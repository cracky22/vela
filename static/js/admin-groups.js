// Vela Admin – Gruppenübersicht: wer ist in welcher Gruppe, wer ist dort Admin?
// Drei Ansichten auf dieselben Daten: Karten, Netzwerk (Gruppen und Nutzer als Graph) und Matrix.
// Gruppen-Admins lassen sich in jeder Ansicht ernennen bzw. entziehen (Server: POST /api/admin/groups/role).
// Der Server kennt nur Metadaten (Name, Mitglieder, Rollen) – keine Nachrichteninhalte.
// Alle Texte kommen per DOM-API (kein innerHTML) in die Seite.
import { h, clear, icon, iconBtn, avatar, hue } from './util.js';
import { api } from './api.js';
import { snackbar, menu, dialog } from './ui.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const VIEWS = [['cards', 'Karten', 'group'], ['graph', 'Netzwerk', 'share'], ['matrix', 'Matrix', 'transcript']];
const MAX_CHIPS = 18;       // Mitglieder pro Karte, bevor „+ n weitere“ erscheint
const LABEL_LIMIT = 70;     // ab so vielen Knoten werden Nutzernamen im Netzwerk nur bei Hover gezeigt

// SVG-Elemente brauchen createElementNS – util.h() erzeugt nur HTML-Elemente.
function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'style' && typeof v === 'object') {
      for (const [a, b] of Object.entries(v)) el.style.setProperty(a, b);
    } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

const trunc = (t, n) => (t.length > n ? t.slice(0, n - 1) + '…' : t);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
function fmtTtl(sec) {
  if (!sec) return 'aus';
  if (sec < 3600) return `${Math.round(sec / 60)} Min`;
  if (sec < 86400) return `${Math.round(sec / 3600)} Std`;
  return plural(Math.round(sec / 86400), 'Tag', 'Tage');
}
const fmtDT = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');
// Menü an der Klickposition – bei Tastaturbedienung (clientX = 0) am Element
function pos(ev) {
  if (ev && (ev.clientX || ev.clientY)) return [ev.clientX, ev.clientY];
  const r = ev?.currentTarget?.getBoundingClientRect?.();
  return r ? [r.left, r.bottom] : [80, 120];
}

/**
 * @param {{ write: (path: string, body: object) => Promise<any>, openUser: (id: string) => void }} ctx
 *   write: POST mit 2FA-Step-up (aus admin.js), openUser: öffnet die Nutzer-Details
 */
