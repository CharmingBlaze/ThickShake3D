// The Bend tool: a Bézier curve along the selection, with two ends and two handles to drag. The selected vertices,
// edges or faces follow the curve, for organic shapes. With several separate pieces selected, they bend together
// along one curve, or each along its own copy of it (Each piece). Clicking away from the handles selects as usual.
import * as THREE from 'three';
import { applyBend, bendSetup, curvePoints, isStraight, straightShape, toLocal, toWorld, type BendAxis, type BendSetup, type BendShape } from '../core/bend';
import type { V3 } from '../core/types';
import { ed } from '../core/editor';
import { status } from '../ui/feedback';
import type { Pane } from './pane';

const CURVE = '#4cc3f2';
const HANDLE = '#9fe0fa';
const HOT = '#ffffff';

/** Ready-made curves, in a piece's own terms: along, then sideways. */
export const BEND_PRESETS: Record<string, { label: string; title: string; pts: BendShape['pts'] }> = {
  arc: { label: 'Arc', title: 'A smooth curve to one side, as a horn or a tail', pts: [[0, 0, 0], [0.4, 0, 0], [0.8, 0.1, 0], [0.92, 0.42, 0]] },
  s: { label: 'S-curve', title: 'Curves one way then the other, as a neck or a snake', pts: [[0, 0, 0], [0.33, 0.28, 0], [0.67, -0.28, 0], [1, 0, 0]] },
  hook: { label: 'Hook', title: 'Straight, then turning sharply over at the end, as a claw or a beak', pts: [[0, 0, 0], [0.7, 0, 0], [1, 0.12, 0], [0.82, 0.4, 0]] },
  wave: { label: 'Bow', title: 'Bows out evenly in the middle, both ends staying in line', pts: [[0, 0, 0], [0.25, 0.35, 0], [0.75, 0.35, 0], [1, 0, 0]] },
};

export class BendTool {
  opts = { axis: 'auto' as BendAxis, each: false, carryHandles: true };
  shape: BendShape = straightShape();
  private setup: BendSetup | null = null;
  private stale = true;
  private writing = false;
  private drag: { idx: number; piece: number; pane: Pane; anchor: THREE.Vector3; grab: THREE.Vector3; start: BendShape; alt: boolean } | null = null;
  private hover: { idx: number; piece: number } | null = null;

  constructor(private host: { invalidate(): void }) {
    // A new selection, or any other edit (undo included), starts a fresh, straight curve from the shape as it is.
    ed.on('selection', () => { if (!this.writing && !this.drag) this.restart(); });
    ed.on('history', () => { if (!this.writing) this.restart(); });
  }

  get dragging() { return this.drag !== null; }
  get pieces() { this.ensure(); return this.setup?.pieces.length ?? 0; }

  restart() {
    this.stale = true;
    this.shape = straightShape();
    this.hover = null;
    this.host.invalidate();
  }

  private ensure() {
    if (!this.stale) return;
    this.stale = false;
    const verts = ed.selectedVertexSet();
    this.setup = verts.size > 1 ? bendSetup(ed.model, verts, { axis: this.opts.axis, each: this.opts.each }) : null;
    if (this.setup && !this.setup.pieces.length) this.setup = null;
  }

  hint() {
    this.ensure();
    status(this.setup
      ? 'Bend: drag the curve\'s ends and handles to bend the selection. Alt drags an end without its handle; right click or Esc while dragging puts it back. Click elsewhere to select.'
      : 'Bend: select vertices, edges or faces (several pieces are fine), then drag the curve that appears along them.');
  }

  /** Change the options; the next bend starts straight from the shape as it is now. */
  setOpts(change: Partial<BendTool['opts']>) {
    Object.assign(this.opts, change);
    this.restart();
  }

  /** Change the curve from the panel, as one undo step. */
  setShape(change: Partial<BendShape>, label = 'Bend') {
    this.ensure();
    if (!this.setup) { status('Select vertices, edges or faces to bend first.'); return; }
    const next: BendShape = { ...this.shape, ...change, pts: (change.pts ?? this.shape.pts).map((p) => [...p]) as BendShape['pts'] };
    this.writing = true;
    try {
      ed.transact(label, (m) => { applyBend(m, this.setup!, next); });
      this.shape = next;
      ed.emit('geometry');
    } finally { this.writing = false; }
    this.host.invalidate();
  }

  straighten() { this.setShape(straightShape(), 'Straighten bend'); }

  /** A ready-made curve, bending toward the view's right (or up, when the curve runs across the view), so it shows. */
  applyPreset(pts: BendShape['pts'], label: string, view: { right: THREE.Vector3; up: THREE.Vector3 }) {
    this.ensure();
    if (!this.setup) { status('Select vertices, edges or faces to bend first.'); return; }
    const a = this.setup.axis, u = (a + 1) % 3, w = (a + 2) % 3;
    // The sideways direction to bend in: the view's right, unless the curve itself runs left to right.
    const side = Math.abs(view.right.getComponent(a)) > 0.7 ? view.up : view.right;
    let du = side.getComponent(u), dw = side.getComponent(w);
    const l = Math.hypot(du, dw);
    if (l < 1e-6) { du = 1; dw = 0; } else { du /= l; dw /= l; }
    // Turn each point's sideways part [U, 0] to point that way.
    const turned = pts.map((p) => [p[0], p[1] * du - p[2] * dw, p[1] * dw + p[2] * du]) as BendShape['pts'];
    this.setShape({ pts: turned }, label);
  }

