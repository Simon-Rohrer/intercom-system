'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')
const { spawn } = require('child_process')
const express = require('express')
const { WebSocketServer } = require('ws')
const { Atem } = require('atem-connection')
const { createKesherChat } = require('./kesher-chat')
const { createKesherRoles } = require('./kesher-roles')
const { createNeighbors } = require('./neighbors')
const { normalizeRaspberry, parsePiRequest, createPiRegistry } = require('./raspberry-pis')
const { createChurchTools } = require('./churchtools')
const { createUplink, normalizeUplink } = require('./uplink')
const { createYouTube } = require('./youtube')
const { createMonarch } = require('./monarch')
const { createDropbox } = require('./dropbox')
const { createSlideshow } = require('./slideshow')
const { createMessageLinks } = require('./message-links')
const QRCode = require('qrcode')
const { normalizeDayQr, normalizeOutputDayQr } = require('./day-qr')
const { createSsoHandlers, createSocketGuard, proxyWebSocket, sameOriginRequest, machineRequest, nativeMachineRequest, withoutOwnCookies, safePath, verifySignedRequest, DEFAULT_ORIGINS } = require('./auth-http')
const { viewConfig, filterMessage, stationLauncherConfig } = require('./auth-permissions')
const { deviceAssertion, startSatelliteBridge } = require('./device-transport')
const {
  createAccess, normalizeAccess, roleRights, allowedOutputs, editableOutputs, visibleLayouts, canEditLayout, applyRestrictedChanges, claimLayouts, ADMIN,
  SERVICE_LEVELS,
} = require('./access')

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
    outputs: [{ id: 'out1', name: 'Multiview 3', layoutId: 'quad', dayQr: { show: false, corner: 'br', size: 's' } }],
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
    outputs: normalizeOutputDayQr(Array.isArray(c?.outputs) ? c.outputs : base.outputs, c?.dayQr),
    screens: normalizeScreens(c?.screens),
    chat: normalizeChat(c?.chat),
    churchtools: normalizeChurchTools(c?.churchtools),
    uplink: normalizeUplink(c?.uplink),
    access: normalizeAccess(c?.access),
    raspberry: normalizeRaspberry(c?.raspberry),
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
      // Monitor hochkant aufgehängt: Bild um 90° bzw. 270° drehen (0 = normal)
      rotate: [90, 270].includes(Number(s.rotate)) ? Number(s.rotate) : 0,
    }))
}

/** Nur Einstellungen ohne Geheimnisse – der Login-Token liegt in data/churchtools-secret.json. */
function normalizeChurchTools(c) {
  const tz = typeof c?.timeZone === 'string' && c.timeZone.trim() ? c.timeZone.trim() : process.env.TZ || 'Europe/Berlin'
  return { timeZone: tz }
}

function loadConfig() {
  let stored
  try {
    stored = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') throw err // Beschädigte Daten niemals durch Standardwerte ersetzen.
    return normalizeConfig(defaultConfig())
  }
  // Einmalige Übernahme der bisherigen globalen Anzeige, ohne andere Daten zu ändern.
  if (Object.hasOwn(stored, 'dayQr') || stored.outputs?.some((output) => !output.dayQr)) {
    stored.outputs = normalizeOutputDayQr(stored.outputs || [], normalizeDayQr(stored.dayQr, { show: true, corner: 'br', size: 'm' }))
    delete stored.dayQr
    const tmp = `${CONFIG_FILE}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(stored, null, 2))
    fs.renameSync(tmp, CONFIG_FILE)
  }
  return normalizeConfig(stored)
}


function saveConfig() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${CONFIG_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
  fs.renameSync(tmp, CONFIG_FILE)
}

let config = loadConfig()
rememberLayouts()

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
const ppPlaylistCache = new Map() // uuid → { uuid, at, name, items }

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
    playlist: null, // { uuid, name, activeIndex, nextIndex, items: [...] }
    playlists: {}, // feste Playlists der Kachel „Playlist“: uuid → { name, items }
    songs: {}, // Folien der Lieder für „Alle Folien“: Präsentation → [{ group, color, label, enabled }]
    cues: [], // alle Folien der laufenden Präsentation { group, color, label, enabled } – für die Prediger-Ansicht
    layers: null, // was gerade sichtbar ist { slide, media } – „ausgeblendet“ = slide false
    // Ausgeblendet meldet ProPresenter keine laufende Präsentation mehr. Damit die Prediger-Ansicht
    // die Folien behält und „Einblenden“ weiß, wohin, merken wir uns die letzte: { presentation, index, cues }
    held: null,
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
  const hit = ppPlaylistCache.get(uuid)
  if (hit && Date.now() - hit.at < PP_PLAYLIST_TTL) return hit
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
  const entry = { uuid, at: Date.now(), name: data?.id?.name ?? '', items }
  ppPlaylistCache.set(uuid, entry)
  return entry
}

/** Welche Playlists und Folien die Kacheln „Playlist“ brauchen (feste Playlist, Ansicht „Alle Folien“) */
function playlistWants() {
  const fixed = new Set()
  const slides = new Set() // '' = aktive Playlist
  for (const layout of config.layouts || [])
    for (const tile of layout.tiles || []) {
      if (tile.kind !== 'playlist') continue
      const source = typeof tile.playlist?.source === 'string' ? tile.playlist.source : ''
      if (source) fixed.add(source)
      if (tile.playlist?.view === 'slides' || tile.playlist?.view === 'show') slides.add(source)
    }
  return { fixed, slides }
}

/** Alle Playlists von ProPresenter (Ordner aufgelöst) – für die Auswahl im Editor */
function flattenPpPlaylists(list, out = []) {
  for (const entry of Array.isArray(list) ? list : []) {
    if (entry?.field_type === 'playlist' && entry.id?.uuid) out.push({ uuid: entry.id.uuid, name: String(entry.id.name || '') })
    if (Array.isArray(entry?.children)) flattenPpPlaylists(entry.children, out)
  }
  return out
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
        uuid: activePlaylist.uuid,
        name: playlist.name || activePlaylist.name,
        activeIndex: active.presentation.item?.index ?? null,
        nextIndex: null,
        focusedIndex: null,
        items: playlist.items,
      }
    }
    // Feste Playlists und die Folien der Lieder für die Kachel „Playlist“
    const want = playlistWants()
    for (const uuid of want.fixed) {
      try {
        const playlist = await ppPlaylist(uuid)
        next.playlists[uuid] = { name: playlist.name, items: playlist.items }
      } catch {
        next.playlists[uuid] = { name: '', items: [], missing: true }
      }
    }
    const songUuids = new Set()
    for (const source of want.slides)
      for (const it of (source ? next.playlists[source]?.items : next.playlist?.items) ?? []) if (it.presentation && it.type !== 'header') songUuids.add(it.presentation)
    for (const uuid of songUuids) {
      const info = await ppPresentation(uuid)
      if (info) next.songs[uuid] = info.cues.map((c) => ({ group: c.group, color: c.color, label: c.label.trim(), enabled: c.enabled }))
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

    // Ausgeblendet (Folien-Ebene aus, keine laufende Präsentation): letzte Präsentation behalten
    if (!liveUuid && next.layers && !next.layers.slide) {
      const last = ppState.presentation
        ? { presentation: ppState.presentation, index: ppState.index, cues: ppState.cues }
        : ppState.held
      if (last) next.held = last
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
  if (next.connected && !ppState.connected) {
    console.log(`ProPresenter: verbunden (${next.version ?? next.host})`)
    slideshow.ppReachable()
  }
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
  ppPlaylistCache.clear()
  ppState = emptyProPresenterState()
  broadcast({ type: 'propresenter', ...ppState })
  clearTimeout(stageTimer)
  stageState = emptyStageState()
  broadcast({ type: 'ppstage', ...stageState })
  if (target) {
    pollProPresenter()
    requestStagePoll()
  }
}

// ---------------------------------------------------------------------------
// ProPresenter-Bühne: Bühnennachricht, Timer (Countdowns), Video-Countdown und laufende
// Meldungen. Eigene Nachricht "ppstage", weil sich die Zeiten jede Sekunde ändern –
// sonst ginge jedes Mal der ganze Folien-Zustand samt Playlist an alle Bildschirme.
// Lesend; geschrieben wird nur die Bühnennachricht (setStageMessage).
// ---------------------------------------------------------------------------

const STAGE_POLL_MS = 500
const STAGE_MESSAGES_MS = 3000 // Meldungen ändern sich selten

let stageState = emptyStageState()
let stageTimer = null
let stageBusy = false
let stageAgain = false
let stageMessagesAt = 0

function emptyStageState() {
  return {
    connected: false,
    message: '', // Bühnennachricht
    timers: [], // { uuid, name, time: "-00:01:30", state: running|stopped|overrunning|complete }
    videoCountdown: '', // Restzeit des laufenden Videos, leer = kein Video
    messages: [], // aktive Meldungen { uuid, name, text, tokens: [{ name, timer }] }
    templates: [], // Meldungen für den Beamer zum Vorbereiten { uuid, name, text, fields: [Name] }
    requests: [], // Beamer-Meldungen, die auf den ProPresenter-Bediener warten (announceRequests)
  }
}

/** Aktive Meldungen; Platzhalter wie {Countdown 1} füllt der Browser mit der Timer-Zeit. */
function activeMessages(list) {
  return list
    .filter((m) => m.is_active)
    .map((m) => ({
      uuid: m.id?.uuid ?? '',
      name: m.id?.name ?? '',
      text: String(m.message ?? '').trim(),
      tokens: (m.tokens ?? []).map((t) => ({ name: t.name, timer: t.timer?.id?.uuid ?? null, text: t.text?.text ?? '' })),
    }))
}

/**
 * Meldungen, die man vom Handy aus für den Beamer vorbereiten kann: Text, nur Text-Platzhalter.
 * Alles unter einer Trennzeile „ARCHIV“ (in ProPresenter) bleibt weg – außer der eigenen Meldung.
 */
function messageTemplates(list) {
  const archive = list.findIndex((m) => /archiv/i.test(m.id?.name ?? ''))
  return list
    .filter((m, i) => archive < 0 || i < archive || m.id?.name === FREE_MESSAGE_NAME)
    .filter((m) => String(m.message ?? '').trim() && (m.tokens ?? []).every((t) => t.text && !t.timer && !t.clock))
    .map((m) => ({
      uuid: m.id?.uuid ?? '',
      name: String(m.id?.name ?? '').trim(),
      text: tokensFirst(String(m.message ?? '')),
      fields: (m.tokens ?? []).map((t) => t.name),
      free: m.id?.name === FREE_MESSAGE_NAME,
    }))
}

// ---------------------------------------------------------------------------
// Beamer-Meldungen: vom Handy/Multiview vorbereitet, angezeigt nur vom ProPresenter-Bediener.
// Der Server trägt den Text in die ProPresenter-Meldung ein (PUT /v1/message/{id}, löst nichts
// aus) und gibt im Kesher-Chat Bescheid. Ob die Meldung dann auf dem Beamer läuft, sieht er an
// is_active in /v1/messages.
// ---------------------------------------------------------------------------

const FREE_MESSAGE_NAME = 'Multiview-Meldung' // eigene Meldung für freien Text, legt der Server bei Bedarf an
const FREE_MESSAGE_TOKEN = 'Text'
let announceRequests = [] // { id, uuid, name, text, from, by, at, status: wartet|angezeigt|beendet|ersetzt|zurückgezogen, seenInactive }
// Wer eine Meldung geschickt hat (Name|Rolle) – nur der (oder der Admin) darf sie zurückziehen
const senderKey = (user) => (user && !user.open ? `${user.name}|${user.roleId}` : '')

function updateAnnounceRequests(list) {
  const active = new Set(list.filter((m) => m.is_active).map((m) => m.id?.uuid))
  const now = Date.now()
  for (const r of announceRequests) {
    if (r.status === 'wartet') {
      if (!active.has(r.uuid)) r.seenInactive = true
      else if (r.seenInactive) Object.assign(r, { status: 'angezeigt', shownAt: now })
    } else if (r.status === 'angezeigt' && !active.has(r.uuid)) Object.assign(r, { status: 'beendet', endedAt: now })
  }
  // Nur die letzten Stunden, höchstens 10
  announceRequests = announceRequests.filter((r) => now - r.at < 3 * 3600_000).slice(0, 10)
}

const publicRequests = () =>
  announceRequests.map(({ id, name, text, from, by, at, status, shownAt, link }) => ({ id, name, text, from, by, at, status, shownAt, link }))

/** Text mit eingesetzten Platzhaltern, wie ihn ProPresenter anzeigen wird. */
/**
 * Einheitliches Format für Beamer-Meldungen: zuerst die Platzhalter (z. B. das Kennzeichen),
 * dann der Text – wie bei „{Kennzeichen} Bitte sofort umparken!“. So kommt auch
 * „Fenster offen!  {Kfz-Kennzeichen}“ als „{Kfz-Kennzeichen} Fenster offen!“ an.
 */
function tokensFirst(template) {
  const tokens = template.match(/\{[^}]+\}/g) ?? []
  const text = template.replace(/\{[^}]+\}/g, ' ').replace(/\s+/g, ' ').trim()
  return [...tokens, text].filter(Boolean).join(' ')
}

const fillTokens = (template, values) =>
  template.replace(/\{([^}]+)\}/g, (all, name) => (values[name] != null ? values[name] : all))

/** Eigene Meldung für freien Text suchen oder anlegen (Aussehen wie eine vorhandene Laufschrift). */
async function freeMessage(list) {
  const found = list.find((m) => m.id?.name === FREE_MESSAGE_NAME)
  if (found) return found
  const looks =
    list.find((m) => /ticker|laufschrift/i.test(m.theme?.name ?? '') && !(m.tokens ?? []).some((t) => t.timer)) ??
    list.find((m) => !(m.tokens ?? []).some((t) => t.timer))
  const res = await fetch(`${ppBase()}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: { name: FREE_MESSAGE_NAME, index: list.length, uuid: '' },
      message: `{${FREE_MESSAGE_TOKEN}}`,
      tokens: [{ name: FREE_MESSAGE_TOKEN, text: { text: '' } }],
      theme: looks?.theme ?? { name: '', index: 0, uuid: '' },
      visible_on_network: false,
      is_active: false,
    }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`ProPresenter: Meldung „${FREE_MESSAGE_NAME}“ ließ sich nicht anlegen (HTTP ${res.status})`)
  const created = ((await ppGet('/v1/messages')) ?? []).find((m) => m.id?.name === FREE_MESSAGE_NAME)
  if (!created) throw new Error(`ProPresenter: Meldung „${FREE_MESSAGE_NAME}“ fehlt nach dem Anlegen`)
  console.log(`ProPresenter: Meldung „${FREE_MESSAGE_NAME}“ für freien Text angelegt`)
  return created
}

