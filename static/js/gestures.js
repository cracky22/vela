// Gesten: horizontales Wischen mit Aktionen, Long-Press, Doppeltippen.
// Pointer Events = gleiche Logik für Touch, Stift und Maus. `touch-action: pan-y` sorgt dafür,
// dass vertikales Scrollen weiterhin nativ (flüssig) vom Browser übernommen wird.
import { h, icon, vibrate } from './util.js';

const LONG_PRESS_MS = 480;
const MOVE_TOLERANCE = 10;

/**
 * @param {HTMLElement} el   Container (bekommt Hintergründe + .swipe-content)
 * @param {object} o
 *   left/right: { icon, label, color: 'primary'|'tertiary'|'error'|..., action: () => void, dismiss?: bool }
 *   onLongPress(x, y), onDoubleTap(), maxShift (px, optional)
 */
export function swipeable(el, content, o = {}) {
  el.classList.add('swipeable');
  const bgL = o.right ? h('div', { class: `swipe-bg left c-${o.right.color || 'primary'}` }, icon(o.right.icon), h('span', {}, o.right.label)) : null;
  const bgR = o.left ? h('div', { class: `swipe-bg right c-${o.left.color || 'primary'}` }, h('span', {}, o.left.label), icon(o.left.icon)) : null;
  content.classList.add('swipe-content');
  el.append(...[bgL, bgR].filter(Boolean), content);

  let sx = 0, sy = 0, st = 0, dx = 0, mode = null, pid = null, armed = false, lpTimer = 0, suppress = false, lastTap = 0;

  const width = () => el.getBoundingClientRect().width;
  const threshold = () => Math.min(140, width() * 0.33);

  function setX(x, animate) {
    content.style.transition = animate ? 'transform 220ms cubic-bezier(.2,0,0,1)' : 'none';
    content.style.transform = x ? `translate3d(${x}px,0,0)` : '';
    if (bgL) bgL.style.opacity = x > 0 ? Math.min(1, x / threshold()) : 0;
    if (bgR) bgR.style.opacity = x < 0 ? Math.min(1, -x / threshold()) : 0;
  }

  function reset(animate = true) {
    mode = null; pid = null; armed = false; dx = 0;
    el.classList.remove('armed');
    setX(0, animate);
  }

  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || pid !== null) return;
    if (e.target.closest('button, a, input, textarea, audio, .no-gesture')) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; st = performance.now(); mode = null; dx = 0;
    if (o.onLongPress && e.pointerType !== 'mouse') {
      clearTimeout(lpTimer);
      lpTimer = setTimeout(() => {
        if (mode === null) {
          mode = 'longpress'; suppress = true; vibrate(15);
          o.onLongPress(sx, sy);
        }
      }, LONG_PRESS_MS);
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (mode === null) {
      if (Math.abs(mx) > MOVE_TOLERANCE && Math.abs(mx) > Math.abs(my) * 1.3 && ((mx > 0 && o.right) || (mx < 0 && o.left))) {
        mode = 'swipe';
        clearTimeout(lpTimer);
        try { el.setPointerCapture(pid); } catch { /* ok */ }
      } else if (Math.abs(my) > MOVE_TOLERANCE || Math.abs(mx) > MOVE_TOLERANCE) {
        clearTimeout(lpTimer);
        mode = 'scroll';
      }
    }
    if (mode !== 'swipe') return;
    e.preventDefault();
    const max = o.maxShift || width() * 0.6;
    dx = mx > 0 ? (o.right ? mx : 0) : (o.left ? mx : 0);
    if (Math.abs(dx) > max) dx = Math.sign(dx) * (max + (Math.abs(dx) - max) * 0.2); // Gummiband
    setX(dx, false);
    const nowArmed = Math.abs(dx) >= threshold();
    if (nowArmed !== armed) { armed = nowArmed; el.classList.toggle('armed', armed); if (armed) vibrate(8); }
  });

  function end(e) {
    if (e.pointerId !== pid) return;
    clearTimeout(lpTimer);
    if (mode === 'swipe') {
      suppress = true;
      const v = Math.abs(dx) / Math.max(1, performance.now() - st);
      const fire = armed || (v > 0.6 && Math.abs(dx) > 48);
      const side = dx < 0 ? o.left : o.right;
      if (fire && side) {
        if (side.dismiss) {
          setX(Math.sign(dx) * width(), true);
          setTimeout(() => { side.action(); reset(false); }, 200);
        } else {
          reset(true);
          side.action();
        }
      } else reset(true);
      mode = null; pid = null;
      return;
    }
    if (mode === null && e.type === 'pointerup' && o.onDoubleTap) {
      const now = performance.now();
      if (now - lastTap < 300) { lastTap = 0; suppress = true; o.onDoubleTap(); } else lastTap = now;
    }
    pid = null;
    if (mode !== 'longpress') mode = null;
  }
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', (e) => { if (e.pointerId === pid) { clearTimeout(lpTimer); reset(true); } });

  // Klick nach Wischen/Long-Press unterdrücken
  el.addEventListener('click', (e) => {
    if (suppress) { e.stopPropagation(); e.preventDefault(); suppress = false; mode = null; }
  }, true);

  // Desktop: Rechtsklick = Kontextmenü; Touch: natives Menü unterdrücken
  el.addEventListener('contextmenu', (e) => {
    if (!o.onLongPress) return;
    e.preventDefault();
    if (mode === 'longpress') return; // schon per Long-Press geöffnet
    clearTimeout(lpTimer);
    if (pid !== null) { mode = 'longpress'; suppress = true; }
    o.onLongPress(e.clientX, e.clientY);
  });

  return { reset };
}
