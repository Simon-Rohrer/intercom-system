// Fernbedienung fürs Handy, iPad und den Desktop – wie eine kleine App mit Leiste unten
// (am Desktop als Seitenleiste links, siehe remote.css):
//   Multiviews:  die eigenen Multiviews umschalten (welches Layout läuft)
//   Chat:        Kesher-Chat lesen und als die angemeldete Rolle schreiben
//   Bühne:       Bühnennachricht (Stage Display) in ProPresenter senden/löschen
//   Beamer:      Meldung für die Gemeinde in ProPresenter vorbereiten – anzeigen tut sie der Bediener
//   Monitore:    (nur Admin) welcher Multiview auf welchem Monitor am Server läuft
import { connect, reloadWhenIdle, watchLogin, loginKey } from './common.js'
import { adoptServerPrefs, applyPrefs, currentPrefs, nextTheme, setPrefs, themeIcon } from './theme.js'
import { visibleOutputs, visibleLayouts, canEditOutput, chatFor } from './rights.js'
import { createComposer } from './chat-compose.js'
import { fillAvatar, pickAvatar } from './avatar.js'
import { serviceUrl, findService } from './services.js'

const $ = (sel) => document.querySelector(sel)
const $$ = (sel) => [...document.querySelectorAll(sel)]
$('#dashboard-link').href = serviceUrl(findService('dashboard'))
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const QUICK_MESSAGES = ['Noch 5 Minuten', 'Noch 2 Minuten', 'Bitte zum Ende kommen', 'Lauter sprechen', 'Mikrofon näher an den Mund']

let user = { admin: false, open: false, name: '', roleId: '' } // wird in start() gesetzt
let serverBootId = null
let config = null
let screens = [] // erkannte Anschlüsse
let stage = { message: '' }
let propresenter = { connected: false }
let chat = { state: 'connecting', messages: [] }
let composer = null
let online = true
const previews = new Set(readJson(sessionStorage, 'mv.remote.previews', []))
// ?tab=chat|stage|beamer|outputs öffnet direkt diesen Bereich (Links vom Dashboard)
const TAB_PARAM = new URLSearchParams(location.search).get('tab')
let tab = TAB_PARAM || readJson(localStorage, 'mv.remote.tab', 'outputs')
let lastSeenChat = readJson(localStorage, 'mv.remote.chatSeen', 0) // Zeitstempel der neuesten gelesenen Nachricht

function readJson(store, key, fallback) {
  try {
    const v = store.getItem(key)
    return v == null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}

function writeJson(store, key, value) {
  try {
    store.setItem(key, JSON.stringify(value))
  } catch {
    // privater Modus
  }
}

start()

/** Anmeldung klären (sonst zur Anmeldeseite), dann Kopf zeigen und verbinden. */
async function start() {
  const me = await fetch('/api/me', { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null)
  if (me?.access?.enabled && !me.user)
    return location.replace(`/login.html?next=${encodeURIComponent('/remote.html' + location.search)}`)
  user = me?.user ?? { admin: true, open: true, name: '', roleId: 'admin' }
  if (me?.access?.enabled) watchLogin(loginKey(user))
  if (!user.open) adoptServerPrefs(me.prefs)
  else applyPrefs(currentPrefs())

  fillAvatar($('#avatar'), user.open ? null : user, user.open ? 'MV' : initials(user.name))
  $('#user-name').textContent = user.open ? 'Fernbedienung' : user.name
  $('#user-role').textContent = user.open ? 'Zugang offen' : user.roleName
  $('#logout-btn').hidden = user.open
  $('#editor-link').hidden = !user.admin
  renderTheme()
  // Chat schreiben nur angemeldet – dann als die eigene Rolle (Admin wählt eine)
  if (!user.open) {
    composer = createComposer(user)
    $('#chat-compose').append(composer.el)
  } else {
    $('#chat-compose').innerHTML = '<p class="rm-hint">Zum Schreiben bitte anmelden.</p>'
  }
  $('#message-quick').innerHTML = QUICK_MESSAGES.map((t) => `<button type="button" data-quick="${esc(t)}">${esc(t)}</button>`).join('')

  connect(
    (msg) => {
      if (msg.type === 'config') {
        config = msg.config
        render()
      } else if (msg.type === 'server') {
        // Neuer Stand auf dem Server (Update oder geänderte Dateien): von selbst neu laden
        if (msg.bootId && serverBootId && msg.bootId !== serverBootId) return reloadWhenIdle()
        serverBootId = msg.bootId ?? serverBootId
      } else if (msg.type === 'screens') {
        screens = msg.screens
        renderScreens()
      } else if (msg.type === 'ppstage') {
        stage = msg
        renderMessage()
        renderBeamer()
      } else if (msg.type === 'propresenter') {
        propresenter = msg
        renderMessage()
      } else if (msg.type === 'chat') {
        chat = msg
        renderChat()
      } else if (msg.type === 'session_revoked') {
        location.replace('/login.html?abgemeldet=1&next=/remote.html')
      }
    },
    (isOnline) => {
      online = isOnline
      $('#offline').hidden = online
      $('#live-dot').classList.toggle('off', !online)
    },
  )
}

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.replace('/login.html?next=/remote.html')
})
function renderTheme() {
  $('#theme-btn').innerHTML = themeIcon(currentPrefs().theme)
}
// Tippen aufs eigene Bild: neues Profilbild aus Fotos oder Kamera
$('#avatar').addEventListener('click', async () => {
  if (user.open) return
  try {
    const avatar = await pickAvatar()
    if (avatar === undefined) return
    user = { ...user, avatar }
    fillAvatar($('#avatar'), user, initials(user.name))
  } catch (err) {
    alert(err.message)
  }
})

