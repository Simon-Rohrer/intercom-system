'use strict'

// MA Lighting grandMA3 (Lichtpult): per OSC (UDP) mithören, welcher Cue in den überwachten Sequenzen
// läuft. JMS Control sendet NICHTS an die Konsole (kein /cmd) – es nimmt nur entgegen, was die
// Konsole bei „Send = Yes“ in ihrer OSC-Konfiguration von selbst schickt:
//   /13.13.1.6.<Seq>,sis,Go+,1,Sequence 3 Cue 12 "Lobpreis"     Taste (Arg 2: 1 = gedrückt, 0 = losgelassen)
//   /13.13.1.6.<Seq>,sif,FaderMaster,3,63.5                     Fader in Prozent
//   /13.13.1.6.<Seq>,sii,FaderMaster,0,-1                       Drehgeber (Änderung in Prozent)
// Der Objektpfad vor der Sequenznummer (13.13.1.6) stammt aus dem Handbuch 2.x; das Companion-Modul
// wertet 14.14.1.6 aus – er kann sich mit der Software-Version ändern und ist deshalb einstellbar.
// Mit Prefix (Spalte „Prefix“ in der OSC-Konfiguration) lautet die Adresse /<Prefix>/13.13.1.6.<Seq>.
// Zusätzlich versteht der Server /jms/cue,iss,<Seq>,<CueNr>,<CueName> (z. B. von einem Lua-Plugin
// per SendOSC), damit der Cue auch ohne Tastendruck bekannt wird.

const dgram = require('dgram')

const DEFAULT_PORT = 8011
const DEFAULT_SEQ_PATHS = ['13.13.1.6', '14.14.1.6']
const MAX_SEQUENCES = 32
const MAX_SEEN = 64

/** Konfiguration aus config.json mit Standardwerten */
function normalizeGrandma3(g) {
  const host = String(g?.host ?? '').trim()
  const port = Number(g?.port)
  const prefix = String(g?.prefix ?? '').trim().replace(/^\/+|\/+$/g, '')
  const seqPath = String(g?.seqPath ?? '').trim()
  const seen = new Set()
  const sequences = (Array.isArray(g?.sequences) ? g.sequences : [])
    .map((s) => {
      const number = Number(s?.number)
      if (!Number.isInteger(number) || number < 1 || number > 99999 || seen.has(number)) return null
      seen.add(number)
      return { number, name: String(s?.name ?? '').trim().slice(0, 40) }
    })
    .filter(Boolean)
    .slice(0, MAX_SEQUENCES)
  return {
    enabled: g?.enabled !== false,
    // Adresse der Konsole: Pakete anderer Absender werden ignoriert (leer = alle annehmen)
    host: /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ? host : '',
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT,
    prefix: /^[\w.-]{0,40}$/.test(prefix) ? prefix : '',
    seqPath: /^\d+(\.\d+)*$/.test(seqPath) ? seqPath : '',
    sequences,
  }
}

// --- OSC-Parser (nur Lesen; Bundles werden aufgelöst) ------------------------------------------

function readPadded(buf, offset) {
  let end = offset
  while (end < buf.length && buf[end] !== 0) end++
  const text = buf.toString('utf8', offset, end)
  return { text, next: (end + 4) & ~3 }
}

/** Ein OSC-Paket (Nachricht oder Bundle) → Liste von { address, args: [{ type, value }] } */
function parseOsc(buf, out = []) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return out
  if (buf[0] === 0x23 && buf.toString('latin1', 0, 8) === '#bundle\0') {
    let pos = 16 // „#bundle“ + Zeitmarke
    while (pos + 4 <= buf.length) {
      const size = buf.readInt32BE(pos)
      pos += 4
      if (size < 0 || pos + size > buf.length) break
      parseOsc(buf.subarray(pos, pos + size), out)
      pos += size
    }
    return out
  }
  if (buf[0] !== 0x2f) return out // Adresse beginnt mit „/“
  const address = readPadded(buf, 0)
  const args = []
  let pos = address.next
  if (pos < buf.length && buf[pos] === 0x2c) {
    const tags = readPadded(buf, pos)
    pos = tags.next
    for (const tag of tags.text.slice(1)) {
      try {
        if (tag === 'i') {
          args.push({ type: 'i', value: buf.readInt32BE(pos) })
          pos += 4
        } else if (tag === 'f') {
          args.push({ type: 'f', value: buf.readFloatBE(pos) })
          pos += 4
        } else if (tag === 's' || tag === 'S') {
          const s = readPadded(buf, pos)
          args.push({ type: 's', value: s.text })
          pos = s.next
        } else if (tag === 'b') {
          const size = buf.readInt32BE(pos)
          args.push({ type: 'b', value: buf.subarray(pos + 4, pos + 4 + size) })
          pos = (pos + 4 + size + 3) & ~3
        } else if (tag === 'h') {
          args.push({ type: 'h', value: Number(buf.readBigInt64BE(pos)) })
          pos += 8
        } else if (tag === 't') {
          args.push({ type: 't', value: Number(buf.readBigUInt64BE(pos)) })
          pos += 8
        } else if (tag === 'd') {
          args.push({ type: 'd', value: buf.readDoubleBE(pos) })
          pos += 8
        } else if (tag === 'c' || tag === 'r' || tag === 'm') {
          args.push({ type: tag, value: buf.readUInt32BE(pos) })
          pos += 4
        } else if (tag === 'T') args.push({ type: 'T', value: true })
        else if (tag === 'F') args.push({ type: 'F', value: false })
        else if (tag === 'N') args.push({ type: 'N', value: null })
        else if (tag === 'I') args.push({ type: 'I', value: Infinity })
        else break // unbekannter Typ: Rest nicht deutbar
      } catch {
        break // Paket zu kurz
      }
    }
  }
  out.push({ address: address.text, args })
  return out
}

