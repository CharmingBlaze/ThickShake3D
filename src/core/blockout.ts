// Blockout: roughing out any model from whole pieces, whether a character, a prop or a place. A piece is a group.
import { bounds, cross, dist, norm, sub, triangulateFace } from './geom';
import { deformPoints, fuse, type DeformMode } from './organic';
import { decimate } from './decimate';
import { addPrim, groupFaces, removeLoose } from './ops';
import * as prims from './primitives';
import { mirrorName } from './skeleton';
import { makeGroup, makeMaterial, uniqueName, type Group, type Model, type V3 } from './types';

/** Muted colours that read as separate pieces without looking finished. */
export const BLOCK_COLORS = ['#c9cdd2', '#8e9ba8', '#c4a57b', '#a3b18a', '#b08d8d', '#7f9c9c', '#b7a6c9', '#d1b45f', '#8a9a5b', '#c98b6b'];

export function blockColorOf(g: Group): string {
  return g.color ?? BLOCK_COLORS[g.id % BLOCK_COLORS.length];
}

function groupVerts(m: Model, gid: number): Set<number> {
  const out = new Set<number>();
  for (const f of m.faces) if (f.g === gid) for (const v of f.v) out.add(v);
  return out;
}

export function pieceBounds(m: Model, gid: number) {
  return bounds([...groupVerts(m, gid)].map((v) => m.verts[v].p));
}

function movePiece(m: Model, gid: number, by: V3) {
  for (const v of groupVerts(m, gid)) {
    const p = m.verts[v].p;
    m.verts[v].p = [p[0] + by[0], p[1] + by[1], p[2] + by[2]];
  }
}

/** Lower each piece onto whatever is under it, or else onto the ground. Lowest pieces go first, so stacks settle. */
export function dropPieces(m: Model, gids: number[]) {
  const moving = new Set(gids);
  const order = [...gids].sort((a, b) => pieceBounds(m, a).min[1] - pieceBounds(m, b).min[1]);
  for (const gid of order) {
    const box = pieceBounds(m, gid);
    let floor = 0;
    for (const g of m.groups) {
      if (g.id === gid || !g.visible) continue;
      if (moving.has(g.id) && pieceBounds(m, g.id).min[1] > box.min[1]) continue;
      if (!groupFaces(m, g.id).length) continue;
      const o = pieceBounds(m, g.id);
      const overlap = box.min[0] < o.max[0] - 1e-6 && box.max[0] > o.min[0] + 1e-6 && box.min[2] < o.max[2] - 1e-6 && box.max[2] > o.min[2] + 1e-6;
      if (overlap && o.max[1] <= box.min[1] + 1e-6 && o.max[1] > floor) floor = o.max[1];
    }
    movePiece(m, gid, [0, floor - box.min[1], 0]);
  }
}

/** Line each piece's lowest corner up with the grid, keeping its shape. */
export function snapPieces(m: Model, gids: number[], step: number) {
  for (const gid of gids) {
    const { min } = pieceBounds(m, gid);
    const snap = (v: number) => Math.round(v / step) * step;
    movePiece(m, gid, [snap(min[0]) - min[0], snap(min[1]) - min[1], snap(min[2]) - min[2]]);
  }
}

/** Line pieces up with the active one along an axis. */
export function alignPieces(m: Model, gids: number[], to: number, axis: 0 | 1 | 2, edge: 'min' | 'center' | 'max') {
  const target = pieceBounds(m, to)[edge][axis];
  for (const gid of gids) {
    if (gid === to) continue;
    const by: V3 = [0, 0, 0];
    by[axis] = target - pieceBounds(m, gid)[edge][axis];
    movePiece(m, gid, by);
  }
}

/** Copy a piece as its own group, offset by `by`. Returns the new group's id. */
function copyPiece(m: Model, gid: number, by: V3): number {
  const src = m.groups.find((g) => g.id === gid)!;
  const copy = makeGroup(m, uniqueName(m.groups.map((g) => g.name), src.name), src.material, src.kind);
  if (src.color) copy.color = src.color;
  const map = new Map<number, number>();
  const count = m.faces.length;
  for (let i = 0; i < count; i++) {
    const f = m.faces[i];
    if (f.g !== gid) continue;
    const v = f.v.map((o) => {
      let n = map.get(o);
      if (n === undefined) {
        const p = m.verts[o].p;
        n = m.verts.length;
        m.verts.push({ p: [p[0] + by[0], p[1] + by[1], p[2] + by[2]], ...(m.verts[o].w ? { w: m.verts[o].w!.map((x) => [x[0], x[1]] as [number, number]) } : {}) });
        map.set(o, n);
      }
      return n;
    });
    m.faces.push({ v, uv: f.uv.map((u) => [u[0], u[1]]), g: copy.id, s: f.s, ...(f.seam ? { seam: f.seam.slice() } : {}) });
  }
  return copy.id;
}

