// Gruppen: Erstellen, Gruppeninfo (Mitglieder, Admins, Bild, Beschreibung), Weiterleiten,
// verschwindende Nachrichten. Inhalte bleiben E2E-verschlüsselt (siehe app.js → sendPayload).
import { h, clear, icon, iconBtn } from './util.js';
import { api, BASE_PATH } from './api.js';
import { S } from './state.js';
import { dialog, confirm, snackbar, menu, progress, field, switchRow, button } from './ui.js';
import { squareJpeg } from './profile.js';

export const TTL_LABELS = { 0: 'Aus', 3600: '1 Stunde', 86400: '24 Stunden', 604800: '7 Tage', 7776000: '90 Tage' };

let ctx = null;
let panel = null; // { el, gid, body }
export function initGroups(c) { ctx = c; }

// ---------------------------------------------------------------- Personen-Auswahl
function picker(options, selected, { empty = 'Keine Kontakte verfügbar.' } = {}) {
  const search = h('input', { type: 'search', class: 'picker-search', placeholder: 'Suchen …', 'aria-label': 'Suchen' });
  const chips = h('div', { class: 'picker-chips' });
  const list = h('div', { class: 'picker-list', role: 'listbox', 'aria-multiselectable': 'true' });
  const render = () => {
    const q = search.value.trim().toLowerCase();
    clear(chips, [...selected].map((id) => {
      const o = options.find((x) => x.id === id);
      return o ? h('button', { type: 'button', class: 'pick-chip', onclick: () => { selected.delete(id); render(); } }, ctx.avatarEl(o, 22), ctx.titleOf(o), icon('close', 16)) : null;
    }));
    const shown = options.filter((o) => ctx.titleOf(o).toLowerCase().includes(q));
    clear(list, shown.length ? shown.map((o) => h('button', {
      type: 'button', role: 'option', 'aria-selected': String(selected.has(o.id)), class: 'pick-row' + (selected.has(o.id) ? ' on' : ''),
      onclick: () => { if (selected.has(o.id)) selected.delete(o.id); else selected.add(o.id); render(); },
    }, ctx.avatarEl(o, 40), h('div', { class: 'pick-text' }, h('div', { class: 'pick-name' }, ctx.titleOf(o)), o.sub ? h('div', { class: 'small muted' }, o.sub) : null),
    h('span', { class: 'pick-check' }, icon('check', 18)))) : h('p', { class: 'muted small center' }, empty));
    wrap.dispatchEvent(new CustomEvent('change'));
  };
  search.addEventListener('input', render);
  const wrap = h('div', { class: 'picker' }, search, chips, list);
  render();
  return wrap;
}

const acceptedContacts = () => [...S.contacts.values()].filter((c) => c.status === 'accepted' && !S.changed.has(c.id))
  .sort((a, b) => a.username.localeCompare(b.username));

// ---------------------------------------------------------------- Gruppe erstellen
export function createGroupDialog(preselect = []) {
  const contacts = acceptedContacts();
  const selected = new Set(preselect);
  const name = field({ label: 'Gruppenname', name: 'gname', attrs: { maxlength: 64 } });
  const desc = field({ label: 'Beschreibung (optional)', name: 'gdesc', required: false, attrs: { maxlength: 500 } });
  const count = h('div', { class: 'small muted' });
  const pick = picker(contacts, selected, { empty: 'Du hast noch keine Kontakte. Füge zuerst Kontakte hinzu – nur sie können in Gruppen eingeladen werden.' });
  const upd = () => { count.textContent = `${selected.size} ausgewählt · Nur angenommene Kontakte können hinzugefügt werden.`; };
  pick.addEventListener('change', upd); upd();
  const d = dialog({
    title: 'Neue Gruppe', icon: 'group', cls: 'wide-dialog',
    body: h('div', { class: 'create-group' }, name.wrap, desc.wrap, h('div', { class: 'group-label' }, icon('person_add', 18), ' Mitglieder'), count, pick,
      h('p', { class: 'small muted' }, icon('lock', 12), ' Nachrichten werden für jedes Mitglied einzeln Ende-zu-Ende-verschlüsselt. Gruppenname und Mitgliederliste sind für den Server sichtbar.')),
    actions: [
      { label: 'Abbrechen' },
      {
        label: 'Gruppe erstellen', primary: true, onClick: async () => {
          name.setError('');
          if (!name.input.value.trim()) { name.setError('Bitte einen Namen eingeben'); return false; }
          try {
            const g = await api('/groups', { method: 'POST', body: { name: name.input.value.trim(), description: desc.input.value.trim(), members: [...selected] } });
            await ctx.loadGroups();
            snackbar(`Gruppe „${g.name}“ erstellt`);
            setTimeout(() => ctx.openChat(g.id), 50);
          } catch (e) { name.setError(e.message); return false; }
        },
      },
    ],
  });
  setTimeout(() => name.input.focus(), 50);
  return d;
}

