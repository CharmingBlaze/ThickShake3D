// Imports anything Three.js can load (glTF, FBX, DAE, STL, PLY) into the ThickShake document,
// plus the native project and hand-written OBJ/MS3D paths.
import * as THREE from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { autoSmooth, removeDegenerate } from '../core/ops';
import { qConj, qMul, qNorm, qRotate } from '../core/skeleton';
import { emptyModel, makeGroup, makeMaterial, newId, type Clip, type Material as DocMat, type Model, type Q, type V2, type V3 } from '../core/types';
import { importMS3D } from './ms3d';
import { importOBJ } from './simple';

export const IMPORT_EXTS = ['glb', 'gltf', 'fbx', 'dae', 'obj', 'stl', 'ply', 'ms3d'];

export async function importFile(name: string, data: ArrayBuffer): Promise<Model> {
  const ext = name.split('.').pop()!.toLowerCase();
  const stem = name.replace(/\.[^.]+$/, '');
  const text = () => new TextDecoder().decode(data);
  switch (ext) {
    case 'ms3d': return importMS3D(data, stem);
    case 'obj': return importOBJ(text(), stem);
    case 'stl': return fromGeometry(new STLLoader().parse(data), stem);
    case 'ply': return fromGeometry(new PLYLoader().parse(data as any), stem);
    case 'glb': case 'gltf': {
      const g = await new GLTFLoader().parseAsync(data, '');
      return fromObject(g.scene, g.animations, stem);
    }
    case 'fbx': {
      const o = new FBXLoader().parse(data, '');
      return fromObject(o, (o as any).animations ?? [], stem);
    }
    case 'dae': {
      const c = new ColladaLoader().parse(text(), '') as any;
      return fromObject(c.scene, c.scene?.animations ?? c.animations ?? [], stem);
    }
    default: throw new Error(`Unsupported file type: .${ext}`);
  }
}

function fromGeometry(geo: THREE.BufferGeometry, name: string): Model {
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
  mesh.name = name;
  return fromObject(mesh, [], name);
}

function textureToUrl(tex: THREE.Texture | null | undefined): { url: string; w: number; h: number } | null {
  const img = tex?.image as (HTMLImageElement | HTMLCanvasElement | ImageBitmap | undefined);
  const w = (img as any)?.width, h = (img as any)?.height;
  if (!img || !w || !h) return null;
  try {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(img as CanvasImageSource, 0, 0);
    return { url: c.toDataURL('image/png'), w, h };
  } catch { return null; }
}

