/**
 * dsh-goal-ledger — host half.
 *
 * Exposes an analysis API over HTTP so the client panel can render results:
 *
 *   GET  /dsh-goal-ledger-7821/status    cached snapshot + metadata
 *   POST /dsh-goal-ledger-7821/analyze   { cwdFilter?, limit?, embed? } → runs, returns snapshot
 *   GET  /dsh-goal-ledger-7821/clusters  failure clusters only (no embedding needed)
 *   GET  /dsh-goal-ledger-7821/config    resolved embedding settings (key never returned)
 *
 * The host never writes to session logs: this plugin is an auditor.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { readFile, mkdir, writeFile } from 'node:fs/promises'

import { collectGoals } from '../src/session-reader.js'
import { clusterFailures } from '../src/failure-cluster.js'
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_KEY_ENV,
  readCredentialRefs,
  scoreGoals
} from '../src/distance.js'

const name = 'dsh-goal-ledger'
const inject = ['webServer']

const ROUTE_PREFIX = '/dsh-goal-ledger-7821'
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const SESSIONS_DIR = join(DSH_HOME, 'sessions')
const CREDENTIALS = join(DSH_HOME, '.credentials.yaml')
const CACHE_DIR = join(DSH_HOME, 'dsh-goal-ledger')
const CACHE_FILE = join(CACHE_DIR, 'snapshot.json')

/** Last computed snapshot, served by /status without recomputing. */
let snapshot = null
let analyzing = false

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
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Resolve the embedding key: env first, then DSH credentials. Never log it. */
async function resolveKey() {
  const fromEnv = process.env[DEFAULT_KEY_ENV]
  if (fromEnv) return { key: fromEnv, source: 'env' }
  try {
    const yaml = await readFile(CREDENTIALS, 'utf8')
    const refs = readCredentialRefs(yaml)
    if (refs[DEFAULT_KEY_ENV]) return { key: refs[DEFAULT_KEY_ENV], source: 'credentials' }
  } catch {
    // No credentials file: embeddings stay unavailable, clustering still works.
  }
  return { key: null, source: 'missing' }
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
  if (embed && key) {
    try {
      const scored = await scoreGoals(collected.items, { key })
      distance = scored
    } catch (err) {
      distanceError = String(err?.message ?? err)
    }
  }

  const result = {
    generatedAt: Date.now(),
    elapsedMs: Date.now() - started,
    sessionsDir: SESSIONS_DIR,
    sessionsScanned: collected.sessionsScanned,
    readErrors: collected.errors.slice(0, 10),
    totals,
    keySource: source,
    distanceAvailable: distance !== null,
    distanceError,
    clusters: clustering.clusters,
    labelRollup: clustering.labelRollup,
    totalFailures: clustering.totalFailures,
    distance
  }
  return result
}

async function handleRoute(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname.replace(ROUTE_PREFIX, '') || '/'

  if (req.method === 'GET' && path === '/status') {
    const { key, source } = await resolveKey()
    return sendJson(res, 200, {
      analyzing,
      keySource: source,
      embeddingConfigured: Boolean(key),
      embeddingModel: DEFAULT_MODEL,
      embeddingBaseUrl: DEFAULT_BASE_URL,
      sessionsDir: SESSIONS_DIR,
      snapshot
    })
  }

  if (req.method === 'GET' && path === '/config') {
    const { source } = await resolveKey()
    return sendJson(res, 200, {
      keySource: source,
      keyEnv: DEFAULT_KEY_ENV,
      model: DEFAULT_MODEL,
      baseUrl: DEFAULT_BASE_URL,
      sessionsDir: SESSIONS_DIR,
      cacheFile: CACHE_FILE
    })
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

  // Load any previous snapshot so the panel shows data before a re-run.
  loadCache().catch(() => {})
}

export { apply, inject, name }
