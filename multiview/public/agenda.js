// ChurchTools-Ablauf als Kachel, der laufende Punkt ist hervorgehoben. Drei Arten:
// „Heute“ (Events von heute), „Nächstes Event“ (das laufende, sonst das nächste,
// auch an späteren Tagen) und ein festes Datum. Vorhandene Abläufe werden bevorzugt,
// sonntags hat der Morgen Vorrang. Die Daten kommen vom Multiview-Server.

const views = new Set()
// Aufgeklappte Punkte (ChurchTools-IDs), bleiben beim Neuzeichnen offen
const openItems = new Set()
// Nach Klick oder eigenem Scrollen so lange nicht automatisch mitscrollen
const MANUAL_MS = 30 * 1000

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

const DENSITIES = ['compact', 'normal', 'airy']
const STATUS_MODES = ['off', 'top', 'bottom']
// So lange gilt ein von Hand gesetzter Punkt (danach wieder nach Uhrzeit)
const POSITION_MAX_AGE_MS = 24 * 60 * 60 * 1000
const ACCENTS = ['#00d1ff', '#30d158', '#ffb020', '#ff5a4f', '#bf5af2', '#ffffff']
const CCLI_COLORS = ['#a9b2be', '#ffffff', '#00d1ff', '#ffd60a', '#ffb020', '#30d158', '#ff5a4f', '#bf5af2']

/** Darstellung der Ablauf-Kachel (tile.agendaLook) mit Standardwerten */
export function agendaOptions(look) {
  const o = look || {}
  const bool = (v, d) => (typeof v === 'boolean' ? v : d)
  const size = Number(o.size)
  return {
    size: Number.isFinite(size) ? Math.min(3, Math.max(0.5, size)) : 1,
    density: DENSITIES.includes(o.density) ? o.density : 'normal',
    accent: ACCENTS.includes(o.accent) ? o.accent : ACCENTS[0],
    header: bool(o.header, true), // Kopfzeile mit Event und Datum
    time: bool(o.time, true), // Uhrzeit-Spalte
    duration: bool(o.duration, true), // Dauer-Spalte
    progress: bool(o.progress, true), // Fortschrittsbalken am laufenden Punkt
    sections: bool(o.sections, true), // Abschnitts-Überschriften
    before: bool(o.before, true), // Punkte vor Eventbeginn
    hideDone: bool(o.hideDone, false), // erledigte Punkte ausblenden
    openAll: bool(o.openAll, false), // Programmspalten immer aufgeklappt
    columns: String(o.columns || ''), // nur diese Programmspalten (Komma), leer = alle
    ccliSize: Number.isFinite(Number(o.ccliSize)) && o.ccliSize != null ? Math.min(2.5, Math.max(0.5, Number(o.ccliSize))) : 1,
    ccliColor: CCLI_COLORS.includes(o.ccliColor) ? o.ccliColor : CCLI_COLORS[0],
    // Statuszeile: Restzeit, Abweichung vom Plan, nächster Punkt (oben, unten oder aus)
    status: STATUS_MODES.includes(o.status) ? o.status : 'off',
    warnMin: num(o.warnMin, 2, 0, 60), // bis hier grün …
    badMin: num(o.badMin, 5, 0, 180), // … bis hier gelb, darüber rot
    control: bool(o.control, false), // laufenden Punkt per Klick setzen (Bedienung)
  }
}

