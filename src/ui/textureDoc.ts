// Textures as editable pixels, shared by the Paint and Tile workspaces: which texture a face shows, loading it into a
// canvas, showing edits in the views as they happen, and saving them as one undo step.
import { ed } from '../core/editor';
import { cloneModel, makeMaterial, newId, uniqueName, type Material, type Model, type TexLayer, type Texture, type V2, type V3 } from '../core/types';
import { triangulateFace } from '../core/geom';
import { remapPixels } from '../core/paint';
import { projectScreen } from '../core/uv';
import { liveTextures } from '../view/materialView';
import { app } from './app';

/** One paint layer: its own pixels, and how it combines with the rest. */
export interface DocLayer {
  name: string;
  opacity: number;
  visible: boolean;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: ImageData;
}

/**
 * A texture being edited: its layers, the one tools paint on, and the combined canvas the views show. `img` is the
 * active layer's pixels, so tools work on that layer.
 */
export interface TexDoc {
  texId: number;
  /** The saved combined image these pixels came from, or were last saved as. */
  url: string;
  w: number;
  h: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  layers: DocLayer[];
  active: number;
  readonly img: ImageData;
}

const docs = new Map<number, TexDoc>();
const loading = new Map<number, string>();
const listeners = new Set<() => void>();

/** Called when a texture finishes loading or its pixels change, for editors to redraw. */
export function onTexturesChanged(fn: () => void) { listeners.add(fn); }
const notify = () => listeners.forEach((fn) => fn());

/** The material a face is drawn with, if any. */
export function materialOfFace(m: Model, fi: number): Material | null {
  const f = m.faces[fi];
  const g = f ? m.groups.find((x) => x.id === f.g) : null;
  return g ? m.materials.find((x) => x.id === g.material) ?? null : null;
}

/** The colour texture a face shows, if any. */
export function textureOfFace(m: Model, fi: number): Texture | null {
  const mat = materialOfFace(m, fi);
  const id = mat?.maps.base;
  return id === undefined ? null : m.textures.find((t) => t.id === id) ?? null;
}

/** The faces an editor panel works on: the selection, or the active group, or everything. */
export function workingFaces(): number[] {
  const sel = ed.selectedFaceSet();
  if (sel.size) return [...sel];
  const out: number[] = [];
  ed.model.faces.forEach((f, i) => { if (f.g === ed.activeGroup) out.push(i); });
  return out.length ? out : [...ed.model.faces.keys()];
}

/** The texture an editor panel works on: the first working face's. */
export function workingTexture(): Texture | null {
  for (const fi of workingFaces()) {
    const t = textureOfFace(ed.model, fi);
    if (t) return t;
  }
  return null;
}

function makeLayer(name: string, w: number, h: number, opacity = 1, visible = true, from?: CanvasImageSource): DocLayer {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  if (from) ctx.drawImage(from, 0, 0);
  return { name, opacity, visible, canvas, ctx, img: ctx.getImageData(0, 0, w, h) };
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
}

/**
 * The editable pixels of a texture. The first ask starts loading them and returns null; listeners hear when they're
 * ready. A texture changed from outside, by undo say, is loaded afresh.
 */
export function texDoc(t: Texture): TexDoc | null {
  const d = docs.get(t.id);
  if (d && d.url === t.url) return d;
  if (d) { docs.delete(t.id); liveTextures.delete(t.id); }
  if (loading.get(t.id) === t.url) return null;
  loading.set(t.id, t.url);
  const sources = t.layers?.length ? t.layers : [{ name: 'Base', url: t.url, opacity: 1, visible: true }];
  Promise.all(sources.map((l) => loadImage(l.url))).then((ims) => {
    if (loading.get(t.id) !== t.url) return;
    loading.delete(t.id);
    const w = ims[0].naturalWidth, h = ims[0].naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const layers = sources.map((l, i) => makeLayer(l.name, w, h, l.opacity, l.visible, ims[i]));
    const doc: TexDoc = {
      texId: t.id, url: t.url, w, h, canvas, ctx, layers, active: layers.length - 1,
      get img() { return this.layers[this.active].img; },
    };
    composite(doc);
    docs.set(t.id, doc);
    notify();
  }).catch(() => loading.delete(t.id));
  return null;
}

