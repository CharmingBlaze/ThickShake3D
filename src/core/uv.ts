// UV projection, seams, unwrapping, packing and layout analysis.
// V runs down from the image's top edge, so a face seen from the front winds clockwise in (u, v) numbers.
import { add, bounds, cross, dist, dot, edgeFaces, edgeKey, faceArea, faceNormal, norm, sub, triangulate } from './geom';
import type { Face, Model, V2, V3 } from './types';

/** Texture axes for looking at a surface from the front: u to the right, v down. */
const basis = (n: V3): [V3, V3] => {
  const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [0, 0, -1];
  const u = norm(cross(ref, n));
  return [u, cross(u, n)];
};

export function fitUV(m: Model, faces: Iterable<number>, keepAspect = true, margin = 0.02) {
  const list = [...faces];
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const fi of list) for (const u of m.faces[fi].uv) {
    minU = Math.min(minU, u[0]); maxU = Math.max(maxU, u[0]);
    minV = Math.min(minV, u[1]); maxV = Math.max(maxV, u[1]);
  }
  if (!isFinite(minU)) return;
  const w = maxU - minU || 1, h = maxV - minV || 1;
  const box = 1 - margin * 2;
  const su = keepAspect ? box / Math.max(w, h) : box / w;
  const sv = keepAspect ? su : box / h;
  for (const fi of list) for (const u of m.faces[fi].uv) {
    u[0] = (u[0] - minU) * su + margin;
    u[1] = (u[1] - minV) * sv + margin;
  }
}

/**
 * Lay faces out as a view sees them, upright: U along the view's right, V down its up, then fit them to the texture.
 * For painting, so the texture looks the way the model does on screen.
 */
export function projectScreen(m: Model, faces: Iterable<number>, right: V3, up: V3) {
  const list = [...faces];
  for (const fi of list) {
    const f = m.faces[fi];
    f.uv = f.v.map((i) => [dot(m.verts[i].p, right), -dot(m.verts[i].p, up)]);
  }
  fitUV(m, list);
}

/** Flatten along an axis direction. */
export function projectPlanar(m: Model, faces: Iterable<number>, dir: V3) {
  const [u, v] = basis(norm(dir));
  const list = [...faces];
  for (const fi of list) {
    const f = m.faces[fi];
    f.uv = f.v.map((i) => [dot(m.verts[i].p, u), dot(m.verts[i].p, v)]);
  }
  fitUV(m, list);
}

export function projectBox(m: Model, faces: Iterable<number>) {
  const list = [...faces];
  // Six charts packed side by side, one per dominant axis.
  const charts = new Map<string, number[]>();
  for (const fi of list) {
    const n = faceNormal(m, m.faces[fi]);
    const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
    const k = ax >= ay && ax >= az ? (n[0] > 0 ? 'x+' : 'x-') : ay >= az ? (n[1] > 0 ? 'y+' : 'y-') : n[2] > 0 ? 'z+' : 'z-';
    const l = charts.get(k);
    if (l) l.push(fi); else charts.set(k, [fi]);
  }
  const dirs: Record<string, V3> = { 'x+': [1, 0, 0], 'x-': [-1, 0, 0], 'y+': [0, 1, 0], 'y-': [0, -1, 0], 'z+': [0, 0, 1], 'z-': [0, 0, -1] };
  const packs: PackChart[] = [];
  charts.forEach((fs, k) => {
    const [u, v] = basis(dirs[k]);
    for (const fi of fs) {
      const f = m.faces[fi];
      f.uv = f.v.map((i) => [dot(m.verts[i].p, u), dot(m.verts[i].p, v)]);
    }
    packs.push(chartOf(m, fs));
  });
  packCharts(m, packs);
}

export function projectCylinder(m: Model, faces: Iterable<number>, axis: 0 | 1 | 2 = 1) {
  const list = [...faces];
  const c = bounds(list.flatMap((fi) => m.faces[fi].v.map((i) => m.verts[i].p)));
  const [a, b] = axis === 1 ? [0, 2] : axis === 0 ? [1, 2] : [0, 1];
  const h = c.size[axis] || 1;
  for (const fi of list) {
    const f = m.faces[fi];
    f.uv = f.v.map((i) => {
      const p = m.verts[i].p;
      return [Math.atan2(p[a] - c.center[a], p[b] - c.center[b]) / (2 * Math.PI) + 0.5, (c.max[axis] - p[axis]) / h];
    });
    fixSeam(f);
  }
}

export function projectSphere(m: Model, faces: Iterable<number>) {
  const list = [...faces];
  const c = bounds(list.flatMap((fi) => m.faces[fi].v.map((i) => m.verts[i].p))).center;
  for (const fi of list) {
    const f = m.faces[fi];
    f.uv = f.v.map((i) => {
      const d = norm([m.verts[i].p[0] - c[0], m.verts[i].p[1] - c[1], m.verts[i].p[2] - c[2]]);
      return [Math.atan2(d[0], d[2]) / (2 * Math.PI) + 0.5, 0.5 - Math.asin(Math.max(-1, Math.min(1, d[1]))) / Math.PI];
    });
    fixSeam(f);
  }
}

function fixSeam(f: Face) {
  const us = f.uv.map((u) => u[0]);
  if (Math.max(...us) - Math.min(...us) > 0.5) f.uv.forEach((u) => { if (u[0] < 0.5) u[0] += 1; });
}

interface PackChart { faces: number[]; minU: number; minV: number; w: number; h: number }

function chartOf(m: Model, faces: number[]): PackChart {
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
  for (const fi of faces) for (const u of m.faces[fi].uv) {
    minU = Math.min(minU, u[0]); maxU = Math.max(maxU, u[0]);
    minV = Math.min(minV, u[1]); maxV = Math.max(maxV, u[1]);
  }
  return { faces, minU, minV, w: maxU - minU, h: maxV - minV };
}

interface Placed { c: PackChart; x: number; y: number; rot: boolean }