function num(v, d, min, max) {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

/**
 * Von Hand gesetzter Punkt (Server-Nachricht „ctposition“) auf den Ablauf abbilden:
 * { index, at } oder null, wenn er nicht (mehr) passt. Hat sich der Ablauf in
 * ChurchTools verschoben, findet die ID den Punkt wieder.
 */
export function resolvePosition(items, position, now = Date.now()) {
  if (!position || !Number.isInteger(position.itemIndex)) return null
  const at = Date.parse(position.at)
  if (!Number.isFinite(at) || now - at > POSITION_MAX_AGE_MS) return null
  const list = items || []
  const fits = (i) => list[i] && list[i].type !== 'header' && (position.itemId == null || list[i].id === position.itemId)
  let index = fits(position.itemIndex) ? position.itemIndex : -1
  if (index < 0 && position.itemId != null) index = list.findIndex((item) => item.type !== 'header' && item.id === position.itemId)
  return index >= 0 ? { index, at } : null
}

/**
 * Lage im Ablauf für die Statuszeile: laufender Punkt (nach Uhr oder von Hand gesetzt),
 * Restzeit in Sekunden, Abweichung vom Plan in Minuten (+ = hinter Plan) mit Stufe
 * (ok/warn/bad nach den Schwellen) und der nächste Punkt.
 */
export function agendaStatus(items, { position = null, now = Date.now(), warnMin = 2, badMin = 5 } = {}) {
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

/** 222 s → "3:42", −80 s → "−1:20" */
export function fmtRemaining(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return '–'
  const sign = seconds < 0 ? '−' : ''
  const s = Math.abs(Math.round(seconds))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h ? `${sign}${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${sign}${m}:${String(sec).padStart(2, '0')}`
}

/** +4 → "+4 min", −2 → "−2 min", 0 → "±0 min" */
export function fmtDeviation(minutes) {
  if (minutes == null || !Number.isFinite(minutes)) return '–'
  return `${minutes > 0 ? '+' : minutes < 0 ? '−' : '±'}${Math.abs(minutes)} min`
}

/** Laufenden Punkt am Server setzen (itemIndex null = wieder nach Uhrzeit). Wirft mit Meldung. */
export async function postPosition(eventId, itemIndex) {
  const res = await fetch('/api/churchtools/agenda/position', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventId, itemIndex }),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok || data?.ok === false) throw new Error(data?.error || `HTTP ${res.status}`)
  return data
}

export const AGENDA_ACCENTS = ACCENTS
export const AGENDA_CCLI_COLORS = CCLI_COLORS
export const AGENDA_STATUS_MODES = STATUS_MODES

/** Text in die Zwischenablage – auch ohne HTTPS bzw. ohne Clipboard-API (ältere Geräte) */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // weiter mit dem alten Weg
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;'
  document.body.append(area)
  area.select()
  area.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

function copyButton(text) {
  const btn = el('button', 'agenda-copy', 'Kopieren')
  btn.type = 'button'
  btn.title = `CCLI ${text} kopieren`
  btn.addEventListener('click', async (e) => {
    e.stopPropagation() // nicht den Punkt auf-/zuklappen
    const ok = await copyText(text)
    btn.textContent = ok ? '✓ Kopiert' : 'Fehler'
    btn.classList.toggle('done', ok)
    clearTimeout(btn.resetTimer)
    btn.resetTimer = setTimeout(() => {
      btn.textContent = 'Kopieren'
      btn.classList.remove('done')
    }, 1600)
  })
  btn.addEventListener('keydown', (e) => e.stopPropagation())
  return btn
}

