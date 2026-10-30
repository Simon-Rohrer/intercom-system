# Betrieb

Dieses Dokument enthält nur die wichtigsten Betriebsinformationen für den Kesher-Server.

## Einheitliche .internal-Adressen – Stand 17.10.2026

Die Serverumstellung ist aktiv: `https://intercom.internal`, `https://jmscontrol.internal`, `https://technik.internal`, `https://companion.internal`, `https://portainer.internal`, `https://glances.internal`, `https://dns.internal`, `https://router.internal` und `https://setup.internal`. Gleichwertige Aliase: `kesher.internal`, `multiview.internal`, `dashboard.internal`. Alle zwölf DNS-Einträge zeigen auf `192.168.0.230`. Dashboard-Verknüpfungen, HTTPS-VHosts und die exakte SSO-Allowlist verwenden die neuen Namen; Rollen und Geräteprüfung bleiben unverändert. Es gibt keine Wildcard-SSO-Freigabe.

**Noch offen: DNS-Verteilung an Clients.** Der ausschließlich per WLAN verbundene Pi erhält DNS und DHCP von `192.168.0.5`, Gateway `192.168.0.1`. Der Benutzer hat nur Zugriff auf `192.168.0.250`, nach seiner Angabe vermutlich im Access-Point-Modus. Es wurde keine Router-/DHCP-/Tailscale-Admin-Einstellung geändert. Eine DNS-Einstellung für den Access Point selbst verteilt nicht automatisch DNS an dessen WLAN-Clients. Kein zweiter DHCP-Server im bestehenden Netz!

- Tailscale-Admin → DNS → Nameservers → Add nameserver → Custom: `192.168.0.230`, „Restrict to domain / Split DNS“ an, Domain `internal` (ohne Punkt oder Stern), speichern. Kein globales DNS-Override nötig. Client: Tailscale-DNS an, Exit Node None, VPN neu verbinden. Die Regel gilt für entsprechend konfigurierte Geräte dieses Tailnets, nicht für beliebige WLAN-Gäste. Erst nach erfolgreicher Abnahme erfolglose `.local`-Pilotregeln entfernen; `.jms.de` vorläufig als Rückfall behalten.
- Für automatische WLAN-Auflösung muss der zuständige Administrator auf DNS `192.168.0.5` die Zone `internal` an `192.168.0.230` weiterleiten. DNS UDP/TCP 53 muss erreichbar sein. Vorhandene interne Zonen/AD-Abhängigkeiten prüfen; nicht pauschal DNS für das gesamte Netz ersetzen. Ohne diesen Zugriff geht das in der heutigen AP-/Bridge-Struktur nicht automatisch für alle Geräte. Eine eigene geroutete WLAN-Zone wäre ein separates, vor Ort zu planendes Netzprojekt, keine beiläufige DHCP-Änderung.
- In AdGuard bleiben die bisherigen Upstream-DNS-Server erhalten. Zwölf exakte Rewrites beantworten bekannte Namen; die DNS-Rewrite-Regel `||internal^$dnsrewrite=NXDOMAIN;;` beantwortet unbekannte Namen lokal, statt sie zurück an `.5` zu leiten. Bekannte AAAA-/HTTPS-/SOA-/MX-Anfragen liefern NOERROR ohne Antwort. Kein Wildcard-A-Eintrag. Rewrites/Regel nicht ohne Ersatz entfernen.
- Bestehende Caddy-Root-CA beibehalten; neue Dienstzertifikate werden darunter ausgestellt. Bereits vertrauende Geräte benötigen keine neue CA. Neue Geräte brauchen einmalig CA-Vertrauen oder zentrale MDM-Verteilung; `.internal` bietet nicht automatisch öffentlich vertrauenswürdige Zertifikate. iPhone: Zertifikatsprofil installieren, dann Einstellungen → Allgemein → Info → Zertifikatsvertrauenseinstellungen → volles Vertrauen. Vorher Echtheit über einen unabhängigen vertrauenswürdigen Kanal prüfen. SHA-256: `6B:5C:BD:1B:2E:14:FF:D5:5D:78:76:60:39:B1:EE:B3:1F:BD:32:90:43:9A:94:E9:2C:AD:98:45:B3:C9:26:8E`. HTTP-Download allein ist kein Echtheitsnachweis; Warnungen nicht umgehen.

**Kompatibilität:** Bisherige IP-Port-/`.local`-/`.jms.de`-Zugänge bleiben als befristeter Migrationsrückweg bestehen. Der zentrale SSO-Hub bleibt absichtlich `https://192.168.0.230:8090`, damit IP-Zugriff und noch nicht umgestellte DNS-Clients weiter funktionieren. Das ist dieselbe Anmeldung, kein zweiter Auth-Dienst. Native Maschinen-/Backend-Adressen wurden nicht unnötig geändert. Nach vollständiger WLAN-/VPN-Abnahme kann die Entfernung alter Aliase separat geplant werden.

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
| `8011/udp` (eingehend) | OSC-Empfang vom grandMA3 (Kachel „Licht“), Port in den Einstellungen änderbar |
| `→ 192.168.1.70:51325/tcp` (ausgehend) | MIDI over TCP zur Avantis (Kachel „Mischpult“), nur mitlesen |

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

**Keine Stream-Meldungen:** Auf diesem Server ist `YOUTUBE_STATUS_URL=` in `/etc/jms-watch/watch.env` ausdrücklich leer. Damit entfallen sämtliche Stream-/YouTube-Meldungen: Upload-/Bitratenwarnungen, Encoder- und Empfangsstörungen, Entwarnungen, Angaben in `/status` und die Zusammenfassung nach Stream-Ende. Beim Abschalten wurden auch gespeicherte Stream-Störungen und eventuell wartende Stream-Meldungen entfernt, damit keine nachträgliche Entwarnung verschickt wird. Die anderen Servermeldungen und die YouTube-Kachel in JMS Control bleiben aktiv. Die Einstellung bleibt bei Updates des Watch-Dienstes erhalten.

Wird ein Container absichtlich länger gestoppt, meldet der Bot das nach 3 Minuten einmal. Soll das nicht passieren, den Container in `IGNORE_CONTAINERS` eintragen.

## Dropbox-Ordner für die Diashow

JMS Control → Einstellungen → Verbindungen → **Dropbox**. Einmalig eine eigene Dropbox-App anlegen (Anleitung steht dort: *Scoped access*, *Full Dropbox*, Rechte `files.metadata.read` und `files.content.read`, nur der **App key** wird gebraucht). *Mit Dropbox verbinden* öffnet Dropbox; nach *Zulassen* zeigt Dropbox einen Code, den man in JMS Control einfügt (OAuth mit PKCE, ohne Weiterleitung – der Server braucht keine öffentliche Adresse). Danach den Ordner wählen.

- JMS Control lauscht über das Longpoll von Dropbox auf den Ordner: Ein hineingezogenes Bild ist nach wenigen Sekunden in der Diashow, gelöschte verschwinden. Zur Sicherheit wird alle 30 Minuten komplett abgeglichen.
- Bilder werden über die Vorschau-Schnittstelle von Dropbox als JPEG/PNG (bis 2048 × 1536) geholt – damit gehen auch HEIC-Fotos vom iPhone, TIFF und BMP; GIFs kommen im Original. Nur Bilder direkt im Ordner, höchstens 200, sortiert nach Dateiname (`01_…`, `02_…` legt die Reihenfolge fest). Zwischenspeicher: `dropbox/` im Datenordner.
- In der Kachel „Diashow“: bei *Diashow zeigt* den Eintrag *Bilder aus dem Dropbox-Ordner* wählen, darunter *Neues Bild in der Dropbox sofort zeigen* (springt sofort auf ein neu hinzugekommenes Bild).
- Anmeldung (Refresh-Token) in `dropbox-secret.json` (Rechte 600), nie im Browser; nur Leserechte. *Trennen* widerruft das Token bei Dropbox und leert den Zwischenspeicher.

## Diashow-Kachel

Eine Diashow-Kachel zeigt genau eine Quelle. Sie wird im Layout-Editor bei der Kachel über das Dropdown **Diashow zeigt** gewählt (früher Häkchen): hochgeladene Bilder, Folien aus ProPresenter, Bilder aus dem Dropbox-Ordner, Slider der Webseite, Beiträge der Webseite, Termine aus ChurchTools oder nächste Veranstaltungen. Die Einstellungen der gewählten Quelle stehen darunter. Ältere Kacheln mit mehreren Quellen zeigen „Mehrere Quellen (bisherige Einstellung)“ und laufen unverändert weiter, bis man eine Quelle wählt. Neue Kacheln starten mit hochgeladenen Bildern.

**Bereiche bei ChurchTools:** Bei „Termine aus ChurchTools“ und „Nächste Veranstaltungen“ zeigt die aufklappbare Karte **Bereiche** alle bekannten Kalender mit einzelnen Schaltern. Neue Kalender werden automatisch ergänzt und sind zunächst eingeschaltet. Schalten und Datenaktualisierungen lassen die Karte geöffnet beziehungsweise geschlossen; die Einstellungen bleiben pro Kachel gespeichert.

**Prüfung 25.10.2026:** Bereichsschalter, nachgeladene Kalender, getrennte Termin-/Veranstaltungsfilter, Klappzustand und Speichern/Neuladen sowie ProPresenter-Auswahl, Offline-Erhalt, leere Liste und erneutes Laden in Browsern mit 390, 768 und 1440 Pixeln geprüft; keine Konsolenfehler oder Seitenüberbreite. 14 relevante Diashow-/Playlist-Tests erfolgreich. Sicherung vor dieser UI-Änderung: `/home/master/backups/slideshow-selectors-20261025-v3alb7/rollback.sh`. Für einen vollständigen Rückweg zuerst diese Änderung, dann das Multiview-Dropdown und zuletzt die Techniker-Änderung zurücknehmen.

