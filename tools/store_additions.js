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