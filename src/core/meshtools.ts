// More mesh tools, after Blender and its LoopTools add-on: loop shaping (circle, flatten, space, bridge), hole
// filling (grid fill, fill), bevel, dissolve, connect, poke, solidify, spin, separating loose parts, and selection
// helpers. Each mutates the model in place; the editor wraps calls in undo steps.
import { add, cross, dist, dot, edgeFaces, edgeKey, faceNormal, len, norm, parseEdge, sub, triangulate } from './geom';
import { fixNormals, removeLoose } from './ops';
import type { Face, Model, V2, V3 } from './types';

const scale = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const lerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const lerpUV = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** UVs for new faces: a flat projection along their normal, as other new faces get. */
function planarUV(m: Model, vs: number[]): V2[] {
  const n = norm(newellNormal(m, vs));
  const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = norm(cross(ref, n)), v = cross(n, u);
  return vs.map((i) => [dot(m.verts[i].p, u), dot(m.verts[i].p, v)]);
}

function newellNormal(m: Model, vs: number[]): V3 {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < vs.length; i++) {
    const a = m.verts[vs[i]].p, b = m.verts[vs[(i + 1) % vs.length]].p;
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

function centroid(m: Model, vs: Iterable<number>): V3 {
  let c: V3 = [0, 0, 0], n = 0;
  for (const v of vs) { c = add(c, m.verts[v].p); n++; }
  return n ? scale(c, 1 / n) : c;
}

function newVert(m: Model, p: V3, like?: number): number {
  const w = like !== undefined ? m.verts[like].w?.map((x) => [x[0], x[1]] as [number, number]) : undefined;
  m.verts.push(w ? { p, w } : { p });
  return m.verts.length - 1;
}

// ---------- loops from a selection ----------
export interface Loop { verts: number[]; closed: boolean }

/**
 * The selected edges as chains: each a run of vertices joined by selected edges, open or closed. Branching
 * selections are left out.
 */
export function edgeLoops(edges: Iterable<string>): Loop[] {
  const adj = new Map<number, number[]>();
  for (const k of edges) {
    const [a, b] = parseEdge(k);
    (adj.get(a) ?? adj.set(a, []).get(a)!).push(b);
    (adj.get(b) ?? adj.set(b, []).get(b)!).push(a);
  }
  const seen = new Set<number>();
  const out: Loop[] = [];
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    // The whole connected piece, to check it doesn't branch.
    const piece: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) { const v = stack.pop()!; piece.push(v); for (const w of adj.get(v)!) if (!seen.has(w)) { seen.add(w); stack.push(w); } }
    if (piece.some((v) => adj.get(v)!.length > 2)) continue;
    const end = piece.find((v) => adj.get(v)!.length === 1);
    const closed = end === undefined;
    const verts = [end ?? piece[0]];
    let prev = -1;
    for (;;) {
      const cur = verts[verts.length - 1];
      const next = adj.get(cur)!.find((w) => w !== prev && (!closed || w !== verts[0] || verts.length < 2));
      if (next === undefined || (closed && next === verts[0])) break;
      if (verts.includes(next)) break;
      prev = cur;
      verts.push(next);
    }
    if (verts.length >= 2) out.push({ verts, closed: closed && verts.length >= 3 });
  }
  return out;
}

/** Mesh edges with both ends among `verts`. */
export function edgesAmong(m: Model, verts: Set<number>): Set<string> {
  const out = new Set<string>();
  for (const f of m.faces) for (let i = 0; i < f.v.length; i++) {
    const a = f.v[i], b = f.v[(i + 1) % f.v.length];
    if (verts.has(a) && verts.has(b)) out.add(edgeKey(a, b));
  }
  return out;
}

/** The best-fit plane through points: their centre and the normal across which they spread least. */
export function fitPlane(pts: V3[]): { center: V3; normal: V3 } {
  const c = scale(pts.reduce((s, p) => add(s, p), [0, 0, 0] as V3), 1 / Math.max(1, pts.length));
  // Covariance, then its smallest eigenvector by Jacobi rotations.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const p of pts) { const d = sub(p, c); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) A[i][j] += d[i] * d[j]; }
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += A[p][q] * A[p][q];
    if (off < 1e-20) break;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) {
      if (Math.abs(A[p][q]) < 1e-30) continue;
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) { const a = A[k][p], b = A[k][q]; A[k][p] = cs * a - sn * b; A[k][q] = sn * a + cs * b; }
      for (let k = 0; k < 3; k++) { const a = A[p][k], b = A[q][k]; A[p][k] = cs * a - sn * b; A[q][k] = sn * a + cs * b; }
      for (let k = 0; k < 3; k++) { const a = V[k][p], b = V[k][q]; V[k][p] = cs * a - sn * b; V[k][q] = sn * a + cs * b; }
    }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (A[i][i] < A[best][best]) best = i;
  const n = norm([V[0][best], V[1][best], V[2][best]]);
  return { center: c, normal: len(n) > 0 ? n : [0, 1, 0] };
}

// ---------- loop tools ----------
/**
 * Circle: make each closed loop a circle in its best-fit plane, keeping its size (the average distance from its
 * centre). `regular` spaces the points evenly; otherwise each keeps its own angle. `influence` 0..1 blends.
 */
export function circleLoops(m: Model, loops: Loop[], regular = true, influence = 1): number {
  let n = 0;
  for (const l of loops) {
    if (!l.closed || l.verts.length < 3) continue;
    const pts = l.verts.map((v) => m.verts[v].p);
    const { center, normal } = fitPlane(pts);
    // Keep the loop's own direction around the normal.
    const nn = dot(newellNormal(m, l.verts), normal) < 0 ? scale(normal, -1) : normal;
    const flat = pts.map((p) => { const d = sub(p, center); return sub(d, scale(nn, dot(d, nn))); });
    const r = flat.reduce((s, d) => s + len(d), 0) / flat.length;
    if (r < 1e-9) continue;
    const u = norm(len(flat[0]) > 1e-9 ? flat[0] : cross(nn, [1, 0, 0]));
    const w = cross(nn, u);
    l.verts.forEach((v, i) => {
      const a = regular ? (2 * Math.PI * i) / l.verts.length : Math.atan2(dot(flat[i], w), dot(flat[i], u));
      const target = add(center, add(scale(u, Math.cos(a) * r), scale(w, Math.sin(a) * r)));
      m.verts[v].p = lerp(m.verts[v].p, target, influence);
    });
    n++;
  }
  return n;
}