**Folien aus ProPresenter (seit 24.10.2026 je Kachel):** Bei *Folien aus ProPresenter* erscheint das Dropdown **Playlist in ProPresenter** mit den verfügbaren Playlists. **Playlists neu laden** aktualisiert die Auswahl. Bereits gespeicherte Namen bleiben bei einer unterbrochenen Verbindung erhalten. Jede Kachel kann so eine andere Playlist zeigen, z. B. Ankündigungen auf dem Multiview im Foyer und eine Kinder-Playlist auf einem anderen. Der Server holt alle Playlists, die eine Kachel braucht, speichert die Folien als Bilder (`diashow/pp/` im Datenordner) und aktualisiert sie alle 10 Minuten, solange ProPresenter läuft (bei Fehlern jede Minute). Ist ProPresenter aus, laufen die zuletzt gespeicherten Folien. Nicht mehr gebrauchte Playlists und ihre Bilder fallen weg. Die frühere gemeinsame Playlist unter *Einstellungen → Diashow* gibt es nicht mehr; dort steht nur noch eine Übersicht, welche Playlist in welchem Layout läuft, mit *Alle jetzt holen*. Eine dort früher eingetragene Playlist wird beim Start einmalig in alle ProPresenter-Kacheln ohne eigene Playlist übernommen.

## Kacheln Tally, Event-Ops-Ampel und Stream-Gesundheit (30.10.2026)

Drei weitere Kachel-Arten im Layout-Editor (Kachel wählen → *Was zeigt die Kachel?*). Alle drei brauchen keine neue Einrichtung, sie nutzen vorhandene Verbindungen des Servers.

- **Tally** (Gruppe *Bild & Ton*): zeigt für einen ATEM-Eingang rot (auf Sendung), grün (Vorschau) oder dunkel (aus); ohne ATEM-Verbindung grau gestrichelt. *ATEM-Eingang* listet die Eingänge des verbundenen ATEM (sonst die der Quellen). Darstellung **Feld**: die ganze Kachel färbt sich und nennt den Eingang (Name vom ATEM oder eigene Beschriftung). Darstellung **Rahmen**: die Kachel bleibt durchsichtig, nur ein farbiger Rand leuchtet – gedacht als Vollbild-Kachel über dem Kamerabild auf einem Raspberry Pi (Rahmenstärke einstellbar; der Layout-Hintergrund bleibt dabei schwarz, der Rahmen zeigt nur die Tally-Farbe). Optional erscheinen **REC** und **STREAM**, wenn der ATEM selbst aufnimmt bzw. streamt; der Server liefert das in der Nachricht `atem` als `recording`/`streaming` (`null` bei Modellen ohne diese Funktion, z. B. ohne eigenen Streaming-Zustand).
- **Event-Ops** (Gruppe *Info & Medien*): Ampel über dieselben Prüfungen wie der *Technische Startcheck* im Veranstaltungsbetrieb (ATEM, ChurchTools, Companion und seine Verbindungen, Kesher, ProPresenter, Raspberry-Stationen, Sichtprüfungen LED-Wand/Stage Display/Stream Decks). Rot: ein benötigtes System meldet einen Fehler. Gelb: ein benötigtes System ist unbestätigt/eingeschränkt oder ein optionales meldet einen Fehler. Grün: alles Benötigte in Ordnung (Ruhemodus zählt als in Ordnung). Welche Systeme benötigt sind, legt der Admin je Veranstaltung im Startcheck fest. Die Liste zeigt die nicht-grünen Punkte mit Kurztext („LED-Wand bestätigen“, „Kesher prüfen“); Option *Alle Prüfungen zeigen* listet auch die grünen. Der Server (`ops-status.js`) prüft alle 30 Sekunden (bei Fehlern jede Minute), aber nur, solange irgendein Layout eine Event-Ops-Kachel hat, und schickt das Ergebnis als Nachricht `ops` an alle Anzeigen; neue Verbindungen bekommen den letzten Stand sofort. Nach drei Minuten ohne neue Daten meldet die Kachel „Keine aktuellen Daten“.
- **Stream-Gesundheit** (Gruppe *Info & Medien*): eine Zeile mit **Encoder** (Monarch; ohne Monarch der ATEM, wenn er selbst streamt), **YouTube** (Live/Geplant/Beendet, mit Google-Anmeldung der Empfang gut/ok/schlecht), **Zuschauer** (mit Spitze) und **Upload** (FRITZ!Box: Rate und freie Reserve der Leitung). Die Daten kommen aus den vorhandenen Nachrichten `youtube` und `uplink`, es gibt keine neue Abfrage. Warnschwellen je Kachel: Upload-Reserve unter 20 % gelb, unter 10 % rot (einstellbar). Immer rot: Encoder sendet nicht, während YouTube live ist; kein Bild am Eingang der Monarch; YouTube empfängt nichts; Upload unter 1 Mbit/s während des Streams. FRITZ!Box nicht erreichbar oder veraltete Werte: gelb. Darunter optional die erste Störungsmeldung der YouTube-Überwachung.

Rechte: Die Nachricht `ops` geht wie `youtube`/`uplink` an alle angemeldeten Anzeigen außer Nur-Chat-Rollen; sie enthält nur Name, Status und Kurztext der Prüfungen (keine Zugangsdaten, keine Links). Tests: `test/ops-status.test.js`, `test/streamhealth.test.js`, `test/tally-view.test.js`.

## Schutz lokaler Companion-Module bei Updates

Seit 25.10.2026 schützt `/usr/local/lib/jms-companion-page-links/modules.py` beide bestehenden Modulordner: `/opt/companion-module-dev` und `/home/companion/.config/companion-nodejs/modules`. Erfasst werden alle lokalen Pakete, einschließlich JMS Control, Kesher und der tatsächlich verwendeten LED-Wand-Verbindung LibreLight 0.2.0. Die ältere LibreLight-Entwicklerversion 0.1.0 bleibt separat erhalten; die aktive Verbindung wird nicht umgestellt.

Der Systemd-Drop-in `/etc/systemd/system/companion.service.d/yy-jms-modules.conf` führt die Prüfung vor dem vorhandenen Seitenlink-Schutz bei jedem Start aus. Vollständige Moduldateien samt Geräteschlüsseln, Dateirechten und Eigentümern werden in `/var/lib/jms-companion-modules/objects` gesichert. Der übergeordnete Sicherungsordner ist nur für root zugänglich. Fehlt ein bekanntes Modul oder sein Einstiegspunkt, wird die geprüfte Sicherung vor dem Start wiederhergestellt; unvollständige Ordner werden aufbewahrt. Gültige vorhandene Modulupdates bleiben bestehen und erhalten eine neue Sicherung. Identische Sicherungen werden nicht doppelt gespeichert.

Die SQLite-Konfigurationen unter `v*/db.sqlite` werden einschließlich bestätigter WAL-Änderungen konsistent nach `/var/lib/jms-companion-modules/settings` gesichert. Das umfasst Verbindungen, Optionen, Tastenbelegungen, Seiten und Stream-Deck-Einstellungen. **Keine automatische Rücksetzung der Nutzerdatenbank**, damit neuere Benutzeränderungen erhalten bleiben. Eine bewusste dauerhafte Modulentfernung muss auch aus `modules.json` ausgetragen werden, sonst stellt der Schutz das fehlende Modul wieder her.

Status: `sudo cat /var/lib/jms-companion-modules/status.json`; Bestandsliste: `sudo cat /var/lib/jms-companion-modules/modules.json`. Quellen und sechs isolierte Tests liegen in `scripts/companion-page-links/modules.py` und `test-modules.py`. Tests prüfen Wiederherstellung einschließlich Schlüssel und Rechte, aktuelle Benutzeränderungen, unvollständige Module, reguläre Modulupdates, unveränderte Neustarts und beschädigte Sicherungen. Normale CompanionPi-Updates ersetzen nur den Programmordner und die Basis-Unit; beide Modulordner, dieser Drop-in und die Sicherungen liegen außerhalb. Die Kompatibilität mit einer künftig geänderten Modul-API bleibt eine eigene Prüfung.

Rückweg für diesen zusätzlichen Schutz: nur `yy-jms-modules.conf` entfernen und `sudo systemctl daemon-reload` ausführen. Den bestehenden Seitenlink-Schutz und die Sicherungen beibehalten.

## Kesher-Tastenbilder in Companion

**Eigene Beschriftung ab Modulversion 0.2.8:** `dynamic_button_image` und `synced_slot_style` überschreiben weder Text noch Textfarbe. Beim Einfügen eines Presets erhält die Taste weiterhin eine Startbeschriftung; danach gilt der Companion-Style einschließlich eigener Texte, Zeilenumbrüche, Variablen und leerer Beschriftungen. Bestehende Text-Overrides wurden am 25.10.2026 bei allen 18 betroffenen Tasten über die Companion-API entfernt. Rahmen, Funktionsbadge und Statusgrafik bleiben dynamisch. Acht Tests erfolgreich; eigene Beschriftung „Select / LichtPro7“ in der laufenden Vorschau nach Neustart verifiziert. Version 0.2.8 ist im Modulschutz gesichert. Rückweg nur für diese Textänderung: `/home/master/backups/companion-labels-20261025-nrpM3G/rollback.sh`.

**Textfarbe ab Modulversion 0.2.7:** Die automatischen Feedbacks `dynamic_button_image` und `synced_slot_style` geben keine Textfarbe mehr zurück. Es gilt die im Companion-Style gewählte Schriftfarbe; helle Kesher-Rahmenfarben dürfen keine schwarze Schrift erzwingen. Am 25.10.2026 wurden die bisherigen Textfarb-Overrides an allen 18 betroffenen Tasten über die Companion-API entfernt. Sieben Regressionstests erfolgreich; Livestream und Producer in der laufenden Vorschau nach Neustart mit weißer Schrift geprüft. Die übrigen Style-Werte, Aktionen und Verbindungen blieben unverändert. Version 0.2.7 ist im automatischen Modulschutz gesichert. Rückweg für diese Änderung: `/home/master/backups/companion-text-color-20261025-TWdK7J/rollback.sh`.

