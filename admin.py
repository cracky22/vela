#!/usr/bin/env python3
"""Vela-Administration (Kommandozeile): Nutzer auflisten, sperren, löschen, Inhalte löschen, Wartungsmodus.

Liegt neben run.py und arbeitet direkt auf der Datenbank. Bequemer und ohne Datenbank-Locks geht es
bei laufendem Server über die Web-Adminseite (/admin) – diese CLI ist dafür gedacht, den ersten
Admin zu bestimmen und als Notfallzugang bei gestopptem Server.

    python admin.py                      # interaktiver Modus (Eingabe wie unten, ohne "python admin.py")
    python admin.py list                 # alle Nutzer          (-s TEXT suchen, --blocked, --pending, --inactive TAGE)
    python admin.py info max             # Details zu einem Nutzer
    python admin.py block max 3fa9c1     # sperren (mehrere möglich);  unblock / logout analog
    python admin.py delete max,peter -y  # löschen (mehrere, Komma oder Leerzeichen, -y = ohne Rückfrage)
    python admin.py delete --pending     # alle nicht abgeschlossenen Registrierungen

    python admin.py admins               # Admins der Weboberfläche anzeigen
    python admin.py admins grant max     # max darf /admin benutzen (Konto muss existieren, 2FA aktiv)
    python admin.py admins revoke max

    python admin.py maintenance on Heute 22-23 Uhr   # Wartungsmodus an (ohne Text: "Wartungsarbeiten")
    python admin.py maintenance off                  # aus;  ohne Argument: Status

    python admin.py purge max --all                  # Inhalte vorzeitig löschen, Konto bleibt
    python admin.py purge max --attachments --min-mb 5 --older-than 7
    python admin.py purge max peter --status --viewonce --in chats -y

    python admin.py doctor               # Selbstprüfung: richtige Dateien/Ordner/Datenbank? Web-Admin eingebunden?

Nutzer: Benutzername, volle ID oder ID-Anfang (mind. 3 Zeichen).
Hinweis zu Bild/Audio/Datei: Inhalte sind Ende-zu-Ende verschlüsselt, der Server sieht nur, OB eine
Nachricht Anhänge hat – Bild, Audio und Datei sind nicht unterscheidbar (näherungsweise: --min-mb/--max-mb).
"""
from __future__ import annotations

import argparse
import os
import shlex
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

BASE = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE))

from app import admin_ops as ops  # noqa: E402
from app import config, db, maintenance  # noqa: E402

CAT_LABEL, CATS, MB = ops.CAT_LABEL, ops.CATS, ops.MB
STATE_LABEL = {"blocked": "GESPERRT", "active": "aktiv", "pending": "ausstehend"}


# ------------------------------------------------------------------ Hilfsfunktionen
def fmt_ts(ms: int | None) -> str:
    return datetime.fromtimestamp(ms / 1000).strftime("%d.%m.%Y %H:%M") if ms else "-"


def state_of(u: sqlite3.Row) -> str:
    return STATE_LABEL[ops.state_code(u)]


def seen_of(u: sqlite3.Row) -> str:
    """Zuletzt gesehen: der Server schreibt den Wert beim Verbinden, Trennen und alle ~60 s."""
    ts = u["last_seen"]
    if not ts:
        return "-"
    return "online" if db.now_ms() - ts < 150_000 else fmt_ts(ts)


def split_refs(refs: list[str]) -> list[str]:
    out: list[str] = []
    for r in refs:
        out += [p.strip() for p in r.split(",") if p.strip()]
    return out


def resolve_many(refs: list[str]) -> tuple[list[sqlite3.Row], list[str]]:
    users: dict[str, sqlite3.Row] = {}
    errors: list[str] = []
    for ref in split_refs(refs):
        try:
            u = ops.resolve(ref)
            users[u["id"]] = u
        except LookupError as e:
            errors.append(str(e))
    return list(users.values()), errors


def confirm(question: str) -> bool:
    try:
        return input(f"{question} [ja/N] ").strip().lower() in ("j", "ja", "y", "yes")
    except EOFError:
        return False


def report_errors(errors: list[str]) -> None:
    for e in errors:
        print(f"  ! {e}")


def log(action: str, target: str = "", detail: str = "") -> None:
    ops.audit(None, "CLI", action, target, detail)


def label(u: sqlite3.Row) -> str:
    return f"{u['username']} ({u['id'][:8]})"


# ------------------------------------------------------------------ Befehle: Nutzer
def cmd_list(a: argparse.Namespace) -> None:
    rows = ops.list_users(a.search, a.blocked, a.pending, inactive_days=a.inactive)
    if not rows:
        print("Keine Nutzer gefunden.")
        return
    print(f"{'ID':<9}{'Benutzername':<22}{'E-Mail':<32}{'Status':<11}{'Registriert':<17}Zuletzt gesehen")
    for u in rows:
        adm = " [Admin]" if u["is_admin"] else ""
        print(f"{u['id'][:8]:<9}{(u['username'] + adm)[:21]:<22}{u['email'][:31]:<32}{state_of(u):<11}"
              f"{fmt_ts(u['created_at']):<17}{seen_of(u)}")
    print(f"\n{len(rows)} Nutzer")


