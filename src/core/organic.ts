// Organic shapes for blocking out: character parts, freehand tubes and drawn silhouettes.
// Each is a stack of rings closed by a point at each end, so detail is just how many rings and sides it gets.
import { add, cross, dist, dot, norm, sub } from './geom';
import { splitOutline } from './limbs';
import type { Prim } from './primitives';
import type { V2, V3 } from './types';

interface Ring { c: V3; x: V3; z: V3; rx: number; rz: number }

/** Skin a stack of rings between two end points. */
export function loft(start: V3, rings: Ring[], end: V3, sides: number, smooth: boolean): Prim {
  const n = Math.max(3, Math.round(sides));
  const verts: V3[] = [start];
  for (const r of rings) {
    for (let j = 0; j < n; j++) {
      const a = (j / n) * Math.PI * 2, cx = Math.cos(a) * r.rx, sz = Math.sin(a) * r.rz;
      verts.push([r.c[0] + r.x[0] * cx + r.z[0] * sz, r.c[1] + r.x[1] * cx + r.z[1] * sz, r.c[2] + r.x[2] * cx + r.z[2] * sz]);
    }
  }
  verts.push(end);
  const last = verts.length - 1;
  const id = (i: number, j: number) => 1 + i * n + ((j + n) % n);
  const rows = rings.length;
  const v = (i: number) => 1 - (i + 1) / (rows + 1);
  const faces: Prim['faces'] = [];
  for (let j = 0; j < n; j++) {
    const u0 = j / n, u1 = (j + 1) / n;
    faces.push({ v: [0, id(0, j + 1), id(0, j)], uv: [[(u0 + u1) / 2, 1], [u1, v(0)], [u0, v(0)]] });
    for (let i = 0; i + 1 < rows; i++) {
      faces.push({ v: [id(i, j), id(i, j + 1), id(i + 1, j + 1), id(i + 1, j)], uv: [[u0, v(i)], [u1, v(i)], [u1, v(i + 1)], [u0, v(i + 1)]] });
    }
    faces.push({ v: [last, id(rows - 1, j), id(rows - 1, j + 1)], uv: [[(u0 + u1) / 2, 0], [u0, v(rows - 1)], [u1, v(rows - 1)]] });
  }
  return outward({ verts, faces, smooth });
}

/** Turn a closed shape right side out, whichever way its rings happened to run. */
function outward(p: Prim): Prim {
  let vol = 0;
  for (const f of p.faces) {
    for (let i = 1; i + 1 < f.v.length; i++) {
      const a = p.verts[f.v[0]], b = p.verts[f.v[i]], c = p.verts[f.v[i + 1]];
      vol += dot(a, cross(b, c));
    }
  }
  if (vol < 0) for (const f of p.faces) { f.v.reverse(); f.uv.reverse(); }
  return p;
}

// ---------- character parts ----------
/** Along the part, from 0 to 1: width and depth from its centre, and any bend toward +Z. All as shares of its length. */
type Profile = [t: number, rx: number, rz: number, bend?: number][];

export interface PartDef { label: string; color: string; hint: string; icon: string; profile: Profile }

const SKIN = '#c4a57b', BODY = '#8e9ba8', LIMB = '#c9cdd2', END = '#b08d8d';

