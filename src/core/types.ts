// The ThickShake document model. Plain data only, so undo snapshots and project
// files are just copies of it. World space: right-handed, +Y up, 1 unit = 1 metre.

export type V2 = [number, number];
export type V3 = [number, number, number];
export type Q = [number, number, number, number];

export interface Vertex {
  p: V3;
  /** Skin influences as [boneId, weight] pairs. Up to 4; normalised on write. */
  w?: [number, number][];
}

export interface Face {
  /** Vertex indices, counter-clockwise from the front. 3 or more (n-gons are allowed). */
  v: number[];
  /** One UV per corner, matching v. */
  uv: V2[];
  /** Owning group id. */
  g: number;
  /** Smoothing group. 0 = flat; faces sharing a non-zero id blend normals. */
  s: number;
  /** UV seams: seam[i] marks the edge from corner i to corner i + 1. Kept per face so it survives vertex reindexing. */
  seam?: boolean[];
  /** Pinned UV corners stay where they are when the face is unwrapped again. */
  pin?: boolean[];
}

export type GroupKind = 'mesh' | 'lod' | 'collision';

export interface Group {
  id: number;
  name: string;
  material: number | null;
  visible: boolean;
  locked: boolean;
  kind: GroupKind;
  /** Colour in the Blockout view, as sRGB hex. Automatic when absent. */
  color?: string;
}

export type MapSlot = 'base' | 'normal' | 'orm' | 'emissive';

export interface GradientStop { at: number; color: string }

export interface Gradient {
  kind: 'linear' | 'mirror' | 'radial';
  /** Across the model's shape, whatever its UVs; or across the texture itself, which follows the UVs. */
  space: 'model' | 'texture';
  /** Direction in degrees as seen from the front: 0 runs upward, 90 runs to the right. */
  angle: number;
  /** Run front to back instead of using the angle. */
  depth: boolean;
  /** Above 1, the colours step in this many flat bands: good for toon and low-poly looks. */
  bands: number;
  size: number;
  stops: GradientStop[];
}

export interface Material {
  id: number;
  name: string;
  /** sRGB hex, e.g. #c8ccd2 */
  color: string;
  alpha: number;
  metallic: number;
  roughness: number;
  emissive: string;
  emissiveStrength: number;
  doubleSided: boolean;
  alphaMode: 'opaque' | 'mask' | 'blend';
  maps: Partial<Record<MapSlot, number>>;
  // The rest are optional, so older projects load as they were. See MATERIAL_DEFAULTS.
  /** Ignore lighting and show colour as it is, for stylised and low-poly looks. */
  unlit?: boolean;
  normalScale?: number;
  occlusionStrength?: number;
  /** Below this alpha, a cutout material's pixels vanish. */
  alphaCutoff?: number;
  /** A glossy layer over the surface, like car paint or lacquer. */
  clearcoat?: number;
  clearcoatRoughness?: number;
  /** How much light passes through, as with glass or water. */
  transmission?: number;
  ior?: number;
  /** A soft edge sheen, as on cloth and velvet. */
  sheen?: number;
  sheenColor?: string;
  /** Kept so a gradient stays editable. It's baked into the base colour map, so it exports as an ordinary texture. */
  gradient?: Gradient;
  /** Texture tiling, shift and turn, applied to all this material's maps. */
  uvScale?: V2;
  uvOffset?: V2;
  uvRotation?: number;
}

export const MATERIAL_DEFAULTS = {
  normalScale: 1, occlusionStrength: 1, alphaCutoff: 0.5, clearcoat: 0, clearcoatRoughness: 0.1,
  transmission: 0, ior: 1.5, sheen: 0, sheenColor: '#ffffff',
};

export interface Texture {
  id: number;
  name: string;
  /** Data URL. Shared between undo snapshots, never mutated. */
  url: string;
  width: number;
  height: number;
  /** Pixel art: shown and exported with sharp, unblended pixels. */
  pixelated?: boolean;
  /** Counts edits made by painting, so views know to reload the image. */
  rev?: number;
}

