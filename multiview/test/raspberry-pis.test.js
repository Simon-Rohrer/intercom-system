'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { normalizeRaspberry, launcherConfig, parsePiRequest, createPiRegistry } = require('../raspberry-pis')

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
  assert.equal(RASPBERRY.allowInsecureTls, true)
  assert.equal(RASPBERRY.connectTimeoutSeconds, 30)
  assert.equal(RASPBERRY.audioWaitSeconds, null)
  const [cam] = RASPBERRY.clients
  assert.equal(cam.name, 'Kamera-1') // keine Leerzeichen (Kesher-Benutzername)
  assert.equal(cam.deviceId, 'kamera-1-pi')
  assert.deepEqual(cam.macAddresses, ['b8:27:eb:b2:aa:2d'])
  assert.equal(cam.audioInputMatch, 'Headset')
  assert.deepEqual(normalizeRaspberry(undefined), {
    managed: false, serverUrl: '', allowInsecureTls: true, browserBinary: '',
    audioWaitSeconds: null, displaySettleSeconds: null, connectTimeoutSeconds: null, clients: [],
  })
})

test('Pi bekommt nur seinen eigenen Eintrag, im Format der Datei', () => {
  const res = launcherConfig(RASPBERRY, { macs: ['b8:27:eb:b2:aa:2d'], ips: ['192.168.0.157'] })
  assert.deepEqual(res, {
    managed: true,
    config: {
      allow_insecure_tls: true,
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
  // Ohne MACs im Eintrag zählt die IP
  assert.equal(launcherConfig(RASPBERRY, { ips: ['192.168.0.50'] }).config.clients[0].name, 'FOH')
  // Unvollständige Einträge (ohne Rolle) gehen nicht raus
  assert.deepEqual(launcherConfig(RASPBERRY, { macs: ['b8:27:eb:00:00:01'] }).config.clients, [])
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
