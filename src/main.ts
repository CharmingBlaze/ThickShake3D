// ThickShake application shell.
import './style.css';
import { ed, type Workspace } from './core/editor';
import { emptyModel } from './core/types';
import { defaultExport, exportGLB } from './io/gltf';
import { importFile } from './io/importer';
import { exportMS3D } from './io/ms3d';
import { autosave, native, recentFiles } from './io/platform';
import { exportOBJ } from './io/simple';
import { parseProject, serializeProject } from './io/project';
import { app } from './ui/app';
import { addReference, bindShortcuts, commands, confirmDiscard, isImageFile, loadOpened, mergeOpened, runCommand, TOOLS } from './ui/commands';
import { button, h, ICONS, numField, renderInto, svgIcon } from './ui/dom';
import { modal, reportError, setStatusEl, toast } from './ui/feedback';
import { buildDock, flipNormalGreen, halveTextures, importImageFiles, makeNormalFromBase, makePaletteFromPixels, modelStats, packOrmImage, panelState, refreshDock } from './ui/panels';
import { Timeline } from './ui/timeline';
import { UVEditor } from './ui/uvEditor';
import type { MapSlot } from './core/types';
import { colorStore } from './ui/colorPicker';
import { flyoutButton } from './ui/menu';
import type { Shading } from './view/scene';
import { Viewports } from './view/viewports';

// ---------- menus ----------
const MENUS: [string, (string | null)[]][] = [
  ['File', ['file.new', 'file.open', null, 'file.save', 'file.saveAs', null, 'file.import', 'file.export', null, 'file.sample', ...(native ? [null, 'file.quit'] : [])]],
  ['Edit', ['edit.undo', 'edit.redo', null, 'edit.duplicate', 'edit.delete', null, 'select.all', 'select.none', 'select.invert', 'select.grow', 'select.shrink', 'select.linked', null, 'select.loop', 'select.ring', 'select.boundary', 'select.similarNormal']],
  ['Create', ['tool.box', 'tool.sphere', 'tool.geosphere', 'tool.cylinder', 'tool.cone', 'tool.limb', 'tool.stroke', 'tool.blob', 'tool.pen', 'tool.lathe', 'tool.capsule', 'tool.tapered', 'tool.pyramid', 'tool.wedge', 'tool.stairs', 'tool.doorway', 'tool.plane', 'tool.torus', null, 'create.lowPoly', 'create.onSurface', null, 'tool.vertex', 'tool.face', 'tool.joint']],
  ['Mesh', ['tool.extrude', 'mesh.inset', 'tool.loopcut', 'tool.knife', 'mesh.subdivide', 'mesh.makeFace', 'mesh.fillHoles', null, 'mesh.weld', 'mesh.collapse', 'mesh.weldAll', 'mesh.smoothVerts', null, 'mesh.triangulate', 'mesh.quadify', 'mesh.mirror', null, 'mesh.detach', 'mesh.regroup', 'mesh.mergeGroups', null, 'mesh.flip', 'mesh.fixNormals', 'mesh.smoothShade', 'mesh.flatShade', 'mesh.autoSmooth', null, 'mesh.centerOrigin', 'mesh.ground', 'mesh.rescale']],
  ['UV', ['uv.unwrap', 'uv.smart', null, 'uv.box', 'uv.planarView', 'uv.cylinder', 'uv.sphere', null, 'uv.pack', 'uv.minimize', 'uv.average', 'uv.fit', 'uv.density', null, 'uv.markSeam', 'uv.clearSeam', 'uv.seamsFromIslands', 'uv.clearAllSeams', null, 'uv.exportLayout']],
  ['Rig', ['rig.humanoid', 'tool.joint', 'rig.split', 'rig.mirrorJoints', null, 'rig.autoWeightsAll', 'rig.autoWeights', 'rig.assign', 'rig.clear', null, 'tool.paint', 'rig.smooth', 'rig.mirrorWeights', 'rig.prune', 'rig.selectUnweighted', null, 'rig.testPose', 'rig.resetPose']],
  ['Animate', ['anim.play', 'anim.togglePose', 'tool.ik', null, 'anim.key', 'anim.deleteKey', 'anim.prevKey', 'anim.nextKey', null, 'anim.copyPose', 'anim.pastePose', 'anim.pasteMirrored', 'anim.mirrorPose', 'anim.resetPose', null, 'anim.newClip', 'anim.duplicateClip', 'anim.deleteClip', 'anim.makeLoop', 'anim.mirrorClip', 'anim.reverse', 'anim.retime', 'anim.reduce', 'anim.bake', null, 'anim.onion', 'anim.trail']],
  ['Game', ['mesh.generateLods', 'mesh.collisionHull', 'mesh.collisionBox', null, 'mesh.cleanDegenerate', 'mesh.cleanLoose', 'mesh.triangulateNgons', null, 'file.export']],
  ['View', ['view.frame', 'view.frameAll', 'view.maximize', 'view.center', 'view.zoomIn', 'view.zoomOut', 'view.level', 'view.link', null, 'ref.addFront', 'ref.addRight', 'ref.addTop', null, 'view.xray', 'view.wire', 'view.grid', 'view.bones', 'view.boneNames', 'view.timeline', null, 'view.snap', 'view.mirrorX', ...(native ? [null, 'view.fullscreen', 'view.devtools'] : [])]],
  ['Help', ['help.palette', 'help.shortcuts', null, 'help.about']],
];

