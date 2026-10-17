'use strict'

const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createMessageLinks } = require('../message-links')

const fresh = () => createMessageLinks({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'msg-links-')) })

test('Link anlegen, finden, sperren und erneuern', () => {
  const links = fresh()
  const link = links.create({ name: '  Ordner  ', beamer: true })
  assert.strictEqual(link.name, 'Ordner')
  assert.strictEqual(links.byToken(link.token).id, link.id)
  assert.strictEqual(links.byToken('falsch'), null)

  links.update(link.id, { enabled: false })
  assert.strictEqual(links.byToken(link.token), null)

  links.update(link.id, { enabled: true, renew: true })
  assert.strictEqual(links.byToken(link.token), null, 'alter Link gilt nach dem Erneuern nicht mehr')
  assert.ok(links.byToken(links.list()[0].token))
})

test('Ohne Namen oder Ziel kein Link', () => {
  const links = fresh()
  assert.throws(() => links.create({ name: '', beamer: true }), /Namen/)
  assert.throws(() => links.create({ name: 'Ordner' }), /Beamer oder Stage/)
})

test('Bremse: höchstens eine Nachricht alle 10 Sekunden', () => {
  const links = fresh()
  const link = links.create({ name: 'Ordner', stage: true })
  links.check(link, 1000)
  links.record(link, 1000)
  assert.throws(() => links.check(link, 5000), /warten/)
  links.check(link, 11_001)
  assert.strictEqual(links.list()[0].used, 1)
})
