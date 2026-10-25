#!/usr/bin/env python3
"""Vela-Administration: Nutzer auflisten, sperren, entsperren und löschen.

Liegt neben run.py und arbeitet direkt auf der Datenbank (der Server darf dabei weiterlaufen).

    python admin.py                      # interaktiver Modus (Eingabe wie unten, ohne "python admin.py")
    python admin.py list                 # alle Nutzer
    python admin.py list -s max          # Suche nach Name/E-Mail/ID
    python admin.py list --blocked       # nur gesperrte  (auch: --pending)
    python admin.py info max             # Details zu einem Nutzer
    python admin.py block max 3fa9c1     # sperren (mehrere möglich)
    python admin.py unblock max
    python admin.py logout max           # alle Sitzungen beenden, ohne zu sperren
    python admin.py delete max 3fa9 b7e1 # löschen (mehrere möglich, mit Rückfrage)
    python admin.py delete max,peter -y  # Komma-getrennt, ohne Rückfrage
    python admin.py delete --pending     # alle nicht abgeschlossenen Registrierungen

    # Wartungsmodus (Banner "Wartungsarbeiten" in der App, ohne Server-Neustart):
    python admin.py maintenance on                   # einschalten (Standardtext "Wartungsarbeiten")
    python admin.py maintenance on Heute 22-23 Uhr   # mit eigenem Text
    python admin.py maintenance off                  # ausschalten
    python admin.py maintenance                      # Status anzeigen

    python admin.py list --inactive 90               # seit 90 Tagen nicht gesehen

    # Inhalte vorzeitig löschen (statt 30 Tage Aufbewahrung abzuwarten), Konto bleibt bestehen:
    python admin.py purge max --all                  # alles von max (Nachrichten, Anhänge, Status)
    python admin.py purge max --text                 # nur Textnachrichten (ohne Anhang)
    python admin.py purge max --attachments          # nur Nachrichten mit Anhang (Bilder/Audio/Dateien)
    python admin.py purge max --attachments --min-mb 5 --older-than 7   # nur große Anhänge, älter als 7 Tage
    python admin.py purge max peter --status --viewonce --in chats -y   # mehrere Nutzer, ohne Rückfrage

Hinweis zu Bild/Audio/Datei: Alle Inhalte sind Ende-zu-Ende verschlüsselt. Der Server sieht nur,
OB eine Nachricht Anhänge hat, nicht WAS es ist. Bild, Audio und Datei lassen sich daher nicht
sauber trennen – näherungsweise hilft der Größenfilter (--min-mb / --max-mb).

Nutzer können angegeben werden als: Benutzername, volle ID oder ID-Anfang (mind. 3 Zeichen,
in der Liste wird der Anfang mit 8 Zeichen angezeigt).
"""
from __future__ import annotations

import argparse
import json
import shlex
import sqlite3
import sys
import uuid
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from app import config, db, maintenance  # noqa: E402

DAY_MS = 86_400_000


# ------------------------------------------------------------------ Hilfsfunktionen
def ensure_schema() -> None:
    """Legt DB/Tabellen an (falls nötig) und ergänzt die Spalte `blocked`."""
    db.init()
    c = db.conn()
    cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
    if "blocked" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0")
    if "last_seen" not in cols:
        c.execute("ALTER TABLE users ADD COLUMN last_seen INTEGER")


def fmt_ts(ms: int | None) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%d.%m.%Y %H:%M") if ms else "-"


def seen_of(u: sqlite3.Row) -> str:
    """Zuletzt gesehen: der Server schreibt den Wert beim Verbinden, Trennen und alle ~60 s."""
    ts = u["last_seen"]
    if not ts:
        return "-"
    if db.now_ms() - ts < 150_000:
        return "online"
    return fmt_ts(ts)


def state_of(u: sqlite3.Row) -> str:
    if u["blocked"]:
        return "GESPERRT"
    return "aktiv" if u["activated"] else "ausstehend"


