// Baking: ambient occlusion and normals from a detailed mesh, written into a texture through a mesh's UV layout.
//
// Each texel the layout covers is found by drawing the mesh's triangles flat in texture space, which gives the point
// on the surface it shows and the normal there. Rays are then cast from that point against the scene, quickly, through
// a bounding volume tree. Works on plain arrays, so it runs anywhere and is easy to test; the editor turns the result
// into images.

/** Triangles to bake from or cast rays against: positions xyz, normals xyz, uvs uv, three indices a triangle. */
export interface BakeMesh {
  positions: ArrayLike<number>;
  normals: ArrayLike<number>;
  uvs: ArrayLike<number>;
  indices: ArrayLike<number>;
}

// ---------- ray casting ----------
/** A bounding volume tree over triangles, in flat arrays. */
export interface Bvh {
  pos: Float64Array;
  /** Triangle corner indices, reordered so each node's triangles sit together. */
  tris: Uint32Array;
  /** Per node: bounds min xyz, max xyz. */
  boxes: Float64Array;
  /** Per node: first child (or first triangle) and count; count 0 means an inner node with children at first, first+1. */
  first: Uint32Array;
  count: Uint32Array;
}

export function buildBvh(mesh: { positions: ArrayLike<number>; indices: ArrayLike<number> }): Bvh {
  const pos = Float64Array.from(mesh.positions);
  const n = Math.floor(mesh.indices.length / 3);
  const order = Array.from({ length: n }, (_, i) => i);
  const cen = new Float64Array(n * 3);
  const I = mesh.indices;
  for (let t = 0; t < n; t++) for (let k = 0; k < 3; k++) cen[t * 3 + k] = (pos[I[t * 3] * 3 + k] + pos[I[t * 3 + 1] * 3 + k] + pos[I[t * 3 + 2] * 3 + k]) / 3;
  const boxes: number[] = [], first: number[] = [], count: number[] = [];
  const sorted: number[] = [];
  const bounds = (lo: number, hi: number) => {
    const b = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) {
      const t = order[i];
      for (let c = 0; c < 3; c++) {
        const v = I[t * 3 + c] * 3;
        for (let k = 0; k < 3; k++) { b[k] = Math.min(b[k], pos[v + k]); b[3 + k] = Math.max(b[3 + k], pos[v + k]); }
      }
    }
    return b;
  };
  // Nodes are laid out so an inner node's two children sit side by side.
  const build = (node: number, lo: number, hi: number) => {
    const b = bounds(lo, hi);
    for (let k = 0; k < 6; k++) boxes[node * 6 + k] = b[k];
    if (hi - lo <= 4) {
      first[node] = sorted.length; count[node] = hi - lo;
      for (let i = lo; i < hi; i++) sorted.push(order[i]);
      return;
    }
    // Split at the middle of the widest spread of centres.
    let axis = 0, lo3 = [Infinity, Infinity, Infinity], hi3 = [-Infinity, -Infinity, -Infinity];
    for (let i = lo; i < hi; i++) for (let k = 0; k < 3; k++) { lo3[k] = Math.min(lo3[k], cen[order[i] * 3 + k]); hi3[k] = Math.max(hi3[k], cen[order[i] * 3 + k]); }
    for (let k = 1; k < 3; k++) if (hi3[k] - lo3[k] > hi3[axis] - lo3[axis]) axis = k;
    const part = order.slice(lo, hi).sort((a, b2) => cen[a * 3 + axis] - cen[b2 * 3 + axis]);
    for (let i = 0; i < part.length; i++) order[lo + i] = part[i];
    const mid = (lo + hi) >> 1;
    const left = first.length;
    first.push(0, 0); count.push(0, 0);
    first[node] = left; count[node] = 0;
    build(left, lo, mid);
    build(left + 1, mid, hi);
  };
  first.push(0); count.push(0);
  if (n) build(0, 0, n); else { boxes.push(0, 0, 0, 0, 0, 0); }
  const tris = new Uint32Array(sorted.length * 3);
  sorted.forEach((t, i) => { tris[i * 3] = I[t * 3]; tris[i * 3 + 1] = I[t * 3 + 1]; tris[i * 3 + 2] = I[t * 3 + 2]; });
  return { pos, tris, boxes: Float64Array.from(boxes), first: Uint32Array.from(first), count: Uint32Array.from(count) };
}

/** Where a ray first meets a triangle: distance along it, the triangle (index into the tree's order) and weights. */
export interface RayHit { t: number; tri: number; u: number; v: number }

