'use strict'

// ProPresenter-Ebenen aus- und mit derselben Taste wieder einblenden (Companion, Stream Deck).
// ProPresenter selbst kann nur „Clear“. Deshalb merkt sich JMS Control beim Ausblenden, was auf
// der Ebene lief, und löst es beim Einblenden erneut aus:
//   slide          → die zuletzt gezeigte Folie
//   media          → die Folie, die den Hintergrund gestartet hat (danach wieder der Text darüber),
//                    sonst das Medium aus einer Media-Playlist
//   audio          → das Audio aus seiner Playlist, an derselben Stelle
//   props/messages → die aktiven Props bzw. Meldungen (mit ihren Platzhaltern)
//   announcements  → die laufende Ankündigungsfolie
//   video_input    → der einzige Video-Eingang
//   all            → alles, was sichtbar war

const LAYERS = ['slide', 'media', 'audio', 'props', 'messages', 'announcements', 'video_input']
// Beim Wiedereinblenden von „Alles“: Hintergrund vor dem Text, Rest danach
const RESTORE_ORDER = ['media', 'slide', 'props', 'messages', 'announcements', 'audio', 'video_input']

const enc = encodeURIComponent
const uuidOf = (x) => x?.id?.uuid ?? x?.uuid ?? null

/** „fractal-glow-17-hd.mp4“ passt zur Folien-Beschriftung „fractal-glow-17-hd“ */
function sameMedia(label, name) {
  const norm = (s) => String(s || '').toLowerCase().replace(/\.[a-z0-9]{2,5}$/, '').replace(/[^a-z0-9]+/g, '')
  const a = norm(label)
  return Boolean(a && a === norm(name))
}

/**
 * deps: get(path) → JSON | null, send(path, { method, body }) → löst in ProPresenter aus,
 * slideTarget() → { presentation: { uuid }, index } | null (laufende oder zuletzt gezeigte Folie),
 * backgroundAt(target) → Promise<{ presentation, cue, label } | null>
 */
