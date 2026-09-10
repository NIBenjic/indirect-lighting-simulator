/**
 * main.js — 間接照明模擬器 (純 2D Canvas)
 *
 * 座標系：x=0 左牆，x=W 右牆；y=0 地板，y=H 天花板
 * 左側燈槽：從 x=0 延伸 depth 入室，擋板在 x=depth
 * 右側燈槽：從 x=W 延伸 depth 入室，擋板在 x=W-depth
 */
import {
  COMPACT_PREFIX,
  THICK,
  angDiff,
  clamp,
  crossedStringsFF,
  decodeCompact,
  dirToEmissionRad,
  distPointSeg,
  emissionWeight,
  encodeCompact,
  kelvinToColor,
  pointToSegFF,
  solveRadiosity,
  splitSegment,
  validateForm,
  validateLight,
} from './core.js';
import {
  analyzeGlareBox,
  hitIsFixture,
  inGlareBox,
  segmentOccluded,
} from './glare.js';
import {
  TEMPLATES,
  TEMPLATE_LABELS,
  arcEndpoints,
  arcPoints,
  compileForm,
  elementCenterline,
  makeFormFromTemplate,
} from './geometry.js';

// ══ 全域狀態 ══════════════════════════════════════════════════════
// 長度單位內部一律以「公尺」儲存；UI 以 mm 顯示，於繫結層換算。
const S = {
  room:  { W: 8, H: 3 },
  cove: {
    // 燈槽形式（唯一真實來源）：面板清單 + 光源掛點。init 時以經典範本填入。
    form: null,
    // 光源：發光形式、顏色、與「作用中掛點位置」（與燈槽幾何完全分離；隨光源模板儲存）
    light: {
      emissionAngle: 180, rotationAngle: 0,
      lightKelvin: 3000, lightIntensity: 800,
      fixture: { u: 0.09, d: 0.20 },
    },
  },
  sides: { left: true, right: true },
  wallReflect: { left: true, right: true }, // 槽外主牆面是否反射（關閉＝光線完全穿透）
  refl:  { ceiling: 0.85, wall: 0.75, floor: 0.35 },
  ray:   { density: 20, bounces: 1 },
  eye:   { height: 1.65, xRatio: 0.50, show: true },
  glare: { width: 0.04, height: 0.04, hAnchor: 'wall', vAnchor: 'center' }, // 燈具裸露邊界（公尺）＋基準角
  // 指定點照度估算：燈帶每公尺光通量(lm/m)、發光分佈、受光面朝向、量測點清單(世界座標,公尺;結果內嵌)、放置模式旗標
  // 每點：{ x, y, result: { lux, direct, indirect } | null }；placing 不持久化
  illum: { lmPerM: 1000, dist: 'lambert', normal: 'up', points: [], placing: false },
  legendShow: true,
  theme: 'dark',
};


// 背景主題（深色 / 淺色）：僅影響背景與中性線條，語意化的射線/標示色不變
const THEMES = {
  dark:  { bg: '#0d1015', border: '#3a4248', eyeLine: 'rgba(255,255,255,0.15)' },
  light: { bg: '#eef1f4', border: '#9aa4ac', eyeLine: 'rgba(0,0,0,0.18)'      },
};
const theme = () => THEMES[S.theme] || THEMES.dark;

// 局部剖面座標 (u：自牆面向室內、d：自天花板向下) → 世界座標。
// 集中所有左右鏡像：左側 x=u、右側 x=W-u；y=H-d。
function toWorld(u, d, side, W, H) {
  return { x: side === 'L' ? u : W - u, y: H - d };
}

// 燈具裸露邊界（公尺）：以光源為錨，依水平/垂直基準延伸，再繞掛點隨自體旋轉。
//   hAnchor: 'wall' 靠牆（向室內延伸）/ 'center' 置中 / 'interior' 靠室內（向牆延伸）
//   vAnchor: 'top' 上（向下延伸）/ 'center' 置中 / 'bottom' 下（向上延伸）
// 回傳未旋轉 AABB (x0,x1,y0,y1) + 旋轉原點/角 + 世界座標四角。
function glareBox(lx, ly, side) {
  const gW = Math.max(0, S.glare.width), gH = Math.max(0, S.glare.height);
  const inward = side === 'L' ? 1 : -1;   // 朝室內的 x 方向
  let x0, x1;
  if (S.glare.hAnchor === 'center') { x0 = lx - gW / 2; x1 = lx + gW / 2; }
  else {
    const dir = (S.glare.hAnchor === 'wall' ? inward : -inward);
    x0 = Math.min(lx, lx + dir * gW); x1 = Math.max(lx, lx + dir * gW);
  }
  let y0, y1;
  if (S.glare.vAnchor === 'top')         { y0 = ly - gH; y1 = ly; }
  else if (S.glare.vAnchor === 'bottom') { y0 = ly;      y1 = ly + gH; }
  else                                   { y0 = ly - gH / 2; y1 = ly + gH / 2; }
  // 右側發光方向鏡像，框跟著轉（左 +θ、右 −θ）
  const phi = inward * (S.cove.light.rotationAngle || 0) * Math.PI / 180;
  const rot = (x, y) => {
    if (Math.abs(phi) < 1e-12) return { x, y };
    const dx = x - lx, dy = y - ly;
    const c = Math.cos(phi), s = Math.sin(phi);
    return { x: lx + dx * c - dy * s, y: ly + dx * s + dy * c };
  };
  const corners = [
    rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1),
  ];
  return { x0, x1, y0, y1, ox: lx, oy: ly, phi, corners };
}

// 光源顯示色：色相完全依色溫（與 kelvinToColor 一致），亮度僅影響
// 透明度與光暈大小，不改變色相。回傳 0–255 的 r8/g8/b8 與亮度因子 bf。
function lightDisplayColor() {
  const lc = kelvinToColor(S.cove.light.lightKelvin);
  const bf = clamp((S.cove.light.lightIntensity - 100) / (2000 - 100), 0, 1);
  return {
    r8: Math.round(lc.r * 255),
    g8: Math.round(lc.g * 255),
    b8: Math.round(lc.b * 255),
    bf,
  };
}

// ══ Canvas ════════════════════════════════════════════════════════
const canvas = document.getElementById('main-canvas');
const ctx    = canvas.getContext('2d');

function resizeCanvas() {
  const vp = document.getElementById('viewport');
  canvas.width  = vp.clientWidth  || (window.innerWidth - 280);
  canvas.height = vp.clientHeight || window.innerHeight;
  redraw();
}
window.addEventListener('resize', resizeCanvas);

// ══ 座標映射（含使用者縮放/平移）══════════════════════════════════
let _scale = 1, _ox = 0, _oy = 0;
let _zoom = 1, _panX = 0, _panY = 0;   // 使用者縮放倍率與平移量（螢幕像素）
let _scene = null;                     // 最近一次 buildScene 結果（供命中測試）
const ZOOM_MIN = 1, ZOOM_MAX = 12;

function setupCoords(CW, CH) {
  const { W, H } = S.room;
  const pL = 58, pR = 44, pT = 38, pB = 52;
  const baseScale = Math.max(0, Math.min((CW - pL - pR) / W, (CH - pT - pB) / H));
  const baseOx = pL + ((CW - pL - pR) - baseScale * W) / 2;
  const baseOy = pT + ((CH - pT - pB) - baseScale * H) / 2 + baseScale * H;
  // 以畫布中心為基準套用 zoom，再加上平移
  const cx = CW / 2, cy = CH / 2;
  _scale = baseScale * _zoom;
  _ox = cx + (baseOx - cx) * _zoom + _panX;
  _oy = cy + (baseOy - cy) * _zoom + _panY;
}

const mx = (x) => _ox + x * _scale;
const my = (y) => _oy - y * _scale;

// 限制平移：室內矩形必須始終覆蓋畫布中心，避免拖到全空白而迷失
function clampPan() {
  const CW = canvas.width, CH = canvas.height;
  setupCoords(CW, CH);
  const left = mx(0), right = mx(S.room.W);
  const top = my(S.room.H), bottom = my(0);
  const cx = CW / 2, cy = CH / 2;
  if (right < cx) _panX += cx - right; else if (left > cx) _panX += cx - left;
  if (bottom < cy) _panY += cy - bottom; else if (top > cy) _panY += cy - top;
  setupCoords(CW, CH);
}

// 以螢幕點 (sx,sy) 為焦點縮放（焦點下的內容維持不動）
function zoomAt(sx, sy, factor) {
  const CW = canvas.width, CH = canvas.height;
  setupCoords(CW, CH);
  const wx = (sx - _ox) / _scale, wy = (_oy - sy) / _scale;
  _zoom = clamp(_zoom * factor, ZOOM_MIN, ZOOM_MAX);
  if (_zoom === ZOOM_MIN) { _panX = 0; _panY = 0; }
  setupCoords(CW, CH);
  _panX += sx - (_ox + wx * _scale);
  _panY += sy - (_oy - wy * _scale);
  clampPan();
  redraw();
}

function resetView() { _zoom = 1; _panX = 0; _panY = 0; redraw(); }

// ══ 燈槽樣式產生器（回傳「局部剖面座標」幾何）══════════════════════
// 每個範本：(g) => form，g = 範本預設幾何參數（DEFAULT_GEOMETRY）
//   fillLoops: [{ fill, pts:[{u,d}...] }]      封閉多邊形，供繪製填色
//   faces:     [{ a:{u,d}, b:{u,d}, r, surf }] 物理碰撞線段（不含貼牆面，由牆面處理）
//   light:     { u, d }                        光源掛點
//   shield:    { candidates:[{u,d}...], taggedIdx, hasCutoff }  遮擋邊緣候選
// ══ 燈槽形式（form）→ 幾何編譯 ════════════════════════════════════
// form = { schema:'cove-form@2', elements:[ element ], fixture:{u,d} }
// element = { id, kind:'panel'|'polygon',
//             path:{kind:'polyline',points:[{u,d}...]} | {kind:'arc',center:{u,d},radius,startDeg,sweepDeg},
//             thickness, reflect(0-1), transparency(0-1), materialName, hidden }
// 'panel'：中心線 ±thickness/2 成厚片；'polygon'：封閉填色多邊形（不規則實體）。

// 將角度 a 加減 360 調到最接近 ref（連續拖曳避免跨 ±180 跳變）
function unwrapAngle(a, ref) {
  while (a - ref > 180) a -= 360;
  while (a - ref < -180) a += 360;
  return a;
}

// 初始化預設 form（經典）
S.cove.form = makeFormFromTemplate('classic');

// ══ 場景結構 ══════════════════════════════════════════════════════
// 局部幾何 → 世界座標 coveData（每側一份，鏡像集中於 toWorld）。
function makeCoveData(local, side, W, H, bottomY) {
  const segments = local.faces.map((f, i) => {
    const A = toWorld(f.a.u, f.a.d, side, W, H);
    const B = toWorld(f.b.u, f.b.d, side, W, H);
    const ex = B.x - A.x, ey = B.y - A.y;
    const len = Math.hypot(ex, ey) || 1;
    return { ax: A.x, ay: A.y, bx: B.x, by: B.y, r: f.r, transparency: f.transparency || 0,
             surf: f.surf, nx: -ey / len, ny: ex / len, id: side + i };
  });
  const loops = local.fillLoops.map(l => ({ id: l.id, fill: l.fill, transparency: l.transparency || 0, pts: l.pts.map(p => toWorld(p.u, p.d, side, W, H)) }));
  const lw = toWorld(local.light.u, local.light.d, side, W, H);
  const shield = {
    candidates: local.shield.candidates.map(p => toWorld(p.u, p.d, side, W, H)),
    taggedIdx: local.shield.taggedIdx,
    hasCutoff: local.shield.hasCutoff,
    silhouette: !!local.shield.silhouette,
  };
  return { segments, loops, light: { lx: lw.x, ly: lw.y }, shield, bottomY, side };
}

function buildScene() {
  const { W, H } = S.room;
  // 直接編譯使用者編輯中的 form；光源位置取自 S.cove.light.fixture（與燈槽分離）。
  const local = compileForm(S.cove.form || { elements: [], fixture: { u: 0.09, d: 0.20 } }, S.cove.light.fixture);
  // 牆面「槽內」分界：取貼牆材料延伸（compileForm 計算）。
  const bottomD = local.bottomD != null ? local.bottomD : 0.4;
  const bottomY = H - bottomD;
  return {
    W, H,
    leftCove:  S.sides.left  ? makeCoveData(local, 'L', W, H, bottomY) : null,
    rightCove: S.sides.right ? makeCoveData(local, 'R', W, H, bottomY) : null,
    refl: { ...S.refl },
    wallReflect: { ...S.wallReflect },
  };
}

// ══ Form 序列化（cove-form@2，僅燈槽幾何，與光源/室內解耦）══════════
function serializeForm() {
  const f = JSON.parse(JSON.stringify(S.cove.form));
  f.originRoomH = S.room.H;   // 非規範註記：匯出時室高，供人對照
  return f;
}

// 解析 form JSON → { ok, error, form }
function parseForm(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { ok:false, error:'JSON 格式錯誤：' + e.message }; }
  if (!obj || typeof obj !== 'object') return { ok:false, error:'不是有效的 JSON 物件' };
  // 舊格式 cove-profile@1 → 以對應範本概略轉換（不還原微調）
  if (obj.schema === 'cove-profile@1') {
    const tname = (obj.preset && obj.preset in TEMPLATES) ? obj.preset : 'classic';
    return { ok:true, form: makeFormFromTemplate(tname) };
  }
  if (obj.schema !== 'cove-form@2') return { ok:false, error:'不支援的 schema（需 cove-form@2）' };
  const v = validateForm(obj);
  if (!v.ok) return { ok:false, error: v.error };
  return { ok:true, form: { schema: 'cove-form@2', units: 'm', elements: obj.elements, fixture: obj.fixture,
    joints: Array.isArray(obj.joints) ? obj.joints : [] } };   // 保留相黏接點（失效者由 ensureUniqueIds 清理）
}

// 牆面反射屬性：燈槽範圍內（底板以上的槽後牆）一律照常反射；
// 燈槽範圍外（底板以下的主牆面）依該側開關決定——關閉時 pass=true（光線完全穿透）。
function wallProps(scene, side, yi) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  const inCove = cove && yi >= cove.bottomY;
  if (inCove) return { r: scene.refl.wall, pass: false };
  const on = side === 'L' ? scene.wallReflect.left : scene.wallReflect.right;
  return on ? { r: scene.refl.wall, pass: false } : { r: 0, pass: true };
}

// 牆面薄帶/邊框的可見下緣 y：牆面只在 [回傳值, H] 之間繪製。
// 反射開啟 → 整面牆（0）；反射關閉 → 僅燈槽範圍內（bottomY），無燈槽則整面消失（H）。
function wallVisibleBottom(scene, side) {
  const on = side === 'L' ? scene.wallReflect.left : scene.wallReflect.right;
  if (on) return 0;
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  return cove ? cove.bottomY : scene.H;
}

// ══ 射線交叉計算 ══════════════════════════════════════════════════
/**
 * 找最近交點，回傳 { x, y, surf, r } 或 null
 * surf: 'ceiling' | 'floor' | 'wallL' | 'wallR' | 'plate' | 'baffle'
 */
function findHit(ox, oy, dx, dy, scene, ignoreId) {
  const { W, H, refl } = scene;
  let tMin = Infinity, surf = null, r = 1, nx = 0, ny = 1, pass = false, hitId = null, transp = 0;

  // 反射用法向量 (hnx,hny)；反射公式 d'=d-2(d·n)n 與法向量正負號無關，
  // 故軸向面以 (0,1)/(1,0) 表示即可，等價於原本的水平/垂直翻轉。
  const try_ = (t, s, rv, hnx, hny, p = false, id = null, tr = 0) => {
    if (t > 1e-5 && t < tMin) { tMin = t; surf = s; r = rv; nx = hnx; ny = hny; pass = p; hitId = id; transp = tr; }
  };

  // 室內四面
  if (dy > 0) try_((H - oy) / dy, 'ceiling', refl.ceiling, 0, 1);
  if (dy < 0) try_(-oy / dy,       'floor',   refl.floor, 0, 1);
  if (dx < 0) {
    const t = -ox / dx, yi = oy + dy * t;
    if (yi >= 0 && yi <= H) { const w = wallProps(scene, 'L', yi); try_(t, 'wallL', w.r, 1, 0, w.pass); }
  }
  if (dx > 0) {
    const t = (W - ox) / dx, yi = oy + dy * t;
    if (yi >= 0 && yi <= H) { const w = wallProps(scene, 'R', yi); try_(t, 'wallR', w.r, 1, 0, w.pass); }
  }

  // 燈槽結構：通用射線 vs 線段（線段於 buildScene 依樣式產生，含反射率與法向量）
  const addCove = (cove) => {
    if (!cove) return;
    for (const sg of cove.segments) {
      if (sg.id === ignoreId) continue;                 // 跳過剛碰撞的線段，避免掠射重複命中
      const ex = sg.bx - sg.ax, ey = sg.by - sg.ay;
      const denom = dx * ey - dy * ex;
      if (Math.abs(denom) < 1e-12) continue;            // 平行
      const t  = ((sg.ax - ox) * ey - (sg.ay - oy) * ex) / denom;
      const sp = ((sg.ax - ox) * dy - (sg.ay - oy) * dx) / denom;
      if (sp >= 0 && sp <= 1) try_(t, sg.surf, sg.r, sg.nx, sg.ny, false, sg.id, sg.transparency);  // try_ 內含 t>1e-5
    }
  };

  addCove(scene.leftCove);
  addCove(scene.rightCove);

  if (!surf) return null;
  return { x: ox + dx * tMin, y: oy + dy * tMin, surf, r, nx, ny, pass, segId: hitId, transparency: transp };
}

