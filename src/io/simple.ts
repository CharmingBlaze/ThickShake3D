// Text and simple binary mesh formats: OBJ/MTL, STL, PLY.
import { faceNormal, triangulateFace } from '../core/geom';
import { autoSmooth } from '../core/ops';
import { emptyModel, makeGroup, makeMaterial, type Face, type Model, type V2, type V3 } from '../core/types';
import { exportGroups, type ExportOptions } from './gltf';

const enc = (s: string) => new TextEncoder().encode(s);

// ---------- OBJ ----------

export function exportOBJ(m: Model, o: ExportOptions, baseName: string): { obj: Uint8Array; mtl: Uint8Array } {
  const lines: string[] = ['# ThickShake OBJ export', `mtllib ${baseName}.mtl`];
  const s = o.scale;
  for (const v of m.verts) lines.push(`v ${v.p[0] * s} ${v.p[1] * s} ${v.p[2] * s}`);
  const fmt = (x: number) => +x.toFixed(6);
  const uvIndex = new Map<string, number>();
  const uvLines: string[] = [];
  const nrmLines: string[] = [];
  const body: string[] = [];
  // Importers take vn as the shading normal, so smoothed faces need normals blended across their
  // smoothing group; flat faces (s = 0) use their own.
  const groups = exportGroups(m, o);
  const exported = new Set(groups.map((g) => g.id));
  const blended = new Map<string, V3>();
  for (const f of m.faces) {
    if (!f.s || !exported.has(f.g)) continue;
    const n = faceNormal(m, f);
    for (const v of f.v) {
      const k = `${v}|${f.s}`;
      const e = blended.get(k);
      if (e) { e[0] += n[0]; e[1] += n[1]; e[2] += n[2]; } else blended.set(k, [n[0], n[1], n[2]]);
    }
  }
  const nrmIndex = new Map<string, number>();
  const normalRef = (n: V3) => {
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    const line = `vn ${fmt(n[0] / l)} ${fmt(n[1] / l)} ${fmt(n[2] / l)}`;
    let k = nrmIndex.get(line);
    if (k === undefined) { k = nrmIndex.size + 1; nrmIndex.set(line, k); nrmLines.push(line); }
    return k;
  };
  for (const g of groups) {
    const faces = m.faces.filter((f) => f.g === g.id);
    if (!faces.length) continue;
    body.push(`g ${safe(g.name)}`);
    const mat = m.materials.find((x) => x.id === g.material);
    if (mat) body.push(`usemtl ${safe(mat.name)}`);
    let curS = -1;
    for (const f of faces) {
      if (f.s !== curS) { body.push(`s ${f.s || 'off'}`); curS = f.s; }
      const flat = f.s ? 0 : normalRef(faceNormal(m, f));
      const corners = f.v.map((v, i) => {
        const nrmCount = f.s ? normalRef(blended.get(`${v}|${f.s}`)!) : flat;
        const u = f.uv[i] ?? [0, 0];
        // OBJ's V axis runs up from the image bottom; ours runs down from the top.
        const uv = `${fmt(u[0])} ${fmt(1 - u[1])}`;
        let k = uvIndex.get(uv);
        if (k === undefined) { k = uvIndex.size + 1; uvIndex.set(uv, k); uvLines.push(`vt ${uv}`); }
        return `${v + 1}/${k}/${nrmCount}`;
      });
      body.push(`f ${corners.join(' ')}`);
    }
  }
  const obj = enc([...lines, ...uvLines, ...nrmLines, ...body, ''].join('\n'));
  const mtl: string[] = ['# ThickShake MTL'];
  for (const d of m.materials) {
    const [r, gr, b] = hexRgb(d.color);
    mtl.push(`newmtl ${safe(d.name)}`, `Kd ${r} ${gr} ${b}`, `d ${d.alpha}`, `Ns ${Math.round((1 - d.roughness) * 900)}`, 'illum 2', '');
  }
  return { obj, mtl: enc(mtl.join('\n')) };
}

const safe = (s: string) => s.replace(/\s+/g, '_');
function hexRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [+((n >> 16 & 255) / 255).toFixed(4), +((n >> 8 & 255) / 255).toFixed(4), +((n & 255) / 255).toFixed(4)];
}

