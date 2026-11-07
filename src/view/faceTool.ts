// The Face tool: build polygons point by point, in 3D, as Blender's Poly Build and PolyEcho's do. Points land on
// the model's surface under the mouse (for drawing over a model), or on a plane through the last point facing the
// view. Existing vertices snap; clicking an open edge starts from it; after each face the chain carries on from its
// last edge, so a whole mesh can be built a face at a time.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { edgeFaces, parseEdge } from '../core/geom';
import { nextSmooth } from '../core/ops';
import { makeMaterial, uniqueName, type Face, type Model, type V2, type V3 } from '../core/types';
import { status } from '../ui/feedback';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

export interface FaceToolHost {
  scene(): SceneGraph;
  invalidate(): void;
  /** A new group for a new mesh. Call inside an edit. */
  newGroup(): number;
  /** Snap a point to the grid when snapping is on. */
  snap(w: THREE.Vector3): void;
}

/** A point of the chain: an existing vertex, or a new one not yet made. */
type Pt = { v: number } | { p: V3 };

type Hover =
  | { kind: 'vertex'; v: number }
  | { kind: 'close' }
  | { kind: 'edge'; a: number; b: number }
  | { kind: 'point'; p: V3; onSurface: boolean };

const SEL = '#f2b24c', CLOSE = '#34d399', NEW = '#7fc8f8';

/** The Face tool's settings, shown in the side panel while it's in use. */
export interface FaceOptions {
  /** Free: as many corners as you like. Tri and Quad make the face as soon as it has 3 or 4. */
  shape: 'free' | 'tri' | 'quad';
  /** After a face is made by clicking its first point or by Tri or Quad: finish, or carry on from its last edge. */
  after: 'finish' | 'strip';
  /** Faces show from both sides: the mesh's material is set double-sided. */
  doubleSided: boolean;
  /** New faces shade smooth with their neighbours. */
  smooth: boolean;
  /** New points land on the model under the mouse. */
  surfaces: boolean;
  /** Existing vertices and open edges snap. */
  snapVerts: boolean;
}

export class FaceTool {
  opts: FaceOptions = { shape: 'free', after: 'finish', doubleSided: false, smooth: false, surfaces: true, snapVerts: true };
  private chain: Pt[] = [];
  private hover: Hover | null = null;
  private hoverPane: Pane | null = null;
  private mouse = { x: 0, y: 0 };
  /** In perspective, draw on the ground instead of a plane facing the view. N switches. */
  ground = false;
  /** The face made last, for Flip when nothing is selected. */
  private lastMade = -1;

  constructor(private host: FaceToolHost) {}

  get active() { return this.chain.length > 0; }
  get count() { return this.chain.length; }

  private pos(pt: Pt): V3 { return 'v' in pt ? ed.model.verts[pt.v].p : pt.p; }

  reset() { this.chain = []; this.hover = null; this.host.invalidate(); }

  // ---------- where a click lands ----------
  /** Where a new point under the mouse goes: on a surface, or on the drawing plane. */
  private placeAt(p: Pane, x: number, y: number, ignoreSurface: boolean): { p: V3; onSurface: boolean } | null {
    if (!ignoreSurface && this.opts.surfaces) {
      const hit = pick.pickFace(p, this.host.scene(), x, y, false);
      if (hit) {
        const w = hit.point.clone();
        if (ed.snap) this.host.snap(w);
        return { p: [w.x, w.y, w.z], onSurface: true };
      }
    }
    const last = this.chain.length ? this.pos(this.chain[this.chain.length - 1]) : null;
    const through = last ? new THREE.Vector3(...last) : new THREE.Vector3();
    let w: THREE.Vector3 | null;
    if (p.isOrtho || this.ground || !last) {
      // Front, side and top views draw on their own plane; perspective on the ground, at the last point's height.
      w = p.planePoint(x, y, through);
    } else {
      // In perspective, on a plane through the last point facing the view, so the chain can climb and turn.
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(p.viewDir(through), through);
      w = p.ray(x, y).intersectPlane(plane, new THREE.Vector3());
    }
    if (!w) return null;
    if (ed.snap) this.host.snap(w);
    return { p: [w.x, w.y, w.z], onSurface: false };
  }

  private boundaryEdge(k: string): boolean { return (edgeFaces(ed.model).get(k) ?? []).length === 1; }

