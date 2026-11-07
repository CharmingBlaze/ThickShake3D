// Painting on texture pixels: hard pixel brushes for pixel art, soft brushes, lines, rectangles, flood fill and
// colour picking. Works on plain RGBA pixel buffers, so it runs anywhere and is easy to test; the editor copies
// them to and from canvases.
import { triangulateFace } from './geom';
import type { Model, V2 } from './types';

export interface Pixels { width: number; height: number; data: Uint8ClampedArray }
export type RGBA = [number, number, number, number];

export function hexToRgba(hex: string, alpha = 255): RGBA {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

export function rgbaToHex(c: RGBA): string {
  return `#${[c[0], c[1], c[2]].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function getPixel(img: Pixels, x: number, y: number): RGBA | null {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

/** Blend a colour onto one pixel. `amount` 0..1 scales the colour's own alpha; erasing removes alpha instead. */
export function blendPixel(img: Pixels, x: number, y: number, c: RGBA, amount = 1, erase = false) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height || amount <= 0) return;
  const i = (y * img.width + x) * 4;
  const d = img.data;
  if (erase) { d[i + 3] = Math.round(d[i + 3] * (1 - Math.min(1, amount))); return; }
  const a = (c[3] / 255) * Math.min(1, amount);
  if (a >= 1) { d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; return; }
  // Source over, so soft edges and see-through paint layer onto what's there.
  const da = d[i + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) return;
  for (let k = 0; k < 3; k++) d[i + k] = Math.round((c[k] * a + d[i + k] * da * (1 - a)) / oa);
  d[i + 3] = Math.round(oa * 255);
}

export interface Brush {
  /** Width in pixels. */
  size: number;
  /** Pixel art: square or round, every pixel fully on or off. Soft: a round brush with a feathered edge. */
  shape: 'square' | 'round' | 'soft';
  /** 0..1, how much of the colour goes down in one stroke. */
  opacity: number;
  /** Soft brushes: 0 is all feather, 1 is a hard edge. */
  hardness: number;
  erase: boolean;
}

/**
 * The pixels one dab of a brush covers, centred on (cx, cy), with how strongly each is covered. Pixel brushes cover
 * whole pixels, so an even size sits on the pixel corner toward the top left, as in pixel art editors.
 */
export function brushFootprint(cx: number, cy: number, b: Brush): { x: number; y: number; w: number }[] {
  const out: { x: number; y: number; w: number }[] = [];
  const size = Math.max(1, b.size);
  if (b.shape !== 'soft') {
    const x0 = Math.floor(cx - size / 2 + 0.5), y0 = Math.floor(cy - size / 2 + 0.5);
    const r = size / 2;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (b.shape === 'round' && size > 2) {
        const dx = x + 0.5 - r, dy = y + 0.5 - r;
        if (dx * dx + dy * dy > r * r) continue;
      }
      out.push({ x: x0 + x, y: y0 + y, w: 1 });
    }
    return out;
  }
  const r = size / 2;
  const inner = r * Math.max(0, Math.min(1, b.hardness));
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d > r) continue;
    const w = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-6, r - inner);
    out.push({ x, y, w: w * w * (3 - 2 * w) });
  }
  return out;
}

/**
 * Paint one dab. `covered` remembers how much each pixel has had this stroke, so a stroke laid over itself doesn't
 * build up past its opacity, as in most paint programs.
 */
export function dab(img: Pixels, cx: number, cy: number, c: RGBA, b: Brush, covered: Map<number, number>) {
  for (const { x, y, w } of brushFootprint(cx, cy, b)) {
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    const k = y * img.width + x;
    const want = w * b.opacity;
    const had = covered.get(k) ?? 0;
    if (want <= had + 1e-6) continue;
    covered.set(k, want);
    // Lay down only the extra coverage, so the result matches one pass at `want`.
    const extra = had >= 1 ? 0 : (want - had) / (1 - had);
    blendPixel(img, x, y, c, extra, b.erase);
  }
}

/** Every pixel on the line from a to b, without gaps or doubled corners. */
export function linePixels(ax: number, ay: number, bx: number, by: number): [number, number][] {
  const out: [number, number][] = [];
  let x = Math.floor(ax), y = Math.floor(ay);
  const x1 = Math.floor(bx), y1 = Math.floor(by);
  const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
  let err = dx + dy;
  for (let guard = 0; guard < 100000; guard++) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return out;
}

/** Dab along a line. Pixel brushes step pixel by pixel; soft brushes space their dabs by a quarter of their size. */
export function strokeLine(img: Pixels, ax: number, ay: number, bx: number, by: number, c: RGBA, b: Brush, covered: Map<number, number>) {
  if (b.shape !== 'soft') {
    for (const [x, y] of linePixels(ax, ay, bx, by)) dab(img, x + 0.5, y + 0.5, c, b, covered);
    return;
  }
  const len = Math.hypot(bx - ax, by - ay);
  const step = Math.max(0.5, b.size / 4);
  const n = Math.max(1, Math.ceil(len / step));
  for (let i = 0; i <= n; i++) dab(img, ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n, c, b, covered);
}

/** A rectangle from corner to corner, outlined or filled. */
export function rectPixels(ax: number, ay: number, bx: number, by: number, filled: boolean): [number, number][] {
  const x0 = Math.min(Math.floor(ax), Math.floor(bx)), x1 = Math.max(Math.floor(ax), Math.floor(bx));
  const y0 = Math.min(Math.floor(ay), Math.floor(by)), y1 = Math.max(Math.floor(ay), Math.floor(by));
  const out: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (filled || x === x0 || x === x1 || y === y0 || y === y1) out.push([x, y]);
  }
  return out;
}

/**
 * Fill the area of matching colour around (x, y). `tolerance` 0..255 lets near colours count as the same; `global`
 * fills every matching pixel in the image instead of only the connected ones.
 */
export function floodFill(img: Pixels, x: number, y: number, c: RGBA, tolerance = 0, erase = false, global = false): number {
  const start = getPixel(img, Math.floor(x), Math.floor(y));
  if (!start) return 0;
  const W = img.width, H = img.height, d = img.data;
  const same = (i: number) => Math.max(Math.abs(d[i] - start[0]), Math.abs(d[i + 1] - start[1]), Math.abs(d[i + 2] - start[2]), Math.abs(d[i + 3] - start[3])) <= tolerance;
  const target: RGBA = erase ? [start[0], start[1], start[2], 0] : c;
  // Filling a colour with itself would loop for ever; there's nothing to do.
  if (!erase && start.every((v, k) => v === target[k])) return 0;
  const done = new Uint8Array(W * H);
  let count = 0;
  const set = (k: number) => {
    const i = k * 4;
    if (erase) d[i + 3] = 0;
    else { d[i] = target[0]; d[i + 1] = target[1]; d[i + 2] = target[2]; d[i + 3] = target[3]; }
    count++;
  };
  if (global) {
    for (let k = 0; k < W * H; k++) if (same(k * 4)) set(k);
    return count;
  }
  const stack = [Math.floor(y) * W + Math.floor(x)];
  while (stack.length) {
    const k = stack.pop()!;
    if (done[k]) continue;
    done[k] = 1;
    if (!same(k * 4)) continue;
    set(k);
    const px = k % W, py = (k - px) / W;
    if (px > 0) stack.push(k - 1);
    if (px < W - 1) stack.push(k + 1);
    if (py > 0) stack.push(k - W);
    if (py < H - 1) stack.push(k + W);
  }
  return count;
}

/** Mirror a pixel position across the image's vertical centre line, for symmetrical painting. */
export const mirrorX = (img: Pixels, x: number) => img.width - x;

/**
 * The texture coordinate at a point on a face, by where the point falls in the face's triangles. Null if the point
 * isn't on the face.
 */
export function uvAtPoint(m: Model, fi: number, p: [number, number, number]): V2 | null {
  const f = m.faces[fi];
  if (!f) return null;
  const tris = triangulateFace(m, f);
  let best: { uv: V2; err: number } | null = null;
  for (let t = 0; t < tris.length; t += 3) {
    const ia = tris[t], ib = tris[t + 1], ic = tris[t + 2];
    const a = m.verts[f.v[ia]].p, b = m.verts[f.v[ib]].p, c = m.verts[f.v[ic]].p;
    const v0 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], v2 = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
    const d00 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2], d01 = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
    const d11 = v1[0] * v1[0] + v1[1] * v1[1] + v1[2] * v1[2], d20 = v2[0] * v0[0] + v2[1] * v0[1] + v2[2] * v0[2];
    const d21 = v2[0] * v1[0] + v2[1] * v1[1] + v2[2] * v1[2];
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-14) continue;
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
    // How far outside the triangle the point lies; the closest triangle wins.
    const err = Math.max(0, -u, -v, -w);
    const A = f.uv[ia], B = f.uv[ib], C = f.uv[ic];
    const uv: V2 = [u * A[0] + v * B[0] + w * C[0], u * A[1] + v * B[1] + w * C[1]];
    if (!best || err < best.err) best = { uv, err };
  }
  return best && best.err < 0.05 ? best.uv : null;
}

/** Texture coordinates to pixel coordinates, wrapping as the texture repeats. */
export function uvToPixel(uv: V2, w: number, h: number): [number, number] {
  const u = uv[0] - Math.floor(uv[0]), v = uv[1] - Math.floor(uv[1]);
  return [u * w, v * h];
}
