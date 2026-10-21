'use strict'

// Diashow (Kachel „Diashow“, z. B. für den Bildschirm in der Empfangshalle).
// Quellen: hochgeladene Bilder (mit „zeigen von/bis“), die Folien einer ProPresenter-Playlist und
// die nächsten Veranstaltungen aus ChurchTools (die baut der Browser aus den ChurchTools-Daten).
// Die ProPresenter-Folien werden hier als Bilder zwischengespeichert: Die Diashow läuft so auch,
// wenn ProPresenter aus ist.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MAX_IMAGES = 200
const MAX_BYTES = 25 * 1024 * 1024
const PP_REFRESH_MS = 10 * 60 * 1000
const PP_RETRY_MS = 60 * 1000
const PP_TIMEOUT_MS = 8000
const PP_MAX_SLIDES = 120
// Webseite (Slider der Startseite) und ChurchTools-Termine: alle 15 Minuten, nach Fehlern nach 2 Minuten
const EXT_REFRESH_MS = 15 * 60 * 1000
const EXT_RETRY_MS = 2 * 60 * 1000
const EXT_TIMEOUT_MS = 15000
const CT_DAYS = 42
const CT_MAX = 80
const DEFAULT_WEBSITE = 'https://www.jms-altensteig.de/'

/** Bildformat am Dateianfang erkennen (nicht der Angabe des Browsers trauen) */
function imageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif'
  return null
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const day = (value) => (typeof value === 'string' && DAY.test(value) ? value : '')
const text = (value, max) => String(value ?? '').trim().slice(0, max)

function normalizeImage(entry) {
  return {
    id: String(entry.id),
    file: String(entry.file),
    title: text(entry.title, 80),
    from: day(entry.from),
    to: day(entry.to),
    enabled: entry.enabled !== false,
    createdAt: Number(entry.createdAt) || Date.now(),
  }
}

const decodeHtml = (value) =>
  String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Slider der Startseite einer ChurchTools-Webseite: je Folie das große Bild (Desktop, doppelte
 * Auflösung), der Link und der Text darauf. Liest nur das öffentliche HTML der Seite.
 */
function parseWebsiteSlides(html, pageUrl) {
  const hero = String(html).split(/class="[^"]*swiper--hero/)[1]
  if (!hero) return []
  // Bis zum Ende des Sliders (danach kommen andere Bereiche der Seite)
  const block = hero.split(/<(?:main|section|footer)\b|class="[^"]*swiper-pagination/)[0]
  const out = []
  for (const part of block.split(/<div class="swiper-slide[\s"]/).slice(1)) {
    const desktop = /<picture[^>]*slide__image-desktop[\s\S]*?<\/picture>/.exec(part)?.[0] || ''
    const srcset = /srcset="([^"]+)"/.exec(desktop)?.[1] || ''
    const candidates = srcset.split(',').map((c) => c.trim().split(/\s+/))
    const best = (candidates.find((c) => c[1] === '2x') || candidates[0] || [])[0]
    if (!best) continue
    let url
    try {
      url = new URL(best, pageUrl).href
    } catch {
      continue
    }
    if (!/^https?:/.test(url)) continue
    const href = /class="swiper-slide-content[^"]*"[^>]*href="([^"]+)"/.exec(part)?.[1] || /<a[^>]+href="([^"]+)"/.exec(part)?.[1] || ''
    let link = ''
    try {
      link = href ? new URL(href, pageUrl).href : ''
    } catch {
      link = ''
    }
    const inner = part
      .slice(part.indexOf('>') + 1) // Rest des öffnenden <div class="swiper-slide …">
      .replace(/<[^>]*$/, '') // abgeschnittenes Tag am Ende
      .replace(/<picture[\s\S]*?<\/picture>/g, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/Weiterlesen/g, '')
    const text = decodeHtml(inner).slice(0, 300)
    if (!out.some((slide) => slide.url === url)) out.push({ url, link, text })
  }
  return out
}

/** Beiträge, auf die die Startseite verlinkt (/beitraege/451-…): genau die, die dort gerade stehen */
function websitePostIds(html) {
  const ids = []
  for (const m of String(html).matchAll(/href="[^"]*\/beitraege\/(\d+)[^"]*"/g)) if (!ids.includes(Number(m[1]))) ids.push(Number(m[1]))
  return ids
}

