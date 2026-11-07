import { describe, expect, it } from 'vitest';
// @ts-expect-error The Khronos validator ships without type declarations.
import validator from 'gltf-validator';
import { runChecks, BUDGETS, triangleCount } from '../src/core/checks';
import { decimate } from '../src/core/decimate';
import { knifeCut, loopCut, loopCuts, loopPreview, planKnife, type KnifeClick, type KnifeView } from '../src/core/cuts';
import { edgeFaces, edgeKey, faceArea, faceNormal, parseEdge, signedVolume, triangulate } from '../src/core/geom';
import * as ops from '../src/core/ops';
import * as prims from '../src/core/primitives';
import { buildSample } from '../src/core/sample';
import { applyEase, applyPose, bakeClip, capturePose, copyKeys, deleteKeys, EASES, flattenTrack, ikChain, makeLoop, mirrorClip, pasteKeys, reduceKeys, remapKeys, resetPose, retimeClip, reverseClip, solveIK } from '../src/core/anim';
import { deformPoints, lathe, partPrim, PARTS, inflateParts, pathLength, PEN_SECTIONS, penFrame, profileAt, quadSilhouette, resamplePath, ROUND_PROFILE, silhouette, tube } from '../src/core/organic';
import { bezierAt, insertAnchor, nearestOnOutline, sampleOutline, type PenAnchor } from '../src/core/pen';
import { splitOutline } from '../src/core/limbs';
import { blendPixel, brushFootprint, clearRegion, clipRect, copyRegion, flipRegion, floodFill, getPixel, keepInside, linePixels, mapToPalette, pasteRegion, rectPixels, reducePalette, remapPixels, replaceColor, seamTwins, strokeLine, usedColors, uvAtPoint, worldPerTexel, type Brush, type Pixels, type RGBA } from '../src/core/paint';
import { autotileSlot, autotileTemplate, BLOB_MASKS, boxQuads, cellAt, cellCorners, cellsOnPlane, cubeBox, fitTileToFace, placeTileQuad, quadTileCounts, splitQuad, tileAtPixel, tileCounts, tileForCell, tileOfFace, tilePixels, tileUV, type TileBlock, type TileGrid, type TilePlane } from '../src/core/tiles';
import { addLimb, addStarter, deformPiece, fusePieces, limbFrame, radialPieces, reducePiece, twinOf, alignPieces, arrayPieces, colorsToMaterials, dropPieces, mirrorPiece, pieceBounds, scaleFigure, snapPieces } from '../src/core/blockout';
import { bounds, cross, dist, dot, sub } from '../src/core/geom';
import { applyPreset, bakeModelGradient, bakeTextureGradient, blankOrm, evenStops, flipGreen, gradientDirection, guessMapKind, harmonies, hexToHsv, hexToRgb, hsvToHex, MATERIAL_PRESETS, normalFromHeight, packChannel, paletteFromImage, parseHex, parsePaletteText, reverseStops, sampleGradient } from '../src/core/materials';
import { sampleTrack } from '../src/core/skeleton';
import { addHumanoid, autoWeights, evalPose, heatWeights, mirrorJoints, mirrorName, mirrorWeights, paintWeight, pruneWeights, qAxisAngle, qFromEuler, qRotate, qToEuler, removeJoints, skinInto, smoothWeights, splitJoint, weightIssues } from '../src/core/skeleton';
import { cloneModel, emptyModel, makeGroup, makeMaterial, type Gradient, type Clip, type Model, type Q, type V2, type V3 } from '../src/core/types';
import { alignIslands, averageIslandScale, projectScreen, liveUnwrap, minimizeStretch, setPins, clearSeams, fitUV, packIslands, projectBox, relaxUV, seamEdges, seamsFromIslands, setSeams, setTexelDensity, smartUnwrap, stitchIslands, texelDensity, unwrap, uvIslands, uvOverlaps, uvStretch } from '../src/core/uv';
import { exportGLB } from '../src/io/gltf';
import { exportMS3D, importMS3D } from '../src/io/ms3d';
import { parseProject, serializeProject } from '../src/io/project';

describe('pyramid', () => {
  it('is closed, wound outward, and has the exact volume', () => {
    const m = emptyModel();
    ops.addPrim(m, prims.pyramid(2, 3), 'Pyramid');
    expect(m.faces.length).toBe(5);
    for (const faces of edgeFaces(m).values()) expect(faces.length).toBe(2);
    expect(signedVolume(m, m.faces.keys())).toBeCloseTo((2 * 2 * 3) / 3, 6);
  });
});
import { exportOBJ, exportSTL, importOBJ } from '../src/io/simple';
import { defaultExport } from '../src/io/gltf';

function modelOf(p: prims.Prim): Model {
  const m = emptyModel();
  ops.addPrim(m, p, 'Test');
  return m;
}
const all = (m: Model) => new Set(m.faces.keys());
function isClosed(m: Model) {
  for (const l of edgeFaces(m).values()) if (l.length !== 2) return false;
  return true;
}
function isConsistent(m: Model) {
  // Every directed edge should appear exactly once on a closed, oriented mesh.
  const seen = new Set<string>();
  for (const f of m.faces) for (let i = 0; i < f.v.length; i++) {
    const k = `${f.v[i]}>${f.v[(i + 1) % f.v.length]}`;
    if (seen.has(k)) return false;
    seen.add(k);
  }
  return true;
}

describe('primitives', () => {
  const cases: [string, () => prims.Prim, number][] = [
    ['box', () => prims.box(2, 2, 2), 8],
    ['sphere', () => prims.sphere(1, 16, 10), (4 / 3) * Math.PI],
    ['geosphere', () => prims.geosphere(1, 3), (4 / 3) * Math.PI],
    ['cylinder', () => prims.cylinder(1, 1, 2, 32), 2 * Math.PI],
    ['cone', () => prims.cylinder(0, 1, 3, 32), Math.PI],
    ['torus', () => prims.torus(1, 0.3, 32, 16), 2 * Math.PI * Math.PI * 1 * 0.09],
  ];
  for (const [name, make, volume] of cases) {
    it(`${name} is closed, wound outward, and has the right volume`, () => {
      const m = modelOf(make());
      expect(isClosed(m)).toBe(true);
      expect(isConsistent(m)).toBe(true);
      const v = signedVolume(m, m.faces.keys());
      expect(v).toBeGreaterThan(0);
      expect(Math.abs(v - volume) / volume).toBeLessThan(0.08);
    });
  }
  it('box welds shared corners and subdivided boxes stay closed', () => {
    expect(modelOf(prims.box(1, 1, 1)).verts.length).toBe(8);
    const m = modelOf(prims.box(1, 1, 1, 3));
    expect(isClosed(m)).toBe(true);
    expect(m.faces.length).toBe(54);
  });
});

describe('triangulation', () => {
  it('keeps a concave L-shape inside its outline', () => {
    const L: V3[] = [[0, 0, 0], [2, 0, 0], [2, 1, 0], [1, 1, 0], [1, 2, 0], [0, 2, 0]];
    const t = triangulate(L);
    expect(t.length).toBe(12);
    let area = 0;
    for (let i = 0; i < t.length; i += 3) {
      const [a, b, c] = [L[t[i]], L[t[i + 1]], L[t[i + 2]]];
      const s = ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
      expect(s).toBeGreaterThan(0);
      area += s;
    }
    expect(area).toBeCloseTo(3);
  });
});

describe('mesh operations', () => {
  it('extruding a box face keeps it closed and adds side walls', () => {
    const m = modelOf(prims.box(2, 2, 2));
    const before = m.faces.length;
    const { top, normal } = ops.extrudeFaces(m, new Set([0]));
    expect(m.faces.length).toBe(before + 4);
    expect(top.length).toBe(4);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    top.forEach((v) => { m.verts[v].p = [m.verts[v].p[0] + normal[0], m.verts[v].p[1] + normal[1], m.verts[v].p[2] + normal[2]]; });
    expect(signedVolume(m, m.faces.keys())).toBeCloseTo(8 + 4);
  });

  it('extruding a connected region only walls its outer boundary', () => {
    const m = modelOf(prims.box(2, 2, 2, 2)); // 4 quads per side
    const before = m.faces.length;
    ops.extrudeFaces(m, new Set([0, 1, 2, 3]));
    expect(m.faces.length).toBe(before + 8);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
  });

  it('inset keeps area, topology and winding', () => {
    const m = modelOf(prims.box(2, 2, 2));
    ops.insetFaces(m, new Set([0]), 0.25);
    expect(m.faces.length).toBe(6 + 4);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    expect(signedVolume(m, m.faces.keys())).toBeCloseTo(8);
  });

  it('Catmull-Clark rounds a cube and stays closed', () => {
    const m = modelOf(prims.box(2, 2, 2));
    ops.subdivide(m, all(m), true);
    expect(m.faces.length).toBe(24);
    expect(m.verts.length).toBe(26);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    // The textbook rule moves a cube corner at (1,1,1) to (5/9, 5/9, 5/9).
    for (const v of m.verts.slice(0, 8)) for (const x of v.p) expect(Math.abs(x)).toBeCloseTo(5 / 9);
    expect(signedVolume(m, m.faces.keys())).toBeCloseTo(3.5);
  });

  it('linear subdivide preserves volume; partial subdivide leaves no T-junctions', () => {
    const m = modelOf(prims.box(2, 2, 2));
    ops.subdivide(m, all(m), false);
    expect(signedVolume(m, m.faces.keys())).toBeCloseTo(8);
    const p = modelOf(prims.box(2, 2, 2));
    ops.subdivide(p, new Set([0]), false);
    expect(isClosed(p)).toBe(true);
    expect(isConsistent(p)).toBe(true);
  });

  it('weld merges coincident vertices and remaps faces', () => {
    const m = emptyModel();
    const g = makeGroup(m, 'G');
    m.verts.push({ p: [0, 0, 0] }, { p: [1, 0, 0] }, { p: [0, 1, 0] }, { p: [1, 0, 0] }, { p: [1, 1, 0] }, { p: [0, 1, 0] });
    m.faces.push({ v: [0, 1, 2], uv: [[0, 0], [1, 0], [0, 1]], g: g.id, s: 0 });
    m.faces.push({ v: [3, 4, 5], uv: [[1, 0], [1, 1], [0, 1]], g: g.id, s: 0 });
    expect(ops.weld(m, new Set(m.verts.keys()), 1e-4)).toBe(2);
    expect(m.verts.length).toBe(4);
    m.faces.forEach((f) => f.v.forEach((v) => expect(v).toBeLessThan(4)));
    expect(edgeFaces(m).size).toBe(5);
  });

  it('removing faces drops only orphaned vertices', () => {
    const m = modelOf(prims.box(2, 2, 2));
    ops.removeFaces(m, new Set([0]));
    expect(m.verts.length).toBe(8);
    m.faces.forEach((f) => f.v.forEach((v) => expect(v).toBeLessThan(8)));
  });

  it('fillHoles closes a missing face with correct winding', () => {
    const m = modelOf(prims.box(2, 2, 2));
    ops.removeFaces(m, new Set([0]));
    expect(ops.fillHoles(m, null, m.groups[0].id)).toBe(1);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    expect(signedVolume(m, m.faces.keys())).toBeCloseTo(8);
  });

  it('fixNormals repairs scrambled winding and turns an inside-out mesh right way out', () => {
    const m = modelOf(prims.sphere(1, 12, 8));
    ops.flipFaces(m, m.faces.keys());
    ops.flipFaces(m, [0, 3, 7, 20]);
    ops.fixNormals(m, all(m));
    expect(isConsistent(m)).toBe(true);
    expect(signedVolume(m, m.faces.keys())).toBeGreaterThan(0);
  });

  it('mirror with weld makes a symmetric closed-seam result', () => {
    const m = modelOf(prims.box(1, 1, 1));
    m.verts.forEach((v) => { v.p[0] += 0.5; });
    // Remove the face lying on the mirror plane first.
    const seam = new Set<number>();
    m.faces.forEach((f, i) => { if (f.v.every((x) => Math.abs(m.verts[x].p[0]) < 1e-6)) seam.add(i); });
    ops.removeFaces(m, seam);
    ops.mirrorFaces(m, all(m), 0, true);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    expect(signedVolume(m, m.faces.keys())).toBeCloseTo(2);
  });

  it('edge loop walks around a cylinder and loop cut splits the ring', () => {
    const m = modelOf(prims.cylinder(1, 1, 2, 8, 2));
    // Find a horizontal edge in the middle row (both ends y=0).
    const mid = [...edgeFaces(m).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return Math.abs(m.verts[a].p[1]) < 1e-6 && Math.abs(m.verts[b].p[1]) < 1e-6;
    })!;
    expect(ops.edgeLoop(m, mid).length).toBe(8);

    // A vertical edge's ring crosses the whole stack; cutting it adds a full loop.
    const vertical = [...edgeFaces(m).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return Math.abs(m.verts[a].p[0] - m.verts[b].p[0]) < 1e-6 && Math.abs(m.verts[a].p[2] - m.verts[b].p[2]) < 1e-6
        && m.verts[a].p[1] < 0.5 && m.verts[b].p[1] < 0.5;
    })!;
    const quadsBefore = m.faces.length;
    const made = loopCut(m, vertical);
    expect(made.length).toBe(8);
    expect(m.faces.length).toBe(quadsBefore + 8);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
  });

  // An orthographic view from the front: screen x and y are world X and Y, scaled, with no perspective.
  const frontView = (visible?: KnifeView['visible']): KnifeView => ({
    project: ([x, y]) => ({ x: x * 100, y: -y * 100 }),
    ray: (x, y) => ({ o: [x / 100, -y / 100, 10], d: [0, 0, -1] }),
    visible,
  });
  const frontOnly = frontView(([, , z]) => z > 0);
  const click = (id: number, x: number, y: number, z = 0.5): KnifeClick => ({ id, p: [x, y, z] });
  const faceCount = (m: Model) => m.faces.length;
  const area = (m: Model) => m.faces.reduce((s, f) => s + faceArea(m, f), 0);

  it('loop cuts make any number of evenly spaced loops', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const edge = [...edgeFaces(m).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return Math.abs(m.verts[a].p[1] - m.verts[b].p[1]) > 0.5;
    })!;
    const r = loopCuts(m, edge, { cuts: 3 });
    expect(r.verts.length).toBe(12);
    expect(m.faces.length).toBe(6 + 4 * 3);
    expect(r.edges.length).toBe(12);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    const heights = [...new Set(r.verts.map((v) => Math.round(m.verts[v].p[1] * 1000) / 1000))].sort((a, b) => a - b);
    expect(heights).toEqual([-0.25, 0, 0.25]);
    expect(area(m)).toBeCloseTo(6);
  });

  it('a slide stays level all the way round, whichever way edges were built', () => {
    const m = modelOf(prims.cylinder(0.5, 0.5, 2, 12));
    const edge = [...edgeFaces(m).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return Math.abs(m.verts[a].p[1] - m.verts[b].p[1]) > 1.5;
    })!;
    const r = loopCuts(m, edge, { slide: 0.5 });
    expect(r.verts.length).toBe(12);
    const ys = r.verts.map((v) => m.verts[v].p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6);
    expect(Math.abs(ys[0])).toBeCloseTo(0.5);
    expect(isClosed(m)).toBe(true);
  });

  it('even slides keep one distance from a side, on uneven edges too', () => {
    const m = modelOf(prims.box(1, 1, 1));
    // Lean one corner so edges around the ring have different lengths.
    const top = m.verts.findIndex((v) => v.p[1] > 0 && v.p[0] > 0 && v.p[2] > 0);
    m.verts[top].p[1] = 1.5;
    const edge = [...edgeFaces(m).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return !k.split('_').includes(String(top)) && Math.abs(m.verts[a].p[1] - m.verts[b].p[1]) > 0.5;
    })!;
    const [lo, hi] = parseEdge(edge);
    const low = m.verts[lo].p[1] < m.verts[hi].p[1];
    const even = cloneModel(m);
    const r = loopCuts(even, edge, { slide: low ? -0.5 : 0.5, even: true, flip: !low });
    const ys = r.verts.map((v) => even.verts[v].p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6);
    const plain = cloneModel(m);
    const r2 = loopCuts(plain, edge, { slide: low ? -0.5 : 0.5 });
    const ys2 = r2.verts.map((v) => plain.verts[v].p[1]);
    expect(Math.max(...ys2) - Math.min(...ys2)).toBeGreaterThan(0.05);
  });

  it('smoothness rounds a cut on a curved surface, and leaves a flat one flat', () => {
    const sph = modelOf(prims.sphere(1, 12, 4));
    const edge = [...edgeFaces(sph).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return sph.faces.some((f) => f.v.length === 4 && f.v.includes(a) && f.v.includes(b)) && Math.abs(sph.verts[a].p[1] - sph.verts[b].p[1]) > 0.3;
    })!;
    const radius = (m: Model, vs: number[]) => Math.hypot(...m.verts[vs[0]].p);
    const flat = cloneModel(sph), round = cloneModel(sph);
    const r0 = loopCuts(flat, edge), r1 = loopCuts(round, edge, { smooth: 1 });
    expect(radius(round, r1.verts)).toBeGreaterThan(radius(flat, r0.verts));
    const plane = modelOf(prims.plane(2, 2, 2));
    const pe = [...edgeFaces(plane).keys()][0];
    const rp = loopCuts(plane, pe, { smooth: 1 });
    rp.verts.forEach((v) => expect(Math.abs(plane.verts[v].p[1])).toBeLessThan(1e-6));
  });

  it('loop cuts keep UV seams and interpolate UVs', () => {
    const m = modelOf(prims.box(1, 1, 1));
    m.faces.forEach((f) => { f.seam = f.v.map(() => true); });
    const edge = [...edgeFaces(m).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return Math.abs(m.verts[a].p[1] - m.verts[b].p[1]) > 0.5;
    })!;
    const r = loopCuts(m, edge);
    const newEdges = new Set(r.edges);
    let oldSeams = 0;
    for (const f of m.faces) {
      f.v.forEach((v, i) => {
        const k = edgeKey(v, f.v[(i + 1) % f.v.length]);
        if (newEdges.has(k)) expect(f.seam![i]).toBe(false);
        else if (f.seam![i]) oldSeams++;
      });
      expect(f.seam!.length).toBe(f.v.length);
    }
    expect(oldSeams).toBeGreaterThan(20);
  });

  it('a loop preview changes nothing and matches the real cut', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const before = JSON.stringify(m);
    const edge = [...edgeFaces(m).keys()].find((k) => {
      const [a, b] = parseEdge(k);
      return Math.abs(m.verts[a].p[1] - m.verts[b].p[1]) > 0.5;
    })!;
    expect(loopPreview(m, edge, { cuts: 2 }).length).toBe(8);
    expect(JSON.stringify(m)).toBe(before);
  });

  it('the knife splits only the faces it can see, and keeps the mesh sealed', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const before = area(m);
    const r = knifeCut(m, [{ a: click(1, -2, 0), b: click(2, 2, 0), view: frontOnly }]);
    // One visible face splits in two. Its neighbours gain a corner each, with no split.
    expect(faceCount(m)).toBe(7);
    expect(r.verts.length).toBe(2);
    expect(r.edges.length).toBe(1);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    expect(area(m)).toBeCloseTo(before);
    r.verts.forEach((v) => { expect(Math.abs(m.verts[v].p[1])).toBeLessThan(1e-3); expect(m.verts[v].p[2]).toBeCloseTo(0.5); });
  });

  it('cut through goes all the way, ignoring what can be seen', () => {
    const m = modelOf(prims.box(1, 1, 1));
    knifeCut(m, [{ a: click(1, -2, 0), b: click(2, 2, 0), view: frontOnly }], { through: true });
    // Front, back and both sides split. Top and bottom lie edge-on, so the line never enters them.
    expect(faceCount(m)).toBe(10);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
  });

  it('cutting from corner to corner uses the corners', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const verts = m.verts.length;
    const r = knifeCut(m, [{ a: click(1, -0.5, -0.5), b: click(2, 0.5, 0.5), view: frontOnly }]);
    expect(m.verts.length).toBe(verts);
    expect(r.edges.length).toBe(1);
    expect(faceCount(m)).toBe(7);
    expect(isClosed(m)).toBe(true);
  });

  it('a cut that stops inside a face still leaves simple faces', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const before = area(m);
    knifeCut(m, [{ a: click(1, -2, 0), b: click(2, 0, 0), view: frontOnly }]);
    expect(area(m)).toBeCloseTo(before);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    m.faces.forEach((f) => expect(new Set(f.v).size).toBe(f.v.length));
  });

  it('a closed cut inside a face makes an inner face, with no holes', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const before = area(m);
    const c = [click(1, -0.2, -0.2), click(2, 0.2, -0.2), click(3, 0.2, 0.2), click(4, -0.2, 0.2)];
    const segs = c.map((a, i) => ({ a, b: c[(i + 1) % 4], view: frontOnly }));
    const r = knifeCut(m, segs);
    expect(r.verts.length).toBe(4);
    expect(area(m)).toBeCloseTo(before);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    m.faces.forEach((f) => expect(new Set(f.v).size).toBe(f.v.length));
    // The square itself is one of the faces.
    const inner = m.faces.find((f) => f.v.every((v) => r.verts.includes(v)));
    expect(inner).toBeTruthy();
    expect(faceArea(m, inner!)).toBeCloseTo(0.16);
  });

  it('crossing cuts join where they cross, and chains continue through a face', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const before = area(m);
    knifeCut(m, [
      { a: click(1, -2, 0), b: click(2, 2, 0), view: frontOnly },
      { a: click(3, 0, -2), b: click(4, 0, 2), view: frontOnly },
    ]);
    expect(faceCount(m)).toBe(6 + 3);
    expect(area(m)).toBeCloseTo(before);
    expect(isClosed(m)).toBe(true);
    expect(isConsistent(m)).toBe(true);
    const bent = modelOf(prims.box(1, 1, 1));
    knifeCut(bent, [
      { a: click(1, -2, 0), b: click(2, 0, 0.2), view: frontOnly },
      { a: click(2, 0, 0.2), b: click(3, 2, 0), view: frontOnly },
    ]);
    expect(faceCount(bent)).toBe(7);
    expect(isClosed(bent)).toBe(true);
    expect(bent.faces.some((f) => f.v.some((v) => Math.abs(bent.verts[v].p[1] - 0.2) < 1e-6))).toBe(true);
  });

  it('the knife gives new corners matching UVs and skin weights', () => {
    const m = modelOf(prims.box(1, 1, 1));
    m.verts.forEach((v) => { v.w = [[7, 1]]; });
    const front = m.faces.findIndex((f) => f.v.every((v) => m.verts[v].p[2] > 0));
    const f = m.faces[front];
    const uvAt = new Map(f.v.map((v, i) => [JSON.stringify(m.verts[v].p), f.uv[i]]));
    const corner = (x: number, y: number) => uvAt.get(JSON.stringify([x, y, 0.5]))!;
    const r = knifeCut(m, [{ a: click(1, -2, 0), b: click(2, 2, 0), view: frontOnly }]);
    expect(m.verts[r.verts[0]].w).toEqual([[7, 1]]);
    const left = r.verts.find((v) => m.verts[v].p[0] < 0)!;
    const g = m.faces.find((x) => x.v.includes(left) && x.v.includes(r.verts.find((v) => v !== left)!))!;
    const uv = g.uv[g.v.indexOf(left)];
    const want = [(corner(-0.5, -0.5)[0] + corner(-0.5, 0.5)[0]) / 2, (corner(-0.5, -0.5)[1] + corner(-0.5, 0.5)[1]) / 2];
    expect(uv[0]).toBeCloseTo(want[0], 2);
    expect(uv[1]).toBeCloseTo(want[1], 2);
  });

  it('the knife can keep to the faces given, cuts n-gons and concave faces, and changes nothing when planning', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const before = JSON.stringify(m);
    const plan = planKnife(m, [{ a: click(1, -2, 0), b: click(2, 2, 0), view: frontOnly }], { faces: [] });
    expect(plan.chords.size).toBe(0);
    expect(JSON.stringify(m)).toBe(before);
    expect(knifeCut(m, [{ a: click(1, -2, 0), b: click(2, 2, 0), view: frontView() }], { faces: [] }).verts.length).toBe(0);
    // A U shape: a line straight across its arms crosses two separate spans, and only those split.
    const u = emptyModel();
    const g = makeGroup(u, 'U');
    const outline: [number, number][] = [[-1, -1], [1, -1], [1, 1], [0.5, 1], [0.5, -0.5], [-0.5, -0.5], [-0.5, 1], [-1, 1]];
    outline.forEach(([x, y]) => u.verts.push({ p: [x, y, 0] }));
    u.faces.push({ v: outline.map((_, i) => i), uv: outline.map(() => [0, 0]), g: g.id, s: 0 });
    const a0 = area(u);
    knifeCut(u, [{ a: click(1, -2, 0.5, 0), b: click(2, 2, 0.5, 0), view: frontView() }]);
    expect(area(u)).toBeCloseTo(a0);
    expect(u.faces.length).toBe(3);
  });

  it('autoSmooth separates a cube into flat sides and blends a sphere', () => {
    const cube = modelOf(prims.box(1, 1, 1));
    ops.autoSmooth(cube, all(cube), 30);
    expect(new Set(cube.faces.map((f) => f.s)).size).toBe(6);
    const sph = modelOf(prims.sphere(1, 16, 10));
    ops.autoSmooth(sph, all(sph), 40);
    expect(new Set(sph.faces.map((f) => f.s)).size).toBe(1);
  });

  it('quadify restores quads from a triangulated grid', () => {
    const m = modelOf(prims.plane(2, 2, 2));
    ops.triangulateFaces(m, all(m));
    expect(m.faces.every((f) => f.v.length === 3)).toBe(true);
    ops.quadify(m, all(m));
    expect(m.faces.filter((f) => f.v.length === 4).length).toBeGreaterThan(1);
  });
});

