// Reader and writer for the MS3D v4 binary model format, so existing
// MilkShape 3D work can move into ThickShake and back.
import { edgeKey } from '../core/geom';
import { flattenTrack } from '../core/anim';
import { qConj, qFromEuler, qMul, qNorm, qRotate, qToEuler, bonesTopo, sampleTrack } from '../core/skeleton';
import { emptyModel, makeGroup, makeMaterial, newId, type Clip, type Model, type Q, type V2, type V3 } from '../core/types';
import { triangulateFace } from '../core/geom';

class Reader {
  o = 0;
  dv: DataView;
  constructor(public b: ArrayBuffer) { this.dv = new DataView(b); }
  u8() { return this.dv.getUint8(this.o++); }
  i8() { return this.dv.getInt8(this.o++); }
  u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i32() { const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  v3(): V3 { return [this.f32(), this.f32(), this.f32()]; }
  str(n: number) {
    const bytes = new Uint8Array(this.b, this.o, n);
    this.o += n;
    const end = bytes.indexOf(0);
    return new TextDecoder('latin1').decode(end >= 0 ? bytes.subarray(0, end) : bytes);
  }
  get remaining() { return this.b.byteLength - this.o; }
}

export function importMS3D(buf: ArrayBuffer, name: string): Model {
  const r = new Reader(buf);
  if (r.str(10) !== 'MS3D000000') throw new Error('Not an MS3D file (bad header).');
  const version = r.i32();
  if (version < 3 || version > 4) throw new Error(`Unsupported MS3D version ${version}.`);

  const m = emptyModel();
  const nv = r.u16();
  const boneOf: number[] = [];
  for (let i = 0; i < nv; i++) {
    r.u8();
    const p = r.v3();
    boneOf.push(r.i8());
    r.u8();
    m.verts.push({ p });
  }
  const nt = r.u16();
  const tris: { v: number[]; s: number[]; t: number[]; sg: number; g: number }[] = [];
  for (let i = 0; i < nt; i++) {
    r.u16();
    const v = [r.u16(), r.u16(), r.u16()];
    r.o += 36; // stored normals; recomputed from smoothing groups
    const s = [r.f32(), r.f32(), r.f32()];
    const t = [r.f32(), r.f32(), r.f32()];
    const sg = r.u8();
    const g = r.u8();
    tris.push({ v, s, t, sg, g });
  }
  const ng = r.u16();
  const groupInfo: { name: string; material: number; id: number }[] = [];
  for (let i = 0; i < ng; i++) {
    r.u8();
    const gname = r.str(32);
    const n = r.u16();
    r.o += n * 2;
    groupInfo.push({ name: gname, material: r.i8(), id: 0 });
  }
  const nm = r.u16();
  const matIds: number[] = [];
  for (let i = 0; i < nm; i++) {
    const mname = r.str(32);
    r.o += 16; // ambient
    const diff = [r.f32(), r.f32(), r.f32(), r.f32()];
    r.o += 16; // specular
    const emis = [r.f32(), r.f32(), r.f32(), r.f32()];
    const shininess = r.f32();
    const transparency = r.f32();
    r.i8();
    r.str(128); r.str(128);
    const mat = makeMaterial(m, mname || `Material ${i + 1}`);
    mat.color = rgbHex(diff);
    mat.emissive = rgbHex(emis);
    mat.alpha = transparency;
    mat.roughness = Math.max(0.05, Math.min(1, 1 - shininess / 128));
    if (transparency < 1) mat.alphaMode = 'blend';
    matIds.push(mat.id);
  }
  for (const g of groupInfo) {
    const gr = makeGroup(m, g.name || 'Group', g.material >= 0 ? matIds[g.material] ?? null : null);
    g.id = gr.id;
  }
  for (const t of tris) {
    const gid = groupInfo[t.g]?.id;
    if (gid === undefined) continue;
    // MS3D smoothing group 0 still means flat in our model; shift to keep ids positive.
    m.faces.push({ v: t.v, uv: [[t.s[0], t.t[0]], [t.s[1], t.t[1]], [t.s[2], t.t[2]]] as V2[], g: gid, s: t.sg });
  }

  if (r.remaining < 10) return finish(m);
  const fps = r.f32() || 25;
  r.f32();
  const totalFrames = r.i32();
  const nj = r.u16();

  interface J { name: string; parent: string; rot: V3; pos: V3; kr: { t: number; v: V3 }[]; kp: { t: number; v: V3 }[]; id: number; }
  const joints: J[] = [];
  for (let i = 0; i < nj; i++) {
    r.u8();
    const jname = r.str(32);
    const parent = r.str(32);
    const rot = r.v3();
    const pos = r.v3();
    const nr = r.u16(), np = r.u16();
    const kr: J['kr'] = [], kp: J['kp'] = [];
    for (let k = 0; k < nr; k++) kr.push({ t: r.f32(), v: r.v3() });
    for (let k = 0; k < np; k++) kp.push({ t: r.f32(), v: r.v3() });
    joints.push({ name: jname, parent, rot, pos, kr, kp, id: 0 });
  }

  // Optional extended data carrying up to 4 influences per vertex.
  const extra = readExtendedWeights(r, nv, boneOf);

  if (!nj) return finish(m);

  // Convert rest-rotated joints to ThickShake's identity-rest bones.
  const byName = new Map(joints.map((j, i) => [j.name, i]));
  const eulerQ = (e: V3): Q => qFromEuler((e[0] * 180) / Math.PI, (e[1] * 180) / Math.PI, (e[2] * 180) / Math.PI);
  const restWorld: { rot: Q; pos: V3 }[] = [];
  const ensureRest = (i: number): { rot: Q; pos: V3 } => {
    if (restWorld[i]) return restWorld[i];
    const j = joints[i];
    const pi = byName.get(j.parent);
    const local = eulerQ(j.rot);
    if (pi === undefined) restWorld[i] = { rot: local, pos: j.pos };
    else {
      const P = ensureRest(pi);
      const off = qRotate(P.rot, j.pos);
      restWorld[i] = { rot: qNorm(qMul(P.rot, local)), pos: [P.pos[0] + off[0], P.pos[1] + off[1], P.pos[2] + off[2]] };
    }
    return restWorld[i];
  };
  joints.forEach((j, i) => {
    ensureRest(i);
    j.id = newId(m);
  });
  joints.forEach((j, i) => {
    const pi = byName.get(j.parent);
    m.bones.push({ id: j.id, name: j.name || `Joint ${i}`, parent: pi === undefined ? null : joints[pi].id, head: [...restWorld[i].pos] as V3 });
  });

  // MS3D vertices live in joint-local space only at runtime; on disk they're model space.
  m.verts.forEach((v, i) => {
    const e = extra?.[i];
    if (e) {
      const list: [number, number][] = [];
      e.forEach(([ji, w]) => { const jo = joints[ji]; if (jo) list.push([jo.id, w]); });
      if (list.length) v.w = list;
    } else if (boneOf[i] >= 0 && joints[boneOf[i]]) v.w = [[joints[boneOf[i]].id, 1]];
  });

  // Bake keyframes: world' = world * restRot^-1, then express against our identity rest.
  const hasKeys = joints.some((j) => j.kr.length || j.kp.length);
  if (hasKeys) {
    const clip: Clip = { id: newId(m), name: name || 'Take', fps: Math.round(fps), length: Math.max(1, totalFrames), loop: true, tracks: {} };
    const frames = new Set<number>();
    // A key a hair before a whole frame marks a hold up to that frame (see flattenKeys). Rounding it
    // would land it on the next key and turn the hold into a blend, so keep it as a step key instead.
    const holds = new Map<number, Set<number>>();
    joints.forEach((j) => {
      const s = new Set<number>();
      for (const k of [...j.kr, ...j.kp]) {
        const fr = k.t * fps;
        if (Math.abs(fr - Math.round(fr)) > 1e-4 && Math.ceil(fr) - fr < 0.01) s.add(Math.ceil(fr));
        else frames.add(Math.round(fr));
      }
      holds.set(j.id, s);
    });
    const sorted = [...frames].sort((a, b) => a - b);
    const sampleEuler = (ks: J['kr'], t: number): Q => {
      if (!ks.length) return [0, 0, 0, 1];
      if (t <= ks[0].t) return eulerQ(ks[0].v);
      if (t >= ks[ks.length - 1].t) return eulerQ(ks[ks.length - 1].v);
      let i = 1;
      while (ks[i].t < t) i++;
      const a = ks[i - 1], b = ks[i];
      const q = (t - a.t) / (b.t - a.t);
      return nlerp(eulerQ(a.v), eulerQ(b.v), q);
    };
    const sampleV = (ks: J['kp'], t: number): V3 => {
      if (!ks.length) return [0, 0, 0];
      if (t <= ks[0].t) return ks[0].v;
      if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
      let i = 1;
      while (ks[i].t < t) i++;
      const a = ks[i - 1], b = ks[i];
      const q = (t - a.t) / (b.t - a.t);
      return [a.v[0] + (b.v[0] - a.v[0]) * q, a.v[1] + (b.v[1] - a.v[1]) * q, a.v[2] + (b.v[2] - a.v[2]) * q];
    };
    joints.forEach((j) => { clip.tracks[j.id] = { pos: [], rot: [] }; });
    for (const f of sorted) {
      const t = f / fps;
      const world: { rot: Q; pos: V3 }[] = [];
      const ours: { rot: Q; pos: V3 }[] = [];
      const compute = (i: number): void => {
        if (world[i]) return;
        const j = joints[i];
        const pi = byName.get(j.parent);
        if (pi !== undefined) compute(pi);
        const lr = qNorm(qMul(eulerQ(j.rot), sampleEuler(j.kr, t)));
        const kp = sampleV(j.kp, t);
        const lp: V3 = [j.pos[0] + kp[0], j.pos[1] + kp[1], j.pos[2] + kp[2]];
        if (pi === undefined) world[i] = { rot: lr, pos: lp };
        else {
          const P = world[pi];
          const off = qRotate(P.rot, lp);
          world[i] = { rot: qNorm(qMul(P.rot, lr)), pos: [P.pos[0] + off[0], P.pos[1] + off[1], P.pos[2] + off[2]] };
        }
        // Our bone: same world position; rotation with the rest orientation removed.
        ours[i] = { rot: qNorm(qMul(world[i].rot, qConj(restWorld[i].rot))), pos: world[i].pos };
        const parentRot: Q = pi === undefined ? [0, 0, 0, 1] : ours[pi].rot;
        const parentPos: V3 = pi === undefined ? [0, 0, 0] : ours[pi].pos;
        const parentHead: V3 = pi === undefined ? [0, 0, 0] : restWorld[pi].pos;
        const localRot = qNorm(qMul(qConj(parentRot), ours[i].rot));
        const delta = qRotate(qConj(parentRot), [ours[i].pos[0] - parentPos[0], ours[i].pos[1] - parentPos[1], ours[i].pos[2] - parentPos[2]]);
        const head = restWorld[i].pos;
        const tr = clip.tracks[j.id];
        tr.rot.push({ f, v: localRot });
        tr.pos.push({ f, v: [delta[0] - (head[0] - parentHead[0]), delta[1] - (head[1] - parentHead[1]), delta[2] - (head[2] - parentHead[2])] });
      };
      joints.forEach((_, i) => compute(i));
    }
    joints.forEach((j) => {
      const s = holds.get(j.id)!;
      if (!s.size) return;
      const tr = clip.tracks[j.id];
      for (const list of [tr.rot, tr.pos] as { f: number; step?: boolean }[][]) {
        for (let i = 0; i + 1 < list.length; i++) if (s.has(list[i + 1].f)) list[i].step = true;
      }
    });
    m.clips.push(clip);
  }
  return finish(m);
}

function nlerp(a: Q, b: Q, t: number): Q {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  return qNorm([a[0] + (b[0] * s - a[0]) * t, a[1] + (b[1] * s - a[1]) * t, a[2] + (b[2] * s - a[2]) * t, a[3] + (b[3] * s - a[3]) * t]);
}

function finish(m: Model): Model {
  m.groups = m.groups.filter((g) => m.faces.some((f) => f.g === g.id));
  return m;
}

function rgbHex(c: number[]): string {
  const f = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');
  return `#${f(c[0])}${f(c[1])}${f(c[2])}`;
}

/** Comment blocks then per-vertex weights. Returns null for files without them. */
function readExtendedWeights(r: Reader, nv: number, boneOf: number[]): [number, number][][] | null {
  try {
    if (r.remaining < 4) return null;
    const sub = r.i32();
    if (sub !== 1) return null;
    for (let section = 0; section < 3; section++) {
      const n = r.i32();
      for (let i = 0; i < n; i++) { r.i32(); const size = r.i32(); r.o += size; }
    }
    const hasModelComment = r.i32();
    if (hasModelComment) { const size = r.i32(); r.o += size; }
    if (r.remaining < 4) return null;
    const vsub = r.i32();
    if (vsub < 1 || vsub > 3) return null;
    const out: [number, number][][] = [];
    let anyWeighted = false;
    for (let i = 0; i < nv; i++) {
      // Bones 2-4 are stored here; bone 1 is the vertex's own bone id. Three weights are
      // stored as percentages for bones 1-3, and bone 4 takes whatever remains.
      const ids = [boneOf[i], r.i8(), r.i8(), r.i8()];
      const ws = [r.u8(), r.u8(), r.u8()];
      if (vsub >= 2) r.o += 4;
      if (vsub >= 3) r.o += 4;
      const sum = ws[0] + ws[1] + ws[2];
      if (!sum) { out.push(ids[0] >= 0 ? [[ids[0], 1]] : []); continue; }
      anyWeighted = true;
      const pct = [ws[0], ws[1], ws[2], Math.max(0, 100 - sum)];
      out.push(ids.map((b, k) => [b, pct[k] / 100] as [number, number]).filter((x) => x[0] >= 0 && x[1] > 0));
    }
    return anyWeighted ? out : null;
  } catch {
    return null;
  }
}

// ---------- writer ----------

class Writer {
  parts: Uint8Array[] = [];
  private push(n: number, fn: (dv: DataView) => void) { const b = new ArrayBuffer(n); fn(new DataView(b)); this.parts.push(new Uint8Array(b)); }
  u8(v: number) { this.push(1, (d) => d.setUint8(0, v)); }
  i8(v: number) { this.push(1, (d) => d.setInt8(0, v)); }
  u16(v: number) { this.push(2, (d) => d.setUint16(0, v, true)); }
  i32(v: number) { this.push(4, (d) => d.setInt32(0, v, true)); }
  f32(v: number) { this.push(4, (d) => d.setFloat32(0, v, true)); }
  v3(v: number[]) { this.f32(v[0]); this.f32(v[1]); this.f32(v[2]); }
  str(s: string, n: number) {
    const b = new Uint8Array(n);
    // MS3D names are single-byte strings and the reader decodes them as latin1, so write latin1 too.
    const bytes = Array.from(s, (ch) => { const c = ch.codePointAt(0)!; return c < 256 ? c : 63; });
    b.set(bytes.slice(0, n - 1));
    this.parts.push(b);
  }
  done() {
    const size = this.parts.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(size);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

/** Write MS3D v4. Triangulates; limited by the format to 65534 vertices and triangles. */
export function exportMS3D(m: Model, scale = 1): Uint8Array {
  const w = new Writer();
  const groups = m.groups.filter((g) => g.kind === 'mesh');
  const groupIds = new Map(groups.map((g, i) => [g.id, i]));
  const tris: { v: number[]; uv: V2[]; sg: number; group: number }[] = [];
  for (const f of m.faces) {
    const gi = groupIds.get(f.g);
    if (gi === undefined) continue;
    const t = triangulateFace(m, f);
    for (let i = 0; i < t.length; i += 3) {
      tris.push({ v: [f.v[t[i]], f.v[t[i + 1]], f.v[t[i + 2]]], uv: [f.uv[t[i]], f.uv[t[i + 1]], f.uv[t[i + 2]]], sg: f.s > 0 ? ((f.s - 1) % 255) + 1 : 0, group: gi });
    }
  }
  if (m.verts.length > 65534) throw new Error(`MS3D holds at most 65534 vertices; this model has ${m.verts.length}.`);
  if (tris.length > 65534) throw new Error(`MS3D holds at most 65534 triangles; this model has ${tris.length}.`);

  w.str('MS3D000000', 11); w.parts.pop();
  w.parts.push(new TextEncoder().encode('MS3D000000'));
  w.i32(4);

  const bones = bonesTopo(m);
  const boneIndex = new Map(bones.map((b, i) => [b.id, i]));
  w.u16(m.verts.length);
  for (const v of m.verts) {
    w.u8(0);
    w.v3([v.p[0] * scale, v.p[1] * scale, v.p[2] * scale]);
    const primary = v.w?.slice().sort((a, b) => b[1] - a[1])[0];
    w.i8(primary ? boneIndex.get(primary[0]) ?? -1 : -1);
    w.u8(0);
  }

  // Vertex normals per triangle corner by smoothing group.
  // Smoothing group 0 is flat: those corners take their own triangle's normal.
  const normals = new Map<string, V3>();
  const normalKey = (x: number, t: { sg: number }, ti: number) => (t.sg ? `${x}|${t.sg}` : `${x}|f${ti}`);
  for (let ti = 0; ti < tris.length; ti++) {
    const t = tris[ti];
    const a = m.verts[t.v[0]].p, b = m.verts[t.v[1]].p, c = m.verts[t.v[2]].p;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const n: V3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const x of t.v) {
      const k = normalKey(x, t, ti);
      const e = normals.get(k);
      if (e) { e[0] += n[0]; e[1] += n[1]; e[2] += n[2]; } else normals.set(k, [...n] as V3);
    }
  }
  w.u16(tris.length);
  tris.forEach((t, ti) => {
    w.u16(0);
    t.v.forEach((x) => w.u16(x));
    for (const x of t.v) {
      const n = normals.get(normalKey(x, t, ti))!;
      const l = Math.hypot(n[0], n[1], n[2]) || 1;
      w.v3([n[0] / l, n[1] / l, n[2] / l]);
    }
    t.uv.forEach((u) => w.f32(u[0]));
    t.uv.forEach((u) => w.f32(u[1]));
    w.u8(t.sg);
    w.u8(t.group);
  });

  const mats = m.materials;
  const matIndex = new Map(mats.map((x, i) => [x.id, i]));
  w.u16(groups.length);
  groups.forEach((g, gi) => {
    w.u8(0);
    w.str(g.name, 32);
    const ids: number[] = [];
    tris.forEach((t, i) => { if (t.group === gi) ids.push(i); });
    w.u16(ids.length);
    ids.forEach((i) => w.u16(i));
    w.i8(g.material !== null ? matIndex.get(g.material) ?? -1 : -1);
  });

  w.u16(mats.length);
  for (const d of mats) {
    w.str(d.name, 32);
    const col = hexFloat(d.color), em = hexFloat(d.emissive);
    [0.2, 0.2, 0.2, 1].forEach((x) => w.f32(x));
    [...col, d.alpha].forEach((x) => w.f32(x));
    [0.2, 0.2, 0.2, 1].forEach((x) => w.f32(x));
    [...em, 1].forEach((x) => w.f32(x));
    w.f32((1 - d.roughness) * 128);
    w.f32(d.alpha);
    w.i8(0);
    const baseTex = d.maps.base !== undefined ? m.textures.find((t) => t.id === d.maps.base)?.name ?? '' : '';
    w.str(baseTex, 128);
    w.str('', 128);
  }

  const clip = m.clips[0] ?? null;
  const fps = clip?.fps ?? 30;
  w.f32(fps);
  w.f32(0);
  w.i32(clip?.length ?? 1);

  const byId = new Map(m.bones.map((b) => [b.id, b]));
  w.u16(bones.length);
  for (const b of bones) {
    w.u8(0);
    w.str(b.name, 32);
    w.str(b.parent !== null ? byId.get(b.parent)?.name ?? '' : '', 32);
    const parentHead: V3 = b.parent !== null ? byId.get(b.parent)?.head ?? [0, 0, 0] : [0, 0, 0];
    w.v3([0, 0, 0]);
    w.v3([(b.head[0] - parentHead[0]) * scale, (b.head[1] - parentHead[1]) * scale, (b.head[2] - parentHead[2]) * scale]);
    // MS3D keys are linear, so eased and held stretches are written as the motion they produce.
    const curved = clip?.tracks[b.id];
    const tr = curved ? flattenTrack(curved) : undefined;
    const frames = tr ? [...new Set([...tr.rot.map((k) => k.f), ...tr.pos.map((k) => k.f)])].sort((x, y) => x - y) : [];
    w.u16(frames.length);
    w.u16(frames.length);
    for (const f of frames) {
      const e = qToEuler(sampleTrack(tr, f).rot);
      w.f32(f / fps);
      w.v3([(e[0] * Math.PI) / 180, (e[1] * Math.PI) / 180, (e[2] * Math.PI) / 180]);
    }
    for (const f of frames) {
      const p = sampleTrack(tr, f).pos;
      w.f32(f / fps);
      w.v3([p[0] * scale, p[1] * scale, p[2] * scale]);
    }
  }

  // Extended block: no comments, then 4-influence vertex weights.
  w.i32(1);
  w.i32(0); w.i32(0); w.i32(0); w.i32(0);
  w.i32(1);
  for (const v of m.verts) {
    // sorted[0] is already stored as the vertex's own bone; bone 4 gets the remainder on read.
    const sorted = (v.w ?? []).slice().sort((a, b) => b[1] - a[1]);
    for (let k = 1; k < 4; k++) w.i8(sorted[k] ? boneIndex.get(sorted[k][0]) ?? -1 : -1);
    for (let k = 0; k < 3; k++) w.u8(sorted[k] ? Math.round(sorted[k][1] * 100) : 0);
  }
  return w.done();
}

function hexFloat(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
}

export { edgeKey };
