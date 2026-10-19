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

Der JMS-Server sichert sich **einmal pro Woche, montags um 3:30 Uhr** (deutsche Zeit, direkt nach dem Sonntag, an dem die Systeme am meisten genutzt werden), verschlüsselt auf einen **USB-Datenträger**, der dauerhaft am Server steckt (restic, eingebunden unter `/mnt/jms-backup`). Kesher und Companion sind dabei ca. 1 Minute aus. Gespeichert werden nur Änderungen; es bleiben 8 wöchentliche und 6 monatliche Sicherungen (ein halbes Jahr zurück), nach jeder Sicherung wird ein Teil der Daten zurückgelesen und geprüft. Eine verpasste Sicherung (Server war montags um 3:30 aus) wird bewusst nicht beim Einschalten nachgeholt – der Störungs-Bot meldet sich dann, und sie lässt sich von Hand starten (siehe unten). Fehlt der Datenträger, bricht die Sicherung ab, bevor Kesher angehalten wird, und schreibt nie auf die Server-Festplatte.

Der Störungs-Bot (siehe unten) meldet eine fehlgeschlagene Sicherung, einen fehlenden oder fast vollen USB-Datenträger und wenn die letzte erfolgreiche Sicherung länger als 8 Tage her ist. In `/status` steht, wann zuletzt gesichert wurde.

Größe: 64–128 GB reichen (eine Sicherung ist klein, weil Docker-Images und Betriebssystem nicht mitgesichert werden; jede weitere Woche kommt nur die Änderung dazu). Belegung prüfen: `sudo jms-backup --list` bzw. `/status` im Bot. Bei einer Sicherung pro Woche reicht ein guter Marken-USB-Stick; eine kleine USB-SSD hält noch länger.

Einrichten (einmalig, Datenträger vorher anstecken):

```sh
cd ~/intercom-system/Kesher/deploy/server-backup
sudo ./install-backup.sh --usb            # vorhandenes Dateisystem nutzen (ext4, exFAT, NTFS …)
sudo ./install-backup.sh --usb --format   # vorher mit ext4 neu formatieren (löscht den Datenträger)
```

Das Skript zeigt die angeschlossenen Datenträger (die Systemplatte nie), fragt nach der Partition (z. B. `sdb1`), trägt sie in `/etc/fstab` ein (`nofail`: der Server startet auch ohne) und zeigt am Ende das **Backup-Passwort**. Es muss außerhalb des Servers aufbewahrt werden – ohne es ist keine Sicherung lesbar, auch nicht vom USB-Datenträger.

Gesichert werden alle Docker-Volumes (u. a. Kesher-Datenbank, Multiview-Einstellungen, Portainer), Companion, Caddy, Netzwerk, Kiosk, systemd-Dienste, `/opt/homelab` und der Quellstand `~/intercom-system` mit lokalen Änderungen.

```sh
sudo systemctl start jms-backup-cloud     # Sicherung jetzt
journalctl -u jms-backup-cloud -n 50      # letzter Lauf
systemctl list-timers jms-backup-cloud    # nächster Lauf
sudo jms-backup --list                    # wöchentliche Sicherungen anzeigen
sudo jms-backup --restore /home/master/restore   # neueste Sicherung holen
sudo jms-backup                           # Vollsicherung als Ordner unter /home/master/backups (für den Mac)
```

**Alternative Google Drive** (auf dem JMS-Server bewusst nicht genutzt, Einrichtung aufwändig; Google-Anmeldung über einen Rechner mit Browser):

```sh
cd ~/intercom-system/Kesher/deploy/server-backup
sudo ./install-backup.sh
```

Das Skript zeigt am Ende das **Backup-Passwort**. Es muss außerhalb des Servers aufbewahrt werden – ohne es ist keine Sicherung lesbar.