describe('mesh operations keep UVs, seams and vertices tidy', () => {
  const corners = (m: Model) => m.faces.flatMap((f) => f.uv);
  const seamKeys = (m: Model) => {
    const s = new Set<string>();
    m.faces.forEach((f) => f.seam?.forEach((on, i) => { if (on) s.add(edgeKey(f.v[i], f.v[(i + 1) % f.v.length])); }));
    return [...s].sort();
  };
  const markSeam = (m: Model, a: number, b: number) => m.faces.forEach((f) => {
    const n = f.v.length;
    f.v.forEach((v, i) => { if ((v === a && f.v[(i + 1) % n] === b) || (v === b && f.v[(i + 1) % n] === a)) { f.seam ??= f.v.map(() => false); f.seam[i] = true; } });
  });

  it('never shares one UV array between corners', () => {
    for (const run of [
      (m: Model) => ops.triangulateFaces(m, all(m)),
      (m: Model) => ops.subdivide(m, all(m), false),
      (m: Model) => ops.insetFaces(m, all(m), 0.2),
      (m: Model) => { ops.triangulateFaces(m, all(m)); ops.quadify(m, all(m)); },
    ]) {
      const m = modelOf(prims.box(1, 1, 1));
      run(m);
      const list = corners(m);
      expect(new Set(list).size).toBe(list.length);
    }
  });

  it('keeps a seam on the same edge through subdivide, triangulate and collapse', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const f0 = m.faces[0];
    const a = f0.v[0], b = f0.v[1];
    markSeam(m, a, b);
    ops.triangulateFaces(m, all(m));
    expect(seamKeys(m)).toEqual([edgeKey(a, b)]);
    m.faces.forEach((f) => { expect(f.seam?.length ?? f.v.length).toBe(f.v.length); });
    // Collapsing a vertex off the seam keeps the seam on its edge.
    const other = m.verts.findIndex((_, i) => i !== a && i !== b && m.faces.some((f) => f.v.includes(i) && f.v.includes(a)));
    const third = m.verts.findIndex((_, i) => i !== a && i !== b && i !== other && m.faces.some((f) => f.v.includes(i) && f.v.includes(other)));
    ops.collapse(m, new Set([other, third]));
    m.faces.forEach((f) => { expect(f.seam?.length ?? f.v.length).toBe(f.v.length); });
  });

  it('extruding a region leaves no loose vertices behind', () => {
    const m = modelOf(prims.plane(2, 2, 2));
    ops.extrudeFaces(m, all(m));
    const used = new Set(m.faces.flatMap((f) => f.v));
    expect(used.size).toBe(m.verts.length);
  });

  it('partial smooth subdivide leaves the unselected faces alone', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const before = m.verts.map((v) => [...v.p]);
    ops.subdivide(m, new Set([0]), true);
    before.forEach((p, i) => p.forEach((x, k) => expect(m.verts[i].p[k]).toBeCloseTo(x, 9)));
  });

  it('mirror with weld only welds the mirrored piece', () => {
    const m = modelOf(prims.box(1, 1, 1));
    m.verts.forEach((v) => { v.p[0] += 0.5; });
    // A separate piece with two coincident, deliberately split vertices on the mirror plane.
    const g = makeGroup(m, 'Other', null).id;
    const n = m.verts.length;
    m.verts.push({ p: [0, 5, 0] }, { p: [0, 5, 0] }, { p: [0, 6, 0] }, { p: [0, 5, 1] });
    m.faces.push({ v: [n, n + 2, n + 3], uv: [[0, 0], [1, 0], [0, 1]], g, s: 0 }, { v: [n + 1, n + 3, n + 2], uv: [[0, 0], [1, 0], [0, 1]], g, s: 0 });
    const boxFaces = new Set(m.faces.map((f, i) => (f.g !== g ? i : -1)).filter((i) => i >= 0));
    ops.mirrorFaces(m, boxFaces, 0, true);
    // Its two split vertices are still two.
    expect(new Set(m.faces.filter((f) => f.g === g).map((f) => f.v[0])).size).toBe(2);
  });
});

