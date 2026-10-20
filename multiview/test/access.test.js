'use strict'

const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createAccess, parseNetwork, ipInNetworks, localTime, roleRights, normalizeAccess, applyRestrictedChanges } = require('../access')

const CLIENT = '192.168.0.90'
const ROLES = ['licht', 'video', 'cam1', 'ton', 'lighting', 'regie']
const directories = []
const instances = []

function directory() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  directories.push(temporary)
  return temporary
}

function request(cookies = {}, ip = CLIENT) {
  return {
    headers: { cookie: Object.entries(cookies).map(([name, value]) => name + '=' + encodeURIComponent(value)).join('; ') },
    secure: true, get: () => '', ip,
  }
}

function response() {
  const cookies = {}
  const headers = []
  return {
    cookies, headers,
    setHeader(name, value) { if (name === 'Set-Cookie') this.append(name, value) },
    append(name, value) {
      headers.push([name, value])
      const pair = String(value).split(';')[0]
      const separator = pair.indexOf('=')
      cookies[pair.slice(0, separator)] = decodeURIComponent(pair.slice(separator + 1))
    },
  }
}

function create(options = {}) {
  const access = createAccess({
    dataDir: directory(), log: () => {}, getRoles: () => ROLES,
    ipOf: (req) => req?.ip ?? CLIENT, ...options,
  })
  instances.push(access)
  return access
}

async function setup(options = {}) {
  const dataDir = directory()
  const access = create({ dataDir, allowBootstrap: true, ...options })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true }, request())
  return { access, dataDir }
}

async function loginAs(access, roleId = 'video', cookies = {}, ip = CLIENT, name = 'Tim') {
  const res = response()
  await access.login({ name, roleId, pin: '123456' }, request(cookies, ip), res)
  return { ...cookies, ...res.cookies }
}

function approve(access, ip = CLIENT) {
  const res = response()
  access.redeemDayCode(access.dayCode().code, ip, request({}, ip), res)
  return res.cookies
}

function flow(origin = 'https://intercom.local') {
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  return { issue: { audienceOrigin: origin, codeChallenge }, redeem: { audienceOrigin: origin, codeVerifier } }
}

function berlin(iso, offset = '+02:00') {
  return Date.parse(iso + offset)
}

after(() => {
  for (const access of instances) access.flush()
  for (const temporary of directories) fs.rmSync(temporary, { recursive: true, force: true })
})

test('Kesher PIN verification receives the original client request', async () => {
  const req = request({}, '192.0.2.9')
  let calls = 0
  const access = create({ allowBootstrap: true, verifyKesherPin: async (pin, original) => {
    assert.equal(pin, '123456')
    assert.equal(original, req)
    calls++
    return true
  } })
  await access.setAdminPin({ pin: '123456', source: 'kesher' }, { open: true }, req)
  await access.login({ name: 'Admin', roleId: 'admin', pin: '123456' }, req, response())
  assert.equal(calls, 2)
})

test('IPv4, IPv6 und Netze werden geprüft', () => {
  const networks = ['192.168.0.0/24', '10.8.0.2'].map(parseNetwork)
  assert.ok(ipInNetworks('192.168.0.77', networks))
  assert.ok(ipInNetworks('::ffff:192.168.0.5', networks))
  assert.ok(ipInNetworks('10.8.0.2', networks))
  assert.ok(!ipInNetworks('10.8.0.3', networks))
  assert.ok(!ipInNetworks('192.168.1.5', networks))
  assert.equal(parseNetwork('192.168.0.300'), null)
  assert.equal(parseNetwork('kein netz'), null)
  assert.equal(parseNetwork('::::'), null)
  assert.equal(ipInNetworks('448.168.0.1', networks), false)
  assert.ok(ipInNetworks('1.2.3.4', [parseNetwork('0.0.0.0/0')]))
})

test('Berliner Datum und Stunde', () => {
  assert.deepEqual(localTime(berlin('2026-10-14T23:30:00')), { day: '2026-10-14', hour: 23 })
  assert.deepEqual(localTime(berlin('2026-10-15T00:10:00')), { day: '2026-10-15', hour: 0 })
})

