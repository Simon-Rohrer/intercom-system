'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createGrandma3, normalizeGrandma3, parseOsc, parseCueText, parseSequenceMessage } = require('../grandma3')

/** OSC-Nachricht bauen, wie sie die Konsole schickt (nur für die Tests) */
function osc(address, tags, ...values) {
  const pad = (b) => Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))])
  const parts = [pad(Buffer.from(address)), pad(Buffer.from(`,${tags}`))]
  let v = 0
  for (const tag of tags) {
    if (tag === 'i') {
      const b = Buffer.alloc(4)
      b.writeInt32BE(values[v++])
      parts.push(b)
    } else if (tag === 'f') {
      const b = Buffer.alloc(4)
      b.writeFloatBE(values[v++])
      parts.push(b)
    } else if (tag === 's') parts.push(pad(Buffer.from(values[v++])))
    else if (tag === 'b') {
      const data = values[v++]
      const len = Buffer.alloc(4)
      len.writeInt32BE(data.length)
      parts.push(len, pad(Buffer.from(data)))
    }
    // T/F/N/I haben keine Daten
  }
  return Buffer.concat(parts)
}

function bundle(...messages) {
  const head = Buffer.concat([Buffer.from('#bundle\0'), Buffer.alloc(8)])
  return Buffer.concat([head, ...messages.flatMap((m) => {
    const len = Buffer.alloc(4)
    len.writeInt32BE(m.length)
    return [len, m]
  })])
}

test('grandMA3: OSC-Parser liest Nachricht, Typen und Bundles', () => {
  const [m] = parseOsc(osc('/13.13.1.6.1', 'sis', 'Go+', 1, 'Sequence 1 Cue 12 "Lobpreis"'))
  assert.equal(m.address, '/13.13.1.6.1')
  assert.deepEqual(m.args, [
    { type: 's', value: 'Go+' },
    { type: 'i', value: 1 },
    { type: 's', value: 'Sequence 1 Cue 12 "Lobpreis"' },
  ])
  const [f] = parseOsc(osc('/13.13.1.6.1', 'sif', 'FaderMaster', 3, 63.5))
  assert.equal(f.args[2].type, 'f')
  assert.ok(Math.abs(f.args[2].value - 63.5) < 0.001)
  const [t] = parseOsc(osc('/Page1/Key201', 'TFN'))
  assert.deepEqual(t.args.map((a) => a.value), [true, false, null])
  const [b] = parseOsc(osc('/x', 'b', Buffer.from([1, 2, 3])))
  assert.deepEqual([...b.args[0].value], [1, 2, 3])
  const list = parseOsc(bundle(osc('/a', 'i', 1), osc('/b', 'i', 2)))
  assert.deepEqual(list.map((x) => x.address), ['/a', '/b'])
  // Müll bleibt leer, zu kurze Pakete kippen nichts
  assert.deepEqual(parseOsc(Buffer.from('hallo')), [])
  assert.deepEqual(parseOsc(Buffer.alloc(2)), [])
  assert.deepEqual(parseOsc(osc('/x', 'i', 1).subarray(0, 9)), [{ address: '/x', args: [] }])
})

test('grandMA3: Cue-Text deuten', () => {
  assert.deepEqual(parseCueText('Sequence 3 Cue 12 "Lobpreis"'), { sequenceName: '', number: '12', name: 'Lobpreis' })
  assert.deepEqual(parseCueText('Strobe 1 Cue 1'), { sequenceName: 'Strobe 1', number: '1', name: '' })
  assert.deepEqual(parseCueText('Predigt Cue 2.5 Warm'), { sequenceName: 'Predigt', number: '2.5', name: 'Warm' })
  assert.deepEqual(parseCueText('Off'), { sequenceName: '', number: null, name: 'Off' })
})

