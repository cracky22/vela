// Vela – Hauptanwendung: Navigation, Chatliste, Chat (Einzel & Gruppe), Echtzeit, Medien.
// Ein "Gespräch" (conversation) ist entweder ein Kontakt (1:1) oder eine Gruppe; beide teilen
// sich dieselbe Darstellung. Aktualisierung über schlüsselbasierten DOM-Abgleich (kein Flackern).
import {
  h, clear, icon, iconBtn, initials, hue, randomId, fmtBytes, fmtTime, fmtDay, fmtListTime, fmtDuration,
  throttle, isTouch, vibrate,
} from './util.js';
import { api, ApiError, uploadBlob, downloadBuffer, BASE_PATH } from './api.js';
import {
  cryptoAvailable, sealMessage, openMessage, encryptFile, decryptFile, importSigPub, safetyNumber, shortFingerprint, FILE_CHUNK,
} from './crypto.js';
import * as store from './store.js';
import { S, cacheKey } from './state.js';
import { cacheGet, cachePut, cacheDel, cachePrefetch, cachePrune, applyCacheEpoch, cacheMemoryClear } from './cache.js';
import { initAuth, renderLogin, renderRestore } from './auth.js';
import { dialog, confirm, snackbar, menu, progress, field, button, initRipple, reconcile } from './ui.js';
import { swipeable } from './gestures.js';
import { prepareImage, startRecording, canPlayAudio } from './media.js';
import { transcribe } from './transcribe.js';
import { initStatus, renderStatusView, loadStatuses, statusEvent, hasUnseenStatus } from './status.js';
import { initProfile, renderProfileView } from './profile.js';
import { initNotify, showLocal, disablePush } from './notify.js';
import { maybeShowChangelog } from './changelog.js';
import { initConn, setWsState } from './conn.js';
import { initGroups, createGroupDialog, openGroupInfo, refreshGroupInfo, forwardDialog, ttlDialog, TTL_LABELS } from './groups.js';

const root = document.getElementById('app');
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const QUICK = ['❤️', '👍', '😂'];
const AUTO_DOWNLOAD_MAX = 10 * 1024 * 1024;
const GROUP_GAP_MS = 3 * 60 * 1000;
const EDIT_WINDOW_MS = 15 * 60 * 1000;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const compact = () => !matchMedia('(min-width: 840px)').matches;
let el = {};
const payloadNodes = new Map(); // Medien-Elemente (Wiedergabe-Zustand) über Neu-Darstellungen erhalten
const msgNodes = new Map();     // Nachrichten-ID -> { row, sig }
const dayNodes = new Map();
const rowNodes = new Map();     // Gesprächs-Schlüssel -> Zeile der Chatliste
const previews = new Map();     // Gesprächs-ID -> { id, text }
let hidden = new Set();
let initialRender = true;
let fatalShown = false;   // Fehlerseite sichtbar? (dann Seite neu laden, sobald der Server wieder da ist)

// ================================================================= Gespräche & Nutzer
S.groups = new Map();
S.users = new Map();   // alle bekannten Personen (Kontakte + Gruppenmitglieder)
S.changed = new Set(); // Nutzer, deren Schlüssel sich seit dem Anheften geändert hat
S.names = new Map();   // Namen ausgetretener Mitglieder (aus Systemnachrichten)
S.editing = null;

export const version = 'v1.3.2';
export const isGroup = (id) => S.groups.has(id);
export const conv = (id) => S.contacts.get(id) || S.groups.get(id);
export const convOf = (m) => m.group || (m.from === S.me.id ? m.to : m.from);
export const titleOf = (c) => (c?.kind === 'group' ? c.name : c?.username) || '?';
export function nameOf(uid) {
  if (uid === S.me?.id) return 'Du';
  return S.users.get(uid)?.username || S.names.get(uid) || 'Unbekannt';
}

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
  initConn({ onReconnect: retryWS, onServerBack: () => { if (fatalShown) location.reload(); }, onCacheEpoch: (e) => applyCacheEpoch(e, onCacheCleared) });
  initAuth(root, afterLogin);
  //if (!cryptoAvailable()) return renderNoCrypto();
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
  fatalShown = true;
  clear(root, h('div', { class: 'auth-page' }, h('div', { class: 'auth-card' },
    h('h1', { class: 'auth-title' }, 'Verbindung fehlgeschlagen'), h('p', {}, msg),
    button('Erneut versuchen', { onClick: () => location.reload() }))));
}

export function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
  const dark = t === 'dark' || (t === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#18120c' : '#fff8f4');
}

// ================================================================= Avatare
export function avatarUrl(x) {
  if (!x?.avatar_version) return null;
  return x.kind === 'group' ? `${BASE_PATH}/api/groups/${x.id}/avatar?v=${x.avatar_version}` : `${BASE_PATH}/api/avatars/${x.id}?v=${x.avatar_version}`;
}

export function avatarEl(x, size = 40, { ring = null } = {}) {
  const name = titleOf(x);
  const group = x?.kind === 'group';
  const box = h('div', { class: 'avatar' + (group ? ' group' : '') + (ring ? ' ring ' + ring : ''), style: { '--h': hue(name), width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.4) + 'px' }, 'aria-hidden': 'true' },
    group ? icon('group', Math.round(size * 0.55)) : h('span', { class: 'avatar-initials' }, initials(name)));
  const url = avatarUrl(x);
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
  S.contacts.clear(); S.groups.clear(); S.users.clear(); S.messages.clear(); S.decoded.clear(); S.dec = new Map(); S.chat = null;
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
        h('div', { class: 'app-title' }, h('span', { class: 'brand-mini' }, h('img', { src: 'static/icon.svg', alt: '', width: 34, height: 34 })), 'Chats'),
        h('div', { class: 'spacer' }),
        iconBtn('group', 'Neue Gruppe', () => createGroupDialog()),
        iconBtn('person_add', 'Kontakt hinzufügen', addContactDialog, 'hide-compact')),
      h('div', { class: 'search-wrap' }, icon('search', 20), el.search),
      el.tabs, el.listProgress.el, el.list,
      h('button', { class: 'fab show-compact', 'aria-label': 'Neuer Chat', onclick: (e) => newChatMenu(e.currentTarget) }, icon('edit'), h('span', { class: 'fab-label' }, 'Neuer Chat'))),
    status: h('section', { class: 'view', dataset: { view: 'status' }, hidden: true }),
    profile: h('section', { class: 'view', dataset: { view: 'profile' }, hidden: true }),
  };
  el.navItems = {};
  const navButton = (v) => {
    const btn = h('button', { class: 'nav-item', type: 'button', 'aria-label': v.label, onclick: () => switchView(v.id) },
      h('span', { class: 'nav-icon' }, h('span', { class: 'nav-pill' }), v.id === 'profile' ? h('span', { class: 'nav-avatar' }) : icon(v.icon, 24), h('span', { class: 'nav-badge' })),
      h('span', { class: 'nav-label' }, v.label));
    (el.navItems[v.id] ||= []).push(btn);
    return btn;
  };
  el.bottomNav = h('nav', { class: 'bottom-nav', 'aria-label': 'Hauptnavigation' }, VIEWS.map((v) => navButton(v)));
  el.rail = h('nav', { class: 'nav-rail', 'aria-label': 'Hauptnavigation' },
    h('div', { class: 'rail-brand' }, icon('shield', 26)),
    h('button', { class: 'rail-fab', type: 'button', 'aria-label': 'Neuer Chat', onclick: (e) => newChatMenu(e.currentTarget) }, icon('edit', 22)),
    h('div', { class: 'rail-items' }, VIEWS.map((v) => navButton(v))));
  el.chatPane = h('main', { class: 'pane chat-pane', 'aria-live': 'off' });
  el.listPane = h('aside', { class: 'pane list-pane' }, Object.values(el.views), el.bottomNav);
  el.shell = h('div', { class: 'app-shell', dataset: { view: 'chats' } }, el.rail, el.listPane, el.chatPane);
  clear(root, el.shell);
  initStatus(statusCtx());
  initProfile(profileCtx());
  initGroups(groupCtx());
  renderEmptyChat();
  renderSkeleton();
  refreshNav();
  loadAll();
  loadStatuses().then(refreshNav).catch(() => {});
  connectWS();
  initNotify({ enabled: S.prefs.notifications, openChat: (id) => { if (S.contacts.has(id) || S.groups.has(id)) { switchView('chats'); openChat(id); } } });
  maybeShowChangelog(version, S.me);
  applyCacheEpoch(S.me.cache_epoch, onCacheCleared);
  setTimeout(() => cachePrune(S.config.retention_days), 8000);
}

// Der Admin hat den Cache geleert: Sitzungsspeicher verwerfen, alles neu entschlüsseln
function onCacheCleared() {
  S.decoded.clear(); S.dec = new Map(); previews.clear(); payloadNodes.clear(); msgNodes.clear(); cacheMemoryClear();
  renderList();
  if (S.chat) renderMessages();
}

function statusCtx() {
  return { avatarEl, root: () => el.views.status, openChatWithReply, refreshNav, switchView, contactsWithKeys, getFile, uploadEncrypted, sendPayload };
}
function profileCtx() {
  return { avatarEl, refreshNav, applyTheme, logout, rerenderMessages: () => S.chat && renderMessages(), enterApp };
}
function groupCtx() {
  return { avatarEl, openChat, loadGroups, verifyDialog, nameOf, titleOf, getFile, uploadEncrypted, sendPayload, renderList, renderChatHeader, conv, isGroup, acceptNewKey, closeChat, leaveGroup };
}

function newChatMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  menu([
    { icon: 'person_add', label: 'Kontakt hinzufügen', onClick: addContactDialog },
    { icon: 'group', label: 'Neue Gruppe', onClick: () => createGroupDialog() },
  ], r.left, r.top - 120);
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
  void next.offsetWidth;
  next.classList.add('view-enter');
  if (compact() && S.chat) closeChat();
  refreshNav();
}