export const PARTS: Record<string, PartDef> = {
  head: { label: 'Head', color: SKIN, hint: 'Drag from chin to crown.', icon: '<path d="M12 3c-4 0-7 3-7 7.5 0 5 3.5 10.5 7 10.5s7-5.5 7-10.5C19 6 16 3 12 3z"/>', profile: [[0, 0, 0], [0.12, 0.24, 0.28], [0.32, 0.36, 0.42], [0.62, 0.42, 0.47], [0.86, 0.34, 0.38], [1, 0, 0]] },
  torso: { label: 'Torso', color: BODY, hint: 'Drag from hips to neck.', icon: '<path d="M6 4h12l-2 8 2 8H6l2-8z"/>', profile: [[0, 0, 0], [0.08, 0.27, 0.19], [0.33, 0.22, 0.16], [0.62, 0.27, 0.19], [0.88, 0.33, 0.19], [1, 0, 0]] },
  arm: { label: 'Arm', color: LIMB, hint: 'Drag from shoulder to wrist.', icon: '<path d="M6 4c3 0 5 2 6 6l4 9-4 1-5-9C5 9 4 6 6 4z"/>', profile: [[0, 0, 0], [0.07, 0.1, 0.1], [0.28, 0.115, 0.12], [0.5, 0.085, 0.09], [0.68, 0.095, 0.095], [0.96, 0.055, 0.05], [1, 0, 0]] },
  leg: { label: 'Leg', color: LIMB, hint: 'Drag from hip to ankle.', icon: '<path d="M8 3h8l-1 9 1 9h-5l-1-9z"/>', profile: [[0, 0, 0], [0.06, 0.12, 0.13], [0.26, 0.14, 0.15], [0.5, 0.09, 0.1], [0.66, 0.095, 0.115], [0.96, 0.05, 0.055], [1, 0, 0]] },
  hand: { label: 'Hand', color: END, hint: 'Drag from wrist to fingertips.', icon: '<path d="M8 21l-2-8 2-8 3-2 4 2 2 8-2 8z"/>', profile: [[0, 0, 0], [0.16, 0.2, 0.1], [0.5, 0.33, 0.11], [0.84, 0.27, 0.07], [1, 0, 0]] },
  foot: { label: 'Foot', color: END, hint: 'Drag from heel to toes.', icon: '<path d="M4 9c3-2 6-2 8 1l8 5c1 2 0 4-2 4H6c-2 0-3-7-2-10z"/>', profile: [[0, 0, 0], [0.16, 0.19, 0.21], [0.52, 0.2, 0.14], [0.86, 0.24, 0.1], [1, 0, 0]] },
  ear: { label: 'Ear', color: SKIN, hint: 'Drag from base to tip.', icon: '<path d="M8 21c-2-6-1-13 8-18 1 7 0 14-8 18z"/>', profile: [[0, 0, 0], [0.32, 0.3, 0.06], [0.72, 0.2, 0.045], [1, 0, 0]] },
  horn: { label: 'Horn', color: END, hint: 'Drag from base to tip. Curves as it goes.', icon: '<path d="M7 21c-2-7 1-14 11-18-3 5-4 11-5 18z"/>', profile: [[0, 0, 0], [0.05, 0.17, 0.17], [0.45, 0.1, 0.1, 0.12], [0.82, 0.04, 0.04, 0.12], [1, 0, 0, 0]] },
  tail: { label: 'Tail', color: BODY, hint: 'Drag from base to tip. Curves as it goes.', icon: '<path d="M4 6c6 0 9 3 10 7s3 6 6 6c-5 2-9 0-11-4S6 9 4 9z"/>', profile: [[0, 0, 0], [0.08, 0.1, 0.1], [0.42, 0.075, 0.075, 0.16], [0.78, 0.04, 0.04, 0.15], [1, 0, 0, 0]] },
  wing: { label: 'Wing', color: LIMB, hint: 'Drag from shoulder to wingtip.', icon: '<path d="M3 19C5 9 12 4 21 4c-1 5-3 7-6 8 0 3-2 5-5 5 0 1-4 2-7 2z"/>', profile: [[0, 0, 0], [0.18, 0.2, 0.03], [0.55, 0.4, 0.03], [0.88, 0.2, 0.02], [1, 0, 0]] },
};

function sampleProfile(p: Profile, t: number): [number, number, number] {
  let i = 1;
  while (i < p.length - 1 && p[i][0] < t) i++;
  const a = p[i - 1], b = p[i];
  const k = (t - a[0]) / Math.max(b[0] - a[0], 1e-6);
  const s = k * k * (3 - 2 * k);
  return [a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s, (a[3] ?? 0) + ((b[3] ?? 0) - (a[3] ?? 0)) * s];
}

/** A part one unit long, from the origin up +Y. */
export function partPrim(kind: string, sides = 12, rows = 8, smooth = true): Prim {
  const def = PARTS[kind];
  const n = Math.max(2, Math.round(rows));
  const rings: Ring[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / (n + 1);
    const [rx, rz, bend] = sampleProfile(def.profile, t);
    rings.push({ c: [0, t, bend], x: [1, 0, 0], z: [0, 0, 1], rx: Math.max(rx, 1e-3), rz: Math.max(rz, 1e-3) });
  }
  return loft([0, 0, 0], rings, [0, 1, 0], sides, smooth);
}

// ---------- freehand tubes ----------
/** Smooth a hand-drawn path and space its points evenly. */
export function resamplePath(points: V3[], count: number): V3[] {
  if (points.length < 2) return points.slice();
  // Ease out the wobble of a hand-drawn line, keeping its ends where they are.
  let pts = points.map((p) => [...p] as V3);
  for (let it = 0; it < 3; it++) {
    pts = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return p;
      const a = pts[i - 1], b = pts[i + 1];
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4, (a[2] + 2 * p[2] + b[2]) / 4];
    });
  }
  const lens = [0];
  for (let i = 1; i < pts.length; i++) lens.push(lens[i - 1] + dist(pts[i - 1], pts[i]));
  const total = lens[lens.length - 1];
  const out: V3[] = [];
  let seg = 1;
  for (let i = 0; i < count; i++) {
    const at = (i / (count - 1)) * total;
    while (seg < lens.length - 1 && lens[seg] < at) seg++;
    const span = lens[seg] - lens[seg - 1] || 1;
    const k = (at - lens[seg - 1]) / span;
    const a = pts[seg - 1], b = pts[seg];
    out.push([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]);
  }
  return out;
}