Seit Modulversion **0.2.6** bleiben Live-Bild, Text und Effektwerte nach Kesher-Seite und Tastenslot getrennt. Die erste Kesher-Seite (intern Seite 0) wird nicht mehr durch regelmäßige Updates anderer Seiten überschrieben. Vor dem ersten Live-Bild einer Seite verwendet das Feedback die veröffentlichte Vorschaugrafik derselben Taste. Prüfung: `cd companion && npm test` (Regression für Tastendruck, spätere Statusupdates, Neustart und getrennte Seiten).

Das Modul liegt außerhalb der Companion-Installation unter `/opt/companion-module-dev/companion-module-kesher`; normale Companion-Updates erhalten es. Bei einem bewussten Kesher-Modulupdate Version 0.2.6 oder neuer verwenden. Paketbau mit den Versionen aus `companion/yarn.lock`, Installation über `scripts/deploy-companion-module.sh companion/kesher-0.2.6.tgz`. Der Installer übernimmt den Geräteschlüssel, sichert das alte Modul und startet Companion kurz neu.

**Prüfung 25.10.2026:** Sechs Regressionstests erfolgreich, auch mit der Node-22-Laufzeit des Servers. In der laufenden Companion-Vorschau zeigt die Taste „Andere Folie“ wieder das CHAT-Bild statt „Licht/ProPresenter“; Bild und Text bleiben über weitere Aktualisierungen stabil. 12 Seiten, 96 Tastenbelegungen, 17 Verbindungen und 2 Oberflächen unverändert. Rückweg: `sudo /home/master/backups/companion-image-fix-20261025-ZEYP6P/rollback.sh` (stellt Modul und zugehörige Quellen wieder her; keine Rücksetzung der Nutzerdatenbank).

## Multiviews per Stream Deck (Companion-Modul „JMS Control“)

Seit 24.10.2026 gibt es neben dem Kesher-Modul ein eigenes Companion-Modul **JMS Control** (`companion-jms-control/`). Damit schaltet eine Stream-Deck-Taste einen Multiview auf ein Layout:

- Aktion **Multiview: Layout zeigen** – Multiview und Layout aus Listen wählen (sie kommen live aus JMS Control).
- Aktion **Multiview: nächstes / vorheriges Layout**.
- Aktion **Bildschirm am Server: Multiview zuweisen** (auch „Aus (schwarz)“).
- Rückmeldung **Multiview: Layout ist aktiv** bzw. **Bildschirm zeigt Multiview** – die Taste leuchtet grün.
- Variablen `$(jms-control:multiview_<Nr>)` (laufendes Layout) und `$(jms-control:bildschirm_<Nr>)`, `connected`.
- Presets: unter *Multiview <Name>* je Layout eine fertige Taste plus ◀/▶, unter *Bildschirm <Name>* je Multiview eine Taste.

Einrichten in Companion: *Connections* → **JMS Control** hinzufügen, Adresse `127.0.0.1` und Port `8090` stehen lassen (Companion läuft auf dem Server). Das Modul fragt den Zustand jede Sekunde über `GET /api/state` ab und schaltet über die bekannten Companion-Endpunkte (`POST /api/output/<Multiview>/layout/<Layout>` usw.).

Anmeldung: festes Gerät **Companion-JMS-Control** (Dienst Multiview, Recht *Steuern*, sonst nichts) mit Dienstschlüssel `jms-device.key` neben dem Modul (`/opt/companion-module-dev/companion-module-jms-control/`, 0640 root:companion). Der Schlüssel geht nur über Loopback an JMS Control, nicht ins Paket und nicht ins Repository. Update: Version in `companion-jms-control/package.json` und `companion/manifest.json` erhöhen, `npm install && npm run package`, auf dem Server `sudo bash scripts/deploy-companion-jms-control.sh` (übernimmt den Schlüssel aus der vorigen Installation, startet Companion neu – die Stream Decks sind dabei kurz weg). Bei einer Neuinstallation ohne Schlüssel: Gerät unter *Einstellungen → Anmeldung für alle Dienste* registrieren und den Schlüssel dort ablegen.

### Feste Seitenverweise in Companion

Die lokale Companion-Version `5.0.0+9504-main-1dc10c6ea7` besitzt die Anpassung `JMS_PAGE_LINKS_V2`: Feste Ziele von `internal: Surface: Set to page` und `Surface: Set by index to page` folgen beim Einfügen, Löschen und Verschieben der ursprünglichen Seite. Die Zuordnung erfolgt über die unveränderliche interne Seiten-ID; die angezeigte und gespeicherte Seitennummer wird automatisch angepasst. Das gilt auch für entsprechende `surface_on_page`-Rückmeldungen, verschachtelte Aktionen, Loslassen-Aktionen, Trigger und deaktivierte Aktionen. Bestehende und neue feste Verweise sind abgedeckt. Ausdrücke sowie relative Navigation, „Current page“ und „Startup page“ behalten ihre Bedeutung.

Wird die Zielseite selbst gelöscht, erhält der Verweis den ungültigen Wert `deleted-page:<ID>` und schaltet keine andere Seite. Dann im Button eine neue Zielseite auswählen. Bereits vor der Installation falsch zugeordnete Ziele müssen einmal richtig ausgewählt werden.

**Updates automatisch absichern:** Die dauerhafte Einrichtung liegt unter `/usr/local/lib/jms-companion-page-links/` und in `/etc/systemd/system/companion.service.d/zz-jms-page-links.conf`, außerhalb der vom CompanionPi-Updater ersetzten Verzeichnisse. Vor jedem Start prüft `ensure.py` das Programm. Bei einem neuen Bundle sucht `engine.cjs` die zuständigen Klassen anhand ihrer JavaScript-Struktur statt einer festen Versionsnummer oder minifizierter Variablennamen. Erst nach Syntaxprüfung und sieben Verhaltenstests wird das angepasste Programm atomar übernommen. Die Tests laufen mit den Rechten des Benutzers `companion`, nicht als root. Derselbe bereits geprüfte Programmstand wird beim nächsten Start unverändert wiederverwendet. Der eigene Startwrapper erhält die Bindung an `127.0.0.1` und den bisherigen Modulpfad auch dann, wenn der Updater das CompanionPi-Startskript ersetzt.

**Inkompatibles Update:** Bevor dessen Hauptprogramm startet oder Einstellungen migrieren kann, wird bei fehlgeschlagener Prüfung automatisch das vollständige zuletzt geprüfte Companion-Programm aus `/var/lib/jms-companion-page-links/last-good` wiederhergestellt. Die zurückgehaltene neue Version bleibt unter `rejected/` zur Untersuchung erhalten. Die Benutzerdatenbank wird dabei weder ersetzt noch zurückgesetzt. Das bedeutet: normale kompatible Updates brauchen keine Nacharbeit; bei grundlegenden internen Änderungen läuft vorerst die zuletzt geprüfte Version weiter. Es werden keine Updates eigenständig heruntergeladen oder geplant.

Status: `sudo cat /var/lib/jms-companion-page-links/status.json`; Protokoll: `journalctl -u companion`. `state: ready` bezeichnet einen geprüften Programmstand, `state: fallback` ein zurückgehaltenes Update. Die Quellen, Sperrdatei für die Parser-Abhängigkeit und Tests liegen in `scripts/companion-page-links/`. Wartung am Schutz selbst: diese Dateien nach `/usr/local/lib/jms-companion-page-links/` übernehmen und Companion neu starten. Rückweg zur vorherigen Einrichtung ist im Installationsbackup dokumentiert; zum vollständigen Abschalten den eigenen Systemd-Drop-in entfernen, ein gesichertes Original-Bundle einsetzen und nach `systemctl daemon-reload` Companion neu starten.

Gezielte Tests: `selftest.cjs` prüft die echten Klassen des jeweiligen Bundles in Isolation; `test-update-guard.py` simuliert den bisherigen Patch, wiederholte Starts, das vollständige Ersetzen des Programmordners mit neu gepacktem Code und ein inkompatibles Update einschließlich vollständiger Programmwiederherstellung. Der ursprüngliche Seitenverweis-Patch wurde zusätzlich im laufenden Companion mit temporären Testseiten geprüft; alle Testseiten wurden entfernt.

## YouTube Live

JMS Control fragt den YouTube-Kanal mit einem **API-Schlüssel** ab (YouTube Data API v3). Einrichten: JMS Control → Einstellungen → **YouTube** (Kanal-Link und Schlüssel; dort steht auch, wie man den Schlüssel bekommt). Der Schlüssel liegt nur in `youtube-secret.json` im Datenordner (Rechte 600) und geht nie an den Browser.

- **Kachel „YouTube Live“**: LIVE/geplant/beendet, „Nicht gelistet“/„Privat“, Zuschauer, Laufzeit, Spitze, Aufrufe, Likes, ob die Monarch sendet (mit Eingangssignal), wie YouTube den Stream empfängt, Zustand des ATEM-Streams, Warnungen und auf Wunsch der Live-Chat. Jeder Teil lässt sich im Layout-Editor einzeln ein- und ausschalten (Kachel wählen → Inhalt: Kopfzeile, Zahlen, Stream, Technik). Der ATEM 2 M/E Constellation streamt nicht selbst; seine Zeile verschwindet, sobald die Monarch eingerichtet ist.
- **Telegram:** Stream-Meldungen sind auf diesem Server vollständig abgeschaltet (siehe „Störungsmeldungen per Telegram“). Dazu gehören auch Warnungen zur Uploadrate und die Zusammenfassung nach Stream-Ende.
- Geplante Streams werden automatisch gefunden, wenn sie öffentlich sind. Nicht gelistete und private Streams findet JMS Control mit der Google-Anmeldung von selbst; ohne sie den Video-Link in den Einstellungen eintragen.
- Kontingent: 10 000 Einheiten am Tag, ein Sonntag braucht gut 3 000 (mit Google-Anmeldung etwas mehr). Ist es aufgebraucht, steht das in der Kachel; ab 9 Uhr geht es wieder.

