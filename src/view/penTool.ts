// The Pen Shape tool: draw a closed outline with bezier curves in a view, and it inflates into a rounded piece
// you can shape live. Three coloured rings, at the bottom, middle and top, have handles to pull: the front and
// back ones set the depth there, the side ones the width. Enter or a double-click finalizes.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { splitOutline } from '../core/limbs';
import { PEN_SECTIONS, penFrame, ROUND_PROFILE, type PenProfile } from '../core/organic';
import { bezierAt, insertAnchor, nearestOnOutline, sampleOutline, type PenAnchor } from '../core/pen';
import type { V2, V3 } from '../core/types';
import { status, toast } from '../ui/feedback';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

const LINE = '#f2b24c', POINT = '#ffe2b0', HANDLE = '#7fc8f8', HOT = '#ffffff';
/** Ring colours: bottom, middle, top. */
export const RING_COLORS = ['#ff6b8b', '#3fe07a', '#5ac8ff'] as const;
const RING_NAMES = ['Bottom', 'Middle', 'Top'] as const;
const HIT = 8;

/**
 * What a live piece is built from. The tool updates `outline` as it's reshaped. `label` names the undo step, and
 * `depth` is where the rings' depth starts.
 */
export interface PenBuild {
  outline: V2[]; origin: V3; right: V3; up: V3; label: string; depth: number;
  /** Each limb's own rings, root to tip. Depths are shares of the body's middle depth. */
  limbs: PenProfile[];
  /** Where each limb's tip was, so its rings stay with it when reshaping the outline reorders the limbs. */
  limbTips: V2[];
}

export interface PenHost {
  sg: SceneGraph;
  invalidate(): void;
  /** Build the piece as an adjustable operation. False if the outline is too small. */
  startPiece(build: PenBuild): boolean;
}

/** The operation's parameter keys for each ring's depth and width. */
export const depthKey = (k: number) => `depth${RING_NAMES[k]}`;
export const widthKey = (k: number) => `width${RING_NAMES[k]}`;

/** A point on the outline. Smooth points keep their two handles in line. */
interface PenPoint extends PenAnchor { smooth: boolean }

type Grab =
  | { kind: 'new'; index: number; x0: number; y0: number }
  | { kind: 'point'; index: number; from: V2; at0: V2; moved: boolean; closing: boolean }
  | { kind: 'handle'; index: number; side: 'i' | 'o'; broken: boolean }
  | { kind: 'ring'; part: number; ring: number; axis: 'width' | 'depth'; sign: 1 | -1; pane: Pane };

type Hover =
  | { kind: 'point' | 'handle' | 'curve'; index: number; side?: 'i' | 'o'; t?: number }
  /** `part` is -1 for the body, or which limb. */
  | { kind: 'ring'; part: number; ring: number; axis: 'width' | 'depth'; sign: 1 | -1 }
  | null;

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];
const copy = (p: PenPoint): PenPoint => ({ p: [...p.p] as V2, i: [...p.i] as V2, o: [...p.o] as V2, smooth: p.smooth });

export class PenTool {
  private pane: Pane | null = null;
  private origin = new THREE.Vector3();
  private axisR = new THREE.Vector3(1, 0, 0);
  private axisU = new THREE.Vector3(0, 1, 0);
  private points: PenPoint[] = [];
  private closed = false;
  private grab: Grab | null = null;
  private hover: Hover = null;
  private mouse: { x: number; y: number; pane: Pane } | null = null;
  /** Earlier states of the outline, for Ctrl+Z while drawing. */
  private history: { points: PenPoint[]; closed: boolean }[] = [];
  /** The piece being shaped, and the operation that builds it. */
  private build: PenBuild | null = null;
  private op: unknown = null;
  /** A hand-drawn outline from Draw Shape, shaped with the rings but not edited point by point. */
  private fixed: V2[] | null = null;
  /** The tool the shape belongs to: switching to any other tool lets it go. */
  owner: 'pen' | 'blob' = 'pen';

  constructor(private host: PenHost) {}

  get active() { return this.points.length > 0 || this.fixed !== null; }
  /** True while the piece exists and is still being shaped. Anything else that changes the model ends it. */
  private get live() { return this.op !== null && ed.lastOp === this.op; }

  reset() {
    this.pane = null;
    this.points = [];
    this.closed = false;
    this.grab = null;
    this.hover = null;
    this.history = [];
    this.build = null;
    this.op = null;
    this.fixed = null;
    this.owner = 'pen';
    this.host.invalidate();
  }

