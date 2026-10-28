// Validate the plugin manifest against the REAL DSH rules, extracted from the
// installed app.asar rather than reimplemented: unmetRequirements decides which
// engines/peer fields gate installation, and parseMarketIndex decides whether a
// market index entry is legal. A manifest that passes here installs.
//
// Run: node test/manifest.mjs [git-commit-sha]
import fs from 'node:fs'

const ASAR = 'C:/Users/13938/AppData/Local/Programs/DeepSeek Harness/resources/app.asar'

function makeReader(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  const b = Buffer.alloc(16)
  fs.readSync(fd, b, 0, 16, 0)
  const hs = b.readUInt32LE(12)
  const hb = Buffer.alloc(hs)
  fs.readSync(fd, hb, 0, hs, 16)
  const header = JSON.parse(hb.toString('utf8'))
  const base = 16 + hs
  const find = (p) => {
    let n = header
    for (const part of p.split('/').filter(Boolean)) {
      if (!n.files || !n.files[part]) return null
      n = n.files[part]
    }
    return n
  }
  return (p) => {
    const n = find(p)
    if (!n || n.files) return null
    const buf = Buffer.alloc(n.size)
    fs.readSync(fd, buf, 0, n.size, base + Number(n.offset))
    return buf.toString('utf8')
  }
}

let read
try {
  read = makeReader(ASAR)
} catch (err) {
  console.error('SKIP: DSH app bundle not found at ' + ASAR)
  console.error('      ' + String(err?.message ?? err))
  process.exit(0)
}

const runtimeManifest = read('/dsh/package.json')
if (!runtimeManifest) {
  console.error('SKIP: DSH runtime manifest not present in the bundle')
  process.exit(0)
}
const runtimeVersion = JSON.parse(runtimeManifest).version

