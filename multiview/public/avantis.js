// Kachel „Mischpult“ (Allen & Heath Avantis): überwachte Kanäle mit Mute-Zustand und die zuletzt
// abgerufene Szene. Ist ein als „kritisch“ markierter Kanal stumm (z. B. das Pastor-Mikro),
// wird die Kachel rot und zeigt eine große Warnung. Von hier aus wird nichts gesteuert.

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

/** Einstellungen der Kachel (tile.avantis) mit Standardwerten */
export function avantisOptions(o = {}) {
  const num = (v, d, min, max) => {
    const n = Number(v)
    return v != null && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  return {
    title: String(o.title ?? 'Mischpult').slice(0, 40),
    size: num(o.size, 1, 0.5, 2.5),
    scene: o.scene !== false, // aktuelle Szene zeigen
    open: o.open !== false, // auch offene (nicht stumme) Kanäle auflisten
    columns: num(o.columns, 1, 1, 3),
  }
}

/** Text für den Zustand der Verbindung – auch für die Einstellungen */
export function avantisStateText(d) {
  if (!d) return 'Verbinde …'
  if (d.state === 'ok') return `Verbunden mit ${d.host}`
  if (d.state === 'unconfigured') return 'Keine Adresse eingetragen'
  if (d.state === 'off') return 'Abfrage ausgeschaltet'
  if (d.state === 'connecting') return `Verbinde mit ${d.host} …`
  return `Fehler: ${d.error || 'keine Antwort'}`
}

export function createAvantisView(options) {
  const o = avantisOptions(options)
  const root = el('div', 'avantis')
  root.style.setProperty('--av-scale', String(o.size))
  root.style.setProperty('--av-cols', String(o.columns))
  const header = el('header', 'av-header')
  const title = el('strong', 'av-title', o.title)
  const pill = el('span', 'av-pill')
  header.append(title, pill)
  const alarm = el('div', 'av-alarm')
  alarm.hidden = true
  const list = el('div', 'av-list')
  const note = el('div', 'av-note')
  const scene = el('footer', 'av-scene')
  root.append(header, alarm, list, note, scene)

  let data = null

  function draw() {
    const d = data
    const ok = d?.state === 'ok'
    pill.textContent = ok ? 'Avantis' : d?.state === 'off' ? 'Aus' : d?.state === 'unconfigured' ? 'Nicht eingerichtet' : 'Offline'
    pill.classList.toggle('bad', !ok && d?.state !== 'off' && d?.state !== 'unconfigured')
    pill.title = d?.error || ''
    const alarms = ok ? d.alarm || [] : []
    root.classList.toggle('alarm', alarms.length > 0)
    alarm.hidden = alarms.length === 0
    alarm.textContent = alarms.length ? `${alarms.join(', ')} stumm!` : ''

    list.replaceChildren()
    note.textContent = ''
    if (!ok) {
      note.textContent = avantisStateText(d)
      scene.textContent = ''
      return
    }
    const channels = d.channels || []
    const shown = o.open ? channels : channels.filter((c) => c.muted !== false)
    if (!channels.length) note.textContent = 'Keine Kanäle eingetragen (Einstellungen → Avantis)'
    else if (!shown.length) note.textContent = 'Alle überwachten Kanäle offen'
    let unknown = 0
    for (const c of shown) {
      const row = el('div', `av-row ${c.muted === true ? 'muted' : c.muted === false ? 'open' : 'unknown'}${c.critical ? ' critical' : ''}`)
      const name = el('span', 'av-name', c.name)
      name.title = c.consoleName && c.consoleName !== c.name ? `${c.label} · am Pult: ${c.consoleName}` : c.label
      const badge = el('span', 'av-badge', c.muted === true ? 'STUMM' : c.muted === false ? 'OFFEN' : '?')
      row.append(name, badge)
      list.append(row)
      if (c.muted == null) unknown++
    }
    if (unknown && !note.textContent) note.textContent = unknown === channels.length ? 'Mute-Zustand erst nach der nächsten Änderung am Pult bekannt' : `${unknown} Kanal/Kanäle noch ohne Rückmeldung`

    if (!o.scene) {
      scene.textContent = ''
      return
    }
    if (d.scene) {
      scene.textContent = `Szene ${d.scene.number}${d.scene.name ? ` · ${d.scene.name}` : ''}`
      scene.title = d.scene.at ? `abgerufen ${new Date(d.scene.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ''
    } else {
      scene.textContent = 'Seit der Verbindung keine Szene abgerufen'
      scene.title = ''
    }
  }

  return {
    el: root,
    update(state) {
      data = state
      draw()
    },
  }
}
