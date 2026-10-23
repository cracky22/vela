// HTTP-Zugriff auf die Vela-API. Cookies sind HttpOnly + SameSite=Strict; zusätzlich schützt
// der Header X-Requested-With vor CSRF.
export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Ermittelt dynamisch den Basis-Pfad (z. B. '/vela' oder '') für Reverse-Proxies
export function getBasePath() {
  if (typeof window === 'undefined') return '';
  if (window.__VELA_BASE_PATH__ !== undefined) return window.__VELA_BASE_PATH__;
  const path = window.location.pathname;
  if (path.startsWith('/vela')) return '/vela';
  const m = path.match(/^(.*?)(?:\/(?:static|api|vendor)(?:\/|$)|$)/);
  if (m && m[1] && m[1] !== '/') {
    return m[1].replace(/\/[^\/]+\.[a-zA-Z0-9]+$/, '').replace(/\/+$/, '');
  }
  return '';
}

export const BASE_PATH = getBasePath();

function detail(data, fallback) {
  if (!data) return fallback;
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail)) return data.detail.map((d) => (d.msg || '').replace(/^Value error, /, '')).join(' · ');
  return fallback;
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'vela' }, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  const url = `${BASE_PATH}/api${path.startsWith('/') ? path : '/' + path}`;
  try {
    res = await fetch(url, opts);
  } catch {
    throw new ApiError(0, 'Keine Verbindung zum Server');
  }
  if (raw) return res;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, detail(data, `Fehler ${res.status}`));
  return data;
}

// Upload mit echtem Fortschritt (XHR, da fetch keinen Upload-Fortschritt meldet)
export function uploadBlob(blob, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE_PATH}/api/files`);
    xhr.setRequestHeader('X-Requested-With', 'vela');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText); } catch { /* leer */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new ApiError(xhr.status, detail(data, `Upload fehlgeschlagen (${xhr.status})`)));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Upload abgebrochen – Verbindung verloren'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload abgebrochen'));
    signal?.addEventListener('abort', () => xhr.abort());
    xhr.send(blob);
  });
}

// Download mit Fortschritt (Streams-API)
export async function downloadBuffer(fileId, expectedSize, onProgress) {
  const res = await api('/files/' + fileId, { raw: true });
  if (!res.ok) throw new ApiError(res.status, res.status === 404 ? 'Datei nicht mehr verfügbar' : 'Download fehlgeschlagen');
  const total = Number(res.headers.get('content-length')) || expectedSize || 0;
  if (!res.body || !total) {
    const buf = await res.arrayBuffer();
    onProgress?.(1);
    return buf;
  }
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let off = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (off + value.length > out.length) throw new ApiError(0, 'Unerwartete Dateigröße');
    out.set(value, off);
    off += value.length;
    onProgress?.(off / total);
  }
  return out.buffer.slice(0, off);
}
