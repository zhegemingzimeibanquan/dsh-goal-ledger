// Field layer behaviour: draw order, edge direction, edge budget, time brush.
//
// These are the five things a reader reported as wrong or missing, and none of
// them is reliably checkable by looking at a PNG: draw order needs the call
// sequence, direction needs the emitted geometry, the budget needs a dense
// input, and the brush needs the filter compared against the painted arc.
//
// Run: node test/field-layers.mjs
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
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
  'module.exports = { apply, inject, name, __test: { layoutPoints, layoutLinks, drawField, weakEdgeBudget, timeAtAngle, rangeContains, LINK_STRONG, LINK_WEAK } }'
)
new Function('window', 'document', 'navigator', 'require', instrumented)(
  { __ModuleLoader__: { load: (r) => { captured = r } } },
  { querySelector: () => null, createElement: () => ({ dataset: {}, style: {} }), head: { appendChild() {} } },
  {}, fakeRequire
)
const mod = captured.factory(fakeRequire)
const {
  layoutPoints, layoutLinks, drawField, weakEdgeBudget, timeAtAngle, rangeContains
} = mod.__test

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}

/** A recording canvas context: keeps every call in order. */
function recorder() {
  const calls = []
  const grad = { addColorStop() {} }
  const handler = {
    get(_, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad
      if (prop === 'measureText') return () => ({ width: 46 })
      if (prop === 'canvas') return { width: 900, height: 400 }
      if (prop === 'shadowColor' || prop === 'shadowBlur') return 0
      if (typeof prop === 'string' && [
        'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign',
        'textBaseline', 'globalAlpha', 'lineCap'
      ].includes(prop)) return ''
      return (...args) => { calls.push({ fn: prop, args }) }
    },
    set(_, prop, v) { calls.push({ fn: 'set:' + String(prop), args: [v] }); return true }
  }
  return { ctx: new Proxy({}, handler), calls }
}

const snapshotPath = join(
  process.env.DSH_HOME || join(process.env.USERPROFILE, '.dsh'),
  'dsh-goal-ledger', 'snapshot.json'
)
const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'))
const points = layoutPoints(snapshot.distance?.items ?? [])
const pointById = new Map(points.map(p => [p.id, p]))
const links = layoutLinks(snapshot.distance?.links ?? [], pointById)
console.log(`fixture: ${points.length} points, ${links.length} links\n`)

// --- 1. draw order: chips must come after every link ------------------------
{
  const { ctx, calls } = recorder()
  drawField(ctx, 900, 400, points, 0, null, links, null)

  // Chips are the only thing drawn with a shadow, so their plate marks the spot.
  const chipAt = calls.findIndex(c => c.fn === 'set:shadowColor')
  const lastLinkAt = calls.reduce(
    (acc, c, i) => (c.fn === 'quadraticCurveTo' ? i : acc), -1)
  check('ring chips are painted after the last link', chipAt > lastLinkAt,
    `first chip at ${chipAt}, last link curve at ${lastLinkAt}`)
  check('at least one link was drawn', lastLinkAt > 0, `last curve at ${lastLinkAt}`)
}

// --- 2. direction: arrows exist, and point at the newer end -----------------
{
  const { ctx, calls } = recorder()
  drawField(ctx, 900, 400, points, 0, null, links, null)
  const triangles = calls.filter(c => c.fn === 'closePath').length
  check('arrowheads are emitted', triangles > 0, `${triangles} arrow(s)`)

  const timed = links.filter(l => l.timed)
  // A pair whose two sessions started at the same instant has no knowable
  // direction, so it is deliberately NOT timed and gets no arrow. The expected
  // count is therefore "both ends timed AND the times differ", not "all links".
  const expectTimed = links.filter(l => {
    const fa = pointById.get(l.a)
    const fb = pointById.get(l.b)
    return typeof fa?.startedAt === 'number' && typeof fb?.startedAt === 'number'
      && fa.startedAt !== fb.startedAt
  })
  check('timed flag marks exactly the pairs with a knowable direction',
    timed.length === expectTimed.length,
    `${timed.length} timed, ${expectTimed.length} expected (of ${links.length})`)
  check('same-instant pairs carry no arrow', timed.every(l => {
    const fa = pointById.get(l.a)
    const fb = pointById.get(l.b)
    return fa.startedAt !== fb.startedAt
  }))

  // Direction must match the timestamps, whichever way the pair was stored.
  const wrong = timed.filter(l => {
    const from = pointById.get(l.from)
    const to = pointById.get(l.to)
    return !(from.startedAt <= to.startedAt)
  })
  check('from is never newer than to', wrong.length === 0,
    wrong.length ? JSON.stringify(wrong.slice(0, 2).map(l => [l.a, l.b])) : `${timed.length} checked`)

  // Both storage orders must produce the same direction for the same pair.
  const one = timed[0]
  if (one) {
    const flipped = layoutLinks([{ a: one.b, b: one.a, distance: one.distance }], pointById)
    check('reversed storage yields the same from/to',
      flipped.length === 1 && flipped[0].from === one.from && flipped[0].to === one.to,
      flipped[0] ? `${flipped[0].from === one.from ? 'same' : 'DIFFERENT'}` : 'no link')
  }
}

