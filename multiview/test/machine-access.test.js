'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createAccess } = require('../access')

const directories = []
const instances = []
const previousProxySecret = process.env.JMS_DEVICE_PROXY_SECRET
process.env.JMS_DEVICE_PROXY_SECRET = crypto.randomBytes(32).toString('hex')
const fingerprint = () => crypto.randomBytes(32).toString('hex')
const ip = '192.0.2.21'

function request(headers = {}, options = {}) {
  return { headers, ip: options.ip || ip, secure: options.encrypted === true,
    socket: { remoteAddress: options.peer || ip, encrypted: options.encrypted === true }, get: () => '' }
}

function certificate(value, options = {}) {
  return request({ 'x-jms-device-fingerprint': value, 'x-jms-device-proxy': process.env.JMS_DEVICE_PROXY_SECRET,
    'x-forwarded-proto': 'https', 'x-forwarded-for': options.ip || ip }, { ...options, peer: '127.0.0.1' })
}

function nativeKey(key, options = {}) {
  return request({ 'x-jms-device-key': key }, { encrypted: true, ...options })
}

function response() {
  const cookies = {}
  return { cookies, setHeader(name, value) { this.append(name, value) }, append(name, value) {
    if (name !== 'Set-Cookie') return
    const pair = value.split(';')[0]
    const separator = pair.indexOf('=')
    cookies[pair.slice(0, separator)] = pair.slice(separator + 1)
  } }
}

function load(dataDir, options = {}) {
  const access = createAccess({ dataDir, getRoles: () => ['light', 'video'], ipOf: (req) => req.ip, log: () => {}, ...options })
  instances.push(access)
  return access
}

async function setup(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jms-machine-test-'))
  directories.push(dataDir)
  const access = load(dataDir, { allowBootstrap: true, ...options })
  await access.setAdminPin({ pin: '123456' }, { open: true }, request())
  access.setGateway({ enabled: true })
  return { access, dataDir }
}

function createStation(access, input = {}) {
  return access.createMachine({ name: 'Teststation', fingerprint: fingerprint(), mode: 'station',
    services: ['multiview', 'kesher'], capabilities: ['display', 'pi-config'], ...input })
}

function flow() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  return { issue: { audienceOrigin: 'https://intercom.local', codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url') },
    redeem: { audienceOrigin: 'https://intercom.local', codeVerifier } }
}

after(() => {
  for (const access of instances) access.flush()
  for (const directory of directories) fs.rmSync(directory, { recursive: true, force: true })
  if (previousProxySecret === undefined) delete process.env.JMS_DEVICE_PROXY_SECRET
  else process.env.JMS_DEVICE_PROXY_SECRET = previousProxySecret
})

test('Formatmigration entfernt IP-Ausnahmen und alte menschliche Sitzungen', async () => {
  const { access, dataDir } = await setup()
  const res = response()
  await access.login({ name: 'Admin', roleId: 'admin', pin: '123456' }, request(), res)
  const file = path.join(dataDir, 'access-secret.json')
  const stored = JSON.parse(fs.readFileSync(file))
  stored.securityFormat = 2
  stored.gateway.exempt = [{ network: '127.0.0.1' }, { network: ip, login: true }]
  fs.writeFileSync(file, JSON.stringify(stored))
  const upgraded = load(dataDir)
  assert.equal(upgraded.userOf(request({ cookie: 'mv_session=' + res.cookies.mv_session })), null)
  assert.equal(upgraded.gateway().exempt, undefined)
  assert.equal(upgraded.trusted(ip, request()), false)
  upgraded.flush()
  assert.equal(JSON.parse(fs.readFileSync(file)).securityFormat, 3)
  assert.equal(JSON.parse(fs.readFileSync(file)).gateway.exempt, undefined)
})

