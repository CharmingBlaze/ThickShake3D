// Tools that work on a model's surface in the view: painting its texture, and putting tiles on it or building with
// tiles, for the Paint and Tile workspaces.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { faceNormal } from '../core/geom';
import * as ops from '../core/ops';
import { hexToRgba, rgbaToHex, uvAtPoint, uvToPixel, type Brush, type RGBA } from '../core/paint';
import { autotileSlot, boxQuads, cellAt, cellCorners, cellsOnPlane, cubeBox, faceCell, faceInCell, fitTileToFace, NO_TRANSFORM, placeTileQuad, planeAxes, quadTileCounts, splitQuad, tileForCell, tileOfFace, tileUV, type TileGrid, type TilePlane } from '../core/tiles';
import { makeGroup, type Model, type V3 } from '../core/types';
import { app } from '../ui/app';
import { status, toast } from '../ui/feedback';
import { colorStore } from '../ui/colorPicker';
import { brushFor, paint, pressed, selection, setPressure, strokeBegin, strokeEnd, strokeMove, toolLabel } from '../ui/paintEditor';
import { texDoc, textureOfFace, workingTexture, type TexDoc } from '../ui/textureDoc';
import { atlasGrid, atlasMaterial, atlasTexture, rememberTile, tiles, type TileMode } from '../ui/tileEditor';
import type { Pane } from './pane';
import * as pick from './picking';
import { ModelStroke } from './projectPaint';
import type { SceneGraph } from './scene';

export interface SurfaceHost { sg: SceneGraph; invalidate(): void }

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

/** Drop vertices no face uses any more, after cube sides were taken away. */
function tidyVerts(m: Model) {
  const used = new Set<number>();
  for (const f of m.faces) for (const v of f.v) used.add(v);
  if (used.size < m.verts.length) ops.removeVerts(m, new Set([...m.verts.keys()].filter((v) => !used.has(v))));
}

// ---------- painting on the model ----------
export class TexPaintTool {
  /** A line or rectangle under way: these run straight across one texture. */
  private doc: TexDoc | null = null;
  /** A brush stroke under way, painted as the view sees it. */
  private stroke: { pane: Pane; s: ModelStroke; color: RGBA; brush: Brush; scale: number; last: [number, number] } | null = null;
  private mouse: { x: number; y: number; pane: Pane } | null = null;

  constructor(private host: SurfaceHost) {}

  get active() { return this.doc !== null || this.stroke !== null; }

  /** The texture pixel under the mouse, and the texture it's on. */
  private hitPixel(p: Pane, x: number, y: number): { doc: TexDoc; px: number; py: number } | null {
    const hit = pick.pickFace(p, this.host.sg, x, y, false);
    if (!hit) return null;
    const t = textureOfFace(ed.model, hit.face);
    if (!t) return null;
    const d = texDoc(t);
    if (!d) return null;
    const uv = uvAtPoint(ed.model, hit.face, v3(hit.point));
    if (!uv) return null;
    const [px, py] = uvToPixel(uv, d.w, d.h);
    return { doc: d, px, py };
  }

  /** How many screen pixels one texel covers at the mouse, measured by picking just beside it, across and down. */
  private texelScale = 4;
  private measure(p: Pane, x: number, y: number) {
    const a = this.hitPixel(p, x, y);
    if (!a) return;
    const scales: number[] = [];
    for (const b of [this.hitPixel(p, x + 6, y), this.hitPixel(p, x, y + 6)]) {
      if (!b || b.doc !== a.doc) continue;
      const d = Math.hypot(b.px - a.px, b.py - a.py);
      if (d > 1e-6 && d < a.doc.w / 2) scales.push(6 / d);
    }
    if (scales.length) this.texelScale = scales.reduce((s, v) => s + v, 0) / scales.length;
  }

