// Export, shortcuts and about dialogs.
import { BUDGETS, runChecks } from '../core/checks';
import { ed } from '../core/editor';
import { defaultExport, exportGLB, exportGltfPair, type ExportOptions } from '../io/gltf';
import { exportMS3D } from '../io/ms3d';
import { saveFile } from '../io/platform';
import { exportOBJ, exportPLY, exportSTL } from '../io/simple';
import { commands } from './commands';
import { checkbox, h, numField, select } from './dom';
import { modal, reportError, toast } from './feedback';

type Format = 'glb' | 'gltf' | 'obj' | 'stl' | 'ply' | 'ms3d';
const FORMATS: { id: Format; label: string; note: string }[] = [
  { id: 'glb', label: 'GLB (glTF binary)', note: 'Recommended. Single file with PBR materials, textures, skeleton and every clip. Imports directly into Godot and Unreal, and into Unity through its glTFast package.' },
  { id: 'gltf', label: 'glTF + BIN', note: 'Same contents as GLB, as readable JSON with a separate binary file.' },
  { id: 'obj', label: 'OBJ + MTL', note: 'Static geometry only. Keeps quads and n-gons. No skeleton or animation.' },
  { id: 'stl', label: 'STL', note: 'Triangles only, for 3D printing. No materials, UVs or animation.' },
  { id: 'ply', label: 'PLY', note: 'Plain vertices and polygons. No UVs or animation.' },
  { id: 'ms3d', label: 'MS3D (v4)', note: 'For older tools and engines. Triangles only, 65534 vertex limit, first clip only, simple materials.' },
];

let lastFormat: Format = 'glb';
const options: ExportOptions = { ...defaultExport };

export function openExportDialog() {
  if (!ed.model.faces.length) { toast('Nothing to export yet. Add some geometry first.', 'info'); return; }
  const noteEl = h('p', { class: 'muted' });
  const opts = h('div', { class: 'stack' });
  const refreshNote = () => { noteEl.textContent = FORMATS.find((f) => f.id === lastFormat)!.note; drawOptions(); };
  const drawOptions = () => {
    const animated = lastFormat === 'glb' || lastFormat === 'gltf';
    opts.replaceChildren(
      numField({ label: 'Scale', value: options.scale, step: 0.01, min: 0.0001, max: 10000, digits: 4, onChange: (v) => { options.scale = v; }, title: '1 unit in ThickShake = 1 metre. Most engines expect metres in glTF.' }),
      h('div', { class: 'check-grid' },
        animated ? checkbox('Skeleton', options.skeleton, (v) => { options.skeleton = v; }) : null,
        animated ? checkbox('Animations', options.animations, (v) => { options.animations = v; }) : null,
        lastFormat !== 'stl' && lastFormat !== 'ply' && lastFormat !== 'ms3d' ? checkbox('LOD meshes', options.includeLods, (v) => { options.includeLods = v; }) : null,
        lastFormat !== 'stl' && lastFormat !== 'ply' && lastFormat !== 'ms3d' ? checkbox('Collision meshes', options.includeCollision, (v) => { options.includeCollision = v; }) : null,
        checkbox('Visible groups only', options.onlyVisible, (v) => { options.onlyVisible = v; }),
      ),
    );
  };

  // Preflight against the mid-range budget so real problems surface before export.
  const issues = runChecks(ed.model, BUDGETS[2]).filter((c) => c.severity === 'error' || c.severity === 'warn');
  const preflight = issues.length
    ? h('div', { class: 'preflight warn' }, h('strong', null, `${issues.length} thing${issues.length > 1 ? 's' : ''} to check`), h('ul', null, issues.slice(0, 5).map((i) => h('li', null, `${i.label}: ${i.value}`))))
    : h('div', { class: 'preflight ok' }, 'No problems found. This model is ready to export.');

  const body = h('div', { class: 'stack' },
    h('label', { class: 'form-row' }, 'Format', select<Format>(lastFormat, FORMATS.map((f) => [f.id, f.label]), (v) => { lastFormat = v; refreshNote(); })),
    noteEl, opts, preflight);
  refreshNote();

  void modal('Export model', body, [
    { label: 'Cancel', value: false },
    { label: 'Export', primary: true, run: async () => {
      try { await doExport(lastFormat, options); } catch (e) { reportError('Export failed', e); return false; }
      return true;
    } },
  ], { width: 480 });
}

