// Game-ready texture tools: bake ambient occlusion and normal maps, and pack materials into one texture atlas.
import { packRects, remapIntoAtlas } from '../core/atlas';
import { bakeAO, bakeNormals, buildBvh, dilate, sampleSurface, type BakeMesh } from '../core/bake';
import { ed } from '../core/editor';
import { bounds } from '../core/geom';
import { packChannel, blankOrm } from '../core/materials';
import { makeMaterial, newId, uniqueName, type Group, type Material, type Model, type V3 } from '../core/types';
import { buildExportMesh, computeTangents, type ExportMesh } from '../io/gltf';
import { checkbox, h, numField, select } from './dom';
import { modal, reportError, status, toast } from './feedback';

// ---------- images ----------
function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}

function pixelsOf(im: CanvasImageSource, w: number, hh: number): Uint8ClampedArray {
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(im, 0, 0, w, hh);
  return g.getImageData(0, 0, w, hh).data;
}

function toUrl(rgba: Uint8ClampedArray, w: number, hh: number): string {
  const c = document.createElement('canvas');
  c.width = w; c.height = hh;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, hh), 0, 0);
  return c.toDataURL('image/png');
}

/** Give way to the browser now and then, so a long job keeps the window responsive and can show progress. */
const nextFrame = () => new Promise<void>((r) => setTimeout(r, 0));

async function drive<T>(g: Generator<number, T>, label: string): Promise<T> {
  let t0 = performance.now();
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
    if (performance.now() - t0 > 40) {
      status(`${label}… ${Math.round(r.value * 100)}%`);
      await nextFrame();
      t0 = performance.now();
    }
  }
}

// ---------- baking ----------
const meshGroups = (m: Model) => m.groups.filter((g) => g.kind === 'mesh' && m.faces.some((f) => f.g === g.id));

const asBake = (em: ExportMesh): BakeMesh => em;

/** Several groups as one mesh, for rays to hit. */
function mergeMeshes(list: ExportMesh[]): { positions: number[]; normals: number[]; indices: number[] } {
  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[] };
  for (const em of list) {
    const base = out.positions.length / 3;
    out.positions.push(...em.positions);
    out.normals.push(...em.normals);
    for (const i of em.indices) out.indices.push(i + base);
  }
  return out;
}

type BakeKind = 'ao' | 'normal';
type AoOut = 'orm' | 'color';
const bakeSettings = { kind: 'ao' as BakeKind, size: 512, samples: 32, distance: 0, aoOut: 'orm' as AoOut, shadowsFromOthers: true, source: -1, target: -1, gap: 0 };

