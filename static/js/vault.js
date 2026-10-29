// Schlüsseltresor: privater Schlüssel, mit einem aus dem Passwort abgeleiteten Schlüssel verpackt, auf dem Server.
// Aus dem Passwort entstehen per Argon2id zwei getrennte Werte: `auth` (geht an den Server, nur dessen Hash wird
// gespeichert) und `wrap` (bleibt im Browser, verpackt die Schlüssel). Der Server sieht das Passwort nicht.
import { b64, unb64, utf8, fromUtf8, hex, h } from './util.js';
import { api } from './api.js';
import { field, button } from './ui.js';
import { S, saveIdentity } from './state.js';
import { openBackup, parseRecoveryKey } from './crypto.js';
import { stashIdentity, readStash } from './keystash.js';

const subtle = globalThis.crypto?.subtle;
const SALT = utf8('vela-vault-v1');
let pending = null;           // { wrap, username } nach einer Tresor-Anmeldung, bis die Schlüssel entpackt sind
let argonP = null;

export function loadClassic(src, ready) {
  if (ready()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => (ready() ? resolve() : reject(new Error('Bibliothek konnte nicht geladen werden')));
    s.onerror = () => reject(new Error('Bibliothek konnte nicht geladen werden'));
    document.head.append(s);
  });
}

function argon() {
  argonP ||= loadClassic(new URL('./vendor/argon2.umd.min.js', import.meta.url).href, () => globalThis.hashwasm?.argon2id)
    .then(() => globalThis.hashwasm)
    .catch((e) => { argonP = null; throw e; });
  return argonP;
}

export const newKdf = () => ({ alg: 'argon2id', salt: b64(crypto.getRandomValues(new Uint8Array(16))), t: 3, m: 65536, p: 1 });

/** Passwort -> { auth: Hex-String für den Server, wrap: nicht auslesbarer AES-Schlüssel }. */
export async function deriveKeys(password, kdf) {
  if (kdf.alg !== 'argon2id') throw new Error('Unbekanntes Ableitungsverfahren');
  const { argon2id } = await argon();
  const raw = await argon2id({ password: utf8(password.normalize('NFKC')), salt: unb64(kdf.salt), parallelism: kdf.p,
    iterations: kdf.t, memorySize: kdf.m, hashLength: 32, outputType: 'binary' });
  const ikm = await subtle.importKey('raw', raw, 'HKDF', false, ['deriveBits', 'deriveKey']);
  raw.fill(0);
  const auth = hex(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: utf8('auth') }, ikm, 256));
  const wrap = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: SALT, info: utf8('wrap') }, ikm,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { auth, wrap };
}

const aad = (username) => utf8('vela-vault-v1|' + username.toLowerCase());

export async function sealIdentity(identity, wrap, username) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(username) }, wrap, utf8(JSON.stringify(identity)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) });
}

export async function openIdentity(blob, wrap, username) {
  const o = JSON.parse(blob);
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(o.iv), additionalData: aad(username) }, wrap, unb64(o.ct));
    return JSON.parse(fromUtf8(pt));
  } catch { throw new Error('Passwort falsch oder Tresor beschädigt'); }
}

// ---------------------------------------------------------------- Anmeldung
/** Meldet mit dem Tresor an, falls der Nutzer einen hat (sonst null -> normale Anmeldung). */
export async function vaultLogin(username, password, code) {
  let info;
  try { info = await api('/vault/kdf', { method: 'POST', body: { username } }); } catch { return null; }
  if (!info.vault) return null;
  const { auth, wrap } = await deriveKeys(password, info.kdf);
  const res = await api('/vault/login', { method: 'POST', body: { username, auth, code } });
  pending = { wrap, username: username.toLowerCase() };
  return res;
}

async function unlockFrom(v, wrap, me) {
  const identity = await openIdentity(v.blob, wrap, me.username);
  if (identity.encPub !== me.enc_pub) throw new Error('Der Tresor enthält veraltete Schlüssel. Bitte mit dem Wiederherstellungsschlüssel entsperren.');
  await saveIdentity(me.id, identity, v.key_version);
  return true;
}

/** Nach der Tresor-Anmeldung: Schlüssel ohne weitere Eingabe entpacken. */
export async function unlockFromVault(me) {
  if (!pending || pending.username !== me.username.toLowerCase()) return false;
  const { wrap } = pending;
  pending = null;
  return unlockFrom(await api('/vault'), wrap, me);
}

export async function unlockWithPassword(me, password) {
  const v = await api('/vault');
  return unlockFrom(v, (await deriveKeys(password, v.kdf)).wrap, me);
}

// ---------------------------------------------------------------- Einrichten / Abschalten
export const vaultStatus = () => api('/vault/status');

/** Schlüssel aus der Geräte-Kopie, sonst aus dem Backup (Wiederherstellungsschlüssel nötig). */
export async function sourceIdentity(recoveryText) {
  const me = S.me;
  const stash = await readStash(me.id);
  if (stash) return stash;
  if (!recoveryText) throw new Error('Bitte den Wiederherstellungsschlüssel eingeben');
  const { key_backup, key_version } = await api('/keys/backup');
  const identity = await openBackup(key_backup, parseRecoveryKey(recoveryText), me.username);
  if (identity.encPub !== me.enc_pub) throw new Error('Das Backup gehört zu einem älteren Schlüssel.');
  await stashIdentity(me.id, identity, key_version);
  return { identity, keyVersion: key_version };
}

export async function enableVault({ password, code, recoveryText }) {
  const { identity } = await sourceIdentity(recoveryText);
  const kdf = newKdf();
  const { auth, wrap } = await deriveKeys(password, kdf);
  const blob = await sealIdentity(identity, wrap, S.me.username);
  await api('/vault', { method: 'PUT', body: { password, code, kdf, blob, auth } });
}

export const disableVault = ({ password, code }) => api('/vault/disable', { method: 'POST', body: { password, code } });

// ---------------------------------------------------------------- Oberfläche „Mit Passwort entsperren“
export function vaultUnlockSlot(ui) {
  const slot = h('div', { class: 'vault-slot' });
  api('/vault/status').then((st) => {
    if (st.enabled) slot.append(button('Mit Passwort entsperren', { kind: 'tonal', cls: 'wide', onClick: () => renderVaultUnlock(ui) }));
  }).catch(() => {});
  return slot;
}

function renderVaultUnlock({ page, brand, onDone, onLogout }) {
  const pw = field({ label: 'Passwort', name: 'password', type: 'password', autocomplete: 'current-password' });
  const err = h('div', { class: 'form-error', role: 'alert' });
  const submit = button('Entsperren', { type: 'submit', cls: 'wide' });
  const label = (t) => { submit.querySelector('span').textContent = t; };
  page(brand('Schlüsseltresor'), h('h1', { class: 'auth-title' }, 'Mit Passwort entsperren'),
    h('p', {}, 'Dein Schlüsseltresor wird mit deinem Passwort auf diesem Gerät geöffnet. Das Passwort verlässt dieses Gerät dabei nicht.'),
    h('form', {
      class: 'form', onsubmit: async (e) => {
        e.preventDefault();
        err.classList.remove('show');
        submit.disabled = true; label('Wird geöffnet …');
        try { await unlockWithPassword(S.me, pw.input.value); await onDone(); } catch (ex) {
          err.textContent = ex.message; err.classList.add('show');
          submit.disabled = false; label('Entsperren');
        }
      },
    }, pw.wrap, err, submit),
    h('div', { class: 'auth-links' }, button('Abmelden', { kind: 'text', onClick: onLogout })));
}