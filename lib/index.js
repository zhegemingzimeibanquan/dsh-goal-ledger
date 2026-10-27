/**
 * dsh-goal-ledger — host half.
 *
 * Exposes an analysis API over HTTP so the client panel can render results:
 *
 *   GET  /dsh-goal-ledger-7821/status    cached snapshot + metadata + config
 *   GET  /dsh-goal-ledger-7821/config    resolved embedding config (+ presets)
 *   PUT  /dsh-goal-ledger-7821/config    { baseUrl?, model?, keyEnv?, batchSize?, enabled? }
 *   POST /dsh-goal-ledger-7821/probe     probe the endpoint with one short text
 *   POST /dsh-goal-ledger-7821/analyze   { cwdFilter?, limit?, embed? } → runs, returns snapshot
 *   GET  /dsh-goal-ledger-7821/clusters  failure clusters only (no embedding needed)
 *
 * The host never writes to session logs: this plugin is an auditor. The only
 * file it writes is its own config and snapshot cache under $DSH_HOME.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'

import { collectGoals } from '../src/session-reader.js'
import { clusterFailures } from '../src/failure-cluster.js'
import { scoreGoals, probeEmbedding, readCredentialRefs } from '../src/distance.js'
import {
  DEFAULT_CONFIG,
  MAX_BATCH,
  PRESETS,
  applyConfigPatch,
  normalizeConfig
} from '../src/embed-config.js'

const name = 'dsh-goal-ledger'
const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-goal-ledger-7821'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = join(DSH_HOME, 'sessions')
const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')
const CACHE_DIR = join(DSH_HOME, 'dsh-goal-ledger')
const CACHE_FILE = join(CACHE_DIR, 'snapshot.json')
const CONFIG_FILE = join(CACHE_DIR, 'config.json')

/** Last computed snapshot, served by /status without recomputing. */
let snapshot = null
let analyzing = false
/** Resolved embedding config, loaded once at apply() and updated by PUT /config. */
let config = { ...DEFAULT_CONFIG }
let configWarnings = []

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

  // Load config and any previous snapshot so the panel shows data before a re-run.
  loadConfig().catch(() => {})
  loadCache().catch(() => {})
}

export { apply, inject, name }
