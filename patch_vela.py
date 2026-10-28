#!/usr/bin/env python3
"""Aktiviert Farbschema + neues Icon, den verschlüsselten Entschlüsselungs-Cache und „Usercache leeren“.

    python patch_vela3.py            # im Projektordner (neben run.py) ausführen

Vorher an die richtigen Orte kopieren (siehe README unten in der Antwort):
    app/clientcache.py   static/js/cache.js   static/css/theme.css   static/icon*.png   static/icon.svg   static/badge-96.png
Geändert: app/main.py, static/js/app.js, static/js/auth.js, static/js/store.js, static/index.html,
          static/manifest.webmanifest.  Backups: <datei>.bak. Mehrfach ausführbar.
"""
from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NEED = ["app/clientcache.py", "static/js/cache.js", "static/css/theme.css", "static/icon.svg", "static/icon-192.png",
        "static/icon-512.png", "static/icon-maskable-512.png", "static/badge-96.png", "static/js/conn.js"]

STORE_ADD = "\n// ---- Erweiterungen für den Entschlüsselungs-Cache (cache.js)\n/** Viele Schlüssel mit EINER Transaktion lesen (viel schneller als einzelne get()-Aufrufe). */\nexport async function getMany(storeName, keys) {\n  if (!keys.length) return [];\n  const db = await open();\n  return new Promise((resolve, reject) => {\n    const tx = db.transaction(storeName, 'readonly');\n    const s = tx.objectStore(storeName);\n    const reqs = keys.map((k) => s.get(k));\n    tx.oncomplete = () => resolve(reqs.map((r) => r.result));\n    tx.onerror = tx.onabort = () => reject(tx.error);\n  });\n}\n\nexport const clear = (storeName) => run(storeName, 'readwrite', (s) => s.clear());\n\n/** Löscht alle Einträge, für die pred(value) wahr ist. Gibt die Anzahl zurück. */\nexport async function deleteWhere(storeName, pred) {\n  const db = await open();\n  return new Promise((resolve, reject) => {\n    const tx = db.transaction(storeName, 'readwrite');\n    let n = 0;\n    const req = tx.objectStore(storeName).openCursor();\n    req.onsuccess = () => {\n      const cur = req.result;\n      if (!cur) return;\n      if (pred(cur.value)) { cur.delete(); n++; }\n      cur.continue();\n    };\n    tx.oncomplete = () => resolve(n);\n    tx.onerror = tx.onabort = () => reject(tx.error);\n  });\n}\n"

MAIN_EDITS = [
    ("Import clientcache", "clientcache",
     ["from . import config, db, maintenance, models_dl, security\n"],
     "from . import clientcache, config, db, maintenance, models_dl, security\n"),
    ("cache_epoch in /api/me", 'clientcache.epoch_for(u["id"])',
     ['        "created_at": u["created_at"], "about": u["about"], "avatar_version": u["avatar_version"],\n    }\n'],
     '        "created_at": u["created_at"], "about": u["about"], "avatar_version": u["avatar_version"],\n'
     '        "cache_epoch": clientcache.epoch_for(u["id"]),\n    }\n'),
    ("cache_epoch in /api/maintenance", "clientcache.global_epoch()",
     ['                         "ts": db.now_ms()}, headers={"Cache-Control": "no-store"})\n'],
     '                         "ts": db.now_ms(), "cache_epoch": clientcache.global_epoch()},\n'
     '                        headers={"Cache-Control": "no-store"})\n'),
]

