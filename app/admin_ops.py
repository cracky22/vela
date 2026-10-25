"""Gemeinsame Admin-Logik für die CLI (admin.py) und die Web-Adminseite (admin_web.py).

Reine Datenbank-Funktionen: keine Ausgaben, keine HTTP-Details. Live-Effekte (WebSocket trennen,
Clients benachrichtigen) macht nur der Webserver, weil nur er die Verbindungen kennt.
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import uuid

from . import config, db

DAY_MS = 86_400_000
MB = 1024 * 1024
CATS = ("text", "attachments", "viewonce", "status")
CAT_LABEL = {"text": "Textnachrichten (ohne Anhang)", "attachments": "Nachrichten mit Anhang (Bild/Audio/Datei)",
             "viewonce": "Einmalansichten", "status": "Status"}

AUDIT_SCHEMA = """
CREATE TABLE IF NOT EXISTS admin_audit (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          INTEGER NOT NULL,
    admin_id    TEXT,
    admin_name  TEXT NOT NULL,
    action      TEXT NOT NULL,
    target      TEXT NOT NULL DEFAULT '',
    detail      TEXT NOT NULL DEFAULT '',
    ip          TEXT NOT NULL DEFAULT '',
    prev_hash   TEXT NOT NULL,
    hash        TEXT NOT NULL
)
"""
_extra_done = False


# ------------------------------------------------------------------ Schema
def ensure_extra() -> None:
    """Spalten blocked/last_seen/is_admin und Audit-Tabelle (idempotent, auch im laufenden Server)."""
    global _extra_done
    if _extra_done:
        return
    c = db.conn()
    cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
    for name, decl in (("blocked", "INTEGER NOT NULL DEFAULT 0"), ("last_seen", "INTEGER"),
                       ("is_admin", "INTEGER NOT NULL DEFAULT 0")):
        if name not in cols:
            try:
                c.execute(f"ALTER TABLE users ADD COLUMN {name} {decl}")
            except sqlite3.OperationalError:  # parallel von einem anderen Prozess angelegt
                pass
    c.execute(AUDIT_SCHEMA)
    _extra_done = True


def ensure_schema() -> None:
    """Für die CLI: DB/Tabellen anlegen (falls nötig) und Zusatzspalten ergänzen."""
    db.init()
    ensure_extra()


# ------------------------------------------------------------------ Nutzer finden
def state_code(u: sqlite3.Row) -> str:
    if u["blocked"]:
        return "blocked"
    return "active" if u["activated"] else "pending"


def resolve(ref: str) -> sqlite3.Row:
    """Benutzername -> volle ID -> ID-Anfang (mind. 3 Hex-Zeichen)."""
    u = db.one("SELECT * FROM users WHERE username=? OR id=?", ref, ref.lower())
    if u:
        return u
    if len(ref) >= 3 and all(ch in "0123456789abcdefABCDEF" for ch in ref):
        rows = db.all_("SELECT * FROM users WHERE id LIKE ?", ref.lower() + "%")
        if len(rows) == 1:
            return rows[0]
        if len(rows) > 1:
            names = ", ".join(f"{r['username']} ({r['id'][:8]})" for r in rows)
            raise LookupError(f"'{ref}' ist nicht eindeutig: {names}")
    raise LookupError(f"Kein Nutzer gefunden: '{ref}'")


def list_users(search: str | None = None, blocked: bool = False, pending: bool = False, active: bool = False,
               admins: bool = False, inactive_days: int | None = None, limit: int = 1000) -> list[sqlite3.Row]:
    where: list[str] = []
    args: list = []
    if blocked:
        where.append("blocked=1")
    if pending:
        where.append("activated=0")
    if active:
        where.append("activated=1 AND blocked=0")
    if admins:
        where.append("is_admin=1")
    if inactive_days:
        where.append("COALESCE(last_seen, created_at) < ?")
        args.append(db.now_ms() - inactive_days * DAY_MS)
    if search:
        where.append("(username LIKE ? OR email LIKE ? OR id LIKE ?)")
        args += [f"%{search}%"] * 3
    sql = "SELECT * FROM users" + (" WHERE " + " AND ".join(where) if where else "") + \
          " ORDER BY created_at DESC LIMIT ?"
    return db.all_(sql, *args, limit)


def user_info(uid: str) -> dict | None:
    u = db.one("SELECT * FROM users WHERE id=?", uid)
    if not u:
        return None
    sess = db.one("SELECT COUNT(*) AS n, MAX(created_at) AS t FROM sessions WHERE user_id=?", uid)
    files = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS s FROM files WHERE owner_id=?", uid)
    sel = collect(uid, CATS)
    return {
        "id": uid, "username": u["username"], "email": u["email"], "state": state_code(u),
        "is_admin": bool(u["is_admin"]), "created_at": u["created_at"], "last_seen": u["last_seen"],
        "key_bits": u["key_bits"], "key_version": u["key_version"], "totp_enabled": bool(u["totp_enabled"]),
        "sessions": sess["n"], "last_login": sess["t"],
        "contacts": db.one("SELECT COUNT(*) FROM contacts WHERE user_id=?", uid)[0],
        "groups": db.one("SELECT COUNT(*) FROM group_members WHERE user_id=?", uid)[0],
        "messages": db.one("SELECT COUNT(*) FROM messages WHERE sender_id=? OR recipient_id=?", uid, uid)[0],
        "files": files["n"], "file_bytes": files["s"],
        "content": sel["count"],
    }


# ------------------------------------------------------------------ Sperren / Sitzungen / Admin-Recht
def kill_sessions(c: sqlite3.Connection, uid: str) -> int:
    return c.execute("DELETE FROM sessions WHERE user_id=?", (uid,)).rowcount


def set_blocked(uid: str, flag: bool) -> int:
    """Sperrt/entsperrt. Beim Sperren werden alle Sitzungen beendet. Gibt deren Anzahl zurück."""
    with db.tx() as c:
        c.execute("UPDATE users SET blocked=? WHERE id=?", (1 if flag else 0, uid))
        return kill_sessions(c, uid) if flag else 0


def logout_user(uid: str) -> int:
    with db.tx() as c:
        return kill_sessions(c, uid)


def set_admin(uid: str, flag: bool) -> None:
    with db.tx() as c:
        c.execute("UPDATE users SET is_admin=? WHERE id=?", (1 if flag else 0, uid))


# ------------------------------------------------------------------ Konto löschen (CLI-Weg)
def _group_system(c: sqlite3.Connection, gid: str, actor: str | None, data: dict) -> None:
    now = db.now_ms()
    c.execute("INSERT INTO group_messages (id, group_id, sender_id, envelope, system, created_at, expires_at) "
              "VALUES (?,?,?,NULL,?,?,?)",
              (uuid.uuid4().hex, gid, actor, json.dumps(data), now, now + config.RETENTION_DAYS * DAY_MS))


def delete_user(u: sqlite3.Row) -> dict[str, int]:
    """Entspricht dem Konto-Löschen in der App (ohne Live-Benachrichtigung – die macht nur der Server)."""
    uid = u["id"]
    files: list[str] = []
    group_avatars: list[str] = []
    with db.tx() as c:
        groups = [r["group_id"] for r in c.execute("SELECT group_id FROM group_members WHERE user_id=?", (uid,))]
        for gid in groups:
            c.execute("DELETE FROM group_members WHERE group_id=? AND user_id=?", (gid, uid))
            rest = c.execute("SELECT user_id, role FROM group_members WHERE group_id=? ORDER BY joined_at",
                             (gid,)).fetchall()
            if not rest:
                gf = [r["id"] for r in c.execute(
                    "SELECT f.id FROM files f JOIN group_messages g ON g.id=f.group_message_id WHERE g.group_id=?",
                    (gid,))]
                c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in gf])
                files += gf
                c.execute("DELETE FROM groups WHERE id=?", (gid,))
                group_avatars.append(gid)
                continue
            _group_system(c, gid, uid, {"t": "left", "by": uid, "user": {"id": uid, "username": u["username"]}})
            if not any(r["role"] == "admin" for r in rest):
                new_admin = rest[0]["user_id"]
                c.execute("UPDATE group_members SET role='admin' WHERE group_id=? AND user_id=?", (gid, new_admin))
                name = c.execute("SELECT username FROM users WHERE id=?", (new_admin,)).fetchone()
                _group_system(c, gid, None, {"t": "admin", "by": None, "admin": True,
                                             "user": {"id": new_admin, "username": name["username"] if name else "?"}})
        own = [r["id"] for r in c.execute(
            "SELECT id FROM files WHERE owner_id=? "
            "OR message_id IN (SELECT id FROM messages WHERE sender_id=? OR recipient_id=?) "
            "OR status_id IN (SELECT id FROM statuses WHERE user_id=?)", (uid, uid, uid, uid))]
        c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in own])
        files += own
        n_msgs = c.execute("SELECT COUNT(*) FROM messages WHERE sender_id=? OR recipient_id=?",
                           (uid, uid)).fetchone()[0]
        c.execute("DELETE FROM users WHERE id=?", (uid,))
    remove_files(files)
    (config.DATA_DIR / "avatars" / f"{uid}.jpg").unlink(missing_ok=True)
    for gid in group_avatars:
        (config.DATA_DIR / "avatars" / f"g_{gid}.jpg").unlink(missing_ok=True)
    return {"messages": n_msgs, "files": len(set(files)), "groups": len(groups)}


def remove_files(ids) -> None:
    for fid in set(ids):
        if len(fid) == 32 and all(ch in "0123456789abcdef" for ch in fid):
            (config.UPLOAD_DIR / fid).unlink(missing_ok=True)


# ------------------------------------------------------------------ Inhalte löschen (purge)
def collect(uid: str, cats, scope: str = "all", received: bool = False, older_days: int | None = None,
            min_mb: float | None = None, max_mb: float | None = None) -> dict:
    """Ermittelt, was gelöscht würde. Der Server kennt nur: Anhang ja/nein, Einmalansicht, Status."""
    cats = set(cats)
    lo = None if min_mb is None else min_mb * MB
    hi = None if max_mb is None else max_mb * MB
    cutoff = db.now_ms() - older_days * DAY_MS if older_days else None
    out: dict = {"dm": [], "gm": [], "st": [], "loose": [], "dm_info": [], "gm_info": [],
                 "count": dict.fromkeys(CATS, 0), "bytes": 0}

    def ok(ts: int, size: int) -> bool:
        return (cutoff is None or ts < cutoff) and (lo is None or size >= lo) and (hi is None or size <= hi)

    def kind(view_once: int, nf: int) -> str:
        return "viewonce" if view_once else ("attachments" if nf else "text")

    if scope in ("all", "chats"):
        who, args = ("(x.sender_id=? OR x.recipient_id=?)", (uid, uid)) if received else ("x.sender_id=?", (uid,))
        for r in db.all_(
                "SELECT x.id, x.sender_id, x.recipient_id, x.view_once, x.created_at, "
                "(SELECT COUNT(*) FROM files f WHERE f.message_id=x.id) AS nf, "
                "(SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.message_id=x.id) AS fs "
                f"FROM messages x WHERE x.deleted_at IS NULL AND x.system IS NULL AND {who}", *args):
            k = kind(r["view_once"], r["nf"])
            if k in cats and ok(r["created_at"], r["fs"]):
                out["dm"].append(r["id"])
                out["dm_info"].append((r["id"], r["sender_id"], r["recipient_id"]))
                out["count"][k] += 1
                out["bytes"] += r["fs"]
    if scope in ("all", "groups"):
        for r in db.all_(
                "SELECT x.id, x.group_id, x.created_at, "
                "(SELECT COUNT(*) FROM files f WHERE f.group_message_id=x.id) AS nf, "
                "(SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.group_message_id=x.id) AS fs "
                "FROM group_messages x WHERE x.deleted_at IS NULL AND x.system IS NULL AND x.sender_id=?", uid):
            k = kind(0, r["nf"])
            if k in cats and ok(r["created_at"], r["fs"]):
                out["gm"].append(r["id"])
                out["gm_info"].append((r["id"], r["group_id"]))
                out["count"][k] += 1
                out["bytes"] += r["fs"]
    if "status" in cats and scope == "all":
        for r in db.all_(
                "SELECT x.id, x.created_at, (SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.status_id=x.id) AS fs "
                "FROM statuses x WHERE x.user_id=?", uid):
            if ok(r["created_at"], r["fs"]):
                out["st"].append(r["id"])
                out["count"]["status"] += 1
                out["bytes"] += r["fs"]
    if "attachments" in cats and scope == "all":  # hochgeladen, aber nie versendet
        for r in db.all_("SELECT id, size, created_at FROM files WHERE owner_id=? AND message_id IS NULL "
                         "AND status_id IS NULL AND group_message_id IS NULL", uid):
            if ok(r["created_at"], r["size"]):
                out["loose"].append(r["id"])
                out["count"]["attachments"] += 1
                out["bytes"] += r["size"]
    return out


def purge_user(sel: dict) -> dict:
    """Wie „Für alle löschen“ in der App: Nachricht wird Platzhalter (Ciphertext weg), Dateien werden
    entfernt. Status und lose Dateien werden ganz gelöscht. Gibt Infos für Live-Benachrichtigungen zurück."""
    now = db.now_ms()
    files: list[str] = []
    with db.tx() as c:
        for table, col, ids in (("messages", "message_id", sel["dm"]), ("group_messages", "group_message_id", sel["gm"])):
            for mid in ids:
                c.execute(f"UPDATE {table} SET envelope=NULL, deleted_at=? WHERE id=?", (now, mid))
                files += [r["id"] for r in c.execute(f"SELECT id FROM files WHERE {col}=?", (mid,))]
                c.execute(f"DELETE FROM files WHERE {col}=?", (mid,))
        for sid in sel["st"]:
            files += [r["id"] for r in c.execute("SELECT id FROM files WHERE status_id=?", (sid,))]
            c.execute("DELETE FROM files WHERE status_id=?", (sid,))
            c.execute("DELETE FROM statuses WHERE id=?", (sid,))
        for fid in sel["loose"]:
            c.execute("DELETE FROM files WHERE id=?", (fid,))
            files.append(fid)
    remove_files(files)
    return {"files": len(set(files)), "dm": sel["dm_info"], "gm": sel["gm_info"], "status": bool(sel["st"]), "now": now}


# ------------------------------------------------------------------ Audit-Log (Hash-Kette)
def _audit_hash(prev: str, ts: int, admin_id: str | None, admin_name: str, action: str, target: str,
                detail: str, ip: str) -> str:
    raw = "|".join([prev, str(ts), admin_id or "", admin_name, action, target, detail, ip])
    return hashlib.sha256(raw.encode()).hexdigest()


def audit(admin_id: str | None, admin_name: str, action: str, target: str = "", detail: str = "",
          ip: str = "") -> None:
    """Hängt einen Eintrag an. Jeder Eintrag enthält den Hash des vorherigen -> Änderungen fallen auf."""
    ensure_extra()
    with db.tx() as c:
        row = c.execute("SELECT hash FROM admin_audit ORDER BY id DESC LIMIT 1").fetchone()
        prev = row["hash"] if row else "0" * 64
        ts = db.now_ms()
        h = _audit_hash(prev, ts, admin_id, admin_name, action, target[:300], detail[:500], ip)
        c.execute("INSERT INTO admin_audit (ts, admin_id, admin_name, action, target, detail, ip, prev_hash, hash) "
                  "VALUES (?,?,?,?,?,?,?,?,?)", (ts, admin_id, admin_name, action, target[:300], detail[:500], ip, prev, h))


def audit_list(limit: int = 100) -> dict:
    ensure_extra()
    rows = db.all_("SELECT * FROM admin_audit ORDER BY id ASC")
    prev, broken = "0" * 64, None
    for r in rows:
        want = _audit_hash(prev, r["ts"], r["admin_id"], r["admin_name"], r["action"], r["target"], r["detail"], r["ip"])
        if r["prev_hash"] != prev or r["hash"] != want:
            broken = r["id"]
            break
        prev = r["hash"]
    recent = [dict(r) for r in rows[-limit:]][::-1]
    for r in recent:
        r.pop("prev_hash", None)
    return {"entries": recent, "total": len(rows), "chain_ok": broken is None, "broken_at": broken}