test('fehlende oder beschädigte Sicherheitsdatei öffnet niemals den Zugang', () => {
  const dataDir = directory()
  assert.throws(() => create({ dataDir }), /bleibt gesperrt/)
  fs.writeFileSync(path.join(dataDir, 'access-secret.json'), '{broken')
  assert.throws(() => create({ dataDir, allowBootstrap: true }), /bleibt gesperrt/)
  fs.writeFileSync(path.join(dataDir, 'access-secret.json'), JSON.stringify({ adminPin: null }))
  assert.throws(() => create({ dataDir, allowBootstrap: true }), /keine gültige Admin-PIN/)
})

test('Bootstrap muss ausdrücklich erlaubt sein und endet mit Einrichtung der PIN', async () => {
  const access = create({ allowBootstrap: true })
  assert.equal(access.userOf(request()).open, true)
  assert.throws(() => access.setGateway({ enabled: true }), /Admin-PIN/)
  await access.setAdminPin({ pin: '123456' }, { open: true }, request())
  assert.equal(access.userOf(request()), null)
  await assert.rejects(access.setAdminPin({ off: true }, { admin: true }, request()), /nicht ohne Admin-PIN/)
})

test('Legacy-Sessions und Gerätefreigaben werden beim Upgrade verworfen', async () => {
  const { access, dataDir } = await setup()
  const cookies = await loginAs(access, 'admin')
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'access-secret.json'), 'utf8'))
  delete stored.securityFormat
  stored.devices.old = { gen: 'legacy', created: Date.now(), ip: CLIENT }
  fs.writeFileSync(path.join(dataDir, 'access-secret.json'), JSON.stringify(stored))
  const upgraded = create({ dataDir })
  assert.equal(upgraded.userOf(request(cookies)), null)
  assert.deepEqual(upgraded.sessions(), [])
  assert.equal(upgraded.devicesToday(), 0)
})

test('aktuelle Sitzungen überstehen Neustart nur bis zum gespeicherten Ablauf', async () => {
  const { access, dataDir } = await setup()
  const cookies = await loginAs(access)
  const restored = create({ dataDir })
  assert.equal(restored.userOf(request(cookies)).name, 'Tim')
})

test('ungültige oder doppelte Cookies verursachen keinen Absturz und keine Anmeldung', async () => {
  const { access } = await setup()
  const cookies = await loginAs(access, 'admin')
  const malformed = request()
  malformed.headers.cookie = 'bad=%; mv_session=%E0%A4%A'
  assert.equal(access.userOf(malformed), null)
  malformed.headers.cookie = 'mv_session=' + cookies.mv_session + '; mv_session=invalid'
  assert.equal(access.userOf(malformed), null)
  malformed.headers.cookie = 'unrelated=%; mv_session=' + cookies.mv_session
  assert.equal(access.userOf(malformed).admin, true)
})

test('unbekannte Rolle hat keine Rechte zum Erstellen von Layouts', () => {
  const rights = roleRights({ access: { roles: {} } }, { roleId: 'unknown', admin: false })
  assert.deepEqual(rights, { admin: false, outputs: [], edit: [], editLayouts: false, controlSlides: false })
  assert.equal(roleRights({ access: { roles: {} } }, { roleId: '__proto__', admin: false }).editLayouts, false)
})

test('Foliensteuerung ist ein ausdrückliches Recht und kann von normalen Rollen nicht selbst vergeben werden', () => {
  const access = normalizeAccess({ roles: { video: { outputs: ['out1'], controlSlides: true }, lighting: { outputs: ['out1'] } } })
  assert.equal(access.roles.video.controlSlides, true)
  assert.equal(access.roles.lighting.controlSlides, false)
  assert.equal(normalizeAccess({ roles: { video: { controlSlides: 'true' } } }).roles.video.controlSlides, false)
  const config = { access, layouts: [], outputs: [] }
  const changed = applyRestrictedChanges(config, { ...config, access: { roles: { lighting: { controlSlides: true } } } }, { roleId: 'lighting', admin: false })
  assert.equal(changed.access.roles.lighting.controlSlides, false)
  assert.equal(changed.access.roles.video.controlSlides, true)
})

