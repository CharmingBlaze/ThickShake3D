// Sculpting in the view: grab, draw, flatten, pinch and smooth the surface under a round brush.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { faceNormal, norm } from '../core/geom';
import { mirrorMaps, vertexNeighbors } from '../core/skeleton';
import type { V3 } from '../core/types';
import { toast } from '../ui/feedback';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

export interface SculptHost { sg: SceneGraph }

export type SculptDrag = { kind: 'sculpt'; pane: Pane; x0: number; y0: number; grabbed: { v: number; w: number }[]; orig: Map<number, V3>; at: THREE.Vector3; neighbors: Map<number, Set<number>>; mirror: Map<number, number> | null; moved: boolean };

/** The vertices under the brush, weighted by a soft falloff from its centre. */
function brushVerts(host: SculptHost, p: Pane, x: number, y: number): { v: number; w: number }[] {
  const P = ed.displayPositions();
  const r = ed.sculpt.radius;
  const seeThrough = ed.xray || p.shading === 'wire';
  const at = new THREE.Vector3();
  const out: { v: number; w: number }[] = [];
  const list = host.sg.visibleVerts;
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const s = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d > r) continue;
    if (!seeThrough && pick.occluded(p, host.sg, at.fromArray(P, v * 3))) continue;
    const k = 1 - d / r;
    out.push({ v, w: k * k * (3 - 2 * k) });
  }
  return out;
}

/** Start a sculpt stroke under the mouse, or null if the brush is over nothing. */
export function startSculpt(host: SculptHost, p: Pane, x: number, y: number, e: PointerEvent): SculptDrag | null {
  if (ed.poseActive) { toast('Sculpting edits the rest shape. Leave the pose first.', 'info'); return null; }
  const under = brushVerts(host, p, x, y);
  if (!under.length) return null;
  ed.begin('Sculpt');
  const m = ed.model;
  const hitAt = pick.pickFace(p, host.sg, x, y, true)?.point ?? new THREE.Vector3(...m.verts[under[0].v].p);
  const d: SculptDrag = {
    kind: 'sculpt', pane: p, x0: x, y0: y, grabbed: under,
    orig: new Map(under.map((u) => [u.v, [...m.verts[u.v].p] as V3])),
    at: hitAt.clone(), neighbors: vertexNeighbors(m), mirror: ed.mirrorX ? mirrorMaps(m).vert : null, moved: false,
  };
  if (ed.sculpt.mode !== 'grab') sculptStep(host, d, x, y, e);
  return d;
}

function setSculpted(d: SculptDrag, v: number, p: V3) {
  const m = ed.model;
  m.verts[v].p = p;
  const twin = d.mirror?.get(v);
  if (twin !== undefined && twin !== v) m.verts[twin].p = [-p[0], p[1], p[2]];
}

export function sculptStep(host: SculptHost, d: SculptDrag, x: number, y: number, e: PointerEvent) {
  const m = ed.model;
  const u = d.pane.unitsPerPixel(d.at);
  if (ed.sculpt.mode === 'grab') {
    const { right, up } = d.pane.screenAxes();
    const dx = (x - d.x0) * u, dy = -(y - d.y0) * u;
    for (const { v, w } of d.grabbed) {
      const o = d.orig.get(v)!;
      setSculpted(d, v, [o[0] + (right.x * dx + up.x * dy) * w, o[1] + (right.y * dx + up.y * dy) * w, o[2] + (right.z * dx + up.z * dy) * w]);
    }
  } else {
    const under = brushVerts(host, d.pane, x, y);
    if (ed.sculpt.mode === 'flatten' && !e.ctrlKey && under.length) {
      // Press everything under the brush toward their average plane.
      let cx = 0, cy = 0, cz = 0, nx = 0, ny = 0, nz = 0;
      const want = new Set(under.map((b) => b.v));
      for (const { v } of under) { const p = m.verts[v].p; cx += p[0]; cy += p[1]; cz += p[2]; }
      cx /= under.length; cy /= under.length; cz /= under.length;
      for (const f of m.faces) if (f.v.some((v) => want.has(v))) { const n = faceNormal(m, f); nx += n[0]; ny += n[1]; nz += n[2]; }
      const n = norm([nx, ny, nz]);
      for (const { v, w } of under) {
        const p = m.verts[v].p;
        const off = (p[0] - cx) * n[0] + (p[1] - cy) * n[1] + (p[2] - cz) * n[2];
        const k = off * Math.min(1, w * ed.sculpt.strength);
        setSculpted(d, v, [p[0] - n[0] * k, p[1] - n[1] * k, p[2] - n[2] * k]);
      }
      d.moved = true;
      ed.emit('geometry');
      return;
    }
    if (ed.sculpt.mode === 'pinch' && !e.ctrlKey) {
      // Draw the surface in toward the brush's centre, across the view: creases, lips, knuckles. Shift pushes apart.
      const view = d.pane.viewDir(d.at);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(view, d.at);
      const hit = d.pane.ray(x, y).intersectPlane(plane, new THREE.Vector3());
      if (hit) {
        const dirSign = e.shiftKey ? -1 : 1;
        for (const { v, w } of under) {
          const p = m.verts[v].p;
          const to = new THREE.Vector3(hit.x - p[0], hit.y - p[1], hit.z - p[2]);
          to.addScaledVector(view, -to.dot(view));
          const k = Math.min(0.5, w * ed.sculpt.strength * 0.25) * dirSign;
          setSculpted(d, v, [p[0] + to.x * k, p[1] + to.y * k, p[2] + to.z * k]);
        }
        d.moved = true;
        ed.emit('geometry');
      }
      return;
    }
    const smoothing = ed.sculpt.mode === 'smooth' || e.ctrlKey;
    const sign = e.shiftKey ? -1 : 1;
    // Vertex normals from the faces around each point.
    const normals = new Map<number, V3>();
    if (!smoothing) {
      const want = new Set(under.map((b) => b.v));
      for (const f of m.faces) {
        if (!f.v.some((v) => want.has(v))) continue;
        const n = faceNormal(m, f);
        for (const v of f.v) if (want.has(v)) { const o = normals.get(v) ?? [0, 0, 0]; normals.set(v, [o[0] + n[0], o[1] + n[1], o[2] + n[2]]); }
      }
    }
    const step = ed.sculpt.radius * u * 0.06 * ed.sculpt.strength;
    const next: [number, V3][] = [];
    for (const { v, w } of under) {
      const p = m.verts[v].p;
      if (smoothing) {
        const nb = d.neighbors.get(v);
        if (!nb?.size) continue;
        let a = 0, b = 0, c = 0;
        for (const o of nb) { const q = m.verts[o].p; a += q[0]; b += q[1]; c += q[2]; }
        const k = Math.min(1, w * ed.sculpt.strength * 1.5);
        next.push([v, [p[0] + (a / nb.size - p[0]) * k, p[1] + (b / nb.size - p[1]) * k, p[2] + (c / nb.size - p[2]) * k]]);
      } else {
        const n = norm(normals.get(v) ?? [0, 0, 0]);
        const k = step * w * sign;
        next.push([v, [p[0] + n[0] * k, p[1] + n[1] * k, p[2] + n[2] * k]]);
      }
    }
    next.forEach(([v, p]) => setSculpted(d, v, p));
  }
  d.moved = true;
  ed.emit('geometry');
}
