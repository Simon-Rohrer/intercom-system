# Kesher

Kesher ist ein lokales, webbasiertes Intercom-System für Live-Produktionen. Operatoren nutzen Browser, Raspberry-Pi-Kiosk-Stationen und optional Stream Decks über Companion.

## Wichtige Dokumentation

- [Dokumentationsübersicht](../Dokumentationen/DOKUMENTATIONSUEBERSICHT.md)
- [Vorstellung](../Dokumentationen/VORSTELLUNG.md)
- [Betrieb](../Dokumentationen/BETRIEB.md)
- [Raspberry-Pi-Stationen](../Dokumentationen/RASPBERRY-PI-STATIONEN.md)
- [Companion und Stream Deck](../Dokumentationen/COMPANION-STREAM-DECK.md)
- [Telegram-Bot](../Dokumentationen/TELEGRAM-BOT.md)

## Schnellstart Entwicklung

```sh
make deps
make dev-backend
make dev-web
```

Backend mit gebauter Weboberfläche:

```sh
make run-backend
```

Tests:

```sh
make test
```

## Produktion

Standardbetrieb über Docker Compose:

```sh
make docker-up
make docker-down
```

Serverbetrieb, Ports, Logs, Update und Backup stehen in [Betrieb](../Dokumentationen/BETRIEB.md).
