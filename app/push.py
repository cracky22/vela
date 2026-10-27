"""Web-Push: Benachrichtigungen auch bei geschlossener App (Android, Desktop; iOS nur als installierte Web-App).

Der Inhalt bleibt privat: Die Push-Nachricht enthält nur „Neue Nachricht von X“ / „… in Gruppe Y“ und ist
zusätzlich vom Server zum Gerät Ende-zu-Ende verschlüsselt (RFC 8291), der Push-Dienst von Google/Apple/
Mozilla kann sie nicht lesen. Benötigt das Paket `pywebpush` (pip install pywebpush); ohne dieses Paket
bleibt alles wie bisher (lokale Benachrichtigungen), nur Push ist aus.
"""
from __future__ import annotations

import base64
import ipaddress
import json
import logging
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Annotated, Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config, db

log = logging.getLogger("vela.push")
router = APIRouter(prefix="/api/push")
D: dict[str, Any] = {}                      # von main.py übergeben: COOKIE, lookup_session, rate
KEY_PATH = config.DATA_DIR / "vapid_private.pem"
MAX_SUBS_PER_USER = 10

# Nur echte Push-Dienste der Browserhersteller sind als Ziel erlaubt (sonst könnte jeder Nutzer den Server
# dazu bringen, Anfragen an beliebige interne Adressen zu schicken). Erweiterbar: VELA_PUSH_HOSTS="host,.suffix"
_BASE_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", ".push.services.mozilla.com", ".push.apple.com",
               ".notify.windows.com")

_lock = threading.Lock()
_ready = False
_public_key: str | None = None
_subject_seen: str | None = None
_pool = ThreadPoolExecutor(max_workers=6, thread_name_prefix="vela-push")


# ------------------------------------------------------------------ Einrichtung
def _hosts() -> tuple[str, ...]:
    extra = tuple(h.strip().lower() for h in os.environ.get("VELA_PUSH_HOSTS", "").split(",") if h.strip())
    return _BASE_HOSTS + extra


def _endpoint_ok(url: str) -> bool:
    try:
        u = urlparse(url)
        host = (u.hostname or "").lower()
        if u.scheme != "https" or not host or u.username or u.password or u.port not in (None, 443) or len(url) > 1000:
            return False
        try:
            ipaddress.ip_address(host)
            return False                    # keine IP-Adressen
        except ValueError:
            pass
        return any(host == h or (h.startswith(".") and host.endswith(h)) or (not h.startswith(".") and host.endswith("." + h))
                   for h in _hosts())
    except ValueError:
        return False


def _b64url(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


def available() -> bool:
    try:
        import pywebpush  # noqa: F401
        return True
    except ImportError:
        return False


def ensure() -> None:
    """Tabelle und VAPID-Schlüsselpaar anlegen (einmalig, threadsicher)."""
    global _ready, _public_key
    if _ready:
        return
    with _lock:
        if _ready:
            return
        db.conn().execute(
            "CREATE TABLE IF NOT EXISTS push_subs ("
            " endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,"
            " p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL)")
        db.conn().execute("CREATE INDEX IF NOT EXISTS idx_push_user ON push_subs(user_id)")
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        if KEY_PATH.exists():
            key = serialization.load_pem_private_key(KEY_PATH.read_bytes(), password=None)
        else:
            config.DATA_DIR.mkdir(parents=True, exist_ok=True)
            key = ec.generate_private_key(ec.SECP256R1())
            KEY_PATH.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                   serialization.NoEncryption()))
            try:
                os.chmod(KEY_PATH, 0o600)
            except OSError:
                pass
        _public_key = _b64url(key.public_key().public_bytes(serialization.Encoding.X962,
                                                            serialization.PublicFormat.UncompressedPoint))
        _ready = True


def public_key() -> str:
    ensure()
    return _public_key or ""


def _subject() -> str:
    """Kontakt für den Push-Dienst (VAPID „sub“): VELA_PUSH_SUBJECT oder https://<deine Domain>."""
    return os.environ.get("VELA_PUSH_SUBJECT") or _subject_seen or "mailto:admin@localhost"


# ------------------------------------------------------------------ Senden
def _drop(endpoint: str) -> None:
    with db.tx() as c:
        c.execute("DELETE FROM push_subs WHERE endpoint=?", (endpoint,))


def _send_user(uid: str, payload: dict) -> None:
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        return
    try:
        ensure()
        subs = db.all_("SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id=?", uid)
    except Exception:  # pragma: no cover
        log.exception("Push: Abos nicht lesbar")
        return
    data = json.dumps(payload, ensure_ascii=False)
    topic = re.sub(r"[^A-Za-z0-9_-]", "", str(payload.get("tag", "")))[:32]
    for s in subs:
        headers = {"Urgency": "high"}       # sofort zustellen, auch im Doze-Modus von Android
        if topic:
            headers["Topic"] = topic        # ältere, noch nicht zugestellte Pushs derselben Unterhaltung ersetzen
        try:
            webpush(subscription_info={"endpoint": s["endpoint"], "keys": {"p256dh": s["p256dh"], "auth": s["auth"]}},
                    data=data, vapid_private_key=str(KEY_PATH), vapid_claims={"sub": _subject()},
                    ttl=86400, headers=headers, timeout=10)
        except WebPushException as e:
            status = getattr(getattr(e, "response", None), "status_code", None)
            if status in (404, 410):        # Abo ist abgelaufen oder wurde widerrufen
                _drop(s["endpoint"])
            else:
                log.warning("Push fehlgeschlagen (%s): %s", status, str(e)[:200])
        except Exception as e:
            log.warning("Push fehlgeschlagen: %s", str(e)[:200])