$('#theme-btn').addEventListener('click', async () => {
  await setPrefs({ theme: nextTheme() }, { server: !user.open })
  renderTheme()
})

function initials(name) {
  return (
    String(name || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? '')
      .join('') || '?'
  )
}

function toast(text, kind = '') {
  const el = $('#toast')
  el.textContent = text
  el.className = `rm-toast ${kind}`
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (el.hidden = true), 2200)
}

function render() {
  renderOutputs()
  renderScreens()
  renderMessage()
  renderTabs()
  document.body.classList.remove('booting')
}

// --- Leiste unten ------------------------------------------------------------------

/** Welche Bereiche es für diesen Nutzer gibt. */
function availableTabs() {
  return [
    'outputs',
    'chat',
    config?.propresenter?.host ? 'stage' : null,
    config?.propresenter?.host ? 'beamer' : null,
    user.admin && screenIds().length ? 'screens' : null,
  ].filter(Boolean)
}

function renderTabs() {
  const tabs = availableTabs()
  if (!tabs.includes(tab)) tab = tabs[0]
  for (const btn of $$('#tabs [data-tab]')) {
    btn.hidden = !tabs.includes(btn.dataset.tab)
    btn.classList.toggle('active', btn.dataset.tab === tab)
    btn.setAttribute('aria-current', btn.dataset.tab === tab ? 'page' : 'false')
  }
  for (const panel of $$('[data-panel]')) panel.hidden = panel.dataset.panel !== tab
  document.body.dataset.tab = tab
  if (tab === 'chat') markChatSeen()
  updateBadges()
}

$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]')
  if (!btn || btn.dataset.tab === tab) return
  tab = btn.dataset.tab
  writeJson(localStorage, 'mv.remote.tab', tab)
  renderTabs()
  window.scrollTo(0, 0)
  if (tab === 'chat') scrollChatToEnd()
})

function updateBadges() {
  const unread = tab === 'chat' ? 0 : myMessages().filter((m) => m.timestamp > lastSeenChat).length
  $('#chat-badge').hidden = !unread
  $('#chat-badge').textContent = unread > 9 ? '9+' : String(unread)
  $('#stage-badge').hidden = !(tab !== 'stage' && stage.message)
  $('#beamer-badge').hidden = !(tab !== 'beamer' && (stage.requests ?? []).some((r) => r.status === 'wartet' || r.status === 'angezeigt'))
}

// --- Bildschirme ---------------------------------------------------------------------