// ══ 指定點照度估算（2D 線光源直接項 + 確定性 2D 輻射度間接項）═══════════════
// 假設：燈帶沿進深方向無限長且均勻（線光源 → 直接光 1/r 衰減）、所有表面為漫射
// (Lambertian)。2D 漫射關係：射出度 M=ρE、輝度 L=M/2，半球積分常數為 2（非 3D 的 π）。
// 間接光以邊界分段 + Hottel 交叉弦線形狀因子 + Jacobi 疊代求解（無蒙地卡羅噪訊、收斂穩定）。
// 輸出為此假設下的「估算」照度(lux)，非 DIALux/Relux 等 3D 光學工具替代品。
const NORMAL_VEC = { up: { x: 0, y: 1 }, down: { x: 0, y: -1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
// 由 (px,py) 朝光源(距離 r、單位方向 ux,uy)的可見度：沿途累乘透光面，遇不透光面歸零
function visibilityToSource(px, py, ux, uy, r, C) {
  let vis = 1, ox = px, oy = py, guard = 0;
  while (guard++ < 24) {
    const hit = findHit(ox, oy, ux, uy, C.scene, null);
    if (!hit) break;                                       // 朝光源無遮擋
    const dist = Math.hypot(hit.x - px, hit.y - py);
    if (dist >= r - 1e-3) break;                           // 命中在光源之外→不遮擋
    if (hit.pass) break;                                   // 穿牆（光源在室內，不視為遮擋）
    if (r - dist < 0.005 || hitIsFixture(hit, C.sources)) { // 燈具體積／貼源自遮擋
      ox = hit.x + ux * 1e-4; oy = hit.y + uy * 1e-4; continue;
    }
    if (hit.transparency > 0) { vis *= hit.transparency; if (vis < 1e-3) return 0; ox = hit.x + ux * 1e-4; oy = hit.y + uy * 1e-4; continue; }
    return 0;                                              // 不透光遮擋
  }
  return vis;
}
// 點 (px,py)、法線 (nx,ny) 的直接照度(lux)，累加各側光源
function directIlluminance(px, py, nx, ny, C) {
  let E = 0;
  for (const s of C.sources) {
    const vx = s.lx - px, vy = s.ly - py, r = Math.hypot(vx, vy);
    if (r < 1e-4) continue;
    const ux = vx / r, uy = vy / r;                        // P → 光源
    const cosInc = ux * nx + uy * ny;
    if (cosInc <= 0) continue;                             // 受光面背向
    const w = emissionWeight(dirToEmissionRad(-ux, -uy, s.sign), s, C.dist);
    if (w <= 0) continue;
    const vis = visibilityToSource(px, py, ux, uy, r, C);
    if (vis <= 0) continue;
    E += (C.lmPerM * w / r) * cosInc * vis;                // I(θ)=lmPerM·w；E=I/r·cosθ
  }
  return E;
}
// ── 2D 輻射度求解（漫射間接照度）─────────────────────────────────────
const RAD_ROOM_LEN = 0.075, RAD_COVE_LEN = 0.025, RAD_EPS = 1e-4;
// 任兩點之間可見度 [0,1]：沿途累乘透光面、遇不透光或穿牆歸零
function segVisibility(px, py, qx, qy, C) {
  const dx = qx - px, dy = qy - py, r = Math.hypot(dx, dy);
  if (r < 1e-6) return 1;
  const ux = dx / r, uy = dy / r;
  let vis = 1, ox = px, oy = py, guard = 0;
  while (guard++ < 24) {
    const hit = findHit(ox, oy, ux, uy, C.scene, null);
    if (!hit) return vis;
    if (Math.hypot(hit.x - px, hit.y - py) >= r - 1e-3) return vis;   // 抵達目標
    if (hit.pass) return 0;
    if (hit.transparency > 0) { vis *= hit.transparency; if (vis < 1e-3) return 0; ox = hit.x + ux * 1e-4; oy = hit.y + uy * 1e-4; continue; }
    return 0;
  }
  return vis;
}
// 建立房間邊界 patch（天花/地板/牆，牆依 wallProps；不透光燈槽雙面）
function buildRadiosityPatches(scene) {
  const { W, H } = scene, patches = [];
  // 房間 patch 邊長隨房間放大，使大房間的 patch 數（與 N² 求解）維持有界
  const roomLen = Math.max(RAD_ROOM_LEN, (W + H) / 200);
  const add = (ax, ay, bx, by, nx, ny, rho, kind) => {
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6 || rho <= 0) return;
    patches.push({ ax, ay, bx, by, cx: (ax + bx) / 2, cy: (ay + by) / 2, len, nx, ny, rho, kind });
  };
  for (const s of splitSegment(0, H, W, H, roomLen)) add(s.ax, s.ay, s.bx, s.by, 0, -1, scene.refl.ceiling, 'ceil');
  for (const s of splitSegment(0, 0, W, 0, roomLen)) add(s.ax, s.ay, s.bx, s.by, 0, 1, scene.refl.floor, 'floor');
  for (const side of ['L', 'R']) {
    const x = side === 'L' ? 0 : W, nx = side === 'L' ? 1 : -1;
    for (const s of splitSegment(x, 0, x, H, roomLen)) {
      const wp = wallProps(scene, side, (s.ay + s.by) / 2);
      if (wp.pass || wp.r <= 0) continue;                  // 開口/不反射→不建 patch（能量逸出）
      add(s.ax, s.ay, s.bx, s.by, nx, 0, wp.r, 'wall');
    }
  }
  for (const cove of [scene.leftCove, scene.rightCove]) {
    if (!cove) continue;
    for (const sg of cove.segments) {
      if ((sg.transparency || 0) > 1e-4 || (sg.r || 0) <= 0) continue;   // 透光/不反射→不建漫射 patch
      for (const s of splitSegment(sg.ax, sg.ay, sg.bx, sg.by, RAD_COVE_LEN)) {
        add(s.ax, s.ay, s.bx, s.by, sg.nx, sg.ny, sg.r, 'cove');         // 雙面（對應原 normalToward）
        add(s.ax, s.ay, s.bx, s.by, -sg.nx, -sg.ny, sg.r, 'cove');
      }
    }
  }
  return patches;
}
// patch 平均直接照度（沿段取樣；近光源加密以馴服 1/r 熱點）
function patchDirectIrradiance(p, C) {
  const near = C.sources.some(s => distPointSeg(s.lx, s.ly, p) < Math.max(0.15, 2 * p.len));
  const N = near ? 32 : 8;
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const t = (i + 0.5) / N;
    const x = p.ax + (p.bx - p.ax) * t + p.nx * RAD_EPS, y = p.ay + (p.by - p.ay) * t + p.ny * RAD_EPS;
    sum += directIlluminance(x, y, p.nx, p.ny, C);
  }
  return sum / N;
}
// 形狀因子矩陣（dense；含朝向閘與中點可見度；以互易填對稱項）
function buildFormFactors(patches, C) {
  const N = patches.length, F = Array.from({ length: N }, () => new Float64Array(N));
  for (let i = 0; i < N; i++) {
    const p = patches[i];
    for (let j = i + 1; j < N; j++) {
      const q = patches[j];
      const vx = q.cx - p.cx, vy = q.cy - p.cy;
      if (p.nx * vx + p.ny * vy <= 1e-8) continue;          // q 在 p 背面
      if (q.nx * -vx + q.ny * -vy <= 1e-8) continue;        // p 在 q 背面
      let f = crossedStringsFF(p, q);
      if (f <= 0) continue;
      const vis = segVisibility(p.cx + p.nx * RAD_EPS, p.cy + p.ny * RAD_EPS, q.cx + q.nx * RAD_EPS, q.cy + q.ny * RAD_EPS, C);
      if (vis <= 0) continue;
      f *= vis;
      F[i][j] = f;
      F[j][i] = f * p.len / q.len;                          // 互易：L_i F_ij = L_j F_ji
    }
  }
  return F;
}
// 於量測點收集間接照度：Σ B_i·F_(P→i)·可見度（patch 須面向量測點）
function gatherIndirect(px, py, nx, ny, patches, B, C) {
  let E = 0;
  for (let i = 0; i < patches.length; i++) {
    const p = patches[i];
    if (B[i] <= 0) continue;
    if (p.nx * (px - p.cx) + p.ny * (py - p.cy) <= 1e-8) continue;   // patch 反射面背向量測點
    const ff = pointToSegFF(px, py, nx, ny, p);
    if (ff <= 0) continue;
    const vis = segVisibility(px, py, p.cx + p.nx * RAD_EPS, p.cy + p.ny * RAD_EPS, C);
    if (vis <= 0) continue;
    E += B[i] * ff * vis;
  }
  return E;
}
// 輻射度解快取：幾何/光源/反射率簽章不變時，探針移動只重做收集
let _radCache = { sig: null, patches: null, B: null };
function radSignature(scene, sources, opt) {
  return JSON.stringify({
    W: scene.W, H: scene.H, refl: scene.refl, wr: scene.wallReflect,
    sides: [!!scene.leftCove, !!scene.rightCove], form: S.cove.form,
    src: sources.map(s => [s.lx, s.ly, s.sign, s.axisRad, s.halfR]),
    glare: S.glare, rot: S.cove.light.rotationAngle,
    dist: opt.dist, lm: opt.lmPerM,
  });
}
// 主入口：回傳 { lux, direct, indirect }
function computeIlluminance(scene, sources, opt) {
  const C = { scene, sources, lmPerM: opt.lmPerM, dist: opt.dist };
  const n = NORMAL_VEC[opt.normal] || NORMAL_VEC.up;
  const px = opt.px + n.x * RAD_EPS, py = opt.py + n.y * RAD_EPS;   // 微offset避免量測點落在表面自交
  const direct = directIlluminance(px, py, n.x, n.y, C);
  let indirect = 0;
  if (sources.length) {
    const sig = radSignature(scene, sources, opt);
    if (_radCache.sig !== sig) {
      const patches = buildRadiosityPatches(scene);
      const E0 = patches.map(p => patchDirectIrradiance(p, C));
      const F = buildFormFactors(patches, C);
      const B = solveRadiosity(patches, F, E0);
      _radCache = { sig, patches, B };
    }
    indirect = gatherIndirect(px, py, n.x, n.y, _radCache.patches, _radCache.B, C);
  }
  return { lux: direct + indirect, direct, indirect };
}
// 由場景組出光源清單（每個啟用側別一條燈帶；發光角/旋轉取自 S.cove.light）
function illumSources(scene) {
  const out = [];
  const half = (S.cove.light.emissionAngle / 2) * Math.PI / 180;
  const axis = S.cove.light.rotationAngle * Math.PI / 180;
  if (scene.leftCove)  out.push({ lx: scene.leftCove.light.lx,  ly: scene.leftCove.light.ly,  sign: 1,  axisRad: axis, halfR: half, box: glareBox(scene.leftCove.light.lx, scene.leftCove.light.ly, 'L') });
  if (scene.rightCove) out.push({ lx: scene.rightCove.light.lx, ly: scene.rightCove.light.ly, sign: -1, axisRad: axis, halfR: half, box: glareBox(scene.rightCove.light.lx, scene.rightCove.light.ly, 'R') });
  return out;
}
// 重算照度並更新面板（僅照度分頁啟用且已放置量測點時）：逐點計算，結果內嵌於各點
function recomputeIlluminance() {
  if (!S.illum.points.length) { renderIllumResult(); return; }   // 不分頁籤皆計算，使各分頁的 lux 標籤即時更新
  const scene = buildScene();
  const sources = illumSources(scene);
  let changed = false;
  for (const pt of S.illum.points) {
    const prev = pt.result ? pt.result.lux : null;   // 重輻射度解算以場景簽章快取，逐點僅重跑輕量 gather/direct
    pt.result = computeIlluminance(scene, sources, {
      px: pt.x, py: pt.y, normal: S.illum.normal,
      lmPerM: Math.max(0, S.illum.lmPerM), dist: S.illum.dist,
    });
    if (prev === null || Math.abs(pt.result.lux - prev) > 1e-6) changed = true;
  }
  renderIllumResult();
  // 結果改變時重繪畫布，讓量測點上的 lux 標籤與左側面板一致（值不變則不重繪，避免迴圈）
  if (changed) redraw();
}
let _illumTimer = null;
function scheduleIllum() { clearTimeout(_illumTimer); _illumTimer = setTimeout(recomputeIlluminance, 130); }
function renderIllumResult() {
  const el = document.getElementById('illum-result'); if (!el) return;
  if (!illumTabActive()) return;
  if (!S.illum.points.length) { el.textContent = '尚未放置量測點'; return; }
  const f = (v) => v >= 100 ? Math.round(v) : v.toFixed(1);
  el.innerHTML = S.illum.points.map((pt, i) => {
    const r = pt.result;
    const head = r
      ? `<span class="lux-big">${f(r.lux)}</span> lux`
      : `<span class="lux-big">…</span>`;
    const detail = r ? `<div class="sub">直接 ${f(r.direct)}　間接 ${f(r.indirect)}　lux</div>` : '';
    return `<div class="illum-pt">`
      + `<button class="illum-del" data-idx="${i}" title="刪除此量測點" aria-label="刪除量測點 ${i + 1}">✕</button>`
      + `<div class="sub">點 ${i + 1}</div>${head}${detail}`
      + `<div class="sub">點位 u${Math.round(pt.x * 1000)} / 高${Math.round(pt.y * 1000)} mm（自左下角）</div>`
      + `</div>`;
  }).join('');
}
// 照度量測點標記：十字 + 受光面法線箭頭 + 序號 + lux 標籤（所有分頁皆顯示）
function drawIlluminancePoints() {
  if (!S.illum.points.length) return;
  const n = NORMAL_VEC[S.illum.normal] || NORMAL_VEC.up;
  ctx.save();
  S.illum.points.forEach((p, i) => {
    if (!p) return;   // 防呆
    const sx = mx(p.x), sy = my(p.y);
    // 十字
    ctx.strokeStyle = 'rgba(120,230,160,0.95)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(sx - 8, sy); ctx.lineTo(sx + 8, sy); ctx.moveTo(sx, sy - 8); ctx.lineTo(sx, sy + 8); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, 5, 0, Math.PI * 2); ctx.stroke();
    // 受光面法線箭頭（朝 n 方向，螢幕 y 反向）
    const L = 26, ex = sx + n.x * L, ey = sy - n.y * L;
    ctx.strokeStyle = 'rgba(120,230,160,0.7)';
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
    const ah = Math.atan2(-(n.y), n.x);
    ctx.beginPath(); ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 5 * Math.cos(ah - 0.4), ey - 5 * Math.sin(ah - 0.4));
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - 5 * Math.cos(ah + 0.4), ey - 5 * Math.sin(ah + 0.4));
    ctx.stroke();
    // 序號（標記左下，所有分頁皆顯示，便於與面板清單對照）
    ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(190,240,205,0.95)'; ctx.fillText(String(i + 1), sx - 8, sy + 4);
    // lux 標籤（所有分頁）
    if (p.result) {
      const txt = `${p.result.lux >= 100 ? Math.round(p.result.lux) : p.result.lux.toFixed(1)} lux`;
      ctx.font = '11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      const w = ctx.measureText(txt).width + 8;
      ctx.fillStyle = 'rgba(20,28,36,0.92)'; ctx.strokeStyle = 'rgba(120,230,160,0.7)'; ctx.lineWidth = 1;
      ctx.fillRect(sx + 10, sy - 22, w, 16); ctx.strokeRect(sx + 10, sy - 22, w, 16);
      ctx.fillStyle = 'rgba(190,240,205,0.95)'; ctx.fillText(txt, sx + 14, sy - 8);
    }
  });
  ctx.restore();
}

// ══ 射線繪製 ══════════════════════════════════════════════════════
function drawRays(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;

  const { lx: lightX, ly: lightY } = cove.light;

  // 發光範圍：不做幾何裁切，由射線與擋板/底板的碰撞自然決定遮蔽，
  // 因此自體旋轉可朝任意方向（含水平線以下）。
  const raw  = S.cove.light.rotationAngle;
  const half = S.cove.light.emissionAngle / 2;
  const effMin = raw - half;
  const effMax = raw + half;

  const n  = Math.max(2, S.ray.density);
  // 射線顏色隨色溫（色相）與亮度（明度/不透明度）變化，並依反光係數逐次衰減。
  const { r8, g8, b8, bf } = lightDisplayColor();
  const baseAlpha = Math.min(0.78, 0.18 + bf * 0.60);

  ctx.lineWidth = 1;
  for (let i = 0; i < n; i++) {
    const θ   = n === 1 ? (effMin + effMax) / 2 : effMin + i * (effMax - effMin) / (n - 1);
    const rad = θ * Math.PI / 180;
    // 左側往右（+x）；右側往左（-x）
    const sign = side === 'L' ? 1 : -1;
    let cdx = sign * Math.sin(rad), cdy = Math.cos(rad);
    let cox = lightX, coy = lightY, alpha = baseAlpha, lastId = null;

    for (let b = 0; b <= S.ray.bounces; b++) {
      const hit = findHit(cox, coy, cdx, cdy, scene, lastId);
      if (!hit) break;

      // 槽外牆面反射關閉 → 光線完全穿透牆面、沿原方向射出室外後結束
      if (hit.pass) {
        const far = (scene.W + scene.H) * 3;
        ctx.beginPath();
        ctx.moveTo(mx(cox), my(coy));
        ctx.lineTo(mx(cox + cdx * far), my(coy + cdy * far));
        ctx.strokeStyle = `rgba(${r8},${g8},${b8},${alpha.toFixed(3)})`;
        ctx.stroke();
        break;
      }

      ctx.beginPath();
      ctx.moveTo(mx(cox), my(coy));
      ctx.lineTo(mx(hit.x), my(hit.y));
      ctx.strokeStyle = `rgba(${r8},${g8},${b8},${alpha.toFixed(3)})`;
      ctx.stroke();

      if (b === S.ray.bounces) break;

      // 半透光/透光面：沿原方向穿透、依透光度衰減（單一行為，不分裂）。
      if (hit.transparency > 0) {
        alpha *= hit.transparency;
        if (alpha < 0.012) break;
        cox = hit.x + cdx * 1e-4;
        coy = hit.y + cdy * 1e-4;
        lastId = hit.segId;
        continue;
      }

      alpha *= hit.r;          // 不透光：依反光係數衰減後反射
      if (alpha < 0.012) break;

      // 反射方向：沿碰撞面法向量鏡射 d' = d - 2(d·n)n（支援斜面/曲面）。
      // 軸向面的 (0,1)/(1,0) 法向量等價於原本的水平/垂直翻轉。
      const dot = cdx * hit.nx + cdy * hit.ny;
      cdx = cdx - 2 * dot * hit.nx;
      cdy = cdy - 2 * dot * hit.ny;
      cox = hit.x + cdx * 1e-4;
      coy = hit.y + cdy * 1e-4;
      lastId = hit.segId;       // 下一步忽略剛碰撞的線段（掠射防重複命中）
    }
  }
}

// ══ 燈槽幾何繪製 ══════════════════════════════════════════════════
// 依 coveData.loops（封閉多邊形，世界座標）填色，樣式無關。
function drawCoveGeo(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  for (const loop of cove.loops) {
    // 透明度 → 填色不透明度（所見即所透）；半透光面板較淡。
    const op = 1 - (loop.transparency || 0);
    ctx.globalAlpha = Math.max(0.06, op);   // 編輯/檢視仍保留最低可見度
    ctx.fillStyle = loop.fill;
    ctx.beginPath();
    loop.pts.forEach((p, i) => {
      const X = mx(p.x), Y = my(p.y);
      if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y);
    });
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// 取遮擋邊緣（世界座標）。回傳 { x, y, hasCutoff }。
//   非 silhouette：直接取標記角。
//   silhouette：取「最高（最接近天花板）」的不透光材料邊角作為開口遮擋緣；
//   同高時取最朝室內者（最易暴露光源）。不論該角在光源上下皆適用——光源高於
//   遮擋緣即為眩光情形（視線遮擋分析於 analyzeSide）。
//   註：v1 啟發式，對極複雜剖面非嚴格精確，僅供參考。
function getShieldPoint(cove, side, lightX, lightY) {
  const sh = cove.shield;
  const cands = sh.candidates || [];
  if (!cands.length) return { x: 0, y: 0, hasCutoff: false };
  if (!sh.silhouette) {
    const p = cands[sh.taggedIdx] || cands[0];
    return { x: p.x, y: p.y, hasCutoff: !!sh.hasCutoff };
  }
  const inward = side === 'L' ? 1 : -1;
  let best = cands[0];
  for (const p of cands) {
    if (p.y > best.y + 1e-6) best = p;                          // 更高（世界 y 大 = 近天花板）
    else if (Math.abs(p.y - best.y) < 1e-6 && inward * (p.x - best.x) > 0) best = p; // 同高取更朝室內（最易暴露光源）
  }
  return { x: best.x, y: best.y, hasCutoff: !!sh.hasCutoff };
}

// 局部座標軸（牆-天花板角原點 + u→/d↓ + 100mm 刻度）；燈槽與光源分頁共用
function drawLocalAxes(scene, side) {
  const { W, H } = scene;
  const ox = mx(side === 'L' ? 0 : W), oy = my(H);
  const inward = side === 'L' ? 1 : -1;
  const wallX = side === 'L' ? 0 : W;
  const axisLen = 0.3;
  ctx.save();
  ctx.strokeStyle = 'rgba(120,170,255,0.30)';
  ctx.fillStyle = 'rgba(140,185,255,0.75)';
  ctx.lineWidth = 1;
  ctx.font = '9px system-ui, sans-serif';
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(mx(inward * axisLen + wallX), oy); ctx.stroke();   // u 軸
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, my(H - axisLen)); ctx.stroke();                  // d 軸
  for (let t = 0.1; t <= axisLen + 1e-6; t += 0.1) {                                                    // 100mm 刻度
    const ux = mx(inward * t + wallX);
    ctx.beginPath(); ctx.moveTo(ux, oy); ctx.lineTo(ux, oy - 3); ctx.stroke();
    const dy = my(H - t);
    ctx.beginPath(); ctx.moveTo(ox, dy); ctx.lineTo(ox + inward * 3, dy); ctx.stroke();
  }
  ctx.textAlign = side === 'L' ? 'left' : 'right';
  ctx.fillText('u→', mx(inward * (axisLen - 0.04) + wallX), oy - 5);
  ctx.fillText('d↓ (mm，自牆-頂角)', ox + inward * 5, my(H - axisLen) + 2);
  ctx.restore();
}

