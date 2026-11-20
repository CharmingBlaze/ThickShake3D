// Painting on texture pixels: hard pixel brushes for pixel art, soft brushes, lines, rectangles, flood fill and
// colour picking. Works on plain RGBA pixel buffers, so it runs anywhere and is easy to test; the editor copies
// them to and from canvases.
import { triangulateFace } from './geom';
import type { Model, V2, V3 } from './types';

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
  for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
    const w = brushWeight(x + 0.5 - cx, y + 0.5 - cy, r, b);
    if (w > 0) out.push({ x, y, w });
  }
  return out;
}

/** How strongly a brush of radius `r` covers a spot (dx, dy) from its centre: soft brushes feather off, others are on or off. */
export function brushWeight(dx: number, dy: number, r: number, b: Brush): number {
  if (b.shape === 'square') return Math.max(Math.abs(dx), Math.abs(dy)) <= r ? 1 : 0;
  const d = Math.hypot(dx, dy);
  if (d > r) return 0;
  if (b.shape === 'round') return 1;
  const inner = r * Math.max(0, Math.min(1, b.hardness));
  const w = d <= inner ? 1 : 1 - (d - inner) / Math.max(1e-6, r - inner);
  return w * w * (3 - 2 * w);
}

/**
 * Paint one dab. `covered` remembers how much each pixel has had this stroke, so a stroke laid over itself doesn't
 * build up past its opacity, as in most paint programs.
 */
export function dab(img: Pixels, cx: number, cy: number, c: RGBA, b: Brush, covered: Map<number, number>) {
  for (const { x, y, w } of brushFootprint(cx, cy, b)) coverPixel(img, x, y, c, w * b.opacity, b.erase, covered);
}

/** Bring one pixel up to `want` coverage for this stroke, never past it. */
export function coverPixel(img: Pixels, x: number, y: number, c: RGBA, want: number, erase: boolean, covered: Map<number, number>) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const k = y * img.width + x;
  const had = covered.get(k) ?? 0;
  if (want <= had + 1e-6) return;
  covered.set(k, want);
  // Lay down only the extra coverage, so the result matches one pass at `want`.
  const extra = had >= 1 ? 0 : (want - had) / (1 - had);
  blendPixel(img, x, y, c, extra, erase);
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

// ---------- regions ----------
export interface Rect { x: number; y: number; w: number; h: number }

/** The rectangle clipped to the image, or null if none of it is inside. */
export function clipRect(img: { width: number; height: number }, r: Rect): Rect | null {
  const x0 = Math.max(0, r.x), y0 = Math.max(0, r.y), x1 = Math.min(img.width, r.x + r.w), y1 = Math.min(img.height, r.y + r.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** A copy of the pixels in a rectangle. */
export function copyRegion(img: Pixels, r: Rect): Pixels {
  const out: Pixels = { width: r.w, height: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) };
  for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) {
    const sx = r.x + x, sy = r.y + y;
    if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
    const si = (sy * img.width + sx) * 4, di = (y * r.w + x) * 4;
    for (let k = 0; k < 4; k++) out.data[di + k] = img.data[si + k];
  }
  return out;
}

/** Make a rectangle transparent. */
export function clearRegion(img: Pixels, r: Rect) {
  const c = clipRect(img, r);
  if (!c) return;
  for (let y = c.y; y < c.y + c.h; y++) img.data.fill(0, (y * img.width + c.x) * 4, (y * img.width + c.x + c.w) * 4);
}

/** Put pixels down at (x, y): over what's there, as paint would, or replacing it. */
export function pasteRegion(img: Pixels, src: Pixels, x: number, y: number, replace = false) {
  for (let sy = 0; sy < src.height; sy++) for (let sx = 0; sx < src.width; sx++) {
    const dx = x + sx, dy = y + sy;
    if (dx < 0 || dy < 0 || dx >= img.width || dy >= img.height) continue;
    const si = (sy * src.width + sx) * 4;
    if (replace) { const di = (dy * img.width + dx) * 4; for (let k = 0; k < 4; k++) img.data[di + k] = src.data[si + k]; }
    else blendPixel(img, dx, dy, [src.data[si], src.data[si + 1], src.data[si + 2], src.data[si + 3]]);
  }
}