  down(p: Pane, x: number, y: number, e: PointerEvent) {
    const hit = pick.pickFace(p, this.host.sg, x, y, false);
    if (!hit) return;
    const t = textureOfFace(ed.model, hit.face);
    if (!t) { toast('This part has no texture to paint yet. Use New texture in the panel.', 'info'); return; }
    const h = this.hitPixel(p, x, y);
    if (!h) { status('Loading the texture…'); return; }
    setPressure(e);
    const tip = paint.tool === 'pencil' || paint.tool === 'brush' || paint.tool === 'eraser';
    if (!tip || e.altKey) {
      // Lines and rectangles run straight in the texture, between where the drag starts and where it is now.
      if (strokeBegin(h.doc, h.px, h.py, e.shiftKey, e.altKey)) this.doc = h.doc;
      return;
    }
    this.measure(p, x, y);
    const work = workingTexture();
    const clip = work && selection.rect ? { texId: work.id, rect: selection.rect } : null;
    const s = new ModelStroke(p, clip);
    // The brush keeps the size it has where the stroke starts, so it doesn't swell or shrink crossing other faces.
    this.stroke = { pane: p, s, color: hexToRgba(e.shiftKey ? paint.secondary : paint.primary), brush: brushFor(paint.tool), scale: this.texelScale, last: [x, y] };
    this.dabAt(x, y);
    s.flush();
  }

  /** One dab under (x, y), at the pen's pressure. */
  private dabAt(x: number, y: number) {
    const st = this.stroke!;
    const b = pressed(st.brush);
    const r = (b.size / 2) * st.scale;
    st.s.dab(x, y, r, st.color, b, paint.mirror);
    // A pixel brush narrower than a texel on screen could fall between texel centres: paint the one under it.
    if (b.shape !== 'soft' && r < st.scale) {
      const hit = pick.pickFace(st.pane, this.host.sg, x, y, false);
      const t = hit && textureOfFace(ed.model, hit.face);
      const uv = hit && uvAtPoint(ed.model, hit.face, v3(hit.point));
      const sh = t ? st.s.sheets.get(t.id) : undefined;
      if (t && uv && sh) {
        const [px, py] = uvToPixel(uv, sh.doc.w, sh.doc.h);
        st.s.texel(t.id, Math.min(sh.doc.w - 1, Math.floor(px)), Math.min(sh.doc.h - 1, Math.floor(py)), st.color, b, paint.mirror);
      }
    }
  }

  move(p: Pane, x: number, y: number, e?: PointerEvent) {
    this.mouse = { x, y, pane: p };
    const st = this.stroke;
    if (st) {
      if (p !== st.pane) return;
      if (e) setPressure(e);
      // Dabs along the mouse's path on screen, so the stroke follows the surface however the texture is laid out.
      const r = (pressed(st.brush).size / 2) * st.scale;
      const step = Math.max(1, r * (st.brush.shape === 'soft' ? 0.25 : 0.5));
      const [lx, ly] = st.last;
      const n = Math.min(256, Math.ceil(Math.hypot(x - lx, y - ly) / step));
      for (let i = 1; i <= n; i++) this.dabAt(lx + ((x - lx) * i) / n, ly + ((y - ly) * i) / n);
      if (n) { st.last = [x, y]; st.s.flush(); }
      return;
    }
    if (!this.doc) {
      this.measure(p, x, y);
      this.host.invalidate();
      return;
    }
    const h = this.hitPixel(p, x, y);
    if (!h || h.doc !== this.doc) return;
    strokeMove(h.px, h.py);
  }

  up() {
    const st = this.stroke;
    if (st) {
      this.stroke = null;
      if (st.s.end(toolLabel(paint.tool))) colorStore.remember(rgbaToHex(st.color));
      return;
    }
    if (!this.doc) return;
    this.doc = null;
    strokeEnd();
  }

  draw(g: CanvasRenderingContext2D, p: Pane) {
    const m = this.mouse;
    if (!m || m.pane !== p) return;
    // The brush at its real size on the surface under the mouse.
    const r = paint.tool === 'fill' || paint.tool === 'picker' ? 4 : Math.max(3, (paint.size / 2) * (this.stroke?.scale ?? this.texelScale));
    g.strokeStyle = paint.tool === 'eraser' ? '#ffffff' : paint.primary;
    g.lineWidth = 2;
    g.beginPath(); g.arc(m.x, m.y, r, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1;
    g.beginPath(); g.arc(m.x, m.y, r + 2, 0, Math.PI * 2); g.stroke();
  }
}

// ---------- tiles ----------
interface TileStroke {
  /** A stroke stays in the view it started in. */
  pane: Pane;
  mode: TileMode;
  changed: boolean;
  /** Faces already tiled this stroke, and cells already built. */
  done: Set<string>;
  plane: TilePlane | null;
  /** Tiles built on another mesh's face sit a hair in front of it, so they don't flicker. */
  lift: number;
  /** Stamping a block: the cell the first stamp went in, so the rest line up with it. */
  anchor: [number, number] | null;
}

export class TileTool {
  private s: TileStroke | null = null;
  private hover: { pane: Pane; face: number | null; cell: V3[] | null } | null = null;

