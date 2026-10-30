// Admin-Seite nur für den Admin zeigen. Wer angemeldet ist, sagt die zentrale Anmeldung im
// Multiview (/.jms-auth/api/me, Caddy leitet das auf jeder Adresse dorthin). Das räumt nur das
// Dashboard auf – Companion, Portainer und Glances prüft Caddy ohnehin selbst.
// Sicher im Zweifel: Die Admin-Seite ist erst einmal verborgen und erscheint nur, wenn die Anmeldung
// ausdrücklich einen Admin meldet (oder die Anmeldung ganz ausgeschaltet ist). Antwortet der Multiview
// gerade nicht (z. B. beim Neustart), wird es alle 3 s erneut versucht – bis dahin bleibt sie zu.
;(async () => {
  const style = document.createElement('style')
  style.textContent = '#myTab { display: none !important; } [id="Admin"] { display: none !important; }'
  document.head.append(style)
  // Wer mit …#admin kommt, landet auf der Startseite
  if (location.hash.toLowerCase() === '#admin') {
    ;(async () => {
      for (let i = 0; i < 50; i++) {
        const start = document.getElementById('Start-tab')
        if (start) return start.click()
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    })()
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const res = await fetch('/.jms-auth/api/me', { credentials: 'same-origin', cache: 'no-store' })
      if (res.ok) {
        const me = await res.json()
        if (!me?.access?.enabled || me.user?.admin === true) style.remove()
        return
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 3000))
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

  // Kopf wie bei macOS: „Guten Tag, Name“ mit Datum und Uhrzeit; Suche auf Deutsch
  const head = document.createElement('header')
  head.className = 'jms-head'
  head.innerHTML = '<h1></h1><p></p>'
  const firstName = me && me.user && !me.user.open ? String(me.user.name || '').trim().split(/\s+/)[0] : ''
  const tick = () => {
    const now = new Date()
    const h = now.getHours()
    const greet = h < 5 ? 'Gute Nacht' : h < 11 ? 'Guten Morgen' : h < 18 ? 'Guten Tag' : 'Guten Abend'
    head.querySelector('h1').textContent = firstName ? `${greet}, ${firstName}` : greet
    head.querySelector('p').textContent =
      now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' }) +
      ' · ' +
      now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })
  }
  tick()
  setInterval(tick, 15000)
  const placeHead = () => {
    const top = document.getElementById('information-widgets') || document.getElementById('layout-groups')
    if (top && head.nextElementSibling !== top) top.before(head)
  }
  new MutationObserver(placeHead).observe(document.body, { childList: true, subtree: true })
  placeHead()

  // Die Start-Dienste bleiben in einer verständlichen Reihenfolge. Prediger sehen
  // ihre eigene Seite zuerst; für alle anderen bleiben Raspberry und JMS Control
  // am unteren Ende der Liste.
  const isPreacher = Boolean(me?.user && !me.user.open && (
    /(prediger|preacher)/i.test(String(me.user.roleId || '').trim()) ||
    /(prediger|preacher)/i.test(String(me.user.roleName || '').trim())
  ))
  const arrangeStartServices = () => {
    const tab = document.getElementById('Start-tab')
    if (tab && tab.getAttribute('aria-selected') === 'false') return
    const group = [...document.querySelectorAll('.services-group')].find((item) =>
      /^(Dienste|Services)$/i.test((item.querySelector('.service-group-name') || {}).textContent?.trim() || '')
    )
    const list = group?.querySelector('.services-list')
    if (!list) return
    const items = [...list.children]
    const byName = new Map(items.map((item) => [item.querySelector('.service-name')?.textContent?.trim(), item]))
    const names = isPreacher
      ? ['Prediger', 'Intercom', 'Intercom-Chat', 'Nachricht auf Bühne', 'Nachricht auf Stage Display', 'Raspberry fernsteuern', 'JMS Control']
      : ['Intercom', 'Intercom-Chat', 'Nachricht auf Bühne', 'Nachricht auf Stage Display', 'Prediger', 'Raspberry fernsteuern', 'JMS Control']
    const ordered = names.map((name) => byName.get(name)).filter(Boolean)
    ordered.push(...items.filter((item) => !ordered.includes(item)))
    if (ordered.some((item, index) => list.children[index] !== item)) ordered.forEach((item) => list.append(item))
  }
  const serviceObserver = new MutationObserver(arrangeStartServices)
  serviceObserver.observe(document.body, { childList: true, subtree: true })
  arrangeStartServices()

  // Konto-Leiste unten links wie in allen anderen Diensten (JMS Control, Intercom, Companion …):
  // wer angemeldet ist, Konto wechseln, Abmelden – kommt aus dem Multiview (/.jms-auth/jms-bar.js)
  if (me && me.user && !me.user.open) {
    const s = document.createElement('script')
    s.src = '/.jms-auth/jms-bar.js'
    s.defer = true
    document.head.append(s)
  }

  // Admin-Seite: Verbindung jeder Raspberry-Station live aus Kesher (online, WLAN-IP, Kesher-Rolle) – direkt über
  // dem Abschnitt „Raspberry Pis“ mit den Glances-Messwerten
  if (me && me.user && me.user.admin) {
    const section = document.createElement('div')
    section.className = 'jms-pis'
    section.innerHTML = '<h2 class="jms-pis-title">Raspberry Pis – Verbindung</h2><div class="jms-pis-grid"></div>'
    const grid = section.querySelector('.jms-pis-grid')
    const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
    const meter = (label, value, unit, warn, bad) => {
      if (value == null) return ''
      const v = Math.round(value)
      const cls = v >= bad ? 'bad' : v >= warn ? 'warn' : ''
      const width = unit === '°C' ? Math.min(100, v) : Math.min(100, Math.max(0, v))
      return `<div class="jms-meter ${cls}"><span>${label}</span><i><b style="width:${width}%"></b></i><em>${v}${unit}</em></div>`
    }
    const ago = (s) => (s < 60 ? `vor ${s} s` : s < 3600 ? `vor ${Math.round(s / 60)} min` : `vor ${Math.round(s / 3600)} h`)
    const render = (data) => {
      piStations = data && data.ok ? data.stations : null
      markPiErrors()
      if (!data || !data.ok) {
        grid.innerHTML = `<p class="jms-pis-empty">${esc((data && data.error) || 'Keine Verbindung zu Kesher')}</p>`
        return
      }
      if (!data.stations.length) {
        grid.innerHTML = '<p class="jms-pis-empty">Noch kein Raspberry Pi hat sich gemeldet.</p>'
        return
      }
      grid.innerHTML = data.stations
        .map((p) => {
          const state = !p.online ? ['off', 'Offline'] : p.intercomConnected ? ['ok', 'Online · Intercom verbunden'] : ['warn', 'Online · Intercom nicht verbunden']
          const kesher = p.intercomConnected
            ? `<b>${esc(p.intercomUsername || '–')}</b> als <b>${esc(p.intercomRoleName || p.intercomRoleId || '–')}</b>`
            : '<span class="jms-muted">nicht in Kesher angemeldet</span>'
          return `<div class="jms-pi ${state[0]}">
            <div class="jms-pi-head"><span class="jms-pi-icon"></span><div><b>${esc(p.name || p.deviceId)}</b><small>${esc(p.deviceId)}</small></div><span class="jms-pill ${state[0]}">${state[1]}</span></div>
            <dl>
              <dt>IP-Adresse</dt><dd>${p.ipAddress ? `<code>${esc(p.ipAddress)}</code>` : '–'}</dd>
              <dt>Kesher</dt><dd>${kesher}</dd>
              <dt>Station für</dt><dd>${esc(p.roleName || '–')}</dd>
              <dt>Browser</dt><dd>${esc(p.browserStatus || '–')}${p.loginStatus ? ` · Anmeldung: ${esc(p.loginStatus)}` : ''}</dd>
              ${p.loginError ? `<dt>Fehler</dt><dd class="jms-err">${esc(p.loginError)}</dd>` : ''}
            </dl>
            <div class="jms-pi-foot">Launcher ${esc(p.launcherVersion || '?')}${p.lowPowerMode ? ' · Stromsparmodus' : ''} · zuletzt gemeldet ${ago(p.secondsSinceSeen || 0)}</div>
          </div>`
        })
        .join('')
    }
    // Glances-Messwerte der Pis: Ist ein Pi aus (Ruhemodus mit Strom weg, kein WLAN), kann Glances nicht
    // antworten und Homepage zeigt „API Error“. Stattdessen sagen, warum: Pi aus – oder nur Glances weg.
    let piStations = null
    const markPiErrors = () => {
      const piGroup = [...document.querySelectorAll('.services-group')].find((g) => /raspberry/i.test((g.querySelector('.service-group-name') || {}).textContent || ''))
      if (!piGroup) return
      for (const sub of piGroup.querySelectorAll('.services-group')) {
        const name = ((sub.querySelector('.service-group-name') || {}).textContent || '').trim()
        const station = (piStations || []).find((p) => [p.name, p.deviceId].some((v) => v && String(v).trim().toLowerCase() === name.toLowerCase()))
        const text = !station ? 'Nicht erreichbar' : station.online ? 'Glances antwortet nicht' : 'Pi ist aus oder nicht im WLAN'
        for (const el of sub.querySelectorAll('div, span')) {
          if (el.children.length || !/^(API Error|API-Fehler)/i.test(el.textContent.trim())) continue
          if (el.textContent !== text) el.textContent = text
          const box = el.closest('button, .service-block, div[class*="rose"], div[class*="error"]') || el.parentElement
          if (box) box.title = station && !station.online ? 'Kesher meldet den Pi als offline – Glances-Werte gibt es erst, wenn er wieder an ist.' : 'Glances auf dem Pi (Port 61208) antwortet nicht.'
        }
      }
    }
    new MutationObserver(markPiErrors).observe(document.body, { childList: true, subtree: true, characterData: true })

    let loading = false
    const load = async () => {
      if (loading || document.visibilityState === 'hidden' || !section.isConnected) return
      loading = true
      try {
        const res = await fetch('/.jms-auth/api/raspberry-pis/live', { credentials: 'same-origin', cache: 'no-store' })
        render(await res.json())
      } catch {
        render(null)
      } finally {
        loading = false
      }
    }
    const placePis = () => {
      const groups = document.getElementById('layout-groups')
      const tab = document.getElementById('Admin-tab')
      const onAdmin = tab && tab.getAttribute('aria-selected') === 'true'
      if (groups && onAdmin) {
        // vor der Gruppe „Raspberry Pis“ mit den Messwerten, sonst ans Ende
        const piGroup = [...groups.querySelectorAll('.services-group')].find((g) => /raspberry/i.test((g.querySelector('.service-group-name') || {}).textContent || ''))
        const misplaced = section.parentElement !== groups || (piGroup ? section.nextElementSibling !== piGroup : groups.lastElementChild !== section)
        if (misplaced) groups.insertBefore(section, piGroup || null)
        if (!section.dataset.loaded) {
          section.dataset.loaded = '1'
          load()
        }
      } else if ((!onAdmin || !groups) && section.parentElement) section.remove()
    }
    new MutationObserver(placePis).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] })
    placePis()
    setInterval(load, 5000)
    if (!document.getElementById('jms-pis-style')) {
      const style = document.createElement('style')
      style.id = 'jms-pis-style'
      style.textContent = `
.jms-pis { flex-basis: 100%; padding: 4px; margin-top: 8px; }
.jms-pis-title { font-size: 1.45rem; font-weight: 700; letter-spacing: -0.02em; color: #fff; margin: 4px 0 10px; text-shadow: 0 1px 14px rgba(0,0,0,.55); }
.jms-pis-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
.jms-pis-empty { color: rgba(235,235,245,.7); margin: 0; padding: 16px; border-radius: 18px; background: var(--jms-glass, rgba(36,36,38,.55)); }
.jms-pi { padding: 16px; border-radius: 20px; color: #fff; background: var(--jms-glass, rgba(36,36,38,.55)); border: 1px solid var(--jms-line, rgba(255,255,255,.09));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.14), 0 10px 30px rgba(0,0,0,.25); -webkit-backdrop-filter: blur(28px) saturate(160%); backdrop-filter: blur(28px) saturate(160%); }
.jms-pi.off { opacity: .75; }
.jms-pi-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.jms-pi-head > div { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
.jms-pi-head b { font-size: 16px; }
.jms-pi-head small { font-size: 12px; color: rgba(235,235,245,.55); }
.jms-pi-icon { width: 40px; height: 40px; border-radius: 10px; flex: none; background: linear-gradient(180deg,#ff5f7a,#c51a4a);
  box-shadow: inset 0 1px .5px rgba(255,255,255,.5), 0 6px 14px -4px rgba(197,26,74,.6); position: relative; }
.jms-pi-icon::after { content: ""; position: absolute; inset: 9px; border-radius: 4px; border: 2.5px solid #fff; }
.jms-pill { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 999px; white-space: nowrap; }
.jms-pill.ok { background: rgba(48,209,88,.2); color: #63e38a; }
.jms-pill.warn { background: rgba(255,159,10,.2); color: #ffbe55; }
.jms-pill.off { background: rgba(255,69,58,.2); color: #ff8a80; }
.jms-pi dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0 0 12px; font-size: 13.5px; }
.jms-pi dt { color: rgba(235,235,245,.55); }
.jms-pi dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.jms-pi code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; padding: 1px 6px; border-radius: 6px; background: rgba(255,255,255,.1); }
.jms-muted { color: rgba(235,235,245,.55); }
.jms-err { color: #ff8a80; }
.jms-meters { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 14px; }
.jms-meter { display: grid; grid-template-columns: 44px 1fr 46px; align-items: center; gap: 8px; font-size: 12.5px; }
.jms-meter span { color: rgba(235,235,245,.6); }
.jms-meter i { height: 6px; border-radius: 99px; background: rgba(255,255,255,.12); overflow: hidden; }
.jms-meter b { display: block; height: 100%; border-radius: inherit; background: #30d158; }
.jms-meter.warn b { background: #ff9f0a; }
.jms-meter.bad b { background: #ff453a; }
.jms-meter em { font-style: normal; text-align: right; font-variant-numeric: tabular-nums; }
.jms-pi-foot { margin-top: 12px; font-size: 12px; color: rgba(235,235,245,.5); }
@media (max-width: 520px) { .jms-meters { grid-template-columns: 1fr; } }
`
      document.head.append(style)
    }
  }

  // Die komplette Servicekarte ist anklickbar. Die bestehenden Links und Status-Buttons
  // bleiben zuständig für ihre eigenen Aktionen; freie Kartenflächen öffnen den ersten Service-Link.
  if (!document.documentElement.dataset.jmsCardLinks) {
    document.documentElement.dataset.jmsCardLinks = '1'
    const activateCard = (card) => {
      const link = card?.querySelector('a[href]')
      if (link) link.click()
    }
    document.addEventListener('click', (event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const card = target.closest('.service-card')
      if (!card) return
      // Icon/Text-Links sowie Container-Status und andere Bedienelemente behalten ihr Verhalten.
      if (target.closest('a, button, input, select, textarea, [role="button"]')) return
      activateCard(card)
    })
    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const target = event.target
      if (!(target instanceof Element)) return
      const card = target.closest('.service-card')
      if (!card || target.closest('a, button, input, select, textarea, [role="button"]')) return
      event.preventDefault()
      activateCard(card)
    })
  }

  // An- oder abgemeldet in einem anderen Dienst/Tab (gemeinsames Cookie): beim Zurückwechseln
  // und alle 15 s prüfen und dann neu laden – ohne dass man selbst neu laden muss
  if (!me || !me.access || !me.access.enabled) return
  const keyOf = (u) => (u && !u.open ? `${u.name}|${u.roleId}|${Boolean(u.admin)}|${u.sessionId}|${u.version}|${u.expiresAt}` : '')
  const current = keyOf(me.user)
  let busy = false
  const check = async () => {
    if (busy) return
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
  window.addEventListener('pageshow', check)
  setInterval(check, 5000)
})()

// Veranstaltungsbetrieb: gleiche Daten und Anmeldung wie JMS Control.
;(() => {
  const css=document.createElement('link');css.rel='stylesheet';css.href='/.jms-auth/event-ops.css?v=20261030-agenda-manual';document.head.append(css)
  const script=document.createElement('script');script.src='/.jms-auth/event-ops.js?v=20261030-agenda-manual';script.defer=true;document.head.append(script)
})()
