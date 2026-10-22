'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createYouTube, findProblems } = require('../youtube')

const KEY = 'AIzaSyTestTestTestTestTestTest123'
const CLIENT = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-geheim' }

// Google nachgebaut: Kanal, Uploads (nur öffentliche), Videos, OAuth für Geräte, eigene Streams
function fakeGoogle() {
  const g = { approved: false, calls: [], health: 'good', issues: [], revoked: null }
  const unlisted = {
    id: 'unlisted001',
    snippet: { title: 'Teststream', liveBroadcastContent: 'live' },
    status: { privacyStatus: 'unlisted' },
    liveStreamingDetails: { actualStartTime: '2026-10-22T16:00:00Z', concurrentViewers: '1' },
    statistics: { viewCount: '0', likeCount: '0' },
  }
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body })
  g.fetchImpl = async (url, opts = {}) => {
    const u = new URL(url)
    const bearer = opts.headers?.Authorization
    if (u.hostname === 'oauth2.googleapis.com') {
      const form = new URLSearchParams(opts.body)
      g.calls.push(`oauth:${u.pathname}`)
      if (u.pathname === '/device/code') return json({ device_code: 'dev1', user_code: 'ABCD-EFGH', verification_url: 'https://www.google.com/device', expires_in: 1800, interval: 5 })
      if (u.pathname === '/revoke') return (g.revoked = form.get('token')), json({})
      if (form.get('grant_type').endsWith('device_code')) return g.approved ? json({ access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 }) : json({ error: 'authorization_pending' }, 428)
      if (form.get('grant_type') === 'refresh_token') return json({ access_token: 'at2', expires_in: 3600 })
      return json({ error: 'unsupported' }, 400)
    }
    const endpoint = u.pathname.replace('/youtube/v3/', '')
    g.calls.push(`${bearer ? 'auth' : 'key'}:${endpoint}`)
    if (endpoint === 'channels') return json({ items: [{ id: 'UC1234567890123456789012', snippet: { title: 'JMS Altensteig' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] })
    if (endpoint === 'playlistItems') return json({ items: [] })
    if (endpoint === 'videos') return json({ items: u.searchParams.get('id').split(',').includes('unlisted001') ? [unlisted] : [] })
    if (endpoint === 'liveBroadcasts') {
      if (!bearer) return json({ error: { message: 'Login Required' } }, 401)
      return json({ items: u.searchParams.get('broadcastStatus') === 'upcoming' ? [] : [{ id: 'unlisted001', contentDetails: { boundStreamId: 'stream1' } }] })
    }
    if (endpoint === 'liveStreams')
      return json({ items: [{ id: 'stream1', status: { streamStatus: 'active', healthStatus: { status: g.health, configurationIssues: g.issues } }, cdn: { resolution: '1080p', frameRate: '50fps' } }] })
    return json({ error: { message: 'unbekannt' } }, 404)
  }
  return g
}

test('Google-Anmeldung: Code, Bestätigung, nicht gelistete Streams und Empfang', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ytg-'))
  const g = fakeGoogle()
  let clock = Date.parse('2026-10-22T16:10:00Z')
  const yt = createYouTube({ dataDir, fetchImpl: g.fetchImpl, now: () => clock })
  await assert.rejects(yt.googleStart(CLIENT), /Zuerst API-Schlüssel/)
  await yt.configure({ apiKey: KEY, channel: '@jms' })
  await yt.poll()
  assert.equal(yt.snapshot().video, null) // ohne Anmeldung unsichtbar

  const started = await yt.googleStart(CLIENT)
  assert.equal(started.google.pending.userCode, 'ABCD-EFGH')
  await yt.googlePoll() // noch nicht bestätigt
  assert.equal(yt.settings().google.signedIn, false)
  g.approved = true
  await yt.googlePoll()
  const s = yt.settings()
  assert.equal(s.google.signedIn, true)
  assert.equal(s.google.account.title, 'JMS Altensteig')
  assert.equal(s.google.otherChannel, false)
  for (const secret of ['GOCSPX', 'rt1', 'at1', KEY]) assert.ok(!JSON.stringify(s).includes(secret), secret)

  await yt.poll()
  let snap = yt.snapshot()
  assert.equal(snap.video.id, 'unlisted001')
  assert.equal(snap.video.privacy, 'unlisted')
  assert.equal(snap.health.status, 'good')
  assert.equal(snap.health.resolution, '1080p')
  assert.ok(g.calls.includes('auth:liveBroadcasts'))

  g.health = 'bad'
  g.issues = [{ type: 'bitrateLow', severity: 'error', reason: 'Low bitrate', description: '…' }]
  clock += 30e3
  await yt.poll()
  snap = yt.snapshot()
  assert.deepEqual(snap.problems.map((p) => p.text), ['YouTube: Empfang schlecht', 'YouTube: Bitrate zu niedrig'])
  assert.match(yt.status().info, /YouTube-Empfang schlecht/)

  // Anmeldung überlebt einen Neustart, Abmelden widerruft das Token
  yt.stop()
  const again = createYouTube({ dataDir, fetchImpl: g.fetchImpl, now: () => clock })
  assert.equal(again.settings().google.signedIn, true)
  await again.googleLogout()
  again.stop()
  assert.equal(g.revoked, 'rt1')
  assert.equal(again.settings().google.signedIn, false)
  assert.equal(again.settings().google.clientId, CLIENT.clientId)

  // API-Schlüssel neu speichern behält die Google-Daten
  await again.configure({ apiKey: '', channel: '@jms' })
  again.stop()
  assert.equal(again.settings().google.clientSecretSet, true)
})

