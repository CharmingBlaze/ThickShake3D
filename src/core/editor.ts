// The Editor owns the document, selection, undo history, and change notifications.
import { edgeKey, parseEdge } from './geom';
import { evalPose, skinInto, type BonePose } from './skeleton';
import { type Clip, type Model, cloneModel, emptyModel } from './types';

export type ChangeKind = 'topology' | 'geometry' | 'selection' | 'materials' | 'groups' | 'skeleton' | 'anim' | 'time' | 'tool' | 'view' | 'file' | 'history';
export type SelMode = 'vertex' | 'edge' | 'face' | 'group' | 'bone';
export type ToolId = 'select' | 'move' | 'rotate' | 'scale' | 'extrude' | 'vertex' | 'face' | 'box' | 'sphere' | 'geosphere' | 'cylinder' | 'cone' | 'pyramid' | 'plane' | 'torus' | 'limb' | 'part' | 'stroke' | 'blob' | 'pen' | 'lathe' | 'sculpt' | 'capsule' | 'tapered' | 'wedge' | 'stairs' | 'doorway' | 'joint' | 'ik' | 'paint' | 'loopcut' | 'knife' | 'texpaint' | 'tile' | 'bend';
export type Workspace = 'block' | 'model' | 'uv' | 'paint' | 'tiles' | 'rig' | 'animate';

export interface OpParam { key: string; label: string; type: 'number' | 'bool' | 'choice'; value: any; min?: number; max?: number; step?: number; options?: [any, string][] }

export interface LastOp {
  label: string;
  params: OpParam[];
  run: (m: Model, values: Record<string, any>) => void;
  /** Model snapshot taken before the op first ran. */
  base: Model;
  baseSel: SelSnapshot;
}

interface SelSnapshot { verts: number[]; faces: number[]; edges: string[]; bones: number[]; mode: SelMode; }
interface HistoryEntry { label: string; model: Model; sel: SelSnapshot }

const MAX_UNDO = 256;

export class Editor {
  model: Model = emptyModel();
  // Selection
  mode: SelMode = 'face';
  selVerts = new Set<number>();
  selFaces = new Set<number>();
  selEdges = new Set<string>();
  selBones = new Set<number>();
  // Context
  tool: ToolId = 'select';
  workspace: Workspace = 'model';
  activeGroup: number | null = null;
  activeMaterial: number | null = null;
  activeBone: number | null = null;
  activeClip: number | null = null;
  frame = 0;
  playing = false;
  /** When true, meshes show the animated pose and transforms write keys. */
  pose = false;
  testPose = false;
  testClip: Clip = { id: -1, name: 'Test pose', fps: 30, length: 0, loop: false, tracks: {} };
  moveJointChildren = false;
  ikChain = 2;
  ikHold = true;
  onion = false;
  trail = true;
  lastOp: LastOp | null = null;
  // Options
  snap = false;
  snapStep = 0.25;
  snapAngle = 15;
  mirrorX = false;
  xray = false;
  /** Draw the backs of faces in a tint of their own, so faces pointing the wrong way show. */
  showBack = true;
  showBones = true;
  showBoneNames = false;
  showGrid = true;
  showVerts = true;
  showWire = true;
  transformOrientation: 'world' = 'world';
  primSegments = 16;
  primRings = 10;
  primSubdiv = 2;
  primBoxSeg = 1;
  primSteps = 6;
  /** A limb's width as a share of its length. */
  limbThickness = 0.35;
  /** Which character part the Part tool draws, and how much wider or narrower than its usual shape. */
  partKind = 'head';
  partThickness = 1;
  /** Tube tool: radius in metres, and how much it narrows toward the far end from 0 to 1. */
  strokeRadius = 0.12;
  strokeTaper = 0;
  /** Silhouette tool: how deep a shape is, as a share of its width. */
  blobDepth = 0.8;
  /** Sculpt brush. Grab drags the surface, Inflate swells it, Smooth evens it out. */
  sculpt = { mode: 'grab' as 'grab' | 'inflate' | 'smooth' | 'flatten' | 'pinch', radius: 60, strength: 0.5 };
  blockDims = false;
  /** Pieces drawn see-through, so a reference image shows behind them. */
  blockGhost = false;
  refActive: number | null = null;
  /** Dragging in the view moves and scales the active reference image. */
  refEdit = false;
  refsInPersp = true;
  figure = { show: false, height: 1.8, pos: [-1.5, 0, 0] as [number, number, number] };
  primStacks = 1;
  lowPoly = false;
  drawOnSurface = false;
  private highPolyPrims: { seg: number; rings: number; subdiv: number; box: number; stacks: number } | null = null;
  brush = { radius: 40, strength: 0.25, mode: 'add' as 'add' | 'sub' | 'smooth', through: false };
  // File
  filePath: string | null = null;
  fileName = 'Untitled';
  dirty = false;
  // History
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private pending: HistoryEntry | null = null;
  // Events
  private listeners = new Map<ChangeKind, Set<(k: ChangeKind) => void>>();
  // Pose cache
  private posedBuf = new Float32Array(0);
  private posedValid = false;
  private poseCache: Map<number, BonePose> | null = null;

