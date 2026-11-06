// The Knife and Loop Cut tools, working the way Blender's do.
import * as THREE from 'three';
import { applyKnife, loopCuts, loopPreview, planKnife, type CutResult, type KnifeClick, type KnifeSegment, type KnifeView, type LoopOptions } from '../core/cuts';
import { ed } from '../core/editor';
import { parseEdge } from '../core/geom';
import { cloneModel, type Model, type V3 } from '../core/types';
import { status, toast } from '../ui/feedback';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

const CUT_LINE = '#3fe07a', CUT_POINT = '#c8ffd8', SNAP_VERT = '#ff5a5a', SNAP_EDGE = '#c77dff', SNAP_MID = '#5ac8ff', LOOP_LINE = '#ffd84a';

export interface CutHost {
  sg: SceneGraph;
  invalidate(): void;
  /** Go back to the tool in use before a K or Ctrl+R, if that's how this one started. */
  finishOneShot(): void;
}

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

/** Show new cuts as selected, ready to move. Face and group modes can't show a line, so they switch to edges. */
function selectCut(r: CutResult) {
  ed.clearSelection();
  if (ed.mode === 'vertex') r.verts.forEach((v) => ed.selVerts.add(v));
  else {
    if (ed.mode !== 'edge') ed.mode = 'edge';
    r.edges.forEach((k) => ed.selEdges.add(k));
  }
}

function editableFaces(m: Model): number[] {
  const hidden = new Set(m.groups.filter((g) => !g.visible || g.locked).map((g) => g.id));
  const out: number[] = [];
  m.faces.forEach((f, i) => { if (!hidden.has(f.g)) out.push(i); });
  return out;
}

// ---------- knife ----------
type SnapKind = 'vert' | 'edge' | 'mid' | 'face' | 'free';
interface Cursor { x: number; y: number; p: V3; kind: SnapKind }

export class KnifeTool {
  private chains: KnifeClick[][] = [[]];
  private cursor: Cursor | null = null;
  private pane: Pane | null = null;
  private nextId = 1;
  private held: { x: number; y: number } | null = null;
  private mods = { ctrl: false, shift: false };
  private through = false;
  private angleSnap = false;
  private axis: 0 | 1 | 2 | null = null;
  private measure = false;
  private planPoints: V3[] = [];
  private at: { x: number; y: number } | null = null;
  /** Shift+K: only cut what's selected. */
  selectedOnly = false;

  constructor(private host: CutHost) {}

  get active() { return this.chains.some((c) => c.length > 0); }
  private get last(): KnifeClick | null {
    const c = this.chains[this.chains.length - 1];
    return c[c.length - 1] ?? null;
  }

  reset() {
    this.chains = [[]];
    this.cursor = null;
    this.held = null;
    this.axis = null;
    this.planPoints = [];
    this.host.invalidate();
  }

  hint() {
    const onOff = (v: boolean) => (v ? 'on' : 'off');
    status(`Knife${this.selectedOnly ? ' (selected only)' : ''}: click to cut, drag to draw. Enter or Space confirms, Esc cancels, E new cut, double-click closes, Ctrl midpoints, Shift no snap, A angle (${onOff(this.angleSnap)}), C cut through (${onOff(this.through)}), X Y Z axis (${this.axis === null ? 'off' : 'XYZ'[this.axis]}), S measure (${onOff(this.measure)}), Ctrl+Z undo.`);
  }

  private view(p: Pane): KnifeView {
    const seeThrough = ed.xray || p.shading === 'wire';
    return {
      project: ([x, y, z]) => p.project(x, y, z),
      ray: (x, y) => { const r = p.ray(x, y); return { o: v3(r.origin), d: v3(r.direction) }; },
      visible: seeThrough ? undefined : ([x, y, z]) => !pick.occluded(p, this.host.sg, new THREE.Vector3(x, y, z)),
    };
  }

  private faces(): number[] {
    const m = ed.model;
    const list = editableFaces(m);
    if (!this.selectedOnly) return list;
    const sel = ed.selectedFaceSet();
    return list.filter((i) => sel.has(i));
  }

