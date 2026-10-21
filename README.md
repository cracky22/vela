# Vela – Ende-zu-Ende-verschlüsselter Messenger

Python/FastAPI-Backend + Web-Frontend (Material Design 3, Desktop & Mobil).
**Ohne Docker** – nur Python 3.10+ wird benötigt.

Die vollständige Feature-Spezifikation steht in [`SPEC.md`](SPEC.md).

## Schnellstart

```bash
# 1. In den Projektordner wechseln
cd vela

# 2. (empfohlen) virtuelle Umgebung anlegen
python -m venv .venv
#   Windows:      .venv\Scripts\activate
#   macOS/Linux:  source .venv/bin/activate

# 3. Abhängigkeiten installieren
pip install -r requirements.txt

# 4. Starten
python run.py
```

Danach im Browser öffnen:

- **Desktop:** `https://localhost:8443`
- **Smartphone (gleiches WLAN):** die beim Start angezeigte Adresse, z. B. `https://192.168.1.20:8443`

Beim ersten Aufruf warnt der Browser vor dem selbstsignierten Zertifikat → „Erweitert" → „Weiter zu …". Das ist bei lokalen Zertifikaten normal.

> **Warum HTTPS?** Die Verschlüsselung läuft im Browser über die Web Crypto API, und die gibt es nur über HTTPS (oder auf `localhost`). Deshalb erzeugt `run.py` beim ersten Start automatisch ein Zertifikat für `localhost` und deine LAN-IP.

### Zum Ausprobieren

1. Konto **A** am Desktop anlegen, Konto **B** auf dem Handy (oder in einem privaten Fenster).
2. Bei der Registrierung den **Wiederherstellungsschlüssel** speichern und die **Authenticator-App** einrichten (Aegis, 2FAS, Google/Microsoft Authenticator …).
3. A fügt B über den Nutzernamen hinzu, B nimmt im Tab „Anfragen" an → Schlüssel werden ausgetauscht.
4. Schreiben, Fotos/Dateien/Sprachnachrichten senden, Einmalansicht testen, wischen:
   - Chatliste: **links** = archivieren, **rechts** = markieren, **lange drücken** = Menü
   - Nachricht: **rechts** = reagieren, **links** = antworten, **doppeltippen** = ❤️, **lange drücken** = Menü

## Zertifikat ohne Browser-Warnung (optional)

Mit [mkcert](https://github.com/FiloSottile/mkcert):

```bash
mkcert -install
mkcert -cert-file data/certs/mkcert.pem -key-file data/certs/mkcert-key.pem localhost 127.0.0.1 192.168.1.20
python run.py --cert data/certs/mkcert.pem --key data/certs/mkcert-key.pem
```

Für Smartphones muss die mkcert-Root-CA zusätzlich auf dem Gerät installiert und vertraut werden (siehe mkcert-Doku). Im Internet-Betrieb gehört Vela hinter einen Reverse-Proxy mit echtem Zertifikat (z. B. Caddy oder nginx + Let's Encrypt); dann `python run.py --no-tls --host 127.0.0.1` und den Proxy auf Port 8443 zeigen lassen.

## Optionen

| Option / Variable | Standard | Bedeutung |
|---|---|---|
| `--host` | `0.0.0.0` | `127.0.0.1` = nur dieser Rechner |
| `--port` | `8443` | Port |
| `--cert`, `--key` | – | eigenes TLS-Zertifikat |
| `--no-tls` | aus | nur hinter einem TLS-Proxy oder für `http://localhost` |
| `VELA_MAX_UPLOAD_MB` | `100` | max. Dateigröße |
| `VELA_RETENTION_DAYS` | `30` | so lange liegen verschlüsselte Nachrichten/Dateien max. auf dem Server |
| `VELA_WORKER_THREADS` | `64` | Thread-Pool für DB, Hashing, Datei-I/O |
| `VELA_DATA_DIR` | `./data` | Datenbank, Uploads, Zertifikate |

Alle Daten liegen in `data/`. Zum Zurücksetzen den Server stoppen und den Ordner löschen.

## Projektstruktur

```
vela/
├── run.py                 Start (TLS-Zertifikat, uvicorn)
├── requirements.txt
├── SPEC.md                Feature-Spezifikation
├── app/
│   ├── main.py            FastAPI: Auth, 2FA, Kontakte, Nachrichten, Dateien, WebSocket, DSGVO
│   ├── security.py        scrypt, TOTP (RFC 6238), Tokens, Rate-Limiting
│   ├── db.py              SQLite (WAL, eine Verbindung pro Thread)
│   ├── ws.py              Echtzeit-Verbindungen
│   └── config.py          Einstellungen
├── static/
│   ├── index.html, css/app.css (Material Design 3)
│   └── js/
│       ├── crypto.js      E2E: RSA-OAEP, ECDSA, AES-256-GCM, HKDF, Sicherheitsnummern
│       ├── app.js         Chatliste, Chat, Medien, Echtzeit, Einstellungen
│       ├── auth.js        Registrierung, 2FA, Wiederherstellung, Schlüsselrotation
│       ├── gestures.js    Wischen, Long-Press, Doppeltippen
│       ├── media.js       Bildkompression, Sprachaufnahme
│       ├── whisper-worker.js / transcribe.js   On-Device-Transkription
│       └── store.js, api.js, ui.js, util.js, state.js
└── tests/e2e_test.py      Browser-Test mit zwei Nutzern (Playwright)
```

## Tests

```bash
pip install playwright && python -m playwright install chromium
python run.py            # in einem zweiten Terminal
python tests/e2e_test.py
```

Der Test registriert zwei Nutzer (Desktop + Pixel 7), tauscht Schlüssel aus, prüft Text, Tipp-Indikator, Lesebestätigung, Bildkompression, Datei, Einmalansicht (inkl. Löschung auf dem Server), Reaktion, Wischen zum Archivieren, identische Sicherheitsnummern, dass der Server **nur Ciphertext** speichert, und die Schlüsselwiederherstellung auf einem neuen Gerät (iPhone 13). Er verwendet eine frische Datenbank am besten mit gelöschtem `data/`-Ordner.

## Wichtig zu wissen

- Das ist eine **Referenzimplementierung** für lokale Nutzung, Tests und als Basis – kein auditiertes Produkt. Unterschiede zur Produktion (Forward Secrecy, Skalierung, native Apps) stehen in `SPEC.md`, Abschnitte 0, D2 und G.
- Die Transkription lädt beim ersten Benutzen ein Whisper-Modell (≈ 40–80 MB) von Hugging Face / jsDelivr. Das Audio selbst verlässt das Gerät nicht. Die Funktion ist standardmäßig aus.
- Geht der Wiederherstellungsschlüssel verloren und das letzte Gerät ebenfalls, sind alte Nachrichten nicht mehr lesbar. Das ist gewollt: Es gibt keine Hintertür.
