# Vela – Feature-Spezifikation

**Ende-zu-Ende-verschlüsselte Messaging-Plattform · Version 1.0 · Stand: Oktober 2026**

Diese Spezifikation beschreibt jedes Feature im Format *Beschreibung → Technische Implementierung → User Journey → Sicherheitsaspekte → Performance → Akzeptanzkriterien*. Zu jedem Feature ist vermerkt, wie es in der beiliegenden **Referenzimplementierung** (Python/FastAPI + Web-Frontend, ohne Docker startbar) umgesetzt ist und was für den **Produktivbetrieb** zusätzlich nötig ist.

---

## 0. Grundsätze und ehrliche Einordnung

| Anforderung | Umsetzung / Einordnung |
|---|---|
| „Militärgrade Verschlüsselung" | Kein definierter Fachbegriff. Vela nutzt etablierte, öffentlich geprüfte Standards: **AES-256-GCM**, **RSA-OAEP (SHA-256) 2048–8192 Bit**, **ECDSA P-256**, **HKDF-SHA-256**, **TLS**. AES-256 und RSA ≥ 3072 Bit sind Teil der US-amerikanischen CNSA-Suite; CNSA verlangt für Signaturen allerdings P-384 statt P-256 (siehe Roadmap). In der Nutzerkommunikation verwenden wir den Begriff nicht. |
| „PKI" | Es gibt **keine zentrale Zertifizierungsstelle**. Öffentliche Schlüssel werden vom Server verteilt und beim ersten Kontakt im Client **angeheftet** (*Trust on First Use*). Echtheit wird durch Vergleich der **Sicherheitsnummer** bestätigt. Das ist das Vertrauensmodell von Signal und WhatsApp und schützt – anders als eine CA – auch gegen einen kompromittierten Server, sofern Nutzer die Nummer vergleichen. |
| „Keine Ausfallzeiten" | 100 % Verfügbarkeit ist nicht erreichbar. Produktionsziel: **SLO 99,95 %/Monat** (≈ 22 min), Zero-Downtime-Deployments, Redundanz über ≥ 2 Zonen. |
| „Echte Löschung" | Server-seitig werden Ciphertext und Dateien gelöscht, SQLite überschreibt gelöschte Seiten (`secure_delete`). Auf SSDs (Wear-Leveling) und in Backups ist physisches Überschreiben nicht garantierbar – deshalb **Crypto-Shredding**: Der Inhaltsschlüssel existiert nur in der (gelöschten) Nachricht und beim Empfänger. |
| „Keine Screenshots" | Im Browser technisch **nicht verhinderbar**. Native Apps: Android `FLAG_SECURE` verhindert sie; iOS kann sie nur erkennen, nicht verhindern. Vela setzt Abschreckung und Erschwerung ein (siehe B3). |
| Grenzen der E2E-Verschlüsselung | Schützt Inhalte auf dem Transportweg und auf dem Server. Schützt **nicht** vor einem kompromittierten Endgerät, Schadsoftware oder einem Empfänger, der Inhalte weitergibt. Der Server sieht **Metadaten**: wer mit wem, wann, Nachrichtengröße. |
| Forward Secrecy | Die Referenzimplementierung kapselt jeden Nachrichtenschlüssel mit dem langlebigen RSA-Schlüssel. Wird ein privater Schlüssel später kompromittiert, sind aufgezeichnete Nachrichten lesbar. **Produktion: Double-Ratchet / MLS** (siehe Roadmap). |

---

# A) Sicherheitsarchitektur

### A1 · Schlüsselerzeugung & Identität

**Beschreibung**: Jede Person besitzt ein eigenes Schlüsselpaar, das ausschließlich auf ihrem Gerät entsteht. Damit kann nur sie Nachrichten an sich entschlüsseln und nur sie im eigenen Namen signieren. *Für Nutzer: „Dein Gerät erzeugt ein digitales Schloss mit Schlüssel. Das Schloss (öffentlich) bekommt jeder, den Schlüssel (privat) behältst nur du."*

**Technische Implementierung**:
- Bei der Registrierung erzeugt der Client per **Web Crypto API** zwei Schlüsselpaare:
  - **RSA-OAEP, SHA-256, e = 65537**, Länge wählbar **2048 / 3072 / 4096 / 8192 Bit** → Schlüsselkapselung.
  - **ECDSA P-256 / SHA-256** → Signaturen. Getrennte Schlüssel für Verschlüsselung und Signatur (Schlüsseltrennung, kein Wiederverwenden desselben RSA-Schlüssels für beides).
- Private Schlüssel werden als **nicht exportierbare `CryptoKey`-Objekte** in IndexedDB gespeichert: Skripte können sie benutzen, aber nicht auslesen.
- Der Server erhält nur die öffentlichen Schlüssel (SPKI, Base64) und prüft sie: RSA-Länge = gewählte Länge, e = 65537, Kurve = P-256 (`app/main.py → validate_public_keys`).
- Schlüssellänge ist **pro Nutzer** konfigurierbar; Sender verschlüsseln immer mit der Länge des Empfängerschlüssels.

