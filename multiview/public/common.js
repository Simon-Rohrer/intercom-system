// Gemeinsame Hilfsfunktionen für Editor und Ausgabe-Seiten.

export function uid(prefix = '') {
  return prefix + Math.random().toString(36).slice(2, 9)
}

/**
 * Hinweis, wenn die Live-Verbindung über HTTPS nie zustande kommt: iPhone/iPad (Safari) lassen
 * WebSockets zu einem nicht vertrauten Zertifikat nicht zu, auch wenn die Seite nach der Warnung lädt.
 */
function showCertHint() {
  if (document.getElementById('cert-hint')) return
  const el = document.createElement('div')
  el.id = 'cert-hint'
  el.setAttribute('role', 'alert')
  el.style.cssText =
    'position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:9999;max-width:520px;margin:0 auto;' +
    'padding:14px 16px;border-radius:16px;background:rgba(30,30,32,.94);color:#fff;font:14px/1.45 -apple-system,system-ui,sans-serif;' +
    'box-shadow:0 12px 30px rgba(0,0,0,.4)'
  el.innerHTML =
    '<b>Keine Live-Verbindung zum Server.</b><br>Auf iPhone/iPad einmal das Zertifikat installieren: ' +
    '<a href="/zertifikat" style="color:#64d2ff;font-weight:600">Zertifikat laden</a> → Einstellungen → „Profil geladen“ installieren → ' +
    'Allgemein → Info → Zertifikatsvertrauenseinstellungen → „JMS/Caddy“ einschalten. Danach Seite neu laden.' +
    ' <button type="button" style="margin-left:6px;background:none;border:0;color:#aaa;font:inherit;text-decoration:underline">Ausblenden</button>'
  el.querySelector('button').onclick = () => el.remove()
  document.body.appendChild(el)
}

/** Kennung der Anmeldung aus /api/me – '' ohne Anmeldung. */
export const loginKey = (user) => (user && !user.open ? `${user.name}|${user.roleId}|${Boolean(user.admin)}` : '')

/**
 * An- und Abmeldung gelten für alle Dienste (dasselbe Cookie auf allen Ports). Meldet man sich
 * in Kesher, im Dashboard oder in einem anderen Tab an oder ab, merkt diese Seite das beim
 * Zurückwechseln (und alle 15 s) und lädt neu – ohne dass man selbst neu laden muss.
 */
export function watchLogin(currentKey, { onChange = () => location.reload(), url = '/api/me' } = {}) {
  let busy = false
  const check = async () => {
    if (busy || document.visibilityState === 'hidden') return
    busy = true
    try {
      const me = await fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then((r) => r.json())
      if (me?.access?.enabled && loginKey(me.user) !== currentKey) onChange(me)
    } catch {
      // Server gerade nicht erreichbar – beim nächsten Mal
    } finally {
      busy = false
    }
  }
  document.addEventListener('visibilitychange', check)
  window.addEventListener('focus', check)
  window.addEventListener('pageshow', (e) => e.persisted && check())
  setInterval(check, 15000)
}

/** WebSocket mit automatischem Neuverbinden. */
export function connect(onMessage, onStatus) {
  let ws
  let everOpen = false
  let failures = 0
  const open = () => {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
    ws.onopen = () => {
      everOpen = true
      failures = 0
      document.getElementById('cert-hint')?.remove()
      onStatus?.(true)
    }
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data))
      } catch (err) {
        console.error(err)
      }
    }
    ws.onclose = (e) => {
      onStatus?.(false)
      // Ohne Anmeldung lässt der Server nur feste Geräte zu: zur Anmeldeseite statt endlos neu zu verbinden
      if (e.code === 4401)
        return location.replace(`/login.html?next=${encodeURIComponent(location.pathname + location.search + location.hash)}`)
      if (!everOpen && location.protocol === 'https:' && ++failures === 3) showCertHint()
      setTimeout(open, 1500)
    }
  }
  open()
  return {
    send(msg) {
      if (ws?.readyState === 1) ws.send(JSON.stringify(msg))
    },
  }
}

