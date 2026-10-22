// ProPresenter-Kacheln: Folien (aktuell/nächste, über ihrem Hintergrund), Hintergründe und Playlist.

// nextMode: 'background' = nächste Folie, die einen Hintergrund startet (Video, Bild, PDF …),
//           'direct' = direkt folgende Folie
export const PP_DEFAULTS = { show: 'both', content: 'image', showName: true, nextMode: 'background', showControls: false, blankMode: 'clearAll' }
// source: '' = die gerade aktive Playlist, sonst die UUID einer festen Playlist (sourceName zur Anzeige)
// view: 'list' = Einträge untereinander, 'slides' = alle Folien jedes Lieds als Bilder,
//       'show' = alle Folien nacheinander wie eine Diashow (seconds je Folie, fit wie bei der Diashow)
export const PLAYLIST_DEFAULTS = { thumbs: true, size: 1, source: '', sourceName: '', view: 'list', seconds: 10, fit: 'contain' }

const SHOW_MODES = ['both', 'current', 'next', 'backgrounds', 'nextBackground']

export function ppOptions(options) {
  const o = { ...PP_DEFAULTS, ...options }
  if (!SHOW_MODES.includes(o.show)) o.show = 'both'
  if (!['image', 'text', 'both'].includes(o.content)) o.content = 'image'
  if (!['background', 'direct'].includes(o.nextMode)) o.nextMode = 'background'
  return o
}

export function playlistOptions(options) {
  const o = { ...PLAYLIST_DEFAULTS, ...options }
  if (typeof o.source !== 'string') o.source = ''
  if (!['list', 'slides', 'show'].includes(o.view)) o.view = 'list'
  const seconds = Number(o.seconds)
  o.seconds = Number.isFinite(seconds) ? Math.min(120, Math.max(3, Math.round(seconds))) : 10
  if (!['contain', 'cover'].includes(o.fit)) o.fit = 'contain'
  return o
}

/** Folien für „Als Diashow“: alle eingeschalteten Folien der sichtbaren Lieder, in Reihenfolge */
export function playlistShowSlides(pl) {
  const out = []
  for (const it of pl?.items || []) {
    if (it.type === 'header' || it.hidden || !it.presentation) continue
    ;(pl.songs?.[it.presentation] || []).forEach((cue, i) => {
      if (cue.enabled !== false) out.push({ key: `${it.presentation}:${i}`, presentation: it.presentation, cue: i })
    })
  }
  return out
}

/**
 * Die Playlist, die die Kachel zeigt: die aktive oder eine feste. Ist die feste gerade aktiv, mit
 * laufendem/nächstem Eintrag; sonst ist der Eintrag „laufend“, dessen Lied gerade läuft.
 */
export function shownPlaylist(state, o) {
  if (!o.source) return state?.playlist ? { ...state.playlist, songs: state.songs || {} } : null
  const fixed = state?.playlists?.[o.source]
  if (!fixed || fixed.missing) return null
  if (state.playlist?.uuid === o.source) return { ...state.playlist, songs: state.songs || {} }
  const live = state.presentation?.uuid
  const activeIndex = live ? (fixed.items.find((it) => it.presentation === live)?.index ?? null) : null
  return { name: fixed.name || o.sourceName, items: fixed.items, activeIndex, nextIndex: null, focusedIndex: null, songs: state.songs || {} }
}

/** Adresse eines Folienbilds (über den Multiview-Server). */
const thumbUrl = (ref, quality = 960, format = 'jpeg') =>
  ref ? `/api/propresenter/thumb/${encodeURIComponent(ref.presentation)}/${ref.cue}?q=${quality}&fmt=${format}` : ''

/** Folienbild als PNG – Textfolien sind transparent und liegen über dem Hintergrund. */
const slideUrl = (ref) => thumbUrl(ref, 960, 'png')

// ProPresenter zeichnet transparente Bereiche als festes Schachbrett in die Vorschaubilder
// (exakt diese zwei Grautöne). Für die Folien über dem Hintergrund werden sie wieder durchsichtig.
const CHECKER = [34, 10]
const keyedCache = new Map() // Bildadresse -> Blob-URL ohne Schachbrett

