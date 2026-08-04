// 敵兵。モデルも動きも手続き的に作る。
// 判定は見た目のメッシュではなく専用の球/カプセルで取る。そのほうが速いし、
// 「当たったはずなのに抜けた」が起きにくい。
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _ray = new THREE.Ray();
// 倒れ切った死体が壁や箱に刺さっていないか見るための寝そべりカプセル
const _corpseCap = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.26);
const BONE_UP = new THREE.Vector3(0, 1, 0);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const rand = (s) => (Math.random() - 0.5) * s;
const TAU = Math.PI * 2;
// 角度差は必ず -π..π に畳んでから使う。畳まないと真後ろで一周する
const wrapPi = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
const fract = (x) => x - Math.floor(x);
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const mix = (a, b, t) => a + (b - a) * t;

/* ---------------------------------------------- 手続き生成のテクスチャ */
// 背景は512pxのPBRを焼いているのに敵だけ単色だと、シーンの中でキャラが一番
// 情報量の少ない物体になる。人は必ずキャラを注視するので、そこが一番粗いと
// 全部が作り物に見える。画像ファイルは使えないのでここで布・ナイロン・
// ケブラー・革・肌・顔を焼く。1組を全個体で共有し、個体差はUVのずらしで作る。

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// periodを整数に保つと端が巻き戻るのでタイリングしても継ぎ目が出ない
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const w = yf * yf * (3 - 2 * yf);
  const m = (n) => ((n % period) + period) % period;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * w;
}

function fbm(x, y, freq, oct, seed, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < oct; i++) {
    sum += amp * vnoise(x * f, y * f, f, seed + i * 131);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

// 尾根状のノイズ。革の皺や金属の擦り傷のような「線」はこれでないと出ない
function ridged(x, y, freq, oct, seed) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < oct; i++) {
    const n = 1 - Math.abs(vnoise(x * f, y * f, f, seed + i * 977) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function dataTex(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// 1周で高さ・明度・粗さを書き、高さから法線を起こす。凹凸と光沢が同じ場から
// 出るので必ず一致する（ここがズレると近寄った瞬間に嘘になる）
const _px = { h: 0, l: 1, rough: 0.9, tr: 1, tg: 1, tb: 1 };
function bakeSurface(size, seed, cb, strength) {
  const height = new Float32Array(size * size);
  const alb = new Uint8Array(size * size * 4);
  const rgh = new Uint8Array(size * size * 4);
  const inv = 1 / size;
  let lsum = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      _px.h = 0.5; _px.l = 1; _px.rough = 0.9; _px.tr = 1; _px.tg = 1; _px.tb = 1;
      cb(x * inv, y * inv, _px, seed);
      const i = y * size + x, o = i * 4;
      height[i] = _px.h;
      // 焼いたアルベドの平均。材質側はこれで割って元の色に戻す。手で補正係数を
      // 置くと、柄を1つ触るたびに全個体の明るさが動いて調整が終わらない
      lsum += clamp(_px.l, 0, 1) * (_px.tr + _px.tg + _px.tb) / 3;
      // lは「材質色に掛かる線形の倍率」として設計しているので、sRGBへ
      // 直してから格納する。そのまま入れると中間調が一段暗く沈む
      alb[o] = Math.pow(clamp(_px.l * _px.tr, 0, 1), 1 / 2.2) * 255;
      alb[o + 1] = Math.pow(clamp(_px.l * _px.tg, 0, 1), 1 / 2.2) * 255;
      alb[o + 2] = Math.pow(clamp(_px.l * _px.tb, 0, 1), 1 / 2.2) * 255;
      alb[o + 3] = 255;
      rgh[o] = rgh[o + 1] = rgh[o + 2] = clamp(_px.rough, 0, 1) * 255;
      rgh[o + 3] = 255;
    }
  }
  const nrm = new Uint8Array(size * size * 4);
  const at = (x, y) => height[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      const i = (y * size + x) * 4;
      nrm[i] = (nx / l * 0.5 + 0.5) * 255;
      nrm[i + 1] = (ny / l * 0.5 + 0.5) * 255;
      nrm[i + 2] = (nz / l * 0.5 + 0.5) * 255;
      nrm[i + 3] = 255;
    }
  }
  return {
    map: dataTex(alb, size, true),
    normalMap: dataTex(nrm, size, false),
    roughnessMap: dataTex(rgh, size, false),
    mean: clamp(lsum / (size * size), 0.08, 1),
  };
}

// 布の織り目。縦横の糸が交差する山を作り、その上に毛羽立ちの粒を乗せる
function weaveHeight(u, v, n, seed) {
  return (Math.sin(u * TAU * n) * Math.sin(v * TAU * n)) * 0.22 + 0.5
    + fbm(u, v, 24, 2, seed) * 0.3;
}

// 迷彩の戦闘服。3色ポスタライズの斑＋裾の泥＋擦れて白茶けた縁。
// 色相は材質側のcolorが持つので、ここでは明度の倍率だけを焼く。
// そうすればオリーブ/タン/グレーの3系統を1枚で賄える
const SURF_CAMO = bakeSurface(128, 17, (u, v, o, s) => {
  const blob = fbm(u, v, 4, 4, s) * 0.7 + fbm(u + 0.37, v + 0.11, 8, 3, s + 91) * 0.3;
  // 段差をわずかにぼかす。完全な2値だとプリント柄に見える。
  // 明暗比は1.5:1程度に抑える。ここを2.4:1まで開けると、斑が交戦距離で溶けずに
  // 牛柄として読めてしまい、迷彩の機能（遠目で単一のトーンになる）が消える
  let tone = mix(0.62, 0.80, sstep(0.442, 0.462, blob));
  tone = mix(tone, 0.92, sstep(0.588, 0.606, blob));
  // 斑を細かくしたぶん情報量が落ちるので、全面に細かい粒を足して埋める
  tone += (fbm(u, v, 20, 2, s + 501) - 0.5) * 0.08;
  o.h = weaveHeight(u, v, 26, s + 7);
  // v下側ほど泥。裾と膝は必ず汚れる。汚れの無い軍服は嘘
  const mud = sstep(0.44, 0.02, v) * (0.4 + fbm(u, v, 6, 3, s + 313) * 0.6);
  tone *= 1 - mud * 0.34;
  o.tr = 1 + mud * 0.12; o.tg = 1 - mud * 0.02; o.tb = 1 - mud * 0.18;
  // 折り目の頂点が擦れて色が抜ける
  const wear = clamp(Math.pow(fbm(u, v, 10, 3, s + 77), 3.0) * 2.6, 0, 1);
  o.l = tone + wear * 0.24;
  o.rough = 0.96 - wear * 0.24 - mud * 0.06 + (o.h - 0.5) * 0.12;
}, 2.6);

// ナイロンのウェビング。横方向のテープとステッチが走る。ベストと装備袋用
// 横テープだけだとコーデュロイの横縞セーターになる。実物のPALSは横行と縦列が
// 格子を組むので、縦のウェビング列を同じ振幅で入れて格子として読ませる
const SURF_NYLON = bakeSurface(96, 53, (u, v, o, s) => {
  const band = tri6(v * 5);                       // テープの並び（横行）
  const tape = sstep(0.46, 0.34, band);
  const col = tri6(u * 7);                        // PALSの縦列
  const rib = sstep(0.44, 0.32, col);
  const stitch = sstep(0.30, 0.34, band) * sstep(0.40, 0.36, band)
    * (fract(u * 40) < 0.5 ? 1 : 0.2);            // 縫い目の破線
  o.h = weaveHeight(u, v, 34, s) * 0.6 + tape * 0.30 + rib * 0.26 - stitch * 0.28;
  const wear = clamp(Math.pow(fbm(u, v, 12, 3, s + 41), 2.6) * 2.2, 0, 1);
  const grime = fbm(u, v, 7, 3, s + 5);
  // 明度の幅を持たせないと、法線だけ入れても遠目で無地の板に戻る。
  // ただし横帯だけ強いと縞に見えるので、横と縦の明度差は同じ幅にする
  o.l = 0.70 + tape * 0.06 + rib * 0.06 + wear * 0.26 - grime * 0.18 - stitch * 0.12;
  o.tr = 1 + wear * 0.05;
  o.rough = 0.82 - wear * 0.2 + tape * 0.06;
}, 3.0);

// ケブラーのヘルメット。布カバーの織りの上に細かい梨地
const SURF_KEVLAR = bakeSurface(96, 91, (u, v, o, s) => {
  o.h = weaveHeight(u, v, 18, s) * 0.7 + fbm(u, v, 40, 2, s + 3) * 0.3;
  const scuff = clamp(Math.pow(ridged(u, v, 8, 3, s + 61), 3.0) * 2.4, 0, 1);
  o.l = 0.78 + (o.h - 0.5) * 0.26 + scuff * 0.24 - fbm(u, v, 5, 2, s + 15) * 0.12;
  o.rough = 0.78 - scuff * 0.24 + fbm(u, v, 20, 2, s + 9) * 0.12;
}, 2.2);

// ブーツの革。皺が寄り、爪先だけ光る
const SURF_LEATHER = bakeSurface(96, 131, (u, v, o, s) => {
  const crease = ridged(u, v, 6, 3, s);
  o.h = crease * 0.6 + fbm(u, v, 30, 2, s + 11) * 0.4;
  o.l = 0.74 + crease * 0.28 - fbm(u, v, 5, 2, s + 21) * 0.14;
  o.rough = 0.72 - crease * 0.28 + fbm(u, v, 14, 2, s + 31) * 0.14;
}, 2.4);

// 肌。毛穴の粒と血色のムラ。単色の肌は必ずマネキンに見える
const SURF_SKIN = bakeSurface(64, 211, (u, v, o, s) => {
  o.h = fbm(u, v, 36, 3, s) * 0.7 + fbm(u, v, 12, 2, s + 5) * 0.3;
  const mottle = fbm(u, v, 6, 3, s + 17);
  o.l = 0.92 + mottle * 0.14;
  o.tr = 1 + (mottle - 0.5) * 0.12;
  o.tb = 1 - (mottle - 0.5) * 0.1;
  o.rough = 0.74 + fbm(u, v, 24, 2, s + 23) * 0.16;
}, 1.6);

// 銃の金属。角が擦れて地金が出る。単色の黒だと塊にしか見えない
const SURF_GUNMETAL = bakeSurface(96, 307, (u, v, o, s) => {
  const scratch = ridged(u, v, 5, 4, s);
  o.h = fbm(u, v, 40, 3, s + 3) * 0.6 + scratch * 0.4;
  const wear = clamp(Math.pow(scratch, 3.4) * 3.0, 0, 1);
  o.l = 0.74 + wear * 0.6 + (o.h - 0.5) * 0.22;
  o.rough = 0.72 - wear * 0.34;
}, 2.8);

// v*5の三角波。ウェビングのテープ幅を出すのに使う
function tri6(x) { return Math.abs(fract(x) - 0.5); }

/* 顔。頭は多角柱なので円筒UVがそのまま使える。眉の影・眼窩・鼻筋・口・
   無精髭を1枚に焼く。これが無いと顔はただの肌色の板になる */
const HEAD_SEG = 16;                      // 12角だと真横から見た時に露骨に板になる
const HEAD_ROT = Math.PI / HEAD_SEG;      // 面を正面に向けるための回転
// 円筒UVは u=0 が +Z。ジオメトリをHEAD_ROTだけ回すぶん、正面(-Z)に来るuがずれる
const FACE_U = 0.5 - HEAD_ROT / TAU;
// 顔として使う帯。円筒UVをそのまま使うと、目鼻口の実データが38x32テクセルしか
// 無くなって交戦距離でのっぺらぼうになる。頭のUVをこの帯だけに張り替えて、
// テクスチャ1枚まるごとを顔に使う
const FACE_V0 = 0.26, FACE_V1 = 0.58;
const FACE_HALF = 0.27;                   // 顔の横幅（円周に対する比）。外側は髪

// 頭の円筒UVを顔テクスチャ用に張り替える。横は顔の幅で畳んで側頭部を髪の列に
// 寄せ、縦は顔の帯をテクスチャ全体へ引き伸ばす
function remapFaceUV(geom) {
  const uv = geom.attributes.uv;
  const iv = 1 / (FACE_V1 - FACE_V0);
  for (let i = 0; i < uv.count; i++) {
    const u = uv.getX(i), v = uv.getY(i);
    let du = u - FACE_U;
    if (du > 0.5) du -= 1; else if (du < -0.5) du += 1;
    uv.setXY(i,
      0.5 + clamp(du / (FACE_HALF * 2), -0.5, 0.5),
      clamp((v - FACE_V0) * iv, 0, 1));
  }
  uv.needsUpdate = true;
  return geom;
}

const SURF_FACE = bakeSurface(256, 401, (ut, vt, o, s) => {
  // 焼く側では元の頭のUVへ戻して考える。こうすれば眉・目・鼻の位置の定数は
  // そのままで、使えるテクセルだけが8倍になる
  const du = (ut - 0.5) * (FACE_HALF * 2);
  const v = FACE_V0 + vt * (FACE_V1 - FACE_V0);
  const u = ut;
  const ax = Math.abs(du);

  // 顔として見えるのは顎の箱の上端(v約0.30)から兜の縁(v約0.53)までの帯。
  // ここに眉・目・鼻・口を詰める
  let l = 0.98, h = 0.5, rough = 0.76;
  // 眼窩。落ち窪み全体をまず暗くしてから、その中に瞳の芯を置く。
  // 芯だけだと交戦距離で消えるので、窪みの影の方を大きく取る
  const socket = Math.max(
    sstep(1, 0, Math.hypot((du - 0.058) / 0.062, (v - 0.455) / 0.055)),
    sstep(1, 0, Math.hypot((du + 0.058) / 0.062, (v - 0.455) / 0.055)),
  );
  const eye = Math.max(
    sstep(1, 0, Math.hypot((du - 0.055) / 0.032, (v - 0.452) / 0.030)),
    sstep(1, 0, Math.hypot((du + 0.055) / 0.032, (v - 0.452) / 0.030)),
  );
  l -= socket * 0.26 + eye * 0.40;
  h -= socket * 0.20 + eye * 0.25;
  // 眉。外側ほど上がる弧にする。真っ直ぐな横棒だと記号にしか見えない
  const browV = 0.508 + ax * 0.14;
  const brow = sstep(0.155, 0.10, ax) * sstep(browV - 0.022, browV, v) * sstep(browV + 0.030, browV + 0.008, v);
  l -= brow * 0.34; h += brow * 0.20;
  // 鼻。中央に細い稜線とその両脇の影
  const nose = sstep(0.030, 0.012, ax) * sstep(0.35, 0.39, v) * sstep(0.48, 0.45, v);
  h += nose * 0.30;
  const nostril = sstep(0.055, 0.030, ax) * sstep(0.020, 0.045, ax) * sstep(0.34, 0.37, v) * sstep(0.41, 0.38, v);
  l -= nostril * 0.28;
  // 口。上唇の影と下唇の明るい面
  const mouth = sstep(0.075, 0.035, ax) * sstep(0.305, 0.325, v) * sstep(0.35, 0.335, v);
  l -= mouth * 0.34; h -= mouth * 0.14;
  l += sstep(0.06, 0.02, ax) * sstep(0.285, 0.305, v) * sstep(0.325, 0.31, v) * 0.06;
  // 無精髭。顎から頬にかけての粒。ここが無いと人形の顔になる
  const beardZone = sstep(0.46, 0.28, v) * sstep(0.26, 0.14, ax);
  const beard = beardZone * (0.4 + fbm(u, v, 26, 2, s + 9) * 0.6);
  l -= beard * 0.20; rough += beard * 0.14;
  // 頬骨のハイライトと目の下のくま
  l += sstep(0.14, 0.09, Math.abs(ax - 0.115)) * sstep(0.33, 0.40, v) * sstep(0.47, 0.42, v) * 0.06;
  l -= sstep(0.09, 0.04, Math.abs(ax - 0.055)) * sstep(0.38, 0.41, v) * sstep(0.44, 0.41, v) * 0.10;
  // 側頭部から後頭部は髪。ヘルメットの下の暗がりになる
  const hair = sstep(0.19, 0.27, ax);
  l = mix(l, 0.30, hair * sstep(0.24, 0.40, v));
  rough = mix(rough, 0.94, hair);
  h = mix(h, 0.5 + fbm(u, v, 30, 2, s + 13) * 0.5, hair);
  // 肌の粒は全面に
  h += (fbm(u, v, 40, 2, s) - 0.5) * 0.25;
  o.h = h;
  o.l = l * (0.95 + fbm(u, v, 8, 2, s + 33) * 0.1);
  o.rough = rough;
}, 2.2);
// 顔は繰り返さない。縦に巻き戻すと額の上に顎が出る
SURF_FACE.map.wrapT = SURF_FACE.normalMap.wrapT = SURF_FACE.roughnessMap.wrapT = THREE.ClampToEdgeWrapping;

/* ---------------------------------------------------- 当たり判定の道具 */

function raySphere(origin, dir, center, radius) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const sq = Math.sqrt(disc);
  const t1 = -b - sq;
  if (t1 >= 0) return t1;
  const t2 = -b + sq;
  return t2 >= 0 ? t2 : -1;
}

// 線分ABを軸とする半径rの円柱＋両端の球
function rayCapsule(origin, dir, a, b, radius) {
  const ax = b.x - a.x, ay = b.y - a.y, az = b.z - a.z;
  const ox = origin.x - a.x, oy = origin.y - a.y, oz = origin.z - a.z;
  const aa = ax * ax + ay * ay + az * az;
  const ad = ax * dir.x + ay * dir.y + az * dir.z;
  const ao = ax * ox + ay * oy + az * oz;
  const od = ox * dir.x + oy * dir.y + oz * dir.z;
  const oo = ox * ox + oy * oy + oz * oz;

  const A = aa - ad * ad;
  const B = aa * od - ao * ad;
  const C = aa * oo - ao * ao - radius * radius * aa;

  let best = -1;
  if (Math.abs(A) > 1e-8) {
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A;
      if (t >= 0) {
        const m = ad * t + ao;            // 軸上の位置
        if (m >= 0 && m <= aa) best = t;
      }
    }
  }
  // 端の球も見る（真上や真下から撃たれた時に抜けないように）
  const sa = raySphere(origin, dir, a, radius);
  if (sa >= 0 && (best < 0 || sa < best)) best = sa;
  const sb = raySphere(origin, dir, b, radius);
  if (sb >= 0 && (best < 0 || sb < best)) best = sb;
  return best;
}

/* ------------------------------------------------ 部品を焼き込む道具 */

