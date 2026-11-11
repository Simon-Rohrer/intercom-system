'use strict'

// Verkleinerte Bilder für die Diashow-Kachel. Die Kachel fragt ein Bild mit ?w=…&h=… (Kachelgröße
// in Bildschirmpixeln) an; der Server liefert eine einmal verkleinerte Fassung (höchstens 1920 px)
// aus dem Zwischenspeicher `diashow/klein/` im Datenordner. So dekodiert ein Raspberry Pi 3 oder
// ein altes iPad nicht bei jedem Bildwechsel ein 3840 × 1200 großes Website-Bild oder ein
// Kamerafoto mit 5472 × 3648 – das ließ die Überblendung ruckeln.
//
// Verkleinert wird mit sharp (libvips). Fehlt sharp (z. B. Windows-Installation ohne passendes
// Paket), bekommt der Browser das Original – die Kachel verkleinert dann selbst, wo sie kann.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Erlaubte Größen (Kante in Pixeln): wenige Stufen, damit der Zwischenspeicher klein bleibt
const STEPS = [360, 540, 720, 1080, 1440, 1920]
const MAX_ENTRIES = 400
const MAX_BYTES = 400 * 1024 * 1024
const WEB_TIMEOUT_MS = 15000
const WEB_MAX_BYTES = 25 * 1024 * 1024

function loadSharp() {
  try {
    const sharp = require('sharp')
    // Ein Bild nach dem anderen, ohne eigenen Zwischenspeicher von libvips: der Server macht
    // nebenbei Intercom, Video und Kiosk und soll dabei nicht spürbar langsamer werden
    sharp.concurrency(1)
    sharp.cache(false)
    return sharp
  } catch {
    return null
  }
}

/** Kantenlänge auf die nächste erlaubte Stufe aufrunden (null = keine/ungültige Angabe) */
function step(value) {
  const n = Number(value)
  if (value == null || value === '' || !Number.isFinite(n) || n <= 0) return null
  return STEPS.find((s) => s >= n) || STEPS[STEPS.length - 1]
}

/**
 * Gewünschte Größe aus ?w=…&h=…[&fit=cover]; null, wenn nichts (Gültiges) angegeben ist.
 * cover: Das Bild muss die Fläche ganz bedecken (Kachel „Füllen“), sonst passt es hinein.
 */
function wantedSize(query = {}) {
  const w = step(query.w)
  const h = step(query.h)
  if (!w && !h) return null
  return { w: w || h, h: h || w, cover: query.fit === 'cover' }
}

/** Bildformat am Dateianfang (wie slideshow.js, hier für heruntergeladene Website-Bilder) */
function imageKind(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg'
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png'
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp'
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif'
  return null
}