/** Flatten: move the vertices onto their best-fit plane. `influence` 0..1 blends. */
export function flattenVerts(m: Model, verts: Set<number>, influence = 1) {
  if (verts.size < 3) return;
  const { center, normal } = fitPlane([...verts].map((v) => m.verts[v].p));
  for (const v of verts) {
    const p = m.verts[v].p;
    m.verts[v].p = lerp(p, sub(p, scale(normal, dot(sub(p, center), normal))), influence);
  }
}

/** Space: spread each loop's points evenly along its own path, keeping its shape and, if open, its ends. */
export function spaceLoops(m: Model, loops: Loop[], influence = 1): number {
  let n = 0;
  for (const l of loops) {
    const pts = l.verts.map((v) => [...m.verts[v].p] as V3);
    const path = l.closed ? [...pts, pts[0]] : pts;
    const cum = [0];
    for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dist(path[i - 1], path[i]));
    const total = cum[cum.length - 1];
    if (total < 1e-12) continue;
    const at = (s: number): V3 => {
      let i = 1;
      while (i < cum.length - 1 && cum[i] < s) i++;
      const t = (s - cum[i - 1]) / Math.max(1e-12, cum[i] - cum[i - 1]);
      return lerp(path[i - 1], path[i], Math.max(0, Math.min(1, t)));
    };
    const steps = l.closed ? pts.length : pts.length - 1;
    l.verts.forEach((v, i) => { m.verts[v].p = lerp(pts[i], at((total * i) / steps), influence); });
    n++;
  }
  return n;
}

/**
 * Curve: smooth each open loop into an even curve through its ends, shaped by its own points (Catmull-Rom through
 * every other point), keeping the ends where they are.
 */
export function curveLoops(m: Model, loops: Loop[], influence = 1): number {
  let n = 0;
  for (const l of loops) {
    if (l.closed || l.verts.length < 3) continue;
    const pts = l.verts.map((v) => [...m.verts[v].p] as V3);
    // Knots: the ends and every other point between; the rest are pulled onto the curve through them.
    const knots: number[] = [];
    for (let i = 0; i < pts.length; i += 2) knots.push(i);
    if (knots[knots.length - 1] !== pts.length - 1) knots.push(pts.length - 1);
    const P = (k: number) => pts[knots[Math.max(0, Math.min(knots.length - 1, k))]];
    for (let s = 0; s < knots.length - 1; s++) {
      const a = knots[s], b = knots[s + 1];
      for (let i = a + 1; i < b; i++) {
        const t = (i - a) / (b - a);
        const p0 = P(s - 1), p1 = P(s), p2 = P(s + 1), p3 = P(s + 2);
        const t2 = t * t, t3 = t2 * t;
        const c = [0, 1, 2].map((k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3)) as V3;
        m.verts[l.verts[i]].p = lerp(pts[i], c, influence);
      }
    }
    n++;
  }
  return n;
}

/**
 * Bridge: join loops with faces, in order (more than two loft through them all). Loops line up by their closest
 * points, and unequal ones are joined with some triangles. `segments` adds rows of points between, and `twist`
 * turns the second loop's starting point. Returns the new faces.
 */
export function bridgeLoops(m: Model, loops: Loop[], groupId: number, segments = 1, twist = 0): number[] {
  const made: number[] = [];
  if (loops.length < 2) return made;
  // Order loops into a chain, nearest centre next.
  const left = loops.slice(1);
  const chain = [loops[0]];
  while (left.length) {
    const c = centroid(m, chain[chain.length - 1].verts);
    let bi = 0;
    left.forEach((l, i) => { if (dist(centroid(m, l.verts), c) < dist(centroid(m, left[bi].verts), c)) bi = i; });
    chain.push(left.splice(bi, 1)[0]);
  }
  for (let k = 0; k + 1 < chain.length; k++) made.push(...bridgePair(m, chain[k], chain[k + 1], groupId, segments, k === 0 ? twist : 0));
  return made;
}

function bridgePair(m: Model, A: Loop, B: Loop, groupId: number, segments: number, twist: number): number[] {
  const closed = A.closed && B.closed;
  let a = A.verts.slice(), b = B.verts.slice();
  if (closed) {
    // Same direction around, then start B at the point nearest A's start, then the twist.
    const ca = centroid(m, a), cb = centroid(m, b);
    const na = norm(newellNormal(m, a)), nb = norm(newellNormal(m, b));
    const axis = norm(sub(cb, ca));
    // Both loops seen along the line between them should turn the same way.
    if (Math.sign(dot(na, axis) || 1) !== Math.sign(dot(nb, axis) || 1)) b.reverse();
    let best = 0;
    b.forEach((v, i) => { if (dist(m.verts[v].p, m.verts[a[0]].p) < dist(m.verts[b[best]].p, m.verts[a[0]].p)) best = i; });
    const s = ((best + twist) % b.length + b.length) % b.length;
    b = [...b.slice(s), ...b.slice(0, s)];
  } else {
    // Open chains: match their ends the shorter way.
    const d1 = dist(m.verts[a[0]].p, m.verts[b[0]].p) + dist(m.verts[a[a.length - 1]].p, m.verts[b[b.length - 1]].p);
    const d2 = dist(m.verts[a[0]].p, m.verts[b[b.length - 1]].p) + dist(m.verts[a[a.length - 1]].p, m.verts[b[0]].p);
    if (d2 < d1) b.reverse();
  }
  // Rows from A to B: A, any in-between rows, then B. In-between rows follow A's count, placed between matching points.
  const rows: number[][] = [a];
  const sample = (loop: number[], t: number): V3 => {
    const n = closed ? loop.length : loop.length - 1;
    const x = t * n, i = Math.floor(x), f = x - i;
    const p = m.verts[loop[Math.min(i, loop.length - 1) % loop.length]].p, q = m.verts[loop[Math.min(i + 1, closed ? i + 1 : loop.length - 1) % loop.length]].p;
    return lerp(p, q, f);
  };
  for (let s = 1; s < segments; s++) {
    const t = s / segments;
    const n = closed ? a.length : a.length - 1;
    rows.push(a.map((v, i) => newVert(m, lerp(m.verts[v].p, sample(b, i / Math.max(1, n)), t), v)));
  }
  rows.push(b);
  const made: number[] = [];
  const g = groupId;
  for (let r = 0; r + 1 < rows.length; r++) {
    const top = rows[r], bot = rows[r + 1];
    // Walk both rows together, joining by whichever step keeps the points closest in their own progress.
    const nt = closed ? top.length : top.length - 1, nb = closed ? bot.length : bot.length - 1;
    let i = 0, j = 0;
    while (i < nt || j < nb) {
      const ti = top[i % top.length], tn = top[(i + 1) % top.length], bj = bot[j % bot.length], bn = bot[(j + 1) % bot.length];
      const advTop = i < nt && (j >= nb || (i + 1) / nt <= (j + 1) / nb + 1e-9);
      const advBot = j < nb && (i >= nt || (j + 1) / nb <= (i + 1) / nt + 1e-9);
      let vs: number[];
      if (advTop && advBot) { vs = [ti, tn, bn, bj]; i++; j++; }
      else if (advTop) { vs = [ti, tn, bj]; i++; }
      else { vs = [ti, bn, bj]; j++; }
      if (new Set(vs).size < 3) continue;
      m.faces.push({ v: vs, uv: planarUV(m, vs), g, s: 0 });
      made.push(m.faces.length - 1);
    }
  }
  // Face the same way as the surfaces around.
  orientLike(m, made);
  return made;
}

