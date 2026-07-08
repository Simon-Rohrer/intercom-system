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

## Konfiguration ergänzen

Auf dem Entwicklungsrechner diese Datei bearbeiten:

```text
Kesher/deploy/raspberry-pi/raspberry-pis.json
```

Beispiel:

```json
{
  "device_id": "kamera-2-pi",
  "ip_address": "192.168.178.191",
  "name": "Kamera-2",
  "role_id": "cam 2",
  "audio_input_match": "Headset",
  "audio_output_match": "Headset",
  "low_power_mode": true,
  "simple_view": false
}
```

Wichtig:

- `ip_address` muss zur festen Pi-IP passen.
- `name` und `device_id` dürfen keine Leerzeichen enthalten.
- `role_id` ist die Rollen-ID aus Kesher Admin.
- `server_url` muss auf den Kesher-Server zeigen.
- `audio_runtime_wait_seconds` kann optional auf `0` bis wenige Sekunden gesetzt werden, wenn der Browser schnell starten soll und Audio-Geräte nicht beim Systemstart blockieren dürfen.
- `display_runtime_settle_seconds` steuert die kurze Wartezeit nach dem Start der Desktop-Sitzung. Auf Raspberry Pi OS mit Wayland/Xwayland verhindern etwa `8` Sekunden, dass Chromium während der Grafikinitialisierung hängen bleibt.

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

## Optional: Companion Satellite

```sh
cd ~/raspberry-pi && sudo ./install.sh <user> --update-config --with-companion-satellite
```
