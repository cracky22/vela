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
import mimetypes
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

from . import config, db, models_dl, security
from .security import limiter
from .ws import manager

log = logging.getLogger("vela")

COOKIE = "__Host-vela" if config.TLS_ENABLED else "vela_sid"
DAY_MS = 86_400_000
HEX32 = re.compile(r"^[a-f0-9]{32}$")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.]{3,32}$")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,189}\.[^@\s]{2,63}$")
DEFAULT_SETTINGS = {"read_receipts": True, "typing_indicator": True, "live_typing": False, "show_online": True}
TTL_CHOICES = (0, 3600, DAY_MS // 1000, 7 * DAY_MS // 1000, 90 * DAY_MS // 1000)  # verschwindende Nachrichten (s)
MAX_GROUP_MEMBERS = 256
STATUS_TTL_MS = DAY_MS  # Status-Beiträge verschwinden nach 24 Stunden
AVATAR_MAX_BYTES = 2 * 1024 * 1024

# Windows liest MIME-Typen aus der Registry; dort ist .js teils als text/plain eingetragen,
# was Module-Skripte (mit nosniff) blockiert. Daher feste Zuordnung.
for _ext, _type in ((".js", "text/javascript"), (".mjs", "text/javascript"), (".wasm", "application/wasm"),
                    (".css", "text/css"), (".svg", "image/svg+xml"), (".webmanifest", "application/manifest+json"),
                    (".json", "application/json"), (".onnx", "application/octet-stream")):
    mimetypes.add_type(_type, _ext)


# =============================================================== Lebenszyklus
def cleanup() -> dict[str, int]:
    """Löscht abgelaufene Daten (Datenminimierung / Speicherbegrenzung nach Art. 5 DSGVO)."""
    now = db.now_ms()
    stats = {}
    with db.tx() as c:
        doomed = [r["id"] for r in c.execute(
            "SELECT id FROM files WHERE expires_at < ? OR (message_id IS NULL AND status_id IS NULL AND group_message_id IS NULL AND created_at < ?)",
            (now, now - DAY_MS))]
        doomed += [r["id"] for r in c.execute(
            "SELECT f.id FROM files f JOIN statuses s ON s.id=f.status_id WHERE s.expires_at < ?", (now,))]
        stats["statuses"] = c.execute("DELETE FROM statuses WHERE expires_at < ?", (now,)).rowcount
        doomed += [r["id"] for r in c.execute(
            "SELECT f.id FROM files f JOIN messages m ON m.id=f.message_id WHERE m.expires_at < ?", (now,))]
        c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in doomed])
        doomed += [r["id"] for r in c.execute(
            "SELECT f.id FROM files f JOIN group_messages g ON g.id=f.group_message_id WHERE g.expires_at < ?", (now,))]
        stats["messages"] = c.execute("DELETE FROM messages WHERE expires_at < ?", (now,)).rowcount
        stats["group_messages"] = c.execute("DELETE FROM group_messages WHERE expires_at < ?", (now,)).rowcount
        c.execute("DELETE FROM groups WHERE id NOT IN (SELECT DISTINCT group_id FROM group_members)")
        stats["sessions"] = c.execute("DELETE FROM sessions WHERE expires_at < ?", (now,)).rowcount
        pending = [r["id"] for r in c.execute(
            "SELECT id FROM users WHERE activated=0 AND created_at < ?",
            (now - config.PENDING_ACCOUNT_HOURS * 3_600_000,))]
        for uid in pending:
            doomed += [r["id"] for r in c.execute("SELECT id FROM files WHERE owner_id=?", (uid,))]
            c.execute("DELETE FROM users WHERE id=?", (uid,))
            (config.DATA_DIR / "avatars" / f"{uid}.jpg").unlink(missing_ok=True)
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


