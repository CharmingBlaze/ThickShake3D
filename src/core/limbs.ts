// Split a drawn outline into a body and the limbs sticking out of it, like a palm and its fingers, so each part
// can be inflated along its own direction instead of one tube filling the gaps between them.
//
// The outline is rasterized and thinned to its skeleton: the centre lines of its parts. A branch of the skeleton
// that ends in a tip, is clearly thinner than where it joins, and reaches well past that join is a limb. Each limb
// is cut off at its root, across its width; its piece reaches a little back into the body so the two overlap
// rather than leave a crease, and the body keeps the rest with the cut closed straight.
import type { V2 } from './types';

export interface OutlineParts {
  body: V2[];
  limbs: V2[][];
  /** Each limb's tip, so its rings can run from root to tip. */
  tips: V2[];
}

const cache = new WeakMap<V2[], OutlineParts>();

/** The body and limbs of an outline. Cached per outline array, since tools ask on every frame. */
export function splitOutline(outline: V2[]): OutlineParts {
  let r = cache.get(outline);
  if (!r) { r = split(outline); cache.set(outline, r); }
  return r;
}

function distToPoly(poly: V2[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const l = dx * dx + dy * dy;
    const t = l > 0 ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)) : 0;
    best = Math.min(best, Math.hypot(x - a[0] - dx * t, y - a[1] - dy * t));
  }
  return best;
}