test('grandMA3: Sequenznachrichten mit und ohne Prefix, fremde Adressen ignorieren', () => {
  const key = parseOsc(osc('/13.13.1.6.1', 'sis', 'Go+', 0, 'Licht Cue 12 "Lobpreis"'))[0]
  assert.deepEqual(parseSequenceMessage(key), {
    seq: 1,
    kind: 'key',
    func: 'Go+',
    state: 0,
    cue: { sequenceName: 'Licht', number: '12', name: 'Lobpreis' },
    fader: null,
  })
  // Companion-Modul: anderer Objektpfad (14.14.1.6) wird auch verstanden
  assert.equal(parseSequenceMessage(parseOsc(osc('/14.14.1.6.7', 'si', 'Flash', 1))[0]).seq, 7)
  // Prefix „gma3“ muss passen
  const pre = parseOsc(osc('/gma3/13.13.1.6.2', 'sif', 'FaderMaster', 3, 50))[0]
  assert.equal(parseSequenceMessage(pre), null)
  const fader = parseSequenceMessage(pre, { prefix: 'gma3' })
  assert.equal(fader.kind, 'fader')
  assert.equal(fader.seq, 2)
  assert.equal(fader.fader, 50)
  // Drehgeber
  assert.equal(parseSequenceMessage(parseOsc(osc('/13.13.1.6.2', 'sii', 'FaderMaster', 0, -1))[0]).kind, 'knob')
  // Eigener Pfad aus den Einstellungen
  assert.equal(parseSequenceMessage(parseOsc(osc('/15.15.1.6.3', 'si', 'Go+', 1))[0], { seqPaths: ['15.15.1.6'] }).seq, 3)
  // Nicht zu einer Sequenz gehörend: Master, Fader-Eingaben, Kommandos
  assert.equal(parseSequenceMessage(parseOsc(osc('/13.12.1.1', 'si', 'Black', 1))[0]), null)
  assert.equal(parseSequenceMessage(parseOsc(osc('/Page1/Fader201', 'i', 100))[0]), null)
  assert.equal(parseSequenceMessage(parseOsc(osc('/cmd', 's', 'Go+ Sequence 1'))[0]), null)
  // Eigene Lua-Nachricht /jms/cue
  assert.deepEqual(parseSequenceMessage(parseOsc(osc('/jms/cue', 'iss', 4, '3', 'Predigt'))[0]), {
    seq: 4,
    kind: 'cue',
    func: 'cue',
    state: null,
    cue: { number: '3', name: 'Predigt', sequenceName: '' },
    fader: null,
  })
})

test('grandMA3: Konfiguration normalisieren', () => {
  assert.deepEqual(normalizeGrandma3(undefined), { enabled: true, host: '', port: 8001, prefix: '', seqPath: '', sequences: [] })
  const cfg = normalizeGrandma3({
    host: '192.168.0.231',
    port: '9000',
    prefix: '/gma3/',
    seqPath: '14.14.1.6',
    sequences: [{ number: 1, name: 'Licht' }, { number: 1 }, { number: 'x' }, { number: 5 }],
  })
  assert.deepEqual(cfg, {
    enabled: true,
    host: '192.168.0.231',
    port: 9000,
    prefix: 'gma3',
    seqPath: '14.14.1.6',
    sequences: [{ number: 1, name: 'Licht' }, { number: 5, name: '' }],
  })
  assert.equal(normalizeGrandma3({ host: 'konsole.local' }).host, '')
  assert.equal(normalizeGrandma3({ seqPath: 'abc' }).seqPath, '')
})

/** Nachgebildetes dgram: der Test schickt die Pakete selbst */
function fakeDgram() {
  const sockets = []
  return {
    sockets,
    createSocket() {
      const s = new EventEmitter()
      s.bound = null
      s.closed = false
      s.bind = (port) => {
        s.bound = port
        setImmediate(() => s.emit('listening'))
      }
      s.close = () => {
        s.closed = true
      }
      sockets.push(s)
      return s
    },
  }
}

const tick = () => new Promise((r) => setImmediate(r))