export const pathLength = (pts: V3[]) => pts.reduce((s, p, i) => (i ? s + dist(pts[i - 1], p) : 0), 0);

/**
 * A tube along a path, with rounded ends. `taper` narrows it toward the far end, for tails and tentacles.
 * `spacing` is the distance between rings as a share of the radius, so low poly can simply use fewer.
 */
export function tube(path: V3[], radius: number, sides = 10, spacing = 1, taper = 0, smooth = true): Prim | null {
  const length = pathLength(path);
  if (length < 1e-4 || radius <= 0) return null;
  const count = Math.max(4, Math.min(80, Math.round(length / (radius * spacing)) + 1));
  const pts = resamplePath(path, count);
  const tangent = (i: number) => norm(sub(pts[Math.min(i + 1, count - 1)], pts[Math.max(i - 1, 0)]));
  // Carry a side direction along the path, so the tube doesn't twist.
  let t = tangent(0);
  let x = norm(cross(t, Math.abs(t[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]));
  const rings: Ring[] = [];
  let along = 0;
  for (let i = 1; i < count - 1; i++) {
    along += dist(pts[i - 1], pts[i]);
    const nt = tangent(i);
    const axis = cross(t, nt);
    x = norm(add(x, cross(axis, x)));
    x = norm(sub(x, [nt[0] * dot(x, nt), nt[1] * dot(x, nt), nt[2] * dot(x, nt)]));
    t = nt;
    const k = along / length;
    const body = radius * (1 - taper * k * 0.9);
    const fromEnd = Math.min(along, length - along);
    const cap = fromEnd < body ? Math.sqrt(Math.max(0, 1 - (1 - fromEnd / body) ** 2)) : 1;
    const r = Math.max(body * cap, radius * 0.02);
    rings.push({ c: pts[i], x, z: cross(t, x), rx: r, rz: r });
  }
  if (!rings.length) return null;
  return loft(pts[0], rings, pts[count - 1], sides, smooth);
}

// ---------- lathe ----------
/**
 * Spin a drawn profile around a vertical axis in the view. `profile` holds [distance along right, height],
 * and the axis stands at `axisRight` along the view's right direction. The two ends close onto the axis.
 */
export function lathe(profile: V2[], axisRight: number, origin: V3, right: V3, up: V3, rows = 12, sides = 12, smooth = true): Prim | null {
  if (profile.length < 2) return null;
  const path3 = profile.map(([a, b]): V3 => [a, b, 0]);
  const length = pathLength(path3);
  if (length < 1e-4) return null;
  const pts = resamplePath(path3, Math.max(4, Math.round(rows) + 2));
  const place = (a: number, b: number): V3 => [origin[0] + right[0] * a + up[0] * b, origin[1] + right[1] * a + up[1] * b, origin[2] + right[2] * a + up[2] * b];
  const z = cross(right, up);
  const rings: Ring[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const r = Math.max(Math.abs(pts[i][0] - axisRight), length * 1e-3);
    rings.push({ c: place(axisRight, pts[i][1]), x: right, z, rx: r, rz: r });
  }
  if (!rings.length) return null;
  return loft(place(axisRight, pts[0][1]), rings, place(axisRight, pts[pts.length - 1][1]), sides, smooth);
}

// ---------- deforming ----------
export type DeformMode = 'taper' | 'bend' | 'twist';

/**
 * Reshape points along one axis of their bounds. Taper narrows toward the far end (amount -1 to 1 widens or narrows),
 * twist turns by `amount` degrees end to end, and bend curves by `amount` degrees toward the next axis.
 */
export function deformPoints(points: V3[], mode: DeformMode, axis: 0 | 1 | 2, amount: number): V3[] {
  if (!points.length) return [];
  const a = axis, b = ((axis + 1) % 3) as 0 | 1 | 2, c = ((axis + 2) % 3) as 0 | 1 | 2;
  const lo = [0, 1, 2].map((i) => Math.min(...points.map((p) => p[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...points.map((p) => p[i])));
  const mid = lo.map((v, i) => (v + hi[i]) / 2);
  const L = hi[a] - lo[a] || 1;
  const rad = (amount * Math.PI) / 180;
  return points.map((p) => {
    const t = (p[a] - lo[a]) / L;
    const out: V3 = [p[0], p[1], p[2]];
    const db = p[b] - mid[b], dc = p[c] - mid[c];
    if (mode === 'taper') {
      const k = Math.max(0.01, 1 - amount * t);
      out[b] = mid[b] + db * k;
      out[c] = mid[c] + dc * k;
    } else if (mode === 'twist') {
      const s = Math.sin(rad * t), co = Math.cos(rad * t);
      out[b] = mid[b] + db * co - dc * s;
      out[c] = mid[c] + db * s + dc * co;
    } else if (Math.abs(rad) > 1e-5) {
      // Wrap the piece around a circle, keeping the near end where it is and its length unchanged.
      const R = L / rad, th = rad * t;
      out[a] = lo[a] + (R - db) * Math.sin(th);
      out[b] = mid[b] + R - (R - db) * Math.cos(th);
    }
    return out;
  });
}

// ---------- fusing pieces ----------
export interface FuseInput { tris: [V3, V3, V3][] }

/**
 * Melt closed shapes into one seamless surface. Each shape fills a grid of cells, a blur rounds the joins, and a
 * surface is rebuilt through the result. `cells` is the grid's resolution along the longest side. Returns null if empty.
 */
export function fuse(shapes: FuseInput[], cells = 48, smoothing = 1, smooth = true): Prim | null {
  let lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const s of shapes) for (const t of s.tris) for (const p of t) {
    lo = [Math.min(lo[0], p[0]), Math.min(lo[1], p[1]), Math.min(lo[2], p[2])];
    hi = [Math.max(hi[0], p[0]), Math.max(hi[1], p[1]), Math.max(hi[2], p[2])];
  }
  if (!Number.isFinite(lo[0])) return null;
  const longest = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (longest < 1e-6) return null;
  const h = longest / Math.max(4, Math.min(160, Math.round(cells)));
  const pad = 2 + Math.ceil(smoothing);
  const org: V3 = [lo[0] - h * pad, lo[1] - h * pad, lo[2] - h * pad];
  const nx = Math.ceil((hi[0] - lo[0]) / h) + pad * 2 + 1, ny = Math.ceil((hi[1] - lo[1]) / h) + pad * 2 + 1, nz = Math.ceil((hi[2] - lo[2]) / h) + pad * 2 + 1;
  const at = (x: number, y: number, z: number) => x + nx * (y + ny * z);
  let field = new Float32Array(nx * ny * nz);
  // Fill each shape on its own by crossing counts along Z, so overlaps add rather than cancel.
  for (const s of shapes) {
    const cols = new Map<number, number[]>();
    for (const [a, b, c] of s.tris) {
      const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0], c[0]) - org[0]) / h)), x1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0], c[0]) - org[0]) / h));
      const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1], c[1]) - org[1]) / h)), y1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1], c[1]) - org[1]) / h));
      const det = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
      if (Math.abs(det) < 1e-14) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        // Nudged off the grid so a ray can't run exactly along a shared edge and count it twice.
        const px = org[0] + x * h + h * 1.7e-4, py = org[1] + y * h + h * 2.3e-4;
        const u = ((b[1] - c[1]) * (px - c[0]) + (c[0] - b[0]) * (py - c[1])) / det;
        const v = ((c[1] - a[1]) * (px - c[0]) + (a[0] - c[0]) * (py - c[1])) / det;
        const w = 1 - u - v;
        if (u < 0 || v < 0 || w < 0) continue;
        const z = u * a[2] + v * b[2] + w * c[2];
        const k = x + nx * y;
        const col = cols.get(k);
        if (col) col.push(z); else cols.set(k, [z]);
      }
    }
    cols.forEach((zs, k) => {
      zs.sort((p, q) => p - q);
      const x = k % nx, y = Math.floor(k / nx);
      for (let i = 0; i + 1 < zs.length; i += 2) {
        const z0 = Math.max(0, Math.ceil((zs[i] - org[2]) / h)), z1 = Math.min(nz - 1, Math.floor((zs[i + 1] - org[2]) / h));
        for (let z = z0; z <= z1; z++) field[at(x, y, z)] = 1;
      }
    });
  }
  // Blur rounds off the creases where pieces meet.
  const passes = Math.max(0, Math.round(smoothing)) + 1;
  for (let p = 0; p < passes; p++) {
    for (const axis of [1, nx, nx * ny]) {
      const next = field.slice();
      for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
        const i = at(x, y, z);
        next[i] = (field[i - axis] + 2 * field[i] + field[i + axis]) / 4;
      }
      field = next;
    }
  }
  // Surface nets: one point inside each cell the surface passes through, joined across cell edges.
  const iso = 0.5;
  const index = new Int32Array(nx * ny * nz).fill(-1);
  const verts: V3[] = [];
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let z = 0; z < nz - 1; z++) for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
    let sx = 0, sy = 0, sz = 0, n = 0;
    const vals = corners.map(([a, b, c]) => field[at(x + a, y + b, z + c)]);
    for (const [e0, e1] of edges) {
      const p = vals[e0], q = vals[e1];
      if ((p > iso) === (q > iso)) continue;
      const k = (iso - p) / (q - p);
      sx += corners[e0][0] + (corners[e1][0] - corners[e0][0]) * k;
      sy += corners[e0][1] + (corners[e1][1] - corners[e0][1]) * k;
      sz += corners[e0][2] + (corners[e1][2] - corners[e0][2]) * k;
      n++;
    }
    if (!n) continue;
    index[at(x, y, z)] = verts.length;
    verts.push([org[0] + (x + sx / n) * h, org[1] + (y + sy / n) * h, org[2] + (z + sz / n) * h]);
  }
  const faces: Prim['faces'] = [];
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    const v = flip ? [d, c, b, a] : [a, b, c, d];
    faces.push({ v, uv: [[0, 0], [1, 0], [1, 1], [0, 1]] });
  };
  for (let z = 1; z < nz - 1; z++) for (let y = 1; y < ny - 1; y++) for (let x = 1; x < nx - 1; x++) {
    const here = field[at(x, y, z)] > iso;
    if (here !== (field[at(x + 1, y, z)] > iso)) quad(index[at(x, y - 1, z - 1)], index[at(x, y, z - 1)], index[at(x, y, z)], index[at(x, y - 1, z)], !here);
    if (here !== (field[at(x, y + 1, z)] > iso)) quad(index[at(x - 1, y, z - 1)], index[at(x - 1, y, z)], index[at(x, y, z)], index[at(x, y, z - 1)], !here);
    if (here !== (field[at(x, y, z + 1)] > iso)) quad(index[at(x - 1, y - 1, z)], index[at(x, y - 1, z)], index[at(x, y, z)], index[at(x - 1, y, z)], !here);
  }
  if (!faces.length) return null;
  return outward({ verts, faces, smooth });
}