async function removeChecker(image, src) {
  if (keyedCache.has(src)) return keyedCache.get(src)
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(image, 0, 0)
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const d = pixels.data
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i]
    if (r === d[i + 1] && r === d[i + 2] && (Math.abs(r - CHECKER[0]) <= 1 || Math.abs(r - CHECKER[1]) <= 1)) d[i + 3] = 0
  }
  ctx.putImageData(pixels, 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  const url = URL.createObjectURL(blob)
  keyedCache.set(src, url)
  // Zwischenspeicher klein halten
  if (keyedCache.size > 40) {
    const [oldSrc, oldUrl] = keyedCache.entries().next().value
    keyedCache.delete(oldSrc)
    URL.revokeObjectURL(oldUrl)
  }
  return url
}

/**
 * Bild, das erst nach dem Laden getauscht wird – so flackert beim Wechsel nichts.
 * key = Schachbrett (transparente Bereiche) entfernen.
 */
function swapImage(img, { key = false } = {}) {
  let wanted = ''
  return (src) => {
    if (src === wanted) return
    wanted = src
    if (!src) {
      img.hidden = true
      img.removeAttribute('src')
      return
    }
    const preload = new Image()
    preload.onload = async () => {
      if (wanted !== src) return
      let shown = src
      if (key) {
        try {
          shown = await removeChecker(preload, src)
        } catch {
          // Bild trotzdem zeigen, nur eben mit Schachbrett
        }
        if (wanted !== src) return
      }
      img.src = shown
      img.hidden = false
    }
    preload.onerror = () => {
      if (wanted === src) img.hidden = true
    }
    preload.src = src
  }
}

function createPane(kind, title) {
  const pane = document.createElement('div')
  pane.className = `pp-pane pp-${kind}`
  pane.innerHTML = `
    <div class="pp-tag"></div>
    <div class="pp-slide">
      <div class="pp-stack">
        <img class="pp-bg" alt="" hidden>
        <img class="pp-img" alt="" hidden>
      </div>
      <div class="pp-text"></div>
      <div class="pp-empty"></div>
    </div>
    <div class="pp-caption"></div>`
  pane.querySelector('.pp-tag').textContent = title
  const setBg = swapImage(pane.querySelector('.pp-bg'))
  const setImg = swapImage(pane.querySelector('.pp-img'), { key: true })
  return {
    el: pane,
    /** img/bg = Bildadressen, text = Folientext, caption = Zeile darunter, empty = Hinweis ohne Inhalt */
    set({ img = '', bg = '', text = '', caption = '', empty = '' }) {
      setImg(img)
      setBg(bg)
      pane.querySelector('.pp-text').textContent = text || ''
      pane.querySelector('.pp-caption').textContent = caption || ''
      pane.querySelector('.pp-empty').textContent = !img && !bg && !text ? empty : ''
    },
  }
}

const bgCaption = (b) => (b ? [b.label, b.song].filter(Boolean).join(' · ') : '')

/** Hinweis, aus welchem Lied etwas kommt: angeklickt (übersprungen) oder nächstes laut Playlist. */
function songNote(state, presentation) {
  if (!presentation || presentation === state.presentation?.uuid) return ''
  if (state.focused?.presentation === presentation) return `angeklickt: ${state.focused.name}`
  const name = state.playlist?.items.find((it) => it.presentation === presentation)?.name
  return name ? `Lied: ${name}` : ''
}

/**
 * Folien-/Hintergrund-Kachel. update(state) mit dem ProPresenter-Zustand vom Server aufrufen.
 * interactive = Steuer-Tasten lösen wirklich aus (nur auf den Monitoren, nicht im Editor).
 */
