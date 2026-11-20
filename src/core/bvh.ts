// A bounding volume tree over triangles, so a ray only tests the few triangles near it instead of every one.
import type { V3 } from './types';

const LEAF = 4;

export class TriTree {
  /** Per node: min x, y, z, max x, y, z. */
  private box: Float32Array;
  /** Per node: its first child, or for a leaf its first triangle; its second child; and for a leaf how many triangles, 0 otherwise. */
  private first: Int32Array;
  private second: Int32Array;
  private count: Int32Array;
  /** Triangles in tree order, as indices into the list given. */
  private order: Int32Array;
  private nodes = 0;

  /** `P` packs x, y, z per vertex; `tris` packs three vertex indices per triangle. */
  constructor(private P: ArrayLike<number>, private tris: ArrayLike<number>) {
    const n = Math.floor(tris.length / 3);
    this.order = new Int32Array(n);
    for (let i = 0; i < n; i++) this.order[i] = i;
    const cap = Math.max(1, 2 * Math.ceil(n / LEAF) + 1);
    this.box = new Float32Array(cap * 6);
    this.first = new Int32Array(cap);
    this.second = new Int32Array(cap);
    this.count = new Int32Array(cap);
    const cen = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) {
      cen[i * 3 + k] = (P[tris[i * 3] * 3 + k] + P[tris[i * 3 + 1] * 3 + k] + P[tris[i * 3 + 2] * 3 + k]) / 3;
    }
    this.build(0, n, cen);
  }

  private grow(): number {
    if (this.nodes >= this.first.length) {
      const cap = this.first.length * 2;
      const box = new Float32Array(cap * 6); box.set(this.box); this.box = box;
      const f = new Int32Array(cap); f.set(this.first); this.first = f;
      const c = new Int32Array(cap); c.set(this.count); this.count = c;
      const s2 = new Int32Array(cap); s2.set(this.second); this.second = s2;
    }
    return this.nodes++;
  }

  private build(lo: number, hi: number, cen: Float32Array): number {
    const node = this.grow();
    const { P, tris, order } = this;
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    const cb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const t = order[i];
      for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) {
        const v = P[tris[t * 3 + j] * 3 + k];
        if (v < b[k]) b[k] = v;
        if (v > b[k + 3]) b[k + 3] = v;
      }
      for (let k = 0; k < 3; k++) { const v = cen[t * 3 + k]; if (v < cb[k]) cb[k] = v; if (v > cb[k + 3]) cb[k + 3] = v; }
    }
    this.box.set(b, node * 6);
    const axis = [0, 1, 2].reduce((a, k) => (cb[k + 3] - cb[k] > cb[a + 3] - cb[a] ? k : a), 0);
    if (hi - lo <= LEAF || cb[axis + 3] - cb[axis] < 1e-12) { this.first[node] = lo; this.count[node] = hi - lo; return node; }
    // Split at the middle of the centres along the longest side.
    const mid = (cb[axis] + cb[axis + 3]) / 2;
    let i = lo, j = hi - 1;
    while (i <= j) {
      if (cen[order[i] * 3 + axis] < mid) i++;
      else { const s = order[i]; order[i] = order[j]; order[j] = s; j--; }
    }
    if (i === lo || i === hi) i = (lo + hi) >> 1;
    const left = this.build(lo, i, cen);
    const right = this.build(i, hi, cen);
    this.first[node] = left;
    this.second[node] = right;
    this.count[node] = 0;
    return node;
  }

  /** The distance along the ray where it enters a node's box, or Infinity if it misses (or only beyond `far`). */
  private enter(node: number, o: V3, inv: V3, far: number): number {
    let t0 = 0, t1 = far;
    for (let k = 0; k < 3; k++) {
      let a = (this.box[node * 6 + k] - o[k]) * inv[k], b = (this.box[node * 6 + 3 + k] - o[k]) * inv[k];
      if (a > b) { const s = a; a = b; b = s; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) return Infinity;
    }
    return t0;
  }

  /**
   * Every triangle the ray hits, nearest first unless `all` is false, in which case only the nearest. `cullBack` skips
   * triangles seen from behind (whose corners wind clockwise from the ray's side).
   */
  hits(o: V3, d: V3, cullBack: boolean, all: boolean): { tri: number; t: number }[] {
    const out: { tri: number; t: number }[] = [];
    // With no triangles the root is an empty leaf, which the walk below would mistake for a branch and loop on forever.
    if (!this.order.length) return out;
    const inv: V3 = [1 / d[0], 1 / d[1], 1 / d[2]];
    let far = Infinity;
    const stack = [0];
    while (stack.length) {
      const node = stack.pop()!;
      if (this.enter(node, o, inv, far) === Infinity) continue;
      const cnt = this.count[node];
      if (!cnt) { stack.push(this.second[node], this.first[node]); continue; }
      for (let i = this.first[node]; i < this.first[node] + cnt; i++) {
        const tri = this.order[i];
        const t = this.ray(tri, o, d, cullBack);
        if (t === null || t > far) continue;
        if (all) out.push({ tri, t });
        else { far = t; out[0] = { tri, t }; }
      }
    }
    if (all) out.sort((a, b) => a.t - b.t);
    return out;
  }

  /** Where the ray meets one triangle, by Möller and Trumbore, or null. */
  private ray(tri: number, o: V3, d: V3, cullBack: boolean): number | null {
    const P = this.P, T = this.tris;
    const a = T[tri * 3] * 3, b = T[tri * 3 + 1] * 3, c = T[tri * 3 + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const px = d[1] * e2z - d[2] * e2y, py = d[2] * e2x - d[0] * e2z, pz = d[0] * e2y - d[1] * e2x;
    const det = e1x * px + e1y * py + e1z * pz;
    if (cullBack ? det < 1e-12 : Math.abs(det) < 1e-12) return null;
    const inv = 1 / det;
    const tx = o[0] - P[a], ty = o[1] - P[a + 1], tz = o[2] - P[a + 2];
    const u = (tx * px + ty * py + tz * pz) * inv;
    if (u < 0 || u > 1) return null;
    const qx = ty * e1z - tz * e1y, qy = tz * e1x - tx * e1z, qz = tx * e1y - ty * e1x;
    const v = (d[0] * qx + d[1] * qy + d[2] * qz) * inv;
    if (v < 0 || u + v > 1) return null;
    const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
    return t >= 0 ? t : null;
  }
}
