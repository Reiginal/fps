// マップ本体。遮蔽・高低差・回り込みルートを持たせて、撃ち合いが成立する形にする。
// 足の乗る物は全部Octreeに放り込んで三角形単位の衝突判定にするので、
// 斜路もコンテナの上も渡り板も特別扱いなしでそのまま歩ける。
//
// 置き方は2種類。solidsは衝突に参加する本体、propsは電線やアンテナのように
// 「弾は当たるが体は通り抜ける」飾り。細い物を衝突に入れると、空中で弾が止まったり
// プレイヤーが見えない線に引っかかったりして理不尽になる。
//
// プロップを数百個そのまま置くと描画コール(draw call)が数百になり、影の描画で倍になる。
// 静的な形しか無いので「素材×区画」でジオメトリを結合してから1枚のメッシュにする。
// 全部を1枚にまとめないのは、バウンディング球がマップ全体まで膨らんで、
// 視錐台カリングも射線判定(raycast)の早期棄却も効かなくなるため。
//
// 高さの設計値: ジャンプの到達高は約0.95m(初速6.6/重力22)。登れる段差は0.78で刻み、
// 胸の高さの遮蔽は0.92、全身が隠れる物は1.9以上に揃えてある。
import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
// 汚しのアルファデカール一式。汚れは「重力方向に局所的」に出るものなので、
// テクスチャ内の等方ノイズでは絶対に代替できない。庇の下・窓台の下・
// 壁と地面の接線・ボルト位置といった発生源を決めて、そこから下へ貼る
import { buildDecals } from './textures.js';

// 箱のUVを実寸から焼き直す。これをやらないと大きい壁ほど模様が間延びして
// 縮尺が破綻する（AAA感が最初に死ぬのがここ）。
// 頂点ごとに法線を見て、その面に沿う2軸の位置をそのままUVにする。
// 面が分割されていても同じ式で通るので、大きい面を刻んでも縮尺が狂わない
function applyBoxUV(geo, scale) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const s = 1 / scale;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) { u = pos.getZ(i); v = pos.getY(i); }
    else if (ny >= nz) { u = pos.getX(i); v = pos.getZ(i); }
    else { u = pos.getX(i); v = pos.getY(i); }
    uv.setXY(i, u * s, v * s);
  }
  uv.needsUpdate = true;
}

// 箱は毎回作り直す。結合前にapplyMatrix4で焼き込むので使い回すと形が壊れる
function makeBox(w, h, d, scale) {
  const geo = new THREE.BoxGeometry(w, h, d);
  applyBoxUV(geo, scale);
  return geo;
}

/* 1葉に置く三角形の上限。three既定の8だと深さ12まで割れて節点が3万近くになる。
   32にすると浅く済み、当たり判定の速さは変わらない（葉の中を総当たりする数が
   8→32になるだけで、そこは元々1回の判定で数十個しか見ない） */
const LEAF_TRIS = 32;

/**
 * Octreeを組む。
 *
 * three付属の実装は `split()` の中で `new Octree(box)` を作るので、
 * root に設定した閾値が子へ伝播しない。子は既定の8に戻り、深さ12・節点26,960まで割れる。
 *
 * 以前は「割り切ってから畳み直す」形にしていたが、**畳むのは組み終わった後**なので
 * 一番深く割れた状態の記憶を一度は必ず払っていた。実測で、地形を組むのに
 * ヒープ448MBが要り、384MBでは落ちていた。
 *
 * 各節点が自分の split を始める瞬間に閾値を入れ直せば、割る前に浅くできる。
 * 「割ってから畳む」ではなく「深く割らない」形になる。
 * これで**96MBでも組めるようになり、マシンを1GBから512MBへ戻せた**。
 * 当たり判定は4000本のレイで結果が完全に一致することを確かめてある。
 *
 * 差し込みは組んでいる間だけで、終わったら必ず元へ戻す
 */
function buildOctree(octree, group) {
  const orig = Octree.prototype.split;
  Octree.prototype.split = function patched(level) {
    this.trianglesPerLeaf = LEAF_TRIS;
    return orig.call(this, level);
  };
  try {
    octree.fromGraphNode(group);
  } finally {
    // 例外が出ても必ず戻す。戻し忘れると、この後に作る他のOctreeまで巻き込む
    Octree.prototype.split = orig;
  }
  return octree;
}

// 不定形の塊。破片を全部同じ縦横比のクサビで作ると、地面にまき散らした
// 段ボール片にしか見えない。BoxGeometryを2分割してから頂点を位置ハッシュでずらす。
// ずらし量を「位置」から引くのは、面ごとに複製された同座標の頂点へ同じ量を与えて
// 継ぎ目を割らないため。UVは崩す前の軸整列した法線で焼いておく
function chunkGeo(w, h, d, scale, sd, amt = 0.30) {
  const geo = new THREE.BoxGeometry(w, h, d, 2, 2, 2);
  applyBoxUV(geo, scale);
  const pos = geo.attributes.position;
  const k = Math.min(w, Math.min(h, d)) * amt;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    pos.setXYZ(i,
      x + (hash3(x * 31 + sd, y * 37, z * 41) - 0.5) * k,
      y + (hash3(y * 31, z * 37 + sd, x * 41) - 0.5) * k * 0.7,
      z + (hash3(z * 31, x * 37, y * 41 + sd) - 0.5) * k);
  }
  pos.needsUpdate = true;
  geo.computeVertexNormals();
  return geo;
}

function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
}

// UVの位相ずらし。emit()は個体ごとにこれをやっているが、fxEmit()は通らないので
// 遠景のように大量に並べる物は呼び出し側でずらさないと全棟同じ位相になる
function offsetUV(geo, du, dv) {
  const uv = geo.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) + du, uv.getY(i) + dv);
  uv.needsUpdate = true;
  return geo;
}

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

/* ------------------------------------------------ 手続き生成の下ごしらえ */
// 位置から決まる安定ハッシュ。固定種rnd()の列を消費しないので、
// これを後から足しても既存の配置（瓦礫の散り方・パレットの傾き）は一切ずれない
function hash3(x, y, z) {
  let h = Math.imul(Math.round(x * 137.1) | 0, 374761393)
    ^ Math.imul(Math.round(y * 219.7) | 0, 668265263)
    ^ Math.imul(Math.round(z * 311.3) | 0, 1103515245);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function h2(ix, iy, s) {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise2(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
  const a = h2(xi, yi, s), b = h2(xi + 1, yi, s);
  const c = h2(xi, yi + 1, s), d = h2(xi + 1, yi + 1, s);
  const ab = a + (b - a) * u, cd = c + (d - c) * u;
  return ab + (cd - ab) * v;
}
// 0..1に正規化したfbm。マスクや地形のうねりに使う
function fbm2(x, y, freq, oct, s) {
  let sum = 0, amp = 0.5, f = freq, norm = 0;
  for (let i = 0; i < oct; i++) {
    sum += vnoise2(x * f, y * f, s + i * 131) * amp;
    norm += amp; amp *= 0.5; f *= 2;
  }
  return sum / norm;
}

// 小さい手続きテクスチャの焼き付け。外部画像を持ち込まないので全部ここで作る
function makeTex(size, cb, srgb, wrap) {
  const data = new Uint8Array(size * size * 4);
  const px = { r: 1, g: 1, b: 1, a: 1 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      px.r = 1; px.g = 1; px.b = 1; px.a = 1;
      cb((x + 0.5) / size, (y + 0.5) / size, px);
      const o = (y * size + x) * 4;
      data[o] = clamp(px.r, 0, 1) * 255;
      data[o + 1] = clamp(px.g, 0, 1) * 255;
      data[o + 2] = clamp(px.b, 0, 1) * 255;
      data[o + 3] = clamp(px.a, 0, 1) * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = wrap ?? THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// アルファのカバレッジを保ったミップを自前で作る。
// alphaTestで抜く板(金網・葉・幕)は、自動生成のミップだと縮小のたびに
// 線の周りの透明画素と平均されてアルファが下がり、遠くで網が丸ごと消える。
// 各段で「alphaTestを超える画素の割合」を原寸に合わせ直してから積む
function makeTexMipsAlpha(size, cb, alphaTest, wrap) {
  const t = makeTex(size, cb, true, wrap);
  const base = t.image.data;
  const coverage = (data, scale) => {
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if ((data[i] / 255) * scale > alphaTest) n++;
    return n / (data.length / 4);
  };
  const want = coverage(base, 1);
  const mips = [{ data: base, width: size, height: size }];
  let src = base, w = size;
  while (w > 1) {
    const nw = w >> 1;
    const dst = new Uint8Array(nw * nw * 4);
    for (let y = 0; y < nw; y++) {
      for (let x = 0; x < nw; x++) {
        for (let c = 0; c < 4; c++) {
          const o0 = ((y * 2) * w + x * 2) * 4 + c;
          const o1 = ((y * 2) * w + x * 2 + 1) * 4 + c;
          const o2 = ((y * 2 + 1) * w + x * 2) * 4 + c;
          const o3 = ((y * 2 + 1) * w + x * 2 + 1) * 4 + c;
          dst[(y * nw + x) * 4 + c] = (src[o0] + src[o1] + src[o2] + src[o3]) >> 2;
        }
      }
    }
    // 2分探索で倍率を決める。総当たりでも段ごとに十数回で収束する
    let lo = 1, hi = 8;
    for (let it = 0; it < 14; it++) {
      const mid = (lo + hi) / 2;
      if (coverage(dst, mid) < want) lo = mid; else hi = mid;
    }
    const k = (lo + hi) / 2;
    // 倍率を掛けた物は「積む用」にコピーで持つ。掛けた後の画をさらに縮小すると
    // 補正が段ごとに掛け算で乗って、遠くの網が逆に太くなる
    const up = dst.slice();
    for (let i = 3; i < up.length; i += 4) up[i] = clamp(up[i] * k, 0, 255);
    mips.push({ data: up, width: nw, height: nw });
    src = dst; w = nw;
  }
  t.mipmaps = mips;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

// 路面の貼り分け板を「ギザギザに消える」ようにするマスク。
// 板の辺がそのまま素材の境界になると定規で引いた直線に見えるので、
// 外周へ向かってfbmで食い破らせる。板ごとに種を変えて同じ形を繰り返さない
function patchMaskTexture(seed, size = 160) {
  return makeTex(size, (u, v, p) => {
    const e = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) * 2;   // 0=縁 1=中心
    const n = fbm2(u, v, 6, 4, seed) - 0.5;
    const n2 = fbm2(u + 5.3, v - 2.1, 19, 3, seed + 77) - 0.5;
    let a = sstep(0.0, 0.30, e + n * 0.52 + n2 * 0.15);
    a *= 0.76 + 0.24 * sstep(0.26, 0.64, fbm2(u - 1.7, v + 3.9, 3.5, 3, seed + 191));
    p.r = a; p.g = a; p.b = a; p.a = a;
  }, false);
}

// プロップの足元に敷く汚れ。中心が濃く外周へ白(=変化なし)に抜ける乗算用の板。
// GTAOは陰影であって汚れではないので、泥だまり・吹き溜まりは別に置く必要がある
function grimeTexture(size = 128) {
  return makeTex(size, (u, v, p) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy) * 2;
    const n = fbm2(u, v, 5, 4, 907);
    const core = 1 - sstep(0.0, 0.60, d);
    const halo = 1 - sstep(0.12, 1.0, d);
    // 重ねて敷くので1枚あたりは薄く。濃くすると密集地帯が真っ黒に潰れる
    const k = clamp(core * 0.28 + halo * 0.18 * (0.35 + 1.3 * n), 0, 0.38);
    const c = 1 - k;
    p.r = c; p.g = c * 0.985; p.b = c * 0.94;   // 泥なので青を余分に抜いて暖色に寄せる
    p.a = 1;
  }, true);
}

// 水たまり。タイルに焼いた濡れは4m周期で並ぶので粗さの下限で殺した。
// そのぶん、鏡面は「世界座標に置いた板」として個別に戻す。
// 縁をfbmで食い破らせて、円い板だと分からないようにする
function puddleTexture(size = 128) {
  return makeTex(size, (u, v, p) => {
    const dx = u - 0.5, dy = v - 0.5;
    const d = Math.sqrt(dx * dx + dy * dy) * 2;
    const n = fbm2(u, v, 3.2, 4, 3307) - 0.5;
    const n2 = fbm2(u + 4.1, v - 2.7, 9, 3, 3311) - 0.5;
    let a = 1 - sstep(0.45, 0.92, d + n * 0.62 + n2 * 0.18);
    // 中心ほど深い＝暗い。縁は薄くて地の色が透ける
    const deep = sstep(0.0, 0.55, a);
    p.r = 0.055 + (1 - deep) * 0.10;
    p.g = 0.060 + (1 - deep) * 0.10;
    p.b = 0.070 + (1 - deep) * 0.10;
    p.a = clamp(a * (0.55 + deep * 0.45), 0, 1);
  }, true);
}

// 屋根の水切りや窓台から下へ落ちる汚れの垂れ。縦に伸ばして壁へ貼る
function streakTexture(size = 128) {
  return makeTex(size, (u, v, p) => {
    const vv = 1 - v;                     // 上端から下へ垂れる向きに焼く
    const col = fbm2(u * 3.0, 0.5, 7, 3, 613);
    const run = sstep(0.0, 0.10, vv) * (1 - sstep(0.22, 1.0, vv));
    const grain = 0.55 + 0.45 * fbm2(u, vv * 0.35, 11, 3, 811);
    const k = clamp(run * (0.18 + col * 0.55) * grain, 0, 0.6);
    const c = 1 - k;
    p.r = c; p.g = c * 0.98; p.b = c * 0.95;
    p.a = 1;
  }, true);
}

// 雑草。交差した2枚の板に貼るだけだが、壁の根本と目地に生えるだけで
// 「人が使わなくなった場所」が一気に読めるようになる
function grassTexture(size = 128) {
  const blades = [];
  for (let i = 0; i < 18; i++) {
    blades.push({
      x0: 0.10 + 0.80 * h2(i, 3, 55),
      bend: (h2(i, 9, 71) - 0.5) * 0.46,
      ht: 0.42 + 0.54 * h2(i, 17, 23),
      hw: 0.018 + 0.022 * h2(i, 29, 41),
      dry: h2(i, 37, 13),
    });
  }
  return makeTex(size, (u, v, p) => {
    let a = 0, r = 0, g = 0, b = 0;
    for (const bl of blades) {
      const t = v / bl.ht;
      if (t > 1) continue;
      const cx = bl.x0 + bl.bend * t * t;
      const hw = bl.hw * (1 - t * 0.8);
      const dd = Math.abs(u - cx);
      // 二値で抜くと縁がドット階段になる。1〜2texぶん勾配を持たせてから
      // alphaTestで切ると、先端が細って草に見える
      const cov = 1 - sstep(hw * 0.45, hw, dd);
      if (cov <= a && a > 0) continue;
      if (cov <= 0) continue;
      a = Math.max(a, cov);
      // 根元は光が届かず暗い。先端ほど枯れて明るくなるのが本来の階調で、
      // これが無いと全長が同じ明度のプラスチックのバリに見える
      const root = 0.42 + 0.58 * sstep(0.0, 0.55, t);
      // 彩度を落として地面の砂色へ寄せる。周囲から色として浮くと交差板だとバレる
      r = (0.20 + 0.15 * t + bl.dry * 0.11) * root;
      g = (0.19 + 0.11 * t + bl.dry * 0.04) * root;
      b = (0.115 + 0.045 * t) * root;
    }
    p.r = r; p.g = g; p.b = b; p.a = a;
  }, true);
}

// 遠景ビルの外装。窓の律動さえ残っていれば霞んでもビルに見えるし、
// 逆に無地の面はどれだけ霞ませても「立てたカード」にしか見えない。
// 1タイル=4mに階高2m・柱間1.33mの窓を並べる
// 窓の割り付け(柱間・階高)と種を変えて何種類か焼く。1枚で全棟を賄うと、
// 遠景のビルが全部「同じ図面で建てた同じビル」になって書き割りに見える。
// 窓の明度を3段+空の映り込みに振るのが一番効く。距離があっても、
// 窓の明暗がバラけているだけでビルは本物に見える
function farFacadeTexture(seed, cols, rows, size = 128) {
  return makeTex(size, (u, v, p) => {
    const cu = u * cols, cv = v * rows;
    const iu = Math.floor(cu), iv = Math.floor(cv);
    const fu = cu - iu, fv = cv - iv;
    // 躯体。階ごとにわずかな明度差を付けて水平の層を出す。
    // 0.62〜0.81は真っ白な塗り立ての壁で、日向に立つとリニアで地平の空を
    // 追い越し、100m先のビルが背後の空より明るいという裏返った絵になっていた。
    // 空の手前に立つ面は空より暗いのが先にあるので、風化したコンクリの
    // 0.50〜0.65まで落とす（下の窓と庇の明度も同じ比で下げてある）
    const band = 0.50 + 0.11 * h2(0, iv, 311 + seed) + 0.04 * fbm2(u * 4, v * 4, 3, 3, 401 + seed);
    let r = band * 0.98, g = band * 0.93, b = band * 0.84;
    // 腰壁とスパンドレル(窓の下の帯)。窓を上下に寄せると階の刻みが読める
    const inW = fu > 0.16 && fu < 0.84;
    const inH = fv > 0.30 && fv < 0.88;
    if (inW && inH) {
      const lit = h2(iu, iv, 727 + seed);
      const tone = h2(iu * 3 + 1, iv * 7 + 5, 913 + seed);
      if (lit > 0.95) {
        // 空が映って白く飛んでいる面。5%だけ入れると規則性が一番よく壊れる。
        // 映っているのは空なので、空そのものより明るくはならない
        r = 0.74; g = 0.73; b = 0.71;
      } else if (lit > 0.90) {             // 数枚だけ光が残っている窓
        r = 0.58; g = 0.53; b = 0.42;
      } else {
        // 暗0.35 / 中0.55 / 明0.80の3段。同じ明るさの黒板が並ぶのをやめる。
        // ガラスは空を映すので寒色側へ倒す
        const dk = (tone < 0.55 ? 0.11 : tone < 0.85 ? 0.19 : 0.30) * (0.8 + lit * 0.5);
        r = dk * 0.92; g = dk * 0.97; b = dk * 1.14;
      }
      // 方立(縦の桟)。窓を1枚の黒板にしないための1本
      if (Math.abs(fu - 0.5) < 0.035) { r = band * 0.72; g = band * 0.68; b = band * 0.62; }
      // 庇の落とす影。窓の上端を暗くすると開口に奥行きが出る
      if (fv > 0.80) { r *= 0.62; g *= 0.62; b *= 0.66; }
    } else if (inW && fv >= 0.88) {
      const s2 = band * 0.78;              // まぐさの影
      r = s2 * 0.98; g = s2 * 0.93; b = s2 * 0.84;
    } else if (inW && fv < 0.30 && h2(iu, iv, 1051 + seed) > 0.78) {
      // ベランダ・室外機の台。数階に1つだけ腰壁から出っ張りの影を焼く
      const s3 = band * 0.66;
      r = s3; g = s3 * 0.96; b = s3 * 0.88;
    }
    p.r = r; p.g = g; p.b = b; p.a = 1;
  }, true, THREE.RepeatWrapping);
}

// 破れた防炎シート。頭上に吊るして画面の上半分を埋める
// 破れた防炎シート。頭上に吊るして画面の上半分を埋める。
// 解像度を上げて縁を2〜3texぶんフェザリングしないと、alphaTestの1ビット抜きで
// 輪郭がドット階段になり「板に絵を貼った」ことが露見する
function tarpTexture(size = 256) {
  return makeTex(size, (u, v, p) => {
    const weave = 0.88 + 0.12 * Math.abs(Math.sin(u * size * 0.35) * Math.sin(v * size * 0.35));
    const dirt = fbm2(u, v, 4, 4, 1301);
    const tear = fbm2(u * 1.4, v, 3.2, 3, 1777);
    const edge = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v)) * 2;
    // 逆光で真っ黒に潰れていたので基準の明度を上げる。
    // 薄い所ほど透けるので、擦り切れ(thin)の分だけ明るくする
    const thin = sstep(0.42, 0.62, tear);
    const base = 1.28 + thin * 0.5;
    // 二値化をやめて勾配で抜く。alphaTest 0.5に対して境界が数texに広がる
    const a = sstep(0.28, 0.46, tear) * sstep(0.008, 0.060, edge + (tear - 0.5) * 0.5);
    // 破れ口のほつれ。切り抜きの縁に幅3〜4texの暗い帯を焼いておくと、
    // alphaTestの硬い切り口が「厚みのある布の断面が影を作っている」ように読める。
    // これが無いと紙を鋏で切った形にしか見えない
    const fray = 1 - sstep(0.50, 0.86, a);
    const k = 1 - fray * 0.45;
    p.r = (0.46 - dirt * 0.16) * weave * base * k;
    p.g = (0.37 - dirt * 0.14) * weave * base * k;
    p.b = (0.26 - dirt * 0.10) * weave * base * k;
    p.a = a;
  }, true);
}

// 金網フェンス。場外に1周させるだけで「壁の外にも世界がある」ことになる。
// 菱形の網目は線の交差だけ描いて残りを抜く。縁は勾配を持たせてalphaTestで切る
// 金網フェンス。ミップは自前で作る（自動生成だと10m先で網が丸ごと消える）
function fenceTexture(size = 128) {
  return makeTexMipsAlpha(size, (u, v, p) => {
    const a = Math.abs((((u + v) * 7) % 1 + 1) % 1 - 0.5);
    const b = Math.abs((((u - v) * 7) % 1 + 1) % 1 - 0.5);
    const w = 0.052;
    const cov = Math.max(1 - sstep(w * 0.55, w, a), 1 - sstep(w * 0.55, w, b));
    // 線の芯を明るく、縁を暗くする。単色だと針金ではなく塗った線に見える
    const core = sstep(0.55, 1.0, cov);
    p.r = 0.22 + core * 0.16; p.g = 0.22 + core * 0.16; p.b = 0.21 + core * 0.15;
    p.a = cov;
  }, 0.5, THREE.RepeatWrapping);
}

// 煙突のプルーム。地平に縦へ伸びる煙が1本あるだけでスカイラインに寸法が付くし、
// 大気が動いている＝世界が止まっていないことが1枚で伝わる。
// 下端が濃く、上へ行くほど広がって薄れる。横は中心が濃い山型
function plumeTexture(size = 128) {
  return makeTex(size, (u, v, p) => {
    const n = fbm2(u * 2.4, v * 0.8, 4, 4, 2207);
    const n2 = fbm2(u * 5.1 + 3.3, v * 2.2, 3, 3, 2311);
    const wid = 0.26 + v * 0.70;                       // 上へ行くほど広がる
    const dx = Math.abs(u - 0.5) / (wid * 0.5);
    let a = (1 - sstep(0.30, 1.05, dx)) * (0.42 + n * 1.05);
    // 立ち上がりで一度濃くなり、上端へ向かって溶ける
    a *= sstep(0.0, 0.10, v) * (1 - sstep(0.40, 1.0, v));
    a *= 0.55 + 0.75 * n2;
    const c = 0.60 + n * 0.32;
    p.r = c * 0.99; p.g = c * 0.965; p.b = c * 0.93;   // 煤混じりなので少し暖色
    p.a = clamp(a, 0, 1);
  }, true);
}

// 看板。読める文字が1枚あるだけで「何の施設だったか」が画から読めるようになる
function signTexture(title, sub, bg, fg, seed) {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 160);
  // 枠線
  g.strokeStyle = fg; g.lineWidth = 6;
  g.strokeRect(11, 11, 490, 138);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = 'bold 62px "Courier New", monospace';
  g.fillText(title, 256, sub ? 62 : 80);
  if (sub) {
    g.font = 'bold 30px "Courier New", monospace';
    g.fillText(sub, 256, 116);
  }
  // 剥がれと錆。塗膜を地の色で食い破らせる
  for (let i = 0; i < 90; i++) {
    const r = h2(i, 1, seed), r2 = h2(i, 2, seed), r3 = h2(i, 3, seed);
    g.globalAlpha = 0.10 + r3 * 0.45;
    g.fillStyle = i % 3 === 0 ? '#6b563c' : bg;
    g.beginPath();
    g.ellipse(r * 512, r2 * 160, 4 + r3 * 26, 3 + r * 16, r2 * 3.14, 0, 6.28);
    g.fill();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 8;
  return t;
}

// 土嚢のジオメトリ。角の立った直方体だと、ほぼ水平の視線では法線マップの嘘が効かず
// 「模様を描いた板」に見える。柔らかい物はシルエット自体を丸める必要がある
// squash: 下段ほど潰す係数、sd: 個体ごとの種。
// 分割が粗いと断面の直線ファセットが読めて「袋」でなく「パン」に見えるので、
// 衝突コストと相談しつつ(7,3,6)まで上げる。
// 全個体が同じ枕型だと金型で抜いたクッションが並んで見えるため、
// 種から張り出しの向きと縛り口の位置を振って輪郭を個体ごとに変える
function sandbagGeo(w, h, d, scale, sd = 0, squash = 1) {
  const geo = new THREE.BoxGeometry(w, h, d, 7, 3, 6);
  applyBoxUV(geo, scale);
  const pos = geo.attributes.position;
  const hx = w / 2, hy = h / 2, hz = d / 2;
  // 個体ごとの癖。どちら側に中身が寄っているか、どこがくびれているか
  const lean = (h2(sd, 3, 611) - 0.5) * 0.30;
  const waist = 0.10 + h2(sd, 7, 613) * 0.16;
  const phase = h2(sd, 11, 617) * 6.28;
  for (let i = 0; i < pos.count; i++) {
    const nx = pos.getX(i) / hx, ny = pos.getY(i) / hy, nz = pos.getZ(i) / hz;
    // 立方体→球の標準写像。0.62だけ寄せると角の落ちた枕型になる
    const sx = nx * Math.sqrt(Math.max(0, 1 - ny * ny / 2 - nz * nz / 2 + ny * ny * nz * nz / 3));
    const sy = ny * Math.sqrt(Math.max(0, 1 - nz * nz / 2 - nx * nx / 2 + nz * nz * nx * nx / 3));
    const sz = nz * Math.sqrt(Math.max(0, 1 - nx * nx / 2 - ny * ny / 2 + nx * nx * ny * ny / 3));
    const k = 0.70;
    // 中身の重みで胴が張り出す。長手方向の位置で張り出し量を波打たせると
    // 縫い目のくびれと詰め物の偏りが出て、同じ楕円の繰り返しから抜けられる
    const bulge = 1 + 0.13 * (1 - ny * ny) * (1 + waist * Math.sin(nx * 2.4 + phase))
      + lean * nx * (1 - ny * ny) * 0.5;
    const yk = ny > 0 ? 0.84 * squash : 1.0 + (1 - squash) * 0.35;   // 上は積まれて潰れ、下は接地で広がる
    pos.setXYZ(i,
      (nx + (sx - nx) * k) * hx * bulge,
      (ny + (sy - ny) * k) * hy * yk,
      (nz + (sz - nz) * k) * hz * bulge);
  }
  geo.computeVertexNormals();
  return geo;
}

// アルベドの緑成分の平均。マクロバリエーションを「明るくも暗くもしない」中心値にする
function meanGreen(tex) {
  const d = tex && tex.image && tex.image.data;
  if (!d) return 0.5;
  let s = 0;
  const n = d.length >> 2;
  const step = Math.max(1, Math.floor(n / 16384));
  let c = 0;
  for (let i = 0; i < n; i += step) { s += d[i * 4 + 1]; c++; }
  return s / (c * 255);
}

// タイリングを壊す層を足す。textures側のレシピはタイル内の3帯域しか持っていないので、
// 「タイル周期より十分大きいムラ」が一枚も無い＝512pxの升目がそのまま読める。
// 同じアルベドを1/16のレートでもう一度引いて乗算する（macro blend）だけで升目が消える。
// warpは頂点側でUVを低周波で揺らすもので、床のように大きく割った面だけに掛ける
function addMacroVariation(mat, amount, rate, warp = 0) {
  if (!mat || !mat.map || mat.userData.macroApplied) return mat;
  mat.userData.macroApplied = true;
  const mid = meanGreen(mat.map);
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uMacroAmt = { value: amount };
    shader.uniforms.uMacroRate = { value: rate };
    shader.uniforms.uMacroMid = { value: mid };
    shader.uniforms.uWarpAmt = { value: warp };
    shader.vertexShader = 'uniform float uWarpAmt;\nvarying float vMacroWY;\nvarying float vMacroNY;\n'
      + shader.vertexShader.replace(
        '#include <uv_vertex>',
        `#include <uv_vertex>
      {
        // 汚れに重力の向きを持たせるために、ワールドの高さと面の向きを渡す。
        // 上向き面(埃が溜まって明るい)と垂直面(雨で洗われて縦に流れる)は
        // 符号が逆になるので、法線のY成分だけあれば足りる
        vec4 macroWP = modelMatrix * vec4( position, 1.0 );
        vMacroWY = macroWP.y;
        vMacroNY = normalize( mat3( modelMatrix ) * normal ).y;
      }
      if ( uWarpAmt > 0.0 ) {
        vec3 wposW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        vec2 warpUv = vec2(
          sin( wposW.z * 0.083 + 1.7 ) * 0.62 + sin( wposW.x * 0.031 + 4.1 ) * 0.44,
          cos( wposW.x * 0.071 + 0.4 ) * 0.62 + sin( wposW.z * 0.047 + 2.3 ) * 0.44
        ) * uWarpAmt;
        // アルベドだけずらすと法線と柄が食い違うので、同じ量を全部に掛ける。
        // alphaMapは板1枚に紐づくマスクなので触らない
        #ifdef USE_MAP
          vMapUv += warpUv;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv += warpUv;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv += warpUv;
        #endif
        #ifdef USE_METALNESSMAP
          vMetalnessMapUv += warpUv;
        #endif
        #ifdef USE_AOMAP
          vAoMapUv += warpUv;
        #endif
      }`);
    shader.fragmentShader = 'uniform float uMacroAmt;\nuniform float uMacroRate;\nuniform float uMacroMid;\n'
      + 'varying float vMacroWY;\nvarying float vMacroNY;\n'
      + shader.fragmentShader.replace(
        '#include <map_fragment>',
        `#include <map_fragment>
      #ifdef USE_MAP
      {
        float up = smoothstep( 0.55, 0.85, abs( vMacroNY ) );
        // 垂直面は縦に引き伸ばして引く。等方の楕円斑をそのまま乗せると、汚れではなく
        // 迷彩の塗り分けに見える(斑がジオメトリを無視して水平に連続する)。
        // 上向き面は方向を持たない(埃が等方に溜まる)ので、こちらは回して等方のまま引く。
        // タイル周期を壊す役目は上向き面のほうが重いので強度は落とさない
        vec2 uvA = vMapUv * vec2( uMacroRate * 2.2, uMacroRate * 0.42 );
        vec2 uvB = vMapUv * uMacroRate;
        uvB = vec2( uvB.x * 0.8763 - uvB.y * 0.4817, uvB.x * 0.4817 + uvB.y * 0.8763 );
        vec2 macroUv = mix( uvA, uvB, up ) + vec2( 0.317, 0.113 );
        float macroL = texture2D( map, macroUv ).g;
        // 垂直面は雨で洗われるので上ほど弱く、下端へ向かって濃くなる。
        // 上向き面は埃が溜まって明るくなるので符号が逆
        float drop = clamp( vMacroWY / 3.5, 0.0, 1.0 );
        float grav = mix( 0.28 + 0.72 * ( 1.0 - drop ), 1.0, up );
        float sgn = mix( 1.0, -1.0, up );
        diffuseColor.rgb *= clamp( 1.0 + ( macroL - uMacroMid ) * uMacroAmt * grav * sgn, 0.5, 1.6 );
      }
      #endif`);
  };
  mat.customProgramCacheKey = () => 'macroG' + amount.toFixed(2) + '_' + rate.toFixed(3) + '_' + warp.toFixed(3);
  mat.needsUpdate = true;
  return mat;
}

// 地面のタイル周期そのものを壊す層。
// textures側のアスファルトは4m角のタイル1枚で、その中に補修パッチ(voronoi)と
// ひび(netCrack)という「形のある構造」が焼いてある。それを420m四方に105回並べているので、
// 俯瞰すると同じX字のひびが完全な正方格子で並んで見える。
// 明度のムラ(頂点カラー・マクロノイズ)をいくら足しても揺れるのは明るさだけで、
// 構造の周期は1ミリも崩れない。なので尺も向きも違う第2層を同じテクスチャから引いて、
// ワールド座標のfbmマスクで混ぜる。第2層のレートを0.31のような非整数にするのが肝で、
// 整数比だと第2層のひびも元の4m格子に乗ってしまい何も変わらない。
// あわせて粗さに下限を入れる。タイルに焼かれた水たまりが鏡になっていて、
// 太陽の鏡面方向に入るタイルだけが白飛びし、その白飛びが格子状に並んでいた
function addGroundBlend(mat, rate2 = 0.31, maskRate = 0.045, roughFloor = 0.52, warpMin = 0.26) {
  if (!mat || !mat.map) return mat;
  // 既に差し込みがある材質を壊さない。textures側の材質はonBeforeCompileが
  // 「代入すると連鎖に積まれる」アクセサになっているのでそのまま代入してよいが、
  // patch用のclone(素のプロパティ)は代入すると前の差し込みを消してしまうので包む
  const desc = Object.getOwnPropertyDescriptor(mat, 'onBeforeCompile');
  const prevFn = desc && !desc.set && typeof desc.value === 'function' ? desc.value : null;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey() : '';
  // 第2層のUV。回転行列は31度。回さないと尺だけ違う同じ模様が重なる
  const ROT = 'mat2( 0.8572, -0.5150, 0.5150, 0.8572 )';
  const MASK = `
    // マスクは0/1へ振り切らせない。片側へ寄せると、その領域だけ元の格子が丸ごと復活する
    float gMask = 0.20 + 0.60 * smoothstep( 0.32, 0.68, gndFbm( vGndWP.xz * uGnd.y ) );`;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prevFn) prevFn(shader, renderer);
    shader.uniforms.uGnd = { value: new THREE.Vector4(rate2, maskRate, roughFloor, 0) };
    // 前段が持っているUVのゆらぎを地面だけ強める。ゆらぎは低周波なので
    // 局所の伸びは1割程度にしかならず、そのぶんタイルの升目が読めなくなる
    const wu = shader.uniforms.uWarpAmt;
    if (wu) wu.value = Math.max(wu.value, warpMin);
    shader.vertexShader = 'varying vec3 vGndWP;\n' + shader.vertexShader.replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      vGndWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;`);
    shader.fragmentShader = `
uniform vec4 uGnd;
varying vec3 vGndWP;
float gndH( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float gndN( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( gndH( i ), gndH( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( gndH( i + vec2( 0.0, 1.0 ) ), gndH( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float gndFbm( vec2 p ) { return gndN( p ) * 0.56 + gndN( p * 2.07 ) * 0.29 + gndN( p * 4.13 ) * 0.15; }
` + shader.fragmentShader
      .replace('#include <map_fragment>', /* glsl */`
#ifdef USE_MAP
{
  ${MASK}
  vec2 gUvB = ${ROT} * vMapUv * uGnd.x + vec2( 17.31, 5.77 );
  diffuseColor *= mix( texture2D( map, vMapUv ), texture2D( map, gUvB ), gMask );
}
#endif`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
#ifdef USE_NORMALMAP_TANGENTSPACE
{
  ${MASK}
  vec2 gNvB = ${ROT} * vNormalMapUv * uGnd.x + vec2( 17.31, 5.77 );
  vec3 gN = texture2D( normalMap, gNvB ).xyz * 2.0 - 1.0;
  gN.xy *= normalScale;
  // アルベドと同じ重みで法線も混ぜる。片方だけ混ぜると柄と凹凸が食い違って
  // 「模様を印刷した平らな板」に戻る
  normal = normalize( mix( normal, normalize( tbn * gN ), gMask ) );
}
#endif`)
      .replace('#include <lights_physical_fragment>', /* glsl */`
// タイルに焼かれた水たまりの鏡面を殺す。濡れは板として別に置く方針にして、
// 4m周期で白飛びが並ぶ状態をここで断つ
roughnessFactor = max( roughnessFactor, uGnd.z );
#include <lights_physical_fragment>`);
  };
  // surf材質は全部'surfShade1'の同じ鍵なので、そのままだと他の材質の
  // コンパイル済みプログラムを引き当てて、この差し込みが無かったことになる。
  // 前段の鍵を引き継ぐ（前段が違えばソースも違うので、鍵も分かれていないといけない）
  mat.customProgramCacheKey = () => prevKey + '|gnd';
  mat.needsUpdate = true;
  return mat;
}

/**
 * @param lamps 屋内のランプ(点光源3灯)を置くか。点光源は影を落とさなくても
 *   画面の全フラグメントで評価されるので、設定「影のこまやかさ:低」の端末では
 *   置かずに組む（シェーダの光の本数はコンパイル時に決まるため、起動時の1回だけ）
 */
export function buildLevel(mats, { lamps = true, mapId = 'urban' } = {}) {
  const root = new THREE.Group();
  const solids = new THREE.Group();   // 衝突に参加するもの
  const props = new THREE.Group();    // 衝突には入れない飾り（電線・アンテナ・路面の貼り分け）
  root.add(solids);
  root.add(props);

  // buildMaterials()は必ず16種すべてを返すので、無かった時の退避は置かない
  const M = {
    concrete: mats.concrete,
    concreteDark: mats.concreteDark,
    asphalt: mats.asphalt,
    metal: mats.metal,
    metalRed: mats.metalRed,
    wood: mats.wood,
    sandbag: mats.sandbag,
    brick: mats.brick,
    rust: mats.rustMetal,
    plaster: mats.plaster,
    dirt: mats.dirt,
    corr: mats.corrugated,
    // 江戸ステージ用（mapId==='edo'の時だけ使う）
    timber: mats.timberSiding,
    kawara: mats.kawara,
    earth: mats.packedEarth,
    shoji: mats.shojiPaper,
    /* 2026-08-17に足した3枚。**「江戸に見えない」の正体は色だった。**
       それまで白は1つも無く（障子紙は焼いてあるのに1回も貼っていなかった）、
       朱は輝度0.0079でほぼ黒、石畳と玉垣と灯籠は市街地のコンクリだった。
       実測: 白漆喰0.6499 ／ 朱0.2055 ／ 切石0.1908 ／ 瓦0.0151。
       白と黒瓦の差が5.5倍→43倍になった（src/world/textures.jsのmaterialTone） */
    shikkui: mats.shikkui,
    urushi: mats.urushi,
    stone: mats.cutstone,
    /* 提灯と行灯の灯り。**障子紙の材質を写して、自分で光る設定だけ足す。**

       なぜ写すか: 新しく焼くと1枚147ms＋VRAM4MBかかるが、
       欲しいのは「同じ紙が光っている」だけなので、地図(map)は共有できる。
       cloneはテクスチャを共有するので、焼き直しもVRAMも増えない。

       なぜ点光源(PointLight)にしないか: 点光源は1つでも全フラグメントに乗る。
       このrepoは既定で0個にしてある（src/main.jsのlamps）ので、
       灯りを「光る面」で作る。**ブルームも既定で切ってある**ので、
       にじみに頼らず、材質そのものを明るくして読ませる */
    lantern: (() => {
      const m = mats.shojiPaper.clone();
      m.emissive = new THREE.Color(0xff9333);
      // 2.6。周りの白漆喰(輝度0.65)より明確に上へ出す量。
      // 3を超えると白飛びして、紙の質感も骨も見えないただの白い塊になる
      m.emissiveIntensity = 2.6;
      m.toneMapped = true;
      return m;
    })(),
  };

  // 全材質に頂点カラーを開ける。emit()が個体ごとに±5%の明度を焼き込むので、
  // 結合して1枚のメッシュになった後でも「同じロットの箱」に見えなくなる。
  // main.js側は着弾音の引き当てに材質オブジェクトそのものを使うので、
  // cloneせず元のインスタンスに手を入れる（cloneすると引き当てが外れて無音になる）
  for (const key of Object.keys(M)) {
    const m = M[key];
    if (m) m.vertexColors = true;
  }
  // タイル周期より大きいムラを足す。床は面が大きいぶん強めに、
  // かつ頂点側のUVゆらぎも入れて格子そのものを読めなくする
  // 量は控えめに。縦方向へ引き伸ばして重力バイアスを掛けたぶん1本あたりが
  // 強く読めるので、以前の等方の値のままだと今度は縦縞の迷彩になる
  addMacroVariation(M.asphalt, 0.95, 0.055, 0.16);
  addMacroVariation(M.concrete, 0.45, 0.062);
  addMacroVariation(M.concreteDark, 0.45, 0.062);
  addMacroVariation(M.dirt, 0.90, 0.070);
  addMacroVariation(M.brick, 0.32, 0.075);
  addMacroVariation(M.plaster, 0.42, 0.070);
  addMacroVariation(M.corr, 0.30, 0.085);
  addMacroVariation(M.rust, 0.45, 0.085);
  addMacroVariation(M.metal, 0.32, 0.085);
  addMacroVariation(M.metalRed, 0.38, 0.085);
  addMacroVariation(M.wood, 0.30, 0.090);
  addMacroVariation(M.sandbag, 0.32, 0.090);
  addMacroVariation(M.timber, 0.30, 0.075);
  addMacroVariation(M.kawara, 0.40, 0.070);
  addMacroVariation(M.earth, 0.85, 0.070);
  /* 白漆喰と朱漆は**むらを弱めに**入れる。強く入れると、せっかく上げた
     明度と彩度がむらの暗い側で沈んで、また周りの茶色に混ざる */
  addMacroVariation(M.shikkui, 0.30, 0.040);
  addMacroVariation(M.urushi, 0.28, 0.035);
  addMacroVariation(M.stone, 0.42, 0.065);
  // 上のaddMacroVariationは、textures側でaddSurfaceShadingが済んでいる材質には効かない
  // （向こうがuserData.macroAppliedを立てて一本化している）。効くのはpatch用のcloneだけ。
  // 地面の4m格子はそのどちらでも壊せないので、専用の混合層をここで足す。
  // 土は水が引かないので粗さの下限を高く、舗装は少しだけ艶を残す
  addGroundBlend(M.asphalt, 0.31, 0.045, 0.54);
  addGroundBlend(M.dirt, 0.37, 0.052, 0.78);
  addGroundBlend(M.earth, 0.35, 0.050, 0.80);

  // 重なる半透明どうしの前後を決める表。材質を作る所とデカールを貼る所の
  // 両方から書くので、材質より先に用意しておく
  const renderOrders = new Map();

  // 開口部に入れるガラス。scene.environmentが既にPMREMの空なので、
  // metalnessを上げるだけで空が映り込み、視点を振ると反射が動く。
  // 「黒い矩形」が窓に変わるのはこの一枚のおかげ
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x1b2126, roughness: 0.09, metalness: 0.92,
    envMapIntensity: 1.5, side: THREE.DoubleSide, vertexColors: true,
  });
  // 非常灯・投光器のレンズ。bloomが拾って夕方の画に灯りが1点入る
  const lampMat = new THREE.MeshStandardMaterial({
    color: 0x2a2418, emissive: 0xffc978, emissiveIntensity: 2.4, roughness: 0.35,
    side: THREE.DoubleSide, vertexColors: true,
  });
  const grimeMat = new THREE.MeshBasicMaterial({
    map: grimeTexture(), blending: THREE.MultiplyBlending,
    // 乗算合成はpremultipliedAlphaが立っていないとthreeが警告を出す
    transparent: true, premultipliedAlpha: true, depthWrite: false, toneMapped: false, vertexColors: true,
  });
  const streakMat = new THREE.MeshBasicMaterial({
    map: streakTexture(), blending: THREE.MultiplyBlending,
    // 乗算合成はpremultipliedAlphaが立っていないとthreeが警告を出す
    transparent: true, premultipliedAlpha: true, depthWrite: false, toneMapped: false, side: THREE.DoubleSide, vertexColors: true,
  });
  // 水たまり。metalnessは上げない（水は誘電体で、真上から見ると
  // 反射率は数%しかない）。粗さを落として空を映すことだけで鏡面を作る
  const puddleMat = new THREE.MeshStandardMaterial({
    map: puddleTexture(), transparent: true, depthWrite: false,
    roughness: 0.14, metalness: 0.0, envMapIntensity: 1.0,
    polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
    vertexColors: true,
  });
  // 煙。光を受けさせるとフォグと二重に霞んで消えるので、Basicで焼き付けの色にする
  const plumeMat = new THREE.MeshBasicMaterial({
    map: plumeTexture(), transparent: true, opacity: 0.62, depthWrite: false,
    side: THREE.DoubleSide, vertexColors: true,
  });
  const grassMat = new THREE.MeshStandardMaterial({
    map: grassTexture(), alphaTest: 0.35, side: THREE.DoubleSide,
    roughness: 0.94, metalness: 0, vertexColors: true,
  });
  // 逆光の布は薄い所ほど強く透ける。透過を真面目に入れると描画順の問題が出るので、
  // emissiveで「裏から光が回っている」ぶんだけ底上げして黒潰れを防ぐ。
  // 色は空のヘイズ寄りの暖色にして、周囲の階調から浮かせない
  const tarpMat = new THREE.MeshStandardMaterial({
    map: tarpTexture(), alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: 0.95, metalness: 0, vertexColors: true,
    emissive: 0x6b5233, emissiveIntensity: 0.16,
  });
  // 遠景ビルの外装。1枚で共用すると全棟が同じ窓割りになるので、
  // 柱間と階高の違う3種を用意して棟ごとに割り当てる
  const farFacadeMats = [
    [3, 2, 17], [4, 3, 149], [2, 3, 271],
  ].map(([c, r, sd]) => new THREE.MeshStandardMaterial({
    map: farFacadeTexture(sd, c, r), roughness: 0.86, metalness: 0.04, vertexColors: true,
  }));
  // alphaTestは0.5へ上げる。下げると縁の半端なアルファが残って線が太り、
  // 遠距離でグレーの膜になる。細くなって消えるほうはミップ側で受け止めてある
  const fenceMat = new THREE.MeshStandardMaterial({
    map: fenceTexture(), alphaTest: 0.5, side: THREE.DoubleSide,
    roughness: 0.7, metalness: 0.6, vertexColors: true,
  });

  /* ------------------------------------------------ 汚しのデカール */
  // textures.js側で焼いた6種。貼り方が全て「発生源から下へ」なのが肝で、
  // 壁の中ほどに等方に散らすと汚れではなく塗装のムラになる
  const DEC = buildDecals(8);
  // 乗算ではなく通常合成の不透明度で乗せる。デカール自身も陽を受けるので
  // Standardのまま(日向の垂れは明るく、日陰の垂れは暗く出る)
  const decalMat = (map, order) => {
    const m = new THREE.MeshStandardMaterial({
      map, transparent: true, depthWrite: false, roughness: 0.93, metalness: 0,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6,
      vertexColors: true, side: THREE.DoubleSide,
    });
    renderOrders.set(m, order);
    return m;
  };
  const decRain = decalMat(DEC.rainStreak, 4);   // 窓台・庇・水切りの下
  const decGrime = decalMat(DEC.grime, 4);       // 壁と地面の接線
  const decRust = decalMat(DEC.rustRun, 5);      // ボルト・溶接部から下
  const decGraf = decalMat(DEC.graffiti, 5);     // 人の手が入っていた証拠
  const decSpall = decalMat(DEC.spall, 4);       // 剥落・欠け
  const decEdge = decalMat(DEC.edgeBand, 4);     // 舗装の切り替わりを跨ぐ帯

  // 配置に乱れは欲しいが、ロードのたびにマップが変わるのは困る。
  // Math.randomではなく固定種の擬似乱数にして毎回同じ地形にする
  let seed = 20260731;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const rr = (a, b) => a + (b - a) * rnd();

  /* ------------------------------------------------ ジオメトリの収集 */
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _one = new THREE.Vector3(1, 1, 1);

  const solidChunks = new Map();
  const propChunks = new Map();
  // 射線判定にも参加させないもの（雑草・足元の汚れ・外周の遠景）。
  // 雑草の板で弾が空中で止まったり、120m先の遠景で着弾したりすると理不尽になる
  const fxChunks = new Map();
  const matIds = new Map();

  // 区画に切る。細かく切るほど描画コールは増えるが、バウンディング球が小さくなって
  // 射線判定(raycast)の早期棄却が効く。6x6(1区画16m)でショットガン9発分の射線が
  // 3.6ms→1.9msまで落ちる。8x8にしても0.4ms程度しか変わらず描画コールだけ増える
  const ZDIV = 6;
  const zoneOf = (x, z) => {
    const gx = clamp(Math.floor((x + 48) / 16), 0, ZDIV - 1);
    const gz = clamp(Math.floor((z + 48) / 16), 0, ZDIV - 1);
    return gz * ZDIV + gx;
  };

  const bucket = (store, mat, x, z) => {
    if (!matIds.has(mat)) matIds.set(mat, matIds.size);
    const key = matIds.get(mat) * ZDIV * ZDIV + zoneOf(x, z);
    let c = store.get(key);
    if (!c) { c = { mat, list: [] }; store.set(key, c); }
    return c;
  };

  // 全材質でvertexColorsを開けたので、色属性の無いジオメトリを混ぜると真っ黒になる。
  // ここで必ず1本用意する。tintは個体ごとの明度ずらし
  // tintは数値（明度のみ）でも[r,g,b]でも受ける。土嚢のように
  // 「材質の彩度そのものを下げたい」物は明度だけでは直せない
  const ensureColor = (geo, tint) => {
    if (geo.attributes.color) return;
    const n = geo.attributes.position.count;
    const arr = new Float32Array(n * 3);
    if (Array.isArray(tint)) {
      for (let i = 0; i < n; i++) { arr[i * 3] = tint[0]; arr[i * 3 + 1] = tint[1]; arr[i * 3 + 2] = tint[2]; }
    } else arr.fill(tint);
    geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  };

  const ROT_C = [1, 0, -1, 0];
  const ROT_S = [0, 1, 0, -1];

  // rotation.orderは'YXZ'固定。ヨーを先に効かせないと斜路の向きがねじれる。
  // varyがtrueの時は「置いた場所から決まる」UVの位相ずらしと明度ずらしを焼き込む。
  // applyBoxUVはローカル位置からUVを作るので、これをやらないと量産プロップが
  // 全部まったく同じ位相で貼られ、6個並べると完全なコピーに見える
  const emit = (geo, mat, x, y, z, ry = 0, rx = 0, rz = 0, solid = true, vary = true, tintMul = 1) => {
    let tint = tintMul;
    if (vary) {
      const h1 = hash3(x, y, z);
      const h2v = hash3(z + 11.3, x - 7.1, y + 3.7);
      const uv = geo.attributes.uv;
      if (uv) {
        // 木材だけは90度単位の回転も混ぜる。木目の向きが変わると別のロットに見える。
        // レンガや波板を回すと積み方・リブの向きが崩れるので回さない
        const k = mat === M.wood ? Math.floor(h1 * 4) & 3 : 0;
        const c = ROT_C[k], s = ROT_S[k];
        const du = h1 * 4.0, dv = h2v * 4.0;
        for (let i = 0; i < uv.count; i++) {
          const u0 = uv.getX(i), v0 = uv.getY(i);
          uv.setXY(i, u0 * c - v0 * s + du, u0 * s + v0 * c + dv);
        }
        uv.needsUpdate = true;
      }
      const k = 0.95 + h2v * 0.10;
      tint = Array.isArray(tintMul) ? [tintMul[0] * k, tintMul[1] * k, tintMul[2] * k] : tintMul * k;
    }
    ensureColor(geo, tint);
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _m4.compose(_p.set(x, y, z), _q, _one);
    geo.applyMatrix4(_m4);
    bucket(solid ? solidChunks : propChunks, mat, x, z).list.push(geo);
    return geo;
  };

  // 射線にも影にも参加しない層。区画分けはせず材質ごとに1枚へまとめる
  const fxEmit = (geo, mat, x, y, z, ry = 0, rx = 0, rz = 0, tint = 1) => {
    ensureColor(geo, tint);
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _m4.compose(_p.set(x, y, z), _q, _one);
    geo.applyMatrix4(_m4);
    if (!matIds.has(mat)) matIds.set(mat, matIds.size);
    const key = matIds.get(mat);
    let c = fxChunks.get(key);
    if (!c) { c = { mat, list: [] }; fxChunks.set(key, c); }
    c.list.push(geo);
    return geo;
  };

  /* -------------------------------------------------- デカールの貼り付け */
  // デカールのテクスチャは全部ClampToEdgeなので、UVを1より外へ出すと
  // 縁の値が引き伸ばされて板の外側に筋が残る。繰り返したい時は板を割る。
  // 同じ板が等間隔で並ぶと模様として読めるので、半分は左右反転して使う
  const flipU = (geo) => {
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    uv.needsUpdate = true;
    return geo;
  };
  // 壁に貼る。yTopが発生源(窓台・庇の下端)で、そこから下へhだけ垂れる。
  // 面から2.5cm浮かせたうえでpolygonOffsetも効かせないと、
  // 斜めから見た時にデカールが壁へ潜って途中で消える
  const wallDecal = (mat, w, h, x, yTop, z, ry, tint = 1) => {
    const g = new THREE.PlaneGeometry(w, h);
    if (hash3(x, yTop, z) < 0.5) flipU(g);
    fxEmit(g, mat, x + Math.sin(ry) * 0.028, yTop - h / 2, z + Math.cos(ry) * 0.028, ry, 0, 0, tint);
  };
  // 床に伏せて貼る。舗装の切り替わりや目地の欠けに使う
  const floorDecal = (mat, w, d, x, z, ry, y = 0.05, tint = 1) => {
    const g = new THREE.PlaneGeometry(w, d);
    g.rotateX(-Math.PI / 2);
    if (hash3(x, w, z) < 0.5) flipU(g);
    fxEmit(g, mat, x, y, z, ry, 0, 0, tint);
  };
  // 壁の根本の泥はね。長い壁は板を割って貼る（引き伸ばすと1枚の帯に見える）
  const grimeBase = (x, z, ry, len, h = 1.0, tint = 1, gap = null) => {
    const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
    // 扉のために基礎の段差を切り欠いた所。板を通しで貼ると、段差が無くなった
    // 開口のど真ん中に泥の板だけが宙に浮いて残る。切り欠きの左右へ分けて貼る
    if (gap) {
      const s = gap.u - gap.w / 2, e = gap.u + gap.w / 2;
      for (const [a, b] of [[-len / 2, s], [e, len / 2]]) {
        if (b - a < 0.5) continue;
        const u = (a + b) / 2;
        grimeBase(x + dirX * u, z + dirZ * u, ry, b - a, h, tint);
      }
      return;
    }
    const n = Math.max(1, Math.round(len / 3.8));
    const seg = len / n;
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) * seg - len / 2;
      const hv = hash3(x + u * 1.7, i * 3.1, z);
      wallDecal(decGrime, seg * 1.06, h * (0.72 + hv * 0.62),
        x + dirX * u, h * (0.72 + hv * 0.62), z + dirZ * u, ry, tint);
    }
  };
  // 建物の4辺の根本へまとめて。wは東西、dは南北の外寸。
  // doorsはbandと同じ書き方で渡す（切り欠いた所に泥の板を残さないため）。
  // 4辺のうちz-とx+はuの向きがbandと逆に走るので、ここで符号を合わせる
  const grimeRing = (cx, cz, w, d, h = 1.0, doors = []) => {
    const gapOf = (side, flip) => {
      const o = doors.find((q) => q.side === side);
      return o ? { u: flip ? -o.u : o.u, w: o.w } : null;
    };
    grimeBase(cx, cz + d / 2, 0, w, h, 1, gapOf('z+', false));
    grimeBase(cx, cz - d / 2, Math.PI, w, h, 1, gapOf('z-', true));
    grimeBase(cx + w / 2, cz, Math.PI / 2, d, h, 1, gapOf('x+', true));
    grimeBase(cx - w / 2, cz, -Math.PI / 2, d, h, 1, gapOf('x-', false));
  };
  // ボルト・溶接部から下へ落ちる錆垂れ
  const rustRun = (x, yTop, z, ry, w = 0.30, h = 1.1, tint = 1) =>
    wallDecal(decRust, w, h, x, yTop, z, ry, tint);
  // 円筒(ドラム缶・タンク)の側面に貼る。半径ぶん外へ出す
  const rustRunCyl = (x, yTop, z, r, ang, w = 0.26, h = 0.85) =>
    rustRun(x + Math.sin(ang) * (r + 0.012), yTop, z + Math.cos(ang) * (r + 0.012), ang, w, h);

  /* -------------------------------------- プロップの足元（接地の記録） */
  // 置いた物の足跡を覚えておいて、後から広場の頂点カラーを暗く焼き、
  // 足元へ汚れの板を敷く。物が地面に「乗っている」実感はここで決まる
  const marks = [];
  const mark = (x, z, r, strength = 1, decal = true) => {
    marks.push({ x, z, r, s: strength, decal });
  };
  // 壁面版の足跡。開口の下端（窓台）は雨だれの発生源として必ず記録する。
  // 全部の壁を後から手で拾うのは現実的でないので、開口を作る側で控えておく
  const sills = [];

  /* -------------------------------------------------------- 基本の形 */
  // 箱を置く。yは「底面の高さ」で指定できるようにして配置ミスを減らす
  const box = (w, h, d, mat, x, yBottom, z, ry = 0, texScale = 2.5) =>
    emit(makeBox(w, h, d, texScale), mat, x, yBottom + h / 2, z, ry);
  const boxD = (w, h, d, mat, x, yBottom, z, ry = 0, texScale = 2.5) =>
    emit(makeBox(w, h, d, texScale), mat, x, yBottom + h / 2, z, ry, 0, 0, false);
  // 傾けたい物（瓦礫・立てかけた鉄板）は中心指定のほうが素直
  const boxT = (w, h, d, mat, x, yC, z, ry, rx, rz, texScale = 2, solid = true) =>
    emit(makeBox(w, h, d, texScale), mat, x, yC, z, ry, rx, rz, solid);

  // 外周だけを囲む帯。基礎の段差・モールディング・蛇腹に使う。
  // 中身の詰まった箱で作ると建物の内側が埋まって入れなくなる。
  //
  // doorsは帯を切り欠く所。**基礎の段差が入口を横切ると、床まで開いているはずの
  // 扉の前に腰の高さのコンクリートが通しで残る。** 建物Bはこれで
  // 「屋根の崩落跡から落ちたら二度と出られない部屋」になっていた。
  // 段差の天端は1.15mで、跳べる高さ(0.99m)より上。立ったまま跳ぶと
  // まぐさ(2.9m)に頭がつかえて乗り越えの補助も効かないので、
  // しゃがみ跳びを知らないと本当に出られない。
  //
  // sideは 'z-' 'z+' が東西へ走る辺、'x-' 'x+' が南北へ走る辺。
  // uは辺の中心からの位置で、z辺は+X向き・x辺は+Z向きに測る
  // （開口をuで指定するwallRunと同じ場所を指せるようにするため）
  /* solid=false にすると当たり判定に入れない（飾りの帯用）。
     **壁と同じ場所へ当たり判定を二重に置くと、そこを歩いた時に
     押し戻す向きが2つできて画面が揺れる。** 江戸の町屋で実際に踏んだ
     （貫と、蔵の海鼠壁を、壁と重ねて当たり判定ごと置いていた） */
  const band = (w, d, h, t, mat, cx, yBottom, cz, texScale = 2.0, doors = [], solid = true) => {
    const put = solid ? box : boxD;
    const run = (side, len, place) => {
      const cuts = doors.filter((o) => o.side === side)
        .map((o) => [clamp(o.u - o.w / 2, -len / 2, len / 2), clamp(o.u + o.w / 2, -len / 2, len / 2)])
        .sort((a, b) => a[0] - b[0]);
      let cursor = -len / 2;
      for (const [s, e] of cuts) {
        if (s - cursor > 0.02) place((cursor + s) / 2, s - cursor);
        cursor = Math.max(cursor, e);
      }
      if (len / 2 - cursor > 0.02) place((cursor + len / 2) / 2, len / 2 - cursor);
    };
    run('z-', w, (u, l) => put(l, h, t, mat, cx + u, yBottom, cz - d / 2 + t / 2, 0, texScale));
    run('z+', w, (u, l) => put(l, h, t, mat, cx + u, yBottom, cz + d / 2 - t / 2, 0, texScale));
    run('x-', d - t * 2, (u, l) => put(t, h, l, mat, cx - w / 2 + t / 2, yBottom, cz + u, 0, texScale));
    run('x+', d - t * 2, (u, l) => put(t, h, l, mat, cx + w / 2 - t / 2, yBottom, cz + u, 0, texScale));
  };

  // 建物の出隅の面取り。直角の角は稜線にハイライトが1本も走らないので、
  // 縦面が上から下までのっぺりした板に見える。45度に回した細い角材を角へ差し込むと
  // 面の向きが1つ増えて、低い陽でも稜線に細い明線が立つ。
  // 衝突は本体の壁で取れているので飾り扱いにしてOctreeを太らせない
  const cornerChamfer = (mat, cx, cz, w, d, h, yBottom = 0, t = 0.15) => {
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        emit(makeBox(t, h, t, 1.0), mat,
          cx + su * (w / 2 - t * 0.3), yBottom + h / 2, cz + sv * (d / 2 - t * 0.3),
          Math.PI / 4, 0, 0, false);
      }
    }
  };

  const cylGeo = (rTop, rBot, h, seg, uvU = 3, uvV = 1) => {
    const geo = new THREE.CylinderGeometry(rTop, rBot, h, seg, 1);
    scaleUV(geo, uvU, uvV);
    return geo;
  };
  const cyl = (r, h, seg, mat, x, yBottom, z, uvU = 3, solid = true) =>
    emit(cylGeo(r, r, h, seg, uvU), mat, x, yBottom + h / 2, z, 0, 0, 0, solid);
  // 寝かせた配管・倒れたドラム缶。ローカルYを倒すのでrz=PI/2、向きはryで振る。
  // 倒した後の軸方向は (cos ry, 0, -sin ry)
  const cylLay = (r, len, seg, mat, x, yC, z, ry, uvU = 3, solid = true) =>
    emit(cylGeo(r, r, len, seg, uvU), mat, x, yC, z, ry, 0, Math.PI / 2, solid);

  /* -------------------------------------------------- 壁（開口部つき） */
  // 板を1枚置くだけだと厚みのない書き割りになるので、窓や扉を穴として指定して
  // 袖壁・腰壁・まぐさに割って積む。yBaseがあるのでパラペットにも使い回せる
  const wallRun = (mat, cx, cz, ry, len, h, t, holes = [], texScale = 3, yBase = 0) => {
    const dirX = Math.cos(ry);
    const dirZ = -Math.sin(ry);
    const seg = (u0, u1, y0, y1) => {
      const w = u1 - u0;
      if (w <= 0.02 || y1 - y0 <= 0.02) return;
      const u = (u0 + u1) / 2;
      box(w, y1 - y0, t, mat, cx + dirX * u, yBase + y0, cz + dirZ * u, ry, texScale);
    };
    const list = holes.slice().sort((a, b) => a.u - b.u);

    /* 壁を積む。開口の左右の端を全部並べて、その間の細長い区画ごとに
       「かかっている開口の高さを抜いた残り」へ壁を入れる。

       前は「前の開口の右端から次の開口の左端まで」と順に積んでいた。
       開口どうしが横に重ならない限りこれで同じ形になるが、
       **重なると後の開口の腰壁が先の開口を塗り潰す。**
       建物Bの西の入口(u=0 幅3.0 床から2.9m)は、真上に足した高窓
       (u=0 幅2.0 3.7〜5.0m)の腰壁(0〜3.7m)で完全に塞がっていた。
       扉が絵だけになっていたので、屋根の崩落跡から中へ落ちると出られなかった */
    const cuts = [-len / 2, len / 2];
    for (const ho of list) {
      cuts.push(clamp(ho.u - ho.w / 2, -len / 2, len / 2));
      cuts.push(clamp(ho.u + ho.w / 2, -len / 2, len / 2));
    }
    cuts.sort((a, b) => a - b);
    for (let i = 0; i < cuts.length - 1; i++) {
      const u0 = cuts[i], u1 = cuts[i + 1];
      if (u1 - u0 <= 0.02) continue;
      const mid = (u0 + u1) / 2;
      const spans = list
        .filter((ho) => ho.u - ho.w / 2 < mid && ho.u + ho.w / 2 > mid)
        .map((ho) => [ho.y0, ho.y1])
        .sort((a, b) => a[0] - b[0]);
      let y = 0;
      for (const [y0, y1] of spans) {
        if (y0 > y) seg(u0, u1, y, y0);
        y = Math.max(y, y1);
      }
      seg(u0, u1, y, h);
    }

    /* 開口まわりの造作。見切り・建具はこちらで開口ごとに足す */
    for (const ho of list) {
      const s = clamp(ho.u - ho.w / 2, -len / 2, len / 2);
      const e = clamp(ho.u + ho.w / 2, -len / 2, len / 2);
      // 窓台とまぐさの見切り。厚みが1段出るだけで開口が「穴」から「窓」になる
      if (ho.trim !== false && ho.y1 - ho.y0 > 0.05) {
        const u = (s + e) / 2;
        const px = cx + dirX * u;
        const pz = cz + dirZ * u;
        if (ho.y0 > 0.05) {
          box(e - s + 0.34, 0.12, t + 0.22, mat, px, yBase + ho.y0 - 0.12, pz, ry, 1.4);
          // 窓台は水切りなので、必ずここから下へ雨だれが落ちる。
          // 腰の高さ以下の開口(通路・銃眼)は水が回らないので拾わない
          if (yBase + ho.y0 > 1.0) {
            sills.push({ x: px, y: yBase + ho.y0 - 0.14, z: pz, ry, w: e - s + 0.34, t });
          }
        }
        if (ho.y1 < h - 0.05) box(e - s + 0.34, 0.16, t + 0.16, mat, px, yBase + ho.y1, pz, ry, 1.4);
      }
      // 建具。開口を空けただけだと屋外の強い光の下で窓だけ情報ゼロの黒い矩形になり、
      // そこだけ穴が空いて見える。枠で奥行きを作り、ガラスに空を映して埋める。
      // 敷居が低い開口は扉や通路なので触らない（塞ぐと動線が消える）
      const ow = e - s, oh = ho.y1 - ho.y0;
      if (ho.frame !== false && ow > 0.35 && oh > 0.35 && ho.y0 > 0.45) {
        const u = (s + e) / 2;
        const px = cx + dirX * u;
        const pz = cz + dirZ * u;
        const yc = yBase + (ho.y0 + ho.y1) / 2;
        const ft = t * 0.62;
        // 建具の枠。ガラスを張らない開口(銃眼・割れて抜けた窓)まで錆びた鉄枠にすると、
        // 灰色の壁の中でそこだけ彩度が突出して「テクスチャ事故」に見える。
        // 鉄はまぐさ材1本に限り、残りはコンクリの見切りで納める
        const fm = ho.glass === false ? M.concreteDark : M.rust;
        boxD(ow, 0.08, ft, M.rust, px, yBase + ho.y1 - 0.08, pz, ry, 0.6);
        boxD(ow, 0.08, ft, fm, px, yBase + ho.y0, pz, ry, 0.6);
        for (const sgn of [-1, 1]) {
          const ux = dirX * sgn * (ow / 2 - 0.04);
          const uz = dirZ * sgn * (ow / 2 - 0.04);
          boxD(0.08, oh, ft, fm, px + ux, yBase + ho.y0, pz + uz, ry, 0.6);
        }
        if (ho.glass !== false) {
          const hv = hash3(px, ho.y0 * 3.1, pz);
          if (hv < 0.66) {
            // ガラス。metalnessを上げてあるのでPMREMの空をそのまま拾い、
            // 視点を振ると映り込みが動く。それだけで穴が窓になる
            emit(new THREE.PlaneGeometry(ow - 0.12, oh - 0.12), glassMat,
              px, yc, pz, ry, 0, 0, false);
          } else if (hv < 0.86) {
            // 板打ち。斜めに2枚打ってあるだけで「閉めた」物語が出る。
            // 衝突あり(solid=true)。窓枠(boxD)やガラス(emit...false)は
            // 「割れて中が見える」「反射するガラス」という絵なのですり抜けても
            // 矛盾しないが、板打ちだけは「閉じている」という絵と実際の挙動が
            // 食い違っていた（issue #57）
            boxT(ow * 1.12, 0.19, 0.05, M.wood, px, yc + oh * 0.16, pz, ry, 0, 0.30, 0.8, true);
            boxT(ow * 1.12, 0.17, 0.05, M.wood, px, yc - oh * 0.18, pz, ry, 0, -0.24, 0.8, true);
          }
          // 残りは割れて抜けたまま。全部を同じ建具にしないのが効く
        }
      }
    }
  };

  /* -------------------------------------------------- 斜路・階段・板 */
  const rampSlab = (w, run, rise, mat, x, yBottom, z, ry, thick = 0.34, texScale = 2.0) => {
    const angle = Math.atan2(rise, run);
    const span = Math.hypot(run, rise);
    emit(makeBox(w, thick, span, texScale), mat, x, yBottom + rise / 2, z, ry, -angle, 0);
    return { angle, span };
  };

  const ramp = (w, run, mat, x, yBottom, z, ry, rise) => {
    const { angle, span } = rampSlab(w, run, rise, mat, x, yBottom, z, ry, 0.4, 2.5);
    // 脚。これが無いと板が宙に浮いて見えて、一気に書き割りっぽくなる
    const fwd = { x: Math.sin(ry), z: Math.cos(ry) };
    const side = { x: Math.cos(ry), z: -Math.sin(ry) };
    const legInset = w / 2 - 0.18;
    for (let i = 0; i < 4; i++) {
      const t = ((i + 0.5) / 4 - 0.5) * span;
      const top = yBottom + rise / 2 + t * Math.sin(angle) - 0.2;
      if (top < 0.35) continue;
      for (const s of [-legInset, legInset]) {
        box(0.22, top, 0.22, mat, x + fwd.x * t + side.x * s, 0, z + fwd.z * t + side.z * s, ry, 1.4);
      }
    }
  };

  // 渡り板。屋根から屋根、コンテナから屋根をつなぐ。脚は付けない
  const plank = (w, run, rise, mat, x, yBottom, z, ry) =>
    rampSlab(w, run, rise, mat, x, yBottom, z, ry, 0.26, 1.4);

  // 外階段。足場は斜面のままなので段差でカプセルが引っかからない。
  // 側桁と手すりを付けるだけで工場の外階段に見える
  const stair = (w, run, rise, mat, railMat, x, yBottom, z, ry) => {
    const { angle, span } = rampSlab(w, run, rise, mat, x, yBottom, z, ry, 0.34, 1.8);
    const fwd = { x: Math.sin(ry), z: Math.cos(ry) };
    const side = { x: Math.cos(ry), z: -Math.sin(ry) };
    const midY = yBottom + rise / 2;

    // 踏面と蹴込み。斜めのスラブは衝突用にそのまま残す（段でカプセルが引っかからない）。
    // 見えるほうを段に刻まないと、縞模様を貼った1枚板にしか見えない。
    // ここはboxD（衝突なし）で刻む。boxで刻むとコメントの意図に反して段自体も
    // 衝突判定に入り、スラブと段の二重の当たり判定ができてしまう
    // （段差は0.18m前後なのでプレイヤー側の段差乗り越えで実害は出ないが、
    // 上るたびに乗り越えの処理が段の数だけ余分に走り、Octreeも無駄に太る）
    const n = clamp(Math.round(rise / 0.18), 3, 48);
    const stepRun = run / n, stepRise = rise / n;
    for (let i = 0; i < n; i++) {
      const hu = -run / 2 + (i + 0.5) * stepRun;
      const ys = yBottom + 0.17 + (i + 0.5) * stepRise;    // 踏面の高さ
      boxD(w, 0.055, stepRun + 0.05, mat,
        x + fwd.x * hu, ys - 0.055, z + fwd.z * hu, ry, 0.9);
      const hb = -run / 2 + (i + 1) * stepRun;
      boxD(w, stepRise, 0.045, mat,
        x + fwd.x * hb, ys - 0.055, z + fwd.z * hb, ry, 0.9);
    }

    for (const s of [-(w / 2 + 0.08), w / 2 + 0.08]) {
      emit(makeBox(0.16, 0.42, span, 1.4), mat, x + side.x * s, midY - 0.1, z + side.z * s, ry, -angle, 0);
      // 手すりは角材だと工事の仮設に見える。丸パイプにして端にエルボの返しを付ける
      emit(cylGeo(0.028, 0.028, span, 8, 6, 1), railMat,
        x + side.x * s, midY + 1.02, z + side.z * s, ry, Math.PI / 2 - angle, 0);
      for (const endS of [-1, 1]) {
        const t = endS * span / 2;
        const surf = midY + t * Math.sin(angle);
        emit(cylGeo(0.028, 0.028, 0.34, 8, 2, 1), railMat,
          x + fwd.x * t * Math.cos(angle) + side.x * s, surf + 0.86,
          z + fwd.z * t * Math.cos(angle) + side.z * s, ry, Math.PI / 2, 0);
      }
      const np = Math.max(2, Math.round(span / 2.1));
      for (let i = 0; i <= np; i++) {
        const t = (i / np - 0.5) * span;
        const surf = midY + t * Math.sin(angle);
        cyl(0.026, 1.02, 6, railMat,
          x + fwd.x * t + side.x * s, surf, z + fwd.z * t + side.z * s, 1.0);
      }
    }
    mark(x - fwd.x * run / 2, z - fwd.z * run / 2, w * 0.9 + 0.6, 0.8);
  };

  // 手すり（水平）。屋上や中2階の縁の落下止めも兼ねる
  const railing = (len, mat, x, yBottom, z, ry, texScale = 1.0) => {
    const dirX = Math.cos(ry);
    const dirZ = -Math.sin(ry);
    box(len, 0.08, 0.08, mat, x, yBottom + 1.0, z, ry, texScale);
    box(len, 0.07, 0.07, mat, x, yBottom + 0.52, z, ry, texScale);
    const n = Math.max(2, Math.round(len / 1.9));
    for (let i = 0; i <= n; i++) {
      const u = (i / n - 0.5) * len;
      box(0.09, 1.08, 0.09, mat, x + dirX * u, yBottom, z + dirZ * u, ry, texScale);
    }
  };

  // 高台。脚と手すりを付けて「置かれただけの板」に見せない
  const platform = (w, d, mat, railMat, x, yTop, z, ry, rails = []) => {
    box(w, 0.34, d, mat, x, yTop - 0.34, z, ry, 2.0);
    const dirX = Math.cos(ry);
    const dirZ = -Math.sin(ry);
    const perpX = Math.sin(ry);
    const perpZ = Math.cos(ry);
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        const ox = dirX * su * (w / 2 - 0.3) + perpX * sv * (d / 2 - 0.3);
        const oz = dirZ * su * (w / 2 - 0.3) + perpZ * sv * (d / 2 - 0.3);
        box(0.24, yTop - 0.34, 0.24, mat, x + ox, 0, z + oz, ry, 1.4);
      }
    }
    for (const side of rails) {
      if (side === 'x-') railing(d, railMat, x - dirX * w / 2, yTop, z - dirZ * w / 2, ry + Math.PI / 2);
      if (side === 'x+') railing(d, railMat, x + dirX * w / 2, yTop, z + dirZ * w / 2, ry + Math.PI / 2);
      if (side === 'z-') railing(w, railMat, x - perpX * d / 2, yTop, z - perpZ * d / 2, ry);
      if (side === 'z+') railing(w, railMat, x + perpX * d / 2, yTop, z + perpZ * d / 2, ry);
    }
  };

  // 登れる段差。ジャンプの到達高が約0.95mなので1段0.78で刻めば必ず登れる
  const stepBlocks = (x, z, ry, n, mat, rise = 0.78, run = 1.15, w = 1.9) => {
    const dx = Math.sin(ry);
    const dz = Math.cos(ry);
    for (let i = 0; i < n; i++) {
      box(w, rise * (i + 1), run, mat,
        x + dx * (i + 0.5) * run, 0, z + dz * (i + 0.5) * run, ry, 1.6);
    }
  };

  /* ------------------------------------------------------ 小物の部品 */
  // ジャージーバリア（コンクリの車止め）。台形を3段の箱で近似する。
  // 全高0.92は胸の高さの遮蔽であり、同時にジャンプで乗れる踏み台にもなる
  const jersey = (x, z, ry, len = 2.2, mat = M.concrete) => {
    box(len, 0.26, 0.78, mat, x, 0, z, ry, 1.6);
    box(len, 0.42, 0.52, mat, x, 0.26, z, ry, 1.6);
    box(len, 0.24, 0.34, mat, x, 0.68, z, ry, 1.6);
    mark(x, z, len * 0.7, 0.85);
  };
  // 横倒しの車止め。列に1個混ざるだけで「定規で並べた」感じが消える
  const jerseyDown = (x, z, ry, len = 2.2, mat = M.concrete) => {
    boxT(len, 0.60, 0.86, mat, x, 0.30, z, ry, 0, 0.06, 1.6);
    boxT(len * 0.92, 0.30, 0.42, mat,
      x + Math.sin(ry) * 0.58, 0.68, z + Math.cos(ry) * 0.58, ry, 0, 0.12, 1.6);
    mark(x, z, len * 0.75, 0.9);
  };
  // 等間隔の直列は実質完全な直線に見える。2〜3個のまとまりと隙間に割り、
  // 向き・横ずれ・横倒しを混ぜて非対称にクラスタ化する
  const jerseyLine = (x, z, ry, n, gap = 2.35, mat = M.concrete) => {
    const dx = Math.cos(ry);
    const dz = -Math.sin(ry);
    const px = Math.sin(ry);
    const pz = Math.cos(ry);
    const us = [];
    let u = 0, left = n;
    while (left > 0) {
      const grp = Math.min(left, 2 + Math.floor(rnd() * 2));
      for (let k = 0; k < grp; k++, left--) { us.push(u); u += gap; }
      if (left > 0) u += gap * rr(0.30, 0.85);
    }
    const mid = (us[0] + us[us.length - 1]) / 2;
    for (const uu of us) {
      const t = uu - mid;
      const off = rr(-0.25, 0.25);
      const cxx = x + dx * t + px * off;
      const czz = z + dz * t + pz * off;
      if (rnd() < 0.17) jerseyDown(cxx, czz, ry + rr(-0.4, 0.4), 2.2, mat);
      else jersey(cxx, czz, ry + rr(-0.15, 0.15), 2.2, mat);
    }
  };

  // 土嚢。角の立った直方体だと、ほぼ水平の視線では法線マップの嘘が効かず
  // 「模様を描いた板」に見えるので、シルエットそのものを枕型にする
  // 全個体が同寸だと金型で抜いたクッションが並んで見えるので、
  // 幅・奥行き・潰れ具合を個別に振る。squashは下段ほど強く効かせて、
  // 「上に何も載っていない袋」と「潰れて広がった袋」を作り分ける。
  // 明度は0.74倍。周囲の路面より2段明るいと、遮蔽ではなく土嚢へ視線が吸われる
  // 麻袋の色。前は明度0.74倍だけ掛けていて rgb(157,130,77) と黄色が強く、
  // 黄色いクッションが並んでいるように見えていた。青を戻して彩度を落とす
  const SANDBAG_TINT = [0.695, 0.725, 0.90];
  const sandbagAt = (x, yBottom, z, ry, s = 1, squash = 1) => {
    const sd = Math.round(x * 13.7 + z * 29.3 + yBottom * 7.1);
    const jw = 0.80 + h2(sd, 1, 401) * 0.50;      // 長さ±25%
    const jd = 0.86 + h2(sd, 2, 403) * 0.30;
    // ヨーも個体ごとに振る。呼び出し側の±0.12だけだと列が定規で引いたように揃う
    const yaw = ry + (h2(sd, 5, 409) - 0.5) * 0.50;
    // 15%は破れた袋。中身が流れ出た分だけ潰れて低くなる
    const torn = h2(sd, 9, 411) < 0.15;
    const sq = torn ? squash * 0.72 : squash;
    const w = 1.0 * s * jw * (torn ? 0.92 : 1), h = 0.55 * s * sq, d = 0.7 * s * jd;
    emit(sandbagGeo(w, h, d, 1.1, sd, sq), M.sandbag,
      x, yBottom + h / 2, z, yaw, 0, 0, true, true, SANDBAG_TINT);
    if (torn) {
      // 流出した中身。rnd()を使わずハッシュから引く（ここに処理を足しても
      // 既存の配置がひとつもずれない）
      const oa = h2(sd, 13, 419) * 6.28;
      for (let i = 0; i < 5; i++) {
        const t2 = h2(sd + i, 17, 421);
        const rad = (0.34 + t2 * 0.55) * s;
        const ang = oa + (h2(sd + i, 19, 423) - 0.5) * 1.5;
        const gs = 0.07 + h2(sd + i, 23, 427) * 0.10;
        emit(chunkGeo(gs * 2.0, gs * 0.7, gs * 1.5, 0.6, sd + i * 31, 0.4), M.dirt,
          x + Math.cos(ang) * rad, yBottom + gs * 0.3, z + Math.sin(ang) * rad,
          h2(sd + i, 29, 431) * 3.14, 0, 0, false, true, 0.9);
      }
    }
    // 接地。袋の下に汚れが無いと地面に「置いてある」ようにしか見えない
    if (yBottom < 0.12) mark(x, z, 0.85 * s, 0.55);
    return h;
  };

  // 木箱1個。立方体を1個置くだけだと継ぎ目も角材も蓋も無い茶色い塊になり、
  // 水平の帯がテクスチャの模様でしかなくなる。角の縦桟4本と天地の桟で稜線を起こすと、
  // 逆光でも必ずハイライトが1本立って「組まれた箱」に読める。
  // 桟は本体の箱で衝突が取れているので飾り扱いにしてOctreeを太らせない
  // 木箱は3バリアント(開梱/破損/シート掛け)を種から引き当てる。
  // 同じ箱に同じ板目が乗っただけの山が7つ並ぶと、露骨に複製だと分かる
  const crate = (s, hgt, x, yb, z, ry) => {
    const t = 0.055;
    const dx = Math.cos(ry), dz = -Math.sin(ry);
    const px = Math.sin(ry), pz = Math.cos(ry);
    const sd = Math.round(x * 19.3 + z * 7.7 + yb * 31.1 + s * 53.3);
    const kind = h2(sd, 1, 131);
    // 側板は桟のぶん内側へ落とす。落とさないと桟が板に埋まって稜線が出ない
    box(s - t * 1.7, hgt - t * 1.6, s - t * 1.7, M.wood, x, yb + t * 0.8, z, ry, 1.2);
    const hs = s / 2 - t / 2;
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        boxD(t, hgt, t, M.wood,
          x + dx * su * hs + px * sv * hs, yb, z + dz * su * hs + pz * sv * hs, ry, 0.45);
        // 隅金物。角に小さい金物が1つ乗るだけで、木の塊が「組んだ箱」になる
        for (const by of [yb + t * 0.3, yb + hgt - 0.1]) {
          boxD(0.075, 0.075, 0.075, M.metal,
            x + dx * su * hs + px * sv * hs, by, z + dz * su * hs + pz * sv * hs, ry, 0.16);
        }
      }
    }
    for (const by of [yb + t * 0.6, yb + hgt - t * 1.6]) {
      for (const sv of [-1, 1]) {
        boxD(s, t, t, M.wood, x + px * sv * hs, by, z + pz * sv * hs, ry, 0.45);
        boxD(t, t, s - t * 2, M.wood, x + dx * sv * hs, by, z + dz * sv * hs, ry, 0.45);
      }
    }
    if (kind < 0.40) {
      // 未開封。蓋を締めて梱包バンドを2本掛ける
      boxD(s * 0.97, t * 0.85, s * 0.97, M.wood, x, yb + hgt - t * 0.85, z, ry, 0.9);
      for (const sv of [-0.26, 0.26]) {
        boxD(s * 1.02, hgt * 0.98, 0.022, M.metal,
          x + px * sv * s, yb + hgt * 0.01, z + pz * sv * s, ry, 0.5);
        boxD(0.022, hgt * 0.98, s * 1.02, M.metal,
          x + dx * sv * s, yb + hgt * 0.01, z + dz * sv * s, ry, 0.5);
      }
    } else if (kind < 0.66) {
      // 開梱。蓋を外して側面へ立てかけ、中の梱包材を覗かせる
      boxT(s * 0.97, t * 0.9, s * 0.92, M.wood,
        x + dx * (s * 0.62), yb + hgt * 0.44, z + dz * (s * 0.62),
        ry + (h2(sd, 3, 137) - 0.5) * 0.6, 0, 1.25, 0.9, false);
      boxD(s * 0.86, 0.05, s * 0.86, M.sandbag, x, yb + hgt - 0.09, z, ry, 0.7);
    } else if (kind < 0.86) {
      // 破損。側板が1枚割れて外れ、蓋が斜めに残っている
      boxT(s * 0.96, t * 0.85, s * 0.96, M.wood, x, yb + hgt - 0.02, z,
        ry, (h2(sd, 5, 139) - 0.5) * 0.34, 0.10, 0.9, false);
      boxT(s * 0.72, 0.045, s * 0.30, M.wood,
        x + dx * (s * 0.78) + px * (s * 0.2), 0.04 + yb, z + dz * (s * 0.78) + pz * (s * 0.2),
        ry + 0.5, 0, 0.06, 0.8, false);
      boxT(s * 0.5, 0.04, s * 0.26, M.wood,
        x - dx * (s * 0.7), 0.03 + yb, z - dz * (s * 0.7),
        ry - 0.9, 0, 0.04, 0.8, false);
    } else {
      // シート掛け。麻布を被せた個体。木目のプリントが1個も見えない箱が混ざると
      // 山全体が「同じアセットの複製」から抜ける
      boxD(s * 0.97, t * 0.85, s * 0.97, M.wood, x, yb + hgt - t * 0.85, z, ry, 0.9);
      boxT(s * 1.06, 0.045, s * 1.06, M.sandbag, x, yb + hgt + 0.03, z,
        ry + 0.08, 0.03, 0.02, 1.2, false);
      for (const sv of [-1, 1]) {
        boxT(s * 1.02, hgt * 0.52, 0.04, M.sandbag,
          x + px * sv * (s * 0.53), yb + hgt * 0.74, z + pz * sv * (s * 0.53),
          ry, 0, 0.05 * sv, 1.2, false);
      }
    }
  };

  // パレット。桟2本と甲板で1枚。積むと膝上の遮蔽になる
  const pallet = (x, yBottom, z, ry) => {
    box(1.25, 0.09, 1.05, M.wood, x, yBottom, z, ry, 0.7);
    box(1.25, 0.07, 0.16, M.wood, x, yBottom + 0.09, z - 0.4, ry, 0.7);
    box(1.25, 0.07, 0.16, M.wood, x, yBottom + 0.09, z + 0.4, ry, 0.7);
  };
  const palletStack = (x, z, ry, n = 4, y0 = 0) => {
    for (let i = 0; i < n; i++) {
      pallet(x + rr(-0.05, 0.05), y0 + i * 0.17, z + rr(-0.05, 0.05), ry + rr(-0.05, 0.05));
    }
    if (y0 < 0.1) mark(x, z, 1.3, 0.8);
  };

  // ドラム缶。素のシリンダー2本+水平線だと、中景のスカイラインが一気に安くなる。
  // ビードリング・リム・天板・バングまで入れて輪郭に情報を持たせる
  const drum = (x, z, mat) => {
    cyl(0.475, 1.15, 14, mat, x, 0, z, 3);
    for (const by of [0.3, 0.72]) cyl(0.5, 0.06, 12, mat, x, by, z, 3);
    cyl(0.5, 0.075, 12, M.metal, x, 1.07, z, 3);       // 上端のリムリング
    cyl(0.5, 0.075, 12, M.metal, x, 0, z, 3);
    cyl(0.455, 0.03, 12, M.metal, x, 1.145, z, 2);     // 天板
    cyl(0.07, 0.04, 6, M.metal, x + 0.25, 1.16, z + 0.1, 1);   // バング
    // ビードリングと天板の縁から下へ垂れる錆。等方のノイズでは絶対に出ない、
    // 「発生源があって重力で下へ流れた」形が入ると鉄が鉄に見える
    const a0 = hash3(x, 1.7, z) * 6.28;
    rustRunCyl(x, 1.06, z, 0.49, a0, 0.24, 0.86);
    rustRunCyl(x, 0.72, z, 0.50, a0 + 2.3, 0.18, 0.55);
    mark(x, z, 1.15, 0.95);
  };
  // 倒れたドラム缶。ひとつ転がっているだけで「使われていた場所」に見える
  const drumTipped = (x, z, ry, mat) => {
    cylLay(0.475, 1.15, 14, mat, x, 0.475, z, ry, 3);
    for (const s of [-0.3, 0.3]) {
      cylLay(0.5, 0.06, 12, mat, x + Math.cos(ry) * s, 0.475, z - Math.sin(ry) * s, ry, 3);
    }
    cylLay(0.5, 0.075, 12, M.metal, x + Math.cos(ry) * 0.56, 0.475, z - Math.sin(ry) * 0.56, ry, 3);
    cylLay(0.5, 0.075, 12, M.metal, x - Math.cos(ry) * 0.56, 0.475, z + Math.sin(ry) * 0.56, ry, 3);
    mark(x, z, 1.2, 0.9);
  };

  // 瓦礫の山。大小の欠片を傾けて積むだけだが、輪郭が不規則になるので効果が大きい
  // 瓦礫の山。大中小の3クラスに割る。1クラスしか無いと同じ比率の板が
  // 同じサイズ帯で撒かれるだけになり、大きな塊も細かい粉も鉄筋も出てこない。
  // 傾きは±0.12まで。大きく振ると半数が角を地面に突き刺して浮いて見える
  const rubble = (x, z, r, n, matList, scale = 1) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * r;
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      const fall = clamp(1 - d / (r * 1.6), 0.25, 1);
      const mat = matList[Math.floor(rnd() * matList.length)];
      const sd = Math.round(px * 17.3 + pz * 41.7 + i * 97);
      const cls = rnd();
      // 明度のジッタ。同じ材質でも割れた面と塗装面では値が違う
      const tint = 0.86 + rnd() * 0.30;
      if (cls < 0.16 && scale > 0.6) {
        // 大: 割れた躯体の塊。3割に折れた鉄筋を残す
        const s = rr(0.95, 1.7) * fall * scale;
        const g = chunkGeo(s * 1.15, s * 0.62, s * 0.92, 1.3, sd, 0.34);
        const yc = s * 0.27;
        emit(g, mat, px, yc, pz, rnd() * 3.14, rr(-0.12, 0.12), rr(-0.12, 0.12), true, true, tint);
        if (rnd() < 0.32) {
          const nb = 2 + Math.floor(rnd() * 2);
          for (let b = 0; b < nb; b++) {
            const ba = rnd() * 6.28, bl = rr(0.6, 1.4);
            emit(cylGeo(0.019, 0.019, bl, 4, 3, 1), M.metal,
              px + Math.cos(ba) * s * 0.35, yc + s * 0.2, pz + Math.sin(ba) * s * 0.35,
              ba, Math.PI / 2 - rr(0.2, 0.8), 0, false, true, 0.9);
          }
        }
        // 接地の暗がり。大物は足元に影が無いと地面に半分刺さった板に見える
        const gd = new THREE.PlaneGeometry(s * 2.6, s * 2.6);
        gd.rotateX(-Math.PI / 2);
        fxEmit(gd, grimeMat, px, 0.052, pz, rnd() * 3.14, 0, 0, 1);
      } else if (cls < 0.66) {
        // 中: 板状の破片。w/h/dを個別に振る
        const s = rr(0.35, 0.9) * fall * scale;
        const g = chunkGeo(s * rr(1.2, 2.0), s * rr(0.4, 0.8), s * rr(0.9, 1.6), 1.1, sd, 0.26);
        emit(g, mat, px, s * 0.28, pz, rnd() * 3.14, rr(-0.12, 0.12), rr(-0.12, 0.12), true, true, tint);
      } else {
        // 小: 面を伏せて置く。粉と欠片が無いと「割れた」出来事にならない
        const s = rr(0.06, 0.17) * scale;
        const g = chunkGeo(s * rr(1.4, 2.4), s * rr(0.5, 0.9), s * rr(1.1, 1.9), 0.5, sd, 0.36);
        emit(g, mat, px, s * 0.32, pz, rnd() * 3.14, rr(-0.09, 0.09), rr(-0.09, 0.09), false, true, tint);
      }
    }
    if (scale > 0.5) mark(x, z, r * 1.15, 0.9);
  };

  // 盛り土。衝突床が1枚の平面なので掘り下げは作れないが、盛り上げは物を置けば作れる。
  // 全部のプロップがy=0の同一平面に載っていると、遮蔽が「床に置かれた箱」だけになって
  // 空間が机の上のジオラマに見える。高さは0.8までに抑えて動線は切らない
  const berm = (x, z, ry, len, w, h) => {
    const dx = Math.cos(ry), dz = -Math.sin(ry);
    const n = Math.max(3, Math.round(len / 2.2));
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n;
      const t = 1 - Math.abs(f - 0.5) * 1.5;     // 端へ向かって痩せさせる（土手の裾）
      const u = (f - 0.5) * len;
      boxT((len / n) * 1.45, h * t, w * (0.6 + 0.4 * t), M.dirt,
        x + dx * u, h * t * 0.42, z + dz * u,
        ry + rr(-0.14, 0.14), rr(-0.06, 0.06), rr(-0.07, 0.07), 2.2);
      boxT((len / n) * 1.1, h * t * 0.6, w * 0.5, M.dirt,
        x + dx * u + rr(-0.3, 0.3), h * t * 0.78, z + dz * u + rr(-0.3, 0.3),
        ry + rr(-0.35, 0.35), rr(-0.1, 0.1), rr(-0.1, 0.1), 1.8);
    }
    mark(x, z, len * 0.3 + w * 0.7, 0.6, false);
  };

  // 骨材の散り。舗装の切れ目に必ず出る。境界線が読めなくなる効果が一番大きい
  const gravel = (x, z, r, n, matList) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * r;
      const s = rr(0.07, 0.24);
      const mat = matList[Math.floor(rnd() * matList.length)];
      const px = x + Math.cos(a) * d, pz = z + Math.sin(a) * d;
      // 面を伏せて置く。角を突き刺すと石が浮いて見える
      emit(chunkGeo(s * rr(1.3, 2.1), s * rr(0.4, 0.7), s * rr(1.0, 1.6), 0.7,
        Math.round(px * 53.1 + pz * 71.7 + i), 0.38), mat,
        px, s * 0.22, pz, rnd() * 3.14, rr(-0.12, 0.12), rr(-0.12, 0.12), false,
        true, 0.84 + rnd() * 0.32);
    }
  };

  // 室外機。壁にも屋上にも置く。ルーバーが1枚あるだけで縮尺が伝わる
  const acUnit = (x, yBottom, z, ry) => {
    box(1.0, 0.78, 0.44, M.metal, x, yBottom, z, ry, 1.0);
    box(0.74, 0.54, 0.06, M.rust, x + Math.sin(ry) * 0.24, yBottom + 0.12, z + Math.cos(ry) * 0.24, ry, 0.6);
    box(1.06, 0.07, 0.5, M.metal, x, yBottom + 0.78, z, ry, 1.0);
  };

  // 配電盤。壁際に立てて上から電線管を引き上げる
  const cabinet = (x, z, ry, mat = M.rust) => {
    box(0.78, 1.25, 0.36, mat, x, 0.12, z, ry, 1.0);
    box(0.86, 0.08, 0.44, mat, x, 1.37, z, ry, 1.0);
    box(0.7, 0.12, 0.06, M.metal, x, 0.12, z, ry, 0.5);
    cyl(0.07, 2.4, 6, M.metal, x - 0.3, 1.45, z, 2, false);
    cyl(0.07, 2.4, 6, M.metal, x + 0.3, 1.45, z, 2, false);
    mark(x, z, 1.2, 0.8);
  };

  // 壁付けの投光器。夕方の低い光に灯りが1点入るとスケールと時間帯が伝わる
  const floodLight = (x, y, z, ry, tilt = 0.5) => {
    const dx = Math.sin(ry), dz = Math.cos(ry);
    boxD(0.16, 0.16, 0.42, M.rust, x, y, z, ry, 0.6);
    boxD(0.52, 0.34, 0.22, M.rust, x + dx * 0.42, y - 0.1, z + dz * 0.42, ry, 0.6);
    emit(new THREE.PlaneGeometry(0.42, 0.26), lampMat,
      x + dx * 0.54, y + 0.07, z + dz * 0.54, ry, tilt, 0, false);
  };

  // 消火栓。膝より低い赤い物が1つあるだけで縮尺の基準になるし、
  // 「人が管理していた施設」という読みが一気に立つ
  const hydrant = (x, z, ry) => {
    cyl(0.36, 0.12, 8, M.concreteDark, x, 0, z, 1);
    cyl(0.16, 0.62, 8, M.metalRed, x, 0.12, z, 1);
    cyl(0.21, 0.09, 8, M.metalRed, x, 0.74, z, 1);
    cyl(0.11, 0.13, 6, M.metalRed, x, 0.83, z, 1);
    for (const s of [-1, 1]) {
      cylLay(0.09, 0.24, 6, M.rust, x + Math.cos(ry) * s * 0.2, 0.5, z - Math.sin(ry) * s * 0.2, ry, 1, false);
    }
    mark(x, z, 1.0, 0.7);
  };

  // 電力量計。平らな壁面に小さい影を落とす物が増えるほど面が死ににくくなる
  const meterBox = (x, y, z, ry) => {
    const nx = Math.sin(ry), nz = Math.cos(ry);
    boxD(0.5, 0.66, 0.18, M.metal, x, y, z, ry, 0.6);
    boxD(0.58, 0.06, 0.24, M.rust, x, y + 0.66, z, ry, 0.4);
    boxD(0.2, 0.24, 0.05, glassMat, x + nx * 0.11, y + 0.3, z + nz * 0.11, ry, 0.3);
    cyl(0.05, 1.6, 6, M.metal, x, y + 0.72, z, 2, false);
  };

  // 屋上のダクト。架台で持ち上げて端に送風機を載せる
  const ductRun = (x, yBottom, z, ry, len) => {
    box(0.85, 0.7, len, M.metal, x, yBottom + 0.45, z, ry, 1.2);
    const dx = Math.sin(ry);
    const dz = Math.cos(ry);
    for (let i = 0; i < 3; i++) {
      const u = (i / 2 - 0.5) * (len - 1.2);
      box(0.6, 0.45, 0.6, M.metal, x + dx * u, yBottom, z + dz * u, ry, 1.0);
    }
    cyl(0.62, 0.75, 8, M.metal, x + dx * (len / 2 - 0.4), yBottom + 1.15, z + dz * (len / 2 - 0.4), 2);
    cyl(0.7, 0.12, 8, M.rust, x + dx * (len / 2 - 0.4), yBottom + 1.9, z + dz * (len / 2 - 0.4), 2);
  };

  // 貯水タンク。屋上の輪郭を作るのに一番効く部品
  const waterTank = (x, yBottom, z, r = 1.35, h = 2.3) => {
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.78;
      box(0.2, 0.85, 0.2, M.metal, x + Math.cos(a) * r * 0.72, yBottom, z + Math.sin(a) * r * 0.72, 0, 1.0);
    }
    cyl(r, h, 10, M.rust, x, yBottom + 0.85, z, 4);
    cyl(r + 0.08, 0.1, 10, M.metal, x, yBottom + 0.85 + h - 0.1, z, 4);
    cyl(0.14, 1.0, 6, M.metal, x + r * 0.6, yBottom + 0.2, z, 2);      // 給水管
    // 天端のリングの継ぎ目から下へ垂れる錆
    const wa = hash3(x, yBottom, z) * 6.28;
    for (const k of [0, 2.2, 4.3]) {
      rustRunCyl(x, yBottom + 0.85 + h - 0.16, z, r, wa + k, r * 0.28, h * 0.62);
    }
  };

  // アンテナ。細いので衝突には入れない（弾が空中で止まると理不尽になる）
  const antennaMast = (x, yBottom, z, h = 4.6) => {
    cyl(0.09, h, 6, M.metal, x, yBottom, z, 2, false);
    for (let i = 0; i < 3; i++) {
      boxD(0.9, 0.05, 0.05, M.metal, x, yBottom + h * (0.45 + i * 0.16), z, i * 0.7, 0.6);
    }
    const dish = new THREE.SphereGeometry(0.62, 7, 3, 0, Math.PI * 2, 0, Math.PI / 2.4);
    emit(dish, M.metal, x, yBottom + h * 0.62, z, 0, 1.15, 0, false);
  };

  // 壁付けの梯子。実際の動線は階段と段差で確保してあるので、登れはしない。
  // ただし縦の2本のレールだけは衝突ありにする（box）。以前は見た目ごと
  // 非衝突(boxD)で、登れないだけでなく体がそのまま突き抜けられた。
  // 段(踏みざん)は非衝突のまま（0.46m間隔で全部当たり判定に入れると、
  // 外階段の踏面と同じ形で乗り越え処理が段の数だけ余分に走る）
  const ladder = (x, yBottom, z, h, ry) => {
    const dx = Math.cos(ry);
    const dz = -Math.sin(ry);
    for (const s of [-0.24, 0.24]) {
      box(0.07, h, 0.07, M.metal, x + dx * s, yBottom, z + dz * s, ry, 0.6);
      box(0.07, 1.1, 0.07, M.metal, x + dx * s, yBottom + h, z + dz * s, ry, 0.6);
    }
    for (let i = 0; i * 0.46 < h; i++) {
      boxD(0.55, 0.05, 0.05, M.metal, x, yBottom + 0.2 + i * 0.46, z, ry, 0.5);
    }
  };

  // 雨樋。軒の横引きと縦樋。細いので飾り扱い
  const gutter = (len, x, y, z, ry) => boxD(len, 0.16, 0.18, M.metal, x, y, z, ry, 1.0);
  const downpipe = (x, yBottom, z, h) => cyl(0.1, h, 6, M.metal, x, yBottom, z, 2, false);

  // 看板。錆びた枠に板を張っただけ。高い位置の物は飾り扱い。
  // faceに文字入りの材質を渡すと表面へ1枚貼る。無地の白い板だと
  // 「ここが何の施設で誰が使っていたか」が画から一切読めない
  const sign = (w, h, x, yBottom, z, ry, mat = M.rust, solid = false, face = null) => {
    const f = solid ? box : boxD;
    f(w, h, 0.12, mat, x, yBottom, z, ry, 1.6);
    f(w + 0.16, 0.12, 0.2, M.metal, x, yBottom + h, z, ry, 0.8);
    f(w + 0.16, 0.12, 0.2, M.metal, x, yBottom - 0.12, z, ry, 0.8);
    if (face) {
      emit(new THREE.PlaneGeometry(w - 0.1, h - 0.1), face,
        x + Math.sin(ry) * 0.07, yBottom + h / 2, z + Math.cos(ry) * 0.07, ry, 0, 0, false, false);
    }
  };
  const signMats = new Map();
  const signFace = (title, sub, bg, fg, seed) => {
    const key = title + '|' + sub;
    let m = signMats.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        map: signTexture(title, sub, bg, fg, seed),
        roughness: 0.72, metalness: 0.08, vertexColors: true,
      });
      signMats.set(key, m);
    }
    return m;
  };

  // 配管の横引き。サドルで持ち上げて壁沿いに走らせる
  const pipeRun = (len, r, x, y, z, ry, mat = M.rust, solid = true) => {
    cylLay(r, len, 8, mat, x, y, z, ry, 4, solid);
    cylLay(r + 0.05, 0.16, 6, M.metal, x + Math.cos(ry) * len * 0.3, y, z - Math.sin(ry) * len * 0.3, ry, 1, solid);
    cylLay(r + 0.05, 0.16, 6, M.metal, x - Math.cos(ry) * len * 0.3, y, z + Math.sin(ry) * len * 0.3, ry, 1, solid);
  };

  // 電線。垂れ下がりをチューブで描く。中点基準で作らないと区画分けが中央に寄る
  const wire = (x0, y0, z0, x1, y1, z1, sag = 0.9) => {
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
    const curve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(x0 - mx, y0 - my, z0 - mz),
      new THREE.Vector3(0, -sag, 0),
      new THREE.Vector3(x1 - mx, y1 - my, z1 - mz),
    ]);
    emit(new THREE.TubeGeometry(curve, 8, 0.045, 4, false), M.metal, mx, my, mz, 0, 0, 0, false);
  };

  // 電柱。腕木は電線の走る向きと直交させる（ryで振る）
  const utilityPole = (x, z, h = 8.4, ry = 0) => {
    cyl(0.19, h, 8, M.concrete, x, 0, z, 3);
    boxD(2.6, 0.16, 0.16, M.wood, x, h - 0.9, z, ry, 1.0);
    boxD(2.0, 0.14, 0.14, M.wood, x, h - 1.7, z, ry, 1.0);
    for (const s of [-1.15, 0, 1.15]) {
      boxD(0.12, 0.26, 0.12, M.metal, x + Math.cos(ry) * s, h - 0.74, z - Math.sin(ry) * s, ry, 0.5);
    }
    box(0.6, 0.9, 0.32, M.rust, x + Math.sin(ry) * 0.28, 1.6, z + Math.cos(ry) * 0.28, ry, 0.9);  // 変圧器
    mark(x, z, 1.1, 0.7);
  };

  // 有刺鉄線のコイル。輪を並べるだけ。細いが遮蔽としては効かせたいので衝突に入れる
  const wireCoil = (x, z, ry, n = 5) => {
    for (let i = 0; i < n; i++) {
      const geo = new THREE.TorusGeometry(0.52, 0.05, 3, 9);
      emit(geo, M.metal, x + Math.cos(ry) * (i - (n - 1) / 2) * 0.42, 0.5,
        z - Math.sin(ry) * (i - (n - 1) / 2) * 0.42, ry + Math.PI / 2, 0, 0);
    }
  };

  // ケーブルドラム（電線の木製リール）。円盤2枚と芯だけ
  const cableSpool = (x, z, ry) => {
    cylLay(0.85, 0.12, 10, M.wood, x, 0.85, z, ry, 2);
    cylLay(0.85, 0.12, 10, M.wood, x + Math.cos(ry) * 0.7, 0.85, z - Math.sin(ry) * 0.7, ry, 2);
    cylLay(0.55, 0.7, 8, M.metal, x + Math.cos(ry) * 0.35, 0.85, z - Math.sin(ry) * 0.35, ry, 3);
    mark(x + Math.cos(ry) * 0.35, z - Math.sin(ry) * 0.35, 1.4, 0.85);
  };

  /* 路面の貼り分け板の予約と、影を落とさせない材質の集まり。
     結合と出力(flush)がmapIdに関係なく参照するので、if/elseの外に置く。
     板は「置いた物の足跡」が全部出揃ってから作りたいので、生成は最後にまとめて回す。
     影を落とさせないのは、路面の貼り分け板が床から数cm浮いているだけで、
     影を落とすと広場一面に自己遮蔽の縞が出るため（材質をclone()するので名指しできる） */
  const patchJobs = [];
  const noShadowMats = new Set();
  const patch = (w, d, mat, x, z, ry, y, uv = 6, order = 1) =>
    patchJobs.push({ w, d, mat, x, z, ry, y, uv, order });

  /* ------------------------------------------------ 路面の貼り分け（板） */
  // 灰色一色だと広場が死ぬので舗装と土を敷き分ける。ただし不透明な板をそのまま
  // 浮かせると、ポリゴンの辺がそのまま素材の境界になって定規で引いた直線が横切る。
  // alphaMapで外周をfbmに食い破らせ、頂点カラーで隅と物の足元を焼いて沈める。
  // 板は「置いた物の足跡」が全部出揃ってから作りたいので、生成は最後にまとめて回す
  let patchSeed = 3301;
  const buildPatch = ({ w, d, mat, x, z, ry, y, uv, order }) => {
    const seg = clamp(Math.round(Math.max(w, d) / 1.5), 10, 30);
    const geo = new THREE.PlaneGeometry(w, d, seg, seg);
    geo.rotateX(-Math.PI / 2);
    scaleUV(geo, uv, uv);
    // 頂点カラーの焼き込み。壁際に汚れが溜まり隅が暗くなるのは実在のヤードでは必ず起きる
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    const ca = Math.cos(ry), sa = Math.sin(ry);
    for (let i = 0; i < pos.count; i++) {
      const lx = pos.getX(i), lz = pos.getZ(i);
      const wx = x + lx * ca + lz * sa;
      const wz = z - lx * sa + lz * ca;
      let ao = 1;
      for (let k = 0; k < marks.length; k++) {
        const mk = marks[k];
        const dx = wx - mk.x, dz = wz - mk.z;
        const dist = Math.sqrt(dx * dx + dz * dz);
        if (dist >= mk.r) continue;
        const t = 1 - dist / mk.r;
        ao *= 1 - mk.s * 0.5 * t * t;
      }
      // 板の縁。alphaが抜けきる手前で一段沈めると、砂利が溜まった継ぎ目に見える
      const eu = Math.min(0.5 - Math.abs(lx) / w, 0.5 - Math.abs(lz) / d) * 2;
      ao *= 0.66 + 0.34 * sstep(0.0, 0.22, eu);
      // 人が通る導線は磨り減って明るくなる。ムラの向きを板の目地と揃えない
      ao *= 0.93 + 0.16 * fbm2(wx * 0.035, wz * 0.035, 1.0, 3, 5501);
      ao = clamp(ao, 0.38, 1.12);
      col[i * 3] = ao; col[i * 3 + 1] = ao; col[i * 3 + 2] = ao;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

    const pm = mat.clone();
    pm.userData = {};
    pm.vertexColors = true;
    pm.transparent = true;
    pm.depthWrite = false;
    pm.polygonOffset = true;
    pm.polygonOffsetFactor = -2;
    pm.polygonOffsetUnits = -4;
    const mask = patchMaskTexture(patchSeed);
    patchSeed = (Math.imul(patchSeed, 1103515245) + 12345) >>> 0;
    // ジオメトリのUVは0..uvまで伸ばしてあるので、マスク側を1/uvに縮めて板一枚に合わせる
    mask.repeat.set(1 / uv, 1 / uv);
    pm.alphaMap = mask;
    addMacroVariation(pm, 0.85, 0.06, 0.13);
    // 貼り分けの板も同じ材質を数十回タイリングするので、地面と同じ混合層を掛ける。
    // これが無いと、格子が消えた素地の上に格子の残った板が浮くことになる
    addGroundBlend(pm, 0.29, 0.05, mat === M.dirt ? 0.78 : 0.58);
    // 重なる板どうしで前後がちらつかないよう、上に乗せる板は描画順を明示する
    renderOrders.set(pm, order);
    // 床から数cm浮いた板に影を落とさせない（宣言はnoShadowMatsの定義コメント）
    noShadowMats.add(pm);
    emit(geo, pm, x, y, z, ry, 0, 0, false, false);
  };
  if (mapId === 'edo') {
  /* ================================================================
     江戸ステージ。市街地(urban)とは別に手書きする（CLAUDE.mdの方針通り、
     データ駆動化はしない）。共通なのはここまでの部品(box等)と、この
     if/elseの外にある結合・Octree構築・スポーン登録の型だけ。
     中身の配置・材質選びは市街地と完全に独立している。
     ================================================================ */

  /* ------------------------------------------------------------ 地面 */
  // 市街地と同じ組み方（見た目は420m角・当たり判定は96m角の別板）。
  // 材質だけ叩き土(M.earth)へ差し替える
  const groundGeoE = new THREE.PlaneGeometry(420, 420, 48, 48);
  groundGeoE.rotateX(-Math.PI / 2);
  scaleUV(groundGeoE, 105, 105);
  {
    const gp = groundGeoE.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      const gx = gp.getX(i), gz = gp.getZ(i);
      const dd = Math.hypot(gx, gz);
      const k = sstep(50, 130, dd);
      if (k <= 0) continue;
      const n = fbm2(gx * 0.012, gz * 0.012, 1.0, 4, 5231) - 0.5;
      gp.setY(i, n * 9.0 * k);
    }
    groundGeoE.computeVertexNormals();
    const gc = new Float32Array(gp.count * 3);
    for (let i = 0; i < gp.count; i++) {
      const v = 0.86 + 0.26 * fbm2(gp.getX(i) * 0.014, gp.getZ(i) * 0.014, 1.0, 4, 9137);
      gc[i * 3] = v; gc[i * 3 + 1] = v; gc[i * 3 + 2] = v;
    }
    groundGeoE.setAttribute('color', new THREE.BufferAttribute(gc, 3));
  }
  const groundE = new THREE.Mesh(groundGeoE, M.earth);
  groundE.receiveShadow = true;
  root.add(groundE);

  const floorGeoE = new THREE.PlaneGeometry(96, 96, 8, 8);
  floorGeoE.rotateX(-Math.PI / 2);
  {
    const fc = new Float32Array(floorGeoE.attributes.position.count * 3);
    fc.fill(1);
    floorGeoE.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  }
  const floorE = new THREE.Mesh(floorGeoE, M.earth);
  floorE.visible = false;
  solids.add(floorE);

  /* -------------------------------------------------------- 建物の型 */

  /* 切妻の瓦屋根。**ここが江戸に見えるかどうかの分かれ目。**
     前は平らな板を1枚載せていて、実際に遊んだ画を見ると
     「砂漠に置いた木の箱」にしか見えなかった。日本家屋の輪郭は
     ほとんど屋根が作っているので、勾配・軒の出・棟・破風を全部入れる。

     pitch は「奥行きの半分に対する高さの比」。0.5で約27度、
     日本の瓦屋根としてはこのあたりが素直（急にすると寺、緩くすると倉庫に見える）。
     ryで棟の向きを振る（0なら棟が東西＝X方向に走る） */
  const gableRoof = (cx, cz, w, d, yEave, pitch, ry = 0, over = 0.55, mat = M.kawara) => {
    const halfD = d / 2 + over;
    const rise = halfD * pitch;
    const slope = Math.hypot(halfD, rise);
    const ang = Math.atan2(rise, halfD);
    const wOver = w + over * 2;
    const cs = Math.cos(ry), sn = Math.sin(ry);
    // ローカル(dx,dz)を棟の向きへ回して世界へ置く小道具
    const put = (fn, dx, dz, ...rest) => fn(cx + dx * cs + dz * sn, cz - dx * sn + dz * cs, ...rest);

    for (const s of [-1, 1]) {
      // 傾けた板。中心は軒と棟の中点
      const my = yEave + rise / 2;
      const mz = s * halfD / 2;
      put((x, z) => boxT(wOver, 0.16, slope, mat, x, my, z, ry, s * ang, 0, 1.8, false), 0, mz);
      /* 軒先の瓦（万十軒瓦）。屋根の縁に一段太い列を回すと、
         斜めの板が「屋根」になる。無いと段ボールを立てかけた形のまま */
      put((x, z) => boxT(wOver + 0.06, 0.13, 0.20, M.kawara, x, yEave + 0.03, z, ry, s * ang, 0, 1.0, false),
        0, s * halfD);
    }
    // 棟（むね）。屋根のてっぺんを一段高く太らせる
    put((x, z) => boxT(wOver, 0.26, 0.34, M.kawara, x, yEave + rise + 0.10, z, ry, 0, 0, 1.0, false), 0, 0);
    /* 破風板（はふいた）。妻側の三角の縁に白い板を回す。
       ここが抜けていると、横から見た時に瓦の断面がそのまま出て板厚が見える */
    for (const s of [-1, 1]) {
      const hx = s * (w / 2 + over);
      for (const t of [-1, 1]) {
        put((x, z) => boxT(0.10, 0.16, slope, M.shikkui, x, yEave + rise / 2 + 0.10, z, ry, t * ang, 0, 1.0, false),
          hx, t * halfD / 2);
      }
    }
    mark(cx, cz, Math.max(w, d) * 0.55, 0.85);
  };

  /* 庇（ひさし）。1階の前面に張り出す小さな片流れの屋根。
     町屋の顔はここで決まる（軒下の暗がりが、平らな壁に奥行きを作る） */
  const eave = (cx, cz, w, y, ry, depth = 1.1) => {
    const cs = Math.cos(ry), sn = Math.sin(ry);
    const px = cx - sn * depth / 2, pz = cz - cs * depth / 2;
    boxT(w, 0.10, depth * 1.06, M.kawara, px, y + 0.10, pz, ry, 0.22, 0, 1.4, false);
    // 腕木（うでぎ）。庇を支える横木。これが無いと板が宙に浮く
    for (const u of [-w / 2 + 0.35, 0, w / 2 - 0.35]) {
      boxT(0.09, 0.09, depth * 0.9, M.timber,
        cx + u * cs - sn * depth * 0.45, y - 0.08, cz - u * sn - cs * depth * 0.45, ry, 0, 0, 1.0, false);
    }
  };

  /* 格子（こうし）。町屋の1階の前面。細い縦棒を並べるだけだが、
     **平らな板の壁に「建物の正面」という情報を入れる一番安い手** */
  const lattice = (cx, cz, w, y, h, ry) => {
    const cs = Math.cos(ry), sn = Math.sin(ry);
    const n = Math.max(3, Math.round(w / 0.28));
    for (let i = 0; i <= n; i++) {
      const u = (i / n - 0.5) * w;
      boxT(0.055, h, 0.05, M.timber, cx + u * cs, y + h / 2, cz - u * sn, ry, 0, 0, 1.0, false);
    }
    // 上下の横桟
    for (const yy of [y + 0.02, y + h - 0.02]) {
      boxT(w, 0.07, 0.06, M.timber, cx, yy, cz, ry, 0, 0, 1.0, false);
    }
  };

  // 暖簾（のれん）。入口の上に垂らす布。朱の材質を借りる（布の材質は持っていない）
  const noren = (cx, cz, w, y, ry) => {
    boxT(w, 0.52, 0.03, M.urushi, cx, y - 0.26, cz, ry, 0, 0, 1.2, false);
    boxT(w + 0.1, 0.07, 0.07, M.timber, cx, y + 0.02, cz, ry, 0, 0, 1.0, false);
  };

  /* 提灯（ちょうちん）。**これが一番「江戸」を出す。**

     町並みの形をどれだけ作り込んでも、灯りが1点も無いと
     「昼の土壁の集落」で終わる。逆に軒下に橙の点が並ぶだけで、
     同じ地形が宿場町になる。

     光る面なので当たり判定には入れない（人が引っかかると邪魔なだけ）。
     竹の輪は入れない——0.4mの物に輪を6本足すと、20個で120枚増える。
     **胴の紙と上下の口輪だけ**で、その距離では形が読める */
  const chochin = (x, y, z, r = 0.17, h = 0.42) => {
    // 胴。上下をわずかに絞ると、円筒ではなく提灯の膨らみに見える
    emit(cylGeo(r, r * 0.72, h, 8, 1), M.lantern, x, y, z, 0, 0, 0, false, true, 1.0);
    // 上下の口輪（木の輪）と、吊るす紐
    cyl(r * 0.74, 0.045, 8, M.timber, x, y + h / 2, z, 1.0, false);
    cyl(r * 0.74, 0.045, 8, M.timber, x, y - h / 2 - 0.045, z, 1.0, false);
    boxD(0.025, 0.16, 0.025, M.timber, x, y + h / 2 + 0.10, z, 0, 1.0);
  };

  /* 町屋。**この1つを並べて通りを作る。**
     妻入り/平入りはryで振る。doorsはband()と同じ書式で、
     face（正面）の側にだけ庇・格子・暖簾を足す */
  const machiya = (cx, cz, w, d, h, ry, face = 'z-', doorW = 2.2) => {
    // 壁。土台は板張り、上は漆喰にして2色にする（1色だと巨大な木箱に戻る）
    const doors = [{ side: face, u: 0, w: doorW }];
    band(w, d, 1.5, 0.16, M.timber, cx, 0, cz, 1.6, doors);
    band(w, d, h - 1.5, 0.16, M.shikkui, cx, 1.5, cz, 1.6, doors);
    // 柱。角と中間に見せ柱を立てると、漆喰の面が板で仕切られて日本家屋になる
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        boxT(0.16, h, 0.16, M.timber, cx + su * (w / 2 - 0.08), h / 2, cz + sv * (d / 2 - 0.08), 0, 0, 0, 1.0, false);
      }
    }
    // 貫（ぬき）。胴回りの横木。**壁と同じ場所なので当たり判定には入れない**
    band(w + 0.03, d + 0.03, 0.11, 0.05, M.timber, cx, 1.44, cz, 1.0, [], false);
    gableRoof(cx, cz, w, d, h, 0.52, ry);

    // 正面の造作。faceがどちらを向いているかで、庇と格子の場所が決まる
    const fz = face === 'z-' ? -1 : face === 'z+' ? 1 : 0;
    const fx = face === 'x-' ? -1 : face === 'x+' ? 1 : 0;
    const fw = fz !== 0 ? w : d;
    const px = cx + fx * (w / 2), pz = cz + fz * (d / 2);
    const fry = fz !== 0 ? (fz < 0 ? 0 : Math.PI) : (fx < 0 ? -Math.PI / 2 : Math.PI / 2);
    eave(px, pz, fw + 0.3, 2.05, fry, 1.15);
    // 入口の左右にだけ格子を入れる（入口の上に格子を張ると通れないように見える）
    const side = (fw - doorW) / 2 - 0.25;
    if (side > 0.4) {
      for (const s of [-1, 1]) {
        const u = s * (doorW / 2 + 0.12 + side / 2);
        lattice(px + u * Math.cos(fry), pz - u * Math.sin(fry), side, 0.35, 1.35, fry);
      }
    }
    noren(px, pz, doorW * 0.92, 2.0, fry);
    /* 軒提灯。**入口の脇に1つ。**庇の下（＝暗がりの中）に置くので、
       橙の点が軒の影から浮いて、通りに沿って灯りの列ができる。
       壁から0.3m離す（面に貼り付くと、ただの光る染みに見える） */
    {
      const u = fw / 2 - 0.55;
      const outX = -Math.sin(fry) * 0.34, outZ = -Math.cos(fry) * 0.34;
      chochin(px + u * Math.cos(fry) + outX, 1.98, pz - u * Math.sin(fry) + outZ);
    }
    mark(cx, cz, Math.max(w, d) * 0.6, 0.9);
  };

  /* 蔵（くら）。白漆喰のずんぐりした倉。**目印になる。**
     町屋より背が高くて色が違うので、通りのどこに居るかがこれで分かる */
  const kura = (cx, cz, ry) => {
    const w = 6.4, d = 5.2, h = 4.4;
    band(w, d, h, 0.28, M.shikkui, cx, 0, cz, 1.4, [{ side: 'z-', u: 0, w: 1.9 }]);
    /* 腰の海鼠壁（なまこ壁）。**黒い瓦を並べて目地を白く盛る壁。**
       ここは市街地の西洋レンガ(M.brick)を貼っていた。形だけ和物にして
       表面が近代の資材、という抜け方をしていた所。黒瓦にすると、
       上の白漆喰との対比がそのまま蔵の見た目になる。
       **壁の上に貼る飾りなので当たり判定には入れない** */
    band(w + 0.04, d + 0.04, 1.5, 0.06, M.kawara, cx, 0, cz, 2.4, [], false);
    gableRoof(cx, cz, w, d, h, 0.56, ry, 0.75);
    /* 観音扉。**片方を開けて、両方とも当たり判定に入れる。**

       ここは2枚とも solid=false で、しかも2枚合わせて幅1.95mが
       band()の開けた1.9mの開口を完全に塞いでいた。つまり
       **閉まって見えるのにすり抜けられる。** issue #57で
       「板打ちだけは閉じている絵と挙動が食い違う」として直したのと同じ形。

       塞いで解決にしない。蔵は通りの角に建っていて、中へ逃げ込めると
       遮蔽として意味が出る。片方を90度開いた形で立てれば、
       絵と挙動が合ったうえで幅0.95mの入口が残る（人の半径は0.35m） */
    // 閉まっている側（右）。壁と同じ面に立てて、当たり判定に入れる
    boxT(0.95, 2.2, 0.14, M.timber, cx + 0.5, 1.1, cz - d / 2 - 0.06, 0, 0, 0, 1.2, true);
    // 開いている側（左）。蝶番の所で外向きに90度振る
    boxT(0.14, 2.2, 0.95, M.timber, cx - 0.95, 1.1, cz - d / 2 - 0.52, 0, 0, 0, 1.2, true);
    mark(cx, cz, 4.2, 0.9);
  };

  /* 鳥居。**朱漆(M.urushi)で塗る。**
     2026-08-17まで、朱を持っていなかったので市街地の塗装鉄板に赤を掛けていた。
     materialのcolorはmapへの乗算なので、元が暗いと結果も暗くなる。
     実測すると出力の輝度は0.0079——本物の朱(0.2103)の1/26.6で、
     マップで唯一の差し色が遠目には黒い柱になっていた。
     今の朱は実測0.2055（src/world/textures.jsのurushi）。
     笠木を島木と2段にして、左右を少し跳ね上げると（反り）鳥居の形になる。
     1本の横棒だとサッカーゴールに見える */
  const torii = (x, z, ry, w = 4.6, h = 3.6) => {
    const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
    for (const s of [-1, 1]) {
      // 柱は上へ行くほど細い。まっすぐの円柱だと配管に見える
      emit(cylGeo(0.15, 0.19, h, 10, 2), M.urushi,
        x + dirX * s * w / 2, h / 2, z + dirZ * s * w / 2, 0, 0, 0, true);
      // 亀腹（柱の根元の石）
      cyl(0.26, 0.16, 10, M.stone, x + dirX * s * w / 2, 0, z + dirZ * s * w / 2, 2, false);
    }
    // 貫（ぬき）。柱を横に貫く角材。両端が柱から少し出るのが鳥居の形
    boxD(w + 0.5, 0.20, 0.20, M.urushi, x, h - 1.05, z, ry, 1.2);
    // 額束（がくづか）。貫と島木の間の短い縦材
    boxD(0.24, 0.72, 0.16, M.urushi, x, h - 0.85, z, ry, 1.0);
    // 島木と笠木。2段にして、笠木を少し広く
    boxD(w + 0.9, 0.20, 0.30, M.urushi, x, h - 0.22, z, ry, 1.2);
    boxD(w + 1.3, 0.17, 0.24, M.urushi, x, h, z, ry, 1.2);
    // 反り。両端に短い板を跳ね上げて置く
    for (const s of [-1, 1]) {
      boxT(0.5, 0.16, 0.24, M.urushi,
        x + dirX * s * (w / 2 + 0.72), h + 0.10, z + dirZ * s * (w / 2 + 0.72), ry, 0, s * 0.22, 1.0, false);
    }
    mark(x, z, w * 0.5, 0.5);
  };

  /* 石灯籠。竿・中台・火袋・笠を積む。**火袋に火を入れる。**
     ここは全部同じ石で組んでいたので、名前は灯籠なのに一度も光っていなかった。
     火袋（4段目）だけ光る材質にすると、参道に沿って腰の高さの灯りが並ぶ */
  const lantern = (x, z) => {
    cyl(0.16, 0.30, 8, M.stone, x, 0, z, 2);       // 基礎
    cyl(0.11, 0.62, 8, M.stone, x, 0.30, z, 2);    // 竿
    box(0.44, 0.10, 0.44, M.stone, x, 0.92, z, 0, 1.4);
    // 火袋の石枠。中の紙が見えるよう、一回り小さい光る箱を内側へ入れる
    box(0.30, 0.36, 0.30, M.stone, x, 1.02, z, 0, 1.2);
    boxD(0.24, 0.28, 0.24, M.lantern, x, 1.06, z, 0, 1.0);
    box(0.56, 0.12, 0.56, M.kawara, x, 1.38, z, Math.PI / 4, 1.4);
    box(0.14, 0.16, 0.14, M.stone, x, 1.50, z, Math.PI / 4, 1.0);  // 宝珠
    mark(x, z, 0.6, 0.6);
  };

  // 酒樽の山
  const barrelStack = (x, z, ry) => {
    for (let i = 0; i < 3; i++) {
      const a = ry + i * (Math.PI * 2 / 3);
      cyl(0.32, 0.62, 10, M.wood, x + Math.cos(a) * 0.30, 0, z + Math.sin(a) * 0.30, 1.6);
    }
    cyl(0.30, 0.58, 10, M.wood, x, 0.62, z, 1.6);
    mark(x, z, 1.1, 0.7);
  };

  /* 井戸。**通りの結節点に置く目印。**屋根付きにすると遠くからでも読める */
  const well = (x, z) => {
    cyl(0.85, 0.72, 12, M.stone, x, 0, z, 3);
    cyl(0.72, 0.10, 12, M.stone, x, 0.72, z, 3, false);
    for (const s of [-1, 1]) boxT(0.12, 1.7, 0.12, M.timber, x + s * 0.78, 0.85, z, 0, 0, 0, 1.0, false);
    boxT(0.14, 0.14, 1.9, M.timber, x, 1.66, z, 0, 0, Math.PI / 2, 1.0, false);
    gableRoof(x, z, 2.0, 1.4, 1.72, 0.5, Math.PI / 2, 0.3);
    mark(x, z, 1.5, 0.8);
  };

  // 積み俵（米俵の山）。胸の高さの遮蔽
  const rice = (x, z, ry) => {
    for (let r = 0; r < 2; r++) {
      const n = r === 0 ? 3 : 2;
      for (let i = 0; i < n; i++) {
        const u = (i - (n - 1) / 2) * 0.62;
        cylLay(0.28, 0.86, 9, M.sandbag,
          x + Math.cos(ry) * u, 0.28 + r * 0.5, z - Math.sin(ry) * u, ry + Math.PI / 2, 2);
      }
    }
    mark(x, z, 1.4, 0.8);
  };

  // 天水桶（防火用の水桶）。町屋の脇に必ず置いてある物
  const waterTub = (x, z) => {
    cyl(0.48, 0.86, 12, M.wood, x, 0, z, 2);
    cyl(0.50, 0.07, 12, M.metal, x, 0.30, z, 2, false);
    cyl(0.50, 0.07, 12, M.metal, x, 0.72, z, 2, false);
    mark(x, z, 0.8, 0.7);
  };

  // 材木置き場。丸太を積む
  const lumber = (x, z, ry) => {
    for (let r = 0; r < 3; r++) {
      const n = 3 - r;
      for (let i = 0; i < n; i++) {
        const u = (i - (n - 1) / 2) * 0.42;
        cylLay(0.19, 3.4, 8, M.timber,
          x - Math.sin(ry) * u, 0.19 + r * 0.36, z - Math.cos(ry) * u, ry, 4);
      }
    }
    mark(x, z, 2.0, 0.8);
  };

  // 縁台（店先の腰掛け）。低い遮蔽と、通りの生活感
  const bench = (x, z, ry) => {
    boxD(1.7, 0.10, 0.55, M.timber, x, 0.42, z, ry, 1.4);
    for (const s of [-1, 1]) {
      boxT(0.09, 0.42, 0.45, M.timber, x + Math.cos(ry) * s * 0.72, 0.21, z - Math.sin(ry) * s * 0.72, ry, 0, 0, 1.0, false);
    }
    mark(x, z, 1.1, 0.5);
  };

  // 竹垣。低い仕切り。通りと敷地の境目を作る
  const bambooFence = (cx, cz, ry, len, h = 1.25) => {
    const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
    box(len, h, 0.09, M.timber, cx, 0, cz, ry, 2.4);
    const n = Math.max(2, Math.round(len / 1.8));
    for (let i = 0; i <= n; i++) {
      const u = (i / n - 0.5) * len;
      box(0.13, h + 0.14, 0.13, M.timber, cx + dirX * u, 0, cz + dirZ * u, ry, 1.0);
    }
    // 上の押縁（横に回す竹）
    boxD(len, 0.08, 0.13, M.timber, cx, h + 0.03, cz, ry, 1.2);
  };

  // 板塀の1区間。gapUがあればそこだけ空ける（門）
  const fenceRun = (cx, cz, ry, len, h, gapU = null, gapW = 0) => {
    const segs = [];
    if (gapU === null) segs.push([-len / 2, len / 2]);
    else {
      const s = clamp(gapU - gapW / 2, -len / 2, len / 2);
      const e = clamp(gapU + gapW / 2, -len / 2, len / 2);
      if (s - (-len / 2) > 0.05) segs.push([-len / 2, s]);
      if (len / 2 - e > 0.05) segs.push([e, len / 2]);
    }
    const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
    for (const [a, b] of segs) {
      const w = b - a;
      if (w <= 0.05) continue;
      const u = (a + b) / 2;
      box(w, h, 0.12, M.timber, cx + dirX * u, 0, cz + dirZ * u, ry, 1.6);
      // 塀の上の瓦。塀の天端が板の切り口のままだと、書き割りの縁に見える
      boxD(w, 0.12, 0.34, M.kawara, cx + dirX * u, h, cz + dirZ * u, ry, 1.2);
    }
    const n = Math.max(2, Math.round(len / 2.4));
    for (let i = 0; i <= n; i++) {
      const u = (i / n - 0.5) * len;
      if (gapU !== null && Math.abs(u - gapU) < gapW / 2 + 0.15) continue;
      box(0.16, h + 0.10, 0.16, M.timber, cx + dirX * u, 0, cz + dirZ * u, ry, 1.0);
    }
  };

  /* -------------------------------------------------------- 外周と門 */
  const half = 34, fenceH = 2.6, gateW = 5.0;
  fenceRun(0, -half, 0, half * 2, fenceH, 0, gateW);
  fenceRun(0, half, 0, half * 2, fenceH, 0, gateW);
  fenceRun(-half, 0, Math.PI / 2, half * 2, fenceH, 0, gateW);
  fenceRun(half, 0, Math.PI / 2, half * 2, fenceH, 0, gateW);

  /* 門の屋根（棟門）。塀を切っただけだと「壁の穴」にしか見えない */
  const gate = (x, z, ry) => {
    const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
    for (const s of [-1, 1]) {
      box(0.32, 3.2, 0.32, M.timber, x + dirX * s * (gateW / 2 + 0.2), 0, z + dirZ * s * (gateW / 2 + 0.2), ry, 1.2);
    }
    boxD(gateW + 1.2, 0.26, 0.30, M.timber, x, 3.2, z, ry, 1.2);
    gableRoof(x, z, gateW + 1.6, 1.6, 3.46, 0.62, ry, 0.5);
    // 門提灯。**町の入口が一番大きい灯り。**遠くからでも「あそこが門だ」と分かる
    for (const s of [-1, 1]) {
      chochin(x + dirX * s * (gateW / 2 - 0.35), 2.62, z + dirZ * s * (gateW / 2 - 0.35), 0.24, 0.56);
    }
  };
  gate(0, -half, 0); gate(0, half, 0);
  gate(-half, 0, Math.PI / 2); gate(half, 0, Math.PI / 2);

  /* ------------------------------------------------------ 中央の境内 */
  /* 社（やしろ）。**市街地の中央の掩体と同じ役目**——奪い合いの中心。
     四方から入れて、中で撃ち合える。石段を1段付けて周囲より高くする */
  {
    /* 基壇（石の台）。**2段に積む。**
       前は11.4の台と12.4の台を両方 y=0 から立てていて、
       重なった所を歩くと押し戻す向きが2つできていた */
    box(12.4, 0.22, 12.4, M.stone, 0, 0, 0, 0, 3.0);
    box(11.4, 0.33, 11.4, M.stone, 0, 0.22, 0, 0, 3.0);
    // 社殿。四方に入口
    const doors = [
      { side: 'z-', u: 0, w: 2.6 }, { side: 'z+', u: 0, w: 2.6 },
      { side: 'x-', u: 0, w: 2.6 }, { side: 'x+', u: 0, w: 2.6 },
    ];
    band(9.0, 9.0, 3.2, 0.20, M.timber, 0, 0.55, 0, 1.6, doors);
    // 内側の柱。中が空洞の箱だと「屋根の付いた四角い部屋」で終わる
    for (const su of [-1, 1]) {
      for (const sv of [-1, 1]) {
        boxT(0.24, 3.2, 0.24, M.urushi, su * 3.1, 0.55 + 1.6, sv * 3.1, 0, 0, 0, 1.0, false);
      }
    }
    // 縁側（まわりの回り縁）と高欄
    band(10.6, 10.6, 0.16, 0.7, M.timber, 0, 0.55, 0, 1.6);
    for (const s of [-1, 1]) {
      boxD(10.6, 0.09, 0.09, M.urushi, 0, 1.18, s * 5.2, 0, 1.0);
      boxD(0.09, 0.09, 10.6, M.urushi, s * 5.2, 1.18, 0, 0, 1.0);
    }
    gableRoof(0, 0, 9.6, 9.6, 3.75, 0.60, 0, 1.10);
    // 千木（ちぎ）。屋根の上でX字に交わる木。**遠目のシルエットで社と分かる印**
    for (const s of [-1, 1]) {
      for (const t of [-1, 1]) {
        boxT(0.14, 2.0, 0.14, M.timber, s * 4.4, 7.0, t * 0.3, 0, t * 0.34, s * 0.26, 1.0, false);
      }
    }
    // 鰹木（かつおぎ）。棟の上に並ぶ丸太
    for (const u of [-2.4, -0.8, 0.8, 2.4]) {
      cylLay(0.16, 1.5, 8, M.timber, u, 6.68, 0, Math.PI / 2, 2, false);
    }
    mark(0, 0, 6.4, 1.0);
  }

  // 玉垣（境内をぐるりと囲む低い石柱の列）。四方の参道だけ空ける
  {
    const R = 15.5;
    for (const [ax, az, ry] of [[0, -R, 0], [0, R, 0], [-R, 0, Math.PI / 2], [R, 0, Math.PI / 2]]) {
      const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
      for (let i = -8; i <= 8; i++) {
        const u = i * 1.75;
        if (Math.abs(u) < 3.2) continue;      // 参道の口
        if (Math.abs(u) > R) continue;
        box(0.22, 1.05, 0.22, M.stone, ax + dirX * u, 0, az + dirZ * u, ry, 1.0);
      }
      // 笠石（柱の上を繋ぐ横石）
      for (const s of [-1, 1]) {
        boxD(R - 3.4, 0.13, 0.30, M.stone,
          ax + dirX * s * (R + 3.4) / 2, 1.05, az + dirZ * s * (R + 3.4) / 2, ry, 1.2);
      }
    }
  }

  // 四方の鳥居。参道の入口に立てる
  torii(0, -15.5, 0); torii(0, 15.5, Math.PI);
  torii(-15.5, 0, Math.PI / 2); torii(15.5, 0, -Math.PI / 2);

  // 参道の石灯籠。左右で対
  for (const s of [-1, 1]) {
    lantern(s * 2.4, -12.0); lantern(s * 2.4, 12.0);
    lantern(-12.0, s * 2.4); lantern(12.0, s * 2.4);
    lantern(s * 2.4, -18.5); lantern(s * 2.4, 18.5);
  }

  /* ---------------------------------------------------------- 町並み */
  /* **建物は「戦う輪」の外に置く。**

     最初はここを間違えて、通りを x=±21 / z=±21 に通し、その内側の列を
     ±15.8 に建てた。対戦の湧き地点は中心から11〜18mの環（±17.5と±12,±12）に
     並べてあるので、**建物が湧き地点の真上に来ていた。**
     実際に歩かせて測ると32通りのうち12通りが動けず、
       ・(0,-17.5) … 町屋の中（壁まで1.2m）
       ・(±12,±12) … 町屋2棟の角に挟まれた0.7mの隙間
     という状態だった。湧いた瞬間から壁に挟まって押し戻されるので、
     歩けないうえ画面が揺れる。

     直した形はこう。
       中心〜15.5m … 境内（社と玉垣。ここが奪い合いの中心）
       15.5〜23.2m … 環状の通り。**戦域(半径20m)はここまで建物ゼロ**
       23.2〜28.8m … 町屋の列。四方に4棟ずつ、正面を内側（通り）へ向ける
       28.8〜34m  … 裏通りと板塀

     tools/check-edo.mjs が「湧き地点から8方向へ実際に歩けるか」を測っている。
     目分量で建物を動かすと必ずまた踏むので、機械に歩かせて確かめる */
  const RING = 26;        // 町屋の列の中心（＝環状の通りの外側）
  const HOUSE_W = 7.2;    // 通りに面する側の幅
  const HOUSE_D = 5.6;    // 奥行き
  // 1辺あたりの並び。中心から±6と±18に置くと、間が4.8mの路地になる
  const ALONG = [-18, -6, 6, 18];

  // 南北（z=±RING）に面する列。正面は内側（境内側）
  for (const sz of [-1, 1]) {
    for (const cx of ALONG) {
      machiya(cx, sz * RING, HOUSE_W, HOUSE_D, 3.3, 0, sz < 0 ? 'z+' : 'z-', 2.2);
    }
  }
  // 東西（x=±RING）に面する列。棟の向きを90度振る
  for (const sx of [-1, 1]) {
    for (const cz of ALONG) {
      machiya(sx * RING, cz, HOUSE_D, HOUSE_W, 3.3, Math.PI / 2, sx < 0 ? 'x+' : 'x-', 2.2);
    }
  }

  // 四隅の蔵。町屋の列の切れ目に立てる目印
  kura(-29, -29, 0); kura(29, -29, 0);
  kura(-29, 29, Math.PI); kura(29, 29, Math.PI);

  /* ------------------------------------------------------------ 小物 */
  /* **環状の通り（15.5〜23.2m）に置く。** ここが撃ち合いの場所になるので、
     胸の高さの遮蔽を切らさない。ただし湧き地点(±17.5,0)(0,±17.5)(±12,±12)と
     その周りは空けておく——遮蔽で囲まれた所に湧くと、また同じ不具合になる */

  // 井戸。通りと参道が交わる4箇所…ではなく、その脇へ寄せる（参道は通す）
  well(-19.5, -19.5); well(19.5, 19.5);
  well(-19.5, 19.5); well(19.5, -19.5);

  // 店先まわり。町屋の正面（通りに面した側）に置く
  bench(-12, -22.6, 0); bench(12, 22.6, 0);
  bench(-22.6, 12, Math.PI / 2); bench(22.6, -12, Math.PI / 2);
  waterTub(-2.4, -22.4); waterTub(2.4, 22.4);
  waterTub(-22.4, 2.4); waterTub(22.4, -2.4);
  waterTub(-14.4, -22.4); waterTub(14.4, 22.4);

  // 胸の高さの遮蔽。通りに一直線の射線を残さない
  rice(-8.0, -18.5, 0.3); rice(8.0, 18.5, 0.3);
  rice(-18.5, 8.0, 1.2); rice(18.5, -8.0, 1.2);
  barrelStack(-22.2, -8.0, 0.4); barrelStack(22.2, 8.0, 0.4);
  barrelStack(-8.0, 22.2, 1.0); barrelStack(8.0, -22.2, 1.0);
  barrelStack(-16.0, -16.0, 0.7); barrelStack(16.0, 16.0, 0.7);
  lumber(-22.4, 16.5, 0.15); lumber(22.4, -16.5, 0.15);
  lumber(16.5, 22.4, Math.PI / 2 + 0.1); lumber(-16.5, -22.4, Math.PI / 2 + 0.1);
  /* **木箱(crate)は置かない。** あれは角に鋼の隅金物を8個付けて
     梱包バンドを2本掛ける近代の輸送箱で、江戸の通りに置くと時代錯誤。
     しかも4個とも戦域のすぐ外（半径21m前後）で、必ず目に入る場所だった。
     同じ高さの遮蔽は、この町が既に持っている物（酒樽と米俵）で作る */
  barrelStack(-21.0, 5.5, 0.3);
  barrelStack(21.0, -5.5, 0.9);
  rice(5.5, 21.0, 0.2);
  rice(-5.5, -21.0, 0.5);

  // 裏通りの竹垣。町屋の裏へ回った時に、抜け道が読めるようにする
  bambooFence(-12, -31.5, 0, 10, 1.3);
  bambooFence(12, 31.5, 0, 10, 1.3);
  bambooFence(-31.5, 12, Math.PI / 2, 10, 1.3);
  bambooFence(31.5, -12, Math.PI / 2, 10, 1.3);

  /* ------------------------------------------------------------ 場外の景 */
  /* **塀の外に何も無かった。**
     板塀(2.6m)の外は無地の土が地平線まで続いていて、見えるのは空だけ。
     山も寺も城も無いので、**この町が「どこかの町の一部」に見えない。**
     市街地の方は遠景の街・崩落壁・瓦礫の土手を持っていて、
     それが「広い場所の一角に居る」感じを作っている。江戸側にはそれが1行も無かった。

     全部当たり判定に入れない（届かない所に置く物なので）。
     板塀の天端(2.72m)より高い物だけを置く——低い物は塀に隠れて1ピクセルも見えない。
     **手前の戦いには一切関わらない**ので、形は粗くてよい */
  {
    // 山並み。町を囲む稜線。三角柱を重ねるだけだが、
    // 高さと距離をばらすと1枚の書き割りに見えない
    const ridge = (ang, dist, w, h, tint) => {
      const x = Math.sin(ang) * dist, z = Math.cos(ang) * dist;
      emit(new THREE.ConeGeometry(w, h, 4, 1), M.earth, x, h / 2 - 6, z,
        ang + Math.PI / 4, 0, 0, false, false, tint);
    };
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2 + 0.21;
      const r = 150 + ((i * 37) % 60);
      // 遠いほど淡く。空気遠近はシェーダー側も掛けるが、
      // 頂点色でも落としておくと山が「奥にある」と読める
      ridge(a, r, 60 + (i % 5) * 14, 34 + (i % 7) * 11, 0.72 - (r - 150) / 60 * 0.16);
    }
    // 天守。**1つだけ大きい物を置くと、町の向きが分かる。**
    // どこに居ても「城はあっち」で自分の向きが読めるようになる
    {
      const cx = -96, cz = -128;
      // 石垣。上へ行くほど細い台形
      emit(cylGeo(15, 21, 13, 4, 2), M.stone, cx, 6.5, cz, Math.PI / 4, 0, 0, false, false, 0.80);
      // 5層。上へ行くほど小さく、各層に瓦の庇を回す
      let y = 13, w = 17;
      for (let i = 0; i < 5; i++) {
        emit(new THREE.BoxGeometry(w, 5.2, w), M.shikkui, cx, y + 2.6, cz, 0, 0, 0, false, false, 0.86);
        emit(new THREE.BoxGeometry(w + 3.4, 0.9, w + 3.4), M.kawara, cx, y + 5.4, cz, 0, 0, 0, false, false, 0.80);
        y += 5.9; w *= 0.80;
      }
      // 最上層の屋根。四角錐で締める
      emit(new THREE.ConeGeometry(w * 0.95, 5.0, 4, 1), M.kawara, cx, y + 2.4, cz, Math.PI / 4, 0, 0, false, false, 0.78);
    }
    // 火の見櫓。近い場外に2基。細い骨組みなので、輪郭で「町の外れ」が読める
    for (const [tx, tz] of [[52, -44], [-46, 50]]) {
      for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
          // 柱は上で狭まる。下だけ置いて上を寄せる
          emit(new THREE.BoxGeometry(0.5, 13, 0.5), M.timber,
            tx + su * 1.9, 6.5, tz + sv * 1.9, 0, 0, 0, false, false, 0.9);
        }
      }
      emit(new THREE.BoxGeometry(5.6, 0.5, 5.6), M.timber, tx, 13.2, tz, 0, 0, 0, false, false, 0.9);
      emit(new THREE.ConeGeometry(4.2, 2.6, 4, 1), M.kawara, tx, 14.8, tz, Math.PI / 4, 0, 0, false, false, 0.8);
      // 半鐘。火の見櫓はこれが吊ってあるから火の見櫓に見える
      emit(cylGeo(0.34, 0.42, 0.72, 8, 1), M.lantern, tx, 13.9, tz, 0, 0, 0, false, false, 1.0);
    }
    // 寺の屋根。塀の向こうに大きい瓦屋根を2つ覗かせる
    for (const [tx, tz, ta] of [[-58, -26, 0.3], [40, 62, 1.2]]) {
      emit(new THREE.BoxGeometry(22, 7, 14), M.shikkui, tx, 3.5, tz, ta, 0, 0, false, false, 0.84);
      emit(new THREE.ConeGeometry(16, 7.5, 4, 1), M.kawara, tx, 10.2, tz, ta + Math.PI / 4, 0, 0, false, false, 0.78);
    }
  }

  /* -------------------------------------------------------- 地面の敷き分け */
  /* **ここが無かったのが「砂漠に木箱」の正体。**
     土一色の板が420m四方に1枚あるだけで、通りも境内も同じ色をしていた。
     石畳の環状の通りと、玉砂利の境内と、その外の土を敷き分ける。
     板は物の足跡(marks)が出揃ってから焼くので、生成の呼び出しは最後 */
  patch(34, 34, M.stone, 0, 0, 0, 0.019, 12, 0);            // 境内の玉砂利
  // 環状の通り。4本の帯で囲む
  patch(50, 9.0, M.stone, 0, -19.4, 0, 0.021, 10, 1);
  patch(50, 9.0, M.stone, 0, 19.4, 0, 0.021, 10, 1);
  patch(9.0, 50, M.stone, -19.4, 0, 0, 0.021, 10, 1);
  patch(9.0, 50, M.stone, 19.4, 0, 0, 0.021, 10, 1);
  // 参道。境内から四方の門へ抜ける道
  patch(6.0, 20, M.stone, 0, -24, 0, 0.024, 5, 2);
  patch(6.0, 20, M.stone, 0, 24, 0, 0.024, 5, 2);
  patch(20, 6.0, M.stone, -24, 0, 0, 0.024, 5, 2);
  patch(20, 6.0, M.stone, 24, 0, 0, 0.024, 5, 2);
  // 町屋の裏の土。石畳と石畳の間を埋めて、境界が1本の直線にならないようにする
  patch(16, 12, M.dirt, -26, -31.5, 0.10, 0.023, 7, 1);
  patch(16, 12, M.dirt, 26, 31.5, -0.10, 0.023, 7, 1);
  patch(12, 16, M.dirt, -31.5, 26, 0.15, 0.023, 7, 1);
  patch(12, 16, M.dirt, 31.5, -26, -0.15, 0.023, 7, 1);
  patch(14, 14, M.dirt, -30, 30, 0.20, 0.026, 6, 2);
  patch(14, 14, M.dirt, 30, -30, -0.20, 0.026, 6, 2);
  // 通りの曲がり角の踏み固め。人の通る所ほど土が出る
  patch(9, 9, M.dirt, -19.4, -19.4, 0.3, 0.028, 4, 3);
  patch(9, 9, M.dirt, 19.4, 19.4, -0.3, 0.028, 4, 3);

  for (const job of patchJobs) buildPatch(job);
  patchJobs.length = 0;

  } else {
  /* ------------------------------------------------------------ 地面 */
  // 見た目の地面はフォグで溶けるところまで伸ばす。狭いと視界の先に板の縁が見えて、
  // 一気に「箱庭に立っている」感じになる。
  // ただしこれをOctreeに入れると巨大な三角形が全ノードに複製されて重くなるので、
  // 当たり判定は場内だけを覆う見えない板に任せる。
  // 平らな板を1枚置くと、地平線が定規の直線になって世界が「トレイの底」に見える。
  // 場外だけ緩くうねらせる。場内(R<50)は完全に平らなままなので当たり判定はずれない
  /* 分割は48×48（4,608三角形）。前は96×96で18,432三角形あった。
     この板は420m四方あってバウンディング球の半径が約300mになるので、
     **視錐台カリングで一度も落ちず、毎フレーム必ず全部描かれる。**
     どこを向いても背負う固定費なので、分割は要る最低限まで削る。
     うねりを付けるのはR>50mの外側だけ（下のsstep）で、場内は完全に平ら。
     細かい割りが要るのはうねりの起伏（波長10m前後）の所だけだが、
     50m先の丘の起伏が少し鈍っても遊んでいて見分けは付かない。
     一方この2/3の削りは、影以外の全パスから毎フレーム約14,000三角形を消す */
  const groundGeo = new THREE.PlaneGeometry(420, 420, 48, 48);
  groundGeo.rotateX(-Math.PI / 2);
  scaleUV(groundGeo, 105, 105);
  {
    const gp = groundGeo.attributes.position;
    for (let i = 0; i < gp.count; i++) {
      const gx = gp.getX(i), gz = gp.getZ(i);
      const dd = Math.hypot(gx, gz);
      const k = sstep(50, 130, dd);
      if (k <= 0) continue;
      const n = fbm2(gx * 0.012, gz * 0.012, 1.0, 4, 4409) - 0.5;
      gp.setY(i, n * 9.0 * k);
    }
    groundGeo.computeVertexNormals();
    // 全材質でvertexColorsを開けたので、emitを通らないこの2枚にも色属性が要る。
    // ついでに「タイル周期よりずっと大きいムラ」を頂点カラーへ焼く。
    // 420m四方に4m角のタイルを並べているので、これが無いと地平まで縞が読める
    const gc = new Float32Array(gp.count * 3);
    for (let i = 0; i < gp.count; i++) {
      const v = 0.86 + 0.26 * fbm2(gp.getX(i) * 0.014, gp.getZ(i) * 0.014, 1.0, 4, 7717);
      gc[i * 3] = v; gc[i * 3 + 1] = v; gc[i * 3 + 2] = v;
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(gc, 3));
  }
  const ground = new THREE.Mesh(groundGeo, M.asphalt);
  ground.receiveShadow = true;
  root.add(ground);

  // 当たり判定専用の床。1枚の巨大三角形だとOctreeの各ノードに複製されるので、
  // 場内ぎりぎりの大きさで細かく割っておく
  const floorGeo = new THREE.PlaneGeometry(96, 96, 8, 8);
  floorGeo.rotateX(-Math.PI / 2);
  {
    const fc = new Float32Array(floorGeo.attributes.position.count * 3);
    fc.fill(1);
    floorGeo.setAttribute('color', new THREE.BufferAttribute(fc, 3));
  }
  const floor = new THREE.Mesh(floorGeo, M.asphalt);
  floor.visible = false;          // 描かないがOctreeには入る
  solids.add(floor);


  patch(38, 34, M.concrete, 0, 0, 0, 0.020, 9);            // 中央広場の舗装
  patch(26, 20, M.dirt, -29, 18, 0.12, 0.024, 7);          // 廃墟まわりの土
  patch(30, 18, M.dirt, 24, -26, -0.08, 0.026, 8);         // 倉庫前のヤード
  patch(18, 16, M.dirt, -30, -3, 0.20, 0.022, 5);          // 資材置場
  patch(22, 12, M.concrete, 31, 4, 0.0, 0.028, 6);         // 東側の通路
  patch(16, 14, M.dirt, 6, 30, -0.15, 0.024, 5);
  patch(14, 10, M.concrete, -18, -34, 0.05, 0.022, 4);
  // 舗装の切れ目に小さい土の吹き溜まりを重ねる。境界が1本の線にならなくなる
  patch(11, 7, M.dirt, -17.5, 8.0, 0.4, 0.030, 4, 2);
  patch(9, 6, M.dirt, 15.0, -17.0, -0.5, 0.030, 4, 2);
  patch(8, 8, M.dirt, 19.5, 12.5, 0.2, 0.030, 4, 2);

  /* -------------------------------------------------- 外周の壁と境界 */
  const R = 42;
  // 4面とも同じ高さ・同じ材質・同じ間隔の控え柱だと、境界が「壁」ではなく
  // 「トレイの縁」に見える。面ごとに高さと控え柱の刻みを変えて素材を混ぜる。
  // それでも1面が1本の直線で通っていたので、面を4スパンに割って高さを振り、
  // 1スパンは胸の高さまで崩落させる。上端が定規で引いた直線で84m通っているのが、
  // 俯瞰した瞬間に「箱庭の縁」だと分かる一番の原因だった
  const WALL_H = [9.0, 13.0, 11.0, 16.0];
  const WALL_STEP = [8.4, 6.2, 7.6, 5.4];
  // [スパンの長さの比, 高さの倍率]。面ごとに違う組を当てて4面が揃わないようにする
  const WALL_PLAN = [
    [[0.30, 1.00], [0.24, 0.62], [0.22, 1.18], [0.24, 0.84]],
    [[0.26, 0.80], [0.30, 1.14], [0.20, 0.58], [0.24, 0.96]],
    [[0.22, 1.12], [0.26, 0.74], [0.28, 1.00], [0.24, 0.64]],
    [[0.28, 0.70], [0.22, 1.10], [0.26, 0.86], [0.24, 1.16]],
  ];
  // 面ごとに崩落させるスパンの番号。西面(3)だけは既設の大看板(-40.6, -12)が
  // 載っている区間を避けて選ぶ（崩すと看板が空中に浮く）
  const WALL_BROKEN = [2, 0, 3, 3];
  const WALL_LEN = R * 2 + 4;
  const wallSides = [];
  const wallGaps = [];                // 崩落スパン。瓦礫は乱数列を乱さない位置で後から積む
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    const wx = Math.sin(a) * R;
    const wz = Math.cos(a) * R;
    const dirX = Math.cos(a);
    const dirZ = -Math.sin(a);
    const inX = -Math.sin(a);      // 場内を向く方向
    const inZ = -Math.cos(a);
    const segs = [];
    let uc0 = -WALL_LEN / 2;
    WALL_PLAN[i].forEach(([frac, hm], k) => {
      const len = WALL_LEN * frac;
      const broken = k === WALL_BROKEN[i];
      segs.push({
        uc: uc0 + len / 2, len, broken,
        h: broken ? 1.5 + WALL_H[i] * 0.06 : WALL_H[i] * hm,
        // 車両ゲートの開口。北面の1スパンにだけ開けて、そこへ閉じた扉を吊る
        gateU: i === 0 && k === 3 ? 32 : null,
      });
      uc0 += len;
    });
    wallSides.push({ a, wx, wz, dirX, dirZ, inX, inZ, segs });

    // 基礎の段差だけは通しで引く。ここが切れると壁ではなく塀の列に見える
    box(WALL_LEN, 0.55, 2.5, M.concrete, wx, 0, wz, a, 2.0);
    for (let k = 0; k < segs.length; k++) {
      const sg = segs[k];
      const sx = wx + dirX * sg.uc, sz = wz + dirZ * sg.uc;
      if (sg.gateU !== null) {
        // 開口を実際に抜く。壁の前に扉を貼り付けただけだと、
        // 「塞がった壁に扉の絵が描いてある」ようにしか見えない
        wallRun(M.concreteDark, sx, sz, a, sg.len, sg.h, 2,
          [{ u: sg.gateU - sg.uc, w: 13.0, y0: 0, y1: 5.8, trim: false, frame: false }], 3.5);
      } else {
        box(sg.len, sg.h, 2, sg.broken ? M.brick : M.concreteDark, sx, 0, sz, a, 3.5);
      }
      if (sg.broken) {
        // 崩れた天端。真っ直ぐ切れていると「低く作った壁」にしか見えないので、
        // 折れ残りを何個か立てて破断の形を作る
        for (let b = 0; b < 5; b++) {
          const bu = ((b + 0.5) / 5 - 0.5) * sg.len * 0.92;
          const bh = 0.35 + hash3(bu, i * 3.7, 5.1) * 1.5;
          boxT(sg.len / 5 * 0.8, bh, 1.7, M.brick,
            sx + dirX * bu, sg.h + bh / 2 - 0.15, sz + dirZ * bu,
            a + (hash3(bu, 2.3, i) - 0.5) * 0.25, (hash3(i, bu, 7.7) - 0.5) * 0.2,
            (hash3(bu, i, 9.1) - 0.5) * 0.22, 2.4);
        }
        wallGaps.push({ x: sx, z: sz, dirX, dirZ, len: sg.len, inX, inZ });
      } else {
        box(sg.len, 0.45, 2.4, M.concrete, sx, sg.h, sz, a, 2.0);        // 笠木
        // 天端の有刺鉄線。高所の細物なので飾り扱い
        const nb = Math.max(2, Math.round(sg.len / 6.6));
        for (let k2 = 0; k2 <= nb; k2++) {
          const u = (k2 / nb - 0.5) * sg.len;
          boxT(0.07, 0.75, 0.07, M.metal, sx + dirX * u + inX * 0.6, sg.h + 0.8,
            sz + dirZ * u + inZ * 0.6, a, 0, 0.5, 0.6, false);
        }
        for (let s = 0; s < 3; s++) {
          boxD(sg.len, 0.05, 0.05, M.metal,
            sx + inX * (0.35 + s * 0.2), sg.h + 0.75 + s * 0.15, sz + inZ * (0.35 + s * 0.2), a, 0.6);
        }
      }
      // 段の境目に控え柱を立てて、高さの食い違いを納める。
      // 段差をそのまま見せると壁ではなく「積み残した積み木」になる
      if (k < segs.length - 1) {
        const nx2 = segs[k + 1];
        const eu = sg.uc + sg.len / 2;
        box(1.15, Math.max(sg.h, nx2.h) + 0.5, 2.5, M.concreteDark,
          wx + dirX * eu, 0, wz + dirZ * eu, a, 2.2);
      }
      // 控え柱。等間隔の縦のリズムが入ると、のっぺり長い壁が壁として読める。
      // ただし数本は欠けさせて、機械で刻んだ列に見せない
      const step = WALL_STEP[i];
      const kn = Math.max(1, Math.floor(sg.len / step));
      for (let k2 = 0; k2 < kn; k2++) {
        if (hash3(k2 * 3.3 + sg.uc, i * 7.7, 1.1) < 0.16) continue;
        const u = ((k2 + 0.5) / kn - 0.5) * sg.len;
        // ゲートの開口に控え柱が立つと、開いた穴の真ん中に柱が残って意味が壊れる
        if (sg.gateU !== null && Math.abs(sg.uc + u - sg.gateU) < 7.5) continue;
        box(0.85, Math.max(1.2, sg.h - 1.4), 0.75, M.concreteDark,
          sx + dirX * u + inX * 1.3, 0, sz + dirZ * u + inZ * 1.3, a, 2.2);
      }
      // 壁付けの投光器。高いスパンの真ん中に1灯だけ。灯りの高さでスケールが伝わる
      if (!sg.broken && sg.h > WALL_H[i] * 0.95) {
        floodLight(sx + inX * 1.0, sg.h - 1.2, sz + inZ * 1.0, a + Math.PI, 0.65);
      }
    }
    // 壁の根本は必ず汚れが溜まる。頂点カラー側だけ効かせたいので板は出さない
    for (let k = -4; k <= 4; k++) {
      mark(wx + dirX * k * 9 + inX * 1.6, wz + dirZ * k * 9 + inZ * 1.6, 5.5, 0.55, false);
    }
  }
  // 閉じた門とトラック用のスロープ。境界に「出入口があって閉めてある」形が1つ入ると、
  // 壁が撃ち合いの都合で立てた仕切りではなく、施設の外周として読める
  {
    const gx = 32.0, gz = 41.0;
    box(0.55, 5.4, 0.55, M.rust, gx - 6.4, 0, gz, 0, 1.2);
    box(0.55, 5.4, 0.55, M.rust, gx + 6.4, 0, gz, 0, 1.2);
    box(13.4, 0.4, 0.4, M.rust, gx, 5.4, gz, 0, 1.4);
    for (const s of [-1, 1]) {
      // 扉。框と桟だけ立てて、面は波板で塞ぐ
      box(6.0, 4.4, 0.14, M.corr, gx + s * 3.15, 0.1, gz - 0.25, 0, 2.2);
      boxD(6.1, 0.16, 0.24, M.rust, gx + s * 3.15, 0.1, gz - 0.25, 0, 0.8);
      boxD(6.1, 0.16, 0.24, M.rust, gx + s * 3.15, 4.5, gz - 0.25, 0, 0.8);
      boxD(6.1, 0.14, 0.2, M.rust, gx + s * 3.15, 2.3, gz - 0.25, 0, 0.8);
      boxD(0.18, 4.4, 0.22, M.rust, gx + s * 6.0, 0.1, gz - 0.25, 0, 0.8);
    }
    // 閂。閉じているという情報はここでしか出せない
    boxD(1.6, 0.14, 0.14, M.metal, gx, 1.7, gz - 0.42, 0, 0.5);
    // 荷役スロープ。門の内側で舗装が一段上がる
    rampSlab(7.0, 3.6, 0.42, M.concrete, gx, 0, gz - 3.5, 0, 0.30, 2.2);
    mark(gx, gz - 2.6, 4.4, 0.6);
  }
  // 壁面の大看板。文字が読めるものを混ぜないと、ここが何の施設か画から分からない
  sign(9, 3.4, 0, 5.2, -40.6, 0, M.rust, false, signFace('BLACKOUT', 'YARD 07 / RESTRICTED', '#8d3a2a', '#e8dcc4', 17));
  sign(7, 2.8, 26, 4.6, 40.6, Math.PI, M.corr, false, signFace('DOCK B', 'NO ENTRY', '#2f4152', '#dfe6ea', 41));
  sign(6, 2.4, -40.6, 4.8, -12, Math.PI / 2, M.metalRed, false, signFace('DANGER', 'HIGH VOLTAGE', '#b8901c', '#20180c', 73));

  /* --------------------------------------------- 中央の掩体（争点） */
  // 壁に銃眼を開けて中からも撃てるようにした。屋上は土嚢で胸壁を作る
  //
  // **2026-08-14に点対称へ直した。** 元は西だけ壁（銃眼2つ）・東だけ開口で、
  // 対戦の湧きが東西（±17.5,0）なのに、東の組だけ正面から掩体へ入れて
  // 西の組は壁に阻まれていた（「片方不利やろ」と言われた所）。
  // 東西とも同じ袖壁の開口にし、南北の銃眼・屋上の縁石・斜路も
  // 180度回して重なる形（点対称）に揃えてある。
  // 中心から半径20mの戦域の対称度はtools/check-arena.mjsが測っている
  const bunkerH = 3.4;
  // 銃眼は中から撃つための開口なので、枠だけ入れてガラスは張らない
  // 幅も間隔も揃えると建築というより換気口の列に見える。3つとも別の寸法にする
  const slit = (u, w = 1.6, y0 = 1.05) => ({ u, w, y0, y1: 1.85, glass: false });
  // 北と南は「銃眼2つ＋戸1つ」の180度回した対。戸を両側に残すのは、
  // 中央を南北へ突っ切る動線（0,±17.5の湧きからの最短）を殺さないため
  wallRun(M.concrete, 0, -6.5, 0, 15, bunkerH, 1.0,
    [slit(-5.3, 1.1), { u: -0.6, w: 2.6, y0: 0, y1: 2.5 }, slit(4.9, 1.5, 1.2)], 3);
  wallRun(M.concrete, 0, 6.5, 0, 15, bunkerH, 1.0,
    [slit(5.3, 1.1), { u: 0.6, w: 2.6, y0: 0, y1: 2.5 }, slit(-4.9, 1.5, 1.2)], 3);
  // 東西は同じ袖壁の開口。どちらの湧きからも同じ間口で入れる
  box(1.0, bunkerH, 5.0, M.concrete, 7.0, 0, -4.0, 0, 3);
  box(1.0, bunkerH, 5.0, M.concrete, 7.0, 0, 4.0, 0, 3);
  box(1.0, bunkerH, 5.0, M.concrete, -7.0, 0, -4.0, 0, 3);
  box(1.0, bunkerH, 5.0, M.concrete, -7.0, 0, 4.0, 0, 3);
  cornerChamfer(M.concrete, 0, 0, 15.0, 14.0, bunkerH);
  box(16, 0.5, 15, M.concreteDark, 0, bunkerH, 0, 0, 3);
  box(16.6, 0.3, 15.6, M.concrete, 0, bunkerH - 0.3, 0, 0, 2.5);    // 軒の見切り
  // 屋上の縁石。斜路が着く東西だけ開けておかないと上がれない（開口幅も揃える）
  wallRun(M.concreteDark, 0, -7.3, 0, 16, 0.8, 0.35, [], 2, bunkerH + 0.5);
  wallRun(M.concreteDark, 0, 7.3, 0, 16, 0.8, 0.35, [], 2, bunkerH + 0.5);
  wallRun(M.concreteDark, -7.9, 0, Math.PI / 2, 15, 0.8, 0.35,
    [{ u: 0, w: 3.0, y0: 0, y1: 0.8 }], 2, bunkerH + 0.5);
  wallRun(M.concreteDark, 7.9, 0, Math.PI / 2, 15, 0.8, 0.35,
    [{ u: 0, w: 3.0, y0: 0, y1: 0.8 }], 2, bunkerH + 0.5);
  // 屋上への斜路も両側から。片側だけだと高所の取り合いが毎回同じ側の勝ちになる
  ramp(3.0, 9, M.metal, -11.5, 0, 0, Math.PI / 2, bunkerH + 0.5);
  ramp(3.0, 9, M.metal, 11.5, 0, 0, -Math.PI / 2, bunkerH + 0.5);

  // 掩体の中身。柱と資材があるだけで「入れる場所」に見える
  box(0.5, bunkerH, 0.5, M.concrete, -3.4, 0, -2.2, 0, 1.4);
  box(0.5, bunkerH, 0.5, M.concrete, 3.4, 0, 2.2, 0, 1.4);
  crate(1.3, 1.3, -4.6, 0, 3.8, 0.4);
  crate(1.1, 1.1, -4.4, 1.3, 3.6, 0.9);
  drum(4.4, -3.6, M.rust);
  drum(5.2, -2.6, M.metal);
  cabinet(-6.2, -4.6, Math.PI / 2);
  // 屋内であることを床材で言う。屋外の舗装がそのまま続いていると、
  // 壁と屋根があっても「屋外に立てた衝立」にしか読めない。
  // 描画順は広場の板(9)より後にしないと下に潜って見えない
  patch(12.4, 11.6, M.dirt, 0, 0, 0.03, 0.034, 6, 11);
  // 中を割る間仕切り。壁から生やして途中で止める。
  // 中央に立てて袋小路を作るとAIが引っかかるので、必ず片側を開けておく。
  // 対になる2枚（点対称）。1枚だけだと、間仕切りの陰を使える側が固定になる
  wallRun(M.concreteDark, -1.6, 4.5, Math.PI / 2, 4.0, 2.6, 0.25, [], 2.2);
  box(0.34, bunkerH, 0.34, M.concrete, -1.6, 0, 2.5, 0, 1.2);   // 間仕切りの端の柱
  wallRun(M.concreteDark, 1.6, -4.5, Math.PI / 2, 4.0, 2.6, 0.25, [], 2.2);
  box(0.34, bunkerH, 0.34, M.concrete, 1.6, 0, -2.5, 0, 1.2);
  // 棚と机。人が使っていた痕跡は、量より「腰から胸の高さに水平線があること」で出る。
  // 置き場所は西の袖壁の内side。前は西の壁いっぱいに置いていたが、
  // 対称化で壁が開口になったので、開口（|z|<1.5）を塞がない南側へ寄せた
  for (const sy of [0.55, 1.15, 1.75]) {
    box(0.55, 0.06, 3.6, M.metal, -6.1, sy, -3.5, 0, 1.0);
  }
  for (const sz of [-5.2, -1.8]) {
    box(0.06, 1.85, 0.06, M.metal, -6.1, 0, sz, 0, 0.5);
    box(0.06, 1.85, 0.06, M.rust, -5.85, 0, sz, 0, 0.5);
  }
  box(1.7, 0.07, 0.8, M.wood, -4.6, 0.78, -5.2, 0.12, 1.0);
  for (const [lx, lz] of [[-5.35, -5.5], [-3.85, -5.5], [-5.35, -4.9], [-3.85, -4.9]]) {
    boxD(0.07, 0.78, 0.07, M.metal, lx, 0, lz, 0, 0.4);
  }
  crate(0.75, 0.6, -3.3, 0, -5.4, 0.7);
  // 屋内灯。屋内と屋外の照明差はこの画で一番強いコントラストなのに、
  // 開口の奥が全部真っ黒だとそれを丸ごと捨てることになる。
  // 影は落とさない(点光源の影は6面ぶんの描画になって割に合わない)
  emit(new THREE.PlaneGeometry(0.7, 0.34), lampMat, 1.2, 3.28, -3.0, 0, Math.PI / 2, 0, false, false);
  boxD(0.86, 0.1, 0.5, M.rust, 1.2, 3.34, -3.0, 0, 0.4);
  // 点光源は影を落とさなくても全フラグメントで評価される。屋内3箇所に1灯ずつ、
  // これ以上は増やさない
  // 到達距離は短く。点光源は影を落とさないので、遠くまで届かせると
  // 壁を突き抜けて外の路面まで暖色で照らしてしまう
  if (lamps) {
    const bunkerLamp = new THREE.PointLight(0xffb877, 7.0, 9, 2);
    bunkerLamp.position.set(1.2, 3.05, -3.0);
    root.add(bunkerLamp);
  }

  // 屋上の設備と土嚢。胸壁は北と南に1列ずつ（180度回した対）。
  // 北だけだと、屋上へ上がった後に北向きへ撃つ側しか胸壁を使えない
  const bunkerRoof = bunkerH + 0.5;
  for (const side of [-1, 1]) {
    for (let i = 0; i < 5; i++) {
      const t = (i - 2) * 0.99;
      const h0 = sandbagAt(side * (-3 + t), bunkerRoof, side * -6.6, rr(-0.12, 0.12), rr(0.94, 1.06), rr(0.84, 0.93));
      // 上段は半ピッチずらして目地を互い違いにする
      if (i > 0 && i < 4) {
        sandbagAt(side * (-3 + t + 0.5), bunkerRoof + h0 - 0.055, side * -6.6, rr(-0.18, 0.18), rr(0.94, 1.06), rr(0.92, 1.0));
      }
    }
  }
  ductRun(3.6, bunkerRoof, 3.4, 0, 5.0);
  acUnit(-1.2, bunkerRoof, 4.4, 0.3);
  acUnit(0.2, bunkerRoof, 4.4, 0.3);
  antennaMast(5.8, bunkerRoof, -5.6, 5.2);
  waterTank(-5.4, bunkerRoof, 4.8, 1.0, 1.7);
  // 瓦礫は180度回した対。中央の南北の通り道（x=0、戸から戸へ）に
  // 破片がはみ出さない所まで外へ寄せてある
  rubble(2.8, -4.2, 1.6, 6, [M.concrete, M.brick]);
  rubble(-2.8, 4.2, 1.6, 6, [M.concrete, M.brick]);
  ladder(7.9, 0, 3.4, 3.9, Math.PI / 2);
  ladder(-7.9, 0, -3.4, 3.9, -Math.PI / 2);

  // 掩体を囲む車止めと単発の車止め。**全部180度回した対で置く**（戦域の対称化）。
  // 胸の高さの遮蔽を中央に置いて、距離を詰める側にも寄る場所を作る。
  // 南北の列はx=0の通り道（掩体の南北の戸を突っ切る動線）を塞がない所まで外へ寄せる
  // （列は乱数で±4m前後に伸びるので、中心を6.5まで離さないと端がx=0へ届く）
  jerseyLine(-6.5, -11.0, 0, 4);
  jerseyLine(6.5, 11.0, 0, 4);
  jerseyLine(10.5, -5.0, Math.PI / 2, 3);
  jerseyLine(-10.5, 5.0, Math.PI / 2, 3);
  jersey(-12.6, 5.6, 0.35);
  jersey(-13.4, 7.4, 0.4);
  jersey(12.6, -5.6, 0.35);
  jersey(13.4, -7.4, 0.4);

  /* ------------------------------------------ 建物A（北西・事務所棟） */
  // 中2階を張って吹き抜けを作り、外階段で屋上まで通す。
  // 元の斜路は屋上のパラペットに阻まれて登れなかったので階段に置き換えた
  {
    const cx = -21, cz = -20, w = 17, d = 14, h = 6.5, t = 0.55;
    // 南面の正面入口（下のwallRunの u=0 / 幅3.0）はここで切り欠く。
    // 切らないと基礎の段差と腰壁が入口を横切って、扉が飾りになる
    const doors = [{ side: 'z+', u: 0, w: 3.0 }];
    band(w + 0.9, d + 0.9, 0.5, 1.2, M.concrete, cx, 0, cz, 2.5, doors);    // 基礎の段差
    band(w + 0.4, d + 0.4, 0.65, 0.9, M.brick, cx, 0.5, cz, 2.0, doors);    // 腰のレンガ
    // 南面（正面）
    wallRun(M.plaster, cx, cz + d / 2, 0, w, h, t, [
      { u: 0, w: 3.0, y0: 0, y1: 2.9 },
      { u: -5.6, w: 1.8, y0: 1.2, y1: 2.7 },
      { u: 5.6, w: 1.8, y0: 1.2, y1: 2.7 },
      { u: -5.6, w: 1.5, y0: 4.4, y1: 5.7 },
      { u: 5.6, w: 1.5, y0: 4.4, y1: 5.7 },
    ], 3);
    // 北面
    wallRun(M.plaster, cx, cz - d / 2, 0, w, h, t, [
      { u: -5.2, w: 1.8, y0: 1.2, y1: 2.7 },
      { u: 0, w: 1.8, y0: 1.2, y1: 2.7 },
      { u: 5.2, w: 1.8, y0: 1.2, y1: 2.7 },
    ], 3);
    // 西面
    wallRun(M.plaster, cx - w / 2, cz, Math.PI / 2, d, h, t, [
      { u: -4.2, w: 1.6, y0: 1.2, y1: 2.7 },
      { u: 4.2, w: 1.6, y0: 1.2, y1: 2.7 },
    ], 3);
    // 東面。中2階に光を入れる高窓を足す
    wallRun(M.plaster, cx + w / 2, cz, Math.PI / 2, d, h, t, [
      { u: -4.6, w: 1.6, y0: 1.2, y1: 2.7 },
      { u: 4.6, w: 1.6, y0: 1.2, y1: 2.7 },
      { u: 0.6, w: 2.2, y0: 4.9, y1: 6.1 },
    ], 3);
    band(w + 0.5, d + 0.5, 0.24, 0.8, M.brick, cx, 3.35, cz, 2.0);       // 中間のモールディング
    cornerChamfer(M.plaster, cx, cz, w + t, d + t, h - 1.15, 1.15);
    box(w + 0.9, 0.5, d + 0.9, M.concreteDark, cx, h, cz, 0, 3);         // 屋根スラブ
    band(w + 1.1, d + 1.1, 0.22, 0.8, M.concrete, cx, h - 0.22, cz, 2);  // 蛇腹
    // パラペット。東側に階段の取り付き口を開ける
    wallRun(M.concreteDark, cx, cz - d / 2 - 0.2, 0, w + 0.9, 1.0, 0.4, [], 2, h + 0.5);
    wallRun(M.concreteDark, cx, cz + d / 2 + 0.2, 0, w + 0.9, 1.0, 0.4, [], 2, h + 0.5);
    wallRun(M.concreteDark, cx - w / 2 - 0.2, cz, Math.PI / 2, d + 0.9, 1.0, 0.4, [], 2, h + 0.5);
    wallRun(M.concreteDark, cx + w / 2 + 0.2, cz, Math.PI / 2, d + 0.9, 1.0, 0.4,
      [{ u: -2.4, w: 2.8, y0: 0, y1: 1.0 }], 2, h + 0.5);

    // 玄関の庇
    box(4.6, 0.28, 1.9, M.concreteDark, cx, 3.0, cz + d / 2 + 0.8, 0, 1.6);
    box(0.22, 3.0, 0.22, M.metal, cx - 2.0, 0, cz + d / 2 + 1.6, 0, 1.0);
    box(0.22, 3.0, 0.22, M.metal, cx + 2.0, 0, cz + d / 2 + 1.6, 0, 1.0);

    // 中2階。北半分だけ床を張り、南側を吹き抜けにして撃ち下ろせるようにする
    box(w - 1.4, 0.35, d / 2 - 0.5, M.concreteDark, cx, 4.25, cz - d / 4 - 0.1, 0, 2.5);
    box(0.4, 4.25, 0.4, M.concrete, cx - 4.5, 0, cz - 3.2, 0, 1.4);
    box(0.4, 4.25, 0.4, M.concrete, cx + 4.5, 0, cz - 3.2, 0, 1.4);
    railing(9.0, M.metal, cx + 2.4, 4.6, cz - 3.35, 0);   // 西寄りは内部斜路の取り付きなので開ける
    crate(1.2, 1.2, cx - 5.4, 4.6, cz - 5.6, 0.3);
    crate(1.0, 1.0, cx + 5.0, 4.6, cz - 5.2, 0.8);
    // 1階から中2階へ上がる内部斜路
    ramp(1.8, 6.6, M.concrete, cx - 5.0, 0, cz + 3.1, Math.PI, 4.6);
    // 1階の中身
    crate(1.4, 1.4, cx + 4.4, 0, cz + 3.4, 0.5);
    crate(1.2, 1.2, cx + 5.2, 1.4, cz + 3.2, 1.1);
    drum(cx - 2.5, cz + 4.5, M.rust);
    drum(cx - 1.5, cz + 4.9, M.metal);
    palletStack(cx - 6.5, cz - 4.5, 0.4, 4);

    // 外階段。着地は屋根スラブの外縁で、パラペットの開口に位置を合わせてある
    stair(1.8, 10.5, 7.0, M.metal, M.metal, cx + 14.2, 0, cz + 2.4, -Math.PI / 2);

    // 屋上設備。輪郭に凹凸を作るのが目的
    const ry0 = h + 0.5;
    // 階数のズレた増築棟。3棟とも単純な直方体だと俯瞰で同じレシピだとばれるので、
    // 屋根の上に一段高い棟を載せて直方体1個のシルエットを壊す。
    // 窓を開けておくとwallRun側が枠とガラスを入れるので、遠目にも面が死なない
    {
      const ax = cx - 4.2, az = cz - 3.2, aw = 6.4, ad = 5.6, ah = 3.8, at = 0.4;
      wallRun(M.plaster, ax, az + ad / 2, 0, aw, ah, at, [
        { u: -1.7, w: 1.4, y0: 1.0, y1: 2.5 },
        { u: 1.7, w: 1.4, y0: 1.0, y1: 2.5 },
      ], 3, ry0);
      wallRun(M.plaster, ax, az - ad / 2, 0, aw, ah, at, [
        { u: 0, w: 1.6, y0: 1.0, y1: 2.5 },
      ], 3, ry0);
      wallRun(M.plaster, ax - aw / 2, az, Math.PI / 2, ad, ah, at, [
        { u: -1.3, w: 1.3, y0: 1.1, y1: 2.4 },
      ], 3, ry0);
      wallRun(M.plaster, ax + aw / 2, az, Math.PI / 2, ad, ah, at, [
        { u: 1.3, w: 1.3, y0: 1.1, y1: 2.4 },
      ], 3, ry0);
      band(aw + 0.5, ad + 0.5, 0.22, 0.7, M.brick, ax, ry0 + 2.7, az, 2.0);   // 中間の見切り
      box(aw + 0.6, 0.4, ad + 0.6, M.concreteDark, ax, ry0 + ah, az, 0, 2.5);
      band(aw + 0.8, ad + 0.8, 0.75, 0.28, M.concreteDark, ax, ry0 + ah + 0.4, az, 2.0);
      ladder(ax + aw / 2 + 0.3, ry0, az - 1.7, ah + 0.4, Math.PI / 2);
      acUnit(ax + aw / 2 + 0.55, ry0 + 1.5, az + 1.4, Math.PI / 2);
      downpipe(ax + aw / 2 + 0.28, ry0, az + ad / 2 - 0.3, ah + 0.4);
    }
    waterTank(cx - 6.4, ry0, cz + 4.2, 1.4, 2.4);
    ductRun(cx + 3.0, ry0, cz - 2.0, 0, 7.0);
    acUnit(cx + 5.6, ry0, cz + 3.6, 0.1);
    acUnit(cx + 4.3, ry0, cz + 3.6, 0.1);
    acUnit(cx + 3.0, ry0, cz + 3.6, 0.1);
    antennaMast(cx + 8.0, ry0, cz + 5.6, 5.4);
    box(2.4, 2.4, 2.2, M.brick, cx - 1.2, ry0, cz + 5.2, 0, 2.0);      // 塔屋
    box(2.7, 0.25, 2.5, M.concreteDark, cx - 1.2, ry0 + 2.4, cz + 5.2, 0, 1.6);
    rubble(cx + 6.4, cz - 5.2, 1.4, 5, [M.concrete, M.brick]);

    // 外壁の設備。平らな壁面に影を落とす物を貼るのが一番効く
    cabinet(cx - w / 2 - 0.55, cz + 3.0, -Math.PI / 2);
    acUnit(cx - w / 2 - 0.7, 2.6, cz - 2.4, -Math.PI / 2);
    acUnit(cx - w / 2 - 0.7, 2.6, cz - 4.0, -Math.PI / 2);
    downpipe(cx - w / 2 - 0.35, 0, cz + d / 2 - 0.4, 7.0);
    downpipe(cx + w / 2 + 0.35, 0, cz - d / 2 + 0.4, 7.0);
    gutter(w + 1.0, cx, h + 0.15, cz + d / 2 + 0.62, 0);
    gutter(w + 1.0, cx, h + 0.15, cz - d / 2 - 0.62, 0);
    pipeRun(12.0, 0.17, cx, 2.1, cz - d / 2 - 0.85, 0, M.rust);
    ladder(cx + w / 2 + 0.3, 0, cz + 5.0, 6.4, Math.PI / 2);
    sign(3.4, 1.1, cx + 3.6, 3.4, cz + d / 2 + 0.4, 0, M.metalRed, false,
      signFace('SITE OFFICE', 'REPORT ON ARRIVAL', '#2c4a3a', '#e2e8e0', 5));
  }

  /* -------------------------------------- 建物B（南東・レンガの詰所） */
  {
    const cx = 23, cz = 21, w = 15, d = 15, h = 5.5, t = 0.55;
    // 西面の入口（下のwallRunの u=0 / 幅3.0）を切り欠く。
    // ここが塞がっていたせいで、屋根の崩落跡から落ちると出られなかった
    const doors = [{ side: 'x-', u: 0, w: 3.0 }];
    band(w + 0.9, d + 0.9, 0.5, 1.2, M.concrete, cx, 0, cz, 2.5, doors);
    band(w + 0.4, d + 0.4, 0.65, 0.9, M.concrete, cx, 0.5, cz, 2.0, doors);
    wallRun(M.brick, cx - w / 2, cz, Math.PI / 2, d, h, t, [
      { u: 0, w: 3.0, y0: 0, y1: 2.9 },
      { u: -5.0, w: 1.7, y0: 1.2, y1: 2.7 },
      { u: 5.0, w: 1.7, y0: 1.2, y1: 2.7 },
      { u: 0, w: 2.0, y0: 3.7, y1: 5.0 },
    ], 2.6);
    wallRun(M.brick, cx + w / 2, cz, Math.PI / 2, d, h, t, [
      { u: -4.4, w: 1.7, y0: 1.2, y1: 2.7 },
      { u: 4.4, w: 1.7, y0: 1.2, y1: 2.7 },
    ], 2.6);
    wallRun(M.brick, cx, cz - d / 2, 0, w, h, t, [
      { u: -4.6, w: 1.7, y0: 1.2, y1: 2.7 },
      { u: 0, w: 2.2, y0: 1.2, y1: 2.7 },
      { u: 4.6, w: 1.7, y0: 1.2, y1: 2.7 },
    ], 2.6);
    wallRun(M.brick, cx, cz + d / 2, 0, w, h, t, [
      { u: -4.6, w: 1.7, y0: 1.2, y1: 2.7 },
      { u: 4.6, w: 1.7, y0: 1.2, y1: 2.7 },
    ], 2.6);
    band(w + 0.5, d + 0.5, 0.26, 0.8, M.plaster, cx, 2.9, cz, 2.0);
    cornerChamfer(M.brick, cx, cz, w + t, d + t, h - 1.15, 1.15);
    // 屋根の北東角を崩落させる。1棟だけ床スラブに穴が開くと、
    // 3棟が同じ手順で組まれていることが俯瞰で読めなくなる。
    // 南側の帯と北西の欠片の2枚に割って、x>cx+3.0 かつ z<cz-3.4 を抜く
    box(w + 0.9, 0.5, 11.35, M.concreteDark, cx, h, cz + 2.275, 0, 3);
    box(10.95, 0.5, 4.55, M.concreteDark, cx - 2.475, h, cz - 5.675, 0, 3);
    band(w + 1.1, d + 1.1, 0.22, 0.8, M.plaster, cx, h - 0.22, cz, 2);
    wallRun(M.concreteDark, cx, cz - d / 2 - 0.2, 0, w + 0.9, 1.0, 0.4,
      [{ u: -4.0, w: 2.8, y0: 0, y1: 1.0 }, { u: 5.5, w: 5.0, y0: 0, y1: 1.0 }], 2, h + 0.5);
    wallRun(M.concreteDark, cx, cz + d / 2 + 0.2, 0, w + 0.9, 1.0, 0.4, [], 2, h + 0.5);
    wallRun(M.concreteDark, cx - w / 2 - 0.2, cz, Math.PI / 2, d + 0.9, 1.0, 0.4, [], 2, h + 0.5);
    // 東側のパラペットは崩落した範囲をまるごと抜く。抜かないと床の無いところに
    // 手すりだけが宙に残って、崩落ではなく作り忘れに見える
    wallRun(M.concreteDark, cx + w / 2 + 0.2, cz, Math.PI / 2, d + 0.9, 1.0, 0.4,
      [{ u: 5.7, w: 4.6, y0: 0, y1: 1.0 }], 2, h + 0.5);
    rubble(cx + w / 2 + 1.8, cz + 3.2, 1.6, 6, [M.concrete, M.brick]);
    // 落ちた床版と、折れて垂れた鉄筋。穴の縁が直線で切れていると
    // 「抜いた」ようにしか見えないので、破断の跡を必ず添える
    boxT(4.6, 0.34, 3.4, M.concrete, cx + 4.6, 1.55, cz - 5.2, 0.32, 0.62, 0.12, 2.2);
    boxT(2.6, 0.28, 2.0, M.concreteDark, cx + 5.8, 0.42, cz - 2.4, -0.5, 0.18, 0.24, 2.0);
    for (const [ru, rv] of [[3.2, -3.7], [4.5, -3.55], [6.0, -3.6], [7.0, -3.5],
      [3.15, -5.0], [3.1, -6.4], [3.2, -7.6]]) {
      boxT(0.05, 1.15, 0.05, M.metal, cx + ru, h + 0.5, cz + rv,
        hash3(ru, 1.7, rv) * 3.0, 0.4, 0.3, 0.4, false);
    }
    rubble(cx + 4.8, cz - 5.6, 2.1, 11, [M.concrete, M.brick]);

    // 外階段。屋根スラブの外縁で受けないと外壁の天端に潜ってしまう
    stair(1.8, 9.0, 6.0, M.metal, M.metal, 19, 0, cz - d / 2 - 0.45 - 4.5, 0);

    // 中身。押し出した箱に穴を開けただけだと、入口が奥行きゼロの黒い矩形になる。
    // 床材を替えて棚と机を入れると、開口の奥に空間があることが外からでも読める
    patch(13.2, 13.2, M.dirt, cx, cz, 0.06, 0.036, 6, 11);
    for (const sy of [0.5, 1.12, 1.74, 2.36]) {
      box(0.6, 0.055, 5.4, M.metal, cx + 6.1, sy, cz + 2.2, 0, 1.0);
    }
    for (const sz of [-0.4, 2.2, 4.8]) {
      box(0.06, 2.45, 0.06, M.rust, cx + 5.85, 0, cz + sz, 0, 0.5);
      box(0.06, 2.45, 0.06, M.rust, cx + 6.35, 0, cz + sz, 0, 0.5);
    }
    crate(0.9, 0.8, cx + 6.1, 1.17, cz + 3.4, 0.3);
    crate(0.8, 0.7, cx + 6.1, 0.55, cz + 1.0, 1.2);
    box(2.2, 0.08, 1.0, M.wood, cx - 3.6, 0.76, cz + 5.4, 0.08, 1.2);
    for (const [lx, lz] of [[-4.6, 5.0], [-2.6, 5.0], [-4.6, 5.8], [-2.6, 5.8]]) {
      boxD(0.08, 0.76, 0.08, M.metal, cx + lx, 0, cz + lz, 0, 0.4);
    }
    drum(cx - 4.8, cz - 3.0, M.rust);
    drum(cx - 3.8, cz - 3.8, M.metalRed);
    // 北東の角は屋根が崩落して瓦礫が積んである。設備はそこを避けて西側へ寄せる
    cabinet(cx - 5.9, cz - 5.0, Math.PI);
    palletStack(cx - 5.2, cz + 1.4, 0.35, 3);
    // 入口の内側に灯りを1つ。扉の奥から光が漏れると、そこが穴ではなく部屋になる
    emit(new THREE.PlaneGeometry(0.6, 0.3), lampMat,
      cx - 6.4, 3.9, cz + 1.6, 0, Math.PI / 2, 0, false, false);
    boxD(0.74, 0.09, 0.44, M.rust, cx - 6.4, 3.96, cz + 1.6, 0, 0.4);
    if (lamps) {
      const shedLamp = new THREE.PointLight(0xffb877, 6.0, 9, 2);
      shedLamp.position.set(cx - 6.2, 3.6, cz + 1.6);
      root.add(shedLamp);
    }

    // 玄関の庇と看板
    box(2.0, 0.26, 4.4, M.concreteDark, cx - w / 2 - 1.0, 2.95, cz, 0, 1.6);
    box(0.2, 2.95, 0.2, M.metal, cx - w / 2 - 1.8, 0, cz - 1.8, 0, 1.0);
    box(0.2, 2.95, 0.2, M.metal, cx - w / 2 - 1.8, 0, cz + 1.8, 0, 1.0);
    sign(3.0, 1.0, cx - w / 2 - 0.4, 3.4, cz + 4.4, -Math.PI / 2, M.rust);

    const ry0 = h + 0.5;
    waterTank(cx + 4.4, ry0, cz + 4.2, 1.25, 2.1);
    ductRun(cx - 3.4, ry0, cz + 1.0, Math.PI / 2, 6.0);
    // 崩落した北東角に載っていた設備は西へ寄せる（床が無いところに残せない）
    acUnit(cx - 6.2, ry0, cz - 5.4, 1.4);
    acUnit(cx - 6.2, ry0, cz - 4.2, 1.4);
    antennaMast(cx - 6.8, ry0, cz + 5.6, 4.4);
    // 屋上の土嚢陣地。撃ち下ろす側にも遮蔽を用意する
    for (let i = 0; i < 6; i++) {
      const u = (i - 2.5) * 0.99;
      const h0 = sandbagAt(cx + u, ry0, cz - 6.4, rr(-0.12, 0.12), rr(0.94, 1.06), rr(0.84, 0.93));
      if (i > 0 && i < 5) {
        sandbagAt(cx + u + 0.5, ry0 + h0 - 0.055, cz - 6.4, rr(-0.18, 0.18), rr(0.94, 1.06), rr(0.92, 1.0));
      }
    }
    rubble(cx - 2.0, cz + 5.4, 1.3, 5, [M.concrete, M.brick]);

    downpipe(cx - w / 2 - 0.35, 0, cz - d / 2 + 0.4, 6.0);
    downpipe(cx + w / 2 + 0.35, 0, cz + d / 2 - 0.4, 6.0);
    gutter(w + 1.0, cx, h + 0.15, cz + d / 2 + 0.62, 0);
    ladder(cx + w / 2 + 0.3, 0, cz + 4.6, 5.4, Math.PI / 2);
    cabinet(cx + w / 2 + 0.55, cz - 2.0, Math.PI / 2);
    pipeRun(13.0, 0.15, cx + w / 2 + 0.9, 3.6, cz, Math.PI / 2, M.rust, false);
  }

  /* -------------------------------------------- 倉庫（北東・波板の棟） */
  // レンガの腰壁に波板を載せた大箱。南面を大きく開けて中も撃ち合いの場にする
  {
    const cx = 24, cz = -25, w = 22, d = 13, h = 7.0, t = 0.5;
    const kick = 1.4;   // 腰壁の高さ
    band(w + 1.0, d + 1.0, 0.45, 1.1, M.concrete, cx, 0, cz, 2.5);
    // 南面: シャッターの大開口
    wallRun(M.brick, cx, cz + d / 2, 0, w, kick, t, [{ u: -3.0, w: 8.0, y0: 0, y1: kick }], 2.2);
    wallRun(M.corr, cx, cz + d / 2, 0, w, h - kick, t, [
      { u: -3.0, w: 8.0, y0: 0, y1: 4.0 },
      { u: 7.0, w: 5.0, y0: 2.6, y1: 4.2, trim: false },
    ], 2.6, kick);
    // 北面: 高窓だけ
    wallRun(M.brick, cx, cz - d / 2, 0, w, kick, t, [], 2.2);
    wallRun(M.corr, cx, cz - d / 2, 0, w, h - kick, t, [
      { u: -7, w: 4.4, y0: 2.6, y1: 4.2, trim: false },
      { u: 0, w: 4.4, y0: 2.6, y1: 4.2, trim: false },
      { u: 7, w: 4.4, y0: 2.6, y1: 4.2, trim: false },
    ], 2.6, kick);
    // 西面: 人が出入りする戸
    wallRun(M.brick, cx - w / 2, cz, Math.PI / 2, d, kick, t, [{ u: 0, w: 2.2, y0: 0, y1: kick }], 2.2);
    wallRun(M.corr, cx - w / 2, cz, Math.PI / 2, d, h - kick, t, [
      { u: 0, w: 2.2, y0: 0, y1: 1.6 },
      { u: -4.6, w: 3.0, y0: 2.8, y1: 4.2, trim: false },
    ], 2.6, kick);
    wallRun(M.brick, cx + w / 2, cz, Math.PI / 2, d, kick, t, [], 2.2);
    wallRun(M.corr, cx + w / 2, cz, Math.PI / 2, d, h - kick, t, [
      { u: -4.0, w: 3.0, y0: 2.8, y1: 4.2, trim: false },
      { u: 4.0, w: 3.0, y0: 2.8, y1: 4.2, trim: false },
    ], 2.6, kick);
    cornerChamfer(M.brick, cx, cz, w + t, d + t, kick);
    cornerChamfer(M.corr, cx, cz, w + t, d + t, h - kick, kick, 0.13);
    // 屋根。3棟とも「箱+パラペット+屋上設備」で揃うと俯瞰で一目で同じレシピだと分かる。
    // 倉庫だけ屋根の形をのこぎり屋根に変えて、輪郭の読みを他の2棟から引き離す。
    // 採光面を北向き(-Z)にするのは実在の工場と同じ理由で、直射が入らず光が安定するため
    box(w + 1.2, 0.35, d + 1.2, M.corr, cx, h, cz, 0, 3.2);
    {
      const roofY = h + 0.35;
      const bays = 3, pitch = 2.7, gh = 1.45;
      const swW = w - 2.2;                                  // 東西の端は点検通路として残す
      const swAng = Math.atan2(gh, pitch);
      const swSpan = Math.hypot(gh, pitch);
      for (let i = 0; i < bays; i++) {
        const z0 = cz - 5.9 + i * pitch;                    // 立ち上がりは北端から南へ刻む
        box(swW, gh, 0.2, M.rust, cx, roofY, z0, 0, 1.6);   // 採光面の枠
        emit(new THREE.PlaneGeometry(swW - 0.5, gh - 0.3), glassMat,
          cx, roofY + gh / 2, z0 - 0.12, 0, 0, 0, false);
        // 屋根面。rxを正にすると-Z側の端が持ち上がるので、北が高く南へ下る向きになる
        boxT(swW, 0.16, swSpan, M.corr, cx, roofY + gh / 2, z0 + pitch / 2, 0, swAng, 0, 2.4);
        // 妻側の塞ぎ。無いと断面が抜けて板を並べただけに見える
        for (const s of [-1, 1]) {
          boxT(0.14, gh * 0.55, pitch * 0.98, M.corr,
            cx + s * swW / 2, roofY + gh * 0.28, z0 + pitch / 2, 0, 0, 0, 1.4);
        }
      }
      // 谷樋。のこぎり屋根は谷ごとに樋が要るので、入れると一気に工場らしくなる
      for (let i = 0; i < bays; i++) {
        boxD(swW, 0.14, 0.22, M.rust, cx, roofY + 0.07, cz - 5.9 + i * pitch - 0.22, 0, 1.0);
      }
    }
    // 屋根の縁の低い立ち上がり。落ちにくくしつつ伏せられる高さにする
    wallRun(M.rust, cx, cz - d / 2 - 0.4, 0, w + 1.2, 0.55, 0.24, [], 1.6, h + 0.35);
    wallRun(M.rust, cx, cz + d / 2 + 0.4, 0, w + 1.2, 0.55, 0.24, [], 1.6, h + 0.35);
    wallRun(M.rust, cx - w / 2 - 0.5, cz, Math.PI / 2, d + 1.2, 0.55, 0.24,
      [{ u: 2.0, w: 2.6, y0: 0, y1: 0.55 }], 1.6, h + 0.35);

    // 屋根の設備。のこぎり屋根が cz-5.9 から cz+2.2 までを占めるので、
    // 全部その南側へ寄せる。屋根面に埋めると妻側の塞ぎを突き抜けて形が読めなくなる
    const ry0 = h + 0.35;
    waterTank(cx + 7.4, ry0, cz + 5.4, 1.5, 2.6);
    ductRun(cx - 6.6, ry0, cz + 3.0, Math.PI / 2, 5.0);
    acUnit(cx + 3.2, ry0, cz + 4.6, 0);
    acUnit(cx + 4.5, ry0, cz + 4.6, 0);
    antennaMast(cx + 10.0, ry0, cz + 6.0, 5.0);
    for (let i = 0; i < 4; i++) cyl(0.34, 0.8, 8, M.metal, cx - 9.0 + i * 1.6, ry0, cz + 5.6, 2);
    gutter(w + 1.2, cx, h + 0.1, cz + d / 2 + 0.75, 0);
    gutter(w + 1.2, cx, h + 0.1, cz - d / 2 - 0.75, 0);
    downpipe(cx + w / 2 + 0.3, 0, cz + d / 2 - 0.5, 7.0);
    downpipe(cx - w / 2 - 0.3, 0, cz - d / 2 + 0.5, 7.0);
    ladder(cx + w / 2 + 0.3, 0, cz - 1.5, 6.9, Math.PI / 2);
    sign(6.0, 1.8, cx + 4.0, 4.6, cz + d / 2 + 0.45, 0, M.corr, false,
      signFace('WAREHOUSE 4', 'HARDHAT AREA', '#c0a02a', '#1a1408', 29));
    pipeRun(16.0, 0.2, cx, 1.9, cz - d / 2 - 0.95, 0, M.rust);
    cabinet(cx - w / 2 - 0.55, cz + 4.6, -Math.PI / 2);

    // 荷捌き場。トラック床の高さの台で、胸を出して撃てる位置になる
    box(16, 1.15, 3.8, M.concrete, cx - 1.0, 0, cz + d / 2 + 1.9, 0, 2.5);
    box(16.4, 0.16, 0.3, M.rust, cx - 1.0, 1.15, cz + d / 2 + 3.75, 0, 1.2);
    stepBlocks(cx + 8.8, cz + d / 2 + 1.9, -Math.PI / 2, 2, M.concrete, 0.58, 0.9, 3.4);
    // 荷捌き場の庇。単純な直方体+パラペットのシルエットを1枚崩し、
    // 同時にドックへ影を落として「ただ明るいだけの面」を無くす
    boxT(17.5, 0.2, 4.7, M.corr, cx - 1.0, 4.0, cz + d / 2 + 1.7, 0, 0.21, 0, 2.6);
    boxT(17.7, 0.14, 0.26, M.rust, cx - 1.0, 3.52, cz + d / 2 + 3.95, 0, 0, 0, 1.2);
    for (const sx of [-7.4, 0.4, 7.2]) {
      box(0.14, 2.35, 0.14, M.rust, cx - 1.0 + sx, 1.15, cz + d / 2 + 3.5, 0, 0.8);
      boxT(0.11, 0.11, 1.35, M.rust, cx - 1.0 + sx, 3.2, cz + d / 2 + 3.1, 0, 0.7, 0, 0.6);
    }
    palletStack(cx + 3.2, cz + d / 2 + 2.0, 0.3, 3, 1.15);
    jersey(cx - 5.0, cz + d / 2 + 5.0, 0);
    drum(cx + 5.4, cz + d / 2 + 5.4, M.rust);

    // 中身: パレットラック。屋内にも高さと視線の切れ目を作る
    for (const rz of [cz - 3.2, cz + 2.4]) {
      for (let i = 0; i < 5; i++) {
        const px = cx - 8.0 + i * 3.6;
        box(0.16, 4.4, 0.16, M.rust, px, 0, rz - 0.5, 0, 1.0);
        box(0.16, 4.4, 0.16, M.rust, px, 0, rz + 0.5, 0, 1.0);
      }
      for (const by of [1.5, 3.0]) {
        box(14.4, 0.14, 0.14, M.rust, cx - 0.8, by, rz - 0.5, 0, 1.2);
        box(14.4, 0.14, 0.14, M.rust, cx - 0.8, by, rz + 0.5, 0, 1.2);
      }
      for (let i = 0; i < 3; i++) {
        pallet(cx - 6.0 + i * 3.6, 1.64, rz, 0);
        crate(1.0, 0.9, cx - 6.0 + i * 3.6, 1.8, rz, rr(-0.1, 0.1));
      }
      pallet(cx + 1.6, 3.14, rz, 0);
      crate(1.1, 1.0, cx + 1.6, 3.3, rz, 0.2);
    }
    // 屋内の現場事務所。南側に木箱を2つ寄せて屋根(2.44)まで登れるようにしてある。
    // ラックの支柱を避けて置かないと箱と柱がめり込む
    box(4.2, 2.2, 3.2, M.plaster, cx + 8.6, 0, cz - 3.6, 0, 2.0);
    box(4.5, 0.24, 3.5, M.metal, cx + 8.6, 2.2, cz - 3.6, 0, 1.6);
    box(1.6, 0.9, 0.1, M.metal, cx + 8.6, 1.1, cz - 2.05, 0, 1.0);
    crate(1.1, 0.85, cx + 8.6, 0, cz + 0.0, 0.3);
    crate(1.2, 1.6, cx + 8.6, 0, cz - 1.2, 0.6);
    crate(1.3, 1.3, cx + 6.2, 0, cz - 5.2, 0.4);
    drum(cx - 9.4, cz + 4.2, M.metalRed);
    drum(cx - 8.5, cz + 5.0, M.rust);
    drumTipped(cx - 7.0, cz + 4.6, 0.6, M.metalRed);
    // 屋内の床。土間にすると屋外の舗装と切れて、シャッターの奥が空間として読める
    patch(20.0, 11.6, M.dirt, cx, cz, 0.02, 0.038, 7, 11);
    // 吊り下げの照明。のこぎり屋根の採光だけだと、南から覗いた時に奥が黒く沈む
    for (const lx of [cx - 5.5, cx + 3.0]) {
      cyl(0.028, 0.9, 5, M.metal, lx, h - 1.0, cz - 1.0, 2, false);
      emit(new THREE.PlaneGeometry(0.9, 0.9), lampMat, lx, h - 1.05, cz - 1.0, 0, Math.PI / 2, 0, false, false);
      boxD(1.05, 0.12, 1.05, M.rust, lx, h - 1.0, cz - 1.0, 0, 0.5);
    }
    // 灯具は2つでも点光源は1つ。全フラグメントで評価される物を増やしたくない
    if (lamps) {
      const warehouseLamp = new THREE.PointLight(0xffc089, 10.0, 13, 2);
      warehouseLamp.position.set(cx - 1.2, h - 1.4, cz - 1.0);
      root.add(warehouseLamp);
    }
  }

  /* ------------------------------------------------- 海上コンテナ群 */
  // 海上コンテナ。全部同じ寸法・同じディテールだと、遠目に色付きの箱が並ぶだけになる。
  // 長さを3種に振り、角金具とトップレール、そして波板を「実ジオメトリ」で起こす。
  // 法線マップだけの波は浅い角度で見た時に立体的にずれないので、板に印刷した縞に見える
  const containerBody = (x, z, ry, mat, stack = 1, len = 6.1, opts = {}) => {
    const dx = Math.cos(ry);
    const dz = -Math.sin(ry);
    const px = Math.sin(ry);      // 妻面の幅方向
    const pz = Math.cos(ry);
    const W = 2.44, H = 2.6;
    const ribN = Math.max(4, Math.round((len - 0.7) / 0.3));
    const ribStep = (len - 0.7) / ribN;
    for (let i = 0; i < stack; i++) {
      const yb = i * 2.62;
      // 潰れた個体を混ぜる。寸法違いと色違いだけでは「同じ型の箱」から抜けられない。
      // 天板が落ちて胴が縮んだ個体が1つあるだけで、列全体が量産品に見えなくなる
      const crushed = !!opts.crush && i === stack - 1;
      const HH = crushed ? H - 0.42 : H;
      box(len - 0.1, HH, W - 0.1, mat, x, yb, z, ry, 2.2);
      // 縦リブ。1本あたり12三角形で、結合されるので描画コールは増えない
      for (let k = 0; k < ribN; k++) {
        const u = -(len - 0.7) / 2 + (k + 0.5) * ribStep;
        for (const s of [-1, 1]) {
          boxD(0.14, HH - 0.26, 0.06, mat,
            x + dx * u + px * s * (W / 2 - 0.03), yb + 0.13,
            z + dz * u + pz * s * (W / 2 - 0.03), ry, 0.8);
        }
      }
      box(len + 0.1, 0.14, W + 0.1, M.rust, x, yb + HH, z, ry, 1.6);      // 天端と地際の見切り
      box(len + 0.1, 0.14, W + 0.1, M.rust, x, yb, z, ry, 1.6);
      // トップ/ボトムレール。長辺の見切りが1本通ると箱が「構造物」に見える
      for (const s of [-1, 1]) {
        for (const by of [yb + 0.14, yb + HH - 0.12]) {
          boxD(len - 0.36, 0.12, 0.1, M.rust,
            x + px * s * (W / 2 + 0.02), by, z + pz * s * (W / 2 + 0.02), ry, 0.8);
        }
      }
      // 8隅の角金具(corner casting)。実物で必ず目に入る部品
      for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
          for (const by of [yb + 0.02, yb + HH - 0.2]) {
            // 飾り扱い。本体の箱で衝突は取れているので、Octreeに小片を足す意味がない
            boxD(0.2, 0.18, 0.2, M.metal,
              x + dx * su * (len / 2 - 0.11) + px * sv * (W / 2 - 0.11), by,
              z + dz * su * (len / 2 - 0.11) + pz * sv * (W / 2 - 0.11), ry, 0.5);
          }
        }
      }
      if (crushed) {
        // 落ちた天板。平らな面を潰さずに残すと、ただ背の低い箱にしか見えない
        boxT(len * 0.52, 0.1, W - 0.22, mat, x - dx * len * 0.2, yb + HH + 0.15,
          z - dz * len * 0.2, ry, 0.13, 0.06, 1.8, false);
        boxT(len * 0.42, 0.1, W - 0.3, mat, x + dx * len * 0.26, yb + HH + 0.09,
          z + dz * len * 0.26, ry, -0.18, 0.1, 1.8, false);
        boxT(len * 0.22, 0.09, W - 0.5, M.rust, x + dx * len * 0.02, yb + HH + 0.28,
          z + dz * len * 0.02, ry + 0.25, 0.3, 0.14, 1.2, false);
      }
      // 天端の見切りとトップレールの継ぎ目から下へ落ちる錆。
      // 鉄の箱は必ず上の縁から錆が垂れる。全面が均一に錆びることはない
      for (const s of [-1, 1]) {
        const r1 = hash3(x + s * 2.1, yb + i, z - s * 1.3);
        if (r1 < 0.35) continue;
        const uu = (r1 - 0.5) * len * 0.75;
        rustRun(x + dx * uu + px * s * (W / 2 + 0.05), yb + HH - 0.08,
          z + dz * uu + pz * s * (W / 2 + 0.05),
          s > 0 ? ry : ry + Math.PI, 0.30, 0.7 + r1 * 1.1);
      }

      // 妻面の扉と鎖錠棒。のっぺりした箱に向きが出る
      const opened = !!opts.open && i === 0;
      if (opened) {
        // 片側だけ振り出した扉。開いた個体が1つ混ざると、
        // 「同じ向きの箱が並んでいる」読みが崩れて荷役の跡が出る
        const hx = x + dx * (len / 2 + 0.1) + px * (W / 2 - 0.06);
        const hz = z + dz * (len / 2 + 0.1) + pz * (W / 2 - 0.06);
        const oa = ry - Math.PI / 2 + 1.05;
        const hw = W / 4 - 0.05;
        boxT(W / 2 - 0.1, HH - 0.34, 0.09, M.rust,
          hx + Math.cos(oa) * hw, yb + HH / 2 - 0.02, hz - Math.sin(oa) * hw, oa, 0, 0, 1.2, false);
        boxD(0.11, HH - 0.34, W / 2 - 0.08, M.rust,
          x + dx * (len / 2 + 0.04) - px * (W / 4), yb + 0.17,
          z + dz * (len / 2 + 0.04) - pz * (W / 4), ry, 1.2);
      } else {
        box(0.12, HH - 0.3, 2.3, M.rust, x + dx * (len / 2 + 0.03), yb + 0.15, z + dz * (len / 2 + 0.03), ry, 1.2);
        for (const s of [-0.62, 0.62]) {
          boxD(0.1, HH - 0.4, 0.1, M.metal,
            x + dx * (len / 2 + 0.13) + px * s, yb + 0.2, z + dz * (len / 2 + 0.13) + pz * s, ry, 0.6);
        }
        for (const s of [-0.62, 0.62]) {   // 鎖錠棒のハンドル
          boxD(0.22, 0.09, 0.09, M.metal,
            x + dx * (len / 2 + 0.2) + px * s, yb + 1.2, z + dz * (len / 2 + 0.2) + pz * s, ry, 0.4);
        }
      }
    }
    if (opts.open) {
      // 降ろした荷。扉の前に中身が転がっていないと、開けただけで話が終わる
      for (let c = 0; c < 3; c++) {
        const cu = len / 2 + 1.5 + c * 1.2;
        const jw = 0.72 + hash3(x + c * 1.7, 3.1, z) * 0.55;
        const off = (hash3(c * 2.3, x, z) - 0.5) * 1.6;
        crate(jw, jw * 0.86, x + dx * cu + px * off, 0, z + dz * cu + pz * off,
          ry + (hash3(z, c * 3.1, x) - 0.5) * 1.4);
      }
      mark(x + dx * (len / 2 + 2.3), z + dz * (len / 2 + 2.3), 2.6, 0.95);
    }
    mark(x, z, Math.max(len, W) * 0.62, 1.0);
  };
  containerBody(-8, 24, 0.15, M.metalRed, 2);
  containerBody(-14, 20, 1.35, M.corr, 1, 6.1, { crush: true });
  // 戦域内（半径20m）のコンテナは180度回した対で置く（戦域の対称化）
  containerBody(12, -12, -0.2, M.metal, 2);
  containerBody(-12, 12, -0.2 + Math.PI, M.metal, 2);
  containerBody(16, -6, 1.55, M.metalRed, 1);
  containerBody(-16, 6, 1.55 + Math.PI, M.metalRed, 1);
  containerBody(-26, 6, 0.05, M.corr, 1, 2.9);
  containerBody(-22, 10, 1.5, M.metalRed, 2);
  containerBody(30, 4, 0.9, M.metal, 1, 6.1, { open: true });
  containerBody(4, 32, 0.0, M.corr, 1, 6.1, { open: true });
  containerBody(-34, -6, 1.57, M.metal, 2);
  // 二段積みへ登る段差。天端は5.36なので6段(4.68)まで刻まないと届かない。
  // 下段の天端2.74は上段の底になっていて足場にならない
  stepBlocks(-8.0, 16.7, 0, 6, M.concrete, 0.78, 1.0, 1.7);
  // ↑の180度回した対。西側は二段積みコンテナへの登り口で、東側は同じ形の遮蔽
  stepBlocks(8.0, -16.7, Math.PI, 6, M.concrete, 0.78, 1.0, 1.7);
  stepBlocks(-22.0, 0.87, 0, 6, M.concrete, 0.78, 1.0, 1.7);

  /* 掩体の屋上へ東から渡す線（コンテナ＋段差＋渡り板）はやめた（2026-08-14）。
     東の組だけ登り口が2本あることになって対称が崩れるのと、
     東西へ斜路を1本ずつ通した今は役目が重なるため。
     ここに在った物: containerBody(13.5,0) / stepBlocks(13.5,-7.22) / plank(9.0,3.9) */

  /* ------------------------------------ 倉庫の屋根へ上がるコンテナ段 */
  // 段差(2.34) → コンテナ天端(2.6) → 渡り板 → 二段積み(5.22) → 渡り板 → 屋根(7.35)
  containerBody(9.8, -19.0, Math.PI / 2, M.corr, 1);
  containerBody(9.8, -27.0, Math.PI / 2, M.metalRed, 2);
  stepBlocks(5.13, -19.0, Math.PI / 2, 3, M.concrete);
  // ↑の段差の180度回した対（北側は同じ形の遮蔽として置く。戦域の対称化）
  stepBlocks(-5.13, 19.0, -Math.PI / 2, 3, M.concrete);
  plank(1.5, 4.05, 2.62, M.metal, 9.8, 2.74, -21.93, Math.PI);
  plank(1.6, 3.4, 1.99, M.metal, 10.7, 5.36, -27.0, Math.PI / 2);

  /* ------------------------------------------------------ 木箱・土嚢 */
  // 内部レイアウトを固定にすると、同じ山が7個並んで露骨な複製に見える。
  // 箱数・寸法・傾き・崩れた側板の有無を全部種から振り、重なった分だけ上に積む
  // 寸法は連続乱数をやめて3ロットから引く。倉庫に置かれる木箱は同じ規格品が
  // 揃うほうが正しいうえ、3種しか無いほうが「差」として読める。
  // 向きの振れは±0.18に絞る代わりにrx/rzを入れて水平を崩す（積んだ物は必ず傾く）
  const CRATE_LOT = [0.8, 1.1, 1.4];
  const crateStack = (x, z, ry) => {
    const n = 4 + Math.floor(rnd() * 5);
    const placed = [];
    for (let i = 0; i < n; i++) {
      const s = CRATE_LOT[Math.floor(rnd() * 3)];
      const hgt = s * rr(0.84, 1.0);
      const ox = rr(-1.7, 1.7), oz = rr(-1.7, 1.7);
      let yb = 0;
      for (const c of placed) {
        // 隣接箱と2〜4cmの隙間を空ける。ぴったり接すると1枚の壁になる
        if (Math.abs(c.x - ox) < (c.s + s) * 0.48 && Math.abs(c.z - oz) < (c.s + s) * 0.48) {
          yb = Math.max(yb, c.top);
        }
      }
      if (yb > 2.9) yb = 0;      // 積み過ぎて塔にならないよう地面へ戻す
      crate(s, hgt, x + ox, yb, z + oz, ry + rr(-0.18, 0.18));
      placed.push({ x: ox, z: oz, s: s + 0.06, top: yb + hgt + 0.02 });
    }
    // 崩れて立てかかった側板
    if (rnd() < 0.75) {
      boxT(rr(1.0, 1.5), 0.11, rr(0.8, 1.2), M.wood,
        x + rr(-2.4, 2.4), rr(0.3, 0.6), z + rr(-2.4, 2.4),
        ry + rr(-1.2, 1.2), rr(0.25, 0.55), rr(-0.2, 0.2), 1.0);
    }
    mark(x, z, 3.1, 1.0);
  };
  // 戦域内（半径20m）の山は180度回した対で置く（戦域の対称化）。
  // 中身の乱数は種から回るので対の山は同じ形にならないが、
  // 「その場所に胸の高さの遮蔽の塊がある」という戦い方の意味は揃う
  crateStack(-4, 14, 0.2);
  crateStack(4, -14, 0.2);
  crateStack(13.5, 7.5, 1.1);
  crateStack(-13.5, -7.5, 1.1);
  crateStack(-16, -6, 0.7);
  crateStack(16, 6, 0.7);
  crateStack(5, -23, 2.0);
  crateStack(-30, 26, 0.4);
  crateStack(31, -4, 1.4);
  crateStack(-6, 33, 0.9);

  // 土嚢の壁。袋を1〜2個抜いて崩れた箇所を作り、抜いた袋は足元に転がす
  // 上下段のピッチを半分ずらして目地を互い違いにする。真上に重ねると
  // 縦の継ぎ目が通って積んだ物に見えず、袋を1個ずつ置いた列に見える。
  // 隣接も4〜5cm食い込ませて接触面を潰す
  const sandbagWall = (x, z, ry, len = 5) => {
    const gapAt = 1 + Math.floor(rnd() * Math.max(1, len - 2));
    const dx = Math.cos(ry), dz = -Math.sin(ry);
    const pitch = 0.99;
    for (let i = 0; i < len; i++) {
      const t = (i - (len - 1) / 2) * pitch;
      const bx = x + dx * t;
      const bz = z + dz * t;
      // 下段は上の重みで潰れる
      const h0 = sandbagAt(bx, 0, bz, ry + rr(-0.12, 0.12), rr(0.94, 1.06), rr(0.84, 0.93));
      if (i > 0 && i < len - 1 && i !== gapAt) {
        // 半ピッチずらして目地を互い違いに。接触ぶん少し沈める
        const ux = bx + dx * pitch * 0.5, uz = bz + dz * pitch * 0.5;
        sandbagAt(ux + rr(-0.05, 0.05), h0 - 0.055, uz + rr(-0.05, 0.05),
          ry + rr(-0.18, 0.18), rr(0.94, 1.06), rr(0.92, 1.0));
      }
      if (i === gapAt) {
        // 崩れて落ちた袋。列の途中が欠けるだけで陣地に使われた跡になる。
        // 地面に落ちた袋は一番潰れる
        sandbagAt(bx + Math.sin(ry) * 0.85, 0, bz + Math.cos(ry) * 0.85,
          ry + rr(-1.2, 1.2), 0.98, 0.74);
      }
    }
    mark(x, z, len * 0.6, 0.9);
  };
  // 陣地の向きは壁に対して正確な直角にしない。人が積んだ物が図面通りに
  // 揃っていると、それだけで配置がプログラムの産物だと分かる。
  // 戦域内（半径20m）の陣地は180度回した対で置く（戦域の対称化）
  // 南北の陣地もx=0の通り道から外へ寄せる（列の半分＋袋のはみ出しでx=0に届いていた）
  sandbagWall(-4.5, -16, 0.06, 6);
  sandbagWall(4.5, 16, 0.06, 6);
  sandbagWall(20, 0, Math.PI / 2 + 0.07, 5);
  sandbagWall(-20, 0, Math.PI / 2 + 0.07, 5);
  sandbagWall(-24, 16, 0.5, 4);
  sandbagWall(6, 20, Math.PI / 2 - 0.09, 5);
  sandbagWall(-6, -20, Math.PI / 2 - 0.09, 5);
  sandbagWall(33, -16, 0.1, 4);
  sandbagWall(-12, 34, Math.PI / 2 + 0.11, 4);

  /* ----------------------------------------------- 柱・ドラム缶・配管 */
  // 戦域内（半径20m）のドラム缶は180度回した対で置く（戦域の対称化）
  [[-6, 8, 0], [6, -8, 0], [-7.2, 9.1, 1], [7.2, -9.1, 1],
   [14, 18, 2], [-14, -18, 2], [15.1, 17.2, 0], [-15.1, -17.2, 0],
   [-19, -2, 1], [19, 2, 1],
   [26, -14, 2], [27, -12.8, 0], [2, -30, 1], [-12, 30, 2], [34, 12, 0],
   [-36, 30, 1], [18, 30, 2], [-2, -34, 0]]
    .forEach(([x, z, k]) => drum(x, z, k === 0 ? M.metalRed : k === 1 ? M.rust : M.metal));
  drumTipped(-5.0, 10.2, 0.5, M.rust);
  drumTipped(5.0, -10.2, 0.5 + Math.PI, M.rust);
  drumTipped(25.6, -13.0, 1.2, M.metal);
  drumTipped(1.2, -31.2, 0.2, M.metalRed);
  drumTipped(-13.0, 31.4, 2.0, M.rust);

  [[-33, 33], [33, -33], [33, 33], [-33, -33]].forEach(([x, z]) => {
    emit(cylGeo(0.55, 0.62, 9, 12, 4, 2), M.concrete, x, 4.5, z);
    box(1.5, 0.5, 1.5, M.concreteDark, x, 0, z, 0, 1.6);        // 柱脚
    box(1.3, 0.35, 1.3, M.concreteDark, x, 9.0, z, 0, 1.6);     // 柱頭
  });

  /* -------------------------------------------- 廃墟（南西・レンガ） */
  // 崩れた壁と瓦礫。天井が抜けているので上から撃たれる場所を作る
  {
    // 廃墟の開口はガラスを張らない（割れて抜けている想定。枠だけ残す）
    wallRun(M.brick, -35, 18, Math.PI / 2, 12, 3.2, 0.6, [
      { u: -3.4, w: 1.6, y0: 1.1, y1: 2.6, glass: false },
      { u: 2.2, w: 1.6, y0: 1.1, y1: 2.6, glass: false },
    ], 2.4);
    box(4.0, 1.6, 0.6, M.brick, -35, 3.2, 14.0, Math.PI / 2, 2.4);      // 崩れ残った天端
    wallRun(M.brick, -30, 12.6, 0, 10, 2.6, 0.6, [
      { u: -2.6, w: 1.8, y0: 0, y1: 2.1 },
      { u: 2.8, w: 1.5, y0: 1.0, y1: 2.2, glass: false },
    ], 2.4);
    box(2.4, 1.1, 0.6, M.brick, -33.4, 2.6, 12.6, 0, 2.4);
    wallRun(M.brick, -30.5, 23.6, 0, 9, 1.55, 0.6, [], 2.4);            // 胸の高さで折れた壁
    box(11, 0.32, 12, M.concrete, -30.2, 0, 18.2, 0, 3.0);              // 床スラブ
    // 崩れた床が斜面になっている。ここから壁の天端(2.6)へ登れる
    plank(3.4, 4.6, 2.45, M.concrete, -31.8, 0.32, 15.6, Math.PI);
    box(3.6, 0.4, 3.0, M.concrete, -31.8, 2.4, 12.9, 0, 2.5);
    boxT(4.6, 0.34, 3.4, M.concrete, -27.0, 1.35, 20.0, 0.5, 0.42, 0.12, 2.0);   // 落ちた屋根版
    box(0.45, 2.8, 0.45, M.concrete, -27.6, 0, 16.4, 0, 1.4);
    box(0.45, 2.2, 0.45, M.concrete, -33.0, 0, 21.6, 0, 1.4);
    rubble(-29.5, 17.0, 3.0, 14, [M.brick, M.concrete, M.dirt]);
    rubble(-34.0, 21.5, 2.2, 9, [M.brick, M.concrete]);
    rubble(-25.5, 13.5, 1.8, 7, [M.brick, M.dirt]);
    drum(-33.2, 15.0, M.rust);
    drumTipped(-32.0, 16.2, 1.1, M.rust);
    wireCoil(-26.5, 24.2, 0.4, 5);
    sign(2.6, 1.0, -35.4, 2.0, 22.0, Math.PI / 2, M.rust);
    jerseyLine(-24.0, 22.0, Math.PI / 2, 3);
  }

  /* --------------------------------------------- 資材置場（西）と電柱 */
  {
    palletStack(-30.5, -1.5, 0.3, 4);
    palletStack(-29.0, -3.0, 1.1, 4);
    palletStack(-32.0, -4.4, 0.6, 3);
    cableSpool(-27.5, -8.0, 0.4);
    cableSpool(-28.6, -10.0, 1.2);
    drum(-31.4, -11.0, M.rust);
    drum(-30.4, -11.8, M.metalRed);
    drum(-32.2, -12.2, M.metal);
    rubble(-26.0, -13.5, 2.4, 10, [M.concrete, M.brick, M.dirt]);
    // 波板の物置。全身が隠れる高さの小屋をひとつ置いて視線を切る
    box(5.0, 2.3, 3.4, M.corr, -35.0, 0, -16.0, 0.12, 2.4);
    box(5.4, 0.3, 3.8, M.rust, -35.0, 2.3, -16.0, 0.12, 1.8);
    box(5.2, 0.5, 3.6, M.brick, -35.0, 0, -16.0, 0.12, 2.0);
    ladder(-32.6, 0, -16.0, 2.2, Math.PI / 2);
    stepBlocks(-30.31, -16.0, -Math.PI / 2, 2, M.concrete, 0.85, 1.0, 1.8);
    jerseyLine(-24.5, -4.0, Math.PI / 2, 4);
    utilityPole(-30.0, 3.0);
    utilityPole(-30.0, -20.0);
    utilityPole(-30.0, -32.0);
    wire(-31.3, 7.5, 3.0, -31.3, 7.5, -20.0, 1.1);
    wire(-28.7, 7.5, 3.0, -28.7, 7.5, -20.0, 1.1);
    wire(-30.0, 6.7, 3.0, -30.0, 6.7, -20.0, 1.3);
    wire(-31.3, 7.5, -20.0, -31.3, 7.5, -32.0, 0.8);
    wire(-28.7, 7.5, -20.0, -28.7, 7.5, -32.0, 0.8);
  }

  /* ------------------------------------------------ 東側の配管の回廊 */
  // 頭上に架構を通すと画面の上半分が埋まって密度が出る
  {
    // 西の柱は26.5。27だと(30,4)のコンテナと角が噛む
    for (const pz of [-8, 2, 12]) {
      box(0.5, 5.4, 0.5, M.rust, 26.5, 0, pz, 0, 1.6);
      box(0.5, 5.4, 0.5, M.rust, 35.0, 0, pz, 0, 1.6);
      box(9.0, 0.4, 0.4, M.rust, 30.75, 5.4, pz, 0, 1.6);
      box(0.4, 0.4, 1.6, M.rust, 26.5, 5.0, pz, 0, 1.2);
      box(0.4, 0.4, 1.6, M.rust, 35.0, 5.0, pz, 0, 1.2);
    }
    for (const [px, pr] of [[28.4, 0.26], [31.0, 0.34], [33.6, 0.22]]) {
      pipeRun(22.0, pr, px, 5.05 + pr, 2.0, Math.PI / 2, M.rust, false);
    }
    // 地上の配管は短く低く。長く高いと20mの見えない壁になって敵の足が止まる
    pipeRun(8.0, 0.18, 26.0, 0.55, 6.0, Math.PI / 2, M.metal);
    // 点検用の高台。段差から上がれる。(30,4)のコンテナ(z<=7.15)を外して置く
    platform(3.2, 3.0, M.metal, M.metal, 31.0, 2.6, 12.0, 0, ['x-', 'z+']);
    stepBlocks(31.0, 7.5, 0, 3, M.metal, 0.8, 1.0, 2.0);
    jerseyLine(37.0, 4.0, Math.PI / 2, 5);
    cabinet(25.9, 16.0, -Math.PI / 2);
    drum(28.0, 17.4, M.metalRed);
    drum(29.0, 18.2, M.rust);
    rubble(34.0, 18.5, 2.0, 8, [M.concrete, M.brick]);
    palletStack(34.5, -6.0, 0.5, 3);
  }

  /* --------------------------------------------- 北側の広場と電線の道 */
  {
    for (const px of [-16, -2, 12, 26]) utilityPole(px, 36, 8.4, Math.PI / 2);
    for (const s of [-1.15, 0, 1.15]) {
      wire(-16, 7.5, 36 + s, -2, 7.5, 36 + s, 1.0);
      wire(-2, 7.5, 36 + s, 12, 7.5, 36 + s, 1.0);
      wire(12, 7.5, 36 + s, 26, 7.5, 36 + s, 1.0);
    }
    // 波板の待避所。北の広場を割る全身遮蔽
    box(6.0, 0.4, 3.0, M.concrete, 0, 0, 30, 0.1, 2.0);
    box(0.22, 2.5, 0.22, M.metal, -2.7, 0.4, 28.7, 0, 1.0);
    box(0.22, 2.5, 0.22, M.metal, 2.7, 0.4, 28.7, 0, 1.0);
    box(6.2, 2.5, 0.3, M.corr, 0, 0.4, 31.4, 0, 2.0);
    box(6.6, 0.28, 3.4, M.rust, 0, 2.9, 30, 0, 1.8);
    jersey(-3.8, 28.6, 0.2);
    jerseyLine(16, 24.0, 0.1, 4);
    jerseyLine(-20, 30.0, Math.PI / 2, 3);
    rubble(-24, 34, 2.6, 11, [M.concrete, M.brick, M.dirt]);
    rubble(22, 34, 2.2, 9, [M.concrete, M.dirt]);
    wireCoil(30, 30, 0.9, 4);
    sign(4.0, 1.4, 8, 2.6, 34.0, 0.2, M.metalRed, true,
      signFace('KEEP OUT', 'GATE 3 CLOSED', '#a03028', '#f0e6d2', 61));
    box(0.18, 2.6, 0.18, M.metal, 6.4, 0, 34.2, 0.2, 1.0);
    box(0.18, 2.6, 0.18, M.metal, 9.6, 0, 33.8, 0.2, 1.0);
  }

  /* --------------------------------------------------------- 南側 */
  {
    // 低いレンガ塀。胸の高さの遮蔽を横に長く敷いて、寄る/回るの選択を作る
    wallRun(M.brick, -8, -30, 0, 16, 1.15, 0.45, [{ u: 2.0, w: 2.4, y0: 0, y1: 1.15 }], 2.0);
    box(16.4, 0.22, 0.62, M.concrete, -8, 1.15, -30, 0, 1.4);
    // 全身が隠れる塀。天端(2.4)に登れるよう段差を寄せてある
    wallRun(M.brick, 8, -35, Math.PI / 2 + 0.1, 8, 2.4, 0.7, [
      { u: -1.6, w: 1.5, y0: 1.0, y1: 2.0, glass: false },   // 独立塀なのでガラスは張らない
    ], 2.0);
    stepBlocks(11.2, -35.0, -Math.PI / 2, 3, M.concrete);
    jerseyLine(-20, -33, Math.PI / 2, 4);   // 建物Aの外壁に食い込んでいたので北へ寄せた
    jerseyLine(14, -30, 0.05, 4);
    rubble(-15, -34, 2.8, 12, [M.concrete, M.brick, M.dirt]);
    rubble(20, -36, 2.2, 9, [M.brick, M.dirt]);
    palletStack(-22, -34, 0.7, 3);
    cableSpool(-25, -31, 0.2);
    // 立てかけた鉄板と足場板。斜めの線が入ると画面が締まる
    boxT(3.0, 0.16, 2.2, M.corr, -18.5, 1.15, -26.0, 0.6, 0.85, 0, 1.6);
    boxT(2.6, 0.14, 1.8, M.rust, 4.0, 1.0, -27.0, -0.4, 0.9, 0, 1.6);
    drum(-9.0, -27.0, M.rust);
    drumTipped(-10.4, -26.2, 0.8, M.metal);
  }

  /* ------------------------------------------- 建物と掩体の足跡を登録 */
  // 頂点カラーの焼き込みと足元の汚れに使う。大きい物は板を出さず影の濃さだけ効かせる
  mark(0, 0, 11.5, 0.75, false);            // 中央の掩体
  mark(-21, -20, 12.5, 0.8, false);         // 建物A
  mark(23, 21, 11.5, 0.8, false);           // 建物B
  mark(24, -25, 14.0, 0.8, false);          // 倉庫
  mark(-30.2, 18.2, 8.0, 0.7, false);       // 廃墟

  /* --------------------------------------- 広場の縁石・目地・骨材の散り */
  {
    // 縁石。alphaでぼかした縁だけだと段差がゼロのままなので、
    // 2辺だけ実際に立ち上げて影の落ちる線を作る（全周に回すと機械的になる）
    const curb = (len, x, z, ry) => {
      const dx = Math.cos(ry), dz = -Math.sin(ry);
      let u = -len / 2;
      while (u < len / 2) {
        const seg = rr(2.4, 5.2);
        const e = Math.min(u + seg, len / 2);
        box(e - u, 0.16, 0.30, M.concreteDark, x + dx * (u + e) / 2, 0, z + dz * (u + e) / 2, ry, 1.2);
        u = e + rr(0.0, 1.4);   // 欠けた区間を混ぜる
      }
    };
    // 縁石も180度回した対にする（戦域の対称化。16cmの立ち上がりでも
    // 伏せ撃ちの弾は止まるので、片側にしか無いと低い撃ち合いが不公平になる）
    curb(30, 0.5, -17.0, 0);
    curb(30, -0.5, 17.0, 0);
    curb(24, 19.0, 1.0, Math.PI / 2);
    curb(24, -19.0, -1.0, Math.PI / 2);

    // 舗装の目地。等間隔にしないのが肝で、タイルの升目と位相をずらす。
    // 高さもAOも持たない濃い直線を引くだけだと「印刷」に見えるので、
    // 目地の両側にスラブの見付け(3.5cm)を立ててGTAOが拾える谷を作る。
    // 見付けは区間ごとに欠けさせて、縁が1箇所も欠けていない新品にしない
    const joint = (len, x, z, ry) => {
      const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
      const nx = Math.sin(ry), nz = Math.cos(ry);
      // 目地の底。周りより低いのでここが谷になる
      boxD(len, 0.010, 0.09, M.concreteDark, x, 0.021, z, ry, 1.0);
      for (const s of [-1, 1]) {
        let u = -len / 2;
        while (u < len / 2) {
          const seg = rr(1.8, 4.6);
          const e = Math.min(u + seg, len / 2);
          const mu = (u + e) / 2;
          // 飾り扱い。3.6cmの段差を衝突に入れても足は引っかからないが、
          // Octreeの三角形が増えるだけで得が無い
          boxD(e - u, 0.036, 0.22, M.concrete,
            x + dirX * mu + nx * s * 0.155, 0.020, z + dirZ * mu + nz * s * 0.155, ry, 1.2);
          u = e + rr(0.15, 1.1);     // 欠けた区間
        }
      }
    };
    for (const [zz, ln] of [[-9.4, 34], [3.1, 32], [12.6, 28]]) {
      joint(ln, rr(-1.5, 1.5), zz + rr(-0.02, 0.02), rr(-0.012, 0.012));
    }
    for (const xx of [-11.2, 6.4]) {
      joint(30, xx, rr(-1.0, 1.0), Math.PI / 2);
    }

    // 舗装の切れ目に散る骨材。ここが一番「定規で引いた直線」を殺す
    const edgeSpots = [
      [-19, -8], [-19, 6], [-19, 14], [19, -12], [19, 8], [19, 15],
      [-10, -17], [4, -17], [14, -17], [-12, 17], [2, 17], [12, 17],
      [-28, 8], [-30, -11], [24, -17], [31, 10], [-18, -29], [6, 22],
    ];
    for (const [gx, gz] of edgeSpots) gravel(gx, gz, 2.6, 26, [M.concrete, M.concreteDark, M.dirt]);
  }

  /* ------------------------------------------------ 頭上のレイヤー（門型） */
  // 画面の上半分が空だけだと、構図が締まらないうえに遠近の手がかりも消える。
  // 掩体の東西に門型を立て、その間にキャットウォークを渡してフレームを閉じる
  {
    // 節点の添え板(ガセットプレート)とボルト。部材が互いにめり込んでいるだけだと
    // 「組み立てた物」に見えない。3m先でも板が1枚差さっているだけで印象が変わる。
    // 部材幅の3〜4倍のtexScaleを渡すのも肝で、細い斜材に0.4m周期の錆模様が乗ると
    // 縮尺が壊れて全部がワニ革になる
    const gusset = (x, y, z, ry, sz = 0.26) => {
      boxD(sz, sz, 0.022, M.rust, x, y - sz / 2, z, ry, sz * 3.5);
      // ボルト列。4本置くと節点が「留めてある」ことになる
      for (const bu of [-1, 1]) {
        for (const bv of [-1, 1]) {
          boxD(0.035, 0.035, 0.04, M.metal,
            x + Math.cos(ry) * bu * sz * 0.26, y - sz / 2 + bv * sz * 0.26,
            z - Math.sin(ry) * bu * sz * 0.26, ry, 0.12);
        }
      }
    };

    const latticeMast = (x, z, h, ry) => {
      const s = 0.55;
      const dx = Math.cos(ry), dz = -Math.sin(ry);
      const px = Math.sin(ry), pz = Math.cos(ry);
      // 主柱はL型断面。角材1本だとシルエットに段差が無く、逆光で幅0の線に潰れる。
      // 薄板2枚を直角に組むだけで縦のハイライトが1本増える
      for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
          const cx = x + dx * su * s + px * sv * s;
          const cz = z + dz * su * s + pz * sv * s;
          box(0.17, h, 0.035, M.rust, cx - px * sv * 0.067, 0, cz - pz * sv * 0.067, ry, 0.55);
          box(0.035, h, 0.17, M.rust, cx - dx * su * 0.067, 0, cz - dz * su * 0.067, ry, 0.55);
        }
      }
      const n = Math.max(3, Math.round(h / 1.6));
      for (let i = 1; i <= n; i++) {
        const y = (h * i) / (n + 1);
        for (const sv of [-1, 1]) {
          box(s * 2 + 0.15, 0.09, 0.09, M.rust, x + px * sv * s, y, z + pz * sv * s, ry, 0.32);
          box(0.09, 0.09, s * 2 + 0.15, M.rust, x + dx * sv * s, y, z + dz * sv * s, ry, 0.32);
        }
        // 節点の添え板。4本の主柱それぞれに1枚
        for (const su of [-1, 1]) {
          for (const sv of [-1, 1]) {
            gusset(x + dx * su * s + px * sv * s, y, z + dz * su * s + pz * sv * s, ry, 0.24);
          }
        }
      }
      const seg = h / (n + 1);
      const dl = Math.hypot(seg, s * 2);
      const ang = Math.atan2(seg, s * 2);
      for (let i = 0; i < n; i++) {
        const y = (h * (i + 0.5)) / (n + 1);
        const sgn = i % 2 ? 1 : -1;
        for (const sv of [-1, 1]) {
          boxT(dl, 0.07, 0.07, M.rust, x + px * sv * s, y, z + pz * sv * s, ry, 0, ang * sgn, 0.25, false);
        }
      }
      mark(x, z, 2.2, 0.7);
    };

    const latticeBeam = (x, y, z, len, ry, depth = 0.75) => {
      const dx = Math.cos(ry), dz = -Math.sin(ry);
      box(len, 0.13, 0.13, M.rust, x, y, z, ry, 0.45);
      box(len, 0.13, 0.13, M.rust, x, y - depth, z, ry, 0.45);
      const n = Math.max(2, Math.round(len / 1.7));
      for (let i = 0; i <= n; i++) {
        const u = (i / n - 0.5) * len;
        box(0.09, depth, 0.09, M.rust, x + dx * u, y - depth, z + dz * u, ry, 0.32);
        if (i % 2 === 0) gusset(x + dx * u, y - 0.06, z + dz * u, ry + Math.PI / 2, 0.2);
      }
      const seg = len / n;
      const dl = Math.hypot(seg, depth);
      const ang = Math.atan2(depth, seg);
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.5) / n - 0.5) * len;
        boxT(dl, 0.07, 0.07, M.rust, x + dx * u, y - depth / 2 + 0.06, z + dz * u,
          ry, 0, ang * (i % 2 ? 1 : -1), 0.25, false);
      }
    };

    for (const gx of [-16.5, 16.5]) {
      latticeMast(gx, -11.0, 9.6, 0.0);
      latticeMast(gx, 11.0, 9.6, 0.0);
      latticeBeam(gx, 9.5, 0, 22.6, Math.PI / 2, 0.8);
      // 塔頭の受け梁。塔の上端が宙で終わっていると、何を支えているのか画から読めない。
      // キャットウォークの床スラブ(9.55)と高さを合わせて確実に接触させる
      for (const gz of [-11.0, 11.0]) {
        box(1.5, 0.20, 1.5, M.rust, gx, 9.45, gz, 0, 0.7);
      }
      // 桁と塔頭のあいだの方杖(ブレース)。力の流れが見えると構造物として読める
      for (const gz of [-11.0, 11.0]) {
        const sgn = gz > 0 ? -1 : 1;
        // 主柱の位置に合わせて2本。柱の間に浮かせると何も支えていないように見える
        for (const sx of [-0.5, 0.5]) {
          boxT(0.09, 0.09, 1.9, M.rust, gx + sx, 8.75, gz + sgn * 0.75,
            0, Math.PI / 4 * sgn, 0, 0.3, false);
        }
      }
    }
    // 門型どうしを結ぶキャットウォーク。掩体の真上を通す
    box(33.6, 0.12, 1.35, M.metal, 0, 9.55, 0, 0, 2.0);
    railing(33.6, M.metal, 0, 9.67, -0.72, 0);
    railing(33.6, M.metal, 0, 9.67, 0.72, 0);
    // 広場を斜めに横切る電線。西と北にある書き方をそのまま通す
    wire(-16.5, 9.2, -11.6, 16.5, 9.2, 11.6, 1.6);
    wire(-16.5, 9.2, 11.6, 16.5, 9.2, -11.6, 1.6);
    wire(-16.5, 8.4, -11.6, 16.5, 8.4, -11.6, 1.2);
    // 破れた防炎シート。頭上に布が1枚あるだけで空の面積が減る。
    // 以前は吊り元が何にも繋がっておらず、空中に黒い棒が2本浮いていた。
    // 塔から腕木を張り出させて、そこから吊る
    for (const [tx, tz, tw, th, mx] of [[-13.5, -11.0, 4.2, 3.4, -16.5], [12.0, 11.0, 3.6, 2.8, 16.5]]) {
      const dir = mx > tx ? 1 : -1;              // 塔がある側
      const tipX = tx - dir * (tw / 2 + 0.25);   // 腕木の先端（布の反対側の端）
      const barY = 8.62;
      boxD(Math.abs(mx - tipX), 0.10, 0.10, M.rust, (mx + tipX) / 2, barY, tz, 0, 0.35);
      // 腕木を吊る斜材。片持ちの棒が生えているだけだと支えが無い
      wire(mx - dir * 0.55, 9.4, tz, tipX, barY + 0.06, tz, 0.06);

      const g = new THREE.PlaneGeometry(tw, th, 10, 6);
      const gp = g.attributes.position;
      for (let i = 0; i < gp.count; i++) {
        const lx = gp.getX(i), ly = gp.getY(i);
        const fu = lx / tw;                       // -0.5..0.5
        const fv = 0.5 - ly / th;                 // 0=上端 1=下端
        // カテナリー。吊り点の間で垂れ、下端ほど大きく孕む
        gp.setZ(i, (Math.cosh(fu * 2.4) - 1) * -0.22 * (0.35 + fv)
          + fbm2(lx * 1.7, ly * 1.7, 0.9, 2, 331) * 0.22 * fv);
        gp.setY(i, ly - (1 - Math.abs(fu) * 2) * 0.16 * fv);   // 中央が下へ垂れる
      }
      g.computeVertexNormals();
      fxEmit(g, tarpMat, tx, barY - 0.10 - th / 2, tz, 0);
      // ハトメを噛ませた留め金。3箇所で布の上辺が腕木に留まっているのを見せる。
      // wire()は半径4.5cm固定なので、10cmの吊り元に使うと縄が丸太になる
      for (const s of [-0.42, 0, 0.42]) {
        boxD(0.05, 0.16, 0.05, M.metal, tx + s * tw * 0.92, barY - 0.12, tz, 0, 0.12);
      }
    }
  }

  /* ------------------------------------------------------ ヒーロープロップ */
  // 車両が1台も無いと「誰が何に使っていた場所か」が読めない。
  // 視線のアンカーになる大物を要所に置く
  {
    const wreckedTruck = (x, z, ry) => {
      const dx = Math.cos(ry), dz = -Math.sin(ry);
      const px = Math.sin(ry), pz = Math.cos(ry);
      box(5.4, 0.30, 2.05, M.rust, x, 0.62, z, ry, 1.6);                       // シャシー
      box(2.0, 1.42, 2.15, M.metalRed, x + dx * 1.7, 0.92, z + dz * 1.7, ry, 1.4);   // キャブ
      boxT(1.9, 0.5, 1.6, M.metalRed, x + dx * 3.0, 0.95, z + dz * 3.0, ry, 0, 0.22, 1.2);  // 潰れたボンネット
      emit(new THREE.PlaneGeometry(1.7, 0.9), glassMat,
        x + dx * 2.55, 1.72, z + dz * 2.55, ry + Math.PI / 2, 0.32, 0, false);   // 割れ残った風防
      // 荷台。あおりの1枚を外して中が見えるようにする
      box(3.1, 0.14, 2.05, M.rust, x - dx * 1.4, 0.92, z - dz * 1.4, ry, 1.4);
      for (const s of [-1, 1]) {
        if (s > 0) continue;
        box(3.1, 0.72, 0.09, M.rust, x - dx * 1.4 + px * s * 0.98, 1.06, z - dz * 1.4 + pz * s * 0.98, ry, 1.0);
      }
      box(0.09, 0.72, 2.05, M.rust, x - dx * 2.92, 1.06, z - dz * 2.92, ry, 1.0);
      box(3.1, 0.66, 0.09, M.rust, x - dx * 1.4 - px * 0.98, 1.06, z - dz * 1.4 - pz * 0.98, ry, 1.0);
      // 車輪。1本外れて転がっているほうが物語が出る
      for (const [du, sv] of [[1.6, -1], [1.6, 1], [-1.5, -1], [-1.5, 1], [-2.4, 1]]) {
        cylLay(0.55, 0.34, 12, M.concreteDark,
          x + dx * du + px * sv * 1.06, 0.55, z + dz * du + pz * sv * 1.06, ry + Math.PI / 2, 2);
      }
      cylLay(0.55, 0.34, 12, M.concreteDark, x - dx * 4.2 + px * 1.9, 0.34, z - dz * 4.2 + pz * 1.9, ry, 2);
      mark(x, z, 4.0, 1.0);
    };

    const forklift = (x, z, ry) => {
      const dx = Math.cos(ry), dz = -Math.sin(ry);
      const px = Math.sin(ry), pz = Math.cos(ry);
      box(2.0, 0.85, 1.25, M.metalRed, x, 0.32, z, ry, 1.2);                 // 車体
      box(1.0, 0.55, 1.15, M.metalRed, x - dx * 0.5, 1.17, z - dz * 0.5, ry, 1.0);  // 運転席背
      box(0.9, 0.09, 1.1, M.rust, x - dx * 0.35, 2.05, z - dz * 0.35, ry, 0.8);     // ヘッドガード
      for (const s of [-1, 1]) {
        box(0.09, 0.9, 0.09, M.rust, x - dx * 0.05 + px * s * 0.5, 1.15, z - dz * 0.05 + pz * s * 0.5, ry, 0.6);
        box(0.14, 2.6, 0.18, M.rust, x + dx * 1.05 + px * s * 0.42, 0.18, z + dz * 1.05 + pz * s * 0.42, ry, 0.8);  // マスト
        box(0.9, 0.06, 0.13, M.metal, x + dx * 1.45 + px * s * 0.34, 0.10, z + dz * 1.45 + pz * s * 0.34, ry, 0.6); // フォーク
      }
      for (const [du, sv, r] of [[0.75, -1, 0.42], [0.75, 1, 0.42], [-0.72, -1, 0.3], [-0.72, 1, 0.3]]) {
        cylLay(r, 0.28, 12, M.concreteDark, x + dx * du + px * sv * 0.62, r, z + dz * du + pz * sv * 0.62, ry + Math.PI / 2, 2);
      }
      mark(x, z, 2.4, 0.95);
    };

    // 荷役クレーン。大破したトラックだけでは「重い物を扱っていた場所」にならない。
    // ラチスのブームは細い線の集まりなので、画面の上半分を塞がずに密度だけ上げられる。
    // ブームはローカル+Zを軸にした真っ直ぐな形で組み、emitのryとrxでまとめて倒す。
    // 部材ごとにワールド座標を計算すると符号を1つ間違えただけで骨組みが崩れる
    const latticeBoom = (bx, by, bz, ry, rx, len, half) => {
      const bar = (w, h, d, lx, ly, lz, axis = null, ang = 0) => {
        const g = makeBox(w, h, d, 1.0);
        if (axis === 'x') g.rotateX(ang);
        else if (axis === 'y') g.rotateY(ang);
        g.translate(lx, ly, lz);
        emit(g, M.metalRed, bx, by, bz, ry, rx, 0, false, false);
      };
      for (const a of [-half, half]) {
        for (const b of [-half, half]) bar(0.1, 0.1, len, a, b, len / 2);
      }
      const n = Math.max(5, Math.round(len / 1.5));
      const seg = len / n;
      const dl = Math.hypot(seg, half * 2);
      const ang = Math.atan2(half * 2, seg);
      for (let i = 0; i <= n; i++) {
        for (const b of [-half, half]) bar(half * 2, 0.07, 0.07, 0, b, i * seg);
        for (const a of [-half, half]) bar(0.07, half * 2, 0.07, a, 0, i * seg);
      }
      // 斜材。4本の弦だけだと平行な棒が並んでいるようにしか見えない。
      // 側面はローカルXまわり、上下面はローカルYまわりに倒す
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) * seg;
        const sgn = i % 2 ? 1 : -1;
        for (const a of [-half, half]) bar(0.06, 0.06, dl, a, 0, t, 'x', ang * sgn);
        for (const b of [-half, half]) bar(0.06, 0.06, dl, 0, b, t, 'y', ang * sgn);
      }
      const cr = Math.cos(rx);
      return [bx + cr * Math.sin(ry) * len, by - Math.sin(rx) * len, bz + cr * Math.cos(ry) * len];
    };

    const crawlerCrane = (x, z, ry, pitch, len) => {
      const dx = Math.cos(ry), dz = -Math.sin(ry);   // 幅方向
      const fx = Math.sin(ry), fz = Math.cos(ry);    // ブームの向き（水平成分）
      for (const s of [-1.55, 1.55]) {
        box(1.02, 0.95, 5.6, M.concreteDark, x + dx * s, 0, z + dz * s, ry, 1.6);
        box(1.16, 0.46, 4.4, M.metal, x + dx * s, 0.26, z + dz * s, ry, 1.2);   // 履帯
      }
      box(4.1, 0.4, 4.6, M.rust, x, 0.95, z, ry, 1.6);                          // 台車
      cyl(1.3, 0.32, 12, M.rust, x, 1.35, z, 3);                                // 旋回輪
      box(3.1, 2.0, 3.4, M.metalRed, x - fx * 0.7, 1.67, z - fz * 0.7, ry, 1.8);   // 機械室
      box(3.5, 0.95, 1.5, M.concreteDark, x - fx * 2.8, 1.67, z - fz * 2.8, ry, 1.4); // カウンタウェイト
      boxD(1.4, 1.15, 0.1, glassMat, x + fx * 1.05, 2.35, z + fz * 1.05, ry, 1.0);   // 運転席のガラス
      // Aフレーム。ここからブーム先端へロープが張られるので、斜めの長い線が2本増える
      const ax = x - fx * 1.4, az = z - fz * 1.4;
      for (const s of [-0.85, 0.85]) {
        boxT(0.13, 4.6, 0.13, M.rust, ax + dx * s + fx * 0.5, 4.3, az + dz * s + fz * 0.5,
          ry, -0.22, 0, 1.0);
      }
      const px0 = x + fx * 1.9, pz0 = z + fz * 1.9;
      const tip = latticeBoom(px0, 1.95, pz0, ry, -pitch, len, 0.55);
      // 起伏ロープと巻き上げロープ。線が通ると一気にクレーンとして読める
      wire(ax + dx * 0.85, 6.4, az + dz * 0.85, tip[0], tip[1], tip[2], 0.35);
      wire(ax - dx * 0.85, 6.4, az - dz * 0.85, tip[0], tip[1], tip[2], 0.35);
      // フックは吊ったままにせず建物Bの屋根へ降ろす。宙で止めると
      // 「動いている最中の絵」になって、廃墟という設定と食い違う
      wire(tip[0], tip[1] - 0.2, tip[2], tip[0] + 0.05, 7.45, tip[2] + 0.05, 0.04);
      box(0.42, 0.85, 0.42, M.metal, tip[0], 6.55, tip[2], ry + 0.4, 0.8);        // フックブロック
      cyl(0.09, 0.55, 6, M.rust, tip[0], 6.0, tip[2], 1, false);
      mark(x, z, 4.2, 1.0);
    };

    wreckedTruck(-9.5, -22.5, 0.35);
    forklift(21.5, -12.0, -0.9);
    // 建物Bの北東。ブームを建物越しに倒して、屋根の崩落跡へフックを降ろす。
    // 位置は北のコンテナ(38.5,27)と建物Bの蛇腹(x<=31.05)の両方から逃がしてある
    crawlerCrane(35.5, 31.5, Math.atan2(-0.75, -0.66), 1.15, 15.5);
  }

  /* ------------------------------ 外周の壁沿い（コンテナ列と瓦礫の土手） */
  // 4面が同じ材質だと壁が「縁」に見える。素材を混ぜて奥行きを作る
  containerBody(-30, -38.5, 0.02, M.corr, 2, 6.1);
  containerBody(-20, -38.5, -0.03, M.metalRed, 1, 12.2);
  containerBody(-6, -38.5, 0.01, M.metal, 2, 6.1, { crush: true });
  containerBody(38.5, -14, Math.PI / 2, M.metalRed, 1, 12.2);
  containerBody(38.5, 20, Math.PI / 2 + 0.02, M.corr, 2, 6.1, { crush: true });
  containerBody(38.5, 27, Math.PI / 2, M.metal, 1, 2.9);
  for (let i = 0; i < 7; i++) {
    rubble(14 + i * 3.2, -38.6 + rr(-0.8, 0.8), 2.6, 9, [M.concrete, M.brick, M.dirt]);
  }
  for (let i = 0; i < 5; i++) {
    rubble(-38.6 + rr(-0.8, 0.8), -26 + i * 4.4, 2.4, 8, [M.concrete, M.brick, M.dirt]);
  }
  // 壁の根本へ寄せた盛り土。水平線が1本で通っているのを崩すのが目的なので、
  // 遮蔽としては使わせない位置（外周沿い）に置いて撃ち合いの形は変えない
  berm(-38.3, 8.0, Math.PI / 2, 15, 3.2, 0.75);
  berm(-38.3, 32.0, Math.PI / 2, 10, 3.0, 0.8);
  berm(-8.0, 39.0, 0, 18, 3.4, 0.8);

  // 人間スケールの生活痕。消火栓とメーターは小さいが、置いた瞬間に
  // 「誰かが管理していた施設」に変わる
  // 戦域内の3本は180度回した対で置く（戦域の対称化。小物でも弾は止まる）
  hydrant(-15.0, -11.6, 0.4);
  hydrant(15.0, 11.6, 0.4);
  hydrant(13.6, -14.6, -1.2);
  hydrant(-13.6, 14.6, -1.2);
  hydrant(-9.6, 13.4, 2.1);
  hydrant(9.6, -13.4, 2.1);
  meterBox(-29.85, 1.4, -25.6, -Math.PI / 2);
  meterBox(12.7, 1.5, -29.0, -Math.PI / 2);

  /* -------------------------------------------------- 外周の遠景（場外） */
  // プレイ可能領域の外に層を積んで境界を隠す。屋根に登れる設計なので、
  // ここが空だと「1辺84mの盆に立っている」ことが一目で分かってしまう
  {
    const farY = (x, z) => {
      const dd = Math.hypot(x, z);
      const k = sstep(50, 130, dd);
      return k <= 0 ? 0 : (fbm2(x * 0.012, z * 0.012, 1.0, 4, 4409) - 0.5) * 9.0 * k;
    };
    // 場外に出す物の明度。ここを物ごとの好きな固定値で振っていたせいで、
    // 45m先の路面が0.82、190m先の丘が1.0という並びになり、遠いほうが明るい
    // 逆立ちした奥行きになっていた。距離から基準を1本引いて、場外の物は
    // 全部これを通す。kは物の役割ぶんの振り幅（棟ごとのばらつき・屋上の陰）。
    // 面そのものをここで空より下に置いておけば、フォグ側(textures.jsの
    // 空気遠近が空の放射輝度を上限にしている)と合わせて、どの距離でも
    // 「ビルのほうが空より暗い」が崩れない。
    // 傾きは緩くする。遠いほど空へ寄せるのはフォグ側の仕事で、ここで一気に
    // 沈めるとその効きを打ち消してしまい、遠いほど暗いという逆の絵に戻る
    const farTint = (x, z, k = 1) =>
      k * (0.80 - 0.10 * clamp((Math.hypot(x, z) - 44) / 156, 0, 1));
    // texScaleは実寸連動にする。3.5固定だと20mのビルに5.7m/タイルで貼ることになり、
    // 模様が完全に消えて無地の板になる。窓の律動は霞んでも残るのが正しい
    const boxF = (w, h, d, mat, x, yBottom, z, ry = 0, texScale = 0) =>
      fxEmit(makeBox(w, h, d, texScale || clamp(Math.max(w, h) / 4, 1.2, 4.0)),
        mat, x, yBottom + h / 2, z, ry, 0, 0, farTint(x, z));
    const cylF = (r, h, seg, mat, x, yBottom, z, uvU = 3) =>
      fxEmit(cylGeo(r, r, h, seg, uvU), mat, x, yBottom + h / 2, z, 0, 0, 0, farTint(x, z));

    /* -------------------------------- 場外レイヤー（壁の外〜遠景の手前） */
    // 外周壁のすぐ外が完全な空白で、その先に唐突に遠景ビルが浮いていた。
    // 俯瞰で「1辺84mの盆」だとバレるのはここが空だから。
    // 道路・電柱・フェンス・置き去りの荷を30mの帯に敷いて中間層を作る。
    // 全部fxChunks送りなので衝突もOctreeも増えない
    {
      const fenceRun = (x, z, ry, len, h = 2.4) => {
        const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
        const n = Math.max(1, Math.round(len / 12));
        const seg = len / n;
        for (let i = 0; i < n; i++) {
          const u = ((i + 0.5) / n - 0.5) * len;
          const g = new THREE.PlaneGeometry(seg, h);
          scaleUV(g, seg / 1.6, h / 1.6);      // 網目を実寸で刻む
          fxEmit(g, fenceMat, x + dirX * u, h / 2, z + dirZ * u, ry, 0, 0,
            farTint(x + dirX * u, z + dirZ * u, 1.14));
        }
        // 支柱と上下の胴縁。網だけだと空中に模様が浮いて見える
        const np = Math.max(2, Math.round(len / 3.0));
        for (let i = 0; i <= np; i++) {
          const u = (i / np - 0.5) * len;
          fxEmit(makeBox(0.09, h + 0.18, 0.09, 0.5), M.metal,
            x + dirX * u, (h + 0.18) / 2, z + dirZ * u, ry, 0, 0,
            farTint(x + dirX * u, z + dirZ * u, 1.08));
        }
        fxEmit(makeBox(len, 0.07, 0.07, 0.5), M.metal, x, h + 0.05, z, ry, 0, 0, farTint(x, z, 1.08));
      };

      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 2;
        const nx = Math.sin(a), nz = Math.cos(a);       // 外向き
        const dirX = Math.cos(a), dirZ = -Math.sin(a);  // 壁に沿う向き
        // (a) 壁と平行に走る舗装の帯。薄いスラブで置くと地面とZファイトしない。
        // 長さは84までにして4隅で帯どうしを重ねない（同じ高さで重なるとZファイトする）
        fxEmit(makeBox(84, 0.10, 7.0, 3.2), M.asphalt,
          nx * 48, 0.05, nz * 48, a, 0, 0, farTint(nx * 48, nz * 48, 1.04));
        // 外側の道は大きく振る。壁と平行な帯だけを重ねると、俯瞰で同心の四角になり
        // かえって「盆の縁」を強調してしまう。四隅で交差するぶんだけ高さをずらす
        fxEmit(makeBox(84, 0.10, 5.0, 3.2), M.concreteDark,
          nx * 66 + dirX * 6, 0.056 + i * 0.006, nz * 66 + dirZ * 6, a + 0.22, 0, 0,
          farTint(nx * 66 + dirX * 6, nz * 66 + dirZ * 6, 1.0));
        // (b) 道路沿いの電柱と電線。等間隔の縦の列が奥行きを一番安く作る
        let prev = null;
        for (let k = -5; k <= 5; k++) {
          const u = k * 8.4;
          const px2 = nx * 44.5 + dirX * u;
          const pz2 = nz * 44.5 + dirZ * u;
          fxEmit(cylGeo(0.19, 0.24, 8.4, 6, 3, 1), M.concrete, px2, 4.2, pz2, 0, 0, 0,
            farTint(px2, pz2, 1.06));
          fxEmit(makeBox(2.4, 0.14, 0.14, 1.0), M.wood, px2, 7.6, pz2, a + Math.PI / 2, 0, 0,
            farTint(px2, pz2, 1.06));
          // 電線は1本で足りる。遠目には細い線を3本引いても潰れて1本に見える
          if (prev) wire(prev[0], 7.5, prev[1], px2, 7.5, pz2, 1.0);
          prev = [px2, pz2];
        }
        // (c) フェンス。壁と遠景の間に1枚透ける面が入ると層が増える
        fenceRun(nx * 53, nz * 53, a, 106, 2.4);   // 四隅で突き合うので輪が閉じる
        // (d) 置き去りの荷と土手。壁の外にも同じ施設が続いている読みを作る
        for (let k = -2; k <= 2; k++) {
          const u = k * 17 + (hash3(i * 3.1, k * 2.7, 5.5) - 0.5) * 6;
          if (hash3(k * 1.9, i * 4.3, 1.1) < 0.45) continue;
          const cxo = nx * 49.5 + dirX * u, czo = nz * 49.5 + dirZ * u;
          const lenO = hash3(u, i, k) < 0.5 ? 6.1 : 12.2;
          fxEmit(makeBox(lenO, 2.6, 2.44, 2.2),
            k % 2 ? M.metalRed : M.corr, cxo, 1.3, czo, a + Math.PI / 2 + (hash3(k, u, i) - 0.5) * 0.3,
            0, 0, farTint(cxo, czo, 1.04));
        }
      }
    }

    // 壁線をまたぐ中距離のビル。外周壁のすぐ外に背の高い棟を立てると、
    // 壁の上端の直線がその棟で切られて「境界」に見えなくなる。
    // 置くのは59m。手前の置き去りコンテナ(49.5)と金網(53)より奥で、
    // 金網越しに建っている形になる（場内へは絶対にはみ出させない）
    for (const [side, u, bw2, bh2, bd2] of [[0, 4.2, 20, 30, 10], [1, -12.6, 17, 25, 10],
      [2, 21.0, 22, 34, 11], [3, -29.4, 16, 27, 10]]) {
      const a = (side * Math.PI) / 2;
      const nx = Math.sin(a), nz = Math.cos(a);
      const dirX = Math.cos(a), dirZ = -Math.sin(a);
      const cxo = nx * 59 + dirX * u, czo = nz * 59 + dirZ * u;
      const fm = farFacadeMats[side % farFacadeMats.length];
      const y1 = farY(cxo, czo) - 1.0;
      fxEmit(offsetUV(makeBox(bw2, bh2, bd2, 4.2), hash3(u, side, 1.3), hash3(side, u, 7.7)),
        fm, cxo, y1 + bh2 / 2, czo, a + (hash3(u, 3.1, side) - 0.5) * 0.12, 0, 0,
        farTint(cxo, czo, 1.0));
      fxEmit(makeBox(bw2 + 0.6, 0.9, bd2 + 0.6, 1.6), M.concreteDark,
        cxo, y1 + bh2 + 0.25, czo, a, 0, 0, farTint(cxo, czo, 0.93));
      fxEmit(makeBox(bw2 * 0.34, 3.2, bd2 * 0.5, 2.0), M.concreteDark,
        cxo + dirX * bw2 * 0.2, y1 + bh2 + 1.9, czo + dirZ * bw2 * 0.2, a, 0, 0,
        farTint(cxo, czo, 0.90));
      cylF(1.2, 3.0, 10, M.rust, cxo - dirX * bw2 * 0.26, y1 + bh2 + 1.4, czo - dirZ * bw2 * 0.26, 3);
    }

    const farMats = [M.concreteDark, M.corr, M.brick, M.concrete];
    for (let i = 0; i < 30; i++) {
      const ang = (i / 30) * Math.PI * 2 + rr(-0.09, 0.09);
      const dist = rr(52, 118);
      const bx = Math.sin(ang) * dist;
      const bz = Math.cos(ang) * dist;
      const bw = rr(9, 26), bd = rr(9, 24), bh = rr(8, 34);
      const y0 = farY(bx, bz) - 1.6;
      const ry = rr(-0.5, 0.5);
      // 半分以上は窓の格子を持つ外装にする。無地の面が並ぶと空との明度差だけの
      // 板になり、フォグを掛けるほどシルエットまで消える
      const tall = bh > 14;
      const useWin = tall || rnd() < 0.45;
      const winK = Math.floor(rnd() * farFacadeMats.length);
      const mat = useWin ? farFacadeMats[winK] : farMats[Math.floor(rnd() * farMats.length)];
      // 明度は距離から引く。rnd()の呼び回数はここも下も一切変えていない
      // （変えると以降の乱数が全部ずれて、詰めてある干渉回避が崩れる）。
      // 掛かる幅は棟ごとのばらつきぶんで、同じロットの箱に見せないためのもの
      const tint = farTint(bx, bz, 0.92 + rnd() * 0.20);
      // 窓割りの実寸も棟ごとに変える。同じテクスチャを同じ倍率で貼ると、
      // 3種類作った意味が半分消える
      const winScale = [3.4, 4.2, 5.0][winK];
      fxEmit(offsetUV(makeBox(bw, bh, bd, useWin ? winScale : clamp(Math.max(bw, bh) / 4, 1.4, 4.0)),
        rnd(), rnd()), mat, bx, y0 + bh / 2, bz, ry, 0, 0, tint);
      // 足元の舗装。地形との接点に面が無いと、俯瞰でビルが地面から浮いて見える
      fxEmit(makeBox(bw + rr(4, 10), 0.3, bd + rr(4, 10), 3.0), M.concreteDark,
        bx, y0 + 1.2, bz, ry + rr(-0.3, 0.3), 0, 0, tint * 0.9);
      // パラペット。屋上の縁に厚みが1段出るだけで「箱」から「建物」になる
      fxEmit(makeBox(bw + 0.5, 0.9, bd + 0.5, 1.6), M.concreteDark,
        bx, y0 + bh + 0.25, bz, ry, 0, 0, tint * 0.92);
      // 階層の見切り。中間に帯が1本入ると高さの目盛りになる
      if (tall) {
        fxEmit(makeBox(bw + 0.3, 0.5, bd + 0.3, 1.6), M.concreteDark,
          bx, y0 + bh * 0.55, bz, ry, 0, 0, tint * 0.9);
      }
      // セットバック。上部を一段細くした棟を混ぜると、地平の輪郭が
      // 「同じ高さの直方体が並んだ櫛」から抜ける
      if (tall && rnd() < 0.4) {
        const sw = bw * rr(0.45, 0.7), sd2 = bd * rr(0.45, 0.7), sh = rr(4, 11);
        const sx = bx + rr(-1.5, 1.5), sz = bz + rr(-1.5, 1.5);
        fxEmit(offsetUV(makeBox(sw, sh, sd2, useWin ? winScale : 3.0), rnd(), rnd()),
          mat, sx, y0 + bh + sh / 2, sz, ry, 0, 0, tint * 0.96);
        fxEmit(makeBox(sw + 0.4, 0.7, sd2 + 0.4, 1.6), M.concreteDark,
          sx, y0 + bh + sh + 0.2, sz, ry, 0, 0, tint * 0.9);
      }
      // 階段室(塔屋)。屋上に必ず1つある箱で、これがあると屋上が「面」でなく「場所」になる
      if (rnd() < 0.55) {
        const px3 = bx + rr(-bw * 0.28, bw * 0.28), pz3 = bz + rr(-bd * 0.28, bd * 0.28);
        const ph = rr(2.4, 3.8);
        fxEmit(makeBox(rr(3, 5), ph, rr(3, 4.5), 2.2), M.concreteDark,
          px3, y0 + bh + ph / 2, pz3, ry + rr(-0.2, 0.2), 0, 0, tint * 0.88);
      }
      // 屋上設備。スカイラインを不規則にするのが目的なので、種類を混ぜて数も振る
      if (rnd() < 0.75) {
        fxEmit(makeBox(bw * 0.30, rr(2.5, 6), bd * 0.32, 2.0), M.concreteDark,
          bx + rr(-3, 3), y0 + bh + rr(1.5, 3.5), bz + rr(-3, 3), rr(-0.4, 0.4), 0, 0, tint * 0.86);
      }
      if (rnd() < 0.5) {
        // 給水塔。脚付きの円筒が1つ乗るだけで輪郭が一気に人工物になる
        const tr = rr(1.0, 2.0), thh = rr(2.5, 5);
        const tx2 = bx + rr(-4, 4), tz2 = bz + rr(-4, 4);
        cylF(tr, thh, 10, M.rust, tx2, y0 + bh + 1.6, tz2, 3);
        for (const sa of [0.8, 2.4, 3.9, 5.5]) {
          fxEmit(makeBox(0.35, 1.7, 0.35, 1.0), M.metal,
            tx2 + Math.cos(sa) * tr * 0.7, y0 + bh + 0.85, tz2 + Math.sin(sa) * tr * 0.7, 0, 0, 0, tint * 0.8);
        }
      }
      if (rnd() < 0.45) {
        // 排気筒とアンテナ。細い縦の線が数本立つと屋上の情報量が上がる
        cylF(rr(0.4, 0.9), rr(4, 10), 8, M.metalRed, bx + rr(-5, 5), y0 + bh, bz + rr(-5, 5));
      }
      if (rnd() < 0.4) {
        fxEmit(makeBox(0.18, rr(5, 11), 0.18, 1.0), M.metal,
          bx + rr(-5, 5), y0 + bh + 5, bz + rr(-5, 5), 0, 0, 0, tint * 0.8);
      }
    }

    // スタック煙突。地平のスケールを決める一番強い要素
    const stackChimney = (x, z, h, r) => {
      const y0 = farY(x, z) - 1.2;
      cylF(r, h, 14, M.concreteDark, x, y0, z, 4);
      for (let i = 1; i <= 4; i++) cylF(r * 1.09, 0.9, 14, M.metalRed, x, y0 + (h * i) / 5, z, 2);
      cylF(r * 1.14, 1.6, 14, M.rust, x, y0 + h - 1.6, z, 2);
      // 煙。煙突が立っているのに煙が1粒も出ていないと、世界が停止した書き割りに見える。
      // プレイ範囲は±40mなので、場内の中心を向く板2枚で十分に立体に見える
      const face = Math.atan2(x, z);
      const ph = h * 1.5 + 14, pw = r * 7;
      for (const [ao, sc] of [[0, 1], [0.42, 0.78]]) {
        const g = new THREE.PlaneGeometry(pw * sc, ph * sc, 4, 7);
        const gp = g.attributes.position;
        for (let i = 0; i < gp.count; i++) {
          const t = clamp((gp.getY(i) + ph * sc / 2) / (ph * sc), 0, 1);
          // 上へ行くほど広がって風下へ流れる。真っ直ぐ立った棒だと煙に見えない
          gp.setX(i, gp.getX(i) * (0.34 + t * 1.15) + t * t * ph * sc * 0.30);
        }
        gp.needsUpdate = true;
        g.translate(0, (ph * sc) / 2, 0);
        g.computeVertexNormals();
        // 煙も明るい空を背にして立つので、空より暗い側に置く。
        // 0.95固定だと実測で空の1.008倍あり、煙のほうが光源に見えていた
        fxEmit(g, plumeMat, x, y0 + h - 1.0, z, face + ao, 0, 0, farTint(x, z));
      }
    };
    stackChimney(-64, -86, 42, 2.6);
    stackChimney(-56, -92, 34, 2.1);
    stackChimney(78, 54, 38, 2.4);

    // ガントリークレーン。門型と桁とトロリーだけで一目でクレーンに見える
    const gantry = (x, z, ry, sc) => {
      const y0 = farY(x, z) - 1.0;
      const span = 30 * sc, h = 24 * sc;
      const dx = Math.cos(ry), dz = -Math.sin(ry);
      for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
          const lx = x + dx * su * (span / 2) + Math.sin(ry) * sv * 5 * sc;
          const lz = z + dz * su * (span / 2) + Math.cos(ry) * sv * 5 * sc;
          boxF(1.5 * sc, h, 1.5 * sc, M.metalRed, lx, y0, lz, ry);
          boxF(1.0 * sc, 1.0 * sc, 10 * sc, M.metalRed, lx, y0 + h * 0.45, lz, ry);
        }
      }
      boxF(span + 6 * sc, 2.6 * sc, 2.2 * sc, M.metalRed, x, y0 + h, z, ry);
      boxF(span + 22 * sc, 1.6 * sc, 1.5 * sc, M.metalRed, x + dx * 8 * sc, y0 + h + 2.6 * sc, z + dz * 8 * sc, ry);
      boxF(4 * sc, 3 * sc, 3 * sc, M.rust, x + dx * span * 0.28, y0 + h - 3 * sc, z + dz * span * 0.28, ry);
    };
    gantry(-92, 40, 0.5, 1.0);
    gantry(-70, 74, -0.3, 0.8);
    gantry(96, -38, 1.2, 1.1);

    // 送電鉄塔。細い縦のシルエットが混ざると層が増える
    const pylon = (x, z, h) => {
      const y0 = farY(x, z) - 0.5;
      for (const su of [-1, 1]) {
        for (const sv of [-1, 1]) {
          fxEmit(cylGeo(0.22, 0.7, h, 5, 2, 1), M.metal, x + su * 1.9, y0 + h / 2, z + sv * 1.9, 0,
            0, 0, farTint(x, z));
        }
      }
      for (let i = 1; i <= 3; i++) {
        const y = y0 + h * (0.55 + i * 0.13);
        boxF(9 - i * 1.6, 0.28, 0.28, M.metal, x, y, z, 0);
      }
      boxF(0.3, 2.2, 0.3, M.metal, x, y0 + h, z, 0);
    };
    pylon(-108, -20, 30);
    pylon(-96, 6, 30);
    pylon(-86, 30, 28);
    pylon(62, 96, 30);

    // 遠くの丘。地平線が定規の直線で終わらないようにする
    for (let i = 0; i < 9; i++) {
      const ang = rr(0, Math.PI * 2);
      const dist = rr(140, 195);
      const hx = Math.sin(ang) * dist, hz = Math.cos(ang) * dist;
      // 一番奥にあるのに明度が1.0のまま置かれていて、100m先のビルより明るかった。
      // 地平の最後の層なので、場外の中では一番空へ寄っている所になる
      fxEmit(new THREE.SphereGeometry(rr(28, 55), 10, 5, 0, Math.PI * 2, 0, Math.PI / 2),
        M.dirt, hx, farY(hx, hz) - rr(14, 26), hz, rr(0, 3.1), 0, 0, farTint(hx, hz));
    }
  }

  /* ----------------------------------------------------------- 雑草 */
  // 壁の根本・舗装の目地・瓦礫の隙間に生やす。衝突も影も無いのでコストはほぼゼロ
  {
    // 交差2枚だと見る角度によって板であることがはっきり読める。3枚60度にする。
    // 根元を頂点カラーで暗く落とすのが一番効く。根元の暗さが無いと、
    // 房が地面に「刺さっている」のではなく「置いてある」ように見える
    const tuft = (x, z, s, a) => {
      const base = 0.82 + hash3(x, s, z) * 0.34;
      for (let k = 0; k < 3; k++) {
        const sk = s * (0.80 + h2(k, Math.round(x * 7.3), 91) * 0.44);
        const w = 0.6 * sk, hh = 0.55 * sk;
        const g = new THREE.PlaneGeometry(w, hh);
        g.translate(0, hh / 2, 0);
        const pos = g.attributes.position;
        const col = new Float32Array(pos.count * 3);
        for (let i = 0; i < pos.count; i++) {
          const t = clamp(pos.getY(i) / hh, 0, 1);
          const v = base * (0.40 + 0.60 * t);
          col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        fxEmit(g, grassMat, x, 0, z, a + k * 1.047, 0, 0, 1);
      }
    };
    // 草は「生えられる場所」にしか生えない。壁の根本・塀の際・目地が本来の場所で、
    // プロップ周囲へ等方に撒くと草原に物を置いたように見える
    const grassLine = (x, z, ry, len, n, sc = 1) => {
      const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
      const nx = Math.sin(ry), nz = Math.cos(ry);
      for (let i = 0; i < n; i++) {
        const u = (rnd() - 0.5) * len;
        const off = 0.10 + rnd() * 0.45;
        const gx = x + dirX * u + nx * off;
        const gz = z + dirZ * u + nz * off;
        if (Math.abs(gx) > 41.5 || Math.abs(gz) > 41.5) continue;
        // 壁から離れるほど小さく。生え際が一番濃いのが自然
        tuft(gx, gz, rr(0.6, 1.35) * sc * (1.15 - off), rnd() * 3.14);
      }
    };
    // 外周壁の内側
    for (let i = 0; i < 4; i++) {
      const a = (i * Math.PI) / 2;
      grassLine(Math.sin(a) * 42 - Math.sin(a) * 2.4, Math.cos(a) * 42 - Math.cos(a) * 2.4,
        a, 78, 34, 1.15);
    }
    // 建物と掩体の根本
    for (const [bx, bz, bw, bd] of [[-21, -20, 17.6, 14.6], [23, 21, 15.6, 15.6],
      [24, -25, 22.6, 13.6], [0, 0, 15.4, 14.4], [-30.2, 18.2, 11, 12]]) {
      grassLine(bx, bz + bd / 2, 0, bw, 9);
      grassLine(bx, bz - bd / 2, Math.PI, bw, 9);
      grassLine(bx + bw / 2, bz, Math.PI / 2, bd, 8);
      grassLine(bx - bw / 2, bz, -Math.PI / 2, bd, 8);
    }
    // 残りはプロップの足元。数を減らして「物陰にだけ残った」密度にする
    for (let i = 0; i < 170; i++) {
      const mk = marks[Math.floor(rnd() * marks.length)];
      if (!mk) break;
      const a = rnd() * Math.PI * 2;
      const d = mk.r * rr(0.82, 1.15);
      const gx = mk.x + Math.cos(a) * d;
      const gz = mk.z + Math.sin(a) * d;
      if (Math.abs(gx) > 40.5 || Math.abs(gz) > 40.5) continue;
      tuft(gx, gz, rr(0.55, 1.2), rnd() * 3.14);
    }
  }

  /* ------------------------------------------- スポーン正面の手前の遮蔽 */
  // 開幕のカメラ(0,26 から -Z を向く)に手前のシルエットが1つも無く、
  // 画面の下半分が素のアスファルトで埋まっていた。手前端が無いと広場の広さも
  // 自分の背丈も測れない。視線の中央は空けたまま、左右の端に腰高の物を置く。
  // ここに書いてあるのは乱数列の都合（場内の既存配置を1つもずらさないため）
  {
    jerseyLine(-5.8, 22.4, 0.14, 3);
    palletStack(-7.9, 24.8, 0.5, 4);
    drumTipped(3.9, 23.6, 0.7, M.rust);
    drum(4.8, 24.4, M.metalRed);
    wireCoil(1.6, 21.6, 0.5, 4);
    // 立てかけた波板。斜めの線が1本手前に入ると奥行きの手前端が決まる
    boxT(2.8, 0.15, 2.0, M.corr, -9.6, 1.05, 21.4, 0.55, 0.9, 0, 1.6);
    gravel(-6.0, 23.2, 2.2, 18, [M.concrete, M.concreteDark, M.dirt]);
  }

  /* ------------------------------------ 崩落した外周壁の瓦礫 */
  // 崩したスパンの内外へ瓦礫を積む。ここに置くのは乱数列の都合で、
  // 場内の配置（rnd()を消費する物）を1つもずらさないため。
  // 上でまとめて置くと以降の乱数が全部ずれて、詰めてある干渉回避が崩れる
  for (const gp of wallGaps) {
    const n = Math.max(2, Math.round(gp.len / 7));
    for (let k = 0; k < n; k++) {
      const u = ((k + 0.5) / n - 0.5) * gp.len * 0.9;
      // 内側と外側の両方へ崩す。片側だけだと「低く作った壁」に見える
      rubble(gp.x + gp.dirX * u + gp.inX * 1.9, gp.z + gp.dirZ * u + gp.inZ * 1.9,
        2.8, 10, [M.brick, M.concrete, M.dirt]);
      rubble(gp.x + gp.dirX * u - gp.inX * 2.4, gp.z + gp.dirZ * u - gp.inZ * 2.4,
        2.4, 7, [M.brick, M.concrete, M.dirt]);
    }
  }

  /* ------------------------------------------ 壁を伝う汚れ（垂れ） */
  {
    const streak = (w, h, x, yTop, z, ry) => {
      const g = new THREE.PlaneGeometry(w, h);
      fxEmit(g, streakMat, x, yTop - h / 2, z, ry, 0, 0, 1);
    };
    // 建物A（南面・北面）の軒下
    for (const u of [-6.4, -1.2, 3.6, 6.8]) {
      streak(rr(0.9, 1.9), rr(2.2, 4.0), -21 + u, 6.4, -20 + 7.06, 0);
      streak(rr(0.9, 1.9), rr(1.8, 3.4), -21 + u, 6.4, -20 - 7.06, Math.PI);
    }
    // 建物B（西面）
    for (const u of [-5.0, 0.4, 4.6]) {
      streak(rr(0.9, 1.8), rr(2.0, 3.6), 23 - 7.56, 5.4, 21 + u, -Math.PI / 2);
    }
    // 掩体の正面。軒の見切りの下が綺麗すぎるのを潰す
    for (const u of [-5.6, -1.0, 2.4, 5.8]) {
      streak(rr(0.8, 1.6), rr(1.4, 2.6), u, 3.35, -7.02, Math.PI);
      streak(rr(0.8, 1.6), rr(1.2, 2.2), u, 3.35, 7.02, 0);
    }
  }

  /* --------------------------------- 汚しデカールの配置（重力方向） */
  // buildDecals()で焼いた6種を、発生源に紐付けて貼る。
  // AAAの汚しは100%「重力方向に局所的」で、庇の下・窓台の下・スラブの水切り・
  // ボルト位置から下へ伸びる筋として出る。テクスチャ内の等方ノイズは代替にならない。
  // 乱数はrnd()を使わずハッシュから引く（この位置に処理を足しても既存の配置がずれない）
  {
    const hv = (a, b, c) => hash3(a * 1.7 + 3.1, b * 2.3 - 1.7, c * 1.1 + 5.3);

    // (1) 窓台と水切りの下。wallRunが控えておいた開口の下端を全部使う
    for (const s of sills) {
      const r1 = hv(s.x, s.y, s.z);
      const wd = Math.min(s.w, 2.6) * (0.72 + r1 * 0.28);
      const hh = 1.3 + r1 * 2.0;
      for (const sgn of [1, -1]) {
        const ry = sgn > 0 ? s.ry : s.ry + Math.PI;
        wallDecal(decRain, wd, hh,
          s.x + Math.sin(ry) * (s.t / 2), s.y, s.z + Math.cos(ry) * (s.t / 2), ry);
      }
    }

    // (2) 庇・蛇腹・パラペットの水切りの下。開口が無い面はここでしか汚れが出ない
    const corniceRain = (x, z, ry, len, yTop, n, scale = 1) => {
      const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
      for (let i = 0; i < n; i++) {
        const r1 = hv(x + i * 3.7, yTop + i, z - i * 2.3);
        const r2 = hv(z - i * 1.9, x + i * 5.1, yTop * 2 + i);
        const u = ((i + 0.5) / n - 0.5) * len + (r1 - 0.5) * (len / n) * 0.7;
        wallDecal(decRain, (0.7 + r1 * 1.5) * scale, (1.4 + r2 * 2.6) * scale,
          x + dirX * u, yTop, z + dirZ * u, ry);
      }
    };
    // 建物A（軒の蛇腹 6.28 とパラペットの根本）
    corniceRain(-21, -20 + 7.3, 0, 16.5, 6.24, 5);
    corniceRain(-21, -20 - 7.3, Math.PI, 16.5, 6.24, 4);
    corniceRain(-21 - 8.8, -20, -Math.PI / 2, 13.5, 6.24, 4);
    corniceRain(-21 + 8.8, -20, Math.PI / 2, 13.5, 6.24, 4);
    // 建物B
    corniceRain(23, 21 + 7.8, 0, 14.5, 5.24, 4);
    corniceRain(23 - 7.8, 21, -Math.PI / 2, 14.5, 5.24, 4);
    corniceRain(23, 21 - 7.8, Math.PI, 14.5, 5.24, 3);
    // 掩体の軒の見切り（3.1）。軒は0.8m跳ね出しているので、軒の先端ではなく
    // その下の壁面(±7.0 / ±7.5)へ落とす。先端に合わせると筋が空中に浮く
    corniceRain(0, 7.03, 0, 14.5, 3.05, 6, 0.8);
    corniceRain(0, -7.03, Math.PI, 14.5, 3.05, 6, 0.8);
    corniceRain(-7.53, 0, -Math.PI / 2, 13.5, 3.05, 5, 0.8);
    corniceRain(7.53, 0, Math.PI / 2, 13.5, 3.05, 5, 0.8);
    // 倉庫の軒（7.0）。屋根が0.35出ているので壁面(±18.25 / ±31.75)へ寄せる
    corniceRain(24, -18.22, 0, 21, 6.9, 6);
    corniceRain(24, -31.78, Math.PI, 21, 6.9, 5);
    // 外周壁の笠木の下。長い面が汚れゼロだと壁ではなくトレイの縁に見える。
    // スパンごとに高さが違うので、笠木の実高に合わせてスパン単位で落とす
    for (const sd of wallSides) {
      for (const sg of sd.segs) {
        if (sg.broken) continue;
        corniceRain(Math.sin(sd.a) * 41 + sd.dirX * sg.uc, Math.cos(sd.a) * 41 + sd.dirZ * sg.uc,
          sd.a + Math.PI, sg.len * 0.9, sg.h - 0.1, Math.max(2, Math.round(sg.len / 7)), 1.25);
      }
    }

    // (3) 壁と地面の接線。跳ね返った泥は必ず下端に溜まる
    // 建物は基礎の段差(高さ0.5前後)から上で面が0.25引っ込むので、
    // 泥はねの板はその基礎の高さに収める。はみ出すと板が壁から浮く
    // 入口は基礎の段差を切り欠いてあるので、泥はねの板もそこだけ空ける
    // （建物を組んでいる所のdoorsと同じ位置・同じ幅）
    grimeRing(-21, -20, 17.9, 14.9, 0.55, [{ side: 'z+', u: 0, w: 3.0 }]);
    grimeRing(23, 21, 15.9, 15.9, 0.55, [{ side: 'x-', u: 0, w: 3.0 }]);
    grimeRing(24, -25, 23.0, 14.0, 0.50);
    grimeRing(0, 0, 15.0, 14.0, 0.85);   // 掩体は基礎が無く壁が直に地面へ落ちる
    // 外周壁も基礎の段差が0.25手前に出ているので、その面へ貼る。
    // 崩落したスパンは壁自体が無いので、そこには板を出さない（空中に泥の帯が残る）
    for (const sd of wallSides) {
      for (const sg of sd.segs) {
        if (sg.broken) continue;
        grimeBase(Math.sin(sd.a) * 40.72 + sd.dirX * sg.uc, Math.cos(sd.a) * 40.72 + sd.dirZ * sg.uc,
          sd.a + Math.PI, sg.len * 0.94, 0.62);
      }
    }
    // 廃墟の残った壁。壁厚0.6の外面(-35.3)に合わせる
    grimeBase(-35.3, 18, Math.PI / 2 + Math.PI, 12, 0.9);
    grimeBase(-30, 12.6 - 0.35, Math.PI, 10, 0.9);

    // (4) 剥落。コンクリの隅と根本、目地の縁が欠ける。
    // 欠けが1箇所も無い縁は、経年ではなく施工直後にしか存在しない
    const spallAt = (x, y, z, ry, s) => wallDecal(decSpall, s, s, x, y + s / 2, z, ry);
    for (let i = 0; i < 16; i++) {
      const r1 = hv(i * 4.1, 7.3, i * 2.7), r2 = hv(i * 1.3, i * 5.9, 2.1);
      const u = (r1 - 0.5) * 14;
      const sz = 0.35 + r2 * 0.75;
      // 掩体の4面へ散らす
      if (i % 4 === 0) spallAt(u, r2 * 2.4, -7.03, Math.PI, sz);
      else if (i % 4 === 1) spallAt(u, r2 * 2.4, 7.03, 0, sz);
      else if (i % 4 === 2) spallAt(-7.53, r2 * 2.4, u * 0.9, -Math.PI / 2, sz);
      else spallAt(7.53, r2 * 2.4, u * 0.9, Math.PI / 2, sz);
    }
    for (let i = 0; i < 10; i++) {
      const r1 = hv(i * 2.9, 11.7, i * 3.3), r2 = hv(i * 6.1, i * 1.7, 8.9);
      // 腰のレンガ帯と基礎の段差は面が前後するので、主壁の面(y>1.2)だけに置く
      spallAt(-21 + (r1 - 0.5) * 16, 1.25 + r2 * 1.5, -12.70, 0, 0.4 + r2 * 0.7);
      spallAt(23 - 7.79, 1.3 + r2 * 1.2, 21 + (r1 - 0.5) * 14, -Math.PI / 2, 0.4 + r1 * 0.7);
    }
    // 床の目地の縁。GTAOが拾える段差を付けたので、欠けを添えると印刷に見えなくなる
    for (const [zz, ln] of [[-9.4, 34], [3.1, 32], [12.6, 28]]) {
      for (let i = 0; i < 5; i++) {
        const r1 = hv(zz + i, i * 3.7, ln);
        floorDecal(decSpall, 0.5 + r1 * 0.8, 0.5 + r1 * 0.8,
          (r1 - 0.5) * ln, zz + (hv(i, zz, 3.3) - 0.5) * 0.5, r1 * 3.14, 0.064);
      }
    }

    // (5) 舗装の切り替わりを跨ぐ帯。素材の違う面は必ず定規の直線で接するので、
    // その線をまたいで砂利と泥とタイヤ痕を散らさないと施工図に見える
    const edgeRun = (x, z, ry, len, wid = 1.5) => {
      const dirX = Math.cos(ry), dirZ = -Math.sin(ry);
      const n = Math.max(1, Math.round(len / 6));
      for (let i = 0; i < n; i++) {
        const u = ((i + 0.5) / n - 0.5) * len;
        const r1 = hv(x + u, i * 2.3, z);
        floorDecal(decEdge, (len / n) * 1.04, wid * (0.75 + r1 * 0.6),
          x + dirX * u, z + dirZ * u, ry, 0.058);
      }
    };
    edgeRun(0.5, -17.0, 0, 30, 1.7);        // 縁石に沿って
    edgeRun(19.0, 1.0, Math.PI / 2, 24, 1.6);
    edgeRun(0, -17.2, 0, 36, 1.3);          // 中央広場の舗装の南縁
    edgeRun(0, 17.2, 0, 36, 1.3);
    edgeRun(-19.2, 0, Math.PI / 2, 32, 1.3);
    edgeRun(19.2, 0, Math.PI / 2, 32, 1.3);
    edgeRun(-29, 28.2, 0.12, 24, 1.5);      // 廃墟まわりの土の縁
    edgeRun(24, -16.2, -0.08, 28, 1.5);     // 倉庫前ヤードの縁

    // (6) 落書き。人の手が入っていた痕が1枚あるだけで、廃墟が「使われていた場所」になる
    wallDecal(decGraf, 3.0, 1.9, -3.2, 2.75, -7.03, Math.PI);
    wallDecal(decGraf, 2.4, 1.5, 5.6, 2.55, 7.03, 0);
    wallDecal(decGraf, 3.6, 2.2, -14, 3.6, -41.0, 0);            // 南の外周壁の内側
    wallDecal(decGraf, 3.0, 1.9, 41.0, 3.2, 12, -Math.PI / 2);   // 東の外周壁の内側
    wallDecal(decGraf, 2.2, 1.4, -30, 2.3, -37.28, 0);           // 南のコンテナの側面

    // (7) 鉄骨の節点から下へ落ちる錆。門型の主柱と配管の架構
    for (const gx of [-16.5, 16.5]) {
      for (const gz of [-11.0, 11.0]) {
        for (let i = 0; i < 3; i++) {
          const yy = 2.4 + i * 2.6;
          rustRun(gx + 0.63, yy, gz + 0.55, Math.PI / 2, 0.26, 1.5);
          rustRun(gx - 0.55, yy + 0.7, gz - 0.63, Math.PI, 0.24, 1.3);
        }
      }
    }
    for (const pz of [-8, 2, 12]) {
      for (const px of [26.5, 35.0]) {
        rustRun(px + 0.26, 5.3, pz, Math.PI / 2, 0.3, 1.9);
        rustRun(px, 5.3, pz + 0.26, 0, 0.3, 1.6);
      }
    }
  }

  /* ------------------------------- 路面の板と、プロップ足元の汚れ */
  for (const job of patchJobs) buildPatch(job);
  // 水たまり。全部の物を置き終わってから、足跡(marks)に当たらない場所にだけ敷く。
  // 雨は「低い所と壁際」に残るので、位置は手で選ぶ。等方に散らすと水玉模様になる
  {
    renderOrders.set(puddleMat, 12);
    const spots = [
      [-9.0, 4.2, 3.2], [7.6, -13.4, 2.4], [-15.4, 12.2, 2.8], [17.2, -8.0, 2.2],
      [2.6, 19.4, 3.0], [-25.0, -7.6, 2.6], [11.8, 26.2, 2.4], [-33.0, 3.6, 2.0],
      [30.4, 8.2, 2.2], [-6.2, -25.0, 2.6], [21.0, 33.0, 2.4], [-19.0, 25.6, 2.2],
    ];
    for (const [px, pz, ps] of spots) {
      let blocked = false;
      for (const mk of marks) {
        const dx = px - mk.x, dz = pz - mk.z;
        if (dx * dx + dz * dz < (mk.r * 0.75 + ps * 0.4) ** 2) { blocked = true; break; }
      }
      if (blocked) continue;
      const g = new THREE.PlaneGeometry(ps * 2, ps * 1.7);
      g.rotateX(-Math.PI / 2);
      fxEmit(g, puddleMat, px, 0.042, pz, hash3(px, 1.3, pz) * 3.14, 0, 0, 1);
    }
  }
  {
    // GTAOのリングは陰影であって汚れではない。泥だまり・砂の吹き溜まりを別に敷く
    const decals = [];
    for (const mk of marks) if (mk.decal) decals.push(mk);
    for (const mk of decals) {
      // 大物の足跡まで素直に大きくすると、板1枚が広場を丸ごと沈めてしまう
      const s = Math.min(mk.r, 3.2) * 2.3;
      const g = new THREE.PlaneGeometry(s, s);
      g.rotateX(-Math.PI / 2);
      fxEmit(g, grimeMat, mk.x, 0.045, mk.z, hash3(mk.x, 2.5, mk.z) * 3.14, 0, 0, 1);
    }
    renderOrders.set(grimeMat, 3);
    // 煙は一番奥。手前の半透明より先に描かないと、幕やガラス越しで前後が入れ替わる
    renderOrders.set(plumeMat, -1);
    renderOrders.set(streakMat, 3);
  }
  }

  /* ------------------------------------------------------- 結合と出力 */
  // 飾りは影を落とさない。特に路面の貼り分けは床から数cm浮いているだけなので、
  // 影を落とすと広場一面に自己遮蔽の縞が出る
  const noHit = () => {};
  const flush = (store, parent, castShadow, noRaycast = false) => {
    for (const { mat, list } of store.values()) {
      const order = renderOrders.get(mat) ?? 0;
      const put = (g) => {
        const m = new THREE.Mesh(g, mat);
        // 路面の貼り分け板だけ影から外す（noShadowMats）。プロップの影は保つ
        m.castShadow = castShadow && !noShadowMats.has(mat);
        m.receiveShadow = true;
        m.renderOrder = order;
        // 雑草の板や120m先の遠景で弾が止まると理不尽なので、射線から外す
        if (noRaycast) m.raycast = noHit;
        parent.add(m);
      };
      let geo = list[0];
      if (list.length > 1) {
        const merged = mergeGeometries(list, false);
        // 属性が食い違って結合できなかった時だけ個別に置く（保険）
        if (!merged) { for (const g of list) put(g); continue; }
        geo = merged;
      }
      put(geo);
    }
    store.clear();
  };
  flush(solidChunks, solids, true);
  // プロップ（ドラム缶・木箱・消火栓・配管・瓦礫）にも影を落とさせる。
  // ここがfalseだったせいで、直射下にある小物が1つも影を持たず、
  // 全部が地面に浮いて見えていた（接地感が消える最大の原因）
  flush(propChunks, props, true);
  // 遠景都市だけは影を切ったまま。影カメラが場内±46mしか覆っていないので
  // 100m先のビルは影を落としようがなく、有効にしても描画コストが増えるだけ
  flush(fxChunks, props, false, true);

  /* ------------------------------------------------------- 衝突用Octree */
  const octree = new Octree();
  buildOctree(octree, solids);

  /* -------------------------------------------- スポーン地点と遮蔽情報 */
  // 江戸ステージは市街地と別のスポーン表を持つ（建物の配置が違うので流用できない）。
  // ただしarenaSpawns/teamSpawnsの「並び順に意味がある」制約はそのまま守る
  let enemySpawns, coverPoints, arenaSpawns, teamSpawns, coopSpawns;

  if (mapId === 'edo') {
    /* モンスターと1人用の敵が出てくる場所。**町の外縁から入ってくる形にする。**
       四方の門・裏通り・町外れの空き地に散らしてあり、境内(半径15.5m)の
       中には1つも置いていない——中央から湧くと、押し寄せてくる感じが消える。
       座標は tools/check-edo.mjs が「地形に埋まっていないか」を毎回測っている
       （前の並びは井戸と重なって4箇所が19cm埋まっていた） */
    enemySpawns = [
      // 四方の門の内側
      new THREE.Vector3(0, 0.1, -31.5), new THREE.Vector3(0, 0.1, 31.5),
      new THREE.Vector3(-31.5, 0.1, 0), new THREE.Vector3(31.5, 0.1, 0),
      // 町外れの四隅
      new THREE.Vector3(-31.5, 0.1, -20), new THREE.Vector3(31.5, 0.1, 20),
      new THREE.Vector3(-20, 0.1, -31.5), new THREE.Vector3(20, 0.1, 31.5),
      // 通りの端
      new THREE.Vector3(-21, 0.1, -31.5), new THREE.Vector3(21, 0.1, 31.5),
      new THREE.Vector3(-31.5, 0.1, 21), new THREE.Vector3(31.5, 0.1, -21),
      // 蔵の脇の空き地
      new THREE.Vector3(-24.5, 0.1, -24.5), new THREE.Vector3(24.5, 0.1, 24.5),
      new THREE.Vector3(-24.5, 0.1, 24.5), new THREE.Vector3(24.5, 0.1, -24.5),
    ];

    /* 1人用のAIが「ここに寄れば身を隠せる」と判断する遮蔽の一覧。
       協力プレイのモンスターは隠れないので使わない（monster.jsは隠れる状態を持たない）。
       町屋の角・井戸・積み俵・蔵の角を並べる */
    coverPoints = [
      // 社（中央）の四方の入口前
      [0, -6.5, 4.0], [0, 6.5, 4.0], [-6.5, 0, 4.0], [6.5, 0, 4.0],
      // 玉垣の角（境内の出入口の脇）
      [-15.5, -15.5, 2.6], [15.5, -15.5, 2.6], [-15.5, 15.5, 2.6], [15.5, 15.5, 2.6],
      /* 町屋の角。列は四方の RING=26 にあり、1辺あたり ALONG=±6/±18 の4棟。
         建物の内側の面（通りに面した側）は中心から23.2mの所にある */
      [-18, -23.2, 3.4], [-6, -23.2, 3.4], [6, -23.2, 3.4], [18, -23.2, 3.4],
      [-18, 23.2, 3.4], [-6, 23.2, 3.4], [6, 23.2, 3.4], [18, 23.2, 3.4],
      [-23.2, -18, 3.4], [-23.2, -6, 3.4], [-23.2, 6, 3.4], [-23.2, 18, 3.4],
      [23.2, -18, 3.4], [23.2, -6, 3.4], [23.2, 6, 3.4], [23.2, 18, 3.4],
      // 町屋の間の路地（4.8m）。ここが抜け道になる
      [-12, -26, 2.4], [0, -26, 2.4], [12, -26, 2.4],
      [-12, 26, 2.4], [0, 26, 2.4], [12, 26, 2.4],
      [-26, -12, 2.4], [-26, 0, 2.4], [-26, 12, 2.4],
      [26, -12, 2.4], [26, 0, 2.4], [26, 12, 2.4],
      // 四隅の蔵
      [-29, -29, 3.6], [29, -29, 3.6], [-29, 29, 3.6], [29, 29, 3.6],
      // 井戸（通りの曲がり角）
      [-19.5, -19.5, 2.0], [19.5, 19.5, 2.0], [-19.5, 19.5, 2.0], [19.5, -19.5, 2.0],
      // 胸の高さの遮蔽（積み俵・酒樽・材木・木箱）
      [-8.0, -18.5, 2.0], [8.0, 18.5, 2.0], [-18.5, 8.0, 2.0], [18.5, -8.0, 2.0],
      [-22.2, -8.0, 1.8], [22.2, 8.0, 1.8], [-8.0, 22.2, 1.8], [8.0, -22.2, 1.8],
      [-16.0, -16.0, 1.8], [16.0, 16.0, 1.8],
      [-22.4, 16.5, 2.4], [22.4, -16.5, 2.4], [16.5, 22.4, 2.4], [-16.5, -22.4, 2.4],
      // 四方の門
      [0, -34, 3.5], [0, 34, 3.5], [-34, 0, 3.5], [34, 0, 3.5],
    ].map(([x, z, r]) => ({ pos: new THREE.Vector3(x, 0, z), radius: r }));

    /* 対戦の湧き地点。市街地と同じ並び（中心から11〜18mの環＋
       先頭2つが真向かい35m）をそのまま使える。
       町屋の列は x=±15.8/±26.2、z=±15.8/±26.2 に置いてあり、
       この環の点はどれも通りか境内の中に落ちる（tools/check-edo.mjsで実測） */
    arenaSpawns = [
      new THREE.Vector3(-17.5, 0.1, 0), new THREE.Vector3(17.5, 0.1, 0),
      new THREE.Vector3(0, 0.1, -17.5), new THREE.Vector3(0, 0.1, 17.5),
      new THREE.Vector3(-12, 0.1, -12), new THREE.Vector3(-12, 0.1, 12),
      new THREE.Vector3(12, 0.1, 12), new THREE.Vector3(12, 0.1, -12),
    ];
    teamSpawns = [
      new THREE.Vector3(-17.5, 0.1, -3), new THREE.Vector3(-17.5, 0.1, 3),
      new THREE.Vector3(17.5, 0.1, -3), new THREE.Vector3(17.5, 0.1, 3),
    ];
    // 協力プレイは4人固まって出る（下のurban側の説明を読むこと）。
    // 半径13.8〜17.8mの帯なので、境内(0〜15.5m)の外周と環状の通りに落ちる。
    // どちらも建物を1軒も置いていない帯
    coopSpawns = [
      new THREE.Vector3(-17.5, 0.1, -3), new THREE.Vector3(-17.5, 0.1, 3),
      new THREE.Vector3(-13.5, 0.1, -3), new THREE.Vector3(-13.5, 0.1, 3),
    ];
  } else {
  enemySpawns = [
    new THREE.Vector3(-21, 0.1, -22), new THREE.Vector3(23, 0.1, 27),
    new THREE.Vector3(-33, 0.1, 9), new THREE.Vector3(32, 0.1, -12),
    new THREE.Vector3(-10, 0.1, 30), new THREE.Vector3(4, 0.1, -30),
    // (34,20)と(-16,-37)は瓦礫の山に埋まっていたので、隣の空き地へ寄せた
    new THREE.Vector3(-34, 0.1, -20), new THREE.Vector3(33, 0.1, 20),
    new THREE.Vector3(0, 0.1, 34), new THREE.Vector3(-28, 0.1, 30),
    new THREE.Vector3(20.5, 0.1, -25.5), new THREE.Vector3(-32.5, 0.1, 25.0),
    new THREE.Vector3(38, 0.1, -2), new THREE.Vector3(-17, 0.1, -36),
  ];

  // AIが「ここに寄れば身を隠せる」と判断するための遮蔽物リスト（位置と半径）。
  // 全身が隠れる物と胸の高さの物を混ぜて、詰める側にも寄る場所を用意する
  coverPoints = [
    // 全身が隠れる物（コンテナ・建物の角・小屋）
    // （2026-08-14 戦域の対称化: [13.5,0]のコンテナは消えたので外し、
    // 対で足したコンテナ2つを追加）
    [-8, 24, 3.5], [12, -12, 3.5], [-12, 12, 3.5], [-22, 10, 3.5], [-34, -6, 3.5],
    [-14, 20, 3.2], [16, -6, 3.0], [-16, 6, 3.0], [30, 4, 3.0], [4, 32, 3.0], [-26, 6, 3.0],
    [9.8, -19, 3.2], [9.8, -27, 3.2], [-35, -16, 3.0],
    [0, 30, 3.0], [-12.5, -20, 3.4], [15.5, 21, 3.4], [24, -18.5, 3.6],
    [8, -35, 3.0], [-31.8, 12.9, 3.0],
    // 胸の高さの遮蔽（車止め・土嚢・低い塀・荷捌き場）
    // （対称化で対になった側も追加。1人用のAIも新しい遮蔽を使えるように）
    [-6.5, -11, 3.0], [6.5, 11, 3.0], [10.5, -5, 2.8], [-10.5, 5, 2.8],
    [37, 4, 3.0], [31, 12, 2.6],
    [-24.5, -4, 3.0], [-20, -28, 3.0], [14, -30, 3.0], [16, 24, 3.0],
    [-20, 30, 2.8], [-24, 22, 2.8], [-8, -30, 4.0], [23, -19.8, 3.4],
    [-4.5, -16, 3.0], [4.5, 16, 3.0], [20, 0, 3.0], [-20, 0, 3.0],
    [6, 20, 3.0], [-6, -20, 3.0], [-24, 16, 2.6],
    [33, -16, 2.6], [-12, 34, 2.6],
    // 木箱・瓦礫・資材
    [-4, 14, 2.2], [4, -14, 2.2], [13.5, 7.5, 2.2], [-13.5, -7.5, 2.2],
    [-16, -6, 2.2], [16, 6, 2.2], [5, -23, 2.2],
    [31, -4, 2.2], [-6, 33, 2.2], [-30, 26, 2.2],
    [-29.5, 17, 3.0], [-15, -34, 2.8], [-24, 34, 2.6], [-26, -13.5, 2.4],
    [-30.5, -1.5, 2.0], [34, 18.5, 2.0], [-22, -34, 2.0], [20, -36, 2.2],
    // 中央の掩体
    [0, -7, 8.0], [0, 7, 8.0],
    // スポーン正面の手前の遮蔽。置いた物はAIにも遮蔽として見えていないと、
    // 敵が素通りして「置いてあるだけの飾り」になる
    [-5.8, 22.4, 3.0], [4.4, 24.0, 2.2], [-7.9, 24.8, 2.0],
  ].map(([x, z, r]) => ({ pos: new THREE.Vector3(x, 0, z), radius: r }));

  // 対戦用の湧き地点。対戦は中心から半径20m（protocol.jsのZONE）しか使わないので、
  // 場内全域に散らしてある上のenemySpawnsは1つも中に入っていない（一番近い所で30m）。
  //
  // 座標は目分量ではなく、上で組んだOctreeに対して0.5m刻みで総当たりして、
  //   ・真上から降ろした地面が高さ1.2m以下（コンテナの屋根や倉庫の2階に湧かせない）
  //   ・立ち姿のカプセルが地形に食い込まない
  //   ・頭上90cmに何も無い（低い庇の下で身動きが取れない場所を外す）
  // を全部満たした2843箇所から、互いに一番離れる8点を選んだもの。
  // 中心から11〜18mの帯に限っているのは、中央の掩体まわりは奪い合う場所であって、
  // 出てきた瞬間に立っている場所ではないから。
  //
  // 並び順に意味がある。1対1では席番号でそのまま引くので、
  // 先頭2つが「毎ラウンドの定位置」になる。この2つは中央を挟んで真向かい・35m離れ。
  // 順番を変えると開始位置が近づくので、入れ替える時は距離を測り直すこと
  arenaSpawns = [
    new THREE.Vector3(-17.5, 0.1, 0), new THREE.Vector3(17.5, 0.1, 0),
    new THREE.Vector3(0, 0.1, -17.5), new THREE.Vector3(0, 0.1, 17.5),
    new THREE.Vector3(-12, 0.1, -12), new THREE.Vector3(-10.5, 0.1, 10.5),
    new THREE.Vector3(12, 0.1, 12), new THREE.Vector3(10.5, 0.1, -10.5),
    // (-12,12)は戦域の対称化で置いたコンテナに埋まったので(-10.5,10.5)へ。
    // これで(10.5,-10.5)と180度回した対になり、湧きの並びも点対称になった
  ];

  /* 2対2の湧く位置。**味方2人が並んで出る。**
     並び順は席番号そのまま（0,1が左のチーム／2,3が右のチーム。
     どちらの席がどちらのチームかは protocol.js の TEAM_OF_SEAT）。

     上のarenaSpawnsは「全員が互いに敵」向けに4隅へ散らしてあるので、
     そのまま2対2に使うと**味方が35m離れた所からそれぞれ出てくる。**
     組んで戦う遊び方なのに、合流するまでが毎ラウンドの最初の仕事になっていた。

     味方同士は6m。声を掛けなくても互いが見える距離で、かつ手榴弾1発で
     2人まとめて飛ばない距離（爆風の半径は9.5mだが、中心から6m離れれば
     持っていかれるのは片方だけになる）。
     チーム同士は35mで、これは今までの1対1の開始距離と同じ */
  teamSpawns = [
    new THREE.Vector3(-17.5, 0.1, -3), new THREE.Vector3(-17.5, 0.1, 3),
    new THREE.Vector3(17.5, 0.1, -3), new THREE.Vector3(17.5, 0.1, 3),
  ];

  /* 協力プレイの湧く位置。**4人とも固まって出る。**

     ここが無くて、協力プレイは上のteamSpawns（2対2用）をそのまま使っていた。
     協力プレイは全員が同じチーム（modes.jsのteamOf）なのに、
     **3人目と4人目だけ35m離れた反対側から出てくる。**
     倒れた仲間を起こしにも行けず、相手はこちらを個別に追ってくるので、
     試合の頭からばらばらのまま削られる形になっていた
     （2026-08-17に「味方が範囲外に行きすぎてカバーができねえ」と言われた所）。

     4人が6m四方に収まる。2対2の味方同士(6m)と同じ間隔で、
     手榴弾1発で全員が飛ぶ距離ではない。
     どの点も歩ける所にあることは tools/check-coop.mjs が実際に歩かせて測る */
  coopSpawns = [
    new THREE.Vector3(-17.5, 0.1, -3), new THREE.Vector3(-17.5, 0.1, 3),
    new THREE.Vector3(-13.5, 0.1, -3), new THREE.Vector3(-13.5, 0.1, 3),
  ];
  }

  return {
    root,
    octree,
    // 衝突に参加する物のグループ。octreeはここから組んである。
    // tools/check-rays.mjs が「octreeのレイとメッシュのレイが同じ答えか」を
    // 突き合わせるのに使う（propsの飾りは衝突に入らないので比べる相手から外す）
    solids,
    enemySpawns,
    arenaSpawns,
    teamSpawns,
    coopSpawns,
    coverPoints,
    /* 江戸は南の門の内側から始める。**入ってきた所から参道が中央の社まで
       まっすぐ通っている**ので、初めて入った人でも進む先に迷わない
       （前は(0,28)で、町屋を建てた後はその建物の中だった） */
    playerSpawn: mapId === 'edo' ? new THREE.Vector3(0, 1.2, 31.5) : new THREE.Vector3(0, 1.2, 26),
    // 江戸は板塀が半径34mの正方形なので、その少し外(38)で止める。
    // 市街地は外周のコンクリ壁がそのまま当たり判定になるので、こちらは
    // 「壁の外へ出られると興ざめ」の最後の保険（本来は壁で止まる）
    bounds: mapId === 'edo' ? 38 : 40,
  };
}