function createPpLayers({ get, send, slideTarget, backgroundAt, load = () => ({}), save = () => {} }) {
  // Ebene → was beim Ausblenden lief; gespeichert, damit es einen Neustart von JMS Control übersteht
  const held = { ...load() }
  const remember = (layer, snap) => {
    held[layer] = snap
    save({ ...held })
  }
  // Was zuletzt sichtbar lief – falls jemand direkt in ProPresenter „Clear“ drückt
  const seen = {}
  let observing = false
  let observedAt = 0

  async function findInPlaylists(listPath, itemPath, uuid, name) {
    const flat = []
    const walk = (list) => {
      for (const p of list || []) {
        if (p?.type !== 'group') flat.push(p)
        walk(p?.children)
      }
    }
    walk(await get(listPath).catch(() => null))
    // Erst dieselbe Datei (ID), sonst derselbe Name – in Playlists oft ohne Endung („loop“ statt „loop.mp4“)
    let byName = null
    for (const p of flat) {
      const id = uuidOf(p)
      if (!id) continue
      const items = (await get(`${itemPath}/${enc(id)}`).catch(() => null))?.items || []
      const hit = uuid && items.find((i) => uuidOf(i) === uuid)
      if (hit) return `${itemPath}/${enc(id)}/${enc(uuidOf(hit))}/trigger`
      const named = !byName && name && items.find((i) => sameMedia(i?.id?.name, name))
      if (named) byName = `${itemPath}/${enc(id)}/${enc(uuidOf(named))}/trigger`
    }
    return byName
  }

  async function snapshot(layer) {
    switch (layer) {
      case 'slide': {
        const t = slideTarget()
        return t ? { presentation: t.presentation.uuid, index: t.index } : null
      }
      case 'media': {
        const current = await get('/v1/transport/presentation/current').catch(() => null)
        const t = slideTarget()
        const bg = t ? await backgroundAt(t).catch(() => null) : null
        return { uuid: current?.uuid || null, name: current?.name || '', bg }
      }
      case 'audio': {
        const current = await get('/v1/transport/audio/current').catch(() => null)
        const time = await get('/v1/transport/audio/time').catch(() => null)
        return current?.uuid ? { uuid: current.uuid, name: current.name || '', time: Number(time) || 0 } : null
      }
      case 'props': {
        const active = ((await get('/v1/props')) || []).filter((p) => p?.is_active).map(uuidOf).filter(Boolean)
        return active.length ? { ids: active } : null
      }
      case 'messages': {
        const active = ((await get('/v1/messages')) || []).filter((m) => m?.is_active)
        return active.length ? { list: active.map((m) => ({ id: uuidOf(m), tokens: m.tokens || [] })) } : null
      }
      case 'announcements': {
        const idx = (await get('/v1/announcement/slide_index'))?.announcement_index
        return idx && Number.isInteger(idx.index) ? { index: idx.index, presentation: uuidOf(idx.presentation_id) } : null
      }
      case 'video_input':
        return {}
      default:
        return null
    }
  }

  /** textAfter: Text nach dem Hintergrund wieder einblenden (true), ausgeblendet lassen (false) */
  async function restoreMedia(snap, textAfter) {
    if (snap?.bg && (!snap.name || sameMedia(snap.bg.label, snap.name))) {
      await send(`/v1/presentation/${enc(snap.bg.presentation)}/${snap.bg.cue}/trigger`)
      // Die Hintergrund-Folie hat eigenen (meist keinen) Text: danach den vorherigen Zustand herstellen
      const text = textAfter ? (await snapshot('slide')) ?? held.slide : null
      if (text && (text.presentation !== snap.bg.presentation || text.index !== snap.bg.cue)) {
        await send(`/v1/presentation/${enc(text.presentation)}/${text.index}/trigger`)
      } else if (!textAfter) {
        await send('/v1/clear/layer/slide')
      }
      return
    }
    const path = snap && (await findInPlaylists('/v1/media/playlists', '/v1/media/playlist', snap.uuid, snap.name))
    if (!path) throw Object.assign(new Error('Hintergrund unbekannt – bitte in ProPresenter neu starten'), { status: 409 })
    await send(path)
  }

  async function restore(layer, snap, layers) {
    switch (layer) {
      case 'slide':
        if (!snap) throw Object.assign(new Error('Keine Folie zum Einblenden'), { status: 409 })
        return send(`/v1/presentation/${enc(snap.presentation)}/${snap.index}/trigger`)
      case 'media':
        return restoreMedia(snap, Boolean(layers?.slide))
      case 'audio': {
        const path = snap && (await findInPlaylists('/v1/audio/playlists', '/v1/audio/playlist', snap.uuid, snap.name))
        if (!path) throw Object.assign(new Error('Audio unbekannt – bitte in ProPresenter neu starten'), { status: 409 })
        await send(path)
        if (snap.time > 1) await send('/v1/transport/audio/time', { method: 'PUT', body: snap.time }).catch(() => {})
        return
      }
      case 'props':
        if (!snap?.ids?.length) throw Object.assign(new Error('Keine Props zum Einblenden'), { status: 409 })
        for (const id of snap.ids) await send(`/v1/prop/${enc(id)}/trigger`)
        return
      case 'messages':
        if (!snap?.list?.length) throw Object.assign(new Error('Keine Meldung zum Einblenden'), { status: 409 })
        for (const m of snap.list) await send(`/v1/message/${enc(m.id)}/trigger`, { method: 'POST', body: m.tokens })
        return
      case 'announcements':
        if (!snap) throw Object.assign(new Error('Keine Ankündigung zum Einblenden'), { status: 409 })
        return send(`/v1/announcement/active/${snap.index}/trigger`)
      case 'video_input': {
        const inputs = (await get('/v1/video_inputs')) || []
        if (inputs.length !== 1) throw Object.assign(new Error('Video-Eingang nicht eindeutig'), { status: 409 })
        return send(`/v1/video_inputs/${enc(uuidOf(inputs[0]) ?? 0)}/trigger`)
      }
      default:
        throw Object.assign(new Error('Unbekannte Ebene'), { status: 400 })
    }
  }

  /** Aus der laufenden Abfrage: laufenden Hintergrund und Audio merken (höchstens alle 3 s) */
  async function observe(layers, now = Date.now()) {
    if (!layers || observing || now - observedAt < 3000) return
    observing = true
    observedAt = now
    try {
      for (const l of ['media', 'audio']) if (layers[l]) seen[l] = (await snapshot(l).catch(() => null)) ?? seen[l]
    } finally {
      observing = false
    }
  }

  /** Sichtbar → ausblenden, sonst wieder einblenden. Antwort: { layer, visible } (neuer Zustand) */
  async function toggle(layer) {
    if (layer !== 'all' && !LAYERS.includes(layer)) throw Object.assign(new Error('Unbekannte Ebene'), { status: 400 })
    const layers = (await get('/v1/status/layers')) || {}
    if (layer === 'all') {
      const visible = LAYERS.filter((l) => layers[l])
      if (visible.length) {
        const snaps = {}
        for (const l of visible) snaps[l] = await snapshot(l).catch(() => null)
        for (const l of visible) await send(`/v1/clear/layer/${l}`)
        Object.assign(held, snaps)
        remember('all', { layers: visible, snaps })
        return { layer, visible: false }
      }
      const all = held.all
      if (!all) throw Object.assign(new Error('Nichts zum Einblenden'), { status: 409 })
      const errors = []
      for (const l of RESTORE_ORDER.filter((x) => all.layers.includes(x))) {
        // Mit Hintergrund stellt restoreMedia den Text gleich mit her
        if (l === 'slide' && all.layers.includes('media')) continue
        try {
          if (l === 'media') await restoreMedia(all.snaps.media, all.layers.includes('slide'))
          else await restore(l, all.snaps[l], layers)
        } catch (err) {
          errors.push(err.message)
        }
      }
      if (errors.length) throw Object.assign(new Error(errors.join(' · ')), { status: 409 })
      return { layer, visible: true }
    }
    if (layers[layer]) {
      remember(layer, await snapshot(layer).catch(() => null))
      await send(`/v1/clear/layer/${layer}`)
      return { layer, visible: false }
    }
    await restore(layer, held[layer] ?? seen[layer] ?? null, layers)
    return { layer, visible: true }
  }

  return { toggle, observe, held }
}

module.exports = { createPpLayers, sameMedia, LAYERS }
