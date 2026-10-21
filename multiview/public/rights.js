import { qrOrigin } from './common.js'

// Rechte im Browser – dieselben Regeln wie auf dem Server (access.js). Der Server prüft
// selbst; hier geht es nur darum, nichts anzubieten, was dann doch nicht gespeichert wird.

/** user = { admin, roleId } aus /api/me (offener Zugang: admin = true). */
export function roleRights(config, user) {
  if (!user) return null
  const all = config.outputs.map((o) => o.id)
  if (user.admin) return { admin: true, editLayouts: true, controlSlides: true, outputs: all, edit: all }
  const r = config.access?.roles?.[user.roleId]
  const outputs = (r?.outputs ?? []).filter((id) => all.includes(id))
  return {
    admin: false,
    editLayouts: Boolean(r && r.editLayouts !== false),
    controlSlides: Boolean(r?.controlSlides),
    outputs,
    // Bearbeiten (umschalten, laufendes Layout ändern); ohne Angabe wie früher: alles Freigegebene
    edit: Array.isArray(r?.edit) ? r.edit.filter((id) => outputs.includes(id)) : outputs,
  }
}

/** Darf der Nutzer diesen Multiview bearbeiten (Layout umschalten, laufendes Layout ändern)? */
export function canEditOutput(config, user, outputId) {
  return Boolean(roleRights(config, user)?.edit.includes(outputId))
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
  if (layout.shared) return false
  if (layout.owner === user.roleId) return true
  return config.outputs.some((o) => rights.edit.includes(o.id) && o.layoutId === layout.id)
}

export function visibleLayouts(config, user) {
  const rights = roleRights(config, user)
  if (!rights) return []
  if (rights.admin) return config.layouts
  return config.layouts.filter(
    (l) =>
      l.owner === user.roleId ||
      l.shared === true ||
      // auch das zuletzt gelaufene, damit man nach „Aus“ wieder einschalten kann
      config.outputs.some((o) => rights.edit.includes(o.id) && (o.layoutId === l.id || o.lastLayoutId === l.id)),
  )
}

/** Wie claimLayouts in access.js: Layouts nur auf eigenen Multiviews gehören danach der Rolle. */
export function claimLayouts(config, user) {
  const rights = roleRights(config, user)
  if (!rights || rights.admin) return
  for (const layout of config.layouts) {
    if (layout.owner || layout.shared) continue
    const usedBy = config.outputs.filter((o) => o.layoutId === layout.id).map((o) => o.id)
    if (usedBy.length && usedBy.every((id) => rights.edit.includes(id))) layout.owner = user.roleId
  }
}

/** Adresse dieses Servers, wie sie ein Handy im Netz erreicht (nicht 127.0.0.1). */
/** Adresse für QR-Codes und Links zum Weitergeben: immer die IP im LAN (siehe qrOrigin). */
export function publicOrigin(serverInfo, startUrl = '') {
  return qrOrigin(serverInfo?.addresses, startUrl)
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
