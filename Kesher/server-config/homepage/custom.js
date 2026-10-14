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
