// Kachel „Tally“: zeigt für einen ATEM-Eingang, ob er auf Sendung (rot) oder in der Vorschau (grün)
// ist. Als „Rahmen“ bleibt die Kachel durchsichtig und zeigt nur einen farbigen Rand – gedacht als
// Vollbild-Rahmen über dem Kamerabild am Raspberry Pi. Als „Feld“ färbt sich die ganze Kachel und
// nennt den Eingang. Dazu auf Wunsch, ob der ATEM selbst aufnimmt oder streamt (Nachricht „atem“).

const num = (v, d, min, max) => {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

/** Einstellungen der Kachel (tile.tally) mit Standardwerten */
export function tallyOptions(o = {}) {
  const n = Number(o.input)
  return {
    input: o.input != null && o.input !== '' && Number.isFinite(n) ? n : null, // ATEM-Eingang
    mode: o.mode === 'frame' ? 'frame' : 'field', // Rahmen oder Feld
    label: String(o.label ?? '').slice(0, 40), // eigene Beschriftung (leer = Name vom ATEM)
    name: o.name !== false, // Namen zeigen (Feld)
    status: o.status === true, // Aufnahme/Streaming des ATEM zeigen
    border: num(o.border, 1, 0.25, 4), // Rahmenstärke
    size: num(o.size, 1, 0.5, 2.5),
  }
}

/** Zustand eines Eingangs: 'program' | 'preview' | 'off' | 'offline' (ATEM nicht verbunden) */
export function tallyState(input, atem) {
  if (!atem?.connected) return 'offline'
  if (input == null) return 'off'
  if (atem.program?.includes(input)) return 'program'
  if (atem.preview?.includes(input)) return 'preview'
  return 'off'
}

/** Name des Eingangs: eigene Beschriftung, sonst der Name vom ATEM */
export function tallyName(o, atem) {
  if (o.label) return o.label
  if (o.input == null) return 'Kein Eingang gewählt'
  const input = atem?.inputs?.[o.input]
  return input?.longName || input?.shortName || `Eingang ${o.input}`
}

const STATE_TEXT = { program: 'Auf Sendung', preview: 'Vorschau', off: '', offline: 'ATEM nicht verbunden' }

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

export function createTallyView(options) {
  const o = tallyOptions(options)
  const root = el('div', `tally ${o.mode}`)
  root.style.setProperty('--ta-scale', String(o.size))
  root.style.setProperty('--ta-border', String(o.border))
  const name = el('div', 'ta-name')
  const state = el('div', 'ta-state')
  const badges = el('div', 'ta-badges')
  const rec = el('span', 'ta-badge rec', 'REC')
  const stream = el('span', 'ta-badge stream', 'STREAM')
  badges.append(rec, stream)
  if (o.mode === 'field' && o.name) root.append(name)
  if (o.mode === 'field') root.append(state)
  if (o.status) root.append(badges)

  function update(atem) {
    const s = tallyState(o.input, atem)
    for (const k of ['program', 'preview', 'off', 'offline']) root.classList.toggle(k, s === k)
    name.textContent = tallyName(o, atem)
    state.textContent = STATE_TEXT[s]
    rec.hidden = atem?.recording !== true
    stream.hidden = atem?.streaming !== true
  }

  return { el: root, update }
}
