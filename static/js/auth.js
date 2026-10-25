// Anmeldung, Registrierung (Schlüsselerzeugung, Wiederherstellungsschlüssel, 2FA),
// Konto-Wiederherstellung, Schlüssel-Wiederherstellung auf neuem Gerät, Schlüsselrotation.
import { h, clear, icon } from './util.js';
import { api } from './api.js';
import { field, button, progress, snackbar, confirm } from './ui.js';
import {
  generateIdentity, importIdentity, newRecoveryKey, parseRecoveryKey, makeBackup, openBackup, recoveryAuth,
} from './crypto.js';
import { S, saveIdentity } from './state.js';
import { isWebKit } from './keycompat.js';
import { version } from './app.js';

let root, onAuthenticated;
export function initAuth(rootEl, cb) { root = rootEl; onAuthenticated = cb; }

const KEY_INFO = {
  2048: { label: '2048 Bit', note: 'Schnell. NIST (SP 800-57) hält 2048 Bit bis 2030 für ausreichend, das BSI (TR-02102-1) empfiehlt seit 2023 mindestens 3000 Bit.', time: '< 1 s' },
  3072: { label: '3072 Bit', note: 'Entspricht der BSI-Empfehlung (≥ 3000 Bit) und NIST für Schutz über 2030 hinaus.', time: '1–3 s' },
  4096: { label: '4096 Bit', note: 'Ausgewogen: hohe Sicherheitsreserve, gute Geschwindigkeit.', time: '2–10 s' },
  8192: { label: '8192 Bit', note: 'Maximale Länge. Erzeugung kann auf Smartphones 1–3 Minuten dauern, Entschlüsseln ist spürbar langsamer.', time: '20 s – 3 min' },
};

function brand(sub) {
  return h('div', { class: 'brand' },
    h('div', { class: 'brand-logo' }, icon('shield', 32)),
    h('div', {}, h('div', { class: 'brand-name' }, 'Vela'), h('div', { class: 'brand-sub' }, sub || 'Privat. Verschlüsselt. Einfach.')));
}

function page(...content) {
  clear(root, h('div', { class: 'auth-page' },
    h('div', { class: 'auth-card' }, ...content),
    h('p', { class: 'auth-foot' }, icon('lock', 14), ' Ende-zu-Ende-verschlüsselt - der Server kann deine Nachrichten nicht lesen.'),
    h('pre', { class: 'small muted center' }, 'com.crackyOS.vela · ' + version + ' · © 2026 Martin B.')));
  root.querySelector('input, textarea, button.btn.filled')?.focus({ preventScroll: true });
}

function stepper(active) {
  const steps = ['Konto', 'Schlüssel', 'Sicherung', '2FA'];
  return h('ol', { class: 'stepper', 'aria-label': 'Fortschritt der Registrierung' },
    steps.map((s, i) => h('li', { class: i < active ? 'done' : i === active ? 'active' : '', 'aria-current': i === active ? 'step' : null },
      h('span', { class: 'step-dot' }, i < active ? icon('check', 16) : String(i + 1)), h('span', { class: 'step-label' }, s))));
}

function errorBox() {
  const el = h('div', { class: 'form-error', role: 'alert' });
  return { el, set(msg) { el.textContent = msg || ''; el.classList.toggle('show', !!msg); } };
}

// ================================================================= Anmeldung
export function renderLogin(notice) {
  const u = field({ label: 'Nutzername', name: 'username', autocomplete: 'username', attrs: { autocapitalize: 'none', spellcheck: false } });
  const p = field({ label: 'Passwort', name: 'password', type: 'password', autocomplete: 'current-password' });
  const c = field({ label: '6-stelliger Code aus der Authenticator-App', name: 'code', autocomplete: 'one-time-code', required: false,
    attrs: { inputmode: 'numeric', pattern: '[0-9 ]*', maxlength: 7 }, help: 'Bei nicht abgeschlossener Registrierung leer lassen.' });
  const err = errorBox();
  const submit = button('Anmelden', { type: 'submit', cls: 'wide' });
  const form = h('form', {
    class: 'form', onsubmit: async (e) => {
      e.preventDefault();
      err.set('');
      submit.disabled = true;
      try {
        const res = await api('/auth/login', { method: 'POST', body: { username: u.input.value.trim(), password: p.input.value, code: c.input.value.replace(/\s/g, '') } });
        if (res.setup_2fa) render2FA(res.setup_2fa, onAuthenticated, { intro: 'Die Einrichtung der Zwei-Faktor-Authentifizierung wurde noch nicht abgeschlossen.' });
        else await onAuthenticated();
      } catch (ex) {
        err.set(ex.message);
        submit.disabled = false;
      }
    },
  }, u.wrap, p.wrap, c.wrap, err.el, submit);
  page(brand(), notice ? h('div', { class: 'banner info' }, icon('shield', 20), h('span', {}, notice)) : null,
    h('h1', { class: 'auth-title' }, 'Anmelden'), form,
    h('div', { class: 'auth-links' },
      button('Neues Konto erstellen', { kind: 'tonal', onClick: () => renderRegister(), cls: 'wide' }),
      button('Passwort oder 2FA-Gerät verloren?', { kind: 'text', onClick: () => renderRecover() })));
}

