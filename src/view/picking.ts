// Screen-space picking against the current display positions.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { TriTree } from '../core/bvh';
import { edgeKey, triangulateFace } from '../core/geom';
import type { V3 } from '../core/types';
import type { Pane } from './pane';
import type { SceneGraph } from './scene';

export interface PickHit { face: number; point: THREE.Vector3; dist: number }

const a = new THREE.Vector3(), b = new THREE.Vector3(), cc = new THREE.Vector3(), out = new THREE.Vector3();

/**
 * The pickable triangles, as a tree for quick ray tests. A tree costs about as much to build as eight picks without
 * one, so it is built on the eighth pick of the same positions: a drag that reshapes the model between picks never
 * spends more than twice what it would have, and anything picked often, like hovering, gets the tree.
 */
let cache: { key: string; P: Float32Array; version: number; tris: Int32Array; faces: Int32Array; tree: TriTree | null; uses: number; sources: Set<ArrayLike<number>> } | null = null;

function pickable(sg: SceneGraph) {
  const m = ed.model;
  const P = ed.displayPositions();
  const hidden = new Set(m.groups.filter((g) => !g.visible || g.locked).map((g) => g.id));
  const groups = [...sg.groups.values()].filter((r) => !hidden.has(r.id));
  const key = groups.map((r) => `${r.id}:${r.corners.length}`).join(',');
  if (cache && cache.key === key && cache.P === P && cache.version === ed.posVersion && groups.every((r) => cache!.sources.has(r.corners))) {
    if (!cache.tree && ++cache.uses >= 8) cache.tree = new TriTree(P, cache.tris);
    return cache;
  }
  let n = 0;
  for (const r of groups) n += r.corners.length;
  const tris = new Int32Array(n), faces = new Int32Array(n / 3);
  let o = 0;
  for (const r of groups) {
    tris.set(r.corners, o);
    for (let i = 0; i < r.corners.length; i += 3) faces[(o + i) / 3] = r.cornerFace[i];
    o += r.corners.length;
  }
  cache = { key, P, version: ed.posVersion, tris, faces, tree: null, uses: 1, sources: new Set(groups.map((r) => r.corners)) };
  return cache;
}

/** Hits along the ray through (px, py): the nearest only, or all of them nearest first. */
function rayHits(pane: Pane, sg: SceneGraph, px: number, py: number, cullBack: boolean, all: boolean) {
  const ray = pane.ray(px, py);
  const o: V3 = [ray.origin.x, ray.origin.y, ray.origin.z], d: V3 = [ray.direction.x, ray.direction.y, ray.direction.z];
  const c = pickable(sg);
  if (c.tree) return { ray, faces: c.faces, hits: c.tree.hits(o, d, cullBack, all) };
  // Not worth a tree yet: test every triangle.
  const P = c.P, T = c.tris;
  const hits: { tri: number; t: number }[] = [];
  for (let i = 0; i < T.length; i += 3) {
    a.fromArray(P, T[i] * 3); b.fromArray(P, T[i + 1] * 3); cc.fromArray(P, T[i + 2] * 3);
    const hit = ray.intersectTriangle(a, b, cc, cullBack, out);
    if (!hit) continue;
    const t = hit.distanceTo(ray.origin);
    if (all) hits.push({ tri: i / 3, t });
    else if (!hits.length || t < hits[0].t) hits[0] = { tri: i / 3, t };
  }
  if (all) hits.sort((x, y) => x.t - y.t);
  return { ray, faces: c.faces, hits };
}

export function pickFace(pane: Pane, sg: SceneGraph, px: number, py: number, includeBack: boolean): PickHit | null {
  const { ray, faces, hits } = rayHits(pane, sg, px, py, !includeBack, false);
  const h = hits[0];
  return h ? { face: faces[h.tri], point: ray.at(h.t, new THREE.Vector3()), dist: h.t } : null;
}

