// Inset, as Blender's I: press I over a view with faces selected, then move the mouse toward the selection's middle
// to widen the border. Ctrl+mouse sets Depth, I switches Individual, E switches Even, typing gives an exact width
// (or depth while Ctrl is held). Click or Enter keeps it; right click or Esc puts it back.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { insetRegion } from '../core/meshtools';
import { cloneModel, type Model } from '../core/types';
import { status } from '../ui/feedback';
import type { Pane } from './pane';

interface Session {
  pane: Pane;
  faces: Set<number>;
  base: Model;
  /** The selection's middle on screen, and the mouse's distance from it at the start. */
  cx: number; cy: number; d0: number;
  /** World units per screen pixel at the selection. */
  upp: number;
  thickness: number;
  depth: number;
  individual: boolean;
  even: boolean;
  /** Ctrl held: the mouse sets Depth, from where it was when Ctrl went down. */
  depthFrom: { y: number; depth: number } | null;
  typed: string;
}

export class InsetModal {
  private s: Session | null = null;
  constructor(private invalidate: () => void) {}

  get active() { return this.s !== null; }

  start(p: Pane, x: number, y: number): boolean {
    const faces = ed.selectedFaceSet();
    if (!faces.size) return false;
    const m = ed.model;
    const c = new THREE.Vector3();
    let n = 0;
    for (const fi of faces) for (const v of m.faces[fi].v) { c.add(new THREE.Vector3(...m.verts[v].p)); n++; }
    c.divideScalar(Math.max(1, n));
    const s = p.project(c.x, c.y, c.z);
    ed.begin('Inset');
    this.s = {
      pane: p, faces: new Set(faces), base: cloneModel(m), cx: s.x, cy: s.y, d0: Math.max(30, Math.hypot(x - s.x, y - s.y)),
      upp: p.unitsPerPixel(c), thickness: 0, depth: 0, individual: false, even: true, depthFrom: null, typed: '',
    };
    this.apply();
    return true;
  }

  move(p: Pane, x: number, y: number, e: { ctrlKey: boolean; shiftKey: boolean }) {
    const s = this.s;
    if (!s || p !== s.pane || s.typed) return;
    const fine = e.shiftKey ? 0.1 : 1;
    if (e.ctrlKey) {
      // Depth from the mouse's height since Ctrl went down: up pushes out, down pushes in.
      if (!s.depthFrom) s.depthFrom = { y, depth: s.depth };
      s.depth = s.depthFrom.depth + (s.depthFrom.y - y) * s.upp * fine;
    } else {
      s.depthFrom = null;
      // Toward the middle widens the border, as in Blender.
      s.thickness = Math.max(0, (s.d0 - Math.hypot(x - s.cx, y - s.cy)) * s.upp * fine);
    }
    this.apply();
  }

  key(e: KeyboardEvent): boolean {
    const s = this.s;
    if (!s) return false;
    const k = e.key;
    if (k === 'Escape') { this.cancel(); return true; }
    if (k === 'Enter' || k === ' ') { this.confirm(); return true; }
    if (k.toLowerCase() === 'i' && !e.ctrlKey) { s.individual = !s.individual; this.apply(); return true; }
    if (k.toLowerCase() === 'e' && !e.ctrlKey) { s.even = !s.even; this.apply(); return true; }
    // Typed values: the width, or the depth while Ctrl is held.
    if (/^[0-9.\-]$/.test(k) || k === 'Backspace') {
      s.typed = k === 'Backspace' ? s.typed.slice(0, -1) : s.typed + k;
      const v = parseFloat(s.typed);
      if (Number.isFinite(v)) { if (e.ctrlKey || s.depthFrom) s.depth = v; else s.thickness = Math.max(0, v); }
      this.apply();
      return true;
    }
    if (k === 'Control' || k === 'Shift') return true;
    return true;
  }

  /** Redo the inset from the untouched mesh with the current settings. */
  private apply() {
    const s = this.s;
    if (!s) return;
    const fresh = cloneModel(s.base);
    ed.model.verts = fresh.verts;
    ed.model.faces = fresh.faces;
    insetRegion(ed.model, s.faces, { thickness: s.thickness, depth: s.depth, individual: s.individual, even: s.even });
    ed.emit('topology');
    status(`Inset  width ${s.typed && !s.depthFrom ? `${s.typed}_` : s.thickness.toFixed(3)}  depth ${s.depth.toFixed(3)}   Individual (I): ${s.individual ? 'on' : 'off'}   Even (E): ${s.even ? 'on' : 'off'}   Ctrl: depth   Shift: fine   Click or Enter keeps it, right click or Esc cancels`);
    this.invalidate();
  }

  /** Keep it, as an operation whose settings stay adjustable in the panel. */
  confirm() {
    const s = this.s;
    if (!s) return;
    this.s = null;
    ed.cancel();
    const faces = s.faces;
    ed.runOp('Inset', [
      { key: 'thickness', label: 'Thickness', type: 'number', value: +s.thickness.toFixed(4), min: 0, max: 100, step: 0.005 },
      { key: 'depth', label: 'Depth', type: 'number', value: +s.depth.toFixed(4), min: -100, max: 100, step: 0.005 },
      { key: 'individual', label: 'Individual', type: 'bool', value: s.individual },
      { key: 'even', label: 'Even offset', type: 'bool', value: s.even },
    ], (m, v) => {
      insetRegion(m, faces, { thickness: v.thickness, depth: v.depth, individual: v.individual, even: v.even });
      ed.mode = 'face';
      ed.selFaces = new Set(faces);
    });
    status('');
  }

  cancel() {
    if (!this.s) return;
    this.s = null;
    ed.cancel();
    ed.emitAll();
    status('Inset cancelled.');
    this.invalidate();
  }
}

