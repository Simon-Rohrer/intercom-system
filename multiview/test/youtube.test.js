'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createYouTube, parseChannel, parseVideo, pickVideo, atemStreaming, findProblems } = require('../youtube')

// Nachgebaute YouTube-API: keine echten Anfragen, kein Schlüssel
function fakeApi(videos) {
  const calls = []
  const fetchImpl = async (url) => {
    const u = new URL(url)
    const endpoint = u.pathname.replace('/youtube/v3/', '')
    calls.push(endpoint)
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
    if (endpoint === 'channels') return json({ items: [{ id: 'UC1234567890123456789012', snippet: { title: 'JMS Altensteig' }, contentDetails: { relatedPlaylists: { uploads: 'UU1234567890123456789012' } } }] })
    if (endpoint === 'playlistItems') return json({ items: Object.keys(videos.current).map((videoId) => ({ contentDetails: { videoId } })) })
    if (endpoint === 'videos') return json({ items: u.searchParams.get('id').split(',').map((id) => videos.current[id]).filter(Boolean) })
    if (endpoint === 'liveChat/messages') return json({ items: [{ id: 'm1', snippet: { publishedAt: '2026-10-25T08:31:00Z', displayMessage: 'Hallo aus Nagold' }, authorDetails: { displayName: 'Anna' } }], pollingIntervalMillis: 5000 })
    return json({ error: { message: 'unbekannt' } }, 404)
  }
  return { fetchImpl, calls }
}

const liveVideo = (viewers, extra = {}) => ({
  id: 'abcdefghijk',
  snippet: { title: 'Gottesdienst 25.10.', liveBroadcastContent: 'live' },
  liveStreamingDetails: { actualStartTime: '2026-10-25T08:30:00Z', concurrentViewers: String(viewers), activeLiveChatId: 'chat1', ...extra },
  statistics: { viewCount: '310', likeCount: '12' },
})

