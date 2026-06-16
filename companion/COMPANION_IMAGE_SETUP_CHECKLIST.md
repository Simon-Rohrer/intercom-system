# Companion Image Setup Checklist (Kesher)

Diese Checkliste ist so aufgebaut, dass du in 2-5 Minuten sicher prüfen kannst,
ob die Bildanzeige auf dem StreamDeck korrekt eingerichtet ist.

## Zielbild

Wenn alles korrekt ist, gilt:
- `bridge_connected = 1`
- `bridge_bound = 1`
- `image_connected = 1`
- `image_stored_images` ist nach Verbindungsaufbau deutlich > 1 (typisch nahe 15)
- `image_last_message_at` ist aktuell

---

## 1. Modul-Stand wirklich aktualisieren

1. Im Modul-Repo bauen:
   - `npm run build`
2. Falls du das Paket in Companion importierst:
   - `npm run package`
3. In Companion die Instanz deaktivieren und wieder aktivieren.

Warum: Ein Build alleine reicht nicht immer, wenn Companion noch ein älteres Paket geladen hat.

---

## 2. Backend neu starten

1. Kesher-Backend neu starten.
2. Prüfen, dass neue Endpunkte erreichbar sind:
   - `/api/debug/button-image-preview`
   - `/api/debug/button-image?state=TALK&label=TALK&channel=debug`

Warum: Der Initial-Snapshot (Bilder direkt beim Verbinden) kommt aus dem Backend.

---

## 3. Instanz-Konfiguration in Companion korrekt setzen

In der Kesher-Instanz:
1. `host` korrekt (IP/Host vom Backend)
2. `port` korrekt
3. `useTls` passend zum Backend
4. `companionSecret` exakt wie im Backend
5. Nur **ein** Ziel konfigurieren:
   - bevorzugt `roleId` setzen
   - `username` leer lassen
6. `pageNumberOverride = -1`

Warum: Doppelte oder falsche Ziel-Parameter führen zu Bound/Mapping-Fehlern.

---

## 4. Alte Buttons nicht weiterverwenden

1. In Companion alte testweise Buttons entfernen.
2. Presets öffnen, Kategorie:
   - **Kesher Dynamic Image (Ready)**
3. Presets `Image Slot 1` bis `Image Slot 15` auf ein 5x3-Grid ziehen.

Warum: Alte Buttons enthalten häufig veraltete Feedback-Optionen (falsches Index-Mapping).

---

## 5. Live-Diagnose ausführen

1. Aktion auslösen:
   - `Connection diagnostics reconnect`
2. Danach Variablen prüfen:
   - `bridge_connected`
   - `bridge_bound`
   - `image_connected`
   - `image_stored_images`
   - `image_last_message_at`

Interpretation:
- `image_connected=1`, aber `image_stored_images` bleibt 0 oder 1:
  - meist altes Modul geladen oder Backend nicht neu gestartet
- `bridge_connected=1`, aber `bridge_bound=0`:
  - `roleId`/`username` Ziel oder Binding passt nicht
- `image_connected=0`:
  - Netzwerk/TLS/Host/Port/Secret prüfen

---

## 6. Schnelltest außerhalb von Companion

Zum Ausschluss von Backend-Rendering-Problemen im Browser prüfen:

- `/api/debug/button-image-preview`

Wenn die vier States dort sichtbar sind, rendert das Backend korrekt.
Dann liegt der Fehler fast sicher in Companion-Setup/Mapping/Paketstand.

---

## 7. Wenn es noch nicht klappt (Daten für Debug senden)

Bitte genau diese 5 Werte schicken:
1. `bridge_connected`
2. `bridge_bound`
3. `image_connected`
4. `image_stored_images`
5. `image_last_message_at`

Und zusätzlich:
- Ein Screenshot der Instanz-Konfiguration
- Ein Screenshot eines Buttons mit angewendetem Preset aus
  **Kesher Dynamic Image (Ready)**

Damit kann die Ursache in der Regel in einem Durchlauf eindeutig eingegrenzt werden.