def _quiet_disconnects(loop: asyncio.AbstractEventLoop, context: dict) -> None:
    """Unter Windows meldet die Proactor-Event-Loop abgebrochene Client-Verbindungen
    (WinError 10054, z. B. geschlossener Tab oder Zertifikatswarnung) als Fehler. Das ist
    harmlos und wird hier unterdrückt; alle anderen Fehler laufen normal weiter."""
    if isinstance(context.get("exception"), (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
        return
    loop.default_exception_handler(context)


@asynccontextmanager
async def lifespan(_: FastAPI):
    asyncio.get_running_loop().set_exception_handler(_quiet_disconnects)
    db.init()
    # Thread-Pool für blockierende Arbeit (sync-Endpunkte, DB, Hashing, Datei-I/O)
    anyio.to_thread.current_default_thread_limiter().total_tokens = config.WORKER_THREADS
    task = asyncio.create_task(_cleanup_loop())
    yield
    task.cancel()


app = FastAPI(title="Vela", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


# =============================================================== Reverse-Proxy- & Präfix-Middleware
class ProxyPrefixMiddleware:
    """ASGI-Middleware zur Unterstützung von Reverse-Proxies und Unterpfaden (z. B. /vela):

    * Wenn Anfragen über einen Subpath wie /vela eintreffen:
      - /vela (ohne Slash) wird per 307-Redirect auf /vela/ umgeleitet, damit relative
        Assets (HTML/CSS/JS) im Browser korrekt aufgelöst werden.
      - Pfade wie /vela/api/... oder /vela/static/... werden intern auf /api/...
        bzw. /static/... umgeschrieben und scope['root_path'] wird auf /vela gesetzt.
    * Wenn ein Reverse-Proxy den Pfad bereits strippt und X-Forwarded-Prefix sendet:
      - scope['root_path'] wird entsprechend gesetzt.
    * Funktioniert transparent für HTTP-Requests und WebSockets (/vela/ws).
    """

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            return await self.app(scope, receive, send)

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        path = scope.get("path", "")

        configured_prefix = config.ROOT_PATH.rstrip("/")
        fwd_prefix = headers.get("x-forwarded-prefix", "").rstrip("/")

        prefix = ""
        for cand in (configured_prefix, fwd_prefix, "/vela"):
            if cand and (path == cand or path.startswith(cand + "/")):
                prefix = cand
                break

        if prefix and path == prefix:
            if scope["type"] == "http":
                qs = scope.get("query_string", b"").decode("latin-1")
                location = f"{prefix}/" + (f"?{qs}" if qs else "")
                response = Response(status_code=307, headers={"Location": location})
                return await response(scope, receive, send)

        if prefix and path.startswith(prefix + "/"):
            scope["root_path"] = prefix
        elif fwd_prefix:
            scope["root_path"] = fwd_prefix
            scope["path"] = fwd_prefix + path
        elif configured_prefix:
            scope["root_path"] = configured_prefix
            scope["path"] = configured_prefix + path

        return await self.app(scope, receive, send)


# =============================================================== Sicherheits-Middleware
class SecurityMiddleware:
    """Reines ASGI-Middleware (kompatibel mit Streaming-Uploads und WebSockets):

    * CSRF-Schutz: zustandsändernde API-Aufrufe brauchen den Header `X-Requested-With: vela`
      (lässt sich cross-origin nicht ohne CORS-Freigabe setzen) und eine passende Origin
      (inkl. Unterstützung von Reverse-Proxy Host / X-Forwarded-Host).
    * Sicherheits-Header (CSP, HSTS, nosniff, Referrer-Policy, ...).
    """

    def __init__(self, app_):
        self.app = app_

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        raw_path, method, host = scope["path"], scope["method"], headers.get("host", "")
        root_path = scope.get("root_path", "")
        path = raw_path[len(root_path):] if root_path and raw_path.startswith(root_path) else raw_path
        effective_host = headers.get("x-forwarded-host") or host

        if path.startswith("/api/") and method not in ("GET", "HEAD", "OPTIONS"):
            origin = headers.get("origin")
            origin_host = urlparse(origin).netloc.split(":")[0] if origin else ""
            eff_host = effective_host.split(":")[0]
            if headers.get("x-requested-with") != "vela" or (origin and origin_host != eff_host):
                return await JSONResponse({"detail": "Anfrage abgelehnt (CSRF-Schutz)"}, 403)(scope, receive, send)
            cl = headers.get("content-length")
            if path not in ("/api/files", "/api/me/avatar") and cl and cl.isdigit() and int(cl) > config.MAX_JSON_BYTES:
                return await JSONResponse({"detail": "Anfrage zu groß"}, 413)(scope, receive, send)

        connect_hosts = f"wss://{effective_host} ws://{effective_host}"
        if host and host != effective_host:
            connect_hosts += f" wss://{host} ws://{host}"

        csp = (
            "default-src 'self'; "
            # blob: + wasm-unsafe-eval: die ONNX-Runtime (Transkription) lädt ihr WASM-Modul so.
            # Fremde Skript-Hosts sind nicht erlaubt – alle Dateien kommen vom eigenen Server.
            "script-src 'self' blob: 'wasm-unsafe-eval'; "
            "worker-src 'self' blob:; "
            f"connect-src 'self' blob: {connect_hosts}; "
            "img-src 'self' blob: data:; media-src 'self' blob:; "
            "style-src 'self' 'unsafe-inline'; font-src 'self'; object-src 'none'; "
            "base-uri 'self'; frame-ancestors 'none'; form-action 'self'"
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
                if config.TLS_ENABLED or headers.get("x-forwarded-proto") == "https":
                    h["Strict-Transport-Security"] = "max-age=31536000"
                if path.startswith("/api/avatars/"):
                    h["Cache-Control"] = "private, max-age=86400"
                elif path.startswith("/api/"):
                    h["Cache-Control"] = "no-store"
                elif "cache-control" not in h:
                    h["Cache-Control"] = "no-cache"
            await send(message)

        await self.app(scope, receive, send_wrapper)


app.add_middleware(SecurityMiddleware)
app.add_middleware(ProxyPrefixMiddleware)


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
    token = request.cookies.get(COOKIE) or request.cookies.get("vela_sid") or request.cookies.get("__Host-vela")
    sess = lookup_session(token)
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
        "deleted_at": row["deleted_at"], "expires_at": row["expires_at"],
        "system": json.loads(row["system"]) if row["system"] else None,
    }


def expiry_for(ttl: int, now: int) -> int:
    retention = now + config.RETENTION_DAYS * DAY_MS
    return min(retention, now + ttl * 1000) if ttl else retention


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
    show_online: bool = True


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
            # Abgebrochene Registrierungen (2FA nie bestätigt, älter als 10 min) geben Name/E-Mail frei
            c.execute("DELETE FROM users WHERE activated=0 AND created_at < ? AND (username=? OR email=?)",
                      (db.now_ms() - 600_000, body.username, body.email))
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
        "created_at": u["created_at"], "about": u["about"], "avatar_version": u["avatar_version"],
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
        "groups": [dict(r) for r in db.all_(
            "SELECT g.id, g.name, g.description, m.role, m.joined_at FROM group_members m JOIN groups g ON "
            "g.id=m.group_id WHERE m.user_id=?", uid)],
        "group_messages_metadata": [dict(r) for r in db.all_(
            "SELECT id, group_id, created_at, expires_at, deleted_at FROM group_messages WHERE sender_id=?", uid)],
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
    for r in db.all_("SELECT group_id FROM group_members WHERE user_id=?", uid):
        leave_group(r["group_id"], uid, uid, kind="left")
    with db.tx() as c:
        files = [r["id"] for r in c.execute(
            "SELECT f.id FROM files f LEFT JOIN messages m ON m.id=f.message_id "
            "WHERE f.owner_id=? OR m.recipient_id=?", (uid, uid))]
        c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in files])
        c.execute("DELETE FROM users WHERE id=?", (uid,))
    for fid in files:
        _unlink(fid)
    (config.DATA_DIR / "avatars" / f"{uid}.jpg").unlink(missing_ok=True)
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
        "AND silent=0 AND deleted_at IS NULL AND system IS NULL GROUP BY sender_id", me_)}
    out = []
    for r in db.all_("SELECT c.*, u.username, u.enc_pub, u.sig_pub, u.key_bits, u.key_version, u.about, "
                     "u.avatar_version FROM contacts c JOIN users u ON u.id=c.contact_id WHERE c.user_id=?", me_):
        item = {"id": r["contact_id"], "username": r["username"], "status": r["status"],
                "archived": bool(r["archived"]), "pinned": bool(r["pinned"]), "muted": bool(r["muted"]),
                "since": r["created_at"], "unread": unread.get(r["contact_id"], 0), "last": None,
                "ttl": r["ttl"]}
        if r["status"] == "accepted":
            # Öffentliche Schlüssel werden erst nach beidseitiger Zustimmung herausgegeben
            item.update(enc_pub=r["enc_pub"], sig_pub=r["sig_pub"], key_bits=r["key_bits"],
                        key_version=r["key_version"], about=r["about"], avatar_version=r["avatar_version"],
                        online=is_visible_online(r["contact_id"]))
            last = db.one("SELECT * FROM messages WHERE ((sender_id=? AND recipient_id=?) OR "
                          "(sender_id=? AND recipient_id=?)) AND silent=0 AND expires_at > ? "
                          "ORDER BY created_at DESC LIMIT 1",
                          me_, r["contact_id"], r["contact_id"], me_, db.now_ms())
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


