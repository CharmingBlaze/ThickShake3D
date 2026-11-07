// glTF 2.0 / GLB writer. Exports PBR materials, embedded textures, skins and animation clips.
import { flattenTrack } from '../core/anim';
import { faceNormalRaw, triangulateFace } from '../core/geom';
import { bonesTopo } from '../core/skeleton';
import type { Face, Group, Model, Texture, V3 } from '../core/types';

export interface ExportOptions {
  scale: number;
  animations: boolean;
  skeleton: boolean;
  includeLods: boolean;
  includeCollision: boolean;
  onlyVisible: boolean;
}

export const defaultExport: ExportOptions = { scale: 1, animations: true, skeleton: true, includeLods: true, includeCollision: true, onlyVisible: false };

export interface ExportMesh {
  group: Group;
  positions: number[]; normals: number[]; uvs: number[];
  joints: number[]; weights: number[];
  indices: number[];
}

export function exportGroups(m: Model, o: ExportOptions): Group[] {
  return m.groups.filter((g) => {
    if (o.onlyVisible && !g.visible) return false;
    if (g.kind === 'lod' && !o.includeLods) return false;
    if (g.kind === 'collision' && !o.includeCollision) return false;
    return true;
  });
}

/** Flatten a group into indexed triangles, splitting vertices at UV and normal seams. */
export function buildExportMesh(m: Model, group: Group, scale: number, jointIndex: Map<number, number> | null): ExportMesh | null {
  const faces: Face[] = m.faces.filter((f) => f.g === group.id);
  if (!faces.length) return null;
  // Normal per (vertex, smoothing group), area weighted.
  const acc = new Map<string, V3>();
  const fn = new Map<Face, V3>();
  for (const f of faces) {
    const n = faceNormalRaw(m, f);
    fn.set(f, n);
    if (f.s) for (const v of f.v) {
      const k = `${v}|${f.s}`;
      const e = acc.get(k);
      if (e) { e[0] += n[0]; e[1] += n[1]; e[2] += n[2]; } else acc.set(k, [...n] as V3);
    }
  }
  const out: ExportMesh = { group, positions: [], normals: [], uvs: [], joints: [], weights: [], indices: [] };
  const index = new Map<string, number>();
  for (const f of faces) {
    const tris = triangulateFace(m, f);
    const raw = fn.get(f)!;
    for (const c of tris) {
      const v = f.v[c];
      const uv = f.uv[c] ?? [0, 0];
      const n = f.s ? acc.get(`${v}|${f.s}`)! : raw;
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      const nx = n[0] / l, ny = n[1] / l, nz = n[2] / l;
      const key = `${v}|${uv[0].toFixed(5)}|${uv[1].toFixed(5)}|${nx.toFixed(3)}|${ny.toFixed(3)}|${nz.toFixed(3)}`;
      let i = index.get(key);
      if (i === undefined) {
        i = out.positions.length / 3;
        index.set(key, i);
        const p = m.verts[v].p;
        out.positions.push(p[0] * scale, p[1] * scale, p[2] * scale);
        out.normals.push(nx, ny, nz);
        out.uvs.push(uv[0], uv[1]);
        if (jointIndex) {
          const w = (m.verts[v].w ?? []).filter((x) => jointIndex.has(x[0])).slice(0, 4);
          const total = w.reduce((s, x) => s + x[1], 0);
          for (let k = 0; k < 4; k++) {
            if (total > 0 && w[k]) { out.joints.push(jointIndex.get(w[k][0])!); out.weights.push(w[k][1] / total); }
            else if (total <= 0 && k === 0) { out.joints.push(0); out.weights.push(1); }
            else { out.joints.push(0); out.weights.push(0); }
          }
        }
      }
      out.indices.push(i);
    }
  }
  return out;
}

