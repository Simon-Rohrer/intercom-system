'use strict'

// Fern-Scrollen der Ablauf-Kacheln: An Pi-/Kiosk-Monitoren gibt es keine Maus, darum schickt der
// Server (Companion-Taste, Remote, API) einen Befehl an alle Monitore. Die Kacheln scrollen um eine
// halbe Kachelhöhe hoch/runter und halten das Mitscrollen an wie beim Mausrad; „live“ springt
// sofort zurück zum laufenden Punkt. Kein gespeicherter Zustand – nur ein Ereignis (Nachricht
// „ctscroll“), darum auch kein Snapshot beim Verbinden.

const SCROLL_ACTIONS = ['up', 'down', 'live']
// eventId: leer/„all“ = alle Ablauf-Kacheln, „current“ = Event der Ablauf-Kachel (wie bei der Position)
const ALL_EVENTS = 'all'

const fail = (message, status = 400) => Object.assign(new Error(message), { status })

/**
 * Befehl aus dem Request-Body bauen: { action, eventId? } → { type: 'ctscroll', action, eventId, at }.
 * resolveCurrent() liefert die ID des aktuellen Events (oder null). Wirft mit err.status.
 */
function scrollMessage({ action, eventId } = {}, resolveCurrent = () => null, now = Date.now) {
  if (!SCROLL_ACTIONS.includes(action)) throw fail('Unbekannte Aktion – erlaubt sind up, down und live')
  let id = eventId == null || eventId === '' || eventId === ALL_EVENTS ? null : String(eventId)
  if (id === 'current') {
    id = resolveCurrent()
    if (id == null) throw fail('Kein aktuelles Event mit Ablauf', 404)
    id = String(id)
  }
  return { type: 'ctscroll', action, eventId: id, at: new Date(now()).toISOString() }
}

module.exports = { scrollMessage, SCROLL_ACTIONS, ALL_EVENTS }