/** Bottom-left skyline packing into a bin of fixed width. Returns the placements and the space they span. */
function skyline(charts: PackChart[], binW: number, pad: number, rotate: boolean): { placed: Placed[]; size: number } {
  let segs = [{ x: 0, w: binW, y: 0 }];
  const placed: Placed[] = [];
  let maxX = 0, maxY = 0;
  const spot = (rw: number, rh: number) => {
    let best: { x: number; y: number } | null = null;
    for (const s of segs) {
      if (s.x + rw > binW + 1e-9) continue;
      let y = 0;
      for (const o of segs) if (o.x < s.x + rw - 1e-9 && o.x + o.w > s.x + 1e-9) y = Math.max(y, o.y);
      if (!best || y + rh < best.y + 1e-9 + (best as any).rh || (Math.abs(y + rh - best.y - (best as any).rh) < 1e-9 && s.x < best.x)) best = Object.assign({ x: s.x, y }, { rh });
    }
    return best;
  };
  for (const c of charts) {
    const a = spot(c.w + pad, c.h + pad);
    const b = rotate ? spot(c.h + pad, c.w + pad) : null;
    const useRot = !!b && (!a || b.y + c.w < a.y + c.h - 1e-9);
    const at = useRot ? b! : a!;
    const rw = (useRot ? c.h : c.w) + pad, rh = (useRot ? c.w : c.h) + pad;
    placed.push({ c, x: at.x, y: at.y, rot: useRot });
    const next: typeof segs = [];
    for (const s of segs) {
      if (s.x + s.w <= at.x + 1e-9 || s.x >= at.x + rw - 1e-9) { next.push(s); continue; }
      if (s.x < at.x) next.push({ x: s.x, w: at.x - s.x, y: s.y });
      if (s.x + s.w > at.x + rw) next.push({ x: at.x + rw, w: s.x + s.w - at.x - rw, y: s.y });
    }
    next.push({ x: at.x, w: rw, y: at.y + rh });
    segs = next.sort((p, q) => p.x - q.x);
    maxX = Math.max(maxX, at.x + rw - pad);
    maxY = Math.max(maxY, at.y + rh - pad);
  }
  return { placed, size: Math.max(maxX, maxY) };
}

/** Pack charts into the unit square, keeping their relative scale. Tries several bin widths and keeps the tightest. */
function packCharts(m: Model, charts: PackChart[], margin = 0.01, rotate = true) {
  if (!charts.length) return;
  const area = charts.reduce((s, c) => s + c.w * c.h, 0);
  const span = Math.max(...charts.map((c) => Math.max(c.w, c.h)));
  const pad = margin * Math.max(Math.sqrt(area), span) * 1.1;
  const sorted = [...charts].sort((a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h) || b.w * b.h - a.w * a.h);
  const mustFit = Math.max(...charts.map((c) => (rotate ? Math.min(c.w, c.h) : c.w))) + pad;
  const totalArea = charts.reduce((s, c) => s + (c.w + pad) * (c.h + pad), 0);
  let best: ReturnType<typeof skyline> | null = null;
  for (const k of [1, 1.08, 1.16, 1.25, 1.4, 1.6, 1.85]) {
    const res = skyline(sorted, Math.max(Math.sqrt(totalArea) * k, mustFit), pad, rotate);
    if (!best || res.size < best.size) best = res;
  }
  const s = (1 - margin * 2) / (best!.size || 1);
  for (const { c, x, y, rot } of best!.placed) {
    for (const fi of c.faces) for (const u of m.faces[fi].uv) {
      const a = u[0] - c.minU, b = u[1] - c.minV;
      u[0] = ((rot ? c.h - b : a) + x) * s + margin;
      u[1] = ((rot ? a : b) + y) * s + margin;
    }
  }
}

// ---------- seams ----------
/** Every edge marked as a seam, by either face using it. */
export function seamEdges(m: Model): Set<string> {
  const out = new Set<string>();
  for (const f of m.faces) {
    if (!f.seam) continue;
    f.v.forEach((a, i) => { if (f.seam![i]) out.add(edgeKey(a, f.v[(i + 1) % f.v.length])); });
  }
  return out;
}

export function setSeams(m: Model, edges: Iterable<string>, on: boolean) {
  const set = new Set(edges);
  for (const f of m.faces) {
    f.v.forEach((a, i) => {
      if (!set.has(edgeKey(a, f.v[(i + 1) % f.v.length]))) return;
      f.seam ??= f.v.map(() => false);
      f.seam[i] = on;
    });
    if (f.seam && !f.seam.some(Boolean)) delete f.seam;
  }
}

export function clearSeams(m: Model) { for (const f of m.faces) delete f.seam; }

const sameUV = (a: V2, b: V2, eps = 1e-5) => Math.abs(a[0] - b[0]) < eps && Math.abs(a[1] - b[1]) < eps;

/** The two corners of each face around a shared edge. Returns the UVs at vertices a and b. */
function edgeUV(f: Face, a: number, b: number): [V2, V2] | null {
  const i = f.v.indexOf(a), j = f.v.indexOf(b);
  return i < 0 || j < 0 ? null : [f.uv[i], f.uv[j]];
}

/** Whether two faces meet along this edge in UV space as well as on the mesh. */
function edgeJoined(m: Model, fa: number, fb: number, a: number, b: number) {
  const p = edgeUV(m.faces[fa], a, b), q = edgeUV(m.faces[fb], a, b);
  return !!p && !!q && sameUV(p[0], q[0]) && sameUV(p[1], q[1]);
}

/** Connected UV islands: faces joined across edges whose UVs match. */
export function uvIslands(m: Model, faces: Iterable<number>): number[][] {
  const list = [...faces];
  const inList = new Set(list);
  const ef = edgeFaces(m);
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const seed of list) {
    if (seen.has(seed)) continue;
    const island: number[] = [];
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const fi = stack.pop()!;
      island.push(fi);
      const f = m.faces[fi];
      f.v.forEach((a, i) => {
        const b = f.v[(i + 1) % f.v.length];
        for (const nb of ef.get(edgeKey(a, b)) ?? []) {
          if (seen.has(nb) || !inList.has(nb) || !edgeJoined(m, fi, nb, a, b)) continue;
          seen.add(nb);
          stack.push(nb);
        }
      });
    }
    out.push(island);
  }
  return out;
}

/** Mark every edge where the UVs split as a seam. */
export function seamsFromIslands(m: Model, faces: Iterable<number>) {
  const inList = new Set(faces);
  const out: string[] = [];
  edgeFaces(m).forEach((fs, k) => {
    const inside = fs.filter((f) => inList.has(f));
    if (inside.length < 2) return;
    const [a, b] = k.split('_').map(Number);
    if (inside.some((f) => !edgeJoined(m, inside[0], f, a, b))) out.push(k);
  });
  setSeams(m, out, true);
}

