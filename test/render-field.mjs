// Render the drift field to a PNG for visual inspection.
//
// jsdom cannot rasterize canvas, so this uses the real @napi-rs/canvas when it
// is installed; otherwise it still prints the layout (radius/angle/band per
// goal) so the geometry can be checked numerically.
//
// Run: npm install --no-save @napi-rs/canvas && node test/render-field.mjs
import { readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const src = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

// Evaluate the bundle in a sandbox that stubs React, then reach the field
// helpers through the __test seam the instrumented copy adds.
const documentStub = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {} }),
  head: { appendChild() {} }
}
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
const loader = { load(record) { captured = record } }
const fakeRequire = (id) => {
  if (id === 'react') return ReactStub
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  if (id === 'react-dom') return {}
  throw new Error('unexpected require: ' + id)
}

const instrumented = src.replace(
  'module.exports = { apply, inject, name }',
  'module.exports = { apply, inject, name, __test: { layoutPoints, drawField, bandOf: band, BAND_COLORS, hash01 } }'
)
new Function('window', 'document', 'navigator', 'require', instrumented)(
  { __ModuleLoader__: loader }, documentStub, {}, fakeRequire
)
const mod = captured.factory(fakeRequire)
const { layoutPoints, drawField } = mod.__test

const snapshotPath = process.env.SNAPSHOT
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-goal-ledger', 'snapshot.json')
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const items = snapshot.distance?.items ?? []
const points = layoutPoints(items)

console.log('snapshot:', snapshotPath)
console.log('goals:', points.length)
if (points.length) {
  const dists = points.map(p => p.distance)
  const radii = points.map(p => p.radius)
  console.log('distance range:', Math.min(...dists).toFixed(3), 'to', Math.max(...dists).toFixed(3))
  console.log('radius range:', Math.min(...radii).toFixed(3), 'to', Math.max(...radii).toFixed(3))
  const bands = {}
  for (const p of points) bands[p.band] = (bands[p.band] ?? 0) + 1
  console.log('band distribution:', JSON.stringify(bands))
  console.log('sample:')
  for (const p of points.slice(0, 5)) {
    console.log(`  r=${p.radius.toFixed(2)} theta=${(p.angle % (Math.PI * 2)).toFixed(2)} `
      + `${p.band.padEnd(6)} ${p.distance.toFixed(3)} ${p.objective.slice(0, 40).replace(/\n/g, ' ')}`)
  }
}

let canvas
try {
  canvas = require('@napi-rs/canvas')
} catch {
  console.log('\n(@napi-rs/canvas not installed - skipping PNG render)')
  console.log('install it with: npm install --no-save @napi-rs/canvas')
  process.exit(0)
}

const { createCanvas } = canvas
const W = 900
const H = 380
const c = createCanvas(W, H)
const g = c.getContext('2d')
const projected = drawField(g, W, H, points, 1200, null)
const out = process.env.OUT ?? join(here, '..', 'drift-field.png')
await writeFile(out, c.toBuffer('image/png'))
console.log(`\nwrote ${out} (${projected.length} points)`)