  private updateHover(p: Pane, x: number, y: number, e: { altKey: boolean }) {
    this.hoverPane = p;
    this.mouse = { x, y };
    // Alt draws freely: no snapping to points or edges, and no landing on surfaces.
    const v = e.altKey || !this.opts.snapVerts ? null : pick.pickVertex(p, this.host.scene(), x, y, 14);
    const first = this.chain[0];
    if (v !== null && this.chain.length >= 3 && first && 'v' in first && first.v === v) { this.hover = { kind: 'close' }; return; }
    if (v !== null) { this.hover = { kind: 'vertex', v }; return; }
    // Near the first point when it's new: close on it too.
    if (this.chain.length >= 3) {
      const f = p.project(...this.pos(this.chain[0]));
      if (Math.hypot(f.x - x, f.y - y) < 12) { this.hover = { kind: 'close' }; return; }
    }
    if (!this.chain.length && !e.altKey && this.opts.snapVerts) {
      const k = pick.pickEdge(p, this.host.scene(), x, y, 8);
      if (k && this.boundaryEdge(k)) { const [a, b] = parseEdge(k); this.hover = { kind: 'edge', a, b }; return; }
    }
    const at = this.placeAt(p, x, y, e.altKey);
    this.hover = at ? { kind: 'point', ...at } : null;
  }

  move(p: Pane, x: number, y: number, e: { altKey: boolean }) {
    this.updateHover(p, x, y, e);
    this.host.invalidate();
  }

  down(p: Pane, x: number, y: number, e: { altKey: boolean; shiftKey?: boolean }) {
    // Shift+click selects what's under the mouse instead of adding a point, for moving, extruding and the rest.
    if (e.shiftKey) { this.selectUnder(p, x, y); return; }
    this.updateHover(p, x, y, e);
    const h = this.hover;
    if (!h) return;
    if (h.kind === 'close') { this.fill(this.opts.after === 'finish'); return; }
    if (h.kind === 'edge') {
      // Start from an open edge, ordered so the new face runs against its neighbour, as faces that share an edge do.
      const m = ed.model;
      const f = m.faces.find((x2) => x2.v.includes(h.a) && x2.v.includes(h.b))!;
      const i = f.v.indexOf(h.a);
      const aToB = f.v[(i + 1) % f.v.length] === h.b;
      this.chain = aToB ? [{ v: h.b }, { v: h.a }] : [{ v: h.a }, { v: h.b }];
      this.hint();
      this.host.invalidate();
      return;
    }
    if (h.kind === 'vertex') {
      const last = this.chain[this.chain.length - 1];
      if (last && 'v' in last && last.v === h.v) return;
      if (this.chain.some((q) => 'v' in q && q.v === h.v)) return;
      this.chain.push({ v: h.v });
    } else {
      const last = this.chain[this.chain.length - 1];
      if (last) { const s = p.project(...this.pos(last)); if (Math.hypot(s.x - x, s.y - y) < 5) return; }
      this.chain.push({ p: h.p });
    }
    // Tri and Quad make the face as soon as it has enough corners.
    const want = this.opts.shape === 'tri' ? 3 : this.opts.shape === 'quad' ? 4 : 0;
    if (want && this.chain.length >= want) { this.fill(this.opts.after === 'finish'); this.updateHover(p, x, y, e); this.host.invalidate(); return; }
    this.hint();
    this.updateHover(p, x, y, e);
    this.host.invalidate();
  }

  /** Toggle what's under the mouse in the selection, in the current selection mode. */
  private selectUnder(p: Pane, x: number, y: number) {
    const sg = this.host.scene();
    if (ed.mode === 'vertex') {
      const v = pick.pickVertex(p, sg, x, y, 14);
      if (v === null) return;
      if (ed.selVerts.has(v)) ed.selVerts.delete(v); else ed.selVerts.add(v);
    } else if (ed.mode === 'edge') {
      const k = pick.pickEdge(p, sg, x, y, 8);
      if (!k) return;
      if (ed.selEdges.has(k)) ed.selEdges.delete(k); else ed.selEdges.add(k);
    } else {
      const hit = pick.pickFace(p, sg, x, y, false);
      if (!hit) return;
      const g = ed.model.faces[hit.face].g;
      const faces = ed.mode === 'group' ? ed.model.faces.map((f, i) => (f.g === g ? i : -1)).filter((i) => i >= 0) : [hit.face];
      const on = ed.selFaces.has(hit.face);
      faces.forEach((fi) => { if (on) ed.selFaces.delete(fi); else ed.selFaces.add(fi); });
    }
    ed.emit('selection');
  }

