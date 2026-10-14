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

test('feste Geräte „nur ohne Code“ brauchen trotzdem Name und Rolle', async () => {
  const { access } = await setup()
  access.setGateway({
    enabled: true,
    exempt: [
      { network: '192.168.0.161', label: 'Raspberry' },
      { network: '192.168.0.101', label: 'Mac Pro7', login: true },
    ],
  })
  assert.deepEqual(access.gateway().exempt.map((e) => e.login), [false, true])
  // Station: weiter ohne alles
  assert.equal(access.check({ service: 'dashboard', ip: '192.168.0.161' }, fakeReq()).action, 'allow')
  assert.equal(access.trusted('192.168.0.161', fakeReq()), true)
  // Arbeitsrechner: kein Code, aber die Anmeldung
  assert.equal(access.deviceStatus('192.168.0.101', fakeReq()).required, false)
  assert.equal(access.check({ service: 'dashboard', ip: '192.168.0.101' }, fakeReq()).action, 'login')
  assert.equal(access.check({ service: 'kesher', ip: '192.168.0.101' }, fakeReq()).action, 'login')
  assert.equal(access.trusted('192.168.0.101', fakeReq()), false)
  const session = await loginAs(access, 'Simon', 'video')
  const check = access.check({ service: 'kesher', ip: '192.168.0.101' }, fakeReq({ mv_session: session }))
  assert.equal(check.action, 'allow')
  assert.equal(check.user.name, 'Simon')
  assert.equal(access.check({ service: 'companion', ip: '192.168.0.101' }, fakeReq({ mv_session: session })).action, 'forbidden')
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

test('Schnittstellen des Multiview: nur angemeldet, feste Geräte oder der Server selbst', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true, exempt: [{ network: '192.168.0.0/28', label: 'Stationen' }] })
  assert.equal(access.trusted('192.168.0.99', fakeReq()), false)
  assert.equal(access.trusted('192.168.0.5', fakeReq()), true)
  assert.equal(access.trusted('127.0.0.1', fakeReq()), true)
  // Tagescode allein reicht nicht, erst mit Name und Rolle
  const res = fakeRes()
  access.redeemDayCode(access.dayCode().code, '192.168.0.99', fakeReq(), res)
  assert.equal(access.trusted('192.168.0.99', fakeReq({ jms_device: res.cookies.jms_device })), false)
  const session = await loginAs(access, 'Simon', 'cam1')
  assert.equal(access.trusted('192.168.0.99', fakeReq({ mv_session: session })), true)
})

test('ohne eingeschaltete Anmeldung sind die Schnittstellen offen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const access = createAccess({ dataDir: dir, log: () => {} })
  assert.equal(access.trusted('192.168.0.99', fakeReq()), true)
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

test('eine direkt in Kesher angemeldete Rolle ist auch hier belegt – wegnehmen geht nicht', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const access = createAccess({ dataDir: dir, log: () => {}, kesherActiveRoles: async () => ['ton'] })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })

  assert.deepEqual(await access.occupiedForLogin(fakeReq()), { ton: 'in Kesher' })
  for (const takeover of [false, true]) {
    await assert.rejects(access.login({ name: 'Tim', roleId: 'ton', takeover }, fakeReq(), fakeRes()), (err) => {
      assert.equal(err.status, 409)
      assert.equal(err.holder.kesher, true)
      return true
    })
  }
})

test('belegte Rolle lässt sich nicht übernehmen', async () => {
  const { access } = await setup()
  await loginAs(access, 'Tim', 'video')
  await assert.rejects(access.login({ name: 'Anna', roleId: 'video', takeover: true }, fakeReq(), fakeRes()), /schon angemeldet – von Tim/)
  assert.deepEqual(access.occupiedRoles(), { video: 'Tim' })
})

test('die eigene Kesher-Seite blockiert die Rolle nicht', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  let inKesher = []
  const access = createAccess({ dataDir: dir, log: () => {}, kesherActiveRoles: async () => inKesher })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })
  const res = fakeRes()
  await access.login({ name: 'Tim', roleId: 'ton' }, fakeReq(), res)
  // Kesher hat "ton", weil Tims Kesher-Seite angemeldet ist – Tim meldet sich im selben Browser neu an
  inKesher = ['ton']
  const again = fakeRes()
  await access.login({ name: 'Tim', roleId: 'ton' }, fakeReq({ mv_session: res.cookies.mv_session }), again)
  assert.ok(again.cookies.mv_session)
  // Andere sehen die Rolle mit Tims Namen
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

