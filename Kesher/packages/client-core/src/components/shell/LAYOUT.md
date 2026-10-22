<!--
  LAYOUT-PLAN Kesher (Intercom) im Stil von JMS Control – PC und Handy
  =====================================================================

  Grundgerüst (gleich auf PC und Handy, components/shell/AppShell.tsx + styles/shell.css)
  -----------------------------------------------------------------------------------
  .k-shell
    aside.k-sidebar           Seitenleiste (Glas, wie JMS Control)
      .k-sidebar-head         Marke (4 Quadrate + „Intercom“ / „Kesher“) + Knopf „Seitenleiste ausblenden“
      nav.k-site-nav          1. „Dashboard“ (zurück zum Dashboard, nicht in der Desktop-App)
                              2. Einträge der jeweiligen Ansicht (siehe unten)
      .k-sidebar-foot         Benutzerkarte: Avatar (Initialen), Name, Rolle,
                              Knöpfe „Konto wechseln“ und „Abmelden“
    .k-sidebar-backdrop       nur Handy: dunkler Schleier hinter der offenen Seitenleiste
    .k-main-col
      header.k-topbar         ☰ (nur Handy) · Status der Seite (Live-Punkt, Rolle, Mikrofon-Pegel) · Seitenaktionen
      main.k-main             die eigentliche Seite

  Einträge in der Seitenleiste
  ----------------------------
  Bediener (Operator-Sitzung):
    Dashboard · Intercom · Einstellungen
  Admin (Admin-Sitzung per PIN oder zentralem Admin):
    Dashboard · Admin, darunter gruppiert wie in JMS Control:
      Setup:    Showfile, Rollen, Benutzer, Party Lines, Kanäle, Routing
      Geräte:   Companion, Stream Deck
      Dienste:  Telegram, Chatverlauf
      Betrieb:  Live-Zustand, Logs, Admin-PIN
    (Eine Admin-Sitzung hat in Kesher keinen Ton – Sprechen/Hören gibt es nur in einer
     Bediener-Sitzung. Deshalb zeigt die Admin-Sitzung kein „Intercom“; zum Sprechen
     „Konto wechseln“ bzw. abmelden und als Bediener anmelden.)

  Intercom-Seite (Bediener) – das Wichtigste bleibt sofort erreichbar
  -------------------------------------------------------------------
  - Kopfleiste: Rolle, Name, Live-Punkt und Mikrofon-Pegel (immer sichtbar, oben fixiert).
  - Sprechleiste (Sprechen gedrückt halten · Anrufer antworten · Dauerhaft an) direkt unter
    der Kopfleiste, auf dem PC oben, auf dem Handy als Daumenleiste unten (wie bisher).
  - Darunter die Tasten als Karten: Party Lines, Direkt, Durchsage – links; Chat und
    Raspberry Pis rechts als eigene Karten (ab 1101 px nebeneinander, darunter untereinander).
    Farben: Rot = Sprechen, Grün = Hören, Gelb = Rufen – in hell und dunkel mit gutem Kontrast.
  - Raspberry-Karte: Zustand, IP, Launcher, Prüfungen (Pi/Browser/Intercom), Messwerte;
    unten Ein/Aus (Ruhemodus) und Neu starten – nur mit dem Recht „Raspberry Pis“ in JMS Control.
  - Die Seitenleiste nimmt auf dem PC Platz weg; sie lässt sich ausblenden (wird pro Gerät
    gemerkt). Während einer Sendung kann man so die ganze Breite für die Tasten nutzen.

  Einstellungen (Bediener)
  ------------------------
  Das frühere Fenster „Station-Setup“ ist jetzt eine normale Seite „Einstellungen“ mit dem
  Menü wie in JMS Control: links Gruppen mit farbigen Icon-Einträgen, rechts der Bereich als Karte.
    Ansicht: Layout · Bedienung: Sprechen & Antworten, Tastenkürzel ·
    Ton: Ton & Mikrofon · Geräte: Stream Deck, System
  Handy: erst die Liste, nach der Wahl nur der Bereich mit „‹ Einstellungen“ zurück.
  Die Intercom-Seite bleibt im Hintergrund geladen (Ton, Chat und Tasten laufen weiter);
  ein Klick auf „Intercom“ führt sofort zurück. Auf dem PC bleibt die Sprechleiste auch auf
  der Einstellungsseite sichtbar, auf dem Handy wird sie dort ausgeblendet.

  Admin
  -----
  Die bisherige linke Admin-Navigation wandert in die Seitenleiste (gruppiert, mit Anzahl).
  Rechts steht der gewählte Bereich mit Überschrift und Beschreibung. „Aktualisieren“ sitzt
  in der Kopfleiste, „Sperren/Abmelden“ in der Benutzerkarte.

  Handy (≤ 980 px)
  ----------------
  - Gleiche Struktur wie auf dem PC: Kopfleiste mit ☰ öffnet die Seitenleiste von links
    (mit Schleier, Tippen daneben oder Esc schließt sie). Dashboard oben, Benutzerkarte
    unten – an denselben Stellen wie auf dem PC.
  - Nach der Wahl eines Eintrags schließt sich die Seitenleiste.
  - Die Sprechleiste liegt als Daumenleiste unten (≤ 720 px): Sprechtaste groß oben,
    Antworten und Dauerhaft an darunter.
  - Reiter oben: Kanäle (Party Lines + Durchsage) · Direkt · Chat (mit Raspberry Pis);
    Party Lines als Zeilen mit Hören/Rufen rechts.

  Ohne neue Seitenleiste (unverändert wie bisher)
  -----------------------------------------------
  - Raspberry-Pi-Kiosk: lowPower=1, autoLogin=1 (Pi-Starter), viewMode=…
  - eingebettet in JMS Control: embed=1 (auch controls=0)
  - „Raspberry fernsteuern“ (Fernsteuer-Sitzung)
  - Chat-Anzeige (viewMode=chat / ChatDisplayView)
  - Anmeldeseite
-->

# Kesher – Layout mit Seitenleiste

Der Plan steht im Kommentarblock oben in dieser Datei. Kurz:

- **Gerüst:** `AppShell` (Seitenleiste + Kopfleiste + Seite) – gleich auf PC und Handy.
- **Bediener:** Dashboard · Intercom · Einstellungen (gruppiertes Menü wie in JMS Control).
- **Admin:** Dashboard · Admin mit gruppierten Bereichen in der Seitenleiste.
- **Benutzerkarte** unten links: Name, Rolle, „Konto wechseln“, „Abmelden“.
- **Sonderfälle ohne Seitenleiste:** Kiosk (lowPower/autoLogin/viewMode), embed,
  Raspberry-Fernsteuerung, Chat-Anzeige, Anmeldeseite.
