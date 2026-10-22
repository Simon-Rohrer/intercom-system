'use strict'

// YouTube Live für die Kachel „YouTube Live“, die Störungsmeldungen (jms-watch, Telegram) und die
// Zusammenfassung nach dem Gottesdienst. Mit dem API-Schlüssel (YouTube Data API v3) ist alles
// Öffentliche lesbar – läuft der Stream, geplanter Beginn, Zuschauer, Aufrufe, Likes und der
// Live-Chat. Ob der Encoder sendet, liefert die Monarch (monarch.js) bzw. der ATEM, wenn er selbst
// streamt.
//
// Optional die Google-Anmeldung (OAuth für Geräte, nur Leserecht): Dann findet JMS Control auch
// nicht gelistete und private Streams des Kanals und liest, wie YouTube den Stream empfängt
// („Stream-Zustand“ im Studio: gut/ok/schlecht, Hinweise wie „Bitrate zu niedrig“, Auflösung).
//
// Kontingent: 10 000 Einheiten am Tag. Eine Abfrage der Videos kostet 1, die Liste der Uploads 1,
// eine Seite Live-Chat 5. Ohne geplanten Stream wird alle 10 Minuten nachgesehen, ab 30 Minuten
// vor dem Beginn jede Minute, während des Streams alle 30 Sekunden (Chat alle 10 s, nur wenn eine
// Kachel ihn zeigt) – ein Sonntag braucht damit gut 3 000 Einheiten.

const fs = require('fs')
const path = require('path')

const API = 'https://www.googleapis.com/youtube/v3'
const OAUTH = 'https://oauth2.googleapis.com'
const SCOPE = 'https://www.googleapis.com/auth/youtube.readonly'
const TIMEOUT_MS = 8000
const IDLE_MS = 10 * 60 * 1000
const NEAR_MS = 60 * 1000
const LIVE_MS = 30 * 1000
const RETRY_MS = 60 * 1000
const QUOTA_RETRY_MS = 30 * 60 * 1000
const CHAT_MIN_MS = 10 * 1000
const CHAT_KEEP = 60
const NEAR_BEFORE_MS = 30 * 60 * 1000
const LATE_MS = 5 * 60 * 1000
const LATE_MAX_MS = 3 * 60 * 60 * 1000
const ENDED_SHOW_MS = 12 * 60 * 60 * 1000
const ATEM_GRACE_MS = 2 * 60 * 1000
const CACHE_WARN = 50
const END_GRACE_MS = 5 * 60 * 1000
const TICK_MS = 5000
const TIME_ZONE = 'Europe/Berlin'

const ATEM_STATES = { 1: 'idle', 2: 'connecting', 4: 'streaming', 32: 'stopping' }
const ATEM_LABELS = { off: 'nicht verbunden', nostream: 'ohne Streaming', idle: 'aus', connecting: 'verbindet', streaming: 'sendet', stopping: 'beendet' }

// Hinweise von YouTube zum Stream (liveStreams.status.healthStatus.configurationIssues[].type)
const ISSUE_TEXT = {
  bitrateLow: 'Bitrate zu niedrig',
  bitrateHigh: 'Bitrate zu hoch',
  videoBitrateMismatch: 'Bitrate passt nicht zur Auflösung',
  videoIngestionStarved: 'Bild kommt nicht schnell genug an (Upload zu langsam?)',
  videoIngestionFasterThanRealtime: 'Bild kommt schneller als in Echtzeit an',
  noVideoStream: 'Kein Bild im Stream',
  noAudioStream: 'Kein Ton im Stream',
  audioBitrateLow: 'Ton-Bitrate zu niedrig',
  audioBitrateHigh: 'Ton-Bitrate zu hoch',
  audioSampleRate: 'Abtastrate des Tons ungünstig',
  audioTooManyChannels: 'Zu viele Tonkanäle',
  frameRateHigh: 'Bildrate zu hoch',
  framerateMismatch: 'Bildrate passt nicht zur Einstellung',
  resolutionMismatch: 'Auflösung passt nicht zur Einstellung',
  videoResolutionSuboptimal: 'Auflösung ungünstig',
  videoResolutionUnsupported: 'Auflösung wird nicht unterstützt',
  gopSizeLong: 'Keyframe-Abstand zu lang',
  gopSizeOver: 'Keyframe-Abstand zu lang',
  gopSizeShort: 'Keyframe-Abstand zu kurz',
  openGop: 'Offene GOP – Keyframe-Einstellung prüfen',
  interlacedVideo: 'Bild ist interlaced (Halbbilder)',
  badContainer: 'Ungültiges Stream-Format',
  videoCodec: 'Video-Codec wird nicht unterstützt',
  audioCodec: 'Ton-Codec wird nicht unterstützt',
}

