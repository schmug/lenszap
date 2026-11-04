// SPDX-License-Identifier: Apache-2.0
//
// The in-browser scorer page for eval/browser-scorer.mjs: loads a model with
// transformers.js (NLI or embedding) or WebLLM (small chat model) and answers
// scoring calls from the Node side. Every file it loads, libraries and model
// weights alike, comes from the loopback server that serves this page.
// Developer tooling only: the extension never loads anything in eval/.

import { readSystemOneBody, rescaleCosine, systemOneAnswers } from './shared.js';

let state = null; // { kind, model, device, run }
// One call at a time: the GPU runs them one by one anyway, and a queue keeps each
// call's timing honest.
let queue = Promise.resolve();
const serial = (fn) => {
  const p = queue.then(fn, fn);
  queue = p.catch(() => {});
  return p;
};

async function gpuInfo() {
  if (!('gpu' in navigator)) return { webgpu: false };
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { webgpu: false, note: 'navigator.gpu present, but no adapter' };
    const info = adapter.info ?? {};
    return { webgpu: true, vendor: info.vendor, architecture: info.architecture, description: info.description };
  } catch (err) {
    return { webgpu: false, note: String(err?.message ?? err) };
  }
}

async function loadTransformers({ kind, model, device, dtype, queryPrefix = '', passagePrefix = '', lo = 0.2, hi = 0.6, pooling = 'mean' }) {
  const T = await import('/lib/transformers.min.js');
  T.env.allowRemoteModels = false;
  T.env.allowLocalModels = true;
  T.env.localModelPath = '/models/';
  T.env.useBrowserCache = false;
  T.env.backends.onnx.wasm.wasmPaths = {
    mjs: '/ort/ort-wasm-simd-threaded.asyncify.mjs',
    wasm: '/ort/ort-wasm-simd-threaded.asyncify.wasm'
  };
  const opts = { device, ...(dtype ? { dtype } : {}) };

  if (kind === 'nli') {
    const tokenizer = await T.AutoTokenizer.from_pretrained(model);
    const net = await T.AutoModelForSequenceClassification.from_pretrained(model, opts);
    const l2i = Object.fromEntries(Object.entries(net.config.label2id ?? {}).map(([k, v]) => [k.toLowerCase(), Number(v)]));
    const ent = l2i.entailment ?? 0;
    const con = l2i.contradiction ?? (l2i['not_entailment'] ?? 2);
    return async (passage, hypotheses) => {
      const inputs = tokenizer(hypotheses.map(() => passage), { text_pair: hypotheses, padding: true, truncation: true });
      const { logits } = await net(inputs);
      const [n, c] = logits.dims;
      const data = logits.data;
      const out = [];
      for (let i = 0; i < n; i++) {
        // Entailment against contradiction only, as zero-shot classification does with multi_label.
        const e = Number(data[i * c + ent]);
        const k = Number(data[i * c + con]);
        const m = Math.max(e, k);
        out.push(Math.exp(e - m) / (Math.exp(e - m) + Math.exp(k - m)));
      }
      return out;
    };
  }

  // kind === 'embed'
  const extract = await T.pipeline('feature-extraction', model, opts);
  const qCache = new Map();
  const embed = async (texts) => {
    const t = await extract(texts, { pooling, normalize: true });
    return t.tolist();
  };
  return async (passage, hypotheses) => {
    const missing = hypotheses.filter((h) => !qCache.has(h));
    if (missing.length) {
      const vecs = await embed(missing.map((h) => queryPrefix + h));
      missing.forEach((h, i) => qCache.set(h, vecs[i]));
    }
    const [p] = await embed([passagePrefix + passage]);
    return hypotheses.map((h) => {
      const q = qCache.get(h);
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * p[i];
      return rescaleCosine(dot, lo, hi);
    });
  };
}

async function loadWebLLM({ model, contextWindow = 4096 }) {
  const W = await import('/web-llm/index.js');
  const base = `${location.origin}/models/${model}`;
  const appConfig = {
    cacheBackend: 'cache',
    model_list: [{ model: base, model_id: model, model_lib: `${base}/model-lib.wasm`, overrides: { context_window_size: contextWindow } }]
  };
  const engine = await W.CreateMLCEngine(model, { appConfig });
  return engine;
}

window.lensZap = {
  gpuInfo,

  async load(opts) {
    const t0 = performance.now();
    const gpu = await gpuInfo();
    if (opts.device === 'webgpu' && !gpu.webgpu) throw new Error(`WebGPU is not available in this browser (${gpu.note ?? 'no navigator.gpu'}).`);
    if (opts.kind === 'webllm') {
      const engine = await loadWebLLM(opts);
      state = { kind: 'webllm', model: opts.model, engine };
    } else {
      const run = await loadTransformers(opts);
      state = { kind: opts.kind, model: opts.model, run };
    }
    return { loadMs: Math.round(performance.now() - t0), gpu };
  },

  systemone(body) {
    return serial(async () => {
      if (!state?.run) throw new Error('No NLI or embedding model loaded.');
      const { passage, keys, hypotheses } = readSystemOneBody(body);
      const probs = await state.run(passage, hypotheses);
      return systemOneAnswers(keys, probs);
    });
  },

  chat(body) {
    return serial(async () => {
      if (!state?.engine) throw new Error('No WebLLM model loaded.');
      const req = { messages: body.messages, temperature: body.temperature ?? 0, max_tokens: body.max_tokens ?? 1536, stream: false };
      const schema = body.response_format?.json_schema?.schema;
      if (schema) req.response_format = { type: 'json_object', schema: JSON.stringify(schema) };
      // Qwen3 thinks before answering unless told not to. Qwen3 only: on other
      // models WebLLM still inserts an empty <think></think> before the JSON.
      if (/qwen3/i.test(state.model)) req.extra_body = { enable_thinking: false };
      const reply = await state.engine.chat.completions.create(req);
      // Qwen3 with thinking off still opens with an empty <think></think>, which
      // the extension's parser (core/model-scorer.js) does not strip.
      const text = (c) => String(c.message?.content ?? '').replace(/^\s*<think>[\s\S]*?<\/think>\s*/, '');
      return { choices: reply.choices.map((c) => ({ index: c.index, finish_reason: c.finish_reason, message: { role: 'assistant', content: text(c) } })), usage: reply.usage };
    });
  }
};

window.lensZapReady = true;
