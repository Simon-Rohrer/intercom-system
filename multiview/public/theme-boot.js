// Darstellung sofort beim Laden setzen (vor dem ersten Zeichnen), damit nichts hell aufblitzt.
// Als normales Skript im <head>, die Einstellungen selbst verwaltet theme.js.
;(function () {
  try {
    var root = document.documentElement
    var theme = JSON.parse(localStorage.getItem('mv.theme') || '"system"')
    var accent = JSON.parse(localStorage.getItem('mv.accent') || 'null')
    root.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'system'
    // frühere Akzentfarben auf die Apple-Farben umrechnen (wie theme.js)
    var old = { '#2563eb': '#007aff', '#4f46e5': '#5856d6', '#7c3aed': '#af52de', '#db2777': '#ff2d55', '#dc2626': '#ff3b30', '#ea580c': '#ff9500', '#b45309': '#c27c0e', '#16a34a': '#34c759', '#0d9488': '#30b0c7', '#475569': '#8e8e93' }
    if (accent) root.style.setProperty('--accent', old[String(accent).toLowerCase()] || accent)
  } catch (e) {
    document.documentElement.dataset.theme = 'system'
  }
})()
