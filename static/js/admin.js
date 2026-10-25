// Vela Admin (/admin): Nutzerverwaltung im laufenden Betrieb – dieselben Funktionen wie admin.py.
// Alle Texte kommen per DOM-API (kein innerHTML) in die Seite; Schreibaktionen verlangen einen 2FA-Code.
import { h, clear, icon, iconBtn, fmtBytes } from './util.js';
import { api, ApiError, BASE_PATH } from './api.js';
import { dialog, snackbar, field, button, confirm, switchRow } from './ui.js';

const root = document.getElementById('admin');
const st = { me: null, users: [], sel: new Set(), q: '', state: 'all', days: 30, tab: 'users' };
const STATE_LABEL = { active: 'Aktiv', blocked: 'Gesperrt', pending: 'Ausstehend' };
const CAT_LABEL = { text: 'Textnachrichten (ohne Anhang)', attachments: 'Nachrichten mit Anhang (Bild/Audio/Datei)', viewonce: 'Einmalansichten', status: 'Status' };
const ACTION_LABEL = {
  'user.block': 'Gesperrt', 'user.unblock': 'Entsperrt', 'user.logout': 'Abgemeldet', 'user.delete': 'Gelöscht',
  'user.purge': 'Inhalte gelöscht', 'maintenance.on': 'Wartung an', 'maintenance.off': 'Wartung aus',
  'stepup.failed': '2FA fehlgeschlagen', 'admins.grant': 'Admin erteilt', 'admins.revoke': 'Admin entzogen',
};

// ---------------------------------------------------------------- Helfer
const fmtDT = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
function ago(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 90) return 'gerade eben';
  if (s < 3600) return `vor ${Math.round(s / 60)} Min`;
  if (s < 86400) return `vor ${Math.round(s / 3600)} Std`;
  if (s < 7 * 86400) return `vor ${Math.round(s / 86400)} Tg`;
  return new Date(ts).toLocaleDateString('de-DE');
}
const seen = (u) => (u.online
  ? h('span', { class: 'online' }, h('i', { class: 'dot' }), 'online')
  : u.last_seen ? h('span', { title: fmtDT(u.last_seen) }, ago(u.last_seen)) : h('span', { class: 'muted' }, '–'));
const pill = (state) => h('span', { class: `pill ${state}` }, STATE_LABEL[state] || state);

// ---------------------------------------------------------------- Schreibaktionen mit Step-up
function stepUp() {
  const code = field({ label: '2FA-Code', name: 'code', autocomplete: 'one-time-code', attrs: { inputmode: 'numeric', maxlength: 7 } });
  const d = dialog({
    title: 'Bestätigung nötig', icon: 'lock',
    body: h('div', {}, h('p', {}, 'Gib den aktuellen Code deiner Authenticator-App ein. Danach sind Änderungen 5 Minuten lang freigeschaltet.'), code.wrap),
    actions: [{ label: 'Abbrechen', value: false }, {
      label: 'Bestätigen', primary: true, value: true,
      onClick: async () => {
        try { await api('/admin/stepup', { method: 'POST', body: { code: code.input.value.replace(/\s/g, '') } }); } catch (e) { code.setError(e.message); return false; }
      },
    }],
  });
  setTimeout(() => code.input.focus(), 60);
  code.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); d.el.querySelector('.btn.filled')?.click(); } });
  return d.done.then((v) => v === true);
}

async function write(path, body) {
  for (let attempt = 0; ; attempt++) {
    try { return await api(path, { method: 'POST', body }); } catch (e) {
      if (e instanceof ApiError && e.status === 403 && e.message === 'stepup' && attempt === 0) {
        if (!(await stepUp())) throw new Error('Abgebrochen');
        continue;
      }
      throw e;
    }
  }
}

function showResults(results, title) {
  const ok = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
  if (!bad.length) { snackbar(ok.length === 1 ? `${ok[0].username}: ${ok[0].msg}` : `${title}: ${ok.length} Nutzer`); return; }
  dialog({
    title: ok.length ? `${title}: ${ok.length} ok, ${bad.length} nicht möglich` : `${title}: nicht möglich`, icon: 'warn',
    body: h('ul', { class: 'fail-list' }, bad.map((r) => h('li', {}, h('b', {}, r.username), ': ', r.msg))),
    actions: [{ label: 'OK', primary: true }],
  });
}

