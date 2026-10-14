'use strict'

// Rollen anlegen, umbenennen und löschen – im Multiview unter „Benutzer & Rechte“.
// Gespeichert werden sie weiter in Kesher (dort hängen Party Lines und Stream Deck daran), darum
// öffnet der Server dafür kurz eine Kesher-Admin-Sitzung: mit einem signierten Ticket der
// zentralen Anmeldung (JMS_AUTH_SECRET), ohne PIN.

/** Rollen-ID aus dem Namen: „Licht 2“ → „licht-2“, schon vergeben → „licht-2-2“. */
function roleIdFromName(name, taken = new Set()) {
  const base =
    String(name)
      .toLowerCase()
      .replace(/ä/g, 'ae')
      .replace(/ö/g, 'oe')
      .replace(/ü/g, 'ue')
      .replace(/ß/g, 'ss')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'rolle'
  let id = base
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
  return id
}

const fail = (status, message) => Object.assign(new Error(message), { status })

function createKesherRoles({ getUrl, getTicket, fetchImpl = fetch }) {
  /** Kurze Kesher-Admin-Sitzung: work(call) bekommt eine Funktion für Anfragen an Kesher. */
  async function asAdmin(work) {
    const url = getUrl()
    if (!url) throw fail(503, 'Kesher-Adresse fehlt (Einstellungen → Kesher-Chat)')
    const ticket = getTicket()
    let res
    try {
      res = await fetchImpl(`${url}/api/admin/login/central`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      throw fail(502, 'Kesher ist nicht erreichbar')
    }
    if (res.status === 503) throw fail(503, 'In Kesher ist JMS_AUTH_SECRET nicht eingerichtet')
    if (res.status === 403) throw fail(502, 'Kesher lehnt die Anmeldung ab – ist JMS_AUTH_SECRET in Kesher und Multiview gleich?')
    if (res.status === 404) throw fail(502, 'Kesher kennt die zentrale Anmeldung noch nicht – Kesher muss aktualisiert werden')
    if (!res.ok) throw fail(502, `Kesher: HTTP ${res.status}`)
    const token = (await res.json().catch(() => ({})))?.token
    if (!token) throw fail(502, 'Kesher hat keine Admin-Sitzung geöffnet')

    const call = async (method, path, body) => {
      try {
        return await fetchImpl(`${url}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(5000),
        })
      } catch {
        throw fail(502, 'Kesher ist nicht erreichbar')
      }
    }
    try {
      return await work(call)
    } finally {
      fetchImpl(`${url}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3000),
      }).catch(() => {})
    }
  }

  async function bootstrap(call) {
    const res = await call('GET', '/api/bootstrap')
    if (!res.ok) throw fail(502, `Kesher: Rollen nicht lesbar (HTTP ${res.status})`)
    const data = await res.json()
    return { roles: data.roles ?? [], users: data.users ?? [] }
  }

  async function check(res, what) {
    if (res.ok) return
    const text = (await res.text().catch(() => '')).trim()
    if (res.status === 409) throw fail(409, `${what}: Eine Rolle mit diesem Namen gibt es in Kesher schon`)
    if (res.status === 404) throw fail(404, `${what}: Die Rolle gibt es in Kesher nicht mehr`)
    throw fail(502, `${what}: Kesher meldet ${text || `HTTP ${res.status}`}`)
  }

  const cleanName = (name) => {
    const clean = String(name ?? '').trim().slice(0, 60)
    if (!clean) throw fail(400, 'Bitte einen Namen eingeben')
    return clean
  }

  const sameName = (roles, name, exceptId = null) =>
    roles.find((r) => r.id !== exceptId && String(r.name).trim().toLowerCase() === name.toLowerCase())

  /**
   * Neue Rolle. copyFrom: Kesher kopiert die Rechte dieser Rolle (Party Lines, Stream Deck,
   * Standardwerte) – sonst ist die Rolle leer.
   */
  async function create({ name, copyFrom = '' }) {
    name = cleanName(name)
    return asAdmin(async (call) => {
      const { roles } = await bootstrap(call)
      if (sameName(roles, name)) throw fail(409, `„${name}“ gibt es schon`)
      const id = roleIdFromName(name, new Set(roles.map((r) => r.id)))
      if (copyFrom) {
        const source = roles.find((r) => r.id === copyFrom)
        if (!source) throw fail(404, 'Die Vorlage-Rolle gibt es in Kesher nicht mehr')
        const res = await call('POST', `/api/admin/roles/${encodeURIComponent(copyFrom)}/duplicate`, {
          id,
          name,
          defaultRoomId: source.defaultRoomId || '',
          defaultVoiceMode: source.defaultVoiceMode || '',
          defaultSimpleView: Boolean(source.defaultSimpleView),
        })
        await check(res, 'Anlegen')
      } else {
        await check(await call('POST', '/api/admin/roles', { id, name }), 'Anlegen')
      }
      return { id, name }
    })
  }

  /** Nur der Name ändert sich – die ID (und damit alle Rechte) bleibt. */
  async function rename(id, name) {
    name = cleanName(name)
    return asAdmin(async (call) => {
      const { roles } = await bootstrap(call)
      const role = roles.find((r) => r.id === id)
      if (!role) throw fail(404, 'Die Rolle gibt es in Kesher nicht mehr')
      if (sameName(roles, name, id)) throw fail(409, `„${name}“ gibt es schon`)
      // Kesher überschreibt beim Speichern auch die Standardwerte – darum die bisherigen mitschicken
      const res = await call('PUT', `/api/admin/roles/${encodeURIComponent(id)}`, {
        name,
        defaultRoomId: role.defaultRoomId || '',
        defaultVoiceMode: role.defaultVoiceMode || '',
        defaultSimpleView: Boolean(role.defaultSimpleView),
      })
      await check(res, 'Umbenennen')
      return { id, name }
    })
  }

  /**
   * Rolle löschen. Kesher löscht eine Rolle nur ohne Benutzer – die Einträge der Personen, die sich
   * mit ihr angemeldet hatten, gehen darum vorher mit (nicht, solange jemand verbunden ist).
   */
  async function remove(id) {
    return asAdmin(async (call) => {
      const { roles, users } = await bootstrap(call)
      if (!roles.some((r) => r.id === id)) return { id, gone: true }
      for (const u of users.filter((x) => x.roleId === id)) {
        const res = await call('DELETE', `/api/admin/users/${encodeURIComponent(u.id)}`)
        if (res.status === 409) throw fail(409, `„${u.username}“ ist gerade in Kesher mit dieser Rolle verbunden – erst dort abmelden`)
        if (res.status !== 404) await check(res, 'Löschen')
      }
      await check(await call('DELETE', `/api/admin/roles/${encodeURIComponent(id)}`), 'Löschen')
      return { id }
    })
  }

  return { create, rename, remove }
}

module.exports = { createKesherRoles, roleIdFromName }
