// Quadric-error edge-collapse simplification, used for LOD generation.
// Open borders and UV seams get penalty planes so silhouettes and textures hold up.
import { cross, dot, faceNormal, norm, sub, triangulateFace } from './geom';
import { blendWeights } from './ops';
import type { Face, Model, V2, V3 } from './types';

type Quadric = Float64Array; // symmetric 4x4 as 10 values

const qNew = (): Quadric => new Float64Array(10);
function qAddPlane(q: Quadric, a: number, b: number, c: number, d: number, w: number) {
  q[0] += w * a * a; q[1] += w * a * b; q[2] += w * a * c; q[3] += w * a * d;
  q[4] += w * b * b; q[5] += w * b * c; q[6] += w * b * d;
  q[7] += w * c * c; q[8] += w * c * d; q[9] += w * d * d;
}
const qAdd = (a: Quadric, b: Quadric) => { const o = qNew(); for (let i = 0; i < 10; i++) o[i] = a[i] + b[i]; return o; };
const qErr = (q: Quadric, p: V3) => {
  const [x, y, z] = p;
  return q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x + q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y + q[7] * z * z + 2 * q[8] * z + q[9];
};

interface Tri { v: [number, number, number]; uv: [V2, V2, V2]; dead: boolean; g: number; s: number }
interface Item { cost: number; a: number; b: number; p: V3; va: number; vb: number }

