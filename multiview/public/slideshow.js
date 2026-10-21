// Kachel „Diashow“ (z. B. Bildschirm in der Empfangshalle): hochgeladene Bilder mit „zeigen
// von/bis“, die zwischengespeicherten Folien einer ProPresenter-Playlist (laufen auch, wenn
// ProPresenter aus ist) und eine Folie „Nächste Veranstaltungen“ aus ChurchTools.
// Die Folien blenden weich ineinander über.

const TIME_ZONE = 'Europe/Berlin'

/** Einstellungen der Kachel (tile.slideshow) mit Standardwerten */
export function slideshowOptions(o = {}) {
  const num = (v, d, min, max) => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d
  }
  return {
    seconds: num(o.seconds, 10, 3, 120),
    images: o.images !== false,
    pp: o.pp !== false,
    events: o.events !== false,
    eventDays: num(o.eventDays, 14, 1, 42),
    eventMax: num(o.eventMax, 6, 1, 10),
    eventFilter: String(o.eventFilter ?? '').slice(0, 80),
    eventTitle: String(o.eventTitle ?? 'Nächste Veranstaltungen').slice(0, 60),
    fit: o.fit === 'cover' ? 'cover' : 'contain',
  }
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TIME_ZONE })

/** Nächste Veranstaltungen aus den ChurchTools-Daten (overview: Events der nächsten 4 Wochen) */
export function upcomingEvents(churchtools, o, now = Date.now()) {
  const words = o.eventFilter
    .toLowerCase()
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean)
  return (churchtools?.overview || [])
    .filter((e) => {
      const start = Date.parse(e.startDate)
      // Läuft gerade (bis 2 Std. nach Beginn) oder beginnt in den nächsten Tagen
      if (!Number.isFinite(start) || start < now - 2 * 3600e3 || start > now + o.eventDays * 86400e3) return false
      if (!words.length) return true
      const hay = `${e.name} ${e.calendar || ''}`.toLowerCase()
      return words.some((w) => hay.includes(w))
    })
    .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
    .slice(0, o.eventMax)
}

/** Alle Folien, die gerade dran sind – in dieser Reihenfolge: Bilder, ProPresenter, Veranstaltungen */
export function buildSlides(data, o, now = Date.now()) {
  const slides = []
  const day = today()
  if (o.images)
    for (const image of data?.slideshow?.images || []) {
      if (!image.enabled || (image.from && image.from > day) || (image.to && image.to < day)) continue
      slides.push({ key: `img:${image.url}`, kind: 'image', url: image.url })
    }
  if (o.pp) for (const slide of data?.slideshow?.pp?.slides || []) slides.push({ key: `pp:${slide.url}`, kind: 'image', url: slide.url })
  if (o.events) {
    const events = upcomingEvents(data?.churchtools, o, now)
    if (events.length) slides.push({ key: `events:${events.map((e) => e.id + e.startDate).join('|')}`, kind: 'events', events })
  }
  return slides
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function eventsSlide(events, o) {
  const box = el('div', 'ss-events')
  box.append(el('h2', 'ss-events-title', o.eventTitle))
  const list = el('ol', 'ss-events-list')
  const now = new Date()
  const todayText = now.toLocaleDateString('de-DE', { timeZone: TIME_ZONE })
  const tomorrow = new Date(now.getTime() + 86400e3).toLocaleDateString('de-DE', { timeZone: TIME_ZONE })
  for (const e of events) {
    const start = new Date(e.startDate)
    const date = start.toLocaleDateString('de-DE', { timeZone: TIME_ZONE })
    const label =
      date === todayText
        ? 'Heute'
        : date === tomorrow
          ? 'Morgen'
          : start.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TIME_ZONE })
    const item = el('li', 'ss-event')
    const when = el('div', 'ss-event-when')
    when.append(el('span', 'ss-event-day', label), el('span', 'ss-event-time', start.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE })))
    item.append(when, el('div', 'ss-event-name', e.name))
    list.append(item)
  }
  box.append(list)
  return box
}

export function createSlideshowView(options) {
  const o = slideshowOptions(options)
  const root = el('div', 'slideshow')
  root.dataset.fit = o.fit
  const empty = el('div', 'ss-empty', 'Keine Folien – Bilder unter Einstellungen → Diashow hochladen')
  root.append(empty)

  let data = null
  let slides = []
  let currentKey = ''
  let shownAt = 0
  let current = null
  let changing = false

  async function render(slide) {
    let node
    if (slide.kind === 'image') {
      node = el('div', 'ss-slide')
      const img = new Image()
      img.alt = ''
      img.decoding = 'async'
      img.src = slide.url
      // Erst zeigen, wenn das Bild fertig geladen ist – kein halbes Bild beim Überblenden
      await img.decode().catch(() => {})
      node.append(img)
    } else {
      node = el('div', 'ss-slide ss-slide-events')
      node.append(eventsSlide(slide.events, o))
    }
    return node
  }

  async function show(slide) {
    if (changing) return
    changing = true
    try {
      const node = await render(slide)
      root.append(node)
      // Einen Bildaufbau abwarten, dann einblenden; das alte Bild blendet danach aus
      requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('on')))
      const old = current
      current = node
      currentKey = slide.key
      shownAt = Date.now()
      if (old) setTimeout(() => old.remove(), 1200)
    } finally {
      changing = false
    }
  }

  function step(force = false) {
    empty.hidden = slides.length > 0
    if (!slides.length) {
      current?.remove()
      current = null
      currentKey = ''
      return
    }
    const index = slides.findIndex((s) => s.key === currentKey)
    // Aktuelle Folie gibt es nicht mehr (abgelaufen, gelöscht): gleich die nächste
    if (index === -1) return show(slides[0])
    if (!force && Date.now() - shownAt < o.seconds * 1000) return
    if (slides.length === 1) {
      // Nur eine Folie: Veranstaltungen trotzdem auffrischen (Tageswechsel, „Heute“/„Morgen“)
      if (slides[0].kind === 'events' && Date.now() - shownAt > 60_000) show(slides[0])
      return
    }
    show(slides[(index + 1) % slides.length])
  }

  const view = {
    el: root,
    update(next) {
      data = { ...data, ...next }
      slides = buildSlides(data, o)
      step()
    },
    tick: () => {
      if (data) slides = buildSlides(data, o)
      step()
    },
  }
  views.add(view)
  return view
}

const views = new Set()
setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 1000)