  private segments(extra?: KnifeClick): KnifeSegment[] {
    const out: KnifeSegment[] = [];
    if (!this.pane) return out;
    const view = this.view(this.pane);
    this.chains.forEach((c, k) => {
      const path = k === this.chains.length - 1 && extra ? [...c, extra] : c;
      for (let i = 0; i + 1 < path.length; i++) out.push({ a: path[i], b: path[i + 1], view });
    });
    return out;
  }

  /** Where the pointer lands: on a corner, an edge, a face, or in open space. */
  private resolve(p: Pane, x0: number, y0: number): Cursor {
    const m = ed.model;
    const last = this.last;
    let x = x0, y = y0;
    if (last && this.axis !== null) {
      // Along a world axis through the last point, to the place nearest the pointer.
      const r = p.ray(x, y);
      const d = new THREE.Vector3(); d.setComponent(this.axis, 1);
      const from = new THREE.Vector3(...last.p);
      const w = from.clone().sub(r.origin);
      const b = d.dot(r.direction), c = r.direction.dot(r.direction), de = d.dot(w), e = r.direction.dot(w);
      const den = c - b * b;
      const t = Math.abs(den) < 1e-9 ? 0 : (b * e - c * de) / den;
      const at = from.addScaledVector(d, t);
      const s = p.project(at.x, at.y, at.z);
      return { x: s.x, y: s.y, p: v3(at), kind: 'free' };
    }
    const snapOff = this.mods.shift;
    if (last && this.angleSnap) {
      const s = p.project(...last.p);
      const a = Math.round(Math.atan2(y - s.y, x - s.x) / (Math.PI / 6)) * (Math.PI / 6);
      const len = Math.hypot(x - s.x, y - s.y);
      x = s.x + Math.cos(a) * len;
      y = s.y + Math.sin(a) * len;
    } else if (this.mods.ctrl && !snapOff) {
      const k = pick.pickEdge(p, this.host.sg, x, y, 30);
      if (k) {
        const [a, b] = parseEdge(k);
        const A = m.verts[a].p, B = m.verts[b].p;
        const mid: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
        const s = p.project(...mid);
        return { x: s.x, y: s.y, p: mid, kind: 'mid' };
      }
    } else if (!snapOff) {
      const v = pick.pickVertex(p, this.host.sg, x, y, 12);
      if (v !== null) {
        const s = p.project(...m.verts[v].p);
        return { x: s.x, y: s.y, p: [...m.verts[v].p], kind: 'vert' };
      }
      const k = pick.pickEdge(p, this.host.sg, x, y, 10);
      if (k) {
        const [a, b] = parseEdge(k);
        const A = m.verts[a].p, B = m.verts[b].p;
        const sa = p.project(...A), sb = p.project(...B);
        const dx = sb.x - sa.x, dy = sb.y - sa.y;
        const u = Math.max(0, Math.min(1, ((x - sa.x) * dx + (y - sa.y) * dy) / (dx * dx + dy * dy || 1)));
        const sx = sa.x + dx * u, sy = sa.y + dy * u;
        // A fraction of the way along on screen isn't the same fraction in depth, so find the point by ray.
        const closest = new THREE.Vector3();
        p.ray(sx, sy).distanceSqToSegment(new THREE.Vector3(...A), new THREE.Vector3(...B), undefined, closest);
        return { x: sx, y: sy, p: v3(closest), kind: 'edge' };
      }
    }
    const hit = pick.pickFace(p, this.host.sg, x, y, ed.xray || p.shading === 'wire');
    if (hit) return { x, y, p: v3(hit.point), kind: 'face' };
    // Open space: on a plane facing the view through the last point, or through the model.
    const through = last ? new THREE.Vector3(...last.p) : this.modelCenter();
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(p.viewDir(), through);
    const at = p.ray(x, y).intersectPlane(plane, new THREE.Vector3()) ?? through;
    return { x, y, p: v3(at), kind: 'free' };
  }

  private modelCenter() {
    const c = new THREE.Vector3();
    const n = ed.model.verts.length;
    if (!n) return c;
    for (const v of ed.model.verts) c.add(new THREE.Vector3(...v.p));
    return c.multiplyScalar(1 / n);
  }

  private refreshPreview() {
    if (!this.pane) { this.planPoints = []; return; }
    const extra = this.cursor && this.last ? { id: -1, p: this.cursor.p } : undefined;
    const plan = planKnife(ed.model, this.segments(extra), { faces: this.faces(), through: this.through });
    this.planPoints = [...plan.nodes.values()].map((n) => n.p);
  }

