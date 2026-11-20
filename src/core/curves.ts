// Curves (ported from 3Doddle): a drawn line becomes a tube, ribbon, rope, chain, foliage, tree, lathe and more.
// The result is baked into an ordinary piece; settings stay adjustable until the next edit (see startCurve in viewports).
import type { Prim } from './primitives';
import type { Model, V2, V3 } from './types';

export type P3 = readonly [number, number, number];
export type CurveKind = 'outline' | 'path' | 'blob' | 'capsule' | 'hair' | 'hair-strip' | 'rounded-hair' | 'ribbon' | 'tapered-tube' | 'rope' | 'square-sweep' | 'rail-sweep';
export type CurveType = 'polyline' | 'catmull-rom' | 'bezier';
export type CurveSolid = 'extrude' | 'lathe';
export type CurveResolution = 'low' | 'medium' | 'high';
export type CurveCap = 'flat' | 'round' | 'pointed' | 'open';
export type PathOutput = 'tube' | 'ribbon' | 'chain' | 'vine' | 'rope' | 'foliage' | 'tree' | 'cards' | 'object-array' | 'profile-sweep';
export type PathDistribution = 'spacing' | 'count' | 'fit';
export type PathProfile = 'round' | 'square' | 'rectangle' | 'rail';

export interface CurveParams {
  kind: CurveKind; curveType: CurveType; solid: CurveSolid; cyclic: boolean; radius: number; resolution: CurveResolution;
  blobInflation: number; tipStyle: 'pointed' | 'square';
  latheSegments: number; latheProfileRings: number; latheSmoothing: number; latheAngle: number; latheCaps: boolean;
  pathOutput: PathOutput; pathStartCap: CurveCap; pathEndCap: CurveCap; pathRadiusScale: number; pathRadialSegments: number;
  startScale: number; endScale: number; pathOffset: number; twist: number; pathSpacing: number;
  pathProfile: PathProfile; profileWidth: number; profileHeight: number; pathChainAlternating: boolean; pathCardCrossed: boolean;
  pathDistributionMode: PathDistribution; pathCount: number; pathStartPadding: number; pathEndPadding: number;
  pathRandomScale: number; pathRotation: number; pathRandomRotation: number; pathAlternateRotation: boolean; pathMirrorAlternate: boolean;
  pathSeed: number;
  /** A part (group id) copied along the path by Object Array. */
  pathSourceObject: number | null;
  /** Tile keeps texels square along the length; Stretch fits the texture to it once. Along and Around repeat it. */
  uvFit: 'tile' | 'stretch'; uvAlong: number; uvAround: number;
  cardShape: 'rect' | 'pointed';
}

export const DEFAULT_CURVE: CurveParams = {
  kind: 'path', curveType: 'catmull-rom', solid: 'extrude', cyclic: false, radius: 0.12, resolution: 'medium',
  blobInflation: 0.5, tipStyle: 'pointed',
  latheSegments: 16, latheProfileRings: 20, latheSmoothing: 0.15, latheAngle: 360, latheCaps: true,
  pathOutput: 'tube', pathStartCap: 'flat', pathEndCap: 'flat', pathRadiusScale: 1, pathRadialSegments: 8,
  startScale: 1, endScale: 1, pathOffset: 0, twist: 0, pathSpacing: 0.65,
  pathProfile: 'round', profileWidth: 1, profileHeight: 1, pathChainAlternating: true, pathCardCrossed: true,
  pathDistributionMode: 'spacing', pathCount: 8, pathStartPadding: 0, pathEndPadding: 0,
  pathRandomScale: 0, pathRotation: 0, pathRandomRotation: 0, pathAlternateRotation: false, pathMirrorAlternate: false,
  pathSeed: 1, pathSourceObject: null,
  uvFit: 'tile', uvAlong: 1, uvAround: 1, cardShape: 'rect',
};

export const CURVE_LABEL: Record<CurveKind, string> = {
  outline: 'Outline', path: 'Path', blob: 'Blob', capsule: 'Capsule', hair: 'Hair Paths', 'hair-strip': 'Hair Strips', 'rounded-hair': 'Rounded Hair',
  ribbon: 'Ribbon', 'tapered-tube': 'Tapered Tube', rope: 'Rope', 'square-sweep': 'Square Sweep', 'rail-sweep': 'Rail Sweep',
};

export const PATH_OUTPUT_LABEL: Record<PathOutput, string> = {
  tube: 'Tube', ribbon: 'Ribbon', chain: 'Chain', vine: 'Vine', rope: 'Rope', foliage: 'Foliage', tree: 'Tree', cards: 'Cards', 'object-array': 'Object Array', 'profile-sweep': 'Profile Sweep',
};

/** Kinds drawn as a closed loop. */
export const LOOP_KINDS: CurveKind[] = ['outline', 'blob'];

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(v) ? v : min));
const dist3 = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: P3, n: number): P3 => [a[0] * n, a[1] * n, a[2] * n];
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: P3): P3 => { const n = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };
const lerp3 = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const seeded = (seed: number) => { const v = Math.sin(seed * 12.9898) * 43758.5453; return v - Math.floor(v); };
const wrap01 = (v: number) => ((v % 1) + 1) % 1;

/** The right axis carried over from the last frame, so a path never flips or spins between rings. */
function stableRight(tangent: P3, previous: P3 | null): P3 {
  const t = norm(tangent);
  if (previous) {
    const p = sub(previous, mul(t, dot(previous, t)));
    if (Math.hypot(p[0], p[1], p[2]) > 1e-5) return norm(p);
  }
  const helper: P3 = Math.abs(t[1]) < 0.94 ? [0, 1, 0] : [1, 0, 0];
  return norm(cross(helper, t));
}

// ───────────────────────── sampling ─────────────────────────
/** Points along the curve. Smooth is Catmull-Rom through the points; Bézier uses auto-smooth handles a third of each span long. */
export function sampleCurve(points: readonly P3[], type: CurveType, steps: number, closed: boolean): P3[] {
  if (type === 'polyline' || points.length < 3) return [...points];
  const n = points.length, out: P3[] = [];
  const at = (i: number) => (closed ? points[(i + n) % n] : points[Math.max(0, Math.min(n - 1, i))]);
  for (let s = 0; s < (closed ? n : n - 1); s++) {
    const p0 = at(s - 1), p1 = at(s), p2 = at(s + 1), p3 = at(s + 2);
    const span = dist3(p1, p2);
    const h1 = type === 'bezier' ? add(p1, mul(norm(sub(p2, p0)), span / 3)) : add(p1, mul(sub(p2, p0), 1 / 6));
    const h2 = type === 'bezier' ? sub(p2, mul(norm(sub(p3, p1)), span / 3)) : sub(p2, mul(sub(p3, p1), 1 / 6));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, u = 1 - t;
      out.push([0, 1, 2].map((a) => u * u * u * p1[a] + 3 * u * u * t * h1[a] + 3 * u * t * t * h2[a] + t * t * t * p2[a]) as unknown as P3);
    }
  }
  if (!closed) out.push(points[n - 1]);
  return out;
}

