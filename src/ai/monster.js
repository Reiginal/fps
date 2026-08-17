// 協力プレイのモンスター。**姿も動きも手続きで作る**（兵士 src/ai/enemy.js と同じ流儀）。
//
// なぜ兵士(Enemy)を流用せずに別の物を書いたか
// ------------------------------------------
// 最初の実装は Enemy をそのまま縮尺だけ変えて使っていた。そこで実際に測ったら、
// **60秒で6体湧いて発砲1回・プレイヤーの体力は260→255** しか減らなかった。
// 理由は流用したAIの中身そのもので、2つある。
//
//   ① 兵士は「engageRange(9〜17m)まで詰めたら止まって撃ち合う」設計。
//      間に建物があって視線が通らないと、**遮蔽の裏で立ち尽くしたまま**になる。
//      1人用で表に出なかったのは、遊ぶ人が動き回るから勝手に視線が通っただけ
//   ② 地形に挟まると「加速→押し戻し」の3フレーム周期の足踏みに入って永久に固まる。
//      引っかかり脱出のジャンプは速さ0.7m/s未満でしか出ないのに、
//      この足踏みは0.73m/sなので条件を素通りする
//
// モンスターは「必ずこちらへ来る」のが遊びの芯なので、①も②も致命傷になる。
// だから止まる理由（遮蔽・伏せ・弾倉交換・射線待ち）を最初から持たせない。
// **視線が通っていなくても相手の位置へ向かって進み続ける。**
// 進めなくなったら横へ回り、それでも駄目なら跳ね、最後は地面へ潜って湧き直す。
//
// もう1つ、サーバーの負担も別物になる。
// 兵士は骨とメッシュを組んでから当たり判定を骨から読むので、サーバーでも
// 見た目を丸ごと組む必要があった（1体20ms、10体で1ティック2ms弱）。
// こちらは**当たり判定を位置と向きだけから計算で出す**ので、
// サーバーは見た目を1つも組まない（opts.visual=false）。
// クライアントとずれないのは、どちらも同じ数字（下のHIT表）から作るため。

import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const wrapPi = (a) => { let x = a; while (x > Math.PI) x -= TAU; while (x < -Math.PI) x += TAU; return x; };

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _ray = new THREE.Ray();

/* ------------------------------------------------------------ 状態の番号 */

/* スナップショット(protocol.jsのpackMonster)の state に乗る番号。
   **見た目の姿勢はこれだけで決まる。** クライアントはAIを1行も回さないので、
   「今なにをしているか」がここに乗っていないと、殴る前の溜めも咆哮も描けない */
export const MSTATE = {
  IDLE: 0,      // 湧いた直後。まだ誰も見つけていない
  SEEK: 1,      // 相手の方へ進んでいる（視線が通っていなくても進む）
  WINDUP: 2,    // 殴る前の溜め。**ここが見えるから避けられる**
  STRIKE: 3,    // 爪が出ている瞬間
  RECOVER: 4,   // 振り切った後の隙
  SPIT: 5,      // 口に火の玉を溜めている／吐いた直後
  STUN: 6,      // 壁に突っ込んで怯んでいる（ボスの突進の後）
  CHARGE: 7,    // ボスの突進
  STOMP: 8,     // ボスの踏みつけ（溜め→着地で周囲を薙ぐ）
  ROAR: 9,      // ボスの咆哮
  DEAD: 10,
};

/* ------------------------------------------------------------ 種類の表 */

/* 体格・強さ・技を1箇所に集める。遊んでみて手応えが合わなければここだけ触る。
   scale は「基準の姿(下のNOMINAL_H=1.62m)を何倍にするか」。
   当たり判定も銃口も見た目も全部この倍率から出るので、ここだけで体格が決まる。

   melee/ranged は排他ではない。ボスは両方持つ（殴りもするし火の玉も吐く）。 */
export const MONSTER_KINDS = {
  // 小型。**数で来る。**速くて脆く、まっすぐ突っ込んで爪で殴る
  crawler: {
    scale: 0.78, health: 62, speed: 5.4, radius: 0.36,
    melee: { damage: 12, reach: 2.4, windup: 0.42, strike: 0.14, recover: 0.55 },
    ranged: null,
    // 這うような低い姿。頭が大きく、尻尾が長い
    shape: { crouch: 0.30, headScale: 1.18, armLen: 0.92, tail: 1.25, belly: 0.92, horn: 0 },
    palette: 0,
  },
  // 大型。**遠くから焼いてくる。**遅くて硬い。近づかれると下がりながら吐く
  spitter: {
    scale: 1.32, health: 300, speed: 2.9, radius: 0.55,
    melee: { damage: 20, reach: 3.0, windup: 0.55, strike: 0.16, recover: 0.75 },
    ranged: {
      damage: 16, min: 6, max: 26, windup: 0.85, cooldown: 2.4,
      speed: 26, radius: 0.55, splash: 2.6,
      // 近づかれたら下がる。**この個体は距離で戦う**ので、詰められたら困る側
      keepAway: true,
    },
    // 腹が膨れていて背が高い。口が大きい
    shape: { crouch: 0.10, headScale: 1.30, armLen: 0.80, tail: 0.85, belly: 1.30, horn: 0 },
    palette: 1,
  },
  /* ボス。体高4.5m弱。**正面からは削り切れない。**
     背中のコブが弱点で、そこだけ3倍入る（下のHIT.WEAK_MUL）。
     引きつける人と背後へ回る人が要る、というのがこの試合の山場 */
  boss: {
    /* radiusは**歩く時の芯の太さだけ**（弾の当たり所は下のHIT表から出るので、
       ここを細くしても撃ちやすさは変わらない）。
       見た目通りの1.05m（差し渡し2.1m）にしていた頃は、実測で
       **湧き地点14箇所のうち爪が届いたのは4箇所**しかなかった——
       路地にも門にも引っかかって、町の中をほとんど歩けていない。
       0.78なら江戸の門(5.0m)も町屋の戸(2.2m)も通る。
       体の見た目が少し壁へめり込むが、来ないボスよりはるかにまし */
    scale: 2.75, health: 2600, speed: 3.1, radius: 0.78,
    /* 歩く時の背丈。**見た目(4.5m)より低くする。**
       素直に4.5mのカプセルで歩かせると、庇も門も鳥居も全部つかえて、
       建物の近くに立っている人には永久に届かない（実測で8m手前が限界だった）。
       当たり判定のカプセルは「体が通るか」だけを決める物で、
       弾の当たり所は別（下のHIT表）なので、ここを下げても撃ちやすさは変わらない。
       角と頭が庇を突き抜けて見える回があるが、来ないボスよりはるかにまし */
    colliderH: 0.60,
    melee: { damage: 34, reach: 4.6, windup: 0.62, strike: 0.18, recover: 0.85 },
    ranged: {
      damage: 22, min: 10, max: 34, windup: 1.0, cooldown: 5.0,
      speed: 24, radius: 0.85, splash: 3.4,
      /* **下がらない。** ボスは爪の方が本命（威力34、間合い4.6m）なので、
         火の玉は「遠くへ逃げた相手を追い立てる」ためだけに持たせている。
         ここをtrueにしていた頃は、min(10m)より近づくと必ず後退していて、
         **爪の間合いまで一度も詰めなかった**（onMeleeが出るのは突進の
         ぶつかりだけで、溜め→爪の一連が一度も見られない状態だった） */
      keepAway: false,
    },
    // 技。それぞれ独立した間隔で回る
    charge: { speed: 11.5, windup: 0.75, run: 1.9, damage: 40, cooldown: 9.0, stun: 2.2 },
    stomp: { windup: 0.70, radius: 6.5, damage: 30, cooldown: 7.5 },
    roar: { windup: 0.9, cooldown: 16.0 },
    shape: { crouch: 0.0, headScale: 1.10, armLen: 1.05, tail: 1.10, belly: 1.15, horn: 1 },
    palette: 2,
  },
};

/* 画面に出す名前。**撃破表示に「モンスター」としか出ないと、
   3種類いることが遊んでいる間ずっと伝わらない** */
export const MONSTER_NAMES = {
  crawler: '這いずり',
  spitter: '火吹き',
  boss: '主',
};

/* 基準の体高。この姿を1として、上のscaleで伸ばす。
   前傾しているので「背中の一番高い所」であって、頭の高さではない */
const NOMINAL_H = 1.62;

/* 当たり判定。**位置と向きだけから計算で出す。**
   骨から読まないので、サーバーは見た目を1つも組まなくていい。
   数字は「基準の姿(NOMINAL_H)を1とした時の、足元からの高さと前後」。
   zの負が前（兵士と揃えてある。ヨー0で前方が-Z） */