export function createProPresenterView(options, { interactive = false } = {}) {
  const o = ppOptions(options)
  const el = document.createElement('div')
  el.className = `pp-view pp-show-${o.show} pp-content-${o.content}`
  el.innerHTML = `<div class="pp-header"></div><div class="pp-panes"></div><div class="pp-offline" hidden></div>`
  const header = el.querySelector('.pp-header')
  header.hidden = !o.showName
  const panes = el.querySelector('.pp-panes')
  const offline = el.querySelector('.pp-offline')

  const backgrounds = o.show === 'backgrounds' || o.show === 'nextBackground'
  const first = createPane('current', backgrounds ? 'Hintergrund jetzt' : 'Aktuelle Folie')
  const nextTitle = o.nextMode === 'background' ? 'Nächste Folie mit Hintergrund' : 'Nächste Folie'
  const second = createPane('next', backgrounds ? 'Nächster Hintergrund' : nextTitle)
  if (['both', 'current', 'backgrounds'].includes(o.show)) panes.append(first.el)
  if (['both', 'next', 'backgrounds', 'nextBackground'].includes(o.show)) panes.append(second.el)
  el.classList.toggle('pp-two', panes.children.length === 2)
  const controls = o.showControls ? createControls({ interactive, blankMode: o.blankMode }) : null
  if (controls) el.append(controls.el)

  return {
    el,
    update(state) {
      controls?.update(state)
      const connected = Boolean(state?.connected)
      offline.hidden = connected
      panes.hidden = !connected
      offline.textContent = state?.host ? 'ProPresenter nicht erreichbar' : 'ProPresenter nicht eingerichtet'
      if (!connected) return
      header.textContent = state.presentation?.name ?? state.playlist?.name ?? ''

      if (backgrounds) {
        const { current, next } = state.background ?? {}
        first.set({ img: thumbUrl(current), caption: bgCaption(current), empty: 'Kein Hintergrund' })
        const nextNote = next && state.focused?.presentation === next.presentation ? 'angeklickt: ' : ''
        second.set({ img: thumbUrl(next), caption: nextNote + bgCaption(next), empty: 'Kein weiterer Hintergrund' })
        return
      }
      const withImage = o.content !== 'text'
      const withText = o.content !== 'image'
      const nextSong = state.nextSlide && state.nextSlide.presentation !== state.presentation?.uuid
      first.set({
        img: withImage ? slideUrl(state.currentSlide) : '',
        bg: withImage ? thumbUrl(state.currentSlideBg) : '',
        text: withText ? state.current?.text?.trim() : '',
        empty: 'Keine Folie aktiv',
      })
      if (o.nextMode === 'background') {
        // Folie, die den nächsten Hintergrund startet – ihr Bild enthält den Hintergrund schon
        const v = state.nextBgSlide
        second.set({
          img: withImage ? slideUrl(v) : '',
          text: withText ? v?.text : '',
          caption: v ? [v.label, songNote(state, v.presentation)].filter(Boolean).join(' · ') : '',
          empty: 'Keine weitere Folie mit Hintergrund',
        })
        return
      }
      second.set({
        img: withImage ? slideUrl(state.nextSlide) : '',
        bg: withImage ? thumbUrl(state.nextSlideBg) : '',
        text: withText ? state.next?.text?.trim() : '',
        caption: nextSong ? songNote(state, state.nextSlide.presentation) : '',
        empty: state.presentation ? 'Ende der Präsentation' : 'Keine Folie aktiv',
      })
    },
  }
}

