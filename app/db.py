"""SQLite-Zugriff: eine Verbindung pro Thread, WAL-Modus für parallele Leser.

Der Server speichert nur, was für die Zustellung nötig ist: Kontodaten, öffentliche
Schlüssel, ein mit dem Wiederherstellungsschlüssel verschlüsseltes Schlüssel-Backup,
verschlüsselte Nachrichten (Ciphertext) und verschlüsselte Dateien.
"""
from __future__ import annotations

import sqlite3
import threading
import time
from contextlib import contextmanager
from typing import Iterator

from . import config

_local = threading.local()

SCHEMA = """
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    username        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pw_hash         TEXT NOT NULL,
    totp_secret     TEXT,
    totp_enabled    INTEGER NOT NULL DEFAULT 0,
    totp_last_step  INTEGER NOT NULL DEFAULT 0,
    activated       INTEGER NOT NULL DEFAULT 0,
    enc_pub         TEXT NOT NULL,
    sig_pub         TEXT NOT NULL,
    key_bits        INTEGER NOT NULL,
    key_version     INTEGER NOT NULL DEFAULT 1,
    key_backup      TEXT NOT NULL,
    recovery_hash   TEXT NOT NULL,
    settings        TEXT NOT NULL DEFAULT '{}',
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    full        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS contacts (
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    contact_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status      TEXT NOT NULL CHECK (status IN ('pending_out','pending_in','accepted')),
    archived    INTEGER NOT NULL DEFAULT 0,
    pinned      INTEGER NOT NULL DEFAULT 0,
    muted       INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, contact_id)
);

CREATE TABLE IF NOT EXISTS messages (
    id            TEXT PRIMARY KEY,
    sender_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipient_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    envelope      TEXT,
    view_once     INTEGER NOT NULL DEFAULT 0,
    silent        INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER NOT NULL,
    read_at       INTEGER,
    viewed_at     INTEGER,
    deleted_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_pair ON messages(sender_id, recipient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_msg_recipient ON messages(recipient_id, read_at);
CREATE INDEX IF NOT EXISTS idx_msg_expires ON messages(expires_at);

CREATE TABLE IF NOT EXISTS files (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_id  TEXT REFERENCES messages(id) ON DELETE SET NULL,
    size        INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_message ON files(message_id);

CREATE TABLE IF NOT EXISTS statuses (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    envelope    TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_status_user ON statuses(user_id, expires_at);

CREATE TABLE IF NOT EXISTS groups (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    created_by      TEXT,
    created_at      INTEGER NOT NULL,
    avatar_version  INTEGER NOT NULL DEFAULT 0,
    ttl             INTEGER NOT NULL DEFAULT 0,
    only_admins     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS group_members (
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL CHECK (role IN ('admin','member')),
    joined_at   INTEGER NOT NULL,
    last_read   INTEGER NOT NULL DEFAULT 0,
    archived    INTEGER NOT NULL DEFAULT 0,
    pinned      INTEGER NOT NULL DEFAULT 0,
    muted       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gm_user ON group_members(user_id);

CREATE TABLE IF NOT EXISTS group_messages (
    id          TEXT PRIMARY KEY,
    group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    sender_id   TEXT,
    envelope    TEXT,
    system      TEXT,
    silent      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    deleted_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_gmsg ON group_messages(group_id, created_at);
CREATE INDEX IF NOT EXISTS idx_gmsg_exp ON group_messages(expires_at);

CREATE TABLE IF NOT EXISTS status_views (
    status_id   TEXT NOT NULL REFERENCES statuses(id) ON DELETE CASCADE,
    viewer_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    viewed_at   INTEGER NOT NULL,
    PRIMARY KEY (status_id, viewer_id)
);
"""

# Spalten, die nach Version 1.0 hinzugekommen sind (Migration bestehender Datenbanken)
MIGRATIONS = [
    ("users", "about", "TEXT NOT NULL DEFAULT ''"),
    ("users", "avatar_version", "INTEGER NOT NULL DEFAULT 0"),
    ("files", "status_id", "TEXT"),
    # Version 1.2
    ("files", "group_message_id", "TEXT"),
    ("messages", "system", "TEXT"),
    ("contacts", "ttl", "INTEGER NOT NULL DEFAULT 0"),
]


def now_ms() -> int:
    return int(time.time() * 1000)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.DB_PATH, timeout=15, isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=15000")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA secure_delete=ON")  # gelöschte Inhalte werden in der DB-Datei überschrieben
    return conn


def conn() -> sqlite3.Connection:
    c = getattr(_local, "conn", None)
    if c is None:
        c = _connect()
        _local.conn = c
    return c


@contextmanager
def tx() -> Iterator[sqlite3.Connection]:
    """Schreibtransaktion (BEGIN IMMEDIATE verhindert Deadlocks zwischen Threads)."""
    c = conn()
    c.execute("BEGIN IMMEDIATE")
    try:
        yield c
        c.execute("COMMIT")
    except BaseException:
        c.execute("ROLLBACK")
        raise


def init() -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    config.UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (config.DATA_DIR / "avatars").mkdir(parents=True, exist_ok=True)
    c = _connect()
    c.executescript(SCHEMA)
    for table, column, decl in MIGRATIONS:
        cols = {r["name"] for r in c.execute(f"PRAGMA table_info({table})")}
        if column not in cols:
            c.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    c.close()


def one(sql: str, *args) -> sqlite3.Row | None:
    return conn().execute(sql, args).fetchone()


def all_(sql: str, *args) -> list[sqlite3.Row]:
    return conn().execute(sql, args).fetchall()