def split_refs(refs: list[str]) -> list[str]:
    out: list[str] = []
    for r in refs:
        out += [p.strip() for p in r.split(",") if p.strip()]
    return out


def resolve(ref: str) -> sqlite3.Row:
    """Benutzername -> volle ID -> ID-Anfang."""
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


def resolve_many(refs: list[str]) -> tuple[list[sqlite3.Row], list[str]]:
    users: dict[str, sqlite3.Row] = {}
    errors: list[str] = []
    for ref in split_refs(refs):
        try:
            u = resolve(ref)
            users[u["id"]] = u  # Duplikate zusammenfassen
        except LookupError as e:
            errors.append(str(e))
    return list(users.values()), errors


def confirm(question: str) -> bool:
    try:
        return input(f"{question} [ja/N] ").strip().lower() in ("j", "ja", "y", "yes")
    except EOFError:
        return False


def print_table(rows: list[sqlite3.Row]) -> None:
    if not rows:
        print("Keine Nutzer gefunden.")
        return
    print(f"{'ID':<9}{'Benutzername':<22}{'E-Mail':<32}{'Status':<11}{'Registriert':<17}Zuletzt gesehen")
    for u in rows:
        print(f"{u['id'][:8]:<9}{u['username'][:21]:<22}{u['email'][:31]:<32}{state_of(u):<11}"
              f"{fmt_ts(u['created_at']):<17}{seen_of(u)}")
    print(f"\n{len(rows)} Nutzer")


def report_errors(errors: list[str]) -> None:
    for e in errors:
        print(f"  ! {e}")


# ------------------------------------------------------------------ Befehle
def cmd_list(a: argparse.Namespace) -> None:
    where, args = [], []
    if a.blocked:
        where.append("blocked=1")
    if a.pending:
        where.append("activated=0")
    if a.inactive:
        where.append("COALESCE(last_seen, created_at) < ?")
        args.append(db.now_ms() - a.inactive * DAY_MS)
    if a.search:
        where.append("(username LIKE ? OR email LIKE ? OR id LIKE ?)")
        args += [f"%{a.search}%"] * 3
    sql = "SELECT * FROM users" + (" WHERE " + " AND ".join(where) if where else "") + " ORDER BY created_at DESC"
    print_table(db.all_(sql, *args))


