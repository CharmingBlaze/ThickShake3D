// Material presets, colour tools, gradients and the pixel work behind texture tools.
// No UI or canvas code here: images are plain RGBA arrays.
import { triangulate } from './geom';
import type { Gradient, GradientStop, Material, Model, V3 } from './types';

// ---------- colour ----------
export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full.slice(0, 6), 16);
  return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** A valid colour from typed text, with or without #, in 3 or 6 digits. Null if it isn't one. */
export function parseHex(text: string): string | null {
  const t = text.trim().replace(/^#/, '').toLowerCase();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/.test(t)) return null;
  return `#${t.length === 3 ? t.split('').map((c) => c + c).join('') : t}`;
}

/** Hue in degrees, saturation and value from 0 to 1. */
export function hexToHsv(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b), d = hi - lo;
  let hue = 0;
  if (d > 1e-9) {
    if (hi === r) hue = ((g - b) / d + 6) % 6;
    else if (hi === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return [hue, hi > 0 ? d / hi : 0, hi];
}

export function hsvToHex(hue: number, s: number, v: number): string {
  const c = v * s, h = ((hue % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  const m = v - c;
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** Colours that go with this one: its tints and shades, then its complement and neighbours on the wheel. */
export function harmonies(hex: string): { shades: string[]; matches: string[] } {
  const [h, s, v] = hexToHsv(hex);
  const shades = [0.3, 0.55, 0.8, 1.15, 1.4].map((k) => (k < 1 ? hsvToHex(h, s, v * k) : hsvToHex(h, s * (2 - k), Math.min(1, v * k))));
  // Greys have no hue to turn around the wheel, so they have no matches to offer.
  const turned = s < 0.05 ? [] : [180, 150, 210, 30, -30, 120, -120].map((d) => hsvToHex(h + d, s, v));
  return { shades: [...new Set(shades)], matches: [...new Set(turned)] };
}

// OKLab mixes colours without the muddy, dark middles that plain RGB mixing gives.
const toLinear = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const toSrgb = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.max(v, 0) ** (1 / 2.4) - 0.055);

function rgbToOklab([r, g, b]: RGB): RGB {
  const R = toLinear(r), G = toLinear(g), B = toLinear(b);
  const l = Math.cbrt(0.4122 * R + 0.5363 * G + 0.0514 * B), m = Math.cbrt(0.2119 * R + 0.6807 * G + 0.1074 * B), s = Math.cbrt(0.0883 * R + 0.2817 * G + 0.63 * B);
  return [0.2105 * l + 0.7936 * m - 0.0041 * s, 1.978 * l - 2.4286 * m + 0.4506 * s, 0.0259 * l + 0.7828 * m - 0.8087 * s];
}

function oklabToRgb([L, a, b]: RGB): RGB {
  const l = (L + 0.3963 * a + 0.2158 * b) ** 3, m = (L - 0.1056 * a - 0.0639 * b) ** 3, s = (L - 0.0895 * a - 1.2915 * b) ** 3;
  return [toSrgb(4.0767 * l - 3.3077 * m + 0.2309 * s), toSrgb(-1.2684 * l + 2.6098 * m - 0.3413 * s), toSrgb(-0.0041 * l - 0.7034 * m + 1.707 * s)];
}

// ---------- palettes ----------
export interface Palette { name: string; colors: string[] }

export const PALETTES: Palette[] = [
  { name: 'Skin tones', colors: ['#fde0c8', '#f4c6a0', '#e0a57f', '#c68a62', '#a56c47', '#855233', '#633b25', '#44281a'] },
  { name: 'Hair', colors: ['#f2d58a', '#c99a4a', '#8c5a2b', '#5a3a22', '#2c1d14', '#141010', '#c0451f', '#d9d9d9'] },
  { name: 'Earth', colors: ['#3d2b1f', '#6b4a2f', '#8c6a3f', '#a68a5b', '#c2b280', '#5c6b3c', '#7c8a5c', '#8a8780'] },
  { name: 'Foliage', colors: ['#16361f', '#23552e', '#35753c', '#55953f', '#84b34a', '#b8cc56', '#7a5230', '#4a3320'] },
  { name: 'Metals', colors: ['#e6b422', '#c9a227', '#c97b4a', '#b0703c', '#c0c0c8', '#8e9196', '#55585e', '#2e3034'] },
  { name: 'Pastel', colors: ['#f7c6c7', '#fadcb4', '#fbf3b5', '#c8eebf', '#b9e6e0', '#bcd7f5', '#d3c5f0', '#f2c5e0'] },
  { name: 'Bold', colors: ['#d7263d', '#f46036', '#f2c14e', '#3bb273', '#1b98e0', '#2e294e', '#a23b72', '#111111'] },
  { name: 'Neon', colors: ['#ff2079', '#ff6ec7', '#fff01f', '#39ff14', '#00f5d4', '#00b8ff', '#7d12ff', '#0a0a12'] },
  { name: 'Retro 16', colors: ['#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8', '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa'] },
  { name: 'Greys', colors: ['#000000', '#222222', '#444444', '#666666', '#888888', '#aaaaaa', '#cccccc', '#ffffff'] },
];

/** The main colours of an image, most common first, by k-means over its pixels. Transparent pixels don't count. */
export function paletteFromImage(rgba: ArrayLike<number>, count = 8): string[] {
  const samples: RGB[] = [];
  const total = rgba.length / 4;
  const step = Math.max(1, Math.floor(total / 6000));
  for (let i = 0; i < total; i += step) {
    if (rgba[i * 4 + 3] < 128) continue;
    samples.push(rgbToOklab([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]));
  }
  if (!samples.length) return [];
  // Start from colours spread as far apart as possible, so small bright accents aren't lost.
  const centers: RGB[] = [samples[0]];
  const gap = (a: RGB, b: RGB) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  while (centers.length < count) {
    let far = samples[0], best = -1;
    for (const s of samples) {
      let d = Infinity;
      for (const c of centers) d = Math.min(d, gap(s, c));
      if (d > best) { best = d; far = s; }
    }
    if (best < 1e-4) break;
    centers.push(far);
  }
  const sizes = new Array(centers.length).fill(0);
  for (let it = 0; it < 10; it++) {
    const sum = centers.map((): RGB => [0, 0, 0]);
    sizes.fill(0);
    for (const s of samples) {
      let k = 0, best = Infinity;
      centers.forEach((c, i) => { const d = gap(s, c); if (d < best) { best = d; k = i; } });
      sum[k][0] += s[0]; sum[k][1] += s[1]; sum[k][2] += s[2];
      sizes[k]++;
    }
    centers.forEach((c, i) => { if (sizes[i]) { c[0] = sum[i][0] / sizes[i]; c[1] = sum[i][1] / sizes[i]; c[2] = sum[i][2] / sizes[i]; } });
  }
  return centers
    .map((c, i) => ({ hex: rgbToHex(...oklabToRgb(c)), n: sizes[i] }))
    .filter((c) => c.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((c) => c.hex);
}

/** Colours from a palette file: GIMP .gpl, plain .hex or .txt lists, or anything else with hex codes in it. */
export function parsePaletteText(text: string): string[] {
  const out: string[] = [];
  const add = (hex: string | null) => { if (hex && !out.includes(hex)) out.push(hex); };
  const isGimp = /^GIMP Palette/i.test(text.trimStart());
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    // A # line is a comment unless it starts with a colour.
    if (!t || (t.startsWith('#') && !isGimp && !parseHex(t.split(/[\s,;]+/)[0]))) continue;
    if (isGimp) {
      const m = t.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);
      if (m) add(rgbToHex(+m[1], +m[2], +m[3]));
    } else for (const w of t.split(/[\s,;]+/)) add(parseHex(w));
  }
  return out;
}

// ---------- gradients ----------
export const GRADIENT_PRESETS: { name: string; stops: GradientStop[] }[] = [
  { name: 'Sunset', stops: [{ at: 0, color: '#2b1b5a' }, { at: 0.45, color: '#d0417e' }, { at: 0.75, color: '#f98c3c' }, { at: 1, color: '#ffe08a' }] },
  { name: 'Ocean', stops: [{ at: 0, color: '#04223f' }, { at: 0.55, color: '#0e7fa8' }, { at: 1, color: '#9be8e0' }] },
  { name: 'Fire', stops: [{ at: 0, color: '#3a0a06' }, { at: 0.4, color: '#d62d0f' }, { at: 0.75, color: '#f79a1b' }, { at: 1, color: '#fff3a1' }] },
  { name: 'Forest', stops: [{ at: 0, color: '#3b2a1a' }, { at: 0.35, color: '#2f5a2b' }, { at: 1, color: '#a6cf5a' }] },
  { name: 'Skin', stops: [{ at: 0, color: '#a56c47' }, { at: 0.55, color: '#e0a57f' }, { at: 1, color: '#fbdcc5' }] },
  { name: 'Steel', stops: [{ at: 0, color: '#2e3136' }, { at: 0.5, color: '#9aa0a8' }, { at: 0.62, color: '#e6e9ee' }, { at: 1, color: '#55595f' }] },
  { name: 'Gold', stops: [{ at: 0, color: '#6e4a0c' }, { at: 0.55, color: '#e0ad28' }, { at: 1, color: '#fff0b0' }] },
  { name: 'Neon', stops: [{ at: 0, color: '#ff2079' }, { at: 0.5, color: '#7d12ff' }, { at: 1, color: '#00f5d4' }] },
  { name: 'Shadow', stops: [{ at: 0, color: '#1a1a22' }, { at: 1, color: '#ffffff' }] },
];

export const newGradient = (from: string): Gradient => {
  const [h, s, v] = hexToHsv(from);
  return { kind: 'linear', space: 'model', angle: 0, depth: false, bands: 0, size: 512, stops: [{ at: 0, color: hsvToHex(h, Math.min(1, s * 1.1), v * 0.45) }, { at: 1, color: from }] };
};

const sortedStops = (stops: GradientStop[]) => [...stops].sort((a, b) => a.at - b.at);

/** Prepared colours for fast look-ups: a table across the gradient, mixed in OKLab. */
function gradientTable(g: Pick<Gradient, 'stops' | 'bands'>, size = 1024): Uint8ClampedArray {
  const stops = sortedStops(g.stops);
  const labs = stops.map((s) => rgbToOklab(hexToRgb(s.color)));
  const out = new Uint8ClampedArray((size + 1) * 3);
  const bands = Math.round(g.bands);
  for (let i = 0; i <= size; i++) {
    let t = i / size;
    // Flat bands: each takes the colour its span would have at the middle.
    if (bands > 1) t = Math.min(bands - 1, Math.floor(t * bands)) / (bands - 1);
    let k = 1;
    while (k < stops.length - 1 && stops[k].at < t) k++;
    const a = stops[Math.max(0, k - 1)], b = stops[k] ?? a;
    const span = b.at - a.at;
    const f = span > 1e-6 ? Math.max(0, Math.min(1, (t - a.at) / span)) : t >= b.at ? 1 : 0;
    const la = labs[Math.max(0, k - 1)], lb = labs[k] ?? la;
    const rgb = stops.length === 1 ? hexToRgb(stops[0].color) : oklabToRgb([la[0] + (lb[0] - la[0]) * f, la[1] + (lb[1] - la[1]) * f, la[2] + (lb[2] - la[2]) * f]);
    out[i * 3] = rgb[0]; out[i * 3 + 1] = rgb[1]; out[i * 3 + 2] = rgb[2];
  }
  return out;
}

/** The colour partway along a gradient. */
export function sampleGradient(g: Pick<Gradient, 'stops' | 'bands'>, t: number): string {
  const table = gradientTable(g, 256);
  const i = Math.round(Math.max(0, Math.min(1, t)) * 256) * 3;
  return rgbToHex(table[i], table[i + 1], table[i + 2]);
}

/** A CSS picture of a gradient, for the editor's bar and buttons. */
export function gradientCss(g: Pick<Gradient, 'stops' | 'bands'>): string {
  const n = 24;
  const parts: string[] = [];
  for (let i = 0; i <= n; i++) parts.push(`${sampleGradient(g, i / n)} ${(i / n) * 100}%`);
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

export function reverseStops(stops: GradientStop[]): GradientStop[] {
  return sortedStops(stops).reverse().map((s) => ({ at: 1 - s.at, color: s.color }));
}

export function evenStops(stops: GradientStop[]): GradientStop[] {
  const s = sortedStops(stops);
  return s.map((x, i) => ({ at: s.length > 1 ? i / (s.length - 1) : 0, color: x.color }));
}

const shapeT = (g: Gradient, t: number) => {
  const c = Math.max(0, Math.min(1, t));
  return g.kind === 'mirror' ? 1 - Math.abs(2 * c - 1) : c;
};

/** The way a gradient runs in the model. Angle is seen from the front, so X is across and Y is up. */
export function gradientDirection(g: Gradient): V3 {
  if (g.depth) return [0, 0, 1];
  const a = (g.angle * Math.PI) / 180;
  return [Math.sin(a), Math.cos(a), 0];
}

/** Bake across the texture itself, following the UVs. */
export function bakeTextureGradient(g: Gradient, size: number): Uint8ClampedArray {
  const table = gradientTable(g);
  const out = new Uint8ClampedArray(size * size * 4);
  // V runs down the image, so "up" is toward the top row.
  const a = (g.angle * Math.PI) / 180;
  const dx = g.depth ? 0 : Math.sin(a), dy = g.depth ? -1 : -Math.cos(a);
  const reach = Math.abs(dx) + Math.abs(dy) || 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5, v = (y + 0.5) / size - 0.5;
      const t = g.kind === 'radial' ? Math.hypot(u, v) / 0.5 : (u * dx + v * dy) / reach + 0.5;
      const k = Math.round(shapeT(g, t) * 1024) * 3;
      const i = (y * size + x) * 4;
      out[i] = table[k]; out[i + 1] = table[k + 1]; out[i + 2] = table[k + 2]; out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * Bake across the model's shape: each pixel takes the colour for where its point on the surface sits along the
 * gradient, however the UVs are laid out. Needs UVs that don't overlap, or overlapping faces share colours.
 * `faces` are the faces to paint, and the model's bounds over those faces set the gradient's span.
 */
export function bakeModelGradient(m: Model, faces: Iterable<number>, g: Gradient, size: number): Uint8ClampedArray {
  const list = [...faces];
  if (!list.length) return bakeTextureGradient(g, size);
  const table = gradientTable(g);
  const out = new Uint8ClampedArray(size * size * 4);
  const dir = gradientDirection(g);
  const pts: V3[] = [];
  for (const fi of list) for (const v of m.faces[fi].v) pts.push(m.verts[v].p);
  const lo: V3 = [Infinity, Infinity, Infinity], hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) for (let i = 0; i < 3; i++) { lo[i] = Math.min(lo[i], p[i]); hi[i] = Math.max(hi[i], p[i]); }
  const center: V3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const along = (p: V3) => p[0] * dir[0] + p[1] * dir[1] + p[2] * dir[2];
  let from = Infinity, to = -Infinity, radius = 0;
  for (const p of pts) {
    from = Math.min(from, along(p)); to = Math.max(to, along(p));
    radius = Math.max(radius, Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]));
  }
  const span = to - from || 1;
  const tOf = (x: number, y: number, z: number) => shapeT(g, g.kind === 'radial'
    ? Math.hypot(x - center[0], y - center[1], z - center[2]) / (radius || 1)
    : (x * dir[0] + y * dir[1] + z * dir[2] - from) / span);
  const wrap = (v: number) => { const w = v % size; return w < 0 ? w + size : w; };
  for (const fi of list) {
    const f = m.faces[fi];
    const tris = triangulate(f.v.map((i) => m.verts[i].p));
    for (let n = 0; n < tris.length; n += 3) {
      const [c0, c1, c2] = [tris[n], tris[n + 1], tris[n + 2]];
      const u0 = f.uv[c0][0] * size, v0 = f.uv[c0][1] * size, u1 = f.uv[c1][0] * size, v1 = f.uv[c1][1] * size, u2 = f.uv[c2][0] * size, v2 = f.uv[c2][1] * size;
      const det = (v1 - v2) * (u0 - u2) + (u2 - u1) * (v0 - v2);
      if (Math.abs(det) < 1e-9) continue;
      const P0 = m.verts[f.v[c0]].p, P1 = m.verts[f.v[c1]].p, P2 = m.verts[f.v[c2]].p;
      const x0 = Math.floor(Math.min(u0, u1, u2)), x1 = Math.ceil(Math.max(u0, u1, u2));
      const y0 = Math.floor(Math.min(v0, v1, v2)), y1 = Math.ceil(Math.max(v0, v1, v2));
      if (x1 - x0 > size * 4 || y1 - y0 > size * 4) continue;
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          const cx = px + 0.5, cy = py + 0.5;
          const a = ((v1 - v2) * (cx - u2) + (u2 - u1) * (cy - v2)) / det;
          const b = ((v2 - v0) * (cx - u2) + (u0 - u2) * (cy - v2)) / det;
          const c = 1 - a - b;
          // A little past the edge, so seams don't show gaps.
          if (a < -0.02 || b < -0.02 || c < -0.02) continue;
          const k = Math.round(tOf(a * P0[0] + b * P1[0] + c * P2[0], a * P0[1] + b * P1[1] + c * P2[1], a * P0[2] + b * P1[2] + c * P2[2]) * 1024) * 3;
          const i = (Math.floor(wrap(py)) * size + Math.floor(wrap(px))) * 4;
          out[i] = table[k]; out[i + 1] = table[k + 1]; out[i + 2] = table[k + 2]; out[i + 3] = 255;
        }
      }
    }
  }
  dilate(out, size, 4);
  // Space no face touches gets the middle colour, in case filtering ever reaches it.
  const mid = 512 * 3;
  for (let i = 0; i < out.length; i += 4) if (!out[i + 3]) { out[i] = table[mid]; out[i + 1] = table[mid + 1]; out[i + 2] = table[mid + 2]; out[i + 3] = 255; }
  return out;
}

