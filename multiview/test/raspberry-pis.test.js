'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { normalizeRaspberry, launcherConfig, parsePiRequest, createPiRegistry, piScreenId, answerVersion } = require('../raspberry-pis')

const RASPBERRY = normalizeRaspberry({
  managed: true,
  serverUrl: '192.168.0.21:8443/',
  connectTimeoutSeconds: '30',
  clients: [
    {
      id: 'a',
      name: 'Kamera 1',
      roleId: 'cam1',
      macAddresses: ['B8-27-EB-B2-AA-2D', 'kaputt'],
      audioInputMatch: ' Headset ',
      lowPowerMode: true,
      view: 'station',
    },
    { id: 'b', name: 'FOH', roleId: 'audio', ipAddress: '192.168.0.50' },
    { id: 'c', name: 'Ohne Rolle', macAddresses: ['b8:27:eb:00:00:01'] },
  ],
})

test('Einstellungen werden aufgeräumt', () => {
  assert.equal(RASPBERRY.serverUrl, 'https://192.168.0.21:8443')
  assert.equal(RASPBERRY.allowInsecureTls, false)
  assert.equal(RASPBERRY.connectTimeoutSeconds, 30)
  assert.equal(RASPBERRY.audioWaitSeconds, null)
  const [cam] = RASPBERRY.clients
  assert.equal(cam.name, 'Kamera-1') // keine Leerzeichen (Kesher-Benutzername)
  assert.equal(cam.deviceId, 'kamera-1-pi')
  assert.deepEqual(cam.macAddresses, ['b8:27:eb:b2:aa:2d'])
  assert.equal(cam.audioInputMatch, 'Headset')
  assert.deepEqual(normalizeRaspberry(undefined), {
    managed: false, serverUrl: '', allowInsecureTls: false, browserBinary: '',
    audioWaitSeconds: null, displaySettleSeconds: null, connectTimeoutSeconds: null, clients: [],
  })
})

test('Pi bekommt nur seinen eigenen Eintrag, im Format der Datei', () => {
  const res = launcherConfig(RASPBERRY, { clientId: 'a' })
  assert.deepEqual(res, {
    managed: true,
    config: {
      allow_insecure_tls: false,
      server_url: 'https://192.168.0.21:8443',
      browser_connect_timeout_seconds: 30,
      clients: [
        {
          device_id: 'kamera-1-pi',
          name: 'Kamera-1',
          role_id: 'cam1',
          low_power_mode: true,
          mac_addresses: ['b8:27:eb:b2:aa:2d'],
          audio_input_match: 'Headset',
          simple_view: false,
        },
      ],
    },
  })
  assert.equal(launcherConfig(RASPBERRY, { clientId: 'b' }).config.clients[0].name, 'FOH')
  assert.deepEqual(launcherConfig(RASPBERRY, { clientId: 'c' }).config.clients, [])
  assert.deepEqual(launcherConfig(RASPBERRY, { macs: ['b8:27:eb:b2:aa:2d'], ips: ['192.168.0.50'] }).config.clients, [])
})

test('Anzeige: Intercom ist Standard, Multiview schickt den Bildschirm des Pi mit', () => {
  assert.equal(RASPBERRY.clients[0].display, 'intercom')
  assert.equal(normalizeRaspberry({ clients: [{ id: 'x', display: 'fernseher' }] }).clients[0].display, 'intercom')
  const multiview = normalizeRaspberry({ ...RASPBERRY, clients: [{ ...RASPBERRY.clients[0], display: 'multiview' }] })
  const [client] = launcherConfig(multiview, { clientId: 'a' }).config.clients
  assert.equal(client.display, 'multiview')
  assert.equal(client.screen_id, piScreenId('a'))
  assert.equal(piScreenId('a'), 'pi-a')
  assert.equal(launcherConfig(RASPBERRY, { clientId: 'a' }).config.clients[0].display, undefined)
})

test('Pi meldet Anzeige, Version und Wartezeit (Long-Poll)', () => {
  const req = parsePiRequest({ macs: ['b8:27:eb:b2:aa:2d'], display: 'multiview', version: 'abc', waitSeconds: 600 })
  assert.equal(req.display, 'multiview')
  assert.equal(req.version, 'abc')
  assert.equal(req.waitSeconds, 25) // höchstens 25 s
  const old = parsePiRequest({ macs: ['b8:27:eb:b2:aa:2d'], display: 'fernseher', waitSeconds: '5' })
  assert.deepEqual([old.display, old.version, old.waitSeconds], ['', '', 0])
  const a = launcherConfig(RASPBERRY, { clientId: 'a' })
  assert.equal(answerVersion(a), answerVersion(launcherConfig(RASPBERRY, { clientId: 'a' })))
  const multiview = normalizeRaspberry({ ...RASPBERRY, clients: [{ ...RASPBERRY.clients[0], display: 'multiview' }] })
  assert.notEqual(answerVersion(a), answerVersion(launcherConfig(multiview, { clientId: 'a' })))
})

test('Solange nicht hier verwaltet, gilt die Datei auf dem Pi', () => {
  assert.deepEqual(launcherConfig({ ...RASPBERRY, managed: false }, { macs: ['b8:27:eb:b2:aa:2d'] }), { managed: false })
})

test('Anfrage des Pi wird geprüft, gesehene Pis werden gemerkt', () => {
  const request = parsePiRequest({
    macs: ['B8:27:EB:B2:AA:2D', 'x'],
    ips: ['192.168.0.157', '999.1.1.1'],
    hostname: 'raspberrypi',
    launcherVersion: '10',
    local: { name: 'Kamera-1', role_id: 'cam1', device_id: 'kamera-1-pi', simple_view: true },
  })
  assert.deepEqual(request.macs, ['b8:27:eb:b2:aa:2d'])
  assert.deepEqual(request.ips, ['192.168.0.157'])
  assert.equal(request.local.view, 'simple')
  assert.equal(request.local.roleId, 'cam1')

  let clock = 1000
  const registry = createPiRegistry({ now: () => clock })
  registry.record(request, '::ffff:192.168.0.157')
  clock = 2000
  registry.record(parsePiRequest({ macs: ['dc:a6:32:00:00:09'] }), '192.168.0.160')
  registry.record(parsePiRequest({}), '192.168.0.1') // ohne MAC/IP: nicht merken
  clock = 4000
  const list = registry.list()
  assert.equal(list.length, 2)
  assert.deepEqual(list[0].macs, ['dc:a6:32:00:00:09']) // zuletzt gefragt zuerst
  assert.equal(list[1].hostname, 'raspberrypi')
  assert.equal(list[1].remoteIp, '192.168.0.157')
  assert.equal(list[1].ageMs, 3000)
})
