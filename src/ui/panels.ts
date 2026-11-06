// The right-hand dock: Scene, Material, Rig and Audit tabs.
import { BLOCK_COLORS, blockColorOf } from '../core/blockout';
import { PARTS } from '../core/organic';
import { BUDGETS, runChecks, triangleCount } from '../core/checks';
import { ed } from '../core/editor';
import { bounds } from '../core/geom';
import { groupFaces, pruneEmptyGroups, removeLoose } from '../core/ops';
import { applyPreset, bakeModelGradient, bakeTextureGradient, blankOrm, evenStops, flipGreen, GRADIENT_PRESETS, gradientCss, guessMapKind, MATERIAL_PRESETS, newGradient, normalFromHeight, packChannel, paletteFromImage, parsePaletteText, reverseStops, type MaterialLook, type OrmChannel } from '../core/materials';
import { makeGroup, makeMaterial, newId, uniqueName, type Gradient, type MapSlot, type Material, type Model, type V2, type V3 } from '../core/types';
import { unwrap as unwrapUV, uvOverlaps } from '../core/uv';
import { MaterialPreview } from '../view/materialView';
import { colorButton, colorStore, type ColorCallbacks } from './colorPicker';
import { gradientBar } from './gradientEditor';
import { openFile } from '../io/platform';
import { app } from './app';
import { paintWeight, weightIssues } from '../core/skeleton';
import { commands, runCommand, TOOLS } from './commands';
import { button, checkbox, h, ICONS, numField, renderInto, section, select, svgIcon } from './dom';
import { toast } from './feedback';

let budgetId = 'indie';
export const panelState = { tab: 'scene' };

const eyeOn = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const eyeOff = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M3 3l18 18M10 5.3A10 10 0 0 1 12 5c6 0 10 7 10 7a17 17 0 0 1-3.3 4M6.5 6.7A17 17 0 0 0 2 12s4 7 10 7a10 10 0 0 0 4-.8"/></svg>';
const lockOn = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
const lockOff = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" opacity=".4" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>';

const cmd = (id: string, label: string, title?: string) => button(label, () => runCommand(id), { title });

// ---------- selection inspector ----------
function inspector() {
  const m = ed.model;
  if (ed.mode === 'bone') {
    const b = m.bones.find((x) => x.id === ed.activeBone);
    if (!b) return section('Selection', h('p', { class: 'muted' }, 'No joint selected.'));
    return section('Joint', h('div', { class: 'xyz' }, ([0, 1, 2] as const).map((i) => numField({
      label: 'XYZ'[i], axis: i, value: b.head[i], step: 0.01,
      onScrubStart: () => ed.begin('Move joint'),
      onInput: (v) => { const t = m.bones.find((x) => x.id === b.id); if (t) { t.head[i] = v; ed.emit('skeleton', 'geometry'); } },
      onScrubEnd: () => ed.commit(),
      onChange: () => {},
    }))));
  }
  const vs = ed.selectedVertexSet();
  if (!vs.size) return section('Selection', h('p', { class: 'muted' }, 'Nothing selected.'));
  const pts = [...vs].map((i) => m.verts[i].p);
  const box = bounds(pts);
  let base: Map<number, V3> | null = null;
  const capture = () => { base = new Map([...vs].map((i) => [i, [...m.verts[i].p] as V3])); };
  const setCenter = (axis: number, v: number) => {
    if (!base) capture();
    const delta = v - box.center[axis];
    base!.forEach((o, i) => { const p = [...o] as V3; p[axis] += delta; ed.model.verts[i].p = p; });
    ed.emit('geometry');
  };
  const setSize = (axis: number, v: number) => {
    if (!base) capture();
    const old = box.size[axis];
    if (old < 1e-6 || v <= 0) return;
    const k = v / old, c = box.center[axis];
    base!.forEach((o, i) => { const p = [...o] as V3; p[axis] = c + (p[axis] - c) * k; ed.model.verts[i].p = p; });
    ed.emit('geometry');
  };
  const field = (i: 0 | 1 | 2, val: number, fn: (a: number, v: number) => void, label: string) => numField({
    label, axis: i, value: val, step: 0.01,
    onScrubStart: () => { ed.begin('Edit transform'); capture(); },
    onInput: (v) => fn(i, v),
    onScrubEnd: () => { ed.commit(); base = null; ed.emitAll(); },
    onChange: (v) => { ed.begin('Edit transform'); capture(); fn(i, v); ed.commit(); base = null; ed.emitAll(); },
  });
  return section('Selection',
    h('div', { class: 'readout' }, `${vs.size.toLocaleString()} vertices`),
    h('div', { class: 'field-label' }, 'Centre'),
    h('div', { class: 'xyz' }, ([0, 1, 2] as const).map((i) => field(i, box.center[i], setCenter, 'XYZ'[i]))),
    h('div', { class: 'field-label' }, 'Size'),
    h('div', { class: 'xyz' }, ([0, 1, 2] as const).map((i) => field(i, box.size[i], setSize, 'XYZ'[i]))),
  );
}

// ---------- scene ----------
function renamable(text: string, onDone: (v: string) => void) {
  const span = h('span', { class: 'row-name', title: 'Double-click to rename' }, text);
  span.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    const input = h('input', { class: 'rename', value: text }) as HTMLInputElement;
    const done = (commit: boolean) => {
      if (input.dataset.done) return;
      input.dataset.done = '1';
      const v = input.value.trim();
      input.blur();
      if (commit && v && v !== text) onDone(v); else ed.emit('groups', 'materials', 'skeleton', 'anim');
    };
    input.addEventListener('blur', () => done(true));
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') done(true);
      if (ev.key === 'Escape') done(false);
    });
    span.replaceWith(input);
    input.focus();
    input.select();
  });
  return span;
}

function groupRows() {
  const m = ed.model;
  return m.groups.map((g) => {
    const faces = groupFaces(m, g.id);
    const tris = faces.reduce((s, i) => s + Math.max(0, m.faces[i].v.length - 2), 0);
    const mat = m.materials.find((x) => x.id === g.material);
    const tag = g.kind === 'lod' ? 'LOD' : g.kind === 'collision' ? 'COL' : null;
    return h('div', {
      class: `row${ed.activeGroup === g.id ? ' active' : ''}`,
      onclick: (e: MouseEvent) => {
        ed.activeGroup = g.id;
        if (g.visible && !g.locked && ed.mode !== 'bone' && ed.mode !== 'vertex' && ed.mode !== 'edge') {
          if (!e.shiftKey) ed.selFaces.clear();
          faces.forEach((f) => ed.selFaces.add(f));
        }
        ed.emit('selection', 'groups');
      },
    },
      h('button', { class: 'row-icon', 'aria-label': g.visible ? 'Hide group' : 'Show group', title: g.visible ? 'Hide' : 'Show', html: g.visible ? eyeOn : eyeOff, onclick: (e: Event) => {
        e.stopPropagation();
        ed.transact(g.visible ? 'Hide group' : 'Show group', (d) => { const t = d.groups.find((x) => x.id === g.id)!; t.visible = !t.visible; });
      } }),
      h('button', { class: 'row-icon', 'aria-label': g.locked ? 'Unlock group' : 'Lock group', title: g.locked ? 'Unlock' : 'Lock (stops selection)', html: g.locked ? lockOn : lockOff, onclick: (e: Event) => {
        e.stopPropagation();
        ed.transact(g.locked ? 'Unlock group' : 'Lock group', (d) => { const t = d.groups.find((x) => x.id === g.id)!; t.locked = !t.locked; });
      } }),
      ed.workspace === 'block'
        ? h('span', { class: 'swatch', style: { background: blockColorOf(g) }, title: 'Blockout colour' })
        : h('span', { class: 'swatch', style: { background: mat?.color ?? 'transparent' }, title: mat?.name ?? 'No material' }),
      renamable(g.name, (v) => ed.transact('Rename group', (d) => { d.groups.find((x) => x.id === g.id)!.name = uniqueName(d.groups.filter((x) => x.id !== g.id).map((x) => x.name), v); })),
      tag ? h('span', { class: 'tag' }, tag) : null,
      h('span', { class: 'row-meta' }, tris.toLocaleString()),
    );
  });
}

// ---------- blockout ----------
const BLOCK_SHAPES = ['limb', 'stroke', 'blob', 'lathe', 'sphere', 'capsule', 'tapered', 'box', 'cylinder', 'cone', 'torus'];

