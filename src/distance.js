/**
 * Goal-distance scoring for dsh-goal-ledger.
 *
 * Cosine distance between a goal's objective vector and each turn's output
 * vector. Distance is a *ranking* signal, not a verdict — see README for the
 * two failure modes observed on real data ("similar words, wrong answer" and
 * "long technical tasks drift naturally").
 *
 * The endpoint is configurable (see embed-config.js); the defaults reuse the
 * Volcengine Ark coding-plan credential the user already has. Two provider
 * limits are absorbed here: at most 10 texts per request, and large batches
 * intermittently truncate on this machine (retry + halve).
 */

import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_KEY_ENV,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH
} from './embed-config.js'

export { DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_KEY_ENV, MAX_BATCH }

/** Read `refs:` scalar entries out of DSH's credentials file. */
export function readCredentialRefs(yamlText) {
  const out = {}
  for (const line of String(yamlText ?? '').split('\n')) {
    if (!line.startsWith('  ') || !line.includes(':')) continue
    const idx = line.indexOf(':')
    const name = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if (!name) continue
    if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
      value = value.slice(1, -1)
    }
    // Only flat scalars matter; account blobs are JSON and are skipped.
    if (value && !value.startsWith('{') && value.length < 200) out[name] = value
  }
  return out
}

function cosineDistance(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na <= 0 || nb <= 0) return 1
  const sim = dot / Math.sqrt(na * nb)
  return Math.max(0, Math.min(2, 1 - sim))
}

export { cosineDistance }

/**
 * Goal-to-goal links: the point-to-point edges the chart is missing today.
 *
 * Every goal already has a vector — its objective was embedded in the same
 * scoring pass as its turns — but the chart only ever draws goal -> turn rays,
 * so every goal connects to its own centre and nothing else. That hides the one
 * pattern worth acting on: "similar failures cluster" (several goals drifting
 * the same way) and "successful paths are reusable" (goals that ended up doing
 * nearly the same thing). Both are goal-to-goal questions, and both can be
 * answered from vectors that are already in memory, i.e. at zero extra API
 * cost. This builds those edges offline: pure function, no I/O, no embeddings.
 *
 * Pairs are undirected and deduped by unordered pair. Selection is seeded as
 * the union of each node's nearest surviving pairs — so a pair that is in goal
 * i's top-k but not goal j's is still kept — and then a deterministic hard cap
 * trims any node left above `maxDegree` down to its nearest neighbours. Without
 * that cap one dense hub turns the whole chart into a hairball; the cap is per
 * node, so `maxDegree: 0` means "no links at all". Where a hub's neighbours all
 * pick the hub but the hub already has `maxDegree` closer ones, the cap wins and
 * the farthest of those edges is dropped — a node never exceeds `maxDegree`.
 *
 * Deterministic by construction: distance ties inside a node's neighbourhood
 * break on node index, and the emitted list sorts by distance then `a` then `b`,
 * so two runs over the same input compare deep-equal. Inputs are never mutated.
 *
 * @param vectors  number[][] goal objective vectors, index-aligned with `ids`;
 *                 null/undefined/empty entries are skipped, not errors
 * @param ids      string[] goalIds, same length/order as `vectors`
 * @param options.maxDistance  cosine-distance ceiling; pairs strictly above it
 *                             are dropped, so exactly-at-ceiling is kept
 *                             (default 0.42)
 * @param options.maxDegree    per-node cap on kept links (default 3, 0 = off)
 * @returns {{a: string, b: string, distance: number}[]} ascending by distance,
 *          ties broken by `a` then `b`; a !== b; distances rounded to 4 dp
 */