  /**
   * Shape a finished hand-drawn outline with the rings, for Draw Shape. Coordinates are in the drawing plane's
   * right and up axes. False if it's too small to inflate.
   */
  adopt(p: Pane, outline: V2[], origin: V3, right: V3, up: V3): boolean {
    this.reset();
    this.owner = 'blob';
    this.pane = p;
    this.origin.set(...origin);
    this.axisR.set(...right);
    this.axisU.set(...up);
    this.fixed = outline;
    this.closed = true;
    this.sync();
    if (!this.live) { this.reset(); return false; }
    this.hint();
    return true;
  }

  hint() {
    if (this.fixed) status('Draw Shape: pull the ring handles to shape it: sides for width, front and back for depth (use a side view). Enter or double-click finishes, Esc cancels, and drawing again starts the next shape.');
    else if (!this.points.length) status('Pen Shape: click for a corner, drag for a curve. Click the first point to close the outline.');
    else if (!this.closed) status('Pen Shape: click for a corner, drag for a curve. Click the first point, or press Enter, to close. Backspace removes a point, Esc starts over.');
    else status('Pen Shape: pull the ring handles to shape it: sides for width, front and back for depth (use a side view). Drag points to reshape the outline. Enter or double-click finishes, Esc cancels.');
  }

  /** If something else changed the model since, the piece is done: let it go and start fresh. */
  private checkStale() {
    if (this.op !== null && !this.live) this.reset();
  }

  // ---------- plane ----------
  private normal() { return new THREE.Vector3().crossVectors(this.axisR, this.axisU).normalize(); }