/** Rough out a character quickly, or anything else, from simple pieces. Every other shape is in the Create menu. */
function blockPanel() {
  const m = ed.model;
  const selected = new Set<number>();
  ed.selectedFaceSet().forEach((f) => selected.add(m.faces[f].g));
  const shapes = BLOCK_SHAPES.map((id) => {
    const t = TOOLS.find((x) => x.id === id)!;
    return h('button', {
      class: `shape-btn${ed.tool === id ? ' active' : ''}`, title: t.hint, 'aria-pressed': String(ed.tool === id),
      onclick: () => runCommand(`tool.${id}`),
    }, svgIcon(t.icon, 22), h('span', null, t.label));
  });
  const setColor = (c: string) => ed.transact('Set colour', (d) => {
    for (const g of d.groups) if (selected.has(g.id)) g.color = c;
  });
  const cur = selected.size === 1 ? m.groups.find((g) => selected.has(g.id)) : undefined;
  const hint = (id: string) => commands.get(id)?.hint;
  const steps: [number, string][] = [[0.01, '0.01 m'], [0.05, '0.05 m'], [0.1, '0.1 m'], [0.25, '0.25 m'], [0.5, '0.5 m'], [1, '1 m']];
  if (!steps.some((s) => s[0] === ed.snapStep)) steps.push([ed.snapStep, `${ed.snapStep} m`]);
  return [
    section('Start from',
      h('div', { class: 'btn-row' }, cmd('block.start.character', 'Character', hint('block.start.character')), cmd('block.start.chibi', 'Chibi', hint('block.start.chibi')), cmd('block.start.creature', 'Creature', hint('block.start.creature'))),
      h('p', { class: 'muted small' }, 'Or draw your own below. Any model works: the Create menu has every shape.'),
    ),
    referenceSection(),
    section('Draw body parts',
      h('div', { class: 'shape-grid' }, Object.entries(PARTS).map(([kind, def]) => h('button', {
        class: `shape-btn${ed.tool === 'part' && ed.partKind === kind ? ' active' : ''}`, title: def.hint,
        'aria-pressed': String(ed.tool === 'part' && ed.partKind === kind), onclick: () => runCommand(`part.${kind}`),
      }, svgIcon(def.icon, 22), h('span', null, def.label)))),
      h('p', { class: 'muted small' }, ed.tool === 'part' ? PARTS[ed.partKind].hint : 'Pick a part, then drag where it goes. Start on a piece to attach it.'),
    ),
    section('Draw any shape',
      h('div', { class: 'shape-grid' }, shapes),
      h('p', { class: 'muted small' }, ed.tool === 'limb' ? 'Drag from one end of the limb to the other.'
        : ed.tool === 'stroke' ? 'Draw a line and it becomes a tube. [ and ] change its thickness.'
          : ed.tool === 'blob' ? 'Draw around an outline and it inflates into a rounded solid.'
            : ed.tool === 'lathe' ? 'Draw half an outline, top to bottom, and it spins around the centre line.'
            : 'Drag out the shape in a view, then in another view for depth.'),
      checkbox('Symmetry across X', ed.mirrorX, () => runCommand('view.mirrorX')),
      checkbox('Build on surfaces', ed.drawOnSurface, () => runCommand('create.onSurface')),
    ),
    section('Detail',
      h('div', { class: 'seg block-seg' },
        ([['low', 'Low poly'], ['medium', 'Medium'], ['high', 'High']] as const).map(([id, label]) => {
          const on = commands.get(`block.detail.${id}`)?.checked?.() ?? false;
          return h('button', { class: `seg-btn${on ? ' active' : ''}`, 'aria-pressed': String(on), title: hint(`block.detail.${id}`), onclick: () => runCommand(`block.detail.${id}`) }, label);
        })),
      h('p', { class: 'muted small' }, 'Applies to new pieces. Arrow keys fine-tune a piece as you draw it.'),
    ),
    section('Shape it',
      h('div', { class: 'seg block-seg' },
        ([['grab', 'Grab'], ['inflate', 'Inflate'], ['smooth', 'Smooth'], ['flatten', 'Flatten'], ['pinch', 'Pinch']] as const).map(([id, label]) => {
          const on = ed.tool === 'sculpt' && ed.sculpt.mode === id;
          return h('button', { class: `seg-btn${on ? ' active' : ''}`, 'aria-pressed': String(on), title: hint(`sculpt.${id}`), onclick: () => runCommand(`sculpt.${id}`) }, label);
        })),
      h('p', { class: 'muted small' }, 'Sculpt with a soft brush. [ and ] resize it. Symmetry applies.'),
      h('div', { class: 'btn-row' }, cmd('block.taper', 'Taper', hint('block.taper')), cmd('block.bend', 'Bend', hint('block.bend')), cmd('block.twist', 'Twist', hint('block.twist'))),
      h('div', { class: 'btn-row' }, cmd('block.fuse', 'Fuse pieces', hint('block.fuse')), cmd('block.round', 'Round off', hint('block.round')), cmd('block.reduce', 'Lower poly', hint('block.reduce'))),
      h('div', { class: 'btn-row' }, cmd('mesh.smoothShade', 'Shade smooth'), cmd('mesh.flatShade', 'Shade flat')),
    ),
    selected.size ? inspector() : null,
    selected.size ? section('Colour',
      h('div', { class: 'block-colors' },
        BLOCK_COLORS.map((c) => h('button', { class: `color-chip${cur && blockColorOf(cur) === c ? ' active' : ''}`, style: { background: c }, 'aria-label': `Colour ${c}`, title: c, onclick: () => setColor(c) })),
        colorButton(cur ? blockColorOf(cur) : BLOCK_COLORS[0], 'Any colour', { onInput: () => {}, onCommit: setColor, onCancel: () => {} }),
      ),
    ) : null,
    section('Arrange',
      h('div', { class: 'btn-row' }, cmd('block.duplicate', 'Duplicate', hint('block.duplicate')), cmd('block.mirror', 'Mirror', hint('block.mirror')), cmd('block.array', 'Array', hint('block.array'))),
      h('div', { class: 'btn-row' }, cmd('block.radial', 'Radial', hint('block.radial')), cmd('block.center', 'Centre', hint('block.center')), cmd('block.isolate', commands.get('block.isolate')?.checked?.() ? 'Show all' : 'Isolate', hint('block.isolate'))),
      h('div', { class: 'btn-row' }, cmd('mesh.mergeGroups', 'Join', 'Combine the selected pieces into one, without melting them'), cmd('edit.delete', 'Delete')),
      h('div', { class: 'btn-row' }, cmd('block.alignXCentre', 'Align X', 'Line up centres with the active piece'), cmd('block.alignYCentre', 'Align Y', 'Line up centres with the active piece'), cmd('block.alignZCentre', 'Align Z', 'Line up centres with the active piece')),
    ),
    section('Pieces',
      m.groups.length ? h('div', { class: 'list' }, groupRows()) : h('p', { class: 'muted' }, 'Draw a shape to start.'),
    ),
    section('Precision',
      checkbox('Snap to grid', ed.snap, () => runCommand('view.snap')),
      h('label', { class: 'form-row' }, 'Step', select<number>(ed.snapStep, steps, (v) => { ed.snapStep = v; ed.emit('view', 'tool'); })),
      h('div', { class: 'btn-row' }, cmd('block.snap', 'Snap selection', hint('block.snap')), cmd('block.drop', 'Drop down', hint('block.drop'))),
      checkbox('Show measurements', ed.blockDims, () => runCommand('block.dims')),
      checkbox('Show size reference', ed.figure.show, () => runCommand('block.figure')),
      ed.figure.show ? numField({ label: 'Height', value: ed.figure.height, min: 0.01, max: 1000, step: 0.01, digits: 2, title: 'In metres', onChange: (v) => { ed.figure.height = v; app.vp.invalidate(); } }) : null,
      ed.figure.show ? h('div', { class: 'btn-row' }, cmd('block.placeFigure', 'Move beside selection', hint('block.placeFigure'))) : null,
    ),
    section('Finish',
      h('div', { class: 'btn-row' }, cmd('block.colorsToMaterials', 'Colours to materials', hint('block.colorsToMaterials')), cmd('file.export', 'Export')),
      h('p', { class: 'muted small' }, 'Pieces are ordinary meshes. Refine them in Model, unwrap them in UV, or rig them as they are.'),
    ),
  ];
}

/** Pictures to model over: a drawing behind the Front view, a photo behind the Right view, and so on. */
function referenceSection() {
  const refs = ed.model.refs ?? [];
  const active = refs.find((r) => r.id === ed.refActive);
  const live = (label: string, key: 'size' | 'x' | 'y' | 'opacity', opts: { min?: number; max?: number; step: number; digits: number; title?: string }) => numField({
    label, value: active![key], ...opts,
    onScrubStart: () => ed.begin('Edit reference image'),
    onInput: (v) => { const r = ed.model.refs?.find((x) => x.id === active!.id); if (r) { r[key] = v; ed.emit('view'); } },
    onScrubEnd: () => { ed.commit(); ed.emitAll(); },
    onChange: (v) => ed.transact('Edit reference image', (d) => { const r = d.refs?.find((x) => x.id === active!.id); if (r) r[key] = v; }),
  });
  return section('Reference images',
    h('div', { class: 'btn-row' }, cmd('ref.addFront', 'Front', commands.get('ref.addFront')?.hint), cmd('ref.addRight', 'Side', commands.get('ref.addRight')?.hint), cmd('ref.addTop', 'Top', commands.get('ref.addTop')?.hint), cmd('ref.addBack', 'Back', commands.get('ref.addBack')?.hint)),
    refs.length ? h('div', { class: 'list' }, refs.map((r) => h('div', {
      class: `row${r.id === ed.refActive ? ' active' : ''}`,
      onclick: () => { ed.refActive = r.id; ed.emit('view', 'tool'); refreshDock(); },
    },
      h('button', { class: 'row-icon', 'aria-label': r.visible ? 'Hide image' : 'Show image', title: r.visible ? 'Hide' : 'Show', html: r.visible ? eyeOn : eyeOff, onclick: (e: Event) => {
        e.stopPropagation();
        ed.transact(r.visible ? 'Hide reference image' : 'Show reference image', (d) => { const t = d.refs?.find((x) => x.id === r.id); if (t) t.visible = !t.visible; });
      } }),
      h('img', { class: 'ref-thumb', src: r.url, alt: '' }),
      h('span', { class: 'row-name', title: r.name }, r.name),
      h('span', { class: 'row-meta' }, r.view),
    ))) : h('p', { class: 'muted small' }, 'Pick a view to load a picture behind it, or drop one onto a view.'),
    active ? [
      h('div', { class: 'btn-row' },
        button(ed.refEdit ? 'Done placing' : 'Move and scale', () => runCommand('ref.adjust'), { class: ed.refEdit ? 'btn btn-primary' : 'btn', title: 'Drag the picture in its view, or a corner to scale it' }),
        cmd('ref.fit', 'Fit to selection', commands.get('ref.fit')?.hint),
        cmd('ref.delete', 'Delete'),
      ),
      h('label', { class: 'form-row' }, 'View', select<string>(active.view, [['front', 'Front'], ['back', 'Back'], ['left', 'Left'], ['right', 'Right'], ['top', 'Top'], ['bottom', 'Bottom']], (v) => ed.transact('Move reference image', (d) => { const t = d.refs?.find((x) => x.id === active.id); if (t) t.view = v as typeof t.view; }))),
      live('Opacity', 'opacity', { min: 0.02, max: 1, step: 0.01, digits: 2 }),
      live('Height', 'size', { min: 0.01, max: 1000, step: 0.01, digits: 3, title: 'In metres. Set this to the real size to work at real scale.' }),
      h('div', { class: 'xyz' }, live('X', 'x', { step: 0.005, digits: 3 }), live('Y', 'y', { step: 0.005, digits: 3 })),
      checkbox('Draw over the model', active.over, (v) => ed.transact('Edit reference image', (d) => { const t = d.refs?.find((x) => x.id === active.id); if (t) t.over = v; })),
    ] : null,
    refs.length ? checkbox('See-through pieces', ed.blockGhost, () => runCommand('ref.ghost')) : null,
    refs.length ? checkbox('Show in perspective', ed.refsInPersp, () => runCommand('ref.inPersp')) : null,
  );
}