APP_JS_EDITS = [
    ("Farben der Browser-Leiste", "#18120c", ["dark ? '#0e1513' : '#f4fbf8'"], "dark ? '#18120c' : '#fff8f4'"),
    ("Import cache.js", "from './cache.js'", ["import { S, cacheKey } from './state.js';\n"],
     "import { S, cacheKey } from './state.js';\n"
     "import { cacheGet, cachePut, cacheDel, cachePrefetch, cachePrune, applyCacheEpoch, cacheMemoryClear } from './cache.js';\n"),
    ("Cache lesen", "await cacheGet(m.id)", ["      const cached = await store.get('cache', cacheKey(m.id)).catch(() => null);\n"],
     "      const cached = await cacheGet(m.id);\n"),
    ("Cache schreiben (Entschlüsselung)", "cachePut(m.id, res)", ["      if (!m.view_once) store.put('cache', cacheKey(m.id), res).catch(() => {});\n"],
     "      if (!m.view_once) cachePut(m.id, res);\n"),
    ("Cache schreiben (eigene Nachricht)", "cachePut(id, res)", ["    store.put('cache', cacheKey(id), res).catch(() => {});\n"],
     "    cachePut(id, res);\n"),
    ("Cache löschen (Nachricht gelöscht)", "cacheDel(ev.id)", ["      store.del('cache', cacheKey(ev.id)).catch(() => {});\n"],
     "      cacheDel(ev.id);\n"),
    ("Cache beim Chat-Öffnen auf einmal laden", "cachePrefetch(todo", ["  if (todo.length) await Promise.all(todo.map(decode));\n"],
     "  if (todo.length) { await cachePrefetch(todo.map((m) => m.id)); await Promise.all(todo.map(decode)); }\n"),
    ("Aufräum-Funktion bei Cache-Leerung", "function onCacheCleared", ["function statusCtx() {\n"],
     "// Der Admin hat den Cache geleert: Sitzungsspeicher verwerfen, alles neu entschlüsseln\n"
     "function onCacheCleared() {\n"
     "  S.decoded.clear(); S.dec = new Map(); previews.clear(); payloadNodes.clear(); msgNodes.clear(); cacheMemoryClear();\n"
     "  renderList();\n  if (S.chat) renderMessages();\n}\n\nfunction statusCtx() {\n"),
    ("Cache-Epoche beim Start prüfen, Cache aufräumen", "applyCacheEpoch(S.me",
     ["  maybeShowChangelog(version, S.me);\n}\n", "  loadStatuses().then(refreshNav).catch(() => {});\n  connectWS();\n}\n"],
     None),   # wird unten je nach gefundenem Anker ergänzt
    ("WebSocket-Ereignis cache_clear", "case 'cache_clear'", ["    case 'read':\n"],
     "    case 'cache_clear':\n      applyCacheEpoch(ev.epoch, onCacheCleared);\n      break;\n    case 'read':\n"),
    ("Cache-Epoche aus der Abfrage (vor dem Login)", "onCacheEpoch:",
     ["onServerBack: () => { if (fatalShown) location.reload(); } });"],
     "onServerBack: () => { if (fatalShown) location.reload(); }, onCacheEpoch: (e) => applyCacheEpoch(e, onCacheCleared) });"),
    ("Logo in der Kopfzeile", "static/icon.svg",
     ["h('span', { class: 'brand-mini' }, icon('shield', 22))"],
     "h('span', { class: 'brand-mini' }, h('img', { src: 'static/icon.svg', alt: '', width: 34, height: 34 }))"),
]
ENTER_APP_TAIL = "  applyCacheEpoch(S.me.cache_epoch, onCacheCleared);\n  setTimeout(() => cachePrune(S.config.retention_days), 8000);\n"

AUTH_EDITS = [("Logo auf der Anmeldeseite", "static/icon.svg", ["h('div', { class: 'brand-logo' }, icon('shield', 32)),"],
               "h('div', { class: 'brand-logo' }, h('img', { src: 'static/icon.svg', alt: '', width: 52, height: 52 })),")]

STORE_EDITS = []   # per Anhängen, siehe patch_store()

BOOT_OLD = ('<div class="boot-logo"><svg viewBox="0 -960 960 960" width="40" height="40" aria-hidden="true"><path d="M480-80q-139-35-229.5-159.5'
            'T160-516v-244l320-120 320 120v244q0 152-90.5 276.5T480-80Zm0-84q97-30 162-118.5T718-480H480v-315l-240 90v207q0 7 2 18h238v316Z"/></svg></div>')
