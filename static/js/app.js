// Vela – Hauptanwendung: Navigation, Chatliste, Chat, Echtzeit, Medien.
// Darstellung über schlüsselbasierten DOM-Abgleich: Unveränderte Nachrichten/Zeilen werden nie
// neu erzeugt – dadurch flackert nichts, und laufende Wiedergaben bleiben erhalten.
import {
  h, clear, icon, iconBtn, initials, hue, randomId, fmtBytes, fmtTime, fmtDay, fmtListTime, fmtDuration,
  throttle, isTouch, vibrate,
} from './util.js';
import { api, ApiError, uploadBlob, downloadBuffer } from './api.js';
import {
  cryptoAvailable, sealMessage, openMessage, encryptFile, decryptFile, importSigPub, safetyNumber, shortFingerprint, FILE_CHUNK,
} from './crypto.js';
import * as store from './store.js';
import { S, cacheKey } from './state.js';
import { initAuth, renderLogin, renderRestore } from './auth.js';
import { dialog, confirm, snackbar, menu, progress, field, button, initRipple, reconcile } from './ui.js';
import { swipeable } from './gestures.js';
import { prepareImage, startRecording, canPlayAudio } from './media.js';
import { transcribe } from './transcribe.js';
import { initStatus, renderStatusView, loadStatuses, statusEvent, hasUnseenStatus } from './status.js';
import { initProfile, renderProfileView } from './profile.js';

const root = document.getElementById('app');
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const QUICK = ['❤️', '👍', '😂'];
const AUTO_DOWNLOAD_MAX = 10 * 1024 * 1024;
const GROUP_GAP_MS = 3 * 60 * 1000;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const compact = () => !matchMedia('(min-width: 840px)').matches;
let el = {};
const payloadNodes = new Map(); // Medien-Elemente (Wiedergabe-Zustand) über Neu-Darstellungen erhalten
const msgNodes = new Map();     // Nachrichten-ID -> { row, sig }
const dayNodes = new Map();
const rowNodes = new Map();     // Kontakt-Schlüssel -> Zeile der Chatliste
const previews = new Map();     // Kontakt-ID -> { id, text }
let hidden = new Set();
let initialRender = true;

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
  initRipple();
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

export function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#0e1513' : '#f4fbf8');
}

// ================================================================= Avatare
export function avatarUrl(user) {
  return user?.avatar_version ? `/api/avatars/${user.id}?v=${user.avatar_version}` : null;
}