// ---------- unwrapping ----------
/** Least-squares conformal map of one chart: the angle-preserving flattening of Levy et al. Returns false if it can't apply. */
function flattenLSCM(m: Model, chart: number[], seams: Set<string>): boolean {
  // A chart's UV vertices: corners of one mesh vertex, joined when their faces share a non-seam edge.
  const base = new Map<number, number>();
  let count = 0;
  for (const fi of chart) { base.set(fi, count); count += m.faces[fi].v.length; }
  const parent = Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const edgeUse = new Map<string, [number, number][]>();
  for (const fi of chart) {
    const f = m.faces[fi];
    f.v.forEach((a, i) => {
      const k = edgeKey(a, f.v[(i + 1) % f.v.length]);
      const l = edgeUse.get(k);
      if (l) l.push([fi, i]); else edgeUse.set(k, [[fi, i]]);
    });
  }
  edgeUse.forEach((uses, k) => {
    if (seams.has(k)) return;
    const [f0, i0] = uses[0];
    const F0 = m.faces[f0];
    const c0 = base.get(f0)! + i0, c1 = base.get(f0)! + (i0 + 1) % F0.v.length;
    for (let n = 1; n < uses.length; n++) {
      const [f1, i1] = uses[n];
      const F1 = m.faces[f1];
      const here = base.get(f1)! + i1, next = base.get(f1)! + (i1 + 1) % F1.v.length;
      if (F1.v[i1] === F0.v[i0]) { parent[find(here)] = find(c0); parent[find(next)] = find(c1); }
      else { parent[find(here)] = find(c1); parent[find(next)] = find(c0); }
    }
  });
  const uvIndex = new Map<number, number>();
  const cornerVar = new Int32Array(count);
  for (let c = 0; c < count; c++) {
    const r = find(c);
    if (!uvIndex.has(r)) uvIndex.set(r, uvIndex.size);
    cornerVar[c] = uvIndex.get(r)!;
  }
  const n = uvIndex.size;

  // Only a disk flattens without folding: V - E + F must be 1.
  const edgesOf = new Map<string, number>();
  const pos: V3[] = new Array(n);
  for (const fi of chart) {
    const f = m.faces[fi];
    f.v.forEach((a, i) => {
      const p = cornerVar[base.get(fi)! + i], q = cornerVar[base.get(fi)! + (i + 1) % f.v.length];
      pos[p] = m.verts[a].p;
      const k = p < q ? `${p}_${q}` : `${q}_${p}`;
      edgesOf.set(k, (edgesOf.get(k) ?? 0) + 1);
    });
  }
  if (n - edgesOf.size + chart.length !== 1) return false;
  const boundary: number[] = [];
  edgesOf.forEach((c, k) => { if (c === 1) { const [p, q] = k.split('_').map(Number); boundary.push(p, q); } });
  if (!boundary.length) return false;

  // Pin the two boundary vertices farthest apart.
  const farthest = (from: number) => boundary.reduce((b, v) => (dist(pos[v], pos[from]) > dist(pos[b], pos[from]) ? v : b), boundary[0]);
  const pinA = farthest(boundary[0]);
  const pinB = farthest(pinA);
  const span = dist(pos[pinA], pos[pinB]);
  if (pinA === pinB || span < 1e-12) return false;

  // Two rows per triangle over 2n unknowns. Row entries are [unknown, coefficient].
  const rows: [number, number][][] = [];
  let area3D = 0;
  for (const fi of chart) {
    const f = m.faces[fi];
    const b0 = base.get(fi)!;
    const tris = triangulate(f.v.map((i) => m.verts[i].p));
    for (let t = 0; t < tris.length; t += 3) {
      const id = [cornerVar[b0 + tris[t]], cornerVar[b0 + tris[t + 1]], cornerVar[b0 + tris[t + 2]]];
      const A = m.verts[f.v[tris[t]]].p, B = m.verts[f.v[tris[t + 1]]].p, C = m.verts[f.v[tris[t + 2]]].p;
      const ab = sub(B, A), ac = sub(C, A);
      const l = Math.hypot(...ab);
      const areaX2 = Math.hypot(...cross(ab, ac));
      if (l < 1e-12 || areaX2 < 1e-14) continue;
      area3D += areaX2 / 2;
      const x = [0, l, dot(ab, ac) / l], y = [0, 0, areaX2 / l];
      const root = Math.sqrt(areaX2);
      const row1: [number, number][] = [], row2: [number, number][] = [];
      for (let j = 0; j < 3; j++) {
        const k = (j + 1) % 3, o = (j + 2) % 3;
        const wr = (x[o] - x[k]) / root, wi = (y[o] - y[k]) / root;
        row1.push([id[j] * 2, wr], [id[j] * 2 + 1, -wi]);
        row2.push([id[j] * 2, wi], [id[j] * 2 + 1, wr]);
      }
      rows.push(row1, row2);
    }
  }
  if (!rows.length) return false;

  // Points the user pinned hold their places. The solver works with V up, so theirs flip going in and coming out.
  const userPins = new Map<number, V2>();
  for (const fi of chart) {
    const f = m.faces[fi];
    f.pin?.forEach((on, i) => { if (on) userPins.set(cornerVar[base.get(fi)! + i], f.uv[i]); });
  }
  const pinned = userPins.size >= 2;

  // Move the pinned values to the right-hand side and solve the normal equations by conjugate gradient.
  const fixed = new Map<number, number>(pinned ? [] : [[pinA * 2, 0], [pinA * 2 + 1, 0], [pinB * 2, span], [pinB * 2 + 1, 0]]);
  userPins.forEach((u, v) => { if (pinned) { fixed.set(v * 2, u[0]); fixed.set(v * 2 + 1, -u[1]); } });
  const x = new Float64Array(2 * n);
  fixed.forEach((v, k) => { x[k] = v; });
  const applyAtA = (inp: Float64Array, out: Float64Array) => {
    out.fill(0);
    for (const r of rows) {
      let s = 0;
      for (const [k, c] of r) if (!fixed.has(k)) s += c * inp[k];
      for (const [k, c] of r) if (!fixed.has(k)) out[k] += c * s;
    }
  };
  const b = new Float64Array(2 * n);
  const diag = new Float64Array(2 * n);
  for (const r of rows) {
    let s = 0;
    for (const [k, c] of r) if (fixed.has(k)) s += c * fixed.get(k)!;
    for (const [k, c] of r) if (!fixed.has(k)) { b[k] -= c * s; diag[k] += c * c; }
  }
  const sol = new Float64Array(2 * n);
  const res = b.slice();
  const prec = (i: number) => (diag[i] > 1e-30 ? 1 / diag[i] : 0);
  const z = res.map((v, i) => v * prec(i));
  const d = z.slice();
  const Ad = new Float64Array(2 * n);
  let rz = 0;
  for (let i = 0; i < 2 * n; i++) rz += res[i] * z[i];
  const rz0 = rz;
  const limit = Math.min(20000, 40 * n + 200);
  for (let it = 0; it < limit && rz > 1e-24 * Math.max(rz0, 1e-30); it++) {
    applyAtA(d, Ad);
    let dAd = 0;
    for (let i = 0; i < 2 * n; i++) dAd += d[i] * Ad[i];
    if (Math.abs(dAd) < 1e-30) break;
    const alpha = rz / dAd;
    let next = 0;
    for (let i = 0; i < 2 * n; i++) {
      sol[i] += alpha * d[i];
      res[i] -= alpha * Ad[i];
      z[i] = res[i] * prec(i);
      next += res[i] * z[i];
    }
    const beta = next / rz;
    rz = next;
    for (let i = 0; i < 2 * n; i++) d[i] = z[i] + beta * d[i];
  }
  for (let i = 0; i < 2 * n; i++) if (!fixed.has(i)) x[i] = sol[i];
  for (let i = 0; i < 2 * n; i++) if (!Number.isFinite(x[i])) return false;

  if (pinned) {
    for (const fi of chart) {
      const f = m.faces[fi];
      const b0 = base.get(fi)!;
      f.uv = f.v.map((_, i) => { const p = cornerVar[b0 + i]; return [x[p * 2], -x[p * 2 + 1]]; });
    }
    return true;
  }

  // Real-world scale, and the orientation that reads correctly with V running down.
  let signed = 0;
  for (const fi of chart) {
    const f = m.faces[fi];
    const b0 = base.get(fi)!;
    f.v.forEach((_, i) => {
      const p = cornerVar[b0 + i], q = cornerVar[b0 + (i + 1) % f.v.length];
      signed += x[p * 2] * x[q * 2 + 1] - x[q * 2] * x[p * 2 + 1];
    });
  }
  signed /= 2;
  if (Math.abs(signed) < 1e-14) return false;
  const k = Math.sqrt(area3D / Math.abs(signed));
  const flipV = signed > 0 ? -1 : 1;
  for (const fi of chart) {
    const f = m.faces[fi];
    const b0 = base.get(fi)!;
    f.uv = f.v.map((_, i) => {
      const p = cornerVar[b0 + i];
      return [x[p * 2] * k, x[p * 2 + 1] * k * flipV];
    });
  }
  return true;
}

