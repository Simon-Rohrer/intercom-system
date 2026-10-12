'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { spawn } = require('child_process')
const express = require('express')
const { WebSocketServer } = require('ws')
const { Atem } = require('atem-connection')
const { createKesherChat } = require('./kesher-chat')
const { createChurchTools } = require('./churchtools')

const PORT = Number(process.env.PORT) || 8090
// Hinter Caddy (HTTPS) nur lokal lauschen: HOST=127.0.0.1
const HOST = process.env.HOST || undefined
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const CONFIG_FILE = path.join(DATA_DIR, 'config.json')

// ---------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------

function defaultConfig() {
  const quad = [
    { x: 0, y: 0 }, { x: 6, y: 0 },
    { x: 0, y: 6 }, { x: 6, y: 6 },
  ]
  return {
    atem: { ip: '192.168.10.240', me: 0 },
    sources: [1, 2, 3, 4].map((i) => ({
      id: `src${i}`,
      name: `Kamera ${i}`,
      type: 'test',
      device: '',
      url: '',
      atemInput: i,
      useAtemName: true,
    })),
    layouts: [
      {
        id: 'quad',
        name: 'Quad',
        cols: 12,
        rows: 12,
        gap: 4,
        background: '#000000',
        tiles: quad.map((p, i) => ({
          id: `t${i + 1}`,
          kind: 'source',
          sourceId: `src${i + 1}`,
          x: p.x, y: p.y, w: 6, h: 6,
          showLabel: true, showTally: true, fit: 'contain', label: '', text: '',
        })),
      },
    ],
    outputs: [{ id: 'out1', name: 'Multiview 3', layoutId: 'quad' }],
    chat: defaultChat(),
  }
}

/** Kesher-Chat für Chat-Kacheln: Adresse, Anmeldename und Rolle der Anzeige. */
function defaultChat() {
  return {
    url: process.env.KESHER_URL || 'http://127.0.0.1:8080',
    username: process.env.KESHER_USERNAME || 'Chat-Monitor',
    roleId: process.env.KESHER_ROLE_ID || 'chat-monitor',
  }
}

/** "192.168.0.21:8080" → "http://192.168.0.21:8080" */
function withScheme(url) {
  return /^https?:\/\//i.test(url) ? url : `http://${url}`
}

function normalizeChat(c) {
  const base = defaultChat()
  const text = (v, fallback) => (typeof v === 'string' && v.trim() ? v.trim() : fallback)
  return {
    url: withScheme(text(c?.url, base.url)).replace(/\/+$/, ''),
    username: text(c?.username, base.username),
    roleId: text(c?.roleId, base.roleId),
  }
}

function normalizeConfig(c) {
  const base = defaultConfig()
  const me = Number(c?.atem?.me)
  return {
    atem: {
      ip: String(c?.atem?.ip ?? base.atem.ip).trim(),
      me: Number.isInteger(me) && me >= 0 && me <= 3 ? me : 0,
    },
    sources: Array.isArray(c?.sources) ? c.sources : base.sources,
    layouts: Array.isArray(c?.layouts) ? c.layouts : base.layouts,
    outputs: Array.isArray(c?.outputs) ? c.outputs : base.outputs,
    chat: normalizeChat(c?.chat),
    churchtools: normalizeChurchTools(c?.churchtools),
  }
}

/** Nur Einstellungen ohne Geheimnisse – der Login-Token liegt in data/churchtools-secret.json. */
function normalizeChurchTools(c) {
  const tz = typeof c?.timeZone === 'string' && c.timeZone.trim() ? c.timeZone.trim() : process.env.TZ || 'Europe/Berlin'
  return { timeZone: tz }
}

function loadConfig() {
  try {
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')))
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Konfiguration konnte nicht gelesen werden:', err.message)
    return defaultConfig()
  }
}

function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
  fs.renameSync(tmp, CONFIG_FILE)
}

let config = loadConfig()

