# Raspberry-Pi-Messwerte: automatische IP-Übernahme (2026-11-02)

Die Homepage-Kacheln für Kamera-1 verwendeten noch 192.168.0.161. Der registrierte Pi meldet sich inzwischen als `kamera-1-pi` mit 192.168.0.234. Die Verbindungskarte verwendet bereits Kesher-Statusmeldungen, die Glances-Kacheln hatten feste URLs.

`jms-pi-dashboard.timer` startet alle 30 Sekunden `/usr/local/lib/jms-pi-dashboard/sync.py`. Dieser liest ausschließlich die Tabelle `raspberry_pi_heartbeats` aus Kesher per SQLite `mode=ro` / `query_only`. Die Zuordnung erfolgt explizit über `/etc/jms-pi-dashboard.json`: Gruppe Raspberry Pis, Untergruppe Kamera-1, Geräte-ID kamera-1-pi. Änderungen der Namen oder zusätzliche Stationen erfordern eine entsprechende Zuordnung in dieser Datei.

Nur Meldungen der letzten 120 Sekunden mit gültiger privater IPv4-Adresse werden berücksichtigt. Bei fehlenden, veralteten, zukünftigen oder ungültigen Meldungen bleibt die letzte Adresse erhalten. Neue Zieladressen werden vor dem Schreiben auf eine gültige Glances-v4-CPU-Antwort geprüft; Fehler lassen die bisherige Konfiguration unverändert und werden im Journal protokolliert. Der Timer versucht es erneut. Bei einer schemaändernden Kesher-Aktualisierung bleibt die bisherige Konfiguration ebenfalls erhalten; ein solcher Fall benötigt Anpassung des Lesers.

Es werden nur die sieben Glances-URL-Felder in `/opt/homelab/config/homepage/services.yaml` verändert. Kommentare, andere Dienste und Dateirechte bleiben erhalten. Backup vor jeder Änderung unter `/var/lib/jms-pi-dashboard/services.<sha256>.yaml` (0600), atomarer Austausch und Dateivergleich gegen parallele Änderungen. Homepage lädt die Konfiguration ohne Container-Neustart nach. Bereits geöffnete Seiten können bei Bedarf neu geladen werden.

Zusätzlich wurde die Kachel WLAN in Netzwerk umbenannt und auf `network:eth0` eingestellt: Der Pi ist aktuell per LAN verbunden, wlan0 ist DOWN. Ein Wechsel des Netzwerkinterfaces ist getrennt von einem reinen IP-Wechsel; gegebenenfalls das Metric-Feld anpassen.

Runtime liegt außerhalb der Docker-Images; Homepage-Updates überschreiben ihn nicht. Quell-/Testkopie unter `/home/master/intercom-system/scripts/pi-dashboard/`.

Prüfung: sechs erfolgreiche Tests (gezielte URL-Änderung, Idempotenz, simulierter weiterer IP-Wechsel, veraltete/ungültige/fremde Meldungen, mehrdeutige Zuordnung, atomare Sicherung/Konflikterkennung, aktive WAL-Datenbank). Alle sieben Abfragen über die echte Homepage-Proxy-API HTTP 200, konfigurierte CPU-Temperatur, Root-Dateisystem, SD-Gerät und LAN-Interface vorhanden. Kein echter IP-Wechsel am produktiven Gerät ausgelöst; kein Pi-, Browser-, Kesher- oder Kiosk-Neustart.

Status: `systemctl status jms-pi-dashboard.timer` und `journalctl -u jms-pi-dashboard.service`.

Rollback: `sudo sh /home/master/pi-dashboard-address-20261102/rollback.sh` deaktiviert den Timer und stellt die vorherige services.yaml wieder her. Das setzt die alten URLs wieder ein; vorher spätere Änderungen an services.yaml prüfen. Originalbackup: `/home/master/pi-dashboard-address-20261102/before/services.yaml`.
