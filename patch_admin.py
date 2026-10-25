#!/usr/bin/env python3
"""Bindet die Web-Adminseite (/admin) in app/main.py ein.

    python patch_admin.py        # im Projektordner (neben run.py) ausführen

Vorher an die richtigen Orte kopieren:
    app/admin_ops.py  app/admin_web.py
    static/admin.html  static/css/admin.css  static/js/admin.js  static/js/admin-base.js
    admin.py (ersetzt die alte Version)

Das Skript legt von main.py ein Backup (main.py.bak) an und ist mehrfach ausführbar.
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NEED = ["app/admin_ops.py", "app/admin_web.py", "static/admin.html", "static/css/admin.css",
        "static/js/admin.js", "static/js/admin-base.js"]

ANCHOR = '@app.api_route("/{path:path}", methods=["GET", "HEAD"])\ndef spa(path: str):\n'
INSERT = (
    '# ---- Web-Admin (/admin, /api/admin/*) – muss VOR der SPA-Catch-all-Route registriert werden\n'
    'from . import admin_web  # noqa: E402\n\n'
    'admin_web.init(app, {\n'
    '    "COOKIE": COOKIE, "lookup_session": lookup_session, "rate": rate, "client_ip": client_ip,\n'
    '    "manager": manager, "leave_group": leave_group, "notify_group": notify_group,\n'
    '})\n\n\n'
)


def main() -> None:
    missing = [f for f in NEED if not (ROOT / f).exists()]
    if missing:
        sys.exit("Fehlt noch (bitte kopieren):\n  " + "\n  ".join(missing))
    path = ROOT / "app/main.py"
    raw = path.read_bytes().decode("utf-8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    if "admin_web.init" in text:
        print("= app/main.py: Web-Admin ist schon eingebunden")
        return
    if text.count(ANCHOR) != 1:
        sys.exit("✗ app/main.py: Einstiegspunkt (SPA-Route) nicht gefunden – nichts geändert")
    for fn in ("def leave_group(", "def notify_group(", "def lookup_session(", "def client_ip(", "def rate("):
        if fn not in text:
            sys.exit(f"✗ app/main.py: '{fn}' fehlt – nichts geändert")
    shutil.copy2(path, path.with_suffix(".py.bak"))
    path.write_bytes(text.replace(ANCHOR, INSERT + ANCHOR, 1).replace("\n", eol).encode("utf-8"))
    print("✓ app/main.py: Web-Admin eingebunden (Backup: main.py.bak)")
    print("\nNächste Schritte:\n  1. python admin.py admins grant DEIN_NAME\n  2. Server neu starten\n  3. https://<host>/admin (bzw. /vela/admin) öffnen")


if __name__ == "__main__":
    main()