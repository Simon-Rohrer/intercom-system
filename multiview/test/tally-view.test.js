'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Kleines Ersatz-DOM: genug für die Kacheln „Tally“ und „Event-Ops“
function fakeElement(tag) {
  const classes = new Set()
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    hidden: false,
    textContent: '',
    title: '',
    isConnected: true,
    style: { setProperty() {} },
    classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    append: (...kids) => node.children.push(...kids),
    replaceChildren: (...kids) => (node.children = kids),
    set className(v) { v.split(' ').filter(Boolean).forEach((c) => classes.add(c)) },
    get className() { return [...classes].join(' ') },
  }
  return node
}

// Nacheinander laden: Die Intervalle der Module dürfen den Test-Prozess nicht am Leben halten (unref)
const modules = (async () => {
  global.document = { createElement: fakeElement }
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try {
    const load = (file) => import(`data:text/javascript;base64,${Buffer.from(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8')).toString('base64')}`)
    return { tally: await load('tally.js'), ampel: await load('ampel.js') }
  } finally { global.setInterval = original }
})()
const tally = modules.then((m) => m.tally)
const ampel = modules.then((m) => m.ampel)

const atem = { connected: true, program: [2], preview: [1], inputs: { 1: { longName: 'Kamera 1', shortName: 'CAM1' }, 2: { longName: 'Kamera 2', shortName: 'CAM2' } }, recording: true, streaming: null }

test('Tally-Optionen: Eingang als Zahl, Darstellung, Grenzen', async () => {
  const { tallyOptions } = await tally
  assert.deepEqual(tallyOptions({}), { input: null, mode: 'field', label: '', name: true, status: false, border: 1, size: 1 })
  assert.equal(tallyOptions({ input: '3' }).input, 3)
  assert.equal(tallyOptions({ input: 'abc' }).input, null)
  assert.equal(tallyOptions({ mode: 'frame', border: 99, size: 0.1 }).mode, 'frame')
  assert.equal(tallyOptions({ border: 99 }).border, 4)
  assert.equal(tallyOptions({ size: 0.1 }).size, 0.5)
})

test('Tally-Zustand und Name', async () => {
  const { tallyState, tallyName, tallyOptions } = await tally
  assert.equal(tallyState(2, atem), 'program')
  assert.equal(tallyState(1, atem), 'preview')
  assert.equal(tallyState(3, atem), 'off')
  assert.equal(tallyState(null, atem), 'off')
  assert.equal(tallyState(2, { connected: false }), 'offline')
  assert.equal(tallyState(2, null), 'offline')
  assert.equal(tallyName(tallyOptions({ input: 1 }), atem), 'Kamera 1')
  assert.equal(tallyName(tallyOptions({ input: 7 }), atem), 'Eingang 7')
  assert.equal(tallyName(tallyOptions({ input: 1, label: 'Pult' }), atem), 'Pult')
  assert.equal(tallyName(tallyOptions({}), atem), 'Kein Eingang gewählt')
})

test('Tally-Feld: Farbe folgt dem ATEM, Name und REC-Zeichen', async () => {
  const { createTallyView } = await tally
  const view = createTallyView({ input: 2, status: true })
  const root = view.el
  assert.equal(root.classList.contains('field'), true)
  const [name, state, badges] = root.children
  view.update(atem)
  assert.equal(root.classList.contains('program'), true)
  assert.equal(name.textContent, 'Kamera 2')
  assert.equal(state.textContent, 'Auf Sendung')
  assert.equal(badges.children[0].hidden, false, 'REC sichtbar')
  assert.equal(badges.children[1].hidden, true, 'STREAM nicht gemeldet')
  view.update({ ...atem, program: [1], preview: [2], recording: false })
  assert.equal(root.classList.contains('program'), false)
  assert.equal(root.classList.contains('preview'), true)
  assert.equal(state.textContent, 'Vorschau')
  assert.equal(badges.children[0].hidden, true)
  view.update({ connected: false })
  assert.equal(root.classList.contains('offline'), true)
  assert.equal(state.textContent, 'ATEM nicht verbunden')
})