/** Meldung in ProPresenter überschreiben (PUT löst nichts aus; is_active muss mitgeschickt werden). */
async function putMessage(message) {
  const res = await fetch(`${ppBase()}/v1/message/${encodeURIComponent(message.id.uuid)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`ProPresenter antwortet mit HTTP ${res.status}`)
}

/**
 * Meldung vorbereiten, NICHT anzeigen. Alles landet in der „Multiview-Meldung“ – dem festen Eingang,
 * in den der ProPresenter-Bediener schaut: bei einer Vorlage mit eingesetztem Text und im Aussehen
 * der Vorlage, bei freiem Text im Aussehen einer normalen Laufschrift.
 * { uuid, fields: { Name: Wert } } für eine Vorlage, { text } für freien Text.
 */
async function prepareAnnouncement({ uuid, fields, text }, from, by = '') {
  if (!ppBase()) throw Object.assign(new Error('ProPresenter nicht eingerichtet'), { status: 503 })
  const list = (await ppGet('/v1/messages')) ?? []
  const free = !uuid
  const template = free ? null : list.find((m) => m.id?.uuid === uuid)
  if (!free && !template) throw Object.assign(new Error('Diese Meldung gibt es in ProPresenter nicht mehr'), { status: 404 })
  if (template && !messageTemplates([template]).length)
    throw Object.assign(new Error('Diese Meldung lässt sich nicht vom Handy füllen'), { status: 400 })

  const clean = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)
  let rendered
  if (template) {
    const values = {}
    for (const t of template.tokens ?? []) values[t.name] = clean(fields?.[t.name] ?? t.text?.text)
    rendered = clean(fillTokens(tokensFirst(String(template.message ?? '')), values))
    // Werte auch in der Vorlage selbst ablegen (dort sind sie dann vorbelegt)
    if (template.tokens?.length)
      await putMessage({ ...template, tokens: template.tokens.map((t) => ({ ...t, text: { ...t.text, text: values[t.name] } })) })
  } else rendered = clean(text)
  if (!rendered) throw Object.assign(new Error('Bitte einen Text eingeben'), { status: 400 })

  const inbox = await freeMessage(list)
  // Aussehen: das der Vorlage, sonst eine graue (bzw. irgendeine) Laufschrift
  const others = list.filter((m) => m.id?.uuid !== inbox.id?.uuid && m.theme?.uuid)
  const theme = template?.theme?.uuid
    ? template.theme
    : (others.find((m) => /ticker|laufschrift/i.test(m.theme.name ?? '') && /grau|grey|gray/i.test(m.theme.name ?? '')) ??
        others.find((m) => /ticker|laufschrift/i.test(m.theme.name ?? '')))?.theme ?? inbox.theme
  const token = inbox.tokens?.find((t) => t.name === FREE_MESSAGE_TOKEN) ?? { name: FREE_MESSAGE_TOKEN, text: { text: '' } }
  await putMessage({
    ...inbox,
    message: `{${FREE_MESSAGE_TOKEN}}`,
    tokens: [{ ...token, text: { ...token.text, text: rendered } }],
    theme,
  })

  const request = {
    id: Math.random().toString(36).slice(2, 10),
    uuid: inbox.id.uuid,
    name: template ? String(template.id?.name ?? '').trim() : 'Eigene Meldung',
    text: rendered,
    from,
    by,
    at: Date.now(),
    status: 'wartet',
    seenInactive: !inbox.is_active,
  }
  for (const r of announceRequests) if (r.uuid === request.uuid && r.status === 'wartet') r.status = 'ersetzt'
  announceRequests.unshift(request)
  stageMessagesAt = 0
  requestStagePoll()
  return request
}

async function pollStageOnce(target) {
  const next = emptyStageState()
  try {
    const [message, timers, video] = await Promise.all([
      ppGet('/v1/stage/message'),
      ppGet('/v1/timers/current'),
      ppGet('/v1/timer/video_countdown').catch(() => null),
    ])
    next.connected = true
    next.message = typeof message === 'string' ? message.trim() : ''
    next.timers = (timers ?? []).map((t) => ({
      uuid: t.id?.uuid ?? '',
      name: String(t.id?.name ?? '').trim(),
      time: String(t.time ?? ''),
      state: String(t.state ?? ''),
    }))
    next.videoCountdown = typeof video === 'string' && /[1-9]/.test(video) ? video : ''
    if (Date.now() - stageMessagesAt >= STAGE_MESSAGES_MS) {
      stageMessagesAt = Date.now()
      const list = await ppGet('/v1/messages').catch(() => null)
      if (list) updateAnnounceRequests(list)
      next.messages = list ? activeMessages(list) : stageState.messages
      next.templates = list ? messageTemplates(list) : stageState.templates
    } else {
      next.messages = stageState.messages
      next.templates = stageState.templates
    }
    next.requests = publicRequests()
  } catch {
    next.connected = false
  }
  if (target !== ppBase()) return
  if (JSON.stringify(next) !== JSON.stringify(stageState)) {
    stageState = next
    broadcast({ type: 'ppstage', ...stageState })
  }
}

async function pollStage() {
  stageTimer = null
  const target = ppBase()
  if (!target) return
  stageBusy = true
  try {
    await pollStageOnce(target)
  } finally {
    stageBusy = false
  }
  if (target !== ppBase()) return
  const delay = stageAgain ? 0 : stageState.connected ? STAGE_POLL_MS : 3000
  stageAgain = false
  clearTimeout(stageTimer)
  stageTimer = setTimeout(pollStage, delay)
}

/** Sofort neu abfragen, ohne eine zweite Abfrage-Schleife zu starten. */
function requestStagePoll() {
  if (stageBusy) {
    stageAgain = true
    return
  }
  clearTimeout(stageTimer)
  pollStage()
}

/** Bühnennachricht in ProPresenter setzen; leerer Text = Nachricht löschen. */
async function setStageMessage(text) {
  const base = ppBase()
  if (!base) throw Object.assign(new Error('ProPresenter nicht eingerichtet'), { status: 503 })
  const res = await fetch(`${base}/v1/stage/message`, {
    method: text ? 'PUT' : 'DELETE',
    headers: text ? { 'Content-Type': 'application/json' } : {},
    body: text ? JSON.stringify(text) : undefined,
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) throw new Error(`ProPresenter antwortet mit HTTP ${res.status}`)
  stageMessagesAt = 0
  requestStagePoll()
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

// Ändert sich bei jedem Start UND sobald sich eine Datei der Oberfläche (public/) ändert –
// Monitore, Editor, Handy und Prediger laden dann von selbst den neuen Stand.
const START_ID = `${Date.now()}`
let BOOT_ID = START_ID
function assetsVersion() {
  const hash = require('crypto').createHash('sha1').update(START_ID)
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const stat = fs.statSync(file)
      if (stat.isDirectory()) walk(file)
      else hash.update(`${path.relative(__dirname, file)}:${stat.size}:${stat.mtimeMs}`)
    }
  }
  try {
    walk(path.join(__dirname, 'public'))
  } catch {
    // Ordner gerade nicht lesbar – beim nächsten Mal
  }
  return hash.digest('hex').slice(0, 16)
}
BOOT_ID = assetsVersion()
// Neue Dateien (z. B. per docker cp eingespielt) erkennen: alle 10 s vergleichen und dann Bescheid geben
setInterval(() => {
  const next = assetsVersion()
  if (next === BOOT_ID) return
  BOOT_ID = next
  console.log('Oberfläche geändert – offene Seiten laden neu')
  broadcast(serverInfo())
}, 10_000).unref()

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
      rotate: saved?.rotate ?? 0,
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
    access.flush()
    // kurz warten, damit die Abmeldung bei Kesher die Rolle freigibt
    setTimeout(() => process.exit(0), 500)
  })
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket
// ---------------------------------------------------------------------------

const app = express()
const server = http.createServer(app)
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
const socketGuard = createSocketGuard()
const knownDevices = new Set()

// Pegel kommen 15-mal pro Sekunde: Ein Gerät, das mit dem Empfang nicht hinterherkommt (schwaches
// WLAN, schlafender Tab), bekommt keine weiteren, bis es aufgeholt hat – sonst wüchse der Puffer im Server
const LEVELS_BACKLOG_BYTES = 256 * 1024

function send(ws, msg, encoded = null) {
  if (ws.readyState !== 1) return
  if (msg.type === 'session_revoked') return ws.send(JSON.stringify(msg))
  if (msg.type === 'levels' && ws.bufferedAmount > LEVELS_BACKLOG_BYTES) return
  if (!ws.authRequest || !access.trusted(clientIp(ws.authRequest), ws.authRequest)) return ws.close(4401, 'Bitte anmelden')
  const filtered = messageForRequest(msg, ws.authRequest)
  if (!filtered) return
  // Dieselbe (ungefilterte) Meldung für viele Geräte nur einmal in Text umwandeln
  let text = encoded?.get(filtered)
  if (!text) {
    text = JSON.stringify(filtered)
    encoded?.set(filtered, text)
  }
  ws.send(text)
}

function broadcast(msg) {
  const encoded = new Map()
  for (const ws of wss.clients) send(ws, msg, encoded)
}

let sessionsTimer = null
/**
 * Angemeldete Geräte haben sich geändert (Anmeldung, Seite auf/zu, Kesher verbunden): offene
 * Einstellungen laden die Liste neu. Ohne Inhalt – die Liste selbst darf nur der Admin lesen.
 */
function sessionsChanged() {
  sessionsTimer ??= setTimeout(() => {
    sessionsTimer = null
    broadcast({ type: 'sessions_changed' })
  }, 300)
}

const churchTools = createChurchTools({
  dataDir: DATA_DIR,
  getConfig: () => config.churchtools,
  // Fest gewählte Tage aller ChurchTools-Kacheln
  getDates: () =>
    config.layouts.flatMap((l) => l.tiles.filter((t) => t.kind === 'churchtools' && t.ctDate).map((t) => t.ctDate)),
  // Filter der Kacheln „Nächstes Event“: dafür wird das nächste Event der kommenden Tage gesucht
  getFilters: () =>
    config.layouts.flatMap((l) =>
      l.tiles.filter((t) => t.kind === 'churchtools' && !t.ctDate && t.ctMode === 'next').map((t) => t.ctFilter || ''),
    ),
  onUpdate: broadcast,
  log: console.log,
})

// Upload der Internetleitung (FRITZ!Box) für die Kachel „Upload / Stream“
const uplink = createUplink({ getConfig: () => config.uplink, onUpdate: broadcast, log: console.log })
let uplinkKey = ''
function applyUplink() {
  const key = JSON.stringify(normalizeUplink(config.uplink))
  if (key === uplinkKey) return
  if (uplinkKey) uplink.reconfigure()
  uplinkKey = key
}

// Matrox Monarch HDX: der Encoder, der zu YouTube sendet (sendet er, kommt ein Bild an)
const monarch = createMonarch({ dataDir: DATA_DIR, log: console.log })

// YouTube Live (API-Schlüssel, optional Google-Anmeldung) für die Kachel „YouTube Live“ und jms-watch.
// Ob gesendet wird, liefern die Monarch und der ATEM, wenn er selbst streamt (atem.state.streaming).
const youtube = createYouTube({
  dataDir: DATA_DIR,
  getAtem: () => ({ connected: atem.status === 2, streaming: atem.state?.streaming ?? null }),
  getEncoder: () => monarch.snapshot(),
  getUpload: () => uplink.upload(),
  wantChat: () => (config.layouts || []).some((layout) => (layout.tiles || []).some((tile) => tile.kind === 'youtube' && tile.youtube?.chat === true)),
  onUpdate: broadcast,
  log: console.log,
})

// Dropbox-Ordner für die Diashow: neue Bilder dort erscheinen sofort (Longpoll von Dropbox)
const dropbox = createDropbox({ dataDir: DATA_DIR, onUpdate: () => broadcast(slideshow.snapshot()), log: console.log })

// Diashow (Kachel „Diashow“): hochgeladene Bilder und zwischengespeicherte ProPresenter-Folien
const slideshow = createSlideshow({
  dataDir: DATA_DIR,
  getDropbox: () => dropbox.snapshot(),
  getPpBase: () => ppBase(),
  // Termine aus ChurchTools – nur, wenn ChurchTools verbunden ist
  getCtApi: () => (churchTools.snapshot().state === 'unconfigured' ? null : churchTools.api),
  onUpdate: broadcast,
  log: console.log,
})

const kesherChat = createKesherChat({
  getConfig: () => config.chat,
  getHeaders: () => kesherDeviceHeaders(),
  onUpdate: broadcast,
  onFlash: broadcast,
  // Wer in Kesher verbunden ist, zählt bei den angemeldeten Geräten als online (Handys im WLAN)
  onPresence: sessionsChanged,
  // Kopfhörer/Mikrofon an einem Pi eingesteckt oder abgezogen: Einstellungsseite lädt neu (ohne Inhalt, nur für Admins relevant)
  onAudioDevices: () => broadcast({ type: 'raspberry_changed' }),
  log: console.log,
})

/**
 * Zuletzt gelaufenes Layout je Multiview merken. Ein fremdes Layout sieht eine Rolle nur, solange
 * es auf ihrem Multiview läuft – ohne diese Notiz käme sie nach „Aus“ nicht mehr zurück.
 */
function rememberLayouts() {
  for (const o of config.outputs ?? []) if (o.layoutId) o.lastLayoutId = o.layoutId
}

function configChanged(origin = null) {
  rememberLayouts()
  saveConfig()
  broadcast({ type: 'config', config, origin })
  refreshAtemState()
  applyAtemIp()
  kesherChat.reconfigure()
  applyProPresenter()
  churchTools.datesChanged()
  applyUplink()
  youtube.layoutsChanged()
  if (mediamtx.proc) writeMediamtxConfig()
}

// ---------------------------------------------------------------------------
// Layout-Vorlagen: gespeicherte Ansichten, je eine JSON-Datei in data/vorlagen.
// Eine Vorlage gehört der Rolle, die sie gespeichert hat; Rollen sehen ihre eigenen und die
// des Admins, der Admin sieht alle.
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

/** Nur das Raster und die Kacheln – Name, ID und Besitzer gehören dem Layout, in das geladen wird. */
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
    return {
      id,
      name: String(t.name || id),
      savedAt: t.savedAt || null,
      owner: typeof t.owner === 'string' && t.owner ? t.owner : null,
      layout: normalizeTemplateLayout(t.layout),
    }
  } catch {
    return null
  }
}

function templateVisible(t, user) {
  return user.admin || !t.owner || t.owner === user.roleId
}

function templateList(user) {
  let files = []
  try {
    files = fs.readdirSync(TEMPLATE_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    // noch keine Vorlagen
  }
  return files
    .map((f) => readTemplate(f.slice(0, -5)))
    .filter((t) => t && templateVisible(t, user))
    .map(({ id, name, savedAt, owner, layout }) => ({
      id, name, savedAt, owner, tiles: layout.tiles.length, own: user.admin || owner === user.roleId,
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de'))
}

/** Die Listen sind je Nutzer verschieden – die Seiten holen sie sich daraufhin selbst. */
function templatesChanged() {
  broadcast({ type: 'templates_changed' })
}

wss.on('connection', (ws, req) => {
  // Kaputte Pakete (z. B. Caddy schickt beim Neuladen ein unmaskiertes Schlusspaket) beenden nur
  // diese Verbindung – ohne Fehler-Handler würde ws den ganzen Server abstürzen lassen
  ws.on('error', (err) => console.warn('WebSocket-Fehler:', err.code || err.message))
  // Ohne Anmeldung nur feste Geräte und der Server selbst (Kiosk) – alle anderen zur Anmeldeseite
  if (!access.trusted(clientIp(req), req)) return ws.close(4401, 'Bitte anmelden')
  ws.authRequest = req
  // Welche Anmeldung hier offen ist – so gilt eine Rolle als belegt, solange ihre Seite offen ist
  ws.sessionId = access.sessionIdOf(req)
  const removeGuard = socketGuard.add({ sessionId: ws.sessionId, valid: () => access.trusted(clientIp(req), req), close: () => {
    ws.close(4401, 'Anmeldung beendet')
    setTimeout(() => ws.terminate(), 100).unref()
  } })
  ws.on('close', removeGuard)
  if (ws.sessionId) {
    sessionsChanged()
    ws.on('close', sessionsChanged)
  }
  send(ws, { type: 'config', config })
  send(ws, { type: 'atem', ...atemState })
  send(ws, { type: 'devices', devices: [...knownDevices] })
  send(ws, { type: 'screens', screens: detectedScreens })
  send(ws, serverInfo())
  send(ws, kesherChat.snapshot())
  send(ws, churchTools.snapshot())
  send(ws, uplink.snapshot())
  send(ws, youtube.snapshot())
  send(ws, slideshow.snapshot())
  send(ws, { type: 'propresenter', ...ppState })
  send(ws, { type: 'ppstage', ...stageState })

  ws.on('message', (raw) => {
    if (!access.trusted(clientIp(req), req)) return ws.close(4401, 'Bitte anmelden')
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }
    // Ausgabe-Seiten melden die Videogeräte, die auf ihrem Rechner verfügbar sind.
    if (msg.type === 'devices' && Array.isArray(msg.devices) && (access.userOf(req)?.admin || isMachine(req, 'display'))) {
      let added = false
      for (const d of msg.devices.slice(0, 64)) {
        if (typeof d === 'string' && d && d.length <= 256 && knownDevices.size < 512 && !knownDevices.has(d)) {
          knownDevices.add(d)
          added = true
        }
      }
      if (added) broadcast({ type: 'devices', devices: [...knownDevices] })
    }
  })
})

app.disable('x-powered-by')
app.get('/api/healthz', (req, res) => res.json({ ok: true }))
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'Content-Security-Policy': `frame-ancestors 'self' ${DEFAULT_ORIGINS.join(' ')}` })
  if (req.path.startsWith('/api/') || req.path.startsWith('/.jms-auth/')) res.set('Cache-Control', 'no-store')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !sameOriginRequest(req))
    return res.status(403).json({ ok: false, error: 'Anfrage von einer fremden Seite abgelehnt' })
  next()
})
app.use(express.json({ limit: '5mb' }))
// Alte Browser (z. B. iPad mit iOS 12) bekommen umgeschriebene Dateien, siehe legacy.js
app.use(require('./legacy').legacyMiddleware(path.join(__dirname, 'public')))
app.use(express.static(path.join(__dirname, 'public')))

app.get('/api/config', requireTrusted, requireDisplayReader, (req, res) => res.json(configForRequest(req)))

// ---------------------------------------------------------------------------
// Raspberry-Pi-Stationen (raspberry-pis.js): der Launcher auf dem Pi holt hier seine Konfiguration
// ---------------------------------------------------------------------------

const piRegistry = createPiRegistry()

// Neu starten aus den Einstellungen. Der Befehl wartet, bis der Pi das nächste Mal seine
// Konfiguration holt (alle 15 s), geht genau einmal raus und verfällt nach 2 Minuten.
// Kein Herunterfahren: ein Pi lässt sich danach aus der Ferne nicht wieder einschalten –
// dafür gibt es den Ruhemodus (Einstellung „standby“ der Station).
const PI_POWER_ACTIONS = ['reboot']
const PI_POWER_TTL_MS = 2 * 60 * 1000
const piPowerCommands = new Map() // Raspberry-Eintrag (client.id) -> { id, action, at }

function takePiPowerCommand(clientId) {
  const command = piPowerCommands.get(clientId)
  if (!command) return null
  piPowerCommands.delete(clientId)
  return Date.now() - command.at < PI_POWER_TTL_MS ? { id: command.id, action: command.action } : null
}

// Ohne Anmeldung (der Pi hat keine) – es kommen nur die Einträge zurück, die zu seinen MACs/IPs passen
app.post('/api/raspberry-pis/config', (req, res) => {
  if (!isMachine(req, 'pi-config')) return res.status(403).json({ ok: false, error: 'Nur für registrierte Technikstationen' })
  const machine = access.machineOf(req)
  const observedIp = clientIp(req).replace(/^::ffff:/, '')
  if (!(config.raspberry.clients || []).some((client) => client.id === machine.raspberryClientId && client.roleId === machine.roleId && client.deviceId === machine.deviceId))
    return res.status(403).json({ ok: false, error: 'Technikstation muss zuerst vom Admin registriert werden' })
  const request = parsePiRequest(req.body)
  piRegistry.record({ ...request, ips: [observedIp] }, observedIp)
  const answer = stationLauncherConfig(config.raspberry, machine)
  const power = takePiPowerCommand(machine.raspberryClientId)
  if (power) {
    answer.power = power
    console.log(`Raspberry Pi ${machine.raspberryClientId}: ${power.action} ausgeliefert`)
  }
  res.set('Cache-Control', 'no-store').json(answer)
})

function queuePiPower(client, action) {
  piPowerCommands.set(client.id, { id: require('crypto').randomUUID(), action, at: Date.now() })
}

app.post('/api/raspberry-pis/power', requireAdmin, (req, res) => {
  const { clientId, action } = req.body ?? {}
  if (!PI_POWER_ACTIONS.includes(action)) return res.status(400).json({ ok: false, error: 'Unbekannte Aktion' })
  const client = (config.raspberry.clients || []).find((c) => c.id === clientId)
  if (!client) return res.status(404).json({ ok: false, error: 'Raspberry Pi nicht gefunden' })
  queuePiPower(client, action)
  res.json({ ok: true, waitSeconds: 15 })
})

// Ein/Aus (Ruhemodus) und Neu starten aus dem Intercom: für den Admin und Rollen mit dem Recht
// „Raspberry Pis“ (Benutzer & Rechte). Kesher ruft das über /.jms-auth auf der eigenen Adresse auf
// und ordnet die Einträge über die Geräte-ID seinen Raspberry-Karten zu.
function piControlAllowed(user) {
  const rights = roleRights(config, user)
  return Boolean(rights?.admin || rights?.controlPis)
}

app.get(['/api/raspberry-pis/control', '/.jms-auth/api/raspberry-pis/control'], requireUser, (req, res) => {
  const allowed = piControlAllowed(req.user)
  res.set('Cache-Control', 'no-store').json({
    ok: true,
    allowed,
    pis: allowed ? (config.raspberry.clients || []).map((c) => ({ id: c.id, deviceId: c.deviceId, name: c.name, standby: c.standby === true })) : [],
  })
})

app.post(['/api/raspberry-pis/control', '/.jms-auth/api/raspberry-pis/control'], requireUser, (req, res) => {
  if (!piControlAllowed(req.user)) return res.status(403).json({ ok: false, error: 'Keine Berechtigung, Raspberry Pis zu schalten' })
  const { deviceId, action } = req.body ?? {}
  if (!['on', 'off', 'reboot'].includes(action)) return res.status(400).json({ ok: false, error: 'Unbekannte Aktion' })
  const client = (config.raspberry.clients || []).find((c) => typeof deviceId === 'string' && c.deviceId === deviceId)
  if (!client) return res.status(404).json({ ok: false, error: 'Raspberry Pi nicht gefunden' })
  if (action === 'reboot') {
    queuePiPower(client, 'reboot')
  } else if (client.standby !== (action === 'off')) {
    client.standby = action === 'off'
    console.log(`Raspberry Pi ${client.name || client.id}: ${client.standby ? 'Ruhemodus' : 'eingeschaltet'} (${req.user.name})`)
    configChanged()
  }
  res.json({ ok: true, standby: client.standby === true, waitSeconds: 15 })
})

// Für den Reiter in den Einstellungen: welche Pis gefragt haben und wie Kesher sie gerade sieht
app.get('/api/raspberry-pis/status', requireAdmin, async (req, res) => {
  let stations = null
  let error = ''
  try {
    const r = await fetch(`${config.chat.url}/api/raspberry-pis/remote`, { headers: kesherDeviceHeaders(), signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    stations = (await r.json())?.stations ?? []
  } catch (err) {
    error = `Kesher nicht erreichbar (${err.message})`
  }
  res.set('Cache-Control', 'no-store').json({ seen: piRegistry.list(), stations, error })
})

// ---------------------------------------------------------------------------
// Benutzer und Rechte (access.js): Anmeldung mit Name + Kesher-Rolle, Admin mit PIN
// ---------------------------------------------------------------------------

const access = createAccess({
  dataDir: DATA_DIR,
  allowBootstrap: false,
  getRoles: () => kesherChat.snapshot().roles?.length ? loginRoles() : null,
  log: console.log,
  // Admin-PIN wie im Kesher-Admin: Kesher prüft sie
  verifyKesherPin: (pin, req) => kesherChat.verifyAdminPin(pin, { sourceIp: clientIp(req), secret: AUTH_SECRET }),
  // Eine Rolle nur einmal – auch gegenüber Geräten, die direkt bei Kesher angemeldet sind
  kesherActiveRoles: () => kesherChat.activeRoleIds(),
  isLive: (id) => [...wss.clients].some((ws) => ws.readyState === 1 && ws.sessionId === id),
  // Geräteadresse für die Liste der Anmeldungen (clientIp ist weiter unten definiert, wird erst bei Anfragen aufgerufen)
  ipOf: (req) => (req?.socket ? clientIp(req).replace(/^::ffff:/, '') : ''),
  // Dasselbe Gerät per IPv4 (IP-Adresse) und IPv6 (.local-Namen) erkennen
  macOf: createNeighbors().macOf,
  onChange: sessionsChanged,
  // Kesher-Kacheln mit fester Rolle (nicht „angemeldeter Nutzer“)
  getMirrorRoles: () => config.layouts.flatMap((layout) => (layout.tiles || [])
    .filter((tile) => tile.kind === 'kesher' && tile.kesherRoleId && tile.kesherRoleId !== '@user').map((tile) => tile.kesherRoleId)),
  // Übernommene oder vom Admin beendete Anmeldung: die offenen Seiten dort abmelden
  onRevoke: (ids, reason) => {
    for (const ws of wss.clients) {
      if (!ids.includes(ws.sessionId)) continue
      send(ws, { type: 'session_revoked', reason })
      ws.close(4401, 'Anmeldung beendet')
      setTimeout(() => ws.terminate(), 100).unref()
    }
    socketGuard.revoke(ids)
  },
})
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json')

function requireUser(req, res, next) {
  const user = access.userOf(req)
  if (!user) return res.status(401).json({ ok: false, error: 'Bitte anmelden', login: true })
  req.user = user
  next()
}

/** Schnittstellen des Multiview selbst: angemeldet, feste Geräte oder der Server selbst (Companion, Kiosk). */
function requireTrusted(req, res, next) {
  if (!access.trusted(clientIp(req), req)) return res.status(401).json({ ok: false, error: 'Bitte anmelden', login: true })
  req.user = access.userOf(req)
  next()
}

function isMachine(req, capability = '', service = 'multiview') {
  const machine = access.machineOf(req)
  return machineRequest(req, machine?.mode === 'station' && access.machineServes(machine, service) && (!capability || machine.capabilities.includes(capability)), access.userOf(req))
}

function requireDisplayReader(req, res, next) {
  if (req.user || isMachine(req, 'display') || isMachine(req, 'control')) return next()
  res.status(403).json({ ok: false, error: 'Dieses Gerät hat keine Anzeigerechte' })
}

function requireChatReader(req, res, next) {
  if (isMachine(req, 'chat-monitor')) return next()
  return requireDisplayReader(req, res, next)
}

function requireMutation(req, res, next) {
  if (isMachine(req) && !isMachine(req, 'control')) return res.status(403).json({ ok: false, error: 'Dieses Gerät hat keine Steuerrechte' })
  if (req.method === 'POST' || (req.method === 'GET' && nativeMachineRequest(req, isMachine(req)))) return next()
  res.set('Allow', 'POST').status(405).json({ ok: false, error: 'Bitte POST verwenden' })
}

function requireOperator(req, res, next) {
  if (req.user?.admin || isMachine(req, 'control')) return next()
  res.status(403).json({ ok: false, error: 'Nur für den Admin oder eine feste Technikstation' })
}

function requireSlideOperator(req, res, next) {
  if (roleRights(config, req.user)?.controlSlides) return next()
  return requireOperator(req, res, next)
}

function configForRequest(req) {
  const user = access.userOf(req)
  return viewConfig(config, user, !user ? access.machineOf(req) : null)
}

function messageForRequest(msg, req) {
  const user = access.userOf(req)
  return filterMessage(msg, config, user, !user ? access.machineOf(req) : null)
}

function requireAdmin(req, res, next) {
  const user = access.userOf(req)
  if (!user) return res.status(401).json({ ok: false, error: 'Bitte anmelden', login: true })
  if (!user.admin) return res.status(403).json({ ok: false, error: 'Nur für den Admin' })
  req.user = user
  next()
}

/** Kesher-Rollen für die Anmeldung (ohne die Rolle des Chat-Monitors). */
function loginRoles() {
  return (kesherChat.snapshot().roles ?? []).filter((r) => r.id !== config.chat.roleId)
}

function roleName(roleId) {
  if (roleId === ADMIN) return 'Admin'
  return loginRoles().find((r) => r.id === roleId)?.name || roleId
}

function readProfiles() {
  try {
    return JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'))
  } catch {
    return {}
  }
}

const profileKey = (user) => `${user.roleId}:${String(user.name).trim().toLowerCase()}`

// ---------------------------------------------------------------------------
// Profilbilder: pro Person (Name, unabhängig von der Rolle), als kleines JPEG in data/avatars.
// Der Browser verkleinert vorher auf 256×256, hier kommt nur das fertige Bild an.
// ---------------------------------------------------------------------------
const AVATAR_DIR = path.join(DATA_DIR, 'avatars')
const avatarId = (name) =>
  require('crypto').createHash('sha1').update(String(name || '').trim().toLowerCase()).digest('hex').slice(0, 20)
const avatarFile = (id) => path.join(AVATAR_DIR, `${id}.jpg`)

/** Adresse des Profilbilds einer Person (mit Version gegen den Browser-Cache) oder null. */
function avatarUrl(name) {
  if (!String(name || '').trim()) return null
  const id = avatarId(name)
  try {
    return `/api/avatar/${id}?v=${Math.round(fs.statSync(avatarFile(id)).mtimeMs)}`
  } catch {
    return null
  }
}

/**
 * Wer ist gerade für diesen Multiview angemeldet? Für Monitore ohne eigene Anmeldung (Kiosk am
 * HDMI-Ausgang): Kesher-Kacheln mit „angemeldeter Nutzer“ melden sich dann als diese Person an.
 * Aktive Anmeldungen (ohne Admin) mit Rechten auf den Multiview; bei mehreren die Rolle mit den
 * wenigsten Multiviews (Licht 1 vor einer Rolle, die alles darf), sonst die zuletzt aktive.
 */
app.get('/api/output/:id/user', requireTrusted, requireDisplayReader, (req, res) => {
  const output = findByRef(config.outputs, req.params.id)
  if (!output) return res.status(404).json({ ok: false, user: null })
  if (!isMachine(req, 'display') && !isMachine(req, 'control') && !allowedOutputs(config, req.user).has(output.id)) return res.status(403).json({ ok: false, user: null })
  const active = access
    .sessions()
    .filter((s) => !s.admin && s.roleId && (s.live || Date.now() - s.seen < 2 * 60 * 1000))
    .map((s) => ({ ...s, outputs: allowedOutputs(config, s) }))
    .filter((s) => s.outputs.has(output.id))
    .sort((a, b) => a.outputs.size - b.outputs.size || b.seen - a.seen)
  const who = active[0]
  res.json({ ok: true, user: who ? { name: who.name, roleId: who.roleId } : null })
})

app.get(['/api/me', '/.jms-auth/api/me'], (req, res) => {
  // Dauerhafte Gerätefreigabe ohne Ablauf: Cookie erneuern, damit der Browser es behält
  access.refreshDeviceCookie(req, res)
  const user = access.userOf(req)
  const rights = roleRights(config, user)
  res.json({
    access: { enabled: access.enabled(), pinSource: access.pinSource() },
    user: user && { name: user.name, roleId: user.roleId, roleName: roleName(user.roleId), admin: user.admin, open: user.open, sessionId: user.sessionId, version: user.version, expiresAt: user.expiresAt, avatar: user.open ? null : avatarUrl(user.name) },
    device: access.deviceStatus(clientIp(req), req),
    rights: rights && {
      admin: rights.admin,
      editLayouts: rights.admin || rights.editLayouts,
      controlSlides: rights.admin || rights.controlSlides,
      controlPis: rights.admin || rights.controlPis,
      outputs: [...allowedOutputs(config, user)],
      edit: [...editableOutputs(config, user)],
      layouts: visibleLayouts(config, user).map((l) => l.id),
    },
    prefs: user && !user.open ? (readProfiles()[profileKey(user)] ?? null) : null,
  })
})

app.get(['/api/login/roles', '/.jms-auth/api/login/roles'], async (req, res) =>
  res.set('Cache-Control', 'no-store').json({
    enabled: access.enabled(),
    roles: loginRoles(),
    occupied: await access.occupiedForLogin(req),
    // die eigene Rolle bleibt wählbar (neu anmelden mit anderem Namen)
    mine: access.userOf(req)?.roleId ?? null,
  }),
)

app.post(['/api/login', '/.jms-auth/api/login'], async (req, res) => {
  try {
    await access.login(req.body || {}, req, res)
    res.json({ ok: true })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message, holder: err.holder })
  }
})

app.post(['/api/logout', '/.jms-auth/api/logout'], (req, res) => {
  access.logout(req, res)
  res.json({ ok: true })
})

// Darstellung (Hell/Dunkel, Hintergrund) pro Nutzer – damit Handy und Rechner gleich aussehen
app.put('/api/me/prefs', requireUser, (req, res) => {
  if (req.user.open) return res.json({ ok: true })
  const { theme, wallpaper } = req.body || {}
  const profiles = readProfiles()
  profiles[profileKey(req.user)] = {
    theme: ['light', 'dark', 'system'].includes(theme) ? theme : 'system',
    wallpaper: /^[a-z0-9-]{1,40}$/.test(wallpaper) ? wallpaper : null,
  }
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2))
  res.json({ ok: true })
})

// Multiview am Handy umschalten (Fernbedienung) – nur eigene Multiviews und sichtbare Layouts
app.post('/api/me/avatar', requireUser, (req, res) => {
  if (req.user.open) return res.status(400).json({ ok: false, error: 'Profilbilder gibt es nur mit Anmeldung' })
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.image || ''))
  if (!m) return res.status(400).json({ ok: false, error: 'Bitte ein Bild wählen' })
  const data = Buffer.from(m[1], 'base64')
  if (data.length > 400 * 1024 || data[0] !== 0xff || data[1] !== 0xd8)
    return res.status(400).json({ ok: false, error: 'Das Bild ist zu groß oder kein JPEG' })
  fs.mkdirSync(AVATAR_DIR, { recursive: true })
  fs.writeFileSync(avatarFile(avatarId(req.user.name)), data)
  res.json({ ok: true, avatar: avatarUrl(req.user.name) })
})

app.delete('/api/me/avatar', requireUser, (req, res) => {
  fs.rmSync(avatarFile(avatarId(req.user.name)), { force: true })
  res.json({ ok: true, avatar: null })
})

// Stamm-Zertifikat von Caddys lokaler Zertifizierungsstelle (HTTPS auf 192.168.0.21:<port>).
// iPhone/iPad brauchen es als vertrautes Profil – sonst lädt die Seite nach der Warnung zwar,
// aber die Live-Verbindung (WebSocket) wird abgelehnt und es steht „Server nicht erreichbar“.
// Öffentlich, es ist nur das Zertifikat (kein Schlüssel); Caddy gibt es über seine Admin-API auf dem Server heraus.
app.get(['/zertifikat', '/.jms-auth/zertifikat'], async (req, res) => {
  try {
    const ca = await fetch('http://127.0.0.1:2019/pki/ca/local', { signal: AbortSignal.timeout(3000) }).then((r) => r.json())
    if (!String(ca.root_certificate || '').includes('BEGIN CERTIFICATE')) throw new Error('kein Zertifikat')
    res
      .set('Content-Disposition', 'attachment; filename="JMS-Technik.crt"')
      .type('application/x-x509-ca-cert')
      .send(Buffer.from(ca.root_certificate))
  } catch {
    res.status(503).type('text/plain').send('Zertifikat gerade nicht verfügbar (Caddy-Admin-API nicht erreichbar).')
  }
})

// Hintergrundbilder für Editor, Handy und Anmeldung. Sie liegen im Datenordner (data/wallpapers)
// und nicht im Git-Repo, weil das öffentlich ist und die Bilder fremde Lizenzen haben.
const WALLPAPER_DIR = path.join(DATA_DIR, 'wallpapers')
app.get(['/api/wallpaper/:file', '/.jms-auth/api/wallpaper/:file'], (req, res) => {
  if (!/^[a-z0-9-]{1,40}\.jpg$/.test(req.params.file)) return res.status(404).end()
  // Erst der Datenordner (Fotos mit fremder Lizenz), dann die selbst erzeugten aus dem Repo (wallpapers/)
  const file = [path.join(WALLPAPER_DIR, req.params.file), path.join(__dirname, 'wallpapers', req.params.file)].find((f) =>
    fs.existsSync(f),
  )
  if (!file) return res.status(404).end()
  res.set('Cache-Control', 'public, max-age=604800').type('image/jpeg').sendFile(file)
})

// Dashboard (Admin): Verbindung jeder Raspberry-Station live aus Kesher – mit WLAN-IP aus dem Herzschlag
// und den Rollennamen (die Messwerte zeigt das Dashboard über Glances auf dem Pi)
app.get(['/api/raspberry-pis/live', '/.jms-auth/api/raspberry-pis/live'], requireAdmin, async (req, res) => {
  try {
    const data = await kesherChat.raspberryPis()
    const names = Object.fromEntries((kesherChat.snapshot().roles ?? []).map((r) => [r.id, r.name]))
    res.set('Cache-Control', 'no-store').json({
      ok: true,
      offlineAfterMs: data.offlineAfterMs,
      stations: (data.stations ?? []).map((s) => ({
        ...s,
        roleName: names[s.roleId] || s.roleId || '',
        intercomRoleName: s.intercomRoleId ? names[s.intercomRoleId] || s.intercomRoleId : '',
      })),
    })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

app.get(['/api/avatar/:id', '/.jms-auth/api/avatar/:id'], requireTrusted, requireChatReader, (req, res) => {
  if (!/^[0-9a-f]{20}$/.test(req.params.id)) return res.status(404).end()
  const file = avatarFile(req.params.id)
  if (!fs.existsSync(file)) return res.status(404).end()
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type('image/jpeg').sendFile(file)
})

app.post('/api/me/output/:output/layout', requireUser, (req, res) => {
  const output = config.outputs.find((o) => o.id === req.params.output)
  if (!output || !allowedOutputs(config, req.user).has(output.id))
    return res.status(403).json({ ok: false, error: 'Kein Zugriff auf diesen Multiview' })
  if (!editableOutputs(config, req.user).has(output.id))
    return res.status(403).json({ ok: false, error: 'Diesen Multiview darfst du nur ansehen' })
  const layoutId = req.body?.layoutId ?? null
  if (layoutId !== null && !visibleLayouts(config, req.user).some((l) => l.id === layoutId))
    return res.status(403).json({ ok: false, error: 'Kein Zugriff auf dieses Layout' })
  claimLayouts(config, req.user)
  output.layoutId = layoutId
  configChanged()
  res.json({ ok: true })
})

// Chat schreiben – als die angemeldete Rolle (Admin wählt eine Rolle). Kesher prüft die
// Sprechrechte der Party Line; die Nachricht erscheint wie eine Stream-Deck-Nachricht.
app.post('/api/chat/send', requireUser, async (req, res) => {
  const text = String(req.body?.text ?? '').trim()
  const roomId = String(req.body?.roomId ?? '').trim()
  if (!text) return res.status(400).json({ ok: false, error: 'Text fehlt' })
  if (text.length > 500) return res.status(400).json({ ok: false, error: 'Höchstens 500 Zeichen' })
  const roleId = req.user.admin ? String(req.body?.roleId ?? '').trim() : req.user.roleId
  if (!roleId || !loginRoles().some((r) => r.id === roleId))
    return res.status(400).json({ ok: false, error: req.user.admin ? 'Bitte eine Rolle wählen' : 'Deine Rolle gibt es in Kesher nicht' })
  const room = roomId ? (kesherChat.snapshot().rooms ?? []).find((r) => r.id === roomId) : null
  if (roomId && !room) return res.status(400).json({ ok: false, error: 'Party Line nicht gefunden' })
  if (room && !room.talkers.includes(roleId))
    return res.status(403).json({ ok: false, error: 'Deine Rolle darf auf dieser Party Line nicht schreiben' })
  try {
    await kesherChat.sendText({ roleId, username: req.user.open ? '' : req.user.name, message: text, roomId })
    console.log(`Chat: ${req.user.name || 'Gast'} (${roleName(roleId)}) → ${room ? room.name : 'Global'}`)
    res.json({ ok: true })
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message })
  }
})

// QR-Code-Anmeldung fürs Handy: Einmal-Link, 10 Minuten gültig
// Dazu der Tagescode (nur wenn die Freischaltung an ist) – für Laptops, die keinen QR scannen können
app.post(['/api/me/qr', '/.jms-auth/api/me/qr'], requireUser, (req, res) => {
  try {
    const dayCode = access.gateway().active ? access.dayCode().code : null
    res.json({ ok: true, ...access.createQrToken(req.user, req), dayCode })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})

app.get('/q/:token', (req, res) => {
  const ok = access.redeemQrToken(req.params.token, req, res)
  // Der Code kommt von einem angemeldeten Gerät – das Handy gleich für heute freischalten,
  // damit es auch Intercom und Dashboard ohne Tagescode öffnen kann
  res.redirect(ok ? '/remote.html' : '/login.html?qr=abgelaufen')
})

// Derselbe Anmelde-QR auf der Adresse eines anderen Dienstes (z. B. Dashboard-Startseite):
// Das Handy wird angemeldet und – weil der Code von einem angemeldeten Gerät kommt – auch gleich
// für heute freigeschaltet (kein Tagescode nötig). Danach zurück zur Startseite dieses Dienstes.
app.get('/.jms-auth/q/:token', (req, res) => {
  const ok = access.redeemQrToken(req.params.token, req, res)
  if (!ok) return res.redirect(302, `${loginPath('/')}&qr=abgelaufen`)
  res.redirect(302, '/')
})

app.get(['/api/qr.svg', '/.jms-auth/api/qr.svg'], async (req, res) => {
  const data = String(req.query.data ?? '')
  if (!data || data.length > 600) return res.status(400).send('data fehlt oder ist zu lang')
  try {
    const svg = await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } })
    res.type('image/svg+xml').set('Cache-Control', 'no-store').send(svg)
  } catch (err) {
    res.status(500).send(err.message)
  }
})

// Admin: PIN und angemeldete Geräte
app.post('/api/access/pin', requireAdmin, async (req, res) => {
  try {
    await access.setAdminPin(req.body || {}, req.user, req)
    res.json({ ok: true, enabled: access.enabled() })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})

/**
 * Anmeldungen, deren Kesher-Seite gerade verbunden ist. Kesher meldet nur Rolle und Namen (ohne
 * Leerzeichen), keine Adresse: Rollen gibt es nur einmal, der Admin wird am Namen erkannt.
 * Hat eine Person die Rolle auf mehreren Geräten, zählt die zuletzt aktive Anmeldung.
 */
function sessionsInKesher(list) {
  const key = (name) => String(name ?? '').replace(/\s+/g, '').toLowerCase()
  const ids = new Set()
  for (const p of kesherChat.presence()) {
    const sameName = (s) => key(s.name) === key(p.username)
    const match = list
      .filter((s) => (s.admin ? sameName(s) : s.roleId === p.roleId))
      .sort((a, b) => sameName(b) - sameName(a) || b.seen - a.seen)[0]
    if (match) ids.add(match.id)
  }
  return ids
}

app.get('/api/access/sessions', requireAdmin, (req, res) => {
  const list = access.sessions()
  const inKesher = sessionsInKesher(list)
  res.json(
    list.map((s) => ({
      ...s,
      kesher: inKesher.has(s.id),
      // online: Seite im Multiview oder Kesher offen, sonst eben noch an einem Dienst aktiv (Dashboard …)
      online: s.live || inKesher.has(s.id) || Date.now() - s.seen < 2 * 60 * 1000,
      roleName: roleName(s.roleId),
      self: s.id === req.user.sessionId,
      avatar: avatarUrl(s.name),
    })),
  )
})

app.delete('/api/access/sessions/:id', requireAdmin, (req, res) => {
  access.endSession(req.params.id)
  res.json({ ok: true })
})

// Dauerhaft freigeschaltete Geräte: brauchen keinen Tagescode mehr (Name und Rolle weiterhin).
// Ohne IP: dieser Browser (nur auf dem Gerät selbst, in einer Admin-Sitzung). Mit IP: ein anderes
// Gerät über seine feste Adresse – die Adresse setzt Caddy, nicht der Browser.
app.get('/api/access/devices', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(access.permanentDevices(req)))
app.post('/api/access/devices', requireAdmin, (req, res) => {
  try { res.json({ ok: true, devices: access.approvePermanent({ name: req.body?.name, ip: req.body?.ip, unlimited: req.body?.unlimited === true }, req, res) }) }
  catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }) }
})
app.delete('/api/access/devices/:id', requireAdmin, (req, res) => {
  try { access.revokePermanent(req.params.id); res.json({ ok: true }) }
  catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }) }
})

// ---------------------------------------------------------------------------
// Zentrale Anmeldung für die anderen Dienste (Kesher, Dashboard, Companion …)
// Caddy fragt vor jeder Anfrage an einen Dienst /.jms-auth/check (forward_auth) und leitet
// /.jms-auth/* auf jeder Adresse hierher – so liegt die Anmeldeseite immer auf der Adresse des
// Dienstes, und das Anmelde-Cookie gilt dort. Der Multiview selbst braucht keinen Tagescode
// (dort holt man ihn ja ab).
// ---------------------------------------------------------------------------

// Gemeinsames Geheimnis mit Kesher für die Admin-Anmeldung dort (Tickets, siehe access.js)
const AUTH_SECRET = process.env.JMS_AUTH_SECRET || ''
const kesherDeviceKey = process.env.JMS_KESHER_DEVICE_KEY_FILE ? fs.readFileSync(process.env.JMS_KESHER_DEVICE_KEY_FILE, 'utf8').trim() : ''

function kesherDeviceHeaders() {
  const machine = access.machineOf({ headers: { 'x-jms-device-key': kesherDeviceKey }, socket: { remoteAddress: '127.0.0.1' } })
  const assertion = deviceAssertion(machine, AUTH_SECRET)
  return assertion ? { 'X-JMS-Device-Assertion': assertion, 'X-JMS-Gateway': 'machine' } : {}
}

/** Adresse des Geräts. Hinter Caddy steht sie in X-Forwarded-For – das gilt nur für Anfragen vom Server selbst. */
function clientIp(req) {
  const peer = req.socket.remoteAddress || ''
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return forwarded && /^(127\.|::1$|::ffff:127\.)/.test(peer) ? forwarded : peer
}

/** Nur Pfade auf derselben Adresse als Rücksprungziel, nie eine fremde Seite. */
const safeNext = safePath

/**
 * Anmeldeseite mit Rücksprungziel. Für Dienste nur für den Admin (Companion, Portainer …) bietet
 * sie dann nur die Admin-Anmeldung an – eine Rolle brächte dort ja nur „Nur für den Admin“.
 */
const loginPath = (next, service = '') => {
  const adminOnly = service && (SERVICE_LEVELS[service] ?? 'admin') === 'admin'
  return `/.jms-auth/login?next=${encodeURIComponent(safeNext(next))}${adminOnly ? `&nur=admin&dienst=${encodeURIComponent(service)}` : ''}`
}

/**
 * Wächter für Seiten, die die Anmeldung nicht selbst verfolgen (Companion, „Nur für den Admin“):
 * lädt neu, sobald sich die Anmeldung ändert (public/watch-login.js). Der Server sagt ihm, für wen
 * die Seite gebaut ist – sonst merkt er sich erst beim ersten Nachfragen, wer angemeldet ist, und
 * übersieht einen Wechsel, der passiert, während die Seite noch im Hintergrund lädt.
 */
function watchTag(user) {
  const key = user && !user.open ? `${user.name}|${user.roleId}|${Boolean(user.admin)}|${user.sessionId || ''}|${user.version || ''}|${user.expiresAt || ''}` : null
  return `<script src="/.jms-auth/watch-login.js"${key === null ? '' : ` data-key="${escapeHtml(key)}"`} defer></script>`
}

function forbiddenPage(user, next, service) {
  return `<!doctype html>
<html lang="de" data-theme="system"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>JMS - Technik</title>
<script src="/.jms-auth/theme-boot.js"></script><link rel="stylesheet" href="/.jms-auth/admin.css">
${watchTag(user)}</head>
<body><div class="auth-page"><div class="card auth-card">
<div class="brand"><span class="brand-logo" aria-hidden="true"><i></i><i></i><i></i><i></i></span><span class="brand-text">Technik<small>Anmeldung</small></span></div>
<div><h1>Nur für den Admin</h1>
<p class="muted">Du bist als <b>${escapeHtml(user?.name)}</b> angemeldet. Dieser Bereich ist nur mit der Admin-Anmeldung erreichbar.</p></div>
<a class="btn primary block" href="${escapeHtml(`${loginPath(next, service)}&wechseln=1`)}">Als Admin anmelden</a>
<form action="/.jms-auth/logout" method="post"><button class="btn block" type="submit">Abmelden</button></form>
</div></div></body></html>`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}

// Caddy (forward_auth): 2xx = durchlassen, sonst wird diese Antwort an das Gerät weitergegeben
app.get('/.jms-auth/check', (req, res) => {
  res.set('Cache-Control', 'no-store')
  const service = String(req.query.service || '')
  const { action, user } = access.check({ service, ip: clientIp(req) }, req)
  if (action === 'allow') {
    const machine = !user && isMachine(req, '', service)
    res.set({ 'X-JMS-Gateway': machine ? 'machine' : 'central', 'X-JMS-Session-Id': user?.sessionId || '',
      'X-JMS-Device-Assertion': machine && service === 'kesher' ? deviceAssertion(access.machineOf(req), AUTH_SECRET) : '' })
    const forwardedMethod = req.get('x-forwarded-method') || 'GET'
    if (!['GET', 'HEAD', 'OPTIONS'].includes(forwardedMethod) && !sameOriginRequest(req))
      return res.status(403).json({ ok: false, error: 'Anfrage von einer fremden Seite abgelehnt' })
    const forwardedPath = String(req.get('x-forwarded-uri') || '').split('?')[0]
    if (service === 'kesher' && ['/api/login', '/api/login/takeover', '/api/admin/login'].includes(forwardedPath) && !machine)
      return res.status(403).json({ ok: false, error: 'Bitte die zentrale Anmeldung verwenden' })
    if (user && !user.open)
      res.set({ 'X-Jms-User': encodeURIComponent(user.name), 'X-Jms-Role': user.roleId, 'X-Jms-Admin': user.admin ? '1' : '0' })
    return res.status(204).end()
  }
  const next = safeNext(req.get('x-forwarded-uri'))
  // Seitenaufruf im Browser: zur Anmeldeseite. Alles andere (API, WebSocket): 401 mit dem Weg dorthin
  const wantsPage =
    (req.get('x-forwarded-method') || 'GET') === 'GET' && /text\/html/.test(req.get('accept') || '') && !req.get('upgrade')
  if (action === 'forbidden')
    return wantsPage ? res.status(403).type('html').send(forbiddenPage(user, next, service)) : res.status(403).json({ ok: false, error: 'Nur für den Admin' })
  if (wantsPage) return res.redirect(302, loginPath(next, service))
  res.set('X-Jms-Login', loginPath(next, service)).status(401).json({ ok: false, error: 'Bitte anmelden', login: loginPath(next, service) })
})

app.get('/.jms-auth/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')))

// Fremde Oberflächen hinter der zentralen Anmeldung (Companion) merken An- und Abmeldung in anderen
// Tabs nicht selbst. Caddy schickt ihre Seitenaufrufe (Accept: text/html) hierher (Baustein
// jms_watch im Caddyfile): Der Multiview holt die Seite vom Dienst und hängt watch-login.js ein,
// das bei geänderter Anmeldung neu lädt. Nur HTML, nur für Angemeldete mit Zugang zum Dienst –
// /.jms-auth/* ist auf jeder Adresse offen, das hier darf also kein Umweg an der Anmeldung vorbei sein.
const WATCHED_SERVICES = {
  companion: process.env.COMPANION_URL || 'http://127.0.0.1:8000',
  // Eigene Anmeldung am Dienst: der Admin wird dort automatisch angemeldet (siehe unten)
  portainer: process.env.PORTAINER_URL || 'https://127.0.0.1:9443',
  router: process.env.ROUTER_URL || 'http://192.168.0.250',
  dns: process.env.DNS_URL || 'http://127.0.0.1:8083',
  glances: process.env.GLANCES_URL || 'http://127.0.0.1:61208',
}
const WEBSOCKET_SERVICES = {
  ...WATCHED_SERVICES,
  kesher: process.env.KESHER_URL || 'http://127.0.0.1:8080',
  dashboard: process.env.DASHBOARD_URL || 'http://127.0.0.1:3000',
  glances: process.env.GLANCES_URL || 'http://127.0.0.1:61208',
}

/** Dienste, deren Seiten die Sitzung des Dienstes brauchen (Cookie des Browsers wird mitgeschickt). */
const PAGE_COOKIE_SERVICES = new Set(['router'])
/** Unsere eigenen Cookies gehen nie an einen fremden Dienst. */

/** Seite eines Dienstes holen; Portainer hat nur ein selbst signiertes Zertifikat (nur 127.0.0.1). */
function fetchUpstreamPage(url, userAgent, cookie = '') {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const lib = target.protocol === 'https:' ? https : http
    const request = lib.request(
      target,
      {
        method: 'GET',
        headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': userAgent || '', ...(cookie ? { Cookie: cookie } : {}) },
        rejectUnauthorized: !(target.protocol === 'https:' && target.hostname === '127.0.0.1'),
        timeout: 5000,
      },
      (response) => {
        const chunks = []
        response.on('data', (c) => chunks.push(c))
        response.on('end', () =>
          resolve({
            status: response.statusCode || 502,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        )
        response.on('error', reject)
      },
    )
    request.on('timeout', () => request.destroy(new Error('timeout')))
    request.on('error', reject)
    request.end()
  })
}

// ---------------------------------------------------------------------------
// Zugangsdaten der Dienste mit eigener Anmeldung (Portainer, Router). Der Admin trägt sie einmal
// in JMS Control ein; danach trägt ein kleines Skript sie auf der Anmeldeseite des Dienstes ein und
// schickt sie ab – aber nur, wenn der Admin über die zentrale Anmeldung dort ist. Die Passwörter
// liegen im Datenordner (nur für den Server lesbar) und gehen nie an andere als den angemeldeten Admin.
// ---------------------------------------------------------------------------

const SERVICE_CREDENTIALS_FILE = path.join(DATA_DIR, 'service-credentials.json')
const CREDENTIAL_SERVICES = {
  portainer: { label: 'Portainer', username: true },
  router: { label: 'Router (Speedport)', username: false },
}

function readServiceCredentials() {
  try {
    const data = JSON.parse(fs.readFileSync(SERVICE_CREDENTIALS_FILE, 'utf8'))
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function writeServiceCredentials(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${SERVICE_CREDENTIALS_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  fs.renameSync(tmp, SERVICE_CREDENTIALS_FILE)
}

// Diashow: Bilder für Monitore und Editor (feste Namen aus der Liste, nie ein Pfad vom Browser)
for (const [route, kind] of [['/diashow/bild/:file', 'bild'], ['/diashow/pp/:file', 'pp']]) {
  app.get(route, requireTrusted, requireDisplayReader, (req, res) => {
    const file = slideshow.filePath(kind, req.params.file)
    if (!file) return res.status(404).end()
    // Name ändert sich mit dem Inhalt – darf lange im Browser bleiben
    res.sendFile(file, { maxAge: '7d', immutable: true })
  })
}
app.get('/diashow/dropbox/:file', requireTrusted, requireDisplayReader, (req, res) => {
  const file = dropbox.filePath(req.params.file)
  if (!file) return res.status(404).end()
  res.sendFile(file, { maxAge: '7d', immutable: true })
})

// Dropbox (nur Admin): verbinden mit Code, Ordner wählen. Das Token bleibt auf dem Server.
const dropboxRoute = (handler) => async (req, res) => {
  try {
    const extra = (await handler(req)) || {}
    res.json({ ok: true, ...dropbox.settings(), ...extra })
  } catch (err) {
    res.status(err.status && err.status < 500 ? err.status : 400).json({ ok: false, error: err.message })
  }
}
app.get('/api/dropbox', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(dropbox.settings()))
app.post('/api/dropbox/authorize', requireAdmin, dropboxRoute((req) => ({ url: dropbox.authorizeUrl(req.body?.appKey) })))
app.post('/api/dropbox/connect', requireAdmin, dropboxRoute((req) => dropbox.connect(req.body?.code)))
app.delete('/api/dropbox', requireAdmin, dropboxRoute(() => dropbox.disconnect()))
app.get('/api/dropbox/folders', requireAdmin, dropboxRoute((req) => dropbox.browse(req.query.path)))
app.put('/api/dropbox/folder', requireAdmin, dropboxRoute((req) => dropbox.setFolder(req.body?.folder)))

const slideshowRoute = (handler) => async (req, res) => {
  try {
    res.json({ ok: true, ...((await handler(req)) || {}), ...slideshow.snapshot() })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
}
app.get('/api/slideshow', requireTrusted, requireDisplayReader, (req, res) => res.json(slideshow.snapshot()))
app.post('/api/slideshow/images', requireAdmin, express.raw({ type: () => true, limit: '26mb' }), slideshowRoute((req) => ({
  image: slideshow.addImage(req.body, { title: req.query.title, from: req.query.from, to: req.query.to }),
})))
app.patch('/api/slideshow/images/:id', requireAdmin, slideshowRoute((req) => ({ image: slideshow.updateImage(req.params.id, req.body || {}) })))
app.delete('/api/slideshow/images/:id', requireAdmin, slideshowRoute((req) => slideshow.removeImage(req.params.id)))
app.put('/api/slideshow/order', requireAdmin, slideshowRoute((req) => slideshow.reorder(req.body?.ids)))
app.put('/api/slideshow/propresenter', requireAdmin, slideshowRoute((req) => slideshow.setPpPlaylist(req.body?.playlist)))
app.post('/api/slideshow/propresenter/refresh', requireAdmin, slideshowRoute(() => slideshow.refreshPp()))
app.put('/api/slideshow/website', requireAdmin, slideshowRoute((req) => slideshow.setWebsiteUrl(req.body?.url)))
app.post('/api/slideshow/refresh', requireAdmin, slideshowRoute(() => slideshow.refreshExternal()))

// YouTube: Einstellungen (nur Admin). Der API-Schlüssel liegt in youtube-secret.json im Datenordner
// (nur für den Server lesbar) und geht nie an den Browser zurück.
app.get('/api/youtube', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(youtube.settings()))
app.put('/api/youtube', requireAdmin, async (req, res) => {
  try {
    const { apiKey, channel, video } = req.body || {}
    res.json({ ok: true, ...(await youtube.configure({ apiKey, channel, video })) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})
app.delete('/api/youtube', requireAdmin, (req, res) => {
  youtube.disconnect()
  res.json({ ok: true })
})
// Google-Anmeldung: liefert den Code für google.com/device; der Server wartet dann auf die Bestätigung
app.post('/api/youtube/google', requireAdmin, async (req, res) => {
  try {
    const { clientId, clientSecret } = req.body || {}
    res.json({ ok: true, ...(await youtube.googleStart({ clientId, clientSecret })) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})
app.delete('/api/youtube/google', requireAdmin, async (req, res) => res.json({ ok: true, ...(await youtube.googleLogout()) }))

// Monarch: Zugang (nur Admin). Das Passwort liegt in monarch.json im Datenordner und geht nie zurück.
app.get('/api/monarch', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(monarch.settings()))
app.put('/api/monarch', requireAdmin, async (req, res) => {
  try {
    const { host, user, password } = req.body || {}
    res.json({ ok: true, ...(await monarch.configure({ host, user, password })) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})
app.delete('/api/monarch', requireAdmin, (req, res) => {
  monarch.disconnect()
  res.json({ ok: true })
})
// Für jms-watch auf dem Server selbst (Telegram): nur vom Server, nicht über Caddy von außen
app.get('/api/youtube/status', (req, res) => {
  if (!/^(127\.|::1$|::ffff:127\.)/.test(clientIp(req))) return res.status(403).json({ ok: false })
  res.set('Cache-Control', 'no-store').json(youtube.status())
})

app.get('/api/service-credentials', requireAdmin, (req, res) => {
  const stored = readServiceCredentials()
  const out = {}
  for (const [id, def] of Object.entries(CREDENTIAL_SERVICES)) {
    out[id] = { label: def.label, username: def.username, set: Boolean(stored[id]?.password), user: def.username ? stored[id]?.username || '' : '' }
  }
  res.set('Cache-Control', 'no-store').json(out)
})

app.put('/api/service-credentials/:service', requireAdmin, (req, res) => {
  const def = CREDENTIAL_SERVICES[req.params.service]
  if (!def) return res.status(404).json({ ok: false, error: 'Unbekannter Dienst' })
  const password = String(req.body?.password ?? '')
  const username = def.username ? String(req.body?.username ?? '').trim() : ''
  if (!password || password.length > 200) return res.status(400).json({ ok: false, error: 'Passwort fehlt' })
  if (def.username && !username) return res.status(400).json({ ok: false, error: 'Benutzername fehlt' })
  const stored = readServiceCredentials()
  stored[req.params.service] = def.username ? { username, password } : { password }
  writeServiceCredentials(stored)
  res.json({ ok: true })
})

app.delete('/api/service-credentials/:service', requireAdmin, (req, res) => {
  if (!CREDENTIAL_SERVICES[req.params.service]) return res.status(404).json({ ok: false, error: 'Unbekannter Dienst' })
  const stored = readServiceCredentials()
  delete stored[req.params.service]
  writeServiceCredentials(stored)
  res.json({ ok: true })
})

// Die Anmeldeseite des Dienstes holt sich hier die Zugangsdaten – nur der angemeldete Admin, nur
// von der eigenen Seite (kein Zugriff aus fremden Tabs).
app.get('/.jms-auth/api/autologin/:service', (req, res) => {
  res.set('Cache-Control', 'no-store')
  const user = access.userOf(req)
  const site = req.get('sec-fetch-site')
  if (!CREDENTIAL_SERVICES[req.params.service] || !user?.admin || (site && site !== 'same-origin') || req.get('x-jms-autologin') !== '1') {
    return res.status(404).json({ ok: false })
  }
  const stored = readServiceCredentials()[req.params.service]
  if (!stored?.password) return res.status(404).json({ ok: false })
  res.json({ ok: true, username: stored.username || '', password: stored.password })
})

app.get(/^\/\.jms-auth\/page\/([a-z]+)(\/.*)?$/, async (req, res) => {
  const service = req.params[0]
  const upstream = WATCHED_SERVICES[service]
  if (!upstream) return res.status(404).end()
  const rest = req.params[1] || '/'
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : ''
  const { action, user } = access.check({ service, ip: clientIp(req) }, req)
  if (action !== 'allow') return res.redirect(302, loginPath(rest + query, service))
  let page
  try {
    page = await fetchUpstreamPage(
      `${upstream}${rest}${query}`,
      req.get('user-agent'),
      PAGE_COOKIE_SERVICES.has(service) ? withoutOwnCookies(req.headers.cookie) : '',
    )
  } catch {
    return res.status(502).type('text').send(`${service} ist gerade nicht erreichbar`)
  }
  const type = String(page.headers['content-type'] || '')
  for (const c of [].concat(page.headers['set-cookie'] || [])) if (PAGE_COOKIE_SERVICES.has(service)) res.append('Set-Cookie', c)
  if (page.status >= 300 && page.status < 400) {
    // Weiterleitungen auf die Adresse des Dienstes selbst (Router: http://192.168.0.250/…) bleiben auf dieser Adresse
    const origin = new URL(upstream).origin
    const target = String(page.headers.location || '/')
    return res.redirect(page.status, target.startsWith(origin) ? target.slice(origin.length) || '/' : target)
  }
  if (!/text\/html/i.test(type)) return res.status(404).end()
  // Eigene Anmeldung des Dienstes: den Admin automatisch anmelden, wenn Zugangsdaten hinterlegt sind
  const auto =
    user?.admin && CREDENTIAL_SERVICES[service] && readServiceCredentials()[service]?.password
      ? `<script src="/.jms-auth/autologin.js" data-service="${service}" defer></script>`
      : ''
  // JMS-Leiste unten links: zurück zum Dashboard, wer angemeldet ist, Konto wechseln, Abmelden
  const tag = watchTag(user) + auto + '<script src="/.jms-auth/jms-bar.js" defer></script>'
  const html = page.body
  res
    .status(page.status)
    .set({ 'Content-Type': type, 'Cache-Control': 'no-store' })
    .send(/<\/head>/i.test(html) ? html.replace(/<\/head>/i, `${tag}</head>`) : tag + html)
})

app.post('/.jms-auth/logout', (req, res) => {
  access.logout(req, res)
  res.redirect(302, loginPath(req.query.next))
})

// ---------------------------------------------------------------------------
// Abgleich der Anmeldung zwischen den Adressen. Unter der IP teilen sich alle Dienste ein Cookie
// (Cookies kennen keine Ports), intercom.local, jmscontrol.local usw. haben aber je ein eigenes.
// Die Anmeldeseite holt die Anmeldung darum per Weiterleitung von der zentralen Adresse
// (JMS_SSO_ORIGIN, z. B. https://192.168.0.21:8090) ab und bringt sie nach dem Anmelden dorthin.
// Abmelden beendet die Anmeldung unter allen Adressen (gleiche ID, siehe access.js).
// ---------------------------------------------------------------------------

const SSO_ORIGIN = String(process.env.JMS_SSO_ORIGIN || '').replace(/\/+$/, '')
const sso = createSsoHandlers({ access, centralOrigin: SSO_ORIGIN, ipOf: clientIp, loginPath,
  origins: process.env.JMS_SSO_ORIGINS ? process.env.JMS_SSO_ORIGINS.split(',').map((origin) => origin.trim()) : DEFAULT_ORIGINS })

app.get(['/api/sso', '/.jms-auth/api/sso'], (req, res) =>
  res.set('Cache-Control', 'no-store').json({ origin: access.enabled() && sso.central ? sso.central : null, central: sso.isCentral(req) }),
)

// Zentrale Adresse: die Anmeldung an eine andere Adresse weitergeben – oder sagen, dass es keine gibt
app.get('/.jms-auth/sso/start', sso.start)
app.get('/.jms-auth/sso/issue', sso.issue)

// Ticket einlösen: hier gilt dann dieselbe Anmeldung. Mit host (an der zentralen Adresse) geht es
// danach zurück zu der Adresse, an der man sich gerade angemeldet hat.
app.get('/.jms-auth/sso/accept', sso.accept)

// Nach dem Anmelden an einer anderen Adresse: die Anmeldung zur zentralen Adresse bringen
app.get('/.jms-auth/sso/push', sso.push)

app.post('/.jms-auth/api/session-status', (req, res) => {
  if (!verifySignedRequest(AUTH_SECRET, 'introspect', req.body)) return res.status(403).json({ active: false })
  res.json(access.sessionStatusById(req.body.sessionId))
})

app.post('/.jms-auth/api/revoke-admin', (req, res) => {
  if (!verifySignedRequest(AUTH_SECRET, 'revoke-admin', req.body)) return res.status(403).json({ ok: false })
  access.revokeAdmins('Admin-PIN geändert')
  res.json({ ok: true })
})

// Tagescode: braucht dieses Gerät ihn noch?
app.get(['/api/device', '/.jms-auth/api/device'], (req, res) => {
  access.refreshDeviceCookie(req, res)
  res.set('Cache-Control', 'no-store').json(access.deviceStatus(clientIp(req), req))
})

app.post(['/api/device', '/.jms-auth/api/device'], (req, res) => {
  try {
    // Nicht nur wenn nötig (required): Beim Rollenwechsel aus einer Admin-Sitzung heraus braucht
    // das Gerät die Freigabe für die neue Rolle – vorher wurde der Code dann stillschweigend nicht
    // eingelöst, und die Anmeldung fragte immer wieder nach ihm
    const status = access.deviceStatus(clientIp(req), req)
    if (status.required || status.grantable) access.redeemDayCode(req.body?.code, clientIp(req), req, res)
    res.json({ ok: true })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})

// Der QR-Code öffnet diese Adresse: Code übernehmen, dann weiter zu Name und Rolle
app.get('/.jms-auth/code', (req, res) => {
  const next = safeNext(req.query.next)
  try {
    const status = access.deviceStatus(clientIp(req), req)
    if (status.required || status.grantable) access.redeemDayCode(req.query.c, clientIp(req), req, res)
    res.redirect(302, loginPath(next))
  } catch (err) {
    res.redirect(302, `${loginPath(next)}&code=${err.status === 429 ? 'gesperrt' : 'falsch'}`)
  }
})

/**
 * Darf die Person eine Kesher-Kachel mit dieser Rolle sehen? Dann darf die Kachel die Rolle in
 * Kesher spiegeln (Zweitgerät: zeigt und steuert das echte Gerät der Rolle, belegt sie aber nie).
 */
function mayMirrorRole(user, roleId) {
  if (!roleId || typeof roleId !== 'string' || roleId.length > 128) return false
  if (user.admin || user.roleId === roleId) return true
  return viewConfig(config, user).layouts.some((layout) =>
    (layout.tiles || []).some((tile) => tile.kind === 'kesher' && tile.kesherRoleId === roleId))
}

// Signiertes Ticket, mit dem sich Kesher den Nutzer selbst anmeldet – mit ?mirror=<Rolle> für
// eine Kesher-Kachel, die diese Rolle nur spiegelt
app.get('/.jms-auth/api/ticket', requireUser, (req, res) => {
  try {
    if (req.user.open) return res.status(400).json({ ok: false, error: 'Anmeldung ist nicht eingeschaltet' })
    const mirror = req.query.mirror === undefined ? null : String(req.query.mirror)
    if (mirror !== null && !mayMirrorRole(req.user, mirror))
      return res.status(403).json({ ok: false, error: 'Diese Intercom-Rolle ist für dich nicht freigegeben' })
    res.set('Cache-Control', 'no-store').json({ ok: true, ticket: access.createTicket(req.user, String(req.query.aud || ''), AUTH_SECRET, { mirror }) })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})

// Admin: Einstellungen, Tagescode und freigeschaltete Geräte
function gatewayInfo() {
  const code = access.dayCode()
  return { ...access.gateway(), machines: access.listMachines(), code: code.code, day: code.day, devicesToday: access.devicesToday(), secret: Boolean(AUTH_SECRET) }
}

/**
 * Tagescode für die Monitore (klein in einer Ecke). Nur für Geräte, die den Code ohnehin nicht
 * brauchen – den Server selbst (Kiosk), feste Geräte ohne Code, schon freigeschaltete Geräte
 * oder den Admin. Sonst könnte jedes Handy im WLAN den Code einfach hier abholen.
 */
app.get('/api/display/day-code', (req, res) => {
  res.set('Cache-Control', 'no-store')
  const gateway = access.gateway()
  if (!gateway.active) return res.json({ show: false })
  const user = access.userOf(req)
  if (!user?.admin && !isMachine(req, 'day-code'))
    return res.status(403).json({ show: false, error: 'Nur für feste Geräte' })
  const output = config.outputs.find((item) => item.id === req.query.output)
  if (!output?.dayQr?.show) return res.json({ show: false })
  const code = access.dayCode()
  res.json({ show: true, code: code.code, day: code.day, startUrl: gateway.startUrl, corner: output.dayQr.corner, size: output.dayQr.size })
})

app.get('/api/access/gateway', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json(gatewayInfo()))

app.get('/api/access/machines', requireAdmin, (req, res) => res.json(access.listMachines()))
app.post('/api/access/machines', requireAdmin, (req, res) => {
  try { res.status(201).json({ ok: true, ...access.createMachine(req.body) }) }
  catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }) }
})
app.post('/api/access/machines/:id/rotate', requireAdmin, (req, res) => {
  try { res.json({ ok: true, ...access.rotateMachine(req.params.id, req.body) }) }
  catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }) }
})
app.delete('/api/access/machines/:id', requireAdmin, (req, res) => {
  try { access.revokeMachine(req.params.id); res.json({ ok: true }) }
  catch (error) { res.status(error.status || 400).json({ ok: false, error: error.message }) }
})
app.post('/.jms-auth/api/machine-status', (req, res) => {
  if (!verifySignedRequest(AUTH_SECRET, 'machine', req.body)) return res.status(403).json({ active: false })
  res.json(access.machineStatus(req.body.deviceId, req.body.version))
})

app.put('/api/access/gateway', requireAdmin, (req, res) => {
  try {
    const { enabled, exempt, startUrl } = req.body || {}
    access.setGateway({ enabled, exempt, startUrl })
    res.json({ ok: true, ...gatewayInfo() })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})

app.post('/api/access/code/renew', requireAdmin, (req, res) => {
  access.renewDayCode()
  res.json({ ok: true, ...gatewayInfo() })
})

// QR-Leser für das Scannen des Tagescodes auf der Anmeldeseite (iPhone-Safari hat keinen eingebauten)
app.get(['/vendor/jsQR.js', '/.jms-auth/vendor/jsQR.js'], (req, res) =>
  res.set('Cache-Control', 'public, max-age=86400').sendFile(require.resolve('jsqr/dist/jsQR.js')),
)

// Admin: Rollen anlegen, umbenennen und löschen. Sie werden in Kesher gespeichert (über eine kurze
// Admin-Sitzung mit Ticket); die Multiview-Rechte der Rolle stehen hier in config.access.roles.
const kesherRolesFor = (user) => createKesherRoles({
  getUrl: () => config.chat?.url,
  getTicket: () => access.createTicket(user, 'kesher', AUTH_SECRET),
})

/** Kesher-Rollen gleich neu laden, damit Anmeldung und Rechte-Tabelle sie sofort kennen. */
const refreshRoles = () => kesherChat.refresh().catch((err) => console.log(`Kesher-Chat: Rollen nicht neu geladen – ${err.message}`))

const roleError = (res, err) => res.status(err.status || 400).json({ ok: false, error: err.message })

app.post('/api/access/roles', requireAdmin, async (req, res) => {
  try {
    const copyFrom = String(req.body?.copyFrom || '')
    const role = await kesherRolesFor(req.user).create({ name: req.body?.name, copyFrom })
    // Mit Vorlage: auch die Multiview-Rechte übernehmen
    if (copyFrom && config.access?.roles?.[copyFrom]) {
      config.access.roles[role.id] = structuredClone(config.access.roles[copyFrom])
      configChanged()
    }
    console.log(`Zugang: Rolle „${role.name}“ (${role.id}) angelegt${copyFrom ? ` als Kopie von ${copyFrom}` : ''}`)
    await refreshRoles()
    res.json({ ok: true, role })
  } catch (err) {
    roleError(res, err)
  }
})

app.put('/api/access/roles/:id', requireAdmin, async (req, res) => {
  try {
    const role = await kesherRolesFor(req.user).rename(req.params.id, req.body?.name)
    console.log(`Zugang: Rolle ${role.id} heißt jetzt „${role.name}“`)
    await refreshRoles()
    res.json({ ok: true, role })
  } catch (err) {
    roleError(res, err)
  }
})

app.delete('/api/access/roles/:id', requireAdmin, async (req, res) => {
  const id = req.params.id
  try {
    if (id === config.chat?.roleId) throw Object.assign(new Error('Mit dieser Rolle zeigt JMS Control den Kesher-Chat – sie bleibt'), { status: 409 })
    const holder = access.occupiedRoles()[id]
    if (holder) throw Object.assign(new Error(`„${holder}“ ist gerade mit dieser Rolle angemeldet – erst abmelden (Angemeldete Geräte)`), { status: 409 })
    await kesherRolesFor(req.user).remove(id)
    if (config.access?.roles?.[id]) {
      delete config.access.roles[id]
      configChanged()
    }
    console.log(`Zugang: Rolle ${id} gelöscht`)
    await refreshRoles()
    res.json({ ok: true })
  } catch (err) {
    roleError(res, err)
  }
})

// Anmeldeseite und ihre Dateien auch unter /.jms-auth (auf der Adresse jedes Dienstes)
app.use('/.jms-auth', require('./legacy').legacyMiddleware(path.join(__dirname, 'public')))
app.use('/.jms-auth', express.static(path.join(__dirname, 'public')))

/** Folie zum Wiedereinblenden: die laufende, sonst die vor dem Ausblenden gemerkte. */
function restoreTarget() {
  const t = ppState.presentation ? ppState : ppState.held
  return t?.presentation && t.index != null ? t : null
}

// ProPresenter steuern – NUR diese Befehle (Weiter, Zurück, Ausblenden, Einblenden, Folie wählen).
// Alles andere der Schnittstelle bleibt gesperrt.
app.post('/api/propresenter/control', requireTrusted, requireSlideOperator, async (req, res) => {
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
    restore: restoreTarget()
      ? [`/v1/presentation/${encodeURIComponent(restoreTarget().presentation.uuid)}/${restoreTarget().index}/trigger`]
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

// Bühnennachricht setzen/löschen – von der Bühnen-Kachel (POST { text }) und aus Companion
// (GET …/stage-message?text=… bzw. …/stage-message/clear). Leerer Text löscht.
async function handleStageMessage(req, res, text) {
  const value = String(text ?? '').trim().slice(0, 500)
  try {
    await setStageMessage(value)
    console.log(`ProPresenter: Bühnennachricht ${value ? `„${value}“` : 'gelöscht'} (von ${req.ip})`)
    if (value) notifyChat(access.userOf(req), `Bühnennachricht (Stage Display): „${value}“`)
    res.json({ ok: true, message: value })
  } catch (err) {
    res.status(err.status || 502).json({ ok: false, error: err.name === 'TimeoutError' ? 'ProPresenter antwortet nicht' : err.message })
  }
}
app.all('/api/propresenter/stage-message/clear', requireTrusted, requireMutation, (req, res) => handleStageMessage(req, res, ''))

/**
 * Wichtigen Hinweis in den Kesher-Chat schreiben (rot markiert) – als die Rolle des Nutzers,
 * sonst (Admin, offener Zugang, Companion) als Chat-Monitor. Fehler nur protokollieren.
 */
async function notifyChat(user, message) {
  const roleId = user && !user.open && !user.admin ? user.roleId : config.chat.roleId
  try {
    await kesherChat.sendText({ roleId, username: user && !user.open ? user.name : '', message, roomId: '', alert: true })
    return true
  } catch (err) {
    console.log(`Kesher: Hinweis nicht gesendet (${err.message})`)
    return false
  }
}

// Beamer-Meldung vorbereiten: Text in die ProPresenter-Meldung eintragen (angezeigt wird sie nur
// vom ProPresenter-Bediener) und im Kesher-Chat Bescheid geben.
app.post('/api/propresenter/announce', requireUser, async (req, res) => {
  const user = req.user
  const from = user.open ? '' : `${user.name}${user.roleName && !user.admin ? ` (${user.roleName})` : ''}`
  let request
  try {
    request = await prepareAnnouncement(
      { uuid: req.body?.uuid ? String(req.body.uuid) : '', fields: req.body?.fields || {}, text: req.body?.text },
      from,
      senderKey(user),
    )
  } catch (err) {
    return res.status(err.status || 502).json({ ok: false, error: err.name === 'TimeoutError' ? 'ProPresenter antwortet nicht' : err.message })
  }
  console.log(`ProPresenter: Beamer-Meldung vorbereitet „${request.text}“ (${from || req.ip})`)
  // Immer im Chat Bescheid geben (rot)
  const notified = await notifyChat(
    user,
    `Beamer-Meldung wartet in ProPresenter: „${request.text}“ – bitte „${FREE_MESSAGE_NAME}“ unter Meldungen anzeigen`,
  )
  res.json({ ok: true, request: publicRequests().find((r) => r.id === request.id), notified })
})
// Beamer-Meldung zurückziehen (Handy): nur die eigene, nur solange sie wartet oder läuft – einmal.
// Der Text in der „Multiview-Meldung“ wird geleert (falls dort noch genau diese Meldung steht);
// läuft sie schon auf dem Beamer, bekommt der Bediener im Chat Bescheid, sie auszublenden.
app.post('/api/propresenter/announce/:id/withdraw', requireUser, requireMutation, async (req, res) => {
  const user = req.user
  const request = announceRequests.find((r) => r.id === req.params.id)
  if (!request) return res.status(404).json({ ok: false, error: 'Diese Meldung gibt es nicht mehr' })
  if (!user.admin && (!request.by || request.by !== senderKey(user)))
    return res.status(403).json({ ok: false, error: 'Nur die eigene Meldung lässt sich zurückziehen' })
  if (request.status !== 'wartet' && request.status !== 'angezeigt')
    return res.status(409).json({ ok: false, error: 'Diese Meldung ist schon vorbei' })
  const wasShown = request.status === 'angezeigt'
  try {
    const list = (await ppGet('/v1/messages')) ?? []
    const inbox = list.find((m) => m.id?.uuid === request.uuid)
    const token = inbox?.tokens?.find((t) => t.name === FREE_MESSAGE_TOKEN)
    // Nur leeren, wenn dort noch genau diese Meldung steht (nicht schon eine neuere)
    if (inbox && token && String(token.text?.text ?? '') === request.text)
      await putMessage({ ...inbox, tokens: inbox.tokens.map((t) => (t === token ? { ...t, text: { ...t.text, text: '' } } : t)) })
  } catch (err) {
    return res.status(err.status || 502).json({ ok: false, error: err.name === 'TimeoutError' ? 'ProPresenter antwortet nicht' : err.message })
  }
  request.status = 'zurückgezogen'
  stageMessagesAt = 0
  requestStagePoll()
  console.log(`ProPresenter: Beamer-Meldung zurückgezogen „${request.text}“ (${user.name || req.ip})`)
  await notifyChat(
    user,
    wasShown
      ? `Beamer-Meldung zurückgezogen: „${request.text}“ – läuft noch, bitte „${FREE_MESSAGE_NAME}“ in ProPresenter ausblenden`
      : `Beamer-Meldung zurückgezogen: „${request.text}“`,
  )
  res.json({ ok: true })
})

// ---------------------------------------------------------------------------
// Nachrichten-Links (message-links.js): Ordner & Co. schicken ohne Anmeldung eine Meldung auf
// den Beamer (vorbereitet, angezeigt vom ProPresenter-Bediener) oder das Stage Display.
// Seite: /nachricht.html?k=<Token>. Verwalten nur der Admin (Benutzer & Rechte → Nachrichten-Links).
// ---------------------------------------------------------------------------
const messageLinks = createMessageLinks({ dataDir: DATA_DIR })
const linkStage = new Map() // Link-ID → zuletzt über diesen Link gesetzte Bühnennachricht (nur die darf er löschen)

app.get('/api/message-links', requireAdmin, (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, links: messageLinks.list() }))
app.post('/api/message-links', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, link: messageLinks.create(req.body) })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})
app.put('/api/message-links/:id', requireAdmin, (req, res) => {
  try {
    res.json({ ok: true, link: messageLinks.update(req.params.id, req.body) })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})
app.delete('/api/message-links/:id', requireAdmin, (req, res) => {
  try {
    messageLinks.remove(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(err.status || 400).json({ ok: false, error: err.message })
  }
})

function linkOf(req, res) {
  res.set('Cache-Control', 'no-store')
  const link = messageLinks.byToken(req.params.token)
  if (!link) res.status(404).json({ ok: false, error: 'Dieser Link gilt nicht (mehr). Bitte beim Technik-Team einen neuen holen.' })
  return link
}

app.get('/api/nachricht/:token', (req, res) => {
  const link = linkOf(req, res)
  if (!link) return
  res.json({
    ok: true,
    name: link.name,
    stage: link.stage,
    beamer: link.beamer,
    connected: stageState.connected,
    stageMessage: link.stage ? stageState.message : '',
    ownStage: link.stage && Boolean(stageState.message) && linkStage.get(link.id) === stageState.message,
    templates: link.beamer ? stageState.templates.filter((t) => !t.free) : [],
    requests: link.beamer ? publicRequests().filter((r) => r.link === link.id && r.status !== 'ersetzt').slice(0, 3) : [],
  })
})

app.post('/api/nachricht/:token', async (req, res) => {
  const link = linkOf(req, res)
  if (!link) return
  const from = messageLinks.cleanName(req.body?.from)
  const target = req.body?.target
  const fail = (err) =>
    res.status(err.status || 502).json({ ok: false, error: err.name === 'TimeoutError' ? 'ProPresenter antwortet nicht' : err.message })
  if (!from) return res.status(400).json({ ok: false, error: 'Bitte deinen Namen eingeben' })
  const who = `${from} (${link.name})`
  try {
    if (target === 'stage') {
      if (!link.stage) return res.status(403).json({ ok: false, error: 'Dieser Link darf nicht aufs Stage Display schicken' })
      const text = String(req.body?.text ?? '').trim().slice(0, 200)
      if (!text) {
        // Löschen nur, was über diesen Link kam – eine Nachricht der Technik bleibt stehen
        if (linkStage.get(link.id) !== stageState.message) return res.status(403).json({ ok: false, error: 'Diese Nachricht kam nicht von hier' })
        await setStageMessage('')
        linkStage.delete(link.id)
        console.log(`ProPresenter: Bühnennachricht gelöscht (Nachrichten-Link „${link.name}“, ${from})`)
        return res.json({ ok: true })
      }
      messageLinks.check(link)
      await setStageMessage(text)
      messageLinks.record(link)
      linkStage.set(link.id, text)
      console.log(`ProPresenter: Bühnennachricht „${text}“ (Nachrichten-Link „${link.name}“, ${from})`)
      notifyChat(null, `Bühnennachricht (Stage Display) von ${who}: „${text}“`)
      return res.json({ ok: true })
    }
    if (target === 'beamer') {
      if (!link.beamer) return res.status(403).json({ ok: false, error: 'Dieser Link darf nicht auf den Beamer schicken' })
      messageLinks.check(link)
      const request = await prepareAnnouncement(
        { uuid: req.body?.uuid ? String(req.body.uuid) : '', fields: req.body?.fields || {}, text: req.body?.text },
        who,
      )
      messageLinks.record(link)
      request.link = link.id
      console.log(`ProPresenter: Beamer-Meldung vorbereitet „${request.text}“ (Nachrichten-Link „${link.name}“, ${from})`)
      const notified = await notifyChat(
        null,
        `Beamer-Meldung von ${who} wartet in ProPresenter: „${request.text}“ – bitte „${FREE_MESSAGE_NAME}“ unter Meldungen anzeigen`,
      )
      return res.json({ ok: true, notified })
    }
    res.status(400).json({ ok: false, error: 'Ziel fehlt (Beamer oder Stage Display)' })
  } catch (err) {
    fail(err)
  }
})

app.all('/api/propresenter/stage-message', requireTrusted, requireMutation, (req, res) => {
  const text = req.body?.text ?? req.query.text
  // Ohne Text nichts tun (ein versehentlich geöffneter Link soll die Nachricht nicht löschen)
  if (text == null) return res.status(400).json({ ok: false, error: 'text fehlt, z. B. ?text=Noch%205%20Minuten' })
  handleStageMessage(req, res, text)
})

// Folienbilder von ProPresenter weiterreichen (Browser brauchen so nur diesen Server)
// Playlists von ProPresenter für die Auswahl „feste Playlist“ im Layout-Editor
app.get('/api/propresenter/playlists', requireUser, async (req, res) => {
  if (!ppBase()) return res.json({ ok: false, error: 'ProPresenter ist nicht eingerichtet', playlists: [] })
  try {
    res.json({ ok: true, playlists: flattenPpPlaylists(await ppGet('/v1/playlists')) })
  } catch (err) {
    res.json({ ok: false, error: `ProPresenter nicht erreichbar (${err.message})`, playlists: [] })
  }
})

app.get('/api/propresenter/thumb/:uuid/:index', requireTrusted, requireDisplayReader, async (req, res) => {
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
app.get('/api/chat', requireTrusted, requireChatReader, (req, res) => res.json(messageForRequest(kesherChat.snapshot(), req)))

// ChurchTools: Verbindung mit dem Server-Konto (Token oder Benutzername/Passwort).
// Das Passwort wird nur zum Holen des Login-Tokens benutzt und nicht gespeichert.
app.get('/api/churchtools', requireTrusted, requireDisplayReader, (req, res) => res.json(messageForRequest(churchTools.snapshot(), req)))
app.post('/api/churchtools/connect', requireAdmin, async (req, res) => {
  try {
    const { url, token, username, password } = req.body || {}
    res.json({ ok: true, ...(await churchTools.connect({ url, token, username, password })) })
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message })
  }
})
app.post('/api/churchtools/disconnect', requireAdmin, (req, res) => {
  churchTools.disconnect()
  res.json({ ok: true })
})
app.post('/api/churchtools/refresh', requireAdmin, async (req, res) => {
  await churchTools.refresh()
  res.json(churchTools.snapshot())
})

// WebRTC-Anmeldung (WHEP) an MediaMTX weiterreichen, damit Browser nur diesen Port brauchen
app.post('/whep/:path', requireTrusted, requireDisplayReader, express.text({ type: () => true, limit: '1mb' }), async (req, res) => {
  if (!configForRequest(req).sources.some((source) => source.type === 'stream' && streamPath(source) === req.params.path)) return res.status(403).send('Keine Berechtigung für diese Quelle')
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

app.put('/api/config', requireUser, (req, res) => {
  // Ohne Admin-Rechte nur die eigenen Layouts und die Layout-Wahl der eigenen Multiviews
  config = normalizeConfig(req.user.admin ? req.body : applyRestrictedChanges(config, req.body, req.user))
  configChanged(req.get('X-Client-Id') || null)
  res.json({ ok: true })
})

app.get('/api/templates', requireUser, (req, res) => res.json(templateList(req.user)))

app.get('/api/templates/:id', requireUser, (req, res) => {
  const t = readTemplate(templateId(req.params.id))
  if (!t || !templateVisible(t, req.user)) return res.status(404).json({ ok: false, error: 'Vorlage nicht gefunden' })
  if (req.query.download !== undefined) {
    res.attachment(`${t.id}.json`)
    return res.send(JSON.stringify({ name: t.name, savedAt: t.savedAt, layout: t.layout }, null, 2))
  }
  res.json(t)
})

// Speichert unter dem Namen; eine eigene Vorlage mit gleichem Namen wird überschrieben.
app.post('/api/templates', requireUser, (req, res) => {
  if (!roleRights(config, req.user)?.admin && !roleRights(config, req.user)?.editLayouts)
    return res.status(403).json({ ok: false, error: 'Deine Rolle darf keine Layouts einrichten' })
  const name = String(req.body?.name ?? '').trim()
  const id = templateId(name)
  if (!id) return res.status(400).json({ ok: false, error: 'Bitte einen Namen angeben' })
  if (!Array.isArray(req.body?.layout?.tiles)) return res.status(400).json({ ok: false, error: 'Keine Kacheln in der Vorlage' })
  const existing = readTemplate(id)
  if (existing && !req.user.admin && existing.owner !== req.user.roleId)
    return res.status(403).json({ ok: false, error: `„${existing.name}“ gehört einer anderen Rolle – bitte anderen Namen wählen` })
  const data = {
    name,
    savedAt: new Date().toISOString(),
    // Beim Überschreiben bleibt der Besitzer; neue Vorlagen des Admins gehören niemandem (für alle)
    owner: existing ? existing.owner : req.user.admin ? null : req.user.roleId,
    layout: normalizeTemplateLayout(req.body.layout),
  }
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true })
  const tmp = `${templateFile(id)}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, templateFile(id))
  templatesChanged()
  res.json({ ok: true, id, name })
})

