'use strict'

// Allen & Heath Avantis (Mischpult) über „MIDI over TCP“ (Port 51325) mitlesen: welche Kanäle sind
// stumm, welche Szene wurde zuletzt abgerufen. JMS Control steuert hier NICHTS – es schickt nur die
// „Get Channel Name“-Anfragen aus dem A&H-Protokoll (SysEx, reine Abfrage) und wertet aus, was das
// Pult von sich aus sendet:
//   Mute        9N CH VEL     Note On, VEL ≥ 0x40 = stumm, < 0x40 = offen, VEL 0 = Nachlauf (ignorieren)
//   Szene       BN 00 BANK · CN PROG   Bank Select + Program Change → Szene = BANK·128 + PROG + 1
//   Name        F0 00 00 1A 50 10 01 00 0N 02 CH <Name> F7   (Antwort auf 0N 01 CH)
//   Farbe       F0 00 00 1A 50 10 01 00 0N 05 CH <Farbe> F7  (Antwort auf 0N 04 CH)
// N = MIDI-Kanal (0-basiert) = Basiskanal (Einstellung „MIDI Channel“ am Pult, Companion: midiBase)
// plus Versatz je Kanalart (siehe CHANNEL_TYPES). Unbekannte Nachrichten werden ignoriert.
// Einen Lesebefehl für den Mute-Zustand gibt es im MIDI-TCP-Protokoll nicht: ein Kanal ist erst
// bekannt, wenn das Pult seit der Verbindung eine Mute-Änderung dafür geschickt hat.

const net = require('net')

const DEFAULT_PORT = 51325
const SYSEX_HEADER = [0xf0, 0x00, 0x00, 0x1a, 0x50, 0x10, 0x01, 0x00]
const RECONNECT_MS = [1000, 2000, 5000, 10000]
const CONNECT_TIMEOUT_MS = 8000
const PROBE_MS = 15000 // Lebenszeichen: Namensabfrage, wie das Companion-Modul
const PROBE_TIMEOUT_MS = 8000
const MAX_SYSEX = 4096
const MAX_CHANNELS = 64
const MAX_SCENES = 500

/** Kanalarten: Versatz zum Basiskanal, erste Notennummer, Anzahl am Pult, Bezeichnung (Avantis MIDI TCP V1.x) */
const CHANNEL_TYPES = {
  input: { offset: 0, first: 0x00, count: 64, label: 'Input' },
  monoGroup: { offset: 1, first: 0x00, count: 40, label: 'Gruppe' },
  stereoGroup: { offset: 1, first: 0x40, count: 20, label: 'St-Gruppe' },
  monoAux: { offset: 2, first: 0x00, count: 40, label: 'Aux' },
  stereoAux: { offset: 2, first: 0x40, count: 20, label: 'St-Aux' },
  monoMatrix: { offset: 3, first: 0x00, count: 40, label: 'Matrix' },
  stereoMatrix: { offset: 3, first: 0x40, count: 20, label: 'St-Matrix' },
  monoFxSend: { offset: 4, first: 0x00, count: 12, label: 'FX-Send' },
  stereoFxSend: { offset: 4, first: 0x10, count: 12, label: 'St-FX-Send' },
  fxReturn: { offset: 4, first: 0x20, count: 12, label: 'FX-Return' },
  main: { offset: 4, first: 0x30, count: 3, label: 'Main' },
  dca: { offset: 4, first: 0x36, count: 16, label: 'DCA' },
  muteGroup: { offset: 4, first: 0x46, count: 8, label: 'Mute-Gruppe' },
}

/** Konfiguration aus config.json mit Standardwerten; ungültige Kanäle fallen weg */
function normalizeAvantis(a) {
  const host = String(a?.host ?? '').trim()
  const port = Number(a?.port)
  const midiBase = Number(a?.midiBase)
  const seen = new Set()
  const channels = (Array.isArray(a?.channels) ? a.channels : [])
    .map((c) => {
      const type = CHANNEL_TYPES[c?.type] ? c.type : null
      const number = Number(c?.number)
      if (!type || !Number.isInteger(number) || number < 1 || number > CHANNEL_TYPES[type].count) return null
      const key = `${type}:${number}`
      if (seen.has(key)) return null
      seen.add(key)
      return { type, number, name: String(c?.name ?? '').trim().slice(0, 40), critical: c?.critical === true }
    })
    .filter(Boolean)
    .slice(0, MAX_CHANNELS)
  const sceneSeen = new Set()
  const scenes = (Array.isArray(a?.scenes) ? a.scenes : [])
    .map((s) => {
      const number = Number(s?.number)
      if (!Number.isInteger(number) || number < 1 || number > MAX_SCENES || sceneSeen.has(number)) return null
      sceneSeen.add(number)
      return { number, name: String(s?.name ?? '').trim().slice(0, 60) }
    })
    .filter(Boolean)
    .slice(0, MAX_SCENES)
  return {
    enabled: a?.enabled !== false,
    host: /^[a-z0-9.-]{1,253}$/i.test(host) ? host : '',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    midiBase: Number.isInteger(midiBase) && midiBase >= 1 && midiBase <= 12 ? midiBase : 1,
    channels,
    scenes,
  }
}