  constructor(private host: SurfaceHost) {}

  get active() { return this.s !== null; }

  /** The group built tiles go in: one drawn with the atlas. */
  private tileGroup(m: Model, texId: number): number {
    const mat = atlasMaterial(m, texId);
    const found = m.groups.find((g) => g.name.startsWith('Tiles') && g.material === mat.id);
    return (found ?? makeGroup(m, 'Tiles', mat.id)).id;
  }

  /** Put the chosen tile on one face, drawn with the atlas. */
  private tileFace(fi: number) {
    const t = atlasTexture();
    if (!t) return;
    const m = ed.model;
    const f = m.faces[fi];
    if (!f) return;
    const mat = atlasMaterial(m, t.id);
    const g = m.groups.find((x) => x.id === f.g);
    if (g && g.material !== mat.id) { g.material = mat.id; ed.emit('groups', 'materials'); }
    const grid = atlasGrid(t);
    // Repeat: a quad bigger than a tile is cut into tile-sized pieces, each taking its own tile.
    const pieces = tiles.repeat ? splitQuad(m, fi, ...quadTileCounts(m, f, tiles.cell)) : [fi];
    for (const pi of pieces) {
      const pf = m.faces[pi];
      const at = tileForCell(tiles.block, faceCell(m, pf, tiles.cell), tiles.random);
      fitTileToFace(m, pf, this.rect(grid, at.col, at.row), tiles.xf);
      this.s?.done.add(`f${pi}`);
    }
    if (this.s) this.s.changed = true;
  }

  /** A tile's texture rectangle in the atlas. */
  private rect(grid: TileGrid, col: number, row: number) { return tileUV(grid, col, row, tiles.inset ? 0.5 : 0); }

  /**
   * Choose each built tile around a cell from the autotile block, by which of its neighbours are filled. The plane's
   * cells count along its axes, which may run against the way it reads, so neighbours are looked up the way it reads.
   */
  private autotileAround(m: Model, gid: number, plane: TilePlane, i: number, j: number, grid: TileGrid) {
    const set = tiles.autotile;
    if (!set) return;
    const { uSign, vSign } = planeAxes(plane);
    const cells = cellsOnPlane(m, gid, plane, tiles.cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const ci = i + dx, cj = j + dy;
      const fi = cells.get(`${ci},${cj}`);
      if (fi === undefined) continue;
      const slot = autotileSlot(set, (a, b) => cells.has(`${ci + a * uSign},${cj + b * vSign}`));
      fitTileToFace(m, m.faces[fi], this.rect(grid, tiles.block.col + slot.col, tiles.block.row + slot.row), NO_TRANSFORM);
    }
  }

  /** Build in one cell: a flat tile, or a stack of tile cubes whose touching sides are left out. */
  private buildCell(m: Model, gid: number, plane: TilePlane, i: number, j: number, col: number, row: number, grid: TileGrid) {
    const rect = this.rect(grid, col, row);
    if (tiles.cube) {
      for (let layer = 0; layer < Math.max(1, tiles.height); layer++) {
        const { min, max } = cubeBox(plane, i, j, tiles.cell, layer);
        for (const q of boxQuads(min, max)) {
          // A side that meets a cube already there is inside the block now: take both away.
          const there = faceInCell(m, gid, q);
          if (there >= 0) ops.removeFaces(m, new Set([there]), false);
          else placeTileQuad(m, gid, q, rect, tiles.xf);
        }
      }
      return;
    }
    placeTileQuad(m, gid, cellCorners(plane, i, j, tiles.cell), rect, tiles.autotile ? NO_TRANSFORM : tiles.xf);
    this.autotileAround(m, gid, plane, i, j, grid);
  }

