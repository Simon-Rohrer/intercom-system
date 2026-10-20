// Wächter für fremde Oberflächen hinter der zentralen Anmeldung (z. B. Companion). Unsere eigenen
// Seiten merken An- und Abmeldung in anderen Tabs selbst (watchLogin in common.js); diese hier
// nicht. Der Multiview hängt das Skript in ihre Seite ein: Ändert sich die Anmeldung, lädt die
// Seite neu – dann greift wieder die zentrale Anmeldung (Anmeldeseite bzw. neuer Nutzer).
// Auch auf der Seite „Nur für den Admin“: Wechselt man woanders zum Admin, geht es von selbst weiter.
// Bewusst ohne Module und neue Sprachmittel, damit es in jeder fremden Seite läuft.
;(function () {
  // Für wen der Server die Seite gebaut hat (data-key) – fehlt das, gilt die erste Antwort
  var script = document.currentScript
  var key = script && script.hasAttribute('data-key') ? script.getAttribute('data-key') : null
  var busy = false
  function check() {
    if (busy) return
    busy = true
    fetch('/.jms-auth/api/me', { cache: 'no-store', credentials: 'same-origin' })
      .then(function (r) {
        return r.json()
      })
      .then(function (me) {
        if (!me || !me.access || !me.access.enabled) return
        var u = me.user
        var current = u && !u.open ? u.name + '|' + u.roleId + '|' + Boolean(u.admin) + '|' + u.sessionId + '|' + u.version + '|' + u.expiresAt : ''
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
  window.addEventListener('pageshow', check)
  setInterval(check, 5000)
})()