/** The dialog for baking ambient occlusion, or normals from a detailed part, into the target part's material. */
export function openBakeDialog() {
  const m = ed.model;
  const groups = meshGroups(m);
  if (!groups.length) { toast('Nothing to bake yet. Add a model first.', 'info'); return; }
  const P = m.verts.map((v) => v.p);
  const b = bounds(P.length ? P : [[0, 0, 0] as V3]);
  const size = Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) || 1;
  const s = bakeSettings;
  if (!groups.some((g) => g.id === s.target)) s.target = groups.find((g) => g.id === ed.activeGroup)?.id ?? groups[0].id;
  if (!groups.some((g) => g.id === s.source) || s.source === s.target) s.source = groups.find((g) => g.id !== s.target)?.id ?? -1;
  if (!s.distance) s.distance = +(size * 0.25).toFixed(3);
  if (!s.gap) s.gap = +(size * 0.03).toFixed(3);
  const opts = h('div', { class: 'stack' });
  const note = h('p', { class: 'muted' });
  const groupList = groups.map((g) => [g.id, g.name] as [number, string]);
  const draw = () => {
    const rows: (HTMLElement | null)[] = [
      h('label', { class: 'form-row' }, 'Bake onto', select<number>(s.target, groupList, (v) => { s.target = v; draw(); }, 'The part whose texture layout the bake goes into')),
    ];
    if (s.kind === 'normal') {
      rows.push(h('label', { class: 'form-row' }, 'Detail from', select<number>(s.source, [[-1, 'Choose a part'], ...groupList.filter(([id]) => id !== s.target)], (v) => { s.source = v; }, 'The detailed part whose shape the normals come from')));
      rows.push(numField({ label: 'Search distance', value: s.gap, min: 0.0001, max: 1000, step: 0.001, digits: 4, title: 'How far from the target\'s surface, in and out, to look for the detailed part. A little more than the biggest gap between them.', onChange: (v) => { s.gap = v; } }));
    } else {
      rows.push(numField({ label: 'Rays per texel', value: s.samples, min: 4, max: 256, step: 1, digits: 0, title: 'More is smoother, and slower', onChange: (v) => { s.samples = Math.round(v); } }));
      rows.push(numField({ label: 'Reach', value: s.distance, min: 0.0001, max: 1000, step: 0.01, digits: 3, title: 'How far away something can be and still shade a surface', onChange: (v) => { s.distance = v; } }));
      rows.push(checkbox('Other parts cast shade', s.shadowsFromOthers, (v) => { s.shadowsFromOthers = v; }, 'Shade from every visible part, not just the target'));
      rows.push(h('label', { class: 'form-row' }, 'Put it in', select<AoOut>(s.aoOut, [['orm', 'The occlusion map'], ['color', 'The colour']], (v) => { s.aoOut = v; }, 'An occlusion map engines apply to ambient light; or darken the colour itself, for unlit and stylised looks')));
    }
    rows.push(h('label', { class: 'form-row' }, 'Size', select<number>(s.size, [128, 256, 512, 1024, 2048].map((x) => [x, `${x}×${x}`] as [number, string]), (v) => { s.size = v; })));
    opts.replaceChildren(...rows.filter((x): x is HTMLElement => !!x));
    note.textContent = s.kind === 'ao'
      ? 'Shades creases and corners where light reaches less. The target needs a UV layout without overlaps.'
      : 'Gives the target the look of the detailed part\'s surface. The two should line up; the target needs a UV layout without overlaps.';
  };
  draw();
  const body = h('div', { class: 'stack' },
    h('label', { class: 'form-row' }, 'Bake', select<BakeKind>(s.kind, [['ao', 'Ambient occlusion'], ['normal', 'Normals from a detailed part']], (v) => { s.kind = v; draw(); })),
    note, opts);
  void modal('Bake', body, [
    { label: 'Cancel', value: false },
    { label: 'Bake', primary: true, run: () => {
      if (s.kind === 'normal' && s.source < 0) { toast('Choose the detailed part to bake from.', 'info'); return false; }
      void runBake().catch((e) => reportError('Baking failed', e));
      return true;
    } },
  ], { width: 460 });
}

async function runBake() {
  const s = bakeSettings;
  const m = ed.model;
  const target = m.groups.find((g) => g.id === s.target);
  if (!target) return;
  const mat = m.materials.find((x) => x.id === target.material);
  if (!mat) { toast(`${target.name} has no material to bake into. Give it one in the Material panel.`, 'info'); return; }
  const low = buildExportMesh(m, target, 1, null);
  if (!low) return;
  const W = s.size, H = s.size;
  const samples = sampleSurface(asBake(low), W, H);
  let rgba: Uint8ClampedArray;
  if (s.kind === 'ao') {
    const parts = s.shadowsFromOthers ? meshGroups(m).filter((g) => g.visible || g.id === target.id) : [target];
    const scene = buildBvh(mergeMeshes(parts.map((g) => buildExportMesh(m, g, 1, null)).filter((x): x is ExportMesh => !!x)));
    const ao = await drive(bakeAO(samples, scene, { samples: s.samples, distance: s.distance }), 'Baking ambient occlusion');
    rgba = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) { const v = Math.round(ao[i] * 255); rgba.set([v, v, v, samples.mask[i] ? 255 : 0], i * 4); }
  } else {
    const src = m.groups.find((g) => g.id === s.source);
    const high = src && buildExportMesh(m, src, 1, null);
    if (!high) { toast('The detailed part has no faces.', 'info'); return; }
    const res = await drive(bakeNormals(asBake(low), samples, computeTangents(low), buildBvh(high), high.normals, { distance: s.gap }), 'Baking normals');
    rgba = res.rgba;
    const covered = samples.mask.reduce((a, x) => a + x, 0);
    if (covered && res.found < covered * 0.5) toast(`Only ${Math.round((res.found / covered) * 100)}% of the surface found the detailed part. Try a larger search distance, or check the two line up.`, 'warn');
  }
  dilate(rgba, samples.mask, W, H, 8);
  for (let i = 0; i < W * H; i++) rgba[i * 4 + 3] = 255;
  await writeBake(mat, rgba, W, H, target);
}

