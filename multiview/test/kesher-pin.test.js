'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const http = require('node:http')
const { once } = require('node:events')
const { createKesherChat } = require('../kesher-chat')

test('Kesher PIN bridge signs original client and PIN without creating an admin session', async () => {
  const received = []
  let status = 200
  const backend = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    received.push({ path: request.url, body: JSON.parse(body) })
    response.writeHead(status, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ valid: status === 200 }))
  })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const bridge = createKesherChat({ getConfig: () => ({ url: `http://127.0.0.1:${backend.address().port}` }), onUpdate: () => {}, onFlash: () => {} })
  const options = { sourceIp: '::ffff:192.0.2.8', secret: 'fixture-shared-secret' }
  try {
    assert.equal(await bridge.verifyAdminPin('123456', options), true)
    assert.equal(received[0].path, '/api/admin/pin/verify-central')
    const payload = received[0].body
    assert.equal(payload.sourceIp, '192.0.2.8')
    const digest = crypto.createHash('sha256').update('123456').digest('hex')
    const expected = crypto.createHmac('sha256', options.secret).update(`kesher:verify-pin:192.0.2.8:${payload.issuedAt}:${digest}`).digest('hex')
    assert.equal(payload.signature, expected)
    status = 403
    assert.equal(await bridge.verifyAdminPin('000000', options), false)
    status = 429
    await assert.rejects(bridge.verifyAdminPin('123456', options), (error) => error.status === 429)
    await assert.rejects(bridge.verifyAdminPin('123456', { sourceIp: '192.0.2.8' }), /nicht eingerichtet/)
    assert.equal(received.length, 3)
  } finally {
    bridge.stop()
    await new Promise((resolve) => backend.close(resolve))
  }
})
