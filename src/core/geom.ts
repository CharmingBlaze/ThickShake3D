// Small vector and polygon helpers with no scene dependencies.
import type { Face, Model, V3 } from './types';

export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const lerp3 = (a: V3, b: V3, t: number): V3 => [
  a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t,
];
export function norm(a: V3): V3 {
  const l = len(a);
  return l > 1e-12 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
}

/** Newell normal, unnormalised (length = 2 * polygon area). Handles concave n-gons. */
export function faceNormalRaw(m: Model, f: Face): V3 {
  let x = 0, y = 0, z = 0;
  const n = f.v.length;
  for (let i = 0; i < n; i++) {
    const a = m.verts[f.v[i]].p, b = m.verts[f.v[(i + 1) % n]].p;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}
export const faceNormal = (m: Model, f: Face): V3 => norm(faceNormalRaw(m, f));
export const faceArea = (m: Model, f: Face) => len(faceNormalRaw(m, f)) / 2;

export function faceCenter(m: Model, f: Face): V3 {
  let x = 0, y = 0, z = 0;
  for (const i of f.v) { const p = m.verts[i].p; x += p[0]; y += p[1]; z += p[2]; }
  const k = 1 / f.v.length;
  return [x * k, y * k, z * k];
}

/**
 * Triangulate a polygon given corner positions, returning corner-index triples.
 * Triangles and convex quads take a fast path; n-gons use ear clipping in the
 * polygon's best-fit plane, so concave shapes stay inside their outline.
 */
export function triangulate(pts: V3[]): number[] {
  const n = pts.length;
  if (n < 3) return [];
  if (n === 3) return [0, 1, 2];

  // Newell normal for the projection plane.
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  // Drop the dominant axis and keep orientation positive.
  let u = 0, v = 1, flip = nz < 0;
  if (ax >= ay && ax >= az) { u = 1; v = 2; flip = nx < 0; }
  else if (ay >= az) { u = 2; v = 0; flip = ny < 0; }
  const P = pts.map((p) => (flip ? [p[v], p[u]] : [p[u], p[v]]));

  const cornerCross = (a: number, b: number, c: number) =>
    (P[b][0] - P[a][0]) * (P[c][1] - P[a][1]) - (P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);

  const idx = pts.map((_, i) => i);
  const out: number[] = [];
  let guard = n * n + 8;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length];
      if (cornerCross(a, b, c) <= 1e-14) continue;
      let inside = false;
      for (const k of idx) {
        if (k === a || k === b || k === c) continue;
        if (cornerCross(a, b, k) >= 0 && cornerCross(b, c, k) >= 0 && cornerCross(c, a, k) >= 0) { inside = true; break; }
      }
      if (inside) continue;
      out.push(a, b, c);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // Degenerate outline: fall through to a fan of what's left.
  }
  for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
  return out;
}

export function triangulateFace(m: Model, f: Face): number[] {
  return triangulate(f.v.map((i) => m.verts[i].p));
}

export const edgeKey = (a: number, b: number) => (a < b ? `${a}_${b}` : `${b}_${a}`);
export function parseEdge(k: string): [number, number] {
  const i = k.indexOf('_');
  return [+k.slice(0, i), +k.slice(i + 1)];
}

/** Map of undirected edge -> indices of faces using it. */
export function edgeFaces(m: Model): Map<string, number[]> {
  const out = new Map<string, number[]>();
  m.faces.forEach((f, fi) => {
    for (let i = 0; i < f.v.length; i++) {
      const k = edgeKey(f.v[i], f.v[(i + 1) % f.v.length]);
      const list = out.get(k);
      if (list) list.push(fi); else out.set(k, [fi]);
    }
  });
  return out;
}

export function bounds(points: Iterable<V3>): { min: V3; max: V3; center: V3; size: V3; empty: boolean } {
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  let empty = true;
  for (const p of points) {
    empty = false;
    for (let i = 0; i < 3; i++) { if (p[i] < min[i]) min[i] = p[i]; if (p[i] > max[i]) max[i] = p[i]; }
  }
  if (empty) return { min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], size: [0, 0, 0], empty };
  return {
    min, max, empty,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/** Signed volume of a closed mesh; positive when faces wind outward. */
export function signedVolume(m: Model, faces: Iterable<number>): number {
  let vol = 0;
  for (const fi of faces) {
    const f = m.faces[fi];
    const tris = triangulateFace(m, f);
    for (let t = 0; t < tris.length; t += 3) {
      const a = m.verts[f.v[tris[t]]].p, b = m.verts[f.v[tris[t + 1]]].p, c = m.verts[f.v[tris[t + 2]]].p;
      vol += dot(a, cross(b, c)) / 6;
    }
  }
  return vol;
}