app.delete('/api/templates/:id', requireUser, (req, res) => {
  const t = readTemplate(templateId(req.params.id))
  if (!t || !templateVisible(t, req.user)) return res.status(404).json({ ok: false, error: 'Vorlage nicht gefunden' })
  if (!req.user.admin && t.owner !== req.user.roleId)
    return res.status(403).json({ ok: false, error: 'Nur der Admin oder die eigene Rolle darf löschen' })
  fs.unlinkSync(templateFile(t.id))
  templatesChanged()
  res.json({ ok: true })
})

app.get('/api/state', requireTrusted, requireDisplayReader, (req, res) => {
  const visible = configForRequest(req)
  res.json({
    atem: atemState,
    propresenter: ppState,
    propresenterStage: stageState,
    layouts: visible.layouts.map((l, i) => ({ nr: i + 1, id: l.id, name: l.name })),
    outputs: visible.outputs.map((o, i) => ({
      nr: i + 1,
      id: o.id,
      name: o.name,
      layout: config.layouts.find((l) => l.id === o.layoutId)?.name ?? null,
    })),
    screens: screenList().filter((screen) => req.user?.admin || isMachine(req, 'display') || isMachine(req, 'control') || visible.screens.some((entry) => entry.id === screen.id)).map((s, i) => ({
      nr: i + 1,
      id: s.id,
      name: s.name,
      connected: s.connected,
      output: config.outputs.find((o) => o.id === s.outputId)?.name ?? null,
    })),
  })
})

