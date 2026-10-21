"""Vela – FastAPI-Server.

Der Server sieht niemals Klartext-Nachrichten oder private Schlüssel. Ver- und
Entschlüsselung passieren ausschließlich im Client (Web Crypto API). Der Server ist
ein "Zusteller" für Ciphertext und verwaltet Konten, Kontakte und Sitzungen.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import hmac
import json
import logging
import re
import sqlite3
import time
import uuid
from contextlib import asynccontextmanager
from typing import Annotated, Any
from urllib.parse import urlparse

import anyio
import anyio.to_thread
import segno
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.serialization import load_der_public_key
from fastapi import Depends, FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
from starlette.datastructures import MutableHeaders

from . import config, db, security
from .security import limiter
from .ws import manager

log = logging.getLogger("vela")

COOKIE = "__Host-vela" if config.TLS_ENABLED else "vela_sid"
DAY_MS = 86_400_000
HEX32 = re.compile(r"^[a-f0-9]{32}$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.]{3,32}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,63}$")
DEFAULT_SETTINGS = {"read_receipts": True, "typing_indicator": True, "live_typing": False}


# =============================================================== Lebenszyklus
def cleanup() -> dict[str, int]:
    """Löscht abgelaufene Daten (Datenminimierung / Speicherbegrenzung nach Art. 5 DSGVO)."""
    now = db.now_ms()
    stats = {}
    with db.tx() as c:
        doomed = [r["id"] for r in c.execute(
            "SELECT id FROM files WHERE expires_at < ? OR (message_id IS NULL AND created_at < ?)",
            (now, now - DAY_MS))]
        doomed += [r["id"] for r in c.execute(
            "SELECT f.id FROM files f JOIN messages m ON m.id=f.message_id WHERE m.expires_at < ?", (now,))]
        c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in doomed])
        stats["messages"] = c.execute("DELETE FROM messages WHERE expires_at < ?", (now,)).rowcount
        stats["sessions"] = c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,)).rowcount
        pending = [r["id"] for r in c.execute(
            "SELECT id FROM users WHERE activated=0 AND created_at < ?",
            (now - config.PENDING_ACCOUNT_HOURS * 3_600_000,))]
        for uid in pending:
            doomed += [r["id"] for r in c.execute("SELECT id FROM files WHERE owner_id=?", (uid,))]
            c.execute("DELETE FROM users WHERE id=?", (uid,))
        stats["pending_accounts"] = len(pending)
    for fid in doomed:
        _unlink(fid)
    stats["files"] = len(doomed)
    return stats


async def _cleanup_loop() -> None:
    while True:
        try:
            await anyio.to_thread.run_sync(cleanup)
        except Exception:  # pragma: no cover
            log.exception("Cleanup fehlgeschlagen")
        await asyncio.sleep(300)


@asynccontextmanager
async def lifespan(_: FastAPI):
    db.init()
    # Thread-Pool für blockierende Arbeit (sync-Endpunkte, DB, Hashing, Datei-I/O)
    anyio.to_thread.current_default_thread_limiter().total_tokens = config.WORKER_THREADS
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="Vela", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# =============================================================== Sicherheits-Middleware
class SecurityMiddleware:
    """Reines ASGI-Middleware (kompatibel mit Streaming-Uploads und WebSockets):

    * CSRF-Schutz: zustandsändernde API-Aufrufe brauchen den Header `X-Requested-With: vela`
      (lässt sich cross-origin nicht ohne CORS-Freigabe setzen) und eine passende Origin.
    * Sicherheits-Header (CSP, HSTS, nosniff, Referrer-Policy, ...).
    """

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        path, method, host = scope["path"], scope["method"], headers.get("host", "")

        if path.startswith("/api/") and method not in ("GET", "HEAD", "OPTIONS"):
            origin = headers.get("origin")
            if headers.get("x-requested-with") != "vela" or (origin and urlparse(origin).netloc != host):
                return await JSONResponse({"detail": "Anfrage abgelehnt (CSRF-Schutz)"}, 403)(scope, receive, send)
            cl = headers.get("content-length")
            if path != "/api/files" and cl and cl.isdigit() and int(cl) > config.MAX_JSON_BYTES:
                return await JSONResponse({"detail": "Anfrage zu groß"}, 413)(scope, receive, send)

        csp = (
            "default-src 'self'; "
            "script-src 'self' https://cdn.jsdelivr.net 'wasm-unsafe-eval'; "
            "worker-src 'self' blob:; "
            f"connect-src 'self' wss://{host} ws://{host} https://cdn.jsdelivr.net "
            "https://huggingface.co https://*.huggingface.co https://*.hf.co; "
            "img-src 'self' blob: data:; media-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )

        async def send_wrapper(message):
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                h["Content-Security-Policy"] = csp
                h["X-Content-Type-Options"] = "nosniff"
                h["Referrer-Policy"] = "no-referrer"
                h["X-Frame-Options"] = "DENY"
                h["Cross-Origin-Opener-Policy"] = "same-origin"
                h["Cross-Origin-Resource-Policy"] = "same-origin"
                h["Permissions-Policy"] = "camera=(), geolocation=(), payment=(), usb=(), microphone=(self)"
                if config.TLS_ENABLED:
                    h["Strict-Transport-Security"] = "max-age=31536000"
                if path.startswith("/api/"):
                    h["Cache-Control"] = "no-store"
                elif "cache-control" not in h:
                    h["Cache-Control"] = "no-cache"
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityMiddleware)


# =============================================================== Hilfsfunktionen
def _unlink(file_id: str) -> None:
    if HEX32.match(file_id):
        (config.UPLOAD_DIR / file_id).unlink(missing_ok=True)


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "?"


def rate(key: str, limit: int, window: float) -> None:
    if not limiter.allow(key, limit, window):
        raise HTTPException(429, "Zu viele Versuche. Bitte kurz warten.")


def b64decode(value: str, what: str) -> bytes:
    try:
        return base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, f"{what}: ungültiges Base64")


def validate_public_keys(enc_pub: str, sig_pub: str, bits: int) -> None:
    """Prüft, dass wirklich ein RSA-Schlüssel der angegebenen Länge (e=65537) und ein
    ECDSA-P-256-Schlüssel hochgeladen wurden."""
    if bits not in config.ALLOWED_KEY_BITS:
        raise HTTPException(400, "Nicht unterstützte Schlüssellänge")
    try:
        enc = load_der_public_key(b64decode(enc_pub, "enc_pub"))
        sig = load_der_public_key(b64decode(sig_pub, "sig_pub"))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(400, "Öffentlicher Schlüssel ungültig")
    if not isinstance(enc, rsa.RSAPublicKey) or enc.key_size != bits or enc.public_numbers().e != 65537:
        raise HTTPException(400, "RSA-Schlüssel entspricht nicht der gewählten Länge")
    if not isinstance(sig, ec.EllipticCurvePublicKey) or sig.curve.name != "secp256r1":
        raise HTTPException(400, "Signaturschlüssel muss ECDSA P-256 sein")


def validate_backup(backup: str) -> None:
    try:
        obj = json.loads(backup)
        assert isinstance(obj, dict) and isinstance(obj.get("iv"), str) and isinstance(obj.get("ct"), str)
        b64decode(obj["iv"], "backup.iv")
        b64decode(obj["ct"], "backup.ct")
    except (ValueError, AssertionError):
        raise HTTPException(400, "Schlüssel-Backup ungültig")


def totp_payload(secret: str, username: str) -> dict[str, str]:
    uri = security.otpauth_uri(secret, username)
    qr = segno.make(uri, error="m").svg_data_uri(scale=6, border=2, dark="#000000", light="#ffffff")
    return {"secret": secret, "uri": uri, "qr": qr}


def issue_session(response: Response, user_id: str, full: bool) -> None:
    token = security.new_token()
    now = db.now_ms()
    with db.tx() as c:
        c.execute("INSERT INTO sessions (token_hash, user_id, full, created_at, expires_at) VALUES (?,?,?,?,?)",
                  (security.token_hash(token), user_id, int(full), now, now + config.SESSION_DAYS * DAY_MS))
    response.set_cookie(COOKIE, token, max_age=config.SESSION_DAYS * 86400, httponly=True,
                        secure=config.TLS_ENABLED, samesite="strict", path="/")


def lookup_session(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    th = security.token_hash(token)
    row = db.one("SELECT s.user_id, s.full, s.expires_at, u.username FROM sessions s "
                 "JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?", th)
    if not row or row["expires_at"] < db.now_ms():
        return None
    return {"user_id": row["user_id"], "full": bool(row["full"]), "username": row["username"], "token_hash": th}


def get_session(request: Request) -> dict[str, Any]:
    sess = lookup_session(request.cookies.get(COOKIE))
    if not sess:
        raise HTTPException(401, "Nicht angemeldet")
    return sess


def full_session(sess: Annotated[dict, Depends(get_session)]) -> dict[str, Any]:
    if not sess["full"]:
        raise HTTPException(403, "Bitte zuerst die Zwei-Faktor-Authentifizierung einrichten")
    return sess


Session = Annotated[dict, Depends(get_session)]
Full = Annotated[dict, Depends(full_session)]


def user_settings(user_id: str) -> dict[str, bool]:
    row = db.one("SELECT settings FROM users WHERE id=?", user_id)
    s = dict(DEFAULT_SETTINGS)
    if row:
        s.update(json.loads(row["settings"] or "{}"))
    return s


def contact_status(me: str, other: str) -> str | None:
    row = db.one("SELECT status FROM contacts WHERE user_id=? AND contact_id=?", me, other)
    return row["status"] if row else None


def require_accepted(me: str, other: str) -> None:
    if contact_status(me, other) != "accepted":
        raise HTTPException(403, "Erst nach angenommener Kontaktanfrage (Schlüsselaustausch) möglich")


def msg_out(row: sqlite3.Row, me: str) -> dict[str, Any]:
    envelope = row["envelope"]
    # Einmalansicht: der Absender bekommt nie einen Ciphertext (er hat ohnehin keinen Schlüssel dafür)
    if row["view_once"] and row["sender_id"] == me:
        envelope = None
    return {
        "id": row["id"], "from": row["sender_id"], "to": row["recipient_id"],
        "envelope": envelope, "view_once": bool(row["view_once"]), "silent": bool(row["silent"]),
        "ts": row["created_at"], "read_at": row["read_at"], "viewed_at": row["viewed_at"],
        "deleted_at": row["deleted_at"],
    }


def delete_message_files(c: sqlite3.Connection, message_id: str) -> list[str]:
    ids = [r["id"] for r in c.execute("SELECT id FROM files WHERE message_id=?", (message_id,))]
    c.execute("DELETE FROM files WHERE message_id=?", (message_id,))
    return ids


# =============================================================== Modelle
class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    email: str = Field(max_length=254)
    password: str = Field(min_length=10, max_length=256)
    enc_pub: str = Field(max_length=4096)
    sig_pub: str = Field(max_length=512)
    key_bits: int
    key_backup: str = Field(max_length=65536)
    recovery_auth: str = Field(pattern=r"^[a-f0-9]{64}$")

    @field_validator("username")
    @classmethod
    def _u(cls, v: str) -> str:
        if not USERNAME_RE.match(v):
            raise ValueError("Nutzername: 3–32 Zeichen, nur Buchstaben, Ziffern, _ und .")
        return v

    @field_validator("email")
    @classmethod
    def _e(cls, v: str) -> str:
        v = v.strip()
        if not EMAIL_RE.match(v):
            raise ValueError("Ungültige E-Mail-Adresse")
        return v


class CodeIn(BaseModel):
    code: str = Field(min_length=6, max_length=8)


class LoginIn(BaseModel):
    username: str = Field(max_length=32)
    password: str = Field(max_length=256)
    code: str = Field(default="", max_length=8)


class RecoverIn(BaseModel):
    username: str = Field(max_length=32)
    recovery_auth: str = Field(pattern=r"^[a-f0-9]{64}$")
    new_password: str = Field(min_length=10, max_length=256)


class RotateIn(BaseModel):
    enc_pub: str = Field(max_length=4096)
    sig_pub: str = Field(max_length=512)
    key_bits: int
    key_backup: str = Field(max_length=65536)
    recovery_auth: str = Field(pattern=r"^[a-f0-9]{64}$")
    code: str = Field(min_length=6, max_length=8)


class SettingsIn(BaseModel):
    read_receipts: bool = True
    typing_indicator: bool = True
    live_typing: bool = False


class DeleteAccountIn(BaseModel):
    password: str = Field(max_length=256)
    code: str = Field(min_length=6, max_length=8)


class ContactIn(BaseModel):
    username: str = Field(max_length=32)


class ContactPatch(BaseModel):
    archived: bool | None = None
    pinned: bool | None = None
    muted: bool | None = None


class SendIn(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    to: str = Field(pattern=r"^[a-f0-9]{32}$")
    envelope: str = Field(max_length=262_144)
    view_once: bool = False
    silent: bool = False
    files: list[str] = Field(default_factory=list, max_length=10)


class ReadIn(BaseModel):
    contact_id: str = Field(pattern=r"^[a-f0-9]{32}$")
    up_to: int


# =============================================================== Auth
@app.get("/api/health")
def health():
    return {"ok": True}


@app.get("/api/auth/status")
def auth_status(request: Request):
    """Sitzungsstatus ohne 401 (vermeidet Fehlermeldungen in der Browser-Konsole beim Start)."""
    sess = lookup_session(request.cookies.get(COOKIE))
    return {"authenticated": bool(sess), "full": bool(sess and sess["full"])}


@app.get("/api/config")
def public_config():
    return {"max_upload_bytes": config.MAX_UPLOAD_BYTES, "retention_days": config.RETENTION_DAYS,
            "key_bits": list(config.ALLOWED_KEY_BITS)}


@app.post("/api/auth/register")
def register(body: RegisterIn, request: Request, response: Response):
    rate(f"reg:{client_ip(request)}", 10, 3600)
    validate_public_keys(body.enc_pub, body.sig_pub, body.key_bits)
    validate_backup(body.key_backup)
    uid = uuid.uuid4().hex
    secret = security.new_totp_secret()
    pw_hash = security.hash_password(body.password)
    try:
        with db.tx() as c:
            c.execute(
                "INSERT INTO users (id, username, email, pw_hash, totp_secret, enc_pub, sig_pub, key_bits, "
                "key_backup, recovery_hash, settings, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (uid, body.username, body.email, pw_hash, secret, body.enc_pub, body.sig_pub, body.key_bits,
                 body.key_backup, security.recovery_hash(body.recovery_auth), json.dumps(DEFAULT_SETTINGS),
                 db.now_ms()))
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Nutzername oder E-Mail-Adresse ist bereits vergeben")
    issue_session(response, uid, full=False)
    return {"user_id": uid, "totp": totp_payload(secret, body.username)}


@app.post("/api/auth/2fa/confirm")
def confirm_2fa(body: CodeIn, sess: Session):
    rate(f"2fa:{sess['user_id']}", 10, 300)
    u = db.one("SELECT totp_secret, totp_last_step FROM users WHERE id=?", sess["user_id"])
    step = security.verify_totp(u["totp_secret"], body.code, u["totp_last_step"])
    if step is None:
        raise HTTPException(400, "Code ungültig. Bitte Uhrzeit des Geräts prüfen und erneut versuchen.")
    with db.tx() as c:
        c.execute("UPDATE users SET totp_enabled=1, activated=1, totp_last_step=? WHERE id=?", (step, sess["user_id"]))
        c.execute("UPDATE sessions SET full=1 WHERE token_hash=?", (sess["token_hash"],))
    return {"ok": True}


@app.post("/api/auth/login")
def login(body: LoginIn, request: Request, response: Response):
    rate(f"login-ip:{client_ip(request)}", 30, 600)
    rate(f"login-user:{body.username.lower()}", 10, 600)
    u = db.one("SELECT * FROM users WHERE username=?", body.username)
    ok = security.verify_password(body.password, u["pw_hash"] if u else security.DUMMY_HASH)
    if not u or not ok:
        raise HTTPException(401, "Anmeldedaten ungültig")
    if not u["totp_enabled"]:
        # Registrierung bzw. Wiederherstellung nicht abgeschlossen -> 2FA neu einrichten
        secret = security.new_totp_secret()
        with db.tx() as c:
            c.execute("UPDATE users SET totp_secret=?, totp_last_step=0 WHERE id=?", (secret, u["id"]))
        issue_session(response, u["id"], full=False)
        return {"setup_2fa": totp_payload(secret, u["username"])}
    step = security.verify_totp(u["totp_secret"], body.code, u["totp_last_step"])
    if step is None:
        raise HTTPException(401, "Anmeldedaten ungültig")
    with db.tx() as c:
        c.execute("UPDATE users SET totp_last_step=? WHERE id=?", (step, u["id"]))
    issue_session(response, u["id"], full=True)
    return {"ok": True}


@app.post("/api/auth/logout")
def logout(sess: Session, response: Response):
    with db.tx() as c:
        c.execute("DELETE FROM sessions WHERE token_hash=?", (sess["token_hash"],))
    response.delete_cookie(COOKIE, path="/", secure=config.TLS_ENABLED, httponly=True, samesite="strict")
    return {"ok": True}


@app.post("/api/auth/recover")
def recover(body: RecoverIn, request: Request, response: Response):
    """Konto-Wiederherstellung mit dem Wiederherstellungsschlüssel: neues Passwort, neue 2FA,
    verschlüsseltes Schlüssel-Backup zurück an den Client (nur dieser kann es entschlüsseln)."""
    rate(f"recover-ip:{client_ip(request)}", 10, 3600)
    rate(f"recover-user:{body.username.lower()}", 5, 3600)
    u = db.one("SELECT * FROM users WHERE username=?", body.username)
    expected = u["recovery_hash"] if u else security.recovery_hash("0" * 64)
    if not hmac.compare_digest(security.recovery_hash(body.recovery_auth), expected) or not u:
        raise HTTPException(401, "Nutzername oder Wiederherstellungsschlüssel ungültig")
    secret = security.new_totp_secret()
    pw_hash = security.hash_password(body.new_password)
    with db.tx() as c:
        c.execute("UPDATE users SET pw_hash=?, totp_secret=?, totp_enabled=0, totp_last_step=0 WHERE id=?",
                  (pw_hash, secret, u["id"]))
        c.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))  # alle Geräte abmelden
    manager.close_user_from_thread(u["id"])
    issue_session(response, u["id"], full=False)
    return {"user_id": u["id"], "totp": totp_payload(secret, u["username"]),
            "key_backup": u["key_backup"], "key_version": u["key_version"]}


# =============================================================== Konto & Schlüssel
@app.get("/api/me")
def me(sess: Session):
    u = db.one("SELECT * FROM users WHERE id=?", sess["user_id"])
    return {
        "id": u["id"], "username": u["username"], "email": u["email"], "full": sess["full"],
        "totp_enabled": bool(u["totp_enabled"]), "key_bits": u["key_bits"], "key_version": u["key_version"],
        "enc_pub": u["enc_pub"], "sig_pub": u["sig_pub"], "settings": user_settings(u["id"]),
        "created_at": u["created_at"],
    }


@app.get("/api/keys/backup")
def key_backup(sess: Full):
    u = db.one("SELECT key_backup, key_version FROM users WHERE id=?", sess["user_id"])
    return {"key_backup": u["key_backup"], "key_version": u["key_version"]}


@app.post("/api/keys/rotate")
def rotate_keys(body: RotateIn, sess: Full):
    """Neue Schlüssel erzeugen (z. B. wenn der Wiederherstellungsschlüssel verloren ging).
    Erfordert erneut einen 2FA-Code. Kontakte erhalten eine Schlüsseländerungs-Warnung."""
    rate(f"rotate:{sess['user_id']}", 5, 3600)
    validate_public_keys(body.enc_pub, body.sig_pub, body.key_bits)
    validate_backup(body.key_backup)
    u = db.one("SELECT totp_secret, totp_last_step, key_version FROM users WHERE id=?", sess["user_id"])
    step = security.verify_totp(u["totp_secret"], body.code, u["totp_last_step"])
    if step is None:
        raise HTTPException(400, "2FA-Code ungültig")
    with db.tx() as c:
        c.execute("UPDATE users SET enc_pub=?, sig_pub=?, key_bits=?, key_backup=?, recovery_hash=?, "
                  "key_version=key_version+1, totp_last_step=? WHERE id=?",
                  (body.enc_pub, body.sig_pub, body.key_bits, body.key_backup,
                   security.recovery_hash(body.recovery_auth), step, sess["user_id"]))
    for r in db.all_("SELECT contact_id FROM contacts WHERE user_id=?", sess["user_id"]):
        manager.notify(r["contact_id"], {"type": "contact_update"})
    return {"key_version": u["key_version"] + 1}


@app.put("/api/me/settings")
def update_settings(body: SettingsIn, sess: Full):
    with db.tx() as c:
        c.execute("UPDATE users SET settings=? WHERE id=?", (json.dumps(body.model_dump()), sess["user_id"]))
    return body.model_dump()


@app.get("/api/me/export")
def export_data(sess: Full):
    """Datenauskunft / Datenübertragbarkeit (Art. 15 & 20 DSGVO): alles, was der Server
    über das Konto speichert. Nachrichteninhalte liegen nur verschlüsselt vor."""
    uid = sess["user_id"]
    u = db.one("SELECT id, username, email, key_bits, key_version, enc_pub, sig_pub, settings, created_at, "
               "totp_enabled FROM users WHERE id=?", uid)
    data = {
        "exported_at": db.now_ms(),
        "account": {**dict(u), "settings": json.loads(u["settings"])},
        "contacts": [dict(r) for r in db.all_(
            "SELECT u.username, c.status, c.archived, c.pinned, c.muted, c.created_at FROM contacts c "
            "JOIN users u ON u.id=c.contact_id WHERE c.user_id=?", uid)],
        "sessions": [dict(r) for r in db.all_("SELECT created_at, expires_at, full FROM sessions WHERE user_id=?", uid)],
        "messages_metadata": [dict(r) for r in db.all_(
            "SELECT id, sender_id, recipient_id, created_at, expires_at, read_at, view_once, viewed_at, deleted_at "
            "FROM messages WHERE sender_id=? OR recipient_id=? ORDER BY created_at", uid, uid)],
        "files_metadata": [dict(r) for r in db.all_(
            "SELECT id, size, created_at, expires_at FROM files WHERE owner_id=?", uid)],
        "note": "Nachrichteninhalte und Dateien sind Ende-zu-Ende verschlüsselt und für den Server unlesbar.",
    }
    return JSONResponse(data, headers={"Content-Disposition": 'attachment; filename="vela-datenexport.json"'})


@app.post("/api/me/delete")
def delete_account(body: DeleteAccountIn, sess: Full, response: Response):
    """Recht auf Löschung (Art. 17 DSGVO): Konto, Nachrichten, Dateien, Sitzungen werden entfernt."""
    rate(f"del:{sess['user_id']}", 5, 3600)
    uid = sess["user_id"]
    u = db.one("SELECT pw_hash, totp_secret, totp_last_step FROM users WHERE id=?", uid)
    if not security.verify_password(body.password, u["pw_hash"]) or \
            security.verify_totp(u["totp_secret"], body.code, u["totp_last_step"]) is None:
        raise HTTPException(401, "Passwort oder 2FA-Code ungültig")
    contacts = [r["contact_id"] for r in db.all_("SELECT contact_id FROM contacts WHERE user_id=?", uid)]
    with db.tx() as c:
        files = [r["id"] for r in c.execute(
            "SELECT f.id FROM files f LEFT JOIN messages m ON m.id=f.message_id "
            "WHERE f.owner_id=? OR m.recipient_id=?", (uid, uid))]
        c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in files])
        c.execute("DELETE FROM users WHERE id=?", (uid,))
    for fid in files:
        _unlink(fid)
    for cid in contacts:
        manager.notify(cid, {"type": "contact_update"})
    manager.close_user_from_thread(uid)
    response.delete_cookie(COOKIE, path="/", secure=config.TLS_ENABLED, httponly=True, samesite="strict")
    return {"ok": True}


# =============================================================== Kontakte & Schlüsselaustausch
@app.get("/api/contacts")
def list_contacts(sess: Full):
    me_ = sess["user_id"]
    unread = {r["sender_id"]: r["n"] for r in db.all_(
        "SELECT sender_id, COUNT(*) n FROM messages WHERE recipient_id=? AND read_at IS NULL "
        "AND silent=0 AND deleted_at IS NULL GROUP BY sender_id", me_)}
    out = []
    for r in db.all_("SELECT c.*, u.username, u.enc_pub, u.sig_pub, u.key_bits, u.key_version "
                     "FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.user_id=?", me_):
        item = {"id": r["contact_id"], "username": r["username"], "status": r["status"],
                "archived": bool(r["archived"]), "pinned": bool(r["pinned"]), "muted": bool(r["muted"]),
                "since": r["created_at"], "unread": unread.get(r["contact_id"], 0), "last": None}
        if r["status"] == "accepted":
            # Öffentliche Schlüssel werden erst nach beidseitiger Zustimmung herausgegeben
            item.update(enc_pub=r["enc_pub"], sig_pub=r["sig_pub"], key_bits=r["key_bits"],
                        key_version=r["key_version"])
            last = db.one("SELECT * FROM messages WHERE ((sender_id=? AND recipient_id=?) OR "
                          "(sender_id=? AND recipient_id=?)) AND silent=0 ORDER BY created_at DESC LIMIT 1",
                          me_, r["contact_id"], r["contact_id"], me_)
            if last:
                item["last"] = msg_out(last, me_)
        out.append(item)
    return out


@app.post("/api/contacts")
def add_contact(body: ContactIn, sess: Full):
    me_ = sess["user_id"]
    rate(f"contact:{me_}", 30, 3600)
    other = db.one("SELECT id FROM users WHERE username=? AND activated=1", body.username.strip())
    if not other:
        raise HTTPException(404, "Kein Nutzer mit diesem Namen gefunden")
    oid = other["id"]
    if oid == me_:
        raise HTTPException(400, "Du kannst dich nicht selbst hinzufügen")
    status = contact_status(me_, oid)
    now = db.now_ms()
    with db.tx() as c:
        if status == "pending_in":  # Gegenseitige Anfrage = Annahme
            c.execute("UPDATE contacts SET status='accepted' WHERE (user_id=? AND contact_id=?) OR "
                      "(user_id=? AND contact_id=?)", (me_, oid, oid, me_))
        elif status:
            raise HTTPException(409, "Kontakt oder Anfrage existiert bereits")
        else:
            c.execute("INSERT INTO contacts (user_id, contact_id, status, created_at) VALUES (?,?,?,?)",
                      (me_, oid, "pending_out", now))
            c.execute("INSERT INTO contacts (user_id, contact_id, status, created_at) VALUES (?,?,?,?)",
                      (oid, me_, "pending_in", now))
    manager.notify(oid, {"type": "contact_update"})
    return {"ok": True, "id": oid}


@app.post("/api/contacts/{cid}/accept")
def accept_contact(cid: str, sess: Full):
    me_ = sess["user_id"]
    if contact_status(me_, cid) != "pending_in":
        raise HTTPException(404, "Keine offene Anfrage")
    with db.tx() as c:
        c.execute("UPDATE contacts SET status='accepted' WHERE (user_id=? AND contact_id=?) OR "
                  "(user_id=? AND contact_id=?)", (me_, cid, cid, me_))
    manager.notify(cid, {"type": "contact_update"})
    return {"ok": True}


@app.patch("/api/contacts/{cid}")
def patch_contact(cid: str, body: ContactPatch, sess: Full):
    me_ = sess["user_id"]
    if not contact_status(me_, cid):
        raise HTTPException(404, "Kontakt nicht gefunden")
    fields = {k: int(v) for k, v in body.model_dump().items() if v is not None}
    if fields:
        sets = ", ".join(f"{k}=?" for k in fields)  # Schlüssel stammen aus dem Pydantic-Modell
        with db.tx() as c:
            c.execute(f"UPDATE contacts SET {sets} WHERE user_id=? AND contact_id=?", (*fields.values(), me_, cid))
    return {"ok": True}


@app.delete("/api/contacts/{cid}")
def delete_contact(cid: str, sess: Full):
    """Anfrage ablehnen/zurückziehen oder Kontakt entfernen. Entfernt auch den gemeinsamen
    Chat-Ciphertext und die Dateien auf dem Server (Datenminimierung)."""
    me_ = sess["user_id"]
    if not contact_status(me_, cid):
        raise HTTPException(404, "Kontakt nicht gefunden")
    with db.tx() as c:
        files = [r["id"] for r in c.execute(
            "SELECT f.id FROM files f JOIN messages m ON m.id=f.message_id WHERE "
            "(m.sender_id=? AND m.recipient_id=?) OR (m.sender_id=? AND m.recipient_id=?)", (me_, cid, cid, me_))]
        c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in files])
        c.execute("DELETE FROM messages WHERE (sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)",
                  (me_, cid, cid, me_))
        c.execute("DELETE FROM contacts WHERE (user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?)",
                  (me_, cid, cid, me_))
    for fid in files:
        _unlink(fid)
    manager.notify(cid, {"type": "contact_update"})
    return {"ok": True}


# =============================================================== Nachrichten
@app.get("/api/messages/{cid}")
def get_messages(cid: str, sess: Full, before: int | None = None, limit: int = Query(60, ge=1, le=200)):
    me_ = sess["user_id"]
    if not contact_status(me_, cid):
        raise HTTPException(404, "Kontakt nicht gefunden")
    rows = db.all_("SELECT * FROM messages WHERE ((sender_id=? AND recipient_id=?) OR (sender_id=? AND recipient_id=?)) "
                   "AND created_at < ? ORDER BY created_at DESC LIMIT ?",
                   me_, cid, cid, me_, before or 2**62, limit)
    return {"messages": [msg_out(r, me_) for r in reversed(rows)], "has_more": len(rows) == limit}


@app.post("/api/messages")
def send_message(body: SendIn, sess: Full):
    me_ = sess["user_id"]
    rate(f"send:{me_}", 120, 60)
    require_accepted(me_, body.to)
    try:
        env = json.loads(body.envelope)
        assert isinstance(env, dict) and isinstance(env.get("k"), dict)
        assert isinstance(env.get("iv"), str) and isinstance(env.get("ct"), str) and isinstance(env.get("sig"), str)
        allowed = {body.to} if body.view_once else {body.to, me_}
        assert body.to in env["k"] and set(env["k"]) <= allowed
    except (ValueError, AssertionError):
        raise HTTPException(400, "Ungültiger Nachrichten-Umschlag")
    now = db.now_ms()
    try:
        with db.tx() as c:
            c.execute("INSERT INTO messages (id, sender_id, recipient_id, envelope, view_once, silent, created_at, "
                      "expires_at) VALUES (?,?,?,?,?,?,?,?)",
                      (body.id, me_, body.to, body.envelope, int(body.view_once), int(body.silent), now,
                       now + config.RETENTION_DAYS * DAY_MS))
            for fid in body.files:
                n = c.execute("UPDATE files SET message_id=? WHERE id=? AND owner_id=? AND message_id IS NULL",
                              (body.id, fid, me_)).rowcount
                if n != 1:
                    raise HTTPException(400, "Datei nicht gefunden oder bereits verwendet")
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Nachrichten-ID bereits vergeben")
    row = db.one("SELECT * FROM messages WHERE id=?", body.id)
    manager.notify(body.to, {"type": "message", "message": msg_out(row, body.to)})
    manager.notify(me_, {"type": "message", "message": msg_out(row, me_)})  # andere eigene Geräte
    return msg_out(row, me_)


@app.post("/api/messages/read")
def mark_read(body: ReadIn, sess: Full):
    me_ = sess["user_id"]
    with db.tx() as c:
        n = c.execute("UPDATE messages SET read_at=? WHERE recipient_id=? AND sender_id=? AND read_at IS NULL "
                      "AND created_at <= ?", (db.now_ms(), me_, body.contact_id, body.up_to)).rowcount
    if n and user_settings(me_)["read_receipts"]:
        manager.notify(body.contact_id, {"type": "read", "by": me_, "up_to": body.up_to})
    return {"updated": n}


@app.post("/api/messages/{mid}/viewed")
def mark_viewed(mid: str, sess: Full):
    """Einmalansicht wurde geöffnet: Ciphertext und Dateien werden sofort vom Server gelöscht."""
    me_ = sess["user_id"]
    with db.tx() as c:
        row = c.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if not row or row["recipient_id"] != me_ or not row["view_once"]:
            raise HTTPException(404, "Nachricht nicht gefunden")
        if row["viewed_at"]:
            return {"ok": True}
        now = db.now_ms()
        c.execute("UPDATE messages SET envelope=NULL, viewed_at=?, read_at=COALESCE(read_at, ?) WHERE id=?",
                  (now, now, mid))
        files = delete_message_files(c, mid)
    for fid in files:
        _unlink(fid)
    for uid in (row["sender_id"], me_):
        manager.notify(uid, {"type": "viewed", "id": mid, "at": now})
    return {"ok": True}


@app.delete("/api/messages/{mid}")
def delete_message(mid: str, sess: Full):
    """Für alle löschen (nur Absender)."""
    me_ = sess["user_id"]
    with db.tx() as c:
        row = c.execute("SELECT * FROM messages WHERE id=?", (mid,)).fetchone()
        if not row or row["sender_id"] != me_:
            raise HTTPException(404, "Nachricht nicht gefunden")
        now = db.now_ms()
        c.execute("UPDATE messages SET envelope=NULL, deleted_at=? WHERE id=?", (now, mid))
        files = delete_message_files(c, mid)
    for fid in files:
        _unlink(fid)
    for uid in (row["recipient_id"], me_):
        manager.notify(uid, {"type": "deleted", "id": mid, "at": now})
    return {"ok": True}


# =============================================================== Dateien (nur Ciphertext)
def _register_file(file_id: str, owner: str, size: int) -> None:
    now = db.now_ms()
    with db.tx() as c:
        c.execute("INSERT INTO files (id, owner_id, size, created_at, expires_at) VALUES (?,?,?,?,?)",
                  (file_id, owner, size, now, now + config.RETENTION_DAYS * DAY_MS))


@app.post("/api/files")
async def upload_file(request: Request, sess: Full):
    """Nimmt bereits clientseitig verschlüsselte Bytes entgegen (Streaming, Größenlimit)."""
    rate(f"upload:{sess['user_id']}", 300, 3600)
    cl = request.headers.get("content-length")
    if cl and cl.isdigit() and int(cl) > config.MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Datei zu groß (max. {config.MAX_UPLOAD_MB} MB)")
    file_id = uuid.uuid4().hex
    tmp = config.UPLOAD_DIR / f"{file_id}.part"
    size = 0
    try:
        async with await anyio.open_file(tmp, "wb") as f:
            async for chunk in request.stream():
                size += len(chunk)
                if size > config.MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"Datei zu groß (max. {config.MAX_UPLOAD_MB} MB)")
                await f.write(chunk)
        if size == 0:
            raise HTTPException(400, "Leere Datei")
        await anyio.Path(tmp).rename(config.UPLOAD_DIR / file_id)
        await anyio.to_thread.run_sync(_register_file, file_id, sess["user_id"], size)
    except BaseException:
        await anyio.Path(tmp).unlink(missing_ok=True)
        raise
    return {"id": file_id, "size": size}


@app.get("/api/files/{fid}")
def download_file(fid: str, sess: Full):
    if not HEX32.match(fid):
        raise HTTPException(404, "Datei nicht gefunden")
    row = db.one("SELECT f.owner_id, m.recipient_id, m.deleted_at, m.viewed_at FROM files f "
                 "LEFT JOIN messages m ON m.id=f.message_id WHERE f.id=?", fid)
    me_ = sess["user_id"]
    if not row or me_ not in (row["owner_id"], row["recipient_id"]) or row["deleted_at"] or row["viewed_at"]:
        raise HTTPException(404, "Datei nicht gefunden")
    path = config.UPLOAD_DIR / fid
    if not path.exists():
        raise HTTPException(404, "Datei nicht gefunden")
    return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


# =============================================================== WebSocket
_typing_cache: dict[tuple[str, str], tuple[bool, bool, bool, float]] = {}


def _typing_permission(me_: str, other: str) -> tuple[bool, bool, bool]:
    """(ist Kontakt, Tipp-Indikator erlaubt, Live-Typing erlaubt) – 10 s gecacht."""
    key = (me_, other)
    hit = _typing_cache.get(key)
    if hit and hit[3] > time.monotonic():
        return hit[:3]
    s = user_settings(me_)
    res = (contact_status(me_, other) == "accepted", s["typing_indicator"], s["live_typing"])
    if len(_typing_cache) > 100_000:
        _typing_cache.clear()
    _typing_cache[key] = (*res, time.monotonic() + 10)
    return res


@app.websocket("/ws")
async def websocket(ws: WebSocket):
    origin = ws.headers.get("origin")
    if origin and urlparse(origin).netloc != ws.headers.get("host"):
        await ws.close(code=4403)
        return
    sess = await anyio.to_thread.run_sync(lookup_session, ws.cookies.get(COOKIE))
    if not sess or not sess["full"]:
        await ws.close(code=4401)
        return
    uid = sess["user_id"]
    await ws.accept()
    manager.add(uid, ws)
    bucket: list[float] = []
    try:
        while True:
            try:
                data = await ws.receive_json()
            except (ValueError, KeyError):
                continue
            if not isinstance(data, dict):
                continue
            now = time.monotonic()
            bucket[:] = [t for t in bucket if now - t < 1.0]
            if len(bucket) >= 15:  # max. 15 Ereignisse pro Sekunde
                continue
            bucket.append(now)
            kind = data.get("type")
            if kind == "ping":
                await ws.send_json({"type": "pong"})
            elif kind == "typing":
                to, state, preview = data.get("to"), data.get("state"), data.get("preview")
                if not isinstance(to, str) or not HEX32.match(to) or state not in ("typing", "stop"):
                    continue
                is_contact, indicator, live = await anyio.to_thread.run_sync(_typing_permission, uid, to)
                if not is_contact or not indicator:
                    continue
                event = {"type": "typing", "from": uid, "state": state}
                # Live-Typing-Vorschau ist E2E-verschlüsselt und wird nur weitergeleitet, wenn der
                # Absender sie in seinen Einstellungen freigegeben hat (serverseitig erzwungen).
                if live and isinstance(preview, str) and len(preview) <= 16_384:
                    event["preview"] = preview
                await manager.send(to, event)
    except WebSocketDisconnect:
        pass
    finally:
        manager.remove(uid, ws)


# =============================================================== Frontend
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")


@app.get("/manifest.webmanifest")
def manifest():
    return FileResponse(config.STATIC_DIR / "manifest.webmanifest", media_type="application/manifest+json")


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
def spa(path: str):
    if path.startswith(("api/", "static/")):
        raise HTTPException(404, "Nicht gefunden")
    return FileResponse(config.STATIC_DIR / "index.html", media_type="text/html")