test('Zertifizierte Identität bleibt bei IP-Wechsel gleich und enthält keine Geheimnisse', async () => {
  const { access, dataDir } = await setup()
  const { machine, key } = createStation(access)
  assert.equal(key.length, 43)
  assert.equal(access.machineOf(certificate(machine.fingerprint)).id, machine.id)
  assert.equal(access.machineOf(certificate(machine.fingerprint, { ip: '198.51.100.23' })).id, machine.id)
  assert.equal(access.machineOf(certificate(machine.fingerprint.match(/../g).join(':').toUpperCase())).id, machine.id)
  assert.equal(access.machineOf(nativeKey(key)).id, machine.id)
  for (const result of [machine, access.listMachines(), access.machineStatus(machine.id), access.machineByFingerprint(machine.fingerprint)]) {
    assert.equal(JSON.stringify(result).includes('keyHash'), false)
    assert.equal(JSON.stringify(result).includes(key), false)
  }
  const stored = fs.readFileSync(path.join(dataDir, 'access-secret.json'), 'utf8')
  assert.equal(stored.includes(key), false)
  assert.match(stored, new RegExp(crypto.createHash('sha256').update(key).digest('hex')))
  const reopened = load(dataDir)
  assert.equal(reopened.machineOf(nativeKey(key)).id, machine.id)
})

test('Ein Zertifikatsheader ohne authentifizierten lokalen Proxy wird abgelehnt', async () => {
  const { access } = await setup()
  const { machine } = createStation(access)
  const valid = certificate(machine.fingerprint)
  for (const req of [request({ 'x-jms-device-fingerprint': machine.fingerprint }),
    { ...valid, socket: { remoteAddress: ip } },
    { ...valid, headers: { ...valid.headers, 'x-jms-device-proxy': 'wrong' } },
    { ...valid, headers: { ...valid.headers, 'x-jms-device-fingerprint': fingerprint() } }]) assert.equal(access.machineOf(req), null)
})

test('Native Schlüssel benötigen TLS oder einen nicht weitergeleiteten Loopbacktransport', async () => {
  const { access } = await setup()
  const { machine, key } = createStation(access)
  assert.equal(access.machineOf(nativeKey(key, { encrypted: false })), null)
  assert.equal(access.machineOf(nativeKey(key, { encrypted: false, peer: '127.0.0.1' })).id, machine.id)
  const forgedForwarded = nativeKey(key, { encrypted: false, peer: '127.0.0.1' })
  forgedForwarded.headers['x-forwarded-proto'] = 'https'
  assert.equal(access.machineOf(forgedForwarded), null)
  forgedForwarded.headers['x-jms-device-proxy'] = process.env.JMS_DEVICE_PROXY_SECRET
  assert.equal(access.machineOf(forgedForwarded).id, machine.id)
  forgedForwarded.headers['x-forwarded-proto'] = 'http'
  assert.equal(access.machineOf(forgedForwarded), null)
})

test('Doppelte und widersprüchliche Credentialquellen bleiben geschlossen', async () => {
  const { access } = await setup()
  const first = createStation(access)
  const second = createStation(access)
  const conflicting = certificate(first.machine.fingerprint)
  conflicting.headers['x-jms-device-key'] = second.key
  assert.equal(access.machineOf(conflicting), null)
  conflicting.headers['x-jms-device-key'] = first.key
  assert.equal(access.machineOf(conflicting).id, first.machine.id)
  conflicting.rawHeaders = ['X-JMS-Device-Key', first.key, 'x-jms-device-key', first.key]
  assert.equal(access.machineOf(conflicting), null)
  const malformed = certificate(first.machine.fingerprint)
  malformed.headers['x-jms-device-fingerprint'] = [first.machine.fingerprint]
  assert.equal(access.machineOf(malformed), null)
  malformed.headers['x-jms-device-fingerprint'] = first.machine.fingerprint + ',bad'
  assert.equal(access.machineOf(malformed), null)
})

test('Stationsrechte sind dienstgebunden und niemals Adminrechte', async () => {
  const { access } = await setup()
  const { machine } = createStation(access)
  const req = certificate(machine.fingerprint)
  assert.equal(access.check({ service: 'kesher', ip }, req).action, 'allow')
  assert.equal(access.trusted(ip, req), true)
  assert.equal(access.check({ service: 'dashboard', ip }, req).action, 'login')
  for (const service of ['companion', 'portainer', 'glances', 'dns', 'router', 'unknown'])
    assert.equal(access.check({ service, ip }, req).action, 'login')
  assert.throws(() => createStation(access, { services: ['companion'] }), /berechtigungen/)
  assert.throws(() => createStation(access, { roleId: 'admin' }), /Adminrolle/)
  assert.throws(() => createStation(access, { capabilities: ['unknown'] }), /berechtigungen/)
  assert.throws(() => createStation(access, { capabilities: ['control', 'control'] }), /berechtigungen/)
})

