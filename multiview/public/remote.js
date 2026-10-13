// Fernbedienung fürs Handy: die eigenen Multiviews umschalten (welches Layout läuft),
// als Admin auch die Monitore am Server, und die Bühnennachricht senden.
import { connect } from './common.js'
import { adoptServerPrefs, applyPrefs, currentPrefs, nextTheme, setPrefs, themeIcon } from './theme.js'
import { visibleOutputs, visibleLayouts } from './rights.js'

const $ = (sel) => document.querySelector(sel)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

let user = { admin: false, open: false, name: '', roleId: '' } // wird in start() gesetzt
let config = null
let screens = [] // erkannte Anschlüsse
let stage = { message: '' }
let propresenter = { connected: false }
const previews = new Set(readPreviews())

function readPreviews() {
  try {
    return JSON.parse(sessionStorage.getItem('mv.remote.previews') || '[]')
  } catch {
    return []
  }
}

start()

/** Anmeldung klären (sonst zur Anmeldeseite), dann Kopf zeigen und verbinden. */
async function start() {
  const me = await fetch('/api/me', { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null)
  if (me?.access?.enabled && !me.user) return location.replace('/login.html?next=/remote.html')
  user = me?.user ?? { admin: true, open: true, name: '', roleId: 'admin' }
  if (!user.open) adoptServerPrefs(me.prefs)
  else applyPrefs(currentPrefs())

  $('#avatar').textContent = user.open ? '!' : initials(user.name)
  $('#user-name').textContent = user.open ? 'Fernbedienung' : user.name
  $('#user-role').textContent = user.open ? 'Zugang offen' : user.roleName
  $('#logout-btn').hidden = user.open
  renderTheme()

  connect(
    (msg) => {
      if (msg.type === 'config') {
        config = msg.config
        render()
      } else if (msg.type === 'screens') {
        screens = msg.screens
        renderScreens()
      } else if (msg.type === 'ppstage') {
        stage = msg
        renderMessage()
      } else if (msg.type === 'propresenter') {
        propresenter = msg
        renderMessage()
      } else if (msg.type === 'session_revoked') {
        location.replace('/login.html?abgemeldet=1&next=/remote.html')
      }
    },
    (online) => ($('#offline').hidden = online),
  )
}

$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' }).catch(() => {})
  location.replace('/login.html?next=/remote.html')
})
function renderTheme() {
  $('#theme-btn').innerHTML = themeIcon(currentPrefs().theme)
}
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