function scenePanel() {
  const rows = groupRows();
  const selFaces = ed.selectedFaceSet().size;
  return [
    inspector(),
    section('Groups',
      rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'Add a primitive to create your first group.'),
      h('div', { class: 'btn-row' },
        cmd('mesh.regroup', 'Separate'), cmd('mesh.mergeGroups', 'Merge'),
        button('Delete', () => {
          const id = ed.activeGroup;
          if (id === null) return;
          ed.transact('Delete group', (d) => {
            const set = new Set(groupFaces(d, id));
            d.faces = d.faces.filter((_, i) => !set.has(i));
            removeLoose(d);
            pruneEmptyGroups(d);
            d.groups = d.groups.filter((g) => g.id !== id);
            ed.clearSelection();
          });
        }, { disabled: ed.activeGroup === null }),
      ),
    ),
    section('Shading',
      h('div', { class: 'btn-row' }, cmd('mesh.smoothShade', 'Smooth'), cmd('mesh.flatShade', 'Flat'), cmd('mesh.autoSmooth', 'Auto')),
      h('p', { class: 'muted small' }, selFaces ? `Applies to ${selFaces} selected faces.` : 'Applies to everything visible.'),
    ),
    section('Game-ready meshes',
      h('div', { class: 'btn-row' }, cmd('mesh.generateLods', 'LODs', 'Generate simplified level-of-detail meshes'), cmd('mesh.collisionHull', 'Hull', 'Generate a convex hull collider'), cmd('mesh.collisionBox', 'Box', 'Generate a box collider')),
    ),
  ];
}

// ---------- materials ----------
let preview: MaterialPreview | null | undefined;
/** The preview needs a graphics context of its own. If one can't be had, the panel just goes without. */
function getPreview(): MaterialPreview | null {
  if (preview === undefined) {
    try {
      preview = new MaterialPreview();
      preview.onLoaded = () => { thumbs.clear(); redrawPreview(); refreshDock(); };
      ed.on(['materials', 'history'], redrawPreview);
    } catch { preview = null; }
  }
  return preview;
}
function redrawPreview() {
  const d = ed.model.materials.find((x) => x.id === ed.activeMaterial);
  if (preview && d && panelState.tab === 'material') preview.draw(d, ed.model.textures);
}

const thumbs = new Map<string, string>();
function thumbOf(d: Material): string | null {
  const p = getPreview();
  if (!p) return null;
  const key = JSON.stringify({ ...d, id: d.id, name: '' });
  let url = thumbs.get(key);
  if (!url) {
    if (thumbs.size > 300) thumbs.clear();
    url = p.thumb(d, ed.model.textures);
    thumbs.set(key, url);
    // Thumbnails share the preview's canvas, so put the big picture back.
    redrawPreview();
  }
  return url;
}

const presetThumbs = new Map<string, string>();
function presetThumb(name: string, look: MaterialLook): string | null {
  const p = getPreview();
  if (!p) return null;
  let url = presetThumbs.get(name);
  if (!url) {
    const d: Material = { id: -1, name, color: '#ffffff', alpha: 1, metallic: 0, roughness: 0.6, emissive: '#000000', emissiveStrength: 1, doubleSided: false, alphaMode: 'opaque', maps: {} };
    applyPreset(d, look);
    url = p.thumb(d, []);
    presetThumbs.set(name, url);
  }
  return url;
}

let presetsOpen = true;

