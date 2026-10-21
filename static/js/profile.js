// Profil & Einstellungen (Navigationspunkt „Profil“): Profilbild, Info-Text, Sicherheit,
// Privatsphäre, Transkription, Benachrichtigungen, Darstellung, DSGVO.
import { h, clear, icon } from './util.js';
import { api } from './api.js';
import { shortFingerprint } from './crypto.js';
import * as store from './store.js';
import { S } from './state.js';
import { dialog, snackbar, menu, progress, field, switchRow, button } from './ui.js';
import { startRotate } from './auth.js';
import { MODELS, transcriptionStatus, installModel, waitForInstall } from './transcribe.js';

let ctx = null;
let container = null;
export function initProfile(c) { ctx = c; }

// ---------------------------------------------------------------- Profilbild
async function squareJpeg(file, size = 512) {
  let bmp;
  try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch {
    const url = URL.createObjectURL(file);
    try { const img = new Image(); img.src = url; await img.decode(); bmp = img; } finally { URL.revokeObjectURL(url); }
  }
  const side = Math.min(bmp.width, bmp.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, size, size);
  g.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, size, size);
  bmp.close?.();
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht verarbeitet werden'))), 'image/jpeg', 0.86));
}

async function uploadAvatar(file) {
  const blob = await squareJpeg(file); // neu kodiert: entfernt EXIF/GPS
  const res = await fetch('/api/me/avatar', { method: 'POST', body: blob, credentials: 'same-origin', headers: { 'X-Requested-With': 'vela', 'Content-Type': 'image/jpeg' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'Hochladen fehlgeschlagen');
  S.me.avatar_version = data.avatar_version;
}

function avatarMenu(anchor) {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', async () => {
    const f = input.files?.[0];
    input.remove();
    if (!f) return;
    try {
      await uploadAvatar(f);
      snackbar('Profilbild aktualisiert');
      ctx.refreshNav();
      renderProfileView(container);
    } catch (e) { snackbar(e.message); }
  });
  document.body.append(input);
  const r = anchor.getBoundingClientRect();
  menu([
    { icon: 'image', label: 'Foto auswählen', onClick: () => input.click() },
    S.me.avatar_version ? { icon: 'delete', label: 'Profilbild entfernen', danger: true, onClick: async () => {
      try { const d = await api('/me/avatar', { method: 'DELETE' }); S.me.avatar_version = d.avatar_version; ctx.refreshNav(); renderProfileView(container); } catch (e) { snackbar(e.message); }
    } } : null,
  ], r.left, r.bottom, { header: h('div', { class: 'menu-header small muted' }, 'Sichtbar nur für deine Kontakte') });
}

