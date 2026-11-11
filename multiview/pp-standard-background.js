'use strict'

// Standard-Hintergrund für ProPresenter: ein festes Medium aus einer Media-Playlist (z. B.
// „color-waves-blue-hd“ in „FAVORITEN Lichttechnik“), das eine Stream-Deck-Taste (Companion-Modul
// „JMS Control“) auf die Media-Ebene legt. Welches, legt der Admin unter Einstellungen → ProPresenter
// fest (config.propresenter.standardBackground). Ausgelöst wird über pp-layers.js (startMedia), damit
// die Ebenen-Tasten wissen, was danach auf der Media-Ebene läuft.

const { sameMedia } = require('./pp-layers')

const PP_ID = /^[0-9A-Za-z-]{1,64}$/
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/** { playlistUuid, itemUuid, name, playlistName } oder null (nicht festgelegt / ungültig) */
function normalizeStandardBackground(v) {
  const playlistUuid = text(v?.playlistUuid, 64)
  const itemUuid = text(v?.itemUuid, 64)
  if (!PP_ID.test(playlistUuid) || !PP_ID.test(itemUuid)) return null
  return { playlistUuid, itemUuid, name: text(v.name), playlistName: text(v.playlistName) }
}

/**
 * Alle Media-Playlists mit ihren Einträgen für die Auswahl in den Einstellungen.
 * get(path) → JSON (GET, nur lesend). Gruppen werden zum Pfad („Background Playlists › HEUTE“).
 * Antwort: [{ uuid, name, path, items: [{ uuid, name, type }] }]
 */
async function listMediaPlaylists(get) {
  const lists = []
  const walk = (entries, parents) => {
    for (const e of Array.isArray(entries) ? entries : []) {
      const uuid = e?.id?.uuid
      const name = String(e?.id?.name || '')
      if ((e?.type ?? e?.field_type) !== 'group' && uuid) lists.push({ uuid, name, path: [...parents, name].join(' › ') })
      walk(e?.children, (e?.type ?? e?.field_type) === 'group' ? [...parents, name] : parents)
    }
  }
  walk(await get('/v1/media/playlists'), [])
  const contents = await Promise.all(
    lists.map((l) => get(`/v1/media/playlist/${encodeURIComponent(l.uuid)}`).catch(() => null)),
  )
  return lists.map((l, i) => ({
    ...l,
    items: (contents[i]?.items ?? [])
      .filter((it) => it?.id?.uuid && it.type !== 'header')
      .map((it) => ({ uuid: it.id.uuid, name: String(it.id.name || ''), type: String(it.type || '') })),
  }))
}

/**
 * Zustand für GET /api/state (Companion: Rückmeldung „Standard-Hintergrund läuft“).
 * pp: ppState (connected, layers), current: was pp-layers zuletzt auf der Media-Ebene gesehen hat.
 */
function standardBackgroundState(std, pp, current) {
  if (!std) return { configured: false, name: '', playlist: '', active: false }
  const visible = Boolean(pp?.connected && pp?.layers?.media)
  const same = Boolean(current && (current.uuid === std.itemUuid || (std.name && sameMedia(std.name, current.name))))
  return { configured: true, name: std.name, playlist: std.playlistName, active: visible && same }
}

module.exports = { normalizeStandardBackground, listMediaPlaylists, standardBackgroundState }
