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
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const COOKIE = 'mv_session'
const DEVICE_COOKIE = 'jms_device'
const SESSION_DAYS = 30
const QR_TTL_MS = 10 * 60 * 1000
// Tagescode: neu um Mitternacht (deutsche Zeit); wer ihn am Vortag eingegeben hat, bleibt bis
// 5 Uhr freigeschaltet, damit niemand mitten in einer Veranstaltung rausfliegt
const TIME_ZONE = 'Europe/Berlin'
const GRACE_UNTIL_HOUR = 5
const CODE_MAX_FAILS = 8
const CODE_FAIL_WINDOW_MS = 15 * 60 * 1000
// Eine Rolle gilt als belegt, solange eine Seite von ihr offen ist (WebSocket) oder sie so
// kurz zuvor noch etwas abgefragt hat
const ACTIVE_MS = 2 * 60 * 1000
// So steht eine direkt in Kesher angemeldete Rolle auf der Anmeldeseite
const KESHER_HOLDER = 'in Kesher'
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

// ---------------------------------------------------------------------------
// Zentrale Anmeldung für alle Dienste (Kesher, Dashboard, Companion …) über Caddy
// ---------------------------------------------------------------------------

/**
 * Was ein Dienst verlangt: 'user' = Name + Rolle, 'admin' = Admin mit PIN.
 * Unbekannte Dienste brauchen sicherheitshalber den Admin.
 */
const SERVICE_LEVELS = {
  kesher: 'user',
  dashboard: 'user',
  companion: 'admin',
  portainer: 'admin',
  glances: 'admin',
  dns: 'admin',
}

/** Datum (JJJJ-MM-TT) und Stunde in deutscher Zeit. */
function localTime(ts = Date.now()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    })
      .formatToParts(new Date(ts))
      .map((p) => [p.type, p.value]),
  )
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) }
}

function previousDay(day) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

/** „192.168.0.50“, „192.168.0.0/24“ oder eine IPv6-Adresse; sonst null. */
function parseNetwork(entry) {
  const text = String(entry ?? '').trim()
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(text)
  if (m) {
    const octets = m.slice(1, 5).map(Number)
    const bits = m[5] === undefined ? 32 : Number(m[5])
    if (octets.some((o) => o > 255) || bits > 32) return null
    return { text, v4: ipv4ToInt(octets), bits }
  }
  if (/^[0-9a-f:]+$/i.test(text) && text.includes(':')) return { text, v6: text.toLowerCase() }
  return null
}

