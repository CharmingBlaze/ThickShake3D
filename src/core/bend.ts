// Bend: shape the selection along a Bézier curve, for organic forms (a tail, a horn, a finger, a leaf).
// The selection lies along a straight rest line on one axis. A cubic Bézier with two ends and two handles starts on
// that line; moving its points carries every selected vertex along the curve, keeping its distance and direction from
// the line, turned with the curve (rotation-minimising, so it doesn't spin), with optional twist and taper.
//
// Several pieces can bend at once. Together, the whole selection follows one curve. Each piece, every separate
// connected part of the selection gets the same curve in its own terms, scaled to its own length: bend one finger's
// curve and all the selected fingers bend alike.
import * as THREE from 'three';
import { mirrorVerts } from './symmetry';
import type { Model, V3 } from './types';

export type BendAxis = 'auto' | 'x' | 'y' | 'z';

/** The curve, in a piece's own terms: each point is [along 0..1, sideways U, sideways V], sideways in piece lengths. */
export interface BendShape {
  pts: [V3, V3, V3, V3];
  /** Degrees of turn from start to end, around the curve. */
  twist: number;
  /** Size across the curve at each end; in between it changes smoothly. */
  startScale: number;
  endScale: number;
}

export interface BendPiece {
  verts: number[];
  base: V3[];
  /** Where the rest line starts, and how long it is. */
  origin: V3;
  length: number;
}

export interface BendSetup {
  /** The rest line's axis, 0 X, 1 Y, 2 Z; U and V are the next two, so A, U, V is right-handed. */
  axis: 0 | 1 | 2;
  pieces: BendPiece[];
  /** With symmetry: each selected vertex and its twin across X, which follows it mirrored. */
  mirror: [number, number][];
}

export const straightShape = (): BendShape => ({ pts: [[0, 0, 0], [1 / 3, 0, 0], [2 / 3, 0, 0], [1, 0, 0]], twist: 0, startScale: 1, endScale: 1 });

export const isStraight = (s: BendShape) => {
  const r = straightShape();
  return s.twist === 0 && s.startScale === 1 && s.endScale === 1 && s.pts.every((p, i) => p.every((x, k) => Math.abs(x - r.pts[i][k]) < 1e-9));
};

const axes = (a: number) => [a, (a + 1) % 3, (a + 2) % 3] as const;

/** The separate connected parts of a set of vertices, joined by the edges of faces between them. */
export function selectionPieces(m: Model, verts: Set<number>): number[][] {
  const parent = new Map<number, number>();
  verts.forEach((v) => parent.set(v, v));
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r)! !== r) r = parent.get(r)!;
    while (parent.get(v)! !== r) { const n = parent.get(v)!; parent.set(v, r); v = n; }
    return r;
  };
  for (const f of m.faces) {
    for (let i = 0; i < f.v.length; i++) {
      const a = f.v[i], b = f.v[(i + 1) % f.v.length];
      if (parent.has(a) && parent.has(b)) { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); }
    }
  }
  const groups = new Map<number, number[]>();
  verts.forEach((v) => { const r = find(v); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(v); });
  return [...groups.values()];
}

/** Get the selection ready to bend: its pieces, each with its rest line along the chosen axis. */
export function bendSetup(m: Model, verts: Set<number>, opts: { axis?: BendAxis; each?: boolean; mirrorX?: boolean } = {}): BendSetup {
  const all = [...verts].filter((v) => m.verts[v]);
  // The axis the selection is longest along, unless one is chosen.
  let axis: 0 | 1 | 2 = 1;
  if (opts.axis && opts.axis !== 'auto') axis = ({ x: 0, y: 1, z: 2 } as const)[opts.axis];
  else if (all.length) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of all) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.verts[v].p[k]); hi[k] = Math.max(hi[k], m.verts[v].p[k]); }
    const ext = hi.map((h, k) => h - lo[k]);
    axis = ext[0] > ext[1] + 1e-9 && ext[0] >= ext[2] ? 0 : ext[2] > ext[1] + 1e-9 ? 2 : 1;
  }
  const [a, u, w] = axes(axis);
  const lists = opts.each ? selectionPieces(m, new Set(all)) : [all];
  const pieces: BendPiece[] = [];
  for (const list of lists) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const v of list) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.verts[v].p[k]); hi[k] = Math.max(hi[k], m.verts[v].p[k]); }
    const length = hi[a] - lo[a];
    if (!(length > 1e-6)) continue;
    const origin: V3 = [0, 0, 0];
    origin[a] = lo[a];
    origin[u] = (lo[u] + hi[u]) / 2;
    origin[w] = (lo[w] + hi[w]) / 2;
    pieces.push({ verts: list, base: list.map((v) => [...m.verts[v].p] as V3), origin, length });
  }
  // Twins on the other side that aren't selected themselves follow, mirrored.
  const mirror: [number, number][] = [];
  if (opts.mirrorX) {
    const sel = new Set(all);
    mirrorVerts(m).forEach((o, v) => { if (sel.has(v) && o !== v && !sel.has(o)) mirror.push([v, o]); });
  }
  return { axis, pieces, mirror };
}