  move(p: Pane, x: number, y: number, e: { ctrlKey: boolean; shiftKey: boolean }) {
    this.mods = { ctrl: e.ctrlKey, shift: e.shiftKey };
    this.pane = p;
    this.at = { x, y };
    this.cursor = this.resolve(p, x, y);
    // Holding the button down draws a continuous line.
    if (this.held && Math.hypot(x - this.held.x, y - this.held.y) > 18) {
      this.addPoint(this.cursor);
      this.held = { x, y };
    }
    this.refreshPreview();
    this.host.invalidate();
  }

  private addPoint(c: Cursor) {
    const last = this.last;
    if (last && this.pane) {
      const s = this.pane.project(...last.p);
      if (Math.hypot(s.x - c.x, s.y - c.y) < 3) return;
    }
    this.chains[this.chains.length - 1].push({ id: this.nextId++, p: c.p });
  }

  down(p: Pane, x: number, y: number, e: { ctrlKey: boolean; shiftKey: boolean }) {
    this.mods = { ctrl: e.ctrlKey, shift: e.shiftKey };
    this.pane = p;
    this.cursor = this.resolve(p, x, y);
    this.addPoint(this.cursor);
    this.held = { x, y };
    this.refreshPreview();
    this.hint();
    this.host.invalidate();
  }

  up() { this.held = null; }

  /** Double-click: join the line back to where it began, and start a new one. */
  closeLoop() {
    const c = this.chains[this.chains.length - 1];
    if (c.length >= 3) c.push({ ...c[0] });
    this.chains.push([]);
    this.refreshPreview();
    this.host.invalidate();
  }

  /** E, or a right click: end this line. The next click starts a new one. */
  newCut() {
    if (this.chains[this.chains.length - 1].length) this.chains.push([]);
    this.refreshPreview();
    this.host.invalidate();
  }

  undoPoint() {
    if (!this.chains[this.chains.length - 1].length && this.chains.length > 1) this.chains.pop();
    else this.chains[this.chains.length - 1].pop();
    this.refreshPreview();
    this.host.invalidate();
  }

  rightClick() {
    if (this.last) this.newCut();
    else this.cancel();
  }

  /** Ctrl or Shift went down or up: the snap changes without the pointer moving. */
  modifiers(e: { ctrlKey: boolean; shiftKey: boolean }) {
    if (this.pane && this.at) this.move(this.pane, this.at.x, this.at.y, e);
  }

  cancel() {
    this.reset();
    status('');
    this.host.finishOneShot();
  }

  confirm() {
    const segs = this.segments();
    const opts = { faces: this.faces(), through: this.through };
    if (!segs.length) { this.cancel(); return; }
    const plan = planKnife(ed.model, segs, opts);
    if (!plan.chords.size) {
      toast('That line doesn\'t cross any faces.', 'info');
      this.cancel();
      return;
    }
    ed.transact('Knife', (m) => selectCut(applyKnife(m, plan)));
    this.reset();
    status('');
    this.host.finishOneShot();
  }

  /** Keys while the Knife is the current tool. True if it used the key. */
  key(e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (e.key === 'Control' || e.key === 'Shift') { this.modifiers(e); return true; }
    if (e.ctrlKey && k === 'z' && this.active) { this.undoPoint(); return true; }
    if (e.ctrlKey || e.altKey) return false;
    if ((e.key === 'Enter' || e.key === ' ') && this.active) { this.confirm(); return true; }
    if (e.key === 'Escape' && this.active) { this.cancel(); return true; }
    // Options work whether or not a cut has started, as they do in Blender.
    const toggled = (fn: () => void) => { fn(); this.refreshPreview(); this.hint(); this.host.invalidate(); return true; };
    if (k === 'e') { this.newCut(); return true; }
    if (k === 'a') return toggled(() => { this.angleSnap = !this.angleSnap; });
    if (k === 'c') return toggled(() => { this.through = !this.through; });
    if (k === 's') return toggled(() => { this.measure = !this.measure; });
    if (k === 'x' || k === 'y' || k === 'z') {
      const axis = ({ x: 0, y: 1, z: 2 } as const)[k];
      return toggled(() => { this.axis = this.axis === axis ? null : axis; });
    }
    // Mid-cut, other letters don't switch tools by accident.
    return this.active && e.key.length === 1;
  }

