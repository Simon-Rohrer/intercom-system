// Kachel „Dienstplan“ („Wer ist heute dran?“): die in ChurchTools eingeteilten Personen
// je Dienst (Ton, Licht, Kamera, Moderation, Predigt …) für das Event der Kachel, gruppiert
// nach Dienstgruppe. Unbesetzte Dienste sind rot, nicht zugesagte gelb. Die Eventauswahl
// (Heute / Nächstes Event / Festes Datum, Filter) ist dieselbe wie bei der Ablauf-Kachel.

import { pickEvent, pickNextEvent } from './agenda.js'

const views = new Set()

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function fmtTime(iso, timeZone) {
  if (!iso) return ''
  return new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone })
}

function fmtDate(iso, timeZone) {
  return new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone })
}

/** "2026-10-15" → "Do., 15.10." */
function fmtDay(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' })
}

const ids = (list) => (Array.isArray(list) ? list.map((v) => Number(v)).filter((n) => Number.isFinite(n)) : [])

/** Einstellungen der Kachel (tile.roster) mit Standardwerten */
export function rosterOptions(o = {}) {
  const num = (v, d, min, max) => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  const bool = (v, d) => (typeof v === 'boolean' ? v : d)
  return {
    size: num(o.size, 1, 0.5, 3),
    header: bool(o.header, true), // Kopfzeile mit Event und Datum
    groupTitles: bool(o.groupTitles, true), // Dienstgruppen als Überschriften
    openOnly: bool(o.openOnly, false), // nur unbesetzte und angefragte Dienste
    comments: bool(o.comments, false), // Kommentar der Einteilung zeigen
    groups: ids(o.groups), // nur diese Dienstgruppen (IDs), leer = alle
    services: ids(o.services), // zusätzlich einzelne Dienste (IDs)
  }
}

/** Zeilen nach Dienstgruppen/Diensten und „nur offene“ filtern. */
export function filterRoster(rows, options) {
  const o = rosterOptions(options)
  const groups = new Set(o.groups)
  const services = new Set(o.services)
  return (rows || []).filter((r) => {
    if ((groups.size || services.size) && !groups.has(Number(r.groupId)) && !services.has(Number(r.serviceId))) return false
    if (o.openOnly && r.assigned && r.accepted) return false
    return true
  })
}

/** Zeilen in Dienstgruppen zusammenfassen (Reihenfolge wie geliefert). */
export function groupRoster(rows) {
  const result = []
  for (const r of rows) {
    const key = r.groupId ?? r.group
    let g = result.find((x) => x.key === key)
    if (!g) {
      g = { key, group: r.group, rows: [] }
      result.push(g)
    }
    g.rows.push(r)
  }
  return result
}

/** Zähler für die Kopfzeile: { open, pending, total } */
export function rosterSummary(rows) {
  let open = 0
  let pending = 0
  for (const r of rows) {
    if (!r.assigned) open++
    else if (!r.accepted) pending++
  }
  return { open, pending, total: rows.length }
}

