import { connect, findByRef, sourceLabel, channelName, meterKeyFor, tileChannels, tallyOf, applyBox, keepTouchScrollInside } from './common.js'
import { createMeter, createMeterBank, setLevels, meterOptions } from './meters.js'
import { createChatView } from './chat.js'
import { chatFor, chatRoleFor } from './rights.js'
import { createComposer } from './chat-compose.js'
import { createAgendaView } from './agenda.js'
import { createProPresenterView, createPlaylistView, createPreacherView } from './propresenter.js'
import { createStageView } from './stage.js'
import {
  attachDevice, attachNetworkStream, makeVideo, makeTestPattern, mediaKey, releaseUnusedStreams, listVideoDevices,
} from './media.js'

// ?id=<ID, Name oder Nummer> wählt den Ausgang, ?embed=1 für die Vorschau auf der Webseite.
// ?screen=<Anschluss> (z. B. HDMI-A-1) zeigt den Multiview, der im Editor diesem Bildschirm
// am Server zugeordnet ist, und schaltet live um. Der feste Fenstertitel sagt dem Kiosk,
// auf welchen Anschluss das Fenster gehört.
const params = new URLSearchParams(location.search)
const screenRef = params.get('screen')
const outputRef = params.get('id') || '1'
const embedded = params.has('embed')
document.body.classList.toggle('embedded', embedded)

const stage = document.getElementById('stage')
const frameLayer = document.getElementById('frames')
const badgeServer = document.getElementById('badge-server')
const badgeAtem = document.getElementById('badge-atem')
const fsButton = document.getElementById('fs-button')

let config = null
let atem = { connected: false, program: [], preview: [], inputs: {} }
let renderedKey = ''
let tiles = [] // { el, tile, source, labelEl, labelText }
let bankLabels = [] // Namensfelder der Pegel-Fenster: { el, channel }
let ppViews = [] // ProPresenter-Kacheln
let propresenter = { connected: false }
const stageViews = new Set() // ProPresenter-Bühne
let ppStage = { connected: false, message: '', timers: [], videoCountdown: '', messages: [] }
const clocks = new Set()
const chatViews = new Set() // Chat-Kacheln
const composers = new Set() // Eingabefelder der Chat-Kacheln (angemeldet)
// Angemeldeter Nutzer (falls diese Seite angemeldet geöffnet ist): Chat und Intercom gehen mit ihm mit
let viewer = null
fetch('/api/me', { cache: 'no-store' })
  .then((r) => r.json())
  .then((me) => {
    viewer = me?.user && !me.user.open ? me.user : null
    if (!viewer) return
    for (const view of chatViews) view.update(chatFor(chat, view.roleId()))
    if (config) {
      renderedKey = '' // Kesher-Kacheln mit „angemeldeter Nutzer“ jetzt anmelden
      render()
    }
  })
  .catch(() => {})
let chat = { state: 'connecting', messages: [], stationName: '' }
let bootId = null
const agendaViews = new Set() // ChurchTools-Kacheln
let churchtools = { state: 'connecting', events: [] }
const frames = new Map() // Kesher-Intercom: tile.id → { wrap, url }

const ws = connect(
  (msg) => {
    if (msg.type === 'config') {
      config = msg.config
      render()
    } else if (msg.type === 'atem') {
      atem = msg
      updateOverlays()
    } else if (msg.type === 'levels') {
      setLevels(msg)
    } else if (msg.type === 'server') {
      // Nach einem Update/Neustart des Servers neu laden (Kiosk hat keine Tastatur)
      if (msg.bootId && bootId && msg.bootId !== bootId) location.reload()
      bootId = msg.bootId
    } else if (msg.type === 'chat') {
      chat = msg
      for (const view of chatViews) view.update(chatFor(chat, view.roleId()))
      for (const composer of composers) composer.update(chat)
    } else if (msg.type === 'churchtools') {
      churchtools = msg
      for (const view of agendaViews) view.update(churchtools)
    } else if (msg.type === 'session_revoked') {
      location.reload() // Anmeldung übernommen: ohne persönlichen Chat weiter
    } else if (msg.type === 'chatFlash') {
      for (const view of chatViews) {
        const role = view.roleId()
        if (!role || !msg.audience || msg.audience.includes(role)) view.flash()
      }
    } else if (msg.type === 'propresenter') {
      propresenter = msg
      for (const view of ppViews) view.update(propresenter)
    } else if (msg.type === 'ppstage') {
      ppStage = msg
      for (const view of stageViews) view.updateStage(ppStage)
    }
  },
  (online) => {
    badgeServer.hidden = online
    if (online && !embedded) reportDevices()
  },
)

