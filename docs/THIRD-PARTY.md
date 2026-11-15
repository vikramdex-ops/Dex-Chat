# Third-party components

Dexterity Connect is built by Dexterity Design Services Pvt. Ltd. These open-source parts ship
inside it. Each keeps its own licence; the full texts are in each package's source
(`node_modules/<name>/LICENSE` after `npm ci`). Electron's and Chromium's licences are installed
beside the app (`LICENSE.electron.txt`, `LICENSES.chromium.html`).

| Component | Used for | Licence |
| --- | --- | --- |
| Electron | The Windows and macOS app | MIT |
| React, React DOM | The interface | MIT |
| Capacitor (core, android, preferences) | The Android app | MIT |
| ws | The hub's WebSocket server | MIT |
| node-forge | The hub's self-issued TLS certificate | BSD-3-Clause (chosen from BSD-3-Clause or GPL-2.0) |
| @noble/curves, @noble/hashes | End-to-end encryption (X25519, Ed25519, HKDF, SHA-256) | MIT |
| Tesseract.js, tesseract.js-core | Reading text in images, on the PC | Apache-2.0 |
| Tesseract English model (`eng.traineddata`, via @tesseract.js-data/eng) | Reading text in images | Apache-2.0 (model), MIT (package) |
| wasm-feature-detect | Choosing the OCR engine build | Apache-2.0 |
| Outfit (variable font, via Fontsource) | Headings | OFL-1.1 |
| qrcode-generator | QR codes for setting up phones | MIT |
| jsQR | Reading pairing QR codes with the camera | Apache-2.0 |
| mediasoup (hub) and mediasoup-client (apps) | The relay for Rooms of more than 8 people | ISC |
| MediaPipe Tasks Vision (@mediapipe/tasks-vision) | Background blur in calls, on the PC | Apache-2.0 |
| MediaPipe selfie segmentation model (`selfie_segmenter.tflite`) | Background blur in calls | Apache-2.0 |
| Transformers.js (@huggingface/transformers), with @huggingface/tokenizers and @huggingface/jinja | Drafting automations from plain words, on the PC | Apache-2.0 (tokenizers, Transformers.js), MIT (jinja) |
| ONNX Runtime Web (onnxruntime-web, onnxruntime-common) | Running the drafting model on the PC (WebAssembly) | MIT |
| all-MiniLM-L6-v2 sentence model (sentence-transformers; ONNX, quantized, from Xenova/all-MiniLM-L6-v2 revision 751bff3) | Drafting automations from plain words | Apache-2.0 |
| RNNoise (Xiph.Org, via the WebAssembly build in @sapphi-red/web-noise-suppressor) | Strong noise suppression for the microphone in Rooms, on the PC | BSD-3-Clause (RNNoise); the WebAssembly build comes from @shiguredo/rnnoise-wasm, Apache-2.0 |
| @sapphi-red/web-noise-suppressor | The audio worklet that runs RNNoise (`rnnoiseWorklet.js`, `rnnoise.wasm`, `rnnoise_simd.wasm`, bundled beside the app) | MIT |
| PDF.js (pdfjs-dist), with its parser and page-drawing workers (`pdf.worker.min.mjs`, `pdf.renderer.min.mjs`, bundled beside the app) | Showing PDFs, their first pages in messages, searching and copying their text | Apache-2.0 |
| Image decoders inside pdfjs-dist (WebAssembly): OpenJPEG, PDFium's JBIG2 decoder, qcms | Pictures and colour profiles inside PDFs | BSD-2-Clause (OpenJPEG), BSD-3-Clause (PDFium), MIT (qcms); Mozilla's wrappers Apache-2.0, BSD-2-Clause and MIT |
| Standard PDF fonts from PDFium (Foxit fonts, in pdfjs-dist) | Symbols and text in PDFs that do not embed their fonts | BSD-3-Clause |
| Adobe character maps (CMaps, in pdfjs-dist) | Chinese, Japanese and Korean text in PDFs | BSD-3-Clause |
| ICC profile CGATS001Compat-v2-micro (in pdfjs-dist) | Colours of CMYK drawings in PDFs | CC0-1.0 |
| Wrangler (build tool only) | Deploying the gateway to Cloudflare | MIT OR Apache-2.0 |
| esbuild (build tool only) | Building the gateway's guest meeting page into the Worker | MIT |
| WinSW | Running the hub as a Windows service | MIT |
| Onest (font, `docs/guide/Onest-*.ttf`) | The printed user guide only; not part of the app | OFL-1.1 |

pdfjs-dist also contains Liberation Sans (GPL-2.0 with a font exception), QuickJS and the
@napi-rs/canvas binding for Node; none of them is copied into the app (PDF.js uses the PC's own
Arial or Helvetica, JavaScript in PDFs is never run, and pages are drawn by the browser engine).

Everything else (the design language, icons, sounds, illustrations and the 3D landing page) is
original work for Dexterity. Notification sounds and the call ringtone are generated in code; no
audio files are included. No Zoho code, assets, sounds or wording are used.