describe('pen shapes', () => {
  const circle = (n = 4): PenAnchor[] => {
    // A circle from four smooth points, with the standard bezier handle length.
    const k = 0.5523;
    return [[1, 0], [0, 1], [-1, 0], [0, -1]].slice(0, n).map(([x, y]) => ({ p: [x, y] as V2, i: [y * k, -x * k] as V2, o: [-y * k, x * k] as V2 }));
  };

  it('traces bezier curves and keeps straight sides straight', () => {
    const ring = sampleOutline(circle(), true, 16);
    ring.forEach((p) => expect(Math.hypot(p[0], p[1])).toBeCloseTo(1, 2));
    const square: PenAnchor[] = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([x, y]) => ({ p: [x, y] as V2, i: [0, 0] as V2, o: [0, 0] as V2 }));
    expect(sampleOutline(square, true, 16)).toEqual([[0, 0], [1, 0], [1, 1], [0, 1]]);
  });

  it('adds a point on a curve without changing its shape', () => {
    const before = circle();
    const after = insertAnchor(before, 0, 0.5);
    expect(after.length).toBe(5);
    expect(Math.hypot(...after[1].p)).toBeCloseTo(1, 2);
    for (let t = 0; t <= 1; t += 0.25) {
      // The first half of the old curve is now the whole of the new first curve.
      const a = bezierAt(before[0], before[1], t / 2), b = bezierAt(after[0], after[1], t);
      expect(a[0]).toBeCloseTo(b[0], 9); expect(a[1]).toBeCloseTo(b[1], 9);
    }
    expect(nearestOnOutline(after, [0, 1.2])!.d).toBeCloseTo(0.2, 2);
  });

  it('inflates an outline into a closed, all-quad solid with no poles', () => {
    const outline = sampleOutline(circle(), true, 24);
    for (const [rows, sides] of [[4, 8], [10, 16], [9, 13]]) {
      const m = emptyModel();
      ops.addPrim(m, quadSilhouette(outline, [0, 0, 0], [1, 0, 0], [0, 1, 0], rows, sides, true)!, 'Pen');
      expect(m.faces.every((f) => f.v.length === 4)).toBe(true);
      for (const faces of edgeFaces(m).values()) expect(faces.length).toBe(2);
      // Wound outward, and close to a sphere of radius 1.
      const vol = signedVolume(m, m.faces.keys());
      // Even the coarsest, 4 rings by 8 sides, keeps most of it; flat faces always lose some.
      expect(vol).toBeGreaterThan(0.75 * (4 / 3) * Math.PI);
      expect(vol).toBeLessThan((4 / 3) * Math.PI);
      // No vertex is shared by more than 4 faces: no star of triangles at the ends.
      const valence = new Map<number, number>();
      m.faces.forEach((f) => f.v.forEach((v) => valence.set(v, (valence.get(v) ?? 0) + 1)));
      expect(Math.max(...valence.values())).toBeLessThanOrEqual(4);
    }
  });

  it('blends smoothly through the three ring values without overshooting', () => {
    const v: [number, number, number] = [0.4, 1, 0.6];
    PEN_SECTIONS.forEach((t, k) => expect(profileAt(v, t)).toBeCloseTo(v[k], 9));
    expect(profileAt(v, 0)).toBe(0.4);
    expect(profileAt(v, 1)).toBe(0.6);
    for (let t = 0; t <= 1; t += 0.01) {
      const x = profileAt(v, t);
      expect(x).toBeGreaterThanOrEqual(0.4 - 1e-9);
      expect(x).toBeLessThanOrEqual(1 + 1e-9);
    }
  });

  it('shapes depth and width at the bottom, middle and top rings', () => {
    // A tall oval, so the long direction runs up the drawing plane and the top is +Y.
    const tall = sampleOutline(circle(), true, 24).map(([x, y]): V2 => [x * 0.5, y]);
    const near = (profile: ReturnType<typeof ROUND_PROFILE>, y: number, axis: 0 | 2) => {
      const p = quadSilhouette(tall, [0, 0, 0], [1, 0, 0], [0, 1, 0], 16, 16, true, profile)!;
      return Math.max(...p.verts.filter((v) => Math.abs(v[1] - y) < 0.15).map((v) => Math.abs(v[axis])));
    };
    const round = ROUND_PROFILE();
    // Depth 1 is round: as deep as it is wide.
    expect(near(round, 0, 2)).toBeCloseTo(near(round, 0, 0), 1);
    // A thin top leaves the bottom and middle alone.
    const thinTop: ReturnType<typeof ROUND_PROFILE> = { depth: [1, 1, 0.3], width: [1, 1, 1] };
    expect(near(thinTop, 0.6, 2)).toBeLessThan(near(round, 0.6, 2) * 0.6);
    expect(near(thinTop, -0.6, 2)).toBeCloseTo(near(round, -0.6, 2), 3);
    expect(near(thinTop, 0, 2)).toBeCloseTo(near(round, 0, 2), 3);
    // Width at the middle widens the sides there, without changing the depth.
    const wide: ReturnType<typeof ROUND_PROFILE> = { depth: [1, 1, 1], width: [1, 2, 1] };
    expect(near(wide, 0, 0)).toBeCloseTo(near(round, 0, 0) * 2, 1);
    expect(near(wide, 0, 2)).toBeCloseTo(near(round, 0, 2), 3);
  });

  // An outline as a freehand stroke delivers it: points every few hundredths.
  const dense = (poly: V2[], step = 0.03): V2[] => poly.flatMap((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    return Array.from({ length: n }, (_, k): V2 => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  });
  const hand = dense([[-0.5, -1], [0.5, -1], [0.55, 0], [0.75, 0.1], [1.1, 0.5], [1.0, 0.6], [0.5, 0.3], [0.5, 0.4],
    [0.5, 1.4], [0.32, 1.4], [0.3, 0.45], [0.22, 0.45], [0.2, 1.6], [0.02, 1.6], [0.0, 0.45], [-0.08, 0.45], [-0.1, 1.5], [-0.28, 1.5], [-0.3, 0.45], [-0.38, 0.45], [-0.4, 1.2], [-0.56, 1.2], [-0.55, 0]]);

  it('finds the fingers and thumb of a drawn hand, and keeps the palm as the body', () => {
    const { body, limbs } = splitOutline(hand);
    expect(limbs.length).toBe(5);
    // The palm stops at the finger roots, and each finger reaches its tip.
    expect(Math.max(...body.map((p) => p[1]))).toBeLessThan(0.7);
    const tops = limbs.map((l) => Math.max(...l.map((p) => p[1]))).sort((a, b) => a - b);
    expect(tops.slice(1)).toEqual([1.2, 1.4, 1.5, 1.6].map((y) => expect.closeTo(y, 1)));
    // The thumb points out to the side.
    expect(limbs.some((l) => Math.max(...l.map((p) => p[0])) > 1)).toBe(true);
  });

  it('leaves plain shapes whole: no limbs from corners or ends', () => {
    const circle = Array.from({ length: 80 }, (_, i): V2 => [Math.cos((i / 80) * Math.PI * 2), Math.sin((i / 80) * Math.PI * 2)]);
    for (const o of [circle, dense([[-1, -1], [1, -1], [1, 1], [-1, 1]]), dense([[-0.4, -1.5], [0.4, -1.5], [0.4, 1.5], [-0.4, 1.5]])]) {
      expect(splitOutline(o).limbs.length).toBe(0);
    }
    const ears = dense([[-1, 0], [-0.9, -0.5], [-0.5, -0.9], [0, -1], [0.5, -0.9], [0.9, -0.5], [1, 0], [0.9, 0.5], [0.7, 0.7], [0.75, 1.8], [0.5, 1.8], [0.4, 0.9], [0, 1], [-0.4, 0.9], [-0.5, 1.8], [-0.75, 1.8], [-0.7, 0.7], [-0.9, 0.5]]);
    expect(splitOutline(ears).limbs.length).toBe(2);
  });

  it('inflates a hand into one closed, all-quad piece with every finger', () => {
    const p = inflateParts(hand, [0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 16, true)!;
    const m = emptyModel();
    ops.addPrim(m, p, 'Hand');
    expect(m.faces.every((f) => f.v.length === 4)).toBe(true);
    // Each part is a closed shell: every edge has a face on each side.
    for (const faces of edgeFaces(m).values()) expect(faces.length).toBe(2);
    // Something reaches each fingertip, rather than one tube filling the gaps.
    for (const [x, y] of [[-0.48, 1.15], [-0.19, 1.45], [0.11, 1.55], [0.41, 1.35], [1.0, 0.52]]) {
      expect(m.verts.some((v) => Math.hypot(v.p[0] - x, v.p[1] - y) < 0.12)).toBe(true);
    }
    // And nothing fills the gap between the first two fingers.
    expect(m.verts.some((v) => Math.hypot(v.p[0] - 0.26, v.p[1] - 1.1) < 0.025)).toBe(false);
  });

  it("shapes each limb with its own rings, from root to tip", () => {
    const { limbs, tips } = splitOutline(hand);
    // The middle finger: the one reaching highest.
    const i = limbs.findIndex((l) => Math.max(...l.map((p) => p[1])) > 1.55);
    const widthNear = (profiles: ReturnType<typeof ROUND_PROFILE>[], y: number) => {
      const p = inflateParts(hand, [0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 16, true, ROUND_PROFILE(), profiles)!;
      const xs = p.verts.filter((v) => Math.abs(v[1] - y) < 0.06 && v[0] > -0.02 && v[0] < 0.24).map((v) => v[0]);
      return Math.max(...xs) - Math.min(...xs);
    };
    const plain: ReturnType<typeof ROUND_PROFILE>[] = [];
    const thinTip = limbs.map((_, k) => (k === i ? { depth: [1, 1, 1], width: [1, 1, 0.3] } : ROUND_PROFILE())) as ReturnType<typeof ROUND_PROFILE>[];
    // Near the tip it narrows; near the root it doesn't.
    expect(widthNear(thinTip, 1.35)).toBeLessThan(widthNear(plain, 1.35) * 0.7);
    expect(widthNear(thinTip, 0.75)).toBeCloseTo(widthNear(plain, 0.75), 2);
    // Its tip is where its top ring goes.
    const fr = penFrame(limbs[i], [0, 0, 0], [1, 0, 0], [0, 1, 0], tips[i])!;
    expect(fr.section(fr.uOf(0.8))!.c[1]).toBeGreaterThan(fr.section(fr.uOf(0.2))!.c[1]);
  });

  it('puts the top at the end higher up the drawing plane, however it was drawn', () => {
    const tall = sampleOutline(circle(), true, 24).map(([x, y]): V2 => [x * 0.5, y]);
    const fr = penFrame(tall, [0, 0, 0], [1, 0, 0], [0, 1, 0])!;
    expect(fr.section(fr.uOf(0.8))!.c[1]).toBeGreaterThan(0.4);
    const flipped = penFrame(tall.slice().reverse(), [0, 0, 0], [1, 0, 0], [0, 1, 0])!;
    expect(flipped.section(flipped.uOf(0.8))!.c[1]).toBeGreaterThan(0.4);
  });
});

describe('painting pixels', () => {
  const blank = (w = 8, h = 8): Pixels => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
  const alphaAt = (img: Pixels, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
  const red: RGBA = [255, 0, 0, 255];
  const pencil = (size = 1): Brush => ({ size, shape: 'square', opacity: 1, hardness: 1, erase: false });

  it('draws gapless one-pixel lines', () => {
    const pts = linePixels(0, 0, 7, 3);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([7, 3]);
    pts.slice(1).forEach(([x, y], i) => expect(Math.max(Math.abs(x - pts[i][0]), Math.abs(y - pts[i][1]))).toBe(1));
  });

  it('paints pixel brushes as whole pixels, and erases', () => {
    const img = blank();
    strokeLine(img, 1, 1, 6, 1, red, pencil(1), new Map());
    for (let x = 1; x <= 6; x++) expect(alphaAt(img, x, 1)).toBe(255);
    expect(alphaAt(img, 1, 2)).toBe(0);
    strokeLine(img, 3, 1, 3, 1, red, { ...pencil(1), erase: true }, new Map());
    expect(alphaAt(img, 3, 1)).toBe(0);
    expect(brushFootprint(4, 4, pencil(3)).length).toBe(9);
  });

  it("doesn't build up past its opacity within one stroke", () => {
    const img = blank();
    const b: Brush = { size: 3, shape: 'soft', opacity: 0.5, hardness: 1, erase: false };
    const covered = new Map<number, number>();
    strokeLine(img, 4, 4, 4.2, 4, red, b, covered);
    strokeLine(img, 4.2, 4, 4, 4, red, b, covered);
    expect(alphaAt(img, 4, 4)).toBeGreaterThan(110);
    expect(alphaAt(img, 4, 4)).toBeLessThan(140);
  });

  it('fills the connected area only, inside a closed outline', () => {
    const img = blank();
    for (const [x, y] of rectPixels(1, 1, 5, 5, false)) blendPixel(img, x, y, [0, 0, 255, 255]);
    expect(floodFill(img, 3, 3, red)).toBe(9);
    expect(getPixel(img, 3, 3)).toEqual(red);
    expect(alphaAt(img, 0, 0)).toBe(0);
    expect(floodFill(img, 3, 3, red)).toBe(0);
  });

  it('carries paint across to a new UV layout', () => {
    // A 4×4 texture: left half red, right half blue. One triangle covering it all moves to the bottom-right quarter.
    const src = blank(4, 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) blendPixel(src, x, y, x < 2 ? red : [0, 0, 255, 255]);
    const dst = blank(4, 4);
    remapPixels(src, dst, [
      { from: [[0, 0], [1, 0], [0, 1]], to: [[0.5, 0.5], [1, 0.5], [0.5, 1]] },
      { from: [[1, 0], [1, 1], [0, 1]], to: [[1, 0.5], [1, 1], [0.5, 1]] },
    ]);
    // The new quarter shows the whole texture shrunk: red on its left, blue on its right; the rest stays empty.
    expect(getPixel(dst, 2, 2)).toEqual(red);
    expect(getPixel(dst, 3, 3)).toEqual([0, 0, 255, 255]);
    expect(alphaAt(dst, 0, 0)).toBe(0);
  });

  it('lays faces out as a view sees them, upright', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const front = m.faces.findIndex((f) => faceNormal(m, f)[2] > 0.9);
    projectScreen(m, [front], [1, 0, 0], [0, 1, 0]);
    const f = m.faces[front];
    const topLeft = f.v.findIndex((v) => m.verts[v].p[0] < 0 && m.verts[v].p[1] > 0);
    const bottomRight = f.v.findIndex((v) => m.verts[v].p[0] > 0 && m.verts[v].p[1] < 0);
    // Top left of the face at the top left of the texture (V runs down).
    expect(f.uv[topLeft][0]).toBeLessThan(0.1);
    expect(f.uv[topLeft][1]).toBeLessThan(0.1);
    expect(f.uv[bottomRight][0]).toBeGreaterThan(0.9);
    expect(f.uv[bottomRight][1]).toBeGreaterThan(0.9);
  });

  it('finds the texture coordinate under a point on a face', () => {
    const m = modelOf(prims.plane(2, 2, 1));
    const fi = 0;
    const f = m.faces[fi];
    // Each corner maps to its own UV; the centre maps to the average.
    const centre = [0, 1, 2].map((a) => f.v.reduce((s, v) => s + m.verts[v].p[a], 0) / f.v.length) as V3;
    const uv = uvAtPoint(m, fi, centre)!;
    const avg = [0, 1].map((k) => f.uv.reduce((s, u) => s + u[k], 0) / f.uv.length);
    expect(uv[0]).toBeCloseTo(avg[0], 6);
    expect(uv[1]).toBeCloseTo(avg[1], 6);
    expect(uvAtPoint(m, fi, [50, 0, 50])).toBeNull();
  });

  it('carries a dab across a UV seam to the faces the brush reaches', () => {
    const m = modelOf(prims.box(2, 2, 2));
    // The top face, and a point on it just inside its edge toward +X.
    const top = m.faces.findIndex((f) => f.v.every((v) => m.verts[v].p[1] > 0.99));
    const side = m.faces.findIndex((f) => f.v.every((v) => m.verts[v].p[0] > 0.99));
    const p: V3 = [0.95, 1, 0];
    const all = m.faces.map((_, i) => i);
    const twins = seamTwins(m, top, p, 0.2, all);
    // Only the +X side is within reach; the ball reaches 0.2 âˆ’ 0.05 past the edge down it, so its circle there is smaller.
    expect(twins.map((t) => t.face)).toEqual([side]);
    expect(twins[0].radius).toBeLessThan(0.2);
    expect(twins[0].radius).toBeGreaterThan(0.1);
    // The twin is near the side's own UV square: straight across from p, on the side's plane, is its top edge.
    const onSide = uvAtPoint(m, side, [1, 0.999, 0])!;
    expect(Math.hypot(twins[0].uv[0] - onSide[0], twins[0].uv[1] - onSide[1])).toBeLessThan(0.02);
    // Far from any edge, nothing else is reached; and a texel's size comes from the face's size on the texture.
    expect(seamTwins(m, top, [0, 1, 0], 0.2, all)).toEqual([]);
    expect(worldPerTexel(m, top, 64, 64)).toBeGreaterThan(0);
  });

  it('copies, pastes and flips regions, and keeps painting inside a selection', () => {
    const img = blank(4, 4);
    blendPixel(img, 0, 0, red); blendPixel(img, 1, 0, [0, 0, 255, 255]);
    const r = copyRegion(img, { x: 0, y: 0, w: 2, h: 1 });
    const f = flipRegion(r, 'x');
    expect(getPixel(f, 0, 0)).toEqual([0, 0, 255, 255]);
    pasteRegion(img, f, 2, 3);
    expect(getPixel(img, 2, 3)).toEqual([0, 0, 255, 255]);
    expect(getPixel(img, 3, 3)).toEqual(red);
    clearRegion(img, { x: 0, y: 0, w: 1, h: 1 });
    expect(alphaAt(img, 0, 0)).toBe(0);
    expect(clipRect(img, { x: -2, y: 3, w: 4, h: 4 })).toEqual({ x: 0, y: 3, w: 2, h: 1 });
    // Paint everything, then keep only what landed in the selection.
    const before = img.data.slice();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) blendPixel(img, x, y, red);
    keepInside(img, before, { x: 1, y: 1, w: 2, h: 2 }, { x: 0, y: 0, w: 4, h: 4 });
    expect(getPixel(img, 1, 1)).toEqual(red);
    expect(alphaAt(img, 0, 0)).toBe(0);
    expect(getPixel(img, 2, 3)).toEqual([0, 0, 255, 255]);
  });

  it('lists, swaps and reduces the colours a texture uses', () => {
    const img = blank(4, 1);
    blendPixel(img, 0, 0, red); blendPixel(img, 1, 0, red); blendPixel(img, 2, 0, [250, 10, 0, 255]); blendPixel(img, 3, 0, [0, 0, 200, 128]);
    const used = usedColors(img)!;
    expect(used.length).toBe(3);
    expect(used[0]).toEqual({ c: red, count: 2 });
    expect(usedColors(img, 2)).toBeNull();
    expect(replaceColor(img, [0, 0, 200, 255], [0, 255, 0, 255])).toBe(1);
    // The swapped pixel keeps its own alpha.
    expect(getPixel(img, 3, 0)).toEqual([0, 255, 0, 128]);
    const pal = reducePalette(img, 2);
    expect(pal.length).toBe(2);
    mapToPalette(img, pal);
    // The two near reds merge; green stays apart.
    expect(getPixel(img, 0, 0)).toEqual(getPixel(img, 2, 0));
    expect(getPixel(img, 3, 0)![1]).toBeGreaterThan(200);
    expect(usedColors(img)!.length).toBe(2);
  });
});

describe('tiles', () => {
  const grid: TileGrid = { imageW: 64, imageH: 32, tileW: 16, tileH: 16, marginX: 0, marginY: 0, spacingX: 0, spacingY: 0 };

  it('cuts an atlas into tiles, with margins and spacing', () => {
    expect(tileCounts(grid)).toEqual({ cols: 4, rows: 2 });
    expect(tileUV(grid, 1, 1)).toEqual([0.25, 0.5, 0.5, 1]);
    const spaced: TileGrid = { ...grid, imageW: 70, marginX: 1, marginY: 1, spacingX: 2, spacingY: 2, imageH: 36 };
    expect(tileCounts(spaced)).toEqual({ cols: 3, rows: 2 });
    expect(tilePixels(spaced, 2, 1)).toEqual([37, 19, 16, 16]);
    expect(tileAtPixel(spaced, 37.5, 19.5)).toEqual({ col: 2, row: 1 });
    // The gap between tiles belongs to neither.
    expect(tileAtPixel(spaced, 17.5, 5)).toBeNull();
  });

  it('fits a tile to a wall upright, and turns and mirrors it', () => {
    const m = emptyModel();
    ops.addPrim(m, prims.box(1, 1, 1), 'Box');
    const rect = tileUV(grid, 0, 0);
    // The front face: the corner at top left in the scene gets the tile's top left.
    const front = m.faces.find((f) => faceNormal(m, f)[2] > 0.9)!;
    fitTileToFace(m, front, rect);
    const topLeft = front.v.findIndex((v) => m.verts[v].p[0] < 0 && m.verts[v].p[1] > 0);
    expect(front.uv[topLeft][0]).toBeCloseTo(rect[0], 9);
    expect(front.uv[topLeft][1]).toBeCloseTo(rect[1], 9);
    fitTileToFace(m, front, rect, { rot: 1, flipX: false, flipY: false });
    // A quarter turn clockwise brings the tile's bottom-left corner to the top left.
    expect(front.uv[topLeft][0]).toBeCloseTo(rect[0], 9);
    expect(front.uv[topLeft][1]).toBeCloseTo(rect[3], 9);
    expect(tileOfFace(grid, front)).toEqual({ col: 0, row: 0 });
  });

  it('repeats a block of tiles as a pattern, and picks random tiles that stay put', () => {
    const b: TileBlock = { col: 1, row: 0, w: 2, h: 2 };
    expect(tileForCell(b, { x: 0, y: -1, z: 0 }, false)).toEqual({ col: 1, row: 0 });
    expect(tileForCell(b, { x: 3, y: -1, z: 0 }, false)).toEqual({ col: 2, row: 0 });
    expect(tileForCell(b, { x: 0, y: -2, z: 0 }, false)).toEqual({ col: 1, row: 1 });
    const r1 = tileForCell(b, { x: 5, y: 7, z: 1 }, true), r2 = tileForCell(b, { x: 5, y: 7, z: 1 }, true);
    expect(r1).toEqual(r2);
    const seen = new Set<string>();
    for (let x = 0; x < 40; x++) { const t = tileForCell(b, { x, y: 0, z: 0 }, true); seen.add(`${t.col},${t.row}`); }
    expect(seen.size).toBe(4);
  });

  it('builds tile quads that share corners, face the viewer and replace in place', () => {
    const m = emptyModel();
    const g = makeGroup(m, 'Tiles', null).id;
    const plane: TilePlane = { axis: 2, depth: 0, facing: 1 };
    const rect = tileUV(grid, 0, 0);
    placeTileQuad(m, g, cellCorners(plane, 0, 0, 1), rect);
    placeTileQuad(m, g, cellCorners(plane, 1, 0, 1), rect);
    expect(m.faces.length).toBe(2);
    expect(m.verts.length).toBe(6);
    m.faces.forEach((f) => expect(faceNormal(m, f)[2]).toBeGreaterThan(0.99));
    placeTileQuad(m, g, cellCorners(plane, 1, 0, 1), tileUV(grid, 3, 1));
    expect(m.faces.length).toBe(2);
    expect(tileOfFace(grid, m.faces[1])).toEqual({ col: 3, row: 1 });
    // A floor tile faces up.
    placeTileQuad(m, g, cellCorners({ axis: 1, depth: 0, facing: 1 }, 0, 0, 1), rect);
    expect(faceNormal(m, m.faces[2])[1]).toBeGreaterThan(0.99);
    expect(cellAt(plane, [1.5, 0.2, 0], 1)).toEqual([1, 0]);
  });
  it('picks autotiles by their neighbours, in 16 and 47 tile sets', () => {
    expect(BLOB_MASKS.length).toBe(47);
    const none = () => false, all = () => true;
    expect(autotileSlot('47', none)).toEqual({ col: 0, row: 0 });
    expect(autotileSlot('47', all)).toEqual({ col: 46 % 8, row: 5 });
    // A corner only counts when both sides beside it are filled.
    const cornerOnly = (dx: number, dy: number) => dx === 1 && dy === 1;
    expect(autotileSlot('47', cornerOnly)).toEqual(autotileSlot('47', none));
    // 16: north and east filled is index 1 + 2 = 3.
    expect(autotileSlot('16', (dx, dy) => (dx === 0 && dy === 1) || (dx === 1 && dy === 0))).toEqual({ col: 3, row: 0 });
    expect(autotileSlot('16', all)).toEqual({ col: 3, row: 3 });
    const t = autotileTemplate('47', 8);
    expect([t.width, t.height]).toEqual([64, 48]);
    // The lone tile's corner is background; the full tile's corner is filled.
    expect(t.data[3]).toBe(255);
    const at = (x: number, y: number) => Array.from(t.data.slice((y * t.width + x) * 4, (y * t.width + x) * 4 + 3));
    expect(at(0, 0)).toEqual([34, 36, 44]);
    expect(at(6 * 8, 5 * 8)).not.toEqual([34, 36, 44]);
  });

  it('builds tile cubes with every side facing out', () => {
    const quads = boxQuads([0, 0, 0], [1, 2, 3]);
    expect(quads.length).toBe(6);
    for (const q of quads) {
      const c = [0, 1, 2].map((k) => q.reduce((s, p) => s + p[k], 0) / 4) as V3;
      const n = cross(sub(q[1], q[0]), sub(q[3], q[0]));
      const out = sub(c, [0.5, 1, 1.5]);
      expect(dot(n, out)).toBeGreaterThan(0);
    }
    // A cube on the floor sits on it, one cell up; the next layer sits on that.
    const plane: TilePlane = { axis: 1, depth: 0, facing: 1 };
    expect(cubeBox(plane, 2, -1, 0.5)).toEqual({ min: [1, 0, -0.5], max: [1.5, 0.5, 0] });
    expect(cubeBox(plane, 0, 0, 1, 1).min[1]).toBe(1);
  });

  it('splits a big quad so a tile repeats across it, and finds built tiles by cell', () => {
    const m = modelOf(prims.plane(3, 2, 1));
    const f = m.faces[0];
    expect(quadTileCounts(m, f, 1).slice().sort()).toEqual([2, 3]);
    const [nu, nv] = quadTileCounts(m, f, 1);
    const pieces = splitQuad(m, 0, nu, nv);
    expect(pieces.length).toBe(6);
    expect(m.faces.length).toBe(6);
    // Pieces share corners: a 4Ã—3 grid of points.
    expect(new Set(m.faces.flatMap((x) => x.v)).size).toBe(12);
    const total = m.faces.reduce((s, x) => s + faceArea(m, x), 0);
    expect(total).toBeCloseTo(6, 6);
    // Built tiles on the floor, found by their cells.
    const b = modelOf(prims.plane(1, 1, 1));
    const g = b.faces[0].g;
    const floor: TilePlane = { axis: 1, depth: 0, facing: 1 };
    placeTileQuad(b, g, cellCorners(floor, 3, 4, 1), [0, 0, 1, 1]);
    const cells = cellsOnPlane(b, g, floor, 1);
    expect(cells.get('3,4')).toBe(b.faces.length - 1);
  });
});

describe('decimation', () => {
  it('hits the target and keeps the shape close', () => {
    const m = modelOf(prims.sphere(1, 32, 24));
    const tris = triangleCount(m);
    const res = decimate(m, m.faces.keys(), 0.25);
    expect(res.faces.length).toBeLessThanOrEqual(tris * 0.28);
    expect(res.faces.length).toBeGreaterThan(tris * 0.15);
    const out = emptyModel();
    const g = makeGroup(out, 'L');
    out.verts = res.verts;
    out.faces = res.faces.map((f) => ({ ...f, g: g.id }));
    expect(isClosed(out)).toBe(true);
    const v = signedVolume(out, out.faces.keys());
    expect(v).toBeGreaterThan(((4 / 3) * Math.PI) * 0.85);
    expect(v).toBeLessThan(((4 / 3) * Math.PI) * 1.05);
  });
  it('leaves the source model untouched', () => {
    const m = modelOf(prims.sphere(1, 16, 10));
    const before = JSON.stringify(m);
    decimate(m, m.faces.keys(), 0.5);
    expect(JSON.stringify(m)).toBe(before);
  });
});

describe('uv', () => {
  it('smart unwrap fits the unit square', () => {
    const m = modelOf(prims.torus(1, 0.4, 24, 12));
    const charts = smartUnwrap(m, m.faces.keys());
    expect(charts).toBeGreaterThan(1);
    for (const f of m.faces) for (const u of f.uv) {
      expect(u[0]).toBeGreaterThanOrEqual(-1e-6);
      expect(u[0]).toBeLessThanOrEqual(1 + 1e-6);
      expect(u[1]).toBeGreaterThanOrEqual(-1e-6);
      expect(u[1]).toBeLessThanOrEqual(1 + 1e-6);
    }
  });
  it('box projection gives a cube six non-overlapping tiles', () => {
    const m = modelOf(prims.box(1, 1, 1));
    projectBox(m, m.faces.keys());
    const rects = m.faces.map((f) => ({
      x0: Math.min(...f.uv.map((u) => u[0])), x1: Math.max(...f.uv.map((u) => u[0])),
      y0: Math.min(...f.uv.map((u) => u[1])), y1: Math.max(...f.uv.map((u) => u[1])),
    }));
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      const overlap = a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6;
      expect(overlap).toBe(false);
    }
  });
  it('fit keeps aspect', () => {
    const m = modelOf(prims.plane(2, 2, 1));
    m.faces[0].uv = [[0, 0], [4, 0], [4, 2], [0, 2]];
    fitUV(m, [0], true, 0);
    expect(m.faces[0].uv[2][0]).toBeCloseTo(1);
    expect(m.faces[0].uv[2][1]).toBeCloseTo(0.5);
  });
});