export async function doExport(format: Format, o: ExportOptions) {
  const m = ed.model;
  const stem = ed.fileName.replace(/\.[^.]+$/, '') || 'model';
  const filter = (name: string, ext: string) => [{ name, extensions: [ext] }];
  let res: { name: string } | null = null;
  switch (format) {
    case 'glb': res = await saveFile({ defaultName: `${stem}.glb`, filters: filter('glTF Binary', 'glb'), data: exportGLB(m, o) }); break;
    case 'gltf': {
      const { gltf, bin } = exportGltfPair(m, o, `${stem}.bin`);
      res = await saveFile({ defaultName: `${stem}.gltf`, filters: filter('glTF', 'gltf'), data: gltf, extras: [{ name: `${stem}.bin`, data: bin }] });
      break;
    }
    case 'obj': {
      const { obj, mtl } = exportOBJ(m, o, stem);
      res = await saveFile({ defaultName: `${stem}.obj`, filters: filter('Wavefront OBJ', 'obj'), data: obj, extras: [{ name: `${stem}.mtl`, data: mtl }] });
      break;
    }
    case 'stl': res = await saveFile({ defaultName: `${stem}.stl`, filters: filter('STL', 'stl'), data: exportSTL(m, o) }); break;
    case 'ply': res = await saveFile({ defaultName: `${stem}.ply`, filters: filter('PLY', 'ply'), data: exportPLY(m, o) }); break;
    case 'ms3d': res = await saveFile({ defaultName: `${stem}.ms3d`, filters: filter('MS3D', 'ms3d'), data: exportMS3D(m, o.scale) }); break;
  }
  if (res) toast(`Exported ${res.name}`, 'ok');
}

export function openShortcuts() {
  const groups: [string, RegExp][] = [
    ['Tools', /^tool\./], ['Selection', /^(select|mode)\./], ['Editing', /^(edit|mesh)\./],
    ['View', /^(view|workspace)\./], ['UV, rig & animation', /^(uv|rig|anim)\./], ['File', /^(file|help)\./],
  ];
  const cols = groups.map(([title, re]) => {
    const rows = [...commands.values()].filter((c) => c.key && c.hint !== 'hidden' && re.test(c.id));
    return h('div', { class: 'keys-col' }, h('h4', null, title),
      rows.map((c) => h('div', { class: 'keys-row' }, h('span', null, c.label), h('kbd', null, c.key!))));
  });
  const nav = h('div', { class: 'keys-col' }, h('h4', null, 'Mouse & navigation'),
    [['Orbit', 'Right drag / Alt+Left'], ['Bank (perspective)', 'Alt+Right'], ['Pan', 'Middle drag / Alt in Top, Front, etc.'], ['Pan along ground (perspective)', 'Shift+Alt+Left'], ['Pan up or down (perspective)', 'Shift+Alt+Right'], ['Zoom', 'Wheel / Ctrl+Alt+Drag'], ['Pan a grid square', 'Arrows'], ['Pan 4 squares / a tenth', 'Shift / Alt+Arrows'], ['Back, Top, Right, Perspective', 'Numpad 1-4'], ['Maximize pane', 'Numpad 0'], ['Add to selection', 'Shift+Click'], ['Remove from selection', 'Ctrl+Drag'], ['Toggle snapping', 'Ctrl during a drag'], ['Finer value scrub', 'Shift while dragging a label']]
      .map(([a, b]) => h('div', { class: 'keys-row' }, h('span', null, a), h('kbd', null, b))));
  void modal('Keyboard shortcuts', h('div', { class: 'keys' }, nav, cols), [{ label: 'Close', primary: true }], { width: 860 });
}

export function openAbout() {
  void modal('About ThickShake', h('div', { class: 'stack about' },
    h('img', { src: './icon.png', width: 72, height: 72, alt: '' }),
    h('p', null, h('strong', null, 'ThickShake 1.0')),
    h('p', null, 'A fast low-poly modeler, rigger and animator for game makers.'),
    h('p', { class: 'muted' }, 'An independent project, not affiliated with chUmbaLum sOft or the MilkShape 3D product. MS3D import and export exist so older work can move across.'),
    h('p', { class: 'muted' }, 'Rendering by Three.js (MIT).'),
  ), [{ label: 'Close', primary: true }], { width: 420 });
}
