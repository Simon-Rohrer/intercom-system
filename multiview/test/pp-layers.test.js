'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPpLayers, sameMedia } = require('../pp-layers')

/** Kleines ProPresenter zum Testen: Zustand + Protokoll der ausgelösten Befehle */
function fakePp(state) {
  const sent = []
  const get = async (path) => {
    if (path === '/v1/status/layers') return { ...state.layers }
    if (path in state.get) return state.get[path]
    return null
  }
  const send = async (path, opts = {}) => {
    sent.push(opts.method ? `${opts.method} ${path} ${JSON.stringify(opts.body)}` : path)
    const m = path.match(/^\/v1\/clear\/layer\/(\w+)$/)
    if (m) state.layers[m[1]] = false
    if (/\/presentation\/.*\/trigger$/.test(path)) state.layers.slide = true
  }
  return { sent, get, send }
}

const target = { presentation: { uuid: 'SONG' }, index: 4 }
const bg = { presentation: 'SONG', cue: 0, label: 'fractal-glow-17-hd' }

test('Text: aus, dann dieselbe Folie wieder ein', async () => {
  const state = { layers: { slide: true, media: true }, get: {} }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => target, backgroundAt: async () => bg })
  assert.deepEqual(await layers.toggle('slide'), { layer: 'slide', visible: false })
  assert.deepEqual(await layers.toggle('slide'), { layer: 'slide', visible: true })
  assert.deepEqual(pp.sent, ['/v1/clear/layer/slide', '/v1/presentation/SONG/4/trigger'])
})

test('Hintergrund: Folie mit dem Hintergrund neu, danach wieder der Text darüber', async () => {
  const state = { layers: { slide: true, media: true }, get: { '/v1/transport/presentation/current': { uuid: 'X', name: 'fractal-glow-17-hd.mp4' } } }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => target, backgroundAt: async () => bg })
  await layers.toggle('media')
  state.layers.media = false
  await layers.toggle('media')
  assert.deepEqual(pp.sent, ['/v1/clear/layer/media', '/v1/presentation/SONG/0/trigger', '/v1/presentation/SONG/4/trigger'])
})

test('Hintergrund ohne Text: nach der Hintergrund-Folie den Text wieder ausblenden', async () => {
  const state = { layers: { slide: false, media: true }, get: { '/v1/transport/presentation/current': { uuid: 'X', name: 'fractal-glow-17-hd.mp4' } } }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => target, backgroundAt: async () => bg })
  await layers.toggle('media')
  await layers.toggle('media')
  assert.deepEqual(pp.sent, ['/v1/clear/layer/media', '/v1/presentation/SONG/0/trigger', '/v1/clear/layer/slide'])
})

test('Hintergrund aus der Media-Bibliothek: über die Playlist neu auslösen', async () => {
  const state = {
    layers: { slide: false, media: true },
    get: {
      '/v1/transport/presentation/current': { uuid: 'M1', name: 'loop.mp4' },
      '/v1/media/playlists': [{ id: { uuid: 'PL' }, type: 'playlist', children: [] }],
      '/v1/media/playlist/PL': { items: [{ id: { uuid: 'M1', name: 'loop.mp4' } }] },
    },
  }
  const pp = fakePp(state)
  // Beschriftung der Folie passt nicht zum laufenden Medium → nicht die Folie auslösen
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => target, backgroundAt: async () => bg })
  await layers.toggle('media')
  await layers.toggle('media')
  assert.deepEqual(pp.sent, ['/v1/clear/layer/media', '/v1/media/playlist/PL/M1/trigger'])
})

test('Meldungen und Props: die aktiven wieder auslösen (Meldung mit Platzhaltern)', async () => {
  const tokens = [{ name: 'Text', text: { text: 'Hallo' } }]
  const state = {
    layers: { messages: true, props: true },
    get: {
      '/v1/messages': [{ id: { uuid: 'MSG' }, tokens, is_active: true }, { id: { uuid: 'OFF' }, is_active: false }],
      '/v1/props': [{ id: { uuid: 'P1' }, is_active: true }],
    },
  }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => null, backgroundAt: async () => null })
  await layers.toggle('messages')
  await layers.toggle('messages')
  await layers.toggle('props')
  await layers.toggle('props')
  assert.deepEqual(pp.sent, [
    '/v1/clear/layer/messages', `POST /v1/message/MSG/trigger ${JSON.stringify(tokens)}`,
    '/v1/clear/layer/props', '/v1/prop/P1/trigger',
  ])
})

