'use strict'

// Kesher-Chat: Der Server meldet sich einmal als Anzeige-Rolle bei Kesher an und
// verteilt die Nachrichten an alle Multiview-Seiten. So sieht jeder Monitor und
// jede Vorschau denselben Chat, ohne dass sich die Ansichten gegenseitig die
// Rolle wegnehmen.

const WebSocket = require('ws')

const MAX_MESSAGES = 120
const FLASH_MAX_AGE_MS = 15 * 1000 // ältere Nachrichten (History) blinken nicht
const RETRY_MS = 3000
const REVOKED_RETRY_MS = 60 * 1000 // Rolle wurde übernommen: nicht sofort zurückholen
// Kesher meldet neue oder umbenannte Rollen nicht von selbst (nur Änderungen an Party Lines):
// darum Rollen und Linien regelmäßig neu holen
const BOOTSTRAP_REFRESH_MS = 30 * 1000

function createKesherChat({ getConfig, onUpdate, onFlash, log = console.log }) {
  let ws = null
  let token = null
  let session = null // { url, username, roleId }
  let bootstrap = null
  let messages = [] // neueste zuerst
  let seen = new Set()
  let state = 'offline' // 'connecting' | 'connected' | 'reconnecting' | 'offline'
  let error = ''
  let retryTimer = null
  let stopped = false

  const settings = () => {
    const c = getConfig() || {}
    return { url: c.url, username: c.username, roleId: c.roleId }
  }

  function snapshot() {
    const roleName =
      bootstrap?.roles?.find((r) => r.id === bootstrap?.self?.roleId)?.name || bootstrap?.self?.username || ''
    return {
      type: 'chat',
      state,
      error,
      stationName: roleName,
      // Für die Auswahl der Rolle in der Kesher-Intercom-Kachel
      roles: (bootstrap?.roles ?? []).map((r) => ({ id: r.id, name: r.name || r.id })),
      // Party Lines mit ihren Hörern – zeigt im Multiview, was eine Rolle in Kesher hört
      rooms: (bootstrap?.rooms ?? []).map((r) => ({
        id: r.id,
        name: r.name || r.id,
        listeners: [...new Set([...(r.receiverRoleIds ?? []), ...(r.forcedListenRoleIds ?? [])])],
        talkers: r.senderRoleIds ?? [], // wer dort schreiben/sprechen darf
      })),
      // audience: Rollen, die die Nachricht in Kesher sehen (null = alle) – für den Chat pro Nutzer
      messages: messages.slice(0, 60).map((m) => ({ ...m, audience: audienceOf(m) })),
    }
  }

  function publish() {
    onUpdate(snapshot())
  }

  /** Wer hört auf einer Party Line mit (Empfänger und Zwangs-Mithörer)? */
  function roomListeners(roomId) {
    const room = bootstrap?.rooms?.find((r) => r.id === roomId)
    return room ? [...(room.receiverRoleIds ?? []), ...(room.forcedListenRoleIds ?? [])] : []
  }

  /**
   * Rollen, die eine Nachricht in Kesher sehen – nach den Rechten aus Kesher:
   * Party Line = wer auf ihr empfängt, Broadcast = wer auf einer ihrer Linien empfängt,
   * Global (und Direktnachrichten an den Chat-Monitor) = alle. Der Absender sieht sie immer.
   */
  function audienceOf(m) {
    let roles = null
    if (m.scope === 'room') roles = roomListeners(m.targetId)
    else if (m.scope === 'broadcast') {
      const group = bootstrap?.broadcastGroups?.find((g) => g.id === m.targetId)
      roles = (group?.roomIds ?? []).flatMap(roomListeners)
    }
    if (!roles) return null
    return [...new Set([...roles, m.fromRoleId].filter(Boolean))]
  }

  function setState(next, message = '') {
    if (state === next && error === message) return
    state = next
    error = message
    publish()
  }

  function schedule(ms) {
    clearTimeout(retryTimer)
    if (!stopped) retryTimer = setTimeout(connect, ms)
  }

  async function api(path, options = {}) {
    const res = await fetch(`${session.url}${path}`, { ...options, signal: AbortSignal.timeout(5000) })
    return res
  }

  async function login() {
    const body = JSON.stringify({ username: session.username, roleId: session.roleId })
    const headers = { 'Content-Type': 'application/json' }
    let res = await api('/api/login', { method: 'POST', headers, body })
    if (res.status === 409) {
      // Rolle ist noch aktiv (z. B. alte Sitzung nach einem Neustart): übernehmen
      res = await api('/api/login/takeover', { method: 'POST', headers, body })
    }
    if (!res.ok) throw new Error(`Anmeldung fehlgeschlagen (HTTP ${res.status}): ${(await res.text()).trim()}`)
    token = (await res.json()).token
  }

  async function loadBootstrap() {
    const res = await api('/api/bootstrap', { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 401 || res.status === 403) {
      token = null
      throw new Error('Sitzung abgelaufen')
    }
    if (!res.ok) throw new Error(`Bootstrap fehlgeschlagen (HTTP ${res.status})`)
    bootstrap = await res.json()
  }

  /** Alle Party Lines, auf denen die Rolle empfangen darf (wie die Kesher-Chat-Anzeige). */
  function listenRoomIds() {
    const roleId = bootstrap?.self?.roleId
    return (bootstrap?.rooms ?? [])
      .filter((room) => Array.isArray(room.receiverRoleIds) && room.receiverRoleIds.includes(roleId))
      .map((room) => room.id)
  }

  function sendRoomMatrix() {
    if (ws?.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify({ type: 'set_room_matrix', data: { listenRoomIds: listenRoomIds(), talkRoomIds: [] } }))
  }

  function targetLabel(e) {
    if (e.scope === 'global') return 'Global'
    if (e.scope === 'direct') return 'Direkt'
    if (e.scope === 'room') return bootstrap?.rooms?.find((r) => r.id === e.targetId)?.name || e.targetId
    if (e.scope === 'broadcast') return bootstrap?.broadcastGroups?.find((g) => g.id === e.targetId)?.name || e.targetId
    return e.targetId || ''
  }

  function roleName(roleId) {
    return roleId ? bootstrap?.roles?.find((r) => r.id === roleId)?.name || roleId : ''
  }

  function onChat(e) {
    const body = String(e.body ?? '').trim()
    if (!body) return
    const selfId = bootstrap?.self?.id
    const isSelf = e.fromUser?.id === selfId
    // Gleiche Regel wie die Kesher-Anzeige: Party-Line-Nachrichten nur von empfangenen Linien
    if (!isSelf && e.scope === 'room' && !listenRoomIds().includes(e.targetId)) return
    const key = e.messageId
      ? `id:${e.messageId}`
      : `fb:${e.timestamp}|${e.fromUser?.id}|${e.scope}|${e.targetId}|${body}`
    if (seen.has(key)) return
    seen.add(key)
    const entry = {
      key,
      messageId: e.messageId || null,
      from: e.fromUser?.username || '',
      fromRole: roleName(e.fromUser?.roleId),
      fromRoleId: e.fromUser?.roleId || '',
      scope: e.scope,
      targetId: e.targetId || '',
      target: targetLabel(e),
      source: e.source || '',
      body,
      timestamp: e.timestamp || Date.now(),
      ackRequired: Boolean(e.ackRequired),
      acked: Boolean(e.acked),
      receivedAt: Date.now(),
    }
    messages = [entry, ...messages].sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_MESSAGES)
    publish()

    // Jede neue Nachricht blinkt wie ein Anruf (nicht bei History oder eigener Nachricht)
    if (!isSelf && Date.now() - entry.timestamp <= FLASH_MAX_AGE_MS) {
      onFlash({ type: 'chatFlash', audience: audienceOf(entry) })
    }
  }

  function onAck(a) {
    let changed = false
    messages = messages.map((m) => {
      if (!a?.messageId || m.messageId !== a.messageId || m.acked) return m
      changed = true
      return { ...m, acked: true }
    })
    if (changed) publish()
  }

  function clearHistory() {
    messages = []
    seen = new Set()
    publish()
  }

  async function connect() {
    clearTimeout(retryTimer)
    if (stopped) return
    const next = settings()
    if (!next.url || !next.username || !next.roleId) {
      setState('offline', 'Kesher-Chat nicht eingerichtet')
      return
    }
    // Andere Adresse oder Rolle: neu anmelden
    if (!session || session.url !== next.url || session.username !== next.username || session.roleId !== next.roleId) {
      session = next
      token = null
      clearHistory()
    }
    setState(state === 'connected' || state === 'reconnecting' ? 'reconnecting' : 'connecting', error)
    try {
      if (!token) await login()
      try {
        await loadBootstrap()
      } catch (err) {
        if (token) throw err
        await login() // Sitzung war abgelaufen
        await loadBootstrap()
      }
    } catch (err) {
      setState(messages.length ? 'reconnecting' : 'offline', err.message)
      schedule(RETRY_MS)
      return
    }

    const wsUrl = new URL('/ws', session.url)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    wsUrl.searchParams.set('token', token)
    // "native": kein WebRTC-Audio für diese reine Anzeige
    wsUrl.searchParams.set('transport', 'native')
    const socket = new WebSocket(wsUrl)
    ws = socket
    let revoked = false

    socket.on('open', () => {
      sendRoomMatrix()
      setState('connected')
      log(`Kesher-Chat: verbunden als ${session.username} (${session.roleId})`)
    })
    socket.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw)
      } catch {
        return
      }
      if (msg.type === 'chat') onChat(msg.data || {})
      else if (msg.type === 'chat_ack') onAck(msg.data)
      else if (msg.type === 'chat_history_cleared') clearHistory()
      else if (msg.type === 'session_revoked') {
        revoked = true
        token = null
        log(`Kesher-Chat: Sitzung beendet (${msg.data?.reason || 'unbekannt'})`)
      } else if (msg.type === 'config_updated') {
        // Party Lines oder Rollen geändert: neu laden und Empfang anpassen
        loadBootstrap()
          .then(() => {
            sendRoomMatrix()
            publish()
          })
          .catch(() => {})
      }
    })
    socket.on('error', (err) => {
      error = err.message
    })
    socket.on('close', () => {
      if (ws !== socket) return
      ws = null
      if (stopped) return
      setState('reconnecting', revoked ? 'Rolle wurde von einem anderen Gerät übernommen' : error || 'Verbindung getrennt')
      schedule(revoked ? REVOKED_RETRY_MS : RETRY_MS)
    })
  }

  /** Rollen und Party Lines nachladen; nur bei einer Änderung an alle verteilen. */
  const shape = () => JSON.stringify([bootstrap?.roles, bootstrap?.rooms, bootstrap?.broadcastGroups])
  setInterval(() => {
    if (stopped || !token || state !== 'connected') return
    const before = shape()
    loadBootstrap()
      .then(() => {
        if (shape() === before) return
        log('Kesher-Chat: Rollen oder Party Lines geändert – übernommen')
        sendRoomMatrix()
        publish()
      })
      .catch(() => {})
  }, BOOTSTRAP_REFRESH_MS).unref?.()

  /** Rollen und Party Lines sofort neu holen (nach einer Änderung aus dem Multiview). */
  async function refresh() {
    if (stopped || !token) return
    await loadBootstrap()
    sendRoomMatrix()
    publish()
  }

  /** Nach einer Änderung der Einstellungen aufrufen. */
  function reconfigure() {
    const next = settings()
    if (session && session.url === next.url && session.username === next.username && session.roleId === next.roleId) return
    const old = ws
    ws = null
    old?.terminate()
    connect()
  }

  function stop() {
    stopped = true
    clearTimeout(retryTimer)
    ws?.close()
    if (token && session) {
      // Rolle sofort freigeben
      fetch(`${session.url}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1500),
      }).catch(() => {})
    }
  }

  /**
   * Prüft eine Admin-PIN bei Kesher (dieselbe PIN wie im Kesher-Admin). Die dabei
   * entstehende Kesher-Admin-Sitzung wird sofort wieder beendet.
   */
  async function verifyAdminPin(pin) {
    const url = settings().url
    if (!url) throw new Error('Kesher-Adresse fehlt (Einstellungen → Kesher-Chat)')
    let res
    try {
      res = await fetch(`${url}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: String(pin ?? '') }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      throw new Error('Kesher ist nicht erreichbar – die PIN kann gerade nicht geprüft werden')
    }
    if (res.status === 403) return false
    if (!res.ok) throw new Error(`Kesher antwortet mit HTTP ${res.status}`)
    const adminToken = (await res.json().catch(() => ({})))?.token
    if (adminToken) {
      fetch(`${url}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
        signal: AbortSignal.timeout(3000),
      }).catch(() => {})
    }
    return true
  }

  /**
   * Freien Chat-Text als Rolle schicken (Kesher-Schnittstelle /api/companion/chat-text,
   * nur vom Server selbst erreichbar). Ist die Rolle an einer Station online, erscheint
   * die Nachricht von dieser Station, sonst von der Rolle. roomId leer = global.
   */
  /** alert: wichtige Meldung (Kesher und Multiview zeigen sie rot). */
  async function sendText({ roleId, username, message, roomId, alert = false }) {
    const url = settings().url
    if (!url) throw new Error('Kesher-Adresse fehlt (Einstellungen → Kesher-Chat)')
    let res
    try {
      res = await fetch(`${url}/api/companion/chat-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId, username, message, roomId: roomId || '', ...(alert ? { alert: true } : {}) }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      throw new Error('Kesher ist nicht erreichbar')
    }
    if (res.ok) return
    const text = (await res.text().catch(() => '')).trim()
    if (res.status === 404 && /page not found/i.test(text)) throw new Error('Kesher kennt das Schreiben noch nicht – Kesher muss aktualisiert werden')
    if (res.status === 403 && /room/.test(text)) throw new Error('Deine Rolle darf auf dieser Party Line nicht schreiben')
    if (res.status === 404) throw new Error('Rolle in Kesher nicht gefunden')
    throw new Error(`Kesher: ${text || `HTTP ${res.status}`}`)
  }

  return { start: connect, reconfigure, refresh, stop, snapshot, verifyAdminPin, sendText }
}

module.exports = { createKesherChat }
