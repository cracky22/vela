"""Wartungsmodus. Der Zustand liegt in der Datenbank (Tabelle app_state) – also dort, wo auch alle Nutzer
liegen. So sehen CLI (admin.py), Web-Admin und Server garantiert denselben Stand, egal mit welchem
Datenverzeichnis der jeweilige Prozess gestartet wurde.

Lesen wird 2 Sekunden zwischengespeichert (die Clients fragen alle paar Sekunden ab). Eine ältere
Datei data/maintenance.json wird weiter gelesen, solange noch nichts in der Datenbank steht.
"""
from __future__ import annotations

import json
import sqlite3
import time

from . import config, db

DEFAULT_MESSAGE = "Wartungsarbeiten"
LEGACY_PATH = config.DATA_DIR / "maintenance.json"
CACHE_SECONDS = 2.0
_cache: tuple[float, dict] | None = None
OFF = {"on": False, "message": "", "since": 0}


def _clean(d: dict | None) -> dict:
    if d and d.get("on"):
        return {"on": True, "message": str(d.get("message") or DEFAULT_MESSAGE)[:200], "since": int(d.get("since") or 0)}
    return dict(OFF)


def _ensure_table() -> None:
    db.conn().execute("CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)")


def _read() -> dict:
    try:
        row = db.one("SELECT value FROM app_state WHERE key='maintenance'")
    except sqlite3.OperationalError:       # Tabelle gibt es noch nicht
        _ensure_table()
        row = None
    if row:
        try:
            return _clean(json.loads(row["value"]))
        except ValueError:
            return dict(OFF)
    try:                                    # Altbestand (frühere Version: Datei)
        return _clean(json.loads(LEGACY_PATH.read_text("utf-8")))
    except (OSError, ValueError):
        return dict(OFF)


def get() -> dict:
    global _cache
    now = time.monotonic()
    if _cache and now < _cache[0]:
        return dict(_cache[1])
    state = _read()
    _cache = (now + CACHE_SECONDS, state)
    return dict(state)


def set_(on: bool, message: str = "") -> dict:
    global _cache
    state = _clean({"on": True, "message": message, "since": int(time.time() * 1000)}) if on else dict(OFF)
    _ensure_table()
    with db.tx() as c:
        c.execute("INSERT INTO app_state (key, value) VALUES ('maintenance', ?) "
                  "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (json.dumps(state, ensure_ascii=False),))
    LEGACY_PATH.unlink(missing_ok=True)     # alte Datei darf den Zustand nicht überstimmen
    _cache = None
    return state