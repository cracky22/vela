// Gemeinsamer Anwendungszustand.
import * as store from './store.js';
import { importIdentity } from './crypto.js';

export const S = {
  me: null,            // Antwort von /api/me
  keys: null,          // { encPriv, sigPriv (nicht exportierbar), encPubB64, sigPubB64, bits, keyVersion }
  config: { max_upload_bytes: 100 * 1024 * 1024, retention_days: 30, key_bits: [2048, 3072, 4096, 8192] },
  contacts: new Map(), // id -> Kontakt
  pins: new Map(),     // id -> angehefteter Schlüssel
  chat: null,          // geöffneter Kontakt
  messages: new Map(), // Kontakt-ID -> Nachrichten (aufsteigend)
  hasMore: new Map(),
  decoded: new Map(),  // Nachrichten-ID -> Promise<{payload}|{error}>
  dec: new Map(),      // Nachrichten-ID -> {payload}|{error} (bereits entschlüsselt, synchron lesbar)
  view: 'chats',       // aktiver Navigationspunkt
  typing: new Map(),   // Kontakt-ID -> { until, preview }
  uploads: new Map(),  // Kontakt-ID -> [{ id, label, progress }]
  blobs: new Map(),    // Datei-ID -> { blob, url }
  drafts: new Map(),
  reply: null,
  viewOnce: false,
  tab: 'chats',
  search: '',
  ws: null,
  prefs: {},
};

export async function saveIdentity(userId, identity, keyVersion) {
  const imported = await importIdentity(identity);
  const rec = { ...imported, keyVersion };
  await store.put('identity', userId, rec);
  // Klartext-Schlüsselmaterial aus dem Speicher entfernen (soweit JavaScript das zulässt)
  identity.encPriv = identity.sigPriv = null;
  S.keys = rec;
  return rec;
}

export const cacheKey = (id) => `${S.me?.id}:${id}`;