test('Anmeldung prüft gültige Rollen und Gerätefreigabe vor Sessionausgabe', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  await assert.rejects(loginAs(access, 'unknown'), /gültige Rolle/)
  await assert.rejects(loginAs(access), /Tagescode/)
  assert.deepEqual(access.sessions(), [])
  const cookies = await loginAs(access, 'video', approve(access))
  assert.equal(access.check({ service: 'kesher', ip: CLIENT }, request(cookies)).action, 'allow')
  assert.equal(access.check({ service: 'companion', ip: CLIENT }, request(cookies)).action, 'forbidden')
  assert.equal(access.check({ service: 'unbekannt', ip: CLIENT }, request(cookies)).action, 'forbidden')
  assert.equal(access.userOf(request({ mv_session: cookies.mv_session })), null)
  assert.equal(access.trusted(CLIENT, request({ mv_session: cookies.mv_session })), false)
})

test('Admin-Einstieg braucht PIN und keinen Tagescode', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const cookies = await loginAs(access, 'admin')
  assert.equal(access.check({ service: 'companion', ip: CLIENT }, request(cookies)).action, 'allow')
  assert.equal(access.deviceStatus(CLIENT, request(cookies)).required, false)
  await assert.rejects(access.login({ name: 'Admin', roleId: 'admin', pin: '000000' }, request(), response(), { pinChecked: true }), /PIN falsch/)
})

test('IP-Ausnahmen können nicht mehr angelegt werden', async () => {
  const { access } = await setup()
  assert.throws(() => access.setGateway({ exempt: [{ network: '192.168.0.161', label: 'Raspberry' }] }), /IP-Ausnahmen/)
  assert.throws(() => access.setGateway({ exempt: [{ network: '192.168.0.101', login: true }] }), /IP-Ausnahmen/)
  assert.throws(() => access.setGateway({ exempt: ['wrong'] }), /IP-Ausnahmen/)
  assert.throws(() => access.setGateway({ exempt: ['192.168.0.0/24'] }), /IP-Ausnahmen/)
})

test('eigene Serveradressen und Loopback besitzen keinen Maschinenzugang', async (context) => {
  context.mock.method(os, 'networkInterfaces', () => ({ lan: [{ address: '192.168.0.21' }] }))
  const { access } = await setup()
  access.setGateway({ enabled: true })
  for (const address of ['192.168.0.21', '127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(access.check({ service: 'kesher', ip: address }, request({}, address)).action, 'code')
    assert.equal(access.check({ service: 'companion', ip: address }, request({}, address)).action, 'code')
    assert.equal(access.trusted(address, request({}, address)), false)
  }
})

test('MAC-Adressen übertragen weder feste noch dynamische Freigaben', async () => {
  const { access } = await setup({ macOf: () => 'aa:bb:cc:dd:ee:ff' })
  access.setGateway({ enabled: true })
  assert.equal(access.deviceStatus('fe80::67', request({}, 'fe80::67')).approved, false)
  const cookies = approve(access)
  assert.equal(access.deviceStatus(CLIENT, request(cookies)).approved, true)
  assert.equal(access.deviceStatus(CLIENT, request()).approved, false)
  assert.equal(access.deviceStatus('fe80::90', request({}, 'fe80::90')).approved, false)
})

test('Logout widerruft die Session, lässt aber Tagesfreigabe im Browser bestehen', async () => {
  const revoked = []
  const { access } = await setup({ onRevoke: (ids) => revoked.push(...ids) })
  access.setGateway({ enabled: true })
  const cookies = await loginAs(access, 'video', approve(access))
  const id = access.userOf(request(cookies)).sessionId
  access.logout(request(cookies), response())
  assert.equal(access.check({ service: 'kesher', ip: CLIENT }, request(cookies)).action, 'login')
  assert.equal(access.sessionStatusById(id).active, false)
  assert.ok(revoked.includes(id))
})

test('alle menschlichen Sessions enden um 05:00, unabhängig von Aktivität und Adminstatus', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-14T21:00:00') })
  const revoked = []
  const { access } = await setup({ isLive: () => true, onRevoke: (ids) => revoked.push(...ids) })
  const normal = await loginAs(access)
  const admin = await loginAs(access, 'admin')
  const normalId = access.userOf(request(normal)).sessionId
  const adminId = access.userOf(request(admin)).sessionId
  assert.equal(access.sessionStatusById(adminId).expiresAt, berlin('2026-10-15T05:00:00'))
  context.mock.timers.setTime(berlin('2026-10-15T04:59:59'))
  assert.ok(access.userOf(request(normal)))
  assert.ok(access.userOf(request(admin)))
  context.mock.timers.setTime(berlin('2026-10-15T05:00:00'))
  access.sweep()
  assert.equal(access.userOf(request(normal)), null)
  assert.equal(access.userOf(request(admin)), null)
  assert.ok(revoked.includes(normalId))
  assert.ok(revoked.includes(adminId))
})