  /** Select a face just made, in the current selection mode, so the usual keys act on it. */
  private selectFace(fi: number) {
    const f = ed.model.faces[fi];
    if (!f) return;
    ed.clearSelection();
    if (ed.mode === 'vertex') f.v.forEach((v) => ed.selVerts.add(v));
    else if (ed.mode === 'edge') f.v.forEach((a, i) => ed.selEdges.add(a < f.v[(i + 1) % f.v.length] ? `${a}_${f.v[(i + 1) % f.v.length]}` : `${f.v[(i + 1) % f.v.length]}_${a}`));
    else if (ed.mode === 'bone') return;
    else ed.selFaces.add(fi);
    ed.emit('selection');
  }

  /** Flip the selected faces, or else the last one made, so they face the other way. */
  flipFaces() {
    const m = ed.model;
    let faces = [...ed.selectedFaceSet()];
    if (!faces.length && this.lastMade >= 0 && this.lastMade < m.faces.length) faces = [this.lastMade];
    if (!faces.length) { status('Select faces to flip, or make one first.'); return; }
    ed.transact('Flip faces', (d) => {
      for (const fi of faces) {
        const f = d.faces[fi];
        if (!f) continue;
        f.v.reverse(); f.uv.reverse();
        if (f.seam) f.seam = [...f.seam.slice(0, -1).reverse(), f.seam[f.seam.length - 1]];
        if (f.pin) f.pin.reverse();
      }
    });
    status(`Flipped ${faces.length} face${faces.length === 1 ? '' : 's'}.`);
  }

  /** Take back the last point. */
  undoLast() {
    this.chain.pop();
    this.hint();
    this.host.invalidate();
  }

  /** Keys while building. True if used. */
  key(e: KeyboardEvent): boolean {
    if (e.ctrlKey || e.metaKey || e.altKey) return false;
    const k = e.key.toLowerCase();
    if (k === 'backspace' && this.active) { this.undoLast(); return true; }
    if ((k === 'enter' || k === ' ' || k === 'f') && this.active) { this.fill(true); return true; }
    if (k === 'escape' && this.active) { this.reset(); status('Face: chain ended.'); return true; }
    // G over a vertex grabs that vertex for the move that follows, whatever else is selected.
    if (k === 'g' && (this.hover?.kind === 'vertex' || (this.hover?.kind === 'close' && this.chain[0] && 'v' in this.chain[0]))) {
      const v = this.hover.kind === 'vertex' ? this.hover.v : (this.chain[0] as { v: number }).v;
      if (ed.mode !== 'vertex') ed.setMode('vertex');
      ed.selVerts = new Set([v]);
      ed.emit('selection');
      return false;
    }
    if (k === 'tab' && this.chain.length === 2) { this.chain.reverse(); this.hint(); this.host.invalidate(); return true; }
    if (k === 'n') {
      this.ground = !this.ground;
      status(this.ground ? 'Face: drawing on the ground in perspective.' : 'Face: drawing on a plane facing the view in perspective.');
      if (this.hoverPane) this.updateHover(this.hoverPane, this.mouse.x, this.mouse.y, { altKey: false });
      this.host.invalidate();
      return true;
    }
    return false;
  }

  private hint() {
    const n = this.chain.length;
    status(n === 0
      ? 'Face: click to place points (they land on the model under the mouse), click an existing vertex to use it, or click an open edge to build from it. N: ground or view plane. Alt: ignore surfaces.'
      : n < 3
        ? `Face: ${n} point${n === 1 ? '' : 's'}. Keep clicking. Backspace or right click takes one back, Esc ends.`
        : `Face: ${n} points. Enter or a double-click makes the face and finishes; clicking the first point makes it and carries on beside it. Esc stops.`);
  }