  draw(g: CanvasRenderingContext2D, p: Pane) {
    const pt = (v: V3) => p.project(...v);
    g.save();
    g.lineWidth = 1.5;
    g.strokeStyle = CUT_LINE;
    for (const c of this.chains) {
      if (c.length < 2) continue;
      g.beginPath();
      c.forEach((k, i) => { const s = pt(k.p); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
      g.stroke();
    }
    const last = this.last;
    const cur = this.cursor;
    if (last && cur && p === this.pane) {
      const s = pt(last.p);
      g.setLineDash([5, 3]);
      g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(cur.x, cur.y); g.stroke();
      g.setLineDash([]);
      if (this.measure) {
        const d = Math.hypot(last.p[0] - cur.p[0], last.p[1] - cur.p[1], last.p[2] - cur.p[2]);
        const c = this.chains[this.chains.length - 1];
        const before = c[c.length - 2];
        let text = `${d.toFixed(3)} m`;
        if (before) {
          const u = new THREE.Vector3(...before.p).sub(new THREE.Vector3(...last.p));
          const v = new THREE.Vector3(...cur.p).sub(new THREE.Vector3(...last.p));
          if (u.lengthSq() > 0 && v.lengthSq() > 0) text += `  ${THREE.MathUtils.radToDeg(u.angleTo(v)).toFixed(1)}°`;
        }
        g.font = '12px sans-serif';
        g.fillStyle = '#fff';
        g.fillText(text, (s.x + cur.x) / 2 + 8, (s.y + cur.y) / 2 - 6);
      }
    }
    // Where the cut will land, and each point placed.
    g.fillStyle = CUT_POINT;
    for (const v of this.planPoints) { const s = pt(v); g.beginPath(); g.arc(s.x, s.y, 2.5, 0, 7); g.fill(); }
    g.fillStyle = CUT_LINE;
    for (const c of this.chains) for (const k of c) { const s = pt(k.p); g.beginPath(); g.arc(s.x, s.y, 3.5, 0, 7); g.fill(); }
    if (cur && p === this.pane) {
      const s = cur;
      g.fillStyle = cur.kind === 'vert' ? SNAP_VERT : cur.kind === 'edge' ? SNAP_EDGE : cur.kind === 'mid' ? SNAP_MID : CUT_LINE;
      g.beginPath(); g.arc(s.x, s.y, cur.kind === 'face' || cur.kind === 'free' ? 3 : 5, 0, 7); g.fill();
    }
    g.restore();
  }

  /** Test hook: where the cursor is snapping. */
  get snapKind() { return this.cursor?.kind ?? null; }
  get pointCount() { return this.chains.reduce((s, c) => s + c.length, 0); }
  get options() { return { through: this.through, angleSnap: this.angleSnap, axis: this.axis, measure: this.measure }; }
}

// ---------- loop cut ----------
interface Slide {
  pane: Pane;
  edge: string;
  base: Model;
  s: number;
  /** The slide before clamping and snapping, so small moves aren't lost. */
  raw: number;
  x: number;
  y: number;
  held: boolean;
  moved: boolean;
  a: { x: number; y: number };
  b: { x: number; y: number };
  even: boolean;
  flip: boolean;
  clamp: boolean;
  typed: string;
  lines: [V3, V3][];
}

export class LoopTool {
  private cuts = 1;
  private hover: { edge: string; lines: [V3, V3][] } | null = null;
  private slide: Slide | null = null;
  private typedCuts = '';
  private typedAt = 0;
  private mouse = { x: 0, y: 0 };

  constructor(private host: CutHost) {}

  get sliding() { return this.slide !== null; }
  get cutCount() { return this.cuts; }
  get factor() { return this.slide?.s ?? null; }
  get hovering() { return this.hover?.edge ?? null; }

  hint() {
    if (this.slide) {
      const s = this.slide;
      status(`Slide: ${s.typed || s.s.toFixed(3)}. Click or Enter confirms, right click or Esc leaves it centred. E even (${s.even ? 'on' : 'off'}), F flip (${s.flip ? 'on' : 'off'}), C clamp (${s.clamp ? 'on' : 'off'}), Shift for precision, Ctrl to snap, or type a value.`);
    } else status(`Loop Cut: ${this.cuts} cut${this.cuts === 1 ? '' : 's'}. Hover an edge, wheel or Page Up/Down changes the number, click places, then move to slide.`);
  }

  /** Ctrl+R starts from one cut each time, as in Blender. */
  resetCuts() { this.cuts = 1; }

  clearHover() {
    if (!this.hover) return;
    this.hover = null;
    this.host.invalidate();
  }

  private rebuildHover(edge: string | null) {
    this.hover = edge ? { edge, lines: loopPreview(ed.model, edge, { cuts: this.cuts }) } : null;
    if (this.hover && !this.hover.lines.length) this.hover = null;
    this.host.invalidate();
  }

  move(p: Pane, x: number, y: number, e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }) {
    const dx = x - this.mouse.x, dy = y - this.mouse.y;
    this.mouse = { x, y };
    const s = this.slide;
    if (s) { this.moveSlide(s, x, y, dx, dy, e); return; }
    const k = pick.pickEdge(p, this.host.sg, x, y, 40);
    if (k !== (this.hover?.edge ?? null)) this.rebuildHover(k);
  }

  private moveSlide(s: Slide, x: number, y: number, dx: number, dy: number, e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean }) {
    if (s.typed) return;
    if (Math.hypot(x - s.x, y - s.y) > 4) s.moved = true;
    const rx = s.b.x - s.a.x, ry = s.b.y - s.a.y;
    const len = rx * rx + ry * ry || 1;
    // The edge's full length, either side of the middle, is the full slide. Shift moves it a tenth as fast.
    s.raw += ((2 * (dx * rx + dy * ry)) / len) * (e.shiftKey ? 0.1 : 1);
    const snapped = e.ctrlKey ? Math.round(s.raw * 10) / 10 : s.raw;
    // Alt holds the opposite of the clamp setting.
    const free = s.clamp === e.altKey;
    this.setSlide(s, free ? snapped : Math.max(-0.98, Math.min(0.98, snapped)));
  }

