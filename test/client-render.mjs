// Client-half render test.
//
// Two regressions this catches, both of which shipped blank-but-silent:
//
// 1. `h` bound to `jsx` from react/jsx-runtime. Its third argument is the
//    element KEY, not a child, so every variadic-children call site rendered an
//    empty tree: the settings section registered fine and painted nothing.
// 2. A canvas renderer that throws or never draws. jsdom has no 2D context, so
//    the test installs a recording stub and asserts the field actually issues
//    draw calls instead of failing quietly.
//
// Run: npm run test:render
// Needs devDependencies: react, react-dom, jsdom (installed by `npm install`).
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

let React, jsxRuntime, JSDOM
try {
  React = require('react')
  jsxRuntime = require('react/jsx-runtime')
  ;({ JSDOM } = require('jsdom'))
} catch (err) {
  console.error('SKIP: render test needs react, react-dom and jsdom — run `npm install` first.')
  console.error('      ' + String(err?.message ?? err))
  process.exit(0)
}

// A synthetic snapshot covering every branch the tabs render, so the test is
// offline and stable: no DSH instance, no session logs, no embedding calls.
const snapshot = {
  generatedAt: Date.now(),
  elapsedMs: 1700,
  sessionsDir: 'C:\\Users\\example\\.dsh\\sessions',
  sessionsScanned: 34,
  readErrors: [],
  totals: { goals: 27, turns: 207, calls: 6165, failedCalls: 81, explicitGoals: 2, completedGoals: 2 },
  keySource: 'credentials',
  distanceAvailable: true,
  distanceError: null,
  totalFailures: 81,
  labelRollup: [
    { label: '文件未先读取（需先 read 再改）', count: 30, clusters: 1, tools: ['edit'] },
    { label: '文件/路径不存在', count: 12, clusters: 2, tools: ['read', 'pwsh'] }
  ],
  clusters: [
    {
      key: 'edit::FS_NOT_OBSERVED',
      tool: 'edit',
      signature: '{"name":"FsError","code":"FS_NOT_OBSERVED"}',
      label: '文件未先读取（需先 read 再改）',
      count: 26,
      goalCount: 12,
      sessionCount: 12,
      sample: '{"name":"FsError","code":"FS_NOT_OBSERVED"}',
      occurrences: [{ goalId: 'derived-1', turn: 3, objective: '修一下这个 bug' }]
    },
    {
      key: 'read::FS_NOT_FOUND',
      tool: 'read',
      signature: '{"name":"FsError","code":"FS_NOT_FOUND"}',
      label: '文件/路径不存在',
      count: 12,
      goalCount: 7,
      sessionCount: 7,
      sample: '{"name":"FsError","code":"FS_NOT_FOUND"}',
      occurrences: [{ goalId: 'derived-2', turn: 5, objective: '看看这个文件' }]
    }
  ],
  distance: {
    model: 'doubao-embedding-vision',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    dim: 2048,
    turns: 207,
    scorableTurns: 159,
    items: [
      { goalId: 'g1', objective: '你在 C:\\Project\\dms-frontend 仓库工作', meanDistance: 0.493, turnCount: 20, totalCalls: 500, failedCalls: 20 },
      { goalId: 'g2', objective: '只读复核员，检查落库', meanDistance: 0.211, turnCount: 9, totalCalls: 120, failedCalls: 2 },
      { goalId: 'g3', objective: '长技术任务，天然漂移', meanDistance: 0.712, turnCount: 31, totalCalls: 900, failedCalls: 40 }
    ],
    worstTurns: [
      { distance: 0.812, turn: 7, calls: 31, objective: '你在 C:\\Project\\dms-frontend 仓库工作', preview: '先看一下目录结构' }
    ]
  }
}

