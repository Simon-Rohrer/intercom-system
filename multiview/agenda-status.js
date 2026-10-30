'use strict'

// Lage im ChurchTools-Ablauf auf dem Server – für GET /api/state (Companion-Modul „JMS Control“):
// welches Event die Ablauf-Kachel gerade zeigt, laufender Punkt, Restzeit, Abweichung vom Plan
// mit Stufe ok/warn/bad und der nächste Punkt. Die Rechnung entspricht pickEvent, pickNextEvent,
// resolvePosition und agendaStatus aus public/agenda.js (Browser-Modul); test/agenda-status.test.js
// prüft, dass beide dasselbe Ergebnis liefern.

// So lange gilt ein von Hand gesetzter Punkt (danach wieder nach Uhrzeit), wie in agenda.js
const POSITION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const MAX_EVENTS = 20

/** Passt das Event zum ausdrücklich gesetzten Filter der Kachel? */
function matchesFilter(event, filter) {
  const f = String(filter || '').trim().toLowerCase()
  return !f || String(event.name || '').toLowerCase().includes(f) || String(event.calendar || '').toLowerCase().includes(f)
}

function matchingEvents(events, filter) {
  return (events || [])
    .filter((e) => !e.isCanceled && matchesFilter(e, filter) && Number.isFinite(Date.parse(e.startDate)))
    .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
}

function hasAgenda(event) {
  return event.agenda?.items?.some((item) => item.type !== 'header') === true
}

const eventDateFormatters = new Map()
function eventLocalTime(iso, timeZone) {
  if (!eventDateFormatters.has(timeZone)) {
    eventDateFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', hourCycle: 'h23',
    }))
  }
  const parts = Object.fromEntries(eventDateFormatters.get(timeZone).formatToParts(new Date(iso)).map((p) => [p.type, p.value]))
  return { day: `${parts.year}-${parts.month}-${parts.day}`, sundayMorning: parts.weekday === 'Sun' && Number(parts.hour) < 12 }
}

function sundayMornings(events, timeZone, day) {
  return events.filter((event) => {
    const local = eventLocalTime(event.startDate, timeZone)
    return local.sundayMorning && (!day || local.day === day)
  })
}

function currentOrNext(events, now) {
  return events.find((e) => Date.parse(e.startDate) <= now && now < Date.parse(e.endDate)) ||
    events.find((e) => Date.parse(e.startDate) > now) || null
}

/** Event für „Heute“/festes Datum – wie pickEvent in agenda.js. */
function pickEvent(events, filter, now = Date.now(), timeZone = 'Europe/Berlin') {
  const list = matchingEvents(events, filter)
  const morning = sundayMornings(list, timeZone)
  const candidates = morning.length ? morning : list
  const withAgenda = candidates.filter(hasAgenda)
  const preferred = withAgenda.length ? withAgenda : candidates
  return currentOrNext(preferred, now) || preferred[preferred.length - 1] || null
}

/** Event für „Nächstes Event“ – wie pickNextEvent in agenda.js. */
function pickNextEvent(todays, upcoming, filter, now = Date.now(), timeZone = 'Europe/Berlin') {
  const today = matchingEvents(todays, filter)
  const morning = sundayMornings(today, timeZone, eventLocalTime(now, timeZone).day)
  if (morning.length) return pickEvent(morning, filter, now, timeZone)
  const candidates = matchingEvents([...today, ...(upcoming || [])], filter)
    .filter((e) => Date.parse(e.startDate) > now || now < Date.parse(e.endDate))
  const withAgenda = candidates.filter(hasAgenda)
  return currentOrNext(withAgenda.length ? withAgenda : candidates, now)
}

/** Von Hand gesetzter Punkt → { index, at } oder null – wie resolvePosition in agenda.js. */
function resolvePosition(items, position, now = Date.now()) {
  if (!position || !Number.isInteger(position.itemIndex)) return null
  const at = Date.parse(position.at)
  if (!Number.isFinite(at) || now - at > POSITION_MAX_AGE_MS) return null
  const list = items || []
  const fits = (i) => list[i] && list[i].type !== 'header' && (position.itemId == null || list[i].id === position.itemId)
  let index = fits(position.itemIndex) ? position.itemIndex : -1
  if (index < 0 && position.itemId != null) index = list.findIndex((item) => item.type !== 'header' && item.id === position.itemId)
  return index >= 0 ? { index, at } : null
}