/** Combine the visible layers, bottom first, into the canvas views show. */
function composite(d: TexDoc) {
  d.ctx.clearRect(0, 0, d.w, d.h);
  for (const l of d.layers) {
    if (!l.visible || l.opacity <= 0) continue;
    d.ctx.globalAlpha = l.opacity;
    d.ctx.drawImage(l.canvas, 0, 0);
  }
  d.ctx.globalAlpha = 1;
}

/** The combined colour at a pixel, as the views show it: for picking colours. */
export function compositeAt(d: TexDoc, x: number, y: number): [number, number, number, number] | null {
  if (x < 0 || y < 0 || x >= d.w || y >= d.h) return null;
  const p = d.ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data;
  return [p[0], p[1], p[2], p[3]];
}

/** Show the active layer's latest pixels in the combined canvas and every view, without saving. */
export function pushLive(d: TexDoc) {
  const l = d.layers[d.active];
  l.ctx.putImageData(l.img, 0, 0);
  composite(d);
  liveTextures.set(d.texId, d.canvas);
  app.vp?.sg.showLiveTexture(d.texId);
  notify();
}

/**
 * Save the pixels into the texture as one undo step: the combined image, and the layers when there's more than one.
 * `extra` makes other changes in the same step.
 */
export function commitDoc(d: TexDoc, label: string, extra?: (m: Model) => void) {
  for (const l of d.layers) l.ctx.putImageData(l.img, 0, 0);
  composite(d);
  const url = d.canvas.toDataURL('image/png');
  const single = d.layers.length === 1 && d.layers[0].visible && d.layers[0].opacity === 1;
  const layers: TexLayer[] | undefined = single ? undefined : d.layers.map((l) => ({ name: l.name, url: l.canvas.toDataURL('image/png'), opacity: l.opacity, visible: l.visible }));
  d.url = url;
  ed.transact(label, (m) => {
    const t = m.textures.find((x) => x.id === d.texId);
    if (!t) return;
    t.url = url;
    t.rev = (t.rev ?? 0) + 1;
    if (layers) t.layers = layers; else delete t.layers;
    extra?.(m);
  });
  liveTextures.set(d.texId, d.canvas);
  app.vp?.sg.showLiveTexture(d.texId);
  notify();
}

// ---------- layers ----------
export function addLayer(d: TexDoc) {
  const names = d.layers.map((l) => l.name);
  let n = d.layers.length + 1;
  while (names.includes(`Layer ${n}`)) n++;
  d.layers.splice(d.active + 1, 0, makeLayer(`Layer ${n}`, d.w, d.h));
  d.active++;
  commitDoc(d, 'New layer');
}

export function deleteLayer(d: TexDoc) {
  if (d.layers.length < 2) return;
  d.layers.splice(d.active, 1);
  d.active = Math.min(d.active, d.layers.length - 1);
  commitDoc(d, 'Delete layer');
}

/** Move the active layer up (toward the top) or down. */
export function moveLayer(d: TexDoc, by: 1 | -1) {
  const to = d.active + by;
  if (to < 0 || to >= d.layers.length) return;
  [d.layers[d.active], d.layers[to]] = [d.layers[to], d.layers[d.active]];
  d.active = to;
  commitDoc(d, by > 0 ? 'Raise layer' : 'Lower layer');
}

/** Paint the active layer onto the one below it, at its opacity, and remove it. */
export function mergeDown(d: TexDoc) {
  if (d.active < 1) return;
  const top = d.layers[d.active], below = d.layers[d.active - 1];
  top.ctx.putImageData(top.img, 0, 0);
  below.ctx.putImageData(below.img, 0, 0);
  if (top.visible) { below.ctx.globalAlpha = top.opacity; below.ctx.drawImage(top.canvas, 0, 0); below.ctx.globalAlpha = 1; }
  below.img = below.ctx.getImageData(0, 0, d.w, d.h);
  d.layers.splice(d.active, 1);
  d.active--;
  commitDoc(d, 'Merge layer down');
}

