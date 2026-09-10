import { describe, expect, it } from 'vitest';
import {
  COMPACT_PREFIX,
  angDiff,
  crossedStringsFF,
  decodeCompact,
  emissionWeight,
  encodeCompact,
  kelvinToColor,
  polySelfIntersects,
  pointToSegFF,
  solveRadiosity,
  splitSegment,
  validateCustomPoints,
  validateForm,
  validateLight,
} from '../src/core.js';

const validForm = () => ({
  schema: 'cove-form@2',
  units: 'm',
  elements: [
    {
      id: 'plate',
      kind: 'panel',
      thickness: 0.015,
      reflect: 0.25,
      transparency: 0,
      path: { kind: 'polyline', points: [{ u: 0, d: 0.4 }, { u: 0.15, d: 0.4 }] },
    },
    {
      id: 'baffle',
      kind: 'panel',
      thickness: 0.015,
      reflect: 0.2,
      transparency: 0,
      path: { kind: 'polyline', points: [{ u: 0.15, d: 0.4 }, { u: 0.15, d: 0.28 }] },
    },
  ],
  fixture: { u: 0.09, d: 0.2 },
  joints: [],
});

const validLight = () => ({
  emissionAngle: 120,
  rotationAngle: 15,
  lightKelvin: 3000,
  lightIntensity: 800,
  fixture: { u: 0.09, d: 0.2 },
});

const integrateWeight = (src, dist) => {
  const lo = -Math.PI;
  const hi = Math.PI;
  const n = 20000;
  const h = (hi - lo) / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const x = lo + h * i;
    const c = i === 0 || i === n ? 0.5 : 1;
    sum += c * emissionWeight(x, src, dist);
  }
  return sum * h;
};

describe('ILS1 compact codec', () => {
  it('has the expected prefix and round-trips representative setup JSON', async () => {
    const setup = {
      schema: 'cove-setup@1',
      name: '客廳 間接照明',
      cove: validForm(),
      light: validLight(),
      notes: ['非 ASCII', '測試'],
    };

    const encoded = await encodeCompact(setup);
    expect(encoded.startsWith(COMPACT_PREFIX)).toBe(true);
    expect(JSON.parse(await decodeCompact(encoded))).toEqual(setup);
  });

  it('decodes a fixed known code', async () => {
    const code = `${COMPACT_PREFIX}q1YqTs5IzU1UslLKzssvz1PSUcpJTErNUbJSerZjzYuVy5R0lPKUrEyMdJQSi4qUrKINdUqKSlN18kpzcmJrAQ==`;
    expect(JSON.parse(await decodeCompact(code))).toEqual({
      schema: 'known',
      label: '測試',
      n: 42,
      arr: [1, true, null],
    });
  });
});

describe('form validation', () => {
  it('accepts a valid cove-form@2 style form', () => {
    expect(validateForm(validForm()).ok).toBe(true);
  });

  it('rejects malformed forms and elements', () => {
    expect(validateForm({ fixture: { u: 0, d: 0 } }).ok).toBe(false);
    expect(validateForm({ ...validForm(), fixture: { u: Number.NaN, d: 0 } }).ok).toBe(false);
    expect(validateForm({ ...validForm(), elements: [{ ...validForm().elements[0], reflect: 1.1 }] }).ok).toBe(false);
    expect(validateForm({ ...validForm(), elements: [{ ...validForm().elements[0], transparency: -0.1 }] }).ok).toBe(false);
    expect(validateForm({ ...validForm(), elements: [{ ...validForm().elements[0], path: { kind: 'polyline', points: [{ u: 0, d: 0 }] } }] }).ok).toBe(false);
    expect(validateForm({ ...validForm(), elements: [{ ...validForm().elements[0], path: { kind: 'polyline', points: [{ u: 0, d: 0 }, { u: Infinity, d: 0 }] } }] }).ok).toBe(false);
    expect(validateForm({ ...validForm(), elements: [{ kind: 'panel', path: { kind: 'arc', center: { u: 0, d: 0 }, radius: 0, startDeg: 0, sweepDeg: 90 } }] }).ok).toBe(false);
    expect(validateForm({ ...validForm(), elements: [{ kind: 'polygon', path: { points: [{ u: 0, d: 0 }, { u: 0.1, d: 0 }, { u: 0.2, d: 0 }] } }] }).ok).toBe(false);
  });
});

