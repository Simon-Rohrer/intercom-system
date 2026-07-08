# Kesher Companion-Modul

Dieses Modul verbindet Bitfocus Companion mit Kesher. Es steuert bestehende Browser-Sessions über Rollen-IDs und stellt Stream-Deck-Slots mit Live-Labels, Farben und Buttonbildern bereit.

## Betrieb

Kurzanleitung:

- [Companion und Stream Deck](../Dokumentationen/COMPANION-STREAM-DECK.md)

## Bauen

```sh
npm install
npm run build
npm run package
```

Das erzeugte Paket wird in Bitfocus Companion als lokales Modul importiert.

## Wichtig

- Ziel ist `roleId`, nicht ein freier Username.
- Companion ist nur Eingabe- und Anzeigeoberfläche.
- Die Button-Logik liegt in Kesher.
- Presets aus `Universal Synced Layout` müssen einmal in Companion platziert werden.
