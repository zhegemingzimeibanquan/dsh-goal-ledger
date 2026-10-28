// Trace the link pipeline end to end: snapshot -> layoutPoints -> layoutLinks ->
// what drawField would actually stroke. If a link reaches the last step but not
// the canvas, the bug is in the draw loop; if it never reaches it, the bug is in
// the resolution step.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
const ROOT = 'C:/Project/dsh-goal-ledger'
const src = await readFile(join(ROOT, 'lib', 'client.js'), 'utf8')

const ReactStub = {
  createElement: () => null,
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => f(),
  useRef: () => ({ current: null }),
  Fragment: 'Fragment'
}
let captured = null
const fakeRequire = (id) => {
  if (id === 'react') return ReactStub
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  if (id === 'react-dom') return {}
  throw new Error('unexpected require: ' + id)
}
const instrumented = src.replace(
  'module.exports = { apply, inject, name }',
  'module.exports = { apply, inject, name, __test: { layoutPoints, layoutLinks, drawField, LINK_STRONG, LINK_WEAK } }'
)
new Function('window', 'document', 'navigator', 'require', instrumented)(
  { __ModuleLoader__: { load: (r) => { captured = r } } },
  { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
  {}, fakeRequire
)
const mod = captured.factory(fakeRequire)
const { layoutPoints, layoutLinks, drawField } = mod.__test

const snapshotPath = process.env.SNAPSHOT
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-goal-ledger', 'snapshot.json')
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const distance = snapshot.distance ?? {}
const items = distance.items ?? []
const rawLinks = distance.links ?? []

console.log('snapshot links:', rawLinks.length)

const points = layoutPoints(items)
console.log('points:', points.length)
const byId = new Map(points.map(p => [p.id, p]))
console.log('point ids sample:', points.slice(0, 2).map(p => p.id))
console.log('link ids sample  :', rawLinks.slice(0, 2).map(l => l.a))

const missingA = rawLinks.filter(l => !byId.has(l.a))
const missingB = rawLinks.filter(l => !byId.has(l.b))
console.log('links whose "a" has no point:', missingA.length)
console.log('links whose "b" has no point:', missingB.length)

const resolved = layoutLinks(rawLinks, byId)
console.log('resolved links (survive layoutLinks):', resolved.length)

// Now instrument drawField's canvas context and see whether any link strokes.
const ops = { quadraticCurveTo: 0, strokes: 0, strokesBeforeLinks: 0, fills: 0 }
const grad = { addColorStop() {} }
const ctx = new Proxy({}, {
  get(_, prop) {
    if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad
    if (prop === 'measureText') return () => ({ width: 20 })
    if (prop === 'canvas') return { width: 900, height: 400 }
    if (typeof prop === 'string' && ['fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign', 'textBaseline', 'globalAlpha', 'lineCap'].includes(prop)) return ''
    return (...args) => {
      if (prop === 'quadraticCurveTo') ops.quadraticCurveTo++
      if (prop === 'stroke') ops.strokes++
      if (prop === 'fill') ops.fills++
    }
  },
  set() { return true }
})

drawField(ctx, 900, 400, points, 1200, null, resolved)
console.log('')
console.log('drawField ops:', JSON.stringify(ops))
console.log('=> quadraticCurveTo > 0 means link curves were emitted')
