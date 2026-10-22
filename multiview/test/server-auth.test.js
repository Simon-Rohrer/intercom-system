'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const WebSocket = require('ws')
const { createAccess } = require('../access')

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

for (const serviceHost of ['jmscontrol.local', 'jmscontrol.internal']) test(`real HTTP server enforces device, role, CSRF, SSO and websocket revocation on ${serviceHost}`, { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jms-http-auth-'))
  const roles = [{ id: 'lighting', name: 'Licht' }, { id: 'video', name: 'Regie' }, { id: 'chat-monitor', name: 'Monitor' }]
  const mock = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    if (request.url === '/api/login') return response.end(JSON.stringify({ token: 'fixture-only' }))
    if (request.url === '/api/bootstrap') return response.end(JSON.stringify({ roles, self: { id: 'monitor', roleId: 'chat-monitor' }, rooms: [], broadcastGroups: [] }))
    if (request.url === '/api/public-bootstrap') return response.end(JSON.stringify({ roles, activeRoleIds: [] }))
    response.end('{}')
  })
  const mockSockets = new WebSocket.WebSocketServer({ server: mock })
  const activeSockets = []
  let child
  try {
    mock.listen(0, '127.0.0.1')
    await once(mock, 'listening')
    const probe = http.createServer()
    probe.listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    const access = createAccess({ dataDir: directory, allowBootstrap: true, getRoles: () => roles, log: () => {} })
    await access.setAdminPin({ pin: '472593', source: 'own' }, { open: true }, { headers: {} })
    access.setGateway({ enabled: true, exempt: [] })
    const proxySecret = crypto.randomBytes(32).toString('hex')
    const register = (name, services, capabilities) => access.createMachine({ name, services, capabilities,
      fingerprint: crypto.randomBytes(32).toString('hex'), roleId: 'lighting' }).machine
    const heartbeat = register('Heartbeat', ['multiview'], ['heartbeat'])
    const display = register('Display', ['multiview'], ['display'])
    const qrDisplay = register('QR display', ['multiview'], ['display', 'day-code'])
    const chatOnly = register('Chat', ['multiview'], ['chat-monitor'])
    const foreignService = register('Kesher only', ['kesher'], ['day-code', 'pi-config', 'display'])
    access.flush()
    fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
      atem: { ip: '' }, sources: [], screens: [],
      dayQr: { show: true, corner: 'br', size: 's' },
      layouts: [{ id: 'light-layout', name: 'Licht', tiles: [] }, { id: 'video-layout', name: 'Regie', tiles: [] }],
      outputs: [{ id: 'light-output', name: 'Licht', layoutId: 'light-layout' }, { id: 'video-output', name: 'Regie', layoutId: 'video-layout' }],
      access: { roles: { lighting: { outputs: ['light-output'], edit: ['light-output'], editLayouts: false } } },
      chat: { url: `http://127.0.0.1:${mock.address().port}`, username: 'Fixture', roleId: 'chat-monitor' },
      raspberry: { clients: [{ id: 'pi1', name: 'Buehne', roleId: 'lighting', deviceId: 'pi-buehne', ipAddress: '192.168.0.41' }] },
    }))
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATA_DIR: directory, HOST: '127.0.0.1', PORT: String(port), JMS_DISABLE_HARDWARE: '1', JMS_AUTH_SECRET: 'isolated-fixture-secret', JMS_SSO_ORIGIN: 'https://192.168.0.21:8090', JMS_DEVICE_PROXY_SECRET: proxySecret },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    child.stdout.on('data', (chunk) => { logs += chunk })
    child.stderr.on('data', (chunk) => { logs += chunk })
    async function request(route, { method = 'GET', body, jar = {}, host = serviceHost, origin = `https://${host}`, extra = {} } = {}) {
      const response = await new Promise((resolve, reject) => {
        const outgoing = http.request(`http://127.0.0.1:${port}${route}`, { method, headers: {
          Host: host, Origin: origin, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.90',
          'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json',
          Cookie: Object.entries(jar).map(([key, value]) => `${key}=${value}`).join('; '), ...extra,
        } }, (incoming) => {
          let text = ''
          incoming.setEncoding('utf8')
          incoming.on('data', (chunk) => { text += chunk })
          incoming.on('end', () => resolve({ status: incoming.statusCode, headers: new Headers(Object.entries(incoming.headers).filter(([, value]) => typeof value === 'string')), cookies: incoming.headers['set-cookie'] || [], text }))
        })
        outgoing.on('error', reject)
        outgoing.end(body === undefined ? undefined : JSON.stringify(body))
      })
      for (const value of response.cookies) {
        const pair = value.split(';')[0]
        const separator = pair.indexOf('=')
        if (pair.slice(separator + 1)) jar[pair.slice(0, separator)] = pair.slice(separator + 1)
        else delete jar[pair.slice(0, separator)]
      }
      const text = response.text
      let data
      try { data = JSON.parse(text) } catch { data = text }
      return { status: response.status, headers: response.headers, data }
    }
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`)
      try { ready = (await request('/api/login/roles')).data.roles?.length === 2 } catch {}
      if (ready) break
      await wait(50)
    }
    assert.ok(ready, logs)
    const machineHeaders = (machine) => ({ 'X-JMS-Device-Fingerprint': machine.fingerprint, 'X-JMS-Device-Proxy': proxySecret })
    for (const route of ['/api/config', '/api/state', '/api/output/light-output/user', '/api/propresenter/thumb/fixture/0',
      '/api/churchtools', '/api/chat', '/api/avatar/' + 'a'.repeat(20)])
      assert.equal((await request(route, { extra: machineHeaders(heartbeat) })).status, 403, route)
    assert.equal((await request('/api/config', { extra: machineHeaders(display) })).status, 200)
    assert.equal((await request('/api/state', { extra: machineHeaders(display) })).status, 200)
    assert.equal((await request('/api/chat', { extra: machineHeaders(chatOnly) })).status, 200)
    assert.equal((await request('/api/state', { extra: machineHeaders(chatOnly) })).status, 403)
    assert.equal((await request('/api/config', { extra: machineHeaders(foreignService) })).status, 401)
    assert.equal((await request('/api/display/day-code', { extra: machineHeaders(foreignService) })).status, 403)
    assert.equal((await request('/api/raspberry-pis/config', { method: 'POST', body: {}, extra: machineHeaders(foreignService) })).status, 403)
    assert.equal((await request('/api/me', { extra: { Cookie: 'mv_session=%ZZ;jms_device=%' } })).status, 200)
    assert.equal((await request('/api/login', { method: 'POST', body: { name: 'Tim', roleId: 'lighting' } })).status, 403)
    const adminJar = {}
    const adminLogin = await request('/api/login', { method: 'POST', jar: adminJar, body: { name: 'Fixture Admin', roleId: 'admin', pin: '472593' } })
    assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.data))
    // Alte globale Anzeige wird einmalig und dauerhaft auf alle Multiviews übernommen.
    const migrated = JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'))
    assert.equal(Object.hasOwn(migrated, 'dayQr'), false)
    assert.deepEqual(migrated.outputs.map((output) => output.dayQr), [
      { show: true, corner: 'br', size: 's' }, { show: true, corner: 'br', size: 's' },
    ])
    const qrConfig = (await request('/api/config', { jar: adminJar })).data
    qrConfig.outputs[0].dayQr = { show: false, corner: 'tr', size: 'm' }
    qrConfig.outputs[1].dayQr = { show: true, corner: 'tl', size: 'l' }
    assert.equal((await request('/api/config', { method: 'PUT', jar: adminJar, body: qrConfig })).status, 200)
    const qr = await request('/api/display/day-code?output=video-output', { extra: machineHeaders(qrDisplay) })
    assert.equal(qr.status, 200)
    assert.equal(qr.headers.get('cache-control'), 'no-store')
    assert.equal(qr.data.show, true)
    assert.equal(qr.data.corner, 'tl')
    assert.equal(qr.data.size, 'l')
    assert.match(qr.data.code, /^\d{6}$/)
    for (const query of ['?output=light-output', '?output=unknown', '']) {
      assert.deepEqual((await request('/api/display/day-code' + query, { jar: adminJar })).data, { show: false })
    }
    assert.equal((await request('/api/display/day-code?output=video-output', { extra: machineHeaders(display) })).status, 403)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).outputs.map((o) => o.dayQr), qrConfig.outputs.map((o) => o.dayQr))
    const gateway = await request('/api/access/gateway', { jar: adminJar })
    assert.equal(gateway.status, 200)
    const userJar = {}
    assert.equal((await request('/api/device', { method: 'POST', jar: userJar, body: { code: gateway.data.code } })).status, 200)
    assert.equal((await request('/api/login', { method: 'POST', jar: userJar, body: { name: 'Tim', roleId: 'invented' } })).status, 400)
    assert.equal((await request('/api/login', { method: 'POST', jar: userJar, body: { name: 'Tim', roleId: 'lighting' } })).status, 200)
    const me = await request('/api/me', { jar: userJar })
    assert.equal(me.headers.get('cache-control'), 'no-store')
    assert.equal(me.headers.get('x-frame-options'), null)
    assert.match(me.headers.get('content-security-policy'), /^frame-ancestors 'self' /)
    assert.ok(me.headers.get('content-security-policy').includes('https://192.168.0.21:3000'))
    assert.ok(!me.headers.get('content-security-policy').includes('*'))
    assert.ok(me.data.user.sessionId && me.data.user.version && me.data.user.expiresAt > Date.now())
    const config = await request('/api/config', { jar: userJar })
    assert.deepEqual(config.data.outputs.map((output) => output.id), ['light-output'])
    // Eine Rolle mit Layout-Bearbeitung darf weiterhin keine Tagescode-Anzeige ändern.
    const tampered = structuredClone(config.data)
    tampered.outputs[0].dayQr = { show: true, corner: 'bl', size: 'l' }
    tampered.dayQr = { show: true }
    assert.equal((await request('/api/config', { method: 'PUT', jar: userJar, body: tampered })).status, 200)
    const restrictedQr = (await request('/api/config', { jar: adminJar })).data.outputs.map((o) => o.dayQr)
    assert.deepEqual(restrictedQr, [{ show: true, corner: 'bl', size: 'l' }, { show: true, corner: 'tl', size: 'l' }])
    assert.equal((await request('/api/display/day-code?output=video-output', { jar: userJar })).status, 403)
    const onStation = await request('/api/config', { jar: userJar, extra: machineHeaders(display) })
    assert.deepEqual(onStation.data.outputs.map((output) => output.id), ['light-output'])
    assert.equal((await request('/api/output/video-output/layout/video-layout', { method: 'POST', jar: userJar, body: {} })).status, 403)
    assert.equal((await request('/api/output/light-output/layout/light-layout', { jar: userJar })).status, 405)
    assert.equal((await request('/api/logout', { method: 'POST', jar: userJar, origin: 'https://attacker.invalid', body: {} })).status, 403)
    assert.equal((await request('/api/display/day-code', { jar: userJar })).status, 403)
    // Raspberry Pis ein-/ausschalten aus dem Intercom: nur Admin oder Rollen mit dem Recht
    const piControl = '/.jms-auth/api/raspberry-pis/control'
    assert.deepEqual((await request(piControl, { jar: userJar })).data, { ok: true, allowed: false, pis: [] })
    assert.equal((await request(piControl, { method: 'POST', jar: userJar, body: { deviceId: 'pi-buehne', action: 'off' } })).status, 403)
    assert.equal((await request(piControl, { jar: {} })).status, 401)
    assert.equal((await request(piControl, { method: 'POST', jar: adminJar, body: { deviceId: 'pi-buehne', action: 'shutdown' } })).status, 400)
    assert.equal((await request(piControl, { method: 'POST', jar: adminJar, body: { deviceId: 'unknown', action: 'off' } })).status, 404)
    assert.equal((await request(piControl, { method: 'POST', jar: adminJar, origin: 'https://attacker.invalid', body: { deviceId: 'pi-buehne', action: 'off' } })).status, 403)
    const piOff = await request(piControl, { method: 'POST', jar: adminJar, body: { deviceId: 'pi-buehne', action: 'off' } })
    assert.deepEqual(piOff.data, { ok: true, standby: true, waitSeconds: 15 })
    assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8')).raspberry.clients[0].standby, true)
    assert.deepEqual((await request(piControl, { jar: adminJar })).data.pis, [{ id: 'pi1', deviceId: 'pi-buehne', name: 'Buehne', standby: true }])
    const piRights = (await request('/api/config', { jar: adminJar })).data
    piRights.access.roles.lighting.controlPis = true
    assert.equal((await request('/api/config', { method: 'PUT', jar: adminJar, body: piRights })).status, 200)
    assert.equal((await request(piControl, { jar: userJar })).data.allowed, true)
    assert.equal((await request(piControl, { method: 'POST', jar: userJar, body: { deviceId: 'pi-buehne', action: 'on' } })).data.standby, false)
    assert.equal((await request(piControl, { method: 'POST', jar: userJar, body: { deviceId: 'pi-buehne', action: 'reboot' } })).status, 200)
    const centralJar = {}
    let next = (await request('/.jms-auth/sso/push?next=%2F', { jar: userJar })).headers.get('location')
    for (let step = 0; step < 5 && next?.startsWith('https://'); step++) {
      const target = new URL(next)
      if (!target.pathname.startsWith('/.jms-auth/sso/')) break
      const jar = target.host === serviceHost ? userJar : centralJar
      const result = await request(target.pathname + target.search, { host: target.host, jar })
      assert.equal(result.status, 302)
      next = result.headers.get('location')
    }
    assert.equal((await request('/api/me', { host: '192.168.0.21:8090', jar: centralJar })).data.user.sessionId, me.data.user.sessionId)
    assert.equal((await request('/.jms-auth/sso/start', { host: 'unregistered.local', jar: {} })).status, 400)
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Host: serviceHost, Origin: `https://${serviceHost}`, 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.90', Cookie: Object.entries(userJar).map(([key, value]) => `${key}=${value}`).join('; ') },
    })
    activeSockets.push(socket)
    await once(socket, 'open')
    const closed = once(socket, 'close')
    assert.equal((await request('/api/logout', { method: 'POST', jar: centralJar, host: '192.168.0.21:8090', body: {} })).status, 200)
    const [closeCode] = await Promise.race([closed, wait(2000).then(() => { throw new Error('WebSocket survived logout') })])
    assert.equal(closeCode, 4401)
    assert.equal((await request('/api/me', { jar: userJar })).data.user, null)
    assert.equal((await request('/api/config', { jar: userJar })).status, 401)
    const deviceSocket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      headers: { Host: serviceHost, Origin: `https://${serviceHost}`, 'X-Forwarded-Proto': 'https',
        'X-Forwarded-For': '203.0.113.90', ...machineHeaders(display) },
    })
    activeSockets.push(deviceSocket)
    await once(deviceSocket, 'open')
    const deviceClosed = once(deviceSocket, 'close')
    assert.equal((await request('/api/access/machines/' + display.id, { method: 'DELETE', jar: adminJar })).status, 200)
    const [deviceCloseCode] = await Promise.race([deviceClosed, wait(2500).then(() => { throw new Error('WebSocket survived device revocation') })])
    assert.equal(deviceCloseCode, 4401)
    assert.equal((await request('/api/config', { extra: machineHeaders(display) })).status, 401)
  } finally {
    for (const socket of activeSockets) socket.terminate()
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    for (const socket of mockSockets.clients) socket.terminate()
    mockSockets.close()
    await new Promise((resolve) => mock.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
