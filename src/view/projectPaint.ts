// Painting on the model as the view sees it: each dab is a brush on screen, laid onto every texel whose spot on the
// model is under it and in sight. One stroke can reach several textures, and it carries across UV seams on its own.
import { ed } from '../core/editor';
import { triangulateFace } from '../core/geom';
import { coverPixel, padPainted, projectTri, uvCoverage, type Brush, type PaintTri, type Projector, type Rect, type RGBA } from '../core/paint';
import type { V2, V3 } from '../core/types';
import { commitDocs, pushLive, texDoc, textureOfFace, type TexDoc } from '../ui/textureDoc';
import type { Pane } from './pane';

/** How far painted texels spread into a texture's unused space when a stroke ends, so seams stay clean. */
const PAD = 4;

interface Sheet {
  doc: TexDoc;
  tris: PaintTri[];
  /** Each triangle's normal and centre, to fade the brush where the surface turns away. */
  normals: V3[];
  centres: V3[];
  /** Each triangle's box on screen, straight and mirrored; null when part of it is behind the camera. */
  boxes: (number[] | null)[][];
  covered: Map<number, number>;
  changed: boolean;
  /** Painting stays inside the texture panel's selection, on the texture it shows. */
  clip: Rect | null;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export class ModelStroke {
  readonly sheets = new Map<number, Sheet>();
  private zb: Float32Array;
  private zx: number; private zy: number; private zw: number; private zh: number;
  private persp: boolean;
  private eye: V3; private fwd: V3;
  readonly project: Projector;
  private passes: { project: Projector; flip: boolean }[];

  constructor(pane: Pane, clip: { texId: number; rect: Rect } | null) {
    const m = ed.model;
    const P = ed.displayPositions();
    const cam = pane.camera.matrixWorld.elements;
    this.eye = [cam[12], cam[13], cam[14]];
    this.fwd = [-cam[8], -cam[9], -cam[10]];
    this.persp = !pane.isOrtho;
    this.project = (q) => {
      const s = pane.project(q[0], q[1], q[2]);
      if (!(s.w > 1e-6)) return null;
      const d = this.persp ? s.w : (q[0] - this.eye[0]) * this.fwd[0] + (q[1] - this.eye[1]) * this.fwd[1] + (q[2] - this.eye[2]) * this.fwd[2];
      return { x: s.x, y: s.y, w: s.w, d };
    };
    const mirrored: Projector = (q) => this.project([-q[0], q[1], q[2]]);
    this.passes = [{ project: this.project, flip: false }, ...(ed.mirrorX ? [{ project: mirrored, flip: true }] : [])];

    // Where each vertex lands, once: the view doesn't move during a stroke.
    const nv = m.verts.length;
    const sv = new Float64Array(nv * 3).fill(NaN);
    for (let v = 0; v < nv; v++) {
      const s = this.project([P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]);
      if (s) { sv[v * 3] = s.x; sv[v * 3 + 1] = s.y; sv[v * 3 + 2] = this.persp ? 1 / s.d : s.d; }
    }

    // Depth of the nearest surface at each screen pixel, so paint never lands on what's hidden.
    this.zx = Math.floor(pane.x); this.zy = Math.floor(pane.y);
    this.zw = Math.max(1, Math.ceil(pane.w)); this.zh = Math.max(1, Math.ceil(pane.h));
    this.zb = new Float32Array(this.zw * this.zh).fill(Infinity);
    const hidden = new Set(m.groups.filter((g) => !g.visible).map((g) => g.id));
    const locked = new Set(m.groups.filter((g) => g.locked).map((g) => g.id));
    m.faces.forEach((f, fi) => {
      if (hidden.has(f.g)) return;
      const tris = triangulateFace(m, f);
      for (let t = 0; t < tris.length; t += 3) this.raster(sv, f.v[tris[t]], f.v[tris[t + 1]], f.v[tris[t + 2]]);
      if (locked.has(f.g)) return;
      const tex = textureOfFace(m, fi);
      const doc = tex ? texDoc(tex) : null;
      if (!tex || !doc) return;
      let sh = this.sheets.get(tex.id);
      if (!sh) {
        sh = { doc, tris: [], normals: [], centres: [], boxes: [], covered: new Map(), changed: false, clip: clip?.texId === tex.id ? clip.rect : null };
        this.sheets.set(tex.id, sh);
      }
      for (let t = 0; t < tris.length; t += 3) {
        const c = [tris[t], tris[t + 1], tris[t + 2]];
        const p = c.map((i) => [P[f.v[i] * 3], P[f.v[i] * 3 + 1], P[f.v[i] * 3 + 2]] as V3) as [V3, V3, V3];
        const e0 = p[1].map((x, k) => x - p[0][k]), e1 = p[2].map((x, k) => x - p[0][k]);
        const n: V3 = [e0[1] * e1[2] - e0[2] * e1[1], e0[2] * e1[0] - e0[0] * e1[2], e0[0] * e1[1] - e0[1] * e1[0]];
        const nl = Math.hypot(...n) || 1;
        sh.tris.push({ uv: c.map((i) => f.uv[i]) as [V2, V2, V2], p });
        sh.normals.push([n[0] / nl, n[1] / nl, n[2] / nl]);
        sh.centres.push([0, 1, 2].map((k) => (p[0][k] + p[1][k] + p[2][k]) / 3) as V3);
        sh.boxes.push(this.passes.map((pass) => {
          const S = p.map(pass.project);
          if (S.some((s) => !s)) return null;
          const xs = S.map((s) => s!.x), ys = S.map((s) => s!.y);
          return [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        }));
      }
    });
  }

  /** Lay one triangle into the depth buffer. Depth goes as 1/distance across the screen in perspective, else straight. */
  private raster(sv: Float64Array, a: number, b: number, c: number) {
    const ax = sv[a * 3], ay = sv[a * 3 + 1], aq = sv[a * 3 + 2];
    const bx = sv[b * 3], by = sv[b * 3 + 1], bq = sv[b * 3 + 2];
    const cx = sv[c * 3], cy = sv[c * 3 + 1], cq = sv[c * 3 + 2];
    if (Number.isNaN(ax + bx + cx)) return;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-12) return;
    const x0 = Math.max(this.zx, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(this.zx + this.zw - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(this.zy, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(this.zy + this.zh - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const l0 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
      const l1 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
      const l2 = 1 - l0 - l1;
      if (l0 < -1e-6 || l1 < -1e-6 || l2 < -1e-6) continue;
      const q = l0 * aq + l1 * bq + l2 * cq;
      const d = this.persp ? 1 / q : q;
      const k = (y - this.zy) * this.zw + (x - this.zx);
      if (d < this.zb[k]) this.zb[k] = d;
    }
  }

  /** Is a spot on screen the nearest surface there? Looks a pixel around, so edges and steep faces aren't missed. */
  readonly visible = (s: { x: number; y: number; d: number }) => {
    const ix = Math.floor(s.x) - this.zx, iy = Math.floor(s.y) - this.zy;
    if (ix < 0 || iy < 0 || ix >= this.zw || iy >= this.zh) return false;
    let far = -Infinity;
    for (let y = Math.max(0, iy - 1); y <= Math.min(this.zh - 1, iy + 1); y++) for (let x = Math.max(0, ix - 1); x <= Math.min(this.zw - 1, ix + 1); x++) far = Math.max(far, this.zb[y * this.zw + x]);
    return s.d <= far + Math.abs(far) * 0.003 + 1e-5;
  };

  /** How squarely a triangle faces the camera, 1 head on, 0 or less edge on or away. */
  private facing(n: V3, c: V3, flip: boolean): number {
    const nx = flip ? -n[0] : n[0], cx = flip ? -c[0] : c[0];
    const v = this.persp ? [this.eye[0] - cx, this.eye[1] - c[1], this.eye[2] - c[2]] : [-this.fwd[0], -this.fwd[1], -this.fwd[2]];
    return (nx * v[0] + n[1] * v[1] + n[2] * v[2]) / (Math.hypot(v[0], v[1], v[2]) || 1);
  }

  /**
   * One dab of the brush at (cx, cy) on screen, `r` pixels across the middle. Soft brushes fade out where the surface
   * turns edge on; hard ones stop there, so pixel art keeps whole pixels. `mirrorTex` paints the texture's other half too.
   */
  dab(cx: number, cy: number, r: number, c: RGBA, b: Brush, mirrorTex: boolean) {
    for (const sh of this.sheets.values()) {
      const { doc, clip } = sh;
      const put = (x: number, y: number, want: number) => {
        if (clip && (x < clip.x || y < clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h)) return;
        coverPixel(doc.img, x, y, c, want, b.erase, sh.covered);
        sh.changed = true;
      };
      sh.tris.forEach((t, i) => this.passes.forEach((pass, pi) => {
        const box = sh.boxes[i][pi];
        if (box && (box[1] < cx - r - 1 || box[0] > cx + r + 1 || box[3] < cy - r - 1 || box[2] > cy + r + 1)) return;
        const cos = this.facing(sh.normals[i], sh.centres[i], pass.flip);
        const fade = b.shape === 'soft' ? smooth(0.05, 0.3, cos) : cos >= 0.15 ? 1 : 0;
        if (fade <= 0) return;
        projectTri(t, doc.w, doc.h, pass.project, this.visible, cx, cy, r, { ...b, opacity: b.opacity * fade }, (x, y, want) => {
          put(x, y, want);
          if (mirrorTex) put(doc.w - 1 - x, y, want);
        });
      }));
    }
  }

  /** Show the paint so far on the model. */
  flush() { for (const sh of this.sheets.values()) if (sh.changed) pushLive(sh.doc); }

  /** Paint one texel outright, for a pixel brush smaller than a texel on screen. */
  texel(texId: number, x: number, y: number, c: RGBA, b: Brush, mirrorTex: boolean) {
    const sh = this.sheets.get(texId);
    if (!sh) return;
    for (const px of mirrorTex ? [x, sh.doc.w - 1 - x] : [x]) {
      const cl = sh.clip;
      if (cl && (px < cl.x || y < cl.y || px >= cl.x + cl.w || y >= cl.y + cl.h)) continue;
      coverPixel(sh.doc.img, px, y, c, b.opacity, b.erase, sh.covered);
      sh.changed = true;
    }
  }

  /** Finish: spread the paint past the seams and save every texture it reached as one undo step. */
  end(label: string): boolean {
    const m = ed.model;
    const done = [...this.sheets.entries()].filter(([, sh]) => sh.changed);
    if (!done.length) return false;
    for (const [texId, sh] of done) {
      const uvs: [V2, V2, V2][] = [];
      m.faces.forEach((f, fi) => {
        if (textureOfFace(m, fi)?.id !== texId) return;
        const tris = triangulateFace(m, f);
        for (let t = 0; t < tris.length; t += 3) uvs.push([f.uv[tris[t]], f.uv[tris[t + 1]], f.uv[tris[t + 2]]]);
      });
      padPainted(sh.doc.img, uvCoverage(sh.doc.w, sh.doc.h, uvs), sh.covered.keys(), PAD);
    }
    commitDocs(done.map(([, sh]) => sh.doc), label);
    return true;
  }
}