**Eigener Google-Zugang (nötig):** Der eingebaute Zugang von rclone wird von Google oft gebremst („rateLimitExceeded“). Einmalig mit dem Technik-Konto in der [Google Cloud Console](https://console.cloud.google.com): Projekt anlegen → *APIs & Dienste* → *Google Drive API* aktivieren → *OAuth-Zustimmungsbildschirm*: extern, App-Name, E-Mail, Bereich `…/auth/drive.file`, danach **„App veröffentlichen“** (sonst läuft die Anmeldung nach 7 Tagen ab) → *Anmeldedaten* → *OAuth-Client-ID* vom Typ **Desktop-App**. Dann auf dem Server `sudo ./install-backup.sh --client-id <ID> --client-secret <Secret>` und neu anmelden. Mit `drive.file` sieht ein neuer Zugang die Dateien des alten nicht – einen alten Ordner `JMS-Backup` vorher in Drive löschen; das Skript legt ihn neu an.

Nach `--restore` liegen die Daten unter `/home/master/restore/var/lib/jms-backup/stage` (Volumes, Companion, Kesher-Version und lokale Änderungen), Systemdateien und Quellstand unter ihrem ursprünglichen Pfad in `/home/master/restore`. Ein Volume zurückspielen (Kesher vorher anhalten):

```sh
R=/home/master/restore/var/lib/jms-backup/stage/volumes
docker stop kesher
docker run --rm -v compose_intercom_data:/data -v "$R/compose_intercom_data":/src:ro alpine:3.21 \
  sh -c 'rm -rf /data/* /data/.[!.]* 2>/dev/null; cp -a /src/. /data/'
docker start kesher
```

Vor größeren Updates zusätzlich das Docker-Volume mit der SQLite-Datenbank sichern.

Nützliche Prüfung:

```sh
docker volume ls | grep intercom_data
```

Wenn direkt auf die Datenbank zugegriffen werden muss, liegt sie im Container unter:

```text
/app/data/intercom.db
```

## Störungsmeldungen per Telegram

Der Server prüft sich jede Minute selbst (`jms-watch`) und meldet Störungen über einen **eigenen Telegram-Bot**, der nur dafür da ist (nicht der Kesher-Bot):

- **Internet und DNS**: Ohne Internet kann der Server nichts schicken. Die Meldung kommt deshalb, sobald die Verbindung wieder steht, als „war gestört von … bis …“. Den Ausfall vom 15.10.2026 (17:04 bis 08:57, kein Tailscale-Zugang von außen) hätte er so gemeldet.
- **Docker-Container**: jeder Container mit Neustart-Regel (`always`, `unless-stopped`) muss laufen und darf nicht `unhealthy` sein.
- **Dienste**: `docker`, `caddy`, `tailscaled`, `companion` (und `multiview`, `kesher-chat-kiosk`, falls eingeschaltet) müssen laufen. Zusätzlich wird jede systemd-Unit gemeldet, die als „failed“ steht, z. B. eine fehlgeschlagene Sicherung.
- **Tailscale** auf dem Host und in Tailscale-Containern (z. B. `tailscale-lasse`): nicht verbunden oder abgemeldet.
- **Companion-Weboberfläche** antwortet nicht, **Warnung (⚠️)**, wenn Festplatte, Arbeitsspeicher oder USB-Sicherungsdatenträger über 80 % voll sind oder die Temperatur über 85 °C liegt.
- **Wöchentliche Sicherung**: USB-Datenträger fehlt oder ist fast voll, letzte erfolgreiche Sicherung älter als 8 Tage.
- **Server war aus**: Nach dem Hochfahren kommt eine Meldung mit Zeitraum und **Grund** aus dem Protokoll des vorherigen Starts – Ein-/Aus-Knopf gedrückt, per Befehl (mit Benutzer), automatischer Neustart nach Updates, Arbeitsspeicher voll, Überhitzung, Kernel-Absturz oder „Strom weg / harter Absturz“ (nicht heruntergefahren). Nachträglich: `sudo jms-watch --grund`.

Gemeldet wird erst nach 3 Minuten Störung (Internet: 2 Minuten), damit Neustarts und Updates keinen Alarm auslösen, und noch einmal, wenn es wieder läuft. Während der wöchentlichen Sicherung werden Container und Dienste nicht geprüft. Im Bot zeigt `/status` jederzeit jeden überwachten Dienst mit eigenem Status, gegliedert nach Netzwerk, Container, Dienste, Weboberflächen und System (z. B. „🟢 kesher – läuft seit 9 Std. · gesund“). Die Antwort kommt nach wenigen Sekunden über den Dienst `jms-watch-bot`, Stand ist die letzte Prüfrunde.

Einrichten (fragt nach dem Bot-Token und findet die Chat-ID selbst):

1. In Telegram `@BotFather` öffnen, `/newbot` senden, Namen (z. B. „JMS Störungen“) und Benutzernamen vergeben, Token kopieren.
2. Auf dem Server: `cd ~/intercom-system/Kesher/deploy/server-watch && sudo ./install-watch.sh`, Token einfügen.
3. Wenn das Skript es sagt, in Telegram den neuen Bot öffnen und auf **Start** tippen. Danach kommt die Begrüßung vom Bot.

Weitere Befehle: `sudo jms-watch --status` (Zustand im Terminal), `sudo jms-watch --test` (Testnachricht), `sudo ./install-watch.sh --new-bot` (anderer Bot/Chat), `sudo ./install-watch.sh --uninstall`. Einstellungen (Wartezeiten, auszunehmende Container oder Dienste über `IGNORE_CONTAINERS` / `IGNORE_UNITS`) stehen in `/etc/jms-watch/watch.env` und wirken ab der nächsten Minute. Protokoll: `journalctl -u jms-watch -n 50`.

Wird ein Container absichtlich länger gestoppt, meldet der Bot das nach 3 Minuten einmal. Soll das nicht passieren, den Container in `IGNORE_CONTAINERS` eintragen.

## Chat automatisch leeren

Kommt 6 Stunden lang keine neue Chat-Nachricht, leert Kesher den Chat für alle: Verlauf auf dem Server, Stationen und Chat-Anzeige. Der Server prüft das einmal pro Minute. Jede neue Nachricht (auch per Stream Deck oder Telegram) startet die 6 Stunden neu. Manuell geht es weiterhin im Admin-Bereich unter `Chatverlauf`.

Die Zeit lässt sich ändern: in `config.yaml` mit `chat_history_idle_clear_minutes` oder als Umgebungsvariable `CHAT_HISTORY_IDLE_CLEAR_MINUTES` (in Minuten, `0` schaltet es ab).

## Chat-Anzeige auf dem Server-Bildschirm

Ein am Server angeschlossener Bildschirm kann den Kesher-Chat dauerhaft anzeigen (nur lesen, kein Mikrofon, Ton stumm). Statt der Konsolen-Anmeldung auf `tty1` startet dann `cage` mit Chromium im Vollbild als eigener Benutzer `kesher-kiosk`.

Andere Dienste bleiben unberührt: Docker, Kesher, Caddy, Companion und SSH werden weder geändert noch neu gestartet. Die Anzeige läuft mit niedriger Priorität und höchstens 1,5 GB Arbeitsspeicher. Eine Konsole bleibt am Server über `Strg+Alt+F2` erreichbar.

1. Eine Rolle mit der ID `chat-monitor` anlegen (Multiview → *Benutzer & Rechte* → *+ Neue Rolle*, Name „Chat-Monitor“; ohne `JMS_AUTH_SECRET` im Kesher-Admin) und in Kesher auf allen Party Lines als Empfänger eintragen. Ohne Empfangsrecht zeigt die Anzeige nur globale und direkte Nachrichten.
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

### Multiview statt reinem Chat

Der Bildschirm kann stattdessen das Multiview zeigen (Ordner `multiview/`, eigener Docker-Container mit Port 8090). Der Chat ist dort eine Kachel mit dem Inhalt **Kesher-Chat**. Der Multiview-Container meldet sich einmal mit der Rolle `chat-monitor` bei Kesher an und verteilt den Chat an alle Multiview-Ansichten (HDMI-Monitor, Editor-Vorschau, `output.html` auf jedem Rechner). Darum darf keine andere Anzeige gleichzeitig mit `chat-monitor` angemeldet sein. Zum reinen Chat zurück geht es erst, wenn die Chat-Kachel entfernt oder der Container gestoppt ist.

```sh
cd ~/intercom-system/multiview
docker compose up -d --build
cd ~/intercom-system/Kesher/deploy/server-kiosk
sudo ./install-chat-kiosk.sh --display-url "http://127.0.0.1:8090/output.html?id=1"
```

Zurück zum reinen Chat: `sudo ./install-chat-kiosk.sh --display-url chat`. Editor: `http://<server-ip>:8090/`.

### Mehrere Monitore am Server (HDMI, DisplayPort, VGA)

An jedem Ausgang der Grafikkarte kann ein eigener Multiview laufen. Welcher wo läuft, stellst du im Multiview-Editor auf der **Übersicht** unter **Bildschirme am Server** ein. Die Umschaltung ist sofort live, auch per Companion (`/api/screen/<Anschluss>/output/<Multiview>`, `…/output/aus` = schwarz). VGA hängt bei vielen Boards intern an einem DisplayPort-Ausgang und erscheint dann als `DP-1` oder `DP-2`. Den Namen kannst du in der Tabelle frei vergeben.

```sh
cd ~/intercom-system/Kesher/deploy/server-kiosk
sudo ./install-chat-kiosk.sh --display-url screens
```

Statt `cage` läuft dann `sway`, weil `cage` nur einen Monitor ansteuern kann. Es läuft ein einziger Chromium mit einem Vollbildfenster pro angeschlossenem Monitor, so können sich mehrere Monitore dieselbe Capture-Karte teilen. Wird ein Monitor ein- oder ausgesteckt, startet die Anzeige nach wenigen Sekunden neu. Kurz nach dem Start schaltet sie jeden Ausgang einmal aus und wieder ein, weil der VGA-Ausgang sonst trotz Signal schwarz bleiben kann. Eine feste Auflösung pro Anschluss steht in `/etc/kesher/chat-kiosk.env`, z. B. `KIOSK_OUTPUT_MODES="DP-2=1920x1080@60Hz"` (danach `sudo systemctl restart kesher-chat-kiosk`). Zurück zu einem einzelnen Monitor: `--display-url "http://127.0.0.1:8090/output.html?id=1"`.

### ChurchTools-Ablauf im Multiview

Kacheln mit dem Inhalt **ChurchTools-Ablauf** zeigen den Ablauf des heutigen Events (laufender Punkt hervorgehoben). Der Multiview-Server ist dafür mit einem eigenen ChurchTools-Konto per REST-API verbunden.

1. In ChurchTools ein eigenes Konto für den Server anlegen (ohne Zwei-Faktor-Anmeldung). Es braucht Leserechte auf die Kalender bzw. Events und das Recht, Abläufe zu sehen.
2. Im Multiview-Editor unter *Einstellungen → ChurchTools* die Adresse (z. B. `https://gemeinde.church.tools`) sowie Benutzername und Passwort eintragen und **Verbinden** klicken. Alternativ direkt den Login-Token des Kontos eintragen.
3. Das Passwort wird nur einmal zum Holen des Login-Tokens benutzt. Gespeichert wird nur der Token in `churchtools-secret.json` im Daten-Volume (nur für den Server lesbar, wird nie an Browser geschickt).

Der Server fragt ChurchTools jede Minute ab. Pro Kachel lässt sich unter *Datum* wählen: **Heute** (das laufende, sonst das nächste Event von heute), **Nächstes Event** (das laufende, sonst das nächste – auch an späteren Tagen, bis sechs Wochen voraus) oder **Festes Datum** (mit Kalender, z. B. 15.10.). Der laufende Punkt wird nur bei Events von heute hervorgehoben. Im Kachel-Feld *Event* lässt sich ein Name oder Kalender als Filter eintragen. Events ohne Ablauf werden ebenfalls angezeigt, die Kachel meldet dann „Kein Ablauf hinterlegt“. Unter *Einstellungen → ChurchTools* steht eine Übersicht aller Events von heute bis in vier Wochen (mit Zahl der Ablaufpunkte oder „Kein Ablauf hinterlegt“), dazu die festen Daten der Kacheln. Die Abläufe dieser Übersicht fragt der Server höchstens alle zehn Minuten neu ab.

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

## Einheitlich HTTPS auf dem JMS-Server (vorbereitet, noch nicht umgesetzt)

Ziel: Alle Weboberflächen unter `https://192.168.0.21:<gewohnter Port>`. Caddy übernimmt die Ports nach außen, die Dienste lauschen nur noch auf `127.0.0.1`. Alte `http://`-Links werden auf demselben Port auf `https://` umgeleitet. Auf dem Server selbst (Kiosk, Companion) bleibt `http://127.0.0.1:<port>`. Zertifikate kommen von Caddys lokaler Zertifizierungsstelle; jeder Browser zeigt pro Dienst einmal eine Warnung.

| Dienst | neu | intern |
| --- | --- | --- |
| Kesher | `https://192.168.0.21:8443` | `127.0.0.1:8080` |
| Multiview | `https://192.168.0.21:8090` | `127.0.0.1:8090` (`HOST=127.0.0.1` im Compose) |
| Companion | `https://192.168.0.21:8000` | `127.0.0.1:8000` |
| Dashboard | `https://192.168.0.21:3000` | `127.0.0.1:3000` |
| Glances | `https://192.168.0.21:61208` | `127.0.0.1:61208` |
| Portainer | `https://192.168.0.21:9443` | `127.0.0.1:9443` (eigenes HTTPS, Caddy davor) |

Die bisherigen Namens-Adressen (`kesher.jms.de`, `dashboard.jms.de`, `companion.jms.de`, … sowie `*.local`) bleiben erhalten; neu ist `multiview.jms.de` / `jmscontrol.local` (`multiview.local` gibt es seit 15.10.2026 nicht mehr).

Vorlage: `Kesher/server-config/Caddyfile.jms` (aufgebaut auf der aktiven Server-Konfiguration vom 12.10.2026, mit `caddy adapt --validate` auf dem Server geprüft).

**Stand 14.10.2026: auf dem JMS-Server umgesetzt.** Sicherung unter `~/backups/20261014-165617-https-zentrale-anmeldung`. Companion lauscht über `--admin-address 127.0.0.1` in `/usr/local/src/companionpi/launch.sh` nur lokal (nach einem CompanionPi-Update prüfen, ob die Option noch drin ist, sonst startet die Companion-Oberfläche nicht). HTTP/3 ist auf den Port-Adressen aus (`protocols h1 h2`), weil Caddy sonst UDP auf denselben Ports belegt – UDP 8000 braucht MediaMTX im Multiview. Beim ersten Umstellen geht `systemctl reload caddy` nicht (Adressen wechseln), dann einmal `systemctl restart caddy`.

Umsetzung vor Ort, in dieser Reihenfolge (sonst ist ein Port doppelt belegt):

1. Sicherung: `/etc/caddy/Caddyfile`, Compose-Dateien in `/opt/homelab/compose`, Companion-Konfiguration.
2. Dienste auf `127.0.0.1` umstellen: Homepage-Compose `127.0.0.1:3000:3000`, Portainer-Compose `127.0.0.1:9443:9443`, Glances, Companion (Admin-Oberfläche nur lokal), Multiview (in `multiview/docker-compose.yml` die Zeile `HOST: "127.0.0.1"` einkommentieren, dann `docker compose up -d`).
3. `sudo cp Caddyfile.jms /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`
4. Prüfen: jede Adresse per `https://` und die Weiterleitung von `http://`; Kiosk-Anzeige, Companion-Tasten (Generic HTTP auf `http://127.0.0.1:8090`), Kesher-Clients und Raspberry Pis.
5. Links im Dashboard und in Notion auf `https://` umstellen: Dateien aus `Kesher/server-config/homepage/` übernehmen (siehe [Dashboard](#dashboard)).

## Anmeldung für alle Dienste

Wer über das WLAN (Handy, iPad, Laptop) auf Intercom, Dashboard oder die Technik-Dienste zugreift, meldet sich einmal zentral an: zuerst einmal am Tag mit dem **Tagescode** (QR-Code scannen oder 6 Ziffern eingeben), dann mit **Name und Rolle** (Admin mit PIN). Das gilt danach für alle Dienste: Kesher meldet sich direkt mit Name und Rolle an, der Admin landet ohne Kesher-PIN im Kesher-Admin. Companion, Portainer, Glances und DNS sind nur für den Admin (Portainer fragt zusätzlich sein eigenes Passwort). Der Multiview selbst braucht keinen Code – dort holt man ihn ab.

- **Einschalten, Code, feste Geräte:** Multiview → *Benutzer & Rechte* → *Anmeldung für alle Dienste*. Voraussetzung: Admin-PIN ist eingerichtet. Nach dem Update ist die Anmeldung aus.
- **Tagescode:** neu um Mitternacht (deutsche Zeit). Wer ihn eingegeben hat, bleibt bis zum nächsten Morgen 5 Uhr freigeschaltet. „Neuen Code erzeugen“ beendet alle Freischaltungen sofort. Nach 8 falschen Versuchen ist eine Adresse 15 Minuten gesperrt.
- **Feste Geräte ohne Code:** Raspberry Pis, Kesher-Stationen, Kesher-Desktop-App und andere Geräte, die keinen Code eingeben können, **vor dem Einschalten** als Adresse oder Bereich eintragen (z. B. `192.168.0.50` oder `192.168.0.0/24`). Sie kommen ohne Code und Anmeldung an Intercom und Dashboard, an die Admin-Dienste nur mit Admin-Anmeldung. Der Server selbst (Kiosk, Companion, Multiview → Kesher) ist immer frei.
- **Abmelden:** in Kesher über „Abmelden“, im Dashboard über *Konto → Abmelden*. Das meldet auf allen Diensten ab; die Freischaltung mit dem Code bleibt für den Tag.
- **Technik:** Caddy fragt vor jeder Anfrage an einen Dienst den Multiview (`forward_auth` auf `/.jms-auth/check`, Baustein `jms_auth` in `Caddyfile.jms`), `/.jms-auth/*` geht auf jeder Adresse zum Multiview (Anmeldeseite). Jede Adresse (IP, `.local`, `.jms.de`) hat ihr eigenes Anmelde-Cookie. Kesher erkennt den Admin an einem signierten Ticket: In `Kesher/deploy/compose/.env` und `multiview/.env` muss derselbe Wert `JMS_AUTH_SECRET=` stehen, z. B. erzeugt mit `openssl rand -hex 32`. Ohne ihn meldet sich der Admin in Kesher weiter mit der Kesher-PIN an.
- **Rollen:** werden im Multiview unter *Benutzer & Rechte* angelegt, umbenannt (die ID bleibt) und gelöscht; der Multiview speichert sie über ein Ticket sofort in Kesher. Mit „Rechte übernehmen von“ bekommt eine neue Rolle Party Lines, Stream-Deck-Tasten und Multiview-Rechte einer bestehenden. Beim Löschen gehen die Kesher-Benutzereinträge der Rolle mit; solange jemand mit ihr angemeldet oder in Kesher verbunden ist, geht es nicht. Im Kesher-Admin stellt man dann nur noch Party Lines und Standardwerte der Rolle ein. Braucht `JMS_AUTH_SECRET` wie oben.
- **Telegram:** im Modus `polling` (Standard) nicht betroffen.

## Dashboard

Das Dashboard (Homepage, `https://192.168.0.21:3000`) hat oben zwei Seiten zum Umschalten:

- **Start** – für alle: Intercom, Raspberry fernsteuern, Multiview, Fernbedienung, Prediger-Ansicht sowie *Konto* (Abmelden, Konto wechseln).
- **Admin** – Companion, Portainer, Glances, lokaler DNS, Router; Serverwerte (Prozessor, Arbeitsspeicher, Temperatur, Laufwerk, Prozesse, Container-Auslastung), darunter dieselben Werte für jeden Raspberry Pi (Abschnitt *Raspberry Pis*, Glances auf dem Pi, siehe `RASPBERRY-PI-STATIONEN.md`) und der Zustand jedes Containers.

Die Admin-Seite sieht nur, wer im Dashboard als Admin angemeldet ist (`custom.js` fragt `/.jms-auth/api/me`); alle anderen sehen nur „Start“ ohne Umschaltleiste – als Admin anmelden über *Konto → Konto wechseln*. Ist die zentrale Anmeldung aus, sehen alle beide Seiten. Die Admin-Dienste selbst prüft Caddy unabhängig davon.

Konfiguration im Repo unter `Kesher/server-config/homepage/` (`settings.yaml`: welche Gruppe auf welcher Seite, `services.yaml`: Kacheln, `custom.js`, `custom.css`). Auf dem Server liegen sie in `/opt/homelab/config/homepage/` (gehört root – ohne sudo per `docker cp <datei> homepage:/app/config/` kopieren). Änderungen an `settings.yaml` wirken erst nach `docker restart homepage`. **Danach** einmal `curl -s -H "Host: dashboard.local" http://127.0.0.1:3000/api/revalidate` auf dem Server – sonst liefert Homepage nach dem Neustart noch die alte, vorgefertigte Seite aus (fehlende Gruppen, falsche Reiter).
