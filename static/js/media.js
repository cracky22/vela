// Medienverarbeitung im Browser: Bildkompression (inkl. Entfernen von EXIF/GPS),
// Vorschaubilder, Sprachaufnahme, Audio-Dekodierung für die Transkription.

export const IMAGE_MAX_SIDE = 2560;        // längste Kante nach Kompression
export const IMAGE_COMPRESS_OVER = 1.5e6;  // ab 1,5 MB wird stärker komprimiert

async function loadBitmap(file) {
  if ('createImageBitmap' in window) {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* Fallback unten */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht kodiert werden'))), type, quality));
}

/**
 * Bilder werden immer neu kodiert: Dadurch fallen Metadaten (EXIF, GPS-Position, Kameradaten)
 * weg. Zu große Bilder werden verkleinert und stärker komprimiert. GIFs (Animation) bleiben unverändert.
 */
export async function prepareImage(file) {
  if (file.type === 'image/gif') {
    const bmp = await loadBitmap(file);
    return { blob: file, width: bmp.width, height: bmp.height, mime: file.type, compressed: false, thumb: await thumbFrom(bmp) };
  }
  const bmp = await loadBitmap(file);
  const w0 = bmp.width, h0 = bmp.height;
  const big = file.size > IMAGE_COMPRESS_OVER || Math.max(w0, h0) > IMAGE_MAX_SIDE;
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(w0, h0));
  const w = Math.round(w0 * scale), h = Math.round(h0 * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // JPEG kennt keine Transparenz
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  let quality = big ? 0.82 : 0.9;
  let blob = await canvasBlob(canvas, 'image/jpeg', quality);
  while (blob.size > 2.5e6 && quality > 0.5) { // Zielgröße für schnelle Übertragung
    quality -= 0.1;
    blob = await canvasBlob(canvas, 'image/jpeg', quality);
  }
  const thumb = await thumbFrom(bmp);
  bmp.close?.();
  return { blob, width: w, height: h, mime: 'image/jpeg', compressed: big, originalSize: file.size, thumb };
}

// Winziges, unscharfes Vorschaubild (wird verschlüsselt in der Nachricht mitgeschickt)
async function thumbFrom(bmp) {
  const s = 24 / Math.max(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(bmp.width * s));
  c.height = Math.max(1, Math.round(bmp.height * s));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.6);
}

// ---------------------------------------------------------------- Sprachaufnahme
export function pickAudioMime() {
  const candidates = ['audio/webm;codecs=opus', 'audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
  if (!window.MediaRecorder) return null;
  return candidates.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
}

export async function startRecording(onLevel) {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Sprachaufnahme wird von diesem Browser nicht unterstützt');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = pickAudioMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : undefined);
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const started = performance.now();

  // Pegelanzeige
  let raf = 0, actx = null;
  try {
    actx = new AudioContext();
    const an = actx.createAnalyser();
    an.fftSize = 256;
    actx.createMediaStreamSource(stream).connect(an);
    const data = new Uint8Array(an.frequencyBinCount);
    const tick = () => {
      an.getByteTimeDomainData(data);
      let peak = 0;
      for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
      onLevel?.(peak / 128, (performance.now() - started) / 1000);
      raf = requestAnimationFrame(tick);
    };
    tick();
  } catch { /* Pegel optional */ }

  rec.start(250);
  const cleanup = () => {
    cancelAnimationFrame(raf);
    actx?.close().catch(() => {});
    stream.getTracks().forEach((t) => t.stop());
  };
  return {
    stop: () => new Promise((resolve) => {
      rec.onstop = () => {
        cleanup();
        const type = rec.mimeType || mime || 'audio/webm';
        resolve({ blob: new Blob(chunks, { type }), mime: type, duration: (performance.now() - started) / 1000 });
      };
      rec.stop();
    }),
    cancel: () => { rec.onstop = cleanup; try { rec.stop(); } catch { cleanup(); } },
  };
}

export function canPlayAudio(mime) {
  const a = document.createElement('audio');
  return a.canPlayType((mime || '').split(';')[0]) !== '';
}

// Audio für Whisper: Mono, 16 kHz, Float32
export async function decodeTo16k(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const length = Math.ceil(decoded.duration * 16000);
    const off = new OfflineAudioContext(1, Math.max(1, length), 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    return rendered.getChannelData(0);
  } finally {
    ctx.close().catch(() => {});
  }
}
