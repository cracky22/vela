// Steuert den Transkriptions-Worker und die einmalige Modell-Installation auf dem Server.
import { decodeTo16k } from './media.js';
import { api } from './api.js';

let worker = null;
let seq = 0;
const pending = new Map();

function failAll(msg) {
  for (const job of pending.values()) job.reject(new Error(msg));
  pending.clear();
}

function getWorker() {
  if (!worker) {
    worker = new Worker('/static/js/whisper-worker.js', { type: 'module' });
    worker.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'fatal') { failAll(d.error); return; }
      const job = pending.get(d.id);
      if (!job) return;
      if (d.type === 'progress') job.onProgress?.({ phase: 'load', value: d.progress });
      else if (d.type === 'loading') job.onProgress?.({ phase: 'load', value: null });
      else if (d.type === 'running') job.onProgress?.({ phase: 'running' });
      else if (d.type === 'result') { pending.delete(d.id); job.resolve(d.text); }
      else if (d.type === 'error') { pending.delete(d.id); job.reject(new Error(d.error)); }
    };
    worker.onerror = (e) => {
      e.preventDefault?.();
      failAll(e.message ? `Transkriptions-Laufzeit: ${e.message}` : 'Transkriptions-Laufzeit konnte nicht gestartet werden');
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

export const MODELS = {
  'onnx-community/whisper-tiny': 'Whisper Tiny (~40 MB, schnell)',
  'onnx-community/whisper-base': 'Whisper Base (~80 MB, genauer)',
};

export const transcriptionStatus = () => api('/transcription');
export const installModel = (model) => api('/transcription/install', { method: 'POST', body: { model } });

/** Wartet auf den Server-Download und meldet den Fortschritt (0..1). */
export async function waitForInstall(model, onProgress) {
  for (;;) {
    const st = await transcriptionStatus();
    if (st.installed[model]) return st;
    if (st.state.error) throw new Error(st.state.error);
    if (!st.state.running) await installModel(model);
    onProgress?.(st.state.progress || 0, st.state.current);
    await new Promise((r) => setTimeout(r, 700));
  }
}

export async function transcribe(audioBuffer, { model, language, onProgress }) {
  onProgress?.({ phase: 'check' });
  let st = await transcriptionStatus();
  if (!st.installed[model]) {
    st = await waitForInstall(model, (v) => onProgress?.({ phase: 'install', value: v }));
  }
  onProgress?.({ phase: 'decode' });
  let audio;
  try {
    audio = await decodeTo16k(audioBuffer);
  } catch {
    throw new Error('Dieses Audioformat kann der Browser nicht dekodieren');
  }
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, audio, model, language, cfg: { asyncify: st.asyncify } }, [audio.buffer]);
  });
}