// 燈槽分頁編輯輔助：座標軸 + 選取高亮 + 頂點/相黏把手（不含光源；光源在光源分頁）
function drawEditorOverlay(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const { W, H } = scene;
  drawLocalAxes(scene, side);

  // 半透光面板：以斜線網點標示（編輯時讓「透光」與單純「淡色」可區分）
  for (const loop of cove.loops) {
    if ((loop.transparency || 0) <= 0.001) continue;
    ctx.save();
    ctx.beginPath();
    loop.pts.forEach((p, i) => { const X = mx(p.x), Y = my(p.y); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); });
    ctx.closePath(); ctx.clip();
    const xs = loop.pts.map(p => mx(p.x)), ys = loop.pts.map(p => my(p.y));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), span = y1 - y0;
    ctx.strokeStyle = 'rgba(170,205,255,0.30)'; ctx.lineWidth = 1;
    for (let x = x0 - span; x < x1; x += 5) { ctx.beginPath(); ctx.moveTo(x, y1); ctx.lineTo(x + span, y0); ctx.stroke(); }
    ctx.restore();
  }

  // 僅選取元件：高亮外框（compiled outline）
  const selLoop = cove.loops.find(l => l.id === selectedElementId);
  if (selLoop) {
    ctx.save();
    ctx.beginPath();
    selLoop.pts.forEach((p, i) => { const X = mx(p.x), Y = my(p.y); if (i === 0) ctx.moveTo(X, Y); else ctx.lineTo(X, Y); });
    ctx.closePath();
    ctx.strokeStyle = 'rgba(80,200,255,0.95)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
  }
  // 相黏頂點：所有可見元件的相黏點畫外圈光環（標示接點網路）
  ctx.save();
  ctx.strokeStyle = 'rgba(120,255,180,0.8)'; ctx.lineWidth = 1.5;
  for (const el of S.cove.form.elements) {
    if (el.hidden || el.path.kind === 'arc') continue;
    for (const p of el.path.points) if (isBonded(el.id, p.pid)) { const w = toWorld(p.u, p.d, side, W, H); ctx.beginPath(); ctx.arc(mx(w.x), my(w.y), 6, 0, Math.PI * 2); ctx.stroke(); }
  }
  ctx.restore();

  // 頂點/端點把手：折線/多邊形畫每個路徑點；弧線畫兩端點（拖曳調整角度）+ 圓心
  const selEl = S.cove.form.elements.find(e => e.id === selectedElementId);
  if (selEl && !selEl.hidden) {
    ctx.save();
    ctx.fillStyle = 'rgba(80,200,255,0.95)'; ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1;
    if (selEl.path.kind === 'arc') {
      for (const p of arcEndpoints(selEl.path)) { const w = toWorld(p.u, p.d, side, W, H); ctx.beginPath(); ctx.rect(mx(w.x) - 4, my(w.y) - 4, 8, 8); ctx.fill(); ctx.stroke(); }
      const c = toWorld(selEl.path.center.u, selEl.path.center.d, side, W, H);   // 圓心（小十字，僅標示）
      ctx.strokeStyle = 'rgba(80,200,255,0.6)';
      ctx.beginPath(); ctx.moveTo(mx(c.x) - 4, my(c.y)); ctx.lineTo(mx(c.x) + 4, my(c.y)); ctx.moveTo(mx(c.x), my(c.y) - 4); ctx.lineTo(mx(c.x), my(c.y) + 4); ctx.stroke();
    } else {
      for (const p of selEl.path.points) { const w = toWorld(p.u, p.d, side, W, H); ctx.beginPath(); ctx.rect(mx(w.x) - 4, my(w.y) - 4, 8, 8); ctx.fill(); ctx.stroke(); }
    }
    ctx.restore();
  }
  // （光源掛點不在燈槽分頁顯示／編輯；請至「光源」分頁）

  // 拖曳吸附中：高亮目標頂點（放開即相黏）
  if (dragState && dragState.snap) {
    const w = toWorld(dragState.snap.u, dragState.snap.d, side, W, H);
    ctx.save();
    ctx.strokeStyle = 'rgba(120,255,180,1)'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(mx(w.x), my(w.y), 9, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

// 光源分頁：座標軸 + 可拖曳的光源掛點把手（實心橙圓）+ u/d 讀數
function drawFixtureHandle(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  drawLocalAxes(scene, side);
  const fx = S.cove.light.fixture, hx = mx(cove.light.lx), hy = my(cove.light.ly);   // 讀數取作用中光源掛點（與把手位置一致）
  ctx.save();
  ctx.fillStyle = 'rgba(255,200,80,0.95)'; ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(hx, hy, 6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(255,210,120,0.95)'; ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`u ${Math.round(fx.u * 1000)}, d ${Math.round(fx.d * 1000)} mm`, hx + 9, hy - 7);
  ctx.restore();
}

// 拖曳時的座標徽章（螢幕座標）
function drawDragBadge() {
  if (!dragBadge) return;
  const txt = dragBadge.text || '';
  ctx.save();
  ctx.font = '11px system-ui, sans-serif';
  const w = ctx.measureText(txt).width + 10;
  const bx = dragBadge.sx + 12, by = dragBadge.sy - 24;
  ctx.fillStyle = 'rgba(20,28,36,0.92)'; ctx.strokeStyle = 'rgba(80,200,255,0.7)'; ctx.lineWidth = 1;
  ctx.fillRect(bx, by, w, 18); ctx.strokeRect(bx, by, w, 18);
  ctx.fillStyle = 'rgba(200,230,255,0.95)'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  ctx.fillText(txt, bx + 5, by + 9);
  ctx.restore();
}

// ── 遮光截止角虛線（光源向上、經實際掠射點延伸至天花）────────────────
function firstOpaqueToward(ox, oy, tx, ty, scene, box) {
  const dx = tx - ox, dy = ty - oy;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len, uy = dy / len;
  let x = ox, y = oy, guard = 0;
  while (guard++ < 24) {
    const hit = findHit(x, y, ux, uy, scene, null);
    if (!hit || hit.pass) return null;
    if (inGlareBox(hit.x, hit.y, box) || (hit.transparency || 0) > 0) {
      x = hit.x + ux * 1e-4;
      y = hit.y + uy * 1e-4;
      continue;
    }
    return hit;
  }
  return null;
}

function drawCriticalAngle(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const { H, W } = scene;
  const { lx: lightX, ly: lightY } = cove.light;
  const box = glareBox(lightX, lightY, side);
  const inward = side === 'L' ? 1 : -1;
  // 只取「在光源之上、朝室內」且光線先碰到該點的頂點，避免把底板近牆高角
  // 或斜向燈具外輪廓的隨機高點當成天花截止角。
  const cands = (cove.shield.candidates || []).filter(p =>
    p.y > lightY + 1e-4 && inward * (p.x - lightX) > 1e-4);
  let best = null;
  for (const p of cands) {
    const hit = firstOpaqueToward(lightX, lightY, p.x, p.y, scene, box);
    if (!hit) continue;
    if (Math.hypot(hit.x - p.x, hit.y - p.y) > 0.02) continue;
    const ddx = p.x - lightX, ddy = p.y - lightY;
    const len = Math.hypot(ddx, ddy);
    if (len < 1e-6 || ddy <= 1e-6) continue;
    const nx = ddx / len, ny = ddy / len;
    const tCeil = (H - p.y) / ny;
    if (tCeil <= 0) continue;
    const xEnd = p.x + nx * tCeil;
    const wallDist = side === 'L' ? xEnd : W - xEnd;
    if (!best || wallDist < best.wallDist) best = { p, xEnd, wallDist };
  }
  if (!best) return;

  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = `rgba(255,170,0,0.45)`;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(mx(lightX), my(lightY));
  ctx.lineTo(mx(best.p.x), my(best.p.y));
  ctx.lineTo(mx(best.xEnd), my(H));
  ctx.stroke();
  ctx.restore();
}

// ── 光源光暈 ────────────────────────────────────────────────────
function drawLightDot(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const { lx, ly } = cove.light;
  // 光暈顏色隨色溫/亮度，光暈大小亦隨亮度增大。
  const { r8, g8, b8, bf } = lightDisplayColor();
  const glowR = Math.min(34, _scale * (0.16 + 0.20 * bf));
  const grd = ctx.createRadialGradient(mx(lx), my(ly), 0, mx(lx), my(ly), glowR);
  grd.addColorStop(0,    `rgba(${r8},${g8},${b8},1)`);
  grd.addColorStop(0.5,  `rgba(${r8},${g8},${b8},0.28)`);
  grd.addColorStop(1,    `rgba(${r8},${g8},${b8},0)`);
  ctx.fillStyle = grd;
  ctx.beginPath(); ctx.arc(mx(lx), my(ly), glowR, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = `rgb(${r8},${g8},${b8})`;
  ctx.beginPath(); ctx.arc(mx(lx), my(ly), 3.5, 0, Math.PI * 2); ctx.fill();
}

// ── 燈具裸露邊界框（眩光判定範圍）─────────────────────────────────
function drawGlareBox(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const gW = Math.max(0, S.glare.width), gH = Math.max(0, S.glare.height);
  if (gW <= 0 && gH <= 0) return;
  const { lx, ly } = cove.light;
  const box = glareBox(lx, ly, side);
  const pts = box.corners;
  if (!pts || pts.length < 2) return;
  const { r8, g8, b8 } = lightDisplayColor();
  ctx.save();
  ctx.fillStyle = `rgba(${r8},${g8},${b8},0.16)`;
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = `rgba(${r8},${g8},${b8},0.7)`;
  ctx.beginPath();
  ctx.moveTo(mx(pts[0].x), my(pts[0].y));
  for (let i = 1; i < pts.length; i++) ctx.lineTo(mx(pts[i].x), my(pts[i].y));
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// 眩光框縮放把手（世界座標）。回傳每個把手的 {kind, x, y, sH, sV}：
//   sH/sV＝該把手所在邊的「朝外符號」（0＝該軸不調整）。
// 置中基準的軸：兩側邊皆可調整（各給一個把手＋對應角點）；單向基準：只給可動的遠邊。
function glareHandles(side) {
  const { W, H } = S.room;
  const fx = S.cove.light.fixture;
  const lw = toWorld(fx.u, fx.d, side, W, H);
  const b = glareBox(lw.x, lw.y, side);
  const xMid = (b.x0 + b.x1) / 2, yMid = (b.y0 + b.y1) / 2;
  const inward = side === 'L' ? 1 : -1;
  const hCenter = S.glare.hAnchor === 'center', vCenter = S.glare.vAnchor === 'center';
  let xEdges, yEdges;
  if (hCenter) xEdges = [ { x: b.x1, s: 1 }, { x: b.x0, s: -1 } ];
  else { const dir = (S.glare.hAnchor === 'wall' ? inward : -inward); xEdges = [ { x: lw.x + dir * Math.max(0, S.glare.width), s: dir } ]; }
  if (vCenter) yEdges = [ { y: b.y1, s: 1 }, { y: b.y0, s: -1 } ];
  else if (S.glare.vAnchor === 'top') yEdges = [ { y: b.y0, s: -1 } ];
  else yEdges = [ { y: b.y1, s: 1 } ];   // bottom：向上延伸
  const phi = b.phi || 0;
  const rot = (x, y) => {
    if (Math.abs(phi) < 1e-12) return { x, y };
    const dx = x - lw.x, dy = y - lw.y;
    const c = Math.cos(phi), s = Math.sin(phi);
    return { x: lw.x + dx * c - dy * s, y: lw.y + dx * s + dy * c };
  };
  const out = [];
  for (const xe of xEdges) { const p = rot(xe.x, yMid); out.push({ kind: 'glareW', x: p.x, y: p.y, sH: xe.s, sV: 0 }); }
  for (const ye of yEdges) { const p = rot(xMid, ye.y); out.push({ kind: 'glareH', x: p.x, y: p.y, sH: 0, sV: ye.s }); }
  for (const xe of xEdges) for (const ye of yEdges) {
    const p = rot(xe.x, ye.y);
    out.push({ kind: 'glareWH', x: p.x, y: p.y, sH: xe.s, sV: ye.s });
  }
  return { lx: lw.x, ly: lw.y, handles: out, phi };
}
// 眩光框縮放把手（僅「視角」分頁顯示/可拖曳）
function drawGlareHandles(scene, side) {
  const cove = side === 'L' ? scene.leftCove : scene.rightCove;
  if (!cove) return;
  const { r8, g8, b8 } = lightDisplayColor();
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5;
  ctx.fillStyle = `rgba(${r8},${g8},${b8},0.95)`;
  for (const hd of glareHandles(side).handles) {
    const r = hd.kind === 'glareWH' ? 5 : 4;
    ctx.beginPath(); ctx.rect(mx(hd.x) - r, my(hd.y) - r, r * 2, r * 2); ctx.fill(); ctx.stroke();
  }
  ctx.restore();
}

// ══ 眩光分析 ══════════════════════════════════════════════════════
/**
 * 分析單側燈槽在指定眼高的眩光狀況。
 * 對燈具裸露邊界四個角沿眼高線做實際視線遮擋測試（非「最高角」啟發式），
 * 找隱藏↔可見轉換點。回傳的 baffleX/baffleTop 為繪圖用的實際掠射點。
 * status:
 *   'shielded'  完全遮蔽（室內任何距離都看不到光源）
 *   'allGlare'  全區可見
 *   'safeNear'  近牆安全、超過 xGraze 後可見光源
 *   'safeFar'   遠處安全、未達 xGraze 時可見光源
 */
function makeGlareOccluded(scene, box) {
  return (ax, ay, bx, by) => segmentOccluded(
    ax, ay, bx, by,
    (ox, oy, dx, dy) => findHit(ox, oy, dx, dy, scene, null),
    { skipHit: (hit) => inGlareBox(hit.x, hit.y, box) },
  );
}

function analyzeSide(scene, cove, side, eyeH) {
  const { W } = scene;
  const { lx: lightX, ly: lightY } = cove.light;
  const box = glareBox(lightX, lightY, side);
  const occluded = makeGlareOccluded(scene, box);
  const r = analyzeGlareBox(box, eyeH, side, W, occluded);

  let baffleX = r.lightX, baffleTop = r.lightY;
  if (r.xGraze != null) {
    const hit = firstOpaqueToward(r.lightX, r.lightY, r.xGraze, eyeH, scene, box);
    if (hit) { baffleX = hit.x; baffleTop = hit.y; }
  } else {
    const sp = getShieldPoint(cove, side, lightX, lightY);
    baffleX = sp.x; baffleTop = sp.y;
  }
  return { ...r, baffleX, baffleTop };
}

// ══ 眼睛視角 / 安全距離 ═══════════════════════════════════════════
function drawEye(scene) {
  if (!S.eye.show) return;
  const { W } = scene;
  const eyeX = S.eye.xRatio * W;
  const eyeH = S.eye.height;
  const ex = mx(eyeX), ey = my(eyeH);

  // 眼高水平虛線
  ctx.save();
  ctx.setLineDash([5, 6]);
  ctx.strokeStyle = theme().eyeLine;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(mx(0), ey); ctx.lineTo(mx(W), ey); ctx.stroke();
  ctx.restore();

  const infos = [];

  for (const [cove, side] of [[scene.leftCove, 'L'], [scene.rightCove, 'R']]) {
    if (!cove) continue;
    const a   = analyzeSide(scene, cove, side, eyeH);
    const tag = side === 'L' ? '左側' : '右側';

    // 觀察者目前位置是否直視光源（實際視線，非單點啟發式）
    const occluded = makeGlareOccluded(scene, a.box);
    const seen = !occluded(eyeX, eyeH, a.lightX, a.lightY);

    // 觀察者視線
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = seen ? 'rgba(255,70,70,0.7)' : 'rgba(60,200,60,0.55)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(mx(a.lightX), my(a.lightY));
    ctx.stroke();
    ctx.restore();

    // 安全距離臨界線（光源 → 擋板頂端 → 眼高交點）與刻度
    if (a.xGraze !== null && a.xGraze >= 0 && a.xGraze <= W) {
      const gx = mx(a.xGraze);
      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,170,0,0.6)';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(mx(a.lightX), my(a.lightY));
      ctx.lineTo(mx(a.baffleX), my(a.baffleTop));
      ctx.lineTo(gx, ey);
      ctx.stroke();
      ctx.restore();
      ctx.strokeStyle = 'rgba(255,170,0,0.85)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(gx, ey - 8); ctx.lineTo(gx, ey + 8); ctx.stroke();
      ctx.fillStyle = 'rgba(255,190,60,0.95)';
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const distMM = Math.round((side === 'L' ? a.xGraze : W - a.xGraze) * 1000);
      ctx.fillText(distMM + ' mm', gx, ey - 12);
      ctx.textAlign = 'left';
    }

    // 文字結論 — 安全距離不考慮室寬，直接回報臨界距離。
    let label, color;
    if (a.status === 'shielded') {
      label = `${tag}：完全遮蔽 ✓`; color = 'rgba(90,220,90,0.95)';
    } else if (a.status === 'allGlare') {
      label = `${tag}：全區可見光源 ⚠`; color = 'rgba(255,90,90,0.95)';
    } else {
      // 距牆距離（公尺）；不夾在 [0, W] 內，超出室寬仍照實回報。
      const dist = side === 'L' ? a.xGraze : W - a.xGraze;
      const distTxt = `${Math.round(dist * 1000)} mm`;
      if (a.status === 'safeNear') {
        // 近牆安全、超過此距離後產生眩光 → 最遠安全距離
        label = `${tag}：最遠安全距離 ${distTxt}（更遠眩光）`;
      } else { // safeFar：近處眩光、超過此距離才安全 → 最近安全距離
        label = `${tag}：最近安全距離 ${distTxt}（更近眩光）`;
      }
      color = 'rgba(255,190,60,0.95)';
    }
    infos.push({ label, color });
  }

  // 觀察者眼睛符號
  ctx.fillStyle = 'rgba(80,200,255,0.9)';
  ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(ex, ey, 5, 0, Math.PI * 2); ctx.stroke();

  // 眼高標籤
  ctx.fillStyle = 'rgba(140,210,255,0.65)';
  ctx.font = '10px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.fillText(`眼高 ${Math.round(eyeH * 1000)} mm`, mx(0) - 5, ey + 4);
  ctx.textAlign = 'left';

  // 安全距離結論（左上角）
  ctx.font = '12px system-ui, sans-serif';
  let ty = 20;
  for (const info of infos) {
    ctx.fillStyle = info.color;
    ctx.fillText(info.label, 12, ty);
    ty += 18;
  }
}

// ══ 尺寸標注 ══════════════════════════════════════════════════════
function drawDims(scene) {
  const { W, H } = scene;
  ctx.fillStyle = 'rgba(130,145,155,0.75)';
  ctx.font = '11px system-ui, sans-serif';

  // 室寬（底部）
  ctx.textAlign = 'center';
  ctx.fillText(`W = ${Math.round(W * 1000)} mm`, (mx(0) + mx(W)) / 2, my(0) + 32);

  // 室高（左側垂直）
  ctx.save();
  ctx.translate(mx(0) - 38, (my(0) + my(H)) / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = 'center';
  ctx.fillText(`H = ${Math.round(H * 1000)} mm`, 0, 0);
  ctx.restore();

  ctx.textAlign = 'left';
}

// ══ 主繪圖函數 ════════════════════════════════════════════════════
function redraw() {
  const CW = canvas.width, CH = canvas.height;
  if (CW <= 0 || CH <= 0) return;

  setupCoords(CW, CH);
  ctx.clearRect(0, 0, CW, CH);

  const scene = buildScene();
  _scene = scene;   // 供命中測試（pickBody）使用
  const { W, H } = scene;

  // 背景（依主題）
  ctx.fillStyle = theme().bg;
  ctx.fillRect(0, 0, CW, CH);

  // 表面薄帶（一律畫在室外側，使反射發生在材料的室內表面、不被射線穿透）
  const st = Math.max(3, 0.022 * _scale);
  ctx.fillStyle = 'rgba(215,210,195,0.65)';
  ctx.fillRect(mx(0), my(H) - st, W * _scale, st);         // 天花板（畫在 y=H 之上）
  ctx.fillStyle = 'rgba(150,130,100,0.55)';
  ctx.fillRect(mx(0), my(0), W * _scale, st);              // 地板（畫在 y=0 之下）
  // 牆面薄帶：反射關閉時，燈槽範圍外的牆面消失（只保留燈槽範圍內）
  const lWallBot = wallVisibleBottom(scene, 'L');
  const rWallBot = wallVisibleBottom(scene, 'R');
  ctx.fillStyle = 'rgba(185,185,185,0.45)';
  if (lWallBot < H) ctx.fillRect(mx(0) - st, my(H), st, (H - lWallBot) * _scale);  // 左牆
  if (rWallBot < H) ctx.fillRect(mx(W),      my(H), st, (H - rWallBot) * _scale);  // 右牆

  // 室內邊框（牆面消失處不畫邊線）
  ctx.strokeStyle = theme().border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mx(0), my(H)); ctx.lineTo(mx(W), my(H));     // 天花板
  ctx.moveTo(mx(0), my(0)); ctx.lineTo(mx(W), my(0));     // 地板
  if (lWallBot < H) { ctx.moveTo(mx(0), my(H)); ctx.lineTo(mx(0), my(lWallBot)); }  // 左牆
  if (rWallBot < H) { ctx.moveTo(mx(W), my(H)); ctx.lineTo(mx(W), my(rWallBot)); }  // 右牆
  ctx.stroke();

  // 燈槽幾何
  drawCoveGeo(scene, 'L');
  drawCoveGeo(scene, 'R');

  // 遮光截止角（在射線前面，作為背景參考）
  drawCriticalAngle(scene, 'L');
  drawCriticalAngle(scene, 'R');

  // 射線（最主要的視覺元素）
  drawRays(scene, 'L');
  drawRays(scene, 'R');

  // 燈具裸露邊界框（眩光判定範圍）
  drawGlareBox(scene, 'L');
  drawGlareBox(scene, 'R');

  // 光源光暈（蓋在射線之上）
  drawLightDot(scene, 'L');
  drawLightDot(scene, 'R');

  // 眼睛視角
  drawEye(scene);

  // 尺寸標注
  drawDims(scene);

  // 編輯輔助（僅燈槽分頁啟用時）：選取高亮、頂點、光源把手、座標軸
  const coveTab = document.getElementById('tab-cove');
  if (coveTab && coveTab.classList.contains('active')) {
    drawEditorOverlay(scene, 'L');
    drawEditorOverlay(scene, 'R');
    drawDragBadge();
  }
  const lightTab = document.getElementById('tab-light');
  if (lightTab && lightTab.classList.contains('active')) {
    drawFixtureHandle(scene, 'L');
    drawFixtureHandle(scene, 'R');
    drawDragBadge();
  }
  const viewTab = document.getElementById('tab-view');
  if (viewTab && viewTab.classList.contains('active')) {
    drawGlareHandles(scene, 'L');
    drawGlareHandles(scene, 'R');
    drawDragBadge();
  }
  if (S.illum.points.length) {
    drawIlluminancePoints();   // 量測點標記＋lux：所有分頁皆顯示
    if (typeof scheduleIllum === 'function') scheduleIllum();   // 幾何/光源變動後重算（debounced，不分頁籤）
  }
  if (illumTabActive()) drawDragBadge();

  if (typeof scheduleSave === 'function') scheduleSave();   // 任何變更後自動暫存（debounced）
}

// ══ UI Bindings ═══════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-selected', 'false'); });
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active'); btn.setAttribute('aria-selected', 'true');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab !== 'illum' && S.illum.placing) { S.illum.placing = false; if (typeof updateIllumPlaceBtn === 'function') updateIllumPlaceBtn(); }   // 離開照度→關閉放置模式
    redraw();   // 切換到燈槽分頁時顯示/隱藏編輯輔助
    if (btn.dataset.tab === 'illum') { renderIllumResult(); recomputeIlluminance(); }   // 切到照度→即時算
  });
});

