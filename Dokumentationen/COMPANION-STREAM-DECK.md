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

Die Presets sind pro Rolle gruppiert (`Kesher / <Rolle> / Seite <n>`). Für Tasten, die eine Person anrufen oder ansprechen sollen, `Direct role` statt `Direct user` verwenden: dann funktioniert die Taste, egal wer gerade in der Rolle angemeldet ist.

## Incoming calls indicator

Die Taste blinkt, sobald die Rolle einen Call bekommt (direkt oder auf einer Party Line, auf der `Listen` an ist). Sie blinkt, bis der Call bestätigt wird, höchstens 30 Sekunden.

Bestätigen:

- die Indikator-Taste drücken,
- `Reply to caller` drücken,
- oder die Taste drücken, die zum Anrufer passt (z. B. `Direct role` der anrufenden Rolle oder die Party Line).

Nach einem Update des Companion-Moduls die Indikator-Taste einmal neu aus den Presets ziehen, damit sie beim Drücken bestätigt.

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
