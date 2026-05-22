/* =====================================================
   SLACKADEMICS — Utilities
   Pure helpers. No DOM, no state imports.
   ===================================================== */
'use strict';

// ── Shuffle (Fisher-Yates, returns new array) ─────────────
export function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Sleep (awaitable delay) ───────────────────────────────
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Linear interpolate ────────────────────────────────────
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

// ── Clamp ─────────────────────────────────────────────────
export function clamp(val, min, max) {
  return Math.min(max, Math.max(min, val));
}

// ── Unique ID generator ───────────────────────────────────
let _seq = 0;
export function uid(prefix = 'id') {
  return prefix + '-' + (++_seq);
}

// ── Get element centre position (for animations) ─────────
export function getDOMPosition(el) {
  const r = el.getBoundingClientRect();
  return {
    x: r.left + r.width  / 2,
    y: r.top  + r.height / 2,
    w: r.width,
    h: r.height,
  };
}

// ── Deep clone via JSON ───────────────────────────────────
export function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Random integer in [min, max] ──────────────────────────
export function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ── Pick random item from array ───────────────────────────
export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ── Weighted random choice ────────────────────────────────
// weights: [{ item, weight }, ...]
export function weightedPick(weights) {
  const total = weights.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * total;
  for (const { item, weight } of weights) {
    r -= weight;
    if (r <= 0) return item;
  }
  return weights[weights.length - 1].item;
}
