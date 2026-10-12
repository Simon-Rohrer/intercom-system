import { connect, findByRef, sourceLabel, channelName, meterKeyFor, tileChannels, tallyOf, applyBox } from './common.js'
import { createMeter, createMeterBank, setLevels, meterOptions } from './meters.js'
import { createChatView } from './chat.js'
import { createAgendaView } from './agenda.js'
import { createProPresenterView, createPlaylistView, createPreacherView } from './propresenter.js'
import {
  attachDevice, attachNetworkStream, makeVideo, makeTestPattern, mediaKey, releaseUnusedStreams, listVideoDevices,
} from './media.js'

// ?id=<ID, Name oder Nummer> wählt den Ausgang, ?embed=1 für die Vorschau auf der Webseite
const params = new URLSearchParams(location.search)
const outputRef = params.get('id') || '1'
const embedded = params.has('embed')
document.body.classList.toggle('embedded', embedded)

const stage = document.getElementById('stage')
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
const clocks = new Set()
const chatViews = new Set() // Chat-Kacheln
let chat = { state: 'connecting', messages: [], stationName: '' }
let bootId = null
const agendaViews = new Set() // ChurchTools-Kacheln
let churchtools = { state: 'connecting', events: [] }

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
      for (const view of chatViews) view.update(chat)
    } else if (msg.type === 'churchtools') {
      churchtools = msg
      for (const view of agendaViews) view.update(churchtools)
    } else if (msg.type === 'chatFlash') {
      for (const view of chatViews) view.flash(msg)
    } else if (msg.type === 'propresenter') {
      propresenter = msg
      for (const view of ppViews) view.update(propresenter)
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
  const output = findByRef(config.outputs, outputRef)
  const layout = output && config.layouts.find((l) => l.id === output.layoutId)
  document.title = output ? `${output.name} – Multiview` : 'Multiview'

  // Nur neu aufbauen, wenn sich für diesen Ausgang wirklich etwas geändert hat,
  // sonst würden die Videos bei jeder Änderung an anderen Layouts kurz flackern.
  const key = JSON.stringify([outputRef, layout, config.sources])
  if (key === renderedKey) return updateOverlays()
  renderedKey = key

  stage.replaceChildren()
  tiles = []
  bankLabels = []
  ppViews = []
  clocks.clear()
  chatViews.clear()
  agendaViews.clear()

  if (!output) return showMessage(`Ausgang „${outputRef}“ nicht gefunden`)
  if (!layout) return showMessage(`${output.name}\nKein Layout zugewiesen`)

  stage.style.setProperty('--bg', layout.background || '#000')
  stage.style.setProperty('--gap', `${Number(layout.gap) || 0}px`)

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
    view.update(chat)
    chatViews.add(view)
    media.classList.add('chat')
    media.append(view.el)
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
  document.addEventListener('dblclick', (e) => {
    // Schnelles Doppel-Tippen auf die ProPresenter-Tasten soll nicht ins Vollbild schalten
    if (e.target.closest('.pp-controls, .pr-view')) return
    toggleFullscreen()
  })
  document.addEventListener('keydown', (e) => {
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