// 將數值夾在滑桿範圍內並對齊 step
function clampToSlider(el, v) {
  const min = parseFloat(el.min), max = parseFloat(el.max), step = parseFloat(el.step);
  v = Math.max(min, Math.min(max, v));
  if (!isNaN(step) && step > 0) {
    v = min + Math.round((v - min) / step) * step;
    v = Math.max(min, Math.min(max, v));
  }
  return v;
}

// 點擊數值文字 → 變成可輸入欄位，Enter/失焦套用、Esc 取消
function startValueEdit(el, vl, apply) {
  if (vl.querySelector('input')) return;
  const prev = vl.textContent;
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.className = 'value-edit';
  inp.value = String(parseFloat(el.value));
  vl.textContent = '';
  vl.appendChild(inp);
  inp.focus();
  inp.select();

  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const v = parseFloat(inp.value);
    if (commit && !isNaN(v)) apply(clampToSlider(el, v), true);
    else vl.textContent = prev;
  };
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')      { e.preventDefault(); finish(true);  }
    else if (e.key === 'Escape'){ e.preventDefault(); finish(false); }
  });
}

function bindSlider(id, valId, unit, decimals, setter) {
  const el = document.getElementById(id);
  const vl = document.getElementById(valId);
  if (!el || !vl) return;

  const fmt = (v) => v.toFixed(decimals) + (unit ? ' ' + unit : '');
  const apply = (v, updateSlider) => {
    if (updateSlider) el.value = v;
    vl.textContent = fmt(v);
    setter(v);
    redraw();
  };

  el.addEventListener('input', () => apply(parseFloat(el.value), false));

  vl.classList.add('editable');
  vl.title = '點擊以輸入數值';
  vl.addEventListener('click', () => startValueEdit(el, vl, apply));
}

// 空間（長度 mm → 內部公尺）
bindSlider('room-width',  'room-width-val',  'mm', 0, v => { S.room.W = v / 1000; });
bindSlider('room-height', 'room-height-val', 'mm', 0, v => { S.room.H = v / 1000; });
bindSlider('refl-ceiling', 'refl-ceiling-val', '', 2, v => { S.refl.ceiling = v; });
bindSlider('refl-wall',    'refl-wall-val',    '', 2, v => { S.refl.wall    = v; });
bindSlider('refl-floor',   'refl-floor-val',   '', 2, v => { S.refl.floor   = v; });
document.getElementById('wall-refl-left').addEventListener('change',  e => { S.wallReflect.left  = e.target.checked; redraw(); });
document.getElementById('wall-refl-right').addEventListener('change', e => { S.wallReflect.right = e.target.checked; redraw(); });

// 啟用側別
document.getElementById('side-left').addEventListener('change',  e => { S.sides.left  = e.target.checked; redraw(); });
document.getElementById('side-right').addEventListener('change', e => { S.sides.right = e.target.checked; redraw(); });

// ══ 燈槽形式編輯器 ════════════════════════════════════════════════
let selectedElementId = null;
let nextElId = 1, nextPid = 1;
const genElId = () => 'el' + (nextElId++);
const genPid = () => 'p' + (nextPid++);
// 確保 element id 與頂點 pid 唯一、補齊缺漏，並清理失效的相黏接點（匯入/範本/載入後呼叫）
function ensureUniqueIds(form) {
  let maxE = 0, maxP = 0;
  for (const el of form.elements) {
    const m = /^el(\d+)$/.exec(el.id || ''); if (m) maxE = Math.max(maxE, +m[1]);
    if (el.path && el.path.kind !== 'arc') for (const p of (el.path.points || [])) { const mp = /^p(\d+)$/.exec(p.pid || ''); if (mp) maxP = Math.max(maxP, +mp[1]); }
  }
  nextElId = Math.max(nextElId, maxE + 1); nextPid = Math.max(nextPid, maxP + 1);
  const seenE = new Set(), seenP = new Set();
  for (const el of form.elements) {
    if (!el.id || seenE.has(el.id)) el.id = genElId();
    seenE.add(el.id);
    if (el.path && el.path.kind !== 'arc') for (const p of (el.path.points || [])) {
      if (!p.pid || seenP.has(p.pid)) p.pid = genPid();
      seenP.add(p.pid);
    }
  }
  pruneJoints(form);
}
// ── 相黏接點（joints）：頂點群組共享座標 ──────────────────────────
function getPointByPid(el, pid) {
  if (!el || !el.path || el.path.kind === 'arc') return null;
  return el.path.points.find(p => p.pid === pid) || null;
}
function pruneJoints(form) {
  if (!Array.isArray(form.joints)) { form.joints = []; return; }
  const valid = (m) => m && typeof m.el === 'string' && typeof m.pid === 'string' &&
    (() => { const el = form.elements.find(e => e.id === m.el); return el && getPointByPid(el, m.pid); })();
  form.joints = form.joints
    .filter(g => Array.isArray(g))                         // 容錯：忽略非陣列群組
    .map(g => {
      const seen = new Set(), out = [];
      for (const m of g) { if (!valid(m)) continue; const k = m.el + '/' + m.pid; if (!seen.has(k)) { seen.add(k); out.push({ el: m.el, pid: m.pid }); } }
      return out;
    }).filter(g => g.length >= 2);
}
function jointIndexOf(form, elId, pid) { return (form.joints || []).findIndex(g => g.some(m => m.el === elId && m.pid === pid)); }
function isBonded(elId, pid) { return jointIndexOf(S.cove.form, elId, pid) >= 0; }
// 把某頂點現在座標同步給其接點群組所有成員
function propagateJoint(elId, pid) {
  const form = S.cove.form, gi = jointIndexOf(form, elId, pid); if (gi < 0) return;
  const src = getPointByPid(form.elements.find(e => e.id === elId), pid); if (!src) return;
  for (const m of form.joints[gi]) {
    if (m.el === elId && m.pid === pid) continue;
    const p = getPointByPid(form.elements.find(e => e.id === m.el), m.pid);
    if (p) { p.u = src.u; p.d = src.d; }
  }
}
// 元件整體移動後：把它所有相黏頂點同步給「其他元件」夥伴（略過同元件成員，避免塌陷）
function propagateElementJoints(elId) {
  const form = S.cove.form, el = form.elements.find(e => e.id === elId);
  if (!el || !el.path || el.path.kind === 'arc') return;
  for (const p of el.path.points) {
    const gi = jointIndexOf(form, elId, p.pid); if (gi < 0) continue;
    for (const m of form.joints[gi]) {
      if (m.el === elId) continue;   // 同元件成員已隨整體位移，勿再覆蓋
      const tp = getPointByPid(form.elements.find(e => e.id === m.el), m.pid);
      if (tp) { tp.u = p.u; tp.d = p.d; }
    }
  }
}
// 與 elId 經相黏鏈相連的整個元件連通分量（含 elId 自己）→ Ctrl 整體拖曳用
function bondedComponentIncluding(elId) {
  const form = S.cove.form, comp = new Set([elId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of (form.joints || [])) {
      const els = g.map(m => m.el);
      if (els.some(id => comp.has(id))) for (const id of els) if (!comp.has(id)) { comp.add(id); changed = true; }
    }
  }
  return [...comp];
}
// 拖曳某頂點時，需「整體平移」的相黏夥伴元件（排除被拖曳元件本身）。
// 從該頂點的接點群組夥伴出發，沿相黏鏈擴展，但不經過被拖曳元件 → 夥伴剛體跟隨、不變形。
function bondedPartnerComponent(dragElId, dragPid) {
  const form = S.cove.form, gi = jointIndexOf(form, dragElId, dragPid);
  if (gi < 0) return [];
  const comp = new Set();
  for (const m of form.joints[gi]) if (m.el !== dragElId) comp.add(m.el);
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of (form.joints || [])) {
      const els = g.map(m => m.el);
      if (els.some(id => comp.has(id))) for (const id of els) if (id !== dragElId && !comp.has(id)) { comp.add(id); changed = true; }
    }
  }
  comp.delete(dragElId);
  return [...comp];
}
// 取元件 id 清單的「點列快照」（過濾弧線），供剛體平移用
function snapshotPointEls(ids) {
  return ids.map(id => S.cove.form.elements.find(el => el.id === id))
    .filter(el => el && el.path && el.path.kind !== 'arc')
    .map(el => ({ id: el.id, orig: el.path.points.map(p => ({ pid: p.pid, u: p.u, d: p.d })) }));
}
// 解除某元件所有頂點的相黏（Alt 拖曳本體＝脫離黏合）
function detachElementJoints(elId) {
  const el = S.cove.form.elements.find(e => e.id === elId);
  if (!el || !el.path || el.path.kind === 'arc') return;
  for (const p of el.path.points) if (isBonded(elId, p.pid)) detachVertex(elId, p.pid);
}
// 相黏兩頂點（群組聯集）
function bondVertices(a, b) {
  if (a.el === b.el && a.pid === b.pid) return;
  const form = S.cove.form; if (!Array.isArray(form.joints)) form.joints = [];
  const ga = jointIndexOf(form, a.el, a.pid), gb = jointIndexOf(form, b.el, b.pid);
  if (ga < 0 && gb < 0) form.joints.push([{ el: a.el, pid: a.pid }, { el: b.el, pid: b.pid }]);
  else if (ga >= 0 && gb < 0) form.joints[ga].push({ el: b.el, pid: b.pid });
  else if (gb >= 0 && ga < 0) form.joints[gb].push({ el: a.el, pid: a.pid });
  else if (ga !== gb) { form.joints[ga] = form.joints[ga].concat(form.joints[gb]); form.joints.splice(gb, 1); }
  pruneJoints(form);
}
function detachVertex(elId, pid) {
  const form = S.cove.form, gi = jointIndexOf(form, elId, pid); if (gi < 0) return;
  form.joints[gi] = form.joints[gi].filter(m => !(m.el === elId && m.pid === pid));
  pruneJoints(form);
}

function refreshEditor() { ensureUniqueIds(S.cove.form); renderCoveEditor(); redraw(); if (typeof updateLibraryStatus === 'function') updateLibraryStatus(); }
function afterEdit() { redraw(); runLiveValidation(); if (typeof updateLibraryStatus === 'function') updateLibraryStatus(); }
function applyTemplate(name) {
  if (S.cove.form) snapshot();
  activeFormName = null; savedFormJson = null;   // 從範本＝新草稿
  S.cove.form = makeFormFromTemplate(name);
  ensureUniqueIds(S.cove.form);
  selectedElementId = (S.cove.form.elements[0] || {}).id || null;
  refreshEditor();
}
function applyForm(form) {
  if (S.cove.form) snapshot();
  S.cove.form = form;
  ensureUniqueIds(S.cove.form);
  selectedElementId = (form.elements[0] || {}).id || null;
  refreshEditor();
}

// — 輕量 DOM 建構器 —
function h(tag, attrs, kids) {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k === 'title') e.title = attrs[k];
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  (kids || []).forEach(c => e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c));
  return e;
}
// 數值欄位（顯示單位）：即時更新 form + 重繪 + 即時驗證，不重建 DOM（保留焦點）
function field(label, dispVal, unit, step, onInput) {
  const inp = h('input', { type: 'number', class: 'num-input', step: step || 'any', value: dispVal });
  inp.addEventListener('focus', () => snapshot());
  inp.addEventListener('input', () => { const v = parseFloat(inp.value); if (isFinite(v)) { onInput(v); afterEdit(); } });
  return h('div', { class: 'control-row' }, [ h('span', { class: 'control-label', text: label }), inp,
    h('span', { class: 'unit-label', text: unit || '' }) ]);
}
// 即時驗證目前 form，更新編輯器頂部警示列（不重建 DOM）
function runLiveValidation() {
  const el = document.getElementById('cove-validate');
  if (!el) return;
  const v = validateForm(S.cove.form);
  if (v.ok) { el.textContent = ''; el.className = 'hint'; }
  else { el.textContent = '⚠ ' + v.error; el.className = 'hint error'; }
}
function textField(label, val, onInput) {
  const inp = h('input', { type: 'text', class: 'text-input', value: val || '' });
  inp.addEventListener('input', () => onInput(inp.value));
  return h('div', { class: 'control-row' }, [ h('span', { class: 'control-label', text: label }), inp ]);
}

