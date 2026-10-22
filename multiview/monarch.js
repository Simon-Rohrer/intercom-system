'use strict'

// Matrox Monarch HDX (Encoder für YouTube) über seine HTTP-Steuerung abfragen: sendet der Encoder,
// und kommt am Eingang ein Bild an. Die Monarch antwortet z. B. so:
//   GetStatus       → ENC1:RTMP,ON,ENC2:NONE,DISABLED,NAME:MonarchHDX
//   GetInputStatus  → VIDEO INPUT:1920x1080p, 50 fps (SDI)
// Die gemessene Bitrate gibt sie nicht heraus. Zugangsdaten liegen in monarch.json im Datenordner
// (nur für den Server lesbar); das Passwort geht nie an den Browser zurück.

const fs = require('fs')
const path = require('path')

const POLL_MS = 5000
const TIMEOUT_MS = 3000

/** „ENC1:RTMP,ON,ENC2:NONE,DISABLED,NAME:MonarchHDX“ (HDX) oder „RECORD:READY,STREAM:RTMP,ON,NAME:…“ (HD) */
function parseStatus(raw) {
  const encoders = []
  let name = ''
  for (const part of String(raw || '').trim().split(/,(?=[A-Z][A-Z0-9]*:)/)) {
    const i = part.indexOf(':')
    if (i < 0) continue
    const key = part.slice(0, i).trim().toUpperCase()
    const values = part.slice(i + 1).split(',').map((v) => v.trim().toUpperCase())
    if (key === 'NAME') name = part.slice(i + 1).trim()
    else if (/^ENC\d$/.test(key)) encoders.push({ id: key, mode: values[0] || 'NONE', state: values[1] || 'DISABLED' })
    else if (key === 'STREAM') encoders.push({ id: key, mode: values[0] || 'NONE', state: values[1] || 'DISABLED' })
    else if (key === 'RECORD') encoders.push({ id: key, mode: 'RECORD', state: values[0] || 'DISABLED' })
  }
  return { name, encoders }
}

/** „VIDEO INPUT:1920x1080p, 50 fps (SDI)“ → Auflösung, Bildrate, Anschluss; ohne Auflösung = kein Signal */
function parseInput(raw) {
  const text = String(raw || '').replace(/^[^:]*:/, '').trim()
  const size = /(\d{3,4})\s*x\s*(\d{3,4})\s*([pi])?/i.exec(text)
  const fps = /([\d.,]+)\s*fps/i.exec(text)
  const source = /\(([^)]+)\)/.exec(text)?.[1]?.trim() || ''
  if (!size) return { signal: false, text, source, label: 'kein Signal' }
  const height = Number(size[2])
  const scan = (size[3] || 'p').toLowerCase()
  const rate = fps ? Number(fps[1].replace(',', '.')) : null
  return {
    signal: true,
    text,
    source,
    width: Number(size[1]),
    height,
    scan,
    fps: rate,
    label: `${source ? `${source} ` : ''}${height}${scan}${rate != null ? String(rate).replace('.', ',') : ''}`,
  }
}

function createMonarch({ dataDir, log = () => {}, fetchImpl = fetch, now = Date.now }) {
  const file = path.join(dataDir, 'monarch.json')
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  let settings = read()
  let state = settings?.host ? 'connecting' : 'unconfigured'
  let error = ''
  let name = ''
  let encoders = []
  let input = null
  let at = null
  let timer = null
  let running = false

  async function command(cmd) {
    const auth = Buffer.from(`${settings.user || 'admin'}:${settings.password ?? 'admin'}`).toString('base64')
    let res
    try {
      res = await fetchImpl(`http://${settings.host}/Monarch/syncconnect/sdk.aspx?command=${encodeURIComponent(cmd)}`, {
        headers: { Authorization: `Basic ${auth}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new Error(err.name === 'TimeoutError' ? 'Monarch antwortet nicht' : 'Monarch nicht erreichbar')
    }
    if (res.status === 401) throw new Error('Monarch lehnt die Anmeldung ab (Benutzer/Passwort prüfen)')
    if (!res.ok) throw new Error(`Monarch antwortet mit Fehler ${res.status}`)
    const text = (await res.text()).trim()
    if (text === 'RETRY') return null // beschäftigt – beim nächsten Mal wieder
    if (text === 'FAILED') throw Object.assign(new Error(`Monarch kennt ${cmd} nicht`), { failed: true })
    return text
  }

  async function poll() {
    if (!settings?.host) {
      state = 'unconfigured'
      return
    }
    try {
      const status = await command('GetStatus')
      if (status != null) ({ name, encoders } = parseStatus(status))
      const rawInput = await command('GetInputStatus').catch((err) => {
        if (err.failed) return undefined
        throw err
      })
      if (rawInput !== null) input = rawInput === undefined ? null : parseInput(rawInput)
      if (state !== 'ok') log(`Monarch: verbunden (${name || settings.host})`)
      state = 'ok'
      error = ''
      at = now()
    } catch (err) {
      if (state !== 'error' || error !== err.message) log(`Monarch: ${err.message}`)
      state = 'error'
      error = err.message
    }
  }

  function schedule(ms) {
    clearTimeout(timer)
    if (running) timer = setTimeout(async () => {
      await poll()
      schedule(POLL_MS)
    }, ms)
  }

  /** Der Encoder, der zu YouTube sendet: der mit RTMP (sonst der erste, der läuft) */
  function streamEncoder() {
    return encoders.find((e) => e.mode === 'RTMP') || encoders.find((e) => e.state === 'ON' && e.mode !== 'RECORD') || null
  }

  /** Für die YouTube-Kachel und die Störungsmeldungen */
  function snapshot() {
    if (state === 'unconfigured') return { state: 'unconfigured' }
    if (state !== 'ok') return { state, error, name }
    const enc = streamEncoder()
    return {
      state: !enc ? 'disabled' : enc.state === 'ON' ? 'streaming' : enc.state === 'READY' ? 'ready' : 'disabled',
      name,
      encoder: enc ? enc.id.replace(/^ENC/, 'Encoder ') : '',
      mode: enc?.mode || '',
      input,
      at,
    }
  }

  return {
    start() {
      if (running) return
      running = true
      schedule(0)
    },
    stop() {
      running = false
      clearTimeout(timer)
    },
    snapshot,
    poll,
    /** Für die Einstellungen (nur Admin) – ohne Passwort */
    settings() {
      return { configured: Boolean(settings?.host), host: settings?.host || '', user: settings?.user || 'admin', passwordSet: settings?.password != null, ...snapshot(), encoders }
    },
    /** Zugang speichern und gleich prüfen; leeres Passwort = bisheriges behalten */
    async configure({ host, user, password }) {
      const h = String(host ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
      if (!/^[\w.-]+(:\d+)?$/.test(h)) throw new Error('Adresse der Monarch fehlt, z. B. 192.168.0.30')
      const pw = String(password ?? '')
      settings = { host: h, user: String(user ?? '').trim() || 'admin', password: pw || (settings?.host ? settings.password : undefined) }
      fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(settings, null, 2), { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
      state = 'connecting'
      await poll()
      schedule(POLL_MS)
      return this.settings()
    },
    disconnect() {
      try {
        fs.unlinkSync(file)
      } catch {
        // gab es nicht
      }
      settings = null
      state = 'unconfigured'
      error = ''
      encoders = []
      input = null
    },
  }
}

module.exports = { createMonarch, parseStatus, parseInput }