describe('materials', () => {
  const glbJson = (bytes: Uint8Array) => {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const len = view.getUint32(12, true);
    return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + len)));
  };
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

  function textured() {
    const m = modelOf(prims.box(1, 1, 1));
    m.groups[0].material = makeMaterial(m, 'M').id;
    m.textures.push({ id: 500, name: 't', url: png, width: 1, height: 1 });
    m.nextId = 600;
    m.materials[0].maps = { base: 500, normal: 500, orm: 500 };
    return m;
  }

  it('presets replace a look completely, and keep the name and textures', () => {
    const m = textured();
    const mat = m.materials[0];
    applyPreset(mat, MATERIAL_PRESETS.find((p) => p.name === 'Car Paint')!.look);
    expect(mat.clearcoat).toBe(1);
    expect(mat.metallic).toBe(0.6);
    applyPreset(mat, MATERIAL_PRESETS.find((p) => p.name === 'Rubber')!.look);
    expect(mat.clearcoat).toBe(0);
    expect(mat.metallic).toBe(0);
    expect(mat.name).toBe('M');
    expect(mat.maps.base).toBe(500);
    expect(new Set(MATERIAL_PRESETS.map((p) => p.name)).size).toBe(MATERIAL_PRESETS.length);
  });

  it('exports every new property as valid glTF', async () => {
    const m = textured();
    const mat = m.materials[0];
    Object.assign(mat, { normalScale: 0.5, occlusionStrength: 0.7, alphaMode: 'mask', alphaCutoff: 0.3, clearcoat: 0.8, clearcoatRoughness: 0.2, transmission: 0.5, ior: 1.33, sheen: 0.6, sheenColor: '#ff8080', uvScale: [2, 3], uvOffset: [0.1, 0.2], uvRotation: 0.5, emissive: '#ff0000', emissiveStrength: 3 });
    const bytes = exportGLB(m, defaultExport);
    const report = await validator.validateBytes(bytes);
    expect(report.issues.numErrors).toBe(0);
    const j = glbJson(bytes).materials[0];
    expect(j.alphaCutoff).toBe(0.3);
    expect(j.normalTexture.scale).toBe(0.5);
    expect(j.occlusionTexture.strength).toBe(0.7);
    expect(j.extensions.KHR_materials_clearcoat.clearcoatFactor).toBe(0.8);
    expect(j.extensions.KHR_materials_transmission.transmissionFactor).toBe(0.5);
    expect(j.extensions.KHR_materials_ior.ior).toBeCloseTo(1.33);
    expect(j.extensions.KHR_materials_sheen.sheenColorFactor[0]).toBeCloseTo(0.6);
    expect(j.extensions.KHR_materials_emissive_strength.emissiveStrength).toBe(3);
    const tt = j.pbrMetallicRoughness.baseColorTexture.extensions.KHR_texture_transform;
    expect(tt.scale).toEqual([2, 3]);
    expect(tt.offset).toEqual([0.1, 0.2]);
    expect(tt.rotation).toBe(0.5);
    const used = glbJson(bytes).extensionsUsed;
    for (const e of ['KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_texture_transform', 'KHR_materials_emissive_strength']) expect(used).toContain(e);
  });

  it('an unlit material exports as unlit, and a plain one adds no extensions', async () => {
    const m = textured();
    m.materials[0].unlit = true;
    m.materials[0].clearcoat = 1;
    const bytes = exportGLB(m, defaultExport);
    expect((await validator.validateBytes(bytes)).issues.numErrors).toBe(0);
    const j = glbJson(bytes);
    expect(j.materials[0].extensions.KHR_materials_unlit).toEqual({});
    expect(j.materials[0].extensions.KHR_materials_clearcoat).toBeUndefined();
    const plain = glbJson(exportGLB(textured(), defaultExport));
    expect(plain.extensionsUsed).toBeUndefined();
    expect(plain.materials[0].pbrMetallicRoughness.baseColorTexture.extensions).toBeUndefined();
  });

  it('older projects without the new fields still load and export', async () => {
    const m = textured();
    const back = parseProject(serializeProject(m));
    expect(back.materials[0].clearcoat).toBeUndefined();
    expect((await validator.validateBytes(exportGLB(back, defaultExport))).issues.numErrors).toBe(0);
    const c = cloneModel(m);
    c.materials[0].uvScale = [2, 2];
    expect(m.materials[0].uvScale).toBeUndefined();
  });

  it('makes a normal map from brightness, with green pointing up', () => {
    const w = 8, h = 8;
    const flat = new Uint8ClampedArray(w * h * 4).fill(128);
    const n0 = normalFromHeight(flat, w, h);
    expect(Math.abs(n0[0] - 127.5)).toBeLessThan(1);
    expect(Math.abs(n0[1] - 127.5)).toBeLessThan(1);
    expect(n0[2]).toBe(255);
    // Brighter toward the right edge: a surface rising to the right faces left, so red drops below neutral.
    const ramp = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; ramp[i] = ramp[i + 1] = ramp[i + 2] = x * 30; ramp[i + 3] = 255; }
    const r = normalFromHeight(ramp, w, h);
    const mid = (4 * w + 4) * 4;
    expect(r[mid]).toBeLessThan(120);
    expect(Math.abs(r[mid + 1] - 127.5)).toBeLessThan(1);
    // Brighter toward the top of the image: raised at the top, so the slope faces down and green drops.
    const up = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; up[i] = up[i + 1] = up[i + 2] = (7 - y) * 30; up[i + 3] = 255; }
    expect(normalFromHeight(up, w, h)[mid + 1]).toBeLessThan(120);
    expect(flipGreen(r)[mid + 1]).toBe(255 - r[mid + 1]);
    expect(flipGreen(r)[mid]).toBe(r[mid]);
  });

  it('converts colours accurately, and reads typed ones', () => {
    for (const hex of ['#ff0000', '#00ff00', '#0000ff', '#123456', '#ffffff', '#000000', '#7fa8d9']) {
      const [h, s, v] = hexToHsv(hex);
      expect(hsvToHex(h, s, v)).toBe(hex);
    }
    expect(hexToHsv('#ff0000')).toEqual([0, 1, 1]);
    expect(hexToHsv('#00ffff')[0]).toBeCloseTo(180);
    expect(parseHex('FFF')).toBe('#ffffff');
    expect(parseHex(' #a1B2c3 ')).toBe('#a1b2c3');
    expect(parseHex('nope')).toBe(null);
    expect(parseHex('#12')).toBe(null);
    const { shades, matches } = harmonies('#ff0000');
    expect(shades.length).toBe(5);
    expect(matches[0]).toBe('#00ffff');
    expect(harmonies('#808080').matches).toEqual([]);
  });

  it('samples gradients: ends exact, mixed middle, flat bands', () => {
    const g = { stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }], bands: 0 };
    expect(sampleGradient(g, 0)).toBe('#000000');
    expect(sampleGradient(g, 1)).toBe('#ffffff');
    const mid = hexToRgb(sampleGradient(g, 0.5));
    expect(mid[0]).toBeGreaterThan(50);
    expect(mid[0]).toBeLessThan(170);
    // Stops out of order, and positions beyond them, still behave.
    const out = { stops: [{ at: 0.8, color: '#ffffff' }, { at: 0.2, color: '#000000' }], bands: 0 };
    expect(sampleGradient(out, 0)).toBe('#000000');
    expect(sampleGradient(out, 1)).toBe('#ffffff');
    const three = { ...g, bands: 3 };
    expect(sampleGradient(three, 0.05)).toBe('#000000');
    expect(sampleGradient(three, 0.95)).toBe('#ffffff');
    expect(sampleGradient(three, 0.4)).toBe(sampleGradient(three, 0.6));
    expect(sampleGradient(three, 0.5)).not.toBe('#000000');
    expect(reverseStops(g.stops)).toEqual([{ at: 0, color: '#ffffff' }, { at: 1, color: '#000000' }]);
    expect(evenStops([{ at: 0.1, color: '#111111' }, { at: 0.2, color: '#222222' }, { at: 0.9, color: '#333333' }]).map((s) => s.at)).toEqual([0, 0.5, 1]);
  });

  const blackToWhite = (over: Partial<Gradient> = {}): Gradient => ({ kind: 'linear', space: 'model', angle: 0, depth: false, bands: 0, size: 64, stops: [{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }], ...over });

  it('bakes across the texture, in the direction asked for', () => {
    const size = 32;
    const lum = (rgba: Uint8ClampedArray, x: number, y: number) => rgba[(y * size + x) * 4];
    const up = bakeTextureGradient(blackToWhite(), size);
    // V runs down, so white is at the top row when running upward.
    expect(lum(up, 16, 1)).toBeGreaterThan(220);
    expect(lum(up, 16, 30)).toBeLessThan(40);
    const right = bakeTextureGradient(blackToWhite({ angle: 90 }), size);
    expect(lum(right, 30, 16)).toBeGreaterThan(220);
    expect(lum(right, 1, 16)).toBeLessThan(40);
    const radial = bakeTextureGradient(blackToWhite({ kind: 'radial' }), size);
    expect(lum(radial, 16, 16)).toBeLessThan(40);
    expect(lum(radial, 1, 16)).toBeGreaterThan(200);
    const mirror = bakeTextureGradient(blackToWhite({ kind: 'mirror' }), size);
    expect(lum(mirror, 16, 16)).toBeGreaterThan(220);
    expect(lum(mirror, 16, 1)).toBeLessThan(40);
    expect(up[3]).toBe(255);
  });

  /** The colour a baked map shows at each vertex. */
  const atVerts = (m: Model, rgba: Uint8ClampedArray, size: number) => m.faces.flatMap((f) => f.v.map((v, c) => {
    const u = f.uv[c];
    // Sampled just inside the face, away from island borders.
    const cu = f.uv.reduce((s, x) => s + x[0], 0) / f.uv.length, cv = f.uv.reduce((s, x) => s + x[1], 0) / f.uv.length;
    const px = Math.floor((u[0] * 0.9 + cu * 0.1) * size), py = Math.floor((u[1] * 0.9 + cv * 0.1) * size);
    return { p: m.verts[v].p, l: rgba[(Math.max(0, Math.min(size - 1, py)) * size + Math.max(0, Math.min(size - 1, px))) * 4] };
  }));

  it('bakes across the model by position, whatever the UVs do', () => {
    const m = modelOf(prims.box(1, 2, 1));
    const size = 256;
    const up = atVerts(m, bakeModelGradient(m, m.faces.keys(), blackToWhite(), size), size);
    for (const { p, l } of up) {
      if (p[1] > 0.5) expect(l).toBeGreaterThan(190);
      if (p[1] < -0.5) expect(l).toBeLessThan(65);
    }
    const across = atVerts(m, bakeModelGradient(m, m.faces.keys(), blackToWhite({ angle: 90 }), size), size);
    for (const { p, l } of across) {
      if (p[0] > 0.4) expect(l).toBeGreaterThan(190);
      if (p[0] < -0.4) expect(l).toBeLessThan(65);
    }
    const depth = atVerts(m, bakeModelGradient(m, m.faces.keys(), blackToWhite({ depth: true }), size), size);
    for (const { p, l } of depth) {
      if (p[2] > 0.4) expect(l).toBeGreaterThan(190);
      if (p[2] < -0.4) expect(l).toBeLessThan(65);
    }
    expect(gradientDirection(blackToWhite({ angle: 90 }))[0]).toBeCloseTo(1);
  });

  it('a gradient spans only the faces given, and survives a project file', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const size = 64;
    const rgba = bakeModelGradient(m, [], blackToWhite(), size);
    expect(rgba.length).toBe(size * size * 4);
    const mat = makeMaterial(m, 'G');
    mat.gradient = blackToWhite();
    expect(parseProject(serializeProject(m)).materials[0].gradient!.stops.length).toBe(2);
    expect(cloneModel(m).materials[0].gradient).toEqual(mat.gradient);
  });

  it('pulls a palette out of an image, largest colours first', () => {
    const size = 40;
    const px = new Uint8ClampedArray(size * size * 4);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b] = y < 30 ? [255, 0, 0] : x < 30 ? [0, 0, 255] : [0, 255, 0];
      px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
    }
    const p = paletteFromImage(px, 3);
    expect(p.length).toBe(3);
    const near = (a: string, b: string) => hexToRgb(a).every((v, i) => Math.abs(v - hexToRgb(b)[i]) < 40);
    expect(near(p[0], '#ff0000')).toBe(true);
    expect(near(p[1], '#0000ff')).toBe(true);
    expect(near(p[2], '#00ff00')).toBe(true);
    // A one-colour image doesn't invent others, and a see-through one has none.
    expect(paletteFromImage(new Uint8ClampedArray([9, 9, 9, 255, 9, 9, 9, 255]), 8).length).toBe(1);
    expect(paletteFromImage(new Uint8ClampedArray([9, 9, 9, 0]), 8).length).toBe(0);
  });

  it('reads palette files', () => {
    expect(parsePaletteText('GIMP Palette\nName: Test\n# a comment\n255 0 0\tRed\n0 128 255 Blue\n')).toEqual(['#ff0000', '#0080ff']);
    expect(parsePaletteText('ff0000\n00ff00\n')).toEqual(['#ff0000', '#00ff00']);
    expect(parsePaletteText('#112233, #445566 #112233')).toEqual(['#112233', '#445566']);
    expect(parsePaletteText('no colours here')).toEqual([]);
  });

  it('recognises texture sets from their file names', () => {
    const kind = (n: string) => guessMapKind(n).kind;
    expect(kind('rock_diff_2k.jpg')).toBe('base');
    expect(kind('Wood_Albedo.png')).toBe('base');
    expect(kind('photo.png')).toBe('base');
    expect(kind('rock_nor_gl_2k.png')).toBe('normal');
    expect(kind('Wood_Normal.png')).toBe('normal');
    expect(guessMapKind('rock_nor_dx_2k.png')).toEqual({ kind: 'normal', directX: true });
    expect(kind('rock_rough_2k.jpg')).toBe('roughness');
    expect(kind('Wood_Roughness.png')).toBe('roughness');
    expect(kind('metal_plate_metallic.png')).toBe('metallic');
    expect(kind('rock_ao_2k.jpg')).toBe('occlusion');
    expect(kind('lamp_emissive.png')).toBe('emissive');
    expect(kind('crate_ORM.png')).toBe('orm');
  });

  it('packs greyscale maps into the right channels', () => {
    const orm = blankOrm(1, 1, 0.5, 0);
    expect([...orm]).toEqual([255, 128, 0, 255]);
    const g = new Uint8ClampedArray([200, 200, 200, 255]);
    expect([...packChannel(orm, g, 'occlusion')]).toEqual([200, 128, 0, 255]);
    expect([...packChannel(orm, g, 'roughness')]).toEqual([255, 200, 0, 255]);
    expect([...packChannel(orm, g, 'metallic')]).toEqual([255, 128, 200, 255]);
    expect([...orm]).toEqual([255, 128, 0, 255]);
  });
});

