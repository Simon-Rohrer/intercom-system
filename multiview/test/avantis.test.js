'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createAvantis, normalizeAvantis, createMidiParser, parseSysex, buildNameRequest, channelAddress, CHANNEL_TYPES } = require('../avantis')

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex')

test('Avantis: Kanaladressen wie im A&H-Protokoll (Basiskanal 1 → MIDI-Kanal 0)', () => {
  assert.deepEqual(channelAddress('input', 1, 1), { midiChannel: 0, note: 0x00 })
  assert.deepEqual(channelAddress('input', 64, 1), { midiChannel: 0, note: 0x3f })
  assert.deepEqual(channelAddress('stereoGroup', 1, 1), { midiChannel: 1, note: 0x40 })
  assert.deepEqual(channelAddress('monoAux', 3, 1), { midiChannel: 2, note: 0x02 })
  assert.deepEqual(channelAddress('dca', 1, 1), { midiChannel: 4, note: 0x36 })
  assert.deepEqual(channelAddress('dca', 16, 1), { midiChannel: 4, note: 0x45 })
  assert.deepEqual(channelAddress('muteGroup', 8, 1), { midiChannel: 4, note: 0x4d })
  assert.deepEqual(channelAddress('main', 1, 1), { midiChannel: 4, note: 0x30 })
  // Companion-Anschluss mit midiBase 2: alles einen Kanal höher
  assert.deepEqual(channelAddress('dca', 1, 2), { midiChannel: 5, note: 0x36 })
  assert.equal(channelAddress('unbekannt', 1, 1), null)
  assert.equal(Object.keys(CHANNEL_TYPES).length, 13)
})

test('Avantis: Konfiguration normalisieren – ungültige Kanäle und Dubletten fallen weg', () => {
  const cfg = normalizeAvantis({
    host: '192.168.1.70',
    port: '51325',
    midiBase: 1,
    channels: [
      { type: 'input', number: 12, name: 'Pastor-Mikro', critical: true },
      { type: 'input', number: 12, name: 'doppelt' },
      { type: 'dca', number: 3, name: ' Band ' },
      { type: 'dca', number: 17 }, // gibt es nicht
      { type: 'egal', number: 1 },
      { type: 'input', number: 0 },
    ],
    scenes: [{ number: 12, name: 'Gottesdienst' }, { number: 12, name: 'nochmal' }, { number: 'x' }],
  })
  assert.deepEqual(cfg.channels, [
    { type: 'input', number: 12, name: 'Pastor-Mikro', critical: true },
    { type: 'dca', number: 3, name: 'Band', critical: false },
  ])
  assert.deepEqual(cfg.scenes, [{ number: 12, name: 'Gottesdienst' }])
  assert.equal(cfg.port, 51325)
  assert.equal(cfg.enabled, true)
  // Standardwerte
  const empty = normalizeAvantis(undefined)
  assert.deepEqual(empty, { enabled: true, host: '', port: 51325, midiBase: 1, channels: [], scenes: [] })
  assert.equal(normalizeAvantis({ host: 'http://x/y' }).host, '')
  assert.equal(normalizeAvantis({ midiBase: 13 }).midiBase, 1)
})

test('Avantis: Mute-Nachrichten (Note On, Velocity ≥ 0x40 = stumm, 0 = Nachlauf)', () => {
  const p = createMidiParser()
  // Input 1 stumm: 90 00 7F 90 00 00 · Input 1 offen: 90 00 3F 90 00 00
  assert.deepEqual(p.feed(hex('90 00 7F 90 00 00')), [{ type: 'mute', midiChannel: 0, note: 0, muted: true }])
  assert.deepEqual(p.feed(hex('90 00 3F 90 00 00')), [{ type: 'mute', midiChannel: 0, note: 0, muted: false }])
  // DCA 3 stumm auf MIDI-Kanal 5 (Basis 1 + 4)
  assert.deepEqual(p.feed(hex('94 38 7F 94 38 00')), [{ type: 'mute', midiChannel: 4, note: 0x38, muted: true }])
  // Note Off wird ignoriert
  assert.deepEqual(p.feed(hex('80 00 40')), [])
})

