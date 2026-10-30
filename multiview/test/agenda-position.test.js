'use strict'

// Laufender Punkt im Ablauf von Hand gesetzt: Server-Zustand, Prüfung, Companion-Schritte, Speicherung.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createAgendaPosition, clockIndex } = require('../agenda-position')

const T0 = Date.parse('2026-11-01T09:00:00Z')
const items = [
  { id: 1, type: 'header', title: 'Vor dem Gottesdienst', start: '2026-11-01T08:30:00Z', duration: 0 },
  { id: 2, type: 'normal', title: 'Soundcheck', start: '2026-11-01T08:30:00Z', duration: 1800 },
  { id: 3, type: 'header', title: 'Gottesdienst', start: '2026-11-01T09:00:00Z', duration: 0 },
  { id: 4, type: 'song', title: 'Lied 1', start: '2026-11-01T09:00:00Z', duration: 300 },
  { id: 5, type: 'normal', title: 'Begrüßung', start: '2026-11-01T09:05:00Z', duration: 300, responsible: 'Anna' },
  { id: 6, type: 'normal', title: 'Predigt', start: '2026-11-01T09:10:00Z', duration: 1800, responsible: 'Pastor' },
]
const events = [{ id: 42, name: 'Gottesdienst', agenda: { items } }, { id: 43, name: 'Ohne Ablauf', agenda: null }]

function setup(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-pos-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  let now = T0
  const updates = []
  const pos = createAgendaPosition({ dataDir: dir, getEvents: () => events, onUpdate: (m) => updates.push(m), now: () => now, ...extra })
  return { dir, pos, updates, tick: (ms) => (now += ms), nowAt: () => now }
}

test('Punkt setzen, prüfen und wieder nach Uhr – alle Clients bekommen den Stand', (t) => {
  const { pos, updates } = setup(t)
  assert.deepEqual(pos.snapshot(), { type: 'ctposition', positions: {} })
  const snap = pos.set({ eventId: 42, itemIndex: 5 }, 'Lasse')
  assert.deepEqual(snap.positions['42'], { itemIndex: 5, itemId: 6, at: '2026-11-01T09:00:00.000Z', by: 'Lasse' })
  assert.equal(updates.length, 1)
  assert.equal(updates[0].type, 'ctposition')
  assert.equal(pos.get(42).itemIndex, 5)

  assert.throws(() => pos.set({ eventId: 42, itemIndex: 2 }), /Überschriften/)
  assert.throws(() => pos.set({ eventId: 42, itemIndex: 99 }), /ungültig/)
  assert.throws(() => pos.set({ eventId: 42, itemIndex: 'abc' }), /ungültig/)
  assert.throws(() => pos.set({ eventId: 7 }), (e) => e.status === 404)
  assert.throws(() => pos.set({ eventId: 43, itemIndex: 0 }), /keinen Ablauf/)
  assert.throws(() => pos.set({}), /eventId/)
  assert.throws(() => pos.set({ eventId: 42, action: 'dance' }), /Unbekannte Aktion/)

  pos.set({ eventId: 42, itemIndex: null })
  assert.equal(pos.get(42), null)
  assert.equal(updates.length, 2)
  pos.set({ eventId: 42, action: 'auto' }) // schon automatisch: keine weitere Nachricht
  assert.equal(updates.length, 2)
})

test('Companion: weiter/zurück ab dem laufenden Punkt (nach Uhr oder von Hand)', (t) => {
  const { pos, tick } = setup(t)
  tick(6 * 60 * 1000) // 09:06 → nach Uhr läuft „Begrüßung“ (Index 4)
  assert.equal(clockIndex(items, T0 + 6 * 60 * 1000), 4)
  assert.equal(pos.set({ eventId: 42, action: 'next' }).positions['42'].itemIndex, 5)
  assert.equal(pos.set({ eventId: 42, action: 'previous' }).positions['42'].itemIndex, 4)
  assert.equal(pos.set({ eventId: 42, action: 'previous' }).positions['42'].itemIndex, 3)
  assert.equal(pos.set({ eventId: 42, action: 'previous' }).positions['42'].itemIndex, 1) // Überschrift übersprungen
  assert.throws(() => pos.set({ eventId: 42, action: 'previous' }), /vorheriger/)
  pos.set({ eventId: 42, itemIndex: 5 })
  assert.throws(() => pos.set({ eventId: 42, action: 'next' }), /weiterer/)
  // Vor dem ersten Punkt (Uhr kennt keinen laufenden und keinen kommenden): „weiter“ startet vorn
  const early = createAgendaPosition({ getEvents: () => [{ id: 1, agenda: { items: items.map((i) => ({ ...i, start: null })) } }], now: () => T0 })
  assert.equal(early.set({ eventId: 1, action: 'next' }).positions['1'].itemIndex, 1)
})

test('Stand übersteht einen Neustart, alte Einträge fallen nach einem Tag weg', (t) => {
  const { dir, pos, tick } = setup(t)
  pos.set({ eventId: 42, itemIndex: 3 })
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'agenda-position.json'), 'utf8'))
  assert.equal(saved['42'].itemIndex, 3)
  const again = createAgendaPosition({ dataDir: dir, getEvents: () => events, now: () => T0 + 1000 })
  assert.equal(again.get(42).itemIndex, 3)
  tick(25 * 60 * 60 * 1000)
  assert.equal(pos.get(42), null)
  assert.deepEqual(pos.snapshot().positions, {})
  // Kaputte Datei: leer starten statt abzustürzen
  fs.writeFileSync(path.join(dir, 'agenda-position.json'), '[1,2')
  assert.deepEqual(createAgendaPosition({ dataDir: dir, getEvents: () => events }).snapshot().positions, {})
})