function buildMenuBar(): HTMLElement {
  const bar = h('nav', { class: 'menubar', 'aria-label': 'Main menu' });
  let open: HTMLElement | null = null;
  const closeAll = () => { open?.remove(); open = null; bar.querySelectorAll('.menu-btn.open').forEach((b) => b.classList.remove('open')); };
  const show = (btn: HTMLElement, items: (string | null)[]) => {
    closeAll();
    const r = btn.getBoundingClientRect();
    btn.classList.add('open');
    open = h('div', { class: 'menu', role: 'menu', style: { left: `${r.left}px`, top: `${r.bottom}px` } },
      items.map((id) => {
        if (id === null) return h('div', { class: 'menu-sep' });
        const c = commands.get(id);
        if (!c) return null;
        const disabled = c.enabled ? !c.enabled() : false;
        return h('button', {
          class: 'menu-item', role: 'menuitem', disabled,
          onclick: () => { closeAll(); runCommand(id); },
        }, h('span', { class: 'menu-check' }, c.checked?.() ? svgIcon(ICONS.check, 14) : null), h('span', { class: 'menu-label' }, c.label.replace(/ Tool$/, '')), c.key ? h('kbd', null, c.key) : null);
      }));
    document.body.appendChild(open);
  };
  for (const [label, items] of MENUS) {
    const btn = h('button', {
      class: 'menu-btn',
      onpointerdown: (e: Event) => { e.stopPropagation(); if (btn.classList.contains('open')) closeAll(); else show(btn, items); },
      onpointerenter: () => { if (open && !btn.classList.contains('open')) show(btn, items); },
    }, label);
    bar.appendChild(btn);
  }
  window.addEventListener('pointerdown', (e) => { if (open && !open.contains(e.target as Node)) closeAll(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); closeAll(); } }, true);
  return bar;
}

// ---------- shell ----------
const root = document.getElementById('app')!;
const statusText = h('span', { class: 'status-text' });
setStatusEl(statusText);

const titleName = h('span', { class: 'title-name' });
const wsTabs = h('div', { class: 'ws-tabs', role: 'tablist', 'aria-label': 'Workspaces' }, ([
  ['block', 'Blockout'], ['model', 'Model'], ['uv', 'UV'], ['rig', 'Rig'], ['animate', 'Animate'],
] as [Workspace, string][]).map(([w, l]) => h('button', { 'data-ws': w, role: 'tab', onclick: () => setWorkspace(w) }, l)));

const options = h('div', { class: 'optionsbar' });

// One bar holds the menus, workspaces and tool options. It only wraps if the window is too narrow for them.
const titlebar = h('header', { class: `titlebar${native ? ' has-window-controls' : ''}` },
  h('img', { class: 'app-icon', src: './icon.png', alt: 'ThickShake' }),
  buildMenuBar(),
  wsTabs,
  h('span', { class: 'tl-sep' }),
  options,
);

