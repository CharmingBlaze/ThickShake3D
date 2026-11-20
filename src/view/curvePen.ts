// The Curve tool's pen input, the way a vector pen works: click for a corner, drag for a smooth point with handles,
// click the first point to close the path. The curve builds live from the second point and follows every change.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { LOOP_KINDS, type CurveParams, type P3 } from '../core/curves';
import { bezierAt, insertAnchor, nearestOnOutline, sampleOutline, type PenAnchor } from '../core/pen';
import type { V2 } from '../core/types';
import { status, toast } from '../ui/feedback';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

const LINE = '#3fe05a', POINT = '#c5f5cf', HANDLE = '#7fc8f8', HOT = '#ffffff';
const HIT = 8;

export interface CurvePenHost {
  sg: SceneGraph;
  invalidate(): void;
  /** Build the curve as an adjustable operation, reading the path from `get` each time it runs. False if it can't be built. */
  startCurve(get: () => { pts: P3[]; params: CurveParams }, up: P3): boolean;
  /** Rebuild the curve this pen started, if it's still the last edit. */
  rebuildCurve(): void;
  readonly curveLive: boolean;
}

interface PenPoint extends PenAnchor { smooth: boolean }
type Grab =
  | { kind: 'new'; index: number; x0: number; y0: number }
  | { kind: 'point'; index: number; from: V2; at0: V2; moved: boolean; closing: boolean }
  | { kind: 'handle'; index: number; side: 'i' | 'o'; broken: boolean };
type Hover = { kind: 'point' | 'handle' | 'curve'; index: number; side?: 'i' | 'o'; t?: number } | null;

const copy = (p: PenPoint): PenPoint => ({ p: [...p.p] as V2, i: [...p.i] as V2, o: [...p.o] as V2, smooth: p.smooth });
/** Points per curved span: Low poly keeps spans short. Straight spans are one segment whatever the level. */
const PER_SPAN = { low: 3, medium: 8, high: 16 } as const;

export class CurvePen {
  private pane: Pane | null = null;
  private origin = new THREE.Vector3();
  private axisR = new THREE.Vector3(1, 0, 0);
  private axisU = new THREE.Vector3(0, 1, 0);
  private points: PenPoint[] = [];
  private closed = false;
  private grab: Grab | null = null;
  private hover: Hover = null;
  private mouse: { x: number; y: number; pane: Pane } | null = null;
  private history: { points: PenPoint[]; closed: boolean }[] = [];
  /** True once this path has built its curve. */
  private built = false;

  constructor(private host: CurvePenHost) {}

  get active() { return this.points.length > 0; }

  reset() {
    this.pane = null;
    this.points = [];
    this.closed = false;
    this.grab = null;
    this.hover = null;
    this.history = [];
    this.built = false;
    this.host.invalidate();
  }

  hint() {
    if (!this.points.length) status('Curve pen: click for a corner, drag for a curve. Click the first point to close the path.');
    else status('Curve pen: keep clicking to add points, drag points or handles to reshape. Alt+click a point for sharp/smooth, Alt+drag a handle to break it, click the first point to close. Double-click or Enter finishes; Backspace removes a point, Esc cancels.');
  }

  /** Something else changed the model since: the curve is done, let the path go. */
  private checkStale() {
    if (this.built && !this.host.curveLive) this.reset();
  }

