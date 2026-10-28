// Lokaler, gerätegebundener Speicher (IndexedDB). Liegt nur auf diesem Gerät.
//   identity : eigene (nicht exportierbare) Schlüssel pro Nutzer
//   pins     : angeheftete Schlüssel der Kontakte (Trust on First Use + Verifizierung)
//   cache    : entschlüsselte Nachrichteninhalte (spart erneute RSA-Operationen)
//   kv       : Einstellungen dieses Geräts (Theme, Transkription, ausgeblendete Nachrichten)
const DB_NAME = 'vela';
const STORES = ['identity', 'pins', 'cache', 'kv'];
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Datenbank blockiert – bitte andere Vela-Tabs schließen'));
    });
  }
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const get = (store, key) => run(store, 'readonly', (s) => s.get(key));
export const put = (store, key, value) => run(store, 'readwrite', (s) => s.put(value, key));
export const del = (store, key) => run(store, 'readwrite', (s) => s.delete(key));

export async function wipe() {
  const db = await open();
  db.close();
  dbp = null;
  await new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

// Komfort für Geräte-Einstellungen
export async function pref(key, fallback) {
  try { const v = await get('kv', key); return v === undefined ? fallback : v; } catch { return fallback; }
}
export const setPref = (key, value) => put('kv', key, value).catch(() => {});

// ---- Erweiterungen für den Entschlüsselungs-Cache (cache.js)
/** Viele Schlüssel mit EINER Transaktion lesen (viel schneller als einzelne get()-Aufrufe). */
export async function getMany(storeName, keys) {
  if (!keys.length) return [];
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const s = tx.objectStore(storeName);
    const reqs = keys.map((k) => s.get(k));
    tx.oncomplete = () => resolve(reqs.map((r) => r.result));
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

export const clear = (storeName) => run(storeName, 'readwrite', (s) => s.clear());

/** Löscht alle Einträge, für die pred(value) wahr ist. Gibt die Anzahl zurück. */
export async function deleteWhere(storeName, pred) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    let n = 0;
    const req = tx.objectStore(storeName).openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (pred(cur.value)) { cur.delete(); n++; }
      cur.continue();
    };
    tx.oncomplete = () => resolve(n);
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