export function buildGoalLinks(vectors, ids, { maxDistance = 0.42, maxDegree = 3 } = {}) {
  const n = Math.min(vectors?.length ?? 0, ids?.length ?? 0)
  if (n < 2) return []

  const cap = Number.isFinite(maxDegree) ? Math.max(0, Math.floor(maxDegree)) : 0
  if (cap === 0) return []
  const ceiling = Number.isFinite(maxDistance) ? maxDistance : 0.42
  const usable = v => Array.isArray(v) && v.length > 0

  // 1. Every unordered pair that survives the distance ceiling.
  const candidate = new Map()
  const byNode = new Map()
  for (let i = 0; i < n; i++) {
    if (!usable(vectors[i])) continue
    for (let j = i + 1; j < n; j++) {
      if (!usable(vectors[j])) continue
      const d = cosineDistance(vectors[i], vectors[j])
      if (d > ceiling) continue
      const key = i * n + j
      candidate.set(key, { i, j, d, key })
      if (!byNode.has(i)) byNode.set(i, [])
      if (!byNode.has(j)) byNode.set(j, [])
      byNode.get(i).push({ other: j, key, d })
      byNode.get(j).push({ other: i, key, d })
    }
  }
  if (!candidate.size) return []

  // 2. Seed with the union of each node's nearest pairs: a pair chosen by only
  //    one endpoint still counts (it is that endpoint's neighbour, not a vote).
  const kept = new Set()
  for (const list of byNode.values()) {
    list.sort((x, y) => x.d - y.d || x.other - y.other)
    for (let k = 0; k < list.length && k < cap; k++) kept.add(list[k].key)
  }

  // 3. Enforce the degree cap for real. The union in step 2 can push a node above
  //    `cap` because every neighbour also chose it, so walk the kept edges from
  //    farthest to nearest and drop any edge whose endpoint is still over cap.
  //    Removing never raises a degree, so one ordered pass bounds every node at
  //    `cap` without a fixed-point loop. Farthest goes first on purpose: keeping
  //    the strongest edges is the whole point of a similarity layer.
  const keptEdges = [...kept].map(key => candidate.get(key))
  keptEdges.sort((x, y) => y.d - x.d || y.i - x.i || y.j - x.j)
  const degree = new Map()
  for (const e of keptEdges) {
    degree.set(e.i, (degree.get(e.i) ?? 0) + 1)
    degree.set(e.j, (degree.get(e.j) ?? 0) + 1)
  }
  for (const e of keptEdges) {
    if ((degree.get(e.i) ?? 0) <= cap && (degree.get(e.j) ?? 0) <= cap) continue
    kept.delete(e.key)
    degree.set(e.i, degree.get(e.i) - 1)
    degree.set(e.j, degree.get(e.j) - 1)
  }

  // 4. Emit, sorted on the rounded value actually printed.
  const round = v => Math.round(v * 10000) / 10000
  const out = []
  for (const key of kept) {
    const { i, j, d } = candidate.get(key)
    out.push({ a: ids[i], b: ids[j], distance: round(d) })
  }
  out.sort((x, y) => x.distance - y.distance || cmpStr(x.a, y.a) || cmpStr(x.b, y.b))
  return out
}

/** Code-unit string compare: locale-independent, so ordering is reproducible. */
function cmpStr(a, b) {
  const x = String(a)
  const y = String(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/**
 * Embed a small set of texts with the configured endpoint.
 *
 * Exported for the live path: drift correction scores one turn at a time
 * between turns, and cannot wait for a full-batch analysis run.
 */
export async function embedTexts({ baseUrl = DEFAULT_BASE_URL, model = DEFAULT_MODEL, key, texts }) {
  if (!key) throw new Error('missing API key for embeddings')
  return embedBatch(baseUrl, key, model, texts.slice(0, MAX_BATCH))
}

/** What a turn actually delivered, and whether it is scorable at all. */
export function turnText(turn) {
  const text = (turn.assistant ?? []).join('\n').trim()
  if (!text) {
    const tools = (turn.tools ?? []).join(', ') || 'none'
    // A tool-only turn has no prose whose distance to the goal means anything;
    // scoring it produces noise that ranks as maximally drifted.
    return { text: `(tool-only turn: ${tools})`, scorable: false }
  }
  return { text: text.slice(0, 6000), scorable: true }
}

async function postJson(url, key, payload, { timeoutMs = 90000, retries = 3 } = {}) {
  const body = JSON.stringify(payload)
  let lastErr
  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body,
        signal: controller.signal
      })
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 400)
        // A 4xx is a request problem; retrying cannot fix it.
        const err = new Error(`HTTP ${res.status}: ${detail}`)
        err.permanent = true
        throw err
      }
      return await res.json()
    } catch (err) {
      lastErr = err
      if (err.permanent) throw err
      if (attempt + 1 < retries) await new Promise(r => setTimeout(r, 600 * (attempt + 1)))
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`network error after ${retries} tries: ${lastErr?.message ?? lastErr}`)
}