class TtlIn(BaseModel):
    ttl: int


@app.put("/api/contacts/{cid}/ttl")
def set_contact_ttl(cid: str, body: TtlIn, sess: Full):
    """Verschwindende Nachrichten für einen Einzelchat (gilt für beide Seiten)."""
    me_ = sess["user_id"]
    require_accepted(me_, cid)
    if body.ttl not in TTL_CHOICES:
        raise HTTPException(400, "Ungültige Dauer")
    now = db.now_ms()
    mid = uuid.uuid4().hex
    with db.tx() as c:
        c.execute("UPDATE contacts SET ttl=? WHERE (user_id=? AND contact_id=?) OR (user_id=? AND contact_id=?)",
                  (body.ttl, me_, cid, cid, me_))
        c.execute("INSERT INTO messages (id, sender_id, recipient_id, envelope, system, created_at, expires_at, read_at) "
                  "VALUES (?,?,?,NULL,?,?,?,?)", (mid, me_, cid, json.dumps({"t": "timer", "by": me_, "ttl": body.ttl}),
                                                  now, now + config.RETENTION_DAYS * DAY_MS, now))
    row = db.one("SELECT * FROM messages WHERE id=?", mid)
    for uid in (cid, me_):
        manager.notify(uid, {"type": "message", "message": msg_out(row, uid)})
        manager.notify(uid, {"type": "contact_update"})
    return {"ttl": body.ttl}


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
                   "AND created_at < ? AND expires_at > ? ORDER BY created_at DESC LIMIT ?",
                   me_, cid, cid, me_, before or 2**62, db.now_ms(), limit)
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
    ttl = db.one("SELECT ttl FROM contacts WHERE user_id=? AND contact_id=?", me_, body.to)["ttl"]
    try:
        with db.tx() as c:
            c.execute("INSERT INTO messages (id, sender_id, recipient_id, envelope, view_once, silent, created_at, "
                      "expires_at) VALUES (?,?,?,?,?,?,?,?)",
                      (body.id, me_, body.to, body.envelope, int(body.view_once), int(body.silent), now,
                       expiry_for(ttl, now)))
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
    row = db.one("SELECT f.owner_id, f.status_id, m.recipient_id, m.deleted_at, m.viewed_at, s.expires_at AS s_exp, "
                 "g.group_id AS g_group, g.deleted_at AS g_deleted "
                 "FROM files f LEFT JOIN messages m ON m.id=f.message_id LEFT JOIN statuses s ON s.id=f.status_id "
                 "LEFT JOIN group_messages g ON g.id=f.group_message_id WHERE f.id=?", fid)
    me_ = sess["user_id"]
    allowed = False
    if row:
        if me_ == row["owner_id"]:
            allowed = True
        elif row["recipient_id"] == me_ and not row["deleted_at"] and not row["viewed_at"]:
            allowed = True
        elif row["status_id"] and (row["s_exp"] or 0) > db.now_ms() and \
                contact_status(me_, row["owner_id"]) == "accepted":
            allowed = True
        elif row["g_group"] and not row["g_deleted"] and member_role(row["g_group"], me_):
            allowed = True
    path = config.UPLOAD_DIR / fid
    if not allowed or not path.exists():
        raise HTTPException(404, "Datei nicht gefunden")
    return FileResponse(path, media_type="application/octet-stream", headers={"Cache-Control": "no-store"})


# =============================================================== Profil & Profilbild
class ProfileIn(BaseModel):
    about: str = Field(default="", max_length=140)


@app.put("/api/me/profile")
def update_profile(body: ProfileIn, sess: Full):
    about = " ".join(body.about.split())  # Steuerzeichen/Zeilenumbrüche entfernen
    with db.tx() as c:
        c.execute("UPDATE users SET about=? WHERE id=?", (about, sess["user_id"]))
    for r in db.all_("SELECT contact_id FROM contacts WHERE user_id=? AND status='accepted'", sess["user_id"]):
        manager.notify(r["contact_id"], {"type": "contact_update"})
    return {"about": about}


def _bump_avatar(uid: str, delete: bool) -> int:
    with db.tx() as c:
        c.execute("UPDATE users SET avatar_version=? WHERE id=?",
                  (0 if delete else db.now_ms(), uid))
    v = db.one("SELECT avatar_version FROM users WHERE id=?", uid)["avatar_version"]
    for r in db.all_("SELECT contact_id FROM contacts WHERE user_id=? AND status='accepted'", uid):
        manager.notify(r["contact_id"], {"type": "contact_update"})
    return v


@app.post("/api/me/avatar")
async def upload_avatar(request: Request, sess: Full):
    """Profilbild (vom Client auf 512 px verkleinert, als JPEG ohne Metadaten neu kodiert).
    Hinweis: Profilbilder sind NICHT Ende-zu-Ende-verschlüsselt, sondern werden nur an
    angenommene Kontakte ausgeliefert (siehe SPEC.md, E5)."""
    rate(f"avatar:{sess['user_id']}", 20, 3600)
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > AVATAR_MAX_BYTES:
            raise HTTPException(413, "Profilbild zu groß (max. 2 MB)")
    if not body.startswith(b"\xff\xd8\xff"):
        raise HTTPException(400, "Nur JPEG-Bilder werden akzeptiert")
    path = config.DATA_DIR / "avatars" / f"{sess['user_id']}.jpg"
    await anyio.Path(path).write_bytes(body)
    v = await anyio.to_thread.run_sync(_bump_avatar, sess["user_id"], False)
    return {"avatar_version": v}


