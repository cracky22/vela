// Vela – Hauptanwendung: Navigation, Chatliste, Chat (Einzel & Gruppe), Echtzeit, Medien.
// Ein "Gespräch" (conversation) ist entweder ein Kontakt (1:1) oder eine Gruppe; beide teilen
// sich dieselbe Darstellung. Aktualisierung über schlüsselbasierten DOM-Abgleich (kein Flackern).
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

// Ermittelt automatisch, ob wir unter /vela oder im Root laufen
const BASE_PATH = window.location.pathname.startsWith('/vela') ? '/vela' : '';

// ================================================================= Gespräche & Nutzer
S.groups = new Map();
S.users = new Map();   // alle bekannten Personen (Kontakte + Gruppenmitglieder)
S.changed = new Set(); // Nutzer, deren Schlüssel sich seit dem Anheften geändert hat
S.names = new Map();   // Namen ausgetretener Mitglieder (aus Systemnachrichten)
S.editing = null;

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
        h('div', { class: 'app-title' }, h('span', { class: 'brand-mini' }, icon('shield', 22)), 'Chats'),
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
    h('p', {}, 'Alle Nachrichten, Bilder, Dateien und Sprachnachrichten – auch in Gruppen – werden auf deinem Gerät verschlüsselt (RSA-OAEP + AES-256-GCM) und erst bei den Empfängern entschlüsselt.'),
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
        : S.tab === 'groups' ? 'Noch keine Gruppen. Erstelle eine Gruppe mit deinen Kontakten – alle Nachrichten bleiben Ende-zu-Ende-verschlüsselt.'
          : 'Noch keine Chats. Füge einen Kontakt über seinen Nutzernamen hinzu – nach der Annahme werden eure öffentlichen Schlüssel ausgetauscht.';
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
        }
      }
    ]
  });
  d.show();
}