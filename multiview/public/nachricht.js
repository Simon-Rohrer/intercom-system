// Nachrichten-Link für Ordner und Helfer: ohne Anmeldung eine Meldung auf den Beamer (vorbereitet,
// angezeigt vom ProPresenter-Bediener) oder das Stage Display schicken. Der Link kommt als
// /nachricht.html?k=<Token> (QR vom Admin). Das Token merkt sich das Handy und nimmt es aus der
// Adresszeile, damit es nicht in Verlauf oder Screenshots landet.

const $ = (sel) => document.querySelector(sel)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const QUICK_STAGE = ['Noch 5 Minuten', 'Noch 2 Minuten', 'Bitte zum Ende kommen', 'Lauter sprechen', 'Mikrofon näher an den Mund']
const STATUS = { wartet: 'Wartet auf Freigabe', angezeigt: 'Auf dem Beamer', beendet: 'Beendet' }

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key)
    localStorage.setItem(key, value)
  } catch {
    return null
  }
}

const params = new URLSearchParams(location.search)
const token = params.get('k') || store('jms.msg.token') || ''
if (params.get('k')) {
  store('jms.msg.token', params.get('k'))
  history.replaceState(null, '', location.pathname)
}

let info = null
let target = store('jms.msg.target') || 'beamer'
let openTemplate = null
let templatesKey = ''

$('#from').value = store('jms.msg.from') || ''
$('#from').addEventListener('change', () => store('jms.msg.from', $('#from').value.trim()))
$('#stage-quick').innerHTML = QUICK_STAGE.map((t) => `<button type="button" class="btn" data-quick="${esc(t)}">${esc(t)}</button>`).join('')

function invalid(text) {
  $('#main').hidden = true
  $('#invalid').hidden = false
  if (text) $('#invalid-text').textContent = text
}

async function load() {
  if (!token) return invalid('Bitte den QR-Code vom Technik-Team scannen.')
  const res = await fetch(`/api/nachricht/${encodeURIComponent(token)}`, { cache: 'no-store' }).catch(() => null)
  if (!res) return
  const data = await res.json().catch(() => null)
  if (!res.ok || !data?.ok) return invalid(data?.error)
  info = data
  render()
}

function render() {
  $('#invalid').hidden = true
  $('#main').hidden = false
  $('#link-name').textContent = info.name
  if (!info[target]) target = info.beamer ? 'beamer' : 'stage'
  $('#targets').hidden = !(info.beamer && info.stage)
  for (const b of $('#targets').querySelectorAll('button')) {
    b.classList.toggle('active', b.dataset.target === target)
    b.setAttribute('aria-selected', b.dataset.target === target)
  }
  $('#panel-beamer').hidden = target !== 'beamer'
  $('#panel-stage').hidden = target !== 'stage'
  $('#offline').hidden = info.connected

  $('#stage-current').hidden = !info.stageMessage
  $('#stage-text').textContent = info.stageMessage
  $('#stage-clear').hidden = !info.ownStage

  $('#requests').innerHTML = info.requests
    .map(
      (r) => `<div class="msg-request ${esc(r.status)}"><span>${esc(STATUS[r.status] ?? r.status)}</span><b>${esc(r.text)}</b></div>`,
    )
    .join('')

  // Vorlagen nur neu aufbauen, wenn sie sich ändern – sonst gingen Eingaben verloren
  const key = JSON.stringify([info.templates, openTemplate])
  if (key === templatesKey) return
  templatesKey = key
  const card = (id, name, preview, fields) => {
    const open = openTemplate === id
    return `<div class="msg-template ${open ? 'open' : ''}" data-template="${esc(id)}">
      <button type="button" class="msg-template-head" data-toggle><b>${esc(name)}</b><span class="muted">${esc(preview)}</span></button>
      ${
        open
          ? `<form class="msg-form" data-send>
              ${fields.map((f) => `<label class="field"><span>${esc(f)}</span><input type="text" name="${esc(f)}" maxlength="300" autocomplete="off" required></label>`).join('')}
              <button type="submit" class="btn primary block">An die Technik schicken</button>
            </form>`
          : ''
      }
    </div>`
  }
  $('#templates').innerHTML = [card('', 'Eigene Meldung', 'Freier Text', ['Text']), ...info.templates.map((t) => card(t.uuid, t.name, t.text, t.fields))].join('')
  $('#templates .msg-template.open input')?.focus()
}

function say(text, ok) {
  $('#error').textContent = ok ? '' : text
  $('#ok').hidden = !ok
  $('#ok').textContent = ok ? text : ''
  if (ok) setTimeout(() => ($('#ok').hidden = true), 5000)
}

async function send(body, button) {
  const from = $('#from').value.trim()
  if (!from) {
    say('Bitte zuerst deinen Namen eingeben')
    $('#from').focus()
    return false
  }
  store('jms.msg.from', from)
  if (button) button.disabled = true
  const res = await fetch(`/api/nachricht/${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, from }),
  }).catch(() => null)
  const data = await res?.json().catch(() => null)
  if (button) button.disabled = false
  if (res?.status === 404) return invalid(data?.error), false
  if (!res?.ok || !data?.ok) return say(data?.error || 'Senden fehlgeschlagen – bitte nochmal'), false
  navigator.vibrate?.(15)
  await load()
  return true
}

$('#targets').addEventListener('click', (e) => {
  const b = e.target.closest('[data-target]')
  if (!b) return
  target = b.dataset.target
  store('jms.msg.target', target)
  say('')
  render()
})

$('#templates').addEventListener('click', (e) => {
  const head = e.target.closest('[data-toggle]')
  if (!head) return
  const id = head.closest('[data-template]').dataset.template
  openTemplate = openTemplate === id ? null : id
  render()
})

$('#templates').addEventListener('submit', async (e) => {
  e.preventDefault()
  const form = e.target.closest('[data-send]')
  const id = form.closest('[data-template]').dataset.template
  const values = Object.fromEntries(new FormData(form))
  const body = id ? { target: 'beamer', uuid: id, fields: values } : { target: 'beamer', text: values.Text }
  if (await send(body, form.querySelector('button'))) {
    openTemplate = null
    templatesKey = ''
    render()
    say('Geschickt – die Technik zeigt die Meldung gleich an.', true)
  }
})

$('#stage-quick').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-quick]')
  if (b && (await send({ target: 'stage', text: b.dataset.quick }, b))) say('Steht jetzt auf dem Stage Display.', true)
})

$('#stage-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('#stage-input').value.trim()
  if (!text) return say('Bitte einen Text eingeben')
  if (await send({ target: 'stage', text }, e.submitter)) {
    $('#stage-input').value = ''
    say('Steht jetzt auf dem Stage Display.', true)
  }
})

$('#stage-clear').addEventListener('click', async (e) => {
  if (await send({ target: 'stage', text: '' }, e.currentTarget)) say('Gelöscht.', true)
})

load()
// Stand (Freigabe, Stage Display) regelmäßig nachladen, solange die Seite sichtbar ist
setInterval(() => document.visibilityState === 'visible' && !document.activeElement?.matches('input, textarea') && load(), 5000)
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load())
