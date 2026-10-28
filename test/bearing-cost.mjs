// Score every candidate bearing the way emptiestAngle does, and print the cost
// landscape. A bearing can be "collision-free" against value labels yet still
// land on a light's halo or crowd the chips against each other — the PNG showed
// exactly that, so the cost function needs to be inspected, not just the count.
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

const CHIP_W = 26
const CHIP_H = 12
const LABEL_W = 34
const LABEL_H = 11
const seamCentre = ((-Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
const seamHalf = ANGLE_SEAM / 2 + 0.30

const pointPos = points.map(p => ({
  x: cx + Math.cos(p.angle) * p.radius * maxR,
  y: cy + Math.sin(p.angle) * p.radius * maxR * 0.9
}))
const labelBoxes = points.filter(p => p.band === 'red').map(p => {
  const pos = { x: cx + Math.cos(p.angle) * p.radius * maxR, y: cy + Math.sin(p.angle) * p.radius * maxR * 0.9 }
  const off = p.size + 8
  return {
    x0: pos.x + off,
    x1: pos.x + off + LABEL_W,
    y0: pos.y - off * 0.55 - LABEL_H / 2,
    y1: pos.y - off * 0.55 + LABEL_H / 2
  }
})

const pointCost = (q, lx, ly) => {
  const dx = Math.max(0, Math.abs(q.x - lx) - CHIP_W)
  const dy = Math.max(0, Math.abs(q.y - ly) - CHIP_H)
  const d = Math.hypot(dx, dy)
  return d < 18 ? (18 - d) * (18 - d) : 0
}
const boxCost = (x0, y0, x1, y1, q) => {
  const dx = Math.max(0, Math.max(x0 - q.x1, q.x0 - x1))
  const dy = Math.max(0, Math.max(y0 - q.y1, q.y0 - y1))
  const d = Math.hypot(dx, dy)
  return d < 18 ? (18 - d) * (18 - d) : 0
}

const scored = []
for (let c = 0; c < 72; c++) {
  const a = (c / 72) * Math.PI * 2
  let delta = Math.abs(a - seamCentre)
  if (delta > Math.PI) delta = Math.PI * 2 - delta
  if (delta < seamHalf) continue
  let pts = 0
  let lbl = 0
  let edge = 0
  for (const b of BANDS) {
    const r = (b.at / R_MAX_DIST) * maxR
    const lx = cx + Math.cos(a) * r
    const ly = cy + Math.sin(a) * r * 0.9
    for (const q of pointPos) pts += pointCost(q, lx, ly)
    const x0 = lx - CHIP_W / 2
    const x1 = lx + CHIP_W / 2
    const y0 = ly - CHIP_H / 2
    const y1 = ly + CHIP_H / 2
    for (const q of labelBoxes) lbl += boxCost(x0, y0, x1, y1, q)
    if (lx < 30 || lx > cx * 2 - 30) edge += 400
  }
  scored.push({ a, deg: Math.round((a * 180) / Math.PI), pts, lbl, edge, total: pts + lbl + edge })
}
scored.sort((x, y) => x.total - y.total)

console.log('best 8 bearings (lower is better):')
for (const s of scored.slice(0, 8)) {
  console.log(`  ${String(s.deg).padStart(4)}deg  total=${s.total.toFixed(0).padStart(4)}  points=${s.pts.toFixed(0).padStart(4)}  labels=${s.lbl.toFixed(0).padStart(4)}  edge=${s.edge}`)
}
const chosen = emptiestAngle(points, cx, cy, maxR)
console.log('')
console.log('chosen by emptiestAngle:', Math.round((chosen * 180) / Math.PI) + 'deg')
console.log('bearings clear of ALL lights:', scored.filter(s => s.pts === 0).length, '/', scored.length)
console.log('bearings clear of lights AND labels:', scored.filter(s => s.pts === 0 && s.lbl === 0).length)