const _bp = new THREE.Vector3();
const _bs = new THREE.Vector3();
const _be = new THREE.Euler();
const _bq = new THREE.Quaternion();
const _bm = new THREE.Matrix4();

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, seg = 12) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);
const ball = (r, w = 10, h = 7) => new THREE.SphereGeometry(r, w, h);

/* 頂点に焼く簡易AO。影を受けるようにしても、PCFのセルフシャドウでは首元・脇・
   股・兜の下の細かい暗がりは出ない。人体が立体として読めるのはその暗がりの
   おかげなので、体の位置と面の向きから直接暗さを作って頂点色に入れる。
   yは足元を0とした体の高さ、n*は面の法線 */
function bodyAO(x, y, z, nx, ny, nz) {
  // 上を向く面は明るく、下を向く面は暗い。これだけで全身に階調が乗る
  let s = 0.80 + 0.20 * (ny * 0.5 + 0.5);
  const r = Math.hypot(x, z);
  // 首元。襟と顎の間は必ず暗い
  s *= 1 - 0.34 * sstep(0.09, 0.0, Math.abs(y - 1.47)) * sstep(0.13, 0.05, r);
  // 脇の下。腕と胴の谷
  s *= 1 - 0.30 * sstep(0.13, 0.0, Math.abs(y - 1.36)) * sstep(0.10, 0.20, Math.abs(x));
  // ベストの下端。装備が胴に落とす影
  s *= 1 - 0.26 * sstep(0.07, 0.0, Math.abs(y - 1.17));
  // 股。左右の腿に挟まれて光が入らない
  s *= 1 - 0.34 * sstep(0.14, 0.0, Math.abs(y - 0.86)) * sstep(0.10, 0.0, Math.abs(x));
  // 兜の内側と後頭部。庇の下が明るいと顔が板になる
  s *= 1 - 0.30 * sstep(0.10, 0.0, Math.abs(y - 1.63)) * sstep(0.6, 0.0, nz);
  /* 肘と膝。ここに暗がりが無いと、上腕と前腕・腿と脛が別々の筒として読めて
     しまい、関節に隙間のある組み立て人形に見える。関節を1段落として繋げる */
  s *= 1 - 0.20 * sstep(0.10, 0.0, Math.abs(y - 1.14)) * sstep(0.11, 0.20, Math.abs(x));
  s *= 1 - 0.16 * sstep(0.09, 0.0, Math.abs(y - 0.43));
  // 膝裏と足首まわり
  s *= 1 - 0.18 * sstep(0.08, 0.0, Math.abs(y - 0.44)) * sstep(0.0, -0.5, nz);
  s *= 1 - 0.22 * sstep(0.10, 0.0, Math.abs(y - 0.08));
  return clamp(s, 0.42, 1);
}

// ディテールを足すと箱の数がそのまま描画呼び出しになる。骨に対して動かない部品は
// 材質ごとに1つのジオメトリへ焼いてしまえば、見た目を増やしても描画負荷は増えない
class PartBag {
  constructor() {
    this.items = []; this.aoY = 0; this.aoX = 0; this.aoZ = 0;
    this.ox = 0; this.oy = 0; this.oz = 0;
  }

  // 焼き先の骨が体のどこにあるかを教える。頂点AOはここを足して体基準の高さにする
  at(x, y, z) { this.aoX = x; this.aoY = y; this.aoZ = z; return this; }

  /* この袋に入る部品を全部まとめて平行移動する。銃は「床尾板の背面」を原点に
     したいが、部品の座標を全部書き換えると銃の設計図として読めなくなるので、
     設計は銃の機関部基準のまま置いて、袋の側でずらす */
  origin(x = 0, y = 0, z = 0) { this.ox = x; this.oy = y; this.oz = z; return this; }

  add(geom, mat, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    _bq.setFromEuler(_be.set(rx, ry, rz));
    _bm.compose(_bp.set(px + this.ox, py + this.oy, pz + this.oz), _bq, _bs.set(sx, sy, sz));
    geom.applyMatrix4(_bm);           // 渡されたジオメトリはこの袋のものになる
    this._paintAO(geom);
    this.items.push([geom, mat]);
    return this;
  }

  _paintAO(geom) {
    const pos = geom.attributes.position;
    const nor = geom.attributes.normal;
    const n = pos.count;
    const col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const s = bodyAO(
        pos.getX(i) + this.aoX, pos.getY(i) + this.aoY, pos.getZ(i) + this.aoZ,
        nor ? nor.getX(i) : 0, nor ? nor.getY(i) : 1, nor ? nor.getZ(i) : 0,
      );
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = s;
    }
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }

  bake(group) {
    const byMat = new Map();
    for (const [g, m] of this.items) {
      let arr = byMat.get(m);
      if (!arr) byMat.set(m, (arr = []));
      arr.push(g);
    }
    for (const [mat, arr] of byMat) {
      const merged = arr.length === 1 ? arr[0] : (mergeGeometries(arr, false) ?? arr[0]);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      // 兜の庇が顔に、ベストが腹に、腕が胸に影を落とすようになる。
      // ここが抜けていると人体が均一な明るさに潰れて立体に見えない
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.items.length = 0;
    // 焼き終わったらずらしは解除する。次の部位へ持ち越すと体が丸ごとずれる
    this.ox = this.oy = this.oz = 0;
    return group;
  }
}

function pivot(parent, x = 0, y = 0, z = 0) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
}

/* -------------------------------------------------- 足元の接地の暗がり */
// 太陽の影は順光だと体の裏に落ちるし、AOの半径は人体には届かない。
// 結果、キャラが床に貼った紙のシールに見える。接地点の暗がりだけは
// 光源と無関係に必ず要るので、乗算の円盤を1枚敷いて自前で作る。

function contactTexture(size = 64) {
  const d = new Uint8Array(size * size * 4);
  const c = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - c, y - c) / c;
      // 中心が濃く、縁で1.0（＝何も掛からない）に戻る。
      // 逆光では体側が全部暗いので、足元がここまで沈まないと接地が読めない
      const k = clamp(0.32 + 0.68 * Math.pow(clamp(r, 0, 1), 1.5), 0, 1);
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = k * 255;
      d[i + 3] = 255;
    }
  }
  // 乗算の倍率そのものなので色空間の変換は挟まない
  return dataTex(d, size, false);
}

const CONTACT_GEO = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
const CONTACT_MAT = new THREE.MeshBasicMaterial({
  map: contactTexture(),
  blending: THREE.MultiplyBlending,
  transparent: true,          // 不透明扱いのままだと乗算より先に描かれて効かない
  premultipliedAlpha: true,   // 乗算合成はこれが立っていないとthreeが警告を出す
  depthWrite: false,
  toneMapped: false,
  fog: false,
});

function makeContactShadow() {
  const m = new THREE.Mesh(CONTACT_GEO, CONTACT_MAT);
  m.frustumCulled = true;
  m.renderOrder = -1;
  return m;
}

/* ------------------------------------------------------ 個体差と材質 */

/* 全員同じ色・同じ体格だと「同じモデルを並べただけ」に見える。迷彩は3系統から選ぶ。
   前回は「背景のコンクリ(明度0.45)より2段暗く」と決めて0.25前後まで落としたが、
   日陰に立った兵士が地面より暗く潰れ、輪郭のフレネルだけが残って線画になった。
   実効アルベドを0.36前後まで上げる。コンクリより1段暗いだけで迷彩としては足りるし、
   そこまで上げないと日陰の階調が1つも残らない */
const CAMO = [
  { fatigue: 0x5f6a4a, dark: 0x454c36, vest: 0x3e4238 },   // オリーブ
  { fatigue: 0x7a6949, dark: 0x5b4f36, vest: 0x46413a },   // タン
  { fatigue: 0x5e626b, dark: 0x43464d, vest: 0x3a3d42 },   // グレー
];

const SKIN = [0x8a6a52, 0xa8805f, 0x6d4d38, 0x9c7a5e];

// 頭に載る物。シルエットの一番上が全個体同じだと、色しか見分けがつかない
const HEAD_DOME = 0, HEAD_BOONIE = 1, HEAD_CAP = 2, HEAD_BARE = 3;
// 武器。正面シルエットの横棒が全員同じなのも「同じ人が並んでいる」の原因
const WEP_RIFLE = 0, WEP_SMG = 1, WEP_LMG = 2;

function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

function makeVariant() {
  const camo = CAMO[(Math.random() * CAMO.length) | 0];
  const headGear = pick([HEAD_DOME, HEAD_DOME, HEAD_DOME, HEAD_BOONIE, HEAD_CAP, HEAD_BARE]);
  return {
    // 身長差は±7%だと人の目には映らない。シルエットで分かる幅まで広げる
    scale: 0.90 + Math.random() * 0.22,
    // 肩幅を広げすぎると支持手が銃に届かなくなるので、この範囲までにする
    width: 0.88 + Math.random() * 0.26,
    /* 個体差を色と小物だけに入れても、10m以上では輪郭が同じなので同型に見える。
       姿勢そのものを振る。stanceは構えの高さ、staggerは足の前後の割り、
       neckTilt/slouchは首と背中の癖 */
    stance: pick(['high', 'low', 'patrol']),
    stagger: (Math.random() < 0.5 ? -1 : 1) * (0.035 + Math.random() * 0.045),
    neckTilt: rand(0.14),
    slouch: rand(0.10),
    camo,
    skin: SKIN[(Math.random() * SKIN.length) | 0],
    hue: rand(0.045),
    lum: rand(0.09),
    // アルベドのUVをずらして個体差を出す。色を個体ごとに乗算すると
    // 「同じ服の色違い」にしかならないが、柄がずれると別の服に見える
    uvOff: new THREE.Vector2(Math.random(), Math.random()),
    headGear,
    // 露出した顔は作り込んだ個体だけにする。残りは覆面で肌を隠す。
    // 全員の顔を作り込むのは高いので、これが一番安いAAA近似になる
    faceCover: headGear === HEAD_BARE ? 1 : (Math.random() < 0.45 ? 1 : 0),
    plateCarrier: Math.random() < 0.5,       // 分厚いプレートキャリアか薄いチェストリグか
    weapon: pick([WEP_RIFLE, WEP_RIFLE, WEP_SMG, WEP_LMG]),
    pouches: 2 + ((Math.random() * 2) | 0),
    pack: Math.random() < 0.62,
    radio: Math.random() < 0.5,
    chevron: Math.random() < 0.45,
    canteen: Math.random() < 0.6,
    holster: Math.random() < 0.45,
    optic: Math.random() < 0.6,
    coverHelmet: Math.random() < 0.5,
  };
}

/* 逆光でキャラだけが真っ黒な切り絵に潰れるのを止める縁の光。
   背景の壁は大きい面なので環境光だけでも階調が残るが、兵士は小さくて法線の
   変化が細かいぶん、同じ条件で先に潰れる。ライトを1灯足すとシャドウマップと
   描画コストがそのまま増えるので、材質側にフレネルの縁光を1項だけ焼く。
   同時に、背景のコンクリと同じ明度に沈んでシルエットが読めなくなるのも防ぐ */
const RIM_COLOR = new THREE.Color(0x9fb6d2);      // 空側の冷たい回り込み
// main.jsのSUN_DIRと同じ値。太陽の裏側だけに縁を出すのに要る
const SUN_DIR_WORLD = new THREE.Vector3(-0.78, 0.46, -0.34).normalize();

/* 前回は強度0.30を光源方向と無関係にoutgoingLightへ足していた。結果、腕の内側も
   脇も太陽に背を向けた面も同じ太さで光り、物理的な回り込みではなくトゥーンの
   縁取りにしか見えなくなった（四肢が1本ずつ縁取られて組み立て人形に見える）。
   出せるのは「空が見えていて」「太陽の裏側」の面だけなので、その2段で絞る。
   潰れを埋めるのは縁ではなく面の仕事なので、強度も0.12まで落とす */
function addRimLight(mat, strength = 0.12) {
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = { value: RIM_COLOR };
    shader.uniforms.uRimStrength = { value: strength };
    shader.uniforms.uSunDir = { value: SUN_DIR_WORLD };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>',
        '#include <common>\nuniform vec3 uRimColor;\nuniform float uRimStrength;\nuniform vec3 uSunDir;')
      .replace('#include <opaque_fragment>',
        'float _rim = pow(1.0 - clamp(dot(normal, normalize(vViewPosition)), 0.0, 1.0), 3.0);\n'
        // normalはビュー空間。viewMatrixを右から掛けると転置＝逆回転になり世界法線へ戻る
        + 'vec3 _wn = normalize((vec4(normal, 0.0) * viewMatrix).xyz);\n'
        // 空が見えている面ほど強く。真下を向いた面に空からの回り込みは来ない
        + '_rim *= clamp(_wn.y * 0.5 + 0.5, 0.0, 1.0);\n'
        // 逆光の縁だけ。日向の面にまで乗せると縁取り線になる
        + '_rim *= smoothstep(0.0, 0.6, -dot(_wn, uSunDir));\n'
        + 'outgoingLight += uRimColor * (_rim * uRimStrength);\n'
        + '#include <opaque_fragment>');
  };
  // 差し替えたシェーダーは全個体で同一。キーを固定しないと敵が湧くたびに
  // シェーダーコンパイルが走って最初の1発でカクつく
  mat.customProgramCacheKey = () => 'enemyRim';
  return mat;
}

function makeMaterials(v) {
  // 焼いたアルベドは1未満の倍率なので、その平均で割って元の色に戻す。
  // これをしないとテクスチャを入れた途端に全員が一段暗くなる
  const tint = (hex, dl, boost) => new THREE.Color(hex)
    .offsetHSL(v.hue, 0, clamp(v.lum + dl, -0.12, 0.12))
    .multiplyScalar(boost);

  // 布・革・金属はテクスチャの繰り返し数を変えるだけで別素材に見える。
  // 部位ごとに材質を分けても、PartBagが材質単位で1メッシュに焼くので描画は増えない
  const surf = (baked, hex, repeat, nscale, rough, metal, dl = 0, tone = 1, rim = 0.12) => {
    const m = new THREE.MeshStandardMaterial({
      color: tint(hex, dl, tone / baked.mean), roughness: rough, metalness: metal, vertexColors: true,
    });
    const mp = baked.map.clone(); mp.repeat.set(repeat, repeat); mp.offset.copy(v.uvOff);
    const nm = baked.normalMap.clone(); nm.repeat.set(repeat, repeat); nm.offset.copy(v.uvOff);
    const rm = baked.roughnessMap.clone(); rm.repeat.set(repeat, repeat); rm.offset.copy(v.uvOff);
    m.map = mp; m.normalMap = nm; m.roughnessMap = rm;
    // 罠: normalScaleをコンストラクタに数値で渡すとVector2が数値に潰れて壊れる
    m.normalScale.set(nscale, nscale);
    /* 日陰の下限を光で埋める。兵士は背景の壁より小さく法線の変化が細かいぶん、
       同じ環境光でも先に真っ黒へ潰れる。ライトを1灯足すとシャドウマップごと
       増えるので、自己発光をアルベドの5%だけ入れて下駄を履かせる */
    m.emissive.copy(new THREE.Color(hex)).multiplyScalar(0.05);
    // 環境光は場面全体に掛かる係数なので、キャラだけ強めに拾わせて日陰を持ち上げる
    m.envMapIntensity = 1.25;
    return addRimLight(m, rim);
  };

  const helmetColor = v.coverHelmet ? v.camo.fatigue : v.camo.dark;
  /* 前回はヘルメットもベストも布も一律 roughness 0.9 / metalness 0 で、
     どの部位も同じ拡散一色になり、形が輪郭でしか付いていなかった。
     ケブラーとナイロンは実際そこそこ光る。粗さを部位で割って鏡面で形を出す。
     リムは胴とヘルメットに残し、手足には掛けない（掛けると円柱1本ずつが
     縁取られて、関節に隙間のある組み立て人形として読める） */
  return {
    // 繰り返しは柄の実寸で決める。戦闘服の斑は6cm前後でないと、42cmの胴に
    // 20cmの斑が乗って牛柄になる
    fatigue: surf(SURF_CAMO, v.camo.fatigue, 5.0, 1.1, 0.86, 0, 0, 1, 0.10),
    fatigueDark: surf(SURF_CAMO, v.camo.dark, 6.5, 1.1, 0.88, 0, 0, 1, 0.04),
    vest: surf(SURF_NYLON, v.camo.vest, 2.4, 1.3, 0.50, 0.08, 0, 1, 0.12),
    gear: surf(SURF_NYLON, 0x353a34, 4.0, 1.2, 0.58, 0.12, 0, 1, 0.06),
    glove: surf(SURF_CAMO, 0x35392f, 6.0, 1.2, 0.72, 0.05, 0, 1, 0.04),
    boot: surf(SURF_LEATHER, 0x2b2d33, 3.0, 1.3, 0.44, 0.10, 0, 1, 0.04),
    skin: surf(SURF_SKIN, v.skin, 2.0, 0.8, 0.72, 0, 0, 1, 0.06),
    helmet: surf(SURF_KEVLAR, helmetColor, 2.0, 1.0, 0.45, 0.10, -0.04, 1, 0.12),
    // 銃本体は胴のベストより暗く落とす。同じ明度だと正面シルエットで武器が消える
    gun: surf(SURF_GUNMETAL, 0x2a2d31, 3.5, 1.0, 0.42, 0.85, 0, 1, 0.05),
    // 被筒・銃床・握把はタン系の樹脂に分ける。銃の中に明暗の差ができて、
    // 遠目でも「何か長い物を持っている」が読める（武装して見えない敵は脅威に見えない）
    gunPoly: surf(SURF_GUNMETAL, 0x8a7752, 3.5, 1.1, 0.74, 0.05, 0, 1, 0.05),
    /* バイザー。前回はMeshBasicMaterialのtoneMapped:falseで、距離が離れても
       輝度が落ちないぶんサブピクセルに潰れた時だけ純赤でギラつき、45m先の分隊が
       赤と青の砂粒の山に見えていた。トーンマップに乗る自己発光へ変えて、
       距離でemissiveIntensityを0まで落とす（Enemy側で毎フレーム書く） */
    eye: (() => {
      const m = new THREE.MeshStandardMaterial({ color: 0x141010, roughness: 0.35, metalness: 0.2 });
      m.emissive.setHex(0xc4361c);
      m.emissiveIntensity = 0.85;
      return m;
    })(),
  };
}

