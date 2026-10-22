// Ende-zu-Ende-Verschlüsselung mit der Web Crypto API (im Browser, nie auf dem Server).
//
// Identität pro Nutzer:
//   * RSA-OAEP (SHA-256), 2048–8192 Bit  -> Verschlüsselung (Schlüsselkapselung)
//   * ECDSA P-256 (SHA-256)              -> Signaturen (Absender-Authentizität)
// Nachrichten: hybrid. Pro Nachricht ein zufälliger AES-256-GCM-Schlüssel; dieser wird für
// jeden Empfänger (und den Absender selbst) mit RSA-OAEP verschlüsselt. Der Umschlag wird
// mit ECDSA signiert. Dateien: AES-256-GCM in 1-MiB-Blöcken (STREAM-artig, Kürzungsschutz).
import { b64, unb64, utf8, fromUtf8, hex } from './util.js';
import { pkcs8RsaToJwk, pkcs8EcToJwk, spkiToRsa, spkiToEcXY, jsOaepEncrypt, jsOaepDecrypt, b64url } from './keycompat.js';

const subtle = globalThis.crypto?.subtle;
export const cryptoAvailable = () => !!subtle && window.isSecureContext;

const RSA_IMPORT = { name: 'RSA-OAEP', hash: 'SHA-256' };
const EC = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

export class CryptoError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

// ---------------------------------------------------------------- Identität
// Format v2: private Schlüssel als JWK (funktioniert in allen Browsern inkl. Safari/iOS).
// Format v1 (PKCS#8) wird beim Import weiterhin akzeptiert und bei Bedarf umgewandelt.
export async function generateIdentity(bits) {
  let enc;
  try {
    enc = await subtle.generateKey({ name: 'RSA-OAEP', modulusLength: bits, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true, ['encrypt', 'decrypt']);
  } catch (e) {
    throw new CryptoError('keygen', bits > 4096
      ? `Dieser Browser kann keine ${bits}-Bit-RSA-Schlüssel erzeugen (Safari/iOS unterstützt max. 4096 Bit). Bitte 4096 Bit wählen.`
      : `Schlüsselerzeugung fehlgeschlagen: ${e.message}`);
  }
  const sig = await subtle.generateKey(EC, true, ['sign', 'verify']);
  return {
    v: 2,
    bits,
    encPub: b64(await subtle.exportKey('spki', enc.publicKey)),
    sigPub: b64(await subtle.exportKey('spki', sig.publicKey)),
    encJwk: await subtle.exportKey('jwk', enc.privateKey),
    sigJwk: await subtle.exportKey('jwk', sig.privateKey),
  };
}

async function tryAll(attempts) {
  let last;
  for (const fn of attempts) {
    try { return await fn(); } catch (e) { last = e; }
  }
  throw last;
}

// Private Schlüssel werden – wenn der Browser es kann – als NICHT exportierbare CryptoKeys
// gespeichert: Skripte können sie benutzen, aber nicht auslesen. Lehnt der Browser einen
// RSA-Schlüssel ab (Safari > 4096 Bit), wird er als JWK für die JavaScript-Implementierung
// gespeichert (siehe SPEC.md, A1).
export async function importIdentity(id) {
  const encJwk = id.encJwk || (id.encPriv ? pkcs8RsaToJwk(unb64(id.encPriv)) : null);
  const sigJwk = id.sigJwk || (id.sigPriv ? pkcs8EcToJwk(unb64(id.sigPriv), unb64(id.sigPub)) : null);
  if (!encJwk || !sigJwk) throw new CryptoError('identity', 'Schlüssel-Backup unvollständig');
  const { alg: _a, key_ops: _k, ext: _e, use: _u, ...encFields } = encJwk;
  const { key_ops: _k2, ext: _e2, use: _u2, ...sigFields } = sigJwk;
  let encPriv;
  try {
    encPriv = await tryAll([
      () => subtle.importKey('jwk', { ...encFields, alg: 'RSA-OAEP-256', ext: true }, RSA_IMPORT, false, ['decrypt']),
      ...(id.encPriv ? [() => subtle.importKey('pkcs8', unb64(id.encPriv), RSA_IMPORT, false, ['decrypt'])] : []),
    ]);
  } catch {
    encPriv = { js: true, ...encFields }; // Fallback: RSA-OAEP in JavaScript
  }
  let sigPriv;
  try {
    sigPriv = await tryAll([
      () => subtle.importKey('jwk', { ...sigFields, ext: true }, EC, false, ['sign']),
      ...(id.sigPriv ? [() => subtle.importKey('pkcs8', unb64(id.sigPriv), EC, false, ['sign'])] : []),
    ]);
  } catch (e) {
    throw new CryptoError('identity', `Signaturschlüssel kann in diesem Browser nicht geladen werden (${e.message})`);
  }
  return { bits: id.bits, encPubB64: id.encPub, sigPubB64: id.sigPub, encPriv, sigPriv };
}

const pubCache = new Map();
/** Öffentlicher RSA-Schlüssel: CryptoKey oder (Safari, > 4096 Bit) {js, n, e} */
export async function importEncPub(spkiB64) {
  const k = 'e' + spkiB64;
  if (!pubCache.has(k)) {
    let key;
    try { key = await subtle.importKey('spki', unb64(spkiB64), RSA_IMPORT, false, ['encrypt']); } catch { key = { js: true, ...spkiToRsa(unb64(spkiB64)) }; }
    pubCache.set(k, key);
  }
  return pubCache.get(k);
}
export async function importSigPub(spkiB64) {
  const k = 's' + spkiB64;
  if (!pubCache.has(k)) {
    const key = await tryAll([
      () => subtle.importKey('spki', unb64(spkiB64), EC, false, ['verify']),
      () => subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', ...spkiToEcXY(unb64(spkiB64)), ext: true }, EC, false, ['verify']),
    ]);
    pubCache.set(k, key);
  }
  return pubCache.get(k);
}

async function rsaWrap(spkiB64, raw) {
  const key = await importEncPub(spkiB64);
  if (key.js) return jsOaepEncrypt(key, raw);
  return new Uint8Array(await subtle.encrypt({ name: 'RSA-OAEP' }, key, raw));
}
async function rsaUnwrap(priv, data) {
  if (priv.js) return jsOaepDecrypt(priv, data);
  return new Uint8Array(await subtle.decrypt({ name: 'RSA-OAEP' }, priv, data));
}
export { b64url };

// ---------------------------------------------------------------- Wiederherstellungsschlüssel
// 240 Bit Zufall, Base32 (RFC 4648), 12 Gruppen à 4 Zeichen.
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newRecoveryKey() {
  const bytes = rand(30);
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return { bytes, text: out.match(/.{4}/g).join('-') };
}

export function parseRecoveryKey(text) {
  const clean = (text || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/0/g, 'O').replace(/1/g, 'I').replace(/8/g, 'B');
  if (clean.length !== 48 || /[^A-Z2-7]/.test(clean)) throw new CryptoError('recovery_format', 'Der Wiederherstellungsschlüssel hat 48 Zeichen (A–Z, 2–7).');
  const out = new Uint8Array(30);
  let bits = 0, value = 0, i = 0;
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out[i++] = (value >>> (bits - 8)) & 255; bits -= 8; }
  }
  return out;
}

