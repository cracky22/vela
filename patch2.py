#!/usr/bin/env python3
"""Spielt Push-Benachrichtigungen (Android-Fix), den „Was ist neu“-Dialog und den GitHub-Link an der
Versionsnummer in deine Vela-Dateien ein.

    python patch_vela2.py            # im Projektordner (neben run.py) ausführen

Geändert: app/main.py, static/js/app.js, static/js/profile.js, static/css/app.css
Vorher kopieren: app/push.py, static/sw.js, static/badge-96.png, static/js/notify.js, static/js/changelog.js
Zusätzlich auf dem Server:  ./venv/bin/pip install pywebpush

Backups (<datei>.bak), mehrfach ausführbar, bricht pro Datei ohne Schreiben ab, wenn eine Stelle fehlt.
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NEED = ["app/push.py", "static/sw.js", "static/badge-96.png", "static/js/notify.js", "static/js/changelog.js"]
TARGET_VERSION = (1, 3, 0)

NOTIFY_OLD = ("try { new Notification('Vela', { body: c.kind === 'group' ? `Neue Nachricht in „${c.name}“` : "
              "`Neue Nachricht von ${c.username}`, tag: convId, icon: `${BASE_PATH}/static/icon-192.png` }); } "
              "catch { /* ok */ }")
NOTIFY_NEW = ("if (!S.pushActive) showLocal({ title: 'Vela', body: c.kind === 'group' ? `Neue Nachricht in „${c.name}“` : "
              "`Neue Nachricht von ${c.username}`, tag: convId });")

MAIN_EDITS = [
    ("Push-Modul und /sw.js einbinden", "push.init(",
     '@app.api_route("/{path:path}", methods=["GET", "HEAD"])\ndef spa(path: str):\n',
     '# ---- Web-Push (Benachrichtigungen bei geschlossener App) und /sw.js – vor der SPA-Catch-all-Route\n'
     'from . import push  # noqa: E402\n\n'
     'push.init(app, {"COOKIE": COOKIE, "lookup_session": lookup_session, "rate": rate})\n\n\n'
     '@app.api_route("/{path:path}", methods=["GET", "HEAD"])\ndef spa(path: str):\n'),

    ("Push bei 1:1-Nachrichten", "push.notify_dm",
     '    manager.notify(me_, {"type": "message", "message": msg_out(row, me_)})  # andere eigene Geräte\n    return msg_out(row, me_)\n',
     '    manager.notify(me_, {"type": "message", "message": msg_out(row, me_)})  # andere eigene Geräte\n'
     '    push.notify_dm(me_, body.to, body.silent)\n    return msg_out(row, me_)\n'),

    ("Push bei Gruppennachrichten", "push.notify_group_msg",
     '    notify_group(gid, {"type": "message", "message": out})\n    return out\n',
     '    notify_group(gid, {"type": "message", "message": out})\n'
     '    push.notify_group_msg(gid, me_, body.silent)\n    return out\n'),
]

APP_JS_EDITS = [
    ("Imports notify.js / changelog.js", "from './notify.js'",
     "import { initProfile, renderProfileView } from './profile.js';\n",
     "import { initProfile, renderProfileView } from './profile.js';\n"
     "import { initNotify, showLocal, disablePush } from './notify.js';\n"
     "import { maybeShowChangelog } from './changelog.js';\n"),

    ("Start nach dem Login: Push-Abo, Changelog", "initNotify({",
     "  loadStatuses().then(refreshNav).catch(() => {});\n  connectWS();\n}\n",
     "  loadStatuses().then(refreshNav).catch(() => {});\n  connectWS();\n"
     "  initNotify({ enabled: S.prefs.notifications, openChat: (id) => { if (S.contacts.has(id) || S.groups.has(id)) { switchView('chats'); openChat(id); } } });\n"
     "  maybeShowChangelog(version, S.me);\n}\n"),

    ("Lokale Benachrichtigung über Service Worker (Android)", "showLocal({", NOTIFY_OLD, NOTIFY_NEW),

    ("Abmelden: Push-Abo entfernen", "disablePush().catch",
     "export async function logout(wipe) {\n",
     "export async function logout(wipe) {\n  await disablePush().catch(() => {});\n"),
]

PROFILE_EDITS = [
    ("Import notify.js", "from './notify.js'",
     "import { startRotate } from './auth.js';\n",
     "import { startRotate } from './auth.js';\nimport { enablePush, disablePush } from './notify.js';\n"),

    ("Versionsnummer als GitHub-Link", "version-link",
     "h('pre', { class: 'small muted center' }, 'com.crackyOS.vela · ' + version + ' · © 2026 Martin B.')",
     "h('pre', { class: 'small muted center' }, 'com.crackyOS.vela · ', "
     "h('a', { class: 'version-link', href: 'https://github.com/cracky22/vela/releases', target: '_blank', "
     "rel: 'noopener noreferrer', title: 'Versionen auf GitHub ansehen' }, version), ' · © 2026 Martin B.')"),

    ("Schalter aktiviert/deaktiviert Push", "enablePush()",
     "          S.prefs.notifications = v; store.setPref('notifications', v);\n",
     "          S.prefs.notifications = v; store.setPref('notifications', v);\n"
     "          if (v) { const r = await enablePush(); snackbar(r.ok ? 'Push aktiv – du wirst auch bei geschlossener App benachrichtigt' : 'Benachrichtigungen aktiv. ' + r.reason); } else { await disablePush(); }\n"),
]
PROFILE_OPTIONAL = [
    ("Beschreibungstext", "Auch bei geschlossener App.",
     "desc: 'Nur „Neue Nachricht von …“ - niemals der Inhalt.'",
     "desc: 'Nur „Neue Nachricht von …“ – niemals der Inhalt. Auch bei geschlossener App.'"),
]

CSS_NEW = """/* Changelog „Was ist neu“ (changelog.js) und Versions-Link */
.m3-dialog.changelog-dialog { max-width: min(560px, calc(100vw - 32px)); }
.changelog { display: flex; flex-direction: column; gap: 22px; max-height: min(58vh, 520px); overflow-y: auto; padding-right: 2px; }
.changelog-ver { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
.changelog-ver .badge-v { padding: 4px 12px; border-radius: var(--shape-full); background: var(--primary-container); color: var(--on-primary-container); font-weight: 600; font-size: 13px; }
.changelog-ver .date { color: var(--on-surface-variant); font-size: 12px; }
.changelog-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 16px; }
.changelog-list li { display: flex; gap: 14px; align-items: flex-start; }
.changelog-ic { flex: none; width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--secondary-container); color: var(--on-secondary-container); }
.changelog-list b { display: block; font-weight: 500; margin-bottom: 2px; }
.changelog-list .txt { display: block; color: var(--on-surface-variant); font-size: 14px; line-height: 1.45; }
.version-link { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
.version-link:hover, .version-link:focus-visible { color: var(--primary); }"""


def read(path: Path) -> tuple[str, str]:
    raw = path.read_bytes().decode("utf-8")
    return raw.replace("\r\n", "\n"), "\r\n" if "\r\n" in raw else "\n"


def finish(path: Path, rel: str, old: str, new: str, eol: str, notes: list[str], ok: bool) -> bool:
    print(("✓ " if ok else "✗ ") + rel)
    print("\n".join(notes))
    if not ok:
        print("  -> nichts geschrieben")
        return False
    if new != old:
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
        path.write_bytes(new.replace("\n", eol).encode("utf-8"))
    return True


def bump_version(text: str) -> tuple[str, str]:
    """Erhöht `export const version = '...'` auf TARGET_VERSION, falls niedriger (sonst unverändert)."""
    m = re.search(r"export const version = (['\"])v?(\d+)\.(\d+)(?:\.(\d+))?\1;", text)
    if not m:
        return text, "  - Versionsnummer: nicht gefunden (bitte selbst auf 'v1.3.0' setzen, sonst erscheint der Dialog nicht)"
    cur = (int(m.group(2)), int(m.group(3)), int(m.group(4) or 0))
    if cur >= TARGET_VERSION:
        return text, f"  = Versionsnummer v{'.'.join(map(str, cur))} (schon ≥ 1.3.0)"
    new = f"export const version = {m.group(1)}v{'.'.join(map(str, TARGET_VERSION))}{m.group(1)};"
    return text.replace(m.group(0), new, 1), f"  ✓ Versionsnummer auf v{'.'.join(map(str, TARGET_VERSION))} erhöht"


def patch(rel: str, edits: list, optional: list = (), post=None) -> bool:
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
    if post and ok:
        new, note = post(new)
        notes.append(note)
    return finish(path, rel, text, new, eol, notes, ok)


def patch_css() -> bool:
    rel = "static/css/app.css"
    path = ROOT / rel
    if not path.exists():
        print(f"✗ {rel}: Datei nicht gefunden")
        return False
    text, eol = read(path)
    if ".changelog-list" in text:
        print(f"= {rel}: schon angepasst")
        return True
    return finish(path, rel, text, text.rstrip("\n") + "\n\n" + CSS_NEW + "\n", eol, ["  ✓ Changelog-Stile (angehängt)"], True)


def main() -> None:
    missing = [f for f in NEED if not (ROOT / f).exists()]
    if missing:
        sys.exit("Fehlt noch (bitte zuerst kopieren):\n  " + "\n  ".join(missing))
    results = [patch("app/main.py", MAIN_EDITS), patch("static/js/app.js", APP_JS_EDITS, post=bump_version),
               patch("static/js/profile.js", PROFILE_EDITS, PROFILE_OPTIONAL), patch_css()]
    ok = all(results)
    print("\nFertig." if ok else "\nMit Fehlern beendet (siehe oben).")
    if ok:
        print("\nNoch nötig:\n  ./venv/bin/pip install pywebpush\n  systemctl restart vela   (danach im Browser Strg+F5)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()