  get straight() { return isStraight(this.shape); }

  // ---------- input ----------
  private hit(p: Pane, x: number, y: number): { idx: number; piece: number } | null {
    this.ensure();
    if (!this.setup) return null;
    let best: { idx: number; piece: number } | null = null, bd = 10;
    this.setup.pieces.forEach((piece, pi) => {
      // Ends first: when a handle sits on its end, the end is what gets grabbed.
      for (const idx of [0, 3, 1, 2]) {
        const w = toWorld(this.setup!, piece, this.shape.pts[idx]);
        const s = p.project(w[0], w[1], w[2]);
        const d = Math.hypot(s.x - x, s.y - y) - (idx === 0 || idx === 3 ? 1 : 0);
        if (d < bd) { bd = d; best = { idx, piece: pi }; }
      }
    });
    return best;
  }

  /** A press: true if it took a curve point; otherwise the view selects as usual. */
  down(p: Pane, x: number, y: number, e: PointerEvent): boolean {
    const h = this.hit(p, x, y);
    if (!h || !this.setup) return false;
    const w = new THREE.Vector3(...toWorld(this.setup, this.setup.pieces[h.piece], this.shape.pts[h.idx]));
    const at = p.planePoint(x, y, w);
    this.drag = { ...h, pane: p, anchor: w, grab: w.clone().sub(at), start: { ...this.shape, pts: this.shape.pts.map((q) => [...q]) as BendShape['pts'] }, alt: e.altKey };
    ed.begin('Bend');
    return true;
  }

  /** The mouse moved: true if it was dragging a curve point. */
  move(p: Pane, x: number, y: number, e: PointerEvent): boolean {
    const d = this.drag;
    if (d && this.setup) {
      if (p !== d.pane) return true;
      const piece = this.setup.pieces[d.piece];
      const w = p.planePoint(x, y, d.anchor).add(d.grab);
      const local = toLocal(this.setup, piece, [w.x, w.y, w.z]);
      const pts = d.start.pts.map((q) => [...q]) as BendShape['pts'];
      pts[d.idx] = local;
      // An end takes its handle along, as a vector pen does, unless Alt is held (or the option is off).
      const carry = this.opts.carryHandles !== (d.alt || e.altKey);
      if (carry && (d.idx === 0 || d.idx === 3)) {
        const hIdx = d.idx === 0 ? 1 : 2;
        pts[hIdx] = d.start.pts[hIdx].map((v, k) => v + local[k] - d.start.pts[d.idx][k]) as V3;
      }
      this.shape = { ...this.shape, pts };
      this.writing = true;
      try { applyBend(ed.model, this.setup, this.shape); ed.emit('geometry'); } finally { this.writing = false; }
      this.host.invalidate();
      return true;
    }
    const h = this.hit(p, x, y);
    if (JSON.stringify(h) !== JSON.stringify(this.hover)) { this.hover = h; this.host.invalidate(); }
    return false;
  }

  up() {
    if (!this.drag) return;
    this.drag = null;
    this.writing = true;
    try { ed.commit(); } finally { this.writing = false; }
    this.host.invalidate();
  }

  /** Put the curve back where it was before this drag. */
  cancel() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.shape = d.start;
    this.writing = true;
    try { ed.cancel(); } finally { this.writing = false; }
    this.host.invalidate();
  }

  key(e: KeyboardEvent): boolean {
    if (this.drag && e.key === 'Escape') { this.cancel(); return true; }
    return false;
  }

  // ---------- drawing ----------
  draw(g: CanvasRenderingContext2D, p: Pane) {
    this.ensure();
    if (!this.setup) return;
    const setup = this.setup;
    setup.pieces.forEach((piece, pi) => {
      const pts = curvePoints(setup, piece, this.shape, 40).map((w) => p.project(w[0], w[1], w[2]));
      g.strokeStyle = CURVE; g.lineWidth = 2;
      g.beginPath();
      pts.forEach((s, i) => (i ? g.lineTo(s.x, s.y) : g.moveTo(s.x, s.y)));
      g.stroke();
      const cp = this.shape.pts.map((l) => { const w = toWorld(setup, piece, l); return p.project(w[0], w[1], w[2]); });
      // Handle arms, from each end to its handle.
      g.strokeStyle = HANDLE; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(cp[0].x, cp[0].y); g.lineTo(cp[1].x, cp[1].y); g.moveTo(cp[3].x, cp[3].y); g.lineTo(cp[2].x, cp[2].y); g.stroke();
      g.setLineDash([]);
      cp.forEach((s, idx) => {
        const hot = (this.hover?.piece === pi && this.hover.idx === idx) || (this.drag?.piece === pi && this.drag.idx === idx);
        const end = idx === 0 || idx === 3;
        const r = (end ? 5 : 4) + (hot ? 1.5 : 0);
        g.fillStyle = hot ? HOT : end ? CURVE : '#13262e';
        g.strokeStyle = hot ? CURVE : end ? '#0b1a20' : HANDLE;
        g.lineWidth = 1.5;
        g.beginPath();
        if (end) g.rect(s.x - r, s.y - r, r * 2, r * 2); else g.arc(s.x, s.y, r, 0, Math.PI * 2);
        g.fill(); g.stroke();
      });
    });
  }
}
