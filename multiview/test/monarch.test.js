'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMonarch, parseStatus, parseInput } = require('../monarch')

test('Monarch: Antworten wie von der echten HDX', () => {
  assert.deepEqual(parseStatus('ENC1:RTMP,ON,ENC2:NONE,DISABLED,NAME:MonarchHDX'), {
    name: 'MonarchHDX',
    encoders: [
      { id: 'ENC1', mode: 'RTMP', state: 'ON' },
      { id: 'ENC2', mode: 'NONE', state: 'DISABLED' },
    ],
  })
  // Monarch HD
  assert.deepEqual(parseStatus('RECORD:READY,STREAM:RTMP,ON,NAME:MonarchHD').encoders.map((e) => `${e.id}:${e.mode}:${e.state}`), ['RECORD:RECORD:READY', 'STREAM:RTMP:ON'])
  const input = parseInput('VIDEO INPUT:1920x1080p, 50 fps (SDI)')
  assert.equal(input.signal, true)
  assert.equal(input.label, 'SDI 1080p50')
  assert.equal(parseInput('VIDEO INPUT:1920x1080i, 59.94 fps (HDMI)').label, 'HDMI 1080i59,94')
  assert.equal(parseInput('VIDEO INPUT:NO SIGNAL').signal, false)
})

function fakeMonarch(answers) {
  const calls = []
  const fetchImpl = async (url, opts) => {
    const cmd = new URL(url).searchParams.get('command')
    calls.push({ cmd, auth: opts.headers.Authorization })
    const a = answers[cmd] ?? 'FAILED'
    if (typeof a === 'number') return { ok: false, status: a, text: async () => '' }
    return { ok: true, status: 200, text: async () => `${a}\r\n` }
  }
  return { fetchImpl, calls }
}

test('Monarch: sendet, Eingang, Passwort bleibt auf dem Server', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mon-'))
  const answers = { GetStatus: 'ENC1:RTMP,ON,ENC2:NONE,DISABLED,NAME:MonarchHDX', GetInputStatus: 'VIDEO INPUT:1920x1080p, 50 fps (SDI)' }
  const dev = fakeMonarch(answers)
  const monarch = createMonarch({ dataDir, fetchImpl: dev.fetchImpl })
  assert.equal(monarch.snapshot().state, 'unconfigured')
  await monarch.configure({ host: 'http://192.168.0.30/', user: '', password: 'geheim' })
  monarch.stop()
  assert.equal(dev.calls[0].auth, `Basic ${Buffer.from('admin:geheim').toString('base64')}`)
  let snap = monarch.snapshot()
  assert.equal(snap.state, 'streaming')
  assert.equal(snap.encoder, 'Encoder 1')
  assert.equal(snap.input.label, 'SDI 1080p50')
  assert.ok(!JSON.stringify(monarch.settings()).includes('geheim'))
  assert.equal(monarch.settings().host, '192.168.0.30')

  // Leeres Passwort beim Speichern behält das alte
  await monarch.configure({ host: '192.168.0.30', user: 'admin', password: '' })
  monarch.stop()
  assert.equal(dev.calls.at(-1).auth, `Basic ${Buffer.from('admin:geheim').toString('base64')}`)

  answers.GetStatus = 'ENC1:RTMP,READY,ENC2:NONE,DISABLED,NAME:MonarchHDX'
  await monarch.poll()
  assert.equal(monarch.snapshot().state, 'ready')
  answers.GetStatus = 401
  await monarch.poll()
  snap = monarch.snapshot()
  assert.equal(snap.state, 'error')
  assert.match(snap.error, /Anmeldung/)
})

test('Jede Datei, die der Server lädt, kommt auch in den Container', () => {
  const root = path.join(__dirname, '..')
  const copied = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8')
  const local = [...fs.readFileSync(path.join(root, 'server.js'), 'utf8').matchAll(/require\('\.\/([\w-]+)(?:\.js)?'\)/g)].map((m) => `${m[1]}.js`)
  assert.ok(local.includes('monarch.js'))
  for (const file of local) assert.match(copied, new RegExp(`\\s${file.replace('.', '\\.')}\\s`), `${file} fehlt im Dockerfile`)
})