/** Findet einen Eintrag per ID, Name (ohne Groß-/Kleinschreibung) oder 1-basierter Nummer. */
function findByRef(list, ref) {
  const r = String(ref).trim()
  const byId = list.find((x) => x.id === r)
  if (byId) return byId
  const byName = list.find((x) => String(x.name).toLowerCase() === r.toLowerCase())
  if (byName) return byName
  const n = Number(r)
  return Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined
}

// ---------------------------------------------------------------------------
// ATEM-Verbindung (Tally + Quellennamen)
// ---------------------------------------------------------------------------

const atem = new Atem()
let atemIp = null
let atemState = emptyAtemState()

function emptyAtemState() {
  return { connected: false, ip: atemIp, model: null, program: [], preview: [], inputs: {}, audioInputs: [] }
}

async function applyAtemIp() {
  const ip = config.atem.ip
  if (ip === atemIp) return
  atemIp = ip
  try {
    await atem.disconnect()
  } catch {
    // war nicht verbunden
  }
  atemState = emptyAtemState()
  broadcast({ type: 'atem', ...atemState })
  if (!ip) return
  console.log(`ATEM: verbinde mit ${ip} …`)
  atem.connect(ip).catch((err) => console.error('ATEM:', err.message))
}

function refreshAtemState() {
  const s = atem.state
  const next = emptyAtemState()
  next.connected = atem.status === 2 // AtemConnectionStatus.CONNECTED
  if (s && next.connected) {
    next.model = s.info?.productIdentifier ?? null
    const me = Math.min(config.atem.me, Math.max(s.video.mixEffects.length - 1, 0))
    try {
      next.program = atem.listVisibleInputs('program', me)
      next.preview = atem.listVisibleInputs('preview', me)
    } catch {
      const m = s.video.mixEffects[me]
      next.program = m ? [m.programInput] : []
      next.preview = m ? [m.previewInput] : []
    }
    for (const [id, input] of Object.entries(s.inputs)) {
      if (input) next.inputs[id] = { shortName: input.shortName, longName: input.longName }
    }
    next.audioInputs = Object.keys(s.fairlight?.inputs ?? {}).map(Number)
  }
  if (JSON.stringify(next) !== JSON.stringify(atemState)) {
    atemState = next
    broadcast({ type: 'atem', ...atemState })
  }
}

atem.on('connected', () => {
  console.log(`ATEM: verbunden (${atem.state?.info?.productIdentifier ?? 'unbekanntes Modell'})`)
  refreshAtemState()
  // Pegel anfordern (nur bei Fairlight-Audio; der ATEM schickt sie dann nur an diese Verbindung)
  if (atem.state?.fairlight) {
    atem.startFairlightMixerSendLevels().catch((err) => console.error('ATEM-Pegel:', err.message))
  }
})
atem.on('disconnected', () => {
  console.log('ATEM: Verbindung getrennt')
  audioLevels.inputs.clear()
  audioLevels.master = null
  refreshAtemState()
})
atem.on('stateChanged', refreshAtemState)
atem.on('error', (err) => console.error('ATEM-Fehler:', err))

// ---------------------------------------------------------------------------
// Audiopegel: Der ATEM schickt sehr viele Einzelmeldungen (über 1000/s).
// Wir merken uns jeweils den letzten Wert und verteilen 15-mal pro Sekunde.
// Werte in dB (ATEM liefert Hundertstel dB, -100 dB = Stille).
// ---------------------------------------------------------------------------

const audioLevels = { inputs: new Map(), master: null, dirty: false }

atem.on('levelChanged', (l) => {
  if (l.type === 'master') {
    audioLevels.master = [l.levels.leftLevel, l.levels.rightLevel]
  } else {
    // Ein Eingang kann aus mehreren Quellen bestehen (z. B. getrennte Mono-Kanäle)
    let sources = audioLevels.inputs.get(l.index)
    if (!sources) audioLevels.inputs.set(l.index, (sources = new Map()))
    // Pegel vor dem Fader: zeigt, ob Ton anliegt, auch wenn der Kanal nicht im Mix ist
    sources.set(String(l.source), [l.levels.inputLeftLevel, l.levels.inputRightLevel])
  }
  audioLevels.dirty = true
})

