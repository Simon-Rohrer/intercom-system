// Kachel „YouTube Live“: läuft der Stream, Zuschauer, Laufzeit, Zustand des ATEM-Streamings,
// Warnungen und auf Wunsch der Live-Chat. Die Daten holt der Server (youtube.js) – mit
// API-Schlüssel, ohne Google-Anmeldung.

const TIME_ZONE = 'Europe/Berlin'

/** Was die Kachel einzeln zeigen kann – alles an, außer dem Live-Chat */
export const YOUTUBE_PARTS = ['header', 'status', 'big', 'runtime', 'when', 'peak', 'views', 'likes', 'name', 'atem', 'atemDetails', 'problems']

/** Einstellungen der Kachel (tile.youtube) mit Standardwerten */
export function youtubeOptions(o = {}) {
  const n = Number(o.size)
  const parts = Object.fromEntries(YOUTUBE_PARTS.map((key) => [key, o[key] !== false]))
  return {
    title: String(o.title ?? 'YouTube').slice(0, 40),
    size: o.size != null && o.size !== '' && Number.isFinite(n) ? Math.min(2.5, Math.max(0.5, n)) : 1,
    ...parts,
    chat: o.chat === true,
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

const count = (n) => Number(n || 0).toLocaleString('de-DE')
const clock = (ms) => new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE })

function runtime(ms) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function startsIn(ms) {
  const minutes = Math.round(ms / 60000)
  if (minutes < 1) return 'gleich'
  if (minutes < 60) return `in ${minutes} Min.`
  const h = Math.floor(minutes / 60)
  return h < 24 ? `in ${h} Std. ${minutes % 60} Min.` : ''
}

const ATEM_TEXT = { off: 'ATEM nicht verbunden', nostream: 'ATEM verbunden (streamt nicht selbst)', idle: 'ATEM-Stream aus', connecting: 'ATEM verbindet …', streaming: 'ATEM sendet', stopping: 'ATEM beendet den Stream' }