/** Turn new faces to agree with the faces they join, or outward if they join none. */
function orientLike(m: Model, faces: number[]) {
  if (!faces.length) return;
  const set = new Set(faces);
  // A directed edge used by an older face: the new face along it should run the other way.
  const dir = new Set<string>();
  m.faces.forEach((f, fi) => { if (!set.has(fi)) f.v.forEach((a, i) => dir.add(`${a}>${f.v[(i + 1) % f.v.length]}`)); });
  let agree = 0, clash = 0;
  for (const fi of faces) {
    const f = m.faces[fi];
    f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; if (dir.has(`${b}>${a}`)) agree++; if (dir.has(`${a}>${b}`)) clash++; });
  }
  // Make the new faces consistent among themselves first.
  fixNormals(m, set);
  agree = 0; clash = 0;
  for (const fi of faces) {
    const f = m.faces[fi];
    f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; if (dir.has(`${b}>${a}`)) agree++; if (dir.has(`${a}>${b}`)) clash++; });
  }
  if (clash > agree) for (const fi of faces) { const f = m.faces[fi]; f.v.reverse(); f.uv.reverse(); f.seam = undefined; f.pin = undefined; }
}

// ---------- filling holes ----------
/** Open boundary loops whose vertices are all in `verts`, each ordered so a face filling it faces like its neighbours. */
export function holeLoops(m: Model, verts: Set<number> | null): number[][] {
  const ef = edgeFaces(m);
  const nextOf = new Map<number, number>();
  m.faces.forEach((f) => f.v.forEach((a, i) => {
    const b = f.v[(i + 1) % f.v.length];
    if ((ef.get(edgeKey(a, b)) ?? []).length === 1 && (!verts || (verts.has(a) && verts.has(b)))) nextOf.set(b, a);
  }));
  const out: number[][] = [];
  const seen = new Set<number>();
  for (const start of nextOf.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = nextOf.get(v); }
    if (v === start && loop.length >= 3) out.push(loop);
  }
  return out;
}

/** The smoothing group of a face beside a hole, so the fill shades with it. */
function neighbourSmooth(m: Model, loop: number[]): number {
  const set = new Set(loop);
  return m.faces.find((f) => f.v.some((v) => set.has(v)))?.s ?? 0;
}

/**
 * Grid Fill: fill a hole with a grid of quads, as Blender does. The hole needs an even number of edges; its sides
 * are `span` edges across and the rest up, from the corner `offset` points round. The inside is a Coons patch of the
 * four sides, so it follows a curved rim. Returns the number of holes filled.
 */
export function gridFill(m: Model, loops: number[][], groupId: number, span = 0, offset = 0): number {
  let filled = 0;
  for (const raw of loops) {
    const n = raw.length;
    if (n < 4 || n % 2) continue;
    const s0 = ((offset % n) + n) % n;
    const loop = [...raw.slice(s0), ...raw.slice(0, s0)];
    const a = span > 0 ? Math.min(n / 2 - 1, Math.max(1, Math.round(span))) : Math.max(1, Math.round(n / 4));
    const b = n / 2 - a;
    if (b < 1) continue;
    const P = (i: number) => m.verts[loop[((i % n) + n) % n]].p;
    // Sides: bottom 0..a, right a..a+b, top (a+b)..(2a+b) run backward, left (2a+b)..n run backward.
    const bottom = (i: number) => P(i), top = (i: number) => P(2 * a + b - i);
    const leftSide = (j: number) => P(n - j), rightSide = (j: number) => P(a + j);
    const grid: number[][] = [];
    const smooth = neighbourSmooth(m, loop);
    for (let j = 0; j <= b; j++) {
      const row: number[] = [];
      for (let i = 0; i <= a; i++) {
        if (j === 0) { row.push(loop[i]); continue; }
        if (j === b) { row.push(loop[(2 * a + b - i) % n]); continue; }
        if (i === 0) { row.push(loop[(n - j) % n]); continue; }
        if (i === a) { row.push(loop[a + j]); continue; }
        const u = i / a, v = j / b;
        // Coons patch: the two blends of opposite sides, less the four corners weighted bilinearly.
        const corner = add(add(scale(P(0), (1 - u) * (1 - v)), scale(P(a), u * (1 - v))), add(scale(P(a + b), u * v), scale(P(2 * a + b), (1 - u) * v)));
        const p = sub(add(add(scale(bottom(i), 1 - v), scale(top(i), v)), add(scale(leftSide(j), 1 - u), scale(rightSide(j), u))), corner);
        row.push(newVert(m, p, loop[i]));
      }
      grid.push(row);
    }
    const made: number[] = [];
    for (let j = 0; j < b; j++) for (let i = 0; i < a; i++) {
      const vs = [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]];
      m.faces.push({ v: vs, uv: planarUV(m, vs), g: groupId, s: smooth });
      made.push(m.faces.length - 1);
    }
    orientLike(m, made);
    filled++;
  }
  return filled;
}