test('Anmeldungen und Freigaben zwischen Mitternacht und 05:00 enden ebenfalls um 05:00', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-15T02:00:00') })
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const cookies = await loginAs(access, 'video', approve(access))
  assert.equal(access.userOf(request(cookies)).expiresAt, berlin('2026-10-15T05:00:00'))
  context.mock.timers.setTime(berlin('2026-10-15T05:00:00'))
  assert.equal(access.deviceStatus(CLIENT, request(cookies)).approved, false)
  assert.equal(access.userOf(request(cookies)), null)
})

test('Sessionablauf berücksichtigt Sommerzeitwechsel und Winterzeitwechsel', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-03-28T20:00:00', '+01:00') })
  const { access } = await setup()
  const spring = await loginAs(access)
  assert.equal(access.userOf(request(spring)).expiresAt, berlin('2026-03-29T05:00:00', '+02:00'))
  context.mock.timers.setTime(berlin('2026-10-24T20:00:00', '+02:00'))
  const autumn = await loginAs(access)
  assert.equal(access.userOf(request(autumn)).expiresAt, berlin('2026-10-25T05:00:00', '+01:00'))
})

test('Tagescode rotiert um Mitternacht, alte Freigabe gilt nur bis 05:00', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-14T21:00:00') })
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const previous = access.dayCode()
  const cookies = approve(access)
  context.mock.timers.setTime(berlin('2026-10-15T00:30:00'))
  const current = access.dayCode()
  assert.notEqual(current.gen, previous.gen)
  assert.equal(access.deviceStatus(CLIENT, request(cookies)).approved, true)
  context.mock.timers.setTime(berlin('2026-10-15T05:00:00'))
  assert.equal(access.deviceStatus(CLIENT, request(cookies)).approved, false)
})

test('Codeerneuerung widerruft abhängige Sessions und Freigaben', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const cookies = await loginAs(access, 'video', approve(access))
  access.renewDayCode()
  assert.equal(access.deviceStatus(CLIENT, request(cookies)).approved, false)
  assert.equal(access.userOf(request(cookies)), null)
})

test('Tagescode-Versuchslimit bleibt über Neustart erhalten und sperrt keine anderen IPs', async () => {
  const { access, dataDir } = await setup()
  const wrong = access.dayCode().code === '999999' ? '888888' : '999999'
  for (let attempt = 0; attempt < 8; attempt++)
    assert.throws(() => access.redeemDayCode(wrong, CLIENT, request(), response()), /stimmt nicht/)
  const restarted = create({ dataDir })
  assert.throws(() => restarted.redeemDayCode(restarted.dayCode().code, CLIENT, request(), response()), /Zu viele/)
  assert.doesNotThrow(() => restarted.redeemDayCode(restarted.dayCode().code, '192.168.0.91', request({}, '192.168.0.91'), response()))
})

test('PIN-Versuchslimit bleibt über Neustart erhalten und sperrt keine anderen IPs', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-14T21:00:00') })
  const { access, dataDir } = await setup()
  for (let attempt = 0; attempt < 8; attempt++) {
    await assert.rejects(access.login({ name: 'Admin', roleId: 'admin', pin: '000000' }, request(), response()), /PIN falsch/)
    context.mock.timers.tick(1100)
  }
  const restarted = create({ dataDir })
  await assert.rejects(loginAs(restarted, 'admin'), /Zu viele/)
  assert.ok((await loginAs(restarted, 'admin', {}, '192.168.0.91')).mv_session)
})

test('parallele PIN-Prüfungen derselben IP und globale Konkurrenz sind begrenzt', async () => {
  const pending = []
  const { access, dataDir } = await setup()
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'access-secret.json'), 'utf8'))
  stored.adminPin = { kesher: true }
  fs.writeFileSync(path.join(dataDir, 'access-secret.json'), JSON.stringify(stored))
  const kesher = create({ dataDir, verifyKesherPin: () => new Promise((resolve) => pending.push(resolve)) })
  const attempts = [90, 91, 92, 93].map((suffix) => loginAs(kesher, 'admin', {}, '192.168.0.' + suffix))
  await assert.rejects(loginAs(kesher, 'admin'), /ausgelastet/)
  await assert.rejects(loginAs(kesher, 'admin', {}, '192.168.0.94'), /ausgelastet/)
  for (const resolve of pending) resolve(true)
  await Promise.all(attempts)
  assert.equal(kesher.sessions().length, 4)
  assert.ok(access)
})

