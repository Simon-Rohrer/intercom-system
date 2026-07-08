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