// Tool rail
const groupLabels: Record<string, string> = { edit: 'Transform', model: 'Build', create: 'Primitives', rig: 'Rig' };
const toolButtons = new Map<string, HTMLElement>();
const PRIMITIVES = ['box', 'sphere', 'geosphere', 'cylinder', 'cone', 'pyramid', 'torus', 'plane', null, 'capsule', 'tapered', 'wedge', 'stairs', 'doorway'];
const primitivesBtn = flyoutButton('Primitives', '<circle cx="16.5" cy="7.5" r="4.5"/><path d="M9 9l5.6 3.2v6.6L9 22l-5.6-3.2v-6.6z"/><path d="M3.4 12.2L9 15.5l5.6-3.3M9 15.5V22"/>', PRIMITIVES.map((id) => {
  const t = TOOLS.find((x) => x.id === id);
  return t ? { command: `tool.${t.id}`, label: t.label, icon: t.icon } : null;
}));
const rail = h('div', { class: 'toolrail', role: 'toolbar', 'aria-label': 'Tools', 'aria-orientation': 'vertical' }, Object.keys(groupLabels).map((g) => [
  h('div', { class: 'rail-sep', title: groupLabels[g] }),
  g === 'create' ? primitivesBtn : TOOLS.filter((t) => t.group === g).map((t) => {
    const b = h('button', {
      class: 'tool-btn', 'aria-label': t.label,
      title: `${t.label}${t.key ? `  (${t.key})` : ''}\n${t.hint}`,
      onclick: () => runCommand(`tool.${t.id}`),
    }, svgIcon(t.icon));
    toolButtons.set(t.id, b);
    return b;
  }),
]));

// Stage + panels
const center = h('main', { class: 'center' });
const stageRow = h('div', { class: 'stage-row' });
center.appendChild(stageRow);
const uvHost = h('div', { class: 'uv-host' });
const uvSplit = h('div', { class: 'uv-split', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize. Double-click to reset.' });
const stageHost = h('div', { class: 'stage-host' });
stageRow.append(uvHost, uvSplit, stageHost);

const vp = new Viewports(stageHost);
app.vp = vp;

const uvEditor = new UVEditor();
uvHost.appendChild(uvEditor.el);

const timeline = new Timeline();
app.timeline = timeline;
const tlResize = h('div', { class: 'tl-resize', title: 'Drag to resize' });
center.append(tlResize, timeline.el);

const dock = buildDock();
const dockResize = h('div', { class: 'dock-resize', title: 'Drag to resize' });

const mainRow = h('div', { class: 'main' }, rail, center, dockResize, dock);

const statsEl = h('span', { class: 'status-stats' });
const historyEl = h('span', { class: 'status-hist' });
const statusbar = h('footer', { class: 'statusbar' }, statusText, h('span', { class: 'tl-grow' }), titleName, historyEl, statsEl);

root.append(titlebar, mainRow, statusbar);

const lastOpHost = h('div', { class: 'lastop-host' });
stageHost.appendChild(lastOpHost);

// Welcome overlay: shown once, when the app starts on an empty scene. Anything you do closes it for the session.
const welcome = h('div', { class: 'welcome' });
stageHost.appendChild(welcome);
let welcomeOpen = true;
function closeWelcome() {
  if (!welcomeOpen) return;
  welcomeOpen = false;
  welcome.style.display = 'none';
}
// A click in the views, or Esc, means you'd rather get on with it.
stageHost.addEventListener('pointerdown', (e) => { if (!(e.target as HTMLElement).closest('.welcome-card')) closeWelcome(); }, true);
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeWelcome(); });

