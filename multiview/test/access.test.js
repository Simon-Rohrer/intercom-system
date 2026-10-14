'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { createAccess, parseNetwork, ipInNetworks, localTime } = require('../access')

/** Minimaler Ersatz für Express-Anfrage und -Antwort. */
function fakeReq(cookies = {}) {
  return {
    headers: { cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ') },
    secure: false,
    get: () => '',
  }
}

function fakeRes() {
  const cookies = {}
  return {
    cookies,
    setHeader(name, value) {
      if (name === 'Set-Cookie') this.append(name, value)
    },
    append(name, value) {
      const [pair] = String(value).split(';')
      const i = pair.indexOf('=')
      cookies[pair.slice(0, i)] = decodeURIComponent(pair.slice(i + 1))
    },
  }
}

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const access = createAccess({ dataDir: dir, log: () => {} })
  // Admin-PIN einrichten (schaltet die Anmeldung ein)
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })
  return { access, dir }
}

async function loginAs(access, name, roleId, extraCookies = {}) {
  const res = fakeRes()
  await access.login({ name, roleId, pin: '123456' }, fakeReq(extraCookies), res)
  return res.cookies.mv_session
}

/** Zeitpunkt in deutscher Zeit (Oktober = Sommerzeit, UTC+2). */
const berlin = (iso) => new Date(`${iso}+02:00`).getTime()

test('Adressen und Netze', () => {
  const nets = ['192.168.0.0/24', '10.8.0.2'].map(parseNetwork)
  assert.ok(ipInNetworks('192.168.0.77', nets))
  assert.ok(ipInNetworks('::ffff:192.168.0.5', nets))
  assert.ok(ipInNetworks('10.8.0.2', nets))
  assert.ok(!ipInNetworks('10.8.0.3', nets))
  assert.ok(!ipInNetworks('192.168.1.5', nets))
  assert.equal(parseNetwork('192.168.0.300'), null)
  assert.equal(parseNetwork('kein netz'), null)
  assert.ok(ipInNetworks('1.2.3.4', [parseNetwork('0.0.0.0/0')]))
})

test('Tag und Stunde in deutscher Zeit', () => {
  assert.deepStrictEqual(localTime(berlin('2026-10-14T23:30:00')), { day: '2026-10-14', hour: 23 })
  assert.deepStrictEqual(localTime(berlin('2026-10-15T00:10:00')), { day: '2026-10-15', hour: 0 })
})

test('ohne eingeschaltete Anmeldung kommt jeder durch', async () => {
  const { access } = await setup()
  assert.equal(access.check({ service: 'portainer', ip: '192.168.0.50' }, fakeReq()).action, 'allow')
})

test('Ablauf im WLAN: Code, dann Name und Rolle, dann durch', async (t) => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const ip = '192.168.0.50'
  assert.equal(access.check({ service: 'kesher', ip }, fakeReq()).action, 'code')

  // Falscher Code
  assert.throws(() => access.redeemDayCode('000000' === access.dayCode().code ? '111111' : '000000', ip, fakeReq(), fakeRes()), /stimmt nicht/)
  // Richtiger Code schaltet das Gerät frei
  const res = fakeRes()
  access.redeemDayCode(access.dayCode().code, ip, fakeReq(), res)
  const device = res.cookies.jms_device
  assert.ok(device)
  assert.equal(access.check({ service: 'kesher', ip }, fakeReq({ jms_device: device })).action, 'login')

  const session = await loginAs(access, 'Tim', 'licht', { jms_device: device })
  const req = fakeReq({ jms_device: device, mv_session: session })
  const result = access.check({ service: 'kesher', ip }, req)
  assert.equal(result.action, 'allow')
  assert.equal(result.user.name, 'Tim')
  // Admin-Dienste nur für den Admin
  assert.equal(access.check({ service: 'portainer', ip }, req).action, 'forbidden')
  assert.equal(access.check({ service: 'unbekannt', ip }, req).action, 'forbidden')

  // Abmelden: Name + Rolle weg, die Freischaltung mit dem Code bleibt
  access.logout(fakeReq({ mv_session: session }), fakeRes())
  assert.equal(access.check({ service: 'kesher', ip }, fakeReq({ jms_device: device, mv_session: session })).action, 'login')
  t.diagnostic('ok')
})