test('festes Gerät auch per IPv6 (.local-Namen) frei – erkannt an der MAC-Adresse', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const macs = { '192.168.0.67': 'aa:aa:aa:aa:aa:01', 'fe80::1:2:3:4': 'aa:aa:aa:aa:aa:01', 'fe80::9': 'bb:bb:bb:bb:bb:02' }
  const access = createAccess({ dataDir: dir, log: () => {}, macOf: (ip) => macs[ip] ?? null })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })
  access.setGateway({ enabled: true, exempt: [{ network: '192.168.0.67', label: 'Mac Regie' }] })
  assert.equal(access.check({ service: 'kesher', ip: '192.168.0.67' }, fakeReq()).action, 'allow')
  assert.equal(access.check({ service: 'kesher', ip: 'fe80::1:2:3:4' }, fakeReq()).action, 'allow')
  // anderes Gerät per IPv6: weiter mit Code
  assert.equal(access.check({ service: 'kesher', ip: 'fe80::9' }, fakeReq()).action, 'code')
})

test('Tagescode einmal eingegeben gilt auch unter dem anderen Namen (gleiche MAC-Adresse)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const macs = { '192.168.0.127': 'cc:cc:cc:cc:cc:03', 'fe80::127': 'cc:cc:cc:cc:cc:03' }
  const access = createAccess({ dataDir: dir, log: () => {}, macOf: (ip) => macs[ip] ?? null })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })
  access.setGateway({ enabled: true, exempt: [] })
  // Code über https://192.168.0.21:8443 eingegeben – das Cookie gilt nur dort
  access.redeemDayCode(access.dayCode().code, '192.168.0.127', fakeReq(), fakeRes())
  // intercom.local: kein Cookie, per IPv6 – trotzdem freigeschaltet
  assert.deepEqual(access.deviceStatus('fe80::127', fakeReq()), { required: true, approved: true })
  assert.equal(access.check({ service: 'kesher', ip: 'fe80::127' }, fakeReq()).action, 'login')
  // ein anderes Gerät nicht
  assert.equal(access.check({ service: 'kesher', ip: '192.168.0.200' }, fakeReq()).action, 'code')
  // Freischaltung ohne gespeicherte MAC (vor dem Update): über ihre Adresse nachgeschlagen
  macs['192.168.0.128'] = 'dd:dd:dd:dd:dd:04'
  macs['fe80::128'] = 'dd:dd:dd:dd:dd:04'
  const file = path.join(dir, 'access-secret.json')
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'))
  stored.devices.x = { gen: stored.dayCode.gen, created: Date.now(), ip: '192.168.0.128' }
  fs.writeFileSync(file, JSON.stringify(stored))
  const reloaded = createAccess({ dataDir: dir, log: () => {}, macOf: (ip) => macs[ip] ?? null })
  assert.equal(reloaded.deviceStatus('fe80::128', fakeReq()).approved, true)
  // Neuer Code beendet auch diese Freischaltung
  access.renewDayCode()
  assert.equal(access.check({ service: 'kesher', ip: 'fe80::127' }, fakeReq()).action, 'code')
})

test('Rolle belegt: die bisherige Anmeldung des Browsers bleibt bestehen', async () => {
  const { access } = await setup()
  const tim = await loginAs(access, 'Tim', 'video')
  const anna = await loginAs(access, 'Anna', 'lighting')
  await assert.rejects(access.login({ name: 'Anna', roleId: 'video' }, fakeReq({ mv_session: anna }), fakeRes()), /schon angemeldet/)
  assert.equal(access.userOf(fakeReq({ mv_session: anna }))?.roleId, 'lighting')
  assert.ok(tim)
})

