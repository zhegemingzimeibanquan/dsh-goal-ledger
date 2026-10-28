// Host wiring test for drift correction.
//
// correction.mjs covers the decision logic; those tests pass even when the
// wiring into DSH is wrong. This one drives apply() with a fake ctx shaped like
// the real composition — services as properties, event payloads as objects
// ({ agent, source }), registrations on agent.ctx — and asserts the correction
// actually reaches the prompt section. Every one of those shape details is a
// bug this file caught during development.
//
// Run: node test/correction-wiring.mjs
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SESSION_ID = 'session-wire-1'
const OBJECTIVE = '目标：把报表导出功能做完'
const DRIFTED = '完全不同的话题，先聊聊别的'

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}

// Two orthogonal topics: cosine distance between them is exactly 1, so a
// drifted turn always clears any threshold in range and the test is stable.
function fakeVector(text) {
  return /报表|导出/.test(String(text)) ? [1, 0, 0, 0] : [0, 1, 0, 0]
}
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init?.body ?? '{}')
  const inputs = body.input ?? []
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: inputs.map((t, i) => ({ index: i, embedding: fakeVector(t) }))
    })
  }
}

/**
 * A fake DSH composition, matching the real service/event shapes:
 *   - services are reached through ctx.reflect.get(name), NOT ctx.name — plain
 *     property access throws `cannot get property "<x>" without inject`, which
 *     is how Cordis guards undeclared service reads. Modelling the throw is the
 *     point: an implementation that reads ctx.agents directly must fail here.
 *   - ctx.on('agent/created', ({ agent, source }) => …) — object payload
 *   - agent.ctx.on('session/event', (session, event) => …) — scoped listener
 */
function makeHarness({ withAgents = true } = {}) {
  const listeners = { 'agent/created': [], 'agent/disposed': [] }
  const sections = new Map()
  const sessionListeners = []
  const services = {
    systemPrompt: {
      section(s) {
        if (sections.has(s.name)) throw new Error(`duplicate section: ${s.name}`)
        sections.set(s.name, s)
        return () => sections.delete(s.name)
      }
    }
  }
  if (withAgents) services.agents = { list: () => [] }

  /** Mirror Cordis's reflect.get: undeclared direct reads are unavailable. */
  const makeContext = (base, available) => {
    const ctx = {
      ...base,
      reflect: {
        get(name) {
          const svc = available[name]
          if (svc === undefined) return undefined
          return svc
        }
      }
    }
    // Direct property reads of services throw, exactly as Cordis does.
    for (const name of Object.keys(available)) {
      if (name in base) continue
      Object.defineProperty(ctx, name, {
        get() {
          throw new Error(`cannot get property "${name}" without inject`)
        }
      })
    }
    return ctx
  }

  const agentCtx = makeContext({
    on(event, cb) {
      if (event === 'session/event') sessionListeners.push(cb)
      return () => {}
    }
  }, services)

  const agent = {
    id: SESSION_ID,
    ctx: agentCtx,
    session: { id: SESSION_ID, snapshotEvents: () => [] }
  }

  const ctx = makeContext({
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    on(event, cb) { (listeners[event] ??= []).push(cb); return () => {} },
    emit(event, payload) { for (const cb of listeners[event] ?? []) cb(payload) },
    webServer: { register() { return () => {} } },
    logger: { warn: (m) => console.log('[warn]', m) }
  }, services)

  return { ctx, agent, sections, sessionListeners }
}

/** Deliver one event through the scoped session listener, as DSH would. */
async function fire(harness, type, data) {
  const session = harness.agent.session
  for (const cb of harness.sessionListeners) await cb(session, { type, data, seq: 1 })
}

/** Run a full turn: user ask (first turn only), assistant reply, turn end. */
async function runTurn(harness, turn, replyText) {
  await fire(harness, 'turn/start', { turn })
  await fire(harness, 'assistant/message', {
    message: { content: [{ type: 'text', text: replyText }] }
  })
  await fire(harness, 'turn/end', { turn })
}

