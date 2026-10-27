/**
 * Failure clustering for dsh-goal-ledger.
 *
 * Groups raw tool failures into actionable clusters. This is the part of the
 * ledger that is *evidence* rather than inference: a `data.error` either exists
 * or it does not, so a cluster count is a fact about what happened.
 *
 * Clustering is deliberately lexical (normalised error signature) instead of
 * embedding-based: error strings are highly templated, and the signature
 * captures the recurring cause better than a vector similarity would. Embedding
 * distance is used for goal drift elsewhere; mixing the two would blur which
 * signal is which.
 */

/** Strip volatile parts of an error string so identical causes collapse. */
export function errorSignature(errorText) {
  let s = String(errorText ?? '')
  // Unwrap the JSON envelope DSH stores errors in.
  try {
    const parsed = JSON.parse(s)
    if (parsed && typeof parsed === 'object') {
      s = String(parsed.message ?? parsed.error ?? parsed.msg ?? JSON.stringify(parsed))
    }
  } catch {
    // Not JSON — use the raw text.
  }
  s = s
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hash>')
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*/g, '<time>')
    .replace(/(?:[A-Za-z]:\\|\/)[^\s'"]{3,}/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|bytes?|KB|MB|GB)\b/gi, '<n>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
  // Keep the head of the message: the tail is usually the same noise.
  return s.slice(0, 220)
}

/**
 * A short human-readable label for a cluster.
 *
 * DSH's own tools report structured `{name, code}` errors rather than prose
 * ("FS_NOT_OBSERVED", "SEARCH_FAILED"), so codes are matched first and the
 * prose heuristics only handle third-party tool output. Without the code table
 * every native DSH failure fell into "其他" — 73 of 81 on real data.
 */
export function clusterLabel(signature) {
  const s = signature.toLowerCase()

  // DSH native tool error codes.
  const codes = [
    [/fs_not_observed/, '文件未先读取（需先 read 再改）'],
    [/fs_edit_not_found/, '待替换文本未找到'],
    [/fs_not_found/, '文件/路径不存在'],
    [/fs_stale_version/, '文件版本已过期（需重读）'],
    [/fs_ambiguous_edit/, '替换目标不唯一'],
    [/fs_/, '文件系统错误'],
    [/search_failed/, '搜索失败'],
    [/web_provider_credential_missing/, '联网搜索未配置凭据'],
    [/web_provider_error/, '联网请求失败'],
    [/unknown_tool/, '调用了不存在的工具'],
    [/timeout/, '超时'],
    [/permission|denied/, '权限被拒'],
    [/not_found/, '资源未找到']
  ]
  for (const [re, label] of codes) {
    if (re.test(s)) return label
  }

  // Third-party / shell prose.
  if (/enoent|no such file|cannot find path|系统找不到/.test(s)) return '文件/路径不存在'
  if (/eperm|eacces|permission denied|拒绝访问|access is denied/.test(s)) return '权限被拒'
  if (/timeout|timed out|超时|etimedout/.test(s)) return '超时'
  if (/econnrefused|econnreset|enotfound|network|socket hang|getaddrinfo/.test(s)) return '网络失败'
  if (/command not found|not recognized|不是内部或外部命令/.test(s)) return '命令不存在'
  if (/syntax error|unexpected token|parse|json/.test(s)) return '语法/解析错误'
  if (/exit code|non-zero|failed with|build failure|compilation/.test(s)) return '命令非零退出'
  if (/not a git repository|merge conflict|rejected|fatal:/.test(s)) return 'Git 操作失败'
  if (/401|403|unauthorized|forbidden|invalid api key/.test(s)) return '认证/授权失败'
  if (/429|rate limit|quota/.test(s)) return '限流/配额'
  if (/404|not found|找不到/.test(s)) return '资源未找到'
  if (/stale|version|conflict/.test(s)) return '状态冲突'
  return '其他'
}

/**
 * Cluster every failure across all goals.
 *
 * Returns clusters sorted by frequency, each carrying the goals it hit and one
 * representative raw error so the user can recognise the cause immediately.
 */
export function clusterFailures(items) {
  const byKey = new Map()

  for (const goal of items) {
    for (const turn of goal.turns ?? []) {
      for (const f of turn.failures ?? []) {
        const sig = errorSignature(f.error)
        if (!sig) continue
        const key = `${f.tool}::${sig}`
        let cluster = byKey.get(key)
        if (!cluster) {
          cluster = {
            key,
            tool: f.tool,
            signature: sig,
            label: clusterLabel(sig),
            count: 0,
            goals: new Set(),
            sessions: new Set(),
            sample: f.error,
            turns: []
          }
          byKey.set(key, cluster)
        }
        cluster.count += 1
        cluster.goals.add(goal.goalId)
        cluster.sessions.add(goal.sessionId)
        if (cluster.turns.length < 20) {
          cluster.turns.push({ goalId: goal.goalId, turn: turn.index, objective: (goal.objective ?? '').slice(0, 100) })
        }
      }
    }
  }

  const clusters = [...byKey.values()]
    .map(c => ({
      key: c.key,
      tool: c.tool,
      signature: c.signature,
      label: c.label,
      count: c.count,
      goalCount: c.goals.size,
      sessionCount: c.sessions.size,
      sample: c.sample,
      occurrences: c.turns
    }))
    .sort((a, b) => b.count - a.count || b.goalCount - a.goalCount)

  // Roll clusters up by human label for the top-level view.
  const byLabel = new Map()
  for (const c of clusters) {
    const cur = byLabel.get(c.label) ?? { label: c.label, count: 0, clusters: 0, tools: new Set() }
    cur.count += c.count
    cur.clusters += 1
    cur.tools.add(c.tool)
    byLabel.set(c.label, cur)
  }
  const labelRollup = [...byLabel.values()]
    .map(l => ({ label: l.label, count: l.count, clusters: l.clusters, tools: [...l.tools] }))
    .sort((a, b) => b.count - a.count)

  return { clusters, labelRollup, totalFailures: clusters.reduce((s, c) => s + c.count, 0) }
}
