// Kachel „Upload / Stream“: Upload der Internetleitung von der FRITZ!Box (über den Server),
// groß als Zahl, mit Auslastung und Kurve. Während eines YouTube-Streams ist der Upload
// fast ganz der Stream – bricht er ein, wird die Kachel rot.

const HISTORY_MS = 15 * 60 * 1000
const STALE_MS = 10 * 1000
const SVG = 'http://www.w3.org/2000/svg'

/** Einstellungen der Kachel (tile.uplink) mit Standardwerten */
export function uplinkOptions(o = {}) {
  const num = (v, d, min, max) => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  return {
    title: String(o.title ?? 'Upload').slice(0, 40),
    minutes: num(o.minutes, 5, 1, 15), // Zeitraum der Kurve
    chart: o.chart !== false,
    down: o.down === true, // Download zusätzlich zeigen
    alarm: num(o.alarm, 0, 0, 1000), // Warnung unter … Mbit/s (0 = aus)
    size: num(o.size, 1, 0.5, 2.5),
  }
}

/** Server-Nachricht in den gemeinsamen Stand übernehmen (Verlauf nur im Snapshot, sonst einzelne Werte) */
export function mergeUplink(state, msg) {
  const { sample, history, ...info } = msg
  let list = Array.isArray(history) ? history.slice() : (state?.history || []).slice()
  if (sample) list.push(sample)
  const cut = Date.now() - HISTORY_MS
  while (list.length && list[0].t < cut) list.shift()
  return { ...state, ...info, history: list }
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const mbit = (bits) => (bits / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

export function createUplinkView(options) {
  const o = uplinkOptions(options)
  const root = el('div', 'uplink')
  root.style.setProperty('--ul-scale', String(o.size))
  const header = el('header', 'ul-header')
  const title = el('strong', 'ul-title', o.title)
  const pill = el('span', 'ul-pill')
  header.append(title, pill)
  const main = el('div', 'ul-main')
  const value = el('span', 'ul-value', '–')
  const unit = el('span', 'ul-unit', 'Mbit/s')
  main.append(value, unit)
  const sub = el('div', 'ul-sub')
  const status = el('div', 'ul-status')
  root.append(header, main, sub, status)

  let chart = null
  let area = null
  let line = null
  let alarmLine = null
  let downLine = null
  if (o.chart) {
    chart = document.createElementNS(SVG, 'svg')
    chart.setAttribute('class', 'ul-chart')
    chart.setAttribute('viewBox', '0 0 1000 300')
    chart.setAttribute('preserveAspectRatio', 'none')
    area = document.createElementNS(SVG, 'path')
    area.setAttribute('class', 'ul-area')
    line = document.createElementNS(SVG, 'path')
    line.setAttribute('class', 'ul-line')
    downLine = document.createElementNS(SVG, 'path')
    downLine.setAttribute('class', 'ul-down')
    alarmLine = document.createElementNS(SVG, 'line')
    alarmLine.setAttribute('class', 'ul-alarm')
    chart.append(area, downLine, line, alarmLine)
    root.append(chart)
  }

  let data = null

  function draw() {
    const d = data
    const ok = d?.state === 'ok'
    pill.textContent = ok ? 'FRITZ!Box' : d?.state === 'off' ? 'Aus' : 'Offline'
    pill.classList.toggle('bad', !ok)
    pill.title = d?.error || ''
    const list = d?.history || []
    const last = list[list.length - 1]
    const stale = !last || Date.now() - last.t > STALE_MS
    if (!ok || stale) {
      value.textContent = '–'
      sub.textContent = d?.state === 'off' ? 'Abfrage ausgeschaltet' : d?.error || (d ? 'Keine Daten' : 'Verbinde …')
      status.textContent = ''
      root.classList.remove('alarm')
      root.classList.add('stale')
      if (chart) for (const p of [area, line, downLine]) p.setAttribute('d', '')
      return
    }
    root.classList.remove('stale')
    value.textContent = mbit(last.up)
    const parts = []
    if (d.maxUp) parts.push(`${Math.round((last.up / d.maxUp) * 100)} % der Leitung (${mbit(d.maxUp)} Mbit/s)`)
    if (o.down) parts.push(`Download ${mbit(last.down)} Mbit/s`)
    sub.textContent = parts.join(' · ')

    // Warnung nur, wenn im gezeigten Zeitraum schon mehr lief (Stream war an) und es jetzt eingebrochen ist
    const from = Date.now() - o.minutes * 60 * 1000
    const shown = list.filter((s) => s.t >= from)
    const limit = o.alarm * 1e6
    const wasStreaming = limit > 0 && shown.some((s) => s.up >= limit)
    const alarm = wasStreaming && last.up < limit
    root.classList.toggle('alarm', alarm)
    status.textContent = alarm ? `Upload unter ${mbit(limit)} Mbit/s – Stream prüfen!` : ''

    if (!chart) return
    const peak = Math.max(...shown.map((s) => Math.max(s.up, o.down ? s.down : 0)), limit * 1.3, 1e6)
    const top = peak * 1.15
    const x = (t) => ((t - from) / (o.minutes * 60 * 1000)) * 1000
    const y = (v) => 300 - (v / top) * 290
    const pts = shown.map((s) => `${x(s.t).toFixed(1)},${y(s.up).toFixed(1)}`)
    if (pts.length) {
      line.setAttribute('d', `M${pts.join('L')}`)
      area.setAttribute('d', `M${x(shown[0].t).toFixed(1)},300L${pts.join('L')}L${x(last.t).toFixed(1)},300Z`)
    }
    downLine.setAttribute('d', o.down && shown.length ? `M${shown.map((s) => `${x(s.t).toFixed(1)},${y(s.down).toFixed(1)}`).join('L')}` : '')
    if (limit > 0) {
      alarmLine.setAttribute('x1', '0')
      alarmLine.setAttribute('x2', '1000')
      alarmLine.setAttribute('y1', y(limit).toFixed(1))
      alarmLine.setAttribute('y2', y(limit).toFixed(1))
    }
    alarmLine.style.display = limit > 0 ? '' : 'none'
  }

  const view = {
    el: root,
    update(state) {
      data = state
      draw()
    },
    tick: draw,
  }
  views.add(view)
  return view
}

const views = new Set()
// Kurve weiterschieben und veraltete Werte erkennen, auch wenn nichts mehr kommt
setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 2000)