function renderWelcome() {
  const empty = !ed.model.faces.length && !ed.model.verts.length && !ed.model.bones.length && !ed.model.refs?.length;
  // Once there's something in the scene, it's done its job.
  if (!empty || ed.workspace === 'block') closeWelcome();
  welcome.style.display = welcomeOpen ? 'flex' : 'none';
  if (!welcomeOpen) return;
  const recents = recentFiles();
  renderInto(welcome, () => h('div', { class: 'welcome-card' },
    h('img', { src: './icon.png', width: 64, height: 64, alt: '' }),
    h('h1', null, 'ThickShake'),
    h('p', { class: 'muted' }, 'Model, unwrap, rig, animate and ship game assets.'),
    h('div', { class: 'welcome-actions' },
      button('Blank', () => closeWelcome(), { class: 'btn btn-primary', title: 'Start with an empty scene' }),
      button('Start with a box', () => { closeWelcome(); runCommand('create.box'); }),
      button('Open…', () => { closeWelcome(); runCommand('file.open'); }),
      button('Demo milkshake', () => { closeWelcome(); runCommand('file.sample'); }),
    ),
    native && recents.length ? h('div', { class: 'recents' }, h('h4', null, 'Recent'), recents.slice(0, 5).map((p) => h('button', {
      class: 'recent-item', title: p,
      onclick: async () => {
        const f = await native!.readFile(p);
        if (!f) { toast('That file is no longer there.', 'warn'); return; }
        await loadOpened(f.name, f.path, f.data).catch((e) => reportError('Open failed', e));
      },
    }, p.split(/[\\/]/).pop()))) : null,
    h('p', { class: 'muted small' }, 'Drop a .glb, .fbx, .obj, .ms3d or .tshake anywhere on this window. Ctrl+K finds any command.'),
  ));
}

