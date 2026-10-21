// Vela – Hauptanwendung: Chatliste, Chat, Echtzeit, Medien, Einstellungen.
import {
  h, clear, icon, iconBtn, avatar, randomId, fmtBytes, fmtTime, fmtDay, fmtListTime, fmtDuration,
  throttle, isTouch, vibrate,
} from './util.js';
import { api, ApiError, uploadBlob, downloadBuffer } from './api.js';
import {
  cryptoAvailable, sealMessage, openMessage, encryptFile, decryptFile, importSigPub, safetyNumber, shortFingerprint, FILE_CHUNK,
} from './crypto.js';
import * as store from './store.js';
import { S, cacheKey } from './state.js';
import { initAuth, renderLogin, renderRestore, startRotate } from './auth.js';
import { dialog, confirm, snackbar, menu, progress, field, switchRow, button } from './ui.js';
import { swipeable } from './gestures.js';
import { prepareImage, startRecording, canPlayAudio } from './media.js';
import { transcribe, MODELS } from './transcribe.js';

const root = document.getElementById('app');
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const AUTO_DOWNLOAD_MAX = 10 * 1024 * 1024;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const compact = () => !matchMedia('(min-width: 840px)').matches;
let el = {};
const payloadNodes = new Map(); // erhält Zustand von Medien (z. B. laufende Wiedergabe) über Neu-Darstellungen

// ================================================================= Start
async function boot() {
  S.prefs = {
    theme: await store.pref('theme', 'auto'),
    transcription: await store.pref('transcription', false),
    model: await store.pref('model', 'onnx-community/whisper-tiny'),
    language: await store.pref('language', 'german'),
    notifications: await store.pref('notifications', false),
  };
  applyTheme(S.prefs.theme);
  initAuth(root, afterLogin);
  if (!cryptoAvailable()) return renderNoCrypto();
  try { S.config = await api('/config'); } catch { /* Standardwerte */ }
  let status;
  try { status = await api('/auth/status'); } catch (e) { return renderFatal(e.message); }
  if (!status.authenticated) return renderLogin();
  if (!status.full) {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    return renderLogin('Bitte melde dich erneut an, um die Einrichtung der Zwei-Faktor-Authentifizierung abzuschließen.');
  }
  await afterLogin();
}

async function afterLogin() {
  S.me = await api('/me');
  const stored = await store.get('identity', S.me.id).catch(() => null);
  if (stored && stored.keyVersion === S.me.key_version && stored.encPubB64 === S.me.enc_pub) {
    S.keys = stored;
    return enterApp();
  }
  renderRestore({ onLogout: () => logout(false) });
}

function renderNoCrypto() {
  clear(root, h('div', { class: 'auth-page' }, h('div', { class: 'auth-card' },
    h('div', { class: 'dialog-icon' }, icon('warn')),
    h('h1', { class: 'auth-title' }, 'Sichere Verbindung erforderlich'),
    h('p', {}, 'Die Verschlüsselung im Browser (Web Crypto API) ist nur über HTTPS oder auf localhost verfügbar. Bitte öffne Vela über die https://-Adresse, die beim Start von run.py angezeigt wird.'))));
}

function renderFatal(msg) {
  clear(root, h('div', { class: 'auth-page' }, h('div', { class: 'auth-card' },
    h('h1', { class: 'auth-title' }, 'Verbindung fehlgeschlagen'), h('p', {}, msg),
    button('Erneut versuchen', { onClick: () => location.reload() }))));
}

function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0e1513' : '#f4fbf8');
}

// ================================================================= App-Gerüst
function enterApp() {
  S.contacts.clear(); S.messages.clear(); S.decoded.clear(); S.chat = null;
  el = {};
  el.search = h('input', { type: 'search', class: 'search-input', placeholder: 'Chats durchsuchen', 'aria-label': 'Chats durchsuchen',
    oninput: (e) => { S.search = e.target.value.toLowerCase(); renderList(); } });
  el.tabs = h('div', { class: 'tabs', role: 'tablist' });
  el.listProgress = progress({ value: null, cls: 'thin top' });
  el.list = h('div', { class: 'chat-list', role: 'list' });
  el.chatPane = h('main', { class: 'pane chat-pane', 'aria-live': 'off' });
  el.shell = h('div', { class: 'app-shell' },
    h('aside', { class: 'pane list-pane' },
      h('header', { class: 'top-bar' },
        h('div', { class: 'app-title' }, h('span', { class: 'brand-mini' }, icon('shield', 22)), 'Vela'),
        h('div', { class: 'spacer' }),
        iconBtn('person_add', 'Kontakt hinzufügen', addContactDialog, 'hide-compact'),
        iconBtn('settings', 'Einstellungen', openSettings)),
      h('div', { class: 'search-wrap' }, icon('search', 20), el.search),
      el.tabs, el.listProgress.el, el.list,
      h('button', { class: 'fab show-compact', 'aria-label': 'Kontakt hinzufügen', onclick: addContactDialog }, icon('person_add'))),
    el.chatPane);
  clear(root, el.shell);
  renderEmptyChat();
  loadContacts();
  connectWS();
}

function renderEmptyChat() {
  clear(el.chatPane, h('div', { class: 'empty-chat' },
    h('div', { class: 'empty-icon' }, icon('lock', 48)),
    h('h2', {}, 'Wähle einen Chat'),
    h('p', {}, 'Alle Nachrichten, Bilder, Dateien und Sprachnachrichten werden auf deinem Gerät verschlüsselt (RSA-OAEP + AES-256-GCM) und erst beim Empfänger entschlüsselt.'),
    h('p', { class: 'muted small' }, `Verschlüsselte Inhalte liegen höchstens ${S.config.retention_days} Tage auf dem Server.`)));
}

// ================================================================= Kontakte
async function loadContacts() {
  el.listProgress.el.hidden = false;
  try {
    const list = await api('/contacts');
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      const before = S.contacts.get(c.id);
      if (before?.status === 'pending_out' && c.status === 'accepted') {
        snackbar(`${c.username} hat deine Anfrage angenommen – eure Schlüssel wurden ausgetauscht.`);
        if (S.tab === 'requests' && !list.some((x) => x.status !== 'accepted')) S.tab = 'chats';
      }
      S.contacts.set(c.id, { ...(S.contacts.get(c.id) || {}), ...c });
    }
    for (const id of [...S.contacts.keys()]) if (!seen.has(id)) S.contacts.delete(id);
    await syncPins();
    renderList();
    if (S.chat && !S.contacts.has(S.chat)) closeChat();
    else if (S.chat) renderChatHeader();
  } catch (e) {
    if (e.status === 401) return sessionExpired();
    snackbar(e.message);
  } finally {
    el.listProgress.el.hidden = true;
  }
}

// Trust on First Use: der erste gesehene Schlüssel wird angeheftet. Ändert er sich später,
// wird gewarnt und das Senden blockiert, bis der Nutzer den neuen Schlüssel bestätigt.
async function syncPins() {
  for (const c of S.contacts.values()) {
    if (c.status !== 'accepted') continue;
    const k = cacheKey('pin:' + c.id);
    let pin = await store.get('pins', k).catch(() => null);
    if (!pin) {
      pin = { encPub: c.enc_pub, sigPub: c.sig_pub, keyVersion: c.key_version, bits: c.key_bits, verified: false, history: { [c.key_version]: c.sig_pub }, since: Date.now() };
      await store.put('pins', k, pin).catch(() => {});
    }
    c.keyChanged = pin.encPub !== c.enc_pub || pin.sigPub !== c.sig_pub;
    S.pins.set(c.id, pin);
  }
}

async function acceptNewKey(c) {
  const old = S.pins.get(c.id) || { history: {} };
  const pin = { ...old, encPub: c.enc_pub, sigPub: c.sig_pub, keyVersion: c.key_version, bits: c.key_bits, verified: false, history: { ...old.history, [c.key_version]: c.sig_pub } };
  await store.put('pins', cacheKey('pin:' + c.id), pin);
  S.pins.set(c.id, pin);
  c.keyChanged = false;
  for (const m of S.messages.get(c.id) || []) if (m.from === c.id) S.decoded.delete(m.id);
  renderList();
  if (S.chat === c.id) openChat(c.id, { keepHistory: true });
}

function contactsFor(tab) {
  const all = [...S.contacts.values()];
  let list;
  if (tab === 'requests') list = all.filter((c) => c.status !== 'accepted');
  else if (tab === 'archive') list = all.filter((c) => c.status === 'accepted' && c.archived);
  else list = all.filter((c) => c.status === 'accepted' && !c.archived);
  if (S.search) list = list.filter((c) => c.username.toLowerCase().includes(S.search));
  const ts = (c) => c.last?.ts || c.since || 0;
  return list.sort((a, b) => (b.pinned - a.pinned) || ts(b) - ts(a));
}