  /** Erase the tile cube behind a face, opening up the sides of any cubes beside it. True if anything went. */
  private eraseCube(m: Model, gid: number, fi: number, grid: TileGrid): boolean {
    const f = m.faces[fi];
    const n = faceNormal(m, f);
    const size = tiles.cell;
    const c: V3 = [0, 0, 0];
    for (const v of f.v) for (let k = 0; k < 3; k++) c[k] += m.verts[v].p[k] / f.v.length;
    const centre: V3 = [c[0] - (n[0] * size) / 2, c[1] - (n[1] * size) / 2, c[2] - (n[2] * size) / 2];
    const boxAt = (o: V3) => boxQuads([o[0] - size / 2, o[1] - size / 2, o[2] - size / 2], [o[0] + size / 2, o[1] + size / 2, o[2] + size / 2]);
    const rect = this.rect(grid, tiles.block.col, tiles.block.row);
    const gone = new Set<number>();
    const open: V3[][] = [];
    boxAt(centre).forEach((q, k) => {
      const there = faceInCell(m, gid, q);
      if (there >= 0) { gone.add(there); return; }
      // No face here: a cube beside this one shares the side. If that cube is there, its side shows now.
      const axis = Math.floor(k / 2), dir = k % 2 ? 1 : -1;
      const next: V3 = [centre[0], centre[1], centre[2]];
      next[axis] += dir * size;
      const others = boxAt(next).filter((_, kk) => kk !== (k ^ 1));
      if (others.some((qq) => faceInCell(m, gid, qq) >= 0)) open.push([q[0], q[3], q[2], q[1]]);
    });
    if (!gone.size) return false;
    ops.removeFaces(m, gone, false);
    for (const q of open) placeTileQuad(m, gid, q, rect, tiles.xf);
    return true;
  }

  /** The plane to build on: the flat face under the mouse, lined up with the grid, or else the view's own. */
  private planeAt(p: Pane, x: number, y: number): { plane: TilePlane; lift: number } | null {
    const hit = pick.pickFace(p, this.host.sg, x, y, false);
    if (hit) {
      const f = ed.model.faces[hit.face];
      const n = faceNormal(ed.model, f);
      const axis = ([0, 1, 2] as const).reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0 as 0 | 1 | 2);
      if (Math.abs(n[axis]) > 0.999) {
        const facing = n[axis] > 0 ? 1 : -1;
        const depth = ed.model.verts[f.v[0]].p[axis];
        // A face of another mesh: lift the tiles off it a little.
        const t = atlasTexture();
        const own = t && ed.model.groups.find((g) => g.id === f.g)?.material === ed.model.materials.find((mm) => mm.maps.base === t.id)?.id;
        return { plane: { axis, depth, facing }, lift: own ? 0 : 0.001 * facing };
      }
    }
    if (p.isOrtho) {
      const d = p.viewDir();
      const axis = ([0, 1, 2] as const).reduce((a, b) => (Math.abs(d.getComponent(b)) > Math.abs(d.getComponent(a)) ? b : a), 0 as 0 | 1 | 2);
      return { plane: { axis, depth: tiles.depth, facing: d.getComponent(axis) > 0 ? 1 : -1 }, lift: 0 };
    }
    // In perspective, the floor.
    return { plane: { axis: 1, depth: tiles.depth, facing: 1 }, lift: 0 };
  }

