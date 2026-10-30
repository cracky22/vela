"""Schlüsseltresor (passwortgeschützte Schlüsselkopie) und QR-Geräteverknüpfung.

SCHLÜSSELTRESOR (optional, pro Nutzer)
  Der Browser leitet aus dem Passwort mit Argon2id zwei getrennte Werte ab: einen Anmeldewert (geht an den Server)
  und einen Verpackungsschlüssel (bleibt im Browser). Der Server speichert nur den Hash des Anmeldewerts und die
  mit dem Verpackungsschlüssel verschlüsselte Schlüsselkopie. Das Passwort selbst sieht er bei der Anmeldung nicht.
  Er kann die Schlüssel nicht lesen, sondern ein Datenbank-Dieb nur durch Raten des Passworts (Argon2id bremst das).

QR-VERKNÜPFUNG
  Der Rechner zeigt einen QR-Code (Einmal-ID + kurzlebiger öffentlicher Schlüssel). Das angemeldete Handy scannt ihn
  und schickt dem Rechner die Schlüssel Ende-zu-Ende verschlüsselt (ECDH) über den Server. Der Server stellt dem Rechner
  nach der Bestätigung am Handy eine Sitzung aus, sieht aber nie Klartext-Schlüssel.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import threading
from typing import Annotated, Any, Literal

import segno
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from . import db, security

router = APIRouter(prefix="/api")
D: dict[str, Any] = {}          # von main.py übergeben: COOKIE, lookup_session, issue_session, rate, client_ip
LINK_TTL_MS = 120_000           # Lebensdauer eines QR-Codes
CLAIM_GRACE_MS = 60_000         # nach Bestätigung bleibt noch kurz Zeit zum Abholen
HEX32 = re.compile(r"^[a-f0-9]{32}$")
B64URL_PUB = r"^[A-Za-z0-9_-]{87}$"          # 65 Byte (unkomprimierter P-256-Punkt) als base64url
_lock = threading.Lock()
_ready = False
_DUMMY = hashlib.sha256(b"vela-vault-dummy").hexdigest()


def ensure() -> None:
    """Spalten und Tabelle anlegen (idempotent; die Spalten legt normalerweise db.py an)."""
    global _ready
    if _ready:
        return
    with _lock:
        if _ready:
            return
        c = db.conn()
        cols = {r["name"] for r in c.execute("PRAGMA table_info(users)")}
        for name, decl in (("vault_kdf", "TEXT"), ("vault_blob", "TEXT"), ("vault_auth", "TEXT"), ("vault_at", "INTEGER")):
            if name not in cols:
                try:
                    c.execute(f"ALTER TABLE users ADD COLUMN {name} {decl}")
                except sqlite3.OperationalError:
                    pass
        c.execute(
            "CREATE TABLE IF NOT EXISTS link_requests ("
            " id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, desk_pub TEXT NOT NULL, ua TEXT NOT NULL, ip TEXT NOT NULL,"
            " created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',"
            " user_id TEXT, approve_ip TEXT, phone_pub TEXT, iv TEXT, ct TEXT)")
        _ready = True


def _auth_hash(auth_hex: str) -> str:
    return hashlib.sha256(("vela-vault-auth|" + auth_hex.lower()).encode()).hexdigest()


def _token(request: Request) -> str | None:
    return request.cookies.get(D["COOKIE"]) or request.cookies.get("vela_sid") or request.cookies.get("__Host-vela")


def full_user(request: Request) -> str:
    ensure()
    sess = D["lookup_session"](_token(request))
    if not sess or not sess["full"]:
        raise HTTPException(401, "Nicht angemeldet")
    return sess["user_id"]


UserId = Annotated[str, Depends(full_user)]


def _check_code(u, code: str) -> int:
    step = security.verify_totp(u["totp_secret"], code, u["totp_last_step"]) if u["totp_secret"] else None
    if step is None:
        raise HTTPException(400, "2FA-Code ungültig")
    return step


# ------------------------------------------------------------------ Modelle
class Kdf(BaseModel):
    alg: Literal["argon2id"]
    salt: str = Field(min_length=22, max_length=88, pattern=r"^[A-Za-z0-9+/=]+$")   # 16–64 Byte (Standard-base64)
    t: int = Field(ge=2, le=10)
    m: int = Field(ge=32768, le=262144)       # KiB
    p: int = Field(ge=1, le=4)


class KdfIn(BaseModel):
    username: str = Field(max_length=32)


class VaultLoginIn(BaseModel):
    username: str = Field(max_length=32)
    auth: str = Field(pattern=r"^[a-f0-9]{64}$")
    code: str = Field(default="", max_length=8)


class VaultPutIn(BaseModel):
    password: str = Field(max_length=256)
    code: str = Field(min_length=6, max_length=8)
    kdf: Kdf
    blob: str = Field(max_length=65536)
    auth: str = Field(pattern=r"^[a-f0-9]{64}$")


class VaultOffIn(BaseModel):
    password: str = Field(max_length=256)
    code: str = Field(min_length=6, max_length=8)


# ------------------------------------------------------------------ Schlüsseltresor
@router.post("/vault/kdf")
def vault_kdf(body: KdfIn, request: Request):
    """Welche Anmeldung gilt für diesen Nutzer? (öffentlich, damit der Browser das Passwort passend ableiten kann)"""
    ensure()
    D["rate"](f"vault-kdf:{D['client_ip'](request)}", 60, 600)
    u = db.one("SELECT vault_kdf FROM users WHERE username=?", body.username)
    if u and u["vault_kdf"]:
        return {"vault": True, "kdf": json.loads(u["vault_kdf"])}
    return {"vault": False}


@router.post("/vault/login")
def vault_login(body: VaultLoginIn, request: Request, response: Response):
    ensure()
    D["rate"](f"login-ip:{D['client_ip'](request)}", 30, 600)
    D["rate"](f"login-user:{body.username.lower()}", 10, 600)
    u = db.one("SELECT * FROM users WHERE username=?", body.username)
    expected = (u["vault_auth"] if u and u["vault_auth"] else None) or _DUMMY
    good = hmac.compare_digest(_auth_hash(body.auth), expected)
    if not u or not u["vault_auth"] or not good or not u["totp_enabled"]:
        raise HTTPException(401, "Anmeldedaten ungültig")
    if "blocked" in u.keys() and u["blocked"]:
        raise HTTPException(403, "Dieses Konto wurde gesperrt.")
    step = security.verify_totp(u["totp_secret"], body.code, u["totp_last_step"])
    if step is None:
        raise HTTPException(401, "Anmeldedaten ungültig")
    with db.tx() as c:
        c.execute("UPDATE users SET totp_last_step=? WHERE id=?", (step, u["id"]))
    D["issue_session"](response, u["id"], True)
    return {"ok": True}


@router.get("/vault/status")
def vault_status(uid: UserId):
    u = db.one("SELECT vault_blob, vault_at FROM users WHERE id=?", uid)
    return {"enabled": bool(u and u["vault_blob"]), "updated": u["vault_at"] if u else None}


@router.get("/vault")
def vault_get(uid: UserId):
    D["rate"](f"vault-get:{uid}", 20, 600)
    u = db.one("SELECT vault_kdf, vault_blob, key_version FROM users WHERE id=?", uid)
    if not u or not u["vault_blob"]:
        raise HTTPException(404, "Kein Schlüsseltresor eingerichtet")
    return {"kdf": json.loads(u["vault_kdf"]), "blob": u["vault_blob"], "key_version": u["key_version"]}


def _check_blob(blob: str) -> None:
    try:
        o = json.loads(blob)
        assert isinstance(o, dict) and o.get("v") == 1 and isinstance(o.get("iv"), str) and isinstance(o.get("ct"), str)
        assert 12 <= len(o["iv"]) <= 24 and len(o["ct"]) >= 32
    except (ValueError, AssertionError):
        raise HTTPException(400, "Tresor-Daten ungültig")


@router.put("/vault")
def vault_put(body: VaultPutIn, uid: UserId):
    """Tresor einrichten oder ersetzen. Verlangt Passwort und frischen 2FA-Code (wie „Konto löschen“)."""
    D["rate"](f"vault-put:{uid}", 5, 600)
    _check_blob(body.blob)
    u = db.one("SELECT * FROM users WHERE id=?", uid)
    if not security.verify_password(body.password, u["pw_hash"]):
        raise HTTPException(400, "Passwort falsch")
    step = _check_code(u, body.code)
    with db.tx() as c:
        c.execute("UPDATE users SET vault_kdf=?, vault_blob=?, vault_auth=?, vault_at=?, totp_last_step=? WHERE id=?",
                  (json.dumps(body.kdf.model_dump()), body.blob, _auth_hash(body.auth), db.now_ms(), step, uid))
    return {"ok": True}


@router.post("/vault/disable")
def vault_disable(body: VaultOffIn, uid: UserId):
    D["rate"](f"vault-put:{uid}", 5, 600)
    u = db.one("SELECT * FROM users WHERE id=?", uid)
    if not security.verify_password(body.password, u["pw_hash"]):
        raise HTTPException(400, "Passwort falsch")
    step = _check_code(u, body.code)
    with db.tx() as c:
        c.execute("UPDATE users SET vault_kdf=NULL, vault_blob=NULL, vault_auth=NULL, vault_at=NULL, totp_last_step=? WHERE id=?",
                  (step, uid))
    return {"ok": True}


# ------------------------------------------------------------------ QR-Verknüpfung
class LinkNewIn(BaseModel):
    pub: str = Field(pattern=B64URL_PUB)


class LinkClaimIn(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    secret: str = Field(min_length=20, max_length=64)


class LinkApproveIn(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")
    pub: str = Field(pattern=B64URL_PUB)
    iv: str = Field(pattern=r"^[A-Za-z0-9_-]{16}$")
    ct: str = Field(min_length=32, max_length=60000, pattern=r"^[A-Za-z0-9_-]+$")


class LinkIdIn(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")


def _secret_hash(secret: str) -> str:
    return hashlib.sha256(("vela-link-secret|" + secret).encode()).hexdigest()


@router.post("/link/new")
def link_new(body: LinkNewIn, request: Request):
    ensure()
    ip = D["client_ip"](request)
    D["rate"](f"link-new:{ip}", 12, 600)
    now = db.now_ms()
    rid, secret = secrets.token_hex(16), secrets.token_urlsafe(24)
    with db.tx() as c:
        c.execute("DELETE FROM link_requests WHERE expires_at < ?", (now - 600_000,))
        c.execute("INSERT INTO link_requests (id, secret_hash, desk_pub, ua, ip, created_at, expires_at) VALUES (?,?,?,?,?,?,?)",
                  (rid, _secret_hash(secret), body.pub, request.headers.get("user-agent", "")[:200], ip, now, now + LINK_TTL_MS))
    payload = f"vela-link:1:{rid}:{body.pub}"
    qr = segno.make(payload, error="m").svg_data_uri(scale=6, border=2, dark="#000000", light="#ffffff")
    return {"id": rid, "secret": secret, "payload": payload, "qr": qr, "expires_in": LINK_TTL_MS // 1000}


def _row(rid: str):
    return db.one("SELECT * FROM link_requests WHERE id=?", rid)


@router.get("/link/status")
def link_status(id: str, secret: str, request: Request):
    ensure()
    D["rate"](f"link-status:{D['client_ip'](request)}", 400, 600)
    r = _row(id) if HEX32.match(id) else None
    if not r or not hmac.compare_digest(_secret_hash(secret), r["secret_hash"]):
        raise HTTPException(404, "Unbekannt")
    if r["status"] == "pending" and r["expires_at"] < db.now_ms():
        return {"status": "expired"}
    return {"status": r["status"]}


@router.post("/link/claim")
def link_claim(body: LinkClaimIn, request: Request, response: Response):
    """Der Rechner holt die Sitzung und das verschlüsselte Schlüsselpaket ab (nur einmal)."""
    ensure()
    D["rate"](f"link-claim:{D['client_ip'](request)}", 30, 600)
    r = _row(body.id)
    if not r or not hmac.compare_digest(_secret_hash(body.secret), r["secret_hash"]):
        raise HTTPException(404, "Unbekannt")
    if r["status"] != "approved" or r["expires_at"] + CLAIM_GRACE_MS < db.now_ms():
        raise HTTPException(409, "Anfrage nicht (mehr) gültig")
    u = db.one("SELECT id, blocked FROM users WHERE id=?", r["user_id"]) if r["user_id"] else None
    if not u or ("blocked" in u.keys() and u["blocked"]):
        raise HTTPException(403, "Konto nicht verfügbar")
    with db.tx() as c:
        n = c.execute("UPDATE link_requests SET status='claimed', ct=NULL WHERE id=? AND status='approved'", (body.id,)).rowcount
    if n != 1:
        raise HTTPException(409, "Anfrage bereits abgeholt")
    D["issue_session"](response, u["id"], True)
    return {"user_id": u["id"], "phone_pub": r["phone_pub"], "iv": r["iv"], "ct": r["ct"]}


@router.get("/link/info")
def link_info(id: str, request: Request, uid: UserId):
    """Für den Bestätigungsdialog am Handy: Wer fragt an?"""
    D["rate"](f"link-info:{uid}", 30, 600)
    r = _row(id) if HEX32.match(id) else None
    if not r or r["status"] != "pending" or r["expires_at"] < db.now_ms():
        raise HTTPException(404, "Der QR-Code ist abgelaufen oder ungültig")
    return {"ua": r["ua"], "ip": r["ip"], "created_at": r["created_at"], "same_network": r["ip"] == D["client_ip"](request),
            "expires_in": max(0, (r["expires_at"] - db.now_ms()) // 1000), "pub": r["desk_pub"]}


@router.post("/link/approve")
def link_approve(body: LinkApproveIn, request: Request, uid: UserId):
    D["rate"](f"link-approve:{uid}", 6, 600)
    now = db.now_ms()
    with db.tx() as c:
        n = c.execute("UPDATE link_requests SET status='approved', user_id=?, approve_ip=?, phone_pub=?, iv=?, ct=? "
                      "WHERE id=? AND status='pending' AND expires_at>=?",
                      (uid, D["client_ip"](request), body.pub, body.iv, body.ct, body.id, now)).rowcount
    if n != 1:
        raise HTTPException(409, "Der QR-Code ist abgelaufen oder wurde schon verwendet")
    return {"ok": True}


@router.post("/link/deny")
def link_deny(body: LinkIdIn, uid: UserId):
    with db.tx() as c:
        c.execute("UPDATE link_requests SET status='denied' WHERE id=? AND status='pending'", (body.id,))
    return {"ok": True}


def init(app, deps: dict[str, Any]) -> None:
    """Von main.py aufgerufen (vor der SPA-Catch-all-Route). deps: COOKIE, lookup_session, issue_session, rate, client_ip."""
    D.update(deps)
    app.include_router(router)