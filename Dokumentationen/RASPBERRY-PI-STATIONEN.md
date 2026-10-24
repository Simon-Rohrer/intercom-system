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
Audio-Geräte und Sparmodus. Ab Launcher-Version 14 hält der Pi seine Anfrage offen (Long-Poll
mit `version`/`waitSeconds`): Der Multiview antwortet sofort, sobald sich etwas für diesen Pi
ändert, statt dass der Pi alle 15 Sekunden nachfragt. Ändert sich nur die Anzeige
(Intercom/Multiview), schaltet er um; bei anderen Änderungen startet er den Browser mit den
neuen Einstellungen neu. Eine geänderte Mikrofon-/Kopfhörer-Wahl startet ihn nicht neu (ab v15),
sie wird über die Fernsteuerung (unten) sofort im laufenden Intercom umgeschaltet.

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

## Ton fernsteuern aus JMS Control

Im Kästchen jeder Station unter *Einstellungen → Raspberry Pis* (nur Admin):

- **Mikrofon, Kopfhörer und „Dauerhaft an“** in einer Zeile, mit „Aktiv am Pi“ und dem Zustand
  live aus Kesher. Eine Änderung schaltet sofort im Intercom des Pi um.
- **Eingangspegel** live (2× pro Sekunde) mit Knopf **Mikrofon testen** (der Pi hört sich selbst
  im Kopfhörer), **Verstärkung** (wie im Intercom, stumm bis +18 dB) und **Rauschsperre** mit Schwelle.
- Der Pegel wird nur gemessen, solange die Einstellungen offen sind (je 30 Sekunden, auch im Sparmodus).

Technisch: JMS Control schickt `POST /api/raspberry-pis/remote-command` (`clientId`, `command`, Werte)
an Kesher weiter. Befehle: `set_voice_mode`, `set_audio_input_device`, `set_audio_output_device`,
`set_input_gain`, `set_local_monitor` sowie neu `set_audio_gate` (Rauschsperre an/aus, Schwelle
−72…−12 dBFS) und `set_remote_metering` (Pegelmessung start/stop). Antwortet Kesher mit 409, ist
der Pi gerade nicht im Intercom (z. B. Ruhemodus oder Multiview ohne Intercom-Sitzung).

**Im Sparmodus wirkt die Rauschsperre nicht.** Kesher schaltet sie dort ab (Schalter ausgegraut),
JMS Control zeigt einen Hinweis.

## Rolle wechseln

Rolle und Geräte-ID eines Pi lassen sich unter *Einstellungen → Raspberry Pis* ändern. Das
Rollen-Dropdown zeigt belegte Rollen (angemeldet, in Kesher oder bei einem anderen Pi) wie die
Anmeldeseite gekennzeichnet und gesperrt. Beim Speichern und beim Start des Multiview zieht die
Registrierung des Gerätezertifikats (Benutzer & Rechte → Geräte) automatisch mit
(`reassignPiMachines` in `multiview/access.js`, auch für Rollen-IDs mit Leerzeichen wie `cam 2`).
Das Gerät bekommt dabei eine neue Version, alte Anmeldungen mit der bisherigen Rolle enden.
Vorher lehnten Multiview (Konfig-Abfrage 403) und Kesher („registered device role required“) den
Pi nach einem Rollenwechsel ab.

## Aus- und einschalten aus JMS Control (Ruhemodus)

In JMS Control unter *Einstellungen → Raspberry Pis* hat jede Station die Knöpfe **Ausschalten** / **Einschalten** und **Neu starten**.

- **Ausschalten** ist ein Ruhemodus: Das Intercom auf dem Pi wird beendet und der Bildschirm geht aus, der Pi selbst bleibt an und im Netz. **Einschalten** weckt ihn wieder – ab Launcher-Version 14 kommt das sofort an (Long-Poll, vorher bis zu 15 Sekunden), danach startet das Intercom. Der Ruhemodus ist eine Einstellung der Station: Startet der Pi neu oder war der Strom weg, bleibt er aus, bis er hier eingeschaltet wird.
- **Neu starten** startet den ganzen Pi neu (geht nur, solange er sich meldet). Der Befehl wird genau einmal ausgeführt und verfällt nach 2 Minuten.
- **Bewusst kein echtes Herunterfahren:** Ein heruntergefahrener Raspberry Pi lässt sich aus der Ferne nicht wieder einschalten (kein Wake-on-LAN), nur durch kurzes Trennen vom Strom. Für echtes Aus/An bräuchte es eine schaltbare Steckdose vor dem Netzteil.

