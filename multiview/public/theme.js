// Darstellung: Hell, Dunkel oder wie das System – plus Hintergrundbild. Gemeinsam für Editor,
// Anmeldung und Handy-Seite. Gespeichert im Browser und (angemeldet) pro Nutzer auf dem Server,
// damit Handy und Rechner gleich aussehen. Jeder Hintergrund bringt seine Akzentfarbe mit
// (Liste in theme-boot.js, das schon vor dem ersten Zeichnen läuft).

export const WALLPAPERS = window.MV_WALLPAPERS || [{ id: 'blau', name: 'Blau', file: null, accent: '#007aff' }]
const DEFAULT_WALLPAPER = WALLPAPERS[0].id
const validWallpaper = (id) => (WALLPAPERS.some((w) => w.id === id) ? id : DEFAULT_WALLPAPER)

export const THEMES = [
  { value: 'light', name: 'Hell' },
  { value: 'dark', name: 'Dunkel' },
  { value: 'system', name: 'System' },
]

function read(key, fallback) {
  try {
    const v = localStorage.getItem(`mv.${key}`)
    return v === null ? fallback : JSON.parse(v)
  } catch {
    return fallback
  }
}

function write(key, value) {
  try {
    localStorage.setItem(`mv.${key}`, JSON.stringify(value))
  } catch {
    // privater Modus o. Ä. – gilt dann nur bis zum Neuladen
  }
}

export function currentPrefs() {
  const theme = read('theme', 'dark')
  return {
    theme: THEMES.some((t) => t.value === theme) ? theme : 'dark',
    wallpaper: validWallpaper(read('wallpaper', DEFAULT_WALLPAPER)),
  }
}

/** Tatsächlich sichtbar: 'light' oder 'dark' (System aufgelöst). */
export function effectiveTheme(theme = currentPrefs().theme) {
  if (theme !== 'system') return theme
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyPrefs({ theme, wallpaper }) {
  const root = document.documentElement
  root.dataset.theme = THEMES.some((t) => t.value === theme) ? theme : 'dark'
  const dark = effectiveTheme(theme) === 'dark'
  const wp = window.MV_applyWallpaper?.(validWallpaper(wallpaper), dark)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? wp?.bg || '#0a1d57' : '#eaf2ff')
  for (const fn of listeners) fn({ theme, wallpaper })
}

const listeners = new Set()
export function onPrefsChange(fn) {
  listeners.add(fn)
}

/** Ändern, speichern und (wenn angemeldet) auf den Server legen. */
export async function setPrefs(partial, { server = true } = {}) {
  const next = { ...currentPrefs(), ...partial }
  write('theme', next.theme)
  write('wallpaper', next.wallpaper)
  applyPrefs(next)
  if (!server) return
  try {
    await fetch('/api/me/prefs', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    })
  } catch {
    // offline: bleibt lokal
  }
}

/** Einstellungen vom Server übernehmen (nach der Anmeldung, z. B. am Handy). */
export function adoptServerPrefs(prefs) {
  if (!prefs) return applyPrefs(currentPrefs())
  write('theme', prefs.theme || 'dark')
  if (prefs.wallpaper) write('wallpaper', validWallpaper(prefs.wallpaper))
  applyPrefs(currentPrefs())
}

/** Hell → Dunkel → System → Hell … */
export function nextTheme(theme = currentPrefs().theme) {
  const i = THEMES.findIndex((t) => t.value === theme)
  return THEMES[(i + 1) % THEMES.length].value
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyPrefs(currentPrefs()))

/** Vorschau eines Hintergrunds (kleines Bild bzw. der blaue Verlauf). */
export function wallpaperThumb(wp, light = effectiveTheme() === 'light') {
  const file = light && wp.light ? wp.light : wp.file
  if (file) return `url('${window.MV_wallpaperBase || ''}/api/wallpaper/${file}-s.jpg')`
  return light ? 'linear-gradient(160deg, #eaf2ff, #cfe0ff 45%, #e6ecff)' : 'linear-gradient(165deg, #07174d, #0d2f8f 50%, #2e7aff)'
}

/** Auswahl Hell/Dunkel/System und Hintergründe als HTML (für Dialoge). */
export function appearanceHtml() {
  const { theme, wallpaper } = currentPrefs()
  return `
    <div class="segmented" role="radiogroup" aria-label="Darstellung">
      ${THEMES.map(
        (t) => `<button type="button" role="radio" data-theme-choice="${t.value}" aria-checked="${t.value === theme}" class="${t.value === theme ? 'active' : ''}">${themeIcon(t.value)}<span>${t.name}</span></button>`,
      ).join('')}
    </div>
    <div class="wallpapers" role="radiogroup" aria-label="Hintergrund">
      ${WALLPAPERS.map(
        (w) => `<button type="button" role="radio" class="wp-choice${w.id === wallpaper ? ' active' : ''}" data-wp-choice="${w.id}" aria-checked="${w.id === wallpaper}">
          <span class="wp-thumb" style="background-image:${wallpaperThumb(w)}"><i style="background:${w.accent}"></i></span>
          <span class="wp-name">${w.name}</span>
        </button>`,
      ).join('')}
    </div>`
}

/** Klicks in einem Bereich mit appearanceHtml() behandeln. */
export function bindAppearance(container, rerender) {
  container.addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme-choice]')
    const w = e.target.closest("[data-wp-choice]")
    if (t) setPrefs({ theme: t.dataset.themeChoice })
    else if (w) setPrefs({ wallpaper: w.dataset.wpChoice })
    else return
    rerender?.()
  })
}

export function themeIcon(theme) {
  if (theme === 'light')
    return '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
  if (theme === 'dark') return '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>'
  return '<svg viewBox="0 0 24 24" class="icon" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>'
}
