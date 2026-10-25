// Verbindungsstatus-Banner: Wartungsarbeiten (gelb), Offline (rot), Verbindung wiederhergestellt (grün).
//
// * Der Server meldet den Wartungsmodus über GET /api/maintenance (öffentlich, ohne Anmeldung).
// * Der letzte bekannte Stand wird lokal zwischengespeichert. Ist der Server während der
//   Wartung nicht erreichbar, zeigt die Oberfläche weiter "Wartungsarbeiten" statt "Offline".
// * Der Stand wird regelmäßig neu abgefragt (und beim Zurückkehren in den Tab / bei "online").
import { h, icon } from './util.js';
import { api } from './api.js';
import * as store from './store.js';

const POLL_MS = 20000;       // Normalbetrieb
const POLL_DOWN_MS = 5000;   // Server nicht erreichbar oder Wartung aktiv: öfter nachsehen
const OK_SHOW_MS = 3500;     // Dauer des grünen "Wiederhergestellt"-Hinweises
const CACHE_KEY = 'maintenance';

let maint = { on: false, message: '' };   // letzter bekannter Stand (auch aus dem Cache)
let ws = 'none';                           // 'none' (nicht angemeldet) | 'open' | 'closed'
let poll = 'unknown';                      // 'unknown' | 'ok' | 'fail'
let wasDown = false;                       // war die Verbindung zwischendurch weg?
let okTimer = 0, pollTimer = 0, started = false;
let reconnect = null;                      // () => void – WebSocket sofort neu versuchen
let onBack = null;                         // () => void – Server wieder erreichbar (z. B. Seite neu laden)
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
  clearTimeout(okTimer);
  if (maint.on) {                     // Wartung hat Vorrang vor "Offline"
    show('maint', 'warn', maint.message || 'Wartungsarbeiten');
    return;
  }
  if (down) { show('offline', 'warn', 'Offline – verbinde neu …'); return; }
  if (wasDown) {                      // Rückkehr von offline -> grün
    wasDown = false;
    show('ok', 'check', 'Verbindung wiederhergestellt');
    okTimer = setTimeout(() => { if (banner) banner.hidden = true; }, OK_SHOW_MS);
    return;
  }
  if (banner) banner.hidden = true;
}

async function save() { await store.setPref(CACHE_KEY, maint); }

async function check() {
  clearTimeout(pollTimer);
  let wasFail = poll === 'fail';
  try {
    const d = await api('/maintenance');
    poll = 'ok';
    const next = { on: !!d.maintenance, message: d.message || '' };
    if (next.on !== maint.on || next.message !== maint.message) { maint = next; save(); }
    if (wasFail) { onBack?.(); }
    if (ws === 'closed') reconnect?.();   // Server ist wieder da -> nicht auf den Backoff warten
  } catch {
    poll = 'fail';                        // Stand bleibt wie zwischengespeichert
  }
  render();
  pollTimer = setTimeout(check, isDown() || maint.on ? POLL_DOWN_MS : POLL_MS);
}

/** Einmal beim Start aufrufen (vor dem Login). */
export async function initConn({ onReconnect, onServerBack } = {}) {
  if (started) return;
  started = true;
  reconnect = onReconnect || null;
  onBack = onServerBack || null;
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