// Every user-facing action lives here: menus, shortcuts, the palette and panels all call the same commands.
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import { viewBasis } from '../view/pane';
import * as anim from '../core/anim';
import { addStarter, alignPieces, arrayPieces, colorsToMaterials, deformPiece, dropPieces, fusePieces, mirrorPiece, pieceBounds, radialPieces, reducePiece, snapPieces, twinOf } from '../core/blockout';
import { PARTS } from '../core/organic';
import * as THREE from 'three';
import { decimate } from '../core/decimate';
import { ed, type SelMode, type ToolId, type Workspace } from '../core/editor';
import { bounds, edgeFaces, edgeKey, faceNormal, parseEdge } from '../core/geom';
import * as ops from '../core/ops';
import * as mt from '../core/meshtools';
import * as prims from '../core/primitives';
import { buildSample } from '../core/sample';
import { addHumanoid, autoWeights, ensureTrack, heatWeights, keyFrames, mirrorJoints, mirrorWeights, pruneWeights, removeJoints, sampleTrack, setKey, smoothWeights, splitJoint, weightIssues } from '../core/skeleton';
import { emptyModel, makeGroup, makeMaterial, newId, uniqueName, type Clip, type Model, type RefImage, type V2, type V3 } from '../core/types';
import * as uv from '../core/uv';
import { IMPORT_EXTS, importFile, mergeInto } from '../io/importer';
import { autosave, clearRecent, native, openFile, openRecent, pushRecent, recentFiles, saveFile } from '../io/platform';
import { parseProject, serializeProject } from '../io/project';
import type { ViewKind } from '../view/pane';
import { app } from './app';
import { modal, reportError, status, toast } from './feedback';
import { h } from './dom';
import { openAbout, openExportDialog, openShortcuts } from './dialogs';
import { openPalette } from './palette';
import { glyph } from './glyphs';
import { openKeymapEditor } from './keymap';
import { makeAtlas, openBakeDialog } from './gameTools';

export interface Command {
  id: string;
  label: string;
  key?: string;
  run: () => void | Promise<void>;
  enabled?: () => boolean;
  checked?: () => boolean;
  hint?: string;
}

export const commands = new Map<string, Command>();
const def = (id: string, label: string, run: Command['run'], extra: Partial<Command> = {}) => {
  commands.set(id, { id, label, run, ...extra });
};

export function runCommand(id: string) {
  const c = commands.get(id);
  if (!c) return;
  if (c.enabled && !c.enabled()) return;
  if (ed.testPose && id.startsWith('anim.')) { toast('Turn off Test Pose to animate.', 'info'); return; }
  try {
    // Most commands finish a primitive that's still being drawn before they run.
    if (!/^(view\.|tool\.|help\.|escape$|enter$|edit\.(undo|redo)|create\.(lowPoly|onSurface)$)/.test(id)) app.vp?.dropPrim();
    const r = c.run();
    if (r instanceof Promise) r.catch((e) => reportError(c.label, e));
  } catch (e) { reportError(c.label, e); }
}

const hasFaces = () => ed.selectedFaceSet().size > 0;
const hasVerts = () => ed.selectedVertexSet().size > 0;
const hasAnyMesh = () => ed.model.faces.length > 0;
const notPose = () => !ed.poseActive;
const need = (ok: boolean, msg: string) => { if (!ok) toast(msg, 'info'); return ok; };

// ---------- file ----------
const PROJECT_FILTER = { name: 'ThickShake project', extensions: ['tshake'] };

export async function confirmDiscard(): Promise<boolean> {
  if (!ed.dirty) return true;
  const r = await modal('Save changes?', `"${ed.fileName}" has unsaved changes.`, [
    { label: 'Cancel', value: 'cancel' },
    { label: "Don't save", danger: true, value: 'discard' },
    { label: 'Save', primary: true, value: 'save' },
  ]);
  if (r === 'save') return saveProject(false);
  return r === 'discard';
}

export async function saveProject(forceDialog: boolean): Promise<boolean> {
  const text = serializeProject(ed.model);
  const data = new TextEncoder().encode(text);
  const name = /\.tshake$/.test(ed.fileName) ? ed.fileName : `${ed.fileName}.tshake`;
  const res = await saveFile({ path: forceDialog ? null : ed.filePath, defaultName: name, filters: [PROJECT_FILTER], data });
  if (!res) return false;
  ed.filePath = res.path; ed.fileName = res.name; ed.dirty = false;
  void pushRecent(res.path, res.name, text);
  await autosave.clear();
  ed.emit('file');
  toast(`Saved ${res.name}`, 'ok', 1800);
  return true;
}

/** Pick from the projects opened or saved lately. */
async function openRecentDialog() {
  const list = recentFiles();
  if (!list.length) { toast(native ? 'No recent projects yet.' : 'No recent projects yet. Projects you open or save are kept here, in this browser.', 'info'); return; }
  const ago = (t: number) => {
    if (!t) return '';
    const s = (Date.now() - t) / 1000;
    return s < 90 ? 'just now' : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString();
  };
  let chosen: (typeof list)[number] | null = null;
  const rows = list.map((e) => h('button', {
    class: 'recent-row', title: e.path ?? 'Kept in this browser',
    onclick: () => { chosen = e; (document.querySelector('.modal-back footer .btn-primary') as HTMLElement | null)?.click(); },
  }, h('strong', null, e.name), h('span', { class: 'muted small' }, [e.path ? e.path.replace(/[\\/][^\\/]*$/, '') : 'In this browser', ago(e.at)].filter(Boolean).join(' · '))));
  const r = await modal('Open recent', h('div', { class: 'recent-list' }, rows), [
    { label: 'Clear list', value: 'clear', danger: true },
    { label: 'Cancel', value: 'cancel' },
    { label: 'Open', primary: true, value: 'open', run: () => !!chosen },
  ], { width: 460 });
  if (r === 'clear') { clearRecent(); toast('Cleared the recent list.', 'ok'); return; }
  if (r !== 'open' || !chosen) return;
  if (!(await confirmDiscard())) return;
  const f = await openRecent(chosen);
  if (!f) { toast(`${(chosen as { name: string }).name} isn't there any more.`, 'warn'); return; }
  await loadOpened(f.name, f.path, f.data).catch((e) => reportError('Open failed', e));
}

export async function loadOpened(name: string, path: string | null, data: ArrayBuffer) {
  if (/\.tshake$/i.test(name)) {
    const text = new TextDecoder().decode(data);
    ed.loadModel(parseProject(text), path, name);
    void pushRecent(path, name, text);
  } else {
    const model = await importFile(name, data);
    ed.loadModel(model, null, name.replace(/\.[^.]+$/, ''));
    ed.dirty = true;
    ed.emit('file');
  }
  app.vp.frameSelected(true);
  toast(`Opened ${name}: ${ed.model.faces.length.toLocaleString()} faces${ed.model.bones.length ? `, ${ed.model.bones.length} bones` : ''}${ed.model.clips.length ? `, ${ed.model.clips.length} clips` : ''}`, 'ok');
}

/** Bring a file into the current scene as extra groups. */
export async function mergeOpened(name: string, data: ArrayBuffer) {
  const model = /\.tshake$/i.test(name) ? parseProject(new TextDecoder().decode(data)) : await importFile(name, data);
  ed.transact(`Import ${name}`, (m) => mergeInto(m, model));
  app.vp.frameSelected(true);
  toast(`Imported ${name}`, 'ok');
}

def('file.new', 'New', async () => {
  if (!(await confirmDiscard())) return;
  ed.loadModel(emptyModel(), null, 'Untitled');
  app.vp.frameSelected(true);
}, { key: 'Ctrl+N' });
def('file.open', 'Open…', async () => {
  if (!(await confirmDiscard())) return;
  const f = await openFile([{ name: 'All supported', extensions: ['tshake', ...IMPORT_EXTS] }, PROJECT_FILTER]);
  if (f) await loadOpened(f.name, f.path, f.data);
}, { key: 'Ctrl+O' });
def('file.save', 'Save', () => { void saveProject(false); }, { key: 'Ctrl+S' });
def('file.saveAs', 'Save As…', () => { void saveProject(true); }, { key: 'Ctrl+Shift+S' });
def('file.saveCopy', 'Save a Copy…', async () => {
  // A snapshot under another name; the project carries on as it was, unsaved changes and all.
  const stem = ed.fileName.replace(/\.tshake$/i, '');
  const res = await saveFile({ path: null, defaultName: `${stem} copy.tshake`, filters: [PROJECT_FILTER], data: new TextEncoder().encode(serializeProject(ed.model)) });
  if (res) toast(`Saved a copy as ${res.name}. You're still working on ${ed.fileName}.`, 'ok');
}, { hint: 'Save the project to another file and keep working on this one' });
def('file.openRecent', 'Open Recent…', () => { void openRecentDialog(); }, { key: 'Ctrl+Shift+O' });
def('file.import', 'Import into Scene…', async () => {
  const f = await openFile([{ name: '3D models', extensions: ['tshake', ...IMPORT_EXTS] }]);
  if (f) await mergeOpened(f.name, f.data);
}, { key: 'Ctrl+I' });
def('file.export', 'Export…', () => openExportDialog(), { key: 'Ctrl+E' });
def('file.sample', 'Open Demo Milkshake', async () => {
  if (!(await confirmDiscard())) return;
  ed.loadModel(buildSample(), null, 'Demo Milkshake');
  app.vp.frameSelected(true);
});
if (native) def('file.quit', 'Exit', () => { window.close(); });

// ---------- history & selection ----------
def('edit.undo', 'Undo', () => {
  if (app.vp.pendingFace) { app.vp.clearPending(); return; }
  ed.undo();
}, { key: 'Ctrl+Z', enabled: () => ed.canUndo || app.vp.pendingFace > 0 });
def('edit.redo', 'Redo', () => ed.redo(), { key: 'Ctrl+Y', enabled: () => ed.canRedo });
commands.set('edit.redoAlt', { id: 'edit.redoAlt', label: 'Redo', key: 'Ctrl+Shift+Z', run: () => ed.redo(), enabled: () => ed.canRedo, hint: 'hidden' });

function selectAllOf(fill: boolean) {
  const m = ed.model;
  ed.clearSelection();
  if (fill) {
    const hidden = new Set(m.groups.filter((g) => !g.visible || g.locked).map((g) => g.id));
    switch (ed.mode) {
      case 'vertex': app.vp.sg.visibleVerts.forEach((v) => ed.selVerts.add(v)); break;
      case 'edge': for (let i = 0; i < app.vp.sg.edgeIndex.length; i += 2) ed.selEdges.add(edgeKey(app.vp.sg.edgeIndex[i], app.vp.sg.edgeIndex[i + 1])); break;
      case 'bone': m.bones.forEach((b) => ed.selBones.add(b.id)); break;
      default: m.faces.forEach((f, i) => { if (!hidden.has(f.g)) ed.selFaces.add(i); });
    }
  }
  ed.emit('selection');
}
def('select.all', 'Select All', () => selectAllOf(true), { key: 'Ctrl+A' });
def('select.none', 'Select None', () => selectAllOf(false), { key: 'Ctrl+D' });
def('select.invert', 'Invert Selection', () => {
  const m = ed.model;
  if (ed.mode === 'vertex') { const s = new Set<number>(); app.vp.sg.visibleVerts.forEach((v) => { if (!ed.selVerts.has(v)) s.add(v); }); ed.selVerts = s; }
  else if (ed.mode === 'edge') { const s = new Set<string>(); for (let i = 0; i < app.vp.sg.edgeIndex.length; i += 2) { const k = edgeKey(app.vp.sg.edgeIndex[i], app.vp.sg.edgeIndex[i + 1]); if (!ed.selEdges.has(k)) s.add(k); } ed.selEdges = s; }
  else if (ed.mode === 'bone') { const s = new Set<number>(); m.bones.forEach((b) => { if (!ed.selBones.has(b.id)) s.add(b.id); }); ed.selBones = s; }
  else { const s = new Set<number>(); m.faces.forEach((_, i) => { if (!ed.selFaces.has(i) && !ed.isFaceHidden(i)) s.add(i); }); ed.selFaces = s; }
  ed.emit('selection');
}, { key: 'Ctrl+Shift+I' });

function applyVertsToSelection(vs: Set<number>) {
  ed.selVerts.clear(); ed.selFaces.clear(); ed.selEdges.clear();
  if (ed.mode === 'vertex') ed.selVerts = vs;
  else if (ed.mode === 'edge') {
    for (const f of ed.model.faces) f.v.forEach((a, i) => { const b = f.v[(i + 1) % f.v.length]; if (vs.has(a) && vs.has(b)) ed.selEdges.add(edgeKey(a, b)); });
  } else ed.model.faces.forEach((f, i) => { if (f.v.every((v) => vs.has(v))) ed.selFaces.add(i); });
  if (ed.mode === 'group') ed.expandFacesToGroups();
  ed.emit('selection');
}
def('select.grow', 'Grow Selection', () => {
  const vs = ed.selectedVertexSet();
  const next = new Set(vs);
  for (const f of ed.model.faces) if (f.v.some((v) => vs.has(v))) f.v.forEach((v) => next.add(v));
  applyVertsToSelection(next);
}, { key: 'Ctrl+=' });
def('select.shrink', 'Shrink Selection', () => {
  const vs = ed.selectedVertexSet();
  const next = new Set(vs);
  for (const f of ed.model.faces) if (!f.v.every((v) => vs.has(v))) f.v.forEach((v) => next.delete(v));
  applyVertsToSelection(next);
}, { key: 'Ctrl+-' });
def('select.linked', 'Select Linked', () => {
  const m = ed.model;
  const seen = ed.selectedVertexSet();
  const vf = new Map<number, number[]>();
  m.faces.forEach((f, i) => f.v.forEach((v) => { const l = vf.get(v); if (l) l.push(i); else vf.set(v, [i]); }));
  const stack = [...seen];
  const facesDone = new Set<number>();
  while (stack.length) {
    const v = stack.pop()!;
    for (const fi of vf.get(v) ?? []) {
      if (facesDone.has(fi)) continue;
      facesDone.add(fi);
      for (const x of m.faces[fi].v) if (!seen.has(x)) { seen.add(x); stack.push(x); }
    }
  }
  applyVertsToSelection(seen);
}, { key: 'L' });
def('select.loop', 'Select Edge Loop', () => {
  if (!need(ed.mode === 'edge' && ed.selEdges.size > 0, 'Switch to Edge mode and select an edge first.')) return;
  [...ed.selEdges].forEach((k) => ops.edgeLoop(ed.model, k).forEach((e) => ed.selEdges.add(e)));
  ed.emit('selection');
}, { key: 'Alt+L' });
def('select.ring', 'Select Edge Ring', () => {
  if (!need(ed.mode === 'edge' && ed.selEdges.size > 0, 'Switch to Edge mode and select an edge first.')) return;
  [...ed.selEdges].forEach((k) => ops.edgeRing(ed.model, k).forEach((e) => ed.selEdges.add(e)));
  ed.emit('selection');
}, { key: 'Alt+R' });
def('select.boundary', 'Select Open Edges', () => {
  ed.setMode('edge');
  ed.selEdges.clear();
  edgeFaces(ed.model).forEach((l, k) => { if (l.length === 1) ed.selEdges.add(k); });
  ed.emit('selection');
});
def('select.similarNormal', 'Select Coplanar Faces', () => {
  if (!need(ed.selFaces.size > 0, 'Select a face first.')) return;
  const m = ed.model;
  const ns = [...ed.selFaces].map((i) => faceNormal(m, m.faces[i]));
  m.faces.forEach((f, i) => {
    const n = faceNormal(m, f);
    if (ns.some((x) => x[0] * n[0] + x[1] * n[1] + x[2] * n[2] > 0.999)) ed.selFaces.add(i);
  });
  ed.emit('selection');
});