  /**
   * Make the face from the chain, as one undo step, facing like the faces it joins (or the viewer). It joins the
   * mesh of any existing vertex it uses, or else starts a new mesh. With `end`, the drawing finishes; otherwise it
   * carries on from the face's last edge, as a strip.
   */
  fill(end = true) {
    if (this.chain.length < 3) {
      if (end) { this.reset(); status('Face: finished.'); } else status('Face: needs 3 points or more.');
      return;
    }
    const chain = this.chain.slice();
    let made: number[] = [];
    let faceIndex = -1;
    const view = this.hoverPane;
    ed.transact('Add face', (m) => {
      const ids = chain.map((pt) => {
        if ('v' in pt) return pt.v;
        m.verts.push({ p: [pt.p[0], pt.p[1], pt.p[2]] });
        return m.verts.length - 1;
      });
      // The mesh it joins: the group of a face already using one of its points, or a new mesh.
      const used = new Set(chain.flatMap((pt) => ('v' in pt ? [pt.v] : [])));
      const joined = m.faces.find((f) => f.v.some((v) => used.has(v)));
      const g = joined ? joined.g : this.host.newGroup();
      ed.activeGroup = g;
      let order = ids;
      if (shouldReverse(m, ids, view)) order = ids.slice().reverse();
      const smooth = this.opts.smooth ? (neighbourSmooth(m, order) || nextSmooth(m)) : 0;
      const f: Face = { v: order, uv: planarUV(m, order), g, s: smooth };
      m.faces.push(f);
      faceIndex = m.faces.length - 1;
      made = ids;
      // Mirror X: the same face on the other side, sharing the points on the centre line.
      if (ed.mirrorX) {
        const at = (q: V3) => m.verts.findIndex((x2) => Math.abs(x2.p[0] - q[0]) < 1e-5 && Math.abs(x2.p[1] - q[1]) < 1e-5 && Math.abs(x2.p[2] - q[2]) < 1e-5);
        const twin = order.map((v) => {
          const q = m.verts[v].p;
          if (Math.abs(q[0]) < 1e-5) return v;
          const mq: V3 = [-q[0], q[1], q[2]];
          const found = at(mq);
          if (found >= 0) return found;
          m.verts.push({ p: mq });
          return m.verts.length - 1;
        }).reverse();
        const key = (vs: number[]) => [...vs].sort((a, b) => a - b).join(',');
        if (key(twin) !== key(order) && !m.faces.some((x2) => key(x2.v) === key(twin))) {
          m.faces.push({ v: twin, uv: planarUV(m, twin), g, s: smooth });
        }
      }
      // Double sided: the mesh's material shows both sides; a mesh without one gets one.
      if (this.opts.doubleSided) {
        const grp = m.groups.find((x2) => x2.id === g)!;
        let mat = grp.material !== null ? m.materials.find((x2) => x2.id === grp.material) : undefined;
        if (!mat) { mat = makeMaterial(m, uniqueName(m.materials.map((x2) => x2.name), 'Double sided')); grp.material = mat.id; }
        mat.doubleSided = true;
      }
    });
    // The new face is selected, so G, R, S, T and the rest act on it straight away.
    this.lastMade = faceIndex;
    this.selectFace(faceIndex);
    const n = made.length;
    if (end) {
      this.chain = [];
      status('Face made. Click in empty space for a new mesh, or on a vertex or open edge to carry on from it.');
    } else {
      // Carry on from the last edge drawn, the way a strip grows.
      this.chain = n >= 2 ? [{ v: made[n - 1] }, { v: made[n - 2] }] : [];
      status('Face made. Click two more points to add the next one beside it; Enter or a double-click finishes.');
    }
    this.host.invalidate();
  }

