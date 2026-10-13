import { connect, uid, sourceLabel, audioInputName, channelName, meterKeyFor, tileChannels, tallyOf, applyBox } from './common.js'
import { createMeter, createMeterBank, setLevels, meterOptions, bankOptions } from './meters.js'
import { createChatView } from './chat.js'
import { createAgendaView } from './agenda.js'
import {
  createProPresenterView, createPlaylistView, createPreacherView, ppOptions, playlistOptions, preacherOptions,
} from './propresenter.js'
import {
  attachDevice, attachNetworkStream, makeVideo, makeTestPattern, mediaKey,
  listVideoDevices, permissionGranted, releaseUnusedStreams, mediaAvailable,
} from './media.js'

const $ = (sel, root = document) => root.querySelector(sel)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const clamp = (v, min, max) => Math.min(Math.max(v, min), max)

const CLIENT_ID = uid('c')
const PAGES = ['uebersicht', 'eingaenge', 'layouts', 'einstellungen']
const SOURCE_TYPES = {
  device: 'Capture-Gerät',
  stream: 'Netzwerk-Stream',
  test: 'Testbild',
  url: 'Video-URL',
  image: 'Bild / MJPEG-URL',
}

// Vorlagen auf einem 12×12-Raster (12 lässt sich durch 2, 3, 4 und 6 teilen)
const PRESETS = {
  '2×2': gridPreset(2),
  '3×3': gridPreset(3),
  '4×4': gridPreset(4),
  'ATEM': [
    { x: 0, y: 0, w: 6, h: 6 },
    { x: 6, y: 0, w: 6, h: 6 },
    ...[0, 1].flatMap((r) => [0, 1, 2, 3].map((c) => ({ x: c * 3, y: 6 + r * 3, w: 3, h: 3 }))),
  ],
  '1+5': [
    { x: 0, y: 0, w: 8, h: 8 },
    { x: 8, y: 0, w: 4, h: 4 },
    { x: 8, y: 4, w: 4, h: 4 },
    { x: 0, y: 8, w: 4, h: 4 },
    { x: 4, y: 8, w: 4, h: 4 },
    { x: 8, y: 8, w: 4, h: 4 },
  ],
  '1+7': [
    { x: 0, y: 0, w: 9, h: 9 },
    { x: 9, y: 0, w: 3, h: 3 },
    { x: 9, y: 3, w: 3, h: 3 },
    { x: 9, y: 6, w: 3, h: 3 },
    ...[0, 1, 2, 3].map((c) => ({ x: c * 3, y: 9, w: 3, h: 3 })),
  ],
}

function gridPreset(n) {
  const s = 12 / n
  return Array.from({ length: n * n }, (_, i) => ({ x: (i % n) * s, y: Math.floor(i / n) * s, w: s, h: s }))
}

let config = null
let atem = { connected: false, program: [], preview: [], inputs: {} }
let page = 'uebersicht'
let serverDevices = []
let detectedScreens = [] // Anschlüsse der Grafikkarte am Server { id, connected, mode }
let server ={ addresses: [], ports: {}, mediamtx: { status: 'unknown', message: '' } }
let lastLevels = { inputs: {}, master: null }
let propresenter = { connected: false }
let localDevices = []
let layoutId = null
let selectedTileId = null
let saveTimer = null
let dragging = null
let livePreview = readPref('livePreview', false)
let chat = { state: 'connecting', messages: [], stationName: '' }
const chatViews = new Set()
let churchtools = { state: 'connecting', events: [] }
const agendaViews = new Set()
let templates = [] // gespeicherte Layouts { id, name, savedAt, tiles }

connect(onMessage, (online) => {
  if (!online) setSaveState('error', 'Server nicht erreichbar')
  else if (!saveTimer) setSaveState('')
})

function onMessage(msg) {
  if (msg.type === 'config') {
    // Eigene Änderungen kommen als Echo zurück – die haben wir schon.
    if (msg.origin === CLIENT_ID || saveTimer || dragging) return
    config = msg.config
    renderAll()
  } else if (msg.type === 'atem') {
    atem = msg
    renderAtemPill()
    renderAtem()
    renderDatalists()
    updateCanvasOverlays()
  } else if (msg.type === 'devices') {
    serverDevices = msg.devices
    renderDatalists()
    renderDeviceGrid()
  } else if (msg.type === 'screens') {
    detectedScreens = msg.screens
    if (!config) return
    renderScreens()
    renderCompanion()
  } else if (msg.type === 'churchtools') {
    churchtools = msg
    renderChurchTools()
    for (const view of agendaViews) {
      if (view.el.isConnected) view.update(churchtools)
      else agendaViews.delete(view)
    }
  } else if (msg.type === 'chat') {
    chat = msg
    renderChatStatus()
    for (const view of chatViews) {
      if (view.el.isConnected) view.update(chat)
      else chatViews.delete(view)
    }
  } else if (msg.type === 'propresenter') {
    propresenter = msg
    for (const el of canvas.querySelectorAll('.etile')) el.ppView?.update(propresenter)
    renderProPresenter()
  } else if (msg.type === 'templates') {
    templates = msg.templates
    renderTemplates()
  } else if (msg.type === 'levels') {
    setLevels(msg)
    lastLevels = msg
  } else if (msg.type === 'server') {
    // Nach einem Update des Servers neu laden, sonst läuft hier noch der alte Stand
    if (msg.bootId && server?.bootId && msg.bootId !== server.bootId && !saveTimer) return location.reload()
    server = msg
    renderStreams()
    renderSources()
  }
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(`mv.${key}`)
    return v === null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(`mv.${key}`, JSON.stringify(value))
  } catch {
    // privater Modus o. Ä.
  }
}

// ---------------------------------------------------------------------------
// Speichern
// ---------------------------------------------------------------------------

function changed(delay = 350) {
  setSaveState('pending')
  clearTimeout(saveTimer)
  saveTimer = setTimeout(save, delay)
}

async function save() {
  try {
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID },
      body: JSON.stringify(config),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    setSaveState('saved')
  } catch (err) {
    setSaveState('error', `Speichern fehlgeschlagen: ${err.message}`)
  } finally {
    saveTimer = null
  }
}

function setSaveState(state, text) {
  const el = $('#save-state')
  el.className = `save-state ${state}`
  el.textContent = text ?? { pending: 'Speichere …', saved: 'Gespeichert ✓', error: 'Fehler' }[state] ?? ''
}