const MODES: [SelMode, string, string][] = [['vertex', 'Vertex', '1'], ['edge', 'Edge', '2'], ['face', 'Face', '3'], ['group', 'Group', '4'], ['bone', 'Joint', '5']];
for (const [m, l, k] of MODES) def(`mode.${m}`, `${l} Mode`, () => ed.setMode(m), { key: k, checked: () => ed.mode === m });

// ---------- tools ----------
const DRAW_HINT = 'Drag out the shape in a view, then drag in another view for depth. Ctrl makes it symmetrical. Double-click to finish.';
export const TOOLS: { id: ToolId; label: string; key?: string; icon: string; group: string; hint: string }[] = [
  { id: 'select', label: 'Select', key: 'Q', group: 'edit', hint: 'Click or drag a box. Shift adds, Ctrl removes. Double-click an edge for its loop.', icon: glyph('cursor-select') },
  { id: 'move', label: 'Move', key: 'W', group: 'edit', hint: 'Drag an arrow, plane or the centre square. Ctrl toggles snapping.', icon: glyph('tool-move') },
  { id: 'rotate', label: 'Rotate', group: 'edit', hint: 'Drag a ring, or the outer circle to spin around the view. Ctrl toggles angle snapping.', icon: glyph('tool-rotate') },
  { id: 'scale', label: 'Scale', group: 'edit', hint: 'Drag a handle for one axis, or the centre square for uniform scale.', icon: glyph('tool-scale') },
  { id: 'extrude', label: 'Extrude', key: 'T', group: 'model', hint: 'Drag any face to pull it out or push it in, or click it and move. T over a view extrudes the selection and follows the mouse. Type a distance; double-click repeats the last one.', icon: glyph('tool-extrude') },
  { id: 'loopcut', label: 'Loop Cut', key: 'Ctrl+R', group: 'model', hint: 'Hover an edge to see the loop. Wheel or Page Up/Down changes the number of cuts. Click to place, move to slide, click again to confirm. Right click or Esc leaves it centred.', icon: glyph('tool-loopcut') },
  { id: 'knife', label: 'Knife', key: 'K', group: 'model', hint: 'Click to cut across faces, or drag to draw. Enter or Space confirms, Esc cancels, E new cut, double-click closes, Ctrl midpoints, Shift no snap, A angle, C cut through, X Y Z axis, S measure.', icon: glyph('tool-knife') },
  { id: 'bend', label: 'Bend', key: 'Shift+W', group: 'model', hint: 'Bend the selection along a curve, for organic shapes: select vertices, edges or faces (several pieces at once is fine), then drag the curve square ends and round handles. Twist, taper and ready-made curves are in the side panel. Alt drags an end without its handle; Esc or right click while dragging puts it back.', icon: '<path d="M4 20C5 11 12 13 20 4"/><path d="M4 20l6-9M20 4l-9 3" stroke-dasharray="2 2"/><rect x="2.5" y="18.5" width="3" height="3" fill="currentColor"/><rect x="18.5" y="2.5" width="3" height="3" fill="currentColor"/><circle cx="10" cy="11" r="1.5"/><circle cx="11" cy="7" r="1.5"/>' },
  { id: 'vertex', label: 'Vertex', group: 'model', hint: 'Click in a view to place a vertex.', icon: glyph('vertex-select') },
  { id: 'face', label: 'Face', group: 'model', hint: 'Build faces point by point in 3D: points land on the model under the mouse or on a plane through the last point. Click a vertex to use it, or an open edge to build from it. Enter or a double-click makes the face and finishes, so the next click starts a new mesh or carries on from any vertex or open edge; clicking the first point makes it and carries on beside it. Backspace or right click takes a point back, Esc stops, N ground plane, Alt draws freely.', icon: glyph('fill-face') },
  { id: 'box', label: 'Box', group: 'create', hint: DRAW_HINT, icon: glyph('mesh-cube') },
  { id: 'sphere', label: 'Sphere', group: 'create', hint: DRAW_HINT, icon: glyph('mesh-sphere') },
  { id: 'geosphere', label: 'GeoSphere', group: 'create', hint: DRAW_HINT, icon: glyph('mesh-icosphere') },
  { id: 'cylinder', label: 'Cylinder', group: 'create', hint: DRAW_HINT, icon: glyph('mesh-cylinder') },
  { id: 'cone', label: 'Cone', group: 'create', hint: DRAW_HINT, icon: glyph('mesh-cone') },
  { id: 'pyramid', label: 'Pyramid', group: 'create', hint: DRAW_HINT, icon: '<path d="M12 3L3 17l7 4 11-5z"/><path d="M12 3l-2 18M12 3l9 13"/>' },
  { id: 'plane', label: 'Plane', group: 'create', hint: DRAW_HINT, icon: glyph('mesh-plane') },
  { id: 'limb', label: 'Limb', group: 'block', hint: 'Drag from one end of a limb to the other: shoulder to elbow, hip to knee. Starting on a piece attaches it there.', icon: '<path d="M6 18L18 6" stroke-width="5" stroke-linecap="round"/><circle cx="6" cy="18" r="1" fill="currentColor"/>' },
  { id: 'part', label: 'Part', group: 'block', hint: 'Drag from one end of a character part to the other.', icon: '<path d="M12 3c-4 0-7 3-7 7.5 0 5 3.5 10.5 7 10.5s7-5.5 7-10.5C19 6 16 3 12 3z"/>' },
  { id: 'stroke', label: 'Tube', group: 'block', hint: 'Draw a line, freehand, and it becomes a rounded tube: tentacles, tails, hair, vines. Ctrl+wheel sets the thickness.', icon: '<path d="M4 19c4 0 3-7 7-7s4 5 9-7" stroke-width="3" stroke-linecap="round"/>' },
  { id: 'blob', label: 'Draw Shape', group: 'block', hint: 'Draw around any outline and it inflates into a rounded solid: a torso, a hand, a leaf, a rock.', icon: glyph('tool-shape-draw') },
  { id: 'pen', label: 'Pen Shape', group: 'block', hint: 'Draw an outline with curves, the way a vector pen does: click for a corner, drag for a curve, click the first point to close. Reshape it, then press Enter to inflate it into a rounded piece: a head, a hand, a body.', icon: glyph('tool-poly-draw') },
  { id: 'lathe', label: 'Lathe', group: 'block', hint: 'Draw half an outline, top to bottom, and it spins into a solid around the centre line: a torso, a head, a vase, a bottle.', icon: '<path d="M12 3v18" stroke-dasharray="2 2.5"/><path d="M12 4c5 0 7 3 5 7s2 5 1 7-3 2-6 2"/><path d="M12 4c-5 0-7 3-5 7s-2 5-1 7 3 2 6 2" opacity=".35"/>' },
  { id: 'sculpt', label: 'Sculpt', key: 'C', group: 'model', hint: 'Push the surface around with a soft brush: Grab, Inflate, Smooth, Flatten or Pinch. Shift reverses, Ctrl smooths, Ctrl+wheel resizes.', icon: '<path d="M15 3l6 6-9 9-7 3 3-7z"/><path d="M12 6l6 6"/>' },
  { id: 'capsule', label: 'Capsule', group: 'block', hint: DRAW_HINT, icon: '<rect x="7" y="3" width="10" height="18" rx="5"/><path d="M7 9c2 1.5 8 1.5 10 0M7 15c2 1.5 8 1.5 10 0"/>' },
  { id: 'tapered', label: 'Tapered', group: 'block', hint: DRAW_HINT, icon: '<ellipse cx="12" cy="6" rx="4.5" ry="2"/><path d="M7.5 6L5 18c0 1.7 3.1 3 7 3s7-1.3 7-3L16.5 6"/>' },
  { id: 'wedge', label: 'Wedge', group: 'block', hint: DRAW_HINT, icon: '<path d="M3 19h18L3 7z"/>' },
  { id: 'stairs', label: 'Stairs', group: 'block', hint: `${DRAW_HINT} Arrow keys change the step count.`, icon: '<path d="M3 20h18V5h-5v5h-5v5H6v5"/>' },
  { id: 'doorway', label: 'Doorway', group: 'block', hint: DRAW_HINT, icon: '<path d="M3 20V5h18v15h-6v-9H9v9z"/>' },
  { id: 'torus', label: 'Torus', group: 'create', hint: DRAW_HINT, icon: glyph('mesh-torus') },
  { id: 'joint', label: 'Joint', key: 'J', group: 'rig', hint: 'Click to add a joint chained from the active joint. Esc clears the parent.', icon: glyph('bone') },
  { id: 'ik', label: 'IK Drag', key: 'Y', group: 'rig', hint: 'Pose by pulling a joint: a hand or foot, and the limb follows. Joints sets how far up the chain bends.', icon: glyph('ik') },
  { id: 'paint', label: 'Weight Paint', key: 'B', group: 'rig', hint: 'Paint the active joint\'s influence. Shift subtracts. Ctrl+wheel resizes the brush.', icon: glyph('paint') },
];
for (const t of TOOLS) {
  def(`tool.${t.id}`, `${t.label} Tool`, () => {
    // T while building faces extrudes the selection and stays in the Face tool.
    if (t.id === 'extrude' && ed.tool === 'face' && ed.selectedFaceSet().size && app.vp.startExtrudeHere()) return;
    setTool(t.id);
    // As in Blender: T over a view, with faces selected, extrudes them straight away and they follow the mouse.
    if (t.id === 'extrude') app.vp.startExtrudeHere();
  }, { key: t.key, checked: () => ed.tool === t.id, hint: t.hint });
}

export function setTool(t: ToolId) {
  ed.tool = t;
  ed.refEdit = false; // Picking a tool means getting back to work on the model.
  if (t === 'joint' || (t === 'paint')) { if (t === 'joint') ed.setMode('bone'); }
  if (t === 'paint') { const p = app.vp.active; if (p.shading !== 'weights') { p.shading = 'weights'; app.vp.syncHeaders(); } }
  const info = TOOLS.find((x) => x.id === t);
  status(info?.hint ?? '');
  ed.emit('tool');
}

// ---------- mesh ----------
def('edit.delete', 'Delete', () => {
  if (ed.mode === 'bone') {
    if (!ed.selBones.size) return;
    ed.transact('Delete joints', (m) => {
      removeJoints(m, ed.selBones);
      ed.selBones.clear();
    });
    return;
  }
  if (!ed.selectionCount()) return;
  const mode = ed.mode;
  ed.transact('Delete', (m) => {
    if (mode === 'vertex') ops.removeVerts(m, new Set(ed.selVerts));
    else if (mode === 'edge') {
      const ef = edgeFaces(m);
      const fs = new Set<number>();
      ed.selEdges.forEach((k) => ef.get(k)?.forEach((f) => fs.add(f)));
      ops.removeFaces(m, fs);
    } else ops.removeFaces(m, new Set(ed.selFaces));
    ed.clearSelection();
    ops.pruneEmptyGroups(m);
  });
}, { key: 'Delete', enabled: notPose });
commands.set('edit.deleteAlt', { id: 'edit.deleteAlt', label: 'Delete', key: 'Backspace', run: () => runCommand('edit.delete'), hint: 'hidden' });

def('edit.duplicate', 'Duplicate', () => {
  if (ed.workspace === 'block') { runCommand('block.duplicate'); return; }
  const faces = ed.selectedFaceSet();
  if (!need(faces.size > 0, 'Select faces to duplicate.')) return;
  ed.transact('Duplicate', (m) => {
    const made = ops.duplicateFaces(m, faces);
    ed.clearSelection();
    ed.mode = ed.mode === 'bone' ? 'face' : ed.mode;
    if (ed.mode === 'vertex') made.forEach((f) => m.faces[f].v.forEach((v) => ed.selVerts.add(v)));
    else if (ed.mode === 'edge') made.forEach((fi) => { const f = m.faces[fi]; f.v.forEach((a, i) => ed.selEdges.add(edgeKey(a, f.v[(i + 1) % f.v.length]))); });
    else made.forEach((f) => ed.selFaces.add(f));
  });
  setTool('move');
}, { key: 'Shift+D', enabled: notPose });

// G, R and S, as in Blender: the selection follows the mouse until a click or Enter.
const MODAL_HELP = 'X Y Z lock an axis (Shift for the other two), type a number for an exact value. Click or Enter keeps it, Esc cancels.';
def('edit.moveHere', 'Move Selection', () => { app.vp.startModalHere('move'); }, { key: 'G', hint: `Move the selection with the mouse. ${MODAL_HELP}` });
def('edit.rotateHere', 'Rotate Selection', () => { app.vp.startModalHere('rotate'); }, { key: 'R', hint: `Turn the selection by circling the mouse around it. Typed numbers are degrees. ${MODAL_HELP}` });
def('edit.scaleHere', 'Scale Selection', () => { app.vp.startModalHere('scale'); }, { key: 'S', hint: `Scale the selection by moving the mouse away from it or toward it. ${MODAL_HELP}` });
/** A starting distance for an extrude from a menu or the panel: a quarter of the selection's size. */
function extrudeStep(verts: Iterable<number>): number {
  const m = ed.model;
  const size = bounds([...verts].map((v) => m.verts[v].p)).size;
  const d = Math.max(...size) * 0.25;
  return d > 1e-6 ? +d.toFixed(3) : 0.25;
}

/** Extrude the selected faces by a set distance, which stays adjustable in the last-operation panel. */
function extrudeFacesOp(faces: Set<number>) {
  const sel = new Set(faces);
  const mode = ed.mode === 'group' ? 'group' : 'face';
  ed.runOp('Extrude', [
    { key: 'distance', label: 'Distance', type: 'number', value: extrudeStep([...sel].flatMap((fi) => ed.model.faces[fi].v)), min: -100, max: 100, step: 0.01 },
    { key: 'along', label: 'Along vertex normals', type: 'bool', value: false },
  ], (m, v) => {
    const { top, normal, vertexNormals } = ops.extrudeFaces(m, sel);
    for (const i of top) {
      const n = v.along ? vertexNormals.get(i) ?? normal : normal;
      const p = m.verts[i].p;
      m.verts[i].p = [p[0] + n[0] * v.distance, p[1] + n[1] * v.distance, p[2] + n[2] * v.distance];
    }
    ed.mode = mode;
    ed.selFaces = new Set(sel);
  });
}

/** Extrude the selected edges by a set distance, out along the faces beside them. */
function extrudeEdgesOp(edges: Set<string>) {
  const sel = new Set(edges);
  const m0 = ed.model;
  // The way out: along the faces next to the edges, away from their middle, so an open rim grows outward.
  const ef = edgeFaces(m0);
  const dir = new THREE.Vector3();
  for (const k of sel) {
    const [a, b] = parseEdge(k);
    const mid = new THREE.Vector3(...m0.verts[a].p).add(new THREE.Vector3(...m0.verts[b].p)).multiplyScalar(0.5);
    for (const fi of ef.get(k) ?? []) {
      const f = m0.faces[fi];
      const c = new THREE.Vector3();
      f.v.forEach((v) => c.add(new THREE.Vector3(...m0.verts[v].p)));
      c.divideScalar(f.v.length);
      dir.add(mid.clone().sub(c).normalize());
    }
  }
  if (dir.lengthSq() < 1e-9) dir.set(0, 1, 0);
  dir.normalize();
  const verts = [...sel].flatMap((k) => parseEdge(k));
  const edgeMode = ed.mode === 'edge';
  ed.runOp('Extrude edges', [
    { key: 'distance', label: 'Distance', type: 'number', value: extrudeStep(verts), min: -100, max: 100, step: 0.01 },
    { key: 'x', label: 'Direction X', type: 'number', value: +dir.x.toFixed(3), min: -1, max: 1, step: 0.05 },
    { key: 'y', label: 'Direction Y', type: 'number', value: +dir.y.toFixed(3), min: -1, max: 1, step: 0.05 },
    { key: 'z', label: 'Direction Z', type: 'number', value: +dir.z.toFixed(3), min: -1, max: 1, step: 0.05 },
  ], (m, v) => {
    const made = mt.extrudeEdges(m, sel, activeGroupId(m));
    const d = new THREE.Vector3(v.x, v.y, v.z);
    if (d.lengthSq() < 1e-9) d.set(0, 1, 0);
    d.normalize().multiplyScalar(v.distance);
    for (const i of made.verts) { const p = m.verts[i].p; m.verts[i].p = [p[0] + d.x, p[1] + d.y, p[2] + d.z]; }
    ed.clearSelection();
    if (edgeMode) { ed.mode = 'edge'; made.edges.forEach((k) => ed.selEdges.add(k)); } else { ed.mode = 'vertex'; made.verts.forEach((i) => ed.selVerts.add(i)); }
  });
}