// 顔だけは柄の位置が決まっているので、繰り返さず1周でぴったり貼る
function makeFaceMaterial(v) {
  const m = new THREE.MeshStandardMaterial({
    color: new THREE.Color(v.skin)
      .offsetHSL(v.hue, 0, clamp(v.lum, -0.12, 0.12))
      .multiplyScalar(1 / SURF_FACE.mean),
    roughness: 0.72, metalness: 0, vertexColors: true,
  });
  m.map = SURF_FACE.map;
  m.normalMap = SURF_FACE.normalMap;
  m.roughnessMap = SURF_FACE.roughnessMap;
  m.normalScale.set(1.1, 1.1);
  m.emissive.copy(new THREE.Color(v.skin)).multiplyScalar(0.05);
  m.envMapIntensity = 1.25;
  return addRimLight(m, 0.06);
}

/* -------------------------------------------------------------- モデル */

// 腕の骨の長さ。IKはこの2本の長さから肘角を逆算する
const LU = 0.30;      // 上腕
const LF = 0.29;      // 前腕

/* 銃を体の正面から斜めに構える。床尾板を右肩のくぼみに入れると、銃身は体の
   正面ではなく肩から前方へ斜めに出る。0.10ではほぼ正面のままで、支持手が
   左肩から届く範囲の外（0.72m。腕は0.59m）に出てしまい、両腕とも伸び切った
   「前に捧げ持つ」形にしかならなかった。銃身を体の内側へ振って支持手を近づける。
   銃口が狙いと平行になるよう、この角度ぶんだけ上体を戻す */
const GUN_BLADE = 0.34;
// 銃口を少し伏せる。重い物を肩に載せている感じはここで出る
const GUN_PITCH = -0.05;

/* 銃のローカル座標での「手のひらの芯」と銃口。
   前回は手首（IKの目標）と手袋の置き場所を別々の表で持っていたせいで、
   ライフルでz方向に7.5cmずれ、前腕が空中で切れて丸い断端で終わっていた。
   掴む場所は銃の形が決めるものなので、手のひらだけを表に持ち、
   手首はそこから腕側へ一定量戻した点として必ず計算で出す。
   buttZは床尾板の背面＝肩に当たる面の銃ローカルz。この点が保持点に来るように
   銃の部品を丸ごと後ろへずらすので、銃は床尾板を軸に回る */
const WEAPON_SPECS = [
  { // ライフル。握把の芯と被筒の芯
    buttZ: 0.266,
    palmR: new THREE.Vector3(0.004, -0.105, 0.085), rotR: -0.30,
    palmL: new THREE.Vector3(0.010, -0.032, -0.190), rotL: 0.28,
    muzzleZ: -0.56,
  },
  { // 短機関銃。全長が短いので支持手が手前に来る
    buttZ: 0.263,
    palmR: new THREE.Vector3(0.004, -0.100, 0.055), rotR: -0.30,
    palmL: new THREE.Vector3(0.010, -0.028, -0.175), rotL: 0.26,
    muzzleZ: -0.40,
  },
  { // 分隊支援火器。重いので支持手は被筒の後ろ寄りを掴む
    buttZ: 0.345,
    palmR: new THREE.Vector3(0.004, -0.108, 0.100), rotR: -0.30,
    palmL: new THREE.Vector3(0.010, -0.028, -0.120), rotL: 0.30,
    muzzleZ: -0.70,
  },
];
// 手のひらから手首（前腕の終端）へのずれ。握り込みぶんだけ腕側に戻る
const WRIST_OFF_R = new THREE.Vector3(0.001, 0.042, 0.038);
const WRIST_OFF_L = new THREE.Vector3(0.002, -0.048, 0.072);
// 肘が落ちる向き（胸ローカル）。射撃側は脇を締め、支持側は下に垂らす
const POLE_R = new THREE.Vector3(0.78, -0.82, 0.5).normalize();
const POLE_L = new THREE.Vector3(-0.6, -0.95, 0.14).normalize();

function buildSoldier(v) {
  const M = makeMaterials(v);
  // 素顔の個体だけ顔テクスチャを作る。覆面の個体には要らない
  if (v.faceCover === 0) M.face = makeFaceMaterial(v);
  const W = v.width;
  const spec = WEAPON_SPECS[v.weapon] ?? WEAPON_SPECS[0];

  const root = new THREE.Group();
  root.scale.setScalar(v.scale);
  // 倒れる時の傾きを体の向きより先に掛ける。既定のXYZ順だと向きによって
  // 横倒しの角度が変わり、体が浮いたまま止まる
  root.rotation.order = 'YXZ';

  /* -------------------------------------------------------- 骨盤 */
  const hips = pivot(root, 0, 0.92, 0);
  const bag = new PartBag();
  bag.at(0, 0.92, 0);
  // 腰は細くする。0.152*Wだと左右の腿の間を腰が完全に塞いで、脚の間に空が
  // 抜けなくなる。人体のシルエットが読めるのはあの抜けのおかげ
  bag.add(cyl(0.128 * W, 0.120 * W, 0.20, 12), M.fatigue, 0, -0.04, 0, 0, Math.PI / 8, 0, 1, 1, 0.8);
  bag.add(box(0.27 * W, 0.055, 0.235), M.gear, 0, 0.045, 0);                    // ベルト
  bag.add(box(0.10, 0.10, 0.07), M.gear, 0.14 * W, -0.02, 0.115);               // 尻ポーチ
  bag.add(box(0.075, 0.115, 0.06), M.gear, -0.15 * W, -0.03, 0.10);
  bag.bake(hips);

  /* ------------------------------------------------ 上体（腰から上） */
  // 走る向きと撃つ向きが違う時、ここだけ捻る。体ごと向くと一気に嘘くさくなる
  const chest = pivot(hips, 0, 0.12, 0);
  bag.at(0, 1.04, 0);
  bag.add(cyl(0.198 * W, 0.163 * W, 0.42, 12), M.fatigue, 0, 0.20, 0, 0, Math.PI / 12, 0, 1, 1, 0.66);
  // ベストの嵩は2種類。薄いチェストリグと分厚いプレートキャリアでは
  // 上体の太さが目に見えて変わるので、遠目でも個体が違うと分かる
  if (v.plateCarrier) {
    bag.add(cyl(0.232 * W, 0.222 * W, 0.38, 12), M.vest, 0, 0.245, 0, 0, Math.PI / 12, 0, 1, 1, 0.80);
    // 肩の当て。プレートキャリアはここが分厚い
    bag.add(box(0.085, 0.06, 0.20), M.vest, 0.155 * W, 0.415, -0.01);
    bag.add(box(0.085, 0.06, 0.20), M.vest, -0.155 * W, 0.415, -0.01);
    bag.add(box(0.19 * W, 0.05, 0.035), M.gear, 0, 0.33, -0.20);                 // 胸のカマーバンド
  } else {
    bag.add(cyl(0.206 * W, 0.192 * W, 0.30, 12), M.vest, 0, 0.24, 0, 0, Math.PI / 12, 0, 1, 1, 0.74);
    bag.add(box(0.05, 0.20, 0.03), M.gear, 0.075 * W, 0.33, -0.175);             // 細いストラップ2本
    bag.add(box(0.05, 0.20, 0.03), M.gear, -0.075 * W, 0.33, -0.175);
  }
  bag.add(cyl(0.098 * W, 0.104 * W, 0.075, 10), M.fatigueDark, 0, 0.435, 0, 0, Math.PI / 8, 0, 1, 1, 0.9); // 襟
  bag.add(cyl(0.06, 0.068, 0.10, 10), M.skin, 0, 0.455, -0.005);                 // 首
  // 肩当ては四角い箱をやめて潰した球にする。胸→四角い箱→一段細い球→さらに細い棒と
  // 3つの塊が段差を作って「樽に刺した箒の柄」に見えていた。
  // 球なら三角筋と輪郭が繋がるし、胸のM.vestに混ざるので描画呼び出しも増えない
  bag.add(ball(0.088, 10, 7), M.vest, 0.198 * W, 0.392, 0.02, 0, 0, 0, 1.20, 0.82, 1.10);
  bag.add(ball(0.088, 10, 7), M.vest, -0.185 * W, 0.392, -0.04, 0, 0, 0, 1.20, 0.82, 1.10);
  // 階級章。材質を増やすと描画呼び出しがそのまま増えるので、既にある材質に混ぜる
  if (v.chevron) bag.add(box(0.048, 0.014, 0.05), M.fatigueDark, 0.205 * W, 0.415, 0, 0, 0, -0.26);
  // 弾倉ポーチは数と大きさを個体で変える。ベストの読みをテクスチャの縞ではなく
  // シルエットへ移したいので、留め具のフラップを1枚ずつ被せて段差を作る
  for (let i = 0; i < v.pouches; i++) {
    const x = (i - (v.pouches - 1) / 2) * 0.108 * W;
    const d = v.plateCarrier ? -0.185 : -0.15;
    const hp = 0.12 + (i % 2) * 0.02;
    bag.add(box(0.095, hp, 0.07), M.gear, x, 0.155, d);
  }
  bag.add(cyl(0.032, 0.034, 0.085, 8), M.gear, -0.155 * W, 0.28, -0.135);        // 手榴弾
  if (v.canteen) bag.add(cyl(0.045, 0.045, 0.12, 8), M.gear, -0.175 * W, 0.03, 0.115);
  if (v.pack) {
    // 背嚢は輪郭を割るためにある。小さいと交戦距離で消えるので大きめに取る
    bag.add(box(0.36 * W, 0.40, 0.22), M.fatigueDark, 0, 0.24, 0.215);
    bag.add(cyl(0.06, 0.06, 0.34, 8), M.fatigueDark, 0, 0.43, 0.215, 0, 0, Math.PI / 2);
    bag.add(box(0.10, 0.16, 0.10), M.gear, 0.12 * W, 0.10, 0.30);                // 外付けの袋
  }
  if (v.radio) {
    bag.add(box(0.11, 0.20, 0.085), M.gear, 0.16 * W, 0.30, 0.155);
    // アンテナ。シルエットに細い縦線が入るだけで「装備を背負っている」感が出る。
    // 短いと交戦距離で消えるので、輪郭を割れる長さまで伸ばす
    bag.add(cyl(0.007, 0.0055, 0.72, 5), M.gear, 0.163 * W, 0.72, 0.19, -0.16, 0, -0.12);
  }
  // 負い紐。正面シルエットに斜めの線が1本入るだけで「武装している」の読みが跳ね上がる。
  // 銃といっしょに落ちると困るので、銃ではなく胴に持たせる
  bag.add(box(0.038, 0.46, 0.028), M.gear, -0.01 * W, 0.24, -0.168, 0, 0, 0.52);
  bag.add(box(0.042, 0.16, 0.13), M.gear, -0.16 * W, 0.40, -0.05, 0, 0, 0.16);   // 左肩の掛かり
  // 銃の前部へ渡る側。胸の前面から銃架の高さまで一本で繋ぐ
  bag.add(box(0.034, 0.34, 0.026), M.gear, 0.088, 0.16, -0.285, 0.90, 0, 0.1);
  bag.bake(chest);

  // ポーチの留め具。3cmの段差は30m先で1px未満に潰れるので近距離だけに出す
  const chestDetail = new THREE.Group();
  chest.add(chestDetail);
  bag.at(0, 1.04, 0);
  for (let i = 0; i < v.pouches; i++) {
    const x = (i - (v.pouches - 1) / 2) * 0.108 * W;
    const d = v.plateCarrier ? -0.185 : -0.15;
    const hp = 0.12 + (i % 2) * 0.02;
    bag.add(box(0.09, 0.03, 0.014), M.gear, x, 0.155 + hp * 0.5, d - 0.036, -0.30, 0, 0);
  }
  bag.bake(chestDetail);

  /* -------------------------------------------------------- 頭 */
  const headPivot = pivot(chest, 0, 0.50, 0);
  bag.at(0, 1.54, 0);
  // 顔を作り込むのは高い。覆面の個体は肌の露出をゼロにして、素顔は一部だけにする
  const covered = v.faceCover > 0;
  const faceMat = covered ? M.gear : M.face;
  const skinMat = covered ? M.gear : M.skin;
  // 頭は箱ではなく多角柱。角が少ないと真横から見た時に露骨に板に見える。
  // 上が太く下が細い。ここのテーパーが無いと頭のシルエットが缶になる
  const headGeo = cyl(0.090, 0.070, 0.185, HEAD_SEG);
  // 素顔の個体だけUVを顔の帯へ張り替える。覆面は普通のタイリングのままでいい
  if (!covered) remapFaceUV(headGeo);
  bag.add(headGeo, faceMat, 0, 0.10, 0, 0, HEAD_ROT, 0, 1, 1, 1.06);
  // 顎。こめかみより細くする。同じ幅だと頭が円筒のままになる
  bag.add(box(0.072, 0.044, 0.052), skinMat, 0, 0.040, -0.062);
  // 鼻・眉庇・頬骨・耳は12m以内でしか効かない。後段のheadDetailへ回す
  if (covered) {
    // 覆面の裾。首との境に段差が無いと布を被っているように見えない
    bag.add(cyl(0.076, 0.086, 0.035, 12), M.gear, 0, 0.012, 0, 0, HEAD_ROT, 0, 1, 1, 1.06);
  }

  const hasHelmet = v.headGear === HEAD_DOME;
  switch (v.headGear) {
    case HEAD_BOONIE: {
      // 布帽。柔らかい山と垂れたつば。ドーム兜とは輪郭がまるで違う
      bag.add(new THREE.SphereGeometry(0.110, 14, 8, 0, TAU, 0, Math.PI * 0.5),
        M.helmet, 0, 0.155, 0.004, 0, 0, 0, 1.06, 0.74, 1.10);
      /* つばは直径45cmの平円盤をやめる。あれは農作業の笠であってブーニーでは
         ない。上が細く下が太い円錐にして外へ向かって垂らし、幅も7〜8cmに戻す */
      bag.add(cyl(0.112, 0.148, 0.042, 20), M.helmet, 0, 0.140, 0.012, 0, 0, 0, 1, 1, 1.14);
      bag.add(cyl(0.112, 0.116, 0.028, 14), M.helmet, 0, 0.158, 0.004);           // 帽体の締め
      // 片側だけ跳ね上げる。円対称のままだと正面シルエットが円盤1枚で終わる
      bag.add(box(0.115, 0.014, 0.075), M.helmet, 0.098, 0.166, 0.012, 0, 0.35, 0.44);
      // 顎紐。兜と違って顎受けが無いので、細い紐2本で顔の輪郭を割る
      bag.add(box(0.011, 0.085, 0.011), M.gear, 0.084, 0.096, 0.004, 0.1, 0, -0.12);
      bag.add(box(0.011, 0.085, 0.011), M.gear, -0.084, 0.096, 0.004, 0.1, 0, 0.12);
      break;
    }
    case HEAD_CAP: {
      bag.add(new THREE.SphereGeometry(0.103, 12, 8, 0, TAU, 0, Math.PI * 0.5),
        M.helmet, 0, 0.168, 0.004, 0, 0, 0, 1.03, 0.82, 1.08);
      bag.add(cyl(0.104, 0.106, 0.028, 12), M.helmet, 0, 0.163, 0.004);
      bag.add(box(0.185, 0.016, 0.115), M.helmet, 0, 0.163, -0.12, 0.17, 0, 0);   // つば
      break;
    }
    case HEAD_BARE: {
      // 兜なし。巻いた布と無線のヘッドセットで輪郭を作る
      bag.add(cyl(0.098, 0.098, 0.065, 12), M.gear, 0, 0.178, 0.004, 0, HEAD_ROT, 0, 1, 1, 1.06);
      bag.add(box(0.034, 0.06, 0.035), M.gear, 0.101, 0.118, 0.005);              // ヘッドセット
      bag.add(cyl(0.006, 0.006, 0.21, 6), M.gear, 0, 0.205, 0.015, 0, 0, Math.PI / 2);
      bag.add(cyl(0.005, 0.004, 0.09, 5), M.gear, 0.085, 0.09, -0.045, 0.4, 0, -0.5); // マイク
      break;
    }
    default: {
      // 球キャップだけだと均一なドームで水泳帽に見える。前に庇、後ろに首の
      // 保護を足して初めて軍用ヘルメットの輪郭になる
      bag.add(new THREE.SphereGeometry(0.128, 14, 10, 0, TAU, 0, Math.PI * 0.6),
        M.helmet, 0, 0.145, 0.004, 0, 0, 0, 1.06, 1.0, 1.14);
      bag.add(cyl(0.129, 0.136, 0.035, 14), M.helmet, 0, 0.15, 0.004, 0, 0, 0, 1.06, 1, 1.14); // 縁
      // 庇は薄いと輪郭を割らない。厚みを取って前へ出し、頭頂と額の間に段差を作る
      bag.add(box(0.205, 0.05, 0.085), M.helmet, 0, 0.142, -0.136, 0.20, 0, 0);   // 前へ張り出す庇
      bag.add(box(0.20, 0.085, 0.075), M.helmet, 0, 0.085, 0.072, -0.14, 0, 0);   // 後頭部の垂れ
      bag.add(box(0.028, 0.085, 0.10), M.helmet, 0.128, 0.11, 0.01);              // 耳当て
      bag.add(box(0.028, 0.085, 0.10), M.helmet, -0.128, 0.11, 0.01);
      // 暗視装置の台座。庇の上に段差を作りたいので前へ出す。これは輪郭に出るので近距離限定にしない
      bag.add(box(0.09, 0.075, 0.05), M.gear, 0, 0.207, -0.116);
      break;
    }
  }
  if (hasHelmet) {
    bag.add(box(0.016, 0.10, 0.014), M.gear, 0.107, 0.06, -0.028, 0.22, 0, -0.16); // 顎紐
    bag.add(box(0.016, 0.10, 0.014), M.gear, -0.107, 0.06, -0.028, 0.22, 0, 0.16);
    bag.add(box(0.06, 0.032, 0.022), M.gear, 0, 0.012, -0.058);                    // 顎受け
  }
  if (hasHelmet || v.headGear === HEAD_CAP) {
    bag.add(box(0.175, 0.048, 0.026), M.gear, 0, 0.135, -0.088);                 // ゴーグル
    // 視線方向が一目で分かるように、バイザーだけ光らせる。
    // 帯を大きく取ると遠距離でサブピクセルに潰れた時に赤い砂粒になるので、
    // 高さは抑えて距離で消す（消し方はEnemy._updateDetailにある）
    bag.add(box(0.125, 0.022, 0.012), M.eye, 0, 0.134, -0.101);
  }
  bag.bake(headPivot);

  /* ここから下は近距離でしか効かない細部。10m先の頭は画面上で幅14pxしかなく、
     鼻も頬骨も3px未満の染みにしかならない。輪郭を1つも割らないのに描画だけ
     増えるので、丸ごと切れるように別のグループへ焼いて距離で消す */
  const headDetail = new THREE.Group();
  headPivot.add(headDetail);
  bag.at(0, 1.54, 0);
  /* 鼻・眉庇・頬骨は焼いた絵ではなく実体で足す。焼くだけだと正面の見かけが
     平面1枚なので、近距離では横線が1本入っただけののっぺらぼうに見える */
  bag.add(box(0.024, 0.046, 0.030), skinMat, 0, 0.086, -0.086, 0.06, 0, 0);       // 鼻
  bag.add(box(0.086, 0.014, 0.018), skinMat, 0, 0.103, -0.079);                   // 眉庇
  bag.add(box(0.030, 0.032, 0.020), skinMat, 0.052, 0.087, -0.062, 0, 0.55, 0);   // 頬骨
  bag.add(box(0.030, 0.032, 0.020), skinMat, -0.052, 0.087, -0.062, 0, -0.55, 0);
  bag.add(box(0.03, 0.05, 0.03), skinMat, 0.083, 0.115, 0.01);                    // 耳
  bag.add(box(0.03, 0.05, 0.03), skinMat, -0.083, 0.115, 0.01);
  if (hasHelmet) {
    // 暗視装置の上側。庇との段差を作る小物なので近距離だけでいい
    bag.add(box(0.048, 0.05, 0.06), M.gear, 0, 0.238, -0.142, 0.3, 0, 0);
    if (v.coverHelmet) {
      // 布カバーの皺。細い箱を表面に沿って寝かせると近距離で凹凸が出る
      bag.add(box(0.16, 0.013, 0.032), M.helmet, 0.01, 0.213, 0.02, 0.1, 0.3, 0);
      bag.add(box(0.13, 0.012, 0.028), M.helmet, -0.03, 0.192, -0.062, 0.5, -0.2, 0);
      bag.add(box(0.105, 0.011, 0.026), M.helmet, 0.062, 0.176, 0.07, -0.4, 0.4, 0);
      bag.add(box(0.05, 0.055, 0.014), M.helmet, -0.10, 0.198, 0.062, 0.2, 0.5, 0);
    }
  }
  if (hasHelmet || v.headGear === HEAD_CAP) {
    bag.add(box(0.045, 0.03, 0.02), M.gear, 0.098, 0.135, -0.055, 0, 0.5, 0);
    bag.add(box(0.045, 0.03, 0.02), M.gear, -0.098, 0.135, -0.055, 0, -0.5, 0);
  }
  bag.bake(headDetail);

  /* -------------------------------------------------------- 腕 */
  // 左肩は前に、右肩は後ろに。銃を構えると肩甲骨がこう動くので、腕の届く先が変わる
  const shoulderY = 0.40;
  const armR = pivot(chest, 0.205 * W, shoulderY, 0.03);
  const armL = pivot(chest, -0.19 * W, shoulderY, -0.06);
  // 腕は常にシルエットの縁に来る。6分割だと面の角がそのまま輪郭のギザギザになる
  for (const [arm, side] of [[armR, 1], [armL, -1]]) {
    bag.at(side * 0.2 * W, 1.04 + shoulderY, 0);
    // 三角筋。胸の0.198*Wに対して腕が細すぎると棒に見えるので、肩の球を太らせて
    // 上腕の上端半径をそこに合わせ、段差を消す。
    // 材質を1つ増やすと腕1本につき描画呼び出しが1回増えるので、上腕と同じ材質にする
    bag.add(ball(0.080, 10, 7), M.fatigue, 0, 0.004, 0, 0, 0, 0, 1, 0.94, 1);
    bag.add(cyl(0.074, 0.058, LU, 12), M.fatigue, 0, -LU / 2, 0);
    // 肩の記章。腕1本につき材質を増やすと描画が2回増えるので上腕と同じ材質にする
    bag.add(box(0.05, 0.012, 0.05), M.fatigue, side * 0.058, -0.055, -0.012, 0, 0, side * -0.2);
    bag.bake(arm);
  }
  const lowerR = pivot(armR, 0, -LU, 0);
  const lowerL = pivot(armL, 0, -LU, 0);
  for (const [fore, side] of [[lowerR, 1], [lowerL, -1]]) {
    bag.at(side * 0.2 * W, 1.04 + shoulderY - LU, 0);
    bag.add(ball(0.058, 8, 6), M.fatigueDark, 0, 0, 0);                          // 肘
    bag.add(cyl(0.057, 0.046, LF, 10), M.fatigueDark, 0, -LF / 2, 0);
    bag.add(cyl(0.052, 0.052, 0.035, 10), M.gear, 0, -LF + 0.03, 0);             // 袖口
    bag.bake(fore);
  }

  /* -------------------------------------------------------- 脚 */
  // 脚は左右に広げて細くする。±0.105*Wに0.088*Wの腿だと内側の隙間が3.4cmしか
  // 無く、その上を腰が完全に覆って腰から下が1本の柱になっていた。
  // 脚の間に空が抜けて初めて人体のシルエットが読める
  const LEG_X = 0.135;
  /* 足を前後に割る。左右の足が真横に並んでいると、どの個体も「台に刺した
     フィギュア」の立ち方になる。体重の乗る側は個体ごとに変える */
  const legR = pivot(hips, LEG_X * W, -0.06, v.stagger);
  const legL = pivot(hips, -LEG_X * W, -0.06, -v.stagger);
  for (const [leg, side] of [[legR, 1], [legL, -1]]) {
    bag.at(side * LEG_X * W, 0.86, 0);
    bag.add(cyl(0.072 * W, 0.060 * W, 0.44, 12), M.fatigue, 0, -0.22, 0);
    if (v.holster && side > 0) bag.add(box(0.07, 0.14, 0.06), M.gear, 0.058, -0.20, 0.03);
    bag.bake(leg);
  }
  const shinR = pivot(legR, 0, -0.44, 0);
  const shinL = pivot(legL, 0, -0.44, 0);
  for (const [shin, side] of [[shinR, 1], [shinL, -1]]) {
    bag.at(side * LEG_X * W, 0.42, 0);
    bag.add(cyl(0.058 * W, 0.046 * W, 0.38, 12), M.fatigueDark, 0, -0.19, 0);
    /* 膝当ては腿の骨に付いた箱をやめる。表面に浮いた別の箱として段差を作るだけで、
       腿と脛の境（＝膝）がどこにあるか分からなかった。脛の上端に移して関節を跨がせ、
       前面だけを覆う円筒の一部にする。曲げた時に膝の山として読める */
    // cyl()は分割数までしか渡せないので、角度を切った筒はここで直に作る
    bag.add(new THREE.CylinderGeometry(0.076, 0.070, 0.135, 10, 1, false, Math.PI - 0.95, 1.9),
      M.gear, 0, 0.012, -0.004);
    bag.add(box(0.105, 0.11, 0.112), M.boot, 0, -0.33, -0.005);                  // 編み上げ
    bag.bake(shin);
  }
  // 足首を返せるようにブーツは別の骨にする。接地の見え方がここで決まる
  const footR = pivot(shinR, 0, -0.38, 0);
  const footL = pivot(shinL, 0, -0.38, 0);
  for (const [foot, side] of [[footR, 1], [footL, -1]]) {
    bag.at(side * LEG_X * W, 0.04, 0);
    // つま先を外へ開く。左右が同じ向きに揃った板2枚だと立っている絵にならない。
    // 骨に回転を入れると歩行と死亡の姿勢で毎回上書きされるので、形の方に焼く
    const ty = -side * 0.13;
    // 靴底はかかと側を広く、つま先側を細く。真上から見て長方形だと靴に見えない
    bag.add(box(0.112, 0.038, 0.155), M.boot, 0, -0.022, 0.020, 0, ty, 0);       // 靴底(踵側)
    bag.add(box(0.085, 0.034, 0.115), M.boot, 0, -0.020, -0.100, 0, ty, 0);      // 靴底(爪先側)
    bag.add(box(0.10, 0.062, 0.12), M.boot, 0, 0.012, -0.105, 0, ty, 0);         // つま先
    bag.add(box(0.108, 0.08, 0.115), M.boot, 0, 0.014, -0.005, 0, ty, 0);
    bag.add(box(0.095, 0.055, 0.07), M.boot, 0, 0.016, 0.075, 0, ty, 0);         // かかと
    bag.bake(foot);
  }

  /* -------------------------------------------------------- 銃 */
  /* 保持点は右肩のくぼみそのものにする。前回はここが胸の前(z=-0.428)にあり、
     床尾板が胸の前面より12.5cm内側＝胴に刺さり、同時に機関部が胸から18cm
     飛び出していた。銃が胴を斜めに串刺しにしているので、IKがどう解いても
     肩付けにならず、全個体が「両手で前に捧げ持つ」形に収束していた。
     xは胸の右端寄り、zはベストの前面。ここへ床尾板の背面を合わせる */
  const MOUNT_X = 0.125 * W, MOUNT_Y = 0.345, MOUNT_Z = -0.145;
  const gunMount = pivot(chest, MOUNT_X, MOUNT_Y, MOUNT_Z);
  const gun = new THREE.Group();
  gun.rotation.set(GUN_PITCH, GUN_BLADE, 0);
  gunMount.add(gun);

  // 銃の部品を丸ごとbuttZだけ後ろへずらして、床尾板の背面を銃の原点＝保持点に置く。
  // こうすると銃は床尾板を軸に回るので、構えを振っても肩から離れない
  bag.at(MOUNT_X, 1.04 + MOUNT_Y, MOUNT_Z);
  bag.origin(0, 0, -spec.buttZ);
  buildWeapon(bag, M, v);
  bag.bake(gun);

  /* 手は銃ではなくmountの子にする。死んだ時に銃だけ落とすため。
     銃の子のままだと手袋まで一緒に落ちて、地面に手が転がることになる。
     左右を別の骨に分けるのは、倒れた時に手だけ腕へ付け替えるため（銃といっしょに
     消すと、死体が両腕とも袖口で切れた断端で永久に残る） */
  const hands = pivot(gunMount, 0, 0, 0);
  const gunEuler = new THREE.Euler(GUN_PITCH, GUN_BLADE, 0);
  // 銃の部品と同じだけ後ろへずらす。ここを忘れると手だけ銃から離れる
  const gunShift = new THREE.Vector3(0, 0, -spec.buttZ);
  const handR = pivot(hands, 0, 0, 0);
  const handL = pivot(hands, 0, 0, 0);
  handR.position.copy(spec.palmR).add(gunShift).applyEuler(gunEuler);
  handR.rotation.set(spec.rotR + GUN_PITCH, GUN_BLADE, 0);
  handL.position.copy(spec.palmL).add(gunShift).applyEuler(gunEuler);
  handL.rotation.set(spec.rotL + GUN_PITCH, GUN_BLADE, 0);

  /* 手のひらの箱は掌の芯を原点にして積む。掌・回り込む指・親指の3枚で輪を作り、
     手首側へ十分伸ばしておく。ここが短いと前腕の終端との間に穴が空く。
     指は1枚の板だと黒い塊に潰れて握っているように見えないので、
     第2-3指と第4-5指の2枚に割って間に隙間を作り、輪郭に切れ込みを1本入れる */
  bag.at(MOUNT_X + handR.position.x, 1.04 + MOUNT_Y + handR.position.y, MOUNT_Z + handR.position.z);
  bag.add(box(0.054, 0.092, 0.064), M.glove, 0, 0, 0);                            // 掌
  bag.add(box(0.050, 0.038, 0.026), M.glove, 0, 0.011, -0.044);                   // 第2-3指
  bag.add(box(0.048, 0.036, 0.024), M.glove, 0, -0.031, -0.043);                  // 第4-5指
  bag.add(box(0.026, 0.052, 0.032), M.glove, -0.028, 0.030, 0.008, 0, 0, 0.4);    // 親指
  bag.bake(handR);

  bag.at(MOUNT_X + handL.position.x, 1.04 + MOUNT_Y + handL.position.y, MOUNT_Z + handL.position.z);
  bag.add(box(0.056, 0.050, 0.110), M.glove, 0, -0.014, 0.010);                   // 掌（被筒の下）
  bag.add(box(0.050, 0.032, 0.030), M.glove, 0.004, 0.026, -0.042);               // 被筒を回り込む第2-3指
  bag.add(box(0.048, 0.030, 0.028), M.glove, 0.004, -0.008, -0.041);              // 第4-5指
  bag.add(box(0.028, 0.058, 0.028), M.glove, -0.030, 0.010, 0.018, 0, 0, -0.35);  // 親指
  bag.bake(handL);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, spec.muzzleZ - spec.buttZ);
  gun.add(muzzle);

  /* IKの目標。手首は手のひらから腕側へ一定量戻した点として計算で出す。
     手袋の置き場所と別表で持つと必ずずれて、腕が空中で切れる */
  const wristR = spec.palmR.clone().add(WRIST_OFF_R).add(gunShift).applyEuler(gunEuler);
  const wristL = spec.palmL.clone().add(WRIST_OFF_L).add(gunShift).applyEuler(gunEuler);

  // 判定を見た目に合わせるための骨。空のObject3Dなので描画には出ない
  const headBone = pivot(headPivot, 0, 0.105, 0);
  const chestTop = pivot(chest, 0, 0.42, 0);
  const chestBot = pivot(chest, 0, 0.02, 0);

  return {
    root, hips, chest, headPivot,
    armL, armR, lowerL, lowerR,
    legL, legR, shinL, shinR, footL, footR,
    gun, gunMount, hands, handR, handL, muzzle,
    headBone, chestTop, chestBot,
    wristR, wristL,
    mats: M,
    // 距離で丸ごと消す近距離用の細部
    detail: [headDetail, chestDetail],
    // 首の位置は頬付けで前へ出すので、戻す先を覚えておく
    headHome: headPivot.position.clone(),
    // 手を腕へ付け替えた後、湧き直しで銃へ戻すための元の位置
    handHomeR: { p: handR.position.clone(), q: handR.quaternion.clone() },
    handHomeL: { p: handL.position.clone(), q: handL.quaternion.clone() },
    shoulderR: armR.position.clone(),
    shoulderL: armL.position.clone(),
    mountHome: gunMount.position.clone(),
  };
}