async function bulk(path, ids, title) {
  try { showResults((await write(path, { ids })).results, title); } catch (e) { if (e.message !== 'Abgebrochen') snackbar(e.message); }
  await loadUsers();
}

const names = (ids) => ids.map((i) => st.users.find((u) => u.id === i)?.username || i.slice(0, 8));

// ---------------------------------------------------------------- Dialoge
async function blockDialog(ids) {
  if (await confirm('Nutzer sperren?', `${names(ids).join(', ')} wird sofort abgemeldet und kann sich nicht mehr anmelden, bis du entsperrst. Nachrichten bleiben erhalten.`, { ok: 'Sperren', danger: true, icon: 'lock' })) {
    bulk('/admin/users/block', ids, 'Gesperrt');
  }
}

function deleteDialog(ids) {
  const code = field({ label: 'Zur Bestätigung LÖSCHEN eintippen', name: 'confirm', autocomplete: 'off' });
  dialog({
    title: ids.length === 1 ? 'Nutzer endgültig löschen?' : `${ids.length} Nutzer endgültig löschen?`, icon: 'delete',
    body: h('div', {},
      h('p', {}, 'Konto, Kontakte, Nachrichten, Status und Dateien werden sofort vom Server gelöscht. Das kann nicht rückgängig gemacht werden.'),
      h('p', { class: 'small' }, names(ids).join(', ')), code.wrap),
    actions: [{ label: 'Abbrechen' }, {
      label: 'Endgültig löschen', tonal: true, danger: true,
      onClick: async () => {
        if (code.input.value.trim().toUpperCase() !== 'LÖSCHEN') { code.setError('Bitte LÖSCHEN eintippen'); return false; }
        await bulk('/admin/users/delete', ids, 'Gelöscht');
        st.sel.clear();
        renderTable();
      },
    }],
  });
}

function purgeDialog(ids) {
  const cb = {};
  const check = (key) => { cb[key] = h('input', { type: 'checkbox' }); return h('label', { class: 'check-row' }, cb[key], h('span', {}, CAT_LABEL[key])); };
  const scope = h('select', { class: 'select' }, [['all', 'Chats und Gruppen'], ['chats', 'Nur Einzelchats'], ['groups', 'Nur Gruppen']].map(([v, l]) => h('option', { value: v }, l)));
  const received = h('input', { type: 'checkbox' });
  const older = h('input', { type: 'number', min: 1, placeholder: 'alle' });
  const minMb = h('input', { type: 'number', min: 0, step: 'any', placeholder: '–' });
  const maxMb = h('input', { type: 'number', min: 0, step: 'any', placeholder: '–' });
  const preview = h('div', { class: 'preview', 'aria-live': 'polite' });
  const num = (el) => (el.value === '' ? null : Number(el.value));
  const payload = (dry) => ({
    ids, cats: Object.keys(cb).filter((k) => cb[k].checked), scope: scope.value, received: received.checked,
    older_than: num(older), min_mb: num(minMb), max_mb: num(maxMb), dry_run: dry,
  });
  const runPreview = async () => {
    const p = payload(true);
    if (!p.cats.length) { clear(preview, 'Bitte mindestens eine Kategorie wählen.'); return null; }
    const d = await api('/admin/users/purge-preview', { method: 'POST', body: p });
    const total = d.results.reduce((s, r) => s + Object.values(r.count).reduce((a, b) => a + b, 0), 0);
    clear(preview, d.results.map((r) => h('div', {}, h('b', {}, r.username), ': ',
      p.cats.map((c) => `${r.count[c]} × ${CAT_LABEL[c]}`).join(', '), ` (${fmtBytes(r.bytes)} Dateien)`)));
    return total;
  };
  dialog({
    title: 'Inhalte löschen', icon: 'delete',
    body: h('div', {},
      h('p', { class: 'small muted' }, `${names(ids).join(', ')} – das Konto bleibt bestehen. Nachrichten werden wie „Für alle löschen“ zu Platzhaltern, Dateien werden entfernt.`),
      h('div', { class: 'check-list' }, ['text', 'attachments', 'viewonce', 'status'].map(check)),
      h('p', { class: 'small muted' }, 'Bild, Audio und Datei sind Ende-zu-Ende-verschlüsselt und für den Server nicht unterscheidbar – näherungsweise hilft der Größenfilter.'),
      h('div', { class: 'dlg-grid' },
        h('label', {}, 'Bereich', scope),
        h('label', {}, 'Älter als (Tage)', older),
        h('label', {}, 'Anhang ab (MB)', minMb),
        h('label', {}, 'Anhang bis (MB)', maxMb)),
      h('label', { class: 'check-row' }, received, h('span', {}, 'Auch empfangene Nachrichten in Einzelchats (Standard: nur gesendete)')),
      preview),
    actions: [{ label: 'Abbrechen' },
      { label: 'Vorschau', onClick: async () => { try { await runPreview(); } catch (e) { clear(preview, e.message); } return false; } },
      {
        label: 'Löschen', tonal: true, danger: true,
        onClick: async () => {
          try {
            const total = await runPreview();
            if (total === null) return false;
            if (!total) return false;
            if (!(await confirm('Wirklich löschen?', `${total} Einträge werden unwiderruflich gelöscht.`, { ok: 'Löschen', danger: true }))) return false;
            showResults((await write('/admin/users/purge', payload(false))).results, 'Inhalte gelöscht');
          } catch (e) { if (e.message !== 'Abgebrochen') clear(preview, e.message); return false; }
          await loadUsers();
        },
      }],
  });
}

