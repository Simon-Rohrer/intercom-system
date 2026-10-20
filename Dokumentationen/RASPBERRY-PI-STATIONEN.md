# Raspberry-Pi-Stationen

Raspberry Pis laufen als feste Kesher-Kiosk-Stationen. Der Launcher startet Chromium automatisch, meldet die Station mit Name und Rolle an und sendet Heartbeats an den Server.

## Neue Station einrichten

1. Ubuntu Desktop LTS 64-bit oder Raspberry Pi OS Desktop installieren.
2. SSH und grafischen Autologin aktivieren.
3. Im Router feste DHCP-Reservierung setzen.
4. Auf dem Pi Basis-Pakete installieren:

```sh
sudo apt update && sudo apt install -y chromium-browser python3 alsa-utils pulseaudio-utils
```

IP prüfen:

```sh
hostname -I
```

## Einstellungen im Multiview (empfohlen)

Seit Launcher-Version 10 stehen die Einstellungen der Pis im Multiview unter
**Einstellungen → Raspberry Pis** (`https://192.168.0.21:8090/#/einstellungen/raspberry`, nur Admin):
Kesher-Adresse, Zertifikat, Wartezeiten und pro Station Name, Rolle, Ansicht, MAC-Adressen,
Audio-Geräte und Sparmodus. Der Launcher fragt beim Start und danach alle 15 Sekunden nach;
ändert sich etwas für seinen Pi, startet er den Browser mit den neuen Einstellungen neu.

Dafür steht in `/etc/kesher/raspberry-pis.json` auf dem Pi zusätzlich:

```json
"config_url": "https://192.168.0.21:8090/api/raspberry-pis/config"
```

So funktioniert es:

- Solange der Schalter **Hier verwalten** aus ist, nehmen die Pis weiter ihre Datei. Unter
  **Pis im Netz** erscheinen trotzdem alle Pis mit `config_url`; **Übernehmen** legt die
  Station mit den Werten aus ihrer Datei und allen ihren MAC-Adressen an. Danach einschalten.
- Eingeschaltet gilt der Multiview. In der Datei bleiben nur `config_url`,
  `allow_insecure_tls` (für die Verbindung zum Multiview) und ggf. `heartbeat_secret`
  maßgeblich – der Rest ist die Reserve, falls der Multiview beim Start nicht erreichbar ist.
- Die letzte Antwort des Multiview liegt auf dem Pi in `~/.cache/kesher-pi/managed-config.json`
  und wird genommen, wenn der Multiview beim Start nicht antwortet.
- Ein Pi bekommt nur seinen eigenen Eintrag (über MAC oder IP). Ein Pi ohne Eintrag startet
  bei eingeschaltetem Schalter nicht als Station und taucht unter „Pis im Netz“ auf.
- Prüfen auf dem Pi: `sudo -u <user> /opt/kesher-pi/kesher-pi-launcher.py --print-config`
  zeigt die wirksamen Einstellungen und woher sie kommen (`multiview`, `cache` oder `file`).

Fernsteuern: Im Dashboard **Raspberry fernsteuern** öffnet Kesher direkt im Reiter
*Raspberry* (`https://192.168.0.21:8443/?login=raspberry`), ohne automatische Anmeldung mit der
eigenen Rolle. Dort mit **Steuern** eine verbundene Station übernehmen.

## Aus- und einschalten aus JMS Control (Ruhemodus)

In JMS Control unter *Einstellungen → Raspberry Pis* hat jede Station die Knöpfe **Ausschalten** / **Einschalten** und **Neu starten**.