// ---------- drawn silhouettes ----------
/**
 * Inflate a drawn outline into a rounded solid. The outline is sliced along its longest direction, and each slice
 * becomes an oval ring as deep as `depth` times its width. Dents along that direction fill in.
 */
export function silhouette(outline: V2[], origin: V3, right: V3, up: V3, rows = 8, sides = 12, depth = 0.8, smooth = true): Prim | null {
  if (outline.length < 3) return null;
  const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length, cy = outline.reduce((s, p) => s + p[1], 0) / outline.length;
  let xx = 0, xy = 0, yy = 0;
  for (const [a, b] of outline) { xx += (a - cx) ** 2; xy += (a - cx) * (b - cy); yy += (b - cy) ** 2; }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ax: V2 = [Math.cos(ang), Math.sin(ang)], ay: V2 = [-ax[1], ax[0]];
  const local = outline.map(([a, b]): V2 => [(a - cx) * ax[0] + (b - cy) * ax[1], (a - cx) * ay[0] + (b - cy) * ay[1]]);
  const us = local.map((p) => p[0]);
  const lo = Math.min(...us), hi = Math.max(...us);
  if (hi - lo < 1e-4) return null;
  const toWorld = (u: number, v: number): V3 => {
    const a = cx + ax[0] * u + ay[0] * v, b = cy + ax[1] * u + ay[1] * v;
    return [origin[0] + right[0] * a + up[0] * b, origin[1] + right[1] * a + up[1] * b, origin[2] + right[2] * a + up[2] * b];
  };
  const span = (u: number): [number, number] | null => {
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < local.length; i++) {
      const p = local[i], q = local[(i + 1) % local.length];
      if ((p[0] <= u) === (q[0] <= u)) continue;
      const v = p[1] + ((u - p[0]) / (q[0] - p[0])) * (q[1] - p[1]);
      a = Math.min(a, v); b = Math.max(b, v);
    }
    return Number.isFinite(a) ? [a, b] : null;
  };
  const dirV = norm([right[0] * ay[0] + up[0] * ay[1], right[1] * ay[0] + up[1] * ay[1], right[2] * ay[0] + up[2] * ay[1]]);
  const dirU = norm([right[0] * ax[0] + up[0] * ax[1], right[1] * ax[0] + up[1] * ax[1], right[2] * ax[0] + up[2] * ax[1]]);
  const normal = cross(dirU, dirV);
  const n = Math.max(2, Math.round(rows));
  const rings: Ring[] = [];
  for (let i = 1; i <= n; i++) {
    const u = lo + ((hi - lo) * i) / (n + 1);
    const s = span(u);
    if (!s) continue;
    const half = Math.max((s[1] - s[0]) / 2, (hi - lo) * 1e-3);
    rings.push({ c: toWorld(u, (s[0] + s[1]) / 2), x: dirV, z: normal, rx: half, rz: half * depth });
  }
  if (!rings.length) return null;
  const endV = (u: number) => local.reduce((best, p) => (Math.abs(p[0] - u) < Math.abs(best[0] - u) ? p : best), local[0])[1];
  return loft(toWorld(lo, endV(lo)), rings, toWorld(hi, endV(hi)), sides, smooth);
}