test('Admin kommt an die Admin-Dienste', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const res = fakeRes()
  access.redeemDayCode(access.dayCode().code, '192.168.0.51', fakeReq(), res)
  const session = await loginAs(access, 'Simon', 'admin')
  const req = fakeReq({ jms_device: res.cookies.jms_device, mv_session: session })
  assert.equal(access.check({ service: 'portainer', ip: '192.168.0.51' }, req).action, 'allow')
})

test('feste Geräte brauchen keinen Code, für Admin-Dienste aber die Anmeldung', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true, exempt: [{ network: '192.168.0.0/28', label: 'Stationen' }] })
  assert.equal(access.check({ service: 'kesher', ip: '192.168.0.5' }, fakeReq()).action, 'allow')
  assert.equal(access.check({ service: 'kesher', ip: '127.0.0.1' }, fakeReq()).action, 'allow')
  assert.equal(access.check({ service: 'companion', ip: '192.168.0.5' }, fakeReq()).action, 'login')
  assert.equal(access.check({ service: 'kesher', ip: '192.168.0.99' }, fakeReq()).action, 'code')
  assert.throws(() => access.setGateway({ exempt: [{ network: 'quatsch' }] }), /Keine gültige Adresse/)
})

test('der Server selbst ist auch über seine LAN-Adresse frei', async (t) => {
  t.mock.method(os, 'networkInterfaces', () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    eno1: [
      { address: '192.168.0.21', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false },
    ],
  }))
  const { access } = await setup()
  // Leere Ausnahmeliste: nur der Server selbst kommt ohne Code durch
  access.setGateway({ enabled: true, exempt: [] })
  assert.equal(access.check({ service: 'kesher', ip: '192.168.0.21' }, fakeReq()).action, 'allow')
  assert.equal(access.check({ service: 'kesher', ip: '::ffff:192.168.0.21' }, fakeReq()).action, 'allow')
  assert.equal(access.check({ service: 'kesher', ip: 'fe80::1%eno1' }, fakeReq()).action, 'allow')
  assert.equal(access.deviceStatus('192.168.0.21', fakeReq()).required, false)
  // Admin-Dienste brauchen trotzdem die Admin-Anmeldung
  assert.equal(access.check({ service: 'portainer', ip: '192.168.0.21' }, fakeReq()).action, 'login')
  // Andere Geräte im selben Netz weiter mit Code
  assert.equal(access.check({ service: 'kesher', ip: '192.168.0.22' }, fakeReq()).action, 'code')
})

test('ohne Admin-PIN lässt sich die Anmeldung für alle Dienste nicht einschalten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const access = createAccess({ dataDir: dir, log: () => {} })
  assert.throws(() => access.setGateway({ enabled: true }), /Admin-PIN/)
})

test('neuer Code um Mitternacht, alte Freischaltung gilt bis 5 Uhr', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: berlin('2026-10-14T21:00:00') })
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const yesterdayCode = access.dayCode().code
  const res = fakeRes()
  access.redeemDayCode(yesterdayCode, '192.168.0.60', fakeReq(), res)
  const req = fakeReq({ jms_device: res.cookies.jms_device })

  t.mock.timers.setTime(berlin('2026-10-15T00:30:00'))
  const today = access.dayCode()
  assert.equal(today.day, '2026-10-15')
  assert.equal(access.deviceStatus('192.168.0.60', req).approved, true)

  t.mock.timers.setTime(berlin('2026-10-15T05:00:00'))
  assert.equal(access.deviceStatus('192.168.0.60', req).approved, false)
  // Der Code von gestern gilt für neue Geräte nicht mehr
  if (yesterdayCode !== access.dayCode().code)
    assert.throws(() => access.redeemDayCode(yesterdayCode, '192.168.0.61', fakeReq(), fakeRes()), /stimmt nicht/)
})

test('„Neuen Code erzeugen“ beendet alle Freischaltungen sofort', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const res = fakeRes()
  access.redeemDayCode(access.dayCode().code, '192.168.0.70', fakeReq(), res)
  const req = fakeReq({ jms_device: res.cookies.jms_device })
  assert.equal(access.deviceStatus('192.168.0.70', req).approved, true)
  access.renewDayCode()
  assert.equal(access.deviceStatus('192.168.0.70', req).approved, false)
})

