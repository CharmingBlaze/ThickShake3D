// Textures as editable pixels, shared by the Paint and Tile workspaces: which texture a face shows, loading it into a
// canvas, showing edits in the views as they happen, and saving them as one undo step.
import { ed } from '../core/editor';
import { cloneModel, makeMaterial, newId, uniqueName, type Material, type Model, type Texture, type V2, type V3 } from '../core/types';
import { triangulateFace } from '../core/geom';
import { remapPixels } from '../core/paint';
import { projectScreen } from '../core/uv';
import { liveTextures } from '../view/materialView';
import { app } from './app';

/** A texture being edited: its pixels, and the canvas views show while it's being painted. */
export interface TexDoc {
  texId: number;
  /** The saved image these pixels came from, or were last saved as. */
  url: string;
  w: number;
  h: number;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: ImageData;
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
  const im = new Image();
  im.onload = () => {
    if (loading.get(t.id) !== t.url) return;
    loading.delete(t.id);
    const canvas = document.createElement('canvas');
    canvas.width = im.naturalWidth; canvas.height = im.naturalHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(im, 0, 0);
    docs.set(t.id, { texId: t.id, url: t.url, w: canvas.width, h: canvas.height, canvas, ctx, img: ctx.getImageData(0, 0, canvas.width, canvas.height) });
    notify();
  };
  im.onerror = () => loading.delete(t.id);
  im.src = t.url;
  return null;
}

/** Show the pixels' latest state on the canvas and in every view, without saving. */
export function pushLive(d: TexDoc) {
  d.ctx.putImageData(d.img, 0, 0);
  liveTextures.set(d.texId, d.canvas);
  app.vp?.sg.showLiveTexture(d.texId);
  notify();
}

/** Save the pixels into the texture as one undo step. */
export function commitDoc(d: TexDoc, label: string) {
  d.ctx.putImageData(d.img, 0, 0);
  const url = d.canvas.toDataURL('image/png');
  d.url = url;
  ed.transact(label, (m) => {
    const t = m.textures.find((x) => x.id === d.texId);
    if (!t) return;
    t.url = url;
    t.rev = (t.rev ?? 0) + 1;
  });
  notify();
}

/**
 * Lay the faces out for painting as a view sees them, and carry their paint across so the model looks the same.
 * One undo step. Other faces on the same texture keep their pixels, unless the new layout lands on them.
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
  const out = new ImageData(new Uint8ClampedArray(d.img.data), d.w, d.h);
  remapPixels(d.img, out, tris);
  d.img = out;
  d.ctx.putImageData(out, 0, 0);
  const url = d.canvas.toDataURL('image/png');
  d.url = url;
  ed.transact('Lay out for painting', (m) => {
    for (const fi of faces) m.faces[fi].uv = after.faces[fi].uv.map((u) => [u[0], u[1]] as V2);
    const t = m.textures.find((x) => x.id === d.texId);
    if (t) { t.url = url; t.rev = (t.rev ?? 0) + 1; }
  });
  pushLive(d);
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
