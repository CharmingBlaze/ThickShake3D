// Joint constraints: rotation limits, IK chains, look-at and copy rotation, applied on top of a clip's keys each time
// a pose is worked out. Exports bake them into plain keys, since engines read keys, not these rules.
import { cross, dot, len, norm, sub } from './geom';
import { easeT, forwardPose, qAxisAngle, qConj, qFromEuler, qMul, qNorm, qRotate, qSlerp, qToEuler, sampleTrack, type BonePose } from './skeleton';
import { cloneModel, type Clip, type Constraint, type Key, type Model, type Q, type V3 } from './types';

/** Each joint's own keyed offset and rotation, before its parents are applied. */
export type Locals = Map<number, { pos: V3; rot: Q }>;

const qIdent: Q = [0, 0, 0, 1];

/** A number track's value at a frame, eased like the rest. */
export function sampleNumber(keys: Key<number>[], f: number): number {
  if (!keys.length) return 0;
  if (f <= keys[0].f) return keys[0].v;
  const last = keys[keys.length - 1];
  if (f >= last.f) return last.v;
  let i = 1;
  while (keys[i].f < f) i++;
  const a = keys[i - 1], b = keys[i];
  return a.v + (b.v - a.v) * easeT(a, (f - a.f) / (b.f - a.f));
}

/** How strongly a constraint applies at a frame: its keyed weight in the clip if it has one, or its own. */
export function constraintWeight(c: Constraint, clip: Clip | null, frame: number): number {
  const keys = clip?.weights?.[c.id];
  return Math.max(0, Math.min(1, keys?.length ? sampleNumber(keys, frame) : c.weight));
}

/** The shortest rotation taking direction `a` to direction `b`. */
function rotationBetween(a: V3, b: V3): Q {
  const na = norm(a), nb = norm(b);
  const axis = cross(na, nb);
  const s = len(axis);
  if (s < 1e-9) return qIdent;
  return qAxisAngle(norm(axis), Math.atan2(s, dot(na, nb)));
}

/** Turn a joint so its world rotation becomes `delta` × what it was, by changing its local rotation. */
function turnWorld(locals: Locals, id: number, parentRot: Q, delta: Q) {
  const l = locals.get(id)!;
  l.rot = qNorm(qMul(qMul(qMul(qConj(parentRot), delta), parentRot), l.rot));
}

function clampLimit(rot: Q, c: Extract<Constraint, { kind: 'limit' }>): Q {
  const e = qToEuler(rot);
  const k = [0, 1, 2].map((i) => Math.min(c.max[i], Math.max(c.min[i], e[i])));
  return qFromEuler(k[0], k[1], k[2]);
}

/** Which way a joint points at rest: toward its first child, or on along its parent's line, or up. */
export function restAim(m: Model, id: number): V3 {
  const b = m.bones.find((x) => x.id === id);
  if (!b) return [0, 1, 0];
  const child = m.bones.find((x) => x.parent === id);
  if (child) { const d = sub(child.head, b.head); if (len(d) > 1e-9) return norm(d); }
  const parent = b.parent !== null ? m.bones.find((x) => x.id === b.parent) : undefined;
  if (parent) { const d = sub(b.head, parent.head); if (len(d) > 1e-9) return norm(d); }
  return [0, 1, 0];
}

/** The joints an IK constraint bends: the end joint's parent, then upward, `n` of them. */
export function chainOf(m: Model, end: number, n: number): number[] {
  const out: number[] = [];
  const byId = new Map(m.bones.map((b) => [b.id, b]));
  let p = byId.get(end)?.parent ?? null;
  while (p !== null && out.length < n) { out.push(p); p = byId.get(p)?.parent ?? null; }
  return out;
}

