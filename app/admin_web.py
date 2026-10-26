"""Web-Admin unter /admin: Nutzerverwaltung im laufenden Betrieb.

Läuft im Serverprozess und nutzt dessen Datenbankverbindungen – deshalb ist kein zweiter Prozess
nötig, der die (SMB-)Datenbank sperren könnte. Sperren/Löschen trennt außerdem sofort die
WebSocket-Verbindungen und benachrichtigt betroffene Clients.

Schutz:
* nur Konten mit is_admin (gesetzt per `python admin.py admins grant NAME`), volle 2FA-Sitzung
* Schreibaktionen verlangen zusätzlich einen frischen 2FA-Code (5 Minuten gültig, "Step-up")
* optional Netz-Beschränkung: VELA_ADMIN_NETS="192.168.0.0/16,10.0.0.0/8"
* jede Aktion landet im hash-verketteten Audit-Log
"""
from __future__ import annotations

import ipaddress
import os
import re
import time
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel, Field

from . import admin_ops as ops
from . import config, db, maintenance, security

HEX32 = re.compile(r"^[0-9a-f]{32}$")
STEPUP_SECONDS = 300
_stepup: dict[str, float] = {}   # admin_id -> monotonic-Zeitpunkt, bis zu dem Schreibaktionen erlaubt sind
D: dict[str, Any] = {}           # von main.py übergebene Funktionen (siehe init)
NETS: list = []

router = APIRouter(prefix="/api/admin")


# ------------------------------------------------------------------ Zugriffsschutz
def _check_net(request: Request) -> None:
    if not NETS:
        return
    try:
        ip = ipaddress.ip_address(D["client_ip"](request))
    except ValueError:
        raise HTTPException(403, "Kein Zugriff von dieser Adresse")
    if not any(ip in n for n in NETS):
        raise HTTPException(403, "Kein Zugriff von dieser Adresse")


def admin_user(request: Request) -> dict:
    _check_net(request)
    ops.ensure_extra()
    token = request.cookies.get(D["COOKIE"]) or request.cookies.get("vela_sid") or request.cookies.get("__Host-vela")
    sess = D["lookup_session"](token)
    if not sess:
        raise HTTPException(401, "Nicht angemeldet")
    if not sess["full"]:
        raise HTTPException(403, "Bitte zuerst die Zwei-Faktor-Authentifizierung einrichten")
    row = db.one("SELECT username, is_admin FROM users WHERE id=?", sess["user_id"])
    if not row or not row["is_admin"]:
        raise HTTPException(403, "Kein Admin-Zugriff")
    D["rate"](f"admin:{sess['user_id']}", 300, 60)
    return {"id": sess["user_id"], "name": row["username"], "ip": D["client_ip"](request)}


def stepped_admin(admin: Annotated[dict, Depends(admin_user)]) -> dict:
    if _stepup.get(admin["id"], 0) < time.monotonic():
        raise HTTPException(403, "stepup")   # Client fragt daraufhin den 2FA-Code ab und wiederholt
    return admin


Admin = Annotated[dict, Depends(admin_user)]
Stepped = Annotated[dict, Depends(stepped_admin)]


# ------------------------------------------------------------------ Modelle
class StepIn(BaseModel):
    code: str = Field(max_length=16)


class IdsIn(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=200)


class PurgeIn(IdsIn):
    cats: list[str] = Field(default_factory=list, max_length=8)
    scope: str = "all"
    received: bool = False
    older_than: int | None = Field(default=None, ge=1, le=3650)
    min_mb: float | None = Field(default=None, ge=0, le=100000)
    max_mb: float | None = Field(default=None, ge=0, le=100000)
    dry_run: bool = True


class MaintIn(BaseModel):
    on: bool
    message: str = Field(default="", max_length=200)


# ------------------------------------------------------------------ Hilfsfunktionen
def _item(u) -> dict:
    return {"id": u["id"], "username": u["username"], "email": u["email"], "state": ops.state_code(u),
            "is_admin": bool(u["is_admin"]), "created_at": u["created_at"], "last_seen": u["last_seen"],
            "online": D["manager"].is_online(u["id"])}


def _targets(ids: list[str]):
    """Gültige, eindeutige Nutzer zu den IDs + Liste unbekannter IDs."""
    seen, rows, missing = set(), [], []
    for i in ids:
        i = (i or "").lower()
        if i in seen:
            continue
        seen.add(i)
        u = db.one("SELECT * FROM users WHERE id=?", i) if HEX32.match(i) else None
        (rows if u else missing).append(u if u else i)
    return rows, missing


def _guard(u, admin: dict) -> str | None:
    if u["id"] == admin["id"]:
        return "Das eigene Konto kann hier nicht geändert werden"
    if u["is_admin"]:
        return "Admin-Konto – zuerst Admin-Recht entziehen (python admin.py admins revoke NAME)"
    return None