/* 武器は3種。正面シルエットの横棒が全員同じだと、色以外に個体を見分ける
   手掛かりが無くなる。どれも被筒と銃床をタン系の樹脂に分けて、
   胴と同じ明度で武器が溶けないようにする（武装して見えない敵は脅威に見えない） */
function buildWeapon(bag, M, v) {
  /* 前回はどれも全長が1m近くあった。床尾板から被筒の芯まで59cmもあると、
     床尾板を肩に入れた時点で被筒が左肩から72cm先に行き、腕(59cm)では絶対に
     届かない。実物の騎銃と同じ寸法（床尾板から被筒まで45cm前後、全長80cm）まで
     詰めて、初めて「肩に付けて支持手を添える」形が成立する */
  if (v.weapon === WEP_SMG) {
    bag.add(box(0.058, 0.088, 0.24), M.gun, 0, 0, -0.01);                         // 機関部
    bag.add(box(0.048, 0.02, 0.20), M.gun, 0, 0.054, -0.04);                      // 上部レール
    bag.add(cyl(0.030, 0.030, 0.15, 10), M.gunPoly, 0, -0.004, -0.175, Math.PI / 2, 0, 0); // 被筒
    bag.add(cyl(0.013, 0.012, 0.10, 8), M.gun, 0, 0, -0.30, Math.PI / 2, 0, 0);   // 銃身
    bag.add(cyl(0.019, 0.017, 0.045, 8), M.gun, 0, 0, -0.375, Math.PI / 2, 0, 0); // 消炎器
    bag.add(box(0.05, 0.125, 0.055), M.gunPoly, 0, -0.086, 0.045, -0.28, 0, 0);   // 握把
    bag.add(box(0.04, 0.22, 0.055), M.gear, 0, -0.145, -0.06, 0.1, 0, 0);         // 長い弾倉
    bag.add(box(0.022, 0.05, 0.16), M.gunPoly, 0.028, 0.012, 0.16);               // 骨組みの銃床
    bag.add(box(0.022, 0.05, 0.16), M.gunPoly, -0.028, 0.012, 0.16);
    bag.add(box(0.058, 0.10, 0.026), M.gear, 0, 0.012, 0.25);                     // 床尾板
  } else if (v.weapon === WEP_LMG) {
    bag.add(box(0.072, 0.10, 0.34), M.gun, 0, 0, 0.0);                            // 大きな機関部
    bag.add(box(0.058, 0.024, 0.32), M.gun, 0, 0.062, -0.04);
    bag.add(box(0.05, 0.05, 0.13), M.gun, 0, 0.09, -0.01);                        // 提げ手
    // 被筒は支持手が届く所まで手前に寄せる。前へ出しすぎると腕が伸び切って
    // 手だけ届かず、また銃と手が離れる
    bag.add(cyl(0.032, 0.030, 0.24, 10), M.gunPoly, 0, -0.004, -0.22, Math.PI / 2, 0, 0);
    bag.add(cyl(0.018, 0.016, 0.28, 8), M.gun, 0, 0, -0.49, Math.PI / 2, 0, 0);   // 重い銃身
    bag.add(cyl(0.026, 0.022, 0.06, 8), M.gun, 0, 0, -0.66, Math.PI / 2, 0, 0);
    bag.add(box(0.052, 0.13, 0.06), M.gunPoly, 0, -0.09, 0.09, -0.28, 0, 0);      // 握把
    bag.add(box(0.10, 0.15, 0.16), M.gear, 0, -0.11, -0.06);                      // 弾薬箱
    bag.add(box(0.06, 0.10, 0.18), M.gunPoly, 0, 0.008, 0.235);                   // 銃床
    bag.add(box(0.066, 0.12, 0.03), M.gear, 0, 0.008, 0.33);                      // 床尾板
    // 二脚。畳んでいても輪郭に細い線が2本出るので、遠目でも武器の判別が効く
    bag.add(cyl(0.008, 0.007, 0.26, 6), M.gun, 0.035, -0.10, -0.40, 0.25, 0, 0.22);
    bag.add(cyl(0.008, 0.007, 0.26, 6), M.gun, -0.035, -0.10, -0.40, 0.25, 0, -0.22);
  } else {
    bag.add(box(0.062, 0.085, 0.27), M.gun, 0, 0, -0.02);                         // 機関部
    bag.add(box(0.05, 0.022, 0.30), M.gun, 0, 0.052, -0.06);                      // 上部レール
    bag.add(box(0.026, 0.03, 0.05), M.gun, 0.04, 0.03, 0.085);                    // 装填把手
    bag.add(cyl(0.036, 0.036, 0.24, 10), M.gunPoly, 0, -0.004, -0.20, Math.PI / 2, 0, 0); // 被筒
    bag.add(cyl(0.014, 0.013, 0.20, 8), M.gun, 0, 0, -0.40, Math.PI / 2, 0, 0);   // 銃身
    bag.add(cyl(0.021, 0.018, 0.05, 8), M.gun, 0, 0, -0.525, Math.PI / 2, 0, 0);  // 消炎器
    bag.add(box(0.014, 0.05, 0.018), M.gun, 0, 0.048, -0.33);                     // 照星
    bag.add(box(0.05, 0.128, 0.058), M.gunPoly, 0, -0.088, 0.075, -0.28, 0, 0);   // 握把
    bag.add(box(0.045, 0.145, 0.072), M.gear, 0, -0.10, -0.045, 0.16, 0, 0);      // 弾倉
    bag.add(box(0.045, 0.07, 0.068), M.gear, 0, -0.20, -0.077, 0.34, 0, 0);
    bag.add(box(0.055, 0.088, 0.17), M.gunPoly, 0, 0.005, 0.175);                 // 銃床（縮めた状態）
    bag.add(box(0.062, 0.115, 0.028), M.gear, 0, 0.0, 0.252);                     // 床尾板
  }
  if (v.optic) {
    bag.add(box(0.03, 0.04, 0.06), M.gun, 0, 0.082, 0.0);
    bag.add(cyl(0.026, 0.026, 0.10, 10), M.gun, 0, 0.112, 0.0, Math.PI / 2, 0, 0);
  } else {
    // 光学機器の無い個体でも上部レールに何か載せる。肩のラインを上へ割る物が
    // 1つも無いと、正面シルエットで銃が胴に埋もれる
    bag.add(box(0.03, 0.045, 0.11), M.gunPoly, 0, 0.082, 0.02);
  }
}

