'use strict'

// Raspberry-Pi-Stationen (Kesher-Kiosk) – im Multiview unter Einstellungen → Raspberry Pis.
// Bisher stand alles in /etc/kesher/raspberry-pis.json auf jedem Pi. Jetzt fragt der Launcher
// auf dem Pi beim Start (und danach alle paar Sekunden) hier nach seiner Konfiguration – die
// Datei auf dem Pi braucht nur noch config_url (und ggf. heartbeat_secret).
// Geheimnisse stehen hier bewusst nicht drin: die Konfiguration geht an alle Seiten des Multiview.

const VIEWS = ['standard', 'station', 'simple']
const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const text = (v) => (typeof v === 'string' ? v.trim() : '')
const noSpaces = (v) => text(v).replace(/\s+/g, '-')

function normalizeMac(v) {
  const mac = text(v).toLowerCase().replace(/-/g, ':')
  return MAC_RE.test(mac) ? mac : ''
}

function normalizeIp(v) {
  const m = IPV4_RE.exec(text(v))
  return m && m.slice(1).every((n) => Number(n) <= 255) ? m.slice(1).map(Number).join('.') : ''
}

/** "192.168.0.21:8443" → "https://192.168.0.21:8443", leer bleibt leer (dann gilt die Datei auf dem Pi). */
function normalizeServerUrl(v) {
  const url = text(v).replace(/\/+$/, '')
  if (!url) return ''
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

/** Sekunden (leer = Standard des Launchers). */
function seconds(v) {
  if (v === '' || v === null || v === undefined) return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 600 ? n : null
}

/** Gerät-ID aus dem Namen: „Kamera 2“ → „kamera-2-pi“. */
function deviceIdFromName(name) {
  const base = String(name || '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base ? `${base}-pi` : ''
}

function normalizeClient(c, index) {
  const name = noSpaces(c?.name)
  const macs = [...new Set((Array.isArray(c?.macAddresses) ? c.macAddresses : []).map(normalizeMac).filter(Boolean))]
  return {
    id: text(c?.id) || `pi${index + 1}`,
    name,
    deviceId: noSpaces(c?.deviceId) || deviceIdFromName(name),
    roleId: text(c?.roleId),
    macAddresses: macs,
    ipAddress: normalizeIp(c?.ipAddress),
    audioInputMatch: text(c?.audioInputMatch),
    audioOutputMatch: text(c?.audioOutputMatch),
    lowPowerMode: c?.lowPowerMode === true,
    view: VIEWS.includes(c?.view) ? c.view : 'standard',
  }
}

function normalizeRaspberry(r) {
  return {
    // Erst wenn das an ist, gilt diese Konfiguration statt der Datei auf den Pis
    managed: r?.managed === true,
    serverUrl: normalizeServerUrl(r?.serverUrl),
    allowInsecureTls: r?.allowInsecureTls !== false,
    browserBinary: text(r?.browserBinary),
    audioWaitSeconds: seconds(r?.audioWaitSeconds),
    displaySettleSeconds: seconds(r?.displaySettleSeconds),
    connectTimeoutSeconds: seconds(r?.connectTimeoutSeconds),
    clients: (Array.isArray(r?.clients) ? r.clients : []).map(normalizeClient),
  }
}

/** Passt der Eintrag zu diesem Pi? Über eine MAC-Adresse oder – ohne MACs – über die IP. */
function clientMatches(client, macs, ips) {
  if (client.macAddresses.length) return client.macAddresses.some((m) => macs.includes(m))
  return Boolean(client.ipAddress) && ips.includes(client.ipAddress)
}

/** Ein Eintrag ist erst vollständig mit Name, Rolle und MAC oder IP – sonst bekommt der Pi ihn nicht. */
function clientComplete(client) {
  return Boolean(client.name && client.roleId && client.deviceId && (client.macAddresses.length || client.ipAddress))
}

function launcherClient(c) {
  const out = { device_id: c.deviceId, name: c.name, role_id: c.roleId, low_power_mode: c.lowPowerMode }
  if (c.macAddresses.length) out.mac_addresses = c.macAddresses
  if (c.ipAddress) out.ip_address = c.ipAddress
  if (c.audioInputMatch) out.audio_input_match = c.audioInputMatch
  if (c.audioOutputMatch) out.audio_output_match = c.audioOutputMatch
  if (c.view !== 'standard') out.simple_view = c.view === 'simple'
  return out
}

/**
 * Antwort für den Launcher (Feldnamen wie in raspberry-pis.json). Nur die Einträge, die zu
 * diesem Pi passen – die anderen Pis gehen ihn nichts an.
 */
function launcherConfig(raspberry, { macs = [], ips = [] } = {}) {
  if (!raspberry?.managed) return { managed: false }
  const config = {
    allow_insecure_tls: raspberry.allowInsecureTls,
    clients: raspberry.clients.filter((c) => clientComplete(c) && clientMatches(c, macs, ips)).map(launcherClient),
  }
  if (raspberry.serverUrl) config.server_url = raspberry.serverUrl
  if (raspberry.browserBinary) config.browser_binary = raspberry.browserBinary
  if (raspberry.audioWaitSeconds !== null) config.audio_runtime_wait_seconds = raspberry.audioWaitSeconds
  if (raspberry.displaySettleSeconds !== null) config.display_runtime_settle_seconds = raspberry.displaySettleSeconds
  if (raspberry.connectTimeoutSeconds !== null) config.browser_connect_timeout_seconds = raspberry.connectTimeoutSeconds
  return { managed: true, config }
}

/** Was ein Pi über sich schickt, aufgeräumt (er ist nicht angemeldet – nichts davon ist vertrauenswürdig). */
function parsePiRequest(body) {
  const list = (v, fn) => [...new Set((Array.isArray(v) ? v : []).slice(0, 16).map(fn).filter(Boolean))].sort()
  const local = body?.local && typeof body.local === 'object' ? body.local : null
  return {
    macs: list(body?.macs, normalizeMac),
    ips: list(body?.ips, normalizeIp),
    hostname: text(body?.hostname).slice(0, 64),
    launcherVersion: text(body?.launcherVersion).slice(0, 16),
    // Eintrag aus der Datei auf dem Pi – damit man ihn hier mit einem Klick übernehmen kann
    local: local
      ? normalizeClient(
          {
            name: local.name,
            deviceId: local.device_id,
            roleId: local.role_id,
            macAddresses: local.mac_addresses,
            ipAddress: local.ip_address,
            audioInputMatch: local.audio_input_match,
            audioOutputMatch: local.audio_output_match,
            lowPowerMode: local.low_power_mode,
            view: local.simple_view === true ? 'simple' : local.simple_view === false ? 'station' : 'standard',
          },
          0,
        )
      : null,
    localServerUrl: normalizeServerUrl(body?.localServerUrl),
  }
}

/** Merkt sich, welche Pis zuletzt nach ihrer Konfiguration gefragt haben (nur im Speicher). */
function createPiRegistry({ now = Date.now, max = 50 } = {}) {
  const seen = new Map()
  return {
    record(request, ip) {
      if (!request.macs.length && !request.ips.length) return
      const key = request.macs.join(',') || request.ips.join(',')
      seen.delete(key)
      seen.set(key, { ...request, remoteIp: normalizeIp(String(ip || '').replace(/^::ffff:/, '')), seen: now() })
      while (seen.size > max) seen.delete(seen.keys().next().value)
    },
    list() {
      return [...seen.values()].map((p) => ({ ...p, ageMs: now() - p.seen })).sort((a, b) => a.ageMs - b.ageMs)
    },
  }
}

module.exports = {
  normalizeRaspberry, launcherConfig, parsePiRequest, createPiRegistry, deviceIdFromName, clientComplete,
}
