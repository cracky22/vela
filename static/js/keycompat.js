// Kompatibilitätsschicht für Safari/WebKit (auch Chrome & Firefox auf iOS – dort ist WebKit Pflicht).
//
// Bekannte WebKit-Einschränkungen, die sonst "Data provided to an operation does not meet
// requirements" (DataError) auslösen:
//   1. PKCS#8-EC-Schlüssel werden nur in einer bestimmten Kodierung akzeptiert
//      (WebKit-Bug 233705) – auch selbst exportierte Schlüssel können scheitern.
//   2. RSA-Schlüssel über 4096 Bit werden nicht unterstützt.
// Lösung: Schlüssel als JWK speichern, alte PKCS#8-Schlüssel per DER-Parser umwandeln und für
// RSA-Schlüssel, die der Browser ablehnt, RSA-OAEP (SHA-256, RFC 8017) in JavaScript ausführen.
import { b64, unb64 } from './util.js';

const subtle = globalThis.crypto?.subtle;

// ---------------------------------------------------------------- Base64url & BigInt
export const b64url = (bytes) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const unb64url = (s) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
const toBig = (bytes) => { let x = 0n; for (const b of bytes) x = (x << 8n) | BigInt(b); return x; };
function toBytes(x, len) {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}
const stripZeros = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; return b.subarray(i); };

// ---------------------------------------------------------------- Minimaler DER-Parser
function tlv(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i];
    hdr = 2 + n;
  }
  const start = pos + hdr;
  if (start + len > buf.length) throw new Error('DER: Länge außerhalb der Daten');
  return { tag, start, end: start + len, value: buf.subarray(start, start + len) };
}
function children(buf) {
  const out = [];
  for (let p = 0; p < buf.length;) { const t = tlv(buf, p); out.push(t); p = t.end; }
  return out;
}

/** SPKI (RSA) -> { n, e } als Bytes */
export function spkiToRsa(spki) {
  const [algo, bitstr] = children(tlv(spki, 0).value);
  if (!algo || bitstr?.tag !== 0x03) throw new Error('SPKI ungültig');
  const rsaPub = tlv(bitstr.value.subarray(1), 0); // erstes Byte = ungenutzte Bits
  const [n, e] = children(rsaPub.value);
  return { n: stripZeros(n.value), e: stripZeros(e.value) };
}

/** SPKI (EC P-256) -> JWK-Felder x, y */
export function spkiToEcXY(spki) {
  const bitstr = children(tlv(spki, 0).value)[1];
  const point = bitstr.value.subarray(1);
  if (point[0] !== 0x04 || point.length !== 65) throw new Error('EC-Punkt nicht unkomprimiert');
  return { x: b64url(point.subarray(1, 33)), y: b64url(point.subarray(33, 65)) };
}

function pkcs8Inner(pkcs8) {
  // PrivateKeyInfo ::= SEQUENCE { version, AlgorithmIdentifier, OCTET STRING privateKey, ... }
  const parts = children(tlv(pkcs8, 0).value);
  const octet = parts.find((p, i) => i >= 2 && p.tag === 0x04);
  if (!octet) throw new Error('PKCS#8 ungültig');
  return octet.value;
}

/** PKCS#8 (RSA) -> JWK (private) */
export function pkcs8RsaToJwk(pkcs8) {
  const f = children(tlv(pkcs8Inner(pkcs8), 0).value).map((t) => b64url(stripZeros(t.value)));
  // RSAPrivateKey: version, n, e, d, p, q, dp, dq, qi
  return { kty: 'RSA', n: f[1], e: f[2], d: f[3], p: f[4], q: f[5], dp: f[6], dq: f[7], qi: f[8], alg: 'RSA-OAEP-256', ext: true };
}

/** PKCS#8 (EC) + SPKI -> JWK (private). x/y kommen aus dem öffentlichen Schlüssel, da sie in
 *  manchen PKCS#8-Kodierungen fehlen. */