export interface Bone {
  id: number;
  name: string;
  parent: number | null;
  /** Rest position of the joint in model space. Rest orientation is identity. */
  head: V3;
}

export interface Key<T> {
  f: number;
  v: T;
  /** Timing to the next key as a cubic bezier [x1, y1, x2, y2], as in CSS. Absent means linear. */
  c?: [number, number, number, number];
  /** Hold this key's value until the next key. */
  step?: boolean;
}

export interface Track {
  /** Translation offset from rest, in parent space. */
  pos: Key<V3>[];
  /** Local rotation from rest. */
  rot: Key<Q>[];
}

export interface Clip {
  id: number;
  name: string;
  fps: number;
  /** Last frame of the clip. */
  length: number;
  loop: boolean;
  tracks: Record<number, Track>;
}

/** A picture to model over, standing behind one orthographic view. Saved with the project, never exported. */
export interface RefImage {
  id: number;
  name: string;
  /** Data URL. Shared between undo snapshots, never mutated. */
  url: string;
  view: 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
  /** Picture size in pixels, for its aspect. */
  width: number;
  height: number;
  /** Height in the scene, in metres. */
  size: number;
  /** Centre in the view's own right and up directions. */
  x: number;
  y: number;
  opacity: number;
  visible: boolean;
  /** Draw over the model instead of behind it. */
  over: boolean;
}

export interface Model {
  refs?: RefImage[];
  verts: Vertex[];
  faces: Face[];
  groups: Group[];
  materials: Material[];
  textures: Texture[];
  bones: Bone[];
  clips: Clip[];
  nextId: number;
}

export function emptyModel(): Model {
  return { verts: [], faces: [], groups: [], materials: [], textures: [], bones: [], clips: [], nextId: 1 };
}

export function newId(m: Model): number {
  return m.nextId++;
}

/** Deep copy for undo. Texture records are immutable, so their data URLs stay shared. */
export function cloneModel(m: Model): Model {
  return {
    ...(m.refs ? { refs: m.refs.map((r) => ({ ...r })) } : {}),
    verts: m.verts.map((v) => (v.w
      ? { p: [v.p[0], v.p[1], v.p[2]] as V3, w: v.w.map((x) => [x[0], x[1]] as [number, number]) }
      : { p: [v.p[0], v.p[1], v.p[2]] as V3 })),
    faces: m.faces.map((f) => {
      const c: Face = { v: f.v.slice(), uv: f.uv.map((u) => [u[0], u[1]] as V2), g: f.g, s: f.s };
      if (f.seam) c.seam = f.seam.slice();
      if (f.pin) c.pin = f.pin.slice();
      return c;
    }),
    groups: m.groups.map((g) => ({ ...g })),
    materials: m.materials.map((x) => ({ ...x, maps: { ...x.maps } })),
    textures: m.textures.slice(),
    bones: m.bones.map((b) => ({ ...b, head: [...b.head] as V3 })),
    clips: structuredClone(m.clips),
    nextId: m.nextId,
  };
}

export function makeMaterial(m: Model, name: string, color = '#b9bec6'): Material {
  const mat: Material = {
    id: newId(m), name, color, alpha: 1, metallic: 0, roughness: 0.65,
    emissive: '#000000', emissiveStrength: 1, doubleSided: false, alphaMode: 'opaque', maps: {},
  };
  m.materials.push(mat);
  return mat;
}

export function makeGroup(m: Model, name: string, material: number | null = null, kind: GroupKind = 'mesh'): Group {
  const g: Group = { id: newId(m), name, material, visible: true, locked: false, kind };
  m.groups.push(g);
  return g;
}

export function uniqueName(existing: string[], base: string): string {
  if (!existing.includes(base)) return base;
  const stem = base.replace(/[ _.]?\d+$/, '');
  for (let i = 1; ; i++) {
    const n = `${stem}.${String(i).padStart(3, '0')}`;
    if (!existing.includes(n)) return n;
  }
}