// ---------------------------------------------------------------- Ansicht
export async function renderProfileView(root) {
  container = root;
  const fp = await shortFingerprint(S.keys.encPubB64, S.keys.sigPubB64);
  const section = (title, ic, ...children) => h('section', { class: 'settings-section' }, h('h3', {}, icon(ic, 18), title), ...children);
  const about = h('input', { class: 'about-input', value: S.me.about || '', maxlength: 140, placeholder: 'Info hinzufügen (z. B. „Verfügbar“)', 'aria-label': 'Info' });
  const aboutState = h('span', { class: 'about-state' });
  const saveAbout = async () => {
    if (about.value.trim() === (S.me.about || '')) return;
    try {
      const d = await api('/me/profile', { method: 'PUT', body: { about: about.value } });
      S.me.about = d.about; about.value = d.about;
      clear(aboutState, icon('check', 18)); aboutState.classList.add('ok');
      setTimeout(() => aboutState.classList.remove('ok'), 1600);
    } catch (e) { snackbar(e.message); }
  };
  about.addEventListener('blur', saveAbout);
  about.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); about.blur(); } });

  const avatarBtn = h('button', { class: 'profile-avatar', type: 'button', 'aria-label': 'Profilbild ändern', onclick: (e) => avatarMenu(e.currentTarget) },
    ctx.avatarEl(S.me, 104), h('span', { class: 'avatar-edit' }, icon('camera', 18)));

  const themeSeg = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': 'Design' });
  const renderTheme = () => clear(themeSeg, [['auto', 'System'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([k, l]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(S.prefs.theme === k), class: S.prefs.theme === k ? 'selected' : '',
    onclick: () => { S.prefs.theme = k; store.setPref('theme', k); ctx.applyTheme(k); renderTheme(); },
  }, S.prefs.theme === k ? icon('check', 18) : null, l)));
  renderTheme();

  const select = (opts, value, onChange, label) => h('select', { class: 'select', 'aria-label': label, onchange: (e) => onChange(e.target.value) },
    Object.entries(opts).map(([k, l]) => h('option', { value: k, selected: k === value }, l)));

  const tSlot = h('div', { class: 'transcription-slot' });

  clear(root,
    h('header', { class: 'top-bar' }, h('div', { class: 'app-title' }, 'Profil')),
    h('div', { class: 'settings-body' },
      h('div', { class: 'profile-card' }, avatarBtn,
        h('div', { class: 'profile-name' }, S.me.username),
        h('div', { class: 'muted small' }, S.me.email),
        h('label', { class: 'about-row' }, icon('edit', 18), about, aboutState)),
      section('Sicherheit', 'shield',
        h('div', { class: 'info-row' }, icon('key', 22), h('div', {}, h('div', {}, 'Dein Schlüssel-Fingerabdruck'), h('div', { class: 'mono small' }, fp),
          h('div', { class: 'small muted' }, `RSA-OAEP ${S.keys.bits} Bit · ECDSA P-256 · Schlüsselversion ${S.me.key_version}`))),
        h('div', { class: 'info-row' }, icon('verified', 22), h('div', {}, h('div', {}, 'Zwei-Faktor-Authentifizierung'), h('div', { class: 'small muted' }, 'Aktiv (Authenticator-App, TOTP)'))),
        h('div', { class: 'info-row' }, icon('lock', 22), h('div', {}, h('div', {}, 'Verbindung'), h('div', { class: 'small muted' }, location.protocol === 'https:' ? 'TLS-verschlüsselt (HTTPS/WSS)' : 'Ohne TLS – nur für localhost geeignet'))),
        button('Neue Schlüssel erzeugen …', { kind: 'text', icon: 'refresh', onClick: () => startRotate({ onCancel: () => ctx.enterApp() }) })),
      section('Privatsphäre', 'eye1',
        switchRow({ label: 'Lesebestätigungen senden', desc: 'Kontakte sehen, wann du ihre Nachrichten gelesen und ihren Status angesehen hast.', checked: S.me.settings.read_receipts, onChange: (v) => saveServerSettings({ read_receipts: v }) }),
        switchRow({ label: 'Tipp-Indikator senden', desc: '„schreibt …“ wird angezeigt, während du tippst.', checked: S.me.settings.typing_indicator, onChange: (v) => saveServerSettings({ typing_indicator: v }) }),
        switchRow({ label: 'Live-Typing', desc: 'Dein Gegenüber sieht deinen Text schon während des Tippens (Ende-zu-Ende-verschlüsselt, wird nicht gespeichert). Auch unfertige Sätze werden sichtbar.', checked: S.me.settings.live_typing, onChange: (v) => saveServerSettings({ live_typing: v }) }),
        h('p', { class: 'small muted' }, 'Profilbild und Info sehen nur deine angenommenen Kontakte. Sie sind auf dem Server nicht Ende-zu-Ende-verschlüsselt.')),
      section('Sprachnachrichten', 'mic',
        switchRow({ label: 'Transkription auf dem Gerät', desc: 'Sprachnachrichten werden lokal mit Whisper in Text umgewandelt. Das Audio verlässt dein Gerät nicht. Das Sprachmodell wird einmalig von deinem Vela-Server bereitgestellt.', checked: S.prefs.transcription, onChange: (v) => { S.prefs.transcription = v; store.setPref('transcription', v); renderTranscription(tSlot); } }),
        h('div', { class: 'select-row' }, h('label', {}, 'Modell'), select(MODELS, S.prefs.model, (v) => { S.prefs.model = v; store.setPref('model', v); renderTranscription(tSlot); }, 'Transkriptionsmodell')),
        h('div', { class: 'select-row' }, h('label', {}, 'Sprache'), select({ german: 'Deutsch', english: 'Englisch', auto: 'Automatisch erkennen' }, S.prefs.language, (v) => { S.prefs.language = v; store.setPref('language', v); }, 'Sprache')),
        tSlot),
      section('Benachrichtigungen', 'chat',
        switchRow({ label: 'Browser-Benachrichtigungen', desc: 'Nur „Neue Nachricht von …“ – niemals der Inhalt.', checked: S.prefs.notifications && window.Notification?.permission === 'granted', onChange: async (v) => {
          if (v && window.Notification) {
            const perm = await Notification.requestPermission();
            if (perm !== 'granted') { snackbar('Benachrichtigungen wurden im Browser nicht erlaubt'); v = false; }
          }
          S.prefs.notifications = v; store.setPref('notifications', v);
        } })),
      section('Darstellung', 'palette', themeSeg),
      section('Daten & Konto', 'person',
        h('p', { class: 'small muted' }, `Verschlüsselte Nachrichten und Dateien werden spätestens nach ${S.config.retention_days} Tagen vom Server gelöscht, Status nach 24 Stunden, Einmalansichten sofort nach dem Öffnen.`),
        button('Meine Daten exportieren (DSGVO)', { kind: 'text', icon: 'download', onClick: exportData }),
        button('Abmelden', { kind: 'text', icon: 'logout', onClick: logoutDialog }),
        button('Konto löschen …', { kind: 'text', icon: 'delete', cls: 'danger', onClick: deleteAccountDialog })),
      h('p', { class: 'small muted center' }, 'Vela · Referenzimplementierung · Web Crypto API')));
  renderTranscription(tSlot);
}