def('mesh.extrude', 'Extrude Faces', () => {
  setTool('extrude');
  const faces = ed.selectedFaceSet();
  if (faces.size && !app.vp.mouseInView) extrudeFacesOp(faces);
  else app.vp.startExtrudeHere();
}, { enabled: notPose });
def('mesh.extrudeHere', 'Extrude Selection', () => {
  // As Blender's E: faces push out along their normal, following the mouse; edges pull out into new faces and move
  // with the mouse. The tool in use stays. From a menu or the panel, a set distance, adjustable after.
  const faces = ed.selectedFaceSet();
  if (faces.size) { if (!app.vp.mouseInView) extrudeFacesOp(faces); else app.vp.startExtrudeHere(); return; }
  const edges = ed.mode === 'edge' ? new Set(ed.selEdges) : mt.edgesAmong(ed.model, ed.selectedVertexSet());
  if (!need(edges.size > 0, 'Select faces or edges to extrude.')) return;
  if (!app.vp.mouseInView) { extrudeEdgesOp(edges); return; }
  let made: { verts: number[]; edges: string[] } = { verts: [], edges: [] };
  ed.transact('Extrude edges', (m) => { made = mt.extrudeEdges(m, edges, activeGroupId(m)); });
  ed.clearSelection();
  if (ed.mode === 'edge') made.edges.forEach((k) => ed.selEdges.add(k)); else { ed.setMode('vertex'); made.verts.forEach((v) => ed.selVerts.add(v)); }
  ed.emit('selection');
  app.vp.startModalHere('move');
}, { key: 'E', enabled: notPose, hint: 'Extrude the selection and move it with the mouse, as Blender does: faces along their normal, edges into new faces. X, Y or Z locks an axis; click keeps it, Esc or right click leaves it in place.' });

def('mesh.inset', 'Inset Faces', () => {
  const faces = ed.selectedFaceSet();
  if (!need(faces.size > 0, 'Select faces to inset.')) return;
  // Over a view, as Blender's I: the mouse sets the width. From a menu or the panel: a set width, adjustable after.
  if (app.vp.startInsetHere()) return;
  const m0 = ed.model;
  const pts = [...faces].flatMap((fi) => m0.faces[fi].v.map((v) => m0.verts[v].p));
  const size = bounds(pts).size;
  const width = +(Math.max(0.001, Math.min(...size.filter((x) => x > 1e-6), Infinity) * 0.15)).toFixed(3);
  ed.runOp('Inset', [
    { key: 'thickness', label: 'Thickness', type: 'number', value: Number.isFinite(width) ? width : 0.05, min: 0, max: 100, step: 0.005 },
    { key: 'depth', label: 'Depth', type: 'number', value: 0, min: -100, max: 100, step: 0.005 },
    { key: 'individual', label: 'Individual', type: 'bool', value: false },
    { key: 'even', label: 'Even offset', type: 'bool', value: true },
  ], (m, v) => {
    mt.insetRegion(m, faces, { thickness: v.thickness, depth: v.depth, individual: v.individual, even: v.even });
    ed.mode = 'face';
    ed.selFaces = new Set(faces);
  });
}, { key: 'I', enabled: notPose, hint: 'Inset the selected faces as one region, as Blender does: move the mouse toward their middle to widen the border. Ctrl+mouse: depth. I: each face on its own. E: even width. Type a width. Click keeps it.' });

def('mesh.subdivide', 'Subdivide (Smooth)', () => {
  const start = ed.selectedFaceSet(true);
  if (!need(start.size > 0, 'Nothing to subdivide.')) return;
  const whole = start.size === ed.model.faces.length;
  ed.runOp('Subdivide', [
    { key: 'levels', label: 'Levels', type: 'number', value: 1, min: 1, max: 3, step: 1 },
    { key: 'smooth', label: 'Smooth', type: 'bool', value: true },
  ], (m, v) => {
    let target = new Set(start);
    for (let i = 0; i < v.levels; i++) {
      const count = m.faces.length;
      ops.subdivide(m, target, v.smooth);
      // New quads are appended after the kept faces; they're the region for the next level.
      const made = new Set<number>();
      const kept = count - target.size;
      for (let k = kept; k < m.faces.length; k++) made.add(k);
      target = whole ? new Set(m.faces.keys()) : made;
    }
    ed.clearSelection();
  });
}, { key: 'Ctrl+Shift+D', enabled: notPose });

def('mesh.triangulate', 'Triangulate', () => {
  const faces = ed.selectedFaceSet(true);
  ed.transact('Triangulate', (m) => { ops.triangulateFaces(m, faces); ed.clearSelection(); });
}, { enabled: () => hasAnyMesh() && notPose() });
def('mesh.quadify', 'Tris to Quads', () => {
  const faces = ed.selectedFaceSet(true);
  ed.runOp('Tris to quads', [{ key: 'angle', label: 'Max angle', type: 'number', value: 10, min: 0, max: 60, step: 1 }], (m, v) => {
    ops.quadify(m, faces, v.angle);
    ed.clearSelection();
  });
}, { enabled: () => hasAnyMesh() && notPose() });
def('mesh.triangulateNgons', 'Triangulate N-gons', () => {
  const s = new Set<number>();
  ed.model.faces.forEach((f, i) => { if (f.v.length > 4) s.add(i); });
  if (!s.size) return;
  ed.transact('Triangulate n-gons', (m) => { ops.triangulateFaces(m, s); ed.clearSelection(); });
});

def('mesh.weld', 'Weld Selected', () => {
  const vs = ed.selectedVertexSet();
  if (!need(vs.size > 1, 'Select 2 or more vertices to weld.')) return;
  ed.runOp('Weld', [{ key: 'threshold', label: 'Distance', type: 'number', value: 0.001, min: 0, max: 5, step: 0.001 }], (m, v) => {
    const n = ops.weld(m, vs, v.threshold);
    ed.clearSelection();
    status(`Welded ${n} vertices`);
  });
}, { key: 'Ctrl+M', enabled: notPose });
def('mesh.merge', 'Merge', () => {
  // As Blender's M: in Group mode, the selected groups become one; otherwise the selected points do.
  if (ed.mode === 'group') { runCommand('mesh.mergeGroups'); return; }
  // In the order they were picked, for At First and At Last.
  const vs = ed.mode === 'vertex' ? [...ed.selVerts] : [...ed.selectedVertexSet()];
  if (!need(vs.length > 1, 'Select 2 or more vertices to merge, or switch to Group mode (4) to merge groups.')) return;
  ed.runOp('Merge', [
    { key: 'at', label: 'Merge', type: 'choice', value: 'center', options: [['center', 'At centre'], ['first', 'At first'], ['last', 'At last'], ['distance', 'By distance']] },
    { key: 'distance', label: 'Distance', type: 'number', value: 0.001, min: 0, max: 100, step: 0.001 },
  ], (m, v) => {
    if (v.at === 'distance') {
      const n = ops.weld(m, new Set(vs), v.distance);
      status(n ? `Merged ${n} vertex${n === 1 ? '' : 'es'} within ${v.distance}.` : `No vertices within ${v.distance} of each other. Raise Distance.`);
    } else {
      const pts = vs.map((i) => m.verts[i].p);
      const target: V3 = v.at === 'first' ? [...pts[0]] as V3 : v.at === 'last' ? [...pts[pts.length - 1]] as V3
        : [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length, pts.reduce((s, p) => s + p[2], 0) / pts.length];
      for (const i of vs) m.verts[i].p = [...target] as V3;
      ops.collapse(m, new Set(vs));
    }
    ed.clearSelection();
  });
}, { key: 'M', enabled: notPose, hint: 'Merge the selected vertices into one (at their centre, the first or last picked, or those close together), or in Group mode the selected groups' });
def('mesh.collapse', 'Collapse to Point', () => {
  const vs = ed.selectedVertexSet();
  if (!need(vs.size > 1, 'Select 2 or more vertices to collapse.')) return;
  ed.transact('Collapse', (m) => { ops.collapse(m, vs); ed.clearSelection(); });
}, { key: 'Alt+M', enabled: notPose });
def('mesh.weldAll', 'Weld All Overlapping', () => {
  ed.transact('Weld overlapping', (m) => {
    const n = ops.weld(m, new Set(m.verts.keys()), 0.0001);
    ed.clearSelection();
    toast(`Welded ${n} vertices`, 'ok');
  });
}, { enabled: hasAnyMesh });
def('mesh.flip', 'Flip Normals', () => {
  const faces = ed.selectedFaceSet(true);
  ed.transact('Flip normals', (m) => ops.flipFaces(m, faces));
}, { key: 'Alt+N', enabled: () => hasAnyMesh() && notPose() });
def('mesh.fixNormals', 'Recalculate Outside', () => {
  const faces = ed.selectedFaceSet(true);
  ed.transact('Recalculate normals', (m) => { const n = ops.fixNormals(m, faces); toast(`Flipped ${n} faces`, 'ok'); });
}, { key: 'Shift+N', enabled: () => hasAnyMesh() && notPose() });
def('mesh.smoothShade', 'Shade Smooth', () => {
  const faces = ed.selectedFaceSet(true);
  ed.transact('Shade smooth', (m) => { const s = ops.nextSmooth(m); faces.forEach((i) => { m.faces[i].s = s; }); });
}, { enabled: hasAnyMesh });
def('mesh.flatShade', 'Shade Flat', () => {
  const faces = ed.selectedFaceSet(true);
  ed.transact('Shade flat', (m) => { faces.forEach((i) => { m.faces[i].s = 0; }); });
}, { enabled: hasAnyMesh });
def('mesh.autoSmooth', 'Auto Smooth by Angle…', () => {
  const faces = ed.selectedFaceSet(true);
  ed.runOp('Auto smooth', [{ key: 'angle', label: 'Angle', type: 'number', value: 40, min: 1, max: 180, step: 1 }], (m, v) => ops.autoSmooth(m, faces, v.angle));
}, { enabled: hasAnyMesh });
def('mesh.smoothVerts', 'Relax Vertices', () => {
  const vs = ed.selectedVertexSet();
  if (!need(vs.size > 0, 'Select vertices to relax.')) return;
  ed.runOp('Relax', [{ key: 'iterations', label: 'Iterations', type: 'number', value: 2, min: 1, max: 30, step: 1 }], (m, v) => ops.smoothVerts(m, vs, v.iterations));
}, { enabled: notPose });
def('mesh.mirror', 'Mirror…', () => {
  const faces = ed.selectedFaceSet(true);
  if (!need(faces.size > 0, 'Nothing to mirror.')) return;
  ed.runOp('Mirror', [
    { key: 'axis', label: 'Axis', type: 'choice', value: 0, options: [[0, 'X'], [1, 'Y'], [2, 'Z']] },
    { key: 'copy', label: 'Keep original', type: 'bool', value: true },
    { key: 'weld', label: 'Weld seam', type: 'bool', value: true },
  ], (m, v) => { ops.mirrorFaces(m, faces, v.axis, v.weld, v.copy); ed.clearSelection(); });
}, { enabled: notPose });
def('mesh.detach', 'Detach Faces', () => {
  const faces = ed.selectedFaceSet();
  if (!need(faces.size > 0, 'Select faces to detach.')) return;
  ed.transact('Detach', (m) => ops.detachFaces(m, faces));
}, { enabled: notPose });
def('mesh.regroup', 'Separate to New Group', () => {
  const faces = ed.selectedFaceSet();
  if (!need(faces.size > 0, 'Select faces to separate.')) return;
  ed.transact('Separate', (m) => {
    const name = m.groups.find((g) => g.id === m.faces[[...faces][0]].g)?.name ?? 'Group';
    ops.detachFaces(m, faces);
    ed.activeGroup = ops.regroup(m, faces, name);
  });
}, { key: 'Ctrl+G', enabled: notPose });
def('mesh.mergeGroups', 'Merge Selected Groups', () => {
  // Every group the selection touches, in any mode: whole faces, or any point or edge of one.
  const ids = new Set([...ed.selectedFaceSet()].map((i) => ed.model.faces[i].g));
  if (ed.mode === 'vertex' || ed.mode === 'edge') {
    const vs = ed.selectedVertexSet();
    ed.model.faces.forEach((f) => { if (f.v.some((v) => vs.has(v))) ids.add(f.g); });
  }
  if (!need(ids.size > 1, 'Select two or more groups to merge: Shift-click them in the Groups list, or select part of each in the view.')) return;
  ed.transact('Merge groups', (m) => {
    const [first, ...rest] = [...ids];
    const r = new Set(rest);
    for (const f of m.faces) if (r.has(f.g)) f.g = first;
    ops.pruneEmptyGroups(m);
    ed.activeGroup = first;
  });
}, { enabled: notPose });
// ---------- more mesh tools (Blender and LoopTools) ----------
/** Edges a loop tool works on: the selected edges, the edges among selected points, or the rim of selected faces. */
function selectionEdges(): Set<string> {
  const m = ed.model;
  if (ed.mode === 'edge') return new Set(ed.selEdges);
  if (ed.mode === 'vertex') return mt.edgesAmong(m, ed.selectedVertexSet());
  // Faces: their outline, the edges only one selected face uses.
  const faces = ed.selectedFaceSet();
  const count = new Map<string, number>();
  for (const fi of faces) { const f = m.faces[fi]; f.v.forEach((a, i) => { const k = edgeKey(a, f.v[(i + 1) % f.v.length]); count.set(k, (count.get(k) ?? 0) + 1); }); }
  return new Set([...count].filter(([, n]) => n === 1).map(([k]) => k));
}
const selectionLoops = () => mt.edgeLoops(selectionEdges());
const activeGroupId = (m: Model) => ed.activeGroup ?? m.faces[[...ed.selectedFaceSet(true)][0] ?? 0]?.g ?? m.groups[0]?.id ?? 0;
const influence = { key: 'influence', label: 'Influence', type: 'number' as const, value: 1, min: 0, max: 1, step: 0.05 };