async function detailDialog(id) {
  let d;
  try { d = await api('/admin/users/' + id); } catch (e) { snackbar(e.message); return; }
  const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
  const c = d.content;
  dialog({
    title: d.username, icon: 'person',
    body: h('div', {},
      h('div', { class: 'row gap' }, pill(d.state), d.is_admin ? h('span', { class: 'pill admin' }, 'Admin') : null),
      h('dl', { class: 'kv' },
        kv('ID', h('span', { class: 'mono' }, d.id)), kv('E-Mail', d.email),
        kv('Zuletzt gesehen', d.online ? h('span', { class: 'online' }, h('i', { class: 'dot' }), 'online') : fmtDT(d.last_seen)),
        kv('Registriert', fmtDT(d.created_at)),
        kv('Letzte Anmeldung', `${fmtDT(d.last_login)} (${d.sessions} Sitzung${d.sessions === 1 ? '' : 'en'})`),
        kv('Schlüssel', `RSA-${d.key_bits} (Version ${d.key_version})`), kv('2FA', d.totp_enabled ? 'aktiv' : 'nein'),
        kv('Kontakte / Gruppen', `${d.contacts} / ${d.groups}`), kv('Nachrichten', d.messages),
        kv('Dateien', `${d.files} (${fmtBytes(d.file_bytes)})`),
        kv('Gesendete Inhalte', h('div', {}, Object.keys(CAT_LABEL).map((k) => h('div', {}, `${c[k]} × ${CAT_LABEL[k]}`))))),
      d.is_admin ? h('p', { class: 'small muted' }, 'Admin-Konten können hier nicht gesperrt oder gelöscht werden.') : null),
    actions: [{ label: 'Schließen' },
      !d.is_admin && (d.state === 'blocked'
        ? { label: 'Entsperren', onClick: () => bulk('/admin/users/unblock', [id], 'Entsperrt') }
        : { label: 'Sperren', onClick: () => blockDialog([id]) }),
      !d.is_admin && { label: 'Abmelden', onClick: () => bulk('/admin/users/logout', [id], 'Abgemeldet') },
      { label: 'Inhalte löschen …', onClick: () => purgeDialog([id]) },
      !d.is_admin && { label: 'Löschen …', danger: true, onClick: () => deleteDialog([id]) },
    ].filter(Boolean),
  });
}

function maintenanceDialog() {
  const m = st.me.maintenance;
  let on = m.on;
  const msg = field({ label: 'Text im Banner', name: 'msg', value: m.message || '', required: false, attrs: { maxlength: 200, placeholder: ' ' }, help: 'Leer = „Wartungsarbeiten“' });
  dialog({
    title: 'Wartungsmodus', icon: 'warn',
    body: h('div', {},
      h('p', { class: 'small muted' }, 'Zeigt allen Nutzern ein gelbes Banner, bis du den Modus ausschaltest. Der Server bleibt dabei bedienbar.'),
      switchRow({ label: 'Wartungsmodus aktiv', checked: on, onChange: (v) => { on = v; } }), msg.wrap),
    actions: [{ label: 'Abbrechen' }, {
      label: 'Speichern', primary: true,
      onClick: async () => {
        try { st.me.maintenance = await write('/admin/maintenance', { on, message: msg.input.value }); } catch (e) { if (e.message !== 'Abgebrochen') msg.setError(e.message); return false; }
        snackbar(on ? 'Wartungsmodus an' : 'Wartungsmodus aus');
        renderHead();
      },
    }],
  });
}

