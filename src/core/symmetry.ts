// Symmetry across X for mesh tools: finding each vertex's twin on the other side, and growing a selection to take
// in the other side's matching vertices, edges and faces, so a tool run on one side happens on both.
import { edgeKey, parseEdge } from './geom';
import type { Model, V3 } from './types';

const key = (p: V3) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;

/** Each vertex's twin across X (itself when it sits on the centre line); vertices with no twin are left out. */
export function mirrorVerts(m: Model): Map<number, number> {
  const at = new Map<string, number>();
  m.verts.forEach((v, i) => at.set(key(v.p), i));
  const out = new Map<number, number>();
  m.verts.forEach((v, i) => {
    const o = at.get(key([-v.p[0], v.p[1], v.p[2]]));
    if (o !== undefined) out.set(i, o);
  });
  return out;
}

export interface Selection { verts: Set<number>; edges: Set<string>; faces: Set<number> }

/** The selection with the other side's matching vertices, edges and faces added. */
export function mirrorSelection(m: Model, sel: Selection): Selection {
  const tw = mirrorVerts(m);
  const verts = new Set(sel.verts);
  sel.verts.forEach((v) => { const o = tw.get(v); if (o !== undefined) verts.add(o); });
  const edges = new Set(sel.edges);
  sel.edges.forEach((k) => {
    const [a, b] = parseEdge(k);
    const oa = tw.get(a), ob = tw.get(b);
    if (oa !== undefined && ob !== undefined && oa !== ob) edges.add(edgeKey(oa, ob));
  });
  const faces = new Set(sel.faces);
  if (sel.faces.size) {
    const byVerts = new Map<string, number>();
    m.faces.forEach((f, i) => byVerts.set([...f.v].sort((x, y) => x - y).join(','), i));
    sel.faces.forEach((fi) => {
      const f = m.faces[fi];
      if (!f) return;
      const tv = f.v.map((v) => tw.get(v));
      if (tv.some((x) => x === undefined)) return;
      const o = byVerts.get((tv as number[]).sort((x, y) => x - y).join(','));
      if (o !== undefined) faces.add(o);
    });
  }
  return { verts, edges, faces };
}

/** Whether a mesh is the same on both sides of X: every vertex has a twin. */
export function isSymmetric(m: Model): boolean {
  const tw = mirrorVerts(m);
  return m.verts.every((_, i) => tw.has(i));
}

/** Each face's twin across X: the face whose corners are its corners' twins. */
export function mirrorFaces(m: Model): Map<number, number> {
  const tw = mirrorVerts(m);
  const byVerts = new Map<string, number>();
  m.faces.forEach((f, i) => byVerts.set([...f.v].sort((x, y) => x - y).join(','), i));
  const out = new Map<number, number>();
  m.faces.forEach((f, i) => {
    const tv = f.v.map((v) => tw.get(v));
    if (tv.some((x) => x === undefined)) return;
    const o = byVerts.get((tv as number[]).sort((x, y) => x - y).join(','));
    if (o !== undefined) out.set(i, o);
  });
  return out;
}

/** The given parts plus the parts holding their faces' twins across X. */
export function mirrorGroups(m: Model, groups: Set<number>): Set<number> {
  const out = new Set(groups);
  const tf = mirrorFaces(m);
  m.faces.forEach((f, i) => {
    if (!groups.has(f.g)) return;
    const o = tf.get(i);
    if (o !== undefined) out.add(m.faces[o].g);
  });
  return out;
}

/**
 * Copy UVs from one side of X to the twin faces on the other, as Blender's Copy Mirrored UVs: `overlap` puts them on
 * the same spot, so painting one side paints both; `flip` mirrors them across the texture's middle (u to 1 - u), to
 * match painting with the paint editor's Mirror. Seams copy across too. `faces` limits it to those (either side);
 * null does the whole mesh. Returns the number of faces changed.
 */
export function copyMirroredUVs(m: Model, faces: Set<number> | null, from: 1 | -1, mode: 'overlap' | 'flip'): number {
  const tw = mirrorVerts(m);
  const tf = mirrorFaces(m);
  const side = (fi: number) => m.faces[fi].v.reduce((s, v) => s + m.verts[v].p[0], 0) / m.faces[fi].v.length;
  let n = 0;
  m.faces.forEach((f, fi) => {
    if (side(fi) * from <= 1e-6) return;
    const oi = tf.get(fi);
    if (oi === undefined || oi === fi) return;
    if (faces && !faces.has(fi) && !faces.has(oi)) return;
    const o = m.faces[oi];
    const cornerOf = new Map<number, number>();
    f.v.forEach((v, i) => cornerOf.set(tw.get(v)!, i));
    o.uv = o.v.map((v) => {
      const u = f.uv[cornerOf.get(v)!];
      return mode === 'flip' ? [1 - u[0], u[1]] : [u[0], u[1]];
    });
    // A seam on an edge of this face is a seam on the twin's matching edge.
    if (f.seam || o.seam) {
      const seamed = new Set<string>();
      f.v.forEach((v, i) => { if (f.seam?.[i]) { const a = tw.get(v)!, b = tw.get(f.v[(i + 1) % f.v.length])!; seamed.add(a < b ? `${a}_${b}` : `${b}_${a}`); } });
      o.seam = o.v.map((v, j) => { const w = o.v[(j + 1) % o.v.length]; return seamed.has(v < w ? `${v}_${w}` : `${w}_${v}`); });
    }
    n++;
  });
  return n;
}