setInterval(() => {
  if (!audioLevels.dirty || !atemState.connected) return
  audioLevels.dirty = false
  const inputs = {}
  for (const [index, sources] of audioLevels.inputs) {
    let left = -10000
    let right = -10000
    for (const [l, r] of sources.values()) {
      left = Math.max(left, l)
      right = Math.max(right, r)
    }
    inputs[index] = [left / 100, right / 100]
  }
  const master = audioLevels.master && audioLevels.master.map((v) => v / 100)
  broadcast({ type: 'levels', inputs, master })
}, 66)

// ---------------------------------------------------------------------------
// MediaMTX: empfängt Netzwerk-Streams (RTSP/RTMP/SRT) und gibt sie als WebRTC
// an die Browser weiter. Läuft als Unterprozess, wenn das Programm in ./bin liegt.
// ---------------------------------------------------------------------------

const MEDIAMTX_BIN =
  process.env.MEDIAMTX_BIN || path.join(__dirname, 'bin', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx')
const MEDIAMTX_CONF = path.join(DATA_DIR, 'mediamtx.yml')
const STREAM_PORTS = { rtmp: 1935, rtsp: 8554, srt: 8890, webrtcHttp: 8889, webrtcUdp: 8189 }

const mediamtx = { proc: null, status: 'stopped', message: '', conf: '', stopping: false }

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address)
}

// Ändert sich bei jedem Start; Monitor-Seiten laden dann den neuen Stand.
const BOOT_ID = `${Date.now()}`

function serverInfo() {
  return {
    type: 'server',
    bootId: BOOT_ID,
    addresses: lanAddresses(),
    ports: STREAM_PORTS,
    mediamtx: { status: mediamtx.status, message: mediamtx.message },
  }
}

function setMediamtxStatus(status, message = '') {
  mediamtx.status = status
  mediamtx.message = message
  broadcast(serverInfo())
}

/** Pfadname in MediaMTX für eine Stream-Quelle (= Stream-Name beim Senden). */
function streamPath(source) {
  return String(source.id).replace(/[^A-Za-z0-9_-]/g, '_')
}

function mediamtxConfig() {
  const lines = [
    '# Wird vom Multiview-Server automatisch erzeugt – Änderungen werden überschrieben.',
    `logLevel: ${process.env.MEDIAMTX_LOG || 'warn'}`,
    'rtsp: yes',
    `rtspAddress: :${STREAM_PORTS.rtsp}`,
    'rtmp: yes',
    `rtmpAddress: :${STREAM_PORTS.rtmp}`,
    'srt: yes',
    `srtAddress: :${STREAM_PORTS.srt}`,
    'hls: no',
    'moq: no',
    'webrtc: yes',
    // Die Signalisierung läuft über den Multiview-Server (/whep), darum nur lokal.
    `webrtcAddress: 127.0.0.1:${STREAM_PORTS.webrtcHttp}`,
    `webrtcLocalUDPAddress: :${STREAM_PORTS.webrtcUdp}`,
  ]
  const streams = config.sources.filter((s) => s.type === 'stream')
  if (!streams.length) {
    lines.push('paths: {}')
  } else {
    lines.push('paths:')
    for (const s of streams) {
      const url = String(s.url || '').trim()
      lines.push(`  ${streamPath(s)}:`)
      if (url) {
        // Stream von einer Adresse holen (z. B. rtsp://… vom Monarch), nur solange jemand zuschaut
        lines.push(`    source: ${JSON.stringify(url)}`, '    sourceOnDemand: yes')
      } else {
        // Auf eingehenden Stream warten (z. B. RTMP vom Monarch)
        lines.push('    source: publisher')
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/** Schreibt die Konfiguration neu, wenn sie sich geändert hat (MediaMTX lädt sie dann selbst neu). */
function writeMediamtxConfig() {
  const text = mediamtxConfig()
  if (text === mediamtx.conf) return
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(MEDIAMTX_CONF, text)
  mediamtx.conf = text
}

function startMediamtx() {
  if (!fs.existsSync(MEDIAMTX_BIN)) {
    setMediamtxStatus('missing', `MediaMTX nicht gefunden (${MEDIAMTX_BIN})`)
    return
  }
  writeMediamtxConfig()
  const proc = spawn(MEDIAMTX_BIN, [MEDIAMTX_CONF], { cwd: DATA_DIR, stdio: ['ignore', 'pipe', 'pipe'] })
  mediamtx.proc = proc
  setMediamtxStatus('running')

  const log = (chunk) => {
    for (const line of chunk.toString().split('\n').filter(Boolean)) {
      console.log(`MediaMTX: ${line}`)
      if (/ERR/.test(line)) mediamtx.message = line.replace(/^\S+ \S+ /, '')
    }
  }
  proc.stdout.on('data', log)
  proc.stderr.on('data', log)
  proc.on('error', (err) => setMediamtxStatus('error', err.message))
  proc.on('exit', (code) => {
    mediamtx.proc = null
    if (mediamtx.stopping) return
    setMediamtxStatus('error', mediamtx.message || `MediaMTX beendet (Code ${code}) – Neustart …`)
    setTimeout(startMediamtx, 3000)
  })
}

function stopMediamtx() {
  mediamtx.stopping = true
  mediamtx.proc?.kill()
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopMediamtx()
    kesherChat.stop()
    churchTools.stop()
    // kurz warten, damit die Abmeldung bei Kesher die Rolle freigibt
    setTimeout(() => process.exit(0), 500)
  })
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })
const knownDevices = new Set()

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg))
}