function setup({ atem = { connected: true, streaming: { status: { state: 4, error: 0 }, stats: { encodingBitrate: 6000000, cacheUsed: 0 } } }, chat = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'))
  const videos = { current: { abcdefghijk: liveVideo(40) } }
  const api = fakeApi(videos)
  let clock = Date.parse('2026-10-25T08:40:00Z')
  const updates = []
  const env = { atem }
  const yt = createYouTube({ dataDir, getAtem: () => env.atem, wantChat: () => chat, onUpdate: (m) => updates.push(m), fetchImpl: api.fetchImpl, now: () => clock })
  return { yt, videos, api, updates, env, dataDir, advance: (ms) => (clock += ms) }
}

test('Kanal und Video aus Links, @Namen und IDs', () => {
  assert.deepEqual(parseChannel('https://www.youtube.com/@jms-altensteig'), { handle: '@jms-altensteig' })
  assert.deepEqual(parseChannel('@gemeinde'), { handle: '@gemeinde' })
  assert.deepEqual(parseChannel('https://www.youtube.com/channel/UC1234567890123456789012'), { id: 'UC1234567890123456789012' })
  assert.equal(parseChannel(''), null)
  assert.equal(parseVideo('https://www.youtube.com/watch?v=abcdefghijk&t=3'), 'abcdefghijk')
  assert.equal(parseVideo('https://youtube.com/live/abcdefghijk?si=x'), 'abcdefghijk')
  assert.equal(parseVideo('https://youtu.be/abcdefghijk'), 'abcdefghijk')
})

test('Laufender Stream vor geplantem, geplanter vor beendetem', () => {
  const now = Date.parse('2026-10-25T08:00:00Z')
  const upcoming = { id: 'a', status: 'upcoming', scheduledStart: now + 3600e3 }
  const ended = { id: 'b', status: 'ended', actualEnd: now - 3600e3 }
  const live = { id: 'c', status: 'live' }
  assert.equal(pickVideo([ended, upcoming, live], now).id, 'c')
  assert.equal(pickVideo([ended, upcoming], now).id, 'a')
  assert.equal(pickVideo([ended], now).id, 'b')
  assert.equal(pickVideo([{ ...ended, actualEnd: now - 13 * 3600e3 }], now), null)
})

test('Probleme: ATEM sendet nicht mehr, Puffer, Stream hat nicht begonnen', () => {
  const now = Date.parse('2026-10-25T08:40:00Z')
  const live = { status: 'live' }
  const idle = atemStreaming(true, { status: { state: 1, error: 0 } })
  assert.equal(findProblems({ state: 'ok', video: live, atem: idle, atemUsed: true }, now)[0].text, 'ATEM sendet nicht mehr (aus)')
  // Hat der ATEM in diesem Stream nie gesendet (z. B. OBS), ist er kein Problem
  assert.deepEqual(findProblems({ state: 'ok', video: live, atem: idle, atemUsed: false }, now), [])
  const slow = atemStreaming(true, { status: { state: 4, error: 0 }, stats: { cacheUsed: 72, encodingBitrate: 6e6 } })
  assert.deepEqual(findProblems({ state: 'ok', video: live, atem: slow, atemUsed: true }, now), [{ level: 'warn', text: 'Upload zu langsam: ATEM-Puffer 72 %' }])
  const late = { status: 'upcoming', scheduledStart: now - 10 * 60e3 }
  assert.equal(findProblems({ state: 'ok', video: late, atem: atemStreaming(false), atemUsed: false }, now)[0].level, 'error')
})

test('Stream mit Zuschauern, Abbruch des ATEM und Zusammenfassung am Ende', async () => {
  const { yt, videos, env, advance } = setup()
  await yt.configure({ apiKey: 'AIzaSyTestTestTestTestTestTest123', channel: '@jms' })
  await yt.poll()
  let snap = yt.snapshot()
  assert.equal(snap.video.status, 'live')
  assert.equal(snap.video.viewers, 40)
  assert.equal(snap.problems.length, 0)
  assert.equal(snap.video.liveChatId, undefined)

  videos.current.abcdefghijk = liveVideo(84)
  advance(60e3)
  await yt.poll()
  // ATEM bricht ab
  env.atem = { connected: true, streaming: { status: { state: 2, error: 0 } } }
  advance(5e3)
  yt.evaluate()
  assert.equal(yt.status().problem.text, 'ATEM sendet nicht mehr (verbindet)')
  // und läuft wieder
  env.atem = { connected: true, streaming: { status: { state: 4, error: 0 }, stats: { cacheUsed: 0 } } }
  advance(120e3)
  yt.evaluate()
  assert.equal(yt.status().problem, null)
  assert.match(yt.status().info, /LIVE seit .* · 84 Zuschauer · Spitze 84/)

  // Stream beendet
  videos.current.abcdefghijk = { ...liveVideo(0), snippet: { title: 'Gottesdienst 25.10.', liveBroadcastContent: 'none' }, liveStreamingDetails: { actualStartTime: '2026-10-25T08:30:00Z', actualEndTime: '2026-10-25T10:02:00Z' } }
  advance(60e3)
  await yt.poll()
  snap = yt.snapshot()
  assert.equal(snap.video.status, 'ended')
  const text = yt.status().summary.text
  assert.match(text, /Spitze 84 Zuschauer/)
  assert.match(text, /1 Std\. 32 Min\. live/)
  assert.match(text, /1 Störung:\n– ATEM sendet nicht mehr \(verbindet\)/)
  yt.stop()
})

test('ATEM kurz vor dem Ende gestoppt ist keine Störung', async () => {
  const { yt, videos, env, advance } = setup()
  await yt.configure({ apiKey: 'AIzaSyTestTestTestTestTestTest123', channel: '@jms' })
  await yt.poll()
  env.atem = { connected: true, streaming: { status: { state: 1, error: 0 } } }
  advance(5e3)
  yt.evaluate()
  videos.current.abcdefghijk = { ...liveVideo(0), snippet: { title: 'Gottesdienst', liveBroadcastContent: 'none' }, liveStreamingDetails: { actualStartTime: '2026-10-25T08:30:00Z', actualEndTime: '2026-10-25T08:41:00Z' } }
  advance(60e3)
  await yt.poll()
  assert.match(yt.status().summary.text, /Keine Störungen/)
  yt.stop()
})

test('Gespeicherter Stream gilt nach Neustart erst nach der ersten Abfrage als beendet', async () => {
  const first = setup()
  await first.yt.configure({ apiKey: 'AIzaSyTestTestTestTestTestTest123', channel: '@jms' })
  await first.yt.poll()
  first.yt.stop()
  const again = createYouTube({ dataDir: first.dataDir, getAtem: () => first.env.atem, fetchImpl: first.api.fetchImpl, now: () => Date.parse('2026-10-25T08:45:00Z') })
  again.evaluate()
  assert.equal(again.status().summary, null)
})

test('Live-Chat nur, wenn eine Kachel ihn zeigt', async () => {
  const quiet = setup()
  await quiet.yt.configure({ apiKey: 'AIzaSyTestTestTestTestTestTest123', channel: '@jms' })
  await quiet.yt.poll()
  assert.ok(!quiet.api.calls.includes('liveChat/messages'))
  const chatty = setup({ chat: true })
  await chatty.yt.configure({ apiKey: 'AIzaSyTestTestTestTestTestTest123', channel: '@jms' })
  chatty.yt.start()
  await chatty.yt.poll()
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(chatty.yt.snapshot().chat[0].text, 'Hallo aus Nagold')
  chatty.yt.stop()
  quiet.yt.stop()
})

test('Schlüssel geht nie an den Browser, Fehler sind verständlich', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-'))
  const yt = createYouTube({
    dataDir,
    fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'API key not valid. Please pass a valid API key.', errors: [{ reason: 'badRequest' }] } }) }),
  })
  await assert.rejects(yt.configure({ apiKey: 'AIzaSyTestTestTestTestTestTest123', channel: '@jms' }), /API-Schlüssel ungültig/)
  assert.equal(yt.settings().configured, false)
  assert.ok(!JSON.stringify(yt.snapshot()).includes('AIza'))
  assert.ok(!JSON.stringify(yt.settings()).includes('AIza'))
})
