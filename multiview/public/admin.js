import { connect, watchLogin, loginKey, uid, sourceLabel, hasAtemInput, audioInputName, channelName, meterKeyFor, tileChannels, tallyOf, applyBox, LINE_COLOR, LINE_WIDTH, applyLayoutBorder } from './common.js'
import { createMeter, createMeterBank, setLevels, meterOptions, bankOptions } from './meters.js'
import { createChatView, chatOptions } from './chat.js'
import { createAgendaView } from './agenda.js'
import {
  createProPresenterView, createPlaylistView, createPreacherView, ppOptions, playlistOptions, preacherOptions,
} from './propresenter.js'
import { createStageView, stageOptions, fmtTimer } from './stage.js'
import { adoptServerPrefs, appearanceHtml, bindAppearance, currentPrefs, nextTheme, setPrefs, themeIcon, THEMES, onPrefsChange } from './theme.js'
import { avatarHtml, pickAvatar, removeAvatar } from './avatar.js'
import { roleRights, visibleOutputs, visibleLayouts, canEditLayout, canEditOutput, claimLayouts, publicOrigin, chatFor, chatRoleFor } from './rights.js'
import {
  attachDevice, attachNetworkStream, makeVideo, makeTestPattern, mediaKey,
  listVideoDevices, permissionGranted, releaseUnusedStreams, mediaAvailable,
} from './media.js'

const $ = (sel, root = document) => root.querySelector(sel)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const clamp = (v, min, max) => Math.min(Math.max(v, min), max)

const CLIENT_ID = uid('c')
const PAGES = ['uebersicht', 'eingaenge', 'layouts', 'einstellungen', 'zugang']
const ADMIN_PAGES = ['eingaenge', 'einstellungen', 'zugang']
// Unterseiten der Einstellungen: #/einstellungen/atem …
const SETTINGS_SECTIONS = ['atem', 'propresenter', 'kesher', 'churchtools', 'companion', 'bildschirme', 'geraete']
// Unterseiten von Benutzer & Rechte: #/zugang/rollen …
const ZUGANG_SECTIONS = ['rollen', 'anmeldung', 'dienste']
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
let ppStage = { connected: false, message: '', timers: [], videoCountdown: '', messages: [] }
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
let templates = [] // gespeicherte Layouts { id, name, savedAt, owner, tiles, own }

// Wer ist angemeldet? Wird in start() geladen, bevor die Verbindung zum Server aufgeht.
let me = null
let user = null // { name, roleId, roleName, admin, open }

function onMessage(msg) {
  if (msg.type === 'config') {
    // Eigene Änderungen kommen als Echo zurück – die haben wir schon.
    if (msg.origin === CLIENT_ID || saveTimer || dragging) return
    config = msg.config
    renderAll()
  } else if (msg.type === 'atem') {
    atem = msg
    renderAtemPill()
    renderStatusStrip()
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
    renderStatusStrip()
    for (const view of agendaViews) {
      if (view.el.isConnected) view.update(churchtools)
      else agendaViews.delete(view)
    }
  } else if (msg.type === 'chat') {
    chat = msg
    renderChatStatus()
    renderStatusStrip()
    renderAccess()
    for (const view of chatViews) {
      if (view.el.isConnected) view.update(chatFor(chat, view.roleId?.() ?? ''))
      else chatViews.delete(view)
    }
  } else if (msg.type === 'propresenter') {
    propresenter = msg
    for (const el of canvas.querySelectorAll('.etile')) el.ppView?.update(propresenter)
    renderProPresenter()
    renderStatusStrip()
  } else if (msg.type === 'ppstage') {
    const timersChanged = JSON.stringify(ppStage.timers.map((t) => t.uuid)) !== JSON.stringify(msg.timers.map((t) => t.uuid))
    ppStage = msg
    for (const el of canvas.querySelectorAll('.etile')) el.ppView?.updateStage?.(ppStage)
    // Timer-Auswahl der Bühnen-Kachel nachziehen, wenn ProPresenter andere Timer meldet
    if (timersChanged && inspector.querySelector('[data-st-timer]')) renderInspector()
  } else if (msg.type === 'templates_changed') {
    loadTemplates()
  } else if (msg.type === 'session_revoked') {
    // Rolle wurde auf einem anderen Gerät übernommen oder vom Admin beendet
    location.replace(`/login.html?abgemeldet=1&next=${encodeURIComponent(location.pathname + location.hash)}`)
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
    if (res.status === 401) return goToLogin()
    if (!res.ok) throw new Error(res.status === 403 ? 'keine Berechtigung' : `HTTP ${res.status}`)
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
  const [requested, sub] = location.hash.replace(/^#\/?/, '').split('/')
  page = PAGES.includes(requested) && (isAdmin() || !ADMIN_PAGES.includes(requested)) ? requested : 'uebersicht'
  for (const p of PAGES) $(`#page-${p}`).hidden = p !== page
  const sectionsOf = { einstellungen: SETTINGS_SECTIONS, zugang: ZUGANG_SECTIONS }[page]
  if (sectionsOf) {
    const section = sectionsOf.includes(sub) ? sub : sectionsOf[0]
    document.querySelectorAll(`#page-${page} [data-section]`).forEach((el) => (el.hidden = el.dataset.section !== section))
    document.querySelectorAll(`#page-${page} [data-section-link]`).forEach((a) => {
      a.classList.toggle('active', a.dataset.sectionLink === section)
      if (a.dataset.sectionLink === section) a.setAttribute('aria-current', 'page')
      else a.removeAttribute('aria-current')
    })
  }
  document.querySelectorAll('.site-nav a').forEach((a) => a.classList.toggle('active', a.dataset.page === page))
  document.body.classList.remove('nav-open')
  if (page === 'eingaenge') autoScanDevices()
  if (page === 'einstellungen' && sub === 'geraete') loadSessions()
  if (page === 'zugang') loadGateway()
  renderAll()
  window.scrollTo(0, 0)
}
window.addEventListener('hashchange', showPage)

function renderAll() {
  if (!config) return
  config.access ??= { roles: {} }
  const layouts = myLayouts()
  if (!layouts.some((l) => l.id === layoutId)) layoutId = layouts[0]?.id ?? null
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
  renderStatusStrip()
  renderAccess()
  applyRoleUi()
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
    ...myLayouts().map((l) => `<option value="${esc(l.id)}" ${l.id === selected ? 'selected' : ''}>${esc(l.name)}</option>`),
  ].join('')
}

const scalePreview = (el) => el.style.setProperty('--preview-scale', String(el.clientWidth / 1920))
const previewScaler =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => entries.forEach((entry) => scalePreview(entry.target)))
    : { observe: (el) => requestAnimationFrame(() => scalePreview(el)) }

function renderOutputs() {
  const grid = $('#output-cards')
  // Vorschauen (iframes) nur laden, solange die Übersicht offen ist
  if (page !== 'uebersicht') {
    if (outputsKey) grid.replaceChildren()
    outputsKey = ''
    return
  }
  const outputs = myOutputs()
  const key = outputs.map((o) => o.id).join('|')
  if (key !== outputsKey) {
    outputsKey = key
    grid.innerHTML =
      outputs
        .map(
          (o) => `<article class="card output-card" data-id="${esc(o.id)}">
          <div class="output-preview">
            <iframe src="${esc(outputUrl(o, true))}" allow="camera; fullscreen; autoplay" title="${esc(o.name)}"></iframe>
          </div>
          <div class="output-body">
            <div class="output-title">
              <input type="text" class="name-input" data-o="name" aria-label="Name" ${isAdmin() ? '' : 'readonly'}>
              <select data-o="layoutId" aria-label="Layout"></select>
            </div>
            <div class="output-foot">
              <div class="btn-row">
                <button class="btn primary" data-action="fullscreen">⛶ Vollbild</button>
                <a class="btn" href="${esc(outputUrl(o))}" target="_blank" rel="noopener">Monitor-Ansicht ↗</a>
              </div>
              ${isAdmin() ? '<button class="btn small danger" data-action="delete-output">Entfernen</button>' : ''}
            </div>
          </div>
        </article>`,
        )
        .join('') ||
      (isAdmin()
        ? `<div class="empty-state">Noch kein Multiview. Lege mit <b>+ Multiview</b> einen an.</div>`
        : `<div class="empty-state">Für deine Rolle ist noch kein Multiview freigegeben. Der Admin legt das unter <b>Benutzer &amp; Rechte</b> fest.</div>`)
  }
  // Felder aktualisieren, ohne die Vorschauen neu zu laden
  // Vorschau in Monitorgröße rendern und verkleinern (sonst wirkt alles zu groß)
  for (const preview of grid.querySelectorAll('.output-preview')) previewScaler.observe(preview)
  for (const card of grid.querySelectorAll('.output-card')) {
    const output = config.outputs.find((o) => o.id === card.dataset.id)
    const name = card.querySelector('[data-o="name"]')
    if (document.activeElement !== name) name.value = output.name
    const select = card.querySelector('[data-o="layoutId"]')
    const editable = canEditOutput(config, user, output.id)
    // Nur ansehen: das laufende Layout anzeigen, nicht umschaltbar
    select.innerHTML = editable
      ? layoutOptions(output.layoutId)
      : `<option>${esc(config.layouts.find((l) => l.id === output.layoutId)?.name ?? '– kein Layout –')} · nur ansehen</option>`
    select.disabled = !editable
    card.querySelector('iframe').title = output.name
  }
}

function onOutputField(e) {
  const el = e.target
  const key = el.dataset.o
  if (!key) return
  if ((e.type === 'input') !== (el.type === 'text')) return
  const output = config.outputs.find((o) => o.id === el.closest('.output-card').dataset.id)
  if (key === 'layoutId') claimLayouts(config, user)
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
// Einstellungen: Bildschirme am Server (welcher Multiview auf welchem Anschluss)
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
  $('#layout-list').innerHTML =
    myLayouts()
      .map((l) => {
        const usedBy = config.outputs.filter((o) => o.layoutId === l.id).length
        const nr = config.layouts.indexOf(l) + 1
        const tag = !canEditLayout(config, user, l) ? '🔒' : l.owner && isAdmin() ? esc(roleLabel(l.owner)) : l.shared ? 'für alle' : ''
        return `<li data-id="${esc(l.id)}" class="${l.id === layoutId ? 'active' : ''}" title="${usedBy ? `auf ${usedBy} Multiview(s) aktiv` : ''}">
        <span>${nr}. ${esc(l.name)}</span>
        <span class="meta">${tag}${usedBy ? '<i class="live-dot"></i>' : ''}</span>
      </li>`
      })
      .join('') || '<li class="muted" style="cursor:default">Noch keine Layouts</li>'
}

