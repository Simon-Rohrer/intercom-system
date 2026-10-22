'use strict'

// Kompatibilität für alte Browser (z. B. iPad Air 1 mit iOS 12).
//
// Moderne Browser bekommen die Dateien aus public/ unverändert. Erkennt der Server einen
// alten Browser, liefert er stattdessen umgeschriebene Fassungen:
//   - JavaScript: neue Schreibweisen (?. ?? ??= Klassenfelder …) per esbuild für Safari 12
//   - CSS: clamp(), Container-Einheiten (cqw/cqh/cqmin/cqmax), inset, color-mix, aspect-ratio
//   - HTML: lädt zusätzlich legacy-runtime.js (Container-Größen, Seitenverhältnisse, Flex-Abstände,
//     Vollbild, <dialog>, kleine Polyfills und eine Fehleranzeige)
// Die Dateien in public/ bleiben dabei unberührt.
//
// Zum Testen auf einem neuen Browser: ?legacy=1 an die Adresse hängen (?legacy=0 schaltet zurück).

const fs = require('fs')
const path = require('path')

const TARGET = 'safari12'
const RUNTIME_FILE = path.join(__dirname, 'legacy-runtime.js')
const COOKIE = 'mv-legacy'

let esbuild = null
try {
  esbuild = require('esbuild')
} catch {
  console.warn('[legacy] esbuild fehlt – alte Browser bekommen JavaScript unverändert')
}

/** Browser ohne Container-Einheiten (Safari < 16, Chrome < 105, Firefox < 110). */
function isLegacyBrowser(ua) {
  if (!ua) return false
  let m = / OS (\d+)_\d+(?:_\d+)? like Mac OS X/.exec(ua) // alle Browser auf iPhone/iPad
  if (m) return Number(m[1]) < 16
  m = /(?:Chrome|Chromium|CriOS)\/(\d+)/.exec(ua)
  if (m) return Number(m[1]) < 105
  m = /Firefox\/(\d+)/.exec(ua)
  if (m) return Number(m[1]) < 110
  m = /Version\/(\d+)[\d.]* (?:Mobile\/\S+ )?Safari\//.exec(ua)
  if (m) return Number(m[1]) < 16
  return false
}

