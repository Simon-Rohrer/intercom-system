'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const { once } = require('node:events')
const { WebSocketServer, WebSocket } = require('ws')
const { normalizeOrigin, requestOrigin, sameOriginRequest, machineRequest, nativeMachineRequest, withoutOwnCookies, safePath, verifySignedRequest, createSsoHandlers, createSocketGuard, proxyWebSocket } = require('../auth-http')

function request(origin, query = {}, cookie = '') {
  return { query, headers: { host: new URL(origin).host, 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: '127.0.0.1' } }
}

function response() {
  return {
    statusCode: 200, headers: {}, cookies: [], location: null,
    set(name, value) { if (typeof name === 'string') this.headers[name] = value; else Object.assign(this.headers, name); return this },
    append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); return this },
    status(statusCode) { this.statusCode = statusCode; return this },
    type() { return this },
    send(body) { this.body = body; return this },
    redirect(statusCode, location) { this.statusCode = statusCode; this.location = location; return this },
  }
}

function follow(location, cookie = '') {
  const url = new URL(location)
  return request(url.origin, Object.fromEntries(url.searchParams), cookie)
}

function ssoFixture() {
  let now = 1_000
  const issued = new Map()
  const redeemed = []
  const access = {
    createSsoTicket(ip, req, options) {
      const token = crypto.randomBytes(12).toString('hex')
      issued.set(token, options)
      return token
    },
    redeemSsoTicket(token, ip, req, res, options) {
      const ticket = issued.get(token)
      if (!ticket || ticket.audienceOrigin !== options.audienceOrigin || ticket.codeChallenge !== crypto.createHash('sha256').update(options.codeVerifier).digest('base64url')) return false
      redeemed.push(options)
      issued.delete(token)
      return true
    },
  }
  const handlers = createSsoHandlers({ access, centralOrigin: 'https://192.168.0.21:8090', ipOf: () => 'client', loginPath: () => '/login', now: () => now })
  return { handlers, issued, redeemed, advance: () => { now += 60_001 } }
}

test('Origins are exact HTTPS origins and forwarded scheme only trusted from loopback', () => {
  assert.equal(normalizeOrigin('https://companion.local:443'), 'https://companion.local')
  for (const origin of ['http://companion.local', 'https://user:password@companion.local', 'https://companion.local/path', 'https://companion.local?token=a']) assert.equal(normalizeOrigin(origin), null)
  const req = request('https://companion.local')
  assert.equal(requestOrigin(req), 'https://companion.local')
  req.socket.remoteAddress = '192.168.0.66'
  assert.equal(requestOrigin(req), 'http://companion.local')
})

test('CSRF rejects cross-origin, same-site and cookie-only mutation requests', () => {
  const req = request('https://companion.local', {}, 'mv_session=abc')
  assert.equal(sameOriginRequest(req), false)
  req.headers.origin = 'https://companion.local'
  assert.equal(sameOriginRequest(req), true)
  req.headers.origin = 'https://companion.local:9999'
  assert.equal(sameOriginRequest(req), false)
  delete req.headers.origin
  req.headers['sec-fetch-site'] = 'same-site'
  assert.equal(sameOriginRequest(req), false)
  req.headers['sec-fetch-site'] = 'same-origin'
  assert.equal(sameOriginRequest(req), true)
  assert.equal(machineRequest(req, true, { roleId: 'light' }), false)
  assert.equal(machineRequest(request('https://companion.local'), true), true)
  assert.equal(machineRequest(request('https://companion.local'), false), false)
})

test('Registered Pi browser is a machine only for same-origin requests without a human session', () => {
  const req = request('https://intercom.local')
  req.headers.origin = 'https://intercom.local'
  req.headers['sec-fetch-site'] = 'same-origin'
  assert.equal(machineRequest(req, true), true)
  assert.equal(nativeMachineRequest(req, true), false)
  assert.equal(machineRequest(req, false), false)
  assert.equal(machineRequest(req, true, { roleId: 'light', admin: false }), false)
  req.headers.origin = 'https://attacker.invalid'
  assert.equal(machineRequest(req, true), false)
  delete req.headers.origin
  req.headers['sec-fetch-site'] = 'cross-site'
  assert.equal(machineRequest(req, true), false)
  delete req.headers['sec-fetch-site']
  assert.equal(nativeMachineRequest(req, true), true)
})

test('Return paths reject slash escapes, backslashes and control characters', () => {
  for (const value of ['//evil.local/', '/\\evil.local/', '/foo\nLocation: bad', 'https://evil.local/']) assert.equal(safePath(value, '/safe'), '/safe')
  assert.equal(safePath('/remote.html?view=stage'), '/remote.html?view=stage')
})

test('Upstream cookies never contain central credentials or PKCE verifiers, including whitespace variants', () => {
  assert.equal(withoutOwnCookies('  mv_session=secret; jms_device=grant; jms_sso_ab123=verifier; backend=allowed'), 'backend=allowed')
})

test('Signed introspection requires exact action, session, timestamp and hex signature', () => {
  const issuedAt = Date.now()
  const body = { sessionId: 'session-1', issuedAt }
  body.signature = crypto.createHmac('sha256', 'test-secret').update(`kesher:introspect:${body.sessionId}:${issuedAt}`).digest('hex')
  assert.equal(verifySignedRequest('test-secret', 'introspect', body, issuedAt), true)
  assert.equal(verifySignedRequest('test-secret', 'introspect', { ...body, sessionId: 'session-2' }, issuedAt), false)
  assert.equal(verifySignedRequest('test-secret', 'introspect', body, issuedAt + 30_001), false)
  assert.equal(verifySignedRequest('test-secret', 'revoke-admin', body, issuedAt), false)
  assert.equal(verifySignedRequest('', 'introspect', body, issuedAt), false)
  const revoke = { issuedAt, signature: crypto.createHmac('sha256', 'test-secret').update(`kesher:revoke-admin:${issuedAt}`).digest('hex') }
  assert.equal(verifySignedRequest('test-secret', 'revoke-admin', revoke, issuedAt), true)
})