// ---------- options bar ----------
function renderOptions() {
  // The last operation's settings float over the view, so they never push the top bar onto a second row.
  renderInto(lastOpHost, () => lastOpPanel());
  renderInto(options, () => {
    const seg = (items: [string, string, () => boolean, () => void, string?][]) => h('div', { class: 'seg' }, items.map(([, label, on, run, title]) =>
      h('button', { class: `seg-btn${on() ? ' active' : ''}`, onclick: run, title, 'aria-pressed': String(on()) }, label)));
    const toggle = (label: string, id: string, title: string) => {
      const on = commands.get(id)?.checked?.() ?? false;
      return h('button', { class: `opt-toggle${on ? ' active' : ''}`, 'aria-pressed': String(on), title, onclick: () => runCommand(id) }, label);
    };
    const t = ed.tool;
    const toolOpts: (HTMLElement | null)[] = [];
    if (t === 'part') toolOpts.push(numField({ label: 'Thickness', value: ed.partThickness, min: 0.1, max: 4, step: 0.01, digits: 2, onChange: (v) => { ed.partThickness = v; } }));
    if (t === 'stroke') {
      toolOpts.push(numField({ label: 'Radius', value: ed.strokeRadius, min: 0.002, max: 100, step: 0.005, digits: 3, title: 'In metres. Ctrl+wheel or [ and ] change it.', onChange: (v) => { ed.strokeRadius = v; } }));
      toolOpts.push(numField({ label: 'Taper', value: ed.strokeTaper, min: 0, max: 1, step: 0.01, digits: 2, title: 'Narrow toward the far end', onChange: (v) => { ed.strokeTaper = v; } }));
    }
    if (t === 'blob') toolOpts.push(numField({ label: 'Depth', value: ed.blobDepth, min: 0.05, max: 3, step: 0.01, digits: 2, title: 'Depth as a share of width', onChange: (v) => { ed.blobDepth = v; } }));
    if (t === 'sculpt') {
      toolOpts.push(seg([
        ['grab', 'Grab', () => ed.sculpt.mode === 'grab', () => runCommand('sculpt.grab'), commands.get('sculpt.grab')?.hint],
        ['inflate', 'Inflate', () => ed.sculpt.mode === 'inflate', () => runCommand('sculpt.inflate'), commands.get('sculpt.inflate')?.hint],
        ['smooth', 'Smooth', () => ed.sculpt.mode === 'smooth', () => runCommand('sculpt.smooth'), commands.get('sculpt.smooth')?.hint],
        ['flatten', 'Flatten', () => ed.sculpt.mode === 'flatten', () => runCommand('sculpt.flatten'), commands.get('sculpt.flatten')?.hint],
        ['pinch', 'Pinch', () => ed.sculpt.mode === 'pinch', () => runCommand('sculpt.pinch'), commands.get('sculpt.pinch')?.hint],
      ]));
      toolOpts.push(numField({ label: 'Size', value: ed.sculpt.radius, min: 4, max: 400, step: 1, digits: 0, title: 'Ctrl+wheel or [ and ] change it.', onChange: (v) => { ed.sculpt.radius = v; ed.emit('view'); } }));
    }
    if (['sphere', 'cylinder', 'cone', 'torus', 'capsule', 'tapered', 'limb'].includes(t)) {
      toolOpts.push(numField({ label: 'Sides', title: 'Segments around the shape', value: ed.primSegments, min: 3, max: 128, step: 1, digits: 0, onChange: (v) => { ed.primSegments = v; app.vp.refreshPrim(); } }));
    }
    if (t === 'sphere' || t === 'torus' || t === 'capsule') toolOpts.push(numField({ label: 'Rings', value: ed.primRings, min: 3, max: 96, step: 1, digits: 0, onChange: (v) => { ed.primRings = v; app.vp.refreshPrim(); } }));
    if (t === 'geosphere' || t === 'plane') toolOpts.push(numField({ label: t === 'plane' ? 'Divisions' : 'Detail', value: ed.primSubdiv, min: t === 'plane' ? 1 : 0, max: t === 'plane' ? 64 : 5, step: 1, digits: 0, onChange: (v) => { ed.primSubdiv = v; app.vp.refreshPrim(); } }));
    if (t === 'limb') toolOpts.push(numField({ label: 'Thickness', value: ed.limbThickness, min: 0.05, max: 2, step: 0.01, digits: 2, title: 'Width as a share of length', onChange: (v) => { ed.limbThickness = v; } }));
    if (t === 'stairs') toolOpts.push(numField({ label: 'Steps', value: ed.primSteps, min: 1, max: 64, step: 1, digits: 0, onChange: (v) => { ed.primSteps = v; app.vp.refreshPrim(); } }));
    if (t === 'ik') {
      toolOpts.push(numField({ label: 'Joints', value: ed.ikChain, min: 1, max: 12, step: 1, digits: 0, title: 'How many joints above the dragged one may bend', onChange: (v) => { ed.ikChain = v; } }));
      toolOpts.push(toggle('Hold', 'anim.ikHold', 'Keep the dragged joint\'s rotation, so a foot stays flat as the leg moves'));
    }
    if (t === 'paint') {
      toolOpts.push(numField({ label: 'Radius', value: ed.brush.radius, min: 4, max: 300, step: 1, digits: 0, onChange: (v) => { ed.brush.radius = v; ed.emit('view'); } }));
      toolOpts.push(numField({ label: 'Strength', value: ed.brush.strength, min: 0.01, max: 1, step: 0.01, digits: 2, onChange: (v) => { ed.brush.strength = v; } }));
    }
    return [
      seg([
        ['vertex', 'Vertex', () => ed.mode === 'vertex', () => runCommand('mode.vertex'), 'Select vertices (1)'],
        ['edge', 'Edge', () => ed.mode === 'edge', () => runCommand('mode.edge'), 'Select edges (2)'],
        ['face', 'Face', () => ed.mode === 'face', () => runCommand('mode.face'), 'Select faces (3)'],
        ['group', 'Group', () => ed.mode === 'group', () => runCommand('mode.group'), 'Select whole groups (4)'],
        ['bone', 'Joint', () => ed.mode === 'bone', () => runCommand('mode.bone'), 'Select joints (5)'],
      ]),
      h('span', { class: 'tl-sep' }),
      toggle('Snap', 'view.snap', 'Snap to grid (Shift+S). Ctrl inverts during a drag.'),
      ed.snap ? numField({ value: ed.snapStep, min: 0.001, max: 100, step: 0.01, digits: 3, title: 'Grid step in metres', onChange: (v) => { ed.snapStep = v; } }) : null,
      toggle('Mirror X', 'view.mirrorX', 'Mirror edits across the X axis (Shift+X)'),
      toggle('X-Ray', 'view.xray', 'See and select through surfaces (Alt+X)'),
      toolOpts.length ? h('span', { class: 'tl-sep' }) : null,
      toolOpts,
      h('span', { class: 'tl-grow' }),
      h('button', { class: 'palette-hint', onclick: () => runCommand('help.palette'), title: 'Search all commands (Ctrl+K)', 'aria-label': 'Search all commands' }, svgIcon(ICONS.zoom, 15)),
      button('Export', () => runCommand('file.export'), { class: 'btn btn-primary btn-small', title: 'Export for your game engine (Ctrl+E)' }),
    ];
  });
}

