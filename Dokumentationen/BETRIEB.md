# Betrieb

Dieses Dokument enthält nur die wichtigsten Betriebsinformationen für den Kesher-Server.

## Einheitliche .internal-Adressen – Stand 17.10.2026

Die Serverumstellung ist aktiv: `https://intercom.internal`, `https://jmscontrol.internal`, `https://technik.internal`, `https://companion.internal`, `https://portainer.internal`, `https://glances.internal`, `https://dns.internal`, `https://router.internal` und `https://setup.internal`. Gleichwertige Aliase: `kesher.internal`, `multiview.internal`, `dashboard.internal`. Alle zwölf DNS-Einträge zeigen auf `192.168.0.21`. Dashboard-Verknüpfungen, HTTPS-VHosts und die exakte SSO-Allowlist verwenden die neuen Namen; Rollen und Geräteprüfung bleiben unverändert. Es gibt keine Wildcard-SSO-Freigabe.

**Noch offen: DNS-Verteilung an Clients.** Der ausschließlich per WLAN verbundene Pi erhält DNS und DHCP von `192.168.0.5`, Gateway `192.168.0.1`. Der Benutzer hat nur Zugriff auf `192.168.0.250`, nach seiner Angabe vermutlich im Access-Point-Modus. Es wurde keine Router-/DHCP-/Tailscale-Admin-Einstellung geändert. Eine DNS-Einstellung für den Access Point selbst verteilt nicht automatisch DNS an dessen WLAN-Clients. Kein zweiter DHCP-Server im bestehenden Netz!

- Tailscale-Admin → DNS → Nameservers → Add nameserver → Custom: `192.168.0.21`, „Restrict to domain / Split DNS“ an, Domain `internal` (ohne Punkt oder Stern), speichern. Kein globales DNS-Override nötig. Client: Tailscale-DNS an, Exit Node None, VPN neu verbinden. Die Regel gilt für entsprechend konfigurierte Geräte dieses Tailnets, nicht für beliebige WLAN-Gäste. Erst nach erfolgreicher Abnahme erfolglose `.local`-Pilotregeln entfernen; `.jms.de` vorläufig als Rückfall behalten.
- Für automatische WLAN-Auflösung muss der zuständige Administrator auf DNS `192.168.0.5` die Zone `internal` an `192.168.0.21` weiterleiten. DNS UDP/TCP 53 muss erreichbar sein. Vorhandene interne Zonen/AD-Abhängigkeiten prüfen; nicht pauschal DNS für das gesamte Netz ersetzen. Ohne diesen Zugriff geht das in der heutigen AP-/Bridge-Struktur nicht automatisch für alle Geräte. Eine eigene geroutete WLAN-Zone wäre ein separates, vor Ort zu planendes Netzprojekt, keine beiläufige DHCP-Änderung.
- In AdGuard bleiben die bisherigen Upstream-DNS-Server erhalten. Zwölf exakte Rewrites beantworten bekannte Namen; die DNS-Rewrite-Regel `||internal^$dnsrewrite=NXDOMAIN;;` beantwortet unbekannte Namen lokal, statt sie zurück an `.5` zu leiten. Bekannte AAAA-/HTTPS-/SOA-/MX-Anfragen liefern NOERROR ohne Antwort. Kein Wildcard-A-Eintrag. Rewrites/Regel nicht ohne Ersatz entfernen.
- Bestehende Caddy-Root-CA beibehalten; neue Dienstzertifikate werden darunter ausgestellt. Bereits vertrauende Geräte benötigen keine neue CA. Neue Geräte brauchen einmalig CA-Vertrauen oder zentrale MDM-Verteilung; `.internal` bietet nicht automatisch öffentlich vertrauenswürdige Zertifikate. iPhone: Zertifikatsprofil installieren, dann Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen → volles Vertrauen. Vorher Echtheit über einen unabhängigen vertrauenswürdigen Kanal prüfen. SHA-256: `6B:5C:BD:1B:2E:14:FF:D5:5D:78:76:60:39:B1:EE:B3:1F:BD:32:90:43:9A:94:E9:2C:AD:98:45:B3:C9:26:8E`. HTTP-Download allein ist kein Echtheitsnachweis; Warnungen nicht umgehen.

**Kompatibilität:** Bisherige IP-Port-/`.local`-/`.jms.de`-Zugänge bleiben als befristeter Migrationsrückweg bestehen. Der zentrale SSO-Hub bleibt absichtlich `https://192.168.0.21:8090`, damit IP-Zugriff und noch nicht umgestellte DNS-Clients weiter funktionieren. Das ist dieselbe Anmeldung, kein zweiter Auth-Dienst. Native Maschinen-/Backend-Adressen wurden nicht unnötig geändert. Nach vollständiger WLAN-/VPN-Abnahme kann die Entfernung alter Aliase separat geplant werden.

