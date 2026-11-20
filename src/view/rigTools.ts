// Rigging in the view: placing joints, posing them by IK, and painting skin weights.
import * as THREE from 'three';
import { ikChain, solveIK } from '../core/anim';
import { ed } from '../core/editor';
import { ensureTrack, mirrorMaps, paintWeight, sampleTrack, setKey, smoothVertexWeight, vertexNeighbors } from '../core/skeleton';
import { uniqueName, type Bone, type Q } from '../core/types';
import { status, toast } from '../ui/feedback';
import type { Pane } from './pane';
import * as pick from './picking';
import type { SceneGraph } from './scene';

export interface RigHost { sg: SceneGraph; snap(w: THREE.Vector3): void }

export type IkDrag = { kind: 'ik'; pane: Pane; bone: number; frame: number; keep?: Q; base: Map<number, Q> };
export type WeightDrag = { kind: 'paint'; pane: Pane; neighbors: Map<number, Set<number>>; mirror: ReturnType<typeof mirrorMaps> | null };

// ---------- joints ----------
export function placeJoint(host: RigHost, p: Pane, x: number, y: number) {
  const parent = ed.activeBone;
  const parentBone = ed.model.bones.find((b) => b.id === parent);
  const through = parentBone ? new THREE.Vector3(...parentBone.head) : new THREE.Vector3();
  // Over the mesh, the joint goes inside it, centred in depth; in open space, level with its parent.
  const w = pick.pickInside(p, host.sg, x, y) ?? p.planePoint(x, y, through);
  if (ed.snap) host.snap(w);
  let id = 0;
  ed.transact('Add joint', (m) => {
    id = m.nextId++;
    const bone: Bone = { id, name: uniqueName(m.bones.map((b) => b.name), m.bones.length ? 'Bone' : 'Root'), parent: parent ?? null, head: [w.x, w.y, w.z] };
    m.bones.push(bone);
  });
  ed.activeBone = id;
  ed.selBones = new Set([id]);
  ed.mode = 'bone';
  ed.emit('selection', 'skeleton', 'tool');
  status('Click to chain another joint. Esc to stop and select a different parent.');
}

// ---------- IK ----------
/** Start posing the joint under the mouse by IK, or null if there's nothing to pose. */
export function startIK(p: Pane, x: number, y: number): IkDrag | null {
  const c = ed.clip();
  if (!ed.poseActive || !c) { toast('IK poses joints. Open the Animation workspace and create a clip.', 'info'); return null; }
  const bone = pick.pickBone(p, x, y, 14);
  if (bone === null) return null;
  if (!ikChain(ed.model, bone, 1).length) { toast('This joint has no parent to bend. Move it with the Move tool instead.', 'info'); return null; }
  const frame = Math.round(ed.frame);
  if (frame !== ed.frame) { ed.frame = frame; ed.emit('time'); }
  const pose = ed.bonePose();
  const base = new Map<number, Q>();
  for (const id of [bone, ...ikChain(ed.model, bone, ed.ikChain)]) base.set(id, [...sampleTrack(c.tracks[id], frame).rot] as Q);
  if (!ed.testPose) ed.begin('IK pose');
  ed.activeBone = bone;
  ed.selBones = new Set([bone]);
  ed.mode = 'bone';
  ed.emit('selection', 'skeleton');
  return { kind: 'ik', pane: p, bone, frame, keep: ed.ikHold ? ([...pose.get(bone)!.rot] as Q) : undefined, base };
}

export function dragIK(d: IkDrag, x: number, y: number) {
  const c = ed.clip();
  if (!c) return;
  const at = ed.bonePose().get(d.bone)!.pos;
  const here = new THREE.Vector3(...at);
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(d.pane.viewDir(here), here);
  const hit = d.pane.ray(x, y).intersectPlane(plane, new THREE.Vector3());
  if (!hit) return;
  const gap = solveIK(ed.model, c, d.frame, d.bone, [hit.x, hit.y, hit.z], ed.ikChain, d.keep);
  ed.emit('anim', 'geometry');
  status(gap > 0.01 ? `IK: out of reach by ${gap.toFixed(3)}. Raise Joints to reach further.` : `IK: ${ed.ikChain} joint${ed.ikChain === 1 ? '' : 's'} bending`);
}

/** Put the joints back as they were before the IK drag. */
export function cancelIK(d: IkDrag) {
  if (ed.testPose) {
    d.base.forEach((q, id) => setKey(ensureTrack(ed.testClip, id).rot, d.frame, q));
    ed.emit('anim', 'geometry');
  } else ed.cancel();
}

// ---------- weight paint ----------
/** Start painting weights for the active joint, or null (with a hint) if none is picked. */
export function startWeights(p: Pane): WeightDrag | null {
  if (ed.activeBone === null) { toast('Pick a bone in the Skeleton panel first.', 'warn'); return null; }
  ed.begin('Paint weights');
  return { kind: 'paint', pane: p, neighbors: vertexNeighbors(ed.model), mirror: ed.mirrorX ? mirrorMaps(ed.model) : null };
}

export function paintWeights(host: RigHost, d0: WeightDrag, p: Pane, x: number, y: number, e: PointerEvent) {
  const bone = ed.activeBone;
  if (bone === null) return;
  const P = ed.displayPositions();
  const r = ed.brush.radius;
  const strength = ed.brush.strength;
  const sub = ed.brush.mode === 'sub' || e.shiftKey;
  const smooth = ed.brush.mode === 'smooth' || e.ctrlKey;
  const seeThrough = ed.brush.through || ed.xray || p.shading === 'wire';
  const m = ed.model;
  const list = host.sg.visibleVerts;
  const at = new THREE.Vector3();
  for (let i = 0; i < list.length; i++) {
    const v = list[i];
    const s = p.project(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]);
    const d = Math.hypot(s.x - x, s.y - y);
    if (d > r) continue;
    // The brush paints the surface it's over, not whatever lies behind it.
    if (!seeThrough && pick.occluded(p, host.sg, at.fromArray(P, v * 3))) continue;
    const fall = 1 - d / r;
    const amount = strength * fall * fall;
    if (smooth) smoothVertexWeight(m, v, d0.neighbors, Math.min(1, amount * 2));
    else paintWeight(m, v, bone, sub ? 0 : 1, amount);
    const twin = d0.mirror?.vert.get(v);
    if (twin !== undefined && twin !== v) {
      if (smooth) smoothVertexWeight(m, twin, d0.neighbors, Math.min(1, amount * 2));
      else paintWeight(m, twin, d0.mirror!.bone.get(bone) ?? bone, sub ? 0 : 1, amount);
    }
  }
  host.sg.updateWeights();
  ed.emit('geometry');
}
