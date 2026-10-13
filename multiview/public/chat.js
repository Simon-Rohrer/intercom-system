// Kesher-Chat als Kachel: gleiche Darstellung wie die Kesher-Chat-Anzeige (?viewMode=chat).
// Die Nachrichten kommen vom Multiview-Server, der einmal bei Kesher angemeldet ist.

/** Ältere Nachrichten bleiben stehen, werden aber abgedunkelt. */
const RECENT_MS = 5 * 60 * 1000
const FLASH_MS = 4000

const views = new Set()

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text != null) node.textContent = text
  return node
}

function shortTime(ts) {
  return new Date(ts).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
}

export function createChatView() {
  const root = el('div', 'kchat')
  const header = el('header', 'kchat-header')
  const logo = el('img', 'kchat-logo')
  logo.src = 'jms-logo.svg'
  logo.alt = 'JMS Logo'
  const title = el('div', 'kchat-title')
  const station = el('span')
  title.append(el('strong', null, 'Intercom-Chat'), station)
  const live = el('span', 'kchat-live')
  const liveText = el('span')
  live.append(el('span', 'kchat-live-dot'), liveText)
  const clock = el('time', 'kchat-clock')
  header.append(logo, el('span', 'kchat-sep'), title, live, clock)

  const body = el('div', 'kchat-body')
  root.append(header, body)

  const firstSeen = new Map()
  let lastKey = ''

  const view = {
    el: root,
    clock,
    update(chat) {
      station.textContent = chat.stationName || ''
      const connected = chat.state === 'connected'
      live.classList.toggle('connected', connected)
      live.classList.toggle('disconnected', !connected)
      liveText.textContent = connected ? 'Live' : chat.state === 'offline' ? 'Offline' : 'Verbinde …'
      live.title = connected ? '' : chat.error || ''

      // Neueste unten, wie in Kesher
      const feed = (chat.messages || []).slice(0, 60).reverse()
      const now = Date.now()
      for (const m of feed) if (!firstSeen.has(m.key)) firstSeen.set(m.key, m.receivedAt || now)

      if (!feed.length) {
        body.replaceChildren(el('p', 'kchat-empty', 'Noch keine Nachrichten.'))
        lastKey = ''
        return
      }
      const list = el('ol', 'kchat-feed')
      feed.forEach((m, i) => {
        const isNewest = i === feed.length - 1
        const isOld = now - (firstSeen.get(m.key) ?? now) > RECENT_MS && !isNewest
        const needsAck = m.ackRequired && !m.acked
        const li = el('li', `kchat-msg scope-${m.scope}`)
        if (isNewest) li.classList.add('is-newest')
        if (isNewest && m.key !== lastKey) li.classList.add('arrive')
        if (isOld) li.classList.add('is-old')
        if (needsAck) li.classList.add('needs-ack')
        const meta = el('div', 'kchat-meta')
        meta.append(el('strong', null, m.from))
        if (m.fromRole && m.fromRole !== m.from) meta.append(el('span', 'kchat-role', m.fromRole))
        meta.append(el('span', 'kchat-target', m.target))
        if (m.source === 'telegram') meta.append(el('span', 'kchat-target is-telegram', 'Telegram'))
        else if (m.source === 'companion') meta.append(el('span', 'kchat-target', 'Stream Deck'))
        else if (m.source === 'multiview') meta.append(el('span', 'kchat-target', 'Multiview'))
        if (needsAck) meta.append(el('span', 'kchat-ack', 'Bestätigung erwartet'))
        meta.append(el('time', null, shortTime(m.timestamp)))
        li.append(meta, el('p', 'kchat-text', m.body))
        list.append(li)
      })
      lastKey = feed[feed.length - 1].key
      body.replaceChildren(list)
      list.scrollTop = list.scrollHeight
    },
    /** Stream-Deck-Nachricht: gelber Rahmen blinkt, Text in der Mitte der Kachel. */
    flash({ title: heading, detail }) {
      root.querySelector('.kchat-flash')?.remove()
      const overlay = el('div', 'kchat-flash')
      const card = el('div', 'kchat-flash-card')
      card.append(el('strong', null, heading), el('span', null, detail))
      overlay.append(card)
      root.append(overlay)
      setTimeout(() => overlay.remove(), FLASH_MS)
    },
  }
  views.add(view)
  tickClock(view)
  return view
}

function tickClock(view) {
  const text = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  if (view.clock.textContent !== text) view.clock.textContent = text
}

setInterval(() => {
  for (const view of views) {
    if (!view.el.isConnected) views.delete(view)
    else tickClock(view)
  }
}, 1000)
