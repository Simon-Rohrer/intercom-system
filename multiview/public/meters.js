// Audio-Pegelanzeigen (Stereo-Balken mit Spitzenwert), gespeist mit den Pegeln vom ATEM.
// Aussehen pro Kachel einstellbar: Position, Dicke, Länge, Balken oder Segmente, Skala.

const FLOOR = -60 // dB am unteren Ende der Anzeige
const FALL_DB_PER_S = 24 // so schnell fällt der Balken
const PEAK_HOLD_MS = 1500
const STALE_MS = 1000 // ohne neue Werte gilt die Anzeige als still

const SCALE = [0, -6, -18, -30, -45]

/** Grundeinstellung einer Pegelanzeige in einer Videokachel. */
export const METER_DEFAULTS = { position: 'left', size: 1, length: 62, style: 'bar', scale: false }
/** Grundeinstellung eines Pegel-Fensters (mehrere Pegel in einer eigenen Kachel). */
// fill = Pegel teilen sich die ganze Kachel, gap = Abstand (Faktor), labels = Namen anzeigen
export const BANK_DEFAULTS = { orientation: 'vertical', size: 1, style: 'bar', scale: true, fill: false, gap: 1, labels: true }

const meters = new Set()
let levels = { inputs: {}, master: null }
let receivedAt = 0

const toFraction = (db) => Math.min(1, Math.max(0, (db - FLOOR) / -FLOOR))

/** Neue Pegel vom Server ({ inputs: { id: [l, r] }, master: [l, r] }). */
export function setLevels(msg) {
  levels = msg
  receivedAt = performance.now()
}

/** Pegel eines ATEM-Audioeingangs ('master' = Summe) oder null, wenn unbekannt. */
function levelsFor(key) {
  if (performance.now() - receivedAt > STALE_MS) return null
  return key === 'master' ? levels.master : levels.inputs?.[key]
}

/**
 * Erzeugt eine Pegelanzeige für einen ATEM-Audioeingang (Zahl) oder 'master'.
 * options: { position, size, length, style, scale } – siehe METER_DEFAULTS;
 * big = große Anzeige für eine eigene Audio-Kachel (position: 'vertical' | 'horizontal').
 */
/** Vollständige, gültige Einstellungen einer Pegelanzeige in einer Videokachel. */
export function meterOptions(options) {
  const o = { ...METER_DEFAULTS, ...options }
  if (!['left', 'right', 'top', 'bottom'].includes(o.position)) o.position = 'left'
  return o
}

/** Vollständige, gültige Einstellungen eines Pegel-Fensters. */
export function bankOptions(options) {
  const o = { ...BANK_DEFAULTS, ...options }
  if (!['vertical', 'horizontal'].includes(o.orientation)) o.orientation = 'vertical'
  return o
}

/**
 * Erzeugt eine Pegelanzeige für einen ATEM-Audioeingang (Zahl) oder 'master'.
 * options: { position, size, length, style, scale } – siehe METER_DEFAULTS.
 * bank = Teil eines Pegel-Fensters (wird vom Fenster angeordnet statt in der Kachel positioniert).
 */
export function createMeter(key, options = {}, { bank = false, scaleBefore = false } = {}) {
  const o = meterOptions(options)
  const horizontal = o.position === 'top' || o.position === 'bottom'

  const el = document.createElement('div')
  el.className = [
    'meter',
    bank ? 'bank-meter' : `meter-${o.position}`,
    horizontal ? 'horizontal' : 'vertical',
    o.style === 'segments' ? 'segments' : '',
    scaleBefore ? 'scale-before' : '',
  ].join(' ')
  el.style.setProperty('--meter-size', String(o.size))
  el.style.setProperty('--meter-length', `${o.length}%`)

  const channel = '<div class="meter-ch"><div class="meter-fill"></div><div class="meter-peak"></div></div>'
  el.innerHTML = `<div class="meter-bars">${channel}${channel}</div>`

  if (o.scale) {
    const scale = document.createElement('div')
    scale.className = 'meter-scale'
    for (const db of SCALE) {
      const tick = document.createElement('span')
      tick.textContent = db
      tick.style[horizontal ? 'left' : 'bottom'] = `${toFraction(db) * 100}%`
      scale.append(tick)
    }
    el.append(scale)
  }

  meters.add({
    el,
    key,
    horizontal,
    fills: el.querySelectorAll('.meter-fill'),
    peaks: el.querySelectorAll('.meter-peak'),
    shown: [-100, -100],
    peak: [-100, -100],
    peakAt: [0, 0],
    last: performance.now(),
  })
  return el
}

/**
 * Pegel-Fenster: mehrere Pegel mit Namen, nebeneinander (senkrecht) oder untereinander (waagerecht).
 * channels: [{ input: 'master' | Zahl, label }]. Gibt das Element und die Namensfelder zurück,
 * damit der Aufrufer Namen und Tally aktualisieren kann.
 */
export function createMeterBank(channels, options) {
  const o = bankOptions(options)
  const horizontal = o.orientation === 'horizontal'
  const el = document.createElement('div')
  el.className = `meter-bank ${o.orientation}${o.fill ? ' fill' : ''}${o.labels ? '' : ' no-labels'}`
  el.style.setProperty('--meter-size', String(o.size))
  el.style.setProperty('--bank-gap', String(o.gap))
  const labels = []

  if (!channels.length) {
    const empty = document.createElement('div')
    empty.className = 'bank-empty'
    empty.textContent = 'Noch keine Pegel angelegt'
    el.append(empty)
  }
  channels.forEach((channel, i) => {
    const wrap = document.createElement('div')
    wrap.className = 'bank-ch'
    const key = channel.input === 'master' || channel.input == null ? 'master' : Number(channel.input)
    // Die Skala steht einmal vorne, beim ersten Pegel
    const meter = createMeter(
      key,
      { position: horizontal ? 'top' : 'left', style: o.style, size: o.size, scale: o.scale && i === 0 },
      { bank: true, scaleBefore: true },
    )
    const label = document.createElement('div')
    label.className = 'bank-label'
    if (horizontal) wrap.append(label, meter)
    else wrap.append(meter, label)
    labels.push({ el: label, channel })
    el.append(wrap)
  })
  return { el, labels }
}

function frame(now) {
  for (const m of meters) {
    if (!m.el.isConnected) {
      // noch nicht eingehängt oder schon entfernt – entfernte Anzeigen vergessen
      if (now - m.last > 5000) meters.delete(m)
      continue
    }
    const dt = (now - m.last) / 1000
    m.last = now
    const values = levelsFor(m.key)
    for (let c = 0; c < 2; c++) {
      const target = values ? values[c] : -100
      // schnell hoch, langsam runter (wie ein echter Pegelmesser)
      m.shown[c] = target >= m.shown[c] ? target : Math.max(target, m.shown[c] - FALL_DB_PER_S * dt)
      if (m.shown[c] >= m.peak[c] || now - m.peakAt[c] > PEAK_HOLD_MS) {
        m.peak[c] = m.shown[c]
        m.peakAt[c] = now
      }
      const lit = toFraction(m.shown[c])
      const peak = toFraction(m.peak[c])
      if (m.horizontal) {
        m.fills[c].style.clipPath = `inset(0 ${(1 - lit) * 100}% 0 0)`
        m.peaks[c].style.left = `${peak * 100}%`
      } else {
        m.fills[c].style.clipPath = `inset(${(1 - lit) * 100}% 0 0 0)`
        m.peaks[c].style.bottom = `${peak * 100}%`
      }
      m.peaks[c].style.opacity = m.peak[c] > FLOOR ? '1' : '0'
    }
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