/** The middle of the mesh under the mouse: halfway between where the ray goes in and where it next comes out. */
export function pickInside(pane: Pane, sg: SceneGraph, px: number, py: number): THREE.Vector3 | null {
  const { ray, hits } = rayHits(pane, sg, px, py, false, true);
  const ds = hits.map((h) => h.t);
  // Hits on a shared edge count twice; the exit is the first hit clearly past the entry.
  const exit = ds.find((d) => d > ds[0] + 1e-5);
  if (exit === undefined) return null;
  return ray.at((ds[0] + exit) / 2, new THREE.Vector3());
}

/** Is a world point hidden behind the surface, from this pane's view? */
export function occluded(pane: Pane, sg: SceneGraph, world: THREE.Vector3): boolean {
  const s = pane.project(world.x, world.y, world.z);
  const hit = pickFace(pane, sg, s.x, s.y, true);
  if (!hit) return false;
  const camDist = pane.ray(s.x, s.y).origin.distanceTo(world);
  // A small margin only: side views put the camera far away, so a share of that distance could swallow a whole model.
  return hit.dist < camDist - (1e-3 + camDist * 1e-6);
}

function usesDepth(pane: Pane) {
  return pane.shading !== 'wire' && !ed.xray;
}

export function pickVertex(pane: Pane, sg: SceneGraph, px: number, py: number, radius = 10): number | null {
  const P = ed.displayPositions();
  const cands: { v: number; d: number; z: number }[] = [];
  const list = sg.visibleVerts;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const s = pane.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    if (s.z < -1 || s.z > 1) continue;
    const d = Math.hypot(s.x - px, s.y - py);
    if (d <= radius) cands.push({ v, d, z: s.z });
  }
  cands.sort((x, y) => x.d - y.d || x.z - y.z);
  const depth = usesDepth(pane);
  for (const c1 of cands.slice(0, 16)) {
    if (!depth || !occluded(pane, sg, new THREE.Vector3().fromArray(P, c1.v * 3))) return c1.v;
  }
  return null;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

export function pickEdge(pane: Pane, sg: SceneGraph, px: number, py: number, radius = 8): string | null {
  const P = ed.displayPositions();
  const E = sg.edgeIndex;
  const cands: { k: string; d: number; a: number; b: number }[] = [];
  for (let i = 0; i < E.length; i += 2) {
    const x = E[i], y = E[i + 1];
    const sa = pane.project(P[x * 3], P[x * 3 + 1], P[x * 3 + 2]);
    const sb = pane.project(P[y * 3], P[y * 3 + 1], P[y * 3 + 2]);
    if (sa.z < -1 || sa.z > 1 || sb.z < -1 || sb.z > 1) continue;
    const d = segDist(px, py, sa.x, sa.y, sb.x, sb.y);
    if (d <= radius) cands.push({ k: edgeKey(x, y), d, a: x, b: y });
  }
  cands.sort((p, q) => p.d - q.d);
  const depth = usesDepth(pane);
  for (const e of cands.slice(0, 12)) {
    if (!depth) return e.k;
    const mid = new THREE.Vector3().fromArray(P, e.a * 3).add(new THREE.Vector3().fromArray(P, e.b * 3)).multiplyScalar(0.5);
    if (!occluded(pane, sg, mid)) return e.k;
  }
  return null;
}

export function pickBone(pane: Pane, px: number, py: number, radius = 10): number | null {
  const pose = ed.bonePose();
  let best: number | null = null, bestD = radius;
  const byId = new Map(ed.model.bones.map((x) => [x.id, x]));
  for (const bone of ed.model.bones) {
    const bp = pose.get(bone.id);
    if (!bp) continue;
    const s = pane.project(bp.pos[0], bp.pos[1], bp.pos[2]);
    const d = Math.hypot(s.x - px, s.y - py);
    if (d < bestD) { bestD = d; best = bone.id; }
    if (bone.parent !== null && byId.has(bone.parent)) {
      const pp = pose.get(bone.parent)!;
      const t = pane.project(pp.pos[0], pp.pos[1], pp.pos[2]);
      const sd = segDist(px, py, s.x, s.y, t.x, t.y);
      if (sd + 2 < bestD) { bestD = sd + 2; best = bone.parent; }
    }
  }
  return best;
}