export function avatarEl(user, size = 40, { ring = null } = {}) {
  const name = user?.username || '?';
  const box = h('div', { class: 'avatar' + (ring ? ' ring ' + ring : ''), style: { '--h': hue(name), width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' }, 'aria-hidden': 'true' },
    h('span', { class: 'avatar-initials' }, initials(name)));
  const url = avatarUrl(user);
  if (url) {
    const img = h('img', { src: url, alt: '', loading: 'lazy', draggable: false });
    img.addEventListener('error', () => img.remove());
    box.append(img);
  }
  return box;
}

// ================================================================= App-Gerüst mit Navigation
const VIEWS = [
  { id: 'chats', label: 'Chats', icon: 'chat' },
  { id: 'status', label: 'Status', icon: 'status' },
  { id: 'profile', label: 'Profil', icon: 'person' },
];

async function enterApp() {
  S.contacts.clear(); S.messages.clear(); S.decoded.clear(); S.dec = new Map(); S.chat = null;
  msgNodes.clear(); rowNodes.clear(); previews.clear(); dayNodes.clear();
  hidden = new Set((await store.pref(cacheKey('hidden'), [])) || []);
  S.view = 'chats';
  el = {};
  el.search = h('input', { type: 'search', class: 'search-input', placeholder: 'Chats durchsuchen', 'aria-label': 'Chats durchsuchen',
    oninput: (e) => { S.search = e.target.value.toLowerCase(); renderList(); } });
  el.tabs = h('div', { class: 'tabs', role: 'tablist' });
  el.listProgress = progress({ value: null, cls: 'thin top' });
  el.list = h('div', { class: 'chat-list', role: 'list' });
  el.views = {
    chats: h('section', { class: 'view', dataset: { view: 'chats' } },
      h('header', { class: 'top-bar' },
        h('div', { class: 'app-title' }, h('span', { class: 'brand-mini' }, icon('shield', 22)), 'Chats'),
        h('div', { class: 'spacer' }),
        iconBtn('person_add', 'Kontakt hinzufügen', addContactDialog, 'hide-compact')),
      h('div', { class: 'search-wrap' }, icon('search', 20), el.search),
      el.tabs, el.listProgress.el, el.list,
      h('button', { class: 'fab show-compact', 'aria-label': 'Kontakt hinzufügen', onclick: addContactDialog }, icon('person_add'), h('span', { class: 'fab-label' }, 'Neuer Chat'))),
    status: h('section', { class: 'view', dataset: { view: 'status' }, hidden: true }),
    profile: h('section', { class: 'view', dataset: { view: 'profile' }, hidden: true }),
  };
  el.navItems = {};
  const navButton = (v, cls) => {
    const btn = h('button', { class: 'nav-item', type: 'button', 'aria-label': v.label, onclick: () => switchView(v.id) },
      h('span', { class: 'nav-icon' }, h('span', { class: 'nav-pill' }), v.id === 'profile' ? h('span', { class: 'nav-avatar' }) : icon(v.icon, 24), h('span', { class: 'nav-badge' })),
      h('span', { class: 'nav-label' }, v.label));
    (el.navItems[v.id] ||= []).push(btn);
    return btn;
  };
  el.bottomNav = h('nav', { class: 'bottom-nav', 'aria-label': 'Hauptnavigation' }, VIEWS.map((v) => navButton(v)));
  el.rail = h('nav', { class: 'nav-rail', 'aria-label': 'Hauptnavigation' },
    h('div', { class: 'rail-brand' }, icon('shield', 26)),
    h('button', { class: 'rail-fab', type: 'button', 'aria-label': 'Kontakt hinzufügen', onclick: addContactDialog }, icon('edit', 22)),
    h('div', { class: 'rail-items' }, VIEWS.map((v) => navButton(v))));
  el.chatPane = h('main', { class: 'pane chat-pane', 'aria-live': 'off' });
  el.listPane = h('aside', { class: 'pane list-pane' }, Object.values(el.views), el.bottomNav);
  el.shell = h('div', { class: 'app-shell', dataset: { view: 'chats' } }, el.rail, el.listPane, el.chatPane);
  clear(root, el.shell);
  initStatus(statusCtx());
  initProfile(profileCtx());
  renderEmptyChat();
  renderSkeleton();
  refreshNav();
  loadContacts();
  loadStatuses().then(refreshNav).catch(() => {});
  connectWS();
}

function statusCtx() {
  return { avatarEl, root: () => el.views.status, openChatWithReply, refreshNav, switchView, contactsWithKeys, getFile, uploadEncrypted, sendPayload };
}
function profileCtx() {
  return { avatarEl, refreshNav, applyTheme, logout, rerenderMessages: () => S.chat && renderMessages(), enterApp };
}

export function switchView(view) {
  if (S.view === view) {
    if (view === 'chats') el.list.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  const prev = el.views[S.view];
  const next = el.views[view];
  S.view = view;
  el.shell.dataset.view = view;
  if (view === 'status') renderStatusView();
  if (view === 'profile') renderProfileView(el.views.profile);
  prev.hidden = true;
  next.hidden = false;
  next.classList.remove('view-enter');
  void next.offsetWidth; // Animation neu starten
  next.classList.add('view-enter');
  if (compact() && S.chat) closeChat();
  refreshNav();
}

export function refreshNav() {
  if (!el.navItems) return;
  const unread = [...S.contacts.values()].filter((c) => c.status === 'accepted' && !c.archived && c.unread).length;
  const requests = [...S.contacts.values()].filter((c) => c.status === 'pending_in').length;
  for (const v of VIEWS) {
    for (const btn of el.navItems[v.id] || []) {
      btn.classList.toggle('active', S.view === v.id);
      btn.setAttribute('aria-current', S.view === v.id ? 'page' : 'false');
      const badge = btn.querySelector('.nav-badge');
      if (v.id === 'chats') { badge.textContent = unread + requests || ''; badge.classList.toggle('show', unread + requests > 0); }
      if (v.id === 'status') { badge.textContent = ''; badge.classList.toggle('show', hasUnseenStatus()); badge.classList.add('dot'); }
      if (v.id === 'profile' && S.me) {
        const slot = btn.querySelector('.nav-avatar');
        const key = S.me.avatar_version + ':' + S.me.username;
        if (slot.dataset.key !== key) { slot.dataset.key = key; clear(slot, avatarEl(S.me, 26)); }
      }
    }
  }
}

function renderSkeleton() {
  clear(el.list, Array.from({ length: 5 }, (_, i) => h('div', { class: 'skeleton-row', style: { animationDelay: i * 80 + 'ms' } },
    h('div', { class: 'sk sk-avatar' }), h('div', { class: 'sk-lines' }, h('div', { class: 'sk sk-line' }), h('div', { class: 'sk sk-line short' })))));
}

function renderEmptyChat() {
  clear(el.chatPane, h('div', { class: 'empty-chat' },
    h('div', { class: 'empty-icon' }, icon('lock', 48)),
    h('h2', {}, 'Wähle einen Chat'),
    h('p', {}, 'Alle Nachrichten, Bilder, Dateien und Sprachnachrichten werden auf deinem Gerät verschlüsselt (RSA-OAEP + AES-256-GCM) und erst beim Empfänger entschlüsselt.'),
    h('p', { class: 'muted small' }, `Verschlüsselte Inhalte liegen höchstens ${S.config.retention_days} Tage auf dem Server.`)));
}

// ================================================================= Kontakte
let firstContactLoad = true;
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
      if (before) Object.assign(before, c); else S.contacts.set(c.id, c);
    }
    for (const id of [...S.contacts.keys()]) if (!seen.has(id)) S.contacts.delete(id);
    await syncPins();
    firstContactLoad = false;
    renderList();
    if (S.chat && !S.contacts.has(S.chat)) closeChat();
    else if (S.chat) renderChatHeader();
    if (S.view === 'status') renderStatusView();
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

export function contactsWithKeys() {
  return [...S.contacts.values()].filter((c) => c.status === 'accepted' && !c.keyChanged && S.pins.get(c.id))
    .map((c) => ({ id: c.id, encPub: S.pins.get(c.id).encPub }));
}

async function acceptNewKey(c) {
  const old = S.pins.get(c.id) || { history: {} };
  const pin = { ...old, encPub: c.enc_pub, sigPub: c.sig_pub, keyVersion: c.key_version, bits: c.key_bits, verified: false, history: { ...old.history, [c.key_version]: c.sig_pub } };
  await store.put('pins', cacheKey('pin:' + c.id), pin);
  S.pins.set(c.id, pin);
  c.keyChanged = false;
  for (const m of S.messages.get(c.id) || []) if (m.from === c.id) { S.decoded.delete(m.id); S.dec.delete(m.id); msgNodes.delete(m.id); }
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

let lastTabsKey = '';
function renderList() {
  if (!el.list) return;
  refreshNav();
  const all = [...S.contacts.values()];
  const counts = {
    chats: all.filter((c) => c.status === 'accepted' && !c.archived && c.unread).length,
    archive: all.filter((c) => c.status === 'accepted' && c.archived).length,
    requests: all.filter((c) => c.status === 'pending_in').length,
  };
  const tabsKey = S.tab + JSON.stringify(counts);
  if (tabsKey !== lastTabsKey) {
    lastTabsKey = tabsKey;
    clear(el.tabs, [['chats', 'Alle'], ['archive', 'Archiv'], ['requests', 'Anfragen']].map(([k, label]) => h('button', {
      role: 'tab', class: 'tab' + (S.tab === k ? ' active' : ''), 'aria-selected': String(S.tab === k),
      onclick: () => { S.tab = k; renderList(); },
    }, S.tab === k ? icon('check', 18) : null, label, counts[k] ? h('span', { class: 'badge' + (k === 'archive' ? ' quiet' : '') }, counts[k]) : null)));
  }

  const items = contactsFor(S.tab);
  if (!items.length) {
    if (firstContactLoad) return;
    const msg = S.search ? 'Keine Treffer.' : S.tab === 'requests' ? 'Keine offenen Kontaktanfragen.' : S.tab === 'archive' ? 'Archivierte Chats erscheinen hier. Wische einen Chat nach links, um ihn zu archivieren.' : 'Noch keine Chats. Füge einen Kontakt über seinen Nutzernamen hinzu – nach der Annahme werden eure öffentlichen Schlüssel ausgetauscht.';
    const key = 'empty:' + msg;
    if (el.list.dataset.key !== key) {
      el.list.dataset.key = key;
      clear(el.list, h('div', { class: 'list-empty' }, h('div', { class: 'empty-icon small' }, icon(S.tab === 'archive' ? 'archive' : 'chat', 32)), h('p', {}, msg),
        S.tab === 'chats' && !S.search ? button('Kontakt hinzufügen', { kind: 'tonal', icon: 'person_add', onClick: addContactDialog }) : null));
    }
    return;
  }
  el.list.dataset.key = '';
  reconcile(el.list, items.map((c) => (c.status === 'accepted' ? chatRow(c) : requestRow(c))));
}

function requestRow(c) {
  const key = `req:${c.id}:${c.status}`;
  if (rowNodes.has(key)) return rowNodes.get(key);
  const incoming = c.status === 'pending_in';
  const row = h('div', { class: 'chat-row request enter', role: 'listitem' },
    h('div', { class: 'row-inner static' }, avatarEl(c, 48),
      h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, c.username),
        h('div', { class: 'row-sub' }, incoming ? 'möchte mit dir chatten' : 'Anfrage gesendet – wartet auf Annahme')),
      h('div', { class: 'row-actions' },
        incoming ? button('Annehmen', { kind: 'filled', cls: 'small', onClick: () => acceptContact(c) }) : null,
        button(incoming ? 'Ablehnen' : 'Zurückziehen', { kind: 'text', cls: 'small', onClick: () => removeContact(c, true) }))));
  rowNodes.set(key, row);
  return row;
}

function chatRow(c) {
  const key = `chat:${c.id}:${c.archived ? 1 : 0}:${c.pinned ? 1 : 0}:${c.avatar_version || 0}`;
  let row = rowNodes.get(key);
  if (!row) {
    const r = {};
    r.title = h('span', { class: 'row-name' });
    r.flags = h('span', { class: 'row-flags' });
    r.sub = h('div', { class: 'row-sub' });
    r.time = h('div', { class: 'row-time' });
    r.badge = h('span', { class: 'badge pop' });
    const content = h('div', { class: 'row-inner', tabindex: 0, role: 'button', 'aria-label': `Chat mit ${c.username}`,
      onclick: () => openChat(c.id), onkeydown: (e) => { if (e.key === 'Enter') openChat(c.id); } },
    avatarEl(c, 52),
    h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, r.title, r.flags), r.sub),
    h('div', { class: 'row-meta' }, r.time, h('div', { class: 'row-badges' },
      c.pinned ? h('span', { class: 'pin', title: 'Markiert' }, icon('pin', 16)) : null, r.badge)));
    row = h('div', { class: 'chat-row' + (firstContactLoad ? '' : ' enter'), role: 'listitem', dataset: { id: c.id } });
    const id = c.id;
    swipeable(row, content, {
      left: { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Zurückholen' : 'Archivieren', color: 'tertiary', dismiss: true, action: () => toggleArchive(S.contacts.get(id)) },
      right: { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', color: 'primary', action: () => togglePin(S.contacts.get(id)) },
      onLongPress: (x, y) => chatMenu(S.contacts.get(id), x, y),
    });
    row._r = r;
    for (const k of [...rowNodes.keys()]) if (k.startsWith(`chat:${c.id}:`)) rowNodes.delete(k);
    rowNodes.set(key, row);
  }
  patchRow(row, c);
  return row;
}

function setText(node, text) { if (node.textContent !== text) node.textContent = text; }

function patchRow(row, c) {
  const r = row._r;
  setText(r.title, c.username);
  const flagKey = `${c.keyChanged ? 1 : 0}${S.pins.get(c.id)?.verified ? 1 : 0}`;
  if (r.flags.dataset.k !== flagKey) {
    r.flags.dataset.k = flagKey;
    clear(r.flags, c.keyChanged ? h('span', { class: 'warn-dot', title: 'Sicherheitsschlüssel geändert' }, icon('warn', 16)) : null,
      S.pins.get(c.id)?.verified ? h('span', { class: 'verified', title: 'Verifiziert' }, icon('verified', 16)) : null);
  }
  row.classList.toggle('selected', S.chat === c.id);
  setText(r.time, c.last ? fmtListTime(c.last.ts) : '');
  r.time.classList.toggle('unread', !!c.unread);
  setText(r.badge, c.unread ? String(c.unread) : '');
  r.badge.hidden = !c.unread;
  const t = S.typing.get(c.id);
  const typing = t && t.until > Date.now();
  r.sub.classList.toggle('typing', !!typing);
  if (typing) { setText(r.sub, 'schreibt …'); return; }
  setText(r.sub, previewFor(c));
}

function previewFor(c) {
  const m = c.last;
  if (!m) return 'Sicher verbunden – sag Hallo 👋';
  const prefix = m.from === S.me.id ? 'Du: ' : '';
  if (m.deleted_at) return prefix + 'Nachricht gelöscht';
  if (m.view_once) return prefix + (m.viewed_at ? 'Einmalansicht · geöffnet' : '👁 Einmalansicht');
  const p = previews.get(c.id);
  if (p && p.id === m.id) return prefix + p.text;
  decode(m).then((d) => {
    previews.set(c.id, { id: m.id, text: d?.payload ? previewText(d.payload) : '⚠ Nicht entschlüsselbar' });
    const row = [...rowNodes.entries()].find(([k]) => k.startsWith(`chat:${c.id}:`))?.[1];
    if (row) patchRow(row, c);
  });
  return prefix + '🔒 …';
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
  if (!c) return;
  const archived = !c.archived;
  patchContact(c, { archived });
  vibrate(10);
  snackbar(archived ? `Chat mit ${c.username} archiviert` : 'Chat zurückgeholt', { action: 'Rückgängig', onAction: () => patchContact(c, { archived: !archived }) });
}
function togglePin(c) { if (!c) return; patchContact(c, { pinned: !c.pinned }); snackbar(c.pinned ? 'Chat markiert und oben angeheftet' : 'Markierung entfernt'); }

function chatMenu(c, x, y) {
  if (!c) return;
  menu([
    { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', onClick: () => togglePin(c) },
    { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Aus Archiv holen' : 'Archivieren', onClick: () => toggleArchive(c) },
    { icon: 'person', label: 'Kontaktinfo', onClick: () => contactSheet(c) },
    { icon: 'shield', label: 'Sicherheitsnummer prüfen', onClick: () => verifyDialog(c) },
    { icon: 'delete', label: 'Kontakt & Chat löschen', danger: true, onClick: () => removeContact(c) },
  ], x, y, { header: h('div', { class: 'menu-header' }, avatarEl(c, 36), h('strong', {}, c.username)) });
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
            if (S.view !== 'chats') switchView('chats');
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

function contactSheet(c) {
  const pin = S.pins.get(c.id);
  dialog({
    cls: 'contact-sheet',
    body: h('div', { class: 'contact-info' },
      avatarEl(c, 112),
      h('h2', {}, c.username),
      c.about ? h('p', { class: 'about' }, c.about) : h('p', { class: 'muted' }, 'Keine Info hinterlegt'),
      h('div', { class: 'chip-row center' },
        h('span', { class: 'chip static' }, icon(pin?.verified ? 'verified' : 'lock', 18), pin?.verified ? 'Verifiziert' : 'Ende-zu-Ende-verschlüsselt'),
        h('span', { class: 'chip static' }, icon('key', 18), `RSA ${pin?.bits || c.key_bits}`))),
    actions: [
      { label: 'Sicherheitsnummer', onClick: () => { setTimeout(() => verifyDialog(c), 50); } },
      { label: 'Schließen', primary: true },
    ],
  });
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
      h('div', { class: 'safety-grid' }, digits.map((g, i) => h('span', { style: { animationDelay: i * 30 + 'ms' } }, g))),
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
export async function verifyKeyFor(m) {
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
  })().then((res) => { S.dec.set(m.id, res); return res; });
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
  msgNodes.clear(); dayNodes.clear();
  initialRender = true;
  newWhileScrolled = 0;
  el.shell.classList.add('chat-open');
  if (compact() && !wasOpen && !keepHistory) history.pushState({ chat: id }, '', '#chat');
  for (const r of el.list.querySelectorAll('.chat-row')) r.classList.toggle('selected', r.dataset.id === id);

  el.header = h('header', { class: 'top-bar chat-bar' });
  el.banner = h('div', { class: 'banner-slot' });
  el.msgs = h('div', { class: 'messages', role: 'log', 'aria-label': `Nachrichten mit ${c.username}` });
  el.msgs.addEventListener('scroll', onMessagesScroll, { passive: true });
  el.msgProgress = progress({ value: null, cls: 'thin top' });
  el.typingSlot = h('div', { class: 'typing-slot', 'aria-live': 'polite' }, h('div', { class: 'typing-inner' }));
  el.toBottom = h('button', { class: 'to-bottom', type: 'button', 'aria-label': 'Zu den neuesten Nachrichten', onclick: () => scrollToBottom(true) },
    icon('arrow_down', 22), h('span', { class: 'to-bottom-badge' }));
  el.composer = buildComposer(c);
  clear(el.chatPane, h('div', { class: 'chat chat-enter' }, el.header, el.msgProgress.el, el.banner,
    h('div', { class: 'messages-wrap' }, el.msgs, el.toBottom), el.typingSlot, el.composer));
  renderChatHeader();
  renderTyping();

  if (!S.messages.has(id)) await loadMessages(id);
  else el.msgProgress.el.hidden = true;
  await renderMessages({ scroll: 'bottom' });
  initialRender = false;
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

export async function openChatWithReply(contactId, reply) {
  if (S.view !== 'chats') switchView('chats');
  await openChat(contactId);
  if (reply) { S.reply = reply; renderReplyPreview(); el.input?.focus(); }
}

addEventListener('popstate', () => { if (S.chat && compact()) closeChat(); });
addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.chat && !document.querySelector('dialog[open], .menu-scrim, .viewer, .story')) { if (compact()) history.back(); else closeChat(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && el.search) { e.preventDefault(); switchView('chats'); el.search.focus(); }
});

function renderChatHeader() {
  const c = S.contacts.get(S.chat);
  if (!c || !el.header) return;
  const pin = S.pins.get(c.id);
  const t = S.typing.get(c.id);
  const typing = t && t.until > Date.now();
  const key = [c.username, c.avatar_version, pin?.verified, typing, c.keyChanged, c.archived, c.pinned].join('|');
  if (el.header.dataset.key !== key) {
    el.header.dataset.key = key;
    clear(el.header,
      iconBtn('back', 'Zurück', () => (compact() ? history.back() : closeChat()), 'show-compact'),
      h('button', { class: 'chat-title', type: 'button', onclick: () => contactSheet(c) },
        avatarEl(c, 42),
        h('div', { class: 'chat-title-text' },
          h('div', { class: 'name' }, c.username),
          h('div', { class: 'status' + (typing ? ' typing' : '') },
            typing ? 'schreibt …' : [icon(pin?.verified ? 'verified' : 'lock', 14), pin?.verified ? ' Verifiziert · Ende-zu-Ende-verschlüsselt' : ' Ende-zu-Ende-verschlüsselt']))),
      iconBtn('shield', 'Sicherheitsnummer', () => verifyDialog(c)),
      iconBtn('more', 'Mehr', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        menu([
          { icon: 'person', label: 'Kontaktinfo', onClick: () => contactSheet(c) },
          { icon: 'shield', label: 'Sicherheitsnummer prüfen', onClick: () => verifyDialog(c) },
          { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Aus Archiv holen' : 'Archivieren', onClick: () => toggleArchive(c) },
          { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', onClick: () => togglePin(c) },
          { icon: 'delete', label: 'Kontakt & Chat löschen', danger: true, onClick: () => removeContact(c) },
        ], r.right - 220, r.bottom);
      }));
    clear(el.banner, c.keyChanged ? h('div', { class: 'banner warn' }, icon('warn', 20),
      h('span', {}, `Der Sicherheitsschlüssel von ${c.username} hat sich geändert (z. B. neues Gerät oder neue Schlüssel). Prüfe die Sicherheitsnummer, bevor du weiterschreibst.`),
      button('Neuen Schlüssel akzeptieren', { kind: 'tonal', cls: 'small', onClick: () => acceptNewKey(c) })) : null);
  }
  el.composer?.classList.toggle('blocked', !!c.keyChanged);
}

async function loadMessages(id, before) {
  if (el.msgProgress) el.msgProgress.el.hidden = false;
  try {
    const res = await api(`/messages/${id}${before ? '?before=' + before : ''}`);
    const list = S.messages.get(id) || [];
    const known = new Set(list.map((m) => m.id));
    const merged = [...res.messages.filter((m) => !known.has(m.id)), ...list].sort((a, b) => a.ts - b.ts);
    S.messages.set(id, merged);
    S.hasMore.set(id, res.has_more);
  } catch (e) { snackbar(e.message); } finally { if (el.msgProgress) el.msgProgress.el.hidden = true; }
}

function reactionMap(list) {
  const map = new Map();
  for (const m of list) {
    if (!m.silent) continue;
    const d = S.dec.get(m.id);
    if (d?.payload?.t !== 'reaction') continue;
    if (!map.has(d.payload.target)) map.set(d.payload.target, new Map());
    map.get(d.payload.target).set(m.from, d.payload.emoji);
  }
  return map;
}

// ---------------------------------------------------------------- Scrollen
let newWhileScrolled = 0;
const distanceFromBottom = () => el.msgs.scrollHeight - el.msgs.scrollTop - el.msgs.clientHeight;
function onMessagesScroll() {
  const far = distanceFromBottom() > 320;
  el.toBottom.classList.toggle('show', far);
  if (!far && newWhileScrolled) { newWhileScrolled = 0; updateToBottom(); }
}
function updateToBottom() {
  const b = el.toBottom?.querySelector('.to-bottom-badge');
  if (!b) return;
  b.textContent = newWhileScrolled ? String(newWhileScrolled) : '';
  b.classList.toggle('show', newWhileScrolled > 0);
}
function scrollToBottom(smooth) {
  if (!el.msgs) return;
  el.msgs.scrollTo({ top: el.msgs.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  newWhileScrolled = 0;
  updateToBottom();
}

// ---------------------------------------------------------------- Nachrichten darstellen (Abgleich)
let renderToken = 0;
async function renderMessages({ scroll } = {}) {
  const id = S.chat;
  if (!id || !el.msgs) return;
  const token = ++renderToken;
  const list = S.messages.get(id) || [];
  const todo = list.filter((m) => m.envelope && !m.view_once && !S.dec.has(m.id));
  if (todo.length) await Promise.all(todo.map(decode));
  if (token !== renderToken || S.chat !== id) return;

  const wasAtBottom = distanceFromBottom() < 120;
  const prevHeight = el.msgs.scrollHeight, prevTop = el.msgs.scrollTop;
  const reactions = reactionMap(list);
  const visible = list.filter((m) => !m.silent && !hidden.has(m.id));
  const nodes = [];
  if (S.hasMore.get(id)) {
    el.loadMore ||= h('div', { class: 'load-more' }, button('Ältere Nachrichten laden', { kind: 'text', onClick: async () => {
      const cur = S.messages.get(S.chat) || [];
      await loadMessages(S.chat, cur[0]?.ts); renderMessages({ scroll: 'keep' });
    } }));
    nodes.push(el.loadMore);
  }
  el.e2eNote ||= h('div', { class: 'e2e-note' }, icon('lock', 14), ` Nachrichten sind Ende-zu-Ende-verschlüsselt. Verschlüsselte Inhalte werden nach ${S.config.retention_days} Tagen vom Server gelöscht.`);
  nodes.push(el.e2eNote);
  let lastDay = '';
  const live = new Set();
  visible.forEach((m, i) => {
    const day = fmtDay(m.ts);
    if (day !== lastDay) {
      if (!dayNodes.has(day)) dayNodes.set(day, h('div', { class: 'day-sep' }, h('span', {}, day)));
      nodes.push(dayNodes.get(day));
      lastDay = day;
    }
    const prev = visible[i - 1], next = visible[i + 1];
    const first = !prev || prev.from !== m.from || m.ts - prev.ts > GROUP_GAP_MS || fmtDay(prev.ts) !== day;
    const last = !next || next.from !== m.from || next.ts - m.ts > GROUP_GAP_MS || fmtDay(next.ts) !== day;
    nodes.push(messageRow(m, reactions.get(m.id), first, last));
    live.add(m.id);
  });
  for (const u of S.uploads.get(id) || []) nodes.push(u.node);
  reconcile(el.msgs, nodes);
  for (const k of [...msgNodes.keys()]) if (!live.has(k)) msgNodes.delete(k);

  if (scroll === 'bottom') scrollToBottom(false);
  else if (scroll === 'keep') el.msgs.scrollTop = prevTop + (el.msgs.scrollHeight - prevHeight);
  else if (scroll === 'smooth' || wasAtBottom) scrollToBottom(!initialRender && scroll !== 'instant');
}

function reactionKey(reacts) {
  if (!reacts) return '';
  return [...reacts].filter(([, e]) => e).map(([u, e]) => u + e).sort().join(',');
}

function messageRow(m, reacts, first, last) {
  const d = S.dec.get(m.id);
  const sig = [m.read_at ? 1 : 0, m.viewed_at ? 1 : 0, m.deleted_at ? 1 : 0, m.pending ? 1 : 0, m.failed ? 1 : 0,
    m.envelope ? 1 : 0, d ? (d.error ? 'e' : 'ok') : '-', first ? 1 : 0, last ? 1 : 0, reactionKey(reacts)].join('|');
  const cached = msgNodes.get(m.id);
  if (cached && cached.sig === sig) return cached.row;
  const row = buildMessageRow(m, d, reacts, first, last);
  if (!cached && !initialRender) {
    row.classList.add('enter');
    row.addEventListener('animationend', () => row.classList.remove('enter'), { once: true });
  }
  if (cached?.row.isConnected) cached.row.replaceWith(row);
  msgNodes.set(m.id, { row, sig });
  return row;
}

function buildMessageRow(m, d, reactions, first, last) {
  const mine = m.from === S.me.id;
  const c = S.contacts.get(S.chat);
  const bubble = h('div', { class: 'bubble' });
  const meta = h('span', { class: 'meta' }, fmtTime(m.ts),
    mine ? (m.failed ? h('span', { class: 'tick failed', title: 'Nicht gesendet' }, icon('warn', 15))
      : m.pending ? h('span', { class: 'tick pending', title: 'Wird gesendet' }, icon('timer', 15))
        : h('span', { class: 'tick' + (m.read_at ? ' read' : ''), title: m.read_at ? 'Gelesen' : 'Gesendet' }, icon(m.read_at ? 'done_all' : 'check', 15))) : null);
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
  } else if (!d || d.error) {
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
    if (payload.t === 'image' || payload.t === 'voice' || payload.t === 'file') bubble.classList.add('media-bubble', 'b-' + payload.t);
    if (payload.t === 'text' && /^\p{Extended_Pictographic}{1,3}$/u.test(payload.body)) bubble.classList.add('emoji-only');
    bubble.append(pnode, meta);
  }
  if (m.failed) bubble.append(button('Erneut senden', { kind: 'text', cls: 'small', onClick: () => retrySend(m) }));

  const row = h('div', { class: `msg-row ${mine ? 'mine' : 'theirs'}${first ? ' first' : ''}${last ? ' last' : ''}`, dataset: { id: m.id } });
  const wrap = h('div', { class: 'bubble-wrap' }, bubble);
  if (reactions && reactions.size) {
    const counts = new Map();
    for (const [, emo] of reactions) if (emo) counts.set(emo, (counts.get(emo) || 0) + 1);
    if (counts.size) {
      wrap.append(h('div', { class: 'reactions' }, [...counts].map(([emo, n]) => h('button', {
        class: 'reaction no-gesture' + (reactions.get(S.me.id) === emo ? ' mine' : ''), type: 'button', onclick: () => react(m, emo),
        'aria-label': `Reaktion ${emo}, ${n}`,
      }, emo, n > 1 ? h('span', {}, n) : null))));
    }
  }
  if (!m.deleted_at && !m.pending) {
    // Desktop: Aktionsleiste erscheint beim Überfahren ÜBER der Nachricht
    const actions = h('div', { class: 'hover-actions no-gesture', role: 'toolbar', 'aria-label': 'Nachrichtenaktionen' },
      QUICK.map((e) => h('button', { class: 'quick-react', type: 'button', 'aria-label': 'Reagieren mit ' + e, onclick: () => react(m, e) }, e)),
      h('span', { class: 'ha-sep' }),
      iconBtn('mood', 'Weitere Reaktionen', (e) => reactionPicker(m, e.currentTarget)),
      !m.view_once ? iconBtn('reply', 'Antworten', () => setReply(m, payload)) : null,
      payload?.t === 'text' ? iconBtn('copy', 'Kopieren', () => copyText(payload.body)) : null,
      iconBtn('more', 'Mehr', (e) => { const r = e.currentTarget.getBoundingClientRect(); messageMenu(m, payload, r.left, r.bottom); }));
    wrap.prepend(actions);
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

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => snackbar('Kopiert')).catch(() => snackbar('Kopieren nicht möglich'));
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
    case 'text': return h('div', { class: 'text' }, linkify(p.body));
    case 'image': return imageNode(m, p);
    case 'file': return fileNode(p);
    case 'voice': return voiceNode(m, p);
    default: return h('div', { class: 'text muted' }, 'Nicht unterstützter Nachrichtentyp');
  }
}

// ---------------------------------------------------------------- Typ-Anzeige direkt über der Eingabeleiste
function renderTyping() {
  if (!el.typingSlot) return;
  const c = S.contacts.get(S.chat);
  const t = S.typing.get(S.chat);
  const show = !!(t && t.until > Date.now() && c);
  const inner = el.typingSlot.firstChild;
  const key = show ? (t.preview ? 'p:' + t.preview : 'dots') : 'none';
  if (inner.dataset.key === key) return;
  inner.dataset.key = key;
  if (show) {
    const wasAtBottom = distanceFromBottom() < 120;
    if (t.preview) {
      let bubble = inner.querySelector('.typing-bubble.live');
      if (!bubble) clear(inner, avatarEl(c, 28), bubble = h('div', { class: 'typing-bubble live' }, h('span', { class: 'live-label' }, 'Live'), h('span', { class: 'live-text' })));
      bubble.querySelector('.live-text').textContent = t.preview;
    } else if (!inner.querySelector('.typing-bubble.dots')) {
      clear(inner, avatarEl(c, 28), h('div', { class: 'typing-bubble dots', 'aria-label': `${c.username} schreibt` }, h('i'), h('i'), h('i')));
    }
    el.typingSlot.classList.add('show');
    if (wasAtBottom) requestAnimationFrame(() => scrollToBottom(false));
  } else {
    el.typingSlot.classList.remove('show');
  }
}

// ---------------------------------------------------------------- Medien
export async function getFile(meta, onProgress) {
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
  const showImg = (url) => {
    const img = h('img', { src: url, alt: p.caption || 'Foto', draggable: false });
    img.addEventListener('load', () => box.classList.add('loaded'), { once: true });
    clear(box, img);
    if (img.complete) box.classList.add('loaded');
  };
  const load = async () => {
    try {
      box.append(prog.el);
      const f = await getFile(p.file, (v) => prog.set(v));
      showImg(f.url);
    } catch (e) { prog.el.remove(); clear(box, h('span', { class: 'media-error' }, icon('warn', 18), ' ', e.message)); }
  };
  const cached = S.blobs.get(p.file.id);
  if (cached) showImg(cached.url);
  else if (p.file.size <= AUTO_DOWNLOAD_MAX) setTimeout(load, 0);
  else box.append(h('span', { class: 'media-dl' }, icon('download', 20), fmtBytes(p.file.size)));
  box.addEventListener('click', async () => {
    if (!S.blobs.has(p.file.id)) { await load(); if (!S.blobs.has(p.file.id)) return; }
    openViewer({ url: S.blobs.get(p.file.id).url, blob: S.blobs.get(p.file.id).blob, name: p.file.name, caption: p.caption });
  });
  return h('div', { class: 'image-msg' }, box, p.caption ? h('div', { class: 'text caption' }, linkify(p.caption)) : null,
    p.compressed ? h('div', { class: 'small muted media-note' }, 'komprimiert · Metadaten entfernt') : null);
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
  const ext = p.file.name.includes('.') ? p.file.name.split('.').pop().slice(0, 5).toUpperCase() : '';
  return h('div', { class: 'file-card' }, h('div', { class: 'file-icon' }, icon('file', 28)),
    h('div', { class: 'file-info' }, h('div', { class: 'file-name' }, p.file.name), h('div', { class: 'small muted' }, [ext, fmtBytes(p.file.size)].filter(Boolean).join(' · ')), prog.el), btn);
}

function voiceNode(m, p) {
  const wave = (p.wave && p.wave.length ? p.wave : Array.from({ length: 40 }, (_, i) => 0.25 + 0.35 * Math.abs(Math.sin(i * 1.7)))).slice(0, 64);
  const bars = h('div', { class: 'wave no-gesture', role: 'slider', 'aria-label': 'Wiedergabeposition', 'aria-valuemin': 0, 'aria-valuemax': 100, tabindex: 0 },
    wave.map((v) => h('i', { style: { height: Math.round(12 + v * 88) + '%' } })));
  const time = h('span', { class: 'small mono voice-time' }, fmtDuration(p.duration));
  const speedBtn = h('button', { class: 'speed no-gesture', type: 'button', 'aria-label': 'Wiedergabegeschwindigkeit' }, '1×');
  const transcript = h('div', { class: 'transcript', hidden: true });
  const loadBar = progress({ value: 0, cls: 'inline voice-load' });
  loadBar.el.hidden = true;
  let audio = null, speed = 1, raf = 0;
  const setProgress = (frac) => {
    const n = Math.round(frac * wave.length);
    bars.querySelectorAll('i').forEach((b, i) => b.classList.toggle('played', i < n));
    bars.setAttribute('aria-valuenow', Math.round(frac * 100));
  };
  const total = () => (audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : p.duration);
  const tick = () => {
    if (!audio) return;
    setProgress(Math.min(1, audio.currentTime / total()));
    time.textContent = fmtDuration(audio.currentTime);
    if (!audio.paused) raf = requestAnimationFrame(tick);
  };
  const ensureAudio = async () => {
    if (audio) return audio;
    loadBar.el.hidden = false;
    const f = await getFile(p.file, (v) => loadBar.set(v));
    loadBar.el.hidden = true;
    if (!canPlayAudio(p.file.mime)) snackbar('Dieses Audioformat kann der Browser evtl. nicht abspielen – die Transkription funktioniert trotzdem.');
    audio = new Audio(f.url);
    audio.preload = 'auto';
    audio.playbackRate = speed;
    audio.onended = () => { node.classList.remove('playing'); clear(play, icon('play')); setProgress(0); time.textContent = fmtDuration(p.duration); };
    audio.onpause = () => { node.classList.remove('playing'); cancelAnimationFrame(raf); };
    audio.onplay = () => { node.classList.add('playing'); raf = requestAnimationFrame(tick); };
    return audio;
  };
  const play = iconBtn('play', 'Abspielen', async () => {
    try {
      play.disabled = true;
      const a = await ensureAudio();
      play.disabled = false;
      // andere Wiedergaben anhalten
      document.querySelectorAll('.voice.playing').forEach((n) => n !== node && n._pause?.());
      if (a.paused) { await a.play(); clear(play, icon('pause')); } else { a.pause(); clear(play, icon('play')); }
    } catch (e) { play.disabled = false; loadBar.el.hidden = true; snackbar(e.message || 'Wiedergabe fehlgeschlagen'); }
  }, 'filled-icon no-gesture');
  bars.addEventListener('click', async (e) => {
    const a = await ensureAudio().catch(() => null);
    if (!a) return;
    const r = bars.getBoundingClientRect();
    a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total();
    tick();
  });
  speedBtn.addEventListener('click', () => {
    speed = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    speedBtn.textContent = String(speed).replace('.', ',') + '×';
    if (audio) audio.playbackRate = speed;
  });
  const tBtn = iconBtn('transcript', 'Transkribieren (auf dem Gerät)', () => runTranscription(), 'no-gesture');
  async function runTranscription() {
    if (!S.prefs.transcription) {
      const ok = await confirm('Transkription aktivieren?', 'Sprachnachrichten werden auf deinem Gerät mit Whisper in Text umgewandelt – das Audio verlässt dein Gerät nicht. Dafür lädt dein Vela-Server einmalig ein Sprachmodell (~40 MB) herunter.', { ok: 'Aktivieren', icon: 'transcript' });
      if (!ok) return;
      S.prefs.transcription = true;
      store.setPref('transcription', true);
    }
    tBtn.disabled = true;
    transcript.hidden = false;
    const tp = progress({ value: null });
    clear(transcript, tp.el);
    try {
      const f = await getFile(p.file);
      const text = await transcribe(await f.blob.arrayBuffer(), {
        model: S.prefs.model, language: S.prefs.language === 'auto' ? null : S.prefs.language,
        onProgress: (s) => {
          if (s.phase === 'install') tp.set(s.value, `Sprachmodell wird auf dem Server eingerichtet (einmalig) … ${Math.round((s.value || 0) * 100)} %`);
          else if (s.phase === 'load') tp.set(s.value, s.value == null ? 'Sprachmodell wird geladen …' : `Sprachmodell wird geladen … ${Math.round(s.value * 100)} %`);
          else if (s.phase === 'decode' || s.phase === 'check') tp.set(null, 'Audio wird vorbereitet …');
          else tp.set(null, 'Wird auf deinem Gerät transkribiert …');
        },
      });
      clear(transcript, h('span', { class: 'small muted' }, icon('lock', 12), ' Transkript – auf deinem Gerät erstellt'), h('p', {}, text || '(keine Sprache erkannt)'));
      tBtn.remove();
    } catch (e) {
      clear(transcript, h('span', { class: 'small error-text' }, 'Transkription fehlgeschlagen: ' + e.message),
        button('Erneut versuchen', { kind: 'text', cls: 'small', onClick: runTranscription }));
      tBtn.disabled = false;
    }
  }
  const node = h('div', { class: 'voice' },
    h('div', { class: 'voice-row' }, play, h('div', { class: 'voice-mid' }, bars, h('div', { class: 'voice-sub' }, time, speedBtn)), tBtn),
    loadBar.el, transcript);
  node._pause = () => { if (audio && !audio.paused) { audio.pause(); clear(play, icon('play')); } };
  return node;
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

export function openViewer({ url, blob, name, caption, viewOnce = false, text = null, onClose }) {
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
    v.classList.add('closing');
    setTimeout(() => v.remove(), 160);
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
  return h('div', { class: 'reaction-bar' }, REACTIONS.map((e, i) => h('button', { type: 'button', class: 'reaction-pick', style: { animationDelay: i * 25 + 'ms' }, 'aria-label': 'Reagieren mit ' + e, onclick: () => { close?.(); react(m, e); } }, e)));
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
    payload?.t === 'text' ? { icon: 'copy', label: 'Text kopieren', onClick: () => copyText(payload.body) } : null,
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
  hidden.add(m.id);
  await store.setPref(cacheKey('hidden'), [...hidden].slice(-5000));
  renderMessages();
  snackbar('Nachricht auf diesem Gerät ausgeblendet', { action: 'Rückgängig', onAction: async () => { hidden.delete(m.id); await store.setPref(cacheKey('hidden'), [...hidden]); renderMessages(); } });
}

async function deleteForAll(m) {
  if (!(await confirm('Für alle löschen?', 'Die Nachricht und angehängte Dateien werden vom Server gelöscht und bei deinem Kontakt durch einen Hinweis ersetzt.', { ok: 'Löschen', danger: true }))) return;
  try { await api('/messages/' + m.id, { method: 'DELETE' }); } catch (e) { snackbar(e.message); }
}

async function react(m, emoji) {
  vibrate(8);
  const list = S.messages.get(S.chat) || [];
  const current = reactionMap(list).get(m.id)?.get(S.me.id);
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
  el.sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Senden' },
    h('span', { class: 'sb-icon sb-send' }, icon('send')), h('span', { class: 'sb-icon sb-mic' }, icon('mic')));
  setupSendButton(el.sendBtn);
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
  el.composerRow = h('div', { class: 'composer-row' }, attach, h('div', { class: 'input-wrap' }, el.input, el.voToggle), el.sendBtn);
  const comp = h('div', { class: 'composer' }, el.replySlot, el.composerRow, el.fileInput);
  el.chatPane.ondragover = (e) => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); el.chatPane.classList.add('drop'); } };
  el.chatPane.ondragleave = () => el.chatPane.classList.remove('drop');
  el.chatPane.ondrop = (e) => { e.preventDefault(); el.chatPane.classList.remove('drop'); handleFiles([...e.dataTransfer.files], 'auto'); };
  setTimeout(() => { autoGrow(); updateComposer(); renderReplyPreview(); }, 0);
  return comp;
}