/** OBJ parser that preserves quads and n-gons rather than triangulating on load. */
export function importOBJ(text: string, name: string): Model {
  const m = emptyModel();
  const vt: V2[] = [];
  const mats = new Map<string, number>();
  let group = makeGroup(m, name);
  let curMat: number | null = null;
  let smooth = 0;
  let anySmooth = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    const tag = parts[0];
    if (tag === 'v') m.verts.push({ p: [+parts[1], +parts[2], +parts[3]] });
    else if (tag === 'vt') vt.push([+parts[1], 1 - +(parts[2] ?? 0)]);
    else if (tag === 'g' || tag === 'o') {
      const n = parts.slice(1).join(' ') || 'Group';
      if (m.faces.some((f) => f.g === group.id) || group.name === name) {
        if (m.faces.some((f) => f.g === group.id)) group = makeGroup(m, n, curMat);
        else group.name = n;
      }
    } else if (tag === 'usemtl') {
      const n = parts[1] ?? 'Material';
      if (!mats.has(n)) mats.set(n, makeMaterial(m, n).id);
      curMat = mats.get(n)!;
      if (m.faces.some((f) => f.g === group.id)) group = makeGroup(m, `${group.name}_${n}`, curMat);
      else group.material = curMat;
    } else if (tag === 's') {
      smooth = parts[1] === 'off' || parts[1] === '0' ? 0 : +parts[1] || 1;
      if (smooth) anySmooth = true;
    } else if (tag === 'f') {
      const v: number[] = [], uv: V2[] = [];
      for (const c of parts.slice(1)) {
        const [a, b] = c.split('/');
        let vi = +a; if (vi < 0) vi = m.verts.length + vi; else vi -= 1;
        v.push(vi);
        if (b) { let ti = +b; ti = ti < 0 ? vt.length + ti : ti - 1; uv.push(vt[ti] ? [vt[ti][0], vt[ti][1]] : [0, 0]); }
        else uv.push([0, 0]);
      }
      if (v.length >= 3) m.faces.push({ v, uv, g: group.id, s: smooth });
    }
  }
  m.groups = m.groups.filter((g) => m.faces.some((f) => f.g === g.id));
  if (!anySmooth) autoSmooth(m, new Set(m.faces.keys()), 40);
  return m;
}

// ---------- STL ----------

export function exportSTL(m: Model, o: ExportOptions): Uint8Array {
  const ids = new Set(exportGroups(m, o).filter((g) => g.kind === 'mesh').map((g) => g.id));
  const tris: [V3, V3, V3, V3][] = [];
  for (const f of m.faces) {
    if (!ids.has(f.g)) continue;
    const t = triangulateFace(m, f);
    const n = faceNormal(m, f);
    for (let i = 0; i < t.length; i += 3) tris.push([n, m.verts[f.v[t[i]]].p, m.verts[f.v[t[i + 1]]].p, m.verts[f.v[t[i + 2]]].p]);
  }
  const buf = new ArrayBuffer(84 + tris.length * 50);
  const dv = new DataView(buf);
  new Uint8Array(buf, 0, 80).set(enc('ThickShake binary STL').slice(0, 80));
  dv.setUint32(80, tris.length, true);
  let off = 84;
  for (const [n, a, b, c] of tris) {
    dv.setFloat32(off, n[0], true); dv.setFloat32(off + 4, n[1], true); dv.setFloat32(off + 8, n[2], true);
    off += 12;
    for (const p of [a, b, c]) {
      dv.setFloat32(off, p[0] * o.scale, true); dv.setFloat32(off + 4, p[1] * o.scale, true); dv.setFloat32(off + 8, p[2] * o.scale, true);
      off += 12;
    }
    off += 2;
  }
  return new Uint8Array(buf);
}

// ---------- PLY ----------

export function exportPLY(m: Model, o: ExportOptions): Uint8Array {
  const ids = new Set(exportGroups(m, o).filter((g) => g.kind === 'mesh').map((g) => g.id));
  const faces: Face[] = m.faces.filter((f) => ids.has(f.g));
  const head = [
    'ply', 'format ascii 1.0', 'comment ThickShake export',
    `element vertex ${m.verts.length}`, 'property float x', 'property float y', 'property float z',
    `element face ${faces.length}`, 'property list uchar int vertex_indices', 'end_header',
  ];
  const vs = m.verts.map((v) => `${v.p[0] * o.scale} ${v.p[1] * o.scale} ${v.p[2] * o.scale}`);
  const fs = faces.map((f) => `${f.v.length} ${f.v.join(' ')}`);
  return enc([...head, ...vs, ...fs, ''].join('\n'));
}
