'use strict'

// Ampel „Event-Ops“ für die gleichnamige Kachel: fasst die Prüfungen des Veranstaltungsbetriebs
// (event-ops.js → diagnostics(), Prüfungen aus event-ops-checks.js) zu einer Ampel zusammen und
// schickt sie als WebSocket-Nachricht { type: 'ops', … } an alle Anzeigen. Neue Verbindungen
// bekommen den letzten Stand (snapshot). Gepollt wird nur, solange ein Layout eine Ops-Kachel
// hat – die Prüfungen fragen ProPresenter, Companion und die Raspberry Pis ab.
//
// Rot:   ein benötigtes System meldet einen Fehler.
// Gelb:  ein benötigtes System ist unbestätigt/eingeschränkt oder ein optionales meldet einen Fehler.
// Grün:  alles Benötigte ist in Ordnung (Ruhemodus zählt als in Ordnung).

const POLL_MS = 30 * 1000
const ERROR_MS = 60 * 1000

const SEVERITY = { error: 3, warn: 2, unknown: 1, ok: 0, idle: 0 }

/** Kurzname ohne Zusatz: „LED-Wand – Bildkontrolle“ → „LED-Wand“ */
function shortName(name) {
  return String(name || '').split(/\s[–-]\s/)[0].trim() || 'Prüfung'
}

/** Kurztext für die Kachel: „LED-Wand prüfen“, „Stage Display bestätigen“ … */
function shortText(row) {
  const base = shortName(row.name)
  if (row.status === 'error' || row.status === 'warn') return `${base} prüfen`
  if (row.status === 'unknown') return row.manual ? `${base} bestätigen` : `${base} ohne Rückmeldung`
  if (row.status === 'idle') return `${base} im Ruhemodus`
  return base
}

/** Ampelfarbe einer einzelnen Prüfung: 'error' | 'warn' | 'ok' */
function levelOf(row) {
  const sev = SEVERITY[row.status] ?? SEVERITY.unknown
  if (sev === 0) return 'ok'
  if (row.required) return row.status === 'error' ? 'error' : 'warn'
  return row.status === 'error' ? 'warn' : 'ok'
}

/** Ergebnis von eventOps.diagnostics() → kompakte Ampel-Nachricht für die Kachel */
function summarizeOps(diag, at = Date.now()) {
  const rows = Array.isArray(diag?.checks) ? diag.checks : []
  const items = rows
    .map((r) => ({
      id: String(r.id ?? ''),
      name: String(r.name || r.id || 'Prüfung').slice(0, 80),
      short: shortText(r),
      status: SEVERITY[r.status] != null ? r.status : 'unknown',
      level: levelOf(r),
      required: r.required === true,
      manual: r.manual === true,
      detail: String(r.detail || '').slice(0, 200),
    }))
    // Wichtiges zuerst: Rot vor Gelb, benötigte vor optionalen, dann nach Name
    .sort((a, b) => (SEVERITY[b.status] - SEVERITY[a.status]) || (b.required - a.required) || a.name.localeCompare(b.name, 'de'))
  const counts = { ok: 0, warn: 0, error: 0, unknown: 0 }
  for (const r of items) counts[r.status === 'idle' ? 'ok' : r.status]++
  let overall = rows.length ? 'ok' : 'unknown'
  for (const r of items) {
    if (r.level === 'error') overall = 'error'
    else if (r.level === 'warn' && overall !== 'error') overall = 'warn'
  }
  return {
    type: 'ops',
    state: 'ok',
    error: '',
    overall,
    counts,
    event: String(diag?.event?.name || '').slice(0, 120),
    items,
    at,
  }
}

/**
 * Kurzform der Ampel für GET /api/state (Companion-Modul „JMS Control“): Gesamtzustand,
 * Anzahl der Probleme (Prüfungen mit gelber oder roter Ampel) und das wichtigste davon.
 */
function opsSummary(msg) {
  const items = Array.isArray(msg?.items) ? msg.items : []
  const problems = items.filter((item) => item.level === 'error' || item.level === 'warn')
  return {
    state: msg?.state || 'connecting',
    overall: ['ok', 'warn', 'error'].includes(msg?.overall) ? msg.overall : 'unknown',
    problems: problems.length,
    errors: problems.filter((item) => item.level === 'error').length,
    first: problems[0]?.short || '',
    event: String(msg?.event || ''),
    error: String(msg?.error || ''),
    at: Number(msg?.at) || null,
  }
}

function createOpsStatus({ getDiagnostics, wanted = () => true, onUpdate = () => {}, log = () => {}, now = Date.now }) {
  let last = null
  let lastKey = ''
  let timer = null
  let running = false
  let flight = null

  function snapshot() {
    return last ?? { type: 'ops', state: 'connecting', error: '', overall: 'unknown', counts: { ok: 0, warn: 0, error: 0, unknown: 0 }, event: '', items: [], at: now() }
  }

  function publish(msg) {
    const key = JSON.stringify({ ...msg, at: 0 })
    last = msg
    if (key === lastKey) return
    lastKey = key
    onUpdate(msg)
  }

  /** Prüfungen holen und als Ampel verschicken (läuft nie doppelt) */
  function refresh() {
    flight ??= (async () => {
      try {
        const diag = await getDiagnostics()
        const next = summarizeOps(diag, now())
        if (last?.state !== 'ok') log('Event-Ops: Ampel aktiv')
        publish(next)
      } catch (err) {
        const message = err?.message || String(err)
        if (last?.state !== 'error' || last.error !== message) log(`Event-Ops: ${message}`)
        publish({ ...snapshot(), state: 'error', error: message, overall: 'unknown', at: now() })
      }
    })().finally(() => {
      flight = null
    })
    return flight
  }

  function schedule(ms) {
    clearTimeout(timer)
    if (!running) return
    timer = setTimeout(async () => {
      if (wanted()) await refresh()
      schedule(last?.state === 'error' ? ERROR_MS : POLL_MS)
    }, ms)
  }

  return {
    start() {
      if (running) return
      running = true
      schedule(0)
    },
    stop() {
      running = false
      clearTimeout(timer)
    },
    snapshot,
    refresh,
    /** Layouts geändert: gibt es jetzt eine Ops-Kachel, gleich prüfen */
    layoutsChanged() {
      if (running && wanted() && !flight) schedule(0)
    },
  }
}

module.exports = { createOpsStatus, summarizeOps, opsSummary, shortText, levelOf }