  // ---------- drawing ----------
  draw(g: CanvasRenderingContext2D, p: Pane) {
    if (ed.tool !== 'face') return;
    const pts = this.chain.map((q) => p.project(...this.pos(q)));
    const h = this.hover && this.hoverPane === p ? this.hover : null;
    const tip = h?.kind === 'point' ? p.project(...h.p) : h?.kind === 'vertex' ? p.project(...ed.model.verts[h.v].p) : null;
    // The face so far, filled, with the line to where the next point would go.
    if (pts.length) {
      const poly = tip ? [...pts, tip] : pts;
      if (poly.length >= 3) {
        g.fillStyle = 'rgba(242,178,76,0.14)';
        g.beginPath(); poly.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y))); g.closePath(); g.fill();
      }
      g.strokeStyle = SEL; g.lineWidth = 1.5;
      g.beginPath(); pts.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y))); g.stroke();
      if (tip) {
        g.setLineDash([4, 3]);
        g.beginPath(); g.moveTo(pts[pts.length - 1].x, pts[pts.length - 1].y); g.lineTo(tip.x, tip.y);
        if (pts.length >= 2) g.lineTo(pts[0].x, pts[0].y);
        g.stroke(); g.setLineDash([]);
      }
      pts.forEach((s, i) => {
        g.fillStyle = i === 0 && h?.kind === 'close' ? CLOSE : SEL;
        g.beginPath(); g.arc(s.x, s.y, i === 0 ? 5 : 4, 0, Math.PI * 2); g.fill();
      });
    }
    if (!h) return;
    if (h.kind === 'edge') {
      const a = p.project(...ed.model.verts[h.a].p), b = p.project(...ed.model.verts[h.b].p);
      g.strokeStyle = NEW; g.lineWidth = 3;
      g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
    } else if (h.kind === 'vertex' && tip) {
      g.strokeStyle = SEL; g.lineWidth = 2;
      g.beginPath(); g.arc(tip.x, tip.y, 7, 0, Math.PI * 2); g.stroke();
    } else if (h.kind === 'point' && tip) {
      g.fillStyle = h.onSurface ? NEW : '#ffffff';
      g.beginPath(); g.arc(tip.x, tip.y, 3.5, 0, Math.PI * 2); g.fill();
    } else if (h.kind === 'close' && pts.length) {
      g.strokeStyle = CLOSE; g.lineWidth = 2;
      g.beginPath(); g.arc(pts[0].x, pts[0].y, 8, 0, Math.PI * 2); g.stroke();
    }
  }
}

/** Whether a new face should run the other way: to agree with the faces it shares edges with, or else to face the view. */
function shouldReverse(m: Model, ids: number[], view: Pane | null): boolean {
  const dir = new Set<string>();
  for (const f of m.faces) f.v.forEach((a, i) => dir.add(`${a}>${f.v[(i + 1) % f.v.length]}`));
  let agree = 0, clash = 0;
  ids.forEach((a, i) => {
    const b = ids[(i + 1) % ids.length];
    if (dir.has(`${b}>${a}`)) agree++;
    if (dir.has(`${a}>${b}`)) clash++;
  });
  if (agree || clash) return clash > agree;
  if (!view) return false;
  const n = newell(m, ids);
  const c = ids.reduce((s, v) => [s[0] + m.verts[v].p[0] / ids.length, s[1] + m.verts[v].p[1] / ids.length, s[2] + m.verts[v].p[2] / ids.length], [0, 0, 0]);
  const toViewer = view.viewDir(new THREE.Vector3(c[0], c[1], c[2]));
  return n[0] * toViewer.x + n[1] * toViewer.y + n[2] * toViewer.z < 0;
}

function newell(m: Model, vs: number[]): V3 {
  let x = 0, y = 0, z = 0;
  vs.forEach((i, k) => {
    const a = m.verts[i].p, b = m.verts[vs[(k + 1) % vs.length]].p;
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  });
  return [x, y, z];
}

function planarUV(m: Model, vs: number[]): V2[] {
  const n = newell(m, vs);
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  const nn: V3 = [n[0] / l, n[1] / l, n[2] / l];
  const ref: V3 = Math.abs(nn[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u: V3 = [ref[1] * nn[2] - ref[2] * nn[1], ref[2] * nn[0] - ref[0] * nn[2], ref[0] * nn[1] - ref[1] * nn[0]];
  const ul = Math.hypot(u[0], u[1], u[2]) || 1;
  const uu: V3 = [u[0] / ul, u[1] / ul, u[2] / ul];
  const vv: V3 = [nn[1] * uu[2] - nn[2] * uu[1], nn[2] * uu[0] - nn[0] * uu[2], nn[0] * uu[1] - nn[1] * uu[0]];
  return vs.map((i) => { const p = m.verts[i].p; return [p[0] * uu[0] + p[1] * uu[1] + p[2] * uu[2], p[0] * vv[0] + p[1] * vv[1] + p[2] * vv[2]]; });
}

/** Shade with a face it joins, if any. */
function neighbourSmooth(m: Model, vs: number[]): number {
  const set = new Set(vs);
  return m.faces.find((f) => f.v.filter((v) => set.has(v)).length >= 2)?.s ?? 0;
}
