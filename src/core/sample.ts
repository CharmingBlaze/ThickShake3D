// The built-in demo: a rigged, animated milkshake. It exercises materials,
// smoothing groups, skinning and clips, and it's handy for testing an engine pipeline.
import * as ops from './ops';
import * as prims from './primitives';
import { autoWeights, qAxisAngle } from './skeleton';
import { emptyModel, makeMaterial, newId, type Clip, type Model } from './types';
import { smartUnwrap } from './uv';

export function buildSample(): Model {
  const m = emptyModel();
  const glass = makeMaterial(m, 'Cup', '#e9e2d6');
  glass.roughness = 0.35;
  const shake = makeMaterial(m, 'Shake', '#e88fa7');
  shake.roughness = 0.8;
  const straw = makeMaterial(m, 'Straw', '#d8413f');
  straw.roughness = 0.4;
  const cherry = makeMaterial(m, 'Cherry', '#a8121e');
  cherry.roughness = 0.2;

  ops.addPrim(m, prims.cylinder(0.42, 0.28, 1.1, 20, 4), 'Cup', { material: glass.id, center: [0, 0.55, 0] });
  const dome = prims.sphere(0.46, 20, 10);
  ops.addPrim(m, dome, 'Whip', { material: shake.id, center: [0, 1.15, 0], scale: [1, 0.62, 1] });
  ops.addPrim(m, prims.sphere(0.1, 14, 8), 'Cherry', { material: cherry.id, center: [0.02, 1.53, 0.04] });
  const strawPrim = prims.cylinder(0.045, 0.045, 1.5, 10, 10);
  ops.addPrim(m, strawPrim, 'Straw', { material: straw.id, center: [0.2, 1.65, -0.08] });

  const heads: [string, number | null, [number, number, number]][] = [
    ['Base', null, [0, 0, 0]],
    ['Top', 0, [0, 1.15, 0]],
    ['Straw1', 1, [0.2, 1.3, -0.08]],
    ['Straw2', 2, [0.2, 1.8, -0.08]],
    ['Straw3', 3, [0.2, 2.4, -0.08]],
  ];
  const ids: number[] = [];
  heads.forEach(([name, parent, head]) => {
    const id = newId(m);
    ids.push(id);
    m.bones.push({ id, name, parent: parent === null ? null : ids[parent], head });
  });
  autoWeights(m, m.verts.keys());

  const clip: Clip = { id: newId(m), name: 'Wobble', fps: 30, length: 60, loop: true, tracks: {} };
  const swing = (bone: number, ax: [number, number, number], amp: number, phase = 0) => {
    const keys = [0, 15, 30, 45, 60].map((f) => ({ f, v: qAxisAngle(ax, Math.sin((f / 60) * Math.PI * 2 + phase) * amp) }));
    clip.tracks[bone] = { pos: [], rot: keys };
  };
  swing(ids[1], [0, 0, 1], 0.08);
  swing(ids[2], [0, 0, 1], 0.2, 0.6);
  swing(ids[3], [0, 0, 1], 0.32, 1.2);
  m.clips.push(clip);

  for (const g of m.groups) {
    const fs = ops.groupFaces(m, g.id);
    void fs;
  }
  smartUnwrap(m, m.faces.keys(), 70);
  return m;
}