test('QR-Ausstellung verlangt aktive Ursprungssession und gültige Freigabe', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  assert.throws(() => access.createQrToken({ name: 'Injected', roleId: 'video' }, request()), /erneut anmelden/)
  const cookies = await loginAs(access, 'video', approve(access))
  const user = access.userOf(request(cookies))
  assert.throws(() => access.createQrToken(user, request({ mv_session: cookies.mv_session })), /Tagescode/)
  const ticket = access.createQrToken(user, request(cookies))
  const phone = response()
  assert.equal(access.redeemQrToken(ticket.token, request({}, '192.168.0.91'), phone), true)
  assert.equal(access.userOf(request(phone.cookies, '192.168.0.91')).roleId, 'video')
  assert.equal(access.redeemQrToken(ticket.token, request(), response()), false)
})

test('QRs und bereits angemeldete Zweitgeräte werden mit Ursprungssession widerrufen', async () => {
  const { access } = await setup()
  const cookies = await loginAs(access, 'admin')
  const user = access.userOf(request(cookies))
  const pending = access.createQrToken(user, request(cookies))
  const used = access.createQrToken(user, request(cookies))
  const phone = response()
  assert.equal(access.redeemQrToken(used.token, request({}, '192.168.0.91'), phone), true)
  access.endSession(user.sessionId)
  assert.equal(access.redeemQrToken(pending.token, request(), response()), false)
  assert.equal(access.userOf(request(phone.cookies)), null)
})

test('PIN-Wechsel widerruft bestehende Adminsessions und ausgestellte QRs', async () => {
  const { access } = await setup()
  const cookies = await loginAs(access, 'admin')
  const user = access.userOf(request(cookies))
  const qr = access.createQrToken(user, request(cookies))
  await access.setAdminPin({ currentPin: '123456', pin: '654321' }, user, request(cookies))
  assert.equal(access.userOf(request(cookies)), null)
  assert.equal(access.redeemQrToken(qr.token, request(), response()), false)
  await assert.rejects(loginAs(access, 'admin'), /PIN falsch/)
})

test('Kesher-PIN-Widerruf beendet Adminrechte, aber keine normalen Rollen', async () => {
  const { access } = await setup()
  const admin = await loginAs(access, 'admin')
  const normal = await loginAs(access)
  const qr = access.createQrToken(access.userOf(request(admin)), request(admin))
  access.revokeAdmins()
  assert.equal(access.userOf(request(admin)), null)
  assert.equal(access.redeemQrToken(qr.token, request(), response()), false)
  assert.equal(access.userOf(request(normal)).roleId, 'video')
})

test('Adminwiderruf während laufender PIN-Prüfung verhindert spätere Sessionausgabe', async () => {
  const { dataDir } = await setup()
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'access-secret.json'), 'utf8'))
  stored.adminPin = { kesher: true }
  fs.writeFileSync(path.join(dataDir, 'access-secret.json'), JSON.stringify(stored))
  let finish
  const access = create({ dataDir, verifyKesherPin: () => new Promise((resolve) => { finish = resolve }) })
  const login = loginAs(access, 'admin')
  access.revokeAdmins()
  finish(true)
  await assert.rejects(login, /geändert/)
  assert.deepEqual(access.sessions(), [])
})

test('SSO bindet Einmalticket an exaktes Ziel und PKCE-Browsernachweis', async () => {
  const { access } = await setup()
  const cookies = await loginAs(access)
  const browser = flow()
  const ticket = access.createSsoTicket(CLIENT, request(cookies), browser.issue)
  assert.throws(() => access.createSsoTicket(CLIENT, request(cookies)), /Ungültiger SSO/)
  assert.equal(access.redeemSsoTicket(ticket, CLIENT, request(), response(), { ...browser.redeem, audienceOrigin: 'https://evil.local' }), false)
  assert.equal(access.redeemSsoTicket(ticket, CLIENT, request(), response(), { ...browser.redeem, codeVerifier: 'x'.repeat(43) }), false)
  const res = response()
  assert.equal(access.redeemSsoTicket(ticket, CLIENT, request(), res, browser.redeem), true)
  assert.equal(access.userOf(request(res.cookies)).sessionId, access.userOf(request(cookies)).sessionId)
  assert.equal(access.redeemSsoTicket(ticket, CLIENT, request(), response(), browser.redeem), false)
  access.logout(request(res.cookies), response())
  assert.equal(access.userOf(request(cookies)), null)
})