/**
 * The nearest hit along a ray between `tmin` and `tmax`, or null. With `any`, the first hit found, which is all an
 * occlusion test needs.
 */
export function raycast(b: Bvh, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, tmin: number, tmax: number, any = false): RayHit | null {
  const P = b.pos, T = b.tris, B = b.boxes;
  const ix = 1 / dx, iy = 1 / dy, iz = 1 / dz;
  let best: RayHit | null = null;
  let far = tmax;
  const stack = [0];
  while (stack.length) {
    const node = stack.pop()!;
    // Slab test against the node's box.
    let t0 = tmin, t1 = far;
    const o = node * 6;
    let a = (B[o] - ox) * ix, c = (B[o + 3] - ox) * ix;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    a = (B[o + 1] - oy) * iy; c = (B[o + 4] - oy) * iy;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    a = (B[o + 2] - oz) * iz; c = (B[o + 5] - oz) * iz;
    if (a > c) [a, c] = [c, a];
    t0 = Math.max(t0, a); t1 = Math.min(t1, c);
    if (!(t0 <= t1)) continue;
    const cnt = b.count[node];
    if (!cnt) { stack.push(b.first[node], b.first[node] + 1); continue; }
    for (let i = b.first[node]; i < b.first[node] + cnt; i++) {
      // Möller–Trumbore.
      const p0 = T[i * 3] * 3, p1 = T[i * 3 + 1] * 3, p2 = T[i * 3 + 2] * 3;
      const e1x = P[p1] - P[p0], e1y = P[p1 + 1] - P[p0 + 1], e1z = P[p1 + 2] - P[p0 + 2];
      const e2x = P[p2] - P[p0], e2y = P[p2 + 1] - P[p0 + 1], e2z = P[p2 + 2] - P[p0 + 2];
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (Math.abs(det) < 1e-14) continue;
      const inv = 1 / det;
      const sx = ox - P[p0], sy = oy - P[p0 + 1], sz = oz - P[p0 + 2];
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t < tmin || t > far) continue;
      best = { t, tri: i, u, v };
      if (any) return best;
      far = t;
    }
  }
  return best;
}

// ---------- the texels a layout covers ----------
/** For each covered texel: where on the surface it shows, the normal there, and which triangle and weights. */
export interface SurfaceSamples {
  w: number;
  h: number;
  /** 1 where a triangle covers the texel. */
  mask: Uint8Array;
  pos: Float32Array;
  nrm: Float32Array;
  /** Triangle (index of its first corner in `indices` ÷ 3) and the weights of its second and third corners. */
  tri: Int32Array;
  bary: Float32Array;
}

/**
 * Draw a mesh's triangles flat in texture space and note, for each texel centre they cover, the surface point and
 * normal it shows. UVs wrap into 0..1 per triangle, so a layout shifted by whole tiles still lands in the image.
 */
export function sampleSurface(mesh: BakeMesh, w: number, h: number): SurfaceSamples {
  const s: SurfaceSamples = { w, h, mask: new Uint8Array(w * h), pos: new Float32Array(w * h * 3), nrm: new Float32Array(w * h * 3), tri: new Int32Array(w * h).fill(-1), bary: new Float32Array(w * h * 2) };
  const P = mesh.positions, N = mesh.normals, U = mesh.uvs, I = mesh.indices;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const shift = [Math.floor(Math.min(U[a * 2], U[b * 2], U[c * 2])), Math.floor(Math.min(U[a * 2 + 1], U[b * 2 + 1], U[c * 2 + 1]))];
    const ax = (U[a * 2] - shift[0]) * w, ay = (U[a * 2 + 1] - shift[1]) * h;
    const bx = (U[b * 2] - shift[0]) * w, by = (U[b * 2 + 1] - shift[1]) * h;
    const cx = (U[c * 2] - shift[0]) * w, cy = (U[c * 2 + 1] - shift[1]) * h;
    const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area) < 1e-12) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx))), x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cx)));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy))), y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by, cy)));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const wb = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / area;
      const wc = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / area;
      const wa = 1 - wb - wc;
      if (wa < -1e-6 || wb < -1e-6 || wc < -1e-6) continue;
      const i = y * w + x;
      s.mask[i] = 1;
      s.tri[i] = t;
      s.bary[i * 2] = wb; s.bary[i * 2 + 1] = wc;
      let nx = 0, ny = 0, nz = 0;
      for (let k = 0; k < 3; k++) {
        s.pos[i * 3 + k] = P[a * 3 + k] * wa + P[b * 3 + k] * wb + P[c * 3 + k] * wc;
      }
      nx = N[a * 3] * wa + N[b * 3] * wb + N[c * 3] * wc;
      ny = N[a * 3 + 1] * wa + N[b * 3 + 1] * wb + N[c * 3 + 1] * wc;
      nz = N[a * 3 + 2] * wa + N[b * 3 + 2] * wb + N[c * 3 + 2] * wc;
      const l = Math.hypot(nx, ny, nz) || 1;
      s.nrm[i * 3] = nx / l; s.nrm[i * 3 + 1] = ny / l; s.nrm[i * 3 + 2] = nz / l;
    }
  }
  return s;
}

