'use strict'

const crypto = require('crypto')
const http = require('http')
const https = require('https')
const net = require('net')

const DEFAULT_ORIGINS = [
  ...['intercom.internal', 'kesher.internal', 'jmscontrol.internal', 'multiview.internal',
    'technik.internal', 'dashboard.internal', 'companion.internal', 'glances.internal',
    'portainer.internal', 'dns.internal', 'router.internal'].map((host) => `https://${host}`),
  ...[8090, 8443, 8000, 3000, 61208, 9443, 8250].map((port) => `https://192.168.0.230:${port}`),
  ...['intercom.jms.de', 'kesher.jms.de', 'intercom.local', 'kesher.local', 'multiview.jms.de', 'jmscontrol.local',
    'dashboard.jms.de', 'dashboard.local', 'technik.local', 'companion.jms.de', 'companion.local',
    'glances.jms.de', 'glances.local', 'portainer.jms.de', 'portainer.local', 'dns.jms.de', 'dns.local',
    'router.jms.de', 'router.local', '192.168.178.185'].map((host) => `https://${host}`),
]

function normalizeOrigin(value) {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null
    return parsed.origin
  } catch {
    return null
  }
}

function requestOrigin(req) {
  const peer = String(req.socket?.remoteAddress || '')
  const local = /^(127\.|::1$|::ffff:127\.)/.test(peer)
  const protocol = req.socket?.encrypted || (local && req.headers['x-forwarded-proto'] === 'https') ? 'https' : 'http'
  try { return new URL(`${protocol}://${req.headers.host}`).origin } catch { return null }
}

function sameOriginRequest(req) {
  const origin = req.headers.origin
  if (origin) return origin === requestOrigin(req)
  const site = req.headers['sec-fetch-site']
  if (site) return site === 'same-origin'
  return !req.headers.cookie
}

function machineRequest(req, trusted, user = null) {
  return Boolean(trusted && !user && sameOriginRequest(req))
}

function nativeMachineRequest(req, trusted, user = null) {
  return machineRequest(req, trusted, user) && !req.headers.origin && !req.headers['sec-fetch-site'] && !req.headers.cookie
}

function withoutOwnCookies(header) {
  return String(header || '').split(';').map((part) => part.trim()).filter((part) => part && !/^(mv_session|jms_device|jms_sso_[a-f0-9]+)=/.test(part)).join('; ')
}

function safePath(value, fallback = '/') {
  const valueText = String(value || '')
  return valueText.startsWith('/') && !/[\\\u0000-\u0020\u007f]/.test(valueText) && !valueText.startsWith('//') ? valueText : fallback
}

function verifySignedRequest(secret, action, body, now = Date.now()) {
  if (!secret || !body || !Number.isSafeInteger(body.issuedAt) || Math.abs(now - body.issuedAt) > 30_000) return false
  if (!/^[a-f0-9]{64}$/.test(body.signature || '')) return false
  if (action === 'verify-pin' && (typeof body.pin !== 'string' || body.pin.length > 128 || !net.isIP(body.sourceIp || ''))) return false
  const message = action === 'verify-pin' ? `kesher:verify-pin:${body.sourceIp}:${body.issuedAt}:${crypto.createHash('sha256').update(body.pin).digest('hex')}`
    : action === 'introspect' ? `kesher:introspect:${body.sessionId}:${body.issuedAt}`
    : action === 'machine' ? `kesher:machine:${body.deviceId}:${body.version}:${body.issuedAt}` : `kesher:${action}:${body.issuedAt}`
  if (action === 'introspect' && (typeof body.sessionId !== 'string' || !body.sessionId || body.sessionId.length > 128)) return false
  if (action === 'machine' && [body.deviceId, body.version].some((value) => typeof value !== 'string' || !value || value.length > 128)) return false
  const expected = crypto.createHmac('sha256', secret).update(message).digest()
  return crypto.timingSafeEqual(expected, Buffer.from(body.signature, 'hex'))
}