function fromObject(root: THREE.Object3D, clips: THREE.AnimationClip[], name: string): Model {
  const m = emptyModel();
  root.updateMatrixWorld(true);
  const matMap = new Map<THREE.Material, DocMat>();
  const texMap = new Map<THREE.Texture, number>();
  const docTex = (t: THREE.Texture | null | undefined, label: string) => {
    if (!t) return undefined;
    if (texMap.has(t)) return texMap.get(t);
    const r = textureToUrl(t);
    if (!r) return undefined;
    const id = newId(m);
    // Nearest-neighbour sampling in the file means pixel art; keep it sharp.
    const pixelated = t.magFilter === THREE.NearestFilter ? true : undefined;
    m.textures.push({ id, name: t.name || label, url: r.url, width: r.w, height: r.h, ...(pixelated ? { pixelated } : {}) });
    texMap.set(t, id);
    return id;
  };
  const docMat = (src: THREE.Material): DocMat => {
    let d = matMap.get(src);
    if (d) return d;
    d = makeMaterial(m, src.name || `Material ${m.materials.length + 1}`);
    const s = src as any;
    if (s.color) d.color = `#${s.color.getHexString()}`;
    if (s.emissive) d.emissive = `#${s.emissive.getHexString()}`;
    if (typeof s.emissiveIntensity === 'number') d.emissiveStrength = s.emissiveIntensity;
    if (typeof s.metalness === 'number') d.metallic = s.metalness;
    if (typeof s.roughness === 'number') d.roughness = s.roughness;
    d.alpha = src.opacity ?? 1;
    d.doubleSided = src.side === THREE.DoubleSide;
    d.alphaMode = src.transparent ? 'blend' : src.alphaTest > 0 ? 'mask' : 'opaque';
    const base = docTex(s.map, `${d.name} base`); if (base !== undefined) d.maps.base = base;
    const nrm = docTex(s.normalMap, `${d.name} normal`); if (nrm !== undefined) d.maps.normal = nrm;
    const orm = docTex(s.roughnessMap ?? s.metalnessMap, `${d.name} orm`); if (orm !== undefined) d.maps.orm = orm;
    const emi = docTex(s.emissiveMap, `${d.name} emissive`); if (emi !== undefined) d.maps.emissive = emi;
    // The loader reports extras only where a file set them, so anything left at its default stays unset.
    if (s.isMeshBasicMaterial) d.unlit = true;
    if (src.alphaTest > 0) d.alphaCutoff = src.alphaTest;
    if (s.normalMap && s.normalScale && s.normalScale.x !== 1) d.normalScale = s.normalScale.x;
    if (s.aoMap && typeof s.aoMapIntensity === 'number' && s.aoMapIntensity !== 1) d.occlusionStrength = s.aoMapIntensity;
    if (s.clearcoat > 0) { d.clearcoat = s.clearcoat; d.clearcoatRoughness = s.clearcoatRoughness; }
    if (s.transmission > 0) d.transmission = s.transmission;
    if (typeof s.ior === 'number' && Math.abs(s.ior - 1.5) > 1e-4) d.ior = s.ior;
    if (s.sheen > 0 && s.sheenColor) {
      // A file stores sheen as one coloured value, which comes back apart as a colour and a strength.
      const peak = Math.max(s.sheenColor.r, s.sheenColor.g, s.sheenColor.b, 1e-4);
      d.sheen = Math.min(1, peak * s.sheen);
      d.sheenColor = `#${s.sheenColor.clone().multiplyScalar(1 / peak).getHexString()}`;
    }
    const placed: THREE.Texture | null = s.map ?? s.normalMap ?? s.roughnessMap ?? s.emissiveMap ?? null;
    if (placed) {
      if (placed.repeat.x !== 1 || placed.repeat.y !== 1) d.uvScale = [placed.repeat.x, placed.repeat.y];
      if (placed.offset.x !== 0 || placed.offset.y !== 0) d.uvOffset = [placed.offset.x, placed.offset.y];
      if (placed.rotation !== 0) d.uvRotation = placed.rotation;
    }
    matMap.set(src, d);
    return d;
  };

  // Skeleton: one bone per THREE.Bone, across every skin.
  let skeleton: THREE.Skeleton | null = null;
  const boneId = new Map<THREE.Bone, number>();
  const inverses = new Map<THREE.Bone, THREE.Matrix4>();
  root.traverse((o) => {
    const sk = (o as THREE.SkinnedMesh).skeleton;
    if ((o as THREE.SkinnedMesh).isSkinnedMesh && sk) {
      skeleton = skeleton ?? sk;
      sk.bones.forEach((b, i) => { if (!boneId.has(b)) { boneId.set(b, newId(m)); inverses.set(b, sk.boneInverses[i]); } });
    }
  });
  const heads = new Map<THREE.Bone, V3>();
  boneId.forEach((_, b) => {
    const t = new THREE.Vector3().setFromMatrixPosition(inverses.get(b)!.clone().invert());
    heads.set(b, [t.x, t.y, t.z]);
  });
  boneId.forEach((id, b) => {
    const parent = b.parent as THREE.Bone;
    m.bones.push({ id, name: b.name || `Bone ${m.bones.length}`, parent: boneId.get(parent) ?? null, head: heads.get(b)! });
  });

  // Meshes
  const tmp = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    if (!pos) return;
    const skinned = (mesh as THREE.SkinnedMesh).isSkinnedMesh ? (mesh as THREE.SkinnedMesh) : null;
    const xform = skinned ? skinned.bindMatrix : mesh.matrixWorld;
    const uv = geo.getAttribute('uv');
    const si = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
    const index = geo.getIndex();
    const welded = new Map<string, number>();
    const local = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(xform);
      let skinKey = '';
      if (si && sw) skinKey = `|${si.getX(i)},${si.getY(i)},${si.getZ(i)},${si.getW(i)}`;
      const k = `${tmp.x.toFixed(5)},${tmp.y.toFixed(5)},${tmp.z.toFixed(5)}${skinKey}`;
      let v = welded.get(k);
      if (v === undefined) {
        v = m.verts.length;
        welded.set(k, v);
        const vertex: Model['verts'][number] = { p: [tmp.x, tmp.y, tmp.z] };
        if (skinned && si && sw) {
          const list: [number, number][] = [];
          const bones = skinned.skeleton.bones;
          const put = (b: number, w: number) => { if (w > 1e-4 && bones[b]) list.push([boneId.get(bones[b])!, w]); };
          put(si.getX(i), sw.getX(i)); put(si.getY(i), sw.getY(i)); put(si.getZ(i), sw.getZ(i)); put(si.getW(i), sw.getW(i));
          if (list.length) vertex.w = list;
        }
        m.verts.push(vertex);
      }
      local[i] = v;
    }

    const srcMats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }];
    const mats = srcMats.map(docMat);
    const byMat = new Map<number, number>();
    const flipV = srcMats.some((x) => (x as any).map?.flipY);
    const startFace = m.faces.length;
    // A mirroring transform (negative scale) turns the triangles inside out; wind them back.
    const mirrored = xform.determinant() < 0;
    for (const g of groups) {
      const mi = g.materialIndex ?? 0;
      if (!byMat.has(mi)) {
        const nm = mesh.name || (o.parent?.name ?? name) || 'Mesh';
        const gid = makeGroup(m, unique(m, groups.length > 1 ? `${nm}_${mi}` : nm), (mats[mi] ?? mats[0])?.id ?? null).id;
        byMat.set(mi, gid);
      }
      const gid = byMat.get(mi)!;
      const end = Math.min(g.start + g.count, index ? index.count : pos.count);
      for (let i = g.start; i + 2 < end; i += 3) {
        const c = (mirrored ? [0, 2, 1] : [0, 1, 2]).map((k) => (index ? index.getX(i + k) : i + k));
        const uvs: V2[] = c.map((x) => (uv ? [uv.getX(x), flipV ? 1 - uv.getY(x) : uv.getY(x)] : [0, 0]));
        m.faces.push({ v: c.map((x) => local[x]), uv: uvs, g: gid, s: 0 });
      }
    }
    // Hard edges from angle; imported normals often split every vertex otherwise.
    const added = new Set<number>();
    for (let f = startFace; f < m.faces.length; f++) added.add(f);
    autoSmooth(m, added, 40);
  });

  removeDegenerate(m);
  m.groups = m.groups.filter((g) => m.faces.some((f) => f.g === g.id));
  if (!m.materials.length && m.groups.length) { /* leave unassigned */ }

  // Animation: bake each clip against our identity-rest bones.
  if (boneId.size && clips.length) {
    const mixer = new THREE.AnimationMixer(root);
    const bones = [...boneId.keys()];
    for (const c of clips) {
      const fps = 30;
      const last = Math.max(1, Math.ceil(c.duration * fps));
      const clip: Clip = { id: newId(m), name: c.name || 'Take', fps, length: last, loop: true, tracks: {} };
      bones.forEach((b) => { clip.tracks[boneId.get(b)!] = { pos: [], rot: [] }; });
      const action = mixer.clipAction(c);
      action.play();
      for (let f = 0; f <= last; f++) {
        mixer.setTime(f / fps);
        root.updateMatrixWorld(true);
        const world = new Map<THREE.Bone, { rot: Q; pos: V3 }>();
        for (const b of bones) {
          // S = boneWorld * inverseBind; our bone world = S * T(head).
          const S = new THREE.Matrix4().multiplyMatrices(b.matrixWorld, inverses.get(b)!);
          const head = heads.get(b)!;
          const W = S.clone().multiply(new THREE.Matrix4().makeTranslation(head[0], head[1], head[2]));
          const t = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
          W.decompose(t, q, s);
          world.set(b, { rot: qNorm([q.x, q.y, q.z, q.w]), pos: [t.x, t.y, t.z] });
        }
        for (const b of bones) {
          const wb = world.get(b)!;
          const parent = boneId.has(b.parent as THREE.Bone) ? (b.parent as THREE.Bone) : null;
          const pr: Q = parent ? world.get(parent)!.rot : [0, 0, 0, 1];
          const pp: V3 = parent ? world.get(parent)!.pos : [0, 0, 0];
          const ph: V3 = parent ? heads.get(parent)! : [0, 0, 0];
          const head = heads.get(b)!;
          const local = qNorm(qMul(qConj(pr), wb.rot));
          const d = qRotate(qConj(pr), [wb.pos[0] - pp[0], wb.pos[1] - pp[1], wb.pos[2] - pp[2]]);
          const tr = clip.tracks[boneId.get(b)!];
          tr.rot.push({ f, v: local });
          tr.pos.push({ f, v: [d[0] - (head[0] - ph[0]), d[1] - (head[1] - ph[1]), d[2] - (head[2] - ph[2])] });
        }
      }
      action.stop();
      simplifyClip(clip);
      m.clips.push(clip);
    }
  }
  return m;
}

