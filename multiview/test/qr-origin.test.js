'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Alle QR-Codes zeigen auf die IP des Servers, nie auf .local/.internal-Namen
const common = fs.readFileSync(path.join(__dirname, '../public/common.js'), 'utf8')
const qrSource = common.slice(common.indexOf('const JMS_CONTROL_PORT')).replace(/^export /gm, '')
function at(origin) {
  const url = new URL(origin)
  const context = vm.createContext({ URL, location: { hostname: url.hostname, origin: url.origin } })
  vm.runInContext(qrSource, context)
  return context
}
const addresses = ['172.17.0.1', '100.108.112.34', '192.168.0.230']

test('Über einen Namen geöffnet: QR-Code mit der LAN-IP', () => {
  for (const origin of ['https://jmscontrol.local', 'https://jmscontrol.internal', 'https://multiview.jms.de'])
    assert.equal(at(origin).qrOrigin(addresses), 'https://192.168.0.230:8090')
})

test('Am Kiosk (127.0.0.1) und über die IP', () => {
  assert.equal(at('http://127.0.0.1:8090').qrOrigin(addresses), 'https://192.168.0.230:8090')
  assert.equal(at('https://192.168.0.230:8090').qrOrigin(addresses), 'https://192.168.0.230:8090')
})

test('Eigene Startadresse gilt nur als IP, ein Name wird ersetzt', () => {
  const c = at('https://jmscontrol.local')
  assert.equal(c.qrOrigin(addresses, 'https://jmscontrol.local/'), 'https://192.168.0.230:8090')
  assert.equal(c.qrOrigin(addresses, 'https://192.168.0.30:8090/'), 'https://192.168.0.30:8090')
  assert.equal(c.startUrlIsName('https://jmscontrol.local'), true)
  assert.equal(c.startUrlIsName('https://192.168.0.230:8090'), false)
  assert.equal(c.startUrlIsName(''), false)
})
