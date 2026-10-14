// Anmeldung: Name + Kesher-Rolle (ohne Passwort), Admin mit PIN.
// Unter /.jms-auth/ ist das die zentrale Anmeldung für die anderen Dienste (Kesher, Dashboard …):
// Dort kommt – wenn eingeschaltet – vorher einmal am Tag der Tagescode (QR-Code oder 6 Ziffern).
import { applyPrefs, currentPrefs } from './theme.js'

applyPrefs(currentPrefs())

const $ = (sel) => document.querySelector(sel)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// Auf der Adresse eines anderen Dienstes liegen Seite und Schnittstelle unter /.jms-auth
const gateway = location.pathname.startsWith('/.jms-auth/')
const api = (p) => (gateway ? `/.jms-auth${p}` : p)

const params = new URLSearchParams(location.search)
const isPhone = matchMedia('(max-width: 700px)').matches
// Nur eigene Seiten als Ziel, nie eine fremde Adresse
const nextParam = params.get('next') || ''
const fallback = gateway ? '/' : isPhone ? '/remote.html' : '/'
const next = nextParam.startsWith('/') && !nextParam.startsWith('//') && !nextParam.startsWith('/\\') ? nextParam : fallback
$('#qr-note').hidden = params.get('qr') !== 'abgelaufen'
$('#revoked-note').hidden = !params.has('abgemeldet')
if (gateway) {
  $('#brand-text').innerHTML = 'Technik<small>Anmeldung</small>'
  $('#login-lead').textContent = 'Name eingeben und deine Rolle wählen – das gilt dann für alle Dienste (Intercom, Multiview, Dashboard).'
}

function remembered(key) {
  try {
    return localStorage.getItem(`mv.login.${key}`) || ''
  } catch {
    return ''
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(`mv.login.${key}`, value)
  } catch {
    // egal
  }
}

const getJson = (path) =>
  fetch(api(path), { cache: 'no-store', credentials: 'same-origin' })
    .then((r) => r.json())
    .catch(() => null)

const postJson = async (path, body) => {
  const res = await fetch(api(path), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify(body),
  }).catch(() => null)
  return { res, data: (await res?.json().catch(() => ({}))) ?? {} }
}

main()

async function main() {
  if (gateway) {
    const device = await getJson('/api/device')
    if (device?.required && !device.approved) return showCodeStep()
  }
  showLoginStep()
}

// --- Schritt 1: Tagescode ----------------------------------------------------

function showCodeStep() {
  $('#login-step').hidden = true
  $('#code-form').hidden = false
  const reason = params.get('code')
  if (reason) {
    $('#code-note').textContent =
      reason === 'gesperrt'
        ? 'Zu viele falsche Versuche – bitte in 15 Minuten noch einmal.'
        : 'Der QR-Code ist nicht mehr gültig. Es gilt immer nur der Code von heute – lass dir den aktuellen zeigen.'
    $('#code-note').hidden = false
  }
  const input = $('#day-code')
  input.focus()
  // Nur Ziffern; mit der sechsten geht es von selbst weiter
  input.addEventListener('input', () => {
    input.value = input.value.replace(/\D/g, '').slice(0, 6)
    $('#code-error').textContent = ''
    if (input.value.length === 6) submitCode()
  })
  $('#code-form').addEventListener('submit', (e) => {
    e.preventDefault()
    submitCode()
  })
  async function submitCode() {
    if (input.value.length !== 6) {
      $('#code-error').textContent = 'Der Code hat 6 Ziffern.'
      return
    }
    const { res, data } = await postJson('/api/device', { code: input.value })
    if (!res?.ok || !data.ok) {
      $('#code-error').textContent = data.error || 'Server nicht erreichbar'
      input.select()
      return
    }
    $('#code-note').hidden = true
    stopScan()
    showLoginStep()
  }
  setupScanner((code) => {
    input.value = code
    submitCode()
  })
}

// --- QR-Code mit der Handy-Kamera scannen ------------------------------------------
// Erkennt den QR-Code von heute (…/.jms-auth/code?c=123456) oder 6 Ziffern. Nutzt den eingebauten
// BarcodeDetector (Android/Chrome), sonst jsQR (iPhone). Die Kamera geht nur über https.

let scanStream = null
let scanTimer = null

function stopScan() {
  clearTimeout(scanTimer)
  scanStream?.getTracks().forEach((t) => t.stop())
  scanStream = null
  const view = $('#scan-view')
  if (view) view.hidden = true
  const start = $('#scan-start')
  if (start) start.hidden = false
}

function codeFromText(text) {
  const value = String(text || '')
  try {
    const c = new URL(value, location.href).searchParams.get('c')
    if (/^\d{6}$/.test(c || '')) return c
  } catch {
    // kein Link
  }
  const m = /(?:^|\D)(\d{6})(?:\D|$)/.exec(value)
  return m ? m[1] : null
}

function loadJsQr() {
  if (window.jsQR) return Promise.resolve(window.jsQR)
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'vendor/jsQR.js'
    script.onload = () => resolve(window.jsQR)
    script.onerror = reject
    document.head.append(script)
  })
}