$('#layout-list').addEventListener('click', (e) => {
  const li = e.target.closest('li')
  if (!li?.dataset.id) return
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
    // Layouts einer Rolle gehören ihr – andere Rollen sehen sie nicht
    ...(isAdmin() ? {} : { owner: user.roleId }),
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

function mayEditLayouts() {
  const rights = roleRights(config, user)
  return Boolean(rights?.admin || rights?.editLayouts)
}

async function loadTemplates() {
  try {
    const res = await fetch('/api/templates', { cache: 'no-store' })
    if (!res.ok) return
    templates = await res.json()
    renderTemplates()
  } catch {
    // Server gerade nicht erreichbar – beim nächsten Verbinden wieder
  }
}

function formatSavedAt(iso) {
  const d = iso && new Date(iso)
  if (!d || isNaN(d)) return ''
  return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function renderTemplates() {
  $('#template-list').innerHTML = templates.length
    ? templates
        .map((t) => {
          const owner = isAdmin() && t.owner ? ` · ${esc(roleLabel(t.owner))}` : !t.owner && !isAdmin() ? ' · vom Admin' : ''
          return `<li data-id="${esc(t.id)}">
            <span class="name">${esc(t.name)}</span>
            <span class="meta">${t.tiles} Kachel(n)${t.savedAt ? ` · ${esc(formatSavedAt(t.savedAt))}` : ''}${owner}</span>
            <div class="btn-row">
              <button class="btn small primary" data-action="load" title="In das gewählte Layout laden">Laden</button>
              <a class="btn small" href="/api/templates/${encodeURIComponent(t.id)}?download" download title="Als Datei herunterladen">↓</a>
              ${t.own ? '<button class="btn small danger" data-action="delete" title="Vorlage löschen">✕</button>' : ''}
            </div>
          </li>`
        })
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

  // Ins gewählte Layout laden – ist das gesperrt, entsteht ein neues eigenes Layout
  let layout = currentLayout()
  if (layout && !canEditLayout(config, user, layout)) layout = null
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
    layout = { id: uid('l'), name: template.name, tiles: [], ...(isAdmin() ? {} : { owner: user.roleId }) }
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
// Die Arbeitsfläche ist intern so groß wie ein Monitor (1920×1080) und wird verkleinert –
// so sehen Schriften, Abstände und Rahmen genau so aus wie später auf dem Monitor.
const CANVAS_WIDTH = 1920
const canvasFrame = document.getElementById('canvas-frame')
function scaleCanvas() {
  const scale = canvasFrame.clientWidth / CANVAS_WIDTH
  if (scale > 0) canvasFrame.style.setProperty('--canvas-scale', String(scale))
}
if (typeof ResizeObserver === 'function') new ResizeObserver(scaleCanvas).observe(canvasFrame)
else window.addEventListener('resize', scaleCanvas)


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
  scaleCanvas()
  canvas.style.setProperty('--cols', layout.cols)
  canvas.style.setProperty('--rows', layout.rows)
  // Wie auf dem Monitor: Abstand und Hintergrund des Layouts
  canvas.style.setProperty('--gap', `${Number(layout.gap ?? 4) || 0}px`)
  canvas.style.setProperty('--bg', layout.background || '#000')
  applyLayoutBorder(canvas, layout)
  canvas.style.backgroundColor = layout.background || '#000'
  const readonly = !canEditLayout(config, user, layout)
  canvas.classList.toggle('readonly', readonly)
  const note = $('#readonly-note')
  note.hidden = !readonly
  if (readonly) note.textContent = 'Nur ansehen: Dieses Layout gehört nicht zu deiner Rolle. Mit „+ Neu“ legst du ein eigenes an.'

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
          : tile.kind === 'stage'
            ? JSON.stringify(['stage', stageOptions(tile.stage)])
            : ''
  if (el.dataset.ppKey === signature) return
  el.dataset.ppKey = signature
  el.querySelector('.pp-view, .pl-view, .pr-view, .st-view')?.remove()
  el.ppView = null
  el.classList.toggle('covered', Boolean(signature))
  if (!signature) return
  // Im Editor nur Vorschau: Tasten und Folien lösen hier nichts aus
  el.ppView =
    tile.kind === 'playlist'
      ? createPlaylistView(tile.playlist)
      : tile.kind === 'preacher'
        ? createPreacherView(tile.preacher)
        : tile.kind === 'stage'
          ? createStageView(tile.stage)
          : createProPresenterView(tile.pp)
  el.ppView.update(propresenter)
  el.ppView.updateStage?.(ppStage)
  el.append(el.ppView.el)
}

function syncTileMedia(el, tile) {
  const source = tile.kind === 'source' ? config.sources.find((s) => s.id === tile.sourceId) : null
  // Der Chat ist immer live zu sehen, so wie auf den Monitoren
  const key =
    tile.kind === 'chat'
      ? JSON.stringify(['chat', tile.chatRole ?? '', chatOptions(tile.chat)])
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
    const view = createChatView(tile.chat)
    view.roleId = () => chatRoleFor(tile, user)
    view.update(chatFor(chat, view.roleId()))
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
  if (tile.kind === 'kesher') {
    const role =
      tile.kesherRoleId === '@user'
        ? 'angemeldeter Nutzer'
        : tile.kesherRoleId
          ? chat.roles?.find((r) => r.id === tile.kesherRoleId)?.name || tile.kesherRoleId
          : 'ohne Rolle'
    return { title: 'Kesher-Intercom', sub: `${role} · nur auf dem Monitor bedienbar` }
  }
  if (tile.kind === 'churchtools') {
    const day = tile.ctDate ? new Date(`${tile.ctDate}T12:00:00Z`).toLocaleDateString('de-DE', { timeZone: 'UTC' }) : 'heute'
    return { title: 'ChurchTools-Ablauf', sub: [day, tile.ctFilter].filter(Boolean).join(' · ') }
  }
  if (tile.kind === 'propresenter') return { title: 'ProPresenter', sub: 'Folien' }
  if (tile.kind === 'playlist') return { title: 'Playlist', sub: 'ProPresenter' }
  if (tile.kind === 'preacher') return { title: 'Prediger', sub: 'ProPresenter-Steuerung' }
  if (tile.kind === 'stage') return { title: 'ProPresenter-Bühne', sub: 'Songtext · Countdown · Nachricht' }
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
  if (!layout || e.button !== 0 || !canEditLayout(config, user, layout)) return
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
  if (!canEditLayout(config, user, layout)) return
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
  if (!canEditLayout(config, user, layout)) {
    const usedBy = config.outputs.filter((o) => o.layoutId === layout.id).map((o) => o.name)
    inspector.innerHTML = `<h3>${esc(layout.name)}</h3>
      <p class="muted">${layout.tiles.length} Kachel(n)${usedBy.length ? ` · läuft auf ${esc(usedBy.join(', '))}` : ''}.</p>
      <p class="muted">Dieses Layout kannst du auf deine Multiviews schalten, aber nicht verändern.</p>
      ${roleRights(config, user)?.editLayouts ? '<button class="btn" data-action="duplicate-layout">Als eigenes Layout kopieren</button>' : ''}`
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
    <div class="row">
      <label class="field"><span>Trennlinien (ATEM)</span><select data-l="lines">
        <option value="on" ${layout.lines !== false ? 'selected' : ''}>An</option>
        <option value="off" ${layout.lines === false ? 'selected' : ''}>Aus</option>
      </select></label>
      <label class="field"><span>Linienfarbe</span><input type="color" data-l="lineColor" value="${esc(layout.lineColor || LINE_COLOR)}" ${layout.lines === false ? 'disabled' : ''}></label>
    </div>
    ${layout.lines !== false ? `<label class="field"><span>Linienstärke (px) – ersetzt den Abstand</span><input type="number" min="1" max="16" data-l="lineWidth" value="${layout.lineWidth ?? LINE_WIDTH}"></label>` : ''}
    ${isAdmin() ? layoutAccessFields(layout) : ''}
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
      ${propresenter.connected ? '' : '<p class="muted" style="margin:0;font-size:12px">ProPresenter ist nicht verbunden – Adresse unter <a href="#/einstellungen/propresenter">Einstellungen</a> prüfen.</p>'}
    </div>`
}

/** Auswahl, was „Ausblenden“ bei ProPresenter wegnimmt. */
function blankModeField(attr, value) {
  return `<label class="field"><span>„Ausblenden“ blendet aus</span><select ${attr}="blankMode">
    <option value="clearAll" ${value !== 'clear' ? 'selected' : ''}>Alles – ProPresenter blank (Folie und Hintergrund)</option>
    <option value="clear" ${value === 'clear' ? 'selected' : ''}>Nur die Folie (Hintergrund bleibt)</option>
  </select></label>`
}

/** Prediger-Kachel: Größe der Folien, Ausblenden-Art, Tasten. */
/** ProPresenter-Bühne: was das Stage Display zeigt. */
function stageSection(tile) {
  const o = stageOptions(tile.stage)
  const check = (key, label) =>
    `<label class="check"><input type="checkbox" data-st="${key}" ${o[key] ? 'checked' : ''}> ${label}</label>`
  // Timer, die ProPresenter kennt, plus gewählte, die es (gerade) nicht meldet
  const known = ppStage.timers.map((t) => ({ uuid: t.uuid, name: t.name, time: t.time }))
  for (const uuid of o.timers) if (!known.some((t) => t.uuid === uuid)) known.push({ uuid, name: 'Timer (nicht gefunden)', time: '' })
  const timerChecks = known
    .map(
      (t) => `<label class="check"><input type="checkbox" data-st-timer="${esc(t.uuid)}" ${o.timers.includes(t.uuid) ? 'checked' : ''}> ${esc(t.name)}${t.time ? ` <span class="muted">${esc(fmtTimer(t.time))}</span>` : ''}</label>`,
    )
    .join('')
  return `
    <div class="meter-settings">
      <h4>ProPresenter-Bühne</h4>
      <p class="muted" style="margin:0;font-size:12px">Wie ein Stage Display: Songtext, Countdowns und Bühnennachricht. Am Monitor lässt sich die Bühnennachricht senden und löschen, hier im Editor ist alles nur Vorschau.</p>
      ${check('song', 'Liedname und Teil (Strophe, Refrain …)')}
      ${check('current', 'Text der aktuellen Folie')}
      ${check('next', 'Text der nächsten Folie')}
      ${check('notes', 'Folien-Notizen')}
      ${check('message', 'Bühnennachricht')}
      ${check('messages', 'Laufende Meldungen (Publikum)')}
      ${check('videoCountdown', 'Restzeit des laufenden Videos')}
      ${check('clock', 'Uhrzeit')}
      ${check('send', 'Feld zum Senden der Bühnennachricht')}
      <div class="field"><span>Countdowns / Timer (keiner gewählt = alle, die gerade laufen)</span>
        ${timerChecks || '<p class="muted" style="margin:0;font-size:12px">ProPresenter meldet keine Timer.</p>'}
      </div>
      <label class="field"><span>Schriftgröße <output>${Math.round(o.size * 100)} %</output></span>
        <input type="range" min="0.5" max="2.5" step="0.1" data-st="size" value="${o.size}"></label>
      ${propresenter.connected ? '' : '<p class="muted" style="margin:0;font-size:12px">ProPresenter ist nicht verbunden – Adresse unter <a href="#/einstellungen/propresenter">Einstellungen</a> prüfen.</p>'}
    </div>`
}

/** Eintrag in der Quellen-Auswahl: Name · ATEM-Eingang mit seinem Namen · Art – damit klar ist, was dahinter liegt. */
function sourceOptionLabel(s) {
  const name = sourceLabel(s, atem) || s.name || 'Ohne Namen'
  const parts = [name]
  if (hasAtemInput(s)) {
    const input = atem.inputs?.[Number(s.atemInput)]
    const atemName = input?.longName || input?.shortName || ''
    parts.push(`ATEM ${s.atemInput}${atemName && atemName !== name ? `: ${atemName}` : ''}`)
  }
  parts.push(SOURCE_TYPES[s.type] ?? s.type)
  return parts.join(' · ')
}

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
      ${propresenter.connected ? '' : '<p class="muted" style="margin:0;font-size:12px">ProPresenter ist nicht verbunden – Adresse unter <a href="#/einstellungen/propresenter">Einstellungen</a> prüfen.</p>'}
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

/** Kesher-Chat: für welche Rolle (wie in Kesher, nach deren Party Lines). */
function chatSection(tile) {
  const value = tile.chatRole ?? ''
  const roles = kesherRoles()
  return `
      <label class="field"><span>Nachrichten zeigen für</span><select data-t="chatRole">
        <option value="" ${value === '' ? 'selected' : ''}>Angemeldete Rolle (sonst alle)</option>
        <option value="*" ${value === '*' ? 'selected' : ''}>Alle Nachrichten</option>
        ${roles.map((r) => `<option value="${esc(r.id)}" ${r.id === value ? 'selected' : ''}>Rolle ${esc(r.name)}</option>`).join('')}
      </select></label>
      <label class="check"><input type="checkbox" data-t="chatInput" ${tile.chatInput !== false ? 'checked' : ''}> Schreiben, wenn am Bildschirm jemand angemeldet ist</label>
      ${chatLookSection(tile)}
      <p class="muted">Der Chat zeigt, was die Rolle auch in Kesher sieht: globale Nachrichten und die ihrer Party Lines. „Angemeldete Rolle“: Wer angemeldet ist, sieht seinen Chat – Monitore ohne Anmeldung zeigen alles.</p>`
}

/** Chat-Kachel: Schriftgröße und was angezeigt wird. */
function chatLookSection(tile) {
  const o = chatOptions(tile.chat)
  const check = (key, label) =>
    `<label class="check"><input type="checkbox" data-chat="${key}" ${o[key] ? 'checked' : ''}> ${label}</label>`
  return `
    <div class="meter-settings">
      <h4>Darstellung</h4>
      <label class="field"><span>Schriftgröße <output>${Math.round(o.size * 100)} %</output></span>
        <input type="range" min="0.5" max="2.5" step="0.1" data-chat="size" value="${o.size}"></label>
      <label class="field"><span>Nachrichten <output>${o.count}</output></span>
        <input type="range" min="1" max="60" step="1" data-chat="count" value="${o.count}"></label>
      ${check('follow', 'An neuester Nachricht hängen (immer die neueste zeigen)')}
      ${check('newest', 'Neueste Nachricht groß hervorheben')}
      ${check('meta', 'Absender, Ziel und Uhrzeit zeigen')}
      ${check('header', 'Kopfzeile (Logo, Titel, Uhr)')}
      ${check('dimOld', 'Ältere Nachrichten (über 5 Minuten) abdunkeln')}
    </div>`
}

/** Kesher-Intercom: die Kesher-Weboberfläche als bedienbares Fenster auf dem Monitor. */
function kesherSection(tile) {
  const roles = chat.roles || []
  const roleOptions = [
    `<option value="">– selbst anmelden –</option>`,
    `<option value="@user" ${tile.kesherRoleId === '@user' ? 'selected' : ''}>– angemeldeter Nutzer (Name und Rolle) –</option>`,
    ...roles.map((r) => `<option value="${esc(r.id)}" ${r.id === tile.kesherRoleId ? 'selected' : ''}>${esc(r.name)}</option>`),
  ]
  // Gespeicherte Rolle, die Kesher (noch) nicht gemeldet hat, nicht stillschweigend verlieren
  if (tile.kesherRoleId && tile.kesherRoleId !== '@user' && !roles.some((r) => r.id === tile.kesherRoleId))
    roleOptions.push(`<option value="${esc(tile.kesherRoleId)}" selected>${esc(tile.kesherRoleId)}</option>`)
  const view = tile.kesherView || 'station'
  return `
      <label class="field"><span>Rolle (automatisch anmelden)</span><select data-t="kesherRoleId">${roleOptions.join('')}</select></label>
      <label class="field"><span>Name der Station</span><input type="text" data-t="kesherUser" value="${esc(tile.kesherUser ?? 'Multiview')}" placeholder="Multiview"></label>
      <label class="field"><span>Ansicht</span>
        <select data-t="kesherView">
          <option value="station" ${view === 'station' ? 'selected' : ''}>Station (alle Kanäle)</option>
          <option value="simple" ${view === 'simple' ? 'selected' : ''}>Einfach (große Tasten)</option>
          <option value="chat" ${view === 'chat' ? 'selected' : ''}>Nur Chat (ohne Mikrofon)</option>
        </select>
      </label>
      <label class="check"><input type="checkbox" data-t="kesherTakeover" ${tile.kesherTakeover !== false ? 'checked' : ''}> Rolle übernehmen, wenn sie schon angemeldet ist <span class="muted">(nicht bei „angemeldeter Nutzer“ – dessen eigenes Kesher bleibt angemeldet)</span></label>
      <label class="check"><input type="checkbox" data-t="kesherHideControls" ${tile.kesherHideControls ? 'checked' : ''}> Sprechtasten ausblenden (Hold to talk, Reply, Always on)</label>
      <p class="muted">Die Kanäle passen sich immer der Kachelgröße an. Ohne Sprechtasten spricht man über Stream Deck oder Tastatur – oder in Kesher unter Einstellungen „Direct PTT Mode“ einschalten, dann ist jede Kanal-Taste eine Sprechtaste.</p>
      <label class="field"><span>Mikrofon (Name enthält, leer = Standard)</span><input type="text" data-t="kesherAudioIn" value="${esc(tile.kesherAudioIn)}" placeholder="z. B. USB"></label>
      <label class="field"><span>Lautsprecher (Name enthält, leer = Standard)</span><input type="text" data-t="kesherAudioOut" value="${esc(tile.kesherAudioOut)}" placeholder="z. B. HDMI"></label>
      <label class="field"><span>Kesher-Adresse (leer = automatisch)</span><input type="text" data-t="kesherUrl" value="${esc(tile.kesherUrl)}" placeholder="automatisch"></label>
      <p class="muted">Zeigt Kesher direkt auf dem Monitor, mit Sprechtasten, Kanälen und Chat. Bedienen per Maus oder Touch am Monitor. In der Vorschau hier im Editor ist es nur ein Platzhalter, damit die Rolle nicht zweimal angemeldet wird. Für das Mikrofon muss der Monitor die Seite über <code>127.0.0.1</code> oder <code>https</code> öffnen.</p>`
}

function tileInspector(tile, layout) {
  const sourceOptions = [
    `<option value="">– keine –</option>`,
    ...config.sources.map(
      (s) => `<option value="${esc(s.id)}" ${s.id === tile.sourceId ? 'selected' : ''}>${esc(sourceOptionLabel(s))}</option>`,
    ),
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
        <option value="kesher" ${kind === 'kesher' ? 'selected' : ''}>Kesher-Intercom (bedienbar)</option>
        <option value="churchtools" ${kind === 'churchtools' ? 'selected' : ''}>ChurchTools-Ablauf</option>
        <option value="propresenter" ${kind === 'propresenter' ? 'selected' : ''}>ProPresenter (Folien / Hintergründe)</option>
        <option value="playlist" ${kind === 'playlist' ? 'selected' : ''}>ProPresenter-Playlist</option>
        <option value="preacher" ${kind === 'preacher' ? 'selected' : ''}>ProPresenter-Prediger (Folien steuern)</option>
        <option value="stage" ${kind === 'stage' ? 'selected' : ''}>ProPresenter-Bühne (Songtext, Countdown, Nachricht)</option>
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
      <p class="muted">Zeigt den Ablauf des heutigen Events aus ChurchTools. Gibt es heute keinen, steht der nächste Termin mit Ablauf da (bis 6 Wochen voraus). Mit festem Datum nur dieser Tag. Verbindung unter <a href="#/einstellungen/churchtools">Einstellungen</a>.</p>`
        : ''
    }
    ${kind === 'chat' ? chatSection(tile) : ''}
    ${kind === 'kesher' ? kesherSection(tile) : ''}
    ${kind === 'audio' ? bankSection(tile) : ''}
    ${kind === 'propresenter' ? ppSection(tile) : ''}
    ${kind === 'playlist' ? playlistSection(tile) : ''}
    ${kind === 'preacher' ? preacherSection(tile) : ''}
    ${kind === 'stage' ? stageSection(tile) : ''}
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

  if (el.dataset.st || el.dataset.stTimer) {
    const tile = layout.tiles.find((t) => t.id === selectedTileId)
    if (!tile) return
    const o = stageOptions(tile.stage)
    if (el.dataset.stTimer) {
      const uuid = el.dataset.stTimer
      o.timers = el.checked ? [...o.timers.filter((u) => u !== uuid), uuid] : o.timers.filter((u) => u !== uuid)
    } else {
      o[el.dataset.st] = el.type === 'checkbox' ? el.checked : Number(el.value)
      const out = el.closest('label').querySelector('output')
      if (out) out.textContent = `${Math.round(o.size * 100)} %`
    }
    tile.stage = o
    renderCanvas()
    changed()
    return
  }

  if (el.dataset.chat) {
    const tile = layout.tiles.find((t) => t.id === selectedTileId)
    if (!tile) return
    const key = el.dataset.chat
    const value = el.type === 'checkbox' ? el.checked : Number(el.value)
    tile.chat = { ...chatOptions(tile.chat), [key]: value }
    const out = el.closest('label').querySelector('output')
    if (out) out.textContent = key === 'size' ? `${Math.round(value * 100)} %` : String(value)
    renderCanvas()
    changed()
    return
  }

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
    } else if (key === 'lineWidth') {
      layout.lineWidth = clamp(parseInt(el.value, 10) || LINE_WIDTH, 1, 16)
    } else if (key === 'gap') {
      layout.gap = clamp(parseInt(el.value, 10) || 0, 0, 40)
    } else if (key === 'lines') {
      layout.lines = el.value !== 'off'
      renderInspector()
    } else if (key === 'shared') {
      layout.shared = el.checked
    } else if (key === 'owner') {
      layout.owner = el.value || null
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
  if (
    key === 'showLabel' ||
    key === 'showTally' ||
    key === 'showMeter' ||
    key === 'ctResponsible' ||
    key === 'ctNotes' ||
    key === 'kesherTakeover' ||
    key === 'kesherHideControls' ||
    key === 'chatInput'
  )
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
    if (tile.kind === 'kesher' && tile.kesherUser == null) tile.kesherUser = 'Multiview'
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
      if (!isAdmin()) {
        copy.owner = user.roleId
        copy.shared = false
      }
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
      users.forEach((o) => (o.layoutId = myLayouts()[0]?.id ?? null))
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
    ['ProPresenter: Bühnennachricht senden', `${base}/api/propresenter/stage-message?text=Noch%205%20Minuten`],
    ['ProPresenter: Bühnennachricht löschen', `${base}/api/propresenter/stage-message/clear`],
    ['Status abfragen (JSON)', `${base}/api/state`],
  ]
  $('#companion-help').innerHTML = `<div class="table-wrap"><table class="table companion-table">${lines
    .map(([label, url]) => `<tr><td>${esc(label)}</td><td><code>${esc(url)}</code></td></tr>`)
    .join('')}</table></div>`
}

// ---------------------------------------------------------------------------
// Benutzer, Rechte und Darstellung
// ---------------------------------------------------------------------------

async function loadMe() {
  try {
    const data = await fetch('/api/me', { cache: 'no-store' }).then((r) => r.json())
    if (data.access?.enabled && !data.user) {
      goToLogin()
      await new Promise(() => {}) // Seite wechselt gleich
    }
    if (data.user && !data.user.open) adoptServerPrefs(data.prefs)
    return data
  } catch {
    // Server (noch) nicht erreichbar: wie bisher offen arbeiten, der Server prüft beim Speichern
    return { access: { enabled: false }, user: { admin: true, open: true, name: '', roleId: 'admin' } }
  }
}

function goToLogin() {
  location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.hash)}`)
}

function isAdmin() {
  return Boolean(user?.admin)
}

/** Multiviews und Layouts, die der angemeldete Nutzer sieht. */
function myOutputs() {
  return config ? visibleOutputs(config, user) : []
}

function myLayouts() {
  return config ? visibleLayouts(config, user) : []
}

/** Kesher-Rollen für die Rechte (ohne die Rolle des Chat-Monitors). */
function kesherRoles() {
  return (chat.roles ?? []).filter((r) => r.id !== config?.chat?.roleId)
}

function roleLabel(roleId) {
  return kesherRoles().find((r) => r.id === roleId)?.name || roleId
}

const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

function applyRoleUi() {
  for (const el of document.querySelectorAll('[data-admin]')) el.hidden = !isAdmin()
  $('#layout-add').hidden = !roleRights(config, user)?.editLayouts
  $('#template-panel').hidden = !mayEditLayouts()
  renderUserCard()
}

function renderUserCard() {
  const card = $('#user-card')
  if (user?.open) {
    card.innerHTML = `<div class="avatar" style="background:var(--amber)">!</div>
      <div class="user-meta"><b>Zugang offen</b><span>Ohne Anmeldung – alle dürfen alles</span></div>
      <a class="icon-btn" href="#/zugang/anmeldung" title="Admin-PIN festlegen" aria-label="Admin-PIN festlegen">
        <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></a>`
    return
  }
  renderProfileCard()
  card.innerHTML = `<button type="button" class="avatar-btn" id="avatar-pick" title="Profilbild ändern" aria-label="Profilbild ändern">${avatarHtml(user)}</button>
    <div class="user-meta"><b>${esc(user?.name)}</b><span>${esc(user?.roleName || '')}</span></div>
    <div class="user-actions">
      <a class="icon-btn" href="/login.html?wechseln=1&next=${encodeURIComponent(location.pathname + location.hash)}" title="Konto oder Rolle wechseln" aria-label="Konto wechseln">
        <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M7 7h12l-3-3M17 17H5l3 3"/></svg></a>
      <button class="icon-btn" id="logout-btn" title="Abmelden" aria-label="Abmelden">
        <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/></svg></button>
    </div>`
  // Angemeldet mit einer Rolle: direkt zum Admin wechseln können
  $('#admin-login-btn').hidden = !me?.access?.enabled || isAdmin()
}

// --- Suche in der Seitenleiste (wie in den macOS-Systemeinstellungen) --------------

const SEARCH_ENTRIES = [
  { label: 'Übersicht', href: '#/', words: 'start multiviews status profil qr handy anmelden' },
  { label: 'Layouts', href: '#/layouts', words: 'editor kacheln raster trennlinien vorlagen' },
  { label: 'Eingänge', href: '#/eingaenge', admin: true, words: 'kamera capture stream video quellen testbild' },
  { label: 'ATEM', href: '#/einstellungen/atem', admin: true, words: 'einstellungen tally mischer ip' },
  { label: 'ProPresenter', href: '#/einstellungen/propresenter', admin: true, words: 'einstellungen folien stage display beamer nachricht' },
  { label: 'Kesher-Chat', href: '#/einstellungen/kesher', admin: true, words: 'einstellungen intercom chat rolle' },
  { label: 'ChurchTools', href: '#/einstellungen/churchtools', admin: true, words: 'einstellungen ablauf agenda gottesdienst' },
  { label: 'Companion', href: '#/einstellungen/companion', admin: true, words: 'einstellungen stream deck tasten' },
  { label: 'Bildschirme am Server', href: '#/einstellungen/bildschirme', admin: true, words: 'einstellungen hdmi monitor anschluss' },
  { label: 'Angemeldete Geräte', href: '#/einstellungen/geraete', admin: true, words: 'einstellungen online ip sitzung abmelden' },
  { label: 'Rollen', href: '#/zugang/rollen', admin: true, words: 'benutzer rechte sehen bearbeiten licht ton' },
  { label: 'Anmeldung & Admin-PIN', href: '#/zugang/anmeldung', admin: true, words: 'benutzer pin passwort admin' },
  { label: 'Anmeldung für alle Dienste', href: '#/zugang/dienste', admin: true, words: 'benutzer tagescode qr feste geräte gateway' },
  { label: 'Darstellung', open: 'appearance-dialog', words: 'hintergrund hell dunkel farbe wallpaper theme' },
  { label: 'QR-Codes fürs Handy', open: 'qr-dialog', words: 'handy anmelden scannen' },
]

const searchInput = $('#side-search')
const searchResults = $('#side-search-results')
let searchHits = []
let searchIndex = 0

function renderSearch() {
  const q = searchInput.value.trim().toLowerCase()
  searchHits = q
    ? SEARCH_ENTRIES.filter((e) => (!e.admin || isAdmin()) && `${e.label} ${e.words}`.toLowerCase().includes(q))
        // Treffer im Namen zuerst, dann in den Stichworten
        .sort((a, b) => Number(!a.label.toLowerCase().includes(q)) - Number(!b.label.toLowerCase().includes(q)))
        .slice(0, 8)
    : []
  searchIndex = 0
  searchResults.hidden = !q
  searchResults.innerHTML = searchHits.length
    ? searchHits
        .map((e, i) => `<button type="button" role="option" data-hit="${i}" class="${i === searchIndex ? 'active' : ''}">${esc(e.label)}</button>`)
        .join('')
    : '<p class="muted">Nichts gefunden</p>'
}

function openHit(hit) {
  if (!hit) return
  searchInput.value = ''
  searchResults.hidden = true
  searchInput.blur()
  if (hit.open) document.querySelector(`[data-open="${hit.open}"]`)?.click()
  else location.hash = hit.href
}

searchInput.addEventListener('input', renderSearch)
searchInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault()
    if (!searchHits.length) return
    searchIndex = (searchIndex + (e.key === 'ArrowDown' ? 1 : -1) + searchHits.length) % searchHits.length
    searchResults.querySelectorAll('[data-hit]').forEach((b) => b.classList.toggle('active', Number(b.dataset.hit) === searchIndex))
  } else if (e.key === 'Enter') {
    e.preventDefault()
    openHit(searchHits[searchIndex])
  } else if (e.key === 'Escape') {
    searchInput.value = ''
    renderSearch()
    searchInput.blur()
  }
})
searchResults.addEventListener('mousedown', (e) => {
  const b = e.target.closest('[data-hit]')
  if (b) {
    e.preventDefault()
    openHit(searchHits[Number(b.dataset.hit)])
  }
})
searchInput.addEventListener('blur', () => setTimeout(() => (searchResults.hidden = true), 120))
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    document.body.classList.remove('sidebar-collapsed')
    searchInput.focus()
    searchInput.select()
  }
})

// --- Profil (Übersicht): großes Profilbild, Name, Rolle und App-Kacheln ------------

// Gefüllte Symbole im Stil der SF Symbols (weiß auf farbigem Squircle)
const APP_TILES = [
  { href: '#/layouts', label: 'Layouts', color: 'blue', icon: '<path fill-rule="evenodd" d="M5.5 3h13A3.5 3.5 0 0 1 22 6.5v11a3.5 3.5 0 0 1-3.5 3.5h-13A3.5 3.5 0 0 1 2 17.5v-11A3.5 3.5 0 0 1 5.5 3Zm-1.5 7v7.5c0 .8.7 1.5 1.5 1.5H9v-9H4Zm7 0v9h7.5c.8 0 1.5-.7 1.5-1.5V10h-9Z"/>' },
  { href: '#/eingaenge', label: 'Eingänge', color: 'green', admin: true, icon: '<rect x="1.5" y="5.5" width="14.5" height="13" rx="3.2"/><path d="M17.3 10.1 21 7.6c.6-.4 1.5 0 1.5.8v7.2c0 .8-.9 1.2-1.5.8l-3.7-2.5z"/>' },
  { href: '#/einstellungen', label: 'Einstellungen', color: 'gray', admin: true, icon: '<path fill-rule="evenodd" d="M19.60 12.00 L21.42 13.87 L20.87 15.67 L18.32 16.22 L17.37 17.37 L17.33 19.98 L15.67 20.87 L13.48 19.45 L12.00 19.60 L10.13 21.42 L8.33 20.87 L7.78 18.32 L6.63 17.37 L4.02 17.33 L3.13 15.67 L4.55 13.48 L4.40 12.00 L2.58 10.13 L3.13 8.33 L5.68 7.78 L6.63 6.63 L6.67 4.02 L8.33 3.13 L10.52 4.55 L12.00 4.40 L13.87 2.58 L15.67 3.13 L16.22 5.68 L17.37 6.63 L19.98 6.67 L20.87 8.33 L19.45 10.52Z M15.2 12 a3.2 3.2 0 1 0 -6.4 0 a3.2 3.2 0 1 0 6.4 0Z"/>' },
  { href: '#/zugang', label: 'Benutzer', color: 'orange', admin: true, icon: '<circle cx="9" cy="7.2" r="3.7"/><path d="M1.8 19.3c0-3.8 3.2-6.4 7.2-6.4s7.2 2.6 7.2 6.4c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2Z"/><circle cx="17.2" cy="8.3" r="2.9"/><path d="M17.6 12.9c2.7.2 4.6 2.1 4.6 4.9 0 .7-.5 1.2-1.2 1.2h-3.2c.2-.6.3-1.1.3-1.7 0-1.7-.7-3.2-1.8-4.4h1.3Z"/>' },
  { href: '/remote.html', label: 'Handy', color: 'purple', icon: '<path fill-rule="evenodd" d="M8.2 1.5h7.6A3.2 3.2 0 0 1 19 4.7v14.6a3.2 3.2 0 0 1-3.2 3.2H8.2A3.2 3.2 0 0 1 5 19.3V4.7a3.2 3.2 0 0 1 3.2-3.2Zm1.6 17.6a.8.8 0 0 0 0 1.6h4.4a.8.8 0 0 0 0-1.6H9.8Z"/>' },
  { open: 'qr-dialog', label: 'QR-Codes', color: 'teal', icon: '<path fill-rule="evenodd" d="M4 2.5h5A1.5 1.5 0 0 1 10.5 4v5A1.5 1.5 0 0 1 9 10.5H4A1.5 1.5 0 0 1 2.5 9V4A1.5 1.5 0 0 1 4 2.5Zm1.5 3v2h2v-2h-2ZM15 2.5h5A1.5 1.5 0 0 1 21.5 4v5a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 13.5 9V4A1.5 1.5 0 0 1 15 2.5Zm1.5 3v2h2v-2h-2ZM4 13.5h5a1.5 1.5 0 0 1 1.5 1.5v5A1.5 1.5 0 0 1 9 21.5H4A1.5 1.5 0 0 1 2.5 20v-5A1.5 1.5 0 0 1 4 13.5Zm1.5 3v2h2v-2h-2Z"/><rect x="13.5" y="13.5" width="3.4" height="3.4" rx=".8"/><rect x="18.1" y="18.1" width="3.4" height="3.4" rx=".8"/><rect x="18.1" y="13.5" width="3.4" height="3.4" rx=".8"/><rect x="13.5" y="18.1" width="3.4" height="3.4" rx=".8"/>' },
  { open: 'appearance-dialog', label: 'Darstellung', color: 'pink', icon: '<path fill-rule="evenodd" d="M12 2C6.5 2 2 6.2 2 11.5S6.3 21.5 11.3 21.5c1.5 0 2.4-1 2.4-2.2 0-.6-.2-1.1-.6-1.5-.3-.4-.5-.8-.5-1.3 0-1.2 1-2.1 2.2-2.1h2.4c3 0 4.8-2 4.8-4.6C22 5.6 17.5 2 12 2Zm-5.4 9.8a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Zm3.5-4.3a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Zm4.8.3a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4Z"/>' },
]

function renderProfileCard() {
  const el = $('#profile-card')
  if (!el) return
  const tiles = APP_TILES.filter((t) => !t.admin || isAdmin())
    .map((t) => {
      const inner = `<span class="app-icon ${t.color}"><svg viewBox="0 0 24 24" aria-hidden="true">${t.icon}</svg></span><span class="app-label">${t.label}</span>`
      return t.open
        ? `<button type="button" class="app-tile" data-open="${t.open}">${inner}</button>`
        : `<a class="app-tile" href="${t.href}">${inner}</a>`
    })
    .join('')
  const outputs = myOutputs()
  const live = outputs.filter((o) => o.layoutId).length
  el.innerHTML = `<div class="glass profile-me">
      ${user?.open ? avatarHtml({ name: 'M V' }, { cls: 'avatar xl' }) : `<button type="button" class="avatar-btn" data-avatar-pick title="Profilbild ändern" aria-label="Profilbild ändern">${avatarHtml(user, { cls: 'avatar xl' })}<span class="avatar-edit" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg></span></button>`}
      <h2>${esc(user?.open ? 'Multiview' : user?.name)}</h2>
      <p>${esc(user?.open ? 'Zugang offen' : user?.roleName || '')}${isAdmin() && !user?.open && user?.roleName !== 'Admin' ? ' · Admin' : ''}</p>
      ${user?.open ? '' : `<div class="profile-actions">
        <button type="button" class="btn small" data-avatar-pick>${user?.avatar ? 'Bild ändern' : 'Profilbild hinzufügen'}</button>
        ${user?.avatar ? '<button type="button" class="btn small link" data-avatar-remove>Entfernen</button>' : ''}
      </div>`}
      <p class="profile-stat"><b>${outputs.length}</b> Multiview${outputs.length === 1 ? '' : 's'} · <b>${live}</b> mit Layout</p>
    </div>
    <div class="glass app-grid">${tiles}</div>`
  if (!user?.open) {
    el.append(loginQrCard)
    if (!loginQrCard.dataset.started) renewHeroQr()
  }
  el.classList.toggle('with-qr', !user?.open)
}

// Anmelde-QR auf der Übersicht: Handy-Kamera drauf → das Handy ist als dieselbe Person/Rolle
// angemeldet (und für heute freigeschaltet). Ein Code gilt einmal und 10 Minuten – darum
// erneuert er sich alle 2 Minuten von selbst, damit immer ein gültiger auf dem Bildschirm steht.
const loginQrCard = document.createElement('div')
loginQrCard.className = 'glass qr-hero'
loginQrCard.innerHTML = `<img alt="QR-Code zum Anmelden am Handy" width="168" height="168">
  <div class="qr-hero-text">
    <h3>Handy anmelden</h3>
    <p class="muted">Mit der Handy-Kamera scannen – das Handy ist dann gleich angemeldet.</p>
    <button type="button" class="btn small">Neuer Code</button>
  </div>`
let heroQrTimer = null
async function renewHeroQr() {
  loginQrCard.dataset.started = '1'
  clearTimeout(heroQrTimer)
  const img = loginQrCard.querySelector('img')
  try {
    if (document.visibilityState !== 'hidden') {
      const res = await fetch('/api/me/qr', { method: 'POST' })
      const data = await res.json()
      if (!data.ok) throw new Error(data.error)
      img.src = qrUrl(`${publicOrigin(server)}/q/${data.token}`)
      img.style.opacity = ''
    }
  } catch {
    img.style.opacity = '0.25'
  }
  heroQrTimer = setTimeout(renewHeroQr, 2 * 60 * 1000)
}
loginQrCard.querySelector('button').addEventListener('click', renewHeroQr)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && loginQrCard.dataset.started && renewHeroQr())

async function changeAvatar(remove) {
  try {
    const avatar = remove ? await removeAvatar() : await pickAvatar()
    if (avatar === undefined) return
    user = { ...user, avatar }
    renderUserCard()
  } catch (err) {
    alert(err.message)
  }
}

document.addEventListener('click', (e) => {
  if (e.target.closest('#avatar-pick, [data-avatar-pick]')) changeAvatar(false)
  else if (e.target.closest('[data-avatar-remove]')) changeAvatar(true)
})

$('#user-card').addEventListener('click', async (e) => {
  if (!e.target.closest('#logout-btn')) return
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.replace('/login.html')
})

$('#admin-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const error = $('#admin-error')
  error.textContent = me?.access?.pinSource === 'kesher' ? 'Prüfe bei Kesher …' : ''
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: user?.name || 'Admin', roleId: 'admin', pin: $('#admin-pin').value }),
  }).catch(() => null)
  const data = await res?.json().catch(() => ({}))
  if (!res?.ok || !data?.ok) {
    error.textContent = data?.error || 'Server nicht erreichbar'
    $('#admin-pin').select()
    return
  }
  location.reload()
})
$('#admin-dialog').addEventListener('close', () => {
  $('#admin-pin').value = ''
  $('#admin-error').textContent = ''
})

/** Layout-Inspector (Admin): wem das Layout gehört und ob alle Rollen es benutzen dürfen. */
function layoutAccessFields(layout) {
  const roles = kesherRoles()
  return `<hr class="divider">
    <h3>Zugriff</h3>
    <label class="field"><span>Gehört zur Rolle</span><select data-l="owner">
      <option value="">– niemandem (Admin) –</option>
      ${roles.map((r) => `<option value="${esc(r.id)}" ${r.id === layout.owner ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}
      ${layout.owner && !roles.some((r) => r.id === layout.owner) ? `<option value="${esc(layout.owner)}" selected>${esc(layout.owner)}</option>` : ''}
    </select></label>
    <label class="check"><input type="checkbox" data-l="shared" ${layout.shared ? 'checked' : ''}> Für alle Rollen freigegeben (nur benutzen)</label>`
}

// --- Statusübersicht ---------------------------------------------------------

function renderStatusStrip() {
  if (!config) return
  const tile = (state, title, text, href) =>
    `<${isAdmin() ? `a href="${href}"` : 'div'} class="status-tile ${state}">
      <span class="status-dot"></span>
      <span class="status-text"><b>${title}</b><span>${esc(text)}</span></span>
    </${isAdmin() ? 'a' : 'div'}>`
  const pp = propresenter
  const ct = churchtools
  $('#status-strip').innerHTML = [
    !config.atem.ip
      ? tile('off', 'ATEM', 'nicht eingerichtet', '#/einstellungen/atem')
      : tile(atem.connected ? 'ok' : 'bad', 'ATEM', atem.connected ? atem.model || 'verbunden' : 'getrennt', '#/einstellungen/atem'),
    !config.propresenter?.host
      ? tile('off', 'ProPresenter', 'nicht eingerichtet', '#/einstellungen/propresenter')
      : tile(
          pp.connected ? 'ok' : 'bad',
          'ProPresenter',
          pp.connected ? (pp.presentation ? pp.presentation.name : 'verbunden') : 'nicht erreichbar',
          '#/einstellungen/propresenter',
        ),
    tile(chat.state === 'connected' ? 'ok' : 'bad', 'Kesher', chat.state === 'connected' ? 'verbunden' : 'getrennt', '#/einstellungen/kesher'),
    ct.state === 'unconfigured'
      ? tile('off', 'ChurchTools', 'nicht verbunden', '#/einstellungen/churchtools')
      : tile(ct.state === 'connected' ? 'ok' : 'bad', 'ChurchTools', ct.state === 'connected' ? 'verbunden' : ct.error || 'Fehler', '#/einstellungen/churchtools'),
  ].join('')
  // Derselbe Zustand als Punkt in den Reitern der Einstellungen
  const dots = {
    atem: !config.atem.ip ? 'off' : atem.connected ? 'ok' : 'bad',
    propresenter: !config.propresenter?.host ? 'off' : pp.connected ? 'ok' : 'bad',
    kesher: chat.state === 'connected' ? 'ok' : 'bad',
    churchtools: ct.state === 'unconfigured' ? 'off' : ct.state === 'connected' ? 'ok' : 'bad',
  }
  for (const [section, state] of Object.entries(dots)) {
    const link = document.querySelector(`[data-section-link="${section}"]`)
    if (link) link.dataset.state = state
  }
}

// --- Benutzer & Rechte (Admin) ----------------------------------------------

let pinChoice = null // im Formular gewählte PIN-Quelle
const lockIcon = '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>'
let accessKey = ''
const pencilIcon = '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/></svg>'
const copyIcon = '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>'
const trashIcon = '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>'

function renderAccess() {
  if (!config || !isAdmin() || page !== 'zugang') return
  // Nicht neu aufbauen, während jemand eine PIN tippt
  if ($('#access-pin-card').contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return

  const enabled = me.access?.enabled
  const fromKesher = me.access?.pinSource === 'kesher'
  const source = pinChoice ?? (enabled && !fromKesher ? 'own' : 'kesher')
  $('#access-pin-card').innerHTML = `
    <div class="card-head"><div><h2>Anmeldung</h2>
      <p class="muted">Mit einer Admin-PIN wird die Anmeldung eingeschaltet. Danach meldet sich jeder mit Namen und Kesher-Rolle an, der Admin mit der PIN.</p></div></div>
    <div class="access-state ${enabled ? 'on' : 'open'}">${lockIcon}
      <div>${
        enabled
          ? `<b>Anmeldung aktiv</b> – Admin-PIN ${fromKesher ? '<b>wie im Kesher-Admin</b> (wird bei Kesher geprüft)' : '<b>eigene PIN</b>'}. Ohne Anmeldung lässt sich nichts ändern; Monitore und Companion laufen weiter ohne Anmeldung.`
          : '<b>Zugang offen.</b> Jeder im Netzwerk kann alles ändern. Richte die Admin-PIN ein, um Rollen und Rechte zu nutzen.'
      }</div>
    </div>
    <form id="pin-form" class="pin-form" autocomplete="off">
      <div class="field" style="grid-column:1/-1"><span>Admin-PIN</span>
        <div class="segmented" role="radiogroup">
          <button type="button" data-pin-source="kesher" class="${source === 'kesher' ? 'active' : ''}">Wie im Kesher-Admin (empfohlen)</button>
          <button type="button" data-pin-source="own" class="${source === 'own' ? 'active' : ''}">Eigene PIN</button>
        </div>
      </div>
      ${enabled ? '<label class="field"><span>Bisherige Admin-PIN</span><input type="password" inputmode="numeric" name="currentPin" autocomplete="off" required></label>' : ''}
      ${enabled ? '' : `<label class="field"><span>Dein Name</span><input type="text" name="name" value="${esc(user?.name || 'Admin')}" required></label>`}
      ${
        source === 'kesher'
          ? `<label class="field"><span>Admin-PIN von Kesher</span><input type="password" inputmode="numeric" name="pin" autocomplete="off" required></label>`
          : `<label class="field"><span>Neue PIN (4–12 Ziffern)</span><input type="password" inputmode="numeric" name="pin" pattern="\\d{4,12}" autocomplete="new-password" required></label>
             <label class="field"><span>PIN wiederholen</span><input type="password" inputmode="numeric" name="pin2" autocomplete="new-password" required></label>`
      }
      <div class="btn-row" style="grid-column:1/-1"><button class="btn primary" type="submit">${
        enabled ? 'Übernehmen' : source === 'kesher' ? 'Mit Kesher-PIN einschalten' : 'PIN festlegen und einschalten'
      }</button>
        ${enabled ? '<button class="btn danger" type="button" id="pin-remove">Anmeldung ausschalten</button>' : ''}</div>
    </form>
    <p class="muted" style="font-size:12.5px;margin-top:10px">${
      source === 'kesher'
        ? 'Der Multiview speichert die PIN nicht – er fragt bei jeder Admin-Anmeldung Kesher. Ändert sich die PIN in Kesher, gilt sie hier sofort mit. Ist Kesher nicht erreichbar, geht die Admin-Anmeldung so lange nicht.'
        : 'Die PIN wird nur als Hash auf dem Server gespeichert.'
    }</p>
    <p class="form-error" id="pin-error"></p>`

  const roles = kesherRoles()
  const key = JSON.stringify([roles, chat.rooms, config.outputs.map((o) => [o.id, o.name]), config.access.roles])
  if (key !== accessKey || !$('#access-roles').childElementCount) {
    accessKey = key
    $('#access-roles').innerHTML = !roles.length
      ? `<p class="muted">Keine Rollen – ist Kesher verbunden? (Einstellungen → Kesher-Chat)</p>`
      : `<div class="table-wrap"><table class="table role-table">
          <thead><tr><th>Rolle</th><th>Hört in Kesher (Chat)</th><th>Multiviews <span class="muted" style="font-weight:500">– antippen: aus → sehen → bearbeiten</span></th><th>Neue Layouts anlegen</th></tr></thead>
          <tbody>${roles
            .map((r) => {
              const rights = roleRights(config, { roleId: r.id })
              return `<tr data-role="${esc(r.id)}">
                <td><div class="role-name">${esc(r.name)}</div>
                  <div class="role-actions">
                    <button type="button" class="icon-btn" data-role-rename title="Umbenennen" aria-label="${esc(r.name)} umbenennen">${pencilIcon}</button>
                    <button type="button" class="icon-btn" data-role-copy title="Als Vorlage für eine neue Rolle" aria-label="${esc(r.name)} kopieren">${copyIcon}</button>
                    <button type="button" class="icon-btn danger" data-role-delete title="Löschen" aria-label="${esc(r.name)} löschen">${trashIcon}</button>
                  </div></td>
                <td class="muted" style="font-size:12.5px">${esc(listensTo(r.id)) || '–'}</td>
                <td><div class="chip-set">${
                  config.outputs
                    .map(
                      (o) => {
                        const level = rights.edit.includes(o.id) ? 'edit' : rights.outputs.includes(o.id) ? 'view' : 'off'
                        const hint = { off: 'kein Zugriff', view: 'nur sehen', edit: 'sehen und bearbeiten' }[level]
                        return `<button type="button" class="chip level-${level}" data-role-output="${esc(o.id)}" title="${esc(o.name)}: ${hint}">${esc(o.name)}<span class="chip-level">${{ off: '', view: 'sehen', edit: 'bearbeiten' }[level]}</span></button>`
                      },
                    )
                    .join('') || '<span class="muted">Noch keine Multiviews</span>'
                }</div></td>
                <td><label class="switch"><input type="checkbox" data-role-edit ${rights.editLayouts ? 'checked' : ''}><span class="switch-track"></span><span class="muted">einrichten</span></label></td>
              </tr>`
            })
            .join('')}</tbody></table></div>
        <div class="btn-row" style="margin-top:14px">
          <button class="btn" type="button" id="roles-suggest">Multiviews nach Rollennamen vorschlagen</button>
          <span class="muted" style="font-size:12.5px;align-self:center">z. B. „Licht 1“ und „Licht 2“ → Multiview „Licht“. Bestehende Häkchen bleiben.</span>
        </div>`
  }
}

/** Party Lines, auf denen eine Rolle in Kesher hört (bestimmt ihren Chat). */
function listensTo(roleId) {
  return (chat.rooms ?? [])
    .filter((room) => room.listeners.includes(roleId))
    .map((room) => room.name)
    .join(', ')
}

/** Multiviews vorschlagen, deren Name im Rollennamen steckt („Licht 2“ → „Licht“). */
function suggestRights() {
  const norm = (t) => String(t).toLowerCase().replace(/[^a-z0-9äöüß]+/g, ' ').trim()
  let added = 0
  for (const role of kesherRoles()) {
    const words = norm(role.name).split(' ')
    const matches = config.outputs.filter((o) => {
      const name = norm(o.name)
      return name && (words.includes(name) || norm(role.name).startsWith(`${name} `) || norm(role.name) === name)
    })
    if (!matches.length) continue
    const rights = roleRights(config, { roleId: role.id })
    const ids = matches.map((o) => o.id).filter((id) => !rights.outputs.includes(id))
    added += ids.length
    // Vorschläge bekommen „sehen und bearbeiten“; bestehende Einstellungen bleiben
    config.access.roles[role.id] = {
      ...(config.access.roles[role.id] ?? {}),
      outputs: [...rights.outputs, ...ids],
      edit: [...rights.edit, ...ids],
      editLayouts: rights.editLayouts,
    }
  }
  accessKey = ''
  renderAccess()
  if (added) changed(0)
  toast(added ? `${added} Freigabe(n) ergänzt` : 'Keine passenden Namen gefunden')
}

$('#page-zugang').addEventListener('change', (e) => {
  const row = e.target.closest('tr[data-role]')
  if (!row) return
  const roleId = row.dataset.role
  const current = config.access.roles[roleId] ?? { outputs: [], editLayouts: true }
  if ('roleEdit' in e.target.dataset) {
    current.editLayouts = e.target.checked
  } else return
  config.access.roles[roleId] = current
  accessKey = JSON.stringify([kesherRoles(), config.outputs.map((o) => [o.id, o.name]), config.access.roles])
  changed(0)
})

// Multiview-Recht einer Rolle weiterschalten: aus → sehen → bearbeiten → aus
$('#page-zugang').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-role-output]')
  const row = chip?.closest('tr[data-role]')
  if (!row) return
  const roleId = row.dataset.role
  const rights = roleRights(config, { roleId })
  const id = chip.dataset.roleOutput
  const level = rights.edit.includes(id) ? 'edit' : rights.outputs.includes(id) ? 'view' : 'off'
  const next = { off: 'view', view: 'edit', edit: 'off' }[level]
  const outputs = rights.outputs.filter((x) => x !== id)
  const edit = rights.edit.filter((x) => x !== id)
  if (next !== 'off') outputs.push(id)
  if (next === 'edit') edit.push(id)
  config.access.roles[roleId] = { ...(config.access.roles[roleId] ?? {}), outputs, edit, editLayouts: rights.editLayouts }
  accessKey = ''
  renderAccess()
  changed(0)
})