/** Live parameters of the last operation; changing one re-runs it from the same starting point. */
function lastOpPanel(): HTMLElement | null {
  const op = ed.lastOp;
  if (!op) return null;
  return h('div', { class: 'lastop', 'aria-label': `Adjust ${op.label}` },
    h('span', { class: 'lastop-title' }, op.label),
    op.params.map((p) => {
      if (p.type === 'bool') {
        return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: p.value, onchange: (e: Event) => ed.adjustLastOp(p.key, (e.target as HTMLInputElement).checked) }), h('span', null, p.label));
      }
      if (p.type === 'choice') {
        return h('label', { class: 'check' }, h('span', null, p.label), h('select', { class: 'field-select', onchange: (e: Event) => ed.adjustLastOp(p.key, +(e.target as HTMLSelectElement).value) },
          p.options!.map(([v, l]) => h('option', { value: String(v), selected: v === p.value }, l))));
      }
      const digits = p.step! >= 1 ? 0 : p.step! >= 0.01 ? 2 : 3;
      return numField({ label: p.label, value: p.value, min: p.min, max: p.max, step: p.step, digits, onChange: (v) => ed.adjustLastOp(p.key, v) });
    }));
}

function syncTools() {
  toolButtons.forEach((b, id) => {
    const on = id === ed.tool;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
  primitivesBtn.classList.toggle('active', PRIMITIVES.includes(ed.tool));
  wsTabs.querySelectorAll('button').forEach((b) => {
    const on = (b as HTMLElement).dataset.ws === ed.workspace;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
}

let optionsScheduled = false;
const scheduleOptions = () => {
  if (optionsScheduled) return;
  optionsScheduled = true;
  requestAnimationFrame(() => { optionsScheduled = false; renderOptions(); syncTools(); });
};

function renderStatus() {
  const s = modelStats();
  // Frames are only drawn when something changes, so FPS only means something during playback.
  const fps = ed.playing ? ` · ${Math.round(vp.fps)} fps` : '';
  statsEl.textContent = `${s.tris.toLocaleString()} tris · ${s.verts.toLocaleString()} verts · ${s.groups} groups · ${s.bones} joints${fps}`;
  historyEl.textContent = ed.canUndo ? `Undo: ${ed.undoLabel}` : '';
}

function updateTitle() {
  titleName.replaceChildren(...(ed.dirty ? [svgIcon(ICONS.dot, 10)] : []), ed.fileName);
  // A window title can only hold text.
  document.title = `${ed.dirty ? '*' : ''}${ed.fileName} - ThickShake`;
  native?.setTitle(document.title);
}

// ---------- workspaces ----------
let timelineVisible = false;
function applyTimeline() {
  timeline.el.style.display = timelineVisible ? 'flex' : 'none';
  tlResize.style.display = timelineVisible ? 'block' : 'none';
  timeline.draw();
}
app.toggleTimeline = () => { timelineVisible = !timelineVisible; applyTimeline(); };

/** What Blockout changes on the way in, so it can all go back on the way out. */
let beforeBlock: { surface: boolean; mirror: boolean; wire: boolean; shading: Shading[] } | null = null;

function setWorkspace(w: Workspace) {
  if (ed.workspace === 'animate' && w !== 'animate') { ed.tool = 'select'; ed.showWire = true; }
  if (ed.testPose && w !== 'rig') { ed.setTestPose(false); ed.tool = 'select'; }
  if (beforeBlock && w !== 'block') {
    ed.drawOnSurface = beforeBlock.surface;
    ed.mirrorX = beforeBlock.mirror;
    ed.showWire = beforeBlock.wire;
    vp.panes.forEach((p, i) => { p.shading = beforeBlock!.shading[i]; });
    beforeBlock = null;
    if (ed.mode === 'group') ed.setMode('face');
    ed.tool = 'select';
  }
  ed.workspace = w;
  const persp = vp.panes[1];
  ed.playing = false;
  stageRow.classList.toggle('with-uv', w === 'uv');
  switch (w) {
    case 'block':
      if (!beforeBlock) beforeBlock = { surface: ed.drawOnSurface, mirror: ed.mirrorX, wire: ed.showWire, shading: vp.panes.map((p) => p.shading) };
      ed.pose = false;
      ed.showWire = false; // Forms read better without the mesh lines. Alt+W brings them back.
      // Bodies are built outward and symmetrically, so those start on. Snapping and detail stay your choice.
      ed.drawOnSurface = true;
      ed.mirrorX = true;
      if (!ed.model.faces.length) ed.tool = 'limb';
      vp.setLayout('quad');
      vp.panes.forEach((p) => { p.shading = 'block'; });
      timelineVisible = false;
      app.showTab('block');
      ed.setMode('group');
      break;
    case 'model':
      ed.pose = false;
      vp.setLayout('quad');
      timelineVisible = false;
      persp.shading = 'pbr';
      app.showTab('scene');
      if (ed.mode === 'bone') ed.setMode('face');
      break;
    case 'uv':
      ed.pose = false;
      vp.setLayout('single', persp);
      persp.shading = 'checker';
      timelineVisible = false;
      app.showTab('material');
      if (ed.mode === 'bone') ed.setMode('face');
      break;
    case 'rig':
      ed.pose = false;
      vp.setLayout('single', persp);
      persp.shading = 'clay';
      timelineVisible = false;
      app.showTab('rig');
      ed.setMode('bone');
      ed.xray = false;
      break;
    case 'animate':
      ed.pose = true;
      vp.setLayout('single', persp);
      persp.shading = 'pbr';
      timelineVisible = true;
      app.showTab('rig');
      ed.setMode('bone');
      ed.tool = 'rotate';
      ed.showWire = false; // Judge motion on the clean surface.
      break;
  }
  vp.syncHeaders();
  applyTimeline();
  ed.invalidatePose();
  ed.emit('anim', 'geometry', 'tool', 'selection', 'time');
  uvEditor.draw();
}
app.setWorkspace = setWorkspace;

// ---------- resizers ----------
// Panel sizes are remembered between runs. A viewer's browser may refuse storage, which only loses that memory.
const LAYOUT_KEY = 'thickshake.layout';
const layout: Record<string, string> = (() => {
  try { return JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}'); } catch { return {}; }
})();
function setLayoutVar(name: string, value: string | null) {
  if (value === null) { document.documentElement.style.removeProperty(name); delete layout[name]; }
  else { document.documentElement.style.setProperty(name, value); layout[name] = value; }
}
for (const [k, v] of Object.entries(layout)) document.documentElement.style.setProperty(k, v);
const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* best effort */ } };

function bindResizer(el: HTMLElement, onMove: (e: PointerEvent) => void, reset: string) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.classList.add('dragging');
    document.body.classList.add('resizing');
    const up = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      el.classList.remove('dragging');
      document.body.classList.remove('resizing');
      saveLayout();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });
  el.addEventListener('dblclick', () => { setLayoutVar(reset, null); saveLayout(); });
}
bindResizer(dockResize, (e) => {
  const w = Math.max(200, Math.min(window.innerWidth * 0.6, window.innerWidth - e.clientX));
  setLayoutVar('--dock-w', `${Math.round(w)}px`);
}, '--dock-w');
bindResizer(tlResize, (e) => {
  const r = center.getBoundingClientRect();
  const hh = Math.max(90, Math.min(r.height - 120, r.bottom - e.clientY));
  setLayoutVar('--tl-h', `${Math.round(hh)}px`);
}, '--tl-h');
bindResizer(uvSplit, (e) => {
  const r = stageRow.getBoundingClientRect();
  const w = Math.max(240, Math.min(r.width - 200, e.clientX - r.left));
  setLayoutVar('--uv-w', `${((w / r.width) * 100).toFixed(2)}%`);
}, '--uv-w');