function setupScanner(onCode) {
  const start = $('#scan-start')
  if (!start) return
  const supported = Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext
  if (!supported) {
    // z. B. http-Adresse: Kamera im Browser nicht erlaubt – die Kamera-App des Handys geht trotzdem
    start.hidden = true
    return
  }
  $('#scan-stop').addEventListener('click', stopScan)
  start.addEventListener('click', async () => {
    const hint = $('#scan-hint')
    $('#code-error').textContent = ''
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
    } catch {
      $('#code-error').textContent = 'Kamera nicht erlaubt – bitte den Zugriff erlauben oder den Code eintippen.'
      return
    }
    const video = $('#scan-video')
    video.srcObject = scanStream
    await video.play().catch(() => {})
    start.hidden = true
    $('#scan-view').hidden = false

    let detect
    if ('BarcodeDetector' in window) {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] })
      detect = async () => (await detector.detect(video))[0]?.rawValue
    } else {
      const jsQR = await loadJsQr().catch(() => null)
      if (!jsQR) {
        hint.textContent = 'Scannen geht hier nicht – bitte den Code eintippen.'
        return
      }
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      detect = async () => {
        const w = video.videoWidth
        const h = video.videoHeight
        if (!w || !h) return null
        const scale = Math.min(1, 640 / Math.max(w, h))
        canvas.width = Math.round(w * scale)
        canvas.height = Math.round(h * scale)
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        return jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })?.data
      }
    }
    const tick = async () => {
      if (!scanStream) return
      const text = await detect().catch(() => null)
      const code = text && codeFromText(text)
      if (code) {
        navigator.vibrate?.(30)
        hint.textContent = `Code ${code.slice(0, 3)} ${code.slice(3)} erkannt …`
        stopScan()
        onCode(code)
        return
      }
      if (text) hint.textContent = 'Das ist nicht der QR-Code von heute.'
      scanTimer = setTimeout(tick, 250)
    }
    tick()
  })
}

// --- Schritt 2: Name und Rolle -----------------------------------------------

async function showLoginStep() {
  $('#code-form').hidden = true
  const { enabled, roles = [], occupied = {} } = (await getJson('/api/login/roles')) ?? { enabled: true, roles: [] }
  if (!enabled) return location.replace(next) // Zugang offen: keine Anmeldung nötig

  // Schon angemeldet: auf einem anderen Dienst direkt weiter, sonst zeigen, als wer
  const me = await getJson('/api/me')
  if (me?.user && !me.user.open) {
    if (gateway && !params.has('wechseln')) return location.replace(next)
    $('#current-text').textContent = `Angemeldet als ${me.user.name} (${me.user.roleName}). Hier wechselst du zu einem anderen Konto oder einer anderen Rolle.`
    $('#current-back').href = next
    $('#current-note').hidden = false
  }
  $('#login-step').hidden = false

  const lastRole = remembered('role')
  $('#role').innerHTML = [
    `<option value="" disabled ${lastRole ? '' : 'selected'}>Rolle wählen …</option>`,
    // Belegte Rollen markieren – eine Rolle kann nur einmal angemeldet sein (wie bei Kesher)
    ...roles.map(
      (r) =>
        `<option value="${esc(r.id)}" ${r.id === lastRole ? 'selected' : ''}>${esc(r.name)}${occupied[r.id] ? ` – angemeldet: ${esc(occupied[r.id])}` : ''}</option>`,
    ),
    `<option value="admin" ${lastRole === 'admin' ? 'selected' : ''}>Admin (mit PIN)</option>`,
  ].join('')
  if (!roles.length) $('#error').textContent = 'Kesher ist gerade nicht erreichbar – nur die Admin-Anmeldung geht.'
  $('#name').value = remembered('name')

  function syncPin() {
    const admin = $('#role').value === 'admin'
    $('#pin-field').hidden = !admin
    $('#pin').required = admin
  }
  syncPin()
  $('#role').addEventListener('change', syncPin)
  ;($('#name').value ? $('#role') : $('#name')).focus()

  $('#role').addEventListener('change', () => ($('#takeover').hidden = true))
  $('#takeover-btn').addEventListener('click', () => submit(true))
  $('#login-form').addEventListener('submit', (e) => {
    e.preventDefault()
    submit(false)
  })

  async function submit(takeover) {
    const body = { name: $('#name').value.trim(), roleId: $('#role').value, pin: $('#pin').value, takeover }
    $('#error').textContent = ''
    $('#takeover').hidden = true
    const { res, data } = await postJson('/api/login', body)
    if (res?.status === 409 && data?.holder) {
      // Rolle schon angemeldet: wie bei Kesher übernehmen lassen
      const role = $('#role').selectedOptions[0]?.textContent.replace(/ – angemeldet:.*$/, '')
      $('#takeover-text').textContent = `${role} ist schon angemeldet – von ${data.holder.name}. Übernehmen meldet das andere Gerät ab.`
      $('#takeover').hidden = false
      return
    }
    if (!res?.ok || !data?.ok) {
      $('#error').textContent = data?.error || 'Server nicht erreichbar'
      if (body.roleId === 'admin') $('#pin').select()
      return
    }
    remember('name', body.name)
    remember('role', body.roleId)
    location.replace(next)
  }
}
