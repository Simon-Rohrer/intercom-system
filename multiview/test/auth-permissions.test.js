'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { viewConfig, filterMessage, stationLauncherConfig } = require('../auth-permissions')
const { normalizeRaspberry } = require('../raspberry-pis')

function config() {
  return {
    access: { roles: { light: { outputs: ['one'], edit: [], editLayouts: false }, stage: { outputs: ['two'], edit: ['two'], editLayouts: true } } },
    outputs: [{ id: 'one', layoutId: 'first' }, { id: 'two', layoutId: 'second' }],
    layouts: [{ id: 'first', tiles: [{ sourceId: 'camera-one' }] }, { id: 'second', owner: 'stage', tiles: [{ sourceId: 'camera-two' }] }],
    sources: [{ id: 'camera-one' }, { id: 'camera-two' }],
    screens: [{ id: 'screen-one', outputId: 'one' }, { id: 'screen-two', outputId: 'two' }],
    raspberry: { managed: true, clients: [{ name: 'private' }] },
  }
}

test('Read-only role receives only own output, current layout, sources and screen', () => {
  const original = config()
  const visible = viewConfig(original, { roleId: 'light', admin: false })
  assert.deepEqual(visible.outputs.map((output) => output.id), ['one'])
  assert.deepEqual(visible.layouts.map((layout) => layout.id), ['first'])
  assert.deepEqual(visible.sources.map((source) => source.id), ['camera-one'])
  assert.deepEqual(visible.screens.map((screen) => screen.id), ['screen-one'])
  assert.deepEqual(Object.keys(visible.access.roles), ['light'])
  assert.equal(visible.raspberry.clients.length, 0)
  assert.equal(original.outputs.length, 2)
})

test('Unknown role gets no private output or configuration; admin and fixed station retain their views', () => {
  const original = config()
  const unknown = viewConfig(original, { roleId: 'invented', admin: false })
  assert.equal(unknown.outputs.length, 0)
  assert.equal(unknown.layouts.length, 0)
  assert.equal(unknown.sources.length, 0)
  assert.equal(viewConfig(original, { admin: true }), original)
  const station = viewConfig(original, null, { capabilities: ['display'] })
  assert.equal(station.outputs.length, 2)
  assert.equal(station.raspberry.clients.length, 0)
  assert.deepEqual(station.access.roles, {})
  assert.equal(viewConfig(original, null, { capabilities: ['heartbeat'] }).outputs.length, 0)
  assert.equal(viewConfig(original, { roleId: 'light' }, { capabilities: ['display'] }).outputs.length, 1)
})

test('Chat and broadcast filtering enforces role audience instead of frontend-only hiding', () => {
  const payload = {
    type: 'chat', rooms: [{ id: 'one', listeners: ['light'] }, { id: 'two', listeners: ['stage'] }],
    messages: [{ id: 'global', audience: null }, { id: 'own', audience: ['light'] }, { id: 'private', audience: ['stage'] }],
  }
  const filtered = filterMessage(payload, config(), { roleId: 'light' })
  assert.deepEqual(filtered.rooms.map((room) => room.id), ['one'])
  assert.deepEqual(filtered.messages.map((message) => message.id), ['global', 'own'])
  assert.equal(filterMessage({ type: 'chatFlash', audience: ['stage'] }, config(), { roleId: 'light' }), null)
  // Nur die Versionskennung (zum Neuladen nach Updates) – keine Adressen, Ports oder MediaMTX-Zustand
  assert.deepEqual(
    filterMessage({ type: 'server', bootId: 'v1', addresses: ['192.168.0.230'], ports: { rtsp: 8554 }, mediamtx: { status: 'ok' } }, config(), { roleId: 'light' }),
    { type: 'server', bootId: 'v1' },
  )
  assert.equal(filterMessage(payload, config(), null), null)
})

test('Restricted stations receive neither presentation state nor configuration or chat without read capabilities', () => {
  const heartbeat = { roleId: 'light', capabilities: ['heartbeat'] }
  for (const type of ['config', 'atem', 'propresenter', 'ppstage', 'churchtools', 'ctposition', 'chat', 'chatFlash', 'devices', 'screens', 'server', 'sessions_changed'])
    assert.equal(filterMessage({ type, config: config(), messages: [], rooms: [] }, config(), null, heartbeat), null, type)
  const chatOnly = { roleId: 'light', capabilities: ['chat-monitor'] }
  assert.equal(filterMessage({ type: 'config', config: config() }, config(), null, chatOnly), null)
  assert.equal(filterMessage({ type: 'propresenter', private: 'slides' }, config(), null, chatOnly), null)
  const chat = filterMessage({ type: 'chat', rooms: [{ id: 'own', listeners: ['light'] }, { id: 'private', listeners: ['stage'] }],
    messages: [{ id: 'own', roomId: 'own' }, { id: 'private', roomId: 'private' }] }, config(), null, chatOnly)
  assert.deepEqual(chat.messages.map((entry) => entry.id), ['own'])
  assert.deepEqual(filterMessage({ type: 'propresenter', state: 'visible' }, config(), null, { capabilities: ['display'] }),
    { type: 'propresenter', state: 'visible' })
  const ordinary = filterMessage({ type: 'config', config: config() }, config(), { roleId: 'light' }, { capabilities: ['display'] })
  assert.deepEqual(ordinary.config.outputs.map((output) => output.id), ['one'])
})

test('Pi configuration uses the authenticated registry association and never the IP or MAC', () => {
  const raspberry = normalizeRaspberry({ managed: true, clients: [
    { name: 'Camera', roleId: 'camera', ipAddress: '192.168.0.161', macAddresses: ['aa:bb:cc:dd:ee:01'] },
    { name: 'Other', roleId: 'admin-camera', ipAddress: '192.168.0.162', macAddresses: ['aa:bb:cc:dd:ee:02'] },
    { name: 'Unregistered', roleId: 'unregistered', macAddresses: ['aa:bb:cc:dd:ee:03'] },
  ] })
  assert.deepEqual(stationLauncherConfig(raspberry, { capabilities: ['pi-config'], raspberryClientId: 'pi1' }).config.clients.map((client) => client.role_id), ['camera'])
  assert.deepEqual(stationLauncherConfig(raspberry, '192.168.0.161'), { managed: false })
  assert.deepEqual(stationLauncherConfig(raspberry, { capabilities: [], raspberryClientId: 'pi1' }), { managed: false })
  assert.equal(stationLauncherConfig(raspberry, { capabilities: ['pi-config'], raspberryClientId: 'unknown' }).config.clients.length, 0)
})


test('chat-only configuration and websocket feed exclude every other system', () => {
  const original = config()
  original.access.roles.tech = { chatOnly: true, outputs: ['one'], editLayouts: true, controlSlides: true }
  const user = { roleId: 'tech', chatOnly: true }
  const visible = viewConfig(original, user)
  assert.deepEqual(visible.outputs, [])
  assert.deepEqual(visible.layouts, [])
  assert.equal(visible.access.roles.tech.editLayouts, false)
  for (const type of ['atem', 'ppstage', 'propresenter', 'levels', 'churchtools', 'ctposition', 'uplink', 'youtube', 'slideshow', 'devices', 'screens', 'templates_changed'])
    assert.equal(filterMessage({ type, private: 'secret' }, original, user), null, type)
  const chat = filterMessage({ type: 'chat', rooms: [], messages: [{ id: 'global' }, { id: 'private', audience: ['light'] }] }, original, user)
  assert.deepEqual(chat.messages.map(m => m.id), ['global'])
})