const configPayload = {
  config: {
    enabled: true,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
    model: 'doubao-embedding-vision',
    keyEnv: 'VOLCENGINE_CODING_PLAN_API_KEY',
    batchSize: 4
  },
  defaults: { enabled: true, baseUrl: '', model: '', keyEnv: '', batchSize: 4 },
  presets: [
    { id: 'volcengine', label: '火山方舟（coding plan）', baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3', model: 'doubao-embedding-vision', keyEnv: 'VOLCENGINE_CODING_PLAN_API_KEY' },
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'text-embedding-3-small', keyEnv: 'OPENAI_API_KEY' },
    { id: 'custom', label: '自定义（任意 OpenAI 兼容端点）', baseUrl: '', model: '', keyEnv: '' }
  ],
  maxBatch: 10,
  warnings: [],
  keySource: 'credentials',
  keyConfigured: true,
  configFile: 'C:\\Users\\example\\.dsh\\dsh-goal-ledger\\config.json'
}

const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:58959/'
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { globalThis.navigator = window.navigator } catch { /* node exposes a getter-only navigator */ }
// React reads IS_REACT_ACT_ENVIRONMENT off globalThis, not off `window`.
window.IS_REACT_ACT_ENVIRONMENT = true
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// react-dom MUST be required only after the jsdom globals exist. It snapshots
// `canUseDOM` at module init: loaded earlier, it decides there is no DOM, wires
// no event system at all, and every synthetic 'input' silently never reaches
// onChange — which looks exactly like a broken controlled input in the plugin.
let ReactDOMClient
try {
  ReactDOMClient = require('react-dom/client')
} catch (err) {
  console.error('SKIP: render test needs react-dom — run `npm install` first.')
  console.error('      ' + String(err?.message ?? err))
  process.exit(0)
}

// --- canvas stub -----------------------------------------------------------
// jsdom ships no 2D context. Record every call so the test can prove the field
// renderer really drew, and return plausible objects for the gradient factories.
const canvasCalls = { total: 0, byOp: Object.create(null) }
function makeContext2D() {
  const gradient = { addColorStop() {} }
  const record = (op) => {
    canvasCalls.total++
    canvasCalls.byOp[op] = (canvasCalls.byOp[op] ?? 0) + 1
  }
  const ctx = {
    canvas: null,
    setTransform() { record('setTransform') },
    save() {}, restore() {},
    beginPath() { record('beginPath') },
    closePath() {},
    moveTo() {}, lineTo() {},
    quadraticCurveTo() { record('quadraticCurveTo') },
    arc() { record('arc') },
    ellipse() { record('ellipse') },
    fill() { record('fill') },
    stroke() { record('stroke') },
    fillRect() { record('fillRect') },
    fillText() { record('fillText') },
    setLineDash() {},
    createLinearGradient() { record('createLinearGradient'); return gradient },
    createRadialGradient() { record('createRadialGradient'); return gradient }
  }
  return ctx
}
window.HTMLCanvasElement.prototype.getContext = function getContext(kind) {
  if (kind !== '2d') return null
  if (!this.__ctx) this.__ctx = makeContext2D()
  return this.__ctx
}
// jsdom has no layout, so getBoundingClientRect is all zeros; give the canvas a
// real box or the renderer would compute a zero-size field.
window.HTMLCanvasElement.prototype.getBoundingClientRect = function getRect() {
  return { x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 340, width: 640, height: 340 }
}
window.HTMLElement.prototype.getBoundingClientRect = function getRect() {
  return { x: 0, y: 0, left: 0, top: 0, right: 640, bottom: 340, width: 640, height: 340 }
}
window.devicePixelRatio = 2
// requestAnimationFrame is driven manually: an auto-scheduling stub would spin a
// 0ms timer loop for as long as the field is mounted and starve the event loop
// that React needs to deliver input events.
const frameQueue = new Map()
let rafSeq = 0
window.requestAnimationFrame = (cb) => { rafSeq += 1; frameQueue.set(rafSeq, cb); return rafSeq }
window.cancelAnimationFrame = (id) => { frameQueue.delete(id) }
/** Run up to `count` queued animation frames, oldest first. */
function pumpFrames(count = 1) {
  for (let i = 0; i < count; i++) {
    const entries = [...frameQueue.entries()]
    frameQueue.clear()
    if (!entries.length) return i
    for (const [, cb] of entries) cb(rafSeq * 16)
  }
  return count
}