function autoGrow() {
  el.input.style.height = 'auto';
  el.input.style.height = Math.min(el.input.scrollHeight, 168) + 'px';
}

function updateComposer() {
  const hasText = el.input.value.trim().length > 0;
  el.sendBtn.classList.toggle('has-text', hasText);
  el.sendBtn.setAttribute('aria-label', hasText ? 'Senden' : 'Sprachnachricht: gedrückt halten oder tippen');
  el.sendBtn.title = hasText ? 'Senden' : 'Gedrückt halten zum Aufnehmen, tippen zum Starten';
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
  el.input.focus();
  try { await sendPayload(S.chat, payload, { viewOnce: vo }); } catch (e) { snackbar(e.message); }
}

export async function sendPayload(contactId, payload, { viewOnce = false, silent = false, files = [] } = {}) {
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
    const res = { payload };
    S.decoded.set(id, Promise.resolve(res));
    S.dec.set(id, res);
    store.put('cache', cacheKey(id), res).catch(() => {});
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
  if (S.chat === contactId) {
    const mine = m.from === S.me.id;
    if (!mine && !m.silent && el.msgs && distanceFromBottom() > 320) { newWhileScrolled++; updateToBottom(); }
    renderMessages({ scroll: mine && !m.silent ? 'smooth' : undefined });
  }
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
  const node = h('div', { class: 'msg-row mine first last enter' }, h('div', { class: 'bubble-wrap' }, h('div', { class: 'bubble upload' },
    h('div', { class: 'upload-head' }, h('span', { class: 'upload-spin' }, icon('lock', 16)), h('span', {}, label), iconBtn('close', 'Abbrechen', () => cancel.abort())), prog.el)));
  const u = { node, prog, cancel, contactId: S.chat };
  if (!S.uploads.has(S.chat)) S.uploads.set(S.chat, []);
  S.uploads.get(S.chat).push(u);
  renderMessages({ scroll: 'smooth' });
  return u;
}
function removeUpload(u) {
  const arr = S.uploads.get(u.contactId) || [];
  S.uploads.set(u.contactId, arr.filter((x) => x !== u));
  if (S.chat === u.contactId) renderMessages();
}