// --- 3. budget: dense input hides weak edges, hover reveals them ------------
{
  const budget = weakEdgeBudget(900, 400)
  check('budget scales with canvas area', weakEdgeBudget(1800, 800) > budget,
    `900x400 -> ${budget}, 1800x800 -> ${weakEdgeBudget(1800, 800)}`)

  // A synthetic dense field: many nodes, all weakly linked.
  const ids = Array.from({ length: 120 }, (_, i) => 'g' + i)
  const densePoints = ids.map((id, i) => ({
    id,
    objective: 'o' + i,
    distance: 0.3,
    turns: 2,
    calls: 2,
    failed: 0,
    band: 'green',
    startedAt: 1000 + i,
    angle: (i / ids.length) * Math.PI * 2,
    radius: 0.5,
    size: 3
  }))
  const denseById = new Map(densePoints.map(p => [p.id, p]))
  const denseLinks = []
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length && j < i + 4; j++) {
      denseLinks.push({ a: ids[i], b: ids[j], distance: 0.3 + (j - i) * 0.01 })
    }
  }
  const resolved = layoutLinks(denseLinks, denseById)

  const plain = recorder()
  drawField(plain.ctx, 900, 400, densePoints, 0, null, resolved, null)
  const drawnPlain = plain.calls.filter(c => c.fn === 'quadraticCurveTo').length

  check('dense field draws fewer edges than it has', drawnPlain < resolved.length,
    `${drawnPlain} drawn of ${resolved.length}`)
  check('drawn count respects the budget plus strong edges',
    drawnPlain <= budget + resolved.filter(l => l.strong).length,
    `${drawnPlain} <= ${budget} + ${resolved.filter(l => l.strong).length}`)

  const hovered = recorder()
  const target = densePoints[0].id
  drawField(hovered.ctx, 900, 400, densePoints, 0, target, resolved, null)
  const drawnHover = hovered.calls.filter(c => c.fn === 'quadraticCurveTo').length
  const touchTarget = resolved.filter(l => l.a === target || l.b === target).length
  check('hovering a node draws all of its edges', drawnHover >= touchTarget,
    `${drawnHover} drawn, ${touchTarget} touch the hovered node`)
}

// --- 4. time brush: painted arc equals the filtered set --------------------
{
  const timed = points.filter(p => typeof p.startedAt === 'number')
  check('fixture has timed points', timed.length > 0, `${timed.length}`)

  const sorted = [...timed].sort((a, b) => a.startedAt - b.startedAt)
  const a0 = sorted[0].angle
  const a1 = sorted[Math.floor(sorted.length / 2)].angle
  const t0 = timeAtAngle(points, a0)
  const t1 = timeAtAngle(points, a1)
  check('timeAtAngle recovers the endpoints',
    t0 === sorted[0].startedAt && t1 === sorted[Math.floor(sorted.length / 2)].startedAt,
    `${t0} -> ${t1}`)

  const range = { from: a0, to: a1, t0, t1 }
  const inside = points.filter(p => rangeContains(range, p))
  const brightByAngle = points.filter(p => {
    const lo = Math.min(a0, a1)
    const hi = Math.max(a0, a1)
    return p.angle >= lo && p.angle <= hi
  })
  check('rangeContains agrees with the painted arc',
    inside.length === brightByAngle.length,
    `${inside.length} filtered vs ${brightByAngle.length} inside the arc`)

  const untimed = { id: 'x', startedAt: null }
  check('an untimed point is outside a resolved range', !rangeContains(range, untimed))
  // Unresolved bounds mean "no window", so nothing is excluded — this is the
  // case a field with no time axis would hit, and dimming everything there
  // would punish a drag that cannot mean anything.
  check('unresolved bounds exclude nothing',
    rangeContains({ from: 0, to: 1 }, { id: 'y', startedAt: 123 }))
  check('untimed point survives unresolved bounds',
    rangeContains({ from: 0, to: 1 }, untimed))

  // Dimming, not removal: every point must still be drawn.
  const { ctx, calls } = recorder()
  drawField(ctx, 900, 400, points, 0, null, links, range)
  const arcs = calls.filter(c => c.fn === 'arc').length
  const { ctx: ctx2, calls: calls2 } = recorder()
  drawField(ctx2, 900, 400, points, 0, null, links, null)
  check('brushing does not remove points from the canvas',
    arcs >= calls2.filter(c => c.fn === 'arc').length,
    `${arcs} arcs with range vs ${calls2.filter(c => c.fn === 'arc').length} without`)
}

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)