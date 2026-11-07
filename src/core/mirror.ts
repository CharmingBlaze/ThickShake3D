// The Mirror modifier, after Blender's: a mesh group shows mirrored across one or more axes without the mirrored
// half being real geometry until it's applied. Bisect cuts the mesh at the mirror plane first, Flip keeps the other
// side, Merge joins the halves along the seam, Clipping keeps points from crossing it while editing. Exports apply it.
import { cloneModel, type Face, type MirrorMod, type Model, type V2, type V3 } from './types';
import { mirrorName } from './skeleton';
import { removeLoose, weld } from './ops';

export const MIRROR_DEFAULTS: MirrorMod = {
  on: true, axis: [true, false, false], bisect: [false, false, false], flip: [false, false, false],
  pivot: null, clipping: true, merge: true, mergeDistance: 0.001, bisectDistance: 0.001,
};

/** A group's mirror, filled out with defaults for anything an older project left out. */
export function mirrorOf(m: Model, groupId: number): MirrorMod | null {
  const g = m.groups.find((x) => x.id === groupId);
  return g?.mirror ? { ...MIRROR_DEFAULTS, ...g.mirror } : null;
}

/** Where the mirror planes meet: the world origin, a joint's rest position, or another group's centre. */
export function mirrorPivot(m: Model, mod: MirrorMod): V3 {
  const pv = mod.pivot;
  if (!pv) return [0, 0, 0];
  if (pv.kind === 'joint') return [...(m.bones.find((b) => b.id === pv.id)?.head ?? [0, 0, 0])] as V3;
  const vs = new Set(m.faces.filter((f) => f.g === pv.id).flatMap((f) => f.v));
  if (!vs.size) return [0, 0, 0];
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const v of vs) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], m.verts[v].p[k]); hi[k] = Math.max(hi[k], m.verts[v].p[k]); }
  return [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
}

/** Every mirrored copy to show: one per combination of the enabled axes, as scale factors of -1 or 1. */
export function mirrorCopies(mod: MirrorMod): V3[] {
  const axes = [0, 1, 2].filter((a) => mod.axis[a]);
  const out: V3[] = [];
  for (let mask = 1; mask < 1 << axes.length; mask++) {
    const s: V3 = [1, 1, 1];
    axes.forEach((a, i) => { if (mask & (1 << i)) s[a] = -1; });
    out.push(s);
  }
  return out;
}

/**
 * Keep points from crossing the mirror planes while they're edited, as Blender's Clipping does: a point that was on a
 * plane stays on it, and one that would cross stops at it. `before` holds the points' positions when the edit began.
 */
export function clipToMirror(m: Model, groupId: number, verts: Iterable<number>, before: Map<number, V3>) {
  const mod = mirrorOf(m, groupId);
  if (!mod || !mod.on || !mod.clipping) return;
  const c = mirrorPivot(m, mod);
  for (const v of verts) {
    const p = m.verts[v].p, p0 = before.get(v);
    if (!p0) continue;
    for (let a = 0; a < 3; a++) {
      if (!mod.axis[a]) continue;
      const d0 = p0[a] - c[a], d = p[a] - c[a];
      if (Math.abs(d0) <= mod.mergeDistance || (d0 > 0 && d < 0) || (d0 < 0 && d > 0)) p[a] = c[a];
    }
  }
}

