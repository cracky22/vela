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
