/**
 * Drift correction: turn "this goal is drifting" into a prompt the model can act on.
 *
 * Design constraints, all deliberate:
 *
 * 1. **Prompt only, never a goal mutation.** The objective the user wrote stays
 *    exactly as they wrote it. Rewriting it automatically would mean the anchor
 *    used for judging drift moves with the drift, and the user could end up
 *    with a goal they never asked for. The correction text is advisory.
 *
 * 2. **Cheap and bounded.** This runs between turns, so it must not delay one.
 *    The text is assembled from local signals (the objective, the last turn's
 *    distance, the recent drift trend) with no model call. A model call here
 *    would add seconds of latency to every turn and could itself drift.
 *
 * 3. **Opt-in and per-session.** Nothing is injected unless the user turned it
 *    on for that session. Off means the plugin contributes no prompt section at
 *    all, so behaviour is byte-identical to not having the plugin.
 *
 * 4. **Hysteresis.** A single high-distance turn is normal in long technical
 *    work — the README's own documented false positive. Correction fires only
 *    after sustained drift, and then stays quiet for a cooldown, so the model
 *    is not nagged into thrashing between "follow the objective" and "make
 *    progress".
 */

import { textOf, cleanUserText } from './session-reader.js'
import { cosineDistance } from './distance.js'

/** Bands, mirrored from the client so host and UI cannot disagree. */
export const BANDS = {
  green: 0.35,
  yellow: 0.5,
  orange: 0.65
}

export function bandOf(distance) {
  if (typeof distance !== 'number') return 'grey'
  if (distance >= BANDS.orange) return 'red'
  if (distance >= BANDS.yellow) return 'orange'
  if (distance >= BANDS.green) return 'yellow'
  return 'green'
}

export const DEFAULT_CORRECTION_CONFIG = {
  /** Master switch; false means the plugin contributes no prompt section. */
  enabled: false,
  /** Mean distance at which drift counts as real rather than natural variation. */
  threshold: 0.55,
  /** Consecutive drifting turns required before speaking. */
  minStreak: 2,
  /** Turns to stay quiet after speaking, so the model is not nagged. */
  cooldownTurns: 3,
  /** How many recent turns to look at when describing the trend. */
  windowSize: 6
}

const CONFIG_KEYS = new Set(Object.keys(DEFAULT_CORRECTION_CONFIG))

/**
 * Validate a partial correction config, keeping known-good values on bad input.
 *
 * @param {object} current - config to start from
 * @param {object} patch - fields to change
 * @returns {{ config: object, errors: string[] }}
 */
export function applyCorrectionPatch(current, patch) {
  const base = { ...DEFAULT_CORRECTION_CONFIG, ...(current ?? {}) }
  const next = {
    enabled: base.enabled === true,
    threshold: clampNumber(base.threshold, 0.2, 0.95, DEFAULT_CORRECTION_CONFIG.threshold),
    minStreak: clampInt(base.minStreak, 1, 10, DEFAULT_CORRECTION_CONFIG.minStreak),
    cooldownTurns: clampInt(base.cooldownTurns, 0, 20, DEFAULT_CORRECTION_CONFIG.cooldownTurns),
    windowSize: clampInt(base.windowSize, 2, 20, DEFAULT_CORRECTION_CONFIG.windowSize)
  }
  const errors = []
  const src = patch && typeof patch === 'object' ? patch : {}

  if ('enabled' in src) next.enabled = src.enabled === true

  if ('threshold' in src) {
    const n = Number(src.threshold)
    if (!Number.isFinite(n) || n < 0.2 || n > 0.95) {
      errors.push('threshold 必须在 0.2 到 0.95 之间')
    } else next.threshold = Math.round(n * 100) / 100
  }

  for (const key of ['minStreak', 'cooldownTurns', 'windowSize']) {
    if (!(key in src)) continue
    const n = Number(src[key])
    const lo = key === 'windowSize' ? 2 : (key === 'cooldownTurns' ? 0 : 1)
    const hi = key === 'windowSize' ? 20 : (key === 'cooldownTurns' ? 20 : 10)
    if (!Number.isInteger(n) || n < lo || n > hi) {
      errors.push(`${key} 必须是 ${lo} 到 ${hi} 之间的整数`)
    } else next[key] = n
  }

  for (const key of Object.keys(src)) {
    if (!CONFIG_KEYS.has(key)) errors.push(`未知字段：${key}`)
  }

  return { config: next, errors }
}

