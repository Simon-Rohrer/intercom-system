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
const { legacyMiddleware } = require('./legacy')

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
  const ppPort = Number(c?.propresenter?.port)
  return {
    atem: {
      ip: String(c?.atem?.ip ?? base.atem.ip).trim(),
      me: Number.isInteger(me) && me >= 0 && me <= 3 ? me : 0,
    },
    propresenter: {
      host: String(c?.propresenter?.host ?? '').trim(),
      port: Number.isInteger(ppPort) && ppPort > 0 && ppPort < 65536 ? ppPort : 1025,
    },
    sources: Array.isArray(c?.sources) ? c.sources : base.sources,
    layouts: Array.isArray(c?.layouts) ? c.layouts : base.layouts,
    outputs: Array.isArray(c?.outputs) ? c.outputs : base.outputs,
    screens: normalizeScreens(c?.screens),
    chat: normalizeChat(c?.chat),
    churchtools: normalizeChurchTools(c?.churchtools),
  }
}

/** Bildschirme am Server: Anschluss (z. B. "HDMI-A-1"), eigener Name und gezeigter Multiview. */
function normalizeScreens(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  return list
    .filter((s) => typeof s?.id === 'string' && s.id && !seen.has(s.id) && seen.add(s.id))
    .map((s) => ({
      id: s.id,
      name: typeof s.name === 'string' ? s.name.trim() : '',
      outputId: typeof s.outputId === 'string' && s.outputId ? s.outputId : null,
    }))
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
// ProPresenter: aktuelle/nächste Folie, Hintergründe und Playlist über die Netzwerk-Schnittstelle
// (ProPresenter → Einstellungen → Netzwerk → „Netzwerk aktivieren“).
// NUR LESEND: Viele Adressen der Schnittstelle lösen bei ProPresenter etwas aus
// (…/trigger, …/focus, /v1/clear/…) – die werden hier nie aufgerufen.
//
// Hintergründe: ProPresenter liefert bei jeder Folie, die einen Hintergrund (Medien-Aktion)
// startet, dessen Namen als Beschriftung (z. B. „illuminate-11“) – auch bei Folien mit Text.
// Ab so einer Folie gilt dieser Hintergrund; Textfolien ohne Beschriftung liegen transparent
// darüber. Als Bild des Hintergrunds dient möglichst eine Folie ohne Text mit diesem Namen.
// ---------------------------------------------------------------------------

const PP_POLL_MS = 400
const PP_PRESENTATION_TTL = 60_000
const PP_PLAYLIST_TTL = 15_000

let ppState = emptyProPresenterState()
let ppTimer = null
let ppTarget = ''
const ppPresentations = new Map() // UUID -> { at, name, cues: [{ text, label }], bg: [Cue-Nummern] }
let ppPlaylistCache = null // { uuid, at, name, items }

function emptyProPresenterState() {
  return {
    connected: false,
    host: '',
    version: null,
    presentation: null, // { uuid, name }
    index: null,
    current: null, // Folientext { text, notes }
    next: null,
    currentSlide: null, // { presentation, cue } – für das Folienbild
    nextSlide: null,
    currentSlideBg: null, // Hintergrund unter der Folie { presentation, cue, label }
    nextSlideBg: null,
    nextBgSlide: null, // nächste Folie, die einen Hintergrund startet { presentation, cue, label, song, text }
    focused: null, // angeklicktes Lied, falls es vom laufenden abweicht { presentation, name, playlistIndex }
    background: { current: null, next: null }, // { presentation, cue, label, song }
    playlist: null, // { name, activeIndex, nextIndex, items: [...] }
    cues: [], // alle Folien der laufenden Präsentation { group, color, label, enabled } – für die Prediger-Ansicht
    layers: null, // was gerade sichtbar ist { slide, media } – „ausgeblendet“ = slide false
  }
}

function ppBase() {
  const { host, port } = config.propresenter
  return host ? `http://${host}:${port}` : ''
}

async function ppGet(path) {
  const res = await fetch(`${ppBase()}${path}`, { signal: AbortSignal.timeout(2500) })
  if (res.status === 204) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

const startsBackground = (cue) => Boolean(cue.label.trim())

/** Folien einer Präsentation (zwischengespeichert) samt Liste der Hintergrund-Cues. */
async function ppPresentation(uuid) {
  const hit = ppPresentations.get(uuid)
  if (hit && Date.now() - hit.at < PP_PRESENTATION_TTL) return hit
  try {
    const data = await ppGet(`/v1/presentation/${encodeURIComponent(uuid)}`)
    const cues = (data?.presentation?.groups ?? []).flatMap((g) =>
      (g.slides ?? []).map((s) => ({
        text: s.text ?? '',
        label: s.label ?? '',
        group: g.name ?? '',
        color: headerColor(g.color),
        enabled: s.enabled !== false,
      })),
    )
    const entry = {
      at: Date.now(),
      name: data?.presentation?.id?.name ?? '',
      cues,
      bg: cues.map((c, i) => (startsBackground(c) ? i : -1)).filter((i) => i >= 0),
    }
    ppPresentations.set(uuid, entry)
    return entry
  } catch {
    return hit ?? null
  }
}

const headerColor = (c) =>
  c ? `rgb(${Math.round(c.red * 255)}, ${Math.round(c.green * 255)}, ${Math.round(c.blue * 255)})` : null

/** Einträge der Playlist (zwischengespeichert), Lieder mit ihrem ersten Hintergrund. */
async function ppPlaylist(uuid) {
  if (ppPlaylistCache?.uuid === uuid && Date.now() - ppPlaylistCache.at < PP_PLAYLIST_TTL) return ppPlaylistCache
  const data = await ppGet(`/v1/playlist/${encodeURIComponent(uuid)}`)
  const items = []
  for (const it of data?.items ?? []) {
    const presentation = it.presentation_info?.presentation_uuid ?? null
    let bg = null
    if (presentation) {
      const info = await ppPresentation(presentation)
      if (info?.bg.length) bg = backgroundRef(presentation, info, info.bg[0])
    }
    items.push({
      index: it.id?.index,
      name: it.id?.name ?? '',
      type: it.type,
      hidden: Boolean(it.is_hidden),
      color: headerColor(it.header_color),
      presentation,
      bg,
    })
  }
  ppPlaylistCache = { uuid, at: Date.now(), name: data?.id?.name ?? '', items }
  return ppPlaylistCache
}

/**
 * Hintergrund, der mit Cue `start` beginnt. `cue` ist das Bild dafür: möglichst eine Folie
 * ohne Text mit demselben Hintergrund, sonst die Startfolie selbst. `start` = wo er beginnt.
 */
function backgroundRef(uuid, info, start) {
  const label = info.cues[start].label.trim()
  const clean = info.cues.findIndex((c) => c.label.trim() === label && !c.text.trim())
  return { presentation: uuid, cue: clean >= 0 ? clean : start, start, label, song: info.name }
}

/** Der Hintergrund, der bei Cue `index` wirkt (letzte Folie davor, die einen startet). */
function backgroundAt(uuid, info, index) {
  let start = null
  for (const c of info?.bg ?? []) if (c <= index) start = c
  return start === null ? null : backgroundRef(uuid, info, start)
}

/** Folie, die einen Hintergrund startet – ihr Vorschaubild enthält den Hintergrund schon. */
function slideRef(uuid, info, cue) {
  return { presentation: uuid, cue, label: info.cues[cue].label.trim(), song: info.name, text: info.cues[cue].text.trim() }
}

/** Hintergrund unter einer Folie – nur nötig, wenn die Folie ihn nicht selbst startet. */
function backgroundUnder(uuid, info, index) {
  if (info?.cues[index] && startsBackground(info.cues[index])) return null
  const bg = backgroundAt(uuid, info, index)
  return bg && bg.cue !== index ? bg : null
}

let ppBusy = false
let ppAgain = false

/** Sofort neu abfragen (z. B. nach einem Tastendruck) – ohne eine zweite Abfrage-Schleife zu starten. */
function requestProPresenterPoll() {
  if (ppBusy) {
    ppAgain = true
    return
  }
  clearTimeout(ppTimer)
  pollProPresenter()
}

async function pollProPresenter() {
  ppTimer = null
  const target = ppBase()
  if (!target) return
  ppBusy = true
  try {
    await pollProPresenterOnce(target)
  } finally {
    ppBusy = false
  }
  if (target !== ppBase()) return // Adresse wurde inzwischen geändert
  const delay = ppAgain ? 0 : ppState.connected ? PP_POLL_MS : 3000
  ppAgain = false
  clearTimeout(ppTimer)
  ppTimer = setTimeout(pollProPresenter, delay)
}

async function pollProPresenterOnce(target) {
  const next = emptyProPresenterState()
  next.host = config.propresenter.host
  try {
    next.version = ppState.connected ? ppState.version : ((await ppGet('/version'))?.host_description ?? null)
    const [slide, slideIndex, active, focusedItem, focusedPresentation, layers] = await Promise.all([
      ppGet('/v1/status/slide'),
      ppGet('/v1/presentation/slide_index'),
      ppGet('/v1/playlist/active'),
      ppGet('/v1/playlist/focused').catch(() => null),
      ppGet('/v1/presentation/focused').catch(() => null),
      ppGet('/v1/status/layers').catch(() => null),
    ])
    next.connected = true
    next.layers = layers ? { slide: Boolean(layers.slide), media: Boolean(layers.media) } : null
    next.current = slide?.current?.uuid || slide?.current?.text ? slide.current : null
    next.next = slide?.next?.uuid || slide?.next?.text ? slide.next : null

    // Playlist mit dem gerade laufenden Eintrag
    const activePlaylist = active?.presentation?.playlist
    if (activePlaylist?.uuid) {
      const playlist = await ppPlaylist(activePlaylist.uuid)
      next.playlist = {
        name: playlist.name || activePlaylist.name,
        activeIndex: active.presentation.item?.index ?? null,
        nextIndex: null,
        focusedIndex: null,
        items: playlist.items,
      }
    }
    const items = next.playlist?.items ?? []
    const songsAfter = (i) => items.filter((it) => it.index > i && it.presentation && !it.hidden).map((it) => it.presentation)

    // Laufende Präsentation
    const pi = slideIndex?.presentation_index
    const liveUuid = pi?.presentation_id?.uuid ?? null
    let info = null
    let index = null
    let total = 0
    if (liveUuid) {
      index = pi.index
      info = await ppPresentation(liveUuid)
      total = pi.total_cues ?? info?.cues.length ?? 0
      next.presentation = { uuid: liveUuid, name: pi.presentation_id.name }
      next.index = index
      next.currentSlide = { presentation: liveUuid, cue: index }
      next.background.current = backgroundAt(liveUuid, info, index)
      next.currentSlideBg = backgroundUnder(liveUuid, info, index)
      next.cues = (info?.cues ?? []).map((c) => ({
        group: c.group,
        color: c.color,
        label: c.label.trim(),
        blank: !c.text.trim(), // Folie ohne Text (z. B. reiner Hintergrund)
        enabled: c.enabled,
      }))
    }

    // Angeklicktes Lied: Klickt der Bediener ein anderes Lied an (z. B. weil eins übersprungen
    // wird), geht es dort weiter – auch wenn davon noch keine Folie läuft.
    const focusedUuid =
      focusedItem?.playlist_item?.presentation_info?.presentation_uuid ?? focusedPresentation?.uuid ?? null
    const focusedIndex =
      focusedItem?.playlist?.uuid && focusedItem.playlist.uuid === activePlaylist?.uuid ? (focusedItem.item?.index ?? null) : null
    const jump = focusedUuid && focusedUuid !== liveUuid ? focusedUuid : null

    // Lieder, in denen es nach dem laufenden weitergeht (in dieser Reihenfolge durchsucht)
    const activeItem = items.find((it) => it.index === next.playlist?.activeIndex)
    let upcoming = []
    if (jump) {
      upcoming = [jump, ...(focusedIndex != null ? songsAfter(focusedIndex) : [])]
      next.focused = { presentation: jump, name: (await ppPresentation(jump))?.name ?? '', playlistIndex: focusedIndex }
      if (next.playlist) next.playlist.focusedIndex = focusedIndex
    } else if (activeItem && activeItem.presentation === liveUuid) {
      upcoming = songsAfter(activeItem.index)
    }
    if (next.playlist) {
      next.playlist.nextIndex = jump
        ? focusedIndex
        : (items.find((it) => it.index > (next.playlist.activeIndex ?? -1) && it.type !== 'header' && !it.hidden)?.index ?? null)
    }

    // Direkt folgende Folie: im laufenden Lied, sonst Anfang des nächsten bzw. angeklickten Lieds
    if (!jump && liveUuid && index + 1 < total) {
      next.nextSlide = { presentation: liveUuid, cue: index + 1 }
      next.nextSlideBg = backgroundUnder(liveUuid, info, index + 1)
    } else if (upcoming.length) {
      next.nextSlide = { presentation: upcoming[0], cue: 0 }
      next.next = null
      next.nextSlideBg = backgroundUnder(upcoming[0], await ppPresentation(upcoming[0]), 0)
    }

    // Nächste Folie mit Hintergrund (Video, Bild, PDF …) und nächster Hintergrund:
    // im laufenden Lied der nächste andere, sonst der erste im nächsten bzw. angeklickten Lied
    const currentLabel = next.background.current?.label
    const inSong =
      !jump && info ? info.bg.find((c) => c > index && info.cues[c].label.trim() !== currentLabel) : undefined
    if (inSong !== undefined) {
      next.nextBgSlide = slideRef(liveUuid, info, inSong)
      next.background.next = backgroundRef(liveUuid, info, inSong)
    } else {
      for (const uuid of upcoming) {
        const songInfo = await ppPresentation(uuid)
        if (songInfo?.bg.length) {
          next.nextBgSlide = slideRef(uuid, songInfo, songInfo.bg[0])
          next.background.next = backgroundRef(uuid, songInfo, songInfo.bg[0])
          break
        }
      }
    }
  } catch (err) {
    if (ppState.connected) console.log(`ProPresenter: Verbindung verloren (${err.message})`)
    next.connected = false
  }
  if (target !== ppBase()) return // Adresse wurde inzwischen geändert
  if (next.connected && !ppState.connected) console.log(`ProPresenter: verbunden (${next.version ?? next.host})`)
  if (JSON.stringify(next) !== JSON.stringify(ppState)) {
    ppState = next
    broadcast({ type: 'propresenter', ...ppState })
  }
}

function applyProPresenter() {
  const target = ppBase()
  if (target === ppTarget) return
  ppTarget = target
  clearTimeout(ppTimer)
  ppPresentations.clear()
  ppPlaylistCache = null
  ppState = emptyProPresenterState()
  broadcast({ type: 'propresenter', ...ppState })
  if (target) pollProPresenter()
}

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

// ---------------------------------------------------------------------------
// Bildschirme am Server: Anschlüsse der Grafikkarte (HDMI, DisplayPort, VGA …).
// Der Kiosk öffnet pro angeschlossenem Monitor output.html?screen=<Anschluss>;
// welcher Multiview dort läuft, steht in config.screens und schaltet live um.
// ---------------------------------------------------------------------------

const DRM_DIR = process.env.DRM_DIR || '/sys/class/drm'
let detectedScreens = [] // { id: 'HDMI-A-1', connected, mode: '1920x1080' }

function readFileTrim(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim()
  } catch {
    return ''
  }
}

function readScreens() {
  let entries = []
  try {
    entries = fs.readdirSync(DRM_DIR)
  } catch {
    return [] // kein Linux oder keine Grafikkarte
  }
  return entries
    .map((entry) => [entry, /^card\d+-(.+)$/.exec(entry)?.[1]])
    .filter(([, id]) => id && !id.startsWith('Writeback'))
    .map(([entry, id]) => {
      const connected = readFileTrim(path.join(DRM_DIR, entry, 'status')) === 'connected'
      const mode = connected ? readFileTrim(path.join(DRM_DIR, entry, 'modes')).split('\n')[0] : ''
      return { id, connected, mode }
    })
    .sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

function refreshScreens() {
  const next = readScreens()
  if (JSON.stringify(next) === JSON.stringify(detectedScreens)) return
  detectedScreens = next
  broadcast({ type: 'screens', screens: detectedScreens })
}

/** Erkannte und eingestellte Bildschirme zusammen (für Companion und /api/state). */
function screenList() {
  const ids = [...new Set([...detectedScreens.map((s) => s.id), ...config.screens.map((s) => s.id)])]
  return ids.map((id) => {
    const detected = detectedScreens.find((s) => s.id === id)
    const saved = config.screens.find((s) => s.id === id)
    return {
      id,
      name: saved?.name || id,
      connected: detected?.connected ?? false,
      outputId: saved?.outputId ?? null,
    }
  })
}

function setScreenOutput(id, outputId) {
  let screen = config.screens.find((s) => s.id === id)
  if (!screen) config.screens.push((screen = { id, name: '', outputId: null }))
  screen.outputId = outputId
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
  applyProPresenter()
  churchTools.datesChanged()
  if (mediamtx.proc) writeMediamtxConfig()
}

// ---------------------------------------------------------------------------
// Layout-Vorlagen: gespeicherte Ansichten, je eine JSON-Datei in data/vorlagen
// ---------------------------------------------------------------------------

const TEMPLATE_DIR = path.join(DATA_DIR, 'vorlagen')

/** Dateiname aus dem Vorlagennamen: "Gottesdienst Sonntag" → "gottesdienst-sonntag" */
function templateId(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function templateFile(id) {
  return path.join(TEMPLATE_DIR, `${id}.json`)
}

/** Nur das Raster und die Kacheln – Name und ID gehören dem Layout, in das geladen wird. */
function normalizeTemplateLayout(l) {
  const int = (v, min, max, fallback) => {
    const n = Number(v)
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback
  }
  return {
    cols: int(l?.cols, 1, 48, 12),
    rows: int(l?.rows, 1, 48, 12),
    gap: int(l?.gap, 0, 40, 4),
    background: typeof l?.background === 'string' ? l.background : '#000000',
    tiles: Array.isArray(l?.tiles) ? l.tiles.filter((t) => t && typeof t === 'object') : [],
  }
}

function readTemplate(id) {
  try {
    const t = JSON.parse(fs.readFileSync(templateFile(id), 'utf8'))
    return { id, name: String(t.name || id), savedAt: t.savedAt || null, layout: normalizeTemplateLayout(t.layout) }
  } catch {
    return null
  }
}

function templateList() {
  let files = []
  try {
    files = fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    // noch keine Vorlagen
  }
  return files
    .map((f) => readTemplate(f.slice(0, -5)))
    .filter(Boolean)
    .map(({ id, name, savedAt, layout }) => ({ id, name, savedAt, tiles: layout.tiles.length }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

function templatesChanged() {
  broadcast({ type: 'templates', templates: templateList() })
}

wss.on('connection', (ws) => {
  send(ws, { type: 'config', config })
  send(ws, { type: 'atem', ...atemState })
  send(ws, { type: 'devices', devices: [...knownDevices] })
  send(ws, { type: 'screens', screens: detectedScreens })
  send(ws, serverInfo())
  send(ws, kesherChat.snapshot())
  send(ws, churchTools.snapshot())
  send(ws, { type: 'propresenter', ...ppState })
  send(ws, { type: 'templates', templates: templateList() })

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
// Alte Browser (z. B. iPad mit iOS 12) bekommen umgeschriebene Dateien, siehe legacy.js
app.use(legacyMiddleware(path.join(__dirname, 'public')))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/config', (req, res) => res.json(config))

// ProPresenter steuern – NUR diese Befehle (Weiter, Zurück, Ausblenden, Einblenden, Folie wählen).
// Alles andere der Schnittstelle bleibt gesperrt.
app.post('/api/propresenter/control', async (req, res) => {
  const base = ppBase()
  if (!base) return res.status(503).json({ ok: false, error: 'ProPresenter nicht eingerichtet' })
  const { action, presentation, index } = req.body || {}
  const cue = Number(index)
  const paths = {
    next: ['/v1/trigger/next'],
    previous: ['/v1/trigger/previous'],
    // Ausblenden: nur die Folie (Text) oder Folie und Hintergrund
    clear: ['/v1/clear/layer/slide'],
    clearAll: ['/v1/clear/layer/slide', '/v1/clear/layer/media'],
    // Wieder einblenden = aktuelle Folie erneut auslösen
    restore: ppState.presentation && ppState.index != null
      ? [`/v1/presentation/${encodeURIComponent(ppState.presentation.uuid)}/${ppState.index}/trigger`]
      : null,
    goto: typeof presentation === 'string' && /^[0-9A-Fa-f-]{36}$/.test(presentation) && Number.isInteger(cue) && cue >= 0
      ? [`/v1/presentation/${encodeURIComponent(presentation)}/${cue}/trigger`]
      : null,
  }[action]
  if (!paths) return res.status(400).json({ ok: false, error: 'Unbekannter oder unvollständiger Befehl' })
  try {
    for (const path of paths) {
      const r = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(3000) })
      if (!r.ok) throw new Error(`ProPresenter antwortet mit HTTP ${r.status}`)
    }
    console.log(`ProPresenter: ${action}${action === 'goto' ? ` Folie ${cue + 1}` : ''} (von ${req.ip})`)
    requestProPresenterPoll() // sofort neuen Stand holen, damit alle Bildschirme gleich nachziehen
    res.json({ ok: true })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

// Folienbilder von ProPresenter weiterreichen (Browser brauchen so nur diesen Server)
app.get('/api/propresenter/thumb/:uuid/:index', async (req, res) => {
  const base = ppBase()
  if (!base) return res.status(503).end()
  const quality = Math.min(Math.max(Number(req.query.q) || 960, 100), 1920)
  // PNG behält die Transparenz der Textfolien, JPEG ist für Hintergründe kleiner
  const format = req.query.fmt === 'png' ? 'png' : 'jpeg'
  try {
    const upstream = await fetch(
      `${base}/v1/presentation/${encodeURIComponent(req.params.uuid)}/thumbnail/${Number(req.params.index)}` +
        `?quality=${quality}&thumbnail_type=${format}`,
      { signal: AbortSignal.timeout(5000) },
    )
    if (!upstream.ok) return res.status(upstream.status).end()
    res.set('Content-Type', upstream.headers.get('content-type') || `image/${format}`)
    res.set('Cache-Control', 'max-age=30')
    res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch {
    res.status(502).end()
  }
})

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

app.get('/api/templates', (req, res) => res.json(templateList()))

app.get('/api/templates/:id', (req, res) => {
  const t = readTemplate(templateId(req.params.id))
  if (!t) return res.status(404).json({ ok: false, error: 'Vorlage nicht gefunden' })
  if (req.query.download !== undefined) {
    res.attachment(`${t.id}.json`)
    return res.send(JSON.stringify({ name: t.name, savedAt: t.savedAt, layout: t.layout }, null, 2))
  }
  res.json(t)
})

// Speichert unter dem Namen; eine Vorlage mit gleichem Namen wird überschrieben.
app.post('/api/templates', (req, res) => {
  const name = String(req.body?.name ?? '').trim()
  const id = templateId(name)
  if (!id) return res.status(400).json({ ok: false, error: 'Bitte einen Namen angeben' })
  if (!Array.isArray(req.body?.layout?.tiles)) return res.status(400).json({ ok: false, error: 'Keine Kacheln in der Vorlage' })
  const data = { name, savedAt: new Date().toISOString(), layout: normalizeTemplateLayout(req.body.layout) }
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true })
  const tmp = `${templateFile(id)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, templateFile(id))
  templatesChanged()
  res.json({ ok: true, id, name })
})

app.delete('/api/templates/:id', (req, res) => {
  try {
    fs.unlinkSync(templateFile(templateId(req.params.id)))
  } catch {
    return res.status(404).json({ ok: false, error: 'Vorlage nicht gefunden' })
  }
  templatesChanged()
  res.json({ ok: true })
})

app.get('/api/state', (req, res) => {
  res.json({
    atem: atemState,
    propresenter: ppState,
    layouts: config.layouts.map((l, i) => ({ nr: i + 1, id: l.id, name: l.name })),
    outputs: config.outputs.map((o, i) => ({
      nr: i + 1,
      id: o.id,
      name: o.name,
      layout: config.layouts.find((l) => l.id === o.layoutId)?.name ?? null,
    })),
    screens: screenList().map((s, i) => ({
      nr: i + 1,
      id: s.id,
      name: s.name,
      connected: s.connected,
      output: config.outputs.find((o) => o.id === s.outputId)?.name ?? null,
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

// Bildschirm am Server auf einen Multiview schalten ("aus" = schwarz)
app.all('/api/screen/:screen/output/:output', (req, res) => {
  const screen = findByRef(screenList(), req.params.screen)
  if (!screen) return res.status(404).json({ ok: false, error: 'Bildschirm nicht gefunden' })
  const off = ['aus', 'off', '0'].includes(req.params.output.toLowerCase())
  const output = off ? null : findByRef(config.outputs, req.params.output)
  if (!off && !output) return res.status(404).json({ ok: false, error: 'Multiview nicht gefunden' })
  setScreenOutput(screen.id, output?.id ?? null)
  configChanged()
  res.json({ ok: true, screen: screen.name, output: output?.name ?? null })
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
  refreshScreens()
  setInterval(refreshScreens, 3000)
  applyAtemIp()
  applyProPresenter()
  startMediamtx()
  kesherChat.start()
  churchTools.start()
})