/** Apply the model's constraints, in order, to the joints' local rotations. */
export function applyConstraints(m: Model, clip: Clip | null, frame: number, locals: Locals) {
  const list = m.constraints;
  if (!list?.length) return;
  const parentOf = new Map(m.bones.map((b) => [b.id, b.parent]));
  const limits = new Map<number, Extract<Constraint, { kind: 'limit' }>>();
  for (const c of list) if (c.kind === 'limit' && c.weight > 0) limits.set(c.bone, c);
  const parentRot = (pose: Map<number, BonePose>, id: number): Q => {
    const p = parentOf.get(id);
    return p !== null && p !== undefined ? pose.get(p)?.rot ?? qIdent : qIdent;
  };
  for (const c of list) {
    if (!locals.has(c.bone)) continue;
    const w = constraintWeight(c, clip, frame);
    if (w <= 0) continue;
    const own = locals.get(c.bone)!;
    if (c.kind === 'limit') { own.rot = qSlerp(own.rot, clampLimit(own.rot, c), w); continue; }
    if (!locals.has(c.target)) continue;
    if (c.kind === 'copyRot') { own.rot = qSlerp(own.rot, locals.get(c.target)!.rot, w); continue; }
    if (c.kind === 'lookAt') {
      const pose = forwardPose(m, locals);
      const here = pose.get(c.bone)!;
      const aim = qRotate(here.rot, restAim(m, c.bone));
      const to = sub(pose.get(c.target)!.pos, here.pos);
      if (len(to) < 1e-9) continue;
      const before = own.rot;
      turnWorld(locals, c.bone, parentRot(pose, c.bone), rotationBetween(aim, to));
      own.rot = qSlerp(before, own.rot, w);
      continue;
    }
    // IK: cyclic coordinate descent, then the pole, then the end's rotation, then blend with the keyed pose.
    const chain = chainOf(m, c.bone, c.chain);
    if (!chain.length) continue;
    const touched = c.align ? [...chain, c.bone] : chain;
    const keyed = new Map(touched.map((id) => [id, [...locals.get(id)!.rot] as Q]));
    const start = forwardPose(m, locals);
    const target = start.get(c.target)!;
    for (let it = 0; it < 20; it++) {
      for (const id of chain) {
        const pose = forwardPose(m, locals);
        const here = pose.get(id)!.pos, tip = pose.get(c.bone)!.pos;
        const toTip = sub(tip, here), toTarget = sub(target.pos, here);
        if (len(toTip) < 1e-9 || len(toTarget) < 1e-9) continue;
        let delta = rotationBetween(toTip, toTarget);
        if (delta === qIdent && len(toTarget) < len(toTip) - 1e-4) {
          // A straight chain can't bend toward a nearer target by turning: start a bend, toward the pole if there is one.
          const pole = c.pole !== null ? pose.get(c.pole)?.pos : undefined;
          const side = pole ? sub(pole, here) : (Math.abs(toTip[0]) < 0.9 ? [1, 0, 0] as V3 : [0, 0, 1] as V3);
          const axis = cross(toTip, side);
          if (len(axis) > 1e-9) delta = qAxisAngle(norm(axis), 0.2);
        }
        turnWorld(locals, id, parentRot(pose, id), delta);
        const lim = limits.get(id);
        if (lim) locals.get(id)!.rot = clampLimit(locals.get(id)!.rot, lim);
      }
      const pose = forwardPose(m, locals);
      if (len(sub(pose.get(c.bone)!.pos, target.pos)) < 1e-5) break;
    }
    if (c.pole !== null && chain.length >= 2 && locals.has(c.pole)) {
      // Swing the whole chain about the line from its root to its end, so its bend faces the pole.
      const pose = forwardPose(m, locals);
      const top = chain[chain.length - 1];
      const root = pose.get(top)!.pos, end = pose.get(c.bone)!.pos, mid = pose.get(chain[0])!.pos, pole = pose.get(c.pole)!.pos;
      const axis = sub(end, root);
      if (len(axis) > 1e-9) {
        const ax = norm(axis);
        const flat = (p: V3): V3 => { const d = sub(p, root); return sub(d, [ax[0] * dot(d, ax), ax[1] * dot(d, ax), ax[2] * dot(d, ax)]); };
        const a = flat(mid), b = flat(pole);
        if (len(a) > 1e-9 && len(b) > 1e-9) {
          const angle = Math.atan2(dot(cross(a, b), ax), dot(a, b));
          turnWorld(locals, top, parentRot(pose, top), qAxisAngle(ax, angle));
        }
      }
    }
    if (c.align) {
      const pose = forwardPose(m, locals);
      locals.get(c.bone)!.rot = qNorm(qMul(qConj(parentRot(pose, c.bone)), target.rot));
    }
    if (w < 1) for (const id of touched) locals.get(id)!.rot = qSlerp(keyed.get(id)!, locals.get(id)!.rot, w);
  }
}

/** The keyed locals of every joint at a frame. */
export function sampleLocals(m: Model, clip: Clip | null, frame: number): Locals {
  const out: Locals = new Map();
  for (const b of m.bones) {
    const s = clip ? sampleTrack(clip.tracks[b.id], frame) : { pos: [0, 0, 0] as V3, rot: qIdent };
    out.set(b.id, { pos: [...s.pos] as V3, rot: [...s.rot] as Q });
  }
  return out;
}

