'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Import the production browser module without keeping its UI timer alive.
const selection = (async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/agenda.js'), 'utf8')
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const at = (value) => Date.parse(value)
const event = (id, name, startDate, endDate, items = [{ type: 'normal', title: 'Ablaufpunkt' }], extra = {}) => ({
  id, name, startDate, endDate,
  calendar: '',
  agenda: items === null ? null : { items },
  agendaError: items === null ? 'Kein Ablauf hinterlegt' : '',
  ...extra,
})
const popcorn = event(4811, 'Popcorn', '2026-10-17T13:00:00Z', '2026-10-17T15:00:00Z', null, { calendar: 'Kinderdienst' })
const men = event(4530, 'Männertag mit Matthias Berg', '2026-10-17T13:30:00Z', '2026-10-17T20:00:00Z')
const sunday = event(4241, 'Gottesdienst', '2026-10-18T07:30:00Z', '2026-10-18T09:15:00Z', undefined, { calendar: 'Gottesdienst am Sonntag' })
const evening = event(5193, 'SelfService', '2026-10-18T15:15:00Z', '2026-10-18T19:00:00Z')

test('Live-Fehler: Männertag mit Ablauf statt gleichzeitig laufendem Popcorn ohne Ablauf', async () => {
  const { pickEvent, pickNextEvent } = await selection
  const now = at('2026-10-17T13:40:00Z')
  assert.equal(pickEvent([popcorn, men], '', now).id, men.id)
  assert.equal(pickNextEvent([popcorn, men], [sunday], '', now).id, men.id)
})

test('Sonntagmorgen bleibt auch während des Abend-Events bevorzugt', async () => {
  const { pickEvent, pickNextEvent } = await selection
  for (const now of ['2026-10-18T05:00:00Z', '2026-10-18T08:00:00Z', '2026-10-18T16:00:00Z', '2026-10-18T21:00:00Z']) {
    assert.equal(pickEvent([evening, sunday], '', at(now)).id, sunday.id)
    assert.equal(pickNextEvent([evening, sunday], [], '', at(now)).id, sunday.id)
  }
})

test('Ausdrückliche Namens- und Kalenderfilter bleiben wirksam', async () => {
  const { pickEvent, pickNextEvent } = await selection
  const now = at('2026-10-18T16:00:00Z')
  assert.equal(pickEvent([sunday, evening], 'selfservice', now).id, evening.id)
  assert.equal(pickNextEvent([sunday, evening], [], 'selfservice', now).id, evening.id)
  assert.equal(pickEvent([sunday, evening], 'am sonntag', now).id, sunday.id)
  assert.equal(pickEvent([popcorn, men], 'kinderdienst', at('2026-10-17T14:00:00Z')).id, popcorn.id)
  assert.equal(pickEvent([sunday, evening], 'nicht vorhanden', now), null)
})

test('Fester Sonntag bleibt bei seinem Morgen, unabhängig vom aktuellen Wochentag', async () => {
  const { pickEvent } = await selection
  assert.equal(pickEvent([evening, sunday], '', at('2026-10-19T12:00:00Z')).id, sunday.id)
})

test('Unter der Woche gewinnt ein laufendes Event mit Ablauf vor dem nächsten Sonntag', async () => {
  const { pickNextEvent } = await selection
  assert.equal(pickNextEvent([men], [sunday], '', at('2026-10-17T14:00:00Z')).id, men.id)
  assert.equal(pickNextEvent([men], [sunday], '', at('2026-10-17T21:00:00Z')).id, sunday.id)
})

test('Sonntagmorgen nach lokaler Zeitzone; 12 Uhr gehört nicht mehr dazu', async () => {
  const { pickEvent } = await selection
  const justMorning = event(1, '11:59 Berlin', '2026-10-18T09:59:00Z', '2026-10-18T10:30:00Z')
  const noon = event(2, '12:00 Berlin', '2026-10-18T10:00:00Z', '2026-10-18T11:00:00Z')
  assert.equal(pickEvent([noon, justMorning, evening], '', at('2026-10-18T16:00:00Z'), 'Europe/Berlin').id, 1)
  assert.equal(pickEvent([noon, evening], '', at('2026-10-18T16:00:00Z'), 'Europe/Berlin').id, evening.id)
  const winterMorning = event(3, '11:30 Berlin Winterzeit', '2026-10-25T10:30:00Z', '2026-10-25T11:30:00Z')
  const winterEvening = event(4, 'Abend', '2026-10-25T16:00:00Z', '2026-10-25T19:00:00Z')
  assert.equal(pickEvent([winterEvening, winterMorning], '', at('2026-10-25T17:00:00Z'), 'Europe/Berlin').id, 3)
})

test('Lokaler Sonntag gilt auch bei UTC-Samstag; andere Zeitzonen werden respektiert', async () => {
  const { pickNextEvent } = await selection
  const morning = event(1, 'Sonntag in Auckland', '2026-10-17T20:00:00Z', '2026-10-17T21:00:00Z')
  const later = event(2, 'Nachmittag', '2026-10-18T02:00:00Z', '2026-10-18T05:00:00Z')
  assert.equal(pickNextEvent([later, morning], [], '', at('2026-10-18T03:00:00Z'), 'Pacific/Auckland').id, 1)
})

test('Leere Abläufe und reine Überschriften verdrängen keine nutzbaren Ablaufpunkte', async () => {
  const { pickNextEvent } = await selection
  const empty = { ...popcorn, agenda: { items: [] } }
  const header = { ...popcorn, agenda: { items: [{ type: 'header', title: 'Überschrift' }] } }
  for (const first of [empty, header]) {
    assert.equal(pickNextEvent([first, men], [], '', at('2026-10-17T14:00:00Z')).id, men.id)
  }
})

test('Ohne nutzbaren Ablauf bleiben vorhandene Fehlermeldungen und Sonntagpriorität sichtbar', async () => {
  const { pickEvent, pickNextEvent } = await selection
  const denied = { ...sunday, agenda: null, agendaError: 'Keine Berechtigung für den Ablauf' }
  assert.equal(pickEvent([denied, evening], '', at('2026-10-18T16:00:00Z')).agendaError, denied.agendaError)
  assert.equal(pickNextEvent([popcorn], [], '', at('2026-10-17T14:00:00Z')).agendaError, popcorn.agendaError)
})

test('Leere, abgesagte, ungültige und vergangene Events; Eingaben bleiben unverändert', async () => {
  const { pickEvent, pickNextEvent } = await selection
  const events = [men, popcorn]
  const before = JSON.stringify(events)
  pickEvent(events, '', at('2026-10-17T14:00:00Z'))
  assert.equal(JSON.stringify(events), before)
  assert.equal(pickEvent([], '', at('2026-10-17T14:00:00Z')), null)
  assert.equal(pickEvent([{ ...men, isCanceled: true }, { ...men, startDate: 'invalid' }], ''), null)
  assert.equal(pickNextEvent([men], [], '', at('2026-10-17T21:00:00Z')), null)
})

test('Leerer ChurchTools-Platzhalter zeigt verständlichen Leerzustand beim richtigen Event', async () => {
  const { createAgendaView } = await selection
  const original = global.document
  const element = () => ({
    children: [], textContent: '', classList: { toggle() {}, add() {} }, style: { setProperty() {} }, dataset: {},
    append(...children) { this.children.push(...children) },
    replaceChildren(...children) { this.children = children },
  })
  global.document = { createElement: element }
  try {
    const view = createAgendaView({ ctDate: '2026-10-17' })
    view.update({ state: 'connected', date: '2026-10-17', timeZone: 'Europe/Berlin', days: {
      '2026-10-17': [popcorn, { ...men, agenda: { items: [{ type: 'text', title: '', duration: 0, note: '' }] } }],
    } })
    const texts = (node) => [node.textContent, ...node.children.flatMap(texts)]
    assert.ok(texts(view.el).includes(men.name))
    assert.ok(texts(view.el).includes('Der Ablauf ist leer'))
    assert.ok(!texts(view.el).includes(popcorn.name))
  } finally { global.document = original }
})

// Statuszeile: laufender Punkt nach Uhr oder von Hand, Restzeit, Abweichung, nächster Punkt
const plan = [
  { id: 1, type: 'header', title: 'Gottesdienst', start: '2026-11-01T09:00:00Z', duration: 0 },
  { id: 2, type: 'song', title: 'Lied 1', start: '2026-11-01T09:00:00Z', duration: 300 },
  { id: 3, type: 'normal', title: 'Begrüßung', start: '2026-11-01T09:05:00Z', duration: 300, responsible: 'Anna' },
  { id: 4, type: 'normal', title: 'Predigt', start: '2026-11-01T09:10:00Z', duration: 1800, responsible: 'Pastor' },
]

test('Statuszeile nach Uhr: Restzeit des laufenden Punkts, Abweichung 0, nächster Punkt', async () => {
  const { agendaStatus, fmtRemaining, fmtDeviation } = await selection
  const st = agendaStatus(plan, { now: at('2026-11-01T09:06:30Z') })
  assert.equal(st.current.title, 'Begrüßung')
  assert.equal(st.manual, false)
  assert.equal(st.remainingSec, 210)
  assert.equal(st.deviationMin, 0)
  assert.equal(st.level, 'ok')
  assert.equal(st.next.title, 'Predigt')
  assert.equal(st.next.responsible, 'Pastor')
  // Vor dem Beginn: kein laufender Punkt, aber der kommende
  const before = agendaStatus(plan, { now: at('2026-11-01T08:50:00Z') })
  assert.equal(before.current, null)
  assert.equal(before.next.title, 'Lied 1')
  assert.equal(before.remainingSec, null)
  // Nach dem Ende: nichts mehr
  const after = agendaStatus(plan, { now: at('2026-11-01T10:00:00Z') })
  assert.equal(after.current, null)
  assert.equal(after.next, null)
  assert.equal(fmtRemaining(210), '3:30')
  assert.equal(fmtRemaining(-80), '−1:20')
  assert.equal(fmtRemaining(3725), '1:02:05')
  assert.equal(fmtDeviation(4), '+4 min')
  assert.equal(fmtDeviation(-2), '−2 min')
  assert.equal(fmtDeviation(0), '±0 min')
})

test('Von Hand gesetzter Punkt: Abweichung = Ist-Start minus Plan, Schwellen grün/gelb/rot', async () => {
  const { agendaStatus } = await selection
  // Predigt (Plan 09:10) um 09:14 gestartet → +4 min, Standard: gelb; Restzeit ab dem Klick
  const position = { itemIndex: 3, itemId: 4, at: '2026-11-01T09:14:00Z' }
  const st = agendaStatus(plan, { position, now: at('2026-11-01T09:15:00Z') })
  assert.equal(st.manual, true)
  assert.equal(st.current.title, 'Predigt')
  assert.equal(st.deviationMin, 4)
  assert.equal(st.level, 'warn')
  assert.equal(st.remainingSec, 29 * 60)
  assert.equal(st.next, null)
  assert.equal(agendaStatus(plan, { position, now: at('2026-11-01T09:15:00Z'), warnMin: 5 }).level, 'ok')
  assert.equal(agendaStatus(plan, { position, now: at('2026-11-01T09:15:00Z'), warnMin: 1, badMin: 3 }).level, 'bad')
  // Früher als geplant gestartet: negative Abweichung, Betrag zählt für die Farbe
  const early = agendaStatus(plan, { position: { itemIndex: 3, itemId: 4, at: '2026-11-01T09:03:00Z' }, now: at('2026-11-01T09:04:00Z') })
  assert.equal(early.deviationMin, -7)
  assert.equal(early.level, 'bad')
  // Überzogen: Restzeit negativ
  const over = agendaStatus(plan, { position: { itemIndex: 2, itemId: 3, at: '2026-11-01T09:05:00Z' }, now: at('2026-11-01T09:11:00Z') })
  assert.equal(over.current.title, 'Begrüßung')
  assert.equal(over.remainingSec, -60)
  assert.equal(over.next.title, 'Predigt')
})

test('Gesetzter Punkt: über die ID wiedergefunden, bei Überschrift/zu alt/unpassend ignoriert', async () => {
  const { resolvePosition, agendaStatus } = await selection
  const now = at('2026-11-01T09:15:00Z')
  // Ablauf in ChurchTools verschoben: Index zeigt auf einen anderen Punkt, die ID findet ihn
  assert.deepEqual(resolvePosition(plan, { itemIndex: 2, itemId: 4, at: '2026-11-01T09:14:00Z' }, now), { index: 3, at: at('2026-11-01T09:14:00Z') })
  assert.equal(resolvePosition(plan, { itemIndex: 0, itemId: 1, at: '2026-11-01T09:14:00Z' }, now), null) // Überschrift
  assert.equal(resolvePosition(plan, { itemIndex: 3, itemId: 999, at: '2026-11-01T09:14:00Z' }, now), null) // Punkt weg
  assert.equal(resolvePosition(plan, { itemIndex: 3, itemId: 4, at: '2026-10-30T09:14:00Z' }, now), null) // älter als ein Tag
  assert.equal(resolvePosition(plan, null, now), null)
  // Ohne ID zählt der Index
  assert.equal(resolvePosition(plan, { itemIndex: 2, at: '2026-11-01T09:14:00Z' }, now).index, 2)
  // Ungültige Position → wieder nach Uhr
  assert.equal(agendaStatus(plan, { position: { itemIndex: 0, itemId: 1, at: '2026-11-01T09:14:00Z' }, now }).manual, false)
})
