// dsh-goal-ledger — client half.
//
// Renders a "目标台账" section inside DSH's settings panel: failure clusters,
// goal drift ranking, and per-goal turn detail, all fetched from the host half.
//
// Notes learned from the DSH client sandbox:
//  - `fetch` is replaced by a teaching trap; use `window.fetch` to reach the
//    page's real realm.
//  - There is no global setInterval/timer in the dynamic client realm; declare
//    `timer` in inject and use timerSvc.interval, or avoid polling entirely.
//  - `ctx.slots.inject(name, generator)` + `ctx.slots.register(meta, Component)`.
window.__ModuleLoader__.load({
  id: 'dsh-goal-ledger',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useMemo } = React
    const { jsx: h } = require('react/jsx-runtime')

    const API = '/dsh-goal-ledger-7821'

    // fetch must come from the page realm: the sandbox replaces the bare global.
    const api = {
      get(path) {
        return window.fetch(API + path, { headers: { accept: 'application/json' } })
          .then(r => r.json())
      },
      post(path, body) {
        return window.fetch(API + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {})
        }).then(r => r.json())
      }
    }

    const styles = {
      insert(css) {
        if (document.querySelector('style[data-plugin-css="dsh-goal-ledger"]')) return
        const tag = document.createElement('style')
        tag.dataset.pluginCss = 'dsh-goal-ledger'
        tag.textContent = css
        document.head.appendChild(tag)
      }
    }

    styles.insert(`
.gl-root { display:flex; flex-direction:column; gap:16px; padding:4px 2px 24px; font-size:13px; }
.gl-toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; }
.gl-btn { padding:6px 14px; border-radius:6px; border:1px solid var(--dsw-border, #d0d0d0);
  background:var(--dsw-surface, #fff); color:inherit; cursor:pointer; font-size:13px; }
.gl-btn:hover:not(:disabled) { border-color:var(--dsw-accent, #4a7cff); }
.gl-btn:disabled { opacity:.5; cursor:default; }
.gl-btn-primary { background:var(--dsw-accent, #4a7aFF); border-color:var(--dsw-accent, #4a7aFF); color:#fff; }
.gl-muted { opacity:.65; font-size:12px; }
.gl-cards { display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px; }
.gl-card { border:1px solid var(--dsw-border, #e0e0e0); border-radius:8px; padding:10px 12px; }
.gl-card-v { font-size:20px; font-weight:600; line-height:1.2; }
.gl-card-k { font-size:11px; opacity:.65; margin-top:2px; }
.gl-section-title { font-size:14px; font-weight:600; margin:4px 0 2px; }
.gl-table { width:100%; border-collapse:collapse; font-size:12px; }
.gl-table th { text-align:left; font-weight:600; padding:6px 8px; border-bottom:1px solid var(--dsw-border,#e0e0e0); opacity:.7; }
.gl-table td { padding:6px 8px; border-bottom:1px solid var(--dsw-border,#f0f0f0); vertical-align:top; }
.gl-table tr:hover td { background:rgba(128,128,128,.06); }
.gl-num { font-variant-numeric:tabular-nums; white-space:nowrap; }
.gl-tag { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px; white-space:nowrap; }
.gl-tag-red { background:rgba(220,53,69,.14); color:#c82333; }
.gl-tag-orange { background:rgba(253,126,20,.16); color:#b25b00; }
.gl-tag-yellow { background:rgba(255,193,7,.2); color:#8a6d00; }
.gl-tag-green { background:rgba(40,167,69,.14); color:#1e7e34; }
.gl-tag-grey { background:rgba(128,128,128,.14); opacity:.85; }
.gl-obj { max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gl-mono { font-family:ui-monospace, Consolas, monospace; font-size:11px; }
.gl-empty { padding:28px 12px; text-align:center; opacity:.6; }
.gl-err { padding:10px 12px; border-radius:6px; background:rgba(220,53,69,.1); color:#c82333; font-size:12px; }
.gl-bar { height:4px; border-radius:2px; background:rgba(128,128,128,.2); overflow:hidden; margin-top:4px; }
.gl-bar > i { display:block; height:100%; background:currentColor; }
.gl-detail { border:1px solid var(--dsw-border,#e0e0e0); border-radius:8px; padding:10px 12px; margin-top:8px; }
.gl-sig { font-family:ui-monospace,Consolas,monospace; font-size:11px; opacity:.75;
  max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
`)

    const band = (d) => {
      if (d === null || d === undefined) return ['—', 'grey']
      if (d >= 0.65) return ['严重漂移', 'red']
      if (d >= 0.50) return ['偏题', 'orange']
      if (d >= 0.35) return ['有偏离', 'yellow']
      return ['聚焦', 'green']
    }

    const fmtTime = (ms) => {
      if (!ms) return '—'
      try {
        const d = new Date(ms)
        const pad = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
      } catch {
        return '—'
      }
    }

    function StatCards({ totals, totalFailures, distance }) {
      const failRate = totals.calls ? ((totalFailures / totals.calls) * 100).toFixed(1) + '%' : '—'
      const avg = distance && distance.items.length
        ? (distance.items.reduce((s, g) => s + g.meanDistance, 0) / distance.items.length)
        : null
      const cards = [
        ['目标数', totals.goals, '显式 ' + totals.explicitGoals + ' / 推断 ' + (totals.goals - totals.explicitGoals)],
        ['轮次', totals.turns, distance ? '可打分 ' + distance.scorableTurns : '未打分'],
        ['工具调用', totals.calls, '失败 ' + totalFailures + '（' + failRate + '）'],
        ['平均距离', avg === null ? '—' : avg.toFixed(3), avg === null ? '未启用嵌入' : band(avg)[0]]
      ]
      return h('div', { className: 'gl-cards' },
        cards.map(([k, v, sub]) =>
          h('div', { className: 'gl-card', key: k },
            h('div', { className: 'gl-card-v' }, String(v)),
            h('div', { className: 'gl-card-k' }, k + ' · ' + sub)
          )
        )
      )
    }

    function ClusterTable({ clusters }) {
      const [openKey, setOpenKey] = useState(null)
      if (!clusters || !clusters.length) {
        return h('div', { className: 'gl-empty' }, '没有工具失败记录 —— 这本身是个好消息。')
      }
      const max = clusters[0].count || 1
      return h('div', null,
        h('table', { className: 'gl-table' },
          h('thead', null, h('tr', null,
            h('th', null, '次数'),
            h('th', null, '类别'),
            h('th', null, '工具'),
            h('th', null, '错误特征'),
            h('th', null, '影响目标')
          )),
          h('tbody', null, clusters.map(c =>
            h(React.Fragment, { key: c.key },
              h('tr', {
                style: { cursor: 'pointer' },
                onClick: () => setOpenKey(openKey === c.key ? null : c.key)
              },
                h('td', { className: 'gl-num' },
                  h('div', null, c.count),
                  h('div', { className: 'gl-bar', style: { color: 'var(--dsw-accent,#4a7aff)' } },
                    h('i', { style: { width: Math.round((c.count / max) * 100) + '%' } })
                  )
                ),
                h('td', null, h('span', { className: 'gl-tag gl-tag-' + (c.count >= max * 0.5 ? 'red' : 'orange') }, c.label)),
                h('td', { className: 'gl-mono' }, c.tool),
                h('td', null, h('div', { className: 'gl-sig', title: c.signature }, c.signature)),
                h('td', { className: 'gl-num' }, c.goalCount + ' / ' + c.sessionCount)
              ),
              openKey === c.key && h('tr', null,
                h('td', { colSpan: 5 },
                  h('div', { className: 'gl-detail' },
                    h('div', { className: 'gl-muted', style: { marginBottom: 6 } }, '原始错误样本'),
                    h('div', { className: 'gl-mono', style: { whiteSpace: 'pre-wrap', wordBreak: 'break-all' } }, c.sample),
                    c.occurrences && c.occurrences.length > 0 && h('div', { style: { marginTop: 8 } },
                      h('div', { className: 'gl-muted' }, '出现位置'),
                      h('ul', { style: { margin: '4px 0 0', paddingLeft: 18 } },
                        c.occurrences.slice(0, 8).map((o, i) =>
                          h('li', { key: i, className: 'gl-mono' }, `turn ${o.turn} · ${o.objective}`)
                        )
                      )
                    )
                  )
                )
              )
            )
          ))
        )
      )
    }

    function DriftTable({ distance }) {
      if (!distance) {
        return h('div', { className: 'gl-empty' }, '未启用嵌入打分（缺少 embedding key）。')
      }
      const rows = [...distance.items].sort((a, b) => b.meanDistance - a.meanDistance)
      return h('table', { className: 'gl-table' },
        h('thead', null, h('tr', null,
          h('th', null, '平均距离'),
          h('th', null, '判定'),
          h('th', null, '轮次'),
          h('th', null, '调用'),
          h('th', null, '失败'),
          h('th', null, '目标')
        )),
        h('tbody', null, rows.map(g => {
          const [label, color] = band(g.meanDistance)
          return h('tr', { key: g.goalId },
            h('td', { className: 'gl-num' }, g.meanDistance.toFixed(3)),
            h('td', null, h('span', { className: 'gl-tag gl-tag-' + color }, label)),
            h('td', { className: 'gl-num' }, g.turnCount),
            h('td', { className: 'gl-num' }, g.totalCalls),
            h('td', { className: 'gl-num' }, g.failedCalls),
            h('td', null, h('div', { className: 'gl-obj', title: g.objective }, g.objective))
          )
        }))
      )
    }

    function WorstTurns({ distance }) {
      if (!distance || !distance.worstTurns || !distance.worstTurns.length) return null
      return h('table', { className: 'gl-table' },
        h('thead', null, h('tr', null,
          h('th', null, '距离'),
          h('th', null, '轮'),
          h('th', null, '调用'),
          h('th', null, '目标'),
          h('th', null, '该轮产出')
        )),
        h('tbody', null, distance.worstTurns.slice(0, 10).map((w, i) =>
          h('tr', { key: i },
            h('td', { className: 'gl-num' }, w.distance.toFixed(3)),
            h('td', { className: 'gl-num' }, w.turn),
            h('td', { className: 'gl-num' }, w.calls),
            h('td', null, h('div', { className: 'gl-obj', title: w.objective }, w.objective)),
            h('td', null, h('div', { className: 'gl-obj', title: w.preview }, w.preview))
          )
        ))
      )
    }

    function GoalLedgerSection() {
      const [status, setStatus] = useState(null)
      const [snapshot, setSnapshot] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [tab, setTab] = useState('clusters')

      const refreshStatus = useCallback(() => {
        api.get('/status')
          .then(s => {
            setStatus(s)
            if (s.snapshot) setSnapshot(s.snapshot)
          })
          .catch(e => setError('无法连接宿主：' + e.message))
      }, [])

      useEffect(() => { refreshStatus() }, [refreshStatus])

      const run = useCallback(() => {
        setBusy(true)
        setError(null)
        api.post('/analyze', {})
          .then(result => {
            if (result.error) setError(result.error)
            else { setSnapshot(result); refreshStatus() }
          })
          .catch(e => setError('分析失败：' + e.message))
          .finally(() => setBusy(false))
      }, [refreshStatus])

      const snap = snapshot
      const tabs = [
        ['clusters', '失败聚类'],
        ['drift', '目标漂移'],
        ['turns', '漂移轮次']
      ]

      return h('div', { className: 'gl-root' },
        h('div', { className: 'gl-toolbar' },
          h('button', {
            className: 'gl-btn gl-btn-primary',
            onClick: run,
            disabled: busy
          }, busy ? '分析中…' : (snap ? '重新分析' : '开始分析')),
          status && h('span', { className: 'gl-muted' },
            `嵌入：${status.embeddingConfigured ? status.embeddingModel + ' ✓' : '未配置'} · key 来源：${status.keySource}`),
          snap && h('span', { className: 'gl-muted' },
            `上次分析：${fmtTime(snap.generatedAt)} · 扫描 ${snap.sessionsScanned} 个会话`)
        ),

        error && h('div', { className: 'gl-err' }, error),

        !snap && !busy && h('div', { className: 'gl-empty' },
          '还没有分析结果。点「开始分析」扫描本机会话日志 —— 只读，不会修改任何会话。'),

        snap && h(React.Fragment, null,
          h(StatCards, {
            totals: snap.totals,
            totalFailures: snap.totalFailures,
            distance: snap.distance
          }),

          snap.distanceError && h('div', { className: 'gl-err' },
            '嵌入打分失败：' + snap.distanceError + ' —— 失败聚类仍然可用。'),

          h('div', { className: 'gl-toolbar' },
            tabs.map(([id, label]) =>
              h('button', {
                key: id,
                className: 'gl-btn',
                style: tab === id
                  ? { borderColor: 'var(--dsw-accent,#4a7aff)', fontWeight: 600 }
                  : undefined,
                onClick: () => setTab(id)
              }, label)
            )
          ),

          tab === 'clusters' && h(React.Fragment, null,
            h('div', { className: 'gl-section-title' }, '失败聚类（硬事实，按次数排序）'),
            h('div', { className: 'gl-muted', style: { marginBottom: 8 } },
              '工具报错是确定发生的事实，不受语义判断影响。点任意一行看原始错误与出现位置。'),
            snap.labelRollup && snap.labelRollup.length > 0 && h('div', { style: { marginBottom: 10 } },
              snap.labelRollup.map(l =>
                h('span', { key: l.label, className: 'gl-tag gl-tag-grey', style: { marginRight: 6 } },
                  `${l.label} ×${l.count}`)
              )
            ),
            h(ClusterTable, { clusters: snap.clusters })
          ),

          tab === 'drift' && h(React.Fragment, null,
            h('div', { className: 'gl-section-title' }, '目标漂移（排序信号，不是判决）'),
            h('div', { className: 'gl-muted', style: { marginBottom: 8 } },
              '距离 = 1 − cos(目标向量, 该轮输出向量)。距离高≠做错了：长技术任务天然会偏离最初措辞。请人工确认。'),
            h(DriftTable, { distance: snap.distance })
          ),

          tab === 'turns' && h(React.Fragment, null,
            h('div', { className: 'gl-section-title' }, '单轮最漂移'),
            h('div', { className: 'gl-muted', style: { marginBottom: 8 } },
              '纯工具调用轮次（无文字输出）已排除 —— 它们的向量没有意义。'),
            h(WorstTurns, { distance: snap.distance })
          )
        )
      )
    }

    const name = 'goal-ledger'
    const inject = ['slots']
    function apply(ctx) {
      ctx.slots.inject('settings.section', function* () {
        yield ctx.slots.register({
          name: 'settings.section',
          id: 'goal-ledger',
          order: 40,
          label: () => '目标台账'
        }, GoalLedgerSection)
      })
    }

    module.exports = { apply, inject, name }
    return module.exports
  }
})
