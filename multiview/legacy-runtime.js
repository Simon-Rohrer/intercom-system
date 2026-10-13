// Laufzeit-Hilfen für alte Browser (wird nur von legacy.js ausgeliefert, siehe dort).
//  - Container-Einheiten: setzt --mv-cqw/-cqh/-cqmin/-cqmax an den Kindern jedes Containers
//    (die umgeschriebenen Styles rechnen damit statt mit cqw/cqh …)
//  - Abstände in Flex-Layouts (gap) als Außenabstand der Kinder
//  - Höhe aus aspect-ratio (--mv-aspect)
//  - kleine Polyfills: replaceChildren, structuredClone, Promise.allSettled,
//    matchMedia(...).addEventListener, <dialog> (showModal/close) und Vollbild
;(function () {
  'use strict'

  // Skriptfehler sichtbar machen: auf alten Geräten gibt es keine Entwicklerkonsole.
  // Roter Kasten unten, antippen blendet ihn aus.
  var errorBox = null
  function showError(text) {
    if (!document.body) return document.addEventListener('DOMContentLoaded', function () { showError(text) })
    if (!errorBox) {
      errorBox = document.createElement('div')
      errorBox.style.cssText =
        'position:fixed;left:8px;right:8px;bottom:8px;z-index:2147483647;max-height:40vh;overflow:auto;' +
        'background:#b00020;color:#fff;font:12px/1.4 -apple-system,sans-serif;padding:8px 10px;border-radius:8px;white-space:pre-wrap'
      errorBox.addEventListener('click', function () {
        errorBox.remove()
        errorBox = null
      })
      document.body.appendChild(errorBox)
    }
    errorBox.textContent += (errorBox.textContent ? '\n' : 'Fehler (antippen zum Ausblenden):\n') + text
  }
  window.addEventListener('error', function (e) {
    var t = e.target
    if (t && t !== window && t.tagName) {
      // Bilder/Videos ohne Quelle sind normal, nur fehlende Skripte und Styles melden
      if (t.tagName === 'SCRIPT' || t.tagName === 'LINK') showError('Laden fehlgeschlagen: ' + (t.src || t.href))
    } else showError((e.message || 'Fehler') + (e.filename ? ' – ' + e.filename.split('/').pop() + ':' + e.lineno : ''))
  }, true)
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    showError('Promise: ' + (r && r.message ? r.message : String(r)))
  })

  function replaceChildren() {
    while (this.firstChild) this.removeChild(this.firstChild)
    this.append.apply(this, arguments)
  }
  ;[window.Element, window.Document, window.DocumentFragment].forEach(function (C) {
    if (C && !C.prototype.replaceChildren) C.prototype.replaceChildren = replaceChildren
  })
  if (!window.structuredClone) {
    window.structuredClone = function (value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    }
  }
  if (!Promise.allSettled) {
    Promise.allSettled = function (values) {
      return Promise.all(Array.from(values, function (v) {
        return Promise.resolve(v).then(
          function (value) { return { status: 'fulfilled', value: value } },
          function (reason) { return { status: 'rejected', reason: reason } }
        )
      }))
    }
  }

  // matchMedia(...).addEventListener('change', …) gibt es erst ab Safari 14
  // (Safari 12 kennt kein globales MediaQueryList, darum über ein echtes Ergebnis von matchMedia)
  var mqlProto = window.matchMedia && Object.getPrototypeOf(window.matchMedia('all'))
  if (mqlProto && typeof mqlProto.addEventListener !== 'function' && typeof mqlProto.addListener === 'function') {
    mqlProto.addEventListener = function (type, fn) {
      if (type === 'change') this.addListener(fn)
    }
    mqlProto.removeEventListener = function (type, fn) {
      if (type === 'change') this.removeListener(fn)
    }
  }

  // <dialog> mit showModal()/close() gibt es erst ab Safari 15.4
  if (!window.HTMLDialogElement) {
    var dialogStyle = document.createElement('style')
    dialogStyle.textContent =
      'dialog:not([open]){display:none}' +
      'dialog[open]{display:block;position:fixed;z-index:1001;top:50%;left:50%;right:auto;bottom:auto;margin:0;' +
      'max-height:calc(100vh - 32px);overflow:auto;-webkit-transform:translate(-50%,-50%);transform:translate(-50%,-50%)}' +
      '.mv-dialog-backdrop{position:fixed;top:0;right:0;bottom:0;left:0;z-index:1000;background:rgba(10,12,16,.5)}'
    document.head.appendChild(dialogStyle)

    var isDialog = function (el) {
      return el && el.tagName === 'DIALOG'
    }
    var openDialog = function (el, modal) {
      if (el.hasAttribute('open')) return
      el.setAttribute('open', '')
      if (modal) {
        var backdrop = document.createElement('div')
        backdrop.className = 'mv-dialog-backdrop'
        // Klick neben den Dialog wirkt wie ein Klick auf den Dialog selbst (wie im echten Browser)
        backdrop.addEventListener('click', function () {
          el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        })
        el.parentNode.insertBefore(backdrop, el)
        el.__mvBackdrop = backdrop
      }
    }
    HTMLElement.prototype.showModal = function () {
      if (isDialog(this)) openDialog(this, true)
    }
    HTMLElement.prototype.show = function () {
      if (isDialog(this)) openDialog(this, false)
    }
    HTMLElement.prototype.close = function (returnValue) {
      if (!isDialog(this) || !this.hasAttribute('open')) return
      if (returnValue !== undefined) this.returnValue = returnValue
      this.removeAttribute('open')
      if (this.__mvBackdrop) this.__mvBackdrop.remove()
      this.__mvBackdrop = null
      this.dispatchEvent(new Event('close'))
    }
    // <form method="dialog"> schließt den Dialog statt die Seite neu zu laden
    document.addEventListener('submit', function (e) {
      var form = e.target
      if ((form.getAttribute('method') || '').toLowerCase() !== 'dialog') return
      e.preventDefault()
      var dialog = form.closest('dialog')
      if (dialog) dialog.close()
    }, true)
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return
      var open = document.querySelectorAll('dialog[open]')
      if (open.length) open[open.length - 1].close()
    })
  }

  // Vollbild: iOS 12 kennt nur webkitRequestFullscreen (iPad). Ohne beides öffnet ein
  // iframe (Vorschau im Editor) seine Seite direkt, das ist auf dem Gerät dann bildschirmfüllend.
  if (!Element.prototype.requestFullscreen) {
    Element.prototype.requestFullscreen = function () {
      if (this.webkitRequestFullscreen) {
        this.webkitRequestFullscreen()
        return Promise.resolve()
      }
      if (this.tagName === 'IFRAME' && this.src) {
        location.href = this.src.replace(/([?&])embed=[^&]*&?/, '$1').replace(/[?&]$/, '')
        return Promise.resolve()
      }
      return Promise.reject(new Error('Vollbild wird von diesem Gerät nicht unterstützt'))
    }
  }
  if (!document.exitFullscreen && document.webkitExitFullscreen) {
    document.exitFullscreen = function () {
      document.webkitExitFullscreen()
      return Promise.resolve()
    }
  }
  if (!('fullscreenElement' in document) && 'webkitFullscreenElement' in document) {
    Object.defineProperty(Document.prototype, 'fullscreenElement', {
      get: function () {
        return this.webkitFullscreenElement || null
      },
    })
    document.addEventListener('webkitfullscreenchange', function () {
      document.dispatchEvent(new Event('fullscreenchange'))
    })
  }

  var docEl = document.documentElement
  docEl.style.setProperty('--mv-cqw', '1vw')
  docEl.style.setProperty('--mv-cqh', '1vh')
  docEl.style.setProperty('--mv-cqmin', '1vmin')
  docEl.style.setProperty('--mv-cqmax', '1vmax')

  // Selektoren aus den Stylesheets: Container (--mv-container), Seitenverhältnisse (--mv-aspect)
  // und Regeln mit gap
  var containerSel = ''
  var gapSel = ''
  var aspects = [] // { sel, ratio }
  var sheetCount = -1

  function collect(rules, containers, gaps, found) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i]
      if (r.cssRules && !r.selectorText) collect(r.cssRules, containers, gaps, found) // @media, @supports
      if (!r.style || !r.selectorText) continue
      if (r.style.getPropertyValue('--mv-container')) containers.push(r.selectorText)
      var ratio = parseFloat(r.style.getPropertyValue('--mv-aspect'))
      if (ratio > 0) found.push({ sel: r.selectorText, ratio: ratio })
      if (r.style.getPropertyValue('gap') || r.style.getPropertyValue('column-gap') || r.style.getPropertyValue('row-gap')) {
        gaps.push(r.selectorText)
      }
    }
  }

  function scanSheets() {
    var sheets = document.styleSheets
    if (sheets.length === sheetCount) return
    var containers = []
    var gaps = []
    var found = []
    var complete = true
    for (var i = 0; i < sheets.length; i++) {
      try {
        collect(sheets[i].cssRules, containers, gaps, found)
      } catch (e) {
        complete = false // Stylesheet noch nicht geladen
      }
    }
    if (complete) sheetCount = sheets.length
    containerSel = containers.join(',')
    gapSel = gaps.join(',')
    aspects = found
  }

  // aspect-ratio: Höhe aus der Breite (spätere Regeln gewinnen, wie im CSS)
  function updateAspects() {
    var ratios = []
    var els = []
    for (var i = 0; i < aspects.length; i++) {
      var list = document.querySelectorAll(aspects[i].sel)
      for (var j = 0; j < list.length; j++) {
        var k = els.indexOf(list[j])
        if (k < 0) {
          els.push(list[j])
          ratios.push(aspects[i].ratio)
        } else ratios[k] = aspects[i].ratio
      }
    }
    for (var n = 0; n < els.length; n++) {
      var w = els[n].getBoundingClientRect().width
      if (!w) continue
      var h = Math.round(w * ratios[n] * 100) / 100 + 'px'
      if (els[n].style.height !== h) els[n].style.height = h
    }
  }

  function px(value, el) {
    if (!value || value === 'normal') return 0
    var m = /^(-?[\d.]+)px$/.exec(value)
    if (m) return parseFloat(m[1])
    var probe = document.createElement('div')
    probe.className = 'mv-probe'
    probe.style.cssText = 'position:absolute;visibility:hidden;height:0;width:' + value
    el.appendChild(probe)
    var w = probe.getBoundingClientRect().width
    el.removeChild(probe)
    return w
  }

  function setVar(el, name, value) {
    if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value)
  }

  function updateContainers() {
    if (!containerSel) return
    var list = document.querySelectorAll(containerSel)
    for (var i = 0; i < list.length; i++) {
      var el = list[i]
      var cs = getComputedStyle(el)
      var w = Math.max(0, el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / 100
      var h = Math.max(0, el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / 100
      var values = [w + 'px', h + 'px', Math.min(w, h) + 'px', Math.max(w, h) + 'px']
      // An den Kindern setzen: so rechnet der Container selbst noch mit dem äußeren Container
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        setVar(c, '--mv-cqw', values[0])
        setVar(c, '--mv-cqh', values[1])
        setVar(c, '--mv-cqmin', values[2])
        setVar(c, '--mv-cqmax', values[3])
      }
    }
  }

  function setMargin(el, prop, value) {
    var v = value ? value + 'px' : ''
    if (el.style[prop] !== v) el.style[prop] = v
  }

  function updateGaps() {
    if (!gapSel) return
    var list = document.querySelectorAll(gapSel)
    for (var i = 0; i < list.length; i++) {
      var el = list[i]
      var cs = getComputedStyle(el)
      if (cs.display !== 'flex' && cs.display !== 'inline-flex') continue
      var colGap = px(cs.columnGap, el)
      var rowGap = px(cs.rowGap, el)
      var dir = cs.flexDirection
      var wrap = cs.flexWrap !== 'nowrap'
      var kids = []
      for (var c = el.firstElementChild; c; c = c.nextElementSibling) {
        var kcs = getComputedStyle(c)
        if (kcs.display !== 'none' && kcs.position !== 'absolute' && kcs.position !== 'fixed') kids.push(c)
      }
      for (var k = 0; k < kids.length; k++) {
        var last = k === kids.length - 1
        var kid = kids[k]
        var right = 0
        var left = 0
        var bottom = 0
        var top = 0
        if (dir === 'column') bottom = last ? 0 : rowGap
        else if (dir === 'column-reverse') top = last ? 0 : rowGap
        else {
          if (dir === 'row-reverse') left = last ? 0 : colGap
          else right = last ? 0 : colGap
          if (wrap) bottom = rowGap
        }
        setMargin(kid, 'marginRight', right)
        setMargin(kid, 'marginLeft', left)
        setMargin(kid, 'marginBottom', bottom)
        setMargin(kid, 'marginTop', top)
      }
    }
  }

  var scheduled = false
  function update() {
    scheduled = false
    scanSheets()
    updateContainers()
    updateAspects()
    updateGaps()
  }
  function schedule() {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(update)
  }

  window.addEventListener('resize', schedule)
  window.addEventListener('orientationchange', schedule)
  window.addEventListener('load', schedule)
  document.addEventListener('DOMContentLoaded', function () {
    // Messhilfen aus px() lösen keine neue Runde aus
    var isProbe = function (n) {
      return n.className === 'mv-probe'
    }
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++) {
        var r = records[i]
        var nodes = Array.prototype.slice.call(r.addedNodes).concat(Array.prototype.slice.call(r.removedNodes))
        if (!nodes.every(isProbe)) return schedule()
      }
    }).observe(document.body, { childList: true, subtree: true })
    schedule()
  })
  setInterval(schedule, 1000)
})()
