'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createOpsStatus, summarizeOps, shortText, levelOf } = require('../ops-status')

const row = (id, status, more = {}) => ({ id, name: id, status, required: true, detail: `${id}-detail`, ...more })

test('Kurztexte: Namenszusatz fällt weg, Status bestimmt das Verb', () => {
  assert.equal(shortText({ name: 'LED-Wand – Bildkontrolle', status: 'unknown', manual: true }), 'LED-Wand bestätigen')
  assert.equal(shortText({ name: 'LED-Wand – Bildkontrolle', status: 'error' }), 'LED-Wand prüfen')
  assert.equal(shortText({ name: 'Kamera 2', status: 'warn' }), 'Kamera 2 prüfen')
  assert.equal(shortText({ name: 'Companion', status: 'unknown' }), 'Companion ohne Rückmeldung')
  assert.equal(shortText({ name: 'Pi Foyer', status: 'idle' }), 'Pi Foyer im Ruhemodus')
  assert.equal(shortText({ name: 'ATEM-Steuerung', status: 'ok' }), 'ATEM-Steuerung')
})

test('Ampelfarbe je Prüfung: benötigt rot/gelb, optional höchstens gelb', () => {
  assert.equal(levelOf({ status: 'error', required: true }), 'error')
  assert.equal(levelOf({ status: 'warn', required: true }), 'warn')
  assert.equal(levelOf({ status: 'unknown', required: true }), 'warn')
  assert.equal(levelOf({ status: 'error', required: false }), 'warn')
  assert.equal(levelOf({ status: 'unknown', required: false }), 'ok')
  assert.equal(levelOf({ status: 'idle', required: true }), 'ok')
  assert.equal(levelOf({ status: 'ok', required: true }), 'ok')
})

test('Zusammenfassung: Gesamtfarbe, Zähler, Sortierung und Kürzung', () => {
  const diag = {
    event: { name: 'Gottesdienst' },
    checks: [
      row('jms', 'ok'),
      row('pi', 'idle'),
      row('manual-led', 'unknown', { manual: true, required: false, name: 'LED-Wand – Bildkontrolle' }),
      row('atem', 'error', { name: 'ATEM-Steuerung' }),
      row('connection:x', 'error', { required: false, name: 'Z-Modul' }),
      row('kesher', 'warn', { name: 'Kesher', detail: 'x'.repeat(500) }),
    ],
  }
  const s = summarizeOps(diag, 1000)
  assert.equal(s.type, 'ops')
  assert.equal(s.state, 'ok')
  assert.equal(s.at, 1000)
  assert.equal(s.overall, 'error')
  assert.equal(s.event, 'Gottesdienst')
  assert.deepEqual(s.counts, { ok: 2, warn: 1, error: 2, unknown: 1 })
  // Rot zuerst (benötigt vor optional), dann Gelb, dann Unbekannt, dann Grün
  assert.deepEqual(s.items.map((i) => i.id), ['atem', 'connection:x', 'kesher', 'manual-led', 'jms', 'pi'])
  assert.deepEqual(s.items.map((i) => i.level), ['error', 'warn', 'warn', 'ok', 'ok', 'ok'])
  assert.equal(s.items[0].short, 'ATEM-Steuerung prüfen')
  assert.equal(s.items[2].detail.length, 200)
  assert.equal(s.items[3].manual, true)
  assert.equal(s.items[3].required, false)
})

test('Zusammenfassung: nur optionale Fehler → gelb, alles ok → grün, nichts → unbekannt', () => {
  assert.equal(summarizeOps({ checks: [row('a', 'ok'), row('b', 'error', { required: false })] }).overall, 'warn')
  assert.equal(summarizeOps({ checks: [row('a', 'ok'), row('b', 'unknown', { required: false }), row('c', 'idle')] }).overall, 'ok')
  assert.equal(summarizeOps({ checks: [row('a', 'ok'), row('b', 'unknown')] }).overall, 'warn')
  assert.equal(summarizeOps({ checks: [] }).overall, 'unknown')
  assert.equal(summarizeOps(null).overall, 'unknown')
  assert.equal(summarizeOps({ checks: [{ id: 'x', status: 'komisch' }] }).items[0].status, 'unknown')
})

test('Ampel-Dienst: sendet nur Änderungen, hält bei Fehlern den letzten Stand und gibt Snapshots', async () => {
  const sent = []
  let diag = { event: { name: 'E' }, checks: [row('jms', 'ok')] }
  let fail = false
  let t = 5000
  const ops = createOpsStatus({
    getDiagnostics: async () => {
      if (fail) throw new Error('ChurchTools weg')
      return diag
    },
    onUpdate: (m) => sent.push(m),
    now: () => t,
  })
  assert.equal(ops.snapshot().state, 'connecting')
  assert.equal(ops.snapshot().overall, 'unknown')

  await ops.refresh()
  assert.equal(sent.length, 1)
  assert.equal(sent[0].overall, 'ok')
  assert.equal(ops.snapshot().at, 5000)

  // Gleicher Inhalt, nur die Zeit anders: keine neue Nachricht, aber neuer Snapshot-Zeitstempel
  t = 6000
  await ops.refresh()
  assert.equal(sent.length, 1)
  assert.equal(ops.snapshot().at, 6000)

  diag = { event: { name: 'E' }, checks: [row('jms', 'ok'), row('atem', 'error')] }
  await ops.refresh()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].overall, 'error')

  fail = true
  await ops.refresh()
  assert.equal(sent.length, 3)
  assert.equal(sent[2].state, 'error')
  assert.equal(sent[2].error, 'ChurchTools weg')
  assert.equal(sent[2].overall, 'unknown')
  // Die zuletzt bekannten Punkte bleiben in der Nachricht
  assert.deepEqual(sent[2].items.map((i) => i.id), ['atem', 'jms'])
  await ops.refresh()
  assert.equal(sent.length, 3, 'gleicher Fehler nicht noch einmal')

  fail = false
  await ops.refresh()
  assert.equal(sent.length, 4)
  assert.equal(sent[3].state, 'ok')
})

test('Ampel-Dienst: ohne Ops-Kachel wird nicht geprüft, mit Kachel sofort', async () => {
  let calls = 0
  let want = false
  const ops = createOpsStatus({ getDiagnostics: async () => (calls++, { checks: [row('jms', 'ok')] }), wanted: () => want })
  ops.start()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls, 0)
  want = true
  ops.layoutsChanged()
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(calls, 1)
  assert.equal(ops.snapshot().overall, 'ok')
  ops.stop()
})
