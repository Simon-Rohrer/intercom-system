'use strict'

const test = require('node:test')
const assert = require('node:assert')
const { createNeighbors } = require('../neighbors')

const TABLE = JSON.stringify([
  { dst: '192.168.0.67', dev: 'enp1s0', lladdr: '38:C9:86:2F:C3:88', state: ['REACHABLE'] },
  { dst: 'fe80::27:c69d:6b92:dc00', dev: 'enp1s0', lladdr: '38:c9:86:2f:c3:88', state: ['STALE'] },
  { dst: '192.168.0.99', dev: 'enp1s0', state: ['FAILED'] },
  { dst: '172.22.0.2', dev: 'br-3f2a9c', lladdr: 'fa:77:e7:14:66:02', state: ['REACHABLE'] },
])

test('MAC-Adresse aus der Nachbartabelle, IPv4 und IPv6', () => {
  let reads = 0
  const { macOf } = createNeighbors({ read: () => (reads++, TABLE), log: () => {} })
  assert.equal(macOf('192.168.0.67'), '38:c9:86:2f:c3:88')
  assert.equal(macOf('::ffff:192.168.0.67'), '38:c9:86:2f:c3:88')
  assert.equal(macOf('FE80::27:C69D:6B92:DC00%enp1s0'), '38:c9:86:2f:c3:88')
  assert.equal(macOf('192.168.0.99'), null) // ohne MAC (nicht erreichbar)
  assert.equal(macOf('172.22.0.2'), null) // Docker-Netz auf dem Server, kein Gerät im LAN
  assert.equal(macOf(''), null)
  assert.equal(reads, 1) // unbekannte Adressen lesen nicht bei jeder Anfrage neu
})

test('ohne ip-Befehl: keine MAC-Adressen, kein Absturz', () => {
  const logs = []
  const { macOf } = createNeighbors({
    read: () => {
      throw new Error('spawn ip ENOENT')
    },
    log: (m) => logs.push(m),
  })
  assert.equal(macOf('192.168.0.67'), null)
  assert.equal(logs.length, 1)
})

test('auch bekannte Adressen werden nach Ablauf der TTL neu eingelesen', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 })
  let current = TABLE
  let reads = 0
  const { macOf } = createNeighbors({ read: () => { reads++; return current }, log: () => {} })
  assert.equal(macOf('192.168.0.67'), '38:c9:86:2f:c3:88')
  current = JSON.stringify([{ dst: '192.168.0.67', dev: 'enp1s0', lladdr: 'aa:bb:cc:dd:ee:ff', state: ['REACHABLE'] }])
  context.mock.timers.tick(2999)
  assert.equal(macOf('192.168.0.67'), '38:c9:86:2f:c3:88')
  context.mock.timers.tick(1)
  assert.equal(macOf('192.168.0.67'), 'aa:bb:cc:dd:ee:ff')
  assert.equal(reads, 2)
})

test('Ladefehler löschen alte Zuordnungen; Erholung lädt frische Daten', (context) => {
  context.mock.timers.enable({ apis: ['Date'], now: 0 })
  let unavailable = false
  const { macOf } = createNeighbors({ read: () => { if (unavailable) throw new Error('offline'); return TABLE }, log: () => {} })
  assert.equal(macOf('192.168.0.67'), '38:c9:86:2f:c3:88')
  unavailable = true
  context.mock.timers.tick(3000)
  assert.equal(macOf('192.168.0.67'), null)
  unavailable = false
  context.mock.timers.tick(3000)
  assert.equal(macOf('192.168.0.67'), '38:c9:86:2f:c3:88')
})

test('fehlgeschlagene Nachbarn werden trotz hinterlegter MAC nicht übernommen', () => {
  const { macOf } = createNeighbors({ read: () => JSON.stringify([
    { dst: '192.168.0.90', dev: 'enp1s0', lladdr: 'aa:bb:cc:dd:ee:ff', state: ['FAILED'] },
    { dst: '192.168.0.91', dev: 'enp1s0', lladdr: 'invalid', state: ['REACHABLE'] },
  ]), log: () => {} })
  assert.equal(macOf('192.168.0.90'), null)
  assert.equal(macOf('192.168.0.91'), null)
})
