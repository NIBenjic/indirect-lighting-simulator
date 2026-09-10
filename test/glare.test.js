import { describe, expect, it } from 'vitest';
import {
  analyzeGlareBox,
  analyzeLuminousPoint,
  combineGlareCorners,
  glareCorners,
  hitIsFixture,
  inGlareBox,
  segmentOccluded,
} from '../src/glare.js';

// 簡易射線 vs 線段：回傳最近命中 {x,y,transparency,pass}
function hitFnFromSegs(segs) {
  return (ox, oy, dx, dy) => {
    let tMin = Infinity, hit = null;
    for (const s of segs) {
      const ex = s.bx - s.ax, ey = s.by - s.ay;
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-12) continue;
      const t  = ((s.ax - ox) * ey - (s.ay - oy) * ex) / denom;
      const sp = ((s.ax - ox) * dy - (s.ay - oy) * dx) / denom;
      if (t > 1e-5 && t < tMin && sp >= 0 && sp <= 1) {
        tMin = t;
        hit = { x: ox + dx * t, y: oy + dy * t, transparency: s.transparency || 0, pass: !!s.pass };
      }
    }
    return hit;
  };
}

function occludedFromSegs(segs) {
  const hitFn = hitFnFromSegs(segs);
  return (ax, ay, bx, by) => segmentOccluded(ax, ay, bx, by, hitFn);
}

const W = 8, eyeH = 1.65;

describe('segmentOccluded', () => {
  it('is clear when nothing is in between', () => {
    const hitFn = hitFnFromSegs([]);
    expect(segmentOccluded(4, 1.65, 0.09, 2.8, hitFn)).toBe(false);
  });

  it('detects a vertical baffle between eye and light', () => {
    const hitFn = hitFnFromSegs([{ ax: 0.15, ay: 2.5, bx: 0.15, by: 2.85 }]);
    expect(segmentOccluded(4, 1.65, 0.09, 2.8, hitFn)).toBe(true);
    expect(segmentOccluded(0.12, 1.65, 0.09, 2.8, hitFn)).toBe(false); // 擋板外側、視線不穿越
  });

  it('does not treat a hit at the destination as occlusion', () => {
    const hitFn = hitFnFromSegs([{ ax: 0.05, ay: 2.8, bx: 0.15, by: 2.8 }]);
    expect(segmentOccluded(4, 1.65, 0.09, 2.8, hitFn)).toBe(false);
  });
});

describe('analyzeLuminousPoint: classic vertical baffle', () => {
  // 經典燈槽：垂直擋板 x=0.15、y=2.60..2.72；光源 (0.09, 2.80)
  const segs = [
    { ax: 0.15, ay: 2.60, bx: 0.15, by: 2.72 },
    { ax: 0.00, ay: 2.60, bx: 0.15, by: 2.60 },
  ];
  const occ = occludedFromSegs(segs);

  it('is safeNear with graze near 1 m for a recessed light', () => {
    const r = analyzeLuminousPoint(0.09, 2.80, eyeH, 'L', W, occ);
    expect(r.status).toBe('safeNear');
    expect(r.xGraze).toBeGreaterThan(0.4);
    expect(r.xGraze).toBeLessThan(2.0);
  });

  it('mirrors to the right wall', () => {
    const rSegs = segs.map(s => ({ ...s, ax: W - s.ax, bx: W - s.bx }));
    const r = analyzeLuminousPoint(W - 0.09, 2.80, eyeH, 'R', W, occludedFromSegs(rSegs));
    expect(r.status).toBe('safeNear');
    expect(W - r.xGraze).toBeGreaterThan(0.4);
    expect(W - r.xGraze).toBeLessThan(2.0);
  });
});

describe('analyzeLuminousPoint: no occluder / fully boxed', () => {
  it('reports allGlare when the room has a clear view of the light', () => {
    const r = analyzeLuminousPoint(0.09, 2.80, eyeH, 'L', W, occludedFromSegs([]));
    expect(r.status).toBe('allGlare');
    expect(r.xGraze).toBeNull();
  });

  it('reports safeFar when a room-side slab hides the light from the far field only', () => {
    // 光源在隔板牆側：近牆可見、室內其餘被擋住
    const slab = [{ ax: 0.20, ay: 0.1, bx: 0.20, by: 2.95 }];
    const r = analyzeLuminousPoint(0.09, 2.80, eyeH, 'L', W, occludedFromSegs(slab));
    expect(r.status).toBe('safeFar');
    expect(r.xGraze).toBeGreaterThan(0.15);
    expect(r.xGraze).toBeLessThan(1.5);
  });
});