def cmd_info(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        d = ops.user_info(u["id"])
        print(f"\n{d['username']}  [{state_of(u)}]{'  [Admin]' if d['is_admin'] else ''}")
        print(f"  ID:              {d['id']}")
        print(f"  E-Mail:          {d['email']}")
        print(f"  Registriert:     {fmt_ts(d['created_at'])}")
        print(f"  Schlüssel:       RSA-{d['key_bits']} (Version {d['key_version']})")
        print(f"  2FA aktiv:       {'ja' if d['totp_enabled'] else 'nein'}")
        print(f"  Zuletzt gesehen: {seen_of(u)}")
        print(f"  Sitzungen:       {d['sessions']} (letzte Anmeldung: {fmt_ts(d['last_login'])})")
        print(f"  Kontakte:        {d['contacts']}")
        print(f"  Gruppen:         {d['groups']}")
        print(f"  Nachrichten:     {d['messages']}")
        print(f"  Dateien:         {d['files']} ({d['file_bytes'] / MB:.1f} MB)")
        print("  Gesendete Inhalte (löschbar mit 'purge'):")
        for cat in CATS:
            print(f"    {CAT_LABEL[cat]:<42}{d['content'][cat]}")


def cmd_block(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        n = ops.set_blocked(u["id"], True)
        log("user.block", label(u), f"{n} Sitzung(en) beendet")
        print(f"  ✓ {u['username']} gesperrt ({n} Sitzung(en) beendet)")
    if users:
        print("  Hinweis: Geöffnete Verbindungen enden erst beim Neuladen. Über die Weboberfläche (/admin) "
              "werden sie sofort getrennt.")


def cmd_unblock(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        ops.set_blocked(u["id"], False)
        log("user.unblock", label(u))
        print(f"  ✓ {u['username']} entsperrt")


def cmd_logout(a: argparse.Namespace) -> None:
    users, errors = resolve_many(a.users)
    report_errors(errors)
    for u in users:
        n = ops.logout_user(u["id"])
        log("user.logout", label(u), f"{n} Sitzung(en)")
        print(f"  ✓ {u['username']}: {n} Sitzung(en) beendet")


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
            s = ops.delete_user(u)
            log("user.delete", label(u), f"{u['email']}, {s['files']} Datei(en)")
            print(f"  ✓ {u['username']} gelöscht ({s['messages']} Nachrichten, {s['files']} Dateien, {s['groups']} Gruppen)")
        except Exception as e:
            print(f"  ✗ {u['username']}: {e}")
    print("  Hinweis: Verbundene Clients der Kontakte aktualisieren sich beim nächsten Neuladen.")


# ------------------------------------------------------------------ Befehle: Admins, Wartung
def cmd_admins(a: argparse.Namespace) -> None:
    if a.action in ("grant", "revoke"):
        users, errors = resolve_many(a.users)
        report_errors(errors)
        for u in users:
            if a.action == "grant" and not u["activated"]:
                print(f"  ! {u['username']}: Konto ist nicht aktiviert (2FA fehlt)")
                continue
            ops.set_admin(u["id"], a.action == "grant")
            log("admins." + a.action, label(u))
            print(f"  ✓ {u['username']}: Admin-Recht {'erteilt' if a.action == 'grant' else 'entzogen'}")
        return
    rows = ops.list_users(admins=True)
    print("Admins: " + (", ".join(u["username"] for u in rows) if rows else "keine – vergeben mit: admins grant NAME"))


def cmd_maintenance(a: argparse.Namespace) -> None:
    action = (a.action or "status").lower()
    if action == "on":
        m = maintenance.set_(True, " ".join(a.text))
        log("maintenance.on", "", m["message"])
        print(f"  ✓ Wartungsmodus AN: \"{m['message']}\"")
        print("    Clients zeigen das gelbe Banner innerhalb weniger Sekunden (kein Server-Neustart nötig).")
    elif action == "off":
        maintenance.set_(False)
        log("maintenance.off")
        print("  ✓ Wartungsmodus AUS")
    else:
        m = maintenance.get()
        print(f"  Wartungsmodus: AN seit {fmt_ts(m['since'])} – \"{m['message']}\"" if m["on"] else "  Wartungsmodus: aus")


# ------------------------------------------------------------------ Befehl: doctor
def cmd_doctor(a: argparse.Namespace) -> None:
    """Zeigt, ob dieser Projektordner vollständig und der Web-Admin eingebunden ist."""
    env = os.environ.get("VELA_DATA_DIR")
    print(f"Projektordner:     {BASE}")
    print(f"Datenverzeichnis:  {config.DATA_DIR}   (VELA_DATA_DIR {'= ' + env if env else 'nicht gesetzt'})")
    size = f", {config.DB_PATH.stat().st_size / MB:.1f} MB" if config.DB_PATH.exists() else ""
    print(f"Datenbank:         {config.DB_PATH}   ({'vorhanden' + size if config.DB_PATH.exists() else 'FEHLT'})")
    main_py = BASE / "app" / "main.py"
    text = main_py.read_text("utf-8", "replace") if main_py.exists() else ""
    print("\nIn app/main.py:")
    for desc, needle in (("Web-Admin eingebunden (admin_web.init)", "admin_web.init"),
                         ("Wartungs-Endpunkt /api/maintenance", '"/api/maintenance"'),
                         ("Sperr-Prüfung (u.blocked)", "u.blocked"),
                         ("Zuletzt-gesehen (touch_last_seen)", "touch_last_seen")):
        print(f"  {'✓' if needle in text else '✗'} {desc}")
    print("\nDateien:")
    for rel in ("app/admin_web.py", "app/admin_ops.py", "app/maintenance.py", "static/admin.html", "static/css/admin.css",
                "static/js/admin.js", "static/js/admin-base.js", "static/js/conn.js"):
        print(f"  {'✓' if (BASE / rel).exists() else '✗'} {rel}")
    m = maintenance.get()
    print(f"\nWartungsmodus:     {'AN – ' + m['message'] if m['on'] else 'aus'}")
    admins = ops.list_users(admins=True)
    print(f"Admins:            {', '.join(u['username'] for u in admins) if admins else 'keine (admins grant NAME)'}")
    print("\nTipp: Läuft der Server aus einem anderen Ordner oder mit anderem VELA_DATA_DIR, gelten diese Werte nicht für ihn.")


# ------------------------------------------------------------------ Befehl: Inhalte löschen (purge)
def cmd_purge(a: argparse.Namespace) -> None:
    cats = set(CATS) if a.all else {c for c in CATS if getattr(a, c)}
    if not cats:
        print("Bitte angeben, was gelöscht werden soll: --text, --attachments, --viewonce, --status oder --all")
        return
    users, errors = resolve_many(a.users)
    report_errors(errors)
    plans = [(u, ops.collect(u["id"], cats, a.scope, a.received, a.older_than, a.min_mb, a.max_mb)) for u in users]
    if not plans:
        return
    print("Geplante Löschung (Konto bleibt bestehen):")
    total = 0
    for u, sel in plans:
        parts = [f"{sel['count'][c]} {CAT_LABEL[c]}" for c in CATS if c in cats]
        total += sum(sel["count"].values())
        print(f"  - {u['username']:<20} {', '.join(parts)}  ({sel['bytes'] / MB:.1f} MB Dateien)")
    if not total:
        print("Nichts zu löschen.")
        return
    if not a.yes and not confirm("Wirklich löschen?"):
        print("Abgebrochen.")
        return
    for u, sel in plans:
        try:
            res = ops.purge_user(sel)
            n = sum(sel["count"].values())
            log("user.purge", label(u), f"{','.join(sorted(cats))} -> {n} Einträge, {res['files']} Datei(en)")
            print(f"  ✓ {u['username']}: {n} Einträge gelöscht, {res['files']} Datei(en) entfernt")
        except Exception as e:
            print(f"  ✗ {u['username']}: {e}")
    print("  Hinweis: Offene Clients zeigen die Löschung nach Neuladen (über /admin sofort).")


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

    for name, fn, helptext in (("info", cmd_info, "Details anzeigen"), ("block", cmd_block, "Nutzer sperren"),
                               ("unblock", cmd_unblock, "Nutzer entsperren"), ("logout", cmd_logout, "alle Sitzungen beenden")):
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

    s = sub.add_parser("admins", help="Admins der Weboberfläche (/admin) verwalten")
    s.add_argument("action", nargs="?", choices=["list", "grant", "revoke"], default="list")
    s.add_argument("users", nargs="*", metavar="NUTZER")
    s.set_defaults(fn=cmd_admins)

    s = sub.add_parser("doctor", help="Selbstprüfung der Installation")
    s.set_defaults(fn=cmd_doctor)

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
    if args.fn is cmd_admins and args.action in ("grant", "revoke") and not args.users:
        parser.error("admins grant/revoke: Nutzer angeben")
    args.fn(args)


def main() -> None:
    if not config.DB_PATH.exists():
        sys.exit(f"Datenbank nicht gefunden: {config.DB_PATH}\n(Ggf. VELA_DATA_DIR setzen wie beim Server.)")
    ops.ensure_schema()
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
        except SystemExit:
            pass
        except Exception as e:
            print(f"Fehler: {e}")


if __name__ == "__main__":
    main()