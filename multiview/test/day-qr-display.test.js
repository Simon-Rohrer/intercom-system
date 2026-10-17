'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../public/output.js'), 'utf8')
const refresh = source.slice(source.indexOf('async function refreshDayQr()'), source.indexOf('setInterval(refreshDayQr'))
function fixture(fetch) {
  const children = { img: {}, figcaption: {} }
  const context = vm.createContext({
    dayQr: { hidden: true, dataset: {}, querySelector: (key) => children[key] },
    dayQrKey: '', dayQrRequest: 0, currentOutputId: 'light',
    config: { outputs: [{ id: 'light', dayQr: { show: true } }, { id: 'sound', dayQr: { show: false } }] },
    fetch, encodeURIComponent, lanOrigin: () => 'https://fixture.invalid',
  })
  vm.runInContext(refresh, context)
  return context
}
const reply = { show: true, code: '123456', corner: 'tl', size: 'l' }
test('QR follows the selected output and hides immediately when that output is disabled', async () => {
  const requests = []
  const c = fixture(async (url) => { requests.push(url); return { json: async () => reply } })
  await c.refreshDayQr()
  assert.deepEqual(requests, ['/api/display/day-code?output=light'])
  assert.equal(c.dayQr.hidden, false)
  assert.equal(c.dayQr.dataset.corner, 'tl')
  assert.equal(c.dayQr.dataset.size, 'l')
  c.config.outputs[0].dayQr.show = false
  await c.refreshDayQr()
  assert.equal(c.dayQr.hidden, true)
  assert.equal(requests.length, 1)
  c.currentOutputId = null
  await c.refreshDayQr()
  assert.equal(c.dayQr.hidden, true)
})
test('a delayed response cannot restore QR after disabling or changing the output', async () => {
  let resolve
  const c = fixture(() => new Promise((done) => { resolve = done }))
  const pending = c.refreshDayQr()
  c.currentOutputId = 'sound'
  await c.refreshDayQr()
  resolve({ json: async () => reply })
  await pending
  assert.equal(c.dayQr.hidden, true)
  assert.equal(c.dayQrKey, '')
})
test('denied or failed requests hide a previously displayed code', async () => {
  const c = fixture(async () => ({ json: async () => reply }))
  await c.refreshDayQr()
  c.fetch = async () => ({ json: async () => ({ show: false, error: 'Forbidden' }) })
  await c.refreshDayQr()
  assert.equal(c.dayQr.hidden, true)
  c.fetch = async () => { throw new Error('offline') }
  await c.refreshDayQr()
  assert.equal(c.dayQr.hidden, true)
})
