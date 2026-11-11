'use strict'

// Hervorgehobener Punkt im Ablauf (Klick) und Fern-Scrollen der Ablauf-Kacheln:
// Server-Zustand, Umschalten, Verfallen, Speicherung und die Abbildung im Browser-Modul.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createAgendaHighlight, HIGHLIGHT_MAX_AGE_MS } = require('../agenda-highlight')
const { scrollMessage } = require('../agenda-scroll')

// Browser-Modul ohne dessen UI-Takt laden (wie in agenda.test.js)
const browser = (async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/agenda.js'), 'utf8')
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const T0 = Date.parse('2026-11-01T09:00:00Z')
const items = [
  { id: 1, type: 'header', title: 'Gottesdienst', start: '2026-11-01T09:00:00Z', duration: 0 },
  { id: 2, type: 'song', title: 'Lied 1', start: '2026-11-01T09:00:00Z', duration: 300 },
  { id: 3, type: 'normal', title: 'Begrüßung', start: '2026-11-01T09:05:00Z', duration: 300 },
  { id: 4, type: 'song', title: 'Lied 2', start: '2026-11-01T09:10:00Z', duration: 300 },
]
const events = [{ id: 42, name: 'Gottesdienst', agenda: { items } }, { id: 43, name: 'Ohne Ablauf', agenda: null }]

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-hl-'))
  let now = T0
  const updates = []
  const hl = createAgendaHighlight({ dataDir: dir, getEvents: () => events, onUpdate: (m) => updates.push(m), now: () => now, ...extra })
  t.after(() => {
    hl.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, hl, updates, tick: (ms) => (now += ms) }
}

test('Hervorheben, zweiter Klick hebt auf, Fehlerfälle', (t) => {
  const { hl, updates } = setup(t)
  assert.deepEqual(hl.snapshot(), { type: 'cthighlight', highlights: {} })
  const snap = hl.set({ eventId: 42, itemIndex: 3, toggle: true }, 'Laptop')
  assert.deepEqual(snap.highlights['42'], { itemIndex: 3, itemId: 4, at: '2026-11-01T09:00:00.000Z', by: 'Laptop' })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].type, 'cthighlight')

  // Anderer Punkt: Hervorhebung wandert
  assert.equal(hl.set({ eventId: 42, itemIndex: 1, toggle: true }).highlights['42'].itemIndex, 1)
  // Derselbe Punkt mit toggle: aufgehoben
  assert.equal(hl.set({ eventId: 42, itemIndex: 1, toggle: true }).highlights['42'], undefined)
  assert.equal(updates.length, 3)
  // Ohne toggle bleibt derselbe Punkt hervorgehoben (z. B. erneut setzen)
  hl.set({ eventId: 42, itemIndex: 2 })
  assert.equal(hl.set({ eventId: 42, itemIndex: 2 }).highlights['42'].itemIndex, 2)
  // Aufheben per null und per action 'clear'
  hl.set({ eventId: 42, itemIndex: null })
  assert.equal(hl.get(42), null)
  const count = updates.length
  hl.set({ eventId: 42, action: 'clear' }) // schon aufgehoben: keine weitere Nachricht
  assert.equal(updates.length, count)

  assert.throws(() => hl.set({ eventId: 42, itemIndex: 0 }), /Überschriften/)
  assert.throws(() => hl.set({ eventId: 42, itemIndex: 99 }), /ungültig/)
  assert.throws(() => hl.set({ eventId: 42, itemIndex: 'abc' }), /ungültig/)
  assert.throws(() => hl.set({ eventId: 7, itemIndex: 1 }), (e) => e.status === 404)
  assert.throws(() => hl.set({ eventId: 43, itemIndex: 0 }), /keinen Ablauf/)
  assert.throws(() => hl.set({}), /eventId/)
  assert.throws(() => hl.set({ eventId: 42, action: 'dance' }), /Unbekannte Aktion/)
})