  private opts(s: Slide): LoopOptions {
    return { cuts: this.cuts, slide: s.s, even: s.even, flip: s.flip };
  }

  private setSlide(s: Slide, value: number) {
    s.s = value;
    const work = cloneModel(s.base);
    const r = loopCuts(work, s.edge, this.opts(s));
    ed.model.verts = work.verts;
    ed.model.faces = work.faces;
    s.lines = r.edges.map((k) => {
      const [a, b] = parseEdge(k);
      return [work.verts[a].p, work.verts[b].p] as [V3, V3];
    });
    ed.emit('topology', 'geometry');
    this.hint();
    this.host.invalidate();
  }

  down(p: Pane, x: number, y: number) {
    this.mouse = { x, y };
    if (this.slide) { this.confirm(); return; }
    const k = pick.pickEdge(p, this.host.sg, x, y, 40);
    if (k !== (this.hover?.edge ?? null)) this.rebuildHover(k);
    if (!this.hover) { toast('Hover over an edge on a strip of quads to cut across it.', 'info'); return; }
    const edge = this.hover.edge;
    const [lo, hi] = parseEdge(edge);
    const m = ed.model;
    const a = p.project(...m.verts[lo].p), b = p.project(...m.verts[hi].p);
    ed.clearSelection();
    this.slide = { pane: p, edge, base: cloneModel(m), s: 0, raw: 0, x, y, held: true, moved: false, a, b, even: false, flip: false, clamp: true, typed: '', lines: [] };
    this.hover = null;
    this.setSlide(this.slide, 0);
  }

  up() {
    const s = this.slide;
    if (!s) return;
    // A drag places and slides in one go. A plain click leaves the slide following the pointer until the next click.
    if (s.held && s.moved) this.confirm();
    else s.held = false;
  }

  /** Put the model back as it was before the slide started, ready to record the final result as one step. */
  private restore(s: Slide) {
    ed.model.verts = s.base.verts;
    ed.model.faces = s.base.faces;
    this.slide = null;
  }

  abort() {
    const s = this.slide;
    if (!s) return;
    this.restore(s);
    ed.emit('topology', 'geometry');
    this.host.invalidate();
  }

