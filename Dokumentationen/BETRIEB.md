# Betrieb

Dieses Dokument enthält nur die wichtigsten Betriebsinformationen für den Kesher-Server.

## Aufbau

Im Standardbetrieb läuft Kesher als Docker-Container:

- `systemd` startet `docker compose`
- Containername: `kesher`
- Web/API/WebSocket: `8080/tcp`
- UDP-Audio-Relay: `8081/udp`
- Datenbank: SQLite im Docker-Volume `intercom_data`
- Healthcheck: `/api/healthz`

Optional kann Caddy davor HTTPS bereitstellen.

## Start und Status

Service prüfen:

```sh
sudo systemctl status kesher.service --no-pager
```

Container prüfen:

```sh
docker ps
```

Logs:

```sh
docker logs -f kesher
```

Healthcheck:

```sh
curl http://127.0.0.1:8080/api/healthz
```

## Neustart und Update

```sh
cd /home/master/kesher
docker compose -f deploy/compose/docker-compose.yml up -d --build
```

Stoppen:

```sh
cd /home/master/kesher
docker compose -f deploy/compose/docker-compose.yml down
```

## Wichtige Ports

| Port | Zweck |
| --- | --- |
| `8080/tcp` | Weboberfläche, REST API, WebSocket |
| `8081/udp` | optionaler UDP-Audio-Relay |
| `443/tcp` | HTTPS, wenn Caddy oder CertMagic davor läuft |
| `80/tcp` | HTTP-Redirect oder CertMagic |

## Daten sichern

Vor größeren Updates das Docker-Volume mit der SQLite-Datenbank sichern.

Nützliche Prüfung:

```sh
docker volume ls | grep intercom_data
```

Wenn direkt auf die Datenbank zugegriffen werden muss, liegt sie im Container unter:

```text
/app/data/intercom.db
```

## Chat-Anzeige auf dem Server-Bildschirm

Ein am Server angeschlossener Bildschirm kann den Kesher-Chat dauerhaft anzeigen (nur lesen, kein Mikrofon, Ton stumm). Statt der Konsolen-Anmeldung auf `tty1` startet dann `cage` mit Chromium im Vollbild als eigener Benutzer `kesher-kiosk`.

Andere Dienste bleiben unberührt: Docker, Kesher, Caddy, Companion und SSH werden weder geändert noch neu gestartet. Die Anzeige läuft mit niedriger Priorität und höchstens 1,5 GB Arbeitsspeicher. Eine Konsole bleibt am Server über `Strg+Alt+F2` erreichbar.

1. In Kesher im Admin-Bereich eine Rolle mit der ID `chat-monitor` anlegen und auf allen Party Lines als Empfänger eintragen. Ohne Empfangsrecht zeigt die Anzeige nur globale und direkte Nachrichten.
2. Auf dem Server installieren:

```sh
cd ~/intercom-system/Kesher/deploy/server-kiosk
sudo ./install-chat-kiosk.sh
```

Optionen: `--role-id`, `--username` (ohne Leerzeichen) und `--url` (Standard `http://127.0.0.1:8080`). Die Einstellungen liegen in `/etc/kesher/chat-kiosk.env`.

Prüfen und entfernen:

```sh
sudo systemctl status kesher-chat-kiosk
journalctl -u kesher-chat-kiosk -f
sudo ./install-chat-kiosk.sh --uninstall
```

Die Anzeige wartet nach dem Start, bis `/api/healthz` antwortet, und startet sich bei Fehlern selbst neu.

## Wichtig im Fehlerfall

1. Läuft der Container?
2. Antwortet `/api/healthz`?
3. Stimmen Server-IP und URL in Raspberry-/Companion-Konfigurationen?
4. Gibt es Zertifikats- oder HTTPS-Probleme?
5. Zeigen die Container-Logs Fehler?

## Lokaler Entwicklungsbetrieb

```sh
make deps
make dev-backend
make dev-web
```

Build und Tests:

```sh
make build
make test
```