function split(outline: V2[]): OutlineParts {
  const whole: OutlineParts = { body: outline, limbs: [], tips: [] };
  const n = outline.length;
  if (n < 8) return whole;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of outline) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
  const size = Math.max(maxX - minX, maxY - minY);
  if (size < 1e-6) return whole;

  // Rasterize with a scanline fill, leaving a one-cell border.
  const cells = 160;
  const c = size / cells;
  const W = Math.ceil((maxX - minX) / c) + 3, H = Math.ceil((maxY - minY) / c) + 3;
  const ox = minX - c, oy = minY - c;
  const grid = new Uint8Array(W * H);
  for (let j = 1; j < H - 1; j++) {
    const y = oy + (j + 0.5) * c;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = outline[i], b = outline[(i + 1) % n];
      if ((a[1] > y) !== (b[1] > y)) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(1, Math.ceil((xs[k] - ox) / c - 0.5)), i1 = Math.min(W - 2, Math.floor((xs[k + 1] - ox) / c - 0.5));
      for (let i = i0; i <= i1; i++) grid[j * W + i] = 1;
    }
  }

  // Thin to a one-cell skeleton (Zhang–Suen).
  const at = (i: number, j: number) => grid[j * W + i];
  const nb = (i: number, j: number) => [at(i, j - 1), at(i + 1, j - 1), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1), at(i - 1, j + 1), at(i - 1, j), at(i - 1, j - 1)];
  const transitions = (p: number[]) => { let t = 0; for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) t++; return t; };
  for (let changed = true; changed;) {
    changed = false;
    for (const pass of [0, 1]) {
      const kill: number[] = [];
      for (let j = 1; j < H - 1; j++) for (let i = 1; i < W - 1; i++) {
        if (!at(i, j)) continue;
        const p = nb(i, j);
        const b = p.reduce((s, x) => s + x, 0);
        if (b < 2 || b > 6 || transitions(p) !== 1) continue;
        const [p2, , p4, , p6, , p8] = p;
        if (pass === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) kill.push(j * W + i);
      }
      if (kill.length) { changed = true; kill.forEach((k) => { grid[k] = 0; }); }
    }
  }

  const pos = (k: number): V2 => [ox + ((k % W) + 0.5) * c, oy + (Math.floor(k / W) + 0.5) * c];
  const neighbours = (k: number) => {
    const i = k % W, j = Math.floor(k / W);
    const out: number[] = [];
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) if ((di || dj) && at(i + di, j + dj)) out.push((j + dj) * W + i + di);
    return out;
  };
  const isJunction = (k: number) => neighbours(k).length >= 3 && transitions(nb(k % W, Math.floor(k / W))) >= 3;
  const radius = new Map<number, number>();
  const rOf = (k: number) => { let r = radius.get(k); if (r === undefined) { const p = pos(k); r = distToPoly(outline, p[0], p[1]); radius.set(k, r); } return r; };

  // Trace each branch from a tip to the junction it joins.
  const branches: { path: number[]; junction: number }[] = [];
  for (let k = 0; k < grid.length; k++) {
    if (!grid[k] || neighbours(k).length !== 1) continue;
    const path = [k];
    const seen = new Set(path);
    let cur = k, junction = -1;
    for (let guard = 0; guard < W * H; guard++) {
      const next = neighbours(cur).filter((x) => !seen.has(x));
      if (!next.length) break;
      // Prefer straight-on neighbours, so the walk doesn't cut corners off the line.
      next.sort((a, b) => (Math.abs((a % W) - (cur % W)) + Math.abs(Math.floor(a / W) - Math.floor(cur / W))) - (Math.abs((b % W) - (cur % W)) + Math.abs(Math.floor(b / W) - Math.floor(cur / W))));
      cur = next[0];
      path.push(cur); seen.add(cur);
      if (isJunction(cur)) { junction = cur; break; }
    }
    if (junction >= 0) branches.push({ path, junction });
  }

  interface Cut { a: number; b: number; base: V2; dir: V2; ext: number; tip: number }
  const cuts: Cut[] = [];
  for (const br of branches) {
    const rJ = rOf(br.junction);
    const len = br.path.length * c;
    // How thick the outer half of the branch is: the limb itself, not where it widens into the body.
    const outer = br.path.slice(0, Math.max(2, Math.floor(br.path.length / 2))).map(rOf).sort((p, q) => p - q);
    const rLimb = outer[Math.floor(outer.length / 2)];
    // Thinner than the body, and reaching well beyond it. Spurs into corners and bumps fail one or the other.
    if (!(rLimb < 0.7 * rJ) || !(len - rJ > 1.6 * rLimb)) continue;
    // Straight across the branch at a point along it: the nearest outline crossing on each side.
    const across = (bi: number) => {
      const base = pos(br.path[bi]);
      const back = pos(br.path[Math.max(0, bi - Math.max(2, Math.round(rLimb / c)))]);
      let dx = back[0] - base[0], dy = back[1] - base[1];
      const dl = Math.hypot(dx, dy) || 1;
      dx /= dl; dy /= dl;
      const nx = -dy, ny = dx;
      let sPos = Infinity, sNeg = -Infinity, iPos = -1, iNeg = -1, tPos = 0, tNeg = 0;
      for (let i = 0; i < n; i++) {
        const p = outline[i], q = outline[(i + 1) % n];
        const ex = q[0] - p[0], ey = q[1] - p[1];
        const den = nx * ey - ny * ex;
        if (Math.abs(den) < 1e-12) continue;
        const wx = p[0] - base[0], wy = p[1] - base[1];
        const s = (wx * ey - wy * ex) / den;
        const t = (wx * ny - wy * nx) / den;
        if (t < 0 || t > 1) continue;
        if (s > 0 && s < sPos) { sPos = s; iPos = i; tPos = t; }
        if (s < 0 && s > sNeg) { sNeg = s; iNeg = i; tNeg = t; }
      }
      if (iPos < 0 || iNeg < 0) return null;
      return { base, dir: [dx, dy] as V2, width: sPos - sNeg, pa: iPos + tPos, pb: iNeg + tNeg };
    };
    // The root: walking in from the tip, the last point where the limb is still about as thin as itself, both
    // by distance to the edge and by width straight across. The width matters where limbs sit close together,
    // like fingers, since there the body's edge between them is near too.
    let bi = 2, cut = across(bi);
    for (; bi + 1 < br.path.length; bi++) {
      const next = across(bi + 1);
      if (!next || rOf(br.path[bi + 1]) > 1.3 * rLimb || next.width > 3.2 * rLimb) break;
      cut = next;
    }
    if (!cut || cut.width > 5 * rLimb) continue;
    const { base, pa, pb } = cut;
    const [dx, dy] = cut.dir;
    const tip = pos(br.path[0]);
    let tipIdx = 0, best = Infinity;
    outline.forEach((p, i) => { const d = Math.hypot(p[0] - tip[0], p[1] - tip[1]); if (d < best) { best = d; tipIdx = i; } });
    // The limb's stretch of outline runs forward from one crossing to the other, through the tip.
    const within = (x: number, from: number, to: number) => (from <= to ? x >= from && x <= to : x >= from || x <= to);
    const [a, b] = within(tipIdx, pa, pb) ? [pa, pb] : [pb, pa];
    cuts.push({ a, b, base, dir: [dx, dy], ext: rOf(br.path[bi]) * 0.9, tip: tipIdx });
  }
  if (!cuts.length) return whole;

  // Keep stretches that don't overlap, longest first.
  const lenOf = (x: Cut) => (x.b - x.a + n) % n;
  const overlaps = (x: Cut, y: Cut) => {
    const inside = (p: number, q: Cut) => (q.a <= q.b ? p >= q.a && p <= q.b : p >= q.a || p <= q.b);
    return inside(x.a, y) || inside(x.b, y) || inside(y.a, x) || inside(y.b, x);
  };
  const kept: Cut[] = [];
  for (const cu of cuts.slice().sort((x, y) => lenOf(y) - lenOf(x))) if (!kept.some((k) => overlaps(cu, k))) kept.push(cu);
  // Leave the body most of the outline: a "limb" that took over half of it was really the body.
  const total = kept.reduce((s, x) => s + lenOf(x), 0);
  if (total > 0.85 * n) return whole;

  const pointAt = (p: number): V2 => {
    const i = Math.floor(p) % n, t = p - Math.floor(p);
    const a = outline[i], b = outline[(i + 1) % n];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  /** Outline vertices strictly after `from` up to strictly before `to`, walking forward. */
  const between = (from: number, to: number): V2[] => {
    const out: V2[] = [];
    let i = (Math.floor(from) + 1) % n;
    for (let guard = 0; guard < n; guard++) {
      const span = (to - from + n) % n, d = (i - from + n) % n;
      if (d >= span) break;
      out.push(outline[i]);
      i = (i + 1) % n;
    }
    return out;
  };

  const limbs = kept.map((cu) => {
    const A = pointAt(cu.a), B = pointAt(cu.b);
    // Reach back into the body past the cut, so the limb's rounded base hides inside it.
    // `dir` points from the root toward the tip, so the body lies the other way.
    const back = (p: V2): V2 => [p[0] - cu.dir[0] * cu.ext, p[1] - cu.dir[1] * cu.ext];
    return [A, ...between(cu.a, cu.b), B, back(B), back(A)];
  });
  const order = kept.slice().sort((x, y) => x.a - y.a);
  const body: V2[] = [];
  order.forEach((cu, k) => {
    const next = order[(k + 1) % order.length];
    body.push(pointAt(cu.b), ...between(cu.b, next.a), pointAt(next.a));
  });
  return { body, limbs, tips: kept.map((cu) => outline[cu.tip]) };
}
