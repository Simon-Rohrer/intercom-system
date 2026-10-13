// Chat schreiben – als die angemeldete Rolle. Ziel ist „Global“ oder eine Party Line, auf der
// die Rolle in Kesher sprechen darf (Kesher prüft das noch einmal). Der Admin hat keine
// Kesher-Rolle und wählt deshalb, als welche Rolle er schreibt.
// Gemeinsam für die Chat-Kachel am Monitor und die Handy-Fernbedienung.

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function readPref(key) {
  try {
    return localStorage.getItem(`mv.chat.${key}`) || ''
  } catch {
    return ''
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(`mv.chat.${key}`, value)
  } catch {
    // privater Modus
  }
}

/** user: angemeldeter Nutzer aus /api/me ({ name, roleId, roleName, admin }). */
export function createComposer(user) {
  const form = el('form', 'chat-compose')
  form.autocomplete = 'off'
  const roleSelect = el('select', 'chat-compose-role')
  roleSelect.title = 'Als Rolle schreiben'
  roleSelect.hidden = !user.admin
  const target = el('select', 'chat-compose-target')
  target.title = 'An'
  const input = el('input', 'chat-compose-input')
  input.type = 'text'
  input.maxLength = 500
  input.placeholder = user.admin ? 'Nachricht …' : `Nachricht als ${user.roleName} …`
  input.enterKeyHint = 'send'
  const send = el('button', 'chat-compose-send', 'Senden')
  send.type = 'submit'
  const status = el('div', 'chat-compose-status')
  form.append(roleSelect, target, input, send, status)

  let chat = { roles: [], rooms: [] }
  let busy = false
  let lastKey = ''

  const roleId = () => (user.admin ? roleSelect.value : user.roleId)

  function fillTargets() {
    const role = roleId()
    const wanted = target.value || readPref(`target.${role}`)
    const rooms = (chat.rooms ?? []).filter((r) => r.talkers?.includes(role))
    target.replaceChildren(
      Object.assign(el('option', null, 'Global'), { value: '' }),
      ...rooms.map((r) => Object.assign(el('option', null, r.name), { value: r.id })),
    )
    target.value = rooms.some((r) => r.id === wanted) ? wanted : ''
  }

  function fillRoles() {
    if (!user.admin) return
    const wanted = roleSelect.value || readPref('adminRole')
    roleSelect.replaceChildren(
      Object.assign(el('option', null, 'Als Rolle …'), { value: '', disabled: true }),
      ...(chat.roles ?? []).map((r) => Object.assign(el('option', null, r.name), { value: r.id })),
    )
    roleSelect.value = (chat.roles ?? []).some((r) => r.id === wanted) ? wanted : ''
  }

  function showStatus(text, kind = '') {
    status.textContent = text
    status.className = `chat-compose-status ${kind}`
    clearTimeout(showStatus.timer)
    if (text && kind !== 'error') showStatus.timer = setTimeout(() => (status.textContent = ''), 2500)
  }

  roleSelect.addEventListener('change', () => {
    writePref('adminRole', roleSelect.value)
    fillTargets()
  })
  target.addEventListener('change', () => writePref(`target.${roleId()}`, target.value))

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    const text = input.value.trim()
    if (!text || busy) return
    if (!roleId()) return showStatus('Bitte zuerst wählen, als welche Rolle du schreibst', 'error')
    busy = true
    form.classList.add('busy')
    const res = await fetch('/api/chat/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, roomId: target.value, roleId: roleId() }),
    }).catch(() => null)
    const data = await res?.json().catch(() => ({}))
    busy = false
    form.classList.remove('busy')
    if (res?.status === 401) return location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search)}`)
    if (!res?.ok || !data?.ok) return showStatus(data?.error || 'Senden fehlgeschlagen', 'error')
    input.value = ''
    showStatus('Gesendet ✓', 'ok')
  })

  return {
    el: form,
    input,
    /** Rollen und Party Lines aus dem Chat-Zustand des Servers übernehmen. */
    update(next) {
      chat = next || chat
      const key = JSON.stringify([chat.roles, chat.rooms])
      if (key !== lastKey) {
        lastKey = key
        fillRoles()
        fillTargets()
      }
      form.classList.toggle('offline', chat.state !== 'connected')
    },
  }
}
