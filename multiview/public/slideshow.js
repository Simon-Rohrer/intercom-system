// Kachel „Diashow“ (z. B. Bildschirm in der Empfangshalle): hochgeladene Bilder mit „zeigen
// von/bis“, die zwischengespeicherten Folien einer ProPresenter-Playlist (laufen auch, wenn
// ProPresenter aus ist), die Slider-Bilder der Webseite, die Termine aus den öffentlichen
// ChurchTools-Kalendern (je Termin eine Folie mit seinem Bild) und eine Folie „Nächste Veranstaltungen“.
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
    website: o.website !== false, // Slider der Startseite
    posts: o.posts !== false, // Beiträge der Startseite (Ankündigungen mit Flyer)
    postCaption: o.postCaption === true, // Titel unter dem Flyer (meist steht er schon drauf)
    ct: o.ct !== false, // Termine aus ChurchTools als eigene Folien
    ctDays: num(o.ctDays, 14, 1, 42),
    ctMax: num(o.ctMax, 12, 1, 40),
    ctFilter: String(o.ctFilter ?? '').slice(0, 120),
    ctImageOnly: o.ctImageOnly !== false, // nur Termine mit Bild
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

/** Termine aus ChurchTools, die als eigene Folie laufen (läuft gerade oder in den nächsten Tagen) */
export function ctAppointments(slideshow, o, now = Date.now()) {
  const words = o.ctFilter
    .toLowerCase()
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean)
  return (slideshow?.ct?.appointments || [])
    .filter((a) => {
      const start = Date.parse(a.start)
      const end = Date.parse(a.end || a.start)
      if (!Number.isFinite(start) || end < now || start > now + o.ctDays * 86400e3) return false
      if (o.ctImageOnly && !a.image) return false
      if (!words.length) return true
      const hay = `${a.title} ${a.subtitle} ${a.calendar}`.toLowerCase()
      return words.some((w) => hay.includes(w))
    })
    .slice(0, o.ctMax)
}

/** Alle Folien, die gerade dran sind – in dieser Reihenfolge: Webseite, Termine, Bilder, ProPresenter, Veranstaltungen */
export function buildSlides(data, o, now = Date.now()) {
  const slides = []
  const day = today()
  if (o.website)
    for (const slide of data?.slideshow?.website?.slides || []) slides.push({ key: `web:${slide.url}`, kind: 'web', url: slide.url, text: slide.text })
  if (o.posts)
    for (const post of data?.slideshow?.ct?.posts || []) {
      if (post.expires && Date.parse(post.expires) <= now) continue
      for (const image of post.images) slides.push({ key: `post:${post.id}:${image.url}`, kind: 'post', post, image })
    }
  if (o.ct) for (const a of ctAppointments(data?.slideshow, o, now)) slides.push({ key: `ct:${a.id}:${a.start}`, kind: 'ct', appointment: a })
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

/** "Heute · 18:00 Uhr", "Sa., 24.10. · 19:30 Uhr", "Mo., 26.10. – Mi., 28.10." */
function whenText(a, now = new Date()) {
  const start = new Date(a.start)
  const end = new Date(a.end || a.start)
  const dayOf = (d) => d.toLocaleDateString('sv-SE', { timeZone: TIME_ZONE })
  const todayDay = dayOf(now)
  const tomorrowDay = dayOf(new Date(now.getTime() + 86400e3))
  const dayLabel = (d) =>
    dayOf(d) === todayDay ? 'Heute' : dayOf(d) === tomorrowDay ? 'Morgen' : d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: TIME_ZONE })
  const time = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE })
  // Ganztägig endet bei ChurchTools am Ende des letzten Tages; mehrtägig: Zeitraum
  const lastDay = a.allDay ? new Date(end.getTime() - 1000) : end
  if (dayOf(lastDay) !== dayOf(start)) return `${dayLabel(start)} – ${dayLabel(lastDay)}`
  if (a.allDay) return `${dayLabel(start)} · ganztägig`
  return `${dayLabel(start)} · ${time(start)} Uhr`
}

/** ChurchTools liefert das Bild in jeder Größe (zugeschnitten): passend zur Kachel anfordern */
function sizedImage(url, box) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  let w = Math.max(160, Math.round((box.clientWidth || 1920) * dpr))
  let h = Math.max(90, Math.round((box.clientHeight || 1080) * dpr))
  const scale = Math.min(1, 1920 / Math.max(w, h))
  // Auf 40 px runden: gleiche Kachelgröße = gleiche Adresse = Bild aus dem Browser-Cache
  w = Math.round((w * scale) / 40) * 40 || 40
  h = Math.round((h * scale) / 40) * 40 || 40
  return `${url}?w=${w}&h=${h}`
}

/** Flyer ganz zeigen: Bild im Original-Seitenverhältnis so groß anfordern, wie es in die Kachel passt */
function fittedImage(url, ratio, box) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const bw = (box.clientWidth || 1920) * dpr
  const bh = (box.clientHeight || 1080) * dpr
  const r = ratio || bw / bh
  let w = bw / bh > r ? bh * r : bw
  let h = w / r
  const scale = Math.min(1, 1920 / Math.max(w, h))
  w = Math.max(40, Math.round((w * scale) / 20) * 20)
  h = Math.max(40, Math.round((h * scale) / 20) * 20)
  return `${url}?w=${w}&h=${h}`
}

function loadImage(url) {
  const img = new Image()
  img.alt = ''
  img.decoding = 'async'
  img.src = url
  return img.decode().then(
    () => img,
    () => img,
  )
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
    if (slide.kind === 'web') {
      // Banner der Webseite (sehr breit): ganz zeigen, dahinter dasselbe Bild unscharf als Fläche
      node = el('div', 'ss-slide ss-slide-web')
      const img = await loadImage(slide.url)
      const back = el('div', 'ss-web-back')
      back.style.backgroundImage = `url("${slide.url.replace(/"/g, '%22')}")`
      node.append(back, img)
      if (slide.text) node.append(el('div', 'ss-web-text', slide.text))
    } else if (slide.kind === 'post') {
      // Beitrag der Webseite: Flyer ganz zeigen, dahinter unscharf, darunter der Titel
      const { post, image } = slide
      node = el('div', `ss-slide ss-slide-web ss-slide-post${o.postCaption ? ' with-caption' : ''}`)
      const url = fittedImage(image.url, image.ratio, root)
      const img = await loadImage(url)
      const back = el('div', 'ss-web-back')
      back.style.backgroundImage = `url("${url.replace(/"/g, '%22')}")`
      const frame = el('div', 'ss-post-frame')
      frame.append(img)
      node.append(back, frame)
      if (o.postCaption) node.append(el('div', 'ss-post-caption', post.title))
    } else if (slide.kind === 'ct') {
      const a = slide.appointment
      node = el('div', `ss-slide ss-slide-ct${a.image ? '' : ' no-image'}`)
      if (a.image) node.append(await loadImage(sizedImage(a.image, root)))
      const info = el('div', 'ss-ct-info')
      info.append(el('div', 'ss-ct-when', whenText(a)), el('div', 'ss-ct-title', a.title))
      if (a.subtitle) info.append(el('div', 'ss-ct-sub', a.subtitle))
      const meta = [a.place, a.calendar].filter(Boolean).join(' · ')
      if (meta) info.append(el('div', 'ss-ct-meta', meta))
      node.append(info)
    } else if (slide.kind === 'image') {
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
      if ((slides[0].kind === 'events' || slides[0].kind === 'ct') && Date.now() - shownAt > 60_000) show(slides[0])
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
