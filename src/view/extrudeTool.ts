// Extrude, the way Blender and SketchUp do it.
//
// Push/Pull (SketchUp): with the Extrude tool, the face under the mouse lights up. Drag it to pull it out or push
// it in; a click without dragging follows the mouse until the next click. A face that's part of the selection
// takes the whole selection with it. Double-clicking a face repeats the last distance.
//
// Modal (Blender): pressing T with faces selected, over a view, extrudes them straight away and they follow the
// mouse. Type a distance for an exact one. Enter or a click keeps it; Esc or a right click puts everything back.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { bounds } from '../core/geom';
import * as ops from '../core/ops';
import type { V3 } from '../core/types';
import { status } from '../ui/feedback';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

const HOVER = '#f2b24c';

export interface ExtrudeHost {
  sg: SceneGraph;
  invalidate(): void;
}

interface Session {
  pane: Pane;
  x0: number; y0: number;
  /** The new top vertices and where they started. */
  verts: Map<number, V3>;
  normals: Map<number, V3>;
  center: THREE.Vector3;
  axis: THREE.Vector3;
  amount: number;
  /** A distance typed on the keyboard, which overrides the mouse. */
  typed: string;
  /** Held down since it started: letting go keeps it. Otherwise it follows the mouse until a click. */
  dragging: boolean;
  moved: boolean;
}

export class ExtrudeTool {
  private s: Session | null = null;
  private hoverFace: number | null = null;
  private hoverPane: Pane | null = null;
  private mouse: { x: number; y: number; pane: Pane } | null = null;
  /** The last distance used, for a double-click to repeat. */
  private last = 0;
  private mods = { alt: false, ctrl: false, shift: false };

  constructor(private host: ExtrudeHost) {}

  get active() { return this.s !== null; }

  hint() {
    status('Extrude: drag a face to pull it out or push it in, or click it and move. A face in the selection takes the selection with it. Double-click repeats the last distance. T over a view extrudes the selection.');
  }

  /** The faces a press on `face` should extrude: the selection if it's part of it, otherwise just that face. */
  private facesFor(face: number): Set<number> {
    const sel = ed.selectedFaceSet();
    if (sel.has(face)) return sel;
    if (ed.mode !== 'face' && ed.mode !== 'group') ed.mode = 'face';
    ed.clearSelection();
    ed.selFaces.add(face);
    ed.emit('selection');
    return new Set([face]);
  }

  private begin(p: Pane, x: number, y: number, faces: Set<number>, dragging: boolean) {
    ed.lastOp = null;
    ed.begin('Extrude');
    const { top, normal, vertexNormals } = ops.extrudeFaces(ed.model, faces);
    const verts = new Map<number, V3>();
    top.forEach((v) => verts.set(v, [...ed.model.verts[v].p] as V3));
    const c = bounds([...verts.values()]).center;
    this.s = {
      pane: p, x0: x, y0: y, verts, normals: vertexNormals, center: new THREE.Vector3(...c), axis: new THREE.Vector3(...normal),
      amount: 0, typed: '', dragging, moved: false,
    };
    this.hoverFace = null;
    ed.emit('topology');
    this.show();
  }

  /** T over a view: extrude the selection and let it follow the mouse. False if there's nothing to extrude. */
  startModal(p: Pane, x: number, y: number): boolean {
    if (this.s) return true;
    const faces = ed.selectedFaceSet();
    if (!faces.size) return false;
    this.begin(p, x, y, faces, false);
    return true;
  }

  // ---------- input ----------
  down(p: Pane, x: number, y: number, e: PointerEvent) {
    this.readMods(e);
    // A click while following the mouse keeps the distance.
    if (this.s) { this.finish(); return; }
    const hit = pick.pickFace(p, this.host.sg, x, y, false);
    if (!hit) { status('Extrude: press on a face to pull it out or push it in.'); return; }
    this.begin(p, x, y, this.facesFor(hit.face), true);
  }

  move(p: Pane, x: number, y: number, e: PointerEvent) {
    this.readMods(e);
    this.mouse = { x, y, pane: p };
    if (this.s) {
      if (p !== this.s.pane) return;
      if (Math.hypot(x - this.s.x0, y - this.s.y0) > 3) this.s.moved = true;
      this.update();
      return;
    }
    const hit = pick.pickFace(p, this.host.sg, x, y, false);
    const f = hit?.face ?? null;
    if (f !== this.hoverFace || p !== this.hoverPane) { this.hoverFace = f; this.hoverPane = p; this.host.invalidate(); }
  }

  up() {
    const s = this.s;
    if (!s || !s.dragging) return;
    // A press that didn't move becomes click-move-click; a drag is done when it's let go.
    if (!s.moved) { s.dragging = false; this.show(); return; }
    this.finish();
  }

  /** Double-click a face: extrude it by the last distance again. */
  dblclick(p: Pane, x: number, y: number) {
    if (!this.last) return;
    // The first click of the double-click started a fresh, unmoved extrude: give it the last distance.
    if (this.s && !this.s.moved && !this.s.typed) {
      this.s.typed = String(+this.last.toFixed(6));
      this.update();
      this.finish();
      return;
    }
    const hit = pick.pickFace(p, this.host.sg, x, y, false);
    if (!hit || this.s) return;
    this.begin(p, x, y, this.facesFor(hit.face), false);
    this.s!.typed = String(+this.last.toFixed(6));
    this.update();
    this.finish();
  }

