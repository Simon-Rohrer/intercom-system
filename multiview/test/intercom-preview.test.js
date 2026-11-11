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
const common = fs.readFileSync(path.join(publicDir, 'common.js'), 'utf8')
const kesherSource = common.slice(common.indexOf('const isLoopback =')).replace(/^export /gm, '')
const frameSource = kesherSource + source.slice(source.indexOf('/** Person für Kesher-Kacheln'), source.indexOf('\nfunction placeholder('))
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
    location: { hostname: '192.168.0.230' }, embedded, viewer, viewerReady: true, stationUser,
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
  // Reiner Spiegel der Rolle: Mikrofon und Lautsprecher gehören zum echten Gerät der Rolle
  assert.ok(!iframe.allow.includes('microphone'))
  assert.ok(!iframe.allow.includes('speaker-selection'))
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

test('Kachel mit fester Rolle spiegelt immer, ohne eigenes Mikrofon oder Lautsprecher', () => {
  const { url } = setup({ embedded: false })
  assert.equal(url().searchParams.get('secondary'), '1')
  // Alte Kacheln mit Geräteauswahl: die Angaben werden nicht mehr an Kesher gegeben
  const fixed = url({ ...tile, kesherRoleId: 'licht-1', kesherUser: 'Test', kesherAudioIn: 'USB', kesherAudioOut: 'HDMI', kesherHideControls: true })
  assert.equal(fixed.searchParams.get('secondary'), '1')
  assert.equal(fixed.searchParams.get('roleId'), 'licht-1')
  assert.equal(fixed.searchParams.has('autoTakeover'), false)
  assert.equal(fixed.searchParams.has('audioInputMatch'), false)
  assert.equal(fixed.searchParams.has('audioOutputMatch'), false)
  assert.equal(fixed.searchParams.get('controls'), '0')
})

