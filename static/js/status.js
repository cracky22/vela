// Status: 24-Stunden-Beiträge (Text oder Foto), Ende-zu-Ende-verschlüsselt für alle Kontakte.
// Ein Beitrag = ein Umschlag mit einem AES-Schlüssel, der für jeden Kontakt (und mich) per
// RSA-OAEP gekapselt und mit ECDSA signiert ist – dieselbe Kryptografie wie bei Nachrichten.
import { h, clear, icon, iconBtn, randomId, fmtTime } from './util.js';
import { api } from './api.js';
import { sealMessage, openMessage, importSigPub } from './crypto.js';
import { S } from './state.js';
import { dialog, confirm, snackbar, progress } from './ui.js';
import { prepareImage } from './media.js';

const BACKGROUNDS = [
  ['#00897b', '#004d40'], ['#5c6bc0', '#283593'], ['#e65100', '#bf360c'], ['#8e24aa', '#4a148c'],
  ['#2e7d32', '#1b5e20'], ['#c2185b', '#880e4f'], ['#37474f', '#102027'],
];
const DURATION = { text: 5500, image: 6500 };

let ctx = null;
let statuses = [];
const decCache = new Map();

export function initStatus(c) { ctx = c; }

export async function loadStatuses() {
  statuses = await api('/status');
  const ids = new Set(statuses.map((s) => s.id));
  for (const k of [...decCache.keys()]) if (!ids.has(k)) decCache.delete(k);
  return statuses;
}

export const hasUnseenStatus = () => statuses.some((s) => s.user_id !== S.me?.id && !s.seen);

export async function statusEvent() {
  await loadStatuses().catch(() => {});
  if (S.view === 'status') renderStatusView();
}

function grouped() {
  const map = new Map();
  for (const s of statuses) {
    if (!map.has(s.user_id)) map.set(s.user_id, []);
    map.get(s.user_id).push(s);
  }
  return map;
}

function userOf(id) {
  if (id === S.me.id) return S.me;
  return S.contacts.get(id) || { id, username: '?' };
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'gerade eben';
  if (m < 60) return `vor ${m} Min.`;
  const hh = Math.floor(m / 60);
  return hh < 24 ? `vor ${hh} Std.` : fmtTime(ts);
}

function decodeStatus(s) {
  if (decCache.has(s.id)) return decCache.get(s.id);
  const p = (async () => {
    try {
      let spki;
      if (s.user_id === S.me.id) spki = S.keys.sigPubB64;
      else {
        const pin = S.pins.get(s.user_id);
        if (!pin) throw new Error('Kein Schlüssel für diesen Kontakt');
        const kv = JSON.parse(s.envelope).kv || 1;
        spki = pin.history?.[kv] || pin.sigPub;
      }
      const { payload } = await openMessage({ envelope: s.envelope, id: s.id, from: s.user_id, to: 'status', me: S.me.id, decKey: S.keys.encPriv, verifyKey: await importSigPub(spki) });
      return { payload };
    } catch (e) { return { error: e.message || 'Nicht entschlüsselbar' }; }
  })();
  decCache.set(s.id, p);
  return p;
}

// Ring um den Avatar: ein Segment pro Beitrag, ungesehene in Primärfarbe
function ring(list, size) {
  const n = list.length;
  const gap = n > 1 ? 6 : 0;
  const seg = 360 / n;
  const stops = list.map((s, i) => {
    const col = s.user_id === S.me.id || s.seen ? 'var(--outline-variant)' : 'var(--primary)';
    const a = i * seg + gap / 2, b = (i + 1) * seg - gap / 2;
    return `transparent ${i * seg}deg ${a}deg, ${col} ${a}deg ${b}deg, transparent ${b}deg ${(i + 1) * seg}deg`;
  }).join(', ');
  const wrap = h('div', { class: 'story-ring', style: { width: size + 8 + 'px', height: size + 8 + 'px', background: `conic-gradient(${stops})` } });
  wrap.append(ctx.avatarEl(userOf(list[0].user_id), size));
  return wrap;
}

