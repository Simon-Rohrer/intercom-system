// ChurchTools-Ablauf als Kachel, der laufende Punkt ist hervorgehoben. Drei Arten:
// „Heute“ (Events von heute), „Nächstes Event“ (das laufende, sonst das nächste,
// auch an späteren Tagen) und ein festes Datum. Vorhandene Abläufe werden bevorzugt,
// sonntags hat der Morgen Vorrang. Die Daten kommen vom Multiview-Server.

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

/** "2026-10-15" → "Do., 15.10." (Tag ohne Uhrzeit, darum UTC) */
function fmtDay(day) {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' })
}

function fmtDate(iso, timeZone) {
  return new Date(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone })
}

function fmtDuration(seconds) {
  if (!seconds) return ''
  const m = Math.round(seconds / 60)
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')} h` : `${m}′`
}

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

/**
 * Heute/festes Datum: Sonntags bleibt der Morgen bevorzugt, auch nach Eventende.
 * Innerhalb dieser Auswahl haben vorhandene Abläufe Vorrang vor leeren Events.
 * Ohne Ablauf bleibt das Event samt verständlicher Fehlermeldung sichtbar.
 */
export function pickEvent(events, filter, now = Date.now(), timeZone = 'Europe/Berlin') {
  const list = matchingEvents(events, filter)
  const morning = sundayMornings(list, timeZone)
  const candidates = morning.length ? morning : list
  const withAgenda = candidates.filter(hasAgenda)
  const preferred = withAgenda.length ? withAgenda : candidates
  return currentOrNext(preferred, now) || preferred[preferred.length - 1] || null
}

/**
 * Nächstes Event: verfügbare Abläufe des laufenden/nächsten Events bevorzugen.
 * Nur am Sonntag bleibt ein heutiges Morgenevent vor anderen Events stehen;
 * unter der Woche verdrängt der nächste Sonntag kein heutiges Event mit Ablauf.
 */
export function pickNextEvent(todays, upcoming, filter, now = Date.now(), timeZone = 'Europe/Berlin') {
  const today = matchingEvents(todays, filter)
  const morning = sundayMornings(today, timeZone, eventLocalTime(now, timeZone).day)
  if (morning.length) return pickEvent(morning, filter, now, timeZone)
  const candidates = matchingEvents([...today, ...(upcoming || [])], filter)
    .filter((e) => Date.parse(e.startDate) > now || now < Date.parse(e.endDate))
  const withAgenda = candidates.filter(hasAgenda)
  return currentOrNext(withAgenda.length ? withAgenda : candidates, now)
}

