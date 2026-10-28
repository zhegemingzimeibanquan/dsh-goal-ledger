// Ring-chip placement regression: no chip overlaps a value label or another
// chip, on real snapshot data, under the per-ring placement scheme.
//
// Run: node test/label-collisions.mjs
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const src = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

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
  'module.exports = { apply, inject, name, __test: { layoutPoints, BANDS, R_MAX_DIST, ANGLE_SEAM, emptiestAngle } }'
)
new Function('window', 'document', 'navigator', 'require', instrumented)(
  { __ModuleLoader__: { load: (r) => { captured = r } } },
  { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
  {}, fakeRequire
)
const mod = captured.factory(fakeRequire)
const { layoutPoints, BANDS, R_MAX_DIST, ANGLE_SEAM, emptiestAngle } = mod.__test

const snapshotPath = process.env.SNAPSHOT
  ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-goal-ledger', 'snapshot.json')
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const points = layoutPoints(snapshot.distance?.items ?? [])

const W = 900
const H = 400
const cx = W / 2
const cy = H / 2
const maxR = Math.min(W * 0.42, H * 0.46)

const CHIP_W = 46
const CHIP_H = 13
const LABEL_W = 34
const LABEL_H = 11

const pointPos = points.map(p => ({
  x: cx + Math.cos(p.angle) * p.radius * maxR,
  y: cy + Math.sin(p.angle) * p.radius * maxR * 0.9
}))
const labelBoxes = points.filter(p => p.band === 'red').map(p => {
  const pos = { x: cx + Math.cos(p.angle) * p.radius * maxR, y: cy + Math.sin(p.angle) * p.radius * maxR * 0.9 }
  const off = p.size + 8
  return { x0: pos.x + off, x1: pos.x + off + LABEL_W, y0: pos.y - off * 0.55 - LABEL_H / 2, y1: pos.y - off * 0.55 + LABEL_H / 2 }
})

const overlaps = (ax0, ay0, ax1, ay1, bx0, by0, bx1, by1) =>
  ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1

// Replicate the per-ring placement exactly as drawField() now does.
const chips = []
let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  鈥?' + detail : ''}`)
  if (!ok) failed = true
}

const labelsHit = []
const chipChip = []
for (const b of BANDS) {
  const r = (b.at / R_MAX_DIST) * maxR
  const bearing = emptiestAngle(points, cx, cy, maxR, r, chips)
  const lx = cx + Math.cos(bearing) * r
  const ly = cy + Math.sin(bearing) * r * 0.9
  const box = { x0: lx - CHIP_W / 2, x1: lx + CHIP_W / 2, y0: ly - CHIP_H / 2, y1: ly + CHIP_H / 2 }

  for (const lab of labelBoxes) {
    if (overlaps(box.x0, box.y0, box.x1, box.y1, lab.x0, lab.y0, lab.x1, lab.y1)) {
      labelsHit.push({ band: b.key, label: lab, bearing: Math.round(bearing * 180 / Math.PI) })
    }
  }
  for (const prev of chips) {
    if (overlaps(box.x0, box.y0, box.x1, box.y1, prev.x0, prev.y0, prev.x1, prev.y1)) {
      chipChip.push({ band: b.key, with: prev.band, bearing: Math.round(bearing * 180 / Math.PI) })
    }
  }
  chips.push({ ...box, band: b.key, bearing })
}

console.log(`goals=${points.length} chips=${chips.length} labels=${labelBoxes.length}`)
console.log('chip bearings:', chips.map(c => `${c.band}@${Math.round(Math.atan2(c.y1 - cy, c.x0 - cx) * 180 / Math.PI)}deg`).join(' '))
check('no chip overlaps a value label', labelsHit.length === 0,
  labelsHit.length ? JSON.stringify(labelsHit.map(l => [l.band, l.bearing])) : '0 collisions')
check('no chip overlaps another chip', chipChip.length === 0,
  chipChip.length ? JSON.stringify(chipChip) : '0 collisions')
check('chips are on distinct bearings', new Set(chips.map(c => Math.round(c.bearing * 100))).size === chips.length,
  'distinct')

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
