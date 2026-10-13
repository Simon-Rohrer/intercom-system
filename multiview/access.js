'use strict'

// Benutzer und Rechte – angelehnt an Kesher: Man meldet sich mit Namen und einer Kesher-Rolle
// an (ohne Passwort). Was eine Rolle darf, steht in config.access.roles. Nur der Admin hat eine
// PIN – entweder dieselbe wie im Kesher-Admin (wird dann bei Kesher geprüft, hier nicht
// gespeichert) oder eine eigene. Solange keine Admin-PIN eingerichtet ist, ist der Zugang offen
// (alle dürfen alles), damit beim Einschalten niemand ausgesperrt wird.
//
// Geheimes (PIN-Hash, Sitzungen) liegt in data/access-secret.json, nicht in config.json –
// die Konfiguration ist für die Monitor-Seiten ohne Anmeldung lesbar.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const COOKIE = 'mv_session'
const SESSION_DAYS = 30
const QR_TTL_MS = 10 * 60 * 1000
// Eine Rolle gilt als belegt, solange eine Seite von ihr offen ist (WebSocket) oder sie so
// kurz zuvor noch etwas abgefragt hat
const ACTIVE_MS = 2 * 60 * 1000
const ADMIN = 'admin'

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')
const randomToken = () => crypto.randomBytes(24).toString('base64url')

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 32).toString('hex') }
}

function pinMatches(pin, stored) {
  if (!stored?.salt || !stored?.hash) return false
  const { hash } = hashPin(pin, stored.salt)
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(stored.hash, 'hex'))
}