### Matrox Monarch HDX

Einstellungen → YouTube → **Encoder: Matrox Monarch**: Adresse `192.168.0.30`, Benutzer und Passwort wie in der Weboberfläche der Monarch (ab Werk `admin`/`admin`; leer = `admin`). Zugang in `monarch.json` im Datenordner (Rechte 600). JMS Control fragt alle 5 Sekunden über die HTTP-Steuerung der Monarch ab (`/Monarch/syncconnect/sdk.aspx?command=GetStatus` und `GetInputStatus`): sendet der RTMP-Encoder, welches Signal kommt am Eingang an. Die Bitrate liefert die Monarch nicht (`GetStreamingVideoDataRate` antwortet `FAILED`); stattdessen zeigt die Kachel den Upload der Leitung von der FRITZ!Box (wie die Kachel „Upload / Stream“) – während des Streams ist das fast ganz der Stream. Fällt er unter 1 Mbit/s, während die Monarch sendet, gibt es eine Störung. Zum Prüfen vom Server aus:

```bash
curl -s -u admin:admin "http://192.168.0.30/Monarch/syncconnect/sdk.aspx?command=GetStatus"
# ENC1:RTMP,ON,ENC2:NONE,DISABLED,NAME:MonarchHDX
```

### Google-Anmeldung (optional)

Einstellungen → YouTube → **Google-Anmeldung**: Client-ID und Clientschlüssel eintragen (Anleitung steht dort), **Mit Google anmelden**, den angezeigten Code auf google.com/device eingeben. Nur Leserecht (`youtube.readonly`). Damit kommen dazu: nicht gelistete und private Streams des Kanals, die Sichtbarkeit und der Stream-Zustand bei YouTube (gut/ok/schlecht, Auflösung, Bildrate, Hinweise wie „Bitrate zu niedrig“). Client-Daten und Anmeldung liegen in `youtube-secret.json`; „Abmelden“ widerruft den Zugriff bei Google.

- Die App muss in der Google Cloud Console **veröffentlicht** sein (Zielgruppe → „In Produktion“). Im Status „Testen“ verfällt die Anmeldung nach 7 Tagen – dann steht in den Einstellungen „Google-Anmeldung abgelaufen“, und man meldet sich neu an.
- Anmelden mit dem Konto, dem der Kanal gehört (bei einem Brand-Account den Kanal auswählen). Passt der angemeldete Kanal nicht zum eingetragenen, zeigen die Einstellungen eine Warnung.

## Mischpult Allen & Heath Avantis (Kachel „Mischpult“)

JMS Control liest am Avantis über **MIDI over TCP** (Port 51325, dasselbe Protokoll wie der Companion-Anschluss) mit, welche Kanäle stumm sind und welche Szene zuletzt abgerufen wurde. **Es wird nichts gesteuert**: Der Server schickt nur die „Get Channel Name“-Anfragen aus dem A&H-Protokoll (SysEx, reine Abfrage) und wertet aus, was das Pult von sich aus sendet. Modul: `multiview/avantis.js`.

**Einrichtung am Pult:** Utility → Control → **MIDI**: „MIDI over TCP/IP“ einschalten; der dort eingestellte MIDI-Kanal ist der *Basiskanal* (Companion `midiBase`, hier `1`). Das Pult erlaubt mehrere TCP-Verbindungen gleichzeitig; Companion darf weiterlaufen.

**Einrichtung in JMS Control:** Einstellungen → **Avantis (Mischpult)**: Adresse `192.168.1.70`, Port `51325`, Basiskanal `1`. Darunter die **überwachten Kanäle** (Art, Nummer, Anzeigename, „kritisch“) – z. B. den Input des Pastor-Mikros als kritisch und die DCAs. Optional **Szenennamen** (das Pult meldet nur die Nummer). Alles liegt in `config.json` (`avantis`), keine Geheimnisse.

**Was die Kachel zeigt:** Kopfzeile mit Verbindungsstand, je Kanal OFFEN (grün) / STUMM (rot) / `?` (noch keine Rückmeldung), darunter „Szene 12 · Gottesdienst“. Ist ein kritischer Kanal stumm, wird die Kachel dunkelrot mit großer Warnung „Pastor-Mikro stumm!“. Im Layout-Editor lassen sich Titel, Schriftgröße, Spalten, „nur stumme Kanäle“ und die Szenenzeile einstellen. Bedienen kann man von der Kachel aus nichts.

**Protokoll (aus der A&H-Dokumentation „Avantis MIDI TCP Protocol“ und dem Companion-Modul `allenheath-avantis`):**

| Nachricht | Bytes | Bedeutung |
| --- | --- | --- |
| Mute | `9N CH VEL` (+ `9N CH 00`) | Note On, VEL ≥ `40` = stumm, < `40` = offen; N = Basiskanal−1 + Versatz |
| Szene | `BN 00 BANK` + `CN PROG` | Szene = BANK·128 + PROG + 1, auf dem Basiskanal |
| Name holen | `F0 00 00 1A 50 10 01 00 0N 01 CH F7` | Antwort `… 0N 02 CH <Name> F7` |

Versatz je Kanalart: Inputs 0 (Noten `00`–`3F`), Gruppen 1 (mono `00`–`27`, stereo ab `40`), Aux 2, Matrix 3, FX-Send/FX-Return/Main/DCA/Mute-Gruppen 4 (DCA 1–16 = `36`–`45`, Mute-Gruppen `46`–`4D`).

**Wichtig / noch nicht am echten Pult verifiziert** (Pult war beim Bau nicht erreichbar; die Logik ist mit Mock-Sockets getestet, `multiview/test/avantis.test.js`):

- Im MIDI-TCP-Protokoll gibt es **keine Abfrage des Mute-Zustands**. Nach dem Verbinden steht jeder Kanal auf `?`, bis das Pult die erste Mute-Änderung dafür schickt. Vor dem Gottesdienst also einmal jeden kritischen Kanal am Pult stumm und wieder an schalten (oder prüfen, ob das Pult beim Szenenabruf alle Mutes sendet – dann erledigt sich das von selbst).
- Zu prüfen: Sendet das Pult Mute-Änderungen an alle TCP-Clients (Feedback), auch wenn sie am Pult selbst ausgelöst wurden? Antwortet es auf die Namensabfrage mit `02`? Kommt der Szenenabruf als Bank Select + Program Change? Stimmt der Notenversatz für DCAs (`36`) am Avantis?
- Einen **Szenennamen** liefert das MIDI-Protokoll nicht; deshalb die Namensliste in den Einstellungen. Ohne Eintrag steht „Szene 12“, vor dem ersten Abruf „Seit der Verbindung keine Szene abgerufen“.
- Alle 15 s schickt der Server als Lebenszeichen eine Namensabfrage. Bleibt die Antwort aus, obwohl das Pult vorher geantwortet hat, verbindet er neu. Hat das Pult *nie* geantwortet, bleibt die Verbindung bestehen (Verhalten wird am echten Pult geprüft).

Prüfen vom Server aus: `nc -vz 192.168.1.70 51325` (Port offen?) und im Server-Log `Avantis: verbunden …`, `Avantis: Szene 12 abgerufen`.

## Lichtpult grandMA3 (Kachel „Licht“)

JMS Control hört per **OSC über UDP** mit, welcher Cue in den überwachten Sequenzen läuft, und zeigt je Sequenz eine Zeile „Licht: Lobpreis 3 (Cue 12)“. **Der Server sendet nichts an die Konsole** (kein `/cmd`); er nimmt nur entgegen, was die Konsole bei „Send“ von selbst schickt. Modul: `multiview/grandma3.js`. Die Konsole/onPC steht unter `192.168.0.231`; der Companion-Port 8000 ist der **OSC-Eingang** der Konsole (UDP, nicht der Web-Remote) – für uns ist nur die Gegenrichtung nötig.

**Einrichtung an der Konsole:** Menu → **In & Outputs → OSC**: oben „Enable Output“ einschalten. Eine Zeile anlegen (oder die Companion-Zeile erweitern): **Destination IP** = `192.168.0.230` (JMS-Server), **Port** = `8001` (Empfangsport aus den Einstellungen), Mode **UDP**, **Send = Yes**. „Receive“ und „Receive Command“ sind für JMS Control nicht nötig. Das Feld **Prefix** leer lassen oder denselben Wert in JMS Control eintragen. Mit „EchoOutput = Yes“ sieht man im System Monitor der Konsole, was gesendet wird.

**Einrichtung in JMS Control:** Einstellungen → **grandMA3 (Licht)**: Adresse der Konsole (nur deren Pakete zählen), Empfangsport `8001`, Prefix, Objektpfad (leer = Standard) und die **überwachten Sequenzen** (Nummer aus dem Sequence Pool, Anzeigename). Sequenzen, die im OSC-Verkehr auftauchen, aber nicht eingetragen sind, werden darunter als Vorschlag genannt. Alles liegt in `config.json` (`grandma3`).

**Was die Konsole sendet (Handbuch 2.x, „Object Playback Feedback“):**

```
/13.13.1.6.<Seq>,sis,Go+,1,Sequence 1 Cue 12 "Lobpreis 3"   Taste gedrückt (1) / losgelassen (0), Arg 3 = Cue-Angabe
/13.13.1.6.<Seq>,sif,FaderMaster,3,63.5                      Fader in Prozent
/13.13.1.6.<Seq>,sii,FaderMaster,0,-1                        Drehgeber
```