/* ---------------------------------------------------------- 簡易IK */

const _ikV = new THREE.Vector3();
const _ikU = new THREE.Vector3();
const _ikE = new THREE.Vector3();
const _ikF = new THREE.Vector3();
const _ikT = new THREE.Vector3();
const _ikQ = new THREE.Quaternion();
const BONE_DOWN = new THREE.Vector3(0, -1, 0);

// 肩→肘→手首の2骨IK。手首の位置から肘角を余弦定理で逆算し、
// 「肘がどっちに落ちるか」だけ極ベクトルで決める。正確さより破綻しないことを優先
function solveArm(shoulder, forearm, shoulderPos, target, pole, lu, lf) {
  _ikV.subVectors(target, shoulderPos);
  let d = _ikV.length();
  if (d < 1e-4) { _ikV.set(0, -1, 0); d = lu + lf; } else _ikV.divideScalar(d);
  d = clamp(d, Math.abs(lu - lf) + 0.02, lu + lf - 0.012);

  _ikU.copy(pole).addScaledVector(_ikV, -pole.dot(_ikV));
  if (_ikU.lengthSq() < 1e-6) {
    _ikU.set(0, -1, 0).addScaledVector(_ikV, _ikV.y);          // 極が腕と平行な時の逃げ
    if (_ikU.lengthSq() < 1e-6) _ikU.set(1, 0, 0).addScaledVector(_ikV, -_ikV.x);
  }
  _ikU.normalize();

  const cosA = clamp((d * d + lu * lu - lf * lf) / (2 * d * lu), -1, 1);
  const a = Math.acos(cosA);
  _ikE.copy(_ikV).multiplyScalar(Math.cos(a)).addScaledVector(_ikU, Math.sin(a));
  shoulder.quaternion.setFromUnitVectors(BONE_DOWN, _ikE);

  // 肘から手首への向きを上腕ローカルへ落として前腕に入れる
  _ikF.copy(_ikV).multiplyScalar(d).addScaledVector(_ikE, -lu).normalize();
  _ikQ.copy(shoulder.quaternion).invert();
  _ikF.applyQuaternion(_ikQ);
  forearm.quaternion.setFromUnitVectors(BONE_DOWN, _ikF);
}

/* ------------------------------------------------------ 歩行の姿勢 */

const _pose = { thigh: 0, knee: 0, ankle: 0, abduct: 0 };

// 倒れ込みの緩急。毎フレーム無名関数を作らないようにここへ出す
const ease3 = (t, dur) => { const k = clamp(t / dur, 0, 1); return 1 - Math.pow(1 - k, 3); };

/* 位相tの1周期が2歩ぶん。t=π/2で踵接地、π/2..3π/2が立脚、それ以外が遊脚。
   fwdは進行方向の前後成分(cos)、strafeは横成分(+で体の右へ流れている)、
   sideは脚の左右(+1が右脚)。
   横へ動いているのに前後のストライドを打つと、足が地面を擦る（ムーンウォーク）。
   前後幅をfwdで潰して、そのぶんを外転（脚を左右に開く）へ振り替える */
function legPose(t, amp, run, out, fwd = 1, strafe = 0, side = 1) {
  const sn = Math.sin(t), cs = Math.cos(t);
  const stride = (0.50 + run * 0.42) * amp;
  /* 停止時(amp=0)に全部0を返していたので、腿と脛が完全に真っ直ぐな筒2本になり、
     体重が乗っていない「台に刺したフィギュア」に見えていた。人は立っている時も
     膝を伸ばし切らない。基準の曲げを常時入れる（足首はその分だけ戻して靴底を
     水平に保つ。ここを入れないと爪先立ちになる） */
  out.thigh = 0.05 + sn * stride * Math.abs(fwd);
  /* 静止時のわずかな開き＋横移動ぶん。
     横へ振るのは足が浮いている遊脚期（cos>0）だけにする。ここをsideで分けると
     位相のπずれと符号が打ち消し合って両脚が同時に開き、ガニ股で滑って見える。
     遊脚期に縛れば左右が半位相ずれて、先行脚が外・後脚が内を通る形になる */
  out.abduct = side * 0.045 + strafe * (0.10 + 0.26 * Math.max(0, cs));

  const swingFlex = Math.max(0, cs);                 // 遊脚期は膝を抱え込む
  const impact = Math.max(0, Math.sin(t - 0.6));     // 接地直後の沈み込み
  // 膝は後ろにしか曲がらない。前に折れると一発で人形に見える
  out.knee = -0.11 - amp * (0.10 + swingFlex * (0.70 + run * 0.80) + impact * (0.20 + run * 0.20));

  let ankle = 0.06 + amp * 0.28 * Math.sin(t + 0.5);
  // 立脚中は足裏を地面と平行に保つ。ここを入れないと足首が伸びっぱなしで滑って見える
  const stanceW = Math.max(0, -cs);
  ankle = ankle * (1 - stanceW) + (-(out.thigh + out.knee)) * stanceW * 0.9;
  // 蹴り出しでつま先を返す。返しすぎるとつま先が床にめり込む
  const toe = Math.max(0, -Math.sin(t + 0.35));
  out.ankle = ankle - amp * (0.19 + run * 0.24) * toe * toe;
}

/* --------------------------------------------------------------- 敵 */

const STATE = { IDLE: 0, ALERT: 1, CHASE: 2, ENGAGE: 3, DEAD: 4, COVER: 5 };
// 弾倉交換にかける時間。状態として持たずタイマーだけにしてあるのは、
// 移動や索敵は交換中も普通に続くから（状態を割ると全部そこに書き足す羽目になる）
const RELOAD_TIME = 1.9;
// 仲間と同じ方向から突っ込まないように、プレイヤーを囲む方位を配る
const SLOT_BEARING = [0, 0.95, -0.95, 1.85, -1.85, 2.7, -2.7, 0.5, -0.5];
const _wish = { x: 0, z: 0 };

export class Enemy {
  constructor(level, opts = {}) {
    this.level = level;
    this.octree = level.octree;
    this.variant = makeVariant();
    this.parts = buildSoldier(this.variant);
    this.root = this.parts.root;
    // 影の入り切りを毎回traverseで探すと無駄なので、生成時に1回だけ集める
    this.meshes = [];
    this.root.traverse((o) => { if (o.isMesh) this.meshes.push(o); });
    // 足元の接地の暗がり。rootの子にすると倒れた時に一緒に回るのでシーン直下に置く
    this.blob = makeContactShadow();
    this.blob.visible = false;
    this.scene = null;              // Directorが入れる。銃を落とす先にも使う

    this.bodyScale = this.variant.scale;
    this.radius = 0.34;
    this.height = 1.78 * this.bodyScale;
    this.collider = new Capsule(new THREE.Vector3(), new THREE.Vector3(), this.radius);

    this.maxHealth = opts.health ?? 100;
    this.health = this.maxHealth;
    this.alive = true;
    this.state = STATE.IDLE;

    this.velocity = new THREE.Vector3();
    this.onFloor = false;
    this.facing = Math.random() * TAU;
    this.aimYaw = this.facing;
    this.aimPitch = 0;
    this.lowerYaw = this.facing;      // 下半身の向き。上半身とは別に回す
    this.twist = 0;
    this.crouch = 0;

    this.speed = opts.speed ?? 3.4;
    // 既定値はウェーブ1相当。Directorが波ごとに上書きする
    this.damage = opts.damage ?? 6.6;
    this.accuracy = opts.accuracy ?? 0.32;   // 0..1
    this.fireRate = opts.fireRate ?? 0.155;
    this.burstLeft = 0;
    this.fireTimer = 0;
    this.burstCooldown = 0;
    this.reactionTimer = 0;

    // 個体差。同じ歩調・同じ反応速度で並ぶと機械に見える
    this.gaitRate = 0.9 + Math.random() * 0.24;
    this.reactionBase = 0.22 + Math.random() * 0.42;
    this.turnRate = 6.0 + Math.random() * 3.0;
    this.engageRange = 11 + Math.random() * 7;
    this.aggression = 0.6 + Math.random() * 0.8;
    this.swayFreq = 0.7 + Math.random() * 0.9;
    this.swayPhase = Math.random() * TAU;

    this.walkPhase = Math.random() * TAU;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeTimer = 0;
    this.squadSlot = 0;
    this.squad = null;
    this.target = new THREE.Vector3();
    this.coverTarget = new THREE.Vector3();
    this.hasCover = false;
    this.coverHold = 0;
    this.coverCooldown = 0;
    this.peekTimer = 0;
    this.recentDamage = 0;
    this.hasLOS = false;
    this.losTimer = 0;
    this.flinch = 0;
    this.flinchPart = 'chest';
    this.flinchSide = 1;
    this.deathTime = 0;
    this.deathSpin = 0;
    this.deathKind = 0;
    this._gunKick = 0;
    this._turning = 0;
    // 歩行位相を進める向き。真横に動いている時に毎フレーム反転しないよう、
    // 前後成分がはっきりしている時だけ更新する
    this._dirSign = 1;

    /* 構えの高さ。1が肩付け照準、0がロー・レディ（銃を下げた状態）。
       全員が常に同じ肩付けだと、距離も状況も違う4体が同じ姿勢で並んで、
       個体差の色や装備をいくら振っても「同じ人が4人」に見える */
    this.readyBlend = 1;
    this.reloadTime = 0;

    // 待機中の呼吸・見回し・構え直し。止まった敵が完全な静止画だと群れが機械に見える
    /* 構えの型。全員が同じ高さで同じ角度に銃を持つと、色と小物をいくら振っても
       10m以上では同型の4人にしか見えない。個体差を姿勢そのものへ移す */
    const st = this.variant.stance;
    this.stanceY = st === 'high' ? 0.035 : st === 'low' ? -0.030 : -0.060;
    this.stanceLean = st === 'high' ? -0.055 : st === 'low' ? 0.045 : 0.010;
    // 巡回型は肩付けが浅い。交戦中でも銃を完全には上げ切らない
    this.stanceReady = st === 'patrol' ? 0.82 : st === 'low' ? 0.94 : 1;
    // 前に出した足へ体重を寄せる。左右対称に立っている人はいない
    this.hipLean = (this.variant.stagger >= 0 ? -1 : 1) * 0.045;

    // 近距離用の細部の入り切り。切り替えた時だけ触る
    this._detailOn = true;

    this.breathPhase = Math.random() * TAU;
    this.breathRate = TAU / (3.5 + Math.random());
    this.lookTimer = 1 + Math.random() * 3;
    this.lookYaw = 0;
    this.lookTarget = 0;
    this.regripTimer = 6 + Math.random() * 9;
    this.regrip = 0;

    // 接地まわり。octreeへのレイは間引いて使い回す
    this.groundY = 0;
    this.groundTimer = 0;
    this.footGround = [0, 0];
    this.footTimer = 0;
    this._playerDist = 99;

    // 死体まわり
    this.deathSettled = false;
    this.gunDropped = false;
    this.gunRest = false;
    this.gunVel = new THREE.Vector3();
    this.gunSpin = new THREE.Vector3();
    this.gunGround = 0;
    this._deathLift = 0;
    this._deathRoll = 0;
    this._deathConformed = false;
    // 壁際で倒れ切れなかった個体の倒れ角の抑え込み
    this._deathFold = 1;
    this._foldTarget = 1;
    this.handsFreed = false;
    this._lastShotDir = new THREE.Vector3(0, 0, -1);
    // 被弾方向を体のローカルへ落とした値。倒れ始めの衝撃項に使う
    this._deathPushBack = 0;
    this._deathPushSide = 0;
    this._armSlack = 0;
    this._qa = new THREE.Quaternion();
    this._qb = new THREE.Quaternion();
    this._deathMat = new THREE.Matrix4();

    this.onShoot = null;
    this.onDeath = null;

    // 判定用（毎フレーム位置を更新する）
    this._headPos = new THREE.Vector3();
    this._chestA = new THREE.Vector3();
    this._chestB = new THREE.Vector3();
    this._legA = new THREE.Vector3();
    this._legB = new THREE.Vector3();

    // 視線計算で使い回す。共有の一時ベクトルを使うと、途中の
    // _lineOfSight呼び出しに踏まれて狙いが狂う
    this._toPlayer = new THREE.Vector3();
    this._playerEye = new THREE.Vector3();
    this._myEye = new THREE.Vector3();
  }

  spawn(pos) {
    this.collider.start.set(pos.x, pos.y + this.radius, pos.z);
    this.collider.end.set(pos.x, pos.y + this.height - this.radius, pos.z);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.alive = true;
    // 湧いた時点で攻め手として動き出す。棒立ちで待たれると戦闘が始まらない
    this.state = STATE.CHASE;
    this.root.visible = true;
    this.deathTime = 0;
    this.flinch = 0;
    this.burstLeft = 0;
    this.crouch = 0;
    this.recentDamage = 0;
    this.coverHold = 0;
    this.coverCooldown = 1.5;
    this.hasCover = false;
    this._gunKick = 0;
    this._turning = 0;
    this.lowerYaw = this.aimYaw;
    this.twist = 0;
    this.deathSettled = false;
    this._deathConformed = false;
    this._deathLift = 0;
    this._deathRoll = 0;
    this._deathFold = 1;
    this._foldTarget = 1;
    this._armSlack = 0;
    this.readyBlend = 1;
    this.reloadTime = 0;
    this.groundY = pos.y;
    this.groundTimer = 0;
    this.footGround[0] = this.footGround[1] = pos.y;
    this.blob.visible = true;
    // 死体で切った影を戻す
    for (const m of this.meshes) m.castShadow = true;
    this._corpseShadowOn = true;
    this._detailOn = true;
    for (const g of this.parts.detail) g.visible = true;
    this._pickUpGun();
    this._resetPose();
    this._syncHitboxes();
  }

  /** 落とした銃を構えに戻す。使い回す時にここを忘れると武器なしで湧く */
  _pickUpGun() {
    const p = this.parts;
    const g = p.gun;
    if (g.parent !== p.gunMount) {
      p.gunMount.add(g);
    }
    // 銃の原点は床尾板の背面。位置は保持点そのものなので0でいい
    g.position.set(0, 0, 0);
    g.rotation.set(GUN_PITCH, GUN_BLADE, 0);
    g.scale.setScalar(1);
    g.visible = true;
    // 死んだ時に前腕へ移した手を銃へ戻す。ここを忘れると手が腕に付いたまま
    // 銃だけ構え直すことになる
    if (this.handsFreed) {
      for (const [hand, home] of [[p.handR, p.handHomeR], [p.handL, p.handHomeL]]) {
        p.hands.add(hand);
        hand.position.copy(home.p);
        hand.quaternion.copy(home.q);
        hand.scale.set(1, 1, 1);
      }
      this.handsFreed = false;
    }
    p.hands.visible = true;
    this.gunDropped = false;
    this.gunRest = false;
  }

  /* 手を銃から外して前腕の子に移す。銃といっしょに消すと、倒れ切った死体が
     両腕とも袖口で切れた断端で永久に残る。死体は一番長く見られる静止画なので、
     そこで四肢が途中で終わっているのが一番安く見える。
     attach()はワールド変換を保ったまま親を替えるので、見た目は連続する */
  _freeHands() {
    const p = this.parts;
    this.handsFreed = true;
    for (const [hand, fore] of [[p.handR, p.lowerR], [p.handL, p.lowerL]]) {
      fore.attach(hand);
      // 握るものが無くなったので手首を開く。握りの形のままだと空を掴んで見える
      hand.rotateX(0.45);
    }
  }

  _resetPose() {
    const p = this.parts;
    this.root.rotation.set(0, 0, 0);
    p.hips.rotation.set(0, 0, 0);
    p.hips.position.set(0, 0.92, 0);
    p.chest.rotation.set(0, 0, 0);
    p.chest.position.set(0, 0.12, 0);
    p.headPivot.rotation.set(0, 0, 0);
    p.headPivot.position.copy(p.headHome);
    p.gunMount.position.copy(p.mountHome);
    p.gunMount.rotation.set(0, 0, 0);
    for (const g of [p.legL, p.legR, p.shinL, p.shinR, p.footL, p.footR]) g.rotation.set(0, 0, 0);
  }

  get feetY() { return this.collider.start.y - this.radius; }

  get eyePos() {
    return _v3.set(this.collider.start.x, this.feetY + 1.62 * this.bodyScale, this.collider.start.z);
  }

  _syncHitboxes() {
    const x = this.collider.start.x, z = this.collider.start.z;
    const y = this.feetY;
    const s = this.bodyScale;
    // しゃがむと的が小さくなる。見た目だけ縮んで判定が残ると理不尽なので合わせる
    const c = this.crouch * 0.30 * s;
    this._headPos.set(x, y + 1.68 * s - c, z);
    this._chestA.set(x, y + 1.02 * s - c * 0.8, z);
    this._chestB.set(x, y + 1.50 * s - c, z);
    this._legA.set(x, y + 0.12 * s, z);
    this._legB.set(x, y + 1.00 * s - c * 0.8, z);
  }

