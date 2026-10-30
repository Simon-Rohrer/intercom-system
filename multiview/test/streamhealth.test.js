'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Kleines Ersatz-DOM: genug für die Kachel „Stream-Gesundheit“
function fakeElement(tag) {
  const classes = new Set()
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    hidden: false,
    textContent: '',
    isConnected: true,
    style: { setProperty() {} },
    classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    append: (...kids) => node.children.push(...kids),
    set className(v) { v.split(' ').filter(Boolean).forEach((c) => classes.add(c)) },
    get className() { return [...classes].join(' ') },
  }
  return node
}

const mod = (async () => {
  global.document = { createElement: fakeElement }
  const source = fs.readFileSync(path.join(__dirname, '../public/streamhealth.js'), 'utf8')
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const now = 1_800_000_000_000
const seg = (s, key) => s.segments.find((x) => x.key === key)
const live = { state: 'ok', video: { status: 'live', viewers: 123, peak: 200, actualStart: now - 90 * 60000 }, encoder: { state: 'unconfigured' }, atem: { state: 'nostream' }, problems: [] }
const uplinkOk = (up, maxUp = 50e6) => ({ state: 'ok', maxUp, history: [{ t: now - 1000, up, down: 0 }] })

test('Optionen: Standardwerte, Grenzen, Rot nie über Gelb', async () => {
  const { streamHealthOptions } = await mod
  const o = streamHealthOptions({})
  assert.equal(o.warnReserve, 20)
  assert.equal(o.badReserve, 10)
  assert.equal(o.size, 1)
  assert.equal(o.header, true)
  assert.equal(streamHealthOptions({ size: 9 }).size, 2.5)
  assert.equal(streamHealthOptions({ warnReserve: 5, badReserve: 30 }).badReserve, 5)
  assert.equal(streamHealthOptions({ title: 'x'.repeat(50) }).title.length, 40)
})

test('Ohne Daten: alles neutral, Gesamt neutral', async () => {
  const { streamHealthState } = await mod
  const s = streamHealthState({ youtube: null, uplink: null }, {}, now)
  assert.equal(s.live, false)
  assert.equal(s.level, 'muted')
  assert.deepEqual(s.segments.map((x) => x.level), ['muted', 'muted', 'muted', 'muted'])
  assert.equal(seg(s, 'youtube').sub, 'Verbinde')
})

test('Live mit Monarch, gutem Empfang und viel Reserve: alles grün', async () => {
  const { streamHealthState } = await mod
  const yt = { ...live, encoder: { state: 'streaming', input: { signal: true, label: 'SDI 1080p50' } }, health: { stream: 'active', status: 'good' } }
  const s = streamHealthState({ youtube: yt, uplink: uplinkOk(8e6) }, {}, now)
  assert.equal(s.live, true)
  assert.equal(s.level, 'ok')
  assert.equal(seg(s, 'encoder').label, 'Monarch')
  assert.equal(seg(s, 'encoder').value, 'sendet')
  assert.equal(seg(s, 'encoder').sub, 'SDI 1080p50')
  assert.equal(seg(s, 'youtube').value, 'Live')
  assert.equal(seg(s, 'youtube').sub, 'Empfang gut')
  assert.equal(seg(s, 'viewers').value, '123')
  assert.equal(seg(s, 'viewers').sub, 'Spitze 200')
  assert.equal(seg(s, 'upload').value, '8,0 Mbit/s')
  assert.equal(seg(s, 'upload').sub, '84 % frei von 50,0 Mbit/s')
  assert.equal(seg(s, 'upload').level, 'ok')
})

test('Upload-Reserve: einstellbare Schwellen für gelb und rot', async () => {
  const { streamHealthState } = await mod
  const yt = { ...live, video: { status: 'none' } }
  assert.equal(seg(streamHealthState({ youtube: yt, uplink: uplinkOk(42e6) }, {}, now), 'upload').level, 'warn') // 16 % frei
  assert.equal(seg(streamHealthState({ youtube: yt, uplink: uplinkOk(46e6) }, {}, now), 'upload').level, 'bad') // 8 % frei
  assert.equal(seg(streamHealthState({ youtube: yt, uplink: uplinkOk(42e6) }, { warnReserve: 10, badReserve: 5 }, now), 'upload').level, 'ok')
  assert.equal(streamHealthState({ youtube: yt, uplink: uplinkOk(46e6) }, {}, now).level, 'bad')
  // Ohne Leitungsgeschwindigkeit keine Reserve, aber der Wert
  const noMax = seg(streamHealthState({ youtube: yt, uplink: uplinkOk(5e6, 0) }, {}, now), 'upload')
  assert.equal(noMax.level, 'ok')
  assert.equal(noMax.sub, '')
})

test('Upload: veraltete Werte, Fehler und abgeschaltete Abfrage', async () => {
  const { streamHealthState } = await mod
  const stale = { state: 'ok', maxUp: 50e6, history: [{ t: now - 30_000, up: 8e6, down: 0 }] }
  assert.equal(seg(streamHealthState({ youtube: null, uplink: stale }, {}, now), 'upload').level, 'warn')
  assert.equal(seg(streamHealthState({ youtube: null, uplink: stale }, {}, now), 'upload').sub, 'keine Daten')
  const err = seg(streamHealthState({ youtube: null, uplink: { state: 'error', error: 'FRITZ!Box antwortet nicht' } }, {}, now), 'upload')
  assert.equal(err.level, 'warn')
  assert.equal(err.value, 'offline')
  const off = seg(streamHealthState({ youtube: null, uplink: { state: 'off' } }, {}, now), 'upload')
  assert.equal(off.level, 'muted')
  assert.equal(off.sub, 'Abfrage aus')
  // Während des Streams praktisch kein Upload: rot, auch wenn die Reserve riesig ist
  assert.equal(seg(streamHealthState({ youtube: live, uplink: uplinkOk(0.3e6) }, {}, now), 'upload').level, 'bad')
})

test('Encoder sendet nicht, während YouTube live ist: rot – ohne Stream nur neutral/gelb', async () => {
  const { streamHealthState } = await mod
  const ready = { state: 'ready', input: { signal: true, label: 'SDI 1080p50' } }
  const offline = { ...live, video: { status: 'none' } }
  assert.equal(seg(streamHealthState({ youtube: { ...live, encoder: ready } }, {}, now), 'encoder').level, 'bad')
  assert.equal(seg(streamHealthState({ youtube: { ...offline, encoder: ready } }, {}, now), 'encoder').level, 'muted')
  assert.equal(seg(streamHealthState({ youtube: { ...live, encoder: { state: 'error', error: 'Monarch nicht erreichbar' } } }, {}, now), 'encoder').level, 'bad')
  assert.equal(seg(streamHealthState({ youtube: { ...offline, encoder: { state: 'error', error: 'Monarch nicht erreichbar' } } }, {}, now), 'encoder').level, 'warn')
  // Kein Bild am Eingang: rot, obwohl sie sendet
  const noSignal = seg(streamHealthState({ youtube: { ...live, encoder: { state: 'streaming', input: { signal: false, label: 'kein Signal' } } } }, {}, now), 'encoder')
  assert.equal(noSignal.level, 'bad')
  assert.equal(noSignal.sub, 'kein Bild am Eingang')
})

test('Ohne Monarch zählt der ATEM als Encoder, wenn er selbst streamt', async () => {
  const { streamHealthState } = await mod
  const yt = { ...live, atem: { state: 'streaming', bitrate: 6e6, cache: 12, error: false } }
  const e = seg(streamHealthState({ youtube: yt }, {}, now), 'encoder')
  assert.equal(e.label, 'ATEM')
  assert.equal(e.value, 'sendet')
  assert.equal(e.sub, '6,0 Mbit/s · Puffer 12 %')
  assert.equal(e.level, 'ok')
  assert.equal(seg(streamHealthState({ youtube: { ...live, atem: { state: 'idle' } } }, {}, now), 'encoder').level, 'bad')
  assert.equal(seg(streamHealthState({ youtube: { ...live, atem: { state: 'off' } } }, {}, now), 'encoder').sub, 'ATEM nicht verbunden')
})

test('YouTube: Empfang schlecht/ok/nichts, geplant, beendet, Fehler, nicht eingerichtet', async () => {
  const { streamHealthState } = await mod
  const y = (yt) => seg(streamHealthState({ youtube: yt }, {}, now), 'youtube')
  assert.equal(y({ ...live, health: { stream: 'active', status: 'bad' } }).level, 'bad')
  assert.equal(y({ ...live, health: { stream: 'active', status: 'ok' } }).level, 'warn')
  const none = y({ ...live, health: { stream: 'inactive', status: 'noData' } })
  assert.equal(none.level, 'bad')
  assert.equal(none.sub, 'empfängt nichts')
  assert.equal(y(live).sub.startsWith('seit '), true)
  assert.equal(y({ state: 'ok', video: { status: 'upcoming', scheduledStart: now } }).value, 'Geplant')
  assert.equal(y({ state: 'ok', video: { status: 'ended', actualEnd: now } }).value, 'Beendet')
  assert.equal(y({ state: 'error', error: 'Kontingent' }).level, 'warn')
  assert.equal(y({ state: 'unconfigured' }).sub, 'nicht eingerichtet')
  assert.equal(y({ state: 'ok', video: null }).value, 'Offline')
})

test('Störungsmeldung der YouTube-Überwachung erscheint als Hinweis (abschaltbar)', async () => {
  const { streamHealthState } = await mod
  const yt = { ...live, problems: [{ level: 'warn', text: 'Hinweis' }, { level: 'error', text: 'Monarch sendet nicht mehr' }] }
  assert.equal(streamHealthState({ youtube: yt }, {}, now).note, 'Monarch sendet nicht mehr')
  assert.equal(streamHealthState({ youtube: { ...live, problems: [{ level: 'warn', text: 'Hinweis' }] } }, {}, now).note, 'Hinweis')
  assert.equal(streamHealthState({ youtube: yt }, { note: false }, now).note, '')
})

test('Ansicht: Teilstände einzeln übernehmen, Klassen und Texte folgen dem Zustand', async () => {
  const { createStreamHealthView } = await mod
  const view = createStreamHealthView({ title: 'Stream' })
  const root = view.el
  assert.equal(root.className.includes('shealth'), true)
  const [header, row, note] = root.children
  assert.equal(header.children[0].textContent, 'Stream')
  assert.equal(row.children.length, 4)
  view.update({ youtube: { ...live, encoder: { state: 'ready' } } })
  assert.equal(root.classList.contains('bad'), true)
  assert.equal(root.classList.contains('live'), true)
  assert.equal(header.children[1].textContent, 'Live · Störung')
  assert.equal(row.children[0].classList.contains('bad'), true)
  assert.equal(row.children[2].children[1].textContent, '123')
  view.update({ uplink: uplinkOk(8e6) })
  assert.equal(row.children[3].children[1].textContent, '8,0 Mbit/s')
  assert.equal(root.classList.contains('bad'), true, 'Encoder-Problem bleibt')
  view.update({ youtube: { ...live, encoder: { state: 'streaming', input: { signal: true, label: 'SDI' } } } })
  assert.equal(root.classList.contains('ok'), true)
  assert.equal(note.textContent, '')
})