test('Tally-Rahmen: kein Name, kein Zustandstext – nur die Klasse für den Rand', async () => {
  const { createTallyView } = await tally
  const view = createTallyView({ input: 1, mode: 'frame' })
  assert.equal(view.el.classList.contains('frame'), true)
  assert.equal(view.el.children.length, 0)
  view.update(atem)
  assert.equal(view.el.classList.contains('preview'), true)
})

const ops = {
  type: 'ops', state: 'ok', error: '', overall: 'warn', at: Date.now(), event: 'Gottesdienst',
  counts: { ok: 2, warn: 1, error: 0, unknown: 1 },
  items: [
    { id: 'kesher', name: 'Kesher', short: 'Kesher prüfen', status: 'warn', level: 'warn', required: true, manual: false, detail: 'd' },
    { id: 'led', name: 'LED-Wand – Bildkontrolle', short: 'LED-Wand bestätigen', status: 'unknown', level: 'ok', required: false, manual: true, detail: '' },
    { id: 'jms', name: 'JMS Control', short: 'JMS Control', status: 'ok', level: 'ok', required: true, manual: false, detail: '' },
  ],
}

test('Ampel-Ansicht: nur Probleme oder alles, veraltete Daten, Fehler', async () => {
  const { opsOptions, opsView } = await ampel
  assert.deepEqual(opsOptions({}), { title: 'Event-Ops', all: false, event: true, size: 1 })
  const only = opsView(ops, opsOptions({}))
  assert.equal(only.overall, 'warn')
  assert.equal(only.text, 'Prüfen')
  assert.deepEqual(only.items.map((i) => i.id), ['kesher'])
  assert.equal(only.note, '')
  assert.equal(only.stale, false)
  const all = opsView(ops, opsOptions({ all: true }))
  assert.equal(all.items.length, 3)
  assert.equal(opsView(null, opsOptions({})).text, 'Verbinde …')
  const old = opsView({ ...ops, at: Date.now() - 10 * 60000 }, opsOptions({}))
  assert.equal(old.stale, true)
  assert.equal(old.note, 'Keine aktuellen Daten')
  assert.equal(old.overall, 'warn', 'letzte Farbe bleibt, wenn der Stand nur alt ist')
  const err = opsView({ ...ops, state: 'error', error: 'ChurchTools weg', overall: 'unknown' }, opsOptions({}))
  assert.equal(err.overall, 'unknown')
  assert.equal(err.note, 'ChurchTools weg')
  assert.equal(opsView({ ...ops, items: [], overall: 'unknown' }, opsOptions({})).note, 'Keine Prüfungen eingerichtet')
})

test('Ampel-Kachel: Klassen, Liste und Hinweistext', async () => {
  const { createOpsView } = await ampel
  const view = createOpsView({ title: 'Ops' })
  const root = view.el
  const [header, main, list, note] = root.children
  assert.equal(header.children[0].textContent, 'Ops')
  view.update(ops)
  assert.equal(root.classList.contains('warn'), true)
  assert.equal(header.children[1].textContent, 'Prüfen')
  assert.equal(main.children[1].children[1].textContent, 'Gottesdienst')
  assert.equal(list.children.length, 1)
  assert.equal(list.children[0].children[1].textContent, 'Kesher prüfen')
  assert.equal(list.children[0].classList.contains('warn'), true)
  view.update({ ...ops, overall: 'ok', items: ops.items.filter((i) => i.level === 'ok') })
  assert.equal(root.classList.contains('ok'), true)
  assert.equal(list.children.length, 0)
  assert.equal(note.textContent, 'Alle Prüfungen in Ordnung')
  view.update({ ...ops, overall: 'error', items: [{ ...ops.items[0], status: 'error', level: 'error', short: 'ATEM-Steuerung prüfen' }] })
  assert.equal(root.classList.contains('error'), true)
  assert.equal(header.children[1].textContent, 'Störung')
  assert.equal(list.children[0].children[1].textContent, 'ATEM-Steuerung prüfen')
})
