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

/**
 * Alle Uhren zeigen deutsche Zeit – auch auf Geräten, die auf UTC laufen (z. B. der Kiosk-Browser
 * am HDMI-Ausgang des Servers). Sommer-/Winterzeit rechnet der Browser selbst.
 */
export const TIME_ZONE = 'Europe/Berlin'

/** Bestandteile einer Uhrzeit in deutscher Zeit (für Timecode u. Ä.). */
export function berlinParts(date = new Date()) {
  const parts = {}
  for (const p of new Intl.DateTimeFormat('de-DE', {
    timeZone: TIME_ZONE, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date)) parts[p.type] = p.value
  return { hour: parts.hour === '24' ? '00' : parts.hour, minute: parts.minute, second: parts.second }
}

/** Hochformat-Layout (9:16, z. B. für einen hochkant gedrehten Monitor)? */
export const isPortrait = (layout) => layout?.orientation === 'portrait'

/** Grenzen für eigene Größen in Pixeln */
export const LAYOUT_MIN_PX = 100
export const LAYOUT_MAX_PX = 8192
const px = (v, fallback) => {
  const n = Math.round(Number(v))
  return Number.isFinite(n) && n > 0 ? Math.min(LAYOUT_MAX_PX, Math.max(LAYOUT_MIN_PX, n)) : fallback
}

/** Interne Größe einer Layout-Fläche – so groß wie der Monitor, auf dem es läuft. */
export function layoutSize(layout) {
  if (layout?.orientation === 'custom') return { width: px(layout.width, 1920), height: px(layout.height, 1080) }
  return isPortrait(layout) ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
}

/** Normales Querformat 1920×1080 (füllt den Bildschirm wie bisher)? */
export const isStandardLayout = (layout) => {
  const { width, height } = layoutSize(layout)
  return width === 1920 && height === 1080
}

/** Vorschau-Element auf die Größe des Layouts einstellen (für previewMetrics und CSS). */
export function setPreviewSize(el, layout) {
  const { width, height } = layoutSize(layout)
  const changed = el.dataset.w !== String(width) || el.dataset.h !== String(height)
  el.dataset.w = String(width)
  el.dataset.h = String(height)
  el.style.setProperty('--pw', `${width}px`)
  el.style.setProperty('--ph', `${height}px`)
  el.classList.toggle('portrait', height > width)
  return changed
}

/**
 * Vorschau in Monitorgröße verkleinern und mittig in die Karte setzen
 * (Karten bleiben im Raster gleich groß; Querformat 16:9 füllt sie ganz).
 */
export function previewMetrics(el) {
  const w = Number(el.dataset.w) || 1920
  const h = Number(el.dataset.h) || 1080
  const cw = el.clientWidth
  const ch = el.clientHeight || (cw * 9) / 16
  const scale = Math.min(cw / w, ch / h)
  return { scale, left: Math.max(0, (cw - w * scale) / 2), top: Math.max(0, (ch - h * scale) / 2) }
}

/** Kennung der Anmeldung aus /api/me – '' ohne Anmeldung. */
export const loginKey = (user) => (user && !user.open ? `${user.name}|${user.roleId}|${Boolean(user.admin)}|${user.sessionId}|${user.version}|${user.expiresAt}` : '')

/**
 * An- und Abmeldung gelten für alle Dienste (dasselbe Cookie auf allen Ports). Meldet man sich
 * in Kesher, im Dashboard oder in einem anderen Tab an oder ab, merkt diese Seite das beim
 * Zurückwechseln (und alle 15 s) und lädt neu – ohne dass man selbst neu laden muss.
 */
export function watchLogin(currentKey, { onChange = () => location.reload(), url = '/api/me' } = {}) {
  let busy = false
  const check = async () => {
    if (busy) return
    busy = true
    try {
      const me = await fetch(url, { cache: 'no-store', credentials: 'same-origin' }).then((r) => r.json())
      if (me?.access?.enabled && (loginKey(me.user) !== currentKey || (me.user && me.user.expiresAt <= Date.now()))) onChange(me)
    } catch {
      // Server gerade nicht erreichbar – beim nächsten Mal
    } finally {
      busy = false
    }
  }
  document.addEventListener('visibilitychange', check)
  window.addEventListener('focus', check)
  window.addEventListener('pageshow', (e) => e.persisted && check())
  setInterval(check, 5000)
}

/**
 * Neuen Stand laden – aber nicht mitten im Tippen: Ist gerade ein Eingabefeld aktiv,
 * wird neu geladen, sobald es verlassen wird.
 */
export function reloadWhenIdle() {
  const typing = () => {
    const a = document.activeElement
    return Boolean(a && (a.matches?.('input, textarea, select') || a.isContentEditable))
  }
  if (!typing()) return location.reload()
  const later = () => setTimeout(() => (typing() ? null : location.reload()), 300)
  document.addEventListener('focusout', later)
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

// ---------------------------------------------------------------------------
// Kesher-Intercom-Kachel: immer ein Spiegel der gewählten Rolle (Zweitgerät). Sie belegt die
// Rolle nie und nimmt weder Mikrofon noch Lautsprecher – das Headset hängt am echten Gerät der
// Rolle (Laptop, Handy). Die Kachel zeigt dessen Kanäle, und was man hier drückt, schaltet dort.
// ---------------------------------------------------------------------------
const isLoopback = (host) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host)

export function kesherBase(tile, config) {
  const own = String(tile.kesherUrl || '').trim()
  if (own) return own.replace(/\/+$/, '')
  const server = String(config?.chat?.url || 'http://127.0.0.1:8080').replace(/\/+$/, '')
  let host = ''
  try {
    host = new URL(server).hostname
  } catch {
    return server
  }
  // Kesher lauscht auf dem Server nur lokal: am Kiosk direkt, von anderen Rechnern über Caddy
  if (!isLoopback(host) || isLoopback(location.hostname)) return server
  return kesherPublicOrigin(location.hostname)
}

/**
 * Kesher über Caddy auf Port 8443 derselben Adresse wie JMS Control (IP oder Name). Gleiche Adresse
 * heißt: Der Browser schickt die Anmeldung von JMS Control mit (Cookies gelten für alle Ports einer
 * Adresse). Unter intercom.internal o. ä. wäre die Kachel eine fremde Seite ohne Anmeldung – dort
 * käme nur „Gerät freischalten“. Die Namen auf :8443 stehen im Caddyfile (Kesher/server-config).
 */
export function kesherPublicOrigin(hostname) {
  return `https://${hostname.includes(':') ? `[${hostname}]` : hostname}:8443`
}

/** Rolle und Name, mit denen die Kachel spiegelt – "@user": die angemeldete Person (person). */
function kesherIdentity(tile, person) {
  const asViewer = tile.kesherRoleId === '@user'
  return {
    roleId: asViewer ? (person?.roleId ?? '') : String(tile.kesherRoleId ?? ''),
    username: asViewer ? String(person?.name ?? '').trim() : String(tile.kesherUser ?? 'Multiview').trim() || 'Multiview',
  }
}

/** Adresse der Kesher-Seite für die Kachel, null ohne Rolle (dann zeigt die Kachel einen Hinweis). */
export function kesherTileUrl(tile, config, person) {
  const { roleId, username } = kesherIdentity(tile, person)
  if (!roleId || !username) return null
  // embed: Kesher passt sich dem Kachelfenster an (alle Kanäle sichtbar, nichts scrollt)
  const params = new URLSearchParams({ viewMode: tile.kesherView || 'station', embed: '1' })
  if (tile.kesherHideControls) params.set('controls', '0')
  params.set('autoLogin', '1')
  // Kesher erlaubt keine Leerzeichen im Namen – geschütztes Leerzeichen sieht gleich aus
  params.set('username', username.replace(/\s+/g, '\u00a0'))
  params.set('roleId', roleId)
  params.set('secondary', '1')
  return `${kesherBase(tile, config)}/?${params}`
}

/** Warum eine Kesher-Kachel nichts zeigt. */
export function kesherMissing(tile) {
  return tile.kesherRoleId === '@user' ? 'niemand mit Rolle angemeldet' : 'keine Rolle gewählt'
}

// ---------------------------------------------------------------------------
// QR-Codes: immer die IP-Adresse des Servers im LAN (https://192.168.0.230:8090), nie Namen wie
// jmscontrol.local – die lösen viele Handys nicht auf. Gilt für alle QR-Codes (Monitore, Editor,
// Handy-Fernsteuerung, Link für Ordner, Tagescode).
// ---------------------------------------------------------------------------
const JMS_CONTROL_PORT = 8090
const isIPv4 = (host) => /^\d{1,3}(\.\d{1,3}){3}$/.test(host)

function hostOf(url) {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

/**
 * addresses: IPv4-Adressen des Servers (vom Server gemeldet). startUrl: eigene Startadresse aus
 * „Anmeldung für alle Dienste“ – nur wenn sie selbst eine IP-Adresse ist, sonst gilt die LAN-IP.
 */
export function qrOrigin(addresses, startUrl = '') {
  const own = String(startUrl || '').trim().replace(/\/+$/, '')
  if (own && isIPv4(hostOf(own))) return own
  // Schon über die IP geöffnet (nicht 127.0.0.1 am Kiosk): genau diese Adresse
  if (isIPv4(location.hostname) && !location.hostname.startsWith('127.')) return location.origin
  const list = (addresses ?? []).filter(isIPv4)
  // Das LAN zuerst – nicht Docker (172.x), VPN (10.8.x) oder Tailscale (100.x)
  const address = list.find((a) => a.startsWith('192.168.')) ?? list.find((a) => !/^(172\.|10\.8\.|100\.)/.test(a))
  if (!address) return location.origin
  // Über einen Namen oder am Kiosk (127.0.0.1) geöffnet: JMS Control über Caddy auf der IP
  return `https://${address}:${JMS_CONTROL_PORT}`
}

/** Ist die eingetragene Startadresse ein Name statt einer IP (wird dann für QR-Codes nicht genutzt)? */
export function startUrlIsName(startUrl) {
  return Boolean(String(startUrl || '').trim()) && !isIPv4(hostOf(String(startUrl).trim()))
}