  private toPlane(p: Pane, x: number, y: number): V2 | null {
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.normal(), this.origin);
    const at = p.ray(x, y).intersectPlane(plane, new THREE.Vector3());
    if (!at) return null;
    at.sub(this.origin);
    return [at.dot(this.axisR), at.dot(this.axisU)];
  }

  private toWorld(q: V2): THREE.Vector3 {
    return this.origin.clone().addScaledVector(this.axisR, q[0]).addScaledVector(this.axisU, q[1]);
  }

  private toScreen(p: Pane, q: V2) {
    const w = this.toWorld(q);
    return p.project(w.x, w.y, w.z);
  }

  /** Snap a point in the plane to the grid when snapping is on, or Ctrl is held to flip it. */
  private snap(q: V2, e: { ctrlKey: boolean }): V2 {
    if (e.ctrlKey === ed.snap) return q;
    const s = ed.snapStep;
    // Snap in world space, so points land on the same grid the other tools use.
    const w = this.toWorld(q);
    w.set(Math.round(w.x / s) * s, Math.round(w.y / s) * s, Math.round(w.z / s) * s).sub(this.origin);
    return [w.dot(this.axisR), w.dot(this.axisU)];
  }

  private remember() {
    this.history.push({ points: this.points.map(copy), closed: this.closed });
    if (this.history.length > 200) this.history.shift();
  }

  // ---------- the live piece ----------
  /** Bring the piece in line with the outline: build it once closed, rebuild it as it changes, remove it if reopened. */
  private sync() {
    if (!this.closed || (!this.fixed && this.points.length < 3)) {
      if (this.live) ed.undo();
      this.build = null;
      this.op = null;
      return;
    }
    const outline = this.fixed ?? sampleOutline(this.points, true, 20);
    if (this.live && this.build) {
      this.build.outline = outline;
      this.matchLimbs();
      ed.rerunLastOp();
      return;
    }
    const build: PenBuild = {
      outline, origin: v3(this.origin), right: v3(this.axisR), up: v3(this.axisU),
      label: this.fixed ? 'Draw shape' : 'Pen shape', depth: this.fixed ? ed.blobDepth : 1, limbs: [], limbTips: [],
    };
    if (this.host.startPiece(build)) { this.build = build; this.op = ed.lastOp; }
  }

  private param(key: string): number {
    const p = (ed.lastOp?.params ?? []).find((x) => x.key === key);
    return typeof p?.value === 'number' ? p.value : 1;
  }

  /** A limb's own profile, made when it's first needed. Limbs can come and go as the outline is reshaped. */
  private limbProfile(i: number): PenProfile {
    const b = this.build!;
    if (!b.limbTips.length) b.limbTips = splitOutline(b.outline).tips.slice();
    while (b.limbs.length <= i) b.limbs.push(ROUND_PROFILE());
    return b.limbs[i];
  }

  /**
   * After the outline changes, give each limb the rings of the limb whose tip was nearest before. Limbs are
   * listed by size, so moving one point can reorder them; this keeps a fattened thumb's rings on the thumb.
   */
  private matchLimbs() {
    const b = this.build!;
    const tips = splitOutline(b.outline).tips;
    const was = b.limbTips, had = b.limbs;
    const used = new Set<number>();
    b.limbs = tips.map((tip) => {
      let best = -1, bestD = Infinity;
      was.forEach((w, j) => {
        if (used.has(j) || !had[j]) return;
        const d = Math.hypot(w[0] - tip[0], w[1] - tip[1]);
        if (d < bestD) { bestD = d; best = j; }
      });
      if (best < 0) return ROUND_PROFILE();
      used.add(best);
      return had[best];
    });
    b.limbTips = tips.slice();
  }

  /**
   * Every ring: the body's three, then three on each limb from root to tip. Each has its centre, width and depth
   * directions, current half-width and half-depth, and the drawn half-width the values are shares of.
   */
  private rings() {
    if (!this.live || !this.build) return [];
    const b = this.build;
    const parts = splitOutline(b.outline);
    const out: { part: number; k: number; c: V3; w: V3; d: V3; rw: number; rd: number; half: number }[] = [];
    const add = (part: number, outline: V2[], tip: V2 | undefined, width: (k: number) => number, depth: (k: number) => number) => {
      const fr = penFrame(outline, b.origin, b.right, b.up, tip);
      if (!fr) return;
      PEN_SECTIONS.forEach((t, k) => {
        const s = fr.section(fr.uOf(t));
        if (s) out.push({ part, k, c: s.c, w: fr.dirV, d: fr.normal, rw: s.half * width(k), rd: s.half * depth(k), half: s.half });
      });
    };
    add(-1, parts.body, undefined, (k) => this.param(widthKey(k)), (k) => this.param(depthKey(k)));
    const mid = this.param(depthKey(1));
    parts.limbs.forEach((limb, i) => {
      const lp = this.limbProfile(i);
      add(i, limb, parts.tips[i], (k) => lp.width[k], (k) => lp.depth[k] * mid);
    });
    return out;
  }

  /** Set a ring's width or depth, as a share of the drawn width there. */
  private setRing(part: number, k: number, axis: 'width' | 'depth', v: number) {
    if (part < 0) {
      const key = axis === 'width' ? widthKey(k) : depthKey(k);
      if (Math.abs(v - this.param(key)) > 1e-6) ed.adjustLastOp(key, v);
      return;
    }
    const lp = this.limbProfile(part);
    // A limb's depth is kept relative to the body's middle, so it still follows the body.
    if (axis === 'width') lp.width[k] = v;
    else lp.depth[k] = v / Math.max(0.05, this.param(depthKey(1)));
    ed.rerunLastOp();
  }

  /** A ring handle's screen position, and its direction on screen. Null when it points straight at the viewer. */
  private ringHandle(p: Pane, r: ReturnType<PenTool['rings']>[number], axis: 'width' | 'depth', sign: 1 | -1) {
    const dir = axis === 'width' ? r.w : r.d;
    const ext = (axis === 'width' ? r.rw : r.rd) * sign;
    const c = p.project(r.c[0], r.c[1], r.c[2]);
    const h = p.project(r.c[0] + dir[0] * ext, r.c[1] + dir[1] * ext, r.c[2] + dir[2] * ext);
    const len = Math.hypot(h.x - c.x, h.y - c.y);
    // Hidden only when it points almost straight at the viewer; thin fingertips still need theirs.
    if (len < 4) return null;
    return { c, h, len };
  }

  // ---------- hit testing ----------
  private hitTest(p: Pane, x: number, y: number): Hover {
    // Ring handles, in any view: the nearest, since a finger's handles can sit close to the body's.
    let best: Hover = null, bestD = HIT + 1;
    for (const r of this.rings()) {
      for (const axis of ['width', 'depth'] as const) for (const sign of [1, -1] as const) {
        const hd = this.ringHandle(p, r, axis, sign);
        const d = hd ? Math.hypot(hd.h.x - x, hd.h.y - y) : Infinity;
        if (d < bestD) { bestD = d; best = { kind: 'ring', part: r.part, ring: r.k, axis, sign }; }
      }
    }
    if (best) return best;
    if (p !== this.pane) return null;
    const near = (q: V2) => { const s = this.toScreen(p, q); return Math.hypot(s.x - x, s.y - y) < HIT; };
    for (let k = 0; k < this.points.length; k++) {
      const pt = this.points[k];
      for (const side of ['o', 'i'] as const) {
        const h = pt[side];
        if (Math.hypot(h[0], h[1]) < 1e-9) continue;
        if (near([pt.p[0] + h[0], pt.p[1] + h[1]])) return { kind: 'handle', index: k, side };
      }
    }
    for (let k = 0; k < this.points.length; k++) if (near(this.points[k].p)) return { kind: 'point', index: k };
    if (this.closed) {
      const q = this.toPlane(p, x, y);
      const best = q ? nearestOnOutline(this.points, q) : null;
      if (best) {
        const n = this.points.length;
        const a = this.points[best.index], b = this.points[(best.index + 1) % n];
        // Measure on screen, so how close counts as "on the line" doesn't depend on zoom.
        const s = this.toScreen(p, bezierAt(a, b, best.t));
        if (Math.hypot(s.x - x, s.y - y) < HIT && best.t > 0.02 && best.t < 0.98) return { kind: 'curve', index: best.index, t: best.t };
      }
    }
    return null;
  }

  // ---------- input ----------
  /** A left press. False if it wasn't for this tool: for Draw Shape, a press away from the handles starts a new stroke. */
  down(p: Pane, x: number, y: number, e: PointerEvent): boolean {
    this.checkStale();
    const h = this.hitTest(p, x, y);
    if (h?.kind === 'ring') {
      this.grab = { kind: 'ring', part: h.part, ring: h.ring, axis: h.axis, sign: h.sign, pane: p };
      this.host.invalidate();
      return true;
    }
    if (this.fixed) return false;
    this.downOnOutline(p, x, y, e, h);
    return true;
  }

  private downOnOutline(p: Pane, x: number, y: number, e: PointerEvent, h: Hover) {
    if (this.points.length && p !== this.pane) {
      if (!this.closed) toast('Finish this outline in the view it was started in, or press Esc to start over.', 'info');
      return;
    }
    if (!this.points.length) {
      // A fresh outline lies in the plane facing this view, through the centre or the surface under the cursor.
      const hit = ed.drawOnSurface ? pick.pickFace(p, this.host.sg, x, y, false) : null;
      this.pane = p;
      this.origin.copy(hit ? hit.point : p.viewPlanePoint(x, y));
      const axes = p.screenAxes();
      this.axisR.copy(axes.right);
      this.axisU.copy(axes.up);
      this.closed = false;
    }
    const q = this.toPlane(p, x, y);
    if (!q) return;
    if (h?.kind === 'handle') {
      this.remember();
      const broken = e.altKey;
      if (broken) this.points[h.index].smooth = false;
      this.grab = { kind: 'handle', index: h.index, side: h.side!, broken };
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
    if (g.kind === 'ring') { this.dragRing(g, p, x, y, e); return; }
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
      const moved = g.moved || Math.hypot(q[0] - g.from[0], q[1] - g.from[1]) > 1e-9;
      if (!moved) return;
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
    // The piece follows the outline as it's reshaped.
    if (this.closed) this.sync();
    this.host.invalidate();
  }

  /** Pull a ring handle: how far the mouse is from the ring's centre, along the handle, sets the width or depth there. */
  private dragRing(g: Extract<Grab, { kind: 'ring' }>, p: Pane, x: number, y: number, e: PointerEvent) {
    if (p !== g.pane || !this.live) return;
    const r = this.rings().find((q) => q.part === g.part && q.k === g.ring);
    if (!r) return;
    const dir = g.axis === 'width' ? r.w : r.d;
    const c = p.project(r.c[0], r.c[1], r.c[2]);
    const one = p.project(r.c[0] + dir[0] * r.half * g.sign, r.c[1] + dir[1] * r.half * g.sign, r.c[2] + dir[2] * r.half * g.sign);
    const ax = one.x - c.x, ay = one.y - c.y;
    const l2 = ax * ax + ay * ay;
    if (l2 < 4) return;
    let v = ((x - c.x) * ax + (y - c.y) * ay) / l2;
    v = e.ctrlKey ? Math.round(v * 20) / 20 : Math.round(v * 100) / 100;
    v = Math.max(0.05, Math.min(4, v));
    this.setRing(g.part, g.ring, g.axis, v);
    const where = g.part < 0 ? RING_NAMES[g.ring] : `Limb ${g.part + 1} ${['root', 'middle', 'tip'][g.ring]}`;
    status(`${where} ${g.axis}: ${v.toFixed(2)} of the drawn width. Ctrl steps by 0.05. Double-click a ring handle to reset it.`);
    this.host.invalidate();
  }

  up() {
    const g = this.grab;
    this.grab = null;
    // A click on the first point, without dragging it, closes the outline and builds the piece.
    if (g?.kind === 'point' && g.closing && !g.moved) { this.closed = true; this.sync(); this.hint(); }
    this.host.invalidate();
  }

  /** Double-click: a point toggles smooth or sharp, a ring handle resets to round; anywhere else finishes. */
  dblclick(p: Pane, x: number, y: number) {
    this.checkStale();
    const h = this.hitTest(p, x, y);
    if (h?.kind === 'ring') {
      // Back to round: for a limb, back to following the body.
      if (h.part < 0) this.setRing(-1, h.ring, h.axis, 1);
      else {
        const lp = this.limbProfile(h.part);
        if (h.axis === 'width') lp.width[h.ring] = 1; else lp.depth[h.ring] = 1;
        ed.rerunLastOp();
      }
      this.host.invalidate();
      return;
    }
    if (h?.kind === 'point' && (this.closed || h.index !== 0)) {
      this.toggleSmooth(h.index);
      if (this.closed) this.sync();
      return;
    }
    this.finish();
  }

  private toggleSmooth(k: number) {
    const n = this.points.length;
    const pt = this.points[k];
    if (pt.smooth || Math.hypot(...pt.o) > 1e-9 || Math.hypot(...pt.i) > 1e-9) {
      pt.i = [0, 0]; pt.o = [0, 0]; pt.smooth = false;
    } else {
      // Handles along the line through its neighbours, a third of the way to each.
      const prev = this.points[(k - 1 + n) % n].p, next = this.points[(k + 1) % n].p;
      const has = (this.closed || k > 0) && (this.closed || k < n - 1);
      const dir: V2 = has ? [next[0] - prev[0], next[1] - prev[1]] : [1, 0];
      const l = Math.hypot(dir[0], dir[1]) || 1;
      const a = Math.hypot(pt.p[0] - prev[0], pt.p[1] - prev[1]) / 3, b = Math.hypot(next[0] - pt.p[0], next[1] - pt.p[1]) / 3;
      pt.i = [(-dir[0] / l) * a, (-dir[1] / l) * a];
      pt.o = [(dir[0] / l) * b, (dir[1] / l) * b];
      pt.smooth = true;
    }
    this.host.invalidate();
  }

  /** Keys while drawing. True if one was used. */
  key(e: KeyboardEvent): boolean {
    this.checkStale();
    if (!this.active) return false;
    const k = e.key;
    if (this.fixed) {
      // A hand-drawn outline has no points to edit: Ctrl+Z takes the piece back, and Backspace does nothing.
      if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { if (this.live) ed.undo(); this.reset(); this.hint(); return true; }
      if (k === 'Backspace' || k === 'Delete') return true;
    }
    if (k === 'Escape') {
      // Esc throws away the piece too.
      if (this.live) ed.undo();
      this.reset(); this.hint();
      return true;
    }
    if (k === 'Enter' || k === ' ') { this.finish(); return true; }
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') {
      const last = this.history.pop();
      if (last) { this.points = last.points; this.closed = last.closed; this.sync(); } else { if (this.live) ed.undo(); this.reset(); }
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

  /**
   * Enter, Space, a double-click or a right click. On an open outline it closes it, building the piece to shape
   * with the rings; once it's being shaped, it finishes the piece.
   */
  finish() {
    this.checkStale();
    if (this.fixed) { this.reset(); this.hint(); return; }
    if (this.points.length < 3) { if (this.points.length) toast('Place at least three points to make a shape.', 'info'); return; }
    if (!this.closed) {
      this.remember();
      this.closed = true;
      this.sync();
      if (!this.live) toast('That outline is too small to inflate.', 'info');
      this.hint();
      this.host.invalidate();
      return;
    }
    if (!this.live) { toast('That outline is too small to inflate.', 'info'); return; }
    // The piece stays, and the panel keeps its settings adjustable.
    this.reset();
    this.hint();
  }

  /** A right click finishes, the same as Enter. */
  rightClick() { this.finish(); }

  // ---------- drawing ----------
  draw(g: CanvasRenderingContext2D, p: Pane) {
    if (!this.active) return;
    const home = p === this.pane;
    const scr = (q: V2) => this.toScreen(p, q);
    // The curve.
    const line = this.fixed ?? sampleOutline(this.points, this.closed, 24);
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.strokeStyle = LINE; g.lineWidth = home ? 2 : 1.5;
    g.beginPath();
    line.forEach((q, k) => { const s = scr(q); if (k) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
    if (this.closed) g.closePath();
    g.stroke();
    if (this.closed && !this.live) { g.fillStyle = 'rgba(242,178,76,0.10)'; g.fill(); }
    this.drawRings(g, p);
    if (!home || this.fixed) { g.lineCap = 'butt'; g.lineJoin = 'miter'; return; }
    // Where the next point goes, and the gap that closing would fill.
    if (!this.closed && this.mouse?.pane === p && !this.grab) {
      const last = scr(this.points[this.points.length - 1].p);
      g.setLineDash([5, 4]); g.lineWidth = 1;
      g.beginPath(); g.moveTo(last.x, last.y); g.lineTo(this.mouse.x, this.mouse.y);
      if (this.points.length >= 2) { const first = scr(this.points[0].p); g.lineTo(first.x, first.y); }
      g.stroke();
      g.setLineDash([]);
    }
    // Handles.
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
    // Points: squares for sharp corners, diamonds for smooth ones. The first is larger while it can close the shape.
    this.points.forEach((pt, k) => {
      const s = scr(pt.p);
      const hot = this.hover?.kind === 'point' && this.hover.index === k;
      const r = (hot ? 5.5 : 4) + (k === 0 && !this.closed && this.points.length >= 3 ? 1.5 : 0);
      g.fillStyle = hot ? HOT : POINT;
      g.strokeStyle = '#1a1c20'; g.lineWidth = 1;
      g.beginPath();
      if (pt.smooth) { g.moveTo(s.x, s.y - r); g.lineTo(s.x + r, s.y); g.lineTo(s.x, s.y + r); g.lineTo(s.x - r, s.y); g.closePath(); }
      else g.rect(s.x - r, s.y - r, r * 2, r * 2);
      g.fill(); g.stroke();
    });
    // Where a click on the outline would add a point.
    if (this.hover?.kind === 'curve' && !this.grab) {
      const n = this.points.length;
      const s = scr(bezierAt(this.points[this.hover.index], this.points[(this.hover.index + 1) % n], this.hover.t!));
      g.strokeStyle = HOT; g.lineWidth = 1.5;
      g.beginPath(); g.arc(s.x, s.y, 4, 0, Math.PI * 2); g.stroke();
    }
    g.lineCap = 'butt'; g.lineJoin = 'miter';
  }

  /** The three rings around the piece, each with width handles (round) and depth handles (square). */
  private drawRings(g: CanvasRenderingContext2D, p: Pane) {
    for (const r of this.rings()) {
      const col = RING_COLORS[r.k];
      const limb = r.part >= 0;
      g.strokeStyle = col; g.lineWidth = limb ? 1.5 : 2;
      g.beginPath();
      for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * Math.PI * 2;
        const cw = Math.cos(a) * r.rw, sd = Math.sin(a) * r.rd;
        const s = p.project(r.c[0] + r.w[0] * cw + r.d[0] * sd, r.c[1] + r.w[1] * cw + r.d[1] * sd, r.c[2] + r.w[2] * cw + r.d[2] * sd);
        if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y);
      }
      g.stroke();
      for (const axis of ['width', 'depth'] as const) for (const sign of [1, -1] as const) {
        const hd = this.ringHandle(p, r, axis, sign);
        if (!hd) continue;
        const hot = (this.hover?.kind === 'ring' && this.hover.part === r.part && this.hover.ring === r.k && this.hover.axis === axis && this.hover.sign === sign)
          || (this.grab?.kind === 'ring' && this.grab.part === r.part && this.grab.ring === r.k && this.grab.axis === axis && this.grab.sign === sign);
        // Limb handles are a little smaller, so a hand's many rings stay readable.
        const rad = (hot ? 6.5 : 5) - (limb ? 1 : 0);
        g.fillStyle = hot ? HOT : col; g.strokeStyle = '#1a1c20'; g.lineWidth = 1.5;
        g.beginPath();
        if (axis === 'width') g.arc(hd.h.x, hd.h.y, rad, 0, Math.PI * 2);
        else g.rect(hd.h.x - rad, hd.h.y - rad, rad * 2, rad * 2);
        g.fill(); g.stroke();
      }
    }
  }
}