/** Markdown der Beiträge grob zu Text (für die Bildunterschrift) */
const plainText = (md) =>
  String(md ?? '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>\\]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Beiträge aus /posts → Folien (Flyer mit Seitenverhältnis), abgelaufene fallen weg */
function mapPosts(list, { ids = [], group = 'Ankündigungen', now = Date.now() } = {}) {
  const isImage = (url) => /^https:\/\/[^/]+\/images\/\d+\/[0-9a-f]+$/i.test(url || '')
  return (Array.isArray(list) ? list : [])
    .filter((p) => p?.id != null && !p.isBanned)
    .filter((p) => (ids.length ? ids.includes(Number(p.id)) : String(p.group?.title || '').toLowerCase() === group.toLowerCase()))
    .filter((p) => !p.expirationDate || Date.parse(p.expirationDate) > now)
    .map((p) => {
      const meta = Array.isArray(p.imagesMeta) && p.imagesMeta.length ? p.imagesMeta : (p.images || []).map((url) => ({ imageUrl: url }))
      return {
        id: Number(p.id),
        title: text(p.title, 160),
        text: plainText(p.content).slice(0, 280),
        group: text(p.group?.title, 80),
        expires: p.expirationDate || '',
        images: meta
          .filter((m) => isImage(m.imageUrl))
          .map((m) => ({ url: m.imageUrl, ratio: Number(m.aspectRatio) > 0.2 && Number(m.aspectRatio) < 6 ? Number(m.aspectRatio) : 0 }))
          .slice(0, 4),
      }
    })
    .filter((p) => p.title && p.images.length)
    // Reihenfolge wie auf der Webseite
    .sort((a, b) => (ids.length ? ids.indexOf(a.id) - ids.indexOf(b.id) : b.id - a.id))
}

/** Termine aus /calendars/appointments → das, was die Diashow braucht (je Termin nur der nächste) */
function mapAppointments(list, now = Date.now()) {
  const seen = new Set()
  return (Array.isArray(list) ? list : [])
    .map((entry) => ({ base: entry?.appointment?.base || entry?.base || entry, calc: entry?.appointment?.calculated || entry?.calculated || {} }))
    .filter(({ base }) => base?.id != null && !base.isInternal)
    .map(({ base, calc }) => ({
      id: Number(base.id),
      title: text(base.title || base.caption, 120),
      subtitle: text(base.subtitle, 160),
      start: calc.startDate || base.startDate || '',
      end: calc.endDate || base.endDate || '',
      allDay: base.allDay === true,
      calendar: text(base.calendar?.name || base.calendar?.nameTranslated, 80),
      place: text(base.address?.meetingAt || base.address?.name, 80),
      // Öffentliche Bildadresse von ChurchTools; die Größe hängt die Kachel an (?w=…&h=…)
      image: /^https:\/\/[^/]+\/images\/\d+\/[0-9a-f]+$/i.test(base.image?.imageUrl || '') ? base.image.imageUrl : '',
    }))
    .filter((a) => a.title && Number.isFinite(Date.parse(a.start)) && Date.parse(a.end || a.start) >= now - 3600e3)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .filter((a) => (seen.has(a.id) ? false : seen.add(a.id)))
    .slice(0, CT_MAX)
}

/** Alle Playlists aus /v1/playlists (Ordner aufgelöst) */
function flattenPlaylists(list, out = []) {
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry?.field_type === 'playlist' && entry.id?.uuid) out.push({ uuid: entry.id.uuid, name: String(entry.id.name || '') })
    if (Array.isArray(entry?.children)) flattenPlaylists(entry.children, out)
  }
  return out
}