const curveSteps = (r: CurveResolution) => (r === 'high' ? 12 : r === 'medium' ? 5 : 2);

/** Low, Medium and High poly: picking a level sets the counts around and along together. Each stays adjustable after. */
export const DETAIL_PRESETS: Record<CurveResolution, Partial<CurveParams>> = {
  low: { resolution: 'low', pathRadialSegments: 5, latheSegments: 8, latheProfileRings: 8 },
  medium: { resolution: 'medium', pathRadialSegments: 8, latheSegments: 16, latheProfileRings: 20 },
  high: { resolution: 'high', pathRadialSegments: 14, latheSegments: 32, latheProfileRings: 48 },
};

function polylineLength(pts: readonly P3[]) { let l = 0; for (let i = 1; i < pts.length; i++) l += dist3(pts[i - 1], pts[i]); return l; }
function pointAlong(pts: readonly P3[], t: number): P3 {
  if (pts.length === 1) return pts[0];
  const target = t * polylineLength(pts);
  let walked = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist3(pts[i - 1], pts[i]);
    if (target <= walked + d) return lerp3(pts[i - 1], pts[i], d > 1e-9 ? (target - walked) / d : 0);
    walked += d;
  }
  return pts[pts.length - 1];
}
const resample = (pts: readonly P3[], count: number) => Array.from({ length: Math.max(2, count) }, (_, i) => pointAlong(pts, i / (Math.max(2, count) - 1)));
const dropRepeats = (pts: readonly P3[]) => pts.filter((p, i) => i === 0 || dist3(p, pts[i - 1]) > 1e-6);

/** Remove freehand points the line doesn't need (Ramer-Douglas-Peucker). */
export function simplifyStroke(pts: P3[], tolerance: number): P3[] {
  if (pts.length < 3) return pts;
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const walk = (a: number, b: number) => {
    let far = -1, best = tolerance;
    const ab = sub(pts[b], pts[a]), len = dot(ab, ab);
    for (let i = a + 1; i < b; i++) {
      const ap = sub(pts[i], pts[a]);
      const t = len > 1e-12 ? clamp(dot(ap, ab) / len, 0, 1) : 0;
      const d = dist3(pts[i], add(pts[a], mul(ab, t)));
      if (d > best) { best = d; far = i; }
    }
    if (far >= 0) { keep[far] = true; walk(a, far); walk(far, b); }
  };
  walk(0, pts.length - 1);
  return pts.filter((_, i) => keep[i]);
}

// ───────────────────────── mesh data ─────────────────────────
interface F { v: number[]; uv?: number[] }
export interface MeshData { positions: P3[]; faces: F[] }
const faceOf = (v: number[]): F => ({ v });
const reversed = (f: F): F => {
  const uv = f.uv && f.v.flatMap((_, i) => { const k = f.v.length - 1 - i; return [f.uv![k * 2], f.uv![k * 2 + 1]]; });
  return { v: [...f.v].reverse(), uv };
};
function merge(parts: MeshData[]): MeshData {
  const out: MeshData = { positions: [], faces: [] };
  for (const p of parts) {
    const off = out.positions.length;
    for (const q of p.positions) out.positions.push(q);
    for (const f of p.faces) out.faces.push({ ...f, v: f.v.map((i) => i + off) });
  }
  return out;
}

interface Frame { point: P3; tangent: P3; right: P3; up: P3; progress: number; bend?: P3; miter?: number }

/** Parallel-transport frames; a closed path spreads the leftover turn around the loop so its seam lines up. */
function pathFrames(pts: readonly P3[], closed: boolean): Frame[] {
  const n = pts.length;
  const lengths = [0];
  for (let i = 1; i < n; i++) lengths.push(lengths[i - 1] + dist3(pts[i - 1], pts[i]));
  const total = closed ? lengths[n - 1] + dist3(pts[n - 1], pts[0]) : lengths[n - 1];
  let right: P3 | null = null;
  const frames = pts.map((point, i): Frame => {
    const prev = pts[i === 0 ? (closed ? n - 1 : 0) : i - 1], next = pts[i === n - 1 ? (closed ? 0 : n - 1) : i + 1];
    const end = !closed && (i === 0 || i === n - 1);
    const into = norm(sub(point, prev)), out = norm(sub(next, point)), both = add(into, out);
    const tangent = end ? (i === 0 ? out : into) : Math.hypot(both[0], both[1], both[2]) < 1e-6 ? into : norm(both);
    right = stableRight(tangent, right);
    const cos = dot(tangent, into), corner = !end && cos < 0.985 && cos > 0.05;
    return { point, tangent, right, up: norm(cross(tangent, right)), progress: total > 1e-9 ? lengths[i] / total : 0, bend: corner ? norm(sub(out, into)) : undefined, miter: corner ? Math.min(1 / cos, 3) - 1 : 0 };
  });
  if (closed && n > 2) {
    const f0 = frames[0], back = stableRight(f0.tangent, frames[n - 1].right);
    const turn = Math.atan2(dot(back, f0.up), dot(back, f0.right));
    frames.forEach((f, i) => {
      const a = -turn * (i / n), c = Math.cos(a), s = Math.sin(a), r = f.right, u = f.up;
      f.right = add(mul(r, c), mul(u, s));
      f.up = add(mul(u, c), mul(r, -s));
    });
  }
  return frames;
}

function frameAlong(route: readonly P3[], progress: number, previous: P3 | null): Frame {
  const closed = route.length > 2 && dist3(route[0], route[route.length - 1]) < 1e-6;
  const step = 0.002;
  const before = closed ? wrap01(progress - step) : Math.max(0, progress - step);
  const after = closed ? wrap01(progress + step) : Math.min(1, progress + step);
  const tangent = norm(sub(pointAlong(route, after), pointAlong(route, before)));
  const right = stableRight(tangent, previous);
  return { point: pointAlong(route, progress), tangent, right, up: norm(cross(tangent, right)), progress };
}

