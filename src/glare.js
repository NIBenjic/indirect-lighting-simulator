// glare.js — 視角眩光分析（純函式：不碰 DOM / 全域狀態）
//
// 舊實作取「最高不透光角」當唯一遮擋緣，再把光源–該角連線延長到眼高。
// 燈具貼在水平底板／窗台時，該角幾乎與光源同高，掠射線近水平，
// 會報出數公尺的假安全距離（例如 2767 mm），或把「最高角在光源之上」
// 誤判成完全遮蔽。正確做法：對燈具裸露邊界的每個角，沿眼高線做實際
// 視線遮擋測試，找隱藏↔可見的轉換點。

export const GLARE_NEAR = 0.003; // 3mm：光源貼面時忽略末端自交

// 開區間 A→B 是否被不透光幾何擋住。hitFn(ox,oy,dx,dy) 回傳最近命中
// {x,y,transparency,pass} 或 null，語意同 main.findHit。
export function segmentOccluded(ax, ay, bx, by, hitFn, opts = {}) {
  const ignoreNearB = opts.ignoreNearB != null ? opts.ignoreNearB : GLARE_NEAR;
  const skipHit = opts.skipHit;
  const dx = bx - ax, dy = by - ay;
  const r = Math.hypot(dx, dy);
  if (r < 1e-6) return false;
  const ux = dx / r, uy = dy / r;
  let ox = ax, oy = ay, guard = 0;
  while (guard++ < 24) {
    const hit = hitFn(ox, oy, ux, uy);
    if (!hit) return false;
    const d = Math.hypot(hit.x - ax, hit.y - ay);
    if (d >= r - ignoreNearB) return false;          // 命中在 B 上／之外
    if (hit.pass) return false;                       // 牆面開口
    if (skipHit && skipHit(hit)) {                    // 例如燈具體積內的自遮擋
      ox = hit.x + ux * 1e-4;
      oy = hit.y + uy * 1e-4;
      continue;
    }
    // 半透光：光源仍可見 → 不算遮蔽（偏保守，較易判定眩光）
    if ((hit.transparency || 0) > 0) {
      ox = hit.x + ux * 1e-4;
      oy = hit.y + uy * 1e-4;
      continue;
    }
    return true;
  }
  return false;
}

// 把世界點轉回裸露框的未旋轉座標（有 phi 時繞 ox,oy 反轉）。
function toBoxLocal(x, y, box) {
  if (!box || !box.phi || Math.abs(box.phi) < 1e-12 || box.ox == null) return { x, y };
  const dx = x - box.ox, dy = y - box.oy;
  const c = Math.cos(-box.phi), s = Math.sin(-box.phi);
  return { x: box.ox + dx * c - dy * s, y: box.oy + dx * s + dy * c };
}

export function inGlareBox(x, y, box, pad = 0.002) {
  if (!box) return false;
  const p = toBoxLocal(x, y, box);
  return p.x >= box.x0 - pad && p.x <= box.x1 + pad && p.y >= box.y0 - pad && p.y <= box.y1 + pad;
}

// 分析用的四個角：旋轉後的 corners，否則軸對齊 AABB。
export function glareCorners(box) {
  if (box && box.corners && box.corners.length) return box.corners;
  if (!box) return [];
  return [
    { x: box.x0, y: box.y0 }, { x: box.x1, y: box.y0 },
    { x: box.x0, y: box.y1 }, { x: box.x1, y: box.y1 },
  ];
}

// 命中是否落在燈具體積內（裸露框或距掛點 < near）。照度直射須跳過自遮擋。
export function hitIsFixture(hit, sources, near = 0.005) {
  if (!hit || !sources || !sources.length) return false;
  for (const s of sources) {
    if (s.box && inGlareBox(hit.x, hit.y, s.box)) return true;
    if (s.lx != null && Math.hypot(hit.x - s.lx, hit.y - s.ly) < near) return true;
  }
  return false;
}

/**
 * 單點光源在眼高線上的眩光狀態。
 * occluded(x1,y1,x2,y2) → 開區間是否被擋住。
 * status: 'shielded' | 'allGlare' | 'safeNear' | 'safeFar'
 */