test('Audio: aus der Playlist an derselben Stelle weiter', async () => {
  const state = {
    layers: { audio: true },
    get: {
      '/v1/transport/audio/current': { uuid: 'A1', name: 'Intro.mp3' },
      '/v1/transport/audio/time': 42.5,
      '/v1/audio/playlists': [{ id: { uuid: 'AP' }, type: 'playlist', children: [] }],
      '/v1/audio/playlist/AP': { items: [{ id: { uuid: 'A1', name: 'Intro.mp3' } }] },
    },
  }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => null, backgroundAt: async () => null })
  await layers.toggle('audio')
  await layers.toggle('audio')
  assert.deepEqual(pp.sent, ['/v1/clear/layer/audio', '/v1/audio/playlist/AP/A1/trigger', 'PUT /v1/transport/audio/time 42.5'])
})

test('Alles: sichtbare Ebenen aus, dann Hintergrund vor Text wieder ein', async () => {
  const state = { layers: { slide: true, media: true, audio: false }, get: { '/v1/transport/presentation/current': { uuid: 'X', name: 'fractal-glow-17-hd.mp4' } } }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => target, backgroundAt: async () => bg })
  assert.deepEqual(await layers.toggle('all'), { layer: 'all', visible: false })
  assert.deepEqual(await layers.toggle('all'), { layer: 'all', visible: true })
  assert.deepEqual(pp.sent, ['/v1/clear/layer/slide', '/v1/clear/layer/media', '/v1/presentation/SONG/0/trigger', '/v1/presentation/SONG/4/trigger'])
})

test('Nichts gemerkt: verständlicher Fehler statt stillem Nichts', async () => {
  const pp = fakePp({ layers: {}, get: {} })
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => null, backgroundAt: async () => null })
  await assert.rejects(layers.toggle('props'), /Keine Props/)
  await assert.rejects(layers.toggle('all'), /Nichts zum Einblenden/)
  await assert.rejects(layers.toggle('foo'), /Unbekannte Ebene/)
})

test('Medienname passt zur Folien-Beschriftung', () => {
  assert.equal(sameMedia('fractal-glow-17-hd', 'fractal-glow-17-hd.mp4'), true)
  assert.equal(sameMedia('Hauskreis_Folie.jpg', 'Hauskreis Folie.jpg'), true)
  assert.equal(sameMedia('illuminate-11', 'loop.mp4'), false)
  assert.equal(sameMedia('fractal-glow-17', 'fractal-glow-17-hd.mp4'), false)
  assert.equal(sameMedia('', 'x.mp4'), false)
})

test('Hintergrund aus einer Folien-Aktion: in der Media-Playlist über den Namen ohne Endung gefunden', async () => {
  const state = {
    layers: { slide: false, media: true },
    get: {
      '/v1/transport/presentation/current': { uuid: 'ANDERE-ID', name: 'fractal-glow-17-hd.mp4' },
      '/v1/media/playlists': [{ id: { uuid: 'FAV' }, type: 'playlist', children: [] }],
      '/v1/media/playlist/FAV': { items: [{ id: { uuid: 'X17', name: 'fractal-glow-17' } }, { id: { uuid: 'X17HD', name: 'fractal-glow-17-hd' } }] },
    },
  }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => null, backgroundAt: async () => null })
  await layers.toggle('media')
  await layers.toggle('media')
  assert.deepEqual(pp.sent, ['/v1/clear/layer/media', '/v1/media/playlist/FAV/X17HD/trigger'])
})

test('Gemerktes übersteht einen Neustart (gespeichert und wieder geladen)', async () => {
  let stored = {}
  const state = { layers: { slide: true }, get: {} }
  const pp = fakePp(state)
  const make = () => createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => target, backgroundAt: async () => null, load: () => stored, save: (h) => (stored = JSON.parse(JSON.stringify(h))) })
  await make().toggle('slide')
  await make().toggle('slide') // neue Instanz wie nach einem Neustart
  assert.deepEqual(pp.sent, ['/v1/clear/layer/slide', '/v1/presentation/SONG/4/trigger'])
})

test('Direkt in ProPresenter ausgeblendet: die Taste blendet den zuletzt gesehenen Hintergrund ein', async () => {
  const state = {
    layers: { slide: false, media: true },
    get: {
      '/v1/transport/presentation/current': { uuid: 'M1', name: 'loop.mp4' },
      '/v1/media/playlists': [{ id: { uuid: 'PL' }, type: 'playlist', children: [] }],
      '/v1/media/playlist/PL': { items: [{ id: { uuid: 'M1', name: 'loop' } }] },
    },
  }
  const pp = fakePp(state)
  const layers = createPpLayers({ get: pp.get, send: pp.send, slideTarget: () => null, backgroundAt: async () => null })
  await layers.observe({ media: true }, 10_000)
  state.layers.media = false // Bediener drückt „Clear“ in ProPresenter
  await layers.toggle('media')
  assert.deepEqual(pp.sent, ['/v1/media/playlist/PL/M1/trigger'])
})
