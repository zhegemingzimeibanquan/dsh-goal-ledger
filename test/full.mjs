// Full-pipeline test: extract → cluster → embed → score.
// Run: node test/full.mjs
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { collectGoals } from '../src/session-reader.js'
import { clusterFailures } from '../src/failure-cluster.js'
import { readCredentialRefs, scoreGoals, DEFAULT_KEY_ENV, turnText } from '../src/distance.js'

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const sessionsDir = join(DSH_HOME, 'sessions')

console.log('=== 1. 解析会话 ===')
const collected = await collectGoals(sessionsDir)
console.log(`会话 ${collected.sessionsScanned} · 目标 ${collected.items.length} · `
  + `轮次 ${collected.items.reduce((s, g) => s + g.turnCount, 0)} · `
  + `调用 ${collected.items.reduce((s, g) => s + g.totalCalls, 0)} · `
  + `失败 ${collected.items.reduce((s, g) => s + g.failedCalls, 0)}`)

console.log('\n=== 2. 失败聚类（无需网络）===')
const clustering = clusterFailures(collected.items)
for (const l of clustering.labelRollup) {
  console.log(`  ${String(l.count).padStart(3)}x  ${l.label}`)
}

console.log('\n=== 3. 解析 embedding key ===')
let key = process.env[DEFAULT_KEY_ENV]
let source = 'env'
if (!key) {
  try {
    const refs = readCredentialRefs(await readFile(join(DSH_HOME, '.credentials.yaml'), 'utf8'))
    if (refs[DEFAULT_KEY_ENV]) { key = refs[DEFAULT_KEY_ENV]; source = 'credentials' }
  } catch (e) {
    console.log('  读取凭据失败:', e.message)
  }
}
console.log(key ? `  OK（来源 ${source}，长度 ${key.length}）` : '  未找到 key')

if (key) {
  console.log('\n=== 4. 嵌入打分（真实 API 调用）===')
  // Limit to a few goals so the test is fast and cheap.
  const subset = collected.items.slice(0, 4)
  const scored = await scoreGoals(subset, {
    key,
    onProgress: (done, total) => process.stdout.write(`\r  进度 ${done}/${total}   `)
  })
  process.stdout.write('\n')
  console.log(`  模型 ${scored.model} · ${scored.dim} 维 · ${scored.scorableTurns}/${scored.turns} 轮可打分`)
  console.log('  各目标平均距离：')
  for (const g of scored.items) {
    console.log(`    ${g.meanDistance.toFixed(3)}  ${g.objective.slice(0, 60).replace(/\n/g, ' ')}`)
  }
  // Sanity: distances must be in [0,2] and not all identical.
  const ds = scored.items.map(g => g.meanDistance)
  const allSame = ds.every(d => Math.abs(d - ds[0]) < 1e-6)
  console.log(`\n  断言 距离在 [0,2]: ${ds.every(d => d >= 0 && d <= 2) ? 'OK' : 'FAIL'}`)
  console.log(`  断言 距离不全相同: ${!allSame ? 'OK' : 'FAIL'}`)
  if (ds.every(d => d >= 0 && d <= 2) && !allSame) {
    console.log('\n全部通过。')
  } else {
    process.exit(1)
  }
}