// Companion-freundliche Endpunkte (GET oder POST, z. B. über das "Generic HTTP"-Modul)

app.all('/api/output/:output/layout/:layout', requireTrusted, requireMutation, (req, res) => {
  const output = findByRef(config.outputs, req.params.output)
  const layout = findByRef(config.layouts, req.params.layout)
  if (!output) return res.status(404).json({ ok: false, error: 'Ausgang nicht gefunden' })
  if (!layout) return res.status(404).json({ ok: false, error: 'Layout nicht gefunden' })
  if (!isMachine(req, 'control') && (!editableOutputs(config, req.user).has(output.id) || !visibleLayouts(config, req.user).some((entry) => entry.id === layout.id)))
    return res.status(403).json({ ok: false, error: 'Keine Berechtigung für Multiview oder Layout' })
  output.layoutId = layout.id
  configChanged()
  res.json({ ok: true, output: output.name, layout: layout.name })
})

app.all('/api/output/:output/:dir(next|prev)', requireTrusted, requireMutation, (req, res) => {
  const output = findByRef(config.outputs, req.params.output)
  if (!output) return res.status(404).json({ ok: false, error: 'Ausgang nicht gefunden' })
  if (!isMachine(req, 'control') && !editableOutputs(config, req.user).has(output.id)) return res.status(403).json({ ok: false, error: 'Keine Berechtigung für Multiview' })
  const choices = isMachine(req, 'control') ? config.layouts : visibleLayouts(config, req.user)
  if (!choices.length) return res.status(404).json({ ok: false, error: 'Keine Layouts vorhanden' })
  const step = req.params.dir === 'next' ? 1 : -1
  const current = choices.findIndex((l) => l.id === output.layoutId)
  const layout = choices[(current + step + choices.length) % choices.length]
  output.layoutId = layout.id
  configChanged()
  res.json({ ok: true, output: output.name, layout: layout.name })
})