async function saveServerSettings(patch) {
  const next = { ...S.me.settings, ...patch };
  try { S.me.settings = await api('/me/settings', { method: 'PUT', body: next }); } catch (e) { snackbar(e.message); }
}

async function renderTranscription(slot) {
  if (!S.prefs.transcription) { clear(slot); return; }
  let st;
  try { st = await transcriptionStatus(); } catch (e) { clear(slot, h('p', { class: 'small error-text' }, e.message)); return; }
  const model = S.prefs.model;
  if (st.installed[model]) {
    clear(slot, h('div', { class: 'banner ok' }, icon('check', 20), h('span', {}, `${MODELS[model]} ist auf deinem Server installiert und einsatzbereit.`)));
    return;
  }
  const prog = progress({ value: st.state.running ? st.state.progress : 0 });
  const btn = button(st.state.running ? 'Wird heruntergeladen …' : 'Jetzt einrichten', { kind: 'tonal', icon: 'download', disabled: st.state.running });
  const run = async () => {
    btn.disabled = true;
    prog.el.hidden = false;
    try {
      if (!st.state.running) await installModel(model);
      await waitForInstall(model, (v, cur) => prog.set(v, `${Math.round(v * 100)} % · ${cur || ''}`));
      snackbar('Transkription ist eingerichtet');
      renderTranscription(slot);
      ctx.rerenderMessages();
    } catch (e) {
      prog.set(0, e.message);
      btn.disabled = false;
    }
  };
  btn.addEventListener('click', run);
  if (!st.state.running) prog.el.hidden = true;
  clear(slot, h('div', { class: 'banner info' }, icon('download', 20),
    h('span', {}, `Noch nicht eingerichtet: Dein Vela-Server lädt die Laufzeit und ${MODELS[model]} einmalig herunter (Transformers.js/jsDelivr, Hugging Face). Danach werden keine Drittanbieter mehr kontaktiert.`)),
  btn, prog.el, st.state.error ? h('p', { class: 'small error-text' }, st.state.error) : null);
  if (st.state.running) run();
}

async function exportData() {
  try {
    const res = await api('/me/export', { raw: true });
    if (!res.ok) throw new Error('Export fehlgeschlagen');
    const a = h('a', { href: URL.createObjectURL(await res.blob()), download: 'vela-datenexport.json' });
    document.body.append(a); a.click(); a.remove();
  } catch (e) { snackbar(e.message); }
}

function logoutDialog() {
  const cb = h('input', { type: 'checkbox', id: 'wipe' });
  dialog({
    title: 'Abmelden', icon: 'logout',
    body: h('div', {}, h('label', { class: 'check-row', for: 'wipe' }, cb, h('span', {}, 'Schlüssel und Nachrichtenverlauf von diesem Gerät entfernen (empfohlen auf fremden Geräten). Zum erneuten Anmelden brauchst du dann deinen Wiederherstellungsschlüssel.'))),
    actions: [{ label: 'Abbrechen' }, { label: 'Abmelden', primary: true, onClick: () => ctx.logout(cb.checked) }],
  });
}

function deleteAccountDialog() {
  const pw = field({ label: 'Passwort', name: 'pw', type: 'password', autocomplete: 'current-password' });
  const code = field({ label: '2FA-Code', name: 'code', autocomplete: 'one-time-code', attrs: { inputmode: 'numeric', maxlength: 7 } });
  dialog({
    title: 'Konto endgültig löschen?', icon: 'delete',
    body: h('div', {}, h('p', {}, 'Konto, Kontakte, alle verschlüsselten Nachrichten, Status und Dateien werden sofort vom Server gelöscht. Das kann nicht rückgängig gemacht werden.'), pw.wrap, code.wrap),
    actions: [{ label: 'Abbrechen' }, {
      label: 'Endgültig löschen', tonal: true, danger: true, onClick: async () => {
        try {
          await api('/me/delete', { method: 'POST', body: { password: pw.input.value, code: code.input.value.replace(/\s/g, '') } });
          await store.wipe();
          S.ws?.close(); S.ws = null;
          location.reload();
        } catch (e) { code.setError(e.message); return false; }
      },
    }],
  });
}

