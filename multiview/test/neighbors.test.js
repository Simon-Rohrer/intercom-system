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