async function recoveryMaterial(bytes) {
  const ikm = await subtle.importKey('raw', bytes, 'HKDF', false, ['deriveBits', 'deriveKey']);
  const salt = utf8('vela-recovery-v1');
  const auth = await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8('auth') }, ikm, 256);
  const key = await subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: utf8('backup') }, ikm,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  return { authHex: hex(auth), key };
}

export async function recoveryAuth(bytes) { return (await recoveryMaterial(bytes)).authHex; }

// Verschlüsseltes Schlüssel-Backup: nur mit dem Wiederherstellungsschlüssel lesbar.
// Der Server erhält nur das Backup und einen davon unabhängig abgeleiteten Auth-Wert.
export async function makeBackup(identity, recoveryBytes, username) {
  const { authHex, key } = await recoveryMaterial(recoveryBytes);
  const iv = rand(12);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8('vela-key-backup-v1|' + username.toLowerCase()) },
    key, utf8(JSON.stringify(identity)));
  return { backup: JSON.stringify({ v: 1, iv: b64(iv), ct: b64(ct) }), authHex };
}

export async function openBackup(backupStr, recoveryBytes, username) {
  const { key } = await recoveryMaterial(recoveryBytes);
  const b = JSON.parse(backupStr);
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(b.iv), additionalData: utf8('vela-key-backup-v1|' + username.toLowerCase()) },
      key, unb64(b.ct));
    return JSON.parse(fromUtf8(pt));
  } catch {
    throw new CryptoError('recovery_wrong', 'Wiederherstellungsschlüssel passt nicht zu diesem Konto.');
  }
}

// ---------------------------------------------------------------- Nachrichten
const aadOf = (id, from, to) => `vela-msg-v1|${id}|${from}|${to}`;

/**
 * @param recipients [{id, encPub}] – jeder bekommt den AES-Schlüssel RSA-OAEP-verschlüsselt
 */
export async function sealMessage({ id, from, to, payload, recipients, signKey, kv }) {
  const aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const iv = rand(12);
  const aad = aadOf(id, from, to);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad) }, aes, utf8(JSON.stringify(payload)));
  const raw = new Uint8Array(await subtle.exportKey('raw', aes));
  const k = {};
  for (const r of recipients) k[r.id] = b64(await rsaWrap(r.encPub, raw));
  raw.fill(0);
  const ivB = b64(iv), ctB = b64(ct);
  const sig = b64(await subtle.sign(SIG, signKey, utf8(`${aad}|${ivB}|${ctB}`)));
  return JSON.stringify({ v: 1, iv: ivB, ct: ctB, k, sig, kv });
}

