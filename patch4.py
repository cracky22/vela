#!/usr/bin/env python3
"""Schlüsseltresor (Schnell-Anmeldung) und QR-Anmeldung einbinden.

    python patch_vela4.py      # im Projektordner (neben run.py); oder alles zusammen: patch_all.py

Vorher kopieren: app/vault.py, static/js/{vault,keystash,qrlink,devices}.js, static/js/vendor/{argon2.umd.min.js,jsQR.js}
Geändert: app/db.py, app/main.py, static/js/{state,auth,profile}.js, static/css/app.css (Backups .bak, mehrfach ausführbar).
"""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NEED = ["app/vault.py", "static/js/vault.js", "static/js/keystash.js", "static/js/qrlink.js", "static/js/devices.js",
        "static/js/vendor/argon2.umd.min.js", "static/js/vendor/jsQR.js"]
SPA = '@app.api_route("/{path:path}", methods=["GET", "HEAD"])\ndef spa(path: str):\n'
CLEAR = 'UPDATE users SET vault_kdf=NULL, vault_blob=NULL, vault_auth=NULL, vault_at=NULL WHERE id=?'

# (Beschreibung, Marker „schon vorhanden“, [mögliche Ankertexte], Ersatz)
DB_EDITS = [("Tresor-Spalten", '"vault_kdf"', ['    ("users", "last_seen", "INTEGER"),\n]'],
             '    ("users", "last_seen", "INTEGER"),\n    ("users", "vault_kdf", "TEXT"),\n    ("users", "vault_blob", "TEXT"),\n'
             '    ("users", "vault_auth", "TEXT"),\n    ("users", "vault_at", "INTEGER"),\n]')]

MAIN_EDITS = [
    ("Tresor + QR-Endpunkte einbinden", "vault.init(", [SPA],
     "# ---- Schlüsseltresor und QR-Anmeldung (/api/vault/*, /api/link/*) – vor der SPA-Catch-all-Route\n"
     "from . import vault  # noqa: E402\n\n"
     'vault.init(app, {"COOKIE": COOKIE, "lookup_session": lookup_session, "issue_session": issue_session,\n'
     '                 "rate": rate, "client_ip": client_ip})\n\n\n' + SPA),
    ("Wiederherstellung macht den Tresor ungültig", "Tresor ungültig (neues Passwort)",
     ['        c.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))  # alle Geräte abmelden\n'],
     '        c.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))  # alle Geräte abmelden\n'
     f'        c.execute("{CLEAR}", (u["id"],))  # Tresor ungültig (neues Passwort)\n'),
    ("Schlüsselrotation macht den Tresor ungültig", "Tresor ungültig (neue Schlüssel)",
     ['                   security.recovery_hash(body.recovery_auth), step, sess["user_id"]))\n'],
     '                   security.recovery_hash(body.recovery_auth), step, sess["user_id"]))\n'
     f'        c.execute("{CLEAR}", (sess["user_id"],))  # Tresor ungültig (neue Schlüssel)\n'),
]

STATE_EDITS = [
    ("Import keystash", "from './keystash.js'", ["import { importIdentity } from './crypto.js';\n"],
     "import { importIdentity } from './crypto.js';\nimport { stashIdentity } from './keystash.js';\n"),
    ("Geräte-Kopie der Schlüssel anlegen", "stashIdentity(userId", ["  await store.put('identity', userId, rec);\n"],
     "  await store.put('identity', userId, rec);\n  await stashIdentity(userId, identity, keyVersion).catch(() => {});   // für QR-Weitergabe/Tresor\n"),
]

AUTH_EDITS = [
    ("Imports", "from './vault.js'", ["import { version } from './app.js';\n"],
     "import { version } from './app.js';\nimport { vaultLogin, unlockFromVault, vaultUnlockSlot } from './vault.js';\nimport { renderQrLogin } from './qrlink.js';\n"),
    ("Anmeldung über den Tresor, falls vorhanden", "vaultLogin(login.username",
     ["        const res = await api('/auth/login', { method: 'POST', body: { username: u.input.value.trim(), password: p.input.value, code: c.input.value.replace(/\\s/g, '') } });\n"],
     "        const login = { username: u.input.value.trim(), password: p.input.value, code: c.input.value.replace(/\\s/g, '') };\n"
     "        const res = (await vaultLogin(login.username, login.password, login.code)) || await api('/auth/login', { method: 'POST', body: login });\n"),
    ("Knopf „Mit QR-Code anmelden“", "renderQrLogin({",
     ["      button('Neues Konto erstellen', { kind: 'tonal', onClick: () => renderRegister(), cls: 'wide' }),\n"],
     "      button('Mit QR-Code anmelden', { kind: 'tonal', icon: 'camera', cls: 'wide', onClick: () => renderQrLogin({ page, brand, onDone: onAuthenticated, back: () => renderLogin() }) }),\n"
     "      button('Neues Konto erstellen', { kind: 'tonal', onClick: () => renderRegister(), cls: 'wide' }),\n"),
    ("Tresor beim Entsperren automatisch öffnen", "unlockFromVault(S.me)", ["export function renderRestore({ onLogout }) {\n"],
     "export function renderRestore({ onLogout }) {\n  unlockFromVault(S.me).then((ok) => ok && onAuthenticated()).catch(() => {});   // nach Tresor-Anmeldung ohne Eingabe\n"),
    ("„Mit Passwort entsperren“ im Entsperren-Dialog", "vaultUnlockSlot(",
     ["      button('Schlüssel verloren? Neue Schlüssel erzeugen', { kind: 'text', onClick: () => startRotate({ fromRestore: true }) }),\n"],
     "      vaultUnlockSlot({ page, brand, onDone: onAuthenticated, onLogout }),\n"
     "      button('Schlüssel verloren? Neue Schlüssel erzeugen', { kind: 'text', onClick: () => startRotate({ fromRestore: true }) }),\n"),
]