/** Put a finished bake into the material, as one undo step. */
async function writeBake(mat: Material, rgba: Uint8ClampedArray, W: number, H: number, target: Group) {
  const s = bakeSettings;
  const m = ed.model;
  const texOf = (id: number | undefined) => (id === undefined ? undefined : m.textures.find((t) => t.id === id));
  let slot: 'normal' | 'orm' | 'base';
  let pixels = rgba;
  let label: string;
  let after: ((t: Material) => void) | undefined;
  if (s.kind === 'normal') { slot = 'normal'; label = 'Bake normals'; }
  else if (s.aoOut === 'orm') {
    slot = 'orm'; label = 'Bake ambient occlusion';
    const cur = texOf(mat.maps.orm);
    const orm = cur ? pixelsOf(await loadImage(cur.url), W, H) : blankOrm(W, H, mat.roughness, mat.metallic);
    pixels = packChannel(new Uint8ClampedArray(orm), rgba, 'occlusion');
    // The map now holds roughness and metalness too, and the sliders multiply it.
    if (!cur) after = (t) => { t.roughness = 1; t.metallic = 1; };
  } else {
    slot = 'base'; label = 'Bake ambient occlusion into colour';
    const cur = texOf(mat.maps.base);
    const base = cur ? pixelsOf(await loadImage(cur.url), W, H) : null;
    const tint = parseInt(mat.color.slice(1), 16);
    const col = [(tint >> 16) & 255, (tint >> 8) & 255, tint & 255];
    pixels = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const k = rgba[i * 4] / 255;
      for (let c = 0; c < 3; c++) pixels[i * 4 + c] = (base ? base[i * 4 + c] : col[c]) * k;
      pixels[i * 4 + 3] = base ? base[i * 4 + 3] : 255;
    }
    // The colour is in the texture now.
    after = (t) => { t.color = '#ffffff'; };
  }
  const url = toUrl(pixels, W, H);
  ed.transact(label, (d) => {
    const id = newId(d);
    d.textures.push({ id, name: uniqueName(d.textures.map((x) => x.name), `${target.name} ${slot === 'normal' ? 'normals' : slot === 'orm' ? 'ORM' : 'colour'}`), url, width: W, height: H });
    const t = d.materials.find((x) => x.id === mat.id)!;
    t.maps[slot] = id;
    after?.(t);
  });
  ed.emit('materials');
  status(`${label}: done, ${W}×${H}, into ${mat.name}.`);
  toast(`${label} finished.`, 'ok');
}

// ---------- texture atlas ----------
/**
 * Pack the colour textures of every visible part's material into one atlas, with plain-coloured materials as small
 * swatches, and draw everything with one new material. One undo step.
 */