export async function openMessage({ envelope, id, from, to, me, decKey, verifyKey }) {
  const env = typeof envelope === 'string' ? JSON.parse(envelope) : envelope;
  const aad = aadOf(id, from, to);
  if (!verifyKey) throw new CryptoError('no_key', 'Kein Signaturschlüssel des Absenders bekannt');
  const ok = await subtle.verify(SIG, verifyKey, unb64(env.sig), utf8(`${aad}|${env.iv}|${env.ct}`));
  if (!ok) throw new CryptoError('signature', 'Signatur ungültig – Nachricht wurde verändert oder stammt nicht vom Absender');
  const wrapped = env.k?.[me];
  if (!wrapped) throw new CryptoError('not_for_me', 'Nachricht ist nicht für dieses Konto verschlüsselt');
  let raw;
  try {
    raw = await rsaUnwrap(decKey, unb64(wrapped));
  } catch {
    throw new CryptoError('decrypt', 'Entschlüsselung fehlgeschlagen (anderer Schlüssel?)');
  }
  const aes = await subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  raw.fill(0);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv), additionalData: utf8(aad) }, aes, unb64(env.ct));
  return { payload: JSON.parse(fromUtf8(pt)), kv: env.kv };
}

export function envelopeKeyVersion(envelope) {
  try { return JSON.parse(envelope).kv || 1; } catch { return 1; }
}

// ---------------------------------------------------------------- Dateien
export const FILE_CHUNK = 1 << 20; // 1 MiB Klartext pro Block

function chunkIv(prefix, i) {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  new DataView(iv.buffer).setUint32(8, i);
  return iv;
}

export async function encryptFile(buf, onProgress) {
  const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt']);
  const prefix = rand(8);
  const n = Math.max(1, Math.ceil(buf.byteLength / FILE_CHUNK));
  const parts = [];
  for (let i = 0; i < n; i++) {
    const start = i * FILE_CHUNK;
    const len = Math.min(FILE_CHUNK, buf.byteLength - start);
    const last = i === n - 1 ? 1 : 0;
    parts.push(await subtle.encrypt({ name: 'AES-GCM', iv: chunkIv(prefix, i), additionalData: utf8(`vela-file-v1|${i}|${last}`) },
      key, new Uint8Array(buf, start, Math.max(0, len))));
    onProgress?.((i + 1) / n);
  }
  const raw = await subtle.exportKey('raw', key);
  return { blob: new Blob(parts, { type: 'application/octet-stream' }), key: b64(raw), nonce: b64(prefix), chunk: FILE_CHUNK };
}

export async function decryptFile(cipherBuf, { key, nonce, chunk }, onProgress) {
  const k = await subtle.importKey('raw', unb64(key), 'AES-GCM', false, ['decrypt']);
  const prefix = unb64(nonce);
  const encChunk = chunk + 16;
  const n = Math.max(1, Math.ceil(cipherBuf.byteLength / encChunk));
  const out = new Uint8Array(cipherBuf.byteLength - 16 * n);
  let off = 0;
  for (let i = 0; i < n; i++) {
    const start = i * encChunk;
    const len = Math.min(encChunk, cipherBuf.byteLength - start);
    const last = i === n - 1 ? 1 : 0;
    let pt;
    try {
      pt = await subtle.decrypt({ name: 'AES-GCM', iv: chunkIv(prefix, i), additionalData: utf8(`vela-file-v1|${i}|${last}`) },
        k, new Uint8Array(cipherBuf, start, len));
    } catch {
      throw new CryptoError('file_corrupt', 'Datei beschädigt oder manipuliert');
    }
    out.set(new Uint8Array(pt), off);
    off += pt.byteLength;
    onProgress?.((i + 1) / n);
  }
  return out;
}

// ---------------------------------------------------------------- Fingerabdrücke
export async function fingerprint(encPub, sigPub) {
  const a = unb64(encPub), b = unb64(sigPub);
  const buf = new Uint8Array(a.length + b.length);
  buf.set(a); buf.set(b, a.length);
  return new Uint8Array(await subtle.digest('SHA-256', buf));
}

function fpDigits(fp) {
  const groups = [];
  for (let i = 0; i < 6; i++) {
    let v = 0;
    for (let j = 0; j < 5; j++) v = v * 256 + fp[i * 5 + j];
    groups.push(String(v % 100000).padStart(5, '0'));
  }
  return groups;
}

// Sicherheitsnummer: 60 Ziffern, bei beiden Gesprächspartnern identisch (nach ID sortiert)
export async function safetyNumber(a, b) {
  const [x, y] = [a, b].sort((p, q) => (p.id < q.id ? -1 : 1));
  const fx = await fingerprint(x.encPub, x.sigPub);
  const fy = await fingerprint(y.encPub, y.sigPub);
  return [...fpDigits(fx), ...fpDigits(fy)];
}

export async function shortFingerprint(encPub, sigPub) {
  const fp = await fingerprint(encPub, sigPub);
  return hex(fp.slice(0, 16)).toUpperCase().match(/.{4}/g).join(' ');
}
