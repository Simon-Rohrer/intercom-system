'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const net = require('node:net')
const tls = require('node:tls')
const { once } = require('node:events')
const { execFileSync } = require('node:child_process')
const { deviceAssertion, startSatelliteBridge } = require('../device-transport')

test('device assertions have exact audience, permission scope, bounded lifetime and signature', () => {
  const secret = 'fixture-only-secret'
  const machine = { id: 'device', version: 'version', mode: 'station', services: ['kesher'], roleId: 'light',
    deviceId: 'light-pi', capabilities: ['heartbeat'], expiresAt: 50_000 }
  const [payload, signature] = deviceAssertion(machine, secret, 10_000).split('.')
  assert.equal(signature, crypto.createHmac('sha256', secret).update(payload).digest('base64url'))
  assert.deepEqual(JSON.parse(Buffer.from(payload, 'base64url')), { aud: 'kesher-device', id: 'device', version: 'version', roleId: 'light', deviceId: 'light-pi', capabilities: ['heartbeat'], exp: 40_000 })
  assert.equal(deviceAssertion({ ...machine, mode: 'code-bypass' }, secret), '')
  assert.equal(deviceAssertion({ ...machine, services: ['multiview'] }, secret), '')
  assert.equal(deviceAssertion(null, secret), '')
})

test('satellite requires CA-valid registered certificate and closes an established tunnel after revocation', { timeout: 20_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jms-satellite-test-'))
  const execute = (args) => execFileSync('openssl', args, { cwd: directory, stdio: 'ignore' })
  const sockets = new Set()
  let bridge
  const echo = net.createServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); socket.pipe(socket) })
  try {
    execute(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '1', '-subj', '/CN=Fixture CA'])
    fs.writeFileSync(path.join(directory, 'extensions'), 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth,clientAuth\n')
    for (const name of ['server', 'client', 'unknown']) {
      execute(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`])
      execute(['x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', `${name}.crt`, '-days', '1', '-extfile', 'extensions'])
    }
    const read = (name) => fs.readFileSync(path.join(directory, name))
    const fingerprint = new crypto.X509Certificate(read('client.crt')).fingerprint256
    let active = true
    const machine = { id: 'fixture', version: 'one', mode: 'station', capabilities: ['satellite'] }
    const access = { machineByFingerprint: (value) => active && value === fingerprint ? machine : null,
      machineStatus: () => ({ ...machine, active }) }
    echo.listen(0, '127.0.0.1')
    await once(echo, 'listening')
    bridge = startSatelliteBridge({ access, host: '127.0.0.1', port: 0, upstreamPort: echo.address().port,
      caFile: path.join(directory, 'ca.crt'), certFile: path.join(directory, 'server.crt'), keyFile: path.join(directory, 'server.key') })
    await once(bridge.server, 'listening')
    const connect = (identity) => tls.connect({ host: '127.0.0.1', port: bridge.server.address().port, ca: read('ca.crt'),
      ...(identity ? { cert: read(`${identity}.crt`), key: read(`${identity}.key`) } : {}), rejectUnauthorized: true })
    for (const identity of [null, 'unknown']) {
      const denied = connect(identity)
      denied.on('error', () => {})
      await new Promise((resolve) => denied.on('close', resolve))
      assert.equal(denied.destroyed, true)
    }
    const client = connect('client')
    client.on('error', () => {})
    await once(client, 'secureConnect')
    const response = once(client, 'data')
    client.write('fixture-data')
    assert.equal((await response)[0].toString(), 'fixture-data')
    const closed = new Promise((resolve) => client.on('close', resolve))
    active = false
    await closed
    assert.equal(client.destroyed, true)
  } finally {
    bridge?.close()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => echo.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