// ---------------------------------------------------------------- Mitglieder hinzufügen
function addMembersDialog(g) {
  const inGroup = new Set(g.members.map((m) => m.id));
  const options = acceptedContacts().filter((c) => !inGroup.has(c.id));
  const selected = new Set();
  dialog({
    title: 'Mitglieder hinzufügen', icon: 'person_add', cls: 'wide-dialog',
    body: picker(options, selected, { empty: 'Alle deine Kontakte sind bereits in der Gruppe.' }),
    actions: [
      { label: 'Abbrechen' },
      {
        label: 'Hinzufügen', primary: true, onClick: async () => {
          if (!selected.size) return false;
          try {
            await api(`/groups/${g.id}/members`, { method: 'POST', body: { members: [...selected] } });
            await ctx.loadGroups();
            snackbar(`${selected.size} ${selected.size === 1 ? 'Mitglied' : 'Mitglieder'} hinzugefügt`);
          } catch (e) { snackbar(e.message); return false; }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Gruppeninfo (Seitenpanel)
export function openGroupInfo(gid) {
  closeGroupInfo(true);
  const body = h('div', { class: 'side-body' });
  const el = h('div', { class: 'side-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Gruppeninfo' },
    h('header', { class: 'top-bar' }, iconBtn('close', 'Schließen', () => closeGroupInfo()), h('div', { class: 'app-title' }, 'Gruppeninfo')), body);
  const scrim = h('div', { class: 'side-scrim', onclick: () => closeGroupInfo() });
  document.body.append(scrim, el);
  requestAnimationFrame(() => { el.classList.add('open'); scrim.classList.add('open'); });
  panel = { el, scrim, gid, body };
  document.addEventListener('keydown', onPanelKey);
  renderInfo();
}

function onPanelKey(e) { if (e.key === 'Escape' && !document.querySelector('dialog[open], .menu-scrim')) closeGroupInfo(); }

export function closeGroupInfo(immediate = false) {
  if (!panel) return;
  const { el, scrim } = panel;
  panel = null;
  document.removeEventListener('keydown', onPanelKey);
  if (immediate) { el.remove(); scrim.remove(); return; }
  el.classList.remove('open'); scrim.classList.remove('open');
  setTimeout(() => { el.remove(); scrim.remove(); }, 260);
}

export function refreshGroupInfo() {
  if (!panel) return;
  if (!S.groups.has(panel.gid)) { closeGroupInfo(); return; }
  renderInfo();
}

async function uploadGroupAvatar(g, file) {
  const blob = await squareJpeg(file);
  const res = await fetch(`${BASE_PATH}/api/groups/${g.id}/avatar`, { method: 'POST', body: blob, credentials: 'same-origin', headers: { 'X-Requested-With': 'vela', 'Content-Type': 'image/jpeg' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || 'Hochladen fehlgeschlagen');
  await ctx.loadGroups();
}

function renderInfo() {
  const g = S.groups.get(panel.gid);
  if (!g) return;
  const admin = g.role === 'admin';
  const canEdit = admin || !g.only_admins;
  const scrollTop = panel.body.scrollTop;

  const avatarBtn = h('button', { class: 'profile-avatar', type: 'button', disabled: !canEdit, 'aria-label': 'Gruppenbild ändern', onclick: () => {
    const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    input.addEventListener('change', async () => {
      const f = input.files?.[0]; input.remove();
      if (f) { try { await uploadGroupAvatar(g, f); snackbar('Gruppenbild aktualisiert'); } catch (e) { snackbar(e.message); } }
    });
    document.body.append(input); input.click();
  } }, ctx.avatarEl(g, 104), canEdit ? h('span', { class: 'avatar-edit' }, icon('camera', 18)) : null);

  const nameInput = h('input', { class: 'about-input group-name-input', value: g.name, maxlength: 64, disabled: !canEdit, 'aria-label': 'Gruppenname' });
  const descInput = h('textarea', { class: 'group-desc-input', rows: 2, maxlength: 500, disabled: !canEdit, placeholder: canEdit ? 'Gruppenbeschreibung hinzufügen …' : 'Keine Beschreibung', 'aria-label': 'Gruppenbeschreibung' });
  descInput.value = g.description || '';
  const save = async (patch) => {
    try { await api(`/groups/${g.id}`, { method: 'PATCH', body: patch }); await ctx.loadGroups(); snackbar('Gespeichert'); } catch (e) { snackbar(e.message); }
  };
  nameInput.addEventListener('change', () => { const v = nameInput.value.trim(); if (v && v !== g.name) save({ name: v }); else nameInput.value = g.name; });
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') nameInput.blur(); });
  descInput.addEventListener('change', () => { if (descInput.value.trim() !== (g.description || '')) save({ description: descInput.value.trim() }); });

  const sorted = [...g.members].sort((a, b) => (a.id === S.me.id ? -1 : b.id === S.me.id ? 1 : 0) || (a.role === 'admin' ? -1 : 0) - (b.role === 'admin' ? -1 : 0) || a.username.localeCompare(b.username));
  const memberRows = sorted.map((m) => {
    const mine = m.id === S.me.id;
    const changed = S.changed.has(m.id);
    return h('button', { class: 'member-row', type: 'button', onclick: (e) => !mine && memberMenu(g, m, e.currentTarget) },
      h('div', { class: 'row-avatar' + (m.online ? ' online' : '') }, ctx.avatarEl(mine ? S.me : m, 42), h('span', { class: 'online-dot' })),
      h('div', { class: 'member-text' },
        h('div', { class: 'member-name' }, mine ? 'Du' : m.username, changed ? h('span', { class: 'warn-dot', title: 'Sicherheitsschlüssel geändert' }, icon('warn', 15)) : null,
          S.pins.get(m.id)?.verified ? h('span', { class: 'verified' }, icon('verified', 15)) : null),
        h('div', { class: 'small muted' }, m.about || (m.contact || mine ? '' : 'Kein Kontakt – Schlüssel über die Gruppe erhalten'))),
      m.role === 'admin' ? h('span', { class: 'role-chip' }, 'Admin') : null);
  });

  const section = (title, ic, ...children) => h('section', { class: 'settings-section' }, h('h3', {}, icon(ic, 18), title), ...children);
  clear(panel.body,
    h('div', { class: 'profile-card' }, avatarBtn, nameInput,
      h('div', { class: 'muted small' }, `Gruppe · ${g.members.length} Mitglieder · erstellt ${new Date(g.created_at).toLocaleDateString('de-DE')}`),
      descInput),
    h('div', { class: 'quick-actions' },
      quickAction('search', 'Suchen', () => { closeGroupInfo(); ctx.openChat(g.id).then(() => document.querySelector('.chat-bar .icon-btn[aria-label="In Chat suchen"]')?.click()); }),
      quickAction(g.muted ? 'bell' : 'mute', g.muted ? 'Ton an' : 'Stumm', async () => { g.muted = !g.muted; await api(`/groups/${g.id}/me`, { method: 'PATCH', body: { muted: g.muted } }); ctx.renderList(); ctx.renderChatHeader(true); renderInfo(); }),
      quickAction('timer', g.ttl ? TTL_LABELS[g.ttl] : 'Timer', () => ttlDialog(g)),
      admin ? quickAction('person_add', 'Hinzufügen', () => addMembersDialog(g)) : null),
    section(`${g.members.length} Mitglieder`, 'group',
      admin ? h('button', { class: 'member-row add', type: 'button', onclick: () => addMembersDialog(g) }, h('span', { class: 'add-circle' }, icon('person_add', 22)), h('div', { class: 'member-name' }, 'Mitglieder hinzufügen')) : null,
      memberRows),
    section('Einstellungen', 'settings',
      h('div', { class: 'info-row' }, icon('timer', 22), h('div', {}, h('div', {}, 'Verschwindende Nachrichten'), h('div', { class: 'small muted' }, g.ttl ? `Neue Nachrichten werden nach ${TTL_LABELS[g.ttl]} gelöscht` : 'Aus')),
        h('div', { class: 'spacer' }), button('Ändern', { kind: 'text', cls: 'small', onClick: () => ttlDialog(g) })),
      admin ? switchRow({ label: 'Nur Admins dürfen Gruppeninfo ändern', desc: 'Name, Beschreibung, Bild und Timer.', checked: g.only_admins, onChange: (v) => save({ only_admins: v }) }) : null),
    section('Verschlüsselung', 'lock',
      h('p', { class: 'small' }, 'Jede Nachricht wird auf dem Gerät des Absenders mit einem neuen AES-256-Schlüssel verschlüsselt; dieser wird für jedes Mitglied einzeln per RSA-OAEP gekapselt und signiert. Neue Mitglieder sehen keine älteren Nachrichten.'),
      h('p', { class: 'small muted' }, 'Für den Server sichtbar: Gruppenname, Beschreibung, Gruppenbild und Mitgliederliste. Prüfe die Sicherheitsnummer einzelner Mitglieder über ihr Menü.')),
    h('div', { class: 'danger-zone' },
      button('Gruppe verlassen', { kind: 'tonal', icon: 'logout', cls: 'danger wide', onClick: async () => { if (await ctx.leaveGroup(g)) closeGroupInfo(); } })));
  panel.body.scrollTop = scrollTop;
}

function quickAction(ic, label, onClick) {
  return h('button', { class: 'quick-action', type: 'button', onclick: onClick }, h('span', { class: 'qa-icon' }, icon(ic, 22)), h('span', {}, label));
}

function memberMenu(g, m, anchor) {
  const r = anchor.getBoundingClientRect();
  const admin = g.role === 'admin';
  const contact = S.contacts.get(m.id);
  const user = S.users.get(m.id) || m;
  menu([
    contact?.status === 'accepted' ? { icon: 'chat', label: `Nachricht an ${m.username}`, onClick: () => { closeGroupInfo(); ctx.openChat(m.id); } } : null,
    !contact ? { icon: 'person_add', label: 'Als Kontakt hinzufügen', onClick: async () => { try { await api('/contacts', { method: 'POST', body: { username: m.username } }); snackbar(`Anfrage an ${m.username} gesendet`); } catch (e) { snackbar(e.message); } } } : null,
    { icon: 'shield', label: 'Sicherheitsnummer prüfen', onClick: () => ctx.verifyDialog(user) },
    S.changed.has(m.id) ? { icon: 'key', label: 'Neuen Schlüssel akzeptieren', onClick: () => ctx.acceptNewKey(user) } : null,
    admin ? { icon: 'admin', label: m.role === 'admin' ? 'Admin-Rechte entziehen' : 'Zum Admin machen', onClick: async () => {
      try { await api(`/groups/${g.id}/members/${m.id}/role`, { method: 'PUT', body: { admin: m.role !== 'admin' } }); await ctx.loadGroups(); } catch (e) { snackbar(e.message); }
    } } : null,
    admin ? { icon: 'remove', label: 'Aus Gruppe entfernen', danger: true, onClick: async () => {
      if (!(await confirm(`${m.username} entfernen?`, `${m.username} erhält keine neuen Nachrichten aus „${g.name}“ mehr.`, { ok: 'Entfernen', danger: true }))) return;
      try { await api(`/groups/${g.id}/members/${m.id}`, { method: 'DELETE' }); await ctx.loadGroups(); snackbar(`${m.username} entfernt`); } catch (e) { snackbar(e.message); }
    } } : null,
  ], r.left + 40, r.bottom - 10, { header: h('div', { class: 'menu-header' }, ctx.avatarEl(m, 32), h('strong', {}, m.username)) });
}

// ---------------------------------------------------------------- Verschwindende Nachrichten
export function ttlDialog(c) {
  const group = c.kind === 'group';
  if (group && c.only_admins && c.role !== 'admin') { snackbar('Nur Admins dürfen den Timer ändern'); return; }
  let value = c.ttl || 0;
  const list = h('div', { class: 'radio-list', role: 'radiogroup' });
  const render = () => clear(list, Object.entries(TTL_LABELS).map(([k, label]) => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(Number(k) === value), class: 'radio-row' + (Number(k) === value ? ' on' : ''),
    onclick: () => { value = Number(k); render(); },
  }, h('span', { class: 'radio-dot' }), label)));
  render();
  dialog({
    title: 'Verschwindende Nachrichten', icon: 'timer',
    body: h('div', {}, h('p', {}, `Neue Nachrichten in ${group ? 'dieser Gruppe' : 'diesem Chat'} werden nach der gewählten Zeit für alle vom Server gelöscht und auf den Geräten ausgeblendet. Die Einstellung gilt für alle Teilnehmenden.`), list,
      h('p', { class: 'small muted' }, 'Hinweis: Empfänger können Inhalte vorher speichern oder fotografieren.')),
    actions: [
      { label: 'Abbrechen' },
      {
        label: 'Übernehmen', primary: true, onClick: async () => {
          if (value === (c.ttl || 0)) return;
          try {
            if (group) await api(`/groups/${c.id}`, { method: 'PATCH', body: { ttl: value } });
            else await api(`/contacts/${c.id}/ttl`, { method: 'PUT', body: { ttl: value } });
            c.ttl = value;
            ctx.renderList(); ctx.renderChatHeader(true); refreshGroupInfo();
          } catch (e) { snackbar(e.message); return false; }
        },
      },
    ],
  });
}

// ---------------------------------------------------------------- Weiterleiten
export function forwardDialog(m, payload) {
  const options = [
    ...[...S.contacts.values()].filter((c) => c.status === 'accepted' && !S.changed.has(c.id)).map((c) => ({ ...c, sub: 'Kontakt' })),
    ...[...S.groups.values()].map((g) => ({ ...g, sub: `Gruppe · ${g.members.length} Mitglieder` })),
  ].sort((a, b) => (b.last?.ts || 0) - (a.last?.ts || 0));
  const selected = new Set();
  const prog = progress({ value: 0 });
  prog.el.hidden = true;
  dialog({
    title: 'Weiterleiten an …', icon: 'forward', cls: 'wide-dialog',
    body: h('div', {}, picker(options, selected, { empty: 'Keine Chats verfügbar.' }), prog.el,
      h('p', { class: 'small muted' }, icon('lock', 12), ' Inhalte und Anhänge werden für jeden Empfänger neu verschlüsselt.')),
    actions: [
      { label: 'Abbrechen' },
      {
        label: 'Senden', primary: true, onClick: async () => {
          if (!selected.size) return false;
          prog.el.hidden = false;
          const targets = [...selected];
          const base = { ...payload, fwd: true };
          delete base.reply;
          let done = 0;
          try {
            let blob = null;
            if (payload.file) blob = (await ctx.getFile(payload.file)).blob;
            for (const t of targets) {
              let p = base, files = [];
              if (blob) {
                const meta = await ctx.uploadEncrypted(blob, null);
                p = { ...base, file: { ...meta, mime: payload.file.mime, name: payload.file.name } };
                files = [meta.id];
              }
              await ctx.sendPayload(t, p, { files });
              prog.set(++done / targets.length, `${done} / ${targets.length}`);
            }
            snackbar(`An ${targets.length} ${targets.length === 1 ? 'Chat' : 'Chats'} weitergeleitet`);
          } catch (e) { snackbar(e.message); return false; }
        },
      },
    ],
  });
}
