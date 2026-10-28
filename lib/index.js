/**
 * dsh-goal-ledger — host half.
 *
 * Exposes an analysis API over HTTP so the client panel can render results:
 *
 *   GET  /dsh-goal-ledger-7821/status      cached snapshot + metadata + config
 *   GET  /dsh-goal-ledger-7821/config      resolved embedding config (+ presets)
 *   PUT  /dsh-goal-ledger-7821/config      { baseUrl?, model?, keyEnv?, batchSize?, enabled? }
 *   POST /dsh-goal-ledger-7821/probe       probe the endpoint with one short text
 *   POST /dsh-goal-ledger-7821/analyze     { cwdFilter?, limit?, embed? } → snapshot
 *   GET  /dsh-goal-ledger-7821/clusters    failure clusters only (no embedding needed)
 *   GET  /dsh-goal-ledger-7821/correction  per-session drift-correction state
 *   PUT  /dsh-goal-ledger-7821/correction  { enabled?, threshold?, minStreak?, ... }
 *
 * The host never writes to session logs: this plugin is an auditor. The only
 * files it writes are its own config and snapshot cache under $DSH_HOME.
 *
 * Drift correction (opt-in, per session) contributes one system-prompt section
 * while drift is sustained. It never mutates the goal: see src/correction.js.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'

import { collectGoals } from '../src/session-reader.js'
import { clusterFailures } from '../src/failure-cluster.js'
import { scoreGoals, probeEmbedding, readCredentialRefs, embedTexts } from '../src/distance.js'
import {
  DEFAULT_CONFIG,
  MAX_BATCH,
  PRESETS,
  applyConfigPatch,
  normalizeConfig
} from '../src/embed-config.js'
import {
  CorrectionTracker,
  DEFAULT_CORRECTION_CONFIG,
  LiveScorer,
  applyCorrectionPatch,
  buildCorrectionText
} from '../src/correction.js'

const name = 'dsh-goal-ledger'
/*
 * `webServer` serves the panel. The rest are optional drift-correction seams:
 * Cordis waits for every injected service before starting the plugin, so they
 * are NOT listed here — a headless composition without `systemPrompt` would
 * otherwise never start the panel either. Each use is guarded instead.
 */
const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-goal-ledger-7821'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = join(DSH_HOME, 'sessions')
const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')
const CACHE_DIR = join(DSH_HOME, 'dsh-goal-ledger')
const CACHE_FILE = join(CACHE_DIR, 'snapshot.json')
const CONFIG_FILE = join(CACHE_DIR, 'config.json')
const CORRECTION_FILE = join(CACHE_DIR, 'correction.json')

/** Section order: after tool docs, before the deployment persona suffix. */
const CORRECTION_SECTION_ORDER = 10050
const CORRECTION_SECTION_NAME = 'goal-ledger:drift-correction'

/** Last computed snapshot, served by /status without recomputing. */
let snapshot = null
let analyzing = false
/** Resolved embedding config, loaded once at apply() and updated by PUT /config. */
let config = { ...DEFAULT_CONFIG }
let configWarnings = []

/**
 * Drift-correction config and per-session tracker.
 *
 * `correctionConfig.enabled` is the master switch. When false the plugin
 * registers no prompt section at all, so a session behaves exactly as if the
 * plugin were not installed.
 */
let correctionConfig = { ...DEFAULT_CORRECTION_CONFIG }
const tracker = new CorrectionTracker()
/** sessionId → last text handed to the prompt, and the turn it was built for. */
const pendingCorrection = new Map()
/** sessionId → LiveScorer for the running session. */
const scorers = new Map()

/**
 * Where the correction wiring got to, for the panel's self-check.
 *
 * Filled in by apply(): whether `ctx.agents` existed when the plugin activated,
 * how many live agents it listed, and the last attach error if any. All fields
 * are diagnostic only — nothing branches on them.
 */
const wiring = { agentsService: false, listed: 0, attachErrors: [] }