// ---------------------------------------------------------------------------
// Aufbau der Kacheln
// ---------------------------------------------------------------------------

function render() {
  const screen = screenRef && config.screens?.find((s) => s.id === screenRef)
  const output = screenRef
    ? config.outputs.find((o) => o.id === screen?.outputId)
    : findByRef(config.outputs, outputRef)
  const layout = output && config.layouts.find((l) => l.id === output.layoutId)
  // Der Kiosk erkennt das Fenster am Anfang "Bildschirm <Anschluss> " – nicht ändern.
  document.title = screenRef
    ? `Bildschirm ${screenRef} · Multiview`
    : output ? `${output.name} – Multiview` : 'Multiview'

  // Nur neu aufbauen, wenn sich für diesen Ausgang wirklich etwas geändert hat,
  // sonst würden die Videos bei jeder Änderung an anderen Layouts kurz flackern.
  const key = JSON.stringify([output?.id ?? outputRef, layout, config.sources, config.chat?.url])
  if (key === renderedKey) return updateOverlays()
  renderedKey = key

  stage.replaceChildren()
  tiles = []
  bankLabels = []
  ppViews = []
  clocks.clear()
  chatViews.clear()
  composers.clear()
  agendaViews.clear()
  stageViews.clear()

  syncFrames(layout)
  if (!output && screenRef) {
    // Bildschirm aus: schwarz
    stage.style.setProperty('--bg', '#000')
    return releaseUnusedStreams(new Set())
  }
  if (!output) return showMessage(`Ausgang „${outputRef}“ nicht gefunden`)
  if (!layout) return showMessage(`${output.name}\nKein Layout zugewiesen`)

  for (const el of [stage, frameLayer]) {
    el.style.setProperty('--bg', layout.background || '#000')
    el.style.setProperty('--gap', `${Number(layout.gap) || 0}px`)
  }

  const usedStreams = new Set()
  for (const tile of layout.tiles) stage.append(buildTile(tile, layout, usedStreams))
  releaseUnusedStreams(usedStreams)
  updateOverlays()
  tick()
}

function showMessage(text) {
  const el = document.createElement('div')
  el.className = 'message'
  el.textContent = text
  stage.append(el)
}