function toast(text) {
  const el = $('#toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (el.hidden = true), 3500)
}

// ---------------------------------------------------------------------------
// Seiten
// ---------------------------------------------------------------------------

function showPage() {
  const requested = location.hash.replace(/^#\/?/, '')
  page = PAGES.includes(requested) ? requested : 'uebersicht'
  for (const p of PAGES) $(`#page-${p}`).hidden = p !== page
  document.querySelectorAll('.site-nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page))
  if (page === 'eingaenge') autoScanDevices()
  renderAll()
  window.scrollTo(0, 0)
}
window.addEventListener('hashchange', showPage)

function renderAll() {
  if (!config) return
  if (!config.layouts.some((l) => l.id === layoutId)) layoutId = config.layouts[0]?.id ?? null
  if (!currentLayout()?.tiles.some((t) => t.id === selectedTileId)) selectedTileId = null
  renderOutputs()
  renderScreens()
  renderDeviceGrid()
  renderStreams()
  renderSources()
  renderLayoutList()
  renderCanvas()
  renderInspector()
  renderAtem()
  renderChat()
  renderChurchTools()
  renderProPresenter()
  renderCompanion()
  renderAtemPill()
  renderDatalists()
  syncStreams()
}

/** Gibt Capture-Geräte frei, die auf der aktuellen Seite nicht angezeigt werden. */
function syncStreams() {
  const used = new Set()
  if (page === 'eingaenge') {
    localDevices.forEach((d) => used.add(`dev:${d}`))
    config.sources.filter((s) => s.type === 'stream').forEach((s) => used.add(mediaKey(s)))
  }
  if (page === 'layouts' && livePreview) {
    for (const t of currentLayout()?.tiles ?? []) {
      const key = t.kind === 'source' && mediaKey(config.sources.find((x) => x.id === t.sourceId))
      if (key) used.add(key)
    }
  }
  releaseUnusedStreams(used)
}

function renderAtemPill() {
  const pill = $('#atem-pill')
  if (!config?.atem.ip) {
    pill.className = 'pill'
    pill.textContent = 'Kein ATEM'
  } else if (atem.connected) {
    pill.className = 'pill ok'
    pill.textContent = `ATEM verbunden${atem.model ? ` · ${atem.model}` : ''}`
  } else {
    pill.className = 'pill bad'
    pill.textContent = 'ATEM getrennt'
  }
}

function renderDatalists() {
  const devices = [...new Set([...localDevices, ...serverDevices])]
  $('#device-list').innerHTML = devices.map((d) => `<option value="${esc(d)}"></option>`).join('')
  $('#atem-input-list').innerHTML = Object.entries(atem.inputs || {})
    .map(([id, i]) => `<option value="${esc(id)}">${esc(i.longName)} (${esc(i.shortName)})</option>`)
    .join('')
}

// ---------------------------------------------------------------------------
// Übersicht: Multiviews mit Live-Vorschau
// ---------------------------------------------------------------------------

let outputsKey = ''

function outputUrl(output, embed = false) {
  return `${location.origin}/output.html?id=${encodeURIComponent(output.id)}${embed ? '&embed=1' : ''}`
}

function layoutOptions(selected) {
  return [
    `<option value="">– kein Layout –</option>`,
    ...config.layouts.map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? 'selected' : ''}>${esc(l.name)}</option>`),
  ].join('')
}

function renderOutputs() {
  const grid = $('#output-cards')
  // Vorschauen (iframes) nur laden, solange die Übersicht offen ist
  if (page !== 'uebersicht') {
    if (outputsKey) grid.replaceChildren()
    outputsKey = ''
    return
  }
  const key = config.outputs.map((o) => o.id).join('|')
  if (key !== outputsKey) {
    outputsKey = key
    grid.innerHTML =
      config.outputs
        .map(
          (o) => `<article class="card output-card" data-id="${esc(o.id)}">
          <div class="output-preview">
            <iframe src="${esc(outputUrl(o, true))}" allow="camera; fullscreen; autoplay" title="${esc(o.name)}"></iframe>
          </div>
          <div class="output-body">
            <div class="output-title">
              <input type="text" class="name-input" data-o="name" aria-label="Name">
              <select data-o="layoutId" aria-label="Layout"></select>
            </div>
            <div class="output-foot">
              <div class="btn-row">
                <button class="btn primary" data-action="fullscreen">⛶ Vollbild</button>
                <a class="btn" href="${esc(outputUrl(o))}" target="_blank" rel="noopener">Monitor-Ansicht ↗</a>
              </div>
              <button class="btn small danger" data-action="delete-output">Entfernen</button>
            </div>
          </div>
        </article>`,
        )
        .join('') ||
      `<div class="empty-state">Noch kein Multiview. Lege mit <b>+ Multiview</b> einen an.</div>`
  }
  // Felder aktualisieren, ohne die Vorschauen neu zu laden
  for (const card of grid.querySelectorAll('.output-card')) {
    const output = config.outputs.find((o) => o.id === card.dataset.id)
    const name = card.querySelector('[data-o="name"]')
    if (document.activeElement !== name) name.value = output.name
    card.querySelector('[data-o="layoutId"]').innerHTML = layoutOptions(output.layoutId)
    card.querySelector('iframe').title = output.name
  }
}

function onOutputField(e) {
  const el = e.target
  const key = el.dataset.o
  if (!key) return
  if ((e.type === 'input') !== (el.type === 'text')) return
  const output = config.outputs.find((o) => o.id === el.closest('.output-card').dataset.id)
  output[key] = el.value || null
  renderLayoutList()
  renderScreens()
  renderCompanion()
  changed()
}
$('#output-cards').addEventListener('input', onOutputField)
$('#output-cards').addEventListener('change', onOutputField)

$('#output-cards').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-action]')
  if (!btn) return
  const card = btn.closest('.output-card')
  const output = config.outputs.find((o) => o.id === card.dataset.id)
  if (btn.dataset.action === 'fullscreen') {
    card.querySelector('iframe').requestFullscreen().catch((err) => toast(`Vollbild nicht möglich: ${err.message}`))
  } else if (btn.dataset.action === 'delete-output') {
    if (!confirm(`Multiview „${output.name}“ entfernen?`)) return
    config.outputs = config.outputs.filter((o) => o !== output)
    renderAll()
    changed(0)
  }
})

$('#output-add').addEventListener('click', () => {
  config.outputs.push({
    id: uid('o'),
    name: `Multiview ${config.outputs.length + 1}`,
    layoutId: config.layouts[0]?.id ?? null,
  })
  renderAll()
  changed(0)
})

// ---------------------------------------------------------------------------
// Übersicht: Bildschirme am Server (welcher Multiview auf welchem Anschluss)
// ---------------------------------------------------------------------------

/** "HDMI-A-1" → "HDMI 1", "DP-2" → "DisplayPort 2" */
function connectorLabel(id) {
  const m = /^([A-Za-z]+)(?:-[A-Z])?-(\d+)$/.exec(id)
  if (!m) return id
  const type = { DP: 'DisplayPort', eDP: 'Laptop-Display' }[m[1]] ?? m[1]
  return `${type} ${m[2]}`
}

/** Erkannte Anschlüsse und solche, die schon einmal eingestellt wurden. */
function screenRows() {
  const ids = [...new Set([...detectedScreens.map((s) => s.id), ...config.screens.map((s) => s.id)])]
  return ids.map((id) => ({
    id,
    detected: detectedScreens.find((s) => s.id === id),
    saved: config.screens.find((s) => s.id === id),
  }))
}

const screenName = ({ id, saved }) => saved?.name || connectorLabel(id)

function renderScreens() {
  const body = $('#screen-rows')
  if (body.contains(document.activeElement) && document.activeElement.type === 'text') return
  const rows = screenRows().map(({ id, detected, saved }) => {
    const outputOptions = [
      `<option value="">– aus (schwarz) –</option>`,
      ...config.outputs.map(
        (o) => `<option value="${esc(o.id)}" ${o.id === saved?.outputId ? 'selected' : ''}>${esc(o.name)}</option>`,
      ),
    ].join('')
    const status = !detected
      ? '<span class="pill">nicht gefunden</span>'
      : detected.connected
        ? `<span class="pill ok">angeschlossen${detected.mode ? ` · ${esc(detected.mode)}` : ''}</span>`
        : '<span class="pill">kein Monitor</span>'
    return `<tr data-id="${esc(id)}">
      <td><code>${esc(id)}</code></td>
      <td><input type="text" data-s="name" value="${esc(saved?.name)}" placeholder="${esc(connectorLabel(id))}"></td>
      <td><select data-s="outputId">${outputOptions}</select></td>
      <td>${status}</td>
    </tr>`
  })
  body.innerHTML =
    rows.join('') ||
    `<tr><td colspan="4" class="muted">Keine Anschlüsse gefunden. Sie erscheinen hier, wenn der Multiview-Server
      auf dem Linux-Rechner läuft, an dem die Monitore hängen.</td></tr>`
}

function onScreenField(e) {
  const el = e.target
  const key = el.dataset.s
  if (!key) return
  if ((e.type === 'input') !== (el.type === 'text')) return
  const id = el.closest('tr').dataset.id
  let screen = config.screens.find((s) => s.id === id)
  if (!screen) config.screens.push((screen = { id, name: '', outputId: null }))
  screen[key] = key === 'name' ? el.value : el.value || null
  renderCompanion()
  changed(key === 'name' ? 350 : 0)
}
$('#screen-rows').addEventListener('input', onScreenField)
$('#screen-rows').addEventListener('change', onScreenField)

// ---------------------------------------------------------------------------
// Eingänge: erkannte Geräte
// ---------------------------------------------------------------------------

let deviceGridKey = ''

async function scanDevices({ ask = true } = {}) {
  if (!mediaAvailable()) {
    $('#device-note').textContent =
      'Videozugriff geht nur, wenn die Seite über http://localhost (oder HTTPS) geöffnet ist – also direkt am Server.'
    renderDeviceGrid()
    return
  }
  try {
    localDevices = (await listVideoDevices({ ask })).map((d) => d.label)
    if (ask) toast(localDevices.length ? `${localDevices.length} Videoeingang/-eingänge gefunden` : 'Keine Videoeingänge gefunden')
  } catch (err) {
    if (!ask) return
    if (err.name === 'NotAllowedError') {
      toast('Zugriff verweigert – im Browser über das Symbol links in der Adressleiste die Kamera erlauben.')
    } else if (err.name === 'NotFoundError') {
      toast('Kein Videoeingang gefunden – ist die Capture-Karte angeschlossen und der Treiber installiert?')
    } else {
      toast(`Kein Zugriff auf Videoeingänge: ${err.message}`)
    }
  }
  renderDatalists()
  renderDeviceGrid()
  syncStreams()
}

async function autoScanDevices() {
  if (mediaAvailable() && (await permissionGranted())) scanDevices({ ask: false })
}

$('#scan-devices').addEventListener('click', () => scanDevices())

function renderDeviceGrid() {
  const grid = $('#device-grid')
  if (page !== 'eingaenge') {
    if (deviceGridKey) grid.replaceChildren()
    deviceGridKey = ''
    return
  }
  const remote = serverDevices.filter((d) => !localDevices.includes(d))
  const key = JSON.stringify([localDevices, remote])
  if (key !== deviceGridKey) {
    deviceGridKey = key
    grid.replaceChildren()
    if (!localDevices.length && !remote.length) {
      grid.innerHTML = `<div class="empty-state">
        Noch keine Eingänge gefunden.<br>
        Klicke auf <b>Eingänge suchen</b> und erlaube den Kamerazugriff.
        Ohne Hardware kannst du unten eine Quelle vom Typ <b>Testbild</b> anlegen.
      </div>`
    }
    for (const label of localDevices) grid.append(deviceCard(label, true))
    for (const label of remote) grid.append(deviceCard(label, false))
  }
  updateDeviceStatus()
}

function deviceCard(label, local) {
  const card = document.createElement('article')
  card.className = 'card device-card'
  card.dataset.device = label
  card.innerHTML = `
    <div class="device-preview"></div>
    <div class="device-body">
      <div class="device-name"></div>
      <div class="device-meta">${local ? 'Signal wird gesucht …' : 'Am Server gemeldet (Vorschau nur direkt am Server)'}</div>
      <div class="device-status"></div>
    </div>`
  card.querySelector('.device-name').textContent = label
  const preview = card.querySelector('.device-preview')
  if (local) {
    const hint = document.createElement('span')
    hint.textContent = 'Kein Signal'
    const video = attachDevice(preview, label, hint)
    video.addEventListener('loadedmetadata', () => {
      card.querySelector('.device-meta').textContent = `${video.videoWidth} × ${video.videoHeight}`
    })
  } else {
    preview.textContent = 'Keine Vorschau auf diesem Rechner'
  }
  return card
}

function updateDeviceStatus() {
  for (const card of document.querySelectorAll('#device-grid .device-card')) {
    const source = config.sources.find((s) => s.type === 'device' && s.device === card.dataset.device)
    card.querySelector('.device-status').innerHTML = source
      ? `<span class="badge-ok">✓ Quelle „${esc(source.name)}“</span>`
      : `<button class="btn primary block" data-action="add-device">Als Quelle hinzufügen</button>`
  }
}

$('#device-grid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="add-device"]')
  if (!btn) return
  const label = btn.closest('.device-card').dataset.device
  const source = {
    id: uid('s'),
    name: `Eingang ${config.sources.length + 1}`,
    type: 'device',
    device: label,
    url: '',
    atemInput: '',
    useAtemName: false,
  }
  config.sources.push(source)
  renderAll()
  changed(0)
  toast(`„${source.name}“ angelegt – jetzt noch den ATEM-Eingang eintragen.`)
  document.querySelector(`#source-rows tr[data-id="${source.id}"] [data-s="atemInput"]`)?.focus()
})

// ---------------------------------------------------------------------------
// Eingänge: Netzwerk-Streams (z. B. Matrox Monarch, ATEM-Livestream)
// ---------------------------------------------------------------------------

let streamGridKey = ''

function serverHost() {
  return server.addresses?.[0] || location.hostname
}

/** Erklärt, wie der Stream zum Server kommt (Adresse zum Eintragen im Sender oder Abruf). */
function streamHint(source) {
  if (String(source.url || '').trim()) return 'Wird von dieser Adresse abgeholt.'
  return `Im Sender eintragen – Server: <code>rtmp://${esc(serverHost())}:${server.ports?.rtmp ?? 1935}/</code>
    Stream-Name: <code>${esc(source.id)}</code>`
}

function renderStreams() {
  if (!config) return
  const { status, message } = server.mediamtx ?? {}
  const box = $('#stream-status')
  if (status === 'running') {
    box.className = 'stream-status ok'
    box.innerHTML = '<b>● Stream-Empfang läuft.</b> Netzwerk-Streams werden angenommen und an die Webseite weitergegeben.'
  } else if (status === 'missing') {
    box.className = 'stream-status bad'
    box.innerHTML = `<b>Stream-Empfang nicht installiert.</b>
      Lade <a href="https://github.com/bluenviron/mediamtx/releases" target="_blank" rel="noopener">MediaMTX</a>
      für dein System herunter, lege das Programm als <code>bin/mediamtx</code>
      (Windows: <code>bin\\mediamtx.exe</code>) in den Projektordner und starte den Server neu.`
  } else if (status === 'error') {
    box.className = 'stream-status bad'
    box.innerHTML = `<b>Stream-Empfang gestört:</b> ${esc(message)}`
  } else {
    box.className = 'stream-status'
    box.textContent = 'Status wird abgefragt …'
  }

  const grid = $('#stream-grid')
  const streams = config.sources.filter((s) => s.type === 'stream')
  if (page !== 'eingaenge') {
    if (streamGridKey) grid.replaceChildren()
    streamGridKey = ''
    return
  }
  const key = JSON.stringify([status, streams.map((s) => [s.id, s.url])])
  if (key !== streamGridKey) {
    streamGridKey = key
    grid.replaceChildren()
    for (const s of streams) {
      const card = document.createElement('article')
      card.className = 'card device-card'
      card.dataset.id = s.id
      card.innerHTML = `
        <div class="device-preview"></div>
        <div class="device-body">
          <div class="device-name"></div>
          <div class="device-meta"></div>
          <div class="device-meta stream-hint"></div>
        </div>`
      const preview = card.querySelector('.device-preview')
      const meta = card.querySelectorAll('.device-meta')[0]
      if (status === 'running') {
        const hint = document.createElement('span')
        hint.textContent = 'Warte auf Stream …'
        meta.textContent = 'Kein Signal'
        const video = attachNetworkStream(preview, s.id, hint)
        video.addEventListener('loadedmetadata', () => (meta.textContent = `Empfang ✓ · ${video.videoWidth} × ${video.videoHeight}`))
      } else {
        preview.textContent = 'Stream-Empfang läuft nicht'
      }
      grid.append(card)
    }
  }
  // Name und Hinweis ohne Neuaufbau aktualisieren (Vorschau läuft weiter)
  for (const card of grid.querySelectorAll('.device-card')) {
    const s = streams.find((x) => x.id === card.dataset.id)
    if (!s) continue
    card.querySelector('.device-name').textContent = s.name
    card.querySelector('.stream-hint').innerHTML = streamHint(s)
  }
}

$('#stream-add').addEventListener('click', () => {
  // Die ID ist zugleich der Stream-Name, den man im Sender eintippt – darum kurz und lesbar
  let n = 1
  while (config.sources.some((s) => s.id === `stream${n}`)) n++
  config.sources.push({
    id: `stream${n}`,
    name: `Netzwerk-Stream ${n}`,
    type: 'stream',
    device: '',
    url: '',
    atemInput: '',
    useAtemName: false,
  })
  renderAll()
  changed(0)
})

// ---------------------------------------------------------------------------
// Eingänge: Quellen-Tabelle
// ---------------------------------------------------------------------------

function renderSources() {
  const body = $('#source-rows')
  if (body.contains(document.activeElement) && document.activeElement.type === 'text') return
  const rows = config.sources.map((s) => {
    const typeOptions = Object.entries(SOURCE_TYPES)
      .map(([k, v]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${v}</option>`)
      .join('')
    let target = '<span class="muted">–</span>'
    if (s.type === 'device') {
      target = `<input type="text" list="device-list" data-s="device" value="${esc(s.device)}" placeholder="Gerätename, z. B. DeckLink Duo (1)" spellcheck="false">`
    } else if (s.type === 'stream') {
      target = `<input type="text" data-s="url" value="${esc(s.url)}" placeholder="leer = Stream wird hierher gesendet (RTMP)" spellcheck="false">
        <div class="cell-hint">${streamHint(s)}</div>`
    } else if (s.type === 'url' || s.type === 'image') {
      target = `<input type="text" data-s="url" value="${esc(s.url)}" placeholder="http://…" spellcheck="false">`
    }
    return `<tr data-id="${esc(s.id)}">
      <td><input type="text" data-s="name" value="${esc(s.name)}"></td>
      <td class="w-type"><select data-s="type">${typeOptions}</select></td>
      <td>${target}</td>
      <td class="w-atem"><input type="number" min="0" list="atem-input-list" data-s="atemInput" value="${esc(s.atemInput)}" placeholder="–"></td>
      <td class="center"><input type="checkbox" data-s="useAtemName" ${s.useAtemName ? 'checked' : ''}></td>
      <td class="center"><button class="btn small danger" data-action="delete-source" title="Quelle löschen">✕</button></td>
    </tr>`
  })
  body.innerHTML = rows.join('') || `<tr><td colspan="6" class="muted">Noch keine Quellen.</td></tr>`
}

function onSourceField(e) {
  const el = e.target
  const key = el.dataset.s
  if (!key) return
  if ((e.type === 'input') !== (el.type === 'text')) return
  const source = config.sources.find((s) => s.id === el.closest('tr').dataset.id)
  if (key === 'useAtemName') source.useAtemName = el.checked
  else if (key === 'atemInput') source.atemInput = el.value === '' ? '' : Number(el.value)
  else source[key] = el.value
  if (key === 'type') {
    el.blur()
    renderSources()
  }
  if (source.type === 'stream' && (key === 'url' || key === 'name')) {
    const hint = el.closest('tr').querySelector('.cell-hint')
    if (hint) hint.innerHTML = streamHint(source)
  }
  updateDeviceStatus()
  renderStreams()
  renderCanvas()
  changed()
}
$('#source-rows').addEventListener('input', onSourceField)
$('#source-rows').addEventListener('change', onSourceField)

$('#source-rows').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action="delete-source"]')
  if (!btn) return
  const id = btn.closest('tr').dataset.id
  const source = config.sources.find((s) => s.id === id)
  if (!confirm(`Quelle „${source.name}“ löschen? Kacheln mit dieser Quelle werden leer.`)) return
  config.sources = config.sources.filter((s) => s.id !== id)
  for (const l of config.layouts) for (const t of l.tiles) if (t.sourceId === id) t.sourceId = null
  renderAll()
  changed(0)
})

$('#source-add').addEventListener('click', () => {
  config.sources.push({
    id: uid('s'),
    name: `Quelle ${config.sources.length + 1}`,
    type: 'test',
    device: '',
    url: '',
    atemInput: '',
    useAtemName: false,
  })
  renderAll()
  changed(0)
  $('#source-rows tr:last-child input')?.focus()
})

// ---------------------------------------------------------------------------
// Layouts: Liste
// ---------------------------------------------------------------------------

function currentLayout() {
  return config?.layouts.find((l) => l.id === layoutId) ?? null
}

function renderLayoutList() {
  $('#layout-list').innerHTML = config.layouts
    .map((l, i) => {
      const usedBy = config.outputs.filter((o) => o.layoutId === l.id).length
      return `<li data-id="${esc(l.id)}" class="${l.id === layoutId ? 'active' : ''}" title="${usedBy ? `auf ${usedBy} Multiview(s) aktiv` : ''}">
        <span>${i + 1}. ${esc(l.name)}</span>
        <span class="meta">${usedBy ? '● live' : ''}</span>
      </li>`
    })
    .join('')
}

$('#layout-list').addEventListener('click', (e) => {
  const li = e.target.closest('li')
  if (!li) return
  layoutId = li.dataset.id
  selectedTileId = null
  renderLayoutList()
  renderCanvas()
  renderInspector()
  syncStreams()
})

$('#layout-add').addEventListener('click', () => {
  const layout = {
    id: uid('l'),
    name: `Layout ${config.layouts.length + 1}`,
    cols: 12,
    rows: 12,
    gap: 4,
    background: '#000000',
    tiles: [],
  }
  config.layouts.push(layout)
  layoutId = layout.id
  selectedTileId = null
  renderAll()
  changed(0)
})

// ---------------------------------------------------------------------------
// Layouts: gespeicherte Ansichten (liegen als JSON-Dateien auf dem Server)
// ---------------------------------------------------------------------------

function formatSavedAt(iso) {
  const d = iso && new Date(iso)
  if (!d || isNaN(d)) return ''
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function renderTemplates() {
  $('#template-list').innerHTML = templates.length
    ? templates
        .map(
          (t) => `<li data-id="${esc(t.id)}">
            <span class="name">${esc(t.name)}</span>
            <span class="meta">${t.tiles} Kachel(n)${t.savedAt ? ` · ${esc(formatSavedAt(t.savedAt))}` : ''}</span>
            <div class="btn-row">
              <button class="btn small primary" data-action="load" title="In das gewählte Layout laden">Laden</button>
              <a class="btn small" href="/api/templates/${encodeURIComponent(t.id)}?download" download title="Als Datei herunterladen">↓</a>
              <button class="btn small danger" data-action="delete" title="Vorlage löschen">✕</button>
            </div>
          </li>`,
        )
        .join('')
    : '<li class="muted empty">Noch nichts gespeichert.</li>'
}

async function postTemplate(name, layout) {
  const res = await fetch('/api/templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, layout }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
  return body
}

/** Gleicher Dateiname wie auf dem Server – dort wird eine gleichnamige Vorlage überschrieben. */
function existingTemplate(name) {
  const id = name.toLowerCase().replace(/[^a-z0-9äöüß]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return templates.find((t) => t.id === id)
}

$('#template-save').addEventListener('click', async () => {
  const layout = currentLayout()
  if (!layout) return toast('Erst ein Layout anlegen.')
  const name = prompt('Name für die gespeicherte Ansicht:', layout.name)?.trim()
  if (!name) return
  const existing = existingTemplate(name)
  if (existing && !confirm(`„${existing.name}“ gibt es schon. Überschreiben?`)) return
  try {
    await postTemplate(name, layout)
    toast(`„${name}“ gespeichert.`)
  } catch (err) {
    toast(`Speichern fehlgeschlagen: ${err.message}`)
  }
})

$('#template-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]')
  if (!btn) return
  const id = btn.closest('li').dataset.id
  const entry = templates.find((t) => t.id === id)
  if (!entry) return

  if (btn.dataset.action === 'delete') {
    if (!confirm(`Gespeicherte Ansicht „${entry.name}“ löschen?`)) return
    const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => null)
    if (!res?.ok) toast('Löschen fehlgeschlagen.')
    return
  }

  let layout = currentLayout()
  if (layout && !confirm(`„${entry.name}“ in das Layout „${layout.name}“ laden?\nDie Kacheln dort werden ersetzt – auf den Monitoren sofort sichtbar.`)) return
  let template
  try {
    const res = await fetch(`/api/templates/${encodeURIComponent(id)}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    template = await res.json()
  } catch (err) {
    return toast(`Laden fehlgeschlagen: ${err.message}`)
  }
  if (!layout) {
    layout = { id: uid('l'), name: template.name, tiles: [] }
    config.layouts.push(layout)
    layoutId = layout.id
  }
  const { cols, rows, gap, background, tiles } = template.layout
  Object.assign(layout, { cols, rows, gap, background })
  layout.tiles = tiles.map((t) => ({
    ...t,
    id: uid('t'),
    // Inzwischen gelöschte Quellen nicht mitnehmen
    sourceId: config.sources.some((s) => s.id === t.sourceId) ? t.sourceId : null,
  }))
  selectedTileId = null
  renderAll()
  changed(0)
  toast(`„${template.name}“ geladen.`)
})

$('#template-file').addEventListener('change', (e) => {
  const input = e.target
  const file = input.files[0]
  input.value = ''
  if (!file) return
  // FileReader statt file.text() – das kennt iOS 12 noch nicht
  const reader = new FileReader()
  reader.onload = async () => {
    let data
    try {
      data = JSON.parse(reader.result)
    } catch {
      return toast('Die Datei ist keine gültige Vorlage.')
    }
    const name = String(data?.name || file.name.replace(/\.json$/i, '')).trim()
    const existing = existingTemplate(name)
    if (existing && !confirm(`„${existing.name}“ gibt es schon. Überschreiben?`)) return
    try {
      await postTemplate(name, data?.layout)
      toast(`„${name}“ importiert.`)
    } catch (err) {
      toast(`Import fehlgeschlagen: ${err.message}`)
    }
  }
  reader.readAsText(file)
})

const livePreviewToggle = $('#live-preview')
livePreviewToggle.checked = livePreview
livePreviewToggle.addEventListener('change', () => {
  livePreview = livePreviewToggle.checked
  writePref('livePreview', livePreview)
  renderCanvas()
  syncStreams()
})

// ---------------------------------------------------------------------------
// Layouts: Arbeitsfläche
// ---------------------------------------------------------------------------

const canvas = $('#canvas')

function renderCanvas() {
  const layout = currentLayout()
  if (canvas.dataset.layout !== (layout?.id ?? '')) {
    canvas.replaceChildren()
    canvas.dataset.layout = layout?.id ?? ''
  }
  if (!layout) {
    canvas.innerHTML = '<div class="canvas-empty">Lege links ein Layout an.</div>'
    return
  }
  canvas.style.setProperty('--cols', layout.cols)
  canvas.style.setProperty('--rows', layout.rows)
  canvas.style.backgroundColor = layout.background || '#000'

  // Vorhandene Kachel-Elemente wiederverwenden, damit Live-Bilder nicht flackern
  const existing = new Map([...canvas.querySelectorAll('.etile')].map((el) => [el.dataset.id, el]))
  const ordered = layout.tiles.map((tile) => {
    let el = existing.get(tile.id)
    existing.delete(tile.id)
    if (!el) {
      el = document.createElement('div')
      el.className = 'etile'
      el.dataset.id = tile.id
      el.innerHTML = `<div class="etile-body"><div class="etile-title"></div><div class="etile-sub"></div></div><div class="handle"></div>`
    }
    applyBox(el, tile, layout)
    syncTileMedia(el, tile)
    syncTileMeter(el, tile)
    syncTileProPresenter(el, tile)
    return el
  })
  existing.forEach((el) => el.remove())
  const current = [...canvas.querySelectorAll('.etile')]
  if (ordered.some((el, i) => current[i] !== el)) {
    canvas.append(...ordered)
    canvas.querySelectorAll('video').forEach((v) => v.paused && v.play().catch(() => {}))
  }
  updateCanvasOverlays()
}

/** Pegelanzeige in der Editor-Kachel – zeigt Lage, Größe und Art so wie auf dem Monitor, mit Live-Pegeln. */
function syncTileMeter(el, tile) {
  if (tile.kind === 'audio') {
    // Pegel-Fenster
    const channels = tileChannels(tile)
    const signature = JSON.stringify(['bank', channels, tile.bank])
    if (el.dataset.meterKey === signature) return
    el.dataset.meterKey = signature
    el.querySelector('.meter, .meter-bank')?.remove()
    const bank = createMeterBank(channels, tile.bank)
    el.bankLabels = bank.labels
    el.classList.add('bank')
    el.append(bank.el)
    return
  }
  el.classList.remove('bank')
  el.bankLabels = null
  const key =
    (tile.kind ?? 'source') === 'source' && tile.showMeter === true
      ? meterKeyFor(config.sources.find((s) => s.id === tile.sourceId))
      : null
  const signature = key === null ? '' : JSON.stringify([key, tile.meter])
  if (el.dataset.meterKey === signature) return
  el.dataset.meterKey = signature
  el.querySelector('.meter, .meter-bank')?.remove()
  if (signature) el.append(createMeter(key, tile.meter))
}

/** ProPresenter-Kachel im Editor – zeigt live, was ProPresenter gerade zeigt. */
function syncTileProPresenter(el, tile) {
  const signature =
    tile.kind === 'propresenter'
      ? JSON.stringify(['pp', ppOptions(tile.pp)])
      : tile.kind === 'playlist'
        ? JSON.stringify(['playlist', playlistOptions(tile.playlist)])
        : tile.kind === 'preacher'
          ? JSON.stringify(['preacher', preacherOptions(tile.preacher)])
          : ''
  if (el.dataset.ppKey === signature) return
  el.dataset.ppKey = signature
  el.querySelector('.pp-view, .pl-view, .pr-view')?.remove()
  el.ppView = null
  el.classList.toggle('covered', Boolean(signature))
  if (!signature) return
  // Im Editor nur Vorschau: Tasten und Folien lösen hier nichts aus
  el.ppView =
    tile.kind === 'playlist'
      ? createPlaylistView(tile.playlist)
      : tile.kind === 'preacher'
        ? createPreacherView(tile.preacher)
        : createProPresenterView(tile.pp)
  el.ppView.update(propresenter)
  el.append(el.ppView.el)
}

function syncTileMedia(el, tile) {
  const source = tile.kind === 'source' ? config.sources.find((s) => s.id === tile.sourceId) : null
  // Der Chat ist immer live zu sehen, so wie auf den Monitoren
  const key =
    tile.kind === 'chat'
      ? 'chat'
      : tile.kind === 'churchtools'
        ? JSON.stringify(['churchtools', tile.ctFilter, tile.ctResponsible, tile.ctNotes, tile.ctDate])
        : livePreview && source
        ? JSON.stringify([source.type, source.device, source.url, source.name])
        : ''
  if (el.dataset.mediaKey === key) return
  el.dataset.mediaKey = key
  el.querySelector('.etile-media')?.remove()
  el.classList.toggle('live', Boolean(key))
  el.classList.toggle('chat-tile', tile.kind === 'chat' || tile.kind === 'churchtools')
  if (!key) return
  const media = document.createElement('div')
  media.className = 'etile-media'
  if (tile.kind === 'chat') {
    const view = createChatView()
    view.update(chat)
    chatViews.add(view)
    media.append(view.el)
  } else if (tile.kind === 'churchtools') {
    const view = createAgendaView(tile)
    view.update(churchtools)
    agendaViews.add(view)
    media.append(view.el)
  } else if (source.type === 'device') {
    const hint = document.createElement('span')
    hint.className = 'placeholder'
    hint.textContent = 'Kein Signal'
    attachDevice(media, source.device, hint)
  } else if (source.type === 'stream') {
    const hint = document.createElement('span')
    hint.className = 'placeholder'
    hint.textContent = 'Warte auf Stream'
    attachNetworkStream(media, source.id, hint)
  } else if (source.type === 'url') {
    const video = makeVideo()
    video.loop = true
    video.src = source.url
    media.append(video)
  } else if (source.type === 'image') {
    const img = document.createElement('img')
    img.src = source.url
    img.alt = ''
    media.append(img)
  } else {
    media.append(makeTestPattern(source.name))
  }
  el.prepend(media)
}

function describeTile(tile) {
  if (tile.kind === 'clock') return { title: 'Uhr', sub: 'aktuelle Uhrzeit' }
  if (tile.kind === 'text') return { title: tile.text || 'Text', sub: 'Text' }
  if (tile.kind === 'audio') return { title: 'Pegel-Fenster', sub: `${tileChannels(tile).length} Pegel` }
  if (tile.kind === 'chat') return { title: 'Kesher-Chat', sub: 'Chat' }
  if (tile.kind === 'churchtools') {
    const day = tile.ctDate ? new Date(`${tile.ctDate}T12:00:00Z`).toLocaleDateString('de-DE', { timeZone: 'UTC' }) : 'heute'
    return { title: 'ChurchTools-Ablauf', sub: [day, tile.ctFilter].filter(Boolean).join(' · ') }
  }
  if (tile.kind === 'propresenter') return { title: 'ProPresenter', sub: 'Folien' }
  if (tile.kind === 'playlist') return { title: 'Playlist', sub: 'ProPresenter' }
  if (tile.kind === 'preacher') return { title: 'Prediger', sub: 'ProPresenter-Steuerung' }
  const source = config.sources.find((s) => s.id === tile.sourceId)
  if (!source) return { title: 'Keine Quelle', sub: '' }
  const atemPart = source.atemInput !== '' && source.atemInput != null ? ` · ATEM ${source.atemInput}` : ''
  return { title: tile.label || sourceLabel(source, atem), sub: `${SOURCE_TYPES[source.type] ?? source.type}${atemPart}` }
}

/** Aktualisiert Beschriftung, Auswahl und Tally der Kacheln ohne Neuaufbau. */
function updateCanvasOverlays() {
  const layout = currentLayout()
  if (!layout) return
  for (const el of canvas.querySelectorAll('.etile')) {
    const tile = layout.tiles.find((t) => t.id === el.dataset.id)
    if (!tile) continue
    const { title, sub } = describeTile(tile)
    el.querySelector('.etile-title').textContent = title
    el.querySelector('.etile-sub').textContent = sub
    const source = tile.kind === 'source' ? config.sources.find((s) => s.id === tile.sourceId) : null
    const tally = tile.showTally !== false ? tallyOf(source, atem) : null
    el.classList.toggle('program', tally === 'program')
    el.classList.toggle('preview', tally === 'preview')
    el.classList.toggle('selected', tile.id === selectedTileId)
    for (const { el: label, channel } of el.bankLabels ?? []) {
      label.textContent = channelName(channel, atem)
      label.classList.toggle('program', atem.program?.includes(Number(channel.input)) ?? false)
    }
  }
}

function selectTile(id) {
  if (selectedTileId === id) return
  selectedTileId = id
  updateCanvasOverlays()
  renderInspector()
}

function newTile(rect) {
  return {
    id: uid('t'),
    kind: 'source',
    sourceId: nextFreeSource()?.id ?? null,
    ...rect,
    showLabel: true,
    showTally: true,
    fit: 'contain',
    label: '',
    text: '',
  }
}

/** Die erste Quelle, die im aktuellen Layout noch nicht benutzt wird. */
function nextFreeSource() {
  const used = new Set(currentLayout()?.tiles.map((t) => t.sourceId))
  return config.sources.find((s) => !used.has(s.id)) ?? config.sources[0]
}

canvas.addEventListener('pointerdown', (e) => {
  const layout = currentLayout()
  if (!layout || e.button !== 0) return
  const rect = canvas.getBoundingClientRect()
  const cw = rect.width / layout.cols
  const ch = rect.height / layout.rows
  const tileEl = e.target.closest('.etile')
  canvas.setPointerCapture(e.pointerId)

  if (tileEl) {
    const tile = layout.tiles.find((t) => t.id === tileEl.dataset.id)
    selectTile(tile.id)
    dragging = {
      mode: e.target.classList.contains('handle') ? 'resize' : 'move',
      layout, tile, el: tileEl, cw, ch,
      startX: e.clientX, startY: e.clientY,
      orig: { ...tile },
    }
  } else {
    selectTile(null)
    const cell = {
      x: clamp(Math.floor((e.clientX - rect.left) / cw), 0, layout.cols - 1),
      y: clamp(Math.floor((e.clientY - rect.top) / ch), 0, layout.rows - 1),
    }
    const ghost = document.createElement('div')
    ghost.className = 'ghost'
    ghost.hidden = true
    canvas.append(ghost)
    dragging = { mode: 'create', layout, rect, cw, ch, cell, ghost, startX: e.clientX, startY: e.clientY, box: null }
  }
})

canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return
  const d = dragging
  const { layout } = d
  if (d.mode === 'move' || d.mode === 'resize') {
    const dx = Math.round((e.clientX - d.startX) / d.cw)
    const dy = Math.round((e.clientY - d.startY) / d.ch)
    if (d.mode === 'move') {
      d.tile.x = clamp(d.orig.x + dx, 0, layout.cols - d.tile.w)
      d.tile.y = clamp(d.orig.y + dy, 0, layout.rows - d.tile.h)
    } else {
      d.tile.w = clamp(d.orig.w + dx, 1, layout.cols - d.tile.x)
      d.tile.h = clamp(d.orig.h + dy, 1, layout.rows - d.tile.y)
    }
    applyBox(d.el, d.tile, layout)
  } else if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > 4) {
    const x = clamp(Math.floor((e.clientX - d.rect.left) / d.cw), 0, layout.cols - 1)
    const y = clamp(Math.floor((e.clientY - d.rect.top) / d.ch), 0, layout.rows - 1)
    d.box = {
      x: Math.min(x, d.cell.x),
      y: Math.min(y, d.cell.y),
      w: Math.abs(x - d.cell.x) + 1,
      h: Math.abs(y - d.cell.y) + 1,
    }
    d.ghost.hidden = false
    applyBox(d.ghost, d.box, layout)
  }
})

function endDrag() {
  if (!dragging) return
  const d = dragging
  dragging = null
  if (d.mode === 'create') {
    d.ghost.remove()
    if (!d.box) return
    const tile = newTile(d.box)
    d.layout.tiles.push(tile)
    selectedTileId = tile.id
    renderCanvas()
    renderInspector()
    syncStreams()
    changed(0)
  } else if (['x', 'y', 'w', 'h'].some((k) => d.tile[k] !== d.orig[k])) {
    renderInspector()
    changed(0)
  }
}
canvas.addEventListener('pointerup', endDrag)
canvas.addEventListener('pointercancel', endDrag)

document.addEventListener('keydown', (e) => {
  if (page !== 'layouts' || e.target.closest('input, select, textarea')) return
  const layout = currentLayout()
  const tile = layout?.tiles.find((t) => t.id === selectedTileId)
  if (!tile) return
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    deleteTile(tile)
    return
  }
  if (e.key === 'Escape') {
    selectTile(null)
    return
  }
  const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]
  if (!step) return
  e.preventDefault()
  if (e.shiftKey) {
    tile.w = clamp(tile.w + step[0], 1, layout.cols - tile.x)
    tile.h = clamp(tile.h + step[1], 1, layout.rows - tile.y)
  } else {
    tile.x = clamp(tile.x + step[0], 0, layout.cols - tile.w)
    tile.y = clamp(tile.y + step[1], 0, layout.rows - tile.h)
  }
  renderCanvas()
  renderInspector()
  changed()
})