  // ---------- plane ----------
  private toPlane(p: Pane, x: number, y: number): V2 | null {
    const n = new THREE.Vector3().crossVectors(this.axisR, this.axisU).normalize();
    const at = p.ray(x, y).intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, this.origin), new THREE.Vector3());
    if (!at) return null;
    at.sub(this.origin);
    return [at.dot(this.axisR), at.dot(this.axisU)];
  }
  private toWorld(q: V2) { return this.origin.clone().addScaledVector(this.axisR, q[0]).addScaledVector(this.axisU, q[1]); }
  private toScreen(p: Pane, q: V2) { const w = this.toWorld(q); return p.project(w.x, w.y, w.z); }
  private snap(q: V2, e: { ctrlKey: boolean }): V2 {
    if (e.ctrlKey === ed.snap) return q;
    const s = ed.snapStep, w = this.toWorld(q);
    w.set(Math.round(w.x / s) * s, Math.round(w.y / s) * s, Math.round(w.z / s) * s).sub(this.origin);
    return [w.dot(this.axisR), w.dot(this.axisU)];
  }
  private remember() {
    this.history.push({ points: this.points.map(copy), closed: this.closed });
    if (this.history.length > 200) this.history.shift();
  }

  /** The path as world points, sampled at the curve's poly level. */
  private world(): P3[] {
    return sampleOutline(this.points, this.closed, PER_SPAN[ed.curve.resolution]).map((q) => { const w = this.toWorld(q); return [w.x, w.y, w.z]; });
  }

  /** Bring the curve in line with the path: build it once there's enough, rebuild as it changes, remove it if there's too little. */
  private sync() {
    // Outlines and blobs only make sense as closed loops, so they wait until the path is closed.
    const enough = this.points.length >= 2 && (this.closed || !LOOP_KINDS.includes(ed.curve.kind));
    if (!enough) {
      if (this.built && this.host.curveLive) ed.undo();
      this.built = false;
      return;
    }
    if (this.built && this.host.curveLive) { this.host.rebuildCurve(); return; }
    const up = this.axisU;
    this.built = this.host.startCurve(() => ({ pts: this.world(), params: { ...ed.curve, cyclic: this.closed, curveType: 'polyline' } }), [up.x, up.y, up.z]);
  }

  // ---------- hit testing ----------
  private hitTest(p: Pane, x: number, y: number): Hover {
    if (p !== this.pane) return null;
    const near = (q: V2) => { const s = this.toScreen(p, q); return Math.hypot(s.x - x, s.y - y) < HIT; };
    for (let k = 0; k < this.points.length; k++) {
      const pt = this.points[k];
      for (const side of ['o', 'i'] as const) {
        const h = pt[side];
        if (Math.hypot(h[0], h[1]) > 1e-9 && near([pt.p[0] + h[0], pt.p[1] + h[1]])) return { kind: 'handle', index: k, side };
      }
    }
    for (let k = 0; k < this.points.length; k++) if (near(this.points[k].p)) return { kind: 'point', index: k };
    if (this.points.length >= 2) {
      const q = this.toPlane(p, x, y);
      // An open path has no span from the last point back to the first.
      const best = q ? nearestOnOutline(this.points, q) : null;
      if (best && (this.closed || best.index < this.points.length - 1)) {
        const s = this.toScreen(p, bezierAt(this.points[best.index], this.points[(best.index + 1) % this.points.length], best.t));
        if (Math.hypot(s.x - x, s.y - y) < HIT && best.t > 0.02 && best.t < 0.98) return { kind: 'curve', index: best.index, t: best.t };
      }
    }
    return null;
  }

  // ---------- input ----------
  down(p: Pane, x: number, y: number, e: PointerEvent) {
    this.checkStale();
    if (this.points.length && p !== this.pane) { toast('Finish this path in the view it was started in, or press Enter to finish it.', 'info'); return; }
    if (!this.points.length) {
      const hit = ed.drawOnSurface ? pick.pickFace(p, this.host.sg, x, y, false) : null;
      this.pane = p;
      this.origin.copy(hit ? hit.point : p.viewPlanePoint(x, y));
      const axes = p.screenAxes();
      this.axisR.copy(axes.right);
      this.axisU.copy(axes.up);
    }
    const q = this.toPlane(p, x, y);
    if (!q) return;
    const h = this.hitTest(p, x, y);
    if (h?.kind === 'handle') {
      this.remember();
      if (e.altKey) this.points[h.index].smooth = false;
      this.grab = { kind: 'handle', index: h.index, side: h.side!, broken: e.altKey };
    } else if (h?.kind === 'point' && e.altKey) {
      // Alt+click converts a point between sharp and smooth, as a vector pen's convert tool does.
      this.remember();
      this.toggleSmooth(h.index);
      this.sync();
    } else if (h?.kind === 'point') {
      this.remember();
      const closing = !this.closed && h.index === 0 && this.points.length >= 3;
      this.grab = { kind: 'point', index: h.index, from: q, at0: [...this.points[h.index].p] as V2, moved: false, closing };
    } else if (h?.kind === 'curve') {
      this.remember();
      const pts = insertAnchor(this.points, h.index, h.t!);
      this.points = pts.map((a, k) => ({ ...a, smooth: k === h.index + 1 ? true : this.points[k > h.index ? k - 1 : k].smooth }));
      this.grab = { kind: 'point', index: h.index + 1, from: q, at0: [...this.points[h.index + 1].p] as V2, moved: false, closing: false };
      this.sync();
    } else if (!this.closed) {
      this.remember();
      this.points.push({ p: this.snap(q, e), i: [0, 0], o: [0, 0], smooth: false });
      this.grab = { kind: 'new', index: this.points.length - 1, x0: x, y0: y };
      this.sync();
    }
    this.mouse = { x, y, pane: p };
    this.hint();
    this.host.invalidate();
  }

  move(p: Pane, x: number, y: number, e: PointerEvent) {
    this.mouse = { x, y, pane: p };
    const g = this.grab;
    if (!g) {
      const h = this.hitTest(p, x, y);
      if (JSON.stringify(h) !== JSON.stringify(this.hover)) this.hover = h;
      this.host.invalidate();
      return;
    }
    if (p !== this.pane) return;
    const q = this.toPlane(p, x, y);
    if (!q) return;
    const pt = this.points[g.index];
    if (g.kind === 'new') {
      // Dragging away from a new point pulls out its handles, making it smooth.
      if (Math.hypot(x - g.x0, y - g.y0) < 4) return;
      const o: V2 = [q[0] - pt.p[0], q[1] - pt.p[1]];
      pt.o = o; pt.i = [-o[0], -o[1]]; pt.smooth = true;
    } else if (g.kind === 'point') {
      if (!g.moved && Math.hypot(q[0] - g.from[0], q[1] - g.from[1]) < 1e-9) return;
      g.moved = true;
      pt.p = this.snap([g.at0[0] + q[0] - g.from[0], g.at0[1] + q[1] - g.from[1]], e);
    } else {
      const h: V2 = [q[0] - pt.p[0], q[1] - pt.p[1]];
      pt[g.side] = h;
      if (pt.smooth && !g.broken && !e.altKey) {
        // A smooth point keeps its other handle opposite, at its own length.
        const other = g.side === 'i' ? 'o' : 'i';
        const len = Math.hypot(pt[other][0], pt[other][1]) || Math.hypot(h[0], h[1]);
        const l = Math.hypot(h[0], h[1]) || 1;
        pt[other] = [(-h[0] / l) * len, (-h[1] / l) * len];
      } else pt.smooth = false;
    }
    this.sync();
    this.host.invalidate();
  }

  up() {
    const g = this.grab;
    this.grab = null;
    // A click on the first point, without dragging it, closes the path.
    if (g?.kind === 'point' && g.closing && !g.moved) { this.closed = true; this.sync(); }
    this.host.invalidate();
  }

  /** Double-click finishes, wherever it lands. */
  dblclick() { this.finish(); }

  private toggleSmooth(k: number) {
    const n = this.points.length, pt = this.points[k];
    if (pt.smooth || Math.hypot(...pt.o) > 1e-9 || Math.hypot(...pt.i) > 1e-9) { pt.i = [0, 0]; pt.o = [0, 0]; pt.smooth = false; return; }
    // Handles along the line through its neighbours, a third of the way to each.
    const prev = this.points[this.closed || k > 0 ? (k - 1 + n) % n : k].p, next = this.points[this.closed || k < n - 1 ? (k + 1) % n : k].p;
    const dir: V2 = [next[0] - prev[0], next[1] - prev[1]];
    const l = Math.hypot(dir[0], dir[1]) || 1;
    const a = Math.hypot(pt.p[0] - prev[0], pt.p[1] - prev[1]) / 3 || l / 6, b = Math.hypot(next[0] - pt.p[0], next[1] - pt.p[1]) / 3 || l / 6;
    pt.i = [(-dir[0] / l) * a, (-dir[1] / l) * a];
    pt.o = [(dir[0] / l) * b, (dir[1] / l) * b];
    pt.smooth = true;
  }

  key(e: KeyboardEvent): boolean {
    this.checkStale();
    if (!this.active) return false;
    const k = e.key;
    if (k === 'Escape') { if (this.built && this.host.curveLive) ed.undo(); this.reset(); this.hint(); return true; }
    if (k === 'Enter') { this.finish(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
      const last = this.history.pop();
      if (last) { this.points = last.points; this.closed = last.closed; this.sync(); } else { if (this.built && this.host.curveLive) ed.undo(); this.reset(); }
      this.hint();
      this.host.invalidate();
      return true;
    }
    if (k === 'Backspace' || k === 'Delete') {
      this.remember();
      const at = this.hover?.kind === 'point' ? this.hover.index : this.points.length - 1;
      this.points.splice(at, 1);
      if (this.points.length < 3) this.closed = false;
      this.hover = null;
      this.sync();
      if (!this.points.length) this.reset();
      this.hint();
      this.host.invalidate();
      return true;
    }
    return false;
  }

  /** Enter or a double-click: the curve stays, its settings stay adjustable, and the next click starts a new path. */
  finish() {
    this.checkStale();
    if (!this.built) {
      if (this.points.length) toast(LOOP_KINDS.includes(ed.curve.kind) && !this.closed ? 'Close the path by clicking its first point.' : 'Place at least two points.', 'info');
      if (LOOP_KINDS.includes(ed.curve.kind) && !this.closed && this.points.length) return;
    }
    this.reset();
    this.hint();
  }


  // ---------- drawing ----------
  draw(g: CanvasRenderingContext2D, p: Pane) {
    if (!this.active) return;
    const home = p === this.pane;
    const scr = (q: V2) => this.toScreen(p, q);
    const line = sampleOutline(this.points, this.closed, 24);
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = LINE; g.lineWidth = home ? 2 : 1.5;
    g.beginPath();
    line.forEach((q, k) => { const s = scr(q); if (k) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
    if (this.closed) g.closePath();
    g.stroke();
    if (!home) { g.lineCap = 'butt'; g.lineJoin = 'miter'; return; }
    if (!this.closed && this.mouse?.pane === p && !this.grab) {
      const last = scr(this.points[this.points.length - 1].p);
      g.setLineDash([5, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(this.mouse.x, this.mouse.y); g.stroke();
      g.setLineDash([]);
    }
    g.lineWidth = 1;
    this.points.forEach((pt, k) => {
      const s = scr(pt.p);
      for (const side of ['i', 'o'] as const) {
        const h = pt[side];
        if (Math.hypot(h[0], h[1]) < 1e-9) continue;
        const e = scr([pt.p[0] + h[0], pt.p[1] + h[1]]);
        g.strokeStyle = HANDLE;
        g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(e.x, e.y); g.stroke();
        const hot = this.hover?.kind === 'handle' && this.hover.index === k && this.hover.side === side;
        g.fillStyle = hot ? HOT : HANDLE;
        g.beginPath(); g.arc(e.x, e.y, hot ? 5 : 4, 0, Math.PI * 2); g.fill();
      }
    });
    // Squares for corners, diamonds for smooth points. The first is larger while clicking it would close the path.
    this.points.forEach((pt, k) => {
      const s = scr(pt.p);
      const hot = this.hover?.kind === 'point' && this.hover.index === k;
      const r = (hot ? 5.5 : 4) + (k === 0 && !this.closed && this.points.length >= 3 ? 1.5 : 0);
      g.fillStyle = hot ? HOT : POINT; g.strokeStyle = '#1a1c20'; g.lineWidth = 1;
      g.beginPath();
      if (pt.smooth) { g.moveTo(s.x, s.y - r); g.lineTo(s.x + r, s.y); g.lineTo(s.x, s.y + r); g.lineTo(s.x - r, s.y); g.closePath(); }
      else g.rect(s.x - r, s.y - r, r * 2, r * 2);
      g.fill(); g.stroke();
    });
    if (this.hover?.kind === 'curve' && !this.grab) {
      const n = this.points.length;
      const s = scr(bezierAt(this.points[this.hover.index], this.points[(this.hover.index + 1) % n], this.hover.t!));
      g.strokeStyle = HOT; g.lineWidth = 1.5;
      g.beginPath(); g.arc(s.x, s.y, 4, 0, Math.PI * 2); g.stroke();
    }
    g.lineCap = 'butt'; g.lineJoin = 'miter';
  }
}