/** MIDI-Kanal (0-basiert) und Notennummer eines Kanals, z. B. DCA 3 bei Basiskanal 1 → { midiChannel: 4, note: 0x38 } */
function channelAddress(type, number, midiBase = 1) {
  const t = CHANNEL_TYPES[type]
  if (!t) return null
  return { midiChannel: midiBase - 1 + t.offset, note: t.first + number - 1 }
}

const muteKey = (midiChannel, note) => `${midiChannel}:${note}`

/** Anzeigename, wenn keiner eingetragen ist: „DCA 3“, „Input 12“ */
const channelLabel = (type, number) => `${CHANNEL_TYPES[type]?.label ?? type} ${number}`

/** SysEx „Get Channel Name“ – eine reine Abfrage, das Pult ändert dadurch nichts */
function buildNameRequest(midiChannel, note) {
  return Buffer.from([...SYSEX_HEADER, midiChannel & 0x0f, 0x01, note & 0x7f, 0xf7])
}

/** Ein vollständiger SysEx-Rahmen (F0 … F7) → Ereignis oder null, wenn er nicht von A&H ist */
function parseSysex(frame) {
  if (frame.length < 12 || frame[frame.length - 1] !== 0xf7) return null
  if (SYSEX_HEADER.some((b, i) => frame[i] !== b)) return null
  const midiChannel = frame[8]
  const command = frame[9]
  const note = frame[10]
  if (midiChannel > 15 || note > 127) return null
  if (command === 0x02 || command === 0x03) {
    // 02 = Antwort auf die Namensabfrage, 03 = Name wurde gesetzt (kommt auch, wenn jemand am Pult umbenennt)
    const name = Buffer.from(frame.slice(11, frame.length - 1))
      .toString('latin1')
      .replace(/\0+$/, '')
      .trim()
    return { type: 'name', midiChannel, note, name }
  }
  if (command === 0x05 || command === 0x06) return { type: 'colour', midiChannel, note, colour: frame[11] ?? 0 }
  return null
}

/**
 * MIDI-Bytestrom in Ereignisse zerlegen. Verträgt Running Status, zerstückelte TCP-Pakete und
 * SysEx über Paketgrenzen. Ereignisse: mute, scene, name, colour, fader (NRPN 0x17).
 */
function createMidiParser() {
  let status = null
  let data = []
  let sysex = null
  let skip = 0
  const bank = new Map() // MIDI-Kanal → zuletzt gesendete Bank (CC 0)
  const nrpn = new Map() // MIDI-Kanal → { msb, lsb }

  function message(st, d, out) {
    const kind = st & 0xf0
    const midiChannel = st & 0x0f
    if (kind === 0x90) {
      if (d[1] === 0) return // Nachlauf (Note Off als Note On mit 0)
      out.push({ type: 'mute', midiChannel, note: d[0], muted: d[1] >= 0x40 })
    } else if (kind === 0xb0) {
      if (d[0] === 0x00) bank.set(midiChannel, d[1])
      else if (d[0] === 0x63) nrpn.set(midiChannel, { ...nrpn.get(midiChannel), msb: d[1] })
      else if (d[0] === 0x62) nrpn.set(midiChannel, { ...nrpn.get(midiChannel), lsb: d[1] })
      else if (d[0] === 0x06 && nrpn.get(midiChannel)?.lsb === 0x17)
        out.push({ type: 'fader', midiChannel, note: nrpn.get(midiChannel).msb ?? 0, level: d[1] })
    } else if (kind === 0xc0) {
      const b = bank.get(midiChannel) ?? 0
      out.push({ type: 'scene', midiChannel, bank: b, program: d[0], scene: b * 128 + d[0] + 1 })
    }
  }

  return {
    feed(bytes) {
      const out = []
      for (const b of bytes) {
        if (b >= 0xf8) continue // Echtzeit (Clock, Active Sensing) darf überall stehen
        if (sysex) {
          if (b === 0xf7) {
            sysex.push(b)
            const ev = parseSysex(sysex)
            if (ev) out.push(ev)
            sysex = null
          } else if (b >= 0x80) {
            sysex = null // abgebrochener SysEx – das neue Statusbyte normal verarbeiten
          } else {
            if (sysex.length < MAX_SYSEX) sysex.push(b)
            continue
          }
          if (b === 0xf7) continue
        }
        if (b === 0xf0) {
          sysex = [b]
          continue
        }
        if (b >= 0x80) {
          data = []
          skip = 0
          if (b >= 0xf0) {
            status = null // System Common hat keinen Running Status
            skip = b === 0xf2 ? 2 : b === 0xf1 || b === 0xf3 ? 1 : 0
          } else status = b
          continue
        }
        if (skip > 0) {
          skip--
          continue
        }
        if (status === null) continue
        data.push(b)
        const needed = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2
        if (data.length === needed) {
          message(status, data, out)
          data = []
        }
      }
      return out
    },
  }
}