test('Ohne Rolle lädt die Kachel kein Kesher (keine eigene Station am Server)', () => {
  for (const viewer of [null, { ...user, admin: true }]) {
    const { context, frameLayer } = setup({ viewer })
    context.syncFrames(layout)
    assert.equal(frameLayer.children.length, 0)
    assert.equal(context.kesherMissing(tile), 'niemand mit Rolle angemeldet')
  }
  const { context, frameLayer } = setup()
  context.syncFrames({ ...layout, tiles: [{ ...tile, kesherRoleId: '' }] })
  assert.equal(frameLayer.children.length, 0)
  assert.equal(context.kesherMissing({ ...tile, kesherRoleId: '' }), 'keine Rolle gewählt')
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

test('Kesher liegt auf derselben Adresse wie JMS Control (Port 8443), damit die Anmeldung mitgeht', () => {
  const { context } = setup()
  assert.equal(context.kesherPublicOrigin('192.168.0.230'), 'https://192.168.0.230:8443')
  assert.equal(context.kesherPublicOrigin('jmscontrol.internal'), 'https://jmscontrol.internal:8443')
  context.location.hostname = 'multiview.jms.de'
  assert.equal(new URL(context.kesherUrl({ ...tile, kesherRoleId: 'licht-multiview' })).origin, 'https://multiview.jms.de:8443')
})

test('Kachelgröße der Kanäle geht als tileSize an Kesher', () => {
  const { url } = setup({ embedded: false })
  const fixed = { ...tile, kesherRoleId: 'licht-1', kesherUser: 'Test' }
  assert.equal(url({ ...fixed, kesherTileSize: 'large' }).searchParams.get('tileSize'), 'large')
  assert.equal(url({ ...fixed, kesherTileSize: 'small' }).searchParams.get('tileSize'), 'small')
  assert.equal(url(fixed).searchParams.has('tileSize'), false)
  assert.equal(url({ ...fixed, kesherTileSize: 'riesig' }).searchParams.has('tileSize'), false)
})

function watchdog({ viewer = null, display = true, kesherRoleId = 'licht-1' } = {}) {
  const env = setup({ viewer, embedded: false })
  env.context.displayStation = display
  const fixed = { ...tile, kesherRoleId, kesherUser: 'Multiview' }
  env.context.syncFrames({ ...layout, tiles: [fixed] })
  const frame = env.context.frames.get(fixed.id)
  const win = {}
  frame.iframe.contentWindow = win
  frame.iframe.src = 'about:blank#unverändert'
  const report = (signedIn) => env.context.handleKesherMessage({ source: win, data: { type: 'kesher:session', signedIn, connection: 'offline' } })
  const reloaded = () => frame.iframe.src === frame.url
  return { ...env, frame, report, reloaded }
}

test('Abgemeldete Kachel auf einem Anzeige-Gerät lädt nach einer Wartezeit neu (mit Backoff)', () => {
  const { context, frame, report, reloaded } = watchdog()
  report(false)
  context.checkKesherFrames(Date.now() + 60_000) // Kesher versucht es zuerst selbst
  assert.equal(reloaded(), false)
  context.checkKesherFrames(Date.now() + 91_000)
  assert.equal(reloaded(), true)
  assert.equal(frame.renewAttempt, 1)
  // wieder abgemeldet: jetzt erst nach 3 Minuten
  frame.iframe.src = 'about:blank#unverändert'
  report(false)
  context.checkKesherFrames(Date.now() + 120_000)
  assert.equal(reloaded(), false)
  context.checkKesherFrames(Date.now() + 181_000)
  assert.equal(reloaded(), true)
  // angemeldet: Backoff zurückgesetzt
  report(true)
  assert.equal(frame.renewAttempt, 0)
  assert.equal(frame.signedOutSince, null)
})

test('Angemeldete Kachel wird nicht neu geladen, eine stumme schon', () => {
  const { context, frame, report, reloaded } = watchdog()
  report(true)
  context.checkKesherFrames(Date.now() + 100_000)
  assert.equal(reloaded(), false)
  // meldet sich nicht mehr (z. B. Anmeldeseite im Fenster)
  context.checkKesherFrames(Date.now() + 151_000)
  assert.equal(reloaded(), true)
  assert.equal(frame.renewAttempt, 1)
})

test('Ohne Zustandsmeldung (ältere Kesher-Version) lädt JMS Control nie neu', () => {
  const { context, reloaded } = watchdog()
  context.checkKesherFrames(Date.now() + 60 * 60_000)
  assert.equal(reloaded(), false)
})

test('„Angemeldeter Nutzer“ und Browser ohne Anmeldung melden nie als jemand anderes an', () => {
  // Anzeige-Gerät ohne Anmeldung, Kachel „angemeldeter Nutzer“ (Stationsnutzer): nicht neu laden
  const station = setup({ viewer: null, embedded: false, stationUser: { name: 'Test Licht', roleId: 'licht-2' } })
  station.context.displayStation = true
  station.context.syncFrames(layout)
  const userFrame = station.context.frames.get(tile.id)
  userFrame.iframe.contentWindow = {}
  userFrame.iframe.src = 'about:blank#unverändert'
  station.context.handleKesherMessage({ source: userFrame.iframe.contentWindow, data: { type: 'kesher:session', signedIn: false } })
  station.context.checkKesherFrames(Date.now() + 60 * 60_000)
  assert.equal(userFrame.iframe.src, 'about:blank#unverändert')
  // kein Anzeige-Gerät, niemand angemeldet: nicht neu laden
  const plain = watchdog({ display: false })
  plain.report(false)
  plain.context.checkKesherFrames(Date.now() + 60 * 60_000)
  assert.equal(plain.reloaded(), false)
  // angemeldet: die eigene zentrale Anmeldung darf erneut genutzt werden
  const own = watchdog({ viewer: user, display: false })
  own.report(false)
  own.context.checkKesherFrames(Date.now() + 91_000)
  assert.equal(own.reloaded(), true)
})

test('Nachrichten fremder Fenster werden ignoriert', () => {
  const { context, frame, reloaded } = watchdog()
  context.handleKesherMessage({ source: {}, data: { type: 'kesher:session', signedIn: false } })
  context.handleKesherMessage({ source: frame.iframe.contentWindow, data: { type: 'anderes' } })
  context.checkKesherFrames(Date.now() + 60 * 60_000)
  assert.equal(reloaded(), false)
  assert.equal(frame.reported, false)
})
