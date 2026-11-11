// 2D UV editor. V runs downward from the image's top edge, matching glTF.
import { ed } from '../core/editor';
import { edgeKey } from '../core/geom';
import type { V2 } from '../core/types';
import { liveUnwrap, relaxUV, seamEdges, setPins, stitchIslands, texelDensity, uvIslands, uvOverlaps, uvStretch, uvUsage } from '../core/uv';
import { app } from './app';
import { runCommand } from './commands';
import { button, h, numField, renderInto } from './dom';
import { status, toast } from './feedback';
import { menuButton } from './menu';

type Corner = string; // "face:corner"
const ck = (f: number, c: number): Corner => `${f}:${c}`;
const parse = (k: Corner) => k.split(':').map(Number) as [number, number];

export type UVSelectMode = 'vertex' | 'edge' | 'face' | 'island';
const SEL = '#f2b24c';
const SEAM = '#ff5d5d';

/** Scale handles around the selection, with the opposite side's position used as the pivot. */
const HANDLES: { id: string; ax: number; ay: number }[] = [
  { id: 'nw', ax: -1, ay: -1 }, { id: 'n', ax: 0, ay: -1 }, { id: 'ne', ax: 1, ay: -1 }, { id: 'e', ax: 1, ay: 0 },
  { id: 'se', ax: 1, ay: 1 }, { id: 's', ax: 0, ay: 1 }, { id: 'sw', ax: -1, ay: 1 }, { id: 'w', ax: -1, ay: 0 },
];

type XfDrag = {
  kind: 'xf'; op: 'move' | 'rotate' | 'scale'; x0: number; y0: number; moved: boolean;
  center: V2; orig: Map<Corner, V2>; ax: number; ay: number; pivot: V2; grab: V2;
};

interface Analysis { islands: number[][]; overlap: Set<number>; stretch: Map<number, number>; outside: number; borders: Set<string>; seams: Set<string> }

export class UVEditor {
  el: HTMLElement;
  private cv: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private zoom = 0.85; private panX = 0; private panY = 0;
  private sel = new Set<Corner>();
  mode: UVSelectMode = 'vertex';
  private img: HTMLImageElement | null = null;
  private imgUrl = '';
  private readout: HTMLElement;
  private fields: HTMLElement;
  private modeBtns = new Map<string, HTMLElement>();
  private drag:
    | { kind: 'pan'; x: number; y: number }
    | { kind: 'box'; x0: number; y0: number; x1: number; y1: number; add: boolean; sub: boolean }
    | XfDrag
    | null = null;
  private checker: CanvasPattern | null = null;
  private cache: Analysis | null = null;
  private mouse = { x: 0, y: 0, inside: false };
  // Display options.
  showImage = true;
  showGrid = true;
  showStretch = false;
  showOverlap = true;
  snap = false;
  live = false;
  sticky = true;
  grid = 16;
  textureSize = 1024;

  constructor() {
    this.cv = h('canvas', { class: 'uv-canvas', tabindex: '0' }) as HTMLCanvasElement;
    this.g = this.cv.getContext('2d')!;
    this.readout = h('span', { class: 'muted small uv-readout' });
    this.fields = h('div', { class: 'uv-fields' });
    const modeBtn = (m: UVSelectMode, label: string, key: string) => {
      const b = button(label, () => this.setMode(m), { class: 'seg-btn', title: `Select ${m === 'island' ? 'whole islands' : `${m === 'vertex' ? 'vertice' : m}s`} (${key} while over the editor)` });
      this.modeBtns.set(m, b);
      return b;
    };
    const bar = h('div', { class: 'uv-bar' },
      h('div', { class: 'seg' }, modeBtn('vertex', 'Vertex', '1'), modeBtn('edge', 'Edge', '2'), modeBtn('face', 'Face', '3'), modeBtn('island', 'Island', '4')),
      h('span', { class: 'tl-sep' }),
      button('Auto Unwrap', () => runCommand('uv.unwrap'), { class: 'btn btn-primary btn-small', title: 'One click, no seams to mark (U)' }),
      menuButton('More', ['uv.smart', null, 'uv.box', 'uv.planarView', 'uv.cylinder', 'uv.sphere', null, 'uv.copyMirror', null, 'uv.markSeam', 'uv.clearSeam', 'uv.seamsFromIslands', 'uv.clearAllSeams']),
      menuButton('Pins', ['uv.pin', 'uv.unpin', null, 'uv.live', 'uv.sticky']),
      menuButton('Arrange', ['uv.pack', 'uv.fit', 'uv.minimize', 'uv.average', 'uv.alignIslands', 'uv.density', null, 'uv.stitch', 'uv.weld', 'uv.relax', null, 'uv.alignLeft', 'uv.alignRight', 'uv.alignTop', 'uv.alignBottom', null, 'uv.flipU', 'uv.flipV', 'uv.rot90']),
      menuButton('View', ['uv.frame', 'uv.frameAll', null, 'uv.showImage', 'uv.showGrid', 'uv.showStretch', 'uv.showOverlap', 'uv.selectOverlaps', null, 'uv.snap', null, 'uv.exportLayout']),
    );
    // A fixed-height row: nothing that appears on selecting may move the canvas under the mouse.
    const foot = h('div', { class: 'uv-foot' }, this.fields, this.readout);
    const wrap = h('div', { class: 'uv-wrap' }, this.cv);
    this.el = h('section', { class: 'uv-editor', 'aria-label': 'UV editor' }, bar, wrap, foot);
    new ResizeObserver(() => this.draw()).observe(wrap);
    this.bind();
    this.syncBtns();
    ed.on(['selection', 'topology', 'geometry', 'materials', 'groups', 'history'], () => {
      this.cache = null;
      this.prune();
      this.draw();
      this.renderFields();
    });
    ed.on('tool', () => this.draw());
    app.uvRefresh = () => this.frameAll();
    app.uv = this;
    this.renderFields();
  }