function deleteTile(tile) {
  const layout = currentLayout()
  layout.tiles = layout.tiles.filter((t) => t !== tile)
  selectedTileId = null
  renderCanvas()
  renderInspector()
  syncStreams()
  changed(0)
}

// ---------------------------------------------------------------------------
// Layouts: Eigenschaften (rechte Spalte)
// ---------------------------------------------------------------------------

const inspector = $('#inspector')

function renderInspector() {
  const layout = currentLayout()
  if (!layout) {
    inspector.innerHTML = '<p class="muted">Kein Layout ausgewählt.</p>'
    return
  }
  const tile = layout.tiles.find((t) => t.id === selectedTileId)
  inspector.innerHTML = tile ? tileInspector(tile, layout) : layoutInspector(layout)
}

function presetIcon(rects) {
  return `<span class="preset-icon">${rects
    .map((r) => `<i style="left:${(r.x / 12) * 100}%;top:${(r.y / 12) * 100}%;width:${(r.w / 12) * 100}%;height:${(r.h / 12) * 100}%"></i>`)
    .join('')}</span>`
}

function layoutInspector(layout) {
  return `
    <h3>Layout</h3>
    <label class="field"><span>Name</span><input type="text" data-l="name" value="${esc(layout.name)}"></label>
    <div class="row">
      <label class="field"><span>Raster Spalten</span><input type="number" min="1" max="48" data-l="cols" value="${layout.cols}"></label>
      <label class="field"><span>Raster Zeilen</span><input type="number" min="1" max="48" data-l="rows" value="${layout.rows}"></label>
    </div>
    <div class="row">
      <label class="field"><span>Abstand (px)</span><input type="number" min="0" max="40" data-l="gap" value="${layout.gap ?? 4}"></label>
      <label class="field"><span>Hintergrund</span><input type="color" data-l="background" value="${esc(layout.background || '#000000')}"></label>
    </div>
    <hr class="divider">
    <h3>Vorlagen</h3>
    <div class="presets">
      ${Object.entries(PRESETS)
        .map(([name, rects]) => `<button class="btn" data-preset="${esc(name)}" title="Vorlage ${esc(name)}">${presetIcon(rects)}${esc(name)}</button>`)
        .join('')}
    </div>
    <p class="muted" style="font-size:13px">Vorlagen ersetzen die Kacheln und belegen sie der Reihe nach mit deinen Quellen.</p>
    <hr class="divider">
    <div class="btn-row">
      <button class="btn" data-action="duplicate-layout">Duplizieren</button>
      <button class="btn danger" data-action="delete-layout">Löschen</button>
    </div>
    <p class="muted" style="font-size:13px">${layout.tiles.length} Kachel(n). Kachel anklicken, um sie zu bearbeiten.</p>
  `
}

