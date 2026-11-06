// Animation editing: easing, key operations, whole-clip tools, poses and inverse kinematics.
import { cross, dist, dot, len, norm, sub } from './geom';
import { easeT, ensureTrack, evalPose, keyFrames, mirrorMaps, qAxisAngle, qConj, qMul, qNorm, qSlerp, sampleTrack, setKey } from './skeleton';
import type { Clip, Key, Model, Q, Track, V3 } from './types';

export type EaseName = 'linear' | 'smooth' | 'in' | 'out' | 'overshoot' | 'anticipate' | 'step';

export const EASES: Record<Exclude<EaseName, 'linear' | 'step'>, [number, number, number, number]> = {
  smooth: [0.42, 0, 0.58, 1],
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  anticipate: [0.36, 0, 0.66, -0.56],
};

export function applyEase<T>(key: Key<T>, ease: EaseName) {
  delete key.c;
  delete key.step;
  if (ease === 'step') key.step = true;
  else if (ease !== 'linear') key.c = [...EASES[ease]];
}

export function easeOf(key: Key<unknown>): EaseName | 'custom' {
  if (key.step) return 'step';
  if (!key.c) return 'linear';
  for (const [name, c] of Object.entries(EASES)) if (c.every((x, i) => Math.abs(x - key.c![i]) < 1e-6)) return name as EaseName;
  return 'custom';
}

/** One selected moment on one joint's timeline. */
export interface KeyRef { bone: number; f: number }

const lists = (t: Track): Key<unknown>[][] => [t.rot, t.pos];

export function setEase(c: Clip, refs: KeyRef[], ease: EaseName) {
  for (const { bone, f } of refs) {
    const t = c.tracks[bone];
    if (!t) continue;
    for (const list of lists(t)) { const k = list.find((x) => x.f === f); if (k) applyEase(k, ease); }
  }
}

export function deleteKeys(c: Clip, refs: KeyRef[]) {
  for (const { bone, f } of refs) {
    const t = c.tracks[bone];
    if (!t) continue;
    t.rot = t.rot.filter((k) => k.f !== f);
    t.pos = t.pos.filter((k) => k.f !== f);
  }
}

/** Remap the frames of the given keys. A key landing on an unselected key replaces it. `copy` leaves the originals. */
export function remapKeys(c: Clip, refs: KeyRef[], to: (f: number) => number, copy = false) {
  const byBone = new Map<number, Set<number>>();
  for (const { bone, f } of refs) { const s = byBone.get(bone) ?? new Set(); s.add(f); byBone.set(bone, s); }
  byBone.forEach((frames, bone) => {
    const t = c.tracks[bone];
    if (!t) return;
    const remap = <T>(list: Key<T>[]): Key<T>[] => {
      const moving = list.filter((k) => frames.has(k.f));
      const kept = copy ? list : list.filter((k) => !frames.has(k.f));
      const moved = moving.map((k) => ({ ...structuredClone(k), f: Math.max(0, Math.round(to(k.f))) }));
      const at = new Set(moved.map((k) => k.f));
      return [...kept.filter((k) => !at.has(k.f)), ...moved].sort((a, b) => a.f - b.f);
    };
    t.rot = remap(t.rot);
    t.pos = remap(t.pos);
  });
}

export interface KeyClip { base: number; items: { bone: number; f: number; rot?: Key<Q>; pos?: Key<V3> }[] }

export function copyKeys(c: Clip, refs: KeyRef[]): KeyClip | null {
  if (!refs.length) return null;
  const base = Math.min(...refs.map((r) => r.f));
  const items = refs.map(({ bone, f }) => ({
    bone, f: f - base,
    rot: structuredClone(c.tracks[bone]?.rot.find((k) => k.f === f)),
    pos: structuredClone(c.tracks[bone]?.pos.find((k) => k.f === f)),
  }));
  return { base, items };
}

export function pasteKeys(c: Clip, data: KeyClip, frame: number) {
  for (const it of data.items) {
    const t = ensureTrack(c, it.bone);
    const f = Math.round(frame + it.f);
    const put = <T>(list: Key<T>[], k: Key<T> | undefined) => {
      if (!k) return;
      const i = list.findIndex((x) => x.f === f);
      if (i >= 0) list.splice(i, 1);
      list.push({ ...structuredClone(k), f });
      list.sort((a, b) => a.f - b.f);
    };
    put(t.rot, it.rot);
    put(t.pos, it.pos);
  }
}

// ---------- flattening for export ----------
/**
 * The same motion as plain linear keys, for formats that don't store curves: eased segments sample every frame,
 * and held segments become a jump just before the next key.
 */
