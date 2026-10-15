// Wächter für fremde Oberflächen hinter der zentralen Anmeldung (z. B. Companion). Unsere eigenen
// Seiten merken An- und Abmeldung in anderen Tabs selbst (watchLogin in common.js); diese hier
// nicht. Der Multiview hängt das Skript in ihre Seite ein: Ändert sich die Anmeldung, lädt die
// Seite neu – dann greift wieder die zentrale Anmeldung (Anmeldeseite bzw. neuer Nutzer).
// Bewusst ohne Module und neue Sprachmittel, damit es in jeder fremden Seite läuft.
;(function () {
  var key = null
  var busy = false
  function check() {
    if (busy || document.visibilityState === 'hidden') return
    busy = true
    fetch('/.jms-auth/api/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        return r.json()
      })
      .then(function (me) {
        if (!me || !me.access || !me.access.enabled) return
        var u = me.user
        var current = u && !u.open ? u.name + '|' + u.roleId + '|' + Boolean(u.admin) : ''
        if (key === null) key = current
        else if (current !== key) location.reload()
      })
      .catch(function () {
        // Server gerade nicht erreichbar – beim nächsten Mal
      })
      .then(function () {
        busy = false
      })
  }
  check()
  document.addEventListener('visibilitychange', check)
  window.addEventListener('focus', check)
  setInterval(check, 15000)
})()