// ================================================================= Registrierung
export function renderRegister(prefill = {}, errorMsg = '') {
  const u = field({ label: 'Nutzername', name: 'username', value: prefill.username || '', autocomplete: 'username',
    help: 'Öffentlich sichtbar, damit dich andere finden. 3–32 Zeichen: a–z, 0–9, _ und .',
    attrs: { autocapitalize: 'none', spellcheck: false, minlength: 3, maxlength: 32, pattern: '[A-Za-z0-9_.]{3,32}' } });
  const m = field({ label: 'E-Mail-Adresse', name: 'email', type: 'email', value: prefill.email || '', autocomplete: 'email',
    help: 'Nicht für andere sichtbar.' });
  const p1 = field({ label: 'Passwort (mind. 10 Zeichen)', name: 'password', type: 'password', autocomplete: 'new-password', attrs: { minlength: 10 } });
  const p2 = field({ label: 'Passwort wiederholen', name: 'password2', type: 'password', autocomplete: 'new-password' });
  let bits = Math.min(prefill.bits || 4096, isWebKit() ? 4096 : 8192);
  const note = h('p', { class: 'key-note' });
  const chips = h('div', { class: 'chip-row', role: 'radiogroup', 'aria-label': 'Schlüssellänge' });
  const renderChips = () => {
    clear(chips, S.config.key_bits.map((b) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(b === bits), class: 'chip' + (b === bits ? ' selected' : ''),
      disabled: isWebKit() && b > 4096, title: isWebKit() && b > 4096 ? 'Safari/iOS unterstützt max. 4096 Bit' : null,
      onclick: () => { bits = b; renderChips(); },
    }, b === bits ? icon('check', 18) : null, KEY_INFO[b].label)));
    note.textContent = `${KEY_INFO[bits].note} Erzeugung: ca. ${KEY_INFO[bits].time}.` +
      (isWebKit() ? ' Hinweis: Safari/iOS kann höchstens 4096-Bit-Schlüssel erzeugen.' : '');
  };
  renderChips();
  const err = errorBox();
  err.set(errorMsg);
  const form = h('form', {
    class: 'form', onsubmit: (e) => {
      e.preventDefault();
      err.set('');
      p2.setError('');
      if (p1.input.value !== p2.input.value) { p2.setError('Passwörter stimmen nicht überein'); return; }
      generateAndRegister({ username: u.input.value.trim(), email: m.input.value.trim(), password: p1.input.value, bits });
    },
  }, u.wrap, m.wrap, p1.wrap, p2.wrap,
  h('div', { class: 'group' },
    h('div', { class: 'group-label' }, icon('key', 18), ' Schlüssellänge (RSA)'),
    chips, note,
    h('p', { class: 'muted small' }, 'Dein privater Schlüssel wird jetzt auf diesem Gerät erzeugt und verlässt es nie unverschlüsselt.')),
  err.el, button('Weiter', { type: 'submit', cls: 'wide' }));
  page(brand(), stepper(0), h('h1', { class: 'auth-title' }, 'Konto erstellen'), form,
    button('Ich habe schon ein Konto', { kind: 'text', onClick: () => renderLogin() }));
}