function clampNumber(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value)
  if (!Number.isInteger(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/**
 * Per-session correction state.
 *
 * Kept in the host process rather than the session log on purpose: this is
 * transient advisory state, and writing it into the log would make an opt-in
 * UI toggle a durable mutation of the user's session.
 */
export class CorrectionTracker {
  constructor() {
    this.sessions = new Map()
  }

  stateFor(sessionId) {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = {
        turnIndex: 0,
        /** distance per completed turn, oldest first */
        history: [],
        streak: 0,
        /** turn index at which we last spoke; null = never */
        lastSpokeTurn: null,
        /** what we last told the model, for dedupe */
        lastText: null,
        injections: 0
      }
      this.sessions.set(sessionId, s)
    }
    return s
  }

  /** Forget one session (on dispose) so a long-lived host does not leak. */
  forget(sessionId) {
    this.sessions.delete(sessionId)
  }

  clear() {
    this.sessions.clear()
  }

  /**
   * Record one completed turn's mean distance and decide whether to speak.
   *
   * @param {string} sessionId
   * @param {number|null} distance - that turn's distance, null when unscorable
   * @param {object} config - resolved correction config
   * @returns {{ speak: boolean, reason: string, streak: number, mean: number|null }}
   */
  observe(sessionId, distance, config) {
    const s = this.stateFor(sessionId)
    s.turnIndex += 1

    if (typeof distance === 'number') {
      s.history.push(distance)
      if (s.history.length > 200) s.history.shift()
      if (distance >= config.threshold) s.streak += 1
      else s.streak = 0
    }
    // An unscorable turn (tool-only) neither confirms nor resets the streak:
    // it carries no evidence either way.

    const recent = s.history.slice(-config.windowSize)
    const mean = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null

    const enough = s.streak >= config.minStreak
    // Cooldown counts *quiet turns since we last spoke*. Comparing absolute turn
    // indexes instead would be off by one — the turn we spoke on is itself
    // turn N, so `turnIndex - lastSpokeTurn` reaches cooldownTurns one turn
    // earlier than "stay quiet for cooldownTurns turns" implies.
    const quietSince = s.lastSpokeTurn === null ? Infinity : s.turnIndex - s.lastSpokeTurn - 1
    const cooling = quietSince < config.cooldownTurns
    const speak = Boolean(config.enabled) && enough && !cooling && mean !== null

    if (speak) {
      s.lastSpokeTurn = s.turnIndex
      s.injections += 1
    }

    return {
      speak,
      reason: !config.enabled ? 'disabled'
        : enough ? (cooling ? 'cooling' : 'drift')
          : 'below-streak',
      streak: s.streak,
      mean
    }
  }

  /** Current state, for the settings panel. */
  snapshot(sessionId) {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    const recent = s.history.slice(-10)
    return {
      turnIndex: s.turnIndex,
      streak: s.streak,
      lastSpokeTurn: s.lastSpokeTurn,
      injections: s.injections,
      recent,
      mean: recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null
    }
  }
}

/**
 * Build the advisory text injected into the system prompt.
 *
 * Written as a short, concrete instruction rather than a lecture: the model is
 * mid-task, and the only thing it needs from this is (a) the original wording,
 * (b) that its recent output drifted from it, (c) what to do next. It is
 * explicitly told not to discard work already done — otherwise the cheapest way
 * to "reduce drift" is to restart the task, which is worse than the drift.
 *
 * @param {object} input
 * @param {string} input.objective - the user's original objective, verbatim
 * @param {number} input.mean - recent mean distance
 * @param {number} input.streak - consecutive drifting turns
 * @param {number[]} input.recent - recent per-turn distances, oldest first
 * @returns {string}
 */
export function buildCorrectionText({ objective, mean, streak, recent }) {
  const obj = String(objective ?? '').trim()
  if (!obj) return ''
  // Keep the anchor short enough to survive prompt budgets, and mark the cut so
  // the model does not treat a truncated sentence as the complete objective.
  const anchor = obj.length > 600 ? obj.slice(0, 600) + ' …（原文已截断）' : obj
  const trend = (recent ?? []).map(d => d.toFixed(2)).join(' → ')
  const band = bandOf(mean)
  const bandLabel = band === 'red' ? '严重偏离'
    : band === 'orange' ? '明显偏离'
      : band === 'yellow' ? '轻度偏离' : '基本聚焦'

  return [
    '## 目标漂移提醒',
    '',
    `你正在执行的原始目标（用户原话，逐字引用）：`,
    '',
    `> ${anchor.replace(/\n/g, '\n> ')}`,
    '',
    `最近 ${streak} 轮输出与该目标的语义距离持续偏高（${bandLabel}，` +
      `近几轮 ${trend || mean.toFixed(2)}，均值 ${mean.toFixed(2)}）。`,
    '',
    '请按以下顺序处理，不要重开任务：',
    '',
    '1. 先用一两句话复述：原始目标要求交付什么，现在已经完成到哪一步。',
    '2. 对照原始目标，指出当前正在做的事情里，哪些其实不是它要求的。',
    '3. 回到目标本身，继续推进最直接缺失的那部分。已经完成的有效工作全部保留。',
    '',
    '注意：距离偏高也可能只是长任务的正常表现。如果你的输出确实仍在服务于上面的目标，' +
      '直接说明即可，不需要为了降低距离而改变做法。'
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Live turn scoring
// ---------------------------------------------------------------------------

/**
 * Incrementally score the running session's turns.
 *
 * The cached analysis cannot serve this: it only contains sessions already on
 * disk, and the one running right now is exactly the one correction is for. So
 * the scorer folds the live event stream instead — the same event shapes
 * `buildSession()` reads from the file, which keeps the live decision and the
 * later report consistent by construction.
 *
 * The fold mirrors the offline reader exactly: `turn/start` opens a turn,
 * `assistant/message` blocks accumulate into it (the message event carries no
 * turn index of its own), and `turn/end` closes it. A turn with no prose
 * (tool-only) is never embedded, because its vector would rank as maximally
 * drifted and drown the signal — the same rule `turnText()` applies offline.
 *
 * Scoring is lazy and single-flight: one embed call for the objective, one per
 * scored turn.
 */
export class LiveScorer {
  /**
   * @param {object} options
   * @param {Function} options.embed - async (texts) => vectors[], ≤ MAX_BATCH texts
   */
  constructor({ embed }) {
    if (typeof embed !== 'function') throw new TypeError('LiveScorer requires an embed function')
    this.embed = embed
    this.objectiveText = null
    this.objectiveVec = null
    this.objectivePromise = null
    /** open turn: { turn, texts: string[] } | null */
    this.current = null
    /** turn index → { distance: number|null, scorable: boolean } */
    this.scores = new Map()
  }

  /**
   * Set the anchor explicitly (e.g. the live goal's objective).
   *
   * An explicit goal beats the first user message: it is the wording the user
   * chose to persist, and the session may have opened with setup chatter.
   */
  setObjective(text) {
    const t = String(text ?? '').trim()
    if (t && !this.objectiveText) this.objectiveText = t.slice(0, 6000)
  }

  /**
   * Fold one session event synchronously.
   *
   * @returns {Promise<number|null>|number|null} the distance when a turn just
   *   closed and can be scored, otherwise null. Only `turn/end` with prose
   *   returns a promise, so the common path stays synchronous.
   */
  observe(event) {
    const type = event?.type
    const data = event?.data ?? {}

    if (type === 'user/message') {
      const raw = textOf(data)
      if (raw.startsWith('Additional workspace root instructions.') || raw.startsWith('<system-reminder>')) return null
      const txt = cleanUserText(raw)
      if (txt) this.setObjective(txt)
      return null
    }

    if (type === 'turn/start') {
      this.current = {
        turn: Number.isInteger(data.turn) ? data.turn : event.seq,
        texts: []
      }
      return null
    }

    if (type === 'assistant/message') {
      if (!this.current) return null
      const txt = textOf(data.message ?? {})
      if (txt) this.current.texts.push(txt.slice(0, 3000))
      return null
    }

    if (type === 'turn/end') {
      const turn = Number.isInteger(data.turn) ? data.turn : this.current?.turn
      const texts = this.current?.texts ?? []
      this.current = null
      if (!Number.isInteger(turn)) return null
      const text = texts.join('\n').trim()
      if (!text) {
        // Tool-only turn: no prose, so a distance here would be meaningless.
        this.scores.set(turn, { distance: null, scorable: false })
        return null
      }
      return this.scoreTurn(turn, text)
    }

    return null
  }

  /**
   * Replay events that happened before this scorer attached.
   *
   * Synchronous by design: it only recovers the anchor and the turn boundary,
   * never triggers embedding — re-scoring history would fire one embed call per
   * past turn the moment the plugin loads.
   */
  seed(events) {
    for (const event of events ?? []) {
      const type = event?.type
      const data = event?.data ?? {}
      if (type === 'user/message' && !this.objectiveText) {
        const raw = textOf(data)
        if (raw.startsWith('Additional workspace root instructions.') || raw.startsWith('<system-reminder>')) continue
        const txt = cleanUserText(raw)
        if (txt) this.setObjective(txt)
      } else if (type === 'turn/start') {
        this.current = { turn: Number.isInteger(data.turn) ? data.turn : event.seq, texts: [] }
      } else if (type === 'assistant/message' && this.current) {
        const txt = textOf(data.message ?? {})
        if (txt) this.current.texts.push(txt.slice(0, 3000))
      } else if (type === 'turn/end') {
        const turn = Number.isInteger(data.turn) ? data.turn : this.current?.turn
        const text = (this.current?.texts ?? []).join('\n').trim()
        this.current = null
        if (Number.isInteger(turn) && !this.scores.has(turn)) {
          this.scores.set(turn, { distance: null, scorable: Boolean(text) })
        }
      }
    }
  }

  /** Embed the objective once, then the turn, and return the cosine distance. */
  async scoreTurn(turn, text) {
    try {
      if (!this.objectiveText) return null
      if (!this.objectiveVec) {
        this.objectivePromise ??= this.embed([this.objectiveText]).then(v => v[0] ?? null)
        this.objectiveVec = await this.objectivePromise
      }
      if (!this.objectiveVec) return null
      const [vec] = await this.embed([text])
      if (!vec) return null
      const distance = Math.round(cosineDistance(this.objectiveVec, vec) * 10000) / 10000
      this.scores.set(turn, { distance, scorable: true })
      return distance
    } catch {
      // A failed embed must not stall the turn loop; correction just stays quiet.
      this.scores.set(turn, { distance: null, scorable: false })
      return null
    }
  }

  distanceOf(turn) {
    const e = this.scores.get(turn)
    return typeof e?.distance === 'number' ? e.distance : null
  }

  /** All scored distances in turn order, for the mean and the trend. */
  history() {
    return [...this.scores.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v.distance)
      .filter(d => typeof d === 'number')
  }
}