export function refreshNav() {
  if (!el.navItems) return;
  const convs = [...S.contacts.values(), ...S.groups.values()];
  const unread = convs.filter((c) => (c.kind === 'group' || c.status === 'accepted') && !c.archived && c.unread).length;
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
    h('p', {}, 'Alle Nachrichten, Bilder, Dateien und Sprachnachrichten werden auf deinem Gerät verschlüsselt (RSA-OAEP + AES-256-GCM) und erst bei den Empfängern entschlüsselt.'),
    h('p', { class: 'muted small' }, `Verschlüsselte Inhalte liegen höchstens ${S.config.retention_days} Tage auf dem Server.`)));
}

// ================================================================= Laden: Kontakte & Gruppen
let firstContactLoad = true;
async function loadAll() {
  el.listProgress.el.hidden = false;
  try {
    await Promise.all([loadContacts({ render: false }), loadGroups({ render: false })]);
    firstContactLoad = false;
    renderList();
  } finally { el.listProgress.el.hidden = true; }
}

async function loadContacts({ render = true } = {}) {
  try {
    const list = await api('/contacts');
    const seen = new Set();
    for (const c of list) {
      c.kind = 'dm';
      seen.add(c.id);
      const before = S.contacts.get(c.id);
      if (before?.status === 'pending_out' && c.status === 'accepted') {
        snackbar(`${c.username} hat deine Anfrage angenommen – eure Schlüssel wurden ausgetauscht.`);
        if (S.tab === 'requests' && !list.some((x) => x.status !== 'accepted')) S.tab = 'chats';
      }
      if (before) Object.assign(before, c); else S.contacts.set(c.id, c);
    }
    for (const id of [...S.contacts.keys()]) if (!seen.has(id)) S.contacts.delete(id);
    await rebuildUsers();
    if (render) afterDataChange();
  } catch (e) {
    if (e.status === 401) return sessionExpired();
    snackbar(e.message);
  }
}

export async function loadGroups({ render = true } = {}) {
  try {
    const list = await api('/groups');
    const seen = new Set();
    for (const g of list) {
      seen.add(g.id);
      const before = S.groups.get(g.id);
      if (before) Object.assign(before, g); else S.groups.set(g.id, g);
    }
    for (const id of [...S.groups.keys()]) {
      if (!seen.has(id)) {
        S.groups.delete(id);
        if (S.chat === id) { closeChat(); snackbar('Du bist nicht mehr Mitglied dieser Gruppe'); }
      }
    }
    await rebuildUsers();
    if (render) afterDataChange();
  } catch (e) {
    if (e.status === 401) return sessionExpired();
    snackbar(e.message);
  }
}

function afterDataChange() {
  renderList();
  if (S.chat && !conv(S.chat)) closeChat();
  else if (S.chat) { renderChatHeader(); renderMessages(); }
  if (S.view === 'status') renderStatusView();
  refreshGroupInfo();
}

// Alle bekannten Personen: Kontakte (angenommen) + Mitglieder meiner Gruppen
async function rebuildUsers() {
  S.users.clear();
  for (const g of S.groups.values()) for (const m of g.members) if (m.id !== S.me.id) S.users.set(m.id, { ...m, kind: 'dm' });
  for (const c of S.contacts.values()) if (c.status === 'accepted') S.users.set(c.id, { ...(S.users.get(c.id) || {}), ...c });
  await syncPins();
}

// Trust on First Use: der erste gesehene Schlüssel wird angeheftet. Ändert er sich später,
// wird gewarnt; an diese Person wird erst nach Bestätigung wieder verschlüsselt.
async function syncPins() {
  S.changed.clear();
  for (const u of S.users.values()) {
    if (!u.enc_pub) continue;
    const k = cacheKey('pin:' + u.id);
    let pin = S.pins.get(u.id) || await store.get('pins', k).catch(() => null);
    if (!pin) {
      pin = { encPub: u.enc_pub, sigPub: u.sig_pub, keyVersion: u.key_version, bits: u.key_bits, verified: false, history: { [u.key_version]: u.sig_pub }, since: Date.now() };
      await store.put('pins', k, pin).catch(() => {});
    }
    S.pins.set(u.id, pin);
    const changed = pin.encPub !== u.enc_pub || pin.sigPub !== u.sig_pub;
    if (changed) S.changed.add(u.id);
    const c = S.contacts.get(u.id);
    if (c) c.keyChanged = changed;
  }
}

export function contactsWithKeys() {
  return [...S.contacts.values()].filter((c) => c.status === 'accepted' && !S.changed.has(c.id) && S.pins.get(c.id))
    .map((c) => ({ id: c.id, encPub: S.pins.get(c.id).encPub }));
}

async function acceptNewKey(u) {
  const old = S.pins.get(u.id) || { history: {} };
  const pin = { ...old, encPub: u.enc_pub, sigPub: u.sig_pub, keyVersion: u.key_version, bits: u.key_bits, verified: false, history: { ...old.history, [u.key_version]: u.sig_pub } };
  await store.put('pins', cacheKey('pin:' + u.id), pin);
  S.pins.set(u.id, pin);
  S.changed.delete(u.id);
  const c = S.contacts.get(u.id);
  if (c) c.keyChanged = false;
  for (const list of S.messages.values()) for (const m of list) if (m.from === u.id) { S.decoded.delete(m.id); S.dec.delete(m.id); msgNodes.delete(m.id); }
  renderList();
  if (S.chat) { if (el.header) el.header.dataset.key = ''; renderChatHeader(); renderMessages(); }
}

function allConversations(tab) {
  let list;
  const groups = [...S.groups.values()];
  const dms = [...S.contacts.values()];
  if (tab === 'requests') list = dms.filter((c) => c.status !== 'accepted');
  else if (tab === 'archive') list = [...dms.filter((c) => c.status === 'accepted'), ...groups].filter((c) => c.archived);
  else if (tab === 'groups') list = groups.filter((c) => !c.archived);
  else list = [...dms.filter((c) => c.status === 'accepted'), ...groups].filter((c) => !c.archived);
  if (S.search) list = list.filter((c) => titleOf(c).toLowerCase().includes(S.search));
  const ts = (c) => c.last?.ts || c.since || c.created_at || 0;
  return list.sort((a, b) => (b.pinned - a.pinned) || ts(b) - ts(a));
}