  on(kinds: ChangeKind | ChangeKind[], fn: (k: ChangeKind) => void) {
    for (const k of Array.isArray(kinds) ? kinds : [kinds]) {
      if (!this.listeners.has(k)) this.listeners.set(k, new Set());
      this.listeners.get(k)!.add(fn);
    }
  }
  emit(...kinds: ChangeKind[]) {
    if (kinds.some((k) => k === 'topology' || k === 'geometry' || k === 'skeleton' || k === 'anim' || k === 'time')) this.invalidatePose();
    const called = new Set<(k: ChangeKind) => void>();
    for (const k of kinds) {
      this.listeners.get(k)?.forEach((fn) => { if (!called.has(fn)) { called.add(fn); fn(k); } });
    }
  }

  /** Low Poly swaps in minimal detail for new primitives, and restores the old values when turned off. */
  setLowPoly(on: boolean) {
    if (on === this.lowPoly) return;
    this.lowPoly = on;
    if (on) {
      this.highPolyPrims = { seg: this.primSegments, rings: this.primRings, subdiv: this.primSubdiv, box: this.primBoxSeg, stacks: this.primStacks };
      this.primSegments = 8; this.primRings = 6; this.primSubdiv = 0; this.primBoxSeg = 1; this.primStacks = 1;
    } else if (this.highPolyPrims) {
      const s = this.highPolyPrims;
      this.primSegments = s.seg; this.primRings = s.rings; this.primSubdiv = s.subdiv; this.primBoxSeg = s.box; this.primStacks = s.stacks;
    }
  }

  // ---------- transactions ----------
  private snapSel(): SelSnapshot {
    return { verts: [...this.selVerts], faces: [...this.selFaces], edges: [...this.selEdges], bones: [...this.selBones], mode: this.mode };
  }
  private restoreSel(s: SelSnapshot) {
    this.selVerts = new Set(s.verts); this.selFaces = new Set(s.faces); this.selEdges = new Set(s.edges); this.selBones = new Set(s.bones);
    this.mode = s.mode;
  }
  /** Start an undoable edit. Pair with commit() or cancel(). */
  begin(label: string) {
    if (this.pending) this.commit();
    this.pending = { label, model: cloneModel(this.model), sel: this.snapSel() };
  }
  commit() {
    if (!this.pending) return;
    this.undoStack.push(this.pending);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
    this.redoStack = [];
    this.pending = null;
    this.dirty = true;
    this.emit('history', 'file');
  }
  cancel() {
    if (!this.pending) return;
    this.model = this.pending.model;
    this.restoreSel(this.pending.sel);
    this.pending = null;
    this.emitAll();
  }
  /** Run a one-shot undoable edit and refresh everything it could affect. */
  transact(label: string, fn: (m: Model) => void) {
    this.lastOp = null;
    this.begin(label);
    try { fn(this.model); } catch (e) { this.cancel(); throw e; }
    this.commit();
    this.sanitize();
    this.emitAll();
  }
  /** Run an op with adjustable parameters: the "last op" panel can re-run it from the same base. */
  runOp(label: string, params: OpParam[], run: LastOp['run']) {
    this.begin(label);
    const base = cloneModel(this.model);
    const baseSel = this.snapSel();
    const values = Object.fromEntries(params.map((p) => [p.key, p.value]));
    try { run(this.model, values); } catch (e) { this.cancel(); throw e; }
    this.commit();
    this.lastOp = { label, params, run, base, baseSel };
    this.sanitize();
    this.emitAll();
  }
  /** Re-apply the last op to its original base, for when something it reads from outside has changed. */
  rerunLastOp() {
    const op = this.lastOp;
    if (!op) return;
    this.model = cloneModel(op.base);
    this.restoreSel(op.baseSel);
    op.run(this.model, Object.fromEntries(op.params.map((x) => [x.key, x.value])));
    this.sanitize();
    this.dirty = true;
    this.emitAll();
  }