Der Server nimmt aus dem dritten Argument Cue-Nummer und -Name (`… Cue <Nr> "<Name>"`); kommt ohne Cue-Angabe (z. B. „Off“), bleibt der letzte Cue stehen. Mit Prefix lautet die Adresse `/<Prefix>/13.13.1.6.<Seq>`. Der Objektpfad `13.13.1.6` kann sich mit der Softwareversion ändern (das Companion-Modul nutzt `14.14.1.6`; beide werden erkannt, ein anderer lässt sich in den Einstellungen eintragen – Adresse eines Objekts in der Konsole per Lua `Printf(...)` oder im System Monitor nachsehen).

**Grenzen / noch nicht verifiziert** (Konsole war beim Bau nicht erreichbar; Parser mit Beispielpaketen getestet, `multiview/test/grandma3.test.js`):

- Die Konsole meldet den Cue **nur bei Tastendruck/Fader** am Executor (laut Forum beim Loslassen von Go+). Ein Cue, der per Timecode, Makro oder Kommandozeile läuft, erzeugt möglicherweise keine OSC-Ausgabe – das muss am Pult geprüft werden. Einen rein lesenden „Status-Request“ bietet grandMA3-OSC nicht (nur `/cmd`, das steuert und wird bewusst nicht benutzt).
- Falls nötig, kann ein kleines Lua-Plugin auf der Konsole periodisch den aktuellen Cue schicken; der Server versteht dafür `/jms/cue,iss,<Seq>,<CueNr>,<CueName>` (z. B. `SendOSC 1 "/jms/cue,iss,1,12,Lobpreis"` – Zeilennummer der OSC-Konfiguration anpassen). Das Plugin selbst ist noch nicht geschrieben.
- Exaktes Format des dritten Arguments (Reihenfolge Sequenzname/Cue-Nummer/Cue-Name, Anführungszeichen) am echten Pult gegenprüfen; der Parser nimmt `Cue <Nummer>` als Anker und ist tolerant.

Prüfen vom Server aus: Einstellungen → grandMA3 zeigt „Warte auf OSC an Port 8011“ bzw. „OSC kommt an (von 192.168.0.231)“ mit Uhrzeit des letzten Pakets; im Docker-Betrieb (`network_mode: host`) braucht es keine Portfreigabe, eine Firewall muss `8011/udp` eingehend erlauben.

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

An jedem Ausgang der Grafikkarte kann ein eigener Multiview laufen. Welcher wo läuft, stellst du in JMS Control unter **Einstellungen → Bildschirme** ein: eine Tabelle mit allen Server-Anschlüssen und allen Raspberry Pis (Spalten Bildschirm mit Name und Status, Anzeige, Multiview, Drehung). Rechts klappt **Vorschau** die Live-Ansicht dieses Ausgangs unter der Zeile auf – für jeden Anschluss, auch ohne Monitor; Pis im Intercom zeigen dort die Kesher-Ansicht ihrer Rolle, im Ruhemodus eine schwarze Karte. Offene Vorschauen laufen bei Status-Updates weiter und schließen sich, wenn man die Seite verlässt. Die Multiview-Ausgaben zeigen keinen Hinweis „ATEM getrennt“ mehr (seit 24.10.2026); der ATEM-Status steht nur noch im Admin. Die Umschaltung ist sofort live, auch per Companion (`/api/screen/<Anschluss>/output/<Multiview>`, `…/output/aus` = schwarz). VGA hängt bei vielen Boards intern an einem DisplayPort-Ausgang und erscheint dann als `DP-1` oder `DP-2`. Den Namen kannst du in der Tabelle frei vergeben.

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

**Statuszeile und Live-Position (Ablauf-Kachel):** Unter *Darstellung → Statuszeile* lässt sich oben oder unten eine Zeile mit **Restzeit** des laufenden Punkts, **Abweichung vom Plan** und dem **nächsten Punkt** samt Verantwortlichem einblenden. Normalerweise ergibt sich der laufende Punkt aus der Uhrzeit (Abweichung „nach Plan“). Der Operator kann ihn auch von Hand setzen: mit der Kachel-Option *Laufenden Punkt per Klick setzen* erscheint an jedem Punkt ein Knopf ▶ (auf den Monitoren und in der Multiview-Übersicht), „Nach Uhr“ in der Statuszeile schaltet zurück. Der Stand gilt pro Event für alle Kacheln und Bildschirme; die Abweichung ist dann die tatsächliche Startzeit minus Plan-Startzeit („+4 min“ = hinter Plan; grün bis 2 min, gelb bis 5 min, rot darüber – Schwellen je Kachel einstellbar). Für Companion/Stream Deck: `POST /api/churchtools/agenda/position` mit `{ "eventId": 4241, "itemIndex": 5 }` (Index im Ablauf ab 0, `null` = wieder nach Uhr) oder `{ "eventId": 4241, "action": "next" | "previous" | "auto" }`; Rechte wie bei der Folien-Steuerung (Admin, Technikstation, Rolle mit „Folien steuern“). Der Server merkt sich den Stand in `agenda-position.json`, Einträge älter als ein Tag verfallen.

**Dienstplan („Wer ist heute dran?“):** Die Kachel-Art **Dienstplan** zeigt für das Event der Kachel (gleiche Datumsauswahl und derselbe Event-Filter wie beim Ablauf) die in ChurchTools eingeteilten Personen je Dienst, gruppiert nach Dienstgruppe. **Rot**: Dienst nicht besetzt („Kamera 2 – nicht besetzt“), **gelb**: eingeteilt, aber noch nicht zugesagt. Unter *Dienste* lassen sich ganze Dienstgruppen oder einzelne Dienste anhaken (leer = alle), dazu „Nur unbesetzte und angefragte Dienste“ und die Schriftgröße. Das Server-Konto braucht in ChurchTools Leserechte auf Dienste und Dienstgruppen; die Dienste je Event (`/events/{id}`) fragt der Server nur ab, solange mindestens eine Dienstplan-Kachel existiert. Bei Diensten mit „Namen verbergen“ steht „Name in ChurchTools verborgen“.

## Server-Stand automatisch auf GitHub (30.10.2026)

Wird direkt auf dem Server gearbeitet, ohne zu committen, sichert der Timer `jms-server-stand.timer` den Arbeitsstand von `~/intercom-system` **stündlich** als Zweig **`server-stand`** auf GitHub (Skript `scripts/server-stand/jms-server-stand.sh`). Der Checkout bleibt dabei unberührt: kein Commit auf `main`, kein Stash, kein Zweigwechsel – der Stand wird über einen eigenen Index gebaut (`.gitignore` gilt) und nur hochgeladen, wenn sich etwas geändert hat. Vergleichen: `git diff main origin/server-stand`.

**Das Repository ist öffentlich.** Vor jedem Hochladen werden alle von `main` abweichenden Dateien geprüft: Schlüsseldateien (`*.key`, `*.pem`, `.env`, `access-secret*` …), private Schlüssel, GitHub-/Slack-/AWS-/Tailscale-/Telegram-Tokens, fest eingetragene Passwörter/Tokens und die Geheimnisse der laufenden Container (Multiview, Kesher). Bei einem Fund wird **nichts** hochgeladen; `journalctl -u jms-server-stand` nennt nur die Dateinamen, Zustand in `~/.local/state/jms-server-stand/status.json`.

- Einrichten: `sudo bash scripts/server-stand/install.sh` (legt den Deploy-Schlüssel `/home/master/.ssh/jms-server-stand` an und gibt den öffentlichen Teil aus). Ein **Admin des Repositorys** trägt ihn unter GitHub → Settings → Deploy keys mit **„Allow write access“** ein. Ohne den Schlüssel wird der Stand nur lokal als Zweig `server-stand` gesichert.
- Probelauf: `bash /usr/local/lib/jms-server-stand/jms-server-stand.sh --dry-run`
- Sofort sichern: `sudo systemctl start jms-server-stand.service`

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

Alle Weboberflächen sind unter `https://192.168.0.230:<gewohnter Port>` erreichbar. Caddy übernimmt die Ports nach außen, die HTTP-Backends lauschen nur auf `127.0.0.1`. Alte `http://`-Links werden auf demselben Port auf `https://` umgeleitet. Kiosk und Companion-Modul verwenden inzwischen ebenfalls verifiziertes HTTPS mit individuellem Gerätenachweis. Zertifikate kommen von Caddys lokaler Zertifizierungsstelle; die öffentliche Server-CA muss auf dem Endgerät vertrauenswürdig installiert sein. Zertifikatswarnungen nicht wegklicken und keine TLS-Prüfung abschalten. Lokales HTTP ist ausschließlich für interne Dienste mit weiterhin erforderlichen gültigen Nachweisen vorgesehen.

| Dienst | neu | intern |
| --- | --- | --- |
| Kesher | `https://192.168.0.230:8443` | `127.0.0.1:8080` |
| Multiview | `https://192.168.0.230:8090` | `127.0.0.1:8090` (`HOST=127.0.0.1` im Compose) |
| Companion | `https://192.168.0.230:8000` | `127.0.0.1:8000` |
| Dashboard | `https://192.168.0.230:3000` | `127.0.0.1:3000` |
| Glances | `https://192.168.0.230:61208` | `127.0.0.1:61208` |
| Portainer | `https://192.168.0.230:9443` | `127.0.0.1:9443` (eigenes HTTPS, Caddy davor) |

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

Intercom, Dashboard und JMS Control verwenden dieselbe zentrale Anmeldung: zuerst **Name und gültige Rolle** wählen; für normale Rollen benötigt ein nicht ausgenommenes Gerät anschließend den **Tagescode**. Admins können sich auf jeder Oberfläche direkt mit Name und PIN anmelden, um den aktuellen Code abzurufen; dadurch gibt es keine allgemeine JMS-Control-Ausnahme mehr. Companion, Portainer, Glances, DNS und Router benötigen Adminrechte. IP-Port-Adressen und die ausdrücklich registrierten `.local`-/`.jms.de`-Adressen gleichen Sitzungen über kurzlebige, einmalige und browsergebundene PKCE-Tickets ab.

