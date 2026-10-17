// JMS-Leiste für fremde Oberflächen hinter der zentralen Anmeldung (Companion, Portainer, DNS, Router):
// unten links „Dashboard“ (zurück), wer angemeldet ist, „Konto wechseln“ und „Abmelden“ –
// genauso wie die Benutzerkarte unten links in JMS Control, Intercom und Dashboard.
// Der Multiview hängt das Skript in die Seiten ein (siehe /.jms-auth/page/… in server.js).
// Bewusst ohne Module und neue Sprachmittel, damit es in jeder fremden Seite läuft.
;(function () {
  if (window.__jmsBar) return
  window.__jmsBar = true

  // Adresse des Dashboards, passend zu der Art, wie die Seite aufgerufen wurde (wie services.js)
  function dashboardUrl() {
    var h = location.hostname
    if (/\.jms\.de$/.test(h)) return 'https://dashboard.jms.de/'
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return 'https://' + h + ':3000/'
    return 'https://technik.local/'
  }

  // Im Dashboard selbst braucht es keinen Weg zurück zum Dashboard
  var onDashboard = location.port === '3000' || /^(technik|dashboard)\./.test(location.hostname)

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  // Initialen und Farbe genau wie in JMS Control (public/avatar.js)
  function initials(name) {
    var words = String(name || '?').trim().split(/\s+/).slice(0, 2)
    var out = ''
    for (var i = 0; i < words.length; i++) out += (words[i].charAt(0) || '').toUpperCase()
    return out || '?'
  }
  var TINTS = [
    ['#5ac8fa', '#007aff'], ['#ffcc00', '#ff9500'], ['#4cd964', '#34c759'], ['#ff6b9a', '#ff2d55'],
    ['#c69cff', '#af52de'], ['#64d2ff', '#30b0c7'], ['#ff9f6b', '#ff6b22'], ['#8e9bff', '#5856d6'],
  ]
  function tint(name) {
    var h = 0
    var text = String(name || '')
    for (var i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0
    var t = TINTS[h % TINTS.length]
    return 'linear-gradient(160deg, ' + t[0] + ', ' + t[1] + ')'
  }

  var ICON_BACK = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>'
  var ICON_SWITCH = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h12l-3-3M17 17H5l3 3"/></svg>'
  var ICON_LOGOUT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11"/></svg>'

  var css =
    '.jms-bar{position:fixed;left:max(12px,env(safe-area-inset-left));bottom:max(12px,env(safe-area-inset-bottom));z-index:2147483000;' +
    'display:flex;align-items:center;gap:6px;padding:6px;border-radius:16px;font:13px/1.25 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",Roboto,sans-serif;' +
    'color:#f5f5f7;background:rgba(28,28,32,.78);-webkit-backdrop-filter:saturate(1.6) blur(18px);backdrop-filter:saturate(1.6) blur(18px);' +
    'border:1px solid rgba(255,255,255,.14);box-shadow:0 10px 30px rgba(0,0,0,.35);max-width:calc(100vw - 24px)}' +
    '.jms-bar *{box-sizing:border-box}' +
    '.jms-bar a,.jms-bar button{all:unset;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:34px;border-radius:10px;color:inherit}' +
    '.jms-bar a:hover,.jms-bar button:hover{background:rgba(255,255,255,.12)}' +
    '.jms-bar svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}' +
    '.jms-bar .jms-back{padding:0 10px 0 6px;font-weight:600}' +
    '.jms-bar .jms-icon{width:34px}' +
    '.jms-bar form{all:unset;display:inline-flex}' +
    '.jms-bar .jms-user{display:flex;align-items:center;gap:8px;padding:0 6px 0 4px;min-width:0;border-left:1px solid rgba(255,255,255,.14);margin-left:2px;padding-left:10px}' +
    '.jms-bar .jms-avatar{width:30px;height:30px;border-radius:50%;display:grid;place-items:center;flex:none;background:#0a84ff;color:#fff;font-weight:700;font-size:12px;overflow:hidden}' +
    '.jms-bar .jms-avatar img{width:100%;height:100%;object-fit:cover}' +
    '.jms-bar .jms-meta{display:flex;flex-direction:column;min-width:0;max-width:160px}' +
    '.jms-bar .jms-meta b{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px}' +
    '.jms-bar .jms-meta span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11.5px;opacity:.7}' +
    '.jms-bar .jms-min{width:22px;opacity:.6}' +
    '.jms-bar .jms-user:first-child{border-left:0;margin-left:0;padding-left:4px}' +
    '.jms-bar.jms-small .jms-user,.jms-bar.jms-small .jms-switch,.jms-bar.jms-small .jms-back span{display:none}' +
    '.jms-bar.jms-small .jms-back{padding:0;width:34px}' +
    '@media (max-width:600px){.jms-bar .jms-meta{max-width:110px}.jms-bar .jms-back span{display:none}.jms-bar .jms-back{padding:0;width:34px}}'

  function build(me) {
    var user = me && me.user && !me.user.open ? me.user : null
    var bar = document.createElement('div')
    bar.className = 'jms-bar'
    bar.setAttribute('role', 'navigation')
    bar.setAttribute('aria-label', 'JMS')
    var next = encodeURIComponent(location.pathname + location.search)
    bar.innerHTML =
      (onDashboard ? '' : '<a class="jms-back" href="' + esc(dashboardUrl()) + '" title="Zurück zum Dashboard">' + ICON_BACK + '<span>Dashboard</span></a>') +
      (user
        ? '<span class="jms-user"><span class="jms-avatar"' + (user.avatar ? '' : ' style="background:' + tint(user.name) + '"') + '>' +
          (user.avatar ? '<img alt="" src="/.jms-auth' + esc(user.avatar) + '">' : esc(initials(user.name))) +
          '</span><span class="jms-meta"><b>' + esc(user.name) + '</b><span>' + esc(user.roleName || (user.admin ? 'Admin' : '')) + '</span></span></span>' +
          '<a class="jms-icon jms-switch" href="/.jms-auth/login?wechseln=1&amp;next=' + next + '" title="Konto oder Rolle wechseln" aria-label="Konto wechseln">' + ICON_SWITCH + '</a>' +
          // Abmelden nur per POST (ein fremder Link soll niemanden abmelden können)
          '<form class="jms-logout-form" method="post" action="/.jms-auth/logout?next=' + next + '">' +
          '<button type="submit" class="jms-icon jms-logout" title="Abmelden" aria-label="Abmelden">' + ICON_LOGOUT + '</button></form>'
        : '') +
      '<button type="button" class="jms-min" title="Leiste verkleinern" aria-label="Leiste verkleinern">‹</button>'
    var style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    document.body.appendChild(bar)
    // Klein machen, wenn sie etwas im Dienst verdeckt (merkt sich der Browser je Dienst)
    var KEY = 'jms.bar.small'
    function setSmall(small) {
      bar.className = 'jms-bar' + (small ? ' jms-small' : '')
      bar.querySelector('.jms-min').textContent = small ? '›' : '‹'
      try {
        localStorage.setItem(KEY, small ? '1' : '')
      } catch (e) {}
    }
    var small = false
    try {
      small = localStorage.getItem(KEY) === '1'
    } catch (e) {}
    setSmall(small)
    bar.querySelector('.jms-min').addEventListener('click', function () {
      setSmall(bar.className.indexOf('jms-small') < 0)
    })
  }

  function start() {
    fetch('/.jms-auth/api/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        return r.json()
      })
      .catch(function () {
        return null
      })
      .then(build)
  }
  if (document.body) start()
  else document.addEventListener('DOMContentLoaded', start)
})()