def('loop.circle', 'Circle', () => {
  const loops = selectionLoops().filter((l) => l.closed);
  if (!need(loops.length > 0, 'Select a closed loop of edges, or faces whose rim makes one.')) return;
  ed.runOp('Circle', [{ key: 'regular', label: 'Even spacing', type: 'bool', value: true }, influence], (m, v) => { mt.circleLoops(m, loops, v.regular, v.influence); });
}, { enabled: notPose, hint: 'Make each selected loop a circle in its own plane (LoopTools)' });
def('loop.flatten', 'Flatten', () => {
  const vs = ed.selectedVertexSet();
  if (!need(vs.size >= 3, 'Select 3 or more vertices to flatten.')) return;
  ed.runOp('Flatten', [influence], (m, v) => mt.flattenVerts(m, vs, v.influence));
}, { enabled: notPose, hint: 'Move the selected points onto the plane that fits them best (LoopTools)' });
def('loop.space', 'Space Evenly', () => {
  const loops = selectionLoops();
  if (!need(loops.length > 0, 'Select a loop or a line of edges.')) return;
  ed.runOp('Space', [influence], (m, v) => { mt.spaceLoops(m, loops, v.influence); });
}, { enabled: notPose, hint: 'Spread the points of each selected loop evenly along it (LoopTools)' });
def('loop.curve', 'Curve', () => {
  const loops = selectionLoops().filter((l) => !l.closed);
  if (!need(loops.length > 0, 'Select an open line of edges to curve.')) return;
  ed.runOp('Curve', [influence], (m, v) => { mt.curveLoops(m, loops, v.influence); });
}, { enabled: notPose, hint: 'Smooth a line of edges into an even curve, keeping its ends (LoopTools)' });
def('mesh.bridge', 'Bridge Edge Loops', () => {
  const m0 = ed.model;
  const faceMode = ed.mode === 'face' || ed.mode === 'group';
  const faces = faceMode ? ed.selectedFaceSet() : new Set<number>();
  const loops = selectionLoops();
  if (!need(loops.length >= 2, faceMode ? 'Select two faces or patches to bridge between.' : 'Select two or more loops of edges to bridge.')) return;
  // Remember the loops by position, since removing faces renumbers vertices.
  const keys = loops.map((l) => ({ closed: l.closed, pts: l.verts.map((v) => m0.verts[v].p.join(',')) }));
  ed.runOp('Bridge', [
    { key: 'segments', label: 'Segments', type: 'number', value: 1, min: 1, max: 32, step: 1 },
    { key: 'twist', label: 'Twist', type: 'number', value: 0, min: -64, max: 64, step: 1 },
  ], (m, v) => {
    const g = activeGroupId(m);
    if (faces.size) ops.removeFaces(m, faces, false);
    const at = new Map(m.verts.map((x, i) => [x.p.join(','), i]));
    const found = keys.map((k) => ({ closed: k.closed, verts: k.pts.map((p) => at.get(p)!) })).filter((l) => l.verts.every((x) => x !== undefined));
    mt.bridgeLoops(m, found, g, Math.round(v.segments), Math.round(v.twist));
  });
}, { enabled: notPose, hint: 'Join loops of edges with faces; in face mode, join two faces and open a tube between them' });
def('mesh.gridFill', 'Grid Fill', () => {
  const holes = mt.holeLoops(ed.model, ed.selectedVertexSet());
  if (!need(holes.length > 0, 'Select the edge of a hole to fill it.')) return;
  if (!need(holes.some((l) => l.length % 2 === 0 && l.length >= 4), 'Grid Fill needs a hole with an even number of edges. Use Fill for others.')) return;
  ed.runOp('Grid Fill', [
    { key: 'span', label: 'Span', type: 'number', value: 0, min: 0, max: 64, step: 1 },
    { key: 'offset', label: 'Offset', type: 'number', value: 0, min: -64, max: 64, step: 1 },
  ], (m, v) => { mt.gridFill(m, mt.holeLoops(m, new Set(holes.flat())), activeGroupId(m), Math.round(v.span), Math.round(v.offset)); });
}, { enabled: notPose, hint: 'Fill a hole with a grid of quads that follows its rim. Span sets how many across (0 picks); Offset turns where the grid starts' });
def('mesh.fill', 'Fill', () => {
  const holes = mt.holeLoops(ed.model, ed.selectedVertexSet());
  if (!need(holes.length > 0, 'Select the edge of a hole to fill it.')) return;
  ed.runOp('Fill', [], (m) => { mt.triFill(m, mt.holeLoops(m, new Set(holes.flat())), activeGroupId(m)); });
}, { enabled: notPose, hint: 'Close a hole with triangles' });
def('mesh.bevel', 'Bevel', () => {
  const m0 = ed.model;
  let edges: Set<string>;
  if (ed.mode === 'edge') edges = new Set(ed.selEdges);
  else if (ed.mode === 'vertex') edges = mt.edgesAmong(m0, ed.selectedVertexSet());
  else { edges = new Set(); for (const fi of ed.selectedFaceSet()) { const f = m0.faces[fi]; f.v.forEach((a, i) => edges.add(edgeKey(a, f.v[(i + 1) % f.v.length]))); } }
  if (!need(edges.size > 0, 'Select edges to bevel.')) return;
  const P = [...edges].flatMap((k) => parseEdge(k)).map((v) => m0.verts[v].p);
  const size = bounds(P).size;
  const width = +(Math.max(0.001, Math.min(size[0] || Infinity, size[1] || Infinity, size[2] || Infinity, Math.max(...size)) * 0.1)).toFixed(3);
  ed.runOp('Bevel', [{ key: 'width', label: 'Width', type: 'number', value: width, min: 0.0001, max: 100, step: 0.005 }], (m, v) => {
    mt.bevelEdges(m, edges, v.width);
    ed.clearSelection();
  });
}, { key: 'Ctrl+B', enabled: notPose, hint: 'Cut the selected edges back into flat strips, with a face at each corner' });
def('mesh.dissolve', 'Dissolve', () => {
  const m0 = ed.model;
  if (ed.mode === 'vertex') {
    const vs = ed.selectedVertexSet();
    if (!need(vs.size > 0, 'Select vertices to dissolve.')) return;
    ed.runOp('Dissolve vertices', [], (m) => { mt.dissolveVerts(m, vs); ed.clearSelection(); });
  } else if (ed.mode === 'edge') {
    const es = new Set(ed.selEdges);
    if (!need(es.size > 0, 'Select edges to dissolve.')) return;
    ed.runOp('Dissolve edges', [], (m) => { mt.dissolveEdges(m, es); ed.clearSelection(); });
  } else {
    const fs = ed.selectedFaceSet();
    if (!need(fs.size > 1, 'Select two or more joined faces to dissolve into one.')) return;
    ed.runOp('Dissolve faces', [], (m) => { mt.dissolveFaces(m, fs); ed.clearSelection(); });
  }
  void m0;
}, { enabled: notPose, hint: 'Remove the selection but keep the surface: points and edges go, and the faces around them join into one' });
def('mesh.connect', 'Connect Vertices', () => {
  const vs = ed.selectedVertexSet();
  if (!need(vs.size >= 2, 'Select two or more vertices on the same faces.')) return;
  ed.runOp('Connect', [], (m) => { if (!mt.connectVerts(m, vs)) toast('No face has two of those vertices apart from each other.', 'info'); });
}, { enabled: notPose, hint: 'Split faces with an edge between selected vertices that share them' });
def('mesh.poke', 'Poke Faces', () => {
  const fs = ed.selectedFaceSet();
  if (!need(fs.size > 0, 'Select faces to poke.')) return;
  ed.runOp('Poke', [{ key: 'offset', label: 'Offset', type: 'number', value: 0, min: -100, max: 100, step: 0.01 }], (m, v) => { mt.pokeFaces(m, fs, v.offset); });
}, { enabled: notPose, hint: 'Fan triangles from a new point in the middle of each face' });
def('mesh.solidify', 'Solidify', () => {
  const fs = ed.selectedFaceSet(true);
  if (!need(fs.size > 0, 'Select faces to give thickness.')) return;
  ed.runOp('Solidify', [{ key: 'thickness', label: 'Thickness', type: 'number', value: 0.05, min: -100, max: 100, step: 0.005 }], (m, v) => { mt.solidify(m, fs, v.thickness); });
}, { enabled: notPose, hint: 'Give a surface thickness: a back copy joined round the open edges' });
def('mesh.spin', 'Spin', () => {
  const loops = selectionLoops();
  if (!need(loops.length > 0, 'Select a profile of edges to spin.')) return;
  const vs = new Set(loops.flatMap((l) => l.verts));
  const m0 = ed.model;
  const centre = bounds([...vs].map((v) => m0.verts[v].p)).center;
  ed.runOp('Spin', [
    { key: 'angle', label: 'Angle', type: 'number', value: 360, min: -360, max: 360, step: 5 },
    { key: 'steps', label: 'Steps', type: 'number', value: 12, min: 2, max: 128, step: 1 },
    { key: 'axis', label: 'Axis', type: 'choice', value: 1, options: [[0, 'X'], [1, 'Y'], [2, 'Z']] },
    { key: 'about', label: 'Around', type: 'choice', value: 'origin', options: [['origin', 'The origin'], ['selection', 'The selection']] },
  ], (m, v) => {
    const axis: V3 = [0, 0, 0]; axis[Number(v.axis)] = 1;
    mt.spin(m, loops, activeGroupId(m), axis, v.about === 'origin' ? [0, 0, 0] : centre, v.angle, Math.round(v.steps));
  });
}, { enabled: notPose, hint: 'Sweep a profile of edges round an axis, like a lathe' });
def('mesh.separateLoose', 'Separate Loose Parts', () => {
  const fs = ed.selectedFaceSet(true);
  ed.transact('Separate loose parts', (m) => {
    // Within each group, every loose part after the first gets a group of its own.
    const byGroup = new Map<number, Set<number>>();
    for (const fi of fs) (byGroup.get(m.faces[fi].g) ?? byGroup.set(m.faces[fi].g, new Set()).get(m.faces[fi].g)!).add(fi);
    let made = 0;
    byGroup.forEach((faces, gid) => {
      const parts = mt.looseParts(m, faces);
      const name = m.groups.find((g) => g.id === gid)?.name ?? 'Part';
      for (const part of parts.slice(1)) { ops.regroup(m, new Set(part), name); made++; }
    });
    toast(made ? `Split into ${made} more group${made === 1 ? '' : 's'}.` : 'Nothing loose to separate.', made ? 'ok' : 'info');
  });
}, { enabled: notPose, hint: 'Give each separate piece its own group' });

// Selection helpers.
def('select.shortestPath', 'Select Shortest Path', () => {
  const m = ed.model;
  if (ed.mode === 'vertex') {
    const sel = [...ed.selVerts];
    if (!need(sel.length === 2, 'Select exactly two vertices.')) return;
    const path = mt.shortestPath(m, sel[0], sel[1]);
    if (!need(path.length > 0, 'Those vertices aren\'t joined.')) return;
    ed.selVerts = new Set(path);
  } else if (ed.mode === 'edge') {
    const sel = [...ed.selEdges].map(parseEdge);
    if (!need(sel.length === 2, 'Select exactly two edges.')) return;
    const path = mt.shortestPath(m, sel[0][1], sel[1][0]);
    if (!need(path.length > 0, 'Those edges aren\'t joined.')) return;
    path.forEach((v, i) => { if (i) ed.selEdges.add(edgeKey(path[i - 1], v)); });
  } else {
    const sel = [...ed.selFaces];
    if (!need(sel.length === 2, 'Select exactly two faces.')) return;
    const path = mt.shortestFacePath(m, sel[0], sel[1]);
    if (!need(path.length > 0, 'Those faces aren\'t joined.')) return;
    ed.selFaces = new Set(path);
  }
  ed.emit('selection');
}, { hint: 'Select along the shortest way between two selected vertices, edges or faces' });
const selectFacesWhere = (test: (n: number) => boolean, what: string) => {
  ed.setMode('face');
  const m = ed.model;
  ed.selFaces = new Set(m.faces.map((f, i) => (test(f.v.length) && !ed.isFaceHidden(i) ? i : -1)).filter((i) => i >= 0));
  ed.emit('selection');
  status(`${ed.selFaces.size.toLocaleString()} ${what}.`);
};
def('select.ngons', 'Select N-gons', () => selectFacesWhere((n) => n > 4, 'faces with more than 4 sides'), { hint: 'Faces with more than four corners, which some engines and tools handle badly' });
def('select.tris', 'Select Triangles', () => selectFacesWhere((n) => n === 3, 'triangles'));
def('select.checker', 'Checker Deselect', () => {
  const fs = ed.selectedFaceSet();
  if (!need(fs.size > 1, 'Select some faces first.')) return;
  ed.setMode('face');
  ed.selFaces = mt.checkerFaces(ed.model, fs);
  ed.emit('selection');
}, { hint: 'Keep every other face of the selection' });

def('mesh.makeFace', 'Make Face from Vertices', () => {
  const vs = [...ed.selectedVertexSet()];
  if (!need(vs.length >= 3, 'Select 3 or more vertices.')) return;
  ed.transact('Make face', (m) => {
    const gid = ed.activeGroup ?? makeGroup(m, 'Mesh', ed.activeMaterial).id;
    ed.activeGroup = gid;
    if (ops.makeFace(m, vs, gid) === null) toast('Those vertices are all in a line.', 'warn');
  });
}, { key: 'F', enabled: notPose });
def('mesh.fillHoles', 'Fill Holes', () => {
  const vs = ed.selectedVertexSet();
  ed.transact('Fill holes', (m) => {
    const n = ops.fillHoles(m, vs.size ? vs : null, ed.activeGroup ?? m.groups[0]?.id ?? 0);
    toast(n ? `Filled ${n} hole${n > 1 ? 's' : ''}` : 'No closed holes found.', n ? 'ok' : 'info');
  });
}, { enabled: hasAnyMesh });
def('mesh.fillHolesAll', 'Fill All Holes', () => {
  ed.transact('Fill holes', (m) => {
    const n = ops.fillHoles(m, null, m.groups[0]?.id ?? 0);
    toast(n ? `Filled ${n} hole${n > 1 ? 's' : ''}` : 'No closed holes found.', n ? 'ok' : 'info');
  });
});
def('mesh.cleanDegenerate', 'Remove Degenerate Faces', () => {
  ed.transact('Remove degenerate', (m) => { toast(`Removed ${ops.removeDegenerate(m)} faces`, 'ok'); ed.clearSelection(); });
});
def('mesh.cleanLoose', 'Remove Loose Vertices', () => {
  ed.transact('Remove loose', (m) => { toast(`Removed ${ops.removeLoose(m)} vertices`, 'ok'); ed.clearSelection(); });
});
def('mesh.centerOrigin', 'Centre on Origin', () => {
  ed.transact('Centre', (m) => {
    const c = bounds(m.verts.map((v) => v.p)).center;
    for (const v of m.verts) { v.p[0] -= c[0]; v.p[1] -= c[1]; v.p[2] -= c[2]; }
    for (const b of m.bones) { b.head[0] -= c[0]; b.head[1] -= c[1]; b.head[2] -= c[2]; }
  });
  app.vp.frameSelected(true);
}, { enabled: hasAnyMesh });
def('mesh.ground', 'Drop to Ground', () => {
  ed.transact('Drop to ground', (m) => {
    const b = bounds(m.verts.map((v) => v.p));
    const c: V3 = [b.center[0], b.min[1], b.center[2]];
    for (const v of m.verts) { v.p[0] -= c[0]; v.p[1] -= c[1]; v.p[2] -= c[2]; }
    for (const x of m.bones) { x.head[0] -= c[0]; x.head[1] -= c[1]; x.head[2] -= c[2]; }
  });
  app.vp.frameSelected(true);
}, { enabled: hasAnyMesh });
def('mesh.rescale', 'Set Real-World Height…', async () => {
  const b = bounds(ed.model.verts.map((v) => v.p));
  const input = h('input', { class: 'text-input', value: String(+b.size[1].toFixed(3)), type: 'text', inputmode: 'decimal' }) as HTMLInputElement;
  const go = await modal('Set real-world height', h('div', { class: 'stack' }, h('p', null, 'Scale the whole model so its height matches this many metres. Bones and animation scale with it.'), h('label', { class: 'form-row' }, 'Height (m)', input)), [
    { label: 'Cancel', value: false }, { label: 'Scale', primary: true, value: true },
  ]);
  if (!go) return;
  const target = parseFloat(input.value);
  if (!(target > 0) || b.size[1] <= 0) { toast('Enter a height above 0.', 'warn'); return; }
  const k = target / b.size[1];
  ed.transact('Set height', (m) => {
    for (const v of m.verts) { v.p = [v.p[0] * k, v.p[1] * k, v.p[2] * k]; }
    for (const x of m.bones) x.head = [x.head[0] * k, x.head[1] * k, x.head[2] * k];
    for (const c of m.clips) for (const t of Object.values(c.tracks)) t.pos.forEach((p) => { p.v = [p.v[0] * k, p.v[1] * k, p.v[2] * k]; });
  });
  app.vp.frameSelected(true);
}, { enabled: hasAnyMesh });

