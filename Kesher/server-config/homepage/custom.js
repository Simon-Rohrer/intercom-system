// Admin-Seite nur für den Admin zeigen. Wer angemeldet ist, sagt die zentrale Anmeldung im
// Multiview (/.jms-auth/api/me, Caddy leitet das auf jeder Adresse dorthin). Das räumt nur das
// Dashboard auf – Companion, Portainer und Glances prüft Caddy ohnehin selbst.
// Ist die Anmeldung aus oder nicht erreichbar, bleibt die Admin-Seite sichtbar.
;(async () => {
  let admin = true
  try {
    const res = await fetch('/.jms-auth/api/me', { credentials: 'same-origin', cache: 'no-store' })
    const me = res.ok ? await res.json() : null
    if (me?.access?.enabled) admin = Boolean(me.user?.admin)
  } catch {}
  if (admin) return

  // Ohne Admin-Seite bleibt nur „Start“ – dann braucht es die Umschaltleiste nicht
  const style = document.createElement('style')
  style.textContent = '#myTab { display: none !important; }'
  document.head.append(style)
  // Wer mit …#admin kommt, landet auf der Startseite
  if (location.hash.toLowerCase() !== '#admin') return
  for (let i = 0; i < 50; i++) {
    const start = document.getElementById('Start-tab')
    if (start) return start.click()
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})()

// ==== JMS-Design (wie Multiview): Hintergrund des angemeldeten Nutzers, An-/Abmeldung von anderen Diensten übernehmen ====
// Hintergründe und Farben kommen aus dem Multiview (/.jms-auth/theme-boot.js), die Wahl aus
// /.jms-auth/api/me – so sieht das Dashboard aus wie der Multiview des Nutzers.
;(async () => {
  let me = null
  try {
    const res = await fetch('/.jms-auth/api/me', { credentials: 'same-origin', cache: 'no-store' })
    me = res.ok ? await res.json() : null
  } catch {}

  // Hintergrund
  try {
    window.MV_WALLPAPER_BASE = '/.jms-auth'
    await new Promise((resolve, reject) => {
      const s = document.createElement('script')
      s.src = '/.jms-auth/theme-boot.js'
      s.onload = resolve
      s.onerror = reject
      document.head.append(s)
    })
    const wp = window.MV_applyWallpaper((me && me.prefs && me.prefs.wallpaper) || 'graphit', true)
    const root = document.documentElement.style
    root.setProperty('--jms-wallpaper', wp.file ? root.getPropertyValue('--wallpaper') : 'radial-gradient(110% 70% at 80% 0%, rgba(46,122,255,.75), transparent 60%), radial-gradient(80% 60% at 0% 100%, rgba(30,80,220,.6), transparent 65%), linear-gradient(165deg, #07174d, #0d2f8f 48%, #071338)')
    root.setProperty('--jms-glass', wp.glass)
    root.setProperty('--jms-accent', wp.accent)
  } catch {}

  // An- oder abgemeldet in einem anderen Dienst/Tab (gemeinsames Cookie): beim Zurückwechseln
  // und alle 15 s prüfen und dann neu laden – ohne dass man selbst neu laden muss
  if (!me || !me.access || !me.access.enabled) return
  const keyOf = (u) => (u && !u.open ? `${u.name}|${u.roleId}|${Boolean(u.admin)}` : '')
  const current = keyOf(me.user)
  let busy = false
  const check = async () => {
    if (busy || document.visibilityState === 'hidden') return
    busy = true
    try {
      const res = await fetch('/.jms-auth/api/me', { credentials: 'same-origin', cache: 'no-store' })
      const now = res.ok ? await res.json() : null
      if (now && now.access && now.access.enabled && keyOf(now.user) !== current) location.reload()
    } catch {
    } finally {
      busy = false
    }
  }
  document.addEventListener('visibilitychange', check)
  window.addEventListener('focus', check)
  setInterval(check, 15000)
})()
