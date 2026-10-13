// Anmeldung: Name + Kesher-Rolle (ohne Passwort), Admin mit PIN.
import { applyPrefs, currentPrefs } from './theme.js'

applyPrefs(currentPrefs())

const $ = (sel) => document.querySelector(sel)
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const params = new URLSearchParams(location.search)
const isPhone = matchMedia('(max-width: 700px)').matches
// Nur eigene Seiten als Ziel, nie eine fremde Adresse
const nextParam = params.get('next') || ''
const next = nextParam.startsWith('/') && !nextParam.startsWith('//') ? nextParam : isPhone ? '/remote.html' : '/'
$('#qr-note').hidden = params.get('qr') !== 'abgelaufen'
$('#revoked-note').hidden = !params.has('abgemeldet')

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

main()

async function main() {
  const { enabled, roles, occupied = {} } = await fetch('/api/login/roles', { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => ({ enabled: true, roles: [] }))
  if (!enabled) return location.replace(next) // Zugang offen: keine Anmeldung nötig

  // Schon angemeldet (z. B. über „Konto wechseln“): zeigen, als wer – neue Anmeldung ersetzt sie
  const me = await fetch('/api/me', { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => null)
  if (me?.user && !me.user.open) {
    $('#current-text').textContent = `Angemeldet als ${me.user.name} (${me.user.roleName}). Hier wechselst du zu einem anderen Konto oder einer anderen Rolle.`
    $('#current-back').href = next
    $('#current-note').hidden = false
  }

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
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => null)
    const data = await res?.json().catch(() => ({}))
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