test('widerrufene Sessions können auch mit gültigem SSO-Ticket nicht wiederkehren', async () => {
  const { access } = await setup()
  const cookies = await loginAs(access)
  const browser = flow()
  const ticket = access.createSsoTicket(CLIENT, request(cookies), browser.issue)
  access.logout(request(cookies), response())
  assert.equal(access.redeemSsoTicket(ticket, CLIENT, request(), response(), browser.redeem), false)
})

test('SSO und QR übernehmen Vortagsfreigabe unverändert statt sie zu verlängern', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-14T23:55:00') })
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const cookies = await loginAs(access, 'video', approve(access))
  const original = access.deviceStatus(CLIENT, request(cookies))
  context.mock.timers.setTime(berlin('2026-10-15T00:01:00'))
  access.dayCode()
  const browser = flow()
  const ticket = access.createSsoTicket(CLIENT, request(cookies), browser.issue)
  const target = response()
  assert.equal(access.redeemSsoTicket(ticket, 'fe80::90', request({}, 'fe80::90'), target, browser.redeem), true)
  const transferred = access.deviceStatus('fe80::90', request(target.cookies, 'fe80::90'))
  assert.equal(transferred.generation, original.generation)
  assert.equal(transferred.expiresAt, original.expiresAt)
  const qr = access.createQrToken(access.userOf(request(cookies)), request(cookies))
  const phone = response()
  assert.equal(access.redeemQrToken(qr.token, request({}, '192.168.0.91'), phone), true)
  assert.equal(access.deviceStatus('192.168.0.91', request(phone.cookies, '192.168.0.91')).expiresAt, original.expiresAt)
  context.mock.timers.setTime(berlin('2026-10-15T05:00:00'))
  assert.equal(access.userOf(request(target.cookies, 'fe80::90')), null)
  assert.equal(access.userOf(request(phone.cookies, '192.168.0.91')), null)
})

test('SSO überträgt einen Gerätenachweis nicht auf ein fremdes Gerät', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const { key } = access.createMachine({ name: 'Regie', mode: 'code-bypass' })
  const req = request()
  req.socket = { encrypted: true, remoteAddress: CLIENT }
  req.headers['x-jms-device-key'] = key
  const res = response()
  await access.login({ name: 'Tim', roleId: 'video' }, req, res)
  req.headers.cookie = 'mv_session=' + res.cookies.mv_session
  const browser = flow()
  const ticket = access.createSsoTicket(CLIENT, req, browser.issue)
  assert.equal(access.redeemSsoTicket(ticket, '192.168.0.91', request({}, '192.168.0.91'), response(), browser.redeem), false)
})

test('Kesher-Ticket enthält aktive Session, Version, Einmal-ID und begrenztes Ablaufdatum', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-15T04:59:45') })
  const { access } = await setup()
  const cookies = await loginAs(access, 'admin')
  const user = access.userOf(request(cookies))
  assert.throws(() => access.createTicket(user, 'kesher', ''), /JMS_AUTH_SECRET/)
  const [payload, signature] = access.createTicket(user, 'kesher', 'test-secret').split('.')
  assert.equal(signature, crypto.createHmac('sha256', 'test-secret').update(payload).digest('base64url'))
  const ticket = JSON.parse(Buffer.from(payload, 'base64url').toString())
  assert.equal(ticket.sid, user.sessionId)
  assert.equal(ticket.ver, user.version)
  assert.equal(ticket.exp, user.expiresAt)
  assert.equal(ticket.sessionExpiresAt, user.expiresAt)
  assert.ok(ticket.jti.length >= 32)
  assert.equal(ticket.aud, 'kesher')
  access.logout(request(cookies), response())
  assert.throws(() => access.createTicket(user, 'kesher', 'test-secret'), /erneut anmelden/)
})