/** Auswahl der ATEM-Audioeingänge: Summe, die Videoeingänge mit Ton und die reinen Audioeingänge. */
function audioOptions(selected) {
  const ids = atem.audioInputs?.length ? atem.audioInputs : []
  const opts = [['master', 'Summe (Program)'], ...ids.map((id) => [id, `${id} – ${audioInputName(id, atem)}`])]
  if (selected != null && selected !== 'master' && !ids.includes(Number(selected))) {
    opts.push([selected, `${selected} – ${audioInputName(selected, atem)}`])
  }
  return opts
    .map(([v, label]) => `<option value="${esc(v)}" ${String(v) === String(selected ?? 'master') ? 'selected' : ''}>${esc(label)}</option>`)
    .join('')
}

/** Einstellungen der Pegelanzeige (Lage, Darstellung, Dicke, Länge, Skala). */
function meterSection(tile) {
  const m = meterOptions(tile.meter)
  const positions = [['left', 'Links'], ['right', 'Rechts'], ['top', 'Oben (quer)'], ['bottom', 'Unten (quer)']]
  const options = (list, value) =>
    list.map(([k, label]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${label}</option>`).join('')
  return `
    <div class="meter-settings">
      <h4>Pegelanzeige</h4>
      <div class="row">
        <label class="field"><span>Position</span><select data-m="position">${options(positions, m.position)}</select></label>
        <label class="field"><span>Darstellung</span><select data-m="style">${options([['bar', 'Balken'], ['segments', 'LED-Segmente']], m.style)}</select></label>
      </div>
      <label class="field"><span>Dicke <output>${Math.round(m.size * 100)} %</output></span>
        <input type="range" min="0.5" max="8" step="0.25" data-m="size" value="${m.size}"></label>
      <label class="field"><span>Länge <output>${m.length} %</output></span>
        <input type="range" min="15" max="100" step="5" data-m="length" value="${m.length}"></label>
      <label class="check"><input type="checkbox" data-m="scale" ${m.scale ? 'checked' : ''}> dB-Skala anzeigen</label>
      <button class="btn small" data-action="meter-all">Für alle Videokacheln im Layout übernehmen</button>
    </div>`
}

/** Playlist-Kachel: Vorschaubilder und Schriftgröße. */
function playlistSection(tile) {
  const o = playlistOptions(tile.playlist)
  return `
    <div class="meter-settings">
      <h4>Playlist</h4>
      <p class="muted" style="margin:0;font-size:12px">Zeigt die aktive Playlist von ProPresenter. Das laufende Lied ist rot, das nächste grün markiert, gespielte sind abgeblendet.</p>
      <label class="check"><input type="checkbox" data-pl="thumbs" ${o.thumbs ? 'checked' : ''}> Hintergrund-Vorschau anzeigen</label>
      <label class="field"><span>Schriftgröße <output>${Math.round(o.size * 100)} %</output></span>
        <input type="range" min="0.6" max="2" step="0.1" data-pl="size" value="${o.size}"></label>
    </div>`
}

/** ProPresenter-Kachel: was angezeigt wird. */
function ppSection(tile) {
  const o = ppOptions(tile.pp)
  const options = (list, value) =>
    list.map(([k, label]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${label}</option>`).join('')
  return `
    <div class="meter-settings">
      <h4>ProPresenter</h4>
      <label class="field"><span>Folien</span><select data-p="show">${options(
        [
          ['both', 'Aktuelle und nächste Folie'],
          ['current', 'Nur aktuelle Folie'],
          ['next', 'Nur nächste Folie'],
          ['backgrounds', 'Hintergrund jetzt und nächster'],
          ['nextBackground', 'Nur nächster Hintergrund'],
        ],
        o.show,
      )}</select></label>
      <label class="field"><span>Inhalt</span><select data-p="content">${options(
        [['image', 'Folienbild'], ['text', 'Nur Text (groß)'], ['both', 'Bild und Text']],
        o.content,
      )}</select></label>
      <label class="field"><span>Als „nächste Folie“ zeigen</span><select data-p="nextMode">${options(
        [['background', 'Nächste Folie mit Hintergrund'], ['direct', 'Direkt folgende Folie']],
        o.nextMode,
      )}</select></label>
      <label class="check"><input type="checkbox" data-p="showName" ${o.showName ? 'checked' : ''}> Name der Präsentation anzeigen</label>
      <label class="check"><input type="checkbox" data-p="showControls" ${o.showControls ? 'checked' : ''}> Steuer-Tasten einblenden (Zurück / Ausblenden / Weiter)</label>
      ${o.showControls ? blankModeField('data-p', o.blankMode) : ''}
      <p class="muted" style="margin:0;font-size:12px">„Mit Hintergrund“ springt zur nächsten Folie, die einen anderen Hintergrund startet (Video, Bild, PDF …) – nie zu reinem Text. Hat der Bediener in ProPresenter schon ein anderes Lied angeklickt (z. B. eins übersprungen), kommt sie aus diesem Lied.</p>
      ${propresenter.connected ? '' : '<p class="muted" style="margin:0;font-size:12px">ProPresenter ist nicht verbunden – Adresse unter <a href="#/einstellungen">Einstellungen</a> prüfen.</p>'}
    </div>`
}

/** Auswahl, was „Ausblenden“ bei ProPresenter wegnimmt. */
function blankModeField(attr, value) {
  return `<label class="field"><span>„Ausblenden“ blendet aus</span><select ${attr}="blankMode">
    <option value="clear" ${value === 'clear' ? 'selected' : ''}>Nur die Folie (Hintergrund bleibt)</option>
    <option value="clearAll" ${value === 'clearAll' ? 'selected' : ''}>Folie und Hintergrund</option>
  </select></label>`
}

/** Prediger-Kachel: Größe der Folien, Ausblenden-Art, Tasten. */
function preacherSection(tile) {
  const o = preacherOptions(tile.preacher)
  return `
    <div class="meter-settings">
      <h4>Prediger</h4>
      <p class="muted" style="margin:0;font-size:12px">Zeigt alle Folien der laufenden Präsentation (Predigt oder Lied) wie in ProPresenter. Auf dem Monitor löst Antippen einer Folie sie in ProPresenter aus; die Tasten schalten weiter, zurück oder blenden aus. Hier im Editor ist alles nur Vorschau.</p>
      <label class="field"><span>Foliengröße <output>${Math.round(o.size * 100)} %</output></span>
        <input type="range" min="0.5" max="2.5" step="0.1" data-pr="size" value="${o.size}"></label>
      <label class="check"><input type="checkbox" data-pr="showControls" ${o.showControls ? 'checked' : ''}> Tasten Zurück / Ausblenden / Weiter</label>
      ${blankModeField('data-pr', o.blankMode)}
      ${propresenter.connected ? '' : '<p class="muted" style="margin:0;font-size:12px">ProPresenter ist nicht verbunden – Adresse unter <a href="#/einstellungen">Einstellungen</a> prüfen.</p>'}
    </div>`
}

/** Pegel-Fenster: Liste der Pegel (Quelle + Name) und Darstellung. */
function bankSection(tile) {
  const channels = tileChannels(tile)
  const b = bankOptions(tile.bank)
  const options = (list, value) =>
    list.map(([k, label]) => `<option value="${k}" ${k === value ? 'selected' : ''}>${label}</option>`).join('')
  const rows = channels
    .map(
      (ch, i) => `<div class="channel-row" data-index="${i}">
        <select data-ch="input" aria-label="Quelle von Pegel ${i + 1}">${audioOptions(ch.input)}</select>
        <input type="text" data-ch="label" value="${esc(ch.label)}" placeholder="${esc(audioInputName(ch.input, atem))}" aria-label="Name von Pegel ${i + 1}">
        <div class="channel-actions">
          <button class="btn small" data-action="channel-up" title="Nach vorne" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn small" data-action="channel-down" title="Nach hinten" ${i === channels.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn small danger" data-action="channel-remove" title="Pegel entfernen">✕</button>
        </div>
      </div>`,
    )
    .join('')
  return `
    <div class="meter-settings">
      <h4>Pegel in diesem Fenster</h4>
      <p class="muted" style="margin:0;font-size:12px">Für jeden Pegel die Quelle wählen. Der Name ist optional – leer = Name vom ATEM.</p>
      <div class="channel-list">${rows || '<p class="muted" style="margin:0">Noch keine Pegel.</p>'}</div>
      <div class="btn-row">
        <button class="btn small primary" data-action="channel-add">+ Pegel</button>
        <button class="btn small" data-action="channel-add-active" title="Alle ATEM-Eingänge, an denen gerade Ton anliegt">+ Alle mit Ton</button>
      </div>
    </div>
    <div class="meter-settings">
      <h4>Darstellung</h4>
      <div class="row">
        <label class="field"><span>Anordnung</span><select data-b="orientation">${options([['vertical', 'Nebeneinander (senkrecht)'], ['horizontal', 'Untereinander (quer)']], b.orientation)}</select></label>
        <label class="field"><span>Darstellung</span><select data-b="style">${options([['bar', 'Balken'], ['segments', 'LED-Segmente']], b.style)}</select></label>
      </div>
      <label class="check"><input type="checkbox" data-b="fill" ${b.fill ? 'checked' : ''}> Ganzes Feld ausfüllen</label>
      ${
        b.fill
          ? ''
          : `<label class="field"><span>Dicke <output>${Math.round(b.size * 100)} %</output></span>
        <input type="range" min="0.5" max="8" step="0.25" data-b="size" value="${b.size}"></label>`
      }
      <label class="field"><span>Abstand zwischen den Pegeln <output>${Math.round(b.gap * 100)} %</output></span>
        <input type="range" min="0" max="4" step="0.25" data-b="gap" value="${b.gap}"></label>
      <label class="check"><input type="checkbox" data-b="labels" ${b.labels ? 'checked' : ''}> Namen anzeigen</label>
      <label class="check"><input type="checkbox" data-b="scale" ${b.scale ? 'checked' : ''}> dB-Skala anzeigen</label>
    </div>`
}

function tileInspector(tile, layout) {
  const sourceOptions = [
    `<option value="">– keine –</option>`,
    ...config.sources.map((s) => `<option value="${esc(s.id)}" ${s.id === tile.sourceId ? 'selected' : ''}>${esc(s.name)}</option>`),
  ].join('')
  const kind = tile.kind || 'source'
  return `
    <div class="panel-head" style="margin:0"><h3>Kachel</h3><button class="btn small" data-action="deselect">← Layout</button></div>
    <label class="field"><span>Inhalt</span>
      <select data-t="kind">
        <option value="source" ${kind === 'source' ? 'selected' : ''}>Videoquelle</option>
        <option value="clock" ${kind === 'clock' ? 'selected' : ''}>Uhr</option>
        <option value="text" ${kind === 'text' ? 'selected' : ''}>Text</option>
        <option value="audio" ${kind === 'audio' ? 'selected' : ''}>Pegel-Fenster (Audio)</option>
        <option value="chat" ${kind === 'chat' ? 'selected' : ''}>Kesher-Chat</option>
        <option value="churchtools" ${kind === 'churchtools' ? 'selected' : ''}>ChurchTools-Ablauf</option>
        <option value="propresenter" ${kind === 'propresenter' ? 'selected' : ''}>ProPresenter (Folien / Hintergründe)</option>
        <option value="playlist" ${kind === 'playlist' ? 'selected' : ''}>ProPresenter-Playlist</option>
        <option value="preacher" ${kind === 'preacher' ? 'selected' : ''}>ProPresenter-Prediger (Folien steuern)</option>
      </select>
    </label>
    ${
      kind === 'source'
        ? `
      <label class="field"><span>Quelle</span><select data-t="sourceId">${sourceOptions}</select></label>
      <label class="field"><span>Eigene Beschriftung (leer = automatisch)</span><input type="text" data-t="label" value="${esc(tile.label)}"></label>
      <label class="check"><input type="checkbox" data-t="showLabel" ${tile.showLabel !== false ? 'checked' : ''}> Beschriftung anzeigen</label>
      <label class="check"><input type="checkbox" data-t="showTally" ${tile.showTally !== false ? 'checked' : ''}> Tally-Rahmen anzeigen</label>
      <label class="check"><input type="checkbox" data-t="showMeter" ${tile.showMeter === true ? 'checked' : ''}> Audiopegel in dieser Kachel</label>
      <label class="check"><input type="checkbox" data-t="fit" ${tile.fit === 'cover' ? 'checked' : ''}> Bild füllen (beschneiden)</label>
      ${tile.showMeter === true ? meterSection(tile) : ''}`
        : ''
    }
    ${kind === 'text' ? `<label class="field"><span>Text</span><input type="text" data-t="text" value="${esc(tile.text)}"></label>` : ''}
    ${
      kind === 'churchtools'
        ? `
      <label class="field"><span>Datum</span>
        <select data-t="ctDateMode">
          <option value="today" ${!tile.ctDate ? 'selected' : ''}>Aktuelles Datum</option>
          <option value="fixed" ${tile.ctDate ? 'selected' : ''}>Festes Datum …</option>
        </select>
      </label>
      ${tile.ctDate ? `<label class="field"><span>Tag</span><input type="date" data-t="ctDate" value="${esc(tile.ctDate)}" required></label>` : ''}
      <label class="field"><span>Event (Name oder Kalender enthält, leer = laufendes/nächstes)</span><input type="text" data-t="ctFilter" value="${esc(tile.ctFilter)}" placeholder="z. B. Gottesdienst"></label>
      <label class="check"><input type="checkbox" data-t="ctResponsible" ${tile.ctResponsible !== false ? 'checked' : ''}> Verantwortliche anzeigen</label>
      <label class="check"><input type="checkbox" data-t="ctNotes" ${tile.ctNotes === true ? 'checked' : ''}> Notizen anzeigen</label>
      <p class="muted">Zeigt den Ablauf des heutigen Events aus ChurchTools. Verbindung unter <a href="#einstellungen">Einstellungen</a>.</p>`
        : ''
    }
    ${kind === 'chat' ? `<p class="muted">Zeigt den Kesher-Chat, auf allen Monitoren und Vorschauen gleich. Der Server ist dafür einmal bei Kesher angemeldet. Adresse und Rolle unter <a href="#einstellungen">Einstellungen</a>.</p>` : ''}
    ${kind === 'audio' ? bankSection(tile) : ''}
    ${kind === 'propresenter' ? ppSection(tile) : ''}
    ${kind === 'playlist' ? playlistSection(tile) : ''}
    ${kind === 'preacher' ? preacherSection(tile) : ''}
    <hr class="divider">
    <div class="row4">
      <label class="field"><span>X</span><input type="number" min="0" max="${layout.cols - 1}" data-t="x" value="${tile.x}"></label>
      <label class="field"><span>Y</span><input type="number" min="0" max="${layout.rows - 1}" data-t="y" value="${tile.y}"></label>
      <label class="field"><span>Breite</span><input type="number" min="1" max="${layout.cols}" data-t="w" value="${tile.w}"></label>
      <label class="field"><span>Höhe</span><input type="number" min="1" max="${layout.rows}" data-t="h" value="${tile.h}"></label>
    </div>
    <div class="btn-row">
      <button class="btn small" data-action="front">Nach vorne</button>
      <button class="btn small" data-action="back">Nach hinten</button>
      <button class="btn small" data-action="duplicate-tile">Duplizieren</button>
      <button class="btn small danger" data-action="delete-tile">Löschen</button>
    </div>
  `
}

function onInspectorField(e) {
  const el = e.target
  // Textfelder live übernehmen, alles andere erst bei "change"
  const live = el.type === 'text' || el.type === 'color' || el.type === 'range'
  if ((e.type === 'input') !== live) return
  const layout = currentLayout()
  if (!layout) return

  if (el.dataset.pr) {
    const tile = layout.tiles.find((t) => t.id === selectedTileId)
    if (!tile) return
    const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value
    tile.preacher = { ...preacherOptions(tile.preacher), [el.dataset.pr]: value }
    const out = el.closest('label').querySelector('output')
    if (out) out.textContent = `${Math.round(value * 100)} %`
    renderCanvas()
    changed()
    return
  }

  if (el.dataset.pl) {
    const tile = layout.tiles.find((t) => t.id === selectedTileId)
    if (!tile) return
    const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value
    tile.playlist = { ...playlistOptions(tile.playlist), [el.dataset.pl]: value }
    const out = el.closest('label').querySelector('output')
    if (out) out.textContent = `${Math.round(value * 100)} %`
    renderCanvas()
    changed()
    return
  }

  if (el.dataset.p) {
    const tile = layout.tiles.find((t) => t.id === selectedTileId)
    if (!tile) return
    tile.pp = { ...ppOptions(tile.pp), [el.dataset.p]: el.type === 'checkbox' ? el.checked : el.value }
    if (el.dataset.p === 'showControls') renderInspector()
    renderCanvas()
    changed()
    return
  }

  if (el.dataset.b || el.dataset.ch) {
    const tile = layout.tiles.find((t) => t.id === selectedTileId)
    if (!tile) return
    if (el.dataset.b) {
      const key = el.dataset.b
      const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value
      tile.bank = { ...bankOptions(tile.bank), [key]: value }
      if (key === 'fill') renderInspector()
      const out = el.closest('label').querySelector('output')
      if (out) out.textContent = `${Math.round(value * 100)} %`
    } else {
      tile.channels = tileChannels(tile).map((c) => ({ ...c }))
      const channel = tile.channels[Number(el.closest('.channel-row').dataset.index)]
      if (el.dataset.ch === 'input') {
        channel.input = el.value === 'master' ? 'master' : Number(el.value)
        el.closest('.channel-row').querySelector('[data-ch="label"]').placeholder = audioInputName(channel.input, atem)
      } else {
        channel.label = el.value
      }
    }
    renderCanvas()
    changed()
    return
  }

  if (el.dataset.m) {
    const tile = layout.tiles.find((t) => t.id === selectedTileId)
    if (!tile) return
    const key = el.dataset.m
    const value = el.type === 'checkbox' ? el.checked : el.type === 'range' ? Number(el.value) : el.value
    tile.meter = { ...meterOptions(tile.meter), [key]: value }
    const out = el.closest('label').querySelector('output')
    if (out) out.textContent = key === 'size' ? `${Math.round(value * 100)} %` : `${value} %`
    renderCanvas()
    changed()
    return
  }

  if (el.dataset.l) {
    const key = el.dataset.l
    if (key === 'cols' || key === 'rows') {
      resizeGrid(layout, key, clamp(parseInt(el.value, 10) || 1, 1, 48))
      renderInspector()
    } else if (key === 'gap') {
      layout.gap = clamp(parseInt(el.value, 10) || 0, 0, 40)
    } else {
      layout[key] = el.value
    }
    renderLayoutList()
    renderCanvas()
    renderOutputs()
    renderCompanion()
    changed()
    return
  }

  const tile = layout.tiles.find((t) => t.id === selectedTileId)
  if (!tile || !el.dataset.t) return
  const key = el.dataset.t
  if (key === 'showLabel' || key === 'showTally' || key === 'showMeter' || key === 'ctResponsible' || key === 'ctNotes')
    tile[key] = el.checked
  else if (key === 'ctDateMode') {
    // Festes Datum beginnt mit heute und lässt sich dann im Kalender ändern
    tile.ctDate = el.value === 'fixed' ? tile.ctDate || localDay() : ''
    renderInspector()
  } else if (key === 'ctDate') {
    if (!el.value) return // leeres Datumsfeld: alten Tag behalten
    tile.ctDate = el.value
  }
  else if (key === 'fit') tile.fit = el.checked ? 'cover' : 'contain'
  else if (key === 'sourceId') tile.sourceId = el.value || null
  else if (key === 'audioInput') tile.audioInput = el.value === 'master' ? 'master' : Number(el.value)
  else if (['x', 'y', 'w', 'h'].includes(key)) {
    const v = parseInt(el.value, 10) || 0
    if (key === 'x') tile.x = clamp(v, 0, layout.cols - tile.w)
    if (key === 'y') tile.y = clamp(v, 0, layout.rows - tile.h)
    if (key === 'w') tile.w = clamp(v, 1, layout.cols - tile.x)
    if (key === 'h') tile.h = clamp(v, 1, layout.rows - tile.y)
    el.value = tile[key]
  } else tile[key] = el.value

  if (key === 'showMeter') renderInspector()
  if (key === 'kind') {
    delete tile.meter // Video- und Audiokacheln haben unterschiedliche Lagen
    if (tile.kind === 'source' && !tile.sourceId) tile.sourceId = nextFreeSource()?.id ?? null
    if (tile.kind === 'audio' && !Array.isArray(tile.channels)) tile.channels = [{ input: 'master', label: '' }]
    renderInspector()
  }
  renderCanvas()
  syncStreams()
  changed()
}
inspector.addEventListener('input', onInspectorField)
inspector.addEventListener('change', onInspectorField)

/** Rasteränderung: Kacheln proportional umrechnen, damit das Layout erhalten bleibt. */
function resizeGrid(layout, key, value) {
  const old = layout[key]
  if (old === value) return
  const [pos, size] = key === 'cols' ? ['x', 'w'] : ['y', 'h']
  for (const t of layout.tiles) {
    const start = Math.round((t[pos] * value) / old)
    const end = Math.round(((t[pos] + t[size]) * value) / old)
    t[pos] = clamp(start, 0, value - 1)
    t[size] = clamp(end - start, 1, value - t[pos])
  }
  layout[key] = value
}

inspector.addEventListener('click', (e) => {
  const btn = e.target.closest('button')
  if (!btn) return
  const layout = currentLayout()
  const tile = layout?.tiles.find((t) => t.id === selectedTileId)

  if (btn.dataset.preset) {
    if (layout.tiles.length && !confirm('Vorhandene Kacheln durch die Vorlage ersetzen?')) return
    layout.cols = 12
    layout.rows = 12
    layout.tiles = PRESETS[btn.dataset.preset].map((r, i) => ({ ...newTile(r), sourceId: config.sources[i]?.id ?? null }))
    renderCanvas()
    renderInspector()
    syncStreams()
    changed(0)
    return
  }

  switch (btn.dataset.action) {
    case 'deselect':
      selectTile(null)
      break
    case 'duplicate-layout': {
      const copy = structuredClone(layout)
      copy.id = uid('l')
      copy.name = `${layout.name} (Kopie)`
      copy.tiles.forEach((t) => (t.id = uid('t')))
      config.layouts.push(copy)
      layoutId = copy.id
      renderAll()
      changed(0)
      break
    }
    case 'delete-layout': {
      const users = config.outputs.filter((o) => o.layoutId === layout.id)
      const warn = users.length ? `\nEs wird gerade von ${users.map((o) => o.name).join(', ')} benutzt.` : ''
      if (!confirm(`Layout „${layout.name}“ löschen?${warn}`)) return
      config.layouts = config.layouts.filter((l) => l !== layout)
      users.forEach((o) => (o.layoutId = config.layouts[0]?.id ?? null))
      renderAll()
      changed(0)
      break
    }
    case 'front':
    case 'back': {
      layout.tiles = layout.tiles.filter((t) => t !== tile)
      if (btn.dataset.action === 'front') layout.tiles.push(tile)
      else layout.tiles.unshift(tile)
      renderCanvas()
      changed(0)
      break
    }
    case 'duplicate-tile': {
      const copy = { ...tile, id: uid('t') }
      copy.x = clamp(tile.x + 1, 0, layout.cols - copy.w)
      copy.y = clamp(tile.y + 1, 0, layout.rows - copy.h)
      layout.tiles.push(copy)
      selectedTileId = copy.id
      renderCanvas()
      renderInspector()
      changed(0)
      break
    }
    case 'channel-add':
    case 'channel-add-active':
    case 'channel-up':
    case 'channel-down':
    case 'channel-remove': {
      const channels = tileChannels(tile).map((c) => ({ ...c }))
      const i = Number(btn.closest('.channel-row')?.dataset.index)
      if (btn.dataset.action === 'channel-add') {
        // nächster Eingang, der noch nicht im Fenster ist
        const used = new Set(channels.map((c) => String(c.input)))
        const next = ['master', ...(atem.audioInputs ?? [])].find((id) => !used.has(String(id)))
        channels.push({ input: next ?? 'master', label: '' })
      } else if (btn.dataset.action === 'channel-add-active') {
        const used = new Set(channels.map((c) => String(c.input)))
        const active = Object.entries(lastLevels.inputs ?? {})
          .filter(([id, [l, r]]) => Math.max(l, r) > -60 && !used.has(id))
          .map(([id]) => Number(id))
        for (const id of active) channels.push({ input: id, label: '' })
        toast(active.length ? `${active.length} Pegel mit Ton hinzugefügt.` : 'Gerade liegt an keinem weiteren Eingang Ton an (über −60 dB).')
      } else if (btn.dataset.action === 'channel-remove') {
        channels.splice(i, 1)
      } else {
        const j = btn.dataset.action === 'channel-up' ? i - 1 : i + 1
        ;[channels[i], channels[j]] = [channels[j], channels[i]]
      }
      tile.channels = channels
      delete tile.audioInput
      renderCanvas()
      renderInspector()
      changed(0)
      break
    }
    case 'meter-all': {
      const targets = layout.tiles.filter((t) => (t.kind ?? 'source') === 'source' && t !== tile)
      for (const t of targets) t.meter = { ...tile.meter }
      renderCanvas()
      changed(0)
      toast(`Pegel-Einstellung auf ${targets.length} weitere Kachel(n) übertragen.`)
      break
    }
    case 'delete-tile':
      deleteTile(tile)
      break
  }
})

// ---------------------------------------------------------------------------
// Einstellungen: ATEM und Companion
// ---------------------------------------------------------------------------

function renderAtem() {
  if (!config) return
  const ip = $('#atem-ip')
  if (document.activeElement !== ip) ip.value = config.atem.ip
  $('#atem-me').value = String(config.atem.me ?? 0)
  $('#atem-status').innerHTML = !config.atem.ip
    ? '<span class="muted">Keine IP eingetragen – Tally ist aus.</span>'
    : atem.connected
      ? `<span style="color:var(--green)">●</span> Verbunden mit <b>${esc(atem.model || 'ATEM')}</b> (${esc(config.atem.ip)})`
      : `<span style="color:var(--red)">●</span> Nicht verbunden – versuche ${esc(config.atem.ip)} …`

  const entries = Object.entries(atem.inputs || {}).sort((a, b) => Number(a[0]) - Number(b[0]))
  $('#atem-inputs-rows').innerHTML =
    entries
      .map(([id, i]) => {
        const n = Number(id)
        const tally = atem.program?.includes(n) ? 'program' : atem.preview?.includes(n) ? 'preview' : ''
        return `<tr><td>${esc(id)}</td><td>${esc(i.shortName)}</td><td>${esc(i.longName)}</td><td><span class="tally-dot ${tally}"></span></td></tr>`
      })
      .join('') || `<tr><td colspan="4" class="muted">Keine Daten – ATEM nicht verbunden.</td></tr>`
}

$('#atem-ip').addEventListener('change', (e) => {
  config.atem.ip = e.target.value.trim()
  renderAtem()
  renderAtemPill()
  changed(0)
})

$('#atem-me').addEventListener('change', (e) => {
  config.atem.me = Number(e.target.value)
  changed(0)
})

function renderChat() {
  const settings = config.chat || {}
  for (const key of ['url', 'username', 'roleId']) {
    const input = $(`#chat-${key}`)
    if (document.activeElement !== input) input.value = settings[key] ?? ''
  }
  renderChatStatus()
}

function renderProPresenter() {
  if (!config) return
  $('#pp-preacher-url').textContent = `${location.origin}/prediger.html`
  const host = $('#pp-host')
  const port = $('#pp-port')
  if (document.activeElement !== host) host.value = config.propresenter?.host ?? ''
  if (document.activeElement !== port) port.value = config.propresenter?.port ?? 1025
  const p = propresenter
  $('#pp-status').innerHTML = !config.propresenter?.host
    ? '<span class="muted">Keine Adresse eingetragen.</span>'
    : p.connected
      ? `<span style="color:var(--green)">●</span> Verbunden mit <b>${esc(p.version || 'ProPresenter')}</b>` +
        (p.presentation ? ` · läuft: <b>${esc(p.presentation.name)}</b>, Folie ${p.index + 1}` : ' · keine Präsentation aktiv')
      : `<span style="color:var(--red)">●</span> Nicht erreichbar – ist in ProPresenter unter Einstellungen → Netzwerk „Netzwerk aktivieren“ an?`
}

/** Heutiges Datum als YYYY-MM-DD in der Zeitzone der Veranstaltungen. */
function localDay() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: churchtools.timeZone || 'Europe/Berlin' }).format(new Date())
}

