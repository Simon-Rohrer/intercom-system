'use strict'

const { allowedOutputs, visibleLayouts, roleRights } = require('./access')
const { launcherConfig } = require('./raspberry-pis')

function viewConfig(config, user, station = null) {
  if (user?.admin) return config
  if (user?.chatOnly || roleRights(config, user)?.chatOnly)
    return { outputs: [], layouts: [], sources: [], screens: [], raspberry: { managed: false, clients: [] },
      access: { roles: { [user.roleId]: roleRights(config, user) } } }
  if (!user && station?.capabilities?.some((capability) => ['display', 'control'].includes(capability)))
    return { ...config, raspberry: { managed: false, clients: [] }, access: { roles: {} } }
  const outputs = allowedOutputs(config, user)
  const layouts = new Set(visibleLayouts(config, user).map((layout) => layout.id))
  for (const output of config.outputs) if (outputs.has(output.id) && output.layoutId) layouts.add(output.layoutId)
  const visible = config.layouts.filter((layout) => layouts.has(layout.id))
  const sourceIds = new Set(visible.flatMap((layout) => (layout.tiles || []).map((tile) => tile.sourceId)))
  return { ...config, layouts: visible, outputs: config.outputs.filter((output) => outputs.has(output.id)),
    sources: roleRights(config, user)?.editLayouts ? config.sources : config.sources.filter((source) => sourceIds.has(source.id)),
    screens: config.screens.filter((screen) => outputs.has(screen.outputId)), raspberry: { managed: false, clients: [] },
    access: { roles: user?.roleId && config.access.roles[user.roleId] ? { [user.roleId]: config.access.roles[user.roleId] } : {} } }
}

function filterMessage(msg, config, user, station = null) {
  if (user?.admin) return msg
  if (!user && station) {
    const displays = station.capabilities?.some((capability) => ['display', 'control'].includes(capability))
    if (['chat', 'chatFlash'].includes(msg.type)) {
      if (!displays && !station.capabilities?.includes('chat-monitor')) return null
    } else if (!displays) return null
    if (msg.type === 'config') return { ...msg, config: viewConfig(config, null, station) }
    if (['devices', 'screens', 'server'].includes(msg.type)) return station.capabilities?.includes('display') ? msg : null
    user = { roleId: station.roleId, admin: false }
  }
  if (!user) return null
  if ((user.chatOnly || roleRights(config, user)?.chatOnly) && !['config', 'server', 'chat', 'chatFlash'].includes(msg.type)) return null
  if (msg.type === 'config') return { ...msg, config: viewConfig(config, user) }
  // Nur die Versionskennung – damit offene Seiten nach einem Update von selbst neu laden
  if (msg.type === 'server') return { type: 'server', bootId: msg.bootId }
  if (['devices', 'screens', 'sessions_changed'].includes(msg.type)) return null
  if (msg.type === 'chat') {
    const rooms = (msg.rooms || []).filter((room) => room.listeners?.includes(user.roleId) || room.talkers?.includes(user.roleId))
    const permitted = new Set(rooms.map((room) => room.id))
    return { ...msg, rooms, messages: (msg.messages || []).filter((entry) => (!entry.audience || entry.audience.includes(user.roleId)) && (!entry.roomId || permitted.has(entry.roomId))) }
  }
  if (msg.type === 'chatFlash' && msg.audience && !msg.audience.includes(user.roleId)) return null
  if (msg.type === 'churchtools') return { ...msg, url: '', user: '' }
  return msg
}

function stationLauncherConfig(raspberry, machine) {
  if (!machine?.capabilities?.includes('pi-config') || !machine.raspberryClientId) return { managed: false }
  return launcherConfig(raspberry, { clientId: machine.raspberryClientId })
}

// Explicit allowlist: a chat session cannot use another API, download, proxy or control page.
function chatOnlyRequestAllowed(method, requestPath) {
  const path = requestPath.replace(/^\/\.jms-auth(?=\/)/, '')
  const read = method === 'GET' || method === 'HEAD'
  if (read && ['/api/me', '/api/login/roles', '/api/device', '/api/sso', '/api/chat', '/check', '/login',
    '/chat', '/sso/start', '/sso/issue', '/sso/accept', '/sso/push'].includes(path)) return true
  if (method === 'POST' && ['/api/login', '/api/logout', '/logout', '/api/chat/send'].includes(path)) return true
  if (!read) return false
  return ['/remote.html', '/login.html', '/remote.js', '/remote.css', '/admin.css', '/login.js',
    '/common.js', '/rights.js', '/theme.js', '/theme-boot.js', '/avatar.js', '/chat-compose.js',
    '/legacy-runtime.js', '/services.js', '/watch-login.js', '/jms-logo.svg', '/prediger-icon.png'].includes(path) || /^\/fonts\/[a-z0-9-]+\.woff2$/.test(path) || /^\/api\/wallpaper\/[a-z0-9-]+\.jpg$/.test(path)
}

module.exports = { viewConfig, filterMessage, stationLauncherConfig, chatOnlyRequestAllowed }