// Bildschirm am Server auf einen Multiview schalten ("aus" = schwarz)
app.all('/api/screen/:screen/output/:output', requireTrusted, requireMutation, requireOperator, (req, res) => {
  const screen = findByRef(screenList(), req.params.screen)
  if (!screen) return res.status(404).json({ ok: false, error: 'Bildschirm nicht gefunden' })
  const off = ['aus', 'off', '0'].includes(req.params.output.toLowerCase())
  const output = off ? null : findByRef(config.outputs, req.params.output)
  if (!off && !output) return res.status(404).json({ ok: false, error: 'Multiview nicht gefunden' })
  setScreenOutput(screen.id, output?.id ?? null)
  configChanged()
  res.json({ ok: true, screen: screen.name, output: output?.name ?? null })
})

app.all('/api/layout/:layout/tile/:tile/source/:source', requireTrusted, requireMutation, (req, res) => {
  const layout = findByRef(config.layouts, req.params.layout)
  const tile = layout && findByRef(layout.tiles, req.params.tile)
  const source = findByRef(config.sources, req.params.source)
  if (!tile) return res.status(404).json({ ok: false, error: 'Layout oder Kachel nicht gefunden' })
  if (!source) return res.status(404).json({ ok: false, error: 'Quelle nicht gefunden' })
  if (!isMachine(req, 'control') && !canEditLayout(config, req.user, layout)) return res.status(403).json({ ok: false, error: 'Keine Berechtigung für Layout' })
  tile.kind = 'source'
  tile.sourceId = source.id
  configChanged()
  res.json({ ok: true, layout: layout.name, source: source.name })
})

