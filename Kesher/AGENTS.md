# AGENTS.md

Kurzhinweise für Agenten und lokale Entwicklung.

## Vor jeder Änderung

- vorhandene Struktur prüfen
- bestehende Komponenten, Routen, Datenmodelle und Services wiederverwenden
- keine parallelen Ersatzsysteme aufbauen
- keine Nutzeränderungen zurücksetzen

## Wichtige Befehle

```sh
make deps
make dev-backend
make dev-web
make build
make test
```

Gezielte Backend-Tests:

```sh
cd backend && go test ./...
```

Frontend-Build:

```sh
cd web && npm run build
```

## Dokumentation

Nur die gekürzte Dokumentation pflegen:

- [Dokumentationsübersicht](../Dokumentationen/DOKUMENTATIONSUEBERSICHT.md)
- [Betrieb](../Dokumentationen/BETRIEB.md)
- [Vorstellung](../Dokumentationen/VORSTELLUNG.md)