// ---------------------------------------------------------------- Liste
export function renderStatusView() {
  const root = ctx.root();
  if (!root || !S.me) return;
  const groups = grouped();
  const mine = groups.get(S.me.id) || [];
  const others = [...groups.entries()].filter(([uid]) => uid !== S.me.id && S.contacts.get(uid));
  const latest = (list) => list[list.length - 1].ts;
  const unseen = others.filter(([, l]) => l.some((s) => !s.seen)).sort((a, b) => latest(b[1]) - latest(a[1]));
  const seen = others.filter(([, l]) => l.every((s) => s.seen)).sort((a, b) => latest(b[1]) - latest(a[1]));

  const row = (uid, list, title, sub, onClick, extra) => h('button', { class: 'status-row', type: 'button', onclick: onClick },
    list.length ? ring(list, 52) : h('div', { class: 'story-ring empty' }, ctx.avatarEl(userOf(uid), 52), h('span', { class: 'add-badge' }, icon('add', 16))),
    h('div', { class: 'row-text' }, h('div', { class: 'row-title' }, title), h('div', { class: 'row-sub' }, sub)), extra || null);

  const myRow = row(S.me.id, mine, 'Mein Status',
    mine.length ? `${mine.length} ${mine.length === 1 ? 'Update' : 'Updates'} · ${ago(latest(mine))}` : 'Tippe, um ein Update zu teilen',
    () => (mine.length ? openStory([S.me.id], 0) : createMenu()));

  const section = (title, items) => (items.length ? [h('h3', { class: 'list-heading' }, title), items.map(([uid, list]) => row(uid, list, userOf(uid).username, ago(latest(list)),
    () => openStory(items.map(([u]) => u), items.findIndex(([u]) => u === uid))))] : []);

  clear(root,
    h('header', { class: 'top-bar' }, h('div', { class: 'app-title' }, 'Status'), h('div', { class: 'spacer' }),
      iconBtn('edit', 'Text-Status', () => composeText(), 'hide-compact'), iconBtn('camera', 'Foto-Status', () => pickPhoto(), 'hide-compact')),
    h('div', { class: 'status-list' },
      myRow,
      mine.length ? h('div', { class: 'status-actions' },
        h('button', { class: 'btn tonal small', type: 'button', onclick: () => composeText() }, icon('edit', 18), 'Text'),
        h('button', { class: 'btn tonal small', type: 'button', onclick: () => pickPhoto() }, icon('camera', 18), 'Foto')) : null,
      section('Neue Updates', unseen), section('Angesehen', seen),
      !others.length ? h('div', { class: 'list-empty' }, h('div', { class: 'empty-icon small' }, icon('status', 32)),
        h('p', {}, 'Noch keine Status-Updates von deinen Kontakten. Teile, was gerade los ist – nur deine Kontakte sehen es, und nach 24 Stunden ist es weg.')) : null,
      h('p', { class: 'status-note' }, icon('lock', 14), ' Status-Updates sind Ende-zu-Ende-verschlüsselt und verschwinden nach 24 Stunden.')),
    h('div', { class: 'fab-stack show-compact' },
      h('button', { class: 'fab small', type: 'button', 'aria-label': 'Text-Status', onclick: () => composeText() }, icon('edit', 22)),
      h('button', { class: 'fab', type: 'button', 'aria-label': 'Foto-Status', onclick: () => pickPhoto() }, icon('camera'))));
}

function createMenu() {
  dialog({
    title: 'Status teilen', icon: 'status',
    body: h('div', { class: 'create-choice' },
      h('p', {}, 'Nur deine angenommenen Kontakte sehen deinen Status. Nach 24 Stunden wird er automatisch gelöscht.')),
    actions: [
      { label: 'Abbrechen' },
      { label: 'Text', tonal: true, onClick: () => { setTimeout(composeText, 60); } },
      { label: 'Foto', primary: true, onClick: () => { setTimeout(pickPhoto, 60); } },
    ],
  });
}

// ---------------------------------------------------------------- Erstellen
async function publish(payload, fileIds = []) {
  const id = randomId();
  const recipients = [{ id: S.me.id, encPub: S.keys.encPubB64 }, ...ctx.contactsWithKeys()];
  const envelope = await sealMessage({ id, from: S.me.id, to: 'status', payload, recipients, signKey: S.keys.sigPriv, kv: S.me.key_version });
  await api('/status', { method: 'POST', body: { id, envelope, files: fileIds } });
  decCache.set(id, Promise.resolve({ payload }));
  await loadStatuses();
  renderStatusView();
  ctx.refreshNav();
  snackbar(recipients.length > 1 ? `Status geteilt – sichtbar für ${recipients.length - 1} ${recipients.length === 2 ? 'Kontakt' : 'Kontakte'}` : 'Status geteilt – füge Kontakte hinzu, damit ihn jemand sieht');
}