**User Journey**: Registrierung Schritt 1 → Auswahl der Schlüssellänge als Chips mit Erklärung („Entspricht der BSI-Empfehlung …", geschätzte Dauer) → Schritt 2 zeigt eine pulsierende Schlüssel-Animation, einen animierten Fortschrittsbalken und die vergangene Zeit.

**Sicherheitsaspekte**:
- *Risiko*: Schwache Schlüssel. *Mitigation*: Standard 4096 Bit; 2048 Bit nur mit Hinweis (NIST SP 800-57: bis 2030; BSI TR-02102-1: seit 2023 ≥ 3000 Bit empfohlen).
- *Risiko*: XSS liest Schlüssel aus. *Mitigation*: nicht exportierbare Keys, strikte CSP, kein `innerHTML` für Nutzerdaten. Restrisiko: XSS könnte Schlüssel *benutzen*, solange die Seite offen ist.
- *Risiko*: Gerätediebstahl. *Mitigation (Produktion)*: Geräte-Sperre / Passkey-gebundene Entsperrung; Option „Gerät bereinigen" beim Abmelden ist umgesetzt.

**Performance-Anforderungen**: Erzeugung RSA-4096 ≤ 10 s auf Mittelklasse-Smartphones (Primzahlsuche ist probabilistisch, Streuung hoch); RSA-8192 kann 20 s bis 3 min dauern – UI bleibt bedienbar (Web Crypto läuft asynchron). RSA-OAEP-Entschlüsselung: 4096 Bit ≈ wenige ms, 8192 Bit ≈ Faktor 6–8 langsamer; entschlüsselte Inhalte werden lokal gecacht, damit Chats sofort laden.

**Akzeptanzkriterien**:
- [x] Private Schlüssel verlassen das Gerät nie unverschlüsselt (Netzwerk-Mitschnitt enthält nur SPKI + verschlüsseltes Backup).
- [x] Server lehnt Schlüssel mit falscher Länge/Kurve ab.
- [x] Alle vier Längen funktionieren auf Chrome/Android, Safari/iOS, Desktop-Browsern.
- [x] Fortschrittsanzeige während der Erzeugung.

---

### A2 · Nachrichtenverschlüsselung (hybrid)

**Beschreibung**: Jede Nachricht, jedes Bild, jede Datei und jede Sprachnachricht wird auf dem Gerät des Absenders verschlüsselt und erst beim Empfänger entschlüsselt. Der Server sieht nur unlesbaren Datensalat. *Für Nutzer: „Jede Nachricht kommt in einen eigenen Tresor. Den Tresorschlüssel bekommt nur dein Gegenüber – in einem Umschlag, den nur er öffnen kann."*

**Technische Implementierung** (`static/js/crypto.js`):
1. Pro Nachricht zufälliger **AES-256-GCM**-Schlüssel und 96-Bit-IV.
2. Klartext = JSON-Payload (`text`, `image`, `file`, `voice`, `reaction`). **AAD** = `vela-msg-v1|<id>|<von>|<an>` bindet den Ciphertext an Nachrichten-ID, Absender und Empfänger (verhindert Umleiten/Vertauschen durch den Server).
3. Der AES-Schlüssel wird mit **RSA-OAEP** für den Empfänger **und** für den Absender selbst gekapselt (damit der eigene Verlauf auf anderen Geräten lesbar ist). Bei Einmalansicht nur für den Empfänger – der Server erzwingt das.
4. **ECDSA-Signatur** über `AAD | IV | Ciphertext`. Der Empfänger prüft mit dem **angehefteten** Schlüssel des Absenders, *bevor* er entschlüsselt.
5. Umschlag: `{v, iv, ct, k:{nutzerId: gekapselterSchlüssel}, sig, kv}` (`kv` = Schlüsselversion für Rotation).
6. Dateien: AES-256-GCM in **1-MiB-Blöcken**; Nonce = 64-Bit-Zufall ‖ 32-Bit-Blockzähler; AAD enthält Blockindex und „letzter Block"-Flag (STREAM-Konstruktion) → schützt vor Vertauschen, Duplizieren und Abschneiden von Blöcken. Datei-Schlüssel und Nonce stehen in der verschlüsselten Nachricht.

**User Journey**: Unsichtbar. Sichtbar sind das Schloss-Symbol „Ende-zu-Ende-verschlüsselt" im Chat-Kopf, der Hinweis am Chat-Anfang und die Nachrichteninfo (Verfahren, Signatur geprüft, Löschdatum).

**Sicherheitsaspekte**:
- *Manipulation durch Server*: GCM-Authentisierung + Signatur → Anzeige „Signatur ungültig".
- *Nonce-Wiederverwendung*: frischer Schlüssel pro Nachricht/Datei; Blockzähler eindeutig.
- *Fehlende Forward Secrecy*: siehe Abschnitt 0.
- *Metadaten*: Typ der Nachricht ist verschlüsselt; nur das Flag `silent` (Reaktion ohne Ungelesen-Zähler) ist für den Server sichtbar.

**Performance-Anforderungen**: Verschlüsseln einer Textnachricht < 20 ms (RSA ≤ 4096). Dateiverschlüsselung ≥ 100 MB/s auf Desktop (AES-GCM ist hardwarebeschleunigt). Entschlüsselte Payloads werden in IndexedDB gecacht.

**Akzeptanzkriterien**:
- [x] Datenbank und Upload-Verzeichnis enthalten keinen Klartext (automatisierter Test prüft Nachrichten und Dateien).
- [x] Veränderter Ciphertext oder fremde Signatur → Nachricht wird als nicht entschlüsselbar markiert, nie angezeigt.
- [x] Abgeschnittene Datei → Fehler „Datei beschädigt oder manipuliert".

---

### A3 · Public-Key-Austausch & Verifizierung (Key-Handshake)

**Beschreibung**: Bevor zwei Personen schreiben können, müssen sie ihre öffentlichen Schlüssel austauschen. Vela macht das automatisch, sobald eine Kontaktanfrage angenommen wird, und erlaubt eine optionale Prüfung per Sicherheitsnummer.

**Technische Implementierung**:
- Kontaktanfrage per Nutzername → Server legt `pending_out`/`pending_in` an. Öffentliche Schlüssel werden **erst nach beidseitiger Zustimmung** herausgegeben (`GET /api/contacts`). Nachrichten an Nicht-Kontakte lehnt der Server ab (403).
- Der Client **heftet** den ersten gesehenen Schlüssel an (IndexedDB `pins`) und verschlüsselt immer an den angehefteten Schlüssel, nicht an den, den der Server gerade liefert.
- Ändert sich der Schlüssel (Rotation, Neuinstallation – oder Angriff), erscheint ein Warnbanner; Senden ist blockiert, bis der Nutzer den neuen Schlüssel bestätigt. Alte Signaturschlüssel bleiben pro Version gespeichert, damit ältere Nachrichten prüfbar bleiben.
- **Sicherheitsnummer**: 60 Ziffern aus SHA-256(RSA-SPKI ‖ ECDSA-SPKI) beider Personen, nach Nutzer-ID sortiert → bei beiden identisch. Zusätzlich 128-Bit-Kurzfingerabdruck je Person.

**User Journey**: „Kontakt hinzufügen" → Nutzername → „Anfrage senden". Gegenüber sieht den Tab „Anfragen" (Badge) → „Annehmen" → Snackbar „Schlüssel ausgetauscht … [Prüfen]". Über das Schild-Symbol öffnet sich die Sicherheitsnummer mit Erklärung; nach persönlichem Vergleich „Als verifiziert markieren" → grünes Verifiziert-Abzeichen.

**Sicherheitsaspekte**: Ein bösartiger Server könnte beim *ersten* Kontakt einen falschen Schlüssel ausliefern (inhärent bei TOFU) – genau das deckt der Sicherheitsnummern-Vergleich auf. Spätere Austausche werden immer bemerkt.

**Performance-Anforderungen**: Annahme → Schlüssel beim Gegenüber verfügbar < 1 s (WebSocket-Benachrichtigung).

**Akzeptanzkriterien**:
- [x] Ohne angenommene Anfrage keine Schlüssel und keine Nachrichten.
- [x] Sicherheitsnummer bei beiden Personen identisch (automatisierter Test).
- [x] Schlüsseländerung → Warnung + Sendesperre bis zur Bestätigung.

---

### A4 · Wiederherstellungsschlüssel

**Beschreibung**: Ein zufälliger Schlüssel, den die Person bei der Registrierung herunterlädt. Er stellt das Konto bei verlorenem Passwort oder 2FA-Gerät wieder her und entsperrt die privaten Schlüssel auf einem neuen Gerät. *Für Nutzer: „Der Ersatzschlüssel für deinen Tresor – Vela hat keine Kopie."*

**Technische Implementierung**:
- **240 Bit** aus `crypto.getRandomValues`, dargestellt als 48 Zeichen Base32 in 12 Gruppen (`XXXX-XXXX-…`). Eingabe tolerant (Groß/Klein, Leerzeichen, 0↔O, 1↔I, 8↔B).
- **HKDF-SHA-256** leitet zwei unabhängige Werte ab: `info="backup"` → AES-256-GCM-Schlüssel für das **Schlüssel-Backup**; `info="auth"` → 256-Bit-Auth-Token. Der Server speichert nur `SHA-256(Auth-Token)` und das verschlüsselte Backup (AAD = Nutzername). Aus dem Auth-Wert lässt sich der Backup-Schlüssel nicht berechnen.
- **Konto-Wiederherstellung** (`POST /api/auth/recover`): Auth-Token + neues Passwort → alle Sitzungen werden beendet, 2FA wird neu eingerichtet, Backup wird zurückgegeben und lokal entschlüsselt.
- **Neues Gerät**: Anmeldung mit Passwort + 2FA → Eingabe des Wiederherstellungsschlüssels → lokale Entschlüsselung des Backups.
- **Verlust des Wiederherstellungsschlüssels**: „Neue Schlüssel erzeugen" (erfordert 2FA-Code) → neues Schlüsselpaar, neuer Wiederherstellungsschlüssel, Kontakte erhalten Schlüsseländerungs-Warnung; alte Nachrichten sind auf neuen Geräten nicht mehr lesbar (bewusst so – keine Hintertür).

**User Journey**: Registrierung Schritt 3: Schlüssel in großer Monospace-Darstellung → „Als Datei speichern" (.txt mit Anleitung) / „Kopieren" → Warnhinweis → Checkbox „Ich habe den Schlüssel sicher gespeichert" schaltet „Weiter" frei.

**Sicherheitsaspekte**: Wer Wiederherstellungsschlüssel **und** Nutzernamen hat, kann das Konto übernehmen → Hinweis, ihn offline/Passwort-Manager aufzubewahren. Rate-Limits (5 Versuche/h pro Nutzer, 10/h pro IP). 240 Bit Entropie machen Raten aussichtslos.

**Performance-Anforderungen**: Ableitung + Entschlüsselung < 200 ms.

**Akzeptanzkriterien**:
- [x] Download als Datei bei der Registrierung, Weiter erst nach Bestätigung.
- [x] Neues Gerät kann mit dem Schlüssel alte Nachrichten lesen (automatisierter Test mit iPhone-Emulation).
- [x] Falscher Schlüssel → verständliche Fehlermeldung, kein Datenverlust.

---

### A5 · Zwei-Faktor-Authentifizierung (Authenticator-App)

**Beschreibung**: Zusätzlich zum Passwort ist ein 6-stelliger Code aus einer Authenticator-App nötig (Aegis, 2FAS, Google/Microsoft Authenticator, iOS-Passwörter …). 2FA ist **verpflichtend**.

**Technische Implementierung**: TOTP nach **RFC 6238** (HMAC-SHA-1, 6 Ziffern, 30 s – das von allen gängigen Apps unterstützte Profil), 160-Bit-Secret, QR-Code (`otpauth://`-URI, serverseitig als SVG mit `segno` erzeugt), ±1 Zeitfenster gegen Uhrabweichung, **Replay-Schutz** (jeder Zeitschritt nur einmal gültig). Konto ist erst nach bestätigtem Code aktiv; unbestätigte Registrierungen werden nach 24 h gelöscht. Erneute 2FA-Abfrage für sensible Aktionen (Schlüsselrotation, Kontolöschung).

**User Journey**: Schritt 4: QR-Code scannen (oder Schlüssel manuell / „In App öffnen" auf dem Handy) → Code eingeben → „Bestätigen & loslegen". Anmeldung: Nutzername, Passwort, Code in einem Formular (keine Information, welcher Teil falsch war).

**Sicherheitsaspekte**: Passwort-Hashing mit **scrypt** (N = 2¹⁵, r = 8, p = 1), konstante Antwortzeit bei unbekannten Nutzern (Dummy-Hash), Rate-Limits (10 Versuche/10 min pro Nutzer, 30 pro IP). TOTP schützt nicht gegen Echtzeit-Phishing → *Produktion*: zusätzlich **Passkeys (WebAuthn)**. TOTP-Secret liegt serverseitig im Klartext in der DB → *Produktion*: Verschlüsselung mit KMS-Schlüssel.

**Performance-Anforderungen**: Login-Antwort < 300 ms (scrypt ≈ 50–100 ms, im Thread-Pool).

**Akzeptanzkriterien**:
- [x] Anmeldung ohne gültigen Code unmöglich; derselbe Code ist kein zweites Mal gültig.
- [x] Funktioniert mit Authenticator-Apps auf iOS und Android (Standard-TOTP-Profil).

---

### A6 · TLS für alle Übertragungen

**Beschreibung**: Jede Verbindung (Seite, API, WebSocket) ist zusätzlich zur E2E-Verschlüsselung transportverschlüsselt.

**Technische Implementierung**: `run.py` startet uvicorn **standardmäßig mit TLS**; fehlt ein Zertifikat, wird ein ECDSA-P-256-Zertifikat für `localhost` und die LAN-IP(s) erzeugt (397 Tage). Eigene Zertifikate (z. B. mkcert, Let's Encrypt) per `--cert/--key`. Header: **HSTS**, CSP (nur `wss://`/`https://` auf eigenem Host), `Referrer-Policy: no-referrer`, `nosniff`, `frame-ancestors 'none'`, COOP/CORP. Cookies: `__Host-`-Präfix, `Secure`, `HttpOnly`, `SameSite=Strict`. Web Crypto funktioniert nur in sicheren Kontexten – ohne HTTPS startet die App nicht (außer auf `localhost`). `--no-tls` nur für den Betrieb hinter einem TLS-Reverse-Proxy.

**Produktion**: TLS 1.3 only an einem Reverse-Proxy/Load-Balancer (Caddy/nginx/Envoy), OCSP-Stapling, HSTS-Preload, Zertifikats-Automatisierung.

**Akzeptanzkriterien**:
- [x] Standardstart nur per HTTPS/WSS erreichbar, alle Sicherheits-Header gesetzt.

---

# B) Kernfeatures (Messaging & Media)

### B1 · Live-Typing

**Beschreibung**: Zwei Stufen: (1) **Tipp-Indikator** „schreibt …" (Standard an), (2) optional **Live-Typing**: Der Text erscheint beim Gegenüber schon während des Tippens als „Live"-Blase (Standard aus, da auch unfertige Sätze sichtbar werden).

**Technische Implementierung**: WebSocket-Ereignis `typing` (gedrosselt auf ≤ 1 je 350 ms, Stopp nach 5 s Inaktivität, beim Senden oder Verlassen). Die Live-Vorschau (letzte 280 Zeichen) wird **wie eine Nachricht E2E-verschlüsselt und signiert**, aber nie gespeichert. Der Server leitet sie nur weiter, wenn der Absender Live-Typing in seinen Einstellungen aktiviert hat (serverseitig erzwungen) und nur an angenommene Kontakte. Max. 15 Ereignisse/s pro Verbindung.

**User Journey**: Kopfzeile und Chatliste zeigen „schreibt …" (kursiv, Primärfarbe), im Chat erscheinen animierte Punkte bzw. die Live-Blase; verschwindet nach 6 s ohne Ereignis automatisch. Einstellungen → Privatsphäre: Schalter mit Erklärung.

**Sicherheitsaspekte**: Tipp-Ereignisse sind Metadaten (wann jemand tippt) → abschaltbar. Live-Text ist E2E-verschlüsselt.

**Performance-Anforderungen**: Ende-zu-Ende-Latenz Tastendruck → Anzeige ≤ 500 ms (Drosselung 350 ms + Netzwerk).

**Akzeptanzkriterien**:
- [x] Indikator erscheint beim Gegenüber (automatisierter Test), verschwindet zuverlässig.
- [x] Live-Text nur bei aktivierter Einstellung, nie im Klartext auf dem Server.

---

### B2 · Bilder versenden (automatische Kompression)

**Beschreibung**: Fotos werden vor dem Senden automatisch verkleinert, wenn sie zu groß sind, und immer von Metadaten befreit (GPS-Position, Kameradaten).

**Technische Implementierung** (`static/js/media.js`): Dekodieren mit `createImageBitmap` (EXIF-Ausrichtung wird berücksichtigt) → Canvas → JPEG. Über 1,5 MB oder > 2560 px längste Kante: Skalierung auf 2560 px, Qualität 0,82, schrittweise Reduktion bis ≤ 2,5 MB. Kleinere Bilder werden mit Qualität 0,9 neu kodiert (entfernt Metadaten). GIFs bleiben unverändert (Animation). Ein 24-px-Vorschaubild wird **verschlüsselt** in der Nachricht mitgeschickt (sofortige, unscharfe Vorschau). Bilder ≤ 10 MB werden beim Empfänger automatisch geladen.

**User Journey**: Büroklammer → „Foto" (oder Einfügen/Drag & Drop auf dem Desktop) → Upload-Karte mit Phasen „Komprimieren & Metadaten entfernen" → „Verschlüsseln" → „Hochladen … 64 % · 1,2 MB/s" → Bild erscheint; Snackbar „Foto komprimiert: 4,8 MB → 610 KB"; Hinweis „komprimiert · Metadaten entfernt".

**Sicherheitsaspekte**: Kompression findet vor der Verschlüsselung auf dem Gerät statt; der Server sieht nur die Ciphertext-Größe. SVG wird nicht als Bild behandelt (Skript-Risiko), sondern als Datei.

**Performance-Anforderungen**: Kompression eines 12-MP-Fotos < 1,5 s auf Mittelklasse-Smartphone.

**Akzeptanzkriterien**:
- [x] Großes Bild wird verkleinert (Test: 3000×2000 PNG, 840 KB → 51 KB), Metadaten entfernt.
- [x] Fortschritt für jede Phase sichtbar, Abbrechen möglich.

---

### B3 · Einmalansicht-Bilder

**Beschreibung**: Ein Foto, das der Empfänger genau einmal öffnen kann. Danach ist es gelöscht – auf dem Server und auf dem Gerät.

**Technische Implementierung**:
- Senden: Nachrichtenschlüssel nur für den Empfänger gekapselt (Absender behält keine Kopie, serverseitig erzwungen), kein Vorschaubild.
- Öffnen: Bestätigungsdialog → Entschlüsseln im Speicher → `POST /api/messages/{id}/viewed` löscht **sofort** Ciphertext (`envelope = NULL`) und Datei (Datenbankzeile + Datei auf dem Datenträger); übrig bleibt ein Hinweis „geöffnet" ohne Inhalt. Beim Schließen werden Blob-URL und Puffer freigegeben; Einmalinhalte werden nie im lokalen Cache gespeichert.
- **Screenshot-Erschwerung (Web)**: Wasserzeichen mit Nutzername + Zeit über dem Bild, Ausblenden bei Fokusverlust/Tab-Wechsel/`PrintScreen`, kein Kontextmenü, kein Drag & Drop, keine Speichern-Funktion. **Native Apps (Produktion)**: Android `FLAG_SECURE` (verhindert Screenshots und Bildschirmaufnahmen), iOS: Inhalt in sicherem Textfeld-Layer rendern + `userDidTakeScreenshotNotification` → Absender wird benachrichtigt.

**User Journey**: Büroklammer → „Einmalansicht-Foto". Empfänger sieht eine Blase mit „1"-Symbol „Einmalansicht – tippen zum Öffnen" → Dialog erklärt das Verhalten → Vollbild mit Hinweis „wird beim Schließen gelöscht" → danach „Einmalansicht · geöffnet" bei beiden.

**Sicherheitsaspekte**: Gegen Abfotografieren mit einer zweiten Kamera gibt es keinen Schutz – wird in der UI ehrlich kommuniziert.

**Akzeptanzkriterien**:
- [x] Nach dem Öffnen enthält die Datenbank weder Ciphertext noch Datei (automatisierter Test).
- [x] Absender kann den Inhalt nach dem Senden nicht mehr abrufen.

---

### B4 · Einmalansicht-Nachrichten

**Beschreibung**: Wie B3 für Text: Umschalter „1" im Eingabefeld.

**Technische Implementierung**: identisch zu B3 (Flag `view_once`), Anzeige im geschützten Vollbild-Viewer.

**User Journey**: „1" antippen → Feld zeigt „Einmalansicht-Nachricht" → Senden → beim Empfänger „tippen zum Öffnen" → Lesen → gelöscht.

**Akzeptanzkriterien**:
- [x] Inhalt nach einmaligem Lesen auf Server und Gerät gelöscht; beide Seiten sehen „geöffnet".

---

### B5 · Sprachnachrichten mit plattformübergreifender Transkription

**Beschreibung**: Sprachnachrichten aufnehmen, verschlüsselt senden, abspielen – und auf Wunsch in Text umwandeln, **auf dem Gerät**, damit die E2E-Verschlüsselung erhalten bleibt.

**Technische Implementierung**:
- Aufnahme: `MediaRecorder` (Chrome/Android: WebM/Opus, Safari/iOS: MP4/AAC), 32 kbit/s, Echo- und Rauschunterdrückung, Pegelanzeige, max. 5 min.
- Transkription: **Whisper** über **Transformers.js 4.3.1** (ONNX Runtime Web/WASM) in einem **Web Worker**: Audio → `decodeAudioData` → Mono 16 kHz → Whisper (`onnx-community/whisper-tiny` ≈ 40 MB oder `whisper-base` ≈ 80 MB, Sprache Deutsch/Englisch/automatisch).
- Bewusst **nicht** verwendet: die Web Speech API – in Chrome wird Audio dafür an Server des Browserherstellers gesendet, das widerspräche E2E und DSGVO.
- Das Modell (öffentliche Gewichte) wird einmalig von Hugging Face/jsDelivr geladen und im Browser-Cache gespeichert; dabei sehen diese Anbieter die IP-Adresse. Daher **Opt-in** mit Erklärung. *Produktion*: Modell selbst hosten.

**User Journey**: Mikrofon-Taste (wenn das Feld leer ist) → Aufnahmeleiste mit rotem Punkt, Zeit, Pegel, „Verwerfen" und „Senden". Empfänger: Play/Pause mit Fortschrittsbalken; bei aktivierter Transkription Symbol „Transkribieren" → einmaliger Modell-Download mit Prozentanzeige → „Wird auf deinem Gerät transkribiert …" → Text unter der Nachricht.

**Sicherheitsaspekte**: Audio verlässt das Gerät nur verschlüsselt. Mikrofonzugriff nur nach Browser-Berechtigung (`Permissions-Policy: microphone=(self)`).

**Performance-Anforderungen**: Whisper-tiny transkribiert auf aktuellen Smartphones etwa in Echtzeit bis mehrfacher Echtzeit; ältere Geräte langsamer – Fortschrittsanzeige statt fester Zusage.

**Plattform-Hinweis**: Ob ein Browser das Audioformat des anderen abspielen kann, hängt von der Browserversion ab. Die App prüft `canPlayType` und weist darauf hin; die Transkription funktioniert unabhängig davon, sofern der Browser das Format dekodieren kann. *Produktion*: einheitliches Aufnahmeformat in den nativen Apps (z. B. Opus in Ogg auf beiden Plattformen).

**Akzeptanzkriterien**:
- [x] Aufnahme, Versand, Wiedergabe mit Fortschritt; Transkription ohne Server-Beteiligung.
- [ ] Manuelle Abnahme auf echten iOS- und Android-Geräten (Mikrofon lässt sich nicht automatisiert testen).

---

### B6 · Dateiuploads

**Beschreibung**: Beliebige Dateitypen bis zu einem Größenlimit (Standard **100 MB**, `VELA_MAX_UPLOAD_MB`).

**Technische Implementierung**: Clientseitige Blockverschlüsselung (A2) → Upload als Rohdaten (`application/octet-stream`) per XHR mit echtem Fortschritt → Server streamt auf die Platte, bricht beim Überschreiten des Limits ab, speichert unter zufälliger ID (keine Dateinamen auf dem Server – der Name steht in der verschlüsselten Nachricht). Download nur für Absender und Empfänger, Streaming mit Fortschritt, `Cache-Control: no-store`. Nicht verknüpfte Uploads werden nach 24 h gelöscht.

**User Journey**: „Datei (max. 100 MB)" oder Drag & Drop → Upload-Karte (Name, Verschlüsseln, Hochladen mit Rate, Abbrechen) → Dateikarte mit Symbol, Name, Größe, Download-Taste mit Fortschritt.

**Sicherheitsaspekte**: Server kann Dateien nicht auf Schadsoftware prüfen (E2E) → Empfänger sieht Dateinamen und -größe, Dateien werden nie automatisch geöffnet.

**Performance-Anforderungen**: Upload-Durchsatz durch Netzwerk begrenzt; Server-Speicherbedarf konstant (Streaming). *Produktion*: Objektspeicher (S3-kompatibel) mit vorsignierten URLs, fortsetzbare Uploads (tus), Verschlüsselung im Worker mit Streams statt vollständig im Speicher.

**Akzeptanzkriterien**:
- [x] Datei kommt bitgenau an (automatisierter Test), Limit wird client- und serverseitig durchgesetzt.

---

### B7 · Foto-Download (Speichern im Gerät)

**Beschreibung**: Empfangene Fotos im Gerätespeicher/Fotos sichern.

**Technische Implementierung**: iOS: Web Share API mit Datei → „Bild sichern" (iOS fragt einmalig nach der Berechtigung, Fotos hinzuzufügen). Android/Desktop: Download über `<a download>` (Browser-Downloadordner, von der Galerie indiziert). *Native Apps*: Android `MediaStore` (ab Android 10 ohne Speicherberechtigung für eigene Dateien), iOS `PHPhotoLibrary` mit „nur hinzufügen"-Berechtigung (`NSPhotoLibraryAddUsageDescription`). Einmalansicht-Bilder können nicht gespeichert werden.

**User Journey**: Foto antippen → Vollbild → Speichern/Teilen-Symbol; alternativ Long-Press → „Foto speichern".

**Akzeptanzkriterien**:
- [x] Gespeichertes Foto ist das entschlüsselte Original ohne Metadaten.

---

### B8 · Reaktionen, Antworten, Löschen (Ergänzung)

Reaktionen (👍 ❤️ 😂 😮 😢 🙏) und Antworten sind E2E-verschlüsselte Nachrichten. „Für alle löschen" (nur Absender) löscht Ciphertext und Dateien auf dem Server; „Für mich ausblenden" wirkt lokal. Lesebestätigungen (✓ gesendet, ✓✓ gelesen) sind abschaltbar.

---

# C) User Experience (Mobile-First)

### C1 · Gesten

**Beschreibung**: Häufige Aktionen ohne Menüs, mit sofortigem visuellem und haptischem Feedback.

**Technische Implementierung** (`static/js/gestures.js`): Pointer Events (einheitlich für Touch, Stift, Maus); `touch-action: pan-y`, damit vertikales Scrollen nativ und flüssig bleibt. Richtungserkennung erst nach 10 px (horizontal muss deutlich überwiegen), Auslöseschwelle 33 % der Breite (max. 140 px) **oder** schnelle Wischbewegung (> 0,6 px/ms). Beim Überschreiten der Schwelle: Symbol vergrößert sich, kurze Vibration (Android). Gummiband-Effekt am Ende. Klick nach Geste wird unterdrückt.

| Ort | Geste | Aktion |
|---|---|---|
| Chatliste | Wischen nach **links** | **Archivieren** / aus Archiv holen (mit „Rückgängig") |
| Chatliste | Wischen nach **rechts** | **Markieren** (Chat wird hervorgehoben und oben angeheftet) |
| Chatliste | **Long-Press** / Rechtsklick | Kontextmenü: Markieren, Archivieren, Sicherheitsnummer, Löschen |
| Nachricht | Wischen nach **rechts** | **Reagieren** (Reaktionsleiste) |
| Nachricht | Wischen nach **links** | **Antworten** (Zitat im Eingabefeld) |
| Nachricht | **Doppeltippen** | ❤️ schnell reagieren (erneut = entfernen) |
| Nachricht | **Long-Press** / Rechtsklick | Bottom-Sheet: Reaktionsleiste, Antworten, Kopieren, Speichern, Info, Ausblenden, Für alle löschen |
| Chat | System-Zurückgeste (iOS-Randwischen, Android-Zurück) | Zurück zur Liste (über die History-API, daher ohne Konflikt mit der Systemgeste) |
| Desktop | Hover über Nachricht | Schnellaktionen (Reagieren, Antworten, Mehr) |
| Desktop | `Enter` / `Shift+Enter` / `Esc` / `Strg+K` | Senden / Zeilenumbruch / Chat schließen / Suche |

**Akzeptanzkriterien**:
- [x] Wischen zum Archivieren funktioniert mit Touch-Pointer-Events (automatisierter Test).
- [x] Vertikales Scrollen wird nie versehentlich als Wischgeste erkannt.
- [x] Jede Gesten-Aktion ist zusätzlich über ein Menü erreichbar (Barrierefreiheit).

### C2 · Material Design 3

**Technische Implementierung**: Eigene, abhängigkeitsfreie Umsetzung der M3-Tokens: vollständige Farbrollen (Primary/Secondary/Tertiary/Surface-Container-Stufen) für Hell und Dunkel, automatisch nach Systemeinstellung oder manuell; Formskala (4–28 px), Elevation, Bewegungskurven (*standard*/*emphasized*), State-Layer (8 %/12 %). Komponenten: Top-App-Bar, FAB, Filter-Chips, Listen, Outlined-Text-Fields mit schwebendem Label, Filled/Tonal/Text-Buttons, Dialoge, Bottom-Sheets, Menüs, Snackbar, Switches, Segmented Buttons, Stepper. Icons als Inline-SVG (Material Symbols) – **keine externen Schriften**, damit keine Anfragen an Drittserver entstehen. `prefers-reduced-motion` wird respektiert.

### C3 · Animierte Fortschrittsanzeigen

Eingesetzt bei: Schlüsselerzeugung (unbestimmt + Zeit), Verschlüsseln/Komprimieren, Upload (Prozent + Rate), Download/Entschlüsseln (Prozent), Laden von Chats (dünne Leiste oben), Modell-Download der Transkription (Prozent), Wiedergabe von Sprachnachrichten. Bestimmte Balken animieren weich (250 ms) und haben einen Glanzeffekt, unbestimmte laufen kontinuierlich. ARIA `role="progressbar"` mit `aria-valuenow`.

### C4 · Responsive Design

M3-Fensterklassen: **kompakt (< 840 px)** – eine Ansicht, Chat schiebt sich über die Liste, FAB; **erweitert (≥ 840 px)** – Liste (360 px, ab 1200 px 400 px) und Chat nebeneinander, Hover-Aktionen, Drag & Drop. `100dvh`, Safe-Area-Insets (Notch, Home-Indicator), `interactive-widget=resizes-content` (Tastatur verdeckt das Eingabefeld nicht), 16-px-Schrift in Eingabefeldern (kein Auto-Zoom auf iOS). Als PWA installierbar (Manifest, Icons).

**Akzeptanzkriterien**:
- [x] Automatisierte Tests mit Desktop 1280×800, Pixel 7 und iPhone 13.

---

# D) Backend-Architektur

### D1 · Nebenläufigkeit / Multithreading

**Beschreibung**: Viele Verbindungen gleichzeitig bedienen, ohne dass langsame Operationen andere blockieren.

**Technische Implementierung** (Referenz):
- **Asynchroner Event-Loop** (uvicorn/asyncio) für I/O-gebundene Arbeit: WebSockets, Datei-Streaming, Echtzeit-Weiterleitung.
- **Thread-Pool** (Standard 64 Threads, `VELA_WORKER_THREADS`) für blockierende Arbeit: Alle REST-Endpunkte sind synchrone Funktionen und laufen parallel im Pool; Passwort-Hashing (scrypt gibt den GIL frei), Datenbankzugriffe (eine SQLite-Verbindung pro Thread, WAL-Modus für parallele Leser), Datei-I/O.
- Benachrichtigungen aus Worker-Threads werden thread-sicher an den Event-Loop übergeben, ohne auf langsame Clients zu warten (`app/ws.py`).
- Die **Verschlüsselung** selbst läuft auf den Clients – der Server hat keine Krypto-Last pro Nachricht.

**Akzeptanzkriterien**:
- [x] Kein Endpunkt blockiert den Event-Loop; Uploads streamen.

### D2 · Skalierbarkeit (Millionen gleichzeitiger Nutzer)

Die Referenzimplementierung ist bewusst ein **einzelner Prozess** (SQLite, Verbindungsverwaltung im Speicher) – ideal für lokale Nutzung und Tests. Zielarchitektur für Produktion:

| Baustein | Referenz | Produktion |
|---|---|---|
| API | 1 uvicorn-Prozess | Zustandslose API-Instanzen hinter L7-Load-Balancer, horizontal skaliert |
| Echtzeit | In-Memory-Verbindungstabelle | Gateway-Knoten mit je ~100 k WebSockets, Pub/Sub (NATS/Redis Streams) zur Zustellung zwischen Knoten |
| Datenbank | SQLite (WAL) | PostgreSQL mit Partitionierung nach Nutzer-ID / Citus, Lesereplikate; oder ScyllaDB für Nachrichten-Queues |
| Dateien | Lokales Verzeichnis | S3-kompatibler Objektspeicher, vorsignierte URLs, CDN nur für Ciphertext |
| Rate-Limits | Im Speicher | Redis, global |
| Benachrichtigungen | Browser-Notifications | FCM/APNs mit inhaltsfreien Pushes |

Grobe Dimensionierung: 1 Mio. gleichzeitige Verbindungen ≈ 10–20 Gateway-Knoten; Nachrichten sind klein (Text ≈ 1–3 KB Ciphertext), daher ist die Speicherschicht der Engpass, nicht die CPU. Lasttests (k6/Locust) mit Zielwerten: p99-Zustellung < 300 ms bei 50 k Nachrichten/s.

### D3 · Datensicherheit & Datenminimierung

**Gespeichert**: Nutzername, E-Mail, Passwort-Hash, TOTP-Secret, öffentliche Schlüssel, verschlüsseltes Schlüssel-Backup, Hash des Wiederherstellungs-Auth-Werts, Kontaktbeziehungen, verschlüsselte Nachrichten und Dateien (mit Ablaufdatum), Sitzungen (nur als Hash).
**Nicht gespeichert**: Klartext, private Schlüssel, Dateinamen, IP-Adressen (Access-Log ist deaktiviert), Geräteinformationen.
**Speicherbegrenzung**: Ciphertext wird nach **30 Tagen** (`VELA_RETENTION_DAYS`) gelöscht, Einmalansichten sofort nach dem Öffnen, nicht verknüpfte Uploads nach 24 h, abgelaufene Sitzungen und unbestätigte Konten automatisch (Aufräum-Job alle 5 min).

---

# E) Account-Verwaltung

### E1 · Registrierung

**Beschreibung**: Nutzername + E-Mail + Passwort, geführt in 4 Schritten (Konto → Schlüssel → Sicherung → 2FA).

**Technische Implementierung**: Nutzername 3–32 Zeichen `[A-Za-z0-9_.]`, Groß-/Kleinschreibung egal, öffentlich auffindbar; E-Mail nicht öffentlich; Passwort ≥ 10 Zeichen. Konto wird erst nach Schlüsselerzeugung angelegt (öffentliche Schlüssel sind Teil der Registrierung) und erst nach 2FA-Bestätigung aktiv. Rate-Limit 10 Registrierungen/h pro IP. *Produktion*: E-Mail-Bestätigung per Link (die Referenz sendet keine E-Mails), Prüfung gegen kompromittierte Passwörter (k-Anonymität, HIBP).

**Akzeptanzkriterien**:
- [x] Vollständiger Ablauf automatisiert getestet (Desktop + Mobil).

### E2 · Public-Key-Exchange → siehe **A3**

### E3 · Wiederherstellungsschlüssel → siehe **A4**

### E4 · Betroffenenrechte (DSGVO)

| Recht | Umsetzung |
|---|---|
| Auskunft / Datenübertragbarkeit (Art. 15, 20) | Einstellungen → „Meine Daten exportieren" → JSON mit allen serverseitig gespeicherten Daten |
| Löschung (Art. 17) | „Konto löschen" (Passwort + 2FA) → Konto, Kontakte, Nachrichten, Dateien, Sitzungen sofort gelöscht |
| Datenminimierung, Speicherbegrenzung (Art. 5) | siehe D3 |
| Privacy by Default (Art. 25) | Live-Typing aus, Transkription aus, Benachrichtigungen ohne Inhalt, keine Drittanbieter-Ressourcen außer beim Opt-in-Modell-Download |
| Sicherheit der Verarbeitung (Art. 32) | E2E, TLS, scrypt, 2FA, Rate-Limits, Sicherheits-Header |

Für den Produktivbetrieb zusätzlich: Verarbeitungsverzeichnis, Datenschutzerklärung, AV-Verträge mit Hostern, Datenschutz-Folgenabschätzung (Art. 35 – bei einem Messenger mit großer Nutzerzahl erforderlich).

---

# F) Cross-Platform-Konsistenz

Die Referenz ist eine Web-App und läuft identisch auf iOS (Safari ≥ 16.4), Android (Chrome), Desktop (Chrome, Edge, Firefox, Safari). Alle Krypto-Operationen nutzen die standardisierte Web Crypto API, daher sind Umschläge zwischen allen Plattformen kompatibel. Native Apps (Produktion) müssen dasselbe Umschlagformat implementieren (Android: Tink/Conscrypt, iOS: CryptoKit + Security.framework für RSA-OAEP-SHA256).

# G) Roadmap (nach Priorität)

1. **Forward Secrecy & Post-Compromise Security**: Signal-Protokoll (X3DH/PQXDH + Double Ratchet) für 1:1, **MLS (RFC 9420)** für Gruppen. RSA bleibt dann optional für Identitätsschlüssel.
2. **Post-Quanten-Hybrid**: ML-KEM-768 (FIPS 203) zusätzlich zur klassischen Schlüsselkapselung.
3. Passkeys (WebAuthn) als zweiter Faktor/Passwortersatz; Mehrgeräte-Verknüpfung per QR-Code statt Wiederherstellungsschlüssel.
4. Gruppenchats, verschwindende Nachrichten mit Timer, Sealed Sender (Absender-Metadaten verbergen).
5. Native Apps mit `FLAG_SECURE`, Push über FCM/APNs, Hintergrundzustellung.
6. Konfigurierbares CNSA-Profil (ECDSA P-384, SHA-384, RSA ≥ 3072).
7. Unabhängiges Sicherheitsaudit und Bug-Bounty vor dem öffentlichen Start.
