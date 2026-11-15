// Qline agent energy core — procedural canvas renderer (prototype).
// States and agent identities follow docs/03-DESIGN_SYSTEM.md §2 and §6.
(function () {
  const AGENTS = {
    ceo:       { name: 'AI CEO',     role: 'Chief of Staff', hue: '#A58BFA', speed: 0.55, curl: 1.0 },
    sales:     { name: 'Sales',      role: 'Pipeline & follow-ups', hue: '#2ED3EA', speed: 1.25, curl: 0.8 },
    finance:   { name: 'Finance',    role: 'Cash flow & reports', hue: '#F2B544', speed: 0.75, curl: 0.25 },
    ops:       { name: 'Operations', role: 'Projects & SOPs', hue: '#3FD39A', speed: 0.9, curl: 0.45 },
    marketing: { name: 'Marketing',  role: 'Campaigns & content', hue: '#F07AC0', speed: 1.0, curl: 1.6 },
    research:  { name: 'Research',   role: 'Market & competitors', hue: '#6FA8FF', speed: 0.7, curl: 0.7 },
  };
  const IVORY = [236, 226, 204], HALO = [235, 203, 139], AMBER = [242, 181, 68], BAD = [242, 119, 122], GREY = [120, 132, 146];

  // target parameters per state
  const STATES = {
    idle:      { glow: .75, scale: 1.0, ring: IVORY, ringW: 1.6, halo: .18, sSpeed: 1.0, sAlpha: .32, conv: 0, dash: 0, sats: 0, notch: 0, err: 0, wave: 0, amp: 0, desat: 0, cross: .25 },
    listening: { glow: 1.0, scale: 1.08, ring: IVORY, ringW: 1.8, halo: .42, sSpeed: .6, sAlpha: .28, conv: 0, dash: 0, sats: 0, notch: 0, err: 0, wave: 0, amp: 1, desat: 0, cross: .15 },
    thinking:  { glow: .9, scale: .94, ring: IVORY, ringW: 1.6, halo: .2, sSpeed: 2.4, sAlpha: .42, conv: 1, dash: 1, sats: 0, notch: 0, err: 0, wave: 0, amp: 0, desat: 0, cross: .7 },
    tool:      { glow: .85, scale: 1.0, ring: AMBER, ringW: 2.2, halo: .26, sSpeed: 1.6, sAlpha: .36, conv: .5, dash: 1, sats: 2, notch: 0, err: 0, wave: 0, amp: 0, desat: 0, cross: .85 },
    approval:  { glow: .5, scale: .96, ring: HALO, ringW: 2.6, halo: .3, sSpeed: .15, sAlpha: .18, conv: 0, dash: 0, sats: 0, notch: 1, err: 0, wave: 0, amp: 0, desat: 0, cross: .1 },
    speaking:  { glow: 1.0, scale: 1.04, ring: IVORY, ringW: 1.8, halo: .3, sSpeed: 1.1, sAlpha: .34, conv: 0, dash: 0, sats: 0, notch: 0, err: 0, wave: 1, amp: 0, desat: 0, cross: .3 },
    success:   { glow: 1.25, scale: 1.02, ring: IVORY, ringW: 1.8, halo: .34, sSpeed: .8, sAlpha: .3, conv: 0, dash: 0, sats: 0, notch: 0, err: 0, wave: 0, amp: 0, desat: 0, cross: .2 },
    error:     { glow: .35, scale: .92, ring: GREY, ringW: 1.4, halo: .08, sSpeed: .35, sAlpha: .16, conv: 0, dash: 0, sats: 0, notch: 0, err: 1, wave: 0, amp: 0, desat: .75, cross: .05 },
    offline:   { glow: .2, scale: .9, ring: GREY, ringW: 1.2, halo: 0, sSpeed: 0, sAlpha: .08, conv: 0, dash: 1, sats: 0, notch: 0, err: 0, wave: 0, amp: 0, desat: 1, cross: 0 },
  };

  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const rgba = (c, a) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const lerp = (a, b, t) => a + (b - a) * t;
  function rand(seed) { let s = seed; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

  class Core {
    constructor() {
      this.canvas = null; this.agent = 'ceo'; this.state = 'idle'; this.reduce = false;
      this.p = JSON.parse(JSON.stringify(STATES.idle)); this.hue = hex(AGENTS.ceo.hue);
      this.t = 0; this.last = 0; this.raf = 0; this.flash = 0; this.compact = false;
      const r = rand(7);
      this.stars = Array.from({ length: 80 }, () => ({ x: r(), y: r(), s: r() * 1.2 + .3, p: r() * 6.28 }));
      this.parts = Array.from({ length: 170 }, () => { const a = r() * 6.283; const d = Math.pow(r(), 1.8); return { a, d, p: r() * 6.28, s: r() * 1.3 + .4 }; });
      this.strands = Array.from({ length: 7 }, (_, i) => ({ rx: 1.25 + r() * .7, ry: 1.0 + r() * .7, ph: r() * 6.28, rot: r() * 6.28, sp: (r() * .6 + .4) * (i % 2 ? 1 : -1), len: .35 + r() * .35, warm: i % 3 === 0 }));
      this.loop = this.loop.bind(this);
      document.addEventListener('visibilitychange', () => { if (!document.hidden) this.kick(); });
    }
    attach(canvas, opts = {}) {
      this.canvas = canvas; this.compact = !!opts.compact; this.cy = opts.cy ?? .52;
      this.resize(); this.kick();
    }
    detach() { this.canvas = null; cancelAnimationFrame(this.raf); this.raf = 0; }
    resize() {
      if (!this.canvas) return; const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = this.canvas.getBoundingClientRect(); this.w = r.width; this.h = r.height;
      this.canvas.width = Math.max(1, r.width * dpr); this.canvas.height = Math.max(1, r.height * dpr);
      this.ctx = this.canvas.getContext('2d'); this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    setAgent(a) { this.agent = a; this.kick(); }
    setState(s) { if (s === 'success' && this.state !== 'success') this.flash = 1; this.state = s; this.kick(); }
    setReduce(v) { this.reduce = v; this.kick(); }
    kick() {
      if (!this.canvas) return;
      if (this.reduce) { cancelAnimationFrame(this.raf); this.raf = 0; this.snap(); this.draw(0); return; }
      if (!this.raf) { this.last = performance.now(); this.raf = requestAnimationFrame(this.loop); }
    }
    snap() { Object.assign(this.p, JSON.parse(JSON.stringify(STATES[this.state]))); this.hue = hex(AGENTS[this.agent].hue); this.flash = 0; }
    loop(now) {
      this.raf = 0; if (!this.canvas || !this.canvas.isConnected || document.hidden) return;
      const dt = Math.min(.05, (now - this.last) / 1000); this.last = now;
      const ag = AGENTS[this.agent]; this.t += dt * (ag.speed);
      const tgt = STATES[this.state], k = Math.min(1, dt * 2.6);
      for (const key in tgt) { if (Array.isArray(tgt[key])) this.p[key] = mix(this.p[key], tgt[key], k); else this.p[key] = lerp(this.p[key], tgt[key], k); }
      this.hue = mix(this.hue, hex(ag.hue), k);
      this.flash = Math.max(0, this.flash - dt * 2.5);
      this.draw(dt);
      this.raf = requestAnimationFrame(this.loop);
    }
    draw() {
      const c = this.ctx, w = this.w, h = this.h; if (!c) return;
      const p = this.p, t = this.t, ag = AGENTS[this.agent];
      const hue = mix(this.hue, [150, 158, 168], p.desat);
      const cx = w / 2, cy = h * this.cy, R = Math.min(w, h) * (this.compact ? .2 : .22);
      // amplitude (listening = simulated mic level, speaking = simulated TTS envelope)
      const micAmp = p.amp * (.35 + .35 * Math.sin(t * 7.3) * Math.sin(t * 2.1) + .3 * Math.abs(Math.sin(t * 13.7)));
      c.globalCompositeOperation = 'source-over';
      c.fillStyle = '#05070A'; c.fillRect(0, 0, w, h);
      let g = c.createRadialGradient(cx, cy, R * .2, cx, cy, R * 3.4);
      g.addColorStop(0, rgba(hue, .16 * p.glow)); g.addColorStop(.5, rgba(hue, .05 * p.glow)); g.addColorStop(1, 'rgba(5,7,10,0)');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
      // stars
      for (const s of this.stars) { const a = .25 + .25 * Math.sin(t * 1.3 + s.p); c.fillStyle = `rgba(200,215,230,${a * .55})`; c.fillRect(s.x * w, s.y * h, s.s, s.s); }
      c.globalCompositeOperation = 'lighter';
      // vertical crossing strands (reel reference: processing)
      if (p.cross > .01) {
        for (let j = 0; j < 2; j++) {
          const col = j ? hue : AMBER; c.beginPath();
          for (let y = -20; y <= h + 20; y += 8) {
            const x = cx + Math.sin(y * .012 + t * (j ? 1.3 : -1.1) + j * 2) * R * (.35 + .25 * j) + Math.sin(y * .03 + t) * 4;
            y === -20 ? c.moveTo(x, y) : c.lineTo(x, y);
          }
          const lg = c.createLinearGradient(0, 0, 0, h); lg.addColorStop(0, rgba(col, 0)); lg.addColorStop(.3, rgba(col, .5 * p.cross)); lg.addColorStop(.5, rgba(col, .05)); lg.addColorStop(.7, rgba(col, .45 * p.cross)); lg.addColorStop(1, rgba(col, 0));
          c.strokeStyle = lg; c.lineWidth = 1.4; c.stroke();
        }
      }
      // orbiting ribbons (reel reference: listening)
      for (const s of this.strands) {
        const col = s.warm ? mix(IVORY, AMBER, .5) : mix(hue, IVORY, .25);
        const rot = s.rot + t * .15 * s.sp * p.sSpeed;
        const start = s.ph + t * .5 * s.sp * p.sSpeed; const N = 46;
        for (let i = 0; i < N - 1; i++) {
          const u0 = start + (i / N) * s.len * 6.283, u1 = start + ((i + 1) / N) * s.len * 6.283;
          const pt = (u) => { const wob = 1 + Math.sin(u * 3 + t * 1.5) * .05 * ag.curl * (1 + p.sSpeed * .3) + p.halo * .25;
            const x = Math.cos(u) * R * s.rx * wob, y = Math.sin(u) * R * s.ry * wob;
            return [cx + x * Math.cos(rot) - y * Math.sin(rot), cy + x * Math.sin(rot) + y * Math.cos(rot)]; };
          const a = pt(u0), b = pt(u1); const fade = Math.sin((i / N) * Math.PI);
          c.strokeStyle = rgba(col, p.sAlpha * fade); c.lineWidth = 1.1;
          c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke();
        }
      }
      c.globalCompositeOperation = 'source-over';
      // outer halo
      const ringC = p.ring; const haloR = R * (1.0 + p.halo * .9 + micAmp * .12);
      g = c.createRadialGradient(cx, cy, R * .95, cx, cy, haloR + R * .35);
      g.addColorStop(0, rgba(ringC, .0)); g.addColorStop(.25, rgba(ringC, .10 * (p.halo * 2 + .2))); g.addColorStop(1, rgba(ringC, 0));
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, haloR + R * .35, 0, 6.283); c.fill();
      if (p.halo > .3) { c.strokeStyle = rgba(ringC, .18 * p.halo); c.lineWidth = 1; c.beginPath(); c.arc(cx, cy, R * (1.28 + micAmp * .05), 0, 6.283); c.stroke(); }
      // inner disk
      const sc = p.scale * (1 + micAmp * .06);
      g = c.createRadialGradient(cx, cy, 0, cx, cy, R);
      g.addColorStop(0, rgba(mix(hue, [255, 255, 255], .3), .55 * p.glow)); g.addColorStop(.45, rgba(mix(hue, [10, 12, 20], .55), .55)); g.addColorStop(1, rgba([8, 10, 18], .96));
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, R, 0, 6.283); c.fill();
      // inner orbit ring (dashed when thinking / working)
      c.save(); c.strokeStyle = rgba(mix(hue, IVORY, .4), .32); c.lineWidth = 1;
      if (p.dash > .5) { c.setLineDash([R * .12, R * .09]); c.lineDashOffset = -t * 40; }
      c.beginPath(); c.arc(cx, cy, R * .64, 0, 6.283); c.stroke(); c.restore();
      // core particles
      c.globalCompositeOperation = 'lighter';
      const breath = 1 + Math.sin(t * 1.6) * .04;
      for (const q of this.parts) {
        const d = q.d * R * .55 * sc * breath * (1 - p.conv * .45 * (.5 + .5 * Math.sin(t * 3 + q.p)));
        const a = q.a + t * .25 * (1 + p.conv);
        const x = cx + Math.cos(a) * d, y = cy + Math.sin(a) * d;
        const al = (.25 + .55 * (1 - q.d)) * p.glow * (.6 + .4 * Math.sin(t * 4 + q.p));
        c.fillStyle = rgba(q.d < .3 ? [255, 255, 255] : mix(hue, [255, 255, 255], .35), Math.max(0, al));
        c.fillRect(x, y, q.s, q.s);
      }
      g = c.createRadialGradient(cx, cy, 0, cx, cy, R * .42 * sc);
      g.addColorStop(0, rgba([255, 255, 255], .9 * Math.min(1, p.glow + this.flash))); g.addColorStop(.25, rgba(mix(hue, [255, 255, 255], .5), .45 * p.glow)); g.addColorStop(1, rgba(hue, 0));
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, R * .42 * sc, 0, 6.283); c.fill();
      if (this.flash > 0) { c.fillStyle = rgba(IVORY, .12 * this.flash); c.beginPath(); c.arc(cx, cy, R * 1.6, 0, 6.283); c.fill(); }
      c.globalCompositeOperation = 'source-over';
      // main ring
      c.save(); c.shadowColor = rgba(ringC, .9); c.shadowBlur = 14 + p.halo * 16; c.strokeStyle = rgba(ringC, .95); c.lineWidth = p.ringW;
      const gap = p.notch * .14; const startA = -Math.PI / 2 + gap, endA = -Math.PI / 2 + 6.283 - gap;
      c.beginPath();
      if (p.wave > .02) {
        for (let i = 0; i <= 180; i++) { const a = startA + (endA - startA) * i / 180; const rr = R * (1 + p.wave * .022 * Math.sin(a * 9 + t * 9) * (.6 + .4 * Math.sin(t * 5.1))); const x = cx + Math.cos(a) * rr, y = cy + Math.sin(a) * rr; i ? c.lineTo(x, y) : c.moveTo(x, y); }
      } else c.arc(cx, cy, R, startA, endA);
      c.stroke(); c.restore();
      if (p.notch > .3) { c.strokeStyle = rgba(HALO, p.notch); c.lineWidth = 2; c.beginPath(); c.moveTo(cx, cy - R - 6); c.lineTo(cx, cy - R - 16); c.stroke(); }
      if (p.err > .05) { c.save(); c.strokeStyle = rgba(BAD, .9 * p.err); c.lineWidth = 2.4; c.beginPath(); c.arc(cx, cy, R, -0.55, 0.15); c.stroke(); c.restore(); }
      // tool satellites
      if (p.sats > .05) {
        const n = Math.round(STATES[this.state].sats) || 2;
        for (let i = 0; i < n; i++) { const a = t * 1.6 + i * (6.283 / n); const x = cx + Math.cos(a) * R * 1.13, y = cy + Math.sin(a) * R * 1.13;
          c.fillStyle = rgba(AMBER, p.sats / 2); c.beginPath(); c.arc(x, y, 3, 0, 6.283); c.fill(); c.fillStyle = rgba(AMBER, .15 * p.sats / 2); c.beginPath(); c.arc(x, y, 8, 0, 6.283); c.fill(); }
      }
    }
  }
  window.QlineCore = { Core, AGENTS, STATES };
})();