test('gleichzeitige Anmeldung derselben Rolle erzeugt genau eine Session', async () => {
  let finish
  let lookups = 0
  const { access } = await setup({
    kesherActiveRoles: () => ++lookups === 1 ? new Promise((resolve) => { finish = resolve }) : Promise.resolve([]),
  })
  const first = loginAs(access, 'video', {}, CLIENT, 'Tim')
  const second = loginAs(access, 'video', {}, '192.168.0.91', 'Anna')
  await new Promise((resolve) => setImmediate(resolve))
  finish([])
  const results = await Promise.allSettled([first, second])
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1)
  assert.equal(results.find((result) => result.status === 'rejected').reason.status, 409)
  assert.equal(access.sessions().length, 1)
})

test('belegte Rolle bewahrt bisherige Anmeldung und kann nicht übernommen werden', async () => {
  const { access } = await setup()
  await loginAs(access, 'video', {}, CLIENT, 'Tim')
  const anna = await loginAs(access, 'lighting', {}, '192.168.0.91', 'Anna')
  await assert.rejects(loginAs(access, 'video', anna, '192.168.0.91', 'Anna'), /schon angemeldet/)
  assert.equal(access.userOf(request(anna, '192.168.0.91')).roleId, 'lighting')
})

test('eigene Kesher-Rolle blockiert erneute Anmeldung nicht, fremde belegte Rollen schon', async () => {
  let occupied = []
  const { access } = await setup({ kesherActiveRoles: async () => occupied })
  const cookies = await loginAs(access, 'ton')
  occupied = ['ton', 'lighting']
  assert.ok((await loginAs(access, 'ton', cookies)).mv_session)
  await assert.rejects(loginAs(access, 'lighting'), /direkt in Kesher/)
})

test('entfernte Rollen widerrufen aktive Sessions beim nächsten Zugriff', async () => {
  let roles = [...ROLES]
  const revoked = []
  const { access } = await setup({ getRoles: () => roles, onRevoke: (ids) => revoked.push(...ids) })
  const cookies = await loginAs(access)
  const id = access.userOf(request(cookies)).sessionId
  roles = roles.filter((role) => role !== 'video')
  assert.equal(access.userOf(request(cookies)), null)
  assert.ok(revoked.includes(id))
})

test('unbekannter Rollenzustand beim Kaltstart sperrt temporär ohne intakte Sessions zu löschen', async () => {
  let roles = [...ROLES]
  const revoked = []
  const { access } = await setup({ getRoles: () => roles, onRevoke: (ids) => revoked.push(...ids) })
  const cookies = await loginAs(access)
  const id = access.userOf(request(cookies)).sessionId
  roles = null
  assert.equal(access.userOf(request(cookies)), null)
  assert.equal(access.sessionStatusById(id).active, false)
  access.sweep()
  assert.equal(access.sessions().length, 1)
  assert.deepEqual(revoked, [])
  await assert.rejects(loginAs(access, 'lighting'), (error) => error.status === 503)
  roles = [...ROLES]
  assert.equal(access.userOf(request(cookies)).sessionId, id)
  roles = []
  assert.equal(access.userOf(request(cookies)), null)
  assert.ok(revoked.includes(id))
})

test('auch bei nicht geladenen Rollen erzwingt der Ablauf weiterhin 05:00', async (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-14T21:00:00') })
  let roles = [...ROLES]
  const { access } = await setup({ getRoles: () => roles })
  const cookies = await loginAs(access)
  roles = null
  context.mock.timers.setTime(berlin('2026-10-15T05:00:00'))
  access.sweep()
  roles = [...ROLES]
  assert.equal(access.userOf(request(cookies)), null)
  assert.deepEqual(access.sessions(), [])
})

test('Sessionstatus liefert keine Tokens und abgelaufene Sessions werden ausdrücklich als inaktiv gemeldet', async () => {
  const { access } = await setup()
  const cookies = await loginAs(access)
  const user = access.userOf(request(cookies))
  const state = access.sessionStatusById(user.sessionId)
  assert.deepEqual(Object.keys(state).sort(), ['active', 'admin', 'expiresAt', 'name', 'roleId', 'sessionId', 'version'].sort())
  assert.equal(JSON.stringify(state).includes(cookies.mv_session), false)
  access.endSession(user.sessionId)
  assert.equal(access.sessionStatusById(user.sessionId).active, false)
})
