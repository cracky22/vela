#!/usr/bin/env python3
"""Vela starten – ohne Docker.

    pip install -r requirements.txt
    python run.py

Standardmäßig läuft der Server per HTTPS (TLS erzwungen) auf Port 8443. Beim ersten Start
wird ein selbstsigniertes Zertifikat für localhost und die IP-Adressen im lokalen Netz
erzeugt, damit auch Smartphones im selben WLAN zugreifen können. Für ein Zertifikat ohne
Browser-Warnung siehe README (mkcert) oder --cert/--key.
"""
from __future__ import annotations

import argparse
import datetime as dt
import ipaddress
import os
import socket
import sys
from pathlib import Path

BASE = Path(__file__).resolve().parent
MIN_PY = (3, 10)


def check_requirements() -> None:
    if sys.version_info < MIN_PY:
        sys.exit(f"Python {MIN_PY[0]}.{MIN_PY[1]}+ wird benötigt (gefunden: {sys.version.split()[0]})")
    missing = []
    for mod in ("fastapi", "uvicorn", "segno", "cryptography"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    try:
        import websockets  # noqa: F401
    except ImportError:
        try:
            import wsproto  # noqa: F401
        except ImportError:
            missing.append("websockets")
    if missing:
        sys.exit("Fehlende Pakete: " + ", ".join(missing) +
                 f"\nBitte installieren mit:\n  {sys.executable} -m pip install -r requirements.txt")


def local_ips() -> list[str]:
    ips: set[str] = {"127.0.0.1"}
    try:  # IP der Standardroute ermitteln (es werden keine Pakete gesendet)
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(info[4][0])
    except OSError:
        pass
    return sorted(ips)


def ensure_cert(cert_dir: Path, ips: list[str]) -> tuple[Path, Path]:
    """Erzeugt ein selbstsigniertes ECDSA-P-256-Zertifikat (gültig 397 Tage) mit SANs."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    cert_path, key_path = cert_dir / "cert.pem", cert_dir / "key.pem"
    if cert_path.exists() and key_path.exists():
        try:
            cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
            san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
            known = {str(i) for i in san.get_values_for_type(x509.IPAddress)}
            valid = cert.not_valid_after_utc > dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=7)
            if valid and set(ips) <= known:
                return cert_path, key_path
        except Exception:
            pass
        print("• Zertifikat wird erneuert (abgelaufen oder neue IP-Adresse)")

    cert_dir.mkdir(parents=True, exist_ok=True)
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Vela lokal"),
                      x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Vela Messenger (Entwicklung)")])
    sans: list[x509.GeneralName] = [x509.DNSName("localhost"), x509.DNSName(socket.gethostname())]
    sans += [x509.IPAddress(ipaddress.ip_address(ip)) for ip in ips]
    now = dt.datetime.now(dt.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - dt.timedelta(minutes=5)).not_valid_after(now + dt.timedelta(days=397))
        .add_extension(x509.SubjectAlternativeName(sans), critical=False)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([x509.oid.ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    os.chmod(key_path, 0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print(f"• Selbstsigniertes Zertifikat erstellt: {cert_path}")
    return cert_path, key_path


def main() -> None:
    p = argparse.ArgumentParser(description="Vela – E2E-verschlüsselter Messenger")
    p.add_argument("--host", default="0.0.0.0", help="Bind-Adresse (Standard: 0.0.0.0 = auch im LAN erreichbar)")
    p.add_argument("--port", type=int, default=8443)
    p.add_argument("--cert", help="Eigenes TLS-Zertifikat (PEM), z. B. von mkcert")
    p.add_argument("--key", help="Privater Schlüssel zum Zertifikat (PEM)")
    p.add_argument("--no-tls", action="store_true",
                   help="Nur für lokale Entwicklung hinter einem TLS-Reverse-Proxy. Ohne TLS funktioniert die "
                        "Verschlüsselung im Browser nur unter http://localhost.")
    p.add_argument("--workers-threads", type=int, help="Größe des Thread-Pools (Standard 64)")
    p.add_argument("--root-path", default=os.environ.get("VELA_ROOT_PATH", ""),
                   help="Unterpfad für Reverse Proxy (z. B. /vela)")
    p.add_argument("--setup-transcription", nargs="?", const="onnx-community/whisper-tiny", metavar="MODELL",
                   help="Transkriptions-Laufzeit und Whisper-Modell einmalig herunterladen und beenden "
                        "(Standard: onnx-community/whisper-tiny; alternativ onnx-community/whisper-base). "
                        "Geht auch bequem in der App unter Profil -> Sprachnachrichten.")
    args = p.parse_args()

    check_requirements()
    os.environ["VELA_TLS"] = "0" if args.no_tls else "1"
    if args.workers_threads:
        os.environ["VELA_WORKER_THREADS"] = str(args.workers_threads)
    if args.root_path:
        os.environ["VELA_ROOT_PATH"] = args.root_path
    sys.path.insert(0, str(BASE))

    from app import config  # noqa: E402  (nach dem Setzen der Umgebungsvariablen importieren)
    import uvicorn

    if args.setup_transcription:
        from app import models_dl
        print(f"Lade Transkription herunter: {args.setup_transcription}")
        models_dl.install_blocking(args.setup_transcription)
        return

    ips = local_ips()
    ssl_kwargs = {}
    scheme = "http" if args.no_tls else "https"
    if not args.no_tls:
        if args.cert and args.key:
            cert, key = Path(args.cert), Path(args.key)
        else:
            cert, key = ensure_cert(config.CERT_DIR, ips)
        ssl_kwargs = {"ssl_certfile": str(cert), "ssl_keyfile": str(key)}

    print("\n  Vela läuft:")
    print(f"    Desktop:  {scheme}://localhost:{args.port}")
    if args.host in ("0.0.0.0", "::"):
        for ip in ips:
            if ip != "127.0.0.1":
                print(f"    Handy:    {scheme}://{ip}:{args.port}   (gleiches WLAN)")
    if not args.no_tls and not args.cert:
        print("\n  Hinweis: Selbstsigniertes Zertifikat – der Browser zeigt beim ersten Aufruf eine Warnung.")
        print("  Für Zertifikate ohne Warnung: siehe README (mkcert).")
    print("  Beenden mit Strg+C\n")

    uvicorn.run("app.main:app", host=args.host, port=args.port, access_log=False, log_level="warning",
                proxy_headers=True, forwarded_allow_ips="*", root_path=args.root_path,
                server_header=False, ws_max_size=1_048_576, ws_ping_interval=25,
                **ssl_kwargs)


if __name__ == "__main__":
    main()