/** Repeat pieces in a line. `count` includes the originals. Returns the new groups. */
export function arrayPieces(m: Model, gids: number[], count: number, offset: V3): number[] {
  const made: number[] = [];
  for (const gid of gids) {
    for (let i = 1; i < count; i++) made.push(copyPiece(m, gid, [offset[0] * i, offset[1] * i, offset[2] * i]));
  }
  return made;
}

/**
 * Reflect a piece across X as a new piece, so an arm gets its other arm. Names gain .L and .R. Returns the new
 * group's id, or null for a piece on the centre line, which is already its own mirror image.
 */
export function mirrorPiece(m: Model, gid: number): number | null {
  const box = pieceBounds(m, gid);
  // Anything crossing the centre line, like a torso drawn by hand, doesn't need a twin.
  if (box.min[0] < 1e-4 && box.max[0] > -1e-4) return null;
  const src = m.groups.find((g) => g.id === gid)!;
  let name = mirrorName(src.name);
  if (!name) {
    const left = box.center[0] > 0; // +X is a character's left when it faces +Z.
    const base = src.name;
    src.name = uniqueName(m.groups.filter((g) => g !== src).map((g) => g.name), `${base}.${left ? 'L' : 'R'}`);
    name = `${base}.${left ? 'R' : 'L'}`;
  }
  const copy = makeGroup(m, uniqueName(m.groups.map((g) => g.name), name), src.material, src.kind);
  if (src.color) copy.color = src.color;
  const map = new Map<number, number>();
  const count = m.faces.length;
  for (let i = 0; i < count; i++) {
    const f = m.faces[i];
    if (f.g !== gid) continue;
    const v = f.v.map((o) => {
      let n = map.get(o);
      if (n === undefined) {
        const p = m.verts[o].p;
        n = m.verts.length;
        m.verts.push({ p: [-p[0], p[1], p[2]] });
        map.set(o, n);
      }
      return n;
    });
    // Reflection turns a face inside out, so its corners run the other way.
    m.faces.push({ v: v.reverse(), uv: f.uv.map((u) => [u[0], u[1]] as [number, number]).reverse(), g: copy.id, s: f.s });
  }
  return copy.id;
}

// ---------- pieces along a line, and starter bodies ----------
type Shape = 'capsule' | 'sphere' | 'tapered' | 'box';

function shapePrim(shape: Shape): prims.Prim {
  switch (shape) {
    case 'sphere': return prims.sphere(0.5, 16, 10);
    case 'tapered': return prims.cylinder(0.32, 0.5, 1, 12, 1);
    case 'box': return prims.box(1, 1, 1);
    default: return prims.capsule(0.5, 3, 12, 7);
  }
}

/** Axes for a piece running from a to b. X stays as close to world X as it can, so widths mean what they look like. */
export function limbFrame(a: V3, b: V3): { x: V3; y: V3; z: V3; length: number } {
  const y = norm(sub(b, a));
  const seed: V3 = Math.abs(y[2]) < 0.95 ? [0, 0, 1] : [0, 1, 0];
  const x = norm(cross(y, seed));
  return { x, y, z: cross(x, y), length: dist(a, b) };
}

/** Add a piece that runs from a to b, with a half-width `rx` and half-depth `rz`. Returns its group's id. */
export function addLimb(m: Model, name: string, shape: Shape, a: V3, b: V3, rx: number, rz = rx, color?: string): number {
  const p = shapePrim(shape);
  const box = bounds(p.verts);
  const f = limbFrame(a, b);
  const verts = p.verts.map((v): V3 => {
    const lx = ((v[0] - box.center[0]) / (box.size[0] || 1)) * 2 * rx;
    const ly = ((v[1] - box.min[1]) / (box.size[1] || 1)) * f.length;
    const lz = ((v[2] - box.center[2]) / (box.size[2] || 1)) * 2 * rz;
    return [
      a[0] + f.x[0] * lx + f.y[0] * ly + f.z[0] * lz,
      a[1] + f.x[1] * lx + f.y[1] * ly + f.z[1] * lz,
      a[2] + f.x[2] * lx + f.y[2] * ly + f.z[2] * lz,
    ];
  });
  const res = addPrim(m, { ...p, verts }, name);
  const g = m.groups.find((x) => x.id === res.groupId)!;
  if (color) g.color = color;
  return res.groupId;
}