/** The joints whose rotation constraints change. */
export function constrainedJoints(m: Model): Set<number> {
  const out = new Set<number>();
  for (const c of m.constraints ?? []) {
    out.add(c.bone);
    if (c.kind === 'ik') chainOf(m, c.bone, c.chain).forEach((id) => out.add(id));
  }
  return out;
}

/**
 * A copy of a clip with what the constraints do written in as keys, one on every frame for the joints they move,
 * so the motion plays the same where constraints aren't known.
 */
export function bakeConstraints(m: Model, clip: Clip): Clip {
  const out: Clip = structuredClone(clip);
  delete out.weights;
  const joints = constrainedJoints(m);
  if (!joints.size) return out;
  const rot = new Map<number, Key<Q>[]>([...joints].map((id) => [id, []]));
  for (let f = 0; f <= Math.max(0, Math.round(clip.length)); f++) {
    const locals = sampleLocals(m, clip, f);
    applyConstraints(m, clip, f, locals);
    for (const id of joints) rot.get(id)!.push({ f, v: locals.get(id)!.rot });
  }
  for (const id of joints) {
    const t = out.tracks[id] ?? (out.tracks[id] = { pos: [], rot: [] });
    t.rot = rot.get(id)!;
  }
  return out;
}

/**
 * The model as an export should see it: every clip with its constraints baked in, and the control joints, such as IK
 * targets, taken out along with their keys.
 */
export function prepareRigForExport(m: Model): Model {
  if (!m.constraints?.length && !m.bones.some((b) => b.control)) return m;
  const out = cloneModel(m);
  out.clips = out.clips.map((c) => bakeConstraints(m, c));
  delete out.constraints;
  const controls = new Set(out.bones.filter((b) => b.control && !out.bones.some((x) => x.parent === b.id)).map((b) => b.id));
  if (controls.size) {
    out.bones = out.bones.filter((b) => !controls.has(b.id));
    for (const c of out.clips) for (const id of controls) delete c.tracks[id];
    for (const v of out.verts) if (v.w) v.w = v.w.filter((x) => !controls.has(x[0]));
  }
  return out;
}

// ---------- switching between IK and FK ----------
/**
 * Snap an IK constraint's target to where the chain's end is in the keyed (FK) pose at a frame, keying the target
 * there, so switching to IK doesn't jump. Works for a target with no parent.
 */
export function snapTargetToFK(m: Model, clip: Clip, frame: number, c: Extract<Constraint, { kind: 'ik' }>) {
  const fk = forwardPose(m, sampleLocals(m, clip, frame));
  const end = fk.get(c.bone), tb = m.bones.find((b) => b.id === c.target);
  if (!end || !tb) return;
  const parent = tb.parent !== null ? fk.get(tb.parent) : undefined;
  const t = clip.tracks[tb.id] ?? (clip.tracks[tb.id] = { pos: [], rot: [] });
  // The target's keyed offset is in its parent's space, from its rest place.
  let pos: V3, rot: Q;
  if (parent) {
    const ph = m.bones.find((b) => b.id === tb.parent)!.head;
    pos = sub(qRotate(qConj(parent.rot), sub(end.pos, parent.pos)), sub(tb.head, ph));
    rot = qNorm(qMul(qConj(parent.rot), end.rot));
  } else {
    pos = sub(end.pos, tb.head);
    rot = end.rot;
  }
  setKeyAt(t.pos, frame, pos);
  setKeyAt(t.rot, frame, rot);
}

/** Write an IK chain's solved rotations into its keys at a frame, so switching to FK doesn't jump. */
export function bakeIKToFK(m: Model, clip: Clip, frame: number, c: Extract<Constraint, { kind: 'ik' }>) {
  const locals = sampleLocals(m, clip, frame);
  applyConstraints(m, clip, frame, locals);
  for (const id of c.align ? [...chainOf(m, c.bone, c.chain), c.bone] : chainOf(m, c.bone, c.chain)) {
    const t = clip.tracks[id] ?? (clip.tracks[id] = { pos: [], rot: [] });
    setKeyAt(t.rot, frame, locals.get(id)!.rot);
  }
}

/** Key a constraint's weight at a frame. */
export function keyWeight(clip: Clip, id: number, frame: number, w: number) {
  const all = clip.weights ?? (clip.weights = {});
  setKeyAt(all[id] ?? (all[id] = []), frame, Math.max(0, Math.min(1, w)));
}

function setKeyAt<T>(keys: Key<T>[], f: number, v: T) {
  const i = keys.findIndex((k) => k.f === f);
  if (i >= 0) keys[i] = { ...keys[i], v };
  else { keys.push({ f, v }); keys.sort((a, b) => a.f - b.f); }
}

