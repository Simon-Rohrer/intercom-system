'use strict'

// Laufender Punkt im ChurchTools-Ablauf, vom Operator von Hand gesetzt (Kachel, Remote
// oder API). Normalerweise ergibt sich der laufende Punkt aus der Uhrzeit; weicht der
// Gottesdienst vom Plan ab, setzt der Operator den Punkt – alle Kacheln zeigen dann
// diesen Punkt, die Restzeit ab dem Klick und die Abweichung vom Plan.
// Der Stand liegt pro Event im Speicher und in data/agenda-position.json (übersteht
// einen Neustart), ältere Einträge als ein Tag fallen weg.

const fs = require('fs')
const path = require('path')

const MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Index des Punkts, der nach der Uhr gerade läuft (oder als nächstes kommt), -1 wenn keiner. */
function clockIndex(items, now) {
  let running = -1
  let next = -1
  items.forEach((item, i) => {
    if (item.type === 'header') return
    const start = item.start ? Date.parse(item.start) : NaN
    if (!Number.isFinite(start)) return
    const end = start + (item.duration || 0) * 1000
    if (start <= now && now < end && running < 0) running = i
    if (start > now && next < 0) next = i
  })
  return running >= 0 ? running : next
}

/** Nächster bzw. voriger Punkt ohne Überschriften, -1 wenn es keinen gibt. */
function stepIndex(items, from, dir) {
  for (let i = from + dir; i >= 0 && i < items.length; i += dir) if (items[i].type !== 'header') return i
  return -1
}

function createAgendaPosition({ dataDir, getEvents = () => [], onUpdate = () => {}, log = () => {}, now = Date.now }) {
  const file = dataDir ? path.join(dataDir, 'agenda-position.json') : null
  let positions = {} // eventId → { itemIndex, itemId, at, by }

  try {
    if (file) positions = JSON.parse(fs.readFileSync(file, 'utf8')) || {}
    if (typeof positions !== 'object' || Array.isArray(positions)) positions = {}
  } catch {
    positions = {}
  }
  prune()

  function prune() {
    const cut = now() - MAX_AGE_MS
    let changed = false
    for (const [id, p] of Object.entries(positions)) {
      const at = Date.parse(p?.at)
      if (!Number.isFinite(at) || at < cut || !Number.isInteger(p?.itemIndex)) {
        delete positions[id]
        changed = true
      }
    }
    return changed
  }

  function save() {
    if (!file) return
    try {
      fs.mkdirSync(dataDir, { recursive: true })
      const tmp = `${file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(positions), { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      log(`Ablauf-Position nicht gespeichert: ${err.message}`)
    }
  }

  function snapshot() {
    prune()
    return { type: 'ctposition', positions }
  }

  function publish() {
    save()
    onUpdate(snapshot())
  }

  function findEvent(eventId) {
    const id = String(eventId ?? '')
    return getEvents().find((e) => String(e?.id) === id) || null
  }

  const fail = (message, status = 400) => Object.assign(new Error(message), { status })

  /**
   * Punkt setzen. body: { eventId, itemIndex } (null = wieder nach Uhr) oder
   * { eventId, action: 'next' | 'previous' | 'auto' }. Wirft mit err.status bei Fehlern.
   */
  function set({ eventId, itemIndex, action } = {}, by = '') {
    if (eventId == null || eventId === '') throw fail('eventId fehlt')
    const id = String(eventId)
    const event = findEvent(id)
    if (!event) throw fail('Event nicht geladen – nur Events der Kacheln lassen sich steuern', 404)
    const items = event.agenda?.items || []
    if (!items.length) throw fail('Das Event hat keinen Ablauf')
    let index
    if (action === 'auto' || (action == null && itemIndex === null)) {
      if (!positions[id]) return snapshot()
      delete positions[id]
      log(`Ablauf: Event ${id} wieder nach Uhrzeit${by ? ` (${by})` : ''}`)
      publish()
      return snapshot()
    }
    if (action === 'next' || action === 'previous') {
      const current = positions[id]?.itemIndex ?? clockIndex(items, now())
      index = current < 0 ? (action === 'next' ? stepIndex(items, -1, 1) : -1) : stepIndex(items, current, action === 'next' ? 1 : -1)
      if (index < 0) throw fail(action === 'next' ? 'Kein weiterer Punkt' : 'Kein vorheriger Punkt')
    } else if (action != null) throw fail('Unbekannte Aktion')
    else {
      index = Number(itemIndex)
      if (!Number.isInteger(index) || index < 0 || index >= items.length) throw fail('itemIndex ungültig')
      if (items[index].type === 'header') throw fail('Überschriften lassen sich nicht als laufender Punkt setzen')
    }
    positions[id] = { itemIndex: index, itemId: items[index].id ?? null, at: new Date(now()).toISOString(), by: String(by || '').slice(0, 80) }
    log(`Ablauf: Event ${id} → Punkt ${index + 1} „${items[index].title || ''}“${by ? ` (${by})` : ''}`)
    publish()
    return snapshot()
  }

  function get(eventId) {
    prune()
    return positions[String(eventId)] || null
  }

  return { set, get, snapshot }
}

module.exports = { createAgendaPosition, clockIndex, stepIndex }