/** Kleine Skizze eines Layouts: die Kacheln als Kästchen, eingefärbt nach Art. */
function layoutSketch(layout) {
  if (!layout?.tiles?.length || !layout.cols || !layout.rows) return '<span class="rm-sketch empty"></span>'
  const boxes = layout.tiles
    .map((t) => {
      const style = `left:${(t.x / layout.cols) * 100}%;top:${(t.y / layout.rows) * 100}%;width:${(t.w / layout.cols) * 100}%;height:${(t.h / layout.rows) * 100}%`
      return `<i class="k-${esc(t.kind || 'source')}" style="${style}"></i>`
    })
    .join('')
  return `<span class="rm-sketch">${boxes}</span>`
}

// --- Ausklappen -----------------------------------------------------------------------
// Jede Karte (Multiview bzw. Monitor) lässt sich zuklappen; gemerkt pro Gerät. Ohne eigene
// Wahl sind bei mehr als zwei Karten alle zu – dann sieht man sofort die ganze Liste.
let collapsed = readJson(localStorage, 'mv.remote.collapsed', {})

const isCollapsed = (key, count) => collapsed[key] ?? count > 2

function setCollapsed(keys, value) {
  for (const key of keys) collapsed[key] = value
  writeJson(localStorage, 'mv.remote.collapsed', collapsed)
}

/** Leiste „Alle auf/zu“ über einer Liste mit mehr als zwei Karten. */
function foldBar(keys, count) {
  if (count <= 2) return ''
  const allOpen = keys.every((k) => !isCollapsed(k, count))
  return `<div class="rm-foldbar"><span>${count} Einträge</span>
    <button type="button" data-fold-all="${allOpen ? 'zu' : 'auf'}">${allOpen ? 'Alle zuklappen' : 'Alle aufklappen'}</button></div>`
}

function renderOutputs() {
  const outputs = visibleOutputs(config, user)
  const layouts = visibleLayouts(config, user)
  const box = $('#outputs')
  // Offene Vorschauen (iframes) behalten, damit sie nicht bei jeder Änderung neu laden
  const keep = new Map([...box.querySelectorAll('.rm-preview')].map((el) => [el.dataset.id, el]))
  box.replaceChildren()
  if (!outputs.length) {
    box.innerHTML = `<div class="rm-empty"><b>Noch kein Multiview freigegeben</b>Der Admin legt unter „Benutzer &amp; Rechte“ fest, welche Multiviews deine Rolle bedienen darf.</div>`
    return
  }
  const keys = outputs.map((o) => `o:${o.id}`)
  box.insertAdjacentHTML('beforeend', foldBar(keys, outputs.length))
  for (const output of outputs) {
    const current = config.layouts.find((l) => l.id === output.layoutId)
    const folded = isCollapsed(`o:${output.id}`, outputs.length)
    const card = document.createElement('article')
    card.className = `rm-card${folded ? ' folded' : ''}`
    card.dataset.id = output.id
    card.dataset.fold = `o:${output.id}`
    card.innerHTML = `
      <div class="rm-card-head">
        <button type="button" class="rm-card-title rm-fold" data-fold aria-expanded="${!folded}">
          <h2>${esc(output.name)}</h2>
          <span class="rm-status ${current ? 'on' : ''}">${current ? `<i></i>${esc(current.name)}` : 'Aus'}</span>
        </button>
        <button class="rm-pill ${previews.has(output.id) ? 'active' : ''}" data-preview aria-pressed="${previews.has(output.id)}">
          <svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
          Vorschau
        </button>
        <button type="button" class="rm-fold-btn" data-fold aria-label="${folded ? 'Aufklappen' : 'Zuklappen'}"><svg viewBox="0 0 24 24" class="icon rm-chevron" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button>
      </div>
      ${
        !canEditOutput(config, user, output.id)
          ? `<div class="rm-viewonly"><svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>Nur ansehen – umschalten darf hier jemand anderes</div>`
          : `<div class="rm-layouts">
        ${layouts
          .map(
            (l) => `<button class="rm-layout ${l.id === output.layoutId ? 'active' : ''}" data-layout="${esc(l.id)}">
              ${layoutSketch(l)}<span>${esc(l.name)}</span></button>`,
          )
          .join('')}
        <button class="rm-layout off ${output.layoutId ? '' : 'active'}" data-layout="">
          <span class="rm-sketch empty"><svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/></svg></span><span>Aus</span>
        </button>
      </div>`
      }`
    // Vorschau auch zugeklappt zeigen, wenn sie an ist – das ist der schnelle Blick auf den Monitor
    if (previews.has(output.id)) {
      const preview =
        keep.get(output.id) ??
        Object.assign(document.createElement('div'), {
          className: 'rm-preview',
          innerHTML: `<iframe src="/output.html?id=${encodeURIComponent(output.id)}&embed=1" allow="microphone; camera; fullscreen; autoplay; speaker-selection" title="${esc(output.name)}"></iframe>`,
        })
      preview.dataset.id = output.id
      card.querySelector('.rm-card-head').after(preview)
      previewScaler.observe(preview)
    }
    box.append(card)
  }
}