/** Flip pixels left to right, or upside down. */
export function flipRegion(src: Pixels, axis: 'x' | 'y'): Pixels {
  const out: Pixels = { width: src.width, height: src.height, data: new Uint8ClampedArray(src.data.length) };
  for (let y = 0; y < src.height; y++) for (let x = 0; x < src.width; x++) {
    const fx = axis === 'x' ? src.width - 1 - x : x, fy = axis === 'y' ? src.height - 1 - y : y;
    const si = (fy * src.width + fx) * 4, di = (y * src.width + x) * 4;
    for (let k = 0; k < 4; k++) out.data[di + k] = src.data[si + k];
  }
  return out;
}

/**
 * Put back every pixel outside `keep`, within `area`, from `before`: so painting stays inside a selection. Only
 * `area` is checked, which keeps it quick on large textures.
 */
export function keepInside(img: Pixels, before: Uint8ClampedArray, keep: Rect, area: Rect) {
  const a = clipRect(img, area);
  if (!a) return;
  for (let y = a.y; y < a.y + a.h; y++) for (let x = a.x; x < a.x + a.w; x++) {
    if (x >= keep.x && x < keep.x + keep.w && y >= keep.y && y < keep.y + keep.h) continue;
    const i = (y * img.width + x) * 4;
    img.data[i] = before[i]; img.data[i + 1] = before[i + 1]; img.data[i + 2] = before[i + 2]; img.data[i + 3] = before[i + 3];
  }
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

/**
 * Copy paint from one UV layout to another: for each triangle, every pixel it covers in the new layout takes the
 * colour from the same spot of the triangle in the old layout. Pixels within half a pixel of a triangle's edge count
 * as covered, so no gaps show along seams. `dst` keeps whatever the triangles don't cover.
 */
export function remapPixels(src: Pixels, dst: Pixels, tris: { from: [V2, V2, V2]; to: [V2, V2, V2] }[]) {
  const W = dst.width, H = dst.height;
  for (const { from, to } of tris) {
    const P = to.map((u) => [u[0] * W, u[1] * H]) as Tri2;
    forTexelsInTri(P, 0, 0, W - 1, H - 1, (x, y, c) => {
      const u = c[0] * from[0][0] + c[1] * from[1][0] + c[2] * from[2][0], v = c[0] * from[0][1] + c[1] * from[1][1] + c[2] * from[2][1];
      const [sx, sy] = uvToPixel([u, v], src.width, src.height);
      const si = (Math.min(src.height - 1, Math.floor(sy)) * src.width + Math.min(src.width - 1, Math.floor(sx))) * 4;
      const di = (y * W + x) * 4;
      dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1]; dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = src.data[si + 3];
    });
  }
}

type Tri2 = [[number, number], [number, number], [number, number]];

/**
 * Every pixel a triangle (in pixel coordinates) covers, within the range given, with where it sits in the triangle.
 * Pixels within half a pixel of an edge count as covered, so no gaps show along seams.
 */