let lastTabsKey = '';
function renderList() {
  if (!el.list) return;
  refreshNav();
  const all = [...[...S.contacts.values()].filter((c) => c.status === 'accepted'), ...S.groups.values()];
  const counts = {
    chats: all.filter((c) => !c.archived && c.unread).length,
    groups: [...S.groups.values()].filter((c) => !c.archived && c.unread).length,
    archive: all.filter((c) => c.archived).length,
    requests: [...S.contacts.values()].filter((c) => c.status === 'pending_in').length,
  };
  const tabsKey = S.tab + JSON.stringify(counts);
  if (tabsKey !== lastTabsKey) {
    lastTabsKey = tabsKey;
    clear(el.tabs, [['chats', 'Alle'], ['groups', 'Gruppen'], ['archive', 'Archiv'], ['requests', 'Anfragen']].map(([k, label]) => h('button', {
      role: 'tab', class: 'tab' + (S.tab === k ? ' active' : ''), 'aria-selected': String(S.tab === k),
      onclick: () => { S.tab = k; renderList(); },
    }, S.tab === k ? icon('check', 18) : null, label, counts[k] ? h('span', { class: 'badge' + (k === 'archive' ? ' quiet' : '') }, counts[k]) : null)));
  }

  const items = allConversations(S.tab);
  if (!items.length) {
    if (firstContactLoad) return;
    const msg = S.search ? 'Keine Treffer.' : S.tab === 'requests' ? 'Keine offenen Kontaktanfragen.'
      : S.tab === 'archive' ? 'Archivierte Chats erscheinen hier. Wische einen Chat nach links, um ihn zu archivieren.'
        : S.tab === 'groups' ? 'Noch keine Gruppen. Erstelle eine Gruppe mit deinen Kontakten - alle Nachrichten bleiben Ende-zu-Ende-verschlüsselt.'
          : 'Noch keine Chats. Füge einen Kontakt über seinen Nutzernamen hinzu.';
    const key = 'empty:' + msg;
    if (el.list.dataset.key !== key) {
      el.list.dataset.key = key;
      clear(el.list, h('div', { class: 'list-empty' }, h('div', { class: 'empty-icon small' }, icon(S.tab === 'archive' ? 'archive' : S.tab === 'groups' ? 'group' : 'chat', 32)), h('p', {}, msg),
        S.tab === 'chats' && !S.search ? button('Kontakt hinzufügen', { kind: 'tonal', icon: 'person_add', onClick: addContactDialog }) : null,
        S.tab === 'groups' && !S.search ? button('Neue Gruppe', { kind: 'tonal', icon: 'group', onClick: () => createGroupDialog() }) : null));
    }
    return;
  }
  el.list.dataset.key = '';
  reconcile(el.list, items.map((c) => (c.kind === 'group' || c.status === 'accepted' ? chatRow(c) : requestRow(c))));
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
    r.mute = h('span', { class: 'pin', title: 'Stummgeschaltet' }, icon('mute', 16));
    r.avatarWrap = h('div', { class: 'row-avatar' }, avatarEl(c, 52), h('span', { class: 'online-dot' }));
    const content = h('div', { class: 'row-inner', tabindex: 0, role: 'button', 'aria-label': `Chat mit ${titleOf(c)}`,
      onclick: () => openChat(c.id), onkeydown: (e) => { if (e.key === 'Enter') openChat(c.id); } },
    r.avatarWrap,
    h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, r.title, r.flags), r.sub),
    h('div', { class: 'row-meta' }, r.time, h('div', { class: 'row-badges' },
      r.mute, c.pinned ? h('span', { class: 'pin', title: 'Markiert' }, icon('pin', 16)) : null, r.badge)));
    row = h('div', { class: 'chat-row' + (firstContactLoad ? '' : ' enter'), role: 'listitem', dataset: { id: c.id } });
    const id = c.id;
    swipeable(row, content, {
      left: { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Zurückholen' : 'Archivieren', color: 'tertiary', dismiss: true, action: () => toggleArchive(conv(id)) },
      right: { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', color: 'primary', action: () => togglePin(conv(id)) },
      onLongPress: (x, y) => chatMenu(conv(id), x, y),
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
  setText(r.title, titleOf(c));
  const group = c.kind === 'group';
  const changed = group ? c.members.some((m) => S.changed.has(m.id)) : S.changed.has(c.id);
  const flagKey = `${changed ? 1 : 0}${!group && S.pins.get(c.id)?.verified ? 1 : 0}${c.ttl ? 1 : 0}`;
  if (r.flags.dataset.k !== flagKey) {
    r.flags.dataset.k = flagKey;
    clear(r.flags, changed ? h('span', { class: 'warn-dot', title: 'Sicherheitsschlüssel geändert' }, icon('warn', 16)) : null,
      !group && S.pins.get(c.id)?.verified ? h('span', { class: 'verified', title: 'Verifiziert' }, icon('verified', 16)) : null,
      c.ttl ? h('span', { class: 'ttl-flag', title: 'Verschwindende Nachrichten' }, icon('timer', 15)) : null);
  }
  r.avatarWrap.classList.toggle('online', !group && !!c.online);
  r.mute.hidden = !c.muted;
  row.classList.toggle('selected', S.chat === c.id);
  setText(r.time, c.last ? fmtListTime(c.last.ts) : '');
  r.time.classList.toggle('unread', !!c.unread);
  setText(r.badge, c.unread ? String(c.unread) : '');
  r.badge.hidden = !c.unread;
  r.badge.classList.toggle('quiet', !!c.muted);
  const t = typingFor(c.id);
  r.sub.classList.toggle('typing', !!t);
  if (t) { setText(r.sub, group ? `${t.names} ${t.plural ? 'schreiben' : 'schreibt'} …` : 'schreibt …'); return; }
  setText(r.sub, previewFor(c));
}

function previewFor(c) {
  const m = c.last;
  if (!m) return c.kind === 'group' ? `${c.members.length} Mitglieder · Ende-zu-Ende-verschlüsselt` : 'Sicher verbunden – sag Hallo 👋';
  if (m.system) return systemText(m.system);
  const group = c.kind === 'group';
  const prefix = m.from === S.me.id ? 'Du: ' : group ? `${nameOf(m.from)}: ` : '';
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

export function systemText(sys) {
  const meBy = sys.by === S.me?.id;
  const by = sys.by ? nameOf(sys.by) : 'Vela';
  const has = meBy ? 'hast' : 'hat';
  const list = (users) => (users || []).map((u) => (u.id === S.me?.id ? 'dich' : u.username)).join(', ');
  const who = (u) => (u?.id === S.me?.id ? 'Du' : u?.username || '?');
  switch (sys.t) {
    case 'created': return `${by} ${has} die Gruppe „${sys.name}“ erstellt`;
    case 'added': return `${by} ${has} ${list(sys.users)} hinzugefügt`;
    case 'removed': return `${by} ${has} ${sys.user?.id === S.me?.id ? 'dich' : sys.user?.username} entfernt`;
    case 'left': return `${who(sys.user)} ${sys.user?.id === S.me?.id ? 'hast' : 'hat'} die Gruppe verlassen`;
    case 'renamed': return `${by} ${has} den Gruppennamen zu „${sys.name}“ geändert`;
    case 'description': return `${by} ${has} die Gruppenbeschreibung geändert`;
    case 'avatar': return `${by} ${has} das Gruppenbild geändert`;
    case 'admin': return `${who(sys.user)} ${sys.user?.id === S.me?.id ? 'bist' : 'ist'} ${sys.admin ? 'jetzt Admin' : 'kein Admin mehr'}`;
    case 'only_admins': return sys.value ? `${by}: Nur Admins dürfen die Gruppeninfo ändern` : `${by}: Alle dürfen die Gruppeninfo ändern`;
    case 'timer': return sys.ttl ? `${by} ${has} verschwindende Nachrichten aktiviert (${TTL_LABELS[sys.ttl] || ''})` : `${by} ${has} verschwindende Nachrichten deaktiviert`;
    default: return 'Gruppe aktualisiert';
  }
}

function patchPath(c) { return c.kind === 'group' ? `/groups/${c.id}/me` : `/contacts/${c.id}`; }

async function patchConv(c, patch) {
  Object.assign(c, patch);
  renderList();
  try { await api(patchPath(c), { method: 'PATCH', body: patch }); } catch (e) { snackbar(e.message); }
}

function toggleArchive(c) {
  if (!c) return;
  const archived = !c.archived;
  patchConv(c, { archived });
  vibrate(10);
  snackbar(archived ? `„${titleOf(c)}“ archiviert` : 'Chat zurückgeholt', { action: 'Rückgängig', onAction: () => patchConv(c, { archived: !archived }) });
}
function togglePin(c) { if (!c) return; patchConv(c, { pinned: !c.pinned }); snackbar(c.pinned ? 'Chat markiert und oben angeheftet' : 'Markierung entfernt'); }
export function toggleMute(c) { if (!c) return; patchConv(c, { muted: !c.muted }); snackbar(c.muted ? 'Benachrichtigungen stummgeschaltet' : 'Benachrichtigungen aktiviert'); if (S.chat === c.id) renderChatHeader(true); refreshGroupInfo(); }

function chatMenu(c, x, y) {
  if (!c) return;
  const group = c.kind === 'group';
  menu([
    { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', onClick: () => togglePin(c) },
    { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Aus Archiv holen' : 'Archivieren', onClick: () => toggleArchive(c) },
    { icon: c.muted ? 'bell' : 'mute', label: c.muted ? 'Ton an' : 'Stummschalten', onClick: () => toggleMute(c) },
    group ? { icon: 'info', label: 'Gruppeninfo', onClick: () => openGroupInfo(c.id) } : { icon: 'person', label: 'Kontaktinfo', onClick: () => contactSheet(c) },
    !group ? { icon: 'shield', label: 'Sicherheitsnummer prüfen', onClick: () => verifyDialog(c) } : null,
    group ? { icon: 'logout', label: 'Gruppe verlassen', danger: true, onClick: () => leaveGroup(c) } : { icon: 'delete', label: 'Kontakt & Chat löschen', danger: true, onClick: () => removeContact(c) },
  ], x, y, { header: h('div', { class: 'menu-header' }, avatarEl(c, 36), h('strong', {}, titleOf(c))) });
}

export async function leaveGroup(g) {
  if (!(await confirm('Gruppe verlassen?', `Du verlässt „${g.name}“ und erhältst keine Nachrichten mehr aus dieser Gruppe.`, { ok: 'Verlassen', danger: true }))) return false;
  try {
    await api(`/groups/${g.id}/members/${S.me.id}`, { method: 'DELETE' });
    S.groups.delete(g.id); S.messages.delete(g.id);
    if (S.chat === g.id) closeChat();
    renderList();
    snackbar(`Du hast „${g.name}“ verlassen`);
    return true;
  } catch (e) { snackbar(e.message); return false; }
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
  if (!isRequest && !(await confirm('Kontakt löschen?', `${c.username} wird entfernt. Der gemeinsame Chat wird für euch beide vom Server gelöscht. Gemeinsame Gruppen bleiben bestehen.`, { ok: 'Löschen', danger: true }))) return;
  try {
    await api('/contacts/' + c.id, { method: 'DELETE' });
    S.contacts.delete(c.id);
    S.messages.delete(c.id);
    if (S.chat === c.id) closeChat();
    await rebuildUsers();
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
  const common = [...S.groups.values()].filter((g) => g.members.some((m) => m.id === c.id));
  dialog({
    cls: 'contact-sheet',
    body: h('div', { class: 'contact-info' },
      avatarEl(c, 112),
      h('h2', {}, c.username),
      c.online ? h('div', { class: 'online-label' }, 'online') : null,
      c.about ? h('p', { class: 'about' }, c.about) : h('p', { class: 'muted' }, 'Keine Info hinterlegt'),
      h('div', { class: 'chip-row center' },
        h('span', { class: 'chip static' }, icon(pin?.verified ? 'verified' : 'lock', 18), pin?.verified ? 'Verifiziert' : 'Ende-zu-Ende-verschlüsselt'),
        h('span', { class: 'chip static' }, icon('key', 18), `RSA ${pin?.bits || c.key_bits}`),
        c.ttl ? h('span', { class: 'chip static' }, icon('timer', 18), TTL_LABELS[c.ttl]) : null),
      common.length ? h('p', { class: 'small muted' }, `Gemeinsame Gruppen: ${common.map((g) => g.name).join(', ')}`) : null),
    actions: [
      { label: 'Sicherheitsnummer', onClick: () => { setTimeout(() => verifyDialog(c), 50); } },
      { label: 'Schließen', primary: true },
    ],
  });
}

// ================================================================= Sicherheitsnummer
export async function verifyDialog(c) {
  if (!c || !S.pins.get(c.id)) return;
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
          if (S.chat) renderChatHeader(true);
          snackbar(pin.verified ? `${c.username} ist verifiziert` : 'Verifizierung aufgehoben');
        },
      },
    ],
  });
}

// ================================================================= Entschlüsseln
export async function verifyKeyFor(m) {
  if (m.from === S.me.id) return importSigPub(S.keys.sigPubB64);
  let pin = S.pins.get(m.from);
  if (!pin) pin = await store.get('pins', cacheKey('pin:' + m.from)).catch(() => null); // z. B. ausgetretenes Mitglied
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
      const cached = await cacheGet(m.id);
      if (cached) return cached;
    }
    try {
      const verifyKey = await verifyKeyFor(m);
      if (!verifyKey) return { error: 'Absender-Schlüssel unbekannt oder geändert – bitte Sicherheitsnummer prüfen' };
      const { payload } = await openMessage({ envelope: m.envelope, id: m.id, from: m.from, to: m.to, me: S.me.id, decKey: S.keys.encPriv, verifyKey });
      const res = { payload };
      if (!m.view_once) cachePut(m.id, res);
      return res;
    } catch (e) {
      return { error: e.message || 'Entschlüsselung fehlgeschlagen' };
    }
  })().then((res) => { S.dec.set(m.id, res); return res; });
  S.decoded.set(m.id, p);
  return p;
}

