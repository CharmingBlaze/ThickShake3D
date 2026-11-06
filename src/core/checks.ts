// Game-readiness audit: budgets plus topology, UV and skinning problems.
import { edgeFaces, parseEdge, triangulateFace } from './geom';
import { isDegenerate } from './ops';
import type { Model } from './types';

export interface Budget { id: string; label: string; tris: number; materials: number; bones: number; texture: number }

export const BUDGETS: Budget[] = [
  { id: 'retro', label: 'Retro / PS1 style', tris: 1500, materials: 1, bones: 24, texture: 256 },
  { id: 'mobile', label: 'Mobile character', tris: 8000, materials: 2, bones: 40, texture: 1024 },
  { id: 'indie', label: 'Indie PC / console', tris: 30000, materials: 4, bones: 80, texture: 2048 },
  { id: 'hero', label: 'AAA hero asset', tris: 120000, materials: 8, bones: 200, texture: 4096 },
];

export type Severity = 'ok' | 'info' | 'warn' | 'error';

export interface CheckResult {
  id: string;
  label: string;
  value: string;
  severity: Severity;
  detail: string;
  /** Things the "Select" button can highlight. */
  verts?: number[];
  faces?: number[];
  edges?: string[];
  /** Command id that repairs this. */
  fix?: string;
  fixLabel?: string;
}

export function triangleCount(m: Model, includeAux = false): number {
  const aux = new Set(m.groups.filter((g) => g.kind !== 'mesh').map((g) => g.id));
  let n = 0;
  for (const f of m.faces) if (includeAux || !aux.has(f.g)) n += Math.max(0, f.v.length - 2);
  return n;
}