def _label(u) -> str:
    return f"{u['username']} ({u['id'][:8]})"


def _run(ids: list[str], admin: dict, fn, guard: bool = True) -> list[dict]:
    rows, missing = _targets(ids)
    out = [{"id": m, "username": "?", "ok": False, "msg": "Nutzer nicht gefunden"} for m in missing]
    for u in rows:
        why = _guard(u, admin) if guard else None
        if why:
            out.append({"id": u["id"], "username": u["username"], "ok": False, "msg": why})
            continue
        try:
            out.append({"id": u["id"], "username": u["username"], "ok": True, "msg": fn(u)})
        except Exception as e:  # einzelner Fehler stoppt nicht die übrigen
            out.append({"id": u["id"], "username": u["username"], "ok": False, "msg": f"Fehler: {e}"})
    return out


# ------------------------------------------------------------------ Endpunkte
@router.get("/me")
def me(admin: Admin):
    left = max(0, int(_stepup.get(admin["id"], 0) - time.monotonic()))
    return {"id": admin["id"], "name": admin["name"], "stepup_left": left, "maintenance": maintenance.get(),
            "retention_days": config.RETENTION_DAYS, "nets_restricted": bool(NETS)}


@router.post("/stepup")
def stepup(body: StepIn, admin: Admin):
    D["rate"](f"admin-stepup:{admin['id']}", 8, 300)
    u = db.one("SELECT totp_secret, totp_last_step FROM users WHERE id=?", admin["id"])
    step = security.verify_totp(u["totp_secret"], body.code, u["totp_last_step"]) if u and u["totp_secret"] else None
    if step is None:
        ops.audit(admin["id"], admin["name"], "stepup.failed", ip=admin["ip"])
        raise HTTPException(401, "2FA-Code ungültig")
    with db.tx() as c:
        c.execute("UPDATE users SET totp_last_step=? WHERE id=?", (step, admin["id"]))
    _stepup[admin["id"]] = time.monotonic() + STEPUP_SECONDS
    return {"ok": True, "stepup_left": STEPUP_SECONDS}


@router.get("/users")
def users(admin: Admin, q: str = "", state: str = "all", days: int = 30):
    kw: dict[str, Any] = {"search": q.strip()[:80] or None}
    if state == "blocked":
        kw["blocked"] = True
    elif state == "pending":
        kw["pending"] = True
    elif state == "active":
        kw["active"] = True
    elif state == "admin":
        kw["admins"] = True
    elif state == "inactive":
        kw["inactive_days"] = max(1, min(days, 3650))
    return {"users": [_item(u) for u in ops.list_users(**kw, limit=500)]}


@router.get("/users/{uid}")
def user_detail(uid: str, admin: Admin):
    info = ops.user_info(uid) if HEX32.match(uid) else None
    if not info:
        raise HTTPException(404, "Nutzer nicht gefunden")
    info["online"] = D["manager"].is_online(uid)
    return info


@router.post("/users/block")
def block(body: IdsIn, admin: Stepped):
    def one(u):
        n = ops.set_blocked(u["id"], True)
        D["manager"].close_user_from_thread(u["id"])     # offene Verbindungen sofort trennen
        ops.audit(admin["id"], admin["name"], "user.block", _label(u), f"{n} Sitzung(en) beendet", admin["ip"])
        return f"gesperrt, {n} Sitzung(en) beendet"
    return {"results": _run(body.ids, admin, one)}


@router.post("/users/unblock")
def unblock(body: IdsIn, admin: Stepped):
    def one(u):
        ops.set_blocked(u["id"], False)
        ops.audit(admin["id"], admin["name"], "user.unblock", _label(u), "", admin["ip"])
        return "entsperrt"
    return {"results": _run(body.ids, admin, one, guard=False)}


@router.post("/users/logout")
def logout(body: IdsIn, admin: Stepped):
    def one(u):
        n = ops.logout_user(u["id"])
        D["manager"].close_user_from_thread(u["id"])
        ops.audit(admin["id"], admin["name"], "user.logout", _label(u), f"{n} Sitzung(en)", admin["ip"])
        return f"{n} Sitzung(en) beendet"
    return {"results": _run(body.ids, admin, one)}