function renderList() {
  if (!el.list) return;
  const counts = {
    chats: [...S.contacts.values()].filter((c) => c.status === 'accepted' && !c.archived).reduce((n, c) => n + (c.unread ? 1 : 0), 0),
    archive: [...S.contacts.values()].filter((c) => c.status === 'accepted' && c.archived).length,
    requests: [...S.contacts.values()].filter((c) => c.status === 'pending_in').length,
  };
  clear(el.tabs, [['chats', 'Chats'], ['archive', 'Archiv'], ['requests', 'Anfragen']].map(([k, label]) => h('button', {
    role: 'tab', class: 'tab' + (S.tab === k ? ' active' : ''), 'aria-selected': String(S.tab === k),
    onclick: () => { S.tab = k; renderList(); },
  }, label, counts[k] ? h('span', { class: 'badge' + (k === 'archive' ? ' quiet' : '') }, counts[k]) : null)));

  const items = contactsFor(S.tab);
  if (!items.length) {
    const msg = S.search ? 'Keine Treffer.' : S.tab === 'requests' ? 'Keine offenen Kontaktanfragen.' : S.tab === 'archive' ? 'Archivierte Chats erscheinen hier. Wische einen Chat nach links, um ihn zu archivieren.' : 'Noch keine Chats. Füge einen Kontakt über seinen Nutzernamen hinzu – nach der Annahme werden eure öffentlichen Schlüssel ausgetauscht.';
    clear(el.list, h('div', { class: 'list-empty' }, h('p', {}, msg),
      S.tab === 'chats' && !S.search ? button('Kontakt hinzufügen', { kind: 'tonal', icon: 'person_add', onClick: addContactDialog }) : null));
    return;
  }
  clear(el.list, items.map((c) => (c.status === 'accepted' ? chatRow(c) : requestRow(c))));
}

function requestRow(c) {
  const incoming = c.status === 'pending_in';
  return h('div', { class: 'chat-row request', role: 'listitem' },
    h('div', { class: 'row-inner' }, avatar(c.username, 44),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, c.username),
        h('div', { class: 'row-sub' }, incoming ? 'möchte mit dir chatten' : 'Anfrage gesendet – wartet auf Annahme')),
      h('div', { class: 'row-actions' },
        incoming ? button('Annehmen', { kind: 'filled', cls: 'small', onClick: () => acceptContact(c) }) : null,
        button(incoming ? 'Ablehnen' : 'Zurückziehen', { kind: 'text', cls: 'small', onClick: () => removeContact(c, true) }))));
}

function chatRow(c) {
  const sub = h('div', { class: 'row-sub' });
  fillPreview(sub, c);
  const content = h('div', { class: 'row-inner', tabindex: 0, role: 'button', 'aria-label': `Chat mit ${c.username}`,
    onclick: () => openChat(c.id), onkeydown: (e) => { if (e.key === 'Enter') openChat(c.id); } },
  avatar(c.username, 48),
  h('div', { class: 'row-text' },
    h('div', { class: 'row-title' }, c.username,
      c.keyChanged ? h('span', { class: 'warn-dot', title: 'Sicherheitsschlüssel geändert' }, icon('warn', 16)) : null,
      S.pins.get(c.id)?.verified ? h('span', { class: 'verified', title: 'Verifiziert' }, icon('verified', 16)) : null),
    sub),
  h('div', { class: 'row-meta' },
    h('div', { class: 'row-time' + (c.unread ? ' unread' : '') }, c.last ? fmtListTime(c.last.ts) : ''),
    h('div', { class: 'row-badges' },
      c.pinned ? h('span', { class: 'pin', title: 'Markiert' }, icon('pin', 16)) : null,
      c.unread ? h('span', { class: 'badge' }, c.unread) : null)));
  const row = h('div', { class: 'chat-row' + (S.chat === c.id ? ' selected' : ''), role: 'listitem', dataset: { id: c.id } });
  swipeable(row, content, {
    left: { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Zurückholen' : 'Archivieren', color: 'tertiary', dismiss: true, action: () => toggleArchive(c) },
    right: { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', color: 'primary', action: () => togglePin(c) },
    onLongPress: (x, y) => chatMenu(c, x, y),
  });
  return row;
}

async function fillPreview(sub, c) {
  const t = S.typing.get(c.id);
  if (t && t.until > Date.now()) { sub.className = 'row-sub typing'; sub.textContent = 'schreibt …'; return; }
  const m = c.last;
  if (!m) { sub.textContent = 'Sicher verbunden – sag Hallo 👋'; return; }
  const mine = m.from === S.me.id;
  const prefix = mine ? 'Du: ' : '';
  if (m.deleted_at) { sub.textContent = prefix + 'Nachricht gelöscht'; return; }
  if (m.view_once) { sub.textContent = prefix + (m.viewed_at ? 'Einmalansicht · geöffnet' : '👁 Einmalansicht'); return; }
  sub.textContent = prefix + '🔒 …';
  const d = await decode(m);
  sub.textContent = prefix + (d?.payload ? previewText(d.payload) : '⚠ Nicht entschlüsselbar');
}

function previewText(p) {
  switch (p.t) {
    case 'text': return p.body;
    case 'image': return '📷 Foto' + (p.caption ? ': ' + p.caption : '');
    case 'file': return '📎 ' + p.file.name;
    case 'voice': return `🎤 Sprachnachricht (${fmtDuration(p.duration)})`;
    default: return '';
  }
}

async function patchContact(c, patch) {
  Object.assign(c, patch);
  renderList();
  try { await api('/contacts/' + c.id, { method: 'PATCH', body: patch }); } catch (e) { snackbar(e.message); }
}

function toggleArchive(c) {
  const archived = !c.archived;
  patchContact(c, { archived });
  vibrate(10);
  snackbar(archived ? `Chat mit ${c.username} archiviert` : 'Chat zurückgeholt', { action: 'Rückgängig', onAction: () => patchContact(c, { archived: !archived }) });
}
function togglePin(c) { patchContact(c, { pinned: !c.pinned }); snackbar(c.pinned ? 'Chat markiert und oben angeheftet' : 'Markierung entfernt'); }

function chatMenu(c, x, y) {
  menu([
    { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', onClick: () => togglePin(c) },
    { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Aus Archiv holen' : 'Archivieren', onClick: () => toggleArchive(c) },
    { icon: 'shield', label: 'Sicherheitsnummer prüfen', onClick: () => verifyDialog(c) },
    { icon: 'delete', label: 'Kontakt & Chat löschen', danger: true, onClick: () => removeContact(c) },
  ], x, y, { header: h('div', { class: 'menu-header' }, avatar(c.username, 32), h('strong', {}, c.username)) });
}

async function acceptContact(c) {
  try {
    await api(`/contacts/${c.id}/accept`, { method: 'POST' });
    await loadContacts();
    S.tab = 'chats';
    renderList();
    snackbar(`Schlüssel mit ${c.username} ausgetauscht. Ihr könnt jetzt sicher chatten.`, { action: 'Prüfen', onAction: () => verifyDialog(S.contacts.get(c.id)) });
  } catch (e) { snackbar(e.message); }
}

async function removeContact(c, isRequest = false) {
  if (!isRequest && !(await confirm('Kontakt löschen?', `${c.username} wird entfernt. Der gemeinsame Chat wird für euch beide vom Server gelöscht.`, { ok: 'Löschen', danger: true }))) return;
  try {
    await api('/contacts/' + c.id, { method: 'DELETE' });
    S.contacts.delete(c.id);
    S.messages.delete(c.id);
    if (S.chat === c.id) closeChat();
    renderList();
  } catch (e) { snackbar(e.message); }
}

function addContactDialog() {
  const f = field({ label: 'Nutzername', name: 'contact', attrs: { autocapitalize: 'none', spellcheck: false } });
  const d = dialog({
    title: 'Kontakt hinzufügen', icon: 'person_add',
    body: h('div', {}, h('p', {}, 'Sobald die Anfrage angenommen wird, tauscht ihr automatisch eure öffentlichen Schlüssel aus. Erst dann sind Nachrichten möglich.'), f.wrap),
    actions: [
      { label: 'Abbrechen' },
      {
        label: 'Anfrage senden', primary: true, onClick: async () => {
          f.setError('');
          const name = f.input.value.trim();
          if (!name) { f.setError('Bitte Nutzernamen eingeben'); return false; }
          try {
            await api('/contacts', { method: 'POST', body: { username: name } });
            snackbar(`Anfrage an ${name} gesendet`);
            S.tab = 'requests';
            loadContacts();
          } catch (e) { f.setError(e.message); return false; }
        },
      },
    ],
  });
  f.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); d.el.querySelector('.btn.filled').click(); } });
  setTimeout(() => f.input.focus(), 50);
}

// ================================================================= Sicherheitsnummer
async function verifyDialog(c) {
  if (!c || c.status !== 'accepted') return;
  const pin = S.pins.get(c.id);
  const digits = await safetyNumber({ id: S.me.id, encPub: S.keys.encPubB64, sigPub: S.keys.sigPubB64 }, { id: c.id, encPub: pin.encPub, sigPub: pin.sigPub });
  const mine = await shortFingerprint(S.keys.encPubB64, S.keys.sigPubB64);
  const theirs = await shortFingerprint(pin.encPub, pin.sigPub);
  dialog({
    title: 'Sicherheitsnummer', icon: 'shield',
    body: h('div', { class: 'verify' },
      h('p', {}, `Vergleiche diese Nummer mit ${c.username} – am besten persönlich oder per Videoanruf. Stimmt sie bei euch beiden überein, ist sichergestellt, dass niemand (auch nicht der Server) eure Schlüssel ausgetauscht hat.`),
      h('div', { class: 'safety-grid' }, digits.map((g) => h('span', {}, g))),
      h('dl', { class: 'fp-list' },
        h('dt', {}, 'Dein Fingerabdruck'), h('dd', { class: 'mono' }, mine),
        h('dt', {}, `Fingerabdruck von ${c.username}`), h('dd', { class: 'mono' }, theirs),
        h('dt', {}, 'Verfahren'), h('dd', {}, `RSA-OAEP ${pin.bits || c.key_bits} Bit · ECDSA P-256 · AES-256-GCM`)),
      pin.verified ? h('div', { class: 'banner ok' }, icon('verified', 20), h('span', {}, 'Du hast diesen Kontakt verifiziert.')) : null),
    actions: [
      { label: 'Schließen' },
      {
        label: pin.verified ? 'Verifizierung aufheben' : 'Als verifiziert markieren', primary: !pin.verified, onClick: async () => {
          pin.verified = !pin.verified;
          await store.put('pins', cacheKey('pin:' + c.id), pin);
          renderList();
          if (S.chat === c.id) renderChatHeader();
          snackbar(pin.verified ? `${c.username} ist verifiziert` : 'Verifizierung aufgehoben');
        },
      },
    ],
  });
}