- **Techniker (nur Chat):** Die bestehende Rolle `techniker` öffnet auf Handy, Tablet und Desktop die Fernbedienung mit ausschließlich dem Reiter **Chat**. Name genügt; PIN, QR-Code und Tagescode sind nicht erforderlich. `access.roles.techniker.chatOnly` sperrt alle anderen APIs, WebSocket-Daten und Dienste serverseitig. Es entstehen weder Gerätefreigaben noch Kesher-Intercom-Tokens; die bestehende Nachtablaufregel gilt weiterhin.
- **Multiview-Rechte:** Pro Rolle öffnet ein Dropdown die Mehrfachauswahl. Ein Häkchen erlaubt **Sehen**, daneben lässt sich **Bearbeiten** wählen. Entfernen des Häkchens nimmt beide Rechte zurück. Das Menü bleibt für weitere Auswahlen offen; Änderungen werden automatisch gespeichert. Escape oder ein Klick außerhalb schließen es. Für reine Chat-Rollen sind keine Multiview-Freigaben möglich.
- ~~**Dropdown für Multiview-Rechte (25.10.2026):**~~ Bisherige Schaltflächen und Wechsel-Logik ersetzt; bestehende Rollenfelder und Speicherwege weiterverwendet. Browserprüfung bei 390, 768 und 1440 Pixeln: Mehrfachauswahl, Sehen/Bearbeiten, Speichern/Neuladen, Entfernen, Tastatur, Schließen außerhalb, Darkmode und Chat-Sperre erfolgreich; keine Konsolenfehler oder Seitenüberbreite. Alle 185 Node-Tests erfolgreich. Rückweg zur vorherigen Oberfläche: `/home/master/backups/multiview-dropdown-20261025-rXdAOf/rollback.sh` (vor einem vollständigen Techniker-Rollback zuerst ausführen).
- **Multianmeldung:** Unter *Einstellungen → Benutzer & Rechte → Rollen* erlaubt der Schalter mehrere Personen mit eigenen Namen in derselben Rolle. Für Techniker ist er aktiviert, für bestehende andere Rollen bleibt er ausgeschaltet. Einstellung: `access.roles[roleId].multiLogin`; Kesher berücksichtigt sie aus der signiert abgefragten zentralen Sitzung. Abmelden beendet nur die eigene Sitzung. Ausschalten beendet keine laufenden Sitzungen, verhindert aber neue Belegungen bis zur Freigabe der Rolle.
- ~~**Techniker und Multianmeldung (25.10.2026):**~~ Bestehende Rollen-, Geräte-, Chat- und UI-Struktur erweitert; keine Schemaänderung und keine zusätzliche Datenbank. Geprüft: 185 Node-Tests einschließlich paralleler Anmeldungen, Rollenwechsel, Abmelden, HTTP-/WebSocket-Sperren und SSO ohne Gerätefreigabe; vollständige Go-Tests; Browserprüfung mit 390, 768 und 1440 Pixeln einschließlich Speichern/Neuladen der Rollenoption. Live auf `192.168.0.230` bestätigt: zwei unabhängige Techniker-Sitzungen ohne Code, Einstieg über `intercom.internal` mit SSO, Neuladen, getrenntes Abmelden, Chat-Lesezugriff und gesperrte Fremddienste/APIs; beide Container gesund. Keine produktive Testnachricht versendet, alle Testanmeldungen beendet. Rollback-Sicherung: `/home/master/backups/techniker-20261025-dV8v3N`; die ursprünglichen laufenden Container wurden wegen fehlender Docker-Image-Inhalte als eigene Dateisystem-Images gesichert.

- **Einstellungen:** JMS Control → *Benutzer & Rechte*. Die bestehende PIN und Gatewaykonfiguration bleiben beim Update erhalten. Alte Sitzungen und Gerätefreigaben werden beim Wechsel auf Sicherheitsformat 3 ungültig; einmal neu anmelden. Fehlende oder beschädigte `access-secret.json` sperrt den Start, statt anonymen Adminzugang zu öffnen. Die PIN kann nicht mehr ersatzlos abgeschaltet werden.
- **Zeitregel:** Codewechsel um 00:00, Ablauf sämtlicher persönlicher Sitzungen einschließlich Admin spätestens um 05:00 **Europe/Berlin**. Bestehende Freigaben vom Vortag gelten nach Mitternacht nur bis 05:00. Auch eine Anmeldung zwischen 00:00 und 05:00 endet an diesem Morgen. Ab 05:00 gilt der nächste Morgen als Grenze. Sommer-/Winterzeit wird berücksichtigt. QR- und SSO-Übernahmen verlängern diese Frist nicht. Der neue Tagescode ist nur für Admins und feste Anzeigestationen abrufbar.
- **Versuchslimits:** Tagescode und Admin-PIN: acht Fehlversuche pro Quelladresse in 15 Minuten; zusätzlich begrenzte parallele PIN-Prüfungen. Die zentrale PIN-Sperre überlebt einen Neustart. Kesher schützt auch seine eigene PIN-Schnittstelle.
- **Feste Geräte:** sämtliche IP-Ausnahmen sind durch individuell registrierte kryptografische Nachweise ersetzt. IP- und MAC-Adressen dienen nur noch der Netzdiagnose, nicht als Anmeldeberechtigung. Server-Kiosk und Kamera-Pi sind mit Clientzertifikaten, der Kesher-Monitor und das Companion-Modul mit getrennten Dienstschlüsseln provisioniert. Andere frühere IP-Ausnahmen benötigen wieder Tagescode und Rollenlogin oder eine bewusste individuelle Provisionierung.
- **Dauerhaft freigeschaltete Geräte** (für normale Rechner ohne Zertifikat, z. B. Regie-Mac): Einstellungen → *Angemeldete Geräte* → *Dauerhaft freigeschaltete Geräte*. Ein Admin meldet sich auf dem Gerät selbst an, gibt einen Namen ein und klickt *Dieses Gerät dauerhaft freischalten*. Der Browser bekommt dann eine eigene, ein Jahr gültige Gerätefreigabe (HttpOnly-Cookie, auf dem Server nur als Hash) und braucht keinen Tagescode und keinen QR-Code mehr; Name und Rolle wählt man weiterhin, die Rollen-Anmeldung endet wie gewohnt um 5 Uhr. Die Freigabe hängt am Browser, nicht an IP oder MAC – ein anderes Gerät mit derselben IP kommt nicht hinein. „Neuen Code erzeugen“ und eine geänderte Admin-PIN lassen sie bestehen; *Widerrufen* beendet sie und alle Anmeldungen darauf sofort. Ein QR-Code von so einem Gerät gibt einem Handy nur die Freigabe für heute.
- **QR-Code auf der Übersicht:** schaltet ein Handy nur für heute frei (wie der Tagescode). Name und Rolle wählt man danach selbst in der Anmeldemaske; das Handy übernimmt nicht mehr die Rolle des PCs, eine früher per QR übernommene Anmeldung endet. Nur der QR-Code im Dialog *Handy-Fernsteuerung* meldet weiterhin als dieselbe Person an.
- **Rollen-Dropdown der Raspberry Pis** (*Einstellungen → Raspberry Pis*): belegte Rollen (angemeldet, in Kesher oder bei einem anderen Pi) sind wie auf der Anmeldeseite gekennzeichnet und gesperrt. Anderer Browser oder gelöschte Website-Daten: neu freischalten.
  - **Mit fester IP-Adresse** (Feld „Feste IP-Adresse“): gilt für jedes Gerät mit dieser Adresse, ohne Cookie – auch für Geräte, an denen man sich nicht als Admin anmelden kann. Nur einzelne IPv4-Adressen aus dem eigenen Netz (192.168.x.x, 10.x.x.x, 172.16–31.x.x) oder von Tailscale (100.64–127.x.x), nicht die Adresse des Servers. Die Adresse setzt Caddy (`X-Forwarded-For` vom Browser wird ersetzt), das Backend lauscht nur auf 127.0.0.1. Risiko: Wer dieselbe IP bekommt oder sich von Hand einstellt, ist ohne Code drin – deshalb in der FRITZ!Box eine feste IP für das Gerät vergeben. Die Rollen-Sitzung gilt nur von dieser Adresse aus.
  - **Ohne Ablauf** (Schalter): keine Ablaufzeit. Beim Browser hält der Cookie 400 Tage (Grenze der Browser) und wird bei jedem Öffnen von JMS Control bzw. der Anmeldeseite erneuert.
- **Abmelden:** in Kesher über „Abmelden“, im Dashboard über *Konto → Abmelden*. Das meldet auf allen Diensten ab; die Freischaltung mit dem Code bleibt für den Tag.
- **Technik:** Caddy prüft HTTP-Anfragen über `/.jms-auth/check`. WebSocket-Upgrades laufen zusätzlich durch den zentralen widerrufbaren Proxy; Logout beendet bereits offene Verbindungen. `X-JMS-Gateway` und `X-JMS-Session-Id` werden am Proxy entfernt und ausschließlich aus dem Prüfergebnis neu gesetzt. Kesher-Rollen und -Admins verwenden einmalige signierte Tickets mit zentraler Sitzungs-ID, Version und Ablauf; Kesher prüft den Parent bei HTTP-Anfragen und sekündlich für offene Verbindungen. Bei Ausfall der Prüfung bleibt der Zugang gesperrt. Beide Compose-Umgebungen benötigen dasselbe `JMS_AUTH_SECRET`; Kesher zusätzlich `JMS_AUTH_URL` und das schreibgeschützte öffentliche Caddy-CA-Zertifikat unter `JMS_AUTH_CA_FILE`. Es gibt keinen unsicheren Browser-Fallback auf unabhängige Kesher-Sessions. Native feste Stationen bleiben separat zugelassen.
- **Rechte:** Steuernde Browseranfragen verwenden POST und Herkunftsprüfung. Die GET-Kompatibilität für Companion bleibt nur für echte Maschinenaufrufe ohne Browsermetadaten erhalten. Multiview-Konfiguration, Chat und WebSocket-Nachrichten werden nach Rolle gefiltert. ProPresenter-Foliensteuerung benötigt das explizite Rollenrecht *Folien steuern*; Layoutbearbeitung allein genügt nicht. Raspberry Pis im Intercom ein-/ausschalten (Ruhemodus) und neu starten dürfen nur der Admin und Rollen mit dem Recht *Raspberry Pis* (Benutzer & Rechte); der Schalter erscheint dann unten auf jeder Pi-Karte im Intercom und gilt für JMS Control genauso.
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
- Sicherheitsformat 3 übernimmt keine alten IP-Ausnahmen oder persönlichen Sitzungen automatisch. Vor dem Umschalten alle benötigten Stationen bewusst provisionieren und testen. Einen gesicherten persönlichen Adminzugang bereithalten; niemals zur Fehlerbehebung eine globale IP-/Netzbereichsfreigabe aktivieren (Netzbereiche nimmt der Server nicht an; einzelne feste IPs gibt es nur als „dauerhaft freigeschaltetes Gerät“, das weiterhin Name und Rolle braucht).