// ───────────────────────── sweeps ─────────────────────────
type SectionShape = 'round' | 'square' | 'flat' | 'ibeam';
interface SweepOptions {
  radius: number; sides: number; section: SectionShape; closed: boolean; startScale: number; endScale: number; width: number; height: number; twist: number; offset: number; startCap: CurveCap; endCap: CurveCap;
  widthAt?: (t: number) => number; uv?: Pick<CurveParams, 'uvFit' | 'uvAlong' | 'uvAround'>;
}
type Ctx = CurveParams & { widthAt: (t: number) => number };

function sectionPoints(o: SweepOptions): [number, number][] {
  // Flat is a ribbon with a little thickness: one-sided materials would hide a bare sheet from behind.
  if (o.section === 'flat') return [[1, -0.06], [1, 0.06], [-1, 0.06], [-1, -0.06]];
  if (o.section === 'square') return [[1, -1], [1, 1], [-1, 1], [-1, -1]];
  if (o.section === 'ibeam') return [[-1, -1], [1, -1], [1, -0.72], [0.28, -0.72], [0.28, 0.72], [1, 0.72], [1, 1], [-1, 1], [-1, 0.72], [-0.28, 0.72], [-0.28, -0.72], [-1, -0.72]];
  const n = Math.max(3, Math.round(o.sides));
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return [Math.cos(a), Math.sin(a)] as [number, number]; });
}

function sweepMesh(points: readonly P3[], o: SweepOptions): MeshData {
  const pts = dropRepeats(points);
  const positions: P3[] = [], faces: F[] = [];
  if (pts.length < 2) return { positions, faces };
  const section = sectionPoints(o), n = section.length;
  const frames = pathFrames(pts, o.closed);
  const size = (f: Frame) => o.radius * (o.startScale + (o.endScale - o.startScale) * f.progress) * (o.widthAt?.(f.progress) ?? 1);
  const ringAt = (f: Frame, factor = 1, lift = 0) => {
    const a = (o.twist * f.progress * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), r = size(f) * factor;
    const center = add(add(f.point, mul(f.right, o.offset)), mul(f.tangent, lift));
    return section.map(([sx, sy]) => {
      const x = sx * r * o.width, y = sy * r * o.height;
      let at = add(mul(f.right, x * c - y * s), mul(f.up, x * s + y * c));
      if (f.bend) at = add(at, mul(f.bend, dot(at, f.bend) * f.miter!));
      return positions.push(add(center, at)) - 1;
    });
  };
  // One repeat around, and as many along as keeps the texels square (or one over the whole length).
  const fit = o.uv?.uvFit ?? 'tile', along = o.uv?.uvAlong ?? 1, around = o.uv?.uvAround ?? 1;
  const flat = o.section === 'flat';
  const across = Math.max(1e-6, flat ? 2 * o.radius * o.width : 2 * Math.PI * o.radius * (o.width + o.height) / 2);
  const length = polylineLength(pts) + (o.closed ? dist3(pts[pts.length - 1], pts[0]) : 0);
  const vOf = (t: number) => (fit === 'stretch' ? t : (t * length) / across) * along;
  const U = flat ? [0, 0, around, around] : Array.from({ length: n + 1 }, (_, k) => (k / n) * around);
  const stitch = (a: number[], b: number[], v0: number, v1: number) => {
    for (let k = 0; k < n; k++) {
      const l = (k + 1) % n, u0 = U[k], u1 = flat ? U[l] : U[k + 1];
      faces.push({ v: [a[k], a[l], b[l], b[k]], uv: [u0, v0, u1, v0, u1, v1, u0, v1] });
    }
  };
  const rings = frames.map((f) => ringAt(f));
  for (let i = 0; i < (o.closed ? rings.length : rings.length - 1); i++) stitch(rings[i], rings[(i + 1) % rings.length], vOf(frames[i].progress), vOf(frames[(i + 1) % rings.length].progress || 1));
  const cap = (ring: number[], f: Frame, style: CurveCap, sign: 1 | -1) => {
    if (style === 'open') return;
    const round = style === 'round' && o.section !== 'flat';
    let cur = ring;
    const r = size(f);
    if (round) for (const k of [1, 2]) {
      const phi = (k / 3) * (Math.PI / 2);
      const next = ringAt(f, Math.cos(phi), sign * Math.sin(phi) * r);
      const v = vOf(f.progress);
      if (sign > 0) stitch(cur, next, v, v); else stitch(next, cur, v, v);
      cur = next;
    }
    if (style === 'flat' || o.section === 'flat') { const face = faceOf([...cur]); faces.push(sign > 0 ? face : reversed(face)); return; }
    const reach = round ? r : Math.max(r, o.radius * 0.35) * 1.5;
    const tip = positions.push(add(add(f.point, mul(f.right, o.offset)), mul(f.tangent, sign * reach))) - 1;
    for (let k = 0; k < n; k++) { const l = (k + 1) % n; faces.push(faceOf(sign > 0 ? [cur[k], cur[l], tip] : [cur[l], cur[k], tip])); }
  };
  if (!o.closed) {
    cap(rings[0], frames[0], o.startCap, -1);
    cap(rings[rings.length - 1], frames[frames.length - 1], o.endCap, 1);
  }
  return { positions, faces };
}

const sweepOptions = (c: Ctx, radius: number, section: SectionShape, sides: number): SweepOptions => ({ radius, sides, section, closed: c.cyclic, startScale: c.startScale, endScale: c.endScale, width: c.profileWidth, height: c.profileHeight, twist: c.twist, offset: c.pathOffset, startCap: c.pathStartCap, endCap: c.pathEndCap, widthAt: c.widthAt, uv: c });