export function forTexelsInTri(P: Tri2, rx0: number, ry0: number, rx1: number, ry1: number, fn: (x: number, y: number, c: [number, number, number]) => void) {
  const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
  if (Math.abs(area) < 1e-9) return;
  // Only the texels the triangle's box spans: the edge allowance must not reach past it, or wrap round the texture.
  const fx = Math.floor(Math.min(P[0][0], P[1][0], P[2][0])), fy = Math.floor(Math.min(P[0][1], P[1][1], P[2][1]));
  const x0 = Math.max(rx0, fx), x1 = Math.min(rx1, Math.max(fx, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])) - 1));
  const y0 = Math.max(ry0, fy), y1 = Math.min(ry1, Math.max(fy, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])) - 1));
  // Each edge's length, to measure how far outside it a pixel lies in pixels.
  const len = [0, 1, 2].map((i) => Math.hypot(P[(i + 2) % 3][0] - P[(i + 1) % 3][0], P[(i + 2) % 3][1] - P[(i + 1) % 3][1]) || 1);
  const w: [number, number, number] = [0, 0, 0];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const px = x + 0.5, py = y + 0.5;
    let out = false;
    for (let i = 0; i < 3 && !out; i++) {
      const a = P[(i + 1) % 3], b = P[(i + 2) % 3];
      w[i] = ((b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0])) / area;
      // w × twice the area ÷ the opposite edge is the distance inside that edge, in pixels.
      out = (w[i] * Math.abs(area)) / len[i] < -0.5;
    }
    if (out) continue;
    const c0 = Math.max(0, w[0]), c1 = Math.max(0, w[1]), c2 = Math.max(0, w[2]);
    const s = c0 + c1 + c2 || 1;
    fn(x, y, [c0 / s, c1 / s, c2 / s]);
  }
}

/** Texture coordinates to pixel coordinates, wrapping as the texture repeats. */
export function uvToPixel(uv: V2, w: number, h: number): [number, number] {
  const u = uv[0] - Math.floor(uv[0]), v = uv[1] - Math.floor(uv[1]);
  return [u * w, v * h];
}

// ---------- indexed colours ----------
/** One colour a texture uses, and how many visible pixels have it. */
export interface UsedColor { c: RGBA; count: number }

const key = (d: Uint8ClampedArray, i: number) => ((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]) >>> 0;

/**
 * The colours an image uses, most common first, ignoring alpha and fully transparent pixels. Null when there are more
 * than `max`, as in a painting rather than pixel art.
 */
export function usedColors(img: Pixels, max = 64): UsedColor[] | null {
  const counts = new Map<number, number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const k = key(d, i);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (counts.size > max) return null;
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([k, count]) => ({ c: [(k >> 16) & 255, (k >> 8) & 255, k & 255, 255], count }));
}

/** Recolour every pixel of one colour, keeping each pixel's own alpha. Returns how many changed. */
export function replaceColor(img: Pixels, from: RGBA, to: RGBA): number {
  const d = img.data;
  const want = ((from[0] << 16) | (from[1] << 8) | from[2]) >>> 0;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3] || key(d, i) !== want) continue;
    d[i] = to[0]; d[i + 1] = to[1]; d[i + 2] = to[2];
    n++;
  }
  return n;
}

/** Each visible pixel takes the nearest of the palette's colours, keeping its alpha. */
export function mapToPalette(img: Pixels, palette: RGBA[]) {
  if (!palette.length) return;
  const d = img.data;
  const memo = new Map<number, RGBA>();
  for (let i = 0; i < d.length; i += 4) {
    if (!d[i + 3]) continue;
    const k = key(d, i);
    let c = memo.get(k);
    if (!c) {
      let best = Infinity;
      for (const p of palette) {
        // Weighted for how the eye sees: green counts most, blue least.
        const e = 2 * (p[0] - d[i]) ** 2 + 4 * (p[1] - d[i + 1]) ** 2 + 3 * (p[2] - d[i + 2]) ** 2;
        if (e < best) { best = e; c = p; }
      }
      memo.set(k, c!);
    }
    d[i] = c![0]; d[i + 1] = c![1]; d[i + 2] = c![2];
  }
}

/**
 * Pick `n` colours that represent an image well: split the colours along their widest channel, at the biggest gap,
 * until there are `n` groups, then average each group, weighted by how many pixels use each colour.
 */
