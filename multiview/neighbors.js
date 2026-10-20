'use strict'

// MAC-Adresse zu einer Geräteadresse, aus der Nachbartabelle des Servers (`ip neigh`; der
// Multiview läuft mit network_mode host). Dasselbe Gerät kommt über die .local-Namen oft per
// IPv6 (fe80::…) an, über die IP-Adresse per IPv4 – die MAC-Adresse ist in beiden Fällen gleich.

const { execFileSync } = require('child_process')

const CACHE_MS = 3000
// Container-Netze auf dem Server selbst (Docker-Brücken) zählen nicht als Geräte im LAN
const DOCKER_DEV = /^(docker\d*|br-|veth)/

const normalize = (ip) =>
  String(ip ?? '')
    .replace(/^::ffff:/i, '')
    .replace(/%.*$/, '')
    .toLowerCase()

function createNeighbors({
  read = () => execFileSync('ip', ['-j', 'neigh', 'show'], { encoding: 'utf8', timeout: 1000 }),
  log = console.log,
} = {}) {
  let table = new Map()
  let loadedAt = null
  let warned = false

  function load() {
    loadedAt = Date.now()
    try {
      const next = new Map()
      for (const neighbor of JSON.parse(read() || '[]'))
        if (neighbor?.dst && /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/i.test(neighbor?.lladdr ?? '') &&
          !DOCKER_DEV.test(neighbor.dev ?? '') && !(neighbor.state ?? []).some((state) => ['FAILED', 'INCOMPLETE'].includes(state)))
          next.set(normalize(neighbor.dst), String(neighbor.lladdr).toLowerCase())
      table = next
      warned = false
    } catch (err) {
      table = new Map()
      if (!warned) log(`Zugang: Nachbartabelle nicht lesbar (${err.message}) – Geräte nur an ihrer Adresse erkannt`)
      warned = true
    }
  }

  function macOf(ip) {
    const addr = normalize(ip)
    if (!addr) return null
    if (loadedAt === null || Date.now() - loadedAt >= CACHE_MS || Date.now() < loadedAt) load()
    return table.get(addr) ?? null
  }

  return { macOf }
}

module.exports = { createNeighbors }
