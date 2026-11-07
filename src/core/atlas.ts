// Texture atlases: pack several images into one, so a model draws with one material, and move UVs to match.
import type { V2 } from './types';

export interface PackedRect { x: number; y: number; w: number; h: number }

/**
 * Pack rectangles into the smallest power-of-two square-ish image that holds them, tallest first along shelves,
 * with `pad` pixels around each. Returns where each goes, in the order given, and the image size.
 */
export function packRects(sizes: { w: number; h: number }[], pad: number, maxSize = 8192): { rects: PackedRect[]; width: number; height: number } | null {
  const order = sizes.map((s, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w);
  const area = sizes.reduce((s, r) => s + (r.w + pad * 2) * (r.h + pad * 2), 0);
  const widest = Math.max(1, ...sizes.map((s) => s.w + pad * 2));
  let width = 1;
  while (width < Math.max(widest, Math.sqrt(area))) width *= 2;
  for (; width <= maxSize; width *= 2) {
    const rects: PackedRect[] = new Array(sizes.length);
    let x = 0, y = 0, shelf = 0;
    for (const i of order) {
      const w = sizes[i].w + pad * 2, h = sizes[i].h + pad * 2;
      if (x + w > width) { x = 0; y += shelf; shelf = 0; }
      rects[i] = { x: x + pad, y: y + pad, w: sizes[i].w, h: sizes[i].h };
      x += w;
      shelf = Math.max(shelf, h);
    }
    const used = y + shelf;
    let height = 1;
    while (height < used) height *= 2;
    // Prefer a square-ish result: a strip twice as tall as it is wide means the next width packs better.
    if (height <= maxSize && height <= width * 2) return { rects, width, height };
  }
  return null;
}

/**
 * Move a face's UVs into its image's place in the atlas. UVs a little past 0..1 as a whole face are shifted back by
 * whole tiles first; anything still outside is clamped, since an atlas can't repeat one image. Returns whether
 * clamping was needed.
 */
export function remapIntoAtlas(uv: V2[], r: PackedRect, width: number, height: number): { uv: V2[]; clamped: boolean } {
  const minU = Math.min(...uv.map((u) => u[0])), minV = Math.min(...uv.map((u) => u[1]));
  const su = Math.floor(minU + 1e-6), sv = Math.floor(minV + 1e-6);
  let clamped = false;
  const out = uv.map(([u, v]): V2 => {
    let a = u - su, b = v - sv;
    if (a < -1e-6 || a > 1 + 1e-6 || b < -1e-6 || b > 1 + 1e-6) clamped = true;
    a = Math.min(1, Math.max(0, a)); b = Math.min(1, Math.max(0, b));
    return [(r.x + a * r.w) / width, (r.y + b * r.h) / height];
  });
  return { uv: out, clamped };
}