export function reducePalette(img: Pixels, n: number): RGBA[] {
  const counts = new Map<number, number>();
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) { const k = key(d, i); counts.set(k, (counts.get(k) ?? 0) + 1); }
  type Entry = { c: [number, number, number]; w: number };
  const all: Entry[] = [...counts].map(([k, w]) => ({ c: [(k >> 16) & 255, (k >> 8) & 255, k & 255], w }));
  if (!all.length) return [];
  const boxes: Entry[][] = [all];
  const spread = (b: Entry[]) => {
    let best = -1, ch = 0;
    for (let k = 0; k < 3; k++) {
      let lo = 255, hi = 0;
      for (const e of b) { lo = Math.min(lo, e.c[k]); hi = Math.max(hi, e.c[k]); }
      if (hi - lo > best) { best = hi - lo; ch = k; }
    }
    return { range: best, ch };
  };
  while (boxes.length < n) {
    // Split the box with the widest range of colour, if any still has more than one.
    let pick = -1, widest = 0;
    boxes.forEach((b, i) => { if (b.length > 1) { const s = spread(b).range; if (s > widest) { widest = s; pick = i; } } });
    if (pick < 0) break;
    const b = boxes[pick];
    const { ch } = spread(b);
    b.sort((x, y) => x.c[ch] - y.c[ch]);
    // Cut at the widest gap between neighbouring colours, so distinct groups of colours stay apart.
    let cut = 1, gap = -1;
    for (let i = 0; i < b.length - 1; i++) { const g = b[i + 1].c[ch] - b[i].c[ch]; if (g > gap) { gap = g; cut = i + 1; } }
    boxes.splice(pick, 1, b.slice(0, cut), b.slice(cut));
  }
  return boxes.map((b) => {
    const w = b.reduce((s, e) => s + e.w, 0);
    const avg = [0, 1, 2].map((k) => Math.round(b.reduce((s, e) => s + e.c[k] * e.w, 0) / w));
    return [avg[0], avg[1], avg[2], 255] as RGBA;
  });
}

// ---------- painting on the model as the view sees it ----------
/** A triangle of the model to paint: its corners on the texture (0..1) and on the model. */
export interface PaintTri { uv: [V2, V2, V2]; p: [V3, V3, V3] }

/**
 * Where a model point lands on screen: x and y in pixels, w the perspective divide (1 when flat), d its distance in
 * front of the camera. Null behind the camera.
 */
export type Projector = (p: V3) => { x: number; y: number; w: number; d: number } | null;

/**
 * Paint a brush seen on screen onto one triangle's texture: each texel whose spot on the model lands within the brush
 * around (cx, cy), radius `r` pixels, gets `fn(x, y, want)`. So the brush keeps its shape however the texture is
 * stretched, and never reaches texels of parts that aren't under it. `visible` hides spots behind other surfaces.
 */
export function projectTri(t: PaintTri, w: number, h: number, project: Projector, visible: (s: { x: number; y: number; d: number }) => boolean,
  cx: number, cy: number, r: number, b: Brush, fn: (x: number, y: number, want: number) => void) {
  const S = t.p.map(project);
  const reach = r + 1;
  const all = S.every((s) => s !== null);
  if (all) {
    const xs = S.map((s) => s!.x), ys = S.map((s) => s!.y);
    if (Math.max(...xs) < cx - reach || Math.min(...xs) > cx + reach || Math.max(...ys) < cy - reach || Math.min(...ys) > cy + reach) return;
  }
  // Shift the triangle near the texture's first repeat, and wrap the texels back.
  const ou = Math.floor(Math.min(t.uv[0][0], t.uv[1][0], t.uv[2][0])), ov = Math.floor(Math.min(t.uv[0][1], t.uv[1][1], t.uv[2][1]));
  const P = t.uv.map((u) => [(u[0] - ou) * w, (u[1] - ov) * h]) as Tri2;
  let rx0 = -Infinity, ry0 = -Infinity, rx1 = Infinity, ry1 = Infinity;
  if (all) {
    // Only the texels under the brush's box on screen: map its corners back onto the triangle, correcting for perspective.
    const [a, bb, c] = S as { x: number; y: number; w: number }[];
    const den = (bb.y - c.y) * (a.x - c.x) + (c.x - bb.x) * (a.y - c.y);
    if (Math.abs(den) > 1e-9) {
      let ok = true;
      const us: number[] = [], vs: number[] = [];
      for (const [qx, qy] of [[cx - reach, cy - reach], [cx + reach, cy - reach], [cx - reach, cy + reach], [cx + reach, cy + reach]]) {
        const l0 = ((bb.y - c.y) * (qx - c.x) + (c.x - bb.x) * (qy - c.y)) / den;
        const l1 = ((c.y - a.y) * (qx - c.x) + (a.x - c.x) * (qy - c.y)) / den;
        const m0 = l0 / a.w, m1 = l1 / bb.w, m2 = (1 - l0 - l1) / c.w, sum = m0 + m1 + m2;
        if (sum <= 1e-12) { ok = false; break; }
        us.push((m0 * P[0][0] + m1 * P[1][0] + m2 * P[2][0]) / sum);
        vs.push((m0 * P[0][1] + m1 * P[1][1] + m2 * P[2][1]) / sum);
      }
      if (ok) { rx0 = Math.floor(Math.min(...us)) - 2; rx1 = Math.ceil(Math.max(...us)) + 2; ry0 = Math.floor(Math.min(...vs)) - 2; ry1 = Math.ceil(Math.max(...vs)) + 2; }
    }
  }
  const q: V3 = [0, 0, 0];
  forTexelsInTri(P, rx0, ry0, rx1, ry1, (x, y, k) => {
    for (let i = 0; i < 3; i++) q[i] = k[0] * t.p[0][i] + k[1] * t.p[1][i] + k[2] * t.p[2][i];
    const s = project(q);
    if (!s) return;
    const want = brushWeight(s.x - cx, s.y - cy, r, b) * b.opacity;
    if (want <= 0 || !visible(s)) return;
    fn(((x % w) + w) % w, ((y % h) + h) % h, want);
  });
}

/** Which texels some triangle covers (corners 0..1), within half a texel of its edges, as y × width + x. */
export function uvCoverage(w: number, h: number, tris: [V2, V2, V2][]): Uint8Array {
  const used = new Uint8Array(w * h);
  for (const uv of tris) {
    const ou = Math.floor(Math.min(uv[0][0], uv[1][0], uv[2][0])), ov = Math.floor(Math.min(uv[0][1], uv[1][1], uv[2][1]));
    const P = uv.map((u) => [(u[0] - ou) * w, (u[1] - ov) * h]) as Tri2;
    forTexelsInTri(P, -Infinity, -Infinity, Infinity, Infinity, (x, y) => { used[(((y % h) + h) % h) * w + (((x % w) + w) % w)] = 1; });
  }
  return used;
}

/**
 * Spread painted pixels `pad` pixels out into the texture's unused space, so a seam doesn't show the old colour once
 * the texture is drawn smaller. `used` marks the pixels faces use; only pixels outside it change. `from` are the
 * painted pixels, as y × width + x.
 */
export function padPainted(img: Pixels, used: Uint8Array, from: Iterable<number>, pad: number) {
  const W = img.width, H = img.height, d = img.data;
  const done = new Uint8Array(W * H);
  let ring = [...from].filter((k) => used[k]);
  for (let step = 0; step < pad && ring.length; step++) {
    const next: number[] = [];
    for (const k of ring) {
      const x = k % W, y = (k - x) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const n = ny * W + nx;
        if (used[n] || done[n]) continue;
        done[n] = 1;
        d.copyWithin(n * 4, k * 4, k * 4 + 4);
        next.push(n);
      }
    }
    ring = next;
  }
}