test('zu viele falsche Codes sperren die Adresse eine Weile', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true })
  const wrong = access.dayCode().code === '999999' ? '888888' : '999999'
  for (let i = 0; i < 8; i++) assert.throws(() => access.redeemDayCode(wrong, '192.168.0.80', fakeReq(), fakeRes()), /stimmt nicht/)
  assert.throws(() => access.redeemDayCode(access.dayCode().code, '192.168.0.80', fakeReq(), fakeRes()), /Zu viele/)
  // Andere Geräte sind nicht betroffen
  access.redeemDayCode(access.dayCode().code, '192.168.0.81', fakeReq(), fakeRes())
})

test('Ticket für Kesher ist signiert und kurz gültig', async () => {
  const { access } = await setup()
  const session = await loginAs(access, 'Simon', 'admin')
  const user = access.userOf(fakeReq({ mv_session: session }))
  assert.throws(() => access.createTicket(user, 'kesher', ''), /JMS_AUTH_SECRET/)
  const ticket = access.createTicket(user, 'kesher', 'geheim-geheim-geheim-geheim-geheim')
  const [payload, signature] = ticket.split('.')
  const expected = crypto.createHmac('sha256', 'geheim-geheim-geheim-geheim-geheim').update(payload).digest('base64url')
  assert.equal(signature, expected)
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString())
  assert.equal(data.admin, true)
  assert.equal(data.aud, 'kesher')
  assert.ok(data.exp > Date.now() && data.exp <= Date.now() + 60_000)
})

test('eine direkt in Kesher angemeldete Rolle ist auch hier belegt', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  let inKesher = ['ton']
  const released = []
  const access = createAccess({
    dataDir: dir,
    log: () => {},
    kesherActiveRoles: async () => inKesher,
    releaseKesherRole: async (roleId, name) => {
      released.push({ roleId, name })
      inKesher = inKesher.filter((id) => id !== roleId)
    },
  })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })

  assert.deepEqual(await access.occupiedForLogin(fakeReq()), { ton: 'in Kesher' })
  // Ohne Übernehmen: abgelehnt, mit dem Hinweis auf Kesher
  await assert.rejects(access.login({ name: 'Tim', roleId: 'ton' }, fakeReq(), fakeRes()), (err) => {
    assert.equal(err.status, 409)
    assert.equal(err.holder.kesher, true)
    return true
  })
  assert.deepEqual(released, [])
  // Übernehmen gibt die Rolle in Kesher frei
  const res = fakeRes()
  await access.login({ name: 'Tim', roleId: 'ton', takeover: true }, fakeReq(), res)
  assert.deepEqual(released, [{ roleId: 'ton', name: 'Tim' }])
  assert.ok(res.cookies.mv_session)
  assert.deepEqual(await access.occupiedForLogin(fakeReq()), { ton: 'Tim' })
})

test('die eigene Kesher-Seite blockiert die Rolle nicht', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const access = createAccess({ dataDir: dir, log: () => {}, kesherActiveRoles: async () => ['ton'] })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })
  // Kesher hat "ton", weil Tims Kesher-Seite angemeldet ist – Tim meldet sich im selben Browser neu an
  const token = await loginAs(access, 'Tim', 'ton').catch(() => null)
  assert.equal(token, null) // erste Anmeldung: Kesher hat die Rolle schon (fremdes Gerät)
  const res = fakeRes()
  await access.login({ name: 'Tim', roleId: 'ton', takeover: true }, fakeReq(), res)
  const again = fakeRes()
  await access.login({ name: 'Tim', roleId: 'ton' }, fakeReq({ mv_session: res.cookies.mv_session }), again)
  assert.ok(again.cookies.mv_session)
  // Andere sehen die Rolle mit Tims Namen, er selbst auch
  assert.deepEqual(await access.occupiedForLogin(fakeReq()), { ton: 'Tim' })
})

test('ist Kesher nicht erreichbar, geht die Anmeldung trotzdem', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const access = createAccess({
    dataDir: dir,
    log: () => {},
    kesherActiveRoles: async () => {
      throw new Error('offline')
    },
  })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })
  assert.ok(await loginAs(access, 'Tim', 'ton'))
  assert.deepEqual(await access.occupiedForLogin(fakeReq()), { ton: 'Tim' })
})
