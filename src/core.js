// 共用工具/常數
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const THICK = 0.015;   // 材料厚度 15mm（公尺）

// 色溫轉 RGB（Tanner Helland 近似）→ { r, g, b }（0–1 浮點）。純函式、無 three 相依。
export function kelvinToColor(K) {
  const t = K / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = t <= 2 ? 0 : 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v) => Math.max(0, Math.min(255, v)) / 255;
  return { r: c(r), g: c(g), b: c(b) };
}

// 自訂剖面頂點驗證閘（公尺）：回傳 { ok, error, points }
export function validateCustomPoints(pts) {
  if (!Array.isArray(pts)) return { ok:false, error:'points 不是陣列' };
  const P = pts.map(p => ({ u: Number(p.u), d: Number(p.d) }));
  if (P.some(p => !isFinite(p.u) || !isFinite(p.d))) return { ok:false, error:'座標含非數值' };
  const D = P.filter((p,i) => i===0 || Math.hypot(p.u-P[i-1].u, p.d-P[i-1].d) > 1e-6); // 去連續重複/零長段
  if (D.length < 3) return { ok:false, error:'至少需 3 個相異點' };
  if (D.some(p => p.u < -1e-3 || p.u > 0.32 || p.d < -1e-3 || p.d > 0.65))
    return { ok:false, error:'座標超出範圍（u 0~300mm、d 0~600mm）' };
  // 非相鄰頂點重合（T 形交會／自觸）
  for (let i = 0; i < D.length; i++)
    for (let j = i + 2; j < D.length; j++) {
      if (i === 0 && j === D.length - 1) continue;     // 首尾相鄰（封閉）
      if (Math.hypot(D[i].u - D[j].u, D[i].d - D[j].d) < 1e-6)
        return { ok:false, error:'非相鄰頂點重合' };
    }
  let area = 0;
  for (let i=0;i<D.length;i++){ const a=D[i], b=D[(i+1)%D.length]; area += a.u*b.d - b.u*a.d; }
  if (Math.abs(area/2) < 1e-6) return { ok:false, error:'多邊形面積過小或退化' };
  if (polySelfIntersects(D)) return { ok:false, error:'多邊形邊線自相交' };
  return { ok:true, points: D };
}

// 非相鄰邊線段相交偵測（封閉多邊形）；含 T 接與共線重疊（舊版只抓嚴格交叉）。
export function polySelfIntersects(P) {
  const n = P.length;
  const EPS = 1e-9;
  const cross = (o, a, b) => (a.u - o.u) * (b.d - o.d) - (a.d - o.d) * (b.u - o.u);
  const nearly = (p, q) => Math.hypot(p.u - q.u, p.d - q.d) < 1e-9;
  // p 在 a–b 開區間上（共線且非端點）
  const interiorOnSeg = (a, b, p) => {
    if (Math.abs(cross(a, b, p)) > EPS) return false;
    if (nearly(p, a) || nearly(p, b)) return false;
    const minU = Math.min(a.u, b.u) - EPS, maxU = Math.max(a.u, b.u) + EPS;
    const minD = Math.min(a.d, b.d) - EPS, maxD = Math.max(a.d, b.d) + EPS;
    return p.u >= minU && p.u <= maxU && p.d >= minD && p.d <= maxD;
  };
  const projOverlap = (a, b, c, d) => {
    const useU = Math.abs(b.u - a.u) >= Math.abs(b.d - a.d);
    const A = useU ? [a.u, b.u] : [a.d, b.d];
    const B = useU ? [c.u, d.u] : [c.d, d.d];
    const lo = Math.max(Math.min(A[0], A[1]), Math.min(B[0], B[1]));
    const hi = Math.min(Math.max(A[0], A[1]), Math.max(B[0], B[1]));
    return hi - lo > EPS;                               // 正長度重疊（共享端點不算）
  };
  const segsHit = (a, b, c, d) => {
    const d1 = cross(c, d, a), d2 = cross(c, d, b), d3 = cross(a, b, c), d4 = cross(a, b, d);
    const proper = ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
                   ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    if (proper) return true;
    if (Math.abs(d1) <= EPS && Math.abs(d2) <= EPS) return projOverlap(a, b, c, d);
    return interiorOnSeg(c, d, a) || interiorOnSeg(c, d, b) ||
           interiorOnSeg(a, b, c) || interiorOnSeg(a, b, d);
  };
  for (let i = 0; i < n; i++) {
    const a = P[i], b = P[(i + 1) % n];
    // 相鄰邊若共線折返（沿同一線來回）也算自交
    const cAdj = P[(i + 2) % n];
    if (interiorOnSeg(a, b, cAdj) || interiorOnSeg(b, cAdj, a)) return true;
    for (let j = i + 1; j < n; j++) {
      if (j === (i + 1) % n || i === (j + 1) % n) continue;
      if (segsHit(a, b, P[j], P[(j + 1) % n])) return true;
    }
  }
  return false;
}