  /** The cell under the mouse on a plane, as its corners. */
  private cellUnder(p: Pane, x: number, y: number, plane: TilePlane, lift: number): { corners: V3[]; i: number; j: number } | null {
    const normal = new THREE.Vector3(); normal.setComponent(plane.axis, 1);
    const pt = new THREE.Vector3(); pt.setComponent(plane.axis, plane.depth);
    const ray = p.ray(x, y);
    // A view looking along the plane sees it edge on: there's no sensible cell under the mouse.
    if (Math.abs(ray.direction.dot(normal)) < 0.05) return null;
    const at = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, pt), new THREE.Vector3());
    if (!at || at.length() > 1e4) return null;
    const [i, j] = cellAt(plane, v3(at), tiles.cell);
    const lifted: TilePlane = { ...plane, depth: plane.depth + lift };
    return { corners: cellCorners(lifted, i, j, tiles.cell), i, j };
  }

  down(p: Pane, x: number, y: number, e: PointerEvent) {
    const t = atlasTexture();
    if (!t) { toast('Load an atlas image first, with Load atlas in the panel.', 'info'); return; }
    const mode: TileMode = e.altKey ? 'pick' : tiles.mode;
    if (mode === 'pick') {
      const hit = pick.pickFace(p, this.host.sg, x, y, false);
      const at = hit ? tileOfFace(atlasGrid(t), ed.model.faces[hit.face]) : null;
      if (at) { tiles.block = { col: at.col, row: at.row, w: 1, h: 1 }; app.tilesRefresh(); status(`Picked tile ${at.col}, ${at.row}.`); }
      return;
    }
    const placing = mode === 'place' ? this.planeAt(p, x, y) : null;
    ed.lastOp = null;
    ed.begin({ paint: 'Paint tiles', fill: 'Fill tiles', place: 'Build tiles', erase: 'Erase tiles', pick: '' }[mode]);
    this.s = { pane: p, mode, changed: false, done: new Set(), plane: placing?.plane ?? null, lift: placing?.lift ?? 0, anchor: null };
    if (mode === 'fill') {
      const hit = pick.pickFace(p, this.host.sg, x, y, false);
      if (hit) this.fill(hit.face);
      this.up();
      return;
    }
    this.apply(p, x, y);
  }

  /** Tile every face joined to this one across shared edges and lying in the same flat plane. */
  private fill(start: number) {
    const m = ed.model;
    const n0 = faceNormal(m, m.faces[start]);
    const d0 = n0[0] * m.verts[m.faces[start].v[0]].p[0] + n0[1] * m.verts[m.faces[start].v[0]].p[1] + n0[2] * m.verts[m.faces[start].v[0]].p[2];
    const byEdge = new Map<string, number[]>();
    m.faces.forEach((f, fi) => f.v.forEach((a, i) => {
      const b = f.v[(i + 1) % f.v.length];
      const k = a < b ? `${a},${b}` : `${b},${a}`;
      const l = byEdge.get(k); if (l) l.push(fi); else byEdge.set(k, [fi]);
    }));
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      const fi = stack.pop()!;
      this.tileFace(fi);
      const f = m.faces[fi];
      f.v.forEach((a, i) => {
        const b = f.v[(i + 1) % f.v.length];
        for (const nb of byEdge.get(a < b ? `${a},${b}` : `${b},${a}`) ?? []) {
          if (seen.has(nb)) continue;
          const g = m.faces[nb];
          const n = faceNormal(m, g);
          const d = n[0] * m.verts[g.v[0]].p[0] + n[1] * m.verts[g.v[0]].p[1] + n[2] * m.verts[g.v[0]].p[2];
          if (n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2] < 0.999 || Math.abs(d - d0) > 1e-4) continue;
          seen.add(nb);
          stack.push(nb);
        }
      });
    }
    ed.emit('topology');
    status(`Tiled ${seen.size} face${seen.size === 1 ? '' : 's'}.`);
  }

  private apply(p: Pane, x: number, y: number) {
    const s = this.s;
    const t = atlasTexture();
    if (!s || !t) return;
    const m = ed.model;
    if (s.mode === 'paint' || s.mode === 'erase') {
      const hit = pick.pickFace(p, this.host.sg, x, y, false);
      if (!hit) return;
      const key = `f${hit.face}`;
      if (s.done.has(key)) return;
      s.done.add(key);
      if (s.mode === 'paint') { this.tileFace(hit.face); ed.emit('topology'); return; }
      // Erase only what was tiled with this atlas, never the rest of a model.
      const mat = m.materials.find((x2) => x2.maps.base === t.id);
      const f = m.faces[hit.face];
      if (!mat || m.groups.find((g) => g.id === f.g)?.material !== mat.id) return;
      const grid = atlasGrid(t);
      if (tiles.cube) {
        if (this.eraseCube(m, f.g, hit.face, grid)) { tidyVerts(m); s.done.clear(); s.changed = true; ed.emit('topology'); }
        return;
      }
      // With autotiling, the tiles around a removed one change to suit.
      const n = faceNormal(m, f);
      const axis = ([0, 1, 2] as const).reduce((a, b) => (Math.abs(n[b]) > Math.abs(n[a]) ? b : a), 0 as 0 | 1 | 2);
      const flat: TilePlane | null = tiles.autotile && Math.abs(n[axis]) > 0.999 ? { axis, depth: m.verts[f.v[0]].p[axis], facing: n[axis] > 0 ? 1 : -1 } : null;
      let cell: [number, number] | null = null;
      if (flat) {
        const c: V3 = [0, 0, 0];
        for (const v of f.v) for (let k = 0; k < 3; k++) c[k] += m.verts[v].p[k] / f.v.length;
        cell = cellAt(flat, c, tiles.cell);
      }
      ops.removeFaces(m, new Set([hit.face]));
      if (flat && cell) this.autotileAround(m, f.g, flat, cell[0], cell[1], grid);
      // Face numbers moved: forget the ones already visited.
      s.done.clear();
      s.changed = true;
      ed.emit('topology');
      return;
    }
    if (s.mode === 'place' && s.plane) {
      const c = this.cellUnder(p, x, y, s.plane, s.lift);
      if (!c) return;
      const grid = atlasGrid(t);
      const gid = this.tileGroup(m, t.id);
      const plane: TilePlane = { ...s.plane, depth: s.plane.depth + s.lift };
      const b = tiles.block;
      if (tiles.stamp && !tiles.autotile && (b.w > 1 || b.h > 1)) {
        // The whole block goes down at once, the way it looks in the atlas; dragging lays more beside it, edge to edge.
        const { uSign, vSign } = planeAxes(plane);
        const a = s.anchor ?? (s.anchor = [c.i, c.j]);
        // Steps in cell numbers: across is u, and down the atlas is against the plane's up.
        const su = b.w * uSign, sv = -b.h * vSign;
        const ai = a[0] + Math.floor((c.i - a[0]) / su) * su, aj = a[1] + Math.floor((c.j - a[1]) / sv) * sv;
        const key = `s${ai},${aj}`;
        if (s.done.has(key)) return;
        s.done.add(key);
        for (let dr = 0; dr < b.h; dr++) for (let dc = 0; dc < b.w; dc++) {
          this.buildCell(m, gid, plane, ai + dc * uSign, aj - dr * vSign, b.col + dc, b.row + dr, grid);
        }
      } else {
        const key = `c${c.i},${c.j}`;
        if (s.done.has(key)) return;
        s.done.add(key);
        const at = tileForCell(b, { x: c.i, y: c.j, z: Math.round(s.plane.depth / tiles.cell) }, tiles.random);
        this.buildCell(m, gid, plane, c.i, c.j, at.col, at.row, grid);
      }
      if (tiles.cube) tidyVerts(m);
      s.changed = true;
      ed.emit('topology', 'groups', 'materials');
    }
  }

  move(p: Pane, x: number, y: number) {
    if (this.s) {
      if (p === this.s.pane) this.apply(p, x, y);
      this.host.invalidate();
      return;
    }
    // What a click would affect: the face under the mouse, or the cell a tile would be built in.
    let face: number | null = null, cell: V3[] | null = null;
    if (tiles.mode === 'place') {
      const pl = this.planeAt(p, x, y);
      if (pl) cell = this.cellUnder(p, x, y, pl.plane, pl.lift)?.corners ?? null;
    } else face = pick.pickFace(p, this.host.sg, x, y, false)?.face ?? null;
    this.hover = { pane: p, face, cell };
    this.host.invalidate();
  }

  up() {
    const s = this.s;
    if (!s) return;
    this.s = null;
    if (s.changed) { ed.commit(); ed.emitAll(); if (s.mode !== 'erase') rememberTile(); } else ed.cancel();
  }

  cancel() {
    if (!this.s) return;
    this.s = null;
    ed.cancel();
  }

  clearHover() { if (this.hover) { this.hover = null; this.host.invalidate(); } }

  draw(g: CanvasRenderingContext2D, p: Pane) {
    const hv = this.hover;
    if (!hv || hv.pane !== p || this.s) return;
    const pts = hv.cell ?? (hv.face !== null ? ed.model.faces[hv.face]?.v.map((v) => ed.model.verts[v].p) : null);
    if (!pts) return;
    g.beginPath();
    pts.forEach((q, i) => { const s = p.project(q[0], q[1], q[2]); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
    g.closePath();
    g.fillStyle = tiles.mode === 'erase' ? 'rgba(255,90,90,0.22)' : 'rgba(63,224,90,0.22)';
    g.fill();
    g.strokeStyle = tiles.mode === 'erase' ? '#ff5a5a' : '#3fe05a';
    g.lineWidth = 2;
    g.stroke();
  }
}