export function createRosterView(tile) {
  const o = rosterOptions(tile.roster)
  const select = {
    filter: tile.ctFilter || '',
    date: tile.ctDate || '',
    next: !tile.ctDate && tile.ctMode === 'next',
  }
  const root = el('div', 'roster')
  root.style.setProperty('--ro-scale', String(o.size))
  root.classList.toggle('no-header', !o.header)
  const header = el('header', 'roster-header')
  const titleBox = el('div', 'roster-title')
  const label = el('strong', null, 'Dienstplan')
  const eventName = el('span', 'roster-event')
  titleBox.append(label, eventName)
  const when = el('span', 'roster-when')
  const summary = el('span', 'roster-summary')
  const pill = el('span', 'roster-pill')
  header.append(titleBox, when, summary, pill)
  const body = el('div', 'roster-body')
  root.append(header, body)

  let data = null
  let shownId = null // gezeigtes Event, um beim Weiterrücken neu zu zeichnen

  function message(text) {
    body.replaceChildren(el('p', 'roster-empty', text))
  }

  function currentEvent(ct) {
    const events = ct?.days?.[select.date || ct?.date]
    if (!events) return null
    return select.next
      ? pickNextEvent(events, ct.upcoming, select.filter, Date.now(), ct.timeZone)
      : pickEvent(events, select.filter, Date.now(), ct.timeZone)
  }

  function render() {
    const ct = data
    const tz = ct?.timeZone
    eventName.textContent = ''
    when.textContent = ''
    summary.textContent = ''
    summary.className = 'roster-summary'
    label.textContent = 'Dienstplan'
    shownId = null
    if (!ct || ct.state === 'unconfigured') return message('ChurchTools ist nicht verbunden.\nEinstellungen → ChurchTools')
    const day = select.date || ct.date
    const events = ct.days?.[day]
    if (!events) {
      if (ct.state === 'error') return message(ct.error || 'ChurchTools nicht erreichbar')
      return message(ct.state === 'connected' ? `Lade ${fmtDay(day)} …` : 'Verbinde mit ChurchTools …')
    }
    const event = currentEvent(ct)
    shownId = event?.id ?? null
    const live = !select.date || select.date === ct.date
    if (select.next) {
      if (!event) return message(select.filter ? `Kein Event „${select.filter}“ in den nächsten Wochen` : 'Keine Events in den nächsten Wochen')
      if (!events.includes(event)) label.textContent = 'Nächstes Event'
    }
    const dayText = live ? 'Heute' : `Am ${fmtDay(day)}`
    if (!event) return message(select.filter ? `${dayText} kein Event „${select.filter}“` : `${dayText} keine Events`)
    eventName.textContent = event.name
    when.textContent = `${fmtDate(event.startDate, tz)} · ${fmtTime(event.startDate, tz)}`
    if (event.services === undefined) return message('Lade Dienste …')
    if (!event.services) return message(event.servicesError || 'Dienste nicht verfügbar')
    const rows = filterRoster(event.services, o)
    if (!rows.length) return message(event.services.length ? (o.openOnly ? 'Alle Dienste besetzt und zugesagt' : 'Keine Dienste in der Auswahl') : 'Keine Dienste eingeteilt')
    const sum = rosterSummary(rows)
    const parts = []
    if (sum.open) parts.push(`${sum.open} nicht besetzt`)
    if (sum.pending) parts.push(`${sum.pending} angefragt`)
    summary.textContent = parts.join(' · ') || 'alle besetzt'
    summary.classList.toggle('bad', sum.open > 0)
    summary.classList.toggle('warn', !sum.open && sum.pending > 0)
    summary.classList.toggle('ok', !sum.open && !sum.pending)

    const list = el('div', 'roster-list')
    for (const g of groupRoster(rows)) {
      if (o.groupTitles) list.append(el('h3', 'roster-group', g.group))
      for (const r of g.rows) {
        const row = el('div', `roster-row${!r.assigned ? ' open' : !r.accepted ? ' pending' : ''}`)
        row.append(el('span', 'roster-service', r.label || r.service))
        const who = el('span', 'roster-name')
        if (!r.assigned) who.textContent = 'nicht besetzt'
        else {
          who.textContent = r.name || 'Eingeteilt'
          if (!r.accepted) who.append(el('small', 'roster-state', 'angefragt'))
        }
        row.append(who)
        if (o.comments && r.comment) row.append(el('span', 'roster-comment', r.comment))
        list.append(row)
      }
    }
    body.replaceChildren(list)
  }

  const view = {
    el: root,
    update(ct) {
      data = ct
      const connected = ct?.state === 'connected'
      pill.textContent = connected ? 'ChurchTools' : ct?.state === 'unconfigured' ? 'Nicht verbunden' : 'Offline'
      pill.classList.toggle('bad', !connected)
      pill.title = ct?.error || ''
      render()
    },
    /** Laufendes Event vorbei oder nächstes begonnen: anderes Event zeigen */
    tick() {
      if (data && (currentEvent(data)?.id ?? null) !== shownId) render()
    },
  }
  views.add(view)
  return view
}

setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 30000)
