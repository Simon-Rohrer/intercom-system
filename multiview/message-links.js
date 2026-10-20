'use strict'

// Nachrichten-Links: Ordner und andere Helfer schicken eine Meldung auf den Beamer oder das
// Stage Display, ohne sich anzumelden. Der Admin legt je Gruppe einen Link an (als QR zum
// Aufhängen oder Weitergeben) und legt fest, wohin er schicken darf. Wer den Link hat, gibt
// nur seinen Namen ein. Der Link lässt sich jederzeit sperren oder durch einen neuen ersetzen.
//
// Beamer-Meldungen zeigt weiterhin nur der ProPresenter-Bediener an (wie aus der Fernbedienung).
// Damit ein geteilter Link nicht missbraucht wird, gibt es eine Bremse je Link.
//
// Die Links liegen in data/message-links.json (nicht in config.json – die ist ohne Anmeldung lesbar).

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const MIN_GAP_MS = 10 * 1000 // höchstens eine Nachricht alle 10 Sekunden je Link
const MAX_PER_HOUR = 30
const NAME_MAX = 40

function createMessageLinks({ dataDir }) {
  const file = path.join(dataDir, 'message-links.json')
  const sent = new Map() // Link-ID → Zeitpunkte der letzten Nachrichten

  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(data?.links) ? data.links : []
    } catch {
      return []
    }
  }

  function write(links) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ links }, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
  const newToken = () => crypto.randomBytes(18).toString('base64url')
  const newId = () => crypto.randomBytes(6).toString('hex')

  function normalize(input, old = {}) {
    const name = clean(input.name ?? old.name, NAME_MAX)
    if (!name) throw Object.assign(new Error('Bitte einen Namen für den Link eingeben, z. B. „Ordner“'), { status: 400 })
    const stage = Boolean(input.stage ?? old.stage)
    const beamer = Boolean(input.beamer ?? old.beamer)
    if (!stage && !beamer) throw Object.assign(new Error('Bitte mindestens Beamer oder Stage Display erlauben'), { status: 400 })
    return { name, stage, beamer }
  }

  return {
    list: () => read(),

    create(input) {
      const links = read()
      const link = { id: newId(), token: newToken(), ...normalize(input || {}), enabled: true, created: Date.now(), used: 0, lastUsed: null }
      links.push(link)
      write(links)
      return link
    },

    update(id, input) {
      const links = read()
      const link = links.find((l) => l.id === id)
      if (!link) throw Object.assign(new Error('Diesen Link gibt es nicht mehr'), { status: 404 })
      Object.assign(link, normalize(input || {}, link))
      if (input?.enabled != null) link.enabled = Boolean(input.enabled)
      // Neuer Link: der alte (und alle ausgedruckten QR-Codes) gilt sofort nicht mehr
      if (input?.renew) link.token = newToken()
      write(links)
      return link
    },

    remove(id) {
      const links = read()
      const rest = links.filter((l) => l.id !== id)
      if (rest.length === links.length) throw Object.assign(new Error('Diesen Link gibt es nicht mehr'), { status: 404 })
      write(rest)
    },

    /** Gültiger, eingeschalteter Link zu einem Token – sonst null. */
    byToken(token) {
      const value = String(token || '')
      if (value.length < 16) return null
      const want = Buffer.from(value)
      return (
        read().find((l) => {
          const have = Buffer.from(String(l.token))
          return l.enabled && have.length === want.length && crypto.timingSafeEqual(have, want)
        }) ?? null
      )
    },

    /** Bremse: wirft, wenn über diesen Link gerade zu viel geschickt wurde. */
    check(link, now = Date.now()) {
      const times = (sent.get(link.id) ?? []).filter((t) => now - t < 3600_000)
      const last = times[times.length - 1]
      if (last && now - last < MIN_GAP_MS)
        throw Object.assign(new Error(`Bitte ${Math.ceil((MIN_GAP_MS - (now - last)) / 1000)} Sekunden warten`), { status: 429 })
      if (times.length >= MAX_PER_HOUR)
        throw Object.assign(new Error('Über diesen Link wurde gerade sehr viel geschickt – bitte später nochmal'), { status: 429 })
    },

    /** Geschickte Nachricht zählen (nur wenn sie angekommen ist). */
    record(link, now = Date.now()) {
      const times = (sent.get(link.id) ?? []).filter((t) => now - t < 3600_000)
      times.push(now)
      sent.set(link.id, times)
      const links = read()
      const stored = links.find((l) => l.id === link.id)
      if (stored) {
        stored.used = (stored.used || 0) + 1
        stored.lastUsed = now
        write(links)
      }
    },

    cleanName: (v) => clean(v, NAME_MAX),
  }
}

module.exports = { createMessageLinks }