function unique(m: Model, n: string) {
  let out = n, i = 1;
  while (m.groups.some((g) => g.name === out)) out = `${n}.${String(i++).padStart(3, '0')}`;
  return out;
}

/** Remove keys that linear interpolation already reproduces. */
export function simplifyClip(c: Clip, eps = 1e-4) {
  for (const t of Object.values(c.tracks)) {
    t.pos = reduce(t.pos, eps);
    t.rot = reduce(t.rot, eps);
    if (t.pos.length === 1 && t.pos[0].v.every((x) => Math.abs(x) < eps)) t.pos = [];
    if (t.rot.length === 1 && Math.abs(Math.abs(t.rot[0].v[3]) - 1) < eps) t.rot = [];
  }
}

function reduce<T extends number[]>(keys: { f: number; v: T }[], eps: number) {
  if (keys.length < 3) {
    if (keys.length === 2 && keys[0].v.every((x, i) => Math.abs(x - keys[1].v[i]) < eps)) return [keys[0]];
    return keys;
  }
  const out = [keys[0]];
  for (let i = 1; i < keys.length - 1; i++) {
    const a = out[out.length - 1], b = keys[i], c = keys[i + 1];
    const t = (b.f - a.f) / (c.f - a.f);
    if (!b.v.every((x, k) => Math.abs(a.v[k] + (c.v[k] - a.v[k]) * t - x) < eps)) out.push(b);
  }
  out.push(keys[keys.length - 1]);
  if (out.length === 2 && out[0].v.every((x, i) => Math.abs(x - out[1].v[i]) < eps)) return [out[0]];
  return out;
}