// ---------------------------------------------------------------------------
// Einstellungen: ChurchTools
// ---------------------------------------------------------------------------

function renderChurchTools() {
  const ct = churchtools
  const url = $('#ct-url')
  if (document.activeElement !== url && !url.dataset.edited) url.value = ct.url || ''
  $('#ct-status').innerHTML =
    ct.state === 'unconfigured'
      ? '<span class="muted">Nicht verbunden.</span>'
      : ct.state === 'connected'
        ? `<span style="color:var(--green)">●</span> Verbunden mit <b>${esc(ct.url)}</b> als <b>${esc(ct.user)}</b>`
        : ct.state === 'connecting'
          ? `<span class="muted">Verbinde mit ${esc(ct.url)} …</span>`
          : `<span style="color:var(--red)">●</span> ${esc(ct.error || 'Fehler')}`
  $('#ct-disconnect').hidden = ct.state === 'unconfigured'
  $('#ct-refresh').hidden = ct.state === 'unconfigured'
  const time = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: ct.timeZone })
  const dayLabel = (day) =>
    day === ct.date ? 'Heute' : new Date(`${day}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' })
  const rows = Object.entries(ct.days || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([day, events]) =>
      events.length
        ? events.map(
            (e) =>
              `<tr><td>${esc(dayLabel(day))}, ${esc(time(e.startDate))}</td><td>${esc(e.name)}</td><td>${esc(e.calendar)}</td><td>${
                e.agenda ? `${e.agenda.items.filter((i) => i.type !== 'header').length} Punkte` : esc(e.agendaError)
              }</td></tr>`,
          )
        : [`<tr><td>${esc(dayLabel(day))}</td><td colspan="3" class="muted">keine Events</td></tr>`],
    )
  $('#ct-events').innerHTML =
    ct.state === 'unconfigured'
      ? ''
      : `<div class="table-wrap"><table class="table">
          <thead><tr><th>Wann</th><th>Event</th><th>Kalender</th><th>Ablauf</th></tr></thead>
          <tbody>${rows.join('') || '<tr><td colspan="4" class="muted">Noch keine Daten.</td></tr>'}</tbody></table></div>`
}

$('#ct-url').addEventListener('input', (e) => (e.target.dataset.edited = '1'))

$('#ct-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const body = {
    url: $('#ct-url').value.trim(),
    username: $('#ct-username').value.trim(),
    password: $('#ct-password').value,
    token: $('#ct-token').value.trim(),
  }
  const button = $('#ct-connect')
  button.disabled = true
  button.textContent = 'Verbinde …'
  try {
    const res = await fetch('/api/churchtools/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const result = await res.json()
    if (!result.ok) throw new Error(result.error)
    toast(`ChurchTools verbunden als ${result.user}`)
    // Zugangsdaten nicht im Formular stehen lassen
    $('#ct-password').value = ''
    $('#ct-token').value = ''
    delete $('#ct-url').dataset.edited
  } catch (err) {
    toast(`ChurchTools: ${err.message}`)
  } finally {
    button.disabled = false
    button.textContent = 'Verbinden'
  }
})

$('#ct-disconnect').addEventListener('click', async () => {
  if (!confirm('ChurchTools-Verbindung trennen? Der gespeicherte Login-Token wird gelöscht.')) return
  await fetch('/api/churchtools/disconnect', { method: 'POST' })
})

$('#ct-refresh').addEventListener('click', async () => {
  await fetch('/api/churchtools/refresh', { method: 'POST' })
  toast('ChurchTools aktualisiert')
})

function renderChatStatus() {
  $('#chat-status').innerHTML =
    chat.state === 'connected'
      ? `<span style="color:var(--green)">●</span> Verbunden mit Kesher als <b>${esc(chat.stationName || config?.chat?.roleId || '')}</b>`
      : `<span style="color:var(--red)">●</span> Nicht verbunden${chat.error ? ` – ${esc(chat.error)}` : ' – versuche …'}`
}

for (const key of ['url', 'username', 'roleId']) {
  $(`#chat-${key}`).addEventListener('change', (e) => {
    const value = e.target.value.trim()
    if (!value) return renderChat() // leer lassen geht nicht, der alte Wert bleibt
    config.chat = { ...config.chat, [key]: key === 'url' ? value.replace(/\/+$/, '') : value }
    changed(0)
  })
}