// — 結構性操作（皆先 snapshot 供 Undo）—
function addEl(kind) {
  snapshot();
  const id = genElId();
  let el;
  if (kind === 'polygon')
    el = { id, name: '多邊形', kind: 'polygon', reflect: 0.25, transparency: 0, materialName: '',
           path: { kind: 'polyline', points: [ {u:0.05,d:0.30},{u:0.15,d:0.30},{u:0.15,d:0.40},{u:0.05,d:0.40} ] } };
  else if (kind === 'arc')
    el = { id, name: '弧形', kind: 'panel', thickness: THICK, reflect: 0.2, transparency: 0, materialName: '',
           path: { kind: 'arc', center: { u: 0.05, d: 0.30 }, radius: 0.10, startDeg: 0, sweepDeg: -90 } };
  else
    el = { id, name: '面板', kind: 'panel', thickness: THICK, reflect: 0.25, transparency: 0, materialName: '',
           path: { kind: 'polyline', points: [ {u:0,d:0.40},{u:0.15,d:0.40} ] } };
  S.cove.form.elements.push(el); selectedElementId = id; refreshEditor();
}
function delEl(i) {
  snapshot();
  const el = S.cove.form.elements[i]; S.cove.form.elements.splice(i, 1);
  if (el.id === selectedElementId) selectedElementId = (S.cove.form.elements[0] || {}).id || null;
  refreshEditor();
}
function dupEl(i) {
  snapshot();
  const c = JSON.parse(JSON.stringify(S.cove.form.elements[i])); c.id = genElId(); c.name = (c.name || '') + ' 複本';
  S.cove.form.elements.splice(i + 1, 0, c); selectedElementId = c.id; refreshEditor();
}
function moveEl(i, dir) {
  const a = S.cove.form.elements, j = i + dir; if (j < 0 || j >= a.length) return;
  snapshot();
  const t = a[i]; a[i] = a[j]; a[j] = t; refreshEditor();
}
function insertPoint(el, pi) {
  snapshot();
  const pts = el.path.points, a = pts[pi], b = pts[(pi + 1) % pts.length] || a;
  pts.splice(pi + 1, 0, { u: (a.u + b.u) / 2, d: (a.d + b.d) / 2 }); refreshEditor();
}
function deletePoint(el, pi) {
  const min = el.kind === 'polygon' ? 3 : 2; if (el.path.points.length <= min) return;
  snapshot();
  el.path.points.splice(pi, 1); refreshEditor();
}
function arcToPolyline(el) { snapshot(); el.path = { kind: 'polyline', points: arcPoints(el.path) }; refreshEditor(); }

// — 重建編輯器 DOM —
function renderCoveEditor() {
  const root = document.getElementById('cove-editor');
  if (!root) return;
  root.innerHTML = '';
  const form = S.cove.form;

  // 即時驗證警示列
  root.appendChild(h('div', { id: 'cove-validate', class: 'hint' }));
  root.appendChild(h('div', { class: 'hint', text: '座標原點為「牆-天花板角」：u＝距牆、d＝距頂（mm），左右鏡像共用。拖曳頂點＝調整尺寸、拖曳本體＝整體移動；相黏物件預設「整體跟隨不變形」，Ctrl＝接點被拉伸（夥伴變形），Alt＝脫離黏合單獨操作。把頂點拖到另一頂點上會「相黏」；方向鍵微調（Shift=10mm）。' }));

  // 元件清單
  root.appendChild(h('div', { class: 'section-title', text: '元件清單' }));
  if (!form.elements.length)
    root.appendChild(h('div', { class: 'hint', text: '尚無元件。按下方「新增」或選一個範本開始。' }));
  const list = h('div', { class: 'el-list' });
  form.elements.forEach((el, i) => {
    const sel = el.id === selectedElementId;
    list.appendChild(h('div', { class: 'el-row' + (sel ? ' sel' : '') }, [
      h('button', { class: 'el-btn', title: '顯示/隱藏', text: el.hidden ? '◯' : '●',
        onclick: (ev) => { ev.stopPropagation(); el.hidden = !el.hidden; refreshEditor(); } }),
      h('span', { class: 'el-name', text: (el.kind === 'polygon' ? '▰ ' : '▭ ') + (el.name || el.id),
        onclick: () => { selectedElementId = el.id; refreshEditor(); } }),
      h('button', { class: 'el-btn', title: '上移', text: '▲', onclick: (ev) => { ev.stopPropagation(); moveEl(i, -1); } }),
      h('button', { class: 'el-btn', title: '下移', text: '▼', onclick: (ev) => { ev.stopPropagation(); moveEl(i, 1); } }),
      h('button', { class: 'el-btn', title: '複製', text: '⧉', onclick: (ev) => { ev.stopPropagation(); dupEl(i); } }),
      h('button', { class: 'el-btn', title: '刪除', text: '✕', onclick: (ev) => { ev.stopPropagation(); delEl(i); } }),
    ]));
  });
  root.appendChild(list);
  root.appendChild(h('div', { class: 'btn-row wrap' }, [
    h('button', { class: 'btn', text: '＋ 折線', onclick: () => addEl('panel') }),
    h('button', { class: 'btn', text: '＋ 弧線', onclick: () => addEl('arc') }),
    h('button', { class: 'btn', text: '＋ 多邊形', onclick: () => addEl('polygon') }),
  ]));

  // 選取元件 inspector
  const el = form.elements.find(e => e.id === selectedElementId);
  if (el) {
    root.appendChild(h('div', { class: 'section-title', text: '材質與尺寸' }));
    root.appendChild(textField('名稱', el.name, v => { el.name = v; const n = list.querySelector('.el-row.sel .el-name'); if (n) n.textContent = (el.kind === 'polygon' ? '▰ ' : '▭ ') + (v || el.id); }));
    root.appendChild(field('反光係數', Math.round((el.reflect || 0) * 100), '%', 1, v => { el.reflect = clamp(v / 100, 0, 1); }));
    root.appendChild(field('透光度', Math.round((el.transparency || 0) * 100), '%', 1, v => { el.transparency = clamp(v / 100, 0, 1); }));
    root.appendChild(h('div', { class: 'hint', text: '參考：白漆≈85%、鏡面≈95%、深色≈10%；透光度>0 即半透光' }));
    root.appendChild(textField('材料名稱', el.materialName, v => { el.materialName = v; }));
    if (el.kind !== 'polygon')
      root.appendChild(field('厚度', Math.round((el.thickness || THICK) * 1000), 'mm', 1, v => { el.thickness = Math.max(0.001, v / 1000); }));

    // 幾何
    root.appendChild(h('div', { class: 'section-title', text: '幾何' }));
    if (el.path.kind === 'arc') {
      const a = el.path;
      root.appendChild(field('圓心 u', Math.round(a.center.u * 1000), 'mm', 1, v => { a.center.u = v / 1000; }));
      root.appendChild(field('圓心 d', Math.round(a.center.d * 1000), 'mm', 1, v => { a.center.d = v / 1000; }));
      root.appendChild(field('半徑', Math.round(a.radius * 1000), 'mm', 1, v => { a.radius = Math.max(0.001, v / 1000); }));
      root.appendChild(field('起始角', a.startDeg, '°', 1, v => { a.startDeg = v; }));
      root.appendChild(field('掃掠角', a.sweepDeg, '°', 1, v => { a.sweepDeg = v; }));
      root.appendChild(h('div', { class: 'btn-row' }, [ h('button', { class: 'btn', text: '轉為折線', onclick: () => arcToPolyline(el) }) ]));
    } else {
      const tbl = h('div', { class: 'pt-table' });
      tbl.appendChild(h('div', { class: 'pt-row pt-head' }, [ h('span', { class: 'pt-idx', text: '#' }),
        h('span', { class: 'pt-h', text: 'u (mm)' }), h('span', { class: 'pt-h', text: 'd (mm)' }), h('span', { class: 'pt-h', text: '' }) ]));
      el.path.points.forEach((p, pi) => {
        const bonded = isBonded(el.id, p.pid);
        const ru = h('input', { type: 'number', class: 'num-input sm', step: 1, value: Math.round(p.u * 1000) });
        ru.addEventListener('focus', () => snapshot());
        ru.addEventListener('input', () => { const v = parseFloat(ru.value); if (isFinite(v)) { p.u = v / 1000; propagateJoint(el.id, p.pid); afterEdit(); } });
        const rd = h('input', { type: 'number', class: 'num-input sm', step: 1, value: Math.round(p.d * 1000) });
        rd.addEventListener('focus', () => snapshot());
        rd.addEventListener('input', () => { const v = parseFloat(rd.value); if (isFinite(v)) { p.d = v / 1000; propagateJoint(el.id, p.pid); afterEdit(); } });
        const ops = [
          h('button', { class: 'el-btn', title: '下方插入', text: '＋', onclick: () => insertPoint(el, pi) }),
          h('button', { class: 'el-btn', title: '刪除', text: '✕', onclick: () => deletePoint(el, pi) }) ];
        if (bonded) ops.unshift(h('button', { class: 'el-btn', title: '解除相黏', text: '⛓', onclick: () => { snapshot(); detachVertex(el.id, p.pid); refreshEditor(); } }));
        tbl.appendChild(h('div', { class: 'pt-row' }, [ h('span', { class: 'pt-idx', text: pi + 1 }), ru, rd, h('span', { class: 'pt-ops' }, ops) ]));
      });
      root.appendChild(tbl);
    }
  }

  // （光源掛點移至「光源」分頁；此處同步其數值）
  syncFixtureControls();
  runLiveValidation();
}

// 範本按鈕（資料驅動）
function renderTemplateButtons() {
  const root = document.getElementById('cove-templates');
  if (!root) return;
  root.innerHTML = '';
  Object.keys(TEMPLATE_LABELS).forEach(name => {
    root.appendChild(h('button', { class: 'btn tmpl-btn', text: TEMPLATE_LABELS[name], onclick: () => applyTemplate(name) }));
  });
}

// ══ 匯入/匯出：可選擇性包含各項設定（獨立分頁）═══════════════════════
// 格式 cove-setup@2：依勾選帶入燈槽/光源/空間/視角/射線/照度各區段；相容舊版 @1（燈槽＋光源）與純燈槽。
const SETUP_SECTIONS = [
  { key: 'cove',  label: '燈槽形式' },
  { key: 'light', label: '光源' },
  { key: 'space', label: '空間（尺寸／側別／反射／穿透）' },
  { key: 'view',  label: '視角（眼睛／眩光／主題／圖例）' },
  { key: 'ray',   label: '射線' },
  { key: 'illum', label: '照度量測點' },
];
const ALL_SECTIONS = SETUP_SECTIONS.reduce((o, s) => (o[s.key] = true, o), {});
const secLabel = (k) => { const s = SETUP_SECTIONS.find(x => x.key === k); return s ? s.label : k; };
const cloneJSON = (v) => JSON.parse(JSON.stringify(v));
// 依勾選(sel)組出設定碼物件；未勾選的區段不納入
function serializeSetup(sel = ALL_SECTIONS) {
  const o = { schema: 'cove-setup@2', originRoomH: Math.round(S.room.H * 1000) };   // originRoomH：匯出時室高(mm)，供人對照
  if (sel.cove)  o.cove  = serializeForm();
  if (sel.light) o.light = cloneJSON(S.cove.light);
  if (sel.space) o.space = { room: cloneJSON(S.room), sides: cloneJSON(S.sides), refl: cloneJSON(S.refl), wallReflect: cloneJSON(S.wallReflect) };
  if (sel.view)  o.view  = { eye: cloneJSON(S.eye), glare: cloneJSON(S.glare), theme: S.theme, legendShow: S.legendShow };
  if (sel.ray)   o.ray   = cloneJSON(S.ray);
  if (sel.illum) o.illum = { lmPerM: S.illum.lmPerM, dist: S.illum.dist, normal: S.illum.normal, points: S.illum.points.map(p => ({ x: p.x, y: p.y })) };
  return o;
}
// 驗證設定碼物件中「有出現」的燈槽/光源區段；其餘區段交由 sanitizeState 夾制
function validateSetupObj(obj) {
  if (obj.cove != null) { const v = validateForm(obj.cove); if (!v.ok) return { ok:false, error:'燈槽：' + v.error }; }
  if (obj.light != null) { const v = validateLight(obj.light); if (!v.ok) return { ok:false, error:'光源：' + v.error }; }
  return { ok:true };
}
// 解析設定碼 → { ok, error, setup, sections }；sections 為實際包含的區段鍵
function parseSetup(text) {
  let obj;
  if (!text || !text.trim()) return { ok:false, error:'設定碼是空的' };
  try { obj = JSON.parse(text); } catch (e) { console.error('[匯入] 設定碼解析失敗：', e); return { ok:false, error:'設定碼格式不正確，請確認已完整複製貼上' }; }
  if (!obj || typeof obj !== 'object') return { ok:false, error:'設定碼格式不正確' };
  if (obj.schema === 'cove-setup@2') {
    if (obj.cove != null) { const cv = parseForm(JSON.stringify(obj.cove)); if (!cv.ok) return { ok:false, error:'燈槽：' + cv.error }; obj.cove = cv.form; }
    const lv = validateSetupObj(obj); if (!lv.ok) return lv;
    return { ok:true, setup: obj, sections: SETUP_SECTIONS.map(s => s.key).filter(k => obj[k] != null) };   // 忽略 null 區段
  }
  if (obj.schema === 'cove-setup@1') {   // 舊版：燈槽＋光源
    const cv = parseForm(JSON.stringify(obj.cove)); if (!cv.ok) return { ok:false, error:'燈槽：' + cv.error };
    const lv = validateLight(obj.light); if (!lv.ok) return { ok:false, error: lv.error };
    return { ok:true, setup: { cove: cv.form, light: obj.light }, sections: ['cove', 'light'] };
  }
  const cv = parseForm(text);   // 更舊：純燈槽（cove-form@2 / cove-profile@1）
  if (!cv.ok) return cv;
  return { ok:true, setup: { cove: cv.form }, sections: ['cove'] };
}
function applyLight(L) {
  S.cove.light.emissionAngle  = Number(L.emissionAngle);
  S.cove.light.rotationAngle  = Number(L.rotationAngle);
  S.cove.light.lightKelvin    = Number(L.lightKelvin);
  S.cove.light.lightIntensity = Number(L.lightIntensity);
  S.cove.light.fixture = { u: Number(L.fixture.u), d: Number(L.fixture.d) };
}
// 套用設定碼物件中「有出現且被勾選」的區段；回傳已套用區段的中文標籤
function applySetup(obj, sel) {
  const applied = [];
  if (sel.cove && obj.cove !== undefined) { activeFormName = null; savedFormJson = null; applyForm(cloneJSON(obj.cove)); applied.push(secLabel('cove')); }
  if (sel.light && obj.light !== undefined) { applyLight(obj.light); activeLightName = null; savedLightJson = null; applied.push(secLabel('light')); }
  if (sel.space && obj.space) {
    const sp = obj.space;
    if (sp.room) Object.assign(S.room, sp.room);
    if (sp.sides) Object.assign(S.sides, sp.sides);
    if (sp.refl) Object.assign(S.refl, sp.refl);
    if (sp.wallReflect) Object.assign(S.wallReflect, sp.wallReflect);
    applied.push(secLabel('space'));
  }
  if (sel.view && obj.view) {
    const v = obj.view;
    if (v.eye) Object.assign(S.eye, v.eye);
    if (v.glare) Object.assign(S.glare, v.glare);
    if (typeof v.theme === 'string') S.theme = v.theme;
    if (typeof v.legendShow === 'boolean') S.legendShow = v.legendShow;
    applied.push(secLabel('view'));
  }
  if (sel.ray && obj.ray) { Object.assign(S.ray, obj.ray); applied.push(secLabel('ray')); }
  if (sel.illum && obj.illum) {
    const il = obj.illum;
    if (isFinite(Number(il.lmPerM))) S.illum.lmPerM = Number(il.lmPerM);
    if (typeof il.dist === 'string') S.illum.dist = il.dist;
    if (typeof il.normal === 'string') S.illum.normal = il.normal;
    if (Array.isArray(il.points)) S.illum.points = il.points.filter(p => p && isFinite(Number(p.x)) && isFinite(Number(p.y))).map(p => ({ x: Number(p.x), y: Number(p.y), result: null }));
    applied.push(secLabel('illum'));
  }
  sanitizeState();                                   // 夾制套用值至合法範圍
  syncAllControls(); syncLightControls(); syncFixtureControls();
  if (typeof renderIllumResult === 'function') renderIllumResult();   // 刷新照度面板（含套用後量測點清空的情形）
  if (typeof updateIllumPlaceBtn === 'function') updateIllumPlaceBtn();   // 放置模式已被 sanitize 關閉→同步按鈕外觀
  renderLightLib(); renderLibrary(); redraw();
  return applied;
}
// 讀取「包含項目」勾選狀態（控制匯出/匯入；預設全選）
function readSetupSelection() {
  const sel = {};
  for (const s of SETUP_SECTIONS) { const el = document.getElementById('setup-inc-' + s.key); sel[s.key] = el ? el.checked : true; }
  return sel;
}
// 精簡格式 ILS1：JSON → UTF-8 → deflate-raw → base64，加前綴。可讀性換取體積（約少 6~8 成）。
const _hasCompression = (typeof CompressionStream === 'function' && typeof DecompressionStream === 'function');
// 匯入文字 → 純 JSON 文字（ILS1 前綴則先解壓；否則原樣，相容 JSON 貼上）
async function resolveImportText(raw) {
  const t = (raw || '').trim();
  if (!t.startsWith(COMPACT_PREFIX)) return raw;
  if (!_hasCompression) throw new Error('此瀏覽器不支援解壓縮設定碼，請改用 JSON 格式');
  return await decodeCompact(t);
}
document.getElementById('io-export').addEventListener('click', async () => {
  const st = document.getElementById('io-status');
  const sel = readSetupSelection();
  if (!Object.values(sel).some(Boolean)) { st.textContent = '✗ 請至少勾選一個要匯出的項目'; st.className = 'hint error'; return; }
  let out;
  try {
    out = _hasCompression ? await encodeCompact(serializeSetup(sel))
                          : JSON.stringify(serializeSetup(sel));   // 後備：瀏覽器無壓縮 API → 最小化 JSON
  } catch (e) { console.error('[匯出] 失敗：', e); st.textContent = '✗ 匯出失敗，請稍後再試'; st.className = 'hint error'; return; }
  document.getElementById('io-json').value = out;
  const note = _hasCompression ? '' : '（瀏覽器不支援壓縮，已輸出最小化 JSON）';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(out).then(
      () => { st.textContent = '✓ 已複製到剪貼簿' + note; st.className = 'hint ok'; },
      () => { st.textContent = '已顯示於上方，可手動複製' + note; st.className = 'hint'; });
  } else { st.textContent = '已顯示於上方，可手動複製' + note; st.className = 'hint'; }
});
document.getElementById('io-import').addEventListener('click', async () => {
  const st = document.getElementById('io-status');
  const raw = document.getElementById('io-json').value;
  if (!raw || !raw.trim()) { st.textContent = '✗ 請先在上方貼上設定碼再按「匯入套用」'; st.className = 'hint error'; return; }
  let text;
  try { text = await resolveImportText(raw); }
  catch (e) { console.error('[匯入] 解壓縮失敗：', e); st.textContent = '✗ 設定碼格式不正確，請確認已完整複製貼上'; st.className = 'hint error'; return; }
  const res = parseSetup(text);
  if (!res.ok) { st.textContent = '✗ ' + res.error; st.className = 'hint error'; return; }
  const sel = readSetupSelection();
  const applicable = res.sections.filter(k => sel[k]);
  if (!applicable.length) {
    st.textContent = '✗ 設定碼含：' + res.sections.map(secLabel).join('、') + '，但未勾選相符項目';
    st.className = 'hint error'; return;
  }
  const applied = applySetup(res.setup, sel);
  activeSetupName = null; savedSetupJson = null;   // 匯入＝未命名設定檔
  renderSetupLib();
  const skipped = res.sections.filter(k => !sel[k]);
  let msg = '✓ 已匯入並套用：' + applied.join('、');
  if (skipped.length) msg += '（略過未勾選：' + skipped.map(secLabel).join('、') + '）';
  st.textContent = msg; st.className = 'hint ok';
});

