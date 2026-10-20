'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const source = fs.readFileSync(path.join(__dirname, '../public/admin.js'), 'utf8')

function uiContext(fetch) {
  const context = vm.createContext({ fetch, config: { raspberry: { clients: [{ id: 'pi1', name: 'Kamera <1>', deviceId: 'kamera-1', roleId: 'camera' }] } },
    kesherRoles: () => [{ id: 'admin', name: 'Admin' }, { id: 'camera', name: 'Kamera' }], piDeviceId: (client) => client.deviceId,
    esc: (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]) })
  const helpers = source.slice(source.indexOf('const machineServiceLabels ='), source.indexOf('async function loadGateway()'))
  const forms = source.slice(source.indexOf('function machineRow('), source.indexOf('function renderGateway()'))
  const request = source.slice(source.indexOf('async function changeRegisteredMachine('), source.indexOf("$('#access-gateway-card').addEventListener('click'"))
  vm.runInContext(helpers + forms + request, context)
  return context
}

test('Geräteformular startet ohne Stationsprivilegien und bietet keine IP-Ausnahme', () => {
  const html = uiContext().machineCreateForm()
  assert.match(html, /<option value="code-bypass">/)
  assert.match(html, /name="fingerprint" required/)
  assert.match(html, /name="expiresAt" type="datetime-local" required/)
  assert.equal(html.includes('<option value="admin">'), false)
  assert.equal(html.includes('name="network"'), false)
  const stationInputs = [...html.matchAll(/<(?:input|select)[^>]*name="(?:services|capabilities|roleId|raspberryClientId|deviceId)"[^>]*>/g)]
  assert.ok(stationInputs.length > 10)
  assert.ok(stationInputs.every(([markup]) => markup.includes('disabled')))
  assert.match(html, /Kamera &lt;1&gt;/)
})

test('Geräteliste maskiert Namen und erlaubt Zertifikatrotation nicht für reine Dienstschlüssel', () => {
  const context = uiContext()
  const machine = { id: '123', name: '<script>alert(1)</script>', active: true, mode: 'station', expiresAt: Date.now() + 60_000,
    capabilities: ['control'], services: ['kesher'], fingerprint: 'a'.repeat(64) }
  const html = context.machineRow(machine)
  assert.equal(html.includes('<script>'), false)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /data-machine-revoke="123"/)
  assert.match(html, /data-machine-rotate="123"/)
  const native = context.machineRow({ ...machine, fingerprint: '' })
  assert.equal(native.includes('data-machine-rotate='), false)
  const revoked = context.machineRow({ ...machine, active: false, revokedAt: Date.now() })
  assert.equal(revoked.includes('data-machine-revoke='), false)
  assert.equal(revoked.includes('data-machine-rotate='), false)
})

test('Geräte-API-Helfer gibt niemals den einmaligen Dienstschlüssel an die UI weiter', async () => {
  const requests = []
  const machine = { id: 'registered' }
  const context = uiContext(async (url, options) => {
    requests.push({ url, options })
    return { ok: true, json: async () => ({ ok: true, machine, key: 'private-native-key' }) }
  })
  assert.deepEqual(await context.changeRegisteredMachine('', 'POST', { name: 'Kamera' }), machine)
  assert.equal(requests[0].url, '/api/access/machines')
  assert.equal(requests[0].options.credentials, 'same-origin')
  assert.equal(JSON.parse(requests[0].options.body).name, 'Kamera')
  const failed = uiContext(async () => ({ ok: false, json: async () => ({ error: 'Zertifikat bereits registriert' }) }))
  await assert.rejects(failed.changeRegisteredMachine('', 'POST', {}), /bereits registriert/)
  const offline = uiContext(async () => { throw new Error('offline') })
  await assert.rejects(offline.changeRegisteredMachine('', 'POST', {}), /nicht erreichbar/)
})

test('Unsichere TLS-Schalter und IP-Ausnahmen sind aus dem Verwaltungsformular entfernt', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8')
  assert.equal(source.includes('exemptRow'), false)
  assert.equal(source.includes('data-exempt-remove'), false)
  assert.equal(source.includes('pi-allowInsecureTls'), false)
  assert.equal(html.includes('pi-allowInsecureTls'), false)
  assert.match(html, /TLS-Prüfung ist verpflichtend/)
})