**Nachweise der Umstellung:** 109 lokale Node-Tests und 112 Tests mit dem Kandidaten-Container bestanden. Der erste Testlauf auf dem Serverhost scheiterte an dort fehlenden Node-Abhängigkeiten; die automatische Rücknahme funktionierte. Anschließend wurde mit den tatsächlichen Container-Abhängigkeiten erfolgreich geprüft und ausgerollt. 150 isolierte DNS-Prüfungen sowie 150 DNS-Prüfungen vom MacBook direkt an `.21` über UDP/TCP bestanden. Sechs zusätzliche DNS-Stichproben bei ausgeschaltetem AdGuard-Schutz bestehen ebenfalls. 365 produktive HTTPS-/Auth-Protokollprüfungen über 37 Ursprünge bestanden: elf `.internal`, sieben IP-Port-Einstiege, zehn `.local`, neun `.jms.de`; einschließlich normaler Rolle, exakter Weiterleitungen, unveränderter Ablaufzeit, Admin-Abgrenzung, CSRF, zentralem Logout und WebSocket-Widerruf 4401. Die Testrolle wurde wieder freigegeben.

Alle zwölf HTTPS-Einstiege sind zusätzlich vom WLAN-Pi mit expliziter Serverzuordnung und verifizierter CA erreichbar. **Das ist kein DNS-Nachweis:** Reguläres `intercom.internal` löst der Pi über `.5` noch nicht auf. Die Einrichtungsseite wurde im Desktopbrowser über den bisherigen Setup-Namen geprüft. iPhone-/Tablet-Bedienung, Mikrofon, WebRTC/PTT und echter nächtlicher Ablauf bleiben Geräteabnahmen. Keine realen Audio-/Steueraktionen durchgeführt. Bestehende Kesher-/Companion-Dienste wurden nicht neu installiert.

**Sicherung/Rückweg:** `/home/master/backups/internal-migration-20261017` (nur root), altes Image `jms-multiview:internal-rollback-20261017`. Enthält die betroffenen Originaldateien einschließlich DNS-, Caddy-, Homepage-, Auth- und Betriebsdokumentation. Vor Rücknahme spätere Änderungen vergleichen; AdGuard-Konfiguration nur bei gestopptem AdGuard zurückspielen. Caddy vor Reload validieren, ausschließlich betroffene Multiview-/Homepage-Container neu erstellen. Keine Auth-Datenvolumes oder Geräteidentitäten zurücksetzen. Details und manuelle Abnahme im Übergabedokument „JMS-Internal-Umstellung-2026-10-17“.

## Aufbau

Im Standardbetrieb läuft Kesher als Docker-Container:

- `systemd` startet `docker compose`
- Containername: `kesher`
- Web/API/WebSocket: `127.0.0.1:8080/tcp`, von außen ausschließlich über Caddy
- Seit 17.10.2026: Linux-Hostnetz für erreichbare WebRTC-ICE-Kandidaten; kein unverschlüsselter UDP-Audio-Relay
- Datenbank: SQLite im Docker-Volume `intercom_data`
- Healthcheck: `/api/healthz`

Auf dem JMS-Server ist Caddy der verbindliche HTTPS- und Authentifizierungseinstieg.

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
cd /home/master/intercom-system/Kesher
docker compose -f deploy/compose/docker-compose.yml up -d --build
```

Stoppen:

```sh
cd /home/master/intercom-system/Kesher
docker compose -f deploy/compose/docker-compose.yml down
```

## Wichtige Ports

| Port | Zweck |
| --- | --- |
| `127.0.0.1:8080/tcp` | internes Backend für Caddy und serverseitige Dienste |
| dynamische UDP-Ports | authentifiziertes WebRTC: ICE, DTLS und verschlüsseltes SRTP; kein allgemeiner HTTP-Zugang |
| `8081/udp` | alter unverschlüsselter Audio-Relay; abgeschaltet |
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
- **Uhrzeit**: nicht mit dem Internet abgeglichen (Störung) oder Hardware-Uhr geht falsch (Warnung). Nach einem Stromausfall stand die Uhr beim Start schon auf dem 27.07. – dann scheitern Zertifikate (Companion → Kesher, Tailscale), bis die Zeit übers Internet kommt. Ursache ist fast immer die leere CMOS-Batterie (CR2032) auf der Hauptplatine. Die Neustart-Meldung weist darauf hin.
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

## Einheitlich HTTPS auf dem JMS-Server

Alle Weboberflächen sind unter `https://192.168.0.21:<gewohnter Port>` erreichbar. Caddy übernimmt die Ports nach außen, die HTTP-Backends lauschen nur auf `127.0.0.1`. Alte `http://`-Links werden auf demselben Port auf `https://` umgeleitet. Kiosk und Companion-Modul verwenden inzwischen ebenfalls verifiziertes HTTPS mit individuellem Gerätenachweis. Zertifikate kommen von Caddys lokaler Zertifizierungsstelle; die öffentliche Server-CA muss auf dem Endgerät vertrauenswürdig installiert sein. Zertifikatswarnungen nicht wegklicken und keine TLS-Prüfung abschalten. Lokales HTTP ist ausschließlich für interne Dienste mit weiterhin erforderlichen gültigen Nachweisen vorgesehen.

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

Historische HTTPS-Erstumstellung (bereits erfolgt; nicht als erneute Anleitung für die Geräteumstellung verwenden):

