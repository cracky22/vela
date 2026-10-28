// Lokaler Entschlüsselungs-Cache (IndexedDB, Speicher „cache“).
//
// * Einmal entschlüsselte Nachrichten werden verschlüsselt auf dem Gerät abgelegt (AES-GCM mit einem
//   gerätegebundenen, nicht auslesbaren Schlüssel) – die aufwendige RSA-Entschlüsselung entfällt beim nächsten Laden.
// * Beim Öffnen eines Chats wird der Cache für alle Nachrichten mit EINER Datenbankabfrage geladen (cachePrefetch).
// * Alte Einträge werden aufgeräumt (cachePrune); der Admin kann den Cache aller Nutzer leeren (applyCacheEpoch).
// * Schlüssel, angeheftete Kontakt-Schlüssel und Einstellungen werden NIE angefasst.
import * as store from './store.js';
import { S, cacheKey } from './state.js';

const subtle = globalThis.crypto?.subtle;
const mem = new Map();          // Nachrichten-ID -> { payload } (nur diese Sitzung, Klartext im Arbeitsspeicher)
let aes = null;
const enc = new TextEncoder(), dec = new TextDecoder();

async function key() {
  if (aes) return aes;
  aes = await store.get('kv', 'cache-aes').catch(() => null);
  if (!aes) {
    aes = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await store.put('kv', 'cache-aes', aes).catch(() => {});
  }
  return aes;
}

const aad = (id) => enc.encode(`vela-cache-v1|${S.me?.id}|${id}`);

async function seal(id, res) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad(id) }, await key(), enc.encode(JSON.stringify(res)));
  return { v: 2, iv, ct, at: Date.now() };
}

async function open(id, entry) {
  if (!entry) return null;
  if (entry.v !== 2) return entry.payload ? entry : null;   // Altbestand (Klartext): wird beim Lesen neu verschlüsselt
  try {
    const pt = await subtle.decrypt({ name: 'AES-GCM', iv: entry.iv, additionalData: aad(id) }, await key(), entry.ct);
    return JSON.parse(dec.decode(pt));
  } catch { return null; }                                   // anderer Nutzer/Schlüssel gewechselt -> neu entschlüsseln
}

export async function cacheGet(id) {
  if (mem.has(id)) return mem.get(id);
  const entry = await store.get('cache', cacheKey(id)).catch(() => null);
  const res = await open(id, entry);
  if (res) {
    mem.set(id, res);
    if (entry.v !== 2) cachePut(id, res);                    // Altbestand migrieren
  }
  return res;
}

export async function cachePut(id, res) {
  mem.set(id, res);
  try { await store.put('cache', cacheKey(id), await seal(id, res)); } catch { /* Cache ist nur eine Beschleunigung */ }
}

export function cacheDel(id) {
  mem.delete(id);
  return store.del('cache', cacheKey(id)).catch(() => {});
}

/** Lädt die Cache-Einträge vieler Nachrichten mit einer einzigen Transaktion in den Arbeitsspeicher. */
export async function cachePrefetch(ids) {
  const need = ids.filter((id) => !mem.has(id));
  if (!need.length) return 0;
  const entries = await store.getMany('cache', need.map(cacheKey)).catch(() => []);
  let hits = 0;
  await Promise.all(need.map(async (id, i) => {
    const res = await open(id, entries[i]);
    if (res) { mem.set(id, res); hits++; if (entries[i].v !== 2) cachePut(id, res); }
  }));
  return hits;
}

/** Entfernt Einträge, die älter sind als die Aufbewahrungszeit des Servers (+ 7 Tage Puffer). */
export async function cachePrune(retentionDays = 30) {
  const limit = Date.now() - (retentionDays + 7) * 86400000;
  try { return await store.deleteWhere('cache', (v) => v?.v === 2 && v.at < limit); } catch { return 0; }
}

export async function clearCache() {
  mem.clear();
  await store.clear('cache').catch(() => {});
}

export function cacheMemoryClear() { mem.clear(); }

/** Admin hat den Cache geleert (Epoche ist größer als die zuletzt angewendete) -> lokal leeren. */
export async function applyCacheEpoch(epoch, onCleared) {
  if (!epoch) return false;
  const seen = (await store.pref('cache_epoch', 0)) || 0;
  if (epoch <= seen) return false;
  await store.setPref('cache_epoch', epoch);                 // zuerst merken, damit es nie in einer Schleife endet
  await clearCache();
  onCleared?.();
  return true;
}