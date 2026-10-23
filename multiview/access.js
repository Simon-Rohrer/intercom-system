'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const net = require('net')
const os = require('os')

const COOKIE = 'mv_session'
const DEVICE_COOKIE = 'jms_device'
const SECURITY_FORMAT = 3
const MACHINE_SERVICES = new Set(['multiview', 'kesher', 'dashboard'])
const MACHINE_CAPABILITIES = new Set(['display', 'day-code', 'pi-config', 'heartbeat', 'control', 'pi-manage', 'companion', 'satellite', 'chat-monitor', 'image-stream'])
const QR_TTL_MS = 10 * 60 * 1000
// Dauerhaft freigeschaltetes Gerät (vom Admin auf dem Gerät selbst): braucht keinen Tagescode
const PERMANENT_MS = 365 * 24 * 60 * 60 * 1000
// Ohne Ablauf: Browser halten Cookies höchstens 400 Tage – JMS Control erneuert es bei jedem Besuch
const COOKIE_MAX_MS = 400 * 24 * 60 * 60 * 1000
// Feste IP-Adressen nur aus dem eigenen Netz (und Tailscale, dort ist die IP an den Geräteschlüssel gebunden)
const IP_GRANT_NETWORKS = ['192.168.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '100.64.0.0/10'].map(parseNetwork)
// Ticket für den Abgleich der Anmeldung zwischen den Adressen (nur für eine Weiterleitung)
const SSO_TTL_MS = 60 * 1000
// Tagescode: neu um Mitternacht (deutsche Zeit); wer ihn am Vortag eingegeben hat, bleibt bis
// 5 Uhr freigeschaltet, damit niemand mitten in einer Veranstaltung rausfliegt
const TIME_ZONE = 'Europe/Berlin'
const GRACE_UNTIL_HOUR = 5
const CODE_MAX_FAILS = 8
const CODE_FAIL_WINDOW_MS = 15 * 60 * 1000
const PIN_MAX_FAILS = 8
const PIN_FAIL_WINDOW_MS = 15 * 60 * 1000
const MAX_FAIL_ENTRIES = 2048
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

function parseCookies(header) {
  const out = Object.create(null)
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=')
    if (separator <= 0) continue
    const name = part.slice(0, separator).trim()
    if (Object.hasOwn(out, name)) {
      out[name] = null
      continue
    }
    try {
      out[name] = decodeURIComponent(part.slice(separator + 1).trim())
    } catch {
      out[name] = null
    }
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
  return {
    outputs, edit, editLayouts: Boolean(r && typeof r === 'object' && r.editLayouts !== false),
    controlSlides: r?.controlSlides === true,
    controlPis: r?.controlPis === true,
  }
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
  router: 'admin',
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

function nextMorning(now = Date.now()) {
  const local = localTime(now)
  const date = new Date(`${local.day}T12:00:00Z`)
  if (local.hour >= GRACE_UNTIL_HOUR) date.setUTCDate(date.getUTCDate() + 1)
  const target = Date.parse(`${date.toISOString().slice(0, 10)}T05:00:00Z`)
  let instant = target
  for (let attempt = 0; attempt < 3; attempt++) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]))
    const represented = Date.parse(`${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}Z`)
    instant += target - represented
  }
  return instant
}

/** „192.168.0.50“, „192.168.0.0/24“ oder eine IPv6-Adresse; sonst null. */
/** IPv4-Adressen dieses Servers – die dürfen keine feste Freigabe bekommen */
function ownAddresses() {
  return Object.values(os.networkInterfaces()).flat().filter((i) => i && (i.family === 'IPv4' || i.family === 4)).map((i) => i.address)
}

function parseNetwork(entry) {
  const text = String(entry ?? '').trim()
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(text)
  if (m) {
    const octets = m.slice(1, 5).map(Number)
    const bits = m[5] === undefined ? 32 : Number(m[5])
    if (octets.some((o) => o > 255) || bits > 32) return null
    return { text, v4: ipv4ToInt(octets), bits }
  }
  if (net.isIP(text) === 6) return { text, v6: text.toLowerCase() }
  return null
}

function ipv4ToInt(octets) {
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
}

/** Gehört die Adresse zu einem der Netze? (IPv4 auch in der Schreibweise ::ffff:1.2.3.4) */
function ipInNetworks(ip, networks) {
  const addr = String(ip ?? '').replace(/^::ffff:/i, '')
  if (!net.isIP(addr)) return false
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr)
  return networks.some((n) => {
    if (n.v6) return !v4 && addr.toLowerCase() === n.v6
    if (!v4) return false
    const mask = n.bits === 0 ? 0 : (0xffffffff << (32 - n.bits)) >>> 0
    return ((ipv4ToInt(v4.slice(1, 5).map(Number)) & mask) >>> 0) === ((n.v4 & mask) >>> 0)
  })
}

const isLoopback = (ip) => /^(127\.|::1$|::ffff:127\.)/.test(String(ip ?? ''))

