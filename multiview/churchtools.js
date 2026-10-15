'use strict'

// ChurchTools: Der Server ist mit einem eigenen Konto per REST-API verbunden
// (Login-Token, Header "Authorization: Login <token>") und verteilt die Abläufe
// der heutigen Events an alle Multiview-Seiten. Der Token liegt getrennt von der
// übrigen Konfiguration und wird nie an Browser geschickt.

const fs = require('fs')
const path = require('path')

const REFRESH_MS = 60 * 1000
const MAX_DAYS = 10 // so viele verschiedene Tage werden höchstens abgefragt
const LOOKAHEAD_DAYS = 42 // so weit voraus wird das nächste Event gesucht
const RETRY_MS = 15 * 1000
const TIMEOUT_MS = 10 * 1000

/** "jms.church.tools" → "https://jms.church.tools" (ohne /api und Schrägstrich am Ende) */
function normalizeUrl(url) {
  let u = String(url || '').trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`
  return u.replace(/\/+$/, '').replace(/\/api$/i, '')
}

/** Datum (YYYY-MM-DD) in der Zeitzone der Veranstaltungen. */
function dateIn(timeZone, date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

class ChurchToolsError extends Error {
  constructor(message, status) {
    super(message)
    this.status = status
  }
}

/** "2026-10-15" → "2026-10-16" */
function nextDay(day) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

/** "2026-10-15", 3 → "2026-10-18" */
function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Passt ein Event zum Filter einer Kachel (Name oder Kalender enthält)? Wie pickEvent in agenda.js. */
function matchesFilter(event, filter) {
  const f = String(filter || '').trim().toLowerCase()
  return !f || event.name.toLowerCase().includes(f) || (event.calendar || '').toLowerCase().includes(f)
}

/** Gültiges Datum im Format YYYY-MM-DD? */
function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) && !Number.isNaN(Date.parse(value))
}

function createChurchTools({ dataDir, getConfig, getDates = () => [], getFilters = () => [], onUpdate, log = console.log }) {
  const secretFile = path.join(dataDir, 'churchtools-secret.json')
  let secret = readSecret() // { url, token, user }
  let state = secret?.token ? 'connecting' : 'unconfigured'
  let error = ''
  let date = '' // heute
  let days = {} // { 'YYYY-MM-DD': events[] }
  let upcoming = [] // je Filter das nächste Event ab morgen, für Kacheln „Nächstes Event“
  let daysKey = ''
  let lastPublished = ''
  let timer = null
  let refreshing = null

  function readSecret() {
    try {
      return JSON.parse(fs.readFileSync(secretFile, 'utf8'))
    } catch {
      return null
    }
  }

  function writeSecret(next) {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${secretFile}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, secretFile)
    secret = next
  }

  const timeZone = () => getConfig()?.timeZone || 'Europe/Berlin'

  function snapshot() {
    return {
      type: 'churchtools',
      state,
      error,
      url: secret?.url || '',
      user: secret?.user || '',
      date,
      timeZone: timeZone(),
      // Events von heute (für die Übersicht in den Einstellungen)
      events: days[date] || [],
      days,
      upcoming,
    }
  }

  function publish() {
    const snap = snapshot()
    const key = JSON.stringify(snap)
    if (key === lastPublished) return
    lastPublished = key
    onUpdate(snap)
  }

  async function request(base, pathname, { token, method = 'GET', body, headers = {} } = {}) {
    const res = await fetch(`${base}/api${pathname}`, {
      method,
      headers: {
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Login ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    let data = null
    const text = await res.text()
    try {
      data = text ? JSON.parse(text) : null
    } catch {
      data = null
    }
    if (!res.ok) {
      const detail = data?.message || data?.errors?.[0]?.message || text.slice(0, 120)
      throw new ChurchToolsError(`HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status)
    }
    return { data, res }
  }

  async function whoami(base, token) {
    const { data } = await request(base, '/whoami', { token })
    const p = data?.data
    if (!p?.id) throw new ChurchToolsError('Login-Token ungültig (nicht angemeldet)', 401)
    return [p.firstName, p.lastName].filter(Boolean).join(' ') || p.email || `Person ${p.id}`
  }

  /** Holt mit Benutzername und Passwort den dauerhaften Login-Token des Kontos. */
  async function tokenFromPassword(base, username, password) {
    try {
      const { data } = await request(base, '/login/token', { method: 'POST', body: { username, password } })
      if (data?.data?.token) return data.data.token
    } catch (err) {
      // Ältere ChurchTools-Versionen kennen /login/token noch nicht
      if (![404, 405].includes(err.status)) throw loginError(err)
    }
    let login
    try {
      login = await request(base, '/login', { method: 'POST', body: { username, password, rememberMe: false } })
    } catch (err) {
      throw loginError(err)
    }
    const status = login.data?.data?.status
    if (status === 'totp') throw new ChurchToolsError('Das Konto hat Zwei-Faktor-Anmeldung – für das Server-Konto bitte ausschalten')
    const personId = login.data?.data?.personId
    const cookies = login.res.headers.getSetCookie?.() ?? []
    const cookie = cookies.map((c) => c.split(';')[0]).join('; ')
    if (!personId || !cookie) throw new ChurchToolsError('Anmeldung fehlgeschlagen')
    const { data } = await request(base, `/persons/${personId}/logintoken`, { headers: { Cookie: cookie } })
    if (!data?.data) throw new ChurchToolsError('Kein Login-Token erhalten')
    return data.data
  }

  function loginError(err) {
    if (err.status === 400 || err.status === 401) return new ChurchToolsError('Benutzername oder Passwort falsch')
    if (err.status === 429) return new ChurchToolsError('Zu viele Anmeldeversuche – bitte kurz warten')
    return err
  }

  /** Verbindet mit Token oder Benutzername/Passwort. Wirft bei Fehlern. */
  async function connect({ url, token, username, password }) {
    const base = normalizeUrl(url)
    if (!base) throw new ChurchToolsError('Bitte die ChurchTools-Adresse eintragen')
    let t = String(token || '').trim()
    if (!t) {
      if (!username || !password) throw new ChurchToolsError('Bitte Login-Token oder Benutzername und Passwort eintragen')
      t = await tokenFromPassword(base, String(username).trim(), String(password))
    }
    const user = await whoami(base, t)
    writeSecret({ url: base, token: t, user })
    log(`ChurchTools: verbunden mit ${base} als ${user}`)
    state = 'connecting'
    error = ''
    days = {}
    publish()
    await refresh()
    return { url: base, user }
  }

  function disconnect() {
    try {
      fs.rmSync(secretFile, { force: true })
    } catch {
      // schon weg
    }
    secret = null
    state = 'unconfigured'
    error = ''
    days = {}
    upcoming = []
    publish()
  }

  /** Heute plus die fest gewählten Tage aller ChurchTools-Kacheln. */
  function wantedDays(today) {
    const extra = [...new Set(getDates().filter(isDate))].filter((d) => d !== today).sort()
    return [today, ...extra.slice(0, MAX_DAYS - 1)]
  }

  /** Filter der Kacheln „Nächstes Event“ (leer = alle Events). */
  function wantedFilters() {
    return [...new Set(getFilters().map((f) => String(f || '').trim().toLowerCase()))].sort()
  }

  function wantedKey(today) {
    return JSON.stringify([wantedDays(today), wantedFilters()])
  }

  /** Nach einer Änderung der Kacheln: neu gewählte Tage und Filter sofort laden. */
  function datesChanged() {
    const key = wantedKey(date || dateIn(timeZone()))
    if (key === daysKey) return
    daysKey = key
    if (secret?.token) refresh()
  }

  /** Name einer Person aus dem Ablauf (DomainObject oder Person). */
  function personName(p) {
    const x = p?.person ?? p
    if (!x) return ''
    return x.title || [x.domainAttributes?.firstName, x.domainAttributes?.lastName].filter(Boolean).join(' ') || ''
  }

  /** "[Predigt]" usw. durch die eingeteilten Personen ersetzen. */
  function responsibleText(r) {
    if (!r) return ''
    let text = String(r.text || '')
    const byService = new Map()
    for (const entry of r.persons || []) {
      const name = personName(entry)
      // Der Dienst steht je nach Version mit oder ohne Klammern da ("[Predigt]" / "Predigt")
      const service = String(entry.service || '').replace(/^\[|\]$/g, '')
      if (!service || !name) continue
      const label = entry.accepted === false ? `${name} (angefragt)` : name
      byService.set(service, [...(byService.get(service) || []), label])
    }
    for (const [service, names] of byService) text = text.split(`[${service}]`).join(names.join(', '))
    // Nicht besetzte Dienste stehen weiter als [Dienst] da – lesbarer ohne Klammern
    return text.replace(/\[([^\]]+)\]/g, '$1').trim()
  }

  function agendaItems(agenda, event) {
    const items = [...(agenda?.items || [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    // Startzeiten: von ChurchTools, sonst ab Eventbeginn aufsummiert
    const before = items.filter((i) => i.isBeforeEvent)
    const eventStart = Date.parse(event.startDate)
    let t = eventStart - before.reduce((sum, i) => sum + (i.type === 'header' ? 0 : i.duration || 0) * 1000, 0)
    return items.map((i) => {
      const start = i.startTimes?.[event.id] || i.start || null
      const startMs = start ? Date.parse(start) : t
      const duration = i.type === 'header' ? 0 : i.duration || 0
      t = startMs + duration * 1000
      const song = i.type === 'song' && i.song ? i.song : null
      return {
        id: i.id,
        type: i.type,
        title: i.title || song?.title || '',
        start: Number.isFinite(startMs) ? new Date(startMs).toISOString() : null,
        duration,
        beforeEvent: Boolean(i.isBeforeEvent),
        responsible: i.type === 'header' ? '' : responsibleText(i.responsible),
        note: i.type === 'header' ? '' : String(i.note || '').trim(),
        song: song
          ? { title: song.title || '', key: song.key || '', arrangement: song.arrangement || '', bpm: song.bpm ?? null }
          : null,
      }
    })
  }

  async function loadAgenda(base, token, event) {
    try {
      const { data } = await request(base, `/events/${event.id}/agenda`, { token })
      const agenda = data?.data
      if (!agenda) return { agenda: null, agendaError: 'Kein Ablauf hinterlegt' }
      return { agenda: { name: agenda.name || '', items: agendaItems(agenda, event) }, agendaError: '' }
    } catch (err) {
      if (err.status === 404) return { agenda: null, agendaError: 'Kein Ablauf hinterlegt' }
      if (err.status === 403) return { agenda: null, agendaError: 'Keine Berechtigung für den Ablauf' }
      throw err
    }
  }

  function eventInfo(e) {
    const calendar = Array.isArray(e.calendar) ? e.calendar[0] : e.calendar
    return {
      id: e.id,
      name: e.name || '',
      startDate: e.startDate,
      endDate: e.endDate,
      calendar: calendar?.title || calendar?.name || '',
    }
  }

  /** Events eines Tages mit ihren Abläufen. */
  async function loadDay(base, token, tz, day) {
    // "to" ist je nach ChurchTools-Version inklusiv oder exklusiv: bis zum Folgetag
    // abfragen und dann selbst nach Datum filtern
    const { data } = await request(base, `/events?from=${day}&to=${nextDay(day)}`, { token })
    const list = (data?.data || [])
      .filter((e) => !e.isCanceled && dateIn(tz, new Date(e.startDate)) === day)
      .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
    const result = []
    for (const e of list) result.push({ ...eventInfo(e), ...(await loadAgenda(base, token, e)) })
    return result
  }

  /**
   * Für Kacheln „Nächstes Event“: je Filter das nächste passende Event ab morgen,
   * mit oder ohne Ablauf. Immer geladen, damit die Kachel nach dem letzten Event
   * des Tages sofort weiterrücken kann. Je Filter nur der Ablauf des ersten Treffers.
   */
  async function loadUpcoming(base, token, tz, today) {
    const open = wantedFilters()
    if (!open.length) return []
    const from = nextDay(today)
    const { data } = await request(base, `/events?from=${from}&to=${addDays(from, LOOKAHEAD_DAYS)}`, { token })
    const list = (data?.data || [])
      .filter((e) => !e.isCanceled && dateIn(tz, new Date(e.startDate)) > today)
      .sort((a, b) => Date.parse(a.startDate) - Date.parse(b.startDate))
    const found = []
    for (const e of list) {
      if (!open.length) break
      const event = eventInfo(e)
      if (!open.some((f) => matchesFilter(event, f))) continue
      const full = { ...event, ...(await loadAgenda(base, token, e)) }
      found.push(full)
      for (let i = open.length - 1; i >= 0; i--) if (matchesFilter(full, open[i])) open.splice(i, 1)
    }
    return found
  }

  async function refreshNow() {
    clearTimeout(timer)
    if (!secret?.token || !secret?.url) {
      state = 'unconfigured'
      days = {}
      upcoming = []
      publish()
      return
    }
    const { url: base, token } = secret
    const tz = timeZone()
    const today = dateIn(tz)
    try {
      const wanted = wantedDays(today)
      daysKey = wantedKey(today)
      const next = {}
      for (const day of wanted) next[day] = await loadDay(base, token, tz, day)
      try {
        upcoming = await loadUpcoming(base, token, tz, today)
      } catch (err) {
        // Der heutige Ablauf soll nicht an der Vorschau scheitern: alten Stand behalten
        if (err.status === 401) throw err
        log(`ChurchTools: nächste Abläufe nicht geladen: ${err.message}`)
      }
      date = today
      days = next
      state = 'connected'
      error = ''
      publish()
      timer = setTimeout(refresh, REFRESH_MS)
    } catch (err) {
      state = 'error'
      error =
        err.status === 401
          ? 'Login-Token ungültig – bitte unter Einstellungen neu verbinden'
          : err.status === 403
            ? 'Keine Berechtigung, Events zu sehen'
            : err.name === 'TimeoutError'
              ? 'ChurchTools antwortet nicht'
              : err.message
      publish()
      timer = setTimeout(refresh, err.status === 401 ? REFRESH_MS * 5 : RETRY_MS)
    }
  }

  /** Mehrere gleichzeitige Anstöße teilen sich eine Abfrage. */
  function refresh() {
    refreshing ??= refreshNow().finally(() => (refreshing = null))
    return refreshing
  }

  function stop() {
    clearTimeout(timer)
  }

  return { start: refresh, refresh, connect, disconnect, snapshot, stop, datesChanged }
}

module.exports = { createChurchTools, normalizeUrl, dateIn }
