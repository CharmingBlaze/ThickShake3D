// Parametric primitives. All are centred on the origin, wind outward, and have UVs.
import type { V2, V3 } from './types';

export interface Prim { verts: V3[]; faces: { v: number[]; uv: V2[] }[]; smooth: boolean }

/** The builders below lay UVs out with V up; the document's V runs down from the image's top edge. */
function vDown(p: Prim): Prim {
  for (const f of p.faces) for (const u of f.uv) u[1] = 1 - u[1];
  return p;
}

export function box(sx = 1, sy = 1, sz = 1, seg = 1): Prim {
  const verts: V3[] = [];
  const faces: Prim['faces'] = [];
  const index = new Map<string, number>();
  const vert = (p: V3) => {
    const k = p.map((x) => x.toFixed(6)).join(',');
    let i = index.get(k);
    if (i === undefined) { i = verts.length; index.set(k, i); verts.push(p); }
    return i;
  };
  // Each side: origin, u axis, v axis (u x v = outward normal).
  const sides: [V3, V3, V3][] = [
    [[-1, -1, 1], [2, 0, 0], [0, 2, 0]],   // +Z
    [[1, -1, -1], [-2, 0, 0], [0, 2, 0]],  // -Z
    [[1, -1, 1], [0, 0, -2], [0, 2, 0]],   // +X
    [[-1, -1, -1], [0, 0, 2], [0, 2, 0]],  // -X
    [[-1, 1, 1], [2, 0, 0], [0, 0, -2]],   // +Y
    [[-1, -1, -1], [2, 0, 0], [0, 0, 2]],  // -Y
  ];
  // Atlas cross-less layout: 3x2 tiles so a fresh box has non-overlapping UVs.
  sides.forEach(([o, u, v], si) => {
    const tx = si % 3, ty = Math.floor(si / 3);
    const at = (a: number, b: number): V3 => [
      (o[0] + u[0] * a + v[0] * b) * sx / 2,
      (o[1] + u[1] * a + v[1] * b) * sy / 2,
      (o[2] + u[2] * a + v[2] * b) * sz / 2,
    ];
    const tuv = (a: number, b: number): V2 => [(tx + 0.02 + a * 0.96) / 3, (ty + 0.02 + b * 0.96) / 2];
    for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
      const a0 = i / seg, a1 = (i + 1) / seg, b0 = j / seg, b1 = (j + 1) / seg;
      faces.push({
        v: [vert(at(a0, b0)), vert(at(a1, b0)), vert(at(a1, b1)), vert(at(a0, b1))],
        uv: [tuv(a0, b0), tuv(a1, b0), tuv(a1, b1), tuv(a0, b1)],
      });
    }
  });
  return vDown({ verts, faces, smooth: false });
}

export function plane(sx = 2, sz = 2, seg = 1): Prim {
  const verts: V3[] = [];
  const faces: Prim['faces'] = [];
  const id = (i: number, j: number) => j * (seg + 1) + i;
  for (let j = 0; j <= seg; j++) for (let i = 0; i <= seg; i++) verts.push([(i / seg - 0.5) * sx, 0, (0.5 - j / seg) * sz]);
  for (let j = 0; j < seg; j++) for (let i = 0; i < seg; i++) {
    faces.push({
      v: [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)],
      uv: [[i / seg, j / seg], [(i + 1) / seg, j / seg], [(i + 1) / seg, (j + 1) / seg], [i / seg, (j + 1) / seg]],
    });
  }
  return vDown({ verts, faces, smooth: false });
}

export function sphere(r = 1, seg = 16, rings = 10): Prim {
  const verts: V3[] = [[0, r, 0]];
  const faces: Prim['faces'] = [];
  for (let j = 1; j < rings; j++) {
    const phi = (j / rings) * Math.PI;
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      verts.push([r * Math.sin(phi) * Math.sin(th), r * Math.cos(phi), r * Math.sin(phi) * Math.cos(th)]);
    }
  }
  verts.push([0, -r, 0]);
  const ring = (j: number, i: number) => 1 + (j - 1) * seg + ((i + seg) % seg);
  const bottom = verts.length - 1;
  for (let i = 0; i < seg; i++) {
    const u0 = i / seg, u1 = (i + 1) / seg;
    faces.push({ v: [0, ring(1, i), ring(1, i + 1)], uv: [[(u0 + u1) / 2, 1], [u0, 1 - 1 / rings], [u1, 1 - 1 / rings]] });
    for (let j = 1; j < rings - 1; j++) {
      const v0 = 1 - j / rings, v1 = 1 - (j + 1) / rings;
      faces.push({
        v: [ring(j, i), ring(j + 1, i), ring(j + 1, i + 1), ring(j, i + 1)],
        uv: [[u0, v0], [u0, v1], [u1, v1], [u1, v0]],
      });
    }
    faces.push({ v: [ring(rings - 1, i), bottom, ring(rings - 1, i + 1)], uv: [[u0, 1 / rings], [(u0 + u1) / 2, 0], [u1, 1 / rings]] });
  }
  return vDown({ verts, faces, smooth: true });
}