function materialPanel() {
  const m = ed.model;
  const rows = m.materials.map((x) => {
    const pic = thumbOf(x);
    return h('div', {
      class: `row${ed.activeMaterial === x.id ? ' active' : ''}`,
      onclick: () => { ed.activeMaterial = x.id; ed.emit('materials'); refreshDock(); },
    },
      pic ? h('img', { class: 'mat-thumb', src: pic, alt: '' }) : h('span', { class: 'swatch big', style: { background: x.color } }),
      renamable(x.name, (v) => ed.transact('Rename material', (d) => { d.materials.find((q) => q.id === x.id)!.name = v; })),
      h('span', { class: 'row-meta' }, `${m.groups.filter((g) => g.material === x.id).length} use`),
    );
  });
  const mat = m.materials.find((x) => x.id === ed.activeMaterial);
  const update = (label: string, fn: (t: Material) => void) => {
    if (!mat) return;
    ed.transact(label, (d) => fn(d.materials.find((q) => q.id === mat.id)!));
  };
  type NumKey = 'metallic' | 'roughness' | 'alpha' | 'emissiveStrength' | 'normalScale' | 'occlusionStrength' | 'alphaCutoff' | 'clearcoat' | 'clearcoatRoughness' | 'transmission' | 'ior' | 'sheen' | 'uvRotation';
  const scrub = (label: string, key: NumKey, max: number, min = 0, fallback = 0, title?: string) => numField({
    label, value: mat![key] ?? fallback, min, max, step: 0.01, digits: 2, title,
    onScrubStart: () => ed.begin(`Edit ${label.toLowerCase()}`),
    onInput: (v) => { const t = ed.model.materials.find((q) => q.id === mat!.id)!; t[key] = v; ed.emit('materials'); },
    onScrubEnd: () => ed.commit(),
    onChange: (v) => { if ((mat![key] ?? fallback) !== v) update(`Edit ${label.toLowerCase()}`, (t) => { t[key] = v; }); },
  });
  const pair = (label: string, key: 'uvScale' | 'uvOffset', axis: 0 | 1, fallback: number, min?: number, max?: number) => numField({
    label, value: mat![key]?.[axis] ?? fallback, min, max, step: 0.01, digits: 2,
    onScrubStart: () => ed.begin('Edit tiling'),
    onInput: (v) => {
      const t = ed.model.materials.find((q) => q.id === mat!.id)!;
      const now: V2 = [t[key]?.[0] ?? fallback, t[key]?.[1] ?? fallback];
      now[axis] = v;
      t[key] = now;
      ed.emit('materials');
    },
    onScrubEnd: () => ed.commit(),
    onChange: (v) => update('Edit tiling', (t) => { const now: V2 = [t[key]?.[0] ?? fallback, t[key]?.[1] ?? fallback]; now[axis] = v; t[key] = now; }),
  });
  const color = (label: string, key: 'color' | 'emissive' | 'sheenColor', fallback = '#ffffff') => h('div', { class: 'form-row' }, label,
    colorButton(mat![key] ?? fallback, label, liveColor(label, (t, hex) => { t[key] = hex; })));
  const slot = (s: MapSlot, label: string, extra?: HTMLElement | null) => {
    const tex = m.textures.find((t) => t.id === mat!.maps[s]);
    return h('div', { class: 'map-block', 'data-map-slot': s, title: 'Drop an image here' },
      h('div', { class: 'map-slot' },
        tex ? h('img', { src: tex.url, alt: '' }) : h('div', { class: 'map-empty' }, svgIcon(ICONS.plus, 16)),
        h('div', { class: 'map-info' }, h('strong', null, label), h('span', { class: 'muted small' }, tex ? `${tex.width}×${tex.height}` : 'None')),
        button(tex ? 'Replace' : 'Load', () => loadTexture(s)),
        tex ? button('Clear', () => ed.transact(`Clear ${label}`, (d) => {
          const t = d.materials.find((q) => q.id === mat!.id)!;
          if (s === 'base' && t.gradient) dropGradient(d, t);
          else delete t.maps[s];
        })) : null,
      ),
      extra,
    );
  };
  /** Live while the picker is open, and one undo step when it closes. */
  function liveColor(label: string, set: (t: Material, hex: string) => void): ColorCallbacks {
    const id = mat!.id;
    let begun = false;
    return {
      onInput: (hex) => {
        if (!begun) { ed.begin(`Edit ${label.toLowerCase()}`); begun = true; }
        const t = ed.model.materials.find((q) => q.id === id);
        if (t) { set(t, hex); ed.emit('materials'); }
      },
      onCommit: () => { if (begun) { ed.commit(); begun = false; ed.emitAll(); } },
      onCancel: () => { if (begun) { ed.cancel(); begun = false; } },
    };
  }
  const hasOrm = mat?.maps.orm !== undefined, hasNormal = mat?.maps.normal !== undefined, hasBase = mat?.maps.base !== undefined;
  const anyMap = !!mat && Object.keys(mat.maps).length > 0;
  const unused = m.textures.filter((t) => !m.materials.some((x) => Object.values(x.maps).includes(t.id))).length;
  const p = mat ? getPreview() : null;
  if (p && mat) p.draw(mat, m.textures);
  return [
    section('Materials',
      rows.length ? h('div', { class: 'list' }, rows) : h('p', { class: 'muted' }, 'No materials yet. Pick a look below to start one.'),
      h('div', { class: 'btn-row' },
        button('New', () => ed.transact('New material', (d) => {
          const nm = makeMaterial(d, uniqueName(d.materials.map((x) => x.name), 'Material'));
          ed.activeMaterial = nm.id;
        })),
        button('Copy', () => ed.transact('Duplicate material', (d) => {
          const src = d.materials.find((x) => x.id === ed.activeMaterial)!;
          const id = newId(d);
          d.materials.push({ ...structuredClone(src), id, name: uniqueName(d.materials.map((x) => x.name), src.name) });
          ed.activeMaterial = id;
        }), { title: 'Duplicate this material', disabled: !mat }),
        button('Assign', () => {
          const id = ed.activeMaterial;
          const groups = new Set([...ed.selectedFaceSet()].map((i) => m.faces[i].g));
          if (!groups.size && ed.activeGroup !== null) groups.add(ed.activeGroup);
          if (!groups.size) { toast('Select a group first.', 'info'); return; }
          ed.transact('Assign material', (d) => d.groups.forEach((g) => { if (groups.has(g.id)) g.material = id; }));
        }, { title: 'Assign to the selected or active group', disabled: !mat }),
        button('Delete', () => {
          const id = ed.activeMaterial;
          ed.transact('Delete material', (d) => {
            d.materials = d.materials.filter((x) => x.id !== id);
            d.groups.forEach((g) => { if (g.material === id) g.material = null; });
            ed.activeMaterial = d.materials[0]?.id ?? null;
          });
        }, { disabled: !mat }),
      ),
      mat ? h('div', { class: 'btn-row' }, button('Select users', () => {
        const id = mat.id;
        ed.setMode('group');
        ed.clearSelection();
        const groups = new Set(m.groups.filter((g) => g.material === id).map((g) => g.id));
        m.faces.forEach((f, i) => { if (groups.has(f.g)) ed.selFaces.add(i); });
        ed.emit('selection', 'tool');
        if (!groups.size) toast('Nothing uses this material yet.', 'info');
      }, { title: 'Select every group using this material' })) : null,
    ),
    mat && p ? section('Preview',
      p.canvas,
      h('div', { class: 'seg block-seg' }, (['sphere', 'cube', 'plane'] as const).map((s) => h('button', {
        class: `seg-btn${p.shape === s ? ' active' : ''}`, 'aria-pressed': String(p.shape === s),
        onclick: () => { p.shape = s; refreshDock(); },
      }, s === 'sphere' ? 'Sphere' : s === 'cube' ? 'Cube' : 'Flat'))),
    ) : null,
    section('Looks',
      h('div', { class: 'preset-head' }, h('button', { class: 'btn btn-small', onclick: () => { presetsOpen = !presetsOpen; refreshDock(); } }, presetsOpen ? 'Hide' : 'Show all')),
      presetsOpen ? h('div', { class: 'preset-grid' }, MATERIAL_PRESETS.map((pre) => {
        const pic = presetThumb(pre.name, pre.look);
        return h('button', {
          class: 'preset-btn', title: `${pre.group}: ${pre.name}. Keeps your textures.`,
          'data-preset': pre.name,
          onclick: () => {
            // With no material to change, a look starts one and gives it to what's selected.
            if (mat) { update(`Look: ${pre.name}`, (t) => {
              applyPreset(t, pre.look);
              // The gradient's own colours stay true: a look only changes its finish.
              if (t.gradient) t.color = '#ffffff';
            }); return; }
            const groups = new Set([...ed.selectedFaceSet()].map((i) => m.faces[i].g));
            if (!groups.size && ed.activeGroup !== null) groups.add(ed.activeGroup);
            ed.transact(`New ${pre.name} material`, (d) => {
              const nm = makeMaterial(d, uniqueName(d.materials.map((x) => x.name), pre.name));
              applyPreset(nm, pre.look);
              ed.activeMaterial = nm.id;
              d.groups.forEach((g) => { if (groups.has(g.id)) g.material = nm.id; });
            });
          },
        }, pic ? h('img', { src: pic, alt: '' }) : null, h('span', null, pre.name));
      })) : null,
    ),
    section('Images',
      h('div', { class: 'drop-hint' },
        h('p', { class: 'small' }, 'Drop images anywhere on this panel, or onto a piece in the view, or paste with Ctrl+V. Texture sets sort themselves by file name: normal, roughness, metallic, AO, emissive.'),
        h('div', { class: 'btn-row' }, button('Choose images…', () => void chooseImages(), { title: 'Pick one image, or a whole texture set' })),
      ),
    ),
    mat ? section('Surface',
      mat.gradient ? h('p', { class: 'muted small' }, 'Colour comes from the gradient below.') : color('Base colour', 'color'),
      palettePanel(mat),
      mat.unlit ? null : scrub('Metallic', 'metallic', 1),
      mat.unlit ? null : scrub('Roughness', 'roughness', 1),
      scrub('Alpha', 'alpha', 1),
      h('label', { class: 'form-row' }, 'Alpha mode', select(mat.alphaMode, [['opaque', 'Opaque'], ['mask', 'Cutout'], ['blend', 'Blend']], (v) => update('Alpha mode', (t) => { t.alphaMode = v; }))),
      mat.alphaMode === 'mask' ? scrub('Cutoff', 'alphaCutoff', 1, 0, 0.5, 'Pixels less opaque than this vanish') : null,
      mat.unlit ? null : color('Emissive', 'emissive'),
      mat.unlit ? null : scrub('Glow', 'emissiveStrength', 20),
      checkbox('Double-sided', mat.doubleSided, (v) => update('Double-sided', (t) => { t.doubleSided = v; })),
      checkbox('Unlit (ignores lighting)', !!mat.unlit, (v) => update('Unlit', (t) => { t.unlit = v; })),
    ) : null,
    mat ? gradientSection(mat) : null,
    mat && !mat.unlit ? section('Finish',
      scrub('Clearcoat', 'clearcoat', 1, 0, 0, 'A glossy layer on top, like car paint or lacquer'),
      (mat.clearcoat ?? 0) > 0 ? scrub('Coat rough', 'clearcoatRoughness', 1, 0, 0.1) : null,
      scrub('Sheen', 'sheen', 1, 0, 0, 'A soft edge glow, as on cloth and velvet'),
      (mat.sheen ?? 0) > 0 ? color('Sheen colour', 'sheenColor') : null,
      scrub('Glass', 'transmission', 1, 0, 0, 'How much light passes through. The view shows an approximation; engines that support it refract properly.'),
      (mat.transmission ?? 0) > 0 ? scrub('Bends light', 'ior', 2.5, 1, 1.5, 'Index of refraction: water 1.33, glass 1.5, diamond 2.4') : null,
    ) : null,
    mat ? section('Texture maps',
      slot('base', 'Base colour'),
      mat.unlit ? null : slot('normal', 'Normal', h('div', null,
        hasNormal ? scrub('Strength', 'normalScale', 5, 0, 1) : null,
        h('div', { class: 'btn-row' },
          hasBase ? button('From base colour', () => void makeNormalFromBase(), { class: 'btn btn-small', title: 'Generate bumps from the base colour\'s light and dark' }) : null,
          hasNormal ? button('Flip green', () => void flipNormalGreen(), { class: 'btn btn-small', title: 'If bumps look inside out, the map is DirectX-style. This converts it for glTF.' }) : null,
        ),
      )),
      mat.unlit ? null : slot('orm', 'Occlusion / rough / metal', h('div', null,
        hasOrm ? scrub('Occlusion', 'occlusionStrength', 1, 0, 1) : null,
        h('p', { class: 'muted small' }, 'Have separate greyscale maps? They pack into this one.'),
        h('div', { class: 'btn-row' },
          button('Occlusion', () => void packOrmChannel('occlusion'), { class: 'btn btn-small' }),
          button('Roughness', () => void packOrmChannel('roughness'), { class: 'btn btn-small' }),
          button('Metallic', () => void packOrmChannel('metallic'), { class: 'btn btn-small' }),
        ),
      )),
      mat.unlit ? null : slot('emissive', 'Emissive'),
    ) : null,
    mat && anyMap ? section('Texture placement',
      h('div', { class: 'field-label' }, 'Tiling'),
      h('div', { class: 'xyz' }, pair('U', 'uvScale', 0, 1, -100, 100), pair('V', 'uvScale', 1, 1, -100, 100)),
      h('div', { class: 'field-label' }, 'Shift'),
      h('div', { class: 'xyz' }, pair('U', 'uvOffset', 0, 0), pair('V', 'uvOffset', 1, 0)),
      scrub('Turn', 'uvRotation', 6.2832, -6.2832, 0, 'In radians'),
      h('div', { class: 'btn-row' },
        button('Half size', () => void halveTextures(), { class: 'btn btn-small', title: 'Halve this material\'s textures, for a smaller file and less memory' }),
        unused ? button(`Remove ${unused} unused`, () => ed.transact('Remove unused textures', (d) => {
          const used = new Set(d.materials.flatMap((x) => Object.values(x.maps)));
          d.textures = d.textures.filter((t) => used.has(t.id));
        }), { class: 'btn btn-small' }) : null,
      ),
    ) : null,
  ];
}