/** Fill: close each hole with triangles laid across it, facing like its neighbours. */
export function triFill(m: Model, loops: number[][], groupId: number): number {
  let filled = 0;
  for (const loop of loops) {
    const tris = triangulate(loop.map((v) => m.verts[v].p));
    const made: number[] = [];
    const smooth = neighbourSmooth(m, loop);
    for (let t = 0; t < tris.length; t += 3) {
      const vs = [loop[tris[t]], loop[tris[t + 1]], loop[tris[t + 2]]];
      m.faces.push({ v: vs, uv: planarUV(m, vs), g: groupId, s: smooth });
      made.push(m.faces.length - 1);
    }
    orientLike(m, made);
    if (made.length) filled++;
  }
  return filled;
}

// ---------- merging faces ----------
/**
 * Replace a connected set of faces with one face, its outline, when the outline is a single loop. Returns the new
 * face's index, or -1 if the region has holes or more than one outline.
 */
function mergeRegion(m: Model, faces: number[]): number {
  if (faces.length === 1) return faces[0];
  const set = new Set(faces);
  const dir = new Map<string, { a: number; b: number; uv: V2 }>();
  for (const fi of faces) {
    const f = m.faces[fi];
    f.v.forEach((a, i) => dir.set(`${a}>${f.v[(i + 1) % f.v.length]}`, { a, b: f.v[(i + 1) % f.v.length], uv: f.uv[i] }));
  }
  // Outline: directed edges whose reverse isn't in the region.
  const next = new Map<number, { b: number; uv: V2 }>();
  for (const [k, e] of dir) {
    if (dir.has(`${e.b}>${e.a}`)) continue;
    if (next.has(e.a)) return -1; // a vertex the outline passes twice
    next.set(e.a, { b: e.b, uv: e.uv });
    void k;
  }
  if (!next.size) return -1;
  const start = next.keys().next().value as number;
  const vs: number[] = [], uvs: V2[] = [];
  let v = start;
  do {
    const e = next.get(v);
    if (!e) return -1;
    vs.push(v); uvs.push([e.uv[0], e.uv[1]]);
    v = e.b;
  } while (v !== start && vs.length <= next.size);
  if (vs.length !== next.size) return -1;
  const keep = faces[0];
  const f = m.faces[keep];
  m.faces[keep] = { v: vs, uv: uvs, g: f.g, s: f.s };
  for (const fi of faces.slice(1)) m.faces[fi] = { v: [], uv: [], g: f.g, s: 0 };
  void set;
  return keep;
}

/** Drop faces emptied by merging, and vertices nothing uses any more. */
function dropEmpty(m: Model) {
  m.faces = m.faces.filter((f) => f.v.length >= 3);
  removeLoose(m);
}

/** Faces sharing an edge, as groups, among `faces`. */
function regions(m: Model, faces: Set<number>, joinable: (key: string) => boolean = () => true): number[][] {
  const ef = edgeFaces(m);
  const seen = new Set<number>();
  const out: number[][] = [];
  for (const s of faces) {
    if (seen.has(s)) continue;
    const reg: number[] = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const fi = stack.pop()!;
      reg.push(fi);
      const f = m.faces[fi];
      f.v.forEach((a, i) => {
        const k = edgeKey(a, f.v[(i + 1) % f.v.length]);
        if (!joinable(k)) return;
        for (const nb of ef.get(k) ?? []) if (faces.has(nb) && !seen.has(nb)) { seen.add(nb); stack.push(nb); }
      });
    }
    out.push(reg);
  }
  return out;
}

/** Take out a vertex that only sits along a straight run of one face's outline. */
function dropInlineVerts(m: Model, verts: Iterable<number>) {
  const ef = edgeFaces(m);
  for (const v of verts) {
    const around = new Set<number>();
    m.faces.forEach((f) => { const i = f.v.indexOf(v); if (i >= 0) { around.add(f.v[(i + 1) % f.v.length]); around.add(f.v[(i - 1 + f.v.length) % f.v.length]); } });
    // Two neighbours only: v is a bend or a straight point on a line of edges, not a corner of a fan.
    if (around.size !== 2) continue;
    const [x, y] = [...around];
    const dxv = norm(sub(m.verts[v].p, m.verts[x].p)), dvy = norm(sub(m.verts[y].p, m.verts[v].p));
    if (dot(dxv, dvy) < 0.999) continue;
    void ef;
    m.faces.forEach((f) => {
      const i = f.v.indexOf(v);
      if (i < 0 || f.v.length <= 3) return;
      f.v.splice(i, 1); f.uv.splice(i, 1);
      if (f.seam) f.seam.splice(i, 1);
      if (f.pin) f.pin.splice(i, 1);
    });
  }
}

/** Dissolve faces: each connected patch of selected faces becomes one face. Returns how many faces it made. */
export function dissolveFaces(m: Model, faces: Set<number>): number {
  let n = 0;
  for (const reg of regions(m, faces)) if (reg.length > 1 && mergeRegion(m, reg) >= 0) n++;
  dropEmpty(m);
  return n;
}

/** Dissolve edges: the faces on either side of each edge become one, and points left on a straight line go. */
export function dissolveEdges(m: Model, edges: Set<string>): number {
  const ef = edgeFaces(m);
  const touched = new Set<number>();
  for (const k of edges) for (const fi of ef.get(k) ?? []) touched.add(fi);
  let n = 0;
  for (const reg of regions(m, touched, (k) => edges.has(k))) if (reg.length > 1 && mergeRegion(m, reg) >= 0) n++;
  const ends = new Set<number>();
  for (const k of edges) parseEdge(k).forEach((v) => ends.add(v));
  dropEmpty(m);
  dropInlineVerts(m, [...ends].filter((v) => v < m.verts.length));
  return n;
}

/** Dissolve vertices: the faces around each become one face, without the vertex. */
export function dissolveVerts(m: Model, verts: Set<number>): number {
  let n = 0;
  for (const v of verts) {
    const around = m.faces.map((f, i) => (f.v.includes(v) ? i : -1)).filter((i) => i >= 0);
    if (!around.length) continue;
    const fi = mergeRegion(m, around);
    if (fi < 0) continue;
    const f = m.faces[fi];
    const i = f.v.indexOf(v);
    if (i >= 0 && f.v.length > 3) { f.v.splice(i, 1); f.uv.splice(i, 1); }
    else if (i >= 0) continue;
    n++;
  }
  dropEmpty(m);
  return n;
}

// ---------- splitting faces ----------
/**
 * Connect: split faces between selected vertices that share them, as Blender's Connect Vertex Path does. A face
 * with two selected corners that aren't neighbours splits in two along the line between them; with more, it splits
 * along each line between consecutive ones. Returns how many cuts it made.
 */
export function connectVerts(m: Model, verts: Set<number>): number {
  let cuts = 0;
  const count = m.faces.length;
  for (let fi = 0; fi < count; fi++) {
    let f = m.faces[fi];
    const picks = f.v.map((v, i) => (verts.has(v) ? i : -1)).filter((i) => i >= 0);
    if (picks.length < 2) continue;
    // Cut from each picked corner to the next, wherever they aren't already neighbours.
    for (let k = 0; k < picks.length; k++) {
      const p = f.v[picks[k]], q = f.v[picks[(k + 1) % picks.length]];
      if (picks.length === 2 && k === 1) break;
      const i = f.v.indexOf(p), j = f.v.indexOf(q);
      if (i < 0 || j < 0) continue;
      const n = f.v.length;
      if ((i + 1) % n === j || (j + 1) % n === i) continue;
      // The two halves: from p round to q, and from q round to p.
      const side = (from: number, to: number) => { const out: number[] = []; for (let x = from; ; x = (x + 1) % n) { out.push(x); if (x === to) break; } return out; };
      const h1 = side(i, j), h2 = side(j, i);
      const make = (idx: number[]): Face => {
        const nf: Face = { v: idx.map((x) => f.v[x]), uv: idx.map((x) => [f.uv[x][0], f.uv[x][1]] as V2), g: f.g, s: f.s };
        if (f.seam) nf.seam = idx.map((x, t) => (t === idx.length - 1 ? false : f.seam![x] ?? false));
        if (f.pin) nf.pin = idx.map((x) => f.pin![x] ?? false);
        return nf;
      };
      m.faces[fi] = make(h1);
      m.faces.push(make(h2));
      cuts++;
      // Carry on cutting the half that still holds the other picks.
      const rest = picks.map((x) => f.v[x]).filter((v) => m.faces[fi].v.includes(v));
      if (rest.length < 2) { f = m.faces[m.faces.length - 1]; } else f = m.faces[fi];
    }
  }
  return cuts;
}

/** Poke: put a point in the middle of each face and fan triangles from it. */
export function pokeFaces(m: Model, faces: Set<number>, offset = 0): number[] {
  const made: number[] = [];
  for (const fi of [...faces]) {
    const f = m.faces[fi];
    const n = f.v.length;
    const c = add(centroid(m, f.v), scale(faceNormal(m, f), offset));
    const cv = newVert(m, c, f.v[0]);
    const cu: V2 = [f.uv.reduce((s, u) => s + u[0], 0) / n, f.uv.reduce((s, u) => s + u[1], 0) / n];
    const tris: Face[] = f.v.map((v, i) => ({ v: [v, f.v[(i + 1) % n], cv], uv: [[...f.uv[i]] as V2, [...f.uv[(i + 1) % n]] as V2, cu], g: f.g, s: f.s }));
    m.faces[fi] = tris[0];
    made.push(fi);
    for (const t of tris.slice(1)) { m.faces.push(t); made.push(m.faces.length - 1); }
  }
  return made;
}

// ---------- thickness ----------
/**
 * Solidify: give the faces thickness, a copy pushed back along the surface's normals by `thickness`, facing the
 * other way, joined round the open edges.
 */
export function solidify(m: Model, faces: Set<number>, thickness: number): number[] {
  const made: number[] = [];
  const vn = new Map<number, V3>();
  for (const fi of faces) {
    const f = m.faces[fi];
    const n = faceNormal(m, f);
    for (const v of f.v) vn.set(v, add(vn.get(v) ?? [0, 0, 0], n));
  }
  const copy = new Map<number, number>();
  vn.forEach((n, v) => copy.set(v, newVert(m, sub(m.verts[v].p, scale(norm(n), thickness)), v)));
  const dirs = new Set<string>();
  for (const fi of faces) { const f = m.faces[fi]; f.v.forEach((a, i) => dirs.add(`${a}>${f.v[(i + 1) % f.v.length]}`)); }
  for (const fi of [...faces]) {
    const f = m.faces[fi];
    // The back: the same face, reversed, on the copied points.
    m.faces.push({ v: f.v.map((v) => copy.get(v)!).reverse(), uv: f.uv.map((u) => [u[0], u[1]] as V2).reverse(), g: f.g, s: f.s });
    made.push(m.faces.length - 1);
    // The rim, along each open edge.
    f.v.forEach((a, i) => {
      const b = f.v[(i + 1) % f.v.length];
      if (dirs.has(`${b}>${a}`)) return;
      const vs = [b, a, copy.get(a)!, copy.get(b)!];
      const ua = f.uv[i], ub = f.uv[(i + 1) % f.v.length];
      m.faces.push({ v: vs, uv: [[...ub] as V2, [...ua] as V2, [...ua] as V2, [...ub] as V2], g: f.g, s: 0 });
      made.push(m.faces.length - 1);
    });
  }
  return made;
}

// ---------- spin ----------
/**
 * Spin: sweep a profile of selected edges round an axis through `center`, in `steps` steps over `angle` degrees,
 * as a lathe does. A full turn joins up with the start. Returns the new faces.
 */
export function spin(m: Model, loops: Loop[], groupId: number, axis: V3, center: V3, angle: number, steps: number): number[] {
  const made: number[] = [];
  const ax = norm(axis);
  const full = Math.abs(Math.abs(angle) - 360) < 1e-6;
  const rings = full ? steps : steps + 1;
  const rot = (p: V3, a: number): V3 => {
    const d = sub(p, center);
    const c = Math.cos(a), s = Math.sin(a);
    const r = add(add(scale(d, c), scale(cross(ax, d), s)), scale(ax, dot(ax, d) * (1 - c)));
    return add(center, r);
  };
  for (const l of loops) {
    const ringsV: number[][] = [l.verts];
    for (let k = 1; k < rings; k++) {
      const a = ((angle * Math.PI) / 180) * (k / steps);
      // Points on the axis stay put, so the ends of a profile touching it close up.
      ringsV.push(l.verts.map((v) => {
        const p = m.verts[v].p, d = sub(p, center);
        if (len(sub(d, scale(ax, dot(d, ax)))) < 1e-9) return v;
        return newVert(m, rot(p, a), v);
      }));
    }
    const faceRows = full ? rings : rings - 1;
    const segs = l.closed ? l.verts.length : l.verts.length - 1;
    const first = made.length;
    for (let k = 0; k < faceRows; k++) {
      const r0 = ringsV[k], r1 = ringsV[(k + 1) % rings];
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % l.verts.length;
        const vs = [r0[i], r0[j], r1[j], r1[i]].filter((v, idx, arr) => arr.indexOf(v) === idx);
        if (vs.length < 3) continue;
        m.faces.push({ v: vs, uv: vs.map((_, t): V2 => [(k + (t === 2 || t === 3 ? 1 : 0)) / faceRows, (i + (t === 1 || t === 2 ? 1 : 0)) / segs]), g: groupId, s: 0 });
        made.push(m.faces.length - 1);
      }
    }
    fixNormals(m, new Set(made.slice(first)));
  }
  return made;
}

// ---------- bevel ----------
/**
 * Bevel the selected edges by `width`: each edge becomes a flat strip, its ends sliding back along the edges beside
 * it, and corners where several bevelled edges meet get a small face of their own. Works on edges between two faces.
 * Returns the new faces.
 */
export function bevelEdges(m: Model, edges: Set<string>, width: number): number[] {
  const ef = edgeFaces(m);
  const sel = new Set([...edges].filter((k) => (ef.get(k) ?? []).length === 2));
  if (!sel.size || width <= 0) return [];
  const verts = new Set<number>();
  for (const k of sel) parseEdge(k).forEach((v) => verts.add(v));
  // Faces round each vertex, with the corner's two neighbours.
  const facesAt = new Map<number, { fi: number; prev: number; next: number }[]>();
  m.faces.forEach((f, fi) => f.v.forEach((v, i) => {
    if (!verts.has(v)) return;
    (facesAt.get(v) ?? facesAt.set(v, []).get(v)!).push({ fi, prev: f.v[(i - 1 + f.v.length) % f.v.length], next: f.v[(i + 1) % f.v.length] });
  }));
  // A point slid from v along the edge toward x: shared by every face beside that edge.
  const slid = new Map<string, number>();
  const slide = (v: number, x: number): number => {
    const k = `${v}>${x}`;
    let id = slid.get(k);
    if (id === undefined) {
      const p = m.verts[v].p, q = m.verts[x].p;
      const t = Math.min(0.45, width / Math.max(1e-9, dist(p, q)));
      id = newVert(m, lerp(p, q, t), v);
      slid.set(k, id);
    }
    return id;
  };
  // What replaces each corner (face, vertex), in the face's own order.
  const repl = new Map<string, { vs: number[]; uv: V2[] }>();
  const uvAlong = (f: Face, i: number, j: number, p: V3, q: V3, at: V3): V2 => {
    const t = dist(p, at) / Math.max(1e-9, dist(p, q));
    return lerpUV(f.uv[i], f.uv[j], t);
  };
  for (const v of verts) {
    for (const c of facesAt.get(v) ?? []) {
      const f = m.faces[c.fi];
      const i = f.v.indexOf(v), n = f.v.length;
      const ip = (i - 1 + n) % n, inx = (i + 1) % n;
      const bSel = sel.has(edgeKey(v, c.prev)), aSel = sel.has(edgeKey(v, c.next));
      const p = m.verts[v].p;
      let vs: number[], uv: V2[];
      if (bSel && aSel) {
        // A corner between two bevelled edges: in from both.
        const dp = norm(sub(m.verts[c.prev].p, p)), dn = norm(sub(m.verts[c.next].p, p));
        const lp = dist(p, m.verts[c.prev].p), ln = dist(p, m.verts[c.next].p);
        const tp = Math.min(0.45 * lp, width), tn = Math.min(0.45 * ln, width);
        const q = add(p, add(scale(dp, tp), scale(dn, tn)));
        vs = [newVert(m, q, v)];
        const u = f.uv[i];
        uv = [[u[0] + (f.uv[ip][0] - u[0]) * (tp / lp) + (f.uv[inx][0] - u[0]) * (tn / ln), u[1] + (f.uv[ip][1] - u[1]) * (tp / lp) + (f.uv[inx][1] - u[1]) * (tn / ln)]];
      } else if (bSel) {
        const s = slide(v, c.next);
        vs = [s]; uv = [uvAlong(f, i, inx, p, m.verts[c.next].p, m.verts[s].p)];
      } else if (aSel) {
        const s = slide(v, c.prev);
        vs = [s]; uv = [uvAlong(f, i, ip, p, m.verts[c.prev].p, m.verts[s].p)];
      } else {
        const s1 = slide(v, c.prev), s2 = slide(v, c.next);
        vs = [s1, s2]; uv = [uvAlong(f, i, ip, p, m.verts[c.prev].p, m.verts[s1].p), uvAlong(f, i, inx, p, m.verts[c.next].p, m.verts[s2].p)];
      }
      repl.set(`${c.fi}:${v}`, { vs, uv });
    }
  }
  // The strips, read before the faces change: each edge (a, b) with the face that runs a→b and the one that runs b→a.
  const strips: { a: number; b: number; f1: number; f2: number }[] = [];
  for (const k of sel) {
    const [x, y] = parseEdge(k);
    const [fa, fb] = ef.get(k)!;
    const runs = (fi: number, a: number, b: number) => { const f = m.faces[fi]; const i = f.v.indexOf(a); return f.v[(i + 1) % f.v.length] === b; };
    if (runs(fa, x, y)) strips.push({ a: x, b: y, f1: fa, f2: fb }); else strips.push({ a: x, b: y, f1: fb, f2: fa });
  }
  // Fan order round each vertex, for the corner faces, before the faces change.
  const fans = new Map<number, number[] | null>();
  for (const v of verts) {
    const list = facesAt.get(v) ?? [];
    const byPrev = new Map(list.map((c) => [c.prev, c]));
    const order: number[] = [];
    let cur = list[0];
    while (cur && order.length <= list.length) {
      order.push(cur.fi);
      const nx = byPrev.get(cur.next);
      if (!nx || nx.fi === list[0].fi) { if (!nx) order.length = 0; break; }
      cur = nx;
    }
    fans.set(v, order.length === list.length ? order : null);
  }
  // Rewrite each face's corners.
  const touched = new Set<number>();
  for (const v of verts) for (const c of facesAt.get(v) ?? []) touched.add(c.fi);
  for (const fi of touched) {
    const f = m.faces[fi];
    const nv: number[] = [], nuv: V2[] = [];
    f.v.forEach((v, i) => {
      const r = repl.get(`${fi}:${v}`);
      if (r) { nv.push(...r.vs); nuv.push(...r.uv); } else { nv.push(v); nuv.push(f.uv[i]); }
    });
    m.faces[fi] = { v: nv, uv: nuv, g: f.g, s: f.s };
  }
  const made: number[] = [];
  const at = (fi: number, v: number) => repl.get(`${fi}:${v}`)!.vs;
  for (const s of strips) {
    const a1 = at(s.f1, s.a), b1 = at(s.f1, s.b), a2 = at(s.f2, s.a), b2 = at(s.f2, s.b);
    const vs = [b1[0], a1[a1.length - 1], a2[0], b2[b2.length - 1]].filter((x, i, arr) => arr.indexOf(x) === i);
    if (vs.length < 3) continue;
    m.faces.push({ v: vs, uv: planarUV(m, vs), g: m.faces[s.f1].g, s: m.faces[s.f1].s });
    made.push(m.faces.length - 1);
  }
  // Corner faces: the hole left round each vertex whose faces all moved off it.
  for (const v of verts) {
    const order = fans.get(v);
    if (!order) continue;
    const ring: number[] = [];
    for (const fi of order) for (const x of at(fi, v)) if (ring[ring.length - 1] !== x) ring.push(x);
    while (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop();
    if (new Set(ring).size < 3) continue;
    const vs = ring.reverse();
    m.faces.push({ v: vs, uv: planarUV(m, vs), g: m.faces[order[0]].g, s: m.faces[order[0]].s });
    made.push(m.faces.length - 1);
  }
  removeLoose(m);
  return made;
}

// ---------- parts and selection ----------
/** Separate: split each group's selected faces into one group per loose part. Returns the new groups' faces. */
export function looseParts(m: Model, faces: Set<number>): number[][] {
  // Joined by shared vertices.
  const byVert = new Map<number, number[]>();
  for (const fi of faces) for (const v of m.faces[fi].v) (byVert.get(v) ?? byVert.set(v, []).get(v)!).push(fi);
  const seen = new Set<number>();
  const parts: number[][] = [];
  for (const s of faces) {
    if (seen.has(s)) continue;
    const part: number[] = [];
    const stack = [s];
    seen.add(s);
    while (stack.length) {
      const fi = stack.pop()!;
      part.push(fi);
      for (const v of m.faces[fi].v) for (const nb of byVert.get(v)!) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); }
    }
    parts.push(part);
  }
  return parts;
}

/** The shortest path along edges between two vertices, by length, as its vertices; empty if they aren't joined. */
export function shortestPath(m: Model, from: number, to: number): number[] {
  const adj = new Map<number, Set<number>>();
  for (const f of m.faces) f.v.forEach((a, i) => {
    const b = f.v[(i + 1) % f.v.length];
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  });
  const d = new Map<number, number>([[from, 0]]);
  const prev = new Map<number, number>();
  const open = new Set([from]);
  while (open.size) {
    let cur = -1, best = Infinity;
    for (const v of open) { const x = d.get(v)!; if (x < best) { best = x; cur = v; } }
    open.delete(cur);
    if (cur === to) break;
    for (const nb of adj.get(cur) ?? []) {
      const nd = best + dist(m.verts[cur].p, m.verts[nb].p);
      if (nd < (d.get(nb) ?? Infinity)) { d.set(nb, nd); prev.set(nb, cur); open.add(nb); }
    }
  }
  if (!d.has(to)) return [];
  const path = [to];
  while (path[path.length - 1] !== from) path.push(prev.get(path[path.length - 1])!);
  return path.reverse();
}

/** The shortest chain of faces, neighbour to neighbour across edges, between two faces. */
export function shortestFacePath(m: Model, from: number, to: number): number[] {
  const ef = edgeFaces(m);
  const prev = new Map<number, number>([[from, -1]]);
  const queue = [from];
  while (queue.length) {
    const fi = queue.shift()!;
    if (fi === to) break;
    const f = m.faces[fi];
    f.v.forEach((a, i) => {
      for (const nb of ef.get(edgeKey(a, f.v[(i + 1) % f.v.length])) ?? []) if (!prev.has(nb)) { prev.set(nb, fi); queue.push(nb); }
    });
  }
  if (!prev.has(to)) return [];
  const path = [to];
  while (prev.get(path[path.length - 1])! >= 0) path.push(prev.get(path[path.length - 1])!);
  return path.reverse();
}

/** Every other face of a selection, by steps across edges from its first, as Blender's Checker Deselect keeps. */
export function checkerFaces(m: Model, faces: Set<number>): Set<number> {
  const ef = edgeFaces(m);
  const keep = new Set<number>();
  const depth = new Map<number, number>();
  for (const s of faces) {
    if (depth.has(s)) continue;
    depth.set(s, 0);
    const queue = [s];
    while (queue.length) {
      const fi = queue.shift()!;
      if (depth.get(fi)! % 2 === 0) keep.add(fi);
      const f = m.faces[fi];
      f.v.forEach((a, i) => {
        for (const nb of ef.get(edgeKey(a, f.v[(i + 1) % f.v.length])) ?? []) if (faces.has(nb) && !depth.has(nb)) { depth.set(nb, depth.get(fi)! + 1); queue.push(nb); }
      });
    }
  }
  return keep;
}


// ---------- extruding edges ----------
/**
 * Extrude edges as Blender's E does: each edge gets a copy of itself joined to it by a new face, ready to be moved
 * away. Points the edges share stay shared in the copies, so a line of edges pulls out as a strip. New faces run
 * against the faces the edges already have, so they face the same way. Returns the copied points and edges.
 */
export function extrudeEdges(m: Model, edges: Set<string>, groupId: number): { verts: number[]; edges: string[] } {
  const ef = edgeFaces(m);
  const copy = new Map<number, number>();
  const dup = (v: number) => {
    let c = copy.get(v);
    if (c === undefined) { c = newVert(m, [...m.verts[v].p] as V3, v); copy.set(v, c); }
    return c;
  };
  const out: string[] = [];
  for (const k of edges) {
    const [x, y] = parseEdge(k);
    // The edge's direction in the face it belongs to; the new face runs the other way along it.
    const fi = (ef.get(k) ?? [])[0];
    const f = fi !== undefined ? m.faces[fi] : undefined;
    let a = x, b = y;
    if (f) { const i = f.v.indexOf(x); if (f.v[(i + 1) % f.v.length] !== y) { a = y; b = x; } }
    const vs = [b, a, dup(a), dup(b)];
    m.faces.push({ v: vs, uv: [[0, 0], [1, 0], [1, 1], [0, 1]], g: f?.g ?? groupId, s: f?.s ?? 0 });
    out.push(edgeKey(dup(a), dup(b)));
  }
  return { verts: [...copy.values()], edges: out };
}

// ---------- inset, as Blender does ----------
/** A face's texture coordinates at any point in its plane, from the best fit of its corners. */
function uvMapper(m: Model, f: Face): (p: V3) => V2 {
  const n = norm(newellNormal(m, f.v));
  const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const ax = norm(cross(ref, n)), ay = cross(n, ax);
  const pts = f.v.map((v) => { const p = m.verts[v].p; return [dot(p, ax), dot(p, ay)]; });
  // Least squares: u = a·x + b·y + c, and likewise v.
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0;
  const k = pts.length;
  pts.forEach(([x, y]) => { sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y; });
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, k]];
  const solve = (b: number[]): number[] => {
    const A = M.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < 3; c++) {
      let piv = c;
      for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      if (Math.abs(A[c][c]) < 1e-14) return [0, 0, b[2] / Math.max(1, k)];
      for (let r = 0; r < 3; r++) if (r !== c) { const t = A[r][c] / A[c][c]; for (let j = c; j < 4; j++) A[r][j] -= t * A[c][j]; }
    }
    return [A[0][3] / A[0][0], A[1][3] / A[1][1], A[2][3] / A[2][2]];
  };
  const bu = [0, 0, 0], bv = [0, 0, 0];
  pts.forEach(([x, y], i) => { const u = f.uv[i] ?? [0, 0]; bu[0] += u[0] * x; bu[1] += u[0] * y; bu[2] += u[0]; bv[0] += u[1] * x; bv[1] += u[1] * y; bv[2] += u[1]; });
  const cu = solve(bu), cv = solve(bv);
  return (p) => { const x = dot(p, ax), y = dot(p, ay); return [cu[0] * x + cu[1] * y + cu[2], cv[0] * x + cv[1] * y + cv[2]]; };
}

export interface InsetOptions {
  /** How far in the new border runs, in metres. */
  thickness: number;
  /** How far the inset faces move along their normal: out when positive. */
  depth: number;
  /** Each face on its own, instead of the selection as one region. */
  individual: boolean;
  /** Keep the border the same width at corners, as Blender's Even Offset does. */
  even: boolean;
}

/**
 * Inset, as Blender's I: the selected faces as one region (or each face, with `individual`) get a new border of
 * faces `thickness` wide round their outline, the inner part moved `depth` along its normal. Returns the inner faces.
 */
export function insetRegion(m: Model, faces: Set<number>, o: InsetOptions): number[] {
  if (o.individual) {
    const inner: number[] = [];
    for (const fi of [...faces]) inner.push(...insetRegion(m, new Set([fi]), { ...o, individual: false }));
    return inner;
  }
  if (!faces.size || (o.thickness === 0 && o.depth === 0)) return [...faces];
  // The region's outline: directed edges of its faces whose reverse isn't in it.
  const owner = new Map<string, number>();
  for (const fi of faces) { const f = m.faces[fi]; f.v.forEach((a, i) => owner.set(`${a}>${f.v[(i + 1) % f.v.length]}`, fi)); }
  const outIn = new Map<number, { next: number; face: number }>(), inTo = new Map<number, { prev: number; face: number }>();
  for (const [k, fi] of owner) {
    const [a, b] = k.split('>').map(Number);
    if (owner.has(`${b}>${a}`)) continue;
    if (!outIn.has(a)) outIn.set(a, { next: b, face: fi });
    if (!inTo.has(b)) inTo.set(b, { prev: a, face: fi });
  }
  const normals = new Map<number, V3>();
  for (const fi of faces) normals.set(fi, norm(faceNormal(m, m.faces[fi])));
  // The region's own normal, for Depth.
  let rn: V3 = [0, 0, 0];
  normals.forEach((n) => { rn = add(rn, n); });
  rn = len(rn) > 1e-9 ? norm(rn) : [0, 1, 0];
  // A new inner point for each outline point, moved in across both outline edges beside it.
  const inner = new Map<number, number>();
  for (const [v, o2] of outIn) {
    const i2 = inTo.get(v);
    if (!i2) continue;
    const p = m.verts[v].p;
    const inward = (from: V3, to: V3, n: V3) => norm(cross(n, sub(to, from)));
    const u1 = inward(m.verts[i2.prev].p, p, normals.get(i2.face)!), u2 = inward(p, m.verts[o2.next].p, normals.get(o2.face)!);
    let dir = add(u1, u2);
    if (len(dir) < 1e-9) dir = u1;
    dir = norm(dir);
    // Even: farther along the bisector at sharp corners, so the border keeps its width.
    const k = o.even ? Math.min(4, 1 / Math.max(0.25, dot(dir, u1))) : 1;
    inner.set(v, newVert(m, add(p, scale(dir, o.thickness * k)), v));
  }
  // The inner faces take the new points; a border face joins each outline edge to its inner copy.
  const mappers = new Map<number, (p: V3) => V2>();
  for (const fi of faces) mappers.set(fi, uvMapper(m, m.faces[fi]));
  const rims: Face[] = [];
  for (const [k, fi] of owner) {
    const [a, b] = k.split('>').map(Number);
    if (owner.has(`${b}>${a}`) || !inner.has(a) || !inner.has(b)) continue;
    const f = m.faces[fi];
    const vs = [a, b, inner.get(b)!, inner.get(a)!];
    const uv = mappers.get(fi)!;
    rims.push({ v: vs, uv: vs.map((v) => uv(m.verts[v].p)), g: f.g, s: f.s });
  }
  for (const fi of faces) {
    const f = m.faces[fi];
    const uv = mappers.get(fi)!;
    f.v = f.v.map((v) => inner.get(v) ?? v);
    f.uv = f.v.map((v) => uv(m.verts[v].p));
    f.seam = undefined; f.pin = undefined;
  }
  // Depth: the inner part moves along the region's normal.
  if (o.depth) {
    const moved = new Set<number>();
    for (const fi of faces) for (const v of m.faces[fi].v) moved.add(v);
    for (const v of moved) m.verts[v].p = add(m.verts[v].p, scale(rn, o.depth));
  }
  m.faces.push(...rims);
  return [...faces];
}
