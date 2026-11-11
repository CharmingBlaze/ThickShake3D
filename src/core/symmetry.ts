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