// ── 設定檔列表（光源＋燈槽合併，與燈槽/光源模板平行）──────────────────
const LS_SETUP_LIB = 'indirect-lighting:setup-library@1';
let activeSetupName = null, savedSetupJson = null;
const setupPayload = () => serializeSetup(ALL_SECTIONS);   // 列表儲存完整快照（含所有設定區段）
// 目前狀態是否已偏離作用中設定檔（只比對該設定檔實際含有的區段，兼容舊 @1）
function setupDirtyVsSaved() {
  if (!savedSetupJson) return false;
  let stored; try { stored = JSON.parse(savedSetupJson); } catch (e) { return true; }
  const cur = setupPayload();
  // cove 比對忽略 originRoomH 註記（舊版列表項未含此欄，避免誤判已修改）
  const norm = (key, v) => { if (key === 'cove' && v && typeof v === 'object') { const c = { ...v }; delete c.originRoomH; return JSON.stringify(c); } return JSON.stringify(v); };
  return SETUP_SECTIONS.some(s => stored[s.key] !== undefined && norm(s.key, stored[s.key]) !== norm(s.key, cur[s.key]));
}
function loadSetupLib() { try { const r = localStorage.getItem(LS_SETUP_LIB); const d = r ? JSON.parse(r) : null; return (d && Array.isArray(d.setups)) ? d.setups : []; } catch (e) { return []; } }
function saveSetupLib(setups) { try { localStorage.setItem(LS_SETUP_LIB, JSON.stringify({ schema: 'setup-library@1', setups })); _storageFailed = false; updateStorageBanner(); return true; } catch (e) { _storageFailed = true; updateStorageBanner(); updateSetupStatus(); return false; } }
function updateSetupStatus() {
  const st = document.getElementById('setup-status'); if (!st) return;
  if (_storageFailed) { st.textContent = '⚠ 本機儲存不可用，本次變更不會保留'; st.className = 'hint error'; return; }
  if (activeSetupName) {
    const dirty = setupDirtyVsSaved();
    st.textContent = dirty ? `目前：${activeSetupName}（已修改，未儲存）` : `目前：${activeSetupName}（已同步）`;
    st.className = dirty ? 'hint' : 'hint ok';
  } else { st.textContent = '未命名設定檔（按「儲存」存入設定檔列表）'; st.className = 'hint'; }
}
function renderSetupLib() {
  const sel = document.getElementById('setup-select'); if (!sel) return;
  const setups = loadSetupLib();
  sel.innerHTML = '';
  setups.forEach(s => { const o = document.createElement('option'); o.value = s.name; o.textContent = s.name; sel.appendChild(o); });
  if (activeSetupName) sel.value = activeSetupName;
  const nameInp = document.getElementById('setup-name');
  if (nameInp) { if (activeSetupName) nameInp.value = activeSetupName; else if (!nameInp.value) nameInp.value = nextUnnamedName('未命名設定檔', setups); }
  updateSetupStatus();
}
function setupSaveAs() {
  const st = document.getElementById('setup-status');
  const name = (document.getElementById('setup-name').value || '').trim();
  if (!name) { st.textContent = '✗ 請先輸入名稱'; st.className = 'hint error'; return; }
  const setups = loadSetupLib(), now = Date.now(), data = setupPayload();
  const existing = setups.find(s => s.name === name);
  if (existing && !pendConfirm('ssave:' + name, `「${name}」已存在，再按一次「另存新檔」以覆蓋`, 'setup-status', updateSetupStatus)) return;
  if (existing) { existing.setup = data; existing.updatedAt = now; }
  else setups.push({ id: 'S' + now, name, createdAt: now, updatedAt: now, setup: data });
  if (!saveSetupLib(setups)) return;
  activeSetupName = name; savedSetupJson = JSON.stringify(data); renderSetupLib();
}
function setupSave() { if (!activeSetupName) { setupSaveAs(); return; } document.getElementById('setup-name').value = activeSetupName; setupSaveAs(); }
function setupLoad() {
  const st = document.getElementById('setup-status');
  const name = document.getElementById('setup-select').value;
  const s = loadSetupLib().find(x => x.name === name); if (!s || !s.setup) return;
  const v = validateSetupObj(s.setup);
  if (!v.ok) { st.textContent = '✗ 資料毀損：' + v.error; st.className = 'hint error'; return; }
  // 載入設定檔＝還原其包含的所有區段；個別模板關聯轉為未命名（不再對應單一模板）
  const applied = applySetup(s.setup, ALL_SECTIONS);
  activeSetupName = name;
  // dirty 基準取「套用並夾制後」的目前值（僅該設定檔含有的區段），避免 sanitize 夾制造成載入後即誤判已修改
  const presentSel = {}; SETUP_SECTIONS.forEach(x => { if (s.setup[x.key] != null) presentSel[x.key] = true; });
  savedSetupJson = JSON.stringify(serializeSetup(presentSel));
  document.getElementById('setup-name').value = name; renderSetupLib(); redraw();
  st.textContent = '✓ 已載入：' + applied.join('、'); st.className = 'hint ok';
}
function setupDelete() {
  const name = document.getElementById('setup-select').value; if (!name) return;
  if (!pendConfirm('sdel:' + name, `再按一次「刪除」以確認刪除「${name}」`, 'setup-status', updateSetupStatus)) return;
  saveSetupLib(loadSetupLib().filter(s => s.name !== name));
  if (activeSetupName === name) { activeSetupName = null; savedSetupJson = null; }
  const ni = document.getElementById('setup-name'); if (ni && ni.value === name) ni.value = '';
  renderSetupLib();
}
document.getElementById('setup-save').addEventListener('click', setupSave);
document.getElementById('setup-saveas').addEventListener('click', setupSaveAs);
document.getElementById('setup-load').addEventListener('click', setupLoad);
document.getElementById('setup-delete').addEventListener('click', setupDelete);

// ══ 持久化：session 自動存檔 + 具名表單庫 ══════════════════════════
const LS_SESSION = 'indirect-lighting:session@2';
const LS_LIBRARY = 'indirect-lighting:cove-library@2';
let activeFormName = null;   // 目前作用中的具名表單（null＝未命名草稿）
let savedFormJson = null;    // 該具名表單儲存當下的快照，用於 dirty 判定

let _storageFailed = false;
// 本機儲存失敗時顯示全域橫幅（成功則隱藏）
function updateStorageBanner() { const b = document.getElementById('storage-banner'); if (b) b.hidden = !_storageFailed; }
function saveSession() {
  try {
    localStorage.setItem(LS_SESSION, JSON.stringify({
      schema: 'session@2', savedAt: Date.now(),
      room: S.room, refl: S.refl, wallReflect: S.wallReflect, sides: S.sides,
      ray: S.ray, eye: S.eye, glare: S.glare, theme: S.theme,
      activeFormName, savedFormJson,                       // 還原後可保留具名關聯與 dirty 判定
      activeLightName, savedLightJson,
      activeSetupName, savedSetupJson,
      illum: { lmPerM: S.illum.lmPerM, dist: S.illum.dist, normal: S.illum.normal, points: S.illum.points.map(p => ({ x: p.x, y: p.y })) },
      legendShow: S.legendShow,
      cove: { form: S.cove.form, light: S.cove.light },
    }));
    _storageFailed = false;
  } catch (e) { _storageFailed = true; updateLibraryStatus(); if (typeof updateLightStatus === 'function') updateLightStatus(); } // 配額/隱私模式
  updateStorageBanner();
  if (typeof updateSetupStatus === 'function') updateSetupStatus();   // 任何變更後刷新設定檔「已修改」指示（設定檔含全部設定）
}
let _saveTimer = null;
function scheduleSave() { clearTimeout(_saveTimer); _saveTimer = setTimeout(saveSession, 400); }
function loadSession() {
  try {
    const r = localStorage.getItem(LS_SESSION); if (!r) return false;
    const d = JSON.parse(r); if (!d || d.schema !== 'session@2') return false;
    if (d.cove && d.cove.form) { const v = validateForm(d.cove.form); if (!v.ok) return false; } // 毀損→不套用
    ['room', 'refl', 'wallReflect', 'sides', 'ray', 'eye', 'glare'].forEach(k => { if (d[k]) Object.assign(S[k], d[k]); });
    if (typeof d.theme === 'string') S.theme = d.theme;
    if (d.cove) {
      if (d.cove.form) S.cove.form = d.cove.form;
      if (d.cove.light) Object.assign(S.cove.light, d.cove.light);
      // 遷移：舊 session 把光源位置存在 form.fixture → 帶到 light.fixture
      if (d.cove.light && !d.cove.light.fixture && d.cove.form && d.cove.form.fixture)
        S.cove.light.fixture = { u: d.cove.form.fixture.u, d: d.cove.form.fixture.d };
    }
    if (typeof d.activeFormName === 'string') activeFormName = d.activeFormName;
    if (typeof d.savedFormJson === 'string') savedFormJson = d.savedFormJson;
    if (typeof d.activeLightName === 'string') activeLightName = d.activeLightName;
    if (typeof d.savedLightJson === 'string') savedLightJson = d.savedLightJson;
    if (typeof d.activeSetupName === 'string') activeSetupName = d.activeSetupName;
    if (typeof d.savedSetupJson === 'string') savedSetupJson = d.savedSetupJson;
    if (typeof d.legendShow === 'boolean') S.legendShow = d.legendShow;
    if (d.illum) {
      if (isFinite(Number(d.illum.lmPerM))) S.illum.lmPerM = Number(d.illum.lmPerM);
      if (typeof d.illum.dist === 'string') S.illum.dist = d.illum.dist;
      if (typeof d.illum.normal === 'string') S.illum.normal = d.illum.normal;
      const raw = (Array.isArray(d.illum.points) && d.illum.points.length)
        ? d.illum.points
        : (d.illum.probe ? [d.illum.probe] : []);   // 相容遷移：舊檔單點 probe → points（points 為空也回退）
      S.illum.points = raw
        .filter(p => p && isFinite(Number(p.x)) && isFinite(Number(p.y)))
        .map(p => ({ x: Number(p.x), y: Number(p.y), result: null }));
    }
    return true;
  } catch (e) { return false; }
}

function loadLibrary() {
  try { const r = localStorage.getItem(LS_LIBRARY); const d = r ? JSON.parse(r) : null; return (d && Array.isArray(d.forms)) ? d.forms : []; }
  catch (e) { return []; }
}
function saveLibrary(forms) {
  try { localStorage.setItem(LS_LIBRARY, JSON.stringify({ schema: 'cove-library@2', forms })); _storageFailed = false; updateStorageBanner(); return true; }
  catch (e) { _storageFailed = true; updateStorageBanner(); updateLibraryStatus(); return false; }
}
function updateLibraryStatus() {
  const st = document.getElementById('lib-status'); if (!st) return;
  if (_storageFailed) { st.textContent = '⚠ 本機儲存不可用（配額/隱私模式），本次變更不會保留'; st.className = 'hint error'; return; }
  if (activeFormName) {
    const dirty = JSON.stringify(S.cove.form) !== savedFormJson;
    st.textContent = dirty ? `目前：${activeFormName}（已修改，未儲存）` : `目前：${activeFormName}（已同步）`;
    st.className = dirty ? 'hint' : 'hint ok';
  } else { st.textContent = '未命名模板（編輯會自動暫存，按「儲存」存入模板列表）'; st.className = 'hint'; }
  if (typeof updateSetupStatus === 'function') updateSetupStatus();   // 燈槽變更同步設定檔 dirty 標示
}
function renderLibrary() {
  const sel = document.getElementById('lib-select'); if (!sel) return;
  const forms = loadLibrary();
  sel.innerHTML = '';
  forms.forEach(f => { const o = document.createElement('option'); o.value = f.name; o.textContent = f.name; sel.appendChild(o); });
  if (activeFormName) sel.value = activeFormName;
  const nameInp = document.getElementById('lib-name');
  if (nameInp) { if (activeFormName) nameInp.value = activeFormName; else if (!nameInp.value) nameInp.value = nextUnnamedName('未命名模板', forms); }
  updateLibraryStatus();
}
let _pendConfirm = null, _pendTimer = null;
function pendConfirm(key, msg, statusId, refresh) {   // 兩段式確認：回傳 true 表示已確認可執行
  const st = document.getElementById(statusId || 'lib-status');
  if (_pendConfirm === key) { _pendConfirm = null; clearTimeout(_pendTimer); return true; }
  _pendConfirm = key; clearTimeout(_pendTimer);
  _pendTimer = setTimeout(() => { _pendConfirm = null; (refresh || updateLibraryStatus)(); }, 3000);
  if (st) { st.textContent = msg; st.className = 'hint error'; }
  return false;
}
// 下一個未命名名稱：prefix + 最小未使用編號
function nextUnnamedName(prefix, forms) {
  let n = 1; const names = new Set(forms.map(f => f.name));
  while (names.has(prefix + n)) n++;
  return prefix + n;
}
function libSaveAs() {
  const st = document.getElementById('lib-status');
  const name = (document.getElementById('lib-name').value || '').trim();
  if (!name) { st.textContent = '✗ 請先輸入名稱'; st.className = 'hint error'; return; }
  const forms = loadLibrary(), now = Date.now(), copy = JSON.parse(JSON.stringify(S.cove.form));
  const existing = forms.find(f => f.name === name);
  if (existing && !pendConfirm('save:' + name, `「${name}」已存在，再按一次「另存新檔」以覆蓋`)) return;
  if (existing) { existing.form = copy; existing.updatedAt = now; }
  else forms.push({ id: 'f' + now, name, createdAt: now, updatedAt: now, form: copy });
  if (!saveLibrary(forms)) return;
  activeFormName = name; savedFormJson = JSON.stringify(S.cove.form); renderLibrary();
}
function libSave() { if (!activeFormName) { libSaveAs(); return; } document.getElementById('lib-name').value = activeFormName; libSaveAs(); }
function libLoad() {
  const name = document.getElementById('lib-select').value;
  const f = loadLibrary().find(x => x.name === name); if (!f) return;
  activeFormName = name;
  applyForm(JSON.parse(JSON.stringify(f.form)));
  savedFormJson = JSON.stringify(S.cove.form);
  document.getElementById('lib-name').value = name; renderLibrary();
}
function libDelete() {
  const name = document.getElementById('lib-select').value; if (!name) return;
  if (!pendConfirm('del:' + name, `再按一次「刪除」以確認刪除「${name}」`)) return;
  saveLibrary(loadLibrary().filter(f => f.name !== name));
  if (activeFormName === name) { activeFormName = null; savedFormJson = null; }
  const ni = document.getElementById('lib-name'); if (ni && ni.value === name) ni.value = '';  // 清掉被刪名稱→改回預設
  renderLibrary();
}
document.getElementById('lib-save').addEventListener('click', libSave);
document.getElementById('lib-saveas').addEventListener('click', libSaveAs);
document.getElementById('lib-load').addEventListener('click', libLoad);
document.getElementById('lib-delete').addEventListener('click', libDelete);

// ── 光源模板列表（與燈槽模板平行）──────────────────────────────────
const LS_LIGHT_LIB = 'indirect-lighting:light-library@1';
let activeLightName = null, savedLightJson = null;
const lightSerialize = () => JSON.parse(JSON.stringify(S.cove.light));   // 深拷貝（含 fixture）
function syncLightControls() {
  const set = (id, val, unit, dec) => { const el = document.getElementById(id); if (el) el.value = val;
    const vl = document.getElementById(id + '-val'); if (vl) vl.textContent = Number(val).toFixed(dec) + (unit ? ' ' + unit : ''); };
  const L = S.cove.light;
  set('emission-angle', L.emissionAngle, '°', 0); set('rotation-angle', L.rotationAngle, '°', 0);
  set('light-kelvin', L.lightKelvin, 'K', 0); set('light-intensity', L.lightIntensity, '', 0);
}
function loadLightLib() { try { const r = localStorage.getItem(LS_LIGHT_LIB); const d = r ? JSON.parse(r) : null; return (d && Array.isArray(d.lights)) ? d.lights : []; } catch (e) { return []; } }
function saveLightLib(lights) { try { localStorage.setItem(LS_LIGHT_LIB, JSON.stringify({ schema: 'light-library@1', lights })); _storageFailed = false; updateStorageBanner(); return true; } catch (e) { _storageFailed = true; updateStorageBanner(); updateLightStatus(); return false; } }
function updateLightStatus() {
  const st = document.getElementById('light-lib-status'); if (!st) return;
  if (_storageFailed) { st.textContent = '⚠ 本機儲存不可用，本次變更不會保留'; st.className = 'hint error'; return; }
  if (activeLightName) {
    const dirty = JSON.stringify(lightSerialize()) !== savedLightJson;
    st.textContent = dirty ? `目前：${activeLightName}（已修改，未儲存）` : `目前：${activeLightName}（已同步）`;
    st.className = dirty ? 'hint' : 'hint ok';
  } else { st.textContent = '未命名光源（按「儲存」存入光源列表）'; st.className = 'hint'; }
  if (typeof updateSetupStatus === 'function') updateSetupStatus();   // 光源變更同步設定檔 dirty 標示
}
function renderLightLib() {
  const sel = document.getElementById('light-lib-select'); if (!sel) return;
  const lights = loadLightLib();
  sel.innerHTML = '';
  lights.forEach(l => { const o = document.createElement('option'); o.value = l.name; o.textContent = l.name; sel.appendChild(o); });
  if (activeLightName) sel.value = activeLightName;
  const nameInp = document.getElementById('light-lib-name');
  if (nameInp) { if (activeLightName) nameInp.value = activeLightName; else if (!nameInp.value) nameInp.value = nextUnnamedName('未命名光源', lights); }
  updateLightStatus();
}
function lightSaveAs() {
  const st = document.getElementById('light-lib-status');
  const name = (document.getElementById('light-lib-name').value || '').trim();
  if (!name) { st.textContent = '✗ 請先輸入名稱'; st.className = 'hint error'; return; }
  const lights = loadLightLib(), now = Date.now(), data = lightSerialize();
  const existing = lights.find(l => l.name === name);
  if (existing && !pendConfirm('lsave:' + name, `「${name}」已存在，再按一次「另存新檔」以覆蓋`, 'light-lib-status', updateLightStatus)) return;
  if (existing) { existing.light = data; existing.updatedAt = now; }
  else lights.push({ id: 'L' + now, name, createdAt: now, updatedAt: now, light: data });
  if (!saveLightLib(lights)) return;
  activeLightName = name; savedLightJson = JSON.stringify(data); renderLightLib();
}
function lightSave() { if (!activeLightName) { lightSaveAs(); return; } document.getElementById('light-lib-name').value = activeLightName; lightSaveAs(); }
function lightLoad() {
  const name = document.getElementById('light-lib-select').value;
  const l = loadLightLib().find(x => x.name === name); if (!l) return;
  activeLightName = name; Object.assign(S.cove.light, JSON.parse(JSON.stringify(l.light))); savedLightJson = JSON.stringify(lightSerialize());
  syncLightControls(); syncFixtureControls(); redraw();
  document.getElementById('light-lib-name').value = name; renderLightLib();
}
function lightDelete() {
  const name = document.getElementById('light-lib-select').value; if (!name) return;
  if (!pendConfirm('ldel:' + name, `再按一次「刪除」以確認刪除「${name}」`, 'light-lib-status', updateLightStatus)) return;
  saveLightLib(loadLightLib().filter(l => l.name !== name));
  if (activeLightName === name) { activeLightName = null; savedLightJson = null; }
  const ni = document.getElementById('light-lib-name'); if (ni && ni.value === name) ni.value = '';
  renderLightLib();
}
document.getElementById('light-lib-save').addEventListener('click', lightSave);
document.getElementById('light-lib-saveas').addEventListener('click', lightSaveAs);
document.getElementById('light-lib-load').addEventListener('click', lightLoad);
document.getElementById('light-lib-delete').addEventListener('click', lightDelete);