Voraussetzung ist der aktuelle Launcher auf dem Pi (ab Version 12; `install.sh` richtet für „Neu starten“ auch die sudo-Regel `/etc/sudoers.d/kesher-pi-power` ein, die nur `systemctl poweroff` und `systemctl reboot` erlaubt). Den Bildschirm schaltet der Launcher über `wlopm` (nur Stromsparen), sonst `wlr-randr` oder `vcgencmd` – `wlr-randr` meldet den Ausgang ab und wieder an, dabei ist labwc auf dem Pi 3 abgestürzt und der Anmeldebildschirm mit Passwortabfrage kam. Aktualisieren vom Server aus, ohne die Konfiguration auf dem Pi zu überschreiben:

```sh
cd ~/intercom-system/Kesher/deploy && tar -czf /tmp/kesher-raspberry-pi-deploy.tar.gz raspberry-pi && scp /tmp/kesher-raspberry-pi-deploy.tar.gz <user>@<pi-ip>:~
ssh <user>@<pi-ip> 'rm -rf raspberry-pi && tar -xzf kesher-raspberry-pi-deploy.tar.gz && cd raspberry-pi && sudo ./install.sh <user> && sudo reboot'
```

## Intercom oder Multiview auf dem Bildschirm

In JMS Control unter *Einstellungen → Bildschirme* hat jeder Raspberry Pi ein eigenes Kästchen: **Intercom** oder **Multiview**, welcher Multiview und die Drehung. Der Pi steht dort als Bildschirm `pi-<id>` (wie die Anschlüsse am Server, auch für Companion: `/api/screen/<Pi-Name>/output/<Multiview>`). Im Multiview-Modus öffnet der Launcher `output.html?screen=pi-<id>` beim Multiview; der Wechsel zwischen Multiviews ist sofort live.

**Zwei Tabs (ab Launcher-Version 14):** Intercom und Multiview laufen als zwei Tabs in einem Chromium, umgeschaltet über die Fernsteuerung von Chromium auf `127.0.0.1:9222`. Der Wechsel Intercom ↔ Multiview dauert so nur 1–3 Sekunden statt eines Browser-Neustarts (auf dem Pi 3 vorher etwa 45 Sekunden). Das Intercom läuft im Hintergrund weiter. Der Pi meldet, was er gerade zeigt (Status unter *Einstellungen → Bildschirme*).

**Speicher (ab Version 16, Pi 3 mit 905 MB):** Zwei Tabs gleichzeitig haben den Pi 3 nach einigen Stunden voll laufen lassen (Swap 90 %, Absturz des Chromium-Netzwerkdienstes, schwarzer Bildschirm). Deshalb:

- Beim Wechsel zurück zum Intercom wird der Multiview-Tab geschlossen, nicht im Hintergrund gehalten.
- Ein Speicherwächter prüft alle 5 Sekunden den freien Speicher. Unter 120 MB schließt er den Multiview (das Intercom bleibt), nach 2 Minuten und ab 250 MB frei öffnet er ihn wieder frisch (`MEMORY_LOW_MB`, `MEMORY_RECOVER_MB`, `MEMORY_REOPEN_DELAY_SECONDS` im Launcher).
- Solange der Multiview vorne ist, ist der Mauszeiger ausgeblendet (zwei labwc-Tastenkürzel in `~/.config/labwc/rc.xml`, ausgelöst mit `wtype`; `install.sh` richtet beides ein).
- `entlasten.sh` schaltet Dienste ab, die eine Kamera-Station nicht braucht (cups, NFS/rpcbind, xrdp, wayvnc, rpi-connect, PackageKit, colord, gvfs, cloud-init, automatische Updates). Es deinstalliert nichts und sichert die vorherige Dienstliste unter `/var/backups/kesher-pi-dienste-*.txt`.
- Prüfen: `free -m` und `journalctl -b | grep "Network service crashed"`.

Während der Browser startet, zeigt der Pi statt des Desktops nur das JMS-Logo mittig auf Schwarz (`jms-logo-dunkel.png`, Hintergrund von pcmanfm). `install.sh` richtet das ein, blendet die Desktop-Symbole aus und nimmt die Taskleiste aus dem Desktop-Autostart: `/etc/xdg/labwc/autostart` ist per `dpkg-divert` ersetzt, die Fassung des Pakets liegt unter `autostart.distrib` (zurück: `sudo rm /etc/xdg/labwc/autostart && sudo dpkg-divert --rename --remove /etc/xdg/labwc/autostart`).

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