// ================================================================= Entschlüsseln
async function verifyKeyFor(m) {
  if (m.from === S.me.id) return importSigPub(S.keys.sigPubB64);
  const pin = S.pins.get(m.from);
  if (!pin) return null;
  let kv = 1;
  try { kv = JSON.parse(m.envelope).kv || 1; } catch { /* Standard */ }
  const spki = pin.history?.[kv] || (kv === pin.keyVersion ? pin.sigPub : null);
  return spki ? importSigPub(spki) : null;
}

function decode(m) {
  if (!m.envelope) return Promise.resolve(null);
  if (S.decoded.has(m.id)) return S.decoded.get(m.id);
  const p = (async () => {
    if (!m.view_once) {
      const cached = await store.get('cache', cacheKey(m.id)).catch(() => null);
      if (cached) return cached;
    }
    try {
      const verifyKey = await verifyKeyFor(m);
      if (!verifyKey) return { error: 'Absender-Schlüssel unbekannt oder geändert – bitte Sicherheitsnummer prüfen' };
      const { payload } = await openMessage({ envelope: m.envelope, id: m.id, from: m.from, to: m.to, me: S.me.id, decKey: S.keys.encPriv, verifyKey });
      const res = { payload };
      if (!m.view_once) store.put('cache', cacheKey(m.id), res).catch(() => {});
      return res;
    } catch (e) {
      return { error: e.message || 'Entschlüsselung fehlgeschlagen' };
    }
  })();
  S.decoded.set(m.id, p);
  return p;
}

// ================================================================= Chat
async function openChat(id, { keepHistory = false } = {}) {
  const c = S.contacts.get(id);
  if (!c) return;
  if (S.chat && S.chat !== id) saveDraft();
  const wasOpen = !!S.chat;
  S.chat = id;
  S.reply = null;
  S.viewOnce = false;
  el.shell.classList.add('chat-open');
  if (compact() && !wasOpen && !keepHistory) history.pushState({ chat: id }, '', '#chat');
  for (const r of el.list.querySelectorAll('.chat-row')) r.classList.toggle('selected', r.dataset.id === id);

  el.header = h('header', { class: 'top-bar chat-bar' });
  el.banner = h('div', { class: 'banner-slot' });
  el.msgs = h('div', { class: 'messages', role: 'log', 'aria-label': `Nachrichten mit ${c.username}` });
  el.msgProgress = progress({ value: null, cls: 'thin top' });
  el.composer = buildComposer(c);
  clear(el.chatPane, h('div', { class: 'chat' }, el.header, el.msgProgress.el, el.banner, el.msgs, el.composer));
  renderChatHeader();

  if (!S.messages.has(id)) await loadMessages(id);
  else el.msgProgress.el.hidden = true;
  renderMessages({ scroll: 'bottom' });
  markRead(id);
  if (!isTouch()) el.input?.focus({ preventScroll: true });
}

function closeChat() {
  saveDraft();
  sendTypingStop();
  S.chat = null;
  el.shell?.classList.remove('chat-open');
  for (const r of el.list?.querySelectorAll('.chat-row') || []) r.classList.remove('selected');
  if (el.chatPane) renderEmptyChat();
}

addEventListener('popstate', () => { if (S.chat && compact()) closeChat(); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.chat && !document.querySelector('dialog[open], .menu-scrim, .viewer')) { if (compact()) history.back(); else closeChat(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && el.search) { e.preventDefault(); el.search.focus(); }
});

function renderChatHeader() {
  const c = S.contacts.get(S.chat);
  if (!c || !el.header) return;
  const pin = S.pins.get(c.id);
  const t = S.typing.get(c.id);
  const typing = t && t.until > Date.now();
  clear(el.header,
    iconBtn('back', 'Zurück', () => (compact() ? history.back() : closeChat()), 'show-compact'),
    avatar(c.username, 40),
    h('button', { class: 'chat-title', type: 'button', onclick: () => verifyDialog(c) },
      h('div', { class: 'name' }, c.username),
      h('div', { class: 'status' + (typing ? ' typing' : '') },
        typing ? 'schreibt …' : [icon(pin?.verified ? 'verified' : 'lock', 14), pin?.verified ? ' Verifiziert · Ende-zu-Ende-verschlüsselt' : ' Ende-zu-Ende-verschlüsselt'])),
    iconBtn('shield', 'Sicherheitsnummer', () => verifyDialog(c)),
    iconBtn('more', 'Mehr', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      menu([
        { icon: 'shield', label: 'Sicherheitsnummer prüfen', onClick: () => verifyDialog(c) },
        { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Aus Archiv holen' : 'Archivieren', onClick: () => toggleArchive(c) },
        { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', onClick: () => togglePin(c) },
        { icon: 'delete', label: 'Kontakt & Chat löschen', danger: true, onClick: () => removeContact(c) },
      ], r.right - 220, r.bottom);
    }));
  clear(el.banner, c.keyChanged ? h('div', { class: 'banner warn' }, icon('warn', 20),
    h('span', {}, `Der Sicherheitsschlüssel von ${c.username} hat sich geändert (z. B. neues Gerät oder neue Schlüssel). Prüfe die Sicherheitsnummer, bevor du weiterschreibst.`),
    button('Neuen Schlüssel akzeptieren', { kind: 'tonal', cls: 'small', onClick: () => acceptNewKey(c) })) : null);
  if (el.sendBtn) el.composer.classList.toggle('blocked', !!c.keyChanged);
}

async function loadMessages(id, before) {
  el.msgProgress.el.hidden = false;
  try {
    const res = await api(`/messages/${id}${before ? '?before=' + before : ''}`);
    const list = S.messages.get(id) || [];
    const known = new Set(list.map((m) => m.id));
    const merged = [...res.messages.filter((m) => !known.has(m.id)), ...list].sort((a, b) => a.ts - b.ts);
    S.messages.set(id, merged);
    S.hasMore.set(id, res.has_more);
  } catch (e) { snackbar(e.message); } finally { el.msgProgress.el.hidden = true; }
}

function reactionsFor(list) {
  const map = new Map();
  return Promise.all(list.filter((m) => m.silent && m.envelope).map(async (m) => ({ m, d: await decode(m) }))).then((arr) => {
    for (const { m, d } of arr.sort((a, b) => a.m.ts - b.m.ts)) {
      if (d?.payload?.t !== 'reaction') continue;
      if (!map.has(d.payload.target)) map.set(d.payload.target, new Map());
      map.get(d.payload.target).set(m.from, d.payload.emoji);
    }
    return map;
  });
}

let renderToken = 0;
async function renderMessages({ scroll } = {}) {
  const id = S.chat;
  if (!id || !el.msgs) return;
  const token = ++renderToken;
  const list = S.messages.get(id) || [];
  const atBottom = el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight < 120;
  const prevHeight = el.msgs.scrollHeight;
  const reactions = await reactionsFor(list);
  const visible = list.filter((m) => !m.silent);
  const hidden = new Set((await store.pref(cacheKey('hidden'), [])) || []);
  const nodes = [];
  if (S.hasMore.get(id)) {
    nodes.push(h('div', { class: 'load-more' }, button('Ältere Nachrichten laden', { kind: 'text', onClick: async () => {
      await loadMessages(id, list[0]?.ts); renderMessages({ scroll: 'keep' });
    } })));
  }
  nodes.push(h('div', { class: 'e2e-note' }, icon('lock', 14), ` Nachrichten sind Ende-zu-Ende-verschlüsselt. Verschlüsselte Inhalte werden nach ${S.config.retention_days} Tagen vom Server gelöscht.`));
  let lastDay = '';
  for (const m of visible) {
    if (hidden.has(m.id)) continue;
    const day = fmtDay(m.ts);
    if (day !== lastDay) { nodes.push(h('div', { class: 'day-sep' }, h('span', {}, day))); lastDay = day; }
    nodes.push(await messageNode(m, reactions.get(m.id)));
  }
  for (const u of S.uploads.get(id) || []) nodes.push(u.node);
  const t = S.typing.get(id);
  if (t && t.until > Date.now()) {
    nodes.push(h('div', { class: 'msg-row theirs' }, h('div', { class: 'bubble ghost' + (t.preview ? '' : ' dots') },
      t.preview ? [h('span', { class: 'live-label' }, 'Live'), ' ', t.preview] : [h('i'), h('i'), h('i')])));
  }
  if (token !== renderToken) return; // eine neuere Darstellung läuft bereits
  clear(el.msgs, nodes);
  if (scroll === 'bottom' || (scroll !== 'keep' && atBottom)) el.msgs.scrollTop = el.msgs.scrollHeight;
  else if (scroll === 'keep') el.msgs.scrollTop = el.msgs.scrollHeight - prevHeight;
}

async function messageNode(m, reactions) {
  const mine = m.from === S.me.id;
  const c = S.contacts.get(S.chat);
  const bubble = h('div', { class: 'bubble' });
  const meta = h('span', { class: 'meta' }, fmtTime(m.ts),
    mine ? (m.failed ? h('span', { class: 'tick failed', title: 'Nicht gesendet' }, icon('warn', 14))
      : m.pending ? h('span', { class: 'tick', title: 'Wird gesendet' }, icon('timer', 14))
        : h('span', { class: 'tick' + (m.read_at ? ' read' : ''), title: m.read_at ? 'Gelesen' : 'Gesendet' }, icon(m.read_at ? 'done_all' : 'check', 14))) : null);
  let payload = null;

  if (m.deleted_at) {
    bubble.classList.add('tombstone');
    bubble.append(h('span', {}, icon('delete', 16), ' Diese Nachricht wurde gelöscht'), meta);
  } else if (m.view_once) {
    bubble.classList.add('view-once');
    if (m.viewed_at) bubble.append(h('span', { class: 'vo-label' }, icon('eye1', 18), ' Einmalansicht · geöffnet'), meta);
    else if (mine) bubble.append(h('span', { class: 'vo-label' }, icon('eye1', 18), ' Einmalansicht gesendet'), meta);
    else {
      bubble.append(h('button', { class: 'vo-open', type: 'button', onclick: () => openViewOnce(m) },
        h('span', { class: 'vo-badge' }, '1'), h('span', {}, 'Einmalansicht – tippen zum Öffnen')), meta);
    }
  } else {
    const d = await decode(m);
    if (!d || d.error) {
      bubble.classList.add('error');
      bubble.append(h('span', {}, icon('warn', 16), ' ', d?.error || 'Nicht entschlüsselbar'), meta);
    } else {
      payload = d.payload;
      if (payload.reply) {
        const who = payload.reply.from === S.me.id ? 'Du' : c?.username;
        bubble.append(h('div', { class: 'quote' }, h('strong', {}, who), h('span', {}, payload.reply.snippet)));
      }
      let pnode = payloadNodes.get(m.id);
      if (!pnode || payload.t === 'text') { pnode = renderPayload(m, payload); if (payload.t !== 'text') payloadNodes.set(m.id, pnode); }
      bubble.append(pnode, meta);
    }
  }
  if (m.failed) bubble.append(button('Erneut senden', { kind: 'text', cls: 'small', onClick: () => retrySend(m) }));

  const row = h('div', { class: `msg-row ${mine ? 'mine' : 'theirs'}`, dataset: { id: m.id } });
  const wrap = h('div', { class: 'bubble-wrap' }, bubble);
  if (reactions && reactions.size) {
    const counts = new Map();
    for (const [, emo] of reactions) if (emo) counts.set(emo, (counts.get(emo) || 0) + 1);
    if (counts.size) {
      wrap.append(h('div', { class: 'reactions' }, [...counts].map(([emo, n]) => h('button', {
        class: 'reaction' + (reactions.get(S.me.id) === emo ? ' mine' : ''), type: 'button', onclick: () => react(m, emo),
        'aria-label': `Reaktion ${emo}, ${n}`,
      }, emo, n > 1 ? h('span', {}, n) : null))));
    }
  }
  if (!m.deleted_at && !m.pending) {
    wrap.append(h('div', { class: 'hover-actions' },
      iconBtn('mood', 'Reagieren', (e) => reactionPicker(m, e.currentTarget)),
      !m.view_once ? iconBtn('reply', 'Antworten', () => setReply(m, payload)) : null,
      iconBtn('more', 'Mehr', (e) => { const r = e.currentTarget.getBoundingClientRect(); messageMenu(m, payload, r.left, r.bottom); })));
    swipeable(row, wrap, {
      left: !m.view_once ? { icon: 'reply', label: 'Antworten', color: 'secondary', action: () => setReply(m, payload) } : null,
      right: { icon: 'mood', label: 'Reagieren', color: 'primary', action: () => reactionPicker(m) },
      onLongPress: (x, y) => messageMenu(m, payload, x, y),
      onDoubleTap: () => react(m, '❤️'),
      maxShift: 96,
    });
  } else row.append(wrap);
  return row;
}

function linkify(text) {
  const parts = [];
  const re = /\bhttps?:\/\/[^\s<>"']+/gi;
  let last = 0, mt;
  while ((mt = re.exec(text))) {
    if (mt.index > last) parts.push(text.slice(last, mt.index));
    const url = mt[0].replace(/[.,;:!?)]+$/, '');
    parts.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'no-gesture' }, url));
    last = mt.index + url.length;
  }
  parts.push(text.slice(last));
  return parts;
}

