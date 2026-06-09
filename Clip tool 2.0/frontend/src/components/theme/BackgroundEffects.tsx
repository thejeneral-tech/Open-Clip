"use client";

import { useEffect, useRef } from "react";
import { hexToRgb } from "@/lib/theme/colorUtils";
import { useTheme } from "./ThemeProvider";

/**
 * Canvas-driven animated backgrounds, ported from Odysseus' theme.js.
 * The static patterns (dots / synapse grid) are pure CSS (see globals.css);
 * these are the moving ones. Each runner reads live CSS vars so it tracks
 * theme + intensity + size changes without remount.
 */

type Runner = (canvas: HTMLCanvasElement) => () => void;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function effectColor(fallback = "#9cdef2"): string {
  return cssVar("--bg-effect-color") || cssVar("--fg") || fallback;
}
function effectIntensity(): number {
  const v = parseFloat(cssVar("--bg-effect-intensity"));
  return Number.isNaN(v) ? 1 : v;
}
function effectSize(): number {
  const v = parseFloat(cssVar("--bg-effect-size"));
  return Number.isNaN(v) ? 1 : v;
}

function setup(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d")!;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let W = 0;
  let H = 0;
  function resize() {
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  return { ctx, dpr, get W() { return W; }, get H() { return H; }, resize };
}

const synapse: Runner = (canvas) => {
  const { ctx, resize } = setup(canvas);
  const GRID = 24, MAX = 20, SMIN = 2, SMAX = 22, TRAIL = 12;
  let raf = 0;
  let pulses: { x: number; y: number; dx: number; dy: number }[] = [];
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  const spawn = () => {
    const speed = SMIN + Math.random() * (SMAX - SMIN);
    if (Math.random() > 0.5) {
      const row = Math.floor(Math.random() * (Math.ceil(window.innerHeight / GRID) + 1));
      pulses.push({ x: -TRAIL, y: row * GRID, dx: speed, dy: 0 });
    } else {
      const col = Math.floor(Math.random() * (Math.ceil(window.innerWidth / GRID) + 1));
      pulses.push({ x: col * GRID, y: -TRAIL, dx: 0, dy: speed });
    }
  };
  const draw = () => {
    raf = requestAnimationFrame(draw);
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    const c = effectColor();
    if (pulses.length < MAX && Math.random() < 0.12) spawn();
    for (let i = pulses.length - 1; i >= 0; i--) {
      const p = pulses[i];
      p.x += p.dx; p.y += p.dy;
      if (p.x > W + TRAIL || p.y > H + TRAIL) { pulses.splice(i, 1); continue; }
      const tx = p.x - (p.dx > 0 ? TRAIL : 0);
      const ty = p.y - (p.dy > 0 ? TRAIL : 0);
      const grad = ctx.createLinearGradient(tx, ty, p.x, p.y);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad; ctx.globalAlpha = 0.35; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(p.x, p.y); ctx.stroke();
      ctx.globalAlpha = 0.55; ctx.fillStyle = c;
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  draw();
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
};

const rain: Runner = (canvas) => {
  const { ctx, resize } = setup(canvas);
  const MAX = 130;
  let raf = 0;
  const drops: { x: number; y: number; len: number; speed: number; alpha: number }[] = [];
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  const spawn = () => {
    const len = 20 + Math.random() * 40;
    drops.push({ x: Math.random() * window.innerWidth, y: -len, len, speed: 4 + Math.random() * 8, alpha: 0.32 + Math.random() * 0.28 });
  };
  const draw = () => {
    raf = requestAnimationFrame(draw);
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    const c = effectColor();
    const inten = effectIntensity();
    const speedMult = 0.35 + inten * 0.65;
    const sizeMult = effectSize();
    if (drops.length < MAX * inten && Math.random() < 0.6 * inten) spawn();
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.y += d.speed * speedMult;
      if (d.y > H + d.len * sizeMult) { drops.splice(i, 1); continue; }
      const effLen = d.len * sizeMult;
      const grad = ctx.createLinearGradient(d.x, d.y - effLen, d.x, d.y);
      grad.addColorStop(0, "transparent");
      grad.addColorStop(1, c);
      ctx.strokeStyle = grad; ctx.globalAlpha = d.alpha;
      ctx.lineWidth = 1.3 * Math.min(2, Math.max(0.6, sizeMult));
      ctx.beginPath(); ctx.moveTo(d.x, d.y - effLen); ctx.lineTo(d.x, d.y); ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  draw();
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
};

const constellations: Runner = (canvas) => {
  const { ctx } = setup(canvas);
  const COUNT = 50, DIST = 120;
  let raf = 0, t = 0;
  let stars: { x: number; y: number; vx: number; vy: number; r: number; phase: number }[] = [];
  const initStars = () => {
    stars = [];
    for (let i = 0; i < COUNT; i++)
      stars.push({
        x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight,
        vx: (Math.random() - 0.5) * 0.15, vy: (Math.random() - 0.5) * 0.15,
        r: 0.8 + Math.random() * 0.8, phase: Math.random() * Math.PI * 2,
      });
  };
  initStars();
  const onResize = () => { canvas.width = window.innerWidth * Math.min(window.devicePixelRatio || 1, 2); canvas.height = window.innerHeight * Math.min(window.devicePixelRatio || 1, 2); const dpr = Math.min(window.devicePixelRatio || 1, 2); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); initStars(); };
  window.addEventListener("resize", onResize);
  const draw = () => {
    raf = requestAnimationFrame(draw);
    t += 0.01;
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    const c = effectColor();
    for (const s of stars) {
      s.x += s.vx; s.y += s.vy;
      if (s.x < 0) s.x = W; if (s.x > W) s.x = 0;
      if (s.y < 0) s.y = H; if (s.y > H) s.y = 0;
    }
    ctx.strokeStyle = c; ctx.lineWidth = 0.5;
    for (let i = 0; i < stars.length; i++)
      for (let j = i + 1; j < stars.length; j++) {
        const dx = stars[i].x - stars[j].x, dy = stars[i].y - stars[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < DIST) {
          ctx.globalAlpha = (1 - dist / DIST) * 0.15;
          ctx.beginPath(); ctx.moveTo(stars[i].x, stars[i].y); ctx.lineTo(stars[j].x, stars[j].y); ctx.stroke();
        }
      }
    ctx.fillStyle = c;
    for (const s of stars) {
      const tw = 0.5 + 0.5 * Math.sin(t * 2 + s.phase);
      ctx.globalAlpha = 0.15 + tw * 0.25;
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  };
  draw();
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
};

function noise2d(x: number, y: number) { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); }
function smoothNoise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const a = noise2d(ix, iy), b = noise2d(ix + 1, iy), cc = noise2d(ix, iy + 1), d = noise2d(ix + 1, iy + 1);
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  return a + (b - a) * ux + (cc - a) * uy + (a - b - cc + d) * ux * uy;
}

const perlinFlow: Runner = (canvas) => {
  const { ctx, resize } = setup(canvas);
  let raf = 0, t = 0;
  const particles: { x: number; y: number; life: number }[] = [];
  for (let i = 0; i < 200; i++) particles.push({ x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight, life: Math.random() });
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  let cachedBg = "", fade = "rgba(0,0,0,0.02)";
  const getFade = () => {
    const bg = cssVar("--bg") || "#282c34";
    if (bg !== cachedBg) { cachedBg = bg; const { r, g, b } = hexToRgb(bg) || { r: 0, g: 0, b: 0 }; fade = `rgba(${r},${g},${b},0.02)`; }
    return fade;
  };
  const draw = () => {
    raf = requestAnimationFrame(draw);
    const W = window.innerWidth, H = window.innerHeight;
    ctx.fillStyle = getFade(); ctx.fillRect(0, 0, W, H);
    const c = effectColor();
    particles.forEach((p) => {
      const n = smoothNoise(p.x * 0.004 + t * 0.0008, p.y * 0.004 + 100);
      const angle = n * Math.PI * 6;
      const speed = 1 + smoothNoise(p.x * 0.003, p.y * 0.003 + 50) * 1.5;
      p.x += Math.cos(angle) * speed; p.y += Math.sin(angle) * speed; p.life -= 0.001;
      if (p.life <= 0 || p.x < 0 || p.x > W || p.y < 0 || p.y > H) { p.x = Math.random() * W; p.y = Math.random() * H; p.life = 1; }
      ctx.beginPath(); ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.globalAlpha = p.life * 0.15; ctx.fill();
    });
    ctx.globalAlpha = 1; t++;
  };
  draw();
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
};

const petals: Runner = (canvas) => {
  const { ctx, resize } = setup(canvas);
  let raf = 0;
  type P = { x: number; y: number; size: number; rot: number; vr: number; vy: number; drift: number; driftSpeed: number; wobble: number };
  const make = (): P => ({
    x: Math.random() * window.innerWidth, y: -10 - Math.random() * 40,
    size: 3 + Math.random() * 5, rot: Math.random() * Math.PI * 2,
    vr: (Math.random() - 0.5) * 0.03, vy: 0.3 + Math.random() * 0.6,
    drift: Math.random() * Math.PI * 2, driftSpeed: 0.008 + Math.random() * 0.012,
    wobble: 0.3 + Math.random() * 0.8,
  });
  const list: P[] = [];
  for (let i = 0; i < 30; i++) { const p = make(); p.y = Math.random() * window.innerHeight; list.push(p); }
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  const draw = () => {
    raf = requestAnimationFrame(draw);
    const W = window.innerWidth, H = window.innerHeight;
    ctx.clearRect(0, 0, W, H);
    const c = effectColor();
    const sz = effectSize();
    list.forEach((p) => {
      p.y += p.vy; p.rot += p.vr; p.drift += p.driftSpeed;
      p.x += Math.sin(p.drift) * p.wobble;
      if (p.y > H + 15) Object.assign(p, make());
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot);
      ctx.globalAlpha = 0.2; ctx.fillStyle = c;
      ctx.beginPath(); ctx.ellipse(-p.size * 0.2 * sz, 0, p.size * 0.6 * sz, p.size * 0.3 * sz, 0.3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.15;
      ctx.beginPath(); ctx.ellipse(p.size * 0.2 * sz, 0, p.size * 0.6 * sz, p.size * 0.3 * sz, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.restore();
    });
    ctx.globalAlpha = 1;
  };
  draw();
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
};

const sparkles: Runner = (canvas) => {
  const { ctx, resize } = setup(canvas);
  let raf = 0;
  type S = { x: number; y: number; size: number; phase: number; speed: number; life: number };
  const make = (): S => ({ x: Math.random() * window.innerWidth, y: Math.random() * window.innerHeight, size: 2 + Math.random() * 5, phase: Math.random() * Math.PI * 2, speed: 0.015 + Math.random() * 0.03, life: 0.5 + Math.random() * 0.5 });
  const list: S[] = [];
  for (let i = 0; i < 35; i++) list.push(make());
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  const star = (x: number, y: number, r: number, c: string, alpha: number) => {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = c; ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(0, -r); ctx.quadraticCurveTo(r * 0.15, -r * 0.15, r, 0);
    ctx.quadraticCurveTo(r * 0.15, r * 0.15, 0, r);
    ctx.quadraticCurveTo(-r * 0.15, r * 0.15, -r, 0);
    ctx.quadraticCurveTo(-r * 0.15, -r * 0.15, 0, -r);
    ctx.fill(); ctx.restore();
  };
  const draw = () => {
    raf = requestAnimationFrame(draw);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const c = effectColor();
    const sz = effectSize();
    list.forEach((s) => {
      s.phase += s.speed;
      const tw = Math.sin(s.phase);
      const alpha = Math.max(0, tw) * 0.25 * s.life;
      const scale = 0.5 + Math.max(0, tw) * 0.5;
      if (alpha > 0.01) star(s.x, s.y, s.size * scale * sz, c, alpha);
      if (s.phase > Math.PI * 6) Object.assign(s, make());
    });
    ctx.globalAlpha = 1;
  };
  draw();
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
};

const embers: Runner = (canvas) => {
  const { ctx, resize } = setup(canvas);
  let raf = 0;
  type E = { x: number; y: number; vx: number; vy: number; r: number; life: number; maxLife: number; wobble: number; spark: boolean };
  const make = (): E => ({
    x: Math.random() * window.innerWidth, y: window.innerHeight + Math.random() * 40,
    vx: (Math.random() - 0.5) * 0.3, vy: -0.3 - Math.random() * 0.8,
    r: 0.3 + Math.random() * 0.6, life: 0, maxLife: 220 + Math.random() * 220,
    wobble: Math.random() * Math.PI * 2, spark: false,
  });
  const list: E[] = [];
  for (let i = 0; i < 60; i++) { const e = make(); e.y = Math.random() * window.innerHeight; e.life = Math.random() * e.maxLife; list.push(e); }
  const onResize = () => resize();
  window.addEventListener("resize", onResize);
  const rgba = (hex: string, a: number) => { const { r, g, b } = hexToRgb(hex) || { r: 0, g: 0, b: 0 }; return `rgba(${r},${g},${b},${a})`; };
  const draw = () => {
    raf = requestAnimationFrame(draw);
    const W = window.innerWidth, H = window.innerHeight;
    ctx.globalCompositeOperation = "destination-out";
    ctx.fillStyle = "rgba(0,0,0,0.18)"; ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";
    const color = effectColor("#c9a95a");
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i];
      e.wobble += 0.03; e.x += e.vx + Math.sin(e.wobble) * 0.5; e.y += e.vy; e.life++;
      if (e.life > e.maxLife || e.y < -20) { list.splice(i, 1); if (list.length < 70) list.push(make()); continue; }
      if (!e.spark && Math.random() < 0.003) e.spark = true;
      const ratio = e.life / e.maxLife;
      const fade = Math.min(1, Math.min(ratio * 4, (1 - ratio) * 3));
      const sz = effectSize();
      const r = e.r * (e.spark ? 2.4 : 1) * sz;
      const a = (e.spark ? 0.9 : 0.55) * fade;
      const g = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r * 4);
      g.addColorStop(0, rgba(color, a)); g.addColorStop(0.4, rgba(color, a * 0.3)); g.addColorStop(1, rgba(color, 0));
      ctx.fillStyle = g; ctx.fillRect(e.x - r * 4, e.y - r * 4, r * 8, r * 8);
      ctx.fillStyle = rgba("#ffffff", a * 0.6);
      ctx.beginPath(); ctx.arc(e.x, e.y, r * 0.5, 0, Math.PI * 2); ctx.fill();
      e.spark = false;
    }
    if (Math.random() < 0.015) {
      const bx = Math.random() * W;
      for (let i = 0; i < 5; i++) { const e = make(); e.x = bx + (Math.random() - 0.5) * 40; e.y = H - 10; e.vy *= 1.5; list.push(e); }
    }
    ctx.globalCompositeOperation = "source-over";
  };
  draw();
  return () => { cancelAnimationFrame(raf); window.removeEventListener("resize", onResize); };
};

const RUNNERS: Partial<Record<string, Runner>> = {
  synapse, rain, constellations, "perlin-flow": perlinFlow, petals, sparkles, embers,
};

export function BackgroundEffects() {
  const { bgPattern, bgEffectIntensity } = useTheme();
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const runner = RUNNERS[bgPattern];
    const canvas = canvasRef.current;
    if (!runner || !canvas) return;
    const cleanup = runner(canvas);
    return cleanup;
  }, [bgPattern]);

  // Hide the canvas entirely for non-canvas patterns.
  const active = bgPattern in RUNNERS;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      style={{
        position: "fixed",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none",
        zIndex: 0,
        display: active ? "block" : "none",
        opacity: bgEffectIntensity,
      }}
    />
  );
}