function parseCookies(header) {
  const out = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

/**
 * Rechte einer Rolle aus config.access (fehlende Rolle = darf nichts).
 * outputs: Multiviews, die die Rolle sieht. edit: davon die, die sie auch bearbeiten darf
 * (Layout umschalten und das laufende Layout ändern). editLayouts: eigene neue Layouts anlegen.
 * Ältere Einstellungen ohne „edit“: alles Freigegebene war bearbeitbar – so bleibt es.
 */
function normalizeRole(r) {
  const ids = (list) => (Array.isArray(list) ? list.filter((id) => typeof id === 'string') : [])
  const outputs = ids(r?.outputs)
  const edit = Array.isArray(r?.edit) ? ids(r.edit).filter((id) => outputs.includes(id)) : [...outputs]
  return { outputs, edit, editLayouts: r?.editLayouts !== false }
}

function normalizeAccess(a) {
  const roles = {}
  for (const [id, r] of Object.entries(a?.roles ?? {})) if (id && id !== ADMIN) roles[id] = normalizeRole(r)
  return { roles }
}

function createAccess({ dataDir, log = console.log, verifyKesherPin = async () => false, isLive = () => false, onRevoke = () => {} }) {
  const file = path.join(dataDir, 'access-secret.json')
  // { adminPin: { salt, hash } | { kesher: true }, sessions: { sha256(token): session } }
  let secret = read()
  const qrTokens = new Map() // sha256(token) -> { session, expires }
  let writeTimer = null

  function read() {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'))
      return { adminPin: s.adminPin ?? null, sessions: s.sessions ?? {} }
    } catch {
      return { adminPin: null, sessions: {} }
    }
  }

  function write() {
    clearTimeout(writeTimer)
    writeTimer = null
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(secret, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  /** "Zuletzt gesehen" nicht bei jeder Anfrage auf die Platte schreiben. */
  function writeSoon() {
    writeTimer ??= setTimeout(write, 30_000)
  }

  const enabled = () => Boolean(secret.adminPin)
  const pinSource = () => (!secret.adminPin ? null : secret.adminPin.kesher ? 'kesher' : 'own')

  /** Stimmt die Admin-PIN? Bei der Kesher-PIN fragt der Server Kesher. */
  async function checkPin(pin) {
    if (secret.adminPin?.kesher) return verifyKesherPin(pin)
    return pinMatches(pin, secret.adminPin)
  }

  function prune() {
    const cutoff = Date.now() - SESSION_DAYS * 86400_000
    for (const [key, s] of Object.entries(secret.sessions)) if ((s.seen ?? s.created) < cutoff) delete secret.sessions[key]
    for (const [key, t] of qrTokens) if (t.expires < Date.now()) qrTokens.delete(key)
  }

  /** group: Anmeldungen derselben Person (Rechner + per QR-Code angemeldetes Handy). */
  function newSession({ name, roleId, admin, group }) {
    prune()
    const token = randomToken()
    const id = crypto.randomBytes(6).toString('hex')
    secret.sessions[sha256(token)] = {
      id,
      group: group || id,
      name,
      roleId: admin ? ADMIN : roleId,
      admin: Boolean(admin),
      created: Date.now(),
      seen: Date.now(),
    }
    write()
    return token
  }

  function cookieFor(token, req) {
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : ''
    return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`
  }

  /** Sitzung zur Anfrage (oder null). */
  function sessionOf(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    if (!token) return null
    const s = secret.sessions[sha256(token)]
    if (!s) return null
    if (Date.now() - (s.seen ?? 0) > 60_000) {
      s.seen = Date.now()
      writeSoon()
    }
    return s
  }

  /**
   * Wer fragt an: { admin, roleId, name, open }.
   * open = Zugang noch nicht eingeschaltet → alle sind Admin.
   */
  function userOf(req) {
    if (!enabled()) return { admin: true, open: true, name: '', roleId: ADMIN }
    const s = sessionOf(req)
    return s ? { admin: s.admin, open: false, name: s.name, roleId: s.roleId, sessionId: s.id, group: s.group ?? s.id } : null
  }

  /** Sitzungs-ID zur Anfrage (für die WebSocket-Verbindungen), ohne "zuletzt gesehen" zu ändern. */
  function sessionIdOf(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    return (token && secret.sessions[sha256(token)]?.id) || null
  }

  const isActive = (s) => isLive(s.id) || Date.now() - (s.seen ?? 0) < ACTIVE_MS

  /** Wer hat die Rolle gerade (andere Personen als group)? */
  function holdersOf(roleId, group = null) {
    return Object.values(secret.sessions).filter((s) => s.roleId === roleId && !s.admin && (s.group ?? s.id) !== group)
  }

  /** Belegte Rollen für die Anmeldeseite: { roleId: Name } */
  function occupiedRoles() {
    const out = {}
    for (const s of Object.values(secret.sessions)) if (!s.admin && isActive(s)) out[s.roleId] = s.name
    return out
  }

  function endSessions(list, why) {
    if (!list.length) return
    const ids = list.map((s) => s.id)
    for (const [key, s] of Object.entries(secret.sessions)) if (ids.includes(s.id)) delete secret.sessions[key]
    write()
    onRevoke(ids, why)
  }

  async function login({ name, roleId, pin, takeover }, req, res, { pinChecked = false } = {}) {
    const cleanName = String(name || '').trim().slice(0, 60)
    if (!cleanName) throw Object.assign(new Error('Bitte einen Namen eingeben'), { status: 400 })
    const admin = roleId === ADMIN
    if (admin) {
      if (!enabled()) throw Object.assign(new Error('Es ist noch keine Admin-PIN festgelegt'), { status: 400 })
      if (!pinChecked && !(await checkPin(pin))) throw Object.assign(new Error('PIN falsch'), { status: 403 })
    } else if (!roleId) throw Object.assign(new Error('Bitte eine Rolle wählen'), { status: 400 })

    // Eine Rolle nur einmal: wie bei Kesher ablehnen oder (auf Wunsch) übernehmen
    const own = parseCookies(req.headers.cookie)[COOKIE]
    if (own) delete secret.sessions[sha256(own)] // eigene alte Anmeldung in diesem Browser
    if (!admin) {
      const holders = holdersOf(roleId)
      const active = holders.filter(isActive)
      if (active.length && !takeover) {
        const who = active.sort((a, b) => b.seen - a.seen)[0]
        throw Object.assign(new Error(`Die Rolle ist schon angemeldet – von ${who.name}.`), {
          status: 409,
          holder: { name: who.name, seen: who.seen },
        })
      }
      // Übernehmen bzw. alte, nicht mehr aktive Anmeldungen derselben Rolle aufräumen
      endSessions(holders, active.length ? `übernommen von ${cleanName}` : 'abgelaufen')
      if (active.length) log(`Zugang: ${cleanName} übernimmt die Rolle ${roleId} von ${active.map((s) => s.name).join(', ')}`)
    }
    const token = newSession({ name: cleanName, roleId, admin })
    res.setHeader('Set-Cookie', cookieFor(token, req))
    log(`Zugang: ${cleanName} angemeldet als ${admin ? 'Admin' : roleId}`)
  }

  function logout(req, res) {
    const token = parseCookies(req.headers.cookie)[COOKIE]
    if (token) delete secret.sessions[sha256(token)]
    write()
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`)
  }

  /**
   * Admin-PIN einrichten, ändern oder entfernen.
   * source 'kesher': dieselbe PIN wie im Kesher-Admin (wird bei Kesher geprüft, nicht gespeichert).
   * source 'own': eigene PIN (4–12 Ziffern). off: Zugang wieder öffnen.
   */
  async function setAdminPin({ pin, currentPin, source, off }, user) {
    if (enabled() && !(await checkPin(currentPin)))
      throw Object.assign(new Error('Bisherige PIN falsch'), { status: 403 })
    const value = String(pin ?? '').trim()
    if (off) {
      secret.adminPin = null
      secret.sessions = {}
      log('Zugang: Anmeldung ausgeschaltet – Zugang ist offen')
    } else if (source === 'kesher') {
      if (!(await verifyKesherPin(value))) throw Object.assign(new Error('Das ist nicht die Admin-PIN von Kesher'), { status: 403 })
      secret.adminPin = { kesher: true }
      log('Zugang: Admin-PIN = Kesher-Admin-PIN – Anmeldung ist eingeschaltet')
    } else {
      if (!/^\d{4,12}$/.test(value)) throw Object.assign(new Error('Die PIN braucht 4 bis 12 Ziffern'), { status: 400 })
      secret.adminPin = hashPin(value)
      log(`Zugang: eigene Admin-PIN ${user?.open ? 'festgelegt – Anmeldung ist eingeschaltet' : 'geändert'}`)
    }
    write()
  }

  /** Einmal-Link fürs Handy: meldet das Handy als derselbe Nutzer an. */
  function createQrToken(user) {
    prune()
    const token = randomToken()
    qrTokens.set(sha256(token), {
      user: { name: user.name || 'Handy', roleId: user.roleId, admin: user.admin, group: user.group },
      expires: Date.now() + QR_TTL_MS,
    })
    return { token, expiresInMs: QR_TTL_MS }
  }

  function redeemQrToken(token, req, res) {
    const key = sha256(String(token || ''))
    const entry = qrTokens.get(key)
    qrTokens.delete(key)
    if (!entry || entry.expires < Date.now()) return false
    if (!enabled()) return true // offen: keine Anmeldung nötig
    const session = newSession(entry.user)
    res.setHeader('Set-Cookie', cookieFor(session, req))
    log(`Zugang: ${entry.user.name} per QR-Code am Handy angemeldet`)
    return true
  }

  function sessions() {
    return Object.values(secret.sessions)
      .map(({ id, name, roleId, admin, created, seen }) => ({ id, name, roleId, admin, created, seen, live: isLive(id) }))
      .sort((a, b) => b.seen - a.seen)
  }

  function endSession(id) {
    endSessions(Object.values(secret.sessions).filter((s) => s.id === id), 'vom Admin abgemeldet')
  }

  return { enabled, pinSource, userOf, sessionIdOf, occupiedRoles, login, logout, setAdminPin, createQrToken, redeemQrToken, sessions, endSession, flush: write }
}

// ---------------------------------------------------------------------------
// Rechte auf Layouts und Multiviews
// ---------------------------------------------------------------------------

function roleRights(config, user) {
  if (!user) return null
  if (user.admin) return { admin: true }
  return { admin: false, ...normalizeRole(config.access?.roles?.[user.roleId]) }
}

/** Multiviews, die der Nutzer sehen darf. */
function allowedOutputs(config, user) {
  const rights = roleRights(config, user)
  if (!rights) return new Set()
  if (rights.admin) return new Set(config.outputs.map((o) => o.id))
  return new Set(rights.outputs.filter((id) => config.outputs.some((o) => o.id === id)))
}

/** Multiviews, die der Nutzer bearbeiten darf (Layout umschalten, laufendes Layout ändern). */
function editableOutputs(config, user) {
  const rights = roleRights(config, user)
  if (!rights) return new Set()
  if (rights.admin) return new Set(config.outputs.map((o) => o.id))
  return new Set(rights.edit.filter((id) => config.outputs.some((o) => o.id === id)))
}

/**
 * Darf der Nutzer dieses Layout bearbeiten? Eigene Layouts der Rolle immer; sonst das Layout,
 * das gerade auf einem Multiview läuft, den der Admin der Rolle zum Bearbeiten freigegeben hat.
 * Freigegebene Layouts des Admins („für alle“) nur benutzen.
 */
function canEditLayout(config, user, layout) {
  const rights = roleRights(config, user)
  if (!rights || !layout) return false
  if (rights.admin) return true
  if (layout.shared) return false
  if (layout.owner === user.roleId) return true
  const edit = editableOutputs(config, user)
  return config.outputs.some((o) => edit.has(o.id) && o.layoutId === layout.id)
}

/** Layouts, die der Nutzer sieht (und auf seine Multiviews schalten darf). */
function visibleLayouts(config, user) {
  const rights = roleRights(config, user)
  if (!rights) return []
  if (rights.admin) return config.layouts
  const outputs = editableOutputs(config, user)
  return config.layouts.filter(
    (l) =>
      l.owner === user.roleId ||
      l.shared === true ||
      config.outputs.some((o) => outputs.has(o.id) && (o.layoutId === l.id || o.lastLayoutId === l.id)),
  )
}

/**
 * Layouts, die nur auf Multiviews dieser Rolle laufen und niemandem gehören, gehen in den
 * Besitz der Rolle über – sonst wären sie nach dem Umschalten auf ein anderes Layout weg.
 */
function claimLayouts(config, user) {
  const rights = roleRights(config, user)
  if (!rights || rights.admin) return
  for (const layout of config.layouts) {
    if (layout.owner || layout.shared) continue
    const usedBy = config.outputs.filter((o) => o.layoutId === layout.id).map((o) => o.id)
    if (usedBy.length && usedBy.every((id) => rights.edit.includes(id))) layout.owner = user.roleId
  }
}

/**
 * Änderungen eines Nutzers ohne Admin-Rechte übernehmen: nur seine Layouts und die
 * Layout-Wahl seiner Multiviews. Alles andere bleibt, wie es auf dem Server ist.
 */
function applyRestrictedChanges(current, submitted, user) {
  const rights = roleRights(current, user)
  const next = structuredClone(current)
  const sent = new Map((Array.isArray(submitted?.layouts) ? submitted.layouts : []).map((l) => [l?.id, l]))

  next.layouts = next.layouts.flatMap((layout) => {
    if (!canEditLayout(current, user, layout)) return [layout]
    const changed = sent.get(layout.id)
    if (!changed) return layout.owner === user.roleId ? [] : [layout] // nur eigene Layouts löschen
    return [{ ...changed, id: layout.id, owner: layout.owner ?? null, shared: layout.shared }]
  })
  if (rights?.editLayouts) {
    for (const layout of sent.values()) {
      if (!layout?.id || current.layouts.some((l) => l.id === layout.id)) continue
      next.layouts.push({ ...layout, owner: user.roleId, shared: false })
    }
  }

  claimLayouts(next, user)
  const outputs = editableOutputs(current, user)
  const visible = new Set(visibleLayouts(next, user).map((l) => l.id))
  for (const output of next.outputs) {
    if (!outputs.has(output.id)) continue
    const wanted = (Array.isArray(submitted?.outputs) ? submitted.outputs : []).find((o) => o?.id === output.id)
    if (wanted && (wanted.layoutId === null || visible.has(wanted.layoutId))) output.layoutId = wanted.layoutId
  }
  return next
}

module.exports = {
  createAccess,
  normalizeAccess,
  roleRights,
  allowedOutputs,
  editableOutputs,
  canEditLayout,
  visibleLayouts,
  applyRestrictedChanges,
  claimLayouts,
  ADMIN,
}