function broadcast(msg) {
  const data = JSON.stringify(msg)
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data)
}

const churchTools = createChurchTools({
  dataDir: DATA_DIR,
  getConfig: () => config.churchtools,
  // Fest gewählte Tage aller ChurchTools-Kacheln
  getDates: () =>
    config.layouts.flatMap((l) => l.tiles.filter((t) => t.kind === 'churchtools' && t.ctDate).map((t) => t.ctDate)),
  onUpdate: broadcast,
  log: console.log,
})

const kesherChat = createKesherChat({
  getConfig: () => config.chat,
  onUpdate: broadcast,
  onFlash: broadcast,
  log: console.log,
})

function configChanged(origin = null) {
  saveConfig()
  broadcast({ type: 'config', config, origin })
  refreshAtemState()
  applyAtemIp()
  kesherChat.reconfigure()
  churchTools.datesChanged()
  if (mediamtx.proc) writeMediamtxConfig()
}

wss.on('connection', (ws) => {
  send(ws, { type: 'config', config })
  send(ws, { type: 'atem', ...atemState })
  send(ws, { type: 'devices', devices: [...knownDevices] })
  send(ws, serverInfo())
  send(ws, kesherChat.snapshot())
  send(ws, churchTools.snapshot())

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    // Ausgabe-Seiten melden die Videogeräte, die auf ihrem Rechner verfügbar sind.
    if (msg.type === 'devices' && Array.isArray(msg.devices)) {
      let added = false
      for (const d of msg.devices) {
        if (typeof d === 'string' && d && !knownDevices.has(d)) {
          knownDevices.add(d)
          added = true
        }
      }
      if (added) broadcast({ type: 'devices', devices: [...knownDevices] })
    }
  })
})

app.use(express.json({ limit: '5mb' }))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/config', (req, res) => res.json(config))

// Zustand der Kesher-Chat-Verbindung (zur Fehlersuche)
app.get('/api/chat', (req, res) => res.json(kesherChat.snapshot()))