/** Per-vertex tangents from UV gradients, orthonormalised against the normal; w holds handedness. */
export function computeTangents(em: ExportMesh): Float32Array {
  const n = em.positions.length / 3;
  const tan = new Float64Array(n * 3), bit = new Float64Array(n * 3);
  const P = em.positions, U = em.uvs, N = em.normals, I = em.indices;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], b = I[t + 1], c = I[t + 2];
    const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
    const du1 = U[b * 2] - U[a * 2], dv1 = U[b * 2 + 1] - U[a * 2 + 1];
    const du2 = U[c * 2] - U[a * 2], dv2 = U[c * 2 + 1] - U[a * 2 + 1];
    const det = du1 * dv2 - du2 * dv1;
    if (Math.abs(det) < 1e-12) continue;
    const r = 1 / det;
    for (const v of [a, b, c]) {
      tan[v * 3] += (e1x * dv2 - e2x * dv1) * r; tan[v * 3 + 1] += (e1y * dv2 - e2y * dv1) * r; tan[v * 3 + 2] += (e1z * dv2 - e2z * dv1) * r;
      bit[v * 3] += (e2x * du1 - e1x * du2) * r; bit[v * 3 + 1] += (e2y * du1 - e1y * du2) * r; bit[v * 3 + 2] += (e2z * du1 - e1z * du2) * r;
    }
  }
  const out = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    const nx = N[i * 3], ny = N[i * 3 + 1], nz = N[i * 3 + 2];
    let tx = tan[i * 3], ty = tan[i * 3 + 1], tz = tan[i * 3 + 2];
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d; ty -= ny * d; tz -= nz * d;
    let l = Math.hypot(tx, ty, tz);
    if (l < 1e-9) {
      // No usable UV gradient: any unit vector perpendicular to the normal is valid.
      if (Math.abs(nx) < 0.9) { tx = 0; ty = nz; tz = -ny; } else { tx = -nz; ty = 0; tz = nx; }
      l = Math.hypot(tx, ty, tz);
    }
    tx /= l; ty /= l; tz /= l;
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    const w = cx * bit[i * 3] + cy * bit[i * 3 + 1] + cz * bit[i * 3 + 2] < 0 ? -1 : 1;
    out.set([tx, ty, tz, w], i * 4);
  }
  return out;
}

class BinBuilder {
  chunks: Uint8Array[] = [];
  length = 0;
  views: any[] = [];
  accessors: any[] = [];