INDEX_EDITS = [
    ("Farbschema laden", "theme.css", ['  <link rel="stylesheet" href="static/css/app.css">\n'],
     '  <link rel="stylesheet" href="static/css/app.css">\n  <link rel="stylesheet" href="static/css/theme.css">\n'),
    ("Farbe der Browser-Leiste", "#fff8f4", ['<meta name="theme-color" content="#f4fbf8">'], '<meta name="theme-color" content="#fff8f4">'),
    ("Logo beim Laden", 'src="static/icon.svg"', [BOOT_OLD], '<div class="boot-logo"><img src="static/icon.svg" alt="" width="72" height="72"></div>'),
]


def read(path: Path):
    raw = path.read_bytes().decode("utf-8")
    return raw.replace("\r\n", "\n"), "\r\n" if "\r\n" in raw else "\n"


def finish(path, rel, old, new, eol, notes, ok):
    print(("✓ " if ok else "✗ ") + rel)
    print("\n".join(notes))
    if not ok:
        print("  -> nichts geschrieben")
        return False
    if new != old:
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
        path.write_bytes(new.replace("\n", eol).encode("utf-8"))
    return True


def patch(rel, edits, enter_app_tail=False):
    path = ROOT / rel
    if not path.exists():
        print(f"✗ {rel}: Datei nicht gefunden")
        return False
    text, eol = read(path)
    new, notes, ok = text, [], True
    for desc, marker, olds, repl in edits:
        if marker in new:
            notes.append(f"  = {desc} (schon vorhanden)")
            continue
        old = next((o for o in olds if new.count(o) == 1), None)
        if old is None:
            notes.append(f"  ✗ {desc}: Einstiegspunkt nicht gefunden")
            ok = False
            continue
        if repl is None:      # enter-App-Anker: Ergänzung vor der schließenden Klammer
            repl = old[:-2] + ENTER_APP_TAIL + "}\n"
        new = new.replace(old, repl, 1)
        notes.append(f"  ✓ {desc}")
    return finish(path, rel, text, new, eol, notes, ok)


def patch_store():
    rel = "static/js/store.js"
    path = ROOT / rel
    if not path.exists():
        print(f"✗ {rel}: Datei nicht gefunden")
        return False
    text, eol = read(path)
    if "export async function getMany" in text:
        print(f"= {rel}: schon erweitert")
        return True
    return finish(path, rel, text, text.rstrip("\n") + "\n" + STORE_ADD, eol, ["  ✓ getMany / clear / deleteWhere ergänzt"], True)


def patch_manifest():
    rel = "static/manifest.webmanifest"
    path = ROOT / rel
    if not path.exists():
        print(f"- {rel}: nicht gefunden, übersprungen")
        return True
    text, eol = read(path)
    data = json.loads(text)
    icons = data.setdefault("icons", [])
    existing = [i.get("src", "") for i in icons]
    prefix = next((s[: s.rfind("/") + 1] for s in existing if s.endswith(".png")), "static/")
    want = [("icon-192.png", "192x192", "any"), ("icon-512.png", "512x512", "any"), ("icon-maskable-512.png", "512x512", "maskable")]
    notes = []
    for name, size, purpose in want:
        if not any(s.endswith(name) for s in existing):
            icons.append({"src": prefix + name, "sizes": size, "type": "image/png", "purpose": purpose})
            notes.append(f"  ✓ Icon {name} ergänzt")
    for key, val in (("theme_color", "#fff8f4"), ("background_color", "#fff8f4")):
        if data.get(key) != val:
            data[key] = val
            notes.append(f"  ✓ {key} = {val}")
    new = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    return finish(path, rel, text, new, eol, notes or ["  = schon aktuell"], True)


def main():
    missing = [f for f in NEED if not (ROOT / f).exists()]
    if missing:
        sys.exit("Fehlt noch (bitte zuerst kopieren):\n  " + "\n  ".join(missing))
    results = [patch("app/main.py", MAIN_EDITS), patch("static/js/app.js", APP_JS_EDITS), patch("static/js/auth.js", AUTH_EDITS),
               patch_store(), patch("static/index.html", INDEX_EDITS), patch_manifest()]
    ok = all(results)
    print("\nFertig." if ok else "\nMit Fehlern beendet (siehe oben).")
    if ok:
        print("\nNoch nötig:  systemctl restart vela   (danach im Browser Strg+F5; Icon auf dem Handy ggf. neu installieren)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()