/** Findet einen Eintrag per ID, Name oder 1-basierter Nummer (wie auf dem Server). */
export function findByRef(list, ref) {
  const r = String(ref).trim()
  const byId = list.find((x) => x.id === r)
  if (byId) return byId
  const byName = list.find((x) => String(x.name).toLowerCase() === r.toLowerCase())
  if (byName) return byName
  const n = Number(r)
  return Number.isInteger(n) && n >= 1 ? list[n - 1] : undefined
}

export function hasAtemInput(source) {
  return source && source.atemInput !== '' && source.atemInput != null && !Number.isNaN(Number(source.atemInput))
}

export function sourceLabel(source, atem) {
  if (!source) return ''
  const input = hasAtemInput(source) ? atem.inputs?.[source.atemInput] : null
  if (source.useAtemName && input) return input.longName || input.shortName || source.name
  return source.name
}

/**
 * Welcher ATEM-Pegel zu einer Quelle gehört: Eingänge haben ihren eigenen Pegel,
 * Ausgänge des Mischers (Clean Feed 7001+, Aux 8001+, Programm 10010/10020 …)
 * führen den Program-Ton, also die Summe.
 */
export function meterKeyFor(source) {
  if (!hasAtemInput(source)) return null
  const n = Number(source.atemInput)
  const isMixerOutput = (n >= 7001 && n <= 8999) || (n >= 10000 && n % 10 === 0)
  return isMixerOutput ? 'master' : n
}

/**
 * Die Pegel eines Pegel-Fensters: [{ input: 'master' | Zahl, label }].
 * Ältere Audio-Kacheln hatten nur einen Pegel (audioInput) – die werden hier übernommen.
 */
export function tileChannels(tile) {
  if (Array.isArray(tile.channels)) return tile.channels
  return [{ input: tile.audioInput ?? 'master', label: tile.label || '' }]
}

/** Anzeigename eines Pegels im Pegel-Fenster (kurz, damit er unter den Balken passt). */
export function channelName(channel, atem) {
  if (channel.label) return channel.label
  return channel.input === 'master' || channel.input == null ? 'Summe' : audioInputName(channel.input, atem)
}

/** Name eines ATEM-Audioeingangs ('master' = Summe). */
export function audioInputName(id, atem) {
  if (id === 'master' || id == null || id === '') return 'Summe (Program)'
  const input = atem.inputs?.[id]
  if (input) return input.longName || input.shortName
  return `Audio-Eingang ${id}`
}

/** 'program' | 'preview' | null */
export function tallyOf(source, atem) {
  if (!hasAtemInput(source)) return null
  const n = Number(source.atemInput)
  if (atem.program?.includes(n)) return 'program'
  if (atem.preview?.includes(n)) return 'preview'
  return null
}

/** Positioniert ein Element anhand der Rasterkoordinaten einer Kachel. */
export function applyBox(el, tile, layout) {
  el.style.left = `${(tile.x / layout.cols) * 100}%`
  el.style.top = `${(tile.y / layout.rows) * 100}%`
  el.style.width = `${(tile.w / layout.cols) * 100}%`
  el.style.height = `${(tile.h / layout.rows) * 100}%`
}

/** Nächstes Element, das sich per Wischen scrollen lässt (oder null). */
function scrollableParent(node) {
  for (let el = node instanceof Element ? node : node?.parentElement; el && el !== document.body; el = el.parentElement) {
    const style = getComputedStyle(el)
    const y = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1
    const x = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 1
    if (x || y) return el
  }
  return null
}

