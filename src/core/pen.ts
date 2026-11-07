// Pen Shape outlines: closed loops of cubic bezier curves, drawn in a view's plane. Blockout inflates the traced
// outline into a piece with the same ring-based method as Draw Shape (see silhouette in organic.ts).
import type { V2 } from './types';

/** A point on a pen outline. Handles are offsets from the point; zero-length handles make a sharp corner. */
export interface PenAnchor { p: V2; i: V2; o: V2 }

const sub2 = (a: V2, b: V2): V2 => [a[0] - b[0], a[1] - b[1]];
const len2 = (a: V2) => Math.hypot(a[0], a[1]);

/** A point on the cubic from anchor `a` to anchor `b`. */
export function bezierAt(a: PenAnchor, b: PenAnchor, t: number): V2 {
  const p0 = a.p, p1: V2 = [a.p[0] + a.o[0], a.p[1] + a.o[1]], p2: V2 = [b.p[0] + b.i[0], b.p[1] + b.i[1]], p3 = b.p;
  const s = 1 - t;
  const k0 = s * s * s, k1 = 3 * s * s * t, k2 = 3 * s * t * t, k3 = t * t * t;
  return [k0 * p0[0] + k1 * p1[0] + k2 * p2[0] + k3 * p3[0], k0 * p0[1] + k1 * p1[1] + k2 * p2[1] + k3 * p3[1]];
}

/** Trace the outline as a polygon. Straight segments add only their start point. */
export function sampleOutline(anchors: PenAnchor[], closed = true, perSegment = 16): V2[] {
  const out: V2[] = [];
  const n = anchors.length;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const a = anchors[i], b = anchors[(i + 1) % n];
    const straight = len2(a.o) < 1e-9 && len2(b.i) < 1e-9;
    const steps = straight ? 1 : perSegment;
    for (let k = 0; k < steps; k++) out.push(bezierAt(a, b, k / steps));
  }
  if (!closed && n) out.push(anchors[n - 1].p);
  return out;
}

/** Split the curve from anchor `index` to the next at `t`, keeping its shape exactly. Returns the new anchor list. */
export function insertAnchor(anchors: PenAnchor[], index: number, t: number): PenAnchor[] {
  const n = anchors.length;
  const a = anchors[index], b = anchors[(index + 1) % n];
  const p0 = a.p, p1: V2 = [a.p[0] + a.o[0], a.p[1] + a.o[1]], p2: V2 = [b.p[0] + b.i[0], b.p[1] + b.i[1]], p3 = b.p;
  const lerp = (x: V2, y: V2): V2 => [x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t];
  const q0 = lerp(p0, p1), q1 = lerp(p1, p2), q2 = lerp(p2, p3);
  const r0 = lerp(q0, q1), r1 = lerp(q1, q2);
  const m = lerp(r0, r1);
  const out = anchors.map((x) => ({ p: [...x.p] as V2, i: [...x.i] as V2, o: [...x.o] as V2 }));
  out[index].o = sub2(q0, p0);
  out[(index + 1) % n].i = sub2(q2, p3);
  out.splice(index + 1, 0, { p: m, i: sub2(r0, m), o: sub2(r1, m) });
  return out;
}

/** Nearest point on the closed outline's curves: which segment, where along it, and how far away. */
export function nearestOnOutline(anchors: PenAnchor[], q: V2, perSegment = 24): { index: number; t: number; d: number } | null {
  let best: { index: number; t: number; d: number } | null = null;
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i], b = anchors[(i + 1) % anchors.length];
    for (let k = 0; k <= perSegment; k++) {
      const t = k / perSegment;
      const d = len2(sub2(bezierAt(a, b, t), q));
      if (!best || d < best.d) best = { index: i, t, d };
    }
  }
  return best;
}
