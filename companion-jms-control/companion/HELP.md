# JMS Control

Schaltet die Multiviews von JMS Control (Multiview-Server) per Stream Deck um und zeigt Ablauf und Event-Ops.

## Multiview

- **Aktion „Multiview: Layout zeigen“**: Multiview und Layout aus den Listen wählen.
- **Aktion „Multiview: nächstes / vorheriges Layout“**
- **Aktion „Bildschirm: Multiview zuweisen“**: einen Bildschirm am Server auf einen Multiview (oder schwarz) stellen.
- **Rückmeldung „Layout ist aktiv“**: Taste leuchtet, solange das Layout auf dem Multiview läuft.
- **Presets**: unter „JMS Control / <Multiview>“ je Layout eine fertige Taste.

## Ablauf (ChurchTools)

- **Aktionen „Ablauf: nächster Punkt“, „Ablauf: vorheriger Punkt“, „Ablauf: wieder nach Uhr“**: setzen den laufenden
  Punkt wie die Bedienung der Ablauf-Kachel. Event: „Aktuelles Event“ = das Event, das die Ablauf-Kachel zeigt
  (Kachel mit Bedienung zuerst, dann eine sichtbare Kachel), oder ein festes Event aus der Liste.
- **Variablen**: `$(jms-control:agenda_current)` (laufender Punkt), `agenda_remaining` (Restzeit m:ss),
  `agenda_deviation` („+4 min“, nach Uhr „nach Plan“), `agenda_next`, `agenda_next_responsible`, `agenda_event`,
  `agenda_level` (ok/warn/bad), `agenda_manual`. Sie zeigen immer das aktuelle Event.
- **Rückmeldungen**: „Ablauf: Abweichung vom Plan in Stufe“ (grün/gelb/rot, Schwellen der Ablauf-Kachel),
  „Ablauf: Punkt von Hand gesetzt“.
- **Presets** unter „Ablauf“: Status (Punkt, Restzeit, Abweichung in Ampelfarbe), ◀ / ▶, „Nach Uhr“, „Dann“.

## Event-Ops

- **Variablen**: `$(jms-control:ops_overall)` (OK / Prüfen / Fehler), `ops_problems` (Anzahl), `ops_first`
  (wichtigstes Problem), `ops_level` (ok/warn/error/unknown).
- **Rückmeldung „Event-Ops: Ampel zeigt“** (grün/gelb/rot/unbekannt).
- **Presets** unter „Event-Ops“: Ampel mit Anzahl, wichtigstes Problem.

Die Verbindung meldet sich mit dem Geräteschlüssel `jms-device.key` neben dem Modul an
(festes Gerät „Companion-JMS-Control“, Steuerrechte nur für den Multiview).