// ---------- events ----------
ed.on(['tool', 'history', 'selection', 'view', 'topology'], scheduleOptions);
ed.on(['history', 'topology', 'selection', 'file'], () => { renderWelcome(); renderStatus(); });
ed.on(['file', 'history'], updateTitle);
vp.onFrame = (dt) => timeline.tick(dt);
setInterval(renderStatus, 1000);

// Autosave every 45 seconds while there are unsaved changes.
let lastSavedDepth = -1;
setInterval(() => {
  if (!ed.dirty || ed.historyDepth === lastSavedDepth) return;
  lastSavedDepth = ed.historyDepth;
  void autosave.write(serializeProject(ed.model));
}, 45000);

// Paste an image from the clipboard: into the active material, or behind the Front view while blocking out.
window.addEventListener('paste', async (e) => {
  const target = e.target as HTMLElement | null;
  if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;
  const file = [...(e.clipboardData?.files ?? [])].find((x) => x.type.startsWith('image/'));
  if (!file) return;
  e.preventDefault();
  try {
    const name = file.name && file.name !== 'image.png' ? file.name : 'Pasted image.png';
    const data = await file.arrayBuffer();
    if (ed.workspace === 'block' && panelState.tab !== 'material') await addReference(name, data, 'front');
    else await importImageFiles([{ name, data }]);
  } catch (err) { reportError('Could not paste that image', err); }
});