/** Playlist-Kachel: alle Einträge, laufendes Lied hervorgehoben, nächstes markiert. */
/** Playlist als Diashow: jede Folie `seconds` lang, mit Überblendung; das nächste Bild lädt vorher */
function createPlaylistShow(o) {
  const el = document.createElement('div')
  el.className = 'pl-show'
  el.dataset.fit = o.fit
  const offline = document.createElement('div')
  offline.className = 'pp-offline'
  el.append(offline)
  let slides = []
  let current = null // { key, node }
  let shownAt = 0
  let loading = ''

  function show(slide) {
    if (loading === slide.key) return
    loading = slide.key
    const img = new Image()
    img.alt = ''
    img.decoding = 'async'
    const done = () => {
      if (loading !== slide.key) return
      loading = ''
      const node = document.createElement('div')
      node.className = 'pl-show-slide'
      node.append(img)
      el.append(node)
      const old = current?.node
      requestAnimationFrame(() => node.classList.add('on'))
      if (old) setTimeout(() => old.remove(), 1100)
      current = { key: slide.key, node }
      shownAt = Date.now()
    }
    img.onload = done
    // Bild fehlt (Folie gelöscht, ProPresenter kurz weg): trotzdem weiter, sonst hängt die Schau
    img.onerror = () => {
      if (loading !== slide.key) return
      loading = ''
      current = { key: slide.key, node: current?.node }
      shownAt = Date.now()
    }
    img.src = thumbUrl(slide, 1920)
  }

  function step() {
    if (!slides.length) {
      current?.node?.remove()
      current = null
      return
    }
    const index = slides.findIndex((s) => s.key === current?.key)
    if (index === -1) return show(slides[0])
    if (slides.length === 1 || Date.now() - shownAt < o.seconds * 1000) return
    show(slides[(index + 1) % slides.length])
  }

  const view = {
    el,
    update(state) {
      const pl = state?.connected ? shownPlaylist(state, o) : null
      slides = playlistShowSlides(pl)
      offline.hidden = slides.length > 0
      offline.textContent = !state?.connected
        ? state?.host ? 'ProPresenter nicht erreichbar' : 'ProPresenter nicht eingerichtet'
        : !pl ? (o.source ? 'Playlist wird geladen …' : 'Keine Playlist aktiv') : 'Keine Folien in der Playlist'
      step()
    },
    tick: step,
  }
  showViews.add(view)
  return view
}

const showViews = new Set()
setInterval(() => {
  for (const view of showViews) {
    if (!view.el.isConnected) showViews.delete(view)
    else view.tick()
  }
}, 1000)

