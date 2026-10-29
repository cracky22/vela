// Profil-Bereich „Anmeldung auf anderen Geräten“: Schlüsseltresor (Schnell-Anmeldung) und QR-Verknüpfung.
import { h, clear, icon } from './util.js';
import { dialog, field, button, snackbar } from './ui.js';
import { S } from './state.js';
import { readStash } from './keystash.js';
import { vaultStatus, enableVault, disableVault } from './vault.js';
import { scanAndApprove, activateSource } from './qrlink.js';

const fmt = (ts) => (ts ? new Date(ts).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

function code2fa() {
  return field({ label: '2FA-Code', name: 'code', autocomplete: 'one-time-code', attrs: { inputmode: 'numeric', maxlength: 7 } });
}

function enableDialog(hasStash, done) {
  const pw = field({ label: 'Passwort', name: 'password', type: 'password', autocomplete: 'current-password' });
  const rk = hasStash ? null : field({ label: 'Wiederherstellungsschlüssel', name: 'rk', autocomplete: 'off', attrs: { autocapitalize: 'characters', spellcheck: false } });
  const code = code2fa();
  dialog({
    title: 'Schnell-Anmeldung einrichten', icon: 'key',
    body: h('div', {},
      h('p', {}, 'Deine Schlüssel werden mit deinem Passwort verschlüsselt auf dem Server abgelegt. Auf einem neuen Gerät genügen dann Passwort und 2FA-Code, den langen Wiederherstellungsschlüssel brauchst du nicht mehr.'),
      h('div', { class: 'banner info' }, icon('shield', 20), h('span', {}, 'Der Server sieht dein Passwort dabei nicht und kann die Schlüssel nicht lesen. Wer die Datenbank stiehlt, könnte aber ein schwaches Passwort erraten. Nimm ein langes, einmaliges Passwort. Der Wiederherstellungsschlüssel bleibt zusätzlich gültig.')),
      pw.wrap, rk?.wrap, code.wrap),
    actions: [{ label: 'Abbrechen' }, {
      label: 'Einrichten', primary: true,
      onClick: async (close) => {
        try { await enableVault({ password: pw.input.value, code: code.input.value.replace(/\s/g, ''), recoveryText: rk?.input.value }); } catch (e) {
          (e.message.includes('Wiederherstellungs') || e.message.includes('Backup') ? rk || code : e.message.includes('2FA') ? code : pw).setError(e.message);
          return false;
        }
        snackbar('Schnell-Anmeldung ist eingerichtet');
        done();
      },
    }],
  });
}

function disableDialog(done) {
  const pw = field({ label: 'Passwort', name: 'password', type: 'password', autocomplete: 'current-password' });
  const code = code2fa();
  dialog({
    title: 'Schnell-Anmeldung abschalten?', icon: 'lock',
    body: h('div', {}, h('p', {}, 'Die Schlüsselkopie wird vom Server gelöscht. Neue Geräte brauchen dann wieder den Wiederherstellungsschlüssel oder einen QR-Code.'), pw.wrap, code.wrap),
    actions: [{ label: 'Abbrechen' }, {
      label: 'Abschalten', tonal: true, danger: true,
      onClick: async () => {
        try { await disableVault({ password: pw.input.value, code: code.input.value.replace(/\s/g, '') }); } catch (e) { (e.message.includes('2FA') ? code : pw).setError(e.message); return false; }
        snackbar('Schnell-Anmeldung abgeschaltet');
        done();
      },
    }],
  });
}

export async function renderDeviceSection(slot) {
  let st = { enabled: false }, stash = null;
  try { [st, stash] = await Promise.all([vaultStatus(), readStash(S.me.id)]); } catch (e) { clear(slot, h('p', { class: 'small error-text' }, e.message)); return; }
  const again = () => renderDeviceSection(slot);
  clear(slot,
    h('div', { class: 'device-block' },
      h('div', { class: 'info-row' }, icon('key', 22), h('div', {},
        h('div', {}, 'Schnell-Anmeldung (Schlüsseltresor)'),
        h('div', { class: 'small muted' }, st.enabled ? `Aktiv seit ${fmt(st.updated)}. Neue Geräte: Passwort + 2FA genügen.` : 'Aus. Auf neuen Geräten brauchst du den Wiederherstellungsschlüssel.'))),
      st.enabled ? button('Abschalten …', { kind: 'text', icon: 'lock', onClick: () => disableDialog(again) })
        : button('Einrichten …', { kind: 'tonal', icon: 'key', onClick: () => enableDialog(!!stash, again) })),
    h('div', { class: 'device-block' },
      h('div', { class: 'info-row' }, icon('camera', 22), h('div', {},
        h('div', {}, 'Neues Gerät per QR-Code anmelden'),
        h('div', { class: 'small muted' }, stash ? 'Dieses Gerät kann Schlüssel weitergeben. Öffne auf dem Rechner die Anmeldung → „Mit QR-Code anmelden“ und scanne den Code.' : 'Dieses Gerät kann noch keine Schlüssel weitergeben. Einmalig aktivieren (Wiederherstellungsschlüssel).'))),
      stash ? button('QR-Code scannen', { kind: 'tonal', icon: 'camera', onClick: scanAndApprove })
        : button('Dieses Gerät aktivieren …', { kind: 'tonal', icon: 'key', onClick: async () => { if (await activateSource()) { snackbar('Gerät aktiviert'); again(); } } })));
}