function curveMesh(points: readonly P3[], c: Ctx, lookup: (id: number) => MeshData | null): MeshData {
  if ((c.kind === 'outline' || c.kind === 'blob' || c.kind === 'capsule') && c.cyclic && points.length >= 3) {
    if (c.kind === 'outline') return extrudedPolygon(points, Math.max(0.02, c.radius * 0.8));
    // A blob is a pillow: the outline swells toward the middle instead of being a flat slab.
    return pillowMesh(points, Math.max(0.02, c.radius * (c.kind === 'blob' ? 1 + c.blobInflation * 4 : 1.5)));
  }
  if (c.kind === 'path') return pathOutputMesh(points, c, lookup);
  if (c.kind === 'rope') return braidedRope(points, c, c.radius);
  const hair = c.kind === 'hair' || c.kind === 'hair-strip' || c.kind === 'rounded-hair';
  const tapered = c.kind === 'tapered-tube' || hair;
  return sweepMesh(points, {
    ...sweepOptions(c, c.radius * (hair ? 0.55 : 1), c.kind === 'ribbon' || c.kind === 'hair-strip' ? 'flat' : c.kind === 'square-sweep' ? 'square' : c.kind === 'rail-sweep' ? 'ibeam' : 'round', c.pathRadialSegments),
    endScale: tapered ? 0.05 : c.endScale,
    // A lock of hair starts a little narrow, is fullest near the root, then tapers.
    widthAt: hair ? (t) => (t < 0.2 ? 0.72 + 0.28 * Math.sin((t / 0.2) * (Math.PI / 2)) : 1) : c.widthAt,
    startCap: c.kind === 'capsule' ? 'round' : c.pathStartCap,
    endCap: c.kind === 'capsule' ? 'round' : c.tipStyle === 'pointed' && tapered ? 'pointed' : c.pathEndCap,
  });
}

function pathOutputMesh(points: readonly P3[], c: Ctx, lookup: (id: number) => MeshData | null): MeshData {
  const radius = c.radius * c.pathRadiusScale;
  switch (c.pathOutput) {
    case 'ribbon': return sweepMesh(points, sweepOptions(c, radius, 'flat', 4));
    case 'cards': return repeatedMesh(points, c, 'card');
    case 'chain': return repeatedMesh(points, c, 'chain');
    case 'object-array': return repeatedMesh(points, c, 'box', c.pathSourceObject === null ? null : centred(lookup(c.pathSourceObject)));
    case 'rope': return braidedRope(points, c, radius);
    case 'vine': return vineMesh(points, c, radius);
    case 'foliage': return foliageMesh(points, c, radius);
    case 'tree': return treeMesh(points, c, radius);
    case 'profile-sweep': {
      if (c.pathProfile === 'round') return sweepMesh(points, sweepOptions(c, radius, 'round', c.pathRadialSegments));
      const o = sweepOptions(c, radius, 'square', 4);
      // Square keeps its sides equal, rectangle takes both sizes, rail is an I-beam.
      return sweepMesh(points, { ...o, section: c.pathProfile === 'rail' ? 'ibeam' : 'square', height: c.pathProfile === 'square' ? o.width : o.height });
    }
    default: return sweepMesh(points, sweepOptions(c, radius, 'round', c.pathRadialSegments));
  }
}

function braidedRope(points: readonly P3[], c: Ctx, radius: number): MeshData {
  const route = c.cyclic && points.length > 2 ? [...points, points[0]] : points;
  const length = polylineLength(route);
  const count = Math.max(points.length, Math.min(180, Math.ceil(length / Math.max(0.04, radius * 0.55)) + 1));
  let line = resample(route, count);
  if (c.cyclic && line.length > 2) line = line.slice(0, -1);
  const frames = pathFrames(line, c.cyclic);
  // A closed braid needs whole turns or its strands wouldn't meet at the seam.
  const auto = Math.max(1, length / Math.max(0.2, radius * 8));
  const turns = c.twist === 0 ? (c.cyclic ? Math.round(auto) : auto) * Math.PI * 2 : (c.twist * Math.PI) / 180;
  const parts: MeshData[] = [];
  for (let strand = 0; strand < 3; strand++) {
    const pts = frames.map((f) => {
      const a = f.progress * turns + (strand * Math.PI * 2) / 3;
      const r = radius * 0.62 * c.widthAt(f.progress);
      return add(f.point, add(mul(f.right, Math.cos(a) * r), mul(f.up, Math.sin(a) * r)));
    });
    parts.push(sweepMesh(pts, { ...sweepOptions(c, radius * 0.42, 'round', Math.max(6, c.pathRadialSegments - 1)), twist: 0, offset: 0 }));
  }
  return merge(parts);
}

const twig = (pts: P3[], radius: number, sides: number): MeshData => sweepMesh(pts, { radius, sides, section: 'round', closed: false, startScale: 1, endScale: 0.08, width: 1, height: 1, twist: 0, offset: 0, startCap: 'flat', endCap: 'pointed' });

function vineMesh(points: readonly P3[], c: Ctx, radius: number): MeshData {
  const stem = sweepMesh(points, sweepOptions(c, radius * 0.58, 'round', Math.max(6, c.pathRadialSegments)));
  const leaves = repeatedMesh(points, { ...c, pathSpacing: Math.max(0.18, c.pathSpacing), pathDistributionMode: 'fit', pathAlternateRotation: true, pathRandomRotation: Math.max(18, c.pathRandomRotation), pathRandomScale: Math.max(0.14, c.pathRandomScale) }, 'leaf');
  const route = c.cyclic && points.length > 2 ? [...points, points[0]] : points;
  const count = Math.min(32, Math.floor(polylineLength(route) / Math.max(0.35, c.pathSpacing * 2)));
  const tendrils: MeshData[] = [];
  let prev: P3 | null = null;
  for (let i = 0; i < count; i++) {
    const f = frameAlong(route, (i + 0.65) / Math.max(1, count), prev);
    prev = f.right;
    const rnd = seeded(c.pathSeed + i * 29), a = i * 2.399963 + rnd * 0.8;
    const out = add(mul(f.right, Math.cos(a)), mul(f.up, Math.sin(a)));
    const reach = radius * c.profileWidth * (2.2 + rnd * 1.8);
    const start = add(f.point, mul(out, radius * 0.45));
    tendrils.push(twig([start, add(add(start, mul(out, reach * 0.55)), mul(f.tangent, reach * 0.18)), add(add(start, mul(out, reach)), mul(f.tangent, -reach * 0.08))], Math.max(0.008, radius * 0.12), 5));
  }
  return merge([stem, leaves, ...tendrils]);
}

