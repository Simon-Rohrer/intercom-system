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

/** Alle Playlists aus /v1/playlists (Ordner aufgelöst) */
function flattenPlaylists(list, out = []) {
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry?.field_type === 'playlist' && entry.id?.uuid) out.push({ uuid: entry.id.uuid, name: String(entry.id.name || '') })
    if (Array.isArray(entry?.children)) flattenPlaylists(entry.children, out)
  }
  return out
}

function createSlideshow({ dataDir, getPpBase = () => '', onUpdate = () => {}, log = () => {}, fetchImpl = fetch, now = Date.now }) {
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

  function persist() {
    const tmp = `${stateFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ images, ppPlaylist, ppSlides, ppAt }, null, 2))
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
    },
    stop() {
      running = false
      clearTimeout(timer)
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
    settings: () => ({ ppPlaylist, images: images.length }),
  }
}

module.exports = { createSlideshow, imageType, flattenPlaylists }
