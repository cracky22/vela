// Material-3-Bausteine: Dialoge, Snackbar, Menüs/Bottom-Sheets, Fortschrittsbalken, Felder.
import { h, icon, isTouch } from './util.js';

// ---------------------------------------------------------------- Fortschritt
export function progress({ value = null, label = '', cls = '' } = {}) {
  const bar = h('div', { class: 'bar' });
  const text = h('span', { class: 'progress-label' }, label);
  const el = h('div', { class: 'progress ' + cls, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100 },
    h('div', { class: 'track' }, bar), label ? text : null);
  const api = {
    el,
    set(v, lbl) {
      if (v === null || v === undefined) { el.classList.add('indeterminate'); el.removeAttribute('aria-valuenow'); bar.style.width = ''; }
      else {
        el.classList.remove('indeterminate');
        const pct = Math.max(0, Math.min(100, v * 100));
        bar.style.width = pct + '%';
        el.setAttribute('aria-valuenow', Math.round(pct));
      }
      if (lbl !== undefined) { text.textContent = lbl; if (!text.isConnected && lbl) el.append(text); }
    },
  };
  api.set(value, label);
  return api;
}

// ---------------------------------------------------------------- Snackbar
let snackTimer = 0;
export function snackbar(text, { action, onAction, timeout = 4000 } = {}) {
  document.querySelector('.snackbar')?.remove();
  const el = h('div', { class: 'snackbar', role: 'status', 'aria-live': 'polite' },
    h('span', {}, text),
    action ? h('button', { class: 'btn text inverse', onclick: () => { el.remove(); onAction?.(); } }, action) : null);
  document.body.append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, timeout);
}

// ---------------------------------------------------------------- Dialoge
export function dialog({ title, icon: ic, body, actions = [], dismissible = true, cls = '' }) {
  const d = h('dialog', { class: 'm3-dialog ' + cls });
  let result;
  const close = (v) => { result = v; d.close(); };
  const btns = actions.map((a) => h('button', {
    class: `btn ${a.primary ? 'filled' : a.tonal ? 'tonal' : 'text'} ${a.danger ? 'danger' : ''}`, type: 'button',
    onclick: async (e) => {
      if (a.onClick) {
        const btn = e.currentTarget;
        btn.disabled = true;
        try { if ((await a.onClick(close)) === false) return; } finally { btn.disabled = false; }
      }
      close(a.value);
    },
  }, a.label));
  d.append(
    ic ? h('div', { class: 'dialog-icon' }, icon(ic)) : null,
    title ? h('h2', { class: 'dialog-title' }, title) : null,
    h('div', { class: 'dialog-body' }, body),
    btns.length ? h('div', { class: 'dialog-actions' }, btns) : null,
  );
  d.addEventListener('cancel', (e) => { if (!dismissible) e.preventDefault(); });
  d.addEventListener('click', (e) => { if (dismissible && e.target === d) close(undefined); });
  document.body.append(d);
  d.showModal();
  const done = new Promise((resolve) => d.addEventListener('close', () => { resolve(result); d.remove(); }));
  return { el: d, close, done };
}

export function confirm(title, text, { ok = 'OK', cancel = 'Abbrechen', danger = false, icon: ic } = {}) {
  return dialog({
    title, icon: ic, body: h('p', {}, text),
    actions: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, tonal: danger, danger }],
  }).done.then((v) => v === true);
}

// ---------------------------------------------------------------- Menü / Bottom-Sheet
export function menu(items, x, y, { header } = {}) {
  document.querySelector('.menu-scrim')?.remove();
  const sheet = isTouch() || innerWidth < 600;
  const list = h('div', { class: sheet ? 'bottom-sheet' : 'menu', role: 'menu' },
    sheet ? h('div', { class: 'sheet-handle' }) : null,
    header || null,
    items.filter(Boolean).map((it) => h('button', {
      class: 'menu-item' + (it.danger ? ' danger' : ''), role: 'menuitem', type: 'button',
      onclick: () => { close(); it.onClick?.(); },
    }, it.icon ? icon(it.icon, 22) : null, h('span', {}, it.label))));
  const scrim = h('div', { class: 'menu-scrim' + (sheet ? ' sheet' : ''), onclick: (e) => { if (e.target === scrim) close(); } }, list);
  function close() { scrim.classList.remove('open'); setTimeout(() => scrim.remove(), 180); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKey);
  document.body.append(scrim);
  if (!sheet) {
    const r = list.getBoundingClientRect();
    list.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
    list.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
  }
  requestAnimationFrame(() => scrim.classList.add('open'));
  list.querySelector('button')?.focus({ preventScroll: true });
  return close;
}

// ---------------------------------------------------------------- Formularfelder
export function field({ label, type = 'text', name, value = '', autocomplete, help, required = true, attrs = {} }) {
  const id = 'f-' + name + '-' + Math.random().toString(36).slice(2, 7);
  const input = h('input', { id, name, type, value, autocomplete, required, placeholder: ' ', ...attrs });
  const err = h('div', { class: 'field-error', 'aria-live': 'polite' });
  const wrap = h('div', { class: 'field' },
    h('div', { class: 'field-box' }, input, h('label', { for: id }, label)),
    help ? h('div', { class: 'field-help' }, help) : null, err);
  return { wrap, input, setError(msg) { err.textContent = msg || ''; wrap.classList.toggle('invalid', !!msg); } };
}

export function switchRow({ label, desc, checked, onChange }) {
  const input = h('input', { type: 'checkbox', role: 'switch', checked: !!checked, onchange: (e) => onChange(e.target.checked) });
  return h('label', { class: 'switch-row' },
    h('div', { class: 'switch-text' }, h('div', { class: 'switch-label' }, label), desc ? h('div', { class: 'switch-desc' }, desc) : null),
    h('span', { class: 'switch' }, input, h('span', { class: 'switch-track' }, h('span', { class: 'switch-thumb' }))));
}

export function button(label, { kind = 'filled', onClick, type = 'button', icon: ic, cls = '', disabled = false } = {}) {
  return h('button', { class: `btn ${kind} ${cls}`, type, onclick: onClick, disabled }, ic ? icon(ic, 20) : null, h('span', {}, label));
}

// ---------------------------------------------------------------- Ripple (Material-Welleneffekt)
const RIPPLE_SEL = '.btn, .icon-btn, .nav-item, .menu-item, .chip, .fab, .tab, .row-inner, .status-row, .segmented button, .reaction-pick';
export function initRipple() {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const t = e.target.closest(RIPPLE_SEL);
    if (!t || t.disabled || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const r = t.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2.2;
    const s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = size + 'px';
    s.style.left = (e.clientX - r.left - size / 2) + 'px';
    s.style.top = (e.clientY - r.top - size / 2) + 'px';
    t.append(s);
    const kill = () => s.remove();
    s.addEventListener('animationend', kill);
    setTimeout(kill, 900);
  }, { passive: true });
}

// DOM-Abgleich: bringt die Kinder von `container` in die Reihenfolge `nodes`, ohne
// unveränderte Elemente neu zu erzeugen (verhindert Flackern und erhält Zustand).
export function reconcile(container, nodes) {
  let ref = container.firstChild;
  for (const n of nodes) {
    if (n === ref) { ref = ref.nextSibling; continue; }
    container.insertBefore(n, ref);
  }
  while (ref) { const next = ref.nextSibling; ref.remove(); ref = next; }
}