/** A curve point from a piece's own terms to the world. */
export function toWorld(setup: BendSetup, piece: BendPiece, l: V3): V3 {
  const [a, u, w] = axes(setup.axis);
  const out: V3 = [0, 0, 0];
  out[a] = piece.origin[a] + l[0] * piece.length;
  out[u] = piece.origin[u] + l[1] * piece.length;
  out[w] = piece.origin[w] + l[2] * piece.length;
  return out;
}

/** A world point to a piece's own terms. */
export function toLocal(setup: BendSetup, piece: BendPiece, p: V3): V3 {
  const [a, u, w] = axes(setup.axis);
  return [(p[a] - piece.origin[a]) / piece.length, (p[u] - piece.origin[u]) / piece.length, (p[w] - piece.origin[w]) / piece.length];
}

const bez = (p: THREE.Vector3[], t: number) => {
  const s = 1 - t;
  return p[0].clone().multiplyScalar(s * s * s).addScaledVector(p[1], 3 * s * s * t).addScaledVector(p[2], 3 * s * t * t).addScaledVector(p[3], t * t * t);
};
const bezTangent = (p: THREE.Vector3[], t: number) => {
  const s = 1 - t;
  const d = p[1].clone().sub(p[0]).multiplyScalar(3 * s * s)
    .addScaledVector(p[2].clone().sub(p[1]), 6 * s * t)
    .addScaledVector(p[3].clone().sub(p[2]), 3 * t * t);
  // A handle on top of its end gives no direction there: look a little further along instead.
  if (d.lengthSq() < 1e-14) return p[3].clone().sub(p[0]);
  return d;
};

/** Points along a piece's curve in the world, for drawing it. */
export function curvePoints(setup: BendSetup, piece: BendPiece, shape: BendShape, n = 32): V3[] {
  const cp = shape.pts.map((l) => new THREE.Vector3(...toWorld(setup, piece, l)));
  const out: V3[] = [];
  for (let i = 0; i <= n; i++) out.push(bez(cp, i / n).toArray() as V3);
  return out;
}

const STEPS = 64;

/** Move the selection to follow the curve, from where it was when the bend was set up. */
export function applyBend(m: Model, setup: BendSetup, shape: BendShape) {
  const [a, u, w] = axes(setup.axis);
  const A = new THREE.Vector3(); A.setComponent(a, 1);
  for (const piece of setup.pieces) {
    const cp = shape.pts.map((l) => new THREE.Vector3(...toWorld(setup, piece, l)));
    // Rotation-minimising frames along the curve: each step turns the last frame just enough to follow the tangent.
    const qs: THREE.Quaternion[] = [];
    const tans: THREE.Vector3[] = [];
    for (let i = 0; i <= STEPS; i++) {
      const tv = bezTangent(cp, i / STEPS).normalize();
      if (!i) qs.push(new THREE.Quaternion().setFromUnitVectors(A, tv));
      else qs.push(new THREE.Quaternion().setFromUnitVectors(tans[i - 1], tv).multiply(qs[i - 1]));
      tans.push(tv);
    }
    piece.verts.forEach((v, j) => {
      const b = piece.base[j];
      const t = Math.min(1, Math.max(0, (b[a] - piece.origin[a]) / piece.length));
      const f = t * STEPS, i0 = Math.min(STEPS - 1, Math.floor(f));
      const q = qs[i0].clone().slerp(qs[i0 + 1], f - i0);
      const off = new THREE.Vector3();
      off.setComponent(u, b[u] - piece.origin[u]);
      off.setComponent(w, b[w] - piece.origin[w]);
      // Taper eases from one end to the other; twist turns around the rest line before the curve turns it.
      const e = t * t * (3 - 2 * t);
      off.multiplyScalar(shape.startScale + (shape.endScale - shape.startScale) * e);
      if (shape.twist) off.applyAxisAngle(A, (shape.twist * Math.PI / 180) * t);
      off.applyQuaternion(q);
      const p = bez(cp, t).add(off);
      m.verts[v].p = [p.x, p.y, p.z];
    });
  }
  for (const [v, o] of setup.mirror) { const p = m.verts[v].p; m.verts[o].p = [-p[0], p[1], p[2]]; }
}
