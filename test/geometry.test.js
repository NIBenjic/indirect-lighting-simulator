import { describe, expect, it } from 'vitest';
import { ribbonFromCenter } from '../src/geometry.js';

function splitSides(pts, outline) {
  const n = pts.length;
  return { left: outline.slice(0, n), right: outline.slice(n).reverse() };
}

describe('ribbonFromCenter', () => {
  it('offsets a 2-point panel into a rectangle of the given thickness', () => {
    const pts = [{ u: 0, d: 0.4 }, { u: 0.15, d: 0.4 }];
    const { outline, faces } = ribbonFromCenter(pts, 0.02);
    const { left, right } = splitSides(pts, outline);
    expect(faces.length).toBe(4);
    expect(left[0].d).toBeCloseTo(0.41);
    expect(right[0].d).toBeCloseTo(0.39);
    expect(left[1].d).toBeCloseTo(0.41);
    expect(right[1].d).toBeCloseTo(0.39);
  });

  it('miters a 90° L so the outer corner is at (depth+h, -h)', () => {
    const h = 0.01;
    const pts = [{ u: 0, d: 0 }, { u: 0.1, d: 0 }, { u: 0.1, d: 0.1 }];
    const { outline } = ribbonFromCenter(pts, h * 2);
    const { left, right } = splitSides(pts, outline);
    // 右走再上走＝左轉；右側為外角
    expect(right[1].u).toBeCloseTo(0.1 + h);
    expect(right[1].d).toBeCloseTo(0 - h);
    expect(left[1].u).toBeCloseTo(0.1 - h);
    expect(left[1].d).toBeCloseTo(0 + h);
  });

  it('does not invert left/right at an acute turn', () => {
    const pts = [{ u: 0, d: 0 }, { u: 0.1, d: 0 }, { u: 0.03, d: 0.01 }];
    const { outline } = ribbonFromCenter(pts, 0.02);
    const { left, right } = splitSides(pts, outline);
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const midU = (left[i].u + right[i].u) / 2;
      const midD = (left[i].d + right[i].d) / 2;
      expect(Math.hypot(midU - pts[i].u, midD - pts[i].d)).toBeLessThan(0.025);
    }
    // 第一段：左在 +d、右在 -d
    expect(left[0].d).toBeGreaterThan(pts[0].d);
    expect(right[0].d).toBeLessThan(pts[0].d);
  });
});