const HIT = {
  // 頭。前へ突き出している。**ここが一番小さくて、一番よく入る**
  HEAD: { y: 1.24, z: -0.86, r: 0.26, mul: 2.0 },
  // 胴。腰から首の付け根まで斜めに1本
  BODY: { ay: 0.92, az: 0.24, by: 1.32, bz: -0.60, r: 0.42, mul: 1.0 },
  // 脚。まとめて1本の筒
  LEG: { ay: 0.08, az: 0.06, by: 0.94, bz: 0.06, r: 0.34, mul: 0.72 },
  // 背中のコブ。**ボスだけが持つ弱点。** 前からは胴に隠れて狙えない
  WEAK: { y: 1.46, z: 0.30, r: 0.30, mul: 3.0 },
};

export const MONSTER_HIT = HIT;

/* 詰まりの判定。**ここが緩いと、挟まったモンスターが1体でも出た瞬間に
   波が永久に終わらなくなる**（生き残りが0にならないと次の波へ進まないため）。
   実際に流用していた頃は3フレーム周期の足踏みで固まったまま60秒過ぎていた */
const STUCK = {
  WINDOW: 1.0,     // この秒数ぶんの移動量を見る
  MOVED: 0.45,     // これだけ動けていなければ詰まり
  SIDE_S: 1.1,     // まず横へ回る秒数
  HOP_AT: 2.6,     // それでも駄目なら跳ねる
  BURROW_AT: 6.0,  // 最後は地面へ潜って湧き直す（ボスは潜らない。下のcanBurrow）
};

/* --------------------------------------------------- 手続き生成のテクスチャ */

/* 見た目は**ブラウザでしか組まない**（サーバーはopts.visual=falseで素通り）ので、
   テクスチャも材質も最初に姿を組む時まで作らない。
   サーバーで作ろうとすると、要らない計算を毎回起動時に払うことになる */

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// periodを整数に保つと端が巻き戻るので、タイリングしても継ぎ目が出ない
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const w = yf * yf * (3 - 2 * yf);
  const m = (n) => ((n % period) + period) % period;
  const x0 = m(xi), x1 = m(xi + 1), y0 = m(yi), y1 = m(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  return (a + (b - a) * u) + ((c + (d - c) * u) - (a + (b - a) * u)) * w;
}

function fbm(x, y, period, oct, seed) {
  let v = 0, amp = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    v += vnoise(x * f, y * f, period * f, seed + i * 71) * amp;
    amp *= 0.5; f *= 2;
  }
  return v;
}

function dataTex(data, size, srgb) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.needsUpdate = true;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/* 皮。まだら模様と、その上を走る筋（血管とも鱗の稜線とも読める）。
   単色の皮だと、いくら形を作っても「粘土の塊」にしか見えない。
   模様の粗さ(scaleN)を種類ごとに変えて、小型と大型が同じ皮に見えないようにする */
function hideTexture(base, dark, vein, scaleN, size = 128) {
  const d = new Uint8Array(size * size * 4);
  const br = (base >> 16) & 255, bg = (base >> 8) & 255, bb = base & 255;
  const dr = (dark >> 16) & 255, dg = (dark >> 8) & 255, db = dark & 255;
  const vr = (vein >> 16) & 255, vg = (vein >> 8) & 255, vb = vein & 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * scaleN, w = y / size * scaleN;
      // まだら。低い所ほど濃い色へ寄せる
      const blotch = fbm(u, w, scaleN, 4, 1733);
      let t = clamp((blotch - 0.34) * 2.2, 0, 1);
      // 筋。fbmの等高線を細く抜き出す
      const rid = Math.abs(fbm(u * 2.1, w * 2.1, scaleN * 2, 3, 907) - 0.5);
      const vk = clamp(1 - rid * 14, 0, 1) * 0.55;
      // 細かいざらつき。近づいた時に面が平らに見えないため
      const grain = (hash2(x, y, 4517) - 0.5) * 0.10;
      let r = dr + (br - dr) * t;
      let g = dg + (bg - dg) * t;
      let b = db + (bb - db) * t;
      r = r + (vr - r) * vk; g = g + (vg - g) * vk; b = b + (vb - b) * vk;
      const k = 1 + grain;
      const i = (y * size + x) * 4;
      d[i] = clamp(r * k, 0, 255); d[i + 1] = clamp(g * k, 0, 255); d[i + 2] = clamp(b * k, 0, 255);
      d[i + 3] = 255;
    }
  }
  return dataTex(d, size, true);
}

// 表面のでこぼこ。皮の模様と同じ種から作るので、模様と凹凸の位置が揃う
function hideRough(scaleN, size = 128) {
  const d = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size * scaleN, w = y / size * scaleN;
      const rid = Math.abs(fbm(u * 2.1, w * 2.1, scaleN * 2, 3, 907) - 0.5);
      // 筋の上だけ濡れて見える（粗さを下げる）。全面が同じ粗さだと生き物に見えない
      const v = 0.92 - clamp(1 - rid * 14, 0, 1) * 0.42 + (hash2(x, y, 88) - 0.5) * 0.10;
      const i = (y * size + x) * 4;
      d[i] = d[i + 1] = d[i + 2] = clamp(v * 255, 0, 255);
      d[i + 3] = 255;
    }
  }
  return dataTex(d, size, false);
}

/* 種類ごとの色。**色だけでなく模様の粗さも変える。**
   同じ模様の色違いは、遠目には同じ生き物の色違いにしか見えない */
const PALETTES = [
  // 小型: 生々しい赤茶。数で来るので、群れた時に地面から浮く明るさにしてある
  { base: 0x7b4438, dark: 0x38201c, vein: 0xb8705a, scaleN: 5, eye: 0xffc040 },
  // 大型: 病んだ緑。火を吐く口まわりだけ後で明るくする
  { base: 0x4d5c3a, dark: 0x232a1b, vein: 0x8fa055, scaleN: 4, eye: 0x9dff50 },
  // ボス: 黒に近い灰。**弱点のコブだけが光る**ので、体は沈ませる
  { base: 0x3b3a3c, dark: 0x1a191b, vein: 0x6d5f52, scaleN: 3, eye: 0xff4a2a },
];

let MATS = null;

function materials() {
  if (MATS) return MATS;
  MATS = PALETTES.map((p) => {
    const map = hideTexture(p.base, p.dark, p.vein, p.scaleN);
    const rough = hideRough(p.scaleN);
    const hide = new THREE.MeshStandardMaterial({
      map, roughnessMap: rough, roughness: 1, metalness: 0, vertexColors: true,
    });
    // 爪と角と牙。皮より硬く見せたいので、模様を持たせず粗さだけ落とす
    const horn = new THREE.MeshStandardMaterial({
      color: 0xc9c2b0, roughness: 0.42, metalness: 0.05, vertexColors: true,
    });
    // 目と口の奥。光る物は影を落とさない側に置く
    const glow = new THREE.MeshStandardMaterial({
      color: p.eye, emissive: p.eye, emissiveIntensity: 2.2, roughness: 0.6, toneMapped: true,
    });
    return { hide, horn, glow, eye: p.eye };
  });
  return MATS;
}

/* --------------------------------------------------------- 部品を焼く道具 */

/* 骨に対して動かない部品は1つのジオメトリへ焼く（enemy.jsのPartBagと同じ理屈）。
   細部を足しても描画呼び出しが増えない。
   頂点色は簡易AO。影を受けさせても、脇・股・顎の下・コブの根元の細かい暗がりは
   PCFの影では出ない。そこが無いと生き物が「均一な明るさの粘土」に潰れる */
class Bag {
  constructor() { this.items = []; this.ax = 0; this.ay = 0; this.az = 0; }

  at(x, y, z) { this.ax = x; this.ay = y; this.az = z; return this; }

  add(geom, mat, px = 0, py = 0, pz = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1) {
    geom.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(px, py, pz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz),
    ));
    this._ao(geom);
    this.items.push([geom, mat]);
    return this;
  }

  _ao(geom) {
    const pos = geom.attributes.position;
    const nor = geom.attributes.normal;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i) + this.ax, y = pos.getY(i) + this.ay, z = pos.getZ(i) + this.az;
      const ny = nor ? nor.getY(i) : 1;
      // 上を向く面が明るく、下を向く面が暗い。これだけで全身に階調が乗る
      let s = 0.78 + 0.22 * (ny * 0.5 + 0.5);
      // 腹の下。地面に近い所は光が回らない
      s *= 1 - 0.30 * sstep(0.55, 0.0, y);
      // 脇と股。四肢の付け根は必ず暗い
      s *= 1 - 0.26 * sstep(0.18, 0.0, Math.abs(y - 1.02)) * sstep(0.06, 0.22, Math.abs(x));
      // 顎の下と首の付け根
      s *= 1 - 0.30 * sstep(0.14, 0.0, Math.abs(y - 1.16)) * sstep(0.0, -0.5, z);
      // 背中のコブの根元
      s *= 1 - 0.22 * sstep(0.16, 0.0, Math.abs(y - 1.34)) * sstep(0.0, 0.4, z);
      col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = clamp(s, 0.40, 1);
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
      mesh.receiveShadow = true;
      group.add(mesh);
    }
    this.items.length = 0;
    return group;
  }
}

