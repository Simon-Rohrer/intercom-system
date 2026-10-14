'use strict'

// MAC-Adresse zu einer Geräteadresse, aus der Nachbartabelle des Servers (`ip neigh`; der
// Multiview läuft mit network_mode host). Dasselbe Gerät kommt über die .local-Namen oft per
// IPv6 (fe80::…) an, über die IP-Adresse per IPv4 – die MAC-Adresse ist in beiden Fällen gleich.

const { execFileSync } = require('child_process')

const CACHE_MS = 3000

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
  let loadedAt = 0
  let warned = false

  function load() {
    loadedAt = Date.now()
    try {
      const next = new Map()
      for (const n of JSON.parse(read() || '[]')) if (n?.dst && n?.lladdr) next.set(normalize(n.dst), String(n.lladdr).toLowerCase())
      table = next
    } catch (err) {
      if (!warned) log(`Zugang: Nachbartabelle nicht lesbar (${err.message}) – Geräte nur an ihrer Adresse erkannt`)
      warned = true
    }
  }

  /** MAC-Adresse zur Adresse oder null. Unbekannte Adressen lösen höchstens alle 3 s ein neues Lesen aus. */
  function macOf(ip) {
    const addr = normalize(ip)
    if (!addr) return null
    if (!table.has(addr) && Date.now() - loadedAt > CACHE_MS) load()
    return table.get(addr) ?? null
  }

  return { macOf }
}

module.exports = { createNeighbors }