  addView(bytes: Uint8Array, target?: number): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    const view: any = { buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength };
    if (target) view.target = target;
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    this.views.push(view);
    return this.views.length - 1;
  }

  addAccessor(arr: Float32Array | Uint16Array | Uint32Array, type: string, count: number, opts: { target?: number; minmax?: boolean; normalized?: boolean } = {}): number {
    const componentType = arr instanceof Float32Array ? 5126 : arr instanceof Uint16Array ? 5123 : 5125;
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const acc: any = { bufferView: this.addView(bytes, opts.target), componentType, count, type };
    if (opts.minmax) {
      const n = arr.length / count;
      const min = new Array(n).fill(Infinity), max = new Array(n).fill(-Infinity);
      for (let i = 0; i < count; i++) for (let k = 0; k < n; k++) {
        const x = arr[i * n + k];
        if (x < min[k]) min[k] = x;
        if (x > max[k]) max[k] = x;
      }
      acc.min = min; acc.max = max;
    }
    this.accessors.push(acc);
    return this.accessors.length - 1;
  }

  merged(): Uint8Array {
    const out = new Uint8Array(this.length);
    let o = 0;
    for (const c of this.chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}

function dataUrlBytes(url: string): { mime: string; bytes: Uint8Array } {
  const comma = url.indexOf(',');
  const head = url.slice(0, comma);
  const mime = /data:([^;]+)/.exec(head)?.[1] ?? 'image/png';
  const bin = atob(url.slice(comma + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime, bytes };
}

function hexToLinear(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  const f = (c: number) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

export function buildGltf(m: Model, o: ExportOptions): { json: any; bin: Uint8Array } {
  const b = new BinBuilder();
  const json: any = {
    asset: { version: '2.0', generator: 'ThickShake 1.0' },
    scene: 0, scenes: [{ name: 'Scene', nodes: [] }],
    nodes: [], meshes: [],
  };
  const sceneNodes: number[] = json.scenes[0].nodes;

  // Textures + materials
  const textures: any[] = [], images: any[] = [];
  const textureIndex = new Map<number, number>();
  const texOf = (t?: Texture) => {
    if (!t) return undefined;
    let i = textureIndex.get(t.id);
    if (i === undefined) {
      const { mime, bytes } = dataUrlBytes(t.url);
      images.push({ name: t.name, mimeType: mime, bufferView: b.addView(bytes) });
      // Pixel art keeps its pixels sharp in engines too: sampler 1 is nearest-neighbour.
      textures.push({ source: images.length - 1, sampler: t.pixelated ? 1 : 0 });
      i = textures.length - 1;
      textureIndex.set(t.id, i);
    }
    return i;
  };
  const tex = (id?: number) => (id === undefined ? undefined : texOf(m.textures.find((x) => x.id === id)));
  const matIndex = new Map<number, number>();
  const materials: any[] = [];
  const extensionsUsed = new Set<string>();
  for (const d of m.materials) {
    const [r, g, bl] = hexToLinear(d.color);
    const mat: any = {
      name: d.name,
      pbrMetallicRoughness: { baseColorFactor: [r, g, bl, d.alpha], metallicFactor: d.metallic, roughnessFactor: d.roughness },
    };
    const ext = (name: string, value: object) => {
      mat.extensions ??= {};
      mat.extensions[name] = value;
      extensionsUsed.add(name);
    };
    // Tiling, shift and turn travel with every map.
    const su = d.uvScale?.[0] ?? 1, sv = d.uvScale?.[1] ?? 1, ou = d.uvOffset?.[0] ?? 0, ov = d.uvOffset?.[1] ?? 0, rot = d.uvRotation ?? 0;
    const placed = su !== 1 || sv !== 1 || ou !== 0 || ov !== 0 || rot !== 0;
    const info = (index: number): any => {
      if (!placed) return { index };
      extensionsUsed.add('KHR_texture_transform');
      return { index, extensions: { KHR_texture_transform: { offset: [ou, ov], rotation: rot, scale: [su, sv] } } };
    };
    const base = tex(d.maps.base), orm = tex(d.maps.orm), nrm = tex(d.maps.normal), emi = tex(d.maps.emissive);
    if (base !== undefined) mat.pbrMetallicRoughness.baseColorTexture = info(base);
    if (orm !== undefined) {
      mat.pbrMetallicRoughness.metallicRoughnessTexture = info(orm);
      mat.occlusionTexture = info(orm);
      if (d.occlusionStrength !== undefined && d.occlusionStrength !== 1) mat.occlusionTexture.strength = d.occlusionStrength;
    }
    if (nrm !== undefined) {
      mat.normalTexture = info(nrm);
      if (d.normalScale !== undefined && d.normalScale !== 1) mat.normalTexture.scale = d.normalScale;
    }
    const [er, eg, eb] = hexToLinear(d.emissive);
    if (er + eg + eb > 0 || emi !== undefined) {
      const s = Math.min(1, d.emissiveStrength);
      mat.emissiveFactor = emi !== undefined && er + eg + eb === 0 ? [1, 1, 1] : [er * s, eg * s, eb * s];
      if (d.emissiveStrength > 1) ext('KHR_materials_emissive_strength', { emissiveStrength: d.emissiveStrength });
    }
    if (emi !== undefined) mat.emissiveTexture = info(emi);
    if (d.doubleSided) mat.doubleSided = true;
    if (d.alphaMode === 'blend' || d.alpha < 1) mat.alphaMode = 'BLEND';
    else if (d.alphaMode === 'mask') { mat.alphaMode = 'MASK'; mat.alphaCutoff = d.alphaCutoff ?? 0.5; }
    if (d.unlit) ext('KHR_materials_unlit', {});
    else {
      if (d.clearcoat) ext('KHR_materials_clearcoat', { clearcoatFactor: d.clearcoat, clearcoatRoughnessFactor: d.clearcoatRoughness ?? 0.1 });
      if (d.transmission) ext('KHR_materials_transmission', { transmissionFactor: d.transmission });
      if (d.ior !== undefined && d.ior !== 1.5) ext('KHR_materials_ior', { ior: d.ior });
      if (d.sheen) {
        const [sr, sg, sb] = hexToLinear(d.sheenColor ?? '#ffffff');
        ext('KHR_materials_sheen', { sheenColorFactor: [sr * d.sheen, sg * d.sheen, sb * d.sheen], sheenRoughnessFactor: Math.max(0.2, d.roughness) });
      }
    }
    matIndex.set(d.id, materials.length);
    materials.push(mat);
  }
  if (extensionsUsed.size) json.extensionsUsed = [...extensionsUsed];

  // Skeleton
  const useSkin = o.skeleton && m.bones.length > 0;
  const ordered = useSkin ? bonesTopo(m) : [];
  const jointIndex = useSkin ? new Map(ordered.map((x, i) => [x.id, i])) : null;
  const boneNode = new Map<number, number>();
  if (useSkin) {
    const byId = new Map(m.bones.map((x) => [x.id, x]));
    for (const bone of ordered) {
      const parent = bone.parent !== null ? byId.get(bone.parent) : undefined;
      const ph: V3 = parent ? parent.head : [0, 0, 0];
      const node = {
        name: bone.name,
        translation: [(bone.head[0] - ph[0]) * o.scale, (bone.head[1] - ph[1]) * o.scale, (bone.head[2] - ph[2]) * o.scale],
        children: [] as number[],
      };
      boneNode.set(bone.id, json.nodes.length);
      json.nodes.push(node);
    }
    for (const bone of ordered) {
      const idx = boneNode.get(bone.id)!;
      if (bone.parent !== null && boneNode.has(bone.parent)) json.nodes[boneNode.get(bone.parent)!].children.push(idx);
      else sceneNodes.push(idx);
    }
    for (const bone of ordered) if (!json.nodes[boneNode.get(bone.id)!].children.length) delete json.nodes[boneNode.get(bone.id)!].children;
    const ibm = new Float32Array(16 * ordered.length);
    ordered.forEach((bone, i) => {
      ibm.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -bone.head[0] * o.scale, -bone.head[1] * o.scale, -bone.head[2] * o.scale, 1], i * 16);
    });
    json.skins = [{
      name: 'Armature',
      joints: ordered.map((x) => boneNode.get(x.id)!),
      inverseBindMatrices: b.addAccessor(ibm, 'MAT4', ordered.length),
      skeleton: boneNode.get(ordered.find((x) => x.parent === null)?.id ?? ordered[0].id),
    }];
  }

  // Meshes
  for (const group of exportGroups(m, o)) {
    const skinned = useSkin && group.kind !== 'collision';
    const em = buildExportMesh(m, group, o.scale, skinned ? jointIndex : null);
    if (!em) continue;
    const count = em.positions.length / 3;
    const attributes: any = {
      POSITION: b.addAccessor(new Float32Array(em.positions), 'VEC3', count, { target: 34962, minmax: true }),
      NORMAL: b.addAccessor(new Float32Array(em.normals), 'VEC3', count, { target: 34962 }),
      TEXCOORD_0: b.addAccessor(new Float32Array(em.uvs), 'VEC2', count, { target: 34962 }),
    };
    // Normal maps need tangents to shade the same in every engine.
    const usesNormalMap = m.materials.find((x) => x.id === group.material)?.maps.normal !== undefined;
    if (usesNormalMap) attributes.TANGENT = b.addAccessor(computeTangents(em), 'VEC4', count, { target: 34962 });
    if (skinned) {
      attributes.JOINTS_0 = b.addAccessor(new Uint16Array(em.joints), 'VEC4', count, { target: 34962 });
      attributes.WEIGHTS_0 = b.addAccessor(new Float32Array(em.weights), 'VEC4', count, { target: 34962 });
    }
    const indices = b.addAccessor(new Uint32Array(em.indices), 'SCALAR', em.indices.length, { target: 34963 });
    const prim: any = { attributes, indices, mode: 4 };
    if (group.material !== null && matIndex.has(group.material)) prim.material = matIndex.get(group.material);
    json.meshes.push({ name: group.name, primitives: [prim] });
    const node: any = { name: group.kind === 'collision' ? `UCX_${group.name}` : group.name, mesh: json.meshes.length - 1 };
    if (skinned) node.skin = 0;
    sceneNodes.push(json.nodes.length);
    json.nodes.push(node);
  }

  // Animation
  if (useSkin && o.animations && m.clips.length) {
    const byId = new Map(m.bones.map((x) => [x.id, x]));
    const anims: any[] = [];
    for (const clip of m.clips) {
      const samplers: any[] = [], channels: any[] = [];
      const addChannel = (node: number, path: string, frames: number[], values: Float32Array, type: string) => {
        const times = new Float32Array(frames.map((f) => f / clip.fps));
        samplers.push({ input: b.addAccessor(times, 'SCALAR', times.length, { minmax: true }), output: b.addAccessor(values, type, frames.length), interpolation: 'LINEAR' });
        channels.push({ sampler: samplers.length - 1, target: { node, path } });
      };
      for (const [idStr, curved] of Object.entries(clip.tracks)) {
        // glTF channels here are linear, so eased and held stretches are written as the motion they produce.
        const track = flattenTrack(curved);
        const id = +idStr;
        const node = boneNode.get(id);
        const bone = byId.get(id);
        if (node === undefined || !bone) continue;
        const parent = bone.parent !== null ? byId.get(bone.parent) : undefined;
        const ph: V3 = parent ? parent.head : [0, 0, 0];
        if (track.pos.length) {
          const vals = new Float32Array(track.pos.length * 3);
          track.pos.forEach((k, i) => {
            vals[i * 3] = (bone.head[0] - ph[0] + k.v[0]) * o.scale;
            vals[i * 3 + 1] = (bone.head[1] - ph[1] + k.v[1]) * o.scale;
            vals[i * 3 + 2] = (bone.head[2] - ph[2] + k.v[2]) * o.scale;
          });
          addChannel(node, 'translation', track.pos.map((k) => k.f), vals, 'VEC3');
        }
        if (track.rot.length) {
          const vals = new Float32Array(track.rot.length * 4);
          track.rot.forEach((k, i) => vals.set(k.v, i * 4));
          addChannel(node, 'rotation', track.rot.map((k) => k.f), vals, 'VEC4');
        }
      }
      if (channels.length) anims.push({ name: clip.name, samplers, channels });
    }
    if (anims.length) json.animations = anims;
  }

  if (materials.length) json.materials = materials;
  if (textures.length) {
    json.textures = textures; json.images = images;
    json.samplers = [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }, { magFilter: 9728, minFilter: 9728, wrapS: 10497, wrapT: 10497 }];
  }
  if (!json.meshes.length) delete json.meshes;
  if (!json.nodes.length) delete json.nodes;
  json.accessors = b.accessors;
  json.bufferViews = b.views;
  const bin = b.merged();
  json.buffers = [{ byteLength: bin.byteLength }];
  return { json, bin };
}

export function exportGLB(m: Model, o: ExportOptions): Uint8Array {
  const { json, bin } = buildGltf(m, o);
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (text.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;
  const total = 12 + 8 + text.length + jsonPad + 8 + bin.length + binPad;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, text.length + jsonPad, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + text.length + jsonPad);
  const bo = 20 + text.length + jsonPad;
  dv.setUint32(bo, bin.length + binPad, true);
  dv.setUint32(bo + 4, 0x004e4942, true);
  out.set(bin, bo + 8);
  return out;
}

/** Separate .gltf + .bin pair. */
export function exportGltfPair(m: Model, o: ExportOptions, binName: string): { gltf: Uint8Array; bin: Uint8Array } {
  const { json, bin } = buildGltf(m, o);
  json.buffers[0].uri = binName;
  return { gltf: new TextEncoder().encode(JSON.stringify(json, null, 2)), bin };
}
