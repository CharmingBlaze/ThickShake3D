// Export, shortcuts and about dialogs.
import { BUDGETS, runChecks } from '../core/checks';
import { ed } from '../core/editor';
import { defaultExport, exportGLB, exportGltfPair, type ExportOptions } from '../io/gltf';
import { exportMS3D } from '../io/ms3d';
import { saveFile } from '../io/platform';
import { exportOBJ, exportPLY, exportSTL } from '../io/simple';
import { commands } from './commands';
import { cloneModel, type Model } from '../core/types';
import { button, checkbox, h, numField, select } from './dom';
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

/** Export settings ready for a target: an engine, the web, printing. */
interface ExportPreset { name: string; format: Format; options: ExportOptions; note?: string }
const BUILT_IN: ExportPreset[] = [
  { name: 'Godot 4', format: 'glb', options: { ...defaultExport }, note: 'Drop the GLB into the project; Godot imports meshes, materials, skeleton and animations.' },
  { name: 'Unity (glTFast)', format: 'glb', options: { ...defaultExport }, note: 'Needs the glTFast package. Metres in, metres out.' },
  { name: 'Unreal Engine 5', format: 'glb', options: { ...defaultExport }, note: 'Import with Interchange; it turns metres into centimetres itself. Collision parts come through as UCX_ colliders.' },
  { name: 'Roblox', format: 'glb', options: { ...defaultExport, includeLods: false, includeCollision: false, maxTexture: 1024 }, note: 'Import with the 3D Importer. Textures are kept to 1024, Roblox\'s limit.' },
  { name: 'Web (three.js, Babylon)', format: 'glb', options: { ...defaultExport, includeLods: false, includeCollision: false, onlyVisible: true, maxTexture: 1024 }, note: 'Small and quick to load: no LODs or colliders, textures kept to 1024.' },
  { name: 'Sketchfab', format: 'glb', options: { ...defaultExport, includeLods: false, includeCollision: false, onlyVisible: true }, note: 'Just what you see, with its animations, for showing off.' },
  { name: 'Mobile', format: 'glb', options: { ...defaultExport, includeCollision: false, maxTexture: 512 }, note: 'Textures kept to 512 to save memory; LODs included.' },
  { name: '3D printing', format: 'stl', options: { ...defaultExport, skeleton: false, animations: false, includeLods: false, includeCollision: false, onlyVisible: true, scale: 1000 }, note: 'STL in millimetres: 1 metre in ThickShake prints as 1000 mm.' },
  { name: 'Older engines (MS3D)', format: 'ms3d', options: { ...defaultExport, includeLods: false, includeCollision: false }, note: 'MilkShape 3D format for older tools: triangles, the first clip, simple materials.' },
];

// Your own presets last between sessions.
const PRESET_KEY = 'thickshake.exportPresets';
function savedPresets(): ExportPreset[] {
  try { return JSON.parse(localStorage.getItem(PRESET_KEY) ?? '[]') ?? []; } catch { return []; }
}
function storePresets(list: ExportPreset[]) {
  try { localStorage.setItem(PRESET_KEY, JSON.stringify(list)); } catch { /* storage may be off */ }
}
let lastPreset = '';

