// Goal-to-goal links: the helper that turns already-computed goal vectors into
// the point-to-point edges the chart draws. Guards the contract the client and
// README depend on: distance ceiling is strict-greater, the degree cap is a real
// per-node bound (union-of-top-k alone would let a hub exceed it), output order
// is deterministic, and missing vectors degrade to "no link" instead of a throw.
//
// Fully offline: hand-built vectors, no embeddings call, no DSH instance.
//
// Run: node test/links.mjs
import { buildGoalLinks, cosineDistance } from '../src/distance.js'

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}

// Unit vector at `deg` degrees in the plane, so cosineDistance is 1 - cos(deg).
const at = (deg) => {
  const r = (deg * Math.PI) / 180
  return [Math.cos(r), Math.sin(r)]
}
const ids = (n, p = 'g') => Array.from({ length: n }, (_, i) => `${p}${i}`)
const degreeOf = (links, id) => links.filter(l => l.a === id || l.b === id).length
const unordered = (l) => [l.a, l.b].sort().join('|')

// --- 1. distance ceiling: strictly-greater drops, equal stays ---------------
{
  // 45 deg -> d = 1 - cos45 = 0.2929; 75 deg -> d = 1 - cos75 = 0.7412.
  const near = buildGoalLinks([at(0), at(45)], ['n0', 'n1'], { maxDistance: 0.42, maxDegree: 3 })
  const far = buildGoalLinks([at(0), at(75)], ['f0', 'f1'], { maxDistance: 0.42, maxDegree: 3 })
  check('pair within maxDistance is kept', near.length === 1 && near[0].distance === 0.2929,
    `d=${near[0]?.distance}`)
  check('pair beyond maxDistance is dropped', far.length === 0, `${far.length} link(s)`)

  // The boundary itself: pass the exact raw distance as the ceiling. It must be
  // kept (the test is `d > ceiling`, not `>=`), and one ulp below must drop it.
  const raw = cosineDistance(at(0), at(30))
  const exact = buildGoalLinks([at(0), at(30)], ['e0', 'e1'], { maxDistance: raw, maxDegree: 3 })
  const below = buildGoalLinks([at(0), at(30)], ['e0', 'e1'], { maxDistance: raw - 1e-9, maxDegree: 3 })
  check('distance == maxDistance is kept', exact.length === 1, `raw=${raw}`)
  check('distance slightly > maxDistance is dropped', below.length === 0, `ceiling=${raw - 1e-9}`)
  check('reported distance is rounded to 4 dp',
    Number.isInteger(Math.round(exact[0].distance * 10000))
    && String(exact[0].distance).replace(/^[^.]*\.?/, '').length <= 4,
    String(exact[0].distance))
}

// --- 2. degree cap: a hub cannot exceed maxDegree ---------------------------
{
  // Hub along the first axis; five leaves each sit at 45 deg to the hub
  // (d = 0.2929, all under the ceiling) and are deliberately orthogonal to one
  // another in their own axis, so every leaf-leaf pair is d = 0.5 and drops out.
  // Every surviving edge therefore touches the hub. A pure union-of-top-k would
  // keep all five; the per-node cap must trim the hub to `maxDegree`.
  const c = 0.7071067811865476
  const vectors = [
    [1, 0, 0, 0, 0, 0],
    [c, c, 0, 0, 0, 0],
    [c, 0, c, 0, 0, 0],
    [c, 0, 0, c, 0, 0],
    [c, 0, 0, 0, c, 0],
    [c, 0, 0, 0, 0, c]
  ]
  const goalIds = ids(vectors.length)
  const links = buildGoalLinks(vectors, goalIds, { maxDistance: 0.42, maxDegree: 3 })
  check('hub capped at maxDegree', degreeOf(links, 'g0') <= 3, `degree=${degreeOf(links, 'g0')}`)
  check('hub keeps exactly maxDegree when five are closer',
    degreeOf(links, 'g0') === 3 && links.length === 3, `links=${links.length}`)
  check('no leaf exceeds maxDegree',
    links.every(l => degreeOf(links, l.a) <= 3 && degreeOf(links, l.b) <= 3),
    JSON.stringify(links.map(l => [l.a, l.b])))
  check('leaf-leaf pairs stay unlinked at this spread',
    links.every(l => l.a === 'g0' || l.b === 'g0'), JSON.stringify(links.map(l => [l.a, l.b])))

  // Lifting the cap recovers the whole star, proving the trim was the cap and
  // not the distance ceiling silently eating edges.
  const wide = buildGoalLinks(vectors, goalIds, { maxDistance: 0.42, maxDegree: 10 })
  check('larger maxDegree keeps the whole star',
    wide.length === 5 && degreeOf(wide, 'g0') === 5,
    `${links.length} -> ${wide.length}, degree ${degreeOf(wide, 'g0')}`)

  // maxDegree 1: every node ends up with at most one edge.
  const single = buildGoalLinks(vectors, goalIds, { maxDistance: 0.42, maxDegree: 1 })
  check('maxDegree 1 keeps at most one edge per node',
    single.length >= 1 && goalIds.every(id => degreeOf(single, id) <= 1),
    `${single.length} link(s)`)
}