describe('blockout', () => {
  const volume = (m: Model) => signedVolume(m, m.faces.keys());
  /** Separate connected surfaces in a mesh. */
  const uvIslandsCount = (m: Model) => {
    const parent = m.verts.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const f of m.faces) for (const v of f.v) parent[find(v)] = find(f.v[0]);
    return new Set(m.verts.map((_, i) => find(i))).size;
  };
  const closed = (m: Model) => { for (const fs of edgeFaces(m).values()) expect(fs.length).toBe(2); };

  it('new shapes are closed solids wound outward', () => {
    const cases: [prims.Prim, number][] = [
      [prims.wedge(), 0.5],
      [prims.stairs(4), (1 + 2 + 3 + 4) / 16],
      [prims.doorway(0.5, 0.75), 1 - 0.5 * 0.75],
    ];
    for (const [p, want] of cases) {
      const m = modelOf(p);
      closed(m);
      expect(volume(m)).toBeCloseTo(want, 5);
    }
    const c = modelOf(prims.capsule(0.5, 3, 16, 8));
    closed(c);
    expect(volume(c)).toBeGreaterThan(1.5);
    const b = bounds(c.verts.map((v) => v.p));
    expect(b.size[1]).toBeCloseTo(3);
  });

  function two() {
    const m = emptyModel();
    const a = ops.addPrim(m, prims.box(2, 1, 2), 'Base', { center: [0, 0.5, 0] }).groupId;
    const b = ops.addPrim(m, prims.box(1, 1, 1), 'Top', { center: [0.25, 5, 0] }).groupId;
    return { m, a, b };
  }

  it('drops a piece onto what is beneath it, or the ground', () => {
    const { m, a, b } = two();
    dropPieces(m, [b]);
    expect(pieceBounds(m, b).min[1]).toBeCloseTo(1);
    const c = ops.addPrim(m, prims.box(1, 1, 1), 'Far', { center: [9, 3, 9] }).groupId;
    dropPieces(m, [c]);
    expect(pieceBounds(m, c).min[1]).toBeCloseTo(0);
    expect(pieceBounds(m, a).min[1]).toBeCloseTo(0);
  });

  it('arrays and aligns whole pieces, each its own group', () => {
    const { m, a, b } = two();
    const made = arrayPieces(m, [b], 3, [2, 0, 0]);
    expect(made.length).toBe(2);
    expect(pieceBounds(m, made[1]).center[0]).toBeCloseTo(4.25);
    expect(m.groups.length).toBe(4);
    closed(m);
    alignPieces(m, [a, b], a, 0, 'center');
    expect(pieceBounds(m, b).center[0]).toBeCloseTo(0);
    snapPieces(m, [made[0]], 1);
    expect(pieceBounds(m, made[0]).min[0] % 1).toBeCloseTo(0);
  });

  it('mirrors a piece across X, right side out, with named sides', () => {
    const m = emptyModel();
    const arm = ops.addPrim(m, prims.capsule(0.1, 1, 8, 5), 'Arm', { center: [1, 1, 0.5] }).groupId;
    const v0 = volume(m);
    const twin = mirrorPiece(m, arm)!;
    expect(volume(m)).toBeCloseTo(v0 * 2, 5);
    closed(m);
    const a = pieceBounds(m, arm), t = pieceBounds(m, twin);
    expect(t.center[0]).toBeCloseTo(-a.center[0]);
    expect(t.center[2]).toBeCloseTo(a.center[2]);
    expect(m.groups.map((g) => g.name).sort()).toEqual(['Arm.L', 'Arm.R']);
    const body = ops.addPrim(m, prims.sphere(1, 8, 5), 'Body', { center: [0, 1, 0] }).groupId;
    expect(mirrorPiece(m, body)).toBe(null);
  });

  it('runs a limb exactly between two points', () => {
    const m = emptyModel();
    const a: V3 = [0.2, 1.4, 0.1], b: V3 = [0.7, 1, -0.2];
    const g = addLimb(m, 'Arm', 'capsule', a, b, 0.05);
    closed(m);
    expect(volume(m)).toBeGreaterThan(0);
    const f = limbFrame(a, b);
    expect(f.length).toBeCloseTo(dist(a, b));
    const along = m.verts.map((v) => (v.p[0] - a[0]) * f.y[0] + (v.p[1] - a[1]) * f.y[1] + (v.p[2] - a[2]) * f.y[2]);
    expect(Math.min(...along)).toBeCloseTo(0, 5);
    expect(Math.max(...along)).toBeCloseTo(f.length, 5);
    expect(m.groups[0].id).toBe(g);
  });

  it.each(['character', 'chibi', 'creature'] as const)('builds a symmetrical %s at the height asked for', (kind) => {
    const m = emptyModel();
    const made = addStarter(m, kind, 2);
    expect(made.length).toBe(m.groups.length);
    expect(made.length).toBeGreaterThan(8);
    closed(m);
    expect(volume(m)).toBeGreaterThan(0);
    const b = bounds(m.verts.map((v) => v.p));
    expect(b.min[1]).toBeGreaterThan(-0.05);
    expect(b.max[1]).toBeCloseTo(2, 1);
    expect(b.min[0]).toBeCloseTo(-b.max[0], 5);
    expect(new Set(m.groups.map((g) => g.name)).size).toBe(m.groups.length);
    expect(m.groups.some((g) => g.name.endsWith('.L'))).toBe(true);
    for (const g of m.groups.filter((x) => x.name.endsWith('.L'))) {
      const twin = m.groups.find((x) => x.name === g.name.replace('.L', '.R'))!;
      expect(pieceBounds(m, twin.id).center[0]).toBeCloseTo(-pieceBounds(m, g.id).center[0], 5);
    }
  });

  it.each(Object.keys(PARTS))('the %s part is a closed solid, one unit long, at any detail', (kind) => {
    for (const [sides, rows, smooth] of [[6, 3, false], [12, 8, true], [24, 16, true]] as const) {
      const p = partPrim(kind, sides, rows, smooth);
      const m = modelOf(p);
      closed(m);
      expect(volume(m)).toBeGreaterThan(0);
      const b = bounds(p.verts);
      expect(b.size[1]).toBeCloseTo(1, 1);
      expect(p.smooth).toBe(smooth);
    }
    expect(partPrim(kind, 6, 3).faces.length).toBeLessThan(partPrim(kind, 24, 16).faces.length);
  });

  it('turns a drawn line into a smooth tube, with low poly using fewer faces', () => {
    const path: V3[] = [];
    for (let i = 0; i <= 30; i++) path.push([i * 0.05, Math.sin(i * 0.25) * 0.4, 0]);
    const hi = tube(path, 0.05, 10, 1)!;
    const lo = tube(path, 0.05, 5, 2.4)!;
    const m = modelOf(hi);
    closed(m);
    expect(volume(m)).toBeGreaterThan(0);
    closed(modelOf(lo));
    expect(lo.faces.length).toBeLessThan(hi.faces.length / 2);
    expect(dist(hi.verts[0], path[0])).toBeLessThan(1e-6);
    const end = hi.verts[hi.verts.length - 1];
    expect(dist(end, path[path.length - 1])).toBeLessThan(1e-6);
    // Its volume is close to a cylinder's of the same length.
    const expected = Math.PI * 0.05 * 0.05 * pathLength(resamplePath(path, 60));
    expect(volume(m)).toBeGreaterThan(expected * 0.7);
    expect(volume(m)).toBeLessThan(expected * 1.1);
    const tapered = modelOf(tube(path, 0.05, 10, 1, 1)!);
    expect(volume(tapered)).toBeLessThan(volume(m) * 0.75);
    expect(tube([[0, 0, 0], [0, 0, 0]], 0.05)).toBe(null);
  });

  it('inflates a drawn outline into a solid that fills its silhouette', () => {
    const outline: V2[] = [];
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; outline.push([Math.cos(a) * 2, Math.sin(a) * 0.5]); }
    const p = silhouette(outline, [0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 12, 0.8)!;
    const m = modelOf(p);
    closed(m);
    expect(volume(m)).toBeGreaterThan(0);
    const b = bounds(p.verts);
    expect(b.size[0]).toBeCloseTo(4, 1);
    expect(b.size[1]).toBeGreaterThan(0.85);
    expect(b.size[1]).toBeLessThan(1.05);
    expect(b.size[2]).toBeCloseTo(b.size[1] * 0.8, 1);
    expect(silhouette([[0, 0], [1, 1]], [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBe(null);
    const tilted = silhouette(outline.map(([x, y]): V2 => [x * 0.7 - y * 0.7, x * 0.7 + y * 0.7]), [0, 0, 0], [1, 0, 0], [0, 1, 0], 10, 12)!;
    closed(modelOf(tilted));
    expect(bounds(tilted.verts).size[0]).toBeGreaterThan(2.5);
  });

  it('spins a drawn profile into a closed solid around the axis', () => {
    const profile: V2[] = [];
    for (let i = 0; i <= 20; i++) profile.push([0.5, 2 - i * 0.1]);
    const p = lathe(profile, 0, [0, 0, 0], [1, 0, 0], [0, 1, 0], 16, 24)!;
    const m = modelOf(p);
    closed(m);
    const v = volume(m);
    expect(v).toBeGreaterThan(Math.PI * 0.25 * 2 * 0.8);
    expect(v).toBeLessThan(Math.PI * 0.25 * 2 * 1.05);
    expect(bounds(p.verts).size[0]).toBeCloseTo(1, 1);
    expect(lathe([[0, 0]], 0, [0, 0, 0], [1, 0, 0], [0, 1, 0])).toBe(null);
  });

  it('tapers, twists and bends a piece along an axis', () => {
    const pts: V3[] = [];
    for (let i = 0; i <= 10; i++) for (const [x, z] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) pts.push([x, i, z]);
    const tip = (out: V3[]) => out.slice(-4);
    const t = deformPoints(pts, 'taper', 1, 0.5);
    expect(Math.max(...tip(t).map((p) => p[0]))).toBeCloseTo(0.25);
    expect(t[1][0]).toBeCloseTo(0.5);
    const tw = deformPoints(pts, 'twist', 1, 90);
    expect(tip(tw)[0][0]).toBeCloseTo(-0.5);
    expect(tip(tw)[0][2]).toBeCloseTo(0.5);
    expect(tw[0][0]).toBeCloseTo(-0.5);
    expect(tw.every((p, i) => Math.abs(p[1] - pts[i][1]) < 1e-9)).toBe(true);
    const b = deformPoints(pts, 'bend', 1, 90);
    expect(b[0][1]).toBeCloseTo(0);
    // A quarter circle of the same length turns the far end sideways.
    const c = tip(b).reduce((s, p) => [s[0] + p[0] / 4, s[1] + p[1] / 4, s[2] + p[2] / 4] as V3, [0, 0, 0] as V3);
    const R = 10 / (Math.PI / 2);
    expect(c[1]).toBeCloseTo(R, 1);
  });

  it('fuses overlapping pieces into one closed mesh with their combined volume', () => {
    const m = emptyModel();
    const a = ops.addPrim(m, prims.box(1, 1, 1), 'A', { center: [0, 0, 0] }).groupId;
    const b = ops.addPrim(m, prims.box(1, 1, 1), 'B', { center: [0.5, 0, 0] }).groupId;
    m.groups.find((g) => g.id === a)!.color = '#112233';
    const g = fusePieces(m, [a, b], 48, 0)!;
    expect(m.groups.map((x) => x.id)).toEqual([g]);
    expect(m.groups[0].color).toBe('#112233');
    closed(m);
    expect(m.verts.every((_, i) => m.faces.some((f) => f.v.includes(i)))).toBe(true);
    // The union is 1.5, not the 2 that the overlap would count twice.
    expect(volume(m)).toBeGreaterThan(1.3);
    expect(volume(m)).toBeLessThan(1.65);
  });

  it('keeps fused gaps apart, and lower detail means fewer faces', () => {
    const build = (cells: number, smooth: number) => {
      const m = emptyModel();
      const a = ops.addPrim(m, prims.sphere(0.5, 16, 10), 'A', { center: [-1, 0, 0] }).groupId;
      const b = ops.addPrim(m, prims.sphere(0.5, 16, 10), 'B', { center: [1, 0, 0] }).groupId;
      fusePieces(m, [a, b], cells, smooth);
      return m;
    };
    const fine = build(64, 1), coarse = build(16, 1);
    closed(fine);
    expect(uvIslandsCount(fine)).toBe(2);
    expect(coarse.faces.length).toBeLessThan(fine.faces.length / 4);
    expect(volume(fine)).toBeCloseTo((2 * 4 * Math.PI * 0.125) / 3, 0);
  });

  it('repeats a piece evenly around an axis', () => {
    const m = emptyModel();
    const p = ops.addPrim(m, prims.box(0.2, 0.2, 0.2), 'Petal', { center: [1, 0.5, 0] }).groupId;
    const made = radialPieces(m, [p], 4, 1, [0, 0.5, 0]);
    expect(made.length).toBe(3);
    closed(m);
    const cs = [p, ...made].map((id) => pieceBounds(m, id).center);
    for (const c of cs) {
      expect(Math.hypot(c[0], c[2])).toBeCloseTo(1, 5);
      expect(c[1]).toBeCloseTo(0.5);
    }
    expect(cs.reduce((s, c) => s + c[0], 0)).toBeCloseTo(0, 5);
    expect(volume(m)).toBeCloseTo(4 * 0.008, 5);
  });

  it('finds a piece\'s twin across X by name and position', () => {
    const m = emptyModel();
    const arm = ops.addPrim(m, prims.box(0.2, 1, 0.2), 'Arm', { center: [1, 1, 0] }).groupId;
    const twin = mirrorPiece(m, arm)!;
    expect(twinOf(m, arm)).toBe(twin);
    expect(twinOf(m, twin)).toBe(arm);
    const lone = ops.addPrim(m, prims.box(1, 1, 1), 'Lone', { center: [0, 5, 0] }).groupId;
    expect(twinOf(m, lone)).toBe(null);
    deformPiece(m, arm, 'taper', 1, 0.5);
    closed(m);
  });

  it('makes a piece lower poly, keeping it closed and in place', () => {
    const m = emptyModel();
    const g = ops.addPrim(m, prims.sphere(1, 24, 16), 'Ball').groupId;
    const before = triangleCount(m);
    const b0 = pieceBounds(m, g);
    reducePiece(m, g, 0.3);
    expect(triangleCount(m)).toBeLessThan(before * 0.5);
    expect(m.faces.every((f) => f.g === g)).toBe(true);
    closed(m);
    expect(pieceBounds(m, g).center[1]).toBeCloseTo(b0.center[1], 0);
    expect(m.verts.every((_, i) => m.faces.some((f) => f.v.includes(i)))).toBe(true);
  });

  it('keeps reference images through undo copies and files, and out of exports', async () => {
    const m = modelOf(prims.box(1, 1, 1));
    const plain = exportGLB(m, defaultExport).length;
    m.refs = [{ id: 99, name: 'front.png', url: 'data:image/png;base64,AAAA', view: 'front', width: 100, height: 200, size: 2, x: 0, y: 1, opacity: 0.8, visible: true, over: false }];
    const copy = cloneModel(m);
    copy.refs![0].x = 5;
    expect(m.refs[0].x).toBe(0);
    expect(parseProject(serializeProject(m)).refs![0].name).toBe('front.png');
    expect(exportGLB(m, defaultExport).length).toBe(plain);
  });

  it('keeps colours through copies and files, and turns them into materials', () => {
    const { m, a, b } = two();
    m.groups.find((g) => g.id === a)!.color = '#112233';
    m.groups.find((g) => g.id === b)!.color = '#112233';
    expect(cloneModel(m).groups[0].color).toBe('#112233');
    expect(parseProject(serializeProject(m)).groups[0].color).toBe('#112233');
    expect(colorsToMaterials(m)).toBe(1);
    expect(m.groups.every((g) => g.material === m.materials[0].id)).toBe(true);
    expect(m.materials[0].color).toBe('#112233');
    expect(colorsToMaterials(m)).toBe(0);
    expect(scaleFigure(1.8).length % 2).toBe(0);
  });
});

describe('animation', () => {
  function chain() {
    const m = emptyModel();
    m.bones.push({ id: 1, name: 'Hip', parent: null, head: [0, 2, 0] }, { id: 2, name: 'Knee', parent: 1, head: [0, 1, 0] }, { id: 3, name: 'Foot', parent: 2, head: [0, 0, 0] });
    m.nextId = 10;
    return m;
  }
  const clipOf = (tracks: Clip['tracks'] = {}, length = 30): Clip => ({ id: 1, name: 'c', fps: 30, length, loop: false, tracks });
  const q90 = qAxisAngle([0, 0, 1], Math.PI / 2);
  const ident: Q = [0, 0, 0, 1];
  const twoKeys = (): Clip => clipOf({ 1: { rot: [{ f: 0, v: ident }, { f: 10, v: q90 }], pos: [{ f: 0, v: [0, 0, 0] }, { f: 10, v: [1, 0, 0] }] } });

  it('applies timing curves between keys', () => {
    const c = twoKeys();
    expect(sampleTrack(c.tracks[1], 5).pos[0]).toBeCloseTo(0.5);
    applyEase(c.tracks[1].pos[0], 'in');
    expect(sampleTrack(c.tracks[1], 2).pos[0]).toBeLessThan(0.2 * 0.6);
    applyEase(c.tracks[1].pos[0], 'out');
    expect(sampleTrack(c.tracks[1], 8).pos[0]).toBeGreaterThan(0.8);
    applyEase(c.tracks[1].pos[0], 'smooth');
    expect(sampleTrack(c.tracks[1], 5).pos[0]).toBeCloseTo(0.5, 2);
    expect(sampleTrack(c.tracks[1], 0).pos[0]).toBe(0);
    expect(sampleTrack(c.tracks[1], 10).pos[0]).toBe(1);
  });

  it('overshoots and holds', () => {
    const c = twoKeys();
    applyEase(c.tracks[1].pos[0], 'overshoot');
    let peak = 0;
    for (let f = 0; f <= 10; f += 0.25) peak = Math.max(peak, sampleTrack(c.tracks[1], f).pos[0]);
    expect(peak).toBeGreaterThan(1.05);
    applyEase(c.tracks[1].pos[0], 'step');
    expect(sampleTrack(c.tracks[1], 9.5).pos[0]).toBe(0);
    expect(sampleTrack(c.tracks[1], 10).pos[0]).toBe(1);
    applyEase(c.tracks[1].pos[0], 'linear');
    expect(c.tracks[1].pos[0].c).toBeUndefined();
    expect(c.tracks[1].pos[0].step).toBeUndefined();
  });

  it('flattens curves for export without changing the motion', () => {
    const c = twoKeys();
    applyEase(c.tracks[1].rot[0], 'overshoot');
    applyEase(c.tracks[1].pos[0], 'step');
    const flat = flattenTrack(c.tracks[1]);
    expect(flat.rot.every((k) => !k.c && !k.step)).toBe(true);
    expect(flat.rot.length).toBe(11);
    for (let f = 0; f <= 10; f++) {
      const a = sampleTrack(c.tracks[1], f), b = sampleTrack(flat, f);
      a.rot.forEach((x, i) => expect(b.rot[i]).toBeCloseTo(x, 4));
      a.pos.forEach((x, i) => expect(b.pos[i]).toBeCloseTo(x, 4));
    }
  });

  it('exports eased motion to a valid GLB and MS3D that play the same', async () => {
    const m = modelOf(prims.cylinder(0.2, 0.2, 2, 8, 4));
    m.verts.forEach((v) => { v.p[1] += 1; });
    m.bones.push({ id: 1000, name: 'A', parent: null, head: [0, 0, 0] }, { id: 1001, name: 'B', parent: 1000, head: [0, 1, 0] });
    m.nextId = 2000;
    heatWeights(m, m.verts.keys());
    const c = clipOf({ 1001: { rot: [{ f: 0, v: ident, c: [...EASES.overshoot] }, { f: 20, v: q90 }], pos: [] } });
    m.clips.push(c);
    const report = await validator.validateBytes(exportGLB(m, defaultExport));
    expect(report.issues.numErrors).toBe(0);
    const bytes = exportMS3D(m);
    const back = importMS3D(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'x');
    const oa = new Float32Array(m.verts.length * 3), ob = new Float32Array(back.verts.length * 3);
    skinInto(m, evalPose(m, c, 7), oa);
    skinInto(back, evalPose(back, back.clips[0], 7), ob);
    const top = (o: Float32Array) => { let hi = -9; for (let i = 1; i < o.length; i += 3) hi = Math.max(hi, o[i]); return hi; };
    expect(top(ob)).toBeCloseTo(top(oa), 2);
  });

  it('moves, stretches, copies and pastes keys', () => {
    const c = twoKeys();
    remapKeys(c, [{ bone: 1, f: 10 }], (f) => f + 5);
    expect(c.tracks[1].rot.map((k) => k.f)).toEqual([0, 15]);
    remapKeys(c, [{ bone: 1, f: 0 }, { bone: 1, f: 15 }], (f) => f * 2);
    expect(c.tracks[1].pos.map((k) => k.f)).toEqual([0, 30]);
    remapKeys(c, [{ bone: 1, f: 30 }], (f) => f - 10, true);
    expect(c.tracks[1].pos.map((k) => k.f)).toEqual([0, 20, 30]);
    remapKeys(c, [{ bone: 1, f: 20 }], () => 0);
    expect(c.tracks[1].pos.map((k) => k.f)).toEqual([0, 30]);
    const data = copyKeys(c, [{ bone: 1, f: 30 }])!;
    pasteKeys(c, data, 12);
    expect(c.tracks[1].rot.map((k) => k.f)).toEqual([0, 12, 30]);
    deleteKeys(c, [{ bone: 1, f: 12 }]);
    expect(c.tracks[1].rot.map((k) => k.f)).toEqual([0, 30]);
  });

  it('reverses, retimes and loops a clip', () => {
    const c = twoKeys();
    c.length = 10;
    applyEase(c.tracks[1].pos[0], 'in');
    const at3 = sampleTrack(c.tracks[1], 3).pos[0];
    reverseClip(c);
    expect(c.tracks[1].pos.map((k) => k.f)).toEqual([0, 10]);
    expect(sampleTrack(c.tracks[1], 7).pos[0]).toBeCloseTo(at3, 3);
    const d = twoKeys();
    d.length = 10;
    retimeClip(d, 2);
    expect(d.length).toBe(20);
    expect(d.tracks[1].rot[1].f).toBe(20);
    const e = twoKeys();
    e.length = 30;
    makeLoop(e);
    expect(e.loop).toBe(true);
    expect(sampleTrack(e.tracks[1], 30).pos).toEqual(sampleTrack(e.tracks[1], 0).pos);
  });

  it('reduces only the keys the motion does not need, and bakes faithfully', () => {
    const c = clipOf({ 1: { rot: [], pos: [0, 1, 2, 3, 4, 5].map((f) => ({ f: f * 2, v: [f, 0, 0] as V3 })).concat([{ f: 12, v: [0, 0, 0] }]) } });
    const removed = reduceKeys(c);
    expect(removed).toBe(4);
    expect(c.tracks[1].pos.map((k) => k.f)).toEqual([0, 10, 12]);
    expect(sampleTrack(c.tracks[1], 5).pos[0]).toBeCloseTo(2.5);
    const b = twoKeys();
    b.length = 10;
    applyEase(b.tracks[1].pos[0], 'smooth');
    const want = sampleTrack(b.tracks[1], 3).pos[0];
    bakeClip(b);
    expect(b.tracks[1].pos.length).toBe(11);
    expect(sampleTrack(b.tracks[1], 3).pos[0]).toBeCloseTo(want);
  });

  it('mirrors poses and clips across X, swapping sides', () => {
    const m = emptyModel();
    m.bones.push({ id: 1, name: 'Root', parent: null, head: [0, 0, 0] }, { id: 2, name: 'Arm.L', parent: 1, head: [1, 0, 0] }, { id: 3, name: 'Arm.R', parent: 1, head: [-1, 0, 0] });
    m.bones.push({ id: 4, name: 'Hand.L', parent: 2, head: [2, 0, 0] }, { id: 5, name: 'Hand.R', parent: 3, head: [-2, 0, 0] });
    const c = clipOf({ 2: { rot: [{ f: 0, v: qAxisAngle([0, 0, 1], 0.5) }], pos: [] } });
    mirrorClip(c, m);
    expect(c.tracks[2]).toBeUndefined();
    const p = evalPose(m, c, 0);
    const handR = p.get(5)!.pos;
    // The left arm rotated up; mirrored, the right arm rises by the same amount.
    expect(handR[1]).toBeCloseTo(Math.sin(0.5));
    expect(handR[0]).toBeCloseTo(-1 - Math.cos(0.5));
    const d = clipOf({ 2: { rot: [{ f: 0, v: qAxisAngle([0, 0, 1], 0.5) }], pos: [] } });
    applyPose(d, 10, capturePose(d, 0, [2]), m, true);
    const q = evalPose(m, d, 10).get(5)!.pos;
    expect(q[1]).toBeCloseTo(Math.sin(0.5));
    resetPose(d, 10, [2, 3]);
    expect(sampleTrack(d.tracks[3], 10).rot).toEqual([0, 0, 0, 1]);
  });

  it('solves IK: the end reaches a target in reach, and bends a straight limb', () => {
    const m = chain();
    const c = clipOf();
    expect(ikChain(m, 3, 2)).toEqual([2, 1]);
    const target: V3 = [0.5, 0.5, 0.2];
    const gap = solveIK(m, c, 5, 3, target, 2);
    expect(gap).toBeLessThan(0.01);
    const p = evalPose(m, c, 5);
    expect(dist(p.get(3)!.pos, target)).toBeLessThan(0.01);
    expect(dist(p.get(1)!.pos, [0, 2, 0])).toBeLessThan(1e-6);
    expect(dist(p.get(2)!.pos, p.get(1)!.pos)).toBeCloseTo(1, 5);
    // Straight up along the limb, which has no bend to start from.
    const c2 = clipOf();
    expect(solveIK(m, c2, 0, 3, [0, 0.8, 0], 2)).toBeLessThan(0.01);
  });

  it('holds the end joint\'s rotation in IK, and reports targets out of reach', () => {
    const m = chain();
    const c = clipOf();
    const keep: Q = [0, 0, 0, 1];
    solveIK(m, c, 0, 3, [0.6, 0.6, 0], 2, keep);
    const r = evalPose(m, c, 0).get(3)!.rot;
    expect(Math.abs(r[3])).toBeCloseTo(1, 5);
    const far = clipOf();
    expect(solveIK(m, far, 0, 3, [9, 2, 0], 2)).toBeGreaterThan(5);
  });
});

describe('UV unwrapping and layout', () => {
  /** Twice the signed area of a face's UVs. With V running down, a face seen from the front is negative. */
  const uvArea2 = (uv: V2[]) => uv.reduce((s, p, i) => { const q = uv[(i + 1) % uv.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0);
  const worst = (m: Model) => Math.max(...uvStretch(m, m.faces.keys()).values());
  const inUnitSquare = (m: Model) => m.faces.every((f) => f.uv.every((u) => u[0] >= -1e-6 && u[0] <= 1 + 1e-6 && u[1] >= -1e-6 && u[1] <= 1 + 1e-6));

  it('every primitive and projection reads correctly with V running down', () => {
    for (const p of [prims.box(1, 1, 1), prims.plane(2, 2, 2), prims.sphere(1, 8, 6), prims.cylinder(1, 1, 2, 8), prims.pyramid(1, 1), prims.torus(1, 0.3, 8, 6)]) {
      const m = modelOf(p);
      const front = m.faces.filter((f) => Math.abs(uvArea2(f.uv)) > 1e-9);
      const negative = front.filter((f) => uvArea2(f.uv) < 0).length;
      expect(negative / front.length).toBeGreaterThan(0.9);
    }
    const m = modelOf(prims.box(1, 1, 1));
    projectBox(m, m.faces.keys());
    m.faces.forEach((f) => expect(uvArea2(f.uv)).toBeLessThan(0));
    smartUnwrap(m, m.faces.keys());
    m.faces.forEach((f) => expect(uvArea2(f.uv)).toBeLessThan(0));
  });

  it('flattens a flat grid without distortion', () => {
    const m = modelOf(prims.plane(3, 1, 6));
    unwrap(m, m.faces.keys());
    expect(worst(m)).toBeLessThan(1.01);
    expect(inUnitSquare(m)).toBe(true);
    expect(uvOverlaps(m, m.faces.keys()).size).toBe(0);
  });

  it('opens a cylinder along one seam into a true rectangle', () => {
    const m = modelOf(prims.cylinder(1, 1, 2, 16, 4, false));
    setSeams(m, [0, 1, 2, 3].map((j) => { const a = j * 16, b = (j + 1) * 16; return a < b ? `${a}_${b}` : `${b}_${a}`; }), true);
    expect(unwrap(m, m.faces.keys())).toBe(1);
    expect(uvIslands(m, m.faces.keys()).length).toBe(1);
    expect(worst(m)).toBeLessThan(1.05);
    expect(uvOverlaps(m, m.faces.keys()).size).toBe(0);
  });

  it('unfolds a cube along seams into one flat cross', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const ef = edgeFaces(m);
    // A spanning tree of faces: every edge not used to join them must be cut.
    const seen = new Set([0]), stack = [0], joined = new Set<string>();
    while (stack.length) {
      const fi = stack.pop()!;
      const f = m.faces[fi];
      f.v.forEach((a, i) => {
        const k = a < f.v[(i + 1) % 4] ? `${a}_${f.v[(i + 1) % 4]}` : `${f.v[(i + 1) % 4]}_${a}`;
        for (const nb of ef.get(k)!) if (!seen.has(nb)) { seen.add(nb); stack.push(nb); joined.add(k); }
      });
    }
    setSeams(m, [...ef.keys()].filter((k) => !joined.has(k)), true);
    expect(unwrap(m, m.faces.keys())).toBe(1);
    expect(uvIslands(m, m.faces.keys()).length).toBe(1);
    expect(worst(m)).toBeLessThan(1.05);
    expect(uvOverlaps(m, m.faces.keys()).size).toBe(0);
    m.faces.forEach((f) => expect(uvArea2(f.uv)).toBeLessThan(0));
  });

  it.each([
    ['box', () => prims.box(1, 1, 1), 6],
    ['sphere', () => prims.sphere(1, 24, 16), 14],
    ['cylinder', () => prims.cylinder(0.5, 0.5, 2, 16, 4), 8],
    ['torus', () => prims.torus(1, 0.35, 24, 12), 14],
    ['pyramid', () => prims.pyramid(1, 1), 5],
    ['capsule', () => prims.capsule(0.5, 3, 16, 9), 14],
  ] as const)('auto unwraps a closed %s with no seams: few islands, low stretch, nothing overlapping', (_n, make, most) => {
    const m = modelOf(make());
    const islands = unwrap(m, m.faces.keys());
    expect(islands).toBeLessThanOrEqual(most);
    expect(uvIslands(m, m.faces.keys()).length).toBeLessThanOrEqual(islands);
    expect(inUnitSquare(m)).toBe(true);
    expect(uvOverlaps(m, m.faces.keys()).size).toBe(0);
    expect(worst(m)).toBeLessThan(2.2);
    expect(seamEdges(m).size).toBe(0);
  });

  it('auto unwrap trades islands for distortion with Max stretch', () => {
    const loose = modelOf(prims.sphere(1, 24, 16)), tight = modelOf(prims.sphere(1, 24, 16));
    const few = unwrap(loose, loose.faces.keys(), 0.01, 2.5);
    const many = unwrap(tight, tight.faces.keys(), 0.01, 1.1);
    expect(few).toBeLessThan(many);
  });

  it('cuts along creases: a cube splits at its edges, never across a face', () => {
    const m = modelOf(prims.box(1, 1, 1, 3));
    unwrap(m, m.faces.keys(), 0.01, 1.05);
    const n = (fi: number) => { const a = m.verts[m.faces[fi].v[0]].p, b = m.verts[m.faces[fi].v[1]].p, c = m.verts[m.faces[fi].v[2]].p; const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]; const x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]; return x.map((q) => Math.sign(Math.round(q * 1000))).join(); };
    // Each cube side stays whole: all nine of its faces share one island.
    const sideIsland = new Map<string, Set<number>>();
    uvIslands(m, m.faces.keys()).forEach((isl, i) => isl.forEach((fi) => { const s = sideIsland.get(n(fi)) ?? new Set(); s.add(i); sideIsland.set(n(fi), s); }));
    expect(sideIsland.size).toBe(6);
    for (const s of sideIsland.values()) expect(s.size).toBe(1);
  });

  it('holds pinned points through an unwrap, and live unwrap moves the rest', () => {
    const m = modelOf(prims.plane(2, 2, 2));
    unwrap(m, m.faces.keys());
    const corner = (x: number, z: number) => { const out: [number, number][] = []; m.faces.forEach((f, fi) => f.v.forEach((v, c) => { const p = m.verts[v].p; if (Math.abs(p[0] - x) < 1e-6 && Math.abs(p[2] - z) < 1e-6) out.push([fi, c]); })); return out; };
    const pinsA = corner(-1, -1), pinsB = corner(1, 1);
    setPins(m, [...pinsA, ...pinsB], true);
    for (const [f, c] of pinsA) m.faces[f].uv[c] = [0.1, 0.1];
    for (const [f, c] of pinsB) m.faces[f].uv[c] = [0.9, 0.9];
    expect(liveUnwrap(m, m.faces.keys())).toBeGreaterThanOrEqual(0);
    unwrap(m, m.faces.keys());
    for (const [f, c] of pinsA) { expect(m.faces[f].uv[c][0]).toBeCloseTo(0.1); expect(m.faces[f].uv[c][1]).toBeCloseTo(0.1); }
    for (const [f, c] of pinsB) { expect(m.faces[f].uv[c][0]).toBeCloseTo(0.9); expect(m.faces[f].uv[c][1]).toBeCloseTo(0.9); }
    expect(uvOverlaps(m, m.faces.keys()).size).toBe(0);
    m.faces.forEach((f) => { if (Math.abs(uvArea2(f.uv)) > 1e-9) expect(uvArea2(f.uv)).toBeLessThan(0); });
    expect(cloneModel(m).faces.some((f) => f.pin?.some(Boolean))).toBe(true);
    setPins(m, [...pinsA, ...pinsB], false);
    expect(m.faces.some((f) => f.pin)).toBe(false);
  });

  it('minimize stretch evens out a distorted layout and leaves pins alone', () => {
    const m = modelOf(prims.plane(2, 2, 4));
    unwrap(m, m.faces.keys());
    const pts = new Map<string, V2>();
    m.faces.forEach((f) => f.v.forEach((v, c) => { const k = `${v}`; const u = f.uv[c]; const skewed: V2 = pts.get(k) ?? [u[0] + u[1] * 0.3, u[1] * u[1]]; pts.set(k, skewed); f.uv[c] = [skewed[0], skewed[1]]; }));
    const before = worst(m);
    expect(before).toBeGreaterThan(1.3);
    minimizeStretch(m, m.faces.keys(), 60);
    expect(worst(m)).toBeLessThan(before);
    expect(worst(m)).toBeLessThan(1.15);
    const held = modelOf(prims.plane(2, 2, 2));
    unwrap(held, held.faces.keys());
    setPins(held, [[0, 0]], true);
    const u0 = [...held.faces[0].uv[0]];
    minimizeStretch(held, held.faces.keys(), 5);
    expect(held.faces[0].uv[0]).toEqual(u0);
  });

  it('averages island scale and straightens islands in place', () => {
    const m = modelOf(prims.box(1, 1, 1));
    projectBox(m, m.faces.keys());
    const f0 = m.faces[0];
    const c0: V2 = [f0.uv.reduce((s, u) => s + u[0], 0) / 4, f0.uv.reduce((s, u) => s + u[1], 0) / 4];
    f0.uv = f0.uv.map((u) => [c0[0] + (u[0] - c0[0]) * 0.3, c0[1] + (u[1] - c0[1]) * 0.3]);
    averageIslandScale(m, m.faces.keys());
    const areas = m.faces.map((f) => Math.abs(uvArea2(f.uv)));
    expect(Math.max(...areas) / Math.min(...areas)).toBeLessThan(1.01);
    const a = Math.PI / 5;
    m.faces[1].uv = m.faces[1].uv.map((u) => [0.5 + (u[0] - 0.5) * Math.cos(a) - (u[1] - 0.5) * Math.sin(a), 0.5 + (u[0] - 0.5) * Math.sin(a) + (u[1] - 0.5) * Math.cos(a)]);
    alignIslands(m, [1]);
    const xs = m.faces[1].uv.map((u) => u[0]);
    expect(new Set(xs.map((x) => x.toFixed(2))).size).toBe(2);
  });

  it('keeps seams through undo copies and project files, and finds them from islands', () => {
    const m = modelOf(prims.box(1, 1, 1));
    expect(seamEdges(m).size).toBe(0);
    projectBox(m, m.faces.keys());
    seamsFromIslands(m, m.faces.keys());
    expect(seamEdges(m).size).toBe(12);
    expect(seamEdges(cloneModel(m)).size).toBe(12);
    expect(seamEdges(parseProject(serializeProject(m))).size).toBe(12);
    setSeams(m, [...seamEdges(m)].slice(0, 2), false);
    expect(seamEdges(m).size).toBe(10);
    clearSeams(m);
    expect(seamEdges(m).size).toBe(0);
  });

  it('packs islands without overlap, at one density, and can set a density', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const big = modelOf(prims.box(4, 0.5, 1));
    const base = m.verts.length;
    big.verts.forEach((v) => m.verts.push(v));
    big.faces.forEach((f) => m.faces.push({ ...f, v: f.v.map((i) => i + base) }));
    projectBox(m, m.faces.keys());
    m.faces.forEach((f) => { const k = Math.random() + 0.2; const u0 = f.uv[0][0], v0 = f.uv[0][1]; f.uv.forEach((u) => { u[0] = u0 + (u[0] - u0) * k; u[1] = v0 + (u[1] - v0) * k; }); });
    expect(packIslands(m, m.faces.keys())).toBe(12);
    expect(inUnitSquare(m)).toBe(true);
    expect(uvOverlaps(m, m.faces.keys()).size).toBe(0);
    expect(worst(m)).toBeLessThan(1.05);
    setTexelDensity(m, m.faces.keys(), 512, 1024);
    expect(texelDensity(m, m.faces.keys(), 1024)).toBeCloseTo(512, 3);
  });

  it('detects real overlap but not faces that merely touch', () => {
    const m = modelOf(prims.plane(2, 1, 2));
    m.faces[0].uv = [[0, 1], [1, 1], [1, 0], [0, 0]];
    m.faces[1].uv = [[1, 1], [2, 1], [2, 0], [1, 0]];
    expect(uvOverlaps(m, [0, 1]).size).toBe(0);
    m.faces[1].uv = [[0.5, 1], [1.5, 1], [1.5, 0], [0.5, 0]];
    expect(uvOverlaps(m, [0, 1]).size).toBe(2);
  });

  it('stitches a neighbouring island onto the selected one', () => {
    const m = modelOf(prims.box(1, 1, 1));
    projectBox(m, m.faces.keys());
    expect(uvIslands(m, m.faces.keys()).length).toBe(6);
    expect(stitchIslands(m, m.faces.keys(), new Set([0]))).toBe(true);
    expect(uvIslands(m, m.faces.keys()).length).toBe(5);
    expect(stitchIslands(m, m.faces.keys(), new Set())).toBe(false);
  });

  it('relaxes inner points and leaves borders alone', () => {
    const m = modelOf(prims.plane(2, 2, 2));
    const centre = m.faces[0].v.indexOf(4);
    const corners: [number, number][] = [];
    m.faces.forEach((f, fi) => f.v.forEach((v, c) => { if (v === 4) { f.uv[c] = [0.9, 0.9]; corners.push([fi, c]); } }));
    const edge = [...m.faces[0].uv[(centre + 1) % 4]];
    relaxUV(m, m.faces.keys(), corners, 5);
    expect(m.faces[0].uv[centre][0]).toBeCloseTo(0.5, 3);
    expect(m.faces[0].uv[centre][1]).toBeCloseTo(0.5, 3);
    expect(m.faces[0].uv[(centre + 1) % 4]).toEqual(edge);
  });
});