def _submit(uid: str, payload: dict) -> None:
    _pool.submit(_send_user, uid, payload)


def _has_subs(uid: str) -> bool:
    try:
        ensure()
        return db.one("SELECT 1 FROM push_subs WHERE user_id=? LIMIT 1", uid) is not None
    except Exception:  # pragma: no cover
        return False


def notify_dm(sender_id: str, recipient_id: str, silent: bool = False) -> None:
    """Aufruf beim Senden einer 1:1-Nachricht (läuft im Anfrage-Thread, sendet im Hintergrund)."""
    if silent or sender_id == recipient_id or not _has_subs(recipient_id) or not available():
        return
    muted = db.one("SELECT muted FROM contacts WHERE user_id=? AND contact_id=?", recipient_id, sender_id)
    sender = db.one("SELECT username FROM users WHERE id=?", sender_id)
    if (muted and muted["muted"]) or not sender:
        return
    _submit(recipient_id, {"title": "Vela", "body": f"Neue Nachricht von {sender['username']}", "tag": sender_id})


def notify_group_msg(gid: str, sender_id: str, silent: bool = False) -> None:
    if silent or not available():
        return
    g = db.one("SELECT name FROM groups WHERE id=?", gid)
    if not g:
        return
    for r in db.all_("SELECT user_id, muted FROM group_members WHERE group_id=? AND user_id<>?", gid, sender_id):
        if not r["muted"] and _has_subs(r["user_id"]):
            _submit(r["user_id"], {"title": "Vela", "body": f"Neue Nachricht in „{g['name']}“", "tag": gid})


# ------------------------------------------------------------------ API
def user_session(request: Request) -> str:
    token = request.cookies.get(D["COOKIE"]) or request.cookies.get("vela_sid") or request.cookies.get("__Host-vela")
    sess = D["lookup_session"](token)
    if not sess or not sess["full"]:
        raise HTTPException(401, "Nicht angemeldet")
    return sess["user_id"]


UserId = Annotated[str, Depends(user_session)]


class Keys(BaseModel):
    p256dh: str = Field(min_length=20, max_length=200, pattern=r"^[A-Za-z0-9_\-=+/]+$")
    auth: str = Field(min_length=8, max_length=100, pattern=r"^[A-Za-z0-9_\-=+/]+$")


class SubIn(BaseModel):
    endpoint: str = Field(max_length=1000)
    keys: Keys


class UnsubIn(BaseModel):
    endpoint: str = Field(max_length=1000)


@router.get("/key")
def get_key(request: Request, uid: UserId):
    global _subject_seen
    host = request.headers.get("x-forwarded-host") or request.headers.get("host") or ""
    if host and "localhost" not in host and not re.match(r"^[\d.:]+$", host.split(",")[0].strip()):
        _subject_seen = "https://" + host.split(",")[0].strip()
    ok = available()
    return {"available": ok, "key": public_key() if ok else ""}


@router.post("/subscribe")
def subscribe(body: SubIn, uid: UserId):
    D["rate"](f"push-sub:{uid}", 30, 3600)
    if not available():
        raise HTTPException(503, "Push ist auf dem Server nicht eingerichtet (pip install pywebpush)")
    if not _endpoint_ok(body.endpoint):
        raise HTTPException(400, "Ungültiger Push-Dienst")
    ensure()
    with db.tx() as c:
        c.execute("INSERT INTO push_subs (endpoint, user_id, p256dh, auth, created_at) VALUES (?,?,?,?,?) "
                  "ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, "
                  "auth=excluded.auth, created_at=excluded.created_at",
                  (body.endpoint, uid, body.keys.p256dh, body.keys.auth, db.now_ms()))
        c.execute("DELETE FROM push_subs WHERE user_id=? AND endpoint NOT IN "
                  "(SELECT endpoint FROM push_subs WHERE user_id=? ORDER BY created_at DESC LIMIT ?)",
                  (uid, uid, MAX_SUBS_PER_USER))
    return {"ok": True}


@router.post("/unsubscribe")
def unsubscribe(body: UnsubIn, uid: UserId):
    ensure()
    with db.tx() as c:
        c.execute("DELETE FROM push_subs WHERE endpoint=? AND user_id=?", (body.endpoint, uid))
    return {"ok": True}


def init(app, deps: dict[str, Any]) -> None:
    """Von main.py aufgerufen (vor der SPA-Catch-all-Route). deps: COOKIE, lookup_session, rate."""
    D.update(deps)
    app.include_router(router)

    @app.get("/sw.js")
    def service_worker():
        # Aus dem Wurzelpfad ausgeliefert (hinter dem Proxy: /vela/sw.js), damit der Worker die ganze App abdeckt.
        return FileResponse(config.STATIC_DIR / "sw.js", media_type="text/javascript",
                            headers={"Cache-Control": "no-cache"})