  /** Right click or Esc: the cut stays, in the centre. */
  cancelSlide() {
    const s = this.slide;
    if (!s) return;
    s.s = 0;
    s.typed = '';
    this.confirm();
  }

  confirm() {
    const s = this.slide;
    if (!s) return;
    const typed = s.typed ? parseFloat(s.typed) : NaN;
    const edge = s.edge;
    const params = { cuts: this.cuts, slide: Number.isNaN(typed) ? s.s : typed, even: s.even, flip: s.flip };
    this.restore(s);
    ed.runOp('Loop Cut', [
      { key: 'cuts', label: 'Number of Cuts', type: 'number', value: params.cuts, min: 1, max: 64, step: 1 },
      { key: 'slide', label: 'Factor', type: 'number', value: Math.round(params.slide * 1000) / 1000, min: -1, max: 1, step: 0.01 },
      { key: 'smooth', label: 'Smoothness', type: 'number', value: 0, min: 0, max: 1, step: 0.05 },
      { key: 'even', label: 'Even', type: 'bool', value: params.even },
      { key: 'flip', label: 'Flipped', type: 'bool', value: params.flip },
    ], (m, v) => {
      const cuts = Math.max(1, Math.round(v.cuts));
      selectCut(loopCuts(m, edge, { cuts, slide: Math.max(-1, Math.min(1, v.slide)), even: v.even, flip: v.flip, smooth: v.smooth }));
    });
    status('');
    this.host.finishOneShot();
    this.host.invalidate();
  }

  wheel(deltaY: number) {
    if (this.slide) return;
    this.setCuts(this.cuts + (deltaY > 0 ? -1 : 1));
  }

  private setCuts(n: number) {
    this.cuts = Math.max(1, Math.min(64, n));
    if (this.hover) this.rebuildHover(this.hover.edge);
    this.hint();
  }

  /** True if it used the key. */
  key(e: KeyboardEvent): boolean {
    const s = this.slide;
    if (s) return this.slideKey(s, e);
    if (e.ctrlKey || e.altKey) return false;
    if (e.key === 'PageUp' || e.key === '+' || e.key === '=') { this.setCuts(this.cuts + 1); return true; }
    if (e.key === 'PageDown' || e.key === '-') { this.setCuts(this.cuts - 1); return true; }
    if (/^[0-9]$/.test(e.key)) {
      // Digits typed close together make a number: 1 then 2 is twelve cuts.
      const now = performance.now();
      this.typedCuts = now - this.typedAt < 900 ? this.typedCuts + e.key : e.key;
      this.typedAt = now;
      this.setCuts(parseInt(this.typedCuts, 10) || 1);
      return true;
    }
    return false;
  }

  private slideKey(s: Slide, e: KeyboardEvent): boolean {
    const k = e.key.toLowerCase();
    if (e.key === 'Enter' || e.key === ' ') { this.confirm(); return true; }
    if (e.key === 'Escape') { this.cancelSlide(); return true; }
    const redo = () => { this.setSlide(s, s.s); return true; };
    if (k === 'e') { s.even = !s.even; return redo(); }
    if (k === 'f') { s.flip = !s.flip; return redo(); }
    if (k === 'c') { s.clamp = !s.clamp; return redo(); }
    if (/^[0-9.]$/.test(e.key) || (e.key === '-' && !s.typed)) {
      s.typed += e.key;
      const v = parseFloat(s.typed);
      if (!Number.isNaN(v)) this.setSlide(s, Math.max(-1, Math.min(1, v)));
      return true;
    }
    if (e.key === 'Backspace') {
      s.typed = s.typed.slice(0, -1);
      const v = parseFloat(s.typed);
      this.setSlide(s, Number.isNaN(v) ? 0 : Math.max(-1, Math.min(1, v)));
      return true;
    }
    // Nothing else reaches the app during a slide.
    return true;
  }

  draw(g: CanvasRenderingContext2D, p: Pane) {
    const lines = this.slide?.lines ?? this.hover?.lines;
    if (!lines) return;
    g.save();
    g.strokeStyle = LOOP_LINE;
    g.lineWidth = 1.5;
    g.beginPath();
    for (const [a, b] of lines) {
      const sa = p.project(...a), sb = p.project(...b);
      g.moveTo(sa.x, sa.y);
      g.lineTo(sb.x, sb.y);
    }
    g.stroke();
    g.restore();
  }
}