export interface Rect { x0: number; y0: number; x1: number; y1: number }

export function boxVerts(pane: Pane, sg: SceneGraph, r: Rect): number[] {
  const P = ed.displayPositions();
  const list = sg.visibleVerts;
  const inside: number[] = [];
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const s = pane.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    if (s.z < -1 || s.z > 1) continue;
    if (s.x >= r.x0 && s.x <= r.x1 && s.y >= r.y0 && s.y <= r.y1) inside.push(v);
  }
  // Depth testing costs verts x tris, so skip it for very heavy selections.
  if (!usesDepth(pane) || inside.length * ed.model.faces.length > 2.5e7) return inside;
  return inside.filter((v) => !occluded(pane, sg, new THREE.Vector3().fromArray(P, v * 3)));
}

export function boxEdges(pane: Pane, sg: SceneGraph, r: Rect): string[] {
  const P = ed.displayPositions();
  const E = sg.edgeIndex;
  const out2: string[] = [];
  for (let i = 0; i < E.length; i += 2) {
    const x = E[i], y = E[i + 1];
    const sa = pane.project(P[x * 3], P[x * 3 + 1], P[x * 3 + 2]);
    const sb = pane.project(P[y * 3], P[y * 3 + 1], P[y * 3 + 2]);
    if (sa.x >= r.x0 && sa.x <= r.x1 && sa.y >= r.y0 && sa.y <= r.y1 && sb.x >= r.x0 && sb.x <= r.x1 && sb.y >= r.y0 && sb.y <= r.y1) {
      out2.push(edgeKey(x, y));
    }
  }
  return out2;
}

export function boxFaces(pane: Pane, r: Rect): number[] {
  const m = ed.model;
  const P = ed.displayPositions();
  const hidden = new Set(m.groups.filter((g) => !g.visible || g.locked).map((g) => g.id));
  const view = pane.isOrtho ? pane.viewDir() : null;
  const res: number[] = [];
  const depth = usesDepth(pane);
  m.faces.forEach((f, i) => {
    if (hidden.has(f.g)) return;
    let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
    const n = f.v.length;
    for (let k = 0; k < n; k++) {
      const a1 = f.v[k] * 3, b1 = f.v[(k + 1) % n] * 3;
      cx += P[a1]; cy += P[a1 + 1]; cz += P[a1 + 2];
      nx += (P[a1 + 1] - P[b1 + 1]) * (P[a1 + 2] + P[b1 + 2]);
      ny += (P[a1 + 2] - P[b1 + 2]) * (P[a1] + P[b1]);
      nz += (P[a1] - P[b1]) * (P[a1 + 1] + P[b1 + 1]);
    }
    cx /= n; cy /= n; cz /= n;
    const s = pane.project(cx, cy, cz);
    if (s.x < r.x0 || s.x > r.x1 || s.y < r.y0 || s.y > r.y1) return;
    if (depth) {
      const d = view ?? pane.viewDir(new THREE.Vector3(cx, cy, cz));
      if (nx * d.x + ny * d.y + nz * d.z <= 0) return; // Facing away.
    }
    res.push(i);
  });
  return res;
}

export function boxBones(pane: Pane, r: Rect): number[] {
  const pose = ed.bonePose();
  const out2: number[] = [];
  pose.forEach((bp, id) => {
    const s = pane.project(bp.pos[0], bp.pos[1], bp.pos[2]);
    if (s.x >= r.x0 && s.x <= r.x1 && s.y >= r.y0 && s.y <= r.y1) out2.push(id);
  });
  return out2;
}

export { triangulateFace };
