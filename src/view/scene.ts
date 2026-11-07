// Turns the Editor's document into GPU buffers. One Three.js scene is drawn once per
// viewport pane; shading and overlays are switched per pane just before each draw.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { ed } from '../core/editor';
import { parseEdge, triangulateFace } from '../core/geom';
import { blockColorOf } from '../core/blockout';
import { fillLit, fillUnlit, liveTextures, makeDocTexture, newLitMaterial, newUnlitMaterial, shaderSignature, type TexOf } from './materialView';

/** A cached map is rebuilt when the texture is painted (rev) or switched to or from pixel art. */
const texKey = (owner: number, slot: string, t: DocTexture) => `${owner}:${slot}:${t.id}:${t.rev ?? 0}${t.pixelated ? 'p' : ''}`;
import { viewBasis } from './pane';
import { boneWeight } from '../core/skeleton';
import type { Material as DocMaterial, Texture as DocTexture } from '../core/types';

export type Shading = 'wire' | 'clay' | 'block' | 'pbr' | 'checker' | 'normals' | 'weights';

const WIRE_DARK = 0x14161a;
const WIRE_LIGHT = 0x9aa3ad;
export const SELECT_HEX = 0xf2b24c;

interface GroupRender {
  id: number;
  mesh: THREE.Mesh;
  /** Vertex index per GPU corner. */
  corners: Int32Array;
  /** Per-corner source: face index, for normal calculation. */
  cornerFace: Int32Array;
  faces: number[];
}

/** Heat ramp for weights: blue (0) to green to red (1). */
export function heat(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.25) return [0.05, 0.1 + x * 3.2, 0.75];
  if (x < 0.5) return [0.05, 0.9, 0.75 - (x - 0.25) * 3];
  if (x < 0.75) return [(x - 0.5) * 3.8, 0.9, 0];
  return [0.95, 0.9 - (x - 0.75) * 3.6, 0];
}

function makeCheckerTexture(): THREE.CanvasTexture {
  const n = 512, cells = 8, c = document.createElement('canvas');
  c.width = c.height = n;
  const g = c.getContext('2d')!;
  const s = n / cells;
  const tint = (i: number, j: number) => `hsl(${(i + j * cells) * (360 / (cells * cells))} 45% ${(i + j) % 2 ? 62 : 38}%)`;
  for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) {
    g.fillStyle = tint(i, j);
    g.fillRect(i * s, n - (j + 1) * s, s, s);
    g.fillStyle = 'rgba(255,255,255,.9)';
    g.font = 'bold 20px Segoe UI, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(`${String.fromCharCode(65 + i)}${j + 1}`, (i + 0.5) * s, n - (j + 0.5) * s);
  }
  const t = new THREE.CanvasTexture(c);
  t.flipY = false; // Same V-down convention as every other texture.
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

export class SceneGraph {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  meshRoot = new THREE.Group();
  groups = new Map<number, GroupRender>();