// ---------- texture work ----------
const bytesToUrl = (mime: string, data: ArrayBuffer) => {
  let bin = '';
  const bytes = new Uint8Array(data);
  for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return `data:${mime};base64,${btoa(bin)}`;
};

async function decode(url: string) {
  const img = new Image();
  img.src = url;
  await img.decode();
  return img;
}

const pixelsOf = (img: HTMLImageElement, w = img.naturalWidth, h0 = img.naturalHeight) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h0;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(img, 0, 0, w, h0);
  return g.getImageData(0, 0, w, h0).data;
};

const pixelsToUrl = (rgba: Uint8ClampedArray, w: number, h0: number) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h0;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h0), 0, 0);
  return c.toDataURL('image/png');
};

function setMap(label: string, slot: MapSlot, name: string, url: string, w: number, h0: number, also?: (t: Material) => void) {
  const id = ed.activeMaterial;
  ed.transact(label, (d) => {
    const tid = newId(d);
    d.textures.push({ id: tid, name, url, width: w, height: h0 });
    const t = d.materials.find((x) => x.id === id)!;
    if (slot === 'base') {
      // A picture replaces a gradient, and shows in its own colours rather than tinted by the old base colour.
      if (t.gradient) dropGradient(d, t);
      else if (t.maps.base === undefined) t.color = '#ffffff';
    }
    t.maps[slot] = tid;
    also?.(t);
  });
  app.uvRefresh();
}

// ---------- palettes ----------
function palettePanel(mat: Material) {
  const p = colorStore.current();
  const applyColor = (hex: string) => {
    // With a gradient, swatches colour the selected stop. Otherwise they set the base colour.
    if (mat.gradient) {
      const stops = mat.gradient.stops.map((s, i) => (i === gradStop ? { ...s, color: hex } : s));
      commitGradient('Gradient colour', { stops });
    } else ed.transact('Set colour', (d) => { d.materials.find((x) => x.id === mat.id)!.color = hex; });
    colorStore.remember(hex);
    refreshDock();
  };
  const current = mat.gradient ? mat.gradient.stops[gradStop]?.color : mat.color;
  const chips = (colors: string[]) => h('div', { class: 'palette-chips' }, colors.map((c) => h('button', {
    class: `palette-chip${c === current ? ' active' : ''}`, style: { background: c }, title: c, 'aria-label': c, 'data-swatch': c,
    onclick: () => applyColor(c),
  })));
  const custom = colorStore.isCustom(p.name);
  return h('div', { class: 'palette-box' },
    h('div', { class: 'palette-head' },
      h('select', {
        class: 'cp-palette', 'aria-label': 'Palette',
        onchange: (e: Event) => { colorStore.setActive((e.target as HTMLSelectElement).value); refreshDock(); },
      }, colorStore.all().map((x) => h('option', { value: x.name, selected: x.name === p.name }, x.name))),
      button(svgIcon(ICONS.plus, 12), () => { if (current) { colorStore.addColor(current); refreshDock(); } }, { class: 'cp-mini', title: custom ? `Add this colour to ${p.name}` : 'Save this colour to a palette of your own' }),
      menuLike(p.name, custom),
    ),
    chips(p.colors),
    colorStore.recent.length ? h('div', { class: 'palette-sub' }, h('span', { class: 'muted small' }, 'Recent'), chips(colorStore.recent.slice(0, 8))) : null,
  );
}

/** Palette tools: make one from an image, load one from a file, delete your own. */
function menuLike(name: string, custom: boolean) {
  return h('div', { class: 'palette-tools' },
    button('From image', () => void paletteFromFile(), { class: 'btn btn-small', title: 'Pull the main colours out of a picture' }),
    button('Load', () => void loadPaletteFile(), { class: 'btn btn-small', title: 'Load a palette file: .gpl, .hex or .txt' }),
    custom ? button('Delete', () => { colorStore.deletePalette(name); refreshDock(); }, { class: 'btn btn-small', title: `Delete ${name}` }) : null,
  );
}

export function makePaletteFromPixels(rgba: ArrayLike<number>, name: string) {
  const colors = paletteFromImage(rgba, 8);
  if (!colors.length) { toast('That image has no solid colours to use.', 'info'); return null; }
  const made = colorStore.addPalette(name, colors);
  refreshDock();
  toast(`Made the palette ${made}`, 'ok');
  return made;
}

async function paletteFromFile() {
  const f = await pickImage();
  if (!f) return;
  const img = await decode(f.url);
  const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  makePaletteFromPixels(pixelsOf(img, Math.max(1, Math.round(img.naturalWidth * scale)), Math.max(1, Math.round(img.naturalHeight * scale))), f.name.replace(/\.[^.]+$/, ''));
}

async function loadPaletteFile() {
  const f = await openFile([{ name: 'Palettes', extensions: ['gpl', 'hex', 'txt'] }]);
  if (!f) return;
  const colors = parsePaletteText(new TextDecoder().decode(f.data));
  if (!colors.length) { toast('No colours found in that file.', 'warn'); return; }
  colorStore.addPalette(f.name.replace(/\.[^.]+$/, ''), colors);
  refreshDock();
}

// ---------- gradients ----------
let gradStop = 0;
let gradDragging = false;

/** Remove a gradient along with its baked texture, restoring a plain colour. */
function dropGradient(d: Model, t: Material) {
  const id = t.maps.base;
  if (t.gradient) t.color = t.gradient.stops[t.gradient.stops.length - 1]?.color ?? t.color;
  delete t.gradient;
  delete t.maps.base;
  if (id !== undefined && !d.materials.some((x) => Object.values(x.maps).includes(id))) d.textures = d.textures.filter((x) => x.id !== id);
}

const facesUsing = (d: Model, materialId: number) => {
  const groups = new Set(d.groups.filter((g) => g.material === materialId).map((g) => g.id));
  const out: number[] = [];
  d.faces.forEach((f, i) => { if (groups.has(f.g)) out.push(i); });
  return out;
};

/** Bake a material's gradient into its base colour map. The old baked texture goes, so edits don't pile up. */
function bakeGradientInto(d: Model, t: Material, size?: number) {
  const g = t.gradient;
  if (!g) return;
  const res = size ?? g.size;
  const rgba = g.space === 'model' ? bakeModelGradient(d, facesUsing(d, t.id), g, res) : bakeTextureGradient(g, res);
  const old = t.maps.base;
  const id = newId(d);
  d.textures.push({ id, name: `${t.name} gradient`, url: pixelsToUrl(rgba, res, res), width: res, height: res });
  t.maps.base = id;
  t.color = '#ffffff';
  // Tiling would move a model-space bake off the surface it was painted for.
  if (g.space === 'model') { delete t.uvScale; delete t.uvOffset; delete t.uvRotation; }
  if (old !== undefined && !d.materials.some((x) => Object.values(x.maps).includes(old))) d.textures = d.textures.filter((x) => x.id !== old);
}

function commitGradient(label: string, change: Partial<Gradient>) {
  const id = ed.activeMaterial;
  ed.transact(label, (d) => {
    const t = d.materials.find((x) => x.id === id);
    if (!t?.gradient) return;
    t.gradient = { ...t.gradient, ...change };
    bakeGradientInto(d, t);
  });
}

/** Draw the gradient live during a drag, at a lower resolution so it keeps up. */
let gradTimer = 0;
function liveGradient(change: Partial<Gradient>) {
  const t = ed.model.materials.find((x) => x.id === ed.activeMaterial);
  if (!t?.gradient) return;
  t.gradient = { ...t.gradient, ...change };
  if (performance.now() - gradTimer > 60) {
    gradTimer = performance.now();
    bakeGradientInto(ed.model, t, 128);
    ed.emit('materials');
  }
  refreshDock();
}

const DIRECTIONS: [number, string][] = [[0, 'Upward'], [45, 'Up and right'], [90, 'To the right'], [135, 'Down and right'], [180, 'Downward'], [225, 'Down and left'], [270, 'To the left'], [315, 'Up and left']];