const OAUTH_ERRORS = {
  invalid_client: 'Client-ID oder Clientschlüssel falsch',
  unauthorized_client: 'Die Client-ID ist nicht vom Typ „Fernseher und Geräte mit begrenzter Eingabe“',
  access_denied: 'Anmeldung bei Google abgelehnt',
  expired_token: 'Der Code ist abgelaufen – bitte noch einmal anmelden',
  invalid_grant: 'Google-Anmeldung abgelaufen oder widerrufen – bitte neu anmelden',
  invalid_scope: 'Google erlaubt die YouTube-Berechtigung für diese Client-ID nicht',
}
const oauthText = (body) => OAUTH_ERRORS[body?.error] || body?.error_description || body?.error || 'Google-Anmeldung fehlgeschlagen'
const HEALTH_TEXT = { good: 'gut', ok: 'ok', bad: 'schlecht', noData: 'keine Daten' }

/** Kanal aus Eingabe: Kanal-ID, Link oder @Name */
function parseChannel(input) {
  const text = String(input ?? '').trim()
  const id = /(?:^|\/channel\/)(UC[\w-]{22})(?:[/?#]|$)/.exec(text)?.[1]
  if (id) return { id }
  const handle = /(?:^|youtube\.com\/|^@)@?([\w.-]{3,30})\/?$/i.exec(text.replace(/[?#].*$/, ''))?.[1]
  return handle ? { handle: `@${handle}` } : null
}

/** Video aus Eingabe: ID oder Link (watch?v=, youtu.be/, /live/) */
function parseVideo(input) {
  const text = String(input ?? '').trim()
  if (/^[\w-]{11}$/.test(text)) return text
  return /(?:[?&]v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/.exec(text)?.[1] ?? ''
}

function clock(ms) {
  return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE })
}

function duration(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return h ? `${h} Std. ${m} Min.` : `${m} Min.`
}

const count = (n) => Number(n || 0).toLocaleString('de-DE')
const time = (iso) => (iso ? Date.parse(iso) || null : null)

/** Fehlermeldung der Google-API verständlich machen */
function apiError(status, body) {
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || ''
  const message = body?.error?.message || ''
  if (/quotaExceeded|dailyLimitExceeded|rateLimitExceeded/i.test(reason))
    return { text: 'Tageskontingent der YouTube-API aufgebraucht – ab 9 Uhr wieder', quota: true }
  if (/keyInvalid/i.test(reason) || /API key not valid/i.test(message)) return { text: 'API-Schlüssel ungültig' }
  if (/accessNotConfigured|SERVICE_DISABLED/i.test(reason) || /has not been used|is disabled/i.test(message))
    return { text: 'YouTube Data API v3 ist für diesen API-Schlüssel nicht aktiviert' }
  if (/ipRefererBlocked|forbidden|API_KEY_.*BLOCKED/i.test(reason))
    return { text: 'API-Schlüssel ist eingeschränkt (Server-IP oder Referrer nicht erlaubt)' }
  if (/liveChatEnded|liveChatNotFound/i.test(reason)) return { text: 'Live-Chat beendet', chatEnded: true }
  if (/liveChatDisabled/i.test(reason)) return { text: 'Live-Chat ist bei diesem Stream aus', chatEnded: true }
  return { text: `YouTube antwortet mit Fehler ${status}${message ? `: ${message.slice(0, 120)}` : ''}` }
}

class YouTubeError extends Error {
  constructor(info, status) {
    super(info.text)
    this.status = status
    this.quota = Boolean(info.quota)
    this.chatEnded = Boolean(info.chatEnded)
  }
}

/** Video der API in unsere Form bringen; null bei normalen Videos (ohne Live-Daten) */
function toVideo(item) {
  const live = item?.liveStreamingDetails
  if (!item?.id || !live) return null
  const kind = item.snippet?.liveBroadcastContent
  const status = kind === 'live' ? 'live' : kind === 'upcoming' ? 'upcoming' : live.actualEndTime ? 'ended' : 'none'
  return {
    id: item.id,
    title: String(item.snippet?.title || ''),
    status,
    scheduledStart: time(live.scheduledStartTime),
    actualStart: time(live.actualStartTime),
    actualEnd: time(live.actualEndTime),
    viewers: live.concurrentViewers != null ? Number(live.concurrentViewers) : null,
    views: item.statistics?.viewCount != null ? Number(item.statistics.viewCount) : null,
    likes: item.statistics?.likeCount != null ? Number(item.statistics.likeCount) : null,
    liveChatId: live.activeLiveChatId || '',
    privacy: item.status?.privacyStatus || '',
  }
}

/** Welcher Stream gerade zählt: läuft, sonst der nächste geplante, sonst der zuletzt beendete. */
function pickVideo(videos, now) {
  const list = videos.filter(Boolean)
  const live = list.find((v) => v.status === 'live')
  if (live) return live
  const upcoming = list
    .filter((v) => v.status === 'upcoming' && v.scheduledStart && v.scheduledStart > now - LATE_MAX_MS)
    .sort((a, b) => a.scheduledStart - b.scheduledStart)[0]
  if (upcoming) return upcoming
  return list
    .filter((v) => v.status === 'ended' && v.actualEnd && v.actualEnd > now - ENDED_SHOW_MS)
    .sort((a, b) => b.actualEnd - a.actualEnd)[0] ?? null
}

/** Zustand des ATEM-Streamings (atem.state.streaming von atem-connection) */
// Ohne streaming-Zustand ist der ATEM ein Modell, das nicht selbst streamt (dann sendet z. B. ein Encoder).
function atemStreaming(connected, streaming) {
  if (!connected || !streaming) return { state: connected ? 'nostream' : 'off', bitrate: null, cache: null, error: false, duration: null }
  const d = streaming.duration
  return {
    state: ATEM_STATES[streaming.status?.state] ?? 'idle',
    bitrate: streaming.stats?.encodingBitrate ?? null,
    cache: streaming.stats?.cacheUsed ?? null,
    error: Boolean(streaming.status?.error) && streaming.status.error !== 0,
    duration: d ? ((d.hours * 60 + d.minutes) * 60 + d.seconds) * 1000 : null,
  }
}

/**
 * Was gerade nicht stimmt. level "error" = Ausfall (rot, Telegram), "warn" = Warnung.
 * atemUsed: Der ATEM hat in diesem Stream schon gesendet (dann muss er weiter senden).
 */
function findProblems({ state, error, video, atem, atemUsed, atemStreamingSince, encoder = { state: 'unconfigured' }, encoderUsed, encoderSince, health }, now) {
  const problems = []
  if (state === 'error' && error) problems.push({ level: 'warn', text: `YouTube nicht abfragbar: ${error}` })
  if (video?.status === 'upcoming' && video.scheduledStart && now - video.scheduledStart > LATE_MS && now - video.scheduledStart < LATE_MAX_MS)
    problems.push({ level: 'error', text: `Stream hat noch nicht begonnen (geplant ${clock(video.scheduledStart)})` })
  if (video?.status === 'live' && atemUsed) {
    if (atem.state === 'off') problems.push({ level: 'error', text: 'ATEM nicht erreichbar – sendet der Stream noch?' })
    else if (atem.state !== 'streaming') problems.push({ level: 'error', text: `ATEM sendet nicht mehr (${ATEM_LABELS[atem.state]})` })
  }
  if (atem.state === 'streaming' && atem.error) problems.push({ level: 'error', text: 'ATEM meldet einen Streaming-Fehler' })
  if (atem.state === 'streaming' && atem.cache != null && atem.cache >= CACHE_WARN)
    problems.push({ level: 'warn', text: `Upload zu langsam: ATEM-Puffer ${Math.round(atem.cache)} %` })
  if (atem.state === 'streaming' && atemStreamingSince && now - atemStreamingSince > ATEM_GRACE_MS && video && video.status !== 'live' && state === 'ok')
    problems.push({ level: 'warn', text: 'ATEM sendet, aber YouTube zeigt keinen laufenden Stream' })
  // Monarch (Encoder): sendet er nicht mehr, ist der Stream weg
  if (video?.status === 'live' && encoderUsed) {
    if (encoder.state === 'error' || encoder.state === 'connecting') problems.push({ level: 'error', text: 'Monarch nicht erreichbar – sendet der Stream noch?' })
    else if (encoder.state !== 'streaming') problems.push({ level: 'error', text: 'Monarch sendet nicht mehr' })
  }
  if (encoder.state === 'streaming' && encoder.input && !encoder.input.signal) problems.push({ level: 'error', text: 'Kein Bild am Eingang der Monarch' })
  if (encoder.state === 'streaming' && encoderSince && now - encoderSince > ATEM_GRACE_MS && video && video.status !== 'live' && state === 'ok')
    problems.push({ level: 'warn', text: 'Monarch sendet, aber YouTube zeigt keinen laufenden Stream' })
  // Wie YouTube den Stream empfängt (nur mit Google-Anmeldung)
  if (video?.status === 'live' && health) {
    if (health.stream && health.stream !== 'active') problems.push({ level: 'error', text: 'YouTube empfängt kein Signal' })
    else if (health.status === 'bad') problems.push({ level: 'error', text: 'YouTube: Empfang schlecht' })
    for (const issue of health.issues || [])
      if (issue.severity === 'error' || issue.severity === 'warning') problems.push({ level: issue.severity === 'error' ? 'error' : 'warn', text: `YouTube: ${issue.text}` })
  }
  return problems
}

function summaryText(session, video) {
  const end = session.end ?? Date.now()
  const lines = [`„${session.title}“`]
  lines.push(session.peak ? `Spitze ${count(session.peak)} Zuschauer (${clock(session.peakAt)})` : 'Keine Zuschauerzahl gemeldet')
  lines.push(`${duration(end - session.start)} live (${clock(session.start)}–${clock(end)})`)
  if (video?.views != null) lines.push(`${count(video.views)} Aufrufe bisher`)
  if (!session.issues.length) lines.push('Keine Störungen')
  else {
    lines.push(`${session.issues.length} Störung${session.issues.length > 1 ? 'en' : ''}:`)
    for (const issue of session.issues.slice(0, 6))
      lines.push(`– ${issue.text} (${clock(issue.from)}${issue.to ? `, ${duration(issue.to - issue.from)}` : ''})`)
  }
  return lines.join('\n')
}

function createYouTube({ dataDir, getAtem = () => ({ connected: false, streaming: null }), getEncoder = () => ({ state: 'unconfigured' }), wantChat = () => false, onUpdate = () => {}, log = () => {}, fetchImpl = fetch, now = Date.now }) {
  const secretFile = path.join(dataDir, 'youtube-secret.json')
  const stateFile = path.join(dataDir, 'youtube-state.json')

  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const writeJson = (file, value) => {
    fs.mkdirSync(dataDir, { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, file)
  }

  let secret = readJson(secretFile)
  const saved = readJson(stateFile) || {}
  let session = saved.session ?? null
  let lastSummary = saved.summary ?? null
  let state = secret?.apiKey && secret?.uploads ? 'connecting' : 'unconfigured'
  let error = ''
  let video = null
  let chat = []
  let chatError = ''
  let chatPage = ''
  let chatFor = ''
  let atem = atemStreaming(false, null)
  let atemStreamingSince = null
  let encoder = { state: 'unconfigured' }
  let encoderSince = null
  // Google-Anmeldung: laufende Anmeldung (Code), Zugriffstoken, Empfang bei YouTube
  const google = { pending: null, error: '', accessToken: '', expires: 0 }
  let googleTimer = null
  const streamIds = new Map() // Video-ID → ID des Streams (liveStreams), aus liveBroadcasts
  let health = null
  const signedIn = () => Boolean(secret?.google?.refreshToken)
  let problems = []
  let running = false
  let pollTimer = null
  let chatTimer = null
  let tickTimer = null
  let lastKey = ''
  // Erst nach der ersten erfolgreichen Abfrage über Beginn/Ende eines Streams entscheiden – sonst
  // gälte ein gespeicherter Stream nach einem Neustart sofort als beendet
  let polledOnce = false

  const persist = () => writeJson(stateFile, { session, summary: lastSummary })

  async function request(endpoint, params, token) {
    const query = new URLSearchParams(token ? params : { ...params, key: secret.apiKey })
    const headers = { Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }
    let res
    try {
      res = await fetchImpl(`${API}/${endpoint}?${query}`, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      throw new YouTubeError({ text: err.name === 'TimeoutError' ? 'YouTube antwortet nicht' : 'YouTube nicht erreichbar (Internet?)' }, 0)
    }
    const body = await res.json().catch(() => null)
    if (res.status === 401 && token) google.accessToken = ''
    if (!res.ok) throw new YouTubeError(apiError(res.status, body), res.status)
    return body || {}
  }

  const api = (endpoint, params) => request(endpoint, params)

  async function oauthPost(endpoint, params) {
    let res
    try {
      res = await fetchImpl(`${OAUTH}/${endpoint}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams(params).toString(),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch {
      throw new YouTubeError({ text: 'Google nicht erreichbar (Internet?)' }, 0)
    }
    return { ok: res.ok, status: res.status, body: (await res.json().catch(() => null)) || {} }
  }

  /** Gültiges Zugriffstoken (aus dem gespeicherten Refresh-Token) */
  async function accessToken() {
    if (google.accessToken && now() < google.expires) return google.accessToken
    const g = secret?.google
    if (!g?.refreshToken) throw new YouTubeError({ text: 'Nicht bei Google angemeldet' }, 401)
    const r = await oauthPost('token', { client_id: g.clientId, client_secret: g.clientSecret, refresh_token: g.refreshToken, grant_type: 'refresh_token' })
    if (!r.ok || !r.body.access_token) {
      const text = oauthText(r.body)
      // Widerrufen oder abgelaufen: Anmeldung verwerfen, sonst fragt jede Abfrage erneut
      if (r.body.error === 'invalid_grant' || r.body.error === 'invalid_client') {
        secret = { ...secret, google: { clientId: g.clientId, clientSecret: g.clientSecret } }
        writeJson(secretFile, secret)
        health = null
        log(`YouTube: ${text}`)
      }
      google.error = text
      throw new YouTubeError({ text }, r.status)
    }
    google.accessToken = r.body.access_token
    google.expires = now() + (Number(r.body.expires_in) || 3600) * 1000 - 60_000
    return google.accessToken
  }

  const authApi = async (endpoint, params) => request(endpoint, params, await accessToken())

  /** Mit Google-Anmeldung über das Konto (sieht auch nicht gelistete/private Videos), sonst mit dem Schlüssel */
  async function ytApi(endpoint, params) {
    if (signedIn()) {
      try {
        return await authApi(endpoint, params)
      } catch (err) {
        if (err.quota || err.status === 0) throw err
        google.error = err.message
      }
    }
    return api(endpoint, params)
  }

  async function fetchVideos(ids) {
    if (!ids.length) return []
    const data = await ytApi('videos', { part: 'snippet,liveStreamingDetails,statistics,status', id: ids.join(','), maxResults: '50' })
    return (data.items || []).map(toVideo)
  }

  /** Laufende und geplante Streams des angemeldeten Kanals – auch nicht gelistete und private */
  async function ownBroadcasts(ids) {
    if (!signedIn()) return
    try {
      for (const broadcastStatus of ['active', 'upcoming']) {
        const data = await authApi('liveBroadcasts', { part: 'id,contentDetails', broadcastStatus, broadcastType: 'all', maxResults: '10' })
        for (const b of data.items || []) {
          ids.add(b.id)
          streamIds.set(b.id, b.contentDetails?.boundStreamId || '')
        }
      }
      google.error = ''
    } catch (err) {
      if (err.quota) throw err
      google.error = err.message
    }
  }

  async function discover() {
    const ids = new Set()
    if (secret.videoId) ids.add(secret.videoId)
    await ownBroadcasts(ids)
    const list = await api('playlistItems', { part: 'contentDetails', playlistId: secret.uploads, maxResults: '8' })
    for (const item of list.items || []) if (item.contentDetails?.videoId) ids.add(item.contentDetails.videoId)
    return pickVideo(await fetchVideos([...ids]), now())
  }

  /** Wie YouTube den laufenden Stream empfängt (Stream-Zustand im Studio) */
  async function fetchHealth() {
    if (!signedIn() || video?.status !== 'live') {
      health = null
      return
    }
    try {
      if (!streamIds.has(video.id)) {
        const data = await authApi('liveBroadcasts', { part: 'contentDetails', id: video.id })
        streamIds.set(video.id, data.items?.[0]?.contentDetails?.boundStreamId || '')
      }
      const streamId = streamIds.get(video.id)
      if (!streamId) {
        health = null // nicht vom angemeldeten Kanal
        return
      }
      const data = await authApi('liveStreams', { part: 'status,cdn', id: streamId })
      const s = data.items?.[0]
      health = s
        ? {
            stream: s.status?.streamStatus || '',
            status: s.status?.healthStatus?.status || 'noData',
            issues: (s.status?.healthStatus?.configurationIssues || []).map((i) => ({
              type: String(i.type || ''),
              severity: String(i.severity || ''),
              text: ISSUE_TEXT[i.type] || String(i.reason || i.description || i.type || 'Hinweis'),
            })),
            resolution: String(s.cdn?.resolution || ''),
            frameRate: String(s.cdn?.frameRate || ''),
            at: now(),
          }
        : null
      google.error = ''
    } catch (err) {
      health = null
      google.error = err.message
    }
  }

  /** Stream-Sitzung für die Zusammenfassung mitführen */
  function trackSession() {
    if (!polledOnce) return
    const t = now()
    if (video?.status === 'live') {
      if (!session || session.videoId !== video.id) {
        if (session) finishSession(t)
        session = { videoId: video.id, title: video.title, start: video.actualStart || t, peak: 0, peakAt: null, atemUsed: false, issues: [], open: {} }
        log(`YouTube: Stream läuft – „${video.title}“`)
      }
      session.title = video.title
      if (video.viewers != null && video.viewers > session.peak) {
        session.peak = video.viewers
        session.peakAt = t
      }
      if (atem.state === 'streaming') session.atemUsed = true
      if (encoder.state === 'streaming') session.encoderUsed = true
    } else if (session && (!video || video.id !== session.videoId || video.status === 'ended' || video.status === 'none')) {
      finishSession(video?.id === session.videoId ? video.actualEnd || t : t)
    }
  }

  function finishSession(end) {
    // Normales Ende: Erst wird der ATEM gestoppt, YouTube beendet den Stream etwas später – was erst
    // in den letzten Minuten vor dem Ende auftrat, ist keine Störung
    for (const [text, from] of Object.entries(session.open)) if (end - from > END_GRACE_MS) session.issues.push({ text, from, to: end })
    session.open = {}
    session.end = end
    const final = video?.id === session.videoId ? video : null
    lastSummary = { id: `${session.videoId}:${end}`, at: end, title: session.title, text: summaryText(session, final) }
    log(`YouTube: Stream beendet – ${lastSummary.text.replace(/\n/g, ' · ')}`)
    session = null
    persist()
  }

  /** Probleme neu bestimmen; während eines Streams für die Zusammenfassung festhalten */
  function evaluate() {
    const t = now()
    const raw = getAtem()
    atem = atemStreaming(raw?.connected, raw?.streaming)
    if (atem.state === 'streaming') atemStreamingSince ??= t
    else atemStreamingSince = null
    encoder = getEncoder() || { state: 'unconfigured' }
    if (encoder.state === 'streaming') encoderSince ??= t
    else encoderSince = null
    trackSession()
    problems = findProblems({ state, error, video, atem, atemUsed: session?.atemUsed, atemStreamingSince, encoder, encoderUsed: session?.encoderUsed, encoderSince, health }, t)
    if (session) {
      const current = new Set(problems.filter((p) => p.level === 'error' || !p.text.startsWith('YouTube nicht abfragbar')).map((p) => p.text))
      let changed = false
      for (const text of current) if (!(text in session.open)) (session.open[text] = t), (changed = true)
      for (const [text, from] of Object.entries(session.open))
        if (!current.has(text)) {
          session.issues.push({ text, from, to: t })
          delete session.open[text]
          changed = true
        }
      if (changed) persist()
    }
    publish()
  }

  function snapshot() {
    return {
      type: 'youtube',
      state,
      error,
      channelTitle: secret?.channelTitle || '',
      video: video ? { ...video, liveChatId: undefined, chat: Boolean(video.liveChatId), peak: session?.videoId === video.id ? session.peak : null } : null,
      atem,
      encoder,
      health: video?.status === 'live' ? health : null,
      google: signedIn(),
      problems,
      chat,
      chatError,
      summary: lastSummary,
      at: now(),
    }
  }

  function publish(force = false) {
    const snap = snapshot()
    const key = JSON.stringify({ ...snap, at: 0 })
    if (!force && key === lastKey) return
    lastKey = key
    onUpdate(snap)
  }

  function schedulePoll(ms) {
    clearTimeout(pollTimer)
    if (running) pollTimer = setTimeout(poll, ms)
  }

  async function poll() {
    if (!secret?.apiKey || !secret?.uploads) {
      state = 'unconfigured'
      video = null
      evaluate()
      return
    }
    let next = IDLE_MS
    try {
      if (video?.status === 'live') {
        const [fresh] = await fetchVideos([video.id])
        video = fresh ?? null
        if (!video || video.status !== 'live') video = await discover()
      } else {
        video = await discover()
      }
      await fetchHealth()
      if (state !== 'ok') log(`YouTube: verbunden${secret.channelTitle ? ` (${secret.channelTitle})` : ''}`)
      state = 'ok'
      error = ''
      polledOnce = true
      const t = now()
      if (video?.status === 'live') next = LIVE_MS
      else if (video?.status === 'upcoming' && video.scheduledStart && video.scheduledStart - t < NEAR_BEFORE_MS) next = NEAR_MS
    } catch (err) {
      if (state !== 'error' || error !== err.message) log(`YouTube: ${err.message}`)
      state = 'error'
      error = err.message
      next = err.quota ? QUOTA_RETRY_MS : RETRY_MS
    }
    evaluate()
    syncChat()
    schedulePoll(next)
  }

  function syncChat() {
    const id = video?.status === 'live' && wantChat() ? video.liveChatId : ''
    if (id === chatFor) return
    clearTimeout(chatTimer)
    chatFor = id
    chatPage = ''
    chat = []
    chatError = ''
    if (id) pollChat()
    else publish()
  }

  async function pollChat() {
    const id = chatFor
    if (!id || !running) return
    let next = CHAT_MIN_MS
    try {
      const data = await ytApi('liveChat/messages', { liveChatId: id, part: 'snippet,authorDetails', maxResults: '200', ...(chatPage ? { pageToken: chatPage } : {}) })
      if (id !== chatFor) return
      chatPage = data.nextPageToken || chatPage
      next = Math.max(CHAT_MIN_MS, Number(data.pollingIntervalMillis) || 0)
      const fresh = (data.items || []).map((m) => ({
        id: m.id,
        at: time(m.snippet?.publishedAt),
        author: String(m.authorDetails?.displayName || ''),
        text: String(m.snippet?.displayMessage || ''),
        owner: Boolean(m.authorDetails?.isChatOwner),
        mod: Boolean(m.authorDetails?.isChatModerator),
        amount: m.snippet?.superChatDetails?.amountDisplayString || '',
      }))
      const known = new Set(chat.map((m) => m.id))
      chat = [...chat, ...fresh.filter((m) => !known.has(m.id))].slice(-CHAT_KEEP)
      chatError = ''
    } catch (err) {
      chatError = err.chatEnded ? err.message : err.status === 401 || err.status === 403 ? `Live-Chat nicht lesbar: ${err.message}` : err.message
      if (err.chatEnded) {
        publish()
        return
      }
      next = err.quota ? QUOTA_RETRY_MS : RETRY_MS
    }
    publish()
    if (id === chatFor && running) chatTimer = setTimeout(pollChat, next)
  }

  /** Einstellungen speichern: Kanal (und Schlüssel) prüfen, bevor sie gelten */
  async function configure({ apiKey, channel, video: videoInput }) {
    const key = String(apiKey ?? '').trim() || secret?.apiKey || ''
    if (!key) throw new Error('API-Schlüssel fehlt')
    if (!/^[\w-]{20,60}$/.test(key)) throw new Error('Das sieht nicht wie ein API-Schlüssel aus')
    const target = parseChannel(channel)
    if (!target) throw new Error('Kanal nicht erkannt – Kanal-Link, @Name oder Kanal-ID eintragen')
    const videoId = parseVideo(videoInput)
    if (String(videoInput ?? '').trim() && !videoId) throw new Error('Video-Link nicht erkannt')
    const previous = secret
    secret = { ...(secret || {}), apiKey: key }
    try {
      const data = await api('channels', { part: 'snippet,contentDetails', ...(target.id ? { id: target.id } : { forHandle: target.handle }) })
      const item = data.items?.[0]
      if (!item) throw new Error('Kanal bei YouTube nicht gefunden')
      secret = {
        apiKey: key,
        channel: String(channel).trim(),
        channelId: item.id,
        channelTitle: String(item.snippet?.title || ''),
        uploads: item.contentDetails?.relatedPlaylists?.uploads || '',
        video: String(videoInput ?? '').trim(),
        videoId,
        ...(previous?.google ? { google: previous.google } : {}),
      }
    } catch (err) {
      secret = previous
      throw err
    }
    writeJson(secretFile, secret)
    state = 'connecting'
    error = ''
    video = null
    publish(true)
    schedulePoll(0)
    return settings()
  }

  // --- Google-Anmeldung (OAuth für Geräte): JMS Control zeigt einen Code, den man auf
  // google.com/device eingibt. Danach bleibt ein Refresh-Token auf dem Server (youtube-secret.json).

  /** Anmeldung beginnen; Client-ID/-Schlüssel leer = die gespeicherten nehmen */
  async function googleStart({ clientId, clientSecret } = {}) {
    if (!secret?.apiKey) throw new Error('Zuerst API-Schlüssel und Kanal speichern')
    const id = String(clientId ?? '').trim() || secret.google?.clientId || ''
    const key = String(clientSecret ?? '').trim() || secret.google?.clientSecret || ''
    if (!/\.apps\.googleusercontent\.com$/.test(id)) throw new Error('Client-ID fehlt – sie endet auf .apps.googleusercontent.com')
    if (!key) throw new Error('Clientschlüssel fehlt')
    const r = await oauthPost('device/code', { client_id: id, scope: SCOPE })
    if (!r.ok || !r.body.device_code) throw new Error(oauthText(r.body))
    const keep = secret.google?.clientId === id ? secret.google : {}
    secret = { ...secret, google: { ...keep, clientId: id, clientSecret: key } }
    writeJson(secretFile, secret)
    google.pending = {
      deviceCode: r.body.device_code,
      userCode: String(r.body.user_code || ''),
      url: String(r.body.verification_url || r.body.verification_uri || 'https://www.google.com/device'),
      expiresAt: now() + (Number(r.body.expires_in) || 1800) * 1000,
      interval: Math.max(5, Number(r.body.interval) || 5),
    }
    google.error = ''
    scheduleGoogle()
    return settings()
  }

  function scheduleGoogle() {
    clearTimeout(googleTimer)
    if (google.pending) googleTimer = setTimeout(() => void googlePoll(), google.pending.interval * 1000)
  }

  /** Nachsehen, ob der Code auf google.com/device eingegeben und bestätigt wurde */
  async function googlePoll() {
    const p = google.pending
    if (!p || !secret?.google) return
    if (now() > p.expiresAt) {
      google.pending = null
      google.error = OAUTH_ERRORS.expired_token
      return
    }
    let r
    try {
      r = await oauthPost('token', { client_id: secret.google.clientId, client_secret: secret.google.clientSecret, device_code: p.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' })
    } catch {
      return scheduleGoogle()
    }
    if (google.pending !== p) return
    if (r.ok && r.body.access_token) {
      google.pending = null
      google.error = ''
      google.accessToken = r.body.access_token
      google.expires = now() + (Number(r.body.expires_in) || 3600) * 1000 - 60_000
      secret = { ...secret, google: { ...secret.google, refreshToken: r.body.refresh_token || secret.google.refreshToken || '' } }
      let account = { id: '', title: '' }
      try {
        const me = await authApi('channels', { part: 'snippet', mine: 'true' })
        account = { id: me.items?.[0]?.id || '', title: String(me.items?.[0]?.snippet?.title || '') }
      } catch (err) {
        google.error = err.message
      }
      secret = { ...secret, google: { ...secret.google, account } }
      writeJson(secretFile, secret)
      log(`YouTube: bei Google angemeldet${account.title ? ` (${account.title})` : ''}`)
      schedulePoll(0)
      return
    }
    if (r.body.error === 'authorization_pending') return scheduleGoogle()
    if (r.body.error === 'slow_down') {
      p.interval += 5
      return scheduleGoogle()
    }
    google.pending = null
    google.error = oauthText(r.body)
  }

  /** Abmelden: Token bei Google widerrufen; Client-ID und -Schlüssel bleiben für die nächste Anmeldung */
  async function googleLogout() {
    clearTimeout(googleTimer)
    google.pending = null
    google.error = ''
    const token = secret?.google?.refreshToken
    if (token) await oauthPost('revoke', { token }).catch(() => null)
    if (secret?.google) {
      secret = { ...secret, google: { clientId: secret.google.clientId, clientSecret: secret.google.clientSecret } }
      writeJson(secretFile, secret)
    }
    google.accessToken = ''
    health = null
    streamIds.clear()
    schedulePoll(0)
    return settings()
  }

  function disconnect() {
    try {
      fs.unlinkSync(secretFile)
    } catch {
      // gab es nicht
    }
    clearTimeout(googleTimer)
    google.pending = null
    google.accessToken = ''
    health = null
    secret = null
    state = 'unconfigured'
    error = ''
    video = null
    clearTimeout(pollTimer)
    syncChat()
    evaluate()
  }

  /** Für die Einstellungen (nur Admin) – ohne den Schlüssel selbst */
  function settings() {
    return {
      configured: Boolean(secret?.apiKey && secret?.uploads),
      keySet: Boolean(secret?.apiKey),
      channel: secret?.channel || '',
      channelTitle: secret?.channelTitle || '',
      channelId: secret?.channelId || '',
      video: secret?.video || '',
      state,
      error,
      google: {
        clientId: secret?.google?.clientId || '',
        clientSecretSet: Boolean(secret?.google?.clientSecret),
        signedIn: signedIn(),
        account: signedIn() ? secret.google.account || null : null,
        // Angemeldet mit einem anderen Kanal als dem eingetragenen?
        otherChannel: Boolean(signedIn() && secret.google.account?.id && secret.channelId && secret.google.account.id !== secret.channelId),
        pending: google.pending ? { userCode: google.pending.userCode, url: google.pending.url, expiresAt: google.pending.expiresAt } : null,
        error: google.error,
      },
    }
  }

  /** Für jms-watch (Telegram): Zustand, wichtigstes Problem und die letzte Zusammenfassung */
  function status() {
    const t = now()
    const top = problems.find((p) => p.level === 'error') || problems[0] || null
    let info = 'nicht eingerichtet'
    if (state === 'connecting') info = 'verbinde …'
    else if (state === 'error') info = error
    else if (video?.status === 'live')
      info = `LIVE seit ${clock(video.actualStart || t)}${video.viewers != null ? ` · ${count(video.viewers)} Zuschauer` : ''}${session?.peak ? ` · Spitze ${count(session.peak)}` : ''}`
    else if (video?.status === 'upcoming' && video.scheduledStart) info = `geplant ${new Date(video.scheduledStart).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone: TIME_ZONE })}`
    else if (video?.status === 'ended') info = `zuletzt beendet ${clock(video.actualEnd)}`
    else if (state === 'ok') info = 'kein Stream geplant'
    if (atem.state === 'streaming') info += ` · ATEM sendet${atem.bitrate ? ` ${(atem.bitrate / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mbit/s` : ''}`
    if (encoder.state === 'streaming') info += ` · Monarch sendet${encoder.input?.signal ? ` (${encoder.input.label})` : ''}`
    if (video?.status === 'live' && health) info += ` · YouTube-Empfang ${HEALTH_TEXT[health.status] || health.status}`
    return { configured: settings().configured, state, live: video?.status === 'live', info, problem: top, summary: lastSummary }
  }

  return {
    start() {
      if (running) return
      running = true
      tickTimer = setInterval(evaluate, TICK_MS)
      schedulePoll(0)
    },
    stop() {
      running = false
      clearTimeout(pollTimer)
      clearTimeout(chatTimer)
      clearInterval(tickTimer)
      clearTimeout(googleTimer)
    },
    /** Kacheln geändert (Chat an/aus) */
    layoutsChanged: () => syncChat(),
    configure,
    disconnect,
    googleStart,
    googleLogout,
    googlePoll,
    settings,
    status,
    snapshot,
    evaluate,
    poll,
  }
}

module.exports = { createYouTube, parseChannel, parseVideo, pickVideo, atemStreaming, findProblems }