PROFILE_EDITS = [
    ("Import devices.js", "from './devices.js'", ["import { startRotate } from './auth.js';\n"],
     "import { startRotate } from './auth.js';\nimport { renderDeviceSection } from './devices.js';\n"),
    ("Platzhalter", "devSlot = h(", ["  const tSlot = h('div', { class: 'transcription-slot' });\n"],
     "  const tSlot = h('div', { class: 'transcription-slot' });\n  const devSlot = h('div', { class: 'device-slot' });\n"),
    ("Abschnitt im Profil", "section('Anmeldung auf anderen Geräten'", ["      section('Darstellung', 'palette', themeSeg),\n"],
     "      section('Anmeldung auf anderen Geräten', 'key', devSlot),\n      section('Darstellung', 'palette', themeSeg),\n"),
    ("Abschnitt füllen", "renderDeviceSection(devSlot)", ["  renderTranscription(tSlot);\n}\n\nasync function saveServerSettings"],
     "  renderTranscription(tSlot);\n  renderDeviceSection(devSlot);\n}\n\nasync function saveServerSettings"),
]

CSS_NEW = """/* QR-Anmeldung und Schlüsseltresor (qrlink.js, devices.js) */
.qr-steps { margin: 4px 0 12px; padding-left: 20px; color: var(--on-surface-variant); font-size: 14px; display: flex; flex-direction: column; gap: 4px; }
.qr-box { display: grid; place-items: center; padding: 14px; background: #fff; border-radius: 20px; width: fit-content; margin: 8px auto; box-shadow: var(--elev-1); }
.qr-box img { width: min(260px, 70vw); height: auto; image-rendering: pixelated; display: block; }
.qr-timer { text-align: center; margin: 2px 0; font-size: 13px; color: var(--on-surface-variant); }
.qr-payload { word-break: break-all; display: block; margin-top: 6px; }
.qr-scan video { width: 100%; max-height: 52vh; border-radius: 16px; background: #000; object-fit: cover; display: block; }
.device-block { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; padding: 6px 0 14px; }
.device-block + .device-block { border-top: 1px solid var(--outline-variant); padding-top: 14px; }
.vault-slot:empty { display: none; }"""


def read(path):
    raw = path.read_bytes().decode("utf-8")
    return raw.replace("\r\n", "\n"), "\r\n" if "\r\n" in raw else "\n"


def finish(path, rel, old, new, eol, notes, ok):
    print(("✓ " if ok else "✗ ") + rel)
    print("\n".join(notes))
    if not ok:
        print("  -> nichts geschrieben")
        return False
    if new != old:
        shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
        path.write_bytes(new.replace("\n", eol).encode("utf-8"))
    return True


def patch(rel, edits):
    path = ROOT / rel
    if not path.exists():
        print(f"✗ {rel}: Datei nicht gefunden")
        return False
    text, eol = read(path)
    new, notes, ok = text, [], True
    for desc, marker, olds, repl in edits:
        if marker in new:
            notes.append(f"  = {desc} (schon vorhanden)")
            continue
        old = next((o for o in olds if new.count(o) == 1), None)
        if old is None:
            notes.append(f"  ✗ {desc}: Einstiegspunkt nicht gefunden")
            ok = False
            continue
        new = new.replace(old, repl, 1)
        notes.append(f"  ✓ {desc}")
    return finish(path, rel, text, new, eol, notes, ok)


def patch_css():
    rel = "static/css/app.css"
    path = ROOT / rel
    if not path.exists():
        print(f"✗ {rel}: Datei nicht gefunden")
        return False
    text, eol = read(path)
    if ".qr-box" in text:
        print(f"= {rel}: schon angepasst")
        return True
    return finish(path, rel, text, text.rstrip("\n") + "\n\n" + CSS_NEW + "\n", eol, ["  ✓ QR-/Tresor-Stile (angehängt)"], True)


def main():
    missing = [f for f in NEED if not (ROOT / f).exists()]
    if missing:
        sys.exit("Fehlt noch (bitte zuerst kopieren):\n  " + "\n  ".join(missing))
    results = [patch("app/db.py", DB_EDITS), patch("app/main.py", MAIN_EDITS), patch("static/js/state.js", STATE_EDITS),
               patch("static/js/auth.js", AUTH_EDITS), patch("static/js/profile.js", PROFILE_EDITS), patch_css()]
    ok = all(results)
    print("\nFertig." if ok else "\nMit Fehlern beendet (siehe oben).")
    if ok:
        print("\nNoch nötig:  systemctl restart vela   (danach im Browser Strg+F5)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()