export function createPlaylistView(options) {
  const o = playlistOptions(options)
  if (o.view === 'show') return createPlaylistShow(o)
  const el = document.createElement('div')
  el.className = `pl-view${o.thumbs ? ' with-thumbs' : ''}${o.view === 'slides' ? ' pl-slides-view' : ''}`
  el.style.setProperty('--pl-size', String(o.size))
  el.innerHTML = `<div class="pl-title"></div><div class="pl-list"></div><div class="pp-offline" hidden></div>`
  const title = el.querySelector('.pl-title')
  const list = el.querySelector('.pl-list')
  const offline = el.querySelector('.pp-offline')
  let itemsKey = ''
  let rows = []
  let lastActive = null
  let lastTop = null

  let lastLive = ''
  // Laufendes Lied (bzw. in „Alle Folien“ die laufende Folie) mittig halten; am Anfang und Ende so weit es geht
  function centerCurrent(smooth) {
    const block = rows.find((r) => r.item.index === lastActive)?.row
    const current = (block && block.offsetHeight > list.clientHeight * 0.8 && block.querySelector('.pl-slide.live')) || block
    if (!current || !list.clientHeight) return
    const max = Math.max(0, list.scrollHeight - list.clientHeight)
    const top = Math.round(Math.min(max, Math.max(0, current.offsetTop + current.offsetHeight / 2 - list.clientHeight / 2)))
    if (top === lastTop) return
    lastTop = top
    list.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
  }
  // Nach Größenänderung der Kachel neu ausrichten (alte Browser ohne ResizeObserver: beim nächsten Update)
  if (typeof ResizeObserver === 'function') new ResizeObserver(() => centerCurrent(false)).observe(list)

  return {
    el,
    update(state) {
      const pl = state?.connected ? shownPlaylist(state, o) : null
      offline.hidden = Boolean(pl)
      list.hidden = !pl
      offline.textContent = !state?.connected
        ? state?.host ? 'ProPresenter nicht erreichbar' : 'ProPresenter nicht eingerichtet'
        : o.source
          ? state.playlists?.[o.source]?.missing ? `Playlist „${o.sourceName || '?'}“ nicht gefunden` : 'Playlist wird geladen …'
          : 'Keine Playlist aktiv'
      if (!pl) return
      title.textContent = pl.name
      const slides = o.view === 'slides'

      // Liste nur neu aufbauen, wenn sich die Einträge (bzw. ihre Folien) ändern
      const key = JSON.stringify([
        pl.items.map((it) => [it.index, it.name, it.type, it.hidden, it.color, it.bg?.cue, it.bg?.presentation]),
        slides ? pl.items.map((it) => (it.presentation ? (pl.songs[it.presentation] || []).map((c) => [c.group, c.color, c.enabled]) : null)) : null,
      ])
      if (key !== itemsKey) {
        itemsKey = key
        list.replaceChildren()
        rows = pl.items.map((it) => {
          const row = document.createElement('div')
          row.className = `pl-row pl-${it.type}${it.hidden ? ' pl-hidden' : ''}`
          if (it.type === 'header') {
            row.textContent = it.name.replace(/[▼▲]/g, '').trim()
            if (it.color) row.style.setProperty('--pl-color', it.color)
          } else if (slides) {
            // Alle Folien des Lieds als Bilder, mit der Farbe ihrer Gruppe (Strophe, Refrain …)
            row.classList.add('pl-song')
            const name = document.createElement('div')
            name.className = 'pl-name'
            name.textContent = it.name
            const grid = document.createElement('div')
            grid.className = 'pl-slides'
            ;(pl.songs[it.presentation] || []).forEach((cue, i) => {
              const slide = document.createElement('span')
              slide.className = `pl-slide${cue.enabled ? '' : ' off'}`
              slide.dataset.cue = String(i)
              if (cue.color) slide.style.setProperty('--pl-color', cue.color)
              slide.title = cue.group
              const img = document.createElement('img')
              img.alt = ''
              img.loading = 'lazy'
              img.src = thumbUrl({ presentation: it.presentation, cue: i }, 240)
              slide.append(img)
              grid.append(slide)
            })
            if (!grid.childElementCount) grid.textContent = it.presentation ? 'Folien werden geladen …' : ''
            row.append(name, grid)
          } else {
            row.innerHTML = `<span class="pl-thumb"></span><span class="pl-name"></span><span class="pl-bg"></span>`
            row.querySelector('.pl-name').textContent = it.name
            row.querySelector('.pl-bg').textContent = it.bg?.label ?? ''
            if (o.thumbs && it.bg) {
              const img = document.createElement('img')
              img.alt = ''
              img.loading = 'lazy'
              img.src = thumbUrl(it.bg, 240)
              row.querySelector('.pl-thumb').append(img)
            }
          }
          list.append(row)
          return { row, item: it }
        })
        lastActive = null
        lastTop = null
      }

      for (const { row, item } of rows) {
        row.classList.toggle('done', pl.activeIndex != null && item.index < pl.activeIndex && item.type !== 'header')
        row.classList.toggle('current', item.index === pl.activeIndex)
        row.classList.toggle('next', item.index === pl.nextIndex)
        row.classList.toggle('selected', item.index === pl.focusedIndex)
        // Laufende Folie im Lied markieren
        if (slides && item.presentation) {
          const liveCue = item.index === pl.activeIndex && state.presentation?.uuid === item.presentation ? state.index : null
          for (const slide of row.querySelectorAll('.pl-slide')) slide.classList.toggle('live', Number(slide.dataset.cue) === liveCue)
        }
      }
      const live = slides ? `${state.presentation?.uuid ?? ''}:${state.index ?? ''}` : ''
      const changed = pl.activeIndex !== lastActive || live !== lastLive
      lastActive = pl.activeIndex
      lastLive = live
      // Noch nicht ausgelegt (Kachel gerade erst eingefügt): im nächsten Frame
      if (list.clientHeight) centerCurrent(changed)
      else requestAnimationFrame(() => centerCurrent(false))
    },
  }
}

// ---------------------------------------------------------------------------
// Steuerung: Weiter, Zurück, Ausblenden – und die Prediger-Ansicht
// ---------------------------------------------------------------------------