function createImageScaler({ cacheDir, sharp = loadSharp(), log = () => {}, fetchImpl = fetch, maxEntries = MAX_ENTRIES, maxBytes = MAX_BYTES }) {
  const webDir = path.join(cacheDir, 'web')
  fs.mkdirSync(webDir, { recursive: true })
  const running = new Map() // gleiche Anfrage läuft schon → auf dieselbe warten
  const original = new Set() // Bilder, die schon klein genug sind (Original schicken)
  const failed = new Map() // Website-Bild nicht ladbar: Adresse → Zeitpunkt (5 Minuten Pause)
  let queue = Promise.resolve() // ein Bild nach dem anderen
  let warned = false

  const once = (key, job) => {
    if (running.has(key)) return running.get(key)
    const promise = job().finally(() => running.delete(key))
    running.set(key, promise)
    return promise
  }
  const queued = (job) => {
    const result = queue.then(job, job)
    queue = result.catch(() => {})
    return result
  }

  /** Älteste Einträge löschen, wenn zu viele oder zu groß (zuletzt benutzte bleiben) */
  function prune() {
    let entries
    try {
      entries = fs
        .readdirSync(cacheDir)
        .filter((name) => /^[0-9a-f]{20}\.(jpg|png)$/.test(name))
        .map((name) => {
          const stat = fs.statSync(path.join(cacheDir, name))
          return { name, size: stat.size, used: stat.mtimeMs }
        })
        .sort((a, b) => b.used - a.used)
    } catch {
      return
    }
    let bytes = 0
    entries.forEach((entry, index) => {
      bytes += entry.size
      if (index >= maxEntries || bytes > maxBytes) fs.rmSync(path.join(cacheDir, entry.name), { force: true })
    })
  }

  /**
   * Verkleinerte Fassung von `file`, die in w × h passt (Seitenverhältnis bleibt). Ergebnis: Pfad
   * der Fassung oder null, wenn das Original passt bzw. nicht verkleinert werden kann (dann das
   * Original schicken). Animierte GIFs bleiben Original.
   */
  async function scaled(file, size) {
    if (!sharp || !size) return null
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      return null
    }
    if (/\.gif$/i.test(file)) return null
    const key = crypto.createHash('sha1').update(`${file}|${stat.size}|${stat.mtimeMs}|${size.w}x${size.h}|${size.cover ? 'cover' : 'inside'}`).digest('hex').slice(0, 20)
    if (original.has(key)) return null
    for (const ext of ['jpg', 'png']) {
      const hit = path.join(cacheDir, `${key}.${ext}`)
      if (fs.existsSync(hit)) {
        const t = new Date()
        try {
          fs.utimesSync(hit, t, t) // zuletzt benutzt
        } catch {}
        return hit
      }
    }
    return once(key, () =>
      queued(async () => {
        try {
          const meta = await sharp(file).metadata()
          const turned = (meta.orientation || 1) >= 5 // EXIF: hochkant gespeichert
          const width = turned ? meta.height : meta.width
          const height = turned ? meta.width : meta.height
          // Verkleinerung: „Füllen“ muss die Fläche bedecken, sonst muss das Bild ganz hineinpassen
          const scale = width && height ? (size.cover ? Math.max(size.w / width, size.h / height) : Math.min(size.w / width, size.h / height)) : 1
          // Passt schon (und ist kein WebP – das kann Safari 12 nicht) oder animiertes GIF: Original
          if (meta.format === 'gif' || (scale >= 1 && meta.format !== 'webp')) {
            if (original.size > 2000) original.clear()
            original.add(key)
            return null
          }
          // PNG mit Alphakanal, der aber überall deckend ist (so die Slider der Webseite): JPEG, das
          // ist kleiner und dekodiert schneller
          const alpha = meta.hasAlpha === true && !(await sharp(file).stats()).isOpaque
          const out = path.join(cacheDir, `${key}.${alpha ? 'png' : 'jpg'}`)
          const tmp = `${out}.${process.pid}.tmp`
          // rotate(): EXIF-Drehung einrechnen (die Fassung hat keine EXIF-Daten mehr)
          let pipeline = sharp(file).rotate().resize({ width: size.w, height: size.h, fit: size.cover ? 'outside' : 'inside', withoutEnlargement: true })
          // Kein progressives JPEG: das dekodiert ein Pi spürbar langsamer
          pipeline = alpha ? pipeline.png({ compressionLevel: 6 }) : pipeline.flatten({ background: '#000' }).jpeg({ quality: 85, progressive: false, mozjpeg: false })
          await pipeline.toFile(tmp)
          fs.renameSync(tmp, out)
          prune()
          return out
        } catch (err) {
          if (!warned) log(`Diashow: Bild nicht verkleinert (${path.basename(file)}): ${err.message}`)
          warned = true
          original.add(key) // nicht bei jeder Anfrage neu versuchen
          return null
        }
      }),
    )
  }

  /**
   * Bild der Webseite (Slider, z. B. 3840 × 1200) einmal holen und als Datei zwischenspeichern.
   * Ergebnis: Pfad oder null (dann leitet der Server auf die Adresse selbst weiter).
   */
  async function webFile(url) {
    if (!sharp) return null
    const key = crypto.createHash('sha1').update(url).digest('hex').slice(0, 20)
    const known = fs.readdirSync(webDir).find((name) => name.startsWith(`${key}.`) && !name.endsWith('.tmp'))
    if (known) return path.join(webDir, known)
    if (Date.now() - (failed.get(key) || 0) < 5 * 60 * 1000) return null
    return once(`web:${key}`, async () => {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(WEB_TIMEOUT_MS) })
        if (!res.ok) throw new Error(`Fehler ${res.status}`)
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length > WEB_MAX_BYTES) throw new Error('Bild ist zu groß')
        const kind = imageKind(buffer)
        if (!kind) throw new Error('kein Bild')
        // Alte Website-Bilder aufräumen (die Startseite hat selten mehr als zehn)
        const old = fs.readdirSync(webDir).map((name) => ({ name, used: fs.statSync(path.join(webDir, name)).mtimeMs }))
        old.sort((a, b) => b.used - a.used).slice(40).forEach((entry) => fs.rmSync(path.join(webDir, entry.name), { force: true }))
        const out = path.join(webDir, `${key}.${kind}`)
        fs.writeFileSync(`${out}.tmp`, buffer)
        fs.renameSync(`${out}.tmp`, out)
        return out
      } catch (err) {
        log(`Diashow: Bild der Webseite nicht geladen: ${err.message}`)
        failed.set(key, Date.now())
        return null
      }
    })
  }

  return {
    available: Boolean(sharp),
    scaled,
    webFile,
    warnMissing() {
      if (!sharp) log('Diashow: sharp fehlt – Bilder gehen in Originalgröße an die Kacheln')
    },
  }
}

module.exports = { createImageScaler, wantedSize, step, STEPS }
