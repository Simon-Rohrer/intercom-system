# Multiview – Installation auf dem Server

Dieses Paket enthält das komplette Projekt **mit allen aktuellen Einstellungen**:
ATEM-Verbindung, Quellen (inkl. Monarch-Stream), Layouts, Pegel-Fenster und Multiviews.
Sie stehen in `data/config.json` und werden beim Start automatisch geladen.

Nicht im Paket, weil sie zum Betriebssystem des Servers passen müssen. Das
Installationsskript holt beides automatisch:

- die Node-Pakete (`node_modules`)
- MediaMTX, der Empfänger für den Monarch-Stream (`bin/`), offiziell von GitHub, mit Prüfsumme

## Voraussetzungen

- **Node.js 18 oder neuer** – https://nodejs.org (LTS-Version)
- **Google Chrome** auf dem Rechner, an dem die Monitore hängen
- Der Server muss im selben Netz wie ATEM und Monarch sein (**192.168.0.x**)
- Internet beim ersten Installieren (für Node-Pakete und MediaMTX)

## Windows

1. ZIP entpacken, z. B. nach `C:\Multiview`. Am besten nicht auf den Desktop, und kein Pfad
   mit Sonderzeichen.
2. Node.js installieren, falls noch nicht vorhanden.
3. **`install-windows.bat`** doppelklicken.
4. **`firewall-windows.bat`** mit Rechtsklick → *Als Administrator ausführen*. Das gibt die
   Ports frei.
5. **`start-windows.bat`** doppelklicken. Das Fenster muss offen bleiben.
6. Im Browser `http://localhost:8090` öffnen, von anderen Rechnern `http://<Server-IP>:8090`.
7. Monitore: **`monitore-windows.bat`** öffnet Multiview 1 und 2 im Vollbild.
   Die Fensterpositionen stehen in der Datei: `0,0` = erster Monitor, `1920,0` = rechts daneben.
8. Optional: **`autostart-windows.bat`** startet Server und Monitore automatisch bei der
   Anmeldung.

## Linux (Ubuntu/Debian)

```bash
sudo apt install nodejs npm unzip     # falls Node.js fehlt (Version prüfen: node -v)
unzip atem-multiview.zip -d ~/
cd ~/atem-multiview
./install-linux.sh --autostart        # installiert und richtet den Dienst "multiview" ein
```

Ohne `--autostart` wird nur installiert. Starten dann mit `./start-linux.sh`.
Monitore öffnest du mit `./monitore-linux.sh`.
Dienst: `sudo systemctl status|restart|stop multiview`, Protokoll: `journalctl -u multiview -f`.

Firewall (falls `ufw` aktiv):

```bash
sudo ufw allow 8090/tcp && sudo ufw allow 1935/tcp && sudo ufw allow 8554/tcp \
  && sudo ufw allow 8890/udp && sudo ufw allow 8189/udp
```

## Ports

| Port | Wofür |
| --- | --- |
| 8090/TCP | Webseite und Monitore |
| 8189/UDP | WebRTC – Videobild an die Browser |
| 1935/TCP | RTMP-Empfang (nur falls ein Sender per RTMP schickt) |
| 8554/TCP | RTSP |
| 8890/UDP | SRT |

## Mitgenommene Einstellungen (Stand beim Packen)

**ATEM:** ATEM 2 M/E Constellation HD unter **192.168.0.31**. Tally kommt von M/E 1, die
Audiopegel über Fairlight.

**Monarch-Stream:** Der Server holt das Bild von **`rtsp://192.168.0.30:554/Stream1`** ab.
Am Monarch muss dafür **Encoder 2** so eingestellt sein und laufen:

| Feld | Wert |
| --- | --- |
| Mode | RTSP |
| Resolution | 1280 × 720 |
| Target Data Rate | 4000 kb/s |
| GOP structure | 25 |
| Profile | Baseline |
| Stream name / Port | Stream1 / 554 |

Encoder 1 (YouTube) bleibt davon unberührt. Der Monarch hängt am ATEM an **Aux 3** und
bekommt dort Programm 1. Die Einstellung muss im Monarch-Profil gespeichert sein, sonst ist
sie nach dem Laden des Profils weg.

**Multiviews und Layouts:** wie zuletzt im Editor eingerichtet. Ändern kannst du alles
jederzeit auf der Webseite.

## Was sich mit dem Umzug ändert

- **Companion:** Die Adressen zeigen jetzt auf den Server statt auf den Mac. In Companion bei
  *Generic HTTP* die IP auf die Server-IP ändern. Die fertigen Adressen stehen auf der Webseite
  unter *Einstellungen*.
- **Lesezeichen und Monitore** auf `http://<Server-IP>:8090` umstellen.
- Auf dem Mac den alten Server beenden, damit nicht zwei gleichzeitig laufen.

## Sichern und Übertragen

Alle Einstellungen stecken in **einer Datei: `data/config.json`**. Zum Sichern diese Datei
kopieren. Zum Übertragen auf einen anderen Rechner: Datei dort an dieselbe Stelle legen und
den Server neu starten.

## Hilfe bei Problemen

- **„ATEM getrennt“:** Ist die ATEM-IP unter *Einstellungen* richtig? Ist der Server im Netz
  192.168.0.x?
- **Monarch-Bild fehlt:** Läuft Encoder 2 am Monarch, und steht er auf RTSP? Unter *Eingänge →
  Netzwerk-Streams* zeigt der Status, ob der Stream-Empfang läuft.
- **Bild kommt nur am Server, nicht an anderen Rechnern:** Firewall-Port 8189/UDP freigeben.
- **Nach einem Update** zeigen offene Browser die Änderungen erst nach dem Neuladen (F5).
