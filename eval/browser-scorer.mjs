#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
//
// Spike: score blocks with a model running inside the browser (WebGPU), and
// serve it on a loopback port so eval/run.mjs and eval/compare-models.mjs can
// measure it exactly like llama-server. Chromium (Playwright) opens a local
// page that loads the model with transformers.js or WebLLM; this script
// forwards each scoring request to that page.
//
// Kinds (--kind):
//   nli     zero-shot NLI with transformers.js, e.g. Xenova/nli-deberta-v3-xsmall.
//           Each System One yes/no question becomes a hypothesis; P(entailment)
//           is the score. Answers /v1/systemone (eval --api systemone).
//   embed   embedding similarity with transformers.js, e.g. Xenova/bge-small-en-v1.5.
//           Cosine between passage and question, rescaled from --lo..--hi to 0–1.
//           Answers /v1/systemone.
//   webllm  a small chat model with WebLLM, e.g. Qwen2.5-0.5B-Instruct-q4f16_1-MLC,
//           given the extension's chat prompt. Answers /v1/chat/completions
//           (eval --api openai).
//
// Usage:
//   npm install --no-save @huggingface/transformers@4.3.1 @mlc-ai/web-llm@0.2.86   # once
//   npm run browser-scorer -- --kind nli --model Xenova/nli-deberta-v3-xsmall --download
//   npm run browser-scorer -- --kind nli --model Xenova/nli-deberta-v3-xsmall
//   npm run eval -- --api systemone --endpoint http://127.0.0.1:8282 --tag browser:nli-xsmall --concurrency 1
//
// Options: --kind nli|embed|webllm  --model ID  --port N (default 8282)
//          --device webgpu|wasm (default webgpu; wasm is the CPU fallback)
//          --dtype fp32|fp16|q8|q4|q4f16 (transformers.js weights; default: what
//          --download fetched, fp16 when the repo has it, else fp32)
//          --download (fetch the model files from Hugging Face into --models-dir
//          and exit; the only step that touches the network)
//          --models-dir DIR (default eval/data/models, git-ignored)
//          --headed (show the browser; use it if headless Chromium has no WebGPU adapter)
//          --lo X --hi X (embed: cosine mapped to 0 and 1; default 0.2 and 0.6)
//          --query-prefix TEXT --passage-prefix TEXT --pooling mean|cls (embed)
//          --context N (webllm context window, default 4096)  --verbose (page console)
//
// While scoring, the browser may load only files from this server: every other
// request is refused and counted (GET /health reports it). Model weights come
// from --models-dir, libraries from node_modules. Developer tooling only: the
// extension never loads anything in eval/, and this adds no runtime dependency.

import http from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { parseArgs } from './lib.mjs';
import { KINDS, apiForKind, isLocalRequest, modelFilePath } from './browser-scorer/shared.js';

const args = parseArgs(process.argv.slice(2));
const root = fileURLToPath(new URL('..', import.meta.url));
const here = join(root, 'eval/browser-scorer');
const kind = String(args.kind ?? 'nli');
const model = typeof args.model === 'string' ? args.model : '';
const port = Number(args.port ?? 8282);
const device = String(args.device ?? 'webgpu');
const modelsDir = resolve(typeof args['models-dir'] === 'string' ? args['models-dir'] : join(root, 'eval/data/models'));
const INSTALL = 'npm install --no-save @huggingface/transformers@4.3.1 @mlc-ai/web-llm@0.2.86';

if (!KINDS[kind] || !model) {
  console.error(`Usage: npm run browser-scorer -- --kind ${Object.keys(KINDS).join('|')} --model ID [--download]`);
  process.exit(2);
}
if (device !== 'webgpu' && device !== 'wasm') {
  console.error('--device must be webgpu or wasm.');
  process.exit(2);
}
if (kind === 'webllm' && device !== 'webgpu') {
  console.error('WebLLM runs on WebGPU only.');
  process.exit(2);
}

// --- Libraries (dev-only, installed with --no-save) ---------------------------

function findLib(rel) {
  for (const base of [join(root, 'node_modules'), join(root, 'node_modules/@huggingface/transformers/node_modules')]) {
    const p = join(base, rel);
    if (existsSync(p)) return p;
  }
  return null;
}
const LIBS = {
  transformers: findLib('@huggingface/transformers/dist/transformers.min.js'),
  ort: findLib('onnxruntime-web/dist'),
  webllm: findLib('@mlc-ai/web-llm/lib/index.js')
};
const needed = kind === 'webllm' ? ['webllm'] : ['transformers', 'ort'];
if (needed.some((k) => !LIBS[k])) {
  console.error(`Missing the in-browser model libraries. Install them once, without adding them to package.json:\n  ${INSTALL}`);
  process.exit(2);
}