// ---------- pen shapes ----------
/** Depth and width at the bottom, middle and top of a pen shape, as shares of the drawn width. */
export interface PenProfile { depth: [number, number, number]; width: [number, number, number] }
export const ROUND_PROFILE = (): PenProfile => ({ depth: [1, 1, 1], width: [1, 1, 1] });
/** Where the bottom, middle and top rings sit, as shares of the length from the bottom end. */
export const PEN_SECTIONS = [0.2, 0.5, 0.8] as const;

/** A smooth curve through the three values at PEN_SECTIONS, level beyond the outer two. Never overshoots. */
export function profileAt(v: readonly [number, number, number], t: number): number {
  const T = PEN_SECTIONS;
  if (t <= T[0]) return v[0];
  if (t >= T[2]) return v[2];
  const k = t < T[1] ? 0 : 1;
  const s = (t - T[k]) / (T[k + 1] - T[k]);
  // Hermite with a level tangent at the ends and, in the middle, the average slope, or level at a peak or dip.
  const d0 = (v[1] - v[0]) / (T[1] - T[0]), d1 = (v[2] - v[1]) / (T[2] - T[1]);
  const mid = d0 * d1 > 0 ? (d0 + d1) / 2 : 0;
  const m0 = k === 0 ? 0 : mid, m1 = k === 0 ? mid : 0;
  const h = T[k + 1] - T[k];
  const s2 = s * s, s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v[k] + (s3 - 2 * s2 + s) * h * m0 + (-2 * s3 + 3 * s2) * v[k + 1] + (s3 - s2) * h * m1;
}