export function createYouTubeView(options) {
  const o = youtubeOptions(options)
  const root = el('div', 'youtube')
  root.style.setProperty('--yt-scale', String(o.size))
  root.classList.toggle('with-chat', o.chat)
  const header = el('header', 'yt-header')
  const title = el('strong', 'yt-title', o.title)
  const pill = el('span', 'yt-pill', '–')
  title.hidden = !o.header
  pill.hidden = !o.status
  header.append(title, pill)
  const main = el('div', 'yt-main')
  const viewers = el('span', 'yt-value', '–')
  const unit = el('span', 'yt-unit', 'Zuschauer')
  const clockEl = el('span', 'yt-runtime')
  viewers.hidden = unit.hidden = !o.big
  clockEl.hidden = !o.runtime
  main.append(viewers, unit, clockEl)
  const sub = el('div', 'yt-sub')
  const name = el('div', 'yt-name')
  const atemLine = el('div', 'yt-atem')
  const problems = el('ul', 'yt-problems')
  if (o.header || o.status) root.append(header)
  if (o.big || o.runtime) root.append(main)
  root.append(sub)
  if (o.name) root.append(name)
  if (o.atem) root.append(atemLine)
  if (o.problems) root.append(problems)
  const chatList = o.chat ? el('ol', 'yt-chat') : null
  if (chatList) root.append(chatList)

  let data = null
  let chatKey = ''

  function draw() {
    const d = data
    const v = d?.video
    const now = Date.now()
    const live = v?.status === 'live'
    root.classList.toggle('live', live)
    root.classList.toggle('stale', !live)
    root.classList.toggle('alarm', o.problems && Boolean(d?.problems?.some((p) => p.level === 'error')))

    if (!d || d.state === 'unconfigured') {
      pill.textContent = 'Nicht eingerichtet'
      viewers.textContent = '–'
      unit.textContent = ''
      clockEl.textContent = ''
      sub.textContent = d ? 'API-Schlüssel und Kanal unter Einstellungen → YouTube eintragen' : 'Verbinde …'
      name.textContent = ''
    } else {
      pill.textContent = live ? 'Live' : v?.status === 'upcoming' ? 'Geplant' : v?.status === 'ended' ? 'Beendet' : d.state === 'error' ? 'Fehler' : 'Offline'
      unit.textContent = live ? 'Zuschauer' : ''
      if (live) {
        viewers.textContent = v.viewers != null ? count(v.viewers) : '–'
        clockEl.textContent = v.actualStart ? runtime(now - v.actualStart) : ''
        sub.textContent = [o.peak && v.peak ? `Spitze ${count(v.peak)}` : '', o.views && v.views != null ? `${count(v.views)} Aufrufe` : '', o.likes && v.likes != null ? `${count(v.likes)} Likes` : '']
          .filter(Boolean)
          .join(' · ')
      } else if (v?.status === 'upcoming' && v.scheduledStart) {
        viewers.textContent = clock(v.scheduledStart)
        clockEl.textContent = ''
        const day = new Date(v.scheduledStart).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: TIME_ZONE })
        const today = new Date(now).toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', timeZone: TIME_ZONE })
        sub.textContent = o.when ? `${day === today ? 'Heute' : day} · ${v.scheduledStart > now ? startsIn(v.scheduledStart - now) : 'überfällig'}`.replace(/ · $/, '') : ''
      } else if (v?.status === 'ended') {
        viewers.textContent = v.actualStart && v.actualEnd ? runtime(v.actualEnd - v.actualStart).replace(/:\d\d$/, '') : '–'
        clockEl.textContent = ''
        sub.textContent = [o.when ? `Beendet ${v.actualEnd ? clock(v.actualEnd) : ''}`.trim() : '', o.views && v.views != null ? `${count(v.views)} Aufrufe` : ''].filter(Boolean).join(' · ')
      } else {
        viewers.textContent = '–'
        clockEl.textContent = ''
        sub.textContent = d.state === 'error' ? d.error : d.state === 'connecting' ? 'Verbinde …' : 'Kein Stream geplant'
      }
      name.textContent = v?.title || d.channelTitle || ''
    }

    if (o.atem) {
      const a = d?.atem
      const parts = [ATEM_TEXT[a?.state] ?? 'ATEM –']
      if (o.atemDetails && a?.state === 'streaming') {
        if (a.bitrate) parts.push(`${(a.bitrate / 1e6).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Mbit/s`)
        if (a.cache != null) parts.push(`Puffer ${Math.round(a.cache)} %`)
      }
      atemLine.textContent = parts.join(' · ')
      atemLine.classList.toggle('on', a?.state === 'streaming')
    }

    if (o.problems) problems.replaceChildren(...(d?.problems || []).map((p) => el('li', p.level, p.text)))

    if (chatList) {
      const messages = d?.chat || []
      const key = `${messages.length}:${messages[messages.length - 1]?.id ?? ''}:${d?.chatError ?? ''}`
      if (key !== chatKey) {
        chatKey = key
        if (!messages.length) {
          chatList.replaceChildren(el('li', 'yt-chat-empty', d?.chatError || (live ? (v?.chat ? 'Noch keine Nachrichten' : 'Live-Chat ist aus') : 'Chat erscheint, wenn der Stream läuft')))
        } else {
          chatList.replaceChildren(
            ...messages.map((m) => {
              const item = el('li', m.owner ? 'owner' : m.mod ? 'mod' : m.amount ? 'super' : '')
              item.append(el('span', 'yt-author', m.author), el('span', 'yt-text', m.amount ? `${m.amount} · ${m.text}` : m.text))
              return item
            }),
          )
          chatList.scrollTop = chatList.scrollHeight
        }
      }
    }
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
// Laufzeit und „beginnt in …“ jede Sekunde weiterzählen
setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else view.tick()
  }
}, 1000)