// --- Download (the only network step) ------------------------------------------

const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
const modelDir = join(modelsDir, ...model.split('/'));
const metaPath = join(modelDir, 'lenszap-browser.json');

async function fetchTo(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  mkdirSync(dirname(dest), { recursive: true });
  await streamPipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function hfFiles(repo) {
  const res = await fetch(`https://huggingface.co/api/models/${repo}`);
  if (!res.ok) throw new Error(`Hugging Face has no model ${repo} (${res.status}).`);
  return (await res.json()).siblings.map((s) => s.rfilename);
}

async function download() {
  let files;
  let meta;
  let base;
  let lib = null;
  if (kind === 'webllm') {
    const { prebuiltAppConfig } = await import(LIBS.webllm);
    const rec = prebuiltAppConfig.model_list.find((m) => m.model_id === model);
    if (!rec) throw new Error(`WebLLM has no prebuilt model ${model}. Pick a model_id from its prebuiltAppConfig.`);
    const repo = new URL(rec.model).pathname.replace(/^\/|\/$/g, '');
    files = (await hfFiles(repo)).filter((f) => !/^(\.gitattributes|README\.md)$/.test(f));
    base = `https://huggingface.co/${repo}/resolve/main/`;
    lib = rec.model_lib;
    meta = { kind, model, repo, modelLib: rec.model_lib, vramMB: rec.vram_required_MB };
  } else {
    const all = await hfFiles(model);
    const want = typeof args.dtype === 'string' ? args.dtype : all.includes('onnx/model_fp16.onnx') ? 'fp16' : 'fp32';
    if (!(want in DTYPE_SUFFIX)) throw new Error(`Unknown --dtype ${want}.`);
    const onnx = `onnx/model${DTYPE_SUFFIX[want]}.onnx`;
    if (!all.includes(onnx)) throw new Error(`${model} has no ${onnx}. It has: ${all.filter((f) => f.startsWith('onnx/')).join(', ')}`);
    const extras = ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'vocab.txt', 'spm.model', 'sentencepiece.bpe.model'];
    files = [...extras.filter((f) => all.includes(f)), ...all.filter((f) => f === onnx || f.startsWith(`${onnx}_data`))];
    base = `https://huggingface.co/${model}/resolve/main/`;
    meta = { kind, model, dtype: want };
  }
  console.error(`Downloading ${files.length} files of ${model} into ${modelDir}`);
  for (const f of files) {
    const dest = join(modelDir, f);
    if (existsSync(dest) && statSync(dest).size > 0) continue;
    process.stderr.write(`  ${f}\n`);
    await fetchTo(base + f, dest);
  }
  if (lib && !existsSync(join(modelDir, 'model-lib.wasm'))) {
    process.stderr.write('  model-lib.wasm\n');
    await fetchTo(lib, join(modelDir, 'model-lib.wasm'));
  }
  writeFileSync(metaPath, JSON.stringify({ ...meta, downloaded: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
  console.error('Done.');
}

if (args.download) {
  try {
    await download();
    process.exit(0);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

if (!existsSync(metaPath)) {
  console.error(`No downloaded files for ${model} in ${modelsDir}. Run once with --download.`);
  process.exit(2);
}
const meta = JSON.parse(readFileSync(metaPath, 'utf8'));

// --- Loopback server ------------------------------------------------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.txt': 'text/plain' };
const blocked = [];
let ready = false;
let loadInfo = null;
let page = null;

function within(dir, p) {
  const full = resolve(dir, p);
  return full === dir || full.startsWith(dir + sep) ? full : null;
}

function sendFile(res, file) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
    'content-length': statSync(file).size,
    // Cross-origin isolation lets onnxruntime-web use threads (SharedArrayBuffer).
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-embedder-policy': 'require-corp',
    'cross-origin-resource-policy': 'same-origin'
  });
  createReadStream(file).pipe(res);
}

function staticPath(url) {
  const p = url.split('?')[0];
  if (p === '/') return join(here, 'page.html');
  if (p === '/page.js' || p === '/shared.js') return join(here, p.slice(1));
  if (p === '/lib/transformers.min.js') return LIBS.transformers;
  if (p.startsWith('/ort/') && LIBS.ort) return within(LIBS.ort, p.slice('/ort/'.length));
  if (p === '/web-llm/index.js') return LIBS.webllm;
  if (p.startsWith('/models/')) {
    const rel = modelFilePath(p);
    return rel ? within(modelsDir, rel) : null;
  }
  return null;
}

const readBody = (req) =>
  new Promise((ok, fail) => {
    let s = '';
    req.on('data', (d) => { s += d; });
    req.on('end', () => {
      try { ok(JSON.parse(s)); } catch (err) { fail(err); }
    });
    req.on('error', fail);
  });

const json = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(obj));
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return json(res, ready ? 200 : 503, { ready, kind, model, device, ...(loadInfo ?? {}), blockedRequests: blocked.length });
    }
    if (req.method === 'POST' && (req.url === '/v1/systemone' || req.url === '/v1/chat/completions')) {
      if (!ready) return json(res, 503, { error: 'still loading' });
      const want = req.url === '/v1/systemone' ? 'systemone' : 'openai';
      if (want !== apiForKind(kind)) return json(res, 404, { error: `A ${kind} scorer answers ${apiForKind(kind)} requests only.` });
      const body = await readBody(req);
      const fn = want === 'systemone' ? 'systemone' : 'chat';
      const out = await page.evaluate(([f, b]) => window.lensZap[f](b), [fn, body]);
      return json(res, 200, out);
    }
    if (req.method === 'GET') return sendFile(res, staticPath(req.url));
    res.writeHead(405).end();
  } catch (err) {
    json(res, 500, { error: String(err?.message ?? err).slice(0, 500) });
  }
});

