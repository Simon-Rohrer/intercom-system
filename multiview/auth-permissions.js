'use strict'

const { allowedOutputs, visibleLayouts, roleRights } = require('./access')
const { launcherConfig } = require('./raspberry-pis')

function viewConfig(config, user, station = null) {
  if (user?.admin) return config
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

module.exports = { viewConfig, filterMessage, stationLauncherConfig }