const SKIN = '#c4a57b', BODY = '#8e9ba8', LIMB = '#c9cdd2', END = '#b08d8d';
type Spec = [name: string, shape: Shape, a: V3, b: V3, rx: number, rz: number, color: string];

export type Starter = 'character' | 'chibi' | 'creature';

/** Body plans as pieces, in units of total height, feet on the ground, facing +Z. `side` pieces get a mirrored twin. */
function starterSpec(kind: Starter): { centre: Spec[]; side: Spec[] } {
  if (kind === 'creature') {
    return {
      centre: [
        ['Body', 'capsule', [0, 0.62, -0.42], [0, 0.66, 0.2], 0.2, 0.22, BODY],
        ['Neck', 'capsule', [0, 0.72, 0.2], [0, 0.92, 0.42], 0.1, 0.1, BODY],
        ['Head', 'sphere', [0, 0.84, 0.4], [0, 1, 0.55], 0.11, 0.12, SKIN],
        ['Snout', 'capsule', [0, 0.92, 0.52], [0, 0.88, 0.72], 0.06, 0.06, SKIN],
        ['Tail', 'tapered', [0, 0.72, -0.5], [0, 0.82, -0.98], 0.05, 0.05, END],
      ],
      side: [
        ['FrontThigh', 'capsule', [0.15, 0.62, 0.14], [0.17, 0.32, 0.18], 0.07, 0.08, LIMB],
        ['FrontShin', 'capsule', [0.17, 0.34, 0.18], [0.17, 0.04, 0.16], 0.05, 0.05, LIMB],
        ['FrontPaw', 'capsule', [0.17, 0.05, 0.1], [0.17, 0.04, 0.28], 0.06, 0.05, END],
        ['BackThigh', 'capsule', [0.15, 0.62, -0.4], [0.17, 0.32, -0.3], 0.09, 0.1, LIMB],
        ['BackShin', 'capsule', [0.17, 0.34, -0.3], [0.17, 0.04, -0.38], 0.05, 0.05, LIMB],
        ['BackPaw', 'capsule', [0.17, 0.05, -0.44], [0.17, 0.04, -0.26], 0.06, 0.05, END],
      ],
    };
  }
  if (kind === 'chibi') {
    return {
      centre: [
        ['Head', 'sphere', [0, 0.54, 0], [0, 1, 0], 0.26, 0.24, SKIN],
        ['Chest', 'capsule', [0, 0.28, 0], [0, 0.56, 0], 0.13, 0.1, BODY],
      ],
      side: [
        ['Arm', 'capsule', [0.13, 0.52, 0], [0.27, 0.28, 0], 0.05, 0.05, LIMB],
        ['Hand', 'sphere', [0.26, 0.31, 0], [0.31, 0.21, 0], 0.05, 0.05, END],
        ['Leg', 'capsule', [0.08, 0.32, 0], [0.09, 0.04, 0], 0.06, 0.06, LIMB],
        ['Foot', 'capsule', [0.09, 0.04, -0.05], [0.09, 0.04, 0.13], 0.06, 0.04, END],
      ],
    };
  }
  return {
    centre: [
      ['Head', 'sphere', [0, 0.87, 0], [0, 1, 0], 0.065, 0.075, SKIN],
      ['Neck', 'capsule', [0, 0.82, 0], [0, 0.89, 0], 0.03, 0.03, SKIN],
      ['Chest', 'capsule', [0, 0.65, 0], [0, 0.84, 0], 0.115, 0.075, BODY],
      ['Belly', 'capsule', [0, 0.54, 0], [0, 0.68, 0], 0.09, 0.065, BODY],
      ['Pelvis', 'capsule', [0, 0.46, 0], [0, 0.56, 0], 0.1, 0.07, BODY],
    ],
    side: [
      ['UpperArm', 'capsule', [0.125, 0.81, 0], [0.2, 0.63, 0], 0.035, 0.035, LIMB],
      ['Forearm', 'capsule', [0.2, 0.64, 0], [0.255, 0.47, 0.015], 0.028, 0.028, LIMB],
      ['Hand', 'capsule', [0.255, 0.48, 0.015], [0.275, 0.39, 0.025], 0.028, 0.016, END],
      ['Thigh', 'capsule', [0.06, 0.5, 0], [0.07, 0.27, 0], 0.05, 0.055, LIMB],
      ['Shin', 'capsule', [0.07, 0.28, 0], [0.075, 0.045, -0.005], 0.037, 0.04, LIMB],
      ['Foot', 'capsule', [0.075, 0.03, -0.035], [0.075, 0.03, 0.11], 0.035, 0.03, END],
    ],
  };
}