/**
 * How a pen outline lies: its long direction, the cross-section at any point along it, and which end is the top.
 * Shared by the shape builder and by the tool, which draws its rings with it.
 */
export function penFrame(outline: V2[], origin: V3, right: V3, up: V3, topToward?: V2) {
  if (outline.length < 3) return null;
  const cx = outline.reduce((s, p) => s + p[0], 0) / outline.length, cy = outline.reduce((s, p) => s + p[1], 0) / outline.length;
  let xx = 0, xy = 0, yy = 0;
  for (const [a, b] of outline) { xx += (a - cx) ** 2; xy += (a - cx) * (b - cy); yy += (b - cy) ** 2; }
  const ang = 0.5 * Math.atan2(2 * xy, xx - yy);
  const ax: V2 = [Math.cos(ang), Math.sin(ang)], ay: V2 = [-ax[1], ax[0]];
  const local = outline.map(([a, b]): V2 => [(a - cx) * ax[0] + (b - cy) * ax[1], (a - cx) * ay[0] + (b - cy) * ay[1]]);
  const us = local.map((p) => p[0]);
  const lo = Math.min(...us), hi = Math.max(...us);
  if (hi - lo < 1e-4) return null;
  const toWorld = (u: number, v: number): V3 => {
    const a = cx + ax[0] * u + ay[0] * v, b = cy + ax[1] * u + ay[1] * v;
    return [origin[0] + right[0] * a + up[0] * b, origin[1] + right[1] * a + up[1] * b, origin[2] + right[2] * a + up[2] * b];
  };
  const span = (u: number): [number, number] | null => {
    let a = Infinity, b = -Infinity;
    for (let i = 0; i < local.length; i++) {
      const p = local[i], q = local[(i + 1) % local.length];
      if ((p[0] <= u) === (q[0] <= u)) continue;
      const v = p[1] + ((u - p[0]) / (q[0] - p[0])) * (q[1] - p[1]);
      a = Math.min(a, v); b = Math.max(b, v);
    }
    return Number.isFinite(a) ? [a, b] : null;
  };
  const dirV = norm([right[0] * ay[0] + up[0] * ay[1], right[1] * ay[0] + up[1] * ay[1], right[2] * ay[0] + up[2] * ay[1]]);
  const dirU = norm([right[0] * ax[0] + up[0] * ax[1], right[1] * ax[0] + up[1] * ax[1], right[2] * ax[0] + up[2] * ax[1]]);
  const normal = cross(dirU, dirV);
  const endV = (u: number) => local.reduce((best, p) => (Math.abs(p[0] - u) < Math.abs(best[0] - u) ? p : best), local[0])[1];
  // The top is the end nearer `topToward` when given, like a limb's tip; otherwise the end higher up the plane.
  const endAt = (u: number): V2 => [cx + ax[0] * u + ay[0] * endV(u), cy + ax[1] * u + ay[1] * endV(u)];
  const hiIsTop = topToward
    ? Math.hypot(endAt(hi)[0] - topToward[0], endAt(hi)[1] - topToward[1]) <= Math.hypot(endAt(lo)[0] - topToward[0], endAt(lo)[1] - topToward[1])
    : endAt(hi)[1] >= endAt(lo)[1];
  /** From 0 at the bottom end to 1 at the top. */
  const tOf = (u: number) => (hiIsTop ? (u - lo) / (hi - lo) : (hi - u) / (hi - lo));
  const uOf = (t: number) => (hiIsTop ? lo + (hi - lo) * t : hi - (hi - lo) * t);
  /** The cross-section at a point along the length: its centre and half the drawn width there. */
  const section = (u: number) => {
    const s = span(u);
    if (!s) return null;
    return { c: toWorld(u, (s[0] + s[1]) / 2), half: Math.max((s[1] - s[0]) / 2, (hi - lo) * 1e-3) };
  };
  return { lo, hi, toWorld, endV, dirV, normal, tOf, uOf, section };
}

