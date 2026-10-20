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
    children: [], textContent: '', classList: { toggle() {}, add() {} },
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