export function createGroupsView({ write, openUser }) {
  const S = { groups: [], q: '', view: 'cards', sig: '', focus: null, loaded: false };
  const pos0 = new Map();                    // Knoten-ID -> {x, y}: Netzwerk-Layout bleibt beim Aktualisieren stabil
  let lastView = null;                       // Zoom/Ausschnitt des Netzwerks, bleibt beim Aktualisieren erhalten
  let stopGraph = () => {};                  // räumt die laufende Netzwerk-Animation auf
  const el = {};

  // ------------------------------------------------------------ Daten
  function index() {
    const users = new Map();
    for (const g of S.groups) {
      for (const m of g.members) {
        let u = users.get(m.id);
        if (!u) { u = { id: m.id, username: m.username, state: m.state, online: m.online, site_admin: m.site_admin, groups: [] }; users.set(m.id, u); }
        u.groups.push({ g, m });
      }
    }
    return { users };
  }
  const adminCount = (g) => g.members.filter((m) => m.role === 'admin').length;

  // ------------------------------------------------------------ Rollen ändern
  async function setRole(g, m, admin) {
    try {
      const r = await write('/admin/groups/role', { group_id: g.id, user_id: m.id, admin });
      snackbar(r.changed
        ? `${m.username} ist jetzt ${admin ? 'Admin' : 'normales Mitglied'} in „${g.name}“`
        : `${m.username} ist dort bereits ${admin ? 'Admin' : 'normales Mitglied'}`,
      r.changed ? { action: 'Rückgängig', onAction: () => setRole(g, m, !admin), timeout: 8000 } : {});
    } catch (e) { if (e.message !== 'Abgebrochen') snackbar(e.message); }
    await load(true);
  }

  function memberMenu(ev, g, m) {
    const isAdmin = m.role === 'admin';
    const [x, y] = pos(ev);
    menu([
      { icon: 'admin', label: isAdmin ? 'Gruppen-Admin entziehen' : 'Zum Gruppen-Admin ernennen', onClick: () => setRole(g, m, !isAdmin) },
      { icon: 'person', label: 'Nutzer-Details …', onClick: () => openUser(m.id) },
    ], x, y, { header: h('div', { class: 'menu-head' }, h('b', {}, m.username), ` in „${g.name}“ – ${isAdmin ? 'Gruppen-Admin' : 'Mitglied'}`) });
  }

  function groupDialog(g) {
    const kv = (k, v) => [h('dt', {}, k), h('dd', {}, v)];
    dialog({
      title: g.name, icon: 'group',
      body: h('div', {},
        g.description ? h('p', {}, g.description) : h('p', { class: 'small muted' }, 'Keine Beschreibung'),
        h('dl', { class: 'kv' },
          kv('ID', h('span', { class: 'mono' }, g.id)),
          kv('Mitglieder', `${g.members.length} (davon ${plural(adminCount(g), 'Admin', 'Admins')})`),
          kv('Erstellt', `${fmtDT(g.created_at)}${g.created_by_name ? ' von ' + g.created_by_name : ''}`),
          kv('Schreiben', g.only_admins ? 'nur Gruppen-Admins' : 'alle Mitglieder'),
          kv('Nachrichten-Timer', fmtTtl(g.ttl))),
        h('p', { class: 'small muted' }, 'Nachrichten sind Ende-zu-Ende-verschlüsselt – der Server sieht nur Mitglieder und Rollen.')),
      actions: [{ label: 'Schließen', primary: true }],
    });
  }

  // ------------------------------------------------------------ Kleine Bausteine
  const roleIcon = (size = 14) => h('span', { class: 'g-crown', title: 'Gruppen-Admin' }, icon('admin', size));

  function chip(g, m) {
    const isAdmin = m.role === 'admin';
    return h('button', {
      type: 'button', class: `g-chip${isAdmin ? ' admin' : ''}${m.state !== 'active' ? ' off' : ''}${m.online ? ' on' : ''}`,
      title: `${m.username} – ${isAdmin ? 'Gruppen-Admin' : 'Mitglied'}${m.state === 'blocked' ? ' (gesperrt)' : m.state === 'pending' ? ' (nicht aktiviert)' : ''}`,
      'aria-label': `${m.username}, ${isAdmin ? 'Gruppen-Admin' : 'Mitglied'} in ${g.name}. Zum Ändern öffnen`,
      onclick: (e) => memberMenu(e, g, m),
    }, h('span', { class: 'g-av' }, avatar(m.username, 28), m.online ? h('i', { class: 'g-online' }) : null),
    h('span', { class: 'g-name' }, m.username), isAdmin ? roleIcon() : null);
  }

  // ------------------------------------------------------------ Ansicht 1: Karten
  function card(g) {
    const box = h('div', { class: 'g-members' });
    let open = g.members.length <= MAX_CHIPS;
    const draw = () => {
      const list = open ? g.members : g.members.slice(0, MAX_CHIPS);
      clear(box, list.map((m) => chip(g, m)),
        open ? null : h('button', { type: 'button', class: 'g-more', onclick: () => { open = true; draw(); } }, `+ ${g.members.length - MAX_CHIPS} weitere`));
    };
    draw();
    const adm = adminCount(g);
    return h('section', { class: 'g-card' },
      h('header', { class: 'g-head' }, avatar(g.name, 44),
        h('div', { class: 'g-title' }, h('b', {}, g.name), h('div', { class: 'small muted' }, g.description || 'Keine Beschreibung')),
        iconBtn('info', 'Gruppen-Details', () => groupDialog(g))),
      h('div', { class: 'g-stats' },
        h('span', { class: 'g-stat' }, icon('group', 16), plural(g.members.length, 'Mitglied', 'Mitglieder')),
        h('span', { class: 'g-stat adm' }, icon('admin', 16), plural(adm, 'Admin', 'Admins')),
        g.only_admins ? h('span', { class: 'g-stat', title: 'Nur Gruppen-Admins dürfen schreiben' }, icon('lock', 16), 'nur Admins schreiben') : null),
      box);
  }

  const renderCards = () => (S.groups.length ? h('div', { class: 'g-grid' }, S.groups.map(card)) : empty());

  // ------------------------------------------------------------ Ansicht 2: Matrix (Nutzer × Gruppen)
  function renderMatrix() {
    if (!S.groups.length) return empty();
    const { users } = index();
    const rows = [...users.values()].sort((a, b) => b.groups.length - a.groups.length || a.username.localeCompare(b.username, 'de'));
    const table = h('table', { class: 'g-matrix' });
    const hl = (c, on) => table.querySelectorAll(`[data-c="${c}"]`).forEach((n) => n.classList.toggle('hl', on));
    const head = h('tr', {}, h('th', { class: 'corner' }, 'Nutzer'),
      S.groups.map((g, i) => h('th', { class: 'gcol', 'data-c': i, title: `${g.name} – ${g.members.length} Mitglieder`, onclick: () => groupDialog(g) },
        h('span', {}, trunc(g.name, 22)))));
    const body = rows.map((u) => h('tr', {},
      h('th', { class: `urow${u.state !== 'active' ? ' off' : ''}`, scope: 'row', onclick: () => openUser(u.id), title: 'Nutzer-Details' },
        h('span', { class: 'g-av' }, avatar(u.username, 24), u.online ? h('i', { class: 'g-online' }) : null), u.username,
        u.groups.some((x) => x.m.role === 'admin') ? roleIcon(13) : null),
      S.groups.map((g, i) => {
        const m = g.members.find((x) => x.id === u.id);
        return h('td', { 'data-c': i, onmouseenter: () => hl(i, true), onmouseleave: () => hl(i, false) },
          m ? h('button', {
            type: 'button', class: `g-cell ${m.role}`, title: `${u.username} in „${g.name}“: ${m.role === 'admin' ? 'Gruppen-Admin' : 'Mitglied'}`,
            'aria-label': `${u.username} in ${g.name}: ${m.role === 'admin' ? 'Gruppen-Admin' : 'Mitglied'}`,
            onclick: (e) => memberMenu(e, g, m),
          }, m.role === 'admin' ? icon('admin', 18) : h('i', { class: 'dotm' })) : null);
      })));
    table.append(h('thead', {}, head), h('tbody', {}, body));
    return h('div', { class: 'table-wrap g-matrix-wrap' }, table);
  }

  // ------------------------------------------------------------ Ansicht 3: Netzwerk
  function buildGraph() {
    const nodes = [], links = [], byId = new Map();
    const add = (n) => { nodes.push(n); byId.set(n.id, n); return n; };
    for (const g of S.groups) add({ id: 'g:' + g.id, type: 'group', ref: g, label: g.name, r: 15 + Math.sqrt(g.members.length) * 3.2, nb: [] });
    for (const g of S.groups) {
      const gn = byId.get('g:' + g.id);
      for (const m of g.members) {
        let un = byId.get('u:' + m.id);
        if (!un) un = add({ id: 'u:' + m.id, type: 'user', ref: m, label: m.username, r: 8, nb: [], admin: false });
        if (m.role === 'admin') un.admin = true;
        links.push({ a: gn, b: un, g, m, admin: m.role === 'admin' });
        gn.nb.push(un); un.nb.push(gn);
      }
    }
    return { nodes, links, byId };
  }

  // Einfache Kräfte-Simulation (Abstoßung, Federn, Schwerkraft); fixierte Knoten (Ziehen) bewegen sich nicht selbst.
  function makeSim(nodes, links, W, H) {
    const n = nodes.length;
    return function tick(alpha) {
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < n; j++) {
          const b = nodes[j];
          let dx = b.x - a.x, dy = b.y - a.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 0.01) { dx = Math.random() - .5; dy = Math.random() - .5; d2 = dx * dx + dy * dy + .01; }
          const d = Math.sqrt(d2), min = a.r + b.r + 14;
          let f = (a.type === 'group' && b.type === 'group' ? 5200 : 900) / d2;
          if (d < min) f += (min - d) * .35;
          if (d > 420) f = 0;
          const fx = (dx / d) * f * alpha, fy = (dy / d) * f * alpha;
          a.vx -= fx; a.vy -= fy; b.vx += fx; b.vy += fy;
        }
      }
      for (const l of links) {
        const dx = l.b.x - l.a.x, dy = l.b.y - l.a.y, d = Math.sqrt(dx * dx + dy * dy) || 1;
        const ideal = l.a.r + l.b.r + 38 + Math.sqrt(l.a.nb.length) * 4;
        const f = (d - ideal) * .045 * alpha, fx = (dx / d) * f, fy = (dy / d) * f;
        l.a.vx += fx; l.a.vy += fy; l.b.vx -= fx; l.b.vy -= fy;
      }
      for (const a of nodes) {
        a.vx += (W / 2 - a.x) * .004 * alpha; a.vy += (H / 2 - a.y) * .006 * alpha;
        if (a.fixed) { a.vx = a.vy = 0; continue; }
        a.vx *= .82; a.vy *= .82;
        a.x += Math.max(-30, Math.min(30, a.vx)); a.y += Math.max(-30, Math.min(30, a.vy));
      }
    };
  }

  function renderGraph() {
    if (!S.groups.length) return empty();
    const W = 900, H = 600;
    const { nodes, links, byId } = buildGraph();
    const gcount = S.groups.length;
    // Startpositionen: Gruppen auf einem Kreis, Nutzer in der Nähe ihrer ersten Gruppe; bekannte Knoten behalten ihren Platz
    let fresh = 0;
    nodes.forEach((nd, i) => {
      const p = pos0.get(nd.id);
      if (p) { nd.x = p.x; nd.y = p.y; } else {
        fresh++;
        if (nd.type === 'group') {
          const gi = S.groups.findIndex((g) => 'g:' + g.id === nd.id), ang = (gi / gcount) * Math.PI * 2;
          nd.x = W / 2 + Math.cos(ang) * 230; nd.y = H / 2 + Math.sin(ang) * 190;
        } else {
          const home = nd.nb[0];
          nd.x = (home?.x ?? W / 2) + (Math.random() - .5) * 90; nd.y = (home?.y ?? H / 2) + (Math.random() - .5) * 90;
        }
      }
      nd.vx = nd.vy = 0;
    });
    // Neuer Aufbau: volle Simulation. Sonst bleiben bekannte Knoten stehen, nur neue Knoten finden ihren Platz.
    const tick = makeSim(nodes, links, W, H);
    const known = fresh < nodes.length;
    if (fresh) {
      const iters = known ? 90 : (nodes.length > 400 ? 120 : 280);
      if (known) for (const nd of nodes) nd.fixed = pos0.has(nd.id);
      for (let i = 0; i < iters; i++) tick(known ? .6 * (1 - (i / iters) * .9) : 1 - (i / iters) * .9);
      for (const nd of nodes) nd.fixed = false;
    }

    // ---- SVG
    const showAll = nodes.length <= LABEL_LIMIT;
    const svg = s('svg', { class: 'g-svg' + (showAll ? ' labels' : ''), role: 'img', 'aria-label': 'Netzwerk aus Gruppen und ihren Mitgliedern', preserveAspectRatio: 'xMidYMid meet' });
    const linkG = s('g', { class: 'g-links' }), nodeG = s('g', { class: 'g-nodes' });
    svg.append(linkG, nodeG);
    for (const l of links) {
      l.el = s('line', { class: 'g-link' + (l.admin ? ' admin' : '') },
        s('title', {}, `${l.m.username} in „${l.g.name}“: ${l.admin ? 'Gruppen-Admin' : 'Mitglied'} (klicken zum Ändern)`));
      l.hit = s('line', { class: 'g-hit', onclick: (e) => memberMenu(e, l.g, l.m) });
      linkG.append(l.el, l.hit);
    }
    for (const nd of nodes) {
      if (nd.type === 'group') {
        nd.el = s('g', { class: 'g-node grp', style: { '--h': hue(nd.label) }, tabindex: 0, role: 'button', 'aria-label': `Gruppe ${nd.label}, ${nd.ref.members.length} Mitglieder` },
          s('circle', { r: nd.r }), s('text', { class: 'ini', 'text-anchor': 'middle', dy: '.35em' }, nd.label.slice(0, 2).toUpperCase()),
          s('text', { class: 'lbl', 'text-anchor': 'middle', y: nd.r + 14 }, trunc(nd.label, 20)));
      } else {
        nd.el = s('g', { class: `g-node usr${nd.admin ? ' adm' : ''}${nd.ref.state !== 'active' ? ' off' : ''}${nd.ref.online ? ' on' : ''}`, style: { '--h': hue(nd.label) }, tabindex: 0, role: 'button', 'aria-label': `Nutzer ${nd.label}${nd.admin ? ', Gruppen-Admin' : ''}` },
          s('circle', { r: nd.r }), nd.ref.online ? s('circle', { class: 'ondot', r: 3.6, cx: nd.r * .75, cy: -nd.r * .75 }) : null,
          s('text', { class: 'lbl', 'text-anchor': 'middle', y: nd.r + 12 }, trunc(nd.label, 14)));
      }
      nodeG.append(nd.el);
    }
    const place = () => {
      for (const l of links) for (const e of [l.el, l.hit]) { e.setAttribute('x1', l.a.x); e.setAttribute('y1', l.a.y); e.setAttribute('x2', l.b.x); e.setAttribute('y2', l.b.y); }
      for (const nd of nodes) { nd.el.setAttribute('transform', `translate(${nd.x.toFixed(1)} ${nd.y.toFixed(1)})`); pos0.set(nd.id, { x: nd.x, y: nd.y }); }
    };

    // ---- Ansicht (Zoom/Verschieben) – Anfang: alles im Bild
    const view = { x: 0, y: 0, w: W, h: H };
    const setView = () => {
      svg.setAttribute('viewBox', `${view.x.toFixed(1)} ${view.y.toFixed(1)} ${view.w.toFixed(1)} ${view.h.toFixed(1)}`);
      lastView = { ...view };
    };
    const fit = () => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const nd of nodes) { x0 = Math.min(x0, nd.x - nd.r - 30); y0 = Math.min(y0, nd.y - nd.r - 30); x1 = Math.max(x1, nd.x + nd.r + 30); y1 = Math.max(y1, nd.y + nd.r + 36); }
      const bw = Math.max(x1 - x0, 200), bh = Math.max(y1 - y0, 150), k = Math.max(bw / W, bh / H);
      view.w = W * k; view.h = H * k; view.x = (x0 + x1) / 2 - view.w / 2; view.y = (y0 + y1) / 2 - view.h / 2; setView();
    };
    const zoom = (f, cx = view.x + view.w / 2, cy = view.y + view.h / 2) => {
      const nw = Math.max(W / 8, Math.min(W * 6, view.w * f)), k = nw / view.w;
      view.x = cx - (cx - view.x) * k; view.y = cy - (cy - view.y) * k; view.w = nw; view.h *= k; setView();
    };
    // Bildschirm -> SVG-Koordinaten (inkl. Rand durch preserveAspectRatio „meet“)
    const toSvg = (e) => {
      const r = svg.getBoundingClientRect(), k = Math.max(view.w / r.width, view.h / r.height);
      return [view.x + (e.clientX - r.left - (r.width - view.w / k) / 2) * k, view.y + (e.clientY - r.top - (r.height - view.h / k) / 2) * k];
    };
    // ohne Ctrl/⌘ soll das Mausrad die Seite scrollen, nicht den Graphen zoomen
    svg.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const [cx, cy] = toSvg(e); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, cx, cy);
    }, { passive: false });

    // ---- Hervorhebung
    const setHover = (nd) => {
      const on = new Set(nd ? [nd, ...nd.nb] : []);
      svg.classList.toggle('dim', !!nd);
      for (const x of nodes) x.el.classList.toggle('hot', on.has(x));
      for (const l of links) l.el.classList.toggle('hot', !!nd && (l.a === nd || l.b === nd));
    };
    const setFocus = (nd) => {
      S.focus = nd ? { id: nd.id } : null;
      for (const x of nodes) x.el.classList.toggle('sel', !!nd && x === nd);
      drawPanel();
    };

    // ---- Ziehen (Knoten) und Verschieben (Hintergrund)
    let anim = 0, heat = 0, alive = true;
    const loop = () => {
      anim = 0;
      if (!alive) return;
      if (heat > 0) { tick(.3 * Math.min(1, heat / 30)); heat--; place(); anim = requestAnimationFrame(loop); }
    };
    const kick = (n = 50) => { heat = Math.max(heat, n); if (!anim) anim = requestAnimationFrame(loop); };
    stopGraph = () => { alive = false; cancelAnimationFrame(anim); };

    let drag = null;
    svg.addEventListener('pointerdown', (e) => {
      const g = e.target.closest?.('.g-node');
      const nd = g && nodes.find((x) => x.el === g);
      if (nd) {
        nd.fixed = true; drag = { nd, moved: false, sx: e.clientX, sy: e.clientY };
      } else if (!e.target.closest?.('.g-hit')) {
        drag = { pan: true, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
      }
      if (drag) svg.setPointerCapture?.(e.pointerId);
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = svg.getBoundingClientRect(), k = Math.max(view.w / r.width, view.h / r.height);
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 4) drag.moved = true;
      if (drag.pan) { view.x = drag.vx - (e.clientX - drag.sx) * k; view.y = drag.vy - (e.clientY - drag.sy) * k; setView(); return; }
      if (!drag.moved) return;
      const [x, y] = toSvg(e); drag.nd.x = x; drag.nd.y = y; place(); kick(40);
    });
    const end = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.nd) { d.nd.fixed = false; if (!d.moved) { setFocus(S.focus?.id === d.nd.id ? null : d.nd); } else kick(30); }
      else if (!d.moved) setFocus(null);
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    for (const nd of nodes) {
      nd.el.addEventListener('pointerenter', () => { if (!drag) setHover(nd); });
      nd.el.addEventListener('pointerleave', () => { if (!drag) setHover(null); });
      nd.el.addEventListener('focus', () => setHover(nd));
      nd.el.addEventListener('blur', () => setHover(null));
      nd.el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setFocus(S.focus?.id === nd.id ? null : nd); } });
    }

    // ---- Panel zur Auswahl (Gruppe -> Mitglieder, Nutzer -> Gruppen), dort lassen sich Rechte direkt setzen
    const panel = h('div', { class: 'g-panel', 'aria-live': 'polite' });
    const toggle = (g, m) => h('button', {
      type: 'button', class: `g-toggle${m.role === 'admin' ? ' on' : ''}`, 'aria-pressed': m.role === 'admin' ? 'true' : 'false',
      title: m.role === 'admin' ? 'Admin-Recht entziehen' : 'Zum Gruppen-Admin ernennen',
      onclick: () => setRole(g, m, m.role !== 'admin'),
    }, icon('admin', 16), m.role === 'admin' ? 'Admin' : 'Mitglied');
    function drawPanel() {
      const nd = S.focus && byId.get(S.focus.id);
      if (!nd) { clear(panel, h('p', { class: 'small muted' }, 'Gruppe oder Nutzer anklicken, um Mitglieder und Rechte zu sehen und zu ändern. Knoten lassen sich ziehen, Linien anklicken.')); return; }
      if (nd.type === 'group') {
        const g = nd.ref;
        clear(panel, h('div', { class: 'g-panel-head' }, avatar(g.name, 36), h('div', {}, h('b', {}, g.name), h('div', { class: 'small muted' }, `${plural(g.members.length, 'Mitglied', 'Mitglieder')}, ${plural(adminCount(g), 'Admin', 'Admins')}`)),
          h('span', { class: 'grow' }), iconBtn('info', 'Gruppen-Details', () => groupDialog(g))),
        h('ul', { class: 'g-plist' }, g.members.map((m) => h('li', {}, h('span', { class: 'g-av' }, avatar(m.username, 28), m.online ? h('i', { class: 'g-online' }) : null),
          h('a', { href: '#', class: 'g-ulink', onclick: (e) => { e.preventDefault(); openUser(m.id); } }, m.username),
          m.state !== 'active' ? h('span', { class: 'small muted' }, m.state === 'blocked' ? 'gesperrt' : 'ausstehend') : null,
          h('span', { class: 'grow' }), toggle(g, m)))));
      } else {
        const gs = nd.nb.map((gn) => ({ g: gn.ref, m: gn.ref.members.find((x) => x.id === nd.ref.id) })).filter((x) => x.m);
        clear(panel, h('div', { class: 'g-panel-head' }, avatar(nd.label, 36), h('div', {}, h('b', {}, nd.label), h('div', { class: 'small muted' }, `in ${plural(gs.length, 'Gruppe', 'Gruppen')}`)),
          h('span', { class: 'grow' }), iconBtn('person', 'Nutzer-Details', () => openUser(nd.ref.id))),
        h('ul', { class: 'g-plist' }, gs.map(({ g, m }) => h('li', {}, avatar(g.name, 28), h('span', {}, g.name), h('span', { class: 'grow' }), toggle(g, m)))));
      }
    }
    drawPanel();

    const bar = h('div', { class: 'g-graph-bar' },
      h('span', { class: 'small muted grow' }, 'Ziehen verschiebt · Strg/⌘ + Mausrad zoomt'),
      iconBtn('add', 'Vergrößern', () => zoom(1 / 1.3)), iconBtn('remove', 'Verkleinern', () => zoom(1.3)),
      iconBtn('refresh', 'Neu anordnen', () => { pos0.clear(); lastView = null; render(); }), iconBtn('search', 'Alles anzeigen', fit));
    place();
    if (known && lastView) { Object.assign(view, lastView); setView(); } else fit();
    if (S.focus && byId.has(S.focus.id)) byId.get(S.focus.id).el.classList.add('sel');
    return h('div', {}, h('div', { class: 'g-graph' }, bar, svg), panel);
  }

  // ------------------------------------------------------------ Rahmen
  const empty = () => h('div', { class: 'g-empty' }, icon('group', 40),
    h('p', {}, S.q ? 'Keine Gruppe passt zur Suche.' : 'Es gibt noch keine Gruppen.'));

  function legend() {
    const dot = (cls, t) => h('span', { class: 'g-leg' }, h('i', { class: cls }), t);
    return h('div', { class: 'g-legend small muted' },
      dot('lg-admin', 'Gruppen-Admin'), dot('lg-member', 'Mitglied'), dot('lg-on', 'online'), dot('lg-off', 'gesperrt / ausstehend'));
  }

  function render() {
    stopGraph(); stopGraph = () => {};
    const sum = S.groups.reduce((n, g) => n + g.members.length, 0);
    const uniq = new Set(S.groups.flatMap((g) => g.members.map((m) => m.id))).size;
    el.count.textContent = `${plural(S.groups.length, 'Gruppe', 'Gruppen')} · ${plural(uniq, 'Nutzer', 'Nutzer')} · ${plural(sum, 'Mitgliedschaft', 'Mitgliedschaften')}`;
    clear(el.views, VIEWS.map(([k, l, ic]) => h('button', { type: 'button', class: S.view === k ? 'on' : '', 'aria-pressed': String(S.view === k), onclick: () => { S.view = k; render(); } }, icon(ic, 18), l)));
    clear(el.body, S.view === 'graph' ? renderGraph() : S.view === 'matrix' ? renderMatrix() : renderCards());
  }

  async function load(force = false) {
    try {
      const d = await api('/admin/groups?' + new URLSearchParams({ q: S.q }));
      const sig = JSON.stringify(d.groups, (k, v) => (k === 'last_seen' ? undefined : v));
      S.loaded = true;
      if (!force && sig === S.sig) return;      // nichts geändert -> Ansicht (Scroll, Layout) nicht anfassen
      S.sig = sig; S.groups = d.groups;
      if (S.focus && !S.groups.some((g) => S.focus.id === 'g:' + g.id || g.members.some((m) => S.focus.id === 'u:' + m.id))) S.focus = null;
      render();
    } catch (e) { snackbar(e.message); }
  }

  // ------------------------------------------------------------ Aufbau
  const search = h('input', { type: 'search', placeholder: 'Gruppe oder Mitglied suchen …', 'aria-label': 'Gruppen suchen' });
  let t = 0;
  search.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { S.q = search.value.trim(); load(true); }, 250); });
  el.count = h('span', { class: 'muted small' });
  el.views = h('div', { class: 'g-views', role: 'group', 'aria-label': 'Ansicht' });
  el.body = h('div', { class: 'g-body' });
  const root = h('div', {},
    h('div', { class: 'admin-toolbar' }, search, el.views, iconBtn('refresh', 'Aktualisieren', () => load(true)), el.count),
    legend(), el.body);

  return {
    el: root,
    load: () => load(true),
    refresh: () => (S.loaded ? load(false) : load(true)),
    isReady: () => S.loaded,
  };
}