1. Sicherung: `/etc/caddy/Caddyfile`, Compose-Dateien in `/opt/homelab/compose`, Companion-Konfiguration.
2. Dienste auf `127.0.0.1` umstellen: Homepage-Compose `127.0.0.1:3000:3000`, Portainer-Compose `127.0.0.1:9443:9443`, Glances, Companion (Admin-Oberfläche nur lokal), Multiview (in `multiview/docker-compose.yml` die Zeile `HOST: "127.0.0.1"` einkommentieren, dann `docker compose up -d`).
3. `sudo cp Caddyfile.jms /etc/caddy/Caddyfile && sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy`
4. Prüfen: jede Adresse per `https://` und die Weiterleitung von `http://`; Kiosk-Anzeige, Companion-Tasten (Generic HTTP auf `http://127.0.0.1:8090`), Kesher-Clients und Raspberry Pis.
5. Links im Dashboard und in Notion auf `https://` umstellen: Dateien aus `Kesher/server-config/homepage/` übernehmen (siehe [Dashboard](#dashboard)).

## Anmeldung für alle Dienste

Intercom, Dashboard und JMS Control verwenden dieselbe zentrale Anmeldung: ein nicht ausgenommenes Gerät benötigt zuerst den **Tagescode**, danach **Name und gültige Rolle**. Admins können sich auf jeder Oberfläche direkt mit Name und PIN anmelden, um den aktuellen Code abzurufen; dadurch gibt es keine allgemeine JMS-Control-Ausnahme mehr. Companion, Portainer, Glances, DNS und Router benötigen Adminrechte. IP-Port-Adressen und die ausdrücklich registrierten `.local`-/`.jms.de`-Adressen gleichen Sitzungen über kurzlebige, einmalige und browsergebundene PKCE-Tickets ab.

- **Einstellungen:** JMS Control → *Benutzer & Rechte*. Die bestehende PIN und Gatewaykonfiguration bleiben beim Update erhalten. Alte Sitzungen und Gerätefreigaben werden beim Wechsel auf Sicherheitsformat 3 ungültig; einmal neu anmelden. Fehlende oder beschädigte `access-secret.json` sperrt den Start, statt anonymen Adminzugang zu öffnen. Die PIN kann nicht mehr ersatzlos abgeschaltet werden.
- **Zeitregel:** Codewechsel um 00:00, Ablauf sämtlicher persönlicher Sitzungen einschließlich Admin spätestens um 05:00 **Europe/Berlin**. Bestehende Freigaben vom Vortag gelten nach Mitternacht nur bis 05:00. Auch eine Anmeldung zwischen 00:00 und 05:00 endet an diesem Morgen. Ab 05:00 gilt der nächste Morgen als Grenze. Sommer-/Winterzeit wird berücksichtigt. QR- und SSO-Übernahmen verlängern diese Frist nicht. Der neue Tagescode ist nur für Admins und feste Anzeigestationen abrufbar.
- **Versuchslimits:** Tagescode und Admin-PIN: acht Fehlversuche pro Quelladresse in 15 Minuten; zusätzlich begrenzte parallele PIN-Prüfungen. Die zentrale PIN-Sperre überlebt einen Neustart. Kesher schützt auch seine eigene PIN-Schnittstelle.
- **Feste Geräte:** sämtliche IP-Ausnahmen sind durch individuell registrierte kryptografische Nachweise ersetzt. IP- und MAC-Adressen dienen nur noch der Netzdiagnose, nicht als Anmeldeberechtigung. Server-Kiosk und Kamera-Pi sind mit Clientzertifikaten, der Kesher-Monitor und das Companion-Modul mit getrennten Dienstschlüsseln provisioniert. Andere frühere IP-Ausnahmen benötigen wieder Tagescode und Rollenlogin oder eine bewusste individuelle Provisionierung.
- **Abmelden:** in Kesher über „Abmelden“, im Dashboard über *Konto → Abmelden*. Das meldet auf allen Diensten ab; die Freischaltung mit dem Code bleibt für den Tag.
- **Technik:** Caddy prüft HTTP-Anfragen über `/.jms-auth/check`. WebSocket-Upgrades laufen zusätzlich durch den zentralen widerrufbaren Proxy; Logout beendet bereits offene Verbindungen. `X-JMS-Gateway` und `X-JMS-Session-Id` werden am Proxy entfernt und ausschließlich aus dem Prüfergebnis neu gesetzt. Kesher-Rollen und -Admins verwenden einmalige signierte Tickets mit zentraler Sitzungs-ID, Version und Ablauf; Kesher prüft den Parent bei HTTP-Anfragen und sekündlich für offene Verbindungen. Bei Ausfall der Prüfung bleibt der Zugang gesperrt. Beide Compose-Umgebungen benötigen dasselbe `JMS_AUTH_SECRET`; Kesher zusätzlich `JMS_AUTH_URL` und das schreibgeschützte öffentliche Caddy-CA-Zertifikat unter `JMS_AUTH_CA_FILE`. Es gibt keinen unsicheren Browser-Fallback auf unabhängige Kesher-Sessions. Native feste Stationen bleiben separat zugelassen.
- **Rechte:** Steuernde Browseranfragen verwenden POST und Herkunftsprüfung. Die GET-Kompatibilität für Companion bleibt nur für echte Maschinenaufrufe ohne Browsermetadaten erhalten. Multiview-Konfiguration, Chat und WebSocket-Nachrichten werden nach Rolle gefiltert. ProPresenter-Foliensteuerung benötigt das explizite Rollenrecht *Folien steuern*; Layoutbearbeitung allein genügt nicht.
- **PIN-Wechsel:** Änderungen widerrufen betroffene Sitzungen und ausstehende Tickets. Kesher-PIN-Änderungen benötigen einen erfolgreichen signierten Widerruf beim zentralen Dienst. Vollständige Sitzungstokens dürfen nicht in Logs geschrieben werden.
- **Companion Satellite:** die alten Klartextzugänge TCP 16622 und WebSocket 16623 sind von außen vollständig gesperrt. Externe Stationen verwenden den mTLS-geschützten Bridge-Port 16624 mit eigener Geräteidentität und der Berechtigung `satellite`; keine zusätzlichen IP-Ausnahmen anlegen. Auf dem Pi vermittelt `jms-satellite-tls.service` von Loopback 16622; Satellite REST 9999 ist deaktiviert. Das Companion-Modul nutzt den System-CA-Speicher mit `--use-system-ca`, nicht eine abgeschaltete TLS-Prüfung.
- **Rollen:** werden im Multiview unter *Benutzer & Rechte* angelegt, umbenannt (die ID bleibt) und gelöscht; der Multiview speichert sie über ein Ticket sofort in Kesher. Mit „Rechte übernehmen von“ bekommt eine neue Rolle Party Lines, Stream-Deck-Tasten und Multiview-Rechte einer bestehenden. Beim Löschen gehen die Kesher-Benutzereinträge der Rolle mit; solange jemand mit ihr angemeldet oder in Kesher verbunden ist, geht es nicht. Im Kesher-Admin stellt man dann nur noch Party Lines und Standardwerte der Rolle ein. Braucht `JMS_AUTH_SECRET` wie oben.
- **Telegram:** im Modus `polling` (Standard) nicht betroffen.

### Sicherheitsupdate 17.10.2026: Prüfung und Rückweg

Vor dem Update wurden die beiden Anwendungscontainer für konsistente Datensicherungen kurz gestoppt. Sicherung: `/home/master/backups/auth-hardening-20261016T214913Z` (nur Eigentümerzugriff), einschließlich Quellstand, Caddy/Homepage, beider Datenvolumes und SHA-256-Prüfsummen. Vorherige Images: `jms-multiview:auth-rollback-20261016` und `compose-intercom:auth-rollback-20261016`.

Prüfung: Node-Regressionen einschließlich echtem isoliertem HTTP-/WebSocket-Server und IP-/Namens-SSO; Go-Tests einschließlich Race-Tests für zentrale Tickets, Parentwiderruf und PIN-Limits; vorhandene Frontendtests und Produktionsbuild. Die Tests steuern keine produktiven Ausgänge oder Audiogeräte. Die SQLite-Tabelle `central_ticket_redemptions` ist eine additive, automatisch ausgeführte Migration zur Replayabwehr und löscht keine vorhandenen Nutzerdaten.

Rollback nur kontrolliert im Wartungsfenster: neue Container stoppen, vorherige Images verwenden, Caddy/Homepage und bei Bedarf den gesicherten Quellstand wiederherstellen. Vor dem Rückspielen eines Datenvolumes immer den aktuellen Stand zusätzlich sichern; die Sicherung enthält den Stand **vor** diesem Update. Alte Images ohne wiederhergestellten kompatiblen Sicherheitszustand nicht als fertigen Rollback betrachten. Die zusätzliche SQLite-Tabelle kann bestehen bleiben. Die Satellite-Regeln lassen sich separat mit `systemctl disable --now jms-satellite-firewall.service` entfernen; Companion-TLS-Konfiguration nur aus der Sicherung zurücksetzen, wenn tatsächlich erforderlich. Ein Rollback stellt auch die alten Sicherheitslücken wieder her und ist keine dauerhafte Lösung.

### Geräteauthentifizierung: ausgerollt am 17.10.2026

Die Geräteauthentifizierung ist auf Server und Kamera-Pi ausgerollt. Die Abschlussprüfung am 17.10.2026 um 11:13 Uhr Europe/Berlin besteht mit 234 produktiven Protokollprüfungen über 23 HTTPS-Ursprünge: vier IP-/Port-Einstiege, zehn `.local`- und neun `.jms.de`-Namen. Login, unveränderte SSO-Identität/Rolle/Ablaufzeit, Rechteabgrenzung, zentrale Abmeldung und Widerruf eines offenen WebSockets sind bestätigt. Gezielt zum Server geroutete HTTPS-Aufrufe mit geprüfter CA beweisen nicht die iPhone-DNS-Auflösung. Die Testanmeldung wurde beendet; keine realen Ausgänge oder Audiogeräte angesteuert.

Erneut bestanden: 96 Node-, 307 Frontend- und 42 Pi-Launcher-Tests, Frontend-Produktionsbuild, Go-Vollsuite und gezielte Race-Tests. Sechs Companion-Sicherheitsprüfungen und der Modulbuild bestanden bereits bei der vorherigen Bereitstellung. Die vier VPN-Anmeldemasken und das Adminformular wurden im Desktopbrowser ohne erfasste Konsolenwarnungen/-fehler geöffnet. Physische iPhone-/Tablet-/Headset-Abnahme, angemeldete Safari-E2E-Prüfung und echter Nachtablauf bleiben offen; deterministische 00:00-/05:00-/Zeitumstellungstests bestehen.

- Jede feste Station besitzt ein eigenes Clientzertifikat samt privatem Schlüssel. Caddy prüft die Geräte-CA; die zentrale Registry prüft zusätzlich SHA-256-Fingerprint, Version, Ablauf und Widerruf. Ein anderer Rechner mit derselben IP oder MAC erhält dadurch keine Berechtigung. Für interne Serverdienste gibt es getrennte, zufällige Dienstschlüssel; sie werden nicht an Browser ausgeliefert.
- HTTPS-Aufrufe über eine IP-Adresse senden nicht zuverlässig TLS-SNI. Deshalb ist die zusätzliche SNI/HTTP-Host-Gleichheitsprüfung ausschließlich auf den ausdrücklich konfigurierten IP-Listenern abgeschaltet; die Namens-Listener behalten sie bei. Das deaktiviert weder TLS noch die Clientzertifikats-/CA-Prüfung. Alle Listener prüfen vorgelegte Gerätezertifikate gegen dieselbe Geräte-CA; Fingerprint, Dienstrechte und Widerruf werden unabhängig vom Host für jede Anfrage geprüft.
- **Nur ohne Tagescode:** das Gerät überspringt ausschließlich die Codefreigabe. Name/Rolle beziehungsweise Admin-PIN bleiben erforderlich. Persönliche Sitzungen enden weiterhin um 05:00 Uhr.
- **Technikstation:** ausschließlich ausdrücklich freigegebene Dienste und Funktionen. Intercom-Anmeldung muss zur registrierten Rolle passen. Eine Maschinenidentität allein erhält keine Adminrechte; auch die native Kesher-Anmeldung kann durch Mitgeben einer PIN nicht zum Admin werden. Ein Mensch kann sich im Stationsbrowser getrennt über die zentrale Adminmaske mit gültiger PIN anmelden; diese persönliche Sitzung hat Vorrang und endet spätestens um 05:00. Geräteablauf beziehungsweise Widerruf gilt unabhängig von Tagescode und persönlicher Sitzung.
- Verwaltung unter JMS Control → *Benutzer & Rechte* → *Registrierte Geräte*. Zuerst ein Zertifikat von der Geräte-CA ausstellen, dann seinen Fingerprint, Ablauf und die minimal notwendigen Berechtigungen eintragen. Ein registrierter Fingerprint ohne gültiges Zertifikat und privaten Schlüssel reicht nicht aus. Für Pis müssen zusätzlich die bestehende Pi-Konfiguration, deren Geräte-ID und Rolle übereinstimmen.
- Stationsdateien liegen unter `/etc/jms-device/`: `client.crt`, `client.key` und das öffentliche Server-CA-Zertifikat. Private Schlüssel ausschließlich dem benötigten Dienstbenutzer zugänglich machen; keine Schlüssel in URLs, Git, Bildschirmfotos, Browser-JavaScript oder Logausgaben. Chromium erhält das Clientzertifikat in seinem dedizierten Stationsprofil; TLS-Warnungen niemals durch Abschalten der Prüfung umgehen.
- Geräteverlust: sofort *Widerrufen*. HTTP-Folgezutritte, Intercom-Sitzungen, offene WebSockets und Medien werden gesperrt; eine offline gewesene Station darf sich danach nicht wieder verbinden. Zertifikatswechsel über *Zertifikat ersetzen* mit neuem Fingerprint und anschließendem Austausch auf der Station. Alten Schlüssel nicht wiederverwenden. Ein kompromittiertes Betriebssystem kann lokale Schlüssel entwenden; Gerätezugriff und Betriebssystemupdates bleiben notwendig.
- Kesher erhält ausschließlich kurzlebige, signierte `X-JMS-Device-Assertion`-Nachweise. HTTP-Zugriffe und laufende Sitzungen werden beim zentralen Dienst nachgeprüft; Störungen sperren statt freizuschalten. Gerätegebundene Tokens bleiben nach Widerruf auch am internen Backend ungültig. Bei konfiguriertem `JMS_AUTH_URL` ist das bisherige gemeinsame Companion-Secret weder Voraussetzung noch Zugangsersatz.
- Sicherheitsformat 3 übernimmt keine alten IP-Ausnahmen oder persönlichen Sitzungen automatisch. Vor dem Umschalten alle benötigten Stationen bewusst provisionieren und testen. Einen gesicherten persönlichen Adminzugang bereithalten; niemals zur Fehlerbehebung eine globale IP-/Netzbereichsfreigabe aktivieren.

Die aktuellen Geräte-Zertifikate sind für ein Jahr ausgestellt. Rechtzeitig vor Ablauf mit neuem Schlüssel und Fingerprint ersetzen; Browser/NSS-Import und Registry koordiniert aktualisieren. Geräte-CA und Server-CA sind verschiedene Vertrauensanker. Der CA-Privatschlüssel bleibt ausschließlich geschützt auf dem Server unter `/etc/jms-auth/device-ca-private/`.

**Companion-Laufzeit:** Der Node-Worker erlaubt Dateizugriff nur im Modulverzeichnis und übernimmt die systemd-Umgebungsvariablen nicht. Der individuelle Schlüssel liegt deshalb unter `/opt/companion-module-dev/companion-module-kesher/jms-device.key`, Modus `0640 root:companion`, das Modulverzeichnis gehört root. `deviceTransport.ts` bestimmt diesen Ort relativ zum tatsächlichen Worker-Einstiegspunkt. Die öffentliche Caddy-CA ist unter `/usr/local/share/ca-certificates/jms-caddy-root.crt` im Systemvertrauen installiert. Die vier vorhandenen Modulinstanzen verwenden ausschließlich HTTPS/WSS mit verifizierten Zertifikaten; keine globalen Node-Dateirechte freigeben.

**Caddy 2.6.2:** `default_sni 192.168.0.21` und ebenfalls klientenzertifikatsgeprüfte No-SNI-Policies sichern IP-Aufrufe ab. Ein Regex-Mapping überträgt nur echte 64-stellige SHA-256-Fingerprints; ein nicht aufgelöster Platzhalter ist kein Gerätenachweis. `order request_header before forward_auth` entfernt gefälschte Eingangsdaten vor der Prüfung, ohne anschließend die gerade verifizierten Header wieder zu löschen. Regressionstests liegen in `multiview/test/caddy-device.test.js`.

**Pi-Verbindungsstatus:** Die Zuordnung zwischen Launcher-Heartbeat und Intercom-Verbindung verwendet die registrierte Geräte-ID und Rolle statt eines veränderlichen Anzeigenamens. Ein Gerät mit `heartbeat` darf am bestehenden Statusendpunkt ausschließlich seinen eigenen Status lesen, aber keine fremde Station sehen oder fernsteuern. Nur `pi-manage` beziehungsweise die bestehende berechtigte persönliche Rolle erhält den weitergehenden Zugriff. Dadurch vermeidet der Launcher falsche Verbindungsfehler und unnötige Browserneustarts. Gegenfälle für fremde IDs, fehlende Rechte, Widerruf und Auth-Ausfall sind getestet.

**Sicherung/Rückweg:** `/home/master/backups/device-auth-20261017` enthält konsistente Daten-, Quell- und Systemkopien; vorherige Images heißen `jms-multiview:device-rollback-20261017` und `compose-intercom:device-rollback-20261017`. Clientbackups liegen auf dem jeweiligen Gerät unter `/var/backups/jms-device/`. Vor Rückspielen den aktuellen Stand erneut sichern und Server, Registry, Caddy, Clientzertifikate/NSS, Companion und Satellite koordiniert zurücksetzen. Keine pauschale Wiederherstellung laufender SQLite-Dateien und kein dauerhaftes Wiederöffnen alter IP-/Klartextzugänge.

### Frühere .local-Namensauflösung und VPN-Pilot (historisch)

Seit 17.10.2026 veröffentlicht der bestehende Dienst `avahi-cname-aliases.service` die elf vorhandenen `.local`-Namen direkt als A-Adressen für `192.168.0.21`, statt CNAME-Verweise auf `server.local` zu senden. Dienstname und bestehende Avahi-Integration bleiben erhalten; es wurde kein zweites DNS-System eingerichtet. Router, DHCP und WLAN-Konfiguration wurden nicht geändert.

Auf dem Kamera-Pi, verbunden ausschließlich über WLAN, wurden direkte mDNS-Antworten sowie normale Systemauflösung und verifizierte HTTPS-Aufrufe für `intercom.local`, `technik.local` und `jmscontrol.local` bestätigt. Dabei wurde kein Clientzertifikat verwendet: die zentrale Anmeldung verlangte weiterhin den Tagescode. Das ist kein Nachweis für jedes Handy: Gastnetz-/Multicastfilter, VPN und fehlende mDNS-Unterstützung des jeweiligen Clients können weiterhin stören. Auf dem echten Handy explizit `https://intercom.local` und `https://technik.local` im Veranstaltungs-WLAN testen; einen Namensfehler von einer TLS-Warnung unterscheiden. HTTPS-IP bleibt der sichere Ausweichzugang. mDNS ist keine Geräteauthentifizierung.

Die ursprüngliche Alias-Konfiguration ist unter `/home/master/backups/mdns-addresses-20261017` gesichert. Ein gezielter Rückweg betrifft nur `/usr/local/sbin/avahi-cname-aliases.py` und den Neustart des gleichnamigen Dienstes.

**VPN-DNS:** Das MacBook löst die elf `.local`-Namen bereits über vorhandene `/etc/hosts`-Einträge auf; dies beweist keine mDNS-Weiterleitung durch Tailscale. Die eingeschränkte Tailscale-Regel `jms.de` → `192.168.0.21` ist inzwischen vom Benutzer eingerichtet und im Tailnet aktiv. Alle vier Hauptnamen wurden am Mac ohne `.jms.de`-Overrides über reguläre Namensauflösung mit verifiziertem HTTPS geprüft; der Benutzer bestätigt `intercom.jms.de` am Handy. Die vorhandenen neun `.jms.de`-Einträge bleiben als Rückfall erhalten. Backup vor deren früherer Ergänzung: `/home/master/backups/mdns-addresses-20261017/AdGuardHome.before-vpn-dns.yaml`.

**Gleiche Namen vor Ort und über VPN:** Auf Wunsch des Benutzers enthält der bestehende AdGuard nun einzelne Rewrites für alle elf vorhandenen Namen auf `192.168.0.21`: `intercom.local`, `kesher.local`, `jmscontrol.local`, `dashboard.local`, `technik.local`, `portainer.local`, `companion.local`, `glances.local`, `dns.local`, `setup.local`, `router.local`. Kein Wildcard-Eintrag für `.local`; mDNS, Authentifizierung, Rollen und HTTPS-Konfiguration bleiben unverändert. Prüfung: alle elf Namen über UDP/TCP korrekt, AAAA/HTTPS-RR ohne Fehler; alle neun `.jms.de`-Namen erhalten; unbekannter `.local`-Name weiterhin NXDOMAIN; zehn HTTPS-Start-/Anmeldeseiten mit geprüfter CA erreichbar, `setup.local` weiterhin HTTP. Der WLAN-Pi löst alle elf Namen auf und erreicht die drei Hauptdienste mit verifiziertem HTTPS.

**Historische VPN-Prüfung am 17.10.2026 ab 10:49 Uhr Europe/Berlin:** Mit der damaligen Sammelregel `local` wurden elf Namen direkt über den VPN-Resolver `100.100.100.100` auf `.21` aufgelöst; zehn HTTPS-Startseiten mit geprüfter CA HTTP 200, die bestehende HTTP-Einrichtungsseite `setup.local` ebenfalls 200. Diese Prüfung war keine iPhone-Abnahme. **Aktuell** enthält die gelieferte Tailnet-Konfiguration stattdessen die engere Einzelregel `intercom.local` sowie weiterhin `jms.de`.

**iPhone-Abnahme fehlgeschlagen:** Der Benutzer meldet `intercom.local` schwarz bzw. dauerhaft ladend, während `intercom.jms.de` funktioniert. Auch nach Umstellen auf die Einzelregel `intercom.local` und erneutem Verbinden bleibt der Fehler bestehen. Ein begrenzter Mitschnitt zeigt um 10:56:54 Uhr Europe/Berlin DNS-Anfragen/Antworten für `intercom.jms.de` und TCP-Verbindungsaufbau auf 443, aber keine DNS-Anfrage für `intercom.local` im Vergleich. Verdacht: iOS-mDNS-Sonderbehandlung; Cache oder andere lokale DNS-Einstellungen sind damit nicht ausgeschlossen. Weder Sammel- noch Einzelregel ist eine bestätigte iPhone-Lösung. Keine Auth-/TLS-/Firewallprüfung wurde aufgeweicht.

**Einschränkung und Rückweg:** Zertifikatsvertrauen, SSO/Audio und Vor-Ort-Funktion gesondert prüfen. Den erfolglosen `intercom.local`-Pilot in der Tailscale-Adminseite entfernen, `jms.de` erhalten; dieser Adminseiten-Schritt ist noch offen. Keine weiteren Einzelregeln als bestätigte Lösung ausrollen. AdGuard enthält weiterhin nur elf exakte Einträge; kein Neustart nötig. Für dauerhaft gleiche URLs im WLAN und VPN eine reguläre, von JMS kontrollierte DNS-Zone mit passender WLAN-DNS-Zuweisung verwenden. Eigentümerschaft der bestehenden Zone `jms.de` ist noch nicht geprüft; keine öffentliche DNS- oder Routeränderung durchgeführt.

**Letzte WLAN-Nachprüfung:** Kamera-Pi ausschließlich auf `wlan0`, `eth0` ohne Verbindung. Alle elf Namen normal auf `.21` aufgelöst; Intercom, Technik und JMS Control mit `Accept: text/html` sowie expliziter CA `/etc/jms-device/server-ca.crt` über HTTPS 200. Die CA ist dienstbezogen eingebunden, nicht im allgemeinen curl-Systemvertrauen. Satellite-Tunnel, Launcher und Glances aktiv. `arecord -l` meldet kein Aufnahmegerät; physisches Mikrofon/Audiointerface vor der Audioabnahme anschließen.

**Notion und Übergabe:** Die Seite „JMS Server“ ist mit aktuellem Auth-/VPN-Stand, Testnachweisen und offenen Geräteprüfungen aktualisiert. Vorhandene Klartextzugänge bleiben bewusst unverändert, weil der Benutzer noch keine externe Sicherung hat. Erst sicher in einem zugriffsbeschränkten Passwortspeicher ablegen und Zugriff prüfen, danach aus der Betriebsdokumentation entfernen und bei möglicher Offenlegung koordiniert rotieren. Keine Geheimnisse in Testprotokolle übernehmen.

**Sicherung der früheren DNS-Erweiterung:** Zehn neue Rewrites gegenüber dem Intercom-Einzelpilot sind durch semantischen Vergleich als einzige damalige Konfigurationsänderung bestätigt. Sicherung: `/home/master/backups/mdns-addresses-20261017/AdGuardHome.before-all-local-vpn.yaml`; der Zustand vor allen `.local`-Rewrites liegt daneben als `AdGuardHome.before-intercom-local-vpn-pilot.yaml`. Falls auch diese Erweiterung zurückgenommen werden soll, nur die betreffenden Rewrites entfernen; vollständige Sicherungen ausschließlich bei gestopptem AdGuard und nach Prüfung späterer Änderungen zurückspielen.

### Audio und Docker-Netzwerk

Der alte UDP-Relay auf 8081 überträgt Audio und die Erstregistrierung unverschlüsselt und schützt weitere Pakete nur mit einem kurzen Tokenhash. Er ist mit `UDP_AUDIO_ADDR: ""` ausgeschaltet und nicht veröffentlicht. Web und native Clients verwenden stattdessen den bestehenden WebRTC-Pfad mit ICE sowie DTLS-SRTP. Auch eine native Anfrage `transport=native` fällt bei abgeschaltetem Relay auf WebRTC zurück.

Die Linux-Compose-Konfiguration verwendet `network_mode: host`, damit Pion die tatsächlichen LAN-/VPN-Adressen statt unerreichbarer Docker-Bridge-Adressen bekanntgibt. Das HTTP-Backend ist dabei ausdrücklich auf **`127.0.0.1:8080`** gebunden, nicht auf alle Interfaces; Caddy bleibt der externe HTTPS-Einstieg. Es gibt keine Portweiterleitung eines HTTP-Backends ins LAN. Die Netzwerkisolation des Containers entfällt bewusst; andere Container-/Dateisystemgrenzen bleiben bestehen. Keine zusätzlichen privilegierten Containerrechte sind dafür nötig.

Prüfung nach dem Deployment, ohne Mikrofon oder Produktionsausgänge anzusteuern:

```sh
docker inspect --format '{{.HostConfig.NetworkMode}}' kesher
sudo ss -ltnp 'sport = :8080'
sudo ss -lunp 'sport = :8081'
curl --fail http://127.0.0.1:8080/api/healthz
```

Erwartung: Netzwerkmodus `host`, HTTP nur `127.0.0.1:8080`, kein Kesher-Listener auf UDP 8081, Healthcheck erfolgreich. Zusätzlich von einem zweiten Rechner prüfen, dass `192.168.0.21:8080` nicht erreichbar ist, HTTPS 8443 aber weiterhin authentifiziert funktioniert. Die zentrale Chat- und Rollenverwaltung spricht intern `http://127.0.0.1:8080` an; gültige Geräte-/Sitzungsnachweise bleiben trotzdem erforderlich.

Ein erfolgreicher Login oder WebSocket beweist noch keine Audioverbindung. In der Intercom-Diagnose muss WebRTC/ICE auf verbunden wechseln; die ausgewählte Kandidatenverbindung muss eine erreichbare Serveradresse verwenden. WLAN-/VPN-Regeln müssen direkte UDP-Verbindungen zum Server zulassen; isolierte Gastnetze oder ein nur für HTTPS freigegebener VPN können Audio weiterhin verhindern. Es wird nicht automatisch ein externer TURN-Dienst verwendet. Die lokalen Regressionstests prüfen Signalisierungsfallback, sichere Compose-Bindung sowie einen synthetischen Pion-DTLS-/SRTP-Paketaustausch ohne Mikrofon; die tatsächliche Netzstrecke, Mikrofonfreigabe, Lautsprecher, PTT, Echo und Hintergrundverhalten sind vor Ort separat abzunehmen. Keinesfalls den alten unverschlüsselten Relay als dauerhaften Workaround wieder einschalten.

## Dashboard

Das Dashboard (Homepage, `https://technik.internal`, IP-Rückfall `https://192.168.0.21:3000`) hat oben zwei Seiten zum Umschalten:

- **Start** – für alle: Intercom, Raspberry fernsteuern, Multiview, Fernbedienung, Prediger-Ansicht sowie *Konto* (Abmelden, Konto wechseln).
- **Admin** – Companion, Portainer, Glances, lokaler DNS, Router; Serverwerte (Prozessor, Arbeitsspeicher, Temperatur, Laufwerk, Prozesse, Container-Auslastung), darunter dieselben Werte für jeden Raspberry Pi (Abschnitt *Raspberry Pis*, Glances auf dem Pi, siehe `RASPBERRY-PI-STATIONEN.md`) und der Zustand jedes Containers.

Die Admin-Seite sieht nur, wer im Dashboard als Admin angemeldet ist (`custom.js` fragt `/.jms-auth/api/me`); alle anderen sehen nur „Start“ ohne Umschaltleiste – als Admin anmelden über *Konto → Konto wechseln*. Ist die zentrale Anmeldung aus, sehen alle beide Seiten. Die Admin-Dienste selbst prüft Caddy unabhängig davon.

Konfiguration im Repo unter `Kesher/server-config/homepage/` (`settings.yaml`: welche Gruppe auf welcher Seite, `services.yaml`: Kacheln, `custom.js`, `custom.css`). Auf dem Server liegen sie in `/opt/homelab/config/homepage/` (gehört root – ohne sudo per `docker cp <datei> homepage:/app/config/` kopieren). Änderungen an `settings.yaml` wirken erst nach `docker restart homepage`. **Danach** einmal `curl -s -H "Host: dashboard.local" http://127.0.0.1:3000/api/revalidate` auf dem Server – sonst liefert Homepage nach dem Neustart noch die alte, vorgefertigte Seite aus (fehlende Gruppen, falsche Reiter).