async function embedBatch(baseUrl, key, model, texts, options = {}) {
  const data = await postJson(
    `${baseUrl.replace(/\/$/, '')}/embeddings`,
    key,
    { model, input: texts },
    options
  )
  const rows = data.data ?? []
  if (rows.length !== texts.length) {
    throw new Error(`expected ${texts.length} embeddings, got ${rows.length}`)
  }
  // The API does not guarantee order; each row carries its own index.
  rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  return rows.map(r => r.embedding)
}

/**
 * Probe an endpoint with one short text: is the URL right, the key valid, the
 * model name accepted, and how many dimensions come back?
 *
 * The settings page calls this before running a full analysis, so a typo shows
 * up in seconds instead of after embedding hundreds of turns.
 */
export async function probeEmbedding({ baseUrl, model, key, timeoutMs = 20000 }) {
  if (!key) return { ok: false, error: '没有可用的 API key（检查 keyEnv 指向的环境变量或 credentials ref）' }
  const started = Date.now()
  try {
    const vecs = await embedBatch(
      baseUrl ?? DEFAULT_BASE_URL,
      key,
      model ?? DEFAULT_MODEL,
      ['connectivity probe'],
      { timeoutMs, retries: 1 }
    )
    const vector = vecs[0] ?? []
    return {
      ok: true,
      model: model ?? DEFAULT_MODEL,
      dim: vector.length,
      elapsedMs: Date.now() - started,
      sample: vector.slice(0, 4).map(v => Math.round(v * 1000) / 1000)
    }
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err), elapsedMs: Date.now() - started }
  }
}

/**
 * Embed and score every goal.
 *
 * @param items        goals from collectGoals()
 * @param options.key  API key
 * @param options.baseUrl / options.model / options.batchSize endpoint overrides
 * @param options.onProgress optional (done, total) callback
 */
