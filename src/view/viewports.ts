// The stage: layout of viewport panes, the render loop, the 2D overlay, and all pointer input.
import * as THREE from 'three';
import { ed, type SelMode, type ToolId } from '../core/editor';
import { KnifeTool, LoopTool, type CutHost } from './cutTools';
import { bounds, dist as dist3, edgeKey, faceNormal, norm, parseEdge } from '../core/geom';
import * as ops from '../core/ops';
import * as prims from '../core/primitives';
import { ensureTrack, mirrorMaps, paintWeight, qAxisAngle, qConj, qMul, qNorm, qRotate, sampleTrack, setKey, smoothVertexWeight, vertexNeighbors } from '../core/skeleton';
import { ikChain, solveIK } from '../core/anim';
import { limbFrame, mirrorPiece, scaleFigure } from '../core/blockout';
import { lathe, partPrim, PARTS, silhouette, tube } from '../core/organic';
import { evalPose, keyFrames, skinInto } from '../core/skeleton';
import { uniqueName, type Bone, type Q, type RefImage, type V3 } from '../core/types';
import { seamEdges } from '../core/uv';
import { Pane, VIEW_LABELS, viewBasis, type ViewKind } from './pane';
import * as pick from './picking';
import { SceneGraph, type Shading } from './scene';
import { h, ICONS, svgIcon } from '../ui/dom';
import { status, toast } from '../ui/feedback';

const AXIS = ['#e8555a', '#7bc043', '#4a90e2'];
const AXIS_DIR: V3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const SEL = '#f2b24c';
const GIZMO = 80; // pixels
const VIEWPORT_KEY = 'thickshake.viewports';

type Drag =
  | { kind: 'orbit' | 'bank' | 'pan' | 'panGround' | 'panVertical' | 'zoom'; pane: Pane; x: number; y: number }
  | { kind: 'box'; pane: Pane; x0: number; y0: number; x1: number; y1: number; add: boolean; sub: boolean }
  | { kind: 'transform'; pane: Pane; handle: Handle; x0: number; y0: number; mode: 'move' | 'rotate' | 'scale'; center: THREE.Vector3; orig: Map<number, V3>; mirror: Map<number, number>; boneOrig?: Map<number, V3>; boneMirror?: Map<number, number>; poseBase?: PoseBase; startAngle?: number }
  | { kind: 'extrude'; pane: Pane; x0: number; y0: number; verts: Map<number, V3>; normals: Map<number, V3>; center: THREE.Vector3; axis: THREE.Vector3 }
  | { kind: 'prim'; pane: Pane; s: PrimSession; x0: number; y0: number; made: boolean }
  | { kind: 'primResize'; pane: Pane; s: PrimSession; x0: number; y0: number; min0: Vec3; max0: Vec3; move: boolean; made: boolean; axes: { i: number; sx: number; sy: number; side: -1 | 0 | 1 }[] }
  | { kind: 'freehand'; pane: Pane; tool: 'stroke' | 'blob' | 'lathe'; origin: THREE.Vector3; points: THREE.Vector3[]; screen: [number, number][] }
  | { kind: 'sculpt'; pane: Pane; x0: number; y0: number; grabbed: { v: number; w: number }[]; orig: Map<number, V3>; at: THREE.Vector3; neighbors: Map<number, Set<number>>; mirror: Map<number, number> | null; moved: boolean }
  | { kind: 'ref'; pane: Pane; id: number; x0: number; y0: number; ox: number; oy: number; size0: number; corner: { sx: number; sy: number; ax: number; ay: number; span: number } | null }
  | { kind: 'ik'; pane: Pane; bone: number; frame: number; keep?: Q; base: Map<number, Q> }
  | { kind: 'paint'; pane: Pane; neighbors: Map<number, Set<number>>; mirror: ReturnType<typeof mirrorMaps> | null };

type Handle = { type: 'axis' | 'plane' | 'ring' | 'center' | 'view'; axis: number };
type Vec3 = [number, number, number];

/**
 * A primitive being drawn. Its extents live in a local frame whose Y is the primitive's major axis:
 * the view direction in orthographic views, the ground normal in perspective, the face normal on a surface.
 * Every adjustment is its own undo step, so no edit stays open while the tool waits for input.
 */
interface PrimSession {
  tool: string;
  origin: THREE.Vector3;
  axes: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  min: Vec3;
  max: Vec3;
  flatUntilDepth: boolean; // Drawn in an orthographic view: depth comes from a drag in another view.
  ground: boolean;
  groupId: number | null;
  pendingGroup: number | null;
  baseV: number;
  baseF: number;
  steps: number;
  open: boolean;
}

interface PoseBase { bones: { id: number; rot: [number, number, number, number]; pos: V3; parentRot: [number, number, number, number] }[]; center: THREE.Vector3 }

export class Viewports {
  el: HTMLElement;
  gl: HTMLCanvasElement;
  ov: HTMLCanvasElement;
  g2: CanvasRenderingContext2D;
  sg: SceneGraph;
  panes: Pane[];
  layout: 'quad' | 'single' = 'quad';
  active: Pane;
  splitX = 0.5;
  splitY = 0.5;
  linked = true;
  private session: PrimSession | null = null;
  private sessionWriting = false;
  private rightPress: { x: number; y: number } | null = null;
  private uvSelected = new Set<number>();
  private uvHover: number | null = null;
  private singlePane: Pane;
  private dirty = true;
  private drag: Drag | null = null;
  private cutHost: CutHost = { sg: null as unknown as SceneGraph, invalidate: () => this.invalidate(), finishOneShot: () => this.finishOneShot() };
  readonly knife = new KnifeTool(this.cutHost);
  readonly loopTool = new LoopTool(this.cutHost);
  private oneShotFrom: ToolId | null = null;
  private hover: Handle | null = null;
  private mouse = { x: 0, y: 0, inside: false };
  private facePending: number[] = [];
  private cssW = 0; private cssH = 0;
  private headers: HTMLElement;
  private splitters: HTMLElement[] = [];
  fps = 0;
  private frames = 0; private lastFps = performance.now();
  onFrame: (dt: number) => void = () => {};
  private lastT = performance.now();

  constructor(host: HTMLElement) {
    this.gl = h('canvas', { class: 'stage-gl' }) as HTMLCanvasElement;
    this.ov = h('canvas', { class: 'stage-ov', tabindex: '0' }) as HTMLCanvasElement;
    this.headers = h('div', { class: 'stage-headers' });
    this.el = h('div', { class: 'stage' }, this.gl, this.ov, this.headers);
    host.appendChild(this.el);
    this.g2 = this.ov.getContext('2d')!;
    this.sg = new SceneGraph(this.gl);
    this.sg.onDirty = () => this.invalidate();

    this.panes = [
      new Pane('top', 'wire'), new Pane('persp', 'pbr'),
      new Pane('front', 'wire'), new Pane('right', 'wire'),
    ];
    this.active = this.panes[1];
    this.singlePane = this.panes[1];

    this.panes.forEach((p) => this.buildHeader(p));
    this.buildSplitters();
    this.cutHost.sg = this.sg;

    new ResizeObserver(() => this.resize()).observe(this.el);
    this.bindInput();
    ed.on(['selection', 'tool', 'time', 'anim', 'skeleton', 'view', 'geometry', 'topology'], () => this.invalidate());
    ed.on('tool', () => {
      this.facePending = [];
      this.updateCursor();
      if (this.session && ed.tool !== this.session.tool) this.dropPrim();
      if (ed.tool !== 'knife') { this.knife.reset(); this.knife.selectedOnly = false; } else this.knife.hint();
      if (ed.tool !== 'loopcut') { this.loopTool.abort(); this.loopTool.clearHover(); } else this.loopTool.hint();
      if (ed.tool !== 'knife' && ed.tool !== 'loopcut') this.oneShotFrom = null;
    });
    ed.on(['anim', 'history', 'topology', 'skeleton'], () => this.clearAnimCaches());
    // Any other edit, undo or file load ends the drawing session: its vertex ranges are no longer ours.
    ed.on('history', () => {
      if (!this.sessionWriting) this.session = null;
      this.knife.reset();
    });
    // The shape changed, so the loop being previewed may no longer be right.
    ed.on(['history', 'topology'], () => this.loopTool.clearHover());
    window.addEventListener('keyup', (e) => { if (ed.tool === 'knife' && (e.key === 'Control' || e.key === 'Shift')) this.knife.modifiers(e); });
    requestAnimationFrame(this.loop);
  }

  invalidate() { this.dirty = true; }