// Drift-correction config the panel reads and writes.
const correctionPayload = {
  config: { enabled: false, threshold: 0.55, minStreak: 2, cooldownTurns: 3, windowSize: 6 },
  defaults: { enabled: false, threshold: 0.55, minStreak: 2, cooldownTurns: 3, windowSize: 6 },
  sessions: [
    { sessionId: 'session-abc123def456', turnIndex: 12, streak: 3, mean: 0.62, injections: 2, recent: [0.6, 0.62, 0.64], lastSpokeTurn: 9 }
  ],
  attached: 1,
  file: 'C:\\Users\\example\\.dsh\\dsh-goal-ledger\\correction.json'
}

// --- fetch stub ------------------------------------------------------------
const requests = []
window.fetch = async (url, init) => {
  const path = String(url)
  const method = init?.method ?? 'GET'
  requests.push({ path, method, body: init?.body })
  let body
  if (path.endsWith('/status')) {
    body = {
      analyzing: false,
      keySource: 'credentials',
      embeddingConfigured: true,
      embeddingEnabled: true,
      embeddingModel: 'doubao-embedding-vision',
      embeddingBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
      embeddingKeyEnv: 'VOLCENGINE_CODING_PLAN_API_KEY',
      sessionsDir: snapshot.sessionsDir,
      snapshot
    }
  } else if (path.endsWith('/correction')) {
    // PUT echoes the submitted config, the way the real host does, so the panel
    // reflects what was actually saved rather than a stale fixture.
    if (method === 'PUT') {
      const submitted = JSON.parse(init?.body ?? '{}')
      body = { ...correctionPayload, config: { ...correctionPayload.config, ...submitted } }
    } else {
      body = correctionPayload
    }
  } else if (path.endsWith('/config')) {
    body = configPayload
  } else if (path.endsWith('/probe')) {
    body = { ok: true, model: 'text-embedding-3-small', dim: 1536, elapsedMs: 120, keySource: 'env', keyEnv: 'OPENAI_API_KEY' }
  } else if (path.endsWith('/analyze')) {
    body = snapshot
  } else {
    body = { ok: true }
  }
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }
}

let registration = null
window.__ModuleLoader__ = { load(record) { registration = record } }

const fakeRequire = (id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return jsxRuntime
  if (id === 'react-dom') return require('react-dom')
  throw new Error('unexpected require: ' + id)
}

new Function('window', 'document', 'navigator', 'require', source)(
  window, window.document, window.navigator, fakeRequire
)
if (!registration) {
  console.error('FAIL: bundle never called window.__ModuleLoader__.load')
  process.exit(1)
}

const exports = registration.factory(fakeRequire)
const sections = []
exports.apply({
  effect(fn) { return typeof fn === 'function' ? fn() : undefined },
  slots: {
    inject(name, generator) {
      if (name !== 'settings.section') return () => {}
      const it = typeof generator === 'function' ? generator() : null
      if (it && typeof it.next === 'function') {
        for (let step = it.next(); !step.done; step = it.next()) sections.push(step.value)
      }
      return () => {}
    },
    register(meta, component) { sections.push({ meta, component }); return () => {} }
  }
})

const section = sections.find(s => s.meta?.name === 'settings.section')
if (!section) {
  console.error('FAIL: plugin registered no settings.section')
  process.exit(1)
}

