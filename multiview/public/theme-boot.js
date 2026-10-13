// Darstellung sofort beim Laden setzen (vor dem ersten Zeichnen), damit nichts hell aufblitzt.
// Als normales Skript im <head>, die Einstellungen selbst verwaltet theme.js.
;(function () {
  try {
    var root = document.documentElement
    var theme = JSON.parse(localStorage.getItem('mv.theme') || '"system"')
    var accent = JSON.parse(localStorage.getItem('mv.accent') || 'null')
    root.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'system'
    if (accent) root.style.setProperty('--accent', accent)
  } catch (e) {
    document.documentElement.dataset.theme = 'system'
  }
})()