// 驗證 form 結構（匯入/套用前）→ { ok, error }
export function validateForm(form) {
  if (!form || typeof form !== 'object' || !Array.isArray(form.elements))
    return { ok:false, error:'form 結構無效' };
  const fx = form.fixture;
  if (!fx || !isFinite(Number(fx.u)) || !isFinite(Number(fx.d)))
    return { ok:false, error:'光源掛點座標無效' };
  for (let i = 0; i < form.elements.length; i++) {
    const el = form.elements[i], tag = `元件 ${i + 1}`;
    if (!el || !el.path) return { ok:false, error:`${tag} 缺少 path` };
    if (el.reflect != null && !(el.reflect >= 0 && el.reflect <= 1)) return { ok:false, error:`${tag} 反光係數超界` };
    if (el.transparency != null && !(el.transparency >= 0 && el.transparency <= 1)) return { ok:false, error:`${tag} 透光度超界` };
    if (el.kind === 'polygon') {
      const g = validateCustomPoints(el.path.points);
      if (!g.ok) return { ok:false, error:`${tag}（多邊形）：${g.error}` };
    } else if (el.path.kind === 'arc') {
      const a = el.path;
      if (!a.center || ![a.center.u, a.center.d, a.radius, a.startDeg, a.sweepDeg].every(v => isFinite(Number(v))) || a.radius <= 0)
        return { ok:false, error:`${tag}（弧）參數無效` };
    } else {
      const pts = el.path.points;
      if (!Array.isArray(pts) || pts.length < 2) return { ok:false, error:`${tag} 折線至少需 2 點` };
      if (pts.some(p => !isFinite(Number(p.u)) || !isFinite(Number(p.d)))) return { ok:false, error:`${tag} 座標含非數值` };
      if (el.thickness != null && !(el.thickness > 0)) return { ok:false, error:`${tag} 厚度需 > 0` };
    }
  }
  return { ok:true };
}

export function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; }
// 由世界方向還原發光角（與 drawRays 慣例一致：cdx=sign·sin, cdy=cos）
export const dirToEmissionRad = (dx, dy, sign) => Math.atan2(sign * dx, dy);
// 光源角度分佈權重 w(rad)，已正規化 ∫w=1（單位 1/rad）
export function emissionWeight(rad, src, dist) {
  const dd = angDiff(rad, src.axisRad);
  if (Math.abs(dd) > src.halfR + 1e-9) return 0;           // 發光範圍外
  if (dist === 'uniform') return src.halfR > 1e-9 ? 1 / (2 * src.halfR) : 0;
  const hc = Math.min(src.halfR, Math.PI / 2);             // lambert：cos(相對主軸)
  const Z = 2 * Math.sin(hc);                              // 正規化常數
  return Z > 1e-9 ? Math.max(0, Math.cos(dd)) / Z : 0;
}

// 點到線段最短距離
export function distPointSeg(px, py, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - s.ax) * dx + (py - s.ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
}
// 線段等分為子段（每段約 targetLen）
export function splitSegment(ax, ay, bx, by, targetLen) {
  const L = Math.hypot(bx - ax, by - ay), n = Math.max(1, Math.round(L / targetLen)), out = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n, t1 = (i + 1) / n;
    out.push({ ax: ax + (bx - ax) * t0, ay: ay + (by - ay) * t0, bx: ax + (bx - ax) * t1, by: ay + (by - ay) * t1 });
  }
  return out;
}