  private buildHeader(p: Pane) {
    const viewSel = h('select', { class: 'pane-select', title: 'Change view', onchange: (e: Event) => { p.setKind((e.target as HTMLSelectElement).value as ViewKind); this.joinLink(p); this.syncHeaders(); this.invalidate(); } },
      ...(Object.keys(VIEW_LABELS) as ViewKind[]).map((k) => h('option', { value: k, selected: k === p.kind }, VIEW_LABELS[k])));
    const shadeSel = h('select', { class: 'pane-select', title: 'Shading', onchange: (e: Event) => { p.shading = (e.target as HTMLSelectElement).value as Shading; this.invalidate(); } },
      ...([['wire', 'Wireframe'], ['clay', 'Clay'], ['block', 'Blockout'], ['pbr', 'Material'], ['checker', 'UV Checker'], ['normals', 'Normals'], ['weights', 'Weights']] as [Shading, string][])
        .map(([k, l]) => h('option', { value: k, selected: k === p.shading }, l)));
    const maxBtn = h('button', { class: 'pane-btn', title: 'Maximize / restore pane (Space)', onclick: () => this.toggleMax(p), 'aria-label': 'Maximize or restore pane' }, svgIcon(ICONS.maximize, 14));
    p.header = h('div', { class: 'pane-header' }, viewSel, shadeSel, maxBtn);
    (p.header as any)._view = viewSel;
    (p.header as any)._shade = shadeSel;
    this.headers.appendChild(p.header);

    // View control drag buttons in the pane's upper-right corner, as in LightWave.
    const widget = (kind: 'pan' | 'orbit' | 'zoom', title: string, icon: string) => {
      const b = h('button', { class: 'pane-btn pane-drag', title, 'aria-label': title }, svgIcon(icon, 14)) as HTMLButtonElement;
      b.dataset.drag = kind;
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        this.ov.focus({ preventScroll: true });
        const { x, y } = this.local(e);
        this.active = p;
        this.drag = { kind: kind === 'orbit' && p.isOrtho ? 'pan' : kind, pane: p, x, y };
        this.invalidate();
      });
      return b;
    };
    const rotate = widget('orbit', 'Drag to rotate the view', ICONS.rotate);
    p.nav = h('div', { class: 'pane-header pane-nav' }, widget('pan', 'Drag to pan the view', ICONS.pan), rotate, widget('zoom', 'Drag up or right to zoom in, down or left to zoom out', ICONS.zoom));
    (p.nav as any)._rotate = rotate;
    rotate.disabled = p.isOrtho;
    this.headers.appendChild(p.nav);
  }

  syncHeaders() {
    for (const p of this.panes) {
      ((p.header as any)._view as HTMLSelectElement).value = p.kind;
      ((p.header as any)._shade as HTMLSelectElement).value = p.shading;
      ((p.nav as any)._rotate as HTMLButtonElement).disabled = p.isOrtho;
    }
  }

  // ---------- keyboard navigation ----------
  /** The pane under the mouse, or the active one when the mouse is elsewhere. */
  private keyPane(): Pane {
    return (this.mouse.inside && this.paneAt(this.mouse.x, this.mouse.y)) || this.active;
  }

  /** Pan by grid squares, or by a fixed distance when `distance` is given. */
  panKey(dx: number, dy: number, squares: number, distance?: number) {
    const p = this.keyPane();
    const step = distance ?? squares * p.gridScale();
    p.panBy(dx * step, dy * step);
    this.linkViews(p);
    this.invalidate();
  }

  zoomKey(factor: number) {
    const p = this.keyPane();
    p.zoom(factor);
    this.linkViews(p);
    this.invalidate();
  }

  /** The other views follow the one being moved: all share a centre, orthographic views share a zoom. */
  private linkViews(src: Pane) {
    if (!this.linked) return;
    for (const p of this.panes) {
      if (p === src) continue;
      p.target.copy(src.target);
      if (src.isOrtho && p.isOrtho) p.orthoHeight = src.orthoHeight;
      p.update();
    }
  }

  /** A pane that changes view joins the shared centre and zoom. */
  private joinLink(p: Pane) {
    if (!this.linked) return;
    const other = this.panes.find((q) => q !== p);
    const ortho = this.panes.find((q) => q !== p && q.isOrtho);
    if (other) p.target.copy(other.target);
    if (ortho) p.orthoHeight = ortho.orthoHeight;
    p.update();
  }

  toggleLinked() {
    this.linked = !this.linked;
    if (this.linked) this.linkViews(this.active);
    this.invalidate();
  }

  /** Centre the view on what's under the mouse. */
  centerAtMouse() {
    const p = this.keyPane();
    const { x, y } = this.mouse;
    if (!this.mouse.inside || !p.contains(x, y)) return;
    const hit = p.isOrtho ? null : pick.pickFace(p, this.sg, x, y, true);
    p.centerOn(hit ? hit.point : p.viewPlanePoint(x, y));
    this.linkViews(p);
    this.invalidate();
  }

  /** Switch the pane to a view, or to its partner if it's already showing that view. */
  cycleView(first: ViewKind, second: ViewKind = first) {
    const p = this.keyPane();
    p.setKind(p.kind === first ? second : first);
    this.joinLink(p);
    this.syncHeaders();
    this.invalidate();
  }

  levelView() {
    const p = this.keyPane();
    p.bankAngle = 0;
    p.update();
    this.invalidate();
  }

  private buildSplitters() {
    try {
      const saved = JSON.parse(localStorage.getItem(VIEWPORT_KEY) ?? 'null');
      if (typeof saved?.x === 'number') this.splitX = saved.x;
      if (typeof saved?.y === 'number') this.splitY = saved.y;
    } catch { /* Storage is only a convenience here. */ }
    const save = () => { try { localStorage.setItem(VIEWPORT_KEY, JSON.stringify({ x: this.splitX, y: this.splitY })); } catch { /* ignore */ } };
    const rect = () => this.el.getBoundingClientRect();
    const setX = (e: PointerEvent) => { this.splitX = Math.max(0.1, Math.min(0.9, (e.clientX - rect().left) / rect().width)); };
    const setY = (e: PointerEvent) => { this.splitY = Math.max(0.1, Math.min(0.9, (e.clientY - rect().top) / rect().height)); };
    const mk = (cls: string, onMove: (e: PointerEvent) => void) => {
      const s = h('div', { class: `splitter ${cls}`, title: 'Drag to resize. Double-click to reset.' });
      s.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        s.classList.add('dragging');
        const mv = (ev: PointerEvent) => { onMove(ev); this.layoutPanes(); this.invalidate(); };
        const up = () => {
          window.removeEventListener('pointermove', mv);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          s.classList.remove('dragging');
          save();
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      s.addEventListener('dblclick', () => {
        this.splitX = this.splitY = 0.5;
        save();
        this.layoutPanes();
        this.invalidate();
      });
      this.el.appendChild(s);
      this.splitters.push(s);
      return s;
    };
    mk('splitter-v', setX);
    mk('splitter-h', setY);
    mk('splitter-c', (e) => { setX(e); setY(e); });
  }

  setLayout(layout: 'quad' | 'single', pane?: Pane) {
    this.layout = layout;
    if (pane) { this.singlePane = pane; this.active = pane; }
    this.layoutPanes();
    this.invalidate();
  }

  toggleMax(p: Pane = this.active) {
    if (this.layout === 'quad') this.setLayout('single', p);
    else this.setLayout('quad');
    ed.emit('view');
  }

  visiblePanes(): Pane[] { return this.layout === 'quad' ? this.panes : [this.singlePane]; }

  resize() {
    const r = this.el.getBoundingClientRect();
    this.cssW = Math.max(1, Math.floor(r.width)); this.cssH = Math.max(1, Math.floor(r.height));
    this.sg.renderer.setSize(this.cssW, this.cssH, false);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.ov.width = this.cssW * dpr; this.ov.height = this.cssH * dpr;
    this.gl.style.width = this.ov.style.width = `${this.cssW}px`;
    this.gl.style.height = this.ov.style.height = `${this.cssH}px`;
    this.layoutPanes();
    this.invalidate();
  }

  private layoutPanes() {
    const W = this.cssW, H = this.cssH;
    const gap = 2;
    const x = Math.round(W * this.splitX), y = Math.round(H * this.splitY);
    if (this.layout === 'quad') {
      const [a, b, c, d] = this.panes;
      Object.assign(a, { x: 0, y: 0, w: x - gap / 2, h: y - gap / 2 });
      Object.assign(b, { x: x + gap / 2, y: 0, w: W - x - gap / 2, h: y - gap / 2 });
      Object.assign(c, { x: 0, y: y + gap / 2, w: x - gap / 2, h: H - y - gap / 2 });
      Object.assign(d, { x: x + gap / 2, y: y + gap / 2, w: W - x - gap / 2, h: H - y - gap / 2 });
    } else Object.assign(this.singlePane, { x: 0, y: 0, w: W, h: H });
    const vis = this.visiblePanes();
    for (const p of this.panes) {
      p.update();
      const hdr = p.header!;
      hdr.style.display = vis.includes(p) ? 'flex' : 'none';
      hdr.style.left = `${p.x + 6}px`;
      hdr.style.top = `${p.y + 6}px`;
      const nav = p.nav!;
      nav.style.display = hdr.style.display;
      nav.style.right = `${W - (p.x + p.w) + 6}px`;
      // In a narrow pane the view buttons drop below the menus rather than sit on top of them.
      nav.style.top = `${p.y + (p.w < 340 ? 30 : 6)}px`;
    }
    const [sv, sh, sc] = this.splitters;
    sv.style.display = sh.style.display = sc.style.display = this.layout === 'quad' ? 'block' : 'none';
    sv.style.left = `${x - 3}px`;
    sh.style.top = `${y - 3}px`;
    sc.style.left = `${x - 7}px`;
    sc.style.top = `${y - 7}px`;
  }

  // ---------- render loop ----------
  private loop = (t: number) => {
    const dt = (t - this.lastT) / 1000;
    this.lastT = t;
    this.onFrame(dt);
    if (this.dirty) {
      this.dirty = false;
      this.render();
      this.frames++;
    }
    if (t - this.lastFps > 500) { this.fps = (this.frames * 1000) / (t - this.lastFps); this.frames = 0; this.lastFps = t; }
    requestAnimationFrame(this.loop);
  };

  renderNow() { this.render(); }

  private render() {
    const r = this.sg.renderer;
    const dpr = r.getPixelRatio();
    r.setScissorTest(false);
    r.setClearColor(0x2b2f35); // The gap between panes, matching the interface's --line colour.
    r.clear();
    r.setScissorTest(true);
    for (const p of this.visiblePanes()) {
      if (p.w < 2 || p.h < 2) continue;
      p.update();
      const py = this.cssH - p.y - p.h;
      r.setViewport(p.x, py, p.w, p.h);
      r.setScissor(p.x, py, p.w, p.h);
      r.setClearColor(p.shading === 'wire' ? 0x1b1e22 : 0x24272c);
      r.clear();
      this.sg.applyShading(p.shading);
      this.sg.showRefsFor(p.kind);
      this.sg.setGrid(p.gridPlane(), p.gridScale());
      r.render(this.sg.scene, p.camera);
    }
    this.draw2D(dpr);
  }

  private draw2D(_dpr: number) {
    const g = this.g2;
    const dpr = this.ov.width / Math.max(1, this.cssW);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.cssW, this.cssH);
    for (const p of this.visiblePanes()) {
      g.save();
      g.beginPath(); g.rect(p.x, p.y, p.w, p.h); g.clip();
      if (ed.showBones && ed.model.bones.length) this.drawBones(g, p);
      if (ed.workspace === 'uv') this.drawUVLink(g, p);
      if (ed.workspace === 'block') this.drawBlockout(g, p);
      this.drawRefHandles(g, p);
      if (ed.workspace === 'animate' && ed.poseActive && ed.clip()) {
        if (ed.onion && !ed.playing) this.drawOnion(g, p);
        if (ed.trail) this.drawTrails(g, p);
      }
      this.drawPending(g, p);
      this.drawPrimHandles(g, p);
      this.drawTriad(g, p);
      const center = this.gizmoCenter();
      if (center && this.gizmoMode()) this.drawGizmo(g, p, center);
      if (this.drag?.kind === 'box' && this.drag.pane === p) {
        const d = this.drag;
        g.strokeStyle = SEL; g.fillStyle = 'rgba(242,178,76,.12)'; g.lineWidth = 1;
        g.setLineDash([4, 3]);
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), hh = Math.abs(d.y1 - d.y0);
        g.fillRect(x, y, w, hh); g.strokeRect(x + 0.5, y + 0.5, w, hh);
        g.setLineDash([]);
      }
      if ((ed.tool === 'paint' || ed.tool === 'sculpt') && this.mouse.inside && p.contains(this.mouse.x, this.mouse.y)) {
        g.strokeStyle = '#fff'; g.lineWidth = 1.2;
        g.beginPath(); g.arc(this.mouse.x, this.mouse.y, ed.tool === 'sculpt' ? ed.sculpt.radius : ed.brush.radius, 0, Math.PI * 2); g.stroke();
      }
      this.drawFreehandPreview(g, p);
      if (ed.tool === 'knife') this.knife.draw(g, p);
      if (ed.tool === 'loopcut') this.loopTool.draw(g, p);
      if (p === this.active && this.layout === 'quad') {
        g.strokeStyle = 'rgba(242,178,76,.55)'; g.lineWidth = 1;
        g.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
      }
      g.restore();
    }
  }

  private drawPending(g: CanvasRenderingContext2D, p: Pane) {
    if (ed.tool !== 'face' || !this.facePending.length) return;
    const P = ed.displayPositions();
    g.strokeStyle = SEL; g.fillStyle = SEL; g.lineWidth = 1.5;
    g.beginPath();
    this.facePending.forEach((v, i) => {
      const s = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y);
    });
    g.stroke();
    this.facePending.forEach((v) => {
      const s = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      g.beginPath(); g.arc(s.x, s.y, 4, 0, 7); g.fill();
    });
  }

  // ---------- knife and loop cut ----------
  /** Called just before K or Ctrl+R picks its tool, so the tool knows to hand back afterward. */
  startOneShot(selectedOnly: boolean) {
    if (ed.tool !== 'knife' && ed.tool !== 'loopcut') this.oneShotFrom = ed.tool;
    this.knife.selectedOnly = selectedOnly;
    this.loopTool.resetCuts();
  }

  private finishOneShot() {
    const back = this.oneShotFrom;
    this.oneShotFrom = null;
    if (back) { ed.tool = back; ed.emit('tool'); }
  }

  /** Keys for the Knife and Loop Cut, before the app's shortcuts. True if one was used. */
  toolKey(e: KeyboardEvent): boolean {
    if (ed.tool === 'knife') {
      if (this.knife.key(e)) return true;
    } else if (ed.tool === 'loopcut') {
      if (this.loopTool.key(e)) return true;
    } else return false;
    // With nothing under way, Esc or Enter from a K or Ctrl+R just hands back the tool.
    if ((e.key === 'Escape' || e.key === 'Enter') && this.oneShotFrom) { this.finishOneShot(); status(''); return true; }
    return false;
  }

  /** The group under a point in a pane, for dropping things onto a piece. */
  pieceAt(p: Pane, x: number, y: number): number | null {
    const hit = pick.pickFace(p, this.sg, x, y, true);
    return hit ? ed.model.faces[hit.face]?.g ?? null : null;
  }

  // ---------- reference images ----------
  private activeRef(): RefImage | null {
    return ed.model.refs?.find((r) => r.id === ed.refActive) ?? null;
  }

  /** The active picture's corners on screen, when it's being adjusted in this pane. */
  private refCorners(p: Pane) {
    const r = this.activeRef();
    if (!ed.refEdit || !r || p.kind !== r.view) return null;
    const { right, up } = viewBasis(r.view);
    const w = (r.size * r.width) / Math.max(1, r.height), hh = r.size;
    return ([[-1, 1], [1, 1], [1, -1], [-1, -1]] as const).map(([sx, sy]) => {
      const q = right.clone().multiplyScalar(r.x + (sx * w) / 2).addScaledVector(up, r.y + (sy * hh) / 2);
      const s = p.project(q.x, q.y, q.z);
      return { sx, sy, x: s.x, y: s.y };
    });
  }

  private drawRefHandles(g: CanvasRenderingContext2D, p: Pane) {
    const c = this.refCorners(p);
    if (!c) return;
    g.strokeStyle = SEL; g.lineWidth = 1.5;
    g.beginPath();
    c.forEach((q, i) => { if (i) g.lineTo(q.x, q.y); else g.moveTo(q.x, q.y); });
    g.closePath();
    g.stroke();
    g.fillStyle = SEL;
    for (const q of c) g.fillRect(q.x - 5, q.y - 5, 10, 10);
  }

  /** Grab the active picture: a corner scales it from the opposite corner, and anywhere inside moves it. */
  private startRefDrag(p: Pane, x: number, y: number): boolean {
    const c = this.refCorners(p);
    const r = this.activeRef();
    if (!c || !r) return false;
    const corner = c.find((q) => Math.abs(q.x - x) < 9 && Math.abs(q.y - y) < 9);
    const xs = c.map((q) => q.x), ys = c.map((q) => q.y);
    const inside = x > Math.min(...xs) && x < Math.max(...xs) && y > Math.min(...ys) && y < Math.max(...ys);
    if (!corner && !inside) return false;
    ed.begin(corner ? 'Scale reference image' : 'Move reference image');
    const opp = corner ? c.find((q) => q.sx === -corner.sx && q.sy === -corner.sy)! : null;
    this.drag = { kind: 'ref', pane: p, id: r.id, x0: x, y0: y, ox: r.x, oy: r.y, size0: r.size, corner: corner ? { sx: corner.sx, sy: corner.sy, ax: opp!.x, ay: opp!.y, span: Math.hypot(corner.x - opp!.x, corner.y - opp!.y) } : null };
    return true;
  }

  private dragRef(d: Extract<Drag, { kind: 'ref' }>, x: number, y: number) {
    const r = ed.model.refs?.find((q) => q.id === d.id);
    if (!r) return;
    const u = d.pane.unitsPerPixel(d.pane.target);
    if (d.corner) {
      const k = Math.max(0.02, Math.hypot(x - d.corner.ax, y - d.corner.ay) / Math.max(1, d.corner.span));
      const aspect = r.width / Math.max(1, r.height);
      const w0 = d.size0 * aspect;
      // The opposite corner stays where it is.
      r.size = d.size0 * k;
      r.x = d.ox - (d.corner.sx * w0) / 2 + (d.corner.sx * r.size * aspect) / 2;
      r.y = d.oy - (d.corner.sy * d.size0) / 2 + (d.corner.sy * r.size) / 2;
    } else {
      r.x = d.ox + (x - d.x0) * u;
      r.y = d.oy - (y - d.y0) * u;
    }
    ed.emit('view');
  }

  // ---------- blockout overlays ----------
  /** A figure for judging scale, and the size of what's selected, in metres. Neither is part of the model. */
  private drawBlockout(g: CanvasRenderingContext2D, p: Pane) {
    if (ed.figure.show) {
      const [ox, oy, oz] = ed.figure.pos;
      const seg = scaleFigure(ed.figure.height);
      g.strokeStyle = 'rgba(127,200,248,.95)'; g.lineWidth = 1.5;
      g.beginPath();
      for (let i = 0; i < seg.length; i += 2) {
        const a = seg[i], b = seg[i + 1];
        const s0 = p.project(a[0] + ox, a[1] + oy, a[2] + oz), s1 = p.project(b[0] + ox, b[1] + oy, b[2] + oz);
        g.moveTo(s0.x, s0.y); g.lineTo(s1.x, s1.y);
      }
      g.stroke();
      const top = p.project(ox, oy + ed.figure.height * 1.03, oz);
      this.dimLabel(g, top.x, top.y - 8, `${ed.figure.height.toFixed(2)} m`, '#7fc8f8');
    }
    if (!ed.blockDims) return;
    const vs = ed.selectedVertexSet();
    if (!vs.size) return;
    const { min: lo, max: hi } = bounds([...vs].map((v) => ed.model.verts[v].p));
    const dim = (a: V3, b: V3, value: number) => {
      const s0 = p.project(a[0], a[1], a[2]), s1 = p.project(b[0], b[1], b[2]);
      if (Math.hypot(s1.x - s0.x, s1.y - s0.y) < 24 || value < 1e-4) return;
      g.strokeStyle = SEL; g.lineWidth = 1;
      g.beginPath(); g.moveTo(s0.x, s0.y); g.lineTo(s1.x, s1.y); g.stroke();
      this.dimLabel(g, (s0.x + s1.x) / 2, (s0.y + s1.y) / 2, `${+value.toFixed(3)} m`, SEL);
    };
    dim([lo[0], lo[1], hi[2]], [hi[0], lo[1], hi[2]], hi[0] - lo[0]);
    dim([hi[0], lo[1], hi[2]], [hi[0], hi[1], hi[2]], hi[1] - lo[1]);
    dim([hi[0], lo[1], lo[2]], [hi[0], lo[1], hi[2]], hi[2] - lo[2]);
  }

  private dimLabel(g: CanvasRenderingContext2D, x: number, y: number, text: string, color: string) {
    g.font = '11px "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    const w = g.measureText(text).width + 8;
    g.fillStyle = 'rgba(20,22,25,.85)';
    g.fillRect(x - w / 2, y - 8, w, 16);
    g.fillStyle = color;
    g.fillText(text, x, y);
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
  }

  // ---------- animation overlays ----------
  private ghostCache = new Map<number, Float32Array>();
  private trailCache = new Map<number, V3[]>();
  private ghostEdges: [number, number][] | null = null;
  private clearAnimCaches() { this.ghostCache.clear(); this.trailCache.clear(); this.ghostEdges = null; }

  /** Faint copies of the mesh a few frames either side: red before, green after. */
  private drawOnion(g: CanvasRenderingContext2D, p: Pane) {
    const m = ed.model, c = ed.clip()!;
    const here = Math.round(ed.frame);
    if (!this.ghostEdges) {
      const seen = new Set<string>();
      const out: [number, number][] = [];
      m.faces.forEach((f, fi) => {
        if (ed.isFaceHidden(fi)) return;
        f.v.forEach((a, i) => {
          const b = f.v[(i + 1) % f.v.length];
          const k = edgeKey(a, b);
          if (seen.has(k)) return;
          seen.add(k);
          out.push([a, b]);
        });
      });
      // On very dense meshes, thin the lines so scrubbing stays smooth.
      const skip = Math.ceil(out.length / 6000);
      this.ghostEdges = skip > 1 ? out.filter((_, i) => i % skip === 0) : out;
    }
    const step = Math.max(1, Math.round(c.length / 12));
    g.save();
    g.lineWidth = 1;
    for (const [dir, color] of [[-1, '#ff7a6b'], [1, '#6be08a']] as const) {
      for (let n = 2; n >= 1; n--) {
        const f = here + dir * n * step;
        if (f < 0 || f > c.length) continue;
        let P = this.ghostCache.get(f);
        if (!P) {
          P = new Float32Array(m.verts.length * 3);
          skinInto(m, evalPose(m, c, f), P);
          this.ghostCache.set(f, P);
        }
        g.strokeStyle = color;
        g.globalAlpha = n === 1 ? 0.42 : 0.2;
        g.beginPath();
        for (const [a, b] of this.ghostEdges) {
          const s0 = p.project(P[a * 3], P[a * 3 + 1], P[a * 3 + 2]), s1 = p.project(P[b * 3], P[b * 3 + 1], P[b * 3 + 2]);
          g.moveTo(s0.x, s0.y); g.lineTo(s1.x, s1.y);
        }
        g.stroke();
      }
    }
    g.restore();
  }

  /** The path each selected joint takes over the clip. Dots mark its keys. */
  private drawTrails(g: CanvasRenderingContext2D, p: Pane) {
    const m = ed.model, c = ed.clip()!;
    const every = Math.max(1, Math.ceil(c.length / 400));
    for (const id of ed.selBones) {
      let path = this.trailCache.get(id);
      if (!path) {
        path = [];
        for (let f = 0; f <= c.length; f += every) {
          const bp = evalPose(m, c, f).get(id);
          if (bp) path.push([...bp.pos] as V3);
        }
        this.trailCache.set(id, path);
      }
      if (path.length < 2) continue;
      g.strokeStyle = 'rgba(127,200,248,.75)'; g.lineWidth = 1.5;
      g.beginPath();
      path.forEach((q, i) => { const s = p.project(q[0], q[1], q[2]); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
      g.stroke();
      g.fillStyle = '#ffffff';
      for (const f of keyFrames(c, id)) {
        const q = path[Math.min(path.length - 1, Math.round(f / every))];
        const s = p.project(q[0], q[1], q[2]);
        g.beginPath(); g.arc(s.x, s.y, 3, 0, 7); g.fill();
      }
    }
  }

  // ---------- IK ----------
  private startIK(p: Pane, x: number, y: number) {
    const c = ed.clip();
    if (!ed.poseActive || !c) { toast('IK poses joints. Open the Animation workspace and create a clip.', 'info'); return; }
    const bone = pick.pickBone(p, x, y, 14);
    if (bone === null) return;
    if (!ikChain(ed.model, bone, 1).length) { toast('This joint has no parent to bend. Move it with the Move tool instead.', 'info'); return; }
    const frame = Math.round(ed.frame);
    if (frame !== ed.frame) { ed.frame = frame; ed.emit('time'); }
    const pose = ed.bonePose();
    const base = new Map<number, Q>();
    for (const id of [bone, ...ikChain(ed.model, bone, ed.ikChain)]) base.set(id, [...sampleTrack(c.tracks[id], frame).rot] as Q);
    if (!ed.testPose) ed.begin('IK pose');
    ed.activeBone = bone;
    ed.selBones = new Set([bone]);
    ed.mode = 'bone';
    ed.emit('selection', 'skeleton');
    this.drag = { kind: 'ik', pane: p, bone, frame, keep: ed.ikHold ? ([...pose.get(bone)!.rot] as Q) : undefined, base };
  }

  private dragIK(d: Extract<Drag, { kind: 'ik' }>, x: number, y: number) {
    const c = ed.clip();
    if (!c) return;
    const at = ed.bonePose().get(d.bone)!.pos;
    const here = new THREE.Vector3(...at);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(d.pane.viewDir(here), here);
    const hit = d.pane.ray(x, y).intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    const gap = solveIK(ed.model, c, d.frame, d.bone, [hit.x, hit.y, hit.z], ed.ikChain, d.keep);
    ed.emit('anim', 'geometry');
    status(gap > 0.01 ? `IK: out of reach by ${gap.toFixed(3)}. Raise Joints to reach further.` : `IK: ${ed.ikChain} joint${ed.ikChain === 1 ? '' : 's'} bending`);
  }

  setUVOverlay(selected: Set<number>, hover: number | null) {
    const same = hover === this.uvHover && selected.size === this.uvSelected.size && [...selected].every((v) => this.uvSelected.has(v));
    if (same) return;
    this.uvSelected = selected;
    this.uvHover = hover;
    this.invalidate();
  }

  /** In the UV workspace: seams on the surface, and where the UV editor's selection and cursor are on the mesh. */
  private drawUVLink(g: CanvasRenderingContext2D, p: Pane) {
    const m = ed.model;
    const P = ed.displayPositions();
    const seams = seamEdges(m);
    if (seams.size) {
      g.strokeStyle = '#ff5d5d'; g.lineWidth = 2;
      g.beginPath();
      const eye = p.camera.position;
      m.faces.forEach((f, fi) => {
        if (ed.isFaceHidden(fi)) return;
        // Only surfaces facing the camera, so seams on the far side don't clutter the view.
        const n = faceNormal(m, f);
        const a = m.verts[f.v[0]].p;
        const toEye = p.isOrtho ? p.viewDir() : new THREE.Vector3(eye.x - a[0], eye.y - a[1], eye.z - a[2]);
        if (n[0] * toEye.x + n[1] * toEye.y + n[2] * toEye.z <= 0) return;
        f.v.forEach((v, i) => {
          const w = f.v[(i + 1) % f.v.length];
          if (!seams.has(edgeKey(v, w))) return;
          const s0 = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]), s1 = p.project(P[w * 3], P[w * 3 + 1], P[w * 3 + 2]);
          g.moveTo(s0.x, s0.y); g.lineTo(s1.x, s1.y);
        });
      });
      g.stroke();
    }
    const dot3 = (v: number, r: number, color: string) => {
      if (v * 3 + 2 >= P.length) return;
      const s = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      g.fillStyle = color;
      g.beginPath(); g.arc(s.x, s.y, r, 0, 7); g.fill();
      g.strokeStyle = '#111'; g.lineWidth = 1; g.stroke();
    };
    this.uvSelected.forEach((v) => dot3(v, 3.5, SEL));
    if (this.uvHover !== null) dot3(this.uvHover, 5.5, '#ffffff');
  }

  /** The primitive's bounds, with a handle at the centre for moving it. */
  private drawPrimHandles(g: CanvasRenderingContext2D, p: Pane) {
    const s = this.session;
    if (!s) return;
    const corners: { x: number; y: number }[] = [];
    for (let i = 0; i < 8; i++) {
      corners.push(this.primPoint(p, s, [i & 1 ? s.max[0] : s.min[0], i & 2 ? s.max[1] : s.min[1], i & 4 ? s.max[2] : s.min[2]]));
    }
    g.strokeStyle = SEL; g.fillStyle = SEL; g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath();
    for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) {
      if (i & bit) continue;
      g.moveTo(corners[i].x, corners[i].y);
      g.lineTo(corners[i | bit].x, corners[i | bit].y);
    }
    g.stroke();
    g.setLineDash([]);
    for (const c of corners) g.fillRect(c.x - 2.5, c.y - 2.5, 5, 5);
    const c = this.primPoint(p, s, [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2]);
    g.beginPath(); g.arc(c.x, c.y, 4, 0, 7); g.fill();
  }

  private primPoint(p: Pane, s: PrimSession, l: Vec3) {
    const w = this.primWorld(s, l);
    return p.project(w.x, w.y, w.z);
  }

  private primWorld(s: PrimSession, l: Vec3) {
    return s.origin.clone().addScaledVector(s.axes[0], l[0]).addScaledVector(s.axes[1], l[1]).addScaledVector(s.axes[2], l[2]);
  }

  private drawBones(g: CanvasRenderingContext2D, p: Pane) {
    const pose = ed.bonePose();
    const byId = new Map(ed.model.bones.map((b) => [b.id, b]));
    for (const b of ed.model.bones) {
      const bp = pose.get(b.id);
      if (!bp) continue;
      const s = p.project(bp.pos[0], bp.pos[1], bp.pos[2]);
      if (s.z < -1 || s.z > 1) continue;
      const sel = ed.selBones.has(b.id);
      const active = ed.activeBone === b.id;
      if (b.parent !== null && byId.has(b.parent)) {
        const pp = pose.get(b.parent)!;
        const t = p.project(pp.pos[0], pp.pos[1], pp.pos[2]);
        const dx = s.x - t.x, dy = s.y - t.y, l = Math.hypot(dx, dy) || 1;
        const w = Math.min(7, l * 0.14);
        const nx = -dy / l * w, ny = dx / l * w;
        const px = t.x + dx * 0.18, py = t.y + dy * 0.18;
        const parentSel = ed.selBones.has(b.parent);
        g.beginPath();
        g.moveTo(t.x, t.y); g.lineTo(px + nx, py + ny); g.lineTo(s.x, s.y); g.lineTo(px - nx, py - ny); g.closePath();
        g.fillStyle = parentSel ? 'rgba(242,178,76,.5)' : 'rgba(150,200,235,.3)';
        g.strokeStyle = parentSel ? SEL : '#9bcbe8';
        g.lineWidth = 1;
        g.fill(); g.stroke();
      }
      g.beginPath();
      g.arc(s.x, s.y, active ? 5 : 4, 0, 7);
      g.fillStyle = sel ? SEL : '#d4e9f6';
      g.fill();
      g.strokeStyle = '#111'; g.lineWidth = 1; g.stroke();
      if (ed.showBoneNames) {
        g.font = '11px "Segoe UI", sans-serif';
        g.fillStyle = sel ? SEL : '#cfd6dd';
        g.fillText(b.name, s.x + 8, s.y - 6);
      }
    }
  }

  private drawTriad(g: CanvasRenderingContext2D, p: Pane) {
    const { right, up } = p.screenAxes();
    const ox = p.x + 32, oy = p.y + p.h - 32;
    const axes = AXIS_DIR.map((d, i) => {
      const v = new THREE.Vector3(...d);
      return { i, x: v.dot(right) * 20, y: -v.dot(up) * 20, z: v.dot(p.viewDir()) };
    }).sort((a, b) => a.z - b.z);
    g.font = 'bold 10px "Segoe UI", sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const a of axes) {
      g.strokeStyle = AXIS[a.i]; g.lineWidth = 2;
      g.beginPath(); g.moveTo(ox, oy); g.lineTo(ox + a.x, oy + a.y); g.stroke();
      if (Math.hypot(a.x, a.y) > 5) {
        g.fillStyle = AXIS[a.i];
        g.fillText('XYZ'[a.i], ox + a.x * 1.35, oy + a.y * 1.35);
      }
    }
    g.textAlign = 'start'; g.textBaseline = 'alphabetic';
  }

  // ---------- gizmo ----------
  private gizmoMode(): 'move' | 'rotate' | 'scale' | null {
    if (ed.tool === 'move' || ed.tool === 'rotate' || ed.tool === 'scale') return ed.tool;
    return null;
  }

  gizmoCenter(): THREE.Vector3 | null {
    if (ed.mode === 'bone') {
      if (!ed.selBones.size) return null;
      const pose = ed.bonePose();
      const pts: V3[] = [];
      ed.selBones.forEach((id) => { const bp = pose.get(id); if (bp) pts.push(bp.pos); });
      if (!pts.length) return null;
      return new THREE.Vector3(...bounds(pts).center);
    }
    if (ed.poseActive) return null;
    const vs = ed.selectedVertexSet();
    if (!vs.size) return null;
    const c = bounds([...vs].map((i) => ed.model.verts[i].p)).center;
    return new THREE.Vector3(...c);
  }

  private gizmoScreen(p: Pane, c: THREE.Vector3) {
    const s = p.project(c.x, c.y, c.z);
    const u = p.unitsPerPixel(c) * GIZMO;
    const ends = AXIS_DIR.map((d) => p.project(c.x + d[0] * u, c.y + d[1] * u, c.z + d[2] * u));
    return { s, ends, u };
  }

  private ringPoints(p: Pane, c: THREE.Vector3, axis: number, u: number) {
    const a = AXIS_DIR[(axis + 1) % 3], b = AXIS_DIR[(axis + 2) % 3];
    const pts: { x: number; y: number; front: boolean }[] = [];
    const view = p.viewDir(c);
    for (let i = 0; i <= 64; i++) {
      const th = (i / 64) * Math.PI * 2, cs = Math.cos(th), sn = Math.sin(th);
      const dx = a[0] * cs + b[0] * sn, dy = a[1] * cs + b[1] * sn, dz = a[2] * cs + b[2] * sn;
      const s = p.project(c.x + dx * u, c.y + dy * u, c.z + dz * u);
      pts.push({ x: s.x, y: s.y, front: dx * view.x + dy * view.y + dz * view.z >= -0.02 });
    }
    return pts;
  }

  private drawGizmo(g: CanvasRenderingContext2D, p: Pane, c: THREE.Vector3) {
    const mode = this.gizmoMode()!;
    const { s, ends, u } = this.gizmoScreen(p, c);
    if (s.z < -1 || s.z > 1) return;
    const active = this.drag?.kind === 'transform' ? this.drag.handle : this.hover;
    const isHot = (type: Handle['type'], axis: number) => active?.type === type && active.axis === axis;
    g.lineCap = 'round';
    if (mode === 'rotate') {
      g.strokeStyle = isHot('view', 0) ? SEL : 'rgba(255,255,255,.55)';
      g.lineWidth = isHot('view', 0) ? 3 : 1.5;
      g.beginPath(); g.arc(s.x, s.y, GIZMO * 1.18, 0, 7); g.stroke();
      for (let a = 0; a < 3; a++) {
        const pts = this.ringPoints(p, c, a, u);
        const hot = isHot('ring', a);
        for (let i = 1; i < pts.length; i++) {
          const q = pts[i - 1], r = pts[i];
          g.strokeStyle = hot ? SEL : AXIS[a];
          g.globalAlpha = q.front ? 1 : 0.18;
          g.lineWidth = hot ? 3.5 : 2;
          g.beginPath(); g.moveTo(q.x, q.y); g.lineTo(r.x, r.y); g.stroke();
        }
      }
      g.globalAlpha = 1;
    } else {
      // Planes
      if (mode === 'move') {
        for (let a = 0; a < 3; a++) {
          const e1 = ends[(a + 1) % 3], e2 = ends[(a + 2) % 3];
          const f = 0.28;
          const p1 = { x: s.x + (e1.x - s.x) * f, y: s.y + (e1.y - s.y) * f };
          const p2 = { x: s.x + (e2.x - s.x) * f, y: s.y + (e2.y - s.y) * f };
          const area = Math.abs((p1.x - s.x) * (p2.y - s.y) - (p1.y - s.y) * (p2.x - s.x));
          if (area < 40) continue;
          g.beginPath();
          g.moveTo(s.x, s.y); g.lineTo(p1.x, p1.y); g.lineTo(p1.x + p2.x - s.x, p1.y + p2.y - s.y); g.lineTo(p2.x, p2.y); g.closePath();
          g.fillStyle = isHot('plane', a) ? SEL : AXIS[a];
          g.globalAlpha = isHot('plane', a) ? 0.8 : 0.32;
          g.fill();
          g.globalAlpha = 1;
        }
      }
      for (let a = 0; a < 3; a++) {
        const e = ends[a];
        const len = Math.hypot(e.x - s.x, e.y - s.y);
        if (len < 6) continue;
        const hot = isHot('axis', a);
        g.strokeStyle = g.fillStyle = hot ? SEL : AXIS[a];
        g.lineWidth = hot ? 3.5 : 2.5;
        g.beginPath(); g.moveTo(s.x, s.y); g.lineTo(e.x, e.y); g.stroke();
        const ux = (e.x - s.x) / len, uy = (e.y - s.y) / len;
        if (mode === 'move') {
          g.beginPath();
          g.moveTo(e.x + ux * 12, e.y + uy * 12);
          g.lineTo(e.x - uy * 5, e.y + ux * 5);
          g.lineTo(e.x + uy * 5, e.y - ux * 5);
          g.closePath(); g.fill();
        } else g.fillRect(e.x - 5, e.y - 5, 10, 10);
      }
      const hotC = isHot('center', 0);
      g.fillStyle = hotC ? SEL : 'rgba(255,255,255,.9)';
      g.strokeStyle = '#111';
      g.lineWidth = 1;
      g.fillRect(s.x - 5, s.y - 5, 10, 10); g.strokeRect(s.x - 5, s.y - 5, 10, 10);
    }
    g.lineCap = 'butt';
  }

  private hitGizmo(p: Pane, mx: number, my: number): Handle | null {
    const mode = this.gizmoMode();
    const c = this.gizmoCenter();
    if (!mode || !c) return null;
    const { s, ends, u } = this.gizmoScreen(p, c);
    if (s.z < -1 || s.z > 1) return null;
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) => {
      const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, ((mx - a.x) * dx + (my - a.y) * dy) / l)) : 0;
      return Math.hypot(mx - (a.x + dx * t), my - (a.y + dy * t));
    };
    if (mode === 'rotate') {
      let best: Handle | null = null, bd = 8;
      for (let a = 0; a < 3; a++) {
        const pts = this.ringPoints(p, c, a, u);
        for (let i = 1; i < pts.length; i++) {
          if (!pts[i].front) continue;
          const d = near(pts[i - 1], pts[i]);
          if (d < bd) { bd = d; best = { type: 'ring', axis: a }; }
        }
      }
      if (best) return best;
      if (Math.abs(Math.hypot(mx - s.x, my - s.y) - GIZMO * 1.18) < 7) return { type: 'view', axis: 0 };
      return null;
    }
    if (Math.abs(mx - s.x) < 8 && Math.abs(my - s.y) < 8) return { type: 'center', axis: 0 };
    if (mode === 'move') {
      for (let a = 0; a < 3; a++) {
        const e1 = ends[(a + 1) % 3], e2 = ends[(a + 2) % 3];
        const f = 0.28;
        const ax = (e1.x - s.x) * f, ay = (e1.y - s.y) * f, bx = (e2.x - s.x) * f, by = (e2.y - s.y) * f;
        const det = ax * by - ay * bx;
        if (Math.abs(det) < 40) continue;
        const qx = mx - s.x, qy = my - s.y;
        const uu = (qx * by - qy * bx) / det, vv = (ax * qy - ay * qx) / det;
        if (uu > 0 && uu < 1 && vv > 0 && vv < 1) return { type: 'plane', axis: a };
      }
    }
    let best: Handle | null = null, bd = 8;
    for (let a = 0; a < 3; a++) {
      const d = near(s, ends[a]);
      if (d < bd) { bd = d; best = { type: 'axis', axis: a }; }
    }
    return best;
  }

  // ---------- input ----------
  private local(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }
  private paneAt(x: number, y: number): Pane | null {
    return this.visiblePanes().find((p) => p.contains(x, y)) ?? null;
  }

  private updateCursor() {
    const t = ed.tool;
    this.ov.style.cursor = t === 'select' || t === 'move' || t === 'rotate' || t === 'scale' ? 'default'
      : t === 'paint' || t === 'sculpt' ? 'none' : 'crosshair';
  }

  private bindInput() {
    const ov = this.ov;
    ov.addEventListener('contextmenu', (e) => e.preventDefault());
    ov.addEventListener('wheel', (e) => {
      e.preventDefault();
      const { x, y } = this.local(e);
      const p = this.paneAt(x, y);
      if (!p) return;
      if (ed.tool === 'loopcut' && !e.ctrlKey) { this.loopTool.wheel(e.deltaY); return; }
      if (ed.tool === 'paint' && e.ctrlKey) { ed.brush.radius = Math.max(4, Math.min(300, ed.brush.radius * (e.deltaY > 0 ? 0.9 : 1.1))); ed.emit('tool'); this.invalidate(); return; }
      if (ed.tool === 'sculpt' && e.ctrlKey) { ed.sculpt.radius = Math.max(4, Math.min(400, ed.sculpt.radius * (e.deltaY > 0 ? 0.9 : 1.1))); ed.emit('tool'); this.invalidate(); return; }
      if (ed.tool === 'stroke' && e.ctrlKey) { ed.strokeRadius = Math.max(0.002, ed.strokeRadius * (e.deltaY > 0 ? 0.9 : 1.1)); ed.emit('tool'); this.invalidate(); return; }
      p.zoom(e.deltaY > 0 ? 1.12 : 1 / 1.12, x, y);
      this.linkViews(p);
      this.invalidate();
    }, { passive: false });

    ov.addEventListener('pointerdown', (e) => {
      ov.focus({ preventScroll: true });
      const { x, y } = this.local(e);
      const p = this.paneAt(x, y);
      if (!p) return;
      this.active = p;
      this.invalidate();

      // Camera navigation
      this.rightPress = e.button === 2 && (this.session || ed.tool === 'knife' || ed.tool === 'loopcut') ? { x, y } : null;
      // During a slide, a right click leaves the loop in the centre instead of moving the view.
      if (e.button === 2 && this.loopTool.sliding) { this.loopTool.cancelSlide(); return; }
      if (e.button === 1) { this.drag = { kind: 'pan', pane: p, x, y }; return; }
      if (e.button === 2 && (this.drag?.kind === 'transform' || this.drag?.kind === 'extrude' || this.drag?.kind === 'ik' || this.drag?.kind === 'sculpt')) { this.cancelDrag(); return; }
      if (e.altKey && (e.button === 0 || e.button === 2)) { this.drag = { kind: altDragKind(p, e), pane: p, x, y }; return; }
      if (e.button === 2) { this.drag = { kind: p.isOrtho ? 'pan' : 'orbit', pane: p, x, y }; return; }
      if (e.button !== 0) return;
      if (ed.refEdit && this.startRefDrag(p, x, y)) return;
      this.toolDown(p, x, y, e);
    });

    // Move and release are tracked on the window so a drag survives leaving the viewport.
    window.addEventListener('pointermove', (e) => {
      if (!this.drag && !this.loopTool.sliding && e.target !== ov) return;
      const { x, y } = this.local(e);
      this.mouse = { x, y, inside: e.target === ov };
      const d = this.drag;
      if (!d) {
        const p = this.paneAt(x, y);
        if (ed.tool === 'knife' && p) { this.knife.move(p, x, y, e); return; }
        if (ed.tool === 'loopcut') {
          const at = p ?? this.active;
          if (at) this.loopTool.move(at, x, y, e);
          return;
        }
        const hv = p ? this.hitGizmo(p, x, y) : null;
        if (JSON.stringify(hv) !== JSON.stringify(this.hover)) { this.hover = hv; this.invalidate(); }
        if (ed.tool === 'paint' || ed.tool === 'sculpt') this.invalidate();
        return;
      }
      switch (d.kind) {
        case 'orbit': d.pane.orbit(x - d.x, y - d.y); d.x = x; d.y = y; break;
        case 'pan': d.pane.pan(x - d.x, y - d.y); d.x = x; d.y = y; break;
        case 'bank': d.pane.bank(x - d.x); d.x = x; d.y = y; break;
        case 'panGround': d.pane.panGround(x - d.x, y - d.y); d.x = x; d.y = y; break;
        case 'panVertical': d.pane.panVertical(y - d.y); d.x = x; d.y = y; break;
        case 'zoom': d.pane.zoom(Math.pow(1.006, (d.x - x) + (y - d.y))); d.x = x; d.y = y; break;
        case 'box': d.x1 = x; d.y1 = y; break;
        case 'transform': this.applyTransform(d, x, y, e.ctrlKey !== ed.snap); break;
        case 'extrude': this.applyExtrude(d, x, y, e.altKey, e.ctrlKey !== ed.snap); break;
        case 'prim': this.dragPrim(d, x, y, e); break;
        case 'primResize': this.dragPrimResize(d, x, y, e); break;
        case 'ik': this.dragIK(d, x, y); break;
        case 'ref': this.dragRef(d, x, y); break;
        case 'freehand': this.dragFreehand(d, x, y); break;
        case 'sculpt': this.sculptStep(d, x, y, e); break;
        case 'paint': this.paintAt(d.pane, x, y, e); break;
      }
      if (d.kind === 'pan' || d.kind === 'panGround' || d.kind === 'panVertical' || d.kind === 'zoom') this.linkViews(d.pane);
      this.invalidate();
    });

    ov.addEventListener('pointerleave', () => { this.mouse.inside = false; this.invalidate(); });

    const finish = (e: PointerEvent) => {
      if (e.button === 0) { this.knife.up(); this.loopTool.up(); }
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      const { x, y } = this.local(e);
      // A right click, unlike a right drag, finishes the primitive and readies the next one.
      if (e.button === 2 && this.rightPress && Math.hypot(x - this.rightPress.x, y - this.rightPress.y) < 4) {
        if (ed.tool === 'knife') this.knife.rightClick();
        else if (ed.tool === 'loopcut') this.finishOneShot();
        else this.dropPrim();
      }
      this.rightPress = null;
      if (d.kind === 'box') this.finishBox(d);
      else if (d.kind === 'transform' || d.kind === 'extrude') { ed.commit(); status(''); ed.emitAll(); }
      else if (d.kind === 'prim') this.finishPrim(d);
      else if (d.kind === 'primResize') { if (d.made) this.commitPrim(d.s); }
      else if (d.kind === 'ik') { ed.commit(); status(''); ed.emitAll(); }
      else if (d.kind === 'freehand') this.finishFreehand(d);
      else if (d.kind === 'sculpt') {
        if (d.moved) { ed.commit(); ed.emitAll(); } else ed.cancel();
      }
      else if (d.kind === 'ref') {
        // A click that moved nothing leaves no undo step.
        if (Math.hypot(x - d.x0, y - d.y0) < 2) ed.cancel();
        else { ed.commit(); ed.emitAll(); }
      }
      else if (d.kind === 'paint') { ed.commit(); ed.emit('geometry', 'selection'); }
      this.invalidate();
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    ov.addEventListener('dblclick', (e) => {
      // A double-click finishes whatever is being drawn.
      if (this.session) { this.dropPrim(); return; }
      if (ed.tool === 'knife') { this.knife.closeLoop(); return; }
      if (ed.tool === 'face' && this.facePending.length) { this.closeFace(); return; }
      if (ed.tool !== 'select' || ed.mode !== 'edge') return;
      const { x, y } = this.local(e);
      const p = this.paneAt(x, y);
      if (!p) return;
      const k = pick.pickEdge(p, this.sg, x, y);
      if (k) { ops.edgeLoop(ed.model, k).forEach((a) => ed.selEdges.add(a)); ed.emit('selection'); }
    });
  }

  cancelDrag() {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    if (d.kind === 'transform' && d.poseBase && ed.testPose) {
      // The test pose sits outside undo, so it restores itself.
      for (const b of d.poseBase.bones) {
        const t = ensureTrack(ed.testClip, b.id);
        setKey(t.rot, ed.frame, b.rot);
        setKey(t.pos, ed.frame, b.pos);
      }
      ed.emit('anim', 'geometry');
    } else if (d.kind === 'ik') {
      if (ed.testPose) {
        d.base.forEach((q, id) => setKey(ensureTrack(ed.testClip, id).rot, d.frame, q));
        ed.emit('anim', 'geometry');
      } else ed.cancel();
    } else if (d.kind === 'transform' || d.kind === 'extrude' || d.kind === 'paint' || d.kind === 'ref' || d.kind === 'sculpt') ed.cancel();
    else if ((d.kind === 'prim' || d.kind === 'primResize') && d.made) {
      this.sessionWriting = true;
      ed.cancel();
      this.sessionWriting = false;
      d.s.open = false;
      if (d.kind === 'primResize') { d.s.min = d.min0; d.s.max = d.max0; }
      else this.session = null;
    }
    status('');
    this.invalidate();
  }

  // Tool dispatch on left press.
  private toolDown(p: Pane, x: number, y: number, e: PointerEvent) {
    const handle = this.hitGizmo(p, x, y);
    if (handle) { this.startTransform(p, handle, x, y); return; }
    const t = ed.tool;
    switch (t) {
      case 'select': case 'move': case 'rotate': case 'scale':
        this.startSelect(p, x, y, e); return;
      case 'extrude': this.startExtrude(p, x, y); return;
      case 'vertex': this.placeVertex(p, x, y); return;
      case 'face': this.faceClick(p, x, y); return;
      case 'joint': this.placeJoint(p, x, y); return;
      case 'ik': this.startIK(p, x, y); return;
      case 'stroke': case 'blob': case 'lathe': this.startFreehand(p, x, y, t); return;
      case 'sculpt': this.startSculpt(p, x, y, e); return;
      case 'loopcut': this.loopTool.down(p, x, y); return;
      case 'knife': this.knife.down(p, x, y, e); return;
      case 'paint': {
        if (ed.activeBone === null) { toast('Pick a bone in the Skeleton panel first.', 'warn'); return; }
        ed.begin('Paint weights');
        this.drag = { kind: 'paint', pane: p, neighbors: vertexNeighbors(ed.model), mirror: ed.mirrorX ? mirrorMaps(ed.model) : null };
        this.paintAt(p, x, y, e);
        return;
      }
      default:
        if (this.session?.tool === t) this.startPrimResize(p, this.session, x, y);
        else {
          this.dropPrim();
          this.drag = { kind: 'prim', pane: p, s: this.newPrimSession(p, t, x, y), x0: x, y0: y, made: false };
        }
    }
  }

  private snapV(v: THREE.Vector3) {
    const s = ed.snapStep;
    v.set(Math.round(v.x / s) * s, Math.round(v.y / s) * s, Math.round(v.z / s) * s);
  }

  // ---------- selection ----------
  private startSelect(p: Pane, x: number, y: number, e: PointerEvent) {
    this.drag = { kind: 'box', pane: p, x0: x, y0: y, x1: x, y1: y, add: e.shiftKey, sub: e.ctrlKey };
  }

  private finishBox(d: Extract<Drag, { kind: 'box' }>) {
    const isClick = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 4;
    const r = { x0: Math.min(d.x0, d.x1), y0: Math.min(d.y0, d.y1), x1: Math.max(d.x0, d.x1), y1: Math.max(d.y0, d.y1) };
    const p = d.pane;
    const mode: SelMode = ed.mode;
    const apply = <T,>(set: Set<T>, items: T[]) => {
      if (!d.add && !d.sub) set.clear();
      for (const it of items) { if (d.sub) set.delete(it); else if (d.add && isClick && set.has(it)) set.delete(it); else set.add(it); }
    };
    if (mode === 'vertex') {
      const items = isClick ? [pick.pickVertex(p, this.sg, d.x0, d.y0)].filter((v): v is number => v !== null) : pick.boxVerts(p, this.sg, r);
      apply(ed.selVerts, items);
    } else if (mode === 'edge') {
      const items = isClick ? [pick.pickEdge(p, this.sg, d.x0, d.y0)].filter((v): v is string => v !== null) : pick.boxEdges(p, this.sg, r);
      apply(ed.selEdges, items);
    } else if (mode === 'face' || mode === 'group') {
      let items: number[];
      if (isClick) {
        const hit = pick.pickFace(p, this.sg, d.x0, d.y0, p.shading === 'wire');
        items = hit ? [hit.face] : [];
      } else items = pick.boxFaces(p, r);
      if (mode === 'group') {
        const gs = new Set(items.map((i) => ed.model.faces[i].g));
        items = [];
        ed.model.faces.forEach((f, i) => { if (gs.has(f.g)) items.push(i); });
      }
      if (items.length) ed.activeGroup = ed.model.faces[items[0]].g;
      apply(ed.selFaces, items);
    } else if (mode === 'bone') {
      const items = isClick ? [pick.pickBone(p, d.x0, d.y0)].filter((v): v is number => v !== null) : pick.boxBones(p, r);
      apply(ed.selBones, items);
      ed.activeBone = items[0] ?? (ed.selBones.size ? [...ed.selBones][0] : null);
    }
    ed.emit('selection', 'groups');
  }

  // ---------- transform ----------
  private startTransform(p: Pane, handle: Handle, x: number, y: number) {
    const mode = this.gizmoMode()!;
    const center = this.gizmoCenter()!;
    const orig = new Map<number, V3>();
    let boneOrig: Map<number, V3> | undefined;
    let poseBase: PoseBase | undefined;

    let boneMirror: Map<number, number> | undefined;
    if (ed.mode === 'bone') {
      if (ed.poseActive) {
        if (!ed.clip()) { toast('Create an animation clip first.', 'warn'); return; }
        // Keys belong on whole frames, even straight after playback.
        if (ed.frame !== Math.round(ed.frame)) { ed.frame = Math.round(ed.frame); ed.playing = false; ed.emit('time'); }
        poseBase = this.capturePose(center);
        if (!ed.testPose) ed.begin(mode === 'move' ? 'Pose move' : 'Pose rotate');
      } else {
        boneOrig = new Map();
        const bones = ed.model.bones;
        const moved = new Set(ed.selBones);
        // Optionally carry each selected joint's whole branch along.
        if (ed.moveJointChildren) {
          for (let grew = true; grew;) {
            grew = false;
            for (const b of bones) if (b.parent !== null && moved.has(b.parent) && !moved.has(b.id)) { moved.add(b.id); grew = true; }
          }
        }
        moved.forEach((id) => { const b = bones.find((x) => x.id === id); if (b) boneOrig!.set(id, [...b.head] as V3); });
        if (ed.mirrorX) {
          boneMirror = new Map();
          const map = mirrorMaps(ed.model).bone;
          moved.forEach((id) => { const o = map.get(id); if (o !== undefined && o !== id && !moved.has(o)) boneMirror!.set(id, o); });
        }
        ed.begin(`${cap(mode)} joint`);
      }
    } else {
      ed.selectedVertexSet().forEach((i) => orig.set(i, [...ed.model.verts[i].p] as V3));
      ed.begin(cap(mode));
    }

    const mirror = new Map<number, number>();
    if (ed.mirrorX && orig.size) {
      const index = new Map<string, number>();
      const key = (a: V3) => `${Math.round(a[0] * 1e4)},${Math.round(a[1] * 1e4)},${Math.round(a[2] * 1e4)}`;
      ed.model.verts.forEach((v, i) => index.set(key(v.p), i));
      orig.forEach((pv, i) => {
        const j = index.get(key([-pv[0], pv[1], pv[2]]));
        if (j !== undefined && j !== i && !orig.has(j)) mirror.set(i, j);
      });
    }
    const s = p.project(center.x, center.y, center.z);
    this.drag = { kind: 'transform', pane: p, handle, x0: x, y0: y, mode, center, orig, mirror, boneOrig, boneMirror, poseBase, startAngle: Math.atan2(y - s.y, x - s.x) };
  }

  private capturePose(center: THREE.Vector3): PoseBase {
    const clip = ed.clip()!;
    const pose = ed.bonePose();
    const byId = new Map(ed.model.bones.map((b) => [b.id, b]));
    const bones: PoseBase['bones'] = [];
    ed.selBones.forEach((id) => {
      const b = byId.get(id);
      if (!b) return;
      const s = sampleTrack(clip.tracks[id], ed.frame);
      const parentRot = b.parent !== null ? pose.get(b.parent)?.rot ?? [0, 0, 0, 1] : [0, 0, 0, 1];
      bones.push({ id, rot: s.rot, pos: s.pos, parentRot: parentRot as any });
    });
    return { bones, center };
  }

  private applyTransform(d: Extract<Drag, { kind: 'transform' }>, x: number, y: number, snap: boolean) {
    const p = d.pane;
    const c = d.center;
    const s = p.project(c.x, c.y, c.z);
    const { right, up } = p.screenAxes();
    let move = new THREE.Vector3();
    let scale: V3 = [1, 1, 1];
    let rotAxis: V3 | null = null;
    let rotAngle = 0;
    const u = p.unitsPerPixel(c);
    const dx = x - d.x0, dy = y - d.y0;
    const axisScreen = (a: number) => {
      const e = p.project(c.x + AXIS_DIR[a][0] * u * GIZMO, c.y + AXIS_DIR[a][1] * u * GIZMO, c.z + AXIS_DIR[a][2] * u * GIZMO);
      const ax = e.x - s.x, ay = e.y - s.y;
      return { ax, ay, len: Math.hypot(ax, ay) || 1 };
    };

    if (d.mode === 'move') {
      if (d.handle.type === 'axis') {
        const { ax, ay, len } = axisScreen(d.handle.axis);
        const along = (dx * ax + dy * ay) / len;
        move.setComponent(d.handle.axis, (along / len) * u * GIZMO);
      } else if (d.handle.type === 'plane') {
        // Solve the screen delta in the plane's two projected axes.
        const a1 = (d.handle.axis + 1) % 3, a2 = (d.handle.axis + 2) % 3;
        const A = axisScreen(a1), B = axisScreen(a2);
        const det = A.ax * B.ay - A.ay * B.ax;
        if (Math.abs(det) > 1e-6) {
          move.setComponent(a1, ((dx * B.ay - dy * B.ax) / det) * u * GIZMO);
          move.setComponent(a2, ((A.ax * dy - A.ay * dx) / det) * u * GIZMO);
        }
      } else {
        move = right.clone().multiplyScalar(dx * u).addScaledVector(up, -dy * u);
      }
      if (snap) { const st = ed.snapStep; move.set(Math.round(move.x / st) * st, Math.round(move.y / st) * st, Math.round(move.z / st) * st); }
      status(`Move  X ${move.x.toFixed(3)}  Y ${move.y.toFixed(3)}  Z ${move.z.toFixed(3)}`);
    } else if (d.mode === 'scale') {
      if (d.handle.type === 'axis') {
        const { ax, ay, len } = axisScreen(d.handle.axis);
        const k = Math.max(0.001, 1 + ((dx * ax + dy * ay) / len) / GIZMO);
        const val = snap ? Math.round(k * 10) / 10 : k;
        scale[d.handle.axis] = val;
      } else {
        const k = Math.max(0.001, 1 + (dx - dy) / (GIZMO * 1.5));
        const val = snap ? Math.round(k * 10) / 10 : k;
        scale = [val, val, val];
      }
      status(`Scale  X ${scale[0].toFixed(3)}  Y ${scale[1].toFixed(3)}  Z ${scale[2].toFixed(3)}`);
    } else {
      const ang = Math.atan2(y - s.y, x - s.x);
      let delta = ang - (d.startAngle ?? 0);
      if (d.handle.type === 'ring') {
        rotAxis = AXIS_DIR[d.handle.axis];
        const view = p.viewDir(c);
        const facing = rotAxis[0] * view.x + rotAxis[1] * view.y + rotAxis[2] * view.z;
        delta = facing >= 0 ? -delta : delta;
      } else {
        const view = p.viewDir(c);
        rotAxis = [view.x, view.y, view.z];
        delta = -delta;
      }
      if (snap) { const st = (ed.snapAngle * Math.PI) / 180; delta = Math.round(delta / st) * st; }
      rotAngle = delta;
      status(`Rotate  ${((delta * 180) / Math.PI).toFixed(1)}°`);
    }

    const q = rotAxis ? qAxisAngle(norm(rotAxis), rotAngle) : ([0, 0, 0, 1] as [number, number, number, number]);
    const cv: V3 = [c.x, c.y, c.z];
    const xf = (o: V3): V3 => {
      if (d.mode === 'move') return [o[0] + move.x, o[1] + move.y, o[2] + move.z];
      if (d.mode === 'scale') return [cv[0] + (o[0] - cv[0]) * scale[0], cv[1] + (o[1] - cv[1]) * scale[1], cv[2] + (o[2] - cv[2]) * scale[2]];
      const r = qRotate(q, [o[0] - cv[0], o[1] - cv[1], o[2] - cv[2]]);
      return [r[0] + cv[0], r[1] + cv[1], r[2] + cv[2]];
    };

    if (d.poseBase) {
      const clip = ed.clip()!;
      for (const b of d.poseBase.bones) {
        const tr = ensureTrack(clip, b.id);
        if (d.mode === 'rotate') {
          // Express the world-space rotation in the bone's parent frame.
          const local = qNorm(qMul(qMul(qMul(qConj(b.parentRot), q), b.parentRot), b.rot));
          setKey(tr.rot, ed.frame, local);
        } else if (d.mode === 'move') {
          const off = qRotate(qConj(b.parentRot), [move.x, move.y, move.z]);
          setKey(tr.pos, ed.frame, [b.pos[0] + off[0], b.pos[1] + off[1], b.pos[2] + off[2]]);
        }
      }
      ed.emit('anim', 'geometry');
      return;
    }
    if (d.boneOrig) {
      d.boneOrig.forEach((o, id) => {
        const b = ed.model.bones.find((x) => x.id === id);
        if (!b) return;
        b.head = xf(o);
        const twin = d.boneMirror?.get(id);
        const other = twin !== undefined ? ed.model.bones.find((x) => x.id === twin) : undefined;
        if (other) other.head = [-b.head[0], b.head[1], b.head[2]];
      });
      ed.emit('skeleton', 'geometry');
      return;
    }
    d.orig.forEach((o, i) => {
      const n = xf(o);
      ed.model.verts[i].p = n;
      const mi = d.mirror.get(i);
      if (mi !== undefined) ed.model.verts[mi].p = [-n[0], n[1], n[2]];
    });
    ed.emit('geometry');
  }

  // ---------- extrude ----------
  private startExtrude(p: Pane, x: number, y: number) {
    const faces = ed.selectedFaceSet();
    if (!faces.size) { toast('Select faces to extrude.', 'warn'); return; }
    ed.lastOp = null;
    ed.begin('Extrude');
    const { top, normal, vertexNormals } = ops.extrudeFaces(ed.model, faces);
    const verts = new Map<number, V3>();
    top.forEach((v) => verts.set(v, [...ed.model.verts[v].p] as V3));
    const c = bounds([...verts.values()]).center;
    ed.emit('topology');
    this.drag = { kind: 'extrude', pane: p, x0: x, y0: y, verts, normals: vertexNormals, center: new THREE.Vector3(...c), axis: new THREE.Vector3(...normal) };
  }

  private applyExtrude(d: Extract<Drag, { kind: 'extrude' }>, x: number, y: number, alongVertexNormals: boolean, snap: boolean) {
    const p = d.pane;
    const c = d.center;
    const u = p.unitsPerPixel(c);
    const s = p.project(c.x, c.y, c.z);
    const e = p.project(c.x + d.axis.x, c.y + d.axis.y, c.z + d.axis.z);
    let ax = e.x - s.x, ay = e.y - s.y;
    const l = Math.hypot(ax, ay);
    let amount: number;
    if (l < 1e-3 || l / (1 / u) < 0.15) {
      // Normal points at the camera: fall back to vertical motion.
      amount = (d.y0 - y) * u;
    } else {
      ax /= l; ay /= l;
      amount = ((x - d.x0) * ax + (y - d.y0) * ay) * (1 / l);
    }
    if (snap) amount = Math.round(amount / ed.snapStep) * ed.snapStep;
    d.verts.forEach((o, i) => {
      const n: V3 = alongVertexNormals ? d.normals.get(i) ?? [d.axis.x, d.axis.y, d.axis.z] : [d.axis.x, d.axis.y, d.axis.z];
      ed.model.verts[i].p = [o[0] + n[0] * amount, o[1] + n[1] * amount, o[2] + n[2] * amount];
    });
    status(`Extrude  ${amount.toFixed(3)}   (Alt: along vertex normals)`);
    ed.emit('geometry');
  }

  // ---------- creation ----------
  private ensureGroup(): number {
    const m = ed.model;
    if (ed.activeGroup !== null && m.groups.some((g) => g.id === ed.activeGroup)) return ed.activeGroup;
    const g = { id: m.nextId++, name: uniqueName(m.groups.map((x) => x.name), 'Mesh'), material: ed.activeMaterial, visible: true, locked: false, kind: 'mesh' as const };
    m.groups.push(g);
    ed.activeGroup = g.id;
    return g.id;
  }

  private placeVertex(p: Pane, x: number, y: number) {
    const w = p.planePoint(x, y, this.gizmoCenter() ?? new THREE.Vector3());
    if (ed.snap) this.snapV(w);
    ed.transact('Add vertex', (m) => { m.verts.push({ p: [w.x, w.y, w.z] }); });
    ed.setMode('vertex');
    ed.selVerts.add(ed.model.verts.length - 1);
    ed.emit('selection');
    status(`Vertex ${ed.model.verts.length - 1}. Use the Face tool to connect vertices.`);
  }

  private faceClick(p: Pane, x: number, y: number) {
    let v = pick.pickVertex(p, this.sg, x, y, 12);
    if (v === null) {
      const w = p.planePoint(x, y, this.facePending.length
        ? new THREE.Vector3(...ed.model.verts[this.facePending[0]].p) : new THREE.Vector3());
      if (ed.snap) this.snapV(w);
      ed.transact('Add vertex', (m) => { m.verts.push({ p: [w.x, w.y, w.z] }); });
      v = ed.model.verts.length - 1;
    }
    if (this.facePending[0] === v && this.facePending.length >= 3) { this.closeFace(); return; }
    if (!this.facePending.includes(v)) this.facePending.push(v);
    status(`Face: ${this.facePending.length} corners. Enter or click the first corner to close, Esc to cancel.`);
    this.invalidate();
  }

  closeFace() {
    if (this.facePending.length < 3) { this.facePending = []; this.invalidate(); return; }
    const corners = this.facePending.slice();
    this.facePending = [];
    ed.transact('Add face', (m) => {
      const gid = this.ensureGroup();
      m.faces.push({ v: corners, uv: corners.map((c) => [m.verts[c].p[0], m.verts[c].p[2]]), g: gid, s: 0 });
    });
    status('');
  }
  clearPending() { this.facePending = []; this.invalidate(); }
  get pendingFace() { return this.facePending.length; }

  // ---------- drawing primitives ----------
  private newPrimSession(p: Pane, tool: string, x: number, y: number): PrimSession {
    const hit = ed.drawOnSurface ? pick.pickFace(p, this.sg, x, y, false) : null;
    const zero: Vec3 = [0, 0, 0];
    let origin: THREE.Vector3;
    let axisY: THREE.Vector3;
    let axisX: THREE.Vector3;
    if (hit) {
      origin = hit.point.clone();
      axisY = new THREE.Vector3(...faceNormal(ed.model, ed.model.faces[hit.face]));
      // Snapping moves the start along the surface, never off it.
      if (ed.snap) {
        const snapped = origin.clone();
        this.snapV(snapped);
        origin = snapped.addScaledVector(axisY, axisY.dot(origin.clone().sub(snapped)));
      }
      axisX = new THREE.Vector3().crossVectors(Math.abs(axisY.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1), axisY).normalize();
    } else if (p.isOrtho) {
      origin = p.planePoint(x, y);
      if (ed.snap) this.snapV(origin);
      axisY = p.viewDir();
      axisX = p.screenAxes().right;
    } else {
      origin = p.planePoint(x, y);
      if (ed.snap) this.snapV(origin);
      axisY = new THREE.Vector3(0, 1, 0);
      axisX = new THREE.Vector3(1, 0, 0);
    }
    const axisZ = new THREE.Vector3().crossVectors(axisX, axisY).normalize();
    return {
      tool, origin, axes: tool === 'limb' || tool === 'part' ? [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)] : [axisX, axisY, axisZ], min: [...zero], max: [...zero],
      flatUntilDepth: tool !== 'limb' && tool !== 'part' && !hit && p.isOrtho, ground: !p.isOrtho || !!hit,
      groupId: null, pendingGroup: null, baseV: 0, baseF: 0, steps: 0, open: false,
    };
  }

  /** A limb runs from where the drag began to the cursor, staying in the plane facing the view. */
  private dragLimb(d: Extract<Drag, { kind: 'prim' }>, x: number, y: number) {
    const s = d.s;
    const facing = new THREE.Plane().setFromNormalAndCoplanarPoint(d.pane.viewDir(s.origin), s.origin);
    const end = d.pane.ray(x, y).intersectPlane(facing, new THREE.Vector3());
    if (!end) return;
    if (ed.snap) this.snapV(end);
    const f = limbFrame([s.origin.x, s.origin.y, s.origin.z], [end.x, end.y, end.z]);
    if (f.length < 1e-4) return;
    s.axes = [new THREE.Vector3(...f.x), new THREE.Vector3(...f.y), new THREE.Vector3(...f.z)];
    this.setLimbExtents(s, f.length);
    d.made = true;
    this.buildPrim(s);
    status(`${s.tool === 'part' ? PARTS[ed.partKind].label : 'Limb'}  ${f.length.toFixed(3)} m long, ${(s.max[0] - s.min[0]).toFixed(3)} m wide`);
  }

  /** A limb's width follows its thickness setting; a part keeps its own proportions at this length. */
  private setLimbExtents(s: PrimSession, length: number) {
    if (s.tool === 'part') {
      const b = bounds(this.primShape('part').prim.verts);
      const k = length * ed.partThickness;
      s.min = [b.min[0] * k, 0, b.min[2] * k];
      s.max = [b.max[0] * k, length, b.max[2] * k];
    } else {
      const r = (length * ed.limbThickness) / 2;
      s.min = [-r, 0, -r];
      s.max = [r, length, r];
    }
  }

  // ---------- freehand drawing ----------
  /** Begin a hand-drawn line, on the surface under the cursor if there is one, in the plane facing the view. */
  private startFreehand(p: Pane, x: number, y: number, tool: 'stroke' | 'blob' | 'lathe') {
    const hit = ed.drawOnSurface ? pick.pickFace(p, this.sg, x, y, false) : null;
    const origin = hit ? hit.point.clone() : p.viewPlanePoint(x, y);
    this.drag = { kind: 'freehand', pane: p, tool, origin, points: [origin.clone()], screen: [[x, y]] };
  }

  private dragFreehand(d: Extract<Drag, { kind: 'freehand' }>, x: number, y: number) {
    const last = d.screen[d.screen.length - 1];
    if (Math.hypot(x - last[0], y - last[1]) < 5) return;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(d.pane.viewDir(d.origin), d.origin);
    const at = d.pane.ray(x, y).intersectPlane(plane, new THREE.Vector3());
    if (!at) return;
    d.points.push(at);
    d.screen.push([x, y]);
  }

  /** Turn the finished line into a piece, plus its mirror image when symmetry is on. */
  private finishFreehand(d: Extract<Drag, { kind: 'freehand' }>) {
    const sides = ed.primSegments, smooth = !ed.lowPoly;
    let prim: prims.Prim | null = null;
    let name = 'Tube';
    if (d.tool === 'stroke') {
      prim = tube(d.points.map((q): V3 => [q.x, q.y, q.z]), ed.strokeRadius, sides, ed.lowPoly ? 2.4 : 1, ed.strokeTaper, smooth);
    } else if (d.tool === 'lathe') {
      const { right, up } = d.pane.screenAxes();
      const profile = d.points.map((q): [number, number] => [q.dot(right), q.dot(up)]);
      const us = profile.map((q) => q[0]);
      // With symmetry the axis is the centre line. Otherwise it's the edge of the drawn profile nearest the centre.
      const axis = ed.mirrorX || (Math.min(...us) < 0 && Math.max(...us) > 0) ? 0 : Math.min(...us.map(Math.abs)) * Math.sign(us[0]);
      name = 'Lathe';
      prim = lathe(profile, axis, [0, 0, 0], [right.x, right.y, right.z], [up.x, up.y, up.z], ed.lowPoly ? Math.max(4, ed.primRings) : Math.max(12, ed.primRings * 2), sides, smooth);
    } else {
      const { right, up } = d.pane.screenAxes();
      const toLocal = (q: THREE.Vector3): [number, number] => { const v = q.clone().sub(d.origin); return [v.dot(right), v.dot(up)]; };
      name = 'Shape';
      prim = silhouette(d.points.map(toLocal), [d.origin.x, d.origin.y, d.origin.z], [right.x, right.y, right.z], [up.x, up.y, up.z], ed.lowPoly ? Math.max(3, ed.primRings - 1) : Math.max(8, ed.primRings), sides, ed.blobDepth, smooth);
    }
    if (!prim) { toast(d.tool === 'stroke' ? 'Drag a longer line to draw a tube.' : d.tool === 'lathe' ? 'Draw a longer outline to spin it.' : 'Draw around a shape to inflate it.', 'info'); return; }
    const made = prim;
    let gid = 0;
    ed.transact(d.tool === 'stroke' ? 'Draw tube' : d.tool === 'lathe' ? 'Draw lathe' : 'Draw shape', (m) => {
      const res = ops.addPrim(m, made, name, { material: ed.activeMaterial });
      gid = res.groupId;
      this.selectNewPrim(res);
      if (ed.mirrorX && ed.workspace === 'block') mirrorPiece(m, gid);
    });
    status('');
  }

  private drawFreehandPreview(g: CanvasRenderingContext2D, p: Pane) {
    const d = this.drag;
    if (d?.kind !== 'freehand' || d.pane !== p || d.points.length < 2) return;
    g.strokeStyle = SEL; g.lineCap = 'round'; g.lineJoin = 'round';
    // A tube previews at its real thickness.
    g.lineWidth = d.tool === 'stroke' ? Math.max(2, (ed.strokeRadius * 2) / p.unitsPerPixel(d.origin)) : 2;
    g.globalAlpha = d.tool === 'stroke' ? 0.45 : 1;
    g.beginPath();
    d.screen.forEach(([x, y], i) => { if (i) g.lineTo(x, y); else g.moveTo(x, y); });
    if (d.tool === 'blob') g.closePath();
    g.stroke();
    if (d.tool === 'lathe') {
      // Show the axis it will spin around.
      const s = p.project(0, 0, 0);
      g.strokeStyle = '#7fc8f8'; g.lineWidth = 1; g.setLineDash([5, 4]);
      g.beginPath(); g.moveTo(s.x, p.y); g.lineTo(s.x, p.y + p.h); g.stroke();
      g.setLineDash([]);
    }
    g.globalAlpha = 1; g.lineCap = 'butt'; g.lineJoin = 'miter';
  }

  // ---------- sculpting ----------
  /** The vertices under the brush, weighted by a soft falloff from its centre. */
  private brushVerts(p: Pane, x: number, y: number): { v: number; w: number }[] {
    const P = ed.displayPositions();
    const r = ed.sculpt.radius;
    const seeThrough = ed.xray || p.shading === 'wire';
    const at = new THREE.Vector3();
    const out: { v: number; w: number }[] = [];
    const list = this.sg.visibleVerts;
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const s = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d > r) continue;
      if (!seeThrough && pick.occluded(p, this.sg, at.fromArray(P, v * 3))) continue;
      const k = 1 - d / r;
      out.push({ v, w: k * k * (3 - 2 * k) });
    }
    return out;
  }

  private startSculpt(p: Pane, x: number, y: number, e: PointerEvent) {
    if (ed.poseActive) { toast('Sculpting edits the rest shape. Leave the pose first.', 'info'); return; }
    const under = this.brushVerts(p, x, y);
    if (!under.length) return;
    ed.begin('Sculpt');
    const m = ed.model;
    const hitAt = pick.pickFace(p, this.sg, x, y, true)?.point ?? new THREE.Vector3(...m.verts[under[0].v].p);
    this.drag = {
      kind: 'sculpt', pane: p, x0: x, y0: y, grabbed: under,
      orig: new Map(under.map((u) => [u.v, [...m.verts[u.v].p] as V3])),
      at: hitAt.clone(), neighbors: vertexNeighbors(m), mirror: ed.mirrorX ? mirrorMaps(m).vert : null, moved: false,
    };
    if (ed.sculpt.mode !== 'grab') this.sculptStep(this.drag as Extract<Drag, { kind: 'sculpt' }>, x, y, e);
  }

  private setSculpted(d: Extract<Drag, { kind: 'sculpt' }>, v: number, p: V3) {
    const m = ed.model;
    m.verts[v].p = p;
    const twin = d.mirror?.get(v);
    if (twin !== undefined && twin !== v) m.verts[twin].p = [-p[0], p[1], p[2]];
  }

  private sculptStep(d: Extract<Drag, { kind: 'sculpt' }>, x: number, y: number, e: PointerEvent) {
    const m = ed.model;
    const u = d.pane.unitsPerPixel(d.at);
    if (ed.sculpt.mode === 'grab') {
      const { right, up } = d.pane.screenAxes();
      const dx = (x - d.x0) * u, dy = -(y - d.y0) * u;
      for (const { v, w } of d.grabbed) {
        const o = d.orig.get(v)!;
        this.setSculpted(d, v, [o[0] + (right.x * dx + up.x * dy) * w, o[1] + (right.y * dx + up.y * dy) * w, o[2] + (right.z * dx + up.z * dy) * w]);
      }
    } else {
      const under = this.brushVerts(d.pane, x, y);
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
          this.setSculpted(d, v, [p[0] - n[0] * k, p[1] - n[1] * k, p[2] - n[2] * k]);
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
            this.setSculpted(d, v, [p[0] + to.x * k, p[1] + to.y * k, p[2] + to.z * k]);
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
      next.forEach(([v, p]) => this.setSculpted(d, v, p));
    }
    d.moved = true;
    ed.emit('geometry');
  }

  /** The outline: from where the drag began to the cursor, or symmetrical while Ctrl is held. */
  private dragPrim(d: Extract<Drag, { kind: 'prim' }>, x: number, y: number, e: PointerEvent) {
    if (!d.made && Math.hypot(x - d.x0, y - d.y0) < 4) return;
    if (d.s.tool === 'limb' || d.s.tool === 'part') { this.dragLimb(d, x, y); return; }
    const s = d.s;
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(s.axes[1], s.origin);
    const hit = d.pane.ray(x, y).intersectPlane(plane, new THREE.Vector3());
    if (!hit) return;
    if (ed.snap) this.snapV(hit);
    hit.sub(s.origin);
    let a = hit.dot(s.axes[0]), b = hit.dot(s.axes[2]);
    if (e.ctrlKey) {
      const size = Math.max(Math.abs(a), Math.abs(b));
      a = (a < 0 ? -1 : 1) * size;
      b = (b < 0 ? -1 : 1) * size;
    }
    s.min = [Math.min(0, a), 0, Math.min(0, b)];
    s.max = [Math.max(0, a), 0, Math.max(0, b)];
    if (s.ground && s.tool !== 'plane') s.max[1] = Math.max(Math.abs(a), Math.abs(b));
    d.made = true;
    this.buildPrim(s);
    this.showPrimSize(s);
  }

  private finishPrim(d: Extract<Drag, { kind: 'prim' }>) {
    const s = d.s;
    if (!d.made && (s.tool === 'limb' || s.tool === 'part')) {
      // A click makes a short upright one.
      this.setLimbExtents(s, 0.5);
      s.flatUntilDepth = false;
      this.buildPrim(s);
    } else if (!d.made) {
      // A click makes a 1-unit primitive.
      const flat = s.tool === 'plane';
      s.min = [-0.5, s.ground ? 0 : flat ? 0 : -0.5, -0.5];
      s.max = [0.5, flat ? 0 : s.ground ? 1 : 0.5, 0.5];
      s.flatUntilDepth = false;
      this.buildPrim(s);
    }
    this.session = s;
    this.commitPrim(s);
    status('Drag sides or corners to resize, the centre to move. Drag in another view for depth. Arrows change segments. Double-click, right click, Enter or Space finishes; Esc removes.');
  }

  private startPrimResize(p: Pane, s: PrimSession, x: number, y: number) {
    const mid: Vec3 = [(s.min[0] + s.max[0]) / 2, (s.min[1] + s.max[1]) / 2, (s.min[2] + s.max[2]) / 2];
    const c = this.primPoint(p, s, mid);
    const screen = s.axes.map((_, i) => {
      const end: Vec3 = [...mid];
      end[i] += 1;
      const q = this.primPoint(p, s, end);
      return { i, sx: q.x - c.x, sy: q.y - c.y, len: Math.hypot(q.x - c.x, q.y - c.y) };
    });
    // Perspective only sets height, since one screen drag can't say which ground axis is meant.
    let controlled = screen;
    if (!p.isOrtho) controlled = s.tool === 'plane' ? [screen[0], screen[2]] : [screen[1]];
    else controlled = [...screen].sort((a, b) => b.len - a.len).slice(0, 2);
    const axes = controlled.map((a) => {
      const flat = s.max[a.i] - s.min[a.i] < 1e-6;
      const toward = (x - c.x) * a.sx + (y - c.y) * a.sy;
      const side: -1 | 0 | 1 = flat ? 0 : !p.isOrtho || toward >= 0 ? 1 : -1;
      return { i: a.i, sx: a.sx, sy: a.sy, side };
    });
    const move = p.isOrtho && axes.every((a) => a.side !== 0) && Math.hypot(x - c.x, y - c.y) < 10;
    this.drag = { kind: 'primResize', pane: p, s, x0: x, y0: y, min0: [...s.min], max0: [...s.max], move, made: false, axes };
  }

  private dragPrimResize(d: Extract<Drag, { kind: 'primResize' }>, x: number, y: number, e: PointerEvent) {
    if (!d.made && Math.hypot(x - d.x0, y - d.y0) < 3) return;
    const s = d.s;
    s.min = [...d.min0];
    s.max = [...d.max0];
    for (const a of d.axes) {
      let delta = ((x - d.x0) * a.sx + (y - d.y0) * a.sy) / (a.sx * a.sx + a.sy * a.sy || 1);
      if (ed.snap) delta = Math.round(delta / ed.snapStep) * ed.snapStep;
      if (d.move) { s.min[a.i] += delta; s.max[a.i] += delta; continue; }
      const symmetric = e.ctrlKey;
      if (a.side === 0) {
        // No thickness yet: the drag's direction decides which way it grows.
        if (symmetric) { s.max[a.i] += Math.abs(delta); s.min[a.i] -= Math.abs(delta); }
        else if (delta >= 0) s.max[a.i] += delta;
        else s.min[a.i] += delta;
      } else if (a.side > 0) {
        s.max[a.i] += delta;
        if (symmetric) s.min[a.i] -= delta;
      } else {
        s.min[a.i] += delta;
        if (symmetric) s.max[a.i] -= delta;
      }
      if (s.min[a.i] > s.max[a.i]) { const t = s.min[a.i]; s.min[a.i] = s.max[a.i]; s.max[a.i] = t; }
    }
    d.made = true;
    this.buildPrim(s);
    this.showPrimSize(s);
  }

  private showPrimSize(s: PrimSession) {
    const w = s.max[0] - s.min[0], hh = s.max[1] - s.min[1], l = s.max[2] - s.min[2];
    status(`${cap(s.tool)}  ${w.toFixed(3)} x ${l.toFixed(3)} x ${hh.toFixed(3)}   (Ctrl: symmetrical)`);
  }

  /** Rebuild the live primitive inside an open edit. */
  private buildPrim(s: PrimSession) {
    this.sessionWriting = true;
    if (s.open) ed.cancel();
    ed.lastOp = null;
    ed.begin(`${s.groupId === null ? 'Create' : 'Adjust'} ${cap(s.tool)}`);
    s.open = true;
    this.sessionWriting = false;
    const m = ed.model;
    if (s.groupId === null) { s.baseV = m.verts.length; s.baseF = m.faces.length; } else { m.verts.length = s.baseV; m.faces.length = s.baseF; }
    const { prim, name } = this.primShape(s.tool);
    const res = ops.addPrim(m, this.fitPrim(prim, s), name, { material: ed.activeMaterial, groupId: s.groupId ?? undefined });
    s.pendingGroup = res.groupId;
    if (s.tool === 'part') { const g = m.groups.find((x) => x.id === res.groupId); if (g && !g.color) g.color = PARTS[ed.partKind].color; }
    this.selectNewPrim(res);
    ed.emit('topology', 'groups', 'selection');
  }

  private commitPrim(s: PrimSession) {
    if (!s.open) return;
    this.sessionWriting = true;
    ed.commit();
    s.open = false;
    s.steps++;
    s.groupId = s.pendingGroup;
    ed.sanitize();
    ed.emitAll();
    this.sessionWriting = false;
  }

  /** Stretch a primitive's bounds to the session's extents, then place it in the session's frame. */
  private fitPrim(prim: prims.Prim, s: PrimSession): prims.Prim {
    const b = bounds(prim.verts);
    const verts = prim.verts.map((v): V3 => {
      const l: Vec3 = [0, 0, 0];
      for (let i = 0; i < 3; i++) {
        const size = b.max[i] - b.min[i];
        const want = Math.max(s.max[i] - s.min[i], 1e-3);
        l[i] = s.min[i] + (size > 1e-9 ? ((v[i] - b.min[i]) / size) * want : 0);
      }
      const w = this.primWorld(s, l);
      return [w.x, w.y, w.z];
    });
    return { ...prim, verts };
  }

  /** Finish the primitive being drawn. The tool stays active, ready for the next one. */
  dropPrim() {
    const s = this.session;
    if (!s) return;
    // No depth was ever drawn: give it some rather than leave a flattened solid.
    if (s.flatUntilDepth && s.tool !== 'plane' && s.max[1] - s.min[1] < 1e-6) {
      const d = Math.max(Math.min(s.max[0] - s.min[0], s.max[2] - s.min[2]), 1e-2) / 2;
      s.min[1] -= d;
      s.max[1] += d;
      this.buildPrim(s);
      this.commitPrim(s);
    }
    this.session = null;
    // With symmetry on in Blockout, a piece off the centre line gets its other side as it's finished.
    const gid = s.groupId;
    if (ed.workspace === 'block' && ed.mirrorX && gid !== null) ed.transact('Mirror piece', (m) => { mirrorPiece(m, gid); });
    status('');
    this.invalidate();
  }

  /** Remove the primitive being drawn. */
  removePrim() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    for (let i = 0; i < s.steps; i++) ed.undo();
    status('');
    this.invalidate();
  }

  get drawingPrim() { return this.session !== null; }

  /** Rebuild with the current detail settings. */
  refreshPrim() {
    const s = this.session;
    if (!s || this.drag) return;
    this.buildPrim(s);
    this.commitPrim(s);
  }

  /** Arrow keys while drawing: Left and Right change horizontal segments, Up and Down vertical ones. */
  adjustPrimSegments(horizontal: number, vertical: number) {
    const s = this.session;
    if (!s) return;
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const amount = horizontal + vertical;
    switch (s.tool) {
      case 'box': ed.primBoxSeg = clamp(ed.primBoxSeg + amount, 1, 32); break;
      case 'stairs': ed.primSteps = clamp(ed.primSteps + amount, 1, 64); break;
      case 'geosphere': ed.primSubdiv = clamp(ed.primSubdiv + amount, 0, 5); break;
      case 'plane': ed.primSubdiv = clamp(ed.primSubdiv + amount, 1, 64); break;
      case 'sphere': case 'torus': case 'capsule': case 'limb': case 'part':
        ed.primSegments = clamp(ed.primSegments + horizontal, 3, 128);
        ed.primRings = clamp(ed.primRings + vertical, 3, 96);
        break;
      case 'cylinder': case 'cone': case 'tapered':
        ed.primSegments = clamp(ed.primSegments + horizontal, 3, 128);
        ed.primStacks = clamp(ed.primStacks + vertical, 1, 64);
        break;
      default: return;
    }
    this.refreshPrim();
    ed.emit('tool');
  }

  private primShape(tool: string): { prim: prims.Prim; name: string } {
    const seg = ed.primSegments, rings = ed.primRings, r = 0.5;
    const facet = (p: prims.Prim): prims.Prim => (ed.lowPoly ? { ...p, smooth: false } : p);
    switch (tool) {
      case 'sphere': return { prim: facet(prims.sphere(r, seg, rings)), name: 'Sphere' };
      case 'geosphere': return { prim: facet(prims.geosphere(r, ed.primSubdiv)), name: 'GeoSphere' };
      case 'cylinder': return { prim: facet(prims.cylinder(r, r, r * 2, seg, ed.primStacks)), name: 'Cylinder' };
      case 'cone': return { prim: facet(prims.cylinder(0, r, r * 2, seg, ed.primStacks)), name: 'Cone' };
      case 'pyramid': return { prim: prims.pyramid(r * 2, r * 2), name: 'Pyramid' };
      case 'capsule': return { prim: facet(prims.capsule(r, r * 3, seg, rings)), name: 'Capsule' };
      case 'limb': return { prim: facet(prims.capsule(r, r * 3, seg, rings)), name: 'Limb' };
      case 'part': return { prim: partPrim(ed.partKind, seg, ed.lowPoly ? Math.max(3, rings - 1) : Math.max(8, rings), !ed.lowPoly), name: PARTS[ed.partKind].label };
      case 'tapered': return { prim: facet(prims.cylinder(r * 0.6, r, r * 2, seg, ed.primStacks)), name: 'Tapered' };
      case 'wedge': return { prim: prims.wedge(), name: 'Wedge' };
      case 'stairs': return { prim: prims.stairs(ed.primSteps), name: 'Stairs' };
      case 'doorway': return { prim: prims.doorway(), name: 'Doorway' };
      case 'plane': return { prim: prims.plane(r * 2, r * 2, Math.max(1, Math.round(ed.primSubdiv))), name: 'Plane' };
      case 'torus': return { prim: facet(prims.torus(r, r * 0.33, seg, Math.max(6, rings))), name: 'Torus' };
      default: return { prim: prims.box(r * 2, r * 2, r * 2, ed.primBoxSeg), name: 'Box' };
    }
  }

  private selectNewPrim(res: { groupId: number; faces: number[]; verts: number[] }) {
    const m = ed.model;
    ed.activeGroup = res.groupId;
    ed.clearSelection();
    if (ed.mode === 'bone') ed.mode = 'face';
    if (ed.mode === 'vertex') res.verts.forEach((v) => ed.selVerts.add(v));
    else if (ed.mode === 'edge') {
      res.faces.forEach((fi) => { const f = m.faces[fi]; f.v.forEach((a, i) => ed.selEdges.add(edgeKey(a, f.v[(i + 1) % f.v.length]))); });
    } else res.faces.forEach((f) => ed.selFaces.add(f));
  }

  /** Create a primitive at a point, as the palette commands do. */
  createPrim(tool: string, c: V3) {
    const { prim, name } = this.primShape(tool);
    this.selectNewPrim(ops.addPrim(ed.model, prim, name, { material: ed.activeMaterial, center: c }));
  }

  private placeJoint(p: Pane, x: number, y: number) {
    const parent = ed.activeBone;
    const parentBone = ed.model.bones.find((b) => b.id === parent);
    const through = parentBone ? new THREE.Vector3(...parentBone.head) : new THREE.Vector3();
    const w = p.planePoint(x, y, through);
    if (ed.snap) this.snapV(w);
    if (!p.isOrtho && !parentBone) {
      const hit = pick.pickFace(p, this.sg, x, y, true);
      if (hit) w.copy(hit.point);
    }
    let id = 0;
    ed.transact('Add joint', (m) => {
      id = m.nextId++;
      const bone: Bone = { id, name: uniqueName(m.bones.map((b) => b.name), m.bones.length ? 'Bone' : 'Root'), parent: parent ?? null, head: [w.x, w.y, w.z] };
      m.bones.push(bone);
    });
    ed.activeBone = id;
    ed.selBones = new Set([id]);
    ed.mode = 'bone';
    ed.emit('selection', 'skeleton', 'tool');
    status('Click to chain another joint. Esc to stop and select a different parent.');
  }

  // ---------- weight paint ----------
  private paintAt(p: Pane, x: number, y: number, e: PointerEvent) {
    const bone = ed.activeBone;
    if (bone === null) return;
    const d0 = this.drag;
    if (d0?.kind !== 'paint') return;
    const P = ed.displayPositions();
    const r = ed.brush.radius;
    const strength = ed.brush.strength;
    const sub = ed.brush.mode === 'sub' || e.shiftKey;
    const smooth = ed.brush.mode === 'smooth' || e.ctrlKey;
    const seeThrough = ed.brush.through || ed.xray || p.shading === 'wire';
    const m = ed.model;
    const list = this.sg.visibleVerts;
    const at = new THREE.Vector3();
    for (let i = 0; i < list.length; i++) {
      const v = list[i];
      const s = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
      const d = Math.hypot(s.x - x, s.y - y);
      if (d > r) continue;
      // The brush paints the surface it's over, not whatever lies behind it.
      if (!seeThrough && pick.occluded(p, this.sg, at.fromArray(P, v * 3))) continue;
      const fall = 1 - d / r;
      const amount = strength * fall * fall;
      if (smooth) smoothVertexWeight(m, v, d0.neighbors, Math.min(1, amount * 2));
      else paintWeight(m, v, bone, sub ? 0 : 1, amount);
      const twin = d0.mirror?.vert.get(v);
      if (twin !== undefined && twin !== v) {
        if (smooth) smoothVertexWeight(m, twin, d0.neighbors, Math.min(1, amount * 2));
        else paintWeight(m, twin, d0.mirror!.bone.get(bone) ?? bone, sub ? 0 : 1, amount);
      }
    }
    this.sg.updateWeights();
    ed.emit('geometry');
    this.mouse = { x, y, inside: true };
  }

  // ---------- framing ----------
  frameSelected(all = false) {
    const pts: V3[] = [];
    const P = ed.displayPositions();
    if (!all) {
      if (ed.mode === 'bone') {
        const pose = ed.bonePose();
        ed.selBones.forEach((id) => { const bp = pose.get(id); if (bp) pts.push(bp.pos); });
      } else ed.selectedVertexSet().forEach((v) => pts.push([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]));
    }
    if (!pts.length) {
      for (let i = 0; i < P.length; i += 3) pts.push([P[i], P[i + 1], P[i + 2]]);
      ed.bonePose().forEach((bp) => pts.push(bp.pos));
    }
    if (!pts.length) pts.push([0, 0, 0], [1, 1, 1]);
    const b = bounds(pts);
    const radius = Math.max(dist3(b.min, b.max) / 2, 0.1);
    for (const p of this.panes) p.frame(b.center, radius);
    this.invalidate();
  }
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);

/** LightWave's Alt mouse navigation. */
function altDragKind(p: Pane, e: PointerEvent): 'orbit' | 'bank' | 'pan' | 'panGround' | 'panVertical' | 'zoom' {
  if (e.ctrlKey) return 'zoom';
  if (p.isOrtho) return 'pan';
  if (e.shiftKey) return e.button === 2 ? 'panVertical' : 'panGround';
  return e.button === 2 ? 'bank' : 'orbit';
}

export { faceNormal, parseEdge };