// --- Rollen anlegen, umbenennen, löschen (gespeichert in Kesher) ---------------

let roleDialogMode = null // { mode: 'create' | 'rename', roleId }

function openRoleDialog(mode, roleId = '') {
  roleDialogMode = { mode, roleId }
  const role = kesherRoles().find((r) => r.id === roleId)
  const create = mode !== 'rename'
  $('#role-dialog-title').textContent = create ? 'Neue Rolle' : 'Rolle umbenennen'
  $('#role-dialog-lead').textContent = create
    ? 'Die Rolle erscheint sofort in Kesher und bei der Anmeldung. Mit einer Vorlage bekommt sie deren Party Lines, Stream-Deck-Tasten und Multiview-Rechte.'
    : 'Rechte und Party Lines bleiben, nur der Name ändert sich – hier und in Kesher.'
  $('#role-name').value = create ? '' : role?.name ?? ''
  $('#role-copy-field').hidden = !create
  $('#role-copy').innerHTML = `<option value="">– keine (leere Rolle) –</option>${kesherRoles()
    .map((r) => `<option value="${esc(r.id)}" ${r.id === roleId ? 'selected' : ''}>${esc(r.name)}</option>`)
    .join('')}`
  $('#role-submit').textContent = create ? 'Anlegen' : 'Umbenennen'
  $('#role-error').textContent = ''
  $('#role-dialog').showModal()
  setTimeout(() => $('#role-name').focus(), 50)
}

async function roleRequest(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => null)
  if (res?.status === 401) return goToLogin()
  const data = (await res?.json().catch(() => null)) ?? {}
  if (!res?.ok || !data.ok) throw new Error(data.error || 'Server nicht erreichbar')
  return data
}

$('#role-new').addEventListener('click', () => openRoleDialog('create'))

$('#role-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const { mode, roleId } = roleDialogMode ?? {}
  const name = $('#role-name').value.trim()
  const button = $('#role-submit')
  button.disabled = true
  try {
    if (mode === 'rename') {
      await roleRequest('PUT', `/api/access/roles/${encodeURIComponent(roleId)}`, { name })
      toast(`Rolle heißt jetzt „${name}“`)
    } else {
      await roleRequest('POST', '/api/access/roles', { name, copyFrom: $('#role-copy').value })
      toast(`Rolle „${name}“ angelegt`)
    }
    $('#role-dialog').close()
  } catch (err) {
    $('#role-error').textContent = err.message
  } finally {
    button.disabled = false
  }
})

$('#page-zugang').addEventListener('click', async (e) => {
  const button = e.target.closest('[data-role-rename], [data-role-copy], [data-role-delete]')
  const roleId = button?.closest('tr[data-role]')?.dataset.role
  if (!roleId) return
  if ('roleRename' in button.dataset) return openRoleDialog('rename', roleId)
  if ('roleCopy' in button.dataset) return openRoleDialog('create', roleId)
  const name = roleLabel(roleId)
  if (!confirm(`Rolle „${name}“ löschen?\nSie verschwindet auch aus Kesher – mit ihren Party-Line-Rechten und Stream-Deck-Tasten.`)) return
  try {
    await roleRequest('DELETE', `/api/access/roles/${encodeURIComponent(roleId)}`)
    toast(`Rolle „${name}“ gelöscht`)
  } catch (err) {
    alert(err.message)
  }
})

$('#page-zugang').addEventListener('submit', async (e) => {
  if (e.target.id !== 'pin-form') return
  e.preventDefault()
  const form = new FormData(e.target)
  const error = $('#pin-error')
  const source = $('#pin-form [data-pin-source].active')?.dataset.pinSource || 'kesher'
  if (source === 'own' && form.get('pin') !== form.get('pin2')) return (error.textContent = 'Die beiden PINs stimmen nicht überein.')
  error.textContent = source === 'kesher' ? 'Prüfe bei Kesher …' : ''
  const res = await fetch('/api/access/pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source, pin: form.get('pin'), currentPin: form.get('currentPin'), name: form.get('name') }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) return (error.textContent = data.error || `Fehler (HTTP ${res.status})`)
  error.textContent = ''
  toast(me.access.enabled ? 'Admin-PIN übernommen' : 'Anmeldung ist eingeschaltet – du bist als Admin angemeldet')
  setTimeout(() => location.reload(), 900)
})

$('#page-zugang').addEventListener('click', async (e) => {
  const choice = e.target.closest('[data-pin-source]')
  if (choice) {
    pinChoice = choice.dataset.pinSource
    return renderAccess()
  }
  if (e.target.closest('#roles-suggest')) return suggestRights()
  if (e.target.closest('#pin-remove')) {
    const pin = $('#pin-form [name="currentPin"]').value
    if (!pin) return ($('#pin-error').textContent = 'Zum Ausschalten die bisherige PIN eingeben.')
    if (!confirm('Anmeldung ausschalten? Danach kann wieder jeder im Netzwerk alles ändern.')) return
    const res = await fetch('/api/access/pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ off: true, currentPin: pin }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) return ($('#pin-error').textContent = data.error || `Fehler (HTTP ${res.status})`)
    location.reload()
  }
})

// Einstellungen > Angemeldete Geräte
$('#set-sessions').addEventListener('click', async (e) => {
  const end = e.target.closest('[data-end-session]')
  if (end) {
    await fetch(`/api/access/sessions/${encodeURIComponent(end.dataset.endSession)}`, { method: 'DELETE' })
    loadSessions()
  }
  if (e.target.closest('#sessions-refresh')) loadSessions()
})
// Online/offline ändert sich laufend – solange die Liste offen ist, alle 15 s neu laden
setInterval(() => {
  if (document.visibilityState === 'visible' && !$('#set-sessions').hidden && page === 'einstellungen') loadSessions()
}, 15_000)

async function loadSessions() {
  if (!isAdmin()) return
  const box = $('#access-sessions')
  if (!me.access?.enabled) {
    box.innerHTML = '<p class="muted">Erst mit eingeschalteter Anmeldung gibt es angemeldete Geräte.</p>'
    return
  }
  try {
    const all = await fetch('/api/access/sessions').then((r) => r.json())
    // Nur Geräte, die gerade online sind (eine Seite offen haben)
    const list = all.filter((s) => s.live || s.self)
    const when = (ms) => new Date(ms).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    box.innerHTML = `<div class="table-wrap"><table class="table">
      <thead><tr><th>Name</th><th>Rolle</th><th>IP-Adresse</th><th>Zuletzt aktiv</th><th></th></tr></thead>
      <tbody>${list
        .map(
          (s) => `<tr><td class="session-who">${avatarHtml(s, { cls: 'avatar sm' })}<b>${esc(s.name)}</b>${s.self ? ' <span class="badge accent">dieses Gerät</span>' : ''}${s.live ? ' <span class="pill ok" style="height:22px">online</span>' : ''}</td>
            <td>${esc(s.roleName)}</td><td>${s.ip ? `<code class="ip">${esc(s.ip)}</code>` : '<span class="muted">–</span>'}</td><td class="muted">${esc(when(s.seen))}</td>
            <td style="text-align:right">${s.self ? '' : `<button class="btn small danger" data-end-session="${esc(s.id)}">Abmelden</button>`}</td></tr>`,
        )
        .join('') || '<tr><td colspan="5" class="muted">Gerade ist kein Gerät online.</td></tr>'}</tbody></table></div>`
  } catch {
    box.innerHTML = '<p class="muted">Konnte die Liste nicht laden.</p>'
  }
}

// --- Anmeldung für alle Dienste: Tagescode und feste Geräte -------------------

let gatewayInfo = null
const removeIcon = '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>'

async function loadGateway() {
  if (!isAdmin() || page !== 'zugang') return
  try {
    const res = await fetch('/api/access/gateway', { cache: 'no-store' })
    gatewayInfo = res.ok ? await res.json() : null
  } catch {
    gatewayInfo = null
  }
  renderGateway()
}
// Der Code wechselt um Mitternacht, die Zahl der Geräte laufend
setInterval(() => document.visibilityState === 'visible' && loadGateway(), 60_000)

/** Adresse im QR-Code: öffnet die Startseite (Dashboard) und übernimmt dabei den Code. */
const gatewayCodeUrl = (info) => `${info.startUrl || publicOrigin(server)}/.jms-auth/code?c=${info.code}`

function exemptRow(entry = { network: '', label: '', login: false }) {
  return `<div class="exempt-row">
    <input type="text" name="network" value="${esc(entry.network)}" placeholder="192.168.0.50" aria-label="Adresse oder Bereich" inputmode="decimal">
    <input type="text" name="label" value="${esc(entry.label)}" placeholder="z. B. Station Licht" aria-label="Bezeichnung">
    <select name="login" aria-label="Anmeldung">
      <option value="" ${entry.login ? '' : 'selected'}>Ohne Anmeldung</option>
      <option value="1" ${entry.login ? 'selected' : ''}>Nur ohne Code</option>
    </select>
    <button class="icon-btn" type="button" data-exempt-remove aria-label="Entfernen" title="Entfernen">${removeIcon}</button>
  </div>`
}

function renderGateway() {
  const card = $('#access-gateway-card')
  if (!isAdmin() || page !== 'zugang') return
  // Nicht neu aufbauen, während jemand tippt
  const active = document.activeElement
  if (card.contains(active) && active.tagName === 'INPUT' && active.type !== 'checkbox') return
  const info = gatewayInfo
  const head = `<div class="card-head gateway-head"><div><h2>Anmeldung für alle Dienste</h2>
    <p class="muted">Intercom (Kesher), Dashboard, Companion, Portainer und Glances fragen dann zuerst nach Name und Rolle – einmal für alle, wie hier im Multiview. Geräte im WLAN brauchen dazu einmal am Tag den Code. Companion, Portainer und Glances sind nur für den Admin. Der Multiview selbst bleibt ohne Code erreichbar.</p></div>`
  if (!info) {
    card.innerHTML = `${head}</div><p class="muted">Konnte die Einstellungen nicht laden.</p>`
    return
  }
  const pinReady = me.access?.enabled
  const digits = `${info.code.slice(0, 3)} ${info.code.slice(3)}`
  const exempt = info.exempt.length ? info.exempt : []
  card.innerHTML = `${head}
      <label class="switch"><input type="checkbox" id="gateway-enabled" ${info.enabled ? 'checked' : ''} ${pinReady ? '' : 'disabled'}><span class="switch-track"></span><span>${info.enabled ? 'Eingeschaltet' : 'Ausgeschaltet'}</span></label>
    </div>
    ${pinReady ? '' : '<div class="notice warn">Erst oben die Admin-PIN einrichten – ohne sie gibt es keine Anmeldung.</div>'}
    ${info.secret ? '' : '<div class="notice warn">Auf dem Server fehlt <code>JMS_AUTH_SECRET</code>. Bis es eingerichtet ist, meldet sich der Admin in Kesher weiter mit der Kesher-PIN an.</div>'}
    <div class="day-code">
      <figure class="qr-card accent">
        <div class="qr-frame"><img src="${esc(qrUrl(gatewayCodeUrl(info)))}" alt="QR-Code mit dem Code von heute"></div>
        <figcaption><b>QR-Code von heute</b><span class="muted">Mit der Handy-Kamera scannen</span></figcaption>
      </figure>
      <div class="day-code-info">
        <span class="field"><span>Code für Laptops</span></span>
        <output class="day-code-digits" aria-label="Code von heute: ${esc(info.code.split('').join(' '))}">${esc(digits)}</output>
        <p class="muted">Neu um Mitternacht. Wer ihn heute eingegeben hat, bleibt bis morgen 5 Uhr freigeschaltet.
          <b>${info.devicesToday}</b> ${info.devicesToday === 1 ? 'Gerät ist' : 'Geräte sind'} gerade freigeschaltet.</p>
        <button class="btn small" type="button" id="gateway-renew">Neuen Code erzeugen</button>
        <div class="day-qr-monitor">
          <label class="check"><input type="checkbox" data-dayqr="show" ${config?.dayQr?.show !== false ? 'checked' : ''}> Klein auf den Monitoren zeigen</label>
          <select data-dayqr="corner" aria-label="Ecke" ${config?.dayQr?.show === false ? 'disabled' : ''}>
            ${[['br', 'unten rechts'], ['bl', 'unten links'], ['tr', 'oben rechts'], ['tl', 'oben links']]
              .map(([v, l]) => `<option value="${v}" ${(config?.dayQr?.corner || 'br') === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
          <select data-dayqr="size" aria-label="Größe" ${config?.dayQr?.show === false ? 'disabled' : ''}>
            ${[['s', 'klein'], ['m', 'mittel'], ['l', 'groß']]
              .map(([v, l]) => `<option value="${v}" ${(config?.dayQr?.size || 'm') === v ? 'selected' : ''}>${l}</option>`)
              .join('')}
          </select>
          <small class="muted">Immer der aktuelle Code – nur auf den Monitoren am Server und festen Geräten, nie in der Vorschau.</small>
        </div>
      </div>
    </div>
    <form id="gateway-form" class="gateway-form" autocomplete="off">
      <label class="field"><span>Startseite nach dem Scannen</span>
        <input type="url" name="startUrl" value="${esc(info.startUrl)}" placeholder="${esc(publicOrigin(server))}">
        <small class="muted">Am besten das Dashboard, z. B. https://192.168.0.21:3000. Leer = dieser Multiview.</small>
      </label>
      <div class="field"><span>Feste Geräte ohne Code</span>
        <small class="muted">Stationen, Raspberry Pis, Kesher-App, Rechner im LAN: eine Adresse (192.168.0.50) oder ein Bereich (192.168.0.0/24). <b>Ohne Anmeldung</b>: kommen ohne Code und Anmeldung an Intercom und Dashboard (Stationen, Kiosk). <b>Nur ohne Code</b>: brauchen keinen Tagescode, melden sich aber mit Name und Rolle an (Arbeitsrechner). An die Admin-Dienste kommen alle nur mit Admin-Anmeldung. Der Server selbst ist immer frei.</small>
        <div class="exempt-list" id="exempt-list">${exempt.map(exemptRow).join('')}</div>
        <div><button class="btn small" type="button" id="exempt-add">Gerät hinzufügen</button></div>
      </div>
      <div class="btn-row"><button class="btn primary" type="submit">Speichern</button></div>
      <p class="form-error" id="gateway-error" role="alert"></p>
    </form>`
}

async function saveGateway(changes) {
  const res = await fetch('/api/access/gateway', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  }).catch(() => null)
  const data = (await res?.json().catch(() => null)) ?? {}
  if (!res?.ok || !data.ok) throw new Error(data.error || 'Server nicht erreichbar')
  gatewayInfo = data
  return data
}

$('#access-gateway-card').addEventListener('change', async (e) => {
  if (e.target.id !== 'gateway-enabled') return
  const on = e.target.checked
  if (
    on &&
    !confirm(
      'Anmeldung für alle Dienste einschalten?\n\nDanach brauchen alle Geräte, die nicht unter „Feste Geräte ohne Code“ stehen, den Tagescode – auch Raspberry Pis, Stationen und die Kesher-App. Diese vorher eintragen.',
    )
  ) {
    e.target.checked = false
    return
  }
  try {
    await saveGateway({ enabled: on })
    toast(on ? 'Anmeldung für alle Dienste ist eingeschaltet' : 'Anmeldung für alle Dienste ist ausgeschaltet')
  } catch (err) {
    e.target.checked = !on
    toast(err.message)
  }
  renderGateway()
})

// Tages-QR-Code auf den Monitoren: normale Einstellung (config.dayQr)
$('#access-gateway-card').addEventListener('change', (e) => {
  const key = e.target.dataset.dayqr
  if (!key) return
  config.dayQr = { show: true, corner: 'br', size: 'm', ...config.dayQr, [key]: key === 'show' ? e.target.checked : e.target.value }
  changed(0)
  renderGateway()
})

$('#access-gateway-card').addEventListener('click', async (e) => {
  if (e.target.closest('#exempt-add')) {
    $('#exempt-list').insertAdjacentHTML('beforeend', exemptRow())
    $('#exempt-list .exempt-row:last-child input').focus()
    return
  }
  const remove = e.target.closest('[data-exempt-remove]')
  if (remove) return remove.closest('.exempt-row').remove()
  if (e.target.closest('#gateway-renew')) {
    if (!confirm('Neuen Code erzeugen? Alle Geräte, die heute schon freigeschaltet sind, müssen den neuen Code eingeben.')) return
    const res = await fetch('/api/access/code/renew', { method: 'POST' }).catch(() => null)
    if (res?.ok) gatewayInfo = await res.json()
    renderGateway()
    toast(res?.ok ? 'Neuer Code erzeugt' : 'Server nicht erreichbar')
  }
})

$('#access-gateway-card').addEventListener('submit', async (e) => {
  if (e.target.id !== 'gateway-form') return
  e.preventDefault()
  const form = e.target
  const exempt = [...form.querySelectorAll('.exempt-row')]
    .map((row) => ({
      network: row.querySelector('[name="network"]').value.trim(),
      label: row.querySelector('[name="label"]').value.trim(),
      login: row.querySelector('[name="login"]').value === '1',
    }))
    .filter((entry) => entry.network)
  try {
    await saveGateway({ exempt, startUrl: form.startUrl.value.trim() })
    document.activeElement?.blur()
    renderGateway()
    toast('Gespeichert')
  } catch (err) {
    $('#gateway-error').textContent = err.message
  }
})

// --- Darstellung, QR-Codes, Menü ---------------------------------------------

function renderThemeButton() {
  const { theme } = currentPrefs()
  const name = THEMES.find((t) => t.value === theme)?.name
  $('#theme-btn').innerHTML = themeIcon(theme)
  $('#theme-btn').title = `Darstellung: ${name} (klicken zum Wechseln)`
}
renderThemeButton()
onPrefsChange(() => {
  renderThemeButton()
  if ($('#appearance-dialog').open) $('#appearance-body').innerHTML = appearanceHtml()
})
$('#theme-btn').addEventListener('click', () => setPrefs({ theme: nextTheme() }, { server: !user?.open }))
bindAppearance($('#appearance-body'))

document.addEventListener('click', (e) => {
  const opener = e.target.closest('[data-open]')
  if (!opener) return
  const dialog = document.getElementById(opener.dataset.open)
  if (dialog.id === 'appearance-dialog') $('#appearance-body').innerHTML = appearanceHtml()
  if (dialog.id === 'qr-dialog') renderQr()
  if (dialog.id === 'admin-dialog') setTimeout(() => $('#admin-pin').focus(), 50)
  document.body.classList.remove('nav-open')
  dialog.showModal()
})
for (const dialog of document.querySelectorAll('dialog')) {
  // Klick neben den Dialog schließt ihn
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close()
  })
}

// Menü-Taste (☰) und Abdunklung: siehe Skript am Ende von index.html – unabhängig von diesem Modul

const qrUrl = (data) => `/api/qr.svg?data=${encodeURIComponent(data)}`
let qrTimer = null

async function renderQr() {
  $('#qr-login-user').textContent = user?.open ? 'Gast' : `${user.name} (${user.roleName})`
  await renewLoginQr()
}

async function renewLoginQr() {
  clearInterval(qrTimer)
  const img = $('#qr-login')
  const timer = $('#qr-login-timer')
  try {
    const res = await fetch('/api/me/qr', { method: 'POST' })
    if (res.status === 401) return goToLogin()
    const data = await res.json()
    img.src = qrUrl(`${publicOrigin(server)}/q/${data.token}`)
    img.style.opacity = ''
    const until = Date.now() + data.expiresInMs
    const tick = () => {
      const left = Math.max(0, until - Date.now())
      timer.textContent = left
        ? `Noch ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')} gültig`
        : 'Abgelaufen – neuen Code erzeugen'
      if (!left) {
        img.style.opacity = '0.25'
        clearInterval(qrTimer)
      }
    }
    tick()
    qrTimer = setInterval(tick, 1000)
  } catch {
    timer.textContent = 'Code konnte nicht erzeugt werden'
  }
}
$('#qr-login-renew').addEventListener('click', renewLoginQr)
$('#qr-dialog').addEventListener('close', () => clearInterval(qrTimer))

/** Start: erst die Anmeldung klären (ohne Anmeldung zur Anmeldeseite), dann verbinden. */
async function start() {
  me = await loadMe()
  user = me.user
  if (me.access?.enabled) watchLogin(loginKey(user))
  connect(onMessage, (online) => {
    if (!online) setSaveState('error', 'Server nicht erreichbar')
    else if (!saveTimer) setSaveState('')
  })
  showPage()
  loadTemplates()
  document.body.classList.remove('booting')
}

start()