export function geosphere(r = 1, subdiv = 2): Prim {
  const t = (1 + Math.sqrt(5)) / 2;
  const base: V3[] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t],
    [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const nrm = (p: V3): V3 => { const l = Math.hypot(...p); return [p[0] / l, p[1] / l, p[2] / l]; };
  const verts: V3[] = base.map(nrm);
  let tris = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];
  for (let s = 0; s < subdiv; s++) {
    const mids = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const k = a < b ? `${a}_${b}` : `${b}_${a}`;
      let i = mids.get(k);
      if (i === undefined) {
        i = verts.length;
        const A = verts[a], B = verts[b];
        verts.push(nrm([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]));
        mids.set(k, i);
      }
      return i;
    };
    const next: number[][] = [];
    for (const [a, b, c] of tris) {
      const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    tris = next;
  }
  const uvOf = (p: V3): V2 => [0.5 + Math.atan2(p[0], p[2]) / (2 * Math.PI), 0.5 + Math.asin(p[1]) / Math.PI];
  const faces = tris.map((t3) => {
    const uv = t3.map((i) => uvOf(verts[i]));
    // Unwrap triangles that straddle the longitude seam.
    const maxU = Math.max(...uv.map((u) => u[0]));
    if (maxU - Math.min(...uv.map((u) => u[0])) > 0.5) uv.forEach((u) => { if (u[0] < 0.5) u[0] += 1; });
    return { v: t3, uv };
  });
  return vDown({ verts: verts.map((p) => [p[0] * r, p[1] * r, p[2] * r] as V3), faces, smooth: true });
}

/** Cylinder or cone. radiusTop 0 gives a pointed cone with a single apex vertex. */
export function cylinder(radiusTop = 1, radiusBottom = 1, height = 2, seg = 16, stacks = 1, caps = true): Prim {
  const verts: V3[] = [];
  const faces: Prim['faces'] = [];
  const pointy = radiusTop <= 1e-6;
  const rows = pointy ? stacks : stacks + 1;
  for (let j = 0; j < rows; j++) {
    const t = j / stacks;
    const r = radiusBottom + (radiusTop - radiusBottom) * t;
    const y = -height / 2 + height * t;
    for (let i = 0; i < seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      verts.push([r * Math.sin(th), y, r * Math.cos(th)]);
    }
  }
  const id = (j: number, i: number) => j * seg + ((i + seg) % seg);
  const wallTop = caps ? 0.66 : 1;
  for (let j = 0; j < stacks; j++) for (let i = 0; i < seg; i++) {
    const u0 = i / seg, u1 = (i + 1) / seg, v0 = (j / stacks) * wallTop, v1 = ((j + 1) / stacks) * wallTop;
    if (pointy && j === stacks - 1) continue;
    faces.push({
      v: [id(j, i), id(j, i + 1), id(j + 1, i + 1), id(j + 1, i)],
      uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
    });
  }
  if (pointy) {
    const apex = verts.length;
    verts.push([0, height / 2, 0]);
    const j = stacks - 1;
    for (let i = 0; i < seg; i++) {
      const u0 = i / seg, u1 = (i + 1) / seg;
      faces.push({
        v: [id(j, i), id(j, i + 1), apex],
        uv: [[u0, (j / stacks) * wallTop], [u1, (j / stacks) * wallTop], [(u0 + u1) / 2, wallTop]],
      });
    }
  }
  const capUV = (i: number, cx: number): V2 => {
    const th = (i / seg) * Math.PI * 2;
    return [cx + Math.sin(th) * 0.16, 0.83 + Math.cos(th) * 0.16];
  };
  if (caps) {
    const bottom: number[] = [], bottomUV: V2[] = [];
    for (let i = seg - 1; i >= 0; i--) { bottom.push(id(0, i)); bottomUV.push(capUV(i, 0.18)); }
    faces.push({ v: bottom, uv: bottomUV });
    if (!pointy) {
      const top: number[] = [], topUV: V2[] = [];
      for (let i = 0; i < seg; i++) { top.push(id(stacks, i)); topUV.push(capUV(-i, 0.52)); }
      faces.push({ v: top, uv: topUV });
    }
  }
  return vDown({ verts, faces, smooth: true });
}