function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-cache'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', c => {
      size += c.length
      // A config body is tiny; refuse anything that could be a mistake or abuse.
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/**
 * Resolve the embedding key: environment first, then DSH credentials.
 * The name of the variable comes from the config, so switching provider
 * switches which credential is looked up. The key is never logged or returned.
 */
async function resolveKey() {
  const envName = config.keyEnv
  const fromEnv = process.env[envName]
  if (fromEnv) return { key: fromEnv, source: 'env' }
  try {
    const yaml = await readFile(CREDENTIALS, 'utf8')
    const refs = readCredentialRefs(yaml)
    if (refs[envName]) return { key: refs[envName], source: 'credentials' }
  } catch {
    // No credentials file: embeddings stay unavailable, clustering still works.
  }
  return { key: null, source: 'missing' }
}

/** Read config.json if present; a broken or absent file means defaults. */
async function loadConfig() {
  try {
    const raw = JSON.parse(await readFile(CONFIG_FILE, 'utf8'))
    const { config: next, warnings } = normalizeConfig(raw)
    config = next
    configWarnings = warnings
  } catch {
    config = { ...DEFAULT_CONFIG }
    configWarnings = []
  }
}

async function saveConfig(next) {
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

/** Read correction.json if present; absent or broken means "off". */
async function loadCorrectionConfig() {
  try {
    const raw = JSON.parse(await readFile(CORRECTION_FILE, 'utf8'))
    const { config: next } = applyCorrectionPatch(DEFAULT_CORRECTION_CONFIG, raw)
    correctionConfig = next
  } catch {
    correctionConfig = { ...DEFAULT_CORRECTION_CONFIG }
  }
}

async function saveCorrectionConfig(next) {
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(CORRECTION_FILE, JSON.stringify(next, null, 2) + '\n', 'utf8')
}

async function loadCache() {
  try {
    snapshot = JSON.parse(await readFile(CACHE_FILE, 'utf8'))
  } catch {
    snapshot = null
  }
}

async function saveCache(value) {
  try {
    await mkdir(CACHE_DIR, { recursive: true })
    await writeFile(CACHE_FILE, JSON.stringify(value), 'utf8')
  } catch (err) {
    console.warn('[dsh-goal-ledger] cache write failed: ' + (err?.message ?? err))
  }
}

/**
 * Run the full analysis.
 *
 * Failure clustering is always computed (it needs no network). Embedding-based
 * distance is optional: without a key the snapshot reports `distanceAvailable:
 * false` rather than failing the whole request.
 */
async function analyze(options = {}) {
  const { cwdFilter, limit = 0, embed = true } = options
  const started = Date.now()

  const collected = await collectGoals(SESSIONS_DIR, { cwdFilter, limit })
  const clustering = clusterFailures(collected.items)

  const totals = {
    goals: collected.items.length,
    turns: collected.items.reduce((s, g) => s + g.turnCount, 0),
    calls: collected.items.reduce((s, g) => s + g.totalCalls, 0),
    failedCalls: collected.items.reduce((s, g) => s + g.failedCalls, 0),
    explicitGoals: collected.items.filter(g => g.source === 'explicit').length,
    completedGoals: collected.items.filter(g => g.completed).length
  }

  let distance = null
  let distanceError = null
  const { key, source } = await resolveKey()
  if (embed && config.enabled && key) {
    try {
      distance = await scoreGoals(collected.items, {
        key,
        baseUrl: config.baseUrl,
        model: config.model,
        batchSize: config.batchSize
      })
    } catch (err) {
      distanceError = String(err?.message ?? err)
    }
  }

  return {
    generatedAt: Date.now(),
    elapsedMs: Date.now() - started,
    sessionsDir: SESSIONS_DIR,
    sessionsScanned: collected.sessionsScanned,
    readErrors: collected.errors.slice(0, 10),
    totals,
    keySource: source,
    embedding: {
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      model: config.model,
      keyEnv: config.keyEnv,
      batchSize: config.batchSize
    },
    distanceAvailable: distance !== null,
    distanceError,
    clusters: clustering.clusters,
    labelRollup: clustering.labelRollup,
    totalFailures: clustering.totalFailures,
    distance
  }
}

/** Shape returned by GET /config — never includes a key, only its variable name. */
function configPayload(keyState) {
  return {
    config,
    defaults: DEFAULT_CONFIG,
    presets: PRESETS,
    maxBatch: MAX_BATCH,
    warnings: configWarnings,
    keySource: keyState.source,
    keyConfigured: Boolean(keyState.key),
    configFile: CONFIG_FILE
  }
}

async function handleRoute(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(ROUTE_PREFIX, '') || '/'

  if (req.method === 'GET' && path === '/status') {
    const keyState = await resolveKey()
    return sendJson(res, 200, {
      analyzing,
      keySource: keyState.source,
      embeddingConfigured: Boolean(keyState.key),
      embeddingEnabled: config.enabled,
      embeddingModel: config.model,
      embeddingBaseUrl: config.baseUrl,
      embeddingKeyEnv: config.keyEnv,
      sessionsDir: SESSIONS_DIR,
      snapshot
    })
  }

  if (req.method === 'GET' && path === '/config') {
    return sendJson(res, 200, configPayload(await resolveKey()))
  }

  if (req.method === 'PUT' && path === '/config') {
    let body
    try {
      body = JSON.parse(await readBody(req) || '{}')
    } catch (err) {
      return sendJson(res, 400, { error: 'body 不是合法 JSON: ' + String(err?.message ?? err) })
    }
    const { config: next, errors } = applyConfigPatch(config, body)
    if (errors.length) return sendJson(res, 400, { error: errors.join('；'), errors })
    try {
      await saveConfig(next)
    } catch (err) {
      return sendJson(res, 500, { error: '写入配置失败: ' + String(err?.message ?? err) })
    }
    config = next
    configWarnings = []
    return sendJson(res, 200, configPayload(await resolveKey()))
  }

  if (req.method === 'POST' && path === '/probe') {
    let body = {}
    try {
      body = JSON.parse(await readBody(req) || '{}')
    } catch (err) {
      return sendJson(res, 400, { error: 'body 不是合法 JSON: ' + String(err?.message ?? err) })
    }
    // Probe either the saved config or an unsaved draft, so the UI can test
    // before committing. Draft fields are validated the same way.
    const { config: candidate, errors } = applyConfigPatch(config, body)
    if (errors.length) return sendJson(res, 400, { error: errors.join('；'), errors })
    const keyState = await resolveKeyFor(candidate.keyEnv)
    const result = await probeEmbedding({
      baseUrl: candidate.baseUrl,
      model: candidate.model,
      key: keyState.key
    })
    return sendJson(res, 200, { ...result, keySource: keyState.source, keyEnv: candidate.keyEnv })
  }

  if (req.method === 'GET' && path === '/correction') {
    return sendJson(res, 200, correctionPayload())
  }

  if (req.method === 'PUT' && path === '/correction') {
    let body
    try {
      body = JSON.parse(await readBody(req) || '{}')
    } catch (err) {
      return sendJson(res, 400, { error: 'body 不是合法 JSON: ' + String(err?.message ?? err) })
    }
    const { config: next, errors } = applyCorrectionPatch(correctionConfig, body)
    if (errors.length) return sendJson(res, 400, { error: errors.join('；'), errors })
    try {
      await saveCorrectionConfig(next)
    } catch (err) {
      return sendJson(res, 500, { error: '写入配置失败: ' + String(err?.message ?? err) })
    }
    correctionConfig = next
    // Turning the switch off drops any pending text so the next step sees none.
    if (!next.enabled) pendingCorrection.clear()
    return sendJson(res, 200, correctionPayload())
  }

  if (req.method === 'POST' && path === '/analyze') {
    if (analyzing) return sendJson(res, 409, { error: 'analysis already running' })
    analyzing = true
    try {
      const raw = await readBody(req)
      const body = raw ? JSON.parse(raw) : {}
      const result = await analyze({
        cwdFilter: body.cwdFilter || undefined,
        limit: Number(body.limit) || 0,
        embed: body.embed !== false
      })
      snapshot = result
      await saveCache(result)
      return sendJson(res, 200, result)
    } catch (err) {
      return sendJson(res, 500, { error: String(err?.message ?? err) })
    } finally {
      analyzing = false
    }
  }

  if (req.method === 'GET' && path === '/clusters') {
    // Clustering alone: no embedding call, so this stays fast and free.
    const collected = await collectGoals(SESSIONS_DIR, {
      cwdFilter: url.searchParams.get('cwdFilter') || undefined,
      limit: Number(url.searchParams.get('limit')) || 0
    })
    const clustering = clusterFailures(collected.items)
    return sendJson(res, 200, {
      generatedAt: Date.now(),
      sessionsScanned: collected.sessionsScanned,
      totalFailures: clustering.totalFailures,
      clusters: clustering.clusters,
      labelRollup: clustering.labelRollup
    })
  }

  return sendJson(res, 404, { error: `unknown route: ${path}` })
}

/** Resolve a key for a specific variable name (probe drafts use their own). */
async function resolveKeyFor(envName) {
  const fromEnv = process.env[envName]
  if (fromEnv) return { key: fromEnv, source: 'env' }
  try {
    const refs = readCredentialRefs(await readFile(CREDENTIALS, 'utf8'))
    if (refs[envName]) return { key: refs[envName], source: 'credentials' }
  } catch {
    // fall through
  }
  return { key: null, source: 'missing' }
}

/** Every tracked session, for the settings panel. */
function trackerSnapshot() {
  const out = []
  for (const sessionId of tracker.sessions.keys()) {
    out.push({ sessionId, ...tracker.snapshot(sessionId) })
  }
  return out.sort((a, b) => b.turnIndex - a.turnIndex)
}

/**
 * Payload for both /correction routes.
 *
 * `wiring` is a live self-check. Correction is mounted through optional seams
 * (`ctx.agents`, `agent/created`), and every failure in that chain is silent by
 * design — it must never break activation. That makes it unobservable without a
 * report, which is exactly the kind of thing that quietly never works. These
 * fields say where the chain stopped.
 */
function correctionPayload() {
  return {
    config: correctionConfig,
    defaults: DEFAULT_CORRECTION_CONFIG,
    sessions: trackerSnapshot(),
    attached: scorers.size,
    wiring,
    file: CORRECTION_FILE
  }
}

/**
 * Live analysis for one session, used between turns.
 *
 * The cached snapshot covers sessions already on disk, but the session running
 * right now is exactly the one correction is for — so its turns are scored
 * live by the session's LiveScorer. The cache is the fallback for turns that
 * happened before this plugin attached.
 */
function liveTurnDistance(sessionId, turnIndex, scorer) {
  const live = scorer?.distanceOf?.(turnIndex)
  if (typeof live === 'number') return live
  const cached = snapshot?.distance
  if (!cached || !Array.isArray(cached.items)) return null
  const goal = cached.items.find(g => g.sessionId === sessionId)
  if (!goal || !Array.isArray(goal.turns)) return null
  const turn = goal.turns.find(t => t.turn === turnIndex)
  return typeof turn?.distance === 'number' ? turn.distance : null
}

/**
 * Extract the last completed turn's index and text from a session event.
 *
 * Only `turn/end` matters here: it is the one durable marker that a turn is
 * finished and its output is final.
 */
function turnIndexOf(event) {
  if (event?.type !== 'turn/end') return null
  const turn = event.data?.turn
  return Number.isInteger(turn) ? turn : null
}

/**
 * The objective that anchors the correction, from the live goal or the cache.
 *
 * A live goal view wins: the user may have edited the objective since the last
 * analysis, and correcting toward a stale wording would be worse than not
 * correcting at all.
 */
function objectiveFor(agent, sessionId) {
  try {
    // Optional seams are read through ctx.reflect: a plain `agent.ctx.goals`
    // throws when the goals service is not declared in this plugin's inject.
    const goals = agent?.ctx?.reflect?.get?.('goals')
    if (goals && typeof goals.get === 'function') {
      const view = goals.get(agent)
      if (view?.objective) return view.objective
    }
  } catch {
    // fall through to the cached objective
  }
  const cached = snapshot?.distance
  const goal = cached?.items?.find(g => g.sessionId === sessionId)
  return goal?.objective ?? ''
}

/**
 * Seed the tracker from the cached analysis.
 *
 * A session already deep into a drift streak when the plugin loads should be
 * recognised on its first observed turn, not after building a fresh streak from
 * zero — otherwise the feature silently does nothing for exactly the sessions
 * that need it most.
 */
function seedFromCache(sessionId) {
  const state = tracker.stateFor(sessionId)
  if (state.turnIndex > 0) return
  const goal = snapshot?.distance?.items?.find(g => g.sessionId === sessionId)
  if (!goal || !Array.isArray(goal.turns)) return
  const scored = goal.turns.filter(t => typeof t.distance === 'number')
  state.history.push(...scored.slice(-correctionConfig.windowSize).map(t => t.distance))
  state.turnIndex = goal.turns.length
  let streak = 0
  for (let i = state.history.length - 1; i >= 0; i--) {
    if (state.history[i] >= correctionConfig.threshold) streak += 1
    else break
  }
  state.streak = streak
}

/**
 * Build the per-session embed function from the current config and key.
 *
 * The key is resolved per call, not captured: switching providers in the panel
 * takes effect on the next turn without re-attaching anything.
 */
function makeEmbed() {
  return async (texts) => {
    const { key } = await resolveKey()
    if (!key) return texts.map(() => null)
    return embedTexts({
      baseUrl: config.baseUrl,
      model: config.model,
      key,
      texts
    })
  }
}

/**
 * Recover the anchor from events that happened before this plugin attached:
 * the live goal first, then the first real user message. `scorer.seed()` folds
 * events in memory only — it never triggers embedding, so attaching mid-session
 * does not fire one embed call per past turn.
 */
function seedObjective(scorer, agent, sessionId) {
  const explicit = objectiveFor(agent, sessionId)
  if (explicit) {
    scorer.setObjective(explicit)
    return
  }
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    // A durable create_goal event outranks the first user message.
    for (const event of events) {
      if (event?.type === 'goal/change' && event.data?.operation === 'create') {
        const obj = event.data?.goal?.objective
        if (obj) {
          scorer.setObjective(obj)
          break
        }
      }
    }
    scorer.seed(events)
  } catch {
    // A session that cannot be replayed simply anchors from the next user
    // message it sees.
  }
}

/**
 * Attach drift correction to one live agent.
 *
 * Registration goes on `agent.ctx` — the agent's scoped context — so both the
 * prompt section and the turn observer apply to that agent alone and unwind
 * when it is disposed. That is the documented seam for per-agent composition
 * (agent presets use the same one), and it is what lets the section text be
 * built without guessing which session the current assembly is for: DSH
 * services are property access (`agent.ctx.systemPrompt`), not a lookup call.
 *
 * @param {object} agent - live Agent
 * @param {object} hostCtx - host context, used for logging only
 */
function attachCorrection(agent, hostCtx) {
  const sessionId = agent?.id
  const scoped = agent?.ctx
  if (!sessionId || !scoped) return

  seedFromCache(sessionId)

  const scorer = new LiveScorer({ embed: makeEmbed() })
  scorers.set(sessionId, scorer)
  seedObjective(scorer, agent, sessionId)

  // Read through reflect: the scoped ctx throws on an undeclared service read,
  // and systemPrompt is deliberately not in this plugin's inject list.
  const systemPrompt = scoped.reflect?.get?.('systemPrompt')
  if (systemPrompt && typeof systemPrompt.section === 'function') {
    systemPrompt.section({
      name: CORRECTION_SECTION_NAME,
      order: CORRECTION_SECTION_ORDER,
      /*
       * A thunk, read fresh at every assembly: whether to speak is decided per
       * step, not once at registration. Returning '' contributes nothing —
       * assemble() drops empty sections — so "off" costs no prompt tokens and
       * changes no bytes of the system prompt.
       */
      text: () => {
        if (!correctionConfig.enabled) return ''
        return pendingCorrection.get(sessionId)?.text ?? ''
      },
      interpolate: false
    })
  }

  /*
   * Observe the live event stream. `session/event` is the durable log
   * notification — each event is seen exactly once, and it is the same source
   * the analyzer reads, so the live decision and the later report cannot
   * disagree about what a turn contained. The session is entered inside this
   * agent's scope, so the scoped listener receives this session's events; the
   * identity check is a belt-and-braces guard, matching how dsh-agent-loop
   * listens for it.
   */
  const ownSession = agent.session
  if (typeof scoped.on === 'function') {
    /*
     * Serialized per session. The listener is async (embedding takes time) and
     * events dispatch synchronously, so without a chain turn 3's embed could
     * settle before turn 2's and feed the tracker distances out of order —
     * which would corrupt the streak. Turns are minutes apart, so one queued
     * embed per turn costs nothing.
     */
    let chain = Promise.resolve()
    scoped.on('session/event', (subject, event) => {
      chain = chain
        .then(() => handleSessionEvent(subject, event))
        .catch(err => {
          hostCtx?.logger?.warn?.(`[dsh-goal-ledger] turn observer failed: ${err?.message ?? err}`)
        })
      // Hand back the chain tail: a caller that awaits the listener (the emit
      // site, or a test) then waits for this event's processing, not just its
      // enqueue.
      return chain
    })
  }

  async function handleSessionEvent(subject, event) {
    if (!correctionConfig.enabled) return
    if (ownSession !== undefined && subject !== ownSession) return
    if (subject?.id !== sessionId) return

    // The scorer folds every event shape (objective, assistant text, turn
    // boundaries); it returns a distance only when a turn just completed.
    const scoredDistance = await scorer.observe(event)
    const turn = turnIndexOf(event)
    if (turn === null) return

    const distance = typeof scoredDistance === 'number'
      ? scoredDistance
      : liveTurnDistance(sessionId, turn, scorer)
    const verdict = tracker.observe(sessionId, distance, correctionConfig)
    if (!verdict.speak) {
      pendingCorrection.delete(sessionId)
      return
    }
    const text = buildCorrectionText({
      objective: scorer.objectiveText || objectiveFor(agent, sessionId),
      mean: verdict.mean,
      streak: verdict.streak,
      recent: tracker.snapshot(sessionId)?.recent ?? []
    })
    if (text) pendingCorrection.set(sessionId, { text, turn })
    else pendingCorrection.delete(sessionId)
  }
}

function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        await handleRoute(req, res)
      } catch (err) {
        sendJson(res, 500, { error: String(err?.message ?? err) })
      }
    }
  }), 'dsh-goal-ledger: analysis routes')

  /*
   * Drift correction attaches per agent. `agents` is deliberately NOT in
   * `inject`: a composition without live agents (headless, a bare web server)
   * must still load the panel, and Cordis would refuse to start this plugin
   * while an injected service is missing. Every use is guarded instead.
   *
   * The whole block is wrapped: an activation-time throw marks the plugin entry
   * `failed`, which takes the settings panel down with it — the routes above are
   * already registered, but Cordis still records the fiber as failed. Correction
   * is the optional extra; the panel is the product. So a failure here is logged
   * and swallowed rather than allowed to fail activation.
   *
   * Event payloads are objects: `agent/created` carries `{ agent, source }` and
   * `agent/disposed` carries `{ agent }` — destructuring is required, a bare
   * payload passed as the agent yields `agent.id === undefined` and fails
   * silently.
   */
  try {
    /*
     * `ctx.reflect.get()` reads a service WITHOUT declaring it in `inject` —
     * the only way to reach an optional seam here. A plain `ctx.agents` access
     * throws `cannot get property "agents" without inject` (Cordis guards every
     * undeclared service read through the context proxy), and declaring it in
     * `inject` would stop the panel from loading in a composition without live
     * agents. The guard is real, not defensive noise: it is what the first
     * version of this file died on, and the getter throws rather than returning
     * undefined, so it cannot be left to optional chaining.
     */
    const agents = ctx.reflect?.get?.('agents')
    wiring.agentsService = Boolean(agents)
    if (agents) {
      const attach = (agent) => {
        try {
          attachCorrection(agent, ctx)
        } catch (err) {
          const msg = `${agent?.id}: ${err?.message ?? err}`
          wiring.attachErrors.push(msg)
          if (wiring.attachErrors.length > 5) wiring.attachErrors.shift()
          ctx.logger?.warn?.(`[dsh-goal-ledger] correction attach failed for ${msg}`)
        }
      }
      ctx.effect(() => {
        // Agents already running when this plugin loads.
        if (typeof agents.list === 'function') {
          const live = agents.list()
          wiring.listed = Array.isArray(live) ? live.length : 0
          for (const agent of live) attach(agent)
        }
        return ctx.on('agent/created', ({ agent } = {}) => attach(agent))
      }, 'dsh-goal-ledger: drift correction')

      // Tracker and scorer state is host-process data, outside any agent scope:
      // clean it on the global disposal edge so a long-lived host cannot leak.
      ctx.effect(() => ctx.on('agent/disposed', ({ agent } = {}) => {
        const sessionId = agent?.id
        if (sessionId) {
          tracker.forget(sessionId)
          scorers.delete(sessionId)
          pendingCorrection.delete(sessionId)
        }
      }), 'dsh-goal-ledger: correction state cleanup')
    }
  } catch (err) {
    wiring.attachErrors.push(`activation: ${err?.message ?? err}`)
    ctx.logger?.warn?.(
      `[dsh-goal-ledger] drift correction unavailable, panel unaffected: ${err?.message ?? err}`
    )
  }

  // Load config and any previous snapshot so the panel shows data before a re-run.
  loadConfig().catch(() => {})
  loadCorrectionConfig().catch(() => {})
  loadCache().catch(() => {})
}

export { apply, inject, name }