Die aktuellen Geräte-Zertifikate sind für ein Jahr ausgestellt. Rechtzeitig vor Ablauf mit neuem Schlüssel und Fingerprint ersetzen; Browser/NSS-Import und Registry koordiniert aktualisieren. Geräte-CA und Server-CA sind verschiedene Vertrauensanker. Der CA-Privatschlüssel bleibt ausschließlich geschützt auf dem Server unter `/etc/jms-auth/device-ca-private/`.

**Companion-Laufzeit:** Der Node-Worker erlaubt Dateizugriff nur im Modulverzeichnis und übernimmt die systemd-Umgebungsvariablen nicht. Der individuelle Schlüssel liegt deshalb unter `/opt/companion-module-dev/companion-module-kesher/jms-device.key`, Modus `0640 root:companion`, das Modulverzeichnis gehört root. `deviceTransport.ts` bestimmt diesen Ort relativ zum tatsächlichen Worker-Einstiegspunkt. Die öffentliche Caddy-CA ist unter `/usr/local/share/ca-certificates/jms-caddy-root.crt` im Systemvertrauen installiert. Die vier vorhandenen Modulinstanzen verwenden ausschließlich HTTPS/WSS mit verifizierten Zertifikaten; keine globalen Node-Dateirechte freigeben.

**Caddy 2.6.2:** `default_sni 192.168.0.230` und ebenfalls klientenzertifikatsgeprüfte No-SNI-Policies sichern IP-Aufrufe ab. Ein Regex-Mapping überträgt nur echte 64-stellige SHA-256-Fingerprints; ein nicht aufgelöster Platzhalter ist kein Gerätenachweis. `order request_header before forward_auth` entfernt gefälschte Eingangsdaten vor der Prüfung, ohne anschließend die gerade verifizierten Header wieder zu löschen. Regressionstests liegen in `multiview/test/caddy-device.test.js`.

**Pi-Verbindungsstatus:** Die Zuordnung zwischen Launcher-Heartbeat und Intercom-Verbindung verwendet die registrierte Geräte-ID und Rolle statt eines veränderlichen Anzeigenamens. Ein Gerät mit `heartbeat` darf am bestehenden Statusendpunkt ausschließlich seinen eigenen Status lesen, aber keine fremde Station sehen oder fernsteuern. Nur `pi-manage` beziehungsweise die bestehende berechtigte persönliche Rolle erhält den weitergehenden Zugriff. Dadurch vermeidet der Launcher falsche Verbindungsfehler und unnötige Browserneustarts. Gegenfälle für fremde IDs, fehlende Rechte, Widerruf und Auth-Ausfall sind getestet.

**Sicherung/Rückweg:** `/home/master/backups/device-auth-20261017` enthält konsistente Daten-, Quell- und Systemkopien; vorherige Images heißen `jms-multiview:device-rollback-20261017` und `compose-intercom:device-rollback-20261017`. Clientbackups liegen auf dem jeweiligen Gerät unter `/var/backups/jms-device/`. Vor Rückspielen den aktuellen Stand erneut sichern und Server, Registry, Caddy, Clientzertifikate/NSS, Companion und Satellite koordiniert zurücksetzen. Keine pauschale Wiederherstellung laufender SQLite-Dateien und kein dauerhaftes Wiederöffnen alter IP-/Klartextzugänge.

### Frühere .local-Namensauflösung und VPN-Pilot (historisch)

Seit 17.10.2026 veröffentlicht der bestehende Dienst `avahi-cname-aliases.service` die elf vorhandenen `.local`-Namen direkt als A-Adressen für `192.168.0.230`, statt CNAME-Verweise auf `server.local` zu senden. Dienstname und bestehende Avahi-Integration bleiben erhalten; es wurde kein zweites DNS-System eingerichtet. Router, DHCP und WLAN-Konfiguration wurden nicht geändert.

Auf dem Kamera-Pi, verbunden ausschließlich über WLAN, wurden direkte mDNS-Antworten sowie normale Systemauflösung und verifizierte HTTPS-Aufrufe für `intercom.local`, `technik.local` und `jmscontrol.local` bestätigt. Dabei wurde kein Clientzertifikat verwendet: die zentrale Anmeldung verlangte weiterhin den Tagescode. Das ist kein Nachweis für jedes Handy: Gastnetz-/Multicastfilter, VPN und fehlende mDNS-Unterstützung des jeweiligen Clients können weiterhin stören. Auf dem echten Handy explizit `https://intercom.local` und `https://technik.local` im Veranstaltungs-WLAN testen; einen Namensfehler von einer TLS-Warnung unterscheiden. HTTPS-IP bleibt der sichere Ausweichzugang. mDNS ist keine Geräteauthentifizierung.

Die ursprüngliche Alias-Konfiguration ist unter `/home/master/backups/mdns-addresses-20261017` gesichert. Ein gezielter Rückweg betrifft nur `/usr/local/sbin/avahi-cname-aliases.py` und den Neustart des gleichnamigen Dienstes.

**VPN-DNS:** Das MacBook löst die elf `.local`-Namen bereits über vorhandene `/etc/hosts`-Einträge auf; dies beweist keine mDNS-Weiterleitung durch Tailscale. Die eingeschränkte Tailscale-Regel `jms.de` → `192.168.0.230` ist inzwischen vom Benutzer eingerichtet und im Tailnet aktiv. Alle vier Hauptnamen wurden am Mac ohne `.jms.de`-Overrides über reguläre Namensauflösung mit verifiziertem HTTPS geprüft; der Benutzer bestätigt `intercom.jms.de` am Handy. Die vorhandenen neun `.jms.de`-Einträge bleiben als Rückfall erhalten. Backup vor deren früherer Ergänzung: `/home/master/backups/mdns-addresses-20261017/AdGuardHome.before-vpn-dns.yaml`.

**Gleiche Namen vor Ort und über VPN:** Auf Wunsch des Benutzers enthält der bestehende AdGuard nun einzelne Rewrites für alle elf vorhandenen Namen auf `192.168.0.230`: `intercom.local`, `kesher.local`, `jmscontrol.local`, `dashboard.local`, `technik.local`, `portainer.local`, `companion.local`, `glances.local`, `dns.local`, `setup.local`, `router.local`. Kein Wildcard-Eintrag für `.local`; mDNS, Authentifizierung, Rollen und HTTPS-Konfiguration bleiben unverändert. Prüfung: alle elf Namen über UDP/TCP korrekt, AAAA/HTTPS-RR ohne Fehler; alle neun `.jms.de`-Namen erhalten; unbekannter `.local`-Name weiterhin NXDOMAIN; zehn HTTPS-Start-/Anmeldeseiten mit geprüfter CA erreichbar, `setup.local` weiterhin HTTP. Der WLAN-Pi löst alle elf Namen auf und erreicht die drei Hauptdienste mit verifiziertem HTTPS.

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

Erwartung: Netzwerkmodus `host`, HTTP nur `127.0.0.1:8080`, kein Kesher-Listener auf UDP 8081, Healthcheck erfolgreich. Zusätzlich von einem zweiten Rechner prüfen, dass `192.168.0.230:8080` nicht erreichbar ist, HTTPS 8443 aber weiterhin authentifiziert funktioniert. Die zentrale Chat- und Rollenverwaltung spricht intern `http://127.0.0.1:8080` an; gültige Geräte-/Sitzungsnachweise bleiben trotzdem erforderlich.

Ein erfolgreicher Login oder WebSocket beweist noch keine Audioverbindung. In der Intercom-Diagnose muss WebRTC/ICE auf verbunden wechseln; die ausgewählte Kandidatenverbindung muss eine erreichbare Serveradresse verwenden. WLAN-/VPN-Regeln müssen direkte UDP-Verbindungen zum Server zulassen; isolierte Gastnetze oder ein nur für HTTPS freigegebener VPN können Audio weiterhin verhindern. Es wird nicht automatisch ein externer TURN-Dienst verwendet. Die lokalen Regressionstests prüfen Signalisierungsfallback, sichere Compose-Bindung sowie einen synthetischen Pion-DTLS-/SRTP-Paketaustausch ohne Mikrofon; die tatsächliche Netzstrecke, Mikrofonfreigabe, Lautsprecher, PTT, Echo und Hintergrundverhalten sind vor Ort separat abzunehmen. Keinesfalls den alten unverschlüsselten Relay als dauerhaften Workaround wieder einschalten.

## Dashboard

Das Dashboard (Homepage, `https://technik.internal`, IP-Rückfall `https://192.168.0.230:3000`) hat oben zwei Seiten zum Umschalten:

