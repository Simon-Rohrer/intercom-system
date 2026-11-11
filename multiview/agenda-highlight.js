'use strict'

// Hervorgehobener Punkt im ChurchTools-Ablauf („schaut mal hier“): Ein Klick auf einen Punkt
// (z. B. ein Lied) am Laptop in der Multiview-Übersicht oder auf einem bedienbaren Monitor hebt
// ihn auf allen Ablauf-Kacheln desselben Events hervor – unabhängig vom laufenden Punkt
// (agenda-position.js), der dabei unverändert bleibt. Ein zweiter Klick auf denselben Punkt oder
// „Hervorhebung aufheben“ nimmt sie weg, nach HIGHLIGHT_MAX_AGE_MS verfällt sie von selbst.
// Der Stand liegt pro Event im Speicher und in data/agenda-highlight.json (übersteht einen Neustart).

const fs = require('fs')
const path = require('path')

// So lange bleibt eine Hervorhebung stehen (wie HIGHLIGHT_MAX_AGE_MS in public/agenda.js)
const HIGHLIGHT_MAX_AGE_MS = 10 * 60 * 1000

function createAgendaHighlight({ dataDir, getEvents = () => [], onUpdate = () => {}, log = () => {}, now = Date.now, maxAgeMs = HIGHLIGHT_MAX_AGE_MS }) {
  const file = dataDir ? path.join(dataDir, 'agenda-highlight.json') : null
  let highlights = {} // eventId → { itemIndex, itemId, at, by }
  let expiryTimer = null
  let published = '' // zuletzt gemeldeter Stand – Verfallenes wird genau einmal gemeldet

  try {
    if (file) highlights = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
    if (typeof highlights !== 'object' || Array.isArray(highlights)) highlights = {}
  } catch {
    highlights = {}
  }
  prune()
  published = JSON.stringify(highlights)
  scheduleExpiry()

  function prune() {
    const cut = now() - maxAgeMs
    let changed = false
    for (const [id, h] of Object.entries(highlights)) {
      const at = Date.parse(h?.at)
      if (!Number.isFinite(at) || at <= cut || !Number.isInteger(h?.itemIndex)) {
        delete highlights[id]
        changed = true
      }
    }
    return changed
  }

  /** Beim Verfallen der ältesten Hervorhebung allen Kacheln Bescheid geben */
  function scheduleExpiry() {
    clearTimeout(expiryTimer)
    expiryTimer = null
    const times = Object.values(highlights).map((h) => Date.parse(h.at) + maxAgeMs)
    if (!times.length) return
    const wait = Math.max(0, Math.min(...times) - now()) + 50
    expiryTimer = setTimeout(() => {
      expiryTimer = null
      prune()
      // Auch melden, wenn zwischendurch snapshot()/get() den Eintrag schon entfernt hat
      if (JSON.stringify(highlights) !== published) publish()
      else scheduleExpiry()
    }, wait)
    expiryTimer.unref?.()
  }

  function save() {
    if (!file) return
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(highlights), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      log(`Ablauf-Hervorhebung nicht gespeichert: ${err.message}`)
    }
  }

  function snapshot() {
    prune()
    return { type: 'cthighlight', highlights }
  }

  function publish() {
    const snap = snapshot()
    published = JSON.stringify(highlights)
    save()
    scheduleExpiry()
    onUpdate(snap)
  }

  function findEvent(eventId) {
    const id = String(eventId ?? '')
    return getEvents().find((e) => String(e?.id) === id) || null
  }

  const fail = (message, status = 400) => Object.assign(new Error(message), { status })

  /**
   * Hervorheben. body: { eventId, itemIndex } setzt, mit toggle: true nimmt ein zweiter Klick auf
   * denselben Punkt die Hervorhebung wieder weg; { eventId, itemIndex: null } oder
   * { eventId, action: 'clear' } hebt sie auf. Wirft mit err.status bei Fehlern.
   */
  function set({ eventId, itemIndex, toggle = false, action } = {}, by = '') {
    if (eventId == null || eventId === '') throw fail('eventId fehlt')
    const id = String(eventId)
    prune()
    if (action === 'clear' || (action == null && itemIndex === null)) {
      if (!highlights[id]) return snapshot()
      delete highlights[id]
      log(`Ablauf: Hervorhebung in Event ${id} aufgehoben${by ? ` (${by})` : ''}`)
      publish()
      return snapshot()
    }
    if (action != null) throw fail('Unbekannte Aktion')
    const event = findEvent(id)
    if (!event) throw fail('Event nicht geladen – nur Events der Kacheln lassen sich steuern', 404)
    const items = event.agenda?.items || []
    if (!items.length) throw fail('Das Event hat keinen Ablauf')
    const index = Number(itemIndex)
    if (!Number.isInteger(index) || index < 0 || index >= items.length) throw fail('itemIndex ungültig')
    if (items[index].type === 'header') throw fail('Überschriften lassen sich nicht hervorheben')
    const itemId = items[index].id ?? null
    const same = highlights[id] && highlights[id].itemIndex === index && (highlights[id].itemId ?? null) === itemId
    if (toggle === true || toggle === 'true') {
      if (same) {
        delete highlights[id]
        log(`Ablauf: Hervorhebung in Event ${id} aufgehoben${by ? ` (${by})` : ''}`)
        publish()
        return snapshot()
      }
    }
    highlights[id] = { itemIndex: index, itemId, at: new Date(now()).toISOString(), by: String(by || '').slice(0, 80) }
    log(`Ablauf: Event ${id} – Punkt ${index + 1} „${items[index].title || ''}“ hervorgehoben${by ? ` (${by})` : ''}`)
    publish()
    return snapshot()
  }

  function get(eventId) {
    prune()
    return highlights[String(eventId)] || null
  }

  function close() {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }

  return { set, get, snapshot, close }
}

module.exports = { createAgendaHighlight, HIGHLIGHT_MAX_AGE_MS }
