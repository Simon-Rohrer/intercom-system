// Rechte im Browser – dieselben Regeln wie auf dem Server (access.js). Der Server prüft
// selbst; hier geht es nur darum, nichts anzubieten, was dann doch nicht gespeichert wird.

/** user = { admin, roleId } aus /api/me (offener Zugang: admin = true). */
export function roleRights(config, user) {
  if (!user) return null
  if (user.admin) return { admin: true, editLayouts: true, outputs: config.outputs.map((o) => o.id) }
  const r = config.access?.roles?.[user.roleId]
  return {
    admin: false,
    editLayouts: r?.editLayouts !== false,
    outputs: (r?.outputs ?? []).filter((id) => config.outputs.some((o) => o.id === id)),
  }
}

export function visibleOutputs(config, user) {
  const rights = roleRights(config, user)
  if (!rights) return []
  return config.outputs.filter((o) => rights.outputs.includes(o.id))
}

export function canEditLayout(config, user, layout) {
  const rights = roleRights(config, user)
  if (!rights || !layout) return false
  if (rights.admin) return true
  if (!rights.editLayouts) return false
  if (layout.owner === user.roleId) return true
  if (layout.owner && layout.owner !== user.roleId) return false
  if (layout.shared) return false
  const usedBy = config.outputs.filter((o) => o.layoutId === layout.id).map((o) => o.id)
  return usedBy.length > 0 && usedBy.every((id) => rights.outputs.includes(id))
}

export function visibleLayouts(config, user) {
  const rights = roleRights(config, user)
  if (!rights) return []
  if (rights.admin) return config.layouts
  return config.layouts.filter(
    (l) =>
      l.owner === user.roleId ||
      l.shared === true ||
      config.outputs.some((o) => rights.outputs.includes(o.id) && o.layoutId === l.id),
  )
}

/** Wie claimLayouts in access.js: Layouts nur auf eigenen Multiviews gehören danach der Rolle. */
export function claimLayouts(config, user) {
  const rights = roleRights(config, user)
  if (!rights || rights.admin) return
  for (const layout of config.layouts) {
    if (layout.owner || layout.shared) continue
    const usedBy = config.outputs.filter((o) => o.layoutId === layout.id).map((o) => o.id)
    if (usedBy.length && usedBy.every((id) => rights.outputs.includes(id))) layout.owner = user.roleId
  }
}

/** Adresse dieses Servers, wie sie ein Handy im Netz erreicht (nicht 127.0.0.1). */
export function publicOrigin(serverInfo) {
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname)
  // Das LAN zuerst – nicht Docker (172.x), VPN (10.8.x) oder Tailscale (100.x)
  const list = (serverInfo?.addresses ?? []).filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a))
  const address =
    list.find((a) => a.startsWith('192.168.')) ??
    list.find((a) => !a.startsWith('172.') && !a.startsWith('10.8.') && !a.startsWith('100.'))
  if (!loopback || !address) return location.origin
  return `${location.protocol}//${address}${location.port ? `:${location.port}` : ''}`
}

/**
 * Chat so, wie ihn eine Rolle in Kesher sieht (audience kommt vom Server aus den
 * Party-Line-Rechten). roleId leer = alles.
 */
export function chatFor(chat, roleId) {
  if (!roleId || !chat?.messages) return chat
  return { ...chat, messages: chat.messages.filter((m) => !m.audience || m.audience.includes(roleId)) }
}

/** Welche Rolle der Chat einer Kachel zeigt: fest gewählt, alle ('*') oder die angemeldete. */
export function chatRoleFor(tile, user) {
  if (tile?.chatRole === '*') return ''
  if (tile?.chatRole) return tile.chatRole
  return user && !user.admin && !user.open ? user.roleId : ''
}
