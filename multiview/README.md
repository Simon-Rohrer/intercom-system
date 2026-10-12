# Multiview Builder für ATEM

Eigene Multiviews zusammenbauen und auf beliebig vielen Monitoren ausgeben – mit Tally und
Quellennamen vom ATEM und Steuerung über Companion.

```
 Kameras ──► SDI-Verteiler ──► ATEM ◄──── Netzwerk (Tally, Namen) ────┐
                    │                                                 │
                    └──► Capture-Karte (DeckLink) ──► Server ─────────┘
                                                        │
                                       Grafikkarte HDMI/DP ──► Monitore
```

Der ATEM überträgt **kein Video** über das Netzwerk. Die Bilder kommen über eine Capture-Karte
(z. B. DeckLink) oder einen USB-Grabber in den Server. Vom ATEM kommen nur Tally und Namen.

## Installation

Voraussetzung: [Node.js](https://nodejs.org) ab Version 18.

```bash
cd atem-multiview
npm install
npm start
```

Danach:

- **Editor:** `http://<server-ip>:8090/` – von jedem Rechner im Netzwerk aus bedienbar
- **Ausgabe:** `http://localhost:8090/output.html?id=1` – auf dem Server, ein Fenster pro Monitor

Ein anderer Port geht mit `PORT=9000 npm start`. Die Einstellungen liegen in `data/config.json`.

## Bedienung

Die Webseite hat vier Bereiche:

1. **Übersicht**: Alle Multiviews mit Live-Vorschau. **Vollbild** zeigt einen Multiview
   bildschirmfüllend (zurück mit Esc). **Monitor-Ansicht** öffnet ihn in einem eigenen Fenster,
   das du auf einen Monitor ziehen kannst. Hier wählst du auch das Layout pro Multiview.
2. **Eingänge**: Mit **Eingänge suchen** werden die Capture-Karten erkannt und live angezeigt.
   **Als Quelle hinzufügen** übernimmt einen Eingang. Danach in der Tabelle den
   **ATEM-Eingang** eintragen, darüber laufen Tally und Name.
   Der Typ **Testbild** zeigt Farbbalken, damit lässt sich alles ohne Hardware ausprobieren.
3. **Layouts**: Vorlage wählen (2×2, 3×3, 4×4, ATEM-Stil, 1+5, 1+7) oder frei zeichnen:
   - auf freier Fläche ziehen: neue Kachel
   - Kachel ziehen: verschieben, Ecke unten rechts: Größe ändern
   - Pfeiltasten: verschieben, ⇧ + Pfeiltasten: Größe, Entf: löschen
   - Kacheln können auch eine **Uhr** oder einen **Text** zeigen
   - **Pegel-Fenster (Audio)**: eine eigene Kachel mit beliebig vielen Pegeln. Für jeden Pegel
     wählst du die Quelle (Summe, ein ATEM-Eingang oder ein reiner Audioeingang wie XLR) und
     optional einen Namen. „+ Alle mit Ton“ legt alle Eingänge an, an denen gerade Ton anliegt.
     Anordnung nebeneinander oder untereinander, Balken oder LED-Segmente, Dicke (bis 800 %),
     Abstand, Namen und dB-Skala sind einstellbar. **„Ganzes Feld ausfüllen“** verteilt die Pegel
     über die komplette Kachel – die Balken werden so breit bzw. hoch wie möglich. Die Namen zeigen Tally (rot = Program, grün = Preview).
     Die Pegel kommen über das Netzwerk vom ATEM (Fairlight-Audio), gemessen vor dem Fader.
   - Optional kann eine Videokachel zusätzlich einen eigenen Pegel zeigen („Audiopegel in dieser
     Kachel“), mit Position, Dicke, Länge und Darstellung. Ist die Quelle ein **Ausgang** des ATEM
     (z. B. `10010` = Programm 1, `8001`… = Aux), zeigt dieser Pegel die **Summe**.
   - **ProPresenter (Folien / Hintergründe)**: aktuelle und nächste Folie als Bild (über ihrem
     Hintergrund, so wie sie auf der Leinwand aussehen), als Text oder beides. Alternativ
     „Hintergrund jetzt und nächster“: Der nächste Hintergrund kommt aus dem laufenden Lied
     oder, wenn dort keiner mehr folgt, aus dem nächsten Lied der Playlist. Am Liedende zeigt
     „nächste Folie“ den Anfang des nächsten Lieds.
   - **ProPresenter-Prediger (Folien steuern)**: alle Folien der laufenden Präsentation (Predigt
     oder Lied) nebeneinander wie in ProPresenter, mit Gruppen-Farben. Auf dem Monitor löst
     Antippen einer Folie sie in ProPresenter aus; darunter die Tasten **Zurück**, **Ausblenden**
     (danach **Einblenden**) und **Weiter**. Im Editor ist alles nur Vorschau.
   - **Prediger-Seite fürs iPad/iPhone:** `http://<server-ip>:8090/prediger.html` – dieselbe
     Ansicht ohne Layout, bildschirmfüllend, für Hoch- und Querformat. In Safari über
     *Teilen → „Zum Home-Bildschirm“* als App ablegen, dann öffnet sie ohne Safari-Leisten.
     Presenter-Clicker und Tastatur: Pfeil rechts / Bild↓ / Leertaste = Weiter, Pfeil links /
     Bild↑ = Zurück, „B“ = Aus-/Einblenden. Optionen: `?groesse=1.5`, `?ausblenden=alles`,
     `?tasten=aus`. Tipp: In den iOS-Einstellungen „Automatische Sperre“ auf „Nie“ stellen –
     ohne HTTPS darf die Seite das Display nicht selbst anlassen.
   - Die normale ProPresenter-Kachel kann dieselben drei Tasten einblenden („Steuer-Tasten“).
     „Ausblenden“ nimmt wahlweise nur die Folie weg oder Folie und Hintergrund.
   - Gesteuert wird nur über diese Befehle: Weiter, Zurück, Ausblenden, Einblenden und Folie wählen.
   - **ProPresenter-Playlist**: die ganze aktive Playlist mit den farbigen Abschnitten. Das
     laufende Lied ist rot, das nächste grün markiert, gespielte sind abgeblendet, optional mit
     Hintergrund-Vorschau. Die Liste scrollt automatisch mit.
   - Die ProPresenter-Verbindung (Adresse und Port) stellst du unter *Einstellungen* ein. Der
     Zugriff ist nur lesend: Es werden keine Adressen aufgerufen, die in ProPresenter etwas
     auslösen.
   - Hintergründe erkennt die Software an der Folien-Beschriftung, die ProPresenter liefert.
     Bei einer Folie mit Hintergrund-Aktion ist das der Name des Mediums, z. B. „illuminate-11“.
   - **Live-Bilder im Editor** zeigt die echten Bilder in den Kacheln
4. **Einstellungen**: IP-Adresse des ATEM und die fertigen Companion-Adressen.

Änderungen werden sofort gespeichert und erscheinen live auf den Monitoren.

> **Wichtig:** Live-Bilder von Capture-Karten gibt es nur in dem Browser, der auf dem Rechner mit
> der Karte läuft (über `http://localhost:8090`). Öffnest du die Seite von einem anderen Rechner,
> kannst du alles einstellen, siehst aber keine Kamerabilder.

## Ausgabe auf mehreren Monitoren

Pro Monitor ein Chrome-Fenster im Kiosk-Modus öffnen. Jedes Fenster braucht ein eigenes
`--user-data-dir`, sonst landen alle Fenster auf demselben Bildschirm.
`--window-position` ist die Position des Monitors im Desktop (bei 1920er-Monitoren nebeneinander
also `0,0`, `1920,0`, `3840,0` …).

**Windows** (z. B. als `start-multiview.bat` in den Autostart):

```bat
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --window-position=1920,0 --user-data-dir=C:\mv\out1 --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required http://localhost:8090/output.html?id=1
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --window-position=3840,0 --user-data-dir=C:\mv\out2 --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required http://localhost:8090/output.html?id=2
```

**Linux**:

```bash
google-chrome --kiosk --window-position=1920,0 --user-data-dir=/tmp/mv-out1 \
  --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required \
  "http://localhost:8090/output.html?id=1" &
```

`--use-fake-ui-for-media-stream` erlaubt den Zugriff auf die Capture-Karte ohne Rückfrage.
Ohne Kiosk-Modus wechselt ein Doppelklick ins Vollbild.

> Die Ausgabe-Seite muss auf dem Rechner laufen, in dem die Capture-Karte steckt. Den Editor
> kannst du von überall öffnen.

## Capture-Karten

- **Blackmagic DeckLink**: *Desktop Video* installieren. Die Eingänge erscheinen dann als
  Videogeräte, z. B. „DeckLink Quad (1)“ bis „(8)“. Das Eingangsformat stellst du in
  *Desktop Video Setup* fest auf das Format des ATEM ein (z. B. 1080p50).
- **USB-Grabber** (UVC, z. B. Elgato Cam Link, Magewell USB Capture): funktionieren direkt.
- Mit dem Knopf **„Geräte an diesem Rechner suchen“** im Tab *Quellen* siehst du die genauen
  Namen. Sobald eine Ausgabe-Seite auf dem Server läuft, meldet sie ihre Geräte automatisch an
  den Editor.

## Netzwerk-Streams (z. B. Matrox Monarch)

Streams aus dem Netzwerk empfängt [MediaMTX](https://github.com/bluenviron/mediamtx). Der Server
startet es automatisch, wenn es im Ordner `bin/` liegt:

- macOS / Linux: `bin/mediamtx`
- Windows: `bin\mediamtx.exe`

Download: Release-Seite von MediaMTX, die Datei für dein System nehmen
(`…_windows_amd64.zip`, `…_linux_amd64.tar.gz` oder `…_darwin_arm64.tar.gz`).

Auf der Seite **Eingänge** mit **+ Netzwerk-Stream** eine Quelle anlegen. Es gibt zwei Wege:

- **Der Sender schickt zum Server** (Adressfeld leer lassen): Im Sender die angezeigte Adresse
  eintragen, z. B. beim Monarch *Mode RTMP*, *Server URL* `rtmp://<server-ip>:1935/` und
  *Stream name* `stream1`.
- **Der Server holt den Stream ab**: Im Adressfeld `rtsp://…` oder `srt://…` eintragen.

Im Browser kommt das Bild per WebRTC an, mit etwa 1 Sekunde Verzögerung, auf jedem Rechner im
Netzwerk. Tipp für den Encoder: H.264-Profil **Baseline** und eine kurze GOP (z. B. 25).
WebRTC verträgt keine B-Frames.

Ports, die in der Firewall des Servers offen sein müssen:

| Port | Wofür |
| --- | --- |
| 8090/TCP | Webseite |
| 1935/TCP | RTMP-Empfang |
| 8554/TCP | RTSP |
| 8890/UDP | SRT |
| 8189/UDP | WebRTC-Video an die Browser |

## Companion

Im Modul **Generic HTTP** eine GET-Anfrage anlegen. Die fertigen Adressen stehen im Editor im
Tab *Ausgänge*. Ausgänge, Layouts, Kacheln und Quellen gehen per Nummer, Name oder ID:

| Aktion | URL |
| --- | --- |
| Ausgang 1 auf Layout 2 | `/api/output/1/layout/2` |
| Ausgang 1 auf Layout „Interview“ | `/api/output/1/layout/Interview` |
| Nächstes / vorheriges Layout | `/api/output/1/next`, `/api/output/1/prev` |
| Kachel 3 in Layout 1 auf Quelle 5 | `/api/layout/1/tile/3/source/5` |
| Status als JSON | `/api/state` |

## Grenzen

- Software-Multiview hat etwa 1–3 Frames Verzögerung. Zum Anschauen reicht das, für
  Lippensynchronität eher nicht.
- Audio-Pegel werden nicht angezeigt.
- Die Zahl der Quellen hängt von CPU/GPU und der Capture-Karte ab.
