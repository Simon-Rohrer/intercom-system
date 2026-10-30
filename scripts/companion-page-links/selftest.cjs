// Run with: node test-companion-page-links.cjs patched-main.js [sanitized-fixture.json]
// Development dependency: acorn. Executes extracted real Companion classes only;
// no server, hardware connection or production page is started/changed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { randomUUID } = require('node:crypto')
const { analyze, method, walk } = require('./engine.cjs')
const source = fs.readFileSync(process.argv[2], 'utf8')
const nodes = analyze(source)
const logger = { silly() {}, warn() {}, debug() {} }
const schema = new Proxy(() => schema, { get: () => schema })
const procedure = { input() { return this }, mutation(fn) { return fn }, subscription(fn) { return fn } }
const env = { setImmediate, structuredClone }
for (const name of ['Controller', 'Store']) {
  assert.equal(nodes[name].superClass.type, 'Identifier')
  env[nodes[name].superClass.name] = EventEmitter
}
for (const node of Object.values(nodes)) walk(node, n => {
  if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'createLogger') {
    assert.equal(n.callee.object.type, 'Identifier')
    env[n.callee.object.name] = { createLogger: () => logger }
  }
})
walk(method(nodes.Store, '_ensureDefaultPageExists'), n => {
  if (n.type === 'Property' && n.key.name === 'id' && n.value.type === 'CallExpression') {
    assert.equal(n.value.callee.type, 'Identifier')
    env[n.value.callee.name] = randomUUID
  }
})
const router = method(nodes.Controller, 'createTrpcRouter')
const returned = router.value.body.body.find(n => n.type === 'ReturnStatement')
assert.equal(returned.argument.callee.type, 'Identifier')
env[returned.argument.callee.name] = x => x
walk(router, n => {
  if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression' || n.callee.object.type !== 'Identifier') return
  if (['subscription', 'input'].includes(n.callee.property.name)) env[n.callee.object.name] = procedure
  if (n.callee.property.name === 'object') env[n.callee.object.name] = schema
})
const load = name => vm.runInNewContext('(' + source.slice(nodes[name].start, nodes[name].end) + ')', env)
const Store = load('Store'), Controller = load('Controller'), Pool = load('Pool')
const fixture = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : {
  pages: Object.fromEntries(['Regie', 'Licht', 'Chat'].map((name, index) => [index + 1, { id: name, name, controls: {} }])),
  refs: [],
}
function entity(value, overrides = {}) {
  return { type: 'action', definitionId: 'set_page', connectionId: 'internal',
    rawOptions: { page: { isExpression: false, value } }, calls: 0,
    setOption(key, option) { this.rawOptions[key] = option; this.calls++ }, ...overrides }
}
function setup(extra = [], pageData = fixture.pages, refs = fixture.refs) {
  const disk = structuredClone(pageData)
  const store = new Store({ all: () => structuredClone(disk), set: (k, v) => { disk[k] = structuredClone(v) }, delete: k => { delete disk[k] } })
  const entities = refs.map(ref => entity(ref.options.page.value, {
    ...ref, rawOptions: structuredClone(ref.options),
  })).concat(extra)
  let saves = 0, saved
  const pool = Object.create(Pool.prototype)
  // The real pool recursively reads all lists; include an additional nested-list
  // result to cover every entity, instead of testing only press actions.
  pool.getAllEntityLists = () => [{ getAllEntities: () => entities.slice(0, 1) }, { getAllEntities: () => entities.slice(1) }]
  pool.reportChange = props => {
    assert.equal(props.noSave, undefined)
    assert.equal(props.redraw, true)
    saves++
    saved = entities.map(e => ({ type: e.type, definitionId: e.definitionId, connectionId: e.connectionId, options: structuredClone(e.rawOptions) }))
  }
  const control = { supportsEntities: true, entities: pool }
  const controller = new Controller({ clearAllForPage() {}, invalidateButton() {} }, {
    getAllControls: () => new Map([['button', control], ['nav', { supportsEntities: false }]]),
    getControl: () => control,
  }, {}, new EventEmitter(), store)
  return { controller, store, entities, disk, get saves() { return saves }, get saved() { return saved } }
}
const targetIds = ctx => ctx.entities.map(e => ctx.store.getPageId(Number(e.rawOptions.page.value)))
let passed = 0
function test(name, fn) { fn(); passed++; console.log('PASS', name) }

