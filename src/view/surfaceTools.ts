// Tools that work on a model's surface in the view: painting its texture, and putting tiles on it or building with
// tiles, for the Paint and Tile workspaces.
import * as THREE from 'three';
import { ed } from '../core/editor';
import { faceNormal } from '../core/geom';
import * as ops from '../core/ops';
import { uvAtPoint, uvToPixel } from '../core/paint';
import { cellAt, cellCorners, faceCell, fitTileToFace, placeTileQuad, tileForCell, tileOfFace, tileUV, type TilePlane } from '../core/tiles';
import { makeGroup, type Model, type V3 } from '../core/types';
import { app } from '../ui/app';
import { status, toast } from '../ui/feedback';
import { paint, strokeBegin, strokeEnd, strokeMove } from '../ui/paintEditor';
import { texDoc, textureOfFace, type TexDoc } from '../ui/textureDoc';
import { atlasGrid, atlasMaterial, atlasTexture, tiles, type TileMode } from '../ui/tileEditor';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

export interface SurfaceHost { sg: SceneGraph; invalidate(): void }

const v3 = (p: THREE.Vector3): V3 => [p.x, p.y, p.z];

// ---------- painting on the model ----------
export class TexPaintTool {
  private doc: TexDoc | null = null;
  private last: [number, number] | null = null;
  private mouse: { x: number; y: number; pane: Pane } | null = null;

  constructor(private host: SurfaceHost) {}

  get active() { return this.doc !== null; }

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

  down(p: Pane, x: number, y: number, e: PointerEvent) {
    const hit = pick.pickFace(p, this.host.sg, x, y, false);
    if (!hit) return;
    const t = textureOfFace(ed.model, hit.face);
    if (!t) { toast('This part has no texture to paint yet. Use New texture in the panel.', 'info'); return; }
    if (paint.tool === 'line' || paint.tool === 'rect') { status('Lines and rectangles are drawn in the texture panel; on the model, use the pencil or brush.'); return; }
    const h = this.hitPixel(p, x, y);
    if (!h) { status('Loading the texture…'); return; }
    if (strokeBegin(h.doc, h.px, h.py, e.shiftKey, e.altKey)) { this.doc = h.doc; this.last = [h.px, h.py]; }
  }

  move(p: Pane, x: number, y: number) {
    this.mouse = { x, y, pane: p };
    if (!this.doc) { this.host.invalidate(); return; }
    const h = this.hitPixel(p, x, y);
    if (!h || h.doc !== this.doc) return;
    // A big jump across the texture means the stroke crossed a UV seam: carry on from the new spot, not a line across.
    const far = !this.last || Math.hypot(h.px - this.last[0], h.py - this.last[1]) > Math.max(12, paint.size * 4);
    strokeMove(h.px, h.py, far);
    this.last = [h.px, h.py];
  }

  up() {
    if (!this.doc) return;
    this.doc = null;
    this.last = null;
    strokeEnd();
  }

  draw(g: CanvasRenderingContext2D, p: Pane) {
    const m = this.mouse;
    if (!m || m.pane !== p) return;
    g.strokeStyle = paint.tool === 'eraser' ? '#ffffff' : paint.primary;
    g.lineWidth = 2;
    g.beginPath(); g.arc(m.x, m.y, 6, 0, Math.PI * 2); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 1;
    g.beginPath(); g.arc(m.x, m.y, 8, 0, Math.PI * 2); g.stroke();
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
    const at = tileForCell(tiles.block, faceCell(m, f, tiles.cell), tiles.random);
    fitTileToFace(m, f, tileUV(grid, at.col, at.row, tiles.inset ? 0.5 : 0), tiles.xf);
    if (this.s) this.s.changed = true;
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
    this.s = { pane: p, mode, changed: false, done: new Set(), plane: placing?.plane ?? null, lift: placing?.lift ?? 0 };
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
      ops.removeFaces(m, new Set([hit.face]));
      // Face numbers moved: forget the ones already visited.
      s.done.clear();
      s.changed = true;
      ed.emit('topology');
      return;
    }
    if (s.mode === 'place' && s.plane) {
      const c = this.cellUnder(p, x, y, s.plane, s.lift);
      if (!c) return;
      const key = `c${c.i},${c.j}`;
      if (s.done.has(key)) return;
      s.done.add(key);
      const grid = atlasGrid(t);
      const gid = this.tileGroup(m, t.id);
      const at = tileForCell(tiles.block, { x: c.i, y: c.j, z: Math.round(s.plane.depth / tiles.cell) }, tiles.random);
      placeTileQuad(m, gid, c.corners, tileUV(grid, at.col, at.row, tiles.inset ? 0.5 : 0), tiles.xf);
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
    if (s.changed) { ed.commit(); ed.emitAll(); } else ed.cancel();
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
    g.fillStyle = tiles.mode === 'erase' ? 'rgba(255,90,90,0.22)' : 'rgba(242,178,76,0.22)';
    g.fill();
    g.strokeStyle = tiles.mode === 'erase' ? '#ff5a5a' : '#f2b24c';
    g.lineWidth = 2;
    g.stroke();
  }
}