- **Ausschalten** ist ein Ruhemodus: Das Intercom auf dem Pi wird beendet und der Bildschirm geht aus, der Pi selbst bleibt an und im Netz. **Einschalten** weckt ihn wieder – nach etwa 15 Sekunden (so oft fragt der Pi seine Einstellungen ab) läuft das Intercom wieder. Der Ruhemodus ist eine Einstellung der Station: Startet der Pi neu oder war der Strom weg, bleibt er aus, bis er hier eingeschaltet wird.
- **Neu starten** startet den ganzen Pi neu (geht nur, solange er sich meldet). Der Befehl wird genau einmal ausgeführt und verfällt nach 2 Minuten.
- **Bewusst kein echtes Herunterfahren:** Ein heruntergefahrener Raspberry Pi lässt sich aus der Ferne nicht wieder einschalten (kein Wake-on-LAN), nur durch kurzes Trennen vom Strom. Für echtes Aus/An bräuchte es eine schaltbare Steckdose vor dem Netzteil.

Voraussetzung ist der aktuelle Launcher auf dem Pi (ab Version 12; `install.sh` richtet für „Neu starten“ auch die sudo-Regel `/etc/sudoers.d/kesher-pi-power` ein, die nur `systemctl poweroff` und `systemctl reboot` erlaubt). Den Bildschirm schaltet der Launcher über `wlr-randr` (labwc), sonst `wlopm` oder `vcgencmd`. Aktualisieren vom Server aus, ohne die Konfiguration auf dem Pi zu überschreiben:

```sh
cd ~/intercom-system/Kesher/deploy && tar -czf /tmp/kesher-raspberry-pi-deploy.tar.gz raspberry-pi && scp /tmp/kesher-raspberry-pi-deploy.tar.gz <user>@<pi-ip>:~
ssh <user>@<pi-ip> 'rm -rf raspberry-pi && tar -xzf kesher-raspberry-pi-deploy.tar.gz && cd raspberry-pi && sudo ./install.sh <user> && sudo reboot'
```

## Konfiguration in der Datei (ohne Multiview)

Auf dem Entwicklungsrechner diese Datei bearbeiten:

```text
Kesher/deploy/raspberry-pi/raspberry-pis.json
```

Beispiel:

```json
{
  "device_id": "kamera-2-pi",
  "ip_address": "192.168.178.191",
  "mac_addresses": ["b8:27:eb:00:00:01", "b8:27:eb:00:00:02"],
  "name": "Kamera-2",
  "role_id": "cam 2",
  "audio_input_match": "Headset",
  "audio_output_match": "Headset",
  "low_power_mode": true,
  "simple_view": false
}
```

Wichtig:

- Der Pi findet seinen Eintrag über `ip_address` oder `mac_addresses`. Mit MAC-Adressen (LAN und WLAN, `ip -br link`) ist die IP egal, die DHCP gerade vergibt; `ip_address` darf dann fehlen, `device_id` ist dann Pflicht. Ohne `mac_addresses` muss `ip_address` zur festen Pi-IP passen.
- `name` und `device_id` dürfen keine Leerzeichen enthalten.
- `role_id` ist die Rollen-ID aus Kesher Admin.
- `server_url` muss auf den Kesher-Server zeigen.
- `audio_runtime_wait_seconds` kann optional auf `0` bis wenige Sekunden gesetzt werden, wenn der Browser schnell starten soll und Audio-Geräte nicht beim Systemstart blockieren dürfen.
- `display_runtime_settle_seconds` steuert die kurze Wartezeit nach dem Start der Desktop-Sitzung. Auf Raspberry Pi OS mit Wayland/Xwayland verhindern etwa `8` Sekunden, dass Chromium während der Grafikinitialisierung hängen bleibt.

Auf aktuellem Raspberry Pi OS mit `labwc` installiert das Setup den Launcher als
Benutzer-Dienst und startet ihn aus `~/.config/labwc/autostart`. Dadurch startet
Chromium erst, wenn die grafische Sitzung vollständig bereit ist, und nutzt die
native Wayland-Sitzung statt Xwayland. Auf älteren Desktop-Systemen bleibt
`kesher-pi.service` der Fallback.

