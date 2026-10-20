# Telegram-Bot

Telegram ist optional. Es wird nur benötigt, wenn Telegram-Chats mit Kesher-Party-Lines verbunden werden sollen.

## Bot erstellen

1. In Telegram `@BotFather` öffnen.
2. `/newbot` senden.
3. Namen und Bot-Username vergeben.
4. Bot-Token kopieren.
5. Für Gruppen: `Bot Settings` -> `Group Privacy` -> `Disabled`.

## Chat-ID ermitteln

Bot zur Gruppe hinzufügen, Nachricht senden und im Browser öffnen:

```text
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Die Chat-ID steht in der Antwort unter `chat.id`.

## Kesher konfigurieren

Umgebungsvariable setzen:

```sh
TELEGRAM_BOT_TOKEN=<token>
```

Polling ist der Standard und für LAN-Server empfohlen:

```sh
TELEGRAM_MODE=polling
```

Webhook nur nutzen, wenn der Server öffentlich per HTTPS erreichbar ist:

```sh
TELEGRAM_MODE=webhook
TELEGRAM_WEBHOOK_SECRET=<secret>
```

## Mapping in Kesher

Im Adminbereich:

1. Telegram-Bot-Integration öffnen.
2. Mapping hinzufügen.
3. Telegram-Chat-ID eintragen.
4. Label vergeben.
5. Party-Line auswählen.
6. speichern.

## Fehler prüfen

- Bot-Token korrekt?
- Bot ist Mitglied der Gruppe?
- Group Privacy deaktiviert?
- Chat-ID stimmt?
- Server erreicht `api.telegram.org:443`?
- Telegram-Nutzer steht in der Allowlist, falls er nach Kesher schreiben soll?
