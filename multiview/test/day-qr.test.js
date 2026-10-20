'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeDayQr, normalizeOutputDayQr } = require('../day-qr')

test('legacy settings copy independently, preserve explicit overrides and all output fields', () => {
  const old = [{ id: 'a', name: 'Licht', layoutId: 'quad', custom: 42 },
    { id: 'b', dayQr: { show: false, corner: 'tl', size: 'l' } }]
  const result = normalizeOutputDayQr(old, { show: true, corner: 'br', size: 'm' })
  assert.deepEqual(result[0], { ...old[0], dayQr: { show: true, corner: 'br', size: 'm' } })
  assert.deepEqual(result[1], old[1])
  result[0].dayQr.show = false
  assert.equal(old[0].dayQr, undefined)
  assert.notEqual(result[0].dayQr, result[1].dayQr)
  assert.deepEqual(normalizeOutputDayQr(result), result)
})

test('new outputs default to hidden, old disabled settings remain disabled, invalid inputs normalize', () => {
  assert.deepEqual(normalizeDayQr(), { show: false, corner: 'br', size: 's' })
  assert.deepEqual(normalizeDayQr({ show: 'false', corner: 'bad', size: 'huge' }), { show: false, corner: 'br', size: 's' })
  assert.deepEqual(normalizeOutputDayQr([{ id: 'a' }], { show: false, corner: 'tr', size: 'l' })[0].dayQr,
    { show: false, corner: 'tr', size: 'l' })
  for (const corner of ['tl', 'tr', 'bl', 'br']) for (const size of ['s', 'm', 'l']) {
    assert.deepEqual(normalizeDayQr({ show: true, corner, size }), { show: true, corner, size })
  }
})