/**
 * Spread baked texels outward into the empty ones around them, `steps` texels, so filtering and mipmaps never pull in
 * the empty background along UV seams. Works on RGBA in place; `mask` says which texels were baked.
 */
export function dilate(rgba: Uint8ClampedArray, mask: Uint8Array, w: number, h: number, steps: number) {
  let have = Uint8Array.from(mask);
  for (let s = 0; s < steps; s++) {
    const next = Uint8Array.from(have);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (have[i]) continue;
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const j = yy * w + xx;
        if (!have[j]) continue;
        r += rgba[j * 4]; g += rgba[j * 4 + 1]; b += rgba[j * 4 + 2]; a += rgba[j * 4 + 3]; n++;
      }
      if (!n) continue;
      rgba[i * 4] = r / n; rgba[i * 4 + 1] = g / n; rgba[i * 4 + 2] = b / n; rgba[i * 4 + 3] = a / n;
      next[i] = 1;
    }
    have = next;
  }
}

// ---------- ambient occlusion ----------
export interface AoOptions {
  samples: number;
  /** How far a surface can be and still shade: farther hits don't count. */
  distance: number;
}

/** A cheap, repeatable random number from a texel and sample number. */
function hash(i: number, k: number): number {
  let x = (i * 73856093) ^ (k * 19349663);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

/**
 * Ambient occlusion through a mesh's layout: for each covered texel, how much of the sky above it is open, 1 for
 * fully open. Rays go out in a cosine-weighted spread over the surface's hemisphere, against `scene`. A generator, so
 * a long bake can pause to show progress: it yields how much is done, 0..1, and returns the result.
 */
export function* bakeAO(s: SurfaceSamples, scene: Bvh, o: AoOptions): Generator<number, Float32Array> {
  const out = new Float32Array(s.w * s.h).fill(1);
  const eps = Math.max(1e-4, o.distance * 1e-3);
  const total = s.w * s.h;
  const n = Math.max(1, Math.round(o.samples));
  for (let i = 0; i < total; i++) {
    if (i % 2048 === 0) yield i / total;
    if (!s.mask[i]) continue;
    const nx = s.nrm[i * 3], ny = s.nrm[i * 3 + 1], nz = s.nrm[i * 3 + 2];
    // A frame around the normal.
    let tx: number, ty: number, tz: number;
    if (Math.abs(nx) < 0.9) { tx = 0; ty = nz; tz = -ny; } else { tx = -nz; ty = 0; tz = nx; }
    const tl = Math.hypot(tx, ty, tz); tx /= tl; ty /= tl; tz /= tl;
    const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
    const ox = s.pos[i * 3] + nx * eps, oy = s.pos[i * 3 + 1] + ny * eps, oz = s.pos[i * 3 + 2] + nz * eps;
    let open = 0;
    for (let k = 0; k < n; k++) {
      // Stratified over the samples, jittered per texel so neighbours don't band.
      const r1 = (k + hash(i, k)) / n, r2 = hash(i, k + 7919);
      const r = Math.sqrt(r1), phi = 2 * Math.PI * r2;
      const lx = r * Math.cos(phi), ly = r * Math.sin(phi), lz = Math.sqrt(Math.max(0, 1 - r1));
      const dx = tx * lx + bx * ly + nx * lz, dy = ty * lx + by * ly + ny * lz, dz = tz * lx + bz * ly + nz * lz;
      if (!raycast(scene, ox, oy, oz, dx, dy, dz, 0, o.distance, true)) open++;
    }
    out[i] = open / n;
  }
  return out;
}

// ---------- normals from a detailed mesh ----------
export interface NormalBakeOptions {
  /** How far out from the low mesh to look for the detailed one, and how far in. */
  distance: number;
}

/**
 * A tangent-space normal map for `low` from the surface of `high`: from each covered texel, look along the low
 * surface's normal for the detailed surface, from `distance` outside to `distance` inside, and write the detailed
 * normal there in the low surface's tangent frame (glTF's: +X along U, +Y as the tangent's handedness gives, +Z out).
 * `tangents` are the low mesh's per-vertex tangents with handedness in w, as the exporter writes them. Texels that
 * find nothing come out flat. Yields progress, 0..1, and returns RGBA.
 */
export function* bakeNormals(low: BakeMesh, s: SurfaceSamples, tangents: ArrayLike<number>, high: Bvh, highNormals: ArrayLike<number>, o: NormalBakeOptions): Generator<number, { rgba: Uint8ClampedArray; found: number }> {
  const rgba = new Uint8ClampedArray(s.w * s.h * 4);
  const total = s.w * s.h;
  const I = low.indices;
  let found = 0;
  for (let i = 0; i < total; i++) {
    if (i % 2048 === 0) yield i / total;
    rgba[i * 4] = 128; rgba[i * 4 + 1] = 128; rgba[i * 4 + 2] = 255; rgba[i * 4 + 3] = 255;
    if (!s.mask[i]) continue;
    const nx = s.nrm[i * 3], ny = s.nrm[i * 3 + 1], nz = s.nrm[i * 3 + 2];
    const px = s.pos[i * 3], py = s.pos[i * 3 + 1], pz = s.pos[i * 3 + 2];
    // Look inward from outside, so the outermost detailed surface wins, as a cage would.
    const hit = raycast(high, px + nx * o.distance, py + ny * o.distance, pz + nz * o.distance, -nx, -ny, -nz, 0, o.distance * 2);
    if (!hit) continue;
    found++;
    const T = high.tris;
    const a = T[hit.tri * 3], b = T[hit.tri * 3 + 1], c = T[hit.tri * 3 + 2];
    const wa = 1 - hit.u - hit.v;
    let hx = highNormals[a * 3] * wa + highNormals[b * 3] * hit.u + highNormals[c * 3] * hit.v;
    let hy = highNormals[a * 3 + 1] * wa + highNormals[b * 3 + 1] * hit.u + highNormals[c * 3 + 1] * hit.v;
    let hz = highNormals[a * 3 + 2] * wa + highNormals[b * 3 + 2] * hit.u + highNormals[c * 3 + 2] * hit.v;
    const hl = Math.hypot(hx, hy, hz) || 1; hx /= hl; hy /= hl; hz /= hl;
    // The low surface's tangent frame at the texel, from its triangle's corners.
    const t = s.tri[i], wb = s.bary[i * 2], wc = s.bary[i * 2 + 1], w0 = 1 - wb - wc;
    const ta = I[t * 3], tb = I[t * 3 + 1], tc = I[t * 3 + 2];
    let tx = tangents[ta * 4] * w0 + tangents[tb * 4] * wb + tangents[tc * 4] * wc;
    let ty = tangents[ta * 4 + 1] * w0 + tangents[tb * 4 + 1] * wb + tangents[tc * 4 + 1] * wc;
    let tz = tangents[ta * 4 + 2] * w0 + tangents[tb * 4 + 2] * wb + tangents[tc * 4 + 2] * wc;
    const d = tx * nx + ty * ny + tz * nz;
    tx -= nx * d; ty -= ny * d; tz -= nz * d;
    const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
    const hand = tangents[ta * 4 + 3] < 0 ? -1 : 1;
    const bx = (ny * tz - nz * ty) * hand, by = (nz * tx - nx * tz) * hand, bz = (nx * ty - ny * tx) * hand;
    const X = hx * tx + hy * ty + hz * tz, Y = hx * bx + hy * by + hz * bz, Z = hx * nx + hy * ny + hz * nz;
    rgba[i * 4] = Math.round((X * 0.5 + 0.5) * 255);
    rgba[i * 4 + 1] = Math.round((Y * 0.5 + 0.5) * 255);
    rgba[i * 4 + 2] = Math.round((Math.max(0, Z) * 0.5 + 0.5) * 255);
  }
  return { rgba, found };
}

/** Run a baking generator to the end at once: for tests and small bakes. */
export function runToEnd<T>(g: Generator<number, T>): T {
  for (;;) { const r = g.next(); if (r.done) return r.value; }
}