export function createAgendaView(tile) {
  const look = agendaOptions(tile.agendaLook)
  const onlyColumns = look.columns.split(',').map((c) => c.trim().toLowerCase()).filter(Boolean)
  const options = {
    filter: tile.ctFilter || '',
    date: tile.ctDate || '', // leer = heute bzw. nächstes Event
    next: !tile.ctDate && tile.ctMode === 'next',
    responsible: tile.ctResponsible !== false,
    notes: tile.ctNotes === true,
    songInfo: tile.ctSongInfo !== false,
    ccli: tile.ctCcli !== false,
  }
  const root = el('div', `agenda density-${look.density}`)
  root.style.setProperty('--ag-scale', String(look.size))
  root.style.setProperty('--k-accent', look.accent)
  root.style.setProperty('--ag-ccli-scale', String(look.ccliSize))
  root.style.setProperty('--ag-ccli-color', look.ccliColor)
  root.classList.toggle('no-header', !look.header)
  root.classList.toggle('no-time', !look.time)
  root.classList.toggle('no-dur', !look.duration)
  root.classList.toggle('no-progress', !look.progress)
  root.classList.toggle('hide-done', look.hideDone)
  const header = el('header', 'agenda-header')
  const titleBox = el('div', 'agenda-title')
  const label = el('strong', null, 'Ablauf')
  const eventName = el('span', 'agenda-event')
  titleBox.append(label, eventName)
  const when = el('span', 'agenda-when')
  const pill = el('span', 'agenda-pill')
  header.append(titleBox, when, pill)
  const body = el('div', 'agenda-body')
  // Statuszeile: Restzeit · Abweichung · nächster Punkt (optional oben oder unten)
  const status = el('div', 'agenda-status')
  const stRest = statusCell(status, 'Rest')
  const stDev = statusCell(status, 'Plan')
  const stNext = statusCell(status, 'Dann')
  const autoBtn = el('button', 'agenda-auto', 'Nach Uhr')
  autoBtn.type = 'button'
  autoBtn.title = 'Laufenden Punkt wieder nach der Uhrzeit bestimmen'
  autoBtn.hidden = true
  status.append(autoBtn)
  root.classList.toggle('status-top', look.status === 'top')
  root.classList.toggle('status-bottom', look.status === 'bottom')
  root.classList.toggle('has-control', look.control)
  if (look.status === 'top') root.append(header, status, body)
  else if (look.status === 'bottom') root.append(header, body, status)
  else root.append(header, body)
  const toast = el('div', 'agenda-toast')
  toast.hidden = true
  root.append(toast)

  let data = null
  let positions = {} // Event-ID → von Hand gesetzter Punkt (Server-Nachricht „ctposition“)
  let rows = [] // { li, item, bar, index }
  let live = false // nur beim heutigen Tag: laufenden Punkt markieren
  let shownId = null // gezeigtes Event, um beim Weiterrücken neu zu zeichnen
  let manualUntil = 0 // bis dahin kein automatisches Mitscrollen
  let toastTimer = null

  function showToast(text) {
    toast.textContent = text
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => (toast.hidden = true), 3500)
  }

  /** Punkt am Server setzen; Fehler kurz in der Kachel zeigen */
  async function setPosition(eventId, itemIndex) {
    pauseFollow()
    try {
      await postPosition(eventId, itemIndex)
    } catch (err) {
      showToast(`Punkt nicht gesetzt: ${err.message}`)
    }
  }
  if (look.control)
    autoBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (shownId != null) setPosition(shownId, null)
    })

  function pauseFollow() {
    manualUntil = Date.now() + MANUAL_MS
  }

  /** Was beim Aufklappen erscheint: Programmspalten und ausgeblendete Angaben */
  function details(item) {
    const lines = (item.columns || [])
      .filter((c) => !onlyColumns.length || onlyColumns.includes(String(c.group).toLowerCase()))
      .map((c) => [c.group, c.note])
    if (!options.responsible && item.responsible) lines.unshift(['Verantwortlich', item.responsible])
    if (!options.notes && item.note) lines.push(['Notiz', item.note])
    if (item.song) {
      if (!options.songInfo) {
        const facts = [item.song.key && `Tonart ${item.song.key}`, item.song.arrangement].filter(Boolean)
        if (facts.length) lines.push(['Song', facts.join(' · ')])
      }
      if (!options.ccli && item.song.ccli) lines.push(['CCLI', item.song.ccli])
    }
    return lines
  }

  // openItems merkt die Abweichung vom Standard (zu bzw. bei „immer aufgeklappt“ offen)
  const isOpen = (id) => look.openAll !== openItems.has(id)

  function toggle(row) {
    if (openItems.has(row.item.id)) openItems.delete(row.item.id)
    else openItems.add(row.item.id)
    const open = isOpen(row.item.id)
    row.li.classList.toggle('open', open)
    row.li.setAttribute('aria-expanded', String(open))
    pauseFollow()
  }

  function message(text) {
    rows = []
    body.replaceChildren(el('p', 'agenda-empty', text))
    renderStatus(null)
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
    /** Von Hand gesetzte Punkte aller Events (Server-Nachricht „ctposition“) */
    updatePosition(msg) {
      positions = msg?.positions || {}
      if (rows.length) tick()
    },
    tick,
    tickStatus,
  }

  /** Lage im Ablauf des gezeigten Events (laufender Punkt, Restzeit, Abweichung) */
  function currentStatus(event) {
    if (!event?.agenda || !live) return null
    return agendaStatus(event.agenda.items, {
      position: positions[String(event.id)],
      now: Date.now(),
      warnMin: look.warnMin,
      badMin: look.badMin,
    })
  }

  function renderStatus(st) {
    if (look.status === 'off') return
    status.classList.remove('level-ok', 'level-warn', 'level-bad')
    status.classList.toggle('manual', Boolean(st?.manual))
    autoBtn.hidden = !(look.control && st?.manual)
    if (!st) {
      setCell(stRest, '–', '')
      setCell(stDev, '–', '')
      setCell(stNext, '–', '')
      return
    }
    const tz = data?.timeZone
    if (st.current) {
      setCell(stRest, fmtRemaining(st.remainingSec), st.remainingSec < 0 ? 'überzogen' : st.current.title)
      status.classList.add(`level-${st.level}`)
      const dev = st.deviationMin
      setCell(stDev, st.manual ? fmtDeviation(dev) : 'nach Plan', st.manual ? (dev > 0 ? 'hinter Plan' : dev < 0 ? 'vor Plan' : 'im Plan') : 'nach Uhrzeit')
    } else {
      setCell(stRest, '–', st.next ? 'noch nicht begonnen' : 'Ablauf vorbei')
      setCell(stDev, '–', '')
    }
    if (st.next) setCell(stNext, st.next.title, [st.next.responsible, fmtTime(st.next.start, tz)].filter(Boolean).join(' · '))
    else setCell(stNext, 'Ende', '')
  }

  /** Nur die Statuszeile (Sekundentakt) – ohne Punkte neu zu markieren */
  function tickStatus() {
    if (look.status === 'off' || !rows.length || !live) return
    renderStatus(currentStatus(currentEvent()))
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
    renderStatus(null)
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
      if (item.type === 'header' && !look.sections) continue
      if (item.beforeEvent && !look.before) continue
      const li = el('li', `agenda-item type-${item.type}`)
      if (item.beforeEvent) li.classList.add('before-event')
      const index = event.agenda.items.indexOf(item)
      if (item.type === 'header') {
        li.append(el('span', 'agenda-time', fmtTime(item.start, tz)), el('span', 'agenda-head', item.title))
        list.append(li)
        rows.push({ li, item, bar: null, index })
        continue
      }
      const main = el('div', 'agenda-main')
      const title = el('div', 'agenda-item-title')
      title.append(el('span', null, item.title))
      if (item.song) {
        const facts = options.songInfo ? [item.song.key && `Tonart ${item.song.key}`, item.song.arrangement].filter(Boolean) : []
        if (facts.length) title.append(el('span', 'agenda-song', facts.join(' · ')))
        if (options.ccli && item.song.ccli) {
          const ccli = el('span', 'agenda-ccli-wrap')
          ccli.append(el('span', 'agenda-ccli', `CCLI ${item.song.ccli}`), copyButton(item.song.ccli))
          title.append(ccli)
        }
      }
      main.append(title)
      if (options.responsible && item.responsible) main.append(el('div', 'agenda-resp', item.responsible))
      if (options.notes && item.note) main.append(el('div', 'agenda-note', item.note))
      const lines = details(item)
      if (lines.length) {
        const sub = el('dl', 'agenda-sub')
        for (const line of lines) sub.append(el('dt', null, line[0]), el('dd', null, line[1]))
        main.append(sub)
      }
      const bar = el('span', 'agenda-progress')
      li.append(el('span', 'agenda-time', fmtTime(item.start, tz)), main, el('span', 'agenda-dur', fmtDuration(item.duration)), bar)
      if (look.control && live) {
        // Bedienung: diesen Punkt jetzt als laufenden setzen (alle Kacheln folgen)
        const go = el('button', 'agenda-go', '▶')
        go.type = 'button'
        go.title = `„${item.title}“ jetzt starten`
        go.setAttribute('aria-label', `${item.title} jetzt starten`)
        go.addEventListener('click', (e) => {
          e.stopPropagation()
          setPosition(event.id, index)
        })
        go.addEventListener('keydown', (e) => e.stopPropagation())
        li.append(go)
      }
      list.append(li)
      const row = { li, item, bar, index }
      rows.push(row)
      if (lines.length) {
        li.classList.add('has-sub')
        li.tabIndex = 0
        li.setAttribute('role', 'button')
        const open = isOpen(item.id)
        li.classList.toggle('open', open)
        li.setAttribute('aria-expanded', String(open))
        li.addEventListener('click', () => toggle(row))
        li.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          e.preventDefault()
          toggle(row)
        })
      }
    }
    // Eigenes Scrollen (Rad, Wischen) hält das Mitscrollen kurz an
    list.addEventListener('wheel', pauseFollow, { passive: true })
    list.addEventListener('touchstart', pauseFollow, { passive: true })
    const keepScroll = body.querySelector('.agenda-list')?.scrollTop
    body.replaceChildren(list)
    if (keepScroll != null && Date.now() < manualUntil) {
      list.scrollTop = keepScroll
      tick()
    } else tick(true)
  }

  /** Laufenden Punkt markieren, erledigte abdunkeln, mitscrollen. */
  function tick(force = false) {
    // Laufendes Event vorbei oder nächstes begonnen: anderes Event zeigen
    if (data && (currentEvent()?.id ?? null) !== shownId) return render()
    if (!rows.length || !live) return
    const now = Date.now()
    const st = currentStatus(currentEvent())
    renderStatus(st)
    let current = null
    for (const row of rows) {
      const isHeader = row.item.type === 'header'
      let start = row.item.start ? Date.parse(row.item.start) : NaN
      let running
      let done
      if (st?.manual) {
        // Von Hand gesetzt: dieser Punkt läuft seit dem Klick, alle davor sind erledigt
        running = !isHeader && row.index === st.index
        done = !isHeader && row.index < st.index
        if (running) start = st.startedAt
      } else {
        running = !isHeader && start <= now && now < start + row.item.duration * 1000
        done = !isHeader ? now >= start + row.item.duration * 1000 : false
      }
      const end = start + row.item.duration * 1000
      row.li.classList.toggle('current', running)
      row.li.classList.toggle('done', done)
      if (running) {
        current = row
        row.bar.style.width = `${Math.min(100, end > start ? ((now - start) / (end - start)) * 100 : 100)}%`
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
    if (!list || !target || (!force && Date.now() < manualUntil)) return
    // Den vorherigen Punkt noch sichtbar lassen
    // (ausgeblendete erledigte Punkte überspringen)
    const index = rows.indexOf(target)
    let anchor = target.li
    for (let i = index - 1; i >= 0; i--) {
      if (rows[i].li.offsetParent === null) continue
      anchor = rows[i].li
      break
    }
    const top = anchor.offsetTop - list.offsetTop
    if (force || Math.abs(list.scrollTop - top) > 2) list.scrollTo({ top, behavior: force ? 'auto' : 'smooth' })
  }

  views.add(view)
  return view
}

/** Zelle der Statuszeile: Beschriftung klein, Wert groß, Zusatz darunter */
function statusCell(parent, label) {
  const cell = el('span', 'agenda-st')
  const value = el('b', null, '–')
  const sub = el('small', null, '')
  cell.append(el('i', null, label), value, sub)
  cell.value = value
  cell.sub = sub
  parent.append(cell)
  return cell
}

function setCell(cell, value, sub) {
  cell.value.textContent = value
  cell.sub.textContent = sub || ''
  cell.sub.hidden = !sub
}

setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 5000)
// Restzeit im Sekundentakt
setInterval(() => {
  for (const view of views) if (view.el.isConnected) view.tickStatus()
}, 1000)