export async function uploadEncrypted(blob, u) {
  if (blob.size + 16 * Math.ceil(blob.size / FILE_CHUNK + 1) > S.config.max_upload_bytes) throw new Error(`Datei zu groß (max. ${fmtBytes(S.config.max_upload_bytes)})`);
  u?.prog.set(0, 'Verschlüsseln …');
  const enc = await encryptFile(await blob.arrayBuffer(), (v) => u?.prog.set(v * 0.15, 'Verschlüsseln …'));
  if (u?.cancel.signal.aborted) throw new ApiError(0, 'Abgebrochen');
  const t0 = performance.now();
  const up = await uploadBlob(enc.blob, (v) => {
    const secs = (performance.now() - t0) / 1000;
    const rate = v * enc.blob.size / Math.max(0.1, secs);
    u?.prog.set(0.15 + v * 0.85, `Hochladen … ${Math.round(v * 100)} % · ${fmtBytes(rate)}/s`);
  }, u?.cancel.signal);
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
// Senden-Taste mit leerem Feld = Mikrofon:
//   * gedrückt halten -> aufnehmen, loslassen -> senden, nach links ziehen -> verwerfen,
//     nach oben ziehen -> einrasten (freihändig weiter aufnehmen)
//   * kurz tippen -> Aufnahme startet eingerastet (Senden/Verwerfen per Taste)
const HOLD_MS = 300, CANCEL_PX = 110, LOCK_PX = 70;
let voice = null;

function setupSendButton(btn) {
  let downAt = 0, sx = 0, sy = 0, pid = null, holdTimer = 0, suppressClick = false;
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || voice || el.input.value.trim()) return; // Text/laufende Aufnahme: normaler Klick
    e.preventDefault();
    downAt = performance.now(); sx = e.clientX; sy = e.clientY; pid = e.pointerId;
    try { btn.setPointerCapture(pid); } catch { /* ok */ }
    holdTimer = setTimeout(() => { if (pid !== null && !voice) startVoice({ hold: true }); }, HOLD_MS);
  });
  btn.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid || !voice?.hold || voice.locked) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    voice.slide(dx, dy);
    if (dx < -CANCEL_PX) { pid = null; cancelVoice(); }
    else if (dy < -LOCK_PX) voice.lock();
  });
  btn.addEventListener('pointerup', (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    clearTimeout(holdTimer);
    if (!voice) {
      if (performance.now() - downAt < HOLD_MS) { suppressClick = true; startVoice({ hold: false }); }
      return;
    }
    if (voice.pendingStart) { voice.lockWhenReady = true; return; } // losgelassen während der Mikrofon-Abfrage
    if (voice.hold && !voice.locked) { suppressClick = true; finishVoice(); }
  });
  btn.addEventListener('pointercancel', (e) => {
    if (e.pointerId !== pid) return;
    pid = null; clearTimeout(holdTimer);
    if (voice?.hold) voice.lock();
  });
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    if (suppressClick) { suppressClick = false; return; }
    if (voice?.locked && !voice.pendingStart) { finishVoice(); return; }
    if (!voice && el.input.value.trim()) sendText();
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function startVoice({ hold }) {
  const c = S.contacts.get(S.chat);
  if (c?.keyChanged) { snackbar('Sicherheitsschlüssel geändert – bitte zuerst bestätigen'); return; }
  const canvas = h('canvas', { class: 'rec-wave', width: 600, height: 64, 'aria-hidden': 'true' });
  const time = h('span', { class: 'rec-time mono' }, '0:00');
  const hint = h('span', { class: 'rec-hint' }, icon('chevron_left', 18), 'Zum Verwerfen wischen');
  const lockHint = h('div', { class: 'rec-lock', 'aria-hidden': 'true' }, icon('lock', 18), h('span', { class: 'rec-lock-arrow' }));
  const trash = iconBtn('delete', 'Verwerfen', () => cancelVoice(), 'rec-trash');
  const bar = h('div', { class: 'recording ' + (hold ? 'holding' : 'locked') }, trash, h('span', { class: 'rec-dot' }), time,
    h('div', { class: 'rec-track' }, canvas, hint), lockHint);
  const v = {
    hold, locked: !hold, contactId: S.chat, rec: null, pendingStart: true, lockWhenReady: false, bar,
    slide(dx, dy) {
      const x = Math.min(0, dx);
      bar.style.setProperty('--slide', x + 'px');
      bar.classList.toggle('near-cancel', x < -CANCEL_PX * 0.6);
      lockHint.style.setProperty('--lift', Math.max(-LOCK_PX, Math.min(0, dy)) + 'px');
    },
    lock() {
      if (this.locked) return;
      this.locked = true; vibrate(12);
      bar.classList.replace('holding', 'locked');
      el.sendBtn.classList.replace('rec-holding', 'rec-locked');
      bar.style.setProperty('--slide', '0px');
    },
  };
  voice = v;
  el.composerRow.append(bar);
  el.composer.classList.add('is-recording');
  el.sendBtn.classList.add(hold ? 'rec-holding' : 'rec-locked');
  el.sendBtn.setAttribute('aria-label', 'Sprachnachricht senden');
  const ctx = canvas.getContext('2d');
  const color = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#006b5f';
  const draw = (levels) => {
    const w = canvas.width, hgt = canvas.height, step = 9;
    const data = levels.slice(-Math.floor(w / step));
    ctx.clearRect(0, 0, w, hgt);
    ctx.fillStyle = color;
    data.forEach((lv, i) => {
      const bh = Math.max(5, lv * hgt * 0.95);
      const x = w - (data.length - i) * step;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x, (hgt - bh) / 2, 5, bh, 3); else ctx.rect(x, (hgt - bh) / 2, 5, bh);
      ctx.fill();
    });
  };
  let rec;
  try {
    rec = await startRecording((lv, secs, levels) => {
      time.textContent = fmtDuration(secs);
      draw(levels);
      if (secs > 300 && voice === v) finishVoice();
    });
  } catch (e) {
    if (voice === v) { voice = null; endVoiceUi(); }
    snackbar(e.name === 'NotAllowedError' ? 'Mikrofonzugriff verweigert – bitte in den Browser-Einstellungen erlauben.'
      : e.name === 'NotFoundError' ? 'Kein Mikrofon gefunden.' : e.message);
    return;
  }
  if (voice !== v) { rec.cancel(); return; } // inzwischen verworfen
  v.rec = rec;
  v.pendingStart = false;
  if (v.hold && v.lockWhenReady) v.lock();
  vibrate(15);
}

