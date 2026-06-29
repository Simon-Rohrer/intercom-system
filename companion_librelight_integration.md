# Librelight & Bitfocus Companion Integration

## Analyse der Ausgangslage

Ich habe mir die Architektur deines **Librelight** Projekts angesehen. Hier sind die wichtigsten Erkenntnisse:

1. **Interne Kommunikation:** Librelight kommuniziert intern über TCP-Sockets auf bestimmten Ports (u. a. Port `30003` für UI/Exec-Commands).
2. **Datenformat:** Die über den Socket gesendeten Daten werden stark komprimiert (`zlib`), danach `base64`-kodiert und mit einem Null-Byte terminiert (`\x00`). Ein simples "Generic TCP" Modul aus Companion kann dieses Format daher leider nicht *direkt* ohne Weiteres nativ erzeugen.
3. **Das CLI-Tool:** Die gute Nachricht ist, dass Librelight bereits ein Command-Line-Interface (CLI) Script mitliefert: `Xdesk/remote/cli.py`. Dieses Script ist genau dafür gedacht, von außen Befehle (wie z.B. das Drücken eines Executors) lokal in das laufende System einzuspeisen.

**Syntax des CLI-Tools:**
```bash
python3 /opt/LibreLight/Xdesk/remote/cli.py exec <EXECUTOR_ID> <COMMAND>
```
Mögliche Commands sind `on`, `off` oder `go`.

---

## Mögliche Lösungswege

Um einen Button in Companion mit einem Executor in Librelight zu verbinden, gibt es mehrere Herangehensweisen. 

### Lösung 1: Verbindung über SSH (Empfohlen & am einfachsten)

Da Librelight auf einem Linux/Debian-System läuft (laut README) und Companion ein hervorragendes **SSH-Modul** besitzt, können wir Companion einfach anweisen, den CLI-Befehl per SSH remote auszuführen.

**Einrichtung in Companion:**
1. Gehe in Companion auf den Reiter **Connections** (oder *Instances*).
2. Füge eine neue Verbindung vom Typ **Generic: SSH** hinzu.
3. **Konfiguration der Verbindung:**
   - **Host:** IP-Adresse des Librelight-Rechners (z.B. `10.10.10.x`)
   - **Port:** `22` (Standard für SSH)
   - **Username:** `user` (Der Benutzername auf dem Debian-System, laut Doku)
   - **Password:** Dein SSH-Passwort
4. **Button konfigurieren:**
   - Erstelle einen neuen Button in Companion.
   - Füge eine **Action** (Press Action) hinzu: Wähle die SSH-Verbindung und die Aktion **"Run Command"**.
   - Trage bei Command folgenden Befehl ein (Beispiel für Executor 1):
     ```bash
     /usr/bin/python3 /opt/LibreLight/Xdesk/remote/cli.py exec 1 go
     ```
   - *(Hinweis: Der Pfad `/opt/LibreLight/...` muss eventuell an deinen tatsächlichen Installationspfad auf dem Server angepasst werden, falls er abweicht.)*

Wenn du nun den Button drückst, loggt sich Companion im Hintergrund per SSH ein und feuert den `exec go` Befehl ab, als würdest du ihn im Terminal tippen.

**Erwartete Latenz (Reaktionszeit) bei SSH:**
Da das generische SSH-Modul von Companion die Verbindung nach dem Start in der Regel **dauerhaft offen hält**, entfällt der aufwendige Login bei jedem einzelnen Tastendruck. 
* Die reine Netzwerkübertragung dauert meist nur **1-5 ms**.
* Das Starten des Python-Scripts (`cli.py`) auf dem Librelight-PC benötigt zusätzlich ca. **20-50 ms**.
* **Gesamtlatenz:** Du kannst bei jedem Tastendruck mit einer Reaktionszeit von **ca. 30 bis 80 Millisekunden** rechnen. 

*Fazit zur Latenz:* Für das Starten von Cues, Farbwechseln oder Szenen-Management ist das absolut flüssig und unmerklich. Lediglich für extrem schnelle, manuelle "Flash"-Tasten (z.B. Strobe exakt im Takt tippen) könnte sich diese minimale Verzögerung bemerkbar machen.

---

### Lösung 2: Einen kleinen HTTP-Server (API) bereitstellen

Falls SSH zu langsam sein sollte (manchmal gibt es eine minimale Verzögerung durch den SSH-Handshake), kann man ein kleines, leichtgewichtiges Python-Script auf dem Librelight-Rechner als Dienst laufen lassen. 
Dieses Script startet einen simplen Webserver, der auf HTTP-Requests hört und dann intern das `cli.py` triggert.

**Ablauf:**
1. Wir schreiben ein Script (z.B. `http_api.py`), das z.B. auf Port `8080` lauscht.
2. In Companion nutzt du das Modul **Generic: HTTP Requests**.
3. Der Button führt einen simplen GET-Request aus: `http://<IP-LIBRELIGHT>:8080/exec/1/go`.
4. Das Python-Script empfängt den Request und löst den Executor lokal und blitzschnell aus.

---

### Lösung 3: Ein OSC-Listener (UDP)

Lichtpulte und Companion arbeiten sehr gerne mit OSC (Open Sound Control via UDP). Ähnlich wie bei Lösung 2 bräuchte man ein kleines Bridge-Script auf dem Librelight-Rechner (`osc_bridge.py`), das UDP-Pakete empfängt und in Librelight-Befehle übersetzt. 
Companion würde dann einfach über sein OSC-Modul Befehle wie `/exec/1/go` (Type: Integer) verschicken.

---

## Fazit & Nächste Schritte

Da du erstmal keine direkte Umsetzung wolltest, ist dies die theoretische Bestandsaufnahme. 

**Mein Vorschlag für das weitere Vorgehen:** 
Wir können im nächsten Schritt testen, ob **Lösung 1 (SSH)** für dich von der Reaktionszeit her ausreichend ist, da sie komplett ohne Änderungen am Code auskommt. 

Sollte es für Timing-kritische Aktionen (z.B. schnelle Flash-Tasten, Strobe-Effekte) zu viel Latenz haben, bauen wir **Lösung 2 (HTTP API)** oder **Lösung 3 (OSC)** ein. Das wäre dann nur ein kleines Script (ca. 30 Zeilen Code), das wir zu Librelight hinzufügen, um Companion den direkten API-Zugriff zu ermöglichen.

Lass mich wissen, wie du die Vorschläge findest und welchen Weg wir weiter verfolgen sollen!
