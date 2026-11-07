// Turning a document material into Three.js materials, shared by the viewport and the preview. Also the preview itself.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { bakeTextureGradient } from '../core/materials';
import { MATERIAL_DEFAULTS, type MapSlot, type Material, type Texture } from '../core/types';

export type TexOf = (slot: MapSlot, srgb: boolean) => THREE.Texture | null;

const OFFSET = { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };

export function newLitMaterial() { return new THREE.MeshPhysicalMaterial(OFFSET); }
export function newUnlitMaterial() { return new THREE.MeshBasicMaterial(OFFSET); }

/** Tiling, shift and turn for every map of a material, as KHR_texture_transform defines them. */
function placeTexture(t: THREE.Texture | null, d: Material) {
  if (!t) return;
  t.matrixAutoUpdate = true;
  t.repeat.set(d.uvScale?.[0] ?? 1, d.uvScale?.[1] ?? 1);
  t.offset.set(d.uvOffset?.[0] ?? 0, d.uvOffset?.[1] ?? 0);
  t.rotation = d.uvRotation ?? 0;
}

function alphaSetup(mat: THREE.Material, d: Material, opacity: number) {
  mat.side = d.doubleSided ? THREE.DoubleSide : THREE.FrontSide;
  mat.transparent = d.alphaMode === 'blend' || opacity < 1;
  mat.opacity = opacity;
  mat.alphaTest = d.alphaMode === 'mask' ? d.alphaCutoff ?? MATERIAL_DEFAULTS.alphaCutoff : 0;
}

/** Glass is shown as a see-through approximation here. Real refraction is left to the game engine. */
export function fillLit(mat: THREE.MeshPhysicalMaterial, d: Material, texOf: TexOf) {
  const transmission = d.transmission ?? 0;
  mat.color.set(d.color);
  mat.metalness = d.metallic;
  mat.roughness = d.roughness;
  mat.emissive.set(d.emissive);
  mat.emissiveIntensity = d.emissiveStrength;
  alphaSetup(mat, d, d.alpha * (1 - transmission * 0.72));
  mat.map = texOf('base', true);
  mat.normalMap = texOf('normal', false);
  const ns = d.normalScale ?? MATERIAL_DEFAULTS.normalScale;
  mat.normalScale.set(ns, ns);
  const orm = texOf('orm', false);
  mat.roughnessMap = orm; mat.metalnessMap = orm; mat.aoMap = orm;
  mat.aoMapIntensity = d.occlusionStrength ?? MATERIAL_DEFAULTS.occlusionStrength;
  mat.emissiveMap = texOf('emissive', true);
  mat.clearcoat = d.clearcoat ?? 0;
  mat.clearcoatRoughness = d.clearcoatRoughness ?? MATERIAL_DEFAULTS.clearcoatRoughness;
  mat.sheen = d.sheen ?? 0;
  mat.sheenColor.set(d.sheenColor ?? MATERIAL_DEFAULTS.sheenColor);
  mat.sheenRoughness = Math.max(0.2, d.roughness);
  mat.ior = d.ior ?? MATERIAL_DEFAULTS.ior;
  for (const t of [mat.map, mat.normalMap, orm, mat.emissiveMap]) placeTexture(t, d);
}

export function fillUnlit(mat: THREE.MeshBasicMaterial, d: Material, texOf: TexOf) {
  mat.color.set(d.color);
  alphaSetup(mat, d, d.alpha);
  mat.map = texOf('base', true);
  placeTexture(mat.map, d);
}

/** What forces a shader recompile. Slow, so it's done only when this changes. */
export function shaderSignature(d: Material, mat: THREE.Material) {
  return [d.unlit, d.alphaMode, mat.transparent, mat.side, d.maps.base, d.maps.normal, d.maps.orm, d.maps.emissive, (d.clearcoat ?? 0) > 0, (d.sheen ?? 0) > 0].join('|');
}

/**
 * Canvases being painted, by texture id. While one is here, views show it instead of the saved image, so a stroke
 * appears as it's drawn; and a texture reloading after a stroke starts from it, so it doesn't flash.
 */
export const liveTextures = new Map<number, HTMLCanvasElement>();

export function makeDocTexture(t: Texture, srgb: boolean, onLoad: () => void): THREE.Texture {
  const img = new Image();
  const live = liveTextures.get(t.id);
  const tex = new THREE.Texture(live ?? img);
  if (live) tex.needsUpdate = true;
  img.onload = () => { if (!liveTextures.has(t.id)) { tex.image = img; tex.needsUpdate = true; } onLoad(); };
  img.src = t.url;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.flipY = false;
  if (t.pixelated) {
    // Pixel art: each texel a crisp square, at any distance.
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.anisotropy = 1;
  } else tex.anisotropy = 8;
  return tex;
}

