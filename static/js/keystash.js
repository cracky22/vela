// Geräte-Kopie der Schlüssel („Quelle“): wird gebraucht, um Schlüssel per QR-Code an ein neues Gerät weiterzugeben
// und um den Schlüsseltresor ohne Wiederherstellungsschlüssel einzurichten.
//
// Die normalen Schlüssel in IndexedDB sind absichtlich nicht auslesbar. Damit sie sich weitergeben lassen, liegt hier
// zusätzlich eine mit einem gerätegebundenen, nicht auslesbaren AES-Schlüssel verschlüsselte Kopie. Wer Skripte auf der
// Seite ausführen kann, könnte sie lesen – das ist der Preis der Weitergabe. Beim Abmelden mit „Daten entfernen“ wird
// die ganze lokale Datenbank samt Kopie gelöscht.
import * as store from './store.js';

const subtle = globalThis.crypto?.subtle;
const enc = new TextEncoder(), dec = new TextDecoder();
let keyPromise = null;

function deviceKey() {
  keyPromise ||= (async () => {
    let k = await store.get('kv', 'stash-aes').catch(() => null);
    if (!k) {
      k = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await store.put('kv', 'stash-aes', k);
    }
    return k;
  })().catch((e) => { keyPromise = null; throw e; });
  return keyPromise;
}

const aad = (userId) => enc.encode(`vela-stash-v1|${userId}`);

export async function stashIdentity(userId, identity, keyVersion) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(userId) }, await deviceKey(),
    enc.encode(JSON.stringify({ identity, keyVersion })));
  await store.put('kv', 'stash:' + userId, { v: 1, iv, ct });
}

/** @returns {Promise<{identity: object, keyVersion: number} | null>} */
export async function readStash(userId) {
  const e = await store.get('kv', 'stash:' + userId).catch(() => null);
  if (!e || e.v !== 1) return null;
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: e.iv, additionalData: aad(userId) }, await deviceKey(), e.ct);
    return JSON.parse(dec.decode(pt));
  } catch { return null; }
}

export const clearStash = (userId) => store.del('kv', 'stash:' + userId).catch(() => {});