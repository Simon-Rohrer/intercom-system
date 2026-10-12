'use strict'

// Kesher-Chat: Der Server meldet sich einmal als Anzeige-Rolle bei Kesher an und
// verteilt die Nachrichten an alle Multiview-Seiten. So sieht jeder Monitor und
// jede Vorschau denselben Chat, ohne dass sich die Ansichten gegenseitig die
// Rolle wegnehmen.

const WebSocket = require('ws')

const MAX_MESSAGES = 120
const FLASH_MAX_AGE_MS = 15 * 1000 // ältere Stream-Deck-Nachrichten (History) blinken nicht
const RETRY_MS = 3000
const REVOKED_RETRY_MS = 60 * 1000 // Rolle wurde übernommen: nicht sofort zurückholen

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
      messages: messages.slice(0, 60),
    }
  }

  function publish() {
    onUpdate(snapshot())
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
      scope: e.scope,
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

    // Stream-Deck-Nachricht blinkt wie ein Anruf (nicht bei History oder eigener Nachricht)
    if (e.source === 'companion' && !isSelf && Date.now() - entry.timestamp <= FLASH_MAX_AGE_MS) {
      const sender = entry.fromRole && entry.fromRole !== entry.from ? `${entry.from} · ${entry.fromRole}` : entry.from
      onFlash({ type: 'chatFlash', title: `Stream Deck · ${entry.target}`, detail: `${sender}: ${body}`, key })
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

  return { start: connect, reconfigure, stop, snapshot }
}

module.exports = { createKesherChat }