class Heap {
  a: Item[] = [];
  push(x: Item) {
    const a = this.a; a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop(): Item | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0], last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * Simplify `faces`, returning brand-new vertices and triangles (the source mesh is
 * untouched). `ratio` is the target fraction of triangles to keep.
 */
export function decimate(m: Model, faces: Iterable<number>, ratio: number): { verts: Model['verts']; faces: Face[] } {
  const idMap = new Map<number, number>();
  const pos: V3[] = [];
  const srcOf: number[] = [];
  const local = (v: number) => {
    let i = idMap.get(v);
    if (i === undefined) { i = pos.length; idMap.set(v, i); pos.push([...m.verts[v].p] as V3); srcOf.push(v); }
    return i;
  };
  const tris: Tri[] = [];
  for (const fi of faces) {
    const f = m.faces[fi];
    const t = triangulateFace(m, f);
    for (let i = 0; i < t.length; i += 3) {
      tris.push({
        v: [local(f.v[t[i]]), local(f.v[t[i + 1]]), local(f.v[t[i + 2]])],
        uv: [f.uv[t[i]], f.uv[t[i + 1]], f.uv[t[i + 2]]],
        dead: false, g: f.g, s: f.s,
      });
    }
  }

  const n = pos.length;
  const Q: Quadric[] = Array.from({ length: n }, qNew);
  const vtris: Set<number>[] = Array.from({ length: n }, () => new Set());
  const version = new Int32Array(n);
  const merged: number[][] = Array.from({ length: n }, (_, i) => [srcOf[i]]);

  const edgeUse = new Map<string, { tri: number; a: number; b: number }[]>();
  tris.forEach((t, ti) => {
    const nrm = norm(cross(sub(pos[t.v[1]], pos[t.v[0]]), sub(pos[t.v[2]], pos[t.v[0]])));
    const d = -dot(nrm, pos[t.v[0]]);
    for (const x of t.v) { qAddPlane(Q[x], nrm[0], nrm[1], nrm[2], d, 1); vtris[x].add(ti); }
    for (let i = 0; i < 3; i++) {
      const a = t.v[i], b = t.v[(i + 1) % 3];
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      const list = edgeUse.get(k);
      const e = { tri: ti, a: i, b: (i + 1) % 3 };
      if (list) list.push(e); else edgeUse.set(k, [e]);
    }
  });

  // Border / UV seam constraint planes.
  edgeUse.forEach((use, k) => {
    const [a, b] = k.split('_').map(Number);
    let constrain = use.length === 1;
    if (use.length === 2) {
      const [x, y] = use;
      const same = (t: Tri, vert: number, other: Tri) => {
        const uv1 = t.uv[t.v.indexOf(vert)], uv2 = other.uv[other.v.indexOf(vert)];
        return Math.abs(uv1[0] - uv2[0]) < 1e-5 && Math.abs(uv1[1] - uv2[1]) < 1e-5;
      };
      constrain = !same(tris[x.tri], a, tris[y.tri]) || !same(tris[x.tri], b, tris[y.tri]);
    }
    if (constrain) {
      const t = tris[use[0].tri];
      const tn = norm(cross(sub(pos[t.v[1]], pos[t.v[0]]), sub(pos[t.v[2]], pos[t.v[0]])));
      const en = norm(cross(sub(pos[b], pos[a]), tn));
      const d = -dot(en, pos[a]);
      qAddPlane(Q[a], en[0], en[1], en[2], d, 100);
      qAddPlane(Q[b], en[0], en[1], en[2], d, 100);
    }
  });

  const heap = new Heap();
  const pushEdge = (a: number, b: number) => {
    const q = qAdd(Q[a], Q[b]);
    const mid: V3 = [(pos[a][0] + pos[b][0]) / 2, (pos[a][1] + pos[b][1]) / 2, (pos[a][2] + pos[b][2]) / 2];
    let bestP = mid, bestC = qErr(q, mid);
    for (const c of [pos[a], pos[b]]) { const e = qErr(q, c); if (e < bestC) { bestC = e; bestP = c; } }
    heap.push({ cost: bestC, a, b, p: [...bestP] as V3, va: version[a], vb: version[b] });
  };
  edgeUse.forEach((_, k) => { const [a, b] = k.split('_').map(Number); pushEdge(a, b); });

  const flips = (v: number, other: number, p: V3) => {
    for (const ti of vtris[v]) {
      const t = tris[ti];
      if (t.dead || t.v.includes(other)) continue;
      const i = t.v.indexOf(v);
      const a = pos[t.v[0]], b = pos[t.v[1]], c = pos[t.v[2]];
      const before = norm(cross(sub(b, a), sub(c, a)));
      const P = [a, b, c]; P[i] = p;
      const raw = cross(sub(P[1], P[0]), sub(P[2], P[0]));
      if (Math.hypot(...raw) < 1e-14) return true;
      if (dot(before, norm(raw)) < 0.2) return true;
    }
    return false;
  };
  const neighbours = (v: number) => {
    const s = new Set<number>();
    for (const ti of vtris[v]) if (!tris[ti].dead) for (const x of tris[ti].v) if (x !== v) s.add(x);
    return s;
  };

  let alive = tris.length;
  const target = Math.max(4, Math.floor(tris.length * ratio));
  while (alive > target) {
    const e = heap.pop();
    if (!e) break;
    if (version[e.a] !== e.va || version[e.b] !== e.vb) continue;
    const { a, b, p } = e;
    const shared = [...vtris[a]].filter((ti) => !tris[ti].dead && tris[ti].v.includes(b));
    if (!shared.length) continue;
    // Link condition: collapsing must not pinch the surface.
    const na = neighbours(a), nb = neighbours(b);
    let common = 0;
    na.forEach((x) => { if (nb.has(x)) common++; });
    if (common > shared.length) continue;
    if (flips(a, b, p) || flips(b, a, p)) continue;

    pos[a] = p;
    Q[a] = qAdd(Q[a], Q[b]);
    merged[a] = merged[a].concat(merged[b]);
    for (const ti of shared) { tris[ti].dead = true; alive--; }
    for (const ti of vtris[b]) {
      const t = tris[ti];
      if (t.dead) continue;
      t.v[t.v.indexOf(b)] = a;
      vtris[a].add(ti);
    }
    vtris[b].clear();
    version[a]++; version[b]++;
    neighbours(a).forEach((x) => { version[x]++; });
    const refreshed = new Set<number>();
    neighbours(a).forEach((x) => {
      neighbours(x).forEach((y) => {
        const k = x < y ? x * n + y : y * n + x;
        if (!refreshed.has(k)) { refreshed.add(k); pushEdge(x, y); }
      });
    });
  }

  const remap = new Map<number, number>();
  const outVerts: Model['verts'] = [];
  const outFaces: Face[] = [];
  for (const t of tris) {
    if (t.dead) continue;
    const v = t.v.map((x) => {
      let i = remap.get(x);
      if (i === undefined) {
        i = outVerts.length;
        remap.set(x, i);
        outVerts.push({ p: pos[x], w: blendWeights(merged[x].map((s) => m.verts[s])) });
      }
      return i;
    });
    outFaces.push({ v, uv: t.uv.map((u) => [u[0], u[1]]) as V2[], g: t.g, s: t.s });
  }
  return { verts: outVerts, faces: outFaces };
}

export { faceNormal };