/** Add a ready-made body at the given height, as separate named pieces to reshape. Returns the new groups. */
export function addStarter(m: Model, kind: Starter, height = 1.8): number[] {
  const { centre, side } = starterSpec(kind);
  const s = (p: V3, flip = 1): V3 => [p[0] * height * flip, p[1] * height, p[2] * height];
  const out: number[] = [];
  const names = () => m.groups.map((g) => g.name);
  for (const [name, shape, a, b, rx, rz, color] of centre) {
    out.push(addLimb(m, uniqueName(names(), name), shape, s(a), s(b), rx * height, rz * height, color));
  }
  for (const [name, shape, a, b, rx, rz, color] of side) {
    out.push(addLimb(m, uniqueName(names(), `${name}.L`), shape, s(a), s(b), rx * height, rz * height, color));
    out.push(addLimb(m, uniqueName(names(), `${name}.R`), shape, s(a, -1), s(b, -1), rx * height, rz * height, color));
  }
  // Rounded and tilted pieces can reach past the plan, so settle the whole body at exactly the height asked for.
  const moved = new Set<number>();
  const made = new Set(out);
  for (const f of m.faces) if (made.has(f.g)) f.v.forEach((v) => moved.add(v));
  const top = Math.max(...[...moved].map((v) => m.verts[v].p[1]));
  if (top > 1e-6) {
    const k = height / top;
    for (const v of moved) { const p = m.verts[v].p; m.verts[v].p = [p[0] * k, p[1] * k, p[2] * k]; }
  }
  return out;
}

/** Reshape a whole piece along an axis. */
export function deformPiece(m: Model, gid: number, mode: DeformMode, axis: 0 | 1 | 2, amount: number) {
  const ids = [...groupVerts(m, gid)];
  const moved = deformPoints(ids.map((v) => m.verts[v].p), mode, axis, amount);
  ids.forEach((v, i) => { m.verts[v].p = moved[i]; });
}

/** A piece's opposite-side twin, if it has one: its mirrored name, sitting at its mirrored position. */
export function twinOf(m: Model, gid: number): number | null {
  const g = m.groups.find((x) => x.id === gid);
  const name = g && mirrorName(g.name);
  const twin = name ? m.groups.find((x) => x.name === name) : undefined;
  if (!twin) return null;
  const a = pieceBounds(m, gid), b = pieceBounds(m, twin.id);
  return Math.abs(a.center[0] + b.center[0]) < 1e-3 + a.size[0] && Math.abs(a.center[1] - b.center[1]) < 1e-3 + a.size[1] ? twin.id : null;
}

/** Repeat pieces evenly around an axis through `pivot`. `count` includes the originals. Returns the new groups. */
export function radialPieces(m: Model, gids: number[], count: number, axis: 0 | 1 | 2, pivot: V3): number[] {
  const made: number[] = [];
  const a = ((axis + 1) % 3) as 0 | 1 | 2, b = ((axis + 2) % 3) as 0 | 1 | 2;
  for (const gid of gids) {
    for (let i = 1; i < count; i++) {
      const id = copyPiece(m, gid, [0, 0, 0]);
      const th = (i / count) * Math.PI * 2, s = Math.sin(th), c = Math.cos(th);
      for (const v of groupVerts(m, id)) {
        const p = [...m.verts[v].p] as V3;
        const da = p[a] - pivot[a], db = p[b] - pivot[b];
        p[a] = pivot[a] + da * c - db * s;
        p[b] = pivot[b] + da * s + db * c;
        m.verts[v].p = p;
      }
      made.push(id);
    }
  }
  return made;
}