/**
 * A solid from a 2D outline, counter-clockwise seen from its +side. `at(a, b, side)` places an outline point in
 * 3D, with side -1 or +1 for the two caps. UVs are flat projections, ready for a later unwrap.
 */
function extrude(outline: V2[], at: (a: number, b: number, side: number) => V3): Prim {
  const n = outline.length;
  const verts: V3[] = [...outline.map(([a, b]) => at(a, b, 1)), ...outline.map(([a, b]) => at(a, b, -1))];
  const front = (i: number) => i % n, back = (i: number) => n + (i % n);
  const uv = ([a, b]: V2, shift = 0): V2 => [a + 0.5 + shift, 0.5 - b];
  const faces: Prim['faces'] = [
    { v: outline.map((_, i) => front(i)), uv: outline.map((p) => uv(p)) },
    { v: outline.map((_, i) => back(n - 1 - i)), uv: outline.map((_, i) => uv(outline[n - 1 - i], 1)) },
  ];
  for (let i = 0; i < n; i++) {
    const p = outline[i], q = outline[(i + 1) % n];
    const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
    faces.push({ v: [back(i), back(i + 1), front(i + 1), front(i)], uv: [[0, 0], [l, 0], [l, 1], [0, 1]] });
  }
  return { verts, faces, smooth: false };
}

/** A pill: good for limbs, fingers and anything organic. An odd ring count leaves the middle free to stretch. */
export function capsule(r = 0.5, height = 2, seg = 12, rings = 7): Prim {
  const p = sphere(r, seg, Math.max(3, rings | 1));
  const half = Math.max(0, height / 2 - r);
  p.verts = p.verts.map((v) => [v[0], v[1] + (v[1] >= 0 ? half : -half), v[2]]);
  return p;
}

/** A ramp: flat base, tall at the back (-Z), down to nothing at the front (+Z). */
export function wedge(): Prim {
  return extrude([[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5]], (a, b, side) => [side * 0.5, b, -a]);
}

/** A solid flight of stairs rising toward -Z. */
export function stairs(steps = 6): Prim {
  const n = Math.max(1, Math.round(steps));
  const outline: V2[] = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5]];
  // Walk back down from the top, tread then riser.
  for (let i = n - 1; i >= 1; i--) {
    const a = -0.5 + (i / n), b = -0.5 + ((i + 1) / n);
    outline.push([a, b], [a, -0.5 + i / n]);
  }
  outline.push([-0.5, -0.5 + 1 / n]);
  return extrude(outline, (a, b, side) => [side * 0.5, b, -a]);
}

/** A wall with a door-shaped opening down to the floor. */
export function doorway(openWidth = 0.5, openHeight = 0.75): Prim {
  const w = openWidth / 2, top = -0.5 + openHeight;
  return extrude(
    [[-0.5, -0.5], [-w, -0.5], [-w, top], [w, top], [w, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]],
    (a, b, side) => [a, b, side * 0.5],
  );
}

/** Square pyramid with its apex on +Y. */
export function pyramid(size = 1, height = 1): Prim {
  const a = size / 2, y = height / 2;
  const verts: V3[] = [[-a, -y, a], [a, -y, a], [a, -y, -a], [-a, -y, -a], [0, y, 0]];
  const side = (i: number, j: number, u: number): Prim['faces'][number] => ({
    v: [i, j, 4],
    uv: [[u + 0.01, 0.51], [u + 0.24, 0.51], [u + 0.125, 0.99]],
  });
  return vDown({
    verts,
    faces: [
      side(0, 1, 0), side(1, 2, 0.25), side(2, 3, 0.5), side(3, 0, 0.75),
      { v: [3, 2, 1, 0], uv: [[0.01, 0.01], [0.49, 0.01], [0.49, 0.49], [0.01, 0.49]] },
    ],
    smooth: false,
  });
}

export function torus(R = 1, r = 0.35, seg = 24, sides = 12): Prim {
  const verts: V3[] = [];
  const faces: Prim['faces'] = [];
  const id = (i: number, j: number) => ((i + seg) % seg) * sides + ((j + sides) % sides);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    for (let j = 0; j < sides; j++) {
      const b = (j / sides) * Math.PI * 2;
      const d = R + r * Math.cos(b);
      verts.push([d * Math.sin(a), r * Math.sin(b), d * Math.cos(a)]);
    }
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < sides; j++) {
    const u0 = i / seg, u1 = (i + 1) / seg, v0 = j / sides, v1 = (j + 1) / sides;
    faces.push({
      v: [id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)],
      uv: [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
    });
  }
  return vDown({ verts, faces, smooth: true });
}
