import { describe, expect, it } from 'vitest';
import { CURVE_LABEL, curveToPrim, DEFAULT_CURVE, DETAIL_PRESETS, LOOP_KINDS, PATH_OUTPUT_LABEL, signedVolume, simplifyStroke, type CurveKind, type P3, type PathOutput } from '../src/core/curves';
import type { Prim } from '../src/core/primitives';

const wave: P3[] = Array.from({ length: 6 }, (_, i) => [i * 0.4, Math.sin(i) * 0.3, 0]);
const loop: P3[] = Array.from({ length: 8 }, (_, i) => [Math.cos((i / 8) * Math.PI * 2), Math.sin((i / 8) * Math.PI * 2), 0]);
const vol = (p: Prim) => signedVolume({ positions: p.verts, faces: p.faces.map((f) => ({ v: f.v })) });
const valid = (p: Prim) => {
  expect(p.faces.length).toBeGreaterThan(0);
  for (const v of p.verts) expect(v.every(Number.isFinite)).toBe(true);
  for (const f of p.faces) {
    expect(f.v.length).toBeGreaterThanOrEqual(3);
    expect(f.uv.length).toBe(f.v.length);
    for (const i of f.v) expect(i >= 0 && i < p.verts.length).toBe(true);
  }
};

describe('curves', () => {
  it('builds every kind', () => {
    for (const kind of Object.keys(CURVE_LABEL) as CurveKind[]) {
      const cyclic = LOOP_KINDS.includes(kind);
      valid(curveToPrim(cyclic ? loop : wave, { ...DEFAULT_CURVE, kind, cyclic }));
    }
  });

  it('builds every path output', () => {
    for (const pathOutput of Object.keys(PATH_OUTPUT_LABEL) as PathOutput[]) valid(curveToPrim(wave, { ...DEFAULT_CURVE, pathOutput }));
  });

  it('copies another part along the path', () => {
    const cube = { positions: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]] as P3[], faces: [{ v: [0, 2, 1] }, { v: [0, 1, 3] }, { v: [0, 3, 2] }, { v: [1, 2, 3] }] };
    const p = curveToPrim(wave, { ...DEFAULT_CURVE, pathOutput: 'object-array', pathSourceObject: 7 }, [0, 1, 0], (id) => (id === 7 ? cube : null));
    valid(p);
    expect(p.faces.length % 4).toBe(0);
  });

  it('closed tubes and lathes face outward', () => {
    expect(vol(curveToPrim(wave, { ...DEFAULT_CURVE, kind: 'tapered-tube' }))).toBeGreaterThan(0);
    expect(vol(curveToPrim(wave, DEFAULT_CURVE))).toBeGreaterThan(0);
    // Drawn either way up, the lathe still points out.
    const profile: P3[] = [[0, 1, 0], [0.5, 0.8, 0], [0.4, 0, 0], [0, -0.2, 0]];
    for (const pts of [profile, [...profile].reverse()]) {
      const p = curveToPrim(pts, { ...DEFAULT_CURVE, solid: 'lathe' });
      valid(p);
      expect(vol(p)).toBeGreaterThan(0);
    }
    const half = curveToPrim(profile, { ...DEFAULT_CURVE, solid: 'lathe', latheAngle: 180 });
    valid(half);
    expect(vol(half)).toBeGreaterThan(0);
  });

  it('low, medium and high poly step up in face count', () => {
    const profile: P3[] = [[0, 1, 0], [0.5, 0.8, 0], [0.4, 0, 0], [0, -0.2, 0]];
    for (const [pts, extra] of [[wave, {}], [wave, { kind: 'rope' }], [profile, { solid: 'lathe' }]] as const) {
      const [lo, mid, hi] = (['low', 'medium', 'high'] as const).map((l) => curveToPrim(pts, { ...DEFAULT_CURVE, ...extra, ...DETAIL_PRESETS[l] }).faces.length);
      expect(lo).toBeLessThan(mid);
      expect(mid).toBeLessThan(hi);
    }
  });

  it('rejects a line too short to build', () => {
    expect(() => curveToPrim([[0, 0, 0], [0, 0, 0]], DEFAULT_CURVE)).toThrow();
    expect(() => curveToPrim([[0, 0, 0], [0, 1, 0]], { ...DEFAULT_CURVE, solid: 'lathe' })).toThrow();
  });

  it('simplifies a freehand stroke', () => {
    const line: P3[] = Array.from({ length: 50 }, (_, i) => [i / 49, 0, 0]);
    expect(simplifyStroke(line, 0.01)).toHaveLength(2);
  });
});