export const PREACHER_DEFAULTS = { size: 1, blankMode: 'clearAll', showControls: true }

export function preacherOptions(options) {
  const o = { ...PREACHER_DEFAULTS, ...options }
  if (!['clear', 'clearAll'].includes(o.blankMode)) o.blankMode = 'clearAll'
  return o
}

/** Schickt einen Steuerbefehl an ProPresenter (über den Multiview-Server). */
async function sendControl(action, extra = {}) {
  const res = await fetch('/api/propresenter/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
}

/** Ausgeblendet = keine Folie auf der Ausgabe, obwohl eine Präsentation läuft. */
const isBlanked = (state) => Boolean((state?.presentation || state?.held) && state.layers && !state.layers.slide)

/**
 * Steuer-Leiste mit drei Tasten. interactive = false (Editor): nur Vorschau, löst nichts aus.
 * blankMode: 'clear' = nur Folie ausblenden, 'clearAll' = Folie und Hintergrund.
 */
export function createControls({ interactive = false, blankMode = 'clearAll' } = {}) {
  const el = document.createElement('div')
  el.className = `pp-controls${interactive ? ' interactive' : ''}`
  el.innerHTML = `
    <button type="button" class="pp-btn pp-prev" data-action="previous">◀ Zurück</button>
    <button type="button" class="pp-btn pp-blank" data-action="blank">Ausblenden</button>
    <button type="button" class="pp-btn pp-next-btn" data-action="next">Weiter ▶</button>
    <div class="pp-error" hidden></div>`
  const blank = el.querySelector('.pp-blank')
  const error = el.querySelector('.pp-error')
  let state = null
  let busy = false

  const run = async (action, extra) => {
    if (!interactive || busy) return
    busy = true
    el.classList.add('busy')
    error.hidden = true
    try {
      await sendControl(action, extra)
    } catch (err) {
      error.textContent = err.message
      error.hidden = false
      setTimeout(() => (error.hidden = true), 4000)
    } finally {
      // kurze Sperre gegen Doppel-Tippen
      setTimeout(() => {
        busy = false
        el.classList.remove('busy')
      }, 250)
    }
  }

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.pp-btn')
    if (!btn) return
    const action = btn.dataset.action
    // Ausblenden schaltet nicht um: es macht ProPresenter immer blank. Zurück geht es mit Weiter/Zurück
    // oder durch Antippen einer Folie.
    if (action === 'blank') run(blankMode === 'clear' ? 'clear' : 'clearAll')
    else run(action)
  })

  return {
    el,
    run,
    /** Wie ein Tastendruck: 'next', 'previous' oder 'blank' (Ausblenden). */
    press(action) {
      if (action === 'blank') run(blankMode === 'clear' ? 'clear' : 'clearAll')
      else run(action)
    },
    update(next) {
      state = next
      const blanked = isBlanked(state)
      blank.classList.toggle('active', blanked)
      el.classList.toggle('disabled', !state?.connected)
    },
  }
}

/** Hintergrund, der bei Folie i wirkt (wie auf dem Server: letzte Folie davor mit Hintergrund-Namen). */
function backgroundFor(cues, i) {
  let start = -1
  for (let c = 0; c <= i && c < cues.length; c++) if (cues[c].label) start = c
  if (start < 0 || start === i) return null
  const label = cues[start].label
  const clean = cues.findIndex((c) => c.label === label && c.blank)
  return clean >= 0 ? clean : start
}

/**
 * Prediger-Ansicht: alle Folien der laufenden Präsentation (Predigt oder Lied) nebeneinander,
 * wie in ProPresenter. Antippen löst die Folie aus; darunter Zurück / Ausblenden / Weiter.
 */
