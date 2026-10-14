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

  // Konto-Leiste ganz oben: wer angemeldet ist, Konto wechseln, Abmelden
  if (me && me.user && !me.user.open) {
    const u = me.user
    const bar = document.createElement('div')
    bar.className = 'jms-account'
    const initials = String(u.name || '?').trim().split(/\s+/).slice(0, 2).map((w) => (w[0] || '').toUpperCase()).join('') || '?'
    const avatar = document.createElement('span')
    avatar.className = 'jms-avatar'
    if (u.avatar) {
      const img = document.createElement('img')
      img.src = '/.jms-auth' + u.avatar
      img.alt = ''
      avatar.append(img)
    } else {
      avatar.textContent = initials
    }
    const who = document.createElement('span')
    who.className = 'jms-who'
    const name = document.createElement('b')
    name.textContent = u.name
    const role = document.createElement('small')
    role.textContent = u.roleName || u.roleId
    who.append(name, role)
    const actions = document.createElement('span')
    actions.className = 'jms-account-actions'
    actions.innerHTML =
      '<a href="/.jms-auth/login?wechseln=1&next=%2F">Konto wechseln</a>' +
      '<a href="/.jms-auth/logout" class="jms-logout">Abmelden</a>'
    bar.append(avatar, who, actions)
    // Gestaltung direkt mitliefern – custom.css hält der Browser gern länger im Zwischenspeicher
    if (!document.getElementById('jms-account-style')) {
      const style = document.createElement('style')
      style.id = 'jms-account-style'
      style.textContent = '/* Konto-Leiste oben (custom.js): Profilbild, Name, Rolle, Konto wechseln, Abmelden */\n.jms-account {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  margin: 16px 16px 0;\n  padding: 10px 12px 10px 10px;\n  border-radius: 20px;\n  background: var(--jms-glass);\n  border: 1px solid var(--jms-line);\n  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);\n  -webkit-backdrop-filter: blur(28px) saturate(160%);\n  backdrop-filter: blur(28px) saturate(160%);\n  color: #fff;\n}\n@media (min-width: 640px) { .jms-account { margin: 24px 36px 0; } }\n.jms-avatar {\n  width: 44px;\n  height: 44px;\n  flex: none;\n  border-radius: 50%;\n  display: grid;\n  place-items: center;\n  overflow: hidden;\n  font-weight: 700;\n  font-size: 16px;\n  background: linear-gradient(160deg, #8e9bff, #5856d6);\n  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.3);\n}\n.jms-avatar img { width: 100%; height: 100%; object-fit: cover; }\n.jms-who { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.25; }\n.jms-who b { font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.jms-who small { font-size: 13px; color: rgba(235, 235, 245, 0.62); }\n.jms-account-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }\n.jms-account-actions a {\n  padding: 9px 14px;\n  border-radius: 12px;\n  background: rgba(255, 255, 255, 0.12);\n  color: #fff !important;\n  font-weight: 600;\n  font-size: 14px;\n  text-decoration: none;\n  white-space: nowrap;\n}\n.jms-account-actions a:hover { background: rgba(255, 255, 255, 0.2); }\n.jms-account-actions a.jms-logout { background: rgba(255, 69, 58, 0.22); color: #ff8a80 !important; }\n.jms-account-actions a.jms-logout:hover { background: rgba(255, 69, 58, 0.34); }\n@media (max-width: 520px) {\n  .jms-account { flex-wrap: wrap; }\n  .jms-account-actions { width: 100%; }\n  .jms-account-actions a { flex: 1; text-align: center; }\n}\n'
      document.head.append(style)
    }
    // Homepage zeichnet die Seite selbst – die Leiste über der Suche halten
    const placeBar = () => {
      const top = document.getElementById('information-widgets')
      if (top && bar.nextElementSibling !== top) top.before(bar)
    }
    new MutationObserver(placeBar).observe(document.body, { childList: true, subtree: true })
    placeBar()
  }

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