test('Avantis: Running Status und zerstückelte Pakete', () => {
  const p = createMidiParser()
  // Zwei Mutes mit Running Status, in drei TCP-Häppchen
  const all = [...p.feed(hex('90 05')), ...p.feed(hex('7F 05 00 06')), ...p.feed(hex('3F 06 00'))]
  assert.deepEqual(all, [
    { type: 'mute', midiChannel: 0, note: 5, muted: true },
    { type: 'mute', midiChannel: 0, note: 6, muted: false },
  ])
  // Echtzeit-Bytes (Active Sensing) mittendrin stören nicht
  assert.deepEqual(createMidiParser().feed(hex('90 FE 07 FE 7F')), [{ type: 'mute', midiChannel: 0, note: 7, muted: true }])
})

test('Avantis: Szenenabruf = Bank Select + Program Change auf dem Basiskanal', () => {
  const p = createMidiParser()
  assert.deepEqual(p.feed(hex('B0 00 00 C0 0B')), [{ type: 'scene', midiChannel: 0, bank: 0, program: 11, scene: 12 }])
  assert.deepEqual(p.feed(hex('B0 00 01 C0 00')), [{ type: 'scene', midiChannel: 0, bank: 1, program: 0, scene: 129 }])
  // Ohne erneutes Bank Select bleibt die letzte Bank
  assert.deepEqual(p.feed(hex('C0 73')), [{ type: 'scene', midiChannel: 0, bank: 1, program: 0x73, scene: 244 }])
  // Faderstand per NRPN (0x17) – nur der Vollständigkeit halber
  assert.deepEqual(p.feed(hex('B0 63 02 B0 62 17 B0 06 50')), [{ type: 'fader', midiChannel: 0, note: 2, level: 0x50 }])
})

test('Avantis: SysEx Namensantwort, Farbe, fremde SysEx und Nachricht über Paketgrenze', () => {
  assert.deepEqual(buildNameRequest(4, 0x38), hex('F0 00 00 1A 50 10 01 00 04 01 38 F7'))
  const reply = hex('F0 00 00 1A 50 10 01 00 00 02 0B') // Kanal 12 heißt „Pastor“
  const frame = Buffer.concat([reply, Buffer.from('Pastor  '), hex('F7')])
  assert.deepEqual(parseSysex([...frame]), { type: 'name', midiChannel: 0, note: 11, name: 'Pastor' })
  assert.deepEqual(parseSysex([...hex('F0 00 00 1A 50 10 01 00 04 05 36 03 F7')]), { type: 'colour', midiChannel: 4, note: 0x36, colour: 3 })
  // Fremder Hersteller → ignorieren
  assert.equal(parseSysex([...hex('F0 7E 00 06 01 F7')]), null)
  const p = createMidiParser()
  const part1 = frame.subarray(0, 13)
  const part2 = frame.subarray(13)
  assert.deepEqual(p.feed(part1), [])
  assert.deepEqual(p.feed(part2), [{ type: 'name', midiChannel: 0, note: 11, name: 'Pastor' }])
  // Unbekannte Dinge (System Common, fremde SysEx, Controller) kippen den Parser nicht
  assert.deepEqual(p.feed(hex('F2 00 00 F0 7E 00 06 01 F7 B0 07 40 90 01 7F')), [{ type: 'mute', midiChannel: 0, note: 1, muted: true }])
})

/** Nachgebildetes net: liefert eine Attrappe des Sockets, die der Test selbst bedient */
function fakeNet() {
  const sockets = []
  return {
    sockets,
    connect(opts) {
      const s = new EventEmitter()
      s.opts = opts
      s.written = []
      s.destroyed = false
      s.setNoDelay = () => {}
      s.setKeepAlive = () => {}
      s.write = (buf) => s.written.push(Buffer.from(buf))
      s.destroy = () => {
        if (s.destroyed) return
        s.destroyed = true
        s.emit('close')
      }
      sockets.push(s)
      return s
    },
  }
}