function normalizeGateway(g) {
  const startUrl = String(g?.startUrl ?? '').trim()
  return {
    enabled: Boolean(g?.enabled),
    startUrl: /^https?:\/\/[^\s"'<>]+$/i.test(startUrl) ? startUrl.replace(/\/+$/, '') : '',
  }
}

/** kesherActiveRoles: Rollen, die in Kesher gerade an einem Gerät angemeldet sind. */
function createAccess({
  dataDir,
  log = console.log,
  verifyKesherPin = async () => false,
  isLive = () => false,
  onRevoke = () => {},
  kesherActiveRoles = async () => [],
  getRoles = () => [],
  ipOf = () => '',
  onChange = () => {},
  allowBootstrap = false,
  // Rollen der Kesher-Kacheln in den Layouts: Anzeige-Stationen (Kiosk am HDMI-Ausgang) dürfen
  // sie in Kesher spiegeln (Zweitgerät, belegt die Rolle nie)
  getMirrorRoles = () => [],
}) {
  const file = path.join(dataDir, 'access-secret.json')
  const qrTokens = new Map()
  const ssoTickets = new Map()
  const roleLocks = new Map()
  const pinPending = new Set()
  let pinInFlight = 0
  let pinTokens = 8
  let pinRefilledAt = Date.now()
  let adminRevision = 0
  let writeTimer = null
  let bootstrapping = false
  let secret = read()

  const fail = (status, message) => Object.assign(new Error(message), { status })
  const enabled = () => Boolean(secret.adminPin)
  const pinSource = () => (!secret.adminPin ? null : secret.adminPin.kesher ? 'kesher' : 'own')
  const gatewayActive = () => enabled() && secret.gateway.enabled

  function read() {
    let loaded
    try {
      loaded = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (error) {
      if (!allowBootstrap || error.code !== 'ENOENT')
        throw new Error('Sicherheitsdaten fehlen oder sind nicht lesbar – Zugang bleibt gesperrt', { cause: error })
      bootstrapping = true
      return {
        securityFormat: SECURITY_FORMAT, version: randomToken(), adminPin: null,
        sessions: {}, gateway: normalizeGateway(null), dayCode: null, devices: {}, ipGrants: {}, machines: {}, pinFails: {}, codeFails: {},
      }
    }
    const pin = loaded?.adminPin
    if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded) ||
      !(pin?.kesher === true || (/^[0-9a-f]{32}$/i.test(pin?.salt ?? '') && /^[0-9a-f]{64}$/i.test(pin?.hash ?? ''))))
      throw new Error('Sicherheitsdaten enthalten keine gültige Admin-PIN – Zugang bleibt gesperrt')
    const modern = loaded.securityFormat === SECURITY_FORMAT && typeof loaded.version === 'string' && loaded.version.length >= 16
    if (!modern) log('Zugang: Sicherheitsformat aktualisiert – bestehende Sitzungen und Gerätefreigaben verworfen')
    const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {}
    return {
      securityFormat: SECURITY_FORMAT,
      version: modern ? loaded.version : randomToken(),
      adminPin: pin,
      sessions: modern ? record(loaded.sessions) : {},
      gateway: normalizeGateway(loaded.gateway),
      dayCode: loaded.dayCode && /^\d{4}-\d{2}-\d{2}$/.test(loaded.dayCode.day) &&
        /^\d{6}$/.test(loaded.dayCode.code) && typeof loaded.dayCode.gen === 'string' ? loaded.dayCode : null,
      devices: modern ? record(loaded.devices) : {},
      ipGrants: modern ? record(loaded.ipGrants) : {},
      machines: modern ? record(loaded.machines) : {},
      pinFails: record(loaded.pinFails),
      codeFails: record(loaded.codeFails),
    }
  }

  function write() {
    clearTimeout(writeTimer)
    writeTimer = null
    const temporary = file + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(secret, null, 2), { mode: 0o600 })
    fs.chmodSync(temporary, 0o600)
    fs.renameSync(temporary, file)
    onChange()
  }

  function writeSoon() {
    if (writeTimer) return
    writeTimer = setTimeout(write, 30_000)
    writeTimer.unref?.()
  }

  function normalizedFingerprint(value) {
    if (typeof value !== 'string') return ''
    const fingerprint = value.replace(/:/g, '').toLowerCase()
    return /^[a-f0-9]{64}$/.test(fingerprint) ? fingerprint : ''
  }

  function publicMachine(machine) {
    const { id, name, mode, version, fingerprint, services, capabilities, roleId, raspberryClientId, deviceId, expiresAt, revokedAt, createdAt } = machine
    return { id, name, mode, version, fingerprint, services: [...services], capabilities: [...capabilities], roleId,
      raspberryClientId, deviceId, expiresAt, revokedAt, createdAt, mirrorRoles: mirrorRolesOf(machine) }
  }

  /** Welche Kesher-Rollen eine Anzeige-Station spiegeln darf (die ihrer Kesher-Kacheln). */
  function mirrorRolesOf(machine) {
    if (machine?.mode !== 'station' || !machine.capabilities?.includes('display') || !machine.services?.includes('multiview')) return []
    try {
      return [...new Set(getMirrorRoles())].filter((role) => typeof role === 'string' && role && role.length <= 128).sort()
    } catch {
      return []
    }
  }

  function validMachine(machine, now = Date.now()) {
    return Boolean(machine && typeof machine.id === 'string' && /^[a-f0-9]{24}$/.test(machine.id) &&
      typeof machine.name === 'string' && ['station', 'code-bypass'].includes(machine.mode) &&
      typeof machine.version === 'string' && /^[A-Za-z0-9_-]{32}$/.test(machine.version) &&
      Number.isSafeInteger(machine.expiresAt) && machine.expiresAt > now && machine.revokedAt === null &&
      Array.isArray(machine.services) && machine.services.every((service) => MACHINE_SERVICES.has(service)) &&
      Array.isArray(machine.capabilities) && machine.capabilities.every((capability) => MACHINE_CAPABILITIES.has(capability)) &&
      (machine.mode !== 'code-bypass' || machine.capabilities.length === 0) &&
      (!machine.fingerprint || normalizedFingerprint(machine.fingerprint) === machine.fingerprint) &&
      /^[a-f0-9]{64}$/.test(machine.keyHash || '') && machine.roleId !== ADMIN)
  }

  function machineStatus(id, version) {
    const machine = typeof id === 'string' && Object.hasOwn(secret.machines, id) ? secret.machines[id] : null
    if (!validMachine(machine) || (version !== undefined && machine.version !== version)) return { active: false, id: String(id || '') }
    return { active: true, ...publicMachine(machine) }
  }

  function machineByFingerprint(value) {
    const fingerprint = normalizedFingerprint(value)
    if (!fingerprint) return null
    const matches = Object.values(secret.machines).filter((machine) => machine?.fingerprint === fingerprint)
    return matches.length === 1 && validMachine(matches[0]) ? publicMachine(matches[0]) : null
  }

  function credentialHeader(req, name) {
    const value = req?.headers?.[name]
    if (value === undefined) return ''
    if (typeof value !== 'string' || value.length > 512 || value.includes(',') || /[\s\u0000-\u001f\u007f]/.test(value)) return null
    const raw = req.rawHeaders || []
    let count = 0
    for (let index = 0; index < raw.length; index += 2) if (String(raw[index]).toLowerCase() === name) count++
    return count > 1 ? null : value
  }

  function machineOf(req) {
    const fingerprintHeader = credentialHeader(req, 'x-jms-device-fingerprint')
    const proxyHeader = credentialHeader(req, 'x-jms-device-proxy')
    const keyHeader = credentialHeader(req, 'x-jms-device-key')
    if ([fingerprintHeader, proxyHeader, keyHeader].includes(null) || (!fingerprintHeader && !keyHeader)) return null
    const loopback = isLoopback(req?.socket?.remoteAddress)
    const proxySecret = process.env.JMS_DEVICE_PROXY_SECRET || ''
    const verifiedProxy = loopback && proxySecret.length >= 32 && Boolean(proxyHeader) &&
      crypto.timingSafeEqual(Buffer.from(sha256(proxyHeader), 'hex'), Buffer.from(sha256(proxySecret), 'hex'))
    if (proxyHeader && !verifiedProxy) return null
    let certificateMachine = null
    let keyMachine = null
    if (fingerprintHeader) {
      if (!verifiedProxy) return null
      certificateMachine = machineByFingerprint(fingerprintHeader)
      if (!certificateMachine) return null
    }
    if (keyHeader) {
      const forwarded = ['x-forwarded-for', 'x-forwarded-proto', 'forwarded'].some((header) => req?.headers?.[header] !== undefined)
      const secureTransport = req?.socket?.encrypted === true || (verifiedProxy && req.headers['x-forwarded-proto'] === 'https') || (loopback && !forwarded)
      if (!secureTransport || !/^[A-Za-z0-9_-]{43}$/.test(keyHeader)) return null
      const hashed = Buffer.from(sha256(keyHeader), 'hex')
      const matches = Object.values(secret.machines).filter((machine) => validMachine(machine) &&
        crypto.timingSafeEqual(hashed, Buffer.from(machine.keyHash, 'hex')))
      if (matches.length !== 1) return null
      keyMachine = publicMachine(matches[0])
    }
    if (certificateMachine && keyMachine && certificateMachine.id !== keyMachine.id) return null
    return certificateMachine || keyMachine
  }

  function listMachines() {
    return Object.values(secret.machines).filter((machine) => machine && Array.isArray(machine.services) && Array.isArray(machine.capabilities))
      .map((machine) => ({ ...publicMachine(machine), active: validMachine(machine) }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  function machineInput(input, previous = null) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail(400, 'Ungültige Gerätedaten')
    const given = { ...previous, ...input }
    const name = typeof given.name === 'string' ? given.name.trim() : ''
    if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw fail(400, 'Bitte einen gültigen Gerätenamen eingeben')
    const mode = given.mode ?? 'station'
    if (!['station', 'code-bypass'].includes(mode)) throw fail(400, 'Ungültige Gerätebetriebsart')
    const validateList = (value, allowed) => {
      if (!Array.isArray(value) || value.length > allowed.size || value.some((entry) => !allowed.has(entry)) || new Set(value).size !== value.length)
        throw fail(400, 'Ungültige Geräteberechtigungen')
      return [...value]
    }
    const services = validateList(given.services ?? [], MACHINE_SERVICES)
    const capabilities = validateList(given.capabilities ?? [], MACHINE_CAPABILITIES)
    if (mode === 'code-bypass' && capabilities.length) throw fail(400, 'Codefreigaben dürfen keine Stationsrechte erhalten')
    const fingerprint = given.fingerprint ? normalizedFingerprint(given.fingerprint) : ''
    if (given.fingerprint && !fingerprint) throw fail(400, 'Ungültiger Zertifikatsfingerprint')
    if (fingerprint && Object.values(secret.machines).some((machine) =>
      (machine?.id !== previous?.id && machine?.fingerprint === fingerprint) || machine?.fingerprintHistory?.includes(fingerprint)))
      throw fail(409, 'Dieses Zertifikat ist bereits einem Gerät zugeordnet')
    const expiresAt = given.expiresAt ?? Date.now() + 365 * 24 * 60 * 60 * 1000
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw fail(400, 'Das Geräteablaufdatum muss in der Zukunft liegen')
    const identifier = (value) => {
      if (value === undefined || value === null || value === '') return ''
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw fail(400, 'Ungültige Gerätezuordnung')
      return value
    }
    // Kesher-Rollen-IDs dürfen Leerzeichen enthalten („lighting 2“)
    const roleId = given.roleId === undefined || given.roleId === null || given.roleId === '' ? '' : validRoleId(given.roleId) ? given.roleId : identifier(given.roleId)
    if (roleId === ADMIN) throw fail(400, 'Geräte dürfen keine Adminrolle erhalten')
    return { name, mode, services, capabilities, fingerprint, expiresAt, roleId,
      raspberryClientId: identifier(given.raspberryClientId), deviceId: identifier(given.deviceId) }
  }

  function createMachine(input) {
    if (Object.keys(secret.machines).length >= 1024) throw fail(409, 'Maximale Anzahl registrierter Geräte erreicht')
    const normalized = machineInput(input)
    const key = crypto.randomBytes(32).toString('base64url')
    const id = crypto.randomBytes(12).toString('hex')
    const machine = { ...normalized, id, version: randomToken(), keyHash: sha256(key),
      fingerprintHistory: normalized.fingerprint ? [normalized.fingerprint] : [], createdAt: Date.now(), revokedAt: null }
    secret.machines[id] = machine
    write()
    return { machine: publicMachine(machine), key }
  }

  function rotateMachine(id, input = {}) {
    const previous = typeof id === 'string' && Object.hasOwn(secret.machines, id) ? secret.machines[id] : null
    if (!previous) throw fail(404, 'Gerät nicht gefunden')
    const normalized = machineInput({ ...input, fingerprint: Object.hasOwn(input, 'fingerprint') ? input.fingerprint : '' }, previous)
    if (normalized.fingerprint && normalized.fingerprint === previous.fingerprint)
      throw fail(400, 'Beim Erneuern muss ein neues Gerätezertifikat verwendet werden')
    const key = crypto.randomBytes(32).toString('base64url')
    const machine = { ...normalized, id, version: randomToken(), keyHash: sha256(key),
      fingerprintHistory: [...new Set([...(previous.fingerprintHistory || []), previous.fingerprint, normalized.fingerprint].filter(Boolean))],
      createdAt: previous.createdAt, revokedAt: null }
    secret.machines[id] = machine
    endSessions(Object.values(secret.sessions).filter((session) => session.machine?.id === id), 'Gerätenachweis erneuert')
    write()
    return { machine: publicMachine(machine), key }
  }

  /** Kesher-Rollen-ID: wie eine Gerätekennung, aber mit Leerzeichen innen (nicht am Rand). */
  function validRoleId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9](?:[A-Za-z0-9 _.-]{0,126}[A-Za-z0-9_.-])?$/.test(value)
  }

  /**
   * Rolle oder Geräte-ID eines Raspberry Pi wurde in den Einstellungen geändert: die Registrierung
   * seines Zertifikats zieht mit. Neue Version, damit alte Anmeldungen (mit der alten Rolle) enden.
   */
  function reassignPiMachines(raspberryClientId, { roleId, deviceId }) {
    const valid = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)
    if (!valid(raspberryClientId) || !validRoleId(roleId) || !valid(deviceId) || roleId === ADMIN) return []
    const changed = Object.values(secret.machines).filter((machine) => machine?.raspberryClientId === raspberryClientId &&
      machine.revokedAt === null && (machine.roleId !== roleId || machine.deviceId !== deviceId))
    for (const machine of changed) {
      machine.roleId = roleId
      machine.deviceId = deviceId
      machine.version = randomToken()
      endSessions(Object.values(secret.sessions).filter((session) => session.machine?.id === machine.id), 'Rolle des Geräts geändert')
    }
    if (changed.length) write()
    return changed.map(publicMachine)
  }

  function revokeMachine(id) {
    const machine = typeof id === 'string' && Object.hasOwn(secret.machines, id) ? secret.machines[id] : null
    if (!machine) throw fail(404, 'Gerät nicht gefunden')
    machine.revokedAt = Date.now()
    endSessions(Object.values(secret.sessions).filter((session) => session.machine?.id === id), 'Gerät widerrufen')
    write()
    return publicMachine(machine)
  }

  function machineBinding(req) {
    const machine = machineOf(req)
    return machine ? { id: machine.id, version: machine.version } : null
  }

  function matchesMachine(req, binding) {
    if (!binding) return true
    const machine = machineOf(req)
    return Boolean(machine && machine.id === binding.id && machine.version === binding.version)
  }

  function roleStatus(roleId) {
    if (typeof roleId !== 'string' || !roleId || roleId === ADMIN) return false
    const roles = getRoles()
    if (roles == null) return null
    if (Array.isArray(roles)) return roles.some((role) => (typeof role === 'string' ? role : role?.id) === roleId)
    return Boolean(roles && typeof roles === 'object' && Object.hasOwn(roles, roleId))
  }

  const validRole = (roleId) => roleStatus(roleId) === true

  function trimFailures(collection, windowMs) {
    const now = Date.now()
    for (const [key, entry] of Object.entries(collection))
      if (!entry || !Number.isFinite(entry.since) || now - entry.since >= windowMs || !Number.isInteger(entry.count)) delete collection[key]
    const ordered = Object.entries(collection).sort((left, right) => left[1].since - right[1].since)
    for (const [key] of ordered.slice(0, Math.max(0, ordered.length - MAX_FAIL_ENTRIES))) delete collection[key]
  }

  function attemptKey(req) {
    return sha256(String(ipOf(req) || req?.ip || req?.socket?.remoteAddress || 'unknown').replace(/^::ffff:/i, '').slice(0, 160))
  }

  async function checkPin(pin, req, verifier = null) {
    trimFailures(secret.pinFails, PIN_FAIL_WINDOW_MS)
    const key = attemptKey(req)
    if ((secret.pinFails[key]?.count ?? 0) >= PIN_MAX_FAILS)
      throw fail(429, 'Zu viele falsche PIN-Versuche – bitte in 15 Minuten noch einmal')
    const now = Date.now()
    pinTokens = Math.min(8, pinTokens + Math.max(0, now - pinRefilledAt) / 1000)
    pinRefilledAt = now
    if (pinPending.has(key) || pinInFlight >= 4 || pinTokens < 1)
      throw fail(429, 'PIN-Prüfung ausgelastet – bitte kurz warten')
    pinTokens--
    pinPending.add(key)
    pinInFlight++
    const entry = secret.pinFails[key] ?? { count: 0, since: now }
    entry.count++
    secret.pinFails[key] = entry
    write()
    try {
      const value = String(pin ?? '')
      let matches = false
      if (/^\d{4,12}$/.test(value)) {
        if (verifier || secret.adminPin?.kesher) {
          let timeoutTimer
          const timeout = new Promise((resolve) => {
            timeoutTimer = setTimeout(() => resolve(false), 6000)
            timeoutTimer.unref?.()
          })
          try {
            matches = Boolean(await Promise.race([(verifier ?? verifyKesherPin)(value, req), timeout]))
          } finally {
            clearTimeout(timeoutTimer)
          }
        } else if (secret.adminPin) {
          const calculated = await new Promise((resolve, reject) =>
            crypto.scrypt(value, secret.adminPin.salt, 32, (error, derived) => error ? reject(error) : resolve(derived)))
          matches = crypto.timingSafeEqual(calculated, Buffer.from(secret.adminPin.hash, 'hex'))
        }
      }
      if (matches) {
        delete secret.pinFails[key]
        write()
      }
      return matches
    } finally {
      pinPending.delete(key)
      pinInFlight--
    }
  }

  function rawSessionById(id) {
    return Object.values(secret.sessions).find((session) => session?.id === id) ?? null
  }

  function generationValid(generation, now = Date.now()) {
    const current = secret.dayCode
    if (!current || !generation) return false
    const local = localTime(now)
    if (current.day === local.day)
      return generation === current.gen || (generation === current.prevGen && local.hour < GRACE_UNTIL_HOUR)
    return current.day === previousDay(local.day) && generation === current.gen && local.hour < GRACE_UNTIL_HOUR
  }

  const unexpired = (expiresAt, now) => expiresAt == null || (Number.isFinite(expiresAt) && expiresAt > now)

  function validGrant(grant, now = Date.now()) {
    if (!grant) return false
    // Dauerhafte Freigaben gelten, solange der Admin sie nicht widerrufen hat (dann fehlt ihr Eintrag);
    // expiresAt null = ohne Ablauf
    if (grant.ipGrant) return Boolean(secret.ipGrants[grant.id]) && unexpired(secret.ipGrants[grant.id].expiresAt, now)
    if (grant.permanent) return Boolean(grant.id) && Object.values(secret.devices).some((d) => d.permanent && d.id === grant.id && unexpired(d.expiresAt, now))
    return Number.isFinite(grant.expiresAt) && grant.expiresAt > now && generationValid(grant.gen, now)
  }

  /** Freigabe für heute (wie mit dem Tagescode) */
  const todayGrant = () => ({ gen: dayCode().gen, expiresAt: nextMorning() })

  function validSession(session, now = Date.now(), seen = new Set(), preserveUnknownRoles = false) {
    if (!session || seen.has(session.id) || session.securityFormat !== SECURITY_FORMAT ||
      session.version !== secret.version || !Number.isFinite(session.expiresAt) || session.expiresAt <= now ||
      (session.device && !validGrant(session.device, now)) ||
      (session.machine && !machineStatus(session.machine.id, session.machine.version).active)) return false
    if (!session.admin) {
      const role = roleStatus(session.roleId)
      if (role === false || (role === null && !preserveUnknownRoles)) return false
    }
    if (session.originSessionId) {
      seen.add(session.id)
      return validSession(rawSessionById(session.originSessionId), now, seen, preserveUnknownRoles)
    }
    return true
  }

  function endSessions(list, why) {
    const ids = new Set(list.map((session) => session.id))
    let changed = true
    while (changed) {
      changed = false
      for (const session of Object.values(secret.sessions))
        if (session.originSessionId && ids.has(session.originSessionId) && !ids.has(session.id)) {
          ids.add(session.id)
          changed = true
        }
    }
    if (!ids.size) return
    for (const [key, session] of Object.entries(secret.sessions)) if (ids.has(session.id)) delete secret.sessions[key]
    for (const [key, ticket] of qrTokens) if (ids.has(ticket.id)) qrTokens.delete(key)
    for (const [key, ticket] of ssoTickets) if (ids.has(ticket.id)) ssoTickets.delete(key)
    write()
    onRevoke([...ids], why)
  }

  function prune() {
    const now = Date.now()
    endSessions(Object.values(secret.sessions).filter((session) => !validSession(session, now, new Set(), true)), 'abgelaufen')
    for (const [key, ticket] of qrTokens) if (ticket.expires <= now) qrTokens.delete(key)
    for (const [key, ticket] of ssoTickets) if (ticket.expires <= now) ssoTickets.delete(key)
    let removedDevice = false
    for (const [key, device] of Object.entries(secret.devices)) if (!validGrant(device, now)) {
      delete secret.devices[key]
      removedDevice = true
    }
    for (const [id, grant] of Object.entries(secret.ipGrants)) if (!unexpired(grant.expiresAt, now)) {
      delete secret.ipGrants[id]
      removedDevice = true
    }
    if (removedDevice) write()
  }

  function lookupSession(req) {
    const token = parseCookies(req?.headers?.cookie)[COOKIE]
    const session = token ? secret.sessions[sha256(token)] : null
    if (session && !validSession(session)) {
      if (!validSession(session, Date.now(), new Set(), true)) endSessions([session], 'abgelaufen')
      return null
    }
    return session && matchesMachine(req, session.machine) ? session : null
  }

  function sessionOf(req) {
    const session = lookupSession(req)
    if (!session) return null
    const ip = ipOf(req)
    if (ip && session.ip !== ip) {
      session.ip = ip
      writeSoon()
    }
    if (Date.now() - (session.seen ?? 0) > 60_000) {
      session.seen = Date.now()
      writeSoon()
    }
    return session
  }

  /** Hinterlegte feste IP-Adresse dieses Aufrufs (Adresse kommt von Caddy, nicht vom Browser) */
  function ipGrantOf(req) {
    const ip = String(ipOf(req) || '').replace(/^::ffff:/i, '')
    if (!ip) return null
    const grant = Object.values(secret.ipGrants).find((g) => g.ip === ip && unexpired(g.expiresAt, Date.now()))
    if (!grant) return null
    if (Date.now() - (grant.seen ?? 0) > 60_000) {
      grant.seen = Date.now()
      writeSoon()
    }
    return { ipGrant: true, id: grant.id, name: grant.name, ip: grant.ip, expiresAt: grant.expiresAt }
  }

  function deviceGrant(req) {
    const token = parseCookies(req?.headers?.cookie)[DEVICE_COOKIE]
    const grant = token ? secret.devices[sha256(token)] : null
    if (!validGrant(grant)) return ipGrantOf(req)
    if (!grant.permanent) return { gen: grant.gen, expiresAt: grant.expiresAt }
    if (Date.now() - (grant.seen ?? 0) > 60_000) {
      grant.seen = Date.now()
      grant.ip = ipOf(req) || grant.ip
      writeSoon()
    }
    return { permanent: true, id: grant.id, name: grant.name, expiresAt: grant.expiresAt }
  }

  function userOf(req) {
    if (bootstrapping && !enabled()) return { admin: true, open: true, name: '', roleId: ADMIN }
    const session = sessionOf(req)
    if (!session) return null
    if (!session.admin && gatewayActive() && !machineOf(req) && !deviceGrant(req)) return null
    return {
      admin: session.admin, open: false, name: session.name, roleId: session.roleId,
      sessionId: session.id, group: session.group ?? session.id, expiresAt: session.expiresAt, version: session.version,
    }
  }

  function sessionIdOf(req) {
    return userOf(req)?.sessionId ?? null
  }

  function sessionStatusById(id) {
    const session = rawSessionById(id)
    if (!validSession(session)) {
      if (session && !validSession(session, Date.now(), new Set(), true)) endSessions([session], 'abgelaufen')
      return { active: false, sessionId: String(id ?? '') }
    }
    return {
      active: true, sessionId: session.id, admin: session.admin, roleId: session.roleId,
      name: session.name, expiresAt: session.expiresAt, version: session.version,
    }
  }

  function secureSuffix(req) {
    return req?.secure || req?.get?.('x-forwarded-proto') === 'https' ? '; Secure' : ''
  }

  function cookieFor(token, req) {
    const session = secret.sessions[sha256(token)]
    const maxAge = Math.max(0, Math.ceil(((session?.expiresAt ?? Date.now()) - Date.now()) / 1000))
    return COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secureSuffix(req)
  }

  function newSession({ name, roleId, admin, group, originSessionId, expiresAt, device, machine }, ip = '') {
    const now = Date.now()
    const token = randomToken()
    const id = crypto.randomBytes(12).toString('hex')
    secret.sessions[sha256(token)] = {
      securityFormat: SECURITY_FORMAT, version: secret.version, id, group: group || id,
      name, roleId: admin ? ADMIN : roleId, admin: Boolean(admin), created: now, seen: now,
      expiresAt: Math.min(nextMorning(now), expiresAt ?? Infinity, device?.expiresAt ?? Infinity,
        machine ? machineStatus(machine.id, machine.version).expiresAt ?? now : Infinity),
      ip: ip || undefined, originSessionId: originSessionId || undefined, device: device || null, machine: machine || null,
    }
    write()
    return token
  }

  const isActive = (session) => validSession(session) && (isLive(session.id) || Date.now() - (session.seen ?? 0) < ACTIVE_MS)

  function occupiedRoles() {
    prune()
    const occupied = {}
    for (const session of Object.values(secret.sessions)) if (!session.admin && isActive(session)) occupied[session.roleId] = session.name
    return occupied
  }

  async function rolesInKesher() {
    try {
      return new Set(await kesherActiveRoles())
    } catch {
      return new Set()
    }
  }

  async function occupiedForLogin(req) {
    const occupied = occupiedRoles()
    const ownRole = sessionOf(req)?.roleId
    for (const roleId of await rolesInKesher()) if (!occupied[roleId] && roleId !== ownRole) occupied[roleId] = KESHER_HOLDER
    return occupied
  }

  async function lockRole(roleId, work) {
    const previous = roleLocks.get(roleId) ?? Promise.resolve()
    let release
    const pending = new Promise((resolve) => { release = resolve })
    roleLocks.set(roleId, pending)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (roleLocks.get(roleId) === pending) roleLocks.delete(roleId)
    }
  }

  async function login({ name, roleId, pin }, req, res) {
    const cleanName = String(name || '').trim().slice(0, 60)
    if (!cleanName) throw fail(400, 'Bitte einen Namen eingeben')
    const admin = roleId === ADMIN
    const authenticatedVersion = secret.version
    const authenticatedRevision = adminRevision
    if (admin) {
      if (!enabled()) throw fail(400, 'Es ist noch keine Admin-PIN festgelegt')
      if (!(await checkPin(pin, req))) throw fail(403, 'PIN falsch')
      if (authenticatedVersion !== secret.version || authenticatedRevision !== adminRevision)
        throw fail(401, 'Admin-PIN wurde geändert – bitte erneut anmelden')
    } else {
      if (roleStatus(roleId) === null) throw fail(503, 'Rollen werden geladen – bitte kurz warten')
      if (!validRole(roleId)) throw fail(400, 'Bitte eine gültige Rolle wählen')
      if (gatewayActive() && !machineOf(req) && !deviceGrant(req)) throw fail(403, 'Bitte zuerst den Tagescode eingeben')
    }
    return lockRole(roleId, async () => {
      if (admin && (authenticatedVersion !== secret.version || authenticatedRevision !== adminRevision))
        throw fail(401, 'Admin-PIN wurde geändert – bitte erneut anmelden')
      prune()
      const ownSession = sessionOf(req)
      const ownGroup = ownSession?.group ?? ownSession?.id
      if (!admin) {
        const inKesher = ownSession?.roleId !== roleId && (await rolesInKesher()).has(roleId)
        if (roleStatus(roleId) === null) throw fail(503, 'Rollen werden geladen – bitte kurz warten')
        if (!validRole(roleId) || (gatewayActive() && !machineOf(req) && !deviceGrant(req)))
          throw fail(403, 'Die Rolle oder Gerätefreigabe ist nicht mehr gültig')
        const holders = Object.values(secret.sessions).filter((session) =>
          !session.admin && session.roleId === roleId && (session.group ?? session.id) !== ownGroup)
        const active = holders.filter(isActive)
        if (active.length) {
          const holder = active.sort((left, right) => right.seen - left.seen)[0]
          throw Object.assign(fail(409, 'Die Rolle ist schon angemeldet – von ' + holder.name + '. Bitte eine andere Rolle wählen.'),
            { holder: { name: holder.name, seen: holder.seen } })
        }
        if (inKesher)
          throw Object.assign(fail(409, 'Die Rolle ist schon angemeldet – direkt in Kesher. Bitte eine andere Rolle wählen.'),
            { holder: { name: KESHER_HOLDER, kesher: true } })
        endSessions(holders, 'abgelaufen')
      }
      if (ownSession)
        endSessions(Object.values(secret.sessions).filter((session) => (session.group ?? session.id) === ownGroup), 'neu angemeldet')
      const device = admin ? null : deviceGrant(req)
      const token = newSession({ name: cleanName, roleId, admin, device, machine: machineBinding(req) }, ipOf(req))
      res.setHeader('Set-Cookie', cookieFor(token, req))
      log('Zugang: ' + cleanName + ' angemeldet als ' + (admin ? 'Admin' : roleId))
    })
  }

  function logout(req, res) {
    const own = lookupSession(req)
    if (own) endSessions(Object.values(secret.sessions).filter((session) => (session.group ?? session.id) === (own.group ?? own.id)), 'abgemeldet')
    res.setHeader('Set-Cookie', COOKIE + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + secureSuffix(req))
  }

  async function setAdminPin({ pin, currentPin, source, off }, user, req) {
    if (off) throw fail(400, 'Die zentrale Anmeldung kann nicht ohne Admin-PIN betrieben werden')
    const authenticatedVersion = secret.version
    const authenticatedRevision = adminRevision
    if (enabled() && (!user?.admin || !(await checkPin(currentPin, req))))
      throw fail(403, 'Bisherige PIN falsch')
    if (!enabled() && !bootstrapping) throw fail(503, 'Sicherheitsdaten sind nicht eingerichtet')
    const value = String(pin ?? '').trim()
    let nextPin
    if (source === 'kesher') {
      if (!(await checkPin(value, req, verifyKesherPin))) throw fail(403, 'Das ist nicht die Admin-PIN von Kesher')
      nextPin = { kesher: true }
    } else {
      if (!/^\d{4,12}$/.test(value)) throw fail(400, 'Die PIN braucht 4 bis 12 Ziffern')
      nextPin = hashPin(value)
    }
    if (authenticatedVersion !== secret.version || authenticatedRevision !== adminRevision)
      throw fail(401, 'Admin-PIN wurde geändert – bitte erneut anmelden')
    const oldSessions = Object.values(secret.sessions)
    secret.adminPin = nextPin
    secret.version = randomToken()
    bootstrapping = false
    qrTokens.clear()
    ssoTickets.clear()
    endSessions(oldSessions, 'Admin-PIN geändert')
    write()
    log('Zugang: Admin-PIN aktualisiert – bestehende Sitzungen widerrufen')
  }

  function createQrToken(user, req) {
    prune()
    const session = rawSessionById(user?.sessionId)
    if (!validSession(session) || session.version !== user?.version || lookupSession(req)?.id !== session.id)
      throw fail(401, 'Bitte erneut anmelden')
    const grant = deviceGrant(req)
    if (!session.admin && gatewayActive() && !grant && !machineOf(req))
      throw fail(403, 'Bitte zuerst den Tagescode eingeben')
    const token = randomToken()
    const expires = Math.min(Date.now() + QR_TTL_MS, session.expiresAt, grant?.expiresAt ?? Infinity)
    qrTokens.set(sha256(token), { id: session.id, version: session.version, device: grant, machine: session.machine, expires })
    return { token, expiresInMs: expires - Date.now() }
  }

  function approveDevice(ip, req, res, grant) {
    if (!validGrant(grant)) throw fail(403, 'Die Gerätefreigabe ist nicht mehr gültig')
    if (grant.ipGrant) return // gilt über die IP-Adresse, kein Cookie nötig
    const token = randomToken()
    if (grant.permanent) {
      // Derselbe Browser unter einer anderen Adresse (SSO): gleiche Freigabe, gemeinsam widerrufbar
      const known = Object.values(secret.devices).find((d) => d.permanent && d.id === grant.id)
      secret.devices[sha256(token)] = { permanent: true, id: grant.id, name: known?.name ?? grant.name, expiresAt: grant.expiresAt, created: known?.created ?? Date.now(), seen: Date.now(), ip: String(ip ?? '') }
    } else {
      secret.devices[sha256(token)] = { gen: grant.gen, expiresAt: grant.expiresAt, created: Date.now(), ip: String(ip ?? '') }
    }
    write()
    res.append('Set-Cookie', deviceCookie(token, grant.expiresAt, req))
  }

  /** Cookie der Gerätefreigabe; ohne Ablauf so lange, wie Browser es halten (wird erneuert) */
  function deviceCookie(token, expiresAt, req) {
    const maxAge = Math.max(0, Math.ceil((expiresAt == null ? COOKIE_MAX_MS : Math.min(COOKIE_MAX_MS, expiresAt - Date.now())) / 1000))
    return DEVICE_COOKIE + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + maxAge + secureSuffix(req)
  }

  /** Dauerhafte Freigabe ohne Ablauf: Cookie bei jedem Besuch erneuern, damit der Browser es nicht vergisst */
  function refreshDeviceCookie(req, res) {
    const token = parseCookies(req?.headers?.cookie)[DEVICE_COOKIE]
    const grant = token ? secret.devices[sha256(token)] : null
    if (grant?.permanent && validGrant(grant)) res.append('Set-Cookie', deviceCookie(token, grant.expiresAt, req))
  }

  function redeemQrToken(token, req, res) {
    const key = sha256(String(token || ''))
    const entry = qrTokens.get(key)
    qrTokens.delete(key)
    if (!entry || entry.expires <= Date.now()) return false
    const sourceSession = rawSessionById(entry.id)
    if (!validSession(sourceSession) || sourceSession.version !== entry.version || (entry.device && !validGrant(entry.device))) return false
    if (!matchesMachine(req, entry.machine)) return false
    if (!sourceSession.admin && gatewayActive() && !entry.device && !machineOf(req) && !deviceGrant(req)) return false
    const own = lookupSession(req)
    if (own && own.id !== sourceSession.id && own.group !== sourceSession.group) endSessions([own], 'neu angemeldet')
    // Ein dauerhaft freigeschaltetes Gerät gibt per QR-Code nur die Freigabe für heute weiter
    const device = entry.device?.permanent || entry.device?.ipGrant ? todayGrant() : entry.device
    const sessionToken = newSession({
      name: sourceSession.name, roleId: sourceSession.roleId, admin: sourceSession.admin, group: sourceSession.group,
      originSessionId: sourceSession.id, expiresAt: sourceSession.expiresAt, device, machine: entry.machine,
    }, ipOf(req))
    res.append('Set-Cookie', cookieFor(sessionToken, req))
    if (device) approveDevice(ipOf(req), req, res, device)
    return true
  }

  function validAudience(origin) {
    try {
      const parsed = new URL(origin)
      return parsed.protocol === 'https:' && parsed.origin === origin && !parsed.username && !parsed.password
    } catch {
      return false
    }
  }

  function createSsoTicket(ip, req, { audienceOrigin, codeChallenge } = {}) {
    const user = userOf(req)
    if (!user) return null
    if (!validAudience(audienceOrigin) || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge ?? ''))
      throw fail(400, 'Ungültiger SSO-Ziel- oder Browsernachweis')
    prune()
    const session = rawSessionById(user.sessionId)
    const device = deviceGrant(req)
    if (!session || (!session.admin && gatewayActive() && !machineOf(req) && !device)) return null
    const ticket = randomToken()
    ssoTickets.set(sha256(ticket), {
      id: session.id, version: session.version, device, machine: session.machine, audienceOrigin, codeChallenge,
      expires: Math.min(Date.now() + SSO_TTL_MS, session.expiresAt, device?.expiresAt ?? Infinity),
    })
    return ticket
  }

  function redeemSsoTicket(ticket, ip, req, res, { audienceOrigin, codeVerifier } = {}) {
    const key = sha256(String(ticket || ''))
    const entry = ssoTickets.get(key)
    if (!entry || entry.expires <= Date.now()) {
      ssoTickets.delete(key)
      return false
    }
    if (entry.audienceOrigin !== audienceOrigin || !/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier ?? '')) return false
    const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
    if (!crypto.timingSafeEqual(Buffer.from(challenge), Buffer.from(entry.codeChallenge))) return false
    ssoTickets.delete(key)
    const session = rawSessionById(entry.id)
    if (!validSession(session) || session.version !== entry.version || (entry.device && !validGrant(entry.device))) return false
    if (!matchesMachine(req, entry.machine)) return false
    if (!session.admin && gatewayActive() && !entry.device && !machineOf(req) && !deviceGrant(req)) return false
    const ownSession = lookupSession(req)
    if (ownSession && ownSession.id !== session.id && ownSession.group !== session.group) endSessions([ownSession], 'neu angemeldet')
    const token = randomToken()
    secret.sessions[sha256(token)] = session
    write()
    res.append('Set-Cookie', cookieFor(token, req))
    if (entry.device) approveDevice(ip, req, res, entry.device)
    return true
  }

  function sessions() {
    prune()
    const unique = new Map()
    for (const session of Object.values(secret.sessions))
      if (!unique.has(session.id) || unique.get(session.id).seen < session.seen) unique.set(session.id, session)
    return [...unique.values()]
      .map(({ id, name, roleId, admin, created, seen, ip, expiresAt }) =>
        ({ id, name, roleId, admin, created, seen, expiresAt, ip: ip || null, live: isLive(id) }))
      .sort((left, right) => right.seen - left.seen)
  }

  function endSession(id) {
    const session = rawSessionById(id)
    if (session) endSessions(Object.values(secret.sessions).filter((entry) => (entry.group ?? entry.id) === (session.group ?? session.id)), 'vom Admin abgemeldet')
  }

  function revokeAdmins(reason = 'Admin-PIN geändert') {
    adminRevision++
    endSessions(Object.values(secret.sessions).filter((session) => session.admin), reason)
  }

  function gateway() {
    return { ...secret.gateway, active: gatewayActive() }
  }

  function setGateway(next) {
    const given = Object.fromEntries(Object.entries(next ?? {}).filter(([, value]) => value !== undefined))
    const normalized = normalizeGateway({ ...secret.gateway, ...given })
    if (normalized.enabled && !enabled()) throw fail(400, 'Erst die Admin-PIN einrichten – ohne sie gibt es keine Anmeldung')
    if (next?.exempt !== undefined && (!Array.isArray(next.exempt) || next.exempt.length))
      throw fail(400, 'IP-Ausnahmen sind nicht mehr zulässig – bitte einen Gerätenachweis registrieren')
    secret.gateway = normalized
    write()
    return gateway()
  }

  const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')

  function dayCode(now = Date.now()) {
    const { day } = localTime(now)
    const current = secret.dayCode
    if (current?.day !== day) {
      const prevGen = current?.day === previousDay(day) ? current.gen : null
      secret.dayCode = { day, code: newCode(), gen: crypto.randomBytes(12).toString('hex'), prevGen }
      write()
      prune()
    }
    return secret.dayCode
  }

  function renewDayCode() {
    secret.dayCode = { day: localTime().day, code: newCode(), gen: crypto.randomBytes(12).toString('hex'), prevGen: null }
    write()
    prune()
    return secret.dayCode
  }

  function devicesToday() {
    prune()
    return Object.values(secret.devices).filter((device) => !device.permanent && validGrant(device)).length
  }

  /**
   * Gerät dauerhaft freischalten (nur ein Admin): ohne IP diesen Browser (Cookie), mit IP ein
   * anderes Gerät über seine feste Adresse. unlimited = ohne Ablauf, sonst ein Jahr.
   */
  function approvePermanent({ name, ip, unlimited } = {}, req, res) {
    if (!userOf(req)?.admin) throw fail(403, 'Nur ein Admin kann Geräte dauerhaft freischalten')
    const label = String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 40)
    if (!label) throw fail(400, 'Bitte einen Namen für das Gerät eingeben, z. B. „Regie-Mac“')
    const now = Date.now()
    const expiresAt = unlimited ? null : now + PERMANENT_MS
    const address = String(ip ?? '').trim()
    if (address) {
      const parsed = parseNetwork(address)
      if (!parsed?.v4 || parsed.bits !== 32) throw fail(400, 'Bitte eine einzelne IPv4-Adresse eingeben, z. B. 192.168.0.42')
      const clean = parsed.text.split('.').map(Number).join('.')
      if (!ipInNetworks(clean, IP_GRANT_NETWORKS)) throw fail(400, 'Nur Adressen aus dem eigenen Netz (192.168.x.x, 10.x.x.x, 172.16–31.x.x) oder von Tailscale (100.64–127.x.x)')
      if (ownAddresses().includes(clean)) throw fail(400, 'Das ist die Adresse des Servers selbst')
      const existing = Object.values(secret.ipGrants).find((g) => g.ip === clean)
      if (existing) Object.assign(existing, { name: label, expiresAt })
      else {
        const id = crypto.randomBytes(9).toString('hex')
        secret.ipGrants[id] = { id, name: label, ip: clean, created: now, seen: null, expiresAt }
      }
      write()
      log(`Zugang: Gerät „${label}“ mit fester IP ${clean} dauerhaft freigeschaltet${unlimited ? ' (ohne Ablauf)' : ''}`)
      return permanentDevices(req)
    }
    const token = parseCookies(req?.headers?.cookie)[DEVICE_COOKIE]
    const current = token ? secret.devices[sha256(token)] : null
    if (current?.permanent && validGrant(current)) {
      // Schon dauerhaft: umbenennen und Ablauf neu setzen
      for (const device of Object.values(secret.devices)) if (device.permanent && device.id === current.id) Object.assign(device, { name: label, expiresAt })
      write()
      res.append('Set-Cookie', deviceCookie(token, expiresAt, req))
    } else {
      const fresh = randomToken()
      secret.devices[sha256(fresh)] = { permanent: true, id: crypto.randomBytes(9).toString('hex'), name: label, expiresAt, created: now, seen: now, ip: String(ipOf(req) ?? '') }
      write()
      res.append('Set-Cookie', deviceCookie(fresh, expiresAt, req))
    }
    log(`Zugang: Gerät „${label}“ (${ipOf(req)}) dauerhaft freigeschaltet${unlimited ? ' (ohne Ablauf)' : ''}`)
    return permanentDevices(req)
  }

  /** Dauerhaft freigeschaltete Geräte: Browser (je Gerät einmal, auch unter mehreren Adressen) und feste IPs */
  function permanentDevices(req) {
    prune()
    const own = deviceGrant(req)
    const byId = new Map()
    for (const d of Object.values(secret.devices)) {
      if (!d.permanent) continue
      const entry = byId.get(d.id)
      if (!entry) byId.set(d.id, { id: d.id, kind: 'browser', name: d.name, created: d.created, expiresAt: d.expiresAt ?? null, seen: d.seen ?? d.created, ip: d.ip || null })
      else if ((d.seen ?? 0) > entry.seen) Object.assign(entry, { seen: d.seen, ip: d.ip || entry.ip })
    }
    for (const g of Object.values(secret.ipGrants))
      byId.set(g.id, { id: g.id, kind: 'ip', name: g.name, created: g.created, expiresAt: g.expiresAt ?? null, seen: g.seen ?? null, ip: g.ip })
    return [...byId.values()]
      .map((d) => ({ ...d, current: Boolean(own && (own.permanent || own.ipGrant) && own.id === d.id) }))
      .sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0))
  }

  /** Widerrufen: Freigabe weg, Rollen-Anmeldungen dieses Geräts enden sofort */
  function revokePermanent(id) {
    let found = false
    for (const [key, device] of Object.entries(secret.devices))
      if (device.permanent && device.id === id) {
        delete secret.devices[key]
        found = true
      }
    if (secret.ipGrants[id]) {
      delete secret.ipGrants[id]
      found = true
    }
    if (!found) throw fail(404, 'Gerät nicht gefunden')
    write()
    prune()
    log(`Zugang: dauerhafte Freigabe ${id} widerrufen`)
  }

  function redeemDayCode(code, ip, req, res) {
    trimFailures(secret.codeFails, CODE_FAIL_WINDOW_MS)
    const key = sha256(String(ip ?? '').replace(/^::ffff:/i, '').slice(0, 160))
    if ((secret.codeFails[key]?.count ?? 0) >= CODE_MAX_FAILS)
      throw fail(429, 'Zu viele falsche Versuche – bitte in 15 Minuten noch einmal')
    const current = dayCode()
    const given = String(code ?? '').trim()
    const matches = /^\d{6}$/.test(given) && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(current.code))
    if (!matches) {
      const entry = secret.codeFails[key] ?? { count: 0, since: Date.now() }
      entry.count++
      secret.codeFails[key] = entry
      write()
      throw fail(403, 'Der Code stimmt nicht – es gilt immer nur der Code von heute')
    }
    delete secret.codeFails[key]
    approveDevice(ip, req, res, { gen: current.gen, expiresAt: nextMorning() })
    log('Zugang: Gerät ' + ip + ' mit dem Tagescode freigeschaltet')
  }

  function deviceStatus(ip, req) {
    const session = lookupSession(req)
    const machine = machineOf(req)
    const required = gatewayActive() && !machine && !session?.admin
    const grant = deviceGrant(req)
    return {
      required, approved: !required || Boolean(grant), hasGrant: Boolean(grant),
      permanent: grant?.permanent || grant?.ipGrant ? { name: grant.name, expiresAt: grant.expiresAt ?? null, ip: grant.ipGrant ? grant.ip : null } : null,
      // Kann das Gerät freigeschaltet werden? Auch in einer Admin-Sitzung (die selbst keinen Code
      // braucht): Wechselt man zu einer Rolle, braucht das Gerät die Freigabe doch
      grantable: gatewayActive() && !machine && !grant,
      generation: grant?.gen ?? null, expiresAt: grant?.expiresAt ?? (session?.admin ? session.expiresAt : machine?.expiresAt ?? null),
    }
  }

  function trusted(ip, req) {
    const machine = machineOf(req)
    return Boolean(userOf(req)) || Boolean(machine?.mode === 'station' && machine.services.includes('multiview'))
  }

  function check({ service, ip }, req) {
    if (!gatewayActive()) return { action: 'allow', user: null }
    const level = SERVICE_LEVELS[service] ?? 'admin'
    const user = userOf(req)
    const machine = machineOf(req)
    if (!user && machine?.mode === 'station' && level === 'user' && machineServes(machine, service)) return { action: 'allow', user }
    if (!machine && !user?.admin && !deviceGrant(req)) return { action: 'code', user }
    if (!user) return { action: 'login', user: null }
    if (level === 'admin' && !user.admin) return { action: 'forbidden', user }
    return { action: 'allow', user }
  }

  /** Darf das feste Gerät den Dienst nutzen? Kesher auch nur zum Spiegeln seiner Kachel-Rollen. */
  function machineServes(machine, service) {
    return Boolean(machine?.services?.includes(service) || (service === 'kesher' && machine?.mirrorRoles?.length))
  }

  function createTicket(user, audience, key, { mirror = null } = {}) {
    if (!key) throw fail(503, 'JMS_AUTH_SECRET ist nicht eingerichtet')
    const session = rawSessionById(user?.sessionId)
    if (!validSession(session) || session.version !== user?.version) throw fail(401, 'Bitte erneut anmelden')
    const payload = Buffer.from(JSON.stringify({
      name: session.name, roleId: session.roleId, admin: session.admin, aud: audience,
      sid: session.id, exp: Math.min(Date.now() + 60_000, session.expiresAt),
      sessionExpiresAt: session.expiresAt, ver: session.version, version: session.version, jti: randomToken(),
      ...(mirror ? { mirror } : {}),
    })).toString('base64url')
    const signature = crypto.createHmac('sha256', key).update(payload).digest('base64url')
    return payload + '.' + signature
  }

  return {
    enabled, pinSource, userOf, sessionOf, sessionIdOf, sessionStatusById, occupiedRoles, occupiedForLogin,
    login, createSsoTicket, redeemSsoTicket, logout, setAdminPin, createQrToken, redeemQrToken, sessions, endSession, revokeAdmins,
    gateway, setGateway, dayCode, renewDayCode, deviceStatus, devicesToday, redeemDayCode, check, trusted, createTicket,
    approvePermanent, permanentDevices, revokePermanent, refreshDeviceCookie,
    listMachines, createMachine, rotateMachine, reassignPiMachines, revokeMachine, machineOf, machineStatus, machineByFingerprint, machineServes,
    prune, sweep: prune, flush: write,
  }
}

// ---------------------------------------------------------------------------
// Rechte auf Layouts und Multiviews
// ---------------------------------------------------------------------------

function roleRights(config, user) {
  if (!user) return null
  if (user.admin) return { admin: true }
  const roles = config.access?.roles ?? {}
  return { admin: false, ...normalizeRole(Object.hasOwn(roles, user.roleId) ? roles[user.roleId] : null) }
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
    if (wanted?.dayQr && typeof wanted.dayQr === 'object') {
      output.dayQr = {
        show: wanted.dayQr.show === true,
        corner: ['tl', 'tr', 'bl', 'br'].includes(wanted.dayQr.corner) ? wanted.dayQr.corner : (output.dayQr?.corner || 'br'),
        size: ['s', 'm', 'l'].includes(wanted.dayQr.size) ? wanted.dayQr.size : (output.dayQr?.size || 's'),
      }
    }
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
