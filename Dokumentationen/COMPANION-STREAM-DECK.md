# Companion und Stream Deck

Companion ist bei Kesher nur Eingabe- und Anzeigeoberfläche. Die Button-Logik liegt in Kesher. In Companion werden einmal universelle Slots platziert, danach steuert Kesher Label, Farbe, Bild und Aktion.

## Modul bauen

```sh
cd companion
npm install
npm run build
npm run package
```

Das erzeugte Paket in Bitfocus Companion als lokales Modul installieren.

## Connection einrichten

Wichtige Felder:

| Feld | Wert |
| --- | --- |
| `Backend host` | IP oder Hostname des Kesher-Servers |
| `Backend port` | `8080`, `8443` oder `443` |
| `Use TLS` | aktiv bei HTTPS |
| `Target role ID` | Kesher-Rollen-ID |
| `Target page override` | meistens `-1` |

Aktuelle Kesher-Verbindungen sollen über `roleId` laufen.

## Layout nutzen

1. In Kesher Admin das Stream-Deck-Profil der Rolle bearbeiten.
2. Profil für Companion veröffentlichen.
3. In Companion die Presets aus `Universal Synced Layout` einmal auf die Tasten ziehen.
4. Spätere Änderungen nur noch in Kesher veröffentlichen.

Eine Kesher-Verbindung in Companion gehört zu genau einer Rolle (`Target role ID`) und zeigt nur die Presets dieser Rolle (`Kesher / <Rolle> / Seite <n>`). Bedient ein Companion mehrere Plätze, pro Rolle eine eigene Kesher-Verbindung anlegen (z. B. `kesher_licht` mit `lighting`, `kesher_propresenter` mit `audio`) und jedem Stream Deck die Tasten aus seiner Verbindung geben. Nur so bekommt jede Taste Calls, Bilder und Status der richtigen Rolle. Für Tasten, die eine Person anrufen oder ansprechen sollen, `Direct role` statt `Direct user` verwenden: dann funktioniert die Taste, egal wer gerade in der Rolle angemeldet ist.

## Incoming calls indicator

Die Taste blinkt, sobald die Rolle einen Call bekommt (direkt oder auf einer Party Line, auf der `Listen` an ist). Sie blinkt, bis der Call bestätigt wird, höchstens 30 Sekunden.

Bestätigen:

- die Indikator-Taste drücken,
- `Reply to caller` drücken,
- oder die Taste drücken, die zum Anrufer passt (z. B. `Direct role` der anrufenden Rolle oder die Party Line).

Nach einem Update des Companion-Moduls die Indikator-Taste einmal neu aus den Presets ziehen, damit sie beim Drücken bestätigt.

## Chat-Nachricht per Taste

Eine Taste kann einen festen Satz (z. B. „Bitte leiser“) in den Chat schicken.

1. In der Station unter `Einstellungen → Stream Deck` eine Taste wählen.
2. Bei `Function` den Eintrag `Chat-Nachricht senden` wählen.
3. Bei `Nachricht` den Text eintragen (Pflichtfeld, höchstens 200 Zeichen).
4. Bei `Senden an` `Global (alle)` oder eine Party Line wählen. Angeboten werden nur Party Lines, auf denen die Rolle sprechen darf.
5. `Save` und danach `Publish to Companion`.

Als Absender erscheint die angemeldete Station mit ihrer Rolle. Ist für die Rolle gerade niemand angemeldet, erscheint die Rolle selbst als Absender. Im Chat und auf der Chat-Anzeige sind solche Nachrichten mit `Stream Deck` markiert. Auf der Chat-Anzeige am Server-Bildschirm blinkt bei jeder neuen Stream-Deck-Nachricht der Bildschirm gelb wie bei einem Call (etwa 4 Sekunden); ältere Nachrichten nach einem Neustart blinken nicht. Die Nachricht wird nur beim Drücken gesendet, nicht beim Loslassen.

## Prüfen

Wichtige Variablen:

- `bridge_connected`
- `bridge_bound`
- `image_connected`
- `image_stored_images`
- `image_last_message_at`

Debug-Bild im Browser:

```text
/api/debug/button-image-preview
```

Wenn Bilder fehlen:

1. Backend neu starten.
2. Companion-Instanz deaktivieren und aktivieren.
3. aktuelle Presets neu platzieren.
4. Host, Port, TLS, Secret und `Target role ID` prüfen.