// 光源掛點（資料屬 S.cove.light.fixture；與燈槽分離；UI 在光源分頁）
function syncFixtureControls() {
  const f = S.cove.light.fixture;
  const fu = document.getElementById('fixture-u'), fd = document.getElementById('fixture-d');
  if (fu && document.activeElement !== fu) fu.value = Math.round(f.u * 1000);
  if (fd && document.activeElement !== fd) fd.value = Math.round(f.d * 1000);
}
(function bindFixture() {
  const fu = document.getElementById('fixture-u'), fd = document.getElementById('fixture-d');
  const upd = () => { redraw(); if (typeof updateLightStatus === 'function') updateLightStatus(); };
  if (fu) fu.addEventListener('input', () => { const v = parseFloat(fu.value); if (isFinite(v)) { S.cove.light.fixture.u = clamp(v / 1000, -0.05, S.room.W); upd(); } });
  if (fd) fd.addEventListener('input', () => { const v = parseFloat(fd.value); if (isFinite(v)) { S.cove.light.fixture.d = clamp(v / 1000, 0, S.room.H); upd(); } });
})();

// 將整份狀態同步回各分頁控件（session 還原後呼叫）
function syncAllControls() {
  const set = (id, val, unit, dec) => { const el = document.getElementById(id); if (el) el.value = val;
    const vl = document.getElementById(id + '-val'); if (vl) vl.textContent = Number(val).toFixed(dec) + (unit ? ' ' + unit : ''); };
  const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = v; };
  set('room-width', S.room.W * 1000, 'mm', 0); set('room-height', S.room.H * 1000, 'mm', 0);
  set('refl-ceiling', S.refl.ceiling, '', 2); set('refl-wall', S.refl.wall, '', 2); set('refl-floor', S.refl.floor, '', 2);
  chk('wall-refl-left', S.wallReflect.left); chk('wall-refl-right', S.wallReflect.right);
  chk('side-left', S.sides.left); chk('side-right', S.sides.right);
  set('ray-density', S.ray.density, '條', 0); set('ray-bounces', S.ray.bounces, '次', 0);
  set('eye-height', S.eye.height * 1000, 'mm', 0); set('eye-x', S.eye.xRatio, '', 2); chk('eye-show', S.eye.show);
  set('glare-width', S.glare.width * 1000, 'mm', 0); set('glare-height', S.glare.height * 1000, 'mm', 0);
  const gh = document.getElementById('glare-hanchor'); if (gh) gh.value = S.glare.hAnchor;
  const gv = document.getElementById('glare-vanchor'); if (gv) gv.value = S.glare.vAnchor;
  chk('theme-light', S.theme === 'light');
  set('emission-angle', S.cove.light.emissionAngle, '°', 0); set('rotation-angle', S.cove.light.rotationAngle, '°', 0);
  set('light-kelvin', S.cove.light.lightKelvin, 'K', 0); set('light-intensity', S.cove.light.lightIntensity, '', 0);
  const lm = document.getElementById('illum-lm'); if (lm) lm.value = S.illum.lmPerM;
  const idist = document.getElementById('illum-dist'); if (idist) idist.value = S.illum.dist;
  const inrm = document.getElementById('illum-normal'); if (inrm) inrm.value = S.illum.normal;
  chk('legend-show', S.legendShow);
  const lb = document.getElementById('legend-block'); if (lb) lb.style.display = S.legendShow ? '' : 'none';
}

// 將 S 的數值欄位夾制至合法範圍（防止損壞/越界的本機或匯入資料造成無效狀態）
function sanitizeState() {
  const cn = (v, lo, hi, def) => { const n = Number(v); return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  S.room.W = cn(S.room.W, 2, 20, 8);
  S.room.H = cn(S.room.H, 2.2, 6, 3);
  S.refl.ceiling = cn(S.refl.ceiling, 0, 1, 0.85);
  S.refl.wall = cn(S.refl.wall, 0, 1, 0.75);
  S.refl.floor = cn(S.refl.floor, 0, 1, 0.35);
  S.wallReflect.left = S.wallReflect.left !== false;
  S.wallReflect.right = S.wallReflect.right !== false;
  S.sides.left = S.sides.left !== false;
  S.sides.right = S.sides.right !== false;
  S.ray.density = Math.round(cn(S.ray.density, 4, 5000, 20));
  S.ray.bounces = Math.round(cn(S.ray.bounces, 0, 6, 1));
  S.eye.height = cn(S.eye.height, 0.5, 2.2, 1.65);
  S.eye.xRatio = cn(S.eye.xRatio, 0, 1, 0.5);
  S.eye.show = S.eye.show !== false;
  S.glare.width = cn(S.glare.width, 0, 0.5, 0.08);
  S.glare.height = cn(S.glare.height, 0, 0.5, 0.04);
  if (!['wall', 'center', 'interior'].includes(S.glare.hAnchor)) S.glare.hAnchor = 'wall';
  if (!['top', 'center', 'bottom'].includes(S.glare.vAnchor)) S.glare.vAnchor = 'center';
  if (S.theme !== 'light') S.theme = 'dark';
  S.legendShow = S.legendShow !== false;
  const L = S.cove.light;
  L.emissionAngle = cn(L.emissionAngle, 10, 360, 180);
  L.rotationAngle = cn(L.rotationAngle, -180, 180, 0);
  L.lightKelvin = cn(L.lightKelvin, 2700, 6500, 3000);
  L.lightIntensity = cn(L.lightIntensity, 100, 2000, 800);
  const fx = L.fixture || {};
  L.fixture = { u: cn(fx.u, -0.05, S.room.W, 0.09), d: cn(fx.d, 0, S.room.H, 0.20) };
  S.illum.lmPerM = cn(S.illum.lmPerM, 0, 1e6, 1000);
  if (S.illum.dist !== 'uniform') S.illum.dist = 'lambert';
  if (!NORMAL_VEC[S.illum.normal]) S.illum.normal = 'up';
  S.illum.points = (Array.isArray(S.illum.points) ? S.illum.points : [])
    .filter(p => p && isFinite(Number(p.x)) && isFinite(Number(p.y)))
    .map(p => ({ x: cn(p.x, 0, S.room.W, 0), y: cn(p.y, 0, S.room.H, 0), result: null }));
  S.illum.placing = false;
}

loadSession();                       // 還原上次 session（毀損則保留預設經典）
sanitizeState();                     // 夾制還原值至合法範圍
// 作用中名稱若已不在庫中（他處刪除）→ 視為未命名草稿，避免狀態誤報
if (activeFormName && !loadLibrary().some(f => f.name === activeFormName)) { activeFormName = null; savedFormJson = null; }
if (activeLightName && !loadLightLib().some(l => l.name === activeLightName)) { activeLightName = null; savedLightJson = null; }
{
  const _setupEntry = activeSetupName ? loadSetupLib().find(s => s.name === activeSetupName) : null;
  if (activeSetupName && !_setupEntry) { activeSetupName = null; savedSetupJson = null; }
  else if (_setupEntry) savedSetupJson = JSON.stringify(_setupEntry.setup);   // 以庫中現值為基準，避免他處覆寫後 dirty 誤判
}
ensureUniqueIds(S.cove.form);
selectedElementId = (S.cove.form.elements[0] || {}).id || null;
syncAllControls();
renderTemplateButtons();
renderLibrary();
renderCoveEditor();
renderLightLib();
renderSetupLib();
const lightChanged = () => { if (typeof updateLightStatus === 'function') updateLightStatus(); };
bindSlider('emission-angle', 'emission-angle-val', '°', 0, v => { S.cove.light.emissionAngle = v; lightChanged(); });
bindSlider('rotation-angle', 'rotation-angle-val', '°', 0, v => { S.cove.light.rotationAngle = v; lightChanged(); });
bindSlider('light-kelvin',   'light-kelvin-val',   'K', 0, v => { S.cove.light.lightKelvin   = v; lightChanged(); });
bindSlider('light-intensity', 'light-intensity-val', '', 0, v => { S.cove.light.lightIntensity = v; lightChanged(); });
bindSlider('ray-density',  'ray-density-val',  '條', 0, v => { S.ray.density  = v; });
bindSlider('ray-bounces',  'ray-bounces-val',  '次', 0, v => { S.ray.bounces  = v; });

// 視角
document.getElementById('theme-light').addEventListener('change', e => { S.theme = e.target.checked ? 'light' : 'dark'; redraw(); });
document.getElementById('legend-show').addEventListener('change', e => { S.legendShow = e.target.checked; document.getElementById('legend-block').style.display = e.target.checked ? '' : 'none'; if (typeof scheduleSave === 'function') scheduleSave(); });
document.getElementById('eye-show').addEventListener('change', e => { S.eye.show = e.target.checked; redraw(); });
bindSlider('eye-height', 'eye-height-val', 'mm', 0, v => { S.eye.height = v / 1000; });
bindSlider('eye-x',      'eye-x-val',      '', 2,  v => { S.eye.xRatio = v; });
bindSlider('glare-width',  'glare-width-val',  'mm', 0, v => { S.glare.width  = v / 1000; });
bindSlider('glare-height', 'glare-height-val', 'mm', 0, v => { S.glare.height = v / 1000; });
document.getElementById('glare-hanchor').addEventListener('change', e => { S.glare.hAnchor = e.target.value; redraw(); });
document.getElementById('glare-vanchor').addEventListener('change', e => { S.glare.vAnchor = e.target.value; redraw(); });

// 照度（指定點估算）
function updateIllumPlaceBtn() {
  const b = document.getElementById('illum-place'); if (!b) return;
  b.classList.toggle('active', !!S.illum.placing);
  b.textContent = S.illum.placing ? '完成放置' : '＋ 放置量測點';
}
(function bindIllum() {
  const lm = document.getElementById('illum-lm');
  if (lm) lm.addEventListener('input', () => { const v = parseFloat(lm.value); if (isFinite(v)) { S.illum.lmPerM = Math.max(0, v); recomputeIlluminance(); } });
  const dist = document.getElementById('illum-dist');
  if (dist) dist.addEventListener('change', e => { S.illum.dist = e.target.value; recomputeIlluminance(); });
  const nrm = document.getElementById('illum-normal');
  if (nrm) nrm.addEventListener('change', e => { S.illum.normal = e.target.value; recomputeIlluminance(); redraw(); });
  const place = document.getElementById('illum-place');
  if (place) place.addEventListener('click', () => { S.illum.placing = !S.illum.placing; updateIllumPlaceBtn(); canvas.style.cursor = S.illum.placing ? 'crosshair' : 'grab'; });
  const clear = document.getElementById('illum-clear');
  if (clear) clear.addEventListener('click', () => {
    if (dragState && dragState.kind === 'probe') endDrag();   // 清空前結束任何進行中的量測點拖曳，避免殘留 dragState
    S.illum.points = []; S.illum.placing = false; updateIllumPlaceBtn(); renderIllumResult(); redraw();
  });
  const result = document.getElementById('illum-result');   // 委派逐點刪除
  if (result) result.addEventListener('click', e => {
    const del = e.target.closest('.illum-del'); if (!del) return;
    const idx = Number(del.dataset.idx);
    if (idx >= 0 && idx < S.illum.points.length) {
      if (dragState && dragState.kind === 'probe') endDrag();   // 刪除前結束拖曳，避免索引位移後移動到錯誤的點
      S.illum.points.splice(idx, 1); recomputeIlluminance(); renderIllumResult(); redraw();
    }
  });
  window.addEventListener('keydown', e => {   // Esc 取消放置模式
    if (e.key === 'Escape' && S.illum.placing) { S.illum.placing = false; updateIllumPlaceBtn(); canvas.style.cursor = 'grab'; }
  });
})();

// ══ 縮放 / 平移互動 ═══════════════════════════════════════════════
canvas.style.cursor = 'grab';
const _vpScale = () => { const r = canvas.getBoundingClientRect(); return canvas.width / (r.width || 1); };

// 滾輪縮放（以游標為焦點）
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const k = canvas.width / (rect.width || 1);
  const sx = (e.clientX - rect.left) * k, sy = (e.clientY - rect.top) * k;
  zoomAt(sx, sy, e.deltaY < 0 ? 1.12 : 1 / 1.12);
}, { passive: false });

// ── 編輯拖曳 + 平移 ──────────────────────────────────────────────
const coveTabActive = () => { const t = document.getElementById('tab-cove'); return t && t.classList.contains('active'); };
const lightTabActive = () => { const t = document.getElementById('tab-light'); return t && t.classList.contains('active'); };
const viewTabActive = () => { const t = document.getElementById('tab-view'); return t && t.classList.contains('active'); };
const illumTabActive = () => { const t = document.getElementById('tab-illum'); return t && t.classList.contains('active'); };
const evScreen = (e) => { const r = canvas.getBoundingClientRect(), k = canvas.width / (r.width || 1); return { sx: (e.clientX - r.left) * k, sy: (e.clientY - r.top) * k }; };
// 螢幕 → 局部 (u,d)：依側別還原鏡像
function screenToLocal(sx, sy, side) {
  const { W, H } = S.room;
  const x = (sx - _ox) / _scale, y = (_oy - sy) / _scale;
  return { u: side === 'L' ? x : W - x, d: H - y };
}
const SNAP = 0.005;                                   // 5mm 格線吸附
const snapV = (v) => Math.round(v / SNAP) * SNAP;
const HANDLE_PX = 10;
// 命中把手（選取元件頂點 / 光源把手）→ {kind, side, el, pi} 或 null
function pickHandle(sx, sy) {
  const { W, H } = S.room;
  const sides = []; if (S.sides.left) sides.push('L'); if (S.sides.right) sides.push('R');
  let best = null, bestD = HANDLE_PX;
  // 照度量測點：僅在「照度」分頁可拖曳（取最近且在命中半徑內者）
  if (illumTabActive()) {
    S.illum.points.forEach((p, idx) => {
      const dd = Math.hypot(mx(p.x) - sx, my(p.y) - sy);
      if (dd < bestD) { bestD = dd; best = { kind: 'probe', idx }; }
    });
    return best;
  }
  // 眩光框縮放把手：僅在「視角」分頁可拖曳（角把手優先，較易抓取）
  if (viewTabActive()) {
    for (const side of sides) {
      for (const hd of glareHandles(side).handles) {
        const dd = Math.hypot(mx(hd.x) - sx, my(hd.y) - sy);
        const bias = hd.kind === 'glareWH' ? 0.5 : 0;   // 角把手稍微優先
        if (dd - bias < bestD) { bestD = dd; best = { kind: hd.kind, side, sH: hd.sH, sV: hd.sV }; }
      }
    }
    return best;
  }
  // 光源把手：僅在「光源」分頁可拖曳
  if (lightTabActive()) {
    const fx = S.cove.light.fixture;
    for (const side of sides) {
      const w = toWorld(fx.u, fx.d, side, W, H);
      const dd = Math.hypot(mx(w.x) - sx, my(w.y) - sy);
      if (dd < bestD) { bestD = dd; best = { kind: 'fixture', side }; }
    }
    return best;
  }
  // 頂點/弧端點：僅在「燈槽」分頁
  if (!coveTabActive()) return null;
  const el = S.cove.form.elements.find(e => e.id === selectedElementId);
  if (el && !el.hidden) {
    if (el.path.kind === 'arc') {
      arcEndpoints(el.path).forEach((p, which) => {
        for (const side of sides) {
          const w = toWorld(p.u, p.d, side, W, H);
          const dd = Math.hypot(mx(w.x) - sx, my(w.y) - sy);
          if (dd < bestD) { bestD = dd; best = { kind: 'arcEnd', side, el, which }; }
        }
      });
    } else {
      el.path.points.forEach((p, pi) => {
        for (const side of sides) {
          const w = toWorld(p.u, p.d, side, W, H);
          const dd = Math.hypot(mx(w.x) - sx, my(w.y) - sy);
          if (dd < bestD) { bestD = dd; best = { kind: 'vertex', side, el, pi }; }
        }
      });
    }
  }
  return best;
}
// 與某頂點重合的「其他元件」頂點（局部座標 1e-4 內）
function coincidentVertices(elId, pt) {
  const out = [];
  if (!pt) return out;
  for (const el of S.cove.form.elements) {
    if (el.id === elId || el.path.kind === 'arc') continue;
    for (const p of el.path.points) if (Math.hypot(p.u - pt.u, p.d - pt.d) < 1e-4) out.push({ el: el.id, pid: p.pid });
  }
  return out;
}
// 拖曳吸附：找最近「其他頂點」（10px 內，跨元件/側別），回傳其局部座標 + {el,pid}；exclude 內者不吸附
function findSnapTarget(sx, sy, dragEl, dragPid, exclude) {
  const { W, H } = S.room; const sides = []; if (S.sides.left) sides.push('L'); if (S.sides.right) sides.push('R');
  let best = null, bestD = HANDLE_PX;
  for (const el of S.cove.form.elements) {
    if (el.hidden || el.path.kind === 'arc' || el.id === dragEl.id) continue;  // 不與同元件相黏（避免塌陷）
    for (const p of el.path.points) {
      if (exclude && exclude.some(x => x.el === el.id && x.pid === p.pid)) continue;
      for (const side of sides) {
        const w = toWorld(p.u, p.d, side, W, H);
        const dd = Math.hypot(mx(w.x) - sx, my(w.y) - sy);
        if (dd < bestD) { bestD = dd; best = { el, pid: p.pid, u: p.u, d: p.d }; }
      }
    }
  }
  return best;
}
// 點是否在多邊形內（世界座標 ray-casting）
function pointInPoly(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y, xj = pts[j].x, yj = pts[j].y;
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
// 點到線段距離（螢幕像素）
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0; t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// 細長面板：游標是否靠近其中心線（螢幕 6px 內）
function nearCenterline(el, side, sx, sy) {
  const { W, H } = S.room, pts = elementCenterline(el).map(p => { const w = toWorld(p.u, p.d, side, W, H); return { x: mx(w.x), y: my(w.y) }; });
  for (let i = 0; i < pts.length - 1; i++) if (distToSeg(sx, sy, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y) <= 6) return true;
  return false;
}
// 命中元件本體 → {el, side}；元件由上而下（清單後者在上），側別右先於左（繪製順序）
function pickBody(sx, sy) {
  if (!coveTabActive() || !_scene) return null;
  const wx = (sx - _ox) / _scale, wy = (_oy - sy) / _scale;
  const els = S.cove.form.elements;
  for (let i = els.length - 1; i >= 0; i--) {
    const el = els[i]; if (el.hidden) continue;
    for (const sc of [_scene.rightCove, _scene.leftCove]) {
      if (!sc) continue;
      const loop = sc.loops.find(l => l.id === el.id);
      const inside = loop && pointInPoly(wx, wy, loop.pts);
      const onLine = el.kind !== 'polygon' && nearCenterline(el, sc.side, sx, sy);  // 細長面板/弧線沿線可抓
      if (inside || onLine) return { el, side: sc.side };
    }
  }
  return null;
}

// ── Undo / Redo（form 快照）──
let undoStack = [], redoStack = [];
function snapshot() {
  const cur = JSON.stringify(S.cove.form);
  if (undoStack.length && undoStack[undoStack.length - 1] === cur) return; // 去重，避免重複/無變更快照
  undoStack.push(cur); if (undoStack.length > 60) undoStack.shift(); redoStack = [];
}
function restoreForm(json) {
  S.cove.form = JSON.parse(json);
  const sel = S.cove.form.elements.find(e => e.id === selectedElementId);
  selectedElementId = sel ? sel.id : (S.cove.form.elements[0] || {}).id || null;
  refreshEditor();
}
function undo() { if (!undoStack.length) return; redoStack.push(JSON.stringify(S.cove.form)); restoreForm(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(JSON.stringify(S.cove.form)); restoreForm(redoStack.pop()); }
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (!coveTabActive()) return;   // 復原僅作用於燈槽幾何編輯
  const k = e.key.toLowerCase();
  if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
});