for (const id of ['#pp-host', '#pp-port']) {
  $(id).addEventListener('change', () => {
    config.propresenter = { host: $('#pp-host').value.trim(), port: Number($('#pp-port').value) || 1025 }
    renderProPresenter()
    changed(0)
  })
}

function renderCompanion() {
  // Companion läuft auf demselben Server: dort direkt und ohne Zertifikat über 127.0.0.1
  const base = location.protocol === 'https:' ? `http://127.0.0.1:${location.port || 8090}` : location.origin
  const lines = [
    ...config.outputs.flatMap((o, oi) =>
      config.layouts.map((l, li) => [`${o.name} → ${l.name}`, `${base}/api/output/${oi + 1}/layout/${li + 1}`]),
    ),
    ...config.outputs.map((o, oi) => [`${o.name}: nächstes Layout`, `${base}/api/output/${oi + 1}/next`]),
    ...config.outputs.map((o, oi) => [`${o.name}: vorheriges Layout`, `${base}/api/output/${oi + 1}/prev`]),
    ...screenRows().flatMap((row) => {
      const url = `${base}/api/screen/${encodeURIComponent(row.id)}/output`
      return [
        ...config.outputs.map((o, oi) => [`Bildschirm ${screenName(row)} → ${o.name}`, `${url}/${oi + 1}`]),
        [`Bildschirm ${screenName(row)} aus`, `${url}/aus`],
      ]
    }),
    ['Kachel 1 in Layout 1 auf Quelle 2', `${base}/api/layout/1/tile/1/source/2`],
    ['Status abfragen (JSON)', `${base}/api/state`],
  ]
  $('#companion-help').innerHTML = `<div class="table-wrap"><table class="table companion-table">${lines
    .map(([label, url]) => `<tr><td>${esc(label)}</td><td><code>${esc(url)}</code></td></tr>`)
    .join('')}</table></div>`
}

showPage()
