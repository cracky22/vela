// QR-Anmeldung. Der Rechner zeigt einen QR-Code, das angemeldete Handy scannt und bestätigt ihn; die Schlüssel gehen
// Ende-zu-Ende verschlüsselt (ECDH P-256 + AES-GCM) über den Server, der nur Verschlüsseltes sieht.
import { h, icon, utf8, fromUtf8 } from './util.js';
import { api } from './api.js';
import { dialog, field, button, snackbar } from './ui.js';
import { S, saveIdentity } from './state.js';
import { b64url, unb64url } from './keycompat.js';
import { loadClassic, sourceIdentity } from './vault.js';
import { readStash } from './keystash.js';

const subtle = globalThis.crypto?.subtle;
const EC = { name: 'ECDH', namedCurve: 'P-256' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unhex = (s) => Uint8Array.from(s.match(/../g), (x) => parseInt(x, 16));

async function linkKey(privateKey, peerRaw, id, usage) {
  const peer = await subtle.importKey('raw', peerRaw, EC, false, []);
  const bits = await subtle.deriveBits({ name: 'ECDH', public: peer }, privateKey, 256);
  const ikm = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: unhex(id), info: utf8('vela-link-v1') }, ikm,
    { name: 'AES-GCM', length: 256 }, false, usage);
}
const aad = (id) => utf8('vela-link|' + id);

export function parsePayload(text) {
  const m = /^vela-link:1:([a-f0-9]{32}):([A-Za-z0-9_-]{87})$/.exec((text || '').trim());
  return m ? { id: m[1], pub: m[2] } : null;
}

// ---------------------------------------------------------------- Rechner (zeigt den Code)
export async function createLinkRequest() {
  const pair = await subtle.generateKey(EC, false, ['deriveBits']);
  const pub = b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const r = await api('/link/new', { method: 'POST', body: { pub } });
  return { ...r, expiresIn: r.expires_in, privateKey: pair.privateKey };
}

export async function waitForApproval(req, { isAlive = () => true, intervalMs = 1500 } = {}) {
  for (;;) {
    await sleep(intervalMs);
    if (!isAlive()) throw new Error('Abgebrochen');
    const { status } = await api(`/link/status?id=${req.id}&secret=${encodeURIComponent(req.secret)}`);
    if (status === 'approved') return;
    if (status === 'denied') throw new Error('Auf dem Handy abgelehnt');
    if (status === 'expired' || status === 'claimed') throw new Error('Der QR-Code ist abgelaufen');
  }
}

/** Holt Sitzung und Schlüsselpaket ab und entschlüsselt es. */
export async function claimLink(req) {
  const r = await api('/link/claim', { method: 'POST', body: { id: req.id, secret: req.secret } });
  const key = await linkKey(req.privateKey, unb64url(r.phone_pub), req.id, ['decrypt']);
  let bundle;
  try {
    bundle = JSON.parse(fromUtf8(await subtle.decrypt({ name: 'AES-GCM', iv: unb64url(r.iv), additionalData: aad(req.id) }, key, unb64url(r.ct))));
  } catch { throw new Error('Das Schlüsselpaket konnte nicht entschlüsselt werden'); }
  if (bundle.userId !== r.user_id) throw new Error('Schlüsselpaket gehört zu einem anderen Konto');
  return bundle;
}