function gradientSection(mat: Material) {
  const g = mat.gradient;
  if (!g) {
    return section('Gradient',
      h('p', { class: 'muted small' }, 'Blend colours across a piece. It bakes to an ordinary texture, so it works in any engine.'),
      h('div', { class: 'btn-row' }, button('Add gradient', () => {
        const id = mat.id;
        gradStop = 1;
        ed.transact('Add gradient', (d) => {
          const t = d.materials.find((x) => x.id === id)!;
          t.gradient = newGradient(t.color === '#ffffff' ? '#7fa8d9' : t.color);
          bakeGradientInto(d, t);
        });
      })),
      h('div', { class: 'preset-row' }, GRADIENT_PRESETS.map((p) => h('button', {
        class: 'grad-preset', title: p.name, 'aria-label': `${p.name} gradient`, 'data-gradient': p.name, style: { background: gradientCss({ stops: p.stops, bands: 0 }) },
        onclick: () => {
          const id = mat.id;
          gradStop = 0;
          ed.transact(`Gradient: ${p.name}`, (d) => {
            const t = d.materials.find((x) => x.id === id)!;
            t.gradient = { ...newGradient('#ffffff'), stops: p.stops.map((s) => ({ ...s })) };
            bakeGradientInto(d, t);
          });
        },
      }))),
    );
  }
  if (gradStop >= g.stops.length) gradStop = g.stops.length - 1;
  const stop = g.stops[gradStop];
  const usedFaces = facesUsing(ed.model, mat.id);
  const overlaps = g.space === 'model' && usedFaces.length && !gradDragging ? uvOverlaps(ed.model, usedFaces).size : 0;
  const seg = <T extends string>(value: T, options: [T, string, string?][], set: (v: T) => void) => h('div', { class: 'seg block-seg' }, options.map(([v, label, title]) => h('button', {
    class: `seg-btn${value === v ? ' active' : ''}`, 'aria-pressed': String(value === v), title, onclick: () => set(v),
  }, label)));
  const stopColor: ColorCallbacks = (() => {
    const index = gradStop;
    let begun = false;
    return {
      onInput: (hex) => {
        if (!begun) { begun = true; ed.begin('Gradient colour'); gradDragging = true; }
        const t = ed.model.materials.find((x) => x.id === mat.id);
        liveGradient({ stops: (t?.gradient?.stops ?? g.stops).map((s, i) => (i === index ? { ...s, color: hex } : s)) });
      },
      onCommit: () => {
        if (!begun) return;
        const t = ed.model.materials.find((x) => x.id === mat.id);
        if (t?.gradient) bakeGradientInto(ed.model, t);
        ed.commit();
        begun = false; gradDragging = false;
        ed.emitAll();
      },
      onCancel: () => { if (begun) { ed.cancel(); begun = false; gradDragging = false; } },
    };
  })();
  return section('Gradient',
    gradientBar(g, {
      selected: gradStop,
      onSelect: (i) => { gradStop = i; refreshDock(); },
      onDragStart: () => { gradDragging = true; ed.begin('Move gradient colour'); },
      onDrag: (stops, i) => { gradStop = i; liveGradient({ stops }); },
      onDragEnd: (stops, i) => {
        // Now the drag is over, the list settles into order, and the selection follows its stop.
        const moved = stops[i];
        const sorted = [...stops].sort((a, b) => a.at - b.at);
        gradStop = sorted.indexOf(moved);
        const t = ed.model.materials.find((x) => x.id === mat.id);
        if (t?.gradient) { t.gradient = { ...t.gradient, stops: sorted }; bakeGradientInto(ed.model, t); }
        ed.commit();
        gradDragging = false;
        ed.emitAll();
      },
      onAdd: (stops, i) => {
        const moved = stops[i];
        const sorted = [...stops].sort((a, b) => a.at - b.at);
        gradStop = sorted.indexOf(moved);
        commitGradient('Add gradient colour', { stops: sorted });
      },
    }),
    stop ? h('div', { class: 'grad-stop-row' },
      colorButton(stop.color, 'This colour', stopColor),
      numField({ label: 'At', value: Math.round(stop.at * 100), min: 0, max: 100, step: 1, digits: 0, title: 'Position along the gradient, in percent', onChange: (v) => {
        const moved = { ...stop, at: v / 100 };
        const stops = g.stops.map((s, i) => (i === gradStop ? moved : s)).sort((a, b) => a.at - b.at);
        gradStop = stops.indexOf(moved);
        commitGradient('Move gradient colour', { stops });
      } }),
      button('Remove', () => {
        const stops = g.stops.filter((_, i) => i !== gradStop);
        gradStop = Math.min(gradStop, stops.length - 1);
        commitGradient('Remove gradient colour', { stops });
      }, { class: 'btn btn-small', disabled: g.stops.length <= 2, title: 'A gradient needs at least two colours' }),
    ) : null,
    h('div', { class: 'preset-row' }, GRADIENT_PRESETS.map((p) => h('button', {
      class: 'grad-preset', title: p.name, 'aria-label': `${p.name} gradient`, 'data-gradient': p.name, style: { background: gradientCss({ stops: p.stops, bands: 0 }) },
      onclick: () => { gradStop = 0; commitGradient(`Gradient: ${p.name}`, { stops: p.stops.map((s) => ({ ...s })) }); },
    }))),
    h('div', { class: 'field-label' }, 'Type'),
    seg(g.kind, [['linear', 'Linear', 'One colour to the other'], ['mirror', 'Mirror', 'Out from the middle in both directions'], ['radial', 'Radial', 'Outward from the centre']], (kind) => commitGradient('Gradient type', { kind })),
    h('div', { class: 'field-label' }, 'Across'),
    seg(g.space, [['model', 'The model', 'Follows the shape, however the UVs are laid out'], ['texture', 'The texture', 'Follows the UVs, and tiles']], (space) => commitGradient('Gradient space', { space })),
    g.kind === 'radial' ? null : h('div', null,
      h('div', { class: 'field-label' }, 'Direction'),
      h('div', { class: 'dir-row' },
        DIRECTIONS.map(([a, title]) => h('button', {
          class: `dir-btn${!g.depth && Math.round(g.angle) === a ? ' active' : ''}`, title, 'aria-label': title, 'data-angle': String(a),
          onclick: () => commitGradient('Gradient direction', { angle: a, depth: false }),
        }, svgIconRotated(a))),
        h('button', {
          class: `dir-btn dir-depth${g.depth ? ' active' : ''}`, title: 'Front to back', 'aria-label': 'Front to back', 'data-depth': '1',
          onclick: () => commitGradient('Gradient direction', { depth: !g.depth }),
        }, svgIcon('<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.2" fill="currentColor"/>', 14)),
      ),
      g.depth ? null : numField({ label: 'Angle', value: g.angle, min: 0, max: 359, step: 1, digits: 0, title: 'In degrees, as seen from the front: 0 runs upward, 90 to the right', onChange: (v) => commitGradient('Gradient angle', { angle: v, depth: false }) }),
    ),
    numField({ label: 'Bands', value: g.bands, min: 0, max: 32, step: 1, digits: 0, title: 'Flat steps of colour for toon and low-poly looks. 0 blends smoothly.', onChange: (v) => commitGradient('Gradient bands', { bands: Math.round(v) }) }),
    h('label', { class: 'form-row' }, 'Size', select<number>(g.size, [[128, '128'], [256, '256'], [512, '512'], [1024, '1024'], [2048, '2048']], (v) => commitGradient('Gradient size', { size: v }))),
    overlaps ? h('div', { class: 'verdict bad' }, `${overlaps} faces overlap in UVs, so they share colours. `, button('Auto Unwrap', () => {
      const id = mat.id;
      ed.transact('Unwrap for gradient', (d) => {
        unwrapUV(d, facesUsing(d, id));
        const t = d.materials.find((x) => x.id === id);
        if (t) bakeGradientInto(d, t);
      });
    }, { class: 'btn btn-small' })) : null,
    h('div', { class: 'btn-row' },
      button('Reverse', () => { gradStop = g.stops.length - 1 - gradStop; commitGradient('Reverse gradient', { stops: reverseStops(g.stops) }); }, { class: 'btn btn-small' }),
      button('Even out', () => commitGradient('Space gradient evenly', { stops: evenStops(g.stops) }), { class: 'btn btn-small', title: 'Space the colours evenly' }),
      button('Re-bake', () => commitGradient('Re-bake gradient', {}), { class: 'btn btn-small', title: 'Paint it again after changing the shape or UVs' }),
      button('Remove', () => {
        const id = mat.id;
        ed.transact('Remove gradient', (d) => { const t = d.materials.find((x) => x.id === id); if (t) dropGradient(d, t); });
      }, { class: 'btn btn-small' }),
    ),
  );
}

const svgIconRotated = (deg: number) => {
  const el = svgIcon('<path d="M12 20V5M6 11l6-6 6 6"/>', 14);
  el.style.transform = `rotate(${deg}deg)`;
  return el;
};

// ---------- importing images ----------
export interface ImageFile { name: string; data: ArrayBuffer }

const MIME = (name: string) => {
  const ext = name.split('.').pop()!.toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
};

/** A material for images to land on: the active one, or a new one given to what's selected. */
function ensureMaterial(name: string, groups?: number[]) {
  const m = ed.model;
  const wanted = groups ?? (() => {
    const g = new Set([...ed.selectedFaceSet()].map((i) => m.faces[i].g));
    if (!g.size && ed.activeGroup !== null) g.add(ed.activeGroup);
    return [...g];
  })();
  if (m.materials.some((x) => x.id === ed.activeMaterial) && !groups) {
    // Selected pieces with no material of their own take the active one, or the image wouldn't show on them.
    const bare = m.groups.filter((g) => wanted.includes(g.id) && g.material === null).map((g) => g.id);
    if (bare.length) {
      const id = ed.activeMaterial;
      ed.transact('Assign material', (d) => { d.groups.forEach((g) => { if (bare.includes(g.id)) g.material = id; }); });
    }
    return;
  }
  ed.transact('New material from image', (d) => {
    const nm = makeMaterial(d, uniqueName(d.materials.map((x) => x.name), name.replace(/\.[^.]+$/, '').replace(/[_-](base|albedo|diffuse|color|colour|basecolor)$/i, '') || 'Material'));
    nm.color = '#ffffff';
    d.groups.forEach((g) => { if (wanted.includes(g.id)) g.material = nm.id; });
    ed.activeMaterial = nm.id;
  });
}

/**
 * Bring images into the active material. Each goes to the slot given, or else to the one its file name suggests.
 * Separate roughness, metallic and occlusion maps pack together, and DirectX normal maps are corrected.
 */