function composeText() {
  let bg = Math.floor(Math.random() * BACKGROUNDS.length);
  const ta = h('textarea', { class: 'story-input', maxlength: 700, placeholder: 'Was gibt’s Neues?', 'aria-label': 'Status-Text' });
  const counter = h('span', { class: 'story-counter' }, '0/700');
  const sendBtn = h('button', { class: 'story-send', type: 'button', 'aria-label': 'Status teilen', disabled: true }, icon('send'));
  const overlay = h('div', { class: 'story-compose', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Text-Status' },
    h('div', { class: 'story-compose-bar' },
      iconBtn('close', 'Abbrechen', () => close()), h('div', { class: 'spacer' }),
      iconBtn('palette', 'Hintergrund wechseln', () => { bg = (bg + 1) % BACKGROUNDS.length; paint(); })),
    h('div', { class: 'story-compose-stage' }, ta),
    h('div', { class: 'story-compose-foot' }, h('span', { class: 'story-privacy' }, icon('lock', 14), ' Ende-zu-Ende-verschlüsselt · 24 h'), counter, sendBtn));
  const paint = () => { overlay.style.background = `linear-gradient(160deg, ${BACKGROUNDS[bg][0]}, ${BACKGROUNDS[bg][1]})`; };
  const fit = () => {
    const len = ta.value.length;
    ta.style.fontSize = len < 60 ? '34px' : len < 160 ? '26px' : len < 360 ? '21px' : '18px';
    counter.textContent = `${len}/700`;
    sendBtn.disabled = !ta.value.trim();
  };
  ta.addEventListener('input', fit);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { overlay.classList.add('closing'); document.removeEventListener('keydown', onKey); setTimeout(() => overlay.remove(), 180); }
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    sendBtn.classList.add('busy');
    try { await publish({ t: 'text', body: ta.value.trim(), bg }); close(); } catch (e) { snackbar(e.message); sendBtn.disabled = false; sendBtn.classList.remove('busy'); }
  });
  document.addEventListener('keydown', onKey);
  paint(); fit();
  document.body.append(overlay);
  setTimeout(() => ta.focus(), 80);
}

function pickPhoto() {
  const input = h('input', { type: 'file', accept: 'image/*', hidden: true });
  input.addEventListener('change', () => { const f = input.files?.[0]; input.remove(); if (f) composePhoto(f); });
  document.body.append(input);
  input.click();
}