function cookieValue(req) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]*)`).exec(req.headers.cookie || '')
  return m ? m[1] : null
}

function wantsLegacy(req, res) {
  const forced = req.query && req.query.legacy
  if (forced === '1' || forced === '0') {
    res.append('Set-Cookie', `${COOKIE}=${forced}; Path=/; Max-Age=2592000; SameSite=Lax`)
    return forced === '1'
  }
  const cookie = cookieValue(req)
  if (cookie === '1' || cookie === '0') return cookie === '1'
  return isLegacyBrowser(req.headers['user-agent'])
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

/** Teilt eine Werteliste an Kommas bzw. Leerzeichen der obersten Klammerebene. */
function splitTopLevel(text, sep) {
  const parts = []
  let depth = 0
  let cur = ''
  for (const ch of text) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (depth === 0 && (sep === ' ' ? /\s/.test(ch) : ch === sep)) {
      if (cur.trim()) parts.push(cur.trim())
      cur = ''
    } else {
      cur += ch
    }
  }
  if (cur.trim()) parts.push(cur.trim())
  return parts
}

/** Ersetzt jede Funktion name(...) über replacer(argumente) – auch verschachtelt. */
function replaceFunction(css, name, replacer) {
  const re = new RegExp(`(^|[^\\w-])${name}\\(`, 'g')
  for (let guard = 0; guard < 10000; guard++) {
    re.lastIndex = 0
    const m = re.exec(css)
    if (!m) break
    const start = m.index + m[1].length
    const open = start + name.length
    let depth = 0
    let end = -1
    for (let i = open; i < css.length; i++) {
      if (css[i] === '(') depth++
      else if (css[i] === ')' && --depth === 0) {
        end = i
        break
      }
    }
    if (end < 0) break
    const args = splitTopLevel(css.slice(open + 1, end), ',')
    css = css.slice(0, start) + replacer(args) + css.slice(end + 1)
  }
  return css
}

function pickMixColor(args) {
  // color-mix(in srgb, A 10%, B) → die Farbe mit dem größeren Anteil (bzw. die nicht transparente)
  const stops = args.slice(1).map((s) => {
    const m = /^(.*?)\s+(\d+(?:\.\d+)?)%$/.exec(s)
    return m ? { color: m[1], pct: Number(m[2]) } : { color: s, pct: null }
  })
  if (stops.length !== 2) return stops[0] ? stops[0].color : 'transparent'
  const [a, b] = stops
  if (a.color === 'transparent') return b.color
  if (b.color === 'transparent') return a.color
  const pa = a.pct != null ? a.pct : b.pct != null ? 100 - b.pct : 50
  return pa >= 50 ? a.color : b.color
}

function lowerDeclarations(body) {
  // inset: a b c d → top/right/bottom/left (das Schlüsselwort „inset“ in box-shadow bleibt)
  body = body.replace(/(^|[;\s])inset\s*:\s*([^;]+?)\s*(!important)?\s*(?=;|$)/g, (all, pre, value, imp) => {
    const v = splitTopLevel(value, ' ')
    const [t, r = t, b = t, l = r] = v
    const i = imp ? ' !important' : ''
    return `${pre}top: ${t}${i}; right: ${r}${i}; bottom: ${b}${i}; left: ${l}${i}`
  })

  // aspect-ratio: die Höhe setzt legacy-runtime.js aus der Breite (Verhältnis Höhe/Breite)
  const ar = /(?:^|[;\s])aspect-ratio\s*:\s*([\d.]+)\s*\/\s*([\d.]+)/.exec(body)
  if (ar && !/(?:^|[;\s])height\s*:/.test(body)) {
    body = `${body.replace(/;?\s*$/, '')}; --mv-aspect: ${+(Number(ar[2]) / Number(ar[1])).toFixed(6)} `
  }

  // container-type merkt sich legacy-runtime.js über eine eigene Variable
  body = body.replace(/(^|[;\s])container-type\s*:\s*(size|inline-size)/g, '$1--mv-container: $2; container-type: $2')
  return body
}

function transformCss(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  css = replaceFunction(css, 'clamp', ([min, val, max]) => `max(${min}, min(${val}, ${max}))`)
  css = replaceFunction(css, 'color-mix', pickMixColor)
  css = css.replace(/(-?(?:\d+\.?\d*|\.\d+))cq(min|max|w|h|i|b)\b/g, (all, n, unit) => {
    const u = unit === 'i' ? 'w' : unit === 'b' ? 'h' : unit
    return `calc(${n} * var(--mv-cq${u}))`
  })
  return css.replace(/\{([^{}]*)\}/g, (all, body) => `{${lowerDeclarations(body)}}`)
}

// ---------------------------------------------------------------------------
// JavaScript und HTML
// ---------------------------------------------------------------------------

function transformJs(code, file) {
  if (!esbuild) return code
  return esbuild.transformSync(code, {
    loader: 'js',
    target: TARGET,
    // Safari 12 kann Destrukturierung; esbuild sperrt sie wegen eines Randfall-Fehlers in alten Safaris
    supported: { destructuring: true },
    charset: 'utf8',
    sourcefile: file,
  }).code
}

function transformHtml(html) {
  const tag = '<script src="/legacy-runtime.js"></script>'
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (h) => `${h}\n  ${tag}`) : tag + html
}

const TYPES = {
  '.js': ['application/javascript; charset=utf-8', transformJs],
  '.mjs': ['application/javascript; charset=utf-8', transformJs],
  '.css': ['text/css; charset=utf-8', transformCss],
  '.html': ['text/html; charset=utf-8', transformHtml],
}

/** Express-Middleware: vor express.static einhängen. */
function legacyMiddleware(publicDir) {
  const root = path.resolve(publicDir)
  const cache = new Map() // Datei → { mtimeMs, size, body }
  const warned = new Set()

  function render(file, transform) {
    const stat = fs.statSync(file)
    const hit = cache.get(file)
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.body
    const source = fs.readFileSync(file, 'utf8')
    let body = source
    try {
      body = transform(source, path.basename(file))
    } catch (err) {
      if (!warned.has(file)) console.warn(`[legacy] ${path.basename(file)} nicht umgeschrieben: ${err.message}`)
      warned.add(file)
    }
    cache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, body })
    return body
  }

  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next()
    if (!wantsLegacy(req, res)) return next()

    let rel
    try {
      rel = decodeURIComponent(req.path)
    } catch {
      return next()
    }
    let file
    if (rel === '/legacy-runtime.js') file = RUNTIME_FILE
    else {
      if (rel.endsWith('/')) rel += 'index.html'
      file = path.resolve(root, '.' + rel)
      if (!file.startsWith(root + path.sep)) return next()
    }
    const type = TYPES[path.extname(file).toLowerCase()]
    if (!type || !fs.existsSync(file)) return next()

    const body = render(file, type[1])
    res.set({ 'Content-Type': type[0], 'Cache-Control': 'no-cache', Vary: 'User-Agent, Cookie' })
    res.send(body)
  }
}

module.exports = { legacyMiddleware }