export async function importImageFiles(files: ImageFile[], slot?: MapSlot, groups?: number[]) {
  if (!files.length) return;
  ensureMaterial(files[0].name, groups);
  const placed: string[] = [];
  // The base colour goes first, so the rest land on a settled material.
  const order = files.map((f) => ({ f, guess: guessMapKind(f.name) })).sort((a, b) => Number(b.guess.kind === 'base') - Number(a.guess.kind === 'base'));
  for (const { f, guess } of order) {
    const url = bytesToUrl(MIME(f.name), f.data);
    const img = await decode(url);
    const kind = slot ?? guess.kind;
    const w = img.naturalWidth, h0 = img.naturalHeight;
    if (kind === 'roughness' || kind === 'metallic' || kind === 'occlusion') {
      await packOrmImage(kind, url, f.name);
      placed.push(kind);
      continue;
    }
    const needsPng = !/image\/(png|jpeg)/.test(MIME(f.name));
    const finalUrl = kind === 'normal' && guess.directX
      ? pixelsToUrl(flipGreen(new Uint8ClampedArray(pixelsOf(img))), w, h0)
      : needsPng ? pixelsToUrl(new Uint8ClampedArray(pixelsOf(img)), w, h0) : url;
    setMap(`Load ${kind} map`, kind, f.name, finalUrl, w, h0);
    placed.push(kind === 'orm' ? 'occlusion/rough/metal' : kind === 'base' ? 'base colour' : kind);
  }
  panelState.tab = 'material';
  refreshDock();
  toast(files.length === 1 ? `Loaded ${files[0].name} as ${placed[0]}` : `Loaded ${files.length} images: ${placed.join(', ')}`, 'ok');
}

async function chooseImages() {
  const picked = await openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }]);
  if (picked) await importImageFiles([{ name: picked.name, data: picked.data }]);
}