// --- 3. ascending order by distance, ties broken by a then b ----------------
{
  // g0-g1 10 deg (0.0152), g0-g2 40 deg (0.2340), g1-g2 30 deg (0.1340).
  const links = buildGoalLinks([at(0), at(10), at(40)], ids(3), { maxDistance: 0.42, maxDegree: 3 })
  check('three close goals yield three links', links.length === 3, `${links.length}`)
  const dists = links.map(l => l.distance)
  check('links sorted ascending by distance',
    dists.every((d, i) => i === 0 || d >= dists[i - 1]), JSON.stringify(dists))
  check('nearest pair is first', links[0].a === 'g0' && links[0].b === 'g1', JSON.stringify(links[0]))

  // Symmetric pair around g0: equal distances must order by a then b.
  const tied = buildGoalLinks([at(0), at(10), at(-10)], ids(3), { maxDistance: 0.42, maxDegree: 3 })
  const near = tied.filter(l => l.distance < 0.05)
  check('distance ties ordered by a then b',
    near.length === 2 && near[0].a === 'g0' && near[0].b === 'g1'
    && near[1].a === 'g0' && near[1].b === 'g2',
    JSON.stringify(near.map(l => [l.a, l.b])))

  // Exact duplicate distances across different nodes, also index-tie-broken.
  const same = buildGoalLinks([[1, 0], [1, 0], [1, 0]], ids(3), { maxDistance: 0.42, maxDegree: 3 })
  check('identical vectors are all linked at distance 0',
    same.length === 3 && same.every(l => l.distance === 0), `${same.length}`)
  check('identical-vector ties still deterministic by a then b',
    same.map(l => l.a + l.b).join(',') === 'g0g1,g0g2,g1g2', same.map(l => l.a + l.b).join(','))
}

// --- 4. no self pairs, no duplicate unordered pairs -------------------------
{
  const vectors = [at(0), at(5), at(9), at(14), at(20), at(26), at(33)]
  const links = buildGoalLinks(vectors, ids(vectors.length), { maxDistance: 0.42, maxDegree: 3 })
  check('no self pairs', links.every(l => l.a !== l.b), JSON.stringify(links.map(l => [l.a, l.b])))
  const keys = new Set(links.map(unordered))
  check('no duplicate unordered pairs', keys.size === links.length,
    `${links.length} links / ${keys.size} unique`)
  check('every id is one of the inputs', links.every(l => ids(vectors.length).includes(l.a) && ids(vectors.length).includes(l.b)))
  check('links present for a dense neighbourhood', links.length > 0, `${links.length} link(s)`)
  check('degree cap holds across the whole graph',
    links.every(l => degreeOf(links, l.a) <= 3 && degreeOf(links, l.b) <= 3), `${links.length} link(s)`)
}

// --- 5. missing / null / empty vectors are skipped, never thrown ------------
{
  const vectors = [[1, 0], null, [1, 0], undefined, [], [1, 0]]
  let links = null
  let threw = null
  try {
    links = buildGoalLinks(vectors, ['a', 'b', 'c', 'd', 'e', 'f'])
  } catch (err) {
    threw = String(err?.message ?? err)
  }
  check('null/undefined/empty vectors do not throw', threw === null, threw ?? 'no throw')
  check('missing vectors produce no links to their ids',
    links !== null && links.every(l => !['b', 'd', 'e'].includes(l.a) && !['b', 'd', 'e'].includes(l.b)),
    JSON.stringify(links))
  check('valid pair among the surviving vectors is still linked',
    links !== null && links.length === 3 && links.every(l => ['a', 'c', 'f'].includes(l.a) && ['a', 'c', 'f'].includes(l.b)),
    `${links?.length} link(s)`)
  check('missing-vector case yields identical distances',
    links !== null && links.every(l => l.distance === 0), JSON.stringify(links))

  // Ragged tail: a vector array shorter than ids is tolerated, not a crash.
  const short = buildGoalLinks([[1, 0], [1, 0]], ['a', 'b', 'c'])
  check('vectors shorter than ids is tolerated', short.length === 1 && short[0].b === 'b', JSON.stringify(short))
  check('n < 2 returns empty', buildGoalLinks([[1, 0]], ['only']).length === 0
    && buildGoalLinks([], []).length === 0)
}