// LOD + collision
def('mesh.generateLods', 'Generate LODs…', () => {
  const mainGroups = () => ed.model.groups.filter((g) => g.kind === 'mesh');
  if (!need(mainGroups().length > 0, 'Nothing to simplify.')) return;
  ed.runOp('Generate LODs', [
    { key: 'levels', label: 'Levels', type: 'number', value: 2, min: 1, max: 4, step: 1 },
    { key: 'ratio', label: 'Keep per level', type: 'number', value: 0.5, min: 0.1, max: 0.9, step: 0.05 },
  ], (m, v) => {
    // Regenerate from scratch rather than stacking on older LODs.
    const lodIds = new Set(m.groups.filter((g) => g.kind === 'lod').map((g) => g.id));
    if (lodIds.size) {
      const s = new Set<number>();
      m.faces.forEach((f, i) => { if (lodIds.has(f.g)) s.add(i); });
      ops.removeFaces(m, s);
      m.groups = m.groups.filter((g) => !lodIds.has(g.id));
    }
    for (const g of m.groups.filter((x) => x.kind === 'mesh')) {
      const src = ops.groupFaces(m, g.id);
      for (let level = 1; level <= v.levels; level++) {
        const res = decimate(m, src, Math.pow(v.ratio, level));
        const lod = makeGroup(m, `${g.name}_LOD${level}`, g.material, 'lod');
        lod.visible = false;
        const base = m.verts.length;
        m.verts.push(...res.verts);
        for (const f of res.faces) m.faces.push({ ...f, v: f.v.map((x) => x + base), g: lod.id });
      }
    }
    ed.clearSelection();
  });
  toast('LODs are hidden by default. Show them from the Scene panel.', 'ok');
}, { enabled: hasAnyMesh });

function addCollision(m: Model, verts: V3[], tris: number[][], name: string) {
  const g = makeGroup(m, uniqueName(m.groups.map((x) => x.name), `UCX_${name}`), null, 'collision');
  g.visible = false;
  const base = m.verts.length;
  verts.forEach((p) => m.verts.push({ p }));
  tris.forEach((t) => m.faces.push({ v: t.map((i) => i + base), uv: t.map((): V2 => [0, 0]), g: g.id, s: 0 }));
}
def('mesh.collisionHull', 'Generate Convex Hull Collider', () => {
  const vs = ed.selectedVertexSet();
  const source = vs.size >= 4 ? [...vs] : ed.model.verts.map((_, i) => i);
  if (!need(source.length >= 4, 'Need at least 4 vertices.')) return;
  ed.transact('Convex hull', (m) => {
    const hull = new ConvexHull().setFromPoints(source.map((i) => new THREE.Vector3(...m.verts[i].p)));
    const verts: V3[] = [];
    const idx = new Map<string, number>();
    const add = (p: THREE.Vector3) => {
      const k = `${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)}`;
      let i = idx.get(k);
      if (i === undefined) { i = verts.length; idx.set(k, i); verts.push([p.x, p.y, p.z]); }
      return i;
    };
    const tris: number[][] = [];
    for (const face of hull.faces) {
      const loop: number[] = [];
      let e = face.edge;
      do { loop.push(add(e.head().point)); e = e.next; } while (e !== face.edge);
      for (let i = 1; i + 1 < loop.length; i++) tris.push([loop[0], loop[i], loop[i + 1]]);
    }
    addCollision(m, verts, tris, ed.fileName.replace(/\W+/g, '_') || 'Model');
    toast(`Convex hull: ${tris.length} triangles (hidden). Exports with a UCX_ prefix.`, 'ok');
  });
}, { enabled: hasAnyMesh });
def('game.bake', 'Bake…', () => openBakeDialog());
def('game.atlas', 'Make Texture Atlas', () => { void makeAtlas(); });

def('mesh.collisionBox', 'Generate Box Collider', () => {
  ed.transact('Box collider', (m) => {
    const b = bounds(m.verts.map((v) => v.p));
    const p = prims.box(b.size[0] || 0.01, b.size[1] || 0.01, b.size[2] || 0.01);
    const verts = p.verts.map((v): V3 => [v[0] + b.center[0], v[1] + b.center[1], v[2] + b.center[2]]);
    addCollision(m, verts, p.faces.map((f) => f.v), ed.fileName.replace(/\W+/g, '_') || 'Model');
    toast('Box collider added (hidden). Exports with a UCX_ prefix.', 'ok');
  });
}, { enabled: hasAnyMesh });

// Create at origin from the menu.
def('create.lowPoly', 'Low Poly', () => { ed.setLowPoly(!ed.lowPoly); app.vp.refreshPrim(); ed.emit('tool'); }, { checked: () => ed.lowPoly, hint: 'New primitives use minimal segments and flat shading.' });
def('create.onSurface', 'Draw on Surface', () => { ed.drawOnSurface = !ed.drawOnSurface; ed.emit('tool'); }, { checked: () => ed.drawOnSurface, hint: 'Start a drag on a mesh to build the primitive on that face, along its normal.' });
for (const [id, label] of [['box', 'Box'], ['sphere', 'Sphere'], ['geosphere', 'GeoSphere'], ['cylinder', 'Cylinder'], ['cone', 'Cone'], ['pyramid', 'Pyramid'], ['limb', 'Limb'], ['capsule', 'Capsule'], ['tapered', 'Tapered'], ['wedge', 'Wedge'], ['stairs', 'Stairs'], ['doorway', 'Doorway'], ['plane', 'Plane'], ['torus', 'Torus']] as const) {
  def(`create.${id}`, label, () => {
    ed.begin(`Create ${label}`);
    ed.lastOp = null;
    app.vp.createPrim(id, [0, 0, 0]);
    ed.commit();
    ed.sanitize();
    ed.emitAll();
    if (ed.model.faces.length && ed.model.groups.length === 1) app.vp.frameSelected(true);
  });
}

// ---------- view ----------
def('view.frame', 'Frame Selection', () => app.vp.frameSelected(false), { key: 'Z' });
def('view.frameAll', 'Frame All', () => app.vp.frameSelected(true), { key: 'Home' });
def('view.maximize', 'Maximize Active Pane', () => { if (app.vp.drawingPrim) app.vp.dropPrim(); else app.vp.toggleMax(); }, { key: 'Space' });
def('view.fitAll', 'Fit All', () => app.vp.frameSelected(true), { key: 'A' });
def('view.fitSelected', 'Fit Selected', () => app.vp.frameSelected(false), { key: 'Shift+A' });
def('view.center', 'Center View at Mouse', () => app.vp.centerAtMouse(), { key: 'V' });
def('view.zoomIn', 'Zoom In', () => app.vp.zoomKey(1 / 1.25), { key: '.' });
def('view.zoomOut', 'Zoom Out', () => app.vp.zoomKey(1.25), { key: ',' });
def('view.zoomIn2', 'Zoom In Double', () => app.vp.zoomKey(1 / (1.25 * 1.25)), { key: 'Shift+>' });
def('view.zoomOut2', 'Zoom Out Double', () => app.vp.zoomKey(1.25 * 1.25), { key: 'Shift+<' });
def('view.level', 'Level View (Reset Bank)', () => app.vp.levelView(), { key: 'Shift+G' });
def('view.link', 'Link Viewports', () => { app.vp.toggleLinked(); ed.emit('view', 'tool'); }, { checked: () => app.vp.linked });
const toggle = (id: string, label: string, get: () => boolean, set: (v: boolean) => void, key?: string) =>
  def(id, label, () => { set(!get()); ed.emit('view', 'tool'); }, { key, checked: get });
toggle('view.xray', 'X-Ray', () => ed.xray, (v) => { ed.xray = v; }, 'Alt+X');
toggle('view.wire', 'Wireframe on Shaded', () => ed.showWire, (v) => { ed.showWire = v; }, 'Alt+W');
toggle('view.backFaces', 'Show Back Faces', () => ed.showBack, (v) => { ed.showBack = v; });
toggle('view.grid', 'Show Grid', () => ed.showGrid, (v) => { ed.showGrid = v; });
toggle('view.bones', 'Show Joints', () => ed.showBones, (v) => { ed.showBones = v; });
toggle('view.boneNames', 'Show Joint Names', () => ed.showBoneNames, (v) => { ed.showBoneNames = v; });
toggle('view.snap', 'Snap to Grid', () => ed.snap, (v) => { ed.snap = v; }, 'Shift+S');
toggle('view.mirrorX', 'Mirror Edits Across X', () => ed.mirrorX, (v) => { ed.mirrorX = v; }, 'Shift+X');
def('view.timeline', 'Show Timeline', () => app.toggleTimeline(), { key: 'Ctrl+T', checked: () => app.timelineShown() });
if (native) {
  def('view.fullscreen', 'Toggle Fullscreen', () => { void native!.toggleFullscreen(); }, { key: 'F11' });
  def('view.devtools', 'Developer Tools', () => { void native!.toggleDevtools(); });
}
/** Every workspace, in the order the workspace menu lists them. */
export const WORKSPACE_LIST: { id: Workspace; label: string; key: string }[] = [
  { id: 'block', label: 'Blockout', key: 'Ctrl+5' },
  { id: 'model', label: 'Modeling', key: 'Ctrl+1' },
  { id: 'uv', label: 'UV Editing', key: 'Ctrl+2' },
  { id: 'paint', label: 'Paint', key: 'Ctrl+6' },
  { id: 'tiles', label: 'Tile Editor', key: 'Ctrl+7' },
  { id: 'rig', label: 'Rigging', key: 'Ctrl+3' },
  { id: 'animate', label: 'Animation', key: 'Ctrl+4' },
];
for (const { id, label, key } of WORKSPACE_LIST) {
  def(`workspace.${id}`, `${label} Workspace`, () => app.setWorkspace(id), { key, checked: () => ed.workspace === id });
}

// ---------- UV ----------
const uvOp = (label: string, fn: (m: Model, faces: Set<number>) => void) => () => {
  const faces = ed.selectedFaceSet(true);
  if (!need(faces.size > 0, 'Nothing to unwrap.')) return;
  ed.transact(label, (m) => fn(m, faces));
  app.uvRefresh();
};
def('uv.unwrap', 'Auto Unwrap', () => {
  const faces = ed.selectedFaceSet(true);
  if (!need(faces.size > 0, 'Nothing to unwrap.')) return;
  let islands = 0;
  ed.runOp('Auto unwrap', [
    { key: 'stretch', label: 'Max stretch', type: 'number', value: 1.35, min: 1.02, max: 4, step: 0.05 },
    { key: 'margin', label: 'Margin', type: 'number', value: 0.01, min: 0, max: 0.1, step: 0.002 },
  ], (m, v) => { islands = uv.unwrap(m, faces, v.margin, v.stretch); });
  app.uvRefresh();
  status(`Unwrapped into ${islands} island${islands === 1 ? '' : 's'}. Raise Max stretch for fewer islands, or lower it for less distortion.`);
}, { key: 'U', hint: 'One click, no seams to mark. It finds where to cut by itself, along the sharpest creases, and flattens with as little distortion as it can. Any seams you did mark are respected.' });
def('uv.smart', 'Smart Unwrap', () => {
  const faces = ed.selectedFaceSet(true);
  if (!need(faces.size > 0, 'Nothing to unwrap.')) return;
  ed.runOp('Smart unwrap', [
    { key: 'angle', label: 'Angle limit', type: 'number', value: 60, min: 5, max: 89, step: 1 },
    { key: 'margin', label: 'Margin', type: 'number', value: 0.01, min: 0, max: 0.1, step: 0.002 },
  ], (m, v) => { uv.smartUnwrap(m, faces, v.angle, v.margin); });
  app.uvRefresh();
}, { hint: 'Split into charts by surface direction, with no seams needed.' });
/** The edges to mark: picked in the UV editor, or else in the viewport, or else around the selected faces. */
function seamTargets(): string[] {
  const picked = app.uv.selectedEdges();
  if (picked.length) return picked;
  if (ed.mode === 'edge' && ed.selEdges.size) return [...ed.selEdges];
  const faces = ed.selectedFaceSet();
  if (!faces.size) return [];
  const count = new Map<string, number>();
  faces.forEach((fi) => {
    const f = ed.model.faces[fi];
    f.v.forEach((a, i) => { const k = edgeKey(a, f.v[(i + 1) % f.v.length]); count.set(k, (count.get(k) ?? 0) + 1); });
  });
  const all = edgeFaces(ed.model);
  return [...count.keys()].filter((k) => count.get(k) === 1 && (all.get(k)?.length ?? 0) > 1);
}
const seamOp = (label: string, on: boolean) => () => {
  const edges = seamTargets();
  if (!need(edges.length > 0, 'Select edges, or faces to mark around.')) return;
  ed.transact(label, (m) => uv.setSeams(m, edges, on));
  toast(`${label}: ${edges.length} edge${edges.length === 1 ? '' : 's'}`, 'ok');
};
def('uv.pin', 'Pin Points', () => app.uv.pin(true), { enabled: hasAnyMesh, hint: 'Pinned points stay put when you unwrap again. Drag them with Live Unwrap on and the island follows.' });
def('uv.unpin', 'Unpin Points', () => app.uv.pin(false), { enabled: hasAnyMesh });
def('uv.live', 'Live Unwrap', () => { app.uv.live = !app.uv.live; ed.emit('view', 'tool'); app.uv.draw(); }, { checked: () => app.uv.live, hint: 'After you move a pinned point, the rest of its island re-solves around it.' });
def('uv.sticky', 'Keep Shared Points Together', () => { app.uv.sticky = !app.uv.sticky; ed.emit('view', 'tool'); app.uv.draw(); }, { checked: () => app.uv.sticky, hint: 'Off lets you pull one face\'s corner away from its neighbours, ripping it free.' });
def('uv.minimize', 'Minimize Stretch', () => {
  const faces = app.uv.selectedOrShownFaces();
  if (!need(faces.length > 0, 'Nothing to relax.')) return;
  ed.runOp('Minimize stretch', [{ key: 'iterations', label: 'Iterations', type: 'number', value: 20, min: 1, max: 200, step: 5 }], (m, v) => uv.minimizeStretch(m, faces, v.iterations));
}, { enabled: hasAnyMesh, hint: 'Even out distortion across the selected islands. Pinned points stay put.' });
def('uv.average', 'Average Island Scale', () => {
  const faces = app.uv.selectedOrShownFaces();
  ed.transact('Average island scale', (m) => uv.averageIslandScale(m, faces));
}, { enabled: hasAnyMesh, hint: 'Give every island the same texel density, without packing them.' });
def('uv.alignIslands', 'Straighten Islands', () => {
  const faces = app.uv.selectedOrShownFaces();
  ed.transact('Straighten islands', (m) => uv.alignIslands(m, faces));
}, { enabled: hasAnyMesh, hint: 'Turn each island so it lines up with the grid.' });
def('uv.selectOverlaps', 'Select Overlapping', () => app.uv.selectOverlaps(), { enabled: hasAnyMesh, hint: 'Select every face lying on top of another.' });
def('uv.markSeam', 'Mark Seam', seamOp('Mark seam', true), { key: 'Alt+S', hint: 'Optional: force a cut along the selected edges, or around the selected faces.' });
def('uv.clearSeam', 'Clear Seam', seamOp('Clear seam', false), { key: 'Shift+Alt+S' });
def('uv.seamsFromIslands', 'Seams from UV Islands', () => {
  const faces = ed.selectedFaceSet(true);
  ed.transact('Seams from islands', (m) => uv.seamsFromIslands(m, faces));
}, { enabled: hasAnyMesh, hint: 'Mark every edge where the current layout splits.' });
def('uv.clearAllSeams', 'Clear All Seams', () => ed.transact('Clear all seams', (m) => uv.clearSeams(m)), { enabled: hasAnyMesh });
def('uv.pack', 'Pack Islands', () => {
  const faces = app.uv.shownFaces();
  if (!need(faces.length > 0, 'Nothing to pack.')) return;
  ed.runOp('Pack islands', [
    { key: 'margin', label: 'Margin', type: 'number', value: 0.01, min: 0, max: 0.1, step: 0.002 },
    { key: 'equal', label: 'Equal density', type: 'bool', value: true },
    { key: 'rotate', label: 'Rotate', type: 'bool', value: true },
  ], (m, v) => { uv.packIslands(m, faces, v.margin, v.equal, v.rotate); });
  app.uvRefresh();
}, { enabled: hasAnyMesh, hint: 'Arrange the islands tightly in the 0-1 square without changing their shapes.' });
def('uv.density', 'Set Texel Density', () => {
  const faces = app.uv.shownFaces();
  if (!need(faces.length > 0, 'Nothing to scale.')) return;
  const size = app.uv.workingSize;
  ed.runOp('Texel density', [
    { key: 'density', label: 'Pixels per metre', type: 'number', value: Math.max(1, Math.round(uv.texelDensity(ed.model, faces, size))), min: 1, max: 20000, step: 8 },
  ], (m, v) => uv.setTexelDensity(m, faces, v.density, size));
}, { enabled: hasAnyMesh, hint: 'Scale each island so a metre on the model covers this many texture pixels.' });
def('uv.stitch', 'Stitch to Neighbour', () => app.uv.stitch(), { enabled: hasAnyMesh, hint: 'Move the island sharing a mesh edge with the selection so the two join up.' });
def('uv.weld', 'Weld Points', () => app.uv.weld(), { enabled: hasAnyMesh, hint: 'Collapse the selected UV points to their average.' });
def('uv.relax', 'Relax', () => app.uv.relax(), { enabled: hasAnyMesh, hint: 'Even out inner points. Island borders stay fixed.' });
for (const [side, label] of [['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']] as const) {
  def(`uv.align${label}`, `Align ${label}`, () => app.uv.align(side), { enabled: hasAnyMesh });
}
def('uv.flipU', 'Flip Horizontally', () => app.uv.flip(0), { enabled: hasAnyMesh });
def('uv.flipV', 'Flip Vertically', () => app.uv.flip(1), { enabled: hasAnyMesh });
def('uv.rot90', 'Rotate 90°', () => app.uv.rot90(), { enabled: hasAnyMesh });
def('uv.frame', 'Frame Selection', () => app.uv.frameSelected());
def('uv.frameAll', 'Frame All', () => app.uv.frameAll());
const uvToggle = (id: string, label: string, get: () => boolean, set: (v: boolean) => void, hint?: string) =>
  def(id, label, () => { set(!get()); app.uv.draw(); ed.emit('view'); }, { checked: get, hint });