  setMode(m: UVSelectMode) { this.mode = m; this.syncBtns(); this.draw(); }
  private syncBtns() { this.modeBtns.forEach((b, k) => b.classList.toggle('active', k === this.mode)); }

  private prune() {
    for (const k of this.sel) {
      const [f, c] = parse(k);
      if (!ed.model.faces[f]?.uv[c]) this.sel.delete(k);
    }
  }

  /** Faces displayed: the selection, or else the active group, or else everything. */
  shownFaces(): number[] {
    const sel = ed.selectedFaceSet();
    if (sel.size) return [...sel];
    const out: number[] = [];
    ed.model.faces.forEach((f, i) => { if (f.g === ed.activeGroup) out.push(i); });
    if (out.length) return out;
    return [...ed.model.faces.keys()];
  }

  private texture(): HTMLImageElement | null {
    const m = ed.model;
    const shown = this.shownFaces();
    const g = shown.length ? m.groups.find((x) => x.id === m.faces[shown[0]].g) : null;
    const mat = m.materials.find((x) => x.id === g?.material);
    const t = m.textures.find((x) => x.id === mat?.maps.base);
    if (!t) return null;
    if (t.url !== this.imgUrl) {
      this.imgUrl = t.url;
      const img = new Image();
      img.onload = () => this.draw();
      img.src = t.url;
      this.img = img;
    }
    return this.img;
  }

  /** The texture's size where there is one; the editor's working size otherwise. */
  private densitySize(): number {
    const m = ed.model;
    const shown = this.shownFaces();
    const g = shown.length ? m.groups.find((x) => x.id === m.faces[shown[0]].g) : null;
    const mat = m.materials.find((x) => x.id === g?.material);
    const t = m.textures.find((x) => x.id === mat?.maps.base);
    return t ? Math.max(t.width, t.height) : this.textureSize;
  }
  get workingSize() { return this.densitySize(); }

  private size() { return Math.min(this.cv.clientWidth, this.cv.clientHeight) * this.zoom; }
  toScreen(u: number, v: number): [number, number] {
    const s = this.size();
    return [this.cv.clientWidth / 2 + this.panX + (u - 0.5) * s, this.cv.clientHeight / 2 + this.panY + (v - 0.5) * s];
  }
  private toUV(x: number, y: number): V2 {
    const s = this.size();
    return [(x - this.cv.clientWidth / 2 - this.panX) / s + 0.5, (y - this.cv.clientHeight / 2 - this.panY) / s + 0.5];
  }

  // ---------- analysis ----------
  private analysis(): Analysis {
    if (this.cache) return this.cache;
    const m = ed.model;
    const shown = this.shownFaces();
    const seams = seamEdges(m);
    const islands = uvIslands(m, shown);
    // An outline edge has no partner with matching UVs on the other side.
    const counts = new Map<string, number>();
    const edgeId = (fi: number, i: number) => {
      const f = m.faces[fi], j = (i + 1) % f.v.length;
      const a = `${f.v[i]}|${f.uv[i][0].toFixed(5)},${f.uv[i][1].toFixed(5)}`, b = `${f.v[j]}|${f.uv[j][0].toFixed(5)},${f.uv[j][1].toFixed(5)}`;
      return a < b ? `${a}~${b}` : `${b}~${a}`;
    };
    for (const fi of shown) m.faces[fi].v.forEach((_, i) => { const k = edgeId(fi, i); counts.set(k, (counts.get(k) ?? 0) + 1); });
    const borders = new Set<string>();
    for (const fi of shown) m.faces[fi].v.forEach((_, i) => { if (counts.get(edgeId(fi, i)) === 1) borders.add(ck(fi, i)); });
    let outside = 0;
    for (const fi of shown) if (m.faces[fi].uv.some((u) => u[0] < -1e-4 || u[0] > 1 + 1e-4 || u[1] < -1e-4 || u[1] > 1 + 1e-4)) outside++;
    return (this.cache = { islands, overlap: uvOverlaps(m, shown), stretch: uvStretch(m, shown), outside, borders, seams });
  }

  // ---------- drawing ----------
  draw() {
    const cv = this.cv;
    const parent = cv.parentElement!;
    const W = parent.clientWidth, H = parent.clientHeight;
    if (!W || !H || !this.el.isConnected || this.el.offsetParent === null) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      cv.style.width = `${W}px`; cv.style.height = `${H}px`;
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#1b1e22'; g.fillRect(0, 0, W, H);

    const [x0, y0] = this.toScreen(0, 0);
    const s = this.size();
    const img = this.texture();
    if (this.showImage && img?.complete && img.naturalWidth) g.drawImage(img, x0, y0, s, s);
    else { g.fillStyle = this.pattern(); g.save(); g.translate(x0, y0); g.fillRect(0, 0, s, s); g.restore(); }
    if (this.showGrid) this.drawGrid(x0, y0, s);
    g.strokeStyle = '#7a828c'; g.lineWidth = 1; g.strokeRect(x0 + 0.5, y0 + 0.5, s, s);

    const m = ed.model;
    const shown = this.shownFaces();
    const live = this.drag?.kind === 'xf' && this.cache ? this.cache : this.analysis();
    this.drawFaces(shown, live);
    this.drawEdges(shown, live);
    this.drawPoints(shown);
    if (this.drag?.kind !== 'box') this.drawHandles();

    if (this.drag?.kind === 'box') {
      const d = this.drag;
      g.strokeStyle = SEL; g.fillStyle = 'rgba(242,178,76,.12)'; g.setLineDash([4, 3]); g.lineWidth = 1;
      g.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      g.setLineDash([]);
    }

    if (!m.faces.length) {
      g.fillStyle = '#8c949e'; g.font = '13px "Segoe UI", sans-serif'; g.textAlign = 'center';
      g.fillText('Add geometry to edit its UVs.', W / 2, H / 2);
      g.textAlign = 'start';
    }
    this.updateReadout(shown, live);
    this.syncViewportOverlay();
  }