test('Existing links follow original page IDs when pages are inserted and deleted before them', () => {
  const c = setup([entity(3), entity('2')]), original = targetIds(c)
  c.controller.insertPages(1, ['Temporary A', 'Temporary B'])
  assert.deepEqual(targetIds(c), original)
  c.controller.deletePage(1); c.controller.deletePage(1)
  assert.deepEqual(targetIds(c), original)
  assert.equal(c.saves, 3)
})
test('Move in either direction follows IDs, including new links created after a reorder', () => {
  const c = setup([entity(3)]), original = targetIds(c), id = c.store.getPageId(3)
  const router = c.controller.createTrpcRouter()
  router.move({ input: { pageId: id, pageNumber: 1 } })
  assert.deepEqual(targetIds(c), original)
  const newLink = entity(2), newTarget = c.store.getPageId(2)
  c.entities.push(newLink)
  router.move({ input: { pageId: id, pageNumber: 3 } })
  assert.deepEqual(targetIds(c).slice(0, -1), original)
  assert.equal(c.store.getPageId(Number(newLink.rawOptions.page.value)), newTarget)
})
test('Deleting the actual destination never redirects to its replacement or a newly inserted page', () => {
  const c = setup([entity(2)]), e = c.entities.at(-1), id = c.store.getPageId(2)
  c.controller.deletePage(2)
  assert.equal(e.rawOptions.page.value, 'deleted-page:' + id)
  assert.equal(c.store.getPageInfo(Number(e.rawOptions.page.value)), undefined)
  c.controller.insertPages(2, ['Replacement'])
  assert.equal(e.rawOptions.page.value, 'deleted-page:' + id)
})
test('Relative navigation, startup, expressions and other connections are preserved', () => {
  const extra = [0, '0', 'startup', 'back', 'forward', '+1', '-1', 0.5, 999].map(v => entity(v))
  extra.push(entity('3', { rawOptions: { page: { isExpression: true, value: '3' } } }),
    entity(3, { connectionId: 'external' }), entity(3, { definitionId: 'other_action' }))
  const before = extra.map(e => JSON.stringify(e.rawOptions))
  const c = setup(extra); c.controller.insertPages(1, ['Before'])
  assert.deepEqual(extra.map(e => JSON.stringify(e.rawOptions)), before)
})
test('Index-based actions, feedbacks and disabled links follow the page and resubscribe', () => {
  const extras = [entity(3, { definitionId: 'set_page_byindex' }),
    entity(3, { type: 'feedback', definitionId: 'surface_on_page' }), entity('3', { disabled: true })]
  const c = setup(extras); c.controller.insertPages(1, ['Before'])
  assert.deepEqual(extras.map(e => e.rawOptions.page.value), [4, 4, '4'])
  assert.ok(extras.every(e => e.calls === 1))
})
test('Renaming and repeated identical order events do not rewrite links', () => {
  const c = setup([entity(2)])
  c.controller.setPageName(2, 'Renamed')
  c.store.emit('pageindexchange', new Set())
  assert.equal(c.saves, 0)
})
test('Remapped options persist and continue to follow the same pages after restart', () => {
  const c = setup([entity(2)]), original = targetIds(c)
  c.controller.insertPages(1, ['Before'])
  const restored = setup([], c.disk, c.saved)
  assert.deepEqual(targetIds(restored), original)
  restored.controller.deletePage(1)
  assert.deepEqual(targetIds(restored), original)
})
console.log(`${passed} tests passed; real bundled PageController, PageStore and EntityPool methods; ${fixture.refs.length} production references in sanitized fixture`)