  /* 描いている骨の位置から判定を作り直す。上体は最大1.05rad捻り、胸も0.42
     仰け反るので、棒立ちの筒で判定を持つと見た目と20cm近くずれる。
     「頭を撃ったのに抜けた」「何も無い所が頭判定」はここが原因 */
  _syncHitboxesFromBones() {
    const p = this.parts;
    this.root.updateMatrixWorld(true);
    p.headBone.getWorldPosition(this._headPos);
    p.chestTop.getWorldPosition(this._chestB);
    p.chestBot.getWorldPosition(this._chestA);
    // 脚は左右のブーツの中点と腰でカプセルを作る。走行中も画に付いてくる
    p.footL.getWorldPosition(_v);
    p.footR.getWorldPosition(_v2);
    this._legA.addVectors(_v, _v2).multiplyScalar(0.5);
    this._legA.y += 0.10 * this.bodyScale;
    p.hips.getWorldPosition(this._legB);
  }

  /** 弾のレイと交差するか。近い順に部位を判定して倍率を返す */
  intersect(origin, dir) {
    if (!this.alive) return null;
    const s = this.bodyScale;
    const th = raySphere(origin, dir, this._headPos, 0.19 * s);
    const tc = rayCapsule(origin, dir, this._chestA, this._chestB, 0.30 * s);
    const tl = rayCapsule(origin, dir, this._legA, this._legB, 0.24 * s);

    let best = Infinity, part = null;
    if (th >= 0 && th < best) { best = th; part = 'head'; }
    if (tc >= 0 && tc < best) { best = tc; part = 'chest'; }
    if (tl >= 0 && tl < best) { best = tl; part = 'legs'; }
    if (!part) return null;
    // 倒れる向きに弾の飛来方向を効かせたい。hit()に引数を足すと呼び出し側の
    // 変更が要るので、当たった瞬間の向きをここで覚えておく
    this._lastShotDir.copy(dir);
    return {
      distance: best,
      part,
      point: new THREE.Vector3().copy(origin).addScaledVector(dir, best),
      enemy: this,
    };
  }