  private drawGrid(x0: number, y0: number, s: number) {
    const g = this.g;
    // Keep lines a readable distance apart at any zoom.
    let n = this.grid;
    while (s / n < 12 && n > 1) n /= 2;
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1;
    g.beginPath();
    for (let i = 1; i < n; i++) {
      const a = Math.round(x0 + (i / n) * s) + 0.5, b = Math.round(y0 + (i / n) * s) + 0.5;
      g.moveTo(a, y0); g.lineTo(a, y0 + s);
      g.moveTo(x0, b); g.lineTo(x0 + s, b);
    }
    g.stroke();
  }

  private facePath(fi: number) {
    const g = this.g;
    g.beginPath();
    ed.model.faces[fi].uv.forEach((u, i) => {
      const [a, b] = this.toScreen(u[0], u[1]);
      if (i) g.lineTo(a, b); else g.moveTo(a, b);
    });
    g.closePath();
  }

  private isFaceSelected(fi: number) {
    return ed.model.faces[fi].uv.every((_, c) => this.sel.has(ck(fi, c)));
  }

  private drawFaces(shown: number[], a: Analysis) {
    const g = this.g;
    for (const fi of shown) {
      let fill = this.showImage && this.img?.complete ? '' : 'rgba(130,175,225,.09)';
      if (this.showStretch) {
        const t = Math.min(1, ((a.stretch.get(fi) ?? 1) - 1) / 1.2);
        // Blue when true to shape, through green and yellow, to red when badly distorted.
        fill = `hsla(${220 * (1 - t)}, 75%, 52%, .55)`;
      }
      if (this.showOverlap && a.overlap.has(fi)) fill = 'rgba(232,85,90,.42)';
      if (this.mode !== 'vertex' && this.isFaceSelected(fi)) fill = 'rgba(242,178,76,.32)';
      if (!fill) continue;
      this.facePath(fi);
      g.fillStyle = fill;
      g.fill();
    }
  }

  private drawEdges(shown: number[], a: Analysis) {
    const g = this.g, m = ed.model;
    const stroke = (color: string, width: number, want: (fi: number, i: number, key: string) => boolean) => {
      g.strokeStyle = color; g.lineWidth = width;
      g.beginPath();
      for (const fi of shown) {
        const f = m.faces[fi];
        for (let i = 0; i < f.v.length; i++) {
          const j = (i + 1) % f.v.length;
          if (!want(fi, i, edgeKey(f.v[i], f.v[j]))) continue;
          const [ax, ay] = this.toScreen(f.uv[i][0], f.uv[i][1]);
          const [bx, by] = this.toScreen(f.uv[j][0], f.uv[j][1]);
          g.moveTo(ax, ay); g.lineTo(bx, by);
        }
      }
      g.stroke();
    };
    stroke('rgba(190,225,255,.55)', 1, () => true);
    stroke('rgba(225,242,255,.95)', 1.5, (fi, i) => a.borders.has(ck(fi, i)));
    stroke(SEAM, 2, (_f, _i, k) => a.seams.has(k));
    if (this.sel.size) stroke(SEL, 2, (fi, i) => this.sel.has(ck(fi, i)) && this.sel.has(ck(fi, (i + 1) % m.faces[fi].v.length)));
  }

  private drawPoints(shown: number[]) {
    const g = this.g, m = ed.model;
    if (this.mode === 'vertex') {
      g.fillStyle = '#d4e9f6';
      for (const fi of shown) {
        m.faces[fi].uv.forEach((u, c) => {
          if (this.sel.has(ck(fi, c))) return;
          const [a, b] = this.toScreen(u[0], u[1]);
          g.fillRect(a - 1.5, b - 1.5, 3, 3);
        });
      }
    }
    g.fillStyle = SEL;
    this.sel.forEach((k) => {
      const [f, c] = parse(k);
      const u = m.faces[f]?.uv[c];
      if (!u) return;
      const [a, b] = this.toScreen(u[0], u[1]);
      g.fillRect(a - 2.5, b - 2.5, 5, 5);
    });
    // Pins, so they can't be mistaken for ordinary points.
    g.fillStyle = '#ff5d5d'; g.strokeStyle = '#111'; g.lineWidth = 1;
    for (const fi of shown) {
      m.faces[fi].pin?.forEach((on, c) => {
        if (!on) return;
        const [a, b] = this.toScreen(m.faces[fi].uv[c][0], m.faces[fi].uv[c][1]);
        g.beginPath(); g.arc(a, b, 4, 0, 7); g.fill(); g.stroke();
      });
    }
  }

