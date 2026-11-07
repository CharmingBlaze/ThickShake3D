// Loop cuts and knife cuts. No UI or three.js here: the view passes in how to project points and which are visible.
import { cross, dist, dot, edgeFaces, edgeKey, faceNormal, lerp3, norm, sub, triangulate } from './geom';
import { blendWeights } from './ops';
import type { Face, Model, V2, V3 } from './types';

const lerpUV = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export interface CutResult { verts: number[]; edges: string[] }

/**
 * Add new vertices to edges, in every face using those edges, so no T-junctions appear.
 * `splits` maps an edge to its new vertices, each with t measured from the lower vertex id, sorted by t.
 * Seam marks carry over to both halves of an edge.
 */
function insertEdgeVerts(m: Model, splits: Map<string, { t: number; v: number }[]>, skip?: Set<number>) {
  if (!splits.size) return;
  m.faces.forEach((f, fi) => {
    if (skip?.has(fi)) return;
    const v: number[] = [], uv: V2[] = [], seam: boolean[] = [], pin: boolean[] = [];
    let changed = false;
    for (let i = 0; i < f.v.length; i++) {
      const j = (i + 1) % f.v.length;
      const s = f.seam?.[i] ?? false;
      v.push(f.v[i]); uv.push(f.uv[i]); seam.push(s); pin.push(f.pin?.[i] ?? false);
      const list = splits.get(edgeKey(f.v[i], f.v[j]));
      if (!list) continue;
      const forward = f.v[i] < f.v[j];
      for (const x of forward ? list : [...list].reverse()) {
        v.push(x.v); uv.push(lerpUV(f.uv[i], f.uv[j], forward ? x.t : 1 - x.t)); seam.push(s); pin.push(false);
      }
      changed = true;
    }
    if (!changed) return;
    f.v = v; f.uv = uv;
    if (f.seam) f.seam = seam;
    if (f.pin) f.pin = pin;
  });
}

// ---------- loop cut ----------
export interface LoopOptions {
  /** How many parallel loops. */
  cuts?: number;
  /** Slide from -1 (against the first side) through 0 (centred) to 1 (against the other side). */
  slide?: number;
  /** Keep the same distance from one side all the way round, rather than the same proportion. */
  even?: boolean;
  /** With even, measure from the other side. */
  flip?: boolean;
  /** Push new vertices outward to keep a curved surface round: 0 is flat, 1 fully rounded. */
  smooth?: number;
}

interface Rail { from: number; to: number }
interface LoopPlan { rails: Map<string, Rail>; quads: { fi: number; k: number }[]; start: string }

/** Walk the quad strip across an edge, giving every crossed edge a direction, so positions line up all the way round. */
function planLoop(m: Model, edge: string): LoopPlan {
  const ef = edgeFaces(m);
  const [lo, hi] = edge.split('_').map(Number);
  const rails = new Map<string, Rail>([[edge, { from: lo, to: hi }]]);
  const quads: { fi: number; k: number }[] = [];
  const used = new Set<number>();
  const queue = [edge];
  while (queue.length) {
    const e = queue.pop()!;
    const r = rails.get(e)!;
    for (const fi of ef.get(e) ?? []) {
      const f = m.faces[fi];
      if (f.v.length !== 4 || used.has(fi)) continue;
      const k = f.v.findIndex((v, i) => edgeKey(v, f.v[(i + 1) % 4]) === e);
      if (k < 0) continue;
      used.add(fi);
      quads.push({ fi, k });
      const a = f.v[k], c = f.v[(k + 2) % 4], d = f.v[(k + 3) % 4];
      const opp = edgeKey(c, d);
      if (!rails.has(opp)) { rails.set(opp, r.from === a ? { from: d, to: c } : { from: c, to: d }); queue.push(opp); }
    }
  }
  return { rails, quads, start: edge };
}

/** Where each cut sits along an edge of a given length. */
function railParams(o: LoopOptions, length: number, startLength: number): number[] {
  const n = Math.max(1, Math.round(o.cuts ?? 1)), s = o.slide ?? 0;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = (i + 1) / (n + 1);
    const t = s >= 0 ? t0 + s * (1 - t0) : t0 + s * t0;
    if (!o.even) { out.push(t); continue; }
    const d = (o.flip ? 1 - t : t) * startLength;
    const x = d / (length || 1);
    out.push(clamp(o.flip ? 1 - x : x, 0.001, 0.999));
  }
  return out;
}

const railPoint = (m: Model, r: Rail, t: number) => lerp3(m.verts[r.from].p, m.verts[r.to].p, t);

/** The lines a loop cut would make, as pairs of points, without changing anything. */
export function loopPreview(m: Model, edge: string, o: LoopOptions = {}): [V3, V3][] {
  const plan = planLoop(m, edge);
  const s0 = plan.rails.get(edge)!;
  const startLength = dist(m.verts[s0.from].p, m.verts[s0.to].p);
  const out: [V3, V3][] = [];
  for (const { fi, k } of plan.quads) {
    const f = m.faces[fi];
    const a = f.v[k], b = f.v[(k + 1) % 4], c = f.v[(k + 2) % 4], d = f.v[(k + 3) % 4];
    const top = plan.rails.get(edgeKey(a, b)), bot = plan.rails.get(edgeKey(c, d));
    if (!top || !bot) continue;
    const ta = railParams(o, dist(m.verts[a].p, m.verts[b].p), startLength);
    const tb = railParams(o, dist(m.verts[c].p, m.verts[d].p), startLength);
    ta.forEach((t, i) => out.push([railPoint(m, top, t), railPoint(m, bot, tb[i])]));
  }
  return out;
}

/** Vertex normals, for pushing cuts outward on curved surfaces. */
function vertexNormals(m: Model, wanted: Set<number>): Map<number, V3> {
  const sum = new Map<number, V3>();
  for (const f of m.faces) {
    if (!f.v.some((v) => wanted.has(v))) continue;
    const n = faceNormal(m, f);
    for (const v of f.v) {
      if (!wanted.has(v)) continue;
      const s = sum.get(v);
      if (s) { s[0] += n[0]; s[1] += n[1]; s[2] += n[2]; } else sum.set(v, [n[0], n[1], n[2]]);
    }
  }
  sum.forEach((n, v) => sum.set(v, norm(n)));
  return sum;
}

/** Cut one or more loops across the quad strip containing `edge`. Quads on the strip split; other faces gain the new vertices. */
export function loopCuts(m: Model, edge: string, o: LoopOptions = {}): CutResult {
  const plan = planLoop(m, edge);
  if (!plan.quads.length) return { verts: [], edges: [] };
  const s0 = plan.rails.get(edge)!;
  const startLength = dist(m.verts[s0.from].p, m.verts[s0.to].p);
  const smooth = o.smooth ?? 0;
  const ends = new Set<number>();
  if (smooth > 0) plan.rails.forEach((r) => { ends.add(r.from); ends.add(r.to); });
  const normals = smooth > 0 ? vertexNormals(m, ends) : null;

  const lists = new Map<string, { t: number; v: number }[]>();
  const made: number[] = [];
  plan.rails.forEach((r, key) => {
    const A = m.verts[r.from], B = m.verts[r.to];
    const list = railParams(o, dist(A.p, B.p), startLength).map((t) => {
      let p = lerp3(A.p, B.p, t);
      if (normals) {
        // Phong tessellation: flatten the point onto each end's tangent plane, then blend. Curved surfaces bulge, flat ones stay flat.
        const toPlane = (end: V3, n: V3): V3 => {
          const h = dot(sub(p, end), n);
          return [p[0] - n[0] * h, p[1] - n[1] * h, p[2] - n[2] * h];
        };
        const q = lerp3(toPlane(A.p, normals.get(r.from)!), toPlane(B.p, normals.get(r.to)!), t);
        p = lerp3(p, q, smooth);
      }
      const v = m.verts.length;
      m.verts.push({ p, w: blendWeights([A, B], [1 - t, t]) });
      made.push(v);
      return { t, v };
    });
    lists.set(key, list);
  });
  const along = (key: string, from: number) => {
    const r = plan.rails.get(key)!, l = lists.get(key)!;
    return r.from === from ? l : [...l].reverse().map((x) => ({ t: 1 - x.t, v: x.v }));
  };

  const edges: string[] = [];
  const created: Face[] = [];
  const remove = new Set<number>();
  for (const { fi, k } of plan.quads) {
    const f = m.faces[fi];
    const at = (n: number) => (k + n) % 4;
    const a = f.v[at(0)], b = f.v[at(1)], c = f.v[at(2)], d = f.v[at(3)];
    const keyTop = edgeKey(a, b), keyBot = edgeKey(c, d);
    if (!lists.has(keyTop) || !lists.has(keyBot)) continue;
    const ua = f.uv[at(0)], ub = f.uv[at(1)], uc = f.uv[at(2)], ud = f.uv[at(3)];
    const top = [{ v: a, uv: ua, pin: f.pin?.[at(0)] ?? false }, ...along(keyTop, a).map((x) => ({ v: x.v, uv: lerpUV(ua, ub, x.t), pin: false })), { v: b, uv: ub, pin: f.pin?.[at(1)] ?? false }];
    const bot = [{ v: d, uv: ud, pin: f.pin?.[at(3)] ?? false }, ...along(keyBot, d).map((x) => ({ v: x.v, uv: lerpUV(ud, uc, x.t), pin: false })), { v: c, uv: uc, pin: f.pin?.[at(2)] ?? false }];
    for (let i = 0; i + 1 < top.length; i++) {
      const piece: Face = { v: [top[i].v, top[i + 1].v, bot[i + 1].v, bot[i].v], uv: [top[i].uv, top[i + 1].uv, bot[i + 1].uv, bot[i].uv].map((u) => [u[0], u[1]] as V2), g: f.g, s: f.s };
      if (f.seam) piece.seam = [f.seam[at(0)] ?? false, i + 2 === top.length ? f.seam[at(1)] ?? false : false, f.seam[at(2)] ?? false, i === 0 ? f.seam[at(3)] ?? false : false];
      if (f.pin) piece.pin = [top[i].pin, top[i + 1].pin, bot[i + 1].pin, bot[i].pin];
      created.push(piece);
      if (i > 0) edges.push(edgeKey(top[i].v, bot[i].v));
    }
    remove.add(fi);
  }

  const splits = new Map<string, { t: number; v: number }[]>();
  lists.forEach((l, key) => {
    const r = plan.rails.get(key)!;
    const forward = r.from < r.to;
    splits.set(key, (forward ? l : l.map((x) => ({ t: 1 - x.t, v: x.v }))).slice().sort((p, q) => p.t - q.t));
  });
  insertEdgeVerts(m, splits, remove);
  m.faces = m.faces.filter((_, i) => !remove.has(i)).concat(created);
  return { verts: made, edges: [...new Set(edges)] };
}

/** A single loop at position t along `edge`. Returns the new vertices. */
export function loopCut(m: Model, edge: string, t = 0.5): number[] {
  return loopCuts(m, edge, { slide: 2 * t - 1 }).verts;
}

// ---------- knife ----------
export interface KnifeView {
  project(p: V3): { x: number; y: number };
  ray(x: number, y: number): { o: V3; d: V3 };
  /** Can this point on this face be seen? Left out, everything can. */
  visible?(p: V3, face: number): boolean;
}
export interface KnifeClick { id: number; p: V3 }
export interface KnifeSegment { a: KnifeClick; b: KnifeClick; view: KnifeView }
export interface KnifeOptions {
  /** Cut everything under the line, not just what can be seen. */
  through?: boolean;
  /** Only these faces. */
  faces?: Iterable<number>;
}

interface KnifeNode { key: string; p: V3; vert?: number; edge?: { lo: number; hi: number; t: number }; inner?: boolean }
export interface KnifePlan { nodes: Map<string, KnifeNode>; chords: Map<number, [string, string][]> }

type Pt = { x: number; y: number };

function inPoly(p: Pt, poly: Pt[]) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** How far along edge A-B the ray passes closest, or null if they run parallel. */
function rayEdgeT(A: V3, B: V3, o: V3, d: V3): number | null {
  const e = sub(B, A), w = sub(A, o);
  const a = dot(e, e), b = dot(e, d), c = dot(d, d), de = dot(e, w), f = dot(d, w);
  const den = a * c - b * b;
  return Math.abs(den) < 1e-14 ? null : (b * f - c * de) / den;
}

/** Work out which faces the knife lines cross, and where, without changing anything. */
export function planKnife(m: Model, segments: KnifeSegment[], opts: KnifeOptions = {}): KnifePlan {
  const nodes = new Map<string, KnifeNode>();
  const chords = new Map<number, [string, string][]>();
  const list = opts.faces ? [...opts.faces] : m.faces.map((_, i) => i);
  const projected = new Map<KnifeView, Map<number, Pt>>();
  const projOf = (view: KnifeView, v: number) => {
    let c = projected.get(view);
    if (!c) projected.set(view, (c = new Map()));
    let s = c.get(v);
    if (!s) c.set(v, (s = view.project(m.verts[v].p)));
    return s;
  };
  const vertNode = (v: number): KnifeNode => ({ key: `v${v}`, p: m.verts[v].p, vert: v });

  for (const seg of segments) {
    const A = seg.view.project(seg.a.p), B = seg.view.project(seg.b.p);
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) continue;
    const es = 0.5 / len;
    const x0 = Math.min(A.x, B.x) - 1, x1 = Math.max(A.x, B.x) + 1, y0 = Math.min(A.y, B.y) - 1, y1 = Math.max(A.y, B.y) + 1;

    for (const fi of list) {
      const f = m.faces[fi];
      const pts = f.v.map((v) => projOf(seg.view, v));
      if (pts.every((p) => p.x < x0) || pts.every((p) => p.x > x1) || pts.every((p) => p.y < y0) || pts.every((p) => p.y > y1)) continue;

      // Where this line meets the face's outline. Sides remember which outline edges a point is on.
      const hits: { s: number; node: KnifeNode; sides: number[] }[] = [];
      const addHit = (s: number, node: KnifeNode, sides: number[]) => {
        const old = hits.find((h) => h.node.key === node.key);
        if (old) { old.sides = [...new Set([...old.sides, ...sides])]; return; }
        hits.push({ s: clamp(s, 0, 1), node, sides });
      };
      const n = f.v.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const P = pts[i], Q = pts[j];
        const ex = Q.x - P.x, ey = Q.y - P.y;
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const s = ((P.x - A.x) * ey - (P.y - A.y) * ex) / den;
        const u = ((P.x - A.x) * dy - (P.y - A.y) * dx) / den;
        const eu = 0.5 / (Math.hypot(ex, ey) || 1);
        if (s < -es || s > 1 + es || u < -eu || u > 1 + eu) continue;
        if (u <= eu) { addHit(s, vertNode(f.v[i]), [i, (i + n - 1) % n]); continue; }
        if (u >= 1 - eu) { addHit(s, vertNode(f.v[j]), [i, j]); continue; }
        const r = seg.view.ray(A.x + dx * s, A.y + dy * s);
        const pa = f.v[i], pb = f.v[j];
        const lo = Math.min(pa, pb), hi = Math.max(pa, pb);
        const t = clamp(rayEdgeT(m.verts[lo].p, m.verts[hi].p, r.o, r.d) ?? (pa < pb ? u : 1 - u), 0, 1);
        if (t < 1e-3) { addHit(s, vertNode(lo), lo === f.v[i] ? [i, (i + n - 1) % n] : [i, j]); continue; }
        if (t > 1 - 1e-3) { addHit(s, vertNode(hi), hi === f.v[i] ? [i, (i + n - 1) % n] : [i, j]); continue; }
        const rounded = Math.round(t * 1e4) / 1e4;
        addHit(s, { key: `e${lo}_${hi}@${rounded}`, p: lerp3(m.verts[lo].p, m.verts[hi].p, rounded), edge: { lo, hi, t: rounded } }, [i]);
      }

      // Ends of the line that land inside this face.
      const normal = faceNormal(m, f);
      for (const [click, s, pt] of [[seg.a, 0, A], [seg.b, 1, B]] as [KnifeClick, number, Pt][]) {
        if (hits.some((h) => Math.abs(h.s - s) <= es * 2) || !inPoly(pt, pts)) continue;
        const r = seg.view.ray(pt.x, pt.y);
        const den = dot(normal, r.d);
        if (Math.abs(den) < 1e-9) continue;
        const h = dot(normal, sub(m.verts[f.v[0]].p, r.o)) / den;
        hits.push({ s, sides: [], node: { key: `c${click.id}@${fi}`, p: [r.o[0] + r.d[0] * h, r.o[1] + r.d[1] * h, r.o[2] + r.d[2] * h], inner: true } });
      }
      hits.sort((p, q) => p.s - q.s);

      // Seen exactly edge-on, as in the side views, a face is a line on screen. Cutting through still has to split it.
      const screenArea = Math.abs(pts.reduce((sum, p, i) => { const q = pts[(i + 1) % n]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
      const edgeOn = !!opts.through && screenArea < 1;

      for (let i = 0; i + 1 < hits.length; i++) {
        const h0 = hits[i], h1 = hits[i + 1];
        if (h0.sides.some((x) => h1.sides.includes(x))) continue; // Running along an edge that already exists.
        const mid = (h0.s + h1.s) / 2;
        if (!edgeOn && !inPoly({ x: A.x + dx * mid, y: A.y + dy * mid }, pts)) continue;
        if (dist(h0.node.p, h1.node.p) < 1e-7) continue;
        if (!opts.through && seg.view.visible && ![0.25, 0.5, 0.75].some((k) => seg.view.visible!(lerp3(h0.node.p, h1.node.p, k), fi))) continue;
        nodes.set(h0.node.key, h0.node);
        nodes.set(h1.node.key, h1.node);
        let l = chords.get(fi);
        if (!l) chords.set(fi, (l = []));
        l.push([h0.node.key, h1.node.key]);
      }
    }
  }
  return { nodes, chords };
}

interface GNode { x: number; y: number; p: V3; vert?: number }

/** Split a face along chords, by tracing the regions of the planar graph they make with its outline. */
function splitFace(m: Model, fi: number, chords: [string, string][], plan: KnifePlan, vertOf: Map<string, number>, out: CutResult) {
  const f = m.faces[fi];
  const ringP = f.v.map((v) => m.verts[v].p);
  const n = faceNormal(m, f);
  const ref: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const bu = norm(cross(ref, n)), bv = cross(n, bu);
  const to2 = (p: V3) => ({ x: dot(p, bu), y: dot(p, bv) });

  const nodes: GNode[] = f.v.map((v, i) => ({ ...to2(ringP[i]), p: ringP[i], vert: v }));
  const ring2 = nodes.map((x) => ({ x: x.x, y: x.y }));
  const ringOf = new Map(f.v.map((v, i) => [v, i]));
  const idOf = new Map<string, number>();
  const nodeId = (key: string): number | null => {
    const known = idOf.get(key);
    if (known !== undefined) return known;
    const nd = plan.nodes.get(key)!;
    const v = vertOf.get(key);
    let id: number;
    if (v !== undefined) {
      const at = ringOf.get(v);
      if (at === undefined) return null;
      id = at;
    } else {
      id = nodes.length;
      nodes.push({ ...to2(nd.p), p: nd.p });
    }
    idOf.set(key, id);
    return id;
  };

  const adj = new Map<number, Set<number>>();
  const addEdge = (a: number, b: number) => {
    if (a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  const dropEdge = (a: number, b: number) => { adj.get(a)?.delete(b); adj.get(b)?.delete(a); };
  const allEdges = () => {
    const l: [number, number][] = [];
    adj.forEach((s, a) => s.forEach((b) => { if (a < b) l.push([a, b]); }));
    return l;
  };
  const ringCount = f.v.length;
  for (let i = 0; i < ringCount; i++) addEdge(i, (i + 1) % ringCount);
  const isRing = (a: number, b: number) => a < ringCount && b < ringCount && ((a + 1) % ringCount === b || (b + 1) % ringCount === a);

  // Chords, split wherever two of them cross.
  let pieces: [number, number][] = [];
  for (const [ka, kb] of chords) {
    const a = nodeId(ka), b = nodeId(kb);
    if (a !== null && b !== null && a !== b && !isRing(a, b)) pieces.push([a, b]);
  }
  const crossAt = (a: number, b: number, c: number, d: number) => {
    const A = nodes[a], B = nodes[b], C = nodes[c], D = nodes[d];
    const den = (B.x - A.x) * (D.y - C.y) - (B.y - A.y) * (D.x - C.x);
    if (Math.abs(den) < 1e-12) return null;
    const s = ((C.x - A.x) * (D.y - C.y) - (C.y - A.y) * (D.x - C.x)) / den;
    const t = ((C.x - A.x) * (B.y - A.y) - (C.y - A.y) * (B.x - A.x)) / den;
    return s > 1e-6 && s < 1 - 1e-6 && t > 1e-6 && t < 1 - 1e-6 ? s : null;
  };
  for (let restart = true, guard = 0; restart && guard < 256; guard++) {
    restart = false;
    outer: for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const [a, b] = pieces[i], [c, d] = pieces[j];
        if (a === c || a === d || b === c || b === d) continue;
        const s = crossAt(a, b, c, d);
        if (s === null) continue;
        const p = lerp3(nodes[a].p, nodes[b].p, s);
        const id = nodes.length;
        nodes.push({ ...to2(p), p });
        pieces = pieces.filter((_, k) => k !== i && k !== j).concat([[a, id], [id, b], [c, id], [id, d]]);
        restart = true;
        break outer;
      }
    }
  }
  pieces.forEach(([a, b]) => addEdge(a, b));

  // A line from a to b is clear if it's inside the face and touches no other line.
  const clear = (a: number, b: number) => {
    const A = nodes[a], B = nodes[b];
    if (!inPoly({ x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }, ring2)) return false;
    return !allEdges().some(([c, d]) => c !== a && c !== b && d !== a && d !== b && crossAt(a, b, c, d) !== null);
  };
  const gap = (a: number, b: number) => Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
  const live = () => nodes.map((_, i) => i).filter((i) => (adj.get(i)?.size ?? 0) > 0);

  // A cut that stops inside a face runs on to the nearest corner, so every face stays a simple outline.
  for (let guard = 0; guard < 512; guard++) {
    const end = live().find((i) => i >= ringCount && adj.get(i)!.size === 1);
    if (end === undefined) break;
    const near = adj.get(end)!;
    const to = live().filter((i) => i !== end && !near.has(i)).sort((a, b) => gap(end, a) - gap(end, b)).find((i) => clear(end, i));
    if (to === undefined) { [...near].forEach((x) => dropEdge(end, x)); continue; }
    addEdge(end, to);
  }

  // A closed cut floating inside a face joins the outline by two bridges, again so no face has a hole.
  for (let guard = 0; guard < 64; guard++) {
    const reached = new Set<number>([0]);
    const stack = [0];
    while (stack.length) for (const x of adj.get(stack.pop()!) ?? []) if (!reached.has(x)) { reached.add(x); stack.push(x); }
    const island = live().filter((i) => !reached.has(i));
    if (!island.length) break;
    const pairs: [number, number][] = [];
    for (const a of island) for (const b of reached) pairs.push([a, b]);
    pairs.sort((p, q) => gap(...p) - gap(...q));
    const first = pairs.find(([a, b]) => clear(a, b));
    if (first) {
      addEdge(...first);
      const second = pairs.find(([a, b]) => a !== first[0] && b !== first[1] && clear(a, b));
      if (second) { addEdge(...second); continue; }
      dropEdge(...first);
    }
    island.forEach((a) => [...(adj.get(a) ?? [])].forEach((b) => dropEdge(a, b)));
  }
  if (!allEdges().some(([a, b]) => !isRing(a, b))) return;

  // Trace the regions.
  const sorted = new Map<number, number[]>();
  adj.forEach((s, a) => sorted.set(a, [...s].sort((p, q) => Math.atan2(nodes[p].y - nodes[a].y, nodes[p].x - nodes[a].x) - Math.atan2(nodes[q].y - nodes[a].y, nodes[q].x - nodes[a].x))));
  const area2 = (l: { x: number; y: number }[]) => l.reduce((s, p, i) => { const q = l[(i + 1) % l.length]; return s + p.x * q.y - q.x * p.y; }, 0);
  const seen = new Set<string>();
  const regions: number[][] = [];
  for (const [a, list] of sorted) {
    for (const b of list) {
      if (seen.has(`${a}>${b}`)) continue;
      const loop: number[] = [];
      let u = a, v = b;
      for (let guard = 0; guard < nodes.length * 4 + 8; guard++) {
        if (seen.has(`${u}>${v}`)) break;
        seen.add(`${u}>${v}`);
        loop.push(u);
        const around = sorted.get(v)!;
        const next = around[(around.indexOf(u) + around.length - 1) % around.length];
        u = v; v = next;
      }
      if (area2(loop.map((i) => nodes[i])) > 1e-12) regions.push(loop);
    }
  }
  // Anything unexpected leaves the face whole, rather than damaging the mesh.
  const whole = area2(ring2);
  const sum = regions.reduce((s, l) => s + area2(l.map((i) => nodes[i])), 0);
  if (regions.length < 2 || Math.abs(sum - whole) > Math.abs(whole) * 0.01 || regions.some((l) => new Set(l).size !== l.length)) return;

  // New vertices take their UVs and weights from where they sit in the original face.
  const tris = triangulate(ringP);
  const blendAt = (q: { x: number; y: number }) => {
    let best: { c: number[]; b: number[] } | null = null;
    let worst = -Infinity;
    for (let i = 0; i < tris.length; i += 3) {
      const [i0, i1, i2] = [tris[i], tris[i + 1], tris[i + 2]];
      const P0 = ring2[i0], P1 = ring2[i1], P2 = ring2[i2];
      const den = (P1.y - P2.y) * (P0.x - P2.x) + (P2.x - P1.x) * (P0.y - P2.y);
      if (Math.abs(den) < 1e-14) continue;
      const b0 = ((P1.y - P2.y) * (q.x - P2.x) + (P2.x - P1.x) * (q.y - P2.y)) / den;
      const b1 = ((P2.y - P0.y) * (q.x - P2.x) + (P0.x - P2.x) * (q.y - P2.y)) / den;
      const b2 = 1 - b0 - b1;
      const low = Math.min(b0, b1, b2);
      if (low > worst) { worst = low; best = { c: [i0, i1, i2], b: [b0, b1, b2] }; }
    }
    return best ?? { c: [0], b: [1] };
  };
  const uvOf = new Map<number, V2>(f.v.map((_, i) => [i, f.uv[i]]));
  const pinOf = new Map<number, boolean>(f.v.map((_, i) => [i, f.pin?.[i] ?? false]));
  const usedNodes = new Set(regions.flat());
  usedNodes.forEach((id) => {
    if (id < ringCount) return;
    const nd = nodes[id];
    const mix = blendAt(nd);
    nd.vert = m.verts.length;
    m.verts.push({ p: nd.p, w: blendWeights(mix.c.map((i) => m.verts[f.v[i]]), mix.b) });
    out.verts.push(nd.vert);
    uvOf.set(id, mix.c.reduce<V2>((s, i, k) => [s[0] + f.uv[i][0] * mix.b[k], s[1] + f.uv[i][1] * mix.b[k]], [0, 0]));
    pinOf.set(id, false);
  });

  const seamOf = (a: number, b: number) => a < ringCount && b < ringCount && (a + 1) % ringCount === b && (f.seam?.[a] ?? false);
  const faces: Face[] = regions.map((l) => {
    const face: Face = { v: l.map((i) => nodes[i].vert!), uv: l.map((i) => { const u = uvOf.get(i)!; return [u[0], u[1]] as V2; }), g: f.g, s: f.s };
    if (f.seam) face.seam = l.map((a, i) => seamOf(a, l[(i + 1) % l.length]));
    if (f.pin) face.pin = l.map((a) => pinOf.get(a)!);
    return face;
  });
  m.faces[fi] = faces[0];
  m.faces.push(...faces.slice(1));
  allEdges().forEach(([a, b]) => {
    if (!isRing(a, b) && nodes[a].vert !== undefined && nodes[b].vert !== undefined) out.edges.push(edgeKey(nodes[a].vert!, nodes[b].vert!));
  });
}

/** Carry out a plan. Edge crossings are shared with neighbouring faces, so the mesh stays sealed. */
export function applyKnife(m: Model, plan: KnifePlan): CutResult {
  const out: CutResult = { verts: [], edges: [] };
  const vertOf = new Map<string, number>();
  const splits = new Map<string, { t: number; v: number }[]>();
  plan.nodes.forEach((nd, key) => {
    if (nd.vert !== undefined) { vertOf.set(key, nd.vert); return; }
    if (!nd.edge) return;
    const { lo, hi, t } = nd.edge;
    const v = m.verts.length;
    m.verts.push({ p: nd.p, w: blendWeights([m.verts[lo], m.verts[hi]], [1 - t, t]) });
    vertOf.set(key, v);
    out.verts.push(v);
    const k = edgeKey(lo, hi);
    const l = splits.get(k);
    if (l) l.push({ t, v }); else splits.set(k, [{ t, v }]);
  });
  splits.forEach((l) => l.sort((a, b) => a.t - b.t));
  insertEdgeVerts(m, splits);
  plan.chords.forEach((chords, fi) => splitFace(m, fi, chords, plan, vertOf, out));
  return out;
}

export function knifeCut(m: Model, segments: KnifeSegment[], opts: KnifeOptions = {}): CutResult {
  return applyKnife(m, planKnife(m, segments, opts));
}