function endVoiceUi() {
  el.composerRow?.querySelector('.recording')?.remove();
  el.composer?.classList.remove('is-recording');
  el.sendBtn?.classList.remove('rec-holding', 'rec-locked');
  if (el.input) updateComposer();
}

function cancelVoice() {
  if (!voice) return;
  const v = voice;
  voice = null;
  v.bar.classList.add('discard');
  vibrate(20);
  setTimeout(endVoiceUi, 240);
  v.rec?.cancel();
}

async function finishVoice() {
  if (!voice || !voice.rec) return;
  const v = voice;
  voice = null;
  const r = await v.rec.stop();
  endVoiceUi();
  if (r.duration < 0.8 || r.blob.size < 200) { snackbar('Zu kurz – gedrückt halten oder tippen und dann senden'); return; }
  const u = addUpload('Sprachnachricht');
  try {
    const meta = await uploadEncrypted(r.blob, u);
    S.blobs.set(meta.id, { blob: r.blob, url: URL.createObjectURL(r.blob) });
    removeUpload(u);
    await sendPayload(v.contactId, { t: 'voice', file: { ...meta, mime: r.mime, name: 'sprachnachricht' }, duration: r.duration, wave: r.wave },
      { files: [meta.id] });
  } catch (e) { removeUpload(u); snackbar(e.message); }
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

const typingTimers = new Map();
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
    clearTimeout(typingTimers.get(ev.from));
    typingTimers.set(ev.from, setTimeout(() => { S.typing.delete(ev.from); refreshTyping(ev.from); }, 6100));
  }
  refreshTyping(ev.from);
}