describe('skeleton', () => {
  function arm() {
    const m = modelOf(prims.cylinder(0.2, 0.2, 2, 8, 4));
    m.verts.forEach((v) => { v.p[1] += 1; });
    m.bones.push({ id: 1000, name: 'A', parent: null, head: [0, 0, 0] }, { id: 1001, name: 'B', parent: 1000, head: [0, 1, 0] }, { id: 1002, name: 'C', parent: 1001, head: [0, 2, 0] });
    m.nextId = 2000;
    return m;
  }

  it('euler round trip', () => {
    const e = qToEuler(qFromEuler(20, 35, -50));
    expect(e[0]).toBeCloseTo(20); expect(e[1]).toBeCloseTo(35); expect(e[2]).toBeCloseTo(-50);
  });

  it('forward kinematics accumulates parent rotation', () => {
    const m = arm();
    const clip = { id: 1, name: 'c', fps: 30, length: 10, loop: true, tracks: { 1000: { pos: [], rot: [{ f: 0, v: qAxisAngle([0, 0, 1], Math.PI / 2) }] } } };
    const pose = evalPose(m, clip, 0);
    const b = pose.get(1001)!.pos;
    expect(b[0]).toBeCloseTo(-1); expect(b[1]).toBeCloseTo(0);
    const c = pose.get(1002)!.pos;
    expect(c[0]).toBeCloseTo(-2); expect(c[1]).toBeCloseTo(0);
  });

  it('rest pose skinning leaves vertices unchanged', () => {
    const m = arm();
    autoWeights(m, m.verts.keys());
    const out = new Float32Array(m.verts.length * 3);
    skinInto(m, evalPose(m, null, 0), out);
    m.verts.forEach((v, i) => {
      expect(out[i * 3]).toBeCloseTo(v.p[0]);
      expect(out[i * 3 + 1]).toBeCloseTo(v.p[1]);
      expect(out[i * 3 + 2]).toBeCloseTo(v.p[2]);
    });
  });

  it('auto-weights normalise, cap at 4, and follow the nearest bone', () => {
    const m = arm();
    autoWeights(m, m.verts.keys());
    for (const v of m.verts) {
      expect(v.w!.length).toBeLessThanOrEqual(4);
      expect(v.w!.reduce((s, x) => s + x[1], 0)).toBeCloseTo(1);
    }
    const low = m.verts.find((v) => v.p[1] < 0.01)!;
    expect(low.w![0][0]).toBe(1000);
  });

  it('painting normalises with other influences', () => {
    const m = arm();
    m.verts[0].w = [[1000, 0.5], [1001, 0.5]];
    paintWeight(m, 0, 1000, 1, 0.5);
    const total = m.verts[0].w!.reduce((s, x) => s + x[1], 0);
    expect(total).toBeCloseTo(1);
    expect(m.verts[0].w!.find((x) => x[0] === 1000)![1]).toBeCloseTo(0.75);
  });

  /** Two separate parallel legs, close together, each with its own joints under one hip. */
  function legs(gap: number) {
    const m = emptyModel();
    for (const x of [-gap / 2, gap / 2]) {
      const p = prims.cylinder(0.05, 0.05, 1, 8, 8);
      p.verts.forEach((v) => { v[0] += x; v[1] += 0.5; });
      ops.addPrim(m, p, 'Leg');
    }
    m.nextId = 1000;
    m.bones.push({ id: 1, name: 'Hip', parent: null, head: [0, 1.2, 0] });
    for (const [i, x] of [[2, -gap / 2], [4, gap / 2]] as const) {
      m.bones.push({ id: i, name: `Up${i}`, parent: 1, head: [x, 1, 0] });
      m.bones.push({ id: i + 1, name: `Low${i}`, parent: i, head: [x, 0, 0] });
    }
    return m;
  }
  const shareOf = (m: Model, side: number, bones: number[]) => {
    let worst = 0;
    m.verts.forEach((v) => {
      if (Math.sign(v.p[0]) !== side) return;
      const s = (v.w ?? []).filter((x) => bones.includes(x[0])).reduce((a, x) => a + x[1], 0);
      worst = Math.max(worst, s);
    });
    return worst;
  };

  it('heat weights normalise, cap, and follow the nearest bone', () => {
    const m = arm();
    heatWeights(m, m.verts.keys());
    for (const v of m.verts) {
      expect(v.w!.length).toBeLessThanOrEqual(4);
      expect(v.w!.reduce((s, x) => s + x[1], 0)).toBeCloseTo(1);
    }
    const low = m.verts.find((v) => v.p[1] < 0.01)!;
    expect(low.w![0][0]).toBe(1000);
    const out = new Float32Array(m.verts.length * 3);
    skinInto(m, evalPose(m, null, 0), out);
    expect(out[1]).toBeCloseTo(m.verts[0].p[1]);
  });

  it('heat weights keep a leg out of the other leg, where distance weights bleed', () => {
    const near = legs(0.14);
    autoWeights(near, near.verts.keys());
    const bleedDistance = shareOf(near, -1, [4, 5]);
    const hot = legs(0.14);
    heatWeights(hot, hot.verts.keys());
    const bleedHeat = shareOf(hot, -1, [4, 5]);
    expect(bleedHeat).toBeLessThan(bleedDistance);
    expect(bleedHeat).toBeLessThan(0.1);
    expect(shareOf(hot, 1, [2, 3])).toBeLessThan(0.1);
  });

  it('heat weights blend smoothly across a joint, without a hard jump', () => {
    const m = arm();
    heatWeights(m, m.verts.keys());
    const mid = m.verts.filter((v) => Math.abs(v.p[1] - 1) < 0.01);
    expect(mid.length).toBeGreaterThan(0);
    for (const v of mid) expect(v.w!.length).toBeGreaterThan(1);
  });

  it('smooths weight boundaries and keeps the total at one', () => {
    const m = arm();
    m.verts.forEach((v) => { v.w = [[v.p[1] < 1 ? 1000 : 1001, 1]]; });
    smoothWeights(m, m.verts.keys(), 2);
    for (const v of m.verts) expect(v.w!.reduce((s, x) => s + x[1], 0)).toBeCloseTo(1);
    expect(m.verts.some((v) => v.w!.length > 1)).toBe(true);
  });

  it('cleans up tiny influences and caps the count', () => {
    const m = arm();
    m.verts[0].w = [[1000, 0.6], [1001, 0.385], [1002, 0.015]];
    pruneWeights(m, [0], 0.02, 4);
    expect(m.verts[0].w!.length).toBe(2);
    expect(m.verts[0].w!.reduce((s, x) => s + x[1], 0)).toBeCloseTo(1);
    m.verts[1].w = [[1000, 0.5], [1001, 0.3], [1002, 0.2]];
    pruneWeights(m, [1], 0, 1);
    expect(m.verts[1].w).toEqual([[1000, 1]]);
  });

  it('deleting a joint passes its weights and children to its parent', () => {
    const m = arm();
    m.verts[0].w = [[1001, 0.5], [1002, 0.5]];
    removeJoints(m, [1001]);
    expect(m.bones.find((b) => b.id === 1002)!.parent).toBe(1000);
    const w = new Map(m.verts[0].w!);
    expect(w.get(1000)).toBeCloseTo(0.5);
    expect(w.get(1002)).toBeCloseTo(0.5);
    removeJoints(m, [1000]);
    expect(m.bones.find((b) => b.id === 1002)!.parent).toBe(null);
    expect(m.verts[0].w).toEqual([[1002, 1]]);
  });

  it('inserts a joint midway to its child', () => {
    const m = arm();
    const id = splitJoint(m, 1000)!;
    expect(m.bones.find((b) => b.id === id)!.head).toEqual([0, 0.5, 0]);
    expect(m.bones.find((b) => b.id === 1001)!.parent).toBe(id);
    expect(splitJoint(m, 1002)).toBe(null);
  });

  it('names opposite sides', () => {
    expect(mirrorName('Arm.L')).toBe('Arm.R');
    expect(mirrorName('R_Leg')).toBe('L_Leg');
    expect(mirrorName('LeftHand')).toBe('RightHand');
    expect(mirrorName('hand_r')).toBe('hand_l');
    expect(mirrorName('Spine')).toBe(null);
    expect(mirrorName('Leg')).toBe(null);
  });

  it('mirrors joints with their hierarchy, once, and then their weights', () => {
    const m = modelOf(prims.plane(2, 2, 2));
    m.bones.push({ id: 1, name: 'Root', parent: null, head: [0, 0, 0] }, { id: 2, name: 'Arm', parent: 1, head: [1, 0, 0] }, { id: 3, name: 'Hand', parent: 2, head: [2, 0, 0] });
    m.nextId = 100;
    expect(mirrorJoints(m)).toBe(2);
    expect(m.bones.length).toBe(5);
    const armR = m.bones.find((b) => b.name === 'Arm.R')!;
    const handR = m.bones.find((b) => b.name === 'Hand.R')!;
    expect(m.bones.find((b) => b.id === 2)!.name).toBe('Arm.L');
    expect(armR.parent).toBe(1);
    expect(armR.head).toEqual([-1, 0, 0]);
    expect(handR.parent).toBe(armR.id);
    expect(mirrorJoints(m)).toBe(0);
    const right = m.verts.findIndex((v) => v.p[0] > 0.5 && v.p[2] > 0.5);
    const left = m.verts.findIndex((v) => v.p[0] < -0.5 && v.p[2] > 0.5);
    m.verts[right].w = [[2, 0.75], [1, 0.25]];
    expect(mirrorWeights(m, 1)).toBeGreaterThan(0);
    const w = new Map(m.verts[left].w!);
    expect(w.get(armR.id)).toBeCloseTo(0.75);
    expect(w.get(1)).toBeCloseTo(0.25);
  });

  it('fits a humanoid skeleton to the mesh and weights it', () => {
    const m = modelOf(prims.box(1, 2, 0.5));
    m.verts.forEach((v) => { v.p[1] += 1; });
    addHumanoid(m);
    expect(m.bones.length).toBe(24);
    expect(new Set(m.bones.map((b) => b.name)).size).toBe(24);
    const hip = m.bones.find((b) => b.name === 'Hips')!;
    expect(hip.parent).toBe(null);
    expect(m.bones.find((b) => b.name === 'HeadTop')!.head[1]).toBeCloseTo(2);
    const l = m.bones.find((b) => b.name === 'Hand.L')!, r = m.bones.find((b) => b.name === 'Hand.R')!;
    expect(r.head[0]).toBeCloseTo(-l.head[0]);
    expect(l.head[0]).toBeGreaterThan(0);
    expect(weightIssues(m).unweighted.length).toBe(8);
    heatWeights(m, m.verts.keys());
    expect(weightIssues(m).unweighted.length).toBe(0);
  });

  it('rotates a vector correctly', () => {
    const r = qRotate(qAxisAngle([0, 1, 0], Math.PI / 2), [1, 0, 0]);
    expect(r[0]).toBeCloseTo(0); expect(r[2]).toBeCloseTo(-1);
  });
});

