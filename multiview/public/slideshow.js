// Kachel „Diashow“ (z. B. Bildschirm in der Empfangshalle): hochgeladene Bilder mit „zeigen
// von/bis“, die zwischengespeicherten Folien einer ProPresenter-Playlist (laufen auch, wenn
// ProPresenter aus ist), die Slider-Bilder der Webseite, die Termine aus den öffentlichen
// ChurchTools-Kalendern (je Termin eine Folie mit seinem Bild), die Bilder aus einem Dropbox-Ordner
// (neue erscheinen sofort) und eine Folie „Nächste Veranstaltungen“.
// Die Folien blenden weich ineinander über (oder wechseln hart, Einstellung „Übergang“).
//
// Damit die Überblendung auch auf einem Raspberry Pi 3 und alten iPads flüssig läuft:
// - Bilder kommen vom Server auf Kachelgröße verkleinert (?w=…&h=…, höchstens 1920 px),
// - die nächste Folie wird schon geladen und dekodiert, während die aktuelle steht,
// - jede Folie ist genau eine Ebene (<img>, kein <canvas>), animiert wird nur opacity,
// - es läuft immer nur ein Wechsel; was währenddessen dran kommt, wartet.

const TIME_ZONE = 'Europe/Berlin'
const FADE_MS = 1000 // Dauer der Überblendung (wie transition in slideshow.css)

/** Einstellungen der Kachel (tile.slideshow) mit Standardwerten */
export function slideshowOptions(o = {}) {
  const names = (list) => (Array.isArray(list) ? [...new Set(list.filter((n) => typeof n === 'string' && n).map((n) => n.slice(0, 80)))].slice(0, 100) : [])
  const num = (v, d, min, max) => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : d
  }
  return {
    seconds: num(o.seconds, 10, 3, 120),
    images: o.images !== false,
    pp: o.pp !== false,
    ppPlaylist: String(o.ppPlaylist ?? '').trim().slice(0, 80), // Playlist in ProPresenter (je Kachel)
    events: o.events !== false,
    eventDays: num(o.eventDays, 14, 1, 42),
    eventMax: num(o.eventMax, 6, 1, 10),
    eventHidden: names(o.eventHidden), // ausgeschaltete Bereiche (Kalender) – neue sind an
    eventTitle: String(o.eventTitle ?? 'Nächste Veranstaltungen').slice(0, 60),
    fit: o.fit === 'cover' ? 'cover' : 'contain',
    website: o.website !== false, // Slider der Startseite
    posts: o.posts !== false, // Beiträge der Startseite (Ankündigungen mit Flyer)
    postCaption: o.postCaption === true, // Titel unter dem Flyer (meist steht er schon drauf)
    ct: o.ct !== false, // Termine aus ChurchTools als eigene Folien
    ctDays: num(o.ctDays, 14, 1, 42),
    ctMax: num(o.ctMax, 12, 1, 40),
    ctHidden: names(o.ctHidden),
    ctImageOnly: o.ctImageOnly !== false, // nur Termine mit Bild
    dropbox: o.dropbox === true, // Bilder aus dem Dropbox-Ordner (Einstellungen → Diashow)
    dropboxNow: o.dropboxNow !== false, // ein neu hineingezogenes Bild sofort zeigen
    transition: o.transition === 'none' ? 'none' : 'fade', // Überblenden oder harter Schnitt (schwache Geräte)
  }
}

const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: TIME_ZONE })

/** Nächste Veranstaltungen aus den ChurchTools-Daten (overview: Events der nächsten 4 Wochen) */
export function upcomingEvents(churchtools, o, now = Date.now()) {
  return (churchtools?.overview || [])
    .filter((e) => {
      const start = Date.parse(e.startDate)
      // Läuft gerade (bis 2 Std. nach Beginn) oder beginnt in den nächsten Tagen
      if (!Number.isFinite(start) || start < now - 2 * 3600e3 || start > now + o.eventDays * 86400e3) return false
      return !o.eventHidden.includes(e.calendar || '')
    })
    .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
    .slice(0, o.eventMax)
}

/** Termine aus ChurchTools, die als eigene Folie laufen (läuft gerade oder in den nächsten Tagen) */
export function ctAppointments(slideshow, o, now = Date.now()) {
  return (slideshow?.ct?.appointments || [])
    .filter((a) => {
      const start = Date.parse(a.start)
      const end = Date.parse(a.end || a.start)
      if (!Number.isFinite(start) || end < now || start > now + o.ctDays * 86400e3) return false
      if (o.ctImageOnly && !a.image) return false
      return !o.ctHidden.includes(a.calendar || '')
    })
    .slice(0, o.ctMax)
}

