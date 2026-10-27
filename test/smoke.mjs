// Standalone smoke test: exercise the analysis core against real session logs.
// Run: node test/smoke.mjs
import { collectGoals } from '../src/session-reader.js'
import { clusterFailures, errorSignature, clusterLabel } from '../src/failure-cluster.js'

const sessionsDir = process.env.DSH_HOME
  ? `${process.env.DSH_HOME}/sessions`
  : `${process.env.USERPROFILE}/.dsh/sessions`

console.log('sessions dir:', sessionsDir)

const collected = await collectGoals(sessionsDir)
console.log(`sessions scanned: ${collected.sessionsScanned}`)
console.log(`read errors: ${collected.errors.length}`)
console.log(`goals: ${collected.items.length}`)
console.log(`turns: ${collected.items.reduce((s, g) => s + g.turnCount, 0)}`)
console.log(`calls: ${collected.items.reduce((s, g) => s + g.totalCalls, 0)}`)
console.log(`failed calls: ${collected.items.reduce((s, g) => s + g.failedCalls, 0)}`)

const clustering = clusterFailures(collected.items)
console.log(`\n=== failure clusters: ${clustering.clusters.length} (total ${clustering.totalFailures}) ===`)
for (const c of clustering.clusters.slice(0, 10)) {
  console.log(`  ${String(c.count).padStart(3)}x  [${c.label}]  ${c.tool}  goals=${c.goalCount}`)
  console.log(`        ${c.signature.slice(0, 110)}`)
}
console.log('\n=== label rollup ===')
for (const l of clustering.labelRollup) {
  console.log(`  ${String(l.count).padStart(3)}x  ${l.label}  (${l.clusters} 种, ${l.tools.join('/')})`)
}

// Assertions: the two bugs this project already hit must stay fixed.
const goals = collected.items.length
if (goals === 0) {
  console.error('\nFAIL: no goals extracted — zstd frame splitting or turn parsing broke')
  process.exit(1)
}
const failures = collected.items.reduce((s, g) => s + g.failedCalls, 0)
console.log(`\nassert goals > 0: OK (${goals})`)
console.log(`assert failures detected: ${failures > 0 ? 'OK' : 'WARN'} (${failures})`)

const sample = errorSignature('{"message":"ENOENT: no such file or directory, open \'C:\\\\x\\\\y.txt\'"}')
console.log(`\nerrorSignature sample: ${sample}`)
console.log(`clusterLabel sample: ${clusterLabel(sample)}`)
