// Drift-correction tests: the decision logic, the injected text, and the host
// route that toggles it. No DSH, no network, no session logs.
//
// Run: node test/correction.mjs
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CorrectionTracker,
  DEFAULT_CORRECTION_CONFIG,
  applyCorrectionPatch,
  bandOf,
  buildCorrectionText
} from '../src/correction.js'

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}
const enabled = (over = {}) => ({ ...DEFAULT_CORRECTION_CONFIG, enabled: true, ...over })

// --- config validation ------------------------------------------------------
{
  const { config, errors } = applyCorrectionPatch(DEFAULT_CORRECTION_CONFIG, {
    enabled: true, threshold: 0.6, minStreak: 3, cooldownTurns: 4, windowSize: 8
  })
  check('valid patch applies', errors.length === 0 && config.threshold === 0.6 && config.minStreak === 3)

  const bad = applyCorrectionPatch(DEFAULT_CORRECTION_CONFIG, {
    threshold: 5, minStreak: 0, cooldownTurns: -1, windowSize: 99
  })
  check('out-of-range values rejected', bad.errors.length === 4, bad.errors.length + ' errors')
  check('rejected values keep defaults',
    bad.config.threshold === DEFAULT_CORRECTION_CONFIG.threshold
    && bad.config.minStreak === DEFAULT_CORRECTION_CONFIG.minStreak)

  const unknown = applyCorrectionPatch(DEFAULT_CORRECTION_CONFIG, { nope: 1 })
  check('unknown key reported', unknown.errors.some(e => e.includes('nope')))

  check('defaults are off', DEFAULT_CORRECTION_CONFIG.enabled === false)
}

// --- band mapping matches the client ---------------------------------------
{
  check('band green', bandOf(0.2) === 'green')
  check('band yellow', bandOf(0.4) === 'yellow')
  check('band orange', bandOf(0.55) === 'orange')
  check('band red', bandOf(0.7) === 'red')
  check('band grey for null', bandOf(null) === 'grey')
}

// --- hysteresis -------------------------------------------------------------
{
  const t = new CorrectionTracker()
  const cfg = enabled()
  // Natural variation: one high turn then recovery. Must stay silent.
  const script = [0.2, 0.62, 0.3, 0.25, 0.28]
  const spoke = script.map((d, i) => t.observe('s', d, cfg).speak)
  check('single spike does not trigger', spoke.every(v => v === false), JSON.stringify(spoke))

  const t2 = new CorrectionTracker()
  const sustained = [0.58, 0.62, 0.7]
  const v = sustained.map(d => t2.observe('s', d, cfg))
  check('sustained drift triggers on minStreak', v[0].speak === false && v[1].speak === true,
    v.map(x => x.reason).join(','))
  check('streak counted', v[1].streak === 2)

  // Cooldown: after speaking, stay quiet for exactly cooldownTurns turns.
  // It spoke on turn 2, so turns 3,4,5 are quiet and turn 6 speaks again.
  // `sustained` already consumed turn 3, so only turns 4 and 5 remain quiet here.
  const after = [0.7, 0.72].map(d => t2.observe('s', d, cfg))
  check('cooldown suppresses for cooldownTurns', after.every(x => x.speak === false),
    after.map(x => x.reason).join(','))
  const resume = t2.observe('s', 0.7, cfg)
  check('speaks again right after cooldown', resume.speak === true, resume.reason)
}

// --- disabled means silent --------------------------------------------------
{
  const t = new CorrectionTracker()
  const cfg = { ...DEFAULT_CORRECTION_CONFIG, enabled: false }
  const r = [0.9, 0.9, 0.9, 0.9].map(d => t.observe('s', d, cfg))
  check('disabled never speaks', r.every(x => x.speak === false))
  check('disabled reason is explicit', r[3].reason === 'disabled')
}

// --- unscorable turns carry no evidence ------------------------------------
{
  const t = new CorrectionTracker()
  const cfg = enabled()
  t.observe('s', 0.6, cfg)          // streak 1
  t.observe('s', null, cfg)         // tool-only turn: no evidence either way
  const r = t.observe('s', 0.6, cfg) // streak 2 → speak
  check('null distance preserves streak', r.speak === true, `streak=${r.streak}`)
}