function toast(text) {
  const el = $('#toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => (el.hidden = true), 2500)
}

function render() {
  renderOutputs()
  renderScreens()
  renderMessage()
  document.body.classList.remove('booting')
}

// --- Multiviews ---------------------------------------------------------------

function renderOutputs() {
  const outputs = visibleOutputs(config, user)
  const layouts = visibleLayouts(config, user)
  const box = $('#outputs')
  // Offene Vorschauen (iframes) behalten, damit sie nicht bei jeder Änderung neu laden
  const keep = new Map([...box.querySelectorAll('.remote-preview')].map((el) => [el.dataset.id, el]))
  box.replaceChildren()
  if (!outputs.length) {
    box.innerHTML = `<div class="empty-state">Für deine Rolle ist noch kein Bildschirm freigegeben.<br>Der Admin legt das unter „Benutzer &amp; Rechte“ fest.</div>`
    return
  }
  for (const output of outputs) {
    const current = config.layouts.find((l) => l.id === output.layoutId)
    const card = document.createElement('article')
    card.className = 'card remote-card'
    card.dataset.id = output.id
    card.innerHTML = `
      <div class="remote-card-head">
        <div><h3>${esc(output.name)}</h3><span class="muted">${current ? `läuft: ${esc(current.name)}` : 'kein Layout'}</span></div>
        <button class="btn small" data-preview>${previews.has(output.id) ? 'Vorschau aus' : 'Vorschau'}</button>
      </div>
      <div class="layout-buttons">
        ${layouts
          .map(
            (l) => `<button class="layout-btn ${l.id === output.layoutId ? 'active' : ''}" data-layout="${esc(l.id)}">${esc(l.name)}</button>`,
          )
          .join('')}
        <button class="layout-btn off ${output.layoutId ? '' : 'active'}" data-layout="">Aus</button>
      </div>`
    if (previews.has(output.id)) {
      const preview =
        keep.get(output.id) ??
        Object.assign(document.createElement('div'), {
          className: 'remote-preview',
          innerHTML: `<iframe src="/output.html?id=${encodeURIComponent(output.id)}&embed=1" title="${esc(output.name)}"></iframe>`,
        })
      preview.dataset.id = output.id
      card.querySelector('.remote-card-head').after(preview)
    }
    box.append(card)
  }
}

$('#outputs').addEventListener('click', async (e) => {
  const card = e.target.closest('.remote-card')
  if (!card) return
  const id = card.dataset.id
  if (e.target.closest('[data-preview]')) {
    if (previews.has(id)) previews.delete(id)
    else previews.add(id)
    try {
      sessionStorage.setItem('mv.remote.previews', JSON.stringify([...previews]))
    } catch {
      // privater Modus
    }
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
  if (!res?.ok) return toast((await res?.json().catch(() => null))?.error || 'Umschalten fehlgeschlagen')
  navigator.vibrate?.(15)
})

// --- Monitore am Server (Admin) ----------------------------------------------------

function connectorLabel(id) {
  const m = /^([A-Za-z]+)(?:-[A-Z])?-(\d+)$/.exec(id)
  if (!m) return id
  return `${{ DP: 'DisplayPort', eDP: 'Laptop-Display' }[m[1]] ?? m[1]} ${m[2]}`
}

function renderScreens() {
  if (!config || !user.admin) return
  const ids = [...new Set([...screens.map((s) => s.id), ...(config.screens ?? []).map((s) => s.id)])]
  $('#screens-section').hidden = !ids.length
  $('#screens').innerHTML = ids
    .map((id) => {
      const saved = config.screens?.find((s) => s.id === id)
      const detected = screens.find((s) => s.id === id)
      return `<article class="card remote-card" data-screen="${esc(id)}">
        <div class="remote-card-head"><div><h3>${esc(saved?.name || connectorLabel(id))}</h3>
          <span class="muted">${detected?.connected ? 'Monitor angeschlossen' : 'kein Monitor'}</span></div></div>
        <div class="layout-buttons">
          ${config.outputs
            .map((o, i) => `<button class="layout-btn ${o.id === saved?.outputId ? 'active' : ''}" data-output="${i + 1}">${esc(o.name)}</button>`)
            .join('')}
          <button class="layout-btn off ${saved?.outputId ? '' : 'active'}" data-output="aus">Aus</button>
        </div>
      </article>`
    })
    .join('')
}

$('#screens').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-output]')
  const card = e.target.closest('[data-screen]')
  if (!btn || !card || btn.classList.contains('active')) return
  btn.classList.add('busy')
  const res = await fetch(`/api/screen/${encodeURIComponent(card.dataset.screen)}/output/${btn.dataset.output}`, { method: 'POST' }).catch(
    () => null,
  )
  btn.classList.remove('busy')
  if (!res?.ok) toast('Umschalten fehlgeschlagen')
})

// --- Bühnennachricht ------------------------------------------------------------

function renderMessage() {
  if (!config) return
  $('#message-section').hidden = !config.propresenter?.host
  $('#message-current').innerHTML = !propresenter.connected
    ? 'ProPresenter ist nicht verbunden.'
    : stage.message
      ? `Gerade auf der Bühne: <b>${esc(stage.message)}</b>`
      : 'Gerade keine Bühnennachricht.'
}

async function sendMessage(text) {
  const res = await fetch(text ? '/api/propresenter/stage-message' : '/api/propresenter/stage-message/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  }).catch(() => null)
  const data = await res?.json().catch(() => ({}))
  if (!res?.ok || !data?.ok) return toast(data?.error || 'Senden fehlgeschlagen')
  toast(text ? 'Nachricht gesendet' : 'Nachricht gelöscht')
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