export function runChecks(m: Model, budget: Budget): CheckResult[] {
  const out: CheckResult[] = [];
  const tris = triangleCount(m);
  const over = (val: number, cap: number): Severity => (val > cap * 1.25 ? 'error' : val > cap ? 'warn' : 'ok');

  out.push({
    id: 'tris', label: 'Triangles', value: `${tris.toLocaleString()} / ${budget.tris.toLocaleString()}`,
    severity: over(tris, budget.tris), detail: 'Main meshes only. LODs and collision are not counted.',
  });

  const usedMats = new Set(m.groups.filter((g) => g.kind === 'mesh' && m.faces.some((f) => f.g === g.id)).map((g) => g.material ?? -1));
  out.push({
    id: 'materials', label: 'Draw calls (materials)', value: `${usedMats.size} / ${budget.materials}`,
    severity: over(usedMats.size, budget.materials), detail: 'Each distinct material is at least one draw call.',
  });

  out.push({
    id: 'bones', label: 'Bones', value: `${m.bones.length} / ${budget.bones}`,
    severity: over(m.bones.length, budget.bones), detail: 'Skinning cost scales with bone count.',
  });

  const largest = m.textures.reduce((s, t) => Math.max(s, t.width, t.height), 0);
  out.push({
    id: 'textures', label: 'Largest texture', value: largest ? `${largest}px / ${budget.texture}px` : 'none',
    severity: over(largest, budget.texture), detail: 'Texture memory is usually what runs out first.',
  });
  const npot = m.textures.filter((t) => !isPow2(t.width) || !isPow2(t.height));
  if (npot.length) {
    out.push({
      id: 'npot', label: 'Non-power-of-two textures', value: `${npot.length}`, severity: 'warn',
      detail: `${npot.map((t) => t.name).join(', ')}: these can't mipmap on some mobile GPUs.`,
    });
  }

  const degenerate: number[] = [];
  m.faces.forEach((f, i) => { if (isDegenerate(m, f)) degenerate.push(i); });
  out.push({
    id: 'degenerate', label: 'Degenerate faces', value: `${degenerate.length}`, severity: degenerate.length ? 'error' : 'ok',
    detail: 'Zero-area faces break normals, tangents and lightmaps.', faces: degenerate,
    fix: 'mesh.cleanDegenerate', fixLabel: 'Remove',
  });

  const used = new Set<number>();
  for (const f of m.faces) for (const v of f.v) used.add(v);
  const loose: number[] = [];
  m.verts.forEach((_, i) => { if (!used.has(i)) loose.push(i); });
  out.push({
    id: 'loose', label: 'Loose vertices', value: `${loose.length}`, severity: loose.length ? 'warn' : 'ok',
    detail: 'Vertices no face uses. They inflate bounds and vertex counts.', verts: loose,
    fix: 'mesh.cleanLoose', fixLabel: 'Remove',
  });

  // Coincident vertices: usually accidental cracks.
  const seen = new Map<string, number>();
  const dupes: number[] = [];
  m.verts.forEach((v, i) => {
    const k = `${v.p[0].toFixed(4)},${v.p[1].toFixed(4)},${v.p[2].toFixed(4)}`;
    if (seen.has(k)) dupes.push(i); else seen.set(k, i);
  });
  out.push({
    id: 'dupes', label: 'Overlapping vertices', value: `${dupes.length}`, severity: dupes.length ? 'info' : 'ok',
    detail: 'Stacked vertices. Fine at hard seams, otherwise they create visible cracks.', verts: dupes,
    fix: 'mesh.weldAll', fixLabel: 'Weld',
  });

  const ef = edgeFaces(m);
  const nonManifold: string[] = [], open: string[] = [];
  ef.forEach((list, k) => {
    if (list.length > 2) nonManifold.push(k);
    else if (list.length === 1) open.push(k);
  });
  out.push({
    id: 'nonmanifold', label: 'Non-manifold edges', value: `${nonManifold.length}`, severity: nonManifold.length ? 'error' : 'ok',
    detail: 'Edges shared by 3+ faces. These break physics hulls, baking and many importers.', edges: nonManifold,
  });
  out.push({
    id: 'open', label: 'Open edges', value: `${open.length}`, severity: open.length ? 'info' : 'ok',
    detail: 'Boundary edges. Expected on planes and cloth, but a hole on a closed prop.', edges: open,
    fix: 'mesh.fillHolesAll', fixLabel: 'Fill',
  });

  const ngons: number[] = [];
  m.faces.forEach((f, i) => { if (f.v.length > 4) ngons.push(i); });
  out.push({
    id: 'ngons', label: 'N-gons (5+ sides)', value: `${ngons.length}`, severity: ngons.length ? 'info' : 'ok',
    detail: 'Exported as triangles automatically; check they deform well.', faces: ngons,
    fix: 'mesh.triangulateNgons', fixLabel: 'Triangulate',
  });

  const noUV: number[] = [];
  m.faces.forEach((f, i) => {
    const us = f.uv.map((u) => `${u[0].toFixed(5)},${u[1].toFixed(5)}`);
    if (new Set(us).size < Math.min(3, f.v.length)) noUV.push(i);
  });
  const outside: number[] = [];
  m.faces.forEach((f, i) => { if (f.uv.some((u) => u[0] < -0.001 || u[0] > 1.001 || u[1] < -0.001 || u[1] > 1.001)) outside.push(i); });
  out.push({
    id: 'nouv', label: 'Faces with collapsed UVs', value: `${noUV.length}`, severity: noUV.length ? 'warn' : 'ok',
    detail: 'These will sample a single texel and smear.', faces: noUV, fix: 'uv.smartAll', fixLabel: 'Unwrap',
  });
  if (outside.length) {
    out.push({
      id: 'uvoutside', label: 'UVs outside 0-1', value: `${outside.length}`, severity: 'info',
      detail: 'Fine for tiling textures, wrong for atlases and lightmaps.', faces: outside,
    });
  }

  if (m.bones.length) {
    const unbound: number[] = [], heavy: number[] = [];
    m.verts.forEach((v, i) => {
      if (!used.has(i)) return;
      if (!v.w?.length) unbound.push(i);
      else if (v.w.length > 4) heavy.push(i);
    });
    out.push({
      id: 'unbound', label: 'Unskinned vertices', value: `${unbound.length}`, severity: unbound.length ? 'warn' : 'ok',
      detail: 'These stay frozen in place while the skeleton moves.', verts: unbound,
      fix: 'rig.autoWeightsAll', fixLabel: 'Auto-weight',
    });
    out.push({
      id: 'heavy', label: 'Over 4 bone influences', value: `${heavy.length}`, severity: heavy.length ? 'error' : 'ok',
      detail: 'Most engines cap skinning at 4 influences.', verts: heavy,
    });
  }

  const hasCollision = m.groups.some((g) => g.kind === 'collision');
  const hasLod = m.groups.some((g) => g.kind === 'lod');
  if (tris > 2000 && !hasLod) {
    out.push({
      id: 'lod', label: 'No LODs', value: 'none', severity: 'info',
      detail: 'A model this dense benefits from level-of-detail meshes.', fix: 'mesh.generateLods', fixLabel: 'Generate',
    });
  }
  if (m.faces.length && !hasCollision) {
    out.push({
      id: 'collision', label: 'No collision mesh', value: 'none', severity: 'info',
      detail: 'Add a simple hull so the engine does not collide against every triangle.',
      fix: 'mesh.collisionHull', fixLabel: 'Generate',
    });
  }
  return out;
}

const isPow2 = (x: number) => x > 0 && (x & (x - 1)) === 0;

export { parseEdge, triangulateFace };