export function pkcs8EcToJwk(pkcs8, spki) {
  const ecPriv = children(tlv(pkcs8Inner(pkcs8), 0).value); // version, OCTET STRING d, [0] params?, [1] pub?
  const d = ecPriv.find((t) => t.tag === 0x04);
  if (!d) throw new Error('EC-Schlüssel ungültig');
  const dBytes = new Uint8Array(32);
  dBytes.set(d.value.subarray(Math.max(0, d.value.length - 32)), 32 - Math.min(32, d.value.length));
  return { kty: 'EC', crv: 'P-256', d: b64url(dBytes), ...spkiToEcXY(spki), ext: true };
}

// ---------------------------------------------------------------- RSA-OAEP (SHA-256) in JavaScript
function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return result;
}

async function sha256(data) { return new Uint8Array(await subtle.digest('SHA-256', data)); }

async function mgf1(seed, len) {
  const out = new Uint8Array(len);
  const buf = new Uint8Array(seed.length + 4);
  buf.set(seed);
  for (let c = 0, off = 0; off < len; c++) {
    new DataView(buf.buffer).setUint32(seed.length, c);
    const h = await sha256(buf);
    out.set(h.subarray(0, Math.min(32, len - off)), off);
    off += 32;
  }
  return out;
}

const L_HASH = sha256(new Uint8Array(0));

export async function jsOaepEncrypt({ n, e }, msg) {
  const N = toBig(n), E = toBig(e);
  const k = n.length, hLen = 32;
  if (msg.length > k - 2 * hLen - 2) throw new Error('Nachricht zu lang für RSA-OAEP');
  const db = new Uint8Array(k - hLen - 1);
  db.set(await L_HASH, 0);
  db[k - msg.length - hLen - 2] = 0x01;
  db.set(msg, k - msg.length - hLen - 1);
  const seed = crypto.getRandomValues(new Uint8Array(hLen));
  const dbMask = await mgf1(seed, db.length);
  for (let i = 0; i < db.length; i++) db[i] ^= dbMask[i];
  const seedMask = await mgf1(db, hLen);
  for (let i = 0; i < hLen; i++) seed[i] ^= seedMask[i];
  const em = new Uint8Array(k);
  em.set(seed, 1);
  em.set(db, 1 + hLen);
  return toBytes(modPow(toBig(em), E, N), k);
}

export async function jsOaepDecrypt(key, ct) {
  const b = (s) => toBig(unb64url(s));
  const memo = key._big || (key._big = { n: b(key.n), p: b(key.p), q: b(key.q), dp: b(key.dp), dq: b(key.dq), qi: b(key.qi), k: stripZeros(unb64url(key.n)).length });
  const { n, p, q, dp, dq, qi, k } = memo;
  const c = toBig(ct);
  if (c >= n) throw new Error('Entschlüsselung fehlgeschlagen');
  // Chinesischer Restsatz
  const m1 = modPow(c, dp, p), m2 = modPow(c, dq, q);
  const hh = (qi * (((m1 - m2) % p) + p)) % p;
  const em = toBytes(m2 + hh * q, k);
  const hLen = 32;
  const maskedSeed = em.subarray(1, 1 + hLen), maskedDb = em.subarray(1 + hLen);
  const seed = await mgf1(maskedDb, hLen);
  for (let i = 0; i < hLen; i++) seed[i] ^= maskedSeed[i];
  const db = await mgf1(seed, maskedDb.length);
  for (let i = 0; i < db.length; i++) db[i] ^= maskedDb[i];
  const lHash = await L_HASH;
  let bad = em[0];
  for (let i = 0; i < hLen; i++) bad |= db[i] ^ lHash[i];
  let idx = hLen;
  while (idx < db.length && db[idx] === 0) idx++;
  if (bad || db[idx] !== 0x01) throw new Error('Entschlüsselung fehlgeschlagen');
  return db.slice(idx + 1);
}

/** Prüft, ob der Browser eine RSA-Schlüssellänge nativ erzeugen kann (Safari: max. 4096). */
export function isWebKit() {
  const ua = navigator.userAgent;
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg|OPR|Firefox/.test(ua) || /CriOS|FxiOS|EdgiOS/.test(ua);
}
