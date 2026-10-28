// „Was gibt’s Neues?“ nach einem Update (Material-3-Dialog). Gemerkt wird die zuletzt gesehene Version im
// localStorage. Neuer Eintrag nach einem Update: oben in CHANGELOG ergänzen und `version` in app.js erhöhen.
import { h, icon } from './util.js';
import { version } from './app.js';
import { dialog } from './ui.js';

export const RELEASES_URL = 'https://github.com/cracky22/vela/releases';
const KEY = 'vela:last-version';
export const CHANGELOG = [
  {
    version: version, date: '2026-10-27',
    items: [
      { icon: 'bell', title: 'Benachrichtigungen auch auf Android (Web-App)',
        text: 'Neue Nachrichten werden jetzt auch gemeldet, wenn die App geschlossen ist. Aktivieren unter Profil → Benachrichtigungen. Der Inhalt bleibt privat.' },
      { icon: 'warn', title: 'Wartungs- und Verbindungshinweise',
        text: 'Bei Wartungsarbeiten zeigt Vela jetzt nen gelben Banner. Ist die Verbindung furt, siehst du „Offline - verbinde neu …“ und wenn Verbindung wieder da „Verbindung wiederhergestellt“.' },
      { icon: 'info', title: 'Neues Design',
        text: 'Es kommen nochmal Updates was Darstellung angeht, aber es wird in diesem Theming bleiben circa.' },
    ],
  },
];

const parse = (v) => {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function render(entries) {
  const fmt = (d) => { const t = Date.parse(d); return t ? new Date(t).toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' }) : ''; };
  return h('div', { class: 'changelog' }, entries.map((e) => h('section', {},
    h('div', { class: 'changelog-ver' }, h('span', { class: 'badge-v' }, `Version ${e.version}`), h('span', { class: 'date' }, fmt(e.date))),
    h('ul', { class: 'changelog-list' }, e.items.map((it) => h('li', {},
      h('span', { class: 'changelog-ic' }, icon(it.icon || 'info', 22)),
      h('div', {}, h('b', {}, it.title), h('span', { class: 'txt' }, it.text))))))));
}

/**
 * Zeigt den Dialog, wenn die App seit dem letzten Start aktualisiert wurde.
 * @param current  aktuelle Version
 * @param me       eigenes Konto (created_at in ms): Bestandskonten sehen beim ersten Start den neuesten Eintrag,
 *                 frisch registrierte Konten nicht.
 * @returns        Promise, das nach dem Schließen erfüllt wird (oder sofort, wenn nichts anzuzeigen ist)
 */
export function maybeShowChangelog(current, me) {
  const cur = parse(current);
  if (!cur) return Promise.resolve(false);
  let last = null;
  try { last = localStorage.getItem(KEY); } catch { /* Speicher gesperrt: dann ohne Merken */ }
  const save = () => { try { localStorage.setItem(KEY, current); } catch { /* ok */ } };
  const lastV = parse(last);
  let entries = [];
  if (!lastV) {
    const newest = CHANGELOG.find((e) => cmp(parse(e.version), cur) <= 0);
    if (newest && me?.created_at && me.created_at < Date.parse(newest.date)) entries = [newest];
  } else if (cmp(cur, lastV) > 0) {
    entries = CHANGELOG.filter((e) => { const v = parse(e.version); return v && cmp(v, lastV) > 0 && cmp(v, cur) <= 0; }).slice(0, 5);
  }
  if (!entries.length) { save(); return Promise.resolve(false); }
  const d = dialog({
    title: entries.length > 1 ? 'Neu in Vela' : `Neu in Vela ${entries[0].version}`, icon: 'info', cls: 'changelog-dialog',
    body: render(entries),
    actions: [
      { label: 'Alle Versionen', onClick: () => { window.open(RELEASES_URL, '_blank', 'noopener,noreferrer'); return false; } },
      { label: 'Los geht’s', primary: true },
    ],
  });
  return d.done.then(() => { save(); return true; });
}