/**
 * Inflate a drawn outline into an all-quad solid, for the Pen Shape tool. Like silhouette, it stacks oval rings
 * along the outline's longest direction, but spaces them like a sphere's latitudes, so rounded ends stay evenly
 * faceted, and closes each end with a small grid of quads instead of a pole. Every face is a quad, so edge loops
 * run cleanly around and along the piece. `sides` is rounded to a multiple of 4, which the end grids need.
 * `profile` sets the depth and width at the bottom, middle and top, blending smoothly between them.
 */
export function quadSilhouette(outline: V2[], origin: V3, right: V3, up: V3, rows = 8, sides = 16, smooth = true, profile: PenProfile = ROUND_PROFILE(), topToward?: V2): Prim | null {
  const fr = penFrame(outline, origin, right, up, topToward);
  if (!fr) return null;
  const { lo, hi, toWorld, endV, dirV, normal } = fr;
  // Rings at sphere-like latitudes: closer together toward the ends, where the outline turns fastest.
  const n = Math.max(2, Math.round(rows));
  const rings: Ring[] = [];
  for (let i = 1; i <= n; i++) {
    const u = lo + ((hi - lo) * (1 - Math.cos((Math.PI * i) / (n + 1)))) / 2;
    const s = fr.section(u);
    if (!s) continue;
    const t = fr.tOf(u);
    const rx = s.half * Math.max(0.02, profileAt(profile.width, t));
    const rz = s.half * Math.max(0.02, profileAt(profile.depth, t));
    rings.push({ c: s.c, x: dirV, z: normal, rx, rz });
  }
  if (rings.length < 1) return null;
  const tips: [V3, V3] = [toWorld(lo, endV(lo)), toWorld(hi, endV(hi))];

  const k = Math.max(2, Math.round(Math.max(8, sides) / 4));
  const m = 4 * k;
  const verts: V3[] = [];
  const faces: Prim['faces'] = [];
  const ringAt = (r: Ring, a: number): [number, number] => [Math.cos(a) * r.rx, Math.sin(a) * r.rz];
  const place = (r: Ring, x: number, z: number, lift: V3 = [0, 0, 0]): V3 => [
    r.c[0] + r.x[0] * x + r.z[0] * z + lift[0], r.c[1] + r.x[1] * x + r.z[1] * z + lift[1], r.c[2] + r.x[2] * x + r.z[2] * z + lift[2],
  ];
  const ringStart: number[] = [];
  rings.forEach((r) => {
    ringStart.push(verts.length);
    for (let j = 0; j < m; j++) { const [x, z] = ringAt(r, (j / m) * Math.PI * 2); verts.push(place(r, x, z)); }
  });
  const rid = (i: number, j: number) => ringStart[i] + (((j % m) + m) % m);
  const vOf = (i: number) => 1 - (i + 1) / (rings.length + 1);

  // Sides: quads between neighbouring rings, wound outward (away from the ring centre).
  const sideFaces: Prim['faces'] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let j = 0; j < m; j++) {
      sideFaces.push({ v: [rid(i, j), rid(i, j + 1), rid(i + 1, j + 1), rid(i + 1, j)], uv: [[j / m, vOf(i)], [(j + 1) / m, vOf(i)], [(j + 1) / m, vOf(i + 1)], [j / m, vOf(i + 1)]] });
    }
  }
  if (sideFaces.length) {
    const f = sideFaces[0];
    const fn = faceNormalOf(verts, f.v);
    const mid = verts[f.v[0]];
    const out = sub(mid, rings[0].c);
    if (dot(fn, out) < 0) sideFaces.forEach((x) => { x.v.reverse(); x.uv.reverse(); });
  }
  faces.push(...sideFaces);

  // Each end: a k × k grid of quads filling the last ring (a Coons patch), domed out to the tip.
  const cap = (ri: number, tip: V3, vEnd: number) => {
    const r = rings[ri];
    const R = (t: number) => ringAt(r, (((t % m) + m) % m / m) * Math.PI * 2);
    const B = (i: number) => R(i), Rt = (j: number) => R(k + j), T = (i: number) => R(3 * k - i), L = (j: number) => R(4 * k - j);
    const P00 = R(0), P10 = R(k), P11 = R(2 * k), P01 = R(3 * k);
    const lift = sub(tip, r.c);
    const grid: number[][] = [];
    for (let i = 0; i <= k; i++) {
      grid.push([]);
      for (let j = 0; j <= k; j++) {
        if (j === 0) { grid[i].push(rid(ri, i)); continue; }
        if (i === k) { grid[i].push(rid(ri, k + j)); continue; }
        if (j === k) { grid[i].push(rid(ri, 3 * k - i)); continue; }
        if (i === 0) { grid[i].push(rid(ri, 4 * k - j)); continue; }
        const s = i / k, t = j / k;
        const x = (1 - t) * B(i)[0] + t * T(i)[0] + (1 - s) * L(j)[0] + s * Rt(j)[0]
          - ((1 - s) * (1 - t) * P00[0] + s * (1 - t) * P10[0] + (1 - s) * t * P01[0] + s * t * P11[0]);
        const z = (1 - t) * B(i)[1] + t * T(i)[1] + (1 - s) * L(j)[1] + s * Rt(j)[1]
          - ((1 - s) * (1 - t) * P00[1] + s * (1 - t) * P10[1] + (1 - s) * t * P01[1] + s * t * P11[1]);
        // A round dome: full height at the middle, none at the ring.
        const e = Math.min(1, Math.hypot(x / (r.rx || 1), z / (r.rz || 1)));
        const hgt = Math.sqrt(Math.max(0, 1 - e * e));
        grid[i].push(verts.length);
        verts.push(place(r, x, z, [lift[0] * hgt, lift[1] * hgt, lift[2] * hgt]));
      }
    }
    const capFaces: Prim['faces'] = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) {
      capFaces.push({ v: [grid[i][j], grid[i + 1][j], grid[i + 1][j + 1], grid[i][j + 1]], uv: [[i / k, vEnd], [(i + 1) / k, vEnd], [(i + 1) / k, vEnd], [i / k, vEnd]] });
    }
    // Wind the cap to face its tip.
    const c = capFaces[Math.floor(capFaces.length / 2)];
    if (dot(faceNormalOf(verts, c.v), lift) < 0) capFaces.forEach((x) => { x.v.reverse(); x.uv.reverse(); });
    faces.push(...capFaces);
  };
  cap(0, tips[0], 1);
  cap(rings.length - 1, tips[1], 0);
  return { verts, faces, smooth };
}

