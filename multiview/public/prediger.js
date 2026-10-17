// Prediger-Seite fürs iPad/iPhone: alle Folien der laufenden Präsentation, antippen zum Auslösen,
// darunter Zurück / Ausblenden / Weiter. Ohne Layout direkt aufrufbar: /prediger.html
//
// Einstellungen über die Adresse:
//   ?groesse=1.4        Folien größer (0.5 … 2.5)
//   ?ausblenden=folie   „Ausblenden“ nimmt nur die Folie weg (sonst Folie UND Hintergrund)
//   ?tasten=aus         keine Tasten (Folien antippen und Tastatur/Clicker gehen weiter)
import { connect, keepTouchScrollInside } from './common.js'
import { createPreacherView } from './propresenter.js'
import { serviceUrl, findService } from './services.js'

const params = new URLSearchParams(location.search)
const view = createPreacherView(
  {
    size: Math.min(Math.max(Number(params.get('groesse')) || 1, 0.5), 2.5),
    blankMode: params.get('ausblenden') === 'folie' ? 'clear' : 'clearAll',
    showControls: params.get('tasten') !== 'aus',
  },
  { interactive: true },
)
document.getElementById('app').append(view.el)
keepTouchScrollInside()

// Zurück zum Dashboard (nur hier auf der eigenen Seite, nicht in der Multiview-Kachel)
const back = document.createElement('a')
back.className = 'pr-dashboard'
back.href = serviceUrl(findService('dashboard'))
back.title = 'Zurück zum Dashboard'
back.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg><span>Dashboard</span>'
view.el.querySelector('.pr-head')?.prepend(back)

const offline = document.getElementById('offline')
let bootId = null

connect(
  (msg) => {
    if (msg.type === 'propresenter') view.update(msg)
    else if (msg.type === 'server') {
      // Nach einem Update des Servers neu laden, damit hier der neue Stand läuft
      if (msg.bootId && bootId && msg.bootId !== bootId) location.reload()
      bootId = msg.bootId ?? bootId
    }
  },
  (online) => (offline.hidden = online),
)

// Tastatur am iPad und Presenter-Clicker (senden Pfeil- bzw. Bild-Tasten)
document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const action = {
    ArrowRight: 'next', ArrowDown: 'next', PageDown: 'next', ' ': 'next', Enter: 'next',
    ArrowLeft: 'previous', ArrowUp: 'previous', PageUp: 'previous',
    b: 'blank', B: 'blank', '.': 'blank',
  }[e.key]
  if (!action) return
  e.preventDefault()
  view.press(action)
})

// Bildschirm anlassen, solange die Seite offen ist – wo das Gerät es erlaubt
let wakeLock = null
async function keepAwake() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen')
      wakeLock.addEventListener('release', () => (wakeLock = null))
    }
  } catch {
    // nicht erlaubt (z. B. ohne HTTPS) – dann in den Geräte-Einstellungen „Automatische Sperre: Nie“
  }
}
document.addEventListener('visibilitychange', keepAwake)
document.addEventListener('pointerdown', keepAwake, { once: true })
keepAwake()