Der Launcher prüft nach dem Browserstart zusätzlich, ob die Station im Intercom
verbunden ist. Ein nach Betriebssystem-Updates hängender erster Chromium-Start
wird nach standardmäßig `25` Sekunden automatisch neu gestartet. Die Frist kann
mit `browser_connect_timeout_seconds` angepasst werden.
Veraltete Chromium-Profilsperren (`Singleton*`) werden vor dem Start entfernt,
damit ein sauber heruntergefahrener oder neu gestarteter Pi nicht zuerst an der
vorherigen Browserinstanz hängen bleibt.

Companion Satellite startet auf dem Pi über einen systemd-Timer standardmäßig
120 Sekunden verzögert und mit niedrigerer Priorität. So konkurrieren Chromium
und die Node-Prozesse von Satellite auf Geräten mit 1 GB RAM nicht gleichzeitig
um CPU, RAM und SD-Karten-I/O, ohne den normalen Bootabschluss zu blockieren.

## Deploy-Paket kopieren

Auf dem Entwicklungsrechner:

```sh
cd /Users/simonrohrer/Webseiten/jms-intercom/Kesher/deploy && COPYFILE_DISABLE=1 tar -czf /tmp/kesher-raspberry-pi-deploy.tar.gz raspberry-pi && scp /tmp/kesher-raspberry-pi-deploy.tar.gz <user>@<pi-ip>:/home/<user>/
```

Auf dem Pi:

```sh
cd ~ && rm -rf raspberry-pi && tar -xzf kesher-raspberry-pi-deploy.tar.gz && cd raspberry-pi && sudo ./install.sh <user> --update-config && sudo reboot
```

## Prüfen

URL, die der Launcher öffnet:

```sh
sudo -u <user> KESHER_PI_IP=<pi-ip> /opt/kesher-pi/kesher-pi-launcher.py --print-url
```

Service:

```sh
systemctl status kesher-pi.service --no-pager
```

Logs:

```sh
journalctl -u kesher-pi.service -f
```

Audio:

```sh
sudo -u <user> XDG_RUNTIME_DIR=/run/user/$(id -u <user>) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u <user>)/bus /opt/kesher-pi/kesher-pi-launcher.py --print-audio
```

## Messwerte im Dashboard (Glances)

Im Dashboard steht unter *Admin* direkt unter *Server* der Abschnitt **Raspberry Pis** mit je einer
Untergruppe pro Pi: Prozessor, Arbeitsspeicher, Temperatur, Speicherkarte, Lesen/Schreiben, WLAN,
Prozesse. Die Werte liefert Glances auf dem Pi:

```bash
sudo ./install-glances.sh            # nur 192.168.0.21 (der Server) darf abfragen
sudo ./install-glances.sh --remove   # Dienst wieder entfernen
```

- Dienst `kesher-glances` (systemd), nur die Schnittstelle auf Port `61208`, ohne Weboberfläche.
  `IPAddressAllow` lässt nur den Server und den Pi selbst durch, alle anderen bekommen keine Antwort.
- Kostet auf einem Pi 3 ca. 70 MB Arbeitsspeicher und im Schnitt ca. 14 % eines Kerns, aber nur,
  solange jemand den Admin-Reiter offen hat (abgefragt wird alle 15 s).
- **Neuer Pi:** Skript auf dem Pi ausführen, in `Kesher/server-config/homepage/services.yaml` die
  Untergruppe `Kamera-1` kopieren (Name, `url` mit der IP des Pi), in `settings.yaml` den Namen unter
  `Raspberry Pis` ergänzen, dann einspielen (siehe Dashboard in `BETRIEB.md`).
- Das Dashboard fragt die **IP-Adresse** des Pi ab (Homepage kennt keine `.local`-Namen). Ändert sie
  sich (DHCP), zeigt die Gruppe „API Error“ – dann die `url` anpassen. Abhilfe auf Dauer: feste
  Adresse per DHCP-Reservierung auf `dc01`. Die aktuelle IP steht in JMS Control unter
  *Einstellungen → Raspberry Pis*.

## Optional: Companion Satellite

```sh
cd ~/raspberry-pi && sudo ./install.sh <user> --update-config --with-companion-satellite
```