function createSlideshow({ dataDir, getPpBase = () => '', getCtApi = () => null, onUpdate = () => {}, log = () => {}, fetchImpl = fetch, now = Date.now }) {
  const dir = path.join(dataDir, 'diashow')
  const ppDir = path.join(dir, 'pp')
  const stateFile = path.join(dir, 'diashow.json')
  fs.mkdirSync(ppDir, { recursive: true })

  let saved = {}
  try {
    saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  } catch {
    saved = {}
  }
  let images = (Array.isArray(saved.images) ? saved.images : []).map(normalizeImage).filter((i) => fs.existsSync(path.join(dir, i.file)))
  let ppPlaylist = text(saved.ppPlaylist, 80)
  let ppSlides = Array.isArray(saved.ppSlides) ? saved.ppSlides.filter((s) => fs.existsSync(path.join(ppDir, s.file))) : []
  let ppAt = Number(saved.ppAt) || 0
  let ppState = ppPlaylist ? 'cached' : 'off'
  let ppError = ''
  let timer = null
  let running = false
  let refreshing = null
  // Webseite und ChurchTools-Termine (zuletzt geladener Stand bleibt nach Neustart erhalten)
  let websiteUrl = typeof saved.websiteUrl === 'string' ? saved.websiteUrl : DEFAULT_WEBSITE
  let website = { slides: Array.isArray(saved.website?.slides) ? saved.website.slides : [], at: Number(saved.website?.at) || 0, state: 'cached', error: '' }
  let ct = {
    appointments: Array.isArray(saved.ct?.appointments) ? saved.ct.appointments : [],
    posts: Array.isArray(saved.ct?.posts) ? saved.ct.posts : [],
    at: Number(saved.ct?.at) || 0,
    state: 'cached',
    error: '',
  }
  let postIds = Array.isArray(saved.website?.postIds) ? saved.website.postIds : []
  let extTimer = null

  function persist() {
    const tmp = `${stateFile}.tmp`
    fs.writeFileSync(
      tmp,
      JSON.stringify({ images, ppPlaylist, ppSlides, ppAt, websiteUrl, website: { slides: website.slides, at: website.at, postIds }, ct: { appointments: ct.appointments, posts: ct.posts, at: ct.at } }, null, 2),
    )
    fs.renameSync(tmp, stateFile)
  }

  /** Für alle Browser: was die Diashow zeigen kann (Adressen der Bilder, keine Pfade auf dem Server) */
  function snapshot() {
    return {
      type: 'slideshow',
      images: images.map((i) => ({ id: i.id, url: `/diashow/bild/${i.file}`, title: i.title, from: i.from, to: i.to, enabled: i.enabled })),
      pp: {
        playlist: ppPlaylist,
        state: ppState,
        error: ppError,
        at: ppAt,
        slides: ppSlides.map((s) => ({ url: `/diashow/pp/${s.file}`, name: s.name })),
      },
      website: { url: websiteUrl, state: websiteUrl ? website.state : 'off', error: website.error, at: website.at, slides: websiteUrl ? website.slides : [] },
      ct: { state: ct.state, error: ct.error, at: ct.at, appointments: ct.appointments, posts: ct.posts },
    }
  }

  const changed = () => {
    persist()
    onUpdate(snapshot())
  }

  function addImage(buffer, { title = '', from = '', to = '' } = {}) {
    if (buffer.length > MAX_BYTES) throw Object.assign(new Error('Bild ist zu groß (höchstens 25 MB)'), { status: 413 })
    const ext = imageType(buffer)
    if (!ext) throw Object.assign(new Error('Nur Bilder (JPG, PNG, WebP oder GIF)'), { status: 415 })
    if (images.length >= MAX_IMAGES) throw Object.assign(new Error(`Höchstens ${MAX_IMAGES} Bilder`), { status: 409 })
    const id = crypto.randomBytes(8).toString('hex')
    const file = `${id}.${ext}`
    fs.writeFileSync(path.join(dir, file), buffer)
    const image = normalizeImage({ id, file, title, from, to, enabled: true, createdAt: now() })
    images.push(image)
    changed()
    return image
  }

  function updateImage(id, patch) {
    const image = images.find((i) => i.id === id)
    if (!image) throw Object.assign(new Error('Bild nicht gefunden'), { status: 404 })
    const next = normalizeImage({ ...image, ...patch, id: image.id, file: image.file })
    if (next.from && next.to && next.to < next.from) throw Object.assign(new Error('„bis“ liegt vor „von“'), { status: 400 })
    Object.assign(image, next)
    changed()
    return image
  }

  function removeImage(id) {
    const image = images.find((i) => i.id === id)
    if (!image) throw Object.assign(new Error('Bild nicht gefunden'), { status: 404 })
    images = images.filter((i) => i !== image)
    fs.rmSync(path.join(dir, image.file), { force: true })
    changed()
  }

  /** Reihenfolge: Liste der IDs, unbekannte werden ignoriert, fehlende hinten angehängt */
  function reorder(ids) {
    const byId = new Map(images.map((i) => [i.id, i]))
    const ordered = (Array.isArray(ids) ? ids : []).map((id) => byId.get(String(id))).filter(Boolean)
    images = [...new Set([...ordered, ...images])]
    changed()
  }

  /** Datei für /diashow/bild/:file bzw. /diashow/pp/:file – nur bekannte Namen, nie ein Pfad */
  function filePath(kind, name) {
    const list = kind === 'pp' ? ppSlides : images
    const hit = list.find((entry) => entry.file === name)
    return hit ? path.join(kind === 'pp' ? ppDir : dir, hit.file) : null
  }

  async function ppJson(base, pathname) {
    const res = await fetchImpl(`${base}${pathname}`, { signal: AbortSignal.timeout(PP_TIMEOUT_MS) })
    if (!res.ok) throw new Error(`ProPresenter antwortet mit Fehler ${res.status}`)
    const body = await res.text()
    return body ? JSON.parse(body) : null
  }

  /** Folien der Playlist von ProPresenter holen und als Bilder speichern */
  async function refreshPp() {
    if (refreshing) return refreshing
    refreshing = (async () => {
      const base = getPpBase()
      if (!ppPlaylist) {
        ppState = 'off'
        ppError = ''
        return
      }
      if (!base) {
        ppState = ppSlides.length ? 'cached' : 'error'
        ppError = 'ProPresenter ist nicht eingerichtet (Einstellungen → ProPresenter)'
        return
      }
      try {
        const playlists = flattenPlaylists(await ppJson(base, '/v1/playlists'))
        const wanted = ppPlaylist.toLowerCase()
        const playlist = playlists.find((p) => p.name.toLowerCase() === wanted) || playlists.find((p) => p.name.toLowerCase().includes(wanted))
        if (!playlist) throw new Error(`Playlist „${ppPlaylist}“ gibt es in ProPresenter nicht`)
        const items = (await ppJson(base, `/v1/playlist/${encodeURIComponent(playlist.uuid)}`))?.items || []
        const fresh = []
        for (const item of items) {
          const uuid = item.presentation_info?.presentation_uuid
          if (!uuid || item.is_hidden) continue
          const presentation = (await ppJson(base, `/v1/presentation/${encodeURIComponent(uuid)}`))?.presentation
          const slides = (presentation?.groups || []).flatMap((g) => g.slides || [])
          for (let index = 0; index < slides.length && fresh.length < PP_MAX_SLIDES; index++) {
            if (slides[index].enabled === false) continue
            const res = await fetchImpl(`${base}/v1/presentation/${encodeURIComponent(uuid)}/thumbnail/${index}?quality=1920&thumbnail_type=jpeg`, {
              signal: AbortSignal.timeout(PP_TIMEOUT_MS),
            })
            if (!res.ok) continue
            const buffer = Buffer.from(await res.arrayBuffer())
            if (!imageType(buffer)) continue
            // Name aus dem Inhalt: gleiche Folie = gleiche Datei, geänderte Folie = neue Adresse (kein alter Browser-Cache)
            const file = `${crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 16)}.jpg`
            if (!fs.existsSync(path.join(ppDir, file))) fs.writeFileSync(path.join(ppDir, file), buffer)
            fresh.push({ file, name: String(item.id?.name || presentation?.id?.name || '') })
          }
        }
        const keep = new Set(fresh.map((s) => s.file))
        for (const name of fs.readdirSync(ppDir)) if (!keep.has(name)) fs.rmSync(path.join(ppDir, name), { force: true })
        const before = JSON.stringify(ppSlides)
        ppSlides = fresh
        ppAt = now()
        ppState = 'ok'
        ppError = ''
        if (JSON.stringify(ppSlides) !== before) log(`Diashow: ${fresh.length} Folien aus ProPresenter („${playlist.name}“)`)
      } catch (err) {
        ppState = ppSlides.length ? 'cached' : 'error'
        ppError = err.name === 'TimeoutError' || /fetch failed|ECONNREFUSED/i.test(err.message) ? 'ProPresenter nicht erreichbar – es laufen die zuletzt gespeicherten Folien' : err.message
      }
    })()
    try {
      await refreshing
    } finally {
      refreshing = null
      changed()
    }
  }

  function schedule(ms) {
    clearTimeout(timer)
    if (running) timer = setTimeout(loop, ms)
  }

  async function loop() {
    await refreshPp()
    schedule(ppState === 'ok' || ppState === 'off' ? PP_REFRESH_MS : PP_RETRY_MS)
  }

  async function refreshWebsite() {
    if (!websiteUrl) {
      website = { slides: [], at: 0, state: 'off', error: '' }
      return
    }
    try {
      const res = await fetchImpl(websiteUrl, { signal: AbortSignal.timeout(EXT_TIMEOUT_MS), headers: { Accept: 'text/html' } })
      if (!res.ok) throw new Error(`Webseite antwortet mit Fehler ${res.status}`)
      const html = await res.text()
      postIds = websitePostIds(html)
      const slides = parseWebsiteSlides(html, res.url || websiteUrl)
      if (!slides.length) throw new Error('Auf der Seite wurde kein Slider gefunden')
      if (JSON.stringify(slides) !== JSON.stringify(website.slides)) log(`Diashow: ${slides.length} Folien von der Webseite`)
      website = { slides, at: now(), state: 'ok', error: '' }
    } catch (err) {
      website = { ...website, state: website.slides.length ? 'cached' : 'error', error: err.name === 'TimeoutError' ? 'Webseite antwortet nicht' : err.message }
    }
  }

  async function refreshCt() {
    const api = getCtApi()
    if (!api) {
      ct = { ...ct, state: ct.appointments.length ? 'cached' : 'error', error: 'ChurchTools ist nicht verbunden' }
      return
    }
    try {
      const calendars = ((await api('/calendars'))?.data || []).filter((c) => c.isPublic === true || c.type === 'public')
      if (!calendars.length) throw new Error('Keine öffentlichen Kalender in ChurchTools')
      const from = new Date(now()).toISOString().slice(0, 10)
      const to = new Date(now() + CT_DAYS * 86400e3).toISOString().slice(0, 10)
      const query = calendars.map((c) => `calendar_ids[]=${encodeURIComponent(c.id)}`).join('&')
      const list = (await api(`/calendars/appointments?${query}&from=${from}&to=${to}`))?.data || []
      const appointments = mapAppointments(list, now())
      // Beiträge (Ankündigungen mit Flyer): die, die auf der Startseite stehen – ohne Webseite die Gruppe „Ankündigungen“
      let posts = ct.posts
      try {
        posts = mapPosts((await api('/posts?limit=100'))?.data || [], { ids: websiteUrl ? postIds : [], now: now() })
      } catch (err) {
        log(`Diashow: Beiträge nicht geladen: ${err.message}`)
      }
      ct = { appointments, posts, at: now(), state: 'ok', error: '' }
    } catch (err) {
      ct = { ...ct, state: ct.appointments.length ? 'cached' : 'error', error: err.message }
    }
  }

  async function refreshExternal() {
    // Erst die Webseite (welche Beiträge dort stehen), dann ChurchTools
    await refreshWebsite()
    await refreshCt()
    changed()
  }

  function scheduleExt(ms) {
    clearTimeout(extTimer)
    if (running) extTimer = setTimeout(extLoop, ms)
  }

  async function extLoop() {
    await refreshExternal()
    const failed = website.state === 'error' || website.state === 'cached' || ct.state !== 'ok'
    scheduleExt(failed ? EXT_RETRY_MS : EXT_REFRESH_MS)
  }

  function setWebsiteUrl(url) {
    const value = text(url, 300)
    if (value) {
      let parsed
      try {
        parsed = new URL(value)
      } catch {
        throw Object.assign(new Error('Keine gültige Adresse (z. B. https://www.jms-altensteig.de/)'), { status: 400 })
      }
      if (!/^https?:$/.test(parsed.protocol)) throw Object.assign(new Error('Nur http:// oder https://'), { status: 400 })
      websiteUrl = parsed.href
    } else websiteUrl = ''
    website = { slides: [], at: 0, state: websiteUrl ? 'cached' : 'off', error: '' }
    changed()
    return refreshExternal()
  }

  function setPpPlaylist(name) {
    ppPlaylist = text(name, 80)
    if (!ppPlaylist) {
      ppSlides = []
      for (const file of fs.readdirSync(ppDir)) fs.rmSync(path.join(ppDir, file), { force: true })
      ppState = 'off'
      ppError = ''
    }
    changed()
    return refreshPp()
  }

  return {
    start() {
      if (running) return
      running = true
      schedule(5000)
      scheduleExt(8000)
    },
    stop() {
      running = false
      clearTimeout(timer)
      clearTimeout(extTimer)
    },
    /** ProPresenter ist (wieder) erreichbar: gleich die Folien holen */
    ppReachable() {
      if (ppPlaylist && ppState !== 'ok') schedule(0)
    },
    snapshot,
    addImage,
    updateImage,
    removeImage,
    reorder,
    filePath,
    setPpPlaylist,
    refreshPp,
    setWebsiteUrl,
    refreshExternal,
    settings: () => ({ ppPlaylist, images: images.length }),
  }
}

module.exports = { createSlideshow, imageType, flattenPlaylists, parseWebsiteSlides, mapAppointments, mapPosts, websitePostIds }
