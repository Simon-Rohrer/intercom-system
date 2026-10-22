'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { createDropbox, normalizeFolder } = require('../dropbox')

// Dropbox nachgebaut: OAuth mit PKCE, Konto, Ordner, Änderungen über den Cursor, Bilder
function fakeDropbox() {
  const d = { files: { 'id:1': { name: 'Willkommen.jpg', rev: 'r1' } }, changes: [], calls: [], challenge: '', revoked: false }
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) })
  const entry = (id, f) => ({ '.tag': 'file', id, name: f.name, rev: f.rev, path_lower: `/gemeinde/diashow/${f.name.toLowerCase()}`, path_display: `/Gemeinde/Diashow/${f.name}`, server_modified: '2026-10-22T16:00:00Z', size: 1000 })
  d.fetchImpl = async (url, opts) => {
    const u = new URL(url)
    d.calls.push(u.pathname)
    if (u.pathname === '/oauth2/token') {
      const form = new URLSearchParams(opts.body)
      if (form.get('grant_type') === 'authorization_code') {
        const ok = form.get('code') === 'CODE123' && crypto.createHash('sha256').update(form.get('code_verifier')).digest('base64url') === d.challenge
        return ok ? json({ access_token: 'at', refresh_token: 'rt', expires_in: 14400 }) : json({ error: 'invalid_grant' }, 400)
      }
      return json({ access_token: 'at2', expires_in: 14400 })
    }
    if (opts.headers.Authorization && opts.headers.Authorization !== 'Bearer at' && opts.headers.Authorization !== 'Bearer at2') return json({ error_summary: 'invalid_access_token/' }, 401)
    const args = opts.body ? JSON.parse(opts.body) : null
    switch (u.pathname) {
      case '/2/users/get_current_account': return json({ name: { display_name: 'Simon Rohrer' }, email: 'x@y' })
      case '/2/auth/token/revoke': d.revoked = true; return json(null)
      case '/2/files/get_metadata': return args.path === '/Gemeinde/Diashow' ? json({ '.tag': 'folder' }) : json({ error_summary: 'path/not_found/' }, 409)
      case '/2/files/list_folder':
        if (args.path === '') return json({ entries: [{ '.tag': 'folder', name: 'Gemeinde', path_display: '/Gemeinde' }], cursor: 'c0', has_more: false })
        return json({ entries: [...Object.entries(d.files).map(([id, f]) => entry(id, f)), { '.tag': 'file', id: 'id:9', name: 'Predigt.pdf', rev: 'x', path_lower: '/gemeinde/diashow/predigt.pdf' }], cursor: 'c1', has_more: false })
      case '/2/files/list_folder/continue': {
        const out = d.changes.map(([id, f]) => (f ? entry(id, f) : { '.tag': 'deleted', path_lower: `/gemeinde/diashow/${d.gone}` }))
        d.changes = []
        return json({ entries: out, cursor: 'c2', has_more: false })
      }
      case '/2/files/get_thumbnail_v2': {
        const arg = JSON.parse(opts.headers['Dropbox-API-Arg'])
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(`bild ${arg.resource.path} ${arg.format}`) }
      }
    }
    return json({ error_summary: 'unknown' }, 404)
  }
  return d
}

test('Dropbox-Ordner: Pfad', () => {
  assert.equal(normalizeFolder(' Gemeinde/Diashow/ '), '/Gemeinde/Diashow')
  assert.equal(normalizeFolder('/'), '')
  assert.equal(normalizeFolder('\\Fotos\\\\2026'), '/Fotos/2026')
})

test('Dropbox: verbinden mit Code, Ordner wählen, neue und gelöschte Bilder', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbx-'))
  const d = fakeDropbox()
  const updates = []
  const dbx = createDropbox({ dataDir, fetchImpl: d.fetchImpl, onUpdate: (s) => updates.push(s) })
  assert.throws(() => dbx.authorizeUrl(''), /App-Key/)
  const url = new URL(dbx.authorizeUrl('abc123def456'))
  assert.equal(url.searchParams.get('token_access_type'), 'offline')
  assert.equal(url.searchParams.get('redirect_uri'), null)
  d.challenge = url.searchParams.get('code_challenge')
  await assert.rejects(dbx.connect('FALSCH'), /Code ist falsch/)
  const s = await dbx.connect('CODE123')
  assert.equal(s.connected, true)
  assert.equal(s.account.name, 'Simon Rohrer')
  assert.equal(s.state, 'nofolder')
  for (const secret of ['rt', 'at']) assert.ok(!JSON.stringify(s).includes(`"${secret}"`))
  assert.equal((fs.statSync(path.join(dataDir, 'dropbox-secret.json')).mode & 0o777), 0o600)

  assert.deepEqual((await dbx.browse('')).folders, [{ name: 'Gemeinde', path: '/Gemeinde' }])
  await assert.rejects(dbx.setFolder('/Gibtsnicht'), /gibt es in der Dropbox nicht/)
  await dbx.setFolder('Gemeinde/Diashow')
  await dbx.sync()
  let snap = dbx.snapshot()
  assert.equal(snap.state, 'ok')
  assert.deepEqual(snap.images.map((i) => i.name), ['Willkommen.jpg']) // PDF bleibt draußen
  assert.equal(fs.readFileSync(dbx.filePath(snap.images[0].url.split('/').pop()), 'utf8'), 'bild id:1 jpeg')

  // Neues Bild (HEIC vom iPhone wird als JPEG geholt), dann eins gelöscht
  d.changes = [['id:2', { name: 'IMG_0042.HEIC', rev: 'r1' }]]
  await dbx.sync()
  snap = dbx.snapshot()
  assert.deepEqual(snap.images.map((i) => i.name), ['IMG_0042.HEIC', 'Willkommen.jpg'])
  assert.ok(snap.lastChange > 0)
  d.gone = 'willkommen.jpg'
  d.changes = [['id:1', null]]
  await dbx.sync()
  assert.deepEqual(dbx.snapshot().images.map((i) => i.name), ['IMG_0042.HEIC'])
  assert.ok(updates.length >= 3)

  // Nach Neustart noch da; Trennen widerruft und räumt auf
  const again = createDropbox({ dataDir, fetchImpl: d.fetchImpl })
  assert.equal(again.snapshot().images.length, 1)
  assert.equal(again.settings().connected, true)
  await again.disconnect()
  assert.equal(d.revoked, true)
  assert.equal(again.settings().connected, false)
  assert.equal(again.settings().appKey, 'abc123def456')
  assert.equal(again.snapshot().images.length, 0)
})
