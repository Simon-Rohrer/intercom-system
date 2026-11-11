'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { createPpLayers } = require('../pp-layers')
const { normalizeStandardBackground, listMediaPlaylists, standardBackgroundState } = require('../pp-standard-background')
const { createAccess } = require('../access')

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Kleines ProPresenter zum Testen (wie in pp-layers.test.js), Media-Trigger legt das Medium auf die Media-Ebene */
function fakePp(state) {
  const sent = []
  const get = async (p) => {
    if (p === '/v1/status/layers') return { ...state.layers }
    if (p in state.get) return state.get[p]
    return null
  }
  const send = async (p) => {
    sent.push(p)
    if (state.missing?.includes(p)) throw new Error('ProPresenter antwortet mit HTTP 404')
    const m = p.match(/^\/v1\/clear\/layer\/(\w+)$/)
    if (m) state.layers[m[1]] = false
    if (/^\/v1\/media\/playlist\/.*\/trigger$/.test(p)) state.layers.media = true
  }
  return { sent, get, send }
}

const STD = { playlistUuid: 'FAV', itemUuid: 'BLUE', name: 'color-waves-blue-hd', playlistName: 'FAVORITEN Lichttechnik' }
const library = {
  '/v1/media/playlists': [
    { id: { uuid: 'FAV', name: 'FAVORITEN Lichttechnik' }, type: 'playlist', children: [] },
    { id: { uuid: 'GRP', name: 'Background Playlists' }, type: 'group', children: [
      { id: { uuid: 'HEUTE', name: 'HEUTE' }, type: 'playlist', children: [] },
    ] },
  ],
  '/v1/media/playlist/FAV': { items: [{ id: { uuid: 'BLUE', name: 'color-waves-blue-hd' }, type: 'video' }, { id: { uuid: 'RED', name: 'fractal-glow-17-hd' }, type: 'video' }] },
  '/v1/media/playlist/HEUTE': { items: [{ id: { uuid: 'BLUE2', name: 'color-waves-blue-hd' }, type: 'video' }] },
}

test('Standard-Hintergrund: Medium aus der Playlist auslösen, die Ebenen-Taste blendet genau das aus und wieder ein', async () => {
  const state = { layers: { slide: true, media: false }, get: { ...library, '/v1/transport/presentation/current': { uuid: 'BLUE', name: 'color-waves-blue-hd.mp4' } } }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => null, backgroundAt: async () => null })
  await layers.startMedia(STD)
  assert.equal(layers.seen.media.uuid, 'BLUE')
  await layers.toggle('media')
  await layers.toggle('media')
  assert.deepEqual(pp.sent, ['/v1/media/playlist/FAV/BLUE/trigger', '/v1/clear/layer/media', '/v1/media/playlist/FAV/BLUE/trigger'])
})

test('Standard-Hintergrund nach ausgeblendetem Lied-Hintergrund: nach „Clear“ in ProPresenter kommt der Standard zurück', async () => {
  const target = { presentation: { uuid: 'SONG' }, index: 4 }
  const state = { layers: { slide: true, media: true }, get: { ...library, '/v1/transport/presentation/current': { uuid: 'X', name: 'fractal-glow-17-hd.mp4' } } }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => target, backgroundAt: async () => ({ presentation: 'SONG', cue: 0, label: 'fractal-glow-17-hd' }) })
  await layers.toggle('media') // Lied-Hintergrund ausgeblendet und gemerkt
  await layers.startMedia(STD)
  state.layers.media = false // Bediener drückt „Clear“ direkt in ProPresenter
  await layers.toggle('media')
  assert.deepEqual(pp.sent, ['/v1/clear/layer/media', '/v1/media/playlist/FAV/BLUE/trigger', '/v1/media/playlist/FAV/BLUE/trigger'])
})

