const { test } = require('node:test')
const assert = require('node:assert/strict')
const { normalizeOutputDayQr, normalizeTallyFrame } = require('../day-qr')

test('Tally-Rahmen je Ausgabe: Eingang und Stärke, sonst aus', () => {
  assert.deepEqual(normalizeTallyFrame(undefined), { input: null, size: 'm' })
  assert.deepEqual(normalizeTallyFrame({ input: '3', size: 'l' }), { input: 3, size: 'l' })
  assert.deepEqual(normalizeTallyFrame({ input: '', size: 'x' }), { input: null, size: 'm' })
  assert.deepEqual(normalizeTallyFrame({ input: -1 }), { input: null, size: 'm' })
  assert.deepEqual(normalizeTallyFrame({ input: 2.5 }), { input: null, size: 'm' })
})

test('Ausgaben behalten ihre Felder und bekommen einen geprüften Tally-Rahmen', () => {
  const [out] = normalizeOutputDayQr([{ id: 'o1', name: 'Kamera', layoutId: 'l1', tallyFrame: { input: 1, size: 's' } }])
  assert.equal(out.layoutId, 'l1')
  assert.deepEqual(out.tallyFrame, { input: 1, size: 's' })
  assert.equal(normalizeOutputDayQr([{ id: 'o2' }])[0].tallyFrame.input, null)
})