describe('shelf light: the 2767 mm class of bug', () => {
  // 水平底板 0..0.30、厚 20mm（y=2.58..2.60）；光源貼在板頂。
  // 舊啟發式拿近牆最高角當遮擋緣 → 掠射近水平 → 假的數公尺「最遠安全距離」。
  // 正確：不透光底板擋住從下方往上看板頂的視線 → 室內完全看不見（完全遮蔽）。
  const shelf = [
    { ax: 0.00, ay: 2.60, bx: 0.30, by: 2.60 },
    { ax: 0.30, ay: 2.60, bx: 0.30, by: 2.58 },
    { ax: 0.30, ay: 2.58, bx: 0.00, by: 2.58 },
    { ax: 0.00, ay: 2.58, bx: 0.00, by: 2.60 },
  ];

  it('reports shielded, not a multi-metre safeNear, for a light sitting on an opaque shelf', () => {
    const r = analyzeLuminousPoint(0.10, 2.61, eyeH, 'L', W, occludedFromSegs(shelf));
    expect(r.status).toBe('shielded');
  });

  it('reports allGlare once the light is at the room-facing lip (nothing to hide behind)', () => {
    const r = analyzeLuminousPoint(0.32, 2.55, eyeH, 'L', W, occludedFromSegs(shelf));
    expect(r.status).toBe('allGlare');
  });
});

describe('luminous corner past the baffle', () => {
  const baffle = [{ ax: 0.15, ay: 2.60, bx: 0.15, by: 2.72 }];
  it('treats a corner in open room as allGlare', () => {
    // 裸露邊界伸過擋板到 x=0.20，該角已在室內、擋板遮不到
    const r = analyzeLuminousPoint(0.20, 2.82, eyeH, 'L', W, occludedFromSegs(baffle));
    expect(r.status).toBe('allGlare');
  });
});

describe('combineGlareCorners', () => {
  it('promotes any allGlare corner to the side result', () => {
    const comb = combineGlareCorners([
      { status: 'safeNear', xGraze: 0.9, corner: { x: 0.09, y: 2.8 } },
      { status: 'allGlare', xGraze: null, corner: { x: 0.17, y: 2.82 } },
    ], 'L');
    expect(comb.status).toBe('allGlare');
  });

  it('picks the more exposed (smaller) xGraze on the left safeNear', () => {
    const comb = combineGlareCorners([
      { status: 'safeNear', xGraze: 1.2, corner: { x: 0.09, y: 2.78 } },
      { status: 'safeNear', xGraze: 0.7, corner: { x: 0.09, y: 2.82 } },
    ], 'L');
    expect(comb.status).toBe('safeNear');
    expect(comb.xGraze).toBeCloseTo(0.7);
  });
});

describe('analyzeGlareBox', () => {
  it('returns a representative point and status for a recessed box', () => {
    const segs = [
      { ax: 0.15, ay: 2.60, bx: 0.15, by: 2.72 },
      { ax: 0.00, ay: 2.60, bx: 0.15, by: 2.60 },
    ];
    const box = { x0: 0.07, x1: 0.11, y0: 2.78, y1: 2.82 };
    const r = analyzeGlareBox(box, eyeH, 'L', W, occludedFromSegs(segs));
    expect(r.status).toBe('safeNear');
    expect(r.lightX).toBeGreaterThanOrEqual(box.x0);
    expect(r.lightX).toBeLessThanOrEqual(box.x1);
  });
});

describe('rotated glare box', () => {
  it('inGlareBox inverse-rotates so a tilted corner is inside and a world-AABB corner is not', () => {
    const phi = Math.PI / 4;
    const box = {
      x0: 0.09, x1: 0.13, y0: 2.78, y1: 2.82,
      ox: 0.09, oy: 2.80, phi,
    };
    // 未旋轉時的右上角，旋轉 45° 後應仍算在框內
    const c = Math.cos(phi), s = Math.sin(phi);
    const dx = 0.13 - 0.09, dy = 2.82 - 2.80;
    const tilted = { x: 0.09 + dx * c - dy * s, y: 2.80 + dx * s + dy * c };
    expect(inGlareBox(tilted.x, tilted.y, box)).toBe(true);
    // 未旋轉 AABB 的右上（世界）在旋轉後已離開框
    expect(inGlareBox(0.13, 2.82, box)).toBe(false);
  });

  it('glareCorners prefers the rotated corners list', () => {
    const corners = [{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 1, y: 4 }];
    expect(glareCorners({ x0: 0, x1: 1, y0: 0, y1: 1, corners })).toEqual(corners);
    expect(glareCorners({ x0: 0, x1: 1, y0: 2, y1: 3 })).toEqual([
      { x: 0, y: 2 }, { x: 1, y: 2 }, { x: 0, y: 3 }, { x: 1, y: 3 },
    ]);
  });

  it('hitIsFixture treats glare-box hits and near-source hits as fixture body', () => {
    const box = { x0: 0.09, x1: 0.13, y0: 2.78, y1: 2.82 };
    const sources = [{ lx: 0.09, ly: 2.80, box }];
    expect(hitIsFixture({ x: 0.11, y: 2.80 }, sources)).toBe(true);
    expect(hitIsFixture({ x: 0.09, y: 2.801 }, sources)).toBe(true);
    expect(hitIsFixture({ x: 1, y: 1.65 }, sources)).toBe(false);
  });
});
