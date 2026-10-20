'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Execute the existing frame lifecycle and URL builder with a small DOM adapter.
// No network, credentials, audio devices or production sessions are used.
const publicDir = path.join(__dirname, '../public')
const source = fs.readFileSync(path.join(publicDir, 'output.js'), 'utf8')
const frameSource = source.slice(source.indexOf('const isLoopback ='), source.indexOf('\nfunction placeholder('))
const user = { name: 'Test Licht', roleId: 'licht-2', admin: false }
const tile = { id: 'intercom', kind: 'kesher', kesherRoleId: '@user', kesherTakeover: true }
const layout = { id: 'layout', tiles: [tile] }

function setup({ embedded = true, viewer = user, stationUser = null, nextUser = null } = {}) {
  const element = (tag) => ({
    tag, children: [], removed: false,
    append(child) { this.children.push(child); child.parent = this },
    remove() { this.removed = true; this.parent.children = this.parent.children.filter((child) => child !== this) },
  })
  const frameLayer = element('div')
  const requests = []
  const context = vm.createContext({
    URL, URLSearchParams, Map, Set, Boolean, String, JSON,
    config: { chat: { url: 'http://127.0.0.1:8080' }, outputs: [{ id: 'licht', layoutId: 'layout' }], layouts: [layout] },
    location: { hostname: '192.168.0.21' }, embedded, viewer, viewerReady: true, stationUser,
    frames: new Map(), frameLayer, currentOutputId: 'licht', renderedKey: 'old', renders: 0,
    document: { createElement: element }, setInterval() {},
    applyBox(el, value) { el.box = value.id },
    render() { context.renders++ },
    async fetch(url) { requests.push(url); return { async json() { return { user: nextUser } } } },
  })
  vm.runInContext(frameSource, context)
  return { context, frameLayer, requests, url: (value = tile) => new URL(context.kesherUrl(value)) }
}

test('Eingebettete Multiviews zeigen die echte Intercom-Kachel', () => {
  const { context, frameLayer } = setup()
  context.syncFrames(layout)
  assert.equal(frameLayer.children.length, 1)
  const iframe = frameLayer.children[0].children[0]
  assert.equal(iframe.tag, 'iframe')
  assert.equal(iframe.title, 'Kesher-Intercom')
  assert.equal(new URL(iframe.src).searchParams.get('roleId'), user.roleId)
  for (const permission of ['microphone', 'speaker-selection', 'autoplay', 'fullscreen']) assert.ok(iframe.allow.includes(permission))
})

test('Vorschau und Vollbild behalten beim erneuten Aufbau dasselbe Intercom-Fenster', () => {
  const { context, frameLayer } = setup()
  context.syncFrames(layout)
  const original = frameLayer.children[0]
  context.syncFrames({ ...layout, tiles: [{ ...tile, x: 4 }] })
  assert.equal(frameLayer.children[0], original)
  assert.equal(original.removed, false)
})

test('Vorschauen mit Nutzer- oder fester Rolle sind Zweitgeräte ohne Übernahme', () => {
  const { url } = setup()
  for (const role of ['@user', 'gottesdienstleitung']) {
    const params = url({ ...tile, kesherRoleId: role, kesherUser: 'Test Station' }).searchParams
    assert.equal(params.get('secondary'), '1')
    assert.equal(params.has('autoTakeover'), false)
  }
})

test('Monitor-Ansicht erhält ihre bisherige Rollenlogik und Geräteauswahl', () => {
  const { url } = setup({ embedded: false })
  assert.equal(url().searchParams.get('secondary'), '1')
  const fixed = url({ ...tile, kesherRoleId: 'licht-1', kesherUser: 'Test', kesherAudioIn: 'USB', kesherAudioOut: 'HDMI', kesherHideControls: true })
  assert.equal(fixed.searchParams.get('autoTakeover'), '1')
  assert.equal(fixed.searchParams.has('secondary'), false)
  assert.equal(fixed.searchParams.get('audioInputMatch'), 'USB')
  assert.equal(fixed.searchParams.get('audioOutputMatch'), 'HDMI')
  assert.equal(fixed.searchParams.get('controls'), '0')
  assert.equal(url({ ...tile, kesherRoleId: 'licht-1', kesherTakeover: false }).searchParams.has('autoTakeover'), false)
})

test('Ohne Nutzerrolle wird die echte Intercom-Anmeldung ohne erfundene Identität geladen', () => {
  for (const viewer of [null, { ...user, admin: true }]) {
    const { context, frameLayer } = setup({ viewer })
    context.syncFrames(layout)
    assert.equal(frameLayer.children.length, 1)
    const params = new URL(frameLayer.children[0].children[0].src).searchParams
    assert.equal(params.has('autoLogin'), false)
    assert.equal(params.has('roleId'), false)
    assert.equal(params.has('username'), false)
  }
})

test('Der erste Intercom-Aufruf wartet auf die aufgelöste Nutzeridentität', () => {
  const { context, frameLayer } = setup()
  context.viewerReady = false
  context.syncFrames(layout)
  assert.equal(frameLayer.children.length, 0)
  context.viewerReady = true
  context.syncFrames(layout)
  assert.equal(frameLayer.children.length, 1)
  assert.equal(new URL(frameLayer.children[0].children[0].src).searchParams.get('secondary'), '1')
})

test('Zugeordneter Stationsnutzer wird auch in der eingebetteten Ansicht aktualisiert', async () => {
  const { context, requests } = setup({ viewer: null, nextUser: user })
  await context.refreshStationUser()
  assert.deepEqual(requests, ['/api/output/licht/user'])
  assert.equal(context.stationUser, user)
  assert.equal(context.renders, 1)
  await context.refreshStationUser()
  assert.equal(context.renders, 1)
})

test('Entfernte Kacheln werden abgebaut und geänderte Nutzer neu eingebunden', () => {
  const { context, frameLayer } = setup()
  context.syncFrames(layout)
  const original = frameLayer.children[0]
  context.viewer = { ...user, roleId: 'licht-1' }
  context.syncFrames(layout)
  assert.equal(original.removed, true)
  assert.equal(frameLayer.children.length, 1)
  assert.equal(new URL(frameLayer.children[0].children[0].src).searchParams.get('roleId'), 'licht-1')
  context.syncFrames(null)
  assert.equal(frameLayer.children.length, 0)
  assert.equal(context.frames.size, 0)
})

test('Beide äußeren Vorschau-Frames delegieren Mikrofon und Lautsprecher', () => {
  for (const filename of ['admin.js', 'remote.js']) {
    const text = fs.readFileSync(path.join(publicDir, filename), 'utf8')
    const frames = text.match(/<iframe[^>]*(?:outputUrl|output\.html)[^>]*>/g) || []
    assert.ok(frames.length, filename)
    for (const frame of frames) {
      assert.match(frame, /allow="[^"]*microphone/)
      assert.match(frame, /allow="[^"]*speaker-selection/)
    }
  }
  assert.ok(!source.includes('nur auf dem Monitor bedienbar'))
})