/** The triangles of a piece, for fusing. */
function pieceTriangles(m: Model, gid: number): [V3, V3, V3][] {
  const out: [V3, V3, V3][] = [];
  for (const f of m.faces) {
    if (f.g !== gid) continue;
    const t = triangulateFace(m, f);
    for (let i = 0; i < t.length; i += 3) out.push([m.verts[f.v[t[i]]].p, m.verts[f.v[t[i + 1]]].p, m.verts[f.v[t[i + 2]]].p]);
  }
  return out;
}

/**
 * Melt pieces into one seamless mesh and replace them with it. It takes the first piece's colour and material.
 * `cells` sets the detail along the longest side, and `smoothing` how much the joins round off. Returns the new group.
 */
export function fusePieces(m: Model, gids: number[], cells = 48, smoothing = 1, smooth = true): number | null {
  const shapes = gids.map((g) => ({ tris: pieceTriangles(m, g) }));
  const prim = fuse(shapes, cells, smoothing, smooth);
  if (!prim) return null;
  const first = m.groups.find((g) => g.id === gids[0]);
  const gone = new Set(gids);
  m.faces = m.faces.filter((f) => !gone.has(f.g));
  removeLoose(m);
  m.groups = m.groups.filter((g) => !gone.has(g.id));
  const res = addPrim(m, prim, uniqueName(m.groups.map((g) => g.name), gids.length > 1 ? 'Fused' : first?.name ?? 'Fused'), { material: first?.material ?? null });
  const g = m.groups.find((x) => x.id === res.groupId)!;
  if (first) g.color = blockColorOf(first);
  return res.groupId;
}

/** Simplify a piece for a lower polygon count. `ratio` is the share of triangles to keep. */
export function reducePiece(m: Model, gid: number, ratio: number) {
  const src = groupFaces(m, gid);
  if (!src.length) return;
  const res = decimate(m, src, ratio);
  const base = m.verts.length;
  m.verts.push(...res.verts);
  const gone = new Set(src);
  m.faces = m.faces.filter((_, i) => !gone.has(i));
  for (const f of res.faces) m.faces.push({ ...f, v: f.v.map((v) => v + base), g: gid });
  removeLoose(m);
}

/** Turn blockout colours into real materials, so they survive export. One material per colour. */
export function colorsToMaterials(m: Model): number {
  const byColor = new Map<string, number>();
  let made = 0;
  for (const g of m.groups) {
    if (g.material !== null) continue;
    const c = blockColorOf(g);
    let id = byColor.get(c);
    if (id === undefined) {
      const mat = makeMaterial(m, uniqueName(m.materials.map((x) => x.name), 'Blockout'), c);
      mat.roughness = 0.85;
      id = mat.id;
      byColor.set(c, id);
      made++;
    }
    g.material = id;
  }
  return made;
}

/** A stick figure for judging size when that matters, as line segments from feet at the origin. Not part of the model. */
export function scaleFigure(height: number): V3[] {
  const h = height;
  const seg: V3[] = [];
  const line = (a: V3, b: V3) => { seg.push(a, b); };
  const hip = 0.53 * h, shoulder = 0.81 * h, neck = 0.86 * h, sw = 0.13 * h, hw = 0.06 * h, reach = 0.26 * h;
  line([-hw, 0, 0], [-hw, hip, 0]); line([hw, 0, 0], [hw, hip, 0]);
  line([-hw, hip, 0], [hw, hip, 0]); line([0, hip, 0], [0, neck, 0]);
  line([-sw, shoulder, 0], [sw, shoulder, 0]);
  line([-sw, shoulder, 0], [-reach, 0.5 * h, 0]); line([sw, shoulder, 0], [reach, 0.5 * h, 0]);
  const r = 0.07 * h, cy = h - r;
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2, b = ((i + 1) / 16) * Math.PI * 2;
    line([Math.cos(a) * r, cy + Math.sin(a) * r, 0], [Math.cos(b) * r, cy + Math.sin(b) * r, 0]);
    line([0, cy + Math.sin(a) * r, Math.cos(a) * r], [0, cy + Math.sin(b) * r, Math.cos(b) * r]);
  }
  return seg;
}