test('Hervorhebung verfällt nach 10 Minuten und übersteht einen Neustart', (t) => {
  const { dir, hl, tick } = setup(t)
  hl.set({ eventId: 42, itemIndex: 2 }, 'Laptop')
  assert.ok(fs.existsSync(path.join(dir, 'agenda-highlight.json')))
  // Neustart: Stand aus der Datei
  const again = createAgendaHighlight({ dataDir: dir, getEvents: () => events, now: () => T0 + 60 * 1000 })
  t.after(() => again.close())
  assert.equal(again.get(42).itemIndex, 2)
  tick(HIGHLIGHT_MAX_AGE_MS - 1000)
  assert.equal(hl.get(42).itemIndex, 2)
  tick(1000)
  assert.equal(hl.get(42), null)
  assert.deepEqual(hl.snapshot().highlights, {})
  // Kaputte Datei: leer anfangen
  fs.writeFileSync(path.join(dir, 'agenda-highlight.json'), '[1,2')
  const broken = createAgendaHighlight({ dataDir: dir, getEvents: () => events })
  t.after(() => broken.close())
  assert.deepEqual(broken.snapshot().highlights, {})
})

test('Verfallen wird allen Kacheln gemeldet – auch wenn ein Snapshot den Eintrag schon entfernt hat', async (t) => {
  const updates = []
  const hl = createAgendaHighlight({ getEvents: () => events, onUpdate: (m) => updates.push(m), maxAgeMs: 40 })
  t.after(() => hl.close())
  hl.set({ eventId: 42, itemIndex: 1 })
  assert.equal(updates.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 45))
  assert.deepEqual(hl.snapshot().highlights, {}) // z. B. ein neuer Monitor verbindet sich
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(updates.length, 2)
  assert.deepEqual(updates[1].highlights, {})
})

test('Fern-Scrollen: Befehl prüfen, alle Kacheln oder ein Event', () => {
  const now = () => T0
  assert.deepEqual(scrollMessage({ action: 'down' }, () => null, now), { type: 'ctscroll', action: 'down', eventId: null, at: '2026-11-01T09:00:00.000Z' })
  assert.equal(scrollMessage({ action: 'up', eventId: 'all' }, () => 42, now).eventId, null)
  assert.equal(scrollMessage({ action: 'live', eventId: 'current' }, () => 42, now).eventId, '42')
  assert.equal(scrollMessage({ action: 'up', eventId: 4711 }, () => null, now).eventId, '4711')
  assert.throws(() => scrollMessage({ action: 'live', eventId: 'current' }, () => null, now), (e) => e.status === 404)
  for (const action of [undefined, '', 'left', 'next'])
    assert.throws(() => scrollMessage({ action }, () => null, now), (e) => e.status === 400 && /Unbekannte Aktion/.test(e.message))
})

test('Browser: Hervorhebung auf den Ablauf abbilden (ID wiederfinden, verfallen, Überschriften nie)', async () => {
  const { resolveHighlight } = await browser
  const at = '2026-11-01T09:00:00.000Z'
  assert.equal(resolveHighlight(items, null, T0), -1)
  assert.equal(resolveHighlight(items, { itemIndex: 3, itemId: 4, at }, T0), 3)
  // Ablauf in ChurchTools verschoben: ID findet den Punkt wieder
  const moved = [items[0], items[3], items[1], items[2]]
  assert.equal(resolveHighlight(moved, { itemIndex: 3, itemId: 4, at }, T0), 1)
  // Punkt gelöscht
  assert.equal(resolveHighlight(items.slice(0, 3), { itemIndex: 3, itemId: 4, at }, T0), -1)
  // Ohne ID zählt der Index, Überschriften nie
  assert.equal(resolveHighlight(items, { itemIndex: 2, itemId: null, at }, T0), 2)
  assert.equal(resolveHighlight(items, { itemIndex: 0, itemId: null, at }, T0), -1)
  // Nach 10 Minuten verfallen (wie am Server)
  assert.equal(resolveHighlight(items, { itemIndex: 3, itemId: 4, at }, T0 + HIGHLIGHT_MAX_AGE_MS - 1), 3)
  assert.equal(resolveHighlight(items, { itemIndex: 3, itemId: 4, at }, T0 + HIGHLIGHT_MAX_AGE_MS), -1)
  assert.equal(resolveHighlight(items, { itemIndex: 3, itemId: 4, at: 'kaputt' }, T0), -1)
})
