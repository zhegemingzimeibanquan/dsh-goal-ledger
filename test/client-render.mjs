// Client-half render test.
//
// This exists because the panel once shipped blank while every host route
// returned 200: `h` was bound to `jsx` from react/jsx-runtime, whose third
// argument is the element KEY, not a child. Every call site passes children
// variadically, so the component rendered an empty tree — no error, no warning,
// nothing in the host log. Only rendering the real component catches it.
//
// Run: npm run test:render
// Needs devDependencies: react, react-dom, jsdom (installed by `npm install`).
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

let React, jsxRuntime, ReactDOMClient, JSDOM
try {
  React = require('react')
  jsxRuntime = require('react/jsx-runtime')
  ReactDOMClient = require('react-dom/client')
  ;({ JSDOM } = require('jsdom'))
} catch (err) {
  console.error('SKIP: render test needs react, react-dom and jsdom — run `npm install` first.')
  console.error('      ' + String(err?.message ?? err))
  process.exit(0)
}

// A synthetic snapshot covering every branch the three tabs render, so the test
// is offline and stable: no DSH instance, no session logs, no embedding calls.
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
    dim: 2048,
    turns: 207,
    scorableTurns: 159,
    items: [
      { goalId: 'g1', objective: '你在 C:\\Project\\dms-frontend 仓库工作', meanDistance: 0.493, turnCount: 20, totalCalls: 500, failedCalls: 20 },
      { goalId: 'g2', objective: '只读复核员，检查落库', meanDistance: 0.211, turnCount: 9, totalCalls: 120, failedCalls: 2 }
    ],
    worstTurns: [
      { distance: 0.812, turn: 7, calls: 31, objective: '你在 C:\\Project\\dms-frontend 仓库工作', preview: '先看一下目录结构' }
    ]
  }
}

const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1:58959/'
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
try { globalThis.navigator = window.navigator } catch { /* node exposes a getter-only navigator */ }
window.IS_REACT_ACT_ENVIRONMENT = true

const status = {
  analyzing: false,
  keySource: 'credentials',
  embeddingConfigured: true,
  embeddingModel: 'doubao-embedding-vision',
  embeddingBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  sessionsDir: snapshot.sessionsDir,
  snapshot
}
window.fetch = async (url) => {
  const path = String(url)
  const body = path.endsWith('/status') ? status : path.endsWith('/analyze') ? snapshot : { ok: true }
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
const click = (label) => {
  const btn = [...window.document.querySelectorAll('button')].find(b => b.textContent.trim() === label)
  if (!btn) {
    throw new Error(`button "${label}" not found; buttons present: `
      + [...window.document.querySelectorAll('button')].map(b => b.textContent.trim()).join(' | '))
  }
  act(() => { btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
}

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}

await act(async () => {
  root.render(React.createElement(section.component, { close() {} }))
  await new Promise(r => setTimeout(r, 30))
})

console.log('section:', section.meta.id, '| label:', section.meta.label?.())

// The regression guard: a blank panel is exactly what jsx-as-h produced.
check('section paints visible text', text().length > 0, `${text().length} chars`)
check('stat cards', /目标数/.test(text()) && /工具调用/.test(text()))
check('cluster table', /失败聚类（硬事实/.test(text()) && /文件未先读取/.test(text()))
check('cluster counts', /26/.test(text()))
check('label rollup chips', /×30/.test(text()))

click('目标漂移')
check('drift tab', /目标漂移（排序信号/.test(text()))
check('drift rows + bands', /严重漂移|偏题|有偏离|聚焦/.test(text()) && /0\.493/.test(text()))

click('漂移轮次')
check('turns tab', /单轮最漂移/.test(text()) && /该轮产出/.test(text()))

click('失败聚类')
const row = window.document.querySelector('tbody tr')
act(() => { row.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
check('cluster row expands', /原始错误样本/.test(text()) && /turn 3/.test(text()))

act(() => { root.unmount() })

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