describe('audit', () => {
  it('a clean closed box raises no errors', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const bad = runChecks(m, BUDGETS[2]).filter((c) => c.severity === 'error');
    expect(bad).toEqual([]);
  });
  it('finds degenerate, loose and non-manifold geometry', () => {
    const m = modelOf(prims.box(1, 1, 1));
    m.verts.push({ p: [5, 5, 5] });
    const g = m.groups[0].id;
    m.faces.push({ v: [0, 0, 1], uv: [[0, 0], [1, 0], [1, 1]], g, s: 0 });
    const a = m.faces[0].v[0], b = m.faces[0].v[1];
    m.verts.push({ p: [9, 9, 9] });
    m.faces.push({ v: [a, b, m.verts.length - 1], uv: [[0, 0], [1, 0], [1, 1]], g, s: 0 });
    const by = Object.fromEntries(runChecks(m, BUDGETS[2]).map((c) => [c.id, c]));
    expect(by.degenerate.faces?.length).toBe(1);
    expect(by.loose.verts?.length).toBe(1);
    expect(by.nonmanifold.edges?.length).toBeGreaterThan(0);
  });
  it('flags triangle budgets', () => {
    const m = modelOf(prims.sphere(1, 64, 64));
    const r = runChecks(m, BUDGETS[0]).find((c) => c.id === 'tris')!;
    expect(r.severity).toBe('error');
  });
});