// Hottel 交叉弦線：F_{p→q}（僅幾何，未含遮蔽/朝向）
export function crossedStringsFF(p, q) {
  const d00 = Math.hypot(p.ax - q.ax, p.ay - q.ay), d01 = Math.hypot(p.ax - q.bx, p.ay - q.by);
  const d10 = Math.hypot(p.bx - q.ax, p.by - q.ay), d11 = Math.hypot(p.bx - q.bx, p.by - q.by);
  const G = Math.abs((d01 + d10) - (d00 + d11));           // |交叉 − 未交叉|
  return Math.max(0, Math.min(1, G / (2 * p.len)));
}

// Jacobi 求解反射射出度 B_i = ρ_i·E0_i + ρ_i·Σ_j F_ij·B_j（B0=0 → 單調收斂）
export function solveRadiosity(patches, F, E0) {
  const N = patches.length, B = new Float64Array(N), Bn = new Float64Array(N), D = new Float64Array(N);
  let maxRho = 0;
  for (let i = 0; i < N; i++) { D[i] = patches[i].rho * E0[i]; if (patches[i].rho > maxRho) maxRho = patches[i].rho; }
  const maxIter = maxRho <= 0.85 ? 80 : (maxRho <= 0.95 ? 160 : 250);
  for (let it = 0; it < maxIter; it++) {
    let delta = 0, scale = 1;
    for (let i = 0; i < N; i++) {
      const Fi = F[i]; let s = 0;
      for (let j = 0; j < N; j++) s += Fi[j] * B[j];
      const v = D[i] + patches[i].rho * s;
      Bn[i] = v; const d = Math.abs(v - B[i]); if (d > delta) delta = d; if (Math.abs(v) > scale) scale = Math.abs(v);
    }
    B.set(Bn);
    if (delta <= Math.max(0.01, 1e-5 * scale)) break;
  }
  return B;
}

// 量測點(法線 n)→patch 的點-線段形狀因子 F = ½(sinθ_hi − sinθ_lo)，裁切至前半球。
// 角度以「相對法線」量測；直線段對外點張角恆 <π，故 |Δ|>π 表示跨背面分支（在背半球）→ 0。
export function pointToSegFF(px, py, nx, ny, p) {
  const nAng = Math.atan2(ny, nx);
  const b0 = angDiff(Math.atan2(p.ay - py, p.ax - px), nAng);
  const b1 = angDiff(Math.atan2(p.by - py, p.bx - px), nAng);
  if (Math.abs(b1 - b0) > Math.PI) return 0;                 // 跨背面分支→背半球
  let lo = Math.max(Math.min(b0, b1), -Math.PI / 2), hi = Math.min(Math.max(b0, b1), Math.PI / 2);
  if (hi <= lo) return 0;                                     // 完全在前半球之外
  return 0.5 * (Math.sin(hi) - Math.sin(lo));
}

// 驗證光源形式 → { ok, error }
export function validateLight(L) {
  if (!L || typeof L !== 'object') return { ok:false, error:'光源結構無效' };
  for (const k of ['emissionAngle', 'rotationAngle', 'lightKelvin', 'lightIntensity'])
    if (!isFinite(Number(L[k]))) return { ok:false, error:`光源參數 ${k} 無效` };
  const fx = L.fixture;
  if (!fx || !isFinite(Number(fx.u)) || !isFinite(Number(fx.d))) return { ok:false, error:'光源掛點座標無效' };
  return { ok:true };
}

// 精簡格式 ILS1：JSON → UTF-8 → deflate-raw → base64，加前綴。可讀性換取體積（約少 6~8 成）。
export const COMPACT_PREFIX = 'ILS1:';
export async function encodeCompact(obj) {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const cs = new CompressionStream('deflate-raw');
  const w = cs.writable.getWriter(); w.write(bytes); w.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = ''; for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return COMPACT_PREFIX + btoa(bin);
}
export async function decodeCompact(text) {
  const bin = atob(text.slice(COMPACT_PREFIX.length).trim());
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream('deflate-raw');
  const w = ds.writable.getWriter(); w.write(bytes); w.close();
  return new TextDecoder().decode(await new Response(ds.readable).arrayBuffer());
}