// Vorschau in Monitorgröße rendern und verkleinern – sonst wäre die Schrift im Verhältnis
// zu den Kacheln viel zu groß (der Multiview rechnet Schriftgrößen mit Mindestwerten).
const PREVIEW_WIDTH = 1920
const scalePreview = (el) => el.style.setProperty('--rm-scale', String(el.clientWidth / PREVIEW_WIDTH))
// Ältere iPhones (iOS 12) kennen ResizeObserver nicht – dann beim Drehen/Ändern der Größe neu rechnen
const previewScaler =
  typeof ResizeObserver === 'function'
    ? new ResizeObserver((entries) => entries.forEach((entry) => scalePreview(entry.target)))
    : {
        observe: (el) => requestAnimationFrame(() => scalePreview(el)),
      }
if (typeof ResizeObserver !== 'function')
  window.addEventListener('resize', () => document.querySelectorAll('.rm-preview').forEach(scalePreview))

/** Klick auf Kopf oder Pfeil klappt die Karte; „Alle auf/zu“ alle Karten der Liste. */
function handleFold(e, box, render) {
  const all = e.target.closest('[data-fold-all]')
  if (all) {
    setCollapsed([...box.querySelectorAll('[data-fold]')].map((c) => c.dataset.fold).filter(Boolean), all.dataset.foldAll === 'zu')
    render()
    return true
  }
  const toggle = e.target.closest('[data-fold]:not(.rm-card)')
  const card = toggle?.closest('.rm-card')
  if (!card) return false
  setCollapsed([card.dataset.fold], !card.classList.contains('folded'))
  render()
  return true
}