  hit(amount, part, shotDir) {
    if (!this.alive) return false;
    if (shotDir) this._lastShotDir.copy(shotDir);
    this.health -= amount;
    this.recentDamage += amount;
    // 部位ごとに仰け反り方を変える。全部同じ揺れだと当たった場所が伝わらない
    this.flinchPart = part ?? 'chest';
    this.flinchSide = Math.random() < 0.5 ? -1 : 1;
    this.flinch = Math.min(1, this.flinch + (part === 'head' ? 0.85 : part === 'legs' ? 0.7 : 0.6));
    // 撃たれたら反撃モードに入る（背後から撃たれても気づく）
    if (this.state === STATE.IDLE) {
      this.state = STATE.ALERT;
      this.reactionTimer = this.reactionBase * 0.6;
    }
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.state = STATE.DEAD;
      this.deathTime = 0;
      this.deathSettled = false;
      this._deathConformed = false;
      this._armSlack = 0;
      this.deathKind = this._pickDeath(part);
      // 弾の運動量を死体に乗せる。当てた側の手応えはここで決まる
      const d = this._lastShotDir;
      const push = (part === 'head' ? 3.2 : 1.8) * (0.8 + Math.random() * 0.5);
      const hl = Math.hypot(d.x, d.z) || 1;
      this.velocity.x += (d.x / hl) * push;
      this.velocity.z += (d.z / hl) * push;
      this.onDeath?.(this);
      return true;
    }
    return false;
  }

  // 死に方が一種類だと、複数体が同時に倒れた時に全く同じ動きをして興ざめする。
  // 倒れる向きは弾の飛来方向で決める。正面から胸を撃った敵がこちらへ
  // 前のめりに倒れると、運動量が画に出ず手応えが消える
  _pickDeath(part) {
    const d = this._lastShotDir;
    // 兵士の前方(-Z)と右方向(+X)。ヨー0で前方が-Z
    const fx = -Math.sin(this.lowerYaw), fz = -Math.cos(this.lowerYaw);
    const rx = Math.cos(this.lowerYaw), rz = -Math.sin(this.lowerYaw);
    const front = d.x * fx + d.z * fz;   // 正なら背中から撃たれている
    const side = d.x * rx + d.z * rz;
    // 横に流れた弾ほど横倒し、体の右へ抜けたなら右へ回る
    this.deathSpin = clamp(side * 3.4, -3.2, 3.2) + rand(0.8);
    // 押された向きを覚えておく。倒れ始めの一瞬だけ上体をそちらへ突き飛ばす
    this._deathPushBack = front;
    this._deathPushSide = side;
    const r = Math.random();
    if (Math.abs(side) > 0.72 && r < 0.6) return 3;            // 真横から食らったら横倒し
    if (part === 'legs' && r < 0.6) return 2;                  // 脚を撃たれたら崩れ落ちる
    // 頭に入ったら支えが消える。踏ん張らずに膝から落ちるのが一番それらしい
    if (part === 'head') return r < 0.62 ? 2 : 3;
    // 背中側から被弾なら前のめり、正面からなら後ろ倒れ
    return front > 0 ? (r < 0.78 ? 0 : 2) : (r < 0.78 ? 1 : 3);
  }

  _lineOfSight(from, to) {
    _v.subVectors(to, from);
    const dist = _v.length();
    if (dist < 0.001) return true;
    _v.divideScalar(dist);
    _ray.origin.copy(from);
    _ray.direction.copy(_v);
    const hit = this.octree.rayIntersect(_ray);
    return !hit || hit.distance > dist - 0.2;
  }

  _collide() {
    const hit = this.octree.capsuleIntersect(this.collider);
    this.onFloor = false;
    if (!hit) return;
    this.onFloor = hit.normal.y > 0.35;
    if (!this.onFloor) {
      this.velocity.addScaledVector(hit.normal, -hit.normal.dot(this.velocity));
    } else if (this.velocity.y < 0) {
      this.velocity.y = 0;
    }
    this.collider.translate(hit.normal.multiplyScalar(hit.depth));
  }

  /** 遮蔽の裏側に立てる点を探す。見つかればcoverTargetに書いてtrueを返す */
  _pickCover(player) {
    const pts = this.level.coverPoints;
    if (!pts || !pts.length) return false;
    const px = player.collider.start.x, pz = player.collider.start.z;
    const mx = this.collider.start.x, mz = this.collider.start.z;
    let bestScore = -Infinity, bx = 0, bz = 0;
    for (let i = 0; i < pts.length; i++) {
      const c = pts[i];
      let dx = c.pos.x - px, dz = c.pos.z - pz;
      const dp = Math.hypot(dx, dz);
      if (dp < 5) continue;                       // プレイヤーに近すぎる遮蔽は逆に危ない
      dx /= dp; dz /= dp;
      const sx = c.pos.x + dx * (c.radius + 0.75);  // 遮蔽のプレイヤーと反対側
      const sz = c.pos.z + dz * (c.radius + 0.75);
      const dm = Math.hypot(sx - mx, sz - mz);
      if (dm > 26) continue;
      // 近いほど良い。撃ち返せる距離も残したいので離れすぎも減点。少し乱数を混ぜて全員が同じ岩に集まらないようにする
      const score = -dm - Math.abs(dp - 15) * 0.4 + Math.random() * 3;
      if (score > bestScore) { bestScore = score; bx = sx; bz = sz; }
    }
    if (bestScore === -Infinity) return false;
    this.coverTarget.set(bx, this.feetY, bz);
    return true;
  }

  /** 仲間と重ならないように押しのける力 */
  _separation(out) {
    const sq = this.squad;
    if (!sq) return;
    const x = this.collider.start.x, z = this.collider.start.z;
    for (let i = 0; i < sq.length; i++) {
      const o = sq[i];
      if (o === this || !o.alive) continue;
      const dx = x - o.collider.start.x, dz = z - o.collider.start.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 6.25 || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      const w = (2.5 - d) / 2.5;
      out.x += (dx / d) * w * 1.5;
      out.z += (dz / d) * w * 1.5;
    }
  }

  update(dt, player, ctx) {
    if (!this.alive) {
      // 死体でも距離だけは測る。目の前の死体の影を切るかどうかがこれで決まる
      const dx = this.collider.start.x - player.collider.start.x;
      const dz = this.collider.start.z - player.collider.start.z;
      this._playerDist = Math.hypot(dx, dz);
      this._updateDeath(dt);
      return;
    }

    this._syncHitboxes();
    const playerEye = this._playerEye.set(
      player.collider.start.x,
      player.feetY + player.height - 0.16,
      player.collider.start.z,
    );
    const myEye = this._myEye.copy(this.eyePos);
    const toPlayer = this._toPlayer.subVectors(playerEye, myEye);
    const dist = toPlayer.length();
    toPlayer.divideScalar(Math.max(dist, 0.0001));

    this.recentDamage = Math.max(0, this.recentDamage - dt * 6);
    this.coverCooldown -= dt;
    this._playerDist = dist;
    this._updateDetail(dist);

    // 接地の暗がりと足のIKに使う床の高さ。毎フレーム引くと重いので間引く
    this.groundTimer -= dt;
    if (this.groundTimer <= 0) {
      this.groundTimer = 0.1 + Math.random() * 0.05;
      const g = this._groundBelow(this.collider.start.x, this.feetY + 0.45, this.collider.start.z);
      this.groundY = g === null ? this.feetY : g;
    }

    /* -------------------------------------------------------- 索敵 */
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      // 毎フレーム視線を引くと重いので間引く
      this.losTimer = 0.08 + Math.random() * 0.06;
      const wasVisible = this.hasLOS;
      this.hasLOS = player.alive && dist < 75 && this._lineOfSight(myEye, playerEye);
      if (this.hasLOS && !wasVisible && this.state === STATE.IDLE) {
        this.state = STATE.ALERT;
        this.reactionTimer = this.reactionBase;   // 見つけてから撃つまでの間
      }
    }

    /* -------------------------------------------- 撃たれたら下がる */
    // 削られている最中に棒立ちで撃ち合うのが一番機械っぽい。一度遮蔽へ引く
    if (this.state !== STATE.COVER && this.coverCooldown <= 0
        && this.recentDamage > this.maxHealth * 0.24 && this._pickCover(player)) {
      this.state = STATE.COVER;
      this.coverHold = 1.6 + Math.random() * 1.8;
      this.coverCooldown = 5.5 + Math.random() * 3;
      this.hasCover = false;
      this.recentDamage = 0;
      this.peekTimer = 1.0 + Math.random();
    }

    /* ---------------------------------------------------- 状態遷移 */
    switch (this.state) {
      case STATE.IDLE:
        // 何もしなくても、プレイヤーが近ければ気づく
        if (dist < 22 && player.alive) { this.state = STATE.ALERT; this.reactionTimer = this.reactionBase + 0.2; }
        break;
      case STATE.ALERT:
        this.reactionTimer -= dt;
        if (this.reactionTimer <= 0) this.state = this.hasLOS ? STATE.ENGAGE : STATE.CHASE;
        break;
      case STATE.CHASE:
        if (this.hasLOS && dist < 45) this.state = STATE.ENGAGE;
        break;
      case STATE.ENGAGE:
        if (!this.hasLOS) {
          this.chaseGrace = (this.chaseGrace ?? 1.2) - dt;
          if (this.chaseGrace <= 0) { this.state = STATE.CHASE; this.chaseGrace = 1.2; }
        } else {
          this.chaseGrace = 1.2;
        }
        break;
      case STATE.COVER:
        this.coverHold -= dt;
        if (this.coverHold <= 0) { this.state = this.hasLOS ? STATE.ENGAGE : STATE.CHASE; this.hasCover = false; }
        break;
    }

    /* ------------------------------------------------------ 移動先 */
    const engaging = this.state === STATE.ENGAGE;
    const chasing = this.state === STATE.CHASE;
    const covering = this.state === STATE.COVER;
    _wish.x = 0; _wish.z = 0;

    const px = player.collider.start.x, pz = player.collider.start.z;
    const mx = this.collider.start.x, mz = this.collider.start.z;

    if (covering) {
      let dx = this.coverTarget.x - mx, dz = this.coverTarget.z - mz;
      const d = Math.hypot(dx, dz);
      this.hasCover = d < 1.2;
      if (!this.hasCover) {
        _wish.x = dx / (d || 1); _wish.z = dz / (d || 1);
      } else {
        // 遮蔽に着いたら顔を出す間隔を作る。ずっと隠れていても撃ち合いにならない
        this.peekTimer -= dt;
        if (this.peekTimer <= 0) { this.peekTimer = 1.8 + Math.random() * 1.6; this.strafeDir *= -1; }
        const peeking = this.peekTimer < 0.85;
        if (peeking) {
          const tx = px - mx, tz = pz - mz;
          const l = Math.hypot(tx, tz) || 1;
          _wish.x = (-tz / l) * this.strafeDir * 0.9;
          _wish.z = (tx / l) * this.strafeDir * 0.9;
        }
      }
    } else if (chasing || engaging) {
      let dx = px - mx, dz = pz - mz;
      const flat = Math.hypot(dx, dz) || 1;
      dx /= flat; dz /= flat;

      if (engaging) {
        // 好みの交戦距離を保ちつつ横に動く。棒立ちだと的になるので必ず動かす
        const ideal = this.engageRange;
        const closing = clamp((flat - ideal) / 10, -1, 1) * this.aggression;
        this.strafeTimer -= dt;
        if (this.strafeTimer <= 0) {
          this.strafeTimer = 0.8 + Math.random() * 1.4;
          if (Math.random() < 0.45) this.strafeDir *= -1;
        }
        _wish.x = dx * closing + (-dz) * this.strafeDir * 0.85;
        _wish.z = dz * closing + (dx) * this.strafeDir * 0.85;
      } else {
        // 割り当てられた方位からプレイヤーに寄る。全員が最短距離で来ると一列になる
        const bearing = Math.atan2(mx - px, mz - pz) + SLOT_BEARING[this.squadSlot % SLOT_BEARING.length]
          * clamp((flat - 8) / 22, 0, 1);
        const gx = px + Math.sin(bearing) * this.engageRange;
        const gz = pz + Math.cos(bearing) * this.engageRange;
        let ax = gx - mx, az = gz - mz;
        const al = Math.hypot(ax, az) || 1;
        _wish.x = ax / al; _wish.z = az / al;
        // 壁に張り付いたら少し横にずらして回り込む
        if (this.velocity.lengthSq() < 0.4) {
          _wish.x += -dz * this.strafeDir * 0.9;
          _wish.z += dx * this.strafeDir * 0.9;
        }
      }
    }

    this._separation(_wish);

    let wishX = _wish.x, wishZ = _wish.z;
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 1) { wishX /= wl; wishZ /= wl; }

    /* ------------------------------------------------ しゃがみ具合 */
    const wantCrouch = (covering && this.hasCover && this.peekTimer > 0.85) ? 1 : 0;
    this.crouch += (wantCrouch - this.crouch) * Math.min(1, dt * 6);

    /* -------------------------------------------------- 加速と摩擦 */
    const targetSpeed = this.speed * (engaging ? 0.78 : covering && !this.hasCover ? 1.08 : 1)
      * (1 - this.flinch * 0.4) * (1 - this.crouch * 0.55);
    const accel = this.onFloor ? 12 : 3;
    if (this.onFloor) {
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      if (sp > 0.01) {
        const drop = Math.max(sp, 2) * 9 * dt;
        const f = Math.max(sp - drop, 0) / sp;
        this.velocity.x *= f; this.velocity.z *= f;
      }
    }
    const cur = this.velocity.x * wishX + this.velocity.z * wishZ;
    const add = targetSpeed - cur;
    if (add > 0 && wl > 0.01) {
      const step = Math.min(accel * targetSpeed * dt, add);
      this.velocity.x += wishX * step;
      this.velocity.z += wishZ * step;
    }
    this.velocity.y -= 22 * dt;

    // 段差の前で詰まったら小さく跳ねて乗り越える
    if (this.onFloor && wl > 0.3 && Math.hypot(this.velocity.x, this.velocity.z) < 0.7) {
      this._stuck = (this._stuck ?? 0) + dt;
      if (this._stuck > 0.45) { this.velocity.y = 5.2; this._stuck = 0; }
    } else {
      this._stuck = 0;
    }

    const dist2 = this.velocity.length() * dt;
    const steps = clamp(Math.ceil(dist2 / 0.2), 1, 4);
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.collider.translate(_v3.set(this.velocity.x * sub, this.velocity.y * sub, this.velocity.z * sub));
      this._collide();
    }
    if (this.collider.start.y < -20) this.spawn(this.level.enemySpawns[0]);
    this._syncHitboxes();

    /* -------------------------------------------------------- 照準 */
    const wantYaw = Math.atan2(-toPlayer.x, -toPlayer.z);
    const wantPitch = Math.asin(clamp(toPlayer.y, -1, 1));
    if (chasing || engaging || covering || this.state === STATE.ALERT) {
      const d = wrapPi(wantYaw - this.aimYaw);
      this.aimYaw += d * Math.min(1, dt * this.turnRate);
      this.aimPitch += (wantPitch - this.aimPitch) * Math.min(1, dt * this.turnRate);
    } else if (this.velocity.lengthSq() > 0.5) {
      const moveYaw = Math.atan2(-this.velocity.x, -this.velocity.z);
      this.aimYaw += wrapPi(moveYaw - this.aimYaw) * Math.min(1, dt * 4);
    }

    /* -------------------------------------------------------- 射撃 */
    this.fireTimer -= dt;
    this.burstCooldown -= dt;
    if (this.reloadTime > 0) this.reloadTime -= dt;
    const canFire = (engaging || (covering && this.crouch < 0.55)) && this.reloadTime <= 0;
    if (canFire && this.hasLOS && player.alive && dist < 55) {
      // 正面を向き切ってから撃つ
      const aimErr = wrapPi(wantYaw - this.aimYaw);
      if (Math.abs(aimErr) < 0.28) {
        if (this.burstLeft <= 0 && this.burstCooldown <= 0) {
          this.burstLeft = 3 + Math.floor(Math.random() * 4);
        }
        if (this.burstLeft > 0 && this.fireTimer <= 0) {
          this._shoot(player, dist, ctx);
          this.fireTimer = this.fireRate;
          this.burstLeft--;
          if (this.burstLeft <= 0) {
            this.burstCooldown = 0.6 + Math.random() * 1.1;
            // 一連射ごとに確率で弾倉交換。撃てない間ずっとフル照準で棒立ちなのが
            // 一番機械に見えるので、ここで銃を下ろす動作を挟む
            if (Math.random() < 0.3) this.reloadTime = RELOAD_TIME;
          }
        }
      }
    } else {
      this.burstLeft = 0;
    }

    // 仰け反りは速く戻す。だらだら揺れていると当たった手応えが消える
    this.flinch = Math.max(0, this.flinch - this.flinch * dt * 6 - dt * 0.35);
    this._animate(dt);
  }

  /* 距離で見た目の投資先を切り替える。
     10m先の頭は画面上で14pxしかなく、鼻も頬骨もポーチの留め具も1px未満の
     染みにしかならない。輪郭を1つも割らない物にGPUを払う意味はないので落とす。
     バイザーの発光も同じ理屈で、遠くではサブピクセルに潰れて赤い砂粒になるだけ */
  _updateDetail(dist) {
    const want = dist < 20;
    if (want !== this._detailOn) {
      this._detailOn = want;
      for (const g of this.parts.detail) g.visible = want;
    }
    const eye = this.parts.mats.eye;
    // 12mまでは満、25mで消える。歩兵の顔に無条件の発光を置き続けない
    eye.emissiveIntensity = 0.85 * (1 - sstep(12, 25, dist));
  }

  _shoot(player, dist, ctx) {
    const muzzleWorld = this.parts.muzzle.getWorldPosition(new THREE.Vector3());
    const playerEye = _v.set(
      player.collider.start.x,
      player.feetY + player.height - 0.16,
      player.collider.start.z,
    );
    const dir = _v2.subVectors(playerEye, muzzleWorld).normalize().clone();

    // 距離が離れるほど、相手が動くほど当たりにくくする
    const moveFactor = clamp(player.horizontalSpeed / 6, 0, 1);
    const acc = this.accuracy * (1 - clamp((dist - 12) / 45, 0, 0.6)) * (1 - moveFactor * 0.3);
    const hitRoll = Math.random() < acc;

    const spread = hitRoll ? 0.004 : 0.035 + Math.random() * 0.05;
    const a = Math.random() * TAU;
    const r = Math.sqrt(Math.random()) * spread;
    const right = _v3.set(1, 0, 0).applyAxisAngle(BONE_UP, this.aimYaw);
    dir.addScaledVector(right, Math.cos(a) * r);
    dir.y += Math.sin(a) * r;
    dir.normalize();

    this.onShoot?.(this, muzzleWorld, dir, hitRoll ? this.damage : 0, dist);

    // 発砲の反動で銃口が跳ねる
    this.aimPitch += 0.02;
    this._gunKick = Math.min(1, this._gunKick + 0.7);
  }

  /* ---------------------------------------------------------- 死亡 */

  /** 真下の床の高さ。当たらなければnull */
  _groundBelow(x, y, z) {
    _ray.origin.set(x, y, z);
    _ray.direction.set(0, -1, 0);
    const hit = this.octree.rayIntersect(_ray);
    if (!hit) return null;
    return hit.position ? hit.position.y : y - hit.distance;
  }

  /** 倒れ切った所で地形に合わせる。剛体を回すだけだと木箱や斜面に必ず刺さる */
  _conformToGround() {
    const p = this.parts;
    this.root.updateMatrixWorld(true);
    p.chest.getWorldPosition(_v);
    const gy = this._groundBelow(_v.x, _v.y + 0.6, _v.z);
    this._deathLift = gy === null ? 0 : clamp(gy - this.feetY, -0.15, 1.0);
    // 体の左右で床の高さが違うなら、そのぶん寝かせる
    const rx = Math.cos(this.lowerYaw) * 0.45, rz = -Math.sin(this.lowerYaw) * 0.45;
    const cx = this.collider.start.x, cz = this.collider.start.z, cy = this.feetY + 0.9;
    const gr = this._groundBelow(cx + rx, cy, cz + rz);
    const gl = this._groundBelow(cx - rx, cy, cz - rz);
    this._deathRoll = (gr === null || gl === null) ? 0
      : clamp(Math.atan2(gr - gl, 0.9), -0.45, 0.45);
    // 倒れた先の床の高さ。接地の暗がりをここに合わせて置き直す
    const gc = this._groundBelow(cx, cy, cz);
    if (gc !== null) this.groundY = gc;
  }

  /* 倒れた先に壁や木箱があっても、真下へのレイ3本では何も押し戻せない。
     倒れ切った死体は数秒間そこに残る静止画なので、頭と肩が箱の内側に
     刺さったまま止まるのが一番長く見られてしまう。
     寝そべった向きに水平のカプセルを1本置いて、当たっていたら水平に押し出す */
  _pushOutCorpse() {
    const c = this.collider.start;
    const k = this.deathKind;
    let ax, az;
    if (k === 3) {
      // 横倒し。体は倒れた側（右か左）へ伸びる
      const s = this.deathSpin >= 0 ? 1 : -1;
      ax = Math.cos(this.lowerYaw) * s; az = -Math.sin(this.lowerYaw) * s;
    } else {
      // 前のめり(0,2)は前方、後ろ倒れ(1)は後方へ伸びる
      const s = k === 1 ? 1 : -1;
      ax = Math.sin(this.lowerYaw) * s; az = Math.cos(this.lowerYaw) * s;
    }
    const y = this.groundY + 0.26;
    let pushed = 0;
    for (let i = 0; i < 3; i++) {
      _corpseCap.start.set(c.x + ax * 0.20, y, c.z + az * 0.20);
      _corpseCap.end.set(c.x + ax * 1.10, y, c.z + az * 1.10);
      const hit = this.octree.capsuleIntersect(_corpseCap);
      if (!hit) break;
      // 上向きの成分で押すと死体が宙に浮くので、水平成分だけ使う
      const nl = Math.hypot(hit.normal.x, hit.normal.z);
      if (nl < 0.05) break;
      const d = Math.min(hit.depth, 0.25);
      this.collider.translate(_v3.set((hit.normal.x / nl) * d, 0, (hit.normal.z / nl) * d));
      pushed++;
    }
    // 3回押しても抜けないなら、そもそも倒れ切れる隙間が無い。角度を戻して
    // 壁に寄りかからせる
    if (pushed >= 3) this._foldTarget = 0.68;
  }

  /** 銃を手から離してシーン直下に落とす。武器が手から離れるのが死の一番強い記号 */
  _dropGun() {
    const p = this.parts;
    const g = p.gun;
    const host = this.scene ?? this.root.parent;
    if (!host || this.gunDropped) return;
    g.updateWorldMatrix(true, false);
    this._deathMat.copy(g.matrixWorld);
    host.add(g);
    this._deathMat.decompose(g.position, g.quaternion, g.scale);
    this.gunDropped = true;
    this.gunRest = false;
    const d = this._lastShotDir;
    this.gunVel.set(d.x * 0.9 + rand(0.7), 0.8 + Math.random() * 0.6, d.z * 0.9 + rand(0.7));
    this.gunSpin.set(rand(7), rand(7), rand(7));
    this.gunGround = this._groundBelow(g.position.x, g.position.y + 0.4, g.position.z)
      ?? (this.feetY - 0.3);
    // 手は銃から外して腕へ移す。銃と同時にやらないと、銃だけ落ちた後の
    // コンマ数秒だけ手袋が空中で構えの形のまま残る
    if (!this.handsFreed) this._freeHands();
  }

  _updateDroppedGun(dt) {
    const g = this.parts.gun;
    if (!this.gunDropped || this.gunRest) return;
    this.gunVel.y -= 20 * dt;
    g.position.addScaledVector(this.gunVel, dt);
    this._qb.setFromEuler(_be.set(this.gunSpin.x * dt, this.gunSpin.y * dt, this.gunSpin.z * dt));
    g.quaternion.premultiply(this._qb);
    if (g.position.y <= this.gunGround + 0.05) {
      g.position.y = this.gunGround + 0.05;
      // 転がり切ったら横に寝かせる。宙ぶらりんの角度で止まると置物に見える
      _be.setFromQuaternion(g.quaternion, 'YXZ');
      g.rotation.set(0, _be.y, (this.deathSpin >= 0 ? 1 : -1) * (1.25 + Math.random() * 0.3));
      this.gunVel.set(0, 0, 0);
      this.gunRest = true;
    }
  }

  _relaxArm(upper, fore, side, k) {
    // 体の横へ投げ出された角度。IKのまま止めると銃を握った両手が胴を貫通する
    this._qa.setFromEuler(_be.set(-0.15, 0, side * (0.62 + this.deathKind * 0.06)));
    upper.quaternion.slerp(this._qa, k);
    this._qa.setFromEuler(_be.set(-0.35, 0, 0));
    fore.quaternion.slerp(this._qa, k);
  }

  /* 死体の影。前回は倒れ切って3秒で一律castShadow=falseにしていたので、
     目の前の死体だけ影が消えて床から浮いた絵になっていた。
     負荷を切りたいのは遠くの死体なので、距離で決める */
  _corpseShadow() {
    const want = this._playerDist < 35;
    if (want === this._corpseShadowOn) return;
    this._corpseShadowOn = want;
    for (const m of this.meshes) m.castShadow = want;
  }

  _updateDeath(dt) {
    // 倒れ切った死体は静的な物として置いておくだけにする。
    // 更新を止めてしまえば、残しっぱなしでも負荷にならない
    if (this.deathSettled) { this._corpseShadow(); return; }

    this.deathTime += dt;
    const t = this.deathTime;
    const p = this.parts;

    // 空中で撃たれた個体がその場で固まると一気に嘘くさい。倒れる間は落ちる
    if (t < 1.8) {
      this.velocity.y -= 22 * dt;
      this.collider.translate(_v3.set(this.velocity.x * dt * 0.5, this.velocity.y * dt, this.velocity.z * dt * 0.5));
      this._collide();
      this.velocity.x *= 0.92; this.velocity.z *= 0.92;
    }
    if (t > 0.22) this._dropGun();
    this._updateDroppedGun(dt);

    // 倒れ切ったあとの余韻。ぴたっと止まると人形が置かれたように見える
    const settle = Math.sin(t * 16) * Math.exp(-t * 4.5) * 0.05;
    const roll = this.deathSpin * 0.09;

    this.root.position.set(this.collider.start.x, this.feetY, this.collider.start.z);
    this.root.rotation.y = this.lowerYaw;
    p.hips.position.set(0, 0.92, 0);
    p.hips.rotation.set(0, 0, 0);
    p.legL.rotation.z = 0; p.legR.rotation.z = 0;   // 歩行中の外転を戻す
    p.chest.rotation.set(0, 0, 0);
    p.headPivot.rotation.set(0, 0, 0);
    // 頬付けで前へ出した首を戻す。戻さないと死体の頭だけずれたまま固まる
    p.headPivot.position.copy(p.headHome);
    // 上体の捻りは倒れながら解ける。ここで即0にすると死んだ瞬間に体が回って見える
    p.chest.rotation.y = this.twist * (1 - ease3(t, 0.5) * 0.75) - GUN_BLADE;

    switch (this.deathKind) {
      case 1: {   // 後ろへ倒れる
        const a = ease3(t, 0.62);
        this.root.rotation.x = a * 1.48 + settle;
        this.root.rotation.z = a * roll;
        this.root.position.y += a * 0.14;
        // 上体を折りすぎると仰向けなのに頭だけ浮いて起き上がって見える
        p.chest.rotation.x = -a * 0.12;
        p.headPivot.rotation.x = a * 0.4;
        p.legL.rotation.x = a * 0.55; p.legR.rotation.x = a * 0.35;
        p.shinL.rotation.x = -a * 0.7; p.shinR.rotation.x = -a * 0.45;
        break;
      }
      case 2: {   // 膝から崩れ、そのまま上体が床へ着く
        const a = ease3(t, 0.36), b = clamp((t - 0.26) / 0.55, 0, 1);
        const bb = 1 - Math.pow(1 - b, 3);
        // 2段目。1.2rad(約69度)で止めると上体が浮いたまま固まるので、
        // 崩れた後に床まで倒し切るカーブを足す
        const c = ease3(t - 0.72, 0.62);
        p.hips.position.y = 0.92 - a * 0.52 - c * 0.28;
        p.legL.rotation.x = a * 0.35 + c * 0.5; p.legR.rotation.x = a * 0.30 + c * 0.35;
        p.shinL.rotation.x = -a * 2.1; p.shinR.rotation.x = -a * 2.0;
        p.footL.rotation.x = -a * 0.6; p.footR.rotation.x = -a * 0.6;
        this.root.rotation.x = -(bb * 1.02 + c * 0.55) + settle * 0.6;
        this.root.rotation.z = bb * roll * 0.6;
        p.chest.rotation.x = -bb * 0.42 + c * 0.30;
        p.headPivot.rotation.x = -bb * 0.3 + c * 0.22;
        break;
      }
      case 3: {   // 横向きに倒れる
        const a = ease3(t, 0.66);
        const side = this.deathSpin >= 0 ? 1 : -1;
        this.root.rotation.z = a * 1.5 * side + settle * side;
        this.root.rotation.x = -a * 0.25;
        this.root.position.y += a * 0.16;
        p.chest.rotation.z = -a * 0.1 * side;
        p.headPivot.rotation.z = -a * 0.3 * side;
        p.legL.rotation.x = a * 0.4; p.shinL.rotation.x = -a * 0.9;
        break;
      }
      default: {  // 前のめり
        const a = ease3(t, 0.58);
        this.root.rotation.x = -a * 1.52 - settle;
        this.root.rotation.z = a * roll;
        this.root.position.y += a * 0.12;
        p.chest.rotation.x = -a * 0.25;
        p.headPivot.rotation.x = -a * 0.4;
        p.legL.rotation.x = -a * 0.3; p.legR.rotation.x = -a * 0.15;
        p.shinL.rotation.x = -a * 0.55; p.shinR.rotation.x = -a * 0.8;
        break;
      }
    }

    /* 撃たれた瞬間の衝撃。倒れ方だけ4種から選んでも、当たった0.15秒に体が
       何も反応しないと「倒れる再生が始まった」だけの絵になる。
       弾道の向きへ上体を押す項を最初の一瞬だけ重ねる */
    if (t < 0.2) {
      const k = Math.sin(clamp(t / 0.15, 0, 1) * Math.PI);
      // 背中から食らったら前へ、弾が体の右へ抜けたなら右へ倒れ込む
      p.chest.rotation.x -= k * this._deathPushBack * 0.34;
      p.chest.rotation.z -= k * this._deathPushSide * 0.30;
      p.headPivot.rotation.x -= k * this._deathPushBack * 0.30;
      p.headPivot.rotation.z -= k * this._deathPushSide * 0.26;
    }

    // 倒れ込む間は銃を握ったまま垂らす。ここで腕だけ元の構えだと死体が浮いて見える
    if (t < 0.55) {
      const d = clamp(t / 0.8, 0, 1);
      const h = p.mountHome;
      p.gunMount.rotation.set(-d * 0.5, 0, d * 0.3);
      p.gunMount.position.set(h.x + d * 0.03, h.y - d * 0.12, h.z + d * 0.06);
      this._solveArms();
    } else {
      // 銃を離した後は腕を体の横へ投げ出す。手は前腕に付け替えて連れて行く。
      // 銃を落とす先が無かった個体（scene未設定）でも手だけは必ず外す
      if (!this.handsFreed) this._freeHands();
      const k = Math.min(1, dt * 5);
      this._relaxArm(p.armR, p.lowerR, 1, k);
      this._relaxArm(p.armL, p.lowerL, -1, k);
    }

    // 壁や木箱にめり込んだ個体は倒れ切らせず、寄りかかる形で止める
    this._deathFold += (this._foldTarget - this._deathFold) * Math.min(1, dt * 4);
    if (this._deathFold < 0.999) {
      this.root.rotation.x *= this._deathFold;
      this.root.rotation.z *= this._deathFold;
    }

    // 地形に合わせる。倒れ切ってから1回だけ測って、あとは補間で寄せる
    if (!this._deathConformed && t > 0.95) {
      this._deathConformed = true;
      this._conformToGround();
      this._pushOutCorpse();
    }
    if (this._deathConformed) {
      const cf = ease3(t - 0.95, 0.5);
      this.root.position.y += this._deathLift * cf;
      this.root.rotation.z += this._deathRoll * cf;
    }

    // 足元の暗がりは死体にも要る。動かなくなった位置に置いたままにする
    this._updateContact();

    // 時間で消さない。自分が倒した死体が目の前で溶けるのは戦闘の痕跡が
    // 残らないということで、AAAとの距離が一番出る挙動。数はDirectorが抑える
    if (t > 3.0) {
      this.deathSettled = true;
      if (!this.gunRest && this.gunDropped) {
        const g = p.gun;
        g.position.y = this.gunGround + 0.05;
        this.gunRest = true;
      }
      this._corpseShadow();
    }
  }

  /* -------------------------------------------------------- 見た目 */

  _solveArms() {
    const p = this.parts;
    p.gunMount.updateMatrix();
    _ikT.copy(p.wristR).applyMatrix4(p.gunMount.matrix);
    solveArm(p.armR, p.lowerR, p.shoulderR, _ikT, POLE_R, LU, LF);
    _ikT.copy(p.wristL).applyMatrix4(p.gunMount.matrix);
    solveArm(p.armL, p.lowerL, p.shoulderL, _ikT, POLE_L, LU, LF);
  }

  _animate(dt) {
    const p = this.parts;
    const spd = Math.hypot(this.velocity.x, this.velocity.z);
    const run = clamp((spd - 1.8) / 2.4, 0, 1);
    const amp = clamp(spd / Math.max(this.speed, 0.5), 0, 1.15);

    /* ------------------------------------ 上半身と下半身の向きを分ける */
    // 走る方向と銃を向ける方向が違う時、腰から上だけ捻る。体ごと向くのは人の動きではない
    const moving = spd > 1.0;
    const moveYaw = moving ? Math.atan2(-this.velocity.x, -this.velocity.z) : this.lowerYaw;
    const LIMIT = 1.05;
    let wantLower = this.aimYaw + clamp(wrapPi(moveYaw - this.aimYaw), -LIMIT, LIMIT);
    if (!moving) {
      // 止まっている時は捻りが限界を超えたら足を踏み替える
      if (Math.abs(wrapPi(this.aimYaw - this.lowerYaw)) > LIMIT * 0.9) this._turning = 1;
      if (this._turning) {
        wantLower = this.aimYaw;
        if (Math.abs(wrapPi(this.aimYaw - this.lowerYaw)) < 0.16) this._turning = 0;
      } else {
        wantLower = this.lowerYaw;
      }
    }
    this.lowerYaw += wrapPi(wantLower - this.lowerYaw) * Math.min(1, dt * (moving ? 10 : 5.5));
    this.twist = wrapPi(this.aimYaw - this.lowerYaw);

    /* ------------------------------------------------------ 歩行位相 */
    // 後ろ向きに動く時は歩行を逆再生する。前進アニメのまま下がると滑って見える
    const moveRel = wrapPi(moveYaw - this.lowerYaw);
    const fwd = Math.cos(moveRel);
    // 真横に近い時はcosの符号が暴れるので、前後がはっきりしている時だけ更新する
    if (Math.abs(fwd) > 0.25) this._dirSign = fwd >= 0 ? 1 : -1;
    const dirSign = this._dirSign;
    // ENGAGE中は常に横成分0.85を混ぜて動くので、ここを見ないとほぼ常時
    // ストレイフしながら前後のストライドを打つことになる
    const strafe = -Math.sin(moveRel) * amp;
    const cycles = (0.62 + spd * 0.30) * this.gaitRate + (this._turning ? 0.5 : 0);
    this.walkPhase += dt * cycles * TAU * dirSign;
    if (this.walkPhase > TAU) this.walkPhase -= TAU;
    else if (this.walkPhase < 0) this.walkPhase += TAU;

    const stepAmp = Math.max(amp, this._turning ? 0.35 : 0.06);
    const t = this.walkPhase;

    this.root.position.set(this.collider.start.x, this.feetY, this.collider.start.z);
    this.root.rotation.set(0, this.lowerYaw, 0);

    /* -------------------------------------------------------- 脚 */
    legPose(t, stepAmp, run, _pose, fwd, strafe, -1);
    p.legL.rotation.x = _pose.thigh;
    p.legL.rotation.z = _pose.abduct;
    p.shinL.rotation.x = _pose.knee;
    p.footL.rotation.x = _pose.ankle;
    legPose(t + Math.PI, stepAmp, run, _pose, fwd, strafe, 1);
    p.legR.rotation.x = _pose.thigh;
    p.legR.rotation.z = _pose.abduct;
    p.shinR.rotation.x = _pose.knee;
    p.footR.rotation.x = _pose.ankle;

    /* しゃがみは膝を折って腰を落とす。前回は腰が22cmしか下がらず、木箱の陰に
       居る個体が上体を全部さらしたまま立っているようにしか見えなかった。
       遮蔽の裏に入る意味が出る深さまで折る（腰は0.92→0.62相当） */
    const cr = this.crouch;
    if (cr > 0.001) {
      p.legL.rotation.x += cr * 1.05; p.legR.rotation.x += cr * 1.05;
      p.shinL.rotation.x -= cr * 1.75; p.shinR.rotation.x -= cr * 1.75;
      p.footL.rotation.x += cr * 0.62; p.footR.rotation.x += cr * 0.62;
    }

    /* -------------------------------------------------------- 骨盤 */
    // 上下動は1歩ごとなので歩行周期の2倍。接地の瞬間が谷になる
    const bobA = (0.035 + run * 0.045) * stepAmp;
    const sink = Math.max(0, Math.sin(t * 2 - 0.9)) * 0.012 * stepAmp;
    let hipY = 0.92 - bobA * 0.5 + Math.cos(t * 2) * bobA * 0.5 - sink - cr * 0.30;
    const legFlinch = this.flinchPart === 'legs' ? this.flinch : 0;
    hipY -= legFlinch * 0.16;
    p.hips.position.y = hipY;

    // 足のIK。三角関数のサイクルだけだと前足が床に刺さり、後ろ足が宙に浮く。
    // 近い個体だけ床を見て腰の高さで吸収する（遠くの個体では画に出ない）
    if (this._playerDist < 26) this._footIK(dt, stepAmp);

    const hipYaw = -Math.sin(t) * (0.09 + run * 0.10) * stepAmp;
    /* 銃を斜めに構えるぶん、腰から下も半分だけ開く。上体だけで角度を作ると
       胸と腰の捻りが常時19度ぶん残り、腰から上だけ捻れた立ち方になる。
       動いている間は進行方向が優先なので効かせない */
    const still = 1 - clamp(amp * 2, 0, 1);
    const bladeHip = -GUN_BLADE * 0.45 * this.readyBlend * still;
    p.hips.rotation.y = hipYaw + bladeHip;
    p.hips.rotation.z = Math.sin(t) * (0.045 + run * 0.03) * stepAmp + Math.sin(moveRel) * amp * 0.06
      + this.hipLean * still;   // 前に出した足へ体重を寄せる
    p.hips.rotation.x = -run * 0.05 * stepAmp + legFlinch * 0.35;
    if (legFlinch > 0.001) {
      p.legL.rotation.x += legFlinch * 0.5; p.legR.rotation.x += legFlinch * 0.35;
      p.shinL.rotation.x -= legFlinch * 0.9; p.shinR.rotation.x -= legFlinch * 0.7;
    }

    /* ------------------------------------------------ 待機中の生体反応 */
    // 歩行位相とは別系統。amp=0でも効かせないと、止まった敵が彫像になる
    this.breathPhase += dt * this.breathRate;
    const breath = Math.sin(this.breathPhase);
    // 数秒おきに周囲を見回す。交戦中は狙いへ戻す
    this.lookTimer -= dt;
    if (this.lookTimer <= 0) {
      this.lookTimer = 2.2 + Math.random() * 3.5;
      this.lookTarget = rand(0.6);
    }
    const engaged = this.state === STATE.ENGAGE || this.state === STATE.COVER;
    this.lookYaw += ((engaged ? 0 : this.lookTarget) - this.lookYaw) * Math.min(1, dt * 1.4);
    // 銃の構え直し。8〜15秒おきに一度下ろして担ぎ直す
    this.regripTimer -= dt;
    if (this.regripTimer <= 0 && this.regrip <= 0 && amp < 0.35 && !engaged) {
      this.regripTimer = 8 + Math.random() * 7;
      this.regrip = 1;
    }
    if (this.regrip > 0) this.regrip = Math.max(0, this.regrip - dt / 0.6);
    const grip = Math.sin(this.regrip * Math.PI);   // 0→1→0

    /* -------------------------------------------------------- 上体 */
    // 骨盤と逆に回す。ここが同じ向きに回ると全身が板のように見える
    const chestYaw = Math.sin(t) * (0.08 + run * 0.07) * stepAmp;
    const bodyFlinch = this.flinchPart === 'chest' ? this.flinch : 0;
    /* 銃を斜めに構えているぶん上体を戻す。これをしないと銃口が狙いから数度ずれる。
       腰を開いたぶん(bladeHip)もここで引く。腰と胸で同じ角度を二重に足すと、
       せっかく合わせた銃口の向きがまた狙いからずれる */
    p.chest.rotation.y = this.twist - GUN_BLADE + chestYaw - hipYaw - bladeHip;
    p.chest.rotation.x = -run * 0.16 * stepAmp + this.aimPitch * 0.25
      + bodyFlinch * 0.42 - legFlinch * 0.25 - cr * 0.22 + breath * 0.022
      + this.stanceLean + this.variant.slouch;   // 構えの型と背中の癖
    p.chest.rotation.z = -Math.sin(t) * 0.03 * stepAmp + bodyFlinch * 0.16 * this.flinchSide;

    /* -------------------------------------------------------- 頭 */
    const headFlinch = this.flinchPart === 'head' ? this.flinch : 0;
    /* 頬付け。構えている間は銃床の上に頬を乗せる。ここが無いと、肩に銃を
       付けても顔だけ真っ直ぐ前を向いていて「覗いていない」絵になる。
       rotation.zを負にすると頭頂が+x（銃床のある右）へ倒れる */
    const weld = this.readyBlend;
    p.headPivot.rotation.x = this.aimPitch * 0.45 + headFlinch * 0.6 - Math.cos(t * 2) * 0.02 * stepAmp
      + weld * 0.09;
    // 上体を戻したぶん頭だけ狙いへ向け直す。顔がプレイヤーを見ていないと気づかれていない印象になる
    p.headPivot.rotation.y = GUN_BLADE - chestYaw * 0.6 + headFlinch * 0.25 * this.flinchSide + this.lookYaw;
    p.headPivot.rotation.z = headFlinch * 0.35 * this.flinchSide - weld * 0.13 + this.variant.neckTilt;
    // 銃床の上へ首ごと寄せる。骨盤から上を捻るだけでは頬が銃に届かない
    p.headPivot.position.set(
      p.headHome.x + weld * 0.035,
      p.headHome.y,
      p.headHome.z - weld * 0.020,
    );

    /* -------------------------------------------------------- 銃 */
    const kick = this._gunKick;
    this._gunKick = Math.max(0, kick - dt * 6);
    // 個体ごとに微妙な揺れを入れる。全員が同じ精度でぴたりと止まると機械に見える
    this.swayPhase += dt * this.swayFreq;
    const sway = Math.sin(this.swayPhase) * 0.02 * (1 - this.accuracy * 0.6);

    /* -------------------------------------- 構えの高さと弾倉交換 */
    // 狙う相手が見えている時だけ肩に付ける。それ以外は銃を下ろし、走っている
    // 時はさらに胸の前へ寝かせる。ここが1種類しか無いと個体差が全部死ぬ
    const aiming = (this.state === STATE.ENGAGE || this.state === STATE.COVER) && this.hasLOS;
    // 構えの型で上げ切る高さが変わる。巡回型は肩付けが浅いまま撃つ
    const wantReady = this.reloadTime > 0 ? 0 : (aiming ? this.stanceReady : 0);
    this.readyBlend += (wantReady - this.readyBlend)
      * Math.min(1, dt * (wantReady > this.readyBlend ? 6 : 3));
    const low = (1 - this.readyBlend) * (1 + run * 0.55);
    // 弾倉交換。銃を体の内側へ倒して抜き差しする。抜く・差すの2拍を刻む
    let rl = 0;
    if (this.reloadTime > 0) {
      const k = clamp(1 - this.reloadTime / RELOAD_TIME, 0, 1);
      rl = Math.sin(k * Math.PI);
    }
    const rlBeat = rl > 0 ? Math.sin(this.reloadTime * 9) * 0.02 * rl : 0;

    const h = p.mountHome;
    p.gunMount.position.set(
      h.x + Math.sin(t) * 0.008 * stepAmp,
      h.y + Math.cos(t * 2) * 0.012 * stepAmp - bodyFlinch * 0.05 - cr * 0.03 - kick * 0.012
        + breath * 0.008 - grip * 0.05 - low * 0.13 - rl * 0.06 + rlBeat
        + this.stanceY * this.readyBlend,   // 高く構える個体と低く構える個体
      h.z + kick * 0.03 + low * 0.07,
    );
    p.gunMount.rotation.set(
      this.aimPitch * 0.8 * this.readyBlend + kick * 0.28 + bodyFlinch * 0.3 + sway * 0.5
        + grip * 0.22 + low * 0.55 + rl * 0.35
        // 銃自体に入れた伏せ角は、肩に付け切った時だけ打ち消す。
        // 打ち消さないと構えている間ずっと銃口が狙いより3度下を向く
        - GUN_PITCH * this.readyBlend,
      sway - Math.sin(t) * 0.03 * stepAmp,
      Math.sin(t) * 0.05 * stepAmp + run * 0.06 + grip * 0.12 + low * 0.10 + rl * 0.55,
    );

    /* -------------------------------------------------------- 腕 */
    // 手は銃側に付いているので、腕はその手首を掴みに行くだけでいい
    this._solveArms();

    // 判定は描いた後の骨から作り直す。見た目と判定がずれないのはここが要
    this._syncHitboxesFromBones();
    this._updateContact();
  }

  /* 足元の接地の暗がり。太陽の影とは独立に効くので逆光でも足が地面に接する */
  _updateContact() {
    const b = this.blob;
    if (!b.visible) return;
    b.position.set(this.collider.start.x, this.groundY + 0.025, this.collider.start.z);
    // 死体は横たわっているぶん広く敷く
    const s = (this.alive ? 1.02 - this.crouch * 0.15 : 1.55) * this.bodyScale;
    b.scale.set(s, 1, s);
  }

  /* 簡易の足IK。踏んでいる側の足が床に刺さったぶんだけ腰を上げ、
     浮いた側は膝を伸ばして届かせる。地形を一度も見ない歩行は必ず足が刺さる */
  _footIK(dt, stepAmp) {
    const p = this.parts;
    this.root.updateMatrixWorld(true);
    this.footTimer -= dt;
    const sample = this.footTimer <= 0;
    if (sample) this.footTimer = 0.09 + Math.random() * 0.04;

    const s = this.bodyScale;
    const planted = 1 - clamp(stepAmp * 1.6, 0, 1);   // 止まっている時は両足とも接地
    let lift = 0;
    for (let i = 0; i < 2; i++) {
      const foot = i === 0 ? p.footL : p.footR;
      foot.getWorldPosition(_v);
      if (sample) {
        const g = this._groundBelow(_v.x, _v.y + 0.6, _v.z);
        this.footGround[i] = g === null ? this.groundY : g;
      }
      const w = Math.max(planted, clamp(-Math.cos(this.walkPhase + i * Math.PI), 0, 1));
      const pen = (this.footGround[i] - (_v.y - 0.045 * s)) * w;
      if (pen > lift) lift = pen;
      _footPen[i] = pen;
      _footW[i] = w;
    }
    lift = clamp(lift, 0, 0.28);
    if (lift <= 0.0005) return;
    p.hips.position.y += lift / s;
    // 腰を上げたぶん、届かなくなった側は膝を伸ばす（膝は前には折れない）
    for (let i = 0; i < 2; i++) {
      const gap = (lift - _footPen[i]) * _footW[i];
      if (gap <= 0.001) continue;
      const shin = i === 0 ? p.shinL : p.shinR;
      const leg = i === 0 ? p.legL : p.legR;
      shin.rotation.x = Math.min(0, shin.rotation.x + gap * 2.0 / s);
      leg.rotation.x -= gap * 0.6 / s;
    }
  }
}