/** Laufender Punkt, Restzeit, Abweichung (+ = hinter Plan) mit Stufe, nächster Punkt – wie agendaStatus in agenda.js. */
function agendaStatus(items, { position = null, now = Date.now(), warnMin = 2, badMin = 5 } = {}) {
  const list = items || []
  const isPoint = (item) => item && item.type !== 'header'
  const manual = resolvePosition(list, position, now)
  let index = manual ? manual.index : -1
  if (!manual) {
    index = list.findIndex((item) => {
      if (!isPoint(item)) return false
      const start = Date.parse(item.start)
      return start <= now && now < start + (item.duration || 0) * 1000
    })
  }
  const current = index >= 0 ? list[index] : null
  let remainingSec = null
  let deviationMin = null
  let level = null
  if (current) {
    const planned = Date.parse(current.start)
    const start = manual ? manual.at : planned
    remainingSec = Math.round((start + (current.duration || 0) * 1000 - now) / 1000)
    deviationMin = manual && Number.isFinite(planned) ? Math.round((manual.at - planned) / 60000) : 0
    const abs = Math.abs(deviationMin)
    level = abs <= warnMin ? 'ok' : abs <= badMin ? 'warn' : 'bad'
  }
  const nextIndex =
    index >= 0
      ? list.findIndex((item, j) => j > index && isPoint(item))
      : list.findIndex((item) => isPoint(item) && Date.parse(item.start) > now)
  return {
    index,
    current,
    manual: Boolean(manual),
    startedAt: manual ? manual.at : null,
    remainingSec,
    deviationMin,
    level,
    nextIndex,
    next: nextIndex >= 0 ? list[nextIndex] : null,
  }
}

function num(v, d, min, max) {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

/** Schwellen der Ablauf-Kachel (tile.agendaLook) – Standard wie agendaOptions in agenda.js. */
function thresholds(look) {
  return { warnMin: num(look?.warnMin, 2, 0, 60), badMin: num(look?.badMin, 5, 0, 180) }
}

/**
 * Welche Ablauf-Kachel bestimmt das „aktuelle Event“? Nur Kacheln mit dem heutigen Tag (ohne festes
 * Datum oder mit dem heutigen Datum). Vorrang: Kachel mit Bedienung, dann eine gerade auf einem
 * Multiview sichtbare, dann die Reihenfolge der Layouts. Ohne Kachel: Events von heute ohne Filter.
 */
function agendaTile(config, today) {
  const shown = new Set((config?.outputs || []).map((o) => o.layoutId).filter(Boolean))
  const tiles = (config?.layouts || []).flatMap((layout) =>
    (layout.tiles || [])
      .filter((tile) => tile.kind === 'churchtools' && (!tile.ctDate || tile.ctDate === today))
      .map((tile) => ({ tile, rank: (tile.agendaLook?.control === true ? 0 : 2) + (shown.has(layout.id) ? 0 : 1) })),
  )
  tiles.sort((a, b) => a.rank - b.rank)
  return tiles[0]?.tile || null
}

/** Event, das die Ablauf-Kachel gerade zeigt (oder null). ct = churchTools.snapshot(). */
function currentAgendaEvent(ct, config, now = Date.now()) {
  if (!ct?.date) return { event: null, tile: null }
  const tile = agendaTile(config, ct.date)
  const events = ct.days?.[ct.date] || []
  const filter = tile?.ctFilter || ''
  const next = Boolean(tile && !tile.ctDate && tile.ctMode === 'next')
  const event = next ? pickNextEvent(events, ct.upcoming, filter, now, ct.timeZone) : pickEvent(events, filter, now, ct.timeZone)
  return { event, tile }
}

/** Auswahlliste für Companion: Events von heute und die nächsten Events mit Ablauf. */
function agendaEvents(ct) {
  const seen = new Set()
  const list = []
  for (const e of [...(ct?.days?.[ct?.date] || []), ...(ct?.upcoming || [])]) {
    if (!e || e.id == null || e.isCanceled || seen.has(String(e.id))) continue
    seen.add(String(e.id))
    list.push({ id: String(e.id), name: String(e.name || '').slice(0, 120), start: e.startDate || null })
  }
  return list.slice(0, MAX_EVENTS)
}

/**
 * Feld „agenda“ in GET /api/state. positions = agendaPosition.snapshot().positions.
 * Zeiten in Sekunden/Minuten, Stufe nach den Schwellen der Kachel.
 */
function agendaSummary({ ct, positions = {}, config, now = Date.now() }) {
  const { event, tile } = currentAgendaEvent(ct, config, now)
  const { warnMin, badMin } = thresholds(tile?.agendaLook)
  const items = event?.agenda?.items
  const base = {
    state: ct?.state || 'unconfigured',
    eventId: event ? String(event.id) : null,
    event: event ? String(event.name || '') : '',
    eventStart: event?.startDate || null,
    hasAgenda: Boolean(event && hasAgenda(event)),
    current: null,
    remainingSec: null,
    deviationMin: null,
    level: null,
    manual: false,
    next: null,
    warnMin,
    badMin,
    events: agendaEvents(ct),
  }
  if (!Array.isArray(items) || !items.length) return base
  const st = agendaStatus(items, { position: positions[String(event.id)], now, warnMin, badMin })
  return {
    ...base,
    current: st.current ? { index: st.index, title: String(st.current.title || '') } : null,
    remainingSec: st.remainingSec,
    deviationMin: st.deviationMin,
    level: st.level,
    manual: st.manual,
    next: st.next
      ? { index: st.nextIndex, title: String(st.next.title || ''), responsible: String(st.next.responsible || ''), start: st.next.start || null }
      : null,
  }
}

module.exports = { pickEvent, pickNextEvent, resolvePosition, agendaStatus, thresholds, agendaTile, currentAgendaEvent, agendaEvents, agendaSummary }