export function setLayer(d: TexDoc, i: number, change: Partial<Pick<DocLayer, 'opacity' | 'visible' | 'name'>>) {
  Object.assign(d.layers[i], change);
  commitDoc(d, change.name !== undefined ? 'Rename layer' : change.visible !== undefined ? (change.visible ? 'Show layer' : 'Hide layer') : 'Layer opacity');
}

/**
 * Lay the faces out for painting as a view sees them, and carry their paint across, on every layer, so the model
 * looks the same. One undo step. Other faces on the same texture keep their pixels, unless the new layout lands on them.
 */
export function layoutForPainting(d: TexDoc, faces: number[], right: V3, up: V3) {
  const before = cloneModel(ed.model);
  const after = cloneModel(ed.model);
  projectScreen(after, faces, right, up);
  const tris: { from: [V2, V2, V2]; to: [V2, V2, V2] }[] = [];
  for (const fi of faces) {
    const t = triangulateFace(before, before.faces[fi]);
    for (let i = 0; i < t.length; i += 3) {
      const c = [t[i], t[i + 1], t[i + 2]];
      tris.push({ from: c.map((k) => before.faces[fi].uv[k]) as [V2, V2, V2], to: c.map((k) => after.faces[fi].uv[k]) as [V2, V2, V2] });
    }
  }
  for (const l of d.layers) {
    const out = new ImageData(new Uint8ClampedArray(l.img.data), d.w, d.h);
    remapPixels(l.img, out, tris);
    l.img = out;
  }
  commitDoc(d, 'Lay out for painting', (m) => {
    for (const fi of faces) m.faces[fi].uv = after.faces[fi].uv.map((u) => [u[0], u[1]] as V2);
  });
}

/** Throw away unsaved pixel edits, going back to the saved image. */
export function revertDoc(d: TexDoc) {
  docs.delete(d.texId);
  liveTextures.delete(d.texId);
  notify();
}

/**
 * Give the groups of these faces a texture of their own to paint on, size × size, filled with the material's colour
 * (or `fill`). Groups without a material get one. Small textures start as pixel art.
 */
export function createTexture(faces: number[], size: number, opts: { name?: string; fill?: string; transparent?: boolean } = {}): number | null {
  if (!faces.length) return null;
  let made: number | null = null;
  ed.transact('New texture', (m) => {
    const groups = [...new Set(faces.map((fi) => m.faces[fi]?.g).filter((g): g is number => g !== undefined))];
    const first = m.groups.find((g) => g.id === groups[0]);
    let mat = first ? m.materials.find((x) => x.id === first.material) ?? null : null;
    if (!mat) {
      mat = makeMaterial(m, uniqueName(m.materials.map((x) => x.name), `${first?.name ?? 'Painted'} material`));
    }
    for (const gid of groups) { const g = m.groups.find((x) => x.id === gid); if (g) g.material = mat.id; }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d')!;
    if (!opts.transparent) { ctx.fillStyle = opts.fill ?? mat.color; ctx.fillRect(0, 0, size, size); }
    const id = newId(m);
    m.textures.push({ id, name: opts.name ?? `${mat.name} paint`, url: c.toDataURL('image/png'), width: size, height: size, ...(size <= 256 ? { pixelated: true } : {}) });
    mat.maps.base = id;
    // The texture now carries the colour; a white tint shows it as painted.
    mat.color = '#ffffff';
    made = id;
  });
  return made;
}

/** Turn pixel art (sharp, unblended pixels) on or off for a texture. */
export function setPixelated(texId: number, on: boolean) {
  ed.transact(on ? 'Pixel art on' : 'Pixel art off', (m) => {
    const t = m.textures.find((x) => x.id === texId);
    if (t) t.pixelated = on || undefined;
  });
}

// A texture changed by undo or any other edit: drop stale pixels, so they reload from the saved image.
ed.on('history', () => {
  for (const [id, d] of docs) {
    const t = ed.model.textures.find((x) => x.id === id);
    if (!t || t.url !== d.url) { docs.delete(id); liveTextures.delete(id); }
  }
  notify();
});