// ChurchTools: Verbindung mit dem Server-Konto (Token oder Benutzername/Passwort).
// Das Passwort wird nur zum Holen des Login-Tokens benutzt und nicht gespeichert.
app.get('/api/churchtools', (req, res) => res.json(churchTools.snapshot()))
app.post('/api/churchtools/connect', async (req, res) => {
  try {
    const { url, token, username, password } = req.body || {}
    res.json({ ok: true, ...(await churchTools.connect({ url, token, username, password })) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})
app.post('/api/churchtools/disconnect', (req, res) => {
  churchTools.disconnect()
  res.json({ ok: true })
})
app.post('/api/churchtools/refresh', async (req, res) => {
  await churchTools.refresh()
  res.json(churchTools.snapshot())
})

// WebRTC-Anmeldung (WHEP) an MediaMTX weiterreichen, damit Browser nur diesen Port brauchen
app.post('/whep/:path', express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
  if (!mediamtx.proc) return res.status(503).send('MediaMTX läuft nicht')
  try {
    const upstream = await fetch(
      `http://127.0.0.1:${STREAM_PORTS.webrtcHttp}/${encodeURIComponent(req.params.path)}/whep`,
      { method: 'POST', headers: { 'Content-Type': 'application/sdp' }, body: req.body },
    )
    res
      .status(upstream.status)
      .type(upstream.headers.get('content-type') || 'text/plain')
      .send(await upstream.text())
  } catch (err) {
    res.status(502).send(`MediaMTX nicht erreichbar: ${err.message}`)
  }
})

app.put('/api/config', (req, res) => {
  config = normalizeConfig(req.body)
  configChanged(req.get('X-Client-Id') || null)
  res.json({ ok: true })
})

app.get('/api/state', (req, res) => {
  res.json({
    atem: atemState,
    layouts: config.layouts.map((l, i) => ({ nr: i + 1, id: l.id, name: l.name })),
    outputs: config.outputs.map((o, i) => ({
      nr: i + 1,
      id: o.id,
      name: o.name,
      layout: config.layouts.find((l) => l.id === o.layoutId)?.name ?? null,
    })),
  })
})

// Companion-freundliche Endpunkte (GET oder POST, z. B. über das "Generic HTTP"-Modul)

app.all('/api/output/:output/layout/:layout', (req, res) => {
  const output = findByRef(config.outputs, req.params.output)
  const layout = findByRef(config.layouts, req.params.layout)
  if (!output) return res.status(404).json({ ok: false, error: 'Ausgang nicht gefunden' })
  if (!layout) return res.status(404).json({ ok: false, error: 'Layout nicht gefunden' })
  output.layoutId = layout.id
  configChanged()
  res.json({ ok: true, output: output.name, layout: layout.name })
})

app.all('/api/output/:output/:dir(next|prev)', (req, res) => {
  const output = findByRef(config.outputs, req.params.output)
  if (!output) return res.status(404).json({ ok: false, error: 'Ausgang nicht gefunden' })
  if (!config.layouts.length) return res.status(404).json({ ok: false, error: 'Keine Layouts vorhanden' })
  const step = req.params.dir === 'next' ? 1 : -1
  const current = config.layouts.findIndex((l) => l.id === output.layoutId)
  const layout = config.layouts[(current + step + config.layouts.length) % config.layouts.length]
  output.layoutId = layout.id
  configChanged()
  res.json({ ok: true, output: output.name, layout: layout.name })
})

app.all('/api/layout/:layout/tile/:tile/source/:source', (req, res) => {
  const layout = findByRef(config.layouts, req.params.layout)
  const tile = layout && findByRef(layout.tiles, req.params.tile)
  const source = findByRef(config.sources, req.params.source)
  if (!tile) return res.status(404).json({ ok: false, error: 'Layout oder Kachel nicht gefunden' })
  if (!source) return res.status(404).json({ ok: false, error: 'Quelle nicht gefunden' })
  tile.kind = 'source'
  tile.sourceId = source.id
  configChanged()
  res.json({ ok: true, layout: layout.name, source: source.name })
})

server.listen(PORT, HOST, () => {
  console.log('Multiview Builder läuft:')
  console.log(`  Webseite: http://localhost:${PORT}/`)
  for (const a of lanAddresses()) console.log(`            http://${a}:${PORT}/`)
  console.log(`  Monitor:  http://localhost:${PORT}/output.html?id=1`)
  applyAtemIp()
  startMediamtx()
  kesherChat.start()
  churchTools.start()
})