function renderPayload(m, p) {
  switch (p.t) {
    case 'text': return h('div', { class: 'text' + (/^\p{Extended_Pictographic}{1,3}$/u.test(p.body) ? ' jumbo' : '') }, linkify(p.body));
    case 'image': return imageNode(m, p);
    case 'file': return fileNode(p);
    case 'voice': return voiceNode(m, p);
    default: return h('div', { class: 'text muted' }, 'Nicht unterstützter Nachrichtentyp');
  }
}

// ---------------------------------------------------------------- Medien
async function getFile(meta, onProgress) {
  const hit = S.blobs.get(meta.id);
  if (hit) return hit;
  const nChunks = Math.max(1, Math.ceil(meta.size / (meta.chunk || FILE_CHUNK)));
  const cipher = await downloadBuffer(meta.id, meta.size + 16 * nChunks, (v) => onProgress?.(v * 0.85, 'Laden …'));
  onProgress?.(0.9, 'Entschlüsseln …');
  const plain = await decryptFile(cipher, meta, (v) => onProgress?.(0.85 + v * 0.15, 'Entschlüsseln …'));
  const blob = new Blob([plain], { type: meta.mime || 'application/octet-stream' });
  const entry = { blob, url: URL.createObjectURL(blob) };
  S.blobs.set(meta.id, entry);
  return entry;
}

function imageNode(m, p) {
  const ratio = p.w && p.h ? p.w / p.h : 4 / 3;
  const box = h('button', { class: 'media no-gesture', type: 'button', style: { aspectRatio: String(Math.max(0.5, Math.min(2, ratio))) }, 'aria-label': 'Foto öffnen' });
  if (p.thumb) box.style.backgroundImage = `url("${p.thumb}")`;
  const prog = progress({ value: 0, cls: 'overlay' });
  const load = async () => {
    try {
      box.append(prog.el);
      const f = await getFile(p.file, (v) => prog.set(v));
      prog.el.remove();
      clear(box, h('img', { src: f.url, alt: p.caption || 'Foto', draggable: false }));
      box.classList.add('loaded');
    } catch (e) { prog.el.remove(); clear(box, h('span', { class: 'media-error' }, icon('warn', 18), ' ', e.message)); }
  };
  const cached = S.blobs.get(p.file.id);
  if (cached) { box.append(h('img', { src: cached.url, alt: p.caption || 'Foto', draggable: false })); box.classList.add('loaded'); }
  else if (p.file.size <= AUTO_DOWNLOAD_MAX) setTimeout(load, 0);
  else box.append(h('span', { class: 'media-dl' }, icon('download', 20), fmtBytes(p.file.size)));
  box.addEventListener('click', async () => {
    if (!S.blobs.has(p.file.id)) { await load(); if (!S.blobs.has(p.file.id)) return; }
    openViewer({ url: S.blobs.get(p.file.id).url, blob: S.blobs.get(p.file.id).blob, name: p.file.name, caption: p.caption });
  });
  return h('div', { class: 'image-msg' }, box, p.caption ? h('div', { class: 'text caption' }, linkify(p.caption)) : null,
    p.compressed ? h('div', { class: 'small muted' }, 'komprimiert · Metadaten entfernt') : null);
}

function fileNode(p) {
  const prog = progress({ value: 0, cls: 'inline' });
  prog.el.hidden = true;
  const btn = iconBtn('download', 'Herunterladen', async () => {
    try {
      btn.disabled = true; prog.el.hidden = false;
      const f = await getFile(p.file, (v) => prog.set(v));
      saveBlob(f.blob, p.file.name);
    } catch (e) { snackbar(e.message); } finally { btn.disabled = false; prog.el.hidden = true; }
  }, 'tonal no-gesture');
  return h('div', { class: 'file-card' }, h('div', { class: 'file-icon' }, icon('file', 28)),
    h('div', { class: 'file-info' }, h('div', { class: 'file-name' }, p.file.name), h('div', { class: 'small muted' }, fmtBytes(p.file.size)), prog.el), btn);
}