function buildTile(tile, layout, usedStreams) {
  const el = document.createElement('div')
  el.className = `tile fit-${tile.fit || 'contain'}`
  applyBox(el, tile, layout)

  const media = document.createElement('div')
  media.className = 'media'
  el.append(media)

  let source = null
  let labelText = null

  if (tile.kind === 'clock') {
    const clock = document.createElement('div')
    clock.className = 'clock'
    clocks.add(clock)
    media.append(clock)
  } else if (tile.kind === 'text') {
    const text = document.createElement('div')
    text.className = 'text-tile'
    text.textContent = tile.text || ''
    media.append(text)
  } else if (tile.kind === 'chat') {
    const view = createChatView()
    // Chat wie in Kesher für die gewählte bzw. angemeldete Rolle (sonst alles)
    view.roleId = () => chatRoleFor(tile, viewer)
    view.update(chatFor(chat, view.roleId()))
    chatViews.add(view)
    media.classList.add('chat')
    // Angemeldet (nicht in der Editor-Vorschau): unten schreiben – als die eigene Rolle
    if (viewer && !embedded && tile.chatInput !== false) {
      const composer = createComposer(viewer)
      composer.update(chat)
      composers.add(composer)
      const wrap = document.createElement('div')
      wrap.className = 'chat-with-compose'
      wrap.append(view.el, composer.el)
      media.append(wrap)
    } else media.append(view.el)
  } else if (tile.kind === 'kesher') {
    // Die Kesher-Seite selbst liegt in der Ebene #frames (syncFrames) über dieser Kachel
    media.classList.add('chat')
    media.append(
      placeholder(embedded ? 'Kesher-Intercom\nnur auf dem Monitor bedienbar' : 'Kesher-Intercom\nwird geladen …'),
    )
  } else if (tile.kind === 'churchtools') {
    const view = createAgendaView(tile)
    view.update(churchtools)
    agendaViews.add(view)
    media.classList.add('chat')
    media.append(view.el)
  } else if (tile.kind === 'propresenter' || tile.kind === 'playlist' || tile.kind === 'preacher') {
    // Auf den Monitoren sind die Steuer-Tasten bedienbar (im Editor nur Vorschau)
    const view =
      tile.kind === 'playlist'
        ? createPlaylistView(tile.playlist)
        : tile.kind === 'preacher'
          ? createPreacherView(tile.preacher, { interactive: true })
          : createProPresenterView(tile.pp, { interactive: true })
    view.update(propresenter)
    ppViews.push(view)
    el.append(view.el)
  } else if (tile.kind === 'stage') {
    // Bühnennachricht senden nur auf den Monitoren, nicht in der Editor-Vorschau
    const view = createStageView(tile.stage, { interactive: !embedded })
    view.update(propresenter)
    view.updateStage(ppStage)
    ppViews.push(view)
    stageViews.add(view)
    el.append(view.el)
  } else if (tile.kind === 'audio') {
    // Pegel-Fenster: mehrere Pegel mit eigener Quelle
    const bank = createMeterBank(tileChannels(tile), tile.bank)
    el.append(bank.el)
    bankLabels.push(...bank.labels)
  } else {
    source = config.sources.find((s) => s.id === tile.sourceId) || null
    if (source) attachSource(media, source, usedStreams)
    else media.append(placeholder('Keine Quelle'))
    const meterKey = meterKeyFor(source)
    // Pegel in der Videokachel nur, wenn ausdrücklich eingeschaltet (sonst im Pegel-Fenster)
    if (tile.showMeter === true && meterKey !== null) {
      const options = meterOptions(tile.meter)
      el.append(createMeter(meterKey, options))
      if (options.position === 'bottom') {
        // Beschriftung über den Pegel schieben
        el.classList.add('meter-at-bottom')
        const scale = options.scale ? ' + clamp(8px, 3cqmin, 13px) * 1.4' : ''
        el.style.setProperty(
          '--meter-space',
          `calc(clamp(4px, 1.6cqmin, 14px) + ${2.4 * options.size} * clamp(4px, 2.4cqmin, 12px) + 6px${scale})`,
        )
      }
    }
    if (tile.showLabel !== false) labelText = () => tile.label || sourceLabel(source, atem)
  }

  let labelEl = null
  if (labelText) {
    labelEl = document.createElement('div')
    labelEl.className = 'label'
    el.append(labelEl)
  }

  tiles.push({ el, tile, source, labelEl, labelText })
  return el
}

// ---------------------------------------------------------------------------
// Kesher-Intercom (bedienbare Kesher-Weboberfläche)
// ---------------------------------------------------------------------------

const isLoopback = (host) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)