// ---------------------------------------------------------------- Ansicht
const el = {};

function build() {
  el.head = h('div', { class: 'admin-head' });
  el.tabs = h('div', { class: 'admin-tabs' });
  el.users = h('div', {});
  el.audit = h('div', { hidden: true });
  clear(root, h('div', { class: 'admin-wrap' }, el.head, el.tabs, el.users, el.audit));

  const search = h('input', { type: 'search', placeholder: 'Suchen (Name, E-Mail, ID) …', 'aria-label': 'Suchen' });
  let t = 0;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { st.q = search.value; loadUsers(); }, 250); });
  const filter = h('select', { class: 'select', 'aria-label': 'Filter', onchange: (e) => { st.state = e.target.value; days.hidden = st.state !== 'inactive'; loadUsers(); } },
    [['all', 'Alle'], ['active', 'Aktiv'], ['blocked', 'Gesperrt'], ['pending', 'Ausstehend'], ['admin', 'Admins'], ['inactive', 'Inaktiv seit …']].map(([v, l]) => h('option', { value: v }, l)));
  const days = h('input', { type: 'number', min: 1, value: String(st.days), hidden: true, 'aria-label': 'Tage', title: 'Tage', onchange: (e) => { st.days = Number(e.target.value) || 30; loadUsers(); } });
  el.count = h('span', { class: 'muted small' });
  el.sel = h('div', { class: 'admin-sel', hidden: true });
  el.table = h('div', { class: 'table-wrap' });
  clear(el.users,
    h('div', { class: 'admin-toolbar' }, search, filter, days, iconBtn('refresh', 'Aktualisieren', () => loadUsers()), el.count),
    el.sel, el.table);
  renderHead();
}

function renderHead() {
  const m = st.me.maintenance;
  clear(el.head,
    h('h1', {}, icon('shield', 26), 'Vela Admin', m.on ? h('span', { class: 'pill maint' }, 'Wartung an') : null),
    button(m.on ? 'Wartung beenden …' : 'Wartungsmodus …', { kind: 'tonal', icon: 'warn', onClick: maintenanceDialog }),
    h('a', { class: 'btn text', href: (BASE_PATH || '') + '/' }, 'Zur App'),
    h('span', { class: 'muted small' }, st.me.name));
  clear(el.tabs, [['users', 'Nutzer'], ['audit', 'Protokoll']].map(([k, l]) => h('button', {
    type: 'button', class: st.tab === k ? 'on' : '', onclick: () => { st.tab = k; el.users.hidden = k !== 'users'; el.audit.hidden = k !== 'audit'; renderHead(); if (k === 'audit') loadAudit(); },
  }, l)));
}

function renderSel() {
  const ids = [...st.sel];
  el.sel.hidden = !ids.length;
  if (!ids.length) return;
  clear(el.sel,
    h('span', { class: 'grow' }, `${ids.length} ausgewählt`),
    button('Sperren', { kind: 'text', icon: 'lock', onClick: () => blockDialog(ids) }),
    button('Entsperren', { kind: 'text', onClick: () => bulk('/admin/users/unblock', ids, 'Entsperrt') }),
    button('Abmelden', { kind: 'text', icon: 'logout', onClick: () => bulk('/admin/users/logout', ids, 'Abgemeldet') }),
    button('Inhalte löschen …', { kind: 'text', icon: 'delete', onClick: () => purgeDialog(ids) }),
    button('Löschen …', { kind: 'text', icon: 'delete', cls: 'danger', onClick: () => deleteDialog(ids) }),
    button('Aufheben', { kind: 'text', onClick: () => { st.sel.clear(); renderTable(); } }));
}