/**
 * Scrollen per Finger selbst übernehmen (Folienliste, Chat …), die Seite selbst bewegt sich nie.
 * Safari auf dem iPad verkleinert das Vollbild, sobald es eine Wischgeste nach unten sieht –
 * auch mitten in einer scrollbaren Liste. Darum bekommt Safari gar keine Wischgeste mehr
 * (jedes touchmove wird abgefangen) und wir scrollen den Bereich selbst, mit Schwung.
 * Vollbild beenden geht dann nur noch über das X bzw. die Vollbild-Taste.
 */
export function keepTouchScrollInside() {
  let el = null
  let lastX = 0
  let lastY = 0
  let lastT = 0
  let vx = 0
  let vy = 0
  let glide = 0
  let startX = 0
  let startY = 0
  let moving = false

  const stopGlide = () => cancelAnimationFrame(glide)

  document.addEventListener(
    'touchstart',
    (e) => {
      stopGlide()
      if (e.touches.length > 1) return (el = null)
      const t = e.touches[0]
      el = scrollableParent(e.target)
      lastX = startX = t.clientX
      lastY = startY = t.clientY
      lastT = performance.now()
      vx = vy = 0
      moving = false
    },
    { passive: true },
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      if (e.touches.length > 1) return // Zwei Finger: Zoomen nicht verhindern
      const t = e.touches[0]
      // Kleines Wackeln beim Antippen bleibt ein Tippen (Safari wertet das noch nicht als Wischen)
      if (!moving && Math.hypot(t.clientX - startX, t.clientY - startY) < 6) return
      moving = true
      e.preventDefault()
      if (!el) return
      const now = performance.now()
      const dx = lastX - t.clientX
      const dy = lastY - t.clientY
      el.scrollLeft += dx
      el.scrollTop += dy
      const dt = Math.max(now - lastT, 1)
      vx = 0.8 * (dx / dt) + 0.2 * vx // Pixel pro Millisekunde, leicht geglättet
      vy = 0.8 * (dy / dt) + 0.2 * vy
      lastX = t.clientX
      lastY = t.clientY
      lastT = now
    },
    { passive: false },
  )
  document.addEventListener('touchend', () => {
    const target = el
    if (!target || !moving || performance.now() - lastT > 80) return // Finger lag still: kein Schwung
    let prev = performance.now()
    const step = (now) => {
      const dt = now - prev
      prev = now
      target.scrollLeft += vx * dt
      target.scrollTop += vy * dt
      const decay = Math.pow(0.995, dt)
      vx *= decay
      vy *= decay
      if (Math.abs(vx) > 0.02 || Math.abs(vy) > 0.02) glide = requestAnimationFrame(step)
    }
    glide = requestAnimationFrame(step)
  })
}

/** Standardfarbe der Trennlinien zwischen den Kacheln (wie beim ATEM-Multiview). */
export const LINE_COLOR = '#8e8e93'

/** Standardstärke der Trennlinien in Pixeln (auf dem Monitor). */
export const LINE_WIDTH = 4

/**
 * Rahmen zwischen den Kacheln: mit Trennlinien ist der Spalt selbst die Linie (wie beim ATEM),
 * jede Kachel trägt die halbe Stärke, außen herum kommt ein Rahmen in voller Stärke dazu.
 * Ohne Trennlinien: der eingestellte Abstand in der Hintergrundfarbe.
 */
export function layoutBorder(layout) {
  if (layout?.lines === false)
    return { width: (Number(layout?.gap ?? 4) || 0) / 2, color: layout?.background || '#000', frame: 0 }
  const width = Math.min(Math.max(Number(layout?.lineWidth) || LINE_WIDTH, 1), 16)
  return { width: width / 2, color: layout?.lineColor || LINE_COLOR, frame: width / 2 }
}

/** Rahmen-Variablen an ein Element (Bühne, Kesher-Ebene, Editor-Fläche) hängen. */
export function applyLayoutBorder(el, layout) {
  const b = layoutBorder(layout)
  el.style.setProperty('--tile-bw', `${b.width}px`)
  el.style.setProperty('--tile-bc', b.color)
  el.style.setProperty('--frame-bw', `${b.frame}px`)
}