// --- 6. determinism and input immutability ---------------------------------
{
  const vectors = [at(0), at(7), at(15), at(22), at(31), at(44), at(52), at(60), at(70), at(80)]
  const goalIds = ids(vectors.length)
  const snapshotVectors = JSON.stringify(vectors)
  const snapshotIds = JSON.stringify(goalIds)
  const first = buildGoalLinks(vectors, goalIds)
  const second = buildGoalLinks(vectors, goalIds)
  check('two calls return deep-equal output',
    JSON.stringify(first) === JSON.stringify(second), `${first.length} link(s)`)
  check('inputs are not mutated',
    JSON.stringify(vectors) === snapshotVectors && JSON.stringify(goalIds) === snapshotIds)
  check('options object is not mutated', (() => {
    const opts = { maxDistance: 0.42, maxDegree: 2 }
    const before = JSON.stringify(opts)
    buildGoalLinks(vectors, goalIds, opts)
    return JSON.stringify(opts) === before
  })())
}

// --- 7. edge settings: maxDegree 0 and maxDistance 0 -----------------------
{
  const vectors = [[1, 0], [1, 0], [0, 1]]
  const noDegree = buildGoalLinks(vectors, ids(3), { maxDegree: 0 })
  check('maxDegree 0 returns no links', noDegree.length === 0, `${noDegree.length}`)

  const noDistance = buildGoalLinks(vectors, ids(3), { maxDistance: 0 })
  check('maxDistance 0 keeps only identical vectors',
    noDistance.length === 1 && noDistance[0].distance === 0
    && unordered(noDistance[0]) === 'g0|g1', JSON.stringify(noDistance))
  check('maxDistance 0 drops orthogonal pair (d=1)', noDistance.every(l => !l.a.includes('2') && !l.b.includes('2')))

  const negative = buildGoalLinks(vectors, ids(3), { maxDegree: -1 })
  check('negative maxDegree clamps to no links', negative.length === 0, `${negative.length}`)
  const fractional = buildGoalLinks([at(0), at(5), at(10)], ids(3), { maxDegree: 1.9 })
  check('fractional maxDegree floors to 1', fractional.length === 1
    && degreeOf(fractional, 'g0') <= 1, `${fractional.length} link(s)`)
}

// --- 8. synthetic 28-node graph: real-world shape, still bounded -----------
{
  // Golden-angle sphere points: a plausible spread of 28 goal objectives.
  const vectors = []
  for (let i = 0; i < 28; i++) {
    const z = 1 - (2 * (i + 0.5)) / 28
    const r = Math.sqrt(1 - z * z)
    const phi = i * 2.399963229728653
    vectors.push([r * Math.cos(phi), r * Math.sin(phi), z])
  }
  const goalIds = ids(28)
  const links = buildGoalLinks(vectors, goalIds)
  const maxDeg = Math.max(0, ...goalIds.map(id => degreeOf(links, id)))
  console.log(`\n28-node synthetic: ${links.length} links, max degree ${maxDeg}, `
    + `nearest ${links[0]?.distance}, farthest ${links[links.length - 1]?.distance}`)
  check('28-node graph stays within the 3n/2 edge ceiling', links.length <= 42, `${links.length} links`)
  check('28-node graph respects maxDegree 3', maxDeg <= 3, `max degree ${maxDeg}`)
  check('28-node graph is sorted', links.every((l, i) => i === 0 || l.distance >= links[i - 1].distance))
  check('28-node graph has no duplicate pairs',
    new Set(links.map(unordered)).size === links.length)
  check('dense 28-node sphere still yields links', links.length >= 20, `${links.length} link(s)`)
}

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