export type PreviewShape = 'sphere' | 'cube' | 'plane';

/**
 * A small studio for looking at one material, separate from the model. It has its own graphics context, so nothing
 * here can disturb the viewport.
 */
export class MaterialPreview {
  canvas: HTMLCanvasElement;
  shape: PreviewShape = 'sphere';
  /** Called when an image finishes loading, in case something should redraw. */
  onLoaded: () => void = () => {};
  version = 0;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  private mesh: THREE.Mesh;
  private lit = newLitMaterial();
  private unlit = newUnlitMaterial();
  private textures = new Map<string, THREE.Texture>();
  private geo: Record<PreviewShape, THREE.BufferGeometry>;
  private signature = '';

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mat-preview';
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.8;
    pm.dispose();
    this.scene.background = checkerBackground();
    const key = new THREE.DirectionalLight(0xfff2e0, 1.6);
    key.position.set(3, 5, 4);
    this.scene.add(key);
    this.geo = {
      sphere: new THREE.SphereGeometry(1, 48, 32),
      cube: new THREE.BoxGeometry(1.45, 1.45, 1.45),
      plane: new THREE.PlaneGeometry(2.1, 2.1),
    };
    this.mesh = new THREE.Mesh(this.geo.sphere, this.lit);
    this.scene.add(this.mesh);
    this.camera.position.set(0, 0, 4.6);
  }

  private gradTex: { key: string; tex: THREE.Texture } | null = null;

  /**
   * A gradient baked across the model belongs to the model's own UVs, which mean nothing on this sphere. The preview
   * bakes its own copy across the sphere instead, so it shows the direction you chose.
   */
  private gradientTexture(d: Material): THREE.Texture {
    const key = JSON.stringify(d.gradient);
    if (this.gradTex?.key === key) return this.gradTex.tex;
    this.gradTex?.tex.dispose();
    const size = 128;
    const rgba = bakeTextureGradient({ ...d.gradient!, space: 'texture' }, size);
    const tex = new THREE.DataTexture(new Uint8Array(rgba), size, size, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.flipY = false;
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this.gradTex = { key, tex };
    return tex;
  }

  private texOf(d: Material, all: Texture[]): TexOf {
    return (slot, srgb) => {
      if (slot === 'base' && d.gradient) return this.gradientTexture(d);
      const id = d.maps[slot];
      const t = id === undefined ? undefined : all.find((x) => x.id === id);
      if (!t) return null;
      const key = `${d.id}:${slot}:${t.id}`;
      let tex = this.textures.get(key);
      if (!tex) {
        tex = makeDocTexture(t, srgb, () => { this.version++; this.onLoaded(); });
        this.textures.set(key, tex);
      }
      return tex;
    };
  }

  private frame(d: Material, all: Texture[], shape: PreviewShape, w: number, h: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.mesh.geometry = this.geo[shape];
    this.mesh.rotation.set(shape === 'cube' ? 0.5 : 0, shape === 'cube' ? 0.7 : 0, 0);
    const mat = d.unlit ? this.unlit : this.lit;
    if (d.unlit) fillUnlit(this.unlit, d, this.texOf(d, all));
    else fillLit(this.lit, d, this.texOf(d, all));
    // Force the cube and sphere both to show their true side, whatever Double-sided says.
    const sig = shaderSignature(d, mat);
    if (sig !== this.signature) { this.signature = sig; mat.needsUpdate = true; }
    this.mesh.material = mat;
    this.renderer.render(this.scene, this.camera);
  }

  draw(d: Material, all: Texture[]) {
    this.frame(d, all, this.shape, 276, 150);
    this.canvas.style.width = '100%';
    this.canvas.style.height = 'auto';
  }

  /** A little picture of a material, for lists and preset buttons. */
  thumb(d: Material, all: Texture[], size = 44): string {
    this.frame(d, all, 'sphere', size, size);
    return this.canvas.toDataURL('image/png');
  }
}

function checkerBackground(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d')!;
  x.fillStyle = '#34383e'; x.fillRect(0, 0, 64, 64);
  x.fillStyle = '#2a2d32'; x.fillRect(0, 0, 32, 32); x.fillRect(32, 32, 32, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(5, 3);
  return t;
}