// ---------- applying ----------
/** Cut a group's faces at a plane, keeping the side where the point's coordinate along `axis` is ≥ the plane's (or ≤, flipped). */
function bisect(m: Model, groupId: number, axis: number, at: number, flip: boolean, eps: number) {
  const keep = (p: V3) => (flip ? at - p[axis] : p[axis] - at) >= -eps;
  const cut = new Map<string, number>();
  const cross = (a: number, b: number): number => {
    const k = a < b ? `${a}_${b}` : `${b}_${a}`;
    let v = cut.get(k);
    if (v === undefined) {
      const pa = m.verts[a].p, pb = m.verts[b].p;
      const t = (at - pa[axis]) / (pb[axis] - pa[axis]);
      const p: V3 = [pa[0] + (pb[0] - pa[0]) * t, pa[1] + (pb[1] - pa[1]) * t, pa[2] + (pb[2] - pa[2]) * t];
      p[axis] = at;
      m.verts.push({ p, ...(m.verts[a].w ? { w: m.verts[a].w!.map((x) => [x[0], x[1]] as [number, number]) } : {}) });
      v = m.verts.length - 1;
      cut.set(k, v);
    }
    return v;
  };
  const out: Face[] = [];
  for (const f of m.faces) {
    if (f.g !== groupId) { out.push(f); continue; }
    const ins = f.v.map((v) => keep(m.verts[v].p));
    if (ins.every(Boolean)) { out.push(f); continue; }
    if (!ins.some(Boolean)) continue;
    // Keep the inside part of the outline, with points where it crosses the plane.
    const vs: number[] = [], uvs: V2[] = [];
    f.v.forEach((v, i) => {
      const j = (i + 1) % f.v.length;
      if (ins[i]) { vs.push(v); uvs.push(f.uv[i]); }
      if (ins[i] !== ins[j]) {
        const pa = m.verts[v].p, pb = m.verts[f.v[j]].p;
        const t = (at - pa[axis]) / (pb[axis] - pa[axis]);
        vs.push(cross(v, f.v[j]));
        uvs.push([f.uv[i][0] + (f.uv[j][0] - f.uv[i][0]) * t, f.uv[i][1] + (f.uv[j][1] - f.uv[i][1]) * t]);
      }
    });
    if (vs.length >= 3) out.push({ v: vs, uv: uvs, g: f.g, s: f.s });
  }
  m.faces = out;
  // Points already on the plane sit exactly on it, so the halves meet cleanly.
  for (const f of m.faces) if (f.g === groupId) for (const v of f.v) if (Math.abs(m.verts[v].p[axis] - at) <= eps) m.verts[v].p[axis] = at;
}

/** Make a group's mirror real: bisect, mirror across each axis in turn, merge the seam. The modifier is removed. */
export function applyMirror(m: Model, groupId: number) {
  const g = m.groups.find((x) => x.id === groupId);
  const mod = mirrorOf(m, groupId);
  if (!g || !mod) return;
  delete g.mirror;
  if (!mod.on) return;
  const c = mirrorPivot(m, { ...mod });
  // Joints for mirrored skin weights: a joint's twin by its name (Arm.L to Arm.R), or itself.
  const byName = new Map(m.bones.map((b) => [b.name, b.id]));
  const twinJoint = new Map(m.bones.map((b) => { const n = mirrorName(b.name); return [b.id, n ? byName.get(n) ?? b.id : b.id] as [number, number]; }));
  for (let a = 0; a < 3; a++) if (mod.axis[a] && mod.bisect[a]) bisect(m, groupId, a, c[a], mod.flip[a], mod.bisectDistance);
  for (let a = 0; a < 3; a++) {
    if (!mod.axis[a]) continue;
    const faces = m.faces.filter((f) => f.g === groupId);
    const used = [...new Set(faces.flatMap((f) => f.v))];
    const copy = new Map<number, number>();
    for (const v of used) {
      const src = m.verts[v];
      const p: V3 = [...src.p] as V3;
      p[a] = 2 * c[a] - p[a];
      // Weights follow the mirrored joints across X, as a left arm's do to the right.
      const w = src.w?.map(([b, x]) => [a === 0 ? twinJoint.get(b) ?? b : b, x] as [number, number]);
      m.verts.push(w ? { p, w } : { p });
      copy.set(v, m.verts.length - 1);
    }
    for (const f of faces) {
      // Mirroring turns a face inside out; reversing its corners turns it back.
      const n = f.v.length;
      m.faces.push({ v: f.v.map((v) => copy.get(v)!).reverse(), uv: f.uv.map((u) => [u[0], u[1]] as V2).reverse(), g: groupId, s: f.s });
      void n;
    }
    // Merge: points on the plane meet their copies.
    if (mod.merge) {
      const near = new Set<number>();
      for (const v of used) if (Math.abs(m.verts[v].p[a] - c[a]) <= mod.mergeDistance) { near.add(v); near.add(copy.get(v)!); }
      if (near.size) weld(m, near, mod.mergeDistance);
    }
  }
  removeLoose(m);
}

/** A copy of the model with every group's mirror applied, for exports. The model itself is unchanged. */
export function applyAllMirrors(m: Model): Model {
  if (!m.groups.some((g) => g.mirror)) return m;
  const out = cloneModel(m);
  for (const g of out.groups.slice()) if (g.mirror) applyMirror(out, g.id);
  return out;
}