test('Codefreigabe benötigt weiterhin Rollenlogin und bindet Session an das Gerät', async () => {
  const { access } = await setup()
  const { machine } = createStation(access, { mode: 'code-bypass', capabilities: [] })
  const req = certificate(machine.fingerprint)
  assert.equal(access.deviceStatus(ip, req).required, false)
  assert.equal(access.trusted(ip, req), false)
  assert.equal(access.check({ service: 'kesher', ip }, req).action, 'login')
  assert.throws(() => createStation(access, { mode: 'code-bypass' }), /Stationsrechte/)
  const res = response()
  await access.login({ name: 'Nora', roleId: 'light' }, req, res)
  req.headers.cookie = 'mv_session=' + res.cookies.mv_session
  const user = access.userOf(req)
  assert.equal(user.admin, false)
  assert.equal(access.check({ service: 'companion', ip }, req).action, 'forbidden')
  assert.equal(access.userOf(request({ cookie: req.headers.cookie })), null)
  assert.equal(access.machineOf(req).id, machine.id)
  assert.equal(access.sessionStatusById(user.sessionId).active, true)
  access.revokeMachine(machine.id)
  assert.equal(access.userOf(req), null)
  assert.equal(access.sessionStatusById(user.sessionId).active, false)
})

test('SSO und QR können Gerätebindung weder entfernen noch auf fremdes Zertifikat übertragen', async () => {
  const { access } = await setup()
  const first = createStation(access, { mode: 'code-bypass', capabilities: [] })
  const second = createStation(access, { mode: 'code-bypass', capabilities: [] })
  const req = certificate(first.machine.fingerprint)
  const res = response()
  await access.login({ name: 'Nora', roleId: 'light' }, req, res)
  req.headers.cookie = 'mv_session=' + res.cookies.mv_session
  for (const destination of [request(), certificate(second.machine.fingerprint)]) {
    const browser = flow()
    const ticket = access.createSsoTicket(ip, req, browser.issue)
    assert.equal(access.redeemSsoTicket(ticket, ip, destination, response(), browser.redeem), false)
    const qr = access.createQrToken(access.userOf(req), req)
    assert.equal(access.redeemQrToken(qr.token, destination, response()), false)
  }
  const browser = flow()
  const ticket = access.createSsoTicket(ip, req, browser.issue)
  const destination = certificate(first.machine.fingerprint, { ip: '198.51.100.9' })
  const target = response()
  assert.equal(access.redeemSsoTicket(ticket, ip, destination, target, browser.redeem), true)
  destination.headers.cookie = 'mv_session=' + target.cookies.mv_session
  assert.equal(access.userOf(destination).sessionId, access.userOf(req).sessionId)
  const qr = access.createQrToken(access.userOf(req), req)
  const targetQr = response()
  assert.equal(access.redeemQrToken(qr.token, certificate(first.machine.fingerprint), targetQr), true)
  access.revokeMachine(first.machine.id)
  assert.equal(access.userOf(destination), null)
})

test('Rotation ersetzt Schlüssel und Zertifikat und verhindert Wiederverwendung alter Fingerprints', async () => {
  const { access } = await setup()
  const original = createStation(access)
  const rotated = access.rotateMachine(original.machine.id, { fingerprint: fingerprint() })
  assert.equal(access.machineOf(nativeKey(original.key)), null)
  assert.equal(access.machineOf(certificate(original.machine.fingerprint)), null)
  assert.equal(access.machineByFingerprint(original.machine.fingerprint), null)
  assert.equal(access.machineOf(certificate(rotated.machine.fingerprint)).id, original.machine.id)
  assert.equal(access.machineOf(nativeKey(rotated.key)).id, original.machine.id)
  assert.equal(access.machineStatus(original.machine.id, original.machine.version).active, false)
  assert.throws(() => createStation(access, { fingerprint: original.machine.fingerprint }), /bereits/)
  assert.throws(() => access.rotateMachine(original.machine.id, { fingerprint: original.machine.fingerprint }), /bereits/)
  const keyOnly = access.rotateMachine(original.machine.id)
  assert.equal(keyOnly.machine.fingerprint, '')
  assert.equal(access.machineOf(certificate(rotated.machine.fingerprint)), null)
  access.revokeMachine(keyOnly.machine.id)
  assert.equal(access.machineOf(nativeKey(keyOnly.key)), null)
  assert.equal(access.listMachines()[0].active, false)
})