uvToggle('uv.showImage', 'Show Texture', () => app.uv.showImage, (v) => { app.uv.showImage = v; });
uvToggle('uv.showGrid', 'Show Grid', () => app.uv.showGrid, (v) => { app.uv.showGrid = v; });
uvToggle('uv.showStretch', 'Show Stretch', () => app.uv.showStretch, (v) => { app.uv.showStretch = v; }, 'Blue keeps its true shape. Red is badly distorted.');
uvToggle('uv.showOverlap', 'Show Overlaps', () => app.uv.showOverlap, (v) => { app.uv.showOverlap = v; }, 'Faces lying on top of each other turn red.');
uvToggle('uv.snap', 'Snap to Grid', () => app.uv.snap, (v) => { app.uv.snap = v; }, 'Ctrl inverts this during a drag.');
def('uv.exportLayout', 'Export UV Layout…', async () => {
  const size = app.uv.workingSize;
  const data = await app.uv.layoutPNG(size);
  const stem = (ed.fileName || 'model').replace(/\.[^.]+$/, '');
  const res = await saveFile({ defaultName: `${stem}_uv.png`, filters: [{ name: 'PNG image', extensions: ['png'] }], data });
  if (res) toast(`Saved ${res.name} at ${size} x ${size}`, 'ok');
}, { enabled: hasAnyMesh, hint: 'Save the wireframe as a transparent PNG to paint a texture over.' });
def('uv.smartAll', 'Smart Unwrap Everything', () => {
  ed.transact('Smart unwrap', (m) => { uv.smartUnwrap(m, m.faces.keys()); });
  app.uvRefresh();
}, { enabled: hasAnyMesh });
def('uv.box', 'Box Projection', uvOp('Box projection', (m, f) => uv.projectBox(m, f)));
def('uv.planarView', 'Planar from Active View', uvOp('Planar projection', (m, f) => {
  const d = app.vp.active.viewDir();
  uv.projectPlanar(m, f, [d.x, d.y, d.z]);
}));
def('uv.cylinder', 'Cylindrical Projection', uvOp('Cylindrical projection', (m, f) => uv.projectCylinder(m, f)));
def('uv.sphere', 'Spherical Projection', uvOp('Spherical projection', (m, f) => uv.projectSphere(m, f)));
def('uv.fit', 'Fit to 0-1', uvOp('Fit UVs', (m, f) => uv.fitUV(m, f)));

// ---------- rig ----------
const hasBones = () => ed.model.bones.length > 0;
const autoWeightOp = (getVerts: () => number[]) => () => {
  const list = getVerts();
  ed.runOp('Auto-weight', [
    { key: 'method', label: 'Method', type: 'choice', value: 0, options: [[0, 'Surface heat'], [1, 'Distance']] },
    { key: 'max', label: 'Max joints', type: 'number', value: 4, min: 1, max: 8, step: 1 },
  ], (m, v) => {
    if (v.method === 0) heatWeights(m, list, v.max);
    else autoWeights(m, list, v.max);
  });
  toast(`Auto-weighted ${list.length.toLocaleString()} vertices`, 'ok');
};
def('rig.autoWeights', 'Auto-Weight Selected', autoWeightOp(() => {
  const vs = ed.selectedVertexSet();
  return vs.size ? [...vs] : [...ed.model.verts.keys()];
}), { enabled: hasBones, hint: 'Spread each joint\'s influence over the connected surface, so it won\'t jump across a gap to a nearby part.' });
def('rig.autoWeightsAll', 'Auto-Weight Everything', autoWeightOp(() => [...ed.model.verts.keys()]), { enabled: hasBones });
const weightTargets = () => { const vs = ed.selectedVertexSet(); return vs.size ? [...vs] : [...ed.model.verts.keys()]; };
def('rig.smooth', 'Smooth Weights', () => {
  const list = weightTargets();
  ed.runOp('Smooth weights', [{ key: 'iterations', label: 'Iterations', type: 'number', value: 3, min: 1, max: 30, step: 1 }], (m, v) => smoothWeights(m, list, v.iterations));
}, { enabled: hasBones, hint: 'Soften harsh weight boundaries on the selected vertices, or on everything.' });
def('rig.prune', 'Clean Up Weights', () => {
  const list = weightTargets();
  ed.runOp('Clean up weights', [
    { key: 'threshold', label: 'Remove below', type: 'number', value: 0.02, min: 0, max: 0.5, step: 0.01 },
    { key: 'max', label: 'Max joints', type: 'number', value: 4, min: 1, max: 8, step: 1 },
  ], (m, v) => pruneWeights(m, list, v.threshold, v.max));
}, { enabled: hasBones, hint: 'Drop tiny influences and limit how many joints move each vertex.' });
def('rig.mirrorWeights', 'Mirror Weights Across X', () => {
  let n = 0;
  ed.runOp('Mirror weights', [{ key: 'from', label: 'Copy from', type: 'choice', value: 1, options: [[1, '+X to -X'], [-1, '-X to +X']] }], (m, v) => { n = mirrorWeights(m, v.from); });
  toast(n ? `Mirrored ${n.toLocaleString()} vertices` : 'No mirrored vertices found. The mesh needs matching points across X.', n ? 'ok' : 'info');
}, { enabled: hasBones, hint: 'Copy weights to the other side, swapping to the opposite joints.' });
def('rig.mirrorJoints', 'Mirror Joints Across X', () => {
  let n = 0;
  const chosen = ed.mode === 'bone' && ed.selBones.size ? [...ed.selBones] : undefined;
  ed.transact('Mirror joints', (m) => { n = mirrorJoints(m, chosen); });
  toast(n ? `Added ${n} mirrored joint${n === 1 ? '' : 's'}` : 'Those joints are already mirrored, or sit on the centre line.', n ? 'ok' : 'info');
}, { enabled: hasBones, hint: 'Copy the selected joints, or everything on +X, to the other side. Names gain .L and .R.' });
def('rig.split', 'Insert Joint', () => {
  const id = ed.activeBone;
  if (!need(id !== null, 'Pick a joint first.')) return;
  let made: number | null = null;
  ed.transact('Insert joint', (m) => { made = splitJoint(m, id!); });
  if (made === null) { toast('This joint has no child to insert toward.', 'info'); return; }
  ed.activeBone = made;
  ed.selBones = new Set([made]);
  ed.emit('selection', 'skeleton');
}, { enabled: hasBones, hint: 'Add a joint midway between the active joint and its child.' });
def('rig.humanoid', 'Add Humanoid Skeleton', () => {
  let root = 0;
  ed.transact('Add humanoid', (m) => { root = addHumanoid(m); });
  ed.activeBone = root;
  ed.selBones = new Set([root]);
  ed.setMode('bone');
  ed.emit('selection', 'skeleton', 'tool');
  toast('Added a T-pose skeleton fitted to the mesh. Drag joints into place, then auto-weight.', 'ok');
}, { hint: 'A named, game-ready skeleton: spine, head, arms and legs, fitted to the model\'s size.' });
def('rig.selectUnweighted', 'Select Unweighted Vertices', () => {
  const { unweighted } = weightIssues(ed.model);
  if (!need(unweighted.length > 0, 'Every vertex has a weight.')) return;
  ed.setMode('vertex');
  ed.clearSelection();
  unweighted.forEach((v) => ed.selVerts.add(v));
  ed.emit('selection', 'tool');
}, { enabled: hasBones });
def('rig.testPose', 'Test Pose', () => {
  const on = !ed.testPose;
  ed.setTestPose(on);
  if (on) {
    ed.resetTestPose();
    if (ed.mode !== 'bone') ed.setMode('bone');
    setTool('rotate');
    status('Rotate joints to test the deformation. This pose isn\'t saved.');
  } else setTool('select');
  ed.emit('anim', 'geometry', 'skeleton', 'selection');
}, { checked: () => ed.testPose, enabled: hasBones, hint: 'Bend the rig to check its weights. No animation clip needed, and nothing is saved.' });
def('rig.resetPose', 'Reset Test Pose', () => {
  ed.resetTestPose();
  ed.emit('anim', 'geometry', 'skeleton');
}, { enabled: () => ed.testPose });
const resizeBrush = (k: number) => {
  if (ed.tool === 'sculpt') ed.sculpt.radius = Math.max(4, Math.min(400, ed.sculpt.radius * k));
  else if (ed.tool === 'stroke') ed.strokeRadius = Math.max(0.002, ed.strokeRadius * k);
  else ed.brush.radius = Math.max(4, Math.min(300, ed.brush.radius * k));
  ed.emit('tool');
  app.vp.invalidate();
};
def('rig.brushSmaller', 'Smaller Brush', () => resizeBrush(1 / 1.2), { key: '[' });
def('rig.brushBigger', 'Bigger Brush', () => resizeBrush(1.2), { key: ']' });
def('rig.assign', 'Assign to Active Joint', () => {
  const vs = ed.selectedVertexSet();
  if (!need(ed.activeBone !== null && vs.size > 0, 'Pick a joint and select vertices (switch to Vertex or Face mode).')) return;
  const b = ed.activeBone!;
  ed.transact('Assign to joint', (m) => vs.forEach((v) => { m.verts[v].w = [[b, 1]]; }));
}, { enabled: hasBones });
def('rig.clear', 'Clear Weights', () => {
  const vs = ed.selectedVertexSet();
  ed.transact('Clear weights', (m) => {
    (vs.size ? [...vs] : [...m.verts.keys()]).forEach((v) => { delete m.verts[v].w; });
  });
}, { enabled: hasBones });

// ---------- animation ----------
def('anim.newClip', 'New Clip', () => {
  ed.transact('New clip', (m) => {
    const c: Clip = { id: newId(m), name: uniqueName(m.clips.map((x) => x.name), 'Clip'), fps: 30, length: 60, loop: true, tracks: {} };
    m.clips.push(c);
    ed.activeClip = c.id;
  });
  ed.frame = 0;
  ed.emit('time');
});
def('anim.duplicateClip', 'Duplicate Clip', () => {
  const c = ed.clip();
  if (!c) return;
  ed.transact('Duplicate clip', (m) => {
    const copy: Clip = { ...structuredClone(c), id: newId(m), name: uniqueName(m.clips.map((x) => x.name), c.name) };
    m.clips.push(copy);
    ed.activeClip = copy.id;
  });
}, { enabled: () => !!ed.clip() });
def('anim.deleteClip', 'Delete Clip', () => {
  const id = ed.activeClip;
  ed.transact('Delete clip', (m) => { m.clips = m.clips.filter((c) => c.id !== id); ed.activeClip = null; });
}, { enabled: () => !!ed.clip() });
def('anim.play', 'Play / Pause', () => {
  if (!ed.clip()) { toast('Create a clip first.', 'info'); return; }
  if (!ed.pose) { ed.pose = true; ed.invalidatePose(); }
  ed.playing = !ed.playing;
  // Stop on a whole frame, so new keys land where the timeline shows them.
  if (!ed.playing) ed.frame = Math.round(ed.frame);
  ed.emit('time', 'anim');
}, { key: 'P' });
def('anim.togglePose', 'Pose Mode', () => {
  ed.pose = !ed.pose;
  ed.playing = false;
  ed.invalidatePose();
  ed.emit('anim', 'geometry', 'tool');
}, { key: 'Ctrl+Shift+P', checked: () => ed.pose });
def('anim.prevFrame', 'Previous Frame', () => { ed.frame = Math.max(0, ed.frame - 1); ed.emit('time'); }, { key: 'ArrowLeft' });
def('anim.nextFrame', 'Next Frame', () => { const c = ed.clip(); ed.frame = Math.min(c?.length ?? 0, ed.frame + 1); ed.emit('time'); }, { key: 'ArrowRight' });
def('anim.prevKey', 'Previous Keyframe', () => {
  const c = ed.clip(); if (!c) return;
  const k = keyFrames(c).filter((f) => f < ed.frame).pop();
  if (k !== undefined) { ed.frame = k; ed.emit('time'); }
}, { key: 'Shift+ArrowLeft' });
def('anim.nextKey', 'Next Keyframe', () => {
  const c = ed.clip(); if (!c) return;
  const k = keyFrames(c).find((f) => f > ed.frame);
  if (k !== undefined) { ed.frame = k; ed.emit('time'); }
}, { key: 'Shift+ArrowRight' });
def('anim.key', 'Insert Keyframe', () => {
  const c = ed.clip();
  if (!need(!!c, 'Create a clip first.') || !c) return;
  const ids = ed.selBones.size ? [...ed.selBones] : ed.model.bones.map((b) => b.id);
  const cid = c.id, frame = Math.round(ed.frame);
  ed.transact('Insert key', (m) => {
    const clip = m.clips.find((x) => x.id === cid)!;
    ids.forEach((id) => {
      const t = ensureTrack(clip, id);
      const s = sampleTrack(t, frame);
      setKey(t.rot, frame, [...s.rot] as any);
      setKey(t.pos, frame, [...s.pos] as any);
    });
  });
  toast(`Keyed ${ids.length} joint${ids.length === 1 ? '' : 's'} at frame ${frame}`, 'ok', 1500);
}, { key: 'K', enabled: hasBones });
def('anim.deleteKey', 'Delete Keys at Frame', () => {
  const c = ed.clip();
  if (!c) return;
  const ids = ed.selBones.size ? [...ed.selBones] : ed.model.bones.map((b) => b.id);
  const cid = c.id, frame = Math.round(ed.frame);
  ed.transact('Delete keys', (m) => {
    const clip = m.clips.find((x) => x.id === cid)!;
    ids.forEach((id) => {
      const t = clip.tracks[id];
      if (!t) return;
      t.rot = t.rot.filter((k) => k.f !== frame);
      t.pos = t.pos.filter((k) => k.f !== frame);
    });
  });
}, { key: 'Shift+K', enabled: () => !!ed.clip() });