export function createAgendaView(tile) {
  const options = {
    filter: tile.ctFilter || '',
    date: tile.ctDate || '', // leer = heute bzw. nächstes Event
    next: !tile.ctDate && tile.ctMode === 'next',
    responsible: tile.ctResponsible !== false,
    notes: tile.ctNotes === true,
  }
  const root = el('div', 'agenda')
  const header = el('header', 'agenda-header')
  const titleBox = el('div', 'agenda-title')
  const label = el('strong', null, 'Ablauf')
  const eventName = el('span', 'agenda-event')
  titleBox.append(label, eventName)
  const when = el('span', 'agenda-when')
  const pill = el('span', 'agenda-pill')
  header.append(titleBox, when, pill)
  const body = el('div', 'agenda-body')
  root.append(header, body)

  let data = null
  let rows = [] // { li, item, bar }
  let live = false // nur beim heutigen Tag: laufenden Punkt markieren
  let shownId = null // gezeigtes Event, um beim Weiterrücken neu zu zeichnen

  function message(text) {
    rows = []
    body.replaceChildren(el('p', 'agenda-empty', text))
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
    tick,
  }

  /** Welches Event die Kachel gerade zeigen soll (null = keins). */
  function currentEvent() {
    const ct = data
    const events = ct?.days?.[options.date || ct?.date]
    if (!events) return null
    return options.next
      ? pickNextEvent(events, ct.upcoming, options.filter, Date.now(), ct.timeZone)
      : pickEvent(events, options.filter, Date.now(), ct.timeZone)
  }

  function render() {
    const ct = data
    const tz = ct?.timeZone
    shownId = null
    eventName.textContent = ''
    when.textContent = ''
    label.textContent = 'Ablauf'
    if (!ct || ct.state === 'unconfigured') return message('ChurchTools ist nicht verbunden.\nEinstellungen → ChurchTools')
    const day = options.date || ct.date
    const events = ct.days?.[day]
    live = !options.date || options.date === ct.date
    if (!events) {
      if (ct.state === 'error') return message(ct.error || 'ChurchTools nicht erreichbar')
      return message(ct.state === 'connected' ? `Lade ${fmtDay(day)} …` : 'Verbinde mit ChurchTools …')
    }
    const event = currentEvent()
    shownId = event?.id ?? null
    if (options.next) {
      if (!event) {
        const what = options.filter ? `Kein Event „${options.filter}“` : 'Keine Events'
        return message(`${what} in den nächsten Wochen`)
      }
      if (!events.includes(event)) {
        live = false
        label.textContent = 'Nächstes Event'
      }
    }
    const dayText = live ? 'Heute' : `Am ${fmtDay(day)}`
    if (!event) return message(options.filter ? `${dayText} kein Event „${options.filter}“` : `${dayText} keine Events`)
    eventName.textContent = event.name
    when.textContent = `${fmtDate(event.startDate, tz)} · ${fmtTime(event.startDate, tz)}`
    if (!event.agenda) return message(event.agendaError || 'Kein Ablauf hinterlegt')
    // ChurchTools can return a single blank placeholder instead of an empty list.
    const hasContent = event.agenda.items.some((item) =>
      String(item.title || '').trim() || item.duration > 0 || String(item.responsible || '').trim() ||
      String(item.note || '').trim() || String(item.song?.title || '').trim())
    if (!hasContent) return message('Der Ablauf ist leer')

    const list = el('ol', 'agenda-list')
    rows = []
    for (const item of event.agenda.items) {
      const li = el('li', `agenda-item type-${item.type}`)
      if (item.beforeEvent) li.classList.add('before-event')
      if (item.type === 'header') {
        li.append(el('span', 'agenda-time', fmtTime(item.start, tz)), el('span', 'agenda-head', item.title))
        list.append(li)
        rows.push({ li, item, bar: null })
        continue
      }
      const main = el('div', 'agenda-main')
      const title = el('div', 'agenda-item-title')
      title.append(el('span', null, item.title))
      if (item.song) {
        const facts = [item.song.key && `Tonart ${item.song.key}`, item.song.arrangement].filter(Boolean)
        if (facts.length) title.append(el('span', 'agenda-song', facts.join(' · ')))
      }
      main.append(title)
      if (options.responsible && item.responsible) main.append(el('div', 'agenda-resp', item.responsible))
      if (options.notes && item.note) main.append(el('div', 'agenda-note', item.note))
      const bar = el('span', 'agenda-progress')
      li.append(el('span', 'agenda-time', fmtTime(item.start, tz)), main, el('span', 'agenda-dur', fmtDuration(item.duration)), bar)
      list.append(li)
      rows.push({ li, item, bar })
    }
    body.replaceChildren(list)
    tick(true)
  }

  /** Laufenden Punkt markieren, erledigte abdunkeln, mitscrollen. */
  function tick(force = false) {
    // Laufendes Event vorbei oder nächstes begonnen: anderes Event zeigen
    if (data && (currentEvent()?.id ?? null) !== shownId) return render()
    if (!rows.length || !live) return
    const now = Date.now()
    let current = null
    for (const row of rows) {
      const start = row.item.start ? Date.parse(row.item.start) : NaN
      const end = start + row.item.duration * 1000
      const isHeader = row.item.type === 'header'
      const running = !isHeader && start <= now && now < end
      const done = !isHeader ? now >= end : false
      row.li.classList.toggle('current', running)
      row.li.classList.toggle('done', done)
      if (running) {
        current = row
        row.bar.style.width = `${Math.min(100, ((now - start) / (end - start)) * 100)}%`
      } else if (row.bar) row.bar.style.width = '0'
    }
    // Ablauf vorbei: Kopfzeilen der erledigten Abschnitte ebenfalls abdunkeln
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].item.type !== 'header') continue
      let end = rows.findIndex((r, j) => j > i && r.item.type === 'header')
      if (end < 0) end = rows.length
      const section = rows.slice(i + 1, end)
      rows[i].li.classList.toggle('done', section.length > 0 && section.every((r) => r.li.classList.contains('done')))
    }
    const list = rows[0].li.parentElement
    const target = current || rows.find((r) => !r.li.classList.contains('done') && r.item.type !== 'header')
    if (!list || !target) return
    // Den vorherigen Punkt noch sichtbar lassen
    const index = rows.indexOf(target)
    const anchor = rows[Math.max(0, index - 1)].li
    const top = anchor.offsetTop - list.offsetTop
    if (force || Math.abs(list.scrollTop - top) > 2) list.scrollTo({ top, behavior: force ? 'auto' : 'smooth' })
  }

  views.add(view)
  return view
}

setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 5000)