export async function scoreGoals(items, options = {}) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    model = DEFAULT_MODEL,
    key,
    batchSize = DEFAULT_BATCH_SIZE,
    onProgress
  } = options
  if (!key) throw new Error('missing API key for embeddings')

  const work = []
  const scorable = new Map()
  for (let gi = 0; gi < items.length; gi++) {
    const goal = items[gi]
    work.push({ kind: 'goal', gi, ti: -1, text: (goal.objective ?? '').slice(0, 6000) || '(empty objective)' })
    const turns = goal.turns ?? []
    for (let ti = 0; ti < turns.length; ti++) {
      const { text, scorable: ok } = turnText(turns[ti])
      scorable.set(`${gi}:${ti}`, ok)
      if (ok) work.push({ kind: 'turn', gi, ti, text })
    }
  }

  const vectors = new Array(work.length)
  let dim = 0
  let batch = Math.max(1, Math.min(batchSize, MAX_BATCH))
  let start = 0
  while (start < work.length) {
    const chunk = work.slice(start, start + batch)
    try {
      const vecs = await embedBatch(baseUrl, key, model, chunk.map(c => c.text))
      for (let i = 0; i < vecs.length; i++) {
        vectors[start + i] = vecs[i]
        dim = vecs[i].length
      }
      start += chunk.length
      onProgress?.(start, work.length)
    } catch (err) {
      const msg = String(err?.message ?? err)
      // Absorb both the hard input cap and truncated reads by shrinking.
      const retryable = /limit exceeded/i.test(msg) || /network error/i.test(msg) || /aborted/i.test(msg)
      if (retryable && batch > 1) {
        batch = Math.max(1, Math.floor(batch / 2))
        await new Promise(r => setTimeout(r, 400))
        continue
      }
      throw new Error(`embedding failed at offset ${start}: ${msg}`)
    }
  }

  const goalIndex = new Map()
  work.forEach((w, i) => {
    if (w.kind === 'goal') goalIndex.set(w.gi, i)
  })
  const turnIndex = new Map()
  work.forEach((w, i) => {
    if (w.kind === 'turn') turnIndex.set(`${w.gi}:${w.ti}`, i)
  })

  // Goal objective vectors, in item order. These were embedded above as part of
  // the normal scoring work, so the link layer below costs no extra API calls.
  const goalVectors = []
  const goalIds = []
  for (let gi = 0; gi < items.length; gi++) {
    goalVectors.push(vectors[goalIndex.get(gi)])
    goalIds.push(items[gi].goalId)
  }

  const scored = []
  const worst = []
  for (let gi = 0; gi < items.length; gi++) {
    const goal = items[gi]
    const goalVec = vectors[goalIndex.get(gi)]
    const turnsOut = []
    for (let ti = 0; ti < (goal.turns ?? []).length; ti++) {
      const turn = goal.turns[ti]
      const base = {
        turn: ti,
        calls: turn.calls ?? 0,
        failed: turn.failed ?? 0,
        failureRate: turn.calls ? Math.round((turn.failed / turn.calls) * 1000) / 1000 : 0,
        started: turn.started,
        preview: turnText(turn).text.slice(0, 160).replace(/\n/g, ' ')
      }
      if (!scorable.get(`${gi}:${ti}`)) {
        turnsOut.push({ ...base, distance: null, scorable: false })
        continue
      }
      const vi = turnIndex.get(`${gi}:${ti}`)
      const dist = cosineDistance(goalVec, vectors[vi])
      const entry = { ...base, distance: Math.round(dist * 10000) / 10000, scorable: true }
      turnsOut.push(entry)
      worst.push({ goalId: goal.goalId, objective: (goal.objective ?? '').slice(0, 120), ...entry })
    }
    const dists = turnsOut.filter(t => t.distance !== null).map(t => t.distance)
    const mean = dists.length ? dists.reduce((a, b) => a + b, 0) / dists.length : 0
    scored.push({
      goalId: goal.goalId,
      objective: (goal.objective ?? '').slice(0, 400),
      source: goal.source,
      completed: goal.completed,
      cwd: goal.cwd,
      sessionId: goal.sessionId,
      // Timestamps for the chart's angle encoding. Both already exist upstream
      // (collectGoals / session-reader); absent values stay explicitly null so
      // the client can tell "no data" from "not provided by this version".
      createdAt: goal.createdAt ?? null,
      sessionStartedAt: goal.turns?.[0]?.started ?? null,
      turnCount: turnsOut.length,
      scorableTurns: dists.length,
      failedCalls: goal.failedCalls ?? 0,
      totalCalls: goal.totalCalls ?? 0,
      meanDistance: Math.round(mean * 10000) / 10000,
      maxDistance: dists.length ? Math.round(Math.max(...dists) * 10000) / 10000 : 0,
      turns: turnsOut
    })
  }

  worst.sort((a, b) => b.distance - a.distance)
  return {
    model,
    baseUrl,
    dim,
    goals: scored.length,
    turns: scored.reduce((s, g) => s + g.turnCount, 0),
    scorableTurns: scored.reduce((s, g) => s + g.scorableTurns, 0),
    items: scored,
    // Goal-to-goal edges from the vectors already computed above. Empty when
    // no goal is close enough to another — that is a real answer, not an error.
    links: buildGoalLinks(goalVectors, goalIds),
    // Echo the rules so the client and README cannot drift from the server.
    linkRules: { maxDistance: 0.42, maxDegree: 3 },
    worstTurns: worst.slice(0, 20)
  }
}