function renderTable() {
  const all = h('input', { type: 'checkbox', 'aria-label': 'Alle auswählen', checked: st.users.length > 0 && st.users.every((u) => st.sel.has(u.id)),
    onchange: (e) => { for (const u of st.users) e.target.checked ? st.sel.add(u.id) : st.sel.delete(u.id); renderTable(); } });
  const rows = st.users.map((u) => h('tr', { class: 'row' },
    h('td', {}, h('input', { type: 'checkbox', 'aria-label': `${u.username} auswählen`, checked: st.sel.has(u.id),
      onchange: (e) => { e.target.checked ? st.sel.add(u.id) : st.sel.delete(u.id); renderSel(); } })),
    h('td', { class: 'name', onclick: () => detailDialog(u.id) }, h('b', {}, u.username), u.is_admin ? h('span', { class: 'pill admin' }, 'Admin') : null,
      h('div', { class: 'small muted' }, u.email)),
    h('td', {}, pill(u.state)),
    h('td', {}, seen(u)),
    h('td', { class: 'hide-sm' }, fmtDT(u.created_at)),
    h('td', { class: 'hide-sm mono small' }, u.id.slice(0, 8))));
  clear(el.table, h('table', { class: 'admin-table' },
    h('thead', {}, h('tr', {}, h('th', {}, all), h('th', {}, 'Nutzer'), h('th', {}, 'Status'), h('th', {}, 'Zuletzt gesehen'),
      h('th', { class: 'hide-sm' }, 'Registriert'), h('th', { class: 'hide-sm' }, 'ID'))),
    h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { class: 'empty', colspan: 6 }, 'Keine Nutzer gefunden')))));
  el.count.textContent = `${st.users.length} Nutzer`;
  renderSel();
}

async function loadUsers() {
  try {
    const p = new URLSearchParams({ q: st.q, state: st.state, days: String(st.days) });
    st.users = (await api('/admin/users?' + p)).users;
    const ids = new Set(st.users.map((u) => u.id));
    for (const i of [...st.sel]) if (!ids.has(i)) st.sel.delete(i);
    renderTable();
  } catch (e) { snackbar(e.message); }
}

async function loadAudit() {
  try {
    const d = await api('/admin/audit?limit=200');
    const rows = d.entries.map((r) => h('tr', { class: 'row' },
      h('td', { class: 'small' }, fmtDT(r.ts)), h('td', {}, r.admin_name), h('td', {}, ACTION_LABEL[r.action] || r.action),
      h('td', {}, r.target), h('td', { class: 'small muted hide-sm' }, r.detail), h('td', { class: 'small mono hide-sm' }, r.ip)));
    clear(el.audit,
      h('p', {}, d.chain_ok
        ? h('span', { class: 'chain ok' }, icon('check', 18), `Protokoll unverändert (${d.total} Einträge, Hash-Kette in Ordnung)`)
        : h('span', { class: 'chain bad' }, icon('warn', 18), `Hash-Kette unterbrochen bei Eintrag ${d.broken_at} – das Protokoll wurde verändert!`)),
      h('div', { class: 'table-wrap' }, h('table', { class: 'admin-table' },
        h('thead', {}, h('tr', {}, ['Zeit', 'Admin', 'Aktion', 'Ziel', 'Details', 'IP'].map((t, i) => h('th', { class: i > 3 ? 'hide-sm' : '' }, t)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { class: 'empty', colspan: 6 }, 'Noch keine Einträge'))))));
  } catch (e) { snackbar(e.message); }
}

// ---------------------------------------------------------------- Start
function gate(title, text, linkText) {
  clear(root, h('div', { class: 'gate' }, h('h1', {}, title), h('p', { class: 'muted' }, text),
    linkText ? h('a', { class: 'btn filled', href: (BASE_PATH || '') + '/' }, linkText) : null));
}

async function boot() {
  try {
    st.me = await api('/admin/me');
  } catch (e) {
    if (e.status === 401) gate('Nicht angemeldet', 'Bitte melde dich zuerst in Vela an und öffne diese Seite danach erneut.', 'Zur Anmeldung');
    else if (e.status === 403) gate('Kein Zugriff', e.message === 'Kein Admin-Zugriff' ? 'Dieses Konto hat keine Admin-Rechte. Vergeben werden sie auf dem Server mit: python admin.py admins grant NAME' : e.message);
    else gate('Fehler', e.message);
    return;
  }
  build();
  await loadUsers();
  setInterval(() => { if (st.tab === 'users' && !document.hidden && !document.querySelector('dialog[open]')) loadUsers(); }, 30000);
}

boot();