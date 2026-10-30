// Structural patcher. Stable public method names are matched through the AST;
// build numbers, whitespace and minified private names are not hard-coded.
const fs = require('node:fs')
const crypto = require('node:crypto')
const acorn = require('acorn')
const legacy = require('./legacy-v1.json')
const MARKER = 'JMS_PAGE_LINKS_V2'
const hash = text => crypto.createHash('sha256').update(text).digest('hex')
function walk(node, callback) {
  if (!node || typeof node !== 'object') return
  callback(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(v => walk(v, callback))
    else if (value && typeof value === 'object') walk(value, callback)
  }
}
function analyze(source) {
  const ast = acorn.parse(source, { ecmaVersion: 'latest', sourceType: 'module' })
  const found = { Controller: [], Store: [], Pool: [] }
  walk(ast, node => {
    if (!['ClassExpression', 'ClassDeclaration'].includes(node.type)) return
    const methods = node.body.body.map(m => m.key?.name)
    if (['insertPages', 'deletePage', 'createTrpcRouter', 'store'].every(n => methods.includes(n))) found.Controller.push(node)
    if (['_ensureDefaultPageExists', 'getPageIds', '_movePageInOrder'].every(n => methods.includes(n))) found.Store.push(node)
    if (['getAllEntities', 'entitySetOption', 'findEntityById'].every(n => methods.includes(n))) found.Pool.push(node)
  })
  for (const [key, candidates] of Object.entries(found)) {
    if (candidates.length !== 1) throw Error(`Unsupported Companion structure: ${key} count ${candidates.length}`)
    found[key] = candidates[0]
  }
  return found
}
const method = (node, name) => node.body.body.find(m => m.key?.name === name)
function thisField(expression, source) {
  if (expression?.type !== 'MemberExpression' || expression.object.type !== 'ThisExpression' || expression.computed) throw Error('Expected instance field')
  return source.slice(expression.start, expression.end)
}
function patch(source) {
  if (source.includes('JMS_PAGE_LINKS_V1')) {
    if (hash(source) !== legacy.sha256) throw Error('Modified legacy patch; automatic migration refused')
    source = source.replace(legacy.method, '').replace(legacy.listener, '')
  }
  const nodes = analyze(source)
  if (source.includes(MARKER)) {
    if (!method(nodes.Pool, 'jmsRemapSurfacePageReferences')) throw Error('Incomplete existing patch')
    return source // runner still verifies behavior before trusting an unfamiliar hash
  }
  if (method(nodes.Pool, 'jmsRemapSurfacePageReferences')) throw Error('Conflicting page-link customization')
  const getter = method(nodes.Controller, 'store')
  const returned = getter.value.body.body
  if (getter.kind !== 'get' || returned.length !== 1 || returned[0].type !== 'ReturnStatement') throw Error('Unsupported page store getter')
  const pageStore = thisField(returned[0].argument, source)
  const controlsFields = new Set()
  walk(nodes.Controller, n => {
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' &&
        ['deleteControl', 'createButtonControl', 'getControl'].includes(n.callee.property.name)) {
      controlsFields.add(thisField(n.callee.object, source))
    }
  })
  if (controlsFields.size !== 1) throw Error('Ambiguous controls controller')
  const controls = [...controlsFields][0]
  const ctor = method(nodes.Controller, 'constructor')
  if (!ctor || ctor.value.async) throw Error('Unsupported page controller constructor')
  if (ctor.value.body.body.some(n => n.type === 'ReturnStatement')) throw Error('Constructor returns explicitly')
  const listener = `
;/* ${MARKER} */
let jmsPageOrder = [...${pageStore}.getPageIds()];
${pageStore}.prependListener('pageindexchange', () => {
  const previousIds = jmsPageOrder;
  const nextIds = [...${pageStore}.getPageIds()];
  jmsPageOrder = nextIds;
  if (previousIds.length === nextIds.length && previousIds.every((id, index) => id === nextIds[index])) return;
  for (const control of ${controls}.getAllControls().values()) {
    if (control.supportsEntities) control.entities.jmsRemapSurfacePageReferences(previousIds, nextIds);
  }
});
`
  const edits = [
    { at: nodes.Pool.body.end - 1, text: legacy.method },
    { at: ctor.value.body.end - 1, text: listener },
  ].sort((a, b) => b.at - a.at)
  for (const edit of edits) source = source.slice(0, edit.at) + edit.text + source.slice(edit.at)
  analyze(source)
  return source
}
module.exports = { analyze, method, walk, patch, hash, MARKER }
if (require.main === module) {
  const source = fs.readFileSync(process.argv[2], 'utf8')
  const result = patch(source)
  fs.writeFileSync(process.argv[3], result)
  console.log(`Page links: validated structure; candidate ${hash(result)}`)
}
