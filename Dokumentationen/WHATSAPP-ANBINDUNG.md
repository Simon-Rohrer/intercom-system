# WhatsApp-Anbindung

WhatsApp ist aktuell nicht eingebaut. Falls WhatsApp-Gruppen mit Kesher-Party-Lines verbunden werden sollen, ist die sauberste technische Variante eine direkte Go-Integration mit `whatsmeow`.

## Wichtige Einordnung

- `whatsmeow` nutzt WhatsApp Web Multidevice.
- Das ist technisch passend fuer Kesher, aber keine offizielle Meta-API.
- Es besteht ein Restrisiko, dass WhatsApp die Kopplung trennt, die API aendert oder die Nummer einschraenkt.
- Fuer produktiven Betrieb sollte eine eigene WhatsApp-Nummer nur fuer Kesher genutzt werden.

## WhatsApp-Account

Auch mit WhatsApp-Usernames wird weiterhin ein echter WhatsApp-Account mit Telefonnummer benoetigt.

Empfohlen:

1. Separate SIM oder eSIM verwenden.
2. WhatsApp oder WhatsApp Business einrichten.
3. Anzeigename zum Beispiel `Kesher Intercom`.
4. Optional Username setzen, sobald verfuegbar, zum Beispiel `@kesher-intercom`.
5. Diese Nummer in die gewuenschten WhatsApp-Gruppen aufnehmen.

Der Username kann die Telefonnummer nach aussen besser schuetzen. Fuer die technische Anmeldung und die Verknuepfung wird trotzdem ein Account mit Telefonnummer gebraucht.

## Geplanter Aufbau

```text
WhatsApp-Gruppe
-> whatsmeow im Kesher-Backend
-> Kesher-Chat
-> Party-Line
```

Und zurueck:

```text
Kesher Party-Line
-> Kesher-Backend
-> whatsmeow
-> WhatsApp-Gruppe
```

## Umsetzung in Kesher

1. `whatsmeow` ins Go-Backend integrieren.
2. WhatsApp-Session dauerhaft in der Kesher-Datenbank oder unter `/app/data` speichern.
3. Im Adminbereich QR-Code anzeigen und einmal mit WhatsApp scannen.
4. WhatsApp-Gruppen-ID ermitteln.
5. Mapping speichern: `WhatsApp-Gruppe -> Party-Line`.
6. Eingehende WhatsApp-Nachrichten als Kesher-Chat mit Quelle `whatsapp` senden.
7. Kesher-Chat-Nachrichten aus gemappten Party-Lines an WhatsApp senden.
8. Loop-Schutz einbauen, damit WhatsApp-Nachrichten nicht wieder zurueck nach WhatsApp gespiegelt werden.

## Erster sinnvoller Umfang

- Nur Textnachrichten.
- Nur WhatsApp-Gruppen.
- Keine Medien.
- Keine Sprachnachrichten.
- Keine Direct Messages.
- Eine WhatsApp-Session.
- Adminbereich fuer Status, QR-Code und Gruppen-Mapping.

## Fehler pruefen

- Ist die WhatsApp-Session verbunden?
- Wurde der QR-Code erfolgreich gescannt?
- Ist die Kesher-Nummer Mitglied der Gruppe?
- Stimmt die Gruppen-ID?
- Ist die Gruppe einer Party-Line zugeordnet?
- Wurde die Session von WhatsApp getrennt?
- Wird `source = whatsapp` korrekt gesetzt, damit kein Nachrichten-Loop entsteht?
