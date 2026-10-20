// Meldet den Admin bei Diensten mit eigener Anmeldung (Portainer, Router) automatisch an.
// Der Multiview hängt das Skript nur für den angemeldeten Admin in die Seite des Dienstes ein
// (Zugangsdaten unter Benutzer & Rechte → Zugangsdaten der Dienste). Es trägt Benutzer und
// Passwort auf der Anmeldeseite ein und klickt auf „Anmelden“ – höchstens einmal je Seitenaufruf,
// damit man sich im Dienst auch wieder abmelden kann. Bewusst ohne Module, läuft in jeder fremden Seite.
;(function () {
  var script = document.currentScript
  var service = script && script.getAttribute('data-service')
  if (!service) return

  var started = Date.now()
  var done = false

  function visible(el) {
    return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length))
  }

  // Auch für React/Angular-Felder: der Wert muss über den nativen Setter kommen
  function setValue(el, value) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    el.focus()
    setter.call(el, value)
    ;['input', 'change', 'keyup'].forEach(function (type) {
      el.dispatchEvent(new Event(type, { bubbles: true }))
    })
  }

  function enabled(btn) {
    return btn && !btn.disabled && !btn.classList.contains('disabled') && visible(btn)
  }

  // Jeder Dienst: Felder und Knopf der Anmeldeseite
  var forms = {
    portainer: function () {
      var user = document.querySelector('input#username, input[name="username"]')
      var pass = document.querySelector('input#password, input[name="password"]')
      var btn = document.querySelector('button[type="submit"], button[data-cy="auth-loginButton"]')
      return user && pass && visible(user) && visible(pass) ? { user: user, pass: pass, btn: btn } : null
    },
    router: function () {
      var pass = document.getElementById('router_password')
      var btn = document.getElementById('loginbutton')
      return pass && visible(pass) ? { user: null, pass: pass, btn: btn } : null
    },
  }

  fetch('/.jms-auth/api/autologin/' + encodeURIComponent(service), {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'X-JMS-Autologin': '1' },
  })
    .then(function (r) {
      return r.ok ? r.json() : null
    })
    .then(function (cred) {
      if (!cred || !cred.ok || !forms[service]) return
      var timer = setInterval(function () {
        // Nur in den ersten Sekunden nach dem Laden – danach hat jemand die Seite bewusst bedient
        if (done || Date.now() - started > 20000) return clearInterval(timer)
        var form = forms[service]()
        if (!form) return
        if (form.user) setValue(form.user, cred.username || '')
        setValue(form.pass, cred.password)
        if (window.jQuery && service === 'router') window.jQuery(form.pass).trigger('keyup').trigger('change')
        if (!enabled(form.btn)) return
        done = true
        clearInterval(timer)
        form.btn.click()
      }, 300)
    })
    .catch(function () {
      // Server nicht erreichbar – dann bleibt es bei der normalen Anmeldung
    })
})()