test('Abgleich zwischen Adressen: Ticket gibt dieselbe Anmeldung weiter, Abmelden gilt überall', async () => {
  const { access } = await setup()
  // an der zentralen Adresse (IP) angemeldet
  const central = await loginAs(access, 'Simon', 'lighting')
  const ticket = access.createSsoTicket('192.168.0.64', fakeReq({ mv_session: central }))
  assert.ok(ticket)
  // intercom.local löst das Ticket ein: eigenes Cookie, dieselbe Anmeldung
  const res = fakeRes()
  assert.equal(access.redeemSsoTicket(ticket, '192.168.0.111', fakeReq(), res), true)
  const local = res.cookies.mv_session
  assert.notEqual(local, central)
  assert.equal(access.userOf(fakeReq({ mv_session: local }))?.sessionId, access.userOf(fakeReq({ mv_session: central }))?.sessionId)
  // nur einmal einlösbar
  assert.equal(access.redeemSsoTicket(ticket, '192.168.0.111', fakeReq(), fakeRes()), false)
  // in der Liste der Geräte nur einmal
  assert.equal(access.sessions().filter((s) => s.name === 'Simon').length, 1)
  // Abmelden unter intercom.local meldet auch an der IP ab
  access.logout(fakeReq({ mv_session: local }), fakeRes())
  assert.equal(access.userOf(fakeReq({ mv_session: central })), null)
  // ohne Anmeldung gibt es kein Ticket
  assert.equal(access.createSsoTicket('192.168.0.64', fakeReq()), null)
})

test('Anmelden unter einer Adresse ersetzt die Anmeldung unter allen', async () => {
  const { access } = await setup()
  const central = await loginAs(access, 'Simon', 'lighting')
  const res = fakeRes()
  access.redeemSsoTicket(access.createSsoTicket('', fakeReq({ mv_session: central })), '', fakeReq(), res)
  const local = res.cookies.mv_session
  // unter intercom.local neu als Regie angemeldet
  const res2 = fakeRes()
  await access.login({ name: 'Simon', roleId: 'video' }, fakeReq({ mv_session: local }), res2)
  // die alte Anmeldung gilt an der IP nicht mehr; nach dem Weitergeben gilt dort die neue
  assert.equal(access.userOf(fakeReq({ mv_session: central })), null)
  const res3 = fakeRes()
  access.redeemSsoTicket(access.createSsoTicket('', fakeReq({ mv_session: res2.cookies.mv_session })), '', fakeReq({ mv_session: central }), res3)
  assert.equal(access.userOf(fakeReq({ mv_session: res3.cookies.mv_session }))?.roleId, 'video')
  assert.deepEqual(access.occupiedRoles(), { video: 'Simon' })
})

test('Ticket nimmt die Freischaltung per Tagescode mit', async () => {
  const { access } = await setup()
  access.setGateway({ enabled: true, exempt: [] })
  const dev = fakeRes()
  access.redeemDayCode(access.dayCode().code, '10.99.0.64', fakeReq(), dev)
  const central = await loginAs(access, 'Simon', 'lighting')
  const centralReq = fakeReq({ mv_session: central, jms_device: dev.cookies.jms_device })
  const ticket = access.createSsoTicket('10.99.0.64', centralReq)
  const res = fakeRes()
  access.redeemSsoTicket(ticket, 'fe80::9999', fakeReq(), res)
  assert.ok(res.cookies.jms_device)
  assert.equal(access.check({ service: 'kesher', ip: 'fe80::9999' }, fakeReq(res.cookies)).action, 'allow')
})

test('ohne Cookie keine Anmeldung – auch nicht vom selben Gerät (MAC-Adresse)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mv-access-'))
  const macs = { '172.22.0.2': 'fa:77:e7:14:66:02', '192.168.0.127': 'cc:cc:cc:cc:cc:03' }
  const access = createAccess({ dataDir: dir, log: () => {}, macOf: (ip) => macs[ip] ?? null, ipOf: (req) => req.ip })
  await access.setAdminPin({ pin: '123456', source: 'own' }, { open: true })
  const res = fakeRes()
  await access.login({ name: 'Admin', roleId: 'admin', pin: '123456' }, { ...fakeReq(), ip: '172.22.0.2' }, res)
  assert.equal(access.userOf({ ...fakeReq(), ip: '172.22.0.2' }), null)
  assert.equal(access.userOf({ ...fakeReq({ mv_session: res.cookies.mv_session }), ip: '172.22.0.2' })?.admin, true)
  // Abmelden ohne Cookie beendet keine fremde Anmeldung desselben Geräts
  access.logout({ ...fakeReq(), ip: '172.22.0.2' }, fakeRes())
  assert.equal(access.userOf({ ...fakeReq({ mv_session: res.cookies.mv_session }), ip: '172.22.0.2' })?.admin, true)
})