// ---------- reference images ----------
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'];
export const isImageFile = (name: string) => IMAGE_EXTS.includes(name.split('.').pop()!.toLowerCase());

/** Add a picture behind a view, sized to the model if there is one. It starts ready to be moved and scaled. */
export async function addReference(name: string, data: ArrayBuffer, view: RefImage['view']) {
  const ext = name.split('.').pop()!.toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
  let bin = '';
  const bytes = new Uint8Array(data);
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  const url = `data:${mime};base64,${btoa(bin)}`;
  const img = new Image();
  img.src = url;
  await img.decode();
  const pts = ed.model.verts.map((v) => v.p);
  const { up, right } = viewBasis(view);
  const size = pts.length ? Math.max(bounds(pts).size[0], bounds(pts).size[1], bounds(pts).size[2], 0.5) * 1.1 : 2;
  const center = pts.length ? bounds(pts).center : ([0, size / 2, 0] as V3);
  let id = 0;
  ed.transact('Add reference image', (m) => {
    id = newId(m);
    m.refs = [...(m.refs ?? []), {
      id, name, url, view, width: img.naturalWidth, height: img.naturalHeight, size,
      x: center[0] * right.x + center[1] * right.y + center[2] * right.z,
      y: center[0] * up.x + center[1] * up.y + center[2] * up.z,
      opacity: 0.8, visible: true, over: false,
    }];
  });
  ed.refActive = id;
  ed.refEdit = true;
  ed.emit('view', 'tool');
  status('Drag the picture to place it, or a corner to scale it. Pick a shape when you\'re ready to draw.');
}

for (const [view, label] of [['front', 'Front'], ['right', 'Right'], ['back', 'Back'], ['left', 'Left'], ['top', 'Top'], ['bottom', 'Bottom']] as const) {
  def(`ref.add${label}`, `Add Reference Image: ${label}`, async () => {
    const f = await openFile([{ name: 'Images', extensions: IMAGE_EXTS }]);
    if (!f) return;
    await addReference(f.name, f.data, view);
  }, { hint: `Put a picture behind the ${label} view to model over. You can also drop one onto any view.` });
}
const editRef = (label: string, fn: (r: RefImage) => void) => {
  const id = ed.refActive;
  ed.transact(label, (m) => { const r = m.refs?.find((x) => x.id === id); if (r) fn(r); });
};
const hasRef = () => !!ed.model.refs?.some((r) => r.id === ed.refActive);
def('ref.adjust', 'Move and Scale Reference Image', () => { ed.refEdit = !ed.refEdit; ed.emit('view', 'tool'); app.vp.invalidate(); }, { checked: () => ed.refEdit, enabled: hasRef });
def('ref.fit', 'Fit Reference Image to Selection', () => {
  const pts = [...ed.selectedVertexSet()].map((v) => ed.model.verts[v].p);
  if (!need(pts.length > 0, 'Select what the picture should line up with.')) return;
  editRef('Fit reference image', (r) => {
    const { right, up } = viewBasis(r.view);
    const along = (p: V3, a: THREE.Vector3) => p[0] * a.x + p[1] * a.y + p[2] * a.z;
    const ups = pts.map((p) => along(p, up)), rights = pts.map((p) => along(p, right));
    r.size = Math.max(Math.max(...ups) - Math.min(...ups), 0.01);
    r.y = (Math.max(...ups) + Math.min(...ups)) / 2;
    r.x = (Math.max(...rights) + Math.min(...rights)) / 2;
  });
}, { enabled: hasRef, hint: 'Scale the picture so its height matches the selection, and centre it there.' });
def('ref.delete', 'Delete Reference Image', () => {
  const id = ed.refActive;
  ed.transact('Delete reference image', (m) => { m.refs = m.refs?.filter((r) => r.id !== id); });
  ed.refActive = null;
  ed.refEdit = false;
  ed.emit('view', 'tool');
}, { enabled: hasRef });
def('ref.ghost', 'See-Through Pieces', () => { ed.blockGhost = !ed.blockGhost; ed.emit('view', 'tool'); app.vp.invalidate(); }, { checked: () => ed.blockGhost, hint: 'Show the picture through your pieces while you trace it.' });
def('ref.inPersp', 'Show References in Perspective', () => { ed.refsInPersp = !ed.refsInPersp; ed.emit('view', 'tool'); app.vp.invalidate(); }, { checked: () => ed.refsInPersp });

// ---------- blockout ----------
/** The pieces selected in the view: each selected face's group, with locked pieces left out. */
const selectedPieces = (): number[] => {
  const ids = new Set<number>();
  ed.selectedFaceSet().forEach((f) => ids.add(ed.model.faces[f].g));
  return [...ids].filter((id) => !ed.model.groups.find((g) => g.id === id)?.locked);
};
const pieceOp = (label: string, fn: (m: Model, ids: number[]) => void) => () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  ed.transact(label, (m) => fn(m, ids));
};
const selectPieces = (ids: number[]) => {
  ed.clearSelection();
  ed.model.faces.forEach((f, i) => { if (ids.includes(f.g)) ed.selFaces.add(i); });
  if (ids.length) ed.activeGroup = ids[ids.length - 1];
  ed.emit('selection', 'groups');
};
for (const [kind, label, hint] of [
  ['character', 'Character', 'A human-proportioned body in separate, named pieces, ready to reshape.'],
  ['chibi', 'Chibi', 'A big-headed, stylised body in separate, named pieces.'],
  ['creature', 'Creature', 'A four-legged body with a tail, in separate, named pieces.'],
] as const) {
  def(`block.start.${kind}`, `Start from ${label}`, () => {
    let made: number[] = [];
    ed.transact(`Add ${label.toLowerCase()}`, (m) => { made = addStarter(m, kind, ed.figure.height); });
    if (ed.workspace === 'block') { ed.mode = 'group'; setTool('select'); }
    ed.clearSelection();
    ed.emit('selection', 'tool');
    app.vp.frameSelected(true);
    toast(`Added ${made.length} pieces. Click one to reshape it, or pick Limb to add more.`, 'ok');
  }, { hint });
}
for (const [kind, def0] of Object.entries(PARTS)) {
  def(`part.${kind}`, `Draw ${def0.label}`, () => {
    app.vp.dropPrim();
    ed.partKind = kind;
    setTool('part');
    status(def0.hint);
  }, { checked: () => ed.tool === 'part' && ed.partKind === kind, hint: def0.hint });
}
for (const [mode, label, hint] of [
  ['grab', 'Grab', 'Drag the surface around.'],
  ['inflate', 'Inflate', 'Swell the surface outward. Shift deflates.'],
  ['smooth', 'Smooth', 'Even out lumps and creases.'],
  ['flatten', 'Flatten', 'Press the surface flat: planes of the face, chest and hips.'],
  ['pinch', 'Pinch', 'Draw the surface inward to a crease: lips, knuckles, muscle lines. Shift pushes apart.'],
] as const) {
  def(`sculpt.${mode}`, `Sculpt: ${label}`, () => { ed.sculpt.mode = mode; setTool('sculpt'); }, { checked: () => ed.tool === 'sculpt' && ed.sculpt.mode === mode, hint });
}
const DETAIL: Record<string, [number, number]> = { medium: [12, 8], high: [24, 16] };
def('block.detail.low', 'Detail: Low Poly', () => { ed.setLowPoly(true); app.vp.refreshPrim(); ed.emit('tool'); }, { checked: () => ed.lowPoly, hint: 'New pieces use few faces with flat shading.' });
for (const [name, [seg, rings]] of Object.entries(DETAIL)) {
  def(`block.detail.${name}`, `Detail: ${name === 'medium' ? 'Medium' : 'High'}`, () => {
    ed.setLowPoly(false);
    ed.primSegments = seg;
    ed.primRings = rings;
    app.vp.refreshPrim();
    ed.emit('tool');
  }, { checked: () => !ed.lowPoly && ed.primSegments === seg && ed.primRings === rings, hint: 'New pieces are smooth shaded, with more faces.' });
}
/** Keep pieces selected after an edit that rebuilds their faces. */
const reselectPieces = (m: Model, ids: number[]) => {
  ed.clearSelection();
  m.faces.forEach((f, i) => { if (ids.includes(f.g)) ed.selFaces.add(i); });
};
/** Selected pieces, plus their other sides when symmetry is on. */
const piecesWithTwins = (): number[] => {
  const ids = new Set(selectedPieces());
  if (ed.mirrorX) for (const id of [...ids]) { const t = twinOf(ed.model, id); if (t !== null) ids.add(t); }
  return [...ids];
};
for (const [mode, label, amount, unit, lo, hi, hint] of [
  ['taper', 'Taper', 0.5, 'Amount', -2, 0.99, 'Narrow a piece toward one end, or widen it with a negative amount.'],
  ['bend', 'Bend', 45, 'Degrees', -360, 360, 'Curve a piece along its length, keeping its length the same.'],
  ['twist', 'Twist', 45, 'Degrees', -1080, 1080, 'Turn one end of a piece against the other.'],
] as const) {
  def(`block.${mode}`, `${label} Piece`, () => {
    const ids = piecesWithTwins();
    if (!need(ids.length > 0, 'Select a piece first.')) return;
    // Start along the piece's longest side, which is nearly always what's meant.
    const size = pieceBounds(ed.model, ids[0]).size;
    const longest = size[1] >= size[0] && size[1] >= size[2] ? 1 : size[0] >= size[2] ? 0 : 2;
    const centers = new Map(ids.map((id) => [id, pieceBounds(ed.model, id).center[0]]));
    ed.runOp(label, [
      { key: 'amount', label: unit, type: 'number', value: amount, min: lo, max: hi, step: mode === 'taper' ? 0.05 : 5 },
      { key: 'axis', label: 'Along', type: 'choice', value: longest, options: [[0, 'X'], [1, 'Y'], [2, 'Z']] },
    ], (m, v) => {
      for (const id of ids) {
        // The other side turns the opposite way, so the pair stays a mirror image.
        const flip = mode !== 'taper' && ed.mirrorX && (centers.get(id) ?? 0) < -1e-4;
        deformPiece(m, id, mode, v.axis, flip ? -v.amount : v.amount);
      }
    });
  }, { enabled: hasAnyMesh, hint });
}
def('block.fuse', 'Fuse Pieces', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select the pieces to melt together.')) return;
  let made: number | null = null;
  ed.runOp('Fuse', [
    { key: 'detail', label: 'Detail', type: 'number', value: ed.lowPoly ? 16 : 48, min: 8, max: 160, step: 4 },
    { key: 'smoothing', label: 'Smoothing', type: 'number', value: 1, min: 0, max: 6, step: 1 },
  ], (m, v) => {
    made = fusePieces(m, ids, v.detail, v.smoothing, !ed.lowPoly);
    ed.clearSelection();
    if (made !== null) { ed.mode = 'group'; ed.activeGroup = made; m.faces.forEach((f, i) => { if (f.g === made) ed.selFaces.add(i); }); }
  });
  if (made === null) toast('Those pieces have no volume to fuse.', 'info');
}, { enabled: hasAnyMesh, hint: 'Melt the selected pieces into one seamless mesh, rounding the joins. Lower Detail gives a low-poly result.' });
def('block.radial', 'Radial Array', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  // Around the active piece if it's a different one, or else the centre of the world.
  const active = ed.activeGroup;
  const others = active !== null && !ids.includes(active) ? pieceBounds(ed.model, active).center : ([0, pieceBounds(ed.model, ids[0]).center[1], 0] as V3);
  ed.runOp('Radial array', [
    { key: 'count', label: 'Count', type: 'number', value: 6, min: 2, max: 128, step: 1 },
    { key: 'axis', label: 'Around', type: 'choice', value: 1, options: [[0, 'X'], [1, 'Y'], [2, 'Z']] },
  ], (m, v) => { radialPieces(m, ids, Math.round(v.count), v.axis, others); });
}, { enabled: hasAnyMesh, hint: 'Repeat a piece evenly around a centre: petals, spikes, a crown, a spider\'s legs.' });
def('block.center', 'Centre on X', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  ed.transact('Centre piece', (m) => {
    for (const id of ids) {
      const dx = -pieceBounds(m, id).center[0];
      const moved = new Set<number>();
      for (const f of m.faces) if (f.g === id) for (const v of f.v) moved.add(v);
      for (const v of moved) { const p = m.verts[v].p; m.verts[v].p = [p[0] + dx, p[1], p[2]]; }
    }
  });
}, { enabled: hasAnyMesh, hint: 'Put a piece on the centre line, so it stays symmetrical.' });
let isolated: number[] | null = null;
def('block.isolate', 'Isolate Selection', () => {
  const m = ed.model;
  if (isolated) {
    for (const g of m.groups) if (isolated.includes(g.id)) g.visible = true;
    isolated = null;
  } else {
    const ids = selectedPieces();
    if (!need(ids.length > 0, 'Select what to focus on.')) return;
    isolated = m.groups.filter((g) => g.visible && !ids.includes(g.id)).map((g) => g.id);
    for (const g of m.groups) if (isolated.includes(g.id)) g.visible = false;
  }
  ed.emit('groups', 'topology', 'view', 'tool');
}, { key: 'Alt+I', checked: () => isolated !== null, hint: 'Hide everything else while you work on a piece. Press again to bring it all back.' });
def('block.round', 'Round Off', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  ed.runOp('Round off', [{ key: 'levels', label: 'Levels', type: 'number', value: 1, min: 1, max: 3, step: 1 }], (m, v) => {
    for (const id of ids) for (let i = 0; i < v.levels; i++) ops.subdivide(m, new Set(ops.groupFaces(m, id)), true);
    reselectPieces(m, ids);
  });
}, { enabled: hasAnyMesh, hint: 'Smooth a hard or blocky piece into a rounder one, adding faces.' });
def('block.reduce', 'Make Lower Poly', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  ed.runOp('Make lower poly', [{ key: 'keep', label: 'Keep %', type: 'number', value: 50, min: 5, max: 95, step: 5 }], (m, v) => {
    for (const id of ids) reducePiece(m, id, v.keep / 100);
    reselectPieces(m, ids);
  });
}, { enabled: hasAnyMesh, hint: 'Simplify a piece for a chunkier low-poly look, keeping its overall shape.' });
def('block.drop', 'Drop to Surface', pieceOp('Drop', (m, ids) => dropPieces(m, ids)), { key: 'Alt+D', enabled: hasAnyMesh, hint: 'Lower the selected pieces onto what\'s beneath them, or else the ground.' });
def('block.snap', 'Snap to Grid', pieceOp('Snap to grid', (m, ids) => snapPieces(m, ids, ed.snapStep)), { enabled: hasAnyMesh, hint: 'Line each piece\'s corner up with the grid, without changing its shape.' });
def('block.duplicate', 'Duplicate Piece', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  let made: number[] = [];
  ed.transact('Duplicate piece', (m) => { made = arrayPieces(m, ids, 2, [0, 0, 0]); });
  selectPieces(made);
  setTool('move');
}, { enabled: hasAnyMesh, hint: 'Copy the piece in place and pick it up, ready to move.' });
def('block.array', 'Array', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  const box = ids.map((id) => pieceBounds(ed.model, id));
  const span = Math.max(...box.map((b) => b.size[0])) || 1;
  ed.runOp('Array', [
    { key: 'count', label: 'Count', type: 'number', value: 4, min: 2, max: 200, step: 1 },
    { key: 'x', label: 'X', type: 'number', value: span, min: -1000, max: 1000, step: ed.snapStep },
    { key: 'y', label: 'Y', type: 'number', value: 0, min: -1000, max: 1000, step: ed.snapStep },
    { key: 'z', label: 'Z', type: 'number', value: 0, min: -1000, max: 1000, step: ed.snapStep },
  ], (m, v) => { arrayPieces(m, ids, Math.round(v.count), [v.x, v.y, v.z]); });
}, { enabled: hasAnyMesh, hint: 'Repeat the piece in a line: fingers, ribs, teeth, spikes.' });
def('block.mirror', 'Mirror Piece', () => {
  const ids = selectedPieces();
  if (!need(ids.length > 0, 'Select a piece first.')) return;
  let made = 0;
  ed.transact('Mirror piece', (m) => { for (const id of ids) if (mirrorPiece(m, id) !== null) made++; });
  if (!made) toast('This piece sits on the centre line, so it\'s already symmetrical.', 'info');
}, { enabled: hasAnyMesh, hint: 'Add the other side across X. Names gain .L and .R.' });
for (const [axis, name] of [[0, 'X'], [1, 'Y'], [2, 'Z']] as const) {
  for (const [edge, label] of [['min', 'Low'], ['center', 'Centre'], ['max', 'High']] as const) {
    def(`block.align${name}${label}`, `Align ${name} ${label}`, () => {
      const ids = selectedPieces();
      const to = ed.activeGroup;
      if (!need(ids.length > 1 && to !== null && ids.includes(to), 'Select two or more pieces. They line up with the active one.')) return;
      ed.transact(`Align ${name}`, (m) => alignPieces(m, ids, to!, axis, edge));
    }, { enabled: hasAnyMesh });
  }
}
def('block.colorsToMaterials', 'Colours to Materials', () => {
  let n = 0;
  ed.transact('Colours to materials', (m) => { n = colorsToMaterials(m); });
  toast(n ? `Added ${n} material${n === 1 ? '' : 's'}` : 'Every piece already has a material.', n ? 'ok' : 'info');
}, { enabled: hasAnyMesh, hint: 'Give pieces without a material one in their blockout colour, so the colours export.' });
def('block.placeFigure', 'Move Figure Beside Selection', () => {
  const vs = [...ed.selectedVertexSet()].map((v) => ed.model.verts[v].p);
  if (!need(vs.length > 0, 'Select something to stand beside.')) return;
  const b = bounds(vs);
  ed.figure.pos = [b.min[0] - ed.figure.height * 0.4, b.min[1], b.center[2]];
  app.vp.invalidate();
}, { hint: 'Stand the scale figure next to what you\'re judging.' });
def('block.figure', 'Show Size Reference', () => { ed.figure.show = !ed.figure.show; ed.emit('view', 'tool'); app.vp.invalidate(); }, { checked: () => ed.figure.show, hint: 'A stick figure at real height. It isn\'t part of the model and doesn\'t export.' });
def('block.dims', 'Show Measurements', () => { ed.blockDims = !ed.blockDims; ed.emit('view', 'tool'); app.vp.invalidate(); }, { checked: () => ed.blockDims, hint: 'Label the selection\'s size in metres.' });