function voiceNode(m, p) {
  const bar = progress({ value: 0, cls: 'voice-bar' });
  const time = h('span', { class: 'small mono' }, fmtDuration(p.duration));
  const transcript = h('div', { class: 'transcript', hidden: true });
  let audio = null;
  const play = iconBtn('play', 'Abspielen', async () => {
    try {
      if (!audio) {
        play.disabled = true;
        const f = await getFile(p.file, (v) => bar.set(v));
        bar.set(0);
        if (!canPlayAudio(p.file.mime)) snackbar('Dieses Audioformat kann der Browser evtl. nicht abspielen – Transkription funktioniert trotzdem.');
        audio = new Audio(f.url);
        audio.ontimeupdate = () => { bar.set(audio.currentTime / (audio.duration && isFinite(audio.duration) ? audio.duration : p.duration)); time.textContent = fmtDuration(audio.currentTime); };
        audio.onended = () => { clear(play, icon('play')); bar.set(0); time.textContent = fmtDuration(p.duration); };
        play.disabled = false;
      }
      if (audio.paused) { await audio.play(); clear(play, icon('pause')); } else { audio.pause(); clear(play, icon('play')); }
    } catch (e) { play.disabled = false; snackbar(e.message || 'Wiedergabe fehlgeschlagen'); }
  }, 'filled-icon no-gesture');
  const tBtn = S.prefs.transcription ? iconBtn('transcript', 'Transkribieren (auf dem Gerät)', async () => {
    tBtn.disabled = true;
    transcript.hidden = false;
    const tp = progress({ value: null });
    clear(transcript, tp.el);
    try {
      const f = await getFile(p.file);
      const text = await transcribe(await f.blob.arrayBuffer(), {
        model: S.prefs.model, language: S.prefs.language === 'auto' ? null : S.prefs.language,
        onProgress: (s) => {
          if (s.phase === 'download') tp.set(s.value, `Sprachmodell wird geladen (einmalig) … ${Math.round(s.value * 100)} %`);
          else if (s.phase === 'decode') tp.set(null, 'Audio wird vorbereitet …');
          else tp.set(null, 'Wird auf deinem Gerät transkribiert …');
        },
      });
      clear(transcript, h('span', { class: 'small muted' }, 'Transkript (auf dem Gerät erstellt)'), h('p', {}, text || '(keine Sprache erkannt)'));
      tBtn.remove();
    } catch (e) {
      clear(transcript, h('span', { class: 'small error-text' }, 'Transkription fehlgeschlagen: ' + e.message));
      tBtn.disabled = false;
    }
  }, 'no-gesture') : null;
  return h('div', { class: 'voice' }, h('div', { class: 'voice-row' }, play, h('div', { class: 'voice-mid' }, bar.el, time), tBtn), transcript);
}