/** Folien der Playlist dieser Kachel; ältere Server ohne ppLists: die eine gemeinsame Playlist */
export function ppSlides(slideshow, o) {
  if (!slideshow?.ppLists) return slideshow?.pp?.slides || []
  return (o.ppPlaylist && slideshow.ppLists[o.ppPlaylist.toLowerCase()]?.slides) || []
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
  if (o.pp) for (const slide of ppSlides(data?.slideshow, o)) slides.push({ key: `pp:${slide.url}`, kind: 'image', url: slide.url })
  if (o.dropbox) for (const image of data?.slideshow?.dropbox?.images || []) slides.push({ key: `dbx:${image.url}`, kind: 'image', url: image.url })
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

/** Bild von ChurchTools im gewünschten Seitenverhältnis so groß anfordern, wie es in die Kachel passt */
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

// Kantenlängen, in denen der Server verkleinerte Fassungen liefert (slideshow-images.js)
const SIZE_STEPS = [360, 540, 720, 1080, 1440, 1920]
const sizeStep = (px) => SIZE_STEPS.find((s) => s >= px) || SIZE_STEPS[SIZE_STEPS.length - 1]

/**
 * Adresse einer Fassung, die in die Kachel passt (Bildschirmpixel, höchstens 1920): eigene Bilder
 * (/diashow/bild|pp|dropbox/…) mit ?w=…&h=…, Bilder der Webseite über den Server (/diashow/web).
 * Bei „Füllen“ muss das Bild die Kachel ganz bedecken (&fit=cover). Andere Adressen bleiben.
 */
export function scaledUrl(url, width, height, dpr = 1, cover = false) {
  const ratio = Math.min(Math.max(Number(dpr) || 1, 1), 2)
  const size = `w=${sizeStep((width || 1920) * ratio)}&h=${sizeStep((height || 1080) * ratio)}${cover ? '&fit=cover' : ''}`
  if (/^\/diashow\/(?:bild|pp|dropbox)\/[^?#/]+$/.test(url)) return `${url}?${size}`
  if (/^https?:\/\//i.test(url)) return `/diashow/web?u=${encodeURIComponent(url)}&${size}`
  return url
}

/** Bild laden und dekodieren – erst danach kommt es ins Bild (Safari 12 kennt decode() evtl. nicht) */
function loadImage(url) {
  return new Promise((resolve) => {
    const img = new Image()
    img.alt = ''
    img.decoding = 'async'
    const done = () => resolve(img)
    img.onload = () => (typeof img.decode === 'function' ? img.decode().then(done, done) : done())
    img.onerror = done
    img.src = url
  })
}

/** Bilder einer vorab gebauten Folie nochmals dekodieren (der Browser kann sie inzwischen verworfen haben) */
function decoded(node) {
  return Promise.all([...node.querySelectorAll('img')].map((img) => (typeof img.decode === 'function' ? img.decode().catch(() => {}) : null)))
}

/** Größe, in der ein Bild in die Kachel passt (Bildschirmpixel, höchstens 1920 breit) */
function fitSize(w, h, box) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const bw = Math.min((box.clientWidth || 1920) * dpr, 1920)
  const bh = Math.min((box.clientHeight || 1080) * dpr, 1920)
  const scale = Math.min(1, bw / w, bh / h)
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

/**
 * Bild für die Folie. Normalerweise hat der Server schon verkleinert. Kam doch ein viel zu großes
 * Bild (z. B. 5472 × 3648 aus der Kamera, Server ohne sharp), wird es hier einmal auf
 * Bildschirmgröße verkleinert – ein Pi 3 kann Texturen über 2048 Pixel nicht direkt darstellen.
 * Ergebnis ist immer ein <img>: Ein <canvas> würde eine eigene Ebene mit eigenem Grafikspeicher,
 * die beim Überblenden jedes Mal mitgezeichnet werden muss.
 */
async function loadPicture(url, box) {
  const img = await loadImage(url)
  const w = img.naturalWidth
  const h = img.naturalHeight
  if (!w || !h || typeof createImageBitmap !== 'function') return img
  const size = fitSize(w, h, box)
  if (w <= size.width * 1.25 && h <= size.height * 1.25) return img
  try {
    const bitmap = await createImageBitmap(img, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' })
    const canvas = document.createElement('canvas')
    canvas.width = size.width
    canvas.height = size.height
    canvas.getContext('2d').drawImage(bitmap, 0, 0)
    bitmap.close?.()
    // Bild einer fremden Seite ohne CORS: toBlob() geht nicht (SecurityError) – dann das Original
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, /\.png(?:[?#]|$)/i.test(url) ? 'image/png' : 'image/jpeg', 0.9))
    if (!blob) return img
    const small = await loadImage(URL.createObjectURL(blob))
    small.dataset.blob = '1' // freigeben, wenn die Folie wieder geht (release)
    return small.naturalWidth ? small : img
  } catch {
    return img
  }
}

/**
 * Unscharfer Hintergrund: winziges Abbild (32 × 18), das der Browser weich hochskaliert – ohne
 * teuren CSS-Filter. Als <img> (data:-Adresse), damit es mit der Folie eine Ebene bleibt; nur bei
 * Bildern fremder Seiten ohne CORS bleibt es ein <canvas>.
 */
async function blurredBack(picture) {
  const canvas = document.createElement('canvas')
  canvas.width = 32
  canvas.height = 18
  const ctx = canvas.getContext('2d')
  try {
    // Verkleinern im Hintergrund (createImageBitmap) statt drawImage des großen Bildes im Hauptthread
    let source = picture
    try {
      if (typeof createImageBitmap === 'function') source = await createImageBitmap(picture, { resizeWidth: canvas.width, resizeHeight: canvas.height, resizeQuality: 'medium' })
    } catch {}
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
    if (source !== picture) source.close?.()
  } catch {}
  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let back = canvas
  try {
    back = await loadImage(canvas.toDataURL('image/png'))
  } catch {}
  back.className = 'ss-back'
  return back
}

/** Folie entfernen und vorab verkleinerte Bilder freigeben */
function release(node) {
  for (const img of node.querySelectorAll('img[data-blob]')) URL.revokeObjectURL(img.src)
  node.remove()
}

/** Bild hat (fast) dasselbe Seitenverhältnis wie die Kachel, z. B. 16:9 auf 16:9 */
export function sameShape(w, h, bw, bh) {
  if (!w || !h || !bw || !bh) return false
  return Math.abs(w / h / (bw / bh) - 1) < 0.04
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
  root.dataset.transition = o.transition
  const empty = el('div', 'ss-empty', 'Keine Folien – Bilder unter Einstellungen → Diashow hochladen')
  root.append(empty)

  let data = null
  let slides = []
  let currentKey = ''
  let shownAt = 0
  let dropboxKnown = null // Dropbox-Bilder, die schon da waren – ein neues wird sofort gezeigt
  let current = null
  let busy = false // ein Wechsel läuft (Laden + Überblenden)
  let queued = null // Folie, die während eines Wechsels dran kam
  let prepared = null // nächste Folie, schon geladen: { key, at, node }
  let prepareTimer = 0

  /**
   * Einheitliche Bild-Folie für alle Quellen: dasselbe Bild unscharf als Hintergrund, davor das
   * Bild ganz und mittig im immer gleichen Rahmen; wo nötig darunter eine Beschriftung im
   * immer gleichen Stil (Datum, Titel, Ort).
   */
  async function cardSlide(url, caption) {
    const node = el('div', `ss-slide ss-card${caption ? ' has-caption' : ''}`)
    const frame = el('div', 'ss-frame')
    const picture = url ? await loadPicture(url, root) : null
    if (picture && picture.naturalWidth) {
      // Passt das Bild genau in die Kachel (16:9 auf 16:9): ganz ausfüllen, ohne Rahmen und Hintergrund
      if (!caption && sameShape(picture.naturalWidth, picture.naturalHeight, root.clientWidth, root.clientHeight)) node.classList.add('ss-full')
      else node.append(await blurredBack(picture))
      frame.append(picture)
    } else {
      // Kein Bild oder nicht ladbar: leerer Rahmen statt Symbol für ein kaputtes Bild
      node.append(el('div', 'ss-back'))
      frame.append(el('div', 'ss-blank'))
    }
    node.append(frame)
    if (caption) {
      const cap = el('div', 'ss-caption')
      if (caption.when) cap.append(el('div', 'ss-cap-when', caption.when))
      if (caption.title) cap.append(el('div', 'ss-cap-title', caption.title))
      if (caption.meta) cap.append(el('div', 'ss-cap-meta', caption.meta))
      node.append(cap)
    }
    return node
  }

  /** Adresse in Kachelgröße (Bildschirmpixel) */
  const sized = (url) => scaledUrl(url, root.clientWidth, root.clientHeight, window.devicePixelRatio, o.fit === 'cover')

  async function render(slide) {
    // Erst messen, wenn die Kachel im Bild ist (beim Aufbau kommt die erste Folie, bevor sie eingehängt ist)
    await null
    if (slide.kind === 'web') return cardSlide(sized(slide.url), slide.text ? { title: slide.text } : null)
    if (slide.kind === 'post') {
      const { post, image } = slide
      return cardSlide(fittedImage(image.url, image.ratio, root), o.postCaption ? { title: post.title } : null)
    }
    if (slide.kind === 'ct') {
      // Termin-Bilder sind meist Fotos ohne Text: immer mit Datum, Titel und Ort darunter
      const a = slide.appointment
      return cardSlide(a.image ? fittedImage(a.image, a.imageRatio || 16 / 9, root) : '', {
        when: whenText(a),
        title: a.title,
        meta: [a.subtitle, a.place].filter(Boolean).join(' · '),
      })
    }
    if (slide.kind === 'image') return cardSlide(sized(slide.url), null)
    const node = el('div', 'ss-slide ss-slide-events')
    node.append(eventsSlide(slide.events, o))
    return node
  }

  /** Nächste Folie schon bauen (Bild laden, dekodieren, ggf. verkleinern), solange die aktuelle steht */
  function prepare(slide) {
    if (!slide || prepared?.key === slide.key) return
    if (prepared) drop(prepared)
    prepared = { key: slide.key, at: Date.now(), node: render(slide).catch(() => null) }
  }

  function drop(entry) {
    entry.node.then((node) => node && release(node))
  }

  /** Vorab gebaute Folie nehmen (höchstens 5 Minuten alt), sonst jetzt bauen */
  async function take(slide) {
    const entry = prepared
    prepared = null
    if (entry && entry.key === slide.key && Date.now() - entry.at < 5 * 60e3) {
      const node = await entry.node
      if (node) return node
    } else if (entry) drop(entry)
    return render(slide)
  }

  /**
   * Neue Folie einblenden – nur opacity, das macht der Compositor ohne Neuzeichnen. Zwei
   * Bildaufbauten abwarten, damit die neue Ebene fertig gezeichnet ist, bevor die Überblendung
   * beginnt. Fertig nach transitionend (oder spätestens nach der Dauer + Reserve).
   */
  function fadeIn(node) {
    return new Promise((resolve) => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          node.classList.add('on')
          if (o.transition === 'none') return requestAnimationFrame(() => resolve())
          let timer = 0
          const finish = () => {
            clearTimeout(timer)
            node.removeEventListener('transitionend', onEnd)
            resolve()
          }
          const onEnd = (e) => e.target === node && finish()
          node.addEventListener('transitionend', onEnd)
          timer = setTimeout(finish, FADE_MS + 300)
        }),
      )
    })
  }

  async function show(slide) {
    // Nie zwei Wechsel zugleich (zwei Überblendungen übereinander überfordern einen Pi)
    if (busy) {
      queued = slide
      return
    }
    busy = true
    try {
      const node = await take(slide)
      await decoded(node)
      const old = current
      current = node
      currentKey = slide.key
      shownAt = Date.now()
      root.append(node)
      await fadeIn(node)
      // Alte Folie erst weg, wenn die neue ganz deckt
      if (old) release(old)
    } catch {
    } finally {
      busy = false
    }
    const next = queued
    queued = null
    if (next && next.key !== currentKey && slides.some((s) => s.key === next.key)) return show(next)
    // Die nächste Folie schon laden, solange diese steht – beim Wechsel ist dann nichts mehr zu tun.
    // Kurz warten: Der Browser soll erst die gerade gezeigte Folie fertig zeichnen.
    clearTimeout(prepareTimer)
    prepareTimer = setTimeout(() => {
      const index = slides.findIndex((s) => s.key === currentKey)
      if (root.isConnected && !busy && slides.length > 1 && index !== -1) prepare(slides[(index + 1) % slides.length])
    }, 500)
  }

  function step(force = false) {
    empty.hidden = slides.length > 0
    if (!slides.length) {
      if (current) release(current)
      if (prepared) drop(prepared)
      prepared = null
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
      const dropboxSlides = slides.filter((s) => s.key.startsWith('dbx:'))
      const fresh = dropboxKnown && o.dropboxNow ? dropboxSlides.find((s) => !dropboxKnown.has(s.key)) : null
      if (data?.slideshow) dropboxKnown = new Set(dropboxSlides.map((s) => s.key))
      if (fresh && fresh.key !== currentKey) {
        empty.hidden = true
        show(fresh)
        return
      }
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