/** Merge an imported model into an existing one, remapping all ids and indices. */
export function mergeInto(dst: Model, src: Model) {
  const vBase = dst.verts.length;
  const idMap = new Map<number, number>();
  const nid = (old: number) => {
    let n = idMap.get(old);
    if (n === undefined) { n = newId(dst); idMap.set(old, n); }
    return n;
  };
  for (const t of src.textures) dst.textures.push({ ...t, id: nid(t.id) });
  for (const x of src.materials) {
    const maps: DocMat['maps'] = {};
    (Object.keys(x.maps) as (keyof DocMat['maps'])[]).forEach((k) => { maps[k] = nid(x.maps[k]!); });
    dst.materials.push({ ...x, id: nid(x.id), maps });
  }
  for (const g of src.groups) {
    dst.groups.push({ ...g, id: nid(g.id), material: g.material !== null ? nid(g.material) : null, name: unique(dst, g.name) });
  }
  for (const b of src.bones) dst.bones.push({ ...b, id: nid(b.id), parent: b.parent !== null ? nid(b.parent) : null });
  for (const v of src.verts) dst.verts.push({ p: v.p, w: v.w?.map(([b, w]) => [nid(b), w]) });
  let smoothBase = 0;
  for (const f of dst.faces) if (f.s > smoothBase) smoothBase = f.s;
  for (const f of src.faces) dst.faces.push({ v: f.v.map((v) => v + vBase), uv: f.uv, g: nid(f.g), s: f.s ? f.s + smoothBase : 0 });
  for (const c of src.clips) {
    const tracks: Clip['tracks'] = {};
    Object.entries(c.tracks).forEach(([k, t]) => { tracks[nid(+k)] = t; });
    dst.clips.push({ ...c, id: newId(dst), tracks });
  }
}