- **Start** – für alle: Intercom, Raspberry fernsteuern, Multiview, Fernbedienung, Prediger-Ansicht sowie *Konto* (Abmelden, Konto wechseln).
- **Admin** – Companion, Portainer, Glances, lokaler DNS, Router; Serverwerte (Prozessor, Arbeitsspeicher, Temperatur, Laufwerk, Prozesse, Container-Auslastung), darunter dieselben Werte für jeden Raspberry Pi (Abschnitt *Raspberry Pis*, Glances auf dem Pi, siehe `RASPBERRY-PI-STATIONEN.md`) und der Zustand jedes Containers.

Die Admin-Seite sieht nur, wer im Dashboard als Admin angemeldet ist (`custom.js` fragt `/.jms-auth/api/me`); alle anderen sehen nur „Start“ ohne Umschaltleiste – als Admin anmelden über *Konto → Konto wechseln*. Ist die zentrale Anmeldung aus, sehen alle beide Seiten. Die Admin-Dienste selbst prüft Caddy unabhängig davon.

Konfiguration im Repo unter `Kesher/server-config/homepage/` (`settings.yaml`: welche Gruppe auf welcher Seite, `services.yaml`: Kacheln, `custom.js`, `custom.css`). Auf dem Server liegen sie in `/opt/homelab/config/homepage/` (gehört root – ohne sudo per `docker cp <datei> homepage:/app/config/` kopieren). Änderungen an `settings.yaml` wirken erst nach `docker restart homepage`. **Danach** einmal `curl -s -H "Host: dashboard.local" http://127.0.0.1:3000/api/revalidate` auf dem Server – sonst liefert Homepage nach dem Neustart noch die alte, vorgefertigte Seite aus (fehlende Gruppen, falsche Reiter).

## Zentrales Admin-Passwort (30.10.2026)

Die Admin-PIN wird ausschließlich in **JMS Control → Einstellungen → Benutzer & Rechte → Admin-PIN** verwaltet. Drei Felder (altes Passwort, neues Passwort, Bestätigung) haben jeweils einen Sichtbarkeitsschalter. Das bisherige Passwort wurde unverändert als scrypt-Hash in `/data/access-secret.json` übernommen. Neue Passwörter dürfen 4 bis 128 Zeichen enthalten. Nach einer Änderung widerruft JMS Control wie bisher die bestehenden Sitzungen und Anmeldetickets; erneute Anmeldung ist erforderlich.

Kesher zeigt bei konfigurierter zentraler Anmeldung nur noch den Hinweis mit Link zur JMS-Control-Seite. Die alte Änderungs-API `/api/admin/pin` verweigert Änderungen im zentralen Betrieb. Zusätzliche PIN-Prüfungen delegiert Kesher über die HMAC-signierte HTTPS-API `/.jms-auth/api/verify-pin` an JMS Control (Passwort-Hash im Signaturtext, Quell-IP und Zeitstempel gebunden, Rate-Limit). Bei Ausfall gibt es keinen Rückfall auf das alte lokale Passwort. Ohne zentrale Konfiguration bleibt die eigenständige Kesher-Installation unverändert möglich.

Rollout und sofortiger Rückbau: `/home/master/admin-pin-central-20261030/`. Darin liegen Quellsicherung, Image-Tags `*:before-central-pin-20261030`, eine nur für root lesbare Sicherung des vorherigen Zugangsspeichers und der Kesher-Datenbank sowie `rollback.sh`. Rückbau nur unmittelbar nach diesem Rollout verwenden; spätere Passwort- oder Sitzungsänderungen würden sonst überschrieben. Bei der Umstellung wurde kein neues Passwort gewählt.

## Veranstaltungsbetrieb in JMS Control und Dashboard (30.10.2026)

- JMS Control → Übersicht: bestehende Schnellzugriffe zuerst, darunter „Heute im Einsatz“, das eingeteilte ChurchTools-Technikteam und Bereitschaft pro Kesher-Technikrolle. Veranstaltung und Hinweis verwaltet der Admin; normale Rollen melden ausschließlich ihre eigene Bereitschaft. ChurchTools-Dienstzusage und technische Bereitschaft sind getrennt.
- Die ChurchTools-Anbindung liest `/events`, `/events/{id}`, `/services`, `/servicegroups` mit dem bestehenden Serverzugang. Nur Dienste der Kategorie „Technik“ (bzw. technical/production) werden übernommen; verborgene Namen bleiben verborgen. Kein Schreiben nach ChurchTools. Automatische Auswahl: laufende bzw. nächste Veranstaltung; ein Admin kann eine Veranstaltung aus den nächsten vier Wochen fest auswählen.
- Dashboard → Start: Mängelliste unter den Diensten. Dashboard → Admin: Startcheck, Verbindungswege/Fehlerhilfe, Mängelliste, Sicherungen und Änderungen. Startcheck und Infrastrukturdetails benötigen Adminrechte; die Mängelliste ist für angemeldete normale Rollen verfügbar. Chat-only bleibt ausschließlich Chat.
- Benötigte Systeme und Sichtprüfungen gelten pro Veranstaltung. Fehlende Rückmeldungen bleiben „Ungeprüft“; verschwundene benötigte Verbindungen verschwinden nicht aus dem Ergebnis. ATEM-/ProPresenter-/Companion-Verbindungen sind keine Bild- oder Audioprüfung. LED-Wand, Stage Display und Stream Decks werden gesondert vor Ort bestätigt.
- Mängel: Gerät/Bereich, Beschreibung, Zuständigkeit, Dringlichkeit, Bearbeitungsstatus, optional Foto. Eigene Rolle bzw. Admin darf bearbeiten. Erledigte Einträge bleiben erhalten. Fotos werden im Browser verkleinert und serverseitig auf JPEG/PNG/WebP und max. 1,5 MB geprüft. Keine öffentliche Bildfreigabe.
- Persistente Daten: Multiview-Volume `/data/event-ops.json`, Fotos `/data/ops-photos/`. Atomare Schreibvorgänge, Versions-/Zeitstandprüfung bei konkurrierenden Änderungen. Eine beschädigte Datendatei wird nicht still überschrieben. APIs unter `/api/ops/*` und `/.jms-auth/api/ops/*` verwenden bestehende Anmeldung, Chat-only-Sperre und Origin-Prüfung.
- Code: `multiview/event-ops.js`, `event-ops-checks.js`, `public/event-ops.js`, `public/event-ops.css`; Einbindung in `server.js`, `Dockerfile`, `public/index.html`. Homepage lädt die gemeinsamen Assets über den Zusatz in `/opt/homelab/config/homepage/custom.js`. Kein weiterer öffentlicher Port.
- Read-only-Erfassung: `/usr/local/lib/jms-ops/collect-ops.py`, `jms-ops-collect.timer` jede Minute. Schreibt nur `/data/ops-infra.json` und den privaten Vergleichsstand `/var/lib/jms-ops/state.json`. Erfasst freie Platte, Containerzustand, Archivnachweise und Änderungen bekannter Konfigurations-/Programmdateien. Veraltete Messwerte (>3 min) werden nicht grün gewertet. Änderungen sind Dateibeobachtungen ab Installationszeitpunkt, keine lückenlose historische Personen-Auditierung.
- Sicherungsanzeige: bekannte lokale Vollarchive unter `/home/master/backups/full-*` und gemeinsames Modularchiv `/home/master/event-ops-20261030/private-backup/companion-custom-modules.tar.gz`. Ein Archivnachweis ist kein Restore-Test. Der vorhandene `jms-backup-cloud.timer` war bei Einführung deaktiviert und wurde nicht aktiviert. Der vorhandene Sicherungsjob stoppt Kesher/Companion zeitweise und darf nicht ungeplant während einer Veranstaltung gestartet werden.
- Rollout/Sicherung: `/home/master/event-ops-20261030/`; `before/` enthält vorherige Quelldateien/Homepage, `private-backup/` die geschützte JMS-JSON-Sicherung und das lesend geprüfte Archiv eigener Companion-Module inklusive Update-Schutz. Vorheriges Image `jms-multiview:before-event-ops-20261030`, neues `jms-multiview:event-ops-20261030` sowie `latest`. `rollback.sh` setzt Oberfläche/Serverimage zurück und deaktiviert ausschließlich den neuen Erfassungstimer. Benutzer-, Passwort- und Veranstaltungsdaten werden dabei nicht zurückgespielt. Nach späteren fremden Änderungen den Rollback zuerst abgleichen.
- Prüfung: vollständige Node-Suite mit produktionsgleicher Node-22-Laufzeit; zusätzliche Rollen-, Persistenz-, Konflikt-, Foto-, Stale-Status- und HTTP-Zugriffstests. Browser-Formulartests bei Desktopbreite und 390 px; Live-Prüfung in authentifiziertem Safari mit echten ChurchTools- und Infrastruktur-Daten. Physische Gerätefunktion/Restore nicht vor Ort getestet.

### 2026-10-30: Ablauf in Heute im Einsatz
JMS Control zeigt unter Datum/Uhrzeit den ChurchTools-Ablauf der dort ausgewählten Veranstaltung; der Countdown steht rechts daneben (bei wenig Platz Umbruch). Die ersten sechs Punkte sind direkt sichtbar, weitere aufklappbar. Uhrzeiten, Dauer, Verantwortliche und aufklappbare Hinweise verwenden die bestehende ChurchTools-Normalisierung. Abrufe werden je Veranstaltung 60 Sekunden zwischengespeichert; leere Abläufe und Fehler sind ausdrücklich gekennzeichnet. Bei Verbindungsfehlern bleibt ausschließlich der letzte Ablauf derselben Veranstaltung mit Warnhinweis sichtbar. Keine Änderung der Veranstaltung in ChurchTools.
Sicherung inklusive vorherigem Image und gezieltem Rollback: /home/master/event-agenda-20261030/. Nutzdaten und Passwörter werden beim Rollback nicht zurückgesetzt.
