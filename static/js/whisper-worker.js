// On-Device-Transkription mit Whisper (Transformers.js + ONNX Runtime Web, WASM).
// Läuft vollständig im Browser des Empfängers: Das Audio verlässt das Gerät NICHT.
// Laufzeit und Modell liegen auf dem eigenen Vela-Server (/vendor/…), nicht bei Drittanbietern.
let asr = null;
let loadedModel = null;
let lib = null;

// Dynamische Ermittlung des Basis-Pfads für den Web Worker
const BASE_PATH = self.location.pathname.replace(/\/static\/.*$/, '').replace(/\/+$/, '') || (self.location.pathname.startsWith('/vela') ? '/vela' : '');

async function loadLib(cfg) {
  if (lib) return lib;
  lib = await import(`${BASE_PATH}/vendor/transformers.min.js`);
  const { env } = lib;
  env.allowRemoteModels = false;          // nie von Hugging Face nachladen
  env.allowLocalModels = true;
  env.localModelPath = `${BASE_PATH}/vendor/models/`;
  env.useBrowserCache = true;             // Modell bleibt im Browser-Cache
  env.useWasmCache = false;               // WASM direkt von /vendor laden (kein Blob-Umweg)
  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    // Transformers.js wählt die passende WASM-Variante selbst (z. B. ohne "asyncify" auf älterem
    // Safari). Wir behalten diese Wahl und ersetzen nur die CDN-Adresse durch /vendor/ort/.
    const def = wasm.wasmPaths && typeof wasm.wasmPaths === 'object' ? wasm.wasmPaths : null;
    const pick = (url, fallback) => {
      let name = (url || fallback).split('/').pop();
      if (!cfg.asyncify) name = name.replace('.asyncify', '');
      return `${BASE_PATH}/vendor/ort/` + name;
    };
    wasm.wasmPaths = {
      mjs: pick(def?.mjs, 'ort-wasm-simd-threaded.mjs'),
      wasm: pick(def?.wasm, 'ort-wasm-simd-threaded.wasm'),
    };
    wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
    wasm.proxy = false;
  }
  return lib;
}

self.onmessage = async (e) => {
  const { id, audio, model, language, cfg } = e.data;
  try {
    const { pipeline } = await loadLib(cfg || {});
    if (!asr || loadedModel !== model) {
      self.postMessage({ id, type: 'loading' });
      asr = await pipeline('automatic-speech-recognition', model, {
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress_total') self.postMessage({ id, type: 'progress', progress: p.progress / 100 });
        },
      });
      loadedModel = model;
    }
    self.postMessage({ id, type: 'running' });
    const opts = { task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
    if (language) opts.language = language;
    const out = await asr(audio, opts);
    self.postMessage({ id, type: 'result', text: (out.text || '').trim() });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err?.message || err) });
  }
};

// Auch nicht abgefangene Fehler (z. B. aus der WASM-Laufzeit) mit echter Meldung zurückgeben
self.addEventListener('unhandledrejection', (ev) => {
  self.postMessage({ id: -1, type: 'fatal', error: String(ev.reason?.message || ev.reason) });
});
