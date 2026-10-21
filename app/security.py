"""Passwort-Hashing, TOTP (RFC 6238), Sitzungs-Tokens und Rate-Limiting."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import struct
import threading
import time
from collections import defaultdict, deque
from urllib.parse import quote

# ---------------------------------------------------------------- Passwörter
# scrypt (RFC 7914) mit OWASP-konformen Parametern: N=2^15, r=8, p=1 (~32 MiB RAM pro Hash)
_SCRYPT_N, _SCRYPT_R, _SCRYPT_P = 2**15, 8, 1


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(password.encode(), salt=salt, n=_SCRYPT_N, r=_SCRYPT_R, p=_SCRYPT_P,
                        maxmem=64 * 1024 * 1024, dklen=32)
    return f"scrypt${_SCRYPT_N}${_SCRYPT_R}${_SCRYPT_P}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        _, n, r, p, salt_hex, dk_hex = stored.split("$")
        dk = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt_hex), n=int(n), r=int(r),
                            p=int(p), maxmem=64 * 1024 * 1024, dklen=32)
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, TypeError):
        return False


# Dummy-Hash, damit die Antwortzeit bei unbekanntem Nutzernamen gleich bleibt
DUMMY_HASH = hash_password(secrets.token_hex(16))


# ---------------------------------------------------------------- TOTP
TOTP_PERIOD = 30
TOTP_DIGITS = 6


def new_totp_secret() -> str:
    return base64.b32encode(secrets.token_bytes(20)).decode().rstrip("=")


def _hotp(secret_b32: str, counter: int) -> str:
    key = base64.b32decode(secret_b32 + "=" * (-len(secret_b32) % 8))
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF) % (10**TOTP_DIGITS)
    return str(code).zfill(TOTP_DIGITS)


def totp_now(secret_b32: str, at: float | None = None) -> str:
    return _hotp(secret_b32, int((at or time.time()) // TOTP_PERIOD))


def verify_totp(secret_b32: str, code: str, last_step: int) -> int | None:
    """Prüft einen Code (±1 Zeitfenster gegen Uhrabweichung).

    Gibt den verwendeten Zeitschritt zurück oder None. Ein bereits benutzter Schritt
    (<= last_step) wird abgelehnt -> Schutz gegen Replay desselben Codes.
    """
    code = (code or "").strip().replace(" ", "")
    if len(code) != TOTP_DIGITS or not code.isdigit():
        return None
    current = int(time.time() // TOTP_PERIOD)
    for step in (current - 1, current, current + 1):
        if step <= last_step:
            continue
        if hmac.compare_digest(_hotp(secret_b32, step), code):
            return step
    return None


def otpauth_uri(secret_b32: str, username: str, issuer: str = "Vela") -> str:
    label = quote(f"{issuer}:{username}")
    return (f"otpauth://totp/{label}?secret={secret_b32}&issuer={quote(issuer)}"
            f"&algorithm=SHA1&digits={TOTP_DIGITS}&period={TOTP_PERIOD}")


# ---------------------------------------------------------------- Tokens
def new_token() -> str:
    return secrets.token_urlsafe(32)


def token_hash(token: str) -> str:
    """Sitzungstokens werden nur gehasht gespeichert: ein DB-Leak liefert keine gültigen Cookies."""
    return hashlib.sha256(token.encode()).hexdigest()


def recovery_hash(auth_token_hex: str) -> str:
    """Der Client leitet per HKDF aus dem Wiederherstellungsschlüssel (240 Bit Zufall) ein
    Auth-Token ab. Bei dieser Entropie genügt SHA-256; ein langsamer Hash ist nicht nötig."""
    return hashlib.sha256(("vela-recovery|" + auth_token_hex.lower()).encode()).hexdigest()


# ---------------------------------------------------------------- Rate-Limiting
class RateLimiter:
    """Einfacher Sliding-Window-Limiter im Speicher (threadsicher).

    Für Mehrinstanz-Betrieb durch Redis o. ä. ersetzen (siehe SPEC.md, Skalierung).
    """

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key: str, limit: int, window_s: float) -> bool:
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window_s:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            if len(self._hits) > 50_000:  # Speicher begrenzen
                for k in [k for k, v in self._hits.items() if not v][:10_000]:
                    del self._hits[k]
            return True


limiter = RateLimiter()