async function composePhoto(file) {
  let img;
  try { img = await prepareImage(file); } catch (e) { snackbar(e.message); return; }
  const url = URL.createObjectURL(img.blob);
  const caption = h('input', { class: 'story-caption-input', maxlength: 200, placeholder: 'Bildunterschrift hinzufügen …', 'aria-label': 'Bildunterschrift' });
  const prog = progress({ value: 0, cls: 'story-upload' });
  prog.el.hidden = true;
  const sendBtn = h('button', { class: 'story-send', type: 'button', 'aria-label': 'Status teilen' }, icon('send'));
  const overlay = h('div', { class: 'story-compose photo', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Foto-Status' },
    h('div', { class: 'story-compose-bar' }, iconBtn('close', 'Abbrechen', () => close()), h('div', { class: 'spacer' })),
    h('div', { class: 'story-compose-stage' }, h('img', { src: url, alt: 'Vorschau' })),
    prog.el,
    h('div', { class: 'story-compose-foot' }, caption, sendBtn));
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { overlay.classList.add('closing'); document.removeEventListener('keydown', onKey); setTimeout(() => { overlay.remove(); URL.revokeObjectURL(url); }, 180); }
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true; prog.el.hidden = false;
    try {
      const u = { prog, cancel: new AbortController() };
      const meta = await ctx.uploadEncrypted(img.blob, u);
      S.blobs.set(meta.id, { blob: img.blob, url: URL.createObjectURL(img.blob) });
      await publish({ t: 'image', file: { ...meta, mime: img.mime, name: 'status.jpg' }, w: img.width, h: img.height, thumb: img.thumb, caption: caption.value.trim() }, [meta.id]);
      close();
    } catch (e) { snackbar(e.message); sendBtn.disabled = false; prog.el.hidden = true; }
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
}

// ---------------------------------------------------------------- Betrachter
function openStory(userOrder, userIdx) {
  const groups = grouped();
  let ui = userIdx, si = 0, raf = 0, startedAt = 0, elapsed = 0, paused = false, closed = false, duration = DURATION.text;
  const list = () => groups.get(userOrder[ui]) || [];
  // bei fremden Status mit dem ersten ungesehenen Beitrag beginnen
  const firstUnseen = () => { const i = list().findIndex((s) => !s.seen && s.user_id !== S.me.id); return i < 0 ? 0 : i; };
  si = firstUnseen();

  const bars = h('div', { class: 'story-bars' });
  const head = h('div', { class: 'story-head' });
  const stage = h('div', { class: 'story-stage' });
  const foot = h('div', { class: 'story-foot' });
  const overlay = h('div', { class: 'story', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Status', tabindex: -1 },
    bars, head, stage,
    h('button', { class: 'story-tap prev', type: 'button', 'aria-label': 'Vorheriger Status', onclick: () => prev() }),
    h('button', { class: 'story-tap next', type: 'button', 'aria-label': 'Nächster Status', onclick: () => next() }),
    foot);

  function close() {
    if (closed) return;
    closed = true;
    cancelAnimationFrame(raf);
    overlay.classList.add('closing');
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
    setTimeout(() => overlay.remove(), 200);
    renderStatusView();
    ctx.refreshNav();
  }
  function next() {
    if (si < list().length - 1) { si++; show(); return; }
    if (ui < userOrder.length - 1) { ui++; si = firstUnseen(); show(); return; }
    close();
  }
  function prev() {
    if (si > 0) { si--; show(); return; }
    if (ui > 0) { ui--; si = list().length - 1; show(); return; }
    elapsed = 0; startedAt = performance.now();
  }
  function loop() {
    if (closed) return;
    const now = performance.now();
    const t = paused ? elapsed : elapsed + (now - startedAt);
    const fill = bars.children[si]?.firstChild;
    if (fill) fill.style.width = Math.min(100, (t / duration) * 100) + '%';
    if (!paused && t >= duration) { next(); return; }
    raf = requestAnimationFrame(loop);
  }
  function pause() { if (!paused) { paused = true; elapsed += performance.now() - startedAt; overlay.classList.add('paused'); } }
  function resume() { if (paused) { paused = false; startedAt = performance.now(); overlay.classList.remove('paused'); } }

  async function show() {
    cancelAnimationFrame(raf);
    const items = list();
    const s = items[si];
    if (!s) { close(); return; }
    const u = userOf(s.user_id);
    const mine = s.user_id === S.me.id;
    clear(bars, items.map((_, i) => h('div', { class: 'seg' }, h('div', { class: 'seg-fill', style: { width: i < si ? '100%' : '0%' } }))));
    clear(head, ctx.avatarEl(u, 38), h('div', { class: 'story-who' }, h('strong', {}, mine ? 'Mein Status' : u.username), h('span', {}, ago(s.ts))),
      h('div', { class: 'spacer' }),
      mine ? iconBtn('delete', 'Status löschen', async () => {
        pause();
        if (await confirm('Status löschen?', 'Der Beitrag wird sofort für alle gelöscht.', { ok: 'Löschen', danger: true })) {
          try { await api('/status/' + s.id, { method: 'DELETE' }); await loadStatuses(); groups.clear(); for (const [k, v] of grouped()) groups.set(k, v); if (!list().length) { close(); return; } si = Math.min(si, list().length - 1); show(); } catch (e) { snackbar(e.message); resume(); }
        } else resume();
      }) : null,
      iconBtn('close', 'Schließen', () => close()));
    clear(stage, h('div', { class: 'story-loading' }, progress({ value: null }).el));
    elapsed = 0; paused = false; overlay.classList.remove('paused');
    const d = await decodeStatus(s);
    if (closed || list()[si] !== s) return;
    if (d.error) {
      clear(stage, h('div', { class: 'story-text' }, h('p', {}, '⚠ ' + d.error)));
      duration = 3000;
    } else if (d.payload.t === 'image') {
      duration = DURATION.image;
      const img = h('img', { alt: d.payload.caption || 'Status-Foto', draggable: false });
      if (d.payload.thumb) stage.style.backgroundImage = `url("${d.payload.thumb}")`;
      clear(stage, h('div', { class: 'story-photo' }, img), d.payload.caption ? h('div', { class: 'story-caption' }, d.payload.caption) : null);
      paused = true; overlay.classList.add('paused');
      try {
        const f = await ctx.getFile(d.payload.file);
        img.src = f.url;
        await img.decode().catch(() => {});
      } catch (e) { clear(stage, h('div', { class: 'story-text' }, h('p', {}, '⚠ ' + e.message))); }
      if (closed) return;
      paused = false; overlay.classList.remove('paused');
    } else {
      duration = Math.max(DURATION.text, Math.min(12000, 3000 + d.payload.body.length * 45));
      stage.style.backgroundImage = '';
      const [a, b] = BACKGROUNDS[d.payload.bg % BACKGROUNDS.length] || BACKGROUNDS[0];
      const len = d.payload.body.length;
      clear(stage, h('div', { class: 'story-text', style: { background: `linear-gradient(160deg, ${a}, ${b})` } },
        h('p', { style: { fontSize: len < 60 ? '34px' : len < 160 ? '26px' : len < 360 ? '21px' : '18px' } }, d.payload.body)));
    }
    renderFoot(s, d, mine);
    startedAt = performance.now();
    raf = requestAnimationFrame(loop);
    if (!mine && !s.seen) {
      s.seen = true;
      api(`/status/${s.id}/view`, { method: 'POST' }).catch(() => {});
    }
  }

  function renderFoot(s, d, mine) {
    if (mine) {
      clear(foot, h('button', { class: 'story-views', type: 'button', onclick: () => showViews(s) }, icon('eye1', 20), ` ${s.views ?? 0} ${s.views === 1 ? 'Aufruf' : 'Aufrufe'}`));
      return;
    }
    const input = h('input', { class: 'story-reply', placeholder: 'Antworten …', maxlength: 2000, 'aria-label': 'Auf Status antworten' });
    const send = iconBtn('send', 'Antwort senden', () => sendReply());
    input.addEventListener('focus', pause);
    input.addEventListener('blur', () => { if (!input.value) resume(); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); sendReply(); } });
    async function sendReply() {
      const text = input.value.trim();
      if (!text) return;
      const snippet = d.payload ? (d.payload.t === 'image' ? '📷 Status-Foto' : 'Status: ' + d.payload.body).slice(0, 100) : 'Status';
      try {
        await ctx.sendPayload(s.user_id, { t: 'text', body: text, reply: { id: s.id, from: s.user_id, snippet } });
        input.value = '';
        input.blur();
        snackbar('Antwort gesendet');
      } catch (e) { snackbar(e.message); }
    }
    clear(foot, h('div', { class: 'story-reply-wrap' }, input, send));
  }

  async function showViews(s) {
    pause();
    try {
      const d = await api(`/status/${s.id}/views`);
      await dialog({
        title: `${d.total} ${d.total === 1 ? 'Aufruf' : 'Aufrufe'}`, icon: 'eye1',
        body: h('div', { class: 'viewer-list' },
          d.viewers.length ? d.viewers.map((v) => h('div', { class: 'viewer-item' }, ctx.avatarEl(userOf(v.id), 36), h('div', {}, h('strong', {}, v.username), h('div', { class: 'small muted' }, ago(v.viewed_at)))))
            : h('p', { class: 'muted' }, 'Noch keine Aufrufe angezeigt.'),
          d.total > d.viewers.length ? h('p', { class: 'small muted' }, `${d.total - d.viewers.length} weitere Personen haben Lesebestätigungen deaktiviert.`) : null),
        actions: [{ label: 'OK', primary: true }],
      }).done;
    } catch (e) { snackbar(e.message); }
    resume();
  }

  // Gedrückt halten = pausieren, nach unten wischen = schließen
  let downY = 0, downT = 0, holdTimer = 0;
  overlay.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.story-foot, .story-head')) return;
    downY = e.clientY; downT = performance.now();
    holdTimer = setTimeout(pause, 180);
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!downT) return;
    const dy = e.clientY - downY;
    if (dy > 0) overlay.style.transform = `translateY(${dy * 0.6}px) scale(${1 - Math.min(dy, 300) / 1500})`;
  });
  const up = (e) => {
    if (!downT) return;
    clearTimeout(holdTimer);
    const dy = e.clientY - downY, held = performance.now() - downT > 180;
    downT = 0;
    overlay.style.transform = '';
    if (dy > 120) { close(); return; }
    if (held) { resume(); e.preventDefault(); overlay.dataset.suppress = '1'; setTimeout(() => delete overlay.dataset.suppress, 50); }
  };
  overlay.addEventListener('pointerup', up);
  overlay.addEventListener('pointercancel', up);
  overlay.addEventListener('click', (e) => { if (overlay.dataset.suppress && e.target.closest('.story-tap')) { e.stopPropagation(); e.preventDefault(); } }, true);
  const onKey = (e) => {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') close();
    else if (e.key === 'ArrowRight') next();
    else if (e.key === 'ArrowLeft') prev();
    else if (e.key === ' ' && !e.target.closest('input')) { e.preventDefault(); paused ? resume() : pause(); }
  };
  const onVis = () => (document.hidden ? pause() : resume());
  document.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', onVis);
  document.body.append(overlay);
  overlay.focus();
  show();
}
