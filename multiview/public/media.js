import { berlinParts } from './common.js'
// Videoquellen für die Webseite und die Monitor-Ansicht:
// Capture-Geräte (DeckLink, USB-Grabber, ATEM-USB), Netzwerk-Streams (WebRTC über MediaMTX) und Testbilder.

// Geteilte Streams: Schlüssel -> Promise<{ stream, close, ended } | null>
// Schlüssel: "dev:<Gerätename>" oder "net:<Quellen-ID>"
const streams = new Map()
let permission = null

export function mediaAvailable() {
  return Boolean(navigator.mediaDevices?.getUserMedia)
}

/** Einmalige Freigabe, damit der Browser die Gerätenamen verrät. */
export function ensurePermission() {
  if (!mediaAvailable()) {
    return Promise.reject(new Error('Videozugriff nur über http://localhost oder HTTPS möglich'))
  }
  permission ??= navigator.mediaDevices
    .getUserMedia({ video: true, audio: false })
    .then((s) => s.getTracks().forEach((t) => t.stop()))
    .catch((err) => {
      permission = null
      throw err
    })
  return permission
}

/** Ist die Kamera-Freigabe schon erteilt? (dann kann ohne Rückfrage gesucht werden) */
export async function permissionGranted() {
  try {
    const status = await navigator.permissions.query({ name: 'camera' })
    return status.state === 'granted'
  } catch {
    return false
  }
}

/** Liste der Videoeingänge an diesem Rechner. */
export async function listVideoDevices({ ask = true } = {}) {
  if (ask) await ensurePermission()
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'videoinput' && d.label)
}

/** Schlüssel, unter dem der Stream einer Quelle geteilt wird (null bei Testbild/URL). */
export function mediaKey(source) {
  if (source?.type === 'device') return `dev:${source.device}`
  if (source?.type === 'stream') return `net:${source.id}`
  return null
}

function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}

// ---------------------------------------------------------------------------
// Öffnen der Quellen
// ---------------------------------------------------------------------------

async function openDevice(label) {
  if (!label) return null
  await ensurePermission()
  const devices = await listVideoDevices({ ask: false })
  const device = devices.find((d) => d.label === label) || devices.find((d) => d.label.includes(label))
  if (!device) return null
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { deviceId: { exact: device.deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } },
  })
  const ended = deferred()
  stream.getVideoTracks()[0]?.addEventListener('ended', ended.resolve)
  return {
    stream,
    ended: ended.promise,
    close() {
      stream.getTracks().forEach((t) => t.stop())
      ended.resolve()
    },
  }
}