await new Promise((ok, fail) => {
  server.once('error', fail);
  server.listen(port, '127.0.0.1', ok);
});
const origin = `http://127.0.0.1:${port}`;

// --- Browser ------------------------------------------------------------------

const { chromium } = await import('playwright');
const browser = await chromium.launch({
  headless: !args.headed,
  args: [
    '--enable-unsafe-webgpu',
    ...(process.platform === 'linux' ? ['--enable-features=Vulkan', '--use-angle=vulkan'] : []),
    // Keep Chromium's own background traffic off: the scorer must stay local.
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-default-browser-check',
    '--no-first-run'
  ]
});
const shutdown = async (code = 0) => {
  try { await browser.close(); } catch { /* already closed */ }
  server.close();
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

const context = await browser.newContext();
await context.route('**/*', (route) => {
  const url = route.request().url();
  if (isLocalRequest(url) && (url.startsWith(origin) || /^(data|blob):/.test(url))) return route.continue();
  blocked.push(url);
  console.error(`Refused a non-local request from the scorer page: ${url.slice(0, 120)}`);
  return route.abort('blockedbyclient');
});
page = await context.newPage();
page.on('pageerror', (err) => console.error(`page error: ${err.message}`));
if (args.verbose) page.on('console', (m) => console.error(`page: ${m.text()}`));

await page.goto(`${origin}/`);
await page.waitForFunction(() => window.lensZapReady === true);
const opts = {
  kind,
  model,
  device,
  dtype: typeof args.dtype === 'string' ? args.dtype : meta.dtype,
  lo: args.lo !== undefined ? Number(args.lo) : undefined,
  hi: args.hi !== undefined ? Number(args.hi) : undefined,
  queryPrefix: typeof args['query-prefix'] === 'string' ? args['query-prefix'] : undefined,
  passagePrefix: typeof args['passage-prefix'] === 'string' ? args['passage-prefix'] : undefined,
  pooling: typeof args.pooling === 'string' ? args.pooling : undefined,
  contextWindow: args.context !== undefined ? Number(args.context) : undefined
};
for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
console.error(`Loading ${model} (${kind}, ${device}${opts.dtype ? `, ${opts.dtype}` : ''}) in Chromium…`);
try {
  loadInfo = await page.evaluate((o) => window.lensZap.load(o), opts);
} catch (err) {
  console.error(`Could not load the model: ${err.message.split('\n')[0]}`);
  if (/WebGPU is not available/.test(err.message) && !args.headed) console.error('Try --headed: some systems give headless Chromium no GPU adapter.');
  await shutdown(1);
}
ready = true;
const g = loadInfo.gpu;
console.error(`Ready in ${(loadInfo.loadMs / 1000).toFixed(1)} s on ${g.webgpu ? `WebGPU (${[g.vendor, g.architecture].filter(Boolean).join(' ') || 'adapter'})` : 'no WebGPU'}; device ${device}. Serving ${apiForKind(kind)} at ${origin}.`);