server.on('upgrade', (req, socket, head) => {
  const reject = (status) => {
    socket.end(`HTTP/1.1 ${status} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  }
  socket.on('error', () => {})
  if (!sameOriginRequest(req)) return reject(403)
  let url
  try { url = new URL(req.url, 'http://localhost') } catch { return reject(403) }
  if (url.pathname === '/ws') {
    if (!access.trusted(clientIp(req), req)) return reject(401)
    return wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }
  const match = /^\/\.jms-auth\/ws\/([a-z]+)(\/.*)?$/.exec(url.pathname)
  const service = match?.[1]
  const upstream = service && WEBSOCKET_SERVICES[service]
  if (!upstream) return reject(403)
  const decision = access.check({ service, ip: clientIp(req) }, req)
  if (decision.action !== 'allow') return reject(decision.action === 'forbidden' ? 403 : 401)
  req.headers['x-jms-gateway'] = !decision.user && isMachine(req, '', service) ? 'machine' : 'central'
  req.headers['x-jms-session-id'] = decision.user?.sessionId || ''
  req.headers['x-jms-device-assertion'] = !decision.user && service === 'kesher' ? deviceAssertion(access.machineOf(req), AUTH_SECRET) : ''
  return proxyWebSocket(req, socket, head, {
    upstream, upstreamPath: `${match[2] || '/'}${url.search}`, guard: socketGuard,
    sessionId: access.sessionIdOf(req), stripCookies: withoutOwnCookies,
    valid: () => access.check({ service, ip: clientIp(req) }, req).action === 'allow',
  })
})

const expiryTimer = setInterval(() => access.sweep(), 1000)
expiryTimer.unref()

server.listen(PORT, HOST, () => {
  console.log('JMS Control läuft:')
  console.log(`  Webseite: http://localhost:${PORT}/`)
  for (const a of lanAddresses()) console.log(`            http://${a}:${PORT}/`)
  console.log(`  Monitor:  http://localhost:${PORT}/output.html?id=1`)
  kesherChat.start()
  if (process.env.JMS_DISABLE_HARDWARE === '1') return
  if (process.env.JMS_SATELLITE_TLS_DIR) {
    const directory = process.env.JMS_SATELLITE_TLS_DIR
    const bridge = startSatelliteBridge({ access, caFile: path.join(directory, 'ca.crt'), certFile: path.join(directory, 'server.crt'), keyFile: path.join(directory, 'server.key') })
    bridge.server.on('error', (error) => { console.error('Satellite-TLS nicht verfügbar:', error.code); process.exit(1) })
  }
  refreshScreens()
  setInterval(refreshScreens, 3000)
  applyAtemIp()
  applyProPresenter()
  startMediamtx()
  churchTools.start()
  monarch.start()
  youtube.start()
  slideshow.start()
  dropbox.start()
  applyUplink()
  uplink.start()
})