test('Avantis: Verbindung, Namensabfragen, Mutes der überwachten Kanäle, Warnung, Szene', async (t) => {
  const netImpl = fakeNet()
  const updates = []
  const logs = []
  let clock = 1000
  const config = {
    host: '192.168.1.70',
    midiBase: 1,
    channels: [
      { type: 'input', number: 12, name: 'Pastor-Mikro', critical: true },
      { type: 'dca', number: 3, name: 'Band' },
    ],
    scenes: [{ number: 12, name: 'Gottesdienst' }],
  }
  const av = createAvantis({ getConfig: () => config, onUpdate: (m) => updates.push(m), log: (l) => logs.push(l), netImpl, now: () => clock })
  t.after(() => av.stop())
  av.start()
  const s = netImpl.sockets[0]
  assert.deepEqual(s.opts, { host: '192.168.1.70', port: 51325 })
  assert.equal(av.snapshot().state, 'connecting')
  s.emit('connect')
  assert.equal(av.snapshot().state, 'ok')
  // Nur lesende Namensabfragen gingen raus – für jeden überwachten Kanal eine
  assert.deepEqual(s.written, [hex('F0 00 00 1A 50 10 01 00 00 01 0B F7'), hex('F0 00 00 1A 50 10 01 00 04 01 38 F7')])
  let snap = av.snapshot()
  assert.deepEqual(snap.channels.map((c) => [c.name, c.muted, c.label]), [['Pastor-Mikro', null, 'Input 12'], ['Band', null, 'DCA 3']])
  assert.equal(snap.scene, null)
  assert.deepEqual(snap.alarm, [])

  // Pult meldet: Input 12 stumm → Warnung
  s.emit('data', hex('90 0B 7F 90 0B 00'))
  snap = updates[updates.length - 1]
  assert.equal(snap.type, 'avantis')
  assert.equal(snap.channels[0].muted, true)
  assert.deepEqual(snap.alarm, ['Pastor-Mikro'])
  // Ein nicht überwachter Kanal ändert nichts an der Anzeige
  const n = updates.length
  s.emit('data', hex('90 20 7F 90 20 00'))
  assert.equal(updates.length, n)
  // wieder offen
  s.emit('data', hex('90 0B 3F 90 0B 00'))
  assert.deepEqual(updates[updates.length - 1].alarm, [])
  assert.equal(updates[updates.length - 1].channels[0].muted, false)

  // Szene 12 abgerufen, Name aus der Konfiguration
  clock = 2000
  s.emit('data', hex('B0 00 00 C0 0B'))
  assert.deepEqual(updates[updates.length - 1].scene, { number: 12, at: 2000, name: 'Gottesdienst' })
  // Szene auf einem anderen MIDI-Kanal gehört nicht zum Pult-Basiskanal
  s.emit('data', hex('B3 00 00 C3 05'))
  assert.equal(av.snapshot().scene.number, 12)

  // Name vom Pult ergänzt die Anzeige (consoleName), eigener Name bleibt
  s.emit('data', Buffer.concat([hex('F0 00 00 1A 50 10 01 00 04 02 38'), Buffer.from('Band DCA'), hex('F7')]))
  assert.equal(av.snapshot().channels[1].consoleName, 'Band DCA')
  assert.equal(av.snapshot().channels[1].name, 'Band')

  // Verbindung weg: Fehler, Mutes gelten nicht mehr als bekannt, Neuverbinden geplant
  s.emit('error', Object.assign(new Error('x'), { code: 'ECONNRESET' }))
  s.destroy()
  snap = av.snapshot()
  assert.equal(snap.state, 'error')
  assert.equal(snap.channels[0].muted, null)
  assert.ok(logs.some((l) => l.includes('Avantis')))
  await new Promise((r) => setTimeout(r, 1100))
  assert.equal(netImpl.sockets.length, 2, 'nach 1 s wird neu verbunden')
})

test('Avantis: ohne Adresse nichts verbinden, Umkonfigurieren verbindet neu', (t) => {
  const netImpl = fakeNet()
  let config = { channels: [] }
  const av = createAvantis({ getConfig: () => config, onUpdate: () => {}, netImpl })
  t.after(() => av.stop())
  av.start()
  assert.equal(av.snapshot().state, 'unconfigured')
  assert.equal(netImpl.sockets.length, 0)
  config = { host: '192.168.1.70', channels: [{ type: 'input', number: 1 }] }
  av.reconfigure()
  assert.equal(netImpl.sockets.length, 1)
  assert.equal(av.snapshot().state, 'connecting')
  netImpl.sockets[0].emit('connect')
  // Nur Kanalliste geändert: Verbindung bleibt, neue Namensabfrage
  config = { ...config, channels: [{ type: 'dca', number: 1, name: 'Chor' }] }
  av.reconfigure()
  assert.equal(netImpl.sockets.length, 1)
  assert.deepEqual(netImpl.sockets[0].written.at(-1), hex('F0 00 00 1A 50 10 01 00 04 01 36 F7'))
  assert.deepEqual(av.snapshot().channels.map((c) => c.name), ['Chor'])
  // Ausgeschaltet: trennen
  config = { ...config, enabled: false }
  av.reconfigure()
  assert.equal(av.snapshot().state, 'off')
  assert.equal(netImpl.sockets[0].destroyed, true)
})