test('Standard-Hintergrund verschoben: über ID bzw. Namen in den Media-Playlists gefunden, sonst klarer Fehler', async () => {
  const state = { layers: {}, get: { ...library, '/v1/media/playlist/FAV': { items: [] } }, missing: ['/v1/media/playlist/FAV/BLUE/trigger'] }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => null, backgroundAt: async () => null })
  await layers.startMedia(STD)
  assert.deepEqual(pp.sent, ['/v1/media/playlist/FAV/BLUE/trigger', '/v1/media/playlist/HEUTE/BLUE2/trigger'])
  const empty = fakePp({ layers: {}, get: {}, missing: ['/v1/media/playlist/FAV/BLUE/trigger'] })
  const none = createPpLayers({ get: empty.get, send: empty.send, slideTarget: () => null, backgroundAt: async () => null })
  await assert.rejects(none.startMedia(STD), (err) => err.status === 409 && /color-waves-blue-hd.*neu wählen/.test(err.message))
})

test('Einstellung wird bereinigt: nur mit Playlist- und Medium-ID', () => {
  assert.deepEqual(normalizeStandardBackground({ ...STD, extra: 1 }), STD)
  assert.deepEqual(normalizeStandardBackground({ playlistUuid: ' FAV ', itemUuid: 'BLUE' }), { playlistUuid: 'FAV', itemUuid: 'BLUE', name: '', playlistName: '' })
  assert.equal(normalizeStandardBackground(null), null)
  assert.equal(normalizeStandardBackground({ playlistUuid: 'FAV' }), null)
  assert.equal(normalizeStandardBackground({ playlistUuid: '../x', itemUuid: 'BLUE' }), null)
})

test('Auswahlliste: Playlists mit Einträgen, Gruppen als Pfad, nicht ladbare Playlist leer', async () => {
  const get = async (p) => {
    if (p === '/v1/media/playlist/HEUTE') throw new Error('HTTP 500')
    return library[p] ?? null
  }
  assert.deepEqual(await listMediaPlaylists(get), [
    { uuid: 'FAV', name: 'FAVORITEN Lichttechnik', path: 'FAVORITEN Lichttechnik', items: [
      { uuid: 'BLUE', name: 'color-waves-blue-hd', type: 'video' }, { uuid: 'RED', name: 'fractal-glow-17-hd', type: 'video' },
    ] },
    { uuid: 'HEUTE', name: 'HEUTE', path: 'Background Playlists › HEUTE', items: [] },
  ])
})

test('Rückmeldung „läuft“: Media-Ebene sichtbar und dasselbe Medium (ID oder Name ohne Endung)', () => {
  const pp = { connected: true, layers: { media: true } }
  assert.equal(standardBackgroundState(STD, pp, { uuid: 'BLUE', name: '' }).active, true)
  assert.equal(standardBackgroundState(STD, pp, { uuid: 'OTHER', name: 'color-waves-blue-hd.mp4' }).active, true)
  assert.equal(standardBackgroundState(STD, pp, { uuid: 'OTHER', name: 'fractal-glow-17-hd.mp4' }).active, false)
  assert.equal(standardBackgroundState(STD, { connected: true, layers: { media: false } }, { uuid: 'BLUE' }).active, false)
  assert.equal(standardBackgroundState(STD, pp, null).active, false)
  assert.deepEqual(standardBackgroundState(null, pp, { uuid: 'BLUE' }), { configured: false, name: '', playlist: '', active: false })
  assert.deepEqual(standardBackgroundState(STD, pp, { uuid: 'BLUE' }), { configured: true, name: 'color-waves-blue-hd', playlist: 'FAVORITEN Lichttechnik', active: true })
})