export function flattenKeys<T>(keys: Key<T>[], sample: (f: number) => T): Key<T>[] {
  const out: Key<T>[] = [];
  keys.forEach((k, i) => {
    out.push({ f: k.f, v: k.v });
    const next = keys[i + 1];
    if (!next) return;
    if (k.step) out.push({ f: next.f - 1e-3, v: k.v });
    else if (k.c) for (let f = k.f + 1; f < next.f; f++) out.push({ f, v: sample(f) });
  });
  return out;
}

export function flattenTrack(t: Track): Track {
  return {
    rot: flattenKeys(t.rot, (f) => [...sampleTrack(t, f).rot] as Q),
    pos: flattenKeys(t.pos, (f) => [...sampleTrack(t, f).pos] as V3),
  };
}

// ---------- whole clips ----------
function eachList(c: Clip, fn: (list: Key<unknown>[], t: Track) => void) {
  for (const t of Object.values(c.tracks)) for (const list of lists(t)) fn(list, t);
}

export function clipEnd(c: Clip): number {
  const frames = keyFrames(c);
  return frames.length ? frames[frames.length - 1] : 0;
}

/** Play the clip backward. Each segment's curve moves with it, mirrored so the motion is a true reverse. */
export function reverseClip(c: Clip) {
  eachList(c, (list) => {
    const old = list.map((k) => ({ ...k }));
    const n = old.length;
    list.length = 0;
    for (let i = n - 1; i >= 0; i--) {
      const k = old[i];
      const seg = old[i - 1]; // The segment that now follows this key used to lead into it.
      const out: Key<unknown> = { f: c.length - k.f, v: k.v };
      if (seg?.c) out.c = [1 - seg.c[2], 1 - seg.c[3], 1 - seg.c[0], 1 - seg.c[1]];
      if (seg?.step) out.step = true;
      list.push(out);
    }
  });
}

/** Stretch or squash the clip's timing. Below 1 plays faster. */
export function retimeClip(c: Clip, factor: number) {
  eachList(c, (list) => {
    const seen = new Map<number, Key<unknown>>();
    for (const k of list) { k.f = Math.round(k.f * factor); seen.set(k.f, k); }
    const merged = [...seen.values()].sort((a, b) => a.f - b.f);
    list.length = 0;
    list.push(...merged);
  });
  c.length = Math.max(1, Math.round(c.length * factor));
}

/** Copy each track's first pose to the last frame, so the clip loops without a jump. */
export function makeLoop(c: Clip) {
  eachList(c, (list) => {
    if (!list.length) return;
    const first = list[0];
    if (first.f !== 0) list.unshift({ f: 0, v: first.v });
    const i = list.findIndex((k) => k.f === c.length);
    if (i >= 0) list.splice(i, 1);
    list.push({ f: c.length, v: first.v });
    list.sort((a, b) => a.f - b.f);
    // Anything after the end can't play.
    for (let n = list.length - 1; n >= 0; n--) if (list[n].f > c.length) list.splice(n, 1);
  });
  c.loop = true;
}

const qDiff = (a: Q, b: Q) => {
  const d = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(Math.min(1, d)); // Radians between the two rotations.
};

/**
 * Remove keys the motion doesn't need. Each key goes if every frame around it stays within tolerance:
 * `angle` in degrees for rotation and `distance` in units for position.
 */
export function reduceKeys(c: Clip, angle = 0.5, distance = 0.002): number {
  let removed = 0;
  const tolR = (angle * Math.PI) / 180;
  for (const t of Object.values(c.tracks)) {
    const sweep = <T>(keys: Key<T>[], sample: (list: Key<T>[], f: number) => T, diff: (a: T, b: T) => number, tol: number) => {
      for (let i = keys.length - 2; i > 0; i--) {
        const a = keys[i - 1], b = keys[i + 1];
        const without = [...keys.slice(0, i), ...keys.slice(i + 1)];
        let ok = true;
        for (let f = a.f; f <= b.f && ok; f++) if (diff(sample(keys, f), sample(without, f)) > tol) ok = false;
        if (ok) { keys.splice(i, 1); removed++; }
      }
    };
    sweep(t.rot, (list, f) => sampleTrack({ rot: list, pos: [] }, f).rot, qDiff, tolR);
    sweep(t.pos, (list, f) => sampleTrack({ rot: [], pos: list }, f).pos, (a, b) => dist(a, b), distance);
  }
  return removed;
}

/** Replace all curves with a linear key on every frame. */
export function bakeClip(c: Clip, step = 1) {
  for (const t of Object.values(c.tracks)) {
    const src: Track = structuredClone(t);
    if (src.rot.length) { t.rot = []; for (let f = 0; f <= c.length; f += step) t.rot.push({ f, v: [...sampleTrack(src, f).rot] as Q }); }
    if (src.pos.length) { t.pos = []; for (let f = 0; f <= c.length; f += step) t.pos.push({ f, v: [...sampleTrack(src, f).pos] as V3 }); }
  }
}

const mirrorQ = (q: Q): Q => [q[0], -q[1], -q[2], q[3]];
const mirrorV = (v: V3): V3 => [-v[0], v[1], v[2]];