function saveBlob(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name || 'datei' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function savePhoto(blob, name) {
  const file = new File([blob], name || `vela-${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
  // iOS: Teilen-Menü -> "Bild sichern" speichert in Fotos (fragt einmalig nach Foto-Berechtigung)
  if (isIOS() && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  saveBlob(file, file.name);
  snackbar('Foto wird im Download-Ordner gespeichert');
}

function openViewer({ url, blob, name, caption, viewOnce = false, text = null, onClose }) {
  let closed = false;
  const shield = h('div', { class: 'viewer-shield' }, icon('eye1', 32), h('span', {}, 'Ausgeblendet – zurück zur App, um weiter anzusehen'));
  const content = text !== null ? h('div', { class: 'viewer-text' }, text) : h('img', { src: url, alt: caption || 'Foto', draggable: false });
  const v = h('div', { class: 'viewer' + (viewOnce ? ' protected' : ''), role: 'dialog', 'aria-modal': 'true', tabindex: -1 },
    h('div', { class: 'viewer-bar' },
      iconBtn('close', 'Schließen', () => close()),
      h('div', { class: 'spacer' }, viewOnce ? h('span', { class: 'vo-chip' }, '1 · Einmalansicht – wird beim Schließen gelöscht') : null),
      !viewOnce && blob ? iconBtn(isIOS() ? 'share' : 'download', 'Im Gerät speichern', () => savePhoto(blob, name)) : null),
    h('div', { class: 'viewer-stage' }, content,
      viewOnce ? h('div', { class: 'watermark', 'aria-hidden': 'true' }, Array.from({ length: 12 }, () => h('span', {}, `${S.me.username} · ${new Date().toLocaleString('de-DE')}`))) : null),
    caption ? h('div', { class: 'viewer-caption' }, caption) : null,
    viewOnce ? shield : null);
  const hide = () => v.classList.add('hidden-content');
  const show = () => { if (document.visibilityState === 'visible') v.classList.remove('hidden-content'); };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (viewOnce && (e.key === 'PrintScreen' || (e.metaKey && e.shiftKey))) hide();
  };
  function close() {
    if (closed) return;
    closed = true;
    v.remove();
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    removeEventListener('blur', hide); removeEventListener('focus', show);
    onClose?.();
  }
  const onVis = () => (document.hidden ? hide() : show());
  document.addEventListener('keydown', onKey);
  if (viewOnce) {
    document.addEventListener('visibilitychange', onVis);
    addEventListener('blur', hide);
    addEventListener('focus', show);
    v.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  document.body.append(v);
  v.focus();
}

async function openViewOnce(m) {
  const ok = await confirm('Einmalansicht öffnen?', 'Du kannst den Inhalt nur jetzt ansehen. Beim Öffnen wird er vom Server gelöscht und beim Schließen auch von diesem Gerät. Bitte respektiere die Privatsphäre des Absenders – Bildschirmfotos lassen sich im Browser nicht vollständig verhindern.', { ok: 'Öffnen', icon: 'eye1' });
  if (!ok) return;
  const pgr = progress({ value: null, label: 'Wird entschlüsselt …' });
  const wait = dialog({ body: pgr.el, dismissible: false });
  let payload, file = null;
  try {
    const verifyKey = await verifyKeyFor(m);
    ({ payload } = await openMessage({ envelope: m.envelope, id: m.id, from: m.from, to: m.to, me: S.me.id, decKey: S.keys.encPriv, verifyKey }));
    if (payload.t === 'image') {
      const nChunks = Math.max(1, Math.ceil(payload.file.size / (payload.file.chunk || FILE_CHUNK)));
      const cipher = await downloadBuffer(payload.file.id, payload.file.size + 16 * nChunks, (v) => pgr.set(v * 0.9, 'Laden …'));
      const plain = await decryptFile(cipher, payload.file);
      file = new Blob([plain], { type: payload.file.mime });
      plain.fill(0);
    }
    await api(`/messages/${m.id}/viewed`, { method: 'POST' });  // jetzt endgültig vom Server löschen
  } catch (e) {
    wait.close();
    snackbar(e.message || 'Öffnen fehlgeschlagen');
    return;
  }
  wait.close();
  m.viewed_at = Date.now(); m.envelope = null;
  const url = file ? URL.createObjectURL(file) : null;
  openViewer({
    url, viewOnce: true, text: payload.t === 'text' ? payload.body : null, caption: payload.caption,
    onClose: () => { if (url) URL.revokeObjectURL(url); payload = null; file = null; renderMessages(); },
  });
}

// ---------------------------------------------------------------- Reaktionen & Menüs
function reactionBar(m, close) {
  return h('div', { class: 'reaction-bar' }, REACTIONS.map((e) => h('button', { type: 'button', class: 'reaction-pick', 'aria-label': 'Reagieren mit ' + e, onclick: () => { close?.(); react(m, e); } }, e)));
}

function reactionPicker(m, anchor) {
  const r = anchor?.getBoundingClientRect() || el.msgs.querySelector(`[data-id="${m.id}"]`)?.getBoundingClientRect();
  let closeFn = null;
  closeFn = menu([], r ? r.left : innerWidth / 2, r ? r.bottom : innerHeight / 2, { header: reactionBar(m, () => closeFn?.()) });
}

function messageMenu(m, payload, x, y) {
  const mine = m.from === S.me.id;
  let closeFn = null;
  const items = [
    !m.view_once && !m.deleted_at ? { icon: 'reply', label: 'Antworten', onClick: () => setReply(m, payload) } : null,
    payload?.t === 'text' ? { icon: 'copy', label: 'Text kopieren', onClick: () => navigator.clipboard.writeText(payload.body).then(() => snackbar('Kopiert')) } : null,
    payload?.t === 'image' ? { icon: 'download', label: 'Foto speichern', onClick: async () => { const f = await getFile(payload.file); savePhoto(f.blob, payload.file.name); } } : null,
    payload?.t === 'file' ? { icon: 'download', label: 'Datei speichern', onClick: async () => { const f = await getFile(payload.file); saveBlob(f.blob, payload.file.name); } } : null,
    { icon: 'lock', label: 'Info', onClick: () => infoDialog(m) },
    { icon: 'close', label: 'Für mich ausblenden', onClick: () => hideForMe(m) },
    mine && !m.deleted_at && !m.pending ? { icon: 'delete', label: 'Für alle löschen', danger: true, onClick: () => deleteForAll(m) } : null,
  ];
  closeFn = menu(items, x, y, { header: !m.deleted_at ? reactionBar(m, () => closeFn?.()) : null });
}

function infoDialog(m) {
  const rows = [
    ['Gesendet', new Date(m.ts).toLocaleString('de-DE')],
    m.read_at ? ['Gelesen', new Date(m.read_at).toLocaleString('de-DE')] : null,
    m.viewed_at ? ['Geöffnet (Einmalansicht)', new Date(m.viewed_at).toLocaleString('de-DE')] : null,
    ['Verschlüsselung', 'AES-256-GCM, Schlüssel per RSA-OAEP (SHA-256) gekapselt'],
    ['Signatur', 'ECDSA P-256 / SHA-256 – geprüft'],
    ['Auf dem Server gespeichert bis', new Date(m.ts + S.config.retention_days * 86400000).toLocaleDateString('de-DE')],
  ].filter(Boolean);
  dialog({ title: 'Nachrichteninfo', body: h('dl', { class: 'fp-list' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), actions: [{ label: 'OK', primary: true }] });
}

async function hideForMe(m) {
  const k = cacheKey('hidden');
  const list = (await store.pref(k, [])) || [];
  list.push(m.id);
  await store.setPref(k, list.slice(-5000));
  renderMessages();
  snackbar('Nachricht auf diesem Gerät ausgeblendet');
}

async function deleteForAll(m) {
  if (!(await confirm('Für alle löschen?', 'Die Nachricht und angehängte Dateien werden vom Server gelöscht und bei deinem Kontakt durch einen Hinweis ersetzt.', { ok: 'Löschen', danger: true }))) return;
  try { await api('/messages/' + m.id, { method: 'DELETE' }); } catch (e) { snackbar(e.message); }
}

async function react(m, emoji) {
  vibrate(8);
  const list = S.messages.get(S.chat) || [];
  const current = (await reactionsFor(list)).get(m.id)?.get(S.me.id);
  const value = current === emoji ? '' : emoji;
  try { await sendPayload(S.chat, { t: 'reaction', target: m.id, emoji: value }, { silent: true }); } catch (e) { snackbar(e.message); }
}

function setReply(m, payload) {
  if (!payload) return;
  S.reply = { id: m.id, from: m.from, snippet: previewText(payload).slice(0, 100) };
  renderReplyPreview();
  el.input?.focus();
}

// ================================================================= Composer
function buildComposer(c) {
  el.input = h('textarea', { class: 'composer-input', rows: 1, placeholder: 'Nachricht', 'aria-label': 'Nachricht schreiben', enterkeyhint: isTouch() ? 'enter' : 'send' });
  el.input.value = S.drafts.get(c.id) || '';
  el.replySlot = h('div', { class: 'reply-slot' });
  el.voToggle = h('button', { class: 'icon-btn vo-toggle', type: 'button', 'aria-pressed': 'false', title: 'Einmalansicht', 'aria-label': 'Als Einmalansicht senden',
    onclick: () => { S.viewOnce = !S.viewOnce; updateComposer(); } }, h('span', { class: 'vo-badge' }, '1'));
  el.sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Senden', onclick: onSendButton });
  el.fileInput = h('input', { type: 'file', hidden: true, multiple: true, onchange: (e) => { handleFiles([...e.target.files], el.fileInput.dataset.mode); e.target.value = ''; } });
  const attach = iconBtn('attach', 'Anhängen', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pick = (mode, accept) => { el.fileInput.dataset.mode = mode; el.fileInput.accept = accept; el.fileInput.click(); };
    menu([
      { icon: 'image', label: 'Foto', onClick: () => pick('image', 'image/*') },
      { icon: 'eye1', label: 'Einmalansicht-Foto', onClick: () => pick('viewonce', 'image/*') },
      { icon: 'file', label: `Datei (max. ${fmtBytes(S.config.max_upload_bytes)})`, onClick: () => pick('file', '') },
    ], r.left, r.top - 170);
  });
  el.input.addEventListener('input', () => { autoGrow(); updateComposer(); onTypingInput(); });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch() && !e.isComposing) { e.preventDefault(); sendText(); }
  });
  el.input.addEventListener('blur', () => sendTypingStop());
  el.input.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); handleFiles(files, 'auto'); }
  });
  const comp = h('div', { class: 'composer' }, el.replySlot,
    h('div', { class: 'composer-row' }, attach, h('div', { class: 'input-wrap' }, el.input, el.voToggle), el.sendBtn), el.fileInput);
  // Drag & Drop auf dem Desktop
  el.chatPane.ondragover = (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); el.chatPane.classList.add('drop'); } };
  el.chatPane.ondragleave = () => el.chatPane.classList.remove('drop');
  el.chatPane.ondrop = (e) => { e.preventDefault(); el.chatPane.classList.remove('drop'); handleFiles([...e.dataTransfer.files], 'auto'); };
  setTimeout(() => { autoGrow(); updateComposer(); renderReplyPreview(); }, 0);
  return comp;
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 160) + 'px';
}

function updateComposer() {
  const hasText = el.input.value.trim().length > 0;
  clear(el.sendBtn, icon(hasText ? 'send' : 'mic'));
  el.sendBtn.setAttribute('aria-label', hasText ? 'Senden' : 'Sprachnachricht aufnehmen');
  el.voToggle.classList.toggle('active', S.viewOnce);
  el.voToggle.setAttribute('aria-pressed', String(S.viewOnce));
  el.input.placeholder = S.viewOnce ? 'Einmalansicht-Nachricht' : 'Nachricht';
}

function renderReplyPreview() {
  if (!el.replySlot) return;
  const c = S.contacts.get(S.chat);
  clear(el.replySlot, S.reply ? h('div', { class: 'reply-preview' },
    icon('reply', 18), h('div', { class: 'quote' }, h('strong', {}, S.reply.from === S.me.id ? 'Du' : c?.username), h('span', {}, S.reply.snippet)),
    iconBtn('close', 'Antwort abbrechen', () => { S.reply = null; renderReplyPreview(); })) : null);
}

function saveDraft() { if (S.chat && el.input) S.drafts.set(S.chat, el.input.value); }

function onSendButton() {
  if (el.input.value.trim()) sendText();
  else recordVoice();
}

async function sendText() {
  const text = el.input.value.trim();
  if (!text) return;
  if (text.length > 20000) { snackbar('Nachricht zu lang (max. 20.000 Zeichen)'); return; }
  const payload = { t: 'text', body: text };
  if (S.reply && !S.viewOnce) payload.reply = S.reply;
  el.input.value = '';
  S.drafts.delete(S.chat);
  const vo = S.viewOnce;
  S.reply = null; S.viewOnce = false;
  autoGrow(); updateComposer(); renderReplyPreview(); sendTypingStop();
  try { await sendPayload(S.chat, payload, { viewOnce: vo }); } catch (e) { snackbar(e.message); }
}

async function sendPayload(contactId, payload, { viewOnce = false, silent = false, files = [] } = {}) {
  const c = S.contacts.get(contactId);
  const pin = S.pins.get(contactId);
  if (!c || c.status !== 'accepted' || !pin) throw new Error('Kein Schlüssel für diesen Kontakt');
  if (c.keyChanged) throw new Error('Sicherheitsschlüssel geändert – bitte zuerst bestätigen');
  const id = randomId();
  const recipients = [{ id: c.id, encPub: pin.encPub }]; // immer an den ANGEHEFTETEN Schlüssel
  if (!viewOnce) recipients.push({ id: S.me.id, encPub: S.keys.encPubB64 });
  const envelope = await sealMessage({ id, from: S.me.id, to: c.id, payload, recipients, signKey: S.keys.sigPriv, kv: S.me.key_version });
  const local = { id, from: S.me.id, to: c.id, envelope: viewOnce ? null : envelope, view_once: viewOnce, silent, ts: Date.now(), pending: true, _send: { envelope, files } };
  if (!viewOnce) {
    S.decoded.set(id, Promise.resolve({ payload }));
    store.put('cache', cacheKey(id), { payload }).catch(() => {});
  }
  addMessage(local);
  await deliver(local);
}

async function deliver(local) {
  try {
    const res = await api('/messages', { method: 'POST', body: { id: local.id, to: local.to, envelope: local._send.envelope, view_once: local.view_once, silent: local.silent, files: local._send.files } });
    addMessage(res);
  } catch (e) {
    if (e.status === 409) return; // bereits zugestellt
    local.failed = true; local.pending = false;
    addMessage(local);
    throw e;
  }
}

function retrySend(m) {
  m.failed = false; m.pending = true;
  addMessage(m);
  deliver(m).catch((e) => snackbar(e.message));
}

function addMessage(m) {
  const contactId = m.from === S.me.id ? m.to : m.from;
  const list = S.messages.get(contactId);
  if (list) {
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) list[i] = { ...list[i], ...m, pending: m.pending || false, failed: m.failed || false };
    else { list.push(m); list.sort((a, b) => a.ts - b.ts); }
  }
  const c = S.contacts.get(contactId);
  if (c && !m.silent && (!c.last || c.last.ts <= m.ts || c.last.id === m.id)) c.last = m;
  if (S.chat === contactId) renderMessages({ scroll: m.from === S.me.id ? 'bottom' : undefined });
  renderList();
}

// ---------------------------------------------------------------- Anhänge
async function handleFiles(files, mode) {
  for (const file of files) {
    const isImage = file.type.startsWith('image/') && file.type !== 'image/svg+xml';
    if (mode === 'viewonce' && !isImage) { snackbar('Einmalansicht ist nur für Fotos möglich'); continue; }
    if ((mode === 'image' || mode === 'viewonce' || mode === 'auto') && isImage) await sendImage(file, mode === 'viewonce');
    else await sendFile(file);
  }
}

function addUpload(label) {
  const prog = progress({ value: 0, label });
  const cancel = new AbortController();
  const node = h('div', { class: 'msg-row mine' }, h('div', { class: 'bubble upload' },
    h('div', { class: 'upload-head' }, icon('lock', 16), h('span', {}, label), iconBtn('close', 'Abbrechen', () => cancel.abort())), prog.el));
  const u = { node, prog, cancel, contactId: S.chat };
  if (!S.uploads.has(S.chat)) S.uploads.set(S.chat, []);
  S.uploads.get(S.chat).push(u);
  renderMessages({ scroll: 'bottom' });
  return u;
}
function removeUpload(u) {
  const arr = S.uploads.get(u.contactId) || [];
  S.uploads.set(u.contactId, arr.filter((x) => x !== u));
  if (S.chat === u.contactId) renderMessages();
}

async function uploadEncrypted(blob, u) {
  if (blob.size + 16 * Math.ceil(blob.size / FILE_CHUNK + 1) > S.config.max_upload_bytes) throw new Error(`Datei zu groß (max. ${fmtBytes(S.config.max_upload_bytes)})`);
  u.prog.set(0, 'Verschlüsseln …');
  const enc = await encryptFile(await blob.arrayBuffer(), (v) => u.prog.set(v * 0.15, 'Verschlüsseln …'));
  if (u.cancel.signal.aborted) throw new ApiError(0, 'Abgebrochen');
  const t0 = performance.now();
  const up = await uploadBlob(enc.blob, (v) => {
    const secs = (performance.now() - t0) / 1000;
    const rate = v * enc.blob.size / Math.max(0.1, secs);
    u.prog.set(0.15 + v * 0.85, `Hochladen … ${Math.round(v * 100)} % · ${fmtBytes(rate)}/s`);
  }, u.cancel.signal);
  return { id: up.id, key: enc.key, nonce: enc.nonce, chunk: enc.chunk, size: blob.size };
}

async function sendImage(file, viewOnce) {
  const contactId = S.chat;
  const u = addUpload(viewOnce ? 'Einmalansicht-Foto' : 'Foto');
  try {
    u.prog.set(null, 'Komprimieren & Metadaten entfernen …');
    const img = await prepareImage(file);
    const meta = await uploadEncrypted(img.blob, u);
    const fileMeta = { ...meta, mime: img.mime, name: (file.name || 'foto').replace(/\.[^.]+$/, '') + (img.mime === 'image/jpeg' ? '.jpg' : '') };
    const payload = { t: 'image', file: fileMeta, w: img.width, h: img.height, thumb: viewOnce ? null : img.thumb, compressed: img.compressed };
    if (!viewOnce) S.blobs.set(meta.id, { blob: img.blob, url: URL.createObjectURL(img.blob) });
    removeUpload(u);
    await sendPayload(contactId, payload, { viewOnce, files: [meta.id] });
    if (img.compressed) snackbar(`Foto komprimiert: ${fmtBytes(file.size)} → ${fmtBytes(img.blob.size)}`);
  } catch (e) {
    removeUpload(u);
    if (e.message !== 'Upload abgebrochen' && e.message !== 'Abgebrochen') snackbar(e.message);
  }
}

async function sendFile(file) {
  const contactId = S.chat;
  if (file.size > S.config.max_upload_bytes - 64 * 1024) { snackbar(`„${file.name}“ ist zu groß (max. ${fmtBytes(S.config.max_upload_bytes)})`); return; }
  const u = addUpload(file.name);
  try {
    const meta = await uploadEncrypted(file, u);
    removeUpload(u);
    await sendPayload(contactId, { t: 'file', file: { ...meta, name: file.name || 'datei', mime: file.type || 'application/octet-stream' } }, { files: [meta.id] });
  } catch (e) {
    removeUpload(u);
    if (e.message !== 'Upload abgebrochen' && e.message !== 'Abgebrochen') snackbar(e.message);
  }
}

// ---------------------------------------------------------------- Sprachnachricht
async function recordVoice() {
  const c = S.contacts.get(S.chat);
  if (c?.keyChanged) { snackbar('Sicherheitsschlüssel geändert – bitte zuerst bestätigen'); return; }
  let rec;
  const level = h('div', { class: 'rec-level' });
  const time = h('span', { class: 'mono' }, '0:00');
  try {
    rec = await startRecording((lv, secs) => { level.style.transform = `scaleX(${0.08 + lv * 0.92})`; time.textContent = fmtDuration(secs); if (secs > 300) finish(); });
  } catch (e) {
    snackbar(e.name === 'NotAllowedError' ? 'Mikrofonzugriff verweigert – bitte in den Browser-Einstellungen erlauben.' : e.message);
    return;
  }
  vibrate(15);
  const contactId = S.chat;
  const bar = h('div', { class: 'recording' },
    iconBtn('delete', 'Verwerfen', () => { rec.cancel(); restore(); }),
    h('span', { class: 'rec-dot' }), time, h('div', { class: 'rec-track' }, level),
    h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Sprachnachricht senden', onclick: () => finish() }, icon('send')));
  const row = el.composer.querySelector('.composer-row');
  row.hidden = true;
  el.composer.append(bar);
  function restore() { bar.remove(); row.hidden = false; }
  let done = false;
  async function finish() {
    if (done) return;
    done = true;
    const r = await rec.stop();
    restore();
    if (r.duration < 0.7) { snackbar('Zu kurz – zum Aufnehmen tippen, zum Senden erneut tippen'); return; }
    const u = addUpload('Sprachnachricht');
    try {
      const meta = await uploadEncrypted(r.blob, u);
      S.blobs.set(meta.id, { blob: r.blob, url: URL.createObjectURL(r.blob) });
      removeUpload(u);
      await sendPayload(contactId, { t: 'voice', file: { ...meta, mime: r.mime, name: 'sprachnachricht' }, duration: r.duration });
    } catch (e) { removeUpload(u); snackbar(e.message); }
  }
}

// ---------------------------------------------------------------- Live-Typing
let typingActive = false, typingIdle = 0;
const sendTypingNow = throttle(async () => {
  const id = S.chat;
  if (!id || !S.ws || S.ws.readyState !== 1 || !S.me.settings.typing_indicator) return;
  const c = S.contacts.get(id), pin = S.pins.get(id);
  if (!c || c.keyChanged || !pin) return;
  const text = el.input?.value || '';
  if (!text.trim()) return sendTypingStop();
  const msg = { type: 'typing', to: id, state: 'typing' };
  if (S.me.settings.live_typing && !S.viewOnce) {
    // Vorschau wird wie jede Nachricht E2E-verschlüsselt und signiert, aber nicht gespeichert
    msg.preview = await sealMessage({ id: 'preview', from: S.me.id, to: id, payload: { t: 'draft', body: text.slice(-280) }, recipients: [{ id, encPub: pin.encPub }], signKey: S.keys.sigPriv, kv: S.me.key_version });
  }
  if (S.chat === id && el.input?.value.trim()) { S.ws.send(JSON.stringify(msg)); typingActive = true; }
}, 350);

function onTypingInput() {
  sendTypingNow();
  clearTimeout(typingIdle);
  typingIdle = setTimeout(sendTypingStop, 5000);
}
function sendTypingStop() {
  clearTimeout(typingIdle);
  if (typingActive && S.ws?.readyState === 1 && S.chat) S.ws.send(JSON.stringify({ type: 'typing', to: S.chat, state: 'stop' }));
  typingActive = false;
}

async function onTyping(ev) {
  if (ev.state === 'stop') S.typing.delete(ev.from);
  else {
    let preview = null;
    if (ev.preview) {
      try {
        const pin = S.pins.get(ev.from);
        const { payload } = await openMessage({ envelope: ev.preview, id: 'preview', from: ev.from, to: S.me.id, me: S.me.id, decKey: S.keys.encPriv, verifyKey: await importSigPub(pin.sigPub) });
        preview = payload.t === 'draft' ? payload.body : null;
      } catch { preview = null; }
    }
    S.typing.set(ev.from, { until: Date.now() + 6000, preview });
    setTimeout(() => { const t = S.typing.get(ev.from); if (t && t.until <= Date.now()) { S.typing.delete(ev.from); refreshTyping(ev.from); } }, 6100);
  }
  refreshTyping(ev.from);
}

function refreshTyping(contactId) {
  renderList();
  if (S.chat === contactId) { renderChatHeader(); renderMessages(); }
}

// ================================================================= Gelesen-Status
async function markRead(contactId) {
  if (document.hidden || S.chat !== contactId) return;
  const list = S.messages.get(contactId) || [];
  const unread = list.filter((m) => m.from === contactId && !m.read_at);
  if (!unread.length) { const c = S.contacts.get(contactId); if (c?.unread) { c.unread = 0; renderList(); } return; }
  const upTo = Math.max(...unread.map((m) => m.ts));
  unread.forEach((m) => { m.read_at = Date.now(); });
  const c = S.contacts.get(contactId);
  if (c) c.unread = 0;
  renderList();
  try { await api('/messages/read', { method: 'POST', body: { contact_id: contactId, up_to: upTo } }); } catch { /* nächster Versuch beim nächsten Öffnen */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.chat) markRead(S.chat); });

// ================================================================= WebSocket
let wsBackoff = 1000, wsTimer = 0;
function connectWS() {
  clearTimeout(wsTimer);
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    const reconnect = wsBackoff > 1000;
    wsBackoff = 1000;
    document.body.classList.remove('offline');
    if (reconnect) { loadContacts(); if (S.chat) loadMessages(S.chat).then(() => renderMessages()); }
  };
  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    if (e.code === 4401) return sessionExpired();
    document.body.classList.add('offline');
    wsTimer = setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 30000);
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message': {
      const m = ev.message;
      const incoming = m.from !== S.me.id;
      const contactId = incoming ? m.from : m.to;
      if (incoming) S.typing.delete(m.from);
      const c = S.contacts.get(contactId);
      if (incoming && c && !m.silent) {
        const visible = S.chat === contactId && !document.hidden;
        if (!visible) c.unread = (c.unread || 0) + 1;
        if (document.hidden && S.prefs.notifications && window.Notification?.permission === 'granted' && !c.muted) {
          try { new Notification('Vela', { body: `Neue Nachricht von ${c.username}`, tag: contactId }); } catch { /* ok */ }
        }
      }
      addMessage(m);
      if (incoming && S.chat === contactId) markRead(contactId);
      break;
    }
    case 'read':
      for (const m of S.messages.get(ev.by) || []) if (m.from === S.me.id && m.ts <= ev.up_to && !m.read_at) m.read_at = Date.now();
      if (S.chat === ev.by) renderMessages();
      break;
    case 'viewed':
    case 'deleted':
      for (const list of S.messages.values()) {
        const m = list.find((x) => x.id === ev.id);
        if (m) { m.envelope = null; m[ev.type === 'viewed' ? 'viewed_at' : 'deleted_at'] = ev.at; }
      }
      S.decoded.delete(ev.id);
      store.del('cache', cacheKey(ev.id)).catch(() => {});
      for (const c of S.contacts.values()) if (c.last?.id === ev.id) { c.last.envelope = null; c.last[ev.type === 'viewed' ? 'viewed_at' : 'deleted_at'] = ev.at; }
      renderList();
      if (S.chat) renderMessages();
      break;
    case 'typing': onTyping(ev); break;
    case 'contact_update': loadContacts(); break;
    default: break;
  }
}

function sessionExpired() {
  S.ws = null;
  renderLogin('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.');
}

// ================================================================= Einstellungen
function openSettings() {
  const page = h('div', { class: 'settings-page', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Einstellungen' });
  const close = () => { page.classList.remove('open'); setTimeout(() => page.remove(), 220); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape' && !document.querySelector('dialog[open]')) close(); };
  document.addEventListener('keydown', onKey);
  const body = h('div', { class: 'settings-body' });
  page.append(h('header', { class: 'top-bar' }, iconBtn('back', 'Zurück', close), h('div', { class: 'app-title' }, 'Einstellungen')), body);
  document.body.append(page);
  requestAnimationFrame(() => page.classList.add('open'));
  renderSettings(body, close);
}

async function saveServerSettings(patch) {
  const next = { ...S.me.settings, ...patch };
  try { S.me.settings = await api('/me/settings', { method: 'PUT', body: next }); } catch (e) { snackbar(e.message); }
}

async function renderSettings(body, close) {
  const fp = await shortFingerprint(S.keys.encPubB64, S.keys.sigPubB64);
  const section = (title, ...children) => h('section', { class: 'settings-section' }, h('h3', {}, title), ...children);
  const themeSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Design' });
  const renderTheme = () => clear(themeSeg, [['auto', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, l]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(S.prefs.theme === k), class: S.prefs.theme === k ? 'selected' : '',
    onclick: () => { S.prefs.theme = k; store.setPref('theme', k); applyTheme(k); renderTheme(); },
  }, S.prefs.theme === k ? icon('check', 18) : null, l)));
  renderTheme();
  const select = (opts, value, onChange, label) => h('select', { class: 'select', 'aria-label': label, onchange: (e) => onChange(e.target.value) },
    Object.entries(opts).map(([k, l]) => h('option', { value: k, selected: k === value }, l)));

  clear(body,
    h('div', { class: 'profile' }, avatar(S.me.username, 64), h('div', {}, h('div', { class: 'profile-name' }, S.me.username), h('div', { class: 'muted' }, S.me.email))),
    section('Sicherheit',
      h('div', { class: 'info-row' }, icon('key', 22), h('div', {}, h('div', {}, 'Dein Schlüssel-Fingerabdruck'), h('div', { class: 'mono small' }, fp),
        h('div', { class: 'small muted' }, `RSA-OAEP ${S.keys.bits} Bit · ECDSA P-256 · Schlüsselversion ${S.me.key_version}`))),
      h('div', { class: 'info-row' }, icon('verified', 22), h('div', {}, h('div', {}, 'Zwei-Faktor-Authentifizierung'), h('div', { class: 'small muted' }, 'Aktiv (Authenticator-App, TOTP)'))),
      h('div', { class: 'info-row' }, icon('lock', 22), h('div', {}, h('div', {}, 'Verbindung'), h('div', { class: 'small muted' }, location.protocol === 'https:' ? 'TLS-verschlüsselt (HTTPS/WSS)' : 'Ohne TLS – nur für localhost geeignet'))),
      button('Neue Schlüssel erzeugen …', { kind: 'text', icon: 'refresh', onClick: () => { close(); startRotate({ onCancel: () => enterApp() }); } })),
    section('Privatsphäre',
      switchRow({ label: 'Lesebestätigungen senden', desc: 'Kontakte sehen, wann du ihre Nachrichten gelesen hast.', checked: S.me.settings.read_receipts, onChange: (v) => saveServerSettings({ read_receipts: v }) }),
      switchRow({ label: 'Tipp-Indikator senden', desc: '„schreibt …“ wird angezeigt, während du tippst.', checked: S.me.settings.typing_indicator, onChange: (v) => saveServerSettings({ typing_indicator: v }) }),
      switchRow({ label: 'Live-Typing', desc: 'Dein Gegenüber sieht deinen Text schon während des Tippens (Ende-zu-Ende-verschlüsselt, wird nicht gespeichert). Auch unfertige Sätze werden sichtbar.', checked: S.me.settings.live_typing, onChange: (v) => saveServerSettings({ live_typing: v }) })),
    section('Sprachnachrichten',
      switchRow({ label: 'Transkription auf dem Gerät', desc: 'Sprachnachrichten werden lokal mit Whisper in Text umgewandelt. Das Audio verlässt dein Gerät nicht. Das Sprachmodell (öffentliche Daten) wird einmalig von Hugging Face geladen.', checked: S.prefs.transcription, onChange: (v) => { S.prefs.transcription = v; store.setPref('transcription', v); if (S.chat) renderMessages(); } }),
      h('div', { class: 'select-row' }, h('label', {}, 'Modell'), select(MODELS, S.prefs.model, (v) => { S.prefs.model = v; store.setPref('model', v); }, 'Transkriptionsmodell')),
      h('div', { class: 'select-row' }, h('label', {}, 'Sprache'), select({ german: 'Deutsch', english: 'Englisch', auto: 'Automatisch erkennen' }, S.prefs.language, (v) => { S.prefs.language = v; store.setPref('language', v); }, 'Sprache'))),
    section('Benachrichtigungen',
      switchRow({ label: 'Browser-Benachrichtigungen', desc: 'Nur „Neue Nachricht von …“ – niemals der Inhalt.', checked: S.prefs.notifications && window.Notification?.permission === 'granted', onChange: async (v) => {
        if (v && window.Notification) {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') { snackbar('Benachrichtigungen wurden im Browser nicht erlaubt'); v = false; }
        }
        S.prefs.notifications = v; store.setPref('notifications', v);
      } })),
    section('Darstellung', themeSeg),
    section('Daten & Konto',
      h('p', { class: 'small muted' }, `Verschlüsselte Nachrichten und Dateien werden spätestens nach ${S.config.retention_days} Tagen vom Server gelöscht. Einmalansichten sofort nach dem Öffnen.`),
      button('Meine Daten exportieren (DSGVO)', { kind: 'text', icon: 'download', onClick: exportData }),
      button('Abmelden', { kind: 'text', icon: 'logout', onClick: logoutDialog }),
      button('Konto löschen …', { kind: 'text', icon: 'delete', cls: 'danger', onClick: deleteAccountDialog })),
    h('p', { class: 'small muted center' }, 'Vela · Referenzimplementierung · Web Crypto API'));
}

async function exportData() {
  try {
    const res = await api('/me/export', { raw: true });
    if (!res.ok) throw new Error('Export fehlgeschlagen');
    saveBlob(await res.blob(), 'vela-datenexport.json');
  } catch (e) { snackbar(e.message); }
}

function logoutDialog() {
  const cb = h('input', { type: 'checkbox', id: 'wipe' });
  dialog({
    title: 'Abmelden', icon: 'logout',
    body: h('div', {}, h('label', { class: 'check-row', for: 'wipe' }, cb, h('span', {}, 'Schlüssel und Nachrichtenverlauf von diesem Gerät entfernen (empfohlen auf fremden Geräten). Zum erneuten Anmelden brauchst du dann deinen Wiederherstellungsschlüssel.'))),
    actions: [{ label: 'Abbrechen' }, { label: 'Abmelden', primary: true, onClick: () => logout(cb.checked) }],
  });
}

async function logout(wipe) {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* trotzdem lokal abmelden */ }
  const ws = S.ws; S.ws = null; ws?.close();
  if (wipe) await store.wipe();
  for (const b of S.blobs.values()) URL.revokeObjectURL(b.url);
  S.blobs.clear(); S.decoded.clear(); payloadNodes.clear(); S.keys = null; S.me = null;
  document.querySelector('.settings-page')?.remove();
  renderLogin(wipe ? 'Abgemeldet. Schlüssel und Verlauf wurden von diesem Gerät entfernt.' : 'Abgemeldet.');
}

function deleteAccountDialog() {
  const pw = field({ label: 'Passwort', name: 'pw', type: 'password', autocomplete: 'current-password' });
  const code = field({ label: '2FA-Code', name: 'code', autocomplete: 'one-time-code', attrs: { inputmode: 'numeric', maxlength: 7 } });
  dialog({
    title: 'Konto endgültig löschen?', icon: 'delete',
    body: h('div', {}, h('p', {}, 'Konto, Kontakte, alle verschlüsselten Nachrichten und Dateien werden sofort vom Server gelöscht. Das kann nicht rückgängig gemacht werden.'), pw.wrap, code.wrap),
    actions: [{ label: 'Abbrechen' }, {
      label: 'Endgültig löschen', tonal: true, danger: true, onClick: async () => {
        try {
          await api('/me/delete', { method: 'POST', body: { password: pw.input.value, code: code.input.value.replace(/\s/g, '') } });
          await store.wipe();
          document.querySelector('.settings-page')?.remove();
          S.ws?.close(); S.ws = null;
          renderLogin('Dein Konto wurde gelöscht.');
        } catch (e) { code.setError(e.message); return false; }
      },
    }],
  });
}

boot();