// ================================================================= Chat
export async function openChat(id, { keepHistory = false } = {}) {
  const c = conv(id);
  if (!c) return;
  if (S.view !== 'chats' && compact()) switchView('chats');
  if (S.chat && S.chat !== id) saveDraft();
  const wasOpen = !!S.chat;
  S.chat = id;
  S.reply = null; S.editing = null;
  S.viewOnce = false;
  msgNodes.clear(); dayNodes.clear();
  el.loadMore = null; el.e2eNote = null; el.unreadSep = null; el.unreadFrom = null;
  el.searchBar = null;
  initialRender = true;
  newWhileScrolled = 0;
  el.shell.classList.add('chat-open');
  if (compact() && !wasOpen && !keepHistory) history.pushState({ chat: id }, '', '#chat');
  for (const r of el.list.querySelectorAll('.chat-row')) r.classList.toggle('selected', r.dataset.id === id);

  el.header = h('header', { class: 'top-bar chat-bar' });
  el.banner = h('div', { class: 'banner-slot' });
  el.msgs = h('div', { class: 'messages' + (c.kind === 'group' ? ' is-group' : ''), role: 'log', 'aria-label': `Nachrichten: ${titleOf(c)}` });
  el.msgs.addEventListener('scroll', onMessagesScroll, { passive: true });
  el.msgProgress = progress({ value: null, cls: 'thin top' });
  el.typingSlot = h('div', { class: 'typing-slot', 'aria-live': 'polite' }, h('div', { class: 'typing-inner' }));
  el.toBottom = h('button', { class: 'to-bottom', type: 'button', 'aria-label': 'Zu den neuesten Nachrichten', onclick: () => scrollToBottom(true) },
    icon('arrow_down', 22), h('span', { class: 'to-bottom-badge' }));
  el.composer = buildComposer(c);
  clear(el.chatPane, h('div', { class: 'chat chat-enter' }, el.header, el.msgProgress.el, el.banner,
    h('div', { class: 'messages-wrap' }, el.msgs, el.toBottom), el.typingSlot, el.composer));
  renderChatHeader(true);
  renderTyping();

  if (!S.messages.has(id)) await loadMessages(id);
  else el.msgProgress.el.hidden = true;
  if (S.chat !== id) return;
  el.unreadFrom = firstUnread(c);
  await renderMessages({ scroll: el.unreadFrom ? 'unread' : 'bottom' });
  initialRender = false;
  markRead(id);
  if (!isTouch()) el.input?.focus({ preventScroll: true });
}

function firstUnread(c) {
  const list = (S.messages.get(c.id) || []).filter((m) => !m.silent && !m.system && m.from !== S.me.id);
  const m = c.kind === 'group' ? list.find((x) => x.ts > (c.last_read || 0)) : list.find((x) => !x.read_at);
  return m ? m.id : null;
}

export function closeChat() {
  saveDraft();
  sendTypingStop();
  el.searchBar = null;
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
  if (e.key === 'Escape' && S.chat && !document.querySelector('dialog[open], .menu-scrim, .viewer, .story, .side-panel')) {
    if (el.searchBar) { closeSearch(); return; }
    if (S.editing) { cancelEdit(); return; }
    if (compact()) history.back(); else closeChat();
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && el.search) { e.preventDefault(); switchView('chats'); el.search.focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && S.chat) { e.preventDefault(); openSearch(); }
});

function typingFor(id) {
  const t = S.typing.get(id);
  if (!t) return null;
  if (t.users) {
    const now = Date.now();
    const ids = [...t.users].filter(([, until]) => until > now).map(([uid]) => uid);
    if (!ids.length) return null;
    const names = ids.slice(0, 2).map(nameOf).join(' und ') + (ids.length > 2 ? ` +${ids.length - 2}` : '');
    return { names, plural: ids.length > 1, ids };
  }
  return t.until > Date.now() ? t : null;
}

function headerStatus(c) {
  const t = typingFor(c.id);
  if (t) return { text: c.kind === 'group' ? `${t.names} ${t.plural ? 'schreiben' : 'schreibt'} …` : 'schreibt …', cls: 'typing' };
  if (c.kind === 'group') {
    const online = c.members.filter((m) => m.id !== S.me.id && m.online).length;
    const names = c.members.map((m) => (m.id === S.me.id ? 'Du' : m.username)).join(', ');
    return { text: online ? `${c.members.length} Mitglieder · ${online} online` : names, cls: '' };
  }
  if (c.online) return { text: 'online', cls: 'online' };
  const pin = S.pins.get(c.id);
  return { text: pin?.verified ? 'Verifiziert · Ende-zu-Ende-verschlüsselt' : 'Ende-zu-Ende-verschlüsselt', cls: '', icon: pin?.verified ? 'verified' : 'lock' };
}

export function renderChatHeader(force = false) {
  const c = conv(S.chat);
  if (!c || !el.header) return;
  if (el.searchBar) return;
  const group = c.kind === 'group';
  const st = headerStatus(c);
  const changedUsers = group ? c.members.filter((m) => S.changed.has(m.id)) : (S.changed.has(c.id) ? [c] : []);
  const key = [titleOf(c), c.avatar_version, st.text, st.cls, c.archived, c.pinned, c.muted, c.ttl, changedUsers.map((u) => u.id).join(), group && c.members.length].join('|');
  if (!force && el.header.dataset.key === key) return;
  el.header.dataset.key = key;
  clear(el.header,
    iconBtn('back', 'Zurück', () => (compact() ? history.back() : closeChat()), 'show-compact'),
    h('button', { class: 'chat-title', type: 'button', onclick: () => (group ? openGroupInfo(c.id) : contactSheet(c)) },
      h('div', { class: 'row-avatar' + (!group && c.online ? ' online' : '') }, avatarEl(c, 42), h('span', { class: 'online-dot' })),
      h('div', { class: 'chat-title-text' },
        h('div', { class: 'name' }, titleOf(c), c.muted ? icon('mute', 15, 'title-flag') : null, c.ttl ? icon('timer', 15, 'title-flag') : null),
        h('div', { class: 'status ' + st.cls }, st.icon ? icon(st.icon, 14) : null, ' ', st.text))),
    iconBtn('search', 'In Chat suchen', () => openSearch()),
    !group ? iconBtn('shield', 'Sicherheitsnummer', () => verifyDialog(c), 'hide-compact') : null,
    iconBtn('more', 'Mehr', (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      menu([
        group ? { icon: 'info', label: 'Gruppeninfo', onClick: () => openGroupInfo(c.id) } : { icon: 'person', label: 'Kontaktinfo', onClick: () => contactSheet(c) },
        !group ? { icon: 'shield', label: 'Sicherheitsnummer prüfen', onClick: () => verifyDialog(c) } : null,
        { icon: 'search', label: 'In Chat suchen', onClick: () => openSearch() },
        { icon: 'timer', label: 'Verschwindende Nachrichten', onClick: () => ttlDialog(c) },
        { icon: c.muted ? 'bell' : 'mute', label: c.muted ? 'Ton an' : 'Stummschalten', onClick: () => toggleMute(c) },
        { icon: c.archived ? 'unarchive' : 'archive', label: c.archived ? 'Aus Archiv holen' : 'Archivieren', onClick: () => toggleArchive(c) },
        { icon: 'pin', label: c.pinned ? 'Markierung entfernen' : 'Markieren', onClick: () => togglePin(c) },
        group ? { icon: 'logout', label: 'Gruppe verlassen', danger: true, onClick: () => leaveGroup(c) } : { icon: 'delete', label: 'Kontakt & Chat löschen', danger: true, onClick: () => removeContact(c) },
      ], r.right - 240, r.bottom);
    }));
  clear(el.banner, changedUsers.length ? h('div', { class: 'banner warn' }, icon('warn', 20),
    h('span', {}, group
      ? `Der Sicherheitsschlüssel von ${changedUsers.map((u) => u.username).join(', ')} hat sich geändert. Bis zur Bestätigung werden Nachrichten nicht an ${changedUsers.length > 1 ? 'diese Personen' : 'diese Person'} verschlüsselt.`
      : `Der Sicherheitsschlüssel von ${c.username} hat sich geändert (z. B. neues Gerät oder neue Schlüssel). Prüfe die Sicherheitsnummer, bevor du weiterschreibst.`),
    button('Neuen Schlüssel akzeptieren', { kind: 'tonal', cls: 'small', onClick: async () => { for (const u of changedUsers) await acceptNewKey(S.users.get(u.id) || u); } })) : null);
  el.composer?.classList.toggle('blocked', !group && changedUsers.length > 0);
  if (el.voToggle) el.voToggle.hidden = group;
}

async function loadMessages(id, before) {
  if (el.msgProgress) el.msgProgress.el.hidden = false;
  try {
    const q = before ? '?before=' + before : '';
    const res = await api(isGroup(id) ? `/groups/${id}/messages${q}` : `/messages/${id}${q}`);
    const list = S.messages.get(id) || [];
    const known = new Set(list.map((m) => m.id));
    for (const m of res.messages) learnNames(m);
    const merged = [...res.messages.filter((m) => !known.has(m.id)), ...list].sort((a, b) => a.ts - b.ts);
    S.messages.set(id, merged);
    S.hasMore.set(id, res.has_more);
  } catch (e) { snackbar(e.message); } finally { if (el.msgProgress) el.msgProgress.el.hidden = true; }
}

function learnNames(m) {
  const sys = m.system;
  if (!sys) return;
  for (const u of [...(sys.users || []), sys.user].filter(Boolean)) if (u.id && u.username) S.names.set(u.id, u.username);
}

