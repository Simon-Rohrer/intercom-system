'use strict'

// ChurchTools: Der Server ist mit einem eigenen Konto per REST-API verbunden
// (Login-Token, Header "Authorization: Login <token>") und verteilt die Abläufe
// der heutigen Events an alle Multiview-Seiten. Der Token liegt getrennt von der
// übrigen Konfiguration und wird nie an Browser geschickt.

const fs = require('fs')
const path = require('path')
const { normalizeEventServices, serviceMap, serviceCatalog } = require('./roster')

const REFRESH_MS = 60 * 1000
const MAX_DAYS = 10 // so viele verschiedene Tage werden höchstens abgefragt
const LOOKAHEAD_DAYS = 42 // so weit voraus wird das nächste Event gesucht
const OVERVIEW_DAYS = 28 // Übersicht in den Einstellungen: heute und die nächsten 4 Wochen
const OVERVIEW_AGENDA_MS = 10 * 60 * 1000 // Abläufe der Übersicht so lange zwischenspeichern
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

function createChurchTools({ dataDir, getConfig, getDates = () => [], getFilters = () => [], wantServices = () => false, onUpdate, log = console.log }) {
  const secretFile = path.join(dataDir, 'churchtools-secret.json')
  let secret = readSecret() // { url, token, user }
  let state = secret?.token ? 'connecting' : 'unconfigured'
  let error = ''
  let date = '' // heute
  let days = {} // { 'YYYY-MM-DD': events[] }
  let upcoming = [] // je Filter das nächste Event ab morgen, für Kacheln „Nächstes Event“
  let overview = [] // alle Events der nächsten 4 Wochen (ohne Ablauf-Inhalt), für die Einstellungen
  const overviewCache = new Map() // Event-ID → { at, event }
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
      overview,
      // Dienstgruppen mit ihren Diensten (für den Filter der Kachel „Dienstplan“)
      serviceCatalog: catalog,
    }
  }

  function publish() {
    const snap = snapshot()
    const key = JSON.stringify(snap)
    if (key === lastPublished) return
    lastPublished = key
    onUpdate(snap)
  }

  /** Fehler verständlich statt der HTML-Fehlerseite von ChurchTools. */
  function httpErrorText(status, detail) {
    if (detail) return `HTTP ${status}: ${detail}`
    if ([502, 503, 504].includes(status))
      return `ChurchTools ist gerade nicht erreichbar (HTTP ${status}) – Wartung oder Störung bei ChurchTools, nicht bei uns. Wird automatisch erneut versucht.`
    if (status >= 500) return `Fehler auf dem ChurchTools-Server (HTTP ${status}) – wird automatisch erneut versucht.`
    return `HTTP ${status}`
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
      const detail = data?.message || data?.errors?.[0]?.message || (/^\s*</.test(text) ? '' : text.slice(0, 120))
      throw new ChurchToolsError(httpErrorText(res.status, detail), res.status)
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
    overview = []
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
    return JSON.stringify([wantedDays(today), wantedFilters(), Boolean(wantServices())])
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

  // Dienstgruppen (Namen der Programmspalten im Ablauf), selten geändert
  let serviceGroups = { at: 0, base: '', map: new Map() }
  async function loadServiceGroups(base, token) {
    if (serviceGroups.base === base && Date.now() - serviceGroups.at < 60 * 60 * 1000) return serviceGroups.map
    try {
      const { data } = await request(base, '/servicegroups', { token })
      const map = new Map()
      for (const g of data?.data || []) map.set(g.id, { name: g.nameTranslated || g.name || '', sort: g.sortKey ?? g.id })
      serviceGroups = { at: Date.now(), base, map }
    } catch {
      // Ohne Namen trotzdem anzeigen ("Spalte 3"); später erneut versuchen
      serviceGroups = { ...serviceGroups, at: Date.now() - 55 * 60 * 1000 }
    }
    return serviceGroups.map
  }

  // Dienste (Ton, Licht, Kamera …) mit Dienstgruppe, selten geändert
  let serviceDefs = { at: 0, base: '', map: new Map() }
  let catalog = [] // Dienstgruppen mit Diensten für die Kachel-Einstellungen
  async function loadServices(base, token) {
    if (serviceDefs.base === base && Date.now() - serviceDefs.at < 60 * 60 * 1000) return serviceDefs.map
    try {
      const { data } = await request(base, '/services', { token })
      serviceDefs = { at: Date.now(), base, map: serviceMap(data?.data || []) }
      catalog = serviceCatalog(serviceDefs.map, await loadServiceGroups(base, token))
    } catch {
      // Ohne Namen trotzdem anzeigen ("Dienst 12"); später erneut versuchen
      serviceDefs = { ...serviceDefs, at: Date.now() - 55 * 60 * 1000 }
    }
    return serviceDefs.map
  }

  /**
   * Eingeteilte Dienste eines Events. Die Eventliste bringt die Dienste je nach
   * ChurchTools-Version schon mit, sonst holt /events/{id} sie nach.
   */
  async function loadEventServices(base, token, e) {
    try {
      let list = e.eventServices
      if (!Array.isArray(list)) {
        const { data } = await request(base, `/events/${e.id}`, { token })
        list = data?.data?.eventServices || []
      }
      const defs = await loadServices(base, token)
      return { services: normalizeEventServices(list, defs, await loadServiceGroups(base, token)), servicesError: '' }
    } catch (err) {
      if (err.status === 403) return { services: null, servicesError: 'Keine Berechtigung für die Dienste' }
      if (err.status === 404) return { services: null, servicesError: 'Event nicht gefunden' }
      throw err
    }
  }

  // CCLI-Nummern der Songs (braucht im ChurchTools-Benutzer Leserecht auf Songs)
  const ccliCache = new Map() // songId → { at, ccli }
  async function loadCcli(base, token, songIds) {
    const result = new Map()
    for (const id of new Set(songIds)) {
      const cached = ccliCache.get(id)
      if (cached && Date.now() - cached.at < (cached.ccli ? 6 * 60 * 60 : 2 * 60) * 1000) {
        result.set(id, cached.ccli)
        continue
      }
      let ccli = ''
      try {
        const { data } = await request(base, `/songs/${id}`, { token })
        ccli = String(data?.data?.ccli || '').trim()
      } catch {
        ccli = '' // keine Berechtigung oder Song gelöscht
      }
      ccliCache.set(id, { at: Date.now(), ccli })
      result.set(id, ccli)
    }
    return result
  }

  /** Programmspalten eines Punkts: [{ group, note }] in ChurchTools-Reihenfolge */
  function columnNotes(item, groups) {
    return (item.serviceGroupNotes || [])
      .map((n) => ({ id: n.serviceGroupId, note: String(n.note || '').trim() }))
      .filter((n) => n.note)
      .sort((a, b) => (groups.get(a.id)?.sort ?? a.id) - (groups.get(b.id)?.sort ?? b.id))
      .map((n) => ({ group: groups.get(n.id)?.name || `Spalte ${n.id}`, note: n.note }))
  }

  function agendaItems(agenda, event, groups = new Map()) {
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
        columns: columnNotes(i, groups),
        song: song
          ? {
              id: song.songId ?? null,
              title: song.title || '',
              key: song.key || '',
              arrangement: song.arrangement || '',
              isDefault: song.isDefault === true,
              bpm: song.bpm ?? null,
              ccli: '',
            }
          : null,
      }
    })
  }

  async function loadAgenda(base, token, event) {
    try {
      const { data } = await request(base, `/events/${event.id}/agenda`, { token })
      const agenda = data?.data
      if (!agenda) return { agenda: null, agendaError: 'Kein Ablauf hinterlegt' }
      const groups = await loadServiceGroups(base, token)
      const items = agendaItems(agenda, event, groups)
      const songIds = items.map((i) => i.song?.id).filter((id) => id != null)
      if (songIds.length) {
        const ccli = await loadCcli(base, token, songIds)
        for (const i of items) if (i.song) i.song.ccli = ccli.get(i.song.id) || ''
      }
      return { agenda: { name: agenda.name || '', items }, agendaError: '' }
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
    for (const e of list) result.push(await loadEvent(base, token, e))
    return result
  }

  /** Event mit Ablauf und – wenn eine Dienstplan-Kachel sie braucht – den Diensten. */
  async function loadEvent(base, token, e) {
    const event = { ...eventInfo(e), ...(await loadAgenda(base, token, e)) }
    if (wantServices()) Object.assign(event, await loadEventServices(base, token, e))
    return event
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
      const full = await loadEvent(base, token, e)
      found.push(full)
      for (let i = open.length - 1; i >= 0; i--) if (matchesFilter(full, open[i])) open.splice(i, 1)
    }
    return found
  }

  /**
   * Übersicht für die Einstellungen: alle Events von heute bis in 4 Wochen, je
   * Event nur die Zahl der Ablaufpunkte. Abläufe der schon geladenen Tage werden
   * übernommen, die übrigen höchstens alle 10 Minuten neu abgefragt.
   */
  async function loadOverview(base, token, tz, today, loaded) {
    const end = addDays(today, OVERVIEW_DAYS)
    const { data } = await request(base, `/events?from=${today}&to=${end}`, { token })
    const list = (data?.data || [])
      .filter((e) => !e.isCanceled)
      .map((e) => ({ e, day: dateIn(tz, new Date(e.startDate)) }))
      .filter(({ day }) => day >= today && day < end)
      .sort((a, b) => Date.parse(a.e.startDate) - Date.parse(b.e.startDate))
    const known = new Map(Object.values(loaded).flat().map((e) => [e.id, e]))
    const now = Date.now()
    const result = []
    for (const { e, day } of list) {
      let event = known.get(e.id)
      if (!event) {
        const cached = overviewCache.get(e.id)
        if (cached && now - cached.at < OVERVIEW_AGENDA_MS && cached.event.startDate === e.startDate) event = cached.event
        else {
          event = { ...eventInfo(e), ...(await loadAgenda(base, token, e)) }
          overviewCache.set(e.id, { at: now, event })
        }
      }
      result.push({
        id: event.id,
        day,
        name: event.name,
        startDate: event.startDate,
        calendar: event.calendar,
        points: event.agenda ? event.agenda.items.filter((i) => i.type !== 'header').length : null,
        agendaError: event.agendaError,
      })
    }
    const ids = new Set(list.map(({ e }) => e.id))
    for (const id of overviewCache.keys()) if (!ids.has(id)) overviewCache.delete(id)
    return result
  }

  async function refreshNow() {
    clearTimeout(timer)
    if (!secret?.token || !secret?.url) {
      state = 'unconfigured'
      days = {}
      upcoming = []
      overview = []
      publish()
      return
    }
    const { url: base, token } = secret
    const tz = timeZone()
    const today = dateIn(tz)
    try {
      const wanted = wantedDays(today)
      daysKey = wantedKey(today)
      // Der Dienste-Katalog ist für die Kachel-Einstellungen immer da (eine Abfrage pro Stunde)
      await loadServices(base, token)
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
      // Die Übersicht kommt danach, damit die Kacheln nicht auf sie warten
      try {
        overview = await loadOverview(base, token, tz, today, next)
        publish()
      } catch (err) {
        if (err.status === 401) throw err
        log(`ChurchTools: Übersicht nicht geladen: ${err.message}`)
      }
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

  /** GET auf die ChurchTools-API mit dem gespeicherten Zugang (für die Diashow: Kalendertermine) */
  async function api(pathname) {
    if (!secret?.token || !secret?.url) throw new Error('ChurchTools ist nicht verbunden')
    const { data } = await request(secret.url, pathname, { token: secret.token })
    return data
  }

  // Derselbe normalisierte Ablauf für die explizit gewählte Veranstaltung der Übersicht.
  async function agendaForEvent(event) {
    if (!secret?.token || !secret?.url) throw new Error('ChurchTools ist nicht verbunden')
    return loadAgenda(secret.url, secret.token, event)
  }

  /** Alle geladenen Events mit Ablauf (heute, feste Tage, nächste Events) – für die Ablauf-Position. */
  function loadedEvents() {
    return [...Object.values(days).flat(), ...upcoming]
  }

  return { start: refresh, refresh, connect, disconnect, snapshot, stop, datesChanged, api, agendaForEvent, loadedEvents }
}

module.exports = { createChurchTools }