// --- per-session isolation --------------------------------------------------
{
  const t = new CorrectionTracker()
  const cfg = enabled()
  t.observe('a', 0.7, cfg)
  t.observe('a', 0.7, cfg)
  const other = t.observe('b', 0.7, cfg)
  check('sessions do not share streaks', other.speak === false && other.streak === 1)
  t.forget('a')
  check('forget drops state', t.snapshot('a') === null)
}

// --- injected text ----------------------------------------------------------
{
  const text = buildCorrectionText({
    objective: '修复 DMS 落库时审计字段为空的问题',
    mean: 0.62,
    streak: 3,
    recent: [0.5, 0.6, 0.7, 0.65, 0.6]
  })
  check('text quotes the objective verbatim', text.includes('修复 DMS 落库时审计字段为空的问题'))
  check('text states the streak', /最近 3 轮/.test(text))
  check('text shows the trend', text.includes('0.50 → 0.60 → 0.70'))
  check('text forbids restarting', /不要重开任务/.test(text))
  check('text preserves finished work', /已经完成的有效工作全部保留/.test(text))
  check('text allows "no change needed"', /不需要为了降低距离而改变做法/.test(text))
  check('text is advisory not imperative-only', /如果你的输出确实仍在服务于上面的目标/.test(text))

  const long = buildCorrectionText({
    objective: 'x'.repeat(2000), mean: 0.6, streak: 2, recent: [0.6, 0.6]
  })
  check('long objective is truncated', long.includes('原文已截断') && long.length < 2500,
    `${long.length} chars`)

  check('empty objective yields no text', buildCorrectionText({ objective: '  ', mean: 0.6, streak: 2 }) === '')
  check('multiline objective quoted safely', buildCorrectionText({
    objective: '第一行\n第二行', mean: 0.6, streak: 2, recent: [0.6]
  }).includes('> 第一行\n> 第二行'))
}

// --- host routes ------------------------------------------------------------
{
  const home = await mkdtemp(join(tmpdir(), 'gl-corr-'))
  process.env.DSH_HOME = home
  const mod = await import('../lib/index.js')
  let handler = null
  const effects = []
  mod.apply({
    effect(fn) { effects.push(fn()); return () => {} },
    get(name) {
      if (name === 'webServer') return null
      return undefined
    },
    webServer: {
      register(route) { handler = route.handler; return () => {} }
    }
  })
  check('routes registered', typeof handler === 'function')

  const call = (method, path, body) => new Promise((resolve) => {
    const req = {
      method, url: path,
      on(ev, cb) {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') cb()
        return req
      },
      destroy() {}
    }
    const res = {
      status: 0, body: '',
      writeHead(s) { res.status = s },
      end(b) { res.body = b; resolve(res) }
    }
    handler(req, res)
  })

  const get = await call('GET', '/dsh-goal-ledger-7821/correction')
  const getBody = JSON.parse(get.body)
  check('GET /correction 200', get.status === 200)
  check('correction defaults to off', getBody.config.enabled === false)
  check('defaults exposed', getBody.defaults.threshold === DEFAULT_CORRECTION_CONFIG.threshold)
  check('wiring self-check exposed', getBody.attached === 0,
    `attached=${getBody.attached} (no live agents in this harness)`)

  const badPut = await call('PUT', '/dsh-goal-ledger-7821/correction', { threshold: 9 })
  check('PUT rejects bad threshold', badPut.status === 400, JSON.parse(badPut.body).error)

  const put = await call('PUT', '/dsh-goal-ledger-7821/correction', {
    enabled: true, threshold: 0.6, minStreak: 2
  })
  const putBody = JSON.parse(put.body)
  check('PUT accepts valid config', put.status === 200 && putBody.config.enabled === true)
  check('PUT persists threshold', putBody.config.threshold === 0.6)

  const reread = JSON.parse((await call('GET', '/dsh-goal-ledger-7821/correction')).body)
  check('config survives re-read', reread.config.enabled === true && reread.config.threshold === 0.6)

  const off = await call('PUT', '/dsh-goal-ledger-7821/correction', { enabled: false })
  check('can switch off again', JSON.parse(off.body).config.enabled === false)

  await rm(home, { recursive: true, force: true })
}

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
