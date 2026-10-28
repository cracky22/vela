// Verbindungsstatus-Banner: Wartungsarbeiten (gelb), Offline (rot), Verbindung wiederhergestellt (grün).
//
// * Der Server meldet den Wartungsmodus über GET /api/maintenance (öffentlich, ohne Anmeldung).
// * Der letzte bekannte Stand wird lokal zwischengespeichert. Ist der Server während der Wartung nicht
//   erreichbar, zeigt die Oberfläche weiter "Wartungsarbeiten" statt "Offline".
// * Nur Netzwerkfehler und 5xx-Antworten (Proxy/Server nicht erreichbar) zählen als "offline". Eine Antwort
//   wie 404 oder 429 bedeutet: Der Server läuft – der Wartungsstand bleibt dann einfach unverändert.
import { h, icon } from './util.js';
import { api, ApiError } from './api.js';
import * as store from './store.js';

const POLL_MS = 5000;        // Normalbetrieb: Wartungsmodus ist so nach spätestens ~5 s bei allen sichtbar
const POLL_DOWN_MS = 3000;   // Server nicht erreichbar oder Wartung aktiv: öfter nachsehen
const OK_SHOW_MS = 4000;     // Dauer des grünen "Wiederhergestellt"-Hinweises
const CACHE_KEY = 'maintenance';

let maint = { on: false, message: '' };   // letzter bekannter Stand (auch aus dem Cache)
let ws = 'none';                           // 'none' (nicht angemeldet) | 'open' | 'closed'
let poll = 'unknown';                      // 'unknown' | 'ok' | 'fail'
let wasDown = false;                       // war die Verbindung zwischendurch weg?
let okUntil = 0;                           // bis wann der grüne Hinweis stehen bleibt
let okTimer = 0, pollTimer = 0, started = false;
let reconnect = null, onBack = null, onCacheEpoch = null;
let banner = null;

const isDown = () => ws === 'closed' || (ws === 'none' && poll === 'fail');

function ensureBanner() {
  if (banner) return banner;
  banner = h('div', { class: 'conn-banner', role: 'status', 'aria-live': 'polite', hidden: true });
  document.body.append(banner);
  return banner;
}

function show(kind, iconName, text) {
  const b = ensureBanner();
  b.className = 'conn-banner ' + kind;
  b.replaceChildren(icon(iconName, 16), h('span', {}, text));
  b.hidden = false;
}

function render() {
  const down = isDown();
  if (down) wasDown = true;
  if (maint.on) { show('maint', 'warn', maint.message || 'Wartungsarbeiten'); return; }   // Wartung hat Vorrang
  if (down) { show('offline', 'warn', 'Offline – verbinde neu …'); return; }
  if (wasDown) { wasDown = false; okUntil = Date.now() + OK_SHOW_MS; }                     // zurück von offline
  const left = okUntil - Date.now();
  if (left > 0) {                    // grün bleibt stehen, auch wenn zwischendurch erneut gerendert wird
    show('ok', 'check', 'Verbindung wiederhergestellt');
    clearTimeout(okTimer);
    okTimer = setTimeout(render, left + 30);
    return;
  }
  if (banner) banner.hidden = true;
}

async function check() {
  clearTimeout(pollTimer);
  const wasFail = poll === 'fail';
  let reachable = true;
  try {
    const d = await api('/maintenance');
    if (d && typeof d.maintenance === 'boolean') {
      const next = { on: d.maintenance, message: d.message || '' };
      if (next.on !== maint.on || next.message !== maint.message) { maint = next; store.setPref(CACHE_KEY, maint); }
      if (d.cache_epoch) onCacheEpoch?.(d.cache_epoch);
    }
  } catch (e) {
    reachable = e instanceof ApiError && e.status >= 400 && e.status < 500;   // 404/429 …: Server antwortet
  }
  poll = reachable ? 'ok' : 'fail';
  if (reachable) {
    if (wasFail) onBack?.();
    if (ws === 'closed') reconnect?.();   // Server ist wieder da -> nicht auf den Backoff warten
  }
  render();
  pollTimer = setTimeout(check, isDown() || maint.on ? POLL_DOWN_MS : POLL_MS);
}

/** Einmal beim Start aufrufen (vor dem Login). */
export async function initConn({ onReconnect, onServerBack, onCacheEpoch: onEpoch } = {}) {
  if (started) return;
  started = true;
  reconnect = onReconnect || null;
  onBack = onServerBack || null;
  onCacheEpoch = onEpoch || null;
  const cached = await store.pref(CACHE_KEY, null);
  if (cached && typeof cached === 'object') maint = { on: !!cached.on, message: cached.message || '' };
  render();
  check();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  addEventListener('online', check);
  addEventListener('offline', () => { poll = 'fail'; render(); });
}

/** Vom WebSocket-Code aufrufen. */
export function setWsState(state) {
  ws = state;
  render();
  if (state === 'closed') check();       // sofort prüfen: Wartung oder echter Ausfall?
}