function foliageMesh(points: readonly P3[], c: Ctx, radius: number): MeshData {
  const route = c.cyclic && points.length > 2 ? [...points, points[0]] : points;
  const count = c.pathDistributionMode === 'count' ? c.pathCount : Math.max(1, Math.min(120, Math.round(polylineLength(route) / Math.max(0.12, c.pathSpacing)) + (c.cyclic ? 0 : 1)));
  const parts: MeshData[] = [];
  let prev: P3 | null = null;
  for (let i = 0; i < count; i++) {
    const progress = count === 1 ? 0.5 : i / (c.cyclic ? count : count - 1);
    const f = frameAlong(route, progress, prev);
    prev = f.right;
    const rnd = seeded(c.pathSeed + i * 43);
    const scale = Math.max(0.2, (c.startScale + (c.endScale - c.startScale) * progress) * (1 + (rnd * 2 - 1) * Math.max(0.12, c.pathRandomScale)) * c.widthAt(progress));
    const leaves = c.pathCardCrossed ? 5 : 3;
    for (let l = 0; l < leaves; l++) {
      const a = (c.pathRotation * Math.PI) / 180 + (l / leaves) * Math.PI * 2 + rnd * 0.65;
      const dir = norm(add(mul(f.tangent, 0.34 + l * 0.04), add(mul(f.right, Math.cos(a)), mul(f.up, Math.sin(a)))));
      const width = Math.max(0.03, radius * c.profileWidth * 2.4 * scale);
      parts.push(placed(leafMesh(width, Math.max(width * 1.35, radius * c.profileHeight * 4.2 * scale)), f.point, 1, a * 0.22, l % 2 === 1, dir, true, stableRight(dir, f.right)));
    }
  }
  return merge(parts);
}

function foliageCluster(center: P3, f: Frame, size: number, seed: number, count: number): MeshData[] {
  const parts: MeshData[] = [];
  for (let i = 0; i < count; i++) {
    const rnd = seeded(seed + i * 37), a = (i / count) * Math.PI * 2 + rnd * 0.7;
    const out = add(mul(f.right, Math.cos(a)), mul(f.up, Math.sin(a)));
    const dir = norm(add(mul(f.tangent, 0.18 + rnd * 0.3), out));
    parts.push(placed(leafMesh(Math.max(0.025, size * (0.55 + rnd * 0.22)), size * (1.25 + rnd * 0.42)), add(center, mul(out, size * 0.1)), 1, rnd * 0.45, i % 2 === 1, dir, true, stableRight(dir, f.right)));
  }
  return parts;
}

function treeMesh(points: readonly P3[], c: Ctx, radius: number): MeshData {
  // The trunk flares out at the root.
  const flare = (t: number) => c.widthAt(t) * (t < 0.14 ? 1 + 0.45 * (1 - t / 0.14) ** 2 : 1);
  const parts: MeshData[] = [sweepMesh(points, { ...sweepOptions(c, radius, 'round', Math.max(7, c.pathRadialSegments)), closed: false, startCap: 'flat', endCap: 'pointed', widthAt: flare })];
  const count = Math.max(2, Math.min(36, Math.round(polylineLength(points) / Math.max(0.28, c.pathSpacing))));
  let prev: P3 | null = null;
  for (let i = 0; i < count; i++) {
    const progress = 0.2 + ((i + 0.45) / count) * 0.68;
    const f = frameAlong(points, progress, prev);
    prev = f.right;
    const rnd = seeded(c.pathSeed + i * 61), a = i * 2.399963 + rnd * 0.9;
    const dir = norm(add(mul(f.tangent, 0.32 + progress * 0.25), add(mul(f.right, Math.cos(a)), mul(f.up, Math.sin(a)))));
    const reach = Math.max(radius * 3.5, c.pathSpacing * 0.72) * c.profileWidth * (0.72 + rnd * 0.55) * (1.15 - progress * 0.45);
    const tip = add(add(f.point, mul(dir, reach)), mul(f.tangent, reach * 0.2));
    parts.push(twig([f.point, add(add(f.point, mul(dir, reach * 0.52)), mul(f.tangent, reach * 0.12)), tip], Math.max(0.015, radius * (0.34 - progress * 0.12)), Math.max(5, c.pathRadialSegments - 2)));
    parts.push(...foliageCluster(tip, { ...f, tangent: dir }, radius * c.profileHeight * (2.6 + rnd), c.pathSeed + i * 101, c.pathCardCrossed ? 6 : 4));
    // Two side twigs split off each branch, so the crown isn't a row of single sticks.
    for (const side of [-1, 1]) {
      const start = lerp3(f.point, tip, side < 0 ? 0.5 : 0.72);
      const out = norm(add(mul(dir, 0.75), add(mul(f.right, Math.cos(a + side * 1.5) * 0.8), mul(f.up, Math.sin(a + side * 1.5) * 0.8))));
      const end = add(start, mul(out, reach * 0.42));
      parts.push(twig([start, add(start, mul(out, reach * 0.22)), end], Math.max(0.01, radius * 0.12), 5));
      parts.push(...foliageCluster(end, { ...f, tangent: out }, radius * c.profileHeight * (1.7 + rnd * 0.6), c.pathSeed + i * 131 + side, c.pathCardCrossed ? 4 : 3));
    }
  }
  const crown = frameAlong(points, 0.96, prev);
  parts.push(...foliageCluster(crown.point, crown, radius * c.profileHeight * 4.2, c.pathSeed + 701, c.pathCardCrossed ? 10 : 7));
  return merge(parts);
}