const pivot = (parent, x = 0, y = 0, z = 0) => {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  parent.add(g);
  return g;
};

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const ball = (r, w = 10, h = 7) => new THREE.SphereGeometry(r, w, h);
const cone = (r, h, seg = 7) => new THREE.ConeGeometry(r, h, seg);
const tube = (rt, rb, h, seg = 8) => new THREE.CylinderGeometry(rt, rb, h, seg, 1);

/* ------------------------------------------------------------------ 姿 */

/* 1体ぶんの骨とメッシュ。**基準の姿(NOMINAL_H=1.62m)で組む。**
   縮尺は root.scale で掛けるので、ここでは種類ごとの比率(shape)だけ効かせる。

   向きは兵士と揃えて「ヨー0で前方が-Z」。揃えていないと、
   remote.js／remoteMonsters.js の向きの計算をモンスターだけ別に書くことになる */
function buildMonster(kind) {
  const def = MONSTER_KINDS[kind];
  const sh = def.shape;
  const shared = materials()[def.palette];
  /* 皮と角は全個体で同じ物を使い回すが、**光る所だけは1体ずつ別に持たせる。**

     ここは1つで共有していた。animate()の最後で
     `p.mats.glow.emissiveIntensity = 1.6 + this.mouth * 2.6` と書いているので、
     共有していると**その種類の全個体の目が、最後に姿勢を作った1体の値になる。**
     つまり「溜めている個体の目が光る」という唯一の予告が、
     群れの中では誰の予告でもない点滅になっていた。倒れる絵(animateDeath)が
     0まで落とすので、1体倒れると生きている全員の目が消える回まであった。

     2026-08-17に「敵の攻撃モーションが俺に全く見えない。
     なんか気づいたらダメージ食らってる」と言われた所の正体がこれ。
     材質1つは軽い（同じシェーダで、値だけが別になる） */
  const M = { hide: shared.hide, horn: shared.horn, glow: shared.glow.clone(), eye: shared.eye };
  const root = new THREE.Group();

  // 腰。ここが体の付け根で、前傾も歩きの上下もここから下げる
  const hips = pivot(root, 0, 1.00 - sh.crouch * 0.30, 0);
  // 背骨。前傾を作る。**crouchが大きいほど深く倒れて、地を這う姿になる**
  const spine = pivot(hips, 0, 0, 0);
  spine.rotation.x = 0.62 + sh.crouch * 0.55;
  // 首。背骨の先から前へ出る
  const neck = pivot(spine, 0, 0.62, 0);
  const headPivot = pivot(neck, 0, 0.24, 0);
  const jaw = pivot(headPivot, 0, -0.06, -0.16 * sh.headScale);
  // 背中のコブ。ボスの弱点。ボス以外にも小さく付けて、輪郭を生き物に寄せる
  const hump = pivot(spine, 0, 0.34, 0.20);
  // 腕。長い。地面に届きそうな位置から出す
  const armL = pivot(spine, 0.26, 0.50, 0);
  const foreL = pivot(armL, 0, -0.46 * sh.armLen, 0);
  const armR = pivot(spine, -0.26, 0.50, 0);
  const foreR = pivot(armR, 0, -0.46 * sh.armLen, 0);
  // 脚。指行性（かかとが浮いている）。腿が後ろ、脛が前へ折れる
  const legL = pivot(hips, 0.20, -0.06, 0.04);
  const shinL = pivot(legL, 0, -0.46, 0);
  const footL = pivot(shinL, 0, -0.42, 0);
  const legR = pivot(hips, -0.20, -0.06, 0.04);
  const shinR = pivot(legR, 0, -0.46, 0);
  const footR = pivot(shinR, 0, -0.42, 0);
  // 尻尾。3節。輪郭に「人ではない物」の情報を足すのは、ここが一番効く
  const tail1 = pivot(hips, 0, 0.02, 0.22);
  const tail2 = pivot(tail1, 0, 0, 0.34 * sh.tail);
  const tail3 = pivot(tail2, 0, 0, 0.30 * sh.tail);

  const b = new Bag();

  /* 骨盤。上から見ると台形。ここが四角いままだと、腿の付け根が箱の角になる */
  b.at(0, 1.00, 0)
    .add(box(0.52, 0.34, 0.44), M.hide, 0, 0, 0.02)
    .add(ball(0.24), M.hide, 0, -0.02, 0.06, 0, 0, 0, 1.1, 0.8, 1.0);
  b.bake(hips);

  /* 胴。腰から首まで、前へ行くほど細くなる筒。
     腹(belly)を膨らませると大型が「食っている物が違う」体型に見える */
  b.at(0, 1.15, -0.20)
    .add(tube(0.22, 0.30, 0.66, 9), M.hide, 0, 0.33, 0)
    // 肋。横へ張り出させると、丸い筒が骨のある胸郭に見える
    .add(ball(0.30), M.hide, 0, 0.26, 0.02, 0, 0, 0, 1.24 * sh.belly, 0.86, 1.05 * sh.belly)
    .add(ball(0.24), M.hide, 0, 0.56, -0.02, 0, 0, 0, 1.08, 0.9, 1.0)
    // 背骨の突起。背中の稜線が1本通ると、前傾がシルエットで読める
    .add(box(0.07, 0.16, 0.09), M.horn, 0, 0.20, 0.24, 0.3, 0, 0)
    .add(box(0.07, 0.20, 0.09), M.horn, 0, 0.40, 0.22, 0.2, 0, 0)
    .add(box(0.06, 0.16, 0.08), M.horn, 0, 0.58, 0.18, 0.1, 0, 0);
  b.bake(spine);

  /* 背中のコブ。**ボスは光る。** 弱点がどこにあるかを言葉で説明しなくても、
     光っていれば撃つ。ボス以外は光らせず、輪郭を作る瘤としてだけ置く */
  if (sh.horn) {
    b.at(0, 1.46, 0.28)
      .add(ball(0.30), M.hide, 0, 0, 0, 0, 0, 0, 1.15, 0.95, 1.05)
      .add(ball(0.19), M.glow, 0, 0.04, 0.10, 0, 0, 0, 1.0, 0.85, 0.9)
      // コブを囲む骨板。光が漏れる隙間として読ませる
      .add(box(0.10, 0.26, 0.10), M.horn, 0.20, 0.02, 0.02, 0, 0, -0.4)
      .add(box(0.10, 0.26, 0.10), M.horn, -0.20, 0.02, 0.02, 0, 0, 0.4);
  } else {
    b.at(0, 1.42, 0.24).add(ball(0.17), M.hide, 0, 0, 0, 0, 0, 0, 1.1, 0.8, 1.0);
  }
  b.bake(hump);

  /* 首。太い。頭を前へ突き出すための土台 */
  b.at(0, 1.30, -0.30).add(tube(0.15, 0.19, 0.26, 8), M.hide, 0, 0.10, -0.06, 0.5, 0, 0);
  b.bake(neck);

  /* 頭。上顎だけをここに置き、下顎は別の骨(jaw)にして開閉させる。
     **口が開くかどうかで、生き物か置物かが決まる。**
     目は2つ。光らせるのは、暗い所で「どこを見ているか」が唯一の手掛かりになるため */
  const hs = sh.headScale;
  b.at(0, 1.24, -0.86)
    .add(ball(0.20), M.hide, 0, 0, 0, 0, 0, 0, 1.0 * hs, 0.86 * hs, 1.25 * hs)
    // 上顎。前へ伸ばす
    .add(box(0.24 * hs, 0.14 * hs, 0.30 * hs), M.hide, 0, -0.04 * hs, -0.24 * hs)
    // 牙。上から4本
    .add(cone(0.030 * hs, 0.13 * hs, 5), M.horn, 0.075 * hs, -0.10 * hs, -0.32 * hs, Math.PI, 0, 0)
    .add(cone(0.030 * hs, 0.13 * hs, 5), M.horn, -0.075 * hs, -0.10 * hs, -0.32 * hs, Math.PI, 0, 0)
    .add(cone(0.026 * hs, 0.10 * hs, 5), M.horn, 0.085 * hs, -0.10 * hs, -0.18 * hs, Math.PI, 0, 0)
    .add(cone(0.026 * hs, 0.10 * hs, 5), M.horn, -0.085 * hs, -0.10 * hs, -0.18 * hs, Math.PI, 0, 0)
    // 目
    .add(ball(0.037 * hs, 8, 6), M.glow, 0.093 * hs, 0.05 * hs, -0.16 * hs)
    .add(ball(0.037 * hs, 8, 6), M.glow, -0.093 * hs, 0.05 * hs, -0.16 * hs)
    // 眉の骨。目の上に庇があると、目が「顔に開いた穴」でなく眼窩に見える
    .add(box(0.26 * hs, 0.05 * hs, 0.12 * hs), M.hide, 0, 0.10 * hs, -0.16 * hs, -0.25, 0, 0);
  // 角。ボスだけ。輪郭を大きく見せる一番安い方法
  if (sh.horn) {
    b.add(cone(0.05, 0.42, 6), M.horn, 0.13, 0.16, 0.02, -0.35, 0, 0.45)
      .add(cone(0.05, 0.42, 6), M.horn, -0.13, 0.16, 0.02, -0.35, 0, -0.45);
  }
  b.bake(headPivot);

  // 下顎。開くと口の奥が光って見える（火を溜めている口）
  b.at(0, 1.16, -1.00)
    .add(box(0.20 * hs, 0.10 * hs, 0.28 * hs), M.hide, 0, -0.05 * hs, -0.10 * hs)
    .add(cone(0.026 * hs, 0.10 * hs, 5), M.horn, 0.070 * hs, 0.02 * hs, -0.20 * hs)
    .add(cone(0.026 * hs, 0.10 * hs, 5), M.horn, -0.070 * hs, 0.02 * hs, -0.20 * hs)
    .add(box(0.15 * hs, 0.03 * hs, 0.20 * hs), M.glow, 0, -0.01 * hs, -0.10 * hs);
  b.bake(jaw);

  /* 腕。上腕→前腕→爪。長くして地面近くまで垂らす。
     **人の腕の長さで作ると、どれだけ皮を汚しても人型にしか見えない** */
  const al = sh.armLen;
  for (const [arm, fore, side] of [[armL, foreL, 1], [armR, foreR, -1]]) {
    b.at(side * 0.26, 1.55, -0.10)
      .add(tube(0.10, 0.13, 0.46 * al, 7), M.hide, 0, -0.23 * al, 0)
      .add(ball(0.14), M.hide, 0, 0.02, 0, 0, 0, 0, 1.0, 0.9, 1.0);
    b.bake(arm);
    b.at(side * 0.26, 1.10, -0.10)
      .add(tube(0.075, 0.10, 0.42 * al, 7), M.hide, 0, -0.21 * al, 0)
      // 手。指3本＋親指。爪は前へ向ける
      .add(ball(0.09), M.hide, 0, -0.42 * al, 0, 0, 0, 0, 1.1, 0.8, 1.0);
    for (let i = 0; i < 3; i++) {
      const a = (i - 1) * 0.34;
      b.add(cone(0.028, 0.20, 5), M.horn,
        Math.sin(a) * 0.09, -0.50 * al, -0.07 - Math.cos(a) * 0.02, -2.1, a, 0);
    }
    b.add(cone(0.026, 0.15, 5), M.horn, -side * 0.08, -0.47 * al, 0.02, -1.5, 0, side * 0.5);
    b.bake(fore);
  }

  /* 脚。指行性。腿は後ろへ、脛は前へ折れて、足の指だけが地面に着く。
     人の脚（腿が下、脛が下、足が平ら）で組むと、どれだけ皮を汚しても人型になる */
  for (const [leg, shin, foot, side] of [[legL, shinL, footL, 1], [legR, shinR, footR, -1]]) {
    b.at(side * 0.20, 0.94, 0.04)
      .add(tube(0.13, 0.19, 0.46, 8), M.hide, 0, -0.23, 0)
      .add(ball(0.20), M.hide, 0, 0.02, 0, 0, 0, 0, 1.0, 0.9, 1.1);
    b.bake(leg);
    b.at(side * 0.20, 0.48, 0.04)
      .add(tube(0.085, 0.13, 0.42, 7), M.hide, 0, -0.21, 0);
    b.bake(shin);
    b.at(side * 0.20, 0.06, 0.04)
      // 足の甲。前へ長い
      .add(box(0.17, 0.09, 0.26), M.hide, 0, 0.02, -0.08)
      .add(cone(0.032, 0.16, 5), M.horn, 0.055, -0.01, -0.21, -1.7, 0, 0)
      .add(cone(0.032, 0.16, 5), M.horn, -0.055, -0.01, -0.21, -1.7, 0, 0)
      .add(cone(0.028, 0.13, 5), M.horn, 0, 0.00, 0.10, 1.7, 0, 0);
    b.bake(foot);
  }

  /* 尻尾。細くなる3節。歩くたびに横へ振れる */
  const tl = sh.tail;
  b.at(0, 1.00, 0.24).add(tube(0.10, 0.15, 0.34 * tl, 7), M.hide, 0, 0, 0.17 * tl, Math.PI / 2, 0, 0);
  b.bake(tail1);
  b.at(0, 1.00, 0.58).add(tube(0.065, 0.10, 0.30 * tl, 6), M.hide, 0, 0, 0.15 * tl, Math.PI / 2, 0, 0);
  b.bake(tail2);
  b.at(0, 1.00, 0.88)
    .add(tube(0.02, 0.065, 0.28 * tl, 6), M.hide, 0, 0, 0.14 * tl, Math.PI / 2, 0, 0)
    .add(cone(0.05, 0.18, 5), M.horn, 0, 0, 0.32 * tl, Math.PI / 2, 0, 0);
  b.bake(tail3);

  return {
    root, hips, spine, neck, headPivot, jaw, hump,
    armL, foreL, armR, foreR,
    legL, shinL, footL, legR, shinR, footR,
    tail1, tail2, tail3,
    mats: M,
  };
}

