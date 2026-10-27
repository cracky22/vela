// Benachrichtigungen: lokal (über den Service Worker, funktioniert so auch auf Android) und per Web-Push
// (auch bei geschlossener App). `new Notification()` ist auf Android-Chrome verboten und löst dort einen
// Fehler aus – deshalb läuft alles über registration.showNotification().
import { api, BASE_PATH } from './api.js';
import { S } from './state.js';

const SCOPE = `${BASE_PATH}/`;
let regPromise = null;
let listening = false;

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export function registration() {
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error('Service Worker wird nicht unterstützt'));
  if (!regPromise) {
    regPromise = navigator.serviceWorker.register(`${BASE_PATH}/sw.js`, { scope: SCOPE })
      .then(() => navigator.serviceWorker.ready)
      .catch((e) => { regPromise = null; throw e; });
  }
  return regPromise;
}

const iconOpts = () => ({ icon: `${SCOPE}static/icon-192.png`, badge: `${SCOPE}static/badge-96.png` });

/** Lokale Benachrichtigung (z. B. Nachricht kommt an, App ist im Hintergrund, aber noch verbunden). */
export async function showLocal({ title, body, tag }) {
  const opts = { body, tag, ...iconOpts(), data: { conv: tag || null } };
  if (tag) opts.renotify = true;
  try {
    const reg = await registration();
    await reg.showNotification(title, opts);
    return true;
  } catch { /* kein Service Worker: Desktop-Fallback unten */ }
  try { new Notification(title, opts); return true; } catch { return false; }
}

function b64urlToBytes(s) {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}
const sameKey = (buf, bytes) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  return a.length === bytes.length && a.every((v, i) => v === bytes[i]);
};

/** Push-Abo anlegen und beim Server anmelden. Voraussetzung: Berechtigung ist erteilt. */
export async function enablePush() {
  if (!pushSupported()) {
    return { ok: false, reason: 'Dieser Browser unterstützt keine Push-Benachrichtigungen (iPhone: Vela zuerst zum Home-Bildschirm hinzufügen).' };
  }
  if (Notification.permission !== 'granted') return { ok: false, reason: 'Benachrichtigungen sind im Browser nicht erlaubt' };
  try {
    const info = await api('/push/key');
    if (!info.available) return { ok: false, reason: 'Der Server kann noch keine Push-Nachrichten senden (Paket „pywebpush“ fehlt).' };
    const reg = await registration();
    const key = b64urlToBytes(info.key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; }   // Server-Schlüssel hat gewechselt
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/push/subscribe', { method: 'POST', body: sub.toJSON() });
    S.pushActive = true;
    return { ok: true };
  } catch (e) {
    S.pushActive = false;
    return { ok: false, reason: e?.message || 'Push konnte nicht eingerichtet werden' };
  }
}

/** Abo beim Server abmelden und im Browser löschen (Ausschalten, Abmelden). */
export async function disablePush() {
  S.pushActive = false;
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await registration();
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nichts zu tun */ }
}

/** Beim Start nach dem Login: Chat öffnen, wenn auf eine Benachrichtigung getippt wurde; Abo aktuell halten. */
export function initNotify({ enabled, openChat }) {
  if ('serviceWorker' in navigator && !listening) {
    listening = true;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-chat' && e.data.conv) openChat(e.data.conv);
    });
  }
  if (enabled && 'Notification' in window && Notification.permission === 'granted') enablePush().catch(() => {});
}