$('#outputs').addEventListener('click', async (e) => {
  if (handleFold(e, $('#outputs'), renderOutputs)) return
  const card = e.target.closest('.rm-card')
  if (!card) return
  const id = card.dataset.id
  if (e.target.closest('[data-preview]')) {
    if (previews.has(id)) previews.delete(id)
    else previews.add(id)
    writeJson(sessionStorage, 'mv.remote.previews', [...previews])
    return renderOutputs()
  }
  const btn = e.target.closest('[data-layout]')
  if (!btn || btn.classList.contains('active')) return
  btn.classList.add('busy')
  const res = await fetch(`/api/me/output/${encodeURIComponent(id)}/layout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layoutId: btn.dataset.layout || null }),
  }).catch(() => null)
  btn.classList.remove('busy')
  if (res?.status === 401) return location.replace('/login.html?next=/remote.html')
  if (!res?.ok) return toast((await res?.json().catch(() => null))?.error || 'Umschalten fehlgeschlagen', 'error')
  navigator.vibrate?.(15)
})

// --- Monitore am Server (Admin) ------------------------------------------------------

function connectorLabel(id) {
  const m = /^([A-Za-z]+)(?:-[A-Z])?-(\d+)$/.exec(id)
  if (!m) return id
  return `${{ DP: 'DisplayPort', eDP: 'Laptop-Display' }[m[1]] ?? m[1]} ${m[2]}`
}

function screenIds() {
  if (!config) return []
  return [...new Set([...screens.map((s) => s.id), ...(config.screens ?? []).map((s) => s.id)])]
}

function renderScreens() {
  if (!config || !user.admin) return
  renderTabs()
  const ids = screenIds()
  $('#screens').innerHTML =
    foldBar(
      ids.map((id) => `s:${id}`),
      ids.length,
    ) +
    ids
    .map((id) => {
      const saved = config.screens?.find((s) => s.id === id)
      const detected = screens.find((s) => s.id === id)
      const folded = isCollapsed(`s:${id}`, ids.length)
      const running = config.outputs.find((o) => o.id === saved?.outputId)
      return `<article class="rm-card${folded ? ' folded' : ''}" data-screen="${esc(id)}" data-fold="s:${esc(id)}">
        <div class="rm-card-head"><button type="button" class="rm-card-title rm-fold" data-fold aria-expanded="${!folded}"><h2>${esc(saved?.name || connectorLabel(id))}</h2>
          <span class="rm-status ${detected?.connected ? 'on' : ''}">${detected?.connected ? `<i></i>${running ? esc(running.name) : 'Monitor angeschlossen'}` : 'kein Monitor'}</span></button>
          <button type="button" class="rm-fold-btn" data-fold aria-label="${folded ? 'Aufklappen' : 'Zuklappen'}"><svg viewBox="0 0 24 24" class="icon rm-chevron" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg></button></div>
        <div class="rm-segments">
          ${config.outputs
            .map((o, i) => `<button class="${o.id === saved?.outputId ? 'active' : ''}" data-output="${i + 1}">${esc(o.name)}</button>`)
            .join('')}
          <button class="off ${saved?.outputId ? '' : 'active'}" data-output="aus">Aus</button>
        </div>
      </article>`
    })
    .join('')
}

$('#screens').addEventListener('click', async (e) => {
  if (handleFold(e, $('#screens'), renderScreens)) return
  const btn = e.target.closest('[data-output]')
  const card = e.target.closest('[data-screen]')
  if (!btn || !card || btn.classList.contains('active')) return
  btn.classList.add('busy')
  const res = await fetch(`/api/screen/${encodeURIComponent(card.dataset.screen)}/output/${btn.dataset.output}`, { method: 'POST' }).catch(
    () => null,
  )
  btn.classList.remove('busy')
  if (!res?.ok) toast('Umschalten fehlgeschlagen', 'error')
  else navigator.vibrate?.(15)
})

// --- Chat ----------------------------------------------------------------------------

const ownRole = () => (user.admin || user.open ? '' : user.roleId)
const myMessages = () => chatFor(chat, ownRole()).messages ?? []

function markChatSeen() {
  const newest = myMessages()[0]?.timestamp ?? 0
  if (newest > lastSeenChat) {
    lastSeenChat = newest
    writeJson(localStorage, 'mv.remote.chatSeen', newest)
  }
}

function scrollChatToEnd() {
  requestAnimationFrame(() => window.scrollTo(0, document.documentElement.scrollHeight))
}

const time = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
const day = (ms) => new Date(ms).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })

// Beamer-/Bühnen-Meldungen nur 15 s rot, danach wie jede andere Nachricht
const ALERT_MS = 15 * 1000
let alertTimer = null

function renderChat() {
  composer?.update(chat)
  clearTimeout(alertTimer)
  const now = Date.now()
  let nextAlertEnd = Infinity
  const alertState = (m) => {
    if (m.source !== 'multiview-alert') return ''
    const age = now - (m.receivedAt || m.timestamp || now)
    if (age >= ALERT_MS) return ''
    nextAlertEnd = Math.min(nextAlertEnd, ALERT_MS - age)
    return age < 1500 ? 'alert alert-pop' : 'alert'
  }
  const own = ownRole()
  // Server liefert die neueste zuerst – im Messenger steht sie unten
  const messages = myMessages().slice(0, 40).reverse()
  const state = { connected: '', connecting: 'verbindet …' }[chat.state] ?? 'getrennt'
  $('#chat-state').textContent = state
  $('#chat-state').hidden = !state
  const nearEnd = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 80
  let lastDay = ''
  let lastFrom = ''
  $('#chat-list').innerHTML =
    messages
      .map((m) => {
        const mine = own ? m.fromRoleId === own : false
        const d = day(m.timestamp)
        const dayLine = d !== lastDay ? `<li class="rm-day">${esc(d)}</li>` : ''
        const sameSender = d === lastDay && lastFrom === `${m.from}|${m.fromRoleId}`
        lastDay = d
        lastFrom = `${m.from}|${m.fromRoleId}`
        const who = mine ? '' : `<b>${esc(m.from)}</b>${m.fromRole && m.fromRole !== m.from ? ` · ${esc(m.fromRole)}` : ''}`
        return `${dayLine}<li class="rm-bubble ${mine ? 'mine' : ''} ${sameSender ? 'cont' : ''} ${alertState(m)}">
          ${who && !sameSender ? `<div class="rm-bubble-from">${who}</div>` : ''}
          <div class="rm-bubble-body">${esc(m.body)}</div>
          <div class="rm-bubble-meta"><span class="rm-target">${esc(m.target)}</span>${esc(time(m.timestamp))}</div>
        </li>`
      })
      .join('') || '<li class="rm-empty"><b>Noch keine Nachrichten</b>Hier erscheint der Kesher-Chat deiner Rolle.</li>'
  if (tab === 'chat') {
    markChatSeen()
    if (nearEnd) scrollChatToEnd()
  }
  updateBadges()
  if (nextAlertEnd !== Infinity) alertTimer = setTimeout(renderChat, nextAlertEnd + 50)
}

// --- Bühnennachricht -------------------------------------------------------------------

function renderMessage() {
  if (!config) return
  const card = $('#stage-card')
  const live = propresenter.connected && stage.message
  card.classList.toggle('live', Boolean(live))
  card.classList.toggle('offline', !propresenter.connected)
  $('#stage-label').textContent = !propresenter.connected ? 'ProPresenter nicht verbunden' : live ? 'Gerade auf der Bühne' : 'Keine Nachricht'
  $('#message-current').textContent = live ? stage.message : propresenter.connected ? 'Die Bühne zeigt gerade keine Nachricht.' : 'Senden geht erst wieder, wenn ProPresenter erreichbar ist.'
  $('#message-clear').hidden = !live
  // Die eigene, gerade gesendete Nachricht wird zurückgezogen, eine fremde nur gelöscht
  $('#message-clear').textContent = live && stage.message === lastSentStage ? 'Zurückziehen' : 'Löschen'
  renderTabs()
}

let lastSentStage = ''

async function sendMessage(text) {
  const res = await fetch(text ? '/api/propresenter/stage-message' : '/api/propresenter/stage-message/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => null)
  const data = await res?.json().catch(() => ({}))
  if (!res?.ok || !data?.ok) return toast(data?.error || 'Senden fehlgeschlagen', 'error')
  navigator.vibrate?.(15)
  const withdrawn = !text && stage.message && stage.message === lastSentStage
  lastSentStage = text
  toast(text ? 'Auf der Bühne ✓' : withdrawn ? 'Zurückgezogen' : 'Nachricht gelöscht', 'ok')
}

$('#message-form').addEventListener('submit', (e) => {
  e.preventDefault()
  const text = $('#message-text').value.trim()
  if (!text) return
  sendMessage(text)
  $('#message-text').value = ''
  $('#message-text').blur()
})
$('#message-clear').addEventListener('click', () => sendMessage(''))
$('#message-quick').addEventListener('click', (e) => {
  // Nur eintragen, gesendet wird mit dem Pfeil – ein versehentliches Antippen landet nicht auf der Bühne
  const btn = e.target.closest('[data-quick]')
  if (!btn) return
  $('#message-text').value = btn.dataset.quick
  $('#message-form').classList.remove('ready')
  void $('#message-form').offsetWidth
  $('#message-form').classList.add('ready')
})
$('#message-text').addEventListener('input', () => $('#message-form').classList.remove('ready'))

// --- Beamer-Meldungen -------------------------------------------------------------------

const REQUEST_STATUS = {
  wartet: ['wait', 'Wartet auf ProPresenter'],
  angezeigt: ['live', 'Auf dem Beamer'],
  beendet: ['done', 'Beendet'],
  ersetzt: ['done', 'Ersetzt'],
  zurückgezogen: ['done', 'Zurückgezogen'],
}
// Eigene Meldungen (Name|Rolle wie auf dem Server) lassen sich zurückziehen
const ownSender = () => (user && !user.open ? `${user.name}|${user.roleId}` : '')
let openTemplate = null // aufgeklappte Vorlage (uuid, '' = eigene Meldung)
let templatesKey = ''

function renderBeamer() {
  const requests = (stage.requests ?? []).filter((r) => r.status !== 'ersetzt').slice(0, 4)
  $('#beamer-status').hidden = !requests.length
  $('#beamer-requests').innerHTML = requests
    .map((r) => {
      const [kind, label] = REQUEST_STATUS[r.status] ?? ['done', r.status]
      return `<div class="rm-request ${kind}">
        <span class="rm-request-state">${esc(label)}</span>
        <div class="rm-request-text">${esc(r.text)}</div>
        <div class="rm-request-meta">${esc(r.name)}${r.from ? ` · ${esc(r.from)}` : ''} · ${esc(time(r.at))}</div>
        ${
          (r.status === 'wartet' || r.status === 'angezeigt') && (user?.admin || (r.by && r.by === ownSender()))
            ? `<button type="button" class="rm-request-withdraw" data-withdraw="${esc(r.id)}">Zurückziehen</button>`
            : ''
        }
      </div>`
    })
    .join('')

  // Vorlagen nur neu aufbauen, wenn sie sich ändern – sonst gingen Eingaben verloren
  const templates = (stage.templates ?? []).filter((t) => !t.free)
  const key = JSON.stringify([templates, openTemplate, propresenter.connected])
  if (key === templatesKey) return
  templatesKey = key
  const card = (id, name, preview, fields) => {
    const open = openTemplate === id
    return `<div class="rm-template ${open ? 'open' : ''}" data-template="${esc(id)}">
      <button type="button" class="rm-template-head" data-toggle>
        <b>${esc(name)}</b><span>${esc(preview)}</span>
      </button>
      ${
        open
          ? `<form class="rm-template-form" data-send>
              ${fields
                .map(
                  (f) => `<label><span>${esc(f)}</span><input type="text" name="${esc(f)}" maxlength="300" autocomplete="off" required></label>`,
                )
                .join('')}
              <button type="submit" class="rm-primary">An ProPresenter schicken</button>
            </form>`
          : ''
      }
    </div>`
  }
  $('#beamer-templates').innerHTML = !propresenter.connected
    ? '<div class="rm-empty"><b>ProPresenter nicht verbunden</b>Vorbereiten geht erst wieder, wenn ProPresenter erreichbar ist.</div>'
    : [card('', 'Eigene Meldung', 'Freier Text', ['Text']), ...templates.map((t) => card(t.uuid, t.name, t.text, t.fields))].join('')
  $('#beamer-templates .rm-template.open input')?.focus()
}

$('#beamer-requests').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-withdraw]')
  if (!btn) return
  btn.disabled = true
  const res = await fetch(`/api/propresenter/announce/${encodeURIComponent(btn.dataset.withdraw)}/withdraw`, { method: 'POST' }).catch(() => null)
  const data = await res?.json().catch(() => ({}))
  if (!res?.ok || !data?.ok) {
    btn.disabled = false
    return toast(data?.error || 'Zurückziehen fehlgeschlagen', 'error')
  }
  navigator.vibrate?.(15)
  toast('Zurückgezogen', 'ok')
})

$('#beamer-templates').addEventListener('click', (e) => {
  const head = e.target.closest('[data-toggle]')
  if (!head) return
  const id = head.closest('[data-template]').dataset.template
  openTemplate = openTemplate === id ? null : id
  renderBeamer()
})

$('#beamer-templates').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target.closest('[data-send]')
  const id = form.closest('[data-template]').dataset.template
  const values = Object.fromEntries(new FormData(form))
  const body = id ? { uuid: id, fields: values } : { text: values.Text }
  const button = form.querySelector('button')
  button.disabled = true
  const res = await fetch('/api/propresenter/announce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null)
  const data = await res?.json().catch(() => ({}))
  button.disabled = false
  if (res?.status === 401) return location.replace('/login.html?next=/remote.html')
  if (!res?.ok || !data?.ok) return toast(data?.error || 'Vorbereiten fehlgeschlagen', 'error')
  navigator.vibrate?.(15)
  openTemplate = null
  templatesKey = ''
  renderBeamer()
  window.scrollTo(0, 0)
  toast(data.notified ? 'Vorbereitet – ProPresenter weiß Bescheid' : 'In ProPresenter vorbereitet', 'ok')
})
