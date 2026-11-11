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

test('Übergang je Kachel: Überblenden (Standard) oder ohne', async () => {
  const { slideshowOptions } = await view
  assert.equal(slideshowOptions({}).transition, 'fade')
  assert.equal(slideshowOptions({ transition: 'none' }).transition, 'none')
  assert.equal(slideshowOptions({ transition: 'wirbel' }).transition, 'fade')
})

test('Bilder werden in Kachelgröße angefordert (höchstens 1920, gestuft)', async () => {
  const { scaledUrl } = await view
  assert.equal(scaledUrl('/diashow/bild/abc.jpg', 1916, 989, 1), '/diashow/bild/abc.jpg?w=1920&h=1080')
  assert.equal(scaledUrl('/diashow/pp/abc.jpg', 640, 360, 1), '/diashow/pp/abc.jpg?w=720&h=360')
  // Retina (iPad): doppelte Pixel, aber nie mehr als 1920
  assert.equal(scaledUrl('/diashow/dropbox/abc.png', 1024, 768, 2), '/diashow/dropbox/abc.png?w=1920&h=1920')
  assert.equal(scaledUrl('/diashow/bild/abc.jpg', 960, 540, 3), '/diashow/bild/abc.jpg?w=1920&h=1080')
  // „Füllen“: Bild muss die Kachel bedecken
  assert.equal(scaledUrl('/diashow/bild/abc.jpg', 960, 540, 1, true), '/diashow/bild/abc.jpg?w=1080&h=540&fit=cover')
  // Kachel noch nicht im Bild (Breite 0): Bildschirmgröße
  assert.equal(scaledUrl('/diashow/bild/abc.jpg', 0, 0, 1), '/diashow/bild/abc.jpg?w=1920&h=1080')
  // Bild der Webseite: über den Server, der es verkleinert
  assert.equal(
    scaledUrl('https://www.example.org/img/a.dpr-2.png', 1916, 989, 1),
    '/diashow/web?u=https%3A%2F%2Fwww.example.org%2Fimg%2Fa.dpr-2.png&w=1920&h=1080',
  )
  // Schon mit Größe (ChurchTools) oder unbekannt: unverändert
  assert.equal(scaledUrl('/diashow/bild/abc.jpg?w=5', 1916, 989, 1), '/diashow/bild/abc.jpg?w=5')
  assert.equal(scaledUrl('data:image/png;base64,xx', 1916, 989, 1), 'data:image/png;base64,xx')
})