@app.delete("/api/me/avatar")
def delete_avatar(sess: Full):
    (config.DATA_DIR / "avatars" / f"{sess['user_id']}.jpg").unlink(missing_ok=True)
    return {"avatar_version": _bump_avatar(sess["user_id"], True)}


@app.get("/api/avatars/{uid}")
def get_avatar(uid: str, sess: Full):
    if not HEX32.match(uid) or (uid != sess["user_id"] and contact_status(sess["user_id"], uid) != "accepted"
                                and not share_group(sess["user_id"], uid)):
        raise HTTPException(404, "Nicht gefunden")
    path = config.DATA_DIR / "avatars" / f"{uid}.jpg"
    if not path.exists():
        raise HTTPException(404, "Nicht gefunden")
    return FileResponse(path, media_type="image/jpeg")


# =============================================================== Status (24-h-Beiträge, E2E)
class StatusIn(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    envelope: str = Field(max_length=500_000)
    files: list[str] = Field(default_factory=list, max_length=1)


def accepted_ids(uid: str) -> set[str]:
    return {r["contact_id"] for r in db.all_(
        "SELECT contact_id FROM contacts WHERE user_id=? AND status='accepted'", uid)}


@app.get("/api/status")
def list_status(sess: Full):
    me_ = sess["user_id"]
    authors = accepted_ids(me_) | {me_}
    marks = ",".join("?" * len(authors))
    rows = db.all_(f"SELECT s.*, (SELECT COUNT(*) FROM status_views v WHERE v.status_id=s.id) AS views, "
                   f"EXISTS(SELECT 1 FROM status_views v WHERE v.status_id=s.id AND v.viewer_id=?) AS seen "
                   f"FROM statuses s WHERE s.user_id IN ({marks}) AND s.expires_at > ? ORDER BY s.created_at",
                   me_, *authors, db.now_ms())
    out = []
    for r in rows:
        try:
            if me_ not in json.loads(r["envelope"]).get("k", {}):
                continue  # vor der Kontaktaufnahme veröffentlicht -> nicht für mich verschlüsselt
        except ValueError:
            continue
        out.append({"id": r["id"], "user_id": r["user_id"], "envelope": r["envelope"], "ts": r["created_at"],
                    "expires_at": r["expires_at"], "seen": bool(r["seen"]),
                    "views": r["views"] if r["user_id"] == me_ else None})
    return out


@app.post("/api/status")
def post_status(body: StatusIn, sess: Full):
    me_ = sess["user_id"]
    rate(f"status:{me_}", 30, 3600)
    contacts = accepted_ids(me_)
    try:
        env = json.loads(body.envelope)
        assert isinstance(env, dict) and isinstance(env.get("k"), dict) and me_ in env["k"]
        assert set(env["k"]) <= contacts | {me_}
    except (ValueError, AssertionError):
        raise HTTPException(400, "Ungültiger Status-Umschlag")
    now = db.now_ms()
    try:
        with db.tx() as c:
            c.execute("INSERT INTO statuses (id, user_id, envelope, created_at, expires_at) VALUES (?,?,?,?,?)",
                      (body.id, me_, body.envelope, now, now + STATUS_TTL_MS))
            for fid in body.files:
                if c.execute("UPDATE files SET status_id=?, expires_at=? WHERE id=? AND owner_id=? AND "
                             "message_id IS NULL AND status_id IS NULL",
                             (body.id, now + STATUS_TTL_MS, fid, me_)).rowcount != 1:
                    raise HTTPException(400, "Datei nicht gefunden oder bereits verwendet")
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Status-ID bereits vergeben")
    for cid in contacts | {me_}:
        manager.notify(cid, {"type": "status_update"})
    return {"id": body.id, "ts": now, "expires_at": now + STATUS_TTL_MS}


@app.post("/api/status/{sid}/view")
def view_status(sid: str, sess: Full):
    me_ = sess["user_id"]
    row = db.one("SELECT user_id FROM statuses WHERE id=? AND expires_at > ?", sid, db.now_ms())
    if not row or row["user_id"] == me_ or contact_status(me_, row["user_id"]) != "accepted":
        return {"ok": False}
    with db.tx() as c:
        n = c.execute("INSERT OR IGNORE INTO status_views (status_id, viewer_id, viewed_at) VALUES (?,?,?)",
                      (sid, me_, db.now_ms())).rowcount
    if n and user_settings(me_)["read_receipts"]:
        manager.notify(row["user_id"], {"type": "status_view", "id": sid})
    return {"ok": True}


@app.get("/api/status/{sid}/views")
def status_views(sid: str, sess: Full):
    """Wer hat meinen Status gesehen? Nur Personen mit aktivierten Lesebestätigungen."""
    row = db.one("SELECT user_id FROM statuses WHERE id=?", sid)
    if not row or row["user_id"] != sess["user_id"]:
        raise HTTPException(404, "Nicht gefunden")
    viewers = []
    for r in db.all_("SELECT v.viewer_id, v.viewed_at, u.username FROM status_views v JOIN users u ON "
                     "u.id=v.viewer_id WHERE v.status_id=? ORDER BY v.viewed_at DESC", sid):
        if user_settings(r["viewer_id"])["read_receipts"]:
            viewers.append({"id": r["viewer_id"], "username": r["username"], "viewed_at": r["viewed_at"]})
    total = db.one("SELECT COUNT(*) n FROM status_views WHERE status_id=?", sid)["n"]
    return {"viewers": viewers, "total": total}


@app.delete("/api/status/{sid}")
def delete_status(sid: str, sess: Full):
    me_ = sess["user_id"]
    with db.tx() as c:
        row = c.execute("SELECT user_id FROM statuses WHERE id=?", (sid,)).fetchone()
        if not row or row["user_id"] != me_:
            raise HTTPException(404, "Nicht gefunden")
        files = [r["id"] for r in c.execute("SELECT id FROM files WHERE status_id=?", (sid,))]
        c.execute("DELETE FROM files WHERE status_id=?", (sid,))
        c.execute("DELETE FROM statuses WHERE id=?", (sid,))
    for fid in files:
        _unlink(fid)
    for cid in accepted_ids(me_) | {me_}:
        manager.notify(cid, {"type": "status_update"})
    return {"ok": True}


# =============================================================== Transkription (selbst gehostet)
class ModelIn(BaseModel):
    model: str


@app.get("/api/transcription")
def transcription_status(sess: Full):
    return models_dl.status()


@app.post("/api/transcription/install")
def transcription_install(body: ModelIn, sess: Full):
    rate(f"model:{sess['user_id']}", 10, 3600)
    try:
        models_dl.install_async(body.model)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return models_dl.status()


# =============================================================== Online-Status
def is_visible_online(uid: str) -> bool:
    return manager.is_online(uid) and user_settings(uid).get("show_online", True)


def _presence_targets(uid: str) -> list[str]:
    if not user_settings(uid).get("show_online", True):
        return []
    ids = accepted_ids(uid)
    ids |= {r["user_id"] for r in db.all_(
        "SELECT DISTINCT m2.user_id FROM group_members m1 JOIN group_members m2 ON m1.group_id=m2.group_id "
        "WHERE m1.user_id=? AND m2.user_id<>?", uid, uid)}
    return list(ids)


# =============================================================== Gruppen
# Gruppen-Nachrichten sind Ende-zu-Ende-verschlüsselt: Der Absender kapselt den AES-Schlüssel
# für jedes Mitglied einzeln (RSA-OAEP). Der Server kennt Gruppenname, Beschreibung und
# Mitgliederliste (Metadaten, siehe SPEC.md E7) – aber keine Inhalte.
def member_role(gid: str, uid: str) -> str | None:
    row = db.one("SELECT role FROM group_members WHERE group_id=? AND user_id=?", gid, uid)
    return row["role"] if row else None


def share_group(a: str, b: str) -> bool:
    return bool(db.one("SELECT 1 FROM group_members m1 JOIN group_members m2 ON m1.group_id=m2.group_id "
                       "WHERE m1.user_id=? AND m2.user_id=? LIMIT 1", a, b))


def require_member(gid: str, uid: str) -> str:
    role = member_role(gid, uid) if HEX32.match(gid) else None
    if not role:
        raise HTTPException(404, "Gruppe nicht gefunden")
    return role


def require_admin(gid: str, uid: str) -> None:
    if require_member(gid, uid) != "admin":
        raise HTTPException(403, "Nur Admins dürfen das")


def member_ids(gid: str) -> list[str]:
    return [r["user_id"] for r in db.all_("SELECT user_id FROM group_members WHERE group_id=?", gid)]


def gmsg_out(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"], "from": row["sender_id"], "group": row["group_id"], "to": "g:" + row["group_id"],
        "envelope": row["envelope"], "system": json.loads(row["system"]) if row["system"] else None,
        "silent": bool(row["silent"]), "view_once": False, "ts": row["created_at"],
        "deleted_at": row["deleted_at"], "expires_at": row["expires_at"],
    }


def notify_group(gid: str, payload: dict, extra: list[str] | None = None) -> None:
    for uid in set(member_ids(gid)) | set(extra or []):
        manager.notify(uid, payload)


def group_system(c: sqlite3.Connection, gid: str, actor: str | None, data: dict) -> str:
    mid = uuid.uuid4().hex
    now = db.now_ms()
    c.execute("INSERT INTO group_messages (id, group_id, sender_id, envelope, system, created_at, expires_at) "
              "VALUES (?,?,?,NULL,?,?,?)", (mid, gid, actor, json.dumps(data), now,
                                            now + config.RETENTION_DAYS * DAY_MS))
    return mid


def emit(gid: str, mids: list[str], extra: list[str] | None = None) -> None:
    """Systemnachrichten live an alle (aktuellen) Mitglieder senden."""
    for mid in mids:
        row = db.one("SELECT * FROM group_messages WHERE id=?", mid)
        if row:
            notify_group(gid, {"type": "message", "message": gmsg_out(row)}, extra=extra)


def usernames(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    rows = db.all_(f"SELECT id, username FROM users WHERE id IN ({','.join('?' * len(ids))})", *ids)
    return [{"id": r["id"], "username": r["username"]} for r in rows]


def group_out(gid: str, me_: str) -> dict[str, Any]:
    g = db.one("SELECT * FROM groups WHERE id=?", gid)
    mine = db.one("SELECT * FROM group_members WHERE group_id=? AND user_id=?", gid, me_)
    members = []
    for r in db.all_("SELECT m.user_id, m.role, m.joined_at, m.last_read, u.username, u.enc_pub, u.sig_pub, "
                     "u.key_bits, u.key_version, u.avatar_version, u.about FROM group_members m JOIN users u ON "
                     "u.id=m.user_id WHERE m.group_id=? ORDER BY m.joined_at", gid):
        s = user_settings(r["user_id"])
        members.append({
            "id": r["user_id"], "username": r["username"], "role": r["role"], "joined_at": r["joined_at"],
            "enc_pub": r["enc_pub"], "sig_pub": r["sig_pub"], "key_bits": r["key_bits"],
            "key_version": r["key_version"], "avatar_version": r["avatar_version"], "about": r["about"],
            # Lesestand nur, wenn das Mitglied Lesebestätigungen erlaubt
            "last_read": r["last_read"] if s["read_receipts"] else None,
            "online": manager.is_online(r["user_id"]) and s.get("show_online", True),
            "contact": contact_status(me_, r["user_id"]) == "accepted",
        })
    now = db.now_ms()
    unread = db.one("SELECT COUNT(*) n FROM group_messages WHERE group_id=? AND created_at > ? AND "
                    "sender_id IS NOT ? AND silent=0 AND system IS NULL AND deleted_at IS NULL AND expires_at > ?",
                    gid, mine["last_read"], me_, now)["n"]
    last = db.one("SELECT * FROM group_messages WHERE group_id=? AND silent=0 AND expires_at > ? "
                  "ORDER BY created_at DESC LIMIT 1", gid, now)
    return {
        "id": gid, "kind": "group", "name": g["name"], "description": g["description"],
        "avatar_version": g["avatar_version"], "ttl": g["ttl"], "only_admins": bool(g["only_admins"]),
        "created_at": g["created_at"], "created_by": g["created_by"],
        "role": mine["role"], "archived": bool(mine["archived"]), "pinned": bool(mine["pinned"]),
        "muted": bool(mine["muted"]), "last_read": mine["last_read"], "joined_at": mine["joined_at"],
        "unread": unread, "last": gmsg_out(last) if last else None, "members": members,
    }


def leave_group(gid: str, uid: str, actor: str, kind: str = "left") -> None:
    """Mitglied entfernen/austreten. Letzter Admin -> ältestes Mitglied wird Admin.
    Letztes Mitglied -> Gruppe (inkl. Nachrichten & Dateien) wird gelöscht."""
    files: list[str] = []
    mids: list[str] = []
    deleted = False
    with db.tx() as c:
        c.execute("DELETE FROM group_members WHERE group_id=? AND user_id=?", (gid, uid))
        rest = c.execute("SELECT user_id, role FROM group_members WHERE group_id=? ORDER BY joined_at", (gid,)).fetchall()
        if not rest:
            deleted = True
            files = [r["id"] for r in c.execute(
                "SELECT f.id FROM files f JOIN group_messages g ON g.id=f.group_message_id WHERE g.group_id=?", (gid,))]
            c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in files])
            c.execute("DELETE FROM groups WHERE id=?", (gid,))
        else:
            name = c.execute("SELECT username FROM users WHERE id=?", (uid,)).fetchone()
            mids.append(group_system(c, gid, actor, {"t": kind, "by": actor, "user": {"id": uid, "username": name["username"] if name else "?"}}))
            if not any(r["role"] == "admin" for r in rest):
                c.execute("UPDATE group_members SET role='admin' WHERE group_id=? AND user_id=?", (gid, rest[0]["user_id"]))
                mids.append(group_system(c, gid, None, {"t": "admin", "by": None, "user": usernames([rest[0]["user_id"]])[0], "admin": True}))
    for fid in files:
        _unlink(fid)
    if deleted:
        (config.DATA_DIR / "avatars" / f"g_{gid}.jpg").unlink(missing_ok=True)
    emit(gid, mids)
    notify_group(gid, {"type": "group_update", "group": gid}, extra=[uid])


class GroupCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    members: list[str] = Field(default_factory=list, max_length=MAX_GROUP_MEMBERS)


class GroupPatchIn(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=64)
    description: str | None = Field(default=None, max_length=500)
    ttl: int | None = None
    only_admins: bool | None = None


class GroupMembersIn(BaseModel):
    members: list[str] = Field(min_length=1, max_length=MAX_GROUP_MEMBERS)


class RoleIn(BaseModel):
    admin: bool


class GroupSendIn(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    envelope: str = Field(max_length=2_000_000)
    silent: bool = False
    files: list[str] = Field(default_factory=list, max_length=10)


class GroupReadIn(BaseModel):
    up_to: int


def _check_contacts(me_: str, ids: list[str]) -> list[str]:
    ids = list(dict.fromkeys(i for i in ids if i != me_))
    for i in ids:
        if not HEX32.match(i) or contact_status(me_, i) != "accepted":
            raise HTTPException(400, "Nur eigene Kontakte können hinzugefügt werden")
    return ids


@app.get("/api/groups")
def list_groups(sess: Full):
    me_ = sess["user_id"]
    return [group_out(r["group_id"], me_) for r in db.all_("SELECT group_id FROM group_members WHERE user_id=?", me_)]


@app.post("/api/groups")
def create_group(body: GroupCreateIn, sess: Full):
    me_ = sess["user_id"]
    rate(f"gcreate:{me_}", 20, 3600)
    ids = _check_contacts(me_, body.members)
    gid = uuid.uuid4().hex
    now = db.now_ms()
    with db.tx() as c:
        c.execute("INSERT INTO groups (id, name, description, created_by, created_at) VALUES (?,?,?,?,?)",
                  (gid, body.name.strip(), body.description.strip(), me_, now))
        c.execute("INSERT INTO group_members (group_id, user_id, role, joined_at, last_read) VALUES (?,?,?,?,?)",
                  (gid, me_, "admin", now, now))
        for i in ids:
            c.execute("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)",
                      (gid, i, "member", now))
        group_system(c, gid, me_, {"t": "created", "by": me_, "name": body.name.strip(), "users": usernames(ids)})
    notify_group(gid, {"type": "group_update", "group": gid})
    return group_out(gid, me_)


@app.get("/api/groups/{gid}")
def get_group(gid: str, sess: Full):
    require_member(gid, sess["user_id"])
    return group_out(gid, sess["user_id"])


@app.patch("/api/groups/{gid}")
def patch_group(gid: str, body: GroupPatchIn, sess: Full):
    me_ = sess["user_id"]
    role = require_member(gid, me_)
    g = db.one("SELECT * FROM groups WHERE id=?", gid)
    if role != "admin" and (body.only_admins is not None or g["only_admins"]):
        raise HTTPException(403, "Nur Admins dürfen die Gruppeninfo ändern")
    if body.ttl is not None and body.ttl not in TTL_CHOICES:
        raise HTTPException(400, "Ungültige Dauer")
    mids: list[str] = []
    with db.tx() as c:
        if body.name is not None and body.name.strip() != g["name"]:
            c.execute("UPDATE groups SET name=? WHERE id=?", (body.name.strip(), gid))
            mids.append(group_system(c, gid, me_, {"t": "renamed", "by": me_, "name": body.name.strip()}))
        if body.description is not None and body.description.strip() != g["description"]:
            c.execute("UPDATE groups SET description=? WHERE id=?", (body.description.strip(), gid))
            mids.append(group_system(c, gid, me_, {"t": "description", "by": me_}))
        if body.ttl is not None and body.ttl != g["ttl"]:
            c.execute("UPDATE groups SET ttl=? WHERE id=?", (body.ttl, gid))
            mids.append(group_system(c, gid, me_, {"t": "timer", "by": me_, "ttl": body.ttl}))
        if body.only_admins is not None and int(body.only_admins) != g["only_admins"]:
            c.execute("UPDATE groups SET only_admins=? WHERE id=?", (int(body.only_admins), gid))
            mids.append(group_system(c, gid, me_, {"t": "only_admins", "by": me_, "value": body.only_admins}))
    emit(gid, mids)
    notify_group(gid, {"type": "group_update", "group": gid})
    return group_out(gid, me_)


@app.patch("/api/groups/{gid}/me")
def patch_group_me(gid: str, body: ContactPatch, sess: Full):
    me_ = sess["user_id"]
    require_member(gid, me_)
    fields = {k: int(v) for k, v in body.model_dump().items() if v is not None}
    if fields:
        sets = ", ".join(f"{k}=?" for k in fields)
        with db.tx() as c:
            c.execute(f"UPDATE group_members SET {sets} WHERE group_id=? AND user_id=?", (*fields.values(), gid, me_))
    return {"ok": True}


@app.post("/api/groups/{gid}/members")
def add_members(gid: str, body: GroupMembersIn, sess: Full):
    me_ = sess["user_id"]
    require_admin(gid, me_)
    existing = set(member_ids(gid))
    ids = [i for i in _check_contacts(me_, body.members) if i not in existing]
    if len(existing) + len(ids) > MAX_GROUP_MEMBERS:
        raise HTTPException(400, f"Maximal {MAX_GROUP_MEMBERS} Mitglieder")
    if ids:
        now = db.now_ms()
        with db.tx() as c:
            for i in ids:
                c.execute("INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES (?,?,?,?)",
                          (gid, i, "member", now))
            mid = group_system(c, gid, me_, {"t": "added", "by": me_, "users": usernames(ids)})
        emit(gid, [mid])
        notify_group(gid, {"type": "group_update", "group": gid})
    return group_out(gid, me_)


@app.delete("/api/groups/{gid}/members/{uid}")
def remove_member(gid: str, uid: str, sess: Full):
    me_ = sess["user_id"]
    require_member(gid, me_)
    if uid == me_:
        leave_group(gid, me_, me_, "left")
        return {"ok": True, "left": True}
    require_admin(gid, me_)
    if not member_role(gid, uid):
        raise HTTPException(404, "Kein Mitglied")
    leave_group(gid, uid, me_, "removed")
    return group_out(gid, me_)


@app.put("/api/groups/{gid}/members/{uid}/role")
def set_role(gid: str, uid: str, body: RoleIn, sess: Full):
    me_ = sess["user_id"]
    require_admin(gid, me_)
    if not member_role(gid, uid):
        raise HTTPException(404, "Kein Mitglied")
    with db.tx() as c:
        if not body.admin and c.execute("SELECT COUNT(*) n FROM group_members WHERE group_id=? AND role='admin'",
                                        (gid,)).fetchone()["n"] <= 1 and member_role(gid, uid) == "admin":
            raise HTTPException(400, "Die Gruppe braucht mindestens einen Admin")
        c.execute("UPDATE group_members SET role=? WHERE group_id=? AND user_id=?",
                  ("admin" if body.admin else "member", gid, uid))
        mid = group_system(c, gid, me_, {"t": "admin", "by": me_, "user": usernames([uid])[0], "admin": body.admin})
    emit(gid, [mid])
    notify_group(gid, {"type": "group_update", "group": gid})
    return group_out(gid, me_)


@app.get("/api/groups/{gid}/messages")
def group_messages(gid: str, sess: Full, before: int | None = None, limit: int = Query(60, ge=1, le=200)):
    me_ = sess["user_id"]
    require_member(gid, me_)
    rows = db.all_("SELECT * FROM group_messages WHERE group_id=? AND created_at < ? AND expires_at > ? "
                   "ORDER BY created_at DESC LIMIT ?", gid, before or 2**62, db.now_ms(), limit)
    return {"messages": [gmsg_out(r) for r in reversed(rows)], "has_more": len(rows) == limit}


@app.post("/api/groups/{gid}/messages")
def send_group_message(gid: str, body: GroupSendIn, sess: Full):
    me_ = sess["user_id"]
    rate(f"send:{me_}", 120, 60)
    require_member(gid, me_)
    members = set(member_ids(gid))
    g = db.one("SELECT ttl, only_admins FROM groups WHERE id=?", gid)
    try:
        env = json.loads(body.envelope)
        assert isinstance(env, dict) and isinstance(env.get("k"), dict)
        assert isinstance(env.get("iv"), str) and isinstance(env.get("ct"), str) and isinstance(env.get("sig"), str)
        assert me_ in env["k"] and set(env["k"]) <= members
    except (ValueError, AssertionError):
        raise HTTPException(400, "Ungültiger Nachrichten-Umschlag (Mitgliederliste veraltet? Bitte erneut senden.)")
    now = db.now_ms()
    try:
        with db.tx() as c:
            c.execute("INSERT INTO group_messages (id, group_id, sender_id, envelope, silent, created_at, expires_at) "
                      "VALUES (?,?,?,?,?,?,?)", (body.id, gid, me_, body.envelope, int(body.silent), now,
                                                 expiry_for(g["ttl"], now)))
            c.execute("UPDATE group_members SET last_read=? WHERE group_id=? AND user_id=? AND last_read < ?",
                      (now, gid, me_, now))
            for fid in body.files:
                if c.execute("UPDATE files SET group_message_id=? WHERE id=? AND owner_id=? AND message_id IS NULL "
                             "AND group_message_id IS NULL AND status_id IS NULL", (body.id, fid, me_)).rowcount != 1:
                    raise HTTPException(400, "Datei nicht gefunden oder bereits verwendet")
    except sqlite3.IntegrityError:
        raise HTTPException(409, "Nachrichten-ID bereits vergeben")
    out = gmsg_out(db.one("SELECT * FROM group_messages WHERE id=?", body.id))
    notify_group(gid, {"type": "message", "message": out})
    return out


@app.post("/api/groups/{gid}/read")
def group_read(gid: str, body: GroupReadIn, sess: Full):
    me_ = sess["user_id"]
    require_member(gid, me_)
    up_to = min(body.up_to, db.now_ms())
    with db.tx() as c:
        n = c.execute("UPDATE group_members SET last_read=? WHERE group_id=? AND user_id=? AND last_read < ?",
                      (up_to, gid, me_, up_to)).rowcount
    if n and user_settings(me_)["read_receipts"]:
        notify_group(gid, {"type": "gread", "group": gid, "by": me_, "up_to": up_to})
    return {"ok": True}


@app.delete("/api/groups/{gid}/messages/{mid}")
def delete_group_message(gid: str, mid: str, sess: Full):
    me_ = sess["user_id"]
    role = require_member(gid, me_)
    with db.tx() as c:
        row = c.execute("SELECT * FROM group_messages WHERE id=? AND group_id=?", (mid, gid)).fetchone()
        # Absender – oder Admins (Moderation) – dürfen für alle löschen
        if not row or row["system"] or (row["sender_id"] != me_ and role != "admin"):
            raise HTTPException(404, "Nachricht nicht gefunden")
        now = db.now_ms()
        c.execute("UPDATE group_messages SET envelope=NULL, deleted_at=? WHERE id=?", (now, mid))
        files = [r["id"] for r in c.execute("SELECT id FROM files WHERE group_message_id=?", (mid,))]
        c.execute("DELETE FROM files WHERE group_message_id=?", (mid,))
    for fid in files:
        _unlink(fid)
    notify_group(gid, {"type": "deleted", "id": mid, "at": now, "group": gid})
    return {"ok": True}


@app.post("/api/groups/{gid}/avatar")
async def upload_group_avatar(gid: str, request: Request, sess: Full):
    me_ = sess["user_id"]
    role = await anyio.to_thread.run_sync(require_member, gid, me_)
    g = await anyio.to_thread.run_sync(lambda: db.one("SELECT only_admins FROM groups WHERE id=?", gid))
    if role != "admin" and g["only_admins"]:
        raise HTTPException(403, "Nur Admins dürfen das Gruppenbild ändern")
    body = b""
    async for chunk in request.stream():
        body += chunk
        if len(body) > AVATAR_MAX_BYTES:
            raise HTTPException(413, "Bild zu groß (max. 2 MB)")
    if not body.startswith(b"\xff\xd8\xff"):
        raise HTTPException(400, "Nur JPEG-Bilder werden akzeptiert")
    await anyio.Path(config.DATA_DIR / "avatars" / f"g_{gid}.jpg").write_bytes(body)

    def bump():
        with db.tx() as c:
            c.execute("UPDATE groups SET avatar_version=? WHERE id=?", (db.now_ms(), gid))
            mid = group_system(c, gid, me_, {"t": "avatar", "by": me_})
        emit(gid, [mid])
        notify_group(gid, {"type": "group_update", "group": gid})
    await anyio.to_thread.run_sync(bump)
    return {"ok": True}


@app.get("/api/groups/{gid}/avatar")
def get_group_avatar(gid: str, sess: Full):
    require_member(gid, sess["user_id"])
    path = config.DATA_DIR / "avatars" / f"g_{gid}.jpg"
    if not path.exists():
        raise HTTPException(404, "Nicht gefunden")
    return FileResponse(path, media_type="image/jpeg")


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
    effective_host = ws.headers.get("x-forwarded-host") or ws.headers.get("host", "")
    if origin:
        orig_host = urlparse(origin).netloc.split(":")[0]
        eff_host = effective_host.split(":")[0]
        if orig_host != eff_host:
            await ws.close(code=4403)
            return
    token = ws.cookies.get(COOKIE) or ws.cookies.get("vela_sid") or ws.cookies.get("__Host-vela")
    sess = await anyio.to_thread.run_sync(lookup_session, token)
    if not sess or not sess["full"]:
        await ws.close(code=4401)
        return
    uid = sess["user_id"]
    await ws.accept()
    first = not manager.is_online(uid)
    manager.add(uid, ws)
    if first:
        await _broadcast_presence(uid, True)
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
            elif kind == "typing" and isinstance(data.get("group"), str):
                gid, state = data["group"], data.get("state")
                if not HEX32.match(gid) or state not in ("typing", "stop"):
                    continue
                allowed, others = await anyio.to_thread.run_sync(_group_typing_targets, uid, gid)
                if allowed:
                    for other in others:
                        await manager.send(other, {"type": "typing", "from": uid, "group": gid, "state": state})
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
        if not manager.is_online(uid):
            try:
                await _broadcast_presence(uid, False)
            except Exception:  # pragma: no cover
                pass


def _group_typing_targets(uid: str, gid: str) -> tuple[bool, list[str]]:
    if not member_role(gid, uid) or not user_settings(uid)["typing_indicator"]:
        return False, []
    return True, [m for m in member_ids(gid) if m != uid]


async def _broadcast_presence(uid: str, online: bool) -> None:
    targets = await anyio.to_thread.run_sync(_presence_targets, uid)
    for t in targets:
        await manager.send(t, {"type": "presence", "id": uid, "online": online})


# =============================================================== Frontend
app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
app.mount("/vendor", StaticFiles(directory=models_dl.VENDOR_DIR, check_dir=False), name="vendor")


@app.get("/manifest.webmanifest")
def manifest(request: Request):
    root = request.scope.get("root_path", "").rstrip("/")
    data = json.loads((config.STATIC_DIR / "manifest.webmanifest").read_text(encoding="utf-8"))
    if root:
        data["start_url"] = f"{root}/"
        data["scope"] = f"{root}/"
        for icon in data.get("icons", []):
            src = icon.get("src", "")
            if not src.startswith("http") and not src.startswith(root):
                clean_src = src.lstrip("./").lstrip("/")
                icon["src"] = f"{root}/{clean_src}"
    return JSONResponse(data, media_type="application/manifest+json")


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
def spa(path: str):
    if path.startswith(("api/", "static/", "vendor/")):
        raise HTTPException(404, "Nicht gefunden")
    return FileResponse(config.STATIC_DIR / "index.html", media_type="text/html")
