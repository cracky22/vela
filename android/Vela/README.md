# Vela für Android

Native Android-App (Kotlin, Jetpack Compose, Material 3) für den Vela-Server unter
`https://cracky.ddns.net/vela`. Die App spricht dieselbe API und dasselbe Verschlüsselungsformat
wie der Web-Client (RSA-OAEP + ECDSA P-256 + AES-256-GCM), Nachrichten sind also zwischen Web und App austauschbar.

## Einrichten in Android Studio

1. **Android Studio** (aktuelle Version, JDK 17 ist enthalten) starten.
2. `File ▸ Open …` und den entpackten Ordner **`Vela`** (den mit `settings.gradle.kts`) wählen.
3. Warten, bis „Gradle Sync“ fertig ist (lädt Gradle 8.9 und die Bibliotheken – Internet nötig).
   Schlägt Android Studio ein *Android-Gradle-Plugin-Update* vor, kannst du es annehmen.
4. Handy anschließen (Entwickleroptionen ▸ USB-Debugging) oder einen Emulator (API 26+) anlegen.
5. Oben das Gerät wählen und auf ▶ **Run** klicken.

Fertige APK: `Build ▸ Build Bundle(s)/APK(s) ▸ Build APK(s)` → `app/build/outputs/apk/debug/app-debug.apk`.

## Hinweise

* Minimum Android 8.0 (API 26). Server-Adresse steht in `data/LocalStore.kt`/`net/Api.kt` (`DEFAULT_SERVER`) und lässt sich im Login-Dialog ändern.
* Der private Schlüssel wird nur durch einen Android-Keystore-Schlüssel geschützt auf dem Gerät abgelegt.
* Anmeldung: Passwort + 6-stelliger 2FA-Code. Ist der Schlüsseltresor aktiv, wird er automatisch mit dem Passwort entsperrt;
  sonst mit dem Wiederherstellungsschlüssel.
* Benachrichtigungen ohne Google-Dienste: ein Vordergrunddienst hält die WebSocket-Verbindung offen
  (Einstellungen ▸ „Im Hintergrund verbunden bleiben“). Bei aggressiver Akku-Optimierung die App ausnehmen.

## Neu in dieser Version

* **Einmalansicht** (Foto und Text) senden und empfangen – Schalter „1“ neben dem Eingabefeld. Die Ansicht ist gegen Screenshots gesperrt.
* **Profilbild** und **Gruppenbild** ändern (Einstellungen ▸ Avatar antippen bzw. Gruppeninfo).
* **Transkription** von Sprachnachrichten (Untertitel-Symbol an der Sprachnachricht):
  * *Auf dem Gerät*: Offline-Spracherkennung von Android (ab Android 13, Offline-Sprachdaten nötig).
  * *Eigener Whisper-Server*: OpenAI-kompatibel (`POST /v1/audio/transcriptions`), in den Einstellungen eintragen.
* Material-Symbole (Google) statt Emojis für Wiedergabe, Aufnahme, Anhänge, Häkchen usw.

## Bedienung & Optik

* **Antworten aus der Benachrichtigung**: Konversations-Benachrichtigung mit Antwortfeld und „Als gelesen markieren“.
* **Animationen**: federnde Nachrichten, animierte Häkchen, Tipp-Punkte, Mikrofon↔Senden-Morph, Seitenwechsel, einklappende Kopfzeile.
* **Wischen nach rechts** auf einer Nachricht = Antworten.
* **Haptisches Feedback** (Einstellungen ▸ Bedienung abschaltbar).
* Optik im Stil von Material 3 Expressive (große Rundungen, kräftige Schriften, Chips, ausfahrender FAB).

## Medien, Reaktionen, Verlauf

* **Medien-Viewer** (Fotos und Videos eines Chats): wischen zum Blättern, Doppeltippen und Zwicken zum Zoomen, nach unten/oben ziehen zum Schließen, Teilen und Speichern. Videos laufen mit ExoPlayer.
* **Videos** werden beim Senden erkannt (MIME-Typ oder Endung); die Nachricht enthält Vorschaubild, Dauer und Größe und erscheint wie bei WhatsApp als Player. Im Web-Client bleibt es eine normale Datei.
* **Tapback**: Nachricht lange drücken → Reaktionsleiste (Daumen, Herz, … und „+“ für beliebige Emojis), darunter die Nachricht und die Aktionen. Auf die Reaktionen unter einer Nachricht tippen zeigt, wer womit reagiert hat.
* **Verlauf lokal speichern** (Einstellungen ▸ Verlauf auf diesem Gerät): verschlüsselt im App-Speicher, auf Wunsch alle Nachrichten und Anhänge laden.
* Textfarben folgen dem Theme (Hell/Dunkel), Nachrichtenblasen haben eigene Kontrastfarben.