// Drag and drop
window.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  document.body.classList.remove('dropping');
  const all = [...(e.dataTransfer?.files ?? [])];
  const f = all[0];
  if (!f) return;
  try {
    const images = all.filter((x) => isImageFile(x.name));
    if (images.length) {
      const files = await Promise.all(images.map(async (x) => ({ name: x.name, data: await x.arrayBuffer() })));
      const target = e.target as HTMLElement | null;
      // Over a map slot, it goes in that slot. Anywhere on the Material panel, it sorts itself by file name.
      const slot = target?.closest?.('[data-map-slot]')?.getAttribute('data-map-slot') as MapSlot | null | undefined;
      if (slot || (target?.closest?.('.dock') && panelState.tab === 'material')) {
        await importImageFiles(files, slot ?? undefined);
        return;
      }
      const r = vp.el.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const pane = vp.visiblePanes().find((p) => p.contains(x, y));
      // Dropped on a piece, outside Blockout, it textures that piece.
      const piece = pane && ed.workspace !== 'block' ? vp.pieceAt(pane, x, y) : null;
      if (piece !== null) {
        const uses = ed.model.groups.find((g) => g.id === piece)?.material ?? null;
        if (uses !== null) { ed.activeMaterial = uses; await importImageFiles(files); }
        else await importImageFiles(files, undefined, [piece]);
        return;
      }
      // Otherwise it's a picture to model over, behind the view it was dropped on.
      // A perspective view has no fixed side, so it uses Front.
      for (const file of files) await addReference(file.name, file.data, pane && pane.kind !== 'persp' ? pane.kind : 'front');
      return;
    }
    const data = await f.arrayBuffer();
    if (!ed.model.faces.length) await loadOpened(f.name, null, data);
    else await mergeOpened(f.name, data);
  } catch (err) { reportError(`Could not import ${f.name}`, err); }
});

// Window close (desktop)
native?.onRequestClose(async () => {
  if (await confirmDiscard()) {
    await autosave.clear();
    void native!.confirmClose();
  }
});
if (!native) window.addEventListener('beforeunload', (e) => { if (ed.dirty) e.preventDefault(); });

bindShortcuts();

// Dev/test hook. Viewports need a real browser, so end-to-end checks drive the app through this.
(window as any).__thickshake = { ed, vp, commands, emptyModel, addReference, serializeProject, parseProject, panels: { makeNormalFromBase, flipNormalGreen, packOrmImage, halveTextures, importImageFiles, makePaletteFromPixels, refreshDock, panelState, colorStore }, runCommand, setWorkspace, timeline, uvEditor, importFile, exportGLB, exportMS3D, exportOBJ, defaultExport };

// Boot
renderOptions();
syncTools();
renderWelcome();
renderStatus();
updateTitle();
applyTimeline();
vp.frameSelected(true);

// Offer crash recovery.
autosave.read().then(async (text) => {
  if (!text) return;
  const ok = await modal('Recover unsaved work?', 'ThickShake found an autosave from a previous session that didn’t close cleanly.', [
    { label: 'Discard', value: false, danger: true },
    { label: 'Recover', primary: true, value: true },
  ]);
  if (ok) {
    try {
      ed.loadModel(parseProject(text), null, 'Recovered');
      ed.dirty = true;
      ed.emit('file');
      vp.frameSelected(true);
    } catch (e) { reportError('Recovery failed', e); }
  } else await autosave.clear();
}).catch(() => {});