test('Server: Companion-Gerät mit „Steuern“ schaltet den Standard-Hintergrund, /api/state meldet ihn als laufend', { timeout: 30_000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jms-pp-std-'))
  // ProPresenter-Attrappe: nur lesende Abfragen und die Trigger, die der Server schickt
  const pp = { layers: { slide: false, media: false, audio: false }, current: { uuid: '', name: '' }, requests: [] }
  const mock = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json')
    const url = req.url
    if (/trigger|clear/.test(url)) pp.requests.push(url)
    if (url === '/v1/media/playlist/FAV/BLUE/trigger') {
      pp.layers.media = true
      pp.current = { uuid: 'TRANSPORT-ID', name: 'color-waves-blue-hd.mp4' }
      return res.end()
    }
    if (url === '/v1/clear/layer/media') {
      pp.layers.media = false
      return res.end()
    }
    if (url === '/v1/status/layers') return res.end(JSON.stringify(pp.layers))
    if (url === '/v1/transport/presentation/current') return res.end(JSON.stringify(pp.current))
    if (url in library) return res.end(JSON.stringify(library[url]))
    res.end('null')
  })
  let child
  try {
    mock.listen(0, '127.0.0.1')
    await once(mock, 'listening')
    const probe = http.createServer().listen(0, '127.0.0.1')
    await once(probe, 'listening')
    const port = probe.address().port
    await new Promise((resolve) => probe.close(resolve))
    const access = createAccess({ dataDir: directory, allowBootstrap: true, getRoles: () => [], log: () => {} })
    await access.setAdminPin({ pin: '472593', source: 'own' }, { open: true }, { headers: {} })
    access.setGateway({ enabled: true, exempt: [] })
    const proxySecret = crypto.randomBytes(32).toString('hex')
    const register = (name, capabilities) => access.createMachine({ name, services: ['multiview'], capabilities,
      fingerprint: crypto.randomBytes(32).toString('hex'), roleId: 'lighting' }).machine
    const control = register('Companion-JMS-Control', ['control'])
    const display = register('Display', ['display'])
    access.flush()
    const writeConfig = (standardBackground) => fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
      atem: { ip: '' }, sources: [], screens: [], layouts: [], outputs: [],
      propresenter: { host: '127.0.0.1', port: mock.address().port, standardBackground },
      chat: { url: 'http://127.0.0.1:9', username: 'Fixture', roleId: 'chat-monitor' },
    }))
    writeConfig(STD)
    child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
      env: { ...process.env, DATA_DIR: directory, HOST: '127.0.0.1', PORT: String(port), JMS_DISABLE_HARDWARE: '1', JMS_AUTH_SECRET: 'isolated-fixture-secret', JMS_DEVICE_PROXY_SECRET: proxySecret },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    child.stdout.on('data', (chunk) => { logs += chunk })
    child.stderr.on('data', (chunk) => { logs += chunk })
    const request = (route, machine, method = 'GET', body = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
      method,
      headers: { Host: 'jmscontrol.internal', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.90', 'Content-Type': 'application/json',
        'X-JMS-Device-Fingerprint': machine.fingerprint, 'X-JMS-Device-Proxy': proxySecret },
      body: method === 'POST' ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => null) }))
    let ready = false
    for (let attempt = 0; attempt < 100 && !ready; attempt++) {
      if (child.exitCode !== null) throw new Error(`Server beendet: ${logs}`)
      ready = await request('/api/state', control).then((r) => r.status === 200).catch(() => false)
      if (!ready) await wait(50)
    }
    assert.ok(ready, logs)

    const before = await request('/api/state', control)
    assert.deepEqual(before.data.standardBackground, { configured: true, name: 'color-waves-blue-hd', playlist: 'FAVORITEN Lichttechnik', active: false })
    // Anzeige-Gerät darf nicht steuern
    assert.equal((await request('/api/propresenter/standard-background', display, 'POST')).status, 403)
    assert.deepEqual(pp.requests, [])

    const on = await request('/api/propresenter/standard-background', control, 'POST')
    assert.equal(on.status, 200, JSON.stringify(on.data))
    assert.deepEqual(on.data, { ok: true, name: 'color-waves-blue-hd' })
    assert.deepEqual(pp.requests, ['/v1/media/playlist/FAV/BLUE/trigger'])
    let active = false
    for (let attempt = 0; attempt < 60 && !active; attempt++) {
      active = (await request('/api/state', control)).data.standardBackground.active
      if (!active) await wait(100)
    }
    assert.equal(active, true, 'Rückmeldung „Standard-Hintergrund läuft“')

    // Ebenen-Taste „Media“: aus und wieder ein bringt den Standard-Hintergrund zurück
    for (const visible of [false, true]) {
      const toggled = await request('/api/propresenter/control', control, 'POST', { action: 'toggle', layer: 'media' })
      assert.deepEqual(toggled.data, { ok: true, layer: 'media', visible })
    }
    assert.deepEqual(pp.requests, ['/v1/media/playlist/FAV/BLUE/trigger', '/v1/clear/layer/media', '/v1/media/playlist/FAV/BLUE/trigger'])
  } finally {
    if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit') }
    await new Promise((resolve) => mock.close(resolve))
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
