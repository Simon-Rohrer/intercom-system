// Kachel „Event-Ops“: Ampel über die Prüfungen des Veranstaltungsbetriebs (ATEM, ChurchTools,
// Companion, Kesher, ProPresenter, Raspberry-Stationen, LED-Wand, Stage Display, Stream Decks …).
// Gesamt grün/gelb/rot und die Liste der nicht-grünen Punkte mit Kurztext („LED-Wand prüfen“).
// Die Daten liefert der Server als Nachricht „ops“ (ops-status.js).

const STALE_MS = 3 * 60 * 1000

const num = (v, d, min, max) => {
  const n = Number(v)
  return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
}

/** Einstellungen der Kachel (tile.ops) mit Standardwerten */
export function opsOptions(o = {}) {
  return {
    title: String(o.title ?? 'Event-Ops').slice(0, 40),
    all: o.all === true, // alle Prüfungen zeigen, nicht nur Probleme
    event: o.event !== false, // Name der Veranstaltung
    size: num(o.size, 1, 0.5, 2.5),
  }
}

const OVERALL_TEXT = { ok: 'Alles grün', warn: 'Prüfen', error: 'Störung', unknown: 'Keine Daten' }

/** Was die Kachel aus der Nachricht zeigt – ohne DOM, damit es sich testen lässt */
export function opsView(data, o, now = Date.now()) {
  if (!data) return { overall: 'unknown', text: 'Verbinde …', items: [], note: '', stale: true }
  const stale = data.state !== 'ok' || !data.at || now - data.at > STALE_MS
  const overall = stale && data.state !== 'ok' ? 'unknown' : data.overall || 'unknown'
  const items = (data.items || []).filter((item) => o.all || item.level !== 'ok')
  const note =
    data.state === 'connecting'
      ? 'Prüfungen laufen …'
      : data.state === 'error'
        ? data.error || 'Prüfungen nicht abrufbar'
        : stale
          ? 'Keine aktuellen Daten'
          : !data.items?.length
            ? 'Keine Prüfungen eingerichtet'
            : ''
  return { overall, text: OVERALL_TEXT[overall], items, note, stale }
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

export function createOpsView(options) {
  const o = opsOptions(options)
  const root = el('div', 'ampel')
  root.style.setProperty('--am-scale', String(o.size))
  const header = el('header', 'am-header')
  const title = el('strong', 'am-title', o.title)
  const pill = el('span', 'am-pill', '–')
  header.append(title, pill)
  const main = el('div', 'am-main')
  const lamp = el('div', 'am-lamp')
  const summary = el('div', 'am-summary')
  const text = el('strong', 'am-text', '–')
  const event = el('span', 'am-event')
  summary.append(text, event)
  main.append(lamp, summary)
  const list = el('ul', 'am-list')
  const note = el('div', 'am-note')
  root.append(header, main, list, note)

  let data = null

  function draw() {
    const v = opsView(data, o)
    for (const k of ['ok', 'warn', 'error', 'unknown']) root.classList.toggle(k, v.overall === k)
    root.classList.toggle('stale', v.stale)
    pill.textContent = v.text
    text.textContent = v.text
    event.textContent = o.event ? data?.event || '' : ''
    note.textContent = v.note
    if (!v.items.length && !v.note && data?.state === 'ok') note.textContent = o.all ? '' : 'Alle Prüfungen in Ordnung'
    list.replaceChildren(
      ...v.items.map((item) => {
        // Punkt in der Farbe des Status (grau = unbestätigt), Text nach Wirkung auf die Ampel
        const li = el('li', `am-item ${item.level} status-${item.status}${item.required ? ' required' : ''}`)
        li.append(el('span', 'am-dot'), el('span', 'am-short', item.short))
        if (!item.required) li.append(el('span', 'am-opt', 'optional'))
        li.title = item.detail || item.name
        return li
      }),
    )
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
// Veraltete Daten erkennen, auch wenn nichts mehr kommt
setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 10_000)