/** Spread painted pixels outward, so texture filtering at an island's edge never picks up the background. */
function dilate(rgba: Uint8ClampedArray, size: number, passes: number) {
  for (let p = 0; p < passes; p++) {
    const src = rgba.slice();
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      if (src[i + 3]) continue;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = (ny * size + nx) * 4;
        if (!src[j + 3]) continue;
        rgba[i] = src[j]; rgba[i + 1] = src[j + 1]; rgba[i + 2] = src[j + 2]; rgba[i + 3] = 255;
        break;
      }
    }
  }
}

// ---------- recognising maps ----------
export type ImportedMap = 'base' | 'normal' | 'emissive' | 'orm' | OrmChannel;

/** What kind of map an image is, from its file name. Texture sets are named consistently enough to trust this. */
export function guessMapKind(fileName: string): { kind: ImportedMap; directX: boolean } {
  const stem = fileName.replace(/\.[^.]+$/, '').toLowerCase();
  const words = stem.split(/[^a-z0-9]+/).filter(Boolean);
  const has = (...w: string[]) => words.some((x) => w.includes(x));
  const directX = has('dx', 'directx');
  if (has('orm', 'arm', 'rma')) return { kind: 'orm', directX };
  if (has('normal', 'normals', 'nrm', 'nor', 'norm', 'nml') || /normal/.test(stem)) return { kind: 'normal', directX };
  if (has('rough', 'roughness', 'rgh') || /rough/.test(stem)) return { kind: 'roughness', directX };
  if (has('metal', 'metallic', 'metalness', 'mtl') || /metal/.test(stem)) return { kind: 'metallic', directX };
  if (has('ao', 'occlusion', 'ambientocclusion') || /occlusion/.test(stem)) return { kind: 'occlusion', directX };
  if (has('emissive', 'emission', 'emit', 'glow') || /emiss/.test(stem)) return { kind: 'emissive', directX };
  return { kind: 'base', directX };
}