export function createPreacherView(options, { interactive = false } = {}) {
  const o = preacherOptions(options)
  const el = document.createElement('div')
  el.className = `pr-view${interactive ? ' interactive' : ''}`
  el.style.setProperty('--pr-size', String(o.size))
  el.innerHTML = `
    <div class="pr-head"><span class="pr-title"></span><span class="pr-pos"></span><span class="pr-blanked" hidden>AUSGEBLENDET</span></div>
    <div class="pr-grid"></div>
    <div class="pp-offline" hidden></div>`
  const title = el.querySelector('.pr-title')
  const pos = el.querySelector('.pr-pos')
  const blankedBadge = el.querySelector('.pr-blanked')
  const grid = el.querySelector('.pr-grid')
  const offline = el.querySelector('.pp-offline')
  // Die Steuerung gibt es immer (auch für Tastatur/Clicker), die Tasten nur wenn gewünscht
  const controls = createControls({ interactive, blankMode: o.blankMode })
  if (o.showControls) el.append(controls.el)

  let gridKey = ''
  let cards = []
  let lastIndex = null
  let presentation = null

  grid.addEventListener('click', (e) => {
    const card = e.target.closest('.pr-card')
    if (!card || !interactive || !presentation) return
    controls.run('goto', { presentation, index: Number(card.dataset.index) })
  })

  return {
    el,
    press: (action) => controls.press(action),
    update(live) {
      controls.update(live)
      // Ausgeblendet: Folien der zuletzt laufenden Präsentation weiter zeigen
      const state = live?.connected && !live.presentation && live.held ? { ...live, ...live.held } : live
      const p = state?.connected ? state.presentation : null
      offline.hidden = Boolean(p)
      grid.hidden = !p
      offline.textContent = !state?.connected
        ? state?.host ? 'ProPresenter nicht erreichbar' : 'ProPresenter nicht eingerichtet'
        : 'Keine Präsentation aktiv'
      blankedBadge.hidden = !isBlanked(state)
      if (!p) {
        title.textContent = ''
        pos.textContent = ''
        return
      }
      presentation = p.uuid
      title.textContent = p.name
      const cues = state.cues ?? []
      pos.textContent = state.index != null ? `Folie ${state.index + 1} von ${cues.length}` : ''

      // Folienkarten nur neu aufbauen, wenn sich die Präsentation ändert
      const key = JSON.stringify([p.uuid, cues])
      if (key !== gridKey) {
        gridKey = key
        grid.replaceChildren()
        let lastGroup = null
        cards = cues.map((cue, i) => {
          // kein <button>: darin rechnet Chrome die Höhe im Raster falsch (Bild wird abgeschnitten)
          const card = document.createElement('div')
          card.setAttribute('role', 'button')
          card.className = `pr-card${cue.enabled === false ? ' disabled' : ''}`
          card.dataset.index = String(i)
          if (cue.color) card.style.setProperty('--pr-color', cue.color)
          const bg = backgroundFor(cues, i)
          card.innerHTML = `
            <span class="pr-thumb">
              ${bg != null ? `<img class="pr-bg" alt="" loading="lazy" src="${thumbUrl({ presentation: p.uuid, cue: bg }, 480)}">` : ''}
              <img class="pr-img" alt="" loading="lazy" hidden>
            </span>
            <span class="pr-label"><span class="pr-num">${i + 1}</span><span class="pr-group"></span></span>`
          // Gruppenname nur bei der ersten Folie einer Gruppe (wie in ProPresenter)
          card.querySelector('.pr-group').textContent = cue.group !== lastGroup ? cue.group : cue.label
          lastGroup = cue.group
          const setImg = swapImage(card.querySelector('.pr-img'), { key: true })
          setImg(thumbUrl({ presentation: p.uuid, cue: i }, 480, 'png'))
          grid.append(card)
          return card
        })
        lastIndex = null
      }
      cards.forEach((card, i) => {
        card.classList.toggle('current', i === state.index)
        card.classList.toggle('next', i === (state.index ?? -2) + 1)
      })
      if (state.index !== lastIndex) {
        lastIndex = state.index
        const current = cards[state.index]
        if (current) grid.scrollTo({ top: Math.max(0, current.offsetTop - grid.clientHeight / 3), behavior: 'smooth' })
      }
    },
  }
}
