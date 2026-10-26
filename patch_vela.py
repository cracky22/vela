#!/usr/bin/env python3
"""Spielt die Änderungen für Sperren, "Zuletzt gesehen" und Wartungsmodus in deine Vela-Dateien ein.

    python patch_vela.py            # im Projektordner (neben run.py) ausführen

Geändert werden: app/db.py, app/main.py, static/js/app.js, static/css/app.css
Neu (bitte vorher hineinkopieren): app/maintenance.py, static/js/conn.js

* Von jeder geänderten Datei entsteht ein Backup (<datei>.bak).
* Mehrfaches Ausführen ist unschädlich (bereits angewendete Änderungen werden übersprungen).
* Findet das Skript einen Einstiegspunkt nicht (Datei wurde geändert), bricht es für diese Datei
  ab, ohne etwas zu schreiben, und sagt, welche Stelle fehlt.
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# Jede Änderung: (Beschreibung, Marker für "schon angewendet", alter Text, neuer Text)
DB_EDITS = [
    ("Spalten blocked + last_seen", '"last_seen"',
     '    ("contacts", "ttl", "INTEGER NOT NULL DEFAULT 0"),\n]',
     '    ("contacts", "ttl", "INTEGER NOT NULL DEFAULT 0"),\n'
     '    # Version 1.3\n'
     '    ("users", "blocked", "INTEGER NOT NULL DEFAULT 0"),\n'
     '    ("users", "last_seen", "INTEGER"),\n]'),
]

MAIN_EDITS = [
    ("Import maintenance", "maintenance, models_dl",
     "from . import config, db, models_dl, security\n",
     "from . import config, db, maintenance, models_dl, security\n"),

    ("Gesperrte Nutzer: Sitzung ungültig", "u.blocked",
     '    row = db.one("SELECT s.user_id, s.full, s.expires_at, u.username FROM sessions s "\n'
     '                 "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", th)\n'
     '    if not row or row["expires_at"] < db.now_ms():\n',
     '    row = db.one("SELECT s.user_id, s.full, s.expires_at, u.username, u.blocked FROM sessions s "\n'
     '                 "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", th)\n'
     '    if not row or row["expires_at"] < db.now_ms() or row["blocked"]:\n'),

    ("Gesperrte Nutzer: Login abweisen", 'u["blocked"]',
     '    if not u or not ok:\n        raise HTTPException(401, "Anmeldedaten ungültig")\n',
     '    if not u or not ok:\n        raise HTTPException(401, "Anmeldedaten ungültig")\n'
     '    if u["blocked"]:\n        raise HTTPException(403, "Dieses Konto wurde gesperrt.")\n'),

    ("GET /api/maintenance (Wartungsmodus)", "def public_status",
     '            "key_bits": list(config.ALLOWED_KEY_BITS)}\n',
     '            "key_bits": list(config.ALLOWED_KEY_BITS)}\n'
     '\n\n'
     '@app.get("/api/maintenance")\n'
     'def public_status(request: Request):\n'
     '    """Öffentlich (ohne Anmeldung): Wartungsmodus. Der Client fragt das regelmäßig ab."""\n'
     '    rate(f"status:{client_ip(request)}", 240, 60)\n'
     '    m = maintenance.get()\n'
     '    return JSONResponse({"maintenance": m["on"], "message": m["message"], "since": m["since"],\n'
     '                         "ts": db.now_ms()}, headers={"Cache-Control": "no-store"})\n'),

    # Korrektur: /api/status gehört den Status-Beiträgen. Hier nur umbenennen, falls schon eingespielt.
    ("Route /api/status -> /api/maintenance (Korrektur)", '@app.get("/api/maintenance")',
     '@app.get("/api/status")\ndef public_status(',
     '@app.get("/api/maintenance")\ndef public_status('),

    ("last_seen-Helfer", "def touch_last_seen",
     '@app.websocket("/ws")\nasync def websocket(ws: WebSocket):\n',
     'def touch_last_seen(uid: str) -> None:\n'
     '    """Zuletzt gesehen: nur beim Verbinden, Trennen und alle ~60 s (Ping) – nicht pro Anfrage."""\n'
     '    try:\n'
     '        with db.tx() as c:\n'
     '            c.execute("UPDATE users SET last_seen=? WHERE id=?", (db.now_ms(), uid))\n'
     '    except Exception:  # pragma: no cover - nie die Verbindung gefährden\n'
     '        pass\n\n\n'
     '@app.websocket("/ws")\nasync def websocket(ws: WebSocket):\n'),

    ("last_seen beim Verbinden", "last_touch = time.monotonic()",
     '    if first:\n        await _broadcast_presence(uid, True)\n    bucket: list[float] = []\n',
     '    if first:\n        await _broadcast_presence(uid, True)\n'
     '    await anyio.to_thread.run_sync(touch_last_seen, uid)\n'
     '    last_touch = time.monotonic()\n'
     '    bucket: list[float] = []\n'),

    ("last_seen bei Ping", "now - last_touch",
     '            if kind == "ping":\n                await ws.send_json({"type": "pong"})\n',
     '            if kind == "ping":\n                await ws.send_json({"type": "pong"})\n'
     '                if now - last_touch > 55:\n'
     '                    last_touch = now\n'
     '                    await anyio.to_thread.run_sync(touch_last_seen, uid)\n'),

    ("last_seen beim Trennen", "touch_last_seen, uid)\n            except",
     '        if not manager.is_online(uid):\n            try:\n                await _broadcast_presence(uid, False)\n',
     '        if not manager.is_online(uid):\n            try:\n'
     '                await anyio.to_thread.run_sync(touch_last_seen, uid)\n'
     '            except Exception:  # pragma: no cover\n                pass\n'
     '            try:\n                await _broadcast_presence(uid, False)\n'),
]

JS_EDITS = [
    ("Import conn.js", "from './conn.js'",
     "import { initProfile, renderProfileView } from './profile.js';\n",
     "import { initProfile, renderProfileView } from './profile.js';\nimport { initConn, setWsState } from './conn.js';\n"),

    ("Fatal-Flag", "let fatalShown",
     "let initialRender = true;\n",
     "let initialRender = true;\nlet fatalShown = false;   // Fehlerseite sichtbar? (dann Seite neu laden, sobald der Server wieder da ist)\n"),

    ("renderFatal merkt sich den Zustand", "fatalShown = true",
     "function renderFatal(msg) {\n",
     "function renderFatal(msg) {\n  fatalShown = true;\n"),

    ("Start der Statusabfrage", "initConn(",
     "  applyTheme(S.prefs.theme);\n  initRipple();\n",
     "  applyTheme(S.prefs.theme);\n  initRipple();\n"
     "  initConn({ onReconnect: retryWS, onServerBack: () => { if (fatalShown) location.reload(); } });\n"),

    ("WebSocket offen", "setWsState('open')",
     "    document.body.classList.remove('offline');\n",
     "    setWsState('open');\n    startPing(ws);\n"),

    ("WebSocket getrennt", "setWsState('closed')",
     "    document.body.classList.add('offline');\n",
     "    setWsState('closed');\n"),

    ("Hilfsfunktionen retryWS/startPing", "function retryWS",
     "let wsBackoff = 1000, wsTimer = 0;\n",
     "let wsBackoff = 1000, wsTimer = 0, pingTimer = 0;\n"
     "// Server wieder erreichbar (laut /api/status), aber WebSocket noch getrennt -> sofort neu verbinden\n"
     "function retryWS() { if (S.ws && S.ws.readyState === WebSocket.CLOSED) connectWS(); }\n"
     "// Alle 60 s ein Ping: hält \"zuletzt gesehen\" auf dem Server aktuell\n"
     "function startPing(ws) {\n"
     "  clearInterval(pingTimer);\n"
     "  pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send('{\"type\":\"ping\"}'); }, 60000);\n"
     "}\n"),

    ("Abmeldung: Status zurücksetzen (1)", "setWsState('none');\n  S.ws = null;",
     "function sessionExpired() {\n  S.ws = null;\n",
     "function sessionExpired() {\n  setWsState('none');\n  S.ws = null;\n"),

    ("Abmeldung: Status zurücksetzen (2)", "ws?.close(); setWsState('none');",
     "  const ws = S.ws; S.ws = null; ws?.close();\n",
     "  const ws = S.ws; S.ws = null; ws?.close(); setWsState('none');\n"),

]
JS_OPTIONAL = [   # kosmetisch: fehlt der Einstiegspunkt, wird das übersprungen, ohne den Rest zu blockieren
    ("Version", "v1.3.0",
     "export const version = 'v1.2.1';",
     "export const version = 'v1.3.0';"),
]

CSS_NEW = """/* Verbindungs-/Wartungsbanner (conn.js) */
.conn-banner { position: fixed; top: calc(8px + var(--safe-top)); left: 50%; transform: translateX(-50%); z-index: 90; display: flex; align-items: center; gap: 6px; max-width: calc(100vw - 24px); font-size: 12px; font-weight: 600; padding: 5px 14px; border-radius: var(--shape-full); box-shadow: var(--elev-2); animation: rise 240ms var(--ease-emph); pointer-events: none; }
.conn-banner[hidden] { display: none; }
.conn-banner.maint { background: #ffe082; color: #3b2f00; }
.conn-banner.offline { background: var(--error-container); color: var(--on-error-container); }
.conn-banner.ok { background: #b7f0c4; color: #0b3a1a; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .conn-banner.maint { background: #6b5600; color: #ffe9a6; }
  :root:not([data-theme="light"]) .conn-banner.ok { background: #1f5a33; color: #c4f5d0; }
}
:root[data-theme="dark"] .conn-banner.maint { background: #6b5600; color: #ffe9a6; }
:root[data-theme="dark"] .conn-banner.ok { background: #1f5a33; color: #c4f5d0; }"""


def read(path: Path) -> tuple[str, str]:
    raw = path.read_bytes().decode("utf-8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    return raw.replace("\r\n", "\n"), eol


def write(path: Path, text: str, eol: str) -> None:
    shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
    path.write_bytes(text.replace("\n", eol).encode("utf-8"))


def patch(rel: str, edits: list, optional: list = ()) -> bool:
    path = ROOT / rel
    if not path.exists():
        print(f"✗ {rel}: Datei nicht gefunden")
        return False
    text, eol = read(path)
    new, notes, ok = text, [], True
    for desc, marker, old, repl in edits:
        if marker in new:
            notes.append(f"  = {desc} (schon vorhanden)")
            continue
        n = new.count(old)
        if n != 1:
            notes.append(f"  ✗ {desc}: Einstiegspunkt {'nicht gefunden' if n == 0 else 'mehrfach vorhanden'}")
            ok = False
            continue
        new = new.replace(old, repl, 1)
        notes.append(f"  ✓ {desc}")
    for desc, marker, old, repl in optional:
        if marker in new:
            notes.append(f"  = {desc} (schon vorhanden)")
        elif new.count(old) == 1:
            new = new.replace(old, repl, 1)
            notes.append(f"  ✓ {desc}")
        else:
            notes.append(f"  - {desc}: übersprungen (nicht kritisch)")
    return finish(path, rel, text, new, eol, notes, ok)


def patch_css() -> bool:
    rel = "static/css/app.css"
    path = ROOT / rel
    if not path.exists():
        print(f"✗ {rel}: Datei nicht gefunden")
        return False
    text, eol = read(path)
    if ".conn-banner" in text:
        print(f"= {rel}: schon angepasst")
        return True
    new, n = re.subn(r"^body\.offline \.app-shell::before \{.*\}[ \t]*$", CSS_NEW, text, count=1, flags=re.M)
    if n != 1:  # alte Regel nicht da -> Block einfach anhängen
        new = text.rstrip("\n") + "\n\n" + CSS_NEW + "\n"
    return finish(path, rel, text, new, eol, ["  ✓ Banner-Stile (ersetzt die alte Offline-Regel)" if n else "  ✓ Banner-Stile (angehängt)"], True)


def finish(path: Path, rel: str, old: str, new: str, eol: str, notes: list[str], ok: bool) -> bool:
    print(("✓ " if ok else "✗ ") + rel)
    print("\n".join(notes))
    if not ok:
        print("  -> nichts geschrieben")
        return False
    if new != old:
        write(path, new, eol)
    return True


def main() -> None:
    for rel in ("app/maintenance.py", "static/js/conn.js"):
        if not (ROOT / rel).exists():
            sys.exit(f"Fehlt: {rel} – bitte zuerst an den richtigen Ort kopieren.")
    results = [patch("app/db.py", DB_EDITS), patch("app/main.py", MAIN_EDITS),
               patch("static/js/app.js", JS_EDITS, JS_OPTIONAL), patch_css()]
    print("\nFertig." if all(results) else "\nMit Fehlern beendet (siehe oben).")
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()