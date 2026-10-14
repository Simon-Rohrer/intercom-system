// Darstellung sofort beim Laden setzen (vor dem ersten Zeichnen), damit nichts hell aufblitzt.
// Als normales Skript im <head>, die Einstellungen selbst verwaltet theme.js.
// Hier liegt auch die Liste der Hintergründe: Jeder bringt seine Akzentfarbe und die
// Farbe für die Glasflächen mit, damit Karten und Knöpfe zum Bild passen.
;(function () {
  var WALLPAPERS = [
    // file: null = der blaue Verlauf aus admin.css (ohne Bild)
    { id: 'blau', name: 'Blau', file: null, accent: '#007aff', glass: 'rgba(18, 36, 98, 0.5)', side: 'rgba(8, 22, 70, 0.45)', dialog: 'rgba(14, 30, 86, 0.88)', bg: '#0a1d57' },
    { id: 'ozean', name: 'Ozean', file: 'ozean', accent: '#3478f6', glass: 'rgba(16, 26, 92, 0.48)', side: 'rgba(8, 14, 60, 0.45)', dialog: 'rgba(14, 22, 78, 0.88)', bg: '#0b1050' },
    { id: 'indigo', name: 'Indigo', file: 'indigo', accent: '#5e5ce6', glass: 'rgba(22, 16, 70, 0.5)', side: 'rgba(10, 6, 40, 0.5)', dialog: 'rgba(20, 14, 62, 0.9)', bg: '#07052a' },
    { id: 'abendrot', name: 'Abendrot', file: 'abendrot', accent: '#bf5af2', glass: 'rgba(44, 22, 90, 0.48)', side: 'rgba(24, 12, 60, 0.45)', dialog: 'rgba(38, 20, 80, 0.9)', bg: '#1d0f4a' },
    { id: 'kupfer', name: 'Kupfer', file: 'kupfer', accent: '#f57c1f', glass: 'rgba(36, 24, 16, 0.55)', side: 'rgba(14, 10, 8, 0.55)', dialog: 'rgba(32, 22, 16, 0.92)', bg: '#0c0806' },
    { id: 'salbei', name: 'Salbei', file: 'salbei', accent: '#7fa688', glass: 'rgba(30, 38, 32, 0.55)', side: 'rgba(10, 14, 11, 0.55)', dialog: 'rgba(28, 34, 30, 0.92)', bg: '#0b0e0c' },
    { id: 'tanne', name: 'Tanne', file: 'tanne', accent: '#4f9d77', glass: 'rgba(22, 32, 28, 0.55)', side: 'rgba(6, 10, 8, 0.55)', dialog: 'rgba(22, 30, 26, 0.92)', bg: '#050806' },
    { id: 'graphit', name: 'Graphit', file: 'graphit', accent: '#8e8e93', glass: 'rgba(36, 36, 38, 0.55)', side: 'rgba(12, 12, 13, 0.55)', dialog: 'rgba(34, 34, 36, 0.92)', bg: '#0a0a0b' },
  ]
  // Unter /.jms-auth/ (Anmeldung auf der Adresse eines anderen Dienstes) liegen auch die Bilder dort
  var base = location.pathname.indexOf('/.jms-auth/') === 0 ? '/.jms-auth' : ''

  function find(id) {
    for (var i = 0; i < WALLPAPERS.length; i++) if (WALLPAPERS[i].id === id) return WALLPAPERS[i]
    return WALLPAPERS[0]
  }

  // Setzt Hintergrund, Akzentfarbe und Glasfarben direkt am <html>, damit sie die Tokens aus admin.css überschreiben
  function applyWallpaper(id, dark) {
    var root = document.documentElement
    var wp = find(id)
    var s = root.style
    root.setAttribute('data-wallpaper', wp.id)
    s.setProperty('--accent', wp.accent)
    var names = ['--wallpaper', '--surface', '--sidebar-bg', '--dialog-bg', '--bg']
    if (!wp.file) {
      for (var i = 0; i < names.length; i++) s.removeProperty(names[i])
      return wp
    }
    var img = 'url("' + base + '/api/wallpaper/' + wp.file + '.jpg")'
    if (dark) {
      s.setProperty('--wallpaper', img)
      s.setProperty('--surface', wp.glass)
      s.setProperty('--sidebar-bg', wp.side)
      s.setProperty('--dialog-bg', wp.dialog)
      s.setProperty('--bg', wp.bg)
    } else {
      // Hell: dasselbe Bild unter einem hellen Schleier, damit Text direkt darauf lesbar bleibt
      s.setProperty('--wallpaper', 'linear-gradient(rgba(242, 245, 250, 0.62), rgba(242, 245, 250, 0.62)), ' + img)
      for (var j = 1; j < names.length; j++) s.removeProperty(names[j])
    }
    return wp
  }

  window.MV_WALLPAPERS = WALLPAPERS
  window.MV_applyWallpaper = applyWallpaper
  window.MV_wallpaperBase = base

  try {
    var root = document.documentElement
    var theme = JSON.parse(localStorage.getItem('mv.theme') || '"system"')
    var wallpaper = JSON.parse(localStorage.getItem('mv.wallpaper') || '"blau"')
    root.dataset.theme = theme === 'light' || theme === 'dark' ? theme : 'system'
    var dark = theme === 'dark' || (theme !== 'light' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches)
    applyWallpaper(wallpaper, dark)
  } catch (e) {
    document.documentElement.dataset.theme = 'system'
  }
})()
