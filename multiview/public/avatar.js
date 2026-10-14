// Profilbilder: Anzeige (Bild oder Initialen) und Auswahl mit Zuschnitt im Browser.
// Das Bild wird hier quadratisch auf 256×256 verkleinert und als JPEG an den Server geschickt.

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

export const initials = (name) =>
  String(name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?'

// Feste Farbe pro Name, damit Initialen-Avatare unterscheidbar bleiben (wie bei Apple-Kontakten)
const TINTS = [
  ['#5ac8fa', '#007aff'], ['#ffcc00', '#ff9500'], ['#4cd964', '#34c759'], ['#ff6b9a', '#ff2d55'],
  ['#c69cff', '#af52de'], ['#64d2ff', '#30b0c7'], ['#ff9f6b', '#ff6b22'], ['#8e9bff', '#5856d6'],
]
function tint(name) {
  let h = 0
  for (const c of String(name || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0
  const [a, b] = TINTS[h % TINTS.length]
  return `linear-gradient(160deg, ${a}, ${b})`
}

/** HTML für einen Avatar: Profilbild, sonst farbige Initialen. */
export function avatarHtml(person, { cls = 'avatar', size } = {}) {
  const name = person?.name || ''
  const style = [size ? `--av-size:${size}px` : '', person?.avatar ? '' : `background:${tint(name)}`].filter(Boolean).join(';')
  return `<span class="${cls}${person?.avatar ? ' has-img' : ''}"${style ? ` style="${style}"` : ''}>${
    person?.avatar ? `<img src="${esc(person.avatar)}" alt="" loading="lazy" decoding="async">` : esc(initials(name))
  }</span>`
}

/** Setzt einen vorhandenen Avatar-Knoten (z. B. im Handy-Kopf) auf Bild oder Initialen. */
export function fillAvatar(el, person, fallback) {
  el.classList.toggle('has-img', Boolean(person?.avatar))
  el.style.background = person?.avatar ? '' : tint(person?.name || fallback)
  el.innerHTML = person?.avatar ? `<img src="${esc(person.avatar)}" alt="">` : esc(fallback ?? initials(person?.name))
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Das Bild kann nicht gelesen werden'))
    img.src = url
  })
}

/** Datei → quadratisch mittig zugeschnitten, 256×256 JPEG als data:-URL. */
async function toJpeg(file) {
  const img = await loadImage(file)
  const side = Math.min(img.naturalWidth, img.naturalHeight)
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 256
  const ctx = canvas.getContext('2d')
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256)
  URL.revokeObjectURL(img.src)
  return canvas.toDataURL('image/jpeg', 0.86)
}

/** Öffnet die Bildauswahl (Fotos/Kamera) und lädt das Profilbild hoch. Gibt die neue Adresse zurück. */
export function pickAvatar() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return resolve(undefined)
      try {
        const image = await toJpeg(file)
        const res = await fetch('/api/me/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok || !data.ok) throw new Error(data.error || 'Hochladen fehlgeschlagen')
        resolve(data.avatar)
      } catch (err) {
        reject(err)
      }
    })
    input.click()
  })
}

export async function removeAvatar() {
  await fetch('/api/me/avatar', { method: 'DELETE' })
  return null
}