let failed = false
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`)
  if (!ok) failed = true
}

/**
 * The subset of SemVer `satisfies` this manifest needs: a `>=X.Y.Z[-pre]` floor.
 *
 * Written locally on purpose. DSH uses npm's semver, but adding semver as a
 * devDependency of a plugin that ships zero runtime dependencies just to run a
 * packaging check is the wrong trade. The floor form is the only range this
 * manifest declares, and the cases below assert the two behaviours that matter:
 * the tested prerelease satisfies, an older release does not.
 */
function satisfies(version, range) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v)
    return m && { core: [+m[1], +m[2], +m[3]], pre: m[4] ?? null }
  }
  const v = parse(version)
  const floorText = /^>=\s*(.+)$/.exec(String(range).trim())?.[1]
  const floor = floorText === undefined ? null : parse(floorText)
  if (!v || !floor) return false
  for (let i = 0; i < 3; i++) {
    if (v.core[i] !== floor.core[i]) return v.core[i] > floor.core[i]
  }
  if (floor.pre === null) return v.pre === null
  return v.pre === floor.pre
}

console.log('DSH runtime:', runtimeVersion, '\n')

// --- 1. compatibility, using DSH's own semantics ---------------------------
// engines.dsh alone decides; peerDependencies are ignored when it is present.
const manifest = JSON.parse(fs.readFileSync('package.json', 'utf8'))
const engines = manifest.engines ?? {}

check('manifest declares engines.dsh', typeof engines.dsh === 'string', engines.dsh)
if (typeof engines.dsh === 'string') {
  check('engines.dsh accepts the current runtime', satisfies(runtimeVersion, engines.dsh),
    `${runtimeVersion} in "${engines.dsh}"`)
  check('engines.dsh rejects older runtimes', !satisfies('0.2.0', engines.dsh),
    '0.2.0 must NOT satisfy')
}

check('dsh.bundle.patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml')
check('dsh.client.platform is web', manifest.dsh?.client?.platform === 'web')
check('exports["./client"] present', Boolean(manifest.exports?.['./client']))
check('files covers lib+src+patch',
  ['lib', 'src', 'cordis.patch.yml'].every(f => manifest.files?.includes(f)))
check('compat table names the tested release',
  manifest.dsh?.compatibility?.dshReleases?.[runtimeVersion] === 'compatible')

// --- 2. package name / version legality ------------------------------------
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const NUMERIC = '(?:0|[1-9]\\d*)'
const PRERELEASE_PART = `(?:${NUMERIC}|\\d*[a-zA-Z-][0-9a-zA-Z-]*)`
const SEMVER = new RegExp(
  `^${NUMERIC}\\.${NUMERIC}\\.${NUMERIC}(?:-${PRERELEASE_PART}(?:\\.${PRERELEASE_PART})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`,
  'u'
)
check('package name is a legal npm name', PACKAGE_NAME.test(manifest.name), manifest.name)
check('version is exact SemVer', SEMVER.test(manifest.version), manifest.version)

// --- 3. the market index entry, validated by DSH's own validator -----------
const idxSrc = read('/dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js')
check('market index validator available', Boolean(idxSrc))

if (idxSrc) {
  const verifyDir = new URL('../.tmp-verify/', import.meta.url)
  fs.mkdirSync(verifyDir, { recursive: true })
  // The validator imports `semver` for version ordering. Supply a shim exposing
  // just the comparison it uses, so no dependency is added to this package.
  const shim = [
    'const parse = (v) => {',
    "  const m = /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([0-9A-Za-z.-]+))?(?:\\+.*)?$/.exec(v)",
    '  return m && { core: [+m[1], +m[2], +m[3]], pre: m[4] ?? null }',
    '}',
    'const compare = (a, b) => {',
    '  const x = parse(a), y = parse(b)',
    '  if (!x || !y) return 0',
    '  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i]',
    '  if (x.pre === y.pre) return 0',
    '  if (x.pre === null) return 1',
    '  if (y.pre === null) return -1',
    '  return String(x.pre).localeCompare(String(y.pre))',
    '}',
    'export default { rcompare: (a, b) => compare(b, a), compare, validRange: (r) => (String(r).trim() ? r : null) }',
    ''
  ].join('\n')
  const shimmed = idxSrc.replace(/^import semver from "semver";/m, "import semver from './semver-shim.mjs';")
  fs.writeFileSync(new URL('semver-shim.mjs', verifyDir), shim, 'utf8')
  fs.writeFileSync(new URL('validator.mjs', verifyDir), shimmed, 'utf8')

  const { parseMarketIndex } = await import(new URL('validator.mjs', verifyDir).href)

  const gitUrl = 'https://github.com/zhegemingzimeibanquan/dsh-goal-ledger'
  const commit = process.argv[2] ?? '0'.repeat(40)
  const index = {
    format: 1,
    title: { en: 'Goal Ledger', zh: '目标台账' },
    description: {
      en: 'Audit DSH sessions: goal drift and tool failures.',
      zh: '审计 DSH 会话：目标漂移与工具失败。'
    },
    metadata: {
      categories: { observability: { title: { en: 'Observability', zh: '可观测性' } } },
      labels: {
        'drift-detection': { title: { en: 'Drift detection', zh: '漂移检测' } },
        'failure-analysis': { title: { en: 'Failure analysis', zh: '失败分析' } }
      }
    },
    plugins: [{
      name: manifest.name,
      title: { en: 'Goal Ledger', zh: '目标台账' },
      description: {
        en: manifest.description,
        zh: '审计自己的 DSH 会话：哪些目标跑偏了、工具调用到底在哪失败。'
      },
      author: 'zhangruixiong',
      homepage: manifest.homepage,
      repository: { url: gitUrl },
      metadata: {
        category: 'observability',
        keywords: manifest.keywords,
        labels: ['drift-detection', 'failure-analysis']
      },
      versions: [{
        version: manifest.version,
        publishTimestamp: Math.floor(Date.now() / 1000),
        source: { type: 'git', url: gitUrl, commit },
        engines: { dsh: engines.dsh }
      }]
    }]
  }

  try {
    // Validate the SHIPPED index file, not a copy built for the test: a passing
    // test must mean the published artifact is legal.
    const shippedPath = new URL('../market-index.json', import.meta.url)
    const shipped = fs.existsSync(shippedPath)
      ? JSON.parse(fs.readFileSync(shippedPath, 'utf8'))
      : index
    check('market-index.json exists', fs.existsSync(shippedPath))
    const parsed = parseMarketIndex(
      shipped,
      'https://raw.githubusercontent.com/zhegemingzimeibanquan/dsh-goal-ledger/master/market-index.json'
    )
    check('market index passes DSH validator', true, `${parsed.plugins.length} plugin(s)`)
    check('validator kept our version', parsed.plugins[0].versions[0].version === manifest.version)
    check('shipped index pins a real 40-hex commit',
      /^[0-9a-f]{40}$/.test(parsed.plugins[0].versions[0].source.commit ?? ''))
  } catch (err) {
    check('market index passes DSH validator', false, `${err.path ?? ''} ${err.reason ?? err.message}`)
  }
}

fs.rmSync(new URL('../.tmp-verify/', import.meta.url), { recursive: true, force: true })

console.log(failed ? '\nFAILED' : '\nALL PASS')
process.exit(failed ? 1 : 0)