// ───────────────────────── pieces along a path ─────────────────────────
function repeatedMesh(points: readonly P3[], c: Ctx, kind: 'card' | 'chain' | 'box' | 'leaf', source: MeshData | null = null): MeshData {
  const closedRoute = c.cyclic && points.length > 2;
  const route = closedRoute ? [...points, points[0]] : points;
  const length = polylineLength(route);
  const usable = Math.max(0, length - c.pathStartPadding - c.pathEndPadding);
  const loop = closedRoute && c.pathStartPadding === 0 && c.pathEndPadding === 0;
  const spacing = Math.max(0.01, c.pathSpacing);
  // Spacing keeps the exact gap and leaves any remainder at the end, Fit stretches the gap to reach it, Count sets the number.
  const exact = c.pathDistributionMode === 'spacing' && !loop;
  const count = Math.max(1, Math.min(200, c.pathDistributionMode === 'count' ? c.pathCount : exact ? Math.floor(usable / spacing) + 1 : Math.round(usable / spacing) + (loop ? 0 : 1)));
  const gap = exact ? spacing : count > 1 ? usable / (loop ? count : count - 1) : usable;
  const parts: MeshData[] = [];
  let right: P3 | null = null;
  for (let i = 0; i < count; i++) {
    const startT = length > 0 ? Math.min(1, c.pathStartPadding / length) : 0, endT = length > 0 ? Math.max(startT, 1 - c.pathEndPadding / length) : 1;
    const fraction = exact ? (usable > 0 ? (i * gap) / usable : 0) : count === 1 ? 0.5 : i / (loop ? count : count - 1);
    const t = startT + (endT - startT) * fraction;
    const step = Math.min(0.02, Math.max(0.0005, (gap / Math.max(length, 1e-6)) * 0.2));
    const tangent = norm(sub(pointAlong(route, loop ? wrap01(t + step) : Math.min(1, t + step)), pointAlong(route, loop ? wrap01(t - step) : Math.max(0, t - step))));
    right = stableRight(tangent, right);
    const rnd = seeded(c.pathSeed + i * 17);
    const scale = Math.max(0.05, (c.startScale + (c.endScale - c.startScale) * fraction) * (1 + (rnd * 2 - 1) * c.pathRandomScale) * c.widthAt(fraction));
    const width = c.radius * c.profileWidth * scale * (kind === 'leaf' ? 3 : 2);
    const height = c.radius * c.profileHeight * scale * (kind === 'card' || kind === 'leaf' ? 5 : 2);
    const alternating = c.pathAlternateRotation || (kind === 'chain' && c.pathChainAlternating);
    const angle = ((c.pathRotation + (alternating && i % 2 ? 90 : 0) + (rnd * 2 - 1) * c.pathRandomRotation) * Math.PI) / 180;
    let part: MeshData;
    if (kind === 'card') part = cardMesh(width, height, c.pathCardCrossed, c.cardShape);
    else if (kind === 'leaf') part = leafMesh(width, height);
    else if (kind === 'chain') {
      // Oval links long enough that each passes through the next, wide enough to let it through.
      const wide = Math.max(0.02, c.radius * c.pathRadiusScale * 1.6 * scale);
      const tube = wide * clamp(0.28 * c.profileHeight, 0.1, 0.45);
      part = linkMesh(Math.max(wide, gap * 0.5 + tube * 1.6), wide, tube, c.resolution === 'low' ? 5 : 8, c.resolution === 'low' ? 6 : 8, c);
    } else part = source ?? boxMesh(width, height * 0.55, width * 0.55);
    parts.push(placed(part, pointAlong(route, t), source ? scale : 1, angle, c.pathMirrorAlternate && i % 2 === 1, tangent, kind === 'chain', right));
  }
  return merge(parts);
}

/** A part's faces as mesh data, for Object Array. */
export function groupMeshData(m: Model, groupId: number): MeshData | null {
  const map = new Map<number, number>(), positions: P3[] = [], faces: F[] = [];
  for (const f of m.faces) {
    if (f.g !== groupId) continue;
    const v = f.v.map((i) => { let k = map.get(i); if (k === undefined) { k = positions.push(m.verts[i].p) - 1; map.set(i, k); } return k; });
    faces.push({ v, uv: f.uv.flatMap((u) => [u[0], 1 - u[1]]) });
  }
  return faces.length ? { positions, faces } : null;
}

/** Another part's mesh moved so its centre is at the origin. */
function centred(m: MeshData | null): MeshData | null {
  if (!m?.positions.length || !m.faces.length) return null;
  const lo = [0, 1, 2].map((a) => Math.min(...m.positions.map((p) => p[a]))), hi = [0, 1, 2].map((a) => Math.max(...m.positions.map((p) => p[a])));
  const c: P3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  return { positions: m.positions.map((p) => sub(p, c)), faces: m.faces };
}

/** Put a piece on the path. `upright` stands it along the tangent (chain links, leaves), a mirrored basis, so its faces flip back. */
function placed(mesh: MeshData, point: P3, scale: number, angle: number, mirror: boolean, tangent: P3, upright: boolean, frameRight: P3 | null): MeshData {
  const forward = norm(tangent);
  const baseRight = frameRight ?? stableRight(forward, null), baseUp = norm(cross(forward, baseRight));
  const c = Math.cos(angle), s = Math.sin(angle);
  const right = add(mul(baseRight, c), mul(baseUp, s)), up = add(mul(baseUp, c), mul(baseRight, -s));
  return {
    positions: mesh.positions.map(([rx, ry, rz]) => {
      const x = rx * scale * (mirror ? -1 : 1), y = ry * scale, z = rz * scale;
      return add(point, upright ? add(add(mul(right, x), mul(forward, y)), mul(up, z)) : add(add(mul(right, x), mul(up, y)), mul(forward, z)));
    }),
    faces: mesh.faces.map((f) => (mirror !== upright ? reversed(f) : { ...f })),
  };
}

function newell(points: readonly P3[]): P3 {
  let n: P3 = [0, 0, 0];
  points.forEach((p, i) => { const q = points[(i + 1) % points.length]; n = add(n, [(p[1] - q[1]) * (p[2] + q[2]), (p[2] - q[2]) * (p[0] + q[0]), (p[0] - q[0]) * (p[1] + q[1])]); });
  return norm(n);
}

function extrudedPolygon(points: readonly P3[], depth: number, fitUV = false): MeshData {
  // Newell's normal: right for concave outlines too.
  const half = mul(newell(points), depth / 2), n = points.length;
  const positions = [...points.map((p) => sub(p, half)), ...points.map((p) => add(p, half))];
  const faces: F[] = [faceOf([...points.keys()].reverse()), faceOf([...points.keys()].map((i) => i + n))];
  if (fitUV) {
    // Both flat sides show the whole texture (cards).
    const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]), x0 = Math.min(...xs), y0 = Math.min(...ys), w = Math.max(...xs) - x0 || 1, h = Math.max(...ys) - y0 || 1;
    for (const f of faces) f.uv = f.v.flatMap((i) => { const p = positions[i]; return [(p[0] - x0) / w, (p[1] - y0) / h]; });
  }
  for (let i = 0; i < n; i++) faces.push(faceOf([i, (i + 1) % n, (i + 1) % n + n, i + n]));
  return { positions, faces };
}

/** Pillow: rings step in from the outline and up to the thickness, on both sides. */
function pillowMesh(points: readonly P3[], depth: number): MeshData {
  const up = newell(points), n = points.length;
  const mid = mul(points.reduce((s, p) => add(s, p), [0, 0, 0] as P3), 1 / n);
  const positions: P3[] = [...points], faces: F[] = [];
  const ring = (phi: number, side: 1 | -1) => points.map((p) => positions.push(add(lerp3(p, mid, (1 - Math.cos(phi)) * 0.82), mul(up, (side * Math.sin(phi) * depth) / 2))) - 1);
  for (const side of [1, -1] as const) {
    let cur = [...points.keys()];
    for (const k of [1, 2, 3]) {
      const next = ring((k / 3.4) * (Math.PI / 2), side);
      for (let i = 0; i < n; i++) { const l = (i + 1) % n; faces.push(faceOf(side > 0 ? [cur[i], cur[l], next[l], next[i]] : [next[i], next[l], cur[l], cur[i]])); }
      cur = next;
    }
    faces.push(faceOf(side > 0 ? cur : [...cur].reverse()));
  }
  return { positions, faces };
}

