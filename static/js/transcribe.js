// Steuert den Transkriptions-Worker. Eine Warteschlange, ein Modell im Speicher.
import { decodeTo16k } from './media.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker('/static/js/whisper-worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      if (e.data.type === 'progress') job.onProgress?.({ phase: 'download', value: e.data.progress, loaded: e.data.loaded, total: e.data.total });
      else if (e.data.type === 'running') job.onProgress?.({ phase: 'running' });
      else if (e.data.type === 'result') { pending.delete(e.data.id); job.resolve(e.data.text); }
      else if (e.data.type === 'error') { pending.delete(e.data.id); job.reject(new Error(e.data.error)); }
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'Transkription nicht verfügbar (Modell konnte nicht geladen werden)'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

export const MODELS = {
  'onnx-community/whisper-tiny': 'Whisper Tiny (~40 MB, schnell)',
  'onnx-community/whisper-base': 'Whisper Base (~80 MB, genauer)',
};

export async function transcribe(audioBuffer, { model, language, onProgress }) {
  onProgress?.({ phase: 'decode' });
  const audio = await decodeTo16k(audioBuffer);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, audio, model, language }, [audio.buffer]);
  });
}