// 方向鍵微調選取元件（焦點不在輸入欄位時）：1mm，Shift=10mm
let _nudgeActive = false, _nudgeTimer = null;
function nudgeSelected(du, dd) {
  const el = S.cove.form.elements.find(e => e.id === selectedElementId);
  if (!el || el.hidden) return false;
  if (!_nudgeActive) { snapshot(); _nudgeActive = true; }   // 連續微調算一次 Undo
  clearTimeout(_nudgeTimer); _nudgeTimer = setTimeout(() => { _nudgeActive = false; renderCoveEditor(); }, 600);
  const mv = (p) => { p.u = clamp(p.u + du, -0.05, S.room.W); p.d = clamp(p.d + dd, 0, S.room.H); };
  if (el.path.kind === 'arc') mv(el.path.center);
  else {
    el.path.points.forEach(mv);
    // 相黏夥伴整串「剛體平移」跟隨（同位移、不被拉拽變形）
    for (const id of bondedComponentIncluding(el.id)) {
      if (id === el.id) continue;
      const pe = S.cove.form.elements.find(x => x.id === id);
      if (pe && pe.path && pe.path.kind !== 'arc') pe.path.points.forEach(mv);
    }
  }
  redraw();
  return true;
}
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!coveTabActive() || !selectedElementId) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return; // 欄位內 → 交給欄位
  const step = e.shiftKey ? 0.01 : 0.001;
  let handled = false;
  if (e.key === 'ArrowRight') handled = nudgeSelected(step, 0);
  else if (e.key === 'ArrowLeft') handled = nudgeSelected(-step, 0);
  else if (e.key === 'ArrowDown') handled = nudgeSelected(0, step);
  else if (e.key === 'ArrowUp') handled = nudgeSelected(0, -step);
  if (handled) e.preventDefault();
});

// ── 滑鼠：拖曳把手 / 平移 ──
let _dragging = false, _lastX = 0, _lastY = 0;
let dragState = null, dragBadge = null;
// 開始指標互動（滑鼠/觸控共用）：回傳 'drag'（已開始編輯拖曳）或 'pan'（應改為平移）。
// mod = { alt, ctrl } 修飾鍵（觸控皆 false）。
function beginPointer(sx, sy, mod) {
  // 照度分頁＋放置模式：在點擊處新增量測點並立即拖曳微調；放置模式維持開啟以連續放置多點
  if (illumTabActive() && S.illum.placing) {
    const wx = (sx - _ox) / _scale, wy = (_oy - sy) / _scale;
    const idx = S.illum.points.push({ x: clamp(wx, 0, S.room.W), y: clamp(wy, 0, S.room.H), result: null }) - 1;
    dragState = { kind: 'probe', idx }; _dragging = false; canvas.style.cursor = 'grabbing';
    recomputeIlluminance(); redraw(); return 'drag';
  }
  // 非放置模式：照度量測點走一般把手命中（拖曳既有點），空白處落到平移
  const hit = pickHandle(sx, sy);
  if (hit) {
    if (hit.kind !== 'fixture' && hit.kind !== 'probe' && !hit.kind.startsWith('glare')) snapshot();   // 光源/眩光框/量測點拖曳不進燈槽 Undo
    if (hit.kind === 'vertex') {
      const pt = hit.el.path.points[hit.pi];
      hit.excludeSnap = coincidentVertices(hit.el.id, pt);
      if (mod.alt) {
        // Alt：脫離黏合 → 解除此頂點相黏後自由變形、不吸附、不連動
        if (pt && isBonded(hit.el.id, pt.pid)) detachVertex(hit.el.id, pt.pid);
      } else if (pt && isBonded(hit.el.id, pt.pid) && !mod.ctrl) {
        // 預設：被拖元件變形，相黏夥伴整體平移（剛體跟隨、不被拉伸）
        hit.anchorU = pt.u; hit.anchorD = pt.d;
        hit.partnerMove = snapshotPointEls(bondedPartnerComponent(hit.el.id, pt.pid));
      }
      // Ctrl（且相黏）：不設 partnerMove → dragMove 走 propagateJoint（接點被拉、夥伴變形）
    }
    dragState = hit; _dragging = false; canvas.style.cursor = 'grabbing'; return 'drag';
  }
  const body = pickBody(sx, sy);   // 點在元件本體內 → 選取並移動
  if (body) {
    snapshot();
    selectedElementId = body.el.id;
    const el = body.el, loc = screenToLocal(sx, sy, body.side);
    const ds = { kind: 'body', side: body.side, el, startU: loc.u, startD: loc.d, orig: JSON.parse(JSON.stringify(el.path)) };
    if (mod.alt) {
      detachElementJoints(el.id);                          // Alt：脫離黏合後單獨移動
    } else if (mod.ctrl) {
      ds.mode = 'deform';                                  // Ctrl：接點被拉、夥伴變形
    } else {
      ds.mode = 'rigid';                                   // 預設：整串相黏物件剛體平移（不變形）
      ds.partners = snapshotPointEls(bondedComponentIncluding(el.id)).filter(g => g.id !== el.id);
    }
    dragState = ds;
    renderCoveEditor(); redraw(); canvas.style.cursor = 'grabbing'; return 'drag';
  }
  return 'pan';
}
canvas.addEventListener('mousedown', (e) => {
  const { sx, sy } = evScreen(e);
  if (beginPointer(sx, sy, { alt: e.altKey, ctrl: e.ctrlKey || e.metaKey }) === 'pan') {
    _dragging = true; _lastX = e.clientX; _lastY = e.clientY; canvas.style.cursor = 'grabbing';
  }
});
// 拖曳中更新（滑鼠/觸控共用）。mod = { alt }（觸控 alt=false）。
function dragMove(sx, sy, mod) {
    if (dragState.el && !S.cove.form.elements.includes(dragState.el)) { endDrag(); return; } // 元件已被刪除
    if (dragState.kind === 'probe') {
      const pt = S.illum.points[dragState.idx];
      if (!pt) { endDrag(); return; }
      const wx = (sx - _ox) / _scale, wy = (_oy - sy) / _scale;
      pt.x = clamp(wx, 0, S.room.W); pt.y = clamp(wy, 0, S.room.H);
      dragBadge = { sx, sy, text: `量測點 ${dragState.idx + 1} u${Math.round(pt.x * 1000)} / 高${Math.round(pt.y * 1000)} mm` };
      redraw(); return;   // 重算由 redraw 的 scheduleIllum debounce 處理，拖曳不卡頓
    }
    if (dragState.kind === 'glareW' || dragState.kind === 'glareH' || dragState.kind === 'glareWH') {
      const wx = (sx - _ox) / _scale, wy = (_oy - sy) / _scale;
      const fxp = S.cove.light.fixture, lw = toWorld(fxp.u, fxp.d, dragState.side, S.room.W, S.room.H);
      const snapC = v => clamp(Math.round(Math.max(0, v) / 0.001) * 0.001, 0, 0.5);   // 對齊滑桿 0~500mm / 1mm，夾在 0 以上
      // 投影到燈具局部軸（含自體旋轉）：右側 φ 已鏡像
      const phi = (dragState.side === 'L' ? 1 : -1) * (S.cove.light.rotationAngle || 0) * Math.PI / 180;
      const dx = wx - lw.x, dy = wy - lw.y;
      const c = Math.cos(phi), s = Math.sin(phi);
      const localX = dx * c + dy * s;
      const localY = -dx * s + dy * c;
      if (dragState.sH) S.glare.width  = snapC(localX * dragState.sH * (S.glare.hAnchor === 'center' ? 2 : 1));
      if (dragState.sV) S.glare.height = snapC(localY * dragState.sV * (S.glare.vAnchor === 'center' ? 2 : 1));
      const setG = (id, val) => { const el = document.getElementById(id); if (el) el.value = Math.round(val * 1000);
        const vl = document.getElementById(id + '-val'); if (vl) vl.textContent = Math.round(val * 1000) + ' mm'; };
      setG('glare-width', S.glare.width); setG('glare-height', S.glare.height);
      dragBadge = { sx, sy, text: `寬 ${Math.round(S.glare.width * 1000)}, 高 ${Math.round(S.glare.height * 1000)} mm` };
      redraw(); return;
    }
    const loc = screenToLocal(sx, sy, dragState.side);
    if (dragState.kind === 'arcEnd') {
      // 拖曳端點 = 調整角度（圓心、半徑不變）。以「解纏繞」避免跨 ±180 時掃掠角暴衝/反向。
      const a = dragState.el.path;
      const raw = Math.round(Math.atan2(loc.d - a.center.d, loc.u - a.center.u) * 180 / Math.PI);
      const clampSweep = (s) => (s >= 0 ? 1 : -1) * clamp(Math.abs(s), 1, 350);  // 避免 0/≥360 退化
      if (dragState.which === 0) {
        const oldEnd = a.startDeg + a.sweepDeg;
        const ns = unwrapAngle(raw, a.startDeg);          // 接近原起始角的等價角
        a.startDeg = ns; a.sweepDeg = clampSweep(oldEnd - ns);
      } else {
        const ne = unwrapAngle(raw, a.startDeg + a.sweepDeg);
        a.sweepDeg = clampSweep(ne - a.startDeg);
      }
      dragBadge = { sx, sy, text: `掃掠 ${Math.round(a.sweepDeg)}°` };
      redraw(); return;
    }
    if (dragState.kind === 'body') {
      const du = snapV(loc.u - dragState.startU), dd = snapV(loc.d - dragState.startD), o = dragState.orig, el = dragState.el;
      // 移動被拖元件本身（弧線移圓心、其餘移點列）
      if (el.path.kind === 'arc') el.path.center = { u: o.center.u + du, d: o.center.d + dd };
      else el.path.points = o.points.map(p => ({ pid: p.pid, u: clamp(p.u + du, -0.05, S.room.W), d: clamp(p.d + dd, 0, S.room.H) }));
      if (dragState.mode === 'rigid' && dragState.partners) {      // 相黏夥伴整串剛體平移（同位移、不變形）
        for (const g of dragState.partners) {
          const pe = S.cove.form.elements.find(x => x.id === g.id); if (!pe) continue;
          pe.path.points = g.orig.map(p => ({ pid: p.pid, u: clamp(p.u + du, -0.05, S.room.W), d: clamp(p.d + dd, 0, S.room.H) }));
        }
      } else if (dragState.mode === 'deform') {                    // Ctrl：接點被拉、夥伴變形
        propagateElementJoints(el.id);
      }
      // 'free'（Alt）或弧線：不連動夥伴
      dragBadge = { sx, sy, text: `移動 Δu ${Math.round(du * 1000)}, Δd ${Math.round(dd * 1000)} mm` };
      redraw(); return;
    }
    // 夾在合理局部範圍：u ∈ [-50mm, 室寬]，d ∈ [0, 室高]
    const u = clamp(snapV(loc.u), -0.05, S.room.W);
    const d = clamp(snapV(loc.d), 0, S.room.H);
    if (dragState.kind === 'vertex') {
      const pt = dragState.el.path.points[dragState.pi];                    // 原地改值，保留 pid（被拖元件變形）
      const snap = mod.alt ? null : findSnapTarget(sx, sy, dragState.el, pt.pid, dragState.excludeSnap);  // Alt=不吸附
      if (snap) { pt.u = snap.u; pt.d = snap.d; dragState.snap = snap; dragBadge = { sx, sy, text: '放開即相黏 ⛓' }; }
      else { pt.u = u; pt.d = d; dragState.snap = null; dragBadge = { sx, sy, text: `u ${Math.round(u * 1000)}, d ${Math.round(d * 1000)} mm` }; }
      if (dragState.partnerMove) {   // 預設：相黏夥伴整體平移（剛體跟隨，與接點保持貼合、不變形）
        const du = pt.u - dragState.anchorU, dd = pt.d - dragState.anchorD;
        for (const g of dragState.partnerMove) {
          const pe = S.cove.form.elements.find(el => el.id === g.id); if (!pe) continue;
          pe.path.points = g.orig.map(p => ({ pid: p.pid, u: clamp(p.u + du, -0.05, S.room.W), d: clamp(p.d + dd, 0, S.room.H) }));
        }
      } else {
        propagateJoint(dragState.el.id, pt.pid);   // Ctrl（接點被拉、夥伴變形）或未相黏（吸附）→ 同步接點座標
      }
    } else {   // fixture（光源分頁）→ 改 S.cove.light.fixture，標記光源已修改
      S.cove.light.fixture = { u, d }; dragBadge = { sx, sy, text: `u ${Math.round(u * 1000)}, d ${Math.round(d * 1000)} mm` };
      if (typeof updateLightStatus === 'function') updateLightStatus();
    }
    redraw();
}
window.addEventListener('mousemove', (e) => {
  if (dragState) { const { sx, sy } = evScreen(e); dragMove(sx, sy, { alt: e.altKey }); return; }
  if (!_dragging) return;
  const k = _vpScale();
  _panX += (e.clientX - _lastX) * k; _panY += (e.clientY - _lastY) * k;
  _lastX = e.clientX; _lastY = e.clientY;
  clampPan(); redraw();
});
function endDrag() {
  if (dragState) {
    if (dragState.kind === 'vertex' && dragState.snap) {   // 放開於吸附目標 → 相黏
      const pt = dragState.el.path.points[dragState.pi];
      if (pt) bondVertices({ el: dragState.el.id, pid: pt.pid }, { el: dragState.snap.el.id, pid: dragState.snap.pid });
    }
    dragState = null; dragBadge = null; canvas.style.cursor = 'grab'; renderCoveEditor(); redraw();
  }
  _dragging = false; canvas.style.cursor = 'grab';
}
window.addEventListener('mouseup', endDrag);
window.addEventListener('blur', endDrag);   // 視窗失焦/滑鼠移出時結束拖曳，避免卡住
// hover：在把手或元件本體上顯示可拖曳游標
canvas.addEventListener('mousemove', (e) => {
  if (dragState || _dragging) return;
  const { sx, sy } = evScreen(e);
  if (illumTabActive() && S.illum.placing) { canvas.style.cursor = 'crosshair'; return; }   // 放置模式：點擊新增量測點
  canvas.style.cursor = (pickHandle(sx, sy) || pickBody(sx, sy)) ? 'move' : 'grab';
});

// 觸控：單指（命中把手/元件/探針→編輯拖曳，否則平移）、雙指縮放
let _touchMode = null, _tLastX = 0, _tLastY = 0, _tStartDist = 0, _tStartZoom = 1;
const _touchDist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
canvas.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    const { sx, sy } = evScreen(e.touches[0]);          // Touch 具 clientX/Y，可直接用 evScreen
    if (beginPointer(sx, sy, { alt: false, ctrl: false }) === 'drag') {
      _touchMode = 'edit'; e.preventDefault();          // 命中→編輯拖曳
    } else {
      _touchMode = 'pan'; _tLastX = e.touches[0].clientX; _tLastY = e.touches[0].clientY;
    }
  } else if (e.touches.length === 2) {
    if (dragState) endDrag();                           // 第二指落下→取消編輯、改縮放
    _touchMode = 'pinch'; _tStartDist = _touchDist(e.touches) || 1; _tStartZoom = _zoom;
  }
}, { passive: false });
canvas.addEventListener('touchmove', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const k = canvas.width / (rect.width || 1);
  if (_touchMode === 'edit' && dragState && e.touches.length === 1) {
    const { sx, sy } = evScreen(e.touches[0]);
    dragMove(sx, sy, { alt: false });
  } else if (_touchMode === 'pan' && e.touches.length === 1) {
    _panX += (e.touches[0].clientX - _tLastX) * k;
    _panY += (e.touches[0].clientY - _tLastY) * k;
    _tLastX = e.touches[0].clientX; _tLastY = e.touches[0].clientY;
    clampPan(); redraw();
  } else if (_touchMode === 'pinch' && e.touches.length === 2) {
    const d = _touchDist(e.touches);
    const mpx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const mpy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    const sx = (mpx - rect.left) * k, sy = (mpy - rect.top) * k;
    const target = clamp(_tStartZoom * (d / _tStartDist), ZOOM_MIN, ZOOM_MAX);
    zoomAt(sx, sy, target / _zoom);
  }
}, { passive: false });
canvas.addEventListener('touchend', (e) => {
  if (e.touches.length === 0) { if (_touchMode === 'edit') endDrag(); _touchMode = null; }
  else if (e.touches.length === 1 && _touchMode === 'pinch') {   // 雙指縮放剩一指→改回平移，避免卡住
    _touchMode = 'pan'; _tLastX = e.touches[0].clientX; _tLastY = e.touches[0].clientY;
  }
}, { passive: false });

// 縮放按鈕
const _vpCenter = () => ({ x: canvas.width / 2, y: canvas.height / 2 });
document.getElementById('zoom-in').addEventListener('click',    () => { const c = _vpCenter(); zoomAt(c.x, c.y, 1.25); });
document.getElementById('zoom-out').addEventListener('click',   () => { const c = _vpCenter(); zoomAt(c.x, c.y, 0.8);  });
document.getElementById('zoom-reset').addEventListener('click', resetView);

// ══ 手機版：底部設定面板收合 ═════════════════════════════════════
const _panel = document.getElementById('panel');
const _mqMobile = window.matchMedia('(max-width: 820px)');
document.getElementById('panel-header').addEventListener('click', () => {
  if (_mqMobile.matches) _panel.classList.toggle('collapsed');
});
function applyMobileDefault() {
  // 進入手機版預設收合，讓使用者先看到模擬畫面
  _panel.classList.toggle('collapsed', _mqMobile.matches);
}
_mqMobile.addEventListener('change', () => { applyMobileDefault(); resizeCanvas(); });
applyMobileDefault();

// ══ 初始化 ════════════════════════════════════════════════════════
resizeCanvas();
