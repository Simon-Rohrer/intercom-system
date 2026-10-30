'use strict'

// Lage im Ablauf auf dem Server (GET /api/state → agenda, Companion-Modul „JMS Control“):
// gleiche Rechnung wie die Ablauf-Kachel im Browser, Wahl des aktuellen Events, Zusammenfassung.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const server = require('../agenda-status')
const { createAgendaPosition } = require('../agenda-position')

// Das Browser-Modul wie in agenda.test.js laden (ohne dass sein Zeitgeber den Test offen hält)
const browser = (async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/agenda.js'), 'utf8')
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const at = (value) => Date.parse(value)
const plan = [
  { id: 1, type: 'header', title: 'Gottesdienst', start: '2026-11-01T09:00:00Z', duration: 0 },
  { id: 2, type: 'song', title: 'Lied 1', start: '2026-11-01T09:00:00Z', duration: 300 },
  { id: 3, type: 'normal', title: 'Begrüßung', start: '2026-11-01T09:05:00Z', duration: 300, responsible: 'Anna' },
  { id: 4, type: 'normal', title: 'Predigt', start: '2026-11-01T09:10:00Z', duration: 1800, responsible: 'Pastor' },
]
const event = (id, name, startDate, endDate, items = plan, extra = {}) => ({ id, name, startDate, endDate, calendar: '', agenda: items ? { items } : null, ...extra })
const service = event(42, 'Gottesdienst', '2026-11-01T09:00:00Z', '2026-11-01T10:30:00Z', plan, { calendar: 'Gottesdienst am Sonntag' })
const youth = event(43, 'Jugend', '2026-11-01T17:00:00Z', '2026-11-01T19:00:00Z', [{ id: 9, type: 'normal', title: 'Spiele', start: '2026-11-01T17:00:00Z', duration: 3600 }])
const nextWeek = event(44, 'Gottesdienst', '2026-11-08T09:00:00Z', '2026-11-08T10:30:00Z')
const ct = (extra = {}) => ({ state: 'connected', date: '2026-11-01', timeZone: 'Europe/Berlin', days: { '2026-11-01': [youth, service] }, upcoming: [nextWeek], ...extra })

test('Server rechnet wie die Ablauf-Kachel im Browser (Statuszeile und Eventwahl)', async () => {
  const web = await browser
  const positions = [
    null,
    { itemIndex: 3, itemId: 4, at: '2026-11-01T09:14:00Z' },
    { itemIndex: 2, itemId: 4, at: '2026-11-01T09:14:00Z' },
    { itemIndex: 0, itemId: 1, at: '2026-11-01T09:14:00Z' },
    { itemIndex: 2, itemId: 3, at: '2026-11-01T09:03:00Z' },
    { itemIndex: 3, itemId: 4, at: '2026-10-30T09:14:00Z' },
  ]
  const times = ['2026-11-01T08:50:00Z', '2026-11-01T09:06:30Z', '2026-11-01T09:15:00Z', '2026-11-01T10:00:00Z']
  for (const position of positions) for (const time of times) for (const [warnMin, badMin] of [[2, 5], [5, 10], [1, 3]]) {
    const options = { position, now: at(time), warnMin, badMin }
    assert.deepEqual(server.agendaStatus(plan, options), web.agendaStatus(plan, options), JSON.stringify(options))
  }
  for (const time of ['2026-11-01T06:00:00Z', '2026-11-01T09:30:00Z', '2026-11-01T17:30:00Z', '2026-11-01T22:00:00Z']) {
    for (const filter of ['', 'jugend', 'am sonntag', 'fehlt']) {
      assert.equal(server.pickEvent([youth, service], filter, at(time))?.id, web.pickEvent([youth, service], filter, at(time))?.id)
      assert.equal(server.pickNextEvent([youth, service], [nextWeek], filter, at(time))?.id, web.pickNextEvent([youth, service], [nextWeek], filter, at(time))?.id)
    }
  }
  assert.deepEqual(server.thresholds({ warnMin: '3', badMin: 500 }), { warnMin: 3, badMin: 180 })
  assert.deepEqual(server.thresholds(undefined), { warnMin: web.agendaOptions().warnMin, badMin: web.agendaOptions().badMin })
})

test('Aktuelles Event: Kachel mit Bedienung vor sichtbarer Kachel, feste andere Tage zählen nicht', () => {
  const layouts = [
    { id: 'a', tiles: [{ kind: 'churchtools', ctFilter: 'jugend' }] },
    { id: 'b', tiles: [{ kind: 'churchtools', ctDate: '2026-10-25', agendaLook: { control: true } }, { kind: 'churchtools', ctFilter: 'gottesdienst' }] },
    { id: 'c', tiles: [{ kind: 'churchtools', ctFilter: 'gottesdienst', agendaLook: { control: true } }] },
  ]
  const now = at('2026-11-01T09:30:00Z')
  // Bedienung (Layout c) gewinnt, auch wenn nicht sichtbar; der feste 25.10. zählt nicht
  assert.equal(server.agendaTile({ layouts, outputs: [{ layoutId: 'a' }] }, '2026-11-01'), layouts[2].tiles[0])
  // Ohne Bedienung: die sichtbare Kachel vor der ersten
  const plain = layouts.slice(0, 2)
  assert.equal(server.agendaTile({ layouts: plain, outputs: [{ layoutId: 'b' }] }, '2026-11-01'), plain[1].tiles[1])
  assert.equal(server.currentAgendaEvent(ct(), { layouts: plain, outputs: [{ layoutId: 'a' }] }, now).event.id, 43)
  // Ohne Kachel: Events von heute ohne Filter (Sonntagmorgen bevorzugt)
  assert.equal(server.currentAgendaEvent(ct(), { layouts: [], outputs: [] }, at('2026-11-01T17:30:00Z')).event.id, 42)
  // Kachel „Nächstes Event“ nach dem Ende des Sonntags
  const nextTile = { layouts: [{ id: 'n', tiles: [{ kind: 'churchtools', ctMode: 'next', ctFilter: 'gottesdienst' }] }], outputs: [] }
  assert.equal(server.currentAgendaEvent(ct({ days: { '2026-11-01': [] } }), nextTile, now).event.id, 44)
  assert.equal(server.currentAgendaEvent({ state: 'unconfigured' }, nextTile, now).event, null)
})

test('Zusammenfassung für /api/state: Punkt, Restzeit, Abweichung mit Schwellen der Kachel, nächster Punkt', (t) => {
  const config = { layouts: [{ id: 'l', tiles: [{ kind: 'churchtools', agendaLook: { warnMin: 1, badMin: 3 } }] }], outputs: [{ layoutId: 'l' }] }
  const byClock = server.agendaSummary({ ct: ct(), config, now: at('2026-11-01T09:06:30Z') })
  assert.equal(byClock.eventId, '42')
  assert.equal(byClock.event, 'Gottesdienst')
  assert.equal(byClock.hasAgenda, true)
  assert.deepEqual(byClock.current, { index: 2, title: 'Begrüßung' })
  assert.equal(byClock.remainingSec, 210)
  assert.equal(byClock.deviationMin, 0)
  assert.equal(byClock.level, 'ok')
  assert.equal(byClock.manual, false)
  assert.deepEqual(byClock.next, { index: 3, title: 'Predigt', responsible: 'Pastor', start: '2026-11-01T09:10:00Z' })
  assert.deepEqual([byClock.warnMin, byClock.badMin], [1, 3])
  assert.deepEqual(byClock.events.map((e) => e.id), ['43', '42', '44'])

  // Von Hand über die Companion-Schritte gesetzt: 4 min hinter Plan → bei 1/3 min rot
  let now = at('2026-11-01T09:14:00Z')
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'agenda-status-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pos = createAgendaPosition({ dataDir: dir, getEvents: () => [service], now: () => now })
  // Nach Uhr läuft die Predigt: einen zurück und wieder vor → Predigt um 09:14 von Hand gestartet
  pos.set({ eventId: 42, action: 'previous' }, 'Companion')
  pos.set({ eventId: 42, action: 'next' }, 'Companion')
  now += 60 * 1000
  const manual = server.agendaSummary({ ct: ct(), positions: pos.snapshot().positions, config, now })
  assert.equal(manual.manual, true)
  assert.deepEqual(manual.current, { index: 3, title: 'Predigt' })
  assert.equal(manual.deviationMin, 4)
  assert.equal(manual.level, 'bad')
  assert.equal(manual.remainingSec, 29 * 60)
  assert.equal(manual.next, null)
})

test('Zusammenfassung ohne ChurchTools, ohne Event oder ohne Ablauf bleibt leer statt zu werfen', () => {
  for (const input of [{ ct: null }, { ct: { state: 'error', date: '2026-11-01', days: {} } }, { ct: ct({ days: { '2026-11-01': [event(7, 'Leer', '2026-11-01T09:00:00Z', '2026-11-01T10:00:00Z', null)] }, upcoming: [] }) }]) {
    const summary = server.agendaSummary({ ...input, config: { layouts: [], outputs: [] }, now: at('2026-11-01T09:30:00Z') })
    assert.equal(summary.current, null)
    assert.equal(summary.next, null)
    assert.equal(summary.level, null)
    assert.equal(summary.manual, false)
    assert.equal(summary.hasAgenda, false)
  }
  assert.equal(server.agendaSummary({ ct: null, config: {} }).state, 'unconfigured')
})
