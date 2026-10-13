// Laufzeit-Hilfen für alte Browser (wird nur von legacy.js ausgeliefert, siehe dort).
//  - Container-Einheiten: setzt --mv-cqw/-cqh/-cqmin/-cqmax an den Kindern jedes Containers
//    (die umgeschriebenen Styles rechnen damit statt mit cqw/cqh …)
//  - Abstände in Flex-Layouts (gap) als Außenabstand der Kinder
//  - kleine Polyfills: replaceChildren, structuredClone
;(function () {
  'use strict'

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

  var docEl = document.documentElement
  docEl.style.setProperty('--mv-cqw', '1vw')
  docEl.style.setProperty('--mv-cqh', '1vh')
  docEl.style.setProperty('--mv-cqmin', '1vmin')
  docEl.style.setProperty('--mv-cqmax', '1vmax')

  // Selektoren aus den Stylesheets: Container (--mv-container) und Regeln mit gap
  var containerSel = ''
  var gapSel = ''
  var sheetCount = -1

  function collect(rules, containers, gaps) {
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i]
      if (r.cssRules && !r.selectorText) collect(r.cssRules, containers, gaps) // @media, @supports
      if (!r.style || !r.selectorText) continue
      if (r.style.getPropertyValue('--mv-container')) containers.push(r.selectorText)
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
    var complete = true
    for (var i = 0; i < sheets.length; i++) {
      try {
        collect(sheets[i].cssRules, containers, gaps)
      } catch (e) {
        complete = false // Stylesheet noch nicht geladen
      }
    }
    if (complete) sheetCount = sheets.length
    containerSel = containers.join(',')
    gapSel = gaps.join(',')
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
