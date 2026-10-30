// Kachel „Licht“ (grandMA3): je überwachter Sequenz der laufende Cue, z. B. „Licht: Lobpreis (Cue 12)“.
// Die Daten kommen per OSC von der Konsole über den Server; von hier aus wird nichts gesteuert.

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** Einstellungen der Kachel (tile.grandma3) mit Standardwerten */
export function grandma3Options(o = {}) {
  const num = (v, d, min, max) => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  return {
    title: String(o.title ?? 'Licht').slice(0, 40),
    size: num(o.size, 1, 0.5, 2.5),
    number: o.number !== false, // Cue-Nummer zeigen
    fader: o.fader === true, // Faderstand der Sequenz zeigen
    header: o.header !== false,
  }
}

/** Text für den Zustand – auch für die Einstellungen */
export function grandma3StateText(d) {
  if (!d) return 'Verbinde …'
  if (d.state === 'ok') return `OSC kommt an (Port ${d.port}${d.lastFrom ? `, von ${d.lastFrom}` : ''})`
  if (d.state === 'listening') return `Warte auf OSC an Port ${d.port} – noch nichts empfangen`
  if (d.state === 'off') return 'Empfang ausgeschaltet'
  return `Fehler: ${d.error || 'Port konnte nicht geöffnet werden'}`
}

/** Eine Zeile: „Lobpreis (Cue 12)“ bzw. „Cue 12“ oder „noch kein Cue“ */
export function cueText(seq, o = grandma3Options()) {
  const cue = seq?.cue
  if (!cue || (cue.number == null && !cue.name)) return 'noch kein Cue'
  const nr = o.number && cue.number != null ? `Cue ${cue.number}` : ''
  if (cue.name && nr) return `${cue.name} (${nr})`
  return cue.name || nr || `Cue ${cue.number}`
}

export function createGrandma3View(options) {
  const o = grandma3Options(options)
  const root = el('div', 'grandma3')
  root.style.setProperty('--ma-scale', String(o.size))
  const header = el('header', 'ma-header')
  const title = el('strong', 'ma-title', o.title)
  const pill = el('span', 'ma-pill')
  header.append(title, pill)
  header.hidden = !o.header
  const list = el('div', 'ma-list')
  const note = el('div', 'ma-note')
  root.append(header, list, note)

  let data = null

  function draw() {
    const d = data
    const ok = d?.state === 'ok'
    pill.textContent = ok ? 'grandMA3' : d?.state === 'listening' ? 'Wartet' : d?.state === 'off' ? 'Aus' : 'Fehler'
    pill.classList.toggle('bad', d?.state === 'error')
    pill.title = d?.error || ''
    list.replaceChildren()
    note.textContent = ''
    if (!d || d.state === 'error' || d.state === 'off') {
      note.textContent = grandma3StateText(d)
      return
    }
    const seqs = d.sequences || []
    if (!seqs.length) {
      note.textContent = 'Keine Sequenz eingetragen (Einstellungen → grandMA3)'
      return
    }
    for (const s of seqs) {
      const row = el('div', `ma-row${s.cue ? '' : ' empty'}`)
      const name = el('span', 'ma-name', s.name)
      name.title = s.consoleName && s.consoleName !== s.name ? `Sequenz ${s.number} · an der Konsole: ${s.consoleName}` : `Sequenz ${s.number}`
      const cue = el('span', 'ma-cue', cueText(s, o))
      row.append(name, cue)
      if (o.fader && s.fader != null) row.append(el('span', 'ma-fader', `${Math.round(s.fader)} %`))
      list.append(row)
    }
    if (d.state === 'listening') note.textContent = grandma3StateText(d)
  }

  return {
    el: root,
    update(state) {
      data = state
      draw()
    },
  }
}