/**
 * Inflate a drawn outline that may have limbs, like a hand's fingers: the body and each limb become their own
 * quadSilhouette, each along its own direction, overlapping where they join, all in one piece. `profile` shapes
 * the body. Each limb has its own profile, running from its root (bottom) to its tip (top), whose depths are
 * shares of the body's middle depth, so the whole thing thickens and thins together.
 */
export function inflateParts(outline: V2[], origin: V3, right: V3, up: V3, rows = 8, sides = 16, smooth = true, profile: PenProfile = ROUND_PROFILE(), limbProfiles: PenProfile[] = []): Prim | null {
  const { body, limbs, tips } = splitOutline(outline);
  const main = quadSilhouette(body, origin, right, up, rows, sides, smooth, profile);
  if (!main) return null;
  const extent = (o: V2[]) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (const [x, y] of o) { a = Math.min(a, x); b = Math.max(b, x); c = Math.min(c, y); d = Math.max(d, y); } return Math.max(b - a, d - c); };
  const bodySize = extent(body);
  const verts = main.verts.slice(), faces = main.faces.slice();
  limbs.forEach((limb, i) => {
    // Fewer rings along a shorter limb, so it keeps the body's spacing.
    const r = Math.max(3, Math.round((rows * extent(limb)) / Math.max(bodySize, 1e-9)));
    const own = limbProfiles[i] ?? ROUND_PROFILE();
    const d = profile.depth[1];
    const p = quadSilhouette(limb, origin, right, up, r, sides, smooth, { depth: own.depth.map((x) => x * d) as [number, number, number], width: own.width }, tips[i]);
    if (!p) return;
    const off = verts.length;
    verts.push(...p.verts);
    faces.push(...p.faces.map((f) => ({ v: f.v.map((v) => v + off), uv: f.uv })));
  });
  return { verts, faces, smooth };
}

function faceNormalOf(verts: V3[], f: number[]): V3 {
  let n: V3 = [0, 0, 0];
  for (let i = 0; i < f.length; i++) {
    const a = verts[f[i]], b = verts[f[(i + 1) % f.length]];
    n = add(n, [(a[1] - b[1]) * (a[2] + b[2]), (a[2] - b[2]) * (a[0] + b[0]), (a[0] - b[0]) * (a[1] + b[1])]);
  }
  return norm(n);
}
