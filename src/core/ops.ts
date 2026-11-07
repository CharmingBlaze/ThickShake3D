// Mesh editing operations. Each function mutates the model in place; the Editor
// wraps calls in undo transactions.
import {
  add, bounds, cross, dist, dot, edgeFaces, edgeKey, faceCenter, faceNormal, lerp3, len, mul, norm, parseEdge,
  signedVolume, sub, triangulateFace,
} from './geom';
import type { Prim } from './primitives';
import { type Face, type Model, type V2, type V3, type Vertex, makeGroup, newId, uniqueName } from './types';

const lerpUV = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** Blend skin weights, keep the strongest 4, renormalise. */
export function blendWeights(sources: (Vertex | undefined)[], factors?: number[]): [number, number][] | undefined {
  const acc = new Map<number, number>();
  sources.forEach((s, i) => s?.w?.forEach(([b, w]) => acc.set(b, (acc.get(b) ?? 0) + w * (factors ? factors[i] : 1))));
  if (!acc.size) return undefined;
  const list = [...acc.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const total = list.reduce((s, x) => s + x[1], 0) || 1;
  return list.map(([b, w]) => [b, w / total]);
}

// ---------- creation ----------

/** Append a primitive as a new group, optionally transformed. Returns new face indices. */
export function addPrim(m: Model, prim: Prim, name: string, opts: {
  material?: number | null; center?: V3; scale?: V3; groupId?: number;
} = {}): { groupId: number; faces: number[]; verts: number[] } {
  const c = opts.center ?? [0, 0, 0], s = opts.scale ?? [1, 1, 1];
  const base = m.verts.length;
  const groupId = opts.groupId ?? makeGroup(m, uniqueName(m.groups.map((g) => g.name), name), opts.material ?? null).id;
  const smoothId = prim.smooth ? nextSmooth(m) : 0;
  const newVerts: number[] = [];
  for (const p of prim.verts) {
    newVerts.push(m.verts.length);
    m.verts.push({ p: [p[0] * s[0] + c[0], p[1] * s[1] + c[1], p[2] * s[2] + c[2]] });
  }
  const newFaces: number[] = [];
  for (const f of prim.faces) {
    newFaces.push(m.faces.length);
    m.faces.push({ v: f.v.map((i) => i + base), uv: f.uv.map((u) => [u[0], u[1]]), g: groupId, s: smoothId });
  }
  return { groupId, faces: newFaces, verts: newVerts };
}

export function nextSmooth(m: Model): number {
  let hi = 0;
  for (const f of m.faces) if (f.s > hi) hi = f.s;
  return hi + 1;
}

/** Build a face from an unordered vertex set, sorting them around their centroid. */
export function makeFace(m: Model, verts: number[], groupId: number): number | null {
  if (verts.length < 3) return null;
  const pts = verts.map((i) => m.verts[i].p);
  const c = bounds(pts).center;
  // Plane normal from the widest vertex triple.
  let n: V3 = [0, 0, 0], best = 0;
  for (let i = 1; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const k = cross(sub(pts[i], pts[0]), sub(pts[j], pts[0]));
    if (len(k) > best) { best = len(k); n = k; }
  }
  if (best < 1e-12) return null;
  n = norm(n);
  const ref = Math.abs(n[1]) < 0.9 ? ([0, 1, 0] as V3) : ([1, 0, 0] as V3);
  const u = norm(cross(ref, n)), v = cross(n, u);
  const order = verts
    .map((i, k) => ({ i, a: Math.atan2(dot(sub(pts[k], c), v), dot(sub(pts[k], c), u)) }))
    .sort((a, b) => a.a - b.a)
    .map((x) => x.i);
  m.faces.push({ v: order, uv: planarUV(m, order, n), g: groupId, s: 0 });
  return m.faces.length - 1;
}

function planarUV(m: Model, vs: number[], n: V3): V2[] {
  const ref = Math.abs(n[1]) < 0.9 ? ([0, 1, 0] as V3) : ([1, 0, 0] as V3);
  const u = norm(cross(ref, n)), v = cross(n, u);
  return vs.map((i) => [dot(m.verts[i].p, u), dot(m.verts[i].p, v)]);
}

// ---------- deletion ----------

export function removeFaces(m: Model, faces: Set<number>, dropLoose = true) {
  const before = new Set<number>();
  faces.forEach((fi) => m.faces[fi]?.v.forEach((v) => before.add(v)));
  m.faces = m.faces.filter((_, i) => !faces.has(i));
  if (dropLoose) {
    const used = new Set<number>();
    for (const f of m.faces) for (const v of f.v) used.add(v);
    const orphan = new Set([...before].filter((v) => !used.has(v)));
    if (orphan.size) removeVertsRaw(m, orphan);
  }
}

/** Remove verts and every face touching them. */
export function removeVerts(m: Model, verts: Set<number>) {
  m.faces = m.faces.filter((f) => !f.v.some((v) => verts.has(v)));
  removeVertsRaw(m, verts);
}

function removeVertsRaw(m: Model, verts: Set<number>) {
  const remap = new Int32Array(m.verts.length).fill(-1);
  const kept: Vertex[] = [];
  m.verts.forEach((v, i) => { if (!verts.has(i)) { remap[i] = kept.length; kept.push(v); } });
  m.verts = kept;
  for (const f of m.faces) f.v = f.v.map((v) => remap[v]);
}

/** Drop vertices no face uses. Returns how many were removed. */
export function removeLoose(m: Model): number {
  const used = new Set<number>();
  for (const f of m.faces) for (const v of f.v) used.add(v);
  const loose = new Set<number>();
  m.verts.forEach((_, i) => { if (!used.has(i)) loose.add(i); });
  if (loose.size) removeVertsRaw(m, loose);
  return loose.size;
}

/** Remove faces with repeated corners or near-zero area. Returns how many were removed. */
export function removeDegenerate(m: Model, areaEps = 1e-10): number {
  const bad = new Set<number>();
  m.faces.forEach((f, i) => { if (isDegenerate(m, f, areaEps)) bad.add(i); });
  if (bad.size) removeFaces(m, bad, false);
  return bad.size;
}

export function isDegenerate(m: Model, f: Face, areaEps = 1e-10): boolean {
  if (new Set(f.v).size < 3) return true;
  const tris = triangulateFace(m, f);
  let area = 0;
  for (let t = 0; t < tris.length; t += 3) {
    const a = m.verts[f.v[tris[t]]].p, b = m.verts[f.v[tris[t + 1]]].p, c = m.verts[f.v[tris[t + 2]]].p;
    area += len(cross(sub(b, a), sub(c, a))) / 2;
  }
  return area < areaEps;
}

/** Drop groups with no faces (primary meshes only keep if explicitly named active). */
export function pruneEmptyGroups(m: Model) {
  const used = new Set(m.faces.map((f) => f.g));
  m.groups = m.groups.filter((g) => used.has(g.id));
}

// ---------- weld ----------

/** Merge verts in `verts` closer than `threshold`. Returns count removed. */
export function weld(m: Model, verts: Set<number>, threshold: number): number {
  const list = [...verts];
  const cell = Math.max(threshold, 1e-6);
  const grid = new Map<string, number[]>();
  const target = new Map<number, number>();
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (const i of list) {
    const p = m.verts[i].p;
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    let found = -1;
    search:
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(key(cx + dx, cy + dy, cz + dz));
      if (!bucket) continue;
      for (const j of bucket) if (dist(m.verts[j].p, p) <= threshold) { found = j; break search; }
    }
    if (found >= 0) target.set(i, found);
    else {
      const k = key(cx, cy, cz);
      const b = grid.get(k);
      if (b) b.push(i); else grid.set(k, [i]);
    }
  }
  return applyMerge(m, target);
}

/** Collapse a set of vertices to a single point at their centroid. */
export function collapse(m: Model, verts: Set<number>) {
  const list = [...verts];
  if (list.length < 2) return 0;
  const c = bounds(list.map((i) => m.verts[i].p)).center;
  const keep = list[0];
  m.verts[keep].p = c;
  m.verts[keep].w = blendWeights(list.map((i) => m.verts[i]));
  const target = new Map<number, number>();
  for (const i of list.slice(1)) target.set(i, keep);
  return applyMerge(m, target);
}

function applyMerge(m: Model, target: Map<number, number>): number {
  if (!target.size) return 0;
  for (const f of m.faces) {
    const v: number[] = [], uv: V2[] = [], seam: boolean[] = [], pin: boolean[] = [];
    for (let i = 0; i < f.v.length; i++) {
      const nv = target.get(f.v[i]) ?? f.v[i];
      // A corner merged into the one before: the edge leaving it now leaves the kept corner.
      if (v.length && v[v.length - 1] === nv) { seam[seam.length - 1] = f.seam?.[i] ?? false; pin[pin.length - 1] ||= f.pin?.[i] ?? false; continue; }
      v.push(nv); uv.push(f.uv[i]); seam.push(f.seam?.[i] ?? false); pin.push(f.pin?.[i] ?? false);
    }
    if (v.length > 1 && v[0] === v[v.length - 1]) { v.pop(); uv.pop(); seam.pop(); pin[0] ||= pin.pop()!; }
    f.v = v; f.uv = uv;
    if (f.seam) f.seam = seam;
    if (f.pin) f.pin = pin;
  }
  m.faces = m.faces.filter((f) => new Set(f.v).size >= 3);
  removeVertsRaw(m, new Set(target.keys()));
  return target.size;
}

/** A fresh copy of a UV. Corners never share one array, since UV tools edit them in place. */
const cuv = (u: V2): V2 => [u[0], u[1]];
/** Whether the directed edge a→b of a face is marked as a UV seam. */
function edgeSeam(f: Face, a: number, b: number): boolean {
  const i = f.v.indexOf(a);
  return i >= 0 && f.v[(i + 1) % f.v.length] === b && !!f.seam?.[i];
}
function cornerPin(f: Face, v: number): boolean {
  const i = f.v.indexOf(v);
  return i >= 0 && !!f.pin?.[i];
}

// ---------- normals ----------

export function flipFaces(m: Model, faces: Iterable<number>) {
  for (const fi of faces) { const f = m.faces[fi]; f.v.reverse(); f.uv.reverse(); }
}

/** Make winding consistent over each connected island and point it outward. */
export function fixNormals(m: Model, faces: Set<number>): number {
  const ef = edgeFaces(m);
  const seen = new Set<number>();
  let flipped = 0;
  for (const start of faces) {
    if (seen.has(start)) continue;
    const island: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const fi = stack.pop()!;
      island.push(fi);
      const f = m.faces[fi];
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i], b = f.v[(i + 1) % f.v.length];
        for (const nb of ef.get(edgeKey(a, b)) ?? []) {
          if (nb === fi || seen.has(nb) || !faces.has(nb)) continue;
          const g = m.faces[nb];
          // Consistent neighbours traverse the shared edge in opposite directions.
          let same = false;
          for (let k = 0; k < g.v.length; k++) if (g.v[k] === a && g.v[(k + 1) % g.v.length] === b) same = true;
          if (same) { g.v.reverse(); g.uv.reverse(); flipped++; }
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    if (signedVolumeAroundCenter(m, island) < 0) { flipFaces(m, island); flipped += island.length; }
  }
  return flipped;
}

function signedVolumeAroundCenter(m: Model, island: number[]): number {
  // Translate to the island's centroid so open shells still orient sensibly.
  const c = bounds(island.flatMap((fi) => m.faces[fi].v.map((v) => m.verts[v].p))).center;
  let vol = 0;
  for (const fi of island) {
    const f = m.faces[fi];
    const tris = triangulateFace(m, f);
    for (let t = 0; t < tris.length; t += 3) {
      const a = sub(m.verts[f.v[tris[t]]].p, c), b = sub(m.verts[f.v[tris[t + 1]]].p, c), d = sub(m.verts[f.v[tris[t + 2]]].p, c);
      vol += dot(a, cross(b, d));
    }
  }
  return vol;
}

/** Flood-fill smoothing groups: faces within `angleDeg` across a shared edge blend. */
export function autoSmooth(m: Model, faces: Set<number>, angleDeg: number) {
  const cosT = Math.cos((angleDeg * Math.PI) / 180);
  const ef = edgeFaces(m);
  const normals = new Map<number, V3>();
  faces.forEach((fi) => normals.set(fi, faceNormal(m, m.faces[fi])));
  let sid = nextSmooth(m);
  const seen = new Set<number>();
  for (const start of faces) {
    if (seen.has(start)) continue;
    const id = sid++;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const fi = stack.pop()!;
      const f = m.faces[fi];
      f.s = id;
      for (let i = 0; i < f.v.length; i++) {
        for (const nb of ef.get(edgeKey(f.v[i], f.v[(i + 1) % f.v.length])) ?? []) {
          if (seen.has(nb) || !faces.has(nb)) continue;
          if (dot(normals.get(fi)!, normals.get(nb)!) >= cosT) { seen.add(nb); stack.push(nb); }
        }
      }
    }
  }
}

// ---------- extrude / inset ----------

/** Extrude a face region. Returns the newly created top vertices. */
export function extrudeFaces(m: Model, faces: Set<number>): { top: number[]; normal: V3; vertexNormals: Map<number, V3> } {
  const inRegion = new Set<string>();
  faces.forEach((fi) => {
    const f = m.faces[fi];
    for (let i = 0; i < f.v.length; i++) inRegion.add(`${f.v[i]}>${f.v[(i + 1) % f.v.length]}`);
  });
  // Boundary = directed edge with no opposite inside the region.
  // Only vertices on the boundary or shared with faces outside the region need a copy;
  // the rest move with the region, so duplicating them would leave the originals loose.
  const mustCopy = new Set<number>();
  m.faces.forEach((f, fi) => {
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      if (!faces.has(fi)) mustCopy.add(a);
      else if (!inRegion.has(`${b}>${a}`)) { mustCopy.add(a); mustCopy.add(b); }
    }
  });
  const dupe = new Map<number, number>();
  const dup = (v: number) => {
    let n = dupe.get(v);
    if (n === undefined && !mustCopy.has(v)) { dupe.set(v, v); return v; }
    if (n === undefined) {
      n = m.verts.length;
      const src = m.verts[v];
      m.verts.push({ p: [...src.p] as V3, w: src.w?.map((x) => [x[0], x[1]]) });
      dupe.set(v, n);
    }
    return n;
  };
  const sides: Face[] = [];
  let avg: V3 = [0, 0, 0];
  const accum = new Map<number, V3>();
  faces.forEach((fi) => {
    const f = m.faces[fi];
    const fn = faceNormal(m, f);
    avg = add(avg, fn);
    const oldV = f.v.slice();
    for (let i = 0; i < oldV.length; i++) {
      const a = oldV[i], b = oldV[(i + 1) % oldV.length];
      if (!inRegion.has(`${b}>${a}`)) {
        const ua = f.uv[i], ub = f.uv[(i + 1) % oldV.length];
        sides.push({ v: [a, b, dup(b), dup(a)], uv: [ua, ub, ub, ua].map((u) => [u[0], u[1]]) as V2[], g: f.g, s: 0 });
      }
    }
    f.v = oldV.map((v) => { const n = dup(v); accum.set(n, add(accum.get(n) ?? [0, 0, 0], fn)); return n; });
  });
  m.faces.push(...sides);
  const vertexNormals = new Map<number, V3>();
  accum.forEach((v, k) => vertexNormals.set(k, norm(v)));
  return { top: [...dupe.values()], normal: norm(avg), vertexNormals };
}

/** Per-face inset. Returns inner face indices (the originals, repointed). */
export function insetFaces(m: Model, faces: Set<number>, amount: number) {
  const created: Face[] = [];
  faces.forEach((fi) => {
    const f = m.faces[fi];
    const c = faceCenter(m, f);
    const cu: V2 = [0, 0];
    f.uv.forEach((u) => { cu[0] += u[0] / f.uv.length; cu[1] += u[1] / f.uv.length; });
    const inner: number[] = [], innerUV: V2[] = [];
    f.v.forEach((v, i) => {
      const src = m.verts[v];
      inner.push(m.verts.length);
      m.verts.push({ p: lerp3(src.p, c, amount), w: src.w?.map((x) => [x[0], x[1]]) });
      innerUV.push(lerpUV(f.uv[i], cu, amount));
    });
    const n = f.v.length;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const rim: Face = { v: [f.v[i], f.v[j], inner[j], inner[i]], uv: [cuv(f.uv[i]), cuv(f.uv[j]), cuv(innerUV[j]), cuv(innerUV[i])], g: f.g, s: f.s };
      // The outer edge keeps its seam and the outer corners their pins; the new edges have neither.
      if (f.seam) rim.seam = [f.seam[i] ?? false, false, false, false];
      if (f.pin) rim.pin = [f.pin[i] ?? false, f.pin[j] ?? false, false, false];
      created.push(rim);
    }
    f.v = inner; f.uv = innerUV;
    if (f.seam) f.seam = inner.map(() => false);
    if (f.pin) f.pin = inner.map(() => false);
  });
  m.faces.push(...created);
}

// ---------- subdivide ----------

/** Catmull-Clark (smooth) or linear subdivision of the given faces. */
export function subdivide(m: Model, faces: Set<number>, smooth: boolean) {
  const all = faces.size === m.faces.length;
  const ef = edgeFaces(m);
  const facePoint = new Map<number, number>();
  const edgePoint = new Map<string, number>();
  const orig = m.verts.map((v) => [...v.p] as V3);

  faces.forEach((fi) => {
    const f = m.faces[fi];
    facePoint.set(fi, m.verts.length);
    m.verts.push({ p: faceCenter(m, f), w: blendWeights(f.v.map((v) => m.verts[v])) });
  });

  const edgeKeysIn = new Set<string>();
  faces.forEach((fi) => {
    const f = m.faces[fi];
    for (let i = 0; i < f.v.length; i++) edgeKeysIn.add(edgeKey(f.v[i], f.v[(i + 1) % f.v.length]));
  });
  for (const k of edgeKeysIn) {
    const [a, b] = parseEdge(k);
    let p = lerp3(orig[a], orig[b], 0.5);
    const adj = (ef.get(k) ?? []).filter((x) => faces.has(x));
    if (smooth && adj.length === 2 && (ef.get(k) ?? []).length === 2) {
      const c1 = m.verts[facePoint.get(adj[0])!].p, c2 = m.verts[facePoint.get(adj[1])!].p;
      p = mul(add(add(orig[a], orig[b]), add(c1, c2)), 0.25);
    }
    edgePoint.set(k, m.verts.length);
    m.verts.push({ p, w: blendWeights([m.verts[a], m.verts[b]]) });
  }

  // A partial selection also splits neighbouring faces' shared edges so no T-junctions remain.
  m.faces.forEach((f, fi) => {
    if (faces.has(fi)) return;
    const v: number[] = [], uv: V2[] = [], seam: boolean[] = [], pin: boolean[] = [];
    for (let i = 0; i < f.v.length; i++) {
      const j = (i + 1) % f.v.length;
      const s = f.seam?.[i] ?? false;
      v.push(f.v[i]); uv.push(f.uv[i]); seam.push(s); pin.push(f.pin?.[i] ?? false);
      const mid = edgePoint.get(edgeKey(f.v[i], f.v[j]));
      if (mid !== undefined) { v.push(mid); uv.push(lerpUV(f.uv[i], f.uv[j], 0.5)); seam.push(s); pin.push(false); }
    }
    f.v = v; f.uv = uv;
    if (f.seam) f.seam = seam;
    if (f.pin) f.pin = pin;
  });

  if (smooth) {
    // Reposition original vertices with the Catmull-Clark rule; boundaries use the crease rule.
    const vertFaces = new Map<number, number[]>();
    const vertEdges = new Map<number, string[]>();
    faces.forEach((fi) => m.faces[fi].v.forEach((v) => { const l = vertFaces.get(v); if (l) l.push(fi); else vertFaces.set(v, [fi]); }));
    for (const k of edgeKeysIn) {
      const [a, b] = parseEdge(k);
      for (const x of [a, b]) { const l = vertEdges.get(x); if (l) l.push(k); else vertEdges.set(x, [k]); }
    }
    vertFaces.forEach((fl, v) => {
      const es = vertEdges.get(v) ?? [];
      const boundary = es.filter((k) => (ef.get(k) ?? []).filter((x) => faces.has(x)).length < 2 || (ef.get(k) ?? []).length !== 2);
      // The rim of a partial region is shared with unselected faces, so it stays put.
      if (!all && boundary.length && fl.length < es.length) return;
      if (boundary.length >= 2) {
        const [e1, e2] = boundary;
        const other = (k: string) => { const [a, b] = parseEdge(k); return a === v ? b : a; };
        m.verts[v].p = add(mul(orig[v], 0.75), mul(add(orig[other(e1)], orig[other(e2)]), 0.125));
        return;
      }
      if (boundary.length) return;
      const n = fl.length;
      let F: V3 = [0, 0, 0], R: V3 = [0, 0, 0];
      fl.forEach((fi) => { F = add(F, m.verts[facePoint.get(fi)!].p); });
      es.forEach((k) => { const [a, b] = parseEdge(k); R = add(R, lerp3(orig[a], orig[b], 0.5)); });
      F = mul(F, 1 / n); R = mul(R, 1 / es.length);
      m.verts[v].p = mul(add(add(F, mul(R, 2)), mul(orig[v], n - 3)), 1 / n);
    });
  }

  const created: Face[] = [];
  const keep: Face[] = [];
  m.faces.forEach((f, fi) => {
    if (!faces.has(fi)) { keep.push(f); return; }
    const n = f.v.length;
    const c = facePoint.get(fi)!;
    const cu: V2 = [0, 0];
    f.uv.forEach((u) => { cu[0] += u[0] / n; cu[1] += u[1] / n; });
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n, next = (i + 1) % n;
      const q: Face = {
        v: [f.v[i], edgePoint.get(edgeKey(f.v[i], f.v[next]))!, c, edgePoint.get(edgeKey(f.v[prev], f.v[i]))!],
        uv: [cuv(f.uv[i]), lerpUV(f.uv[i], f.uv[next], 0.5), cuv(cu), lerpUV(f.uv[prev], f.uv[i], 0.5)],
        g: f.g, s: f.s,
      };
      // Halves of the original edges keep their seams; the edges to the centre are new.
      if (f.seam) q.seam = [f.seam[i] ?? false, false, false, f.seam[prev] ?? false];
      if (f.pin) q.pin = [f.pin[i] ?? false, false, false, false];
      created.push(q);
    }
  });
  m.faces = keep.concat(created);
}

// ---------- misc topology ----------

export function triangulateFaces(m: Model, faces: Set<number>) {
  const created: Face[] = [];
  const keep: Face[] = [];
  m.faces.forEach((f, fi) => {
    if (!faces.has(fi) || f.v.length === 3) { keep.push(f); return; }
    const t = triangulateFace(m, f);
    const n = f.v.length;
    for (let i = 0; i < t.length; i += 3) {
      const c = [t[i], t[i + 1], t[i + 2]];
      const tri: Face = { v: c.map((k) => f.v[k]), uv: c.map((k) => cuv(f.uv[k])), g: f.g, s: f.s };
      // A triangle side that runs along the original outline keeps that edge's seam.
      if (f.seam) tri.seam = c.map((k, j) => c[(j + 1) % 3] === (k + 1) % n && (f.seam![k] ?? false));
      if (f.pin) tri.pin = c.map((k) => f.pin![k] ?? false);
      created.push(tri);
    }
  });
  m.faces = keep.concat(created);
}

/** Merge coplanar triangle pairs back into quads where it makes clean shapes. */
export function quadify(m: Model, faces: Set<number>, maxAngleDeg = 10): number {
  const ef = edgeFaces(m);
  const cosT = Math.cos((maxAngleDeg * Math.PI) / 180);
  const used = new Set<number>();
  const remove = new Set<number>();
  const created: Face[] = [];
  faces.forEach((fi) => {
    const f = m.faces[fi];
    if (used.has(fi) || f.v.length !== 3) return;
    let best = -1, bestScore = -1, bestEdge = 0;
    for (let i = 0; i < 3; i++) {
      for (const nb of ef.get(edgeKey(f.v[i], f.v[(i + 1) % 3])) ?? []) {
        const g = m.faces[nb];
        if (nb === fi || used.has(nb) || !faces.has(nb) || g.v.length !== 3 || g.g !== f.g) continue;
        const c = dot(faceNormal(m, f), faceNormal(m, g));
        if (c >= cosT && c > bestScore) { best = nb; bestScore = c; bestEdge = i; }
      }
    }
    if (best < 0) return;
    const g = m.faces[best];
    const a = f.v[bestEdge], b = f.v[(bestEdge + 1) % 3], c = f.v[(bestEdge + 2) % 3];
    const gi = g.v.findIndex((x) => x !== a && x !== b);
    const d = g.v[gi];
    if (!g.v.includes(a) || !g.v.includes(b)) return;
    const uv = (face: Face, v: number) => cuv(face.uv[face.v.indexOf(v)]);
    const q: Face = { v: [c, a, d, b], uv: [uv(f, c), uv(f, a), uv(g, d), uv(f, b)], g: f.g, s: f.s };
    if (f.seam || g.seam) q.seam = [edgeSeam(f, c, a), edgeSeam(g, a, d), edgeSeam(g, d, b), edgeSeam(f, b, c)];
    if (f.pin || g.pin) q.pin = [cornerPin(f, c), cornerPin(f, a), cornerPin(g, d), cornerPin(f, b)];
    created.push(q);
    used.add(fi); used.add(best); remove.add(fi); remove.add(best);
  });
  m.faces = m.faces.filter((_, i) => !remove.has(i)).concat(created);
  return created.length;
}

/** Copy faces with independent vertices. Returns new face indices. */
export function duplicateFaces(m: Model, faces: Set<number>, groupId?: number): number[] {
  const map = new Map<number, number>();
  const out: number[] = [];
  const add1 = (v: number) => {
    let n = map.get(v);
    if (n === undefined) {
      n = m.verts.length;
      const s = m.verts[v];
      m.verts.push({ p: [...s.p] as V3, w: s.w?.map((x) => [x[0], x[1]]) });
      map.set(v, n);
    }
    return n;
  };
  [...faces].forEach((fi) => {
    const f = m.faces[fi];
    out.push(m.faces.length);
    m.faces.push({ v: f.v.map(add1), uv: f.uv.map((u) => [u[0], u[1]]), g: groupId ?? f.g, s: f.s });
  });
  return out;
}

/** Detach faces from neighbours by giving them their own copies of shared vertices. */
export function detachFaces(m: Model, faces: Set<number>) {
  const outside = new Set<number>();
  m.faces.forEach((f, fi) => { if (!faces.has(fi)) f.v.forEach((v) => outside.add(v)); });
  const map = new Map<number, number>();
  faces.forEach((fi) => {
    const f = m.faces[fi];
    f.v = f.v.map((v) => {
      if (!outside.has(v)) return v;
      let n = map.get(v);
      if (n === undefined) {
        n = m.verts.length;
        const s = m.verts[v];
        m.verts.push({ p: [...s.p] as V3, w: s.w?.map((x) => [x[0], x[1]]) });
        map.set(v, n);
      }
      return n;
    });
  });
}

export function smoothVerts(m: Model, verts: Set<number>, iterations: number, factor = 0.5) {
  const nbrs = new Map<number, Set<number>>();
  for (const f of m.faces) for (let i = 0; i < f.v.length; i++) {
    const a = f.v[i], b = f.v[(i + 1) % f.v.length];
    if (verts.has(a)) (nbrs.get(a) ?? nbrs.set(a, new Set()).get(a)!).add(b);
    if (verts.has(b)) (nbrs.get(b) ?? nbrs.set(b, new Set()).get(b)!).add(a);
  }
  for (let it = 0; it < iterations; it++) {
    const next = new Map<number, V3>();
    nbrs.forEach((ns, v) => {
      let c: V3 = [0, 0, 0];
      ns.forEach((x) => { c = add(c, m.verts[x].p); });
      next.set(v, lerp3(m.verts[v].p, mul(c, 1 / ns.size), factor));
    });
    next.forEach((p, v) => { m.verts[v].p = p; });
  }
}

/** Mirror the given faces across a world axis plane, optionally welding the seam. */
export function mirrorFaces(m: Model, faces: Set<number>, axis: 0 | 1 | 2, weldSeam: boolean, keepOriginal = true) {
  if (!keepOriginal) {
    const verts = new Set<number>();
    faces.forEach((fi) => m.faces[fi].v.forEach((v) => verts.add(v)));
    verts.forEach((v) => { m.verts[v].p[axis] *= -1; });
    flipFaces(m, faces);
    return;
  }
  const created = duplicateFaces(m, faces);
  const verts = new Set<number>();
  created.forEach((fi) => m.faces[fi].v.forEach((v) => verts.add(v)));
  verts.forEach((v) => { m.verts[v].p[axis] *= -1; });
  flipFaces(m, created);
  if (weldSeam) {
    // Only the mirrored piece and its source: other meshes on the plane keep their split vertices.
    const seam = new Set<number>();
    const consider = new Set(verts);
    faces.forEach((fi) => m.faces[fi].v.forEach((v) => consider.add(v)));
    consider.forEach((i) => { const v = m.verts[i]; if (Math.abs(v.p[axis]) < 1e-4) { v.p[axis] = 0; seam.add(i); } });
    weld(m, seam, 1e-4);
  }
}

/** Walk across a quad strip from an edge; returns the ring of crossed edges. */
export function edgeRing(m: Model, startEdge: string): string[] {
  const ef = edgeFaces(m);
  const ring = new Set<string>([startEdge]);
  const walk = (edge: string, fromFace: number | null) => {
    let e = edge, from = fromFace;
    for (let guard = 0; guard < 100000; guard++) {
      const next = (ef.get(e) ?? []).find((x) => x !== from && m.faces[x].v.length === 4);
      if (next === undefined) return;
      const f = m.faces[next];
      const [a, b] = parseEdge(e);
      const i = f.v.findIndex((v, k) => {
        const w = f.v[(k + 1) % 4];
        return (v === a && w === b) || (v === b && w === a);
      });
      if (i < 0) return;
      const opp = edgeKey(f.v[(i + 2) % 4], f.v[(i + 3) % 4]);
      if (ring.has(opp)) return;
      ring.add(opp);
      e = opp; from = next;
    }
  };
  for (const f of ef.get(startEdge) ?? []) if (m.faces[f].v.length === 4) walk(startEdge, (ef.get(startEdge) ?? []).find((x) => x !== f) ?? null);
  return [...ring];
}

/** Follow an edge through 4-valence vertices; returns the loop of edges. */
export function edgeLoop(m: Model, startEdge: string): string[] {
  const ef = edgeFaces(m);
  const vertEdges = new Map<number, string[]>();
  for (const k of ef.keys()) {
    const [a, b] = parseEdge(k);
    for (const x of [a, b]) { const l = vertEdges.get(x); if (l) l.push(k); else vertEdges.set(x, [k]); }
  }
  const loop = new Set<string>([startEdge]);
  const walk = (from: string, at: number) => {
    let e = from, v = at;
    for (let guard = 0; guard < 100000; guard++) {
      const es = vertEdges.get(v) ?? [];
      if (es.length !== 4) return;
      const facesOfE = new Set(ef.get(e) ?? []);
      // The continuation shares no face with the incoming edge.
      const next = es.find((k) => k !== e && !(ef.get(k) ?? []).some((f) => facesOfE.has(f)));
      if (!next || loop.has(next)) return;
      loop.add(next);
      const [a, b] = parseEdge(next);
      v = a === v ? b : a;
      e = next;
    }
  };
  const [a, b] = parseEdge(startEdge);
  walk(startEdge, a);
  walk(startEdge, b);
  return [...loop];
}

/** Fill every hole whose boundary touches only the given vertices (or all holes). */
export function fillHoles(m: Model, verts: Set<number> | null, groupId: number): number {
  const ef = edgeFaces(m);
  const nextOf = new Map<number, number>();
  m.faces.forEach((f) => {
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      if ((ef.get(edgeKey(a, b)) ?? []).length === 1 && (!verts || (verts.has(a) && verts.has(b)))) nextOf.set(b, a);
    }
  });
  let filled = 0;
  const seen = new Set<number>();
  for (const start of nextOf.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !seen.has(v)) { seen.add(v); loop.push(v); v = nextOf.get(v); }
    if (v === start && loop.length >= 3) {
      const n = faceNormalOfLoop(m, loop);
      m.faces.push({ v: loop, uv: planarUV(m, loop, n), g: groupId, s: 0 });
      filled++;
    }
  }
  return filled;
}

function faceNormalOfLoop(m: Model, loop: number[]): V3 {
  return faceNormal(m, { v: loop, uv: [], g: 0, s: 0 });
}

// ---------- groups ----------

/** Move faces to a new group. */
export function regroup(m: Model, faces: Set<number>, name: string): number {
  const src = m.faces[[...faces][0]];
  const g = makeGroup(m, uniqueName(m.groups.map((x) => x.name), name),
    src ? m.groups.find((x) => x.id === src.g)?.material ?? null : null);
  faces.forEach((fi) => { m.faces[fi].g = g.id; });
  pruneEmptyGroups(m);
  return g.id;
}

export function groupFaces(m: Model, groupId: number): number[] {
  const out: number[] = [];
  m.faces.forEach((f, i) => { if (f.g === groupId) out.push(i); });
  return out;
}

export function modelVolume(m: Model): number {
  return signedVolume(m, m.faces.keys());
}

export { newId };