function cardMesh(width: number, height: number, crossed: boolean, shape: CurveParams['cardShape']): MeshData {
  // A rectangle shows a whole foliage texture (use a cut-out material); the pointed one reads as a leaf without one.
  const outline: P3[] = shape === 'rect'
    ? [[-width * 0.5, 0, 0], [width * 0.5, 0, 0], [width * 0.5, height, 0], [-width * 0.5, height, 0]]
    : [[-width * 0.5, 0, 0], [width * 0.5, 0, 0], [width * 0.34, height * 0.72, 0], [0, height, 0], [-width * 0.34, height * 0.72, 0]];
  const card = extrudedPolygon(outline, Math.max(0.006, width * 0.025), true);
  if (!crossed) return card;
  // The second card turned a quarter about the card's own upright axis.
  return merge([card, { positions: card.positions.map(([x, y, z]): P3 => [z, y, -x]), faces: card.faces }]);
}

/** A leaf: pointed at the tip, folded along its midrib and drooping toward the end. */
function leafMesh(width: number, height: number): MeshData {
  const rows = 4, thick = Math.max(0.003, width * 0.025), positions: P3[] = [], uvs: number[][] = [];
  const add1 = (x: number, y: number, z: number) => { uvs.push([x / width + 0.5, y / height]); return positions.push([x, y, z]) - 1; };
  const droop = (t: number) => -height * 0.2 * t * t;
  const base = add1(0, 0, 0);
  const L = [base], R = [base], T = [base], B = [base];
  for (let r = 1; r < rows; r++) {
    const t = r / rows, hw = width * 0.5 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.8)), 0.8), y = height * t, z = droop(t), fold = hw * 0.35;
    L.push(add1(-hw, y, z + fold)); R.push(add1(hw, y, z + fold)); T.push(add1(0, y, z + thick)); B.push(add1(0, y, z - thick));
  }
  const tip = add1(0, height, droop(1));
  L.push(tip); R.push(tip); T.push(tip); B.push(tip);
  const faces: F[] = [];
  const quad = (v: number[]) => { const u = v.filter((x, i) => x !== v[(i + 1) % v.length]); if (u.length >= 3) faces.push({ v: u, uv: u.flatMap((i) => uvs[i]) }); };
  for (let r = 0; r < rows; r++) {
    quad([L[r], T[r], T[r + 1], L[r + 1]]); quad([T[r], R[r], R[r + 1], T[r + 1]]);
    quad([B[r], L[r], L[r + 1], B[r + 1]]); quad([R[r], B[r], B[r + 1], R[r + 1]]);
  }
  return { positions, faces };
}

/** One chain link: a tube around an oval, long along Y. */
function linkMesh(halfLength: number, halfWidth: number, tube: number, arcSteps: number, sides: number, c: Ctx): MeshData {
  const straight = Math.max(0, halfLength - halfWidth), pts: P3[] = [];
  for (const [cy, a0] of [[straight, 0], [-straight, Math.PI]] as const) {
    for (let i = 0; i <= arcSteps; i++) { const a = a0 + (i / arcSteps) * Math.PI; pts.push([Math.cos(a) * halfWidth, cy + Math.sin(a) * halfWidth, 0]); }
  }
  return sweepMesh(pts, { radius: tube, sides, section: 'round', closed: true, startScale: 1, endScale: 1, width: 1, height: 1, twist: 0, offset: 0, startCap: 'flat', endCap: 'flat', uv: c });
}

function boxMesh(sx: number, sy: number, sz: number): MeshData {
  const x = sx / 2, y = sy / 2, z = sz / 2;
  return { positions: [[-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z], [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]], faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [3, 7, 6, 2], [0, 4, 7, 3], [1, 2, 6, 5]].map((v) => ({ v, uv: [0, 0, 1, 0, 1, 1, 0, 1] })) };
}

// ───────────────────────── lathe ─────────────────────────
/** Spin the drawn line around a vertical axis through `center` (the view's up). Faces are turned outward afterwards. */
function latheMesh(sampled: readonly P3[], c: CurveParams, center: P3, axis: P3): MeshData {
  const smooth = c.latheSmoothing > 0 && sampled.length > 2
    ? sampled.map((p, i) => (i === 0 || i === sampled.length - 1 ? p : lerp3(p, mul(add(add(sampled[i - 1], p), sampled[i + 1]), 1 / 3), c.latheSmoothing)))
    : sampled;
  const ax = norm(axis);
  const pts = resample(smooth, c.latheProfileRings);
  // Each profile point as (distance from the axis, height along it), and the direction it leans out.
  const base = pts.map((p) => { const d = sub(p, center), h = dot(d, ax), out = sub(d, mul(ax, h)); return { r: Math.hypot(out[0], out[1], out[2]), h }; });
  let ref: P3 = [0, 0, 0];
  for (const p of pts) { const d = sub(p, center), out = sub(d, mul(ax, dot(d, ax))); if (Math.hypot(...out) > Math.hypot(...ref)) ref = out; }
  const e1 = Math.hypot(...ref) > 1e-6 ? norm(ref) : stableRight(ax, null), e2 = cross(ax, e1);
  const full = c.latheAngle >= 359.99, segs = Math.max(3, c.latheSegments), span = (c.latheAngle * Math.PI) / 180;
  const cols = full ? segs : segs + 1;
  const positions: P3[] = [], faces: F[] = [];
  const at = (r: number, h: number, a: number): P3 => add(add(center, mul(ax, h)), add(mul(e1, r * Math.cos(a)), mul(e2, r * Math.sin(a))));
  // A point on the axis is one shared vertex, so the ends close without slivers.
  const rings = base.map(({ r, h }) => (r < 1e-4 ? Array(cols).fill(positions.push(at(0, h, 0)) - 1) : Array.from({ length: cols }, (_, j) => positions.push(at(r, h, (j / segs) * span)) - 1)));
  const vLen = base.length - 1 || 1;
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const k = full ? (j + 1) % segs : j + 1;
      const v = [rings[i][j], rings[i][k], rings[i + 1][k], rings[i + 1][j]];
      const uv = [j / segs, i / vLen, (j + 1) / segs, i / vLen, (j + 1) / segs, (i + 1) / vLen, j / segs, (i + 1) / vLen].map((x, n) => x * (n % 2 ? c.uvAlong : c.uvAround));
      const keep = v.map((x, n) => x !== v[(n + 1) % 4]);
      if (keep.filter(Boolean).length >= 3) faces.push({ v: v.filter((_, n) => keep[n]), uv: uv.filter((_, n) => keep[n >> 1]) });
    }
  }
  if (c.latheCaps) {
    for (const i of [0, rings.length - 1]) {
      if (base[i].r < 1e-4) continue;
      if (full) faces.push(faceOf(i === 0 ? [...rings[i]].reverse() : [...rings[i]]));
      else { const hub = positions.push(at(0, base[i].h, 0)) - 1; faces.push(faceOf([hub, ...rings[i]])); }
    }
    if (!full) {
      // The two cut sides: the profile closed along the axis.
      const lo = positions.push(at(0, base[0].h, 0)) - 1, hi = positions.push(at(0, base[base.length - 1].h, 0)) - 1;
      faces.push(faceOf([lo, ...rings.map((r) => r[0]), hi]));
      faces.push(faceOf([hi, ...rings.map((r) => r[cols - 1]).reverse(), lo]));
    }
  }
  const out = { positions, faces };
  if (signedVolume(out) < 0) out.faces = out.faces.map(reversed);
  return out;
}