/** Swap left and right across X for the whole clip: joints trade tracks, and each key reflects. */
export function mirrorClip(c: Clip, m: Model) {
  const { bone } = mirrorMaps(m);
  const next: Record<number, Track> = {};
  for (const [id, t] of Object.entries(c.tracks)) {
    next[bone.get(+id) ?? +id] = {
      rot: t.rot.map((k) => ({ ...k, v: mirrorQ(k.v) })),
      pos: t.pos.map((k) => ({ ...k, v: mirrorV(k.v) })),
    };
  }
  c.tracks = next;
}

// ---------- poses ----------
export type Pose = Map<number, { rot: Q; pos: V3 }>;

export function capturePose(c: Clip, frame: number, ids: Iterable<number>): Pose {
  const out: Pose = new Map();
  for (const id of ids) {
    const s = sampleTrack(c.tracks[id], frame);
    out.set(id, { rot: [...s.rot] as Q, pos: [...s.pos] as V3 });
  }
  return out;
}

export function applyPose(c: Clip, frame: number, pose: Pose, m?: Model, mirrored = false) {
  const map = mirrored && m ? mirrorMaps(m).bone : null;
  pose.forEach((p, id) => {
    const t = ensureTrack(c, map?.get(id) ?? id);
    setKey(t.rot, frame, mirrored ? mirrorQ(p.rot) : p.rot);
    setKey(t.pos, frame, mirrored ? mirrorV(p.pos) : p.pos);
  });
}

export function resetPose(c: Clip, frame: number, ids: Iterable<number>) {
  for (const id of ids) {
    const t = ensureTrack(c, id);
    setKey(t.rot, frame, [0, 0, 0, 1] as Q);
    setKey(t.pos, frame, [0, 0, 0] as V3);
  }
}

// ---------- inverse kinematics ----------
/** The joints an IK solve rotates: the dragged joint's parent, then upward. */
export function ikChain(m: Model, end: number, length: number): number[] {
  const out: number[] = [];
  const byId = new Map(m.bones.map((b) => [b.id, b]));
  let p = byId.get(end)?.parent ?? null;
  while (p !== null && out.length < length) { out.push(p); p = byId.get(p)?.parent ?? null; }
  return out;
}

/**
 * Cyclic coordinate descent: swing each joint in turn so the end reaches the target. Writes rotation keys at `frame`.
 * With `keepEnd`, the end joint holds that world rotation, so a foot stays flat as the leg moves.
 * Returns the remaining distance to the target.
 */
export function solveIK(m: Model, c: Clip, frame: number, end: number, target: V3, length = 2, keepEnd?: Q): number {
  const chain = ikChain(m, end, length);
  if (!chain.length) return Infinity;
  const parentOf = new Map(m.bones.map((b) => [b.id, b.parent]));
  const localRot = (id: number) => sampleTrack(c.tracks[id], frame).rot;
  const setRot = (id: number, q: Q) => setKey(ensureTrack(c, id).rot, frame, q);
  // Keep the keys of the joints we touch in the same state whether or not the solve converges.
  for (const id of chain) setRot(id, [...localRot(id)] as Q);
  let gap = Infinity;
  for (let it = 0; it < 24; it++) {
    for (const id of chain) {
      const pose = evalPose(m, c, frame);
      const here = pose.get(id)!.pos, tip = pose.get(end)!.pos;
      const toTip = sub(tip, here), toTarget = sub(target, here);
      const lt = len(toTip), lg = len(toTarget);
      if (lt < 1e-6 || lg < 1e-6) continue;
      const a = norm(toTip), b = norm(toTarget);
      let axis = cross(a, b);
      let angle = Math.atan2(len(axis), dot(a, b));
      if (len(axis) < 1e-5) {
        // A straight chain has no bend to work with. Start one when the target is closer than the tip.
        if (lg >= lt - 1e-4) continue;
        axis = cross(a, Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1]);
        angle = 0.2;
      }
      const world = qAxisAngle(norm(axis), angle);
      const parent = parentOf.get(id) ?? null;
      const pr: Q = parent !== null ? pose.get(parent)?.rot ?? [0, 0, 0, 1] : [0, 0, 0, 1];
      setRot(id, qNorm(qMul(qMul(qMul(qConj(pr), world), pr), localRot(id))));
    }
    gap = dist(evalPose(m, c, frame).get(end)!.pos, target);
    if (gap < 1e-4) break;
  }
  if (keepEnd) {
    const parent = parentOf.get(end) ?? null;
    const pose = evalPose(m, c, frame);
    const pr: Q = parent !== null ? pose.get(parent)?.rot ?? [0, 0, 0, 1] : [0, 0, 0, 1];
    setRot(end, qNorm(qMul(qConj(pr), keepEnd)));
  }
  return gap;
}

export { easeT, qSlerp };