/* ------------------------------------------------- レイと形の交差（判定） */

function raySphere(o, d, c, r) {
  const ox = o.x - c.x, oy = o.y - c.y, oz = o.z - c.z;
  const b = ox * d.x + oy * d.y + oz * d.z;
  const cc = ox * ox + oy * oy + oz * oz - r * r;
  const h = b * b - cc;
  if (h < 0) return -1;
  const s = Math.sqrt(h);
  const t0 = -b - s;
  return t0 >= 0 ? t0 : (-b + s >= 0 ? 0 : -1);
}

function rayCapsule(o, d, a, b, r) {
  const bax = b.x - a.x, bay = b.y - a.y, baz = b.z - a.z;
  const oax = o.x - a.x, oay = o.y - a.y, oaz = o.z - a.z;
  const baba = bax * bax + bay * bay + baz * baz;
  const bard = bax * d.x + bay * d.y + baz * d.z;
  const baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = d.x * oax + d.y * oay + d.z * oaz;
  const oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  const B = baba * rdoa - baoa * bard;
  const C = baba * oaoa - baoa * baoa - r * r * baba;
  const h = B * B - A * C;
  if (h >= 0) {
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t >= 0 ? t : (oaoa < r * r ? 0 : -1);
    // 端の球
    const oc = y <= 0 ? { x: oax, y: oay, z: oaz } : { x: o.x - b.x, y: o.y - b.y, z: o.z - b.z };
    const bb = oc.x * d.x + oc.y * d.y + oc.z * d.z;
    const cc = oc.x * oc.x + oc.y * oc.y + oc.z * oc.z - r * r;
    const h2 = bb * bb - cc;
    if (h2 > 0) { const t2 = -bb - Math.sqrt(h2); return t2 >= 0 ? t2 : (cc < 0 ? 0 : -1); }
  }
  return -1;
}

/* ------------------------------------------------------------ モンスター */

export class Monster {
  /**
   * @param level  { octree, bounds, enemySpawns } （coverPointsは要らない。隠れないので）
   * @param kind   MONSTER_KINDSのキー
   * @param opts   { visual: 見た目を組むか }。**サーバーはfalse。**
   *               判定は位置と向きから計算で出すので、骨もメッシュも要らない
   */
  constructor(level, kind, opts = {}) {
    this.level = level;
    this.octree = level.octree;
    this.kind = kind;
    const def = MONSTER_KINDS[kind];
    this.def = def;
    this.scale = def.scale;

    this.visual = opts.visual !== false;
    this.parts = this.visual ? buildMonster(kind) : null;
    this.root = this.parts ? this.parts.root : null;
    if (this.root) this.root.scale.setScalar(this.scale);
    this.meshes = [];
    if (this.root) this.root.traverse((o) => { if (o.isMesh) this.meshes.push(o); });

    this.height = NOMINAL_H * this.scale * (def.colliderH ?? 1);
    this.radius = def.radius;
    this.collider = new Capsule(new THREE.Vector3(), new THREE.Vector3(), this.radius);

    this.maxHealth = def.health;
    this.health = def.health;
    this.alive = true;
    this.state = MSTATE.IDLE;
    this.stateT = 0;

    this.velocity = new THREE.Vector3();
    this.onFloor = false;
    this.yaw = Math.random() * TAU;
    this.pitch = 0;
    this.speed = def.speed;

    // 個体差。同じ歩調・同じ間合いで並ぶと群れが機械に見える
    this.gait = 0.92 + Math.random() * 0.22;
    this.turnRate = 3.4 + Math.random() * 2.0;
    this.phase = Math.random() * TAU;
    this.jitter = Math.random() * TAU;      // 進路の揺らぎ。一列に並ばせない

    this.meleeCd = 0;
    this.rangedCd = def.ranged ? Math.random() * 1.5 : 0;
    this.chargeCd = def.charge ? 4 + Math.random() * 4 : 0;
    this.stompCd = def.stomp ? 5 + Math.random() * 3 : 0;
    this.roarCd = def.roar ? def.roar.cooldown * 0.4 : 0;
    this.hasLOS = false;
    this.losTimer = 0;
    this.flinch = 0;
    this.groundY = 0;
    this.groundTimer = 0;

    // 詰まりの見張り
    this._lastPos = new THREE.Vector3();
    this._stuckWin = 0;
    this._stuckFor = 0;
    this._sideFor = 0;
    this._sideDir = Math.random() < 0.5 ? -1 : 1;
    this._wantHop = false;
    this._backoff = 0;

    // 見た目の姿勢（クライアントもサーバーも同じ変数を持つ。サーバーは骨へ流さない）
    this.mouth = 0;         // 口の開き 0..1
    this.rear = 0;          // 前脚を上げて立ち上がる量 0..1
    this.lunge = 0;         // 爪を振り抜く量 -1..1
    this.tell = 0;          // 「今から来る」の光り具合 0..1
    this.bodyTilt = 0;
    // 脚の角度を組み立てる時の入れ物。毎フレーム作らないために持っておく
    this._stepL = { thigh: 0, shin: 0, foot: 0, splay: 0 };
    this._stepR = { thigh: 0, shin: 0, foot: 0, splay: 0 };

    // 判定の当たり所（毎ティック位置を更新する）
    this._head = new THREE.Vector3();
    this._bodyA = new THREE.Vector3();
    this._bodyB = new THREE.Vector3();
    this._legA = new THREE.Vector3();
    this._legB = new THREE.Vector3();
    this._weak = new THREE.Vector3();

    // 出来事の受け口。server/monsters.jsが差し込む
    this.onMelee = null;    // (self, damage, reach) 爪が出た瞬間
    this.onSpit = null;     // (self, origin, dir) 火の玉を吐いた
    this.onStomp = null;    // (self, radius, damage)
    this.onRoar = null;     // (self)
    this.onDeath = null;    // (self)
    this.onStep = null;     // (self) 足音（大型とボスだけ鳴らす）
  }