// Reaktionen und Bearbeitungen sind stille, E2E-verschlüsselte Nachrichten
function silentMaps(list) {
  const reactions = new Map(), edits = new Map();
  const byId = new Map(list.map((m) => [m.id, m]));
  for (const m of list) {
    if (!m.silent) continue;
    const p = S.dec.get(m.id)?.payload;
    if (!p) continue;
    if (p.t === 'reaction') {
      if (!reactions.has(p.target)) reactions.set(p.target, new Map());
      reactions.get(p.target).set(m.from, p.emoji);
    } else if (p.t === 'edit') {
      const target = byId.get(p.target);
      if (target && target.from === m.from) edits.set(p.target, { body: p.body, ts: m.ts }); // nur eigene Nachrichten
    }
  }
  return { reactions, edits };
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
export async function renderMessages({ scroll } = {}) {
  const id = S.chat;
  if (!id || !el.msgs) return;
  const token = ++renderToken;
  const c = conv(id);
  const group = c?.kind === 'group';
  const list = S.messages.get(id) || [];
  const todo = list.filter((m) => m.envelope && !m.view_once && !S.dec.has(m.id));
  if (todo.length) { await cachePrefetch(todo.map((m) => m.id)); await Promise.all(todo.map(decode)); }
  if (token !== renderToken || S.chat !== id) return;

  const wasAtBottom = distanceFromBottom() < 120;
  const prevHeight = el.msgs.scrollHeight, prevTop = el.msgs.scrollTop;
  const { reactions, edits } = silentMaps(list);
  const now = Date.now();
  const visible = list.filter((m) => !m.silent && !hidden.has(m.id) && !(m.expires_at && m.expires_at < now));
  const nodes = [];
  if (S.hasMore.get(id)) {
    el.loadMore ||= h('div', { class: 'load-more' }, button('Ältere Nachrichten laden', { kind: 'text', onClick: async () => {
      const cur = S.messages.get(S.chat) || [];
      await loadMessages(S.chat, cur[0]?.ts); renderMessages({ scroll: 'keep' });
    } }));
    nodes.push(el.loadMore);
  }
  el.e2eNote ||= h('div', { class: 'e2e-note' }, icon('lock', 14), group
    ? ' Gruppennachrichten sind Ende-zu-Ende-verschlüsselt: Jede Nachricht wird einzeln für jedes Mitglied verschlüsselt.'
    : ` Nachrichten sind Ende-zu-Ende-verschlüsselt. Verschlüsselte Inhalte werden nach ${S.config.retention_days} Tagen vom Server gelöscht.`);
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
    if (m.id === el.unreadFrom) {
      el.unreadSep ||= h('div', { class: 'unread-sep' }, h('span', {}, 'Ungelesene Nachrichten'));
      nodes.push(el.unreadSep);
    }
    if (m.system) { nodes.push(systemRow(m)); live.add(m.id); return; }
    const prev = visible[i - 1], next = visible[i + 1];
    const sameAs = (o) => o && !o.system && o.from === m.from && Math.abs(o.ts - m.ts) <= GROUP_GAP_MS && fmtDay(o.ts) === day;
    nodes.push(messageRow(m, reactions.get(m.id), edits.get(m.id), !sameAs(prev), !sameAs(next), group));
    live.add(m.id);
  });
  for (const u of S.uploads.get(id) || []) nodes.push(u.node);
  reconcile(el.msgs, nodes);
  for (const k of [...msgNodes.keys()]) if (!live.has(k)) msgNodes.delete(k);
  if (el.searchBar) applySearch(false);

  if (scroll === 'bottom') scrollToBottom(false);
  else if (scroll === 'unread' && el.unreadSep?.isConnected) { el.msgs.scrollTop = el.unreadSep.offsetTop - 80; onMessagesScroll(); }
  else if (scroll === 'keep') el.msgs.scrollTop = prevTop + (el.msgs.scrollHeight - prevHeight);
  else if (scroll === 'smooth' || wasAtBottom) scrollToBottom(!initialRender && scroll !== 'instant');
}

function systemRow(m) {
  const cached = msgNodes.get(m.id);
  if (cached) return cached.row;
  const row = h('div', { class: 'sys-row' + (initialRender ? '' : ' enter'), dataset: { id: m.id } },
    h('span', {}, m.system.t === 'timer' ? icon('timer', 14) : null, systemText(m.system)));
  msgNodes.set(m.id, { row, sig: 'sys' });
  return row;
}

function reactionKey(reacts) {
  if (!reacts) return '';
  return [...reacts].filter(([, e]) => e).map(([u, e]) => u + e).sort().join(',');
}

function readState(m, c) {
  if (m.from !== S.me.id) return null;
  if (c?.kind !== 'group') return m.read_at ? 'read' : 'sent';
  const others = c.members.filter((x) => x.id !== S.me.id && x.joined_at <= m.ts);
  if (!others.length || others.some((x) => x.last_read == null)) return 'sent';
  return others.every((x) => x.last_read >= m.ts) ? 'read' : 'sent';
}

function messageRow(m, reacts, edit, first, last, group) {
  const d = S.dec.get(m.id);
  const c = conv(S.chat);
  const sig = [readState(m, c), m.viewed_at ? 1 : 0, m.deleted_at ? 1 : 0, m.pending ? 1 : 0, m.failed ? 1 : 0,
    m.envelope ? 1 : 0, d ? (d.error ? 'e' : 'ok') : '-', first ? 1 : 0, last ? 1 : 0, reactionKey(reacts), edit?.ts || 0,
    group ? nameOf(m.from) : ''].join('|');
  const cached = msgNodes.get(m.id);
  if (cached && cached.sig === sig) return cached.row;
  const row = buildMessageRow(m, d, reacts, edit, first, last, group, c);
  if (!cached && !initialRender) {
    row.classList.add('enter');
    row.addEventListener('animationend', () => row.classList.remove('enter'), { once: true });
  }
  if (cached?.row.isConnected) cached.row.replaceWith(row);
  msgNodes.set(m.id, { row, sig });
  return row;
}

function buildMessageRow(m, d, reactions, edit, first, last, group, c) {
  const mine = m.from === S.me.id;
  const bubble = h('div', { class: 'bubble' });
  const rs = readState(m, c);
  const meta = h('span', { class: 'meta' }, edit ? h('span', { class: 'edited' }, 'bearbeitet') : null, fmtTime(m.ts),
    mine ? (m.failed ? h('span', { class: 'tick failed', title: 'Nicht gesendet' }, icon('warn', 15))
      : m.pending ? h('span', { class: 'tick pending', title: 'Wird gesendet' }, icon('timer', 15))
        : h('span', { class: 'tick' + (rs === 'read' ? ' read' : ''), title: rs === 'read' ? 'Gelesen' : 'Gesendet' }, icon(rs === 'read' ? 'done_all' : 'check', 15))) : null);
  let payload = null;

  if (group && !mine && first && !m.deleted_at) {
    bubble.append(h('div', { class: 'sender', style: { '--h': hue(nameOf(m.from)) } }, nameOf(m.from)));
  }
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
    payload = edit ? { ...d.payload, body: edit.body } : d.payload;
    if (payload.fwd) bubble.append(h('div', { class: 'fwd-label' }, icon('forward', 14), ' Weitergeleitet'));
    if (payload.reply) {
      const who = payload.reply.from === S.me.id ? 'Du' : nameOf(payload.reply.from);
      bubble.append(h('button', { class: 'quote no-gesture', type: 'button', onclick: () => jumpTo(payload.reply.id) }, h('strong', {}, who), h('span', {}, payload.reply.snippet)));
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
        title: [...reactions].filter(([, e]) => e === emo).map(([u]) => nameOf(u)).join(', '),
        'aria-label': `Reaktion ${emo}, ${n}`,
      }, emo, n > 1 ? h('span', {}, n) : null))));
    }
  }
  let inner = wrap;
  if (group && !mine) {
    inner = h('div', { class: 'with-avatar' }, last ? avatarEl(S.users.get(m.from) || { id: m.from, username: nameOf(m.from) }, 30) : h('span', { class: 'avatar-spacer' }), wrap);
  }
  if (!m.deleted_at && !m.pending) {
    const actions = h('div', { class: 'hover-actions no-gesture', role: 'toolbar', 'aria-label': 'Nachrichtenaktionen' },
      QUICK.map((e) => h('button', { class: 'quick-react', type: 'button', 'aria-label': 'Reagieren mit ' + e, onclick: () => react(m, e) }, e)),
      h('span', { class: 'ha-sep' }),
      iconBtn('mood', 'Weitere Reaktionen', (e) => reactionPicker(m, e.currentTarget)),
      !m.view_once ? iconBtn('reply', 'Antworten', () => setReply(m, payload)) : null,
      payload?.t === 'text' ? iconBtn('copy', 'Kopieren', () => copyText(payload.body)) : null,
      iconBtn('more', 'Mehr', (e) => { const r = e.currentTarget.getBoundingClientRect(); messageMenu(m, payload, r.left, r.bottom, edit); }));
    wrap.prepend(actions);
    swipeable(row, inner, {
      left: !m.view_once ? { icon: 'reply', label: 'Antworten', color: 'secondary', action: () => setReply(m, payload) } : null,
      right: { icon: 'mood', label: 'Reagieren', color: 'primary', action: () => reactionPicker(m) },
      onLongPress: (x, y) => messageMenu(m, payload, x, y, edit),
      onDoubleTap: () => react(m, '❤️'),
      maxShift: 96,
    });
  } else row.append(inner);
  return row;
}

function jumpTo(id) {
  const row = el.msgs?.querySelector(`.msg-row[data-id="${id}"]`);
  if (!row) { snackbar('Ursprüngliche Nachricht ist nicht geladen'); return; }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' });
  row.classList.remove('flash'); void row.offsetWidth; row.classList.add('flash');
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => snackbar('Kopiert')).catch(() => snackbar('Kopieren nicht möglich'));
}

function linkify(text) {
  const parts = [];
  const re = /\bhttps?:\/\/[^\s<>"']+|@[A-Za-z0-9_.]{3,32}/gi;
  let last = 0, mt;
  while ((mt = re.exec(text))) {
    if (mt.index > last) parts.push(text.slice(last, mt.index));
    if (mt[0][0] === '@') {
      const isMe = mt[0].slice(1).toLowerCase() === S.me.username.toLowerCase();
      parts.push(h('span', { class: 'mention' + (isMe ? ' me' : '') }, mt[0]));
      last = mt.index + mt[0].length;
      continue;
    }
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

// ---------------------------------------------------------------- Suche im Chat
function payloadText(m, edits) {
  const d = S.dec.get(m.id);
  if (!d?.payload) return '';
  const p = d.payload;
  return [edits.get(m.id)?.body ?? p.body, p.caption, p.file?.name].filter(Boolean).join(' ');
}

function openSearch() {
  if (!S.chat) return;
  if (el.searchBar) { el.searchInput?.focus(); return; }
  const input = h('input', { type: 'search', class: 'chat-search-input', placeholder: 'In diesem Chat suchen …', 'aria-label': 'In diesem Chat suchen' });
  const count = h('span', { class: 'search-count' });
  el.searchInput = input; el.searchCount = count;
  el.searchState = { hits: [], idx: -1 };
  el.searchBar = h('div', { class: 'chat-search' },
    iconBtn('back', 'Suche schließen', () => closeSearch()),
    input, count,
    iconBtn('up', 'Vorheriger Treffer', () => stepSearch(-1)),
    iconBtn('arrow_down', 'Nächster Treffer', () => stepSearch(1)));
  input.addEventListener('input', () => applySearch(true));
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); stepSearch(e.shiftKey ? 1 : -1); } });
  clear(el.header, el.searchBar);
  el.header.dataset.key = '';
  setTimeout(() => input.focus(), 30);
}