test('Monarch: sendet sie nicht mehr oder fehlt das Bild, gibt es Alarm', () => {
  const now = Date.parse('2026-10-25T08:40:00Z')
  const live = { status: 'live' }
  const atem = { state: 'nostream' }
  const texts = (o) => findProblems({ state: 'ok', video: live, atem, ...o }, now).map((p) => `${p.level}:${p.text}`)
  assert.deepEqual(texts({ encoder: { state: 'streaming', input: { signal: true } }, encoderUsed: true }), [])
  assert.deepEqual(texts({ encoder: { state: 'ready' }, encoderUsed: true }), ['error:Monarch sendet nicht mehr'])
  assert.deepEqual(texts({ encoder: { state: 'error' }, encoderUsed: true }), ['error:Monarch nicht erreichbar – sendet der Stream noch?'])
  // Hat die Monarch in diesem Stream nie gesendet (anderer Encoder), ist das kein Problem
  assert.deepEqual(texts({ encoder: { state: 'ready' }, encoderUsed: false }), [])
  assert.deepEqual(texts({ encoder: { state: 'streaming', input: { signal: false } }, encoderUsed: true }), ['error:Kein Bild am Eingang der Monarch'])
  // Upload (FRITZ!Box) bricht ein, obwohl die Monarch sendet
  assert.deepEqual(texts({ encoder: { state: 'streaming', input: { signal: true } }, encoderUsed: true, upload: 0.2e6 }), ['error:Upload fast null (0,2 Mbit/s) – kommt der Stream bei YouTube an?'])
  assert.deepEqual(texts({ encoder: { state: 'streaming', input: { signal: true } }, encoderUsed: true, upload: 8.4e6 }), [])
  const upcoming = { status: 'upcoming', scheduledStart: now + 3600e3 }
  assert.deepEqual(
    findProblems({ state: 'ok', video: upcoming, atem, encoder: { state: 'streaming', input: { signal: true } }, encoderSince: now - 3 * 60e3 }, now).map((p) => p.text),
    ['Monarch sendet, aber YouTube zeigt keinen laufenden Stream'],
  )
})
