import { layoutSize, isStandardLayout, TIME_ZONE, connect, findByRef, sourceLabel, channelName, meterKeyFor, tileChannels, tallyOf, applyBox, keepTouchScrollInside, applyLayoutBorder, watchLogin, loginKey, kesherTileUrl, kesherMissing, qrOrigin } from './common.js'
import { createMeter, createMeterBank, setLevels, meterOptions } from './meters.js'
import { createChatView } from './chat.js'
import { chatFor, chatRoleFor } from './rights.js'
import { createComposer } from './chat-compose.js'
import { createAgendaView } from './agenda.js'
import { createRosterView } from './roster.js'
import { createUplinkView, mergeUplink } from './uplink.js'
import { createAvantisView } from './avantis.js'
import { createGrandma3View } from './grandma3.js'
import { createYouTubeView } from './youtube.js'
import { createSlideshowView } from './slideshow.js'
import { createProPresenterView, createPlaylistView, createPreacherView } from './propresenter.js'
import { createStageView } from './stage.js'
import {
  attachDevice, attachNetworkStream, makeVideo, makeTestPattern, mediaKey, releaseUnusedStreams, listVideoDevices, permissionGranted,
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

// Bedienbare Extras (z. B. CCLI kopieren) nur im Monitor-Modus und im Vollbild –
// nicht am HDMI-Ausgang und nicht in den kleinen Vorschauen
function updateCanCopy() {
  const fills = window.innerWidth >= screen.width - 4 && window.innerHeight >= screen.height - 4
  document.body.classList.toggle('can-copy', !screenRef && (!embedded || fills))
}
updateCanCopy()
window.addEventListener('resize', updateCanCopy)

const stage = document.getElementById('stage')
const frameLayer = document.getElementById('frames')
const badgeServer = document.getElementById('badge-server')
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
let viewerReady = false
// Ohne eigene Anmeldung (Kiosk am HDMI-Ausgang): wer gerade für diesen Multiview angemeldet ist
let stationUser = null
let currentOutputId = null
fetch('/api/me', { cache: 'no-store' })
  .then((r) => r.json())
  .then((me) => {
    viewer = me?.user && !me.user.open ? me.user : null
    // In einem anderen Tab (oder Dienst) an- oder abgemeldet: neu laden, damit Chat und
    // Intercom-Kacheln gleich für die neue Anmeldung gelten
    if (me?.access?.enabled) watchLogin(loginKey(me.user))
    if (!viewer) return
    for (const view of chatViews) view.update(chatFor(chat, view.roleId()))
  })
  .catch(() => {})
  .finally(() => {
    viewerReady = true
    if (config) {
      renderedKey = '' // Kesher-Kacheln mit „angemeldeter Nutzer“ jetzt anmelden
      render()
    }
  })
let chat = { state: 'connecting', messages: [], stationName: '' }
let bootId = null
const agendaViews = new Set() // ChurchTools-Kacheln (Ablauf)
const rosterViews = new Set() // ChurchTools-Kacheln (Dienstplan)
let ctPosition = { type: 'ctposition', positions: {} } // von Hand gesetzte Ablauf-Punkte
const uplinkViews = new Set() // Upload-Kacheln (FRITZ!Box)
let uplink = null
const avantisViews = new Set() // Kacheln „Mischpult“ (Avantis)
let avantis = null
const grandma3Views = new Set() // Kacheln „Licht“ (grandMA3)
let grandma3 = null
const youtubeViews = new Set() // Kacheln „YouTube Live“
let youtube = null
const slideshowViews = new Set() // Kacheln „Diashow“
let slideshow = null
let churchtools = { state: 'connecting', events: [] }
const frames = new Map() // Kesher-Intercom: tile.id → { wrap, url }

const ws = connect(
  (msg) => {
    if (msg.type === 'config') {
      config = msg.config
      render()
      refreshDayQr()
    } else if (msg.type === 'atem') {
      atem = msg
      updateOverlays()
    } else if (msg.type === 'levels') {
      setLevels(msg)
    } else if (msg.type === 'server') {
      // Nach einem Update/Neustart des Servers neu laden (Kiosk hat keine Tastatur)
      if (msg.bootId && bootId && msg.bootId !== bootId) location.reload()
      bootId = msg.bootId
      if (Array.isArray(msg.addresses)) serverAddresses = msg.addresses
    } else if (msg.type === 'chat') {
      chat = msg
      for (const view of chatViews) view.update(chatFor(chat, view.roleId()))
      for (const composer of composers) composer.update(chat)
    } else if (msg.type === 'churchtools') {
      churchtools = msg
      for (const view of agendaViews) view.update(churchtools)
      for (const view of rosterViews) view.update(churchtools)
      for (const view of slideshowViews) view.update({ churchtools })
    } else if (msg.type === 'ctposition') {
      ctPosition = msg
      for (const view of agendaViews) view.updatePosition(ctPosition)
    } else if (msg.type === 'slideshow') {
      slideshow = msg
      for (const view of slideshowViews) view.update({ slideshow })
    } else if (msg.type === 'youtube') {
      youtube = msg
      for (const view of youtubeViews) view.update(youtube)
    } else if (msg.type === 'uplink') {
      uplink = mergeUplink(uplink, msg)
      for (const view of uplinkViews) view.update(uplink)
    } else if (msg.type === 'avantis') {
      avantis = msg
      for (const view of avantisViews) view.update(avantis)
    } else if (msg.type === 'grandma3') {
      grandma3 = msg
      for (const view of grandma3Views) view.update(grandma3)
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
  currentOutputId = output?.id ?? null
  // Der Kiosk erkennt das Fenster am Anfang "Bildschirm <Anschluss> " – nicht ändern.
  document.title = screenRef
    ? `Bildschirm ${screenRef} · Multiview`
    : output ? `${output.name} – Multiview` : 'Multiview'

  // Monitor hochkant aufgehängt (Bildschirme am Server → Drehung): das ganze Bild drehen
  const rotate = [90, 180, 270].includes(screen?.rotate) ? String(screen.rotate) : ''
  if ((document.body.dataset.rotate || '') !== rotate) {
    if (rotate) document.body.dataset.rotate = rotate
    else delete document.body.dataset.rotate
  }
  // Nur neu aufbauen, wenn sich für diesen Ausgang wirklich etwas geändert hat,
  // sonst würden die Videos bei jeder Änderung an anderen Layouts kurz flackern.
  const key = JSON.stringify([output ?? outputRef, layout, config.sources, config.chat])
  if (key === renderedKey) {
    fitStage(layout) // z. B. Drehung des Bildschirms geändert
    return updateOverlays()
  }
  renderedKey = key

  stage.replaceChildren()
  tiles = []
  bankLabels = []
  ppViews = []
  clocks.clear()
  chatViews.clear()
  composers.clear()
  agendaViews.clear()
  rosterViews.clear()
  uplinkViews.clear()
  avantisViews.clear()
  grandma3Views.clear()
  youtubeViews.clear()
  slideshowViews.clear()
  stageViews.clear()

  syncFrames(layout)
  if (!output && screenRef) {
    // Bildschirm aus: schwarz
    stage.style.setProperty('--bg', '#000')
    return releaseUnusedStreams(new Set())
  }
  if (!output) return showMessage(`Ausgang „${outputRef}“ nicht gefunden`)
  if (!layout) return showMessage(`${output.name}\nKein Layout zugewiesen`)

  fitStage(layout)
  for (const el of [stage, frameLayer]) {
    el.style.setProperty('--bg', layout.background || '#000')
    el.style.setProperty('--gap', `${Number(layout.gap) || 0}px`)
    applyLayoutBorder(el, layout)
  }

  const usedStreams = new Set()
  for (const tile of layout.tiles) stage.append(buildTile(tile, layout, usedStreams))
  releaseUnusedStreams(usedStreams)
  updateOverlays()
  tick()
}

/**
 * Fläche passend zum Layout-Format: Ein Hochformat-Layout (9:16) – oder ein Querformat-Layout auf
 * einem hochkant stehenden Bildschirm – wird mittig mit schwarzen Rändern gezeigt statt verzerrt.
 * Sonst füllt die Fläche wie bisher den ganzen Bildschirm.
 */
let fittedLayout = null
function fitStage(layout) {
  fittedLayout = layout
  const W = document.body.clientWidth
  const H = document.body.clientHeight
  const size = layoutSize(layout)
  const ratio = size.width / size.height
  // Normales 16:9 füllt wie bisher den Bildschirm (außer hochkant), alles andere wird eingepasst
  const fit = layout && (!isStandardLayout(layout) || W / H < 1)
  for (const el of [stage, frameLayer]) {
    if (!fit) {
      for (const p of ['width', 'height', 'left', 'top', 'right', 'bottom']) el.style.removeProperty(p)
      continue
    }
    const w = Math.min(W, H * ratio)
    const h = w / ratio
    Object.assign(el.style, { width: `${w}px`, height: `${h}px`, left: `${(W - w) / 2}px`, top: `${(H - h) / 2}px`, right: 'auto', bottom: 'auto' })
  }
}
window.addEventListener('resize', () => fittedLayout && fitStage(fittedLayout))

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
    const view = createChatView(tile.chat)
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
    media.append(placeholder(`Kesher-Intercom\n${kesherUrl(tile) ? 'wird geladen …' : kesherMissing(tile)}`))
  } else if (tile.kind === 'slideshow') {
    const view = createSlideshowView(tile.slideshow)
    view.update({ slideshow, churchtools })
    slideshowViews.add(view)
    media.classList.add('chat')
    media.append(view.el)
  } else if (tile.kind === 'youtube') {
    const view = createYouTubeView(tile.youtube)
    view.update(youtube)
    youtubeViews.add(view)
    media.classList.add('chat')
    media.append(view.el)
  } else if (tile.kind === 'uplink') {
    const view = createUplinkView(tile.uplink)
    view.update(uplink)
    uplinkViews.add(view)
    media.classList.add('chat')
    media.append(view.el)
  } else if (tile.kind === 'avantis') {
    const view = createAvantisView(tile.avantis)
    view.update(avantis)
    avantisViews.add(view)
    media.classList.add('chat')
    media.append(view.el)
  } else if (tile.kind === 'grandma3') {
    const view = createGrandma3View(tile.grandma3)
    view.update(grandma3)
    grandma3Views.add(view)
    media.classList.add('chat')
    media.append(view.el)
  } else if (tile.kind === 'churchtools') {
    const view = createAgendaView(tile)
    view.updatePosition(ctPosition)
    view.update(churchtools)
    agendaViews.add(view)
    media.classList.add('chat')
    media.append(view.el)
  } else if (tile.kind === 'services') {
    const view = createRosterView(tile)
    view.update(churchtools)
    rosterViews.add(view)
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

/** Person für Kesher-Kacheln mit „angemeldeter Nutzer“: hier angemeldet, sonst die des Multiviews. */
function kesherPerson() {
  if (viewer) return viewer.admin ? null : viewer
  return stationUser
}

const hasViewerKesher = () => {
  const output = config?.outputs.find((o) => o.id === currentOutputId)
  const layout = output && config.layouts.find((l) => l.id === output.layoutId)
  return Boolean(layout?.tiles.some((t) => t.kind === 'kesher' && t.kesherRoleId === '@user'))
}

/** Ohne eigene Anmeldung regelmäßig nachsehen, wer für diesen Multiview angemeldet ist. */
async function refreshStationUser() {
  if (viewer || !currentOutputId || !hasViewerKesher()) return
  const data = await fetch(`/api/output/${encodeURIComponent(currentOutputId)}/user`, { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null)
  if (!data) return
  const next = data.user ?? null
  if (JSON.stringify(next) === JSON.stringify(stationUser)) return
  stationUser = next
  renderedKey = '' // Kesher-Kachel mit der neuen Person anmelden
  render()
}
setInterval(refreshStationUser, 10_000)

function kesherUrl(tile) {
  return kesherTileUrl(tile, config, kesherPerson())
}

/**
 * Kesher-Fenster passend zum Layout anlegen, verschieben oder entfernen.
 * Ein Fenster bleibt bestehen, solange sich seine Adresse nicht ändert – so reißt
 * die Intercom-Verbindung nicht ab, wenn im Editor etwas anderes geändert wird.
 * Eingebettete Ansichten verwenden dieselben Fenster als Zweitgerät; beim
 * Wechsel ins Vollbild bleibt die bestehende Intercom-Verbindung erhalten.
 */
function syncFrames(layout) {
  // Erst die eigene Identität auflösen, damit der erste iframe-Aufruf schon die
  // richtige Zweitgeräte-Anmeldung nutzt. Ohne Person zeigt Kesher seine Anmeldung.
  const wanted =
    !layout || !viewerReady
      ? []
      : layout.tiles.filter((t) => t.kind === 'kesher' && kesherUrl(t))
  refreshStationUser()
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
      iframe.title = 'Kesher-Intercom'
      // Nur Spiegel: kein Mikrofon, kein Lautsprecher – das Headset hängt am Gerät der Rolle
      iframe.allow = 'autoplay; fullscreen'
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
  const text = new Date().toLocaleTimeString('de-DE', { timeZone: TIME_ZONE })
  for (const c of clocks) if (c.textContent !== text) c.textContent = text
}
setInterval(tick, 200)

/** Meldet dem Server, welche Videogeräte an diesem Rechner verfügbar sind. */
async function reportDevices() {
  // iPad/iPhone: nicht nach der Kamera fragen – dort hängen keine Capture-Karten
  if (matchMedia('(pointer: coarse)').matches) return
  try {
    // Nur am Server selbst (Kiosk über 127.0.0.1, dort hängen die Capture-Karten) nach der Kamera
    // fragen. Anderswo – z. B. die Monitor-Ansicht in einem Tab am Laptop – nur nachsehen, wenn sie
    // schon erlaubt ist, sonst käme bei jedem Öffnen die Kamera-Abfrage.
    const onServer = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname)
    if (!onServer && !(await permissionGranted())) return
    const devices = await listVideoDevices({ ask: onServer })
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


// ---------------------------------------------------------------------------
// Tages-QR-Code der Anmeldung klein in einer Ecke – je Multiview, auch in Vorschau und Vollbild
// ---------------------------------------------------------------------------

let serverAddresses = []
let dayQrKey = ''
let dayQrRequest = 0
const dayQr = document.createElement('figure')
dayQr.className = 'day-qr'
dayQr.hidden = true
dayQr.innerHTML = '<img alt="QR-Code von heute"><figcaption></figcaption>'
document.body.append(dayQr)

/** Adresse für den QR-Code: immer die IP des Servers im LAN (qrOrigin in common.js). */
function lanOrigin(startUrl = '') {
  return qrOrigin(serverAddresses, startUrl)
}

async function refreshDayQr() {
  const request = ++dayQrRequest
  const outputId = currentOutputId
  const enabled = config?.outputs.find((output) => output.id === outputId)?.dayQr?.show
  if (!outputId || !enabled) {
    dayQr.hidden = true
    dayQrKey = ''
    return
  }
  const data = await fetch(`/api/display/day-code?output=${encodeURIComponent(outputId)}`, { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null)
  if (request !== dayQrRequest || outputId !== currentOutputId) return
  if (!data?.show) {
    dayQr.hidden = true
    dayQrKey = ''
    return
  }
  const base = lanOrigin(data.startUrl).replace(/\/+$/, '')
  const target = `${base}/.jms-auth/code?c=${encodeURIComponent(data.code)}&next=${encodeURIComponent('/remote.html')}`
  const key = JSON.stringify([target, data.corner, data.size])
  dayQr.dataset.corner = data.corner || 'br'
  dayQr.dataset.size = data.size || 'm'
  dayQr.hidden = false
  if (key === dayQrKey) return
  dayQrKey = key
  dayQr.querySelector('img').src = `/api/qr.svg?data=${encodeURIComponent(target)}`
  dayQr.querySelector('figcaption').textContent = `${data.code.slice(0, 3)} ${data.code.slice(3)}`
}
setInterval(refreshDayQr, 30_000)
setTimeout(refreshDayQr, 1500)