export type MaterialLook = Partial<Omit<Material, 'id' | 'name' | 'maps'>>;

/** Values a preset doesn't mention go back to these, so presets never inherit leftovers from the last one. */
const NEUTRAL: MaterialLook = {
  metallic: 0, roughness: 0.6, alpha: 1, emissive: '#000000', emissiveStrength: 1, alphaMode: 'opaque', doubleSided: false,
  unlit: false, clearcoat: 0, clearcoatRoughness: 0.1, transmission: 0, ior: 1.5, sheen: 0, sheenColor: '#ffffff',
};

export const MATERIAL_PRESETS: { name: string; group: string; look: MaterialLook }[] = [
  { name: 'Clay', group: 'Basic', look: { color: '#b9a48f', roughness: 0.85 } },
  { name: 'Plastic', group: 'Basic', look: { color: '#d04a3a', roughness: 0.35 } },
  { name: 'Rubber', group: 'Basic', look: { color: '#26282b', roughness: 0.92 } },
  { name: 'Stone', group: 'Basic', look: { color: '#8a8780', roughness: 0.95 } },
  { name: 'Wood', group: 'Basic', look: { color: '#8c5a33', roughness: 0.7 } },
  { name: 'Skin', group: 'Character', look: { color: '#d9a584', roughness: 0.55, sheen: 0.25, sheenColor: '#ffb9a0' } },
  { name: 'Cloth', group: 'Character', look: { color: '#3f5a8a', roughness: 0.95, sheen: 0.8, sheenColor: '#a9c0ff' } },
  { name: 'Leather', group: 'Character', look: { color: '#5a3a26', roughness: 0.5, clearcoat: 0.15, clearcoatRoughness: 0.5 } },
  { name: 'Hair', group: 'Character', look: { color: '#3a2a1e', roughness: 0.45, sheen: 0.5, sheenColor: '#c9a07a', doubleSided: true } },
  { name: 'Iron', group: 'Metal', look: { color: '#8e9196', metallic: 1, roughness: 0.5 } },
  { name: 'Gold', group: 'Metal', look: { color: '#e6b422', metallic: 1, roughness: 0.25 } },
  { name: 'Copper', group: 'Metal', look: { color: '#c97b4a', metallic: 1, roughness: 0.3 } },
  { name: 'Chrome', group: 'Metal', look: { color: '#e8e8ec', metallic: 1, roughness: 0.05 } },
  { name: 'Car Paint', group: 'Metal', look: { color: '#a01822', metallic: 0.6, roughness: 0.4, clearcoat: 1, clearcoatRoughness: 0.05 } },
  { name: 'Glass', group: 'See-through', look: { color: '#e8f4f8', roughness: 0.03, transmission: 1, ior: 1.5, doubleSided: true } },
  { name: 'Water', group: 'See-through', look: { color: '#7fb9d6', roughness: 0.05, transmission: 0.85, ior: 1.33 } },
  { name: 'Ghost', group: 'See-through', look: { color: '#bcd7ff', alpha: 0.35, alphaMode: 'blend', roughness: 0.4, doubleSided: true } },
  { name: 'Neon', group: 'Stylised', look: { color: '#101012', emissive: '#29e0ff', emissiveStrength: 4 } },
  { name: 'Lava', group: 'Stylised', look: { color: '#2a1410', emissive: '#ff5a14', emissiveStrength: 2.5, roughness: 0.8 } },
  { name: 'Flat Colour', group: 'Stylised', look: { color: '#5fb36a', unlit: true } },
];