test('Rollenwechsel eines Raspberry Pi zieht die Geräteregistrierung mit', async () => {
  const { access } = await setup()
  const station = createStation(access, { roleId: 'light', raspberryClientId: 'pi1', deviceId: 'kamera-1-pi' })
  const other = createStation(access, { roleId: 'light', raspberryClientId: 'pi2', deviceId: 'foyer-pi' })
  const changed = access.reassignPiMachines('pi1', { roleId: 'video', deviceId: 'kamera-1-pi' })
  assert.deepEqual(changed.map((machine) => [machine.id, machine.roleId]), [[station.machine.id, 'video']])
  const now = access.machineOf(certificate(station.machine.fingerprint))
  assert.equal(now.roleId, 'video')
  assert.notEqual(now.version, station.machine.version) // alte Anmeldungen gelten nicht mehr
  assert.equal(access.machineStatus(station.machine.id, station.machine.version).active, false)
  assert.equal(access.machineOf(certificate(other.machine.fingerprint)).roleId, 'light')
  assert.deepEqual(access.reassignPiMachines('pi1', { roleId: 'video', deviceId: 'kamera-1-pi' }), []) // nichts zu tun
  assert.deepEqual(access.reassignPiMachines('pi1', { roleId: 'admin', deviceId: 'kamera-1-pi' }), [])
  // Kesher-Rollen mit Leerzeichen („cam 2“)
  assert.equal(access.reassignPiMachines('pi1', { roleId: 'cam 2', deviceId: 'kamera-1-pi' })[0].roleId, 'cam 2')
  assert.equal(createStation(access, { roleId: 'lighting 2' }).machine.roleId, 'lighting 2')
  assert.throws(() => createStation(access, { roleId: ' lighting' }), /Gerätezuordnung/)
})

test('Geräteablauf widerruft Identität und gebundene Sitzungen', async (context) => {
  const { access } = await setup()
  const now = Date.now()
  const { machine, key } = createStation(access, { expiresAt: now + 30_000 })
  const req = certificate(machine.fingerprint)
  const res = response()
  await access.login({ name: 'Nora', roleId: 'light' }, req, res)
  req.headers.cookie = 'mv_session=' + res.cookies.mv_session
  const sessionId = access.userOf(req).sessionId
  context.mock.timers.enable({ apis: ['Date'], now: now + 30_001 })
  assert.equal(access.machineOf(nativeKey(key)), null)
  assert.equal(access.machineByFingerprint(machine.fingerprint), null)
  assert.equal(access.machineStatus(machine.id).active, false)
  assert.equal(access.userOf(req), null)
  assert.equal(access.sessionStatusById(sessionId).active, false)
})

test('Zertifikatregistrierung verlangt eindeutigen Fingerprint und gültige Metadaten', async () => {
  const { access } = await setup()
  const { machine } = createStation(access)
  assert.throws(() => createStation(access, { fingerprint: machine.fingerprint }), /bereits/)
  access.revokeMachine(machine.id)
  assert.throws(() => createStation(access, { fingerprint: machine.fingerprint }), /bereits/)
  for (const input of [{ fingerprint: 'bad' }, { expiresAt: 0 }, { name: '' }, { mode: 'admin' }, { deviceId: '../unsafe' }])
    assert.throws(() => createStation(access, input))
})

test('Anzeige-Station spiegelt nur die Rollen ihrer Kesher-Kacheln, ohne Kesher-Dienst', async () => {
  const { access } = await setup({ getMirrorRoles: () => ['light', 'light', 'video'] })
  const display = fingerprint()
  const { machine: created } = createStation(access, { fingerprint: display, services: ['multiview'], capabilities: ['display'] })
  const status = access.machineStatus(created.id, created.version)
  assert.deepEqual(status.mirrorRoles, ['light', 'video'])
  assert.deepEqual(status.services, ['multiview'])
  assert.equal(access.machineServes(status, 'kesher'), true)
  assert.equal(access.check({ service: 'kesher', ip }, certificate(display)).action, 'allow')
  const { machine: plain } = createStation(access, { services: ['multiview'], capabilities: ['pi-config'] })
  assert.deepEqual(access.machineStatus(plain.id, plain.version).mirrorRoles, [])
  assert.equal(access.machineServes(access.machineStatus(plain.id, plain.version), 'kesher'), false)
})
