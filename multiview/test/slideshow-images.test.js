'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createImageScaler, wantedSize, step } = require('../slideshow-images')
const { createSlideshow } = require('../slideshow')

let sharp = null
try {
  sharp = require('sharp')
} catch {}
const noSharp = !sharp && 'sharp ist hier nicht installiert'

const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diashow-klein-'))
const picture = async (file, width, height, { format = 'jpeg', alpha = false } = {}) => {
  const background = alpha ? { r: 200, g: 40, b: 40, alpha: 0.5 } : { r: 200, g: 40, b: 40 }
  await sharp({ create: { width, height, channels: alpha ? 4 : 3, background } })[format]().toFile(file)
  return file
}

test('Größe aus ?w=…&h=…: auf wenige Stufen gerundet, höchstens 1920', () => {
  assert.equal(step('100'), 360)
  assert.equal(step(1080), 1080)
  assert.equal(step(1081), 1440)
  assert.equal(step(5000), 1920)
  assert.equal(step(''), null)
  assert.equal(step('abc'), null)
  assert.equal(step(-5), null)
  assert.deepEqual(wantedSize({ w: '1916', h: '989' }), { w: 1920, h: 1080, cover: false })
  assert.deepEqual(wantedSize({ w: '960', fit: 'cover' }), { w: 1080, h: 1080, cover: true })
  assert.equal(wantedSize({}), null)
})

test('Ohne sharp: immer das Original', async () => {
  const scaler = createImageScaler({ cacheDir: dir(), sharp: null })
  assert.equal(scaler.available, false)
  assert.equal(await scaler.scaled(__filename, { w: 360, h: 360 }), null)
  assert.equal(await scaler.webFile('https://example.org/a.jpg'), null)
})

test('Großes Bild wird einmal verkleinert und danach aus dem Zwischenspeicher geliefert', { skip: noSharp }, async () => {
  const src = dir()
  const cacheDir = dir()
  const file = await picture(path.join(src, 'gross.jpg'), 3840, 1200)
  const scaler = createImageScaler({ cacheDir, sharp })
  const size = wantedSize({ w: 1916, h: 989 })
  // Zwei Kacheln fragen gleichzeitig: nur eine Fassung
  const [a, b] = await Promise.all([scaler.scaled(file, size), scaler.scaled(file, size)])
  assert.ok(a)
  assert.equal(a, b)
  const meta = await sharp(a).metadata()
  assert.deepEqual([meta.width, meta.height, meta.format], [1920, 600, 'jpeg'])
  assert.equal(await scaler.scaled(file, size), a)
  assert.equal(fs.readdirSync(cacheDir).filter((n) => n.endsWith('.jpg')).length, 1)

  // „Füllen“: Die Fassung bedeckt die Fläche (Höhe 1080), statt nur hineinzupassen
  const cover = await scaler.scaled(file, wantedSize({ w: 1916, h: 989, fit: 'cover' }))
  const coverMeta = await sharp(cover).metadata()
  assert.equal(coverMeta.height, 1080)
  assert.equal(coverMeta.width, 3456)
})

test('Kleine Bilder und GIFs bleiben Original, WebP wird für alte iPads zu JPEG, Transparenz bleibt PNG', { skip: noSharp }, async () => {
  const src = dir()
  const scaler = createImageScaler({ cacheDir: dir(), sharp })
  const size = { w: 1920, h: 1080 }
  assert.equal(await scaler.scaled(await picture(path.join(src, 'klein.jpg'), 1280, 720), size), null)
  assert.equal(await scaler.scaled(await picture(path.join(src, 'bewegt.gif'), 3000, 2000, { format: 'gif' }), size), null)
  const webp = await scaler.scaled(await picture(path.join(src, 'foto.webp'), 800, 600, { format: 'webp' }), size)
  assert.equal((await sharp(webp).metadata()).format, 'jpeg')
  const logo = await scaler.scaled(await picture(path.join(src, 'logo.png'), 4000, 1000, { format: 'png', alpha: true }), size)
  const meta = await sharp(logo).metadata()
  assert.deepEqual([path.extname(logo), meta.width, meta.hasAlpha], ['.png', 1920, true])
  // Alphakanal, aber überall deckend (Slider der Webseite): JPEG
  const opaque = path.join(src, 'slider.png')
  await sharp({ create: { width: 3840, height: 1200, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } } }).png().toFile(opaque)
  const slider = await scaler.scaled(opaque, size)
  assert.deepEqual([path.extname(slider), (await sharp(slider).metadata()).width], ['.jpg', 1920])
  // Kein Bild: Original (der Browser zeigt dann einen leeren Rahmen)
  const broken = path.join(src, 'kaputt.jpg')
  fs.writeFileSync(broken, 'kein Bild')
  assert.equal(await scaler.scaled(broken, size), null)
})

test('Zwischenspeicher behält nur die zuletzt benutzten Fassungen', { skip: noSharp }, async () => {
  const src = dir()
  const cacheDir = dir()
  const scaler = createImageScaler({ cacheDir, sharp, maxEntries: 2 })
  const file = await picture(path.join(src, 'gross.jpg'), 3000, 2000)
  for (const w of [360, 540, 720]) await scaler.scaled(file, { w, h: w })
  assert.equal(fs.readdirSync(cacheDir).filter((n) => n.endsWith('.jpg')).length, 2)
})

test('Bild der Webseite wird einmal geholt; bei Fehlern 5 Minuten Pause', { skip: noSharp }, async () => {
  const jpeg = await sharp({ create: { width: 3840, height: 1200, channels: 3, background: '#335' } }).jpeg().toBuffer()
  let calls = 0
  const fetchImpl = async (url) => {
    calls++
    if (url.includes('kaputt')) return new Response('nein', { status: 500 })
    return new Response(jpeg)
  }
  const scaler = createImageScaler({ cacheDir: dir(), sharp, fetchImpl })
  const file = await scaler.webFile('https://www.example.org/slider.jpg')
  assert.ok(file.endsWith('.jpg'))
  assert.equal(await scaler.webFile('https://www.example.org/slider.jpg'), file)
  assert.equal(calls, 1)
  const small = await scaler.scaled(file, { w: 1440, h: 1440 })
  assert.equal((await sharp(small).metadata()).width, 1440)
  assert.equal(await scaler.webFile('https://www.example.org/kaputt.jpg'), null)
  assert.equal(await scaler.webFile('https://www.example.org/kaputt.jpg'), null)
  assert.equal(calls, 2)
})

test('Server holt nur Bilder, die gerade im Slider der Webseite stehen', async () => {
  const html = `<div class="swiper--hero"><div class="swiper-slide"><picture class="slide__image-desktop"><source srcset="/img/a.png 2x"></picture></div><div class="swiper-pagination"></div></div>`
  const fetchImpl = async () => new Response(html)
  const show = createSlideshow({ dataDir: dir(), fetchImpl })
  await show.refreshExternal()
  assert.equal(show.isWebsiteImage('https://www.jms-altensteig.de/img/a.png'), true)
  assert.equal(show.isWebsiteImage('https://boese.example/x.png'), false)
  assert.equal(show.isWebsiteImage(''), false)
})