describe('custom polygon validation', () => {
  it('accepts a valid quad', () => {
    expect(validateCustomPoints([
      { u: 0, d: 0 },
      { u: 0.2, d: 0 },
      { u: 0.2, d: 0.2 },
      { u: 0, d: 0.2 },
    ]).ok).toBe(true);
  });

  it('rejects invalid custom polygons', () => {
    expect(validateCustomPoints([{ u: 0, d: 0 }, { u: 0.1, d: 0 }]).ok).toBe(false);
    expect(validateCustomPoints([{ u: 0, d: 0 }, { u: 0.1, d: 0 }, { u: 0.1, d: 0 }]).ok).toBe(false);
    expect(validateCustomPoints([{ u: 0, d: 0 }, { u: 0.4, d: 0 }, { u: 0.1, d: 0.1 }]).ok).toBe(false);
    expect(validateCustomPoints([{ u: 0, d: 0 }, { u: 0.1, d: 0 }, { u: Infinity, d: 0.1 }]).ok).toBe(false);
    expect(validateCustomPoints([{ u: 0, d: 0 }, { u: 0.1, d: 0 }, { u: 0.1, d: 0.1 }, { u: 0.1, d: 0 }, { u: 0, d: 0.1 }]).ok).toBe(false);
    expect(validateCustomPoints([{ u: 0, d: 0 }, { u: 0.2, d: 0.2 }, { u: 0, d: 0.2 }, { u: 0.2, d: 0 }]).ok).toBe(false);
  });
});

describe('polySelfIntersects', () => {
  it('accepts a convex quad', () => {
    expect(polySelfIntersects([
      { u: 0, d: 0 }, { u: 0.2, d: 0 }, { u: 0.2, d: 0.2 }, { u: 0, d: 0.2 },
    ])).toBe(false);
  });

  it('detects a bowtie proper crossing', () => {
    expect(polySelfIntersects([
      { u: 0, d: 0 }, { u: 0.2, d: 0.2 }, { u: 0, d: 0.2 }, { u: 0.2, d: 0 },
    ])).toBe(true);
  });

  it('detects a T-junction onto a non-adjacent edge', () => {
    // (0.05,0) 落在底邊 (0,0)–(0.2,0) 內部
    expect(polySelfIntersects([
      { u: 0, d: 0 }, { u: 0.2, d: 0 }, { u: 0.2, d: 0.15 }, { u: 0.05, d: 0 },
    ])).toBe(true);
  });

  it('detects collinear overlap of non-adjacent edges', () => {
    // 底邊 (0,0)–(0.3,0) 與 (0.1,0)–(0.2,0) 共線重疊
    expect(polySelfIntersects([
      { u: 0, d: 0 }, { u: 0.3, d: 0 }, { u: 0.3, d: 0.12 },
      { u: 0.2, d: 0 }, { u: 0.1, d: 0 }, { u: 0, d: 0.12 },
    ])).toBe(true);
  });

  it('detects adjacent backtracking along the same segment', () => {
    expect(polySelfIntersects([
      { u: 0, d: 0 }, { u: 0.2, d: 0 }, { u: 0.1, d: 0 }, { u: 0.1, d: 0.15 },
    ])).toBe(true);
  });
});

describe('light validation', () => {
  it('accepts a valid light', () => {
    expect(validateLight(validLight()).ok).toBe(true);
  });

  it('rejects non-finite light parameters and invalid fixture', () => {
    for (const key of ['emissionAngle', 'rotationAngle', 'lightKelvin', 'lightIntensity']) {
      expect(validateLight({ ...validLight(), [key]: Number.NaN }).ok).toBe(false);
    }
    expect(validateLight({ ...validLight(), fixture: undefined }).ok).toBe(false);
    expect(validateLight({ ...validLight(), fixture: { u: 0.1, d: Infinity } }).ok).toBe(false);
  });
});

describe('emission distribution', () => {
  it('normalizes uniform and lambert distributions over supported half-angles', () => {
    for (const halfDeg of [60, 90, 180]) {
      const src = { axisRad: 0, halfR: halfDeg * Math.PI / 180 };
      expect(integrateWeight(src, 'uniform')).toBeCloseTo(1, 3);
      expect(integrateWeight(src, 'lambert')).toBeCloseTo(1, 3);
    }
  });

  it('returns zero outside the cone and respects a rotated lambert axis', () => {
    const src = { axisRad: Math.PI / 2, halfR: Math.PI / 6 };
    expect(emissionWeight(0, src, 'lambert')).toBe(0);
    expect(emissionWeight(Math.PI / 2, src, 'lambert')).toBeGreaterThan(0);
    expect(emissionWeight(Math.PI / 2 + Math.PI / 3, src, 'uniform')).toBe(0);
  });
});