export function renderQrLogin({ page, brand, onDone, back }) {
  let alive = true, run = 0, timer = 0;
  const img = h('img', { alt: 'QR-Code zum Anmelden', width: 260, height: 260 });
  const countdown = h('p', { class: 'qr-timer mono' });
  const status = h('p', { class: 'muted small', 'aria-live': 'polite' }, 'QR-Code wird erzeugt …');
  const payload = h('code', { class: 'small mono qr-payload' });
  const again = button('Neuen Code erzeugen', { kind: 'tonal', cls: 'wide', onClick: () => start() });
  again.hidden = true;
  const steps = ['Öffne Vela auf deinem Handy (bereits angemeldet).', 'Gehe zu Profil → Anmeldung auf anderen Geräten → „Neues Gerät anmelden“.', 'Scanne diesen Code und bestätige.'];
  page(brand('Mit QR-Code anmelden'), h('h1', { class: 'auth-title' }, 'Mit dem Handy anmelden'),
    h('ol', { class: 'qr-steps' }, steps.map((s) => h('li', {}, s))), h('div', { class: 'qr-box' }, img), countdown, status,
    h('details', { class: 'small' }, h('summary', {}, 'Code als Text'), payload), again,
    button('Zurück zur Anmeldung', { kind: 'text', onClick: () => { alive = false; clearInterval(timer); back(); } }));

  async function start() {
    const me = ++run;
    const ok = () => alive && me === run;
    clearInterval(timer);
    again.hidden = true; status.textContent = 'QR-Code wird erzeugt …';
    try {
      const req = await createLinkRequest();
      if (!ok()) return;
      img.src = req.qr; payload.textContent = req.payload; status.textContent = 'Warte auf dein Handy …';
      const end = Date.now() + req.expiresIn * 1000;
      timer = setInterval(() => {
        const s = Math.max(0, Math.round((end - Date.now()) / 1000));
        countdown.textContent = `Gültig noch ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 500);
      await waitForApproval(req, { isAlive: ok });
      if (!ok()) return;
      clearInterval(timer);
      status.textContent = 'Bestätigt – Schlüssel werden übertragen …';
      const bundle = await claimLink(req);
      await saveIdentity(bundle.userId, bundle.identity, bundle.keyVersion);
      await onDone();
    } catch (e) {
      if (!ok()) return;
      clearInterval(timer);
      status.textContent = e.message; again.hidden = false;
    }
  }
  start();
}

// ---------------------------------------------------------------- Handy (scannt und bestätigt)
export async function approveLink({ id, pub, bundle }) {
  const pair = await subtle.generateKey(EC, false, ['deriveBits']);
  const key = await linkKey(pair.privateKey, unb64url(pub), id, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, key, utf8(JSON.stringify(bundle)));
  return api('/link/approve', { method: 'POST', body: {
    id, pub: b64url(new Uint8Array(await subtle.exportKey('raw', pair.publicKey))), iv: b64url(iv), ct: b64url(new Uint8Array(ct)) } });
}

export function describeUA(ua) {
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'unbekanntes System';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${br} auf ${os}`;
}

function scanDialog() {
  return new Promise((resolve) => {
    const video = h('video', { class: 'qr-video', playsinline: true, muted: true, autoplay: true });
    const manual = field({ label: 'Oder Code als Text einfügen', name: 'code', required: false, autocomplete: 'off' });
    const status = h('p', { class: 'small muted' }, 'Kamera wird gestartet …');
    let stream = null, stop = false, done = false, d = null;
    const finish = (v) => {
      if (done) return;
      done = true; stop = true;
      stream?.getTracks().forEach((t) => t.stop());
      try { d?.close(); } catch { /* ok */ }
      resolve(v);
    };
    d = dialog({ title: 'QR-Code scannen', icon: 'camera', body: h('div', {}, h('div', { class: 'qr-scan' }, video), status, manual.wrap),
      actions: [{ label: 'Abbrechen' }, { label: 'Text verwenden', primary: true, onClick: () => { const t = manual.input.value.trim(); if (!t) return false; finish(t); } }] });
    d.done.then(() => finish(null));
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
        video.srcObject = stream; await video.play();
        status.textContent = 'Halte die Kamera auf den QR-Code an deinem Rechner.';
        const native = 'BarcodeDetector' in window ? new BarcodeDetector({ formats: ['qr_code'] }) : null;
        if (!native) await loadClassic(new URL('./vendor/jsQR.js', import.meta.url).href, () => globalThis.jsQR);
        const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
        const tick = async () => {
          if (stop) return;
          try {
            let text = null;
            if (video.readyState >= 2) {
              if (native) text = (await native.detect(video))[0]?.rawValue || null;
              else {
                canvas.width = video.videoWidth; canvas.height = video.videoHeight; ctx.drawImage(video, 0, 0);
                const im = ctx.getImageData(0, 0, canvas.width, canvas.height);
                text = globalThis.jsQR(im.data, im.width, im.height)?.data || null;
              }
            }
            if (text?.startsWith('vela-link:')) return finish(text);
          } catch { /* nächster Versuch */ }
          setTimeout(tick, native ? 150 : 250);
        };
        tick();
      } catch (e) { status.textContent = `Kamera nicht verfügbar – füge den Code unten als Text ein. (${e.message})`; }
    })();
  });
}

/** „Dieses Gerät kann Schlüssel weitergeben“: einmalig mit dem Wiederherstellungsschlüssel. */
export function activateSource() {
  const rk = field({ label: 'Wiederherstellungsschlüssel', name: 'rk', autocomplete: 'off', attrs: { autocapitalize: 'characters', spellcheck: false } });
  return dialog({
    title: 'Dieses Gerät aktivieren', icon: 'key',
    body: h('div', {}, h('p', {}, 'Damit dieses Gerät Schlüssel an neue Geräte weitergeben kann, brauchst du einmalig deinen Wiederherstellungsschlüssel. Eine verschlüsselte Kopie bleibt dann auf diesem Gerät.'), rk.wrap),
    actions: [{ label: 'Abbrechen', value: null }, {
      label: 'Aktivieren', primary: true, value: true,
      onClick: async () => { try { await sourceIdentity(rk.input.value); } catch (e) { rk.setError(e.message); return false; } },
    }],
  }).done.then((v) => (v === true ? readStash(S.me.id) : null));
}

export async function scanAndApprove() {
  const text = await scanDialog();
  if (!text) return;
  const p = parsePayload(text);
  if (!p) { snackbar('Das ist kein Vela-QR-Code'); return; }
  let info;
  try { info = await api('/link/info?id=' + p.id); } catch (e) { snackbar(e.message); return; }
  if (info.pub !== p.pub) { snackbar('Der Code stimmt nicht überein – bitte neu scannen'); return; }
  const choice = await dialog({
    title: 'Neues Gerät anmelden?', icon: 'warn',
    body: h('div', {},
      h('p', {}, h('b', {}, describeUA(info.ua)), ' möchte sich mit deinem Konto anmelden und bekommt deine Schlüssel.'),
      h('p', { class: 'small' }, info.same_network ? 'Gleiches Netzwerk wie dieses Handy.' : 'Anderes Netzwerk als dieses Handy (zum Beispiel Mobilfunk) – prüfe besonders sorgfältig.', ` (${info.ip})`),
      h('div', { class: 'banner warn' }, icon('warn', 20), h('span', {}, 'Bestätige nur, wenn du diesen QR-Code gerade selbst an deinem eigenen Rechner geöffnet hast. Nie für Fremde oder nach einer Aufforderung per Nachricht.'))),
    actions: [{ label: 'Ablehnen', value: 'deny' }, { label: 'Anmelden', primary: true, value: 'approve' }],
  }).done;
  if (choice !== 'approve') { if (choice === 'deny') api('/link/deny', { method: 'POST', body: { id: p.id } }).catch(() => {}); return; }
  let src = await readStash(S.me.id);
  if (!src) src = await activateSource();
  if (!src) { snackbar('Ohne Aktivierung kann dieses Gerät keine Schlüssel weitergeben'); return; }
  try {
    await approveLink({ id: p.id, pub: p.pub, bundle: { identity: src.identity, keyVersion: src.keyVersion, userId: S.me.id, username: S.me.username } });
    snackbar('Gerät angemeldet');
  } catch (e) { snackbar(e.message); }
}