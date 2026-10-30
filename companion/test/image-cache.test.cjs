const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// Exercise the actual TypeScript classes without starting a Companion worker,
// opening device connections, or needing native canvas on the test machine.
function loadSource(name) {
  const source = fs.readFileSync(path.join(__dirname, '../src', name), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText
  const exports = {}
  vm.runInNewContext(code, { exports, Buffer, WebSocket, setTimeout, clearTimeout,
    require(id) {
      if (id === '@companion-module/base') return { InstanceBase: class {}, runEntrypoint() {}, combineRgb: (r,g,b) => (r << 16) | (g << 8) | b }
      if (id === './presets.js') return loadSource('presets.ts')
      if (id === './imageRenderer.js') return { isCanvasAvailable: () => false }
      if (id === './pngPadding.js') return loadSource('pngPadding.ts')
      if (id === 'node:zlib') return require('node:zlib')
      return {}
    },
  }, { filename: name })
  return exports
}
const { ImageBridge } = loadSource('imageBridge.ts')
const { ModuleInstance } = loadSource('main.ts')
function bridge() {
  return new ImageBridge({ log() {}, checkFeedbacks() {}, setButtonImageEffectValue() {},
    getProfileButtonConfig() { return null }, listenRooms: [], replyDirectUsername: '',
  }, 'https://fixture.invalid')
}
function update(b, bank, buttonIndex, label) {
  b.handleMessage({ data: JSON.stringify({ type: 'update_button_image', bank, buttonIndex,
    label, imageBuffer: Buffer.from(label).toString('base64'), state: 'IDLE',
  }) })
}

test('periodic page 1 updates cannot overwrite page 0 image or text after a press', () => {
  const b = bridge()
  update(b, 0, 0, 'Andere Folie')
  update(b, 1, 0, 'Licht/ProPresenter')
  for (let cycle = 0; cycle < 3; cycle++) {
    update(b, 0, 0, 'Andere Folie') // command feedback
    update(b, 1, 0, 'Licht/ProPresenter') // periodic active-page snapshot
    assert.equal(b.getImage(0, 0).toString(), 'Andere Folie')
    assert.equal(b.getText(0, 0), 'Andere Folie')
    assert.equal(b.getImage(0, 1).toString(), 'Licht/ProPresenter')
    assert.equal(b.getText(0, 1), 'Licht/ProPresenter')
  }
})
test('a missing page stays missing and cannot display another page at startup', () => {
  const b = bridge()
  update(b, 1, 0, 'Wrong page')
  assert.equal(b.getImage(0, 0), undefined)
  assert.equal(b.getText(0, 0), undefined)
  assert.equal(b.getImage(0, 2), undefined)
})
test('legacy latest-slot and composite lookups remain separate from page 0', () => {
  const b = bridge()
  update(b, 0, 4, 'Zero')
  update(b, 1, 104, 'One')
  assert.equal(b.getImage(4).toString(), 'One')
  assert.equal(b.getText(4), 'One')
  assert.equal(b.getImage(104).toString(), 'One')
  assert.equal(b.getImage(4, 0).toString(), 'Zero')
})
test('empty labels and clearing remove only the intended cache entries', () => {
  const b = bridge()
  update(b, 0, 9, 'Danke')
  update(b, 1, 9, '')
  assert.equal(b.getText(9, 0), 'Danke')
  assert.equal(b.getText(9, 1), undefined)
  b.clearImages()
  assert.equal(b.getImage(9), undefined)
  assert.equal(b.getImage(9, 0), undefined)
  assert.equal(b.getText(9), undefined)
  assert.equal(b.getText(9, 0), undefined)
})
test('effect updates and default current-page lookups cannot bleed between pages', () => {
  const m = new ModuleInstance({})
  m.checkFeedbacks = () => {}
  m.currentPageNumber = 1
  m.setButtonImageEffectValue(0, 2, 0)
  m.setButtonImageEffectValue(0, 1, 1)
  assert.equal(m.getButtonEffectValue(0, 0), 2)
  assert.equal(m.getButtonEffectValue(0), 1)
  assert.equal(m.getButtonEffectValue(0, 2), 0)
  m.setButtonImageEffectValue(0, 0)
  assert.equal(m.getButtonEffectValue(0, 0), 2)
  assert.equal(m.getButtonEffectValue(0), 0)
})

const { UpdateFeedbacks } = loadSource('feedbacks.ts')
test('inactive-page feedback starts with its published image and keeps matching live updates', () => {
  const b = bridge()
  const preview = Buffer.from('published page zero overlay').toString('base64')
  let definitions
  const self = {
    getRoomChoices: () => [], setFeedbackDefinitions: d => { definitions = d },
    getPresetProfileButtonConfig: () => ({ index: 0, label: 'Andere Folie', previewImageBuffer: preview }),
    getProfileButtonConfig: () => null,
    getCurrentPageButtonConfig: () => ({ index: 0, label: 'Wrong active page' }),
    resolveSyncedButtonLabel: button => button.label || '',
    getButtonImage: (slot,page) => b.getImage(slot,page),
    getButtonText: (slot,page) => b.getText(slot,page),
  }
  UpdateFeedbacks(self)
  const feedback = { options: { slotIndex: 0, sourcePageNumber: 0, roleId: 'lighting', profileUsername: 'Simon' } }
  const render = () => definitions.dynamic_button_image.callback(feedback)
  update(b, 1, 0, 'Licht/ProPresenter')
  assert.equal(render().text, undefined)
  assert.equal(render().png64, preview)
  update(b, 0, 0, 'Andere Folie live')
  update(b, 1, 0, 'Licht/ProPresenter changed')
  assert.equal(render().text, undefined)
  assert.equal(render().png64, Buffer.from('Andere Folie live').toString('base64'))
  b.clearImages()
  self.getPresetProfileButtonConfig = () => null
  assert.equal(render().text, undefined)
  assert.equal(render().png64, undefined)
})

test('synced feedbacks leave every Companion text colour unchanged, including white', () => {
  let definitions
  let button = { index: 0, label: 'Livestream', color: '#caf0fe' }
  const self = {
    getRoomChoices: () => [], setFeedbackDefinitions: d => { definitions = d },
    getPresetProfileButtonConfig: () => button,
    getProfileButtonConfig: () => button, getCurrentPageButtonConfig: () => button,
    resolveSyncedButtonLabel: b => b.label,
    getButtonImage: () => Buffer.from('overlay'), getButtonText: () => 'Livestream',
  }
  UpdateFeedbacks(self)
  for (const background of ['#caf0fe', '#fffc41', '#000000']) {
    button.color = background
    for (const name of ['dynamic_button_image', 'synced_slot_style']) {
      const result = definitions[name].callback({ options: { slotIndex: 0, sourcePageNumber: 1, roleId: 'lighting' } })
      assert.equal(Object.hasOwn(result, 'color'), false, name + ' must not override Companion colour')
      assert.equal(({ color: 0xffffff, ...result }).color, 0xffffff)
      assert.equal(({ color: 0xff00ff, ...result }).color, 0xff00ff)
    }
  }
})

test('Companion labels, blank text, line breaks and variables survive live Kesher updates', () => {
  let definitions
  let liveLabel = 'Kesher label'
  const self = {
    getRoomChoices: () => [], setFeedbackDefinitions: d => { definitions = d },
    getPresetProfileButtonConfig: () => ({ index: 0, label: liveLabel }),
    getProfileButtonConfig: () => ({ index: 0, label: liveLabel }),
    getCurrentPageButtonConfig: () => ({ index: 0, label: liveLabel }),
    resolveSyncedButtonLabel: b => b.label,
    getButtonImage: () => Buffer.from('live overlay'), getButtonText: () => liveLabel,
  }
  UpdateFeedbacks(self)
  for (const label of ['Kesher label', 'Changed after press', 'Periodic snapshot']) {
    liveLabel = label
    for (const name of ['dynamic_button_image', 'synced_slot_style']) {
      const result = definitions[name].callback({ options: { slotIndex: 0, sourcePageNumber: 1, roleId: 'lighting' } })
      assert.equal(Object.hasOwn(result, 'text'), false)
      for (const text of ['My own label', '', 'Line 1\nLine 2', '$(internal:time_hms)']) {
        assert.equal(({ text, ...result }).text, text)
      }
      if (name === 'dynamic_button_image') assert.ok(result.png64)
    }
  }
})