  /* 弱点を持っているか。**ボスだけ。**
     小型にも付けると、遠くから背中を撃つだけの試合になる */
  get hasWeak() { return !!this.def.shape.horn; }

  // 地面へ潜って湧き直せるか。ボスは駄目（目の前から消えたら山場が壊れる）
  get canBurrow() { return this.kind !== 'boss'; }

  get feetY() { return this.collider.start.y - this.radius; }

  get eyeY() { return this.feetY + HIT.HEAD.y * this.scale; }

  spawn(pos) {
    this.collider.start.set(pos.x, pos.y + this.radius, pos.z);
    this.collider.end.set(pos.x, pos.y + this.height - this.radius, pos.z);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.alive = true;
    this.state = MSTATE.IDLE;
    this.stateT = 0;
    this.flinch = 0;
    this.mouth = 0; this.rear = 0; this.lunge = 0; this.bodyTilt = 0; this.tell = 0;
    this.meleeCd = 0;
    this.rangedCd = this.def.ranged ? Math.random() * 1.2 : 0;
    this._lastPos.copy(this.collider.start);
    this._stuckWin = 0; this._stuckFor = 0; this._sideFor = 0; this._wantHop = false;
    this._backoff = 0;
    this._syncHitboxes();
    if (this.root) { this.root.visible = true; this.root.rotation.set(0, 0, 0); }
  }

  /* 当たり所を今の位置と向きから作り直す。**骨は読まない。**
     読むとサーバーが見た目を組む羽目になるし、
     クライアントの補間位置とサーバーの真の位置がずれた時に、
     どちらの骨を信じるのかという話が増える */
  _syncHitboxes() {
    const s = this.scale;
    const x = this.collider.start.x, z = this.collider.start.z, y = this.feetY;
    const c = Math.cos(this.yaw), sn = Math.sin(this.yaw);
    /* ローカル(0,y,z)を向きで回して世界へ。xは常に0（体の中心線上）なので省ける。
       ヨー0で前方が-Zなので、前方ベクトルは(-sin,-cos)。
       ローカルzがlzの点は「前へ-lz進んだ所」なので、世界の足しは(lz*sin, lz*cos)になる */
    const put = (out, ly, lz) => out.set(x + sn * lz * s, y + ly * s, z + c * lz * s);
    put(this._head, HIT.HEAD.y, HIT.HEAD.z);
    put(this._bodyA, HIT.BODY.ay, HIT.BODY.az);
    put(this._bodyB, HIT.BODY.by, HIT.BODY.bz);
    put(this._legA, HIT.LEG.ay, HIT.LEG.az);
    put(this._legB, HIT.LEG.by, HIT.LEG.bz);
    if (this.hasWeak) put(this._weak, HIT.WEAK.y, HIT.WEAK.z);
  }

  /**
   * 弾のレイと交差するか。近い順に当たり所を見て、部位名を返す。
   * padは近接の刃の太さ（protocol.jsのMELEE_SWEEP）。兵士と同じで、
   * 体格では割らない——刃の幅は振る人の道具の話なので
   */
  intersect(origin, dir, pad = 0) {
    if (!this.alive) return null;
    const s = this.scale;
    const th = raySphere(origin, dir, this._head, HIT.HEAD.r * s);
    const tb = rayCapsule(origin, dir, this._bodyA, this._bodyB, HIT.BODY.r * s + pad);
    const tl = rayCapsule(origin, dir, this._legA, this._legB, HIT.LEG.r * s + pad);
    const tw = this.hasWeak ? raySphere(origin, dir, this._weak, HIT.WEAK.r * s) : -1;

    let best = Infinity, part = null;
    if (tb >= 0 && tb < best) { best = tb; part = 'body'; }
    if (tl >= 0 && tl < best) { best = tl; part = 'legs'; }
    /* 頭とコブは、胴より少し後ろでも優先する（兵士のintersectと同じ決まり）。
       胴のカプセルは太くて上端が丸いので、素直に手前を採ると
       顔を撃っても背中のコブを撃っても全部「胴」になる */
    const SPAN = HIT.BODY.r * 2 * s;
    if (th >= 0 && (part === null || th - best <= SPAN)) { best = th; part = 'head'; }
    if (tw >= 0 && (part === null || tw - best <= SPAN)) { best = tw; part = 'weak'; }
    if (!part) return null;
    return {
      distance: best,
      part,
      point: new THREE.Vector3().copy(origin).addScaledVector(dir, best),
      monster: this,
    };
  }

  /** 部位ごとの倍率。room.jsが電文へ載せる前に掛ける */
  static mulOf(part) {
    return part === 'head' ? HIT.HEAD.mul
      : part === 'weak' ? HIT.WEAK.mul
        : part === 'legs' ? HIT.LEG.mul : HIT.BODY.mul;
  }