describe('angular and geometric form factors', () => {
  it('wraps angular differences into the principal interval', () => {
    expect(angDiff(3 * Math.PI / 2, 0)).toBeCloseTo(-Math.PI / 2);
    expect(angDiff(-3 * Math.PI / 2, 0)).toBeCloseTo(Math.PI / 2);
    expect(Math.abs(angDiff(20, -20))).toBeLessThanOrEqual(Math.PI);
  });

  it('satisfies crossed-string reciprocity and clamps to [0,1]', () => {
    const p = { ax: 0.1, ay: 0.2, bx: 0.7, by: 0.35 };
    const q = { ax: 0.25, ay: 1.1, bx: 1.05, by: 0.95 };
    p.len = Math.hypot(p.bx - p.ax, p.by - p.ay);
    q.len = Math.hypot(q.bx - q.ax, q.by - q.ay);
    const fpq = crossedStringsFF(p, q);
    const fqp = crossedStringsFF(q, p);

    expect(fpq).toBeGreaterThanOrEqual(0);
    expect(fpq).toBeLessThanOrEqual(1);
    expect(fqp).toBeGreaterThanOrEqual(0);
    expect(fqp).toBeLessThanOrEqual(1);
    expect(p.len * fpq).toBeCloseTo(q.len * fqp, 12);
  });

  it('sums a closed box to one front hemisphere and returns zero behind the normal', () => {
    const patches = [
      ...splitSegment(0, 0, 1, 0, 0.02),
      ...splitSegment(1, 0, 1, 1, 0.02),
      ...splitSegment(1, 1, 0, 1, 0.02),
      ...splitSegment(0, 1, 0, 0, 0.02),
    ];

    for (const [nx, ny] of [[0, 1], [0, -1], [-1, 0], [1, 0]]) {
      const sum = patches.reduce((acc, p) => acc + pointToSegFF(0.5, 0.5, nx, ny, p), 0);
      expect(sum).toBeCloseTo(1, 10);
    }

    expect(pointToSegFF(0.5, 0.5, 0, 1, { ax: 0.25, ay: 0.25, bx: 0.75, by: 0.25 })).toBe(0);
  });
});

describe('radiosity solver', () => {
  it('converges to the closed-box uniform-reflectance solution', () => {
    const n = 4;
    const rho = 0.5;
    const e0 = 10;
    const patches = Array.from({ length: n }, () => ({ rho }));
    const F = Array.from({ length: n }, (_, i) =>
      Float64Array.from({ length: n }, (_, j) => i === j ? 0 : 1 / (n - 1)));

    const B = solveRadiosity(patches, F, Array(n).fill(e0));
    // 求解器在 delta≤0.01 收斂門檻停止，故每片約在解析值 ±0.01 內（容差放寬至 1 位小數）
    for (const v of B) expect(v).toBeCloseTo(rho * e0 / (1 - rho), 1);
  });

  it('has non-decreasing Jacobi iterates from zero for non-negative inputs', () => {
    const n = 4;
    const rho = 0.6;
    const e0 = 5;
    const F = Array.from({ length: n }, (_, i) =>
      Float64Array.from({ length: n }, (_, j) => i === j ? 0 : 1 / (n - 1)));
    let B = new Float64Array(n);

    for (let iter = 0; iter < 12; iter++) {
      const next = new Float64Array(n);
      for (let i = 0; i < n; i++) {
        let incoming = 0;
        for (let j = 0; j < n; j++) incoming += F[i][j] * B[j];
        next[i] = rho * e0 + rho * incoming;
        expect(next[i]).toBeGreaterThanOrEqual(B[i]);
      }
      B = next;
    }
  });
});

describe('kelvinToColor', () => {
  it('returns normalized RGB and makes warm light redder than cool light', () => {
    const warm = kelvinToColor(3000);
    const cool = kelvinToColor(6500);

    for (const c of [warm, cool]) {
      expect(c.r).toBeGreaterThanOrEqual(0);
      expect(c.r).toBeLessThanOrEqual(1);
      expect(c.g).toBeGreaterThanOrEqual(0);
      expect(c.g).toBeLessThanOrEqual(1);
      expect(c.b).toBeGreaterThanOrEqual(0);
      expect(c.b).toBeLessThanOrEqual(1);
    }
    expect(warm.r - warm.b).toBeGreaterThan(cool.r - cool.b);
  });
});