/** Give a material a preset's look. Its name and texture maps stay. */
export function applyPreset(m: Material, look: MaterialLook) {
  Object.assign(m, NEUTRAL, look);
}

// ---------- texture pixels ----------
const luma = (d: ArrayLike<number>, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;

/**
 * A tangent-space normal map from an image's brightness, treating bright as raised. The image wraps at its edges so
 * tiling stays seamless. `strength` scales the slopes. Green points up, as glTF expects.
 */
export function normalFromHeight(rgba: ArrayLike<number>, w: number, h: number, strength = 2): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  const at = (x: number, y: number) => luma(rgba, (((y + h) % h) * w + ((x + w) % w)) * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Sobel slopes.
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)) * strength;
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out[i] = (-dx / l + 1) * 127.5;
      // Image rows run downward, so a brightness rise down the image is a slope facing up.
      out[i + 1] = (dy / l + 1) * 127.5;
      out[i + 2] = (1 / l + 1) * 127.5;
      out[i + 3] = 255;
    }
  }
  return out;
}

/** Turn a DirectX-style normal map into the OpenGL style glTF uses, or back: the green channel inverts. */
export function flipGreen(rgba: Uint8ClampedArray): Uint8ClampedArray {
  const out = rgba.slice();
  for (let i = 1; i < out.length; i += 4) out[i] = 255 - out[i];
  return out;
}

export type OrmChannel = 'occlusion' | 'roughness' | 'metallic';
const CHANNEL = { occlusion: 0, roughness: 1, metallic: 2 };

/** A fresh packed map: full occlusion, and the material's current roughness and metallic values. */
export function blankOrm(w: number, h: number, roughness: number, metallic: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = 255;
    out[i + 1] = Math.round(roughness * 255);
    out[i + 2] = Math.round(metallic * 255);
    out[i + 3] = 255;
  }
  return out;
}

/** Copy a greyscale image's brightness into one channel of a packed occlusion/roughness/metallic map. */
export function packChannel(orm: Uint8ClampedArray, gray: ArrayLike<number>, channel: OrmChannel): Uint8ClampedArray {
  const out = orm.slice();
  const c = CHANNEL[channel];
  for (let i = 0; i < out.length; i += 4) out[i + c] = gray[i];
  return out;
}