  // Overlay geometry
  edges: THREE.LineSegments;
  selEdges: THREE.LineSegments;
  points: THREE.Points;
  selPoints: THREE.Points;
  selFill: THREE.Mesh;
  edgeMat = new THREE.LineBasicMaterial({ color: WIRE_DARK, transparent: true, opacity: 0.9 });
  selEdgeMat = new THREE.LineBasicMaterial({ color: SELECT_HEX });
  pointMat = new THREE.PointsMaterial({ color: 0xdfe4ea, size: 4, sizeAttenuation: false });
  selPointMat = new THREE.PointsMaterial({ color: SELECT_HEX, size: 6, sizeAttenuation: false });
  selFillMat = new THREE.MeshBasicMaterial({ color: SELECT_HEX, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  // Shading override materials
  clayMat = new THREE.MeshStandardMaterial({ color: 0xb4b9c0, roughness: 0.72, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
  checkerMat: THREE.MeshStandardMaterial;
  normalMat = new THREE.MeshNormalMaterial({ polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  weightMat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });
  wireFillMat = new THREE.MeshBasicMaterial({ colorWrite: false, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

  private pbr = new Map<number, THREE.MeshPhysicalMaterial>();
  private unlit = new Map<number, THREE.MeshBasicMaterial>();
  private shaderKeys = new Map<number, string>();
  private texCache = new Map<string, THREE.Texture>();
  private fallbackMat = new THREE.MeshStandardMaterial({ color: 0xb9bec6, roughness: 0.65, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });

  grids: Record<'xz' | 'xy' | 'zy', THREE.LineSegments>;
  envMap: THREE.Texture;
  key: THREE.DirectionalLight;
  fill: THREE.DirectionalLight;
  onDirty: () => void = () => {};

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setScissorTest(true);
    this.renderer.autoClear = false;

    const pm = new THREE.PMREMGenerator(this.renderer);
    this.envMap = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.envMap;
    this.scene.environmentIntensity = 0.75;
    pm.dispose();

    this.key = new THREE.DirectionalLight(0xfff2e0, 1.5);
    this.key.position.set(3, 6, 4);
    this.fill = new THREE.DirectionalLight(0xbfd4ff, 0.45);
    this.fill.position.set(-5, 2, -3);
    this.scene.add(this.key, this.fill, this.meshRoot);

    this.checkerMat = new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), roughness: 0.8, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide });

    const empty = () => new THREE.BufferGeometry();
    this.selFill = new THREE.Mesh(empty(), this.selFillMat);
    this.edges = new THREE.LineSegments(empty(), this.edgeMat);
    this.selEdges = new THREE.LineSegments(empty(), this.selEdgeMat);
    this.points = new THREE.Points(empty(), this.pointMat);
    this.selPoints = new THREE.Points(empty(), this.selPointMat);
    this.selEdges.renderOrder = 3; this.selPoints.renderOrder = 4; this.points.renderOrder = 3; this.selFill.renderOrder = 2;
    for (const o of [this.selFill, this.edges, this.selEdges, this.points, this.selPoints]) { o.frustumCulled = false; this.scene.add(o); }

    this.grids = { xz: this.makeGrid('xz'), xy: this.makeGrid('xy'), zy: this.makeGrid('zy') };
    Object.values(this.grids).forEach((g) => this.scene.add(g));

    ed.on(['topology'], () => { this.rebuild(); this.onDirty(); });
    ed.on(['geometry', 'time', 'anim', 'skeleton'], () => { this.updatePositions(); this.onDirty(); });
    ed.on(['selection', 'tool'], () => { this.rebuildSelection(); this.updateWeights(); this.onDirty(); });
    ed.on('materials', () => { this.syncMaterials(); this.onDirty(); });
    ed.on('groups', () => { this.syncVisibility(); this.onDirty(); });
    ed.on(['view'], () => this.onDirty());
    this.scene.add(this.refRoot);
    ed.on(['view', 'topology', 'geometry', 'history'], () => { this.syncRefs(); this.onDirty(); });
    this.rebuild();
  }

  private makeGrid(plane: 'xz' | 'xy' | 'zy'): THREE.LineSegments {
    const half = 25, pos: number[] = [], col: number[] = [];
    const minor = new THREE.Color(0x2c3036), major = new THREE.Color(0x3d424a);
    const axisA = new THREE.Color(plane === 'zy' ? 0x4a90e2 : 0xe8555a); // first axis line
    const axisB = new THREE.Color(plane === 'xz' ? 0x4a90e2 : 0x7bc043); // second axis line
    const put = (a: number, b: number): [number, number, number] =>
      plane === 'xz' ? [a, 0, b] : plane === 'xy' ? [a, b, 0] : [0, b, a];
    for (let i = -half; i <= half; i++) {
      const lineB = i === 0 ? axisA : i % 5 === 0 ? major : minor;
      const lineA = i === 0 ? axisB : i % 5 === 0 ? major : minor;
      pos.push(...put(-half, i), ...put(half, i));
      col.push(lineB.r, lineB.g, lineB.b, lineB.r, lineB.g, lineB.b);
      pos.push(...put(i, -half), ...put(i, half));
      col.push(lineA.r, lineA.g, lineA.b, lineA.r, lineA.g, lineA.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const line = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, depthWrite: false }));
    line.frustumCulled = false;
    line.renderOrder = -1;
    return line;
  }

  // ---------- materials ----------
  /** Show a canvas being painted in place of a texture's saved image, in every material that uses it. */
  showLiveTexture(texId: number) {
    const live = liveTextures.get(texId);
    if (!live) return;
    for (const [key, tex] of this.texCache) {
      if (key.split(':')[2] !== String(texId)) continue;
      if (tex.image !== live) tex.image = live;
      tex.needsUpdate = true;
    }
    this.onDirty();
  }

  /** Each material keeps its own copy of a map, since each can tile it differently. */
  private texture(owner: number, slot: string, t: DocTexture, srgb: boolean): THREE.Texture {
    const key = texKey(owner, slot, t);
    let tex = this.texCache.get(key);
    if (!tex) {
      tex = makeDocTexture(t, srgb, () => this.onDirty());
      this.texCache.set(key, tex);
    }
    return tex;
  }

  private syncMaterials() {
    const m = ed.model;
    const live = new Set(m.materials.map((x) => x.id));
    for (const [id, mat] of this.pbr) if (!live.has(id)) { mat.dispose(); this.pbr.delete(id); }
    for (const [id, mat] of this.unlit) if (!live.has(id)) { mat.dispose(); this.unlit.delete(id); }
    const used = new Set<string>();
    for (const d of m.materials) for (const [slot, id] of Object.entries(d.maps)) {
      const t = m.textures.find((x) => x.id === id);
      if (t) used.add(texKey(d.id, slot, t));
    }
    for (const [key, tex] of this.texCache) if (!used.has(key)) { tex.dispose(); this.texCache.delete(key); }
    for (const d of m.materials) this.applyMaterial(d);
  }

  private applyMaterial(d: DocMaterial) {
    const texOf: TexOf = (slot, srgb) => {
      const id = d.maps[slot];
      const t = id === undefined ? undefined : ed.model.textures.find((x) => x.id === id);
      return t ? this.texture(d.id, slot, t, srgb) : null;
    };
    let mat: THREE.Material;
    if (d.unlit) {
      let u = this.unlit.get(d.id);
      if (!u) { u = newUnlitMaterial(); this.unlit.set(d.id, u); }
      fillUnlit(u, d, texOf);
      mat = u;
    } else {
      let lit = this.pbr.get(d.id);
      if (!lit) { lit = newLitMaterial(); this.pbr.set(d.id, lit); }
      fillLit(lit, d, texOf);
      mat = lit;
    }
    // Recompiling shaders is slow, so do it only when the shader actually has to change.
    const signature = shaderSignature(d, mat);
    if (this.shaderKeys.get(d.id) !== signature) {
      this.shaderKeys.set(d.id, signature);
      mat.needsUpdate = true;
    }
  }

  private syncVisibility() {
    for (const g of ed.model.groups) {
      const r = this.groups.get(g.id);
      if (r) r.mesh.visible = g.visible;
    }
  }

  // ---------- geometry ----------
  rebuild() {
    this.syncMaterials();
    for (const r of this.groups.values()) { r.mesh.geometry.dispose(); this.meshRoot.remove(r.mesh); }
    this.groups.clear();
    const m = ed.model;
    const byGroup = new Map<number, number[]>();
    m.faces.forEach((f, i) => {
      const l = byGroup.get(f.g);
      if (l) l.push(i); else byGroup.set(f.g, [i]);
    });
    for (const g of m.groups) {
      const faces = byGroup.get(g.id);
      if (!faces) continue;
      const corners: number[] = [], cornerFace: number[] = [], uvs: number[] = [];
      for (const fi of faces) {
        const f = m.faces[fi];
        const t = triangulateFace(m, f);
        for (const k of t) {
          corners.push(f.v[k]);
          cornerFace.push(fi);
          uvs.push(f.uv[k]?.[0] ?? 0, f.uv[k]?.[1] ?? 0);
        }
      }
      const geo = new THREE.BufferGeometry();
      const n = corners.length;
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const mesh = new THREE.Mesh(geo, this.fallbackMat);
      mesh.frustumCulled = false;
      mesh.visible = g.visible;
      this.meshRoot.add(mesh);
      this.groups.set(g.id, { id: g.id, mesh, corners: Int32Array.from(corners), cornerFace: Int32Array.from(cornerFace), faces });
    }
    this.updatePositions();
    this.rebuildWire();
  }

  /** Recompute positions + smoothing-group normals from current display positions. */
  updatePositions() {
    const m = ed.model;
    const P = ed.displayPositions();
    for (const r of this.groups.values()) {
      const { corners, cornerFace, faces, mesh } = r;
      const posA = mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const nrmA = mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const pos = posA.array as Float32Array, nrm = nrmA.array as Float32Array;
      for (let i = 0; i < corners.length; i++) {
        const v = corners[i] * 3;
        pos[i * 3] = P[v]; pos[i * 3 + 1] = P[v + 1]; pos[i * 3 + 2] = P[v + 2];
      }
      // Face normals, then accumulate per (vertex, smoothing group).
      const fn = new Map<number, [number, number, number]>();
      const acc = new Map<string, [number, number, number]>();
      for (const fi of faces) {
        const f = m.faces[fi];
        let x = 0, y = 0, z = 0;
        const c = f.v.length;
        for (let i = 0; i < c; i++) {
          const a = f.v[i] * 3, b = f.v[(i + 1) % c] * 3;
          x += (P[a + 1] - P[b + 1]) * (P[a + 2] + P[b + 2]);
          y += (P[a + 2] - P[b + 2]) * (P[a] + P[b]);
          z += (P[a] - P[b]) * (P[a + 1] + P[b + 1]);
        }
        fn.set(fi, [x, y, z]);
        if (f.s) {
          for (const v of f.v) {
            const k = `${v}|${f.s}`;
            const e = acc.get(k);
            if (e) { e[0] += x; e[1] += y; e[2] += z; } else acc.set(k, [x, y, z]);
          }
        }
      }
      for (let i = 0; i < corners.length; i++) {
        const f = m.faces[cornerFace[i]];
        const n = f.s ? acc.get(`${corners[i]}|${f.s}`)! : fn.get(cornerFace[i])!;
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        nrm[i * 3] = n[0] / l; nrm[i * 3 + 1] = n[1] / l; nrm[i * 3 + 2] = n[2] / l;
      }
      posA.needsUpdate = true; nrmA.needsUpdate = true;
    }
    this.updateWireBuffers();
    this.rebuildSelection();
    this.updateWeights();
  }

  /** Index pairs for all visible edges; vertices of visible groups. */
  edgeIndex: Int32Array = new Int32Array(0);
  visibleVerts: Int32Array = new Int32Array(0);

  private rebuildWire() {
    const m = ed.model;
    const hidden = new Set(m.groups.filter((g) => !g.visible).map((g) => g.id));
    const seen = new Set<string>();
    const pairs: number[] = [];
    const vis = new Set<number>();
    const faceVerts = new Set<number>();
    for (const f of m.faces) {
      for (let i = 0; i < f.v.length; i++) {
        const a = f.v[i], b = f.v[(i + 1) % f.v.length];
        faceVerts.add(a);
        if (hidden.has(f.g)) continue;
        vis.add(a);
        const k = a < b ? `${a}_${b}` : `${b}_${a}`;
        if (!seen.has(k)) { seen.add(k); pairs.push(a, b); }
      }
    }
    // Loose vertices stay visible and selectable.
    m.verts.forEach((_, i) => { if (!faceVerts.has(i)) vis.add(i); });
    this.edgeIndex = Int32Array.from(pairs);
    this.visibleVerts = Int32Array.from(vis);
    this.edges.geometry.dispose();
    this.points.geometry.dispose();
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pairs.length * 3), 3));
    this.edges.geometry = eg;
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(vis.size * 3), 3));
    this.points.geometry = pg;
    this.updateWireBuffers();
  }

  private updateWireBuffers() {
    const P = ed.displayPositions();
    const ep = this.edges.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (ep && ep.count === this.edgeIndex.length) {
      const arr = ep.array as Float32Array;
      for (let i = 0; i < this.edgeIndex.length; i++) {
        const v = this.edgeIndex[i] * 3;
        arr[i * 3] = P[v]; arr[i * 3 + 1] = P[v + 1]; arr[i * 3 + 2] = P[v + 2];
      }
      ep.needsUpdate = true;
    }
    const pp = this.points.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (pp && pp.count === this.visibleVerts.length) {
      const arr = pp.array as Float32Array;
      for (let i = 0; i < this.visibleVerts.length; i++) {
        const v = this.visibleVerts[i] * 3;
        arr[i * 3] = P[v]; arr[i * 3 + 1] = P[v + 1]; arr[i * 3 + 2] = P[v + 2];
      }
      pp.needsUpdate = true;
    }
  }

  rebuildSelection() {
    const m = ed.model;
    const P = ed.displayPositions();
    // Selected face fill + edges
    const tri: number[] = [];
    const facesSel = ed.mode === 'face' || ed.mode === 'group' ? ed.selFaces : null;
    const outline: number[] = [];
    if (facesSel) {
      facesSel.forEach((fi) => {
        const f = m.faces[fi];
        if (!f) return;
        const t = triangulateFace(m, f);
        for (const k of t) { const v = f.v[k] * 3; tri.push(P[v], P[v + 1], P[v + 2]); }
        for (let i = 0; i < f.v.length; i++) {
          const a = f.v[i] * 3, b = f.v[(i + 1) % f.v.length] * 3;
          outline.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]);
        }
      });
    }
    if (ed.mode === 'edge') {
      ed.selEdges.forEach((k) => {
        const [x, y] = parseEdge(k);
        const a = x * 3, b = y * 3;
        outline.push(P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2]);
      });
    }
    const replace = (o: THREE.Mesh | THREE.LineSegments | THREE.Points, arr: number[]) => {
      o.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      o.geometry = g;
    };
    replace(this.selFill, tri);
    replace(this.selEdges, outline);
    const pts: number[] = [];
    if (ed.mode === 'vertex') ed.selVerts.forEach((v) => { if (v * 3 < P.length) pts.push(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]); });
    replace(this.selPoints, pts);
  }

  /** Fill the color attribute with the active bone's weight heat map. */
  updateWeights() {
    const bone = ed.activeBone;
    for (const r of this.groups.values()) {
      const col = r.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      const arr = col.array as Float32Array;
      for (let i = 0; i < r.corners.length; i++) {
        const [a, b, c] = bone !== null ? heat(boneWeight(ed.model, r.corners[i], bone)) : [0.05, 0.1, 0.75];
        arr[i * 3] = a; arr[i * 3 + 1] = b; arr[i * 3 + 2] = c;
      }
      col.needsUpdate = true;
    }
  }

  private blockMats = new Map<string, THREE.MeshStandardMaterial>();
  private blockMaterial(color: string) {
    const key = `${color}:${ed.blockGhost}`;
    let mat = this.blockMats.get(key);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, side: THREE.DoubleSide, transparent: ed.blockGhost, opacity: ed.blockGhost ? 0.5 : 1 });
      this.blockMats.set(key, mat);
    }
    return mat;
  }

  // ---------- reference images ----------
  private refRoot = new THREE.Group();
  private refMeshes = new Map<number, { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; url: string; view: string }>();

  /** Match the image planes to the document. Each stands just behind the model along its view. */
  syncRefs() {
    const m = ed.model;
    const refs = m.refs ?? [];
    for (const [id, e] of this.refMeshes) {
      if (refs.some((r) => r.id === id)) continue;
      this.refRoot.remove(e.mesh);
      e.mat.map?.dispose();
      e.mat.dispose();
      e.mesh.geometry.dispose();
      this.refMeshes.delete(id);
    }
    for (const r of refs) {
      let e = this.refMeshes.get(r.id);
      if (!e || e.url !== r.url) {
        if (e) { this.refRoot.remove(e.mesh); e.mat.map?.dispose(); e.mat.dispose(); e.mesh.geometry.dispose(); }
        const img = new Image();
        const tex = new THREE.Texture(img);
        tex.colorSpace = THREE.SRGBColorSpace;
        img.onload = () => { tex.needsUpdate = true; this.onDirty(); };
        img.src = r.url;
        // Front faces only, so a picture isn't seen mirrored from behind.
        const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false, side: THREE.FrontSide });
        const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
        mesh.frustumCulled = false;
        this.refRoot.add(mesh);
        e = { mesh, mat, url: r.url, view: r.view };
        this.refMeshes.set(r.id, e);
      }
      e.view = r.view;
      const { right, up, dir } = viewBasis(r.view);
      let back = 0;
      for (const v of m.verts) back = Math.min(back, v.p[0] * dir.x + v.p[1] * dir.y + v.p[2] * dir.z);
      e.mesh.position.copy(right.clone().multiplyScalar(r.x)).addScaledVector(up, r.y).addScaledVector(dir, back - 0.02);
      e.mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, dir));
      e.mesh.scale.set((r.size * r.width) / Math.max(1, r.height), r.size, 1);
      e.mat.opacity = r.opacity;
      e.mat.depthTest = !r.over;
      e.mesh.renderOrder = r.over ? 10 : -5;
    }
  }

  /** Each picture shows in its own view, and optionally stands in the perspective view too. */
  showRefsFor(kind: string) {
    const refs = ed.model.refs ?? [];
    for (const r of refs) {
      const e = this.refMeshes.get(r.id);
      if (e) e.mesh.visible = r.visible && (kind === r.view || (kind === 'persp' && ed.refsInPersp));
    }
  }

  // ---------- per-pane state ----------
  applyShading(shading: Shading) {
    const m = ed.model;
    for (const r of this.groups.values()) {
      const g = m.groups.find((x) => x.id === r.id);
      if (!g) continue;
      const aux = g.kind === 'collision';
      r.mesh.visible = g.visible;
      switch (shading) {
        case 'wire': r.mesh.visible = false; break;
        case 'clay': r.mesh.material = this.clayMat; break;
        case 'block': r.mesh.material = this.blockMaterial(blockColorOf(g)); break;
        case 'checker': r.mesh.material = this.checkerMat; break;
        case 'normals': r.mesh.material = this.normalMat; break;
        case 'weights': r.mesh.material = this.weightMat; break;
        default:
          r.mesh.material = (g.material !== null ? (m.materials.find((x) => x.id === g.material)?.unlit ? this.unlit.get(g.material) : this.pbr.get(g.material)) : undefined) ?? this.fallbackMat;
          if (aux) r.mesh.visible = false;
      }
    }
    const wire = shading === 'wire';
    this.edgeMat.color.setHex(wire ? WIRE_LIGHT : WIRE_DARK);
    this.edgeMat.opacity = wire ? 0.85 : 0.55;
    const xray = wire || ed.xray;
    this.edgeMat.depthTest = !xray;
    this.selEdgeMat.depthTest = !xray;
    this.pointMat.depthTest = !xray;
    this.selPointMat.depthTest = !xray;
    this.selFillMat.depthTest = !xray;
    this.edges.visible = wire || ed.showWire;
    const showPts = ed.mode === 'vertex' && ed.showVerts;
    this.points.visible = showPts;
    this.selPoints.visible = showPts;
  }

  setGrid(which: 'xz' | 'xy' | 'zy' | null, scale: number) {
    (Object.keys(this.grids) as ('xz' | 'xy' | 'zy')[]).forEach((k) => {
      const g = this.grids[k];
      g.visible = ed.showGrid && k === which;
      g.scale.setScalar(scale);
    });
  }
}