export async function makeAtlas() {
  const m = ed.model;
  const groups = meshGroups(m).filter((g) => g.visible && g.material !== null);
  const mats = [...new Set(groups.map((g) => g.material!))].map((id) => m.materials.find((x) => x.id === id)).filter((x): x is Material => !!x);
  if (mats.length < 2) { toast('Atlasing needs parts with at least two different materials.', 'info'); return; }
  status('Packing textures…');
  const SWATCH = 8;
  const items = await Promise.all(mats.map(async (mat) => {
    const t = mat.maps.base !== undefined ? m.textures.find((x) => x.id === mat.maps.base) : undefined;
    if (!t) return { mat, img: null as HTMLImageElement | null, w: SWATCH, h: SWATCH, pixelated: false };
    const img = await loadImage(t.url);
    return { mat, img, w: img.naturalWidth, h: img.naturalHeight, pixelated: !!t.pixelated };
  }));
  const PAD = 4;
  const packed = packRects(items, PAD);
  if (!packed) { toast('Those textures are too big to fit in one 8192×8192 atlas. Make some smaller first.', 'warn'); return; }
  const { width, height, rects } = packed;
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const g = cv.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  items.forEach((it, i) => {
    const r = rects[i];
    if (it.img) {
      // Textured materials are tinted by their colour: bake that in, keeping the image's own transparency.
      let src: CanvasImageSource = it.img;
      if (it.mat.color.toLowerCase() !== '#ffffff') {
        const t = document.createElement('canvas');
        t.width = it.w; t.height = it.h;
        const tg = t.getContext('2d')!;
        tg.drawImage(it.img, 0, 0);
        tg.globalCompositeOperation = 'multiply';
        tg.fillStyle = it.mat.color;
        tg.fillRect(0, 0, it.w, it.h);
        tg.globalCompositeOperation = 'destination-in';
        tg.drawImage(it.img, 0, 0);
        src = t;
      }
      // The image, then its edges pulled out into the padding, so filtering never reaches a neighbour.
      g.drawImage(src, r.x, r.y, r.w, r.h);
      g.drawImage(src, 0, 0, it.w, 1, r.x, r.y - PAD, r.w, PAD);
      g.drawImage(src, 0, it.h - 1, it.w, 1, r.x, r.y + r.h, r.w, PAD);
      g.drawImage(cv, r.x, r.y - PAD, 1, r.h + PAD * 2, r.x - PAD, r.y - PAD, PAD, r.h + PAD * 2);
      g.drawImage(cv, r.x + r.w - 1, r.y - PAD, 1, r.h + PAD * 2, r.x + r.w, r.y - PAD, PAD, r.h + PAD * 2);
    } else {
      // A plain material's colour.
      g.fillStyle = it.mat.color;
      g.fillRect(r.x - PAD, r.y - PAD, r.w + PAD * 2, r.h + PAD * 2);
    }
  });
  const url = cv.toDataURL('image/png');
  const lost = mats.filter((x) => x.maps.normal !== undefined || x.maps.orm !== undefined || x.maps.emissive !== undefined).length;
  let clamped = 0;
  ed.transact('Texture atlas', (d) => {
    const texId = newId(d);
    d.textures.push({ id: texId, name: uniqueName(d.textures.map((x) => x.name), 'Atlas'), url, width, height, pixelated: items.every((x) => !x.img || x.pixelated) && items.some((x) => x.img) });
    const first = mats[0];
    const atlas = makeMaterial(d, uniqueName(d.materials.map((x) => x.name), 'Atlas material'), '#ffffff');
    Object.assign(atlas, { metallic: first.metallic, roughness: first.roughness, doubleSided: mats.some((x) => x.doubleSided), alphaMode: mats.some((x) => x.alphaMode !== 'opaque') ? 'mask' : 'opaque' });
    atlas.maps.base = texId;
    const where = new Map(mats.map((mat, i) => [mat.id, { r: rects[i], textured: !!items[i].img }]));
    for (const grp of d.groups) {
      const w = grp.material !== null ? where.get(grp.material) : undefined;
      if (!w || !groups.some((x) => x.id === grp.id)) continue;
      for (const f of d.faces) {
        if (f.g !== grp.id) continue;
        if (w.textured) {
          const res = remapIntoAtlas(f.uv, w.r, width, height);
          f.uv = res.uv;
          if (res.clamped) clamped++;
        } else {
          // A plain colour: every corner on its swatch.
          f.uv = f.uv.map(() => [(w.r.x + w.r.w / 2) / width, (w.r.y + w.r.h / 2) / height]);
        }
      }
      grp.material = atlas.id;
    }
  });
  ed.emit('materials', 'groups', 'topology');
  const notes = [
    `Packed ${mats.length} materials into one ${width}×${height} atlas.`,
    clamped ? `${clamped} face${clamped === 1 ? '' : 's'} repeated a texture and had to be squeezed in.` : '',
    lost ? 'Normal, ORM and glow maps aren\'t carried over.' : '',
  ].filter(Boolean).join(' ');
  status(notes);
  toast(notes, clamped || lost ? 'warn' : 'ok');
}