const { act } = React
const root = ReactDOMClient.createRoot(window.document.getElementById('root'))
const text = () => window.document.body.textContent.replace(/\s+/g, ' ').trim()
const click = async (label) => {
  const btn = [...window.document.querySelectorAll('button')].find(b => b.textContent.trim() === label)
  if (!btn) {
    throw new Error(`button "${label}" not found; buttons present: `
      + [...window.document.querySelectorAll('button')].map(b => b.textContent.trim()).join(' | '))
  }
  await act(async () => {
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 20))
  })
}
const settle = (ms = 30) => act(async () => { await new Promise(r => setTimeout(r, ms)) })

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}

await act(async () => {
  root.render(React.createElement(section.component, { close() {} }))
  await new Promise(r => setTimeout(r, 30))
})

// The field paints its first frame synchronously on mount; drive one animation
// frame too so the rAF path is exercised rather than only the initial paint.
await act(async () => {
  pumpFrames(2)
  await new Promise(r => setTimeout(r, 20))
})

console.log('section:', section.meta.id, '| label:', section.meta.label?.())

// The regression guard: a blank panel is exactly what jsx-as-h produced.
check('section paints visible text', text().length > 0, `${text().length} chars`)
check('stat cards', /目标数/.test(text()) && /工具调用/.test(text()))

// --- drift field (default tab) --------------------------------------------
check('field tab is default', /漂移场（半径/.test(text()))
check('field canvas mounted', window.document.querySelectorAll('canvas').length === 1)
check('field legend rendered', /聚焦 <0\.35/.test(text()) && /严重 0\.65\+/.test(text()))
check('canvas actually drew', canvasCalls.total > 100, `${canvasCalls.total} ops`)
check('canvas drew goal points', (canvasCalls.byOp.arc ?? 0) >= 3, `arc×${canvasCalls.byOp.arc ?? 0}`)
check('canvas drew filaments', (canvasCalls.byOp.quadraticCurveTo ?? 0) >= 3,
  `quadraticCurveTo×${canvasCalls.byOp.quadraticCurveTo ?? 0}`)
check('canvas drew band rings', (canvasCalls.byOp.ellipse ?? 0) >= 3, `ellipse×${canvasCalls.byOp.ellipse ?? 0}`)
check('canvas drew ring labels', (canvasCalls.byOp.fillText ?? 0) >= 3, `fillText×${canvasCalls.byOp.fillText ?? 0}`)

// Hover must resolve a point from the drawn projection and show its tooltip.
const canvasEl = window.document.querySelector('canvas')
const drawnPoints = canvasEl.__glPoints ?? []
check('field exposes hit-test points', drawnPoints.length === 3, `${drawnPoints.length} points`)
if (drawnPoints.length) {
  const target = drawnPoints[0]
  await act(async () => {
    canvasEl.dispatchEvent(new window.MouseEvent('mousemove', {
      bubbles: true,
      clientX: Math.round(target.x),
      clientY: Math.round(target.y)
    }))
    await new Promise(r => setTimeout(r, 30))
  })
  check('hover shows tooltip', /轮 ·/.test(text()) && /次调用/.test(text()), text().slice(-120))
  // React synthesizes onMouseLeave from mouseout + relatedTarget; a raw
  // 'mouseleave' event never reaches it, so leave the way the browser does.
  await act(async () => {
    canvasEl.dispatchEvent(new window.MouseEvent('mouseout', {
      bubbles: true,
      relatedTarget: window.document.body
    }))
    await new Promise(r => setTimeout(r, 20))
  })
  check('hover tooltip clears', !/次调用/.test(text()))
}

// --- clusters --------------------------------------------------------------
await click('失败聚类')
check('cluster table', /失败聚类（硬事实/.test(text()) && /文件未先读取/.test(text()))
check('cluster counts', /26/.test(text()))
check('label rollup chips', /×30/.test(text()))
const row = window.document.querySelector('tbody tr')
await act(async () => {
  row.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await new Promise(r => setTimeout(r, 20))
})
check('cluster row expands', /原始错误样本/.test(text()) && /turn 3/.test(text()))