// ---------------------------------------------------------------------------
// Case 1: disabled (the shipped default) contributes nothing at all.
// ---------------------------------------------------------------------------
{
  const home = await mkdtemp(join(tmpdir(), 'gl-wire-off-'))
  process.env.DSH_HOME = home
  process.env.VOLCENGINE_CODING_PLAN_API_KEY = 'test-key-not-secret'
  const mod = await import(`../lib/index.js?case=off&${Date.now()}`)

  const harness = makeHarness()
  mod.apply(harness.ctx)
  await new Promise(r => setTimeout(r, 30)) // let the async config load settle
  harness.ctx.emit('agent/created', { agent: harness.agent, source: 'test' })

  const section = harness.sections.get('goal-ledger:drift-correction')
  check('section registered on agent/created', Boolean(section))
  check('section text is a thunk', typeof section?.text === 'function')
  // A wiring regression means no section at all; guard so every later
  // assertion fails as "missing" instead of crashing the file midway.
  const sectionText = () => section?.text?.() ?? ''
  check('disabled: renders empty', sectionText() === '')

  await fire(harness, 'user/message', { content: [{ type: 'text', text: OBJECTIVE }] })
  for (let i = 1; i <= 4; i++) await runTurn(harness, i, DRIFTED)
  check('disabled: still empty after 4 drifting turns', sectionText() === '')

  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Case 2: enabled through the real config file, sustained drift speaks.
// ---------------------------------------------------------------------------
{
  const home = await mkdtemp(join(tmpdir(), 'gl-wire-on-'))
  await mkdir(join(home, 'dsh-goal-ledger'), { recursive: true })
  await writeFile(join(home, 'dsh-goal-ledger', 'correction.json'),
    JSON.stringify({ enabled: true, threshold: 0.5, minStreak: 2, cooldownTurns: 1 }), 'utf8')
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?case=on&${Date.now()}`)

  const harness = makeHarness()
  mod.apply(harness.ctx)
  await new Promise(r => setTimeout(r, 30))
  harness.ctx.emit('agent/created', { agent: harness.agent, source: 'test' })
  const section = harness.sections.get('goal-ledger:drift-correction')
  check('enabled: section present', Boolean(section))
  const sectionText = () => section?.text?.() ?? ''

  await fire(harness, 'user/message', { content: [{ type: 'text', text: OBJECTIVE }] })

  await runTurn(harness, 1, DRIFTED)
  check('first drifting turn stays quiet (minStreak 2)', sectionText() === '')

  await runTurn(harness, 2, DRIFTED)
  const text = sectionText()
  check('sustained drift produces the correction', text.includes('目标漂移提醒'), `${text.length} chars`)
  check('correction quotes the objective verbatim', text.includes(OBJECTIVE))
  check('correction forbids restarting', text.includes('不要重开任务'))

  // Cooldown: turn 3 drifts but must stay quiet for cooldownTurns = 1.
  await runTurn(harness, 3, DRIFTED)
  check('cooldown clears the pending text', sectionText() === '', sectionText().slice(0, 40))

  // Turn 4: streak is 3 and the cooldown has elapsed → speaks again.
  await runTurn(harness, 4, DRIFTED)
  check('speaks again after cooldown', sectionText().includes('目标漂移提醒'))

  // A focused turn resets the streak for good.
  await runTurn(harness, 5, '继续完善报表导出的分页逻辑')
  check('focused turn resets the drift streak', sectionText() === '', sectionText().slice(0, 40))

  await rm(home, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Case 3: a tool-only turn (no prose) is never scored, so it cannot speak.
// ---------------------------------------------------------------------------
{
  const home = await mkdtemp(join(tmpdir(), 'gl-wire-tool-'))
  await mkdir(join(home, 'dsh-goal-ledger'), { recursive: true })
  await writeFile(join(home, 'dsh-goal-ledger', 'correction.json'),
    JSON.stringify({ enabled: true, threshold: 0.5, minStreak: 2, cooldownTurns: 0 }), 'utf8')
  process.env.DSH_HOME = home
  const mod = await import(`../lib/index.js?case=tool&${Date.now()}`)

  const harness = makeHarness()
  mod.apply(harness.ctx)
  await new Promise(r => setTimeout(r, 30))
  harness.ctx.emit('agent/created', { agent: harness.agent, source: 'test' })
  const section = harness.sections.get('goal-ledger:drift-correction')

  await fire(harness, 'user/message', { content: [{ type: 'text', text: OBJECTIVE }] })
  for (let i = 1; i <= 3; i++) {
    await fire(harness, 'turn/start', { turn: i })
    await fire(harness, 'turn/end', { turn: i }) // no assistant/message at all
  }
  check('tool-only turns never trigger', (section?.text?.() ?? '') === '')
}

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
