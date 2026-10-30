// Kachel „Stream-Gesundheit“: in einer Zeile Encoder • YouTube • Zuschauer • Upload. Die Daten
// kommen aus den Nachrichten „youtube“ (youtube.js, darin auch die Monarch und der ATEM-Stream)
// und „uplink“ (FRITZ!Box). Warnfarben nach einstellbaren Schwellen: Upload-Reserve unter … %
// gelb/rot, Encoder sendet nicht, während YouTube live ist = rot.

const STALE_MS = 10 * 1000

const num = (v, d, min, max) => {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

/** Einstellungen der Kachel (tile.streamhealth) mit Standardwerten */
export function streamHealthOptions(o = {}) {
  const warn = num(o.warnReserve, 20, 0, 100)
  return {
    title: String(o.title ?? 'Stream').slice(0, 40),
    header: o.header !== false,
    warnReserve: warn, // Upload-Reserve unter … % = gelb
    badReserve: Math.min(warn, num(o.badReserve, 10, 0, 100)), // … = rot
    note: o.note !== false, // erste Störungsmeldung der YouTube-Überwachung
    size: num(o.size, 1, 0.5, 2.5),
  }
}

const LEVEL = { muted: 0, ok: 1, warn: 2, bad: 3 }
const mbit = (bits) => `${(bits / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mbit/s`
const count = (n) => Number(n || 0).toLocaleString('de-DE')
const clock = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Berlin' })
const HEALTH_TEXT = { good: 'Empfang gut', ok: 'Empfang ok', bad: 'Empfang schlecht', noData: 'keine Empfangsdaten' }

/** Encoder: die Monarch, sonst der ATEM, wenn er selbst streamt */
function encoderSegment(yt, live) {
  const seg = { key: 'encoder', label: 'Encoder', value: '–', sub: '', level: 'muted' }
  const e = yt?.encoder
  const a = yt?.atem
  if (e && e.state !== 'unconfigured') {
    seg.label = 'Monarch'
    if (e.state === 'streaming') {
      seg.value = 'sendet'
      seg.sub = e.input ? (e.input.signal ? e.input.label : 'kein Bild am Eingang') : ''
      seg.level = e.input && !e.input.signal ? 'bad' : 'ok'
    } else if (e.state === 'ready' || e.state === 'disabled') {
      seg.value = e.state === 'ready' ? 'bereit' : 'aus'
      seg.sub = 'sendet nicht'
      seg.level = live ? 'bad' : 'muted'
    } else {
      seg.value = e.state === 'connecting' ? 'verbindet …' : 'offline'
      seg.sub = e.error || 'nicht erreichbar'
      seg.level = live ? 'bad' : 'warn'
    }
    return seg
  }
  if (a && a.state !== 'off' && a.state !== 'nostream') {
    seg.label = 'ATEM'
    if (a.state === 'streaming') {
      seg.value = 'sendet'
      seg.sub = [a.bitrate ? mbit(a.bitrate) : '', a.cache != null ? `Puffer ${Math.round(a.cache)} %` : ''].filter(Boolean).join(' · ')
      seg.level = a.error ? 'bad' : 'ok'
    } else if (a.state === 'idle') {
      seg.value = 'aus'
      seg.sub = 'sendet nicht'
      seg.level = live ? 'bad' : 'muted'
    } else {
      seg.value = a.state === 'connecting' ? 'verbindet …' : 'beendet'
      seg.level = 'warn'
    }
    return seg
  }
  seg.sub = !yt ? '' : a?.state === 'off' ? 'ATEM nicht verbunden' : 'nicht eingerichtet'
  return seg
}

function youtubeSegment(yt, live, now) {
  const seg = { key: 'youtube', label: 'YouTube', value: '–', sub: '', level: 'muted' }
  if (!yt) {
    seg.value = '…'
    seg.sub = 'Verbinde'
    return seg
  }
  if (yt.state === 'unconfigured') {
    seg.sub = 'nicht eingerichtet'
    return seg
  }
  const v = yt.video
  if (live) {
    seg.value = 'Live'
    seg.level = 'ok'
    const h = yt.health
    if (h) {
      if (h.stream && h.stream !== 'active') {
        seg.sub = 'empfängt nichts'
        seg.level = 'bad'
      } else {
        seg.sub = HEALTH_TEXT[h.status] || h.status
        seg.level = h.status === 'bad' ? 'bad' : h.status === 'ok' ? 'warn' : 'ok'
      }
    } else if (v.actualStart) {
      const min = Math.max(0, Math.floor((now - v.actualStart) / 60000))
      seg.sub = `seit ${clock(v.actualStart)} · ${min} Min.`
    }
    return seg
  }
  if (v?.status === 'upcoming') {
    seg.value = 'Geplant'
    seg.sub = v.scheduledStart ? clock(v.scheduledStart) : ''
  } else if (v?.status === 'ended') {
    seg.value = 'Beendet'
    seg.sub = v.actualEnd ? clock(v.actualEnd) : ''
  } else if (yt.state === 'error') {
    seg.value = 'Fehler'
    seg.sub = yt.error || ''
    seg.level = 'warn'
  } else {
    seg.value = 'Offline'
    seg.sub = yt.state === 'connecting' ? 'Verbinde …' : 'kein Stream'
  }
  return seg
}

function viewersSegment(yt, live) {
  const seg = { key: 'viewers', label: 'Zuschauer', value: '–', sub: '', level: 'muted' }
  if (!live) return seg
  const v = yt.video
  seg.value = v.viewers != null ? count(v.viewers) : '–'
  seg.sub = v.peak ? `Spitze ${count(v.peak)}` : ''
  seg.level = 'ok'
  return seg
}

function uploadSegment(uplink, live, o, now) {
  const seg = { key: 'upload', label: 'Upload', value: '–', sub: '', level: 'muted' }
  if (!uplink) {
    seg.sub = 'Verbinde …'
    return seg
  }
  if (uplink.state === 'off') {
    seg.sub = 'Abfrage aus'
    return seg
  }
  if (uplink.state !== 'ok') {
    seg.value = 'offline'
    seg.sub = uplink.error || 'FRITZ!Box antwortet nicht'
    seg.level = 'warn'
    return seg
  }
  const list = uplink.history || []
  const last = list[list.length - 1]
  if (!last || now - last.t > STALE_MS) {
    seg.sub = 'keine Daten'
    seg.level = 'warn'
    return seg
  }
  seg.value = mbit(last.up)
  seg.level = 'ok'
  if (uplink.maxUp > 0) {
    const reserve = Math.max(0, Math.min(100, (1 - last.up / uplink.maxUp) * 100))
    seg.sub = `${Math.round(reserve)} % frei von ${mbit(uplink.maxUp)}`
    if (reserve < o.badReserve) seg.level = 'bad'
    else if (reserve < o.warnReserve) seg.level = 'warn'
  }
  // Während des Streams praktisch kein Upload: kommt der Stream überhaupt an?
  if (live && last.up < 1e6) seg.level = 'bad'
  return seg
}

/** Alles, was die Kachel zeigt – ohne DOM, damit es sich testen lässt */
export function streamHealthState({ youtube, uplink }, options, now = Date.now()) {
  const o = streamHealthOptions(options)
  const live = youtube?.video?.status === 'live'
  const segments = [encoderSegment(youtube, live), youtubeSegment(youtube, live, now), viewersSegment(youtube, live), uploadSegment(uplink, live, o, now)]
  let level = 'muted'
  for (const s of segments) if (LEVEL[s.level] > LEVEL[level]) level = s.level
  const problem = (youtube?.problems || []).find((p) => p.level === 'error') || (youtube?.problems || [])[0]
  return { live, level, segments, note: o.note && problem ? problem.text : '' }
}

const LEVEL_TEXT = { muted: '–', ok: 'OK', warn: 'Achtung', bad: 'Störung' }

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

export function createStreamHealthView(options) {
  const o = streamHealthOptions(options)
  const root = el('div', 'shealth')
  root.style.setProperty('--sh-scale', String(o.size))
  const header = el('header', 'sh-header')
  const title = el('strong', 'sh-title', o.title)
  const pill = el('span', 'sh-pill', '–')
  header.append(title, pill)
  const row = el('div', 'sh-row')
  const segs = new Map()
  for (const key of ['encoder', 'youtube', 'viewers', 'upload']) {
    const seg = el('div', `sh-seg sh-${key}`)
    const label = el('span', 'sh-label')
    const value = el('span', 'sh-value', '–')
    const sub = el('span', 'sh-sub')
    seg.append(label, value, sub)
    row.append(seg)
    segs.set(key, { seg, label, value, sub })
  }
  const note = el('div', 'sh-note')
  if (o.header) root.append(header)
  root.append(row, note)

  let data = { youtube: null, uplink: null }

  function draw() {
    const s = streamHealthState(data, o)
    for (const k of ['muted', 'ok', 'warn', 'bad']) root.classList.toggle(k, s.level === k)
    root.classList.toggle('live', s.live)
    pill.textContent = s.live ? `Live · ${LEVEL_TEXT[s.level]}` : LEVEL_TEXT[s.level]
    for (const seg of s.segments) {
      const n = segs.get(seg.key)
      n.label.textContent = seg.label
      n.value.textContent = seg.value
      n.sub.textContent = seg.sub
      for (const k of ['muted', 'ok', 'warn', 'bad']) n.seg.classList.toggle(k, seg.level === k)
    }
    note.textContent = s.note
  }

  const view = {
    el: root,
    /** Teilstände übernehmen: { youtube } und/oder { uplink } */
    update(state) {
      data = { ...data, ...state }
      draw()
    },
    tick: draw,
  }
  views.add(view)
  return view
}

const views = new Set()
// Laufzeit weiterzählen und veraltete Upload-Werte erkennen, auch wenn nichts mehr kommt
setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 2000)
