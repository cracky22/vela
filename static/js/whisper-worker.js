// On-Device-Transkription mit Whisper (Transformers.js, ONNX Runtime Web).
// Läuft vollständig im Browser des Empfängers: Audio verlässt das Gerät NICHT.
// Nur das Modell (öffentliche Gewichte) wird einmalig von Hugging Face geladen und im
// Browser-Cache gespeichert.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let loadedModel = null;

self.onmessage = async (e) => {
  const { id, audio, model, language } = e.data;
  try {
    if (!asr || loadedModel !== model) {
      asr = await pipeline('automatic-speech-recognition', model, {
        progress_callback: (p) => {
          if (p.status === 'progress_total') self.postMessage({ id, type: 'progress', progress: p.progress / 100, loaded: p.loaded, total: p.total });
        },
      });
      loadedModel = model;
    }
    self.postMessage({ id, type: 'running' });
    const out = await asr(audio, { language: language || null, task: 'transcribe', chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ id, type: 'result', text: (out.text || '').trim() });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String(err?.message || err) });
  }
};