def cmd_info(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        uid = u["id"]
        sess = db.one("SELECT COUNT(*) AS n, MAX(created_at) AS t FROM sessions WHERE user_id=?", uid)
        files = db.one("SELECT COUNT(*) AS n, COALESCE(SUM(size),0) AS s FROM files WHERE owner_id=?", uid)
        msgs = db.one("SELECT COUNT(*) FROM messages WHERE sender_id=? OR recipient_id=?", uid, uid)[0]
        print(f"\n{u['username']}  [{state_of(u)}]")
        print(f"  ID:            {uid}")
        print(f"  E-Mail:        {u['email']}")
        print(f"  Registriert:   {fmt_ts(u['created_at'])}")
        print(f"  Schlüssel:     RSA-{u['key_bits']} (Version {u['key_version']})")
        print(f"  2FA aktiv:     {'ja' if u['totp_enabled'] else 'nein'}")
        print(f"  Zuletzt gesehen: {seen_of(u)}")
        print(f"  Sitzungen:     {sess['n']} (letzte Anmeldung: {fmt_ts(sess['t'])})")
        print(f"  Kontakte:      {db.one('SELECT COUNT(*) FROM contacts WHERE user_id=?', uid)[0]}")
        print(f"  Gruppen:       {db.one('SELECT COUNT(*) FROM group_members WHERE user_id=?', uid)[0]}")
        print(f"  Nachrichten:   {msgs}")
        print(f"  Dateien:       {files['n']} ({files['s'] / 1024 / 1024:.1f} MB)")
        sel = collect(uid, CATS)
        print("  Gesendete Inhalte (löschbar mit 'purge'):")
        for cat in CATS:
            print(f"    {CAT_LABEL[cat]:<42}{sel['count'][cat]}")


def kill_sessions(c: sqlite3.Connection, uid: str) -> int:
    return c.execute("DELETE FROM sessions WHERE user_id=?", (uid,)).rowcount


def cmd_block(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        with db.tx() as c:
            c.execute("UPDATE users SET blocked=1 WHERE id=?", (u["id"],))
            n = kill_sessions(c, u["id"])
        print(f"  ✓ {u['username']} gesperrt ({n} Sitzung(en) beendet)")
    if users:
        print("  Hinweis: Bereits geöffnete WebSocket-Verbindungen enden erst beim Neuladen/Neuverbinden.")


def cmd_unblock(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        with db.tx() as c:
            c.execute("UPDATE users SET blocked=0 WHERE id=?", (u["id"],))
        print(f"  ✓ {u['username']} entsperrt")


def cmd_logout(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        with db.tx() as c:
            n = kill_sessions(c, u["id"])
        print(f"  ✓ {u['username']}: {n} Sitzung(en) beendet")


def _group_system(c: sqlite3.Connection, gid: str, actor: str | None, data: dict) -> None:
    now = db.now_ms()
    c.execute("INSERT INTO group_messages (id, group_id, sender_id, envelope, system, created_at, expires_at) "
              "VALUES (?,?,?,NULL,?,?,?)",
              (uuid.uuid4().hex, gid, actor, json.dumps(data), now, now + config.RETENTION_DAYS * DAY_MS))


def delete_user(u: sqlite3.Row) -> dict[str, int]:
    """Entspricht dem Konto-Löschen in der App: Gruppen verlassen, Nachrichten, Dateien,
    Sitzungen, Kontakte, Status und Avatar entfernen."""
    uid = u["id"]
    files: list[str] = []
    group_avatars: list[str] = []
    with db.tx() as c:
        groups = [r["group_id"] for r in c.execute("SELECT group_id FROM group_members WHERE user_id=?", (uid,))]
        for gid in groups:
            c.execute("DELETE FROM group_members WHERE group_id=? AND user_id=?", (gid, uid))
            rest = c.execute("SELECT user_id, role FROM group_members WHERE group_id=? ORDER BY joined_at",
                             (gid,)).fetchall()
            if not rest:  # letztes Mitglied -> Gruppe samt Dateien löschen
                gf = [r["id"] for r in c.execute(
                    "SELECT f.id FROM files f JOIN group_messages g ON g.id=f.group_message_id WHERE g.group_id=?",
                    (gid,))]
                c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in gf])
                files += gf
                c.execute("DELETE FROM groups WHERE id=?", (gid,))
                group_avatars.append(gid)
                continue
            _group_system(c, gid, uid, {"t": "left", "by": uid, "user": {"id": uid, "username": u["username"]}})
            if not any(r["role"] == "admin" for r in rest):  # ältestes Mitglied wird Admin
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
        c.execute("DELETE FROM users WHERE id=?", (uid,))  # Rest per ON DELETE CASCADE
    for fid in set(files):
        (config.UPLOAD_DIR / fid).unlink(missing_ok=True)
    (config.DATA_DIR / "avatars" / f"{uid}.jpg").unlink(missing_ok=True)
    for gid in group_avatars:
        (config.DATA_DIR / "avatars" / f"g_{gid}.jpg").unlink(missing_ok=True)
    return {"messages": n_msgs, "files": len(set(files)), "groups": len(groups)}


def cmd_delete(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    if a.pending:
        cutoff = db.now_ms() + 1 if a.all_pending else db.now_ms() - config.PENDING_ACCOUNT_HOURS * 3_600_000
        seen = {u["id"] for u in users}
        users += [r for r in db.all_("SELECT * FROM users WHERE activated=0 AND created_at < ?", cutoff)
                  if r["id"] not in seen]
    report_errors(errors)
    if not users:
        print("Nichts zu löschen.")
        return
    print("Folgende Nutzer werden UNWIDERRUFLICH gelöscht (inkl. Nachrichten, Dateien, Kontakte):")
    for u in users:
        print(f"  - {u['username']:<20} {u['id'][:8]}  {u['email']}  [{state_of(u)}]")
    if errors and not a.yes and not confirm(f"{len(errors)} Angabe(n) nicht gefunden – trotzdem fortfahren?"):
        return
    if not a.yes and not confirm(f"{len(users)} Nutzer wirklich löschen?"):
        print("Abgebrochen.")
        return
    for u in users:
        try:
            s = delete_user(u)
            print(f"  ✓ {u['username']} gelöscht ({s['messages']} Nachrichten, {s['files']} Dateien, "
                  f"{s['groups']} Gruppen)")
        except Exception as e:  # einzelner Fehler stoppt nicht die restlichen Löschungen
            print(f"  ✗ {u['username']}: {e}")
    print("  Hinweis: Verbundene Clients der Kontakte aktualisieren sich beim nächsten Neuladen.")


# ------------------------------------------------------------------ Wartungsmodus
def cmd_maintenance(a: argparse.Namespace) -> None:
    action = (a.action or "status").lower()
    if action == "on":
        m = maintenance.set_(True, " ".join(a.text))
        print(f"  ✓ Wartungsmodus AN: \"{m['message']}\"")
        print("    Clients zeigen das gelbe Banner innerhalb weniger Sekunden (kein Server-Neustart nötig).")
    elif action == "off":
        maintenance.set_(False)
        print("  ✓ Wartungsmodus AUS")
    elif action == "status":
        m = maintenance.get()
        if m["on"]:
            print(f"  Wartungsmodus: AN seit {fmt_ts(m['since'])} – \"{m['message']}\"")
        else:
            print("  Wartungsmodus: aus")
    else:
        print("Bitte 'on', 'off' oder 'status' angeben.")


# ------------------------------------------------------------------ Inhalte löschen (purge)
CATS = ("text", "attachments", "viewonce", "status")
CAT_LABEL = {"text": "Textnachrichten (ohne Anhang)", "attachments": "Nachrichten mit Anhang (Bild/Audio/Datei)",
             "viewonce": "Einmalansichten", "status": "Status"}
MB = 1024 * 1024


def collect(uid: str, cats, scope: str = "all", received: bool = False, older_days: int | None = None,
            min_mb: float | None = None, max_mb: float | None = None) -> dict:
    """Ermittelt, was gelöscht würde. Der Server kennt nur: Anhang ja/nein, Einmalansicht, Status."""
    cats = set(cats)
    lo = None if min_mb is None else min_mb * MB
    hi = None if max_mb is None else max_mb * MB
    cutoff = db.now_ms() - older_days * DAY_MS if older_days else None
    out: dict = {"dm": [], "gm": [], "st": [], "loose": [], "count": dict.fromkeys(CATS, 0), "bytes": 0}

    def ok(ts: int, size: int) -> bool:
        return (cutoff is None or ts < cutoff) and (lo is None or size >= lo) and (hi is None or size <= hi)

    def kind(view_once: int, nf: int) -> str:
        return "viewonce" if view_once else ("attachments" if nf else "text")

    if scope in ("all", "chats"):
        who, args = ("(x.sender_id=? OR x.recipient_id=?)", (uid, uid)) if received else ("x.sender_id=?", (uid,))
        for r in db.all_(
                "SELECT x.id, x.view_once, x.created_at, "
                "(SELECT COUNT(*) FROM files f WHERE f.message_id=x.id) AS nf, "
                "(SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.message_id=x.id) AS fs "
                f"FROM messages x WHERE x.deleted_at IS NULL AND x.system IS NULL AND {who}", *args):
            k = kind(r["view_once"], r["nf"])
            if k in cats and ok(r["created_at"], r["fs"]):
                out["dm"].append(r["id"])
                out["count"][k] += 1
                out["bytes"] += r["fs"]
    if scope in ("all", "groups"):
        for r in db.all_(
                "SELECT x.id, x.created_at, "
                "(SELECT COUNT(*) FROM files f WHERE f.group_message_id=x.id) AS nf, "
                "(SELECT COALESCE(SUM(f.size),0) FROM files f WHERE f.group_message_id=x.id) AS fs "
                "FROM group_messages x WHERE x.deleted_at IS NULL AND x.system IS NULL AND x.sender_id=?", uid):
            k = kind(0, r["nf"])
            if k in cats and ok(r["created_at"], r["fs"]):
                out["gm"].append(r["id"])
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


def purge_user(sel: dict) -> int:
    """Wie „Für alle löschen“ in der App: Nachricht wird zum Platzhalter (Ciphertext weg),
    zugehörige Dateien werden entfernt. Status und lose Dateien werden ganz gelöscht."""
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
    for fid in set(files):
        (config.UPLOAD_DIR / fid).unlink(missing_ok=True)
    return len(set(files))


def cmd_purge(a: argparse.Namespace) -> None:
    cats = set(CATS) if a.all else {c for c in CATS if getattr(a, c)}
    if not cats:
        print("Bitte angeben, was gelöscht werden soll: --text, --attachments, --viewonce, --status oder --all")
        return
    users, errors = resolve_many(a.users)
    report_errors(errors)
    plans = []
    for u in users:
        sel = collect(u["id"], cats, a.scope, a.received, a.older_than, a.min_mb, a.max_mb)
        plans.append((u, sel))
    if not plans:
        return
    print("Geplante Löschung (Konto bleibt bestehen):")
    total = 0
    for u, sel in plans:
        parts = [f"{sel['count'][c]} {CAT_LABEL[c]}" for c in CATS if c in cats]
        n = sum(sel["count"].values())
        total += n
        print(f"  - {u['username']:<20} {', '.join(parts)}  ({sel['bytes'] / MB:.1f} MB Dateien)")
    if not total:
        print("Nichts zu löschen.")
        return
    if not a.yes and not confirm("Wirklich löschen?"):
        print("Abgebrochen.")
        return
    for u, sel in plans:
        try:
            nfiles = purge_user(sel)
            print(f"  ✓ {u['username']}: {sum(sel['count'].values())} Einträge gelöscht, {nfiles} Datei(en) entfernt")
        except Exception as e:
            print(f"  ✗ {u['username']}: {e}")
    print("  Hinweis: Offene Clients zeigen die Löschung nach Neuladen.")


# ------------------------------------------------------------------ CLI
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="admin.py", description="Vela-Administration")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("list", aliases=["ls"], help="Nutzer auflisten")
    s.add_argument("-s", "--search", help="Suche in Name, E-Mail, ID")
    s.add_argument("--blocked", action="store_true", help="nur gesperrte")
    s.add_argument("--pending", action="store_true", help="nur nicht aktivierte")
    s.add_argument("--inactive", type=int, metavar="TAGE", help="nur Nutzer, die seit TAGE Tagen nicht gesehen wurden")
    s.set_defaults(fn=cmd_list)

    for name, fn, helptext in (("info", cmd_info, "Details anzeigen"),
                               ("block", cmd_block, "Nutzer sperren"),
                               ("unblock", cmd_unblock, "Nutzer entsperren"),
                               ("logout", cmd_logout, "alle Sitzungen beenden")):
        s = sub.add_parser(name, help=helptext)
        s.add_argument("users", nargs="+", metavar="NUTZER", help="Name, ID oder ID-Anfang (mehrere erlaubt)")
        s.set_defaults(fn=fn)

    s = sub.add_parser("delete", aliases=["rm"], help="Nutzer löschen (mehrere möglich)")
    s.add_argument("users", nargs="*", metavar="NUTZER", help="Name, ID oder ID-Anfang (mehrere erlaubt)")
    s.add_argument("-y", "--yes", action="store_true", help="ohne Rückfrage")
    s.add_argument("--pending", action="store_true",
                   help=f"zusätzlich alle nicht aktivierten Konten älter als {config.PENDING_ACCOUNT_HOURS} h")
    s.add_argument("--all-pending", action="store_true", help="mit --pending: unabhängig vom Alter")
    s.set_defaults(fn=cmd_delete)

    s = sub.add_parser("maintenance", aliases=["wartung"], help="Wartungsmodus an/aus")
    s.add_argument("action", nargs="?", choices=["on", "off", "status"], default="status")
    s.add_argument("text", nargs="*", help="Anzeigetext (nur bei 'on'), Standard: Wartungsarbeiten")
    s.set_defaults(fn=cmd_maintenance)

    s = sub.add_parser("purge", aliases=["clean"], help="Inhalte vorzeitig löschen (Konto bleibt)")
    s.add_argument("users", nargs="+", metavar="NUTZER", help="Name, ID oder ID-Anfang (mehrere erlaubt)")
    s.add_argument("--text", action="store_true", help="Textnachrichten ohne Anhang")
    s.add_argument("--attachments", "--files", "--media", dest="attachments", action="store_true",
                   help="Nachrichten mit Anhang (Bild/Audio/Datei – vom Server nicht unterscheidbar)")
    s.add_argument("--viewonce", action="store_true", help="Einmalansicht-Nachrichten")
    s.add_argument("--status", action="store_true", help="Status-Beiträge")
    s.add_argument("--all", action="store_true", help="alles oben Genannte")
    s.add_argument("--in", dest="scope", choices=["all", "chats", "groups"], default="all",
                   help="nur Einzelchats oder nur Gruppen (Standard: all)")
    s.add_argument("--received", action="store_true",
                   help="auch Nachrichten, die der Nutzer in Einzelchats empfangen hat (Standard: nur gesendete)")
    s.add_argument("--older-than", type=int, metavar="TAGE", help="nur Inhalte älter als TAGE")
    s.add_argument("--min-mb", type=float, help="nur Anhänge ab dieser Größe (MB, verschlüsselt)")
    s.add_argument("--max-mb", type=float, help="nur Anhänge bis zu dieser Größe (MB, verschlüsselt)")
    s.add_argument("-y", "--yes", action="store_true", help="ohne Rückfrage")
    s.set_defaults(fn=cmd_purge)
    return p


def run(argv: list[str], parser: argparse.ArgumentParser) -> None:
    args = parser.parse_args(argv)
    if not getattr(args, "fn", None):
        parser.print_help()
        return
    if args.fn is cmd_delete and not args.users and not args.pending:
        parser.error("delete: mindestens einen Nutzer angeben (oder --pending)")
    args.fn(args)


def main() -> None:
    if not config.DB_PATH.exists():
        sys.exit(f"Datenbank nicht gefunden: {config.DB_PATH}\n(Ggf. VELA_DATA_DIR setzen wie beim Server.)")
    ensure_schema()
    parser = build_parser()
    if len(sys.argv) > 1:
        run(sys.argv[1:], parser)
        return
    print("Vela-Admin – 'help' für Befehle, 'exit' zum Beenden.\n")
    cmd_list(argparse.Namespace(search=None, blocked=False, pending=False, inactive=None))
    while True:
        try:
            line = input("\nadmin> ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            break
        if line in ("exit", "quit", "q"):
            break
        if not line:
            continue
        if line in ("help", "?"):
            parser.print_help()
            continue
        try:
            run(shlex.split(line), parser)
        except SystemExit:  # argparse-Fehler beenden nicht das Programm
            pass
        except Exception as e:
            print(f"Fehler: {e}")


if __name__ == "__main__":
    main()