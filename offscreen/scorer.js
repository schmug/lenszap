// SPDX-License-Identifier: Apache-2.0
//
// The in-browser scorer's offscreen page (core/in-browser.js). The service
// worker opens it when the in-browser model is needed; it runs the NLI model
// with transformers.js on WebGPU (vendor/), and closes itself after a few idle
// minutes to give the GPU memory back.
//
// Network: only the download, which runs when the reader asks for it in
// Settings, fetches the model files from Hugging Face into Cache Storage.
// Loading and scoring read those cached files and the vendored libraries,
// and refuse anything else.

import { IN_BROWSER_MODEL, MODEL_CACHE, modelFiles, remoteFileUrl, hypotheses, toScore } from '../core/in-browser.js';

// transformers.js asks for model files under MODELS_URL; they are stored in
// Cache Storage under CACHE_BASE, since Cache Storage takes only http(s) keys.
// The .invalid name never resolves: it is a key, never fetched.
const MODELS_URL = chrome.runtime.getURL('models/');
const CACHE_BASE = 'https://models.lenszap.invalid/';
const metaUrl = (model) => `${CACHE_BASE}${model}/lenszap.json`;
const fileUrl = (model, file) => `${CACHE_BASE}${model}/${file}`;
const IDLE_CLOSE_MS = 5 * 60 * 1000;

let loaded = null; // Promise<{tokenizer, net, ent, con, device, dtype}>
let idleTimer = null;
let queue = Promise.resolve();
const serial = (fn) => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
};

function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => window.close(), IDLE_CLOSE_MS);
}

async function gpu() {
  if (!('gpu' in navigator)) return { webgpu: false, f16: false };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { webgpu: false, f16: false };
    return { webgpu: true, f16: adapter.features.has('shader-f16'), vendor: adapter.info?.vendor ?? '', architecture: adapter.info?.architecture ?? '' };
  } catch {
    return { webgpu: false, f16: false };
  }
}

async function readMeta(model = IN_BROWSER_MODEL) {
  const cache = await caches.open(MODEL_CACHE);
  const r = await cache.match(metaUrl(model));
  return r ? r.json() : null;
}

async function status() {
  const [meta, g] = await Promise.all([readMeta(), gpu()]);
  return { model: IN_BROWSER_MODEL, downloaded: !!meta, dtype: meta?.dtype ?? null, bytes: meta?.bytes ?? 0, ...g, loaded: !!loaded };
}

const progress = (data) => {
  touch(); // a long download is not idle
  chrome.runtime.sendMessage({ type: 'ib-progress', ...data }).catch(() => {});
};

async function download() {
  const g = await gpu();
  const dtype = g.f16 ? 'fp16' : 'fp32';
  const files = modelFiles(dtype);
  const cache = await caches.open(MODEL_CACHE);
  let bytes = 0;
  for (const [i, file] of files.entries()) {
    const res = await fetch(remoteFileUrl(file), { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`Hugging Face answered ${res.status} for ${file}`);
    const total = Number(res.headers.get('content-length')) || 0;
    // Read it through, reporting progress, then store it under the extension's own URL.
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    let shown = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      if (got - shown > 4 * 1024 * 1024) {
        shown = got;
        progress({ file, index: i, files: files.length, loaded: got, total });
      }
    }
    bytes += got;
    await cache.put(fileUrl(IN_BROWSER_MODEL, file), new Response(new Blob(chunks), { headers: { 'content-type': res.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(got) } }));
    progress({ file, index: i, files: files.length, loaded: got, total: got });
  }
  const meta = { model: IN_BROWSER_MODEL, dtype, files, bytes, downloaded: new Date().toISOString().slice(0, 10) };
  await cache.put(metaUrl(IN_BROWSER_MODEL), new Response(JSON.stringify(meta), { headers: { 'content-type': 'application/json' } }));
  loaded = null;
  return status();
}

async function remove() {
  loaded = null;
  await caches.delete(MODEL_CACHE);
  return status();
}

function load() {
  loaded ??= (async () => {
    const meta = await readMeta();
    if (!meta) throw new Error('The in-browser model is not downloaded. Settings → Scorer → Download.');
    const T = await import('../vendor/transformers/transformers.min.js');
    const cache = await caches.open(MODEL_CACHE);
    T.env.allowRemoteModels = false;
    T.env.allowLocalModels = true;
    T.env.localModelPath = MODELS_URL;
    T.env.useBrowserCache = false;
    T.env.useWasmCache = false;
    // Every file transformers.js asks for comes from the model cache, or from
    // the extension package; nothing from the network.
    T.env.fetch = async (url) => {
      const u = String(url instanceof Request ? url.url : url);
      if (u.startsWith(MODELS_URL)) return (await cache.match(CACHE_BASE + u.slice(MODELS_URL.length))) ?? new Response(null, { status: 404 });
      if (u.startsWith(chrome.runtime.getURL(''))) return fetch(u);
      throw new Error(`The in-browser scorer does not fetch ${u.slice(0, 80)}`);
    };
    T.env.backends.onnx.wasm.wasmPaths = {
      mjs: chrome.runtime.getURL('vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs'),
      wasm: chrome.runtime.getURL('vendor/onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm')
    };
    const g = await gpu();
    const device = g.webgpu ? 'webgpu' : 'wasm';
    const tokenizer = await T.AutoTokenizer.from_pretrained(IN_BROWSER_MODEL);
    const net = await T.AutoModelForSequenceClassification.from_pretrained(IN_BROWSER_MODEL, { device, dtype: meta.dtype });
    const l2i = Object.fromEntries(Object.entries(net.config.label2id ?? {}).map(([k, v]) => [k.toLowerCase(), Number(v)]));
    return { tokenizer, net, ent: l2i.entailment ?? 0, con: l2i.contradiction ?? 2, device, dtype: meta.dtype };
  })();
  loaded.catch(() => { loaded = null; });
  return loaded;
}

async function score({ blocks, topics, maxChars = 1500 }) {
  const m = await load();
  const hyps = hypotheses(topics);
  const out = [];
  for (const b of blocks) {
    const passage = String(b.text ?? '').slice(0, maxChars);
    const inputs = m.tokenizer(hyps.map(() => passage), { text_pair: hyps, padding: true, truncation: true });
    const { logits } = await m.net(inputs);
    const [n, c] = logits.dims;
    const probs = [];
    for (let i = 0; i < n; i++) {
      // Entailment against contradiction only, as zero-shot classification does with multi_label.
      const e = Number(logits.data[i * c + m.ent]);
      const k = Number(logits.data[i * c + m.con]);
      const top = Math.max(e, k);
      probs.push(Math.exp(e - top) / (Math.exp(e - top) + Math.exp(k - top)));
    }
    out.push(toScore(b.id, topics, probs));
  }
  return { scores: out, device: m.device, dtype: m.dtype };
}

const handlers = {
  'ib-status': status,
  'ib-download': () => serial(download),
  'ib-delete': () => serial(remove),
  'ib-score': (msg) => serial(() => score(msg))
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  const fn = handlers[msg.type];
  if (!fn) return false;
  touch();
  Promise.resolve()
    .then(() => fn(msg))
    .then(sendResponse, (err) => sendResponse({ error: String(err?.message ?? err) }));
  return true;
});
touch();