async function pickImage() {
  const f = await openFile([{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]);
  if (!f) return null;
  const ext = f.name.split('.').pop()!.toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : 'image/png';
  return { name: f.name, mime, url: bytesToUrl(mime, f.data) };
}

async function loadTexture(slot: MapSlot) {
  const f = await pickImage();
  if (!f) return;
  const img = await decode(f.url);
  // glTF only permits PNG and JPEG textures, so WebP is converted on the way in.
  const url = f.mime === 'image/webp' ? pixelsToUrl(pixelsOf(img), img.naturalWidth, img.naturalHeight) : f.url;
  setMap('Load texture', slot, f.name, url, img.naturalWidth, img.naturalHeight);
}

const activeMat = () => ed.model.materials.find((x) => x.id === ed.activeMaterial);
const textureOf = (mat: Material | undefined, slot: MapSlot) => (mat ? ed.model.textures.find((t) => t.id === mat.maps[slot]) : undefined);

export async function makeNormalFromBase(strength = 2) {
  const mat = activeMat();
  const base = textureOf(mat, 'base');
  if (!base) return;
  const img = await decode(base.url);
  const w = img.naturalWidth, h0 = img.naturalHeight;
  setMap('Normal from base colour', 'normal', `${base.name} normal`, pixelsToUrl(normalFromHeight(pixelsOf(img), w, h0, strength), w, h0), w, h0);
}

export async function flipNormalGreen() {
  const tex = textureOf(activeMat(), 'normal');
  if (!tex) return;
  const img = await decode(tex.url);
  const w = img.naturalWidth, h0 = img.naturalHeight;
  setMap('Flip normal green', 'normal', tex.name, pixelsToUrl(flipGreen(new Uint8ClampedArray(pixelsOf(img))), w, h0), w, h0);
}

/** Pack a greyscale image into the material's occlusion/roughness/metallic map, starting one if it has none. */
export async function packOrmImage(channel: OrmChannel, url: string, name: string) {
  const mat = activeMat();
  if (!mat) return;
  const gray = await decode(url);
  const cur = textureOf(mat, 'orm');
  const curImg = cur ? await decode(cur.url) : null;
  const w = curImg?.naturalWidth ?? gray.naturalWidth, h0 = curImg?.naturalHeight ?? gray.naturalHeight;
  const orm = curImg ? new Uint8ClampedArray(pixelsOf(curImg)) : blankOrm(w, h0, mat.roughness, mat.metallic);
  const packed = packChannel(orm, pixelsOf(gray, w, h0), channel);
  // The packed map now holds these values, and the sliders multiply it, so they go to full.
  setMap(`Pack ${channel}`, 'orm', cur?.name ?? `${mat.name} ORM (${name})`, pixelsToUrl(packed, w, h0), w, h0, (t) => { t.roughness = 1; t.metallic = 1; });
}

async function packOrmChannel(channel: OrmChannel) {
  const f = await pickImage();
  if (f) await packOrmImage(channel, f.url, f.name);
}

export async function halveTextures() {
  const mat = activeMat();
  if (!mat) return;
  const slots = Object.keys(mat.maps) as MapSlot[];
  const made: { slot: MapSlot; name: string; url: string; w: number; h: number }[] = [];
  for (const slot of slots) {
    const t = textureOf(mat, slot);
    if (!t || t.width < 8 || t.height < 8) continue;
    const img = await decode(t.url);
    const w = Math.max(1, t.width >> 1), h0 = Math.max(1, t.height >> 1);
    made.push({ slot, name: t.name, url: pixelsToUrl(new Uint8ClampedArray(pixelsOf(img, w, h0)), w, h0), w, h: h0 });
  }
  if (!made.length) return;
  const id = ed.activeMaterial;
  ed.transact('Halve textures', (d) => {
    const t = d.materials.find((x) => x.id === id)!;
    for (const x of made) {
      const tid = newId(d);
      d.textures.push({ id: tid, name: x.name, url: x.url, width: x.w, height: x.h });
      t.maps[x.slot] = tid;
    }
  });
  toast(`Halved ${made.length} texture${made.length === 1 ? '' : 's'}`, 'ok');
}

// ---------- rig ----------
function rigPanel() {
  const m = ed.model;
  const tree: HTMLElement[] = [];
  const walk = (parent: number | null, depth: number) => {
    for (const b of m.bones.filter((x) => x.parent === parent)) {
      const weighted = m.verts.reduce((s, v) => s + (v.w?.some((x) => x[0] === b.id) ? 1 : 0), 0);
      tree.push(h('div', {
        class: `row${ed.activeBone === b.id ? ' active' : ''}`,
        style: { paddingLeft: `${6 + depth * 14}px` },
        onclick: (e: MouseEvent) => {
          ed.activeBone = b.id;
          if (ed.mode === 'bone') {
            if (!e.shiftKey) ed.selBones.clear();
            ed.selBones.add(b.id);
          }
          ed.emit('selection', 'skeleton');
        },
      },
        h('span', { class: 'bone-dot' }),
        renamable(b.name, (v) => ed.transact('Rename joint', (d) => { d.bones.find((x) => x.id === b.id)!.name = uniqueName(d.bones.filter((x) => x.id !== b.id).map((x) => x.name), v); })),
        h('span', { class: 'row-meta', title: 'Vertices influenced' }, weighted.toLocaleString()),
      ));
      walk(b.id, depth + 1);
    }
  };
  walk(null, 0);
  const active = m.bones.find((b) => b.id === ed.activeBone);
  const issues = m.bones.length ? weightIssues(m) : null;
  const jointAxis = (axis: 0 | 1 | 2) => numField({
    label: 'XYZ'[axis], axis, value: active!.head[axis], step: 0.005, digits: 3, title: `Rest position ${'XYZ'[axis]}`,
    onScrubStart: () => ed.begin('Move joint'),
    onInput: (v) => { active!.head[axis] = v; ed.emit('skeleton', 'geometry'); },
    onScrubEnd: () => { ed.commit(); ed.emitAll(); },
    onChange: (v) => ed.transact('Move joint', (d) => { d.bones.find((x) => x.id === active!.id)!.head[axis] = v; }),
  });
  return [
    section('Test pose',
      h('div', { class: 'btn-row' },
        button(ed.testPose ? 'Stop testing' : 'Test pose', () => runCommand('rig.testPose'), { class: ed.testPose ? 'btn btn-primary' : 'btn', title: commands.get('rig.testPose')?.hint, disabled: !m.bones.length }),
        cmd('rig.resetPose', 'Reset'),
      ),
      h('p', { class: 'muted small' }, ed.testPose ? 'Rotate joints to check the bends, then paint to fix them. Nothing here is saved.' : 'Bend the rig to check weights. No clip needed.'),
    ),
    section('Skeleton',
      tree.length ? h('div', { class: 'list tall' }, tree) : h('p', { class: 'muted' }, 'Add a humanoid to start fast, or pick the Joint tool (J) and click in a view to start a chain.'),
      h('div', { class: 'btn-row' },
        m.bones.length ? button('Add joint', () => runCommand('tool.joint')) : cmd('rig.humanoid', 'Add humanoid', commands.get('rig.humanoid')?.hint),
        m.bones.length ? cmd('rig.split', 'Insert', commands.get('rig.split')?.hint) : button('Add joint', () => runCommand('tool.joint')),
        button('Delete', () => { ed.setMode('bone'); if (active) { ed.selBones = new Set([active.id]); runCommand('edit.delete'); } }, { disabled: !active, title: 'Its children and weights pass to its parent.' }),
      ),
      m.bones.length ? h('div', { class: 'btn-row' }, cmd('rig.mirrorJoints', 'Mirror across X', commands.get('rig.mirrorJoints')?.hint)) : null,
      active ? h('label', { class: 'form-row' }, 'Parent', select<number>(active.parent ?? -1,
        [[-1, '(none)'], ...m.bones.filter((b) => b.id !== active.id && !isDescendant(m.bones, b.id, active.id)).map((b): [number, string] => [b.id, b.name])],
        (v) => ed.transact('Reparent joint', (d) => { d.bones.find((x) => x.id === active.id)!.parent = v === -1 ? null : v; }))) : null,
      active && !ed.poseActive ? h('div', { class: 'xyz' }, jointAxis(0), jointAxis(1), jointAxis(2)) : null,
      m.bones.length ? checkbox('Moving a joint moves its branch', ed.moveJointChildren, (v) => { ed.moveJointChildren = v; }) : null,
    ),
    section('Skinning',
      h('div', { class: 'btn-row' },
        cmd('rig.autoWeightsAll', 'Auto-weight all', commands.get('rig.autoWeights')?.hint),
        cmd('rig.autoWeights', 'Selected'),
      ),
      h('div', { class: 'btn-row' }, cmd('rig.smooth', 'Smooth', commands.get('rig.smooth')?.hint), cmd('rig.mirrorWeights', 'Mirror', commands.get('rig.mirrorWeights')?.hint), cmd('rig.prune', 'Clean up', commands.get('rig.prune')?.hint)),
      h('div', { class: 'btn-row' }, cmd('rig.assign', 'Assign to joint', 'Rigidly bind the selected vertices to the active joint'), cmd('rig.clear', 'Clear')),
      issues && m.faces.length && issues.unweighted.length
        ? h('div', { class: 'verdict bad' }, `${issues.unweighted.length.toLocaleString()} vertices have no weight `, button('Select', () => runCommand('rig.selectUnweighted'), { class: 'btn btn-small' }))
        : null,
      issues && m.faces.length && !issues.unweighted.length && issues.unusedJoints.length
        ? h('p', { class: 'muted small' }, `${issues.unusedJoints.length} joint${issues.unusedJoints.length === 1 ? ' moves' : 's move'} no vertices.`)
        : null,
    ),
    vertexWeightsSection(),
    section('Weight paint',
      h('div', { class: 'btn-row' }, cmd('tool.paint', 'Start painting')),
      numField({ label: 'Radius', value: ed.brush.radius, min: 4, max: 300, step: 1, digits: 0, title: '[ and ] change the size', onChange: (v) => { ed.brush.radius = v; } }),
      numField({ label: 'Strength', value: ed.brush.strength, min: 0.01, max: 1, step: 0.01, digits: 2, onChange: (v) => { ed.brush.strength = v; } }),
      h('label', { class: 'form-row' }, 'Brush', select(ed.brush.mode, [['add', 'Add'], ['sub', 'Subtract'], ['smooth', 'Smooth']], (v) => { ed.brush.mode = v as 'add' | 'sub' | 'smooth'; })),
      checkbox('Paint through to hidden surfaces', ed.brush.through, (v) => { ed.brush.through = v; }),
      h('p', { class: 'muted small' }, 'Shift subtracts. Ctrl smooths. Mirror X paints both sides.'),
      h('div', { class: 'heat-legend' }, h('span', null, '0'), h('i', null), h('span', null, '1')),
    ),
    section('Display',
      checkbox('Show joints', ed.showBones, (v) => { ed.showBones = v; ed.emit('view'); }),
      checkbox('Show joint names', ed.showBoneNames, (v) => { ed.showBoneNames = v; ed.emit('view'); }),
    ),
  ];
}

/** Exact weights for the selected vertices, averaged when several are selected. */
function vertexWeightsSection(): HTMLElement | null {
  const m = ed.model;
  if (!m.bones.length || ed.mode === 'bone') return null;
  const verts = [...ed.selectedVertexSet()];
  if (!verts.length) return null;
  const totals = new Map<number, number>();
  for (const v of verts) for (const [b, w] of m.verts[v].w ?? []) totals.set(b, (totals.get(b) ?? 0) + w / verts.length);
  const rows = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  return section(verts.length === 1 ? 'Vertex weights' : `Weights of ${verts.length.toLocaleString()} vertices`,
    rows.length ? rows.map(([b, w]) => numField({
      label: m.bones.find((x) => x.id === b)?.name ?? '?', value: w, min: 0, max: 1, step: 0.01, digits: 3,
      title: 'Other joints rebalance so the total stays 1',
      onChange: (v) => ed.transact('Set weight', (d) => verts.forEach((i) => paintWeight(d, i, b, v, 1))),
    })) : h('p', { class: 'muted small' }, 'No weights on this selection.'),
  );
}

function isDescendant(bones: typeof ed.model.bones, id: number, ancestor: number): boolean {
  let p = bones.find((b) => b.id === id)?.parent ?? null;
  while (p !== null) {
    if (p === ancestor) return true;
    p = bones.find((b) => b.id === p)?.parent ?? null;
  }
  return false;
}

// ---------- audit ----------
function auditPanel() {
  const m = ed.model;
  const budget = BUDGETS.find((b) => b.id === budgetId)!;
  const checks = runChecks(m, budget);
  const order = { error: 0, warn: 1, info: 2, ok: 3 } as const;
  checks.sort((a, b) => order[a.severity] - order[b.severity]);
  const problems = checks.filter((c) => c.severity === 'error' || c.severity === 'warn').length;
  const icon = { ok: ICONS.check, info: ICONS.info, warn: ICONS.warning, error: ICONS.close };
  const selectThing = (c: (typeof checks)[number]) => {
    ed.clearSelection();
    if (c.faces?.length) { ed.mode = 'face'; c.faces.forEach((f) => ed.selFaces.add(f)); }
    else if (c.verts?.length) { ed.mode = 'vertex'; c.verts.forEach((v) => ed.selVerts.add(v)); }
    else if (c.edges?.length) { ed.mode = 'edge'; c.edges.forEach((e) => ed.selEdges.add(e)); }
    ed.emit('selection', 'tool');
    app.vp.frameSelected(false);
  };
  return [
    section('Target',
      h('label', { class: 'form-row' }, 'Budget', select(budgetId, BUDGETS.map((b): [string, string] => [b.id, b.label]), (v) => { budgetId = v; refreshDock(); })),
      m.faces.length
        ? h('div', { class: `verdict ${problems ? 'bad' : 'good'}` }, problems ? `${problems} issue${problems > 1 ? 's' : ''} to fix before shipping` : 'Ready for the engine')
        : h('p', { class: 'muted' }, 'Add some geometry to audit it.'),
    ),
    m.faces.length ? section('Checks', h('div', { class: 'checks' }, checks.map((c) => h('div', { class: `check-row sev-${c.severity}`, title: c.detail },
      h('span', { class: 'sev-icon' }, svgIcon(icon[c.severity], 12)),
      h('div', { class: 'check-main' }, h('div', { class: 'check-title' }, h('span', null, c.label), h('span', { class: 'check-val' }, c.value)), c.severity !== 'ok' ? h('div', { class: 'muted small' }, c.detail) : null,
        c.severity !== 'ok' && (c.faces?.length || c.verts?.length || c.edges?.length || c.fix)
          ? h('div', { class: 'check-actions' },
            c.faces?.length || c.verts?.length || c.edges?.length ? button('Show', () => selectThing(c), { class: 'btn btn-small' }) : null,
            c.fix ? button(c.fixLabel ?? 'Fix', () => runCommand(c.fix!), { class: 'btn btn-small' }) : null)
          : null),
    )))) : null,
    section('History', h('div', { class: 'readout' }, `${ed.historyDepth} undo step${ed.historyDepth === 1 ? '' : 's'}`), ed.canUndo ? h('p', { class: 'muted small' }, `Last: ${ed.undoLabel}`) : null),
  ];
}

// ---------- host ----------
const TABS: [string, string, () => any][] = [
  ['block', 'Blockout', blockPanel],
  ['scene', 'Scene', scenePanel],
  ['material', 'Material', materialPanel],
  ['rig', 'Rig', rigPanel],
  ['audit', 'Audit', auditPanel],
];

let bodyEl: HTMLElement;
let tabsEl: HTMLElement;
let scheduled = false;

export function refreshDock() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    const t = TABS.find((x) => x[0] === panelState.tab) ?? TABS[0];
    renderInto(bodyEl, () => t[2]());
    tabsEl.querySelectorAll('button').forEach((b) => {
      const on = (b as HTMLElement).dataset.tab === panelState.tab;
      if ((b as HTMLElement).dataset.tab === 'block') (b as HTMLElement).style.display = ed.workspace === 'block' ? '' : 'none';
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    });
  });
}

export function buildDock(): HTMLElement {
  tabsEl = h('div', { class: 'dock-tabs', role: 'tablist' }, TABS.map(([id, label]) => h('button', {
    role: 'tab', 'data-tab': id, onclick: () => { panelState.tab = id; refreshDock(); },
  }, label)));
  bodyEl = h('div', { class: 'dock-body' });
  const dock = h('aside', { class: 'dock' }, tabsEl, bodyEl);
  app.showTab = (t) => { panelState.tab = t; refreshDock(); };
  ed.on(['selection', 'topology', 'groups', 'materials', 'skeleton', 'history', 'tool'], refreshDock);
  refreshDock();
  return dock;
}

// Status summary shared with the footer.
export function modelStats() {
  const m = ed.model;
  return { tris: triangleCount(m), verts: m.verts.length, faces: m.faces.length, bones: m.bones.length, groups: m.groups.length };
}

export { makeGroup };