// 足IKの作業用。毎フレーム配列を作らない
const _footPen = [0, 0];
const _footW = [0, 0];

/* --------------------------------------------------- ウェーブ管理 */

export class Director {
  constructor(scene, level) {
    this.scene = scene;
    this.level = level;
    this.pool = [];
    this.active = [];
    this.wave = 0;
    this.pendingSpawns = 0;
    this.spawnTimer = 0;
    this.betweenWaves = 3.0;
    this.slotCounter = 0;
    this.onWaveStart = null;
    this.onEnemyDeath = null;
    this.onEnemyShoot = null;
    // 死体は時間で消さず、数で抑える。戦闘の痕跡が地形として残るのが
    // ウェーブ制シューターの手触りで、目の前で溶けて消えるのが一番安く見える
    this.corpses = [];
    this.maxCorpses = 8;
  }

  _obtain() {
    // 死体は表示したままなので、ここで拾われて使い回されることはない
    let e = this.pool.find((x) => !x.alive && !x.root.visible);
    if (!e) {
      e = new Enemy(this.level);
      e.onShoot = (...a) => this.onEnemyShoot?.(...a);
      e.onDeath = (en) => { this._registerCorpse(en); this.onEnemyDeath?.(en); };
      e.scene = this.scene;
      this.scene.add(e.root);
      this.scene.add(e.blob);
      this.pool.push(e);
    }
    e.parts.hips.rotation.set(0, 0, 0);
    // 散開のための方位を配る。同じ側から固まって来ないようにする
    e.squadSlot = this.slotCounter++;
    e.squad = this.active;
    return e;
  }

  _registerCorpse(e) {
    this.corpses.push(e);
    while (this.corpses.length > this.maxCorpses) this._retireCorpse(this.corpses.shift());
  }

  /** 一番古い死体を片付けてプールへ返す。落とした銃も一緒に回収する */
  _retireCorpse(e) {
    if (!e) return;
    e._pickUpGun();
    e.root.visible = false;
    e.blob.visible = false;
    const i = this.active.indexOf(e);
    if (i >= 0) this.active.splice(i, 1);
  }

  reset() {
    for (const e of this.pool) {
      e.alive = false;
      e._pickUpGun();          // 落ちたままの銃を回収してから隠す
      e.root.visible = false;
      e.blob.visible = false;
    }
    this.corpses.length = 0;
    this.active.length = 0;
    this.wave = 0;
    this.pendingSpawns = 0;
    this.spawnTimer = 0;
    this.betweenWaves = 2.0;
    this.slotCounter = 0;
  }

  get aliveCount() { return this.active.filter((e) => e.alive).length; }

  update(dt, player, ctx) {
    // ウェーブが片付いたら次を用意する
    if (this.pendingSpawns === 0 && this.aliveCount === 0) {
      this.betweenWaves -= dt;
      if (this.betweenWaves <= 0) {
        this.wave++;
        this.pendingSpawns = Math.min(4 + this.wave * 2, 14);
        this.spawnTimer = 0;
        this.betweenWaves = 6.0;
        // 倒れ切った死体はもう更新が要らないのでactiveから外す。死体自体は
        // corpsesが持っていて画面には残る。配列そのものは敵が散開の参照に
        // 持っているので、作り直さず詰める
        for (let i = this.active.length - 1; i >= 0; i--) {
          const e = this.active[i];
          if (!e.alive && (!e.root.visible || e.deathSettled)) this.active.splice(i, 1);
        }
        this.onWaveStart?.(this.wave, this.pendingSpawns);
      }
    }

    if (this.pendingSpawns > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 0.55;
        this._spawnOne(player);
        this.pendingSpawns--;
      }
    }

    for (const e of this.active) e.update(dt, player, ctx);
  }

  _spawnOne(player) {
    const e = this._obtain();
    // プレイヤーから遠い湧き場所を選ぶ（目の前に出さない）
    const spawns = this.level.enemySpawns;
    let best = spawns[0], bestD = -1;
    for (let i = 0; i < 4; i++) {
      const s = spawns[Math.floor(Math.random() * spawns.length)];
      const d = s.distanceToSquared(player.collider.start);
      if (d > bestD) { bestD = d; best = s; }
    }
    e.spawn(best);

    // ウェーブが進むほど強くする。個体ごとに少し散らして同じ動きの群れにしない
    const w = this.wave;
    e.maxHealth = 100 + Math.min(w * 12, 120);
    e.health = e.maxHealth;
    e.speed = (3.2 + Math.min(w * 0.14, 1.6)) * (0.92 + Math.random() * 0.16);
    // 序盤は当てすぎない。複数体に囲まれると一気に削られて何もできなくなる
    e.accuracy = Math.min(0.28 + w * 0.042, 0.74) * (0.85 + Math.random() * 0.3);
    e.damage = 6 + Math.min(w * 0.6, 8);
    e.fireRate = Math.max(0.09, 0.16 - w * 0.006) * (0.9 + Math.random() * 0.25);
    e.engageRange = 9 + Math.random() * 8;
    e.aggression = 0.55 + Math.random() * 0.9;

    if (!this.active.includes(e)) this.active.push(e);
  }
}