// --- drift table -----------------------------------------------------------
await click('目标漂移')
check('drift tab', /目标漂移（排序信号/.test(text()))
check('drift rows + bands', /严重漂移/.test(text()) && /0\.712/.test(text()))

// --- worst turns -----------------------------------------------------------
await click('漂移轮次')
check('turns tab', /单轮最漂移/.test(text()) && /该轮产出/.test(text()))

// --- embedding config ------------------------------------------------------
await click('向量模型')
await settle(60)
check('config tab loads', /向量模型/.test(text()) && /Base URL/.test(text()))
check('config shows current model', /doubao-embedding-vision/.test(text()))
check('config key badge', /key：credentials ✓/.test(text()))
check('config never shows a key value', !/sk-[A-Za-z0-9]{10,}/.test(text()))
check('preset list rendered', window.document.querySelectorAll('select option').length >= 3)

// Edit the model, then probe: the draft must reach /probe, not the saved config.
const modelInput = [...window.document.querySelectorAll('input.gl-input')]
  .find(i => i.value === 'doubao-embedding-vision')
check('model input is editable', Boolean(modelInput))
if (modelInput) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  await act(async () => {
    setter.call(modelInput, 'text-embedding-3-small')
    modelInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 40))
  })
  await settle()
  check('dirty badge appears', /有未保存修改/.test(text()))

  const probeBtn = [...window.document.querySelectorAll('button')].find(b => b.textContent.trim() === '测试连接')
  await act(async () => {
    probeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 60))
  })
  const probeReq = requests.filter(r => r.path.endsWith('/probe'))
  check('probe called POST /probe', probeReq.length === 1 && probeReq[0].method === 'POST')
  check('probe used the unsaved draft model', /text-embedding-3-small/.test(probeReq[0]?.body ?? ''))
  check('probe result shown', /连接成功/.test(text()) && /1536 维/.test(text()))

  const saveBtn = [...window.document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存')
  check('save enabled after edit', saveBtn && !saveBtn.disabled)
  await act(async () => {
    saveBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 60))
  })
  const putReq = requests.filter(r => r.path.endsWith('/config') && r.method === 'PUT')
  check('save called PUT /config', putReq.length === 1)
  check('save confirmation shown', /已保存/.test(text()))
}

// --- drift correction ------------------------------------------------------
await click('漂移纠正')
await settle(60)
check('correction tab loads', /漂移纠正/.test(text()) && /触发阈值/.test(text()))
check('correction defaults to off', /未开启/.test(text()))
check('correction promises not to mutate goals', /不会修改你的目标/.test(text()))
check('correction shows session state', /已观察轮次/.test(text()) && /session-abc123/.test(text()))
check('correction shows injection count', /已提醒/.test(text()) && /0\.620/.test(text()))
check('correction shows wiring self-check', /已接管 1 个会话/.test(text()))

// Turning it on must PUT /correction with enabled:true.
const enableBox = [...window.document.querySelectorAll('input[type="checkbox"]')]
  .find(i => i.closest('label')?.textContent.includes('启用漂移纠正'))
check('enable checkbox present', Boolean(enableBox))
if (enableBox) {
  await act(async () => {
    enableBox.click()
    await new Promise(r => setTimeout(r, 30))
  })
  const corrSave = [...window.document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存')
  check('save enabled after toggling', corrSave && !corrSave.disabled)
  await act(async () => {
    corrSave.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise(r => setTimeout(r, 60))
  })
  const corrPut = requests.filter(r => r.path.endsWith('/correction') && r.method === 'PUT')
  check('toggling calls PUT /correction', corrPut.length === 1)
  check('PUT body enables correction', /"enabled":true/.test(corrPut[0]?.body ?? ''))
  check('correction confirmation shown', /已开启/.test(text()))
}

// --- unmount ---------------------------------------------------------------
await act(async () => { root.unmount() })
await settle(20)

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