/** Positive when faces point outward (for a closed mesh). */
export function signedVolume(m: MeshData): number {
  let v = 0;
  for (const f of m.faces) {
    const a = m.positions[f.v[0]];
    for (let i = 1; i < f.v.length - 1; i++) v += dot(a, cross(m.positions[f.v[i]], m.positions[f.v[i + 1]]));
  }
  return v / 6;
}

// ───────────────────────── to a piece ─────────────────────────
/** Keep settings in the ranges the generators can handle (a typed value must not build a million-face mesh). */
export function cleanParams(v: CurveParams): CurveParams {
  return {
    ...v,
    radius: clamp(v.radius, 0.005, 10),
    latheSegments: Math.round(clamp(v.latheSegments, 3, 64)), latheProfileRings: Math.round(clamp(v.latheProfileRings, 2, 128)),
    latheSmoothing: clamp(v.latheSmoothing, 0, 1), latheAngle: clamp(v.latheAngle, 15, 360),
    pathRadialSegments: Math.round(clamp(v.pathRadialSegments, 3, 24)), pathRadiusScale: clamp(v.pathRadiusScale, 0.05, 4),
    startScale: clamp(v.startScale, 0.02, 4), endScale: clamp(v.endScale, 0.02, 4),
    pathSpacing: clamp(v.pathSpacing, 0.01, 8), pathCount: Math.round(clamp(v.pathCount, 1, 200)),
    pathStartPadding: clamp(v.pathStartPadding, 0, 1e4), pathEndPadding: clamp(v.pathEndPadding, 0, 1e4),
    uvAlong: clamp(v.uvAlong, 0.01, 100), uvAround: clamp(v.uvAround, 0.01, 100),
  };
}

/** Faces whose look is hard-edged rather than smooth. */
function hardEdged(c: CurveParams) {
  if (c.solid === 'lathe') return false;
  if (c.kind === 'outline' || c.kind === 'square-sweep' || c.kind === 'rail-sweep') return true;
  return c.kind === 'path' && (c.pathOutput === 'cards' || c.pathOutput === 'object-array' || (c.pathOutput === 'profile-sweep' && c.pathProfile !== 'round'));
}

/**
 * The piece a drawn curve makes. `points` are the control points in world space; `up` is the view's up, the lathe axis.
 * `lookup` gives another part's faces for Object Array. Throws with a readable message.
 */
export function curveToPrim(points: readonly P3[], params: CurveParams, up: P3 = [0, 1, 0], lookup: (id: number) => MeshData | null = () => null): Prim {
  const c = cleanParams(params);
  const closed = c.solid === 'extrude' && c.cyclic, steps = curveSteps(c.resolution);
  const raw = sampleCurve(points, c.curveType, steps, closed);
  const line = closed ? [...raw, raw[0]] : raw;
  if (dropRepeats(raw).length < 2 || polylineLength(line) < 1e-5) throw new Error('Draw a longer line');
  // Rings evenly spaced along a smooth curve, however unevenly the points were placed.
  const per = c.curveType === 'polyline' || points.length < 3 ? 1 : steps;
  const even = per > 1 ? (closed ? resample(line, raw.length + 1).slice(0, -1) : resample(raw, raw.length)) : raw;
  const sampled = dropRepeats(even);
  let d: MeshData;
  if (c.solid === 'lathe') {
    // The axis stands upright through where the line starts: start on the centre line and draw the outline.
    const a = sampled[0], u = norm(up);
    const r0 = (p: P3) => { const q = sub(p, a); return Math.hypot(...sub(q, mul(u, dot(q, u)))); };
    if (sampled.every((p) => r0(p) < 1e-3)) throw new Error('Draw sideways from where you start to spin a lathe');
    d = latheMesh(sampled, c, a, up);
  } else d = curveMesh(sampled, { ...c, widthAt: () => 1 }, lookup);
  if (!d.faces.length) throw new Error('This curve makes no geometry');
  return toPrim(d, !hardEdged(c));
}

/** Faces without their own UVs get a projection along their main normal axis. The document's V runs down. */
function toPrim(d: MeshData, smooth: boolean): Prim {
  const verts: V3[] = d.positions.map((p) => [p[0], p[1], p[2]]);
  const faces = d.faces.map((f) => {
    let uv: V2[];
    if (f.uv) uv = f.v.map((_, i) => [f.uv![i * 2], 1 - f.uv![i * 2 + 1]]);
    else {
      const n = newell(f.v.map((i) => d.positions[i]));
      const skip = Math.abs(n[0]) > Math.abs(n[1]) && Math.abs(n[0]) > Math.abs(n[2]) ? 0 : Math.abs(n[1]) > Math.abs(n[2]) ? 1 : 2;
      uv = f.v.map((i) => { const a = [...d.positions[i]]; a.splice(skip, 1); return [a[0], 1 - a[1]]; });
    }
    return { v: f.v, uv };
  });
  return { verts, faces, smooth };
}