  private bbox(list: Iterable<Corner> = this.sel): { a: number; b: number; c: number; d: number } | null {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const k of list) {
      const [f, i] = parse(k);
      const u = ed.model.faces[f]?.uv[i];
      if (!u) continue;
      a = Math.min(a, u[0]); b = Math.min(b, u[1]); c = Math.max(c, u[0]); d = Math.max(d, u[1]);
    }
    return Number.isFinite(a) ? { a, b, c, d } : null;
  }

  /** Screen positions of the selection's transform handles, or null if it's too small to need them. */
  private handleLayout() {
    if (this.sel.size < 2) return null;
    const box = this.bbox();
    if (!box) return null;
    const [x0, y0] = this.toScreen(box.a, box.b);
    const [x1, y1] = this.toScreen(box.c, box.d);
    if (x1 - x0 < 6 && y1 - y0 < 6) return null;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    return {
      box, x0, y0, x1, y1, cx, cy, rot: { x: cx, y: y0 - 22 },
      handles: HANDLES.map((h0) => ({ ...h0, x: cx + (h0.ax * (x1 - x0)) / 2, y: cy + (h0.ay * (y1 - y0)) / 2 })),
    };
  }

  private drawHandles() {
    const l = this.handleLayout();
    if (!l) return;
    const g = this.g;
    g.strokeStyle = SEL; g.lineWidth = 1; g.setLineDash([4, 3]);
    g.strokeRect(l.x0 + 0.5, l.y0 + 0.5, l.x1 - l.x0, l.y1 - l.y0);
    g.setLineDash([]);
    g.beginPath(); g.moveTo(l.cx, l.y0); g.lineTo(l.rot.x, l.rot.y); g.stroke();
    g.fillStyle = '#1b1e22'; g.lineWidth = 1.5;
    g.beginPath(); g.arc(l.rot.x, l.rot.y, 5, 0, 7); g.fill(); g.stroke();
    for (const p of l.handles) {
      g.fillStyle = SEL;
      g.fillRect(p.x - 3.5, p.y - 3.5, 7, 7);
      g.strokeStyle = '#111'; g.lineWidth = 1; g.strokeRect(p.x - 3.5, p.y - 3.5, 7, 7);
    }
  }

  private updateReadout(shown: number[], a: Analysis) {
    const m = ed.model;
    if (!shown.length) { this.readout.replaceChildren(''); return; }
    const size = this.densitySize();
    const parts: (string | HTMLElement)[] = [
      `${shown.length.toLocaleString()} faces`,
      `${a.islands.length} island${a.islands.length === 1 ? '' : 's'}`,
      `${Math.round(uvUsage(m, shown) * 100)}% used`,
      `${Math.round(texelDensity(m, shown, size)).toLocaleString()} px/m at ${size}`,
    ];
    const warn = (t: string) => h('span', { class: 'uv-warn' }, t);
    if (a.overlap.size) parts.push(warn(`${a.overlap.size} overlapping`));
    if (a.outside) parts.push(warn(`${a.outside} outside 0-1`));
    this.readout.replaceChildren(...parts.flatMap((p, i) => (i ? [' · ', p] : [p])));
    this.readout.title = this.readout.textContent ?? '';
  }

  private pattern(): CanvasPattern {
    if (this.checker) return this.checker;
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const x = c.getContext('2d')!;
    x.fillStyle = '#2c3036'; x.fillRect(0, 0, 32, 32);
    x.fillStyle = '#34393f'; x.fillRect(0, 0, 16, 16); x.fillRect(16, 16, 16, 16);
    return (this.checker = this.g.createPattern(c, 'repeat')!);
  }

  // ---------- 3D link ----------
  /** Show the viewport which mesh vertices the UV selection and cursor refer to. */
  private syncViewportOverlay() {
    const vp = app.vp;
    if (!vp) return;
    const verts = new Set<number>();
    this.sel.forEach((k) => { const [f, c] = parse(k); const v = ed.model.faces[f]?.v[c]; if (v !== undefined) verts.add(v); });
    let hover: number | null = null;
    if (this.mouse.inside && !this.drag) {
      const near = this.nearest(this.mouse.x, this.mouse.y);
      if (near) { const [f, c] = parse(near); hover = ed.model.faces[f].v[c]; }
    }
    vp.setUVOverlay(verts, hover);
  }

  // ---------- picking ----------
  private nearest(x: number, y: number, r = 8): Corner | null {
    const m = ed.model;
    let best: Corner | null = null, bd = r;
    for (const fi of this.shownFaces()) {
      m.faces[fi].uv.forEach((u, c) => {
        const [a, b] = this.toScreen(u[0], u[1]);
        const d = Math.hypot(a - x, b - y);
        if (d < bd) { bd = d; best = ck(fi, c); }
      });
    }
    return best;
  }

  private nearestEdge(x: number, y: number, r = 7): [number, number] | null {
    const m = ed.model;
    let best: [number, number] | null = null, bd = r;
    for (const fi of this.shownFaces()) {
      const uv = m.faces[fi].uv;
      for (let i = 0; i < uv.length; i++) {
        const [ax, ay] = this.toScreen(uv[i][0], uv[i][1]);
        const [bx, by] = this.toScreen(uv[(i + 1) % uv.length][0], uv[(i + 1) % uv.length][1]);
        const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
        const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
        const d = Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
        if (d < bd) { bd = d; best = [fi, i]; }
      }
    }
    return best;
  }

  private faceAt(x: number, y: number): number | null {
    const m = ed.model;
    const shown = this.shownFaces();
    for (let n = shown.length - 1; n >= 0; n--) {
      const fi = shown[n];
      const uv = m.faces[fi].uv.map((u) => this.toScreen(u[0], u[1]));
      let inside = false;
      for (let i = 0, j = uv.length - 1; i < uv.length; j = i++) {
        if ((uv[i][1] > y) !== (uv[j][1] > y) && x < ((uv[j][0] - uv[i][0]) * (y - uv[i][1])) / (uv[j][1] - uv[i][1]) + uv[i][0]) inside = !inside;
      }
      if (inside) return fi;
    }
    return null;
  }

  /** Add a corner, plus every corner stacked on the same UV point of the same vertex. */
  private addWelded(k: Corner, set = this.sel) {
    if (!this.sticky) { set.add(k); return; }
    const m = ed.model;
    const [f, c] = parse(k);
    const vert = m.faces[f].v[c];
    const u = m.faces[f].uv[c];
    for (const fi of this.shownFaces()) {
      m.faces[fi].v.forEach((v, i) => {
        if (v !== vert) return;
        const o = m.faces[fi].uv[i];
        if (Math.abs(o[0] - u[0]) < 1e-5 && Math.abs(o[1] - u[1]) < 1e-5) set.add(ck(fi, i));
      });
    }
  }

  private islandOf(fi: number): number[] {
    return this.analysis().islands.find((isl) => isl.includes(fi)) ?? [fi];
  }

  private selectIsland(fi: number, remove = false) {
    for (const f of this.islandOf(fi)) ed.model.faces[f].v.forEach((_, i) => { if (remove) this.sel.delete(ck(f, i)); else this.sel.add(ck(f, i)); });
  }

  /** The corners a click at this point would select in the current mode. */
  private pickCorners(x: number, y: number): Corner[] {
    const m = ed.model;
    const welded = (k: Corner) => { const s = new Set<Corner>(); this.addWelded(k, s); return [...s]; };
    switch (this.mode) {
      case 'vertex': { const k = this.nearest(x, y); return k ? welded(k) : []; }
      case 'edge': {
        const e = this.nearestEdge(x, y);
        if (!e) return [];
        const [fi, i] = e;
        return [...welded(ck(fi, i)), ...welded(ck(fi, (i + 1) % m.faces[fi].v.length))];
      }
      case 'face': {
        const fi = this.faceAt(x, y);
        return fi === null ? [] : m.faces[fi].v.map((_, i) => ck(fi, i));
      }
      default: {
        const near = this.nearest(x, y);
        const fi = near ? parse(near)[0] : this.faceAt(x, y);
        return fi === null ? [] : this.islandOf(fi).flatMap((f) => m.faces[f].v.map((_, i) => ck(f, i)));
      }
    }
  }

  private boxSelect(lo: number[], hi: number[], sub: boolean) {
    const m = ed.model;
    const inBox = (u: V2) => { const [a, b] = this.toScreen(u[0], u[1]); return a >= lo[0] && a <= hi[0] && b >= lo[1] && b <= hi[1]; };
    const take = (k: Corner) => { if (sub) this.sel.delete(k); else this.sel.add(k); };
    for (const fi of this.shownFaces()) {
      const f = m.faces[fi];
      if (this.mode === 'vertex') f.uv.forEach((u, c) => { if (inBox(u)) take(ck(fi, c)); });
      else if (this.mode === 'edge') {
        f.uv.forEach((u, c) => {
          const j = (c + 1) % f.uv.length;
          if (inBox(u) && inBox(f.uv[j])) { take(ck(fi, c)); take(ck(fi, j)); }
        });
      } else if (this.mode === 'face') {
        const cx = f.uv.reduce((s, u) => s + u[0], 0) / f.uv.length, cy = f.uv.reduce((s, u) => s + u[1], 0) / f.uv.length;
        if (inBox([cx, cy])) f.uv.forEach((_, c) => take(ck(fi, c)));
      } else if (f.uv.some(inBox)) this.selectIsland(fi, sub);
    }
  }

  // ---------- actions used by commands ----------
  /** The selected corners, or every shown corner when nothing is selected. */
  private targetCorners(): Corner[] {
    if (this.sel.size) return [...this.sel];
    const out: Corner[] = [];
    for (const fi of this.shownFaces()) ed.model.faces[fi].uv.forEach((_, i) => out.push(ck(fi, i)));
    return out;
  }

  /** Mesh edges for the UV edges selected here. */
  selectedEdges(): string[] {
    if (this.mode === 'vertex' && this.sel.size < 2) return [];
    const m = ed.model;
    const out = new Set<string>();
    this.sel.forEach((k) => {
      const [f, c] = parse(k);
      const face = m.faces[f];
      if (!face) return;
      const j = (c + 1) % face.v.length;
      if (this.sel.has(ck(f, j))) out.add(edgeKey(face.v[c], face.v[j]));
    });
    return [...out];
  }

  private forTargets(label: string, fn: (u: V2, box: { a: number; b: number; c: number; d: number }) => void) {
    const list = this.targetCorners();
    const box = this.bbox(list);
    if (!box) return;
    ed.transact(label, (m) => { for (const k of list) { const [f, i] = parse(k); fn(m.faces[f].uv[i], box); } });
    this.draw();
  }

  flip(axis: 0 | 1) { this.forTargets(axis ? 'Flip V' : 'Flip U', (u, b) => { u[axis] = (axis ? b.b + b.d : b.a + b.c) - u[axis]; }); }

  rot90() {
    this.forTargets('Rotate UVs', (u, b) => {
      const cx = (b.a + b.c) / 2, cy = (b.b + b.d) / 2, x = u[0] - cx, y = u[1] - cy;
      u[0] = cx - y; u[1] = cy + x;
    });
  }

  align(side: 'left' | 'right' | 'top' | 'bottom') {
    if (this.sel.size < 2) { toast('Select two or more UV points to align.', 'info'); return; }
    this.forTargets(`Align ${side}`, (u, b) => {
      if (side === 'left') u[0] = b.a;
      else if (side === 'right') u[0] = b.c;
      else if (side === 'top') u[1] = b.b;
      else u[1] = b.d;
    });
  }

  weld() {
    if (this.sel.size < 2) { toast('Select two or more UV points to weld.', 'info'); return; }
    const m = ed.model;
    let x = 0, y = 0;
    this.sel.forEach((k) => { const [f, i] = parse(k); x += m.faces[f].uv[i][0]; y += m.faces[f].uv[i][1]; });
    x /= this.sel.size; y /= this.sel.size;
    const list = [...this.sel];
    ed.transact('Weld UVs', (mm) => { for (const k of list) { const [f, i] = parse(k); mm.faces[f].uv[i] = [x, y]; } });
  }

  stitch() {
    const selected = new Set([...this.sel].map((k) => parse(k)[0]));
    if (!selected.size) { toast('Select an island first. Its neighbour moves to join it.', 'info'); return; }
    const shown = this.shownFaces();
    let ok = false;
    ed.transact('Stitch UVs', (m) => { ok = stitchIslands(m, shown, selected); });
    if (!ok) toast('This island shares no mesh edge with another shown island.', 'info');
  }

  relax() {
    const list = this.targetCorners();
    const shown = this.shownFaces();
    ed.transact('Relax UVs', (m) => relaxUV(m, shown, list.map(parse), 10));
  }

  pin(on: boolean) {
    if (!this.sel.size) { toast('Select UV points first.', 'info'); return; }
    const list = [...this.sel].map(parse);
    ed.transact(on ? 'Pin UVs' : 'Unpin UVs', (m) => setPins(m, list, on));
  }

  /** Faces with a selected corner, or everything shown when nothing is selected. */
  selectedOrShownFaces(): number[] {
    if (!this.sel.size) return this.shownFaces();
    const picked = new Set([...this.sel].map((k) => parse(k)[0]));
    // Whole islands, since relaxing or straightening part of one would tear it.
    return this.analysis().islands.filter((isl) => isl.some((f) => picked.has(f))).flat();
  }

  selectOverlaps() {
    const over = this.analysis().overlap;
    this.sel.clear();
    over.forEach((f) => ed.model.faces[f].v.forEach((_, c) => this.sel.add(ck(f, c))));
    this.setMode('face');
    this.afterSelect();
    if (!over.size) toast('Nothing overlaps.', 'ok');
  }

  selectAll() { this.sel.clear(); for (const fi of this.shownFaces()) ed.model.faces[fi].uv.forEach((_, i) => this.sel.add(ck(fi, i))); this.afterSelect(); }
  selectNone() { this.sel.clear(); this.afterSelect(); }
  private afterSelect() { this.draw(); this.renderFields(); }

  frameAll() { this.frameCorners(this.shownFaces().flatMap((fi) => ed.model.faces[fi].uv.map((_, i) => ck(fi, i)))); }
  frameSelected() { this.frameCorners(this.sel.size ? [...this.sel] : this.shownFaces().flatMap((fi) => ed.model.faces[fi].uv.map((_, i) => ck(fi, i)))); }

  private frameCorners(list: Corner[]) {
    const box = this.bbox(list);
    // Always keep the 0-1 tile in the frame unless looking at a selection.
    const b = list.length && list.length < this.shownFaces().length ? box : box && { a: Math.min(0, box.a), b: Math.min(0, box.b), c: Math.max(1, box.c), d: Math.max(1, box.d) };
    if (!b) { this.zoom = 0.85; this.panX = this.panY = 0; this.draw(); return; }
    const span = Math.max(b.c - b.a, b.d - b.b, 0.02);
    this.zoom = Math.max(0.1, Math.min(40, 0.88 / span));
    const s = this.size();
    this.panX = -((b.a + b.c) / 2 - 0.5) * s;
    this.panY = -((b.b + b.d) / 2 - 0.5) * s;
    this.draw();
  }

  /** A transparent PNG of the layout's wireframe, for painting textures over. */
  layoutPNG(size: number): Promise<Uint8Array> {
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    g.strokeStyle = '#ffffff';
    g.lineWidth = Math.max(1, size / 1024);
    g.lineJoin = 'round';
    g.beginPath();
    for (const fi of this.shownFaces()) {
      ed.model.faces[fi].uv.forEach((u, i) => { if (i) g.lineTo(u[0] * size, u[1] * size); else g.moveTo(u[0] * size, u[1] * size); });
      g.closePath();
    }
    g.stroke();
    return new Promise((resolve, reject) => {
      c.toBlob((b) => { if (b) void b.arrayBuffer().then((a) => resolve(new Uint8Array(a))); else reject(new Error('Could not encode the image.')); }, 'image/png');
    });
  }

  // ---------- numeric fields ----------
  private renderFields() {
    renderInto(this.fields, () => {
      const box = this.bbox();
      if (!box) return h('span', { class: 'muted small' }, 'Select UVs to edit numerically');
      const field = (label: string, value: number, title: string, min: number | undefined, apply: (o: V2, b: NonNullable<typeof box>, v: number) => V2) => {
        let orig: Map<Corner, V2> | null = null;
        let base = box;
        const capture = () => {
          orig = new Map();
          for (const k of this.sel) { const [f, i] = parse(k); const u = ed.model.faces[f].uv[i]; orig.set(k, [u[0], u[1]]); }
          base = this.bbox() ?? box;
        };
        const set = (v: number) => {
          orig!.forEach((o, k) => { const [f, i] = parse(k); ed.model.faces[f].uv[i] = apply(o, base, v); });
          ed.emit('topology');
        };
        return numField({
          label, value, step: 0.002, min, digits: 3, title,
          onScrubStart: () => { capture(); ed.begin(`UV ${label}`); },
          onInput: set,
          onScrubEnd: () => { ed.commit(); ed.emitAll(); },
          onChange: (v) => { capture(); ed.begin(`UV ${label}`); set(v); ed.commit(); ed.emitAll(); },
        });
      };
      const cx = (b: typeof box) => (b.a + b.c) / 2, cy = (b: typeof box) => (b.b + b.d) / 2;
      return [
        field('U', cx(box), 'Horizontal centre of the selection', undefined, (o, b, v) => [o[0] + v - cx(b), o[1]]),
        field('V', cy(box), 'Vertical centre of the selection', undefined, (o, b, v) => [o[0], o[1] + v - cy(b)]),
        field('W', box.c - box.a, 'Width of the selection', 0, (o, b, v) => [cx(b) + (o[0] - cx(b)) * (v / Math.max(b.c - b.a, 1e-9)), o[1]]),
        field('H', box.d - box.b, 'Height of the selection', 0, (o, b, v) => [o[0], cy(b) + (o[1] - cy(b)) * (v / Math.max(b.d - b.b, 1e-9))]),
      ];
    });
  }

  // ---------- input ----------
  private bind() {
    const cv = this.cv;
    const pos = (e: MouseEvent) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    // The editor takes keys while the mouse is over it, so viewport shortcuts are unaffected elsewhere.
    cv.addEventListener('pointerenter', () => {
      const a = document.activeElement as HTMLElement | null;
      if (a?.tagName !== 'INPUT' && a?.tagName !== 'TEXTAREA' && !document.querySelector('.modal-back, .palette-back')) cv.focus({ preventScroll: true });
    });
    cv.addEventListener('pointerleave', () => {
      this.mouse.inside = false;
      if (!this.drag && document.activeElement === cv) cv.blur();
      this.draw();
    });
    cv.addEventListener('keydown', (e) => this.onKey(e));
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = pos(e);
      const before = this.toUV(x, y);
      this.zoom = Math.max(0.1, Math.min(40, this.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      const [ax, ay] = this.toScreen(before[0], before[1]);
      this.panX += x - ax; this.panY += y - ay;
      this.draw();
    }, { passive: false });
    cv.addEventListener('dblclick', (e) => {
      const { x, y } = pos(e);
      const near = this.nearest(x, y, 14);
      const fi = near ? parse(near)[0] : this.faceAt(x, y);
      if (fi === null) return;
      if (!e.shiftKey) this.sel.clear();
      this.selectIsland(fi);
      this.afterSelect();
    });
    cv.addEventListener('pointerdown', (e) => {
      cv.focus({ preventScroll: true });
      const { x, y } = pos(e);
      if (e.button === 2 && this.drag?.kind === 'xf') { this.cancelDrag(); return; }
      if (e.button === 1 || e.button === 2 || e.altKey) { this.drag = { kind: 'pan', x, y }; return; }
      if (e.button !== 0) return;
      const add = e.shiftKey, sub = e.ctrlKey;
      if (!add && !sub) {
        const l = this.handleLayout();
        if (l) {
          if (Math.hypot(x - l.rot.x, y - l.rot.y) < 9) { this.startXf(x, y, 'rotate'); return; }
          for (const p of l.handles) {
            if (Math.abs(x - p.x) < 7 && Math.abs(y - p.y) < 7) { this.startXf(x, y, 'scale', p.ax, p.ay); return; }
          }
        }
      }
      const hit = this.pickCorners(x, y);
      if (hit.length && !add && !sub) {
        if (!hit.every((k) => this.sel.has(k))) {
          this.sel.clear();
          hit.forEach((k) => this.sel.add(k));
          this.afterSelect();
        }
        this.startXf(x, y, 'move');
        return;
      }
      // Dragging inside the selection's box moves it, even from a gap between faces.
      const inner = this.handleLayout();
      if (inner && !add && !sub && !hit.length && x > inner.x0 && x < inner.x1 && y > inner.y0 && y < inner.y1) { this.startXf(x, y, 'move'); return; }
      this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y, add, sub };
    });
    window.addEventListener('pointermove', (e) => {
      const { x, y } = pos(e);
      const d = this.drag;
      if (!d) {
        if (e.target === cv) { this.mouse = { x, y, inside: true }; this.draw(); }
        return;
      }
      if (d.kind === 'pan') { this.panX += x - d.x; this.panY += y - d.y; d.x = x; d.y = y; }
      else if (d.kind === 'box') { d.x1 = x; d.y1 = y; }
      else this.applyXf(d, x, y, e);
      this.draw();
    });
    const end = () => {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      if (d.kind === 'box') {
        const lo = [Math.min(d.x0, d.x1), Math.min(d.y0, d.y1)], hi = [Math.max(d.x0, d.x1), Math.max(d.y0, d.y1)];
        if (!d.add && !d.sub) this.sel.clear();
        this.boxSelect(lo, hi, d.sub);
        this.afterSelect();
      } else if (d.kind === 'xf' && d.moved) {
        // With Live Unwrap, the island re-solves around the pinned points just moved, as part of the same edit.
        if (this.live) liveUnwrap(ed.model, this.shownFaces());
        ed.commit();
        status('');
        ed.emitAll();
      }
      this.draw();
    };
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  private cancelDrag() {
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'xf' && d.moved) ed.cancel();
    status('');
    this.draw();
  }

  private onKey(e: KeyboardEvent) {
    const key = e.key.toLowerCase();
    let handled = true;
    if (e.ctrlKey && key === 'a') this.selectAll();
    else if (e.ctrlKey && key === 'd') this.selectNone();
    else if (e.ctrlKey || e.altKey) handled = false;
    else if (key === 'escape') { if (this.drag) this.cancelDrag(); else this.selectNone(); }
    else if (key === '1') this.setMode('vertex');
    else if (key === '2') this.setMode('edge');
    else if (key === '3') this.setMode('face');
    else if (key === '4') this.setMode('island');
    else if (key === 'a') this.frameAll();
    else if (key === 'f' || key === 'z') this.frameSelected();
    else if (key === 'home') this.frameAll();
    else if (key === 'l') {
      const near = this.nearest(this.mouse.x, this.mouse.y, 14);
      const fi = near ? parse(near)[0] : this.faceAt(this.mouse.x, this.mouse.y);
      if (fi !== null) { this.selectIsland(fi); this.afterSelect(); }
    }
    else if (key === 'p') runCommand('uv.pack');
    else if (key === 'n') this.pin(true);
    else if (key === 'm') runCommand('uv.minimize');
    else if (key === 'w') this.weld();
    else if (key === 's') runCommand('uv.stitch');
    else if (key === 'r') this.rot90();
    else if (key === 'x') this.flip(0);
    else if (key === 'y') this.flip(1);
    else handled = false; // U, undo and the rest stay with the app.
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  private startXf(x: number, y: number, op: XfDrag['op'], ax = 0, ay = 0) {
    const orig = new Map<Corner, V2>();
    this.sel.forEach((k) => {
      const [f, i] = parse(k);
      const u = ed.model.faces[f].uv[i];
      orig.set(k, [u[0], u[1]]);
    });
    const b = this.bbox() ?? { a: 0, b: 0, c: 0, d: 0 };
    const center: V2 = [(b.a + b.c) / 2, (b.b + b.d) / 2];
    // Scale from the side opposite the handle.
    const pivot: V2 = [center[0] - (ax * (b.c - b.a)) / 2, center[1] - (ay * (b.d - b.b)) / 2];
    const grab: V2 = [center[0] + (ax * (b.c - b.a)) / 2, center[1] + (ay * (b.d - b.b)) / 2];
    this.drag = { kind: 'xf', op, x0: x, y0: y, moved: false, center, orig, ax, ay, pivot, grab };
  }

  private applyXf(d: XfDrag, x: number, y: number, e: PointerEvent) {
    // An edit starts only once something moves, so a plain click leaves no undo step.
    if (!d.moved) {
      if (Math.hypot(x - d.x0, y - d.y0) < 2) return;
      d.moved = true;
      ed.begin(`UV ${d.op}`);
    }
    const s = this.size();
    const snapping = e.ctrlKey !== this.snap;
    const m = ed.model;
    if (d.op === 'move') {
      let du = (x - d.x0) / s, dv = (y - d.y0) / s;
      if (e.shiftKey) { if (Math.abs(du) > Math.abs(dv)) dv = 0; else du = 0; }
      if (snapping) { du = Math.round(du * this.grid) / this.grid; dv = Math.round(dv * this.grid) / this.grid; }
      d.orig.forEach((o, k) => { const [f, i] = parse(k); m.faces[f].uv[i] = [o[0] + du, o[1] + dv]; });
      status(`Move  U ${du.toFixed(3)}  V ${dv.toFixed(3)}   (Shift: one axis, Ctrl: ${this.snap ? 'free' : 'snap'})`);
    } else if (d.op === 'rotate') {
      const [cx, cy] = this.toScreen(d.center[0], d.center[1]);
      let a = Math.atan2(y - cy, x - cx) - Math.atan2(d.y0 - cy, d.x0 - cx);
      if (snapping) { const st = Math.PI / 12; a = Math.round(a / st) * st; }
      const cos = Math.cos(a), sin = Math.sin(a);
      d.orig.forEach((o, k) => {
        const [f, i] = parse(k);
        const px = o[0] - d.center[0], py = o[1] - d.center[1];
        m.faces[f].uv[i] = [d.center[0] + px * cos - py * sin, d.center[1] + px * sin + py * cos];
      });
      status(`Rotate  ${((a * 180) / Math.PI).toFixed(1)}°   (Ctrl: ${this.snap ? 'free' : '15° steps'})`);
    } else {
      const cur = this.toUV(x, y);
      const ratio = (axis: 0 | 1) => {
        const span = d.grab[axis] - d.pivot[axis];
        return Math.abs(span) > 1e-9 ? (cur[axis] - d.pivot[axis]) / span : 1;
      };
      let sx = d.ax ? ratio(0) : 1, sy = d.ay ? ratio(1) : 1;
      // Corners keep the aspect unless Shift frees it.
      if (d.ax && d.ay && !e.shiftKey) { const k = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = sy = k; }
      if (snapping) { sx = Math.round(sx * 10) / 10; sy = Math.round(sy * 10) / 10; }
      d.orig.forEach((o, k) => {
        const [f, i] = parse(k);
        m.faces[f].uv[i] = [d.pivot[0] + (o[0] - d.pivot[0]) * sx, d.pivot[1] + (o[1] - d.pivot[1]) * sy];
      });
      status(`Scale  ${sx.toFixed(3)} x ${sy.toFixed(3)}   (Shift on a corner: free aspect)`);
    }
    // UVs share no render state with positions, but the mesh buffers cache them.
    ed.emit('topology');
  }
}