  /** Keys while extruding. True if one was used. */
  key(e: KeyboardEvent): boolean {
    this.readMods(e);
    const s = this.s;
    if (!s) return false;
    const k = e.key;
    if (k === 'Escape') { this.cancel(); return true; }
    if (k === 'Enter' || k === ' ') { this.finish(); return true; }
    // A comma counts as the decimal point too, for keyboards that type one.
    if (/^[0-9.,]$/.test(k) || (k === '-' && !s.typed)) { s.typed += k === ',' ? '.' : k; this.update(); return true; }
    if (k === '-' && s.typed) { s.typed = s.typed.startsWith('-') ? s.typed.slice(1) : `-${s.typed}`; this.update(); return true; }
    if (k === 'Backspace') { s.typed = s.typed.slice(0, -1); this.update(); return true; }
    if (k === 'Alt' || k === 'Control' || k === 'Shift') { this.update(); return true; }
    // Other keys wait until this extrude is done.
    return !e.ctrlKey && !e.metaKey;
  }

  keyUp(e: KeyboardEvent) {
    if (!this.s) return;
    this.readMods(e);
    this.update();
  }

  private readMods(e: { altKey: boolean; ctrlKey: boolean; shiftKey: boolean; type?: string; key?: string }) {
    this.mods = { alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey };
  }

  // ---------- the extrusion ----------
  /** How far along the normal the mouse says, before snapping. */
  private fromMouse(): number {
    const s = this.s!;
    const m = this.mouse?.pane === s.pane ? this.mouse : { x: s.x0, y: s.y0 };
    const p = s.pane, c = s.center;
    const u = p.unitsPerPixel(c);
    const a = p.project(c.x, c.y, c.z);
    const b = p.project(c.x + s.axis.x, c.y + s.axis.y, c.z + s.axis.z);
    let ax = b.x - a.x, ay = b.y - a.y;
    const l = Math.hypot(ax, ay);
    // When the normal points straight at the camera, moving up pulls it out.
    if (l < 1e-3 || l * u < 0.15) return (s.y0 - m.y) * u;
    ax /= l; ay /= l;
    let amount = ((m.x - s.x0) * ax + (m.y - s.y0) * ay) / l;
    if (this.mods.shift) amount *= 0.1;
    return amount;
  }

  private update() {
    const s = this.s;
    if (!s) return;
    let amount: number;
    if (s.typed && s.typed !== '-' && s.typed !== '.' && Number.isFinite(parseFloat(s.typed))) amount = parseFloat(s.typed);
    else {
      amount = this.fromMouse();
      if (this.mods.ctrl !== ed.snap) amount = Math.round(amount / ed.snapStep) * ed.snapStep;
    }
    s.amount = amount;
    const along = this.mods.alt;
    s.verts.forEach((o, i) => {
      const n: V3 = along ? s.normals.get(i) ?? [s.axis.x, s.axis.y, s.axis.z] : [s.axis.x, s.axis.y, s.axis.z];
      ed.model.verts[i].p = [o[0] + n[0] * amount, o[1] + n[1] * amount, o[2] + n[2] * amount];
    });
    // Pushed in or pulled out, the walls are wound to match their neighbours, so they always face out of the solid.
    ed.emit('geometry');
    this.show();
    this.host.invalidate();
  }

  private show() {
    const s = this.s;
    if (!s) return;
    const how = s.dragging ? 'let go to keep it' : 'click or Enter keeps it';
    const typed = s.typed ? `  typed ${s.typed}` : '';
    status(`Extrude ${s.amount.toFixed(3)}${typed}: ${how}, Esc or right click cancels. Type a distance, Ctrl snaps, Shift fine, Alt along vertex normals.`);
  }

  finish() {
    const s = this.s;
    if (!s) return;
    this.s = null;
    // Nothing moved: leave no doubled faces behind.
    if (Math.abs(s.amount) < 1e-9) { ed.cancel(); this.hint(); this.host.invalidate(); return; }
    this.last = s.amount;
    ed.commit();
    ed.emitAll();
    status(`Extruded ${s.amount.toFixed(3)}. Double-click a face to repeat it.`);
    this.host.invalidate();
  }

  cancel() {
    if (!this.s) return;
    this.s = null;
    ed.cancel();
    this.hint();
    this.host.invalidate();
  }

  // ---------- drawing ----------
  draw(g: CanvasRenderingContext2D, p: Pane) {
    const s = this.s;
    if (s && s.pane === p && this.mouse?.pane === p) {
      // The distance, by the cursor.
      const text = `${s.amount >= 0 ? '+' : ''}${s.amount.toFixed(3)}${s.typed ? ' ⌨' : ''}`;
      g.font = '11px "Segoe UI", sans-serif';
      const w = g.measureText(text).width + 10;
      g.fillStyle = 'rgba(20,22,25,0.85)'; g.fillRect(this.mouse.x + 14, this.mouse.y + 10, w, 18);
      g.fillStyle = HOVER; g.textAlign = 'left'; g.textBaseline = 'middle';
      g.fillText(text, this.mouse.x + 19, this.mouse.y + 19);
      return;
    }
    if (s || this.hoverFace === null || this.hoverPane !== p) return;
    const f = ed.model.faces[this.hoverFace];
    if (!f) return;
    // The face that a press would pull.
    g.beginPath();
    f.v.forEach((v, i) => {
      const q = ed.model.verts[v].p;
      const sc = p.project(q[0], q[1], q[2]);
      if (i) g.lineTo(sc.x, sc.y); else g.moveTo(sc.x, sc.y);
    });
    g.closePath();
    g.fillStyle = 'rgba(242,178,76,0.22)'; g.fill();
    g.strokeStyle = HOVER; g.lineWidth = 2; g.stroke();
  }

  clearHover() {
    if (this.hoverFace !== null) { this.hoverFace = null; this.host.invalidate(); }
  }
}
