'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Browser-Modul laden (ohne seinen Takt für die Diashow)
const view = (async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/propresenter.js'), 'utf8')
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const items = [
  { index: 0, name: 'LOBPREIS', type: 'header' },
  { index: 1, name: 'Großer Gott', type: 'presentation', presentation: 'p1' },
  { index: 2, name: '10.000 Gründe', type: 'presentation', presentation: 'p2' },
]

test('Playlist-Kachel: aktive oder feste Playlist', async () => {
  const { shownPlaylist, playlistOptions } = await view
  assert.deepEqual(playlistOptions({ view: 'quatsch', source: 7, seconds: 1, fit: 'x' }), { thumbs: true, size: 1, source: '', sourceName: '', view: 'list', seconds: 3, fit: 'contain' })
  const state = {
    playlist: { uuid: 'aktiv', name: 'Probe', activeIndex: 3, nextIndex: 4, items: [] },
    playlists: { fest: { name: 'Gottesdienst 25.10.', items }, weg: { name: '', items: [], missing: true } },
    presentation: { uuid: 'p2' },
    songs: { p2: [{ group: 'Refrain' }] },
  }
  assert.equal(shownPlaylist(state, playlistOptions({})).name, 'Probe')
  // Feste Playlist, nicht aktiv: das laufende Lied daraus ist markiert
  const fixed = shownPlaylist(state, playlistOptions({ source: 'fest' }))
  assert.equal(fixed.name, 'Gottesdienst 25.10.')
  assert.equal(fixed.activeIndex, 2)
  assert.equal(fixed.nextIndex, null)
  assert.deepEqual(fixed.songs.p2, [{ group: 'Refrain' }])
  // Ist die feste gerade aktiv, gelten laufender und nächster Eintrag von ProPresenter
  assert.equal(shownPlaylist({ ...state, playlist: { ...state.playlist, uuid: 'fest' } }, playlistOptions({ source: 'fest' })).nextIndex, 4)
  assert.equal(shownPlaylist(state, playlistOptions({ source: 'weg' })), null)
})

test('Playlist als Diashow: eingeschaltete Folien der sichtbaren Lieder, in Reihenfolge', async () => {
  const { playlistShowSlides } = await view
  const pl = {
    items: [...items, { index: 3, name: 'Versteckt', type: 'presentation', presentation: 'p3', hidden: true }],
    songs: { p1: [{}, { enabled: false }, {}], p2: [{}], p3: [{}] },
  }
  assert.deepEqual(playlistShowSlides(pl).map((s) => s.key), ['p1:0', 'p1:2', 'p2:0'])
  assert.deepEqual(playlistShowSlides(null), [])
})
