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
.gl-tag-red { background:rgba(255,201,77,.20); color:#a8710a; }
.gl-tag-orange { background:rgba(216,168,96,.20); color:#8f6224; }
.gl-tag-yellow { background:rgba(148,174,192,.24); color:#41677f; }
.gl-tag-green { background:rgba(125,156,179,.22); color:#3a5c73; }
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
.gl-field-canvas { display:block; width:100%; height:340px; cursor:crosshair; }
.gl-field-legend { position:absolute; left:12px; bottom:10px; display:flex; gap:12px;
  flex-wrap:wrap; font-size:11px; color:rgba(198,214,228,.82);
  background:rgba(8,14,20,.55); padding:5px 9px; border-radius:6px;
  backdrop-filter:blur(3px); pointer-events:none; }
.gl-legend-dot { display:inline-block; width:7px; height:7px; border-radius:50%;
  margin-right:5px; vertical-align:middle; }
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
    // Drift field: cold gray-blue canvas, one gold light per goal.
    // The radius IS the drift — the bright core is the objective as asked,
    // the rim is maximal distance from it. Angle is decorative (golden-angle
    // spacing + a hash-derived jitter, so a goal keeps its spot between
    // renders). Colors match the band tags used in the tables.
    // ---------------------------------------------------------------------

    // Cold gray-blue field, gold light. Gold means "drifted", gray-blue means
    // "focused" — the color carries the same meaning as the table tags instead
    // of being decoration, and the palette stays within the gray-blue brief.
    const BAND_COLORS = {
      green: '#7d9cb3',
      yellow: '#94aec0',
      orange: '#d8a860',
      red: '#ffc94d',
      grey: '#75899b'
    }
    const BAND_GLOW = {
      green: [125, 156, 179],
      yellow: [148, 174, 192],
      orange: [216, 168, 96],
      red: [255, 201, 77],
      grey: [117, 137, 155]
    }
    const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
    /** Distance that maps to the outer rim; leaves headroom past the 0.65 band. */
    const R_MAX_DIST = 0.8

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

    /** Distance payload → normalized polar points. */
    function layoutPoints(items) {
      const scored = (items ?? []).filter(g => typeof g.meanDistance === 'number')
      const sorted = [...scored].sort((a, b) => b.meanDistance - a.meanDistance)
      return sorted.map((g, i) => {
        const jitter = hash01(g.goalId) - 0.5
        return {
          id: g.goalId,
          objective: g.objective ?? '',
          distance: g.meanDistance,
          turns: g.turnCount ?? 0,
          calls: g.totalCalls ?? 0,
          failed: g.failedCalls ?? 0,
          band: band(g.meanDistance)[1],
          angle: i * GOLDEN_ANGLE + jitter * 0.55,
          // The floor keeps a well-focused goal off the core sprite, which would
          // otherwise read as the core itself and hide the light.
          radius: Math.max(0.13, Math.min(1, g.meanDistance / R_MAX_DIST)),
          // Log keeps one long session from dwarfing every other point.
          size: Math.min(6.5, 1.6 + Math.log((g.turnCount ?? 1) + 1) * 1.5)
        }
      })
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
     * Paint one frame. Returns projected points so the caller can hit-test.
     */
    function drawField(g, width, height, points, time, hoverId) {
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

      // --- band rings ------------------------------------------------------
      // Labels sit on the upper-left diagonal, where the ring is empty, instead
      // of at 3 o'clock where the goal points crowd the rim.
      for (const ring of [0.35, 0.5, 0.65]) {
        const r = (ring / R_MAX_DIST) * maxR
        g.beginPath()
        g.setLineDash([1, 6])
        g.strokeStyle = ring >= 0.65
          ? 'rgba(150,190,222,0.26)'
          : 'rgba(120,158,192,0.15)'
        g.lineWidth = 1
        g.ellipse(cx, cy, r, r * 0.9, 0, 0, Math.PI * 2)
        g.stroke()
        g.setLineDash([])

        const la = Math.PI * 1.18
        g.font = '9px ui-monospace, Consolas, monospace'
        g.fillStyle = 'rgba(150,186,214,0.55)'
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillText(ring.toFixed(2), cx + Math.cos(la) * r, cy + Math.sin(la) * r * 0.9)
      }

      // --- filaments: the light's threads ----------------------------------
      // Each one is drawn three times at widening width and falling alpha, which
      // gives the soft bloom of the reference instead of a hard hairline.
      for (const p of points) {
        const x = cx + Math.cos(p.angle) * p.radius * maxR
        const y = cy + Math.sin(p.angle) * p.radius * maxR * 0.9
        const bend = 0.34 + (hash01(p.id) - 0.5) * 0.5
        const mx = cx + Math.cos(p.angle + bend) * p.radius * maxR * 0.52
        const my = cy + Math.sin(p.angle + bend) * p.radius * maxR * 0.52 * 0.9
        const hot = p.band === 'red' || p.band === 'orange'
        const base = hot ? [255, 198, 96] : [150, 186, 214]
        const strength = hot ? 1 : 0.5
        for (let layer = 0; layer < 3; layer++) {
          g.beginPath()
          g.moveTo(cx, cy)
          g.quadraticCurveTo(mx, my, x, y)
          g.strokeStyle = 'rgba(' + base.join(',') + ',' +
            ((hot ? 0.10 : 0.055) * strength * (1 - layer * 0.32)).toFixed(3) + ')'
          g.lineWidth = 0.6 + layer * 1.7
          g.stroke()
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
        const x = cx + Math.cos(p.angle) * p.radius * maxR
        const y = cy + Math.sin(p.angle) * p.radius * maxR * 0.9
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

      return projected
    }

    function DriftField({ distance }) {
      const canvasRef = useRef(null)
      const wrapRef = useRef(null)
      const pointsRef = useRef([])
      const hoverRef = useRef(null)
      const [hover, setHover] = useState(null)
      const [tip, setTip] = useState(null)

      const points = useMemo(
        () => layoutPoints(distance ? distance.items : []),
        [distance]
      )
      pointsRef.current = points

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
          const projected = drawField(ctx2d, lastW, lastH, pointsRef.current, time, hoverRef.current)
          canvas.__glPoints = projected
          raf = window.requestAnimationFrame(frame)
        }

        resize()
        // First paint is synchronous so the panel is never briefly empty.
        canvas.__glPoints = drawField(ctx2d, lastW, lastH, pointsRef.current, 0, null)
        raf = window.requestAnimationFrame(frame)

        return () => {
          alive = false
          if (raf) window.cancelAnimationFrame(raf)
        }
      }, [points.length])

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
            `${tip.point.turns} 轮 · ${tip.point.calls} 次调用 · ${tip.point.failed} 次失败`)
        )
      )
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
        ['config', '向量模型']
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
            '中心亮点是「最初的目标」，每个光点是一个目标在整段会话里偏离它的程度 —— 越靠外越远。颜色与下方表格的档位一致。'),
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

        tab === 'config' && h(EmbedConfig, { onSaved: refreshStatus })
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
