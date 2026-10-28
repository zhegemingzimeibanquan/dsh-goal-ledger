// dsh-goal-ledger — client half.
//
// Renders a "目标台账" section inside DSH's settings panel: a drift field, failure
// clusters, goal drift ranking, and an editable embedding endpoint.
//
// Notes learned from the DSH client sandbox:
//  - `fetch` is replaced by a teaching trap; use `window.fetch` to reach the
//    page's real realm.
//  - There is no global setInterval/timer in the dynamic client realm; declare
//    `timer` in inject and use timerSvc.interval, or avoid polling entirely.
//    Animation here uses requestAnimationFrame, which the page owns.
//  - `ctx.slots.inject(name, generator)` + `ctx.slots.register(meta, Component)`.
//  - The bundle is served as ONE file with no bundler: it cannot require a
//    relative sibling, so the canvas renderer lives in this file.
window.__ModuleLoader__.load({
  id: 'dsh-goal-ledger',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { useState, useEffect, useCallback, useMemo, useRef } = React

    // `h` must be createElement, NOT jsx from react/jsx-runtime.
    //
    // jsx(type, props, key) — its third parameter is the element KEY, not a
    // child. Every call site below passes children variadically, so binding
    // `h` to jsx silently renders empty elements: the section appears in the
    // settings nav and then paints a blank page. createElement(type, props,
    // ...children) matches the call sites exactly.
    const h = React.createElement

    const API = '/dsh-goal-ledger-7821'

    // fetch must come from the page realm: the sandbox replaces the bare global.
    const api = {
      get(path) {
        return window.fetch(API + path, { headers: { accept: 'application/json' } })
          .then(r => r.json())
      },
      send(path, method, body) {
        return window.fetch(API + path, {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {})
        }).then(r => r.json())
      },
      post(path, body) { return api.send(path, 'POST', body) },
      put(path, body) { return api.send(path, 'PUT', body) }
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
.gl-tag-red { background:rgba(255,210,74,.24); color:#8a6800; }
.gl-tag-orange { background:rgba(232,148,74,.20); color:#96551c; }
.gl-tag-yellow { background:rgba(53,214,176,.20); color:#1d7f6a; }
.gl-tag-green { background:rgba(77,159,254,.18); color:#2f6fb8; }
.gl-tag-grey { background:rgba(128,128,128,.14); opacity:.85; }
.gl-obj { max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.gl-mono { font-family:ui-monospace, Consolas, monospace; font-size:11px; }
.gl-empty { padding:28px 12px; text-align:center; opacity:.6; }
.gl-err { padding:10px 12px; border-radius:6px; background:rgba(220,53,69,.1); color:#c82333; font-size:12px; }
.gl-ok { padding:8px 12px; border-radius:6px; background:rgba(40,167,69,.12); color:#1e7e34; font-size:12px; }
.gl-bar { height:4px; border-radius:2px; background:rgba(128,128,128,.2); overflow:hidden; margin-top:4px; }
.gl-bar > i { display:block; height:100%; background:currentColor; }
.gl-detail { border:1px solid var(--dsw-border,#e0e0e0); border-radius:8px; padding:10px 12px; margin-top:8px; }
.gl-sig { font-family:ui-monospace,Consolas,monospace; font-size:11px; opacity:.75;
  max-width:520px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

/* --- drift field ------------------------------------------------------- */
.gl-field-wrap { position:relative; border-radius:12px; overflow:hidden;
  border:1px solid rgba(120,150,180,.28); background:#0b1219; }
.gl-field-canvas { display:block; width:100%; height:400px; cursor:crosshair; }
.gl-field-legend { position:absolute; left:12px; bottom:10px; display:flex; gap:12px;
  flex-wrap:wrap; align-items:center; font-size:11px; color:rgba(198,214,228,.82);
  background:rgba(8,14,20,.55); padding:5px 9px; border-radius:6px;
  backdrop-filter:blur(3px); pointer-events:none; }
.gl-legend-dot { display:inline-block; width:7px; height:7px; border-radius:50%;
  margin-right:5px; vertical-align:middle; }
.gl-legend-sep { opacity:.35; }
.gl-legend-line { display:inline-block; width:14px; height:0; margin-right:5px;
  vertical-align:middle; border-top:1px solid; }
.gl-legend-line-weak { border-color:rgba(140,186,220,.75); }
.gl-legend-line-strong { border-color:rgba(255,214,140,.95); }
.gl-field-tip { position:absolute; pointer-events:none; z-index:3; max-width:320px;
  background:rgba(10,17,24,.94); border:1px solid rgba(140,180,215,.35);
  border-radius:8px; padding:8px 10px; font-size:11.5px; line-height:1.5;
  color:#dbe6f0; box-shadow:0 8px 28px rgba(0,0,0,.55); }
.gl-field-tip b { color:#ffd479; font-weight:600; }
.gl-field-tip .gl-tip-obj { display:block; margin:3px 0 5px; color:#c3d3e2;
  max-height:3.2em; overflow:hidden; }
.gl-field-tip .gl-tip-meta { color:#8fa7bb; font-variant-numeric:tabular-nums; }
.gl-field-hint { position:absolute; right:12px; top:10px; font-size:11px;
  color:rgba(180,200,218,.55); pointer-events:none; }

/* --- config form ------------------------------------------------------- */
.gl-form { display:flex; flex-direction:column; gap:12px; max-width:620px; }
.gl-field { display:flex; flex-direction:column; gap:4px; }
.gl-label { font-size:12px; font-weight:600; opacity:.8; }
.gl-input, .gl-select { padding:6px 10px; border-radius:6px; font-size:12.5px;
  border:1px solid var(--dsw-border,#d0d0d0); background:var(--dsw-surface,#fff);
  color:inherit; font-family:inherit; width:100%; box-sizing:border-box; }
.gl-input:focus, .gl-select:focus { outline:none; border-color:var(--dsw-accent,#4a7aff); }
.gl-hint { font-size:11px; opacity:.6; }
.gl-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.gl-form-note { font-size:11.5px; opacity:.7; line-height:1.6;
  border-left:2px solid rgba(120,150,180,.4); padding-left:10px; }
.gl-badge { display:inline-block; padding:1px 7px; border-radius:10px; font-size:11px;
  background:rgba(95,179,217,.16); color:#2b7396; }
.gl-badge-warn { background:rgba(255,193,7,.2); color:#8a6d00; }
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

    // ---------------------------------------------------------------------
    // Drift field: dark starfield, one light per goal.
    //
    // Every channel carries data, and each one answers a different question:
    //   radius  — how far this goal's session drifted from the goal as asked
    //             (mean cosine distance over its scorable turns)
    //   angle   — WHEN the session started, clockwise from 12 o'clock, old→new
    //   colour  — the distance band, same numbers as the tables
    //   size    — turn count (log), so one long session cannot dwarf the rest
    //   edges   — similarity BETWEEN goals: same topic (faint) or the same
    //             request asked twice (bright, usually a reusable path)
    //
    // The edges are what makes this a network instead of a star: goal-to-goal
    // similarity is already computed for scoring, so the links cost no extra
    // embedding call. Decoration (dust, core bloom, orbital arcs, point spray)
    // is confined to drawField() and never encodes anything.
    // ---------------------------------------------------------------------

    // Four bands, four distinguishable hues — the first two used to be two
    // near-identical gray-blues on a near-black field, which read as three
    // bands. Blue = still on target, teal = slightly off, orange = off topic,
    // bright gold = badly drifted. Same palette drives the table tags.
    const BAND_COLORS = {
      green: '#4d9ffe',
      yellow: '#35d6b0',
      orange: '#e8944a',
      red: '#ffd24a',
      grey: '#8fa7bb'
    }
    const BAND_GLOW = {
      green: [77, 159, 254],
      yellow: [53, 214, 176],
      orange: [232, 148, 74],
      red: [255, 210, 74],
      grey: [143, 167, 187]
    }
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
    /** Distance that maps to the outer rim; leaves headroom past the 0.65 band. */
    const R_MAX_DIST = 0.8
    /** Band thresholds, in the same numbers the tables print. */
    const BANDS = [
      { at: 0.35, key: 'yellow', label: '有偏离' },
      { at: 0.50, key: 'orange', label: '偏题' },
      { at: 0.65, key: 'red', label: '严重' }
    ]
    /** Edge classes: same topic vs the same request asked twice. */
    const LINK_STRONG = 0.18
    const LINK_WEAK = 0.42
    /** Wedge at 12 o'clock where the time axis wraps (old→new seam). */
    const ANGLE_SEAM = Math.PI * 0.16

    /** Stable 32-bit string hash → [0,1). Keeps each goal's jitter constant. */
    function hash01(text) {
      let hh = 2166136261
      const s = String(text ?? '')
      for (let i = 0; i < s.length; i++) {
        hh ^= s.charCodeAt(i)
        hh = Math.imul(hh, 16777619)
      }
      return ((hh >>> 0) % 100000) / 100000
    }

    /**
     * Sessions by start time → clockwise angle from 12 o'clock.
     *
     * Angle used to be pure decoration (golden-angle spacing), which wasted a
     * whole visual channel: you could not tell "drifted late" from "drifted,
     * got pulled back, drifted again". With the angle ordered by start time,
     * reading clockwise answers exactly that.
     *
     * Rank-based, not time-proportional, on purpose: real start times here
     * span a week with a 10 ms minimum gap, so mapping times linearly puts
     * dozens of goals on the same ray. Equal angular spacing keeps the field
     * readable and the old→new order exact; the spacing encodes ORDER, not the
     * size of the time gaps (that is what the tooltip timestamp is for).
     */
    function angleByStartTime(entries) {
      const ordered = [...entries].sort((a, b) => {
        const ta = typeof a.startedAt === 'number' ? a.startedAt : Infinity
        const tb = typeof b.startedAt === 'number' ? b.startedAt : Infinity
        if (ta !== tb) return ta - tb
        // Same instant: stable, deterministic tie-break so a re-render cannot
        // shuffle two goals that started together.
        return String(a.id).localeCompare(String(b.id))
      })
      const out = new Map()
      if (!ordered.some(e => typeof e.startedAt === 'number')) {
        // No timestamps at all: keep a deterministic spiral instead of a
        // meaningless time axis.
        ordered.forEach((e, i) => {
          out.set(e.id, i * GOLDEN_ANGLE + (hash01(e.id) - 0.5) * 0.12)
        })
        return out
      }
      const n = ordered.length
      // A full turn would put the newest goal back on the oldest one's ray, so
      // "clockwise = later" would be false for the last point. A half turn
      // wastes the left side. The answer is a full turn with a reserved seam:
      // time runs over 360° minus a small wedge at the top, and the seam is
      // drawn explicitly as the old→new arrow, so the wrap is visible instead
      // of being a coordinate trick.
      const span = Math.PI * 2 - ANGLE_SEAM
      ordered.forEach((e, i) => {
        const f = n === 1 ? 0 : i / (n - 1)
        out.set(e.id, -Math.PI / 2 + ANGLE_SEAM / 2 + f * span)
      })
      return out
    }

    /** Distance payload → normalized polar points. */
    function layoutPoints(items) {
      const scored = (items ?? []).filter(g => typeof g.meanDistance === 'number')
      const sorted = [...scored].sort((a, b) => b.meanDistance - a.meanDistance)
      const entries = sorted.map((g, i) => ({
        id: g.goalId,
        startedAt: g.sessionStartedAt ?? g.createdAt ?? null,
        // Golden-angle order is only the fallback for untimed data.
        seedIndex: i
      }))
      const angles = angleByStartTime(entries)
      return sorted.map((g, i) => {
        return {
          id: g.goalId,
          objective: g.objective ?? '',
          distance: g.meanDistance,
          turns: g.turnCount ?? 0,
          calls: g.totalCalls ?? 0,
          failed: g.failedCalls ?? 0,
          band: band(g.meanDistance)[1],
          startedAt: entries[i].startedAt,
          angle: angles.get(g.goalId) ?? i * GOLDEN_ANGLE,
          // The floor keeps a well-focused goal off the core sprite, which would
          // otherwise read as the core itself and hide the light.
          radius: Math.max(0.13, Math.min(1, g.meanDistance / R_MAX_DIST)),
          // Log keeps one long session from dwarfing every other point.
          size: Math.min(6.5, 1.6 + Math.log((g.turnCount ?? 1) + 1) * 1.5)
        }
      })
    }

    /**
     * Drop the decorative filaments.
     *
     * The old spiral curves read as "the trajectory of the conversation" and
     * encoded nothing — a static picture cannot say whether they were real
     * turns or art. They are gone; real turn trajectories live in the
     * 漂移轮次 tab. What replaces them is real adjacency between goals.
     */

    /**
     * Resolve the similarity links into drawable segments.
     *
     * `links` comes from src/distance.js (goal vectors, 1−cos), so the edges
     * are data, not decoration. Anything without a rendered endpoint is
     * skipped rather than guessed at.
     */
    function layoutLinks(links, positionById) {
      const out = []
      for (const l of links ?? []) {
        const a = positionById.get(l.a)
        const b = positionById.get(l.b)
        if (!a || !b) continue
        if (typeof l.distance !== 'number') continue
        out.push({
          a: l.a,
          b: l.b,
          distance: l.distance,
          strong: l.distance <= LINK_STRONG
        })
      }
      return out
    }

    /**
     * Sparks around one goal point: the sprayed-light texture of the reference.
     *
     * Deterministic per point id, so a goal's spray does not reshuffle between
     * frames — the field only breathes, it never jitters.
     */
    function sparksFor(id, count) {
      const out = []
      const base = Math.floor(hash01(id) * 100000)
      for (let i = 0; i < count; i++) {
        const a = hash01(id + ':a' + i) * Math.PI * 2
        const d = 0.35 + hash01(id + ':d' + i) * 1.5
        out.push({
          dx: Math.cos(a) * d,
          dy: Math.sin(a) * d,
          r: 0.35 + hash01(id + ':r' + i) * 1.0,
          alpha: 0.16 + hash01(id + ':l' + i) * 0.5,
          drift: 0.4 + (base % 100) / 250 + hash01(id + ':s' + i) * 0.8
        })
      }
      return out
    }
    const SPRAY = new Map()
    function sprayOf(p) {
      let s = SPRAY.get(p.id)
      if (!s) {
        // Hotter points spray wider and denser, like the reference's hot zones.
        const count = p.band === 'red' ? 16 : p.band === 'orange' ? 11 : p.band === 'yellow' ? 6 : 4
        s = sparksFor(p.id, count)
        SPRAY.set(p.id, s)
      }
      return s
    }

    /** Deterministic dust motes: the same field looks the same every render. */
    function makeDust(count, seed) {
      const out = []
      let s = seed
      const rnd = () => {
        s = (s * 1664525 + 1013904223) % 4294967296
        return s / 4294967296
      }
      for (let i = 0; i < count; i++) {
        out.push({
          angle: rnd() * Math.PI * 2,
          radius: 0.06 + rnd() * 0.94,
          size: 0.4 + rnd() * 1.1,
          alpha: 0.10 + rnd() * 0.45,
          speed: 0.006 + rnd() * 0.022
        })
      }
      return out
    }
    const DUST = makeDust(260, 20261027)

    /**
     * Pick the bearing for the ring chips where they collide with least.
     *
     * Ring chips are drawn on the rings themselves, so a fixed bearing will
     * eventually sit on top of a light once sessions accumulate. Counting by
     * angle alone is not enough: a chip covers ~46×13px, so a goal at a
     * neighbouring bearing but a different radius still overlaps it. This
     * scores candidate bearings against the ACTUAL projected point positions
     * and picks the cheapest.
     *
     * The seam wedge is excluded on purpose: it is empty BY CONSTRUCTION, so
     * without the filter every render would park the chips in the old→new
     * seam and collide with its labels.
     */
    /**
     * Pick the bearing for one ring chip that collides least.
     *
     * Ring chips are drawn on the rings themselves, so a fixed bearing will
     * eventually sit on top of a light once sessions accumulate. Counting by
     * angle alone is not enough: a chip covers ~46×13px, so a goal at a
     * neighbouring bearing but a different radius still overlaps it. This
     * scores candidate bearings against the ACTUAL projected point positions
     * and picks the cheapest.
     *
     * Value labels count too. Severe-band points carry a permanent three-digit
     * label pinned at a fixed offset, and it used to be invisible to this
     * function — so the chips could park on top of it (measured: one collision
     * on 31 goals, while 66 of 72 bearings were clear).
     *
     * Chips already placed are passed in as boxes: one bearing shared by all
     * three rings put them on a single ray, where they crowd each other. On a
     * dense field no bearing is fully clear anyway (measured: 0 of 59 score
     * zero with 31 goals), so each ring picks its own instead.
     *
     * The seam wedge is excluded on purpose: it is empty BY CONSTRUCTION, so
     * without the filter every render would park the chips in the old→new
     * seam and collide with its labels.
     *
     * @param ringRadius  radius of the ring this chip sits on
     * @param placedChips boxes ({x0,y0,x1,y1}) of chips already drawn
     */
    function emptiestAngle(points, cx, cy, maxR, ringRadius = (0.5 / R_MAX_DIST) * maxR, placedChips = []) {
      const CANDIDATES = 72
      const CHIP_W = 26
      const CHIP_H = 12
      const LABEL_W = 34
      const LABEL_H = 11
      const seamCentre = ((-Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
      const seamHalf = ANGLE_SEAM / 2 + 0.30

      const pointPos = points.map(p => ({
        x: cx + Math.cos(p.angle) * p.radius * maxR,
        y: cy + Math.sin(p.angle) * p.radius * maxR * 0.9
      }))

      // Mirrors the value-label placement in drawField(): severe band only,
      // anchored left-of-top at (x + size + 8, y - (size + 8) * 0.55).
      const labelBoxes = points
        .filter(p => p.band === 'red')
        .map(p => {
          const pos = { x: cx + Math.cos(p.angle) * p.radius * maxR, y: cy + Math.sin(p.angle) * p.radius * maxR * 0.9 }
          const off = p.size + 8
          return {
            x0: pos.x + off,
            x1: pos.x + off + LABEL_W,
            y0: pos.y - off * 0.55 - LABEL_H / 2,
            y1: pos.y - off * 0.55 + LABEL_H / 2
          }
        })

      // Two penalties with deliberately different shapes:
      //
      // - Points use the ORIGINAL centre-distance form (`|Δ| - full size`).
      //   Rewriting it in box terms is not equivalent — the box form penalises
      //   a ring of offsets the original ignores, which made chips avoid lights
      //   far too strongly and shove themselves into a crowded bearing.
      //   Verified numerically: at Δx=44 the original scores 0, the box form
      //   scores 169.
      // - Labels use a box test, because a label is a rectangle anchored at a
      //   corner rather than a centred sprite, and centre-distance against its
      //   anchor puts the penalty in the wrong place.
      const pointCost = (q, lx, ly) => {
        const dx = Math.max(0, Math.abs(q.x - lx) - CHIP_W)
        const dy = Math.max(0, Math.abs(q.y - ly) - CHIP_H)
        const d = Math.hypot(dx, dy)
        return d < 18 ? (18 - d) * (18 - d) : 0
      }
      const boxCost = (x0, y0, x1, y1, q) => {
        const dx = Math.max(0, Math.max(x0 - q.x1, q.x0 - x1))
        const dy = Math.max(0, Math.max(y0 - q.y1, q.y0 - y1))
        const d = Math.hypot(dx, dy)
        return d < 18 ? (18 - d) * (18 - d) : 0
      }

      let best = -Math.PI / 2
      let bestScore = Infinity
      for (let c = 0; c < CANDIDATES; c++) {
        const a = (c / CANDIDATES) * Math.PI * 2
        let delta = Math.abs(a - seamCentre)
        if (delta > Math.PI) delta = Math.PI * 2 - delta
        if (delta < seamHalf) continue

        const lx = cx + Math.cos(a) * ringRadius
        const ly = cy + Math.sin(a) * ringRadius * 0.9
        const x0 = lx - CHIP_W / 2
        const x1 = lx + CHIP_W / 2
        const y0 = ly - CHIP_H / 2
        const y1 = ly + CHIP_H / 2

        let score = 0
        for (const q of pointPos) score += pointCost(q, lx, ly)
        for (const q of labelBoxes) score += boxCost(x0, y0, x1, y1, q)
        // Already-placed chips are scored harder than background noise: two
        // chips overlapping each other is far worse than a chip near a light,
        // because both become unreadable rather than merely busy.
        for (const q of placedChips) score += boxCost(x0, y0, x1, y1, q) * 3
        /*
         * Angular separation, independent of the box test.
         *
         * Chips sit on different radii, so two chips 3° apart can be
         * box-disjoint and still read as one clump — measured: orange at 102°
         * and red at 99° on real data. Penalising near-identical bearings
         * spreads the three chips around the field instead of stacking them.
         */
        for (const q of placedChips) {
          if (q.bearing === undefined) continue
          let sep = Math.abs(a - q.bearing)
          if (sep > Math.PI) sep = Math.PI * 2 - sep
          if (sep < MIN_CHIP_SEP) score += (MIN_CHIP_SEP - sep) * 900
        }
        // Keep the chips away from the rim and the core so they stay on their
        // own ring instead of drifting into other geometry.
        if (lx < 30 || lx > cx * 2 - 30) score += 400
        if (score < bestScore) { bestScore = score; best = a }
      }
      return best
    }

      /** Font stack for canvas: CJK-capable first, then mono for digits. */
    const FIELD_FONT = '"Microsoft YaHei", "PingFang SC", ui-monospace, Consolas, monospace'

    /**
     * Chip plate half-extents, shared by the chip drawer and the bearing picker.
     * drawChip() sizes the plate by text width (at least 46×13); these are the
     * conservative halves used for collision scoring.
     */
    const CHIP_HALF_W = 23
    const CHIP_HALF_H = 7
    /** Minimum bearing gap between two ring chips, in radians (~22 degrees). */
    const MIN_CHIP_SEP = Math.PI * 0.12

    /**
     * A tiny labelled pill, used for the ring thresholds.
     *
     * Canvas has no layout, so this draws the plate itself and keeps the text
     * legible over the starfield: a bare 9px number at 55% alpha was invisible
     * in practice, which is why the rings looked unlabelled.
     */
    function drawChip(g, x, y, text, rgb) {
      g.font = '9px ' + FIELD_FONT
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      const w = Math.max(46, g.measureText(text).width + 10)
      const hgt = 13
      g.beginPath()
      g.fillStyle = 'rgba(10,17,24,0.82)'
      g.strokeStyle = 'rgba(' + rgb.join(',') + ',0.55)'
      g.lineWidth = 0.8
      // roundRect is not in every canvas build; fall back to a plain rect.
      if (typeof g.roundRect === 'function') {
        g.roundRect(x - w / 2, y - hgt / 2, w, hgt, 6)
      } else {
        g.rect(x - w / 2, y - hgt / 2, w, hgt)
      }
      g.fill()
      g.stroke()
      g.fillStyle = 'rgba(' + rgb.join(',') + ',0.95)'
      g.fillText(text, x, y)
    }

    /**
     * Paint one frame. Returns projected points so the caller can hit-test.
     *
     * `links` carries the goal-to-goal similarity edges; the caller resolves
     * them against the same projection the points use, so an edge can never
     * land next to a point that is not actually there.
     */
    function drawField(g, width, height, points, time, hoverId, links = []) {
      const cx = width / 2
      const cy = height / 2
      const maxR = Math.min(width * 0.42, height * 0.46)
      const t = time / 1000

      // --- background: cold gray-blue, lit from behind the core -------------
      const bg = g.createLinearGradient(0, 0, 0, height)
      bg.addColorStop(0, '#080d13')
      bg.addColorStop(0.45, '#101a24')
      bg.addColorStop(1, '#182633')
      g.fillStyle = bg
      g.fillRect(0, 0, width, height)

      // A wide, very soft pool of warm light behind the core, so the field
      // reads as "something is glowing here" rather than a flat backdrop.
      const pool = g.createRadialGradient(cx, cy, 0, cx, cy, maxR * 1.9)
      pool.addColorStop(0, 'rgba(120,140,160,0.16)')
      pool.addColorStop(0.45, 'rgba(70,95,120,0.09)')
      pool.addColorStop(1, 'rgba(20,35,50,0)')
      g.fillStyle = pool
      g.fillRect(0, 0, width, height)

      const vig = g.createRadialGradient(cx, cy, maxR * 0.15, cx, cy, maxR * 1.6)
      vig.addColorStop(0, 'rgba(0,0,0,0)')
      vig.addColorStop(0.7, 'rgba(0,0,0,0.25)')
      vig.addColorStop(1, 'rgba(0,0,0,0.72)')
      g.fillStyle = vig
      g.fillRect(0, 0, width, height)

      // --- dust: two depths, the far layer slower and dimmer ---------------
      for (const d of DUST) {
        const a = d.angle + t * d.speed
        const r = d.radius * maxR * 1.45
        const x = cx + Math.cos(a) * r
        const y = cy + Math.sin(a) * r * 0.9
        if (x < -4 || x > width + 4 || y < -4 || y > height + 4) continue
        const near = d.radius < 0.55
        g.beginPath()
        g.fillStyle = near
          ? 'rgba(168,200,228,' + (d.alpha * 0.7).toFixed(3) + ')'
          : 'rgba(120,152,184,' + (d.alpha * 0.32).toFixed(3) + ')'
        g.arc(x, y, d.size * (near ? 1 : 0.75), 0, Math.PI * 2)
        g.fill()
      }

      // --- band rings, labelled --------------------------------------------
      // The rings used to be unlabelled hairlines: the four bands were only
      // inferable from colour, and colour was exactly the thing that failed.
      // Numbers and band names now sit ON the ring, in the same notation the
      // tables use, so a reader never has to reverse-engineer a colour.
      //
      // The label bearing is picked per render from the emptiest sector rather
      // than hardcoded: goal positions move as sessions accumulate, and a fixed
      // diagonal eventually lands a chip on top of a light.
      //
      // Each ring is placed independently, and each placement also avoids the
      // chips already placed. One shared bearing forced all three chips onto a
      // single ray, where they crowded each other and together sat on whichever
      // light happened to be on that bearing — with 31 goals the field is dense
      // enough that no single bearing is fully clear (measured: 0 of 59
      // candidates score zero), so sharing one makes the collision certain
      // instead of merely likely.
      const placedChips = []
      for (const b of BANDS) {
        const r = (b.at / R_MAX_DIST) * maxR
        g.beginPath()
        g.setLineDash([1, 5])
        g.strokeStyle = 'rgba(' + (BAND_GLOW[b.key] ?? BAND_GLOW.grey).join(',') + ',0.30)'
        g.lineWidth = 1
        g.ellipse(cx, cy, r, r * 0.9, 0, 0, Math.PI * 2)
        g.stroke()
        g.setLineDash([])

        const labelAngle = emptiestAngle(points, cx, cy, maxR, r, placedChips)
        const lx = cx + Math.cos(labelAngle) * r
        const ly = cy + Math.sin(labelAngle) * r * 0.9
        drawChip(g, lx, ly, b.at.toFixed(2) + ' ' + b.label, BAND_GLOW[b.key] ?? BAND_GLOW.grey)
        // Same plate dimensions drawChip() uses; measured here would need the
        // context font, and a fixed conservative box is enough for avoidance.
        placedChips.push({ x0: lx - CHIP_HALF_W, x1: lx + CHIP_HALF_W, y0: ly - CHIP_HALF_H, y1: ly + CHIP_HALF_H, bearing: labelAngle })
      }

      // --- the time axis ----------------------------------------------------
      // Angle means session start time, clockwise from 12 o'clock. The seam at
      // the top is where the axis wraps from newest back to oldest, so it is
      // drawn rather than left implicit: without it the last point would look
      // "earlier" than the first.
      const seamR = maxR * 1.02
      g.beginPath()
      g.strokeStyle = 'rgba(160,194,222,0.22)'
      g.lineWidth = 1
      g.setLineDash([2, 4])
      g.moveTo(cx + Math.cos(-Math.PI / 2 + ANGLE_SEAM / 2) * maxR * 0.18,
        cy + Math.sin(-Math.PI / 2 + ANGLE_SEAM / 2) * maxR * 0.18 * 0.9)
      g.lineTo(cx + Math.cos(-Math.PI / 2 + ANGLE_SEAM / 2) * seamR,
        cy + Math.sin(-Math.PI / 2 + ANGLE_SEAM / 2) * seamR * 0.9)
      g.moveTo(cx + Math.cos(-Math.PI / 2 - ANGLE_SEAM / 2) * maxR * 0.18,
        cy + Math.sin(-Math.PI / 2 - ANGLE_SEAM / 2) * maxR * 0.18 * 0.9)
      g.lineTo(cx + Math.cos(-Math.PI / 2 - ANGLE_SEAM / 2) * seamR,
        cy + Math.sin(-Math.PI / 2 - ANGLE_SEAM / 2) * seamR * 0.9)
      g.stroke()
      g.setLineDash([])

      g.font = '9px ' + FIELD_FONT
      g.textAlign = 'center'
      g.textBaseline = 'middle'
      g.fillStyle = 'rgba(160,194,222,0.62)'
      g.fillText('旧', cx - maxR * 0.20, cy - maxR * 1.02)
      g.fillText('新', cx + maxR * 0.20, cy - maxR * 1.02)
      g.fillStyle = 'rgba(160,194,222,0.34)'
      g.fillText('顺时针 = 更晚', cx, cy + maxR * 1.16)

      // --- goal geometry, shared by the link layer and the point pass -------
      const posById = new Map()
      for (const p of points) {
        posById.set(p.id, {
          x: cx + Math.cos(p.angle) * p.radius * maxR,
          y: cy + Math.sin(p.angle) * p.radius * maxR * 0.9
        })
      }

      // --- links: similarity BETWEEN goals ---------------------------------
      // This is what makes the field a network instead of a star. It replaces
      // the old decorative filaments, which connected every goal to the core
      // and encoded nothing: a static picture cannot distinguish "real turn
      // trajectory" from "art", so it read as data it did not carry.
      for (const l of links) {
        const a = posById.get(l.a)
        const bpos = posById.get(l.b)
        if (!a || !bpos) continue
        const hot = hoverId === l.a || hoverId === l.b
        // Bow the line so overlapping edges stay countable, deterministically.
        const bendSign = hash01(l.a + '|' + l.b) > 0.5 ? 1 : -1
        const mx = (a.x + bpos.x) / 2 + (bpos.y - a.y) * 0.12 * bendSign
        const my = (a.y + bpos.y) / 2 + (a.x - bpos.x) * 0.12 * bendSign
        const base = l.strong ? [255, 214, 140] : [140, 186, 220]
        /*
         * Alpha and width are tuned for the FIELD's real size, not a 900px
         * render. The canvas is ~340 CSS px tall, so a 0.8px line at 0.13 alpha
         * survives only on a high-DPI display — the first version of this
         * layer drew all 17 edges and was still reported as "no lines", which
         * is exactly that failure. Every edge now clears a floor: a layer that
         * is invisible is indistinguishable from one that is absent.
         */
        const alpha = l.strong
          ? (hot ? 0.68 : 0.40)
          : (hot ? 0.46 : 0.24)
        g.beginPath()
        g.moveTo(a.x, a.y)
        g.quadraticCurveTo(mx, my, bpos.x, bpos.y)
        g.strokeStyle = 'rgba(' + base.join(',') + ',' + alpha + ')'
        g.lineWidth = l.strong ? (hot ? 2.4 : 1.8) : (hot ? 1.8 : 1.2)
        g.stroke()

        // A single travelling spark on "same request asked twice" edges: the
        // reuse is the point of those links, so they get a pulse, not a glow.
        if (l.strong) {
          const u = ((t * 0.12 + hash01(l.a + l.b)) % 1)
          const iu = 1 - u
          const sx = iu * iu * a.x + 2 * iu * u * mx + u * u * bpos.x
          const sy = iu * iu * a.y + 2 * iu * u * my + u * u * bpos.y
          g.beginPath()
          g.fillStyle = 'rgba(255,236,186,' + (hot ? 0.95 : 0.72) + ')'
          g.arc(sx, sy, hot ? 1.9 : 1.3, 0, Math.PI * 2)
          g.fill()
        }
      }

      // --- the core: the objective as asked --------------------------------
      const pulse = 1 + Math.sin(t * 1.5) * 0.05
      const coreR = Math.max(11, maxR * 0.062) * pulse

      // Three stacked glows: broad haze, mid bloom, tight hot centre.
      const haze = g.createRadialGradient(cx, cy, 0, cx, cy, coreR * 11)
      haze.addColorStop(0, 'rgba(255,214,140,0.20)')
      haze.addColorStop(0.4, 'rgba(255,190,90,0.07)')
      haze.addColorStop(1, 'rgba(255,180,60,0)')
      g.fillStyle = haze
      g.beginPath()
      g.arc(cx, cy, coreR * 11, 0, Math.PI * 2)
      g.fill()

      const bloom = g.createRadialGradient(cx, cy, 0, cx, cy, coreR * 3.6)
      bloom.addColorStop(0, 'rgba(255,236,186,0.72)')
      bloom.addColorStop(0.3, 'rgba(255,200,100,0.30)')
      bloom.addColorStop(1, 'rgba(255,185,70,0)')
      g.fillStyle = bloom
      g.beginPath()
      g.arc(cx, cy, coreR * 3.6, 0, Math.PI * 2)
      g.fill()

      // Hot inner disc with a bright rim: reads as a light source, not a dot.
      const disc = g.createRadialGradient(cx, cy, 0, cx, cy, coreR * 0.78)
      disc.addColorStop(0, 'rgba(255,252,236,1)')
      disc.addColorStop(0.65, 'rgba(255,232,170,0.95)')
      disc.addColorStop(1, 'rgba(255,206,110,0.25)')
      g.fillStyle = disc
      g.beginPath()
      g.arc(cx, cy, coreR * 0.78, 0, Math.PI * 2)
      g.fill()

      // Orbital arcs around the core, each at its own phase.
      for (let i = 0; i < 4; i++) {
        const r = coreR * (1.7 + i * 0.85)
        const spin = t * (0.10 + i * 0.045) * (i % 2 ? -1 : 1)
        g.beginPath()
        g.strokeStyle = 'rgba(255,214,140,' + (0.22 - i * 0.045).toFixed(3) + ')'
        g.lineWidth = 1
        g.ellipse(cx, cy, r, r * 0.88, spin, 0.3, Math.PI * 1.75)
        g.stroke()
      }

      // --- goal points -----------------------------------------------------
      const projected = []
      for (const p of points) {
        const pos = posById.get(p.id)
        const x = pos.x
        const y = pos.y
        projected.push({ point: p, x, y })

        const rgb = BAND_GLOW[p.band] ?? BAND_GLOW.grey
        const isHover = hoverId === p.id
        const r = p.size * (isHover ? 1.5 : 1)

        // Sprayed sparks first, under the halo: this is what makes a point look
        // like burning light rather than a plotted marker.
        for (const s of sprayOf(p)) {
          const sx = x + s.dx * r * (2.2 + Math.sin(t * s.drift + s.dx) * 0.35)
          const sy = y + s.dy * r * (2.2 + Math.cos(t * s.drift + s.dy) * 0.35)
          g.beginPath()
          g.fillStyle = 'rgba(' + rgb.join(',') + ',' + (s.alpha * (isHover ? 0.95 : 0.62)).toFixed(3) + ')'
          g.arc(sx, sy, s.r * (isHover ? 1.2 : 1), 0, Math.PI * 2)
          g.fill()
        }

        const halo = g.createRadialGradient(x, y, 0, x, y, r * 7.5)
        halo.addColorStop(0, 'rgba(' + rgb.join(',') + ',' + (isHover ? 0.62 : 0.40) + ')')
        halo.addColorStop(0.35, 'rgba(' + rgb.join(',') + ',' + (isHover ? 0.24 : 0.13) + ')')
        halo.addColorStop(1, 'rgba(' + rgb.join(',') + ',0)')
        g.fillStyle = halo
        g.beginPath()
        g.arc(x, y, r * 7.5, 0, Math.PI * 2)
        g.fill()

        g.beginPath()
        g.fillStyle = BAND_COLORS[p.band] ?? BAND_COLORS.grey
        g.arc(x, y, r, 0, Math.PI * 2)
        g.fill()

        g.beginPath()
        g.fillStyle = 'rgba(255,253,244,0.92)'
        g.arc(x - r * 0.2, y - r * 0.2, Math.max(0.7, r * 0.38), 0, Math.PI * 2)
        g.fill()

        if (isHover) {
          g.beginPath()
          g.strokeStyle = 'rgba(255,255,255,0.8)'
          g.lineWidth = 1
          g.arc(x, y, r + 6, 0, Math.PI * 2)
          g.stroke()
        }
      }

      // --- permanent numbers, severe band only ------------------------------
      // One rule for the whole field: the severe (bright gold) points always
      // print their distance, everything else is on hover. Previously three
      // numbers floated over the left side with no visible rule behind them,
      // which read as arbitrary; this makes "why is this one labelled" obvious.
      g.font = '10px ' + FIELD_FONT
      g.textAlign = 'left'
      g.textBaseline = 'middle'
      for (const p of points) {
        if (p.band !== 'red') continue
        const pos = posById.get(p.id)
        if (!pos) continue
        const isHover = hoverId === p.id
        const label = p.distance.toFixed(3)
        const off = (p.size + 8)
        g.fillStyle = isHover ? 'rgba(255,240,205,0.98)' : 'rgba(255,224,158,0.88)'
        g.fillText(label, pos.x + off, pos.y - off * 0.55)
      }

      return projected
    }

    function DriftField({ distance }) {
      const canvasRef = useRef(null)
      const wrapRef = useRef(null)
      const pointsRef = useRef([])
      const linksRef = useRef([])
      const hoverRef = useRef(null)
      const [hover, setHover] = useState(null)
      const [tip, setTip] = useState(null)

      const points = useMemo(
        () => layoutPoints(distance ? distance.items : []),
        [distance]
      )
      pointsRef.current = points

      // Links are resolved once per snapshot, not per frame: they only depend on
      // which goals are present, and the draw loop should stay allocation-light.
      const links = useMemo(() => {
        const byId = new Map(points.map(p => [p.id, p]))
        return layoutLinks(distance ? distance.links : [], byId)
      }, [distance, points])
      linksRef.current = links

      // How many goals share each strong link — used to name the reuse idea in
      // the tooltip instead of leaving the bright edges unexplained.
      const reuseById = useMemo(() => {
        const m = new Map()
        for (const l of links) {
          if (!l.strong) continue
          m.set(l.a, (m.get(l.a) ?? 0) + 1)
          m.set(l.b, (m.get(l.b) ?? 0) + 1)
        }
        return m
      }, [links])

      useEffect(() => {
        const canvas = canvasRef.current
        if (!canvas || !points.length) return undefined
        const ctx2d = canvas.getContext('2d')
        if (!ctx2d) return undefined

        let raf = 0
        let alive = true
        let lastW = 0
        let lastH = 0

        const resize = () => {
          const rect = canvas.getBoundingClientRect()
          const dpr = Math.min(window.devicePixelRatio || 1, 2)
          const w = Math.max(280, Math.round(rect.width))
          const hh = Math.max(220, Math.round(rect.height))
          if (w === lastW && hh === lastH) return false
          lastW = w
          lastH = hh
          canvas.width = Math.round(w * dpr)
          canvas.height = Math.round(hh * dpr)
          ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0)
          return true
        }

        const frame = (time) => {
          if (!alive) return
          resize()
          const projected = drawField(
            ctx2d, lastW, lastH, pointsRef.current, time, hoverRef.current, linksRef.current
          )
          canvas.__glPoints = projected
          raf = window.requestAnimationFrame(frame)
        }

        resize()
        // First paint is synchronous so the panel is never briefly empty.
        canvas.__glPoints = drawField(
          ctx2d, lastW, lastH, pointsRef.current, 0, null, linksRef.current
        )
        raf = window.requestAnimationFrame(frame)

        return () => {
          alive = false
          if (raf) window.cancelAnimationFrame(raf)
        }
      }, [points.length, links.length])

      const onMove = useCallback((e) => {
        const canvas = canvasRef.current
        if (!canvas) return
        const rect = canvas.getBoundingClientRect()
        const mx = e.clientX - rect.left
        const my = e.clientY - rect.top
        let best = null
        let bestD = 18
        for (const p of canvas.__glPoints ?? []) {
          const d = Math.hypot(p.x - mx, p.y - my)
          if (d < bestD) { bestD = d; best = p }
        }
        const id = best ? best.point.id : null
        if (id !== hoverRef.current) {
          hoverRef.current = id
          setHover(id)
        }
        if (best) {
          const wrapRect = wrapRef.current.getBoundingClientRect()
          setTip({
            left: Math.min(best.x + 14, rect.width - 300),
            top: Math.max(8, best.y - 10),
            point: best.point,
            wrapW: wrapRect.width
          })
        } else {
          setTip(null)
        }
      }, [])

      const onLeave = useCallback(() => {
        hoverRef.current = null
        setHover(null)
        setTip(null)
      }, [])

      if (!points.length) {
        return h('div', { className: 'gl-empty' }, '还没有可画的目标 —— 需要先跑一次带嵌入的分析。')
      }

      return h('div', { className: 'gl-field-wrap', ref: wrapRef },
        h('canvas', {
          className: 'gl-field-canvas',
          ref: canvasRef,
          onMouseMove: onMove,
          onMouseLeave: onLeave
        }),
        h('div', { className: 'gl-field-hint' }, '悬停查看目标'),
        h('div', { className: 'gl-field-legend' },
          ['green', 'yellow', 'orange', 'red'].map(b =>
            h('span', { key: b },
              h('i', { className: 'gl-legend-dot', style: { background: BAND_COLORS[b] } }),
              b === 'green' ? '聚焦 <0.35'
                : b === 'yellow' ? '有偏离 0.35+'
                  : b === 'orange' ? '偏题 0.50+' : '严重 0.65+'
            )
          ),
          // The link classes only exist once a snapshot carries `links`. A
          // cached snapshot from before this layer landed has none, and showing
          // the key for edges that are not on screen would be a lie.
          links.length > 0 && h('span', { className: 'gl-legend-sep' }, '|'),
          links.length > 0 && h('span', null,
            h('i', { className: 'gl-legend-line gl-legend-line-weak' }),
            '同主题 ≤' + LINK_WEAK.toFixed(2)
          ),
          links.length > 0 && h('span', null,
            h('i', { className: 'gl-legend-line gl-legend-line-strong' }),
            '几乎同题 ≤' + LINK_STRONG.toFixed(2)
          )
        ),
        tip && h('div', {
          className: 'gl-field-tip',
          style: { left: tip.left, top: tip.top }
        },
          h('b', null, tip.point.distance.toFixed(3)),
          ' ',
          h('span', { className: 'gl-tag gl-tag-' + tip.point.band }, band(tip.point.distance)[0]),
          h('span', { className: 'gl-tip-obj' }, tip.point.objective),
          h('span', { className: 'gl-tip-meta' },
            `${tip.point.turns} 轮 · ${tip.point.calls} 次调用 · ${tip.point.failed} 次失败`
            + (tip.point.startedAt ? ` · 开始于 ${fmtTime(tip.point.startedAt)}` : '')
            + (reuseCountOf(tip.point.id) ? ` · 与 ${reuseCountOf(tip.point.id)} 个目标几乎同题（可复用上次路径）` : '')
          )
        )
      )

      function reuseCountOf(id) {
        return reuseById.get(id) ?? 0
      }
    }

    // ---------------------------------------------------------------------
    // Embedding endpoint config: the model is a property of the user's account,
    // so it is editable instead of hardcoded. The key itself is never entered
    // here — only the NAME of the variable that holds it.
    // ---------------------------------------------------------------------
    function EmbedConfig({ onSaved }) {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [probe, setProbe] = useState(null)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(null)

      const load = useCallback(() => {
        api.get('/config').then(cfg => {
          setData(cfg)
          setDraft({
            baseUrl: cfg.config.baseUrl,
            model: cfg.config.model,
            keyEnv: cfg.config.keyEnv,
            batchSize: cfg.config.batchSize,
            enabled: cfg.config.enabled
          })
        }).catch(e => setError('读取配置失败：' + e.message))
      }, [])

      useEffect(() => { load() }, [load])

      const setField = (key, value) => {
        setDraft(d => ({ ...d, [key]: value }))
        setProbe(null)
        setSaved(null)
      }

      const applyPreset = (id) => {
        const p = (data?.presets ?? []).find(x => x.id === id)
        if (!p) return
        setDraft(d => ({
          ...d,
          baseUrl: p.baseUrl || d.baseUrl,
          model: p.model || d.model,
          keyEnv: p.keyEnv || d.keyEnv
        }))
        setProbe(null)
        setSaved(null)
      }

      const doProbe = () => {
        setBusy(true)
        setError(null)
        setProbe(null)
        api.post('/probe', draft)
          .then(r => {
            if (r.error) setError(r.error)
            else setProbe(r)
          })
          .catch(e => setError('测试失败：' + e.message))
          .finally(() => setBusy(false))
      }

      const doSave = () => {
        setBusy(true)
        setError(null)
        setSaved(null)
        api.put('/config', draft)
          .then(r => {
            if (r.error) { setError(r.error); return }
            setData(r)
            setSaved('已保存。重新分析后生效。')
            onSaved?.()
          })
          .catch(e => setError('保存失败：' + e.message))
          .finally(() => setBusy(false))
      }

      if (!data || !draft) {
        return error
          ? h('div', { className: 'gl-err' }, error)
          : h('div', { className: 'gl-empty' }, '读取配置中…')
      }

      const dirty = draft.baseUrl !== data.config.baseUrl
        || draft.model !== data.config.model
        || draft.keyEnv !== data.config.keyEnv
        || draft.batchSize !== data.config.batchSize
        || draft.enabled !== data.config.enabled

      return h('div', { className: 'gl-form' },
        h('div', { className: 'gl-section-title' }, '向量模型'),
        h('div', { className: 'gl-form-note' },
          '任何兼容 OpenAI 的 ', h('code', { className: 'gl-mono' }, 'POST {baseUrl}/embeddings'),
          ' 端点都可以。这里只填 key 所在的', h('b', null, '环境变量名'),
          '，不填 key 本身 —— key 从环境变量或 ',
          h('code', { className: 'gl-mono' }, '~/.dsh/.credentials.yaml'),
          ' 的 ', h('code', { className: 'gl-mono' }, 'refs:'), ' 里解析，永不写入配置文件。'),

        h('div', { className: 'gl-field' },
          h('label', { className: 'gl-label' }, '预设'),
          h('select', {
            className: 'gl-select',
            value: '',
            onChange: (e) => applyPreset(e.target.value)
          },
            h('option', { value: '' }, '选择预设…'),
            data.presets.map(p => h('option', { key: p.id, value: p.id }, p.label))
          )
        ),

        h('div', { className: 'gl-field' },
          h('label', { className: 'gl-label' }, 'Base URL'),
          h('input', {
            className: 'gl-input',
            value: draft.baseUrl,
            placeholder: 'https://api.openai.com/v1',
            onChange: (e) => setField('baseUrl', e.target.value)
          }),
          h('span', { className: 'gl-hint' }, '请求地址 = baseUrl + /embeddings')
        ),

        h('div', { className: 'gl-field' },
          h('label', { className: 'gl-label' }, '模型'),
          h('input', {
            className: 'gl-input',
            value: draft.model,
            placeholder: 'text-embedding-3-small',
            onChange: (e) => setField('model', e.target.value)
          })
        ),

        h('div', { className: 'gl-row' },
          h('div', { className: 'gl-field', style: { flex: '1 1 220px' } },
            h('label', { className: 'gl-label' }, 'Key 环境变量名'),
            h('input', {
              className: 'gl-input',
              value: draft.keyEnv,
              placeholder: 'OPENAI_API_KEY',
              onChange: (e) => setField('keyEnv', e.target.value)
            })
          ),
          h('div', { className: 'gl-field', style: { flex: '0 0 130px' } },
            h('label', { className: 'gl-label' }, '批量大小'),
            h('input', {
              className: 'gl-input',
              type: 'number',
              min: 1,
              max: data.maxBatch,
              value: draft.batchSize,
              onChange: (e) => setField('batchSize', Number(e.target.value))
            })
          )
        ),

        h('div', { className: 'gl-row' },
          h('label', { className: 'gl-row', style: { gap: 6, fontSize: 12.5 } },
            h('input', {
              type: 'checkbox',
              checked: draft.enabled,
              onChange: (e) => setField('enabled', e.target.checked)
            }),
            '启用嵌入打分（关掉后只用失败聚类，不联网）'
          )
        ),

        h('div', { className: 'gl-row' },
          h('span', { className: 'gl-badge' },
            'key：' + (data.keyConfigured ? data.keySource + ' ✓' : '未配置')),
          dirty && h('span', { className: 'gl-badge gl-badge-warn' }, '有未保存修改')
        ),

        h('div', { className: 'gl-row' },
          h('button', {
            className: 'gl-btn', onClick: doProbe, disabled: busy
          }, busy ? '测试中…' : '测试连接'),
          h('button', {
            className: 'gl-btn gl-btn-primary', onClick: doSave, disabled: busy || !dirty
          }, '保存')
        ),

        error && h('div', { className: 'gl-err' }, error),
        saved && h('div', { className: 'gl-ok' }, saved),
        probe && (probe.ok
          ? h('div', { className: 'gl-ok' },
            `连接成功 · ${probe.model} · ${probe.dim} 维 · ${probe.elapsedMs}ms`)
          : h('div', { className: 'gl-err' }, '连接失败：' + probe.error)),

        h('div', { className: 'gl-hint', style: { marginTop: 4 } },
          '配置文件：', data.configFile)
      )
    }

    // ---------------------------------------------------------------------
    // Drift correction: opt-in, prompt-only. Nothing here mutates a goal — the
    // panel exists so the user can see exactly when the model is being told it
    // drifted, and turn it off again.
    // ---------------------------------------------------------------------
    function CorrectionPanel() {
      const [data, setData] = useState(null)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const [saved, setSaved] = useState(null)

      const load = useCallback(() => {
        api.get('/correction').then(d => {
          setData(d)
          setDraft({ ...d.config })
        }).catch(e => setError('读取纠正配置失败：' + e.message))
      }, [])

      useEffect(() => { load() }, [load])

      const setField = (key, value) => {
        setDraft(d => ({ ...d, [key]: value }))
        setSaved(null)
      }

      const save = () => {
        setBusy(true)
        setError(null)
        setSaved(null)
        api.put('/correction', draft)
          .then(r => {
            if (r.error) { setError(r.error); return }
            setData(r)
            setDraft({ ...r.config })
            setSaved(r.config.enabled ? '已开启。下一个轮次结束后开始生效。' : '已关闭。')
          })
          .catch(e => setError('保存失败：' + e.message))
          .finally(() => setBusy(false))
      }

      if (!data || !draft) {
        return error
          ? h('div', { className: 'gl-err' }, error)
          : h('div', { className: 'gl-empty' }, '读取纠正配置中…')
      }

      const dirty = Object.keys(draft).some(k => draft[k] !== data.config[k])
      const sessions = data.sessions ?? []

      return h('div', { className: 'gl-form' },
        h('div', { className: 'gl-section-title' }, '漂移纠正'),
        h('div', { className: 'gl-form-note' },
          '开启后，当某个目标连续多轮偏离时，在下一步的系统提示里插入一段提醒：' +
          '引用你最初的目标原话，指出当前偏离，并要求模型回到目标继续。',
          h('br'),
          h('b', null, '不会修改你的目标'), '，也不会打断正在跑的轮次 —— 只影响后续轮次的提示。' +
          '关闭时插件不向提示里写任何东西。'),

        h('div', { className: 'gl-row' },
          h('label', { className: 'gl-row', style: { gap: 6, fontSize: 12.5 } },
            h('input', {
              type: 'checkbox',
              checked: Boolean(draft.enabled),
              onChange: (e) => setField('enabled', e.target.checked)
            }),
            '启用漂移纠正（默认关闭）'
          )
        ),

        h('div', { className: 'gl-row' },
          h('div', { className: 'gl-field', style: { flex: '1 1 150px' } },
            h('label', { className: 'gl-label' }, '触发阈值'),
            h('input', {
              className: 'gl-input', type: 'number', step: '0.05', min: 0.2, max: 0.95,
              value: draft.threshold,
              onChange: (e) => setField('threshold', Number(e.target.value))
            }),
            h('span', { className: 'gl-hint' }, '单轮距离 ≥ 此值算「偏离」')
          ),
          h('div', { className: 'gl-field', style: { flex: '1 1 130px' } },
            h('label', { className: 'gl-label' }, '连续轮数'),
            h('input', {
              className: 'gl-input', type: 'number', min: 1, max: 10,
              value: draft.minStreak,
              onChange: (e) => setField('minStreak', Number(e.target.value))
            }),
            h('span', { className: 'gl-hint' }, '连续偏离多少轮才提醒')
          ),
          h('div', { className: 'gl-field', style: { flex: '1 1 130px' } },
            h('label', { className: 'gl-label' }, '冷却轮数'),
            h('input', {
              className: 'gl-input', type: 'number', min: 0, max: 20,
              value: draft.cooldownTurns,
              onChange: (e) => setField('cooldownTurns', Number(e.target.value))
            }),
            h('span', { className: 'gl-hint' }, '提醒后静默几轮')
          )
        ),

        h('div', { className: 'gl-row' },
          h('button', { className: 'gl-btn gl-btn-primary', onClick: save, disabled: busy || !dirty },
            busy ? '保存中…' : '保存'),
          !dirty && data.config.enabled && h('span', { className: 'gl-badge' }, '已开启'),
          !dirty && !data.config.enabled && h('span', { className: 'gl-badge gl-badge-warn' }, '未开启')
        ),

        error && h('div', { className: 'gl-err' }, error),
        saved && h('div', { className: 'gl-ok' }, saved),

        h('div', { className: 'gl-section-title', style: { marginTop: 8 } }, '当前会话状态'),
        h('div', { className: 'gl-row', style: { marginBottom: 6 } },
          h('span', { className: data.attached > 0 ? 'gl-badge' : 'gl-badge gl-badge-warn' },
            data.attached > 0 ? `已接管 ${data.attached} 个会话` : '尚未接管任何会话'),
          h('span', { className: 'gl-hint' },
            data.attached > 0
              ? '每轮结束会打分并判断是否提醒'
              : '需要 DSH 重启后才会挂载到运行中的会话')
        ),
        sessions.length === 0
          ? h('div', { className: 'gl-muted' },
            '还没有观察到轮次。开启后，每轮结束会在这里累计一次判断。')
          : h('table', { className: 'gl-table' },
            h('thead', null, h('tr', null,
              h('th', null, '会话'),
              h('th', null, '已观察轮次'),
              h('th', null, '连续偏离'),
              h('th', null, '近期均值'),
              h('th', null, '已提醒')
            )),
            h('tbody', null, sessions.map(s =>
              h('tr', { key: s.sessionId },
                h('td', { className: 'gl-mono' }, String(s.sessionId).slice(0, 14)),
                h('td', { className: 'gl-num' }, s.turnIndex),
                h('td', { className: 'gl-num' }, s.streak),
                h('td', { className: 'gl-num' }, s.mean === null ? '—' : s.mean.toFixed(3)),
                h('td', { className: 'gl-num' }, s.injections)
              )
            ))
          ),

        h('div', { className: 'gl-hint', style: { marginTop: 6 } },
          '配置文件：', data.file)
      )
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
        return h('div', { className: 'gl-empty' }, '未启用嵌入打分（缺少 embedding key 或已关闭）。')
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
      const [tab, setTab] = useState('field')

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
        ['field', '漂移场'],
        ['clusters', '失败聚类'],
        ['drift', '目标漂移'],
        ['turns', '漂移轮次'],
        ['config', '向量模型'],
        ['correction', '漂移纠正']
      ]

      return h('div', { className: 'gl-root' },
        h('div', { className: 'gl-toolbar' },
          h('button', {
            className: 'gl-btn gl-btn-primary',
            onClick: run,
            disabled: busy
          }, busy ? '分析中…' : (snap ? '重新分析' : '开始分析')),
          status && h('span', { className: 'gl-muted' },
            `嵌入：${!status.embeddingEnabled ? '已关闭'
              : status.embeddingConfigured ? status.embeddingModel + ' ✓'
                : status.embeddingModel + '（key 未配置）'}`),
          snap && h('span', { className: 'gl-muted' },
            `上次分析：${fmtTime(snap.generatedAt)} · 扫描 ${snap.sessionsScanned} 个会话`)
        ),

        error && h('div', { className: 'gl-err' }, error),

        !snap && !busy && tab !== 'config' && h('div', { className: 'gl-empty' },
          '还没有分析结果。点「开始分析」扫描本机会话日志 —— 只读，不会修改任何会话。'),

        snap && h(React.Fragment, null,
          h(StatCards, {
            totals: snap.totals,
            totalFailures: snap.totalFailures,
            distance: snap.distance
          }),

          snap.distanceError && h('div', { className: 'gl-err' },
            '嵌入打分失败：' + snap.distanceError + ' —— 失败聚类仍然可用。')
        ),

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

        tab === 'field' && h(React.Fragment, null,
          h('div', { className: 'gl-section-title' }, '漂移场（半径 = 距离目标的远近）'),
          h('div', { className: 'gl-muted', style: { marginBottom: 8 } },
            '中心亮点是「最初的目标」。每个光点是一个目标，半径 = 它整段会话里可计分轮次的平均距离，越靠外离最初的要求越远；'
            + '角度按会话开始时间顺时针排列（顶部接缝是旧→新的回绕处）；光点之间的连线 = 目标之间的相似度，'
            + '亮线代表几乎是同一个目标被重复提问，上次的路径通常可以直接复用。'),
          h(DriftField, { distance: snap && snap.distance })
        ),

        tab === 'clusters' && h(React.Fragment, null,
          h('div', { className: 'gl-section-title' }, '失败聚类（硬事实，按次数排序）'),
          h('div', { className: 'gl-muted', style: { marginBottom: 8 } },
            '工具报错是确定发生的事实，不受语义判断影响。点任意一行看原始错误与出现位置。'),
          snap && snap.labelRollup && snap.labelRollup.length > 0 && h('div', { style: { marginBottom: 10 } },
            snap.labelRollup.map(l =>
              h('span', { key: l.label, className: 'gl-tag gl-tag-grey', style: { marginRight: 6 } },
                `${l.label} ×${l.count}`)
            )
          ),
          h(ClusterTable, { clusters: snap && snap.clusters })
        ),

        tab === 'drift' && h(React.Fragment, null,
          h('div', { className: 'gl-section-title' }, '目标漂移（排序信号，不是判决）'),
          h('div', { className: 'gl-muted', style: { marginBottom: 8 } },
            '距离 = 1 − cos(目标向量, 该轮输出向量)。距离高≠做错了：长技术任务天然会偏离最初措辞。请人工确认。'),
          h(DriftTable, { distance: snap && snap.distance })
        ),

        tab === 'turns' && h(React.Fragment, null,
          h('div', { className: 'gl-section-title' }, '单轮最漂移'),
          h('div', { className: 'gl-muted', style: { marginBottom: 8 } },
            '纯工具调用轮次（无文字输出）已排除 —— 它们的向量没有意义。'),
          h(WorstTurns, { distance: snap && snap.distance })
        ),

        tab === 'config' && h(EmbedConfig, { onSaved: refreshStatus }),

        tab === 'correction' && h(CorrectionPanel)
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
