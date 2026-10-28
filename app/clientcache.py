"""Serverseitiger Teil des „Usercache leeren“: eine wachsende Epochen-Zahl (Zeitstempel in ms).

Clients merken sich die zuletzt angewendete Epoche. Ist die Zahl vom Server größer, leeren sie ihren lokalen
Entschlüsselungs-Cache (nie Schlüssel!). Es gibt eine globale Epoche (alle Nutzer) und eine pro Nutzer.
Die Clients erfahren sie über /api/me (beim Start), per WebSocket (sofort) und über /api/maintenance (Abfrage).
"""
from __future__ import annotations

import sqlite3
import time

from . import db, maintenance

_memo: tuple[float, int] | None = None


def _get(key: str) -> int:
    try:
        row = db.one("SELECT value FROM app_state WHERE key=?", key)
    except sqlite3.OperationalError:
        maintenance._ensure_table()
        return 0
    try:
        return int(row["value"]) if row else 0
    except (TypeError, ValueError):
        return 0


def global_epoch() -> int:
    """2 Sekunden zwischengespeichert (wird von jedem Client regelmäßig abgefragt)."""
    global _memo
    now = time.monotonic()
    if _memo and now < _memo[0]:
        return _memo[1]
    val = _get("cache_epoch")
    _memo = (now + 2.0, val)
    return val


def epoch_for(uid: str) -> int:
    return max(global_epoch(), _get(f"cache_epoch:{uid}"))


def bump(uids: list[str] | None = None) -> int:
    """Setzt eine neue Epoche (global oder für die genannten Nutzer) und gibt sie zurück."""
    global _memo
    maintenance._ensure_table()
    with db.tx() as c:
        last = max([_get("cache_epoch")] + [_get(f"cache_epoch:{u}") for u in (uids or [])])
        epoch = max(db.now_ms(), last + 1)
        for key in ([f"cache_epoch:{u}" for u in uids] if uids else ["cache_epoch"]):
            c.execute("INSERT INTO app_state (key, value) VALUES (?, ?) "
                      "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, str(epoch)))
    _memo = None
    return epoch