# Vendored libraries

The in-browser scorer (`offscreen/`) runs a small model on WebGPU with
[transformers.js](https://github.com/huggingface/transformers.js) and its
[onnxruntime-web](https://github.com/microsoft/onnxruntime) runtime. They are
copied here unmodified from npm, because an MV3 extension may not load code
from the network. These are the only third-party code in the extension, and
they load only in the offscreen scorer page, never in pages you visit.

| File | Package | License |
|---|---|---|
| `transformers/transformers.min.js` | `@huggingface/transformers@4.3.1` (`dist/transformers.min.js`) | Apache-2.0 (`transformers/LICENSE`) |
| `onnxruntime-web/ort-wasm-simd-threaded.asyncify.{mjs,wasm}` | `onnxruntime-web@1.31.0-dev.20260914-8d85527a0` (`dist/`), the version transformers.js 4.3.1 pins | MIT (`onnxruntime-web/LICENSE`) |

`VENDOR.json` records each file's SHA-256, and `npm test` checks them. To
update: `npm install --no-save @huggingface/transformers@X`, copy the same
files from `node_modules`, update `VENDOR.json`, and bump the extension version.

The model weights are not vendored. Settings → Scorer downloads them once,
when you ask, from Hugging Face into the extension's own cache.