/** Empfängt einen Netzwerk-Stream per WebRTC (WHEP) über den Multiview-Server. */
async function openNetworkStream(id) {
  const pc = new RTCPeerConnection()
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })

  const stream = new MediaStream()
  const gotVideo = deferred()
  pc.ontrack = (e) => {
    stream.addTrack(e.track)
    if (e.track.kind === 'video') gotVideo.resolve(true)
  }

  const ended = deferred()
  const close = () => {
    pc.close()
    ended.resolve()
  }
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close()
  })

  try {
    await pc.setLocalDescription(await pc.createOffer())
    await iceGatheringComplete(pc, 2000)
    const res = await fetch(`/whep/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    })
    // 404 = Stream ist (noch) nicht da – später erneut versuchen
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() })
    const ok = await Promise.race([gotVideo.promise, new Promise((r) => setTimeout(() => r(false), 10000))])
    if (!ok) throw new Error('Kein Videobild empfangen')
  } catch (err) {
    close()
    throw err
  }
  return { stream, ended: ended.promise, close }
}

function iceGatheringComplete(pc, timeout) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }
    const check = () => pc.iceGatheringState === 'complete' && done()
    pc.addEventListener('icegatheringstatechange', check)
    setTimeout(done, timeout)
  })
}

// ---------------------------------------------------------------------------
// Geteilte Streams
// ---------------------------------------------------------------------------

function acquire(key, opener) {
  let p = streams.get(key)
  if (!p) {
    p = opener().catch((err) => {
      console.warn(`${key}:`, err.message ?? err)
      return null
    })
    streams.set(key, p)
    p.then((handle) => {
      const forget = () => streams.get(key) === p && streams.delete(key)
      if (handle) handle.ended.then(forget)
      else forget()
    })
  }
  return p
}

/** Schließt alle Streams, deren Schlüssel nicht in `used` steht. */
export function releaseUnusedStreams(used = new Set()) {
  for (const [key, p] of streams) {
    if (used.has(key)) continue
    streams.delete(key)
    p.then((handle) => handle?.close())
  }
}

export function makeVideo() {
  const video = document.createElement('video')
  video.autoplay = true
  video.muted = true
  video.playsInline = true
  return video
}

/**
 * Hängt ein Live-Bild an `container`. Solange es fehlt, steht dort `hint`; es wird
 * regelmäßig neu versucht, auch wenn die Verbindung später abreißt.
 */
function attachShared(container, key, opener, hint) {
  const video = makeVideo()
  container.append(hint)
  let first = true
  const attempt = async () => {
    if (!first && !container.isConnected) return
    first = false
    const handle = await acquire(key, opener)
    if (!handle) {
      setTimeout(attempt, 5000)
      return
    }
    video.srcObject = handle.stream
    if (hint.isConnected) hint.replaceWith(video)
    handle.ended.then(() => {
      if (!video.isConnected) return
      video.srcObject = null
      video.replaceWith(hint)
      setTimeout(attempt, 2000)
    })
  }
  attempt()
  return video
}

export function attachDevice(container, label, hint) {
  return attachShared(container, `dev:${label}`, () => openDevice(label), hint)
}

export function attachNetworkStream(container, id, hint) {
  return attachShared(container, `net:${id}`, () => openNetworkStream(id), hint)
}

// ---------------------------------------------------------------------------
// Testbild
// ---------------------------------------------------------------------------

const BARS = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0']
const testCanvases = new Set()

function timecode(d) {
  const pad = (n) => String(n).padStart(2, '0')
  const frames = Math.floor((d.getMilliseconds() / 1000) * 25)
  const t = berlinParts(d)
  return `${t.hour}:${t.minute}:${t.second}:${pad(frames)}`
}

function drawTestPattern(canvas, now) {
  const ctx = canvas.getContext('2d')
  const { width: w, height: h } = canvas
  // Unten bleibt Platz für die Beschriftung der Kachel
  BARS.forEach((c, i) => {
    ctx.fillStyle = c
    ctx.fillRect(Math.floor((i * w) / 7), 0, Math.ceil(w / 7) + 1, h * 0.56)
  })
  ctx.fillStyle = '#111'
  ctx.fillRect(0, h * 0.56, w, h * 0.44)
  // Laufender Punkt zeigt, dass das Bild lebt
  ctx.fillStyle = '#fff'
  ctx.fillRect(((now.getTime() / 2000) % 1) * w, h * 0.56, 6, 6)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.font = `600 ${h * 0.09}px system-ui, sans-serif`
  ctx.fillText(canvas.dataset.name || '', w / 2, h * 0.64)
  ctx.font = `${h * 0.065}px ui-monospace, Menlo, monospace`
  ctx.fillStyle = '#bbb'
  ctx.fillText(timecode(now), w / 2, h * 0.73)
}

/** Erzeugt ein animiertes Testbild (läuft, solange es im Dokument hängt). */
export function makeTestPattern(name) {
  const canvas = document.createElement('canvas')
  canvas.width = 640
  canvas.height = 360
  canvas.dataset.name = name
  testCanvases.add(canvas)
  drawTestPattern(canvas, new Date())
  return canvas
}

setInterval(() => {
  const now = new Date()
  for (const c of testCanvases) {
    if (c.isConnected) drawTestPattern(c, now)
    else testCanvases.delete(c)
  }
}, 80)