function flattenPlanar(m: Model, chart: number[]) {
  let sum: V3 = [0, 0, 0];
  for (const fi of chart) sum = add(sum, faceNormal(m, m.faces[fi]));
  const [u, v] = basis(norm(sum));
  for (const fi of chart) {
    const f = m.faces[fi];
    f.uv = f.v.map((i) => [dot(m.verts[i].p, u), dot(m.verts[i].p, v)]);
  }
}

/** Faces connected across edges that aren't seams. */
function seamCharts(m: Model, list: number[], seams: Set<string>): number[][] {
  const inList = new Set(list);
  const ef = edgeFaces(m);
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const seed of list) {
    if (seen.has(seed)) continue;
    const chart: number[] = [];
    const stack = [seed];
    seen.add(seed);
    while (stack.length) {
      const fi = stack.pop()!;
      chart.push(fi);
      const f = m.faces[fi];
      f.v.forEach((a, i) => {
        const k = edgeKey(a, f.v[(i + 1) % f.v.length]);
        if (seams.has(k)) return;
        for (const nb of ef.get(k) ?? []) if (!seen.has(nb) && inList.has(nb)) { seen.add(nb); stack.push(nb); }
      });
    }
    out.push(chart);
  }
  return out;
}

/** Split faces into charts by normal direction, seeded from the largest faces. Seams also divide charts. */
function growCharts(m: Model, list: number[], angleDeg: number, seams: Set<string>): number[][] {
  const inList = new Set(list);
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const ef = edgeFaces(m);
  const normals = new Map<number, V3>();
  for (const fi of list) normals.set(fi, faceNormal(m, m.faces[fi]));
  const order = [...list].sort((a, b) => faceArea(m, m.faces[b]) - faceArea(m, m.faces[a]));
  const assigned = new Set<number>();
  const out: number[][] = [];
  for (const seed of order) {
    if (assigned.has(seed)) continue;
    const chart: number[] = [];
    const seedN = normals.get(seed)!;
    const stack = [seed];
    assigned.add(seed);
    while (stack.length) {
      const fi = stack.pop()!;
      chart.push(fi);
      const f = m.faces[fi];
      f.v.forEach((a, i) => {
        const k = edgeKey(a, f.v[(i + 1) % f.v.length]);
        if (seams.has(k)) return;
        for (const nb of ef.get(k) ?? []) {
          if (assigned.has(nb) || !inList.has(nb)) continue;
          if (dot(seedN, normals.get(nb)!) >= cosT) { assigned.add(nb); stack.push(nb); }
        }
      });
    }
    out.push(chart);
  }
  return out;
}

const hasPins = (m: Model, chart: number[]) => chart.reduce((n, fi) => n + (m.faces[fi].pin?.filter(Boolean).length ?? 0), 0) >= 2;

function flattenAndPack(m: Model, charts: number[][], seams: Set<string>, margin: number) {
  const packs: PackChart[] = [];
  for (const chart of charts) {
    if (!flattenLSCM(m, chart, seams)) flattenPlanar(m, chart);
    // A chart held by pins stays exactly where they put it.
    if (hasPins(m, chart)) continue;
    rotateToMinBox(m, chart);
    packs.push(chartOf(m, chart));
  }
  packCharts(m, packs, margin);
}

