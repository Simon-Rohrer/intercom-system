const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

const source = fs.readFileSync(path.join(__dirname, '../src/pngPadding.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
const mod = { exports: {} }
new Function('exports', 'require', 'module', code)(mod.exports, require, mod)
const { encodePng, decodePng, padPng, hasPadding } = mod.exports

function solid(size, rgba) {
  const data = new Uint8Array(size * size * 4)
  for (let i = 0; i < size * size; i++) data.set(rgba, i * 4)
  return encodePng({ width: size, height: size, data })
}
const pixel = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4))

test('PNG übersteht Kodieren und Lesen', () => {
  const back = decodePng(solid(72, [10, 20, 30, 255]))
  assert.equal(back.width, 72)
  assert.deepEqual(pixel(back, 40, 40), [10, 20, 30, 255])
})

test('Abstände lassen Rand frei und füllen das Innere', () => {
  const out = decodePng(padPng(solid(72, [200, 0, 0, 255]), { top: 10, right: 0, bottom: 0, left: 20 }))
  assert.equal(out.width, 72)
  assert.equal(pixel(out, 5, 40)[3], 0)   // links frei
  assert.equal(pixel(out, 40, 5)[3], 0)   // oben frei
  assert.deepEqual(pixel(out, 50, 50), [200, 0, 0, 255])
})

test('Größere Bilder werden auf 72 px umgerechnet', () => {
  const out = decodePng(padPng(solid(144, [0, 0, 255, 255]), { top: 0, right: 0, bottom: 0, left: 10 }))
  assert.equal(pixel(out, 15, 70)[3], 0)  // 10 px Taste = 20 px Bild
  assert.equal(pixel(out, 25, 70)[3], 255)
})

test('Ohne Abstand nichts zu tun, unlesbares PNG ergibt null', () => {
  assert.equal(hasPadding({ top: 0, right: 0, bottom: 0, left: 0 }), false)
  assert.equal(padPng(Buffer.from('kein png'), { top: 1, right: 0, bottom: 0, left: 0 }), null)
})
