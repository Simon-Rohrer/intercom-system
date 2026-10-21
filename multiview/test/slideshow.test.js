'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createSlideshow, imageType, flattenPlaylists } = require('../slideshow')

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20, 1)])
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 2)])
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diashow-'))

test('Bildformat wird am Inhalt erkannt, nicht am Namen', () => {
  assert.equal(imageType(JPEG), 'jpg')
  assert.equal(imageType(PNG), 'png')
  assert.equal(imageType(Buffer.from('<svg onload=alert(1)>…………')), null)
})

test('Bilder hochladen, Zeitraum setzen, sortieren, löschen', () => {
  const dataDir = dir()
  const updates = []
  const show = createSlideshow({ dataDir, onUpdate: (m) => updates.push(m) })
  const a = show.addImage(JPEG, { title: 'Jugendfreizeit', from: '2026-10-01', to: '2026-10-31' })
  const b = show.addImage(PNG, { title: 'Kinderbibelwoche' })
  assert.throws(() => show.addImage(Buffer.from('kein Bild, nur Text…………')), /Nur Bilder/)
  assert.throws(() => show.updateImage(a.id, { from: '2026-11-02', to: '2026-11-01' }), /vor „von“/)
  show.updateImage(b.id, { enabled: false })
  show.reorder([b.id, a.id])
  let snap = show.snapshot()
  assert.deepEqual(snap.images.map((i) => i.title), ['Kinderbibelwoche', 'Jugendfreizeit'])
  assert.equal(snap.images[0].enabled, false)
  assert.match(snap.images[1].url, /^\/diashow\/bild\/[0-9a-f]+\.jpg$/)
  // Nur Namen aus der Liste werden ausgeliefert
  assert.equal(show.filePath('bild', '../diashow.json'), null)
  assert.ok(fs.existsSync(show.filePath('bild', snap.images[1].url.split('/').pop())))
  show.removeImage(a.id)
  snap = show.snapshot()
  assert.equal(snap.images.length, 1)
  // bleibt nach Neustart erhalten
  assert.equal(createSlideshow({ dataDir }).snapshot().images[0].title, 'Kinderbibelwoche')
  assert.ok(updates.length >= 5)
})

test('ProPresenter-Folien werden zwischengespeichert und bleiben, wenn ProPresenter aus ist', async () => {
  const dataDir = dir()
  let online = true
  const fetchImpl = async (url) => {
    if (!online) throw new TypeError('fetch failed')
    const u = new URL(url)
    const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) })
    if (u.pathname === '/v1/playlists')
      return json([{ id: { uuid: 'g', name: 'Gottesdienst' }, field_type: 'group', children: [{ id: { uuid: 'pl1', name: 'Ankündigungen' }, field_type: 'playlist' }] }])
    if (u.pathname === '/v1/playlist/pl1')
      return json({ items: [{ id: { name: 'Infos' }, presentation_info: { presentation_uuid: 'p1' } }, { id: { name: 'Versteckt' }, is_hidden: true, presentation_info: { presentation_uuid: 'p2' } }] })
    if (u.pathname === '/v1/presentation/p1')
      return json({ presentation: { id: { name: 'Infos' }, groups: [{ slides: [{ enabled: true }, { enabled: false }, { enabled: true }] }] } })
    const thumb = /\/v1\/presentation\/p1\/thumbnail\/(\d+)/.exec(u.pathname)
    if (thumb) return { ok: true, status: 200, arrayBuffer: async () => Buffer.concat([JPEG, Buffer.from([Number(thumb[1])])]) }
    return { ok: false, status: 404, text: async () => '' }
  }
  const show = createSlideshow({ dataDir, getPpBase: () => 'http://pp:1025', fetchImpl })
  await show.setPpPlaylist('ankündigungen')
  let pp = show.snapshot().pp
  assert.equal(pp.state, 'ok')
  assert.equal(pp.slides.length, 2) // ausgeblendete Folie und versteckter Eintrag fehlen
  assert.equal(pp.slides[0].name, 'Infos')
  online = false
  await show.refreshPp()
  pp = show.snapshot().pp
  assert.equal(pp.state, 'cached')
  assert.equal(pp.slides.length, 2)
  assert.match(pp.error, /nicht erreichbar/)
  // auch nach einem Neustart des Servers
  assert.equal(createSlideshow({ dataDir, getPpBase: () => '' }).snapshot().pp.slides.length, 2)
})

test('Playlists in Ordnern werden gefunden', () => {
  assert.deepEqual(flattenPlaylists([{ field_type: 'group', id: { uuid: 'g' }, children: [{ field_type: 'playlist', id: { uuid: 'a', name: 'A' } }] }]), [{ uuid: 'a', name: 'A' }])
})

test('Slider der Webseite: großes Bild, Link und Text je Folie', () => {
  const { parseWebsiteSlides } = require('../slideshow')
  const html = `<div class="hero swiper--hero"><div class="swiper-wrapper">
    <div class="swiper-slide"> <a class="swiper-slide-content has-mobile-image" href="/gruppen/1-test" target="_blank">
      <picture class="slide__image-desktop"><source media="(min-width: 1100px)" srcset="/img/a.w-1920.png 1x, /img/a.dpr-2.png 2x"><img src="data:x"></picture>
      <picture class="slide__image-mobile"><source srcset="/img/a-mobil.png 1x"></picture></a></div>
    <div class="swiper-slide"> <span class="swiper-slide-content">
      <picture class="slide__image-desktop"><source srcset="/img/b.png 1x"></picture>
      <h2>GOTT erleben &amp; feiern</h2><p>Jeden Sonntag</p> Weiterlesen</span></div>
  </div><div class="swiper-pagination"></div></div><main>Rest</main>`
  const slides = parseWebsiteSlides(html, 'https://www.example.org/')
  assert.deepEqual(slides, [
    { url: 'https://www.example.org/img/a.dpr-2.png', link: 'https://www.example.org/gruppen/1-test', text: '' },
    { url: 'https://www.example.org/img/b.png', link: '', text: 'GOTT erleben & feiern Jeden Sonntag' },
  ])
  assert.deepEqual(parseWebsiteSlides('<html>kein Slider</html>', 'https://x.org/'), [])
})

test('ChurchTools-Termine: je Termin nur der nächste, ohne interne und vergangene', () => {
  const { mapAppointments } = require('../slideshow')
  const now = Date.parse('2026-10-21T12:00:00Z')
  const entry = (id, start, extra = {}) => ({
    appointment: {
      base: { id, title: `Termin ${id}`, calendar: { name: 'Jugend' }, address: { meetingAt: 'HISplace' }, image: { imageUrl: `https://jms.church.tools/images/${id}/abc123` }, ...extra },
      calculated: { startDate: start, endDate: start },
    },
  })
  const list = mapAppointments(
    [
      entry(1, '2026-10-28T17:00:00Z'),
      entry(1, '2026-10-22T17:00:00Z'), // gleicher Termin, früher → dieser zählt
      entry(2, '2026-10-20T17:00:00Z'), // vorbei
      entry(3, '2026-10-23T17:00:00Z', { isInternal: true }),
      entry(4, '2026-10-24T17:00:00Z', { image: { imageUrl: 'javascript:alert(1)' } }),
    ],
    now,
  )
  assert.deepEqual(list.map((a) => [a.id, a.start, Boolean(a.image)]), [
    [1, '2026-10-22T17:00:00Z', true],
    [4, '2026-10-24T17:00:00Z', false],
  ])
  assert.equal(list[0].place, 'HISplace')
  assert.equal(list[0].calendar, 'Jugend')
})