/**
 * Text aus dem dritten Argument der Tasten-Nachricht, z. B. „Sequence 3 Cue 12 "Lobpreis"“ oder
 * „Strobe 1 Cue 1“ → { sequenceName, number, name }. Ohne „Cue“ bleibt alles im Namen.
 */
function parseCueText(text) {
  const t = String(text ?? '').trim()
  const m = /^(.*?)\s*\bCue\s+([\d.]+)\s*(.*)$/i.exec(t)
  if (!m) return { sequenceName: '', number: null, name: t }
  return {
    sequenceName: m[1].replace(/^Sequence\s+\d+\s*/i, '').trim(),
    number: m[2],
    name: m[3].replace(/^["“„']+|["”“']+$/g, '').trim(),
  }
}

/**
 * Eine OSC-Nachricht der Konsole deuten. Liefert null, wenn sie nicht zu einer Sequenz gehört.
 * Ergebnis: { seq, kind: 'key' | 'fader' | 'knob' | 'cue', func, state, cue, fader }
 */
function parseSequenceMessage(msg, { prefix = '', seqPaths = DEFAULT_SEQ_PATHS } = {}) {
  if (!msg?.address) return null
  const parts = msg.address.replace(/^\/+/, '').split('/')
  if (prefix) {
    if (parts[0] !== prefix) return null
    parts.shift()
  }
  const values = (msg.args || []).map((a) => a.value)
  // Eigene Nachricht eines Lua-Plugins: /jms/cue,iss,<Seq>,<CueNr>,<CueName>
  if (parts.length === 2 && parts[0] === 'jms' && parts[1] === 'cue') {
    const seq = Number(values[0])
    if (!Number.isInteger(seq) || seq < 1) return null
    const number = values[1] == null || values[1] === '' ? null : String(values[1])
    return { seq, kind: 'cue', func: 'cue', state: null, cue: { number, name: String(values[2] ?? '').trim(), sequenceName: '' }, fader: null }
  }
  if (parts.length !== 1) return null
  const dot = parts[0].lastIndexOf('.')
  if (dot < 0) return null
  const path = parts[0].slice(0, dot)
  const seq = Number(parts[0].slice(dot + 1))
  if (!seqPaths.includes(path) || !Number.isInteger(seq) || seq < 1) return null
  const func = typeof values[0] === 'string' ? values[0] : ''
  const result = { seq, kind: 'key', func, state: null, cue: null, fader: null }
  if (typeof values[2] === 'string') {
    result.state = typeof values[1] === 'number' ? values[1] : null
    result.cue = parseCueText(values[2])
  } else if (/fader/i.test(func) && msg.args?.[2]?.type === 'f') {
    result.kind = 'fader'
    result.fader = Math.max(0, Math.min(100, values[2]))
  } else if (/fader|knob|encoder/i.test(func) && msg.args?.[2]?.type === 'i') {
    result.kind = 'knob'
  } else if (typeof values[1] === 'number') {
    result.state = values[1]
  }
  return result
}

function createGrandma3({ getConfig, onUpdate, log = () => {}, dgramImpl = dgram, now = Date.now }) {
  let cfg = normalizeGrandma3(getConfig())
  let state = 'off'
  let error = ''
  let socket = null
  let running = false
  let lastAt = null
  let lastFrom = ''
  let foreignWarned = false
  const sequences = new Map() // Nummer → { cue, sequenceName, fader, func, state, at }
  const seen = [] // Sequenznummern, von denen je etwas kam (für die Einstellungen)

  function seqPaths() {
    return cfg.seqPath ? [cfg.seqPath, ...DEFAULT_SEQ_PATHS] : DEFAULT_SEQ_PATHS
  }

  function snapshot() {
    return {
      type: 'grandma3',
      state,
      error,
      host: cfg.host,
      port: cfg.port,
      prefix: cfg.prefix,
      lastAt,
      lastFrom,
      sequences: cfg.sequences.map((s) => {
        const live = sequences.get(s.number)
        return {
          number: s.number,
          name: s.name || live?.sequenceName || `Sequenz ${s.number}`,
          consoleName: live?.sequenceName || '',
          cue: live?.cue ?? null,
          fader: live?.fader ?? null,
          func: live?.func ?? '',
          at: live?.at ?? null,
        }
      }),
      seen: seen.slice(),
    }
  }

  function remember(seq) {
    if (seen.includes(seq)) return
    seen.push(seq)
    if (seen.length > MAX_SEEN) seen.shift()
  }

  /** Geparste Nachrichten verarbeiten (auch von den Tests genutzt) */
  function handle(messages, from = '') {
    let changed = false
    for (const msg of messages) {
      const ev = parseSequenceMessage(msg, { prefix: cfg.prefix, seqPaths: seqPaths() })
      if (!ev) continue
      lastAt = now()
      lastFrom = from
      remember(ev.seq)
      const cur = sequences.get(ev.seq) || { cue: null, sequenceName: '', fader: null, func: '', state: null, at: null }
      const next = { ...cur, at: now() }
      if (ev.cue) {
        if (ev.cue.sequenceName) next.sequenceName = ev.cue.sequenceName
        // Ohne Cue-Nummer (Taste „Off“ o. ä.) bleibt der letzte Cue stehen
        if (ev.cue.number != null || ev.kind === 'cue') next.cue = { number: ev.cue.number, name: ev.cue.name }
      }
      if (ev.kind === 'fader') next.fader = ev.fader
      if (ev.kind === 'key') {
        next.func = ev.func
        next.state = ev.state
      }
      sequences.set(ev.seq, next)
      if (state !== 'ok') {
        state = 'ok'
        error = ''
        changed = true
        log(`grandMA3: OSC-Daten von ${from || 'der Konsole'} kommen an`)
      }
      if (cfg.sequences.some((s) => s.number === ev.seq)) changed = true
    }
    if (changed) onUpdate(snapshot())
  }

  function close() {
    if (!socket) return
    const s = socket
    socket = null
    try {
      s.close()
    } catch {
      // war schon zu
    }
  }

  function open() {
    close()
    if (!running || !cfg.enabled) {
      state = 'off'
      return
    }
    const s = dgramImpl.createSocket('udp4')
    socket = s
    s.on('error', (err) => {
      if (socket !== s) return
      state = 'error'
      error = err.code === 'EADDRINUSE' ? `Port ${cfg.port} ist schon belegt` : err.message
      log(`grandMA3: ${error}`)
      close()
      onUpdate(snapshot())
    })
    s.on('listening', () => {
      if (socket !== s) return
      state = 'listening'
      error = ''
      log(`grandMA3: warte auf OSC an UDP-Port ${cfg.port}`)
      onUpdate(snapshot())
    })
    s.on('message', (buf, rinfo) => {
      if (socket !== s) return
      if (cfg.host && rinfo?.address && rinfo.address !== cfg.host) {
        if (!foreignWarned) {
          foreignWarned = true
          log(`grandMA3: OSC von ${rinfo.address} ignoriert (eingetragen ist ${cfg.host})`)
        }
        return
      }
      handle(parseOsc(buf), rinfo?.address || '')
    })
    try {
      s.bind(cfg.port)
    } catch (err) {
      state = 'error'
      error = err.message
    }
  }

  return {
    start() {
      if (running) return
      running = true
      open()
    },
    stop() {
      running = false
      close()
    },
    snapshot,
    /** Konfiguration geändert: anderer Port → neu lauschen, sonst nur die Anzeige nachziehen */
    reconfigure() {
      const next = normalizeGrandma3(getConfig())
      const rebind = next.port !== cfg.port || next.enabled !== cfg.enabled
      cfg = next
      foreignWarned = false
      if (rebind && running) open()
      onUpdate(snapshot())
    },
    _handle: handle,
  }
}

module.exports = {
  createGrandma3,
  normalizeGrandma3,
  parseOsc,
  parseCueText,
  parseSequenceMessage,
  DEFAULT_PORT,
  DEFAULT_SEQ_PATHS,
}