/** Adresse der Kesher-Weboberfläche aus Sicht dieses Browsers. */
function kesherBase(tile) {
  const own = String(tile.kesherUrl || '').trim()
  if (own) return own.replace(/\/+$/, '')
  const server = String(config.chat?.url || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  let host = ''
  try {
    host = new URL(server).hostname
  } catch {
    return server
  }
  // Kesher lauscht auf dem Server nur lokal: am Kiosk direkt, von anderen Rechnern über Caddy (https, Port 8443)
  if (!isLoopback(host) || isLoopback(location.hostname)) return server
  return `https://${location.hostname}:8443`
}

function kesherUrl(tile) {
  // embed: Kesher passt sich dem Kachelfenster an (alle Kanäle sichtbar, nichts scrollt)
  const params = new URLSearchParams({ viewMode: tile.kesherView || 'station', embed: '1' })
  if (tile.kesherHideControls) params.set('controls', '0')
  // "@user": mit Namen und Rolle des angemeldeten Nutzers (nur wenn hier jemand mit Rolle angemeldet ist)
  const asViewer = tile.kesherRoleId === '@user'
  const roleId = asViewer ? (viewer && !viewer.admin ? viewer.roleId : '') : tile.kesherRoleId
  const username = asViewer ? String(viewer?.name ?? '').trim() : String(tile.kesherUser ?? 'Multiview').trim()
  if (roleId && username) {
    params.set('autoLogin', '1')
    params.set('username', username)
    params.set('roleId', roleId)
    // Mit der Rolle des angemeldeten Nutzers nie übernehmen: sein eigenes Kesher (Handy, Laptop,
    // Station) soll dadurch nicht rausfliegen.
    if (tile.kesherTakeover !== false && !asViewer) params.set('autoTakeover', '1')
    // Als Zweitgerät: belegt die Rolle in Kesher nicht, das eigene Kesher-Gerät geht trotzdem
    if (asViewer) params.set('secondary', '1')
  }
  if (tile.kesherAudioIn) params.set('audioInputMatch', tile.kesherAudioIn)
  if (tile.kesherAudioOut) params.set('audioOutputMatch', tile.kesherAudioOut)
  return `${kesherBase(tile)}/?${params}`
}

/**
 * Kesher-Fenster passend zum Layout anlegen, verschieben oder entfernen.
 * Ein Fenster bleibt bestehen, solange sich seine Adresse nicht ändert – so reißt
 * die Intercom-Verbindung nicht ab, wenn im Editor etwas anderes geändert wird.
 * In der Editor-Vorschau nie, sonst wäre die Rolle doppelt angemeldet.
 */
function syncFrames(layout) {
  const wanted = embedded || !layout ? [] : layout.tiles.filter((t) => t.kind === 'kesher')
  const keep = new Set()
  for (const tile of wanted) {
    const url = kesherUrl(tile)
    let frame = frames.get(tile.id)
    if (frame && frame.url !== url) {
      frame.wrap.remove()
      frame = null
    }
    if (!frame) {
      const wrap = document.createElement('div')
      wrap.className = 'frame-tile'
      const iframe = document.createElement('iframe')
      iframe.allow = 'microphone; camera; autoplay; speaker-selection; fullscreen'
      iframe.src = url
      wrap.append(iframe)
      frameLayer.append(wrap)
      frame = { wrap, url }
      frames.set(tile.id, frame)
    }
    applyBox(frame.wrap, tile, layout)
    keep.add(tile.id)
  }
  for (const [id, frame] of frames) {
    if (keep.has(id)) continue
    frame.wrap.remove()
    frames.delete(id)
  }
}

function placeholder(text) {
  const p = document.createElement('div')
  p.className = 'placeholder'
  p.textContent = text
  return p
}

function attachSource(media, source, usedStreams) {
  const key = mediaKey(source)
  if (key) usedStreams.add(key)
  switch (source.type) {
    case 'device':
      attachDevice(media, source.device, placeholder(`Kein Signal\n${source.device || 'kein Gerät gewählt'}`))
      break
    case 'stream':
      attachNetworkStream(media, source.id, placeholder(`Warte auf Stream\n${source.name}`))
      break
    case 'url': {
      const video = makeVideo()
      video.loop = true
      video.src = source.url
      media.append(video)
      break
    }
    case 'image': {
      const img = document.createElement('img')
      img.src = source.url
      img.alt = ''
      media.append(img)
      break
    }
    default:
      media.append(makeTestPattern(source.name))
  }
}

// ---------------------------------------------------------------------------
// Tally und Beschriftung (ändert sich häufig, darum ohne Neuaufbau)
// ---------------------------------------------------------------------------

function updateOverlays() {
  badgeAtem.hidden = !config?.atem?.ip || atem.connected
  for (const { el, tile, source, labelEl, labelText } of tiles) {
    const tally = tile.showTally !== false ? tallyOf(source, atem) : null
    el.classList.toggle('program', tally === 'program')
    el.classList.toggle('preview', tally === 'preview')
    if (labelEl) labelEl.textContent = labelText()
  }
  for (const { el, channel } of bankLabels) {
    el.textContent = channelName(channel, atem)
    const n = Number(channel.input)
    el.classList.toggle('program', atem.program?.includes(n) ?? false)
    el.classList.toggle('preview', !atem.program?.includes(n) && (atem.preview?.includes(n) ?? false))
  }
}

function tick() {
  const text = new Date().toLocaleTimeString('de-DE')
  for (const c of clocks) if (c.textContent !== text) c.textContent = text
}
setInterval(tick, 200)

/** Meldet dem Server, welche Videogeräte an diesem Rechner verfügbar sind. */
async function reportDevices() {
  // iPad/iPhone: nicht nach der Kamera fragen – dort hängen keine Capture-Karten
  if (matchMedia('(pointer: coarse)').matches) return
  try {
    const devices = await listVideoDevices()
    if (devices.length) ws.send({ type: 'devices', devices: devices.map((d) => d.label) })
  } catch {
    // Kein Gerät oder kein Zugriff
  }
}
navigator.mediaDevices?.addEventListener('devicechange', () => !embedded && reportDevices())

// ---------------------------------------------------------------------------
// Vollbild und Mauszeiger
// ---------------------------------------------------------------------------

// Vollbild: Safari auf dem iPad braucht die webkit-Variante, das iPhone kann es gar nicht
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement
const canFullscreen = Boolean(document.fullscreenEnabled || document.webkitFullscreenEnabled)

function toggleFullscreen() {
  const root = document.documentElement
  if (fullscreenElement()) (document.exitFullscreen || document.webkitExitFullscreen)?.call(document)
  else (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root)?.catch?.(() => {})
}

if (!canFullscreen) {
  // iPhone: Vollbild gibt es nur als Web-App vom Home-Bildschirm
  fsButton.hidden = true
  const hint = document.querySelector('.controls-hint')
  if (hint && !navigator.standalone) hint.textContent = 'Vollbild: Teilen → „Zum Home-Bildschirm“'
}

fsButton.addEventListener('click', toggleFullscreen)
if (!embedded) {
  keepTouchScrollInside() // iPad: Wischen in Listen soll das Vollbild nicht beenden
  document.addEventListener('dblclick', (e) => {
    // Schnelles Doppel-Tippen auf die ProPresenter-Tasten soll nicht ins Vollbild schalten
    if (e.target.closest('.pp-controls, .pr-view, .st-send, .chat-compose')) return
    toggleFullscreen()
  })
  document.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, textarea')) return // Tippen in der Bühnennachricht
    if (e.key === 'f' || e.key === 'F') toggleFullscreen()
  })
}
for (const event of ['fullscreenchange', 'webkitfullscreenchange']) {
  document.addEventListener(event, () => {
    fsButton.textContent = fullscreenElement() ? 'Vollbild beenden' : 'Vollbild'
  })
}

// Bedienelemente und Mauszeiger nach kurzer Zeit ausblenden
let idleTimer
function wake() {
  document.body.classList.remove('idle')
  clearTimeout(idleTimer)
  idleTimer = setTimeout(() => document.body.classList.add('idle'), 2500)
}
document.addEventListener('mousemove', wake)
document.addEventListener('pointerdown', wake) // Tablet/Handy: Antippen zeigt die Bedienelemente
wake()

// Bildschirm anlassen, solange der Multiview offen ist – wo das Gerät es erlaubt
let wakeLock = null
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => (wakeLock = null))
    }
  } catch {
    // nicht erlaubt (z. B. ohne HTTPS)
  }
}
document.addEventListener('visibilitychange', keepAwake)
document.addEventListener('pointerdown', keepAwake, { once: true })
keepAwake()
