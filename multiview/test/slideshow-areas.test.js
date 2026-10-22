'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Browser-Modul der Diashow-Kachel laden (ohne seinen Anzeige-Takt)
const view = (async () => {
  const source = fs.readFileSync(path.join(__dirname, '../public/slideshow.js'), 'utf8')
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const now = Date.parse('2026-10-22T12:00:00Z')
const at = (h) => new Date(now + h * 3600e3).toISOString()

test('Bereiche (Kalender) lassen sich einzeln ausschalten, neue sind an', async () => {
  const { slideshowOptions, ctAppointments, upcomingEvents } = await view
  const slideshow = { ct: { appointments: [
    { id: 1, title: 'Gottesdienst', start: at(20), end: at(22), calendar: 'Gottesdienst', image: 'x' },
    { id: 2, title: 'Jugend', start: at(30), end: at(32), calendar: 'Jugend', image: 'x' },
    { id: 3, title: 'Neu', start: at(40), end: at(42), calendar: 'Neuer Kalender', image: 'x' },
  ] } }
  const o = slideshowOptions({ ctHidden: ['Jugend'], eventHidden: ['Gottesdienst'] })
  assert.deepEqual(ctAppointments(slideshow, o, now).map((a) => a.id), [1, 3])
  const churchtools = { overview: [
    { id: 7, name: 'GD', startDate: at(5), calendar: 'Gottesdienst' },
    { id: 8, name: 'Jugendabend', startDate: at(6), calendar: 'Jugend' },
  ] }
  assert.deepEqual(upcomingEvents(churchtools, o, now).map((e) => e.id), [8])
  // ohne Angabe: alles an; Unsinn wird verworfen
  assert.deepEqual(slideshowOptions({}).ctHidden, [])
  assert.deepEqual(slideshowOptions({ ctHidden: 'Jugend', eventHidden: [1, '', 'A', 'A'] }).eventHidden, ['A'])
})

test('Diashow: Bilder aus der Dropbox nur, wenn in der Kachel eingeschaltet', async () => {
  const { slideshowOptions, buildSlides } = await view
  const data = { slideshow: { images: [], pp: { slides: [] }, dropbox: { images: [{ url: '/diashow/dropbox/a.jpg', name: 'a.jpg' }] } } }
  assert.equal(buildSlides(data, slideshowOptions({}), now).filter((s) => s.key.startsWith('dbx:')).length, 0)
  const o = slideshowOptions({ dropbox: true })
  assert.equal(o.dropboxNow, true)
  assert.deepEqual(buildSlides(data, o, now).filter((s) => s.key.startsWith('dbx:')).map((s) => s.url), ['/diashow/dropbox/a.jpg'])
})