describe('file formats', () => {
  it('project round trip is lossless', () => {
    const m = buildSample();
    const r = parseProject(serializeProject(m));
    expect(JSON.stringify(r)).toBe(JSON.stringify(m));
  });
  it('rejects non-project files with a useful error', () => {
    expect(() => parseProject('nope')).toThrow(/corrupted/);
    expect(() => parseProject('{"a":1}')).toThrow(/not a ThickShake/);
  });
  it('OBJ round trip preserves polygons, positions, UVs and groups', () => {
    const m = modelOf(prims.box(2, 2, 2));
    const { obj } = exportOBJ(m, defaultExport, 't');
    const r = importOBJ(new TextDecoder().decode(obj), 't');
    expect(r.verts.length).toBe(m.verts.length);
    expect(r.faces.length).toBe(m.faces.length);
    expect(r.faces.every((f) => f.v.length === 4)).toBe(true);
    expect(r.groups.length).toBe(1);
    r.faces.forEach((f, i) => f.uv.forEach((u, c) => {
      expect(u[0]).toBeCloseTo(m.faces[i].uv[c][0], 4);
      expect(u[1]).toBeCloseTo(m.faces[i].uv[c][1], 4);
    }));
    expect(signedVolume(r, r.faces.keys())).toBeCloseTo(8);
  });
  it('OBJ handles negative indices and missing UVs', () => {
    const r = importOBJ('v 0 0 0\nv 1 0 0\nv 0 1 0\nf -3 -2 -1\n', 'x');
    expect(r.faces[0].v).toEqual([0, 1, 2]);
  });
  it('STL binary has the right size and count', () => {
    const m = modelOf(prims.box(1, 1, 1));
    const b = exportSTL(m, defaultExport);
    expect(b.length).toBe(84 + 12 * 50);
    expect(new DataView(b.buffer).getUint32(80, true)).toBe(12);
  });

  it('GLB has a valid container, accessors and skin', () => {
    const m = buildSample();
    const glb = exportGLB(m, defaultExport);
    const dv = new DataView(glb.buffer, glb.byteOffset);
    expect(dv.getUint32(0, true)).toBe(0x46546c67);
    expect(dv.getUint32(8, true)).toBe(glb.length);
    expect(glb.length % 4).toBe(0);
    const jsonLen = dv.getUint32(12, true);
    expect(jsonLen % 4).toBe(0);
    const json = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonLen)));
    const binLen = dv.getUint32(20 + jsonLen, true);
    expect(binLen).toBeGreaterThanOrEqual(json.buffers[0].byteLength);
    expect(json.skins[0].joints.length).toBe(m.bones.length);
    expect(json.animations[0].name).toBe('Wobble');
    expect(json.meshes.length).toBe(m.groups.length);
    for (const v of json.bufferViews) expect(v.byteOffset % 4).toBe(0);
    for (const v of json.bufferViews) expect(v.byteOffset + v.byteLength).toBeLessThanOrEqual(json.buffers[0].byteLength);
    // Every skin weight row sums to 1, as the spec requires.
    const prim = json.meshes[0].primitives[0];
    const acc = json.accessors[prim.attributes.WEIGHTS_0];
    const view = json.bufferViews[acc.bufferView];
    const bin = glb.slice(20 + jsonLen + 8);
    const w = new Float32Array(bin.buffer, bin.byteOffset + view.byteOffset, acc.count * 4);
    for (let i = 0; i < acc.count; i++) expect(w[i * 4] + w[i * 4 + 1] + w[i * 4 + 2] + w[i * 4 + 3]).toBeCloseTo(1, 5);
    expect(acc.count).toBe(json.accessors[prim.attributes.POSITION].count);
    // Index values are all in range.
    const ia = json.accessors[prim.indices];
    const iv = json.bufferViews[ia.bufferView];
    const idx = new Uint32Array(bin.buffer, bin.byteOffset + iv.byteOffset, ia.count);
    idx.forEach((x) => expect(x).toBeLessThan(acc.count));
  });

  it('MS3D round trip keeps mesh, groups, joints, weights and animation', () => {
    const m = buildSample();
    ops.triangulateFaces(m, all(m));
    const bytes = exportMS3D(m);
    const r = importMS3D(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'T');
    expect(r.verts.length).toBe(m.verts.length);
    expect(r.faces.length).toBe(m.faces.length);
    expect(r.groups.map((g) => g.name)).toEqual(m.groups.map((g) => g.name));
    expect(r.materials.length).toBe(m.materials.length);
    expect(r.bones.map((b) => b.name).sort()).toEqual(m.bones.map((b) => b.name).sort());
    r.bones.forEach((b) => {
      const o = m.bones.find((x) => x.name === b.name)!;
      b.head.forEach((x, i) => expect(x).toBeCloseTo(o.head[i], 4));
    });
    // Multi-bone weights survive, including the implied 4th influence.
    const orig = m.verts.findIndex((v) => (v.w?.length ?? 0) >= 2);
    expect(r.verts[orig].w!.length).toBeGreaterThanOrEqual(2);
    expect(r.verts[orig].w!.reduce((s, x) => s + x[1], 0)).toBeCloseTo(1, 1);
    expect(r.clips.length).toBe(1);

    // The animated pose matches the source at a mid-clip frame.
    const oa = new Float32Array(m.verts.length * 3), ob = new Float32Array(m.verts.length * 3);
    skinInto(m, evalPose(m, m.clips[0], 15), oa);
    skinInto(r, evalPose(r, r.clips[0], 15), ob);
    let worst = 0;
    oa.forEach((x, i) => { worst = Math.max(worst, Math.abs(x - ob[i])); });
    expect(worst).toBeLessThan(0.03);
  });

  it('MS3D keeps accented names, high smoothing groups and hold keys', () => {
    const m = emptyModel();
    ops.addPrim(m, prims.box(1, 1, 1), 'Körper');
    m.faces.forEach((f) => { f.s = 255; });
    m.bones.push({ id: 900, name: 'Hüfte', parent: null, head: [0, 0, 0] });
    m.verts.forEach((v) => { v.w = [[900, 1]]; });
    m.clips.push({ id: 901, name: 'c', fps: 30, length: 20, loop: false, tracks: { 900: { pos: [], rot: [{ f: 0, v: [0, 0, 0, 1], step: true }, { f: 10, v: qAxisAngle([0, 1, 0], Math.PI / 2) }] } } });
    const bytes = exportMS3D(m);
    const r = importMS3D(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'x');
    expect(r.groups[0].name).toBe('Körper');
    expect(r.bones[0].name).toBe('Hüfte');
    expect(r.faces.every((f) => f.s > 0)).toBe(true);
    const tr = r.clips[0].tracks[r.bones[0].id];
    sampleTrack(tr, 5).rot.forEach((x, i) => expect(x).toBeCloseTo([0, 0, 0, 1][i], 4));
  });

  it('OBJ blends normals across smoothing groups and keeps flat faces flat', () => {
    const m = modelOf(prims.sphere(1, 8, 6));
    m.faces.forEach((f) => { f.s = 1; });
    const smooth = new TextDecoder().decode(exportOBJ(m, defaultExport, 'x').obj);
    const count = (s: string) => s.split('\n').filter((l) => l.startsWith('vn ')).length;
    // One normal per vertex, not one per face.
    expect(count(smooth)).toBe(m.verts.length);
    m.faces.forEach((f) => { f.s = 0; });
    const flat = new TextDecoder().decode(exportOBJ(m, defaultExport, 'x').obj);
    expect(count(flat)).toBeGreaterThan(m.verts.length);
  });

  it('MS3D rejects bad files and over-limit models', () => {
    expect(() => importMS3D(new TextEncoder().encode('not a model at all!!').buffer as ArrayBuffer, 'x')).toThrow(/header/);
    const m = emptyModel();
    for (let i = 0; i < 70000; i++) m.verts.push({ p: [0, 0, 0] });
    expect(() => exportMS3D(m)).toThrow(/65534/);
  });
});

describe('official glTF validator', () => {
  // A 1x1 PNG, so textures are covered too.
  const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

  async function validate(m: Model) {
    const report = await validator.validateBytes(exportGLB(m, defaultExport));
    return { errors: report.issues.numErrors, warnings: report.issues.numWarnings, messages: report.issues.messages.filter((x: any) => x.severity <= 1).slice(0, 5) };
  }

  it('a rigged, animated model has no errors or warnings', async () => {
    const r = await validate(buildSample());
    expect(r.messages).toEqual([]);
    expect(r.errors).toBe(0);
    expect(r.warnings).toBe(0);
  });

  it('textured PBR materials, LODs and n-gons validate', async () => {
    const m = buildSample();
    const id = 9000;
    m.nextId = 9001;
    m.textures.push({ id, name: 'tex.png', url: PNG, width: 1, height: 1 });
    m.materials[0].maps = { base: id, normal: id, orm: id, emissive: id };
    m.materials[1].emissive = '#ff0000';
    m.materials[1].emissiveStrength = 3;
    m.materials[2].alphaMode = 'mask';
    m.materials[3].alpha = 0.5;
    const res = decimate(m, ops.groupFaces(m, m.groups[0].id), 0.5);
    const lod = makeGroup(m, 'Cup_LOD1', m.groups[0].material, 'lod');
    const base = m.verts.length;
    m.verts.push(...res.verts);
    res.faces.forEach((f) => m.faces.push({ ...f, v: f.v.map((x) => x + base), g: lod.id }));
    const r = await validate(m);
    expect(r.messages).toEqual([]);
    expect(r.errors).toBe(0);
  });

  it('a static mesh with no skeleton validates', async () => {
    const r = await validate(modelOf(prims.torus()));
    expect(r.messages).toEqual([]);
    expect(r.errors).toBe(0);
  });
});

describe('undo snapshots of textures', () => {
  it('keep a texture as it was when its image is changed afterwards', () => {
    const m = emptyModel();
    m.textures.push({ id: 1, name: 't', url: 'data:old', width: 1, height: 1, layers: [{ name: 'Base', url: 'data:old', opacity: 1, visible: true }] });
    const snap = cloneModel(m);
    m.textures[0].url = 'data:new';
    m.textures[0].layers![0].url = 'data:new';
    expect(snap.textures[0].url).toBe('data:old');
    expect(snap.textures[0].layers![0].url).toBe('data:old');
  });
});

describe('undo snapshots', () => {
  it('cloneModel is deep for geometry and copies texture records, sharing their images', () => {
    const m = buildSample();
    m.textures.push({ id: 99, name: 't', url: 'data:x', width: 1, height: 1 });
    const c = cloneModel(m);
    c.verts[0].p[0] = 123;
    c.faces[0].v[0] = 5;
    c.faces[0].uv[0][0] = 7;
    c.bones[0].head[0] = 9;
    expect(m.verts[0].p[0]).not.toBe(123);
    expect(m.faces[0].uv[0][0]).not.toBe(7);
    expect(m.bones[0].head[0]).not.toBe(9);
    // A record of its own, so painting one doesn't change the other; the image string itself is shared.
    expect(c.textures[0]).not.toBe(m.textures[0]);
    expect(c.textures[0]).toEqual(m.textures[0]);
    c.textures[0].url = 'data:y';
    expect(m.textures[0].url).toBe('data:x');
  });
});