async function generateAndRegister(data) {
  const prog = progress({ value: null });
  const elapsed = h('span', { class: 'mono' }, '0 s');
  const t0 = Date.now();
  const timer = setInterval(() => { elapsed.textContent = `${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
  page(brand(), stepper(1), h('h1', { class: 'auth-title' }, 'Schlüssel werden erzeugt'),
    h('div', { class: 'keygen' },
      h('div', { class: 'keygen-anim', 'aria-hidden': 'true' }, icon('key', 40)),
      prog.el,
      h('p', {}, `RSA-${data.bits}-Schlüsselpaar und ECDSA-Signaturschlüssel werden auf deinem Gerät berechnet … `, elapsed),
      h('p', { class: 'muted small' }, 'Dabei werden große Primzahlen gesucht. Das dauert je nach Gerät unterschiedlich lange – bitte die Seite geöffnet lassen.')));
  try {
    const identity = await generateIdentity(data.bits);
    prog.set(null, 'Schlüssel werden geprüft …');
    await importIdentity({ ...identity }); // erst lokal prüfen, dann Konto anlegen
    prog.set(null, 'Schlüssel-Backup wird verschlüsselt …');
    const recovery = newRecoveryKey();
    const { backup, authHex } = await makeBackup(identity, recovery.bytes, data.username);
    prog.set(null, 'Konto wird angelegt …');
    const res = await api('/auth/register', {
      method: 'POST',
      body: { username: data.username, email: data.email, password: data.password, enc_pub: identity.encPub, sig_pub: identity.sigPub,
        key_bits: data.bits, key_backup: backup, recovery_auth: authHex },
    });
    await saveIdentity(res.user_id, identity, 1);
    clearInterval(timer);
    renderRecoveryKey(recovery.text, data.username, () => render2FA(res.totp, onAuthenticated), { step: 2 });
  } catch (ex) {
    clearInterval(timer);
    renderRegister(data, ex.message || 'Registrierung fehlgeschlagen');
  }
}

// ================================================================= Wiederherstellungsschlüssel anzeigen
export function renderRecoveryKey(text, username, next, { step = null, title = 'Dein Wiederherstellungsschlüssel' } = {}) {
  const groups = text.split('-');
  const check = h('input', { type: 'checkbox', id: 'rk-ok' });
  const nextBtn = button('Weiter', { cls: 'wide', disabled: true, onClick: next });
  check.addEventListener('change', () => { nextBtn.disabled = !check.checked; });
  const download = () => {
    const content = `Vela – Wiederherstellungsschlüssel\n\nNutzername: ${username}\nErstellt: ${new Date().toLocaleString('de-DE')}\n\n${text}\n\n` +
      'Bewahre diesen Schlüssel offline und sicher auf (z. B. ausgedruckt oder im Passwort-Manager).\n' +
      'Mit ihm kannst du dein Konto wiederherstellen und deine Schlüssel auf einem neuen Gerät entsperren.\n' +
      'Wer diesen Schlüssel UND Zugriff auf dein Konto hat, kann deine Nachrichten lesen. Vela kann ihn nicht wiederherstellen.\n';
    const a = h('a', { href: URL.createObjectURL(new Blob([content], { type: 'text/plain' })), download: `vela-wiederherstellung-${username}.txt` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
  page(brand(), step !== null ? stepper(step) : null, h('h1', { class: 'auth-title' }, title),
    h('p', {}, 'Mit diesem Schlüssel stellst du dein Konto wieder her, wenn du Passwort oder Smartphone verlierst – und entsperrst deine Nachrichten auf einem neuen Gerät.'),
    h('div', { class: 'recovery-key', 'aria-label': 'Wiederherstellungsschlüssel' }, groups.map((g) => h('span', {}, g))),
    h('div', { class: 'row gap' },
      button('Als Datei speichern', { kind: 'tonal', icon: 'download', onClick: download }),
      button('Kopieren', { kind: 'text', icon: 'copy', onClick: async () => { try { await navigator.clipboard.writeText(text); snackbar('Kopiert – füge ihn jetzt in deinen Passwort-Manager ein.'); } catch { snackbar('Kopieren nicht möglich'); } } })),
    h('div', { class: 'banner warn' }, icon('warn', 20),
      h('span', {}, 'Vela speichert diesen Schlüssel nicht und kann ihn nicht wiederherstellen. Ohne ihn sind deine Nachrichten auf einem neuen Gerät verloren.')),
    h('label', { class: 'check-row', for: 'rk-ok' }, check, h('span', {}, 'Ich habe den Schlüssel sicher gespeichert.')),
    nextBtn);
}

// ================================================================= 2FA einrichten
export function render2FA(totp, done, { intro } = {}) {
  const c = field({ label: '6-stelliger Code', name: 'code', autocomplete: 'one-time-code', attrs: { inputmode: 'numeric', pattern: '[0-9 ]*', maxlength: 7 } });
  const err = errorBox();
  const submit = button('Bestätigen & loslegen', { type: 'submit', cls: 'wide' });
  const secretGroups = totp.secret.match(/.{1,4}/g).join(' ');
  page(brand(), intro ? null : stepper(3), h('h1', { class: 'auth-title' }, 'Zwei-Faktor-Authentifizierung'),
    intro ? h('div', { class: 'banner info' }, icon('shield', 20), h('span', {}, intro)) : null,
    h('p', {}, 'Scanne den QR-Code mit einer Authenticator-App (z. B. Aegis, 2FAS, Google oder Microsoft Authenticator). Bei jeder Anmeldung brauchst du zusätzlich einen Code aus der App.'),
    h('div', { class: 'qr-wrap' }, h('img', { src: totp.qr, alt: 'QR-Code für die Authenticator-App', width: 220, height: 220, class: 'qr' })),
    h('details', { class: 'secret-details' },
      h('summary', {}, 'QR-Code lässt sich nicht scannen?'),
      h('p', { class: 'small' }, 'Schlüssel manuell eingeben (zeitbasiert, 6 Ziffern, 30 s):'),
      h('code', { class: 'secret' }, secretGroups),
      h('div', { class: 'row gap' },
        button('Kopieren', { kind: 'text', icon: 'copy', onClick: () => navigator.clipboard.writeText(totp.secret).then(() => snackbar('Kopiert')) }),
        h('a', { class: 'btn text', href: totp.uri }, 'In App öffnen'))),
    h('form', {
      class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.set('');
        submit.disabled = true;
        try {
          await api('/auth/2fa/confirm', { method: 'POST', body: { code: c.input.value.replace(/\s/g, '') } });
          await done();
        } catch (ex) { err.set(ex.message); submit.disabled = false; }
      },
    }, c.wrap, err.el, submit));
}

// ================================================================= Konto wiederherstellen
export function renderRecover() {
  const u = field({ label: 'Nutzername', name: 'username', autocomplete: 'username', attrs: { autocapitalize: 'none', spellcheck: false } });
  const rk = h('textarea', { class: 'rk-input', rows: 3, placeholder: 'XXXX-XXXX-XXXX-…', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, required: true, 'aria-label': 'Wiederherstellungsschlüssel' });
  const p1 = field({ label: 'Neues Passwort (mind. 10 Zeichen)', name: 'np', type: 'password', autocomplete: 'new-password', attrs: { minlength: 10 } });
  const err = errorBox();
  const submit = button('Konto wiederherstellen', { type: 'submit', cls: 'wide' });
  page(brand(), h('h1', { class: 'auth-title' }, 'Konto wiederherstellen'),
    h('p', {}, 'Mit deinem Wiederherstellungsschlüssel setzt du Passwort und Zwei-Faktor-Authentifizierung neu und entsperrst deine Schlüssel. Alle anderen Geräte werden abgemeldet.'),
    h('form', {
      class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.set('');
        submit.disabled = true;
        try {
          const bytes = parseRecoveryKey(rk.value);
          const username = u.input.value.trim();
          const res = await api('/auth/recover', { method: 'POST', body: { username, recovery_auth: await recoveryAuth(bytes), new_password: p1.input.value } });
          const identity = await openBackup(res.key_backup, bytes, username);
          await saveIdentity(res.user_id, identity, res.key_version);
          render2FA(res.totp, onAuthenticated, { intro: 'Richte die Zwei-Faktor-Authentifizierung mit deinem (neuen) Gerät neu ein.' });
        } catch (ex) { err.set(ex.message); submit.disabled = false; }
      },
    }, u.wrap, h('div', { class: 'field' }, h('div', { class: 'group-label' }, 'Wiederherstellungsschlüssel'), rk), p1.wrap, err.el, submit),
    button('Zurück zur Anmeldung', { kind: 'text', onClick: () => renderLogin() }));
}

// ================================================================= Schlüssel auf neuem Gerät entsperren
export function renderRestore({ onLogout }) {
  const rk = h('textarea', { class: 'rk-input', rows: 3, placeholder: 'XXXX-XXXX-XXXX-…', autocomplete: 'off', autocapitalize: 'characters', spellcheck: false, required: true, 'aria-label': 'Wiederherstellungsschlüssel' });
  const err = errorBox();
  const submit = button('Schlüssel entsperren', { type: 'submit', cls: 'wide' });
  page(brand(), h('h1', { class: 'auth-title' }, 'Neues Gerät'),
    h('p', {}, `Hallo ${S.me.username}! Auf diesem Gerät sind deine privaten Schlüssel noch nicht vorhanden. Gib deinen Wiederherstellungsschlüssel ein, um dein verschlüsseltes Schlüssel-Backup zu entsperren. Das passiert lokal – der Schlüssel wird nicht an den Server gesendet.`),
    h('form', {
      class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.set('');
        submit.disabled = true;
        try {
          const bytes = parseRecoveryKey(rk.value);
          const { key_backup, key_version } = await api('/keys/backup');
          const identity = await openBackup(key_backup, bytes, S.me.username);
          if (identity.encPub !== S.me.enc_pub) throw new Error('Das Backup gehört zu einem älteren Schlüssel.');
          await saveIdentity(S.me.id, identity, key_version);
          await onAuthenticated();
        } catch (ex) { err.set(ex.message); submit.disabled = false; }
      },
    }, rk, err.el, submit),
    h('div', { class: 'auth-links' },
      button('Schlüssel verloren? Neue Schlüssel erzeugen', { kind: 'text', onClick: () => startRotate({ fromRestore: true }) }),
      button('Abmelden', { kind: 'text', onClick: onLogout })));
}

// ================================================================= Schlüsselrotation
export async function startRotate({ fromRestore = false, onCancel } = {}) {
  const ok = await confirm('Neue Schlüssel erzeugen?',
    'Du bekommst ein neues Schlüsselpaar und einen neuen Wiederherstellungsschlüssel. Bisherige Nachrichten, die mit dem alten Schlüssel verschlüsselt sind, kannst du auf neuen Geräten nicht mehr lesen. Deine Kontakte sehen einen Hinweis, dass sich dein Sicherheitsschlüssel geändert hat.',
    { ok: 'Neue Schlüssel erzeugen', danger: true, icon: 'warn' });
  if (!ok) { onCancel?.(); return; }
  let bits = S.me.key_bits;
  const chips = h('div', { class: 'chip-row' });
  if (isWebKit() && bits > 4096) bits = 4096;
  const renderChips = () => clear(chips, S.config.key_bits.map((b) => h('button', {
    type: 'button', class: 'chip' + (b === bits ? ' selected' : ''), disabled: isWebKit() && b > 4096, onclick: () => { bits = b; renderChips(); },
  }, KEY_INFO[b].label)));
  renderChips();
  const c = field({ label: '2FA-Code', name: 'code', autocomplete: 'one-time-code', attrs: { inputmode: 'numeric', maxlength: 7 } });
  const err = errorBox();
  const prog = progress({ value: null });
  prog.el.hidden = true;
  const submit = button('Schlüssel erzeugen', { type: 'submit', cls: 'wide' });
  page(brand(), h('h1', { class: 'auth-title' }, 'Neue Schlüssel'),
    h('form', {
      class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.set('');
        submit.disabled = true;
        prog.el.hidden = false;
        try {
          const identity = await generateIdentity(bits);
          const recovery = newRecoveryKey();
          const { backup, authHex } = await makeBackup(identity, recovery.bytes, S.me.username);
          const res = await api('/keys/rotate', { method: 'POST', body: { enc_pub: identity.encPub, sig_pub: identity.sigPub, key_bits: bits, key_backup: backup, recovery_auth: authHex, code: c.input.value.replace(/\s/g, '') } });
          await saveIdentity(S.me.id, identity, res.key_version);
          renderRecoveryKey(recovery.text, S.me.username, onAuthenticated, { title: 'Neuer Wiederherstellungsschlüssel' });
        } catch (ex) { err.set(ex.message); submit.disabled = false; prog.el.hidden = true; }
      },
    }, h('div', { class: 'group-label' }, 'Schlüssellänge'), chips, c.wrap, prog.el, err.el, submit),
    button('Abbrechen', { kind: 'text', onClick: () => (fromRestore ? renderRestore({ onLogout: () => location.reload() }) : onCancel?.()) }));
}