/** A small binary heap of [cost, value], for spreading outward over a mesh. */
class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(item: [number, number]) {
    const a = this.a;
    a.push(item);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(): [number, number] {
    const a = this.a, top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = i * 2 + 1, r = l + 1;
        let s = i;
        if (l < a.length && a[l][0] < a[s][0]) s = l;
        if (r < a.length && a[r][0] < a[s][0]) s = r;
        if (s === i) break;
        [a[s], a[i]] = [a[i], a[s]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * Cut a region in two, with the cut falling along its sharpest creases. Two fronts spread from far-apart faces,
 * and crossing a crease costs them far more than crossing flat surface, so they meet at the creases.
 */
function bisect(m: Model, region: number[], seams: Set<string>): [number[], number[]] | null {
  const inRegion = new Set(region);
  const ef = edgeFaces(m);
  const normals = new Map(region.map((fi) => [fi, faceNormal(m, m.faces[fi])]));
  const neighbours = (fi: number): [number, number][] => {
    const f = m.faces[fi];
    const out: [number, number][] = [];
    f.v.forEach((a, i) => {
      const k = edgeKey(a, f.v[(i + 1) % f.v.length]);
      if (seams.has(k)) return;
      for (const nb of ef.get(k) ?? []) {
        if (nb === fi || !inRegion.has(nb)) continue;
        const bend = 1 - dot(normals.get(fi)!, normals.get(nb)!);
        out.push([nb, 1 + bend * bend * 60]);
      }
    });
    return out;
  };
  const spread = (seeds: number[]): Map<number, [number, number]> => {
    const best = new Map<number, [number, number]>();
    const h = new Heap();
    seeds.forEach((s, i) => { best.set(s, [0, i]); h.push([0, s]); });
    while (h.size) {
      const [cost, fi] = h.pop();
      const here = best.get(fi)!;
      if (cost > here[0]) continue;
      for (const [nb, c] of neighbours(fi)) {
        const next = cost + c;
        const old = best.get(nb);
        if (!old || next < old[0]) { best.set(nb, [next, here[1]]); h.push([next, nb]); }
      }
    }
    return best;
  };
  const farthest = (from: number) => {
    let far = from, d = -1;
    spread([from]).forEach(([c], fi) => { if (c > d) { d = c; far = fi; } });
    return far;
  };
  const a = farthest(region[0]);
  const b = farthest(a);
  if (a === b) return null;
  const owners = spread([a, b]);
  const sideOf = (fi: number) => owners.get(fi)?.[1] ?? 0;
  // Fronts can still meet in the middle of a flat area. Each flat patch goes whole to whichever side holds most of it.
  const patchOf = new Map<number, number>();
  const patches: number[][] = [];
  for (const seed of region) {
    if (patchOf.has(seed)) continue;
    const id = patches.length, faces: number[] = [];
    const stack = [seed];
    patchOf.set(seed, id);
    while (stack.length) {
      const fi = stack.pop()!;
      faces.push(fi);
      for (const [nb] of neighbours(fi)) {
        if (patchOf.has(nb) || dot(normals.get(fi)!, normals.get(nb)!) < 0.998) continue;
        patchOf.set(nb, id);
        stack.push(nb);
      }
    }
    patches.push(faces);
  }
  const one: number[] = [], two: number[] = [];
  for (const faces of patches) {
    const second = faces.reduce((n, fi) => n + sideOf(fi), 0);
    (second * 2 > faces.length ? two : one).push(...faces);
  }
  if (one.length && two.length) return [one, two];
  // A single flat patch has nothing to choose between, so the fronts' own split stands.
  const rawOne = region.filter((fi) => sideOf(fi) === 0), rawTwo = region.filter((fi) => sideOf(fi) === 1);
  return rawOne.length && rawTwo.length ? [rawOne, rawTwo] : null;
}

/**
 * Unwrap with no seams to mark, finding where to cut by itself. Each connected part is flattened; if that distorts
 * it past `maxStretch` or it folds over itself, it's cut along its sharpest creases and each half is tried again.
 * The result is as few islands as the shape allows. Any seams you did mark are respected. Returns the island count.
 */
export function unwrap(m: Model, faces: Iterable<number>, margin = 0.01, maxStretch = 1.35): number {
  const seams = seamEdges(m);
  const list = [...new Set(faces)];
  const done: number[][] = [];
  const queue = seamCharts(m, list, seams);
  while (queue.length) {
    const region = queue.pop()!;
    const saved = region.map((fi) => m.faces[fi].uv);
    const flat = flattenLSCM(m, region, seams);
    const good = flat && (hasPins(m, region) || (Math.max(...uvStretch(m, region).values()) <= maxStretch && uvOverlaps(m, region).size === 0));
    region.forEach((fi, i) => { m.faces[fi].uv = saved[i]; });
    if (good || region.length <= 1) { done.push(region); continue; }
    const parts = bisect(m, region, seams);
    if (parts) queue.push(parts[0], parts[1]);
    else done.push(region);
  }
  flattenAndPack(m, done, seams, margin);
  return done.length;
}

/** Re-solve only the charts that hold pinned points, leaving every other island alone. */
export function liveUnwrap(m: Model, faces: Iterable<number>): number {
  const seams = seamEdges(m);
  const islands = uvIslands(m, faces).filter((isl) => hasPins(m, isl));
  for (const isl of islands) flattenLSCM(m, isl, seams);
  return islands.length;
}

export function setPins(m: Model, corners: Iterable<[number, number]>, on: boolean) {
  const touched = new Set<number>();
  for (const [fi, c] of corners) {
    const f = m.faces[fi];
    f.pin ??= f.v.map(() => false);
    f.pin[c] = on;
    touched.add(fi);
  }
  for (const fi of touched) if (!m.faces[fi].pin!.some(Boolean)) delete m.faces[fi].pin;
}

/**
 * Even out distortion without changing how an island is connected. Each triangle's true shape is fitted onto where
 * it sits now, and each point moves to the average of what its triangles want. Pinned points stay.
 */
export function minimizeStretch(m: Model, faces: Iterable<number>, iterations = 20) {
  for (const island of uvIslands(m, faces)) {
    const a3 = island.reduce((s, fi) => s + faceArea(m, m.faces[fi]), 0);
    const k = a3 > 1e-12 ? Math.sqrt(uvUsageRaw(m, island) / a3) : 1;
    // Corners sharing a UV point on the same vertex move as one.
    const keys = new Map<string, number>();
    const members: V2[][] = [];
    const pinned: boolean[] = [];
    const idOf = (fi: number, c: number) => {
      const f = m.faces[fi];
      const key = `${f.v[c]}|${f.uv[c][0].toFixed(6)},${f.uv[c][1].toFixed(6)}`;
      let id = keys.get(key);
      if (id === undefined) { id = members.length; keys.set(key, id); members.push([]); pinned.push(false); }
      members[id].push(f.uv[c]);
      if (f.pin?.[c]) pinned[id] = true;
      return id;
    };
    const tris: { id: [number, number, number]; rest: [V2, V2, V2] }[] = [];
    for (const fi of island) {
      const f = m.faces[fi];
      const ids = f.v.map((_, c) => idOf(fi, c));
      const t = triangulate(f.v.map((i) => m.verts[i].p));
      for (let i = 0; i < t.length; i += 3) {
        const A = m.verts[f.v[t[i]]].p, B = m.verts[f.v[t[i + 1]]].p, C = m.verts[f.v[t[i + 2]]].p;
        const ab = sub(B, A), ac = sub(C, A);
        const l = Math.hypot(...ab), h2 = Math.hypot(...cross(ab, ac));
        if (l < 1e-12 || h2 < 1e-14) continue;
        // In UV space, front-facing triangles wind the other way because V runs down.
        const rest: [V2, V2, V2] = [[0, 0], [l * k, 0], [(dot(ab, ac) / l) * k, (-h2 / l) * k]];
        tris.push({ id: [ids[t[i]], ids[t[i + 1]], ids[t[i + 2]]], rest });
      }
    }
    const pos = members.map((g): V2 => [g[0][0], g[0][1]]);
    for (let it = 0; it < iterations; it++) {
      const sum = pos.map((): V2 => [0, 0]);
      const count = new Int32Array(pos.length);
      for (const { id, rest } of tris) {
        const cu = (pos[id[0]][0] + pos[id[1]][0] + pos[id[2]][0]) / 3, cv = (pos[id[0]][1] + pos[id[1]][1] + pos[id[2]][1]) / 3;
        const rx = (rest[0][0] + rest[1][0] + rest[2][0]) / 3, ry = (rest[0][1] + rest[1][1] + rest[2][1]) / 3;
        // The rotation that best lays the true shape over the current one.
        let s = 0, c = 0;
        for (let j = 0; j < 3; j++) {
          const px = rest[j][0] - rx, py = rest[j][1] - ry, qx = pos[id[j]][0] - cu, qy = pos[id[j]][1] - cv;
          c += px * qx + py * qy;
          s += px * qy - py * qx;
        }
        const n = Math.hypot(c, s) || 1;
        c /= n; s /= n;
        for (let j = 0; j < 3; j++) {
          const px = rest[j][0] - rx, py = rest[j][1] - ry;
          sum[id[j]][0] += cu + px * c - py * s;
          sum[id[j]][1] += cv + px * s + py * c;
          count[id[j]]++;
        }
      }
      pos.forEach((p, i) => { if (!pinned[i] && count[i]) { p[0] = sum[i][0] / count[i]; p[1] = sum[i][1] / count[i]; } });
    }
    members.forEach((g, i) => { for (const u of g) { u[0] = pos[i][0]; u[1] = pos[i][1]; } });
  }
}

/** Give every island the same texel density, without moving them apart or packing them. */
export function averageIslandScale(m: Model, faces: Iterable<number>) {
  const list = [...faces];
  const a3 = list.reduce((s, fi) => s + faceArea(m, m.faces[fi]), 0);
  const k = a3 > 1e-12 ? Math.sqrt(uvUsageRaw(m, list) / a3) : 1;
  for (const island of uvIslands(m, list)) scaleIslandTo(m, island, k);
}

/** Turn each island so its tightest bounding box lines up with the axes. */
export function alignIslands(m: Model, faces: Iterable<number>) {
  for (const island of uvIslands(m, faces)) {
    const before = chartOf(m, island);
    const cx = before.minU + before.w / 2, cy = before.minV + before.h / 2;
    rotateToMinBox(m, island);
    const after = chartOf(m, island);
    const dx = cx - (after.minU + after.w / 2), dy = cy - (after.minV + after.h / 2);
    for (const fi of island) for (const u of m.faces[fi].uv) { u[0] += dx; u[1] += dy; }
  }
}

/**
 * Smart unwrap: split into charts by normal direction, flatten each with minimal distortion, rotate to its
 * tightest bounding box, then pack into 0..1 at one texel density. Marked seams also divide charts.
 */
export function smartUnwrap(m: Model, faces: Iterable<number>, angleDeg = 60, margin = 0.01): number {
  const seams = seamEdges(m);
  const charts = growCharts(m, [...new Set(faces)], angleDeg, seams);
  flattenAndPack(m, charts, seams, margin);
  return charts.length;
}

/** Scale an island about its own corner so its UV area per square metre becomes `k` squared. */
function scaleIslandTo(m: Model, island: number[], k: number) {
  const a3 = island.reduce((s, fi) => s + faceArea(m, m.faces[fi]), 0);
  const au = uvUsageRaw(m, island);
  if (a3 < 1e-12 || au < 1e-12) return;
  const c = chartOf(m, island);
  const cx = c.minU + c.w / 2, cy = c.minV + c.h / 2;
  const s = (k * Math.sqrt(a3)) / Math.sqrt(au);
  for (const fi of island) for (const u of m.faces[fi].uv) {
    u[0] = cx + (u[0] - cx) * s;
    u[1] = cy + (u[1] - cy) * s;
  }
}

/** Arrange existing islands in the 0..1 square. Optionally give every island the same texel density first. */
export function packIslands(m: Model, faces: Iterable<number>, margin = 0.01, equalize = true, rotate = true): number {
  const islands = uvIslands(m, faces);
  if (equalize) for (const island of islands) scaleIslandTo(m, island, 1);
  packCharts(m, islands.map((isl) => chartOf(m, isl)), margin, rotate);
  return islands.length;
}

/** Scale each island to a target density in texture pixels per unit (metre). */
export function setTexelDensity(m: Model, faces: Iterable<number>, density: number, textureSize: number) {
  for (const island of uvIslands(m, faces)) scaleIslandTo(m, island, density / textureSize);
}

/** Average density in texture pixels per unit. */
export function texelDensity(m: Model, faces: Iterable<number>, textureSize: number): number {
  const list = [...faces];
  const a3 = list.reduce((s, fi) => s + faceArea(m, m.faces[fi]), 0);
  return a3 > 1e-12 ? Math.sqrt(uvUsageRaw(m, list) / a3) * textureSize : 0;
}

/** Move a neighbouring island to meet the selected one along an edge they share on the mesh, and join them there. */
export function stitchIslands(m: Model, faces: Iterable<number>, selected: Set<number>): boolean {
  const list = [...faces];
  const islands = uvIslands(m, list);
  const home = islands.find((isl) => isl.some((f) => selected.has(f)));
  if (!home) return false;
  const inHome = new Set(home);
  const owner = new Map<number, number[]>();
  for (const isl of islands) if (isl !== home) for (const f of isl) owner.set(f, isl);
  const ef = edgeFaces(m);
  let other: number[] | null = null;
  const shared: { a: number; b: number; fh: number; fo: number }[] = [];
  const homeFirst = [...home].sort((x, y) => Number(selected.has(y)) - Number(selected.has(x)));
  for (const fh of homeFirst) {
    const f = m.faces[fh];
    f.v.forEach((a, i) => {
      const b = f.v[(i + 1) % f.v.length];
      for (const fo of ef.get(edgeKey(a, b)) ?? []) {
        if (inHome.has(fo) || !owner.has(fo)) continue;
        if (!other) other = owner.get(fo)!;
        if (owner.get(fo) === other) shared.push({ a, b, fh, fo });
      }
    });
  }
  if (!other || !shared.length) return false;
  const first = shared[0];
  const p = edgeUV(m.faces[first.fh], first.a, first.b)!;
  const q = edgeUV(m.faces[first.fo], first.a, first.b)!;
  // The rotation and scale that lay the other island's edge on this one.
  const qx = q[1][0] - q[0][0], qy = q[1][1] - q[0][1], px = p[1][0] - p[0][0], py = p[1][1] - p[0][1];
  const qq = qx * qx + qy * qy;
  if (qq < 1e-14) return false;
  const cr = (px * qx + py * qy) / qq, ci = (py * qx - px * qy) / qq;
  const ox = q[0][0], oy = q[0][1], tx = p[0][0], ty = p[0][1];
  for (const fi of other as number[]) for (const u of m.faces[fi].uv) {
    const x = u[0] - ox, y = u[1] - oy;
    u[0] = tx + cr * x - ci * y;
    u[1] = ty + ci * x + cr * y;
  }
  // Any remaining drift along the shared edges closes up exactly.
  for (const { a, b, fh, fo } of shared) {
    for (const vert of [a, b]) {
      const from = m.faces[fh], to = m.faces[fo];
      const src = from.uv[from.v.indexOf(vert)], dst = to.uv[to.v.indexOf(vert)];
      dst[0] = src[0]; dst[1] = src[1];
    }
  }
  return true;
}

/** Even out UV points by moving each toward the average of its neighbours. Island borders and unlisted points stay. */
export function relaxUV(m: Model, faces: Iterable<number>, corners: Iterable<[number, number]>, iterations = 10) {
  const list = [...faces];
  const keyOf = (fi: number, c: number) => {
    const f = m.faces[fi];
    return `${f.v[c]}|${f.uv[c][0].toFixed(5)},${f.uv[c][1].toFixed(5)}`;
  };
  const movable = new Set<string>();
  for (const [f, c] of corners) movable.add(keyOf(f, c));
  const edgeCount = new Map<string, number>();
  const groups = new Map<string, V2[]>();
  const links = new Map<string, Set<string>>();
  for (const fi of list) {
    const f = m.faces[fi];
    f.v.forEach((_, c) => {
      const a = keyOf(fi, c), b = keyOf(fi, (c + 1) % f.v.length);
      const e = a < b ? `${a}~${b}` : `${b}~${a}`;
      edgeCount.set(e, (edgeCount.get(e) ?? 0) + 1);
      const g = groups.get(a);
      if (g) g.push(f.uv[c]); else groups.set(a, [f.uv[c]]);
      if (!links.has(a)) links.set(a, new Set());
      if (!links.has(b)) links.set(b, new Set());
      links.get(a)!.add(b); links.get(b)!.add(a);
    });
  }
  edgeCount.forEach((n, e) => { if (n === 1) { const [a, b] = e.split('~'); movable.delete(a); movable.delete(b); } });
  const at = new Map<string, V2>();
  groups.forEach((g, k) => at.set(k, [g[0][0], g[0][1]]));
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, V2>();
    for (const k of movable) {
      const nb = links.get(k);
      if (!nb?.size) continue;
      let x = 0, y = 0;
      for (const o of nb) { const p = at.get(o)!; x += p[0]; y += p[1]; }
      next.set(k, [x / nb.size, y / nb.size]);
    }
    next.forEach((v, k) => at.set(k, v));
  }
  for (const k of movable) {
    const v = at.get(k)!;
    for (const u of groups.get(k) ?? []) { u[0] = v[0]; u[1] = v[1]; }
  }
}

// ---------- analysis ----------
function uvTriangles(m: Model, fi: number): [V2, V2, V2][] {
  const f = m.faces[fi];
  const tris = triangulate(f.v.map((i) => m.verts[i].p));
  const out: [V2, V2, V2][] = [];
  for (let t = 0; t < tris.length; t += 3) out.push([f.uv[tris[t]], f.uv[tris[t + 1]], f.uv[tris[t + 2]]]);
  return out;
}

/**
 * Distortion per face: 1 means the face keeps its true shape at the layout's average scale; 2 means something
 * is stretched or squashed to twice or half its size. Measured from each triangle's 3D-to-UV mapping.
 */
export function uvStretch(m: Model, faces: Iterable<number>): Map<number, number> {
  const list = [...faces];
  const a3 = list.reduce((s, fi) => s + faceArea(m, m.faces[fi]), 0);
  const au = uvUsageRaw(m, list);
  const k = a3 > 1e-12 ? Math.sqrt(au / a3) : 1;
  const out = new Map<number, number>();
  for (const fi of list) {
    const f = m.faces[fi];
    const tris = triangulate(f.v.map((i) => m.verts[i].p));
    let worst = 1;
    for (let t = 0; t < tris.length; t += 3) {
      const [i0, i1, i2] = [tris[t], tris[t + 1], tris[t + 2]];
      const A = m.verts[f.v[i0]].p, B = m.verts[f.v[i1]].p, C = m.verts[f.v[i2]].p;
      const ab = sub(B, A), ac = sub(C, A);
      const l = Math.hypot(...ab), area2 = Math.hypot(...cross(ab, ac));
      if (l < 1e-12 || area2 < 1e-14) continue;
      const x1 = l, x2 = dot(ab, ac) / l, y2 = area2 / l;
      const du1 = f.uv[i1][0] - f.uv[i0][0], dv1 = f.uv[i1][1] - f.uv[i0][1];
      const du2 = f.uv[i2][0] - f.uv[i0][0], dv2 = f.uv[i2][1] - f.uv[i0][1];
      // The Jacobian of the mapping from the triangle's plane into UV space, and its singular values.
      const a = du1 / x1, c = dv1 / x1;
      const b = (du2 - a * x2) / y2, d = (dv2 - c * x2) / y2;
      const e = a * a + b * b + c * c + d * d;
      const det = a * d - b * c;
      const root = Math.sqrt(Math.max(0, e * e - 4 * det * det));
      const s1 = Math.sqrt((e + root) / 2), s2 = Math.sqrt(Math.max(0, (e - root) / 2));
      const v = k > 1e-12 ? Math.max(s1 / k, s2 > 1e-9 ? k / s2 : 8) : 8;
      worst = Math.max(worst, v);
    }
    out.set(fi, Math.min(worst, 8));
  }
  return out;
}

function trisOverlap(p: [V2, V2, V2], q: [V2, V2, V2]): boolean {
  const eps = 1e-6;
  for (const [a, b] of [[p, q], [q, p]] as const) {
    for (let i = 0; i < 3; i++) {
      const e0 = a[i], e1 = a[(i + 1) % 3];
      const nx = e1[1] - e0[1], ny = e0[0] - e1[0];
      const l = Math.hypot(nx, ny);
      if (l < 1e-12) return false;
      const proj = (t: [V2, V2, V2]) => t.map((v) => (v[0] * nx + v[1] * ny) / l);
      const pa = proj(a), pb = proj(b);
      if (Math.max(...pa) <= Math.min(...pb) + eps || Math.max(...pb) <= Math.min(...pa) + eps) return false;
    }
  }
  return true;
}

/** Faces whose UVs lie on top of another face's. Uses a uniform grid, so it stays quick on large layouts. */
export function uvOverlaps(m: Model, faces: Iterable<number>): Set<number> {
  const tris: { f: number; t: [V2, V2, V2]; x0: number; x1: number; y0: number; y1: number }[] = [];
  let lox = Infinity, loy = Infinity, hix = -Infinity, hiy = -Infinity;
  for (const fi of faces) for (const t of uvTriangles(m, fi)) {
    const xs = t.map((v) => v[0]), ys = t.map((v) => v[1]);
    const r = { f: fi, t, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    tris.push(r);
    lox = Math.min(lox, r.x0); hix = Math.max(hix, r.x1); loy = Math.min(loy, r.y0); hiy = Math.max(hiy, r.y1);
  }
  const out = new Set<number>();
  if (tris.length < 2) return out;
  const N = Math.max(4, Math.min(128, Math.ceil(Math.sqrt(tris.length))));
  const sx = N / Math.max(hix - lox, 1e-9), sy = N / Math.max(hiy - loy, 1e-9);
  const cell = (v: number) => Math.max(0, Math.min(N - 1, Math.floor(v)));
  const grid = new Map<number, number[]>();
  const tested = new Set<number>();
  const total = tris.length;
  tris.forEach((r, i) => {
    for (let gy = cell((r.y0 - loy) * sy); gy <= cell((r.y1 - loy) * sy); gy++) {
      for (let gx = cell((r.x0 - lox) * sx); gx <= cell((r.x1 - lox) * sx); gx++) {
        const key = gy * N + gx;
        const list = grid.get(key);
        if (!list) { grid.set(key, [i]); continue; }
        for (const j of list) {
          const o = tris[j];
          if (o.f === r.f) continue;
          const pair = j * total + i;
          if (tested.has(pair)) continue;
          tested.add(pair);
          if (r.x0 >= o.x1 || o.x0 >= r.x1 || r.y0 >= o.y1 || o.y0 >= r.y1) continue;
          if (trisOverlap(r.t, o.t)) { out.add(r.f); out.add(o.f); }
        }
        list.push(i);
      }
    }
  });
  return out;
}

function uvUsageRaw(m: Model, faces: Iterable<number>): number {
  let a = 0;
  for (const fi of faces) {
    const uv = m.faces[fi].uv;
    let s = 0;
    for (let i = 0; i < uv.length; i++) {
      const p = uv[i], q = uv[(i + 1) % uv.length];
      s += p[0] * q[1] - q[0] * p[1];
    }
    a += Math.abs(s) / 2;
  }
  return a;
}

function rotateToMinBox(m: Model, chart: number[]) {
  let best = 0, bestArea = Infinity;
  const pts: V2[] = [];
  for (const fi of chart) for (const u of m.faces[fi].uv) pts.push(u);
  const tryAngle = (d: number) => {
    const a = (d * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) {
      const x = p[0] * c - p[1] * s, y = p[0] * s + p[1] * c;
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area < bestArea - 1e-9) { bestArea = area; best = a; }
  };
  for (let d = 0; d < 90; d += 5) tryAngle(d);
  // Narrow in on the best angle.
  for (const [span, step] of [[5, 0.5], [0.5, 0.05]]) {
    const mid = (best * 180) / Math.PI;
    for (let d = mid - span; d <= mid + span; d += step) tryAngle(d);
  }
  if (best) {
    const c = Math.cos(best), s = Math.sin(best);
    for (const p of pts) { const x = p[0] * c - p[1] * s; p[1] = p[0] * s + p[1] * c; p[0] = x; }
  }
}

/** Fraction of the 0..1 square covered by UVs (ignoring overlap). */
export function uvUsage(m: Model, faces: Iterable<number>): number {
  return Math.min(1, uvUsageRaw(m, faces));
}
