'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createKesherRoles, roleIdFromName } = require('../kesher-roles')

/** Kleines Kesher zum Testen: merkt sich Rollen, Benutzer und alle Anfragen. */
function fakeKesher({ roles = [], users = [], active = [], loginStatus = 200 } = {}) {
  const calls = []
  const state = { roles: structuredClone(roles), users: structuredClone(users) }
  const reply = (status, body) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), {
      status,
      headers: { 'Content-Type': typeof body === 'string' ? 'text/plain' : 'application/json' },
    })
  async function fetchImpl(url, { method = 'GET', headers = {}, body } = {}) {
    const path = new URL(url).pathname
    const data = body ? JSON.parse(body) : null
    calls.push({ method, path, data, auth: headers.Authorization })
    if (path === '/api/admin/login/central') return loginStatus === 200 ? reply(200, { token: 'admin-token' }) : reply(loginStatus, 'nope')
    if (path === '/api/logout') return reply(200, { ok: true })
    if (headers.Authorization !== 'Bearer admin-token') return reply(401, 'invalid token')
    if (path === '/api/bootstrap') return reply(200, { roles: state.roles, users: state.users })
    if (path === '/api/admin/roles' && method === 'POST') {
      if (state.roles.some((r) => r.id === data.id)) return reply(409, 'conflict')
      state.roles.push({ id: data.id, name: data.name })
      return reply(201, { ok: true })
    }
    let m = path.match(/^\/api\/admin\/roles\/([^/]+)\/duplicate$/)
    if (m && method === 'POST') {
      state.roles.push({ ...data, copiedFrom: decodeURIComponent(m[1]) })
      return reply(201, data)
    }
    m = path.match(/^\/api\/admin\/roles\/([^/]+)$/)
    if (m) {
      const id = decodeURIComponent(m[1])
      const role = state.roles.find((r) => r.id === id)
      if (!role) return reply(404, 'not found')
      if (method === 'PUT') Object.assign(role, data)
      if (method === 'DELETE') {
        if (state.users.some((u) => u.roleId === id)) return reply(409, 'conflict')
        state.roles = state.roles.filter((r) => r !== role)
      }
      return reply(200, { ok: true })
    }
    m = path.match(/^\/api\/admin\/users\/([^/]+)$/)
    if (m && method === 'DELETE') {
      const id = decodeURIComponent(m[1])
      if (active.includes(id)) return reply(409, 'user is currently active')
      state.users = state.users.filter((u) => u.id !== id)
      return reply(200, { ok: true })
    }
    return reply(404, 'page not found')
  }
  const api = createKesherRoles({ getUrl: () => 'http://kesher.test', getTicket: () => 'ticket', fetchImpl })
  return { roles: api, state, calls }
}

test('Rollen-ID aus dem Namen, eindeutig', () => {
  assert.equal(roleIdFromName('Licht 2'), 'licht-2')
  assert.equal(roleIdFromName('Bühne & Ton'), 'buehne-ton')
  assert.equal(roleIdFromName('Licht', new Set(['licht', 'licht-2'])), 'licht-3')
  assert.equal(roleIdFromName('!!!'), 'rolle')
})

test('Anlegen meldet sich per Ticket an und wieder ab', async () => {
  const k = fakeKesher({ roles: [{ id: 'ton', name: 'Ton' }] })
  const role = await k.roles.create({ name: 'Licht 1' })
  assert.deepEqual(role, { id: 'licht-1', name: 'Licht 1' })
  assert.deepEqual(k.state.roles.map((r) => r.id), ['ton', 'licht-1'])
  assert.deepEqual(k.calls[0], { method: 'POST', path: '/api/admin/login/central', data: { ticket: 'ticket' }, auth: undefined })
  await new Promise((r) => setImmediate(r))
  assert.equal(k.calls.at(-1).path, '/api/logout')
})

test('Anlegen als Kopie übernimmt die Standardwerte der Vorlage', async () => {
  const k = fakeKesher({ roles: [{ id: 'licht-1', name: 'Licht 1', defaultRoomId: 'pl1', defaultVoiceMode: 'ptt' }] })
  await k.roles.create({ name: 'Licht 2', copyFrom: 'licht-1' })
  const copy = k.state.roles.find((r) => r.id === 'licht-2')
  assert.equal(copy.copiedFrom, 'licht-1')
  assert.equal(copy.defaultRoomId, 'pl1')
  assert.equal(copy.defaultVoiceMode, 'ptt')
})

test('Doppelte Namen werden abgelehnt', async () => {
  const k = fakeKesher({ roles: [{ id: 'ton', name: 'Ton' }] })
  await assert.rejects(k.roles.create({ name: ' ton ' }), { status: 409 })
  await assert.rejects(k.roles.create({ name: '  ' }), { status: 400 })
})

test('Umbenennen behält ID und Standardwerte', async () => {
  const k = fakeKesher({ roles: [{ id: 'ton', name: 'Ton', defaultRoomId: 'pl1', defaultSimpleView: true }] })
  await k.roles.rename('ton', 'Tontechnik')
  assert.deepEqual(k.state.roles[0], { id: 'ton', name: 'Tontechnik', defaultRoomId: 'pl1', defaultVoiceMode: '', defaultSimpleView: true })
})

test('Löschen entfernt erst die Benutzer der Rolle', async () => {
  const k = fakeKesher({
    roles: [{ id: 'ton', name: 'Ton' }, { id: 'licht', name: 'Licht' }],
    users: [{ id: 'u1', username: 'Anna', roleId: 'ton' }, { id: 'u2', username: 'Ben', roleId: 'licht' }],
  })
  await k.roles.remove('ton')
  assert.deepEqual(k.state.roles.map((r) => r.id), ['licht'])
  assert.deepEqual(k.state.users.map((u) => u.id), ['u2'])
})

test('Löschen geht nicht, solange jemand in Kesher verbunden ist', async () => {
  const k = fakeKesher({ roles: [{ id: 'ton', name: 'Ton' }], users: [{ id: 'u1', username: 'Anna', roleId: 'ton' }], active: ['u1'] })
  await assert.rejects(k.roles.remove('ton'), (err) => err.status === 409 && /Anna/.test(err.message))
  assert.equal(k.state.roles.length, 1)
})

test('Falsches Geheimnis gibt eine verständliche Meldung', async () => {
  const k = fakeKesher({ loginStatus: 403 })
  await assert.rejects(k.roles.create({ name: 'Ton' }), /JMS_AUTH_SECRET/)
})
