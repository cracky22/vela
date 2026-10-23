"""Zentrale Konfiguration. Alle Werte lassen sich per Umgebungsvariable überschreiben."""
from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "static"
DATA_DIR = Path(os.environ.get("VELA_DATA_DIR", BASE_DIR / "data"))
UPLOAD_DIR = DATA_DIR / "uploads"
CERT_DIR = DATA_DIR / "certs"
DB_PATH = DATA_DIR / "vela.db"


def _int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# Maximale Größe einer (bereits verschlüsselten) Datei in MB
MAX_UPLOAD_MB = _int("VELA_MAX_UPLOAD_MB", 100)
MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024

# Wie lange verschlüsselte Nachrichten/Dateien maximal auf dem Server liegen (Datenminimierung)
RETENTION_DAYS = _int("VELA_RETENTION_DAYS", 30)

# Lebensdauer einer Anmeldesitzung
SESSION_DAYS = _int("VELA_SESSION_DAYS", 30)

# Nicht abgeschlossene Registrierungen (2FA nie bestätigt) werden danach gelöscht
PENDING_ACCOUNT_HOURS = _int("VELA_PENDING_ACCOUNT_HOURS", 24)

# Größe des Thread-Pools für blockierende Arbeit (DB, Datei-I/O, Passwort-Hashing)
WORKER_THREADS = _int("VELA_WORKER_THREADS", 64)

# Maximale Größe eines JSON-Request-Bodys
MAX_JSON_BYTES = 512 * 1024

# Erlaubte RSA-Schlüssellängen (Bit)
ALLOWED_KEY_BITS = (2048, 3072, 4096, 8192)

# Wird beim Start von run.py gesetzt: läuft der Server mit TLS?
TLS_ENABLED = os.environ.get("VELA_TLS", "1") == "1"

# Basis-Pfad hinter einem Reverse-Proxy (z. B. "/vela" oder "")
ROOT_PATH = os.environ.get("VELA_ROOT_PATH", "").rstrip("/")