const hasClip = () => !!ed.clip();
/** Run an undoable edit on a copy-safe reference to the active clip. */
const clipEdit = (label: string, fn: (c: Clip, m: Model) => void) => {
  const id = ed.activeClip;
  ed.transact(label, (m) => { const c = m.clips.find((x) => x.id === id); if (c) fn(c, m); });
};

// Curves.
const EASE_LABELS: [anim.EaseName, string, string][] = [
  ['linear', 'Linear', 'Constant speed'], ['smooth', 'Smooth', 'Ease in and out'], ['in', 'Ease In', 'Start slow'], ['out', 'Ease Out', 'End slow'],
  ['overshoot', 'Overshoot', 'Go past the target, then settle'], ['anticipate', 'Anticipate', 'Pull back before moving'], ['step', 'Hold', 'Keep this pose until the next key'],
];
for (const [ease, label, hint] of EASE_LABELS) {
  def(`anim.ease.${ease}`, label, () => {
    const refs = app.timeline.targets();
    if (!need(refs.length > 0, 'Select keys, or a joint with a key on this frame.')) return;
    clipEdit(`Curve: ${label}`, (c) => anim.setEase(c, refs, ease));
  }, { enabled: hasClip, hint });
}

// Keys.
let keyClipboard: anim.KeyClip | null = null;
def('anim.copyKeys', 'Copy Keys', () => {
  const c = ed.clip();
  const refs = app.timeline.targets();
  if (!c || !need(refs.length > 0, 'Select keys to copy.')) return;
  keyClipboard = anim.copyKeys(c, refs);
  toast(`Copied ${refs.length} key${refs.length === 1 ? '' : 's'}`, 'ok', 1500);
}, { enabled: hasClip });
def('anim.pasteKeys', 'Paste Keys at Frame', () => {
  if (!need(!!keyClipboard, 'Copy some keys first.')) return;
  const f = Math.round(ed.frame), data = keyClipboard!;
  clipEdit('Paste keys', (c) => anim.pasteKeys(c, data, f));
}, { enabled: hasClip });
def('anim.deleteSelected', 'Delete Selected Keys', () => {
  const refs = app.timeline.targets();
  if (!need(refs.length > 0, 'Select keys to delete.')) return;
  clipEdit('Delete keys', (c) => anim.deleteKeys(c, refs));
  app.timeline.clearSelection();
}, { enabled: hasClip });

// Poses.
let poseClipboard: anim.Pose | null = null;
const poseJoints = () => (ed.selBones.size ? [...ed.selBones] : ed.model.bones.map((b) => b.id));
def('anim.copyPose', 'Copy Pose', () => {
  const c = ed.clip();
  if (!c) return;
  poseClipboard = anim.capturePose(c, Math.round(ed.frame), poseJoints());
  toast(`Copied the pose of ${poseClipboard.size} joint${poseClipboard.size === 1 ? '' : 's'}`, 'ok', 1500);
}, { enabled: hasClip, hint: 'The selected joints, or the whole rig.' });
const pastePose = (label: string, mirrored: boolean) => () => {
  if (!need(!!poseClipboard, 'Copy a pose first.')) return;
  const f = Math.round(ed.frame), pose = poseClipboard!;
  clipEdit(label, (c, m) => anim.applyPose(c, f, pose, m, mirrored));
};
def('anim.pastePose', 'Paste Pose', pastePose('Paste pose', false), { enabled: hasClip });
def('anim.pasteMirrored', 'Paste Pose Mirrored', pastePose('Paste pose mirrored', true), { enabled: hasClip, hint: 'Left and right swap. Copy a stride at the start of a walk and paste it mirrored halfway through.' });
def('anim.mirrorPose', 'Mirror Pose', () => {
  const f = Math.round(ed.frame);
  const ids = poseJoints();
  clipEdit('Mirror pose', (c, m) => anim.applyPose(c, f, anim.capturePose(c, f, ids), m, true));
}, { enabled: hasClip, hint: 'Flip this frame\'s pose left to right.' });
def('anim.resetPose', 'Reset Pose', () => {
  const f = Math.round(ed.frame);
  const ids = poseJoints();
  clipEdit('Reset pose', (c) => anim.resetPose(c, f, ids));
}, { enabled: hasClip, hint: 'Return the selected joints, or the whole rig, to rest at this frame.' });

// Whole clips.
def('anim.rename', 'Rename Clip', () => app.timeline.rename(), { enabled: hasClip });
def('anim.makeLoop', 'Make Seamless Loop', () => clipEdit('Make loop', (c) => anim.makeLoop(c)), { enabled: hasClip, hint: 'Copy the first pose to the last frame, so the clip loops without a jump.' });
def('anim.mirrorClip', 'Mirror Clip', () => clipEdit('Mirror clip', (c, m) => anim.mirrorClip(c, m)), { enabled: hasClip, hint: 'Swap left and right for the whole clip.' });
def('anim.reverse', 'Reverse Clip', () => clipEdit('Reverse clip', (c) => anim.reverseClip(c)), { enabled: hasClip });
def('anim.retime', 'Change Speed', () => {
  const id = ed.activeClip;
  ed.runOp('Change speed', [{ key: 'percent', label: 'Duration %', type: 'number', value: 100, min: 5, max: 1000, step: 5 }], (m, v) => {
    const c = m.clips.find((x) => x.id === id);
    if (c) anim.retimeClip(c, v.percent / 100);
  });
  app.timeline.frameAll();
}, { enabled: hasClip, hint: 'Stretch or squash every key. Below 100% plays faster.' });
def('anim.reduce', 'Reduce Keys', () => {
  const id = ed.activeClip;
  ed.runOp('Reduce keys', [
    { key: 'angle', label: 'Angle', type: 'number', value: 0.5, min: 0.01, max: 15, step: 0.1 },
    { key: 'distance', label: 'Distance', type: 'number', value: 0.002, min: 0, max: 1, step: 0.001 },
  ], (m, v) => {
    const c = m.clips.find((x) => x.id === id);
    if (c) anim.reduceKeys(c, v.angle, v.distance);
  });
}, { enabled: hasClip, hint: 'Remove keys the motion doesn\'t need. Good for imported animation, and for smaller game files.' });
def('anim.bake', 'Bake to Every Frame', () => clipEdit('Bake clip', (c) => anim.bakeClip(c)), { enabled: hasClip, hint: 'Replace curves with a key on every frame.' });
def('anim.fitLength', 'Trim End to Last Key', () => clipEdit('Trim clip', (c) => { c.length = Math.max(1, anim.clipEnd(c)); }), { enabled: hasClip });
def('anim.frameAll', 'Frame Whole Clip', () => app.timeline.frameAll(), { enabled: hasClip });
const animToggle = (id: string, label: string, get: () => boolean, set: (v: boolean) => void, hint: string, key?: string) =>
  def(id, label, () => { set(!get()); ed.emit('view', 'tool'); app.vp.invalidate(); }, { checked: get, hint, key });
animToggle('anim.onion', 'Onion Skin', () => ed.onion, (v) => { ed.onion = v; }, 'See faint copies of the frames before (red) and after (green).', 'Alt+O');
animToggle('anim.trail', 'Motion Trail', () => ed.trail, (v) => { ed.trail = v; }, 'Draw the path of the selected joints. Dots mark keys.');
animToggle('anim.ikHold', 'Hold Rotation in IK', () => ed.ikHold, (v) => { ed.ikHold = v; }, 'Keep the dragged joint\'s rotation.');

// ---------- help ----------
def('help.palette', 'Command Palette…', () => openPalette(), { key: 'Ctrl+K' });
def('help.shortcuts', 'Keyboard Shortcuts', () => openShortcuts(), { key: 'F1' });
def('help.keymap', 'Customize Shortcuts…', () => openKeymapEditor(), { hint: 'Change the keys for any command' });
def('help.about', 'About ThickShake', () => openAbout());
def('escape', 'Cancel', () => {
  if (app.vp.drawingPrim) { app.vp.removePrim(); return; }
  if (app.vp.pendingFace) { app.vp.clearPending(); status(''); return; }
  if (ed.tool === 'joint') { ed.activeBone = null; ed.selBones.clear(); ed.emit('selection', 'skeleton'); return; }
  if (ed.tool !== 'select') { setTool('select'); return; }
  selectAllOf(false);
}, { key: 'Escape', hint: 'hidden' });
def('enter', 'Confirm', () => { if (app.vp.drawingPrim) app.vp.dropPrim(); else if (app.vp.pendingFace) app.vp.closeFace(); }, { key: 'Enter', hint: 'hidden' });

// ---------- shortcuts ----------
function comboOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.shiftKey) parts.push('Shift');
  if (e.altKey) parts.push('Alt');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (k === '+' ) k = '=';
  if (k === '_' ) k = '-';
  parts.push(k);
  return parts.join('+');
}

const ARROWS: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };

/** LightWave's numeric keypad views and arrow key panning. Returns true if it used the key. */
function navKey(e: KeyboardEvent): boolean {
  // The numpad works as in Blender.
  if (/^Numpad(\d|Decimal)$/.test(e.code)) {
    if (e.altKey || e.shiftKey) return false;
    const step = (15 * Math.PI) / 180;
    switch (e.code) {
      case 'Numpad1': app.vp.numpadView('front', 'back', e.ctrlKey); break;
      case 'Numpad3': app.vp.numpadView('right', 'left', e.ctrlKey); break;
      case 'Numpad7': app.vp.numpadView('top', 'bottom', e.ctrlKey); break;
      case 'Numpad5': app.vp.togglePerspective(); break;
      // Orbit a step: 4 and 6 turn, 8 and 2 tilt; 9 swings round to the other side.
      case 'Numpad4': app.vp.orbitStep(-step, 0); break;
      case 'Numpad6': app.vp.orbitStep(step, 0); break;
      case 'Numpad8': app.vp.orbitStep(0, -step); break;
      case 'Numpad2': app.vp.orbitStep(0, step); break;
      case 'Numpad9': app.vp.orbitStep(Math.PI, 0); break;
      case 'Numpad0': app.vp.toggleMax(); break;
      case 'NumpadDecimal': app.vp.frameSelected(false); break;
      default: return false;
    }
    return true;
  }
  const dir = ARROWS[e.key];
  if (!dir || e.ctrlKey) return false;
  if (app.vp.drawingPrim && !e.altKey && !e.shiftKey) { app.vp.adjustPrimSegments(dir[0], dir[1]); return true; }
  // Left and right step through frames in the Animation workspace.
  if (ed.workspace === 'animate' && dir[0] !== 0) return false;
  // With something selected, the arrows move it along the view; Shift makes the step finer. Alt still pans.
  if (!e.altKey && ed.workspace !== 'animate' && app.vp.nudgeKey(dir[0], dir[1], e.shiftKey)) return true;
  if (e.altKey) {
    const fine = ed.snap ? ed.snapStep : undefined;
    const scale = e.shiftKey ? 10 : 1;
    app.vp.panKey(dir[0], dir[1], scale * 0.1, fine === undefined ? undefined : fine * scale);
  } else app.vp.panKey(dir[0], dir[1], e.shiftKey ? 4 : 1);
  return true;
}

const table = new Map<string, string>();

/** Rebuild the key-to-command table, after shortcuts change. */
export function rebuildShortcuts() {
  table.clear();
  commands.forEach((c) => { if (c.key) table.set(c.key, c.id); });
}

export { comboOf };

export function bindShortcuts() {
  rebuildShortcuts();
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || (t.tagName === 'SELECT' && !e.ctrlKey)) return;
    if (document.querySelector('.modal-back, .palette-back')) return;
    if (app.vp.toolKey(e)) { e.preventDefault(); return; }
    // A button reached by keyboard takes Enter and Space. One that was clicked keeps focus but doesn't, so Enter still finishes a drawing.
    if (t.tagName === 'BUTTON' && (e.key === 'Enter' || e.key === ' ') && t.matches(':focus-visible')) return;
    if (navKey(e)) { e.preventDefault(); return; }
    const combo = comboOf(e);
    // K keys a pose in Animate, and is the Knife everywhere else. Shift+K likewise.
    const knifeKey = (combo === 'K' || combo === 'Shift+K') && ed.workspace !== 'animate';
    const id = knifeKey ? 'tool.knife' : table.get(combo);
    if (!id) return;
    e.preventDefault();
    // From the keyboard, as in Blender, these do one cut and hand back the tool you were using.
    if (id === 'tool.knife' || id === 'tool.loopcut') app.vp.startOneShot(id === 'tool.knife' && combo === 'Shift+K');
    runCommand(id);
  });
}

export { hasFaces, hasVerts, parseEdge };