  /** Change a parameter of the last op and re-apply it to its original base. */
  adjustLastOp(key: string, value: any) {
    const op = this.lastOp;
    if (!op) return;
    const p = op.params.find((x) => x.key === key);
    if (p) p.value = value;
    this.model = cloneModel(op.base);
    this.restoreSel(op.baseSel);
    op.run(this.model, Object.fromEntries(op.params.map((x) => [x.key, x.value])));
    this.sanitize();
    this.dirty = true;
    this.emitAll();
  }

  /** Fold the latest undo step into the one before it, so a burst of small edits undoes in one go. */
  squashLast() {
    if (this.undoStack.length >= 2) this.undoStack.pop();
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.label ?? ''; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.label ?? ''; }
  get historyDepth() { return this.undoStack.length; }
  get historyLabels() { return this.undoStack.map((h) => h.label); }

  undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    this.redoStack.push({ label: e.label, model: this.model, sel: this.snapSel() });
    this.model = e.model;
    this.restoreSel(e.sel);
    this.lastOp = null;
    this.dirty = true;
    this.sanitize();
    this.emitAll();
  }
  redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    this.undoStack.push({ label: e.label, model: this.model, sel: this.snapSel() });
    this.model = e.model;
    this.restoreSel(e.sel);
    this.lastOp = null;
    this.dirty = true;
    this.sanitize();
    this.emitAll();
  }

  emitAll() {
    this.emit('topology', 'geometry', 'selection', 'materials', 'groups', 'skeleton', 'anim', 'history', 'file');
  }

  /** Clamp cached references after anything that could remove things. */
  sanitize() {
    const m = this.model;
    const keepIf = <T>(s: Set<T>, ok: (x: T) => boolean) => { for (const x of s) if (!ok(x)) s.delete(x); };
    keepIf(this.selVerts, (i) => i < m.verts.length);
    keepIf(this.selFaces, (i) => i < m.faces.length);
    keepIf(this.selEdges, (k) => { const [a, b] = parseEdge(k); return a < m.verts.length && b < m.verts.length; });
    keepIf(this.selBones, (id) => m.bones.some((b) => b.id === id));
    if (this.activeGroup !== null && !m.groups.some((g) => g.id === this.activeGroup)) this.activeGroup = m.groups[0]?.id ?? null;
    if (this.activeGroup === null && m.groups.length) this.activeGroup = m.groups[0].id;
    if (this.activeMaterial !== null && !m.materials.some((x) => x.id === this.activeMaterial)) this.activeMaterial = m.materials[0]?.id ?? null;
    if (this.activeMaterial === null && m.materials.length) this.activeMaterial = m.materials[0].id;
    if (this.activeBone !== null && !m.bones.some((b) => b.id === this.activeBone)) this.activeBone = null;
    if (this.activeClip !== null && !m.clips.some((c) => c.id === this.activeClip)) this.activeClip = m.clips[0]?.id ?? null;
    if (this.activeClip === null && m.clips.length) this.activeClip = m.clips[0].id;
  }

  /** Replace the document (new / open). Clears history. */
  loadModel(model: Model, path: string | null, name: string) {
    this.model = model;
    this.undoStack = []; this.redoStack = []; this.pending = null; this.lastOp = null;
    this.selVerts.clear(); this.selFaces.clear(); this.selEdges.clear(); this.selBones.clear();
    this.activeGroup = null; this.activeMaterial = null; this.activeBone = null; this.activeClip = null;
    this.frame = 0; this.playing = false;
    this.filePath = path; this.fileName = name; this.dirty = false;
    this.sanitize();
    this.emitAll();
  }

  // ---------- selection helpers ----------
  clearSelection() {
    this.selVerts.clear(); this.selFaces.clear(); this.selEdges.clear(); this.selBones.clear();
  }
  setMode(mode: SelMode) {
    if (mode === this.mode) return;
    const old = this.mode;
    // Carry selection across modes where it means the same thing.
    const verts = this.selectedVertexSet();
    this.mode = mode;
    if (old !== 'bone' && mode !== 'bone') {
      this.selFaces.clear(); this.selEdges.clear(); this.selVerts.clear();
      if (mode === 'vertex') this.selVerts = verts;
      else if (mode === 'face' || mode === 'group') {
        this.model.faces.forEach((f, i) => { if (f.v.every((v) => verts.has(v))) this.selFaces.add(i); });
        if (mode === 'group') this.expandFacesToGroups();
      } else if (mode === 'edge') {
        for (const f of this.model.faces) for (let i = 0; i < f.v.length; i++) {
          const a = f.v[i], b = f.v[(i + 1) % f.v.length];
          if (verts.has(a) && verts.has(b)) this.selEdges.add(edgeKey(a, b));
        }
      }
    }
    this.emit('selection', 'tool');
  }
  expandFacesToGroups() {
    const groups = new Set<number>();
    this.selFaces.forEach((fi) => groups.add(this.model.faces[fi].g));
    this.model.faces.forEach((f, i) => { if (groups.has(f.g)) this.selFaces.add(i); });
  }
  /** All vertices affected by the current selection, whatever the mode. */
  selectedVertexSet(): Set<number> {
    const s = new Set<number>();
    if (this.mode === 'vertex') this.selVerts.forEach((v) => s.add(v));
    else if (this.mode === 'edge') this.selEdges.forEach((k) => { const [a, b] = parseEdge(k); s.add(a); s.add(b); });
    else if (this.mode === 'face' || this.mode === 'group') this.selFaces.forEach((fi) => this.model.faces[fi]?.v.forEach((v) => s.add(v)));
    return s;
  }
  /** Faces targeted by the selection. Vertex/edge modes count faces fully covered. */
  selectedFaceSet(fallbackAll = false): Set<number> {
    let out = new Set<number>();
    if (this.mode === 'face' || this.mode === 'group') out = new Set(this.selFaces);
    else if (this.mode !== 'bone') {
      const v = this.selectedVertexSet();
      this.model.faces.forEach((f, i) => { if (f.v.every((x) => v.has(x))) out.add(i); });
    }
    if (!out.size && fallbackAll) this.model.faces.forEach((_, i) => { if (!this.isFaceHidden(i)) out.add(i); });
    return out;
  }
  isFaceHidden(fi: number) {
    const g = this.model.groups.find((x) => x.id === this.model.faces[fi].g);
    return !!g && !g.visible;
  }
  selectionCount(): number {
    switch (this.mode) {
      case 'vertex': return this.selVerts.size;
      case 'edge': return this.selEdges.size;
      case 'bone': return this.selBones.size;
      default: return this.selFaces.size;
    }
  }

  // ---------- pose ----------
  clip(): Clip | null {
    if (this.testPose) return this.testClip;
    return this.model.clips.find((c) => c.id === this.activeClip) ?? null;
  }
  get poseActive() { return (this.pose || this.testPose) && this.model.bones.length > 0; }
  /** Try joints out while rigging, in a throwaway pose that's never saved, exported or put on the undo stack. */
  setTestPose(on: boolean) {
    this.testPose = on;
    this.invalidatePose();
  }
  resetTestPose() {
    this.testClip = { id: -1, name: 'Test pose', fps: 30, length: 0, loop: false, tracks: {} };
    this.invalidatePose();
  }
  invalidatePose() { this.posedValid = false; this.poseCache = null; }
  bonePose(): Map<number, BonePose> {
    if (!this.poseCache) this.poseCache = evalPose(this.model, this.poseActive ? this.clip() : null, this.frame);
    return this.poseCache;
  }
  /** Current display positions packed x,y,z. Skinned when pose mode is on. */
  displayPositions(): Float32Array {
    const m = this.model;
    const n = m.verts.length * 3;
    if (this.posedBuf.length !== n) { this.posedBuf = new Float32Array(n); this.posedValid = false; }
    if (this.posedValid) return this.posedBuf;
    if (this.poseActive && this.clip()) skinInto(m, this.bonePose(), this.posedBuf);
    else {
      for (let i = 0; i < m.verts.length; i++) {
        const p = m.verts[i].p;
        this.posedBuf[i * 3] = p[0]; this.posedBuf[i * 3 + 1] = p[1]; this.posedBuf[i * 3 + 2] = p[2];
      }
    }
    this.posedValid = true;
    return this.posedBuf;
  }
}

export const ed = new Editor();
