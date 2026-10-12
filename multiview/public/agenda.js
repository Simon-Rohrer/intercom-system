// ChurchTools-Ablauf als Kachel: Ablauf des heutigen Events, der laufende Punkt
// ist hervorgehoben. Die Daten kommen vom Multiview-Server (ein Server-Konto).

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

/**
 * Welches Event die Kachel zeigt: passend zum Filter (Name oder Kalender),
 * das laufende, sonst das nächste, sonst das letzte des Tages.
 */
export function pickEvent(events, filter, now = Date.now()) {
  const f = String(filter || '').trim().toLowerCase()
  const list = (events || []).filter(
    (e) => !f || e.name.toLowerCase().includes(f) || (e.calendar || '').toLowerCase().includes(f),
  )
  return (
    list.find((e) => Date.parse(e.startDate) <= now && now < Date.parse(e.endDate)) ||
    list.find((e) => Date.parse(e.startDate) > now) ||
    list[list.length - 1] ||
    null
  )
}

export function createAgendaView(tile) {
  const options = {
    filter: tile.ctFilter || '',
    date: tile.ctDate || '', // leer = aktuelles Datum
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

  function render() {
    const ct = data
    const tz = ct?.timeZone
    eventName.textContent = ''
    when.textContent = ''
    if (!ct || ct.state === 'unconfigured') return message('ChurchTools ist nicht verbunden.\nEinstellungen → ChurchTools')
    const day = options.date || ct.date
    const events = ct.days?.[day]
    live = !options.date || options.date === ct.date
    if (!events) {
      if (ct.state === 'error') return message(ct.error || 'ChurchTools nicht erreichbar')
      return message(ct.state === 'connected' ? `Lade ${fmtDay(day)} …` : 'Verbinde mit ChurchTools …')
    }
    const event = pickEvent(events, options.filter)
    const dayText = live ? 'Heute' : `Am ${fmtDay(day)}`
    if (!event) return message(options.filter ? `${dayText} kein Event „${options.filter}“` : `${dayText} keine Events`)
    eventName.textContent = event.name
    when.textContent = `${fmtDate(event.startDate, tz)} · ${fmtTime(event.startDate, tz)}`
    if (!event.agenda) return message(event.agendaError || 'Kein Ablauf')
    if (!event.agenda.items.length) return message('Der Ablauf ist leer')

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