  /** 当てられた。倒し切ったらtrue */
  hit(amount, part) {
    if (!this.alive) return false;
    this.health -= amount;
    this.flinch = Math.min(1, this.flinch + (part === 'head' || part === 'weak' ? 0.8 : 0.5));
    // 何もしていない時に撃たれたら気づく。**背後から撃たれても必ず振り向く**
    if (this.state === MSTATE.IDLE) this.state = MSTATE.SEEK;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.state = MSTATE.DEAD;
      this.onDeath?.(this);
      return true;
    }
    return false;
  }

  _lineOfSight(fromY, to) {
    _v.set(to.x - this.collider.start.x, to.y - fromY, to.z - this.collider.start.z);
    const dist = _v.length();
    if (dist < 0.001) return true;
    _v.divideScalar(dist);
    _ray.origin.set(this.collider.start.x, fromY, this.collider.start.z);
    _ray.direction.copy(_v);
    const hit = this.octree.rayIntersect(_ray);
    return !hit || hit.distance > dist - 0.25;
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

  /* 詰まりの見張りと脱出。**ここが効いていないと波が終わらない。**
     生き残りが0にならないと次の波へ進まない作りなので、
     1体でも永久に固まると試合がそこで止まる */
  _unstick(dt, wantsToMove) {
    this._stuckWin += dt;
    if (this._stuckWin < STUCK.WINDOW) return;
    const moved = Math.hypot(
      this.collider.start.x - this._lastPos.x,
      this.collider.start.z - this._lastPos.z,
    );
    this._lastPos.copy(this.collider.start);
    this._stuckWin = 0;
    if (!wantsToMove || moved >= STUCK.MOVED) {
      this._stuckFor = 0;
      this._sideFor = 0;
      return;
    }
    this._stuckFor += STUCK.WINDOW;
    // まず横へ回る。壁の角に正面から突っ込んでいるだけなら、これで抜ける
    if (this._sideFor <= 0) {
      this._sideFor = STUCK.SIDE_S;
      this._sideDir *= -1;
    }
    /* 次に跳ねる。段差・縁石・低い塀はこれで越える。
       **その場で跳ばせず、次に接地しているフレームまで持ち越す。**
       ここは1秒に1回しか通らないので、たまたまその瞬間に浮いていた個体は
       跳べずに終わる。挟まった個体はまさに押し戻されて浮いたり着いたりを
       繰り返しているので、その1回を逃すと「跳ねない個体」が出る */
    if (this._stuckFor >= STUCK.HOP_AT) this._wantHop = true;
    if (this._stuckFor >= STUCK.BURROW_AT) {
      if (this.canBurrow) {
        // 最後は地面へ潜って湧き直す。**倒せない置物として残すよりはまし**
        const sp = this.level.enemySpawns;
        if (sp && sp.length) {
          this.spawn(sp[Math.floor(Math.random() * sp.length)]);
          this.state = MSTATE.SEEK;
        }
      } else {
        /* 潜れない個体（ボス）はここで手が無くなる。**実際に詰んだ。**
           市街地の中央の掩体を挟んで向かい合うと、13mの所で押し戻され続けて
           一歩も近づけず、視線も通らないので突進も火の玉も条件に入らない
           ——倒しに来ないうえ何もしないボスになっていた。

           短い横歩き(SIDE_S=1.1秒)では、幅14mの建物は回り切れない。
           **一方向へ長く走り切る**ことで角を回らせる。相手の方へ寄る力を
           混ぜないのは、混ぜると建物の壁へ吸い寄せられて元に戻るため */
        this._sideFor = 4.5;
      }
      this._stuckFor = 0;
    }
  }

  /**
   * 毎ティック呼ぶ（サーバーだけ）。
   * @param target { pos:THREE.Vector3, eyeY:number, alive:boolean } 狙う相手
   * @param ctx    { others:Monster[] } 仲間。重なりを避けるのに使う
   */
  update(dt, target, ctx) {
    if (!this.alive) return;
    this.stateT += dt;
    this.flinch = Math.max(0, this.flinch - dt * 3.2);
    this.meleeCd = Math.max(0, this.meleeCd - dt);
    this.rangedCd = Math.max(0, this.rangedCd - dt);
    this.chargeCd = Math.max(0, this.chargeCd - dt);
    this.stompCd = Math.max(0, this.stompCd - dt);
    this.roarCd = Math.max(0, this.roarCd - dt);
    /* 間合いの取り直しは**毎ティック減らす。** SEEKの中だけで減らしていた頃は、
       殴り終わった次のフレームでまた爪の間合いに入って即WINDUPへ行くので、
       下がる時間が1フレームも取れず、値が2.3のまま止まっていた */
    this._backoff = Math.max(0, this._backoff - dt);

    const tp = target?.pos;
    const dx = tp ? tp.x - this.collider.start.x : 0;
    const dz = tp ? tp.z - this.collider.start.z : 0;
    const dist = Math.hypot(dx, dz);

    // 視線。毎ティック引くと重いので間引く（撃ち返す相手ではないので粗くてよい）
    this.losTimer -= dt;
    if (this.losTimer <= 0) {
      this.losTimer = 0.12 + Math.random() * 0.08;
      this.hasLOS = !!(tp && target.alive && this._lineOfSight(this.eyeY, _v2.set(tp.x, target.eyeY, tp.z)));
    }

    // 接地の高さ。足のIKと着地判定に使う。毎ティック引くと重いので間引く
    this.groundTimer -= dt;
    if (this.groundTimer <= 0) {
      this.groundTimer = 0.15 + Math.random() * 0.06;
      _ray.origin.set(this.collider.start.x, this.feetY + 0.5, this.collider.start.z);
      _ray.direction.set(0, -1, 0);
      const g = this.octree.rayIntersect(_ray);
      this.groundY = g ? this.feetY + 0.5 - g.distance : this.feetY;
    }

    const S = MSTATE;
    let wishX = 0, wishZ = 0, speedMul = 1;
    let wantYaw = tp ? Math.atan2(-dx, -dz) : this.yaw;

    /* -------------------------------------------------------- 技の選択 */
    // 溜め・振り・硬直の最中は何も選び直さない（選び直せる作りにすると、
    // 溜めているように見えてから急に別の技が出て、避ける手掛かりが嘘になる）
    const busy = this.state === S.WINDUP || this.state === S.STRIKE || this.state === S.RECOVER
      || this.state === S.SPIT || this.state === S.STUN || this.state === S.CHARGE
      || this.state === S.STOMP || this.state === S.ROAR;

    if (!busy) {
      if (!tp || !target.alive) {
        this.state = S.IDLE;
      } else {
        this.state = S.SEEK;
        const def = this.def;
        // ボスの技。近い順に見る。**同時に回さない**（1つ出ている間はbusy）
        if (def.stomp && this.stompCd <= 0 && dist < def.stomp.radius * 0.8) {
          this._enter(S.STOMP); this.stompCd = def.stomp.cooldown;
        } else if (def.charge && this.chargeCd <= 0 && this.hasLOS
                   && dist > def.melee.reach * 1.6 && dist < 26) {
          this._enter(S.CHARGE); this.chargeCd = def.charge.cooldown;
          this._chargeYaw = wantYaw;
        } else if (def.roar && this.roarCd <= 0 && dist < 20) {
          this._enter(S.ROAR); this.roarCd = def.roar.cooldown;
        } else if (dist <= def.melee.reach && this.meleeCd <= 0 && this._backoff <= 0) {
          this._enter(S.WINDUP);
        } else if (def.ranged && this.rangedCd <= 0 && this.hasLOS
                   && dist >= def.ranged.min && dist <= def.ranged.max) {
          this._enter(S.SPIT); this.rangedCd = def.ranged.cooldown;
        }
      }
    }

    /* -------------------------------------------------- 状態ごとの中身 */
    switch (this.state) {
      case S.IDLE:
        this.mouth += (0 - this.mouth) * Math.min(1, dt * 4);
        this.rear += (0 - this.rear) * Math.min(1, dt * 4);
        break;

      case S.SEEK: {
        /* **視線が通っていなくても相手の位置へ進む。**
           ここで「視線が通るまで待つ」を入れた瞬間、遮蔽の裏に群れが溜まって
           何も起きなくなる（流用していた頃に実際に起きた形） */
        if (!tp) break;
        // 相手へ向かう単位ベクトルと、その左手側（横へ流れる時に使う）
        const tx = dx / (dist || 1), tz = dz / (dist || 1);
        const sx = -tz, sz = tx;
        let ux = tx, uz = tz;
        /* 遠距離持ちは間合いを取る。**下がるのは視線が通っている時だけ。**
           通っていない時に下がると、壁の裏で永久に後退し続けて、
           流用していた頃と同じ「何も起きない試合」に戻る */
        const rg = this.def.ranged;
        if (this._backoff > 0) {
          // 殴った後の間合い取り直し（RECOVERから来る）。少し下がって次の技へ。
          // 減らすのは上のまとめて減らしている所
          ux = -tx; uz = -tz; speedMul = 0.85;
        } else if (rg && rg.keepAway && this.hasLOS && dist < rg.min) {
          ux = -tx; uz = -tz; speedMul = 0.75;
        } else if (rg && rg.keepAway && this.hasLOS && dist < rg.max * 0.7) {
          // 間合いの中。横へ流れながら次の吐きを待つ
          const side = Math.sin(this.jitter) > 0 ? 1 : -1;
          ux = sx * side; uz = sz * side;
          speedMul = 0.6;
        }
        // 進路を少し散らす。全員が最短距離で来ると一列になる
        this.jitter += dt * 0.7;
        const wob = Math.sin(this.jitter) * 0.28 * clamp((dist - 4) / 12, 0, 1);
        wishX = ux - uz * wob;
        wishZ = uz + ux * wob;
        // 詰まって横へ回っている最中は、進路をまるごと横へ倒す
        if (this._sideFor > 0) {
          this._sideFor -= dt;
          wishX = sx * this._sideDir;
          wishZ = sz * this._sideDir;
        }
        this.mouth += ((dist < 8 ? 0.5 : 0.12) - this.mouth) * Math.min(1, dt * 3);
        this.rear += (0 - this.rear) * Math.min(1, dt * 5);
        break;
      }

      case S.WINDUP: {
        // 溜め。**前脚を上げて大きく見せる。**ここが見えるから避けられる
        const w = this.def.melee.windup;
        this.rear += (1 - this.rear) * Math.min(1, dt * 9);
        this.mouth += (1 - this.mouth) * Math.min(1, dt * 8);
        this.lunge += (-0.7 - this.lunge) * Math.min(1, dt * 8);
        speedMul = 0.15;
        if (tp) { wishX = dx / (dist || 1) * 0.3; wishZ = dz / (dist || 1) * 0.3; }
        if (this.stateT >= w) this._enter(S.STRIKE);
        break;
      }

      case S.STRIKE: {
        this.lunge += (1 - this.lunge) * Math.min(1, dt * 22);
        this.rear += (0.2 - this.rear) * Math.min(1, dt * 16);
        if (!this._struck) {
          this._struck = true;
          this.onMelee?.(this, this.def.melee.damage, this.def.melee.reach);
        }
        if (this.stateT >= this.def.melee.strike) this._enter(S.RECOVER);
        break;
      }

      case S.RECOVER:
        this.lunge += (0 - this.lunge) * Math.min(1, dt * 7);
        this.rear += (0 - this.rear) * Math.min(1, dt * 7);
        this.mouth += (0.2 - this.mouth) * Math.min(1, dt * 5);
        speedMul = 0.35;
        if (this.stateT >= this.def.melee.recover) {
          this.meleeCd = 0.35;
          /* **殴り終わったら一度離れる。** 遠距離や突進を持っている個体
             （＝ボス）は、離れないとその技を一生使わない。
             爪の間合い(4.6m)に張り付いたままだと、突進(7.4m以上)も
             火の玉(10m以上)も条件に入らないため——実際そうなっていて、
             onMeleeが出るのは突進のぶつかりだけ、という状態だった。
             逃げるのではなく「次の技のために間合いを取り直す」動き */
          if ((this.def.charge && this.chargeCd <= 2.5)
              || (this.def.ranged && this.rangedCd <= 2.5)) {
            /* 2.6秒。**次の技が届く所まで下がり切る長さ**で決めてある。
               速さ3.1×0.85で約7m開くので、爪の間合い(4.6m)から
               突進の帯(7.4〜26m)と火の玉の下限(10m)の両方に入る。
               短いと下がりきる前に間合いへ戻ってしまい、技が一度も出ない */
            this._backoff = 2.6;
          }
          this._enter(S.SEEK);
        }
        break;

      case S.SPIT: {
        // 口に溜めてから吐く。溜めている間は口が光る（jawの奥のglow）
        const rg = this.def.ranged;
        this.mouth += (1 - this.mouth) * Math.min(1, dt * 6);
        speedMul = 0;
        if (this.stateT >= rg.windup && !this._spat) {
          this._spat = true;
          if (tp) {
            const oy = this.eyeY - 0.05 * this.scale;
            _v3.set(tp.x - this.collider.start.x, target.eyeY - 0.4 - oy, tp.z - this.collider.start.z).normalize();
            this.onSpit?.(this, _v.set(
              this.collider.start.x - Math.sin(this.yaw) * 0.7 * this.scale,
              oy,
              this.collider.start.z - Math.cos(this.yaw) * 0.7 * this.scale,
            ), _v3);
          }
        }
        if (this.stateT >= rg.windup + 0.35) { this._enter(S.SEEK); }
        break;
      }

      case S.CHARGE: {
        // 突進。溜め→直線に走る→壁か時間切れで怯む。**溜めの間に横へ避ける**
        const cg = this.def.charge;
        if (this.stateT < cg.windup) {
          this.rear += (0.6 - this.rear) * Math.min(1, dt * 8);
          speedMul = 0;
          this._chargeYaw = wantYaw;      // 溜めの間だけ狙いを追う
        } else {
          this.rear += (0 - this.rear) * Math.min(1, dt * 10);
          this.mouth += (1 - this.mouth) * Math.min(1, dt * 6);
          wantYaw = this._chargeYaw;      // 走り出したら曲がらない
          wishX = -Math.sin(this._chargeYaw);
          wishZ = -Math.cos(this._chargeYaw);
          speedMul = cg.speed / this.speed;
          // 走っている間に触れたらぶちかます
          if (tp && dist < this.radius + 2.2 && !this._struck) {
            this._struck = true;
            this.onMelee?.(this, cg.damage, this.radius + 2.6);
          }
          // 壁に当たったら怯む。onFloorが立たない＝横から押し返されている
          const spd = Math.hypot(this.velocity.x, this.velocity.z);
          if (this.stateT >= cg.windup + cg.run || (this.stateT > cg.windup + 0.35 && spd < 2.5)) {
            this._enter(S.STUN);
            this._stunFor = cg.stun;
          }
        }
        break;
      }

      case S.STUN:
        speedMul = 0;
        this.bodyTilt += (0.35 - this.bodyTilt) * Math.min(1, dt * 5);
        this.mouth += (0.6 - this.mouth) * Math.min(1, dt * 4);
        if (this.stateT >= (this._stunFor ?? 1.5)) { this.bodyTilt = 0; this._enter(S.SEEK); }
        break;

      case S.STOMP: {
        // 踏みつけ。溜めて立ち上がり、落として周囲を薙ぐ
        const st = this.def.stomp;
        speedMul = 0;
        if (this.stateT < st.windup) {
          this.rear += (1 - this.rear) * Math.min(1, dt * 7);
        } else {
          this.rear += (0 - this.rear) * Math.min(1, dt * 26);
          if (!this._struck) {
            this._struck = true;
            this.onStomp?.(this, st.radius, st.damage);
          }
          if (this.stateT >= st.windup + 0.55) this._enter(S.SEEK);
        }
        break;
      }

      case S.ROAR: {
        speedMul = 0;
        this.mouth += (1 - this.mouth) * Math.min(1, dt * 7);
        this.rear += (0.5 - this.rear) * Math.min(1, dt * 5);
        if (!this._struck) { this._struck = true; this.onRoar?.(this); }
        if (this.stateT >= this.def.roar.windup + 0.5) { this.rear = 0; this._enter(S.SEEK); }
        break;
      }

      default: break;
    }

    /* ------------------------------------------------ 仲間と重ならない */
    // 兵士は「離れて歩く」ための力だったが、モンスターは群れて来るのが持ち味なので、
    // **重なりを解くぶんだけ**にしてある。離しすぎると囲めなくなる
    const others = ctx?.others;
    if (others) {
      const mx = this.collider.start.x, mz = this.collider.start.z;
      for (let i = 0; i < others.length; i++) {
        const o = others[i];
        if (o === this || !o.alive) continue;
        const ox = mx - o.collider.start.x, oz = mz - o.collider.start.z;
        const need = (this.radius + o.radius) * 1.15;
        const d2 = ox * ox + oz * oz;
        if (d2 > need * need || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const w = (need - d) / need;
        wishX += (ox / d) * w * 1.4;
        wishZ += (oz / d) * w * 1.4;
      }
    }

    /* ------------------------------------------------------ 向きと移動 */
    const wl = Math.hypot(wishX, wishZ);
    if (wl > 1) { wishX /= wl; wishZ /= wl; }

    // 向き。**溜めと突進の最中は速く回さない**（避けた先へ吸い付くと理不尽になる）
    const turn = (this.state === S.WINDUP || this.state === S.CHARGE)
      ? this.turnRate * 0.35 : this.turnRate;
    this.yaw += wrapPi(wantYaw - this.yaw) * Math.min(1, dt * turn);
    this.pitch = tp && dist > 0.5
      ? clamp(Math.atan2((target.eyeY - this.eyeY), dist), -0.6, 0.6) : 0;

    const targetSpeed = this.speed * speedMul * (1 - this.flinch * 0.45);
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
      const step = Math.min((this.onFloor ? 13 : 3) * Math.max(targetSpeed, 1) * dt, add);
      this.velocity.x += wishX * step;
      this.velocity.z += wishZ * step;
    }
    this.velocity.y -= 22 * dt;

    const move = this.velocity.length() * dt;
    const steps = clamp(Math.ceil(move / 0.25), 1, 4);
    const sub = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.collider.translate(_v.set(this.velocity.x * sub, this.velocity.y * sub, this.velocity.z * sub));
      this._collide();
      // 持ち越してあった跳躍を、足が着いた最初のフレームで出す（_unstick参照）
      if (this._wantHop && this.onFloor) { this.velocity.y = 6.4; this._wantHop = false; }
    }
    // 場外へ出たら押し戻す。壁のない江戸の外周や、湧き直しの座標ずれの保険
    const b = this.level.bounds;
    if (b) {
      const c = this.collider;
      const px = clamp(c.start.x, -b, b), pz = clamp(c.start.z, -b, b);
      if (px !== c.start.x || pz !== c.start.z) {
        c.translate(_v.set(px - c.start.x, 0, pz - c.start.z));
      }
    }
    // 床を突き抜けて落ちた個体は湧き直す（Octreeの隙間に落ちた時の保険）
    if (this.collider.start.y < -20 && this.level.enemySpawns?.length) {
      this.spawn(this.level.enemySpawns[0]);
      this.state = MSTATE.SEEK;
    }

    this._unstick(dt, wl > 0.25 && speedMul > 0.2);
    this._syncHitboxes();

    // 足音。**大型とボスだけ。**小型まで鳴らすと、群れが来た時に音が飽和する
    if (this.onStep && this.scale >= 1.2 && this.onFloor) {
      const sp = Math.hypot(this.velocity.x, this.velocity.z);
      this.phase += dt * (0.6 + sp * 0.26) * this.gait * TAU;
      if (sp > 0.6 && this.phase - (this._lastStep ?? 0) > Math.PI) {
        this._lastStep = this.phase;
        this.onStep(this);
      }
    }
  }

  _enter(state) {
    this.state = state;
    this.stateT = 0;
    this._struck = false;
    this._spat = false;
  }

  /* スナップショットへ載せる中身（protocol.jsのpackMonsterへ渡す形） */
  packSource(mid) {
    return {
      mid,
      x: this.collider.start.x, y: this.feetY, z: this.collider.start.z,
      yaw: this.yaw, pitch: this.pitch,
      state: this.state, hp: this.health,
    };
  }

  /* ------------------------------------------------------------ 見た目 */

  /**
   * 姿勢を作る。**クライアントだけが呼ぶ。**
   * サーバーは骨を持たない（visual:false）ので、ここは丸ごと素通りする。
   * @param st { speed, state, stateT, mouth, rear, lunge, tilt }
   */
  animate(dt, st) {
    const p = this.parts;
    if (!p) return;
    const S = MSTATE;
    const spd = st.speed;
    const moving = spd > 0.3;
    const amp = clamp(spd / (this.speed || 4), 0, 1.2);
    const run = clamp((spd - 1.5) / 3.0, 0, 1);

    if (moving) {
      this.phase += dt * (0.85 + spd * 0.34) * this.gait * TAU;
      this.phase = ((this.phase % TAU) + TAU) % TAU;
    }
    const t = this.phase;

    // 溜め・突進・怯みで姿勢を寄せる。数値そのものはサーバーが持っていないので、
    // 状態番号から作り直す（電文に姿勢を全部載せるより安い）
    const wantRear = st.state === S.WINDUP ? 1 : st.state === S.STOMP ? 0.85
      : st.state === S.ROAR ? 0.5 : st.state === S.CHARGE ? 0.35 : 0;
    const wantMouth = (st.state === S.SPIT || st.state === S.ROAR || st.state === S.WINDUP) ? 1
      : st.state === S.STRIKE ? 0.8 : moving ? 0.35 : 0.1;
    const wantLunge = st.state === S.STRIKE ? 1 : st.state === S.WINDUP ? -0.7 : 0;
    const wantTilt = st.state === S.STUN ? 0.35 : 0;
    /* 「今から痛いのが来る」の合図。**目と口の奥を強く光らせる。**
       溜め・火を吐く前・踏みつけ・突進・咆哮の5つだけ。
       立ち上がる姿勢(rear)だけでは、小型が足元に居る時に画面へ入らない
       （体高1.26mなので、2.4mの間合いだと視線の下に沈む）。
       光は視界の端でも分かるので、姿勢と別に持たせる。
       上がるのは速く、消えるのは遅くする（振り終わってから気づいても間に合うように）*/
    const wantTell = (st.state === S.WINDUP || st.state === S.SPIT || st.state === S.STOMP
      || st.state === S.CHARGE || st.state === S.ROAR) ? 1 : 0;
    this.rear += (wantRear - this.rear) * Math.min(1, dt * 10);
    this.tell += (wantTell - this.tell) * Math.min(1, dt * (wantTell > 0 ? 16 : 6));
    this.mouth += (wantMouth - this.mouth) * Math.min(1, dt * 9);
    this.lunge += (wantLunge - this.lunge) * Math.min(1, dt * (wantLunge > 0 ? 24 : 8));
    this.bodyTilt += (wantTilt - this.bodyTilt) * Math.min(1, dt * 6);

    const rear = this.rear;

    /* 腰。走ると上下し、立ち上がると高くなる。
       前傾は種類ごとの姿勢(shape.crouch)から作り、立ち上がる量で起こす */
    const bob = (0.03 + run * 0.05) * amp;
    p.hips.position.y = (1.00 - this.def.shape.crouch * 0.30) + rear * 0.22
      + Math.cos(t * 2) * bob;
    p.hips.rotation.set(-rear * 0.30 + this.bodyTilt * 0.5, 0, Math.sin(t) * 0.06 * amp);

    // 背骨。立ち上がるほど起きる
    p.spine.rotation.x = (0.62 + this.def.shape.crouch * 0.55) * (1 - rear * 0.72)
      - this.bodyTilt * 0.4;
    p.spine.rotation.z = Math.sin(t) * 0.05 * amp;

    // 首と頭。狙いのピッチを首と頭で分けて乗せる
    p.neck.rotation.x = -0.35 * (1 - rear * 0.5) - st.pitch * 0.5;
    p.headPivot.rotation.x = -0.15 - st.pitch * 0.5 + Math.sin(t * 2) * 0.04 * amp;
    p.headPivot.rotation.z = Math.sin(t) * 0.05 * amp;
    // 顎。開くと口の奥の光が見える
    p.jaw.rotation.x = this.mouth * 0.62;

    /* 腕。歩く時は前後に振り、溜めで振りかぶって、振りで前へ叩き落とす。
       左右で少しずらすと「両手を揃えて振る人形」でなくなる */
    const swing = Math.sin(t) * 0.55 * amp;
    const strike = this.lunge;
    p.armL.rotation.x = -0.55 + swing * 0.6 - strike * 1.5 + rear * 0.9;
    p.armR.rotation.x = -0.55 - swing * 0.6 - strike * 1.35 + rear * 0.9;
    p.armL.rotation.z = 0.24 + rear * 0.25 - strike * 0.2;
    p.armR.rotation.z = -0.24 - rear * 0.25 + strike * 0.2;
    p.foreL.rotation.x = 0.75 + Math.max(0, swing) * 0.4 - strike * 0.9 - rear * 0.35;
    p.foreR.rotation.x = 0.75 + Math.max(0, -swing) * 0.4 - strike * 0.75 - rear * 0.35;

    /* 脚。指行性なので、腿が後ろへ／脛が前へ／足がその逆、で1歩になる。
       立ち上がっている間は前脚（＝腕）を上げているだけなので、脚は踏ん張らせる */
    /* 入れ物は使い回す（_stepOut）。**毎フレーム2つ作って捨てていた。**
       1体では気にならない量だが、協力プレイは同時に10体が歩くので、
       毎秒1200個の使い捨てになる。GCが動く回数がそのまま画面の息継ぎになる */
    const step = (out, ph, side) => {
      const s = Math.sin(ph), c = Math.cos(ph);
      out.thigh = 0.30 + s * 0.62 * amp - rear * 0.20;
      out.shin = -0.72 - Math.max(0, c) * 0.55 * amp - rear * 0.25;
      out.foot = 0.44 + Math.max(0, -s) * 0.30 * amp;
      out.splay = side * (0.06 + Math.abs(s) * 0.05 * amp);
      return out;
    };
    const l = step(this._stepL, t, 1), r = step(this._stepR, t + Math.PI, -1);
    p.legL.rotation.set(l.thigh, 0, l.splay);
    p.shinL.rotation.x = l.shin;
    p.footL.rotation.x = l.foot;
    p.legR.rotation.set(r.thigh, 0, r.splay);
    p.shinR.rotation.x = r.shin;
    p.footR.rotation.x = r.foot;

    // 尻尾。歩調に合わせて横へ振る。節ごとに遅らせると鞭のように見える
    const tw = Math.sin(t * 0.5) * 0.32 * (0.4 + amp);
    p.tail1.rotation.set(-0.30 + rear * 0.30, tw, 0);
    p.tail2.rotation.set(0.16, tw * 0.9, 0);
    p.tail3.rotation.set(0.20, tw * 0.8, 0);

    /* 口の奥と目の光。**歩いている時と溜めている時で3倍以上開ける。**
       前は 1.6 + mouth*2.6 で、歩き(2.5)と溜め(4.2)の差が1.7しかなかった。
       画面の端に映った時にその差は読めない */
    const g = p.mats.glow;
    g.emissiveIntensity = 1.3 + this.mouth * 1.4 + this.tell * 5.2;
  }

  /** 倒れる絵。クライアントが自分で進める（サーバーは倒れた瞬間しか教えない） */
  animateDeath(t) {
    const p = this.parts;
    if (!p) return;
    const k = clamp(t / 0.7, 0, 1);
    const fall = (1 - (1 - k) ** 3);
    p.root.rotation.x = fall * 0.9;
    p.root.rotation.z = fall * 0.5;
    p.hips.position.y = (1.00 - this.def.shape.crouch * 0.30) * (1 - fall * 0.55);
    p.spine.rotation.x = 0.62 + fall * 0.5;
    p.neck.rotation.x = -0.35 + fall * 0.9;
    p.jaw.rotation.x = 0.5 * (1 - fall);
    p.armL.rotation.x = -0.55 - fall * 0.8;
    p.armR.rotation.x = -0.55 - fall * 0.6;
    p.mats.glow.emissiveIntensity = 2.2 * (1 - k);
  }

  dispose() {
    if (!this.root) return;
    this.root.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose?.();
    });
    // 光る材質だけは1体ずつの持ち物なので、ここで解放する
    // （皮と角は共有なのでdisposeMonsterMaterials側）
    this.parts?.mats?.glow?.dispose?.();
  }
}

/* 材質はモジュールで共有している（全個体が同じ皮を使う）。
   場面を丸ごと畳む時だけ、ここから解放する */
export function disposeMonsterMaterials() {
  if (!MATS) return;
  for (const m of MATS) {
    m.hide.map?.dispose?.();
    m.hide.roughnessMap?.dispose?.();
    m.hide.dispose(); m.horn.dispose(); m.glow.dispose();
  }
  MATS = null;
}