function ipv4ToInt(octets) {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

/** Gehört die Adresse zu einem der Netze? (IPv4 auch in der Schreibweise ::ffff:1.2.3.4) */
function ipInNetworks(ip, networks) {
  const addr = String(ip ?? '').replace(/^::ffff:/i, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  return networks.some((n) => {
    if (n.v6) return !v4 && addr.toLowerCase() === n.v6
    if (!v4) return false
    const mask = n.bits === 0 ? 0 : (0xffffffff << (32 - n.bits)) >>> 0
    return ((ipv4ToInt(v4.slice(1, 5).map(Number)) & mask) >>> 0) === ((n.v4 & mask) >>> 0)
  })
}

const isLoopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(String(ip ?? ''))

/**
 * Eine eigene Adresse des Servers? Der Multiview läuft mit network_mode host, sieht also alle
 * Netzwerkkarten. Was der Server selbst über Caddy anfragt (Companion → https://192.168.0.21:8443),
 * kommt mit seiner LAN-Adresse an, nicht als Loopback.
 */
function isOwnAddress(ip) {
  const addr = String(ip ?? '').replace(/^::ffff:/i, '').replace(/%.*$/, '').toLowerCase()
  if (!addr) return false
  return Object.values(os.networkInterfaces()).some((list) => (list ?? []).some((i) => i.address.toLowerCase() === addr))
}

function normalizeGateway(g) {
  const exempt = (Array.isArray(g?.exempt) ? g.exempt : [])
    .map((e) => ({ network: String(e?.network ?? e ?? '').trim(), label: String(e?.label ?? '').trim().slice(0, 60) }))
    .filter((e) => parseNetwork(e.network))
  const startUrl = String(g?.startUrl ?? '').trim()
  return {
    enabled: Boolean(g?.enabled),
    exempt,
    startUrl: /^https?:\/\/[^\s"'<>]+$/i.test(startUrl) ? startUrl.replace(/\/+$/, '') : '',
  }
}

/**
 * kesherActiveRoles: Rollen, die in Kesher gerade an einem Gerät angemeldet sind.
 * releaseKesherRole(roleId, name): die Rolle dort freigeben (meldet das andere Gerät ab).
 */
function createAccess({
  dataDir,
  log = console.log,
  verifyKesherPin = async () => false,
  isLive = () => false,
  onRevoke = () => {},
  kesherActiveRoles = async () => [],
  releaseKesherRole = async () => {},
  ipOf = () => '',
}) {
  const file = path.join(dataDir, 'access-secret.json')
  // { adminPin: { salt, hash } | { kesher: true }, sessions: { sha256(token): session },
  //   gateway: { enabled, exempt, startUrl }, dayCode: { day, code, gen, prevGen },
  //   devices: { sha256(token): { gen, created, ip } } }
  let secret = read()
  const qrTokens = new Map() // sha256(token) -> { session, expires }
  const codeFails = new Map() // IP -> { count, since }
  let writeTimer = null

  function read() {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'))
      return {
        adminPin: s.adminPin ?? null,
        sessions: s.sessions ?? {},
        gateway: normalizeGateway(s.gateway),
        dayCode: s.dayCode ?? null,
        devices: s.devices ?? {},
      }
    } catch {
      return { adminPin: null, sessions: {}, gateway: normalizeGateway(null), dayCode: null, devices: {} }
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
  function newSession({ name, roleId, admin, group }, ip = '') {
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
      ip: ip || undefined,
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
    // Adresse des Geräts merken (für „Angemeldet“ beim Admin) – ändert sich z. B. beim WLAN-Wechsel
    const ip = ipOf(req)
    if (ip && s.ip !== ip) {
      s.ip = ip
      writeSoon()
    }
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

  /** Rollen in Kesher – ist Kesher nicht erreichbar, hält das die Anmeldung nicht auf. */
  async function rolesInKesher() {
    try {
      return new Set(await kesherActiveRoles())
    } catch {
      return new Set()
    }
  }

  /**
   * Belegte Rollen für die Anmeldeseite, auch die direkt in Kesher angemeldeten (feste Stationen
   * ohne zentrale Anmeldung). Die eigene Rolle dieses Browsers nicht – die hält ja er selbst.
   */
  async function occupiedForLogin(req) {
    const out = occupiedRoles()
    const ownRole = sessionOf(req)?.roleId
    for (const roleId of await rolesInKesher()) if (!out[roleId] && roleId !== ownRole) out[roleId] = KESHER_HOLDER
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
    const ownRole = own ? secret.sessions[sha256(own)]?.roleId : null
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
      // Hier hat sie niemand – vielleicht aber ein Gerät direkt in Kesher (ohne zentrale Anmeldung).
      // Hatte dieser Browser die Rolle schon, ist das seine eigene Kesher-Seite.
      const inKesher = !active.length && ownRole !== roleId && (await rolesInKesher()).has(roleId)
      if (inKesher && !takeover)
        throw Object.assign(new Error('Die Rolle ist schon angemeldet – direkt in Kesher.'), {
          status: 409,
          holder: { name: KESHER_HOLDER, kesher: true },
        })
      if (inKesher) {
        await releaseKesherRole(roleId, cleanName)
        log(`Zugang: ${cleanName} übernimmt die Rolle ${roleId} von einem Gerät in Kesher`)
      }
      // Übernehmen bzw. alte, nicht mehr aktive Anmeldungen derselben Rolle aufräumen
      endSessions(holders, active.length ? `übernommen von ${cleanName}` : 'abgelaufen')
      if (active.length) log(`Zugang: ${cleanName} übernimmt die Rolle ${roleId} von ${active.map((s) => s.name).join(', ')}`)
    }
    const token = newSession({ name: cleanName, roleId, admin }, ipOf(req))
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
      // Ohne Admin-PIN gibt es keine Rollen-Anmeldung – also auch keine für die anderen Dienste
      secret.gateway.enabled = false
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
    const session = newSession(entry.user, ipOf(req))
    res.setHeader('Set-Cookie', cookieFor(session, req))
    log(`Zugang: ${entry.user.name} per QR-Code am Handy angemeldet`)
    return true
  }

  function sessions() {
    return Object.values(secret.sessions)
      .map(({ id, name, roleId, admin, created, seen, ip }) => ({ id, name, roleId, admin, created, seen, ip: ip || null, live: isLive(id) }))
      .sort((a, b) => b.seen - a.seen)
  }

  function endSession(id) {
    endSessions(Object.values(secret.sessions).filter((s) => s.id === id), 'vom Admin abgemeldet')
  }

  // --- Zentrale Anmeldung für alle Dienste: Einstellungen ---------------------

  /** Eingeschaltet zählt nur mit Admin-PIN – ohne sie gibt es keine Rollen-Anmeldung. */
  const gatewayActive = () => enabled() && secret.gateway.enabled

  function gateway() {
    return { ...secret.gateway, active: gatewayActive() }
  }

  function setGateway(next) {
    // Nur mitgeschickte Werte ändern
    const given = Object.fromEntries(Object.entries(next ?? {}).filter(([, v]) => v !== undefined))
    const normalized = normalizeGateway({ ...secret.gateway, ...given })
    if (normalized.enabled && !enabled())
      throw Object.assign(new Error('Erst die Admin-PIN einrichten – ohne sie gibt es keine Anmeldung'), { status: 400 })
    const invalid = (Array.isArray(next?.exempt) ? next.exempt : []).filter((e) => !parseNetwork(e?.network ?? e))
    if (invalid.length)
      throw Object.assign(new Error(`Keine gültige Adresse: ${invalid.map((e) => e?.network ?? e).join(', ')}`), { status: 400 })
    if (normalized.enabled !== secret.gateway.enabled)
      log(`Zugang: Anmeldung für alle Dienste ${normalized.enabled ? 'eingeschaltet' : 'ausgeschaltet'}`)
    secret.gateway = normalized
    write()
    return gateway()
  }

  // --- Tagescode -------------------------------------------------------------

  const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

  /** Der Code von heute; um Mitternacht entsteht beim ersten Abruf ein neuer. */
  function dayCode(now = Date.now()) {
    const { day } = localTime(now)
    const current = secret.dayCode
    if (current?.day !== day) {
      // Der Code von gestern gilt für schon freigeschaltete Geräte noch bis zum Morgen
      const prevGen = current?.day === previousDay(day) ? current.gen : null
      secret.dayCode = { day, code: newCode(), gen: crypto.randomBytes(6).toString('hex'), prevGen }
      pruneDevices()
      write()
    }
    return secret.dayCode
  }

  /** Neuer Code sofort (z. B. wenn er in falsche Hände geraten ist): alle Freischaltungen enden. */
  function renewDayCode() {
    const { day } = localTime()
    secret.dayCode = { day, code: newCode(), gen: crypto.randomBytes(6).toString('hex'), prevGen: null }
    pruneDevices()
    write()
    log('Zugang: neuer Tagescode erzeugt – alle Geräte müssen ihn neu eingeben')
    return secret.dayCode
  }

  function genValid(gen, now = Date.now()) {
    const code = dayCode(now)
    if (gen === code.gen) return true
    return Boolean(code.prevGen) && gen === code.prevGen && localTime(now).hour < GRACE_UNTIL_HOUR
  }

  function pruneDevices() {
    const keep = new Set([secret.dayCode?.gen, secret.dayCode?.prevGen].filter(Boolean))
    for (const [key, d] of Object.entries(secret.devices)) if (!keep.has(d.gen)) delete secret.devices[key]
  }

  /** Ist dieses Gerät heute schon mit dem Code freigeschaltet? */
  function deviceApproved(req) {
    const token = parseCookies(req.headers.cookie)[DEVICE_COOKIE]
    const device = token && secret.devices[sha256(token)]
    return Boolean(device) && genValid(device.gen)
  }

  function devicesToday() {
    return Object.values(secret.devices).filter((d) => genValid(d.gen)).length
  }

  /**
   * Code prüfen und das Gerät freischalten. Nach zu vielen Fehlversuchen von einer Adresse
   * ist eine Viertelstunde Pause – sechs Ziffern ließen sich sonst durchprobieren.
   */
  function redeemDayCode(code, ip, req, res) {
    const now = Date.now()
    const fails = codeFails.get(ip)
    if (fails && now - fails.since > CODE_FAIL_WINDOW_MS) codeFails.delete(ip)
    if ((codeFails.get(ip)?.count ?? 0) >= CODE_MAX_FAILS)
      throw Object.assign(new Error('Zu viele falsche Versuche – bitte in 15 Minuten noch einmal'), { status: 429 })
    const current = dayCode(now)
    const given = String(code ?? '').replace(/\D/g, '')
    const ok = given.length === 6 && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(current.code))
    if (!ok) {
      const entry = codeFails.get(ip) ?? { count: 0, since: now }
      entry.count++
      codeFails.set(ip, entry)
      throw Object.assign(new Error('Der Code stimmt nicht – es gilt immer nur der Code von heute'), { status: 403 })
    }
    codeFails.delete(ip)
    approveDevice(ip, req, res)
    log(`Zugang: Gerät ${ip} mit dem Tagescode freigeschaltet`)
  }

  /** Gerät für heute freischalten (Tagescode eingegeben oder Anmelde-QR eines angemeldeten Nutzers gescannt). */
  function approveDevice(ip, req, res) {
    const token = randomToken()
    secret.devices[sha256(token)] = { gen: dayCode(Date.now()).gen, created: Date.now(), ip: String(ip ?? '') }
    write()
    // Bis zum übernächsten Morgen reicht – danach braucht es ohnehin den neuen Code
    const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : ''
    res.append('Set-Cookie', `${DEVICE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${2 * 86400}${secure}`)
  }

  // --- Prüfung für Caddy (forward_auth) ---------------------------------------

  /**
   * Darf diese Anfrage an den Dienst durch?
   * allow: ja (user = wer, falls angemeldet). code: erst den Tagescode eingeben.
   * login: erst Name + Rolle. forbidden: angemeldet, aber nicht Admin.
   */
  /** Feste Geräte aus der Liste (und der Server selbst) brauchen keinen Tagescode. */
  const exemptIp = (ip) => isLoopback(ip) || isOwnAddress(ip) || ipInNetworks(ip, secret.gateway.exempt.map((e) => parseNetwork(e.network)))

  /** Muss dieses Gerät den Tagescode eingeben, und hat es das schon? */
  function deviceStatus(ip, req) {
    const required = gatewayActive() && !exemptIp(ip)
    return { required, approved: !required || deviceApproved(req) }
  }

  /**
   * Darf diese Anfrage an die Schnittstellen des Multiview selbst (Zustand, Chat, Companion-Befehle,
   * ProPresenter)? Angemeldete Nutzer, feste Geräte und der Server selbst (Kiosk, Companion).
   * Ohne eingeschaltete Anmeldung jeder.
   */
  function trusted(ip, req) {
    return Boolean(userOf(req)) || exemptIp(ip)
  }

  function check({ service, ip }, req) {
    if (!gatewayActive()) return { action: 'allow', user: null }
    const level = SERVICE_LEVELS[service] ?? 'admin'
    const exempt = exemptIp(ip)
    const user = userOf(req)
    // Feste Geräte (Stationen, Raspberry Pis, Desktop-App) können keinen Code eingeben
    if (exempt && level === 'user') return { action: 'allow', user }
    if (!exempt && !deviceApproved(req)) return { action: 'code', user }
    if (!user) return { action: 'login', user: null }
    if (level === 'admin' && !user.admin) return { action: 'forbidden', user }
    return { action: 'allow', user }
  }

  /**
   * Kurzes, signiertes Ticket für einen anderen Dienst auf dem Server (Kesher), der den Nutzer
   * selbst anmelden soll. Kesher prüft es mit demselben Geheimnis (JMS_AUTH_SECRET).
   */
  function createTicket(user, audience, key) {
    if (!key) throw Object.assign(new Error('JMS_AUTH_SECRET ist nicht eingerichtet'), { status: 503 })
    const payload = Buffer.from(
      JSON.stringify({ name: user.name, roleId: user.roleId, admin: Boolean(user.admin), aud: audience, exp: Date.now() + 60_000 }),
    ).toString('base64url')
    const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url')
    return `${payload}.${signature}`
  }

  return {
    enabled, pinSource, userOf, sessionIdOf, occupiedRoles, occupiedForLogin, login, logout, setAdminPin, createQrToken, redeemQrToken, sessions, endSession,
    gateway, setGateway, dayCode, renewDayCode, deviceStatus, devicesToday, redeemDayCode, approveDevice, check, trusted, createTicket,
    flush: write,
  }
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
  parseNetwork,
  ipInNetworks,
  localTime,
  SERVICE_LEVELS,
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