@router.post("/users/delete")
def delete(body: IdsIn, admin: Stepped):
    """Wie „Konto löschen“ in der App (inkl. Gruppen verlassen und Live-Benachrichtigung)."""
    def one(u):
        uid = u["id"]
        contacts = [r["contact_id"] for r in db.all_("SELECT contact_id FROM contacts WHERE user_id=?", uid)]
        for r in db.all_("SELECT group_id FROM group_members WHERE user_id=?", uid):
            D["leave_group"](r["group_id"], uid, uid, kind="left")
        with db.tx() as c:
            files = [r["id"] for r in c.execute(
                "SELECT f.id FROM files f LEFT JOIN messages m ON m.id=f.message_id "
                "WHERE f.owner_id=? OR m.recipient_id=? "
                "OR f.status_id IN (SELECT id FROM statuses WHERE user_id=?)", (uid, uid, uid))]
            c.executemany("DELETE FROM files WHERE id=?", [(i,) for i in files])
            c.execute("DELETE FROM users WHERE id=?", (uid,))
        ops.remove_files(files)
        (config.DATA_DIR / "avatars" / f"{uid}.jpg").unlink(missing_ok=True)
        for cid in contacts:
            D["manager"].notify(cid, {"type": "contact_update"})
        D["manager"].close_user_from_thread(uid)
        ops.audit(admin["id"], admin["name"], "user.delete", _label(u), f"{u['email']}, {len(files)} Datei(en)", admin["ip"])
        return f"gelöscht ({len(set(files))} Datei(en))"
    return {"results": _run(body.ids, admin, one)}


def _purge_args(body: PurgeIn) -> dict:
    cats = [c for c in body.cats if c in ops.CATS]
    if not cats:
        raise HTTPException(400, "Bitte mindestens eine Kategorie wählen")
    if body.scope not in ("all", "chats", "groups"):
        raise HTTPException(400, "Ungültiger Bereich")
    return {"cats": cats, "scope": body.scope, "received": body.received, "older_days": body.older_than,
            "min_mb": body.min_mb, "max_mb": body.max_mb}


@router.post("/users/purge-preview")
def purge_preview(body: PurgeIn, admin: Admin):
    args = _purge_args(body)
    rows, missing = _targets(body.ids)
    out = []
    for u in rows:
        sel = ops.collect(u["id"], **args)
        out.append({"id": u["id"], "username": u["username"], "count": sel["count"], "bytes": sel["bytes"]})
    return {"results": out}


@router.post("/users/purge")
def purge(body: PurgeIn, admin: Stepped):
    args = _purge_args(body)
    m = D["manager"]

    def one(u):
        sel = ops.collect(u["id"], **args)
        res = ops.purge_user(sel)
        for mid, snd, rcp in res["dm"]:                  # Clients sehen die Löschung sofort
            for target in {snd, rcp}:
                m.notify(target, {"type": "deleted", "id": mid, "at": res["now"]})
        for mid, gid in res["gm"]:
            D["notify_group"](gid, {"type": "deleted", "id": mid, "at": res["now"], "group": gid})
        if res["status"]:
            m.notify(u["id"], {"type": "status_update"})
            for r in db.all_("SELECT contact_id FROM contacts WHERE user_id=?", u["id"]):
                m.notify(r["contact_id"], {"type": "status_update"})
        n = sum(sel["count"].values())
        ops.audit(admin["id"], admin["name"], "user.purge", _label(u),
                  f"{','.join(args['cats'])} scope={args['scope']} received={args['received']} "
                  f"older={args['older_days']} -> {n} Einträge, {res['files']} Datei(en)", admin["ip"])
        return f"{n} Einträge gelöscht, {res['files']} Datei(en) entfernt"
    return {"results": _run(body.ids, admin, one, guard=False)}


@router.get("/maintenance")
def get_maintenance(admin: Admin):
    return maintenance.get()


@router.post("/maintenance")
def set_maintenance(body: MaintIn, admin: Stepped):
    m = maintenance.set_(body.on, body.message.strip())
    ops.audit(admin["id"], admin["name"], "maintenance.on" if body.on else "maintenance.off",
              "", m["message"], admin["ip"])
    return m


@router.get("/audit")
def get_audit(admin: Admin, limit: int = 100):
    return ops.audit_list(max(1, min(limit, 500)))


# ------------------------------------------------------------------ Einbindung
def init(app, deps: dict[str, Any]) -> None:
    """Von main.py aufgerufen (vor der SPA-Catch-all-Route). deps: COOKIE, lookup_session, rate,
    client_ip, manager, leave_group, notify_group."""
    D.update(deps)
    NETS.clear()
    for part in os.environ.get("VELA_ADMIN_NETS", "").split(","):
        if part.strip():
            NETS.append(ipaddress.ip_network(part.strip(), strict=False))
    app.include_router(router)

    @app.get("/admin")
    def admin_page(request: Request):
        _check_net(request)
        return FileResponse(config.STATIC_DIR / "admin.html", media_type="text/html")

    @app.get("/admin/")
    def admin_slash():
        # relative Weiterleitung, damit sie auch hinter einem Reverse-Proxy-Unterpfad (/vela) stimmt
        return RedirectResponse("../admin")