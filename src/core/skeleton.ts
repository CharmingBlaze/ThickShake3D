// Skeleton evaluation, CPU skinning, automatic weights. Bones are rigid
// (rotation + translation) with an identity rest orientation, so a skin transform
// is simply: p' = R * (p - head) + t.
import { dist, sub, dot, add, mul } from './geom';
import { uniqueName, type Bone, type Clip, type Key, type Model, type Q, type Track, type V3 } from './types';

export const qIdent: Q = [0, 0, 0, 1];
export function qMul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
export const qConj = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
export function qNorm(q: Q): Q {
  const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qRotate(q: Q, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + y * tz - z * ty, v[1] + w * ty + z * tx - x * tz, v[2] + w * tz + x * ty - y * tx];
}
export function qAxisAngle(axis: V3, rad: number): Q {
  const s = Math.sin(rad / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(rad / 2)];
}
export function qSlerp(a: Q, b: Q, t: number): Q {
  let c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (c < 0) { c = -c; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (c > 0.9995) {
    return qNorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]);
  }
  const th = Math.acos(c), s = Math.sin(th), p = Math.sin((1 - t) * th) / s, r = Math.sin(t * th) / s;
  return [a[0] * p + bb[0] * r, a[1] * p + bb[1] * r, a[2] * p + bb[2] * r, a[3] * p + bb[3] * r];
}
/** Intrinsic rotation from Euler degrees, order Z * Y * X. */
export function qFromEuler(x: number, y: number, z: number): Q {
  const r = Math.PI / 180;
  return qMul(qMul(qAxisAngle([0, 0, 1], z * r), qAxisAngle([0, 1, 0], y * r)), qAxisAngle([1, 0, 0], x * r));
}
export function qToEuler(q: Q): V3 {
  const [x, y, z, w] = q;
  const d = 180 / Math.PI;
  const sy = Math.max(-1, Math.min(1, 2 * (w * y - z * x)));
  return [Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * d, Math.asin(sy) * d, Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * d];
}

/** Bones sorted so parents always precede children. */
export function bonesTopo(m: Model): Bone[] {
  const byId = new Map(m.bones.map((b) => [b.id, b]));
  const out: Bone[] = [];
  const seen = new Set<number>();
  const visit = (b: Bone) => {
    if (seen.has(b.id)) return;
    seen.add(b.id);
    if (b.parent !== null) { const p = byId.get(b.parent); if (p) visit(p); }
    out.push(b);
  };
  m.bones.forEach(visit);
  return out;
}

/** Progress through a segment after its curve: t in 0..1 gives a value that may overshoot past 0 and 1. */
export function easeT(key: Key<unknown>, t: number): number {
  if (key.step) return 0;
  if (!key.c) return t;
  const [x1, y1, x2, y2] = key.c;
  const at = (a: number, b: number, s: number) => 3 * (1 - s) * (1 - s) * s * a + 3 * (1 - s) * s * s * b + s * s * s;
  let lo = 0, hi = 1, s = t;
  for (let i = 0; i < 24; i++) {
    const x = at(x1, x2, s);
    if (Math.abs(x - t) < 1e-5) break;
    if (x < t) lo = s; else hi = s;
    s = (lo + hi) / 2;
  }
  return at(y1, y2, s);
}

function sampleV3(keys: Key<V3>[], f: number): V3 {
  if (!keys.length) return [0, 0, 0];
  if (f <= keys[0].f) return keys[0].v;
  const last = keys[keys.length - 1];
  if (f >= last.f) return last.v;
  let i = 1;
  while (keys[i].f < f) i++;
  const a = keys[i - 1], b = keys[i];
  const t = easeT(a, (f - a.f) / (b.f - a.f));
  return [a.v[0] + (b.v[0] - a.v[0]) * t, a.v[1] + (b.v[1] - a.v[1]) * t, a.v[2] + (b.v[2] - a.v[2]) * t];
}

function sampleQ(keys: Key<Q>[], f: number): Q {
  if (!keys.length) return qIdent;
  if (f <= keys[0].f) return keys[0].v;
  const last = keys[keys.length - 1];
  if (f >= last.f) return last.v;
  let i = 1;
  while (keys[i].f < f) i++;
  const a = keys[i - 1], b = keys[i];
  return qSlerp(a.v, b.v, easeT(a, (f - a.f) / (b.f - a.f)));
}

export function sampleTrack(t: Track | undefined, f: number): { pos: V3; rot: Q } {
  if (!t) return { pos: [0, 0, 0], rot: qIdent };
  return { pos: sampleV3(t.pos, f), rot: sampleQ(t.rot, f) };
}

export interface BonePose { rot: Q; pos: V3; head: V3 }

export function evalPose(m: Model, clip: Clip | null, frame: number): Map<number, BonePose> {
  const out = new Map<number, BonePose>();
  const byId = new Map(m.bones.map((b) => [b.id, b]));
  for (const b of bonesTopo(m)) {
    const { pos, rot } = clip ? sampleTrack(clip.tracks[b.id], frame) : { pos: [0, 0, 0] as V3, rot: qIdent };
    const parent = b.parent !== null ? out.get(b.parent) : undefined;
    const parentHead: V3 = b.parent !== null ? byId.get(b.parent)?.head ?? [0, 0, 0] : [0, 0, 0];
    const off = add(sub(b.head, parentHead), pos);
    if (parent) out.set(b.id, { rot: qNorm(qMul(parent.rot, rot)), pos: add(parent.pos, qRotate(parent.rot, off)), head: b.head });
    else out.set(b.id, { rot, pos: off, head: b.head });
  }
  return out;
}

/** Skin all vertices into `out` (x,y,z packed). */
export function skinInto(m: Model, pose: Map<number, BonePose>, out: Float32Array) {
  const verts = m.verts;
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    const p = v.p;
    let x = 0, y = 0, z = 0, tw = 0;
    if (v.w) {
      for (const [b, w] of v.w) {
        const bp = pose.get(b);
        if (!bp) continue;
        const r = qRotate(bp.rot, [p[0] - bp.head[0], p[1] - bp.head[1], p[2] - bp.head[2]]);
        x += (r[0] + bp.pos[0]) * w; y += (r[1] + bp.pos[1]) * w; z += (r[2] + bp.pos[2]) * w;
        tw += w;
      }
    }
    const j = i * 3;
    if (tw > 1e-6) { out[j] = x / tw; out[j + 1] = y / tw; out[j + 2] = z / tw; }
    else { out[j] = p[0]; out[j + 1] = p[1]; out[j + 2] = p[2]; }
  }
}

// ---------- weights ----------

function segDistance(p: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const l = dot(ab, ab);
  const t = l > 1e-12 ? Math.max(0, Math.min(1, dot(sub(p, a), ab) / l)) : 0;
  return dist(p, add(a, mul(ab, t)));
}

/** Distance-based automatic skinning. Each bone owns segments to its children. */
export function autoWeights(m: Model, verts: Iterable<number>, maxInfluences = 4, falloff = 4) {
  if (!m.bones.length) return;
  const segs: { bone: number; a: V3; b: V3 }[] = [];
  for (const b of m.bones) {
    const kids = m.bones.filter((c) => c.parent === b.id);
    if (kids.length) kids.forEach((c) => segs.push({ bone: b.id, a: b.head, b: c.head }));
    else segs.push({ bone: b.id, a: b.head, b: b.head });
  }
  for (const i of verts) {
    const v = m.verts[i];
    const best = new Map<number, number>();
    for (const s of segs) {
      const d = segDistance(v.p, s.a, s.b);
      const prev = best.get(s.bone);
      if (prev === undefined || d < prev) best.set(s.bone, d);
    }
    const ranked = [...best.entries()].map(([b, d]) => [b, 1 / Math.pow(d + 0.01, falloff)] as [number, number])
      .sort((a, b) => b[1] - a[1]).slice(0, maxInfluences);
    const total = ranked.reduce((s, x) => s + x[1], 0);
    const norm = ranked.map(([b, w]) => [b, w / total] as [number, number]).filter((x) => x[1] >= 0.02);
    const t2 = norm.reduce((s, x) => s + x[1], 0);
    v.w = norm.map(([b, w]) => [b, w / t2]);
  }
}

/** Each vertex's neighbours along mesh edges. */
export function vertexNeighbors(m: Model): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  const link = (a: number, b: number) => { let s = out.get(a); if (!s) { s = new Set(); out.set(a, s); } s.add(b); };
  for (const f of m.faces) {
    f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; link(a, b); link(b, a); });
  }
  return out;
}

/**
 * Heat-diffusion skinning, after Baran and Popovic's "bone heat". Each bone's influence spreads over the surface
 * from the vertices nearest it, so it flows along connected skin and doesn't leap across a gap to a nearby part,
 * such as from one leg to the other. Solves (L + H) w = H p per bone by conjugate gradient.
 */
export function heatWeights(m: Model, verts: Iterable<number>, maxInfluences = 4) {
  if (!m.bones.length) return;
  const segs: { bone: number; a: V3; b: V3 }[] = [];
  for (const b of m.bones) {
    const kids = m.bones.filter((c) => c.parent === b.id);
    if (kids.length) kids.forEach((c) => segs.push({ bone: b.id, a: b.head, b: c.head }));
    else segs.push({ bone: b.id, a: b.head, b: b.head });
  }
  const n = m.verts.length;
  const boneIds = m.bones.map((b) => b.id);
  const boneIndex = new Map(boneIds.map((id, i) => [id, i]));
  // Distance from every vertex to every bone.
  const dists = new Float64Array(n * boneIds.length).fill(Infinity);
  const nearest = new Float64Array(n).fill(Infinity);
  for (let v = 0; v < n; v++) {
    for (const s of segs) {
      const bi = boneIndex.get(s.bone)!;
      const d = segDistance(m.verts[v].p, s.a, s.b);
      if (d < dists[v * boneIds.length + bi]) dists[v * boneIds.length + bi] = d;
      if (d < nearest[v]) nearest[v] = d;
    }
  }
  // Edge conductance 1 / length squared, which keeps the result independent of mesh density and scale.
  const nb = vertexNeighbors(m);
  const adj: [number, number][][] = Array.from({ length: n }, () => []);
  const eps = 1e-6;
  nb.forEach((set, a) => set.forEach((b) => {
    const l = dist(m.verts[a].p, m.verts[b].p);
    adj[a].push([b, 1 / Math.max(l * l, eps)]);
  }));
  const H = new Float64Array(n);
  const diag = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    H[v] = 1 / Math.max(nearest[v] * nearest[v], eps);
    diag[v] = H[v] + adj[v].reduce((s, e) => s + e[1], 0);
  }
  const apply = (x: Float64Array, out: Float64Array) => {
    for (let v = 0; v < n; v++) {
      let s = diag[v] * x[v];
      for (const [o, w] of adj[v]) s -= w * x[o];
      out[v] = s;
    }
  };
  const result = boneIds.map((_, bi) => {
    const rhs = new Float64Array(n);
    for (let v = 0; v < n; v++) {
      // A vertex midway between bones heats each of them equally.
      let ties = 0;
      for (let k = 0; k < boneIds.length; k++) if (dists[v * boneIds.length + k] <= nearest[v] * 1.001 + 1e-9) ties++;
      if (dists[v * boneIds.length + bi] <= nearest[v] * 1.001 + 1e-9) rhs[v] = H[v] / ties;
    }
    const x = rhs.map((r, v) => r / diag[v]);
    const Ax = new Float64Array(n);
    apply(x, Ax);
    const r = rhs.map((b, v) => b - Ax[v]);
    const z = r.map((a, v) => a / diag[v]);
    const d = z.slice();
    const Ad = new Float64Array(n);
    let rz = 0;
    for (let v = 0; v < n; v++) rz += r[v] * z[v];
    const start = rz;
    for (let it = 0; it < 500 && rz > 1e-10 * Math.max(start, 1e-20); it++) {
      apply(d, Ad);
      let dAd = 0;
      for (let v = 0; v < n; v++) dAd += d[v] * Ad[v];
      if (Math.abs(dAd) < 1e-30) break;
      const a = rz / dAd;
      let next = 0;
      for (let v = 0; v < n; v++) { x[v] += a * d[v]; r[v] -= a * Ad[v]; z[v] = r[v] / diag[v]; next += r[v] * z[v]; }
      const beta = next / rz;
      rz = next;
      for (let v = 0; v < n; v++) d[v] = z[v] + beta * d[v];
    }
    return x;
  });
  for (const v of verts) {
    const ranked = boneIds.map((id, bi) => [id, Math.max(0, result[bi][v])] as [number, number]);
    const w = normalizeWeights(ranked.sort((a, b) => b[1] - a[1]).slice(0, maxInfluences).filter((x) => x[1] >= 0.01), maxInfluences);
    if (w.length) m.verts[v].w = w;
    else {
      // An isolated point has no surface to carry heat: bind it to the nearest bone.
      let best = 0;
      for (let bi = 1; bi < boneIds.length; bi++) if (dists[v * boneIds.length + bi] < dists[v * boneIds.length + best]) best = bi;
      m.verts[v].w = [[boneIds[best], 1]];
    }
  }
}

/** Blend a vertex's weights toward its neighbours' average. Returns the new list without storing it. */
function smoothedWeight(m: Model, v: number, nb: Set<number> | undefined, amount: number): [number, number][] | null {
  if (!nb?.size) return null;
  const sum = new Map<number, number>();
  for (const o of nb) for (const [b, w] of m.verts[o].w ?? []) sum.set(b, (sum.get(b) ?? 0) + w / nb.size);
  const out = new Map<number, number>();
  for (const [b, w] of m.verts[v].w ?? []) out.set(b, w * (1 - amount));
  sum.forEach((w, b) => out.set(b, (out.get(b) ?? 0) + w * amount));
  return normalizeWeights([...out.entries()]);
}

export function smoothVertexWeight(m: Model, v: number, neighbors: Map<number, Set<number>>, amount: number) {
  const w = smoothedWeight(m, v, neighbors.get(v), amount);
  if (w?.length) m.verts[v].w = w;
}

/** Soften harsh weight boundaries across the mesh. */
export function smoothWeights(m: Model, verts: Iterable<number>, iterations = 3, amount = 0.5) {
  const list = [...verts];
  const nb = vertexNeighbors(m);
  for (let it = 0; it < iterations; it++) {
    const next = list.map((v) => smoothedWeight(m, v, nb.get(v), amount));
    list.forEach((v, i) => { const w = next[i]; if (w?.length) m.verts[v].w = w; });
  }
}

/** Drop tiny influences and cap how many joints may move a vertex, as game engines require. */
export function pruneWeights(m: Model, verts: Iterable<number>, threshold = 0.02, maxInfluences = 4) {
  for (const v of verts) {
    const w = m.verts[v].w;
    if (!w?.length) continue;
    const top = [...w].sort((a, b) => b[1] - a[1]);
    const kept = top.filter((x) => x[1] >= threshold);
    m.verts[v].w = normalizeWeights(kept.length ? kept : top.slice(0, 1), maxInfluences);
  }
}

/** Problems worth fixing before export. */
export function weightIssues(m: Model): { unweighted: number[]; unusedJoints: number[] } {
  const used = new Set<number>();
  const unweighted: number[] = [];
  const inFace = new Set<number>();
  for (const f of m.faces) for (const v of f.v) inFace.add(v);
  m.verts.forEach((v, i) => {
    if (v.w?.length) v.w.forEach((x) => used.add(x[0]));
    else if (inFace.has(i)) unweighted.push(i);
  });
  return { unweighted, unusedJoints: m.bones.filter((b) => !used.has(b.id)).map((b) => b.id) };
}

// ---------- joint editing ----------
/** Delete joints. Children join the nearest surviving ancestor, which also inherits the weights. */
export function removeJoints(m: Model, ids: Iterable<number>) {
  const gone = new Set(ids);
  const byId = new Map(m.bones.map((b) => [b.id, b]));
  const survivor = (id: number | null): number | null => {
    let p = id;
    while (p !== null && gone.has(p)) p = byId.get(p)?.parent ?? null;
    return p;
  };
  for (const b of m.bones) b.parent = survivor(b.parent);
  for (const v of m.verts) {
    if (!v.w?.some((x) => gone.has(x[0]))) continue;
    const sum = new Map<number, number>();
    for (const [b, w] of v.w) {
      const to = gone.has(b) ? survivor(byId.get(b)?.parent ?? null) : b;
      if (to !== null) sum.set(to, (sum.get(to) ?? 0) + w);
    }
    v.w = normalizeWeights([...sum.entries()]);
    if (!v.w.length) delete v.w;
  }
  m.bones = m.bones.filter((b) => !gone.has(b.id));
  for (const c of m.clips) gone.forEach((id) => delete c.tracks[id]);
}

/** Insert a joint midway to the first child. Returns its id, or null if the joint has no child. */
export function splitJoint(m: Model, id: number): number | null {
  const b = m.bones.find((x) => x.id === id);
  const child = m.bones.find((x) => x.parent === id);
  if (!b || !child) return null;
  const nid = m.nextId++;
  m.bones.push({ id: nid, name: uniqueName(m.bones.map((x) => x.name), `${b.name}.mid`), parent: id, head: [(b.head[0] + child.head[0]) / 2, (b.head[1] + child.head[1]) / 2, (b.head[2] + child.head[2]) / 2] });
  child.parent = nid;
  return nid;
}

/** The opposite side's name, such as Arm.L to Arm.R; null when the name has no side marker. */
export function mirrorName(name: string): string | null {
  const swaps: [RegExp, (s: string) => string][] = [
    [/(^|[._\- ])([LR])(?=$|[._\- ])/, (s) => (s === 'L' ? 'R' : 'L')],
    [/(^|[._\- ])([lr])(?=$|[._\- ])/, (s) => (s === 'l' ? 'r' : 'l')],
    [/()(Left|Right)/, (s) => (s === 'Left' ? 'Right' : 'Left')],
    [/()(left|right)/, (s) => (s === 'left' ? 'right' : 'left')],
  ];
  for (const [re, swap] of swaps) if (re.test(name)) return name.replace(re, (_, pre, side) => pre + swap(side));
  return null;
}

/**
 * Copy joints to the other side of X. Defaults to everything on +X, the character's left when it faces +Z.
 * Unmarked names gain .L and .R. Joints already mirrored are matched by position instead of duplicated.
 */
export function mirrorJoints(m: Model, ids?: Iterable<number>): number {
  const tol = 1e-3;
  const chosen = ids ? new Set(ids) : null;
  const sources = bonesTopo(m).filter((b) => Math.abs(b.head[0]) > tol && (chosen ? chosen.has(b.id) : b.head[0] > 0));
  const twin = new Map<number, number>();
  const at = (p: V3) => m.bones.find((o) => dist(o.head, p) < tol);
  let made = 0;
  for (const b of sources) {
    const p: V3 = [-b.head[0], b.head[1], b.head[2]];
    const found = at(p);
    if (found) { twin.set(b.id, found.id); continue; }
    let name = mirrorName(b.name);
    if (!name) {
      const left = b.head[0] > 0;
      const base = b.name;
      b.name = uniqueName(m.bones.map((x) => x.name), `${base}.${left ? 'L' : 'R'}`);
      name = `${base}.${left ? 'R' : 'L'}`;
    }
    const id = m.nextId++;
    const parent = b.parent !== null ? twin.get(b.parent) ?? b.parent : null;
    m.bones.push({ id, name: uniqueName(m.bones.map((x) => x.name), name), parent, head: p });
    twin.set(b.id, id);
    made++;
  }
  return made;
}

/** Vertex and joint pairs across X. Anything on the centre line pairs with itself. */
export function mirrorMaps(m: Model): { vert: Map<number, number>; bone: Map<number, number> } {
  const key = (p: V3) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
  const vIndex = new Map<string, number>();
  m.verts.forEach((v, i) => vIndex.set(key(v.p), i));
  const vert = new Map<number, number>();
  m.verts.forEach((v, i) => {
    const o = vIndex.get(key([-v.p[0], v.p[1], v.p[2]]));
    if (o !== undefined) vert.set(i, o);
  });
  const bone = new Map<number, number>();
  for (const b of m.bones) {
    const o = m.bones.find((x) => dist(x.head, [-b.head[0], b.head[1], b.head[2]]) < 1e-3);
    bone.set(b.id, o ? o.id : b.id);
  }
  return { vert, bone };
}

/** Copy weights across X from one side to the other. `from` is +1 for +X to -X, or -1 for the reverse. Returns the count. */
export function mirrorWeights(m: Model, from: 1 | -1 = 1): number {
  const { vert, bone } = mirrorMaps(m);
  let count = 0;
  m.verts.forEach((v, i) => {
    if (v.p[0] * from <= 1e-5) return;
    const o = vert.get(i);
    if (o === undefined || o === i) return;
    if (v.w?.length) m.verts[o].w = normalizeWeights(v.w.map(([b, w]) => [bone.get(b) ?? b, w] as [number, number]));
    else delete m.verts[o].w;
    count++;
  });
  return count;
}

/** A game-ready humanoid skeleton in T-pose, fitted to the mesh's bounds and facing +Z. Returns the root's id. */
export function addHumanoid(m: Model): number {
  const pts = m.verts.map((v) => v.p);
  const lo: V3 = pts.length ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.min(...pts.map((p) => p[2]))] : [-0.8, 0, -0.15];
  const hi: V3 = pts.length ? [Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[2]))] : [0.8, 1.8, 0.15];
  const H = Math.max(hi[1] - lo[1], 1e-3);
  const cx = (lo[0] + hi[0]) / 2, cz = (lo[2] + hi[2]) / 2;
  const reach = Math.max((hi[0] - lo[0]) / 2, 0.2 * H);
  const y = (t: number) => lo[1] + H * t;
  const spec: [string, string | null, number, number, number][] = [
    ['Hips', null, 0, 0.53, 0], ['Spine', 'Hips', 0, 0.62, 0], ['Chest', 'Spine', 0, 0.72, 0], ['Neck', 'Chest', 0, 0.84, 0], ['Head', 'Neck', 0, 0.89, 0], ['HeadTop', 'Head', 0, 1, 0],
    ['Shoulder.L', 'Chest', 0.05, 0.81, 0], ['UpperArm.L', 'Shoulder.L', 0.2, 0.81, 0], ['LowerArm.L', 'UpperArm.L', 0.55, 0.81, 0], ['Hand.L', 'LowerArm.L', 0.88, 0.81, 0], ['Fingers.L', 'Hand.L', 1, 0.81, 0],
    ['UpperLeg.L', 'Hips', 0.1, 0.5, 0], ['LowerLeg.L', 'UpperLeg.L', 0.1, 0.27, 0], ['Foot.L', 'LowerLeg.L', 0.1, 0.05, 0], ['Toes.L', 'Foot.L', 0.1, 0, 0.08],
  ];
  const ids = new Map<string, number>();
  const taken = m.bones.map((b) => b.name);
  const add1 = (name: string, parent: number | null, head: V3) => {
    const id = m.nextId++;
    const unique = uniqueName(taken, name);
    taken.push(unique);
    m.bones.push({ id, name: unique, parent, head });
    return id;
  };
  for (const [name, parent, x, t, z] of spec) {
    const side = x * (name.startsWith('UpperLeg') || name.startsWith('LowerLeg') || name.startsWith('Foot') || name.startsWith('Toes') ? H : reach);
    ids.set(name, add1(name, parent ? ids.get(parent)! : null, [cx + side, y(t), cz + z * H]));
  }
  for (const [name, parent, x, t, z] of spec) {
    if (x === 0 || !name.endsWith('.L')) continue;
    const side = x * (name.startsWith('UpperLeg') || name.startsWith('LowerLeg') || name.startsWith('Foot') || name.startsWith('Toes') ? H : reach);
    const n = name.replace('.L', '.R');
    const p = parent!.endsWith('.L') ? parent!.replace('.L', '.R') : parent!;
    ids.set(n, add1(n, ids.get(p)!, [cx - side, y(t), cz + z * H]));
  }
  return ids.get('Hips')!;
}

export function normalizeWeights(w: [number, number][], cap = 4): [number, number][] {
  const list = w.filter((x) => x[1] > 1e-4).sort((a, b) => b[1] - a[1]).slice(0, cap);
  const total = list.reduce((s, x) => s + x[1], 0);
  return total > 0 ? list.map(([b, x]) => [b, x / total]) : [];
}

/** Push a bone's share of a vertex towards `target` (0..1) by `strength`. */
export function paintWeight(m: Model, vi: number, bone: number, target: number, strength: number) {
  const v = m.verts[vi];
  const w = (v.w ?? []).map((x) => [x[0], x[1]] as [number, number]);
  let e = w.find((x) => x[0] === bone);
  if (!e) { e = [bone, 0]; w.push(e); }
  const next = e[1] + (target - e[1]) * strength;
  const others = w.filter((x) => x !== e);
  const otherSum = others.reduce((s, x) => s + x[1], 0);
  e[1] = next;
  const rest = Math.max(0, 1 - next);
  if (otherSum > 1e-6) others.forEach((x) => { x[1] = (x[1] / otherSum) * rest; });
  else if (others.length === 0 && next > 0) e[1] = 1;
  v.w = normalizeWeights(w);
  if (!v.w.length) delete v.w;
}

export function boneWeight(m: Model, vi: number, bone: number): number {
  return m.verts[vi].w?.find((x) => x[0] === bone)?.[1] ?? 0;
}

export function setKey<T>(keys: Key<T>[], f: number, v: T) {
  const i = keys.findIndex((k) => k.f === f);
  if (i >= 0) keys[i].v = v;
  else { keys.push({ f, v }); keys.sort((a, b) => a.f - b.f); }
}

export function ensureTrack(c: Clip, bone: number): Track {
  return (c.tracks[bone] ??= { pos: [], rot: [] });
}

/** Sorted unique frames that hold any key in a clip (optionally just one bone). */
export function keyFrames(c: Clip, bone?: number): number[] {
  const s = new Set<number>();
  const add1 = (t: Track | undefined) => { t?.pos.forEach((k) => s.add(k.f)); t?.rot.forEach((k) => s.add(k.f)); };
  if (bone !== undefined) add1(c.tracks[bone]);
  else Object.values(c.tracks).forEach(add1);
  return [...s].sort((a, b) => a - b);
}
