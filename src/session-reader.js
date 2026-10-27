/**
 * Session log reader for dsh-goal-ledger.
 *
 * DSH writes each session as `session.v4.jsonl.zstd` under
 * `$DSH_HOME/sessions/<cwd-slug>/<session-id>/`.
 *
 * Two facts drive this implementation, both verified against real logs:
 *
 * 1. **The file is a concatenation of independent zstd frames**, one per append
 *    batch — thousands per session. A single `zstdDecompress` call returns only
 *    the first frame (the session header) and silently drops the conversation.
 *    So we split on the magic bytes and decode frame by frame.
 *
 * 2. **Failures live in `data.error`**, not a boolean `data.ok`. A `tool/result`
 *    event carries `data.message` plus an optional sibling `data.error`. Code
 *    that checks `data.ok` reports zero failures for every session.
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Decode every zstd frame in a buffer and concatenate the results. */
export function decompressFrames(buf) {
  const parts = []
  let pos = 0
  while (pos + 4 <= buf.length) {
    const idx = buf.indexOf(ZSTD_MAGIC, pos)
    if (idx < 0) break
    const next = buf.indexOf(ZSTD_MAGIC, idx + 4)
    const chunk = next < 0 ? buf.subarray(idx) : buf.subarray(idx, next)
    try {
      parts.push(zstdDecompressSync(chunk).toString('utf8'))
    } catch {
      // A damaged frame must not discard the rest of the log.
    }
    pos = next < 0 ? buf.length : next
  }
  return parts.join('')
}

/** Flatten an LLM message's content blocks into plain text. */
export function textOf(message) {
  if (!message || typeof message !== 'object') return ''
  const blocks = message.content
  if (typeof blocks === 'string') return blocks
  const out = []
  for (const b of blocks ?? []) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'text') out.push(b.text ?? '')
    // Reasoning is not part of the deliverable being scored.
    else if (b.type === 'tool-call') out.push(`[tool ${b.name}]`)
    else if (b.type === 'tool-result') out.push('[tool result]')
  }
  return out.filter(Boolean).join('\n')
}

/**
 * Strip host-injected boilerplate from a user message.
 *
 * DSH prepends the runtime-context snapshot and workspace instructions to the
 * first user message. Left in, they dominate any embedding and make every goal
 * look like every other goal — the exact "similar text, wrong meaning" failure.
 */
export function cleanUserText(txt) {
  const cutMarkers = [
    'Current runtime context.',
    'Additional workspace root instructions.',
    'Instructions from:',
    'The following workspace instructions may be relevant',
    '<system-reminder>'
  ]
  let cut = txt.length
  for (const m of cutMarkers) {
    const i = txt.indexOf(m)
    if (i >= 0 && i < cut) cut = i
  }
  const head = txt.slice(0, cut).trim()
  // Drop telemetry lines rather than cutting at the first marker: they can be
  // interleaved with the user's own multi-line task description.
  const drop = [
    'Time sampled while preparing',
    'Current run',
    'Browser time zone',
    'Elapsed since the preceding',
    'This snapshot supersedes earlier'
  ]
  return head
    .split('\n')
    .filter(line => !drop.some(m => line.includes(m)))
    .join('\n')
    .trim()
}

/** Parse raw JSONL text into events, tolerating malformed lines. */
export function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      events.push(JSON.parse(s))
    } catch {
      // Skip unparseable lines; a truncated tail is normal for a live session.
    }
  }
  return events
}

/** Read and parse one session log file. */
export async function readSessionLog(path) {
  const buf = await readFile(path)
  return parseEvents(decompressFrames(buf))
}

/**
 * Build goal + turn trajectories from a session's event stream.
 *
 * Most sessions never call `create_goal`, so an explicit goal is the exception.
 * For the rest the first real user ask becomes the anchor (`source: 'derived'`)
 * — it is what the user actually wanted, and the only stable anchor available.
 */