function createSsoHandlers({ access, centralOrigin, origins = DEFAULT_ORIGINS, ipOf, loginPath, now = Date.now }) {
  const allowed = new Set(origins.map(normalizeOrigin).filter(Boolean))
  const central = normalizeOrigin(centralOrigin)
  const flows = new Map()
  const isCentral = (req) => requestOrigin(req) === central
  const done = (value) => `${value}${value.includes('?') ? '&' : '?'}sso=0`
  const reject = (res) => res.status(400).type('text').send('Ungültiger Anmeldeabgleich')
  const cookieName = (state) => `jms_sso_${state}`
  const cookieValue = (req, name) => {
    const values = String(req.headers.cookie || '').split(';').map((part) => part.trim()).filter((part) => part.startsWith(`${name}=`))
    return values.length === 1 ? values[0].slice(name.length + 1) : null
  }
  function flowOf(req) {
    const state = String(req.query.state || '')
    const flow = flows.get(state)
    if (!flow || flow.expiresAt <= now()) { flows.delete(state); return null }
    return { state, ...flow }
  }
  function start(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    const audience = requestOrigin(req)
    const issuer = req.query.issuer ? normalizeOrigin(req.query.issuer) : central
    const returnOrigin = req.query.returnOrigin ? normalizeOrigin(req.query.returnOrigin) : null
    if (!central || !allowed.has(central) || !allowed.has(audience) || !allowed.has(issuer)) return reject(res)
    if (req.query.issuer && (!isCentral(req) || returnOrigin !== issuer)) return reject(res)
    if (req.query.returnOrigin && !allowed.has(returnOrigin)) return reject(res)
    for (const [state, flow] of flows) if (flow.expiresAt <= now()) flows.delete(state)
    if (flows.size >= 2048) return res.status(429).send('Bitte kurz warten')
    const state = crypto.randomBytes(16).toString('hex')
    const verifier = crypto.randomBytes(32).toString('base64url')
    flows.set(state, { audience, issuer, returnOrigin, next: safePath(req.query.next), back: safePath(req.query.back, loginPath(safePath(req.query.next))),
      challenge: crypto.createHash('sha256').update(verifier).digest('base64url'), expiresAt: now() + 60_000 })
    res.append('Set-Cookie', `${cookieName(state)}=${verifier}; Path=/.jms-auth/sso; HttpOnly; Secure; SameSite=Lax; Max-Age=60`)
    return res.redirect(302, `${issuer}/.jms-auth/sso/issue?state=${state}`)
  }
  function issue(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    const flow = flowOf(req)
    if (!flow || requestOrigin(req) !== flow.issuer || flow.ticketIssued) return reject(res)
    const ticket = access.createSsoTicket(ipOf(req), req, { audienceOrigin: flow.audience, codeChallenge: flow.challenge })
    if (!ticket) { flows.delete(flow.state); return res.redirect(302, `${flow.audience}${done(flow.back)}`) }
    flows.get(flow.state).ticketIssued = true
    const params = new URLSearchParams({ state: flow.state, t: ticket })
    return res.redirect(302, `${flow.audience}/.jms-auth/sso/accept?${params}`)
  }
  function accept(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    const flow = flowOf(req)
    if (!flow || requestOrigin(req) !== flow.audience) return reject(res)
    const verifier = cookieValue(req, cookieName(flow.state))
    if (!verifier || crypto.createHash('sha256').update(verifier).digest('base64url') !== flow.challenge) return reject(res)
    const ok = access.redeemSsoTicket(req.query.t, ipOf(req), req, res, { audienceOrigin: flow.audience, codeVerifier: verifier })
    flows.delete(flow.state)
    res.append('Set-Cookie', `${cookieName(flow.state)}=; Path=/.jms-auth/sso; HttpOnly; Secure; SameSite=Lax; Max-Age=0`)
    return res.redirect(302, ok ? `${flow.returnOrigin || ''}${flow.next}` : done(flow.back))
  }
  function push(req, res) {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    const origin = requestOrigin(req)
    const next = safePath(req.query.next)
    if (!central || !allowed.has(origin) || !allowed.has(central)) return reject(res)
    if (isCentral(req)) return res.redirect(302, next)
    const params = new URLSearchParams({ issuer: origin, returnOrigin: origin, next })
    return res.redirect(302, `${central}/.jms-auth/sso/start?${params}`)
  }
  return { start, issue, accept, push, isCentral, allowed, central }
}

function createSocketGuard({ intervalMs = 1000 } = {}) {
  const connections = new Set()
  function remove(connection) { connections.delete(connection) }
  function add({ sessionId, valid, close }) {
    const connection = { sessionId, valid, close }
    connections.add(connection)
    return () => remove(connection)
  }
  function sweep() {
    for (const connection of connections) {
      let valid = false
      try { valid = connection.valid() } catch {}
      if (!valid) { remove(connection); connection.close() }
    }
  }
  function revoke(ids) {
    for (const connection of connections) if (ids.includes(connection.sessionId)) { remove(connection); connection.close() }
  }
  const timer = setInterval(sweep, intervalMs)
  timer.unref()
  return { add, sweep, revoke, stop: () => clearInterval(timer) }
}

function proxyWebSocket(req, socket, head, { upstream, upstreamPath, guard, sessionId, valid, stripCookies }) {
  const target = new URL(upstream)
  const transport = target.protocol === 'https:' ? https : http
  let upstreamSocket = null
  let closed = false
  let cleanup = () => {}
  const close = () => {
    if (closed) return
    closed = true
    cleanup()
    upstreamSocket?.destroy()
    socket.destroy()
  }
  cleanup = guard.add({ sessionId, valid, close })
  const headers = { ...req.headers, host: target.host, connection: 'Upgrade' }
  delete headers['x-jms-user']
  delete headers['x-jms-role']
  delete headers['x-jms-admin']
  delete headers['x-jms-device-key']
  delete headers['x-jms-device-proxy']
  delete headers['x-jms-device-fingerprint']
  headers.cookie = stripCookies(headers.cookie)
  const request = transport.request(target, {
    method: 'GET', path: upstreamPath, headers, timeout: 10_000,
    rejectUnauthorized: !(target.protocol === 'https:' && target.hostname === '127.0.0.1'),
  })
  request.on('upgrade', (response, upstream, upstreamHead) => {
    upstreamSocket = upstream
    if (closed) return upstream.destroy()
    if (!valid()) return close()
    const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`]
    for (let index = 0; index < response.rawHeaders.length; index += 2) lines.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`)
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (upstreamHead.length) socket.write(upstreamHead)
    if (head.length) upstream.write(head)
    upstream.on('error', close)
    upstream.on('close', close)
    socket.pipe(upstream).pipe(socket)
  })
  request.on('response', () => close())
  request.on('timeout', () => request.destroy())
  request.on('error', close)
  socket.on('error', close)
  socket.on('close', () => { request.destroy(); close() })
  request.end()
}

module.exports = { DEFAULT_ORIGINS, normalizeOrigin, requestOrigin, sameOriginRequest, machineRequest, nativeMachineRequest, withoutOwnCookies, safePath, verifySignedRequest, createSsoHandlers, createSocketGuard, proxyWebSocket }