function createAvantis({ getConfig, onUpdate, log = () => {}, netImpl = net, now = Date.now }) {
  let cfg = normalizeAvantis(getConfig())
  let state = cfg.host ? 'connecting' : 'unconfigured'
  let error = ''
  let socket = null
  let parser = null
  let running = false
  let attempt = 0
  let reconnectTimer = null
  let connectTimer = null
  let probeTimer = null
  let probeDeadline = null
  let namesSeen = false // hat das Pult je eine Namensabfrage beantwortet?
  let connectedAt = null
  const mutes = new Map() // "midiChannel:note" → { muted, at }
  const names = new Map() // "midiChannel:note" → Name vom Pult
  let scene = null // { number, at }

  const connectionKey = (c) => JSON.stringify([c.enabled, c.host, c.port, c.midiBase])

  function configuredChannels() {
    return cfg.channels.map((c) => {
      const addr = channelAddress(c.type, c.number, cfg.midiBase)
      return { ...c, key: muteKey(addr.midiChannel, addr.note), ...addr }
    })
  }

  function snapshot() {
    const channels = configuredChannels().map((c) => {
      const m = mutes.get(c.key)
      return {
        key: `${c.type}:${c.number}`,
        type: c.type,
        number: c.number,
        label: channelLabel(c.type, c.number),
        name: c.name || names.get(c.key) || channelLabel(c.type, c.number),
        consoleName: names.get(c.key) || '',
        critical: c.critical,
        muted: m ? m.muted : null,
        at: m?.at ?? null,
      }
    })
    const sceneName = scene ? cfg.scenes.find((s) => s.number === scene.number)?.name || '' : ''
    return {
      type: 'avantis',
      state,
      error,
      host: cfg.host,
      connectedAt,
      channels,
      // Kritische Kanäle, die gerade stumm sind – dafür die große rote Warnung
      alarm: channels.filter((c) => c.critical && c.muted === true).map((c) => c.name),
      scene: scene ? { ...scene, name: sceneName } : null,
    }
  }

  function write(buf) {
    if (socket && !socket.destroyed && state === 'ok') socket.write(buf)
  }

  function requestNames() {
    for (const c of configuredChannels()) write(buildNameRequest(c.midiChannel, c.note))
  }

  function handle(events) {
    let changed = false
    const watched = new Set(configuredChannels().map((c) => c.key))
    for (const ev of events) {
      if (ev.type === 'mute') {
        const key = muteKey(ev.midiChannel, ev.note)
        const before = mutes.get(key)
        if (mutes.size < 2048 || before) mutes.set(key, { muted: ev.muted, at: now() })
        if (watched.has(key) && before?.muted !== ev.muted) changed = true
      } else if (ev.type === 'scene') {
        if (ev.midiChannel !== cfg.midiBase - 1) continue
        scene = { number: ev.scene, at: now() }
        changed = true
        log(`Avantis: Szene ${ev.scene} abgerufen`)
      } else if (ev.type === 'name') {
        namesSeen = true
        probeDeadline = null
        const key = muteKey(ev.midiChannel, ev.note)
        if (names.get(key) !== ev.name) {
          names.set(key, ev.name)
          if (watched.has(key)) changed = true
        }
      }
    }
    if (changed) onUpdate(snapshot())
  }

  function setError(message) {
    if (state !== 'error' || error !== message) {
      log(`Avantis: ${message}`)
      state = 'error'
      error = message
      onUpdate(snapshot())
    }
  }

  function probe() {
    clearTimeout(probeTimer)
    if (!running || state !== 'ok') return
    if (probeDeadline && now() > probeDeadline && namesSeen) {
      // Das Pult hat früher geantwortet, jetzt nicht mehr: Verbindung ist wahrscheinlich tot
      log('Avantis: keine Antwort mehr – verbinde neu')
      socket?.destroy()
      return
    }
    const first = configuredChannels()[0] || { midiChannel: cfg.midiBase - 1, note: 0 }
    write(buildNameRequest(first.midiChannel, first.note))
    probeDeadline = probeDeadline || now() + PROBE_TIMEOUT_MS
    probeTimer = setTimeout(probe, PROBE_MS)
  }

  function disconnect() {
    clearTimeout(reconnectTimer)
    clearTimeout(connectTimer)
    clearTimeout(probeTimer)
    reconnectTimer = connectTimer = probeTimer = null
    if (socket) {
      const s = socket
      socket = null
      s.removeAllListeners?.()
      s.on?.('error', () => {})
      s.destroy()
    }
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer)
    if (!running || !cfg.enabled || !cfg.host) return
    const wait = RECONNECT_MS[Math.min(attempt, RECONNECT_MS.length - 1)]
    attempt++
    reconnectTimer = setTimeout(connect, wait)
  }

  function connect() {
    if (!running) return
    if (!cfg.host) {
      state = 'unconfigured'
      return
    }
    if (!cfg.enabled) {
      state = 'off'
      return
    }
    disconnect()
    parser = createMidiParser()
    probeDeadline = null
    const s = netImpl.connect({ host: cfg.host, port: cfg.port })
    socket = s
    s.setNoDelay?.(true)
    s.setKeepAlive?.(true, 5000)
    connectTimer = setTimeout(() => {
      if (socket === s && state !== 'ok') {
        setError('Pult antwortet nicht')
        s.destroy()
      }
    }, CONNECT_TIMEOUT_MS)
    s.on('connect', () => {
      clearTimeout(connectTimer)
      attempt = 0
      state = 'ok'
      error = ''
      connectedAt = now()
      log(`Avantis: verbunden mit ${cfg.host}:${cfg.port}`)
      onUpdate(snapshot())
      requestNames()
      probeTimer = setTimeout(probe, PROBE_MS)
    })
    s.on('data', (chunk) => {
      if (socket !== s) return
      handle(parser.feed(chunk))
    })
    s.on('error', (err) => {
      if (socket !== s) return
      const message =
        err.code === 'ECONNREFUSED'
          ? 'Pult lehnt die Verbindung ab (MIDI over TCP am Pult eingeschaltet?)'
          : err.code === 'EHOSTUNREACH' || err.code === 'ETIMEDOUT' || err.code === 'ENETUNREACH'
            ? 'Pult nicht erreichbar'
            : err.message
      setError(message)
    })
    s.on('close', () => {
      if (socket !== s) return
      socket = null
      clearTimeout(connectTimer)
      clearTimeout(probeTimer)
      if (state === 'ok') setError('Verbindung getrennt')
      // Mutes gelten nicht mehr als bekannt – nach dem Neuverbinden meldet das Pult nur Änderungen
      mutes.clear()
      scheduleReconnect()
    })
  }

  return {
    start() {
      if (running) return
      running = true
      connect()
    },
    stop() {
      running = false
      disconnect()
    },
    snapshot,
    /** Konfiguration geändert: bei anderer Adresse neu verbinden, sonst nur Namen nachfragen */
    reconfigure() {
      const next = normalizeAvantis(getConfig())
      const reconnect = connectionKey(next) !== connectionKey(cfg)
      cfg = next
      if (reconnect) {
        disconnect()
        attempt = 0
        mutes.clear()
        names.clear()
        scene = null
        error = ''
        state = !cfg.host ? 'unconfigured' : !cfg.enabled ? 'off' : 'connecting'
        if (running) connect()
      } else requestNames()
      onUpdate(snapshot())
    },
    /** Für Tests: Ereignisse wie vom Pult einspeisen */
    _handle: handle,
  }
}

module.exports = {
  createAvantis,
  normalizeAvantis,
  createMidiParser,
  parseSysex,
  buildNameRequest,
  channelAddress,
  channelLabel,
  CHANNEL_TYPES,
  DEFAULT_PORT,
}