test('SSO pull is bound to browser verifier, exact target origin and one use', () => {
  const fixture = ssoFixture()
  const started = response()
  fixture.handlers.start(request('https://intercom.local', { next: '/room', back: '/login' }), started)
  assert.match(started.cookies[0], /HttpOnly; Secure; SameSite=Lax/)
  const cookie = started.cookies[0].split(';')[0]
  const issued = response()
  fixture.handlers.issue(follow(started.location), issued)
  const noCookie = response()
  fixture.handlers.accept(follow(issued.location), noCookie)
  assert.equal(noCookie.statusCode, 400)
  const wrongOrigin = follow(issued.location, cookie)
  wrongOrigin.headers.host = 'companion.local'
  const denied = response()
  fixture.handlers.accept(wrongOrigin, denied)
  assert.equal(denied.statusCode, 400)
  const accepted = response()
  fixture.handlers.accept(follow(issued.location, cookie), accepted)
  assert.equal(accepted.location, '/room')
  assert.equal(fixture.redeemed.length, 1)
  const replay = response()
  fixture.handlers.accept(follow(issued.location, cookie), replay)
  assert.equal(replay.statusCode, 400)
})

test('SSO refuses wildcard-like names, alternate ports and invalid issuer state', () => {
  const fixture = ssoFixture()
  for (const origin of ['https://evil.local', 'https://evil.jms.de', 'https://intercom.local:9999', 'https://192.168.0.21:9999']) {
    const result = response()
    fixture.handlers.start(request(origin), result)
    assert.equal(result.statusCode, 400)
  }
  const started = response()
  fixture.handlers.start(request('https://intercom.local'), started)
  const wrongIssuer = follow(started.location)
  wrongIssuer.headers.host = 'companion.local'
  const result = response()
  fixture.handlers.issue(wrongIssuer, result)
  assert.equal(result.statusCode, 400)
  fixture.advance()
  fixture.handlers.issue(follow(started.location), result)
  assert.equal(result.statusCode, 400)
})

test('SSO push gets verifier from central before issuing a target login ticket', () => {
  const fixture = ssoFixture()
  const pushed = response()
  fixture.handlers.push(request('https://intercom.local', { next: '/room' }), pushed)
  const started = response()
  fixture.handlers.start(follow(pushed.location), started)
  assert.equal(new URL(started.location).origin, 'https://intercom.local')
  const issued = response()
  fixture.handlers.issue(follow(started.location), issued)
  assert.equal(new URL(issued.location).origin, 'https://192.168.0.21:8090')
  const accepted = response()
  fixture.handlers.accept(follow(issued.location, started.cookies[0].split(';')[0]), accepted)
  assert.equal(accepted.location, 'https://intercom.local/room')
})

test('Socket guard revokes only matching sessions and expires invalid sockets', () => {
  const guard = createSocketGuard()
  let revoked = 0
  let expired = 0
  guard.add({ sessionId: 'first', valid: () => true, close: () => { revoked++ } })
  guard.add({ sessionId: 'second', valid: () => false, close: () => { expired++ } })
  guard.revoke(['first'])
  assert.equal(revoked, 1)
  assert.equal(expired, 0)
  guard.sweep()
  assert.equal(expired, 1)
  guard.revoke(['first', 'second'])
  assert.equal(revoked, 1)
  assert.equal(expired, 1)
  guard.stop()
})

test('Raw WebSocket proxy preserves frames and closes both sides on central revocation', { timeout: 5000 }, async (context) => {
  const upstreamServer = http.createServer()
  const upstreamWs = new WebSocketServer({ server: upstreamServer })
  const proxyServer = http.createServer()
  const guard = createSocketGuard()
  let upstreamConnection
  let observedHeaders
  upstreamWs.on('connection', (connection, req) => {
    upstreamConnection = connection
    observedHeaders = req.headers
    connection.on('message', (message) => connection.send(message))
  })
  await new Promise((resolve) => upstreamServer.listen(0, '127.0.0.1', resolve))
  const upstreamPort = upstreamServer.address().port
  proxyServer.on('upgrade', (req, socket, head) => proxyWebSocket(req, socket, head, {
    upstream: `http://127.0.0.1:${upstreamPort}`, upstreamPath: '/socket', guard, sessionId: 'session-one', valid: () => true,
    stripCookies: () => 'service_cookie=kept',
  }))
  await new Promise((resolve) => proxyServer.listen(0, '127.0.0.1', resolve))
  const client = new WebSocket(`ws://127.0.0.1:${proxyServer.address().port}/proxy`, { headers: { Cookie: 'mv_session=hidden; service_cookie=kept' } })
  context.after(() => { client.terminate(); upstreamConnection?.terminate(); guard.stop(); upstreamWs.close(); upstreamServer.close(); proxyServer.close() })
  await once(client, 'open')
  assert.equal(observedHeaders.cookie, 'service_cookie=kept')
  client.send('payload')
  const [message] = await once(client, 'message')
  assert.equal(message.toString(), 'payload')
  const clientClosed = once(client, 'close')
  const upstreamClosed = once(upstreamConnection, 'close')
  guard.revoke(['session-one'])
  await Promise.all([clientClosed, upstreamClosed])
})