export function buildSession(events) {
  const header = events.find(e => e.type === 'session')
  if (!header) return null

  const session = {
    id: header.id,
    cwd: header.cwd,
    createdAt: header.createdAt,
    agentPreset: header.agentPreset
  }

  const goals = []
  let currentGoal = null
  const turns = []
  let turn = null
  const pendingCalls = new Map()

  for (const e of events) {
    const t = e.type
    const data = e.data ?? {}

    if (t === 'goal/change') {
      const g = data.goal ?? {}
      if (data.operation === 'create') {
        currentGoal = {
          id: g.id,
          objective: g.objective ?? '',
          createdAt: e.time,
          completedAt: null,
          source: 'explicit',
          turns: []
        }
        goals.push(currentGoal)
      } else if (data.operation === 'complete' && currentGoal) {
        currentGoal.completedAt = e.time
        currentGoal.finalPhase = g.phase ?? 'complete'
      }
    } else if (t === 'turn/start') {
      turn = {
        index: data.turn ?? e.seq,
        started: e.time,
        user: '',
        assistant: [],
        tools: [],
        failures: [],
        calls: 0,
        failed: 0
      }
    } else if (t === 'user/message' && turn) {
      const raw = textOf(data)
      if (raw.startsWith('Additional workspace root instructions.') || raw.startsWith('<system-reminder>')) continue
      const txt = cleanUserText(raw)
      if (txt) turn.user = `${turn.user}\n${txt}`.trim().slice(0, 4000)
    } else if (t === 'assistant/message' && turn) {
      const txt = textOf(data.message ?? {})
      if (txt) turn.assistant.push(txt.slice(0, 3000))
    } else if (t === 'tool/call') {
      const callId = data.callId ?? data.message?.toolCallId
      pendingCalls.set(callId, { name: data.name, args: (data.arguments ?? '').slice(0, 300) })
      if (turn) {
        turn.calls += 1
        turn.tools.push(data.name)
      }
    } else if (t === 'tool/result') {
      const callId = data.toolCallId ?? data.message?.toolCallId
      const call = pendingCalls.get(callId)
      pendingCalls.delete(callId)
      if (data.error && turn) {
        turn.failed += 1
        turn.failures.push({
          tool: call?.name ?? 'unknown',
          error: JSON.stringify(data.error).slice(0, 400)
        })
      }
    } else if (t === 'turn/end') {
      if (turn) {
        turn.ended = e.time
        if (data.usage && typeof data.usage === 'object') turn.usage = data.usage
        turns.push(turn)
        turn = null
      }
    }
  }

  if (currentGoal) {
    currentGoal.turns = turns
    currentGoal.sessionId = session.id
    currentGoal.cwd = session.cwd
    return { session, goals }
  }

  const firstUser = turns.find(x => x.user)?.user ?? ''
  if (!firstUser) return { session, goals: [] }
  return {
    session,
    goals: [{
      id: `derived-${session.id}`,
      objective: firstUser.slice(0, 1500),
      createdAt: turns[0]?.started,
      completedAt: null,
      source: 'derived',
      turns,
      sessionId: session.id,
      cwd: session.cwd
    }]
  }
}

/** Walk $DSH_HOME/sessions and return every session log path. */
export async function listSessionLogs(sessionsDir) {
  const out = []
  if (!existsSync(sessionsDir)) return out
  const stack = [sessionsDir]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.name.endsWith('.jsonl.zstd') || ent.name.endsWith('.jsonl.zst')) out.push(p)
    }
  }
  return out.sort()
}

/** Collect all goals from every session under `sessionsDir`. */
export async function collectGoals(sessionsDir, options = {}) {
  const { cwdFilter, limit = 0 } = options
  let logs = await listSessionLogs(sessionsDir)
  if (limit > 0) logs = logs.slice(0, limit)

  const items = []
  let scanned = 0
  const errors = []
  for (const path of logs) {
    let events
    try {
      events = await readSessionLog(path)
    } catch (err) {
      errors.push({ path, error: String(err?.message ?? err) })
      continue
    }
    scanned += 1
    const built = buildSession(events)
    if (!built) continue
    if (cwdFilter && !String(built.session.cwd ?? '').includes(cwdFilter)) continue
    for (const g of built.goals) {
      if (!g.turns.length) continue
      items.push({
        goalId: g.id,
        objective: g.objective,
        source: g.source,
        completed: g.completedAt !== null,
        createdAt: g.createdAt,
        completedAt: g.completedAt,
        sessionId: g.sessionId,
        cwd: g.cwd,
        turnCount: g.turns.length,
        failedCalls: g.turns.reduce((s, t) => s + t.failed, 0),
        totalCalls: g.turns.reduce((s, t) => s + t.calls, 0),
        turns: g.turns
      })
    }
  }
  return { sessionsScanned: scanned, errors, items }
}
