// Darstellung: Hell, Dunkel oder wie das System – plus Akzentfarbe. Gemeinsam für Editor,
// Anmeldung und Handy-Seite. Gespeichert im Browser und (angemeldet) pro Nutzer auf dem Server,
// damit Handy und Rechner gleich aussehen.

export const ACCENTS = [
  { name: 'Blau', value: '#2563eb' },
  { name: 'Indigo', value: '#4f46e5' },
  { name: 'Violett', value: '#7c3aed' },
  { name: 'Pink', value: '#db2777' },
  { name: 'Rot', value: '#dc2626' },
  { name: 'Orange', value: '#ea580c' },
  { name: 'Bernstein', value: '#b45309' },
  { name: 'Grün', value: '#16a34a' },
  { name: 'Türkis', value: '#0d9488' },
  { name: 'Graphit', value: '#475569' },
]

export const THEMES = [
  { value: 'light', name: 'Hell' },
  { value: 'dark', name: 'Dunkel' },
  { value: 'system', name: 'System' },
]

const DEFAULT_ACCENT = ACCENTS[0].value

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
  const theme = read('theme', 'system')
  return {
    theme: THEMES.some((t) => t.value === theme) ? theme : 'system',
    accent: read('accent', null) || DEFAULT_ACCENT,
  }
}

/** Tatsächlich sichtbar: 'light' oder 'dark' (System aufgelöst). */
export function effectiveTheme(theme = currentPrefs().theme) {
  if (theme !== 'system') return theme
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyPrefs({ theme, accent }) {
  const root = document.documentElement
  root.dataset.theme = THEMES.some((t) => t.value === theme) ? theme : 'system'
  root.style.setProperty('--accent', accent || DEFAULT_ACCENT)
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', effectiveTheme(theme) === 'dark' ? '#0b0d10' : '#f6f7f9')
  for (const fn of listeners) fn({ theme, accent })
}

const listeners = new Set()
export function onPrefsChange(fn) {
  listeners.add(fn)
}

/** Ändern, speichern und (wenn angemeldet) auf den Server legen. */
export async function setPrefs(partial, { server = true } = {}) {
  const next = { ...currentPrefs(), ...partial }
  write('theme', next.theme)
  write('accent', next.accent)
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
  write('theme', prefs.theme || 'system')
  if (prefs.accent) write('accent', prefs.accent)
  applyPrefs(currentPrefs())
}

/** Hell → Dunkel → System → Hell … */
export function nextTheme(theme = currentPrefs().theme) {
  const i = THEMES.findIndex((t) => t.value === theme)
  return THEMES[(i + 1) % THEMES.length].value
}

matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyPrefs(currentPrefs()))

/** Auswahl Hell/Dunkel/System und Akzentfarben als HTML (für Dialoge). */
export function appearanceHtml() {
  const { theme, accent } = currentPrefs()
  return `
    <div class="segmented" role="radiogroup" aria-label="Darstellung">
      ${THEMES.map(
        (t) => `<button type="button" role="radio" data-theme-choice="${t.value}" aria-checked="${t.value === theme}" class="${t.value === theme ? 'active' : ''}">${themeIcon(t.value)}<span>${t.name}</span></button>`,
      ).join('')}
    </div>
    <div class="swatches" role="radiogroup" aria-label="Akzentfarbe">
      ${ACCENTS.map(
        (a) => `<button type="button" role="radio" class="swatch${a.value === accent ? ' active' : ''}" data-accent="${a.value}" aria-checked="${a.value === accent}" title="${a.name}" style="--swatch:${a.value}"><span class="sr-only">${a.name}</span></button>`,
      ).join('')}
    </div>`
}

/** Klicks in einem Bereich mit appearanceHtml() behandeln. */
export function bindAppearance(container, rerender) {
  container.addEventListener('click', (e) => {
    const t = e.target.closest('[data-theme-choice]')
    const a = e.target.closest('[data-accent]')
    if (t) setPrefs({ theme: t.dataset.themeChoice })
    else if (a) setPrefs({ accent: a.dataset.accent })
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