test('grandMA3: lauscht, hält Cue je Sequenz, ignoriert fremde Absender, bindet bei Portwechsel neu', async (t) => {
  const dgramImpl = fakeDgram()
  const updates = []
  const logs = []
  let clock = 5000
  let config = { host: '192.168.0.231', port: 8001, sequences: [{ number: 1, name: 'Licht' }, { number: 3, name: '' }] }
  const ma = createGrandma3({ getConfig: () => config, onUpdate: (m) => updates.push(m), log: (l) => logs.push(l), dgramImpl, now: () => clock })
  t.after(() => ma.stop())
  ma.start()
  const s = dgramImpl.sockets[0]
  assert.equal(s.bound, 8001)
  await tick()
  assert.equal(ma.snapshot().state, 'listening')
  let snap = ma.snapshot()
  assert.deepEqual(snap.sequences.map((q) => [q.number, q.name, q.cue]), [[1, 'Licht', null], [3, 'Sequenz 3', null]])

  const from = { address: '192.168.0.231', port: 8000 }
  // Cue-Nummer kommt beim Loslassen der Taste
  s.emit('message', osc('/13.13.1.6.1', 'sis', 'Go+', 1, 'Licht Cue 11 "Begrüßung"'), from)
  s.emit('message', osc('/13.13.1.6.1', 'sis', 'Go+', 0, 'Licht Cue 12 "Lobpreis"'), from)
  snap = updates[updates.length - 1]
  assert.equal(snap.type, 'grandma3')
  assert.equal(snap.state, 'ok')
  assert.deepEqual(snap.sequences[0].cue, { number: '12', name: 'Lobpreis' })
  assert.equal(snap.sequences[0].at, 5000)
  assert.equal(snap.lastFrom, '192.168.0.231')

  // Fader der Sequenz 3 – Cue bleibt leer, Faderwert kommt dazu
  s.emit('message', osc('/13.13.1.6.3', 'sif', 'FaderMaster', 3, 75), from)
  snap = updates[updates.length - 1]
  assert.equal(snap.sequences[1].fader, 75)
  assert.equal(snap.sequences[1].cue, null)
  // Taste „Off“ ohne Cue-Angabe lässt den letzten Cue stehen
  s.emit('message', osc('/13.13.1.6.1', 'sis', 'Off', 1, 'Off'), from)
  assert.deepEqual(ma.snapshot().sequences[0].cue, { number: '12', name: 'Lobpreis' })

  // Sequenz 9 ist nicht konfiguriert: kein Update, aber in „gesehen“
  const n = updates.length
  s.emit('message', osc('/13.13.1.6.9', 'si', 'Go+', 1), from)
  assert.equal(updates.length, n)
  assert.deepEqual(ma.snapshot().seen, [1, 3, 9])

  // Fremder Absender wird ignoriert (einmal geloggt)
  s.emit('message', osc('/13.13.1.6.1', 'sis', 'Go+', 0, 'Licht Cue 99 "Fremd"'), { address: '192.168.0.50', port: 1 })
  s.emit('message', osc('/13.13.1.6.1', 'sis', 'Go+', 0, 'Licht Cue 99 "Fremd"'), { address: '192.168.0.50', port: 1 })
  assert.equal(ma.snapshot().sequences[0].cue.number, '12')
  assert.equal(logs.filter((l) => l.includes('ignoriert')).length, 1)

  // Bundle mit /jms/cue vom Lua-Plugin
  s.emit('message', bundle(osc('/jms/cue', 'iss', 3, '4', 'Predigt')), from)
  assert.deepEqual(ma.snapshot().sequences[1].cue, { number: '4', name: 'Predigt' })

  // Portwechsel: alten Socket schließen, neu binden
  config = { ...config, port: 9001 }
  ma.reconfigure()
  assert.equal(s.closed, true)
  assert.equal(dgramImpl.sockets[1].bound, 9001)
  // Port belegt → Fehler
  dgramImpl.sockets[1].emit('error', Object.assign(new Error('bind EADDRINUSE'), { code: 'EADDRINUSE' }))
  assert.equal(ma.snapshot().state, 'error')
  assert.match(ma.snapshot().error, /9001/)
  // Ausschalten
  config = { ...config, enabled: false }
  ma.reconfigure()
  assert.equal(ma.snapshot().state, 'off')
})