function closeSearch() {
  if (!el.searchBar) return;
  el.searchBar = null; el.searchInput = null;
  el.msgs?.querySelectorAll('.search-hit, .search-current').forEach((n) => n.classList.remove('search-hit', 'search-current'));
  renderChatHeader(true);
}

function applySearch(jump) {
  const q = el.searchInput?.value.trim().toLowerCase() || '';
  const rows = [...el.msgs.querySelectorAll('.msg-row[data-id]')];
  rows.forEach((r) => r.classList.remove('search-hit', 'search-current'));
  if (!q) { el.searchState.hits = []; el.searchCount.textContent = ''; return; }
  const list = S.messages.get(S.chat) || [];
  const byId = new Map(list.map((m) => [m.id, m]));
  const { edits } = silentMaps(list);
  const hits = rows.filter((r) => byId.has(r.dataset.id) && payloadText(byId.get(r.dataset.id), edits).toLowerCase().includes(q));
  hits.forEach((r) => r.classList.add('search-hit'));
  el.searchState.hits = hits;
  if (jump || el.searchState.idx >= hits.length) el.searchState.idx = hits.length - 1;
  el.searchCount.textContent = hits.length ? `${el.searchState.idx + 1}/${hits.length}` : (S.hasMore.get(S.chat) ? '0 · ältere laden' : '0');
  if (hits.length) {
    const cur = hits[el.searchState.idx];
    cur.classList.add('search-current');
    if (jump) cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function stepSearch(dir) {
  const st = el.searchState;
  if (!st?.hits.length) return;
  st.hits[st.idx]?.classList.remove('search-current');
  st.idx = (st.idx + dir + st.hits.length) % st.hits.length;
  const cur = st.hits[st.idx];
  cur.classList.add('search-current');
  cur.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.searchCount.textContent = `${st.idx + 1}/${st.hits.length}`;
}

// ---------------------------------------------------------------- Typ-Anzeige direkt über der Eingabeleiste
function renderTyping() {
  if (!el.typingSlot) return;
  const c = conv(S.chat);
  const t = c ? typingFor(c.id) : null;
  const inner = el.typingSlot.firstChild;
  const key = t ? (t.preview ? 'p:' + t.preview : 'dots:' + (t.ids || []).join()) : 'none';
  if (inner.dataset.key === key) return;
  inner.dataset.key = key;
  if (t) {
    const wasAtBottom = distanceFromBottom() < 120;
    const who = c.kind === 'group' ? (S.users.get(t.ids[0]) || { id: t.ids[0], username: nameOf(t.ids[0]) }) : c;
    if (t.preview) {
      let bubble = inner.querySelector('.typing-bubble.live');
      if (!bubble) clear(inner, avatarEl(who, 28), bubble = h('div', { class: 'typing-bubble live' }, h('span', { class: 'live-label' }, 'Live'), h('span', { class: 'live-text' })));
      bubble.querySelector('.live-text').textContent = t.preview;
    } else {
      clear(inner, avatarEl(who, 28), h('div', { class: 'typing-bubble dots', 'aria-label': `${c.kind === 'group' ? t.names : c.username} schreibt` }, h('i'), h('i'), h('i')),
        c.kind === 'group' ? h('span', { class: 'typing-names' }, t.names) : null);
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
    await api(`/messages/${m.id}/viewed`, { method: 'POST' });
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

function messageMenu(m, payload, x, y, edit) {
  const mine = m.from === S.me.id;
  const c = conv(S.chat);
  const canDelete = !m.deleted_at && !m.pending && (mine || (c?.kind === 'group' && c.role === 'admin'));
  const canEdit = mine && payload?.t === 'text' && !m.view_once && !m.deleted_at && !m.pending && Date.now() - m.ts < EDIT_WINDOW_MS;
  let closeFn = null;
  const items = [
    !m.view_once && !m.deleted_at ? { icon: 'reply', label: 'Antworten', onClick: () => setReply(m, payload) } : null,
    payload?.t === 'text' ? { icon: 'copy', label: 'Text kopieren', onClick: () => copyText(payload.body) } : null,
    canEdit ? { icon: 'edit', label: 'Bearbeiten', onClick: () => startEdit(m, payload) } : null,
    payload && !m.view_once ? { icon: 'forward', label: 'Weiterleiten', onClick: () => forwardDialog(m, payload) } : null,
    payload?.t === 'image' ? { icon: 'download', label: 'Foto speichern', onClick: async () => { const f = await getFile(payload.file); savePhoto(f.blob, payload.file.name); } } : null,
    payload?.t === 'file' ? { icon: 'download', label: 'Datei speichern', onClick: async () => { const f = await getFile(payload.file); saveBlob(f.blob, payload.file.name); } } : null,
    { icon: 'info', label: 'Info', onClick: () => infoDialog(m, edit) },
    { icon: 'close', label: 'Für mich ausblenden', onClick: () => hideForMe(m) },
    canDelete ? { icon: 'delete', label: mine ? 'Für alle löschen' : 'Für alle löschen (Admin)', danger: true, onClick: () => deleteForAll(m) } : null,
  ];
  closeFn = menu(items, x, y, { header: !m.deleted_at ? reactionBar(m, () => closeFn?.()) : null });
}

function infoDialog(m, edit) {
  const c = conv(S.chat);
  const group = c?.kind === 'group';
  const rows = [
    ['Gesendet', new Date(m.ts).toLocaleString('de-DE')],
    edit ? ['Bearbeitet', new Date(edit.ts).toLocaleString('de-DE')] : null,
    !group && m.read_at ? ['Gelesen', new Date(m.read_at).toLocaleString('de-DE')] : null,
    m.viewed_at ? ['Geöffnet (Einmalansicht)', new Date(m.viewed_at).toLocaleString('de-DE')] : null,
    ['Verschlüsselung', group ? `AES-256-GCM, Schlüssel für jedes der ${c.members.length} Mitglieder per RSA-OAEP gekapselt` : 'AES-256-GCM, Schlüssel per RSA-OAEP (SHA-256) gekapselt'],
    ['Signatur', 'ECDSA P-256 / SHA-256 – geprüft'],
    ['Auf dem Server gespeichert bis', new Date(m.expires_at || m.ts + S.config.retention_days * 86400000).toLocaleString('de-DE')],
  ].filter(Boolean);
  let readers = null;
  if (group && m.from === S.me.id) {
    const others = c.members.filter((x) => x.id !== S.me.id && x.joined_at <= m.ts);
    const read = others.filter((x) => x.last_read != null && x.last_read >= m.ts);
    const hiddenN = others.filter((x) => x.last_read == null).length;
    readers = h('div', { class: 'readers' }, h('h3', {}, `Gelesen von ${read.length} / ${others.length}`),
      read.map((x) => h('div', { class: 'viewer-item' }, avatarEl(S.users.get(x.id) || x, 30), h('span', {}, x.username))),
      hiddenN ? h('p', { class: 'small muted' }, `${hiddenN} Mitglieder haben Lesebestätigungen deaktiviert.`) : null);
  }
  dialog({ title: 'Nachrichteninfo', body: h('div', {}, h('dl', { class: 'fp-list' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])), readers), actions: [{ label: 'OK', primary: true }] });
}

async function hideForMe(m) {
  hidden.add(m.id);
  await store.setPref(cacheKey('hidden'), [...hidden].slice(-5000));
  renderMessages();
  snackbar('Nachricht auf diesem Gerät ausgeblendet', { action: 'Rückgängig', onAction: async () => { hidden.delete(m.id); await store.setPref(cacheKey('hidden'), [...hidden]); renderMessages(); } });
}

async function deleteForAll(m) {
  if (!(await confirm('Für alle löschen?', 'Die Nachricht und angehängte Dateien werden vom Server gelöscht und bei allen Empfängern durch einen Hinweis ersetzt.', { ok: 'Löschen', danger: true }))) return;
  try {
    await api(m.group ? `/groups/${m.group}/messages/${m.id}` : '/messages/' + m.id, { method: 'DELETE' });
  } catch (e) { snackbar(e.message); }
}

async function react(m, emoji) {
  vibrate(8);
  const list = S.messages.get(S.chat) || [];
  const current = silentMaps(list).reactions.get(m.id)?.get(S.me.id);
  const value = current === emoji ? '' : emoji;
  try { await sendPayload(S.chat, { t: 'reaction', target: m.id, emoji: value }, { silent: true }); } catch (e) { snackbar(e.message); }
}

function setReply(m, payload) {
  if (!payload) return;
  if (S.editing) cancelEdit();
  S.reply = { id: m.id, from: m.from, snippet: previewText(payload).slice(0, 100) };
  renderReplyPreview();
  el.input?.focus();
}

function startEdit(m, payload) {
  S.reply = null;
  S.editing = { id: m.id, original: payload.body };
  el.input.value = payload.body;
  autoGrow(); updateComposer(); renderReplyPreview();
  el.input.focus();
  el.input.setSelectionRange(el.input.value.length, el.input.value.length);
}

function cancelEdit() {
  S.editing = null;
  el.input.value = S.drafts.get(S.chat) || '';
  autoGrow(); updateComposer(); renderReplyPreview();
}

// ================================================================= Composer
function buildComposer(c) {
  el.input = h('textarea', { class: 'composer-input', rows: 1, placeholder: 'Nachricht', 'aria-label': 'Nachricht schreiben', enterkeyhint: isTouch() ? 'enter' : 'send' });
  el.input.value = S.drafts.get(c.id) || '';
  el.replySlot = h('div', { class: 'reply-slot' });
  el.voToggle = h('button', { class: 'icon-btn vo-toggle', type: 'button', 'aria-pressed': 'false', title: 'Einmalansicht', 'aria-label': 'Als Einmalansicht senden',
    hidden: c.kind === 'group', onclick: () => { S.viewOnce = !S.viewOnce; updateComposer(); } }, h('span', { class: 'vo-badge' }, '1'));
  el.sendBtn = h('button', { class: 'send-btn', type: 'button', 'aria-label': 'Senden' },
    h('span', { class: 'sb-icon sb-send' }, icon('send')), h('span', { class: 'sb-icon sb-mic' }, icon('mic')), h('span', { class: 'sb-icon sb-check' }, icon('check')));
  setupSendButton(el.sendBtn);
  el.fileInput = h('input', { type: 'file', hidden: true, multiple: true, onchange: (e) => { handleFiles([...e.target.files], el.fileInput.dataset.mode); e.target.value = ''; } });
  const attach = iconBtn('attach', 'Anhängen', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const pick = (mode, accept, capture) => {
      el.fileInput.dataset.mode = mode; el.fileInput.accept = accept;
      if (capture) el.fileInput.setAttribute('capture', 'environment'); else el.fileInput.removeAttribute('capture');
      el.fileInput.multiple = !capture;
      el.fileInput.click();
    };
    const group = isGroup(S.chat);
    menu([
      isTouch() ? { icon: 'camera', label: 'Kamera', onClick: () => pick('image', 'image/*', true) } : null,
      { icon: 'image', label: 'Fotos', onClick: () => pick('image', 'image/*') },
      !group ? { icon: 'eye1', label: 'Einmalansicht-Foto', onClick: () => pick('viewonce', 'image/*') } : null,
      { icon: 'file', label: `Datei (max. ${fmtBytes(S.config.max_upload_bytes)})`, onClick: () => pick('file', '') },
    ], r.left, r.top - 220);
  });
  el.input.addEventListener('input', () => { autoGrow(); updateComposer(); if (!S.editing) onTypingInput(); });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !isTouch() && !e.isComposing) { e.preventDefault(); sendText(); }
    if (e.key === 'ArrowUp' && !el.input.value && !S.editing) {
      // Pfeil hoch im leeren Feld: letzte eigene Textnachricht bearbeiten
      const list = S.messages.get(S.chat) || [];
      const lastMine = [...list].reverse().find((m) => m.from === S.me.id && !m.silent && !m.system && !m.deleted_at && S.dec.get(m.id)?.payload?.t === 'text');
      if (lastMine && Date.now() - lastMine.ts < EDIT_WINDOW_MS) {
        e.preventDefault();
        const ed = silentMaps(list).edits.get(lastMine.id);
        startEdit(lastMine, { ...S.dec.get(lastMine.id).payload, body: ed?.body ?? S.dec.get(lastMine.id).payload.body });
      }
    }
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
  el.sendBtn.classList.toggle('has-text', hasText && !S.editing);
  el.sendBtn.classList.toggle('editing', !!S.editing);
  el.sendBtn.setAttribute('aria-label', S.editing ? 'Änderung speichern' : hasText ? 'Senden' : 'Sprachnachricht: gedrückt halten oder tippen');
  el.sendBtn.title = S.editing ? 'Änderung speichern' : hasText ? 'Senden' : 'Gedrückt halten zum Aufnehmen, tippen zum Starten';
  el.voToggle.classList.toggle('active', S.viewOnce);
  el.voToggle.setAttribute('aria-pressed', String(S.viewOnce));
  el.input.placeholder = S.editing ? 'Nachricht bearbeiten' : S.viewOnce ? 'Einmalansicht-Nachricht' : isGroup(S.chat) ? 'Nachricht an die Gruppe' : 'Nachricht';
}

function renderReplyPreview() {
  if (!el.replySlot) return;
  if (S.editing) {
    clear(el.replySlot, h('div', { class: 'reply-preview editing' },
      icon('edit', 18), h('div', { class: 'quote' }, h('strong', {}, 'Nachricht bearbeiten'), h('span', {}, S.editing.original)),
      iconBtn('close', 'Bearbeiten abbrechen', cancelEdit)));
    return;
  }
  clear(el.replySlot, S.reply ? h('div', { class: 'reply-preview' },
    icon('reply', 18), h('div', { class: 'quote' }, h('strong', {}, S.reply.from === S.me.id ? 'Du' : nameOf(S.reply.from)), h('span', {}, S.reply.snippet)),
    iconBtn('close', 'Antwort abbrechen', () => { S.reply = null; renderReplyPreview(); })) : null);
}

function saveDraft() { if (S.chat && el.input && !S.editing) S.drafts.set(S.chat, el.input.value); }

async function sendText() {
  const text = el.input.value.trim();
  if (S.editing) {
    const ed = S.editing;
    if (!text) return;
    S.editing = null;
    el.input.value = S.drafts.get(S.chat) || '';
    autoGrow(); updateComposer(); renderReplyPreview();
    if (text !== ed.original) {
      try { await sendPayload(S.chat, { t: 'edit', target: ed.id, body: text }, { silent: true }); } catch (e) { snackbar(e.message); }
    }
    return;
  }
  if (!text) return;
  if (text.length > 20000) { snackbar('Nachricht zu lang (max. 20.000 Zeichen)'); return; }
  const payload = { t: 'text', body: text };
  if (S.reply && !S.viewOnce) payload.reply = S.reply;
  el.input.value = '';
  S.drafts.delete(S.chat);
  const vo = S.viewOnce;
  S.reply = null; S.viewOnce = false;
  el.unreadFrom = null; el.unreadSep?.remove(); el.unreadSep = null;
  autoGrow(); updateComposer(); renderReplyPreview(); sendTypingStop();
  el.input.focus();
  try { await sendPayload(S.chat, payload, { viewOnce: vo }); } catch (e) { snackbar(e.message); }
}

function groupRecipients(g) {
  const r = g.members.filter((m) => m.id !== S.me.id && !S.changed.has(m.id) && S.pins.get(m.id))
    .map((m) => ({ id: m.id, encPub: S.pins.get(m.id).encPub }));
  r.push({ id: S.me.id, encPub: S.keys.encPubB64 });
  return r;
}

export async function sendPayload(convId, payload, { viewOnce = false, silent = false, files = [] } = {}) {
  const c = conv(convId);
  if (!c) throw new Error('Chat nicht gefunden');
  const id = randomId();
  let recipients, to, group = null;
  if (c.kind === 'group') {
    group = c.id;
    to = 'g:' + c.id;
    recipients = groupRecipients(c);
    viewOnce = false;
  } else {
    const pin = S.pins.get(convId);
    if (c.status !== 'accepted' || !pin) throw new Error('Kein Schlüssel für diesen Kontakt');
    if (S.changed.has(convId)) throw new Error('Sicherheitsschlüssel geändert – bitte zuerst bestätigen');
    to = c.id;
    recipients = [{ id: c.id, encPub: pin.encPub }]; // immer an den ANGEHEFTETEN Schlüssel
    if (!viewOnce) recipients.push({ id: S.me.id, encPub: S.keys.encPubB64 });
  }
  const envelope = await sealMessage({ id, from: S.me.id, to, payload, recipients, signKey: S.keys.sigPriv, kv: S.me.key_version });
  const local = { id, from: S.me.id, to, group, envelope: viewOnce ? null : envelope, view_once: viewOnce, silent, ts: Date.now(), pending: true, _send: { envelope, files, payload } };
  if (!viewOnce) {
    const res = { payload };
    S.decoded.set(id, Promise.resolve(res));
    S.dec.set(id, res);
    cachePut(id, res);
  }
  addMessage(local);
  await deliver(local);
}

async function deliver(local, retried = false) {
  try {
    const res = local.group
      ? await api(`/groups/${local.group}/messages`, { method: 'POST', body: { id: local.id, envelope: local._send.envelope, silent: local.silent, files: local._send.files } })
      : await api('/messages', { method: 'POST', body: { id: local.id, to: local.to, envelope: local._send.envelope, view_once: local.view_once, silent: local.silent, files: local._send.files } });
    addMessage(res);
  } catch (e) {
    if (e.status === 409) return; // bereits zugestellt
    if (local.group && e.status === 400 && !retried) {
      // Mitgliederliste hat sich geändert: neu laden und für die aktuellen Mitglieder neu verschlüsseln
      await loadGroups();
      const g = S.groups.get(local.group);
      if (g) {
        local._send.envelope = await sealMessage({ id: local.id, from: S.me.id, to: local.to, payload: local._send.payload, recipients: groupRecipients(g), signKey: S.keys.sigPriv, kv: S.me.key_version });
        local.envelope = local._send.envelope;
        return deliver(local, true);
      }
    }
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
  learnNames(m);
  const convId = convOf(m);
  const list = S.messages.get(convId);
  if (list) {
    const i = list.findIndex((x) => x.id === m.id);
    if (i >= 0) list[i] = { ...list[i], ...m, pending: m.pending || false, failed: m.failed || false };
    else { list.push(m); list.sort((a, b) => a.ts - b.ts); }
  }
  const c = conv(convId);
  if (c && !m.silent && (!c.last || c.last.ts <= m.ts || c.last.id === m.id)) c.last = m;
  if (S.chat === convId) {
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
  const convId = S.chat;
  const u = addUpload(viewOnce ? 'Einmalansicht-Foto' : 'Foto');
  try {
    u.prog.set(null, 'Komprimieren & Metadaten entfernen …');
    const img = await prepareImage(file);
    const meta = await uploadEncrypted(img.blob, u);
    const fileMeta = { ...meta, mime: img.mime, name: (file.name || 'foto').replace(/\.[^.]+$/, '') + (img.mime === 'image/jpeg' ? '.jpg' : '') };
    const payload = { t: 'image', file: fileMeta, w: img.width, h: img.height, thumb: viewOnce ? null : img.thumb, compressed: img.compressed };
    if (!viewOnce) S.blobs.set(meta.id, { blob: img.blob, url: URL.createObjectURL(img.blob) });
    removeUpload(u);
    await sendPayload(convId, payload, { viewOnce, files: [meta.id] });
    if (img.compressed) snackbar(`Foto komprimiert: ${fmtBytes(file.size)} → ${fmtBytes(img.blob.size)}`);
  } catch (e) {
    removeUpload(u);
    if (e.message !== 'Upload abgebrochen' && e.message !== 'Abgebrochen') snackbar(e.message);
  }
}

async function sendFile(file) {
  const convId = S.chat;
  if (file.size > S.config.max_upload_bytes - 64 * 1024) { snackbar(`„${file.name}“ ist zu groß (max. ${fmtBytes(S.config.max_upload_bytes)})`); return; }
  const u = addUpload(file.name);
  try {
    const meta = await uploadEncrypted(file, u);
    removeUpload(u);
    await sendPayload(convId, { t: 'file', file: { ...meta, name: file.name || 'datei', mime: file.type || 'application/octet-stream' } }, { files: [meta.id] });
  } catch (e) {
    removeUpload(u);
    if (e.message !== 'Upload abgebrochen' && e.message !== 'Abgebrochen') snackbar(e.message);
  }
}

// ---------------------------------------------------------------- Sprachnachricht
const HOLD_MS = 300, CANCEL_PX = 110, LOCK_PX = 70;
let voice = null;

function setupSendButton(btn) {
  let downAt = 0, sx = 0, sy = 0, pid = null, holdTimer = 0, suppressClick = false;
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || voice || el.input.value.trim() || S.editing) return;
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
    if (voice.pendingStart) { voice.lockWhenReady = true; return; }
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
    if (!voice && (el.input.value.trim() || S.editing)) sendText();
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function startVoice({ hold }) {
  if (!isGroup(S.chat) && S.changed.has(S.chat)) { snackbar('Sicherheitsschlüssel geändert – bitte zuerst bestätigen'); return; }
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
  if (voice !== v) { rec.cancel(); return; }
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
  const text = el.input?.value || '';
  if (!text.trim()) return sendTypingStop();
  if (isGroup(id)) {
    if (S.chat === id) { S.ws.send(JSON.stringify({ type: 'typing', group: id, state: 'typing' })); typingActive = true; }
    return;
  }
  const c = S.contacts.get(id), pin = S.pins.get(id);
  if (!c || S.changed.has(id) || !pin) return;
  const msg = { type: 'typing', to: id, state: 'typing' };
  if (S.me.settings.live_typing && !S.viewOnce) {
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
  if (typingActive && S.ws?.readyState === 1 && S.chat) {
    S.ws.send(JSON.stringify(isGroup(S.chat) ? { type: 'typing', group: S.chat, state: 'stop' } : { type: 'typing', to: S.chat, state: 'stop' }));
  }
  typingActive = false;
}

const typingTimers = new Map();
async function onTyping(ev) {
  if (ev.group) {
    const t = S.typing.get(ev.group) || { users: new Map() };
    if (ev.state === 'stop') t.users.delete(ev.from); else t.users.set(ev.from, Date.now() + 6000);
    S.typing.set(ev.group, t);
    clearTimeout(typingTimers.get(ev.group + ev.from));
    typingTimers.set(ev.group + ev.from, setTimeout(() => { t.users.delete(ev.from); refreshTyping(ev.group); }, 6100));
    refreshTyping(ev.group);
    return;
  }
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

function refreshTyping(convId) {
  renderList();
  if (S.chat === convId) { renderChatHeader(); renderTyping(); }
}

// ================================================================= Gelesen-Status
async function markRead(convId) {
  if (document.hidden || S.chat !== convId) return;
  const c = conv(convId);
  if (!c) return;
  const list = S.messages.get(convId) || [];
  if (c.kind === 'group') {
    const latest = list.filter((m) => m.from !== S.me.id).reduce((a, m) => Math.max(a, m.ts), 0);
    if (c.unread) { c.unread = 0; renderList(); }
    if (latest > (c.last_read || 0)) {
      c.last_read = latest;
      try { await api(`/groups/${convId}/read`, { method: 'POST', body: { up_to: latest } }); } catch { /* später erneut */ }
    }
    return;
  }
  const unread = list.filter((m) => m.from === convId && !m.read_at);
  if (!unread.length) { if (c.unread) { c.unread = 0; renderList(); } return; }
  const upTo = Math.max(...unread.map((m) => m.ts));
  unread.forEach((m) => { m.read_at = Date.now(); });
  c.unread = 0;
  renderList();
  try { await api('/messages/read', { method: 'POST', body: { contact_id: convId, up_to: upTo } }); } catch { /* nächster Versuch beim nächsten Öffnen */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.chat) markRead(S.chat); });

// Verschwindende Nachrichten: abgelaufene Nachrichten regelmäßig ausblenden
setInterval(() => {
  if (!S.chat || document.hidden) return;
  const now = Date.now();
  if ((S.messages.get(S.chat) || []).some((m) => m.expires_at && m.expires_at < now && msgNodes.has(m.id))) renderMessages();
}, 30000);

// ================================================================= WebSocket
let wsBackoff = 1000, wsTimer = 0, pingTimer = 0;
// Server wieder erreichbar (laut /api/status), aber WebSocket noch getrennt -> sofort neu verbinden
function retryWS() { if (S.ws && S.ws.readyState === WebSocket.CLOSED) connectWS(); }
// Alle 60 s ein Ping: hält "zuletzt gesehen" auf dem Server aktuell
function startPing(ws) {
  clearInterval(pingTimer);
  pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{"type":"ping"}'); }, 60000);
}
function connectWS() {
  clearTimeout(wsTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}${BASE_PATH}/ws`);
  S.ws = ws;
  ws.onopen = () => {
    const reconnect = wsBackoff > 1000;
    wsBackoff = 1000;
    setWsState('open');
    startPing(ws);
    if (reconnect) { loadContacts(); loadGroups(); loadStatuses().then(refreshNav).catch(() => {}); if (S.chat) loadMessages(S.chat).then(() => renderMessages()); }
  };
  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    handleEvent(ev);
  };
  ws.onclose = (e) => {
    if (S.ws !== ws) return;
    if (e.code === 4401) return sessionExpired();
    setWsState('closed');
    wsTimer = setTimeout(connectWS, wsBackoff);
    wsBackoff = Math.min(wsBackoff * 2, 30000);
  };
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'message': {
      const m = ev.message;
      const incoming = m.from !== S.me.id;
      const convId = convOf(m);
      const c = conv(convId);
      if (!c && m.group) { loadGroups(); return; }
      if (incoming) {
        const t = S.typing.get(convId);
        if (t?.users) t.users.delete(m.from); else S.typing.delete(convId);
        if (S.chat === convId) { renderTyping(); renderChatHeader(); }
      }
      if (incoming && c && !m.silent && !m.system) {
        const visible = S.chat === convId && !document.hidden;
        if (!visible) c.unread = (c.unread || 0) + 1;
        if (document.hidden && S.prefs.notifications && window.Notification?.permission === 'granted' && !c.muted) {
          if (!S.pushActive) showLocal({ title: 'Vela', body: c.kind === 'group' ? `Neue Nachricht in „${c.name}“` : `Neue Nachricht von ${c.username}`, tag: convId });
        }
      }
      addMessage(m);
      if (incoming && S.chat === convId) markRead(convId);
      break;
    }
    case 'cache_clear':
      applyCacheEpoch(ev.epoch, onCacheCleared);
      break;
    case 'read':
      for (const m of S.messages.get(ev.by) || []) if (m.from === S.me.id && m.ts <= ev.up_to && !m.read_at) m.read_at = Date.now();
      if (S.chat === ev.by) renderMessages();
      break;
    case 'gread': {
      const g = S.groups.get(ev.group);
      const mem = g?.members.find((x) => x.id === ev.by);
      if (mem) mem.last_read = Math.max(mem.last_read || 0, ev.up_to);
      if (ev.by === S.me.id && g) { g.last_read = Math.max(g.last_read || 0, ev.up_to); g.unread = 0; renderList(); }
      if (S.chat === ev.group) renderMessages();
      break;
    }
    case 'viewed':
    case 'deleted':
      for (const list of S.messages.values()) {
        const m = list.find((x) => x.id === ev.id);
        if (m) { m.envelope = null; m[ev.type === 'viewed' ? 'viewed_at' : 'deleted_at'] = ev.at; }
      }
      S.decoded.delete(ev.id); S.dec.delete(ev.id); payloadNodes.delete(ev.id);
      cacheDel(ev.id);
      for (const c of [...S.contacts.values(), ...S.groups.values()]) if (c.last?.id === ev.id) { c.last.envelope = null; c.last[ev.type === 'viewed' ? 'viewed_at' : 'deleted_at'] = ev.at; }
      renderList();
      if (S.chat) renderMessages();
      break;
    case 'typing': onTyping(ev); break;
    case 'contact_update': loadContacts(); break;
    case 'group_update': loadGroups(); break;
    case 'presence': {
      const c = S.contacts.get(ev.id);
      if (c) c.online = ev.online;
      for (const g of S.groups.values()) for (const mm of g.members) if (mm.id === ev.id) mm.online = ev.online;
      renderList();
      if (S.chat) renderChatHeader();
      break;
    }
    case 'status_update':
    case 'status_view':
      statusEvent(ev).then(refreshNav);
      break;
    default: break;
  }
}

function sessionExpired() {
  setWsState('none');
  S.ws = null;
  renderLogin('Deine Sitzung ist abgelaufen. Bitte melde dich erneut an.');
}

export async function logout(wipe) {
  await disablePush().catch(() => {});
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* trotzdem lokal abmelden */ }
  const ws = S.ws; S.ws = null; ws?.close(); setWsState('none');
  if (wipe) await store.wipe();
  for (const b of S.blobs.values()) URL.revokeObjectURL(b.url);
  S.blobs.clear(); S.decoded.clear(); S.dec?.clear(); payloadNodes.clear(); msgNodes.clear(); rowNodes.clear();
  S.keys = null; S.me = null;
  renderLogin(wipe ? 'Abgemeldet. Schlüssel und Verlauf wurden von diesem Gerät entfernt.' : 'Abgemeldet.');
}

boot();
