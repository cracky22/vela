"""Wartungsmodus: Zustand liegt in einer kleinen JSON-Datei im Datenverzeichnis.

admin.py schreibt sie, der Server liest sie (GET /api/status). Eine Datei statt DB-Eintrag, damit
der Modus auch gesetzt werden kann, wenn der Server gerade nicht läuft.
"""
from __future__ import annotations

import json
import time

from . import config

PATH = config.DATA_DIR / "maintenance.json"
DEFAULT_MESSAGE = "Wartungsarbeiten"


def get() -> dict:
    try:
        d = json.loads(PATH.read_text("utf-8"))
        if d.get("on"):
            return {"on": True, "message": str(d.get("message") or DEFAULT_MESSAGE)[:200],
                    "since": int(d.get("since") or 0)}
    except (OSError, ValueError, TypeError):
        pass
    return {"on": False, "message": "", "since": 0}


def set_(on: bool, message: str = "") -> dict:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    if on:
        data = {"on": True, "message": (message or DEFAULT_MESSAGE)[:200], "since": int(time.time() * 1000)}
        tmp = PATH.with_suffix(".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False), "utf-8")
        tmp.replace(PATH)
        return data
    PATH.unlink(missing_ok=True)
    return {"on": False, "message": "", "since": 0}