'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Kleines Ersatz-DOM: genug für die Kachel „YouTube Live“
function fakeElement(tag) {
  const classes = new Set()
  const node = {
    tagName: tag.toUpperCase(),
    children: [],
    hidden: false,
    textContent: '',
    isConnected: true,
    style: { setProperty() {} },
    classList: { add: (c) => classes.add(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) },
    append: (...kids) => node.children.push(...kids),
    replaceChildren: (...kids) => (node.children = kids),
    set className(v) { v.split(' ').filter(Boolean).forEach((c) => classes.add(c)) },
    get className() { return [...classes].join(' ') },
  }
  return node
}

const view = (async () => {
  global.document = { createElement: fakeElement }
  const source = fs.readFileSync(path.join(__dirname, '../public/youtube.js'), 'utf8')
  const original = global.setInterval
  global.setInterval = (...args) => original(...args).unref()
  try { return await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`) }
  finally { global.setInterval = original }
})()

const find = (root, cls) => root.children.find((c) => c.className.split(' ').includes(cls))
// Die ATEM-Zeile ist die letzte der Technik-Zeilen (Monarch, Empfang bei YouTube, ATEM)
const atemLine = (root) => root.children.filter((c) => c.className.split(' ').includes('yt-atem')).at(-1)
const now = Date.now()
const live = {
  state: 'ok',
  video: { status: 'live', title: 'Gottesdienst', viewers: 42, peak: 50, views: 300, likes: 12, actualStart: now - 60e3 },
  atem: { state: 'streaming', bitrate: 6e6, cache: 10 },
  problems: [{ level: 'error', text: 'ATEM nicht erreichbar' }],
}

test('YouTube-Kachel: alles an außer Chat; alte Kacheln behalten ihre Einstellung', async () => {
  const { youtubeOptions, YOUTUBE_PARTS } = await view
  const o = youtubeOptions({ atem: false })
  assert.equal(o.chat, false)
  assert.equal(o.atem, false)
  for (const key of YOUTUBE_PARTS.filter((k) => k !== 'atem')) assert.equal(o[key], true, key)
})

test('YouTube-Kachel: jeder Teil lässt sich einzeln ausblenden', async () => {
  const { createYouTubeView } = await view
  const full = createYouTubeView({})
  full.update(live)
  assert.match(find(full.el, 'yt-sub').textContent, /Spitze 50 · 300 Aufrufe · 12 Likes/)
  assert.match(atemLine(full.el).textContent, /ATEM sendet · 6,0 Mbit\/s · Puffer 10 %/)
  assert.ok(full.el.classList.contains('alarm'))

  const slim = createYouTubeView({ header: false, status: false, peak: false, likes: false, name: false, atemDetails: false, problems: false })
  slim.update(live)
  assert.ok(find(slim.el, 'yt-header').hidden)
  assert.equal(find(slim.el, 'yt-name'), undefined)
  assert.equal(find(slim.el, 'yt-problems'), undefined)
  assert.equal(find(slim.el, 'yt-sub').textContent, '300 Aufrufe')
  assert.equal(atemLine(slim.el).textContent, 'ATEM sendet')
  assert.ok(!slim.el.classList.contains('alarm'))

  const noNumbers = createYouTubeView({ big: false, runtime: false })
  noNumbers.update(live)
  assert.equal(find(noNumbers.el, 'yt-main'), undefined)
})

test('YouTube-Kachel: Monarch, Empfang bei YouTube und „Nicht gelistet“', async () => {
  const { createYouTubeView } = await view
  const v = createYouTubeView({})
  v.update({
    ...live,
    video: { ...live.video, privacy: 'unlisted' },
    atem: { state: 'nostream' },
    encoder: { state: 'streaming', input: { signal: true, label: 'SDI 1080p50' } },
    health: { stream: 'active', status: 'good', resolution: '1080p', frameRate: '50fps', issues: [] },
    problems: [],
  })
  const lines = v.el.children.filter((c) => c.className.includes('yt-atem'))
  assert.deepEqual(lines.map((l) => (l.hidden ? '' : l.textContent)), ['Monarch sendet · SDI 1080p50', 'YouTube empfängt: gut · 1080p · 50 fps', ''])
  const header = find(v.el, 'yt-header')
  assert.equal(header.children.find((c) => c.className === 'yt-privacy').textContent, 'Nicht gelistet')

  // Ohne Monarch und ohne Google-Anmeldung: keine leeren Zeilen
  const plain = createYouTubeView({})
  plain.update({ ...live, encoder: { state: 'unconfigured' }, health: null })
  assert.deepEqual(plain.el.children.filter((c) => c.className.includes('yt-atem') && !c.hidden).map((l) => l.textContent), ['ATEM sendet · 6,0 Mbit/s · Puffer 10 %'])
})