function refreshTyping(contactId) {
  renderList();
  if (S.chat === contactId) { renderChatHeader(); renderTyping(); }
}

// ================================================================= Gelesen-Status
async function markRead(contactId) {
  if (document.hidden || S.chat !== contactId) return;
  const list = S.messages.get(contactId) || [];
  const unread = list.filter((m) => m.from === contactId && !m.read_at);
  const c = S.contacts.get(contactId);
  if (!unread.length) { if (c?.unread) { c.unread = 0; renderList(); } return; }
  const upTo = Math.max(...unread.map((m) => m.ts));
  unread.forEach((m) => { m.read_at = Date.now(); });
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
    if (reconnect) { loadContacts(); loadStatuses().then(refreshNav).catch(() => {}); if (S.chat) loadMessages(S.chat).then(() => renderMessages()); }
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
      if (incoming && S.typing.has(m.from)) { S.typing.delete(m.from); if (S.chat === m.from) { renderTyping(); renderChatHeader(); } }
      const c = S.contacts.get(contactId);
      if (incoming && c && !m.silent) {
        const visible = S.chat === contactId && !document.hidden;
        if (!visible) c.unread = (c.unread || 0) + 1;
        if (document.hidden && S.prefs.notifications && window.Notification?.permission === 'granted' && !c.muted) {
          try { new Notification('Vela', { body: `Neue Nachricht von ${c.username}`, tag: contactId, icon: '/static/icon-192.png' }); } catch { /* ok */ }
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
      S.decoded.delete(ev.id); S.dec.delete(ev.id); payloadNodes.delete(ev.id);
      store.del('cache', cacheKey(ev.id)).catch(() => {});
      for (const c of S.contacts.values()) if (c.last?.id === ev.id) { c.last.envelope = null; c.last[ev.type === 'viewed' ? 'viewed_at' : 'deleted_at'] = ev.at; }
      renderList();
      if (S.chat) renderMessages();
      break;
    case 'typing': onTyping(ev); break;
    case 'contact_update': loadContacts(); break;
    case 'status_update':
    case 'status_view':
      statusEvent(ev).then(refreshNav);
      break;
    default: break;
  }
}

function sessionExpired() {
  S.ws = null;
  renderLogin('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.');
}

export async function logout(wipe) {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* trotzdem lokal abmelden */ }
  const ws = S.ws; S.ws = null; ws?.close();
  if (wipe) await store.wipe();
  for (const b of S.blobs.values()) URL.revokeObjectURL(b.url);
  S.blobs.clear(); S.decoded.clear(); S.dec?.clear(); payloadNodes.clear(); msgNodes.clear(); rowNodes.clear();
  S.keys = null; S.me = null;
  renderLogin(wipe ? 'Abgemeldet. Schlüssel und Verlauf wurden von diesem Gerät entfernt.' : 'Abgemeldet.');
}

boot();