export function openExportDialog() {
  if (!ed.model.faces.length) { toast('Nothing to export yet. Add some geometry first.', 'info'); return; }
  const noteEl = h('p', { class: 'muted' });
  const presetNote = h('p', { class: 'muted small' });
  const opts = h('div', { class: 'stack' });
  const formatSel = h('span', {});
  const drawFormat = () => formatSel.replaceChildren(select<Format>(lastFormat, FORMATS.map((f) => [f.id, f.label]), (v) => { lastFormat = v; changed(); refreshNote(); }));
  // Changing a setting by hand leaves the preset behind.
  const changed = () => { lastPreset = ''; drawPresets(); };
  const presetRow = h('div', { class: 'form-row' });
  const drawPresets = () => {
    const mine = savedPresets();
    const all = [...BUILT_IN, ...mine];
    const p = all.find((x) => x.name === lastPreset);
    presetNote.textContent = p?.note ?? '';
    presetRow.replaceChildren(
      'Preset',
      select<string>(lastPreset, [['', 'Custom'], ...BUILT_IN.map((x) => [x.name, x.name] as [string, string]), ...mine.map((x) => [x.name, `${x.name} (yours)`] as [string, string])], (v) => {
        lastPreset = v;
        const chosen = all.find((x) => x.name === v);
        if (chosen) { lastFormat = chosen.format; Object.assign(options, defaultExport, chosen.options); }
        drawFormat(); drawPresets(); refreshNote();
      }, 'Settings ready for an engine or use'),
      button('Save…', () => {
        const name = prompt('Name this preset', lastPreset && !BUILT_IN.some((x) => x.name === lastPreset) ? lastPreset : 'My preset')?.trim();
        if (!name) return;
        if (BUILT_IN.some((x) => x.name === name)) { toast('That name is taken by a built-in preset.', 'info'); return; }
        storePresets([...mine.filter((x) => x.name !== name), { name, format: lastFormat, options: { ...options } }]);
        lastPreset = name;
        drawPresets();
      }, { class: 'btn btn-small', title: 'Keep these settings as a preset of your own' }),
      mine.some((x) => x.name === lastPreset) ? button('Delete', () => { storePresets(mine.filter((x) => x.name !== lastPreset)); lastPreset = ''; drawPresets(); }, { class: 'btn btn-small' }) : '',
    );
  };
  const refreshNote = () => { noteEl.textContent = FORMATS.find((f) => f.id === lastFormat)!.note; drawOptions(); };
  const drawOptions = () => {
    const animated = lastFormat === 'glb' || lastFormat === 'gltf';
    opts.replaceChildren(
      numField({ label: 'Scale', value: options.scale, step: 0.01, min: 0.0001, max: 10000, digits: 4, onChange: (v) => { options.scale = v; changed(); }, title: '1 unit in ThickShake = 1 metre. Most engines expect metres in glTF.' }),
      lastFormat === 'glb' || lastFormat === 'gltf' || lastFormat === 'obj'
        ? h('label', { class: 'form-row' }, 'Largest texture', select<number>(options.maxTexture ?? 0, [[0, 'As they are'], [256, '256'], [512, '512'], [1024, '1024'], [2048, '2048'], [4096, '4096']], (v) => { options.maxTexture = v; changed(); }, 'Shrink bigger textures to this size as they\'re written. The project keeps the originals.'))
        : '',
      h('div', { class: 'check-grid' },
        animated ? checkbox('Skeleton', options.skeleton, (v) => { options.skeleton = v; changed(); }) : null,
        animated ? checkbox('Animations', options.animations, (v) => { options.animations = v; changed(); }) : null,
        lastFormat !== 'stl' && lastFormat !== 'ply' && lastFormat !== 'ms3d' ? checkbox('LOD meshes', options.includeLods, (v) => { options.includeLods = v; changed(); }) : null,
        lastFormat !== 'stl' && lastFormat !== 'ply' && lastFormat !== 'ms3d' ? checkbox('Collision meshes', options.includeCollision, (v) => { options.includeCollision = v; changed(); }) : null,
        checkbox('Visible groups only', options.onlyVisible, (v) => { options.onlyVisible = v; changed(); }),
      ),
    );
  };

  // Preflight against the mid-range budget so real problems surface before export.
  const issues = runChecks(ed.model, BUDGETS[2]).filter((c) => c.severity === 'error' || c.severity === 'warn');
  const preflight = issues.length
    ? h('div', { class: 'preflight warn' }, h('strong', null, `${issues.length} thing${issues.length > 1 ? 's' : ''} to check`), h('ul', null, issues.slice(0, 5).map((i) => h('li', null, `${i.label}: ${i.value}`))))
    : h('div', { class: 'preflight ok' }, 'No problems found. This model is ready to export.');

  const body = h('div', { class: 'stack' },
    presetRow, presetNote,
    h('label', { class: 'form-row' }, 'Format', formatSel),
    noteEl, opts, preflight);
  drawFormat();
  drawPresets();
  refreshNote();

  void modal('Export model', body, [
    { label: 'Cancel', value: false },
    { label: 'Export', primary: true, run: async () => {
      try { await doExport(lastFormat, options); } catch (e) { reportError('Export failed', e); return false; }
      return true;
    } },
  ], { width: 480 });
}

/**
 * A copy of the model with textures over `max` pixels across shrunk to fit, keeping their shape. Pixel art shrinks
 * with sharp pixels.
 */
export async function limitTextures(src: Model, max: number): Promise<Model> {
  if (!max || !src.textures.some((t) => Math.max(t.width, t.height) > max)) return src;
  const m = cloneModel(src);
  for (const t of m.textures) {
    if (Math.max(t.width, t.height) <= max) continue;
    const im = await new Promise<HTMLImageElement>((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = t.url; });
    const k = max / Math.max(t.width, t.height);
    const w = Math.max(1, Math.round(t.width * k)), hh = Math.max(1, Math.round(t.height * k));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = hh;
    const g = cv.getContext('2d')!;
    g.imageSmoothingEnabled = !t.pixelated;
    g.imageSmoothingQuality = 'high';
    g.drawImage(im, 0, 0, w, hh);
    Object.assign(t, { url: cv.toDataURL('image/png'), width: w, height: hh });
    delete t.layers;
  }
  return m;
}

export async function doExport(format: Format, o: ExportOptions) {
  const m = await limitTextures(ed.model, o.maxTexture ?? 0);
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
