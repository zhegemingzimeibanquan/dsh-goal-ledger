// Mount the real settings section in jsdom and fail if ANY render error occurs.
//
// Why this exists: a useCallback dependency array that names a `const` declared
// later in the same component body throws a temporal-dead-zone ReferenceError
// when the component renders, which blanks the entire settings panel with no
// visible message. The older render test happened to pass while that bug was
// live, so this one watches the console and the thrown error directly, and can
// be pointed at any revision of the file:
//
//   node test/section-mount.mjs                    # current lib/client.js
//   node test/section-mount.mjs ../some/other.js   # a different revision
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] ? resolve(process.argv[2]) : join(here, '..', 'lib', 'client.js')

const src = await readFile(target, 'utf8')

// --- jsdom first, then react-dom: requiring react-dom before jsdom globals
// makes canUseDOM false and the whole event system disappears. ---
const { JSDOM } = await import('jsdom')
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost/',
  pretendToBeVisual: true
})
const { window } = dom
globalThis.window = window
globalThis.document = window.document
// Node exposes a getter-only `navigator` on newer versions; React only needs
// whatever the jsdom document already provides.
try { globalThis.navigator = window.navigator } catch { /* getter-only, fine */ }
globalThis.HTMLElement = window.HTMLElement
globalThis.Element = window.Element
globalThis.Node = window.Node
globalThis.requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((cb) => setTimeout(() => cb(Date.now()), 16))
globalThis.cancelAnimationFrame = window.cancelAnimationFrame?.bind(window) ?? clearTimeout
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const { act } = await import('react')

// Canvas 2D is absent in jsdom; record calls instead of failing on them.
const ctxStub = () => {
  const grad = { addColorStop() {} }
  return new Proxy({}, {
    get(_, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => grad
      if (prop === 'measureText') return () => ({ width: 40 })
      if (prop === 'canvas') return { width: 900, height: 400 }
      if (typeof prop === 'string' && [
        'fillStyle', 'strokeStyle', 'lineWidth', 'font', 'textAlign',
        'textBaseline', 'globalAlpha', 'lineCap', 'shadowColor', 'shadowBlur'
      ].includes(prop)) return ''
      return () => {}
    },
    set() { return true }
  })
}
window.HTMLCanvasElement.prototype.getContext = function () { return ctxStub() }
window.HTMLCanvasElement.prototype.getBoundingClientRect = function () {
  return { width: 900, height: 400, top: 0, left: 0, right: 900, bottom: 400 }
}

// The client half reads the host routes through window.fetch. jsdom has none, so
// answer the endpoints the section touches on mount with minimal valid bodies;
// this test is about rendering, not about the route contract.
const ROUTES = {
  '/dsh-goal-ledger-7821/status': {
    snapshot: {
      totals: { goals: 2, turns: 4 },
      distance: {
        items: [
          { goalId: 'g1', objective: 'first goal', meanDistance: 0.62, turnCount: 3, totalCalls: 5, failedCalls: 1, sessionStartedAt: 1790000000000 },
          { goalId: 'g2', objective: 'second goal', meanDistance: 0.21, turnCount: 2, totalCalls: 3, failedCalls: 0, sessionStartedAt: 1790500000000 }
        ],
        links: [{ a: 'g1', b: 'g2', distance: 0.15 }]
      }
    },
    analyzing: false
  },
  '/dsh-goal-ledger-7821/config': { baseUrl: 'https://example.invalid', model: 'm', keyEnv: 'K', batchSize: 4, enabled: true, presets: [], warnings: [] },
  '/dsh-goal-ledger-7821/correction': { enabled: false, threshold: 0.55, minStreak: 2, cooldownTurns: 3, sessions: [], wiring: { attached: 0, agentsService: true, errors: [] } },
  '/dsh-goal-ledger-7821/clusters': { clusters: [], totalFailures: 0 }
}
window.fetch = async (url) => {
  const key = Object.keys(ROUTES).find(k => String(url).includes(k))
  const body = key ? ROUTES[key] : {}
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body)
  }
}

// --- capture anything the client half logs ---------------------------------
const errors = []
const origError = console.error
console.error = (...args) => { errors.push(args.map(String).join(' ')); origError(...args) }
window.addEventListener('error', (e) => errors.push('window.error: ' + e.message))

// --- load the client half exactly as DSH does ------------------------------
let captured = null
const loader = { load: (r) => { captured = r } }
const fakeRequire = (id) => {
  if (id === 'react') return React
  if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }
  if (id === 'react-dom') return {}
  if (id === 'react-dom/client') return { createRoot }
  throw new Error('unexpected require: ' + id)
}
const instrumented = src
  .replace(/window\.__ModuleLoader__\.load\(/g, 'loader.load(')
new Function('window', 'document', 'navigator', 'require', 'loader', instrumented)(
  window, window.document, window.navigator, fakeRequire, loader
)

if (!captured) {
  console.log(`FAIL  client half did not register (${target})`)
  process.exit(1)
}

const mod = captured.factory(fakeRequire)

// Obtain the section exactly the way DSH does: run apply() with a slots stub and
// collect what it registers. Reaching into a private export would let a rename
// silently turn this test into a no-op.
const sections = []
try {
  mod.apply({
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
      register(meta, component) { sections.push({ meta: meta ?? {}, component }); return () => {} }
    }
  })
} catch (err) {
  console.log(`FAIL  apply() threw: ${err.message}`)
  process.exit(1)
}

const found = sections.find(s => s.meta?.name === 'settings.section')
if (!found) {
  console.log('FAIL  plugin registered no settings.section')
  process.exit(1)
}
const Component = found.component ?? found.meta?.component
if (typeof Component !== 'function') {
  console.log('FAIL  settings.section registered without a component')
  process.exit(1)
}

let failed = false
const check = (name, ok, detail) => {
  originalLog(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}
function originalLog(...a) { process.stdout.write(a.join(' ') + '\n') }

originalLog(`target: ${target}`)

// --- mount -----------------------------------------------------------------
const container = window.document.getElementById('root')
const root = createRoot(container)
let threw = null
try {
  await act(async () => {
    root.render(React.createElement(Component, { close() {} }))
  })
} catch (err) {
  threw = err
}

check('section renders without throwing', threw === null, threw ? String(threw.message).slice(0, 220) : '')
check('no render errors were logged', errors.length === 0,
  errors.length ? errors[0].slice(0, 260) : '')
check('something was actually rendered', container.innerHTML.length > 0,
  `${container.innerHTML.length} bytes of DOM`)

try { await act(async () => { root.unmount() }) } catch {}

console.error = origError
console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)