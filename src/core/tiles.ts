// Tiles: pick tiles from an atlas image laid out on a grid, and put them on a model.
//
// A tile goes onto a face by laying the face out flat in its own plane, upright the way it sits in the scene, and
// fitting the tile to it, so quads take a whole tile without stretching and any face shape works. Tiles can also be
// built as new quads on a grid, cell by cell, to model with them directly.
import { faceNormal } from './geom';
import type { Face, Model, V2, V3 } from './types';

/** How an atlas image is cut into tiles. Sizes are in pixels. */
export interface TileGrid {
  imageW: number;
  imageH: number;
  tileW: number;
  tileH: number;
  /** Space before the first tile, from the image's left and top edges. */
  marginX: number;
  marginY: number;
  /** Space between neighbouring tiles. */
  spacingX: number;
  spacingY: number;
}

export function tileCounts(g: TileGrid): { cols: number; rows: number } {
  const cols = Math.max(0, Math.floor((g.imageW - g.marginX + g.spacingX) / Math.max(1, g.tileW + g.spacingX)));
  const rows = Math.max(0, Math.floor((g.imageH - g.marginY + g.spacingY) / Math.max(1, g.tileH + g.spacingY)));
  return { cols, rows };
}

/** A tile's pixel rectangle: left, top, width, height. */
export function tilePixels(g: TileGrid, col: number, row: number): [number, number, number, number] {
  return [g.marginX + col * (g.tileW + g.spacingX), g.marginY + row * (g.tileH + g.spacingY), g.tileW, g.tileH];
}

/**
 * A tile's texture rectangle [u0, v0, u1, v1], with V down from the image's top as in the rest of the app. `inset`
 * pulls the edges in by that many pixels, so neighbouring tiles never bleed in when the texture is filtered.
 */
export function tileUV(g: TileGrid, col: number, row: number, inset = 0): [number, number, number, number] {
  const [x, y, w, h] = tilePixels(g, col, row);
  return [(x + inset) / g.imageW, (y + inset) / g.imageH, (x + w - inset) / g.imageW, (y + h - inset) / g.imageH];
}

/** Which tile a pixel position falls in, or null for the margins and gaps. */
export function tileAtPixel(g: TileGrid, px: number, py: number): { col: number; row: number } | null {
  const col = Math.floor((px - g.marginX) / (g.tileW + g.spacingX)), row = Math.floor((py - g.marginY) / (g.tileH + g.spacingY));
  const { cols, rows } = tileCounts(g);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return null;
  const [x, y] = tilePixels(g, col, row);
  if (px >= x + g.tileW || py >= y + g.tileH) return null;
  return { col, row };
}

/** How a tile is turned when it goes down: quarter turns clockwise, then mirrored. */
export interface TileTransform { rot: 0 | 1 | 2 | 3; flipX: boolean; flipY: boolean }
export const NO_TRANSFORM: TileTransform = { rot: 0, flipX: false, flipY: false };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * A face's own flat frame: right and up within its plane. Up follows the scene's up where it can, so wall tiles stand
 * upright; floors and ceilings take -Z (away from the front view) as up, so they read the same way from above.
 */
export function faceFrame(normal: V3): { right: V3; up: V3 } {
  const n = norm(normal);
  const ref: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [0, 0, n[1] > 0 ? -1 : 1];
  const up = norm(sub(ref, [n[0] * dot(ref, n), n[1] * dot(ref, n), n[2] * dot(ref, n)]));
  return { right: norm(cross(up, n)), up };
}

/** Turn and mirror a position within a tile, both 0..1 with t up. */
function transformST(s: number, t: number, x: TileTransform): [number, number] {
  if (x.flipX) s = 1 - s;
  if (x.flipY) t = 1 - t;
  // Turning the tile clockwise means each point on the face shows the tile a quarter turn back.
  for (let i = 0; i < x.rot; i++) [s, t] = [1 - t, s];
  return [s, t];
}

/**
 * Put a tile on a face: lay the face out in its own frame, fit the tile to that, and set its corners' UVs. The face
 * keeps its shape; a quad gets the whole tile.
 */
export function fitTileToFace(m: Model, f: Face, rect: [number, number, number, number], x: TileTransform = NO_TRANSFORM) {
  const { right, up } = faceFrame(faceNormal(m, f));
  const pts = f.v.map((v): V2 => { const p = m.verts[v].p; return [dot(p, right), dot(p, up)]; });
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const [u0, v0, u1, v1] = rect;
  f.uv = pts.map(([px, py]) => {
    const [s, t] = transformST((px - x0) / Math.max(1e-9, x1 - x0), (py - y0) / Math.max(1e-9, y1 - y0), x);
    // t runs up the face; V runs down the image.
    return [u0 + s * (u1 - u0), v0 + (1 - t) * (v1 - v0)] as V2;
  });
}

/**
 * Which grid cell a face sits in, in its own frame, for laying a block of tiles out across neighbouring faces as a
 * pattern and for choosing a random tile that stays put when the face is painted again.
 */
export function faceCell(m: Model, f: Face, cell: number): { x: number; y: number; z: number } {
  const { right, up } = faceFrame(faceNormal(m, f));
  const n = norm(faceNormal(m, f));
  const c: V3 = [0, 0, 0];
  for (const v of f.v) { const p = m.verts[v].p; c[0] += p[0] / f.v.length; c[1] += p[1] / f.v.length; c[2] += p[2] / f.v.length; }
  const s = Math.max(1e-6, cell);
  return { x: Math.floor(dot(c, right) / s), y: Math.floor(dot(c, up) / s), z: Math.round(dot(c, n) / s) };
}

/** A block of tiles chosen in the atlas: its top-left tile and its size in tiles. */
export interface TileBlock { col: number; row: number; w: number; h: number }

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** A small, stable hash of a cell, so random tiles don't change when nearby faces are painted. */
export function cellHash(x: number, y: number, z: number, seed = 0): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * The tile a cell takes from a block: in order, so the block repeats as a pattern across faces, or chosen at random
 * per cell. Rows run down the atlas while cells count up the face, so the pattern reads the right way up.
 */
export function tileForCell(b: TileBlock, cell: { x: number; y: number; z: number }, random: boolean, seed = 0): { col: number; row: number } {
  if (random) {
    const i = Math.floor(cellHash(cell.x, cell.y, cell.z, seed) * b.w * b.h);
    return { col: b.col + (i % b.w), row: b.row + Math.floor(i / b.w) };
  }
  return { col: b.col + mod(cell.x, b.w), row: b.row + mod(-cell.y - 1, b.h) };
}

/** Which tile a face shows, from where its UVs sit in the atlas: for the eyedropper. */
export function tileOfFace(g: TileGrid, f: Face): { col: number; row: number } | null {
  if (!f.uv.length) return null;
  const u = f.uv.reduce((s, x) => s + x[0], 0) / f.uv.length, v = f.uv.reduce((s, x) => s + x[1], 0) / f.uv.length;
  const wrap = (a: number) => a - Math.floor(a);
  return tileAtPixel(g, wrap(u) * g.imageW, wrap(v) * g.imageH);
}

// ---------- building with tiles ----------
/** A plane to build on: tiles lie across the two axes other than `axis`, at `depth` along it, facing `facing`. */
export interface TilePlane { axis: 0 | 1 | 2; depth: number; facing: 1 | -1 }

/** The plane's two in-plane axes, as right and up for a viewer it faces, so tiles come out upright. */
export function planeAxes(p: TilePlane): { u: 0 | 1 | 2; v: 0 | 1 | 2; uSign: 1 | -1; vSign: 1 | -1 } {
  if (p.axis === 1) return { u: 0, v: 2, uSign: 1, vSign: p.facing > 0 ? -1 : 1 };
  if (p.axis === 2) return { u: 0, v: 1, uSign: p.facing > 0 ? 1 : -1, vSign: 1 };
  return { u: 2, v: 1, uSign: p.facing > 0 ? -1 : 1, vSign: 1 };
}

/** The cell a point on the plane falls in. */
export function cellAt(p: TilePlane, at: V3, size: number): [number, number] {
  const { u, v } = planeAxes(p);
  return [Math.floor(at[u] / size), Math.floor(at[v] / size)];
}

/** A cell's four corners, counter-clockwise as seen from the side it faces, starting bottom left. */
export function cellCorners(p: TilePlane, i: number, j: number, size: number): V3[] {
  const { u, v } = planeAxes(p);
  const at = (a: number, b: number): V3 => { const q: V3 = [0, 0, 0]; q[p.axis] = p.depth; q[u] = a * size; q[v] = b * size; return q; };
  const quad = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
  // Wound to face the viewer: check against the facing direction and turn it round if needed.
  const n = cross(sub(quad[1], quad[0]), sub(quad[3], quad[0]));
  return n[p.axis] * p.facing >= 0 ? quad : [quad[0], quad[3], quad[2], quad[1]];
}

const key3 = (q: V3) => `${Math.round(q[0] * 1e4)},${Math.round(q[1] * 1e4)},${Math.round(q[2] * 1e4)}`;

/** The face filling a cell, if there is one, so placing again replaces it and erasing finds it. */
export function faceInCell(m: Model, group: number, corners: V3[]): number {
  const want = new Set(corners.map(key3));
  return m.faces.findIndex((f) => f.g === group && f.v.length === 4 && f.v.every((v) => want.has(key3(m.verts[v].p))));
}

/**
 * Put a tile quad in a cell, sharing corners with tiles already beside it so the result is one clean surface.
 * A cell that already has one keeps it and just takes the new tile. Returns the face's index.
 */
export function placeTileQuad(m: Model, group: number, corners: V3[], rect: [number, number, number, number], x: TileTransform = NO_TRANSFORM): number {
  let fi = faceInCell(m, group, corners);
  if (fi < 0) {
    const index = new Map<string, number>();
    m.faces.forEach((f) => { if (f.g === group) f.v.forEach((v) => index.set(key3(m.verts[v].p), v)); });
    const v = corners.map((q) => {
      const k = key3(q);
      let i = index.get(k);
      if (i === undefined) { i = m.verts.length; m.verts.push({ p: [q[0], q[1], q[2]] }); index.set(k, i); }
      return i;
    });
    m.faces.push({ v, uv: v.map((): V2 => [0, 0]), g: group, s: 0 });
    fi = m.faces.length - 1;
  }
  fitTileToFace(m, m.faces[fi], rect, x);
  return fi;
}