export function analyzeLuminousPoint(cx, cy, eyeH, side, W, occluded) {
  const visible = (x) => !occluded(x, eyeH, cx, cy);
  const eps = 0.02;                                   // 離牆 20mm，避免射線起點落在牆面
  const inward = side === 'L' ? 1 : -1;
  const wallX = side === 'L' ? 0 : W;
  // s∈[0,1]：從本側牆往室內走。xAt(0) 近牆、xAt(1) 遠牆。
  const xAt = (s) => {
    const x = wallX + inward * (eps + s * (W - 2 * eps));
    return Math.max(eps, Math.min(W - eps, x));
  };

  const N = 160;
  const visAt = (i) => visible(xAt(i / N));
  const nearVis = visAt(0);
  const farVis  = visAt(N);

  const transitions = [];                             // s 從牆往室內遞增；from/to 沿此方向
  let prevV = visAt(0);
  for (let i = 1; i <= N; i++) {
    const v = visAt(i);
    if (v !== prevV) {
      let a = (i - 1) / N, b = i / N, va = prevV;
      for (let k = 0; k < 22; k++) {
        const m = (a + b) / 2;
        if (visible(xAt(m)) === va) a = m; else b = m;
      }
      const s = (a + b) / 2;
      transitions.push({ s, x: xAt(s), from: prevV, to: v });
      prevV = v;
    }
  }

  if (nearVis && farVis && transitions.length === 0)
    return { status: 'allGlare', xGraze: null };
  if (!nearVis && !farVis && transitions.length === 0)
    return { status: 'shielded', xGraze: null };

  if (!nearVis && farVis) {
    const t = transitions.find(tr => !tr.from && tr.to);
    return { status: 'safeNear', xGraze: t ? t.x : null };
  }
  if (nearVis && !farVis) {
    const t = transitions.find(tr => tr.from && !tr.to);
    return { status: 'safeFar', xGraze: t ? t.x : null };
  }
  // 近遠都可見但中間有轉換（遮擋口袋）→ 仍有近處眩光，視為全區可見
  if (nearVis && farVis) return { status: 'allGlare', xGraze: null };
  // 近遠都不可見但中間有可見口袋
  if (!nearVis && !farVis) {
    const t = transitions.find(tr => tr.to);
    if (t) return { status: 'safeNear', xGraze: t.x };
    return { status: 'shielded', xGraze: null };
  }
  return { status: nearVis ? 'allGlare' : 'shielded', xGraze: null };
}

// 四角取「最裸露」：任一角全區可見 → 全區可見；否則取眩光區最大的臨界。
export function combineGlareCorners(results, side) {
  let anyAll = false, best = null;
  for (const r of results) {
    if (r.status === 'allGlare') { anyAll = true; continue; }
    if (r.status === 'shielded' || r.xGraze == null) continue;
    if (!best) { best = r; continue; }
    const smallerWorse = (side === 'L' && r.status === 'safeNear') ||
                         (side === 'R' && r.status === 'safeFar');
    const worse = smallerWorse ? (r.xGraze < best.xGraze) : (r.xGraze > best.xGraze);
    if (worse) best = r;
  }
  if (anyAll) return { status: 'allGlare', xGraze: null, corner: null };
  if (!best) return { status: 'shielded', xGraze: null, corner: null };
  return { status: best.status, xGraze: best.xGraze, corner: best.corner || null };
}

// 從四個角組出單側結論。box = {x0,x1,y0,y1} 或含 corners 的旋轉框。
export function analyzeGlareBox(box, eyeH, side, W, occluded) {
  const corners = glareCorners(box);
  const results = corners.map(c => {
    const r = analyzeLuminousPoint(c.x, c.y, eyeH, side, W, occluded);
    return { ...r, corner: c };
  });
  const comb = combineGlareCorners(results, side);
  const rep = corners.length
    ? { x: corners.reduce((s, c) => s + c.x, 0) / corners.length, y: corners.reduce((s, c) => s + c.y, 0) / corners.length }
    : { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 };
  const used = comb.corner || rep;
  return {
    status: comb.status,
    xGraze: comb.xGraze,
    lightX: used.x,
    lightY: used.y,
    box,
  };
}
