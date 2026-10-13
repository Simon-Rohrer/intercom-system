// ProPresenter-Bühne als Kachel – wie ein Stage Display: Songtext (aktuelle und nächste Folie),
// Countdowns/Timer, Video-Countdown, Bühnennachricht und laufende Meldungen.
// update(state) bekommt den Folien-Zustand ("propresenter"), updateStage(stage) die Zeiten und
// Nachrichten ("ppstage"). Auf den Monitoren lässt sich die Bühnennachricht senden und löschen,
// im Editor ist alles nur Vorschau.

export const STAGE_DEFAULTS = {
  song: true, // Liedname und Teil (Strophe, Refrain …)
  current: true, // Text der aktuellen Folie
  next: true, // Text der nächsten Folie
  notes: false, // Folien-Notizen
  message: true, // Bühnennachricht
  messages: false, // laufende Meldungen (Publikum)
  timers: [], // UUIDs der gezeigten Timer; leer = alle, die gerade laufen
  videoCountdown: true,
  clock: true,
  send: true, // Bühnennachricht am Monitor senden
  size: 1,
}

export function stageOptions(options) {
  const o = { ...STAGE_DEFAULTS, ...options }
  if (!Array.isArray(o.timers)) o.timers = []
  o.size = Math.min(2.5, Math.max(0.5, Number(o.size) || 1))
  return o
}

/** "-00:01:30" → "-1:30", "00:05:00" → "5:00", "01:02:03" → "1:02:03" */
export function fmtTimer(time) {
  const m = /^(-?)(\d+):(\d{2}):(\d{2})/.exec(String(time || ''))
  if (!m) return String(time || '')
  const [, sign, h, mm, ss] = m
  return Number(h) ? `${sign}${Number(h)}:${mm}:${ss}` : `${sign}${Number(mm)}:${ss}`
}

const ACTIVE_TIMER = ['running', 'overrunning', 'overran']

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const views = new Set()

async function sendStageMessage(text) {
  const res = await fetch(text ? '/api/propresenter/stage-message' : '/api/propresenter/stage-message/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
}

/** interactive = Bühnennachricht senden möglich (nur auf den Monitoren). */
export function createStageView(options, { interactive = false } = {}) {
  const o = stageOptions(options)
  const root = el('div', `st-view${interactive ? ' interactive' : ''}`)
  root.style.setProperty('--st-size', o.size)

  const head = el('header', 'st-head')
  const song = el('span', 'st-song')
  const group = el('span', 'st-group')
  const clock = el('span', 'st-clock')
  head.append(song, group, clock)

  const message = el('div', 'st-message')
  const messageText = el('div', 'st-message-text')
  message.append(el('span', 'st-tag', 'Bühnennachricht'), messageText)

  const current = el('div', 'st-current')
  const currentText = el('div', 'st-text')
  current.append(currentText)

  const next = el('div', 'st-next')
  const nextText = el('div', 'st-text')
  next.append(el('span', 'st-tag', 'Als Nächstes'), nextText)

  const notes = el('div', 'st-notes')
  const meldungen = el('div', 'st-meldungen')
  const timers = el('footer', 'st-timers')

  root.append(head, message, current, next, notes, meldungen, timers)

  // Bühnennachricht senden / löschen
  let form = null
  if (o.send) {
    form = el('form', 'st-send')
    const input = el('input')
    input.type = 'text'
    input.maxLength = 500
    input.placeholder = 'Bühnennachricht …'
    input.disabled = !interactive
    const sendBtn = el('button', 'st-btn st-btn-send', 'Senden')
    sendBtn.type = 'submit'
    const clearBtn = el('button', 'st-btn st-btn-clear', 'Löschen')
    clearBtn.type = 'button'
    const error = el('div', 'st-error')
    error.hidden = true
    form.append(input, sendBtn, clearBtn, error)
    root.append(form)

    let busy = false
    const run = async (text) => {
      if (!interactive || busy) return
      busy = true
      form.classList.add('busy')
      error.hidden = true
      try {
        await sendStageMessage(text)
        input.value = ''
      } catch (err) {
        error.textContent = err.message
        error.hidden = false
        setTimeout(() => (error.hidden = true), 4000)
      } finally {
        busy = false
        form.classList.remove('busy')
      }
    }
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const text = input.value.trim()
      if (text) run(text)
    })
    clearBtn.addEventListener('click', () => run(''))
  }

  let pp = null
  let stage = null
  let shownMessage = ''

  function renderSlides() {
    const connected = Boolean(pp?.connected)
    const cue = pp?.cues?.[pp?.index]
    song.textContent = o.song ? pp?.presentation?.name || '' : ''
    group.textContent = o.song ? cue?.group || '' : ''
    group.style.background = o.song && cue?.color ? cue.color : ''
    group.hidden = !group.textContent

    current.hidden = !o.current
    const text = pp?.current?.text?.trim() || ''
    currentText.textContent = !connected
      ? 'ProPresenter nicht verbunden'
      : text || (pp?.presentation ? 'Folie ohne Text' : 'Keine Folie')
    current.classList.toggle('empty', !text)

    const nextValue = pp?.next?.text?.trim() || ''
    next.hidden = !o.next || !nextValue
    nextText.textContent = nextValue

    const noteValue = pp?.current?.notes?.trim() || ''
    notes.hidden = !o.notes || !noteValue
    notes.textContent = noteValue
  }

  function renderStage() {
    const timerList = stage?.timers ?? []
    const byUuid = new Map(timerList.map((t) => [t.uuid, t]))

    // Bühnennachricht: neue Nachricht kurz aufblinken lassen
    const msg = o.message ? stage?.message || '' : ''
    message.hidden = !msg
    messageText.textContent = msg
    if (msg && msg !== shownMessage) {
      message.classList.remove('arrive')
      void message.offsetWidth
      message.classList.add('arrive')
    }
    shownMessage = msg

    // Laufende Meldungen mit eingesetzten Timer-Zeiten
    meldungen.replaceChildren()
    if (o.messages) {
      for (const m of stage?.messages ?? []) {
        let text = m.text
        for (const t of m.tokens ?? []) {
          const value = t.timer ? fmtTimer(byUuid.get(t.timer)?.time) : t.text
          text = text.split(`{${t.name}}`).join(value || '')
        }
        meldungen.append(el('div', 'st-meldung', text.trim() || m.name))
      }
    }
    meldungen.hidden = !meldungen.childElementCount

    // Timer: gewählte immer, sonst alle laufenden
    const shown = o.timers.length
      ? o.timers.map((uuid) => byUuid.get(uuid)).filter(Boolean)
      : timerList.filter((t) => ACTIVE_TIMER.includes(t.state))
    timers.replaceChildren()
    for (const t of shown) {
      const chip = el('div', `st-timer state-${t.state || 'stopped'}`)
      chip.append(el('span', 'st-timer-name', t.name), el('span', 'st-timer-time', fmtTimer(t.time)))
      timers.append(chip)
    }
    if (o.videoCountdown && stage?.videoCountdown) {
      const chip = el('div', 'st-timer state-video')
      chip.append(el('span', 'st-timer-name', 'Video'), el('span', 'st-timer-time', fmtTimer(stage.videoCountdown)))
      timers.append(chip)
    }
    timers.hidden = !timers.childElementCount
  }

  const view = {
    el: root,
    update(state) {
      pp = state
      renderSlides()
    },
    updateStage(state) {
      stage = state
      renderStage()
    },
    tick() {
      clock.textContent = o.clock ? new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : ''
    },
  }
  view.tick()
  renderSlides()
  renderStage()
  views.add(view)
  return view
}

setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 1000)
