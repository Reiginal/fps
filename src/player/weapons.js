// 武器。モデルはプリミティブを組んで手で作り、動きは全部プログラムで付ける。
// 手付けアニメが無くても、反動のバネ・構えの遅れ・歩行の揺れを重ねると生きた動きになる。
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { muzzleFlashTexture, radialTexture, smokeTexture } from '../world/textures.js';
import { tryModelOverride } from './glbview.js';
import { applySkin, skinFor, shapeOf } from './skins.js';
// 持ち物の決まりだけ取り込む。protocol.jsはこちらを読まないので輪にならない
import {
  loadoutOf, NADE, MELEE_HEAVY, MELEE_SWEEP, DEFAULT_SKIN,
} from '../net/protocol.js';
// 強い一撃の音。低く長い（重い物を振ると空気の量が増える）
import { swingTune, gunTune } from '../core/audio.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _fwd = new THREE.Vector3(0, 0, 1);

const clamp = (a, b, c) => (a < b ? b : a > c ? c : a);
const clamp01 = (a) => (a < 0 ? 0 : a > 1 ? 1 : a);
const lerp = (a, b, t) => a + (b - a) * t;
// 覗いている時のバースト。3点にするのは、反動パターンが最初の数発で
// 一番読みやすい形をしているため（4発目から蛇行が始まる）
const BURST_COUNT = 3;
// バースト間の間隔。ライフルの連射間隔(0.094秒)の3倍強にして、
// 押しっぱなしでもフルオートより明確に遅くする
const BURST_GAP_S = 0.32;

/* --------------------------------------------------------- 近接の振り方

   **振り方は「形 × 左右」で変わる。**
   刀を短剣と同じ角度で振ると、長さのある物を持っている感じが出ない。

   1回の振りは3つの姿勢でできている:
     素の構え → back（振りかぶり） → thru（振り抜いた先） → 素の構え
   arcは途中で膨らむ量で、sinで乗るので**行きも帰りも通る道が同じにならない。**
   これが無いと、往復するだけの動きになって刃が「通り過ぎた」ように見えない。

   数字の意味（全部ビューモデルの相対値）:
     p … 前後の傾き。**プラスで切っ先が上を向く。**
          （X軸まわりの回転で、刃は手前から見て-Zを向いている。
           +θで先端が(0, sinθ, -cosθ)へ動く＝上がる。反動のkickPitchが
           プラスで銃口を跳ね上げているのと同じ向き）
          **ここを逆に書いたコメントのせいで、刀の右クリックを
          「真上から落とす」と書きながら下からえぐる動きにしていた。**
          pが小さい所から大きい所へ動く＝下から上へ振り上げている
     y … 左右の振り（プラスで右）
     r … 捻り（刃を寝かせるとプラスマイナスが大きくなる）
     z … 前後の位置（マイナスで前へ突き出す）
     h … 上下の位置

   **時間は見た目だけで、当たり判定にも間隔にも効かない。**
   間隔はrpm（左）とMELEE_HEAVY.COST（右）が決めるので、
   ここを長くしても速く振れるようにはならない。
   だから形ごとに変えてよい（刀は重いので遅く、ダガーは軽いので速い）。

   **強さは形で変わらない。**威力も間隔も間合いも全部同じ。
   形スキンはコインで買う物なので、強くなると「強さを買える」ことになる */
/* 武器を見る動き（5キー）。2026-08-11に「それぞれの武器で5を押したら
   武器を見るモーション欲しい」で足した。

   **形ごとに分けていない。** 振り方(SWINGS)は刃の軌道そのものなので形ごとに要るが、
   こちらは「手元へ引き寄せて回す」だけなので、どの武器でも同じ動きで成り立つ。
   スキンを買った人が買った物を眺める場所なので、**回して裏側まで見せる**のが要件。

   **2026-08-11に作り直した。** 最初は「1周回して裏側まで見せる」形にしたが、
   「なんか腕ごと回るってどういうこと？ちょっと見れればいいのよ」と言われた。

   正体は**腕が武器の模型の中に入っていること。**
   手と腕（buildHand）は銃と同じ群れの子なので、
   模型のrotation.zを回すと腕まで一緒に回る。**銃だけ回す方法が無い。**
   （回したければ腕を別の群れへ出す話になるが、
     構えも装填も振りも全部この群れの姿勢で作ってあるので、そこを触る話ではない）

   なので回すのはやめて、**少し持ち上げて傾けるだけ**にした。
   「ちょっと見れればいい」がそのまま要件。

   time … 全体の長さ(秒)
   in/out … 引き寄せる・戻すのにかける割合。間は持ち上げたまま止める
   tilt … 傾ける量(rad)。銃口を少し左へ向けて、天面がこちらを向く程度 */
const INSPECT = { time: 1.0, in: 0.22, out: 0.28, tilt: 0.34 };

export const SWINGS = {
  // ナイフ・左: 右上から左下への袈裟斬り。元からある動き
  'knife.light': {
    time: 0.42, wind: 0.22, speed: 2.2, fade: 0.55,
    back: { p: -0.55, y: 0.42, r: -0.50, z: -0.10, h: -0.05 },
    thru: { p: 1.25, y: -0.73, r: 1.00, z: -0.10, h: -0.05 },
    arc: { p: -0.25, y: 0, r: 0, z: 0.30, h: 0.15 },
  },
  /* ナイフ・右: 突き。**振らずに、引いてまっすぐ前へ出す。**
     左が「通り過ぎる」動きなのに対して、こちらは1点へ入れる動き。
     だから当たり判定も狭くて遠い（MELEE_SWEEP.HEAVY）*/
  'knife.heavy': {
    // 長さだけprotocol.jsから引く。あちらの説明が「通常より長い」なので、
    // 数字を写すと片方だけ動かした時に説明が嘘になる
    time: MELEE_HEAVY.TIME_S, wind: 0.38, speed: 3.0, fade: 0.46,
    /* 前へ出す量(z)は0.16まで。**構えの位置が-0.52なので、
       0.34も出すと画面から0.86の所まで離れて刃が6割の大きさに縮む**
       （遠近で1/zに効く）。突きは「速く出て速く戻る」で見せる */
    back: { p: -0.22, y: 0.20, r: -0.16, z: 0.14, h: 0.04 },
    thru: { p: 0.14, y: -0.05, r: 0.06, z: -0.16, h: -0.03 },
    arc: { p: 0.08, y: 0.04, r: 0, z: -0.05, h: 0.02 },
  },
  /* ---- 2026-08-11に足した3つ。**軸道を根本から分けるのが狙い。**
     それまで刀もダガーも「振る／突く」の2種類しか無く、
     着け替えても軌道が似ていた。
     斧の縦振りと拳のフックは、通る道が今までの物と重なっていない */

  /* レイピア・左: 突き。**一番速く出る。**
     細い刃は押しのける空気が少ないので、速さで見せる。
     刀の右クリックも突きだが、あちらは0.40秒でこちらは0.12秒 */
  'rapier.light': {
    time: 0.28, wind: 0.16, speed: 3.2, fade: 0.50,
    back: { p: -0.14, y: 0.14, r: -0.10, z: 0.10, h: 0.02 },
    thru: { p: 0.08, y: -0.03, r: 0.04, z: -0.20, h: -0.02 },
    arc: { p: 0.04, y: 0.02, r: 0, z: -0.04, h: 0.01 },
  },
  /* レイピア・右: 横一文字。**刀の横薙ぎより浅く速い。**
     細い刃は「薙ぐ」のではなく「切り裂く」ので、弧を小さく取る */
  'rapier.heavy': {
    time: 0.44, wind: 0.30, speed: 2.6, fade: 0.48,
    back: { p: -0.04, y: 0.52, r: -0.70, z: 0.06, h: 0.03 },
    thru: { p: 0.10, y: -0.68, r: -0.30, z: -0.08, h: -0.01 },
    arc: { p: -0.06, y: 0, r: 0.22, z: 0.08, h: 0.02 },
  },

  /* 斧・左: **真上から振り下ろす。** 今どの形も持っていない縦の軌道。

     **pはプラスで切っ先が上。** 振り下ろすには back.p を大きく（振りかぶって上）、
     thru.p を小さく（振り抜いて下）書く。
     ここを一度逆に書いて `-0.95 → +1.05` にしていた——
     刀の右クリックで「真上から落とす」と書きながら下からえぐっていたのと
     **同じ間違いを、同じ日に別の所でやった。**
     検査(check-melee)のえぐり判定は`.light`を飛ばすので（払いは上がって正しい）、
     ここは素通りしていた。斧の左だけ名指しで見る判定を足してある */
  'axe.light': {
    time: 0.58, wind: 0.36, speed: 2.4, fade: 0.46,
    back: { p: 0.95, y: 0.10, r: -0.12, z: 0.14, h: 0.12 },
    thru: { p: -1.05, y: -0.06, r: 0.08, z: -0.06, h: -0.18 },
    arc: { p: -0.10, y: 0, r: 0, z: 0.16, h: -0.04 },
  },
  /* 斧・右: 横に大きく薙ぐ。**一番遅くて一番大きい弧。**
     重い物を振り回す動きなので、行き過ぎてから戻る量(arc)も大きい */
  'axe.heavy': {
    time: 0.68, wind: 0.42, speed: 3.0, fade: 0.42,
    back: { p: -0.20, y: 1.05, r: -0.55, z: 0.16, h: 0.08 },
    thru: { p: 0.30, y: -1.20, r: 0.30, z: -0.04, h: -0.06 },
    arc: { p: -0.14, y: 0, r: 0.40, z: 0.20, h: 0.06 },
  },

  /* グローブ・左: 右のジャブ。**一番速い。**
     刃が無いので「振る」ではなく「出して戻す」。前へ出す量(z)を一番大きく取る */
  'glove.light': {
    time: 0.26, wind: 0.16, speed: 3.4, fade: 0.52,
    back: { p: -0.10, y: 0.10, r: -0.06, z: 0.12, h: 0.03 },
    /* 前へ出す量は-0.20まで。**構えが-0.52なので、出しすぎると
       拳が遠ざかって小さく見える**（遠近は1/zに効く。刀の突きで一度踏んだ罠。
       tools/check-melee.mjsが-0.28を線にして見張っている） */
    thru: { p: 0.06, y: -0.02, r: 0.02, z: -0.20, h: -0.03 },
    arc: { p: 0.03, y: 0.01, r: 0, z: -0.04, h: 0.01 },
  },
  /* グローブ・右: 大きなフック。**体ごと回す。**
     左手だけを独立して動かせない作りなので（振りは模型ごと動く）、
     捻り(r)を大きく取って「体の回転で殴った」に見せる */
  'glove.heavy': {
    time: 0.42, wind: 0.28, speed: 2.8, fade: 0.44,
    back: { p: -0.16, y: 0.62, r: -0.80, z: 0.14, h: 0.05 },
    thru: { p: 0.20, y: -0.58, r: 0.62, z: -0.14, h: -0.04 },
    arc: { p: -0.08, y: 0, r: 0.34, z: -0.06, h: 0.03 },
  },

  // 刀・左: 横薙ぎ。**縦に落とさず、水平に払う。**
  // 捻り(r)を大きく取って刃を寝かせ、振り(y)で右から左へ通す
  'katana.light': {
    time: 0.50, wind: 0.26, speed: 2.0, fade: 0.52,
    back: { p: -0.06, y: 0.78, r: -1.15, z: 0.08, h: 0.05 },
    thru: { p: 0.14, y: -1.02, r: -0.62, z: -0.05, h: -0.02 },
    arc: { p: -0.10, y: 0, r: 0.34, z: 0.14, h: 0.04 },
  },
  /* 刀・右: 刺突。**腰へ引いて、まっすぐ突き出す。**

     最初は唐竹割り（真上から縦に落とす）にしていたが、
     pの向きを取り違えていて**下からえぐる動き**になっていた。
     直すついでに突きへ変えてある。左が横に払う動きなので、
     右も縦に振ると「大きい横薙ぎと小さい横薙ぎ」に見えて差が出にくい。
     払う／突く で分けた方が、左右の役割が形からも分かる */
  'katana.heavy': {
    time: 0.66, wind: 0.44, speed: 3.4, fade: 0.44,
    // 引く。右腰へ寄せて、切っ先だけ前へ残す
    back: { p: 0.14, y: 0.34, r: -0.34, z: 0.14, h: -0.03 },
    // 突く。体の正面へ乗せて、まっすぐ前へ
    thru: { p: -0.02, y: -0.03, r: -0.06, z: -0.22, h: 0.01 },
    arc: { p: -0.05, y: 0, r: 0.03, z: -0.04, h: 0.01 },
  },
  // ダガー・左: 小さく速い払い。振り幅を半分にして、そのぶん短く終わる
  'dagger.light': {
    time: 0.30, wind: 0.18, speed: 2.8, fade: 0.58,
    back: { p: -0.30, y: 0.26, r: -0.30, z: -0.03, h: -0.02 },
    thru: { p: 0.72, y: -0.48, r: 0.62, z: -0.06, h: -0.04 },
    arc: { p: -0.14, y: 0, r: 0, z: 0.16, h: 0.08 },
  },
  // ダガー・右: 逆手に持ち替えて、上から突き下ろす（pが+0.40→-0.46で切っ先が下がる）
  'dagger.heavy': {
    time: 0.52, wind: 0.34, speed: 3.2, fade: 0.44,
    back: { p: 0.40, y: 0.24, r: -0.52, z: 0.16, h: -0.12 },
    thru: { p: -0.46, y: -0.12, r: -0.18, z: -0.17, h: 0.16 },
    arc: { p: 0.12, y: 0.05, r: 0.12, z: -0.04, h: 0.05 },
  },
  /* 手榴弾を投げる動き。**ナイフの左と同じ数字だが、別に置いてある。**
     同じ物を指すと、ナイフの振りを調整した時に投げ方まで動く */
  'nade.throw': {
    time: 0.42, wind: 0.22, speed: 2.2, fade: 0.55,
    back: { p: -0.55, y: 0.42, r: -0.50, z: -0.10, h: -0.05 },
    thru: { p: 1.25, y: -0.73, r: 1.00, z: -0.10, h: -0.05 },
    arc: { p: -0.25, y: 0, r: 0, z: 0.30, h: 0.15 },
  },
};

/**
 * どの振り方を使うか。**着けているスキンが形違いなら、その形の振り方。**
 * 色だけのスキンは元の武器と同じ動き（見た目しか変わらない物なので）。
 * 表に無い組み合わせはナイフの左へ寄せる（形を足して振り方を書き忘れても止まらない）
 */
export function swingOf(weaponId, kind, shapeId = shapeIdOf(weaponId)) {
  const shape = shapeId || weaponId;
  return SWINGS[`${shape}.${kind}`] || SWINGS[`${weaponId}.${kind}`] || SWINGS['knife.light'];
}

/**
 * 今その武器に着いている**形違いスキンのid**。色だけのスキンならnull。
 * 振り方（SWINGS）と振る音（audio.jsのSWING_TUNES）が両方これで引く
 */
function shapeIdOf(weaponId) {
  const skin = skinFor(weaponId);
  return shapeOf(skin) ? skin : null;
}
// 包帯を巻くのにかかる秒数。protocol.jsのHEAL.TIME_Sと同じ値を持つ
// （weapons.jsはprotocolを読まないので、ここだけ写す。片方を変えたら両方直すこと）
const HEAL_TIME = 2.4;

// 移動の速さ1m/sあたり、ばらつき角に足す量。
// 0.0045から下げてある。20m先の散らばりで見ると、走りながらの腰だめが
// 101cm→88cm、覗いた時が14cm→9cm。tools/check-aim.mjsで測っている
const MOVE_SPREAD = 0.0028;

const rand = (s) => (Math.random() - 0.5) * s;
// pがa..bの区間のどこにいるかを0..1で返す。装填の工程を時間軸に並べるのに使う
const seg = (p, a, b) => clamp01((p - a) / (b - a));
const ease = (t) => t * t * (3 - 2 * t);
const rnd4 = (v) => Math.round(v * 10000) / 10000;

/* ------------------------------------------------ 手続きで作る表面の凹凸 */

function ihash(x, y, s) {
  let h = (x * 374761393 + y * 668265263 + s * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function vnoise(x, y, p, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = x - xi, fy = y - yi;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const w = (i, j) => ihash(((xi + i) % p + p) % p, ((yi + j) % p + p) % p, s);
  const a = w(0, 0), b = w(1, 0), c = w(0, 1), d = w(1, 1);
  const t0 = a + (b - a) * ux;
  const t1 = c + (d - c) * ux;
  return t0 + (t1 - t0) * uy;
}

function fbm(x, y, f, oct, s) {
  let sum = 0, amp = 0.5, fr = f;
  for (let i = 0; i < oct; i++) {
    sum += vnoise(x * fr, y * fr, fr, s + i * 7) * amp;
    amp *= 0.5; fr *= 2;
  }
  return sum;
}

function dataTex(data, size) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

// 高さ場から法線と粗さを焼く。銃も手袋も面が完全に平らだと光が一様に返って
// 作り物に見えるので、微細な凹凸を入れて金属の中に階調を作る
function bakeSurface(size, hf, rf, strength) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) h[y * size + x] = hf(x / size, y / size);
  }
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  const nd = new Uint8Array(size * size * 4);
  const rd = new Uint8Array(size * size * 4);
  // 凸度と粗さの生値。あとで材質ごとに焼き直すので数値のまま持っておく
  const cv = new Float32Array(size * size);
  const rv = new Float32Array(size * size);
  let cmax = 1e-6;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      let nx = -dx, ny = -dy, nz = 1;
      const l = Math.hypot(nx, ny, nz);
      nx /= l; ny /= l; nz /= l;
      const i = (y * size + x) * 4;
      nd[i] = (nx * 0.5 + 0.5) * 255;
      nd[i + 1] = (ny * 0.5 + 0.5) * 255;
      nd[i + 2] = (nz * 0.5 + 0.5) * 255;
      nd[i + 3] = 255;
      // 粗さは倍率として持たせる。材質側のroughnessに掛かる
      const r = clamp01(rf(x / size, y / size, h[y * size + x]));
      rv[y * size + x] = r;
      rd[i] = rd[i + 1] = rd[i + 2] = r * 255;
      rd[i + 3] = 255;
      // 高さ場のラプラシアンの正側だけを拾うと、山の稜線＝角が取れる。
      // 実物は角から先に塗装が擦れて地金が出るので、これをエッジウェアの下地にする
      const lap = at(x + 1, y) + at(x - 1, y) + at(x, y + 1) + at(x, y - 1) - 4 * at(x, y);
      const p = lap > 0 ? lap : 0;
      cv[y * size + x] = p;
      if (p > cmax) cmax = p;
    }
  }
  // 擦れは全面に均一に出ると汚れに見える。低周波のむらを掛けて塊にする
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const patch = clamp01(fbm(x / size, y / size, 4, 3, 61) * 2.1 - 0.45);
      cv[i] = Math.pow(cv[i] / cmax, 0.55) * patch;
    }
  }
  return { n: dataTex(nd, size), r: dataTex(rd, size), cv, rv, size };
}

// ビーズブラストした金属。細かい梨地に薄い加工痕の筋を重ねる
const SURF_METAL = bakeSurface(96,
  (u, v) => fbm(u, v, 32, 3, 11) * 0.7 + Math.sin(v * 220) * 0.03 * fbm(u, v, 4, 2, 5),
  (u, v, h) => 0.80 + h * 0.28,
  3.0);

// 樹脂の梨地。金属より粒が粗く、光を散らす
const SURF_POLYMER = bakeSurface(96,
  (u, v) => Math.pow(fbm(u, v, 16, 4, 23), 1.4),
  (u, v, h) => 0.82 + h * 0.22,
  4.5);

// 布の織り目。手袋と袖に使う。
// 格子の振幅が大きいと、袖のように面積の広い部品で「斜めの網目が等間隔で繰り返す」のが
// 肉眼で読めてしまう（緑の水道ホースに見える原因）。格子は存在が分かる程度まで落として、
// 代わりに繊維のむら(fbm)を主役にする
const SURF_FABRIC = bakeSurface(96,
  (u, v) => (Math.sin(u * Math.PI * 32) * Math.sin(v * Math.PI * 32)) * 0.10 + 0.5
    + fbm(u, v, 24, 3, 41) * 0.5,
  (u, v, h) => 0.86 + h * 0.14,
  3.4);

/* ------------------------------------------------------------ 材質 */

// 角の地金出し（エッジウェア）と薄い埃を1枚から作る。
// 面積の大きい機関部や弾倉が色1つだと「塗り潰した多角形」に見えてしまうので、
// 凸度から アルベド／金属度／粗さ の3つを同時に振って階調を作る。
// 戻り値は map用(sRGB)と、G=粗さ・B=金属度に詰めた1枚
function bakeWear(surf, repeat, color, metalness, roughness, w) {
  const s = surf.size, n = s * s;
  const ad = new Uint8Array(n * 4);
  const md = new Uint8Array(n * 4);
  const br = (color >> 16) & 255, bg = (color >> 8) & 255, bb = color & 255;
  const wc = w.color != null ? w.color : 0x8b939c;
  const wr = (wc >> 16) & 255, wg = (wc >> 8) & 255, wb = wc & 255;
  const dAmt = w.dust || 0;
  const dc = w.dustColor != null ? w.dustColor : 0x9a8f7d;
  const dr = (dc >> 16) & 255, dg = (dc >> 8) & 255, db = dc & 255;
  const mTgt = w.metal != null ? w.metal : 1.0;
  const rTgt = w.rough != null ? w.rough : 0.20;
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const i = y * s + x;
      const k = clamp01(surf.cv[i] * w.amount);
      // 埃は低周波でうっすら。UVの上側ほど溜まる想定にして、
      // 上向きの面が明るくなる（＝立体に見える）方へ寄せる
      const du = dAmt > 0
        ? clamp01(fbm(x / s, y / s, 3, 3, 77) * 1.9 - 0.35) * dAmt * (0.30 + (y / s) * 0.70)
        : 0;
      let R = br + (wr - br) * k, G = bg + (wg - bg) * k, B = bb + (wb - bb) * k;
      R += (dr - R) * du; G += (dg - G) * du; B += (db - B) * du;
      const j = i * 4;
      ad[j] = R; ad[j + 1] = G; ad[j + 2] = B; ad[j + 3] = 255;
      const rr = clamp01((roughness * surf.rv[i]) * (1 - k) + rTgt * k + du * 0.30);
      const mm = clamp01((metalness * (1 - k) + mTgt * k) * (1 - du * 0.55));
      md[j] = 0; md[j + 1] = rr * 255; md[j + 2] = mm * 255; md[j + 3] = 255;
    }
  }
  const a = dataTex(ad, s);
  a.colorSpace = THREE.SRGBColorSpace;
  a.repeat.set(repeat, repeat);
  const p = dataTex(md, s);
  p.repeat.set(repeat, repeat);
  return { a, p };
}

/* **作った時の材料を覚えておく。** スキン（同じ銃の色違い）を作る時に、
   色と擦れだけ差し替えた物を作り直せるようにするため。

   ここに覚えさせるのが一番安い。銃の組み立てはプリミティブを手で並べる形で、
   材質は MATS.enamel のように**直に書かれている所が274箇所**ある。
   そこへ「どのスキンか」を配って回ると、274箇所を書き換えたうえに
   武器を1本足すたびに同じ配線が要る。

   材質を作る関数がこの1本しかないので、ここで控えを取れば全部拾える。
   後から色を変えたい時は recolor() が控えを見て作り直す */
const RECIPES = new WeakMap();

function mat(color, metalness, roughness, surf, repeat, nscale, extra, wear) {
  const m = new THREE.MeshStandardMaterial(
    Object.assign({ color, metalness, roughness }, extra || {}));
  RECIPES.set(m, [color, metalness, roughness, surf, repeat, nscale, extra, wear]);
  if (surf) {
    const n = surf.n.clone(); n.repeat.set(repeat, repeat);
    m.normalMap = n;
    // 罠: normalScaleをコンストラクタに数値で渡すとVector2が数値に潰れて壊れる。
    // 必ず生成後に .normalScale.set() する
    m.normalScale.set(nscale, nscale);
    if (wear) {
      const t = bakeWear(surf, repeat, color, metalness, roughness, wear);
      // 色はマップ側が全部持つ。材質のcolorを白にしないと二重に掛かって沈む
      m.color.setHex(0xffffff);
      m.map = t.a;
      m.roughness = 1.0;
      m.metalness = 1.0;
      m.roughnessMap = t.p;   // Gチャンネルを読む
      m.metalnessMap = t.p;   // Bチャンネルを読む
    } else {
      const r = surf.r.clone(); r.repeat.set(repeat, repeat);
      m.roughnessMap = r;
    }
  }
  return m;
}

/**
 * 材質を、色と擦れだけ変えて作り直す。**スキンはこれ1本で作る。**
 *
 * 表面の凹凸（SURF_*）・繰り返しの細かさ・法線の強さは引き継ぐ。
 * そこまで変えると「同じ銃の色違い」ではなく別の銃になってしまうし、
 * 凹凸は焼くのに時間がかかるので使い回したい。
 *
 * @param base 元の材質（MATSのどれか）
 * @param over { color, metalness, roughness, wear:{amount,color,dust,dustColor,metal,rough} }
 * @returns 新しい材質。元が控えに無ければ null
 */
export function recolor(base, over = {}) {
  const r = RECIPES.get(base);
  if (!r) return null;
  const [color, metalness, roughness, surf, repeat, nscale, extra, wear] = r;
  /* 擦れは**混ぜる**。amount だけ変えたい時に、色や埃まで既定へ戻ってしまうと
     スキンの表に元の値を全部書き写すことになる（そして必ずずれる） */
  const w = (wear || over.wear) ? { ...(wear || {}), ...(over.wear || {}) } : null;
  return mat(
    over.color ?? color,
    over.metalness ?? metalness,
    over.roughness ?? roughness,
    surf, repeat, nscale, extra, w,
  );
}

/**
 * 面に貼ってある材質から、色違いを1つ作る。**スキンはこれを呼ぶ。**
 *
 * 面に実際に貼られているのは、接触影(AO)を焼く時に作った複製のことが多い
 * （bakeStatic参照）。複製には控えが無いので、元を辿ってから作り直して、
 * 複製に掛かっていた設定（頂点カラー・縁光のシェーダー）を掛け直す。
 *
 * @param m    面に貼ってある材質
 * @param over 色や擦れの差し替え（recolorと同じ形）
 */
export function skinnedFrom(m, over) {
  const base = m.userData?.skinBase || m;
  const made = recolor(base, over);
  if (!made) return null;
  if (m.vertexColors) {
    made.vertexColors = true;
    // cloneと同じで、ここも写さないと縁光が消える
    made.onBeforeCompile = m.onBeforeCompile;
    made.customProgramCacheKey = m.customProgramCacheKey;
  }
  return made;
}

/** 面に貼ってある材質の、元の名前（MATSの鍵）。知らない物はnull */
export function matNameOf(m) {
  const base = m?.userData?.skinBase || m;
  for (const [k, v] of Object.entries(MATS)) if (v === base) return k;
  return null;
}

/** 銃の材質。**スキンはこの名前を指して色を差し替える** */
export const MATS = {
  // 焼入れ鋼。擦れて地金が出ている明るい部分。
  // 磨き鋼のまま金属度1.0で置くと、白飛びした空のenvMapをほぼ全反射で返して
  // 機関部上面だけが純白の板になる（未着色のプレースホルダーに見える）。
  // 実銃で機関部上面がむき出しの磨き鋼になることはないので、擦れの量も反射量も絞る
  steel: mat(0x5a6068, 1.0, 0.34, SURF_METAL, 3, 0.5, { envMapIntensity: 0.5 },
    { amount: 0.30, color: 0x7c838b, rough: 0.26 }),
  // パーカーライズド（リン酸塩皮膜）。ざらついて光を散らす軍用の黒
  phosphate: mat(0x2c2f34, 1.0, 0.68, SURF_METAL, 4, 1.0, null,
    { amount: 1.0, color: 0x7d858e, dust: 0.13 }),
  // 焼付塗装。半艶で少し樹脂寄りの黒
  enamel: mat(0x1d2024, 0.35, 0.50, SURF_METAL, 3, 0.5, null,
    { amount: 0.95, color: 0x6e767f, dust: 0.10 }),
  // アルマイト。レールと機関部上面。青みがあって金属の中で一段光る
  anodized: mat(0x3a414a, 1.0, 0.38, SURF_METAL, 3.5, 0.6, { envMapIntensity: 0.7 },
    { amount: 0.85, color: 0x939ba5, dust: 0.09 }),
  // 光学サイトの外皮。ADSでは画面中央をこれ1部品が占めるので、
  // 粗さを一定にすると縁に幅の広い白飛びハイライトが1枚だけベタっと乗って
  // 金属ではなく濡れたプラスチックに見える。粗さマップで艶を割っておく
  gunmetal: mat(0x1a1d21, 0.9, 0.46, SURF_METAL, 7, 0.75, { envMapIntensity: 0.65 },
    { amount: 0.45, color: 0x5e666f, rough: 0.30, dust: 0.07 }),
  // 樹脂。塗装金属とは反射の質が違うので分けておく。
  // 擦れても地金は出ないので、金属度の到達点を低く抑える
  polymer: mat(0x25282b, 0.0, 0.78, SURF_POLYMER, 4, 1.0, null,
    { amount: 0.6, color: 0x5b6167, metal: 0.12, rough: 0.42, dust: 0.15 }),
  polymerTan: mat(0x46413a, 0.0, 0.86, SURF_POLYMER, 9, 1.3, null,
    { amount: 0.55, color: 0x6d675c, metal: 0.10, rough: 0.50, dust: 0.14 }),
  // ゴム。バットパッドと握把の当て板。ほぼ光らない
  rubber: mat(0x131417, 0.0, 0.98, SURF_POLYMER, 7, 1.4),
  brass: mat(0xb8903e, 1.0, 0.30, SURF_METAL, 3, 0.4, null,
    { amount: 0.5, color: 0xe0c179, rough: 0.14 }),
  // 赤いショットシェル。暗い銃の中で唯一の色味になる
  shell: mat(0x8e211a, 0.0, 0.62, SURF_POLYMER, 3, 0.7),
  // 手袋。布と当て革と掌のゴムで3層に分ける。
  // 銃（紺黒）から分離させたくてアルベドを中間グレーまで上げていたが、
  // 日陰にあるはずの手が日向の砂嚢と同じ輝度（平均135）まで光り、
  // 指の1本1本ではなく「白い塊」として読めるようになっていた。材質もラテックスに見える。
  // アルベドは布として妥当な暗さまで落として、銃との分離はリムライトと接触影に任せる。
  // 無地の単色メッシュに見えないよう、織り目の山だけ色が抜けるwearを掛ける
  // 織り目の凹凸と山の色抜けは、腰だめの縮尺を0.53→0.86へ上げて手が画面上で
  // 1.6倍になったぶん実際に読めるようになる。無地の塊に見せないよう一段強める
  // 青灰色(0x3a3e42)は背景のコンクリートと同じ無彩色・同じ明度で、
  // 実測でも手袋の輝度中央値75に対して背景が78＝差がゼロだった。
  // 布として妥当な範囲で色相を土色側へ振り、明度も一段落とす（袖と同じ系統に揃う）
  glove: mat(0x38352c, 0.0, 0.88, SURF_FABRIC, 6, 1.4, null,
    { amount: 0.62, color: 0x585448, metal: 0.0, rough: 0.80, dust: 0.10, dustColor: 0x7a7166 }),
  // 拳の当て革。粗さを落として関節にスペキュラを立てる（指の関節が線として出る）。
  // 手袋の中の3層は明度差を保ったまま、同じ比率で落とす
  gloveHard: mat(0x34312a, 0.18, 0.42, SURF_POLYMER, 7, 1.1),
  palm: mat(0x24272b, 0.0, 0.95, SURF_POLYMER, 9, 1.5),
  // 袖は画面下部で一番面積が広い。彩度が高いと視線が銃でなく袖へ吸われるので抑える。
  // 緑に寄っていたぶんを落として、色ではなく明度の変化で布に見せる。
  // 織り目のrepeatを上げて、等間隔の網目が肉眼で読めないところまで細かくする
  sleeve: mat(0x2b2c26, 0.0, 0.97, SURF_FABRIC, 18, 1.6, null,
    { amount: 0.50, color: 0x484a40, metal: 0.0, rough: 0.92, dust: 0.13, dustColor: 0x6f6555 }),
  strap: mat(0x4a4e40, 0.0, 0.92, SURF_FABRIC, 3, 1.1),
  // 筒の内壁も描かないと、覗いた時に穴が抜けて背景が見えてしまう。
  // 内壁が光ると覗いた時に開口の縁が白く回るので、粗さマップを掛けて完全に消す
  opticTube: mat(0x101216, 0.15, 0.94, SURF_POLYMER, 8, 0.6, { side: THREE.DoubleSide }),
  // レンズ。実物のダットサイトは透過率90%で、覗いた時は外の世界がそのまま見える。
  // 環境マップを強く拾わせると映り込みが透過像を上書きして、
  // 「筒の中だけ青白い平面が貼ってある」画になるので、正面から見た時の反射は最小に保つ。
  // ただし0.25まで落とすと横から見た時も何も映らず、ただの穴になる。
  // 下のonBeforeCompileで「浅い角度で見た面ほど反射する」フレネルを足してあるので、
  // 正面（＝覗いている時）は素通しのまま、横顔だけコーティングの色が出る
  glass: new THREE.MeshStandardMaterial({
    color: 0xdfe8f0, metalness: 0.0, roughness: 0.03,
    transparent: true, opacity: 0.04, depthWrite: false, envMapIntensity: 0.55,
    // ドームなので裏を向く面がある。片面だと接眼側から見た時に硝子が消える
    side: THREE.DoubleSide,
  }),
  // 対物ベゼルのローレット（滑り止めの刻み）。
  // 筐体と同じgunmetalで作ると、画面中央を占める部品なのに継ぎ目が1本も無い
  // 成形プラスチックの輪に見える。粗さを一段上げて、周方向の目を細かく刻む
  knurl: mat(0x1e2126, 0.85, 0.62, SURF_METAL, 16, 1.25, { envMapIntensity: 0.5 },
    { amount: 0.55, color: 0x6a727b, rough: 0.34, dust: 0.08 }),
  // 赤ドット。板にベタ塗りだと画素の四角がそのまま芯になる。
  // 丸い滲みの中心に赤い正方形が入るのが一番安物に見えるので、必ず丸マスクを掛ける。
  // depthTestを切ると筒でも銃身でも遮蔽されず、ヒップでは筒の側面や外周に
  // 赤い点が乗って見える。実物のドットは接眼側から軸上でしか見えないので深度を戻し、
  // レンズとのZファイトはpolygonOffsetで逃がす
  dot: new THREE.MeshBasicMaterial({
    color: 0xff2b1a, toneMapped: false, transparent: true, opacity: 1,
    map: radialTexture(64, 1.4, 0.85), blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }),
  // レティクルの輪。芯のドットだけだと輪郭が無くて滲みに見えるので、細いリングを足す
  reticle: new THREE.MeshBasicMaterial({
    color: 0xff3320, toneMapped: false, transparent: true, opacity: 0.8,
    blending: THREE.AdditiveBlending, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }),

  /* ---- ここから下は形違いのスキンだけが使う材質。
     普段の銃には1つも貼られていないので、素の見た目は1ミリも変わらない */

  // 竜の鱗。暗い赤銅。擦れると金が出る
  scale: mat(0x3a1c18, 1.0, 0.42, SURF_METAL, 5, 1.1, { envMapIntensity: 0.6 },
    { amount: 0.9, color: 0xc79a4a, rough: 0.24, dust: 0.10 }),
  // 竜の角と牙。骨。金属ではないので反射を落とす
  bone: mat(0xc9bfa6, 0.0, 0.66, SURF_POLYMER, 6, 1.0, null,
    { amount: 0.7, color: 0xe8e0cc, metal: 0.0, rough: 0.52, dust: 0.14 }),
  /* 竜の目と、口の奥の熾火。**光る物は素の材質では出せない。**
     toneMapped:false で色をそのままHDRへ振ると、postfxのbloom(閾値0.95)を越えて
     周りへ滲む。加算合成にすると背景が暗い所で強く出る */
  ember: new THREE.MeshBasicMaterial({
    color: new THREE.Color(4.2, 1.1, 0.25), toneMapped: false,
    transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
  }),

  // ここから可愛い系。**彩度は上げるが明度は上げすぎない。**
  // 白に近づけると、日向で背景の砂嚢と同じ輝度に溶けて銃の形が読めなくなる
  candyPink: mat(0xd98aa6, 0.0, 0.55, SURF_POLYMER, 5, 0.8, null,
    { amount: 0.35, color: 0xf0b8ca, metal: 0.0, rough: 0.40 }),
  candyMint: mat(0x7fc9b8, 0.0, 0.52, SURF_POLYMER, 5, 0.8, null,
    { amount: 0.35, color: 0xaee2d6, metal: 0.0, rough: 0.38 }),
  candyCream: mat(0xe0d3b4, 0.0, 0.60, SURF_POLYMER, 6, 0.9, null,
    { amount: 0.30, color: 0xf2ead6, metal: 0.0, rough: 0.44 }),
  // チャームの星。金属で光らせる。emissiveにすると昼間でも自己主張が強すぎた
  charm: mat(0xd9a52a, 1.0, 0.22, SURF_METAL, 3, 0.4, null,
    { amount: 0.4, color: 0xf5dc8a, rough: 0.14 }),

  /* ---- ウエスタン（ショットガンの形違い）。2026-08-11 ----
     **今の品揃えに木が1本も無い**ので、ここが一番効く。
     木は金属と反射の質が根本的に違う（金属度0・粗さが高い）ので、
     色だけ茶色にした金属とは並べた瞬間に見分けが付く */
  walnut: mat(0x4a2a18, 0.0, 0.72, SURF_POLYMER, 3, 1.5, null,
    // 擦れの色を明るい木肌にすると、角の当たった所だけ地の木が出て使い込んで見える
    { amount: 0.55, color: 0x8a5a34, metal: 0.0, rough: 0.58, dust: 0.10 }),
  /* 彫金。真鍮(brass)より一段明るくして粗さを落とす。
     **既にあるbrassと分けてあるのは、彫った線を光らせたいため。**
     同じ材質だと帯と彫りが1つの塊に見えて、彫金だと読めない */
  engrave: mat(0xd8b25a, 1.0, 0.16, SURF_METAL, 2, 0.3, null,
    { amount: 0.35, color: 0xf6e3a8, rough: 0.10 }),

  /* ---- アイス（スナイパーの形違い）。2026-08-11 ----
     **今ある6つが全部暗いか原色で、明るい銃が1本も無い。**
     白は遠目でも一番はっきり分かる */
  frost: mat(0xdce8f2, 0.0, 0.80, SURF_POLYMER, 7, 1.3, null,
    // 霜は擦れると下の氷が出る。青を残した白へ抜けさせる
    { amount: 0.45, color: 0xf4fbff, metal: 0.0, rough: 0.66, dust: 0.06 }),
  // 氷の芯。金属寄りにして薄く光らせる（真っ白だと発泡樹脂に見える）
  glacier: mat(0x8fc0dc, 0.55, 0.22, SURF_METAL, 4, 0.6, { envMapIntensity: 0.85 },
    { amount: 0.40, color: 0xd6ecf8, rough: 0.12 }),
  /* 氷柱と氷輪。**半透明にしないと石膏の棒に見える。**
     depthWriteを切ってあるのは、重なった氷柱が互いの奥を消して
     板を挿したように見えるのを防ぐため（キャンディの星と同じ理由ではない） */
  icicle: new THREE.MeshStandardMaterial({
    color: 0xbfe4f5, metalness: 0.10, roughness: 0.08,
    transparent: true, opacity: 0.62, depthWrite: false,
    envMapIntensity: 1.10, side: THREE.DoubleSide,
  }),

  /* ---- サイバー（ピストルの形違い）。2026-08-11 ----
     **ピストルは塗り替えが届く面が12.6%しかない**（測った値。
     画面の6割が手と袖で、スキンはそこを触らない）。
     だから色で勝負しても届かない。**面積が小さくても目に入るのは光**なので、
     発光する線と窓で作る */
  cyberShell: mat(0x14171c, 0.85, 0.34, SURF_METAL, 6, 0.7, { envMapIntensity: 0.75 },
    { amount: 0.45, color: 0x4a5a68, rough: 0.22 }),
  // 放熱の羽。本体より明るくして枚数が読めるようにする
  heatFin: mat(0x2e353d, 1.0, 0.28, SURF_METAL, 8, 0.9, { envMapIntensity: 0.8 },
    { amount: 0.40, color: 0x7a8a9a, rough: 0.18 }),
  /* 回路の線と表示窓。**ドラゴンの目(ember)と同じ作りで色だけ違う。**
     toneMapped:false で色をそのままHDRへ振ると postfx の bloom(閾値0.95)を越えて
     滲む。青緑にしてあるのはドラゴンの赤と混ざらないため
     （暗い場所で2つ並ぶと、どちらも「光る銃」で終わってしまう） */
  circuit: new THREE.MeshBasicMaterial({
    color: new THREE.Color(0.25, 3.4, 3.0), toneMapped: false,
    transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
  }),

  /* ---- 2026-08-11に足した各武器2つ目のぶん ----
     **新しい材質は3つだけ。** 残りは既にある物を使い回している:
       骨・牙        … bone（ドラゴンの角と牙）
       赤い塗り文字  … shell（赤いショットシェル）
       布テープ      … strap（負い紐。同じ布）
       暗い当て板    … cyberShell（サイバーの筐体）
     材質を1つ増やすと描画呼び出しが1回増えるので、色が近い物は分けない */

  /* サメ（ショットガン）の腹の白。
     **背と腹を塗り分けるには、これを材質として持つしかない。**
     スキンの塗り替えは材質ごとにしか効かないので（部品ごとの模様は作れない）、
     「上が青灰・下が白」は塗りでは出せない。
     腹の板を飾りとして足して、そこだけ白い材質にする。
     歯と顎は bone（ドラゴンの牙）、鰭と鰓は anodized/enamel を使い回す
     ——あちらは塗りで青灰に染まるので、材質を増やさずに背の色が乗る */
  sharkBelly: mat(0xdcd8cc, 0.0, 0.58, SURF_POLYMER, 5, 0.8, null,
    { amount: 0.35, color: 0xf0ece0, metal: 0.0, rough: 0.50, dust: 0.10 }),

  /* ヴェノム（狙撃銃）。鱗。**黄緑は彩度を上げすぎると玩具になる**ので、
     緑を黄へ寄せたうえで暗く保つ。光るのは下のvenomGlowだけ */
  venomScale: mat(0x5a6a1e, 1.0, 0.44, SURF_METAL, 5, 1.1, { envMapIntensity: 0.55 },
    { amount: 0.9, color: 0x9ab040, rough: 0.26, dust: 0.10 }),
  /* 毒の滴と蛇の目。ドラゴンのemberと同じ作りで色だけ違う。
     **黄緑にしてあるのはサイバーの青緑と分けるため**
     （暗い場所で2つ並ぶと、どちらも「光る銃」で終わる） */
  venomGlow: new THREE.MeshBasicMaterial({
    color: new THREE.Color(1.6, 3.6, 0.35), toneMapped: false,
    transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false,
  }),

  /* ---- クローム（拳銃の4つ目）。2026-08-11 ----
     **明るさで読ませる商品。** 拳銃は塗り替えが届く面が12.6%しかないので、
     面積では勝負できない。サイバーは「光」で解いたが、
     ボーン（消した物）は光を使えないまま明暗差だけに頼って地味になった。

     ここは**品揃えで唯一の明るい拳銃**にする。
     アイス（狙撃銃）が「唯一の明るい銃」として効いたのと同じ理屈 */

  /* 鏡面の銀。**steelでは代わりが効かない**（0x5a6068で粗さ0.34は暗くて鏡にならない）。
     粗さを0.06まで落として環境の映り込みを強く拾わせる。
     擦れを焼かないのは、**磨いた鏡に擦れを入れると鏡に見えなくなる**ため
     （このゲームの他の金属は全部使い込んだ物なので、ここだけ逆） */
  chrome: mat(0xc8d0d8, 1.0, 0.06, SURF_METAL, 2, 0.18, { envMapIntensity: 1.35 }),
  /* 象牙の握把板。**boneでは代わりが効かない**（0xc9bfa6で粗さ0.66は鈍い）。
     一段明るく滑らかにして、磨いた銀の隣に置いても安物に見えない所まで持ってくる */
  ivory: mat(0xe4dcc8, 0.0, 0.34, SURF_POLYMER, 4, 0.35, { envMapIntensity: 0.5 },
    { amount: 0.25, color: 0xf4efe2, metal: 0.0, rough: 0.28 }),
};

// レンズのフレネル反射。実物の対物レンズは正面から覗くと素通しなのに、
// 斜めから見ると急に反射して、コーティングの色（緑〜紫）が角度で振れる。
// 標準材質のenvMapだけではこの角度依存が出ず、リングの上に幅の広い白いハイライトが
// 1本ベタっと乗るだけの「濡れたプラスチック」になる。視線と法線の角度から1項足す
MATS.glass.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
    // vViewPositionは面から視点へのベクトル。正面ほどdotが1に近い
    float _fr = 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) );
    _fr = pow( clamp( _fr, 0.0, 1.0 ), 1.6 );
    // 浅い角度ほど緑から紫へ寄る。実物のマルチコートの見え方
    vec3 _coat = mix( vec3( 0.10, 0.30, 0.20 ), vec3( 0.26, 0.13, 0.34 ), _fr );
    gl_FragColor.rgb += _coat * _fr * 1.5;
    gl_FragColor.a = clamp( gl_FragColor.a + _fr * 0.55, 0.0, 1.0 );`);
};

// 手袋の縁光。手は日陰にあるので、アルベドをいくら動かしても背景のコンクリートと
// 同じ明度帯に入ってしまう（実測: 手袋75対背景78）。上げれば今度は日向の砂嚢と同じ
// 白い塊に戻るので、分離はアルベドではなく輪郭で作る。
// 視線と法線が浅く交わる面＝シルエットの縁にだけ空の色を1段乗せると、
// 背景が何色でも手の形が抜ける。指の1本ずつの丸みにも縁が乗るので、
// 稜線が増えて塊が塊でなくなる
// 指数を下げると縁が太って手全体が白い塊になるので、シルエットの1〜2px手前で切る。
// 当て革（gloveHard）には掛けない。袖のベルクロ帯も同じ材質なので、
// 掛けると布の帯の縁が銀線のように光ってクロムの輪に見える
MATS.glove.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace(
    '#include <dithering_fragment>',
    `#include <dithering_fragment>
    float _rim = 1.0 - abs( dot( normalize( normal ), normalize( vViewPosition ) ) );
    _rim = pow( clamp( _rim, 0.0, 1.0 ), 3.4 );
    gl_FragColor.rgb += vec3( 0.30, 0.35, 0.44 ) * _rim * 0.50;`);
};
// 罠: シェーダのプログラムはmaterialの設定値から作った鍵で使い回されるので、
// onBeforeCompileを足しただけだと同じ設定の別材質（袖など）と同じプログラムを
// 引いてしまい、縁光が乗らない／余計な所に乗る。鍵を別にしておく
MATS.glove.customProgramCacheKey = () => 'rimGlove';

// 袖の皺の陰影。
// 【ここが要点】頂点色はアルベドに掛かる係数なので、トーンマップとsRGBを通ると
// 必ず圧縮される。以前は頂点色に0.50〜1.00（リニアで1.9倍）を焼いていたが、
// 画面に出るのは1.34倍で、実測の横断比1.19〜1.39倍とぴったり一致していた。
// つまりこの器を使う限り、何倍焼いても画面上1.4倍が天井になる。
// 手袋の縁光と同じく #include <dithering_fragment> の後——トーンマップとsRGBの
// 後ろ——で足せば圧縮を受けない。
// 皺の量は頂点色ではなくfoldという専用の属性で渡す。頂点色は接触影(bakeAO)と
// 掛け合わされてしまうので、それを増幅すると皺ではなく接触影の染みが浮き出る
// （実際にそうなって、袖の真ん中に大きな黒い滲みが出た）。
// 【足すのではなく掛ける】最初は縁光と同じように定数を足していたが、
// 谷の元の色が既に暗い（0.10前後）ので、そこから0.12引くと赤と緑が0で止まり、
// 空の色ぶんだけ残った青が縦に2本走った。掛け算なら色相が変わらず、
// 黒で止まることもない。表示空間で掛けるので圧縮も受けない
MATS.sleeveSkin = MATS.sleeve.clone();
MATS.sleeveSkin.onBeforeCompile = (sh) => {
  sh.vertexShader = 'attribute float fold;\nvarying float vFold;\n'
    + sh.vertexShader.replace('void main() {', 'void main() {\n\tvFold = fold;');
  sh.fragmentShader = 'varying float vFold;\n'
    + sh.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
    // 谷を山より深く取る。下側の階調が丸ごと余っているので、暗い方に振る余裕がある
    float _f = clamp( vFold, -1.0, 1.0 );
    gl_FragColor.rgb *= 1.0 + ( _f < 0.0 ? _f * 0.48 : _f * 0.32 );`);
};
MATS.sleeveSkin.customProgramCacheKey = () => 'sleeveFold';

// ドットの滲み。芯が細いと滲みが勝つので、外周は指数で落として芯だけ飽和させる
const GLOW_TEX = radialTexture(64, 1.7, 0);
// 映り込み専用。中心から外へアルファを落とし切って、板の四角い外形が出ないようにする
const SHEEN_TEX = radialTexture(64, 1.5, 0);

// ドットの滲み。芯の周りに柔らかい輪を足すと、点ではなく発光体に見える
MATS.dotGlow = new THREE.MeshBasicMaterial({
  map: GLOW_TEX, color: 0xff3a18, toneMapped: false,
  transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending,
  depthWrite: false,
  polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
});
// レンズに乗る環境の映り込み。薄い青の帯を斜めに入れる。
// 濃いと「ガラスの上に半透明の紙を斜めに貼った」ように見えるので、存在が分かる程度まで落とす。
// これはヒップで筒を横から見た時の演出であって、覗いている時に乗せる物ではない。
// 覗いている間は_animateでvisible:falseにする
MATS.sheen = new THREE.MeshBasicMaterial({
  map: SHEEN_TEX, color: 0x3f7fbf, toneMapped: false,
  transparent: true, opacity: 0.05, blending: THREE.AdditiveBlending,
  depthWrite: false,
});
// レンズのコーティング。実物は中心が抜けていて、外周ほど色が乗る。
// 細い輪1本だと「縁に色を塗った円板」にしかならないので、
// 中心が透明・外周が青緑〜紫の分布を1枚のテクスチャに焼いて全面に敷く。
// 覗いている間もこれ越しに外を見るので、濃度は存在が分かる限界まで薄くする
function coatingTexture(size = 64) {
  const d = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x - c) / c, (y - c) / c);
      // 外周へ向かって青緑→紫。角度ではなく半径で振ると、
      // 板でも「見る角度で色が変わるコーティング」の見え方を代用できる
      const k = clamp01(Math.pow(clamp01(r), 2.6));
      const i = (y * size + x) * 4;
      d[i] = (26 + 92 * k);
      d[i + 1] = (74 - 30 * k);
      d[i + 2] = (66 + 62 * k);
      d[i + 3] = r >= 1 ? 0 : k * 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
MATS.coating = new THREE.MeshBasicMaterial({
  map: coatingTexture(64), toneMapped: false,
  transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending,
  depthWrite: false,
});

// レンズの周縁の落ち込み。中心は素通しで、外周ほど暗く沈む板を1枚重ねて
// フレネル（斜めに見た面ほど反射して透過しない）の見え方を代用する。
// これが無いとレンズが「単色の円板」にしか見えない
function lensVignetteTexture(size = 64) {
  const d = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot((x - c) / c, (y - c) / c);
      const a = r >= 1 ? 0 : Math.pow(clamp01(r), 3.4);
      const i = (y * size + x) * 4;
      d[i] = 22; d[i + 1] = 26; d[i + 2] = 32; d[i + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(d, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}
MATS.lensEdge = new THREE.MeshBasicMaterial({
  map: lensVignetteTexture(64), toneMapped: false,
  transparent: true, depthWrite: false,
});

/* --------------------------------------------------- ジオメトリと部品 */

// 部品数を増やすので、同じ寸法のジオメトリは必ず使い回す
const _geo = new Map();
function cached(key, make) {
  let g = _geo.get(key);
  if (!g) { g = make(); _geo.set(key, g); }
  return g;
}
const boxG = (w, h, d) => cached(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d));
const cylG = (rt, rb, h, s = 12, open = false) =>
  cached(`c${rt},${rb},${h},${s},${open}`, () => new THREE.CylinderGeometry(rt, rb, h, s, 1, open));
const capG = (r, len) => cached(`p${r},${len}`, () => new THREE.CapsuleGeometry(r, Math.max(len, 0.0002), 3, 8));
const torG = (r, t, rs = 6, ts = 14, arc = Math.PI * 2) =>
  cached(`t${r},${t},${rs},${ts},${arc}`, () => new THREE.TorusGeometry(r, t, rs, ts, arc));
const sphG = (r, w = 10, h = 7) => cached(`s${r},${w},${h}`, () => new THREE.SphereGeometry(r, w, h));
const planeG = (w, h) => cached(`n${w},${h}`, () => new THREE.PlaneGeometry(w, h));
const circG = (r, s = 16) => cached(`o${r},${s}`, () => new THREE.CircleGeometry(r, s));
// 浅いドーム。開口半径rを球半径Rの一部として切り出す。
// レンズを平らな円板で作ると法線が全面同じになり、どの角度から見ても反射が一定＝
// 「輪の中に貼った灰色の紙」になる。実物どおりわずかに膨らませると、
// 縁だけ視線と法線の角度が開いてフレネルの色が出る
const domeG = (r, R, s = 32) => cached(`m${r},${R},${s}`,
  () => new THREE.SphereGeometry(R, s, 8, 0, Math.PI * 2, 0, Math.asin(r / R)));

// 面取り付きの箱。
// 90度の角のままだと稜線に光の線が乗らず、機関部・弾倉・銃床の3部品が
// 1枚の紺黒の板に潰れて境目が読めない。法線マップはノイズなのでシルエットは救えないので、
// 実物どおり0.5〜1mm相当の面取りを立てて、そこだけ光を返させる。
// mergeGeometriesは索引の有無が揃っていないと失敗するので、最後に索引を張る
function chamferBoxG(w, h, d, t) {
  return cached(`x${w},${h},${d},${t}`, () => {
    const a = w / 2, b = h / 2, c = d / 2;
    const e = Math.min(t, a * 0.45, b * 0.45, c * 0.45);
    const A = a - e, B = b - e, C = c - e;
    const half = [a, b, c];
    const pos = [], nor = [], uv = [];

    // 外向きの基準方向を渡して、法線が逆なら頂点順を入れ替える。
    // 面ごとに向きを手で数えるより間違いが起きない
    const poly = (pts, rx, ry, rz) => {
      const n = _v.set(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2])
        .cross(_v2.set(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1], pts[2][2] - pts[0][2]));
      if (n.x * rx + n.y * ry + n.z * rz < 0) { pts.reverse(); n.negate(); }
      n.normalize();
      // UVは基準方向の主軸を除いた2軸で張る。BoxGeometryと同じく面あたり0..1
      const ax = Math.abs(rx), ay = Math.abs(ry), az = Math.abs(rz);
      let i0 = 0, i1 = 1;
      if (ax >= ay && ax >= az) { i0 = 2; i1 = 1; }
      else if (ay >= az) { i0 = 0; i1 = 2; }
      const emit = (p) => {
        pos.push(p[0], p[1], p[2]);
        nor.push(n.x, n.y, n.z);
        uv.push(p[i0] / (2 * half[i0]) + 0.5, p[i1] / (2 * half[i1]) + 0.5);
      };
      for (let i = 2; i < pts.length; i++) { emit(pts[0]); emit(pts[i - 1]); emit(pts[i]); }
    };

    for (const s of [1, -1]) {
      poly([[s * a, -B, -C], [s * a, B, -C], [s * a, B, C], [s * a, -B, C]], s, 0, 0);
      poly([[-A, s * b, -C], [A, s * b, -C], [A, s * b, C], [-A, s * b, C]], 0, s, 0);
      poly([[-A, -B, s * c], [A, -B, s * c], [A, B, s * c], [-A, B, s * c]], 0, 0, s);
    }
    // 12本の稜線。ここに乗る細い光の線が形状を読ませる
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        poly([[sx * a, sy * B, -C], [sx * a, sy * B, C], [sx * A, sy * b, C], [sx * A, sy * b, -C]],
          sx, sy, 0);
      }
      for (const sz of [1, -1]) {
        poly([[sx * a, -B, sz * C], [sx * a, B, sz * C], [sx * A, B, sz * c], [sx * A, -B, sz * c]],
          sx, 0, sz);
      }
    }
    for (const sy of [1, -1]) {
      for (const sz of [1, -1]) {
        poly([[-A, sy * b, sz * C], [A, sy * b, sz * C], [A, sy * B, sz * c], [-A, sy * B, sz * c]],
          0, sy, sz);
      }
    }
    // 8隅の三角
    for (const sx of [1, -1]) {
      for (const sy of [1, -1]) {
        for (const sz of [1, -1]) {
          poly([[sx * a, sy * B, sz * C], [sx * A, sy * b, sz * C], [sx * A, sy * B, sz * c]],
            sx, sy, sz);
        }
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const idx = new Uint16Array(pos.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return g;
  });
}
// シルエットに効く大きな部品だけ差し替える。小物まで面取りすると頂点が無駄に増える。
// 0.0018mは実寸1.8mm相当で、ビューモデルの縮尺(0.5前後)を通すと画面上0.9mmしか残らず
// 稜線に光が乗らない。実銃の面取りに近い2.6mmまで広げてハイライトを1本立てる
const CHAMFER = 0.0026;
const cboxG = (w, h, d) => chamferBoxG(w, h, d, CHAMFER);
// 弾倉のようにシルエット最大の塊は、これより太い面取りでないと輪郭が黒く潰れる
const MAG_CHAMFER = 0.0045;

function part(geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.rotation.set(rx, ry, rz);
  m.castShadow = false;
  m.receiveShadow = false;
  return m;
}

// 楕円体を作る用。球を潰すと手の甲や掌の丸みが安く出せる
function partS(geo, mat, x, y, z, sx, sy, sz, rx = 0, ry = 0, rz = 0) {
  const m = part(geo, mat, x, y, z, rx, ry, rz);
  m.scale.set(sx, sy, sz);
  return m;
}

// 2点間にカプセルを渡す。指の節をこれで並べると1本ずつ作らなくても握りの形が出る
function capBetween(mat, p0, p1, r) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 0.0002;
  const m = new THREE.Mesh(capG(rnd4(r), rnd4(len)), mat);
  m.position.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
  m.quaternion.setFromUnitVectors(_up, _v.set(dx / len, dy / len, dz / len));
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

// 2点間に先細りの筒を渡す。前腕の袖に使う
function tubeBetween(mat, p0, p1, r0, r1, s = 10) {
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 0.0002;
  const m = new THREE.Mesh(cylG(rnd4(r1), rnd4(r0), rnd4(len), s), mat);
  m.position.set((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (p0[2] + p1[2]) / 2);
  m.quaternion.setFromUnitVectors(_up, _v.set(dx / len, dy / len, dz / len));
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

// 袖の皮を1枚で張る。
// 先細りの筒(tubeBetween)を継いで作ると、継ぎ目が消えて滑らかな円錐になり、
// どう塗っても「塗装した配管」か「ゴムホース」にしか見えない。布に見せるには
//   ・断面を真円にしない（真円は硬い筒の証拠）
//   ・周方向に半径を揺らして縦皺を立てる
//   ・皺の位相を軸方向へ流して、筋が真っ直ぐ通らないようにする
// の3つが要る。輪の間隔で径を変えるやり方（＝節）だと蛇腹になるので、
// 半径は関数rAt(k)から連続で取る。
// atとtanAtは腕の芯線とその接線。曲がった芯にも巻けるようにしてある
function sleeveTube(mat, at, tanAt, k0, k1, rAt, o) {
  o = o || {};
  // 輪の間隔は「一番細かい揺らぎの半分」より狭くないと、その揺らぎが標本化で消える。
  // 袖口の下のギャザー（周期6cm前後）を出すので、20輪＝2.5cm間隔では足りない
  const RN = o.rings || 44;                       // 軸方向の輪の数
  const SN = o.seg || 28;                         // 周方向の分割
  const flat = o.flat != null ? o.flat : 0.88;    // 断面の扁平率。前腕は円柱ではない
  // 縦皺の深さ（半径比）。袖は画面上でも幅80pxしかないので、
  // 実寸2mm程度の皺は2pxの陰にしかならず、遠目には結局ただの円錐に見える。
  // 実物の袖のたるみと同じ5mm前後まで深くする
  const fold = o.fold != null ? o.fold : 0.105;
  const pos = [], uvs = [], idx = [], shade = [], fld = [];
  // 輪の向きは前の輪から送る（平行移動枠）。固定の基準軸から毎回作ると、
  // 曲がった芯線が基準と平行に近づいた所で輪が急にねじれて、皺が渦を巻く
  let ux = 0, uy = 0, uz = 0;
  let px = 0, py = 0, pz = 0, arc = 0;
  for (let i = 0; i <= RN; i++) {
    const k = k0 + (k1 - k0) * (i / RN);
    const c = at(k), t = tanAt(k);
    const tl = Math.hypot(t[0], t[1], t[2]) || 1;
    const tx = t[0] / tl, ty = t[1] / tl, tz = t[2] / tl;
    if (i === 0) {
      // 最初の1本だけ、接線と平行でない軸から作る
      if (Math.abs(ty) < 0.9) { ux = 0; uy = 1; uz = 0; } else { ux = 1; uy = 0; uz = 0; }
    } else {
      arc += Math.hypot(c[0] - px, c[1] - py, c[2] - pz);
    }
    px = c[0]; py = c[1]; pz = c[2];
    // 接線成分を抜くだけで前の輪の向きが引き継がれる
    const d = ux * tx + uy * ty + uz * tz;
    ux -= tx * d; uy -= ty * d; uz -= tz * d;
    const ul = Math.hypot(ux, uy, uz) || 1;
    ux /= ul; uy /= ul; uz /= ul;
    const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
    const r0 = rAt(k);
    // 皺の位相を腕の長さで送ると皺がゆっくりねじれ、袖が腕に巻き付いて見える。
    // ただし一様回転(arc*8)だけだと、輪郭に当たる角度が輪ごとに滑らかに変わるので
    // シルエットは山の包絡線をなぞって放物線から1pxも外れない（実測rms0.9〜1.3px）。
    // 位相を不規則に振って、輪郭の位置に山が来る輪と谷が来る輪を作る。
    // 【振りすぎ厳禁】位相の変化率がそのまま面の軸方向の傾きになる。
    // 一様回転(8)だけだと傾き0.05でどこも真っ平ら＝配管に見えるが、
    // 一度23と53で1.5/0.8まで振ったら傾きが0.53（28度）になり、
    // 面が空を拾って青い筋が走り、法線がばらけて「濡れた金属箔」になった。
    // 傾きが0.15を超えない範囲（変化率20前後まで）に収める
    const ph = arc * 8 + Math.sin(arc * 13 + 0.7) * 0.55 + Math.sin(arc * 29 + 2.1) * 0.22;
    // 袖口の折り返し(外径0.0416)と袖の皮(同じ所で0.0412)の隙間は0.4mmしかない。
    // ここで径を揺らすと皺の山が折り返しを突き抜けて、縁に沿って黒い溝が1本開く。
    // ただし振幅を殺す区間を5cmも引きずると、実物なら一番布が寄る折り返しの直下が
    // 完全な真円になる。折り返しの口(arc=0.040)を出た直後に立ち上げる
    const out = ease(clamp01((arc - 0.040) / 0.014));
    const amp = fold * out;
    // 折り返しの直下のギャザー。締めた口の下では布が寄って膨らむ。
    // 山側だけ(0..1)に出すので、設計半径より細くなる所は作らない
    // ＝SLの単調増加が画面上のくびれに化けない
    const gd = (arc - 0.075) / 0.060;
    const gth = fold * 0.80 * out * Math.exp(-gd * gd);
    // 芯線の蛇行。皺を半径の変調(r0*(1+w))だけで作ると、周期が腕の長さ級に長いので
    // 輪郭が2次曲線から1pxも外れず「数学的に滑らかな円錐」に読める。
    // 芯そのものを数cm周期で振ると、左右の輪郭が同じ向きに揺れて幅は保ったまま
    // 輪郭だけが割れる。折り返しの中では振れないよう、こちらは緩やかに立ち上げる。
    // 振幅3.8mm＝画面上2.7pxでは輪郭を割るのに足りなかったので、
    // 6.0mm（画面上4px前後）まで上げて、周期の方は緩めて折れが尖らないようにする。
    // 【この項は幅を変えない】左右の輪郭が同じ向きに動くだけなので、
    // 半径の単調増加（＝くびれを作らない）は壊さない
    const mn = 0.0060 * ease(clamp01((arc - 0.042) / 0.050));
    const mu = (Math.sin(arc * 27 + 1.1) + Math.sin(arc * 61 + 0.4) * 0.45) * mn;
    const mv = (Math.sin(arc * 39 + 2.3) + Math.sin(arc * 19) * 0.60) * mn;
    for (let j = 0; j <= SN; j++) {
      const a = (j / SN) * Math.PI * 2;
      // 皺の本数。主の山を4本にしていたが、1周に4山あると輪郭の接線方向から
      // ±45度以内に必ず山が来るので、シルエットは常に山の包絡線をなぞって滑らかになる。
      // 3本にすると輪郭の両側(a と a+π)で cos の符号が逆になり、
      // 片側が張り出す時にもう片側が引っ込む＝幅は保ったまま芯が振れて見える。
      // 振幅の合計は前と同じなので、袖の太さ(半径の±15%)は変えていない
      // 3本だけだと画面には太い帯が2本しか出ず、腕が三角柱に見える。
      // 細かい方(7本)を厚くして、太い山の上に細かい目を乗せる。
      // 合計の振幅は前と同じ1.68倍のままなので袖の太さは変わらない
      const wf = Math.cos(a * 3 + ph) * amp
        + Math.cos(a * 7 - ph * 0.6) * amp * 0.50
        // 斜めに1本。肘へ向かって布が寄る（たるみ）を作る
        + Math.cos(a * 5 - arc * 22 + ph * 0.35) * amp * 0.18;
      // ギャザーは山側だけの膨らみなので、皺の陰影には混ぜない
      // （混ぜると折り返しの下だけ一様に明るくなって帯に見える）
      const w = wf + (Math.cos(arc * 96 + a * 1.6) * 0.5 + 0.5) * gth;
      const r = r0 * (1 + w);
      const ca = Math.cos(a) * r + mu, sa = Math.sin(a) * r * flat + mv;
      pos.push(c[0] + ux * ca + vx * sa, c[1] + uy * ca + vy * sa, c[2] + uz * ca + vz * sa);
      // 皺の谷と山を頂点色に焼く。
      // ビューモデルのカメラ側の面は太陽の裏側なので、当たっているのは半球光と
      // 弱い当て光だけ＝どの向きを向いても同じ明るさが返る。つまり形だけ皺を作っても
      // 陰影が1段も出ず、結局のっぺりした円錐に見える（実測: 袖を横切って輝度67が一定）。
      // 【上限は必ず1.0】ここは正規化Uint8のcolorに入る掛け算の係数で、1.0が素のアルベド。
      // 以前は上限1.05で焼いていて、山の1.05*255=267がUint8で11に折り返り、
      // 山が真っ黒な縦縞に反転していた（袖の頂点の21.6%が0〜15に落ちていた）。
      // 係数を1.6から0.60へ落としてあるのは、画面に出す陰影をここで作るのをやめたから。
      // ここはトーンマップの前なので、いくら振っても画面では1.4倍に潰れるうえ、
      // 1.6倍だと頂点の6%が上限1.0に当たって山の頭が平らに削られていた。
      // 実際の濃淡はMATS.sleeveSkinのフラグメント側（トーンマップの後）で付ける
      shade.push(clamp(0.80 + w * 0.60, 0.55, 1.0));
      // 皺の量そのもの。-1..+1へ正規化してフラグメントへ渡す。
      // 折り返しの中(out=0)では0になるので、隠れている区間には陰影が付かない
      fld.push(wf / (fold * 1.68));
      // 織り目の目の大きさを袖の長さに依らず一定にする。
      // uvを0..1で張ると、長い袖ほど目が伸びて手袋と質感が揃わない
      uvs.push((j / SN) * (r0 * 6.283 / 0.09), arc / 0.09);
    }
  }
  for (let i = 0; i < RN; i++) {
    for (let j = 0; j < SN; j++) {
      const a = i * (SN + 1) + j, b = a + SN + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  // 両端に蓋。肘側は画面外へ抜けるので普段は見えないが、
  // 装填で腕が振られた時に開いた口から中が抜けて背景が見えるのを塞いでおく
  for (const e of [0, 1]) {
    const row = e ? RN * (SN + 1) : 0;
    const c = at(e ? k1 : k0);
    const ci = pos.length / 3;
    pos.push(c[0], c[1], c[2]);
    uvs.push(0.5, e ? k1 / 0.09 : k0 / 0.09);
    shade.push(0.80);
    fld.push(0);
    for (let j = 0; j < SN; j++) {
      if (e) idx.push(ci, row + j, row + j + 1);
      else idx.push(ci, row + j + 1, row + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  // 接触影の焼き込みと同じ器（正規化Uint8のcolor）に入れる。
  // 型が違うと材質ごとの結合(mergeGeometries)が失敗して、焼き込み自体が捨てられる
  // Uint8Arrayへの代入は256で折り返す。0..1で持っている係数を、
  // 丸めと上限を通してから入れる（素で入れると255超が小さい値に化ける）
  const cb = new Uint8Array(shade.length * 3);
  for (let i = 0; i < shade.length; i++) {
    const v = Math.min(255, Math.max(0, Math.round(shade[i] * 255)));
    cb[i * 3] = cb[i * 3 + 1] = cb[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.BufferAttribute(cb, 3, true));
  // 皺の量。頂点色と別に持たせるのは、頂点色が接触影と掛け合わされるため。
  // この属性を読む材質(MATS.sleeveSkin)は袖の皮だけが使うので、
  // 材質ごとの結合で属性の顔ぶれが食い違うことはない
  g.setAttribute('fold', new THREE.Float32BufferAttribute(fld, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // 継ぎ目の2列は同じ位置に頂点が重なっているのに法線が別々に出る。
  // 均さないと袖に縦の筋が1本入って、そこだけ折り目のように光る
  const nr = g.attributes.normal.array;
  for (let i = 0; i <= RN; i++) {
    const a = i * (SN + 1) * 3, b = (i * (SN + 1) + SN) * 3;
    for (let c = 0; c < 3; c++) {
      const m = (nr[a + c] + nr[b + c]) * 0.5;
      nr[a + c] = m; nr[b + c] = m;
    }
  }
  const m = new THREE.Mesh(g, mat);
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

// 指定方向を軸にした輪。袖口のバンドなど
function ringAt(mat, p, dir, r, t) {
  const m = new THREE.Mesh(torG(rnd4(r), rnd4(t), 6, 14), mat);
  m.position.set(p[0], p[1], p[2]);
  m.quaternion.setFromUnitVectors(_fwd, _v.set(dir[0], dir[1], dir[2]).normalize());
  m.castShadow = false; m.receiveShadow = false;
  return m;
}

/* ------------------------------------------------------- 共通ディテール */

// ピカティニーレール。刻みを歯として実際に立てると「箱」が「機械」に見える
// ピカティニーレール。刻みを歯として実際に立てると「箱」が「機械」に見える。
// 歯のピッチが粗いと、目から14cmしか離れていないADSでレゴのブロックに見えるので細かく刻む。
// 歯の上面も面取り箱にして、階段状の輪郭が高コントラストの直線にならないようにする
function addRail(g, y, z0, z1, w = 0.024, m = MATS.anodized) {
  const len = z1 - z0, mid = (z0 + z1) / 2;
  g.add(part(cboxG(w, 0.005, len), m, 0, y, mid));
  const pitch = 0.0082;
  const n = Math.max(2, Math.floor(len / pitch));
  const start = mid - (n * pitch) / 2 + pitch / 2;
  for (let i = 0; i < n; i++) {
    const zz = start + i * pitch;
    g.add(part(chamferBoxG(w * 0.94, 0.005, 0.0050, 0.0009), m, 0, y + 0.005, zz));
    // 上面を細くして台形にすると実物の断面に近づく
    g.add(part(chamferBoxG(w * 0.62, 0.003, 0.0050, 0.0008), m, 0, y + 0.0089, zz));
  }
}

// ネジ。1本1本は見えなくても、あると組み立てられた物に見える
function addScrewX(g, x, y, z, r = 0.0036) {
  g.add(part(cylG(r, r, 0.0022, 8), MATS.steel, x, y, z, 0, 0, Math.PI / 2));
  g.add(part(boxG(0.0026, r * 1.7, r * 0.45), MATS.enamel, x + (x > 0 ? 0.0006 : -0.0006), y, z));
}

// 通気孔。黒い丸を貼るだけだと板に見えるので、面取りのリングで厚みを出す。
// さらに内壁の筒を通して底板を沈める。表面と同じ高さに黒い円板を置くだけだと
// 穴の深さがゼロになり、貼り付けたシールにしか見えない
function addVentX(g, x, y, z, r = 0.006) {
  const sx = x > 0 ? 1 : -1;
  const ir = rnd4(r * 0.78);
  g.add(part(torG(rnd4(r), rnd4(r * 0.30), 6, 12), MATS.phosphate, x, y, z, 0, Math.PI / 2, 0));
  g.add(part(cylG(ir, ir, 0.007, 12, true), MATS.opticTube, x - sx * 0.0035, y, z, 0, 0, Math.PI / 2));
  g.add(part(cylG(ir, ir, 0.0015, 12), MATS.enamel, x - sx * 0.0068, y, z, 0, 0, Math.PI / 2));
}

// 刻印風の凹み。細い溝を数本並べるだけで「何か彫ってある」ように見える
function addStampX(g, x, y, z, w, h, rows = 3) {
  for (let i = 0; i < rows; i++) {
    const yy = y + (i - (rows - 1) / 2) * (h / rows);
    g.add(part(boxG(0.0012, (h / rows) * 0.40, w), MATS.enamel, x, yy, z));
  }
}

// スリングを通す環
function addSlingLoop(g, x, y, z, r = 0.0085) {
  g.add(part(torG(rnd4(r), 0.0022, 6, 12), MATS.steel, x, y, z, 0, Math.PI / 2, 0));
  g.add(part(boxG(0.006, 0.010, 0.010), MATS.phosphate, x, y + r * 0.9, z));
}

/* --------------------------------------------------------- 接触影(AO) */

// ビューモデルにはGTAOも影も掛からない。何もしないと手と握把の接触部、
// マグウェルの奥、光学の下、銃床の継ぎ目が全部同じ明るさになり、
// 部品同士が「触れている」情報がゼロになる（＝紺黒の一様な塊に潰れる）。
// レイを1本ずつ飛ばすのは高いので、部品を粗い格子へ焼いてから
// 頂点のまわりだけを数える。これなら焼き込みは一瞬で済む。
const AO_CELL = 0.004;
const AO_STEP = [0.006, 0.014, 0.024, 0.038];
const AO_W = [1.0, 0.72, 0.46, 0.26];
const _aoN = new THREE.Vector3();
const _aoT = new THREE.Vector3();
const _aoB = new THREE.Vector3();
const _aoD = new THREE.Vector3();

function bakeAO(list) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (const g of list) {
    const p = g.attributes.position.array;
    for (let i = 0; i < p.length; i += 3) {
      if (p[i] < x0) x0 = p[i]; if (p[i] > x1) x1 = p[i];
      if (p[i + 1] < y0) y0 = p[i + 1]; if (p[i + 1] > y1) y1 = p[i + 1];
      if (p[i + 2] < z0) z0 = p[i + 2]; if (p[i + 2] > z1) z1 = p[i + 2];
    }
  }
  if (!(x1 > x0 || y1 > y0 || z1 > z0)) return false;
  const pad = AO_CELL * 3;
  x0 -= pad; y0 -= pad; z0 -= pad;
  const nx = Math.ceil((x1 + pad - x0) / AO_CELL) + 1;
  const ny = Math.ceil((y1 + pad - y0) / AO_CELL) + 1;
  const nz = Math.ceil((z1 + pad - z0) / AO_CELL) + 1;
  // 極端に大きい塊は格子が膨らむので諦める。見た目が元に戻るだけで壊れはしない
  if (nx * ny * nz > 4e6) return false;
  const grid = new Uint8Array(nx * ny * nz);

  // 三角形の面上を刻んで塗る。境界箱で塗ると、斜めに伸びた長い面（袖の筒など）が
  // 空っぽの箱ごと埋めてしまい、周り全部が遮蔽扱いになって銃も手も一様に暗くなる
  const step = AO_CELL * 0.5;
  const put = (px, py, pz) => {
    const i = ((px - x0) / AO_CELL) | 0;
    const j = ((py - y0) / AO_CELL) | 0;
    const k = ((pz - z0) / AO_CELL) | 0;
    if (i >= 0 && i < nx && j >= 0 && j < ny && k >= 0 && k < nz) grid[(i * ny + j) * nz + k] = 1;
  };
  for (const g of list) {
    const p = g.attributes.position.array;
    const ix = g.index ? g.index.array : null;
    const n = ix ? ix.length : p.length / 3;
    for (let f = 0; f + 2 < n; f += 3) {
      const va = (ix ? ix[f] : f) * 3;
      const vb = (ix ? ix[f + 1] : f + 1) * 3;
      const vc = (ix ? ix[f + 2] : f + 2) * 3;
      const ux1 = p[vb] - p[va], uy1 = p[vb + 1] - p[va + 1], uz1 = p[vb + 2] - p[va + 2];
      const ux2 = p[vc] - p[va], uy2 = p[vc + 1] - p[va + 1], uz2 = p[vc + 2] - p[va + 2];
      const n1 = Math.min(400, Math.max(1, Math.ceil(Math.hypot(ux1, uy1, uz1) / step)));
      const n2 = Math.min(400, Math.max(1, Math.ceil(Math.hypot(ux2, uy2, uz2) / step)));
      for (let s = 0; s <= n1; s++) {
        const fs = s / n1;
        const lim = Math.max(1, Math.round(n2 * (1 - fs)));
        for (let t = 0; t <= lim; t++) {
          const ft = (t / lim) * (1 - fs);
          put(p[va] + ux1 * fs + ux2 * ft,
            p[va + 1] + uy1 * fs + uy2 * ft,
            p[va + 2] + uz1 * fs + uz2 * ft);
        }
      }
    }
  }

  const hit = (px, py, pz) => {
    const i = ((px - x0) / AO_CELL) | 0;
    if (i < 0 || i >= nx) return 0;
    const j = ((py - y0) / AO_CELL) | 0;
    if (j < 0 || j >= ny) return 0;
    const k = ((pz - z0) / AO_CELL) | 0;
    if (k < 0 || k >= nz) return 0;
    return grid[(i * ny + j) * nz + k];
  };

  const CT = Math.cos(0.96), ST = Math.sin(0.96);   // 約55度に開いた傘
  for (const g of list) {
    const p = g.attributes.position.array;
    const na = g.attributes.normal.array;
    const cnt = p.length / 3;
    // 部品側が先に焼いてある陰影があれば掛け合わせる。上書きすると、
    // 格子(4mm)より広くて浅い凹凸——袖の皺のような物——の陰が全部消える
    const pre = g.getAttribute('color');
    const pa = pre ? pre.array : null;
    const col = new Uint8Array(cnt * 3);
    for (let i = 0; i < cnt; i++) {
      const o = i * 3;
      _aoN.set(na[o], na[o + 1], na[o + 2]);
      if (_aoN.lengthSq() < 1e-8) _aoN.set(0, 1, 0); else _aoN.normalize();
      // 接線の基準。法線と平行にならない軸を選ぶ
      _aoT.set(Math.abs(_aoN.y) > 0.9 ? 1 : 0, Math.abs(_aoN.y) > 0.9 ? 0 : 1, 0)
        .cross(_aoN).normalize();
      _aoB.copy(_aoN).cross(_aoT);
      // 自分の面のセルを拾わないよう、法線方向へ持ち上げてから飛ばす
      const sx = p[o] + _aoN.x * 0.007;
      const sy = p[o + 1] + _aoN.y * 0.007;
      const sz = p[o + 2] + _aoN.z * 0.007;
      let occ = 0;
      for (let d = 0; d < 5; d++) {
        if (d === 0) _aoD.copy(_aoN);
        else {
          const t = (d - 1) * Math.PI * 0.5;
          _aoD.copy(_aoN).multiplyScalar(CT)
            .addScaledVector(_aoT, ST * Math.cos(t))
            .addScaledVector(_aoB, ST * Math.sin(t));
        }
        for (let s = 0; s < AO_STEP.length; s++) {
          const t = AO_STEP[s];
          if (hit(sx + _aoD.x * t, sy + _aoD.y * t, sz + _aoD.z * t)) { occ += AO_W[s]; break; }
        }
      }
      // 真っ黒まで落とすと部品が消えるので下限を作る。
      // ただし0.55は浅すぎて、指と先台の接触部が周囲と同じ輝度のままだった
      // （＝握力も接地も感じられない）。手袋のアルベドを落としたぶん余裕ができたので、
      // 接触が読めるところまで下限を下げる
      const ao = clamp(1 - (occ / 5) * 0.95, 0.42, 1) * (pa ? pa[o] / 255 : 1);
      col[o] = col[o + 1] = col[o + 2] = ao * 255;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
  }
  return true;
}

// 頂点カラーを読む材質は別インスタンスが要る。元の材質1つにつき1個だけ作って使い回す
const _aoMat = new Map();

// 部品を増やすと描画呼び出しが膨らむので、動かない部品は材質ごとに1つへ結合する。
// 動く部品（ボルト・弾倉・手・引金）は別のGroupに入れてあるので対象外になる
function bakeStatic(group) {
  const byMat = new Map();
  const keep = [];
  const solid = [];
  for (const c of group.children) {
    // 描画順を指定してある板（ドット・滲み・映り込み）は結合すると順序が消えるので触らない
    if (c.isMesh && c.userData.keep !== true) {
      let list = byMat.get(c.material);
      if (!list) { list = []; byMat.set(c.material, list); }
      c.updateMatrix();
      const g = c.geometry.clone().applyMatrix4(c.matrix);
      list.push(g);
      // 半透明（レンズ・コーティング）に接触影を焼くとガラスが濁るので外す
      if (!c.material.transparent && g.attributes.normal) solid.push(g);
    } else {
      keep.push(c);
    }
  }
  if (byMat.size === 0) return group;
  const shaded = solid.length > 0 ? bakeAO(solid) : false;
  const merged = [];
  for (const [m, list] of byMat) {
    const geo = mergeGeometries(list, false);
    // 結合に失敗したら元のまま使う。見た目は変わらないので黙って諦めてよい
    if (!geo) return group;
    let mm = m;
    if (shaded && geo.getAttribute('color')) {
      mm = _aoMat.get(m);
      // cloneはonBeforeCompileとプログラムの鍵を写さない。
      // 手袋の縁光はここを通った複製の方が実際に描かれるので、明示的に引き継ぐ
      if (!mm) {
        mm = m.clone();
        mm.vertexColors = true;
        mm.onBeforeCompile = m.onBeforeCompile;
        mm.customProgramCacheKey = m.customProgramCacheKey;
        /* **元が誰かを覚えさせる。** 面に実際に貼られるのはこの複製の方なので、
           スキン（色違い）を被せる時に「これは元々どの材質か」を辿れないと、
           何も差し替わらない（実際そうなって0面しか変わらなかった） */
        mm.userData.skinBase = m;
        _aoMat.set(m, mm);
      }
    }
    const mesh = new THREE.Mesh(geo, mm);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    merged.push(mesh);
  }
  group.clear();
  for (const c of keep) group.add(c);
  for (const m of merged) group.add(m);
  return group;
}

/* ------------------------------------------------------------ 手 */

// 手袋をした手。指を1本ずつ精密に作るのではなく「握りの円弧に沿って節を並べる」方式にする。
// 銃モデルの子として置けば銃の動きにそのまま追従するので、手の姿勢制御が要らない。
// s=+1が右手、-1が左手。X座標にsを掛けるだけで鏡像になる
function buildHand(s, o) {
  o = o || {};
  const h = new THREE.Group();
  // 手であることの印。**検査が「武器そのもの」と「手と腕」を分けて測るために要る。**
  // 分けないと、頂点数の多い手が割合を支配してしまう。
  // 実際ナイフは刃が152頂点に対して手と腕が2639頂点あり、
  // 「頂点の何割が枠外か」は刃が見切れているかを何も表していなかった
  h.userData.isHand = true;
  const R = o.gripR != null ? o.gripR : 0.022;   // 握る対象の半径
  const fr = 0.0094;                              // 指の基準の太さ
  const rr = R + fr * 0.85;                       // 指の芯が通る半径
  // 指先を対象の裏側まで回り込ませる量。ここが足りないと輪が閉じず、
  // 手が対象の手前に浮いているようにしか見えない（左右の隙間から背景が見える）
  const wrap = o.wrap != null ? o.wrap : 0;
  // 末節の回り込み角の補正。太い先台を掴む手はここを詰めないと、
  // 指先が対象の側面を通り越して天面へ回り込み、上に載っている物（レール）を貫通する
  const tip = o.tip != null ? o.tip : 0;
  // 握り軸まわりに手ごと回す量。正で甲が対象の天面側へ回る（左右どちらの手でも同じ向き）。
  // 先台を真横から握らせると指が全部裏側へ回って、画面には甲の塊しか出ない。
  // 甲を斜め上へ起こすと、指の付け根から第2関節までがこちら側の面に並んで
  // 「4本の指で握っている」情報が出る。CoD系のビューモデルはこの角度で見せている
  const roll = o.roll || 0;
  // 指1本ごとに握り角をずらす量（人差し指から小指へ等差）。
  // 支え手の視線は指の並びとほぼ平行(24度)で、4本ぶんの並びが画面上19pxにしかならない。
  // 手ごと傾ければ並びは寝るが、手首まで一緒に振れて前腕が銃を横切ってしまう。
  // 指だけを握り軸まわりにずらすと、付け根の線が斜めの階段になって
  // 「4本ある」情報が出る。回り込みの角度が変わるだけなので接地は崩れない
  const skew = o.skew || 0;
  // 甲・掌・手首はPを通らないので、同じ量だけ回す関数を別に用意する。
  // ここを回し忘れると指だけ動いて甲が元の面に残り、手がねじ切れて見える
  const around = (x, y, z, r) => [
    (Math.cos(r) * x - Math.sin(r) * z) * s, y, Math.cos(r) * z + Math.sin(r) * x];
  // a=0で手の甲側(+X*s)、a=PI/2で前方(-Z)。手はs側から回り込んで握る
  const P = (a, y, k) => {
    const A = a - roll;
    return [Math.cos(A) * rr * (k || 1) * s, y, -Math.sin(A) * rr * (k || 1)];
  };
  // 指の節の皺。カプセル1本を暗い細い輪で区切るだけで、
  // 「無地の白いプラスチックの棒」から「関節のある指」に変わる
  const crease = (p0, p1, r) => {
    const m = new THREE.Mesh(torG(rnd4(r), 0.0022, 4, 10), MATS.palm);
    m.position.set(p1[0], p1[1], p1[2]);
    m.quaternion.setFromUnitVectors(_fwd,
      _v.set(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]).normalize());
    m.castShadow = false; m.receiveShadow = false;
    return m;
  };
  // 握り軸（ローカルY）まわりの円弧。指と指の谷を埋める継ぎ目に使う。
  // torGはXY平面の輪なのでX軸まわりに倒す。倒した後の輪の角uと握り角aの対応は
  // 右手がu=a-roll、左手が鏡像なのでu=PI-a+roll。オイラー順YXZで
  // 「倒してから握り軸まわりに回す」を1回で書く
  const arcRing = (mat, a0, a1, y, r, t) => {
    const m = new THREE.Mesh(torG(rnd4(r), rnd4(t), 4, 14, rnd4(a1 - a0)), mat);
    m.position.set(0, y, 0);
    m.rotation.set(-Math.PI / 2, s > 0 ? a0 - roll : Math.PI - a1 + roll, 0, 'YXZ');
    m.castShadow = false; m.receiveShadow = false;
    return m;
  };

  // 人差し指・中指・薬指・小指。下にいくほど細く、回り込みも浅くする。
  // 【不変条件】隣の指の間隔は、両方の指の半径の和より必ず大きくする。
  // 以前は間隔0.019に対し半径の和が0.0199〜0.0173で、上2組は重なって
  // 面がつながっていた（＝谷が幾何として存在しない＝完全なミトン）。
  // 実測でも走査線ごとの断片が全行1本、指の谷は0本だった。
  // 4本で83mmは実寸の手の幅どおりで、間隔0.0215に対し和は0.0182以下に収まる
  const FING = [
    { y: 0.0210, r: 0.0090, a: [-0.14, 0.98, 1.94] },
    { y: -0.0005, r: 0.0092, a: [-0.16, 1.04, 2.06] },
    { y: -0.0220, r: 0.0086, a: [-0.16, 1.00, 2.00] },
    { y: -0.0435, r: 0.0076, a: [-0.18, 0.92, 1.86] },
  ];

  // 人差し指ほど浅く、小指ほど深く回り込ませる。逆向き（人差し指を深く）にすると、
  // 小指の当て革が天面のレールの歯へ乗り上げる（小指は手の中で一番肘寄り＝
  // 一番レールに近い位置にいるので、この向きしか取れない）
  const skewOf = (i) => (i - 1.5) * skew;
  for (let i = 0; i < FING.length; i++) {
    if (i === 0 && o.trigger) continue;   // 人差し指は引金用に別で作る
    const f = FING[i];
    const sk = skewOf(i);
    // 【不変条件】節の芯は「握り面＋その節の半径」より内へ入れない。
    // 握り軸(手の原点)は銃身芯より6mm下にあるので、天面側では握り面までの距離が
    // 内接半径28.6mmではなく34.6mmになる。ここを見落として全部k=1.0で置いていたので、
    // 付け根が先台の面より7.3mm内側に埋まり、指の腹が半分飲まれていた
    const p0 = P(f.a[0] + sk, f.y, 1.05);
    // 基節の中間。付け根から第2関節まで(60度以上)を1本の直線で結ぶと、
    // 弦が握りの円より内側へ落ちて指の腹が対象の面に埋まり、
    // 画面には両端しか出ない＝4本が1枚の板に溶ける。中間を外へ張らせて弧にする
    const pm = P((f.a[0] + f.a[1]) * 0.5 + sk, f.y - 0.001, 1.09);
    const p1 = P(f.a[1] + sk, f.y - 0.002, 1.02);
    // 第2関節から末節の付け根までも60度近くある。ここを直線1本で結ぶと
    // 基節と同じ理由で弦が沈み、末節の付け根が先台に9mm埋まる。同じく中間を張る
    const pn = P((f.a[1] + f.a[2] + tip + wrap * 0.55) * 0.5 + sk, f.y - 0.003, 1.08);
    // 末節を2本に割って、対象の裏側へ回り込む弧を作る。
    // 先端の1節だけ半径を絞り、握り半径よりわずかに内へ入れて肉が潰れた接地にする
    const p2 = P(f.a[2] + sk + tip + wrap * 0.55, f.y - 0.004, 0.97);
    const p3 = P(f.a[2] + sk + tip + wrap, f.y - 0.006, 0.94);
    h.add(capBetween(MATS.glove, p0, pm, f.r));
    h.add(capBetween(MATS.glove, pm, p1, f.r * 0.96));
    h.add(capBetween(MATS.glove, p1, pn, f.r * 0.93));
    h.add(capBetween(MATS.glove, pn, p2, f.r * 0.90));
    h.add(capBetween(MATS.glove, p2, p3, f.r * 0.80));
    // 関節の皺。隣の指との境目は画面上1px以下に潰れて読めないが、
    // 指を横切るこの輪は指の並びと直角なので潰れない。
    // 「付け根の膨らみ→皺→節→皺→節」の縞が出れば、1本ずつ見えなくても指として読める
    h.add(crease(p0, pm, f.r * 0.99));
    h.add(crease(pm, p1, f.r * 0.97));
    h.add(crease(pn, p2, f.r * 0.90));
    // 拳の当て革。甲側の関節に硬い面を置くと戦術手袋らしくなる。
    // 指の面(rr+f.r)より7mmも外へ出していたので、当て革だけが独立した瘤3個として写り、
    // 指の付け根は全部その裏に隠れていた。指の面から2mmだけ盛り上がる高さに詰めて、
    // 4個が並んだ拳の稜線として読ませる。
    // 位置はp0を定数倍せず握り角から取り直す。p0側にkを入れた時に一緒にずれるため
    const kp = P(f.a[0] + sk, f.y + 0.004, 1.11);
    h.add(partS(sphG(1), MATS.gloveHard, kp[0], kp[1], kp[2],
      f.r * 0.94, f.r * 0.88, f.r * 0.94));
  }

  // 指と指の谷。間隔を広げて幾何の谷は開いたが、視線が指の並びとほぼ平行なので
  // 画面上は1px強にしかならない。谷の底に暗い継ぎ目を渡して明度でも段を作る。
  // 併せて、指の間に開いた隙間から背景が抜けるのも塞ぐ（装填で手が銃から離れた時に出る）
  for (let i = 0; i < FING.length - 1; i++) {
    if (i === 0 && o.trigger) continue;
    const f0 = FING[i], f1 = FING[i + 1];
    const sk = (skewOf(i) + skewOf(i + 1)) / 2;
    // 終点は第2関節の少し先まで。指先まで伸ばすと、末節が握り半径より内へ絞ってある
    // ぶんだけ継ぎ目が指の外へはみ出して、手から細い黒針が生えて見える
    // 半径は指の芯(rr*1.05)に合わせる。rrのままだと谷の継ぎ目だけ指より内へ落ちて、
    // 握り面の中に沈む（＝谷が幾何としてまた消える）
    h.add(arcRing(MATS.palm, f0.a[0] + sk - 0.10, Math.min(f0.a[1], f1.a[1]) + sk + 0.42,
      (f0.y + f1.y) / 2, rr * 1.05, Math.min(f0.r, f1.r) * 0.82));
  }

  // 引金にかける人差し指。ピボットを別Groupにして引く動きを付けられるようにする
  if (o.trigger) {
    const f = FING[0];
    const k = P(f.a[0], f.y);
    const pv = new THREE.Group();
    pv.position.set(k[0], k[1], k[2]);
    pv.add(capBetween(MATS.glove, [0, 0, 0], [-0.015 * s, 0.016, -0.016], f.r));
    pv.add(capBetween(MATS.glove, [-0.015 * s, 0.016, -0.016], [-0.026 * s, 0.024, -0.033], f.r * 0.9));
    pv.add(partS(sphG(1), MATS.gloveHard, 0.001 * s, 0.005, 0.001, 0.014, 0.011, 0.014));
    h.add(pv);
    h.userData.index = pv;
    h.userData.indexZ = k[2];
  }

  // 親指。指と同じ側で止めると何にも触れない灰色のヘラになるので、
  // 指先と向かい合う側まで回して輪を閉じる。回す量はwrapに連動させる
  // 親指の中節は握り半径の6%外を通していたが、先台を上から掴む左手ではこの1本が
  // 天面(＝レールの歯)の高さを通って刺さっていた。実物どおり握り面に密着させる。
  // ただし2本の直線で1.99radを渡していたので、弦の真ん中が握り円より9mm内へ落ちて
  // 先台に13.3mm埋まっていた（指と同じ弦の罠）。3本に割って中間を外へ張る。
  // 親指の先も、握り角の位置から取り直す（Math.cosにrollを入れ忘れていて、
  // 手を起こすほど指先だけ別の場所に置き去りになっていた）
  // 節を1本増やして、握り軸の真上(a=roll-π/2≒-1.05)にちょうど節を置く。
  // 3本だと真上を弦がまたぐので、そこを外へ張るために両端のkを上げるしかなく、
  // 親指の頂点が実寸より9mm高くなってADSの開口の下側へ余計に入っていた
  const th = -1.85 - wrap * 0.90;
  h.add(capBetween(MATS.glove, P(-0.42, 0.030, 1.12), P(-0.74, 0.033, 1.14), 0.0112));
  h.add(capBetween(MATS.glove, P(-0.74, 0.033, 1.14), P(-1.05, 0.035, 1.12), 0.0110));
  h.add(capBetween(MATS.glove, P(-1.05, 0.035, 1.12), P(-1.70, 0.037, 1.19), 0.0106));
  h.add(capBetween(MATS.glove, P(-1.70, 0.037, 1.19), P(th, 0.034, 1.21), 0.0100));
  // 親指の先。1節細くして指先の丸みを作る
  const tp = P(th, 0.033, 1.19);
  h.add(partS(sphG(1), MATS.glove, tp[0], tp[1], tp[2], 0.0092, 0.0088, 0.0092));

  // 手の甲と掌の肉。楕円体2つで丸みを付ける。
  // 薄い軸は握り面の法線方向なので、位置だけでなく向きも一緒に回す。
  // 【不変条件】甲は指の付け根(a=-0.16)より手前の角度に置き、指の上に被せない。
  // 前は握り角a=-0.09に接線方向±0.74radの塊を置いていたので、
  // カメラを向いている面(a=-1.55〜+1.59)のうち一番正面に近い所を甲1個で覆い、
  // 指の付け根から第2関節までが全部その裏に隠れていた（＝ミトン）。
  // around(d,y,0,roll-a)がP(a,y)と同じ位置になるので、握り角aで指定する。
  // 【不変条件その2】甲・掌の内面(中心−薄い軸)は握り面より内へ入れない。
  // 外径の条件だけ書いてあって内径の条件が無かったので、中心をrr-3mmに置いたまま
  // 薄い軸を12mm取っていた＝内面がrr-15mm＝先台の面より12.6mm内側で、
  // 甲の下半分が先台に飲まれていた（画面では手が先台に沈んで小さく見える）。
  // 握り軸は銃身芯より6mm下なので、天面側の握り面までは28.6ではなく34.6mm。
  // 中心をrr+7mmへ出し、薄い軸を7.5mmへ詰めて内面をrr-0.5mmに置く
  // 長さは肘側を4mm詰めてある。中心を10mm外へ出したぶん後端の極が持ち上がり、
  // SMGでは先台のレール(y=0.040, z=-0.170..-0.128)の箱へちょうど乗っていた（頂点11個）
  const BKA = -0.78;                                // 甲。指の付け根より手前
  const bk = around(rr + 0.0070, -0.003, 0, roll - BKA);
  h.add(partS(sphG(1), MATS.glove, bk[0], bk[1], bk[2], 0.0075, 0.029, 0.020,
    0, -(roll - BKA) * s, 0));
  // 掌の付け根。手首の出る所へ寄せて、手の塊と前腕をつなぐ肉にする。
  // 握り角0.15（＝指の基節の真下）に置くと、指の面より内側に埋まっていて
  // つなぎにならないうえ先台を11.8mm貫いていた。手首と同じ握り角へ回し、
  // 小指より肘寄り(y=-46mm)・指の面の外(rr+14mm)へ出して手首の筒と1つの塊にする
  const PLA = 0.90;
  const pl = around(rr + 0.014, -0.046, 0, roll - PLA);
  h.add(partS(sphG(1), MATS.palm, pl[0], pl[1], pl[2], 0.008, 0.020, 0.018,
    0, -(roll - PLA) * s, 0));
  // 甲の中央の縫い目。甲の面から浮かせると、細長い硬質材が空の反射を拾って
  // 手に金属の棒が刺さっているように光る。肉に半分埋めて筋としてだけ出す
  const sm = around(rr + 0.0125, -0.003, 0, roll - BKA);
  h.add(part(boxG(0.0035, 0.030, 0.0035), MATS.gloveHard, sm[0], sm[1], sm[2],
    0, -(roll - BKA) * s, 0));

  /* ---- 手首・袖口・前腕。境目を隠さないと手が宙に浮いて見える */
  const ad = o.armDir || [0.34 * s, -0.62, 0.70];
  const al = Math.hypot(ad[0], ad[1], ad[2]);
  const ux = ad[0] / al, uy = ad[1] / al, uz = ad[2] / al;
  // 手首の芯。[握り軸から離す量, 指の並び方向の位置, 握り軸まわりの高さ]。
  // 既定値は握把(R=0.021)に合わせてある。太い先台(R=0.031)を掴む支え手では
  // これでは全く足りず、手首の肉も袖口の帯も八角柱の中へ入って
  // 銃身の芯まで届いていた（実測: 帯の頂点の24.9%が内側、最大26.6mm）。
  // 前腕は径74〜92mmで先台(62mm)より太いので、二つの軸は
  // 「先台の面までの距離28.6mm＋前腕の半径」以上離すしかない。
  // rollは手首には4割だけ効かせる。前腕は手より下から入るので、
  // 甲と同じだけ回すと袖口が天面のレールへ乗り上げる。
  // 【不変条件】手首は握り軸まわりで指の列より下(握り角1.0前後)へ置く。
  // 目は手の左上にあるので、真横(握り角0.42)に置くと手首と前腕が
  // 目と指の間に入って中節を全部覆う。掌側は「真横」で解剖的には正しいが、
  // 実物のCクランプも手首は先台の下に落ちているので下側で合っている
  const WR = o.wrist || [R * 0.75 + 0.013, -0.052, 0.014];
  const W = around(WR[0], WR[1], WR[2], roll * 0.4);
  // 前腕は肘へ向かって外へ振れる。径のむらだけ付けた直線の筒だと、
  // 画面下辺で切れるまで滑らかに太っていくだけの「塗装した配管」に読める。
  // 軸に2次の曲がりを入れて、腕の傾きそのものを作る。
  // 曲げる向きは手の甲側(X軸のs側)から軸成分を抜いた向き。手の姿勢に依らず必ず外へ振れる
  let bx = s, by = 0, bz = 0;
  const bd = bx * ux + by * uy + bz * uz;
  bx -= ux * bd; by -= uy * bd; bz -= uz * bd;
  const bl = Math.hypot(bx, by, bz) || 1;
  bx /= bl; by /= bl; bz /= bl;
  // 曲げが浅いと、径が変わるだけの真っ直ぐな棒になって画面下辺まで一直線に伸びる。
  // 実際の前腕は肘へ向かって体側へ寄るので、画面の隅へ弧を描いて抜けていく。
  // 0.20では弧が読めなかったので、肘の側で2cm以上振れる量まで強める
  const BEND = 0.46;
  const at = (k) => [
    W[0] + ux * k + bx * BEND * k * k,
    W[1] + uy * k + by * BEND * k * k,
    W[2] + uz * k + bz * BEND * k * k,
  ];
  // 曲がった軸に輪を巻くので、向きは接線を取り直す
  const tanAt = (k) => [ux + 2 * BEND * k * bx, uy + 2 * BEND * k * by, uz + 2 * BEND * k * bz];
  // 手首の肉。前はここをcapBetween(W, at(0.044), 0.021)で置いていた。
  // capBetweenは両端に半径ぶんの半球が生えるので、手側の端に半径21mmの
  // 無地のドームが立ち、目から見て中指〜小指の中節より25〜40mm手前に来て
  // 4本中3本を丸ごと覆っていた（画面上で直径30px、内側に縫い目も関節も無し）。
  // 半球を持たない先細りの筒に替え、太い側の端は締めの帯(半径30mm)の中へ入れて
  // 端面の円板を出さない。細い側は掌の肉の中に埋める
  h.add(tubeBetween(MATS.glove, at(-0.020), at(0.040), 0.0130, 0.0215, 14));
  // 筒の細い側の端は掌の肉の中にあるが、真円の切り口が半分だけ覗く。
  // 同じ半径の球で丸めておく（元のカプセルと違い、こちらは半径13mmなので指に掛からない）
  const we = at(-0.020);
  h.add(partS(sphG(1), MATS.glove, we[0], we[1], we[2], 0.0130, 0.0130, 0.0130));
  // 袖口の帯と締めの輪。手首のすぐ横に前腕の太さの筒を置くと必ず先台に食い込むので、
  // 手首から12mm肘寄りへずらし、手首の位置では実寸どおり細くする
  h.add(tubeBetween(MATS.strap, at(0.034), at(0.064), 0.0300, 0.0352, 16));
  h.add(ringAt(MATS.strap, at(0.042), tanAt(0.042), 0.0330, 0.0038));
  // 袖は必ず画面の外まで伸ばして、フレームの端で切れさせる。
  // 途中で終わると端面の円板が見えて、腕ではなく「端を塞いだ配管」に読めてしまう。
  // 袖の長さはビューモデルの縮尺に効く。右手の腕は肘＝目の方向へ伸びるので、
  // 銃を大きく構えると袖の先が目の前まで来て、近接面が画面いっぱいに引き伸ばされる。
  // 画面の端から外へ抜けさえすれば長さは要らないので、腕ごとに縮められるようにする
  const AL = o.armLen != null ? o.armLen : 1;
  // 前腕の太さの節。手首の径(0.076)が機関部の厚み(0.07強)に並ぶ所から始めて、肘へ太らせる。
  // 【不変条件】この列は必ず単調増加にする。
  // 途中で一度細くなる（＝くびれ）と人の腕には絶対に見えない。実物の前腕は
  // 手首から肘まで一度も細くならず、肘の手前で一番太くなる。
  // 以前の列は3番目でくびれていて、そこが配管の継ぎ手のように読めていた
  const SL = [[0.064, 0.0380], [0.130, 0.0442], [0.230, 0.0522], [0.350, 0.0630], [0.55, 0.0780]];
  // 節の間は直線で結ぶ。袖を1枚の皮として張るので、半径は連続で取れないといけない
  const rAt = (k) => {
    const t = k / AL;
    for (let i = 0; i + 2 < SL.length; i++) {
      if (t <= SL[i + 1][0]) {
        return lerp(SL[i][1], SL[i + 1][1],
          clamp01((t - SL[i][0]) / (SL[i + 1][0] - SL[i][0])));
      }
    }
    const n = SL.length - 1;
    return lerp(SL[n - 1][1], SL[n][1],
      clamp01((t - SL[n - 1][0]) / (SL[n][0] - SL[n - 1][0])));
  };
  // 皮だけ別材質にする。折り返し(下のtubeBetween)は皺の位相を持っていないので、
  // 同じ材質のまま増幅を掛けると遮蔽の差だけが強調されて縁が黒く回る
  h.add(sleeveTube(MATS.sleeveSkin, at, tanAt, SL[0][0] * AL, SL[SL.length - 1][0] * AL, rAt));
  // 袖口の折り返し。手首側へ向かって太くなる短い筒を重ねると、
  // 端に厚みのある縁が立って「布を折り返して留めてある」ように見える。
  // 袖の皮の口はこの中に隠すので、折り返しは袖より必ず太くしておく
  h.add(tubeBetween(MATS.sleeve, at(0.104 * AL), at(0.056 * AL), 0.0410, 0.0452, 20));
  // 袖のベルクロ帯。折り返しの上から締めるので、折り返しの外径より一回り太くする。
  // 布の中で唯一の硬い部品なので、ここだけ粗さが低く、縁にハイライトが1本立つ。
  // 細い帯を1本添えると、締め付けで布が寄っている段が出る
  h.add(ringAt(MATS.gloveHard, at(0.076 * AL), tanAt(0.076 * AL), 0.0442, 0.0042));
  h.add(ringAt(MATS.gloveHard, at(0.092 * AL), tanAt(0.092 * AL), 0.0418, 0.0022));

  bakeStatic(h);
  return h;
}

/* ------------------------------------------------------------ 光学サイト */

// 中身が詰まった箱で作ると覗いた時に真っ黒な壁になる。筒にして芯を通す。
//
// 【不変条件】覗いた時の視線は、接眼リム（内半径0.0195）を頂点にして
// 前へ広がる円錐になる。この円錐の内側に置いてよいのは筒の内壁とレンズとドットだけ。
// 円錐は前へ行くほど太くなるので「cy-0.021より上は禁止」のような固定の高さでは守れない。
// 部品を足す時は、外皮の半径(0.0245／対物側は最大0.0350)より外に置くか、
// 前へ出さないかのどちらかにする。マウントを板でなくリングにしてあるのはこのため
function addOptic(g, y, z) {
  const cy = y + 0.026;
  // ADSでは画面中央をこの1部品が占める。ここだけ分割を上げる。
  // 14角だと対物ベルの円周に平面ファセットが肉眼で数えられて、シェーディングが多角形に折れる
  const SEG = 40;

  // マウント。レールを跨ぐクランプとつまみネジを付けて「載せてある」感を出す
  g.add(part(cboxG(0.034, 0.013, 0.086), MATS.anodized, 0, y - 0.010, z));
  g.add(part(cboxG(0.040, 0.008, 0.030), MATS.anodized, -0.002, y - 0.009, z + 0.028));
  g.add(part(cylG(0.007, 0.007, 0.012, 12), MATS.steel, -0.021, y - 0.009, z + 0.028, 0, 0, Math.PI / 2));
  // 筒を抱えるリング部。ここを板や箱で作ると、上端が視線の円錐へ食い込んで
  // レンズの下側が黒く欠ける（clearより上は筒とレンズとドット以外置けない、の元凶）。
  // 実物どおり筒の外周を巻くリングにすれば、外皮より内へ入りようがないので原理的に安全
  for (const rz of [0.010, 0.034]) {
    g.add(part(torG(0.0262, 0.0035, 6, 26), MATS.anodized, 0, cy, z + rz));
    g.add(part(cboxG(0.012, 0.010, 0.012), MATS.anodized, 0, cy - 0.031, z + rz));
  }
  addScrewX(g, 0.0175, cy - 0.030, z + 0.010, 0.0030);
  addScrewX(g, -0.0175, cy - 0.030, z + 0.010, 0.0030);

  /* ---- 筒。
     【ケラレの不変条件】覗いた時に内壁が有効径を食うかどうかは、
     前の開口と後ろの開口が目から見て張る角度の大小だけで決まる。
     後ろ(接眼)の開口が張る角 > 前(対物)の開口が張る角 になった瞬間、
     その差の分だけ内壁が輪になって見える。今までは直筒だったので
     前の方が遠い＝角が小さく、開口の35〜45%が濃い灰色の内壁で埋まっていた。
     対物側を開いたベルにして、前の開口が張る角を後ろよりわずかに大きくすると
     開口いっぱいまで抜ける。実物のダットサイトが対物側で太いのはこれが理由。

     目までの距離: 接眼リム ≒ adsDist - 0.040*adsScale、対物リム ≒ adsDist + 0.045*adsScale。
     一番厳しいのは目に近いSMG(adsDist 0.136 / adsScale 0.70)で、0.108 と 0.1675、比 1.551。
     接眼の内半径0.0195に対し対物は0.0195*1.551=0.0303以上が要る。両銃を満たす0.0310で取る */
  /* 2026-08-11に窓を広げた。**「もっと敵が見えるようにして」と言われて測ったら、
     壁の厚みが窓を食っていた。**

     どこが塞いでいるかを角度ごとに名指しで測ると、こう出た（覗き切った状態）:

       3.0度まで … 素通し100%
       3.5〜4.5度 … 79〜88%（欠けているのは左手の手袋。下側だけなので実害は小さい）
       5.0度      … **素通し0%。48方向のうち47をopticTubeが塞ぐ**

     つまり壁は接眼側の内壁で、そこから先は1画素も見えていなかった。
     接眼の壁は0.0050あるのに対物側は0.0028しかない。
     **外皮(0.0245)を動かさずに内壁だけ広げれば、銃の太さは変わらないまま窓が広がる。**
     0.0195→0.0215で壁は0.0030（対物側と同じくらい）。

     広げた内壁に合わせて対物側も開く必要がある（下のケラレの不変条件。
     0.0215×1.551=0.0334が下限なので0.0340で取る）。
     そのぶん対物の外皮とリムも押し出すが、増えるのは外径で0.0028だけ */
  // 内壁。接眼側の直筒
  g.add(part(cylG(0.0215, 0.0215, 0.050, SEG, true), MATS.opticTube, 0, cy, z + 0.015, Math.PI / 2));
  // 内壁。対物ベル（前へ開く）
  g.add(part(cylG(0.0215, 0.0340, 0.035, SEG, true), MATS.opticTube, 0, cy, z - 0.0275, Math.PI / 2));
  // 外皮。内壁と分けると筒に厚みが出る。ここも必ず両端を開ける。
  // 蓋が付いていると視線の先に黒い円板が立って、覗いた瞬間に何も見えなくなる。
  // **ここは広げていない**（銃の太さを変えずに窓だけ広げるのが狙いなので）
  g.add(part(cylG(0.0245, 0.0245, 0.052, SEG, true), MATS.gunmetal, 0, cy, z + 0.014, Math.PI / 2));
  // 対物ベルの外皮。ADSでは硝子の周りの黒い輪の太さがそのままここで決まる。
  // 外径がレンズ半径の1.3倍もあると、等倍のダットサイトとしては遮蔽が大きすぎるので
  // 内壁(0.0340)ぎりぎりまで絞って、輪をレンズ半径の1.15倍に収める
  g.add(part(cylG(0.0245, 0.0366, 0.036, SEG, true), MATS.gunmetal, 0, cy, z - 0.028, Math.PI / 2));
  // 前後のリム。対物側は面取りリングを2本重ねて、ベルの縁に細い鏡面ラインを走らせる
  g.add(part(torG(0.0248, 0.0034, 6, 28), MATS.anodized, 0, cy, z + 0.040));
  g.add(part(torG(0.0358, 0.0026, 6, 32), MATS.anodized, 0, cy, z - 0.0455));
  g.add(part(torG(0.0354, 0.0013, 5, 32), MATS.steel, 0, cy, z - 0.0405));
  // 対物ベゼルのローレット。画面中央を1部品が占めるのに、
  // 刻みもツマミも無い輪だと成形プラスチックの筒にしか見えない。
  // 実際に歯を立てると、覗いた時に縁へ細かい明暗の目が並ぶ
  // ベルを開いたぶん、刻みも外へ出す（0.0338→0.0366。歯は必ず輪の外側へ）
  g.add(part(torG(0.0366, 0.0026, 6, 32), MATS.knurl, 0, cy, z - 0.0400));
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    g.add(part(boxG(0.0026, 0.0026, 0.010), MATS.knurl,
      Math.cos(a) * 0.0376, cy + Math.sin(a) * 0.0376, z - 0.0400, 0, 0, a));
  }
  // 胴と対物の継ぎ目
  g.add(part(torG(0.0250, 0.0022, 5, 28), MATS.anodized, 0, cy, z - 0.010));

  // エレベーション（上下）の調整ツマミ。筒の天面に立てる。
  // 内壁(半径0.0195)より外なので視線の円錐には入らない
  g.add(part(cylG(0.0100, 0.0108, 0.016, 14), MATS.anodized, 0, cy + 0.030, z + 0.012));
  g.add(part(cylG(0.0086, 0.0086, 0.004, 14), MATS.steel, 0, cy + 0.039, z + 0.012));
  g.add(part(boxG(0.0030, 0.0016, 0.012), MATS.enamel, 0, cy + 0.0405, z + 0.012));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.add(part(boxG(0.0022, 0.014, 0.0022), MATS.knurl,
      Math.cos(a) * 0.0104, cy + 0.030, z + 0.012 + Math.sin(a) * 0.0104, 0, -a, 0));
  }

  // 輝度ダイヤル。内側の face は必ず外皮の面(x=0.0245)より外で止める。
  // これより内へ入れると、ダイヤルの上下の縁が視線の通り道（接眼の内半径0.0195の円）へ
  // 食い込んで、レンズの右端に黒い欠けが出る。円筒はx=0.0245〜0.0385。
  // 刻みもこの厚みの中へ収める。はみ出すと筒の横に短冊が浮いた「壊れたジオメトリ」に見える
  g.add(part(cylG(0.011, 0.012, 0.014, 14), MATS.anodized, 0.0315, cy, z + 0.012, 0, 0, Math.PI / 2));
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    g.add(part(boxG(0.010, 0.0022, 0.0022), MATS.gunmetal,
      0.0325, cy + Math.cos(a) * 0.0122, z + 0.012 + Math.sin(a) * 0.0122));
  }
  // 電池キャップ。反対側も同じく内側の face を外皮の面で止める
  g.add(part(cylG(0.010, 0.010, 0.010, 14), MATS.anodized, -0.0295, cy, z + 0.012, 0, 0, Math.PI / 2));
  // 刻印は外皮(SEG角形なので面までの距離はほぼ半径そのもの)へ埋め込む。
  // 浮かせると筒の横に薄板が貼り付いただけに見える
  addStampX(g, 0.0242, cy - 0.009, z + 0.030, 0.016, 0.010, 2);

  /* ---- レンズ。対物ベルの内側いっぱいに張る。
     実物の透過率は90%前後で、覗けば外の世界がそのまま見える。
     ここを不透明寄りにすると「筒の中だけ別の絵」になって、サイトとして機能しない */
  // レンズは対物の口元へ寄せる。手前に置くと、レンズの縁と接眼リムの間に
  // 内壁の輪が残って「像の周りに灰色の帯」が出る
  // 外皮を絞ったぶんレンズは広げられる。硝子が広いほど覗いた時の視野が広い
  const lensR = 0.0308;
  // 球半径0.26mの浅いドーム。膨らみは1.8mmしかないが、
  // これがあるだけで縁の法線が視線から開いて、コーティングの色と反射が角度で振れる
  const DOME = 0.26;
  g.add(part(domeG(lensR, DOME, SEG), MATS.glass, 0, cy, z - 0.0425 + DOME, -Math.PI / 2));
  // 周縁の落ち込み。中心は素通しのまま外周だけ暗く沈めて、フレネルを代用する
  const edge = part(circG(lensR, SEG), MATS.lensEdge, 0, cy, z - 0.0400);
  edge.renderOrder = 16;
  edge.userData.keep = true;
  g.add(edge);
  // コーティング。中心が抜けて外周ほど青緑〜紫が乗る1枚を全面に敷く
  const coat = part(circG(lensR - 0.0006, SEG), MATS.coating, 0, cy, z - 0.0396);
  coat.renderOrder = 17;
  coat.userData.keep = true;
  g.add(coat);
  // 環境の映り込み。斜めの帯を薄く乗せる。
  // 板でやると四角い外形がそのまま継ぎ目として出るので、丸を縦に潰して使う
  const sheen = part(circG(0.021, 24), MATS.sheen, -0.008, cy + 0.008, z - 0.0414);
  sheen.scale.set(1.0, 0.42, 1);
  sheen.rotation.z = -0.7;
  sheen.renderOrder = 18;
  sheen.userData.keep = true;
  g.add(sheen);
  g.userData.sheen = sheen;

  /* ---- レティクル。滲みだけだと輪郭が無いので、細いリングと芯のドットで組む */
  // 滲みは芯に寄せる。リングと同じ大きさまで広げるとリングが滲みに溶けて輪郭が消える。
  // 芯を実MOAまで細くすると滲みの方が勝って「赤い丸シール」に逆戻りするので、
  // 滲みも芯に比例して詰める
  const glow = part(planeG(0.006, 0.006), MATS.dotGlow, 0, cy, z - 0.028);
  glow.renderOrder = 19;
  glow.userData.keep = true;
  g.add(glow);
  // 輪。ADSの画角(46度→1px=0.064度)で実測すると、半径0.0105の輪は直径300MOAあった。
  // EOTechの輪でも68MOAなので、30m先の敵の胴がまるごと入る大きさになっていた。
  // 130MOA相当（画面上で直径約68px）まで絞る
  const ring = part(torG(0.0045, 0.00035, 4, 40), MATS.reticle, 0, cy, z - 0.0272);
  ring.renderOrder = 20;
  ring.userData.keep = true;
  g.add(ring);
  // 芯。丸マスクの外周は透けるので、板の寸法より実際に光る芯は一回り小さくなる。
  // 0.0048だと画面上12px＝46MOAで、狙点ではなく的を隠す板になっていた。
  // 実物のダットは2MOA。720pで潰れない下限（芯が約3px＝12MOA相当）まで細める
  const dot = part(planeG(0.0013, 0.0013), MATS.dot, 0, cy, z - 0.0268);
  dot.renderOrder = 20;
  dot.userData.keep = true;
  g.add(dot);
  g.userData.dotGlow = glow;
  g.userData.reticle = [glow, ring, dot];

  const sight = new THREE.Object3D();
  sight.position.set(0, cy, z);
  g.add(sight);
  g.userData.sight = sight;
}

/* ------------------------------------------------------------ 望遠照準 */

/* 狙撃銃に載せる長い筒。**上の addOptic と同じ決まりの上に立っている**ので、
   触る前にあちらの【ケラレの不変条件】を読むこと。要点は同じで、
   覗いた時に見えるのは接眼リム（内半径EYE_R）を頂点に前へ広がる円錐の内側だけ。
   そこへ置いてよいのは筒の内壁とレンズとレティクルに限られる。

   **ドットとの違いは筒が長いこと。** ここで一度間違えたので書いておく:
   穴の広さを決めるのは接眼リムではなく、**直筒の一番前の縁**だった。
   リムを通った斜めの光線は、そのまま進んで内壁の前端にぶつかる。
   実測（tools/check-scope.mjs が目からレイを撃って測る）でも、
   赤ドットの理屈上の開口は5.97度なのに実際に抜けているのは4.6度までで、
   差はちょうどこの直筒の長さ分だった。

   なので見るのは3箇所。**どれか1つでも小さいと、そこが穴の大きさになる:**

     直筒の前端  r=EYE_R*s / (adsDist + 0.035*s) = 0.0126 / 0.151 → 4.77度
     対物リム    r=OBJ_R*s / (adsDist + 0.115*s) = 0.0216 / 0.199 → 6.19度
     接眼リム    r=EYE_R*s / (adsDist - 0.075*s) = 0.0126 / 0.085 → 8.44度

   一番狭い4.77度が答えで、実測でも4.7度。赤ドット(4.6度)とほぼ同じ角度になる。

   **同じ角度でも、画面に写る大きさは3倍違う。**
   覗くとビューモデル側の画角も一緒に絞られる（_animateの末尾。55度→adsFov*0.9）ので、
   赤ドットでは41.4度の画面に4.6度＝画面の高さの21%だが、
   こちらは14.4度の画面に4.7度＝**65%**になる。
   つまり覗いた時に「丸い窓の中に景色が見える」画になるのはこの銃だけで、
   狙撃銃らしさはここから出ている。

   **構えの寸法(view.adsDist/adsScale)を動かすとこの3つが全部変わる。**
   動かしたら tools/check-scope.mjs を走らせて、抜けている角度を測り直すこと */
function addScope(g, y, z) {
  const cy = y + 0.026;
  const SEG = 36;
  const EYE_Z = 0.075, OBJ_Z = -0.115;   // 接眼リムと対物リムの位置（zからの差）
  const EYE_R = 0.0210, OBJ_R = 0.036;   // 内壁の半径。上の計算がこの2つ
  const TUBE_R = 0.0260, BELL_R = 0.0410; // 外皮

  /* ---- マウント。レールを前後2箇所で跨ぐ。
     ここを板や箱で筒の上まで回すと、視線の円錐へ食い込んで開口の縁が欠ける。
     筒に触るのは外周を巻くリングだけにしておけば、原理的にそれが起きない */
  g.add(part(cboxG(0.038, 0.012, 0.105), MATS.anodized, 0, y - 0.016, z + 0.008));
  for (const rz of [0.045, -0.020]) {
    g.add(part(torG(TUBE_R + 0.004, 0.004, 6, 24), MATS.anodized, 0, cy, z + rz));
    g.add(part(cboxG(0.015, 0.030, 0.016), MATS.anodized, 0, cy - 0.028, z + rz));
    addScrewX(g, 0.020, cy - 0.030, z + rz, 0.0032);
    addScrewX(g, -0.020, cy - 0.030, z + rz, 0.0032);
  }

  /* ---- 内壁。接眼側は直筒、対物側は前へ開くベル。
     必ず両端を開けること（openEnded）。蓋が付くと覗いた瞬間に黒い円板が立つ */
  g.add(part(cylG(EYE_R, EYE_R, 0.113, SEG, true), MATS.opticTube, 0, cy, z + 0.0215, Math.PI / 2));
  g.add(part(cylG(EYE_R, OBJ_R, 0.080, SEG, true), MATS.opticTube, 0, cy, z - 0.075, Math.PI / 2));
  // 外皮。内壁と分けると筒に厚みが出る
  g.add(part(cylG(TUBE_R, TUBE_R, 0.115, SEG, true), MATS.gunmetal, 0, cy, z + 0.0205, Math.PI / 2));
  g.add(part(cylG(TUBE_R, BELL_R, 0.082, SEG, true), MATS.gunmetal, 0, cy, z - 0.076, Math.PI / 2));
  // 接眼側の張り出し（目を当てる所）。内径は筒の外皮まで開けておく。
  // ここを細くすると、接眼リムより手前で視線を絞ることになって輪が出る
  g.add(part(cylG(0.032, TUBE_R, 0.030, SEG, true), MATS.gunmetal, 0, cy, z + 0.062, Math.PI / 2));
  g.add(part(torG(0.0322, 0.0030, 6, 26), MATS.anodized, 0, cy, z + EYE_Z + 0.002));
  // 対物リムの面取り。縁に細い鏡面ラインを走らせる
  g.add(part(torG(BELL_R - 0.001, 0.0028, 6, 30), MATS.anodized, 0, cy, z + OBJ_Z + 0.004));
  g.add(part(torG(BELL_R - 0.004, 0.0014, 5, 30), MATS.steel, 0, cy, z + OBJ_Z + 0.010));
  // 胴とベルの継ぎ目
  g.add(part(torG(TUBE_R + 0.002, 0.0022, 5, 26), MATS.anodized, 0, cy, z - 0.035));
  // 倍率環のローレット。接眼寄りに1本。刻みは外皮の厚みの中へ収める
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    g.add(part(boxG(0.0026, 0.0026, 0.016), MATS.knurl,
      Math.cos(a) * (TUBE_R + 0.005), cy + Math.sin(a) * (TUBE_R + 0.005), z + 0.048, 0, 0, a));
  }

  /* ---- 調整ツマミ。内壁(EYE_R)より外なので視線の円錐には入らない */
  g.add(part(cylG(0.0105, 0.0112, 0.020, 14), MATS.anodized, 0, cy + 0.028, z + 0.008));
  g.add(part(cylG(0.0090, 0.0090, 0.005, 14), MATS.steel, 0, cy + 0.040, z + 0.008));
  g.add(part(boxG(0.0030, 0.0016, 0.014), MATS.enamel, 0, cy + 0.0425, z + 0.008));
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    g.add(part(boxG(0.0022, 0.018, 0.0022), MATS.knurl,
      Math.cos(a) * 0.0109, cy + 0.028, z + 0.008 + Math.sin(a) * 0.0109, 0, -a, 0));
  }
  // 横のツマミ。内側の面は外皮(TUBE_R)より外で止める
  g.add(part(cylG(0.0100, 0.0108, 0.016, 14), MATS.anodized, TUBE_R + 0.008, cy, z + 0.008, 0, 0, Math.PI / 2));
  addStampX(g, TUBE_R - 0.0002, cy - 0.008, z - 0.008, 0.020, 0.010, 2);

  /* ---- レンズ。対物ベルの内側いっぱいに張る */
  const lensR = OBJ_R - 0.001;
  const DOME = 0.30;
  g.add(part(domeG(lensR, DOME, SEG), MATS.glass, 0, cy, z + OBJ_Z + 0.006 + DOME, -Math.PI / 2));
  const edge = part(circG(lensR, SEG), MATS.lensEdge, 0, cy, z + OBJ_Z + 0.008);
  edge.renderOrder = 16;
  edge.userData.keep = true;
  g.add(edge);
  const coat = part(circG(lensR - 0.0008, SEG), MATS.coating, 0, cy, z + OBJ_Z + 0.0092);
  coat.renderOrder = 17;
  coat.userData.keep = true;
  g.add(coat);
  const sheen = part(circG(0.024, 24), MATS.sheen, -0.010, cy + 0.010, z + OBJ_Z + 0.0104);
  sheen.scale.set(1.0, 0.42, 1);
  sheen.rotation.z = -0.7;
  sheen.renderOrder = 18;
  sheen.userData.keep = true;
  g.add(sheen);
  g.userData.sheen = sheen;

  /* ---- レティクル。狙撃銃なので点ではなく十字にする。
     真ん中を空けて（中心を隠さない）、外側だけ太くする実物の形にすると、
     細い線でも背景に負けずに追える。
     線の長さは「その面で見えている円」の内側に収めること。
     この面での円の半径は 開口の傾き(0.0834) × 目からの距離(0.3167) = 0.0264 なので、
     一番外の線でも0.0245で止める（はみ出すと筒の内壁に刺さって途中で切れる） */
  const bars = [];
  const bar = (len, th, off, vertical) => {
    for (const s of [1, -1]) {
      const m = part(
        planeG(vertical ? th : len, vertical ? len : th), MATS.reticle,
        vertical ? 0 : s * (off + len / 2), cy + (vertical ? s * (off + len / 2) : 0),
        z + OBJ_Z + 0.015,
      );
      m.renderOrder = 20;
      m.userData.keep = true;
      g.add(m);
      bars.push(m);
    }
  };
  /* 内側の細い線と、外側の太い線。太いほうが視線を中心へ導く。

     **太さは実測して決めた。** 覗くとビューモデルの画角が14.4度まで絞られるので、
     720pだと1度が50画素になる（腰だめの55度なら13画素）。
     最初に置いた0.0010は、そこで9画素の帯になって的を隠していた。
     細い線2.5画素・太い線5画素・芯4画素に収まる寸法まで詰める。
     太さを変えた時は _spike ではなく tools/check-scope.mjs で測り直すこと */
  bar(0.012, 0.00028, 0.0035, false);
  bar(0.012, 0.00028, 0.0035, true);
  bar(0.008, 0.00055, 0.0165, false);
  bar(0.008, 0.00055, 0.0165, true);
  // 芯。十字の交点は空けてあるので、狙点そのものはこの点が受け持つ
  const dot = part(planeG(0.00045, 0.00045), MATS.dot, 0, cy, z + OBJ_Z + 0.016);
  dot.renderOrder = 20;
  dot.userData.keep = true;
  g.add(dot);
  bars.push(dot);
  g.userData.reticle = bars;

  const sight = new THREE.Object3D();
  sight.position.set(0, cy, z);
  g.add(sight);
  g.userData.sight = sight;
}

/* ------------------------------------------------------------ ライフル */

// 銃身の芯の高さ。先台の八角断面の中心をここに合わせる
const R_BORE = 0.021;
const R_RAIL = 0.052;

/**
 * @param deco 形違いのスキンが飾りを足す口。**bakeStaticの前に呼ぶ。**
 *             後から足すと結合の外に出て、飾りの数だけ描画呼び出しが増える。
 *             動く部品（bolt/mag/trigger）には触らせない
 *             （触ると装填の動きが壊れるが、壊れたことに気づけない）
 */
// viewは受けるが読まない（握り方を武器ごとに変えられる形に揃えてあるだけ）。
// eslint-disable-next-line no-unused-vars -- 他のbuildと引数の形を揃えている
function buildRifle(view = {}, deco = null) {
  const g = new THREE.Group();

  /* ---- 下部機関部。マグウェルをラッパ状に開いて差し込み口を「口」に見せる */
  g.add(part(cboxG(0.046, 0.058, 0.20), MATS.enamel, 0, -0.006, -0.05));
  g.add(part(cboxG(0.050, 0.054, 0.070), MATS.enamel, 0, -0.032, 0.030));
  g.add(part(cboxG(0.054, 0.012, 0.078), MATS.phosphate, 0, -0.056, 0.031));
  g.add(part(cboxG(0.036, 0.022, 0.072), MATS.enamel, 0, -0.038, 0.076));
  addStampX(g, 0.0245, -0.022, 0.030, 0.030, 0.018);
  addStampX(g, -0.0245, -0.022, 0.030, 0.030, 0.018);

  /* ---- 上部機関部。上面を一段高い台にして「フラットな箱」から抜け出す */
  g.add(part(cboxG(0.048, 0.036, 0.215), MATS.anodized, 0, 0.0315, -0.055));
  g.add(part(cboxG(0.040, 0.010, 0.215), MATS.anodized, 0, 0.045, -0.055));
  g.add(part(cboxG(0.048, 0.020, 0.048), MATS.anodized, 0, 0.040, 0.070));  // 後端の段差
  addRail(g, R_RAIL, -0.160, 0.050, 0.024);
  // 機関部と先台の継ぎ目のリング
  g.add(part(cylG(0.029, 0.029, 0.022, 14), MATS.steel, 0, R_BORE, -0.152, Math.PI / 2));
  g.add(part(cylG(0.031, 0.031, 0.006, 14), MATS.phosphate, 0, R_BORE, -0.140, Math.PI / 2));

  /* ---- 排莢まわり。フォワードアシストとブラスディフレクター */
  g.add(part(cboxG(0.016, 0.028, 0.030), MATS.anodized, 0.028, 0.020, 0.052));
  g.add(part(cylG(0.0095, 0.0095, 0.016, 12), MATS.phosphate, 0.032, 0.020, 0.052, 0, 0, Math.PI / 2));
  g.add(part(cylG(0.0065, 0.0065, 0.008, 10), MATS.steel, 0.040, 0.020, 0.052, 0, 0, Math.PI / 2));
  g.add(part(cboxG(0.014, 0.024, 0.032), MATS.anodized, 0.028, 0.034, 0.022, 0, 0, 0.42));
  // 排莢口の奥。カバーが開いた時に穴が抜けないよう塞いでおく
  g.add(part(boxG(0.004, 0.026, 0.076), MATS.enamel, 0.022, 0.024, 0.000));

  /* ---- 操作部。セレクター・マガジンリリース・ボルトキャッチ */
  g.add(part(cylG(0.0095, 0.0095, 0.012, 10), MATS.phosphate, -0.026, -0.010, 0.062, 0, 0, Math.PI / 2));
  g.add(part(boxG(0.007, 0.011, 0.028), MATS.phosphate, -0.030, -0.013, 0.070, 0.45));
  addStampX(g, -0.0245, -0.010, 0.062, 0.016, 0.014, 2);
  g.add(part(boxG(0.006, 0.020, 0.022), MATS.anodized, 0.026, -0.020, 0.062));
  g.add(part(cylG(0.0058, 0.0058, 0.010, 10), MATS.steel, 0.030, -0.020, 0.062, 0, 0, Math.PI / 2));
  g.add(part(boxG(0.006, 0.021, 0.032), MATS.anodized, -0.026, -0.016, 0.028));
  g.add(part(boxG(0.008, 0.013, 0.011), MATS.phosphate, -0.029, -0.022, 0.016));
  addSlingLoop(g, -0.026, -0.002, 0.096);
  addScrewX(g, 0.024, -0.014, -0.120);
  addScrewX(g, -0.024, -0.014, -0.120);

  /* ---- 先台。八角の筒にして角を作る。丸でも箱でもない断面が情報量になる */
  g.add(part(cylG(0.031, 0.031, 0.270, 8), MATS.phosphate, 0, R_BORE, -0.290, Math.PI / 2, Math.PI / 8));
  // 天面レールを先台の全長に張ると、左手の指の弧（銃身芯から0.0394m）と
  // 歯の角（0.0396m）がミリ以下で同じ所を通り、指とレールが刺さったまま両方描かれる。
  // 実物のM-LOK先台も握る所にレールは付いていない。
  // さらに前半分のレールは、覗いた時に光軸から伏角3.7〜4.2度＝接眼リムの張る角(5.97度)の
  // 内側に入るので、開口の下半分を明るい歯の列が横切る原因にもなっていた。
  // レールは機関部から続く73mmだけ残して、その先はM-LOKの長穴（平面）にする
  addRail(g, R_RAIL - 0.003, -0.245, -0.172, 0.022);
  // 天面のM-LOK。八角の上面(銃身芯+0.0286)へ彫り込む
  for (let i = 0; i < 3; i++) {
    g.add(part(boxG(0.011, 0.004, 0.030), MATS.enamel, 0, R_BORE + 0.0286, -0.300 - i * 0.052));
  }
  // 通気孔。左右の平面に開ける
  for (let i = 0; i < 5; i++) {
    const z = -0.200 - i * 0.043;
    addVentX(g, 0.0292, R_BORE, z);
    addVentX(g, -0.0292, R_BORE, z);
  }
  // M-LOKの長穴。下面に彫り込みを並べる
  for (let i = 0; i < 4; i++) {
    g.add(part(boxG(0.011, 0.004, 0.030), MATS.enamel, 0, R_BORE - 0.030, -0.215 - i * 0.052));
  }
  addScrewX(g, 0.0295, R_BORE - 0.018, -0.178, 0.0032);
  addScrewX(g, -0.0295, R_BORE - 0.018, -0.178, 0.0032);
  addSlingLoop(g, -0.030, R_BORE - 0.010, -0.400, 0.0075);

  /* ---- 銃身・ガスブロック・消炎制退器。
     露出した円筒は輪郭に多角形の折れが出るので分割を上げる。
     ビューモデルは画面下部を常時占める資産なので、ここのポリゴンは惜しまない */
  g.add(part(cylG(0.0095, 0.0095, 0.190, 20), MATS.phosphate, 0, R_BORE, -0.520, Math.PI / 2));
  g.add(part(cboxG(0.026, 0.030, 0.038), MATS.phosphate, 0, R_BORE + 0.006, -0.442));
  // ガスチューブは先台の中に隠れる部品。以前は前端がz=-0.445まで出ていて、
  // 消炎制退器の爪より前に外径4.5mmの明るい針が1本浮いて見えていた。
  // シルエットで一番効く先端に余計な棒を出さないよう、ガスブロックの中で止める。
  // 材質もsteelだと至近でスペキュラを拾って光るのでphosphateにする
  g.add(part(cylG(0.0045, 0.0045, 0.270, 8), MATS.phosphate, 0, R_BORE + 0.019, -0.295, Math.PI / 2));
  for (let i = 0; i < 3; i++) {
    g.add(part(torG(0.0115, 0.0022, 5, 18), MATS.steel, 0, R_BORE, -0.560 - i * 0.016));
  }
  g.add(part(cylG(0.0165, 0.0155, 0.052, 20), MATS.steel, 0, R_BORE, -0.640, Math.PI / 2));
  // 先端の爪。真横から見た時のシルエットが効く
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    g.add(part(boxG(0.005, 0.005, 0.018), MATS.steel,
      Math.cos(a) * 0.012, R_BORE + Math.sin(a) * 0.012, -0.672));
  }

  /* ---- 握把。ゴムの当て板と指掛かりの溝を入れる。
     前後を厚くすると指が握把にめり込むので、実物どおり細身にする */
  g.add(part(cboxG(0.036, 0.100, 0.036), MATS.polymer, 0, -0.092, 0.126, -0.30));
  g.add(part(boxG(0.030, 0.086, 0.008), MATS.rubber, 0, -0.090, 0.146, -0.30));
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.005, 0.005, 0.034, 8), MATS.polymer,
      0, -0.068 - i * 0.024, 0.106 + i * 0.008, 0, 0, Math.PI / 2));
  }
  g.add(part(cboxG(0.038, 0.011, 0.038), MATS.polymer, 0, -0.140, 0.115, -0.30));

  /* ---- 用心鉄。半円の輪にすると鋳物らしくなる */
  g.add(part(torG(0.020, 0.0036, 6, 14, Math.PI), MATS.enamel,
    0, -0.042, 0.078, 0, Math.PI / 2, Math.PI));

  /* ---- 引金（動く） */
  const trg = new THREE.Group();
  trg.position.set(0, -0.030, 0.088);
  trg.add(part(boxG(0.008, 0.024, 0.008), MATS.steel, 0, -0.012, -0.004, 0.2));
  trg.add(part(cylG(0.005, 0.005, 0.010, 8), MATS.steel, 0, 0, 0, 0, 0, Math.PI / 2));
  g.add(trg);
  g.userData.trigger = trg;

  /* ---- 排莢口カバー（動く）。蝶番を下端に置いて外へ倒す */
  const dust = new THREE.Group();
  dust.position.set(0.024, 0.012, -0.005);
  dust.add(part(boxG(0.005, 0.026, 0.074), MATS.anodized, 0.002, 0.013, 0));
  dust.add(part(boxG(0.004, 0.006, 0.010), MATS.steel, 0.003, 0.025, 0.030));
  g.add(dust);
  g.userData.dust = dust;

  /* ---- ボルト群（動く）。槓桿と、排莢口から覗くボルトキャリア */
  // 大面積で上を向く部品にsteel(金属度1.0)を使うと、白飛びした空のenvMapを
  // ほぼ全反射で返して、周囲の炭色から3〜4段明るい白い板が1枚浮く。
  // 俯瞰で銃の中で一番明るいのがこの板になっていたので、面の広い所はanodized/phosphateにして、
  // つまみの先端だけsteelを残す
  const bolt = new THREE.Group();
  bolt.add(part(cboxG(0.044, 0.009, 0.030), MATS.anodized, 0, 0.048, 0.062));
  bolt.add(part(cboxG(0.015, 0.009, 0.014), MATS.phosphate, -0.026, 0.048, 0.056));
  bolt.add(part(cboxG(0.010, 0.007, 0.016), MATS.phosphate, 0.026, 0.048, 0.056));
  bolt.add(part(boxG(0.004, 0.0045, 0.012), MATS.steel, -0.032, 0.048, 0.056));
  bolt.add(part(cylG(0.012, 0.012, 0.088, 12), MATS.phosphate, 0.006, 0.024, 0.010, Math.PI / 2));
  g.add(bolt);
  g.userData.bolt = bolt;
  g.userData.boltRest = 0;

  /* ---- 弾倉（動く）。口元を軸にしておくと抜く動きが自然に回る */
  // 弾倉はシルエット最大の塊。2段構成だと折れ線が2本の直線にしか見えず、
  // 曲率も底板の縁も読めない真っ黒な楔になる。4段に割って角度を刻み、
  // 段ごとに幅を絞ってテーパーを作る。面取りもここだけ太くして稜線に光を乗せる
  const mg = new THREE.Group();
  mg.position.set(0, -0.052, 0.033);
  const MAG = [
    [0.0340, 0.058, -0.020, 0.10],
    [0.0335, 0.057, -0.060, 0.20],
    [0.0325, 0.056, -0.100, 0.30],
    [0.0315, 0.055, -0.140, 0.40],
  ];
  for (const m of MAG) {
    mg.add(part(chamferBoxG(m[0], 0.044, m[1], MAG_CHAMFER), MATS.polymer,
      0, m[2], -m[2] * 0.21, m[3]));
  }
  // 底板は前後へ張り出したフランジにして明度の段を作る
  mg.add(part(chamferBoxG(0.040, 0.011, 0.070, 0.0030), MATS.polymerTan, 0, -0.170, 0.0357, 0.40));
  mg.add(part(boxG(0.030, 0.007, 0.060), MATS.polymer, 0, -0.161, 0.0338, 0.40));
  for (let i = 0; i < 4; i++) {
    const yy = -0.030 - i * 0.036;
    const zz = -yy * 0.21;
    const rr = 0.10 + i * 0.10;
    mg.add(part(boxG(0.036, 0.004, 0.010), MATS.polymer, 0, yy, zz - 0.019, rr));
    // 残弾確認窓。黒地に黒だと窓が消えるので真鍮にして点として読ませる
    mg.add(part(cylG(0.0048, 0.0048, 0.004, 10), MATS.brass, 0.0172, yy, zz, 0, 0, Math.PI / 2));
  }
  g.add(mg);
  g.userData.mag = mg;
  g.userData.magRest = [0, -0.052, 0.033];

  /* ---- 銃床。構えると目の後ろに来るのでADS中はまとめて消す */
  const rear = new THREE.Group();
  rear.add(part(cboxG(0.046, 0.058, 0.10), MATS.enamel, 0, -0.006, 0.100));
  rear.add(part(cylG(0.024, 0.024, 0.014, 12), MATS.phosphate, 0, 0.020, 0.062, Math.PI / 2));
  rear.add(part(cylG(0.019, 0.019, 0.200, 12), MATS.phosphate, 0, 0.020, 0.155, Math.PI / 2));
  rear.add(part(cboxG(0.044, 0.070, 0.115), MATS.polymer, 0, -0.002, 0.185));
  rear.add(part(cboxG(0.036, 0.016, 0.100), MATS.polymer, 0, 0.044, 0.190));
  rear.add(part(cboxG(0.010, 0.020, 0.016), MATS.enamel, 0.020, 0.008, 0.150));
  rear.add(part(cboxG(0.048, 0.088, 0.014), MATS.rubber, 0, -0.004, 0.252));
  for (let i = 0; i < 3; i++) {
    rear.add(part(boxG(0.050, 0.005, 0.005), MATS.rubber, 0, 0.024 - i * 0.024, 0.259));
  }
  g.add(rear);
  g.userData.rear = rear;

  // 光学の高さ。覗いた時の視線は接眼リム(内半径0.0195)から前へ広がる円錐で、
  // 光軸より下にある自分の部品はこの円錐に入ったぶんだけ像に写り込む。
  // 光軸を銃身芯から0.068mに置いていたので、レール上面の伏角が2.7〜4.5度＝
  // 接眼リムの張る角(5.97度)の内側に完全に入り、狙点の下半分が自分の銃と手で埋まっていた。
  // 高マウント相当の0.080mまで上げて、近側のレールと手を円錐の外へ出す。
  // マウントの箱は y-0.0165 まで下が伸びているので、上げてもレールを跨いだままになる。
  // adsPosはsightから逆算しているのでドットは中心に残る
  addOptic(g, 0.075, -0.020);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, R_BORE, -0.685);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0.042, 0.022, 0.010);
  g.add(eject);
  g.userData.eject = eject;

  /* ---- 手。右は握把、左は先台そのものを掴む。
     以前は先台の下に垂直グリップを立てて、そこを掴む姿勢にしていたが、
     手の芯が先台の芯から7cm下にあったため指が対象に一度も触れず、
     左手と先台の間から背景の地面が見えていた。
     掴む対象を先台に変え、手の芯を銃身の芯(R_BORE)へ合わせる。
     垂直グリップは廃して、掴む位置の前にハンドストップだけ残す */
  g.add(part(cboxG(0.026, 0.030, 0.026), MATS.polymer, 0, R_BORE - 0.036, -0.352, -0.45));

  // 手は機関部のシルエットの外へ少しはみ出させる。中に収めると指の関節が
  // 機関部と重なって輪郭が消え、手と銃が1つの塊に読める。
  // armDirはZ成分を大きくして、腕が「奥から手前」ではなく「画面下隅から手へ」入るようにする。
  // 袖は画面右下隅を通って外へ抜ければよく、長さは要らない（伸ばすと目に届く）
  const handR = buildHand(1, {
    gripR: 0.021, wrap: 0.50, trigger: true, armDir: [0.38, -0.62, 0.92], armLen: 0.62,
  });
  handR.position.set(0.008, -0.064, 0.114);
  handR.rotation.set(-0.30, 0, 0);
  g.add(handR);
  g.userData.handR = handR;

  // 手を90度倒すと握りの軸が銃身方向になる。gripRは先台の外接半径(0.031)に合わせる。
  // 細いと指が対象より内側に来て、掴んでいるのに輪が閉じない。
  // 手の芯は銃身芯から6mm下げる。指の弧が先台の天面より上へ出ると、
  // 上に載っている物（レール・光学）を貫通するうえ、ADSで開口の下側へ食い込む。
  // 下げても指の弧(0.0394)は先台の面(0.031+0.006=0.037)より外なので接地は保てる。
  // tipは末節の回り込み角の補正。太い先台では指先が側面を通り越して天面へ回るので詰める。
  // rollは握り軸まわりに手ごと起こす量。真横から握らせると指が全部裏側へ回って、
  // 画面には甲の塊しか出ず「筒が銃に刺さっている」ようにしか読めない。
  // 0.52で甲が左斜め上、指の付け根から第2関節までが手前の面、親指が天面を斜めに渡る。
  // 天面のレールは機関部側の73mmだけなので、この位置(z=-0.290)の指と親指は当たらない。
  // skewは指1本ずつの回り込み角の差。視線が指の並びと平行なので、
  // これが無いと4本が奥行き方向に重なって1枚の板に見える。
  // wristは手首の芯。既定値のままだと前腕が先台を貫通する（solve3.mjsで詰めた値）
  const handL = buildHand(-1, {
    gripR: 0.031, wrap: 0.62, tip: -0.34, roll: 0.52, skew: 0.22,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.78],
  });
  handL.position.set(0, R_BORE - 0.006, -0.290);
  handL.rotation.set(-Math.PI / 2 + 0.10, 0, 0.12);
  g.add(handL);
  g.userData.handL = handL;

  // 装填中に左手が辿る握り位置。位置と角度をセットで持たせる
  g.userData.holdL = {
    rest: [[0, R_BORE - 0.006, -0.290], [-Math.PI / 2 + 0.10, 0, 0.12]],
    mag: [[0.014, -0.150, 0.036], [0.30, 0.22, -0.20]],
    low: [[0.034, -0.300, 0.085], [0.55, 0.38, -0.30]],
    charge: [[0.006, 0.052, 0.028], [0.95, 0.05, 0.35]],
  };

  // 飾りは結合の前に足す。後からだと飾りの数だけ描画呼び出しが増える
  if (deco) deco(g);

  bakeStatic(rear);
  bakeStatic(bolt);
  bakeStatic(mg);
  bakeStatic(trg);
  bakeStatic(dust);
  bakeStatic(g);
  return g;
}

/* -------------------------------------------------- ライフルの形違い */

/* **銃そのものは組み直していない。** buildRifleに飾りを足す口を1つ開けて、
   そこへ部品を挿している。だから遊底も弾倉も引き金も元のまま動く
   （組み直すと、同じ名前の部品を全部用意し直す必要がある）。
   色は skins.js の over が別に塗り替える。

   **これはナイフの刀・ダガーとは作りが違う。** あちらは刃の輪郭そのものを
   描き直しているが、こちらは元の形へ足している。
   ライフルを一から組み直すと、動く部品の名前を揃える手間が丸ごと乗るため */

function dragonDeco(g) {
  /* ---- 背の棘。機関部の上から銃床にかけて、後ろへ寝かせて並べる。
     **前へ向けると角が生えているように見える。** 竜の背びれは後ろへ流れる */
  for (let i = 0; i < 6; i++) {
    const z = -0.150 + i * 0.062;
    const h = 0.052 - i * 0.005;          // 後ろへ行くほど低くする
    g.add(part(cylG(0, 0.011, h, 6), MATS.bone, 0, R_RAIL + h * 0.42, z, -0.62));
  }

  /* ---- 銃口の顎。上下から牙を寄せる。**閃光は牙の間から出る**
     （muzzleの印は動かしていないので、火は今まで通り芯から出る） */
  for (const s of [1, -1]) {
    g.add(part(cylG(0, 0.013, 0.062, 6), MATS.bone, 0, R_BORE + s * 0.030, -0.655, s * 0.30));
    g.add(part(cylG(0, 0.008, 0.040, 6), MATS.bone, s * 0.020, R_BORE + s * 0.018, -0.640, s * 0.22));
  }
  // 顎の付け根の鱗。銃身が骨から生えているように見せる
  g.add(part(cboxG(0.040, 0.044, 0.070), MATS.scale, 0, R_BORE, -0.612));

  /* ---- 鱗板。先台の側面に、前下がりに重ねる。
     等間隔で平らに並べると鎧の帯にしかならないので、少しずつ角度を変える */
  for (let i = 0; i < 4; i++) {
    const z = -0.520 + i * 0.072;
    for (const s of [1, -1]) {
      g.add(part(cboxG(0.006, 0.030, 0.062), MATS.scale,
        s * 0.026, R_BORE - 0.004, z, 0, 0, s * (0.22 + i * 0.05)));
    }
  }

  /* ---- 目。**2つだけ。** 光る物を増やすと、暗い場所で銃が提灯になる */
  for (const s of [1, -1]) {
    g.add(part(sphG(0.0075), MATS.ember, s * 0.026, R_BORE + 0.026, -0.235));
  }
  // 口の奥の熾火。牙の間から覗く。銃口の芯より少し奥に置いて、直接は見せない
  g.add(part(sphG(0.010), MATS.ember, 0, R_BORE, -0.628));
}

function cuteDeco(g) {
  /* ---- 猫耳。**これ1つで系統が決まる。** 機関部の上、左右に開いて立てる */
  for (const s of [1, -1]) {
    g.add(part(cylG(0, 0.019, 0.046, 4), MATS.candyPink,
      s * 0.017, R_RAIL + 0.020, -0.060, 0, s * 0.30, s * 0.34));
    // 耳の内側。一回り小さい物を前へずらして重ねる
    g.add(part(cylG(0, 0.011, 0.030, 4), MATS.candyCream,
      s * 0.017, R_RAIL + 0.016, -0.066, 0, s * 0.30, s * 0.34));
  }

  /* ---- 角を丸める。**尖った所に球を置くだけで印象が変わる。**
     形そのものを丸めるには全部の箱を作り直すことになるので、要所だけ */
  g.add(part(sphG(0.026), MATS.candyMint, 0, -0.004, 0.100));   // 銃床の後ろ
  g.add(part(sphG(0.018), MATS.candyMint, 0, R_BORE, -0.660));  // 銃口
  g.add(part(sphG(0.016), MATS.candyPink, 0, -0.030, -0.230));  // 用心金のあたり

  /* ---- 先台の縞。パステルを2色で交互に巻くと、単色の塊から抜ける */
  for (let i = 0; i < 5; i++) {
    const z = -0.540 + i * 0.070;
    g.add(part(cylG(0.031, 0.031, 0.030, 12), i % 2 ? MATS.candyMint : MATS.candyCream,
      0, R_BORE, z, Math.PI / 2));
  }

  /* ---- チャーム。**握把から下げる。** 揺れはしないが、
     銃に「持ち主が居る」感じを出しているのはこの1個 */
  const star = new THREE.Shape();
  for (let i = 0; i < 10; i++) {
    const a = (Math.PI / 5) * i - Math.PI / 2;
    const r = i % 2 ? 0.0085 : 0.019;
    if (i === 0) star.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else star.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  star.closePath();
  const starGeo = new THREE.ExtrudeGeometry(star, {
    depth: 0.005, bevelEnabled: true, bevelThickness: 0.0012, bevelSize: 0.0016, bevelSegments: 1,
  });
  starGeo.translate(0, 0, -0.0025);
  g.add(part(starGeo, MATS.charm, 0.030, -0.150, 0.052));
  /* 吊り紐。細い輪を2つ繋いで下げる。
     **星と材質を分けてある。** 同じにすると、押し出した星（索引なし）と
     輪（索引あり）が同じ束へ入って mergeGeometries が失敗する。
     bakeStaticは1つでも失敗すると**その群れ全部の結合を諦める**ので、
     ここを揃えていなかった時は面が47個から288個へ跳ねた（見た目は変わらないまま） */
  g.add(part(torG(0.006, 0.0016, 4, 10), MATS.brass, 0.030, -0.118, 0.052, Math.PI / 2));
  g.add(part(torG(0.006, 0.0016, 4, 10), MATS.brass, 0.030, -0.129, 0.052, Math.PI / 2));
}

const buildRifleDragon = (view = {}) => buildRifle(view, dragonDeco);
const buildRifleCute = (view = {}) => buildRifle(view, cuteDeco);

/* ------------------------------- ショットガン・狙撃銃・拳銃の形違い
 *
 * ライフルの2つ（ドラゴン・キャンディ）と同じ「元の形へ足す」やり方だが、
 * **こちらは動く部品と消える部品を避けて通る必要がある。**
 * ライフルの飾りは機関部・銃身・先台に付いていて、そこは全部動かない。
 *
 * 2026-08-11に実際に踏んだ形（先に読んで避けた分も含む）:
 *
 *   ・ショットガンの銃床は**構えると消える**（updateViewの `parts.rear.visible = t < 0.55`）。
 *     木の銃床を g へ足すと、覗いた瞬間に樹脂の銃床だけ消えて
 *     **木の殻が目の後ろに浮いたまま残る**
 *   ・ショットガンのポンプは発砲のたびに z へ0.075動く。
 *     木の先台を g へ足すと、銃だけ動いて木が置いていかれる
 *   ・狙撃銃の遊底も同じで、引くと本体だけ動く
 *
 * だから飾りの足し先は g ではなく **g.userData の中の群れ**にする。
 * どれも deco(g) を呼ぶ前に userData へ入っているので、そこから辿れる。
 *
 * 動く部品へ足すぶんは、その群れの bakeStatic に間に合う（deco が先に走る）。
 */

/* 材質を1つ増やすと描画呼び出しが1回増える。**群れごとに数えること。**
   同じ材質でも別の群れに置けば別の呼び出しになるので、
   「もう brass を使っているから0円」は g の中でしか成り立たない */
function westernDeco(g) {
  const rear = g.userData.rear;
  const pump = g.userData.pump;

  /* ---- 木の銃床。**rearの中へ入れる**（構えたら一緒に消えないといけない）。
     rear群は位置を持たない（原点にある）ので、中の座標はgと同じまま使える。
     元の樹脂の銃床を一回り大きい木で包む形にしてある。
     元を消さずに包むのは、消すと形を覚え直す必要が出るため */
  if (rear) {
    rear.add(part(cboxG(0.050, 0.100, 0.174), MATS.walnut, 0, -0.022, 0.230, 0.10));
    // 頬づけの背。ここだけ木目の向きが変わるので、板を分けて重ねる
    rear.add(part(cboxG(0.042, 0.022, 0.124), MATS.walnut, 0, 0.030, 0.220, 0.10));
    // 銃床の付け根の真鍮の帯。**木と機関部の継ぎ目を隠す役**でもある
    rear.add(part(cboxG(0.052, 0.066, 0.010), MATS.brass, 0, 0, 0.152));
    // 尻当て。既にある rubber を使う（材質を足すと呼び出しが1回増える）
    rear.add(part(cboxG(0.056, 0.108, 0.010), MATS.rubber, 0, -0.036, 0.318, 0.10));
  }

  /* ---- 木の先台。**pumpの中へ入れる**（前後に動く）。
     pump群は z=-0.280 に居るので、**中の座標は局所**になる。
     ここをgの座標で書くと、先台が銃の1つ前に飛ぶ */
  if (pump) {
    // 元の八角の樹脂を包む。角の向き(ry=PI/8)まで揃えないと角がずれて二重に見える
    pump.add(part(cylG(0.030, 0.030, 0.128, 8), MATS.walnut, 0, -0.008, 0, Math.PI / 2, Math.PI / 8));
    // 前後の口金。木の端が切り落としに見えるのを止める
    for (const z of [-0.064, 0.064]) {
      pump.add(part(cylG(0.032, 0.032, 0.009, 8), MATS.brass, 0, -0.008, z, Math.PI / 2, Math.PI / 8));
    }
  }

  /* ---- 機関部の彫金。**側面の板は2枚だけ。**
     ここは既に刻印(addStampX)が乗っているので、その外側へ薄く貼る */
  for (const s of [1, -1]) {
    g.add(part(boxG(0.002, 0.032, 0.074), MATS.engrave, s * 0.0262, 0.002, -0.020));
  }
  // 機関部の前の帯。銃身との継ぎ目に回す
  g.add(part(cboxG(0.054, 0.066, 0.012), MATS.engrave, 0, 0, -0.108));

  /* ---- 銃身の真鍮の輪。**放熱筒に隠れない所へ置く。**
     筒は z -0.530〜-0.300 を覆っているので、その外の2箇所だけ */
  g.add(part(torG(0.0250, 0.0030, 5, 14), MATS.engrave, 0, 0.022, -0.150));
  g.add(part(torG(0.0250, 0.0030, 5, 14), MATS.engrave, 0, 0.022, -0.548));
}

/* ショットガンのサメ。**ウエスタンと系統を正面から分ける**（手入れされた木と真鍮 ↔ 生き物）。
 *
 * **一番気を付けたのは照準線。** この銃はゴーストリング(z=0.100)から
 * 銃口のビード(z=-0.548)へ、高さ SY=0.054 で線が通っている。
 * 背鰭を立てたくなる所が全部その線の上なので、**鰭は線の下に収める。**
 * 頂点を0.050で止めてあるのはそのため（それ以上上げると覗いた時にビードが消える）。
 *
 * 動く部品と消える部品の扱いはウエスタンと同じ（westernDecoの上のコメント参照）。
 * 尾鰭だけは銃床(rear)へ入れる——構えると消えるが、
 * **あれは目の後ろに来る部品なので、消えて正しい。**
 */
function sharkDeco(g) {
  const rear = g.userData.rear;
  const B = 0.022;   // 銃身の芯（buildShotgunと同じ値）

  /* ---- 銃口の顎と歯。**上顎は y=0.044 で止める**（照準線が0.054）。
     歯は内側へ向ける。外へ向けると牙が生えているだけで、噛む口に見えない */
  for (const s of [1, -1]) {
    // 顎の板
    g.add(part(cboxG(0.046, 0.010, 0.058), MATS.anodized, 0, B + s * 0.020, -0.556, s * 0.16));
    // 歯。4本ずつ。**上は下向き(rx=π)、下は上向き**
    for (let i = 0; i < 4; i++) {
      const x = -0.0165 + i * 0.011;
      g.add(part(cylG(0, 0.0042, 0.016, 5), MATS.bone,
        x, B + s * 0.014, -0.556, s > 0 ? Math.PI : 0));
    }
  }

  /* ---- 鰓の切れ込み。機関部の側面に3本ずつ、斜めに入れる。
     **垂直に入れると滑り止めの溝に見える**ので、必ず傾ける */
  for (const s of [1, -1]) {
    for (let i = 0; i < 3; i++) {
      g.add(part(boxG(0.002, 0.032, 0.005), MATS.enamel,
        s * 0.0258, 0.000, -0.060 + i * 0.018, 0, 0, 0.30));
    }
  }

  /* ---- 背鰭。**照準線の下に収める。**
     銃身の上(y=0.039)から0.054(SY)までの0.015しか使えないので、低く広い鰭にする。
     放熱筒(z -0.530〜-0.300)に隠れない所へ置く。

     **回転を入れないこと。** 最初 rz=π/2 を入れて円錐を横に倒したら、
     半径0.024がYへ効いて頂点が0.068まで伸び、**照準線を塞いだ**
     （測って気づいた。tools/check-scope.mjsの[2.6]がそこを見張る）。
     cylG(0, r, h, 3) は回さなければ「上を向いた三角錐」で、高さがhに収まる */
  g.add(part(cylG(0, 0.018, 0.010, 3), MATS.anodized, 0, 0.042, -0.200));
  // 胸鰭。機関部の下、左右へ張り出す。ここは高さの制約が無い
  for (const s of [1, -1]) {
    g.add(part(cboxG(0.030, 0.005, 0.038), MATS.anodized,
      s * 0.030, -0.026, -0.030, 0, 0, s * 0.34));
  }

  /* ---- 腹の白。**下から見た時に別の色であること**が鮫の塗り分けの要。
     弾倉チューブの下(y=-0.010)と機関部の下(y=-0.032)へ板を貼る */
  g.add(part(cboxG(0.026, 0.006, 0.300), MATS.sharkBelly, 0, -0.020, -0.300));
  g.add(part(cboxG(0.042, 0.006, 0.170), MATS.sharkBelly, 0, -0.034, -0.020));

  /* ---- 尾鰭。**銃床へ入れる**（構えると一緒に消える。目の後ろの部品なので正しい）。
     上下に開いた二股。鮫の尾は上が長い */
  if (rear) {
    rear.add(part(cboxG(0.006, 0.070, 0.046), MATS.anodized, 0, 0.036, 0.318, 0.34));
    rear.add(part(cboxG(0.006, 0.048, 0.038), MATS.anodized, 0, -0.038, 0.316, -0.30));
  }
}

/* 狙撃銃のアイス。
 *
 * **一番気を付けたのは望遠照準の視界。** この銃は覗いて撃つ道具なので、
 * 狙点のまわりに物を置くと、当たる所が見えなくなる。
 * 機関部の上（レールの高さ0.042〜照準の光軸0.072の間）は空けたままにして、
 * 棘は**照準より前の銃身**と、横へ逃がしてある。
 * 塞いだかどうかは tools/check-scope.mjs が素通しの角度で測る（3.0度が今の値）。
 */
function iceDeco(g) {
  const rear = g.userData.rear;

  /* ---- 先台を霜の鞘で包む。**この銃で一番広い面がここ。**
     高さを0.050に抑えてあるのは、天面のレール(y=0.042)を飲み込まないため。
     飲み込むと金属の直線が消えて、樹脂の台に戻る */
  g.add(part(cboxG(0.054, 0.050, 0.294), MATS.frost, 0, 0.015, -0.300));
  // 底の板。伏せ撃ちの台なので、下から見た時も氷であってほしい
  g.add(part(cboxG(0.042, 0.010, 0.284), MATS.frost, 0, -0.012, -0.300));

  /* ---- 機関部の天板を氷の芯に差し替える（元は残したまま上へ重ねる）。
     照準の光軸(0.072)より十分下なので、視界には入らない */
  g.add(part(cboxG(0.046, 0.010, 0.256), MATS.glacier, 0, 0.041, -0.020));

  /* ---- 霜の結晶。**銃身のまわりに輪状に生やす。**
     1方向へ揃えると角が生えているように見えるので、
     6方向へ回して「凍り付いた」に見せる（竜の背びれと逆の考え方） */
  for (const [z, len] of [[-0.470, 0.030], [-0.560, 0.036], [-0.660, 0.028]]) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      g.add(part(cylG(0, 0.0055, len, 5), MATS.icicle,
        Math.cos(a) * 0.016, S_BORE + Math.sin(a) * 0.016, z, 0, 0, a - Math.PI / 2));
    }
  }

  /* ---- 氷輪。銃身に2本。**結晶の輪の間に置く**と、
     生えている所と巻いている所が交互になって密度が出る */
  g.add(part(torG(0.020, 0.0050, 5, 16), MATS.icicle, 0, S_BORE, -0.515));
  g.add(part(torG(0.020, 0.0050, 5, 16), MATS.icicle, 0, S_BORE, -0.610));

  /* ---- 銃口から垂れる氷柱。**下向きにするので rx へ π を入れる。**
     cylG(0, r, h) は先が上を向いた円錐なので、そのままだと角になる */
  for (const [x, z, len] of [[0, -0.780, 0.038], [0.010, -0.745, 0.026], [-0.011, -0.760, 0.030]]) {
    g.add(part(cylG(0, 0.0048, len, 5), MATS.icicle, x, S_BORE - 0.016 - len * 0.4, z, Math.PI));
  }

  /* ---- 銃床。**rearの中へ入れる**（構えると一緒に消えないといけない）。
     頬当ては顔が当たる所なので、氷で包むと持ち主の性格が出る */
  if (rear) {
    rear.add(part(cboxG(0.044, 0.028, 0.114), MATS.frost, 0, 0.056, 0.230));
    rear.add(part(cboxG(0.042, 0.020, 0.154), MATS.frost, 0, -0.034, 0.236, 0.10));
    rear.add(part(cboxG(0.046, 0.084, 0.014), MATS.glacier, 0, -0.004, 0.318));
  }
}

/* 拳銃のサイバー。
 *
 * **この銃は塗り替えが届く面が12.6%しかない**（画面の6割が手と袖で、
 * スキンはそこを触らないため）。だから色を変えても届かないので、
 * **面積が小さくても目に入る「光」で作る。**
 *
 * 動く群れは持っていない（遊底も弾倉も1つの塊に含まれている）ので、
 * 飾りは全部 g へ足してよい。ショットガンと狙撃銃とはそこが違う。
 *
 * **照準線を塞がないこと。** 後ろの照門(z=0.026)から前の照星(z=-0.128)へ
 * 線が通っていないと、覗いた時に狙点が読めない。
 * だから天面には何も足さず、光は側面と下に回してある。
 */
function cyberDeco(g) {
  const SY = P_BORE + 0.008;   // 光の線を通す高さ。スライドの中ほど

  /* ---- 回路の線。**側面に段を付けて通す。**
     真っ直ぐ1本引くと蛍光テープに見えるので、
     途中で高さを変えて「基板の配線」の形にする */
  for (const s of [1, -1]) {
    g.add(part(boxG(0.001, 0.0022, 0.062), MATS.circuit, s * 0.0153, SY, -0.086));
    g.add(part(boxG(0.001, 0.0130, 0.0022), MATS.circuit, s * 0.0153, SY + 0.005, -0.055));
    g.add(part(boxG(0.001, 0.0022, 0.040), MATS.circuit, s * 0.0153, SY + 0.011, -0.036));
    // 分岐。1本だけ下へ落として、握把の方へ流す
    g.add(part(boxG(0.001, 0.0022, 0.022), MATS.circuit, s * 0.0135, -0.004, -0.070));
  }

  /* ---- 表示窓。**片側だけ。** 両側に付けると計器の箱に見えて、
     銃の側面という感じが消える。左（排莢口の無い側）へ置く */
  g.add(part(boxG(0.0012, 0.0090, 0.0180), MATS.circuit, -0.0154, SY + 0.004, 0.006));
  // 窓の枠。光の縁を暗い金属で締めると、貼り付けた板ではなく埋め込みに見える
  g.add(part(cboxG(0.0022, 0.0130, 0.0220), MATS.cyberShell, -0.0150, SY + 0.004, 0.006));

  /* ---- 放熱の羽。**フレームの側面に立てる。**
     天面へ付けると照準線を跨ぐので置けない（この銃で一番の制約） */
  for (const s of [1, -1]) {
    for (let i = 0; i < 3; i++) {
      const z = -0.092 + i * 0.020;
      g.add(part(boxG(0.005, 0.016, 0.0035), MATS.heatFin, s * 0.0145, -0.006, z));
    }
  }
  // 銃身の下の放熱の塊。銃身が浮いて見えるのを止める覆いの上へ重ねる
  g.add(part(cboxG(0.024, 0.012, 0.058), MATS.cyberShell, 0, -0.006, -0.096));
  // その底に細い光を1本。下から見上げた時にここだけ光る
  g.add(part(boxG(0.010, 0.0018, 0.046), MATS.circuit, 0, -0.013, -0.096));

  /* ---- 握把の光。**握った手の指の間から漏れる位置**に置く。
     手で完全に隠れる所へ置くと、点けた意味が無くなる */
  g.add(part(boxG(0.0012, 0.0026, 0.030), MATS.circuit, 0.0148, -0.044, 0.030, P_GRIP_TILT));
  g.add(part(boxG(0.0012, 0.0026, 0.030), MATS.circuit, -0.0148, -0.044, 0.030, P_GRIP_TILT));

  /* ---- スライド後端の小さな筐体。**照門より低く抑える。**
     照門の天面が y=P_BORE+0.0255 なので、そこへ届かない高さで止める */
  g.add(part(cboxG(0.020, 0.008, 0.026), MATS.cyberShell, 0, P_BORE + 0.014, 0.020));
  g.add(part(sphG(0.0030), MATS.circuit, 0, P_BORE + 0.019, 0.031));
}

/* 拳銃のクローム。**サイバーと系統を正面から分ける**（黒と青緑の光 ↔ 磨いた銀と象牙）。
 *
 * **光らせない。** サイバーが「光」で解いた所を、こちらは「明るさ」で解く。
 * ボーン（2026-08-11に消した物）は同じ縛りで明暗差だけに頼って地味になったので、
 * **地そのものを明るい銀にして**、暗い背景から浮く形にしてある
 * （アイスが狙撃銃で効いたのと同じ理屈。品揃えで唯一の明るい拳銃）。
 *
 * 動く群れは持っていないので飾りは全部 g へ足してよい（cyberDecoと同じ）。
 *
 * **照準線を塞がないこと。** 後ろの照門(z=0.026)から前の照星(z=-0.128)へ
 * 線が通っていないと覗いた時に狙点が読めない。
 * 照門の天面が y=P_BORE+0.0255 なので、天面へ足す物はそこへ届かせない。
 */
function chromeDeco(g) {
  /* ---- 象牙の握把板。**この2枚で系統が決まる。**
     握把の側面に貼る。傾き(P_GRIP_TILT)を合わせないと板だけ浮く */
  for (const s of [1, -1]) {
    g.add(part(cboxG(0.004, 0.070, 0.032), MATS.ivory, s * 0.0152, -0.062, 0.036, P_GRIP_TILT));
    // 板の留めネジ。**2つだけ。**貼り付けた板ではなく組み付けた板に見える
    for (const y of [-0.046, -0.080]) {
      g.add(part(cylG(0.0026, 0.0026, 0.004, 6), MATS.brass,
        s * 0.0172, y, 0.036, 0, 0, Math.PI / 2));
    }
  }

  /* ---- 銃身の刻み。スライドの側面に細い溝を並べる。
     **鏡面は情報が無いと「のべつまくなしの銀の板」に見える**ので、
     光の当たる線を作るために刻みを入れる（彫金の代わり） */
  for (const s of [1, -1]) {
    for (let i = 0; i < 5; i++) {
      const z = -0.110 + i * 0.018;
      g.add(part(boxG(0.002, 0.014, 0.004), MATS.chrome, s * 0.0152, P_BORE + 0.002, z));
    }
  }
  // 銃口の環。磨いた縁が一番光る所
  g.add(part(torG(0.0092, 0.0018, 5, 16), MATS.chrome, 0, P_BORE, -0.150));

  /* ---- 銃尾の飾り環。**照門より低く止める。**
     照門の天面が y=P_BORE+0.0255 なので、環の頂点をそこへ届かせない */
  g.add(part(torG(0.0088, 0.0022, 5, 16), MATS.chrome, 0, P_BORE + 0.006, 0.034));

  /* ---- 撃鉄と安全子。**金は2個だけ。**
     銀一色だと単調になるが、増やすとゴールドと紛らわしくなる */
  g.add(part(cboxG(0.006, 0.012, 0.008), MATS.brass, 0, P_BORE + 0.012, 0.040));
  g.add(part(cylG(0.0034, 0.0034, 0.006, 8), MATS.brass, -0.0158, -0.004, 0.014, 0, 0, Math.PI / 2));

  /* ---- 弾倉の底板。握把の下端。**下から見上げた時にここが見える** */
  g.add(part(cboxG(0.034, 0.006, 0.048), MATS.ivory, 0, -0.106, 0.049, P_GRIP_TILT));
}

/* 狙撃銃のヴェノム。**アイスと系統を分ける**（白と氷 ↔ 黄緑と黒）。
   望遠照準の視界を塞がないのはアイスと同じ制約で、
   機関部の上（レール0.042〜光軸0.072の間）は空けたまま、棘と鱗は横と前へ逃がす */
function venomDeco(g) {
  const rear = g.userData.rear;

  /* ---- 先台の側面に鱗板を重ねる。**前下がりに角度を変えながら**並べる
     （等間隔で平らに並べると鎧の帯にしかならない。ドラゴンで学んだ所）*/
  for (let i = 0; i < 5; i++) {
    const z = -0.410 + i * 0.058;
    for (const s of [1, -1]) {
      g.add(part(cboxG(0.006, 0.030, 0.052), MATS.venomScale,
        s * 0.0268, S_BORE - 0.006, z, 0, 0, s * (0.18 + i * 0.04)));
    }
  }
  // 天面にも1列。**レールより低く**置く（0.042より上へ出すと照準が塞がる）
  for (let i = 0; i < 3; i++) {
    g.add(part(cboxG(0.036, 0.005, 0.044), MATS.venomScale, 0, 0.036, -0.360 + i * 0.062));
  }

  /* ---- 銃口の牙。**上下から寄せる。**骨はドラゴンの物を使い回す */
  for (const s of [1, -1]) {
    g.add(part(cylG(0, 0.0105, 0.052, 6), MATS.bone, 0, S_BORE + s * 0.026, -0.842, s * 0.34));
  }
  // 制退器の付け根に鱗。銃身が蛇の口から出ているように見せる
  g.add(part(cboxG(0.040, 0.042, 0.030), MATS.venomScale, 0, S_BORE, -0.786));

  /* ---- 蛇の目。**機関部の側面に。**上に置くと照準の視界へ入る。
     2つだけ（光る物を増やすと暗い場所で提灯になる。ドラゴンと同じ理由）*/
  for (const s of [1, -1]) {
    g.add(part(sphG(0.0070), MATS.venomGlow, s * 0.0262, 0.014, -0.100));
  }
  /* ---- 毒の滴。銃身の下に3つ、下向きに垂らす。
     cylG(0, r, h) は先が上を向いた円錐なので rx へ π を入れる */
  for (const [z, len] of [[-0.520, 0.026], [-0.610, 0.034], [-0.700, 0.022]]) {
    g.add(part(cylG(0, 0.0042, len, 5), MATS.venomGlow, 0, S_BORE - 0.016 - len * 0.4, z, Math.PI));
  }

  // 銃床。頬当てを鱗で覆う（rearの中へ。構えたら一緒に消える）
  if (rear) {
    rear.add(part(cboxG(0.042, 0.026, 0.106), MATS.venomScale, 0, 0.056, 0.230));
    rear.add(part(cboxG(0.040, 0.018, 0.146), MATS.venomScale, 0, -0.034, 0.236, 0.10));
  }
}

/* ------------------------------------------------------------ ショットガン */

/**
 * @param _view 縮尺や構えの設定。**この銃は読まないが、位置は空けておく必要がある。**
 *              呼ぶ側（WEAPONSとSHAPE_BUILDS）が build(view, deco) の順で渡すので、
 *              ここを詰めると deco が view の場所へ入る。頭の `_` は
 *              「受けるが使わない」の印（eslintもその名前だけ見逃す）
 * @param deco 形違いのスキンが飾りを足す口。**bakeStaticの前に呼ぶ。**
 *             ライフルと同じ約束で、元の部品は1つも触らない
 */
function buildShotgun(_view = {}, deco = null) {
  const g = new THREE.Group();
  const B = 0.022;           // 銃身の芯
  // 照準線の高さ。放熱筒の頂点(0.047)より上に通さないと、覗いた時に
  // 筒が邪魔をして先の照星が見えなくなる
  const SY = 0.054;

  /* ---- 機関部。上面に照星をつなぐリブを通して平らな箱をやめる */
  g.add(part(cboxG(0.050, 0.062, 0.190), MATS.phosphate, 0, 0.000, -0.020));
  g.add(part(cboxG(0.044, 0.014, 0.190), MATS.phosphate, 0, 0.034, -0.020));
  g.add(part(cboxG(0.016, 0.008, 0.230), MATS.phosphate, 0, 0.041, -0.070));
  addStampX(g, 0.0255, -0.006, -0.020, 0.040, 0.020, 4);
  addStampX(g, -0.0255, -0.006, -0.020, 0.040, 0.020, 4);
  // 排莢口とローディングポート
  g.add(part(boxG(0.006, 0.026, 0.062), MATS.enamel, 0.024, 0.006, -0.010));
  g.add(part(boxG(0.030, 0.006, 0.058), MATS.enamel, 0, -0.030, -0.005));
  // 安全子
  g.add(part(cylG(0.0055, 0.0055, 0.026, 10), MATS.steel, 0, -0.024, 0.060, 0, 0, Math.PI / 2));
  addSlingLoop(g, -0.026, 0.006, 0.086);

  /* ---- 銃身・放熱筒・弾倉チューブ */
  // 銃身と弾倉チューブは先台の外に出ている長い円筒。分割を上げて輪郭の折れを消す
  g.add(part(cylG(0.0165, 0.0165, 0.460, 20), MATS.phosphate, 0, B, -0.340, Math.PI / 2));
  g.add(part(cylG(0.0125, 0.0125, 0.380, 18), MATS.steel, 0, -0.010, -0.300, Math.PI / 2));
  g.add(part(cylG(0.0135, 0.0135, 0.016, 18), MATS.phosphate, 0, -0.010, -0.494, Math.PI / 2));
  // 放熱筒。八角の外皮に穴を並べると銃身が一気に「装備」らしくなる
  g.add(part(cylG(0.0245, 0.0245, 0.230, 8, true), MATS.phosphate, 0, B, -0.415, Math.PI / 2, Math.PI / 8));
  for (let i = 0; i < 5; i++) {
    const z = -0.330 - i * 0.040;
    addVentX(g, 0.0232, B, z, 0.0055);
    addVentX(g, -0.0232, B, z, 0.0055);
  }
  for (const z of [-0.305, -0.525]) {
    g.add(part(torG(0.0248, 0.0026, 5, 14), MATS.steel, 0, B, z));
  }

  /* ---- 照門と照星。ゴーストリングと真鍮のビーズ。
     土台は必ず照準線より下で止める。少しでも上へ出すと視線を塞ぐ */
  g.add(part(cboxG(0.032, 0.008, 0.026), MATS.phosphate, 0, 0.020, 0.100));
  g.add(part(cboxG(0.024, 0.018, 0.022), MATS.phosphate, 0, 0.026, 0.100));
  // 輪は撃ち手の方を向ける。横に倒すと輪の胴が視線を横切って穴が塞がる
  g.add(part(torG(0.020, 0.0028, 6, 16), MATS.steel, 0, SY, 0.100));
  g.add(part(boxG(0.014, 0.014, 0.010), MATS.phosphate, 0, 0.031, -0.548));
  g.add(part(boxG(0.006, 0.022, 0.008), MATS.phosphate, 0, 0.040, -0.548));
  g.add(part(sphG(0.0042), MATS.brass, 0, SY, -0.548));

  /* ---- 側面のシェルホルダー。暗い銃に赤が入って画が締まる */
  for (let i = 0; i < 4; i++) {
    const z = 0.030 - i * 0.030;
    g.add(part(cylG(0.0098, 0.0098, 0.052, 10), MATS.shell, -0.033, -0.004, z, Math.PI / 2));
    g.add(part(cylG(0.0104, 0.0104, 0.014, 10), MATS.brass, -0.033, -0.004, z + 0.024, Math.PI / 2));
  }
  g.add(part(boxG(0.005, 0.030, 0.126), MATS.strap, -0.026, -0.004, -0.005));

  /* ---- 握把と用心鉄 */
  g.add(part(cboxG(0.038, 0.100, 0.036), MATS.polymer, 0, -0.086, 0.128, -0.30));
  g.add(part(boxG(0.032, 0.088, 0.008), MATS.rubber, 0, -0.084, 0.148, -0.30));
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.005, 0.005, 0.036, 8), MATS.polymer,
      0, -0.062 - i * 0.024, 0.108 + i * 0.008, 0, 0, Math.PI / 2));
  }
  g.add(part(cboxG(0.040, 0.011, 0.038), MATS.polymer, 0, -0.134, 0.117, -0.30));
  g.add(part(torG(0.021, 0.0038, 6, 16, Math.PI), MATS.phosphate,
    0, -0.040, 0.080, 0, Math.PI / 2, Math.PI));

  const trg = new THREE.Group();
  trg.position.set(0, -0.028, 0.090);
  trg.add(part(boxG(0.008, 0.026, 0.008), MATS.steel, 0, -0.013, -0.004, 0.2));
  g.add(trg);
  g.userData.trigger = trg;

  /* ---- ポンプ（動く）。滑り止めの溝を彫って握る場所だと分かるようにする */
  const pump = new THREE.Group();
  pump.position.set(0, 0, -0.280);
  pump.add(part(cylG(0.027, 0.027, 0.132, 8), MATS.polymer, 0, -0.008, 0, Math.PI / 2, Math.PI / 8));
  pump.add(part(cylG(0.029, 0.029, 0.010, 8), MATS.polymer, 0, -0.008, -0.062, Math.PI / 2, Math.PI / 8));
  pump.add(part(cylG(0.029, 0.029, 0.010, 8), MATS.polymer, 0, -0.008, 0.062, Math.PI / 2, Math.PI / 8));
  for (let i = 0; i < 6; i++) {
    const z = -0.042 + i * 0.017;
    pump.add(part(boxG(0.046, 0.005, 0.008), MATS.polymer, 0, -0.033, z));
    pump.add(part(boxG(0.008, 0.042, 0.008), MATS.polymer, 0.023, -0.008, z));
    pump.add(part(boxG(0.008, 0.042, 0.008), MATS.polymer, -0.023, -0.008, z));
  }
  g.add(pump);
  g.userData.pump = pump;
  g.userData.pumpRest = -0.280;

  /* ---- 装填用のシェル1発（動く）。同じ物を出し入れして4発装填を見せる */
  const shell = new THREE.Group();
  shell.add(part(cylG(0.0098, 0.0098, 0.050, 10), MATS.shell, 0, 0, 0, Math.PI / 2));
  shell.add(part(cylG(0.0104, 0.0104, 0.014, 10), MATS.brass, 0, 0, 0.024, Math.PI / 2));
  shell.visible = false;
  g.add(shell);
  g.userData.shell = shell;

  /* ---- 銃床。木ではなく樹脂の実用品にしてライフルと質感を変える */
  const rear = new THREE.Group();
  rear.add(part(cboxG(0.050, 0.062, 0.080), MATS.phosphate, 0, 0, 0.115));
  rear.add(part(cboxG(0.046, 0.096, 0.170), MATS.polymer, 0, -0.022, 0.230, 0.10));
  rear.add(part(cboxG(0.038, 0.018, 0.120), MATS.polymer, 0, 0.030, 0.220, 0.10));
  rear.add(part(cboxG(0.010, 0.020, 0.014), MATS.enamel, 0.022, 0.006, 0.180));
  rear.add(part(cboxG(0.052, 0.104, 0.016), MATS.rubber, 0, -0.036, 0.310, 0.10));
  for (let i = 0; i < 3; i++) {
    rear.add(part(boxG(0.054, 0.005, 0.006), MATS.rubber, 0, -0.006 - i * 0.028, 0.316));
  }
  g.add(rear);
  g.userData.rear = rear;

  // この銃はドット無しなので、照門の位置を照準の基準にする
  const sight = new THREE.Object3D();
  sight.position.set(0, SY, 0.100);
  g.add(sight);
  g.userData.sight = sight;

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, B, -0.578);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0.042, 0.010, -0.010);
  g.add(eject);
  g.userData.eject = eject;

  /* ---- 手。左はポンプを掴むので、毎フレームポンプの前後量を足してやる */
  const handR = buildHand(1, {
    gripR: 0.022, wrap: 0.50, trigger: true, armDir: [0.38, -0.62, 0.94], armLen: 0.62,
  });
  handR.position.set(0.008, -0.060, 0.116);
  handR.rotation.set(-0.30, 0, 0);
  g.add(handR);
  g.userData.handR = handR;

  // ポンプにはレールが載っていないので回り込みは残せるが、
  // 指先が天面で合わさると溝の彫りを潰すので少しだけ詰める。
  // rollを書き忘れていて0のままだったので、この銃だけ指の付け根の列が
  // 甲の裏側へ回り、こちらの面には丸い甲と親指しか出ていなかった。
  // ポンプ(半径27mm)は先台(31mm)とSMG(26mm)の中間なので、0.52と0.46の間で取る。
  // 天面には銃身が通っているが、甲の外面(rr+14.5mm)でも銃身の外周より2mm外を通る
  const handL = buildHand(-1, {
    gripR: 0.027, wrap: 0.70, tip: -0.18, roll: 0.48, skew: 0.22,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.80],
  });
  handL.position.set(0, -0.010, -0.280);
  handL.rotation.set(-Math.PI / 2 + 0.08, 0, 0.10);
  g.add(handL);
  g.userData.handL = handL;

  g.userData.holdL = {
    rest: [[0, -0.010, -0.280], [-Math.PI / 2 + 0.08, 0, 0.10]],
    // 装填口は機関部の下。ここへシェルを押し込む
    mag: [[0.020, -0.090, -0.010], [0.10, 0.30, -0.45]],
    low: [[0.045, -0.250, 0.060], [0.45, 0.40, -0.40]],
    charge: [[0, -0.010, -0.280], [-Math.PI / 2 + 0.08, 0, 0.10]],
  };

  // 飾りは結合の前に足す。後からだと飾りの数だけ描画呼び出しが増える
  if (deco) deco(g);

  bakeStatic(rear);
  bakeStatic(pump);
  bakeStatic(trg);
  bakeStatic(shell);
  bakeStatic(g);
  return g;
}

/* ------------------------------------------------------------ 狙撃銃 */

// 銃身の芯。ライフルより1mm低い（この銃は機関部が厚いので、
// 同じ高さにすると先台が握れる太さに収まらない）
const S_BORE = 0.020;

/* 手動で1発ずつ送り出す銃。ライフルとの違いは長さと太さで作る。
   **同じ形を細長くしただけにしない。** 遠くから見ても別物と分かるように、
   ・銃身を露出させて太くする（ライフルは先台の中に隠れている）
   ・先台を筒ではなく角張った台にする（伏せて撃つ道具に見せる）
   ・銃床に頬当てを立てる（覗く姿勢の銃であることが形から読める）
   の3つを効かせる */
/**
 * @param _view 縮尺や構えの設定。この銃は読まないが、
 *              build(view, deco) の順を崩せないので位置だけ空けてある（buildShotgunと同じ）
 * @param deco 形違いのスキンが飾りを足す口。**bakeStaticの前に呼ぶ**
 */
function buildSniper(_view = {}, deco = null) {
  const g = new THREE.Group();

  /* ---- 機関部。ライフルより背が高く、上面を厚い台にする */
  g.add(part(cboxG(0.050, 0.056, 0.260), MATS.enamel, 0, 0.006, -0.020));
  g.add(part(cboxG(0.044, 0.012, 0.260), MATS.anodized, 0, 0.038, -0.020));
  g.add(part(cboxG(0.048, 0.020, 0.052), MATS.anodized, 0, 0.030, 0.086));
  addRail(g, 0.045, -0.140, 0.060, 0.024);
  addStampX(g, 0.0255, -0.004, -0.050, 0.044, 0.020, 4);
  addStampX(g, -0.0255, -0.004, -0.050, 0.044, 0.020, 4);
  // 機関部と銃身の継ぎ目（バレルナット）
  g.add(part(cylG(0.030, 0.030, 0.026, 14), MATS.steel, 0, S_BORE, -0.158, Math.PI / 2));
  g.add(part(cylG(0.032, 0.032, 0.006, 14), MATS.phosphate, 0, S_BORE, -0.144, Math.PI / 2));

  /* ---- 排莢口。手動で送るので、ライフルのような排莢口カバーは付かない */
  g.add(part(boxG(0.005, 0.026, 0.070), MATS.enamel, 0.023, 0.022, 0.020));
  g.add(part(cboxG(0.014, 0.026, 0.030), MATS.anodized, 0.026, 0.030, 0.062, 0, 0, 0.30));

  /* ---- 操作部 */
  g.add(part(boxG(0.006, 0.020, 0.030), MATS.anodized, -0.026, -0.006, 0.030));
  g.add(part(cylG(0.0058, 0.0058, 0.010, 10), MATS.steel, -0.030, -0.006, 0.030, 0, 0, Math.PI / 2));
  addSlingLoop(g, -0.026, 0.000, 0.098);
  addScrewX(g, 0.024, -0.012, -0.110);
  addScrewX(g, -0.024, -0.012, -0.110);

  /* ---- 先台。角張った台にする。伏せ撃ちの道具に見せたいので、
     ライフルの八角筒ではなく、底が平らな箱を主にして角を立てる */
  g.add(part(cboxG(0.050, 0.048, 0.290), MATS.polymerTan, 0, S_BORE - 0.004, -0.300));
  g.add(part(cboxG(0.038, 0.014, 0.280), MATS.polymerTan, 0, S_BORE - 0.030, -0.300));
  // 天面のレール（前半分）。載せる物のためではなく、金属の直線を1本通して
  // 樹脂の台が「ただの塊」に見えないようにするため
  addRail(g, S_BORE + 0.022, -0.400, -0.170, 0.022);
  // M-LOKの長穴。側面と底面に彫り込む
  for (let i = 0; i < 4; i++) {
    const z = -0.200 - i * 0.052;
    g.add(part(boxG(0.052, 0.004, 0.030), MATS.enamel, 0, S_BORE - 0.026, z));
    addVentX(g, 0.0252, S_BORE - 0.002, z, 0.0055);
    addVentX(g, -0.0252, S_BORE - 0.002, z, 0.0055);
  }
  addSlingLoop(g, -0.028, S_BORE - 0.022, -0.420, 0.0075);
  // 手が止まる出っ張り。掴む位置がここだと形で分かる
  g.add(part(cboxG(0.028, 0.026, 0.024), MATS.polymer, 0, S_BORE - 0.038, -0.360, -0.45));

  /* ---- 銃身。**露出した太い円筒がこの銃の顔になる。**
     溝(フルート)を彫って、単なる棒に見えないようにする */
  g.add(part(cylG(0.0155, 0.0155, 0.400, 20), MATS.phosphate, 0, S_BORE, -0.590, Math.PI / 2));
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    g.add(part(boxG(0.0055, 0.0055, 0.230), MATS.enamel,
      Math.cos(a) * 0.0150, S_BORE + Math.sin(a) * 0.0150, -0.610, 0, 0, a));
  }
  g.add(part(torG(0.0165, 0.0026, 5, 20), MATS.steel, 0, S_BORE, -0.420));
  g.add(part(torG(0.0158, 0.0022, 5, 20), MATS.steel, 0, S_BORE, -0.760));
  // 制退器。横穴を開けて、真横から見た時のシルエットに情報を足す
  g.add(part(cylG(0.0215, 0.0205, 0.062, 20), MATS.steel, 0, S_BORE, -0.808, Math.PI / 2));
  for (let i = 0; i < 3; i++) {
    const z = -0.792 - i * 0.016;
    g.add(part(boxG(0.048, 0.009, 0.008), MATS.enamel, 0, S_BORE + 0.010, z));
    g.add(part(boxG(0.048, 0.009, 0.008), MATS.enamel, 0, S_BORE - 0.010, z));
  }
  g.add(part(torG(0.0210, 0.0026, 5, 20), MATS.phosphate, 0, S_BORE, -0.836));

  /* ---- 握把と用心鉄。垂直に近い狙撃用の握り */
  g.add(part(cboxG(0.036, 0.104, 0.038), MATS.polymer, 0, -0.092, 0.132, -0.16));
  g.add(part(boxG(0.030, 0.090, 0.008), MATS.rubber, 0, -0.090, 0.153, -0.16));
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.005, 0.005, 0.034, 8), MATS.polymer,
      0, -0.066 - i * 0.026, 0.114 + i * 0.004, 0, 0, Math.PI / 2));
  }
  g.add(part(cboxG(0.038, 0.011, 0.040), MATS.polymer, 0, -0.146, 0.126, -0.16));
  g.add(part(torG(0.021, 0.0038, 6, 14, Math.PI), MATS.enamel,
    0, -0.040, 0.082, 0, Math.PI / 2, Math.PI));

  /* ---- 引金（動く） */
  const trg = new THREE.Group();
  trg.position.set(0, -0.030, 0.092);
  trg.add(part(boxG(0.007, 0.026, 0.008), MATS.steel, 0, -0.013, -0.004, 0.18));
  trg.add(part(cylG(0.005, 0.005, 0.010, 8), MATS.steel, 0, 0, 0, 0, 0, Math.PI / 2));
  g.add(trg);
  g.userData.trigger = trg;

  /* ---- 遊底（動く）。**この銃の「1発ずつ送る」を画で見せる部品。**
     撃つたびに後ろへ引かれて戻る（view.boltTravelがその量）。
     右へ突き出した握りを付けておくと、動きが真横から読める */
  const bolt = new THREE.Group();
  bolt.add(part(cylG(0.0125, 0.0125, 0.120, 12), MATS.steel, 0.006, 0.028, 0.030, Math.PI / 2));
  bolt.add(part(cylG(0.0090, 0.0090, 0.048, 10), MATS.steel, 0.030, 0.024, 0.062, 0, 0, Math.PI / 2 - 0.35));
  bolt.add(part(sphG(0.0115, 10, 8), MATS.phosphate, 0.052, 0.010, 0.062));
  bolt.add(part(cboxG(0.020, 0.014, 0.026), MATS.phosphate, 0.006, 0.036, 0.086));
  g.add(bolt);
  g.userData.bolt = bolt;
  g.userData.boltRest = 0;

  /* ---- 弾倉（動く）。5発しか入らないので、ライフルの半分の丈にする。
     短いぶん底板を厚くして、抜き差しの取っ手として読ませる */
  const mg = new THREE.Group();
  mg.position.set(0, -0.048, 0.018);
  mg.add(part(chamferBoxG(0.038, 0.052, 0.062, MAG_CHAMFER), MATS.polymer, 0, -0.026, 0.004, 0.08));
  mg.add(part(chamferBoxG(0.036, 0.050, 0.060, MAG_CHAMFER), MATS.polymer, 0, -0.070, 0.008, 0.14));
  mg.add(part(chamferBoxG(0.044, 0.013, 0.076, 0.0030), MATS.polymerTan, 0, -0.100, 0.012, 0.14));
  for (let i = 0; i < 2; i++) {
    mg.add(part(boxG(0.040, 0.004, 0.010), MATS.polymer, 0, -0.040 - i * 0.036, 0.006, 0.10));
    mg.add(part(cylG(0.0048, 0.0048, 0.004, 10), MATS.brass, 0.0190, -0.040 - i * 0.036, 0.006, 0, 0, Math.PI / 2));
  }
  g.add(mg);
  g.userData.mag = mg;
  g.userData.magRest = [0, -0.048, 0.018];

  /* ---- 銃床。**頬当てと肩当てで「覗く銃」だと形から分かるようにする。**
     覗くと目の後ろに来るので、ADS中はまとめて消える（_animateが見ている） */
  const rear = new THREE.Group();
  rear.add(part(cboxG(0.046, 0.056, 0.110), MATS.enamel, 0, 0.004, 0.150));
  // 骨組み。中を抜いた枠にすると、塊ではなく道具に見える
  rear.add(part(cboxG(0.038, 0.016, 0.150), MATS.polymer, 0, 0.026, 0.240));
  rear.add(part(cboxG(0.038, 0.018, 0.150), MATS.polymer, 0, -0.034, 0.236, 0.10));
  rear.add(part(cboxG(0.042, 0.080, 0.020), MATS.polymer, 0, -0.004, 0.312));
  // 頬当て。支柱を2本立てて、高さを調整できる物に見せる
  rear.add(part(cboxG(0.040, 0.024, 0.110), MATS.polymer, 0, 0.056, 0.230));
  for (const zz of [0.190, 0.268]) {
    rear.add(part(cylG(0.0055, 0.0055, 0.028, 8), MATS.steel, 0.014, 0.040, zz));
    rear.add(part(cylG(0.0055, 0.0055, 0.028, 8), MATS.steel, -0.014, 0.040, zz));
  }
  // 肩当て。段差を彫ってゴムらしくする
  rear.add(part(cboxG(0.046, 0.096, 0.016), MATS.rubber, 0, 0.000, 0.330));
  for (let i = 0; i < 3; i++) {
    rear.add(part(boxG(0.048, 0.005, 0.005), MATS.rubber, 0, 0.028 - i * 0.028, 0.337));
  }
  addSlingLoop(rear, -0.026, -0.024, 0.300);
  g.add(rear);
  g.userData.rear = rear;

  /* 望遠照準。高さの決め方はライフルと同じで、覗いた時の円錐から
     レールと左手を外へ出せる所まで上げる。位置(z)はマウントがレールに載る所。

     **高さは実測で決めた。** 最初は0.062（光軸が銃身芯の6.6cm上）に置いていて、
     狙点のまわりが全周素通しなのは2.2度までだった（ライフルは3.0度）。
     差の正体は制退器で、この銃のほうが太い（半径21.5mm対16.5mm）ぶん
     視線の円錐へ深く入っていた。1cm上げるとライフルと同じ3.0度になる。
     数字は tools/check-scope.mjs が出す */
  addScope(g, 0.072, -0.020);

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, S_BORE, -0.845);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0.040, 0.026, 0.030);
  g.add(eject);
  g.userData.eject = eject;

  /* ---- 手。右は握把、左は先台の下側を掴む。
     先台を箱にしてあるので、掴む半径はライフル(0.031)より少し細く取る */
  const handR = buildHand(1, {
    gripR: 0.021, wrap: 0.50, trigger: true, armDir: [0.38, -0.62, 0.92], armLen: 0.62,
  });
  handR.position.set(0.008, -0.066, 0.120);
  handR.rotation.set(-0.26, 0, 0);
  g.add(handR);
  g.userData.handR = handR;

  const handL = buildHand(-1, {
    gripR: 0.029, wrap: 0.62, tip: -0.32, roll: 0.52, skew: 0.22,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.78],
  });
  handL.position.set(0, S_BORE - 0.008, -0.300);
  handL.rotation.set(-Math.PI / 2 + 0.10, 0, 0.12);
  g.add(handL);
  g.userData.handL = handL;

  // 装填中に左手が辿る握り位置。弾倉が短いぶん、抜く所もライフルより浅い
  g.userData.holdL = {
    rest: [[0, S_BORE - 0.008, -0.300], [-Math.PI / 2 + 0.10, 0, 0.12]],
    mag: [[0.014, -0.120, 0.024], [0.30, 0.22, -0.20]],
    low: [[0.034, -0.280, 0.070], [0.55, 0.38, -0.30]],
    charge: [[0.030, 0.030, 0.060], [0.85, 0.10, 0.30]],
  };

  // 飾りは結合の前に足す。後からだと飾りの数だけ描画呼び出しが増える
  if (deco) deco(g);

  bakeStatic(rear);
  bakeStatic(bolt);
  bakeStatic(mg);
  bakeStatic(trg);
  bakeStatic(g);
  return g;
}

/* ---------------------------------------------------------- 武器定義 */

/* ------------------------------------------------------------------ 短剣 */

// 銃と同じ枠に収める。当たり判定を別に作らないのが肝で、
// 今の射撃は「カメラから前へレイを飛ばして def.range まで見る」作りなので、
// 射程1.8mの銃として書けば近接になる。壁越しにも当たらない（レイが壁で止まる）。
//
// 弾を持たないので mag に大きい数を入れて装填を起こさせない。
// muzzle/eject/sight の3つは武器側が必ず参照するので、銃が無くても印だけは置く
// 拳銃。サイドアーム。
//
// 足した理由は2つ。1つはガンゲーム（キルごとに武器が替わるモード）で、
// 武器が4本しかないと1周が短すぎたこと。もう1つは、
// ライフルとショットガンの間に「軽くて素早いが火力が低い」枠が無かったこと。
//
// 形は詰め込まない。全長19cmしかないので、ライフルと同じ密度で部品を置くと
// 画面上では潰れた塊にしかならない。スライド・フレーム・握把・照準の
// 4つの塊が読めれば拳銃に見える
const P_BORE = 0.012;       // 銃身の芯の高さ
const P_GRIP_TILT = -0.30;  // 握把の傾き。垂直だと握った手が不自然に立つ

/**
 * @param view 握りと構えの設定
 * @param deco 形違いのスキンが飾りを足す口。**bakeStaticの前に呼ぶ**
 */
function buildPistol(view = {}, deco = null) {
  const g = new THREE.Group();
  const grip = view.grip || {};

  /* ---- スライド。一番大きい塊なので、ここで拳銃に見えるかが決まる */
  g.add(part(cboxG(0.030, 0.028, 0.170), MATS.anodized, 0, P_BORE + 0.002, -0.050));
  // 天面の細い段。真っ平らな箱だと「弁当箱」に見える
  g.add(part(boxG(0.013, 0.004, 0.168), MATS.anodized, 0, P_BORE + 0.017, -0.050));
  // 後端の滑り止め。等間隔の溝を数本入れるだけで金属の板に見える
  for (let i = 0; i < 5; i++) {
    const z = 0.012 - i * 0.010;
    g.add(part(boxG(0.032, 0.016, 0.003), MATS.phosphate, 0, P_BORE + 0.002, z));
  }
  // 排莢口。開けっ放しにすると穴が抜けるので奥を塞ぐ
  g.add(part(boxG(0.004, 0.016, 0.040), MATS.enamel, 0.014, P_BORE + 0.006, -0.014));

  /* ---- 銃身。スライドの先から少しだけ出す */
  g.add(part(cylG(0.0075, 0.0075, 0.020, 10), MATS.steel, 0, P_BORE, -0.140, Math.PI / 2));
  g.add(part(cylG(0.0055, 0.0055, 0.008, 10), MATS.phosphate, 0, P_BORE, -0.148, Math.PI / 2));

  /* ---- フレーム。スライドの下に一段細い箱を通す */
  g.add(part(cboxG(0.026, 0.018, 0.120), MATS.polymer, 0, -0.006, -0.040));
  // 銃身の下の覆い。ここが無いと銃身が宙に浮いて見える
  g.add(part(cboxG(0.022, 0.014, 0.062), MATS.polymer, 0, -0.004, -0.096));

  /* ---- 用心金と引き金 */
  g.add(part(boxG(0.020, 0.007, 0.007), MATS.polymer, 0, -0.034, -0.016));
  g.add(part(boxG(0.020, 0.006, 0.032), MATS.polymer, 0, -0.038, 0.002));
  g.add(part(boxG(0.007, 0.019, 0.006), MATS.steel, 0, -0.026, 0.006));

  /* ---- 握把。後ろへ傾ける。垂直だと手首が立って人形の手になる */
  g.add(part(cboxG(0.029, 0.088, 0.040), MATS.polymer, 0, -0.062, 0.036, P_GRIP_TILT));
  // 側面の滑り止め
  for (let i = 0; i < 3; i++) {
    g.add(part(boxG(0.031, 0.004, 0.026), MATS.rubber, 0, -0.046 - i * 0.020, 0.041 + i * 0.006, P_GRIP_TILT));
  }
  // 弾倉の底板。握把の下端に少しはみ出させると「入っている」が読める
  g.add(part(cboxG(0.032, 0.008, 0.046), MATS.phosphate, 0, -0.104, 0.049, P_GRIP_TILT));

  /* ---- 照準。前後を離して置くと、覗いた時に線が通る */
  g.add(part(boxG(0.004, 0.009, 0.005), MATS.phosphate, 0, P_BORE + 0.023, -0.128));
  g.add(part(boxG(0.020, 0.007, 0.007), MATS.phosphate, 0, P_BORE + 0.022, 0.026));
  g.add(part(boxG(0.006, 0.008, 0.008), MATS.steel, 0.007, P_BORE + 0.023, 0.026));
  g.add(part(boxG(0.006, 0.008, 0.008), MATS.steel, -0.007, P_BORE + 0.023, 0.026));

  /* ---- 銃側が必ず読む3つの印 */
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, P_BORE, -0.155);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0.020, P_BORE + 0.008, -0.010);
  g.add(eject);
  g.userData.eject = eject;
  // 覗いた時の寄せ先。照門の高さに置くと照準線が画面の中心へ来る
  const sight = new THREE.Object3D();
  sight.position.set(0, P_BORE + 0.026, -0.050);
  g.add(sight);
  g.userData.sight = sight;

  /* ---- 手。両手で持つ。片手だと的当ての構えになって緊張感が出ない */
  const handR = buildHand(1, {
    gripR: 0.019, wrap: 0.58, trigger: true,
    armDir: grip.armDir || [0.36, -0.78, 0.34],
    armLen: grip.armLen != null ? grip.armLen : 0.34,
  });
  handR.position.fromArray(grip.pos || [0, -0.052, 0.034]);
  handR.rotation.fromArray(grip.rot || [P_GRIP_TILT, 0, 0]);
  g.add(handR);
  g.userData.handR = handR;

  // 添え手。右手の握りを下から包む位置に置く。
  // ライフルの支え手と違って掴む対象が「手」なので、gripRは指の太さぶん大きくする
  const handL = buildHand(-1, {
    gripR: 0.026, wrap: 0.50, tip: -0.26, roll: 0.34, skew: 0.18,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.34, -0.86, -0.30],
  });
  handL.position.set(-0.020, -0.066, 0.044);
  handL.rotation.set(P_GRIP_TILT, 0, 0.34);
  g.add(handL);
  g.userData.handL = handL;

  // 装填中に添え手が辿る位置。弾倉を抜いて、下から新しいのを入れて、戻る
  g.userData.holdL = {
    rest: [[-0.020, -0.066, 0.044], [P_GRIP_TILT, 0, 0.34]],
    mag: [[0.010, -0.150, 0.060], [0.24, 0.20, -0.18]],
    low: [[0.030, -0.290, 0.100], [0.50, 0.34, -0.28]],
    charge: [[0.026, 0.040, 0.020], [0.80, 0.06, 0.30]],
  };

  // 飾りは結合の前に足す。後からだと飾りの数だけ描画呼び出しが増える
  if (deco) deco(g);

  bakeStatic(g);
  return g;
}

function buildKnife(view = {}) {
  const g = new THREE.Group();
  // 握り方（def.view.grip）は meleeRig が読む。ここは刃と柄だけを組む

  // 刃。輪郭を1枚のShapeで描いて押し出す。
  //
  // 前は断面を押し出したうえに、峰の黒帯・血抜きの溝・ギザ刃を重ねていた。
  // 部品が増えるほど「盛った塊」に見えて、ナイフの持つ簡潔さから遠ざかる。
  // 刃物が刃物に見えるのは輪郭であって表面の装飾ではないので、
  // 上から見た形（真っ直ぐな峰と、先で合わさる刃）だけを1枚で出す
  const BL = 0.225;           // 刃渡り
  const BW = 0.024;           // 根元の半幅
  const blade = new THREE.Shape();
  blade.moveTo(-BW, 0);            // 根元・峰側
  blade.lineTo(-BW, -BL * 0.62);   // 峰は先まで真っ直ぐ
  blade.lineTo(0, -BL);            // 切っ先
  blade.lineTo(BW * 0.62, -BL * 0.30);
  blade.lineTo(BW, 0);             // 根元・刃側
  blade.closePath();
  const bladeGeo = new THREE.ExtrudeGeometry(blade, {
    // 薄く押し出して、面取りで縁だけ落とす。これだけで断面が刃に見える
    depth: 0.006, bevelEnabled: true,
    bevelThickness: 0.0022, bevelSize: 0.0030, bevelSegments: 1,
  });
  // Shapeは XY 平面に描かれるので、寝かせて前（-Z）へ向ける。
  // 符号に注意。-90度だと (x, y, 0) → (x, 0, -y) になり、
  // 上で y を 0〜-BL に取った刃が z の正側＝カメラの後ろへ伸びる。
  // +90度で (x, y, 0) → (x, 0, y) となり、そのまま前へ出る
  bladeGeo.rotateX(Math.PI / 2);
  bladeGeo.translate(0, 0.003, -0.030);
  g.add(part(bladeGeo, MATS.steel, 0, 0, 0));

  // 鍔と柄。合わせて2つだけ。輪の飾りや柄尻は足さない。
  // 部品を増やしても情報は増えず、シルエットが濁るだけ
  g.add(part(cboxG(0.052, 0.016, 0.012), MATS.phosphate, 0, 0.002, -0.030));
  g.add(part(cylG(0.016, 0.018, 0.100, 10), MATS.polymer, 0, 0.001, 0.028, Math.PI / 2));

  meleeRig(g, view);
  bakeStatic(g);
  return g;
}

/**
 * 短剣系の共通の枠。**刃と柄より後ろは全部同じ**なので、形違いはここを使い回す。
 *
 * 元は buildKnife の中に直に書いてあった。刀とダガーを足す時に
 * 同じ50行を2回写すことになったので抜き出した。**値は1つも変えていない**
 * （変えると今のナイフの構えが動く。tools/check-weapons.mjs が見張っている）。
 *
 * @param muzzleZ 閃光と煙の出所。短剣では光らせないので位置だけ。
 *                刃の長さに合わせて動かす（切っ先より先に置く）
 * @param sightZ  覗いた時の寄せ先。刃の芯に置くと構えが崩れない
 */
function meleeRig(g, view = {}, { muzzleZ = -0.260, sightZ = -0.140, gripR = 0.021 } = {}) {
  const grip = view.grip || {};

  // 銃ではないが、武器側が必ず読む3つの印は置く。
  // 無いと閃光の出所も覗きの逆算も行き先を失う
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, muzzleZ);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  eject.position.set(0, 0, 0);
  g.add(eject);
  g.userData.eject = eject;
  const sight = new THREE.Object3D();
  sight.position.set(0, 0.003, sightZ);
  g.add(sight);
  g.userData.sight = sight;

  /* ---- 手。右手だけで順手に持つ。左手は使わないので画面外へ逃がす */
  const handR = buildHand(1, {
    gripR, wrap: 0.72, trigger: false,
    armDir: grip.armDir || [0.38, -0.62, 0.92],
    armLen: grip.armLen != null ? grip.armLen : 0.62,
  });
  handR.position.fromArray(grip.pos || [0, -0.001, 0.030]);
  handR.rotation.fromArray(grip.rot || [-0.10, 0, 0]);
  g.add(handR);
  g.userData.handR = handR;

  // 左手は持たない武器なので、画面の外へ置いて出さない。
  // 消してしまうと、武器を持ち替えた時に左手だけ出てこない不具合の元になる
  const handL = buildHand(-1, {
    gripR: 0.024, wrap: 0.55, tip: -0.30, roll: 0.40, skew: 0.20,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.78],
  });
  handL.position.set(0.34, -0.40, 0.16);
  handL.rotation.set(-Math.PI / 2 + 0.10, 0, 0.12);
  handL.visible = false;
  g.add(handL);
  g.userData.handL = handL;

  g.userData.holdL = {
    rest: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
    mag: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
    low: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
    charge: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
  };
  return g;
}

/* 刃を1枚の図形から起こす共通の道具。
   Shapeは XY 平面に描かれるので、寝かせて前（-Z）へ向ける。
   **符号に注意。** -90度だと (x, y, 0) → (x, 0, -y) になり、
   y を 0〜-BL に取った刃が z の正側＝カメラの後ろへ伸びる */
function bladeGeoFrom(shape, depth, bevel, z = -0.030, y = 0.003) {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth, bevelEnabled: true,
    bevelThickness: bevel * 0.73, bevelSize: bevel, bevelSegments: 1,
  });
  geo.rotateX(Math.PI / 2);
  geo.translate(0, y, z);
  return geo;
}

/* ------------------------------------------------------------ 刀 */

// 形違いのスキン。**同じ「射程1.8mの銃」のまま、見た目だけが変わる。**
// 当たり判定はレイを飛ばして射程で決めているので、刃の長さは判定に効かない。
// だから対戦の公平性にも影響しない（長い刀が有利になったりしない）。
function buildKatana(view = {}) {
  const g = new THREE.Group();

  const BL = 0.300;    // 刃渡り。ナイフ(0.225)より3割長い
  const BW = 0.019;    // 半幅。日本刀は幅が狭い
  const SORI = 0.026;  // 反り。**これが刀らしさのほぼ全部**

  /* 反りは「先へ行くほど峰側（-x）へ寄る」で出す。
     直線の刃を長くしただけでは、ただの長いナイフにしかならない */
  const blade = new THREE.Shape();
  blade.moveTo(-BW, 0);                                   // 根元・峰側
  blade.quadraticCurveTo(-BW - SORI * 0.45, -BL * 0.55, -BW - SORI * 0.92, -BL * 0.93);
  blade.lineTo(-BW * 0.15 - SORI, -BL);                   // 切っ先
  // 刃側を根元へ戻る。峰と同じだけ反らせないと、先が太って鉈に見える
  blade.quadraticCurveTo(BW * 0.55 - SORI * 0.5, -BL * 0.5, BW, 0);
  blade.closePath();
  g.add(part(bladeGeoFrom(blade, 0.0065, 0.0030), MATS.steel, 0, 0, 0));

  /* 鎬（しのぎ）。峰寄りに細い面を1枚重ねると、平らな板から抜け出す。
     実物の刀は断面が菱形で、光が2段で返る。そこだけ真似る */
  const ridge = new THREE.Shape();
  ridge.moveTo(-BW * 0.55, -BL * 0.04);
  ridge.quadraticCurveTo(-BW * 0.55 - SORI * 0.45, -BL * 0.55, -BW * 0.5 - SORI * 0.9, -BL * 0.90);
  ridge.lineTo(-BW * 0.15 - SORI * 0.95, -BL * 0.95);
  ridge.quadraticCurveTo(-BW * 0.1 - SORI * 0.45, -BL * 0.5, -BW * 0.12, -BL * 0.04);
  ridge.closePath();
  g.add(part(bladeGeoFrom(ridge, 0.0072, 0.0012, -0.030, 0.0028), MATS.anodized, 0, 0, 0));

  /* 鍔（つば）。**円盤1枚。** 刀と他の刃物を分ける一番大きい印がこれで、
     ここが四角いと途端に西洋剣に見える */
  g.add(part(cylG(0.030, 0.030, 0.006, 18), MATS.phosphate, 0, 0.002, -0.026, Math.PI / 2));
  // 切羽（せっぱ）。鍔の両脇の薄い座金。1枚板に見えないように段を作る
  g.add(part(cylG(0.017, 0.017, 0.004, 14), MATS.brass, 0, 0.002, -0.021, Math.PI / 2));
  g.add(part(cylG(0.017, 0.017, 0.004, 14), MATS.brass, 0, 0.002, -0.031, Math.PI / 2));

  /* 柄（つか）。長い。**両手で握れる長さがあることが刀の形の条件。**
     持つのは右手だけだが、長さが無いと短刀に見える */
  g.add(part(cboxG(0.023, 0.031, 0.135), MATS.rubber, 0, 0.002, 0.052));
  /* 柄巻き。菱形に交差する紐を、細い箱を斜めに置いて出す。
     6組で足りる。増やすと縞に潰れて、かえって平らに見える */
  for (let i = 0; i < 6; i++) {
    const z = 0.000 + i * 0.021;
    g.add(part(boxG(0.026, 0.006, 0.010), MATS.enamel, 0, 0.017, z, 0, 0, 0.62));
    g.add(part(boxG(0.026, 0.006, 0.010), MATS.enamel, 0, 0.017, z, 0, 0, -0.62));
    g.add(part(boxG(0.006, 0.026, 0.010), MATS.enamel, 0.011, 0.002, z, 0.62, 0, 0));
    g.add(part(boxG(0.006, 0.026, 0.010), MATS.enamel, -0.011, 0.002, z, -0.62, 0, 0));
  }
  // 頭（かしら）。柄尻の金具
  g.add(part(cboxG(0.025, 0.033, 0.014), MATS.brass, 0, 0.002, 0.124));

  // 刃が長いぶん、閃光の出所と覗きの寄せ先も先へ送る
  meleeRig(g, view, { muzzleZ: -0.340, sightZ: -0.175, gripR: 0.019 });
  bakeStatic(g);
  return g;
}

/* -------------------------------------------------------- ダガー */

function buildDagger(view = {}) {
  const g = new THREE.Group();

  const BL = 0.175;   // 刃渡り。ナイフより短い
  const BW = 0.030;   // 半幅。**短くて幅広い**のがダガーの形

  /* 左右対称の両刃。ナイフ（片刃・先が寄っている）との差はここで出る。
     真ん中で膨らませて、菱形の断面に見せる */
  const blade = new THREE.Shape();
  blade.moveTo(-BW, 0);
  blade.lineTo(-BW * 0.92, -BL * 0.52);
  blade.lineTo(0, -BL);                 // 切っ先は中央
  blade.lineTo(BW * 0.92, -BL * 0.52);
  blade.lineTo(BW, 0);
  blade.closePath();
  g.add(part(bladeGeoFrom(blade, 0.0075, 0.0034), MATS.steel, 0, 0, 0));

  /* 中央の稜線。両刃は中心が一番厚い。細い帯を重ねるだけで菱形に見える */
  const spine = new THREE.Shape();
  spine.moveTo(-BW * 0.16, -BL * 0.03);
  spine.lineTo(0, -BL * 0.92);
  spine.lineTo(BW * 0.16, -BL * 0.03);
  spine.closePath();
  g.add(part(bladeGeoFrom(spine, 0.0086, 0.0012, -0.030, 0.0028), MATS.anodized, 0, 0, 0));

  /* クロスガード。**横へ大きく張り出す。** 刀の円盤と対になる形で、
     ここだけで「西洋の短剣」に見える。

     **材質を刃と分けてある。** 同じMATS.steelにすると、
     押し出した刃（索引なし）と面取り箱（索引あり）が同じ束へ入って
     mergeGeometriesが失敗する。結合が諦められて描画呼び出しが増えるだけで
     見た目は変わらないので、黙って重くなる形の不具合になる */
  g.add(part(cboxG(0.082, 0.013, 0.015), MATS.phosphate, 0, 0.002, -0.024));
  // 張り出しの先の玉。角のままだと板に見える
  g.add(part(sphG(0.0085), MATS.brass, 0.041, 0.002, -0.024));
  g.add(part(sphG(0.0085), MATS.brass, -0.041, 0.002, -0.024));

  // 柄。短く絞る。革巻きの段を3本
  g.add(part(cylG(0.014, 0.016, 0.078, 12), MATS.rubber, 0, 0.002, 0.020, Math.PI / 2));
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.017, 0.017, 0.006, 12), MATS.polymer, 0, 0.002, 0.000 + i * 0.024, Math.PI / 2));
  }
  // 柄頭。丸い錘。ここが重いと短剣らしい均衡になる
  g.add(part(sphG(0.019), MATS.brass, 0, 0.002, 0.062));

  meleeRig(g, view, { muzzleZ: -0.215, sightZ: -0.110, gripR: 0.016 });
  bakeStatic(g);
  return g;
}

/**
 * 形違いのスキン。**id → 組み立て関数。**
 *
 * 色のスキン（materialを差し替えるだけ）と違って、こちらは組み立てそのものが別。
 * だから**その武器専用**になる（刀はナイフにしか意味が無い）。
 * どの武器で売るかは src/net/protocol.js の SHAPE_LIST が持つ。
 *
 * ここに足す時の決まり:
 *   ・muzzle / eject / sight の3つの印を必ず置く（meleeRigかbuild側で）
 *   ・元の武器が持っている動く部品（bolt/mag/trigger）を同じ名前で用意する。
 *     **無いと装填で何も動かなくなる。** 短剣系は動く部品が無いので楽
 */
export const SHAPE_BUILDS = {
  katana: buildKatana,
  dagger: buildDagger,
  rapier: buildRapier,
  axe: buildAxe,
  glove: buildGlove,
  dragon: buildRifleDragon,
  cute: buildRifleCute,
  western: (view = {}) => buildShotgun(view, westernDeco),
  shark: (view = {}) => buildShotgun(view, sharkDeco),
  ice: (view = {}) => buildSniper(view, iceDeco),
  cyber: (view = {}) => buildPistol(view, cyberDeco),
  venom: (view = {}) => buildSniper(view, venomDeco),
  chrome: (view = {}) => buildPistol(view, chromeDeco),
};

/* ------------------------------------------------- レイピア・斧・グローブ
 *
 * 2026-08-11に足した3つ。「ナイフ種類増やしたいなぁ。レイピア？おの？パンチグローブ？」
 *
 * **強さは3つとも今まで通り全部同じ。** 威力も間隔も間合いも変えない
 * （形スキンはコインで買う物なので、強くなると「強さを買える」ことになる）。
 * 差を付けるのは**見た目・振り方・音**の3つだけ。
 *
 * 刀とダガーは「刃の輪郭を描き直す」作りなので、こちらも同じやり方で組む
 * （銃の形違いのように飾りを足すだけでは、刃物は形が変わらない）。
 */

/* レイピア。**一番細くて一番長い。**
   刀(0.300)より1割長いが、半幅は刀の半分以下。
   細さを出すために刃は「板」ではなく「線に近い菱形」にしてある */
function buildRapier(view = {}) {
  const g = new THREE.Group();

  const BL = 0.330;   // 刃渡り。刀の1.1倍
  const BW = 0.008;   // 半幅。刀(0.019)の半分以下。**細さがこの武器の全部**

  /* 直刃。**反らせない。** 反らせると刀に寄る。
     先へ向かって細く絞ると、突く道具に見える */
  const blade = new THREE.Shape();
  blade.moveTo(-BW, 0);
  blade.lineTo(-BW * 0.42, -BL * 0.72);
  blade.lineTo(0, -BL);
  blade.lineTo(BW * 0.42, -BL * 0.72);
  blade.lineTo(BW, 0);
  blade.closePath();
  g.add(part(bladeGeoFrom(blade, 0.0060, 0.0022), MATS.steel, 0, 0, 0));

  /* 樋（ひ）。刃の中央に細い溝を1本通す。
     細い刃は光が2段で返らないと「針金」に見えるので、稜線ではなく溝で段を作る */
  const groove = new THREE.Shape();
  groove.moveTo(-BW * 0.30, -BL * 0.04);
  groove.lineTo(0, -BL * 0.88);
  groove.lineTo(BW * 0.30, -BL * 0.04);
  groove.closePath();
  g.add(part(bladeGeoFrom(groove, 0.0068, 0.0010), MATS.anodized, 0, 0, 0));

  /* 椀型の護拳（ナックルボウ）。**この形がレイピアの印。**
     刀の円盤・ダガーのクロスガードと並ぶ「手を守る物」で、
     椀は潰した球で作る（円盤だと刀に、横棒だとダガーに見える） */
  g.add(partS(sphG(0.030, 12, 8), MATS.phosphate, 0, 0.002, -0.014, 1, 1, 0.42));
  // 椀の縁。細い環を回すと、金物の椀に見える
  g.add(part(torG(0.029, 0.0022, 5, 18), MATS.brass, 0, 0.002, -0.021, Math.PI / 2));
  /* 護拳の弓。椀から柄尻へ回す1本。**半円の弧で足りる**
     （全周にすると籠になって、レイピアではなくカップヒルトの別物になる）*/
  g.add(part(torG(0.026, 0.0026, 5, 14, Math.PI), MATS.brass, 0, -0.024, 0.024, 0, Math.PI / 2, 0));

  // 柄。細くて短い。片手で握る物なので刀のような長さは要らない
  g.add(part(cylG(0.0105, 0.0125, 0.072, 12), MATS.rubber, 0, 0.002, 0.028, Math.PI / 2));
  // 柄の銀線巻き。細い環を等間隔に。細い柄は段が無いと棒に見える
  for (let i = 0; i < 5; i++) {
    g.add(part(cylG(0.0128, 0.0128, 0.004, 12), MATS.chrome, 0, 0.002, 0.004 + i * 0.016, Math.PI / 2));
  }
  // 柄頭。錘。細い剣は柄尻が重くないと均衡が取れない
  g.add(part(sphG(0.0135, 12, 8), MATS.brass, 0, 0.002, 0.070));

  // 一番長いので、閃光の出所と覗きの寄せ先も一番先へ送る
  meleeRig(g, view, { muzzleZ: -0.380, sightZ: -0.190, gripR: 0.016 });
  bakeStatic(g);
  return g;
}

/* 斧。**一番短くて一番幅広い。**
   刃渡りではなく「刃頭の幅」で大きさを出す物なので、
   BLを短くしてBWを大きく取る（レイピアのちょうど逆） */
function buildAxe(view = {}) {
  const g = new THREE.Group();

  const HL = 0.115;   // 刃頭の丈
  const HW = 0.052;   // 刃頭の半幅。**幅がこの武器の全部**

  /* 片刃の刃頭。**扇形に広がる刃。**
     刃側(+x)だけを膨らませて、峰側(-x)は直線にする。
     両側を膨らませると両刃斧になって、木を割る道具ではなくなる */
  const head = new THREE.Shape();
  head.moveTo(-HW * 0.30, 0);
  head.lineTo(-HW * 0.30, -HL);
  head.quadraticCurveTo(HW * 0.55, -HL * 1.06, HW, -HL * 0.62);
  head.quadraticCurveTo(HW * 0.72, -HL * 0.16, HW * 0.42, 0);
  head.closePath();
  g.add(part(bladeGeoFrom(head, 0.0140, 0.0038), MATS.steel, 0, 0, -0.150));

  /* 刃先の帯。**研いだ所だけ明るい。**
     一枚板だと鉄の板にしか見えないので、縁に細い面を作る */
  const edge = new THREE.Shape();
  edge.moveTo(HW * 0.62, -HL * 0.10);
  edge.quadraticCurveTo(HW * 1.00, -HL * 0.60, HW * 0.55, -HL * 1.02);
  edge.quadraticCurveTo(HW * 0.80, -HL * 0.58, HW * 0.50, -HL * 0.08);
  edge.closePath();
  g.add(part(bladeGeoFrom(edge, 0.0148, 0.0012), MATS.chrome, 0, 0, -0.150));

  /* 刃の背の突起（打撃面）。**斧の裏は槌になっている物が多い。**
     ここが無いと「幅広いナイフ」に見える */
  g.add(part(cboxG(0.026, 0.030, 0.034), MATS.phosphate, -0.030, 0.002, -0.150));

  /* 木の柄。**長い。** 斧は柄の長さで振る力を作る道具なので、
     ここが短いと手斧になって、振り下ろす動きと釣り合わない */
  g.add(part(cylG(0.0115, 0.0135, 0.240, 10), MATS.walnut, 0, 0.002, -0.020, Math.PI / 2));
  // 刃を留める楔と輪。木と鉄の継ぎ目を隠す
  g.add(part(cylG(0.0165, 0.0165, 0.016, 10), MATS.phosphate, 0, 0.002, -0.132, Math.PI / 2));
  g.add(part(cboxG(0.020, 0.008, 0.012), MATS.brass, 0, 0.002, -0.166));
  /* 革巻き。握る所だけ。**柄の全部を巻くと木が見えなくなる**ので、
     手が来る所（z=0.04付近）に3本だけ */
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.0148, 0.0148, 0.014, 10), MATS.strap, 0, 0.002, 0.024 + i * 0.020, Math.PI / 2));
  }
  // 柄尻の環。手が抜けない形にしてあると道具に見える
  g.add(part(torG(0.0135, 0.0028, 5, 12), MATS.brass, 0, 0.002, 0.086));

  // 刃が短いぶん、閃光の出所も手前で止める
  meleeRig(g, view, { muzzleZ: -0.250, sightZ: -0.130, gripR: 0.022 });
  bakeStatic(g);
  return g;
}

/* パンチグローブ。**刃を持たない。武器そのものが拳。**
 *
 * **両拳を出す。** 他の近接は右手だけだが、拳で殴る物は
 * 片手だけ構えていると「何かを握っているのに手が空いている」形になる。
 * ボクシングの構えは両手が前に出ているので、そこを真似る。
 *
 * **左手は独立して動かない。** 振りの動きは模型ごと動かす作りなので、
 * 左だけ突き出すことができない（腕が武器の群れの中に居るのと同じ理由）。
 * 右クリックは体ごと回す大きなフックにしてあって、両拳が一緒に回る。
 */
function buildGlove(view = {}) {
  const g = new THREE.Group();
  const grip = view.grip || {};

  /* 右の拳の当て金。**4つの節。**
     1枚の板にすると指の区切りが消えて「金属の箱」になる */
  for (let i = 0; i < 4; i++) {
    const x = -0.021 + i * 0.014;
    g.add(part(cboxG(0.013, 0.016, 0.020), MATS.brass, x, 0.004, -0.052));
  }
  // 当て金の台。革の甲。節を乗せる面が無いと金だけ浮く
  g.add(part(cboxG(0.062, 0.020, 0.030), MATS.strap, 0, -0.002, -0.044));
  /* 手首の帯。**巻いてある物であることを出す。**
     グローブは「着けている物」なので、留め具が見えないと素手に見える */
  for (let i = 0; i < 3; i++) {
    g.add(part(cylG(0.026, 0.026, 0.012, 12), MATS.strap, 0, 0.000, 0.010 + i * 0.020, Math.PI / 2));
  }
  g.add(part(cboxG(0.014, 0.010, 0.026), MATS.brass, 0.024, 0.000, 0.030));

  /* 左の拳。**meleeRigは右手しか作らない**ので、こちらで足す。
     buildHand(-1) で左になる（ライフルの添え手と同じ口）*/
  const handL = buildHand(-1, {
    gripR: 0.024, wrap: 0.92, trigger: false,
    armDir: grip.armDirL || [-0.42, -0.68, 0.86],
    armLen: 0.58,
  });
  handL.position.set(-0.062, -0.030, 0.010);
  handL.rotation.set(-0.24, 0.18, -0.20);
  g.add(handL);
  g.userData.handL = handL;
  // 左の当て金。右より小さく・奥に置く（構えた時に左が前へ出過ぎない）
  for (let i = 0; i < 3; i++) {
    g.add(part(cboxG(0.012, 0.014, 0.018), MATS.brass, -0.076 + i * 0.013, -0.024, -0.028));
  }
  g.add(part(cboxG(0.050, 0.018, 0.026), MATS.strap, -0.062, -0.030, -0.020));

  /* 閃光の出所と覗きの寄せ先は一番手前。**拳は届く距離が短く見える**方が正しい
     （当たり判定は間合いで決まっていて形に効かないので、見た目の話） */
  meleeRig(g, view, { muzzleZ: -0.140, sightZ: -0.080, gripR: 0.024 });
  bakeStatic(g);
  return g;
}

// 手榴弾。持ち替えると手に持つだけで、左クリックで投げる。
// 撃つ道具ではないので melee と同じく弾数も装填も持たない
function buildGrenade(view = {}) {
  const g = new THREE.Group();
  const grip = view.grip || {};
  // 胴。上下を潰した円柱を2段にして卵形にする
  g.add(part(cylG(0.032, 0.036, 0.062, 14), MATS.enamel, 0, 0, 0, Math.PI / 2));
  g.add(part(cylG(0.026, 0.032, 0.020, 14), MATS.enamel, 0, 0, -0.040, Math.PI / 2));
  g.add(part(cylG(0.026, 0.032, 0.020, 14), MATS.enamel, 0, 0, 0.040, Math.PI / 2));
  // 信管の頭と安全レバー
  g.add(part(cylG(0.013, 0.013, 0.022, 10), MATS.phosphate, 0, 0, -0.062, Math.PI / 2));
  g.add(part(cboxG(0.010, 0.006, 0.052), MATS.steel, 0.014, 0.004, -0.038));
  // 安全ピンの輪。薄い円柱で代用する（この縮尺では輪の穴は1画素も見えない）
  g.add(part(cylG(0.011, 0.011, 0.003, 12), MATS.steel, 0.024, 0.010, -0.060, 0, Math.PI / 2, 0));

  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, -0.07);
  g.add(muzzle);
  g.userData.muzzle = muzzle;
  const eject = new THREE.Object3D();
  g.add(eject);
  g.userData.eject = eject;
  const sight = new THREE.Object3D();
  sight.position.set(0, 0, 0);
  g.add(sight);
  g.userData.sight = sight;

  const handR = buildHand(1, {
    gripR: 0.026, wrap: 0.80, trigger: false,
    armDir: grip.armDir || [0.38, -0.62, 0.92],
    armLen: grip.armLen != null ? grip.armLen : 0.62,
  });
  handR.position.fromArray(grip.pos || [0, -0.004, 0.012]);
  handR.rotation.fromArray(grip.rot || [-0.12, 0, 0]);
  g.add(handR);
  g.userData.handR = handR;

  const handL = buildHand(-1, {
    gripR: 0.024, wrap: 0.55, tip: -0.30, roll: 0.40, skew: 0.20,
    wrist: [0.046, -0.052, -0.038], armDir: [-0.38, -0.86, -0.78],
  });
  handL.position.set(0.34, -0.40, 0.16);
  handL.rotation.set(-Math.PI / 2 + 0.10, 0, 0.12);
  handL.visible = false;
  g.add(handL);
  g.userData.handL = handL;
  g.userData.holdL = {
    rest: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
    mag: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
    low: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
    charge: [[0.34, -0.40, 0.16], [-Math.PI / 2 + 0.10, 0, 0.12]],
  };

  bakeStatic(g);
  return g;
}

export const WEAPONS = [
  {
    // nickは画面の札と操作説明に出る短い呼び名。**表がここ1箇所を持つ。**
    // 前は index.html と検査がそれぞれ「ライフル」と書いていて、
    // 武器を足すたびに3箇所を手で揃えることになっていた
    id: 'rifle', name: 'MK-4 カービン', nick: 'ライフル', build: buildRifle,
    damage: 27, headMult: 2.4, rpm: 640, auto: true, pellets: 1,
    // 予備は5マガジン分。240発(8マガジン)は「撃ち切る心配をしない」量で、
    // 弾を数える場面が最後まで来なかった。5本だと、当てずに撃ち続けると
    // 1ラウンドの終盤で足りなくなる。
    // 弾倉は30→25（2026-08-07、「30は多い」）。予備も5マガジン分のまま追従
    mag: 25, reserve: 125, reloadTime: 2.15,
    // 腰だめは0.030から下げた。0.030は20m先で60cmに散る量で、
    // 止まっていても腰だめでは当たらない＝覗く以外の選択肢が無い状態だった。
    // 0.024だと20m先48cm（胴の幅45cmとほぼ同じ）、10m先なら24cmで当たる。
    // 近い距離の撃ち合いだけ腰だめが成立して、遠くは今まで通り覗く形になる
    spreadHip: 0.024, spreadAds: 0.0016, spreadPerShot: 0.0026, spreadMax: 0.052, spreadRecover: 0.09,
    recoilPitch: 0.0125, recoilYaw: 0.0038, kick: 0.035, adsFov: 46, adsTime: 0.16,
    range: 120, falloffStart: 42, falloffEnd: 95, falloffMin: 0.5,
    // bodyFreq 640は「胴」と呼ぶには高すぎて、クラックと同じ帯で鳴っていた。
    // さらにthump(腹に来る低音の層)が無く、ショットガンだけが持っていた。
    // 高音の破裂しか無い音は、耳には乾いた小さい破裂＝軽い音として届く。
    // 胴を300Hzまで下げ、110→44Hzへ落ちるthumpを足して、減衰も伸ばす
    sound: { volume: 0.78, bodyFreq: 300, crackFreq: 3600, bodyDecay: 0.20, tailDecay: 0.62, thumpFrom: 110, thumpTo: 44 },
    casing: true,
    reloadKind: 'mag', holdOpen: true,
    // 構え・揺れ・反動のバネを武器ごとに変える。数値の差がそのまま手触りの差になる。
    // adsDistは目からサイトまでの距離。遠いと「銃を少し持ち上げただけ」の画になるので、
    // 目をガラスの後ろに置いた感覚が出るところまで詰める。
    // adsPosはサイト位置からの逆算なので、adsDist/adsScaleを変えてもドットは中心に残る。
    //
    // hipの決め方（1280x720・viewCamera fov55で机上計算した）:
    //   前は scale 0.53 / z-0.335 で、銃の占有面積が画面の2.2%しかなかった。
    //   握把・右手・右前腕は全部フレームの外（右手の甲がy=903）で、
    //   プレイヤーの体と画面をつなぐ物が1つも写っていない＝右下に浮いた別レイヤーに見える。
    //   ここで「銃を目へ引き寄せて大きくする」と逆効果になる。近づけるほど
    //   模型の原点から下・後ろにある握把と右手の投影が拡大されて画面外へ飛ぶ。
    //   実際 z-0.24/scale0.62 だと右手の甲は y=1064 まで落ちる。
    //   握把が画面内に入る条件は「握把が目から46cm以上離れていること」なので、
    //   腕を伸ばした構え（z-0.52）にしたうえで縮尺を0.86まで上げるのが唯一の解になる。
    //   結果: 占有 8.3%（3.6倍）、右手の甲(1099,693)・銃床(1182,668)が画面内に入り、
    //   銃口は(722,493)で中央の戦闘領域(640,360)から離れたまま。
    //   一番手前の銃床端でも目から29.5cmあるので、手前の遠近破裂も起きない
    view: {
      /* adsDistは2026-08-11に0.145から0.112へ詰めた。
         **窓の広さは筒の寸法より、ここで決まる。**
         内壁を0.0195→0.0215へ広げても窓は4.6→5.0度しか動かなかったが、
         目を近づけると6.6度まで開いた（同じ内半径でも、目が近いほど張る角が大きい）。
         上に書いてある「目をガラスの後ろに置いた感覚が出るところまで詰める」の続き。

         **0.112より詰めても伸びない。** 総当たりで測った値:
           0.145 → 4.6度 ／ 0.122 → 6.0度 ／ 0.118 → 6.2度
           0.112 → 6.6度 ／ 0.106 → 6.8度（ここから先は0.2度ずつしか動かない）
         詰めるほど銃が画面を覆うので、伸びが止まる所で止めてある。
         数字は tools/check-scope.mjs が実測で出す */
      scale: 0.86, adsScale: 0.64, adsDist: 0.112,
      // hipRotのxとyは、当初-0.12と0.13（約7度ずつ）入っていた。
      // 銃身が下へ7度・左へ7度ぶん向くので、腰だめでは「銃口の指す先」と
      // 「弾の飛ぶ先（クロスヘア）」が20m先で3.5mずれて見えていた。
      // 弾は昔からクロスヘアへ真っ直ぐ飛んでいて当たりも正しかったが、
      // 画がそう見えないせいで狙いの基準が銃身なのか十字なのか読めなかった。
      // 1度目に抜いた時はまだ3.06度残っていて（20m先で107cm）、
      // 「ほぼ抜いた」と言いながら見た目には十分ずれていた。
      // tools/check-weapons.mjs で度数として測れるようにしてから0.87度まで詰めた。
      // zのロールだけは残す（あれは構えの表情で、狙点をずらさない）
      hip: [0.21, -0.16, -0.52], hipRot: [-0.008, 0.013, 0.12],
      bob: 1.40, sway: 1.00, kickK: 300, kickD: 21,
      // 跳ね上げの初速[m/s]。このバネ（kickK 300 / kickD 21）だと
      // 1.30で頂点が約3.4cm＝銃口が画面上で20px上がる。歩きのbobが縦39pxなので、
      // 止まって撃てば十分読めて、歩きながらでも揺れに埋もれない大きさ
      kickUp: 1.30, kickSide: 0.45,
      boltTravel: 0.030, boltTime: 0.075, lower: 0.25,
    },
  },
  {
    id: 'shotgun', name: 'M870 ショットガン', nick: 'ショットガン', build: buildShotgun,
    damage: 13, headMult: 1.6, rpm: 78, auto: false, pellets: 9,
    // ライフルと同じで5マガジン分（56発＝8本から落とす）
    //
    // shellTimeは1発を入れるのにかかる時間。1発ずつ入れる武器はこちらを使い、
    // reloadTimeは使わない（空から満タンで7発×0.42＝2.94秒。前の2.9秒とほぼ同じ）。
    // reloadTimeを残してあるのは、サーバー(server/sim.js)がこの表を読んで
    // 「装填中」の印を立てる時に見ているため
    mag: 7, reserve: 35, reloadTime: 2.9, shellTime: 0.42,
    spreadHip: 0.062, spreadAds: 0.040, spreadPerShot: 0.0, spreadMax: 0.062, spreadRecover: 0.2,
    recoilPitch: 0.052, recoilYaw: 0.010, kick: 0.11, adsFov: 58, adsTime: 0.2,
    range: 40, falloffStart: 8, falloffEnd: 26, falloffMin: 0.18,
    sound: { volume: 0.85, bodyFreq: 380, crackFreq: 2600, bodyDecay: 0.22, tailDecay: 0.7, thumpFrom: 120, thumpTo: 38 },
    casing: true, pumpTime: 0.45,
    reloadKind: 'shell', holdOpen: false,
    // 重い銃。構えが遠く、揺れが大きく、跳ね返りが遅い。
    // 機械照門なので覗いた時に目へ近づける。
    // 全長がライフルより長いので、同じ縮尺でも銃口はもう一段先へ出る
    view: {
      scale: 0.90, adsScale: 0.56, adsDist: 0.105,
      hip: [0.205, -0.168, -0.560], hipRot: [-0.008, 0.013, 0.11],
      bob: 1.80, sway: 1.35, kickK: 205, kickD: 17,
      // 1発が重い銃なので大きく蹴り上げる。バネが柔らかい（kickK 205）ぶん戻りも遅い
      kickUp: 2.20, kickSide: 0.70,
      boltTravel: 0, boltTime: 0.10, lower: 0.29,
    },
  },
  {
    id: 'pistol', name: 'P-9 サイドアーム', nick: 'ピストル', build: buildPistol,
    // ライフルとショットガンの間に「軽くて素早いが火力が低い」枠が無かった。
    // 体力130に対して胴26＝5発。ライフルと同じ発数だが、
    // 連射が400/分（ライフルは640）なので**当て続ける時間が1.6倍かかる**。
    // 撃ち合いを正面から始めたら勝てない、という位置付けにする
    damage: 26, headMult: 2.0, rpm: 400, auto: false, pellets: 1,
    // 弾倉15発は「1人倒すと3発しか残らない」量。2人目に会う前に入れ直す判断が要る
    mag: 15, reserve: 75, reloadTime: 1.55,
    // 腰だめはライフル(0.024)より広い。近い距離だけ成立する形は同じだが、
    // 覗いた時の集束はライフルより甘くして、遠距離では選ばれないようにする
    spreadHip: 0.030, spreadAds: 0.0032, spreadPerShot: 0.0050, spreadMax: 0.062, spreadRecover: 0.14,
    recoilPitch: 0.0165, recoilYaw: 0.0052, kick: 0.045, adsFov: 55, adsTime: 0.11,
    // 射程はライフルの半分ほど。40mを超えると半分以下の威力になる
    range: 70, falloffStart: 18, falloffEnd: 46, falloffMin: 0.42,
    // 小さい銃なので胴を高めに、余韻を短く。ライフルの300Hzより上げて
    // 「パン」と切れる音にする。腹に来る低音(thump)は持たせない
    sound: { volume: 0.62, bodyFreq: 420, crackFreq: 3900, bodyDecay: 0.13, tailDecay: 0.38, thumpFrom: 150, thumpTo: 62 },
    casing: true,
    reloadKind: 'mag', holdOpen: true,
    // 軽いぶん速く歩ける。ナイフ(1.35)ほどではない
    moveMul: 1.12,
    view: {
      // 全長19cmしかないので、ライフルと同じ縮尺だと画面で豆粒になる。
      // 1.0だと本体が画面の6〜10%しか占めず、何を持っているのか読めなかった
      scale: 1.28, adsScale: 0.86, adsDist: 0.125,
      // 握把と弾倉が画面の下へ抜けるのは拳銃では正常で、どのFPSもそう描く。
      // 見せたいのはスライドと照準なので、そこが枠に入る高さまで持ち上げる。
      // 総当たりで測ると、y=-0.150では本体の21.8%が枠外（弾倉の底が画面外）、
      // -0.085まで上げると17.8%。上げすぎると今度は銃が視界の真ん中に立つ。
      // 奥行きは-0.46。それより手前だと縮尺を上げた時に腕が目へ届く
      hip: [0.185, -0.080, -0.460], hipRot: [-0.008, 0.013, 0.10],
      grip: { armDir: [0.36, -0.78, 0.34], armLen: 0.34 },
      // 小さい銃は揺れも反動も速い。跳ね上げはライフル(1.30)より大きいが、
      // バネが硬い(kickK 340)ので戻りも速く、連射が効かないぶん撃つたびに収まる
      bob: 1.15, sway: 0.90, kickK: 340, kickD: 23,
      kickUp: 1.70, kickSide: 0.55,
      boltTravel: 0.022, boltTime: 0.060, lower: 0.21,
    },
  },
  {
    id: 'knife', name: 'ナイフ', nick: 'ナイフ', build: buildKnife, melee: true,
    // 胴で2回、頭なら1回。体力130に対して胴70×2＝140。
    // 1回で倒せると近づくだけで勝ててしまい、銃が要らなくなる
    // autoをtrueに。長押しで振り続けられないと、近接なのに
    // 1回ずつ押し直す操作になって間合いを詰める動きと噛み合わない
    damage: 70, headMult: 2.0, rpm: 95, auto: true, pellets: 1,
    // 弾を持たない。magを大きく取って装填も空撃ちも起こさせない
    mag: 9999, reserve: 0, reloadTime: 0,
    // 振りにばらつきは無い。当たるか当たらないかだけ
    spreadHip: 0, spreadAds: 0, spreadPerShot: 0, spreadMax: 0, spreadRecover: 1,
    recoilPitch: 0.012, recoilYaw: 0.004, kick: 0.05, adsFov: 70, adsTime: 0.16,
    /* ここが近接の全て。届く範囲では威力が一定（減衰を切ってある）。
       壁で止まるのは銃と同じ。
       **間合いはprotocol.jsのMELEE_SWEEPが持つ。**刃の太さと対で決まる値なので、
       ここに数字を書くと片方だけ動かした時に「広いのに近い」等が起きる */
    range: MELEE_SWEEP.LIGHT.reach,
    falloffStart: MELEE_SWEEP.LIGHT.reach, falloffEnd: MELEE_SWEEP.LIGHT.reach, falloffMin: 1.0,
    sound: { volume: 0.30, bodyFreq: 900, crackFreq: 4200, bodyDecay: 0.05, tailDecay: 0.12 },
    casing: false,
    reloadKind: 'mag', holdOpen: false,
    // 持っている間だけ速く走れる。銃を下ろして身軽になるぶん。
    // 他の武器はこの値を持たないので、読む側は既定を1として扱う
    moveMul: 1.35,
    view: {
      // 縮尺を1.0から1.4へ。刃が画面に占める面積が9.0%→16.8%になる。
      // 短剣は元が小さいので、銃と同じ縮尺だと「持っているのが分かる」大きさに届かない
      scale: 1.4, adsScale: 0.86, adsDist: 0.20,
      // **構えを作り直した。** それまでは刃も腕も目の後ろまで突き抜けていて
      // （一番手前の頂点が目の7.1cm後ろ）、カメラの手前へ回った面は画面上で
      // 無限に広がるので、刃の断面と前腕が画面いっぱいに出ていた。
      // 実測では武器本体の頂点の75.6%が枠の外。包帯の手が「でかいしグロい」と
      // 言われたのと同じ壊れ方で、原因も同じ「位置」だった。
      //
      // 直したのは3つ:
      //   ・奥行きを-0.280から-0.380へ。目から離して破裂を止める
      //   ・縮尺を1.4へ。離したぶん小さくなるのを取り返す
      //   ・腕の入る向き(grip.armDir)を下向きへ倒し、長さも0.62→0.30へ。
      //     それまでライフルと同じ[0.38,-0.62,0.92]で、Zが大きいぶん
      //     前腕が「手から目へ向かって」伸びていた
      // 結果: 一番手前16.0cm（ライフル10.3cm）、本体の枠外9.9%
      //
      // hipRotのzを0.30から0.95へ。刃を寝かせて画面を横切らせる。
      // 立てたままだと視界の中央に刃が壁のように立って前が見えない
      hip: [0.22, -0.16, -0.38], hipRot: [0.02, 0.04, 0.95],
      // 右手だけで持つ。腕は真下から入れて、目のほうへ戻さない
      grip: { armDir: [0.30, -0.86, 0.10], armLen: 0.30 },
      bob: 1.10, sway: 0.80, kickK: 320, kickD: 20,
      kickUp: 0.60, kickSide: 1.60,
      boltTravel: 0, boltTime: 0, lower: 0.18,
    },
  },
  {
    id: 'nade', name: '手榴弾', nick: '手榴弾', build: buildGrenade, melee: true, thrown: true,
    // ダメージはサーバーのNADEが持つ。ここの値は使われないが、
    // 表の形を揃えないと他の武器と同じ道を通れない
    damage: 0, headMult: 1, rpm: 40, auto: false, pellets: 1,
    mag: 9999, reserve: 0, reloadTime: 0,
    spreadHip: 0, spreadAds: 0, spreadPerShot: 0, spreadMax: 0, spreadRecover: 1,
    recoilPitch: 0.02, recoilYaw: 0.006, kick: 0.04, adsFov: 70, adsTime: 0.16,
    range: 0, falloffStart: 0, falloffEnd: 0, falloffMin: 1,
    sound: { volume: 0.20, bodyFreq: 700, crackFreq: 2600, bodyDecay: 0.04, tailDecay: 0.10 },
    casing: false,
    reloadKind: 'mag', holdOpen: false,
    moveMul: 1.15,
    view: {
      // 玉そのものが直径6cmしかないので、縮尺1.0だと画面の5.4%しか占めず、
      // 「何か持っている」以上の情報が出ない。1.45で12%前後になる
      scale: 1.45, adsScale: 0.9, adsDist: 0.20,
      // ナイフと同じ直し方。腕がライフルの向きのままで、
      // 一番手前の頂点が目から0.8cm（＝ほぼ目の中）にあった。
      //
      // 右手を胸の高さまで上げて、玉を握って構える形にする。
      // これ以上high上げると（yを-0.06や0.02にすると）玉が画面の右上へ抜けて、
      // 本体の枠外が42%・83%まで跳ねる。振りかぶりは「上げる」より
      // 「手前へ引いて傾ける」ほうが枠に収まる
      hip: [0.26, -0.11, -0.44], hipRot: [-0.30, 0.20, 0.45],
      // 腕は右下から入れる。Zを0.16まで落として目のほうへ戻さない
      grip: { armDir: [0.44, -0.78, 0.16], armLen: 0.32 },
      bob: 1.10, sway: 0.85, kickK: 320, kickD: 20,
      kickUp: 0.40, kickSide: 0.30,
      boltTravel: 0, boltTime: 0, lower: 0.18,
    },
  },
  {
    id: 'sniper', name: 'SR-12 マークスマン', nick: 'スナイパー', build: buildSniper,
    /* **1発の重さで勝負する銃。** 数字の決め方はこう:
       ソロの敵は波が進むほど固くなり、体力は 100+min(波*12,120) で最大220。
       胴110なら一番固い敵でもちょうど2発、頭は110*2.0=220で1発で倒れる。
       ここを110より下げると、波が進んだ途端に「胴3発・頭2発」に化けて、
       持っている意味が薄れる（一番当たらない銃が一番手数も要ることになる）。
       対戦には出ないが、出したくなった時のために書いておくと、
       人の体力は130なので胴2発・頭1発で同じ手触りになる */
    damage: 110, headMult: 2.0, rpm: 48, auto: false, pellets: 1,
    /* **弾は全部で10発。** 遊んで「撃ち放題というよりは、5発とサブが5発の
       合計10発かな」と言われた所。他の銃は予備を5弾倉ぶん持つ（ライフルなら125発）が、
       この銃だけ予備を1弾倉ぶんにする。
       1波を凌ぐのに10発しか無いので、**外すと素直に減る。**
       波の切れ目（体力と弾の補給が入る所）でだけ満タンに戻る */
    mag: 5, reserve: 5, reloadTime: 3.0,
    /* 腰だめは捨てる。0.055は20m先で1.1mに散る量で、当たったら事故という広さ。
       覗いた時だけ0.0004（20m先で8mm）まで締まる。
       **「覗かないと何もできない代わりに、覗けば当たる」**を数字で作る */
    spreadHip: 0.055, spreadAds: 0.0004, spreadPerShot: 0.010, spreadMax: 0.075, spreadRecover: 0.22,
    recoilPitch: 0.055, recoilYaw: 0.010, kick: 0.13,
    /* ここが「アサルトより遠くまで覗ける」の実体。
       ライフルの46度に対して16度なので、覗いた時の見え方は約3倍の大きさになる。
       覗き終わるまでの時間も長くする（重い銃を担ぎ上げる分）*/
    adsFov: 16, adsTime: 0.34,
    /* 覗いている間の視点の効き。既定は0.45（＝感度55%）だが、3倍に伸びた画で
       同じ効きだと、画面上では3倍の速さで景色が流れて狙いが定まらない。
       0.72（＝28%）まで落とす。**倍率を上げる時はここも一緒に動かすこと** */
    adsSlow: 0.72,
    // 遠くでも威力が落ちにくい。100mまで素通し、180mで8割
    range: 200, falloffStart: 100, falloffEnd: 180, falloffMin: 0.8,
    /* **1発ごとに「撃った」と分かる音にする。**
       遊んで「もっとかっこよく、1発のプレミア感、派手に」と言われた所。
       他の銃と同じ形のまま音量だけ上げても、それは「大きい同じ音」にしかならない。
       時間の中に4つの出来事を並べて、耳が順番に聞ける形にする:

         0.00秒 鋭い破裂（crackVol 0.62。ライフルは0.49）
         0.00秒 腹に来る低音が0.34秒かけて150→24Hzまで落ちる（ライフルは0.085秒で110→44）
         0.02秒 尾が鳴り始めて1.5秒引く（ライフルは0.62秒）
         0.03秒 サブベースが遅れて入る（subDelay。同時だと波の頭が足されて潰れる）
         0.42秒 遊底を送る金属音（boltAfter。手で送る銃だけ）

       胴を180Hzまで下げてあるのは、ライフル(300)と同じ帯に置くと
       破裂と混ざって1枚の板になるため。低い所へ逃がすと2つの層として分かれて聞こえる。

       実測（tools/check-sound.mjsの[4.5]が毎回測る）:
         低音34.6%（ライフル24.2%）・重心2399Hz（2530Hz）・実効0.141（0.115）
       つまり**ライフルより低くて大きい**。音量だけ上げても山が限界に当たって
       潰れるだけなので、上げたのは低い層と尾のほう */
    sound: {
      volume: 0.84, bodyFreq: 180, crackFreq: 3400,
      bodyDecay: 0.34, tailDecay: 1.50, tailVol: 0.58, crackVol: 0.62,
      thumpFrom: 150, thumpTo: 24, thumpTime: 0.34,
      subVol: 0.72, subTime: 0.38, subDelay: 0.03,
      boltAfter: 0.42,
    },
    casing: true,
    reloadKind: 'mag', holdOpen: true,
    // 重い。担いでいる間は少し遅くなる
    moveMul: 0.92,
    view: {
      /* 全長がライフルの1.27倍あるので、同じ縮尺だと画面から銃身がはみ出す。
         縮尺を落として、そのぶん構えを手前へ引かない（引くと今度は銃床が目に近づく）。
         adsScale/adsDistは望遠照準の寸法とセットで決まっている値で、
         **動かすと addScope のケラレの計算が変わる。** あちらのコメントを読むこと */
      scale: 0.78, adsScale: 0.60, adsDist: 0.130,
      // 構えの向きはライフルとほぼ同じ。銃身とクロスヘアのズレは0.72度
      hip: [0.205, -0.150, -0.505], hipRot: [-0.006, 0.011, 0.10],
      // 重い銃なので揺れは大きく、跳ね返りは遅い
      bob: 1.65, sway: 1.30, kickK: 180, kickD: 15,
      // 1発が重いので大きく蹴り上げる。ショットガン(2.20)より上に置く
      kickUp: 2.60, kickSide: 0.50,
      // 遊底の行程。撃つたびに5.5cm引かれて戻る（_animatePartsが動かす）
      boltTravel: 0.055, boltTime: 0.30, lower: 0.30,
    },
  },
];

/* ------------------------------------------------------ 装填の工程表 */

// 左手の道のり。区間ごとに握り位置を切り替える。
// audio.reload()が全体の4%/42%/70%/88%で音を鳴らすので、そこへ動きを合わせる
const PATH_EMPTY = [
  [0.00, 0.10, 'rest', 'rest'],
  [0.10, 0.40, 'rest', 'mag'],
  [0.40, 0.54, 'mag', 'low'],
  [0.54, 0.68, 'low', 'mag'],
  [0.68, 0.78, 'mag', 'mag'],
  [0.78, 0.88, 'mag', 'charge'],
  [0.88, 1.00, 'charge', 'rest'],
];
// 弾が残っている時は槓桿を引かないので、そのまま構えに戻る
const PATH_TAC = [
  [0.00, 0.10, 'rest', 'rest'],
  [0.10, 0.40, 'rest', 'mag'],
  [0.40, 0.54, 'mag', 'low'],
  [0.54, 0.70, 'low', 'mag'],
  [0.70, 0.80, 'mag', 'mag'],
  [0.80, 1.00, 'mag', 'rest'],
];
/* 装弾は1発ずつ。**この表は「1発ぶん」で1周する。**
   弾が1つ増えるたびに頭から回り直すので、7発入れれば7周する。
   以前はここに4回ぶんの往復を並べて、全部終わってから弾を7発まとめて足していた。
   見た目は1発ずつ入れているのに、中身は弾倉ごと入れ替える武器と同じだったので、
   途中でやめると1発も増えていなかった */
const PATH_SHELL = [
  [0.00, 0.18, 'low', 'low'],    // 次の1発を掴む
  [0.18, 0.52, 'low', 'mag'],    // 装弾口へ運ぶ
  [0.52, 0.70, 'mag', 'mag'],    // 押し込む
  [0.70, 1.00, 'mag', 'low'],    // 手を戻す
];
// シェルが見えている区間（運んでいる間だけ手に持っている）
const SHELL_INS = [[0.12, 0.62]];

/* ------------------------------------------------------------ 実装 */

class Weapon {
  /**
   * @param def 武器の表の1つ
   * @param viewScene ビューモデルを置く場面
   * @param plain trueなら**スキンを一切着けない素の姿**で組む。
   *              観戦（デスカメラ）で他人の武器を出す時に使う。
   *              2026-08-11まで観戦でも自分の模型を出していて、
   *              **相手が自分のスキンを着けて見えていた**
   */
  constructor(def, viewScene, plain = false) {
    this.def = def;
    this.plain = plain;
    const v = def.view;
    // 組み立てにviewを渡す。**握り方（腕の入る向き・長さ・手の位置）を
    // 武器ごとに変えられるようにするため。** 渡さなかった頃は4つとも
    // ライフルの値で腕が入っていて、ナイフも手榴弾もライフルの構えに見えていた
    /* **どの組み立てで作ったか。** 形違いのスキン（刀・ダガー）は
       組み立てそのものが別なので、着け替えの時にここを見て
       「作り直しが要るか」を決める（WeaponSystem.refreshSkins）*/
    this.builtWith = plain ? def.build : (shapeOf(skinFor(def.id)) || def.build);
    /* 着けている形違いスキンのid（色だけならnull）。**振り方と銃声がここを見る。**
       撃つたびに引き直さないのは、skinFor が中で品揃えの配列を作るため。
       毎秒12発の銃だと、その配列を毎秒12個捨てることになる */
    this.shapeId = plain ? null : shapeIdOf(def.id);
    this.inner = this.builtWith(v);
    // ビューモデルは実寸のまま出すと画面を埋め尽くす。内側で縮めてから構える
    this.inner.scale.setScalar(v.scale);
    this.parts = this.inner.userData;

    // 外側は姿勢制御用。縮尺と分けておくとADSの逆算が素直になる
    this.model = new THREE.Group();
    this.model.add(this.inner);
    this.model.visible = false;
    viewScene.add(this.model);

    /* 買った（もらった）3Dモデルが assets/models/<id>.glb に置いてあれば、
       見えている所だけ差し替える。**置いていなければ何も起きない。**
       読み込みは後から届くので、ここでは頼むだけで待たない
       （待つと、素材を持たないこのゲームで起動が素材待ちになる） */
    tryModelOverride(this, def.id).catch(() => {});

    /* 選んだスキンの色を被せる。**組み上がった後で材質だけ差し替える。**
       形の違いは上の builtWith が既に効いているので、ここは色だけ。
       素の姿(plain)で組む時は標準を渡して、何も被せない */
    applySkin(this.inner, plain ? DEFAULT_SKIN : skinFor(def.id));

    this.ammo = def.mag;
    this.reserve = def.reserve;
    this.spread = def.spreadHip;
    // 撃ち切るとボルトが後退したまま止まる。弾切れが目で分かる
    this.boltLocked = false;

    this.hipPos = new THREE.Vector3(v.hip[0], v.hip[1], v.hip[2]);
    this.hipRot = new THREE.Euler(v.hipRot[0], v.hipRot[1], v.hipRot[2]);

    // 覗いた時にサイトが画面中心へ来る位置を逆算する（ADS時の縮尺で計算する）
    const s = this.parts.sight.position;
    this.adsPos = new THREE.Vector3(
      -s.x * v.adsScale,
      -s.y * v.adsScale,
      -v.adsDist - s.z * v.adsScale,
    );
    this.adsRot = new THREE.Euler(0, 0, 0);

    this.model.position.copy(this.hipPos);
    this.model.rotation.copy(this.hipRot);

    // 手の道のりは毎フレーム作らずに済むよう先にVector3/Eulerへ直しておく
    this.holdL = {};
    const hl = this.parts.holdL;
    if (hl) {
      for (const k in hl) {
        this.holdL[k] = {
          p: new THREE.Vector3(hl[k][0][0], hl[k][0][1], hl[k][0][2]),
          r: new THREE.Euler(hl[k][1][0], hl[k][1][1], hl[k][1][2]),
        };
      }
    }
    const mr = this.parts.magRest;
    this.magRest = mr ? new THREE.Vector3(mr[0], mr[1], mr[2]) : null;

    // マズルフラッシュ（板を直交させて立体感を出す）。
    // 材質は武器ごとに別インスタンスにする。共有すると1挺の減衰が全挺に飛ぶ。
    //
    // 白(1,1,1)で出していたので、発砲ピークの最高輝度が(234,225,181)＝空(236,234,231)より
    // 暗く、昼間の絵の中で「光っている物」として読めなかった。
    // toneMapped:falseなので色をそのままHDRへ振れる。芯を確実にクリップさせて
    // postfxのbloom閾値(0.95)を越えさせる。青を抑えて炎の色温度に寄せる。
    //
    // depthTestを切るのは、板が銃口点(z=-0.685)に置かれていて、そのすぐ後ろにある
    // 消炎制退器の爪(-0.672)が深度で板を切り抜き、フラッシュの幾何中心に
    // 12x14pxの暗い穴が開いていたため。板は銃の最前面にしか出ないので、
    // 深度を切っても手前の物を突き抜ける事故は起きない
    this.flashMat = new THREE.MeshBasicMaterial({
      map: muzzleFlashTexture(128),
      color: new THREE.Color(5.0, 4.2, 2.6),
      transparent: true, opacity: 1, blending: THREE.AdditiveBlending,
      depthWrite: false, depthTest: false, side: THREE.DoubleSide, toneMapped: false,
    });
    this.flash = new THREE.Group();
    // 正面から見える主板。正方形2枚を直交させると回転対称の星にしかならないので、
    // 横に潰した1枚を主役にして、縦の板は細く短くする
    const f1 = new THREE.Mesh(planeG(0.34, 0.34), this.flashMat);
    f1.rotation.y = Math.PI / 2;
    f1.scale.set(0.62, 0.72, 1);
    const f2 = new THREE.Mesh(planeG(0.34, 0.34), this.flashMat);
    f2.scale.set(1.4, 1.0, 1);
    this.flash.add(f1, f2);
    // 制退器のポートから横へ吹く分。前方の板だけだと丸い花火にしか見えない。
    // 左右で大きさを変えて、対称の星に見えないようにする
    let k = 0;
    for (const sx of [1, -1]) {
      const p = new THREE.Mesh(planeG(0.13, 0.13), this.flashMat);
      p.position.set(sx * 0.055, 0.008 * sx, 0.020);
      p.rotation.set(0, 0, sx * 0.5);
      p.scale.setScalar(k++ === 0 ? 1.15 : 0.85);
      this.flash.add(p);
    }
    this.flash.position.copy(this.parts.muzzle.position);
    // 爪より前へ出す。板の中心が銃の実体の中にあると、どの角度でも一度は食われる
    this.flash.position.z -= 0.020;
    this.flash.visible = false;
    this.inner.add(this.flash);

    // 発砲後に銃口へ残る薄い煙。板と光が同時に消えると
    // 「銃口にシールを貼って剥がした」画になるので、煙だけ長く引く
    this.smokeMat = new THREE.MeshBasicMaterial({
      map: smokeTexture(128), color: 0x9b968c,
      transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    });
    this.smoke = new THREE.Mesh(planeG(0.16, 0.16), this.smokeMat);
    this.smoke.position.copy(this.parts.muzzle.position);
    this.smoke.position.z -= 0.02;
    this.smoke.visible = false;
    this.smoke.renderOrder = 12;
    this.inner.add(this.smoke);
  }

  get totalAmmo() { return this.ammo + this.reserve; }

  // 可動部を初期状態へ戻す。持ち替えや復活で中途半端な姿勢が残らないようにする
  restPose() {
    const P = this.parts;
    if (P.bolt) P.bolt.position.z = P.boltRest;
    if (P.dust) P.dust.rotation.z = 0;
    if (P.mag && this.magRest) {
      P.mag.position.copy(this.magRest);
      P.mag.rotation.set(0, 0, 0);
      P.mag.visible = true;
    }
    if (P.pump) P.pump.position.z = P.pumpRest;
    if (P.shell) P.shell.visible = false;
    if (P.trigger) P.trigger.rotation.x = 0;
    if (P.handR && P.handR.userData.index) {
      P.handR.userData.index.rotation.x = 0;
      P.handR.userData.index.position.z = P.handR.userData.indexZ;
    }
    if (P.handL && this.holdL.rest) {
      P.handL.position.copy(this.holdL.rest.p);
      P.handL.rotation.copy(this.holdL.rest.r);
    }
    // 持ち替えを跨いで前の銃の発砲演出が残らないようにする
    this.flash.visible = false;
    this.smoke.visible = false;
    this.smokeMat.opacity = 0;
    this.boltLocked = false;
  }
}

export class WeaponSystem {
  constructor(viewScene, camera, viewCamera, scene) {
    this.camera = camera;
    this.viewCamera = viewCamera;
    this.viewScene = viewScene;
    // モデルは全部組む。持っていない武器でも、ガンゲームで配られた瞬間に
    // 組み始めると持ち替えのたびに一瞬止まる
    this.weapons = WEAPONS.map((d) => new Weapon(d, viewScene));
    // **今持って出ている物の番号。** 表にあること（weapons）と
    // 持っていること（carry）は別で、既定は protocol.js の LOADOUT_IDS。
    // ガンゲームや将来の武器選択画面はここを差し替えるだけで済む
    this.carry = loadoutOf(WEAPONS);
    this.index = this.carry[0] ?? 0;
    /* **数字キーに載らない武器。** 今は1人用で第2波から支給される狙撃銃で、
       Qで出し入れする（main.jsの_applySoloCarryが番号を入れる）。
       nullなら「そんな物は持っていない」＝Qを押しても何も起きない。
       quickBackは、Qで戻る時の行き先（Qを押す直前に持っていた物） */
    this.quickIndex = null;
    this.quickBack = null;
    /* **射撃訓練場だけで持てる武器。** Eで出し入れする。
       2026-08-11に「射撃訓練の時だけはショットガン出しておいて」で足した所。

       quickIndex(Q)と同じ「数字キーに載せない枠」にしてあるのは、
       carryへ入れると自動で5番になって、**5番は武器を見るモーションに使う**ため
       （main.jsのDigitの回しは carry.length ぶん回る）。
       枠を2つに分けているので、訓練場ではQ=狙撃銃・E=ショットガンが同時に持てる。
       nullなら「そんな物は持っていない」＝Eを押しても何も起きない */
    this.rangeIndex = null;
    this.rangeBack = null;
    /* 武器を見ている残り時間（5キー）。0で構えに戻っている。
       **撃つ・装填する・覗く・持ち替える・走るのどれかが来たら途中で止める。**
       止めないと、眺めている最中に撃てて「銃を横に向けたまま弾が出る」ことになる */
    this.inspect = 0;
    // 観戦中に出している相手の武器（showSpectated）。nullなら自分の物
    this._specWeapon = null;
    /* 観戦で出す**素の姿の模型**。武器番号 → Weapon。
       要求された時に1本ずつ組んで、以降は覚えておく。
       自分のスキンが乗った模型を使い回すと、相手が自分のスキンで見える */
    this._plain = new Map();
    this.current.model.visible = true;

    this.adsFactor = 0;
    this.wantAds = false;
    // 覗き込みの入り切り。右クリックを押すたびに反転する
    this.adsHeld = false;
    this.reloading = 0;
    // 1発ずつ入れている途中か。reloadingは「今の1発の残り時間」しか持たないので、
    // 「まだ続きがある」はこちらで持つ。ここを落とすと、途中で持ち替えた後に
    // 1発だけ入って止まる
    this.shellReload = false;
    // 1発ずつ入れる時に銃を下ろしている量。1発ごとに上下させないためのもの
    this._shellLower = 0;
    this.switching = 0;
    this.pumping = 0;
    this.fireTimer = 0;
    // バーストの残り発数。覗いている間だけ使う
    this.burstLeft = 0;
    // 近接の振りの残り時間。0で構えに戻っている
    this.swing = 0;
    // 今どの振り方で動いているか（SWINGSの1つ）。振り始めた時に決まる。
    // **振っている最中に装備を替えても、始めた時の動きで振り切る**
    // （途中で別の軌道へ飛ぶより、1回ぶん古い動きの方がまし）
    this.swingAnim = SWINGS['knife.light'];
    /* 刃が届くまでの残り時間。0より大きい間は「振りかぶっているが、まだ当たらない」。
       **2026-08-11に足した。**それまでは押した瞬間に当たり判定を出していて、
       刀の右クリックだと**突き出す0.36秒前にダメージが入っていた**。
       詳しくは _strikeDelay のコメント */
    this.strikeIn = 0;
    // 手榴弾を長押しで構えている最中か。trueの間に離すと投げる
    this._throwCharging = false;
    /* 投げ物の残り。**弾倉と違って武器ではなく持ち主が持つ物**なので、
       Weaponではなくこちらに置く（拾った時も1箇所を足せば済む）。
       ソロは投げた瞬間に、対戦はサーバーが「飛んだ」と言ってきた時に減る。
       0になったら手から下ろす（takeNade を参照）*/
    this.nades = NADE.PER_ROUND;
    // 投げ切ったので、投げ終わったら手から下ろす、の印
    this._holsterThrown = false;
    // 自分から持ち替えた時に知らせる先。対戦では持っている物をサーバーへ
    // 伝え直さないと、画面と当たり判定が別々の武器になる
    this.onSwitched = null;
    this.flashTimer = 0;
    this.flashLife = 0.035;
    this.flashBase = 1;
    this.smokeTimer = 0;
    this.smokeSeed = 0;
    this.shotIndexInMag = 0;

    // 反動の跳ね返り用バネ。
    // Zは奥行きなので画面上ではほぼ拡大縮小にしかならない。撃った事を画で見せるのは
    // 画面と平行に動くX/Yなので、同じバネをそちらにも持たせる
    this.kickZ = 0; this.kickZv = 0;
    this.kickY = 0; this.kickYv = 0;
    this.kickX = 0; this.kickXv = 0;
    this.kickPitch = 0; this.kickPitchV = 0;
    this.kickYaw = 0; this.kickYawV = 0;
    this.swayX = 0; this.swayY = 0;

    // 包帯。Fで手に持ち、左クリックで巻く。
    // ここで作っておかないと、_animate側の「包帯を出す」処理が
    // this.bandage が undefined のまま素通りして、何も現れない
    this.bandage = this._buildBandage(viewScene);
    this.bandageOut = false;
    this._healBlend = 0;
    this._wasHealing = false;
    this.idleTime = 0;
    // 撃っている間はスプレッドの回復を止める（連射で開かせるため）
    this.spreadHold = 0;

    // 可動部。ボルトの往復・弾倉の揺れ・引金の引き
    this.boltCycle = 0;
    this.magWob = 0; this.magWobV = 0;
    this.trigT = 0; this.trigTarget = 0;

    // ポンプ式の排莢は遅れて出る。setTimeoutだと持ち替えや復活を跨いで飛ぶので
    // 自前のタイマーで持つ
    this._ejectDelay = -1;
    this._ejectPos = new THREE.Vector3();
    this._ejectDir = new THREE.Vector3();

    // 環境を照らす発砲光。これがあると夜でなくても迫力が出る
    this.muzzleLight = new THREE.PointLight(0xffb060, 0, 14, 2);
    this.muzzleLight.castShadow = false;
    scene.add(this.muzzleLight);

    // 銃と手はviewSceneにいて、本編のsceneとはRenderPassが別なので、
    // 上の発砲光は絶対に届かない。何もしないと発砲の瞬間に壁だけがオレンジに光って
    // 銃と手は真っ黒なまま止まり、フラッシュが銃の前に貼ったシールに見える。
    // ビューモデル側にもう1灯置いて、画面に写っている銃の左面と弾倉・手袋の甲を前から焼く。
    //
    // 前は銃口に点光源（distance 1.2）を置いていたが、銃口から機関部までは20cmしかなく、
    // しかも面をかすめる角度で当たるので、法線マップの凹凸1つ1つがスペキュラになって
    // 機関部が高周波のオレンジ斑点に化けていた（銃の勾配エネルギーの19.5%がこの光由来）。
    // それが発砲のたびに3〜4フレーム続いて元に戻るので、表面が這って見える＝「ブレ」。
    // 向きは実測で選んだ。銃口の側（前・下・右）から当てると平行光にしても面をかすめるので
    // 同じ斑点が出る（明るさ+2.0%に対して勾配+20.5%）。画面に写っているのは銃の左面なので、
    // そこへ正面から当たる前・左・やや下だと明るさ+33.4%に対して勾配+29.8%と、
    // 明るさ1%あたりの荒れが1/5になる。強度は明るさが+15%前後に収まるところ
    this.viewMuzzleLight = new THREE.DirectionalLight(0xffb060, 0);
    this.viewMuzzleLight.position.set(-0.60, -0.20, -1.0);
    this.viewMuzzleLight.castShadow = false;
    viewScene.add(this.viewMuzzleLight);

    // 手専用の当て光。握把側の面が黒く潰れると、手が銃と同じ塊に溶けて指が読めない。
    // ただし1.2はキー(vSun 4.2)の29%もあり、手が日向の砂嚢と同じ輝度(平均135)まで光って
    // 「白い塊」に見える原因になっていた。手袋のアルベドを0x6e747c→0x3a3e42へ落とした時点で
    // 線形反射率は25%まで落ちている（sRGBの出力比で約0.53、135→約72）ので、
    // 当て光まで1/3にすると今度は手が銃(32-88)へ沈んで指が読めなくなる。
    // キーの12%まで下げて、手の輝度帯を60-110＝銃の一段上に置く
    const handFill = new THREE.DirectionalLight(0xdfe6f0, 0.5);
    handFill.position.set(0.5, -0.3, 0.8);
    viewScene.add(handFill);
    // 逆方向の弱いリム。指の輪郭を銃から抜くのに要る。
    // 当て光だけだと手と銃の境目が値でつながったままになる
    const handRim = new THREE.DirectionalLight(0xffd0a0, 0.5);
    handRim.position.set(-0.6, 0.4, -0.5);
    viewScene.add(handRim);

    this.onShot = null;
    this.onSound = null;
    this.onEject = null;
  }

  /**
   * 包帯の見た目。巻いている間だけ手元に出す。
   * 武器とは別に1つだけ持って、使う時に見せる（武器ごとに作らない）
   */
  /**
   * 手に持つ包帯。巻いた帯と、それを握る右手。
   *
   * 手を付けるのは見栄えのためだけではない。武器を下ろしている間に
   * 布の塊だけが浮いていると、画面のどこかに物が置いてあるようにしか見えず、
   * 「自分が今それを持っている」情報が出ない。
   */
  _buildBandage(viewScene) {
    const g = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({
      color: 0xd8d2c4, roughness: 0.92, metalness: 0,
    });
    // 血の染みた側。無地の白い塊だと医療品に見えず、ただの筒になる
    const stain = new THREE.MeshStandardMaterial({
      color: 0x9c4034, roughness: 0.95, metalness: 0,
    });
    const roll = new THREE.Group();
    // 巻いた帯の芯。円筒を横に寝かせる
    roll.add(part(cylG(0.030, 0.030, 0.052, 14), cloth, 0, 0, 0, 0, 0, Math.PI / 2));
    // 巻きの層。太さの違う輪を重ねて「巻いてある」ことを出す
    roll.add(part(cylG(0.034, 0.034, 0.016, 14), cloth, -0.014, 0, 0, 0, 0, Math.PI / 2));
    roll.add(part(cylG(0.033, 0.033, 0.014, 14), cloth, 0.012, 0, 0, 0, 0, Math.PI / 2));
    // 赤い帯を1本入れて医療品だと分かるようにする
    roll.add(part(cylG(0.0345, 0.0345, 0.006, 14), stain, 0.000, 0, 0, 0, 0, Math.PI / 2));
    // 引き出した端。手前へ垂らす
    roll.add(part(boxG(0.030, 0.002, 0.075), cloth, 0.012, -0.028, 0.030));
    g.add(roll);
    g.userData.roll = roll;

    // 握る手。
    //
    // ここは「手の形はしているが、帯を握っていない」状態だった。
    // 手の握り軸はローカルYで、帯は横に寝た円筒なので軸はX。
    // 元の向き(-0.20, 0, -0.35)だと**その2つが69.9度ずれていて**、
    // 指が帯を回り込まずに横切る形で閉じていた。
    // 下の値でずれは8.0度になる（ライフルの支え手が8.9度なので同じ範囲）。
    //
    // roll と skew を渡すのも同じ理由。渡さないと真横から握る形になり、
    // 画面には甲の塊しか出ない（buildHandのrollの説明を参照）。
    // 握る対象の太さ(gripR 0.031)はライフルの先台と同じなので、
    // 詰め済みの値をそのまま借りる
    // armDirとarmLenは前腕がどこへ抜けるかを決める。
    //
    // ここは [0.42, -0.70, 0.90] / 0.58 だった。手前(+z)へ0.43m伸ばす向きで、
    // 包帯そのものが目から25cmしか離れていないので、**前腕の先が目より
    // 26cm手前へ突き抜けていた。** 1307頂点のうち972個がカメラの手前にある状態で、
    // 手前に来た面は画面上で無限に広がるので、腕の断面が画面いっぱいに出る。
    // 「手がでかい」「手の形がグロい」の正体はこれ（形ではなく位置の問題）。
    //
    // 下向きを強くして短くする。前腕は画面の下から入って下へ抜ける形になり、
    // 一番手前でも目から18cm残る（ライフルを支える腕の16cmと同じ範囲）
    const hand = buildHand(1, {
      gripR: 0.031, wrap: 0.62, tip: -0.34, roll: 0.52, skew: 0.22,
      armDir: [0.42, -0.92, 0.62], armLen: 0.34,
    });
    hand.position.set(0.030, -0.006, 0.004);
    hand.rotation.set(-0.10, 0, -Math.PI / 2 + 0.14);
    g.add(hand);

    g.position.set(0.10, -0.14, -0.28);
    g.rotation.set(-0.35, 0.4, 0.2);
    // 縮尺は_animateが毎フレーム上書きするので、ここは組み立て時の目安でしかない
    g.scale.setScalar(1.18);
    g.visible = false;
    viewScene.add(g);
    return g;
  }

  /**
   * Fで包帯を出し入れする。出しただけでは回復しない（左クリックで巻く）。
   *
   * 押した瞬間に巻き始める形をやめた理由: 巻いている2.4秒は移動が半分以下に
   * 落ちるので、事故で押した時の代償が大きい。撃つのと同じ「構えてから引く」
   * 2段階にすると、指が滑って回復が始まることがなくなる。
   *
   * @returns 出したか（画面のヒント表示に使う）
   */
  toggleBandage(player) {
    // 巻いている最中は仕舞わせない。途中でしまえると、消費だけして
    // 回復しない操作が生まれる（中断したいなら撃つか武器を持ち替える）
    if (player.healing > 0) return true;
    if (this.bandageOut) { this.bandageOut = false; return false; }
    if ((player.bandages | 0) <= 0) return false;
    if (this.switching > 0) return false;
    this.bandageOut = true;
    // 構えの状態を引きずらない。覗いたまま包帯を出すと画角だけ狭いままになる
    this.reloading = 0;
    this.shellReload = false;
    this._shellLower = 0;
    this.adsHeld = false;
    this.burstLeft = 0;
    this.swing = 0;
    // 待っている判定も捨てる（持ち替えと同じ理由）
    this.strikeIn = 0;
    this.inspect = 0;
    return true;
  }

  /** 包帯をしまう。武器を選んだ時と、巻き終わった時に呼ぶ */
  holsterBandage() { this.bandageOut = false; }

  get current() { return this.weapons[this.index]; }
  get def() { return this.current.def; }

  /**
   * 見た目を掛け直す。**組んである全部の武器に、それぞれのスキンで掛ける。**
   *
   * 今持っている物だけに掛けると、持ち替えた瞬間に前の色へ戻る
   * （武器は起動時に全部組んであって、持ち替えは見せる物を替えているだけ）。
   *
   * **色なら材質を差し替えるだけ。形が違う時だけ作り直す。**
   * 作り直しが要るのは、覗いた時の寄せ先も閃光の付け先も
   * 組み立てから逆算しているため（内側だけ入れ替えると、そこが古いまま残る）。
   * 形を替えるのはホームで押した時だけなので、値段は高くない
   */
  refreshSkins() {
    for (let i = 0; i < this.weapons.length; i++) {
      const w = this.weapons[i];
      const want = shapeOf(skinFor(w.def.id)) || w.def.build;
      if (want !== w.builtWith) {
        // 古い方を場面から外してから差し替える。外さないと2挺重なって出る
        this.viewScene.remove(w.model);
        const fresh = new Weapon(w.def, this.viewScene);
        fresh.model.visible = w.model.visible;
        this.weapons[i] = fresh;
        continue;
      }
      applySkin(w.inner, skinFor(w.def.id));
      // 色だけの着け替えでも、形違いから色違いへ戻した時にここが古いままになる
      w.shapeId = shapeIdOf(w.def.id);
    }
  }

  // 持ち替えが通ったかを返す。対戦では通った時だけサーバーへ知らせないと、
  // 弾かれた持ち替えまで送ってサーバー側だけ別の銃を構えることになる
  switchTo(i) {
    if (i === this.index || i < 0 || i >= this.weapons.length) return false;
    // 持っていない武器へは替われない。**サーバーも同じ判断をする**ので、
    // ここを外しても向こうで弾かれる（画面だけ持ち替わって当たり判定が
    // 元の武器のまま、という一番読めない食い違いになる）
    // **数字キーの4本＋Qの1本が持てる全部。** ここを外すと、
    // 画面に出ていない武器を握れることになる（対戦ではサーバーも同じ判断をする）
    if (!this.carry.includes(i) && i !== this.quickIndex && i !== this.rangeIndex) return false;
    // 使い切った投げ物は握らない。**無い物を持って構えるのが一番おかしい。**
    // 札は残したまま（残りの数を見せるため）、握るのだけ断る
    if (this.weapons[i].def.thrown && this.nades <= 0) return false;
    if (this.switching > 0) return false;
    this.reloading = 0;
    this.shellReload = false;
    this._shellLower = 0;
    this.switching = 0.42;
    // 持ち替えを跨いで前の武器の状態を残さない。
    // 振りの途中でナイフから銃へ替えると、銃が刃の軌道で振り回される
    this.swing = 0;
    // 眺めている最中に持ち替えたら、そこで見るのをやめる
    this.inspect = 0;
    /* **待っている判定も捨てる。** 捨てないと、振りかぶってすぐ銃へ持ち替えた時に
       銃を構えた状態で刃の判定が飛ぶ（見えない所から刺される形になる） */
    this.strikeIn = 0;
    this.burstLeft = 0;
    this.adsHeld = false;
    // 手榴弾を構えたまま(離さずに)持ち替えると、離した扱いが漏れて
    // 戻ってきた時に勝手に投げるということが起きる。持ち替えた時点で構えは解く
    this._throwCharging = false;
    this._pendingIndex = i;
    return true;
  }

  /**
   * 手榴弾を構えている途中（離せば投げる状態）を、投げずに断ち切る。
   * 一時停止で呼ぶ。pointerlockが外れるとinput.buttonsが黙って全部falseに
   * なるので、断ち切らずにいると再開した1フレーム目が「離した」と誤認して
   * 押してもいないのに手榴弾が飛ぶ（課題.md #1で新たに増えた状態なので、
   * 増やした側が閉じる）
   */
  cancelThrowHold() { this._throwCharging = false; }

  /**
   * Qで、数字キーに載らない武器（今は狙撃銃）を出し入れする。
   * 替われたらその番号、駄目ならnull。
   *
   * **数字キーを増やす代わりの物。** 一度5番へ足したが「5押すのは指的に遠い」
   * と言われた。WASDから指を浮かせずに届くのがQまでなので、そこへ寄せてある。
   *
   * 押すたびに行って戻る。行き先が固定なので、何を持っていても
   * 「Qを押せばあれが出る」で読める（直前の武器へ戻る形にすると、
   * 間に別の武器を挟んだ時にQが狙撃銃を指さなくなる）
   */
  /**
   * 観戦中に、**見ている相手の武器**を手元へ出す。nullで自分の物へ戻す。
   *
   * なぜ要るか: 手元の武器は自分専用の別の場面(viewScene)に浮かんでいて、
   * カメラがどこへ行こうが画面の手前に付いてくる。だから味方の目線を借りている間も
   * **自分の武器が写り続けて、見ている相手が自分と同じ武器を持って見えた**。
   * 場面ごと消して黙らせたら、今度は**手元に何も無い**（遊んで
   * 「デスカメラの時、味方とかの武器が見えてない」と言われた）。
   * 正しいのは「その人の武器を出す」で、ここがそれ。
   *
   * **動きは付かない。** 揺れも反動も覗きも、自分のplayerから作っている物なので、
   * 出るのは静止した銃になる。相手の腕の振りまで再現するには、
   * 送られてくる状態から手元の武器を丸ごと動かし直すことになるので、
   * そこは「何を持っているかが分かる」で足りると判断した。
   *
   * 毎フレーム呼ばれる前提。変わった時しか触らない
   */
  /**
   * 観戦（デスカメラ）で出す武器を切り替える。nullで自分の物へ戻る。
   *
   * **2026-08-11まで自分の模型をそのまま出していて、
   * 倒した相手が自分のスキンを着けて見えていた。**
   * 金色のライフルを着けていると、相手も金色のライフルで撃ってきたことになる。
   *
   * 直し方は「素の姿で組んだ模型を別に持って、観戦中はそちらを出す」。
   * **相手の本当のスキンは出せない。** スキンは今どこにも運ばれていなくて
   * （src/net/protocol.js に載っていない）、相手の3人称の姿も
   * 兵士モデルの銃で出しているため（src/net/remote.js の _applyWeapon）。
   * つまり**標準で出すのが、他の画面と揃った状態。**
   * 本当のスキンを出すには、スキンを電文に乗せる所から要る。
   *
   * 素の模型は**要求された時に1本だけ組んで覚えておく**（実測16〜40ms）。
   * 起動時に全部組むと、観戦しない人のぶんまで払うことになる
   */
  showSpectated(i) {
    const at = i == null ? null : (i | 0);
    if (at === this._specWeapon) return;
    this._specWeapon = at;
    for (const w of this.weapons) w.model.visible = false;
    /* 素の模型は**隠すだけでなく場面から外す。**

       2026-08-11に測って分かった所。隠すだけにしていたら、
       武器を替えながら何度か倒されるうちに場面の物が289→560個（メッシュ+206個）へ増えた。
       **隠れていても行列の計算は毎フレーム走る**（three.jsのupdateMatrixWorldは
       visibleを見ずに子を全部辿る。描くのを飛ばすのは描画側の判定）。

       実測では0.025→0.046msで熱の原因になる量ではないが、
       このrepoの決めごとが「描く物を増やしていないか」なので、増えたまま置かない。

       **覚えている物自体は捨てない。** 組み直しは実測16〜40msかかるので、
       次に倒れた時に払い直したくない。場面から出し入れするだけにする */
    for (const w of this._plain.values()) {
      w.model.visible = false;
      if (w.model.parent) this.viewScene.remove(w.model);
    }

    // 自分の物へ戻る
    if (at == null) {
      const mine = this.weapons[this.index];
      if (mine) { mine.restPose(); mine.model.visible = true; }
      return;
    }

    const def = this.weapons[at]?.def;
    if (!def) return;
    let w = this._plain.get(at);
    if (!w) {
      // Weaponのコンストラクタが自分でviewSceneへ入る（初回はここで足りる）
      w = new Weapon(def, this.viewScene, true);
      this._plain.set(at, w);
    } else if (!w.model.parent) {
      // 2回目以降。上で外してあるので戻す
      this.viewScene.add(w.model);
    }
    // 前に持っていた人の装填途中の姿勢が残らないよう、素の形へ戻してから出す
    w.restPose();
    w.model.visible = true;
  }

  quickSwap() {
    if (this.quickIndex == null) return null;
    if (this.index === this.quickIndex) {
      // 戻る先。覚えていない・もう持っていないなら主武器へ
      const back = this.carry.includes(this.quickBack) ? this.quickBack : this.carry[0];
      return back != null && this.switchTo(back) ? back : null;
    }
    const from = this.index;
    if (!this.switchTo(this.quickIndex)) return null;
    this.quickBack = from;
    return this.quickIndex;
  }

  /**
   * 武器を見る動きを始める（5キー）。始められたらtrue。
   *
   * **手が空いている時だけ。** 装填中・持ち替え中・覗いている間・包帯を持っている間、
   * それに投げ物を構えている間は断る。断らないと、
   * 眺める動きと元の動きが同じ姿勢へ二重に足されて、武器が画面外へ飛ぶ。
   *
   * 既に見ている最中にもう一度押したら止める（トグル）。
   * 1.6秒あるので、押し間違えた時に待たされるのは長い
   */
  startInspect() {
    if (this.inspect > 0) { this.inspect = 0; return false; }
    if (this.reloading > 0 || this.switching > 0 || this.shellReload) return false;
    if (this.adsHeld || this.adsFactor > 0.02) return false;
    if (this.bandageOut || this.swing > 0 || this._throwCharging) return false;
    this.inspect = INSPECT.time;
    return true;
  }

  /**
   * 訓練場のショットガン（E）の出し入れ。quickSwapと同じ形。
   *
   * **枠を2つに分けてあるので、Qの狙撃銃と同時に持てる。**
   * 1つの枠を使い回すと、訓練場で狙撃銃とショットガンのどちらか片方になる
   */
  rangeSwap() {
    if (this.rangeIndex == null) return null;
    if (this.index === this.rangeIndex) {
      const back = this.carry.includes(this.rangeBack) ? this.rangeBack : this.carry[0];
      return back != null && this.switchTo(back) ? back : null;
    }
    const from = this.index;
    if (!this.switchTo(this.rangeIndex)) return null;
    this.rangeBack = from;
    return this.rangeIndex;
  }

  /**
   * 投げ物を1つ使う。使えたらtrue。
   *
   * **使い切ったらその場で手から下ろす。** 遊んで「2発使い切ったら手榴弾持つのやめて。
   * 無くなってんだから」と言われた所で、それまでは0本になっても構え続けていて、
   * 左クリックのたびに空撃ちのカチッだけが鳴っていた。
   *
   * 持ち替え先は持ち物の先頭（＝主武器）。倒される直前に投げ切ることもあるので、
   * 手ぶらに近い物へ落とすのではなく、すぐ撃てる物へ戻す
   */
  takeNade() {
    if (this.nades <= 0) return false;
    this.nades--;
    /* **その場では替えない。** switchTo は持ち替えを跨いで前の武器の動きが
       残らないよう swing を0に戻すので、ここで呼ぶと投げる動作が
       始まった瞬間に消えて、玉だけ飛んで手は動かない絵になる。
       印だけ立てて、投げ終わり（update側）で替える */
    if (this.nades <= 0 && this.def.thrown) this._holsterThrown = true;
    return true;
  }

  /** 拾って増える。上限は1回の出撃で持てる数（超えたぶんは捨てる） */
  addNades(n) {
    const before = this.nades;
    this.nades = Math.min(NADE.PER_ROUND, this.nades + Math.max(0, n | 0));
    return this.nades - before;
  }

  /**
   * 装填を始める。始められたらtrue。
   *
   * 入れ方は2種類ある。
   *   弾倉ごと（mag）… 抜いて差して槓桿を引く。**途中で止められない**
   *   1発ずつ（shell）… 1発入れるたびに区切りがある。**いつでも止めて撃てる**
   *
   * 1発ずつの方は、ここでは1発ぶんの時間しか回さない。
   * 1発入り終わったところで update() が「まだ入るか」を見て、次の1発へ進める。
   * 全部を1本の時間で回してしまうと、途中でやめた時に
   * 「2.9秒のうち2秒ぶん入れたのに1発も増えていない」ことになる
   */
  reload() {
    // 近接は装填しない。Rを押すたびに空振りの動作が入るのを止める
    if (this.def.melee) return false;
    const w = this.current;
    if (this.reloading > 0 || this.switching > 0) return false;
    if (w.ammo >= w.def.mag || w.reserve <= 0) return false;
    this.shellReload = w.def.reloadKind === 'shell';
    this.reloading = this.shellReload ? w.def.shellTime : w.def.reloadTime;
    return true;
  }

  /**
   * 装填を始めた時の音。入れ方で鳴らす物が違うので、呼ぶ側に選ばせない。
   * ここを呼ぶ側（main.jsのRキーと、下の撃ち切り自動装填）が
   * それぞれ判断すると、片方だけ直して音がずれる
   */
  playReloadSound(audio) {
    const d = this.def;
    if (d.reloadKind === 'shell') audio?.shell?.();
    else audio?.reload?.(d.reloadTime);
  }

  // 移動・跳躍・姿勢で精度が変わる。止まって覗くのが一番当たる形にする
  _currentSpread(player) {
    const d = this.def;
    const base = THREE.MathUtils.lerp(d.spreadHip, d.spreadAds, this.adsFactor);
    // 撃って開いたぶん。覗いている時は3割しか乗せない。
    // 丸ごと乗せると、腰だめの上限0.075がADSの0.0016に足されて0.0466＝20m先で90cmになり、
    // 8発撃った後のADSがまるで当たらなくなる。覗いて撃つ形を壊さない範囲に抑える
    const bloom = (this.current.spread - d.spreadHip) * (1 - this.adsFactor * 0.7);
    let s = base + bloom;
    const speed = player.horizontalSpeed;
    // 移動のぶれ。覗いている間は銃を体で固定するので効きを落とす。
    // ここを腰だめと同じ量にしていたせいで、歩きながらのADSが
    // 0.0016→0.0227rad（14倍）になり、20m先で45cmに散っていた。
    // 「動きながら狙って撃つ」がまったく成立しない原因がこれだった
    // 係数は0.0045から下げた。測ったら、走りながら覗いても20m先で14cmしか
    // 散っておらず（頭の幅18cmより狭い）、「動くと当たらない」の実体が
    // ほとんど無かった。効いていたのは移動ではなく腰だめかどうかの差。
    // 動き撃ちを少し許す方へ寄せるので、ここも合わせて下げる
    s += speed * MOVE_SPREAD * (1 - this.adsFactor * 0.75);
    if (!player.onFloor) s += 0.035;
    if (player.crouching) s *= 0.72;
    return Math.min(s, d.spreadMax + 0.05);
  }

  update(dt, input, player, ctx) {
    const w = this.current;
    const d = w.def;

    /* -------------------------------------------------- 持ち替え */
    if (this.switching > 0) {
      const prev = this.switching;
      this.switching -= dt;
      // 画面外まで下げた瞬間に差し替える
      if (prev > 0.21 && this.switching <= 0.21 && this._pendingIndex != null) {
        w.model.visible = false;
        w.restPose();
        this.index = this._pendingIndex;
        this._pendingIndex = null;
        this.current.model.visible = true;
        this.current.spread = this.current.def.spreadHip;
        this.boltCycle = 0;
        ctx.audio?.click(1200, 0.35, 0.05);
      }
      if (this.switching < 0) this.switching = 0;
    }

    /* ---------------------------------------------------- 装填 */
    if (this.reloading > 0) {
      const prev = this.reloading;
      this.reloading -= dt;
      if (prev > 0 && this.reloading <= 0) {
        const cur = this.current;
        if (this.shellReload) {
          // 1発だけ入る。ここで弾数が増えるので、**途中でやめても入れた分は残る**
          cur.ammo += 1;
          cur.reserve -= 1;
          cur.boltLocked = false;
          this.shotIndexInMag = 0;
          if (cur.ammo < cur.def.mag && cur.reserve > 0) {
            // まだ入るので次の1発へ。押し込む音もここで1発ぶん鳴らす
            this.reloading = cur.def.shellTime;
            ctx.audio?.shell?.();
          } else {
            this.shellReload = false;
          }
        } else {
          const need = cur.def.mag - cur.ammo;
          const take = Math.min(need, cur.reserve);
          cur.ammo += take;
          cur.reserve -= take;
          cur.boltLocked = false;
          this.shotIndexInMag = 0;
        }
      }
    }

    /* -------------------------------------------- 遅れて出る排莢 */
    if (this._ejectDelay >= 0) {
      this._ejectDelay -= dt;
      if (this._ejectDelay <= 0) {
        this._ejectDelay = -1;
        this.onEject?.(this._ejectPos, this._ejectDir);
      }
    }

    /* ------------------------------------------------------ ADS */
    /* 右クリックを押した瞬間。**投げ物とそれ以外で意味が違う。**

       銃では「押すたびに覗きの入り切り」。押している間ではないのは、
       Macのトラックパッドが右クリックを押したまま左クリックできないためで、
       押しっぱなし方式だと覗きながら撃つ動作そのものが物理的に取れない。

       投げ物では覗く物が無いので、こちらは**押した瞬間に手前へ放る**（下の投擲で受ける） */
    const rightEdge = !!input.clicked?.(2);
    // 近接の右クリックは覗きではなく強い一撃。覗きの入り切りへ流さない
    if (rightEdge && !d.thrown && !d.melee) this.adsHeld = !this.adsHeld;
    // 覗いた・振った瞬間に眺めるのをやめる。眺めながら覗くと照準が横を向く
    if (rightEdge) this.inspect = 0;
    // 包帯を持っている間は武器そのものを下ろしているので、覗くも撃つも無い
    const busyHealing = this.bandageOut || player.healing > 0;
    // 近接は覗く物が無い。覗けると刃を目の前に構えて視界を塞ぐだけになる
    const canAds = !d.melee && !busyHealing && this.reloading <= 0 && this.switching <= 0
      && !player.sprinting && player.alive;
    if (!canAds) this.adsHeld = false;
    this.wantAds = this.adsHeld && canAds;
    const adsTarget = this.wantAds ? 1 : 0;
    // 覗き込みは「adsTime秒で覗き終わる」。一定の速さで詰める。
    //
    // ここは damp（指数で近づく関数）だった。指数はいつまでも到達しないので、
    // adsTimeに0.16秒と書いてあっても実際に覗き終わるのは**0.625秒**（3.9倍）で、
    // 0.16秒の時点ではまだ63%しか進んでいなかった。
    // 「スコープを覗くまでの時間が長い」の正体がこれ。
    // 数字の意味と画の動きが食い違っていると、値をいくら詰めても合わせられない。
    //
    // 一定の速さなら「書いた秒数＝かかる秒数」になり、指定値がそのまま効く
    const adsStep = dt / Math.max(d.adsTime, 0.01);
    this.adsFactor = adsTarget > this.adsFactor
      ? Math.min(adsTarget, this.adsFactor + adsStep)
      : Math.max(adsTarget, this.adsFactor - adsStep);
    player.adsFactor = this.adsFactor;
    // 移動速度の倍率も武器から渡す。持ち替えた次のフレームから効く
    player.moveMul = d.moveMul || 1;
    // 覗いている間に視点の効きをどれだけ落とすか。倍率の高い照準ほど、
    // 同じ手の動きで景色が速く流れるので、武器ごとに変えられるようにしてある
    player.adsSlow = d.adsSlow ?? 0.45;

    /* ---------------------------------------- スプレッドの回復 */
    // 発砲より前で回復させる。後ろに置くと、撃って足した0.0055を同じフレームで削ってから
    // main.jsのクロスヘアが読むので、1発ぶんの膨らみが1画素も表示されない。
    // spreadHoldは連射間隔（ライフル0.094秒・SMG0.063秒）より長くしてある。
    // 撃っている間は回復を止めて、引金を離してから0.5秒かけて閉じる形にする。
    // 前は毎秒spreadRecover*6（ライフル0.540）引いていて、640rpmで足せる0.0587の9倍あった。
    // つまり撃っても撃たなくても常にspreadHipに張り付いていて、
    // 1発目と30発目の弾のばらけ方が完全に同じだった
    this.spreadHold = Math.max(0, this.spreadHold - dt);
    if (this.spreadHold <= 0) {
      w.spread = Math.max(d.spreadHip, w.spread - d.spreadRecover * dt);
    }

    /* ---------------------------------------------------- 発砲 */
    this.fireTimer -= dt;
    this.pumping = Math.max(0, this.pumping - dt);
    this.swing = Math.max(0, this.swing - dt);
    /* 武器を見る動きを進める。**走り出したら途中でも止める。**
       走っている姿勢と眺める姿勢が同じ所へ二重に足されると武器が画面外へ飛ぶ。
       撃つ・装填・覗くで止めるのは、それぞれの処理の中で0にしている */
    if (this.inspect > 0) {
      this.inspect = player.sprinting ? 0 : Math.max(0, this.inspect - dt);
    }

    /* 刃が届いた。**ここで初めて当たり判定を出す。**
       渡すplayerは「今のフレームの」player なので、
       振りかぶっている間に向きを変えれば、変えた先へ当たる。
       押した瞬間の向きを覚えて後で使う形にはしていない
       （そうすると、見ている所と当たる所が別になる） */
    if (this.strikeIn > 0) {
      this.strikeIn -= dt;
      if (this.strikeIn <= 0) {
        this.strikeIn = 0;
        this._fire(player, ctx);
      }
    }

    const trigger = input.buttons[0];
    const triggerEdge = trigger && !this._prevTrigger;
    // 手榴弾は離した瞬間に投げる（課題.md #1）。_prevTriggerは下で今の値へ
    // 上書きしてしまうので、離した合図はここで先に取っておく
    const triggerRelease = !trigger && this._prevTrigger;
    this._prevTrigger = trigger;
    // 指を離したら反動パターンを最初に戻す。押しっぱなしの間だけ積み上がる
    if (!trigger) this.shotIndexInMag = 0;

    /* -------------------------------- 1発ずつ入れている途中で撃ちたくなった */
    // 1発ずつ入れる武器は、入れている途中で止めて撃てる。
    // 弾倉ごと入れ替える武器は止められない（実物がそうだし、
    // 抜いた弾倉を戻す動作が要るので「今すぐ撃つ」にならない）。
    //
    // ここが無いと、装填を始めた後で敵が出てきた時に、
    // **弾が入っているのに2.9秒撃てないまま撃たれる。**
    // 止めた時点までに入った分は弾倉に残っているので、押した瞬間から撃てる。
    //
    // reloadingを0にするだけで済むのは、この下の発砲がreloading<=0を見ているから。
    // 同じフレームのうちに撃ちに行く（押してから撃つまでに間が空かない）
    if (this.shellReload && triggerEdge && w.ammo > 0
      && !busyHealing && player.alive && !player.sprinting) {
      this.reloading = 0;
      this.shellReload = false;
    }

    /* -------------------------------------------- 包帯を構えている間 */
    // Fで手に持ち、左クリックで巻き始める。持っているだけでは回復しない。
    // 巻き終わるか、途中で撃たれて中断したら、そのまま武器へ戻す。
    // 手動でしまわせると、中断された次の瞬間に丸腰のまま撃ち合うことになる
    if (busyHealing) {
      if (triggerEdge && player.healing <= 0 && player.alive) {
        // 断られた時にも音を返す。無反応だと壊れているのか使えないのか分からない
        if (player.startHeal()) ctx.audio?.click(680, 0.30, 0.07);
        else ctx.audio?.click(2600, 0.16, 0.03);
      }
      if (this._wasHealing && player.healing <= 0) this.bandageOut = false;
    }
    this._wasHealing = player.healing > 0;

    // 覗いている間は3点バースト。1回引いたら3発は必ず出る（指を離しても止めない）。
    // フルオートのまま覗くと、一番当たる姿勢のまま一番ばらける撃ち方ができてしまう
    const burst = this.wantAds && d.auto;
    if (burst && triggerEdge && this.burstLeft <= 0) this.burstLeft = BURST_COUNT;

    const wantFire = burst ? this.burstLeft > 0 : (d.auto ? trigger : triggerEdge);
    /* 走っている間に手が出せないのは**銃だけ。**

       刃は走りながらでも振れる。ナイフは**持っているだけで足が速くなる**
       物（moveMul 1.35）なので、「速く走れるが走っている間は振れない」だと
       道具として噛み合わない。実際に「走ってると振れない」と言われた。
       間合いを詰めながら斬るのが近接の遊び方なので、そこを塞がない。

       手榴弾(thrown)は今まで通り走ると構えが解ける。あちらは
       「押して狙って離す」なので、走りながらの投げは別の話になる */
    const sprintBlock = player.sprinting && !(d.melee && !d.thrown);
    const canFire = player.alive && !busyHealing && this.reloading <= 0 && this.switching <= 0
      && this.pumping <= 0 && this.fireTimer <= 0 && !sprintBlock;

    // 引金に指をかけている状態。指の動きに使う
    this.trigTarget = (trigger && player.alive && this.reloading <= 0
      && this.switching <= 0 && !sprintBlock) ? 1 : 0;

    // 投擲物は撃つのではなく投げる。ここでreturnしてはいけない。
    // この下には揺れ・手の姿勢・ビューモデルの変形が続いていて、
    // 抜けると手榴弾だけ画面に貼り付いたまま動かなくなる
    //
    // 押した瞬間ではなく、離した瞬間に投げる（課題.md #1。以前は押した瞬間に
    // 飛んでいた）。軌道の線は持っている間ずっと出ているので（_updateNadeArc）、
    // 押している間はそれを見ながら狙いを決められる。
    //
    // 押している間に死んだ・武器を替えた・一時停止したせいで「離した扱い」が
    // 漏れないよう、実際に投げるのは離した瞬間にcanFireをもう一度見てから。
    // ここがfalseなら投げずに構えを解くだけ（例: 死んだ・スプリントを始めた）。
    // 一時停止はmain.js側で_throwChargingを明示的に折っている
    // （pointerlockが外れるとinput.buttonsが黙って全部falseになり、そのままだと
    // 再開した1フレーム目が「離した」と誤認して勝手に投げてしまうため）
    if (d.thrown) {
      if (triggerEdge && canFire) this._throwCharging = true;
      if (this._throwCharging && triggerRelease) {
        this._throwCharging = false;
        if (canFire) {
          player.cancelHeal?.();
          this._startSwing('throw');
          this.onThrow?.(false);
          this.fireTimer = 60 / d.rpm;
        }
      }
      /* 右クリックは押した瞬間に手前へ放る。**構えない。**
         左クリックが「押して狙って離す」なのに対して、こちらは1動作で終わる。
         逃げながら足元へ落とす・角の裏へ転がす、が手数無しで取れるようにするため。
         構えている途中に押された時は、そちらの構えを畳んでから放る
         （畳まないと、指を離した時にもう1つ飛ぶ） */
      if (rightEdge && canFire) {
        this._throwCharging = false;
        player.cancelHeal?.();
        this._startSwing('throw');
        this.onThrow?.(true);
        this.fireTimer = 60 / d.rpm;
      }
    } else if (d.melee && rightEdge && canFire) {
      /* 近接の右クリック。**遅いが重い一撃。**
         覗く物が無い武器なので、右クリックは今まで何も起きなかった。

         間隔をここで伸ばすのは見た目の話で、**本当の縛りはサーバーが持つ**
         （発射権をMELEE_HEAVY.COST個使う）。こちらだけで止めると、
         書き換えれば通常の速さで強い一撃が出せることになる */
      player.cancelHeal?.();
      this.heavy = true;
      this._startSwing('heavy');
      /* **判定は刃が届いてから出す。**押した瞬間に出すと、
         腰へ引いている間にもう相手が倒れている（実際そうなっていた）。
         間隔(fireTimer)は押した瞬間から数える。そこを遅らせると連打が速くなる */
      this.strikeIn = this._strikeDelay();
      this.fireTimer = (60 / d.rpm) * MELEE_HEAVY.COST;
    } else if (wantFire && canFire) {
      if (w.ammo > 0) {
        // 撃ったら包帯を中断する。撃ちながら巻けると遅くする意味が無い
        player.cancelHeal?.();
        // 近接は撃つのではなく振る。刃が通り過ぎる動きを出す
        if (d.melee) { this.heavy = false; this._startSwing('light'); }
        /* 近接だけ、判定を刃が届く時刻まで待たせる（右クリックと同じ理由）。
           **銃は待たせない。**弾は引金を引いた瞬間に出る物なので、
           ここで遅らせると撃ち味が丸ごと変わる。手榴弾も投げた瞬間で正しい */
        if (d.melee && !d.thrown) this.strikeIn = this._strikeDelay();
        else this._fire(player, ctx);
        this.fireTimer = 60 / d.rpm;
        if (burst) {
          this.burstLeft--;
          // 3発撃ち終わったら間を置く。置かないと引金の連打で
          // フルオートと同じ速さが出て、バーストにした意味が消える
          if (this.burstLeft <= 0) this.fireTimer = Math.max(this.fireTimer, BURST_GAP_S);
        }
        if (d.pumpTime) this.pumping = d.pumpTime;
      } else {
        // 空撃ちのカチッ。連打で鳴り続けないよう間隔を空ける
        if (this.fireTimer <= 0) {
          ctx.audio?.click(2800, 0.3, 0.03);
          this.fireTimer = 0.28;
          if (w.reserve > 0 && this.reload()) this.playReloadSound(ctx.audio);
        }
      }
    }

    /* 投げ切った後の持ち替え。**投げる動作が終わってから**替える
       （takeNade のコメント参照）。無い物を構え続けるのをやめるための物なので、
       持ち替えが済んだ時点で用済み */
    if (this._holsterThrown && this.swing <= 0 && this.switching <= 0) {
      this._holsterThrown = false;
      const to = this.carry[0];
      if (d.thrown && to != null && this.switchTo(to)) this.onSwitched?.(to);
    }

    // 自動リロード（撃ち切ったら勝手に入れ替える）
    if (w.ammo === 0 && w.reserve > 0 && this.reloading <= 0 && this.switching <= 0) {
      if (this.reload()) this.playReloadSound(ctx.audio);
    }

    this._animate(dt, input, player);
    this._animateParts(dt, w, d);
    this._updateFlash(dt);
  }

  /**
   * 振りを始める。**どう振るかはここで1回だけ決めて、振り切るまで変えない。**
   *
   * kindは 'light'（左）/ 'heavy'（右）/ 'throw'（手榴弾）。
   * 形スキンを着けていればその形の振り方になる（swingOf）
   */
  _startSwing(kind) {
    const w = this.current;
    this.swingAnim = swingOf(w.def.id, kind, w.shapeId);
    this.swing = this.swingAnim.time;
  }

  /**
   * 刃が一番遠くへ届く時刻（振り始めからの秒数）。
   *
   * **2026-08-11。「押した瞬間にダメージが入っている」と言われて計算したら、本当だった。**
   *
   * 振りの再生（_animateの中）は2段になっている:
   *
   *   k < wind         … 振りかぶり。引いて溜めている。**刃は後ろにある**
   *   k >= wind        … 振り抜き。a=(k-wind)/(1-wind) が進み、
   *                      m=min(1, a*speed) が1になった所で刃が thru（一番遠く）へ届く
   *
   * つまり刃が届くのは m=1 のとき、すなわち a=1/speed のとき。
   * kに直すと wind + (1/speed)*(1-wind) で、それに time を掛けると秒になる。
   *
   * 実際の値:
   *
   *   ナイフ左   0.24秒 ／ ナイフ右 0.36秒
   *   刀左       0.32秒 ／ 刀右     0.40秒
   *   ダガー左   0.14秒 ／ ダガー右 0.28秒
   *
   * **判定は0秒に出ていたので、刀の右は0.40秒も先走っていた。**
   *
   * ここで数字を新しく置いていないのが大事な所で、**全部SWINGSの表から出している。**
   * 表を触れば当たるタイミングも一緒に動くので、片方だけ古くなることが起きない
   * （MELEE_HEAVY.TIME_Sのコメントにある「当たり判定にも効かない見た目だけの数字」は、
   *   この変更でもう正しくない。あちらのコメントも直してある）
   */
  _strikeDelay() {
    const s = this.swingAnim;
    return (s.wind + (1 / s.speed) * (1 - s.wind)) * s.time;
  }

  _fire(player, ctx) {
    // 撃ったら眺めるのをやめる。**銃を横に向けたまま弾が出るのを止める**
    this.inspect = 0;
    const w = this.current;
    const d = w.def;
    const v = d.view;
    w.ammo--;
    this.shotIndexInMag = (this.shotIndexInMag ?? 0) + 1;
    // 撃ち切ったらボルトが後退位置で止まる
    if (w.ammo === 0 && d.holdOpen) w.boltLocked = true;

    const spread = this._currentSpread(player);
    const origin = _v.setFromMatrixPosition(this.camera.matrixWorld);
    const forward = _v2.set(0, 0, -1).applyQuaternion(this.camera.quaternion);

    // 銃口のビュー空間座標。viewCameraは原点・無回転なのでviewSceneのワールド座標がそのまま使える
    const muzzleView = w.parts.muzzle.getWorldPosition(_v3);
    // ビューモデル用の発砲光は平行光なので位置を動かさない。強度だけ上げる。
    // 近接では光らせない（銃口が無いので光る場所そのものが無い）
    if (!d.melee) this.viewMuzzleLight.intensity = 0.9 * (d.pellets > 1 ? 1.5 : 1);

    // 銃口のワールド座標（ビューモデルはカメラ空間にいるので変換する）。
    // 画角の違いを先に潰しておくこと。_v3はここから書き換わる
    const muzzleWorld = this._viewToWorld(muzzleView);

    for (let p = 0; p < d.pellets; p++) {
      const dir = _v4.copy(forward);
      if (spread > 0) {
        // 円内一様にばらけさせる（正方形にすると角に偏る）
        const a = Math.random() * Math.PI * 2;
        const r = Math.sqrt(Math.random()) * spread;
        const cx = Math.cos(a) * r, cy = Math.sin(a) * r;
        // カメラの右と上をその場で作る。毎発Vector3を作らないための展開
        const q = this.camera.quaternion;
        const rx = 1 - 2 * (q.y * q.y + q.z * q.z);
        const ry = 2 * (q.x * q.y + q.z * q.w);
        const rz = 2 * (q.x * q.z - q.y * q.w);
        const ux = 2 * (q.x * q.y - q.z * q.w);
        const uy = 1 - 2 * (q.x * q.x + q.z * q.z);
        const uz = 2 * (q.y * q.z + q.x * q.w);
        dir.set(
          forward.x + rx * cx + ux * cy,
          forward.y + ry * cx + uy * cy,
          forward.z + rz * cx + uz * cy,
        ).normalize();
      }
      this.onShot?.({
        origin, dir, muzzle: muzzleWorld, def: d,
        pellet: p, pellets: d.pellets,
        // 強い一撃か。1人用は威力を掛け、対戦はサーバーへ印だけ送る
        heavy: !!(d.melee && this.heavy),
      });
    }

    /* ------------------------------------------------ 反動を積む */
    const n = this.shotIndexInMag;
    // 縦は最初の数発で強く、その後は緩やかに。横は左右に蛇行させる
    const rise = d.recoilPitch * (1 + Math.min(n, 7) * 0.16);
    const drift = d.recoilYaw * Math.sin(n * 1.7) * (0.6 + Math.min(n, 10) * 0.09);
    const adsScale = 1 - this.adsFactor * 0.32;
    player.addRecoil(rise * adsScale, (drift + rand(d.recoilYaw * 0.5)) * adsScale);

    this.kickZv += d.kick * 26 * adsScale;
    // 銃を画面上で跳ね上げる。Zだけだと奥行きにしか動かず、
    // 歩くだけで出るbobの揺れ（横52px・縦39px）に埋もれて撃った事が読めない。
    // 覗いている間は平行移動ぶんをほぼ捨てる。弾はカメラ中心から出ているのに
    // ドットは銃に付いているので、銃を1cm持ち上げるとドットだけが上へ飛んで
    // 「見えている狙点と着弾点が違う」状態になる。実測で1発53px＝20m先で40cmずれる。
    // 覗いて撃つ形が壊れるので4%だけ残して5px（20m先で10cm）に収める。
    // ADSの手応えはカメラ側の反動（player.addRecoil）が持っている
    const kickMove = adsScale * (1 - this.adsFactor * 0.96);
    this.kickYv += v.kickUp * kickMove;
    this.kickXv += rand(v.kickSide * 2) * kickMove;
    this.kickPitchV += d.recoilPitch * 40 * adsScale;
    this.kickYawV += rand(d.recoilYaw * 26) * adsScale;
    // ボルトを1往復させ、弾倉を遅れて揺らす
    if (v.boltTravel > 0) this.boltCycle = 1;
    this.magWobV += d.kick * 9;

    w.spread = Math.min(d.spreadMax, w.spread + d.spreadPerShot);
    // 撃っている間は回復を止める。連射間隔より長く取らないと、
    // 発と発の間で回復が挟まって開きっぱなしにならない
    this.spreadHold = 0.12;

    /* ------------------------------------------------ 見た目と音 */
    // 銃の見た目と音の一式。近接はここへ一切入らない。
    //
    // 以前は effects.muzzle() だけを近接から外していたが、それは3つあるうちの1つで、
    // 板の閃光(w.flash)・残留煙・マズルライトはガードの外に置いたままだった。
    // 「ナイフを振ると火花が散る」の正体はこの板。個別に条件を足すと
    // 必ずどれかを取りこぼすので、丸ごと囲う
    if (!d.melee) {
      // 板の寿命。_updateFlashで毎フレーム大きさと濃さを更新する。
      // 出しっぱなしにすると60fpsで全く同じ絵が3枚並んで、発砲に時間が無くなる。
      // 逆に長すぎてもいけない。0.055秒だと60fpsで3.3フレームあり、
      // ライフルの連射間隔5.6フレームの6割を占めるので「光る／戻る」が10Hzで往復する。
      // 2フレームに詰めて、光っていない時間のほうを長くする
      this.flashLife = 0.035;
      this.flashTimer = this.flashLife;
      w.flash.visible = true;
      // 毎発ぐるぐる回すと、形の違いではなく「同じシールが回っている」ようにしか見えない。
      // 横長の主板の向きは保ったまま、ゆらぎとして±0.25radだけ振る
      w.flash.rotation.z = rand(0.5);
      this.flashBase = (0.75 + Math.random() * 0.6) * (1 - this.adsFactor * 0.35);
      w.flash.scale.setScalar(this.flashBase);
      // 残留煙。連射で濃くなりすぎないよう上限を付ける
      this.smokeTimer = Math.min(0.34, (this.smokeTimer || 0) + 0.24);
      this.smokeSeed = Math.random() * Math.PI * 2;
      this.muzzleLight.intensity = 26 * (d.pellets > 1 ? 1.6 : 1);
      this.muzzleLight.position.copy(muzzleWorld);

      ctx.effects?.muzzle(muzzleWorld, forward);
      ctx.audio?.gunshot(gunTune(w.shapeId, d.sound), null, null);

    } else {
      // 刃は空気を切る音だけ。**形と強さで鳴り分ける**
      // （刀は長く澄んで、ダガーは短く高い。audio.jsのSWING_TUNES）
      ctx.audio?.swing?.(swingTune(w.shapeId, this.heavy));
    }

    if (d.casing) {
      const ejectWorld = this._viewToWorld(w.parts.eject.getWorldPosition(_v3));
      if (d.pumpTime) {
        // ポンプ式は排莢が遅れる
        this._ejectPos.copy(ejectWorld);
        this._ejectDir.copy(forward);
        this._ejectDelay = 0.26;
      } else {
        this.onEject?.(ejectWorld, forward);
      }
    }
  }

  // ビュー空間の点を本編カメラのワールド座標へ移す。
  // ビューモデルはfov 55のviewCameraで写るのに、煙・火花・曳光弾はfov 75のcameraで写る。
  // 同じ3D点でも画角が違えば画面上の位置が変わるので、tanの比でx,yを補正してから移す。
  // やらないと撃つほど銃口の少し上に煙が溜まって見える。
  //
  // 比の向きを間違えやすいので導出を残す。画面上の位置(ndc)は
  //   ndc = x / (-z) / tan(fov/2)
  // で決まる。viewCameraで写った銃口と同じndcを本編cameraで作りたいので
  //   x' / tan(fovCam/2) = x / tan(fovView/2)  →  x' = x * tan(fovCam/2) / tan(fovView/2)
  // 狭いviewCamera(55)のほうが拡大されて写るぶん、外側へ広げる向き（k>1）が正しい。
  // 逆にすると補正しないより大きくずれる。
  // ADS中は両方のfovが動くので、その場でtanを取り直す
  _viewToWorld(p) {
    const D = Math.PI / 360;   // 度→ラジアン かつ 半画角にする
    const k = Math.tan(this.camera.fov * D) / Math.tan(this.viewCamera.fov * D);
    p.x *= k; p.y *= k;
    return p.applyMatrix4(this.camera.matrixWorld);
  }

  _updateFlash(dt) {
    const w = this.current;
    if (this.flashTimer > 0) {
      this.flashTimer -= dt;
      if (this.flashTimer <= 0) {
        w.flash.visible = false;
      } else {
        // 出た瞬間が一番小さく明るく、そこから広がりながら薄れる。
        // 大きさと濃さのカーブを別にすると1発が「膨らんで消える」動きになる
        const k = clamp01(this.flashTimer / (this.flashLife || 0.035));
        w.flashMat.opacity = Math.pow(k, 0.5);
        w.flash.scale.setScalar((this.flashBase || 1) * (0.55 + 0.45 * (1 - k) + 0.35 * k));
      }
    }
    // 残留煙。板より2倍以上長く引いて、消え際は膨らませながら薄くする
    if (this.smokeTimer > 0) {
      this.smokeTimer = Math.max(0, this.smokeTimer - dt);
      const k = this.smokeTimer / 0.34;
      w.smoke.visible = k > 0.001;
      w.smokeMat.opacity = Math.pow(k, 1.4) * 0.30;
      const s = 0.7 + (1 - k) * 1.5;
      w.smoke.scale.set(s, s, 1);
      w.smoke.rotation.z = (this.smokeSeed || 0) + (1 - k) * 0.5;
      w.smoke.position.z = w.parts.muzzle.position.z - 0.02 - (1 - k) * 0.05;
    } else if (w.smoke.visible) {
      w.smoke.visible = false;
    }
    // 世界を照らす方の光は板より2〜3倍長く引く。1コマの点滅にしないため
    this.muzzleLight.intensity *= Math.max(0, 1 - dt * 10);
    if (this.muzzleLight.intensity < 0.05) this.muzzleLight.intensity = 0;
    // ビューモデル側は速く落とす。銃はここに写りっぱなしなので、光っている時間が
    // 連射間隔（ライフル0.094秒）の半分を超えると「明るい／暗い」が10Hzで往復して
    // チラつきになる。1発あたり2フレームで落ちきる速さにして往復をやめさせる。
    //
    // 係数26は上の条件を満たしていなかった。60fpsで1フレームあたり0.567倍にしかならず、
    // 0.9から切り捨ての0.01を下回るまで7フレーム掛かる。連射間隔は5.6フレームなので
    // 一度も消えないまま次の発砲で0.9へ戻る＝銃の明るさが撃っている間ずっと往復する。
    // 実測でも銃の画素の平均輝度が35.0↔47.6（36%）を10.6Hzで往復していて、
    // これが「撃つと銃の絵がブレる」の残りぶんだった。2フレームで落ちきる138にすると24%まで下がる。
    // 掛け算の形も1-dt*kからexpへ変える。1-dt*kはdtが1/k秒を超えると負になり、
    // main.js側はdtを0.1秒まで通すので、重い環境では発砲したフレームで光が即0になって
    // 銃が一度も照らされない。expなら刻みが粗くても同じ時定数で減る
    this.viewMuzzleLight.intensity *= Math.exp(-dt * 138);
    if (this.viewMuzzleLight.intensity < 0.01) this.viewMuzzleLight.intensity = 0;
  }

  /* --------------------------------------------- 銃全体の構えと揺れ */
  _animate(dt, input, player) {
    const w = this.current;
    const d = w.def;
    const v = d.view;
    const model = w.model;

    /* --------------------------------------- 反動のバネを解く */
    // バネ定数を武器ごとに変える。SMGは硬くて速く、ショットガンは柔らかくて遅い。
    // 毎フレーム走るので配列を作らず、その場で解く。
    // ただしこの解き方は1回の刻み幅が大きすぎると発散する。kickKが最大405、
    // 減衰が最大26なので、dtが0.077秒（13fps）を超えたところで銃が吹き飛ぶ。
    // main.js側でdtは0.1秒まで許しているので、刻みを0.02秒以下に割ってから解く。
    // 60fps時はdt=0.0167で1回のまま、つまり今までと同じ動きになる
    const steps = Math.max(1, Math.ceil(dt / 0.02));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.kickZv += (-this.kickZ * v.kickK - this.kickZv * v.kickD) * h;
      this.kickZ += this.kickZv * h;
      this.kickYv += (-this.kickY * v.kickK - this.kickYv * v.kickD) * h;
      this.kickY += this.kickYv * h;
      this.kickXv += (-this.kickX * v.kickK - this.kickXv * v.kickD) * h;
      this.kickX += this.kickXv * h;
      this.kickPitchV += (-this.kickPitch * v.kickK * 1.1 - this.kickPitchV * (v.kickD + 1)) * h;
      this.kickPitch += this.kickPitchV * h;
      this.kickYawV += (-this.kickYaw * v.kickK - this.kickYawV * (v.kickD - 1)) * h;
      this.kickYaw += this.kickYawV * h;
    }

    /* ------------------------------------- 視点移動に対する遅れ */
    // 素早く振ると銃が置いていかれる。角速度に負の係数を掛けて追従を遅らせる
    this.swayX = THREE.MathUtils.damp(this.swayX, -this._lookVel(player, 'yaw') * v.sway, 10, dt);
    this.swayY = THREE.MathUtils.damp(this.swayY, -this._lookVel(player, 'pitch') * v.sway, 10, dt);

    /* ---------------------------------------------- 歩行と待機 */
    this.idleTime += dt;
    // 覗いている間は狙点が動いてはいけない。当たり判定はカメラ中心から出ているので、
    // 銃だけが呼吸や振り遅れで泳ぐと、見えている狙点と実際の弾道が食い違う。
    // bobだけでなくsway・breath・rollも一緒に縮める
    // 15%/25%を残していると、静止ADSでもドットのスクリーン座標が中心から数十pxずれる。
    // 撃つのは常にカメラ中心なので、見えているドットと着弾点が食い違う。
    // 覗き切る手前(0.55〜0.90)で残り分を0まで畳んで、狙点を完全に固定する
    const adsHard = clamp01((this.adsFactor - 0.55) / 0.35);
    const steady = (1 - this.adsFactor * 0.85) * (1 - adsHard);
    const bobScale = player.bobAmount * v.bob * (1 - this.adsFactor * 0.75) * (1 - adsHard);
    const bobX = Math.cos(player.bobPhase * 0.5) * 0.030 * bobScale;
    const bobY = Math.sin(player.bobPhase) * 0.022 * bobScale;
    // 待機中の呼吸。実測で横9.8px・縦4.1px泳いでいて、しかも周期1.3と0.9が
    // 割り切れない比なので同じ位置に戻ってこない。世界は1画素も動いていないのに
    // 銃だけが動き続けるので、「呼吸している」ではなく「銃が浮いている」に見える。
    // 実物のFPSは呼吸で視点も一緒に動くから成立している演出で、
    // 視点を固定したままここだけ振ると必ず浮く。
    // 完全に0にすると静止画に見えるので、痕跡が残る量まで落とす（横2.4px・縦1.0px）
    const breathX = Math.sin(this.idleTime * 0.9) * 0.00086 * v.bob * steady;
    const breathY = Math.cos(this.idleTime * 0.62) * 0.00069 * v.bob * steady;
    const swX = this.swayX * steady;
    const swY = this.swayY * steady;

    /* ------------------------------------------------ 各種姿勢 */
    const t = this.adsFactor;
    const base = _v.lerpVectors(w.hipPos, w.adsPos, t);

    // 覗くほど縮める。サイト位置の逆算とセットで効く
    w.inner.scale.setScalar(THREE.MathUtils.lerp(v.scale, v.adsScale, t));
    // 銃床は構えると目の後ろに来る部品なので、覗いたら消す
    if (w.parts.rear) w.parts.rear.visible = t < 0.55;
    // レンズの映り込みは、筒を横から見た時にガラスだと分からせるための演出。
    // 覗いている間に乗せると透過像を白く濁らせるだけなので消す
    if (w.parts.sheen) w.parts.sheen.visible = t < 0.6;
    // レティクルはヒップだと軸から外れて見えているだけなので薄く落とす。
    // 深度は戻してあるので筒や銃身には遮蔽されるが、開口から漏れる分は残る
    if (w.parts.reticle) {
      const rk = 0.18 + 0.82 * t;
      MATS.dot.opacity = rk;
      MATS.reticle.opacity = 0.8 * rk;
      // 芯を細くしたぶん滲みが相対的に勝つ。濃度も一段落として点のままにする
      MATS.dotGlow.opacity = 0.30 * rk;
    }

    // 走っている時は銃を下げて斜めに倒す
    const sprintT = player.sprinting ? 1 : 0;
    this._sprintBlend = THREE.MathUtils.damp(this._sprintBlend ?? 0, sprintT, 9, dt);
    const sp = this._sprintBlend;

    // 装填中は下げて回す（工程の中身は_animatePartsが担当する）
    //
    // 1発ずつ入れる武器はここを分ける。
    // 弾倉ごと入れ替える武器は「下げて→戻す」が1回なので sin で山を描けばよいが、
    // 1発ずつだと**その山が1発ごとに立つ。7発入れると銃が7回上下する。**
    // 入れている間は下げたまま、始めと終わりだけ滑らかにする形にする
    let reloadT = 0;
    if (d.reloadKind === 'shell') {
      this._shellLower = THREE.MathUtils.damp(this._shellLower, this.reloading > 0 ? 1 : 0, 13, dt);
      reloadT = this._shellLower;
    } else if (this.reloading > 0) {
      const p = 1 - this.reloading / d.reloadTime;
      reloadT = Math.sin(clamp01(p) * Math.PI);
    }
    // 持ち替え中も下げる
    const switchT = this.switching > 0 ? Math.sin(clamp(this.switching / 0.42, 0, 1) * Math.PI) : 0;
    // 包帯を手に持っている間は武器を下ろす。持っているのに銃を構えたままだと、
    // 何をしているのか画から読めないうえ、撃てそうに見えて誤解を生む。
    // 出し入れは0.25秒で滑らかに（Fを押した瞬間に瞬間移動させない）
    const using = player.healing > 0;
    const healT = this.bandageOut || using ? 1 : 0;
    this._healBlend = THREE.MathUtils.damp(this._healBlend, healT, 14, dt);
    // 包帯そのものの見せ方。「持っているだけ」と「巻いている」で動きを変える。
    // 同じ動きにすると、Fを押しただけなのか回復が始まったのかが画から読めない
    if (this.bandage) {
      this.bandage.visible = this._healBlend > 0.02;
      if (this.bandage.visible) {
        const k = this._healBlend;
        // 巻く動き。手首をひねる往復を、巻いている時間に合わせて回す
        const spin = using ? (HEAL_TIME - player.healing) * 7.5 : 0;
        // 持っているだけの時は呼吸ぶんだけ上下させる。完全に静止させると
        // 画面に貼り付いた絵に見えて、手に持っている物に見えない
        const breath = Math.sin(this.idleTime * 1.7) * 0.006;
        // 画面のどこに来るかは、この3つの数字と下のscaleでほぼ決まる。
        // 目分量で置くと枠から出るので、投影して測った上で詰めてある
        // （tools/check-weapons.mjs の[3.6]がその測定）。
        // kが0の間は画面の下に沈めておいて、持つと同時に持ち上がる形にする。
        //
        // zは-0.30だった。手に持ちきった所で目から25cmしか離れておらず、
        // ライフルを支える手が36cm先にあるのと比べて近すぎた。
        // -0.38にして33cmへ送ってある（縮尺も1.35→1.18）
        this.bandage.position.set(
          0.048 - k * 0.014 + this.swayX * 0.5,
          -0.200 + k * 0.154 + breath + this.swayY * 0.5,
          -0.38 + k * 0.05,
        );
        // 手首のひねり。往復させる。
        //
        // ここは spin をそのまま足していた（0.40 + spin * 0.5）。
        // spinは巻いている時間に比例して増え続ける値なので、
        // 手が止まらずに回った。2.4秒巻くと spin は18まで伸びるので、
        // 掛けた0.5で9ラジアン＝**手が1回転半していた**。
        // すぐ下のコメントに「手は回さない」と書いてあるのに、この行が回していた。
        //
        // 巻く動作は「ひねって、戻して、またひねる」の往復なので、
        // 増え続ける値ではなく、その sin を使う
        this.bandage.rotation.set(
          -0.35 + Math.sin(spin) * 0.14,
          0.40 + Math.sin(spin * 0.5) * 0.16,
          0.20 + breath * 3 + Math.sin(spin * 0.5 + 1.1) * 0.07,
        );
        // 帯そのものは回してよい。ほどけていく物なので、増え続ける値が正しい。
        // 回るのはこの roll だけで、手は上の往復しかしない
        if (this.bandage.userData.roll) this.bandage.userData.roll.rotation.x = spin * 1.6;
        this.bandage.scale.setScalar(1.18 * (0.72 + k * 0.28));
      }
    }
    const lower = Math.max(reloadT, switchT, this._healBlend);

    /* 近接の振り。0→1で「引く→振り抜く→戻る」の1周期を作る。
       銃と同じ反動(kick)では表せない。反動は「その場で跳ねて戻る」動きで、
       振りは「腕ごと通り抜ける」動きだから、軌道が別物になる。

       **どう通り抜けるかは SWINGS が持つ。**形と左右で違う
       （刀の左は横へ払い、右は真上から落とす）。
       ここは表を再生するだけで、角度そのものは1つも持たない */
    let swingP = 0, swingY = 0, swingR = 0, swingZ = 0, swingH = 0;
    if (this.swing > 0) {
      const s = this.swingAnim;
      // **割る相手は振り方ごとの長さ。**ここを固定値にしていた頃、
      // 0.62秒の強い一撃が「最初の0.2秒だけ止まって見える」状態だった
      // （0.42で割ると1を超えるので、進みが0のまま据え置かれていた）
      const k = 1 - clamp01(this.swing / s.time);   // 0→1で進む
      if (k < s.wind) {
        // 振りかぶり。ゆっくり引いて溜める
        const a = k / s.wind;
        swingP = a * s.back.p; swingY = a * s.back.y;
        swingR = a * s.back.r; swingZ = a * s.back.z; swingH = a * s.back.h;
      } else {
        // 振り抜き。速く通り過ぎて、行き過ぎた所から戻る。
        // eは途中で膨らむ量で、これが無いと同じ道を往復するだけになる
        const a = (k - s.wind) / (1 - s.wind);
        const m = Math.min(1, a * s.speed);
        const e = Math.sin(a * Math.PI);
        // 最後は素の構えへ戻す
        const back = 1 - Math.max(0, (a - s.fade) / (1 - s.fade));
        swingP = (s.back.p + (s.thru.p - s.back.p) * m + e * s.arc.p) * back;
        swingY = (s.back.y + (s.thru.y - s.back.y) * m + e * s.arc.y) * back;
        swingR = (s.back.r + (s.thru.r - s.back.r) * m + e * s.arc.r) * back;
        swingZ = (s.back.z + (s.thru.z - s.back.z) * m + e * s.arc.z) * back;
        swingH = (s.back.h + (s.thru.h - s.back.h) * m + e * s.arc.h) * back;
      }
    }

    /* ---- 武器を見る（5キー）。**手元へ引き寄せて少し傾けるだけ。**

       **回さない。** 腕が同じ群れに入っているので、回すと腕ごと回る
       （上のINSPECTのコメントに経緯）。

       ins … 引き寄せている量(0〜1)。始めと終わりだけ滑らかにして、間は止める */
    let insZ = 0, insH = 0, insP = 0, insY = 0, insR = 0;
    if (this.inspect > 0) {
      const k = 1 - clamp01(this.inspect / INSPECT.time);
      // 台形の包絡。上がり(in)・保ち・下がり(out)
      const ins = k < INSPECT.in ? k / INSPECT.in
        : k > 1 - INSPECT.out ? (1 - k) / INSPECT.out : 1;
      // 手前へ引いて少し持ち上げる。**引きすぎると銃口が画面を覆う**ので0.05まで
      insZ = ins * 0.05;
      insH = ins * 0.030;
      // 銃口を左へ振って、天面がこちらを向く程度に傾ける
      insY = ins * 0.42;
      insP = -ins * 0.24;
      insR = ins * INSPECT.tilt;
    }

    // 巻いている間は武器を大きく下げて画面の外へ寄せる。
    // lowerだけでは足りない（装填の下げ幅は「見えたまま傾く」量なので）
    const healDrop = this._healBlend * 0.30;
    model.position.set(
      base.x + bobX + swX + breathX + sp * 0.05 + this.kickX + this._healBlend * 0.10,
      // 上下は振りの h をそのまま使う。前は前後(swingZ)の半分を流用していたので、
      // 突きのように「前へ出すだけで下げない」動きが作れなかった
      base.y + bobY + swY + breathY - sp * 0.05 - lower * v.lower + this.kickY + swingH
        - healDrop + insH,
      base.z + this.kickZ - sp * 0.02 + swingZ + insZ,
    );
    // kickPitch/kickYawは反動なのでADSでも残す。ADSの減衰は_fireで
    // (1 - adsFactor*0.32)を1回だけ掛けてあるので、ここで重ねない
    model.rotation.set(
      THREE.MathUtils.lerp(w.hipRot.x, w.adsRot.x, t) + this.kickPitch + swY * 1.6
        + sp * 0.22 + reloadT * 0.42 + switchT * 0.7 + swingP + insP,
      THREE.MathUtils.lerp(w.hipRot.y, w.adsRot.y, t) + this.kickYaw + swX * 2.2
        + sp * 0.55 + reloadT * 0.30 + swingY + insY,
      THREE.MathUtils.lerp(w.hipRot.z, w.adsRot.z, t) - sp * 0.30 + reloadT * 0.20
        + player.roll * 1.5 * (1 - this.adsFactor) + swingR + insR,
    );

    // 覗いている間はFOVを絞る。ビューモデルのFOVは本編より狭くしておくと
    // 手前側の遠近の伸びが抑えられて、銃が自然な形に見える
    const fov = THREE.MathUtils.lerp(55, d.adsFov * 0.9, t);
    if (Math.abs(this.viewCamera.fov - fov) > 0.01) {
      this.viewCamera.fov = fov;
      this.viewCamera.updateProjectionMatrix();
    }
  }

  /* ------------------------------------------------- 可動部の動き */
  _animateParts(dt, w, d) {
    const P = w.parts;
    const v = d.view;
    const reloading = this.reloading > 0;
    // 工程の進み具合。0で始まって1で終わる。
    // 1発ずつ入れる武器は「1発ぶん」が1周期なので、割る相手がshellTimeになる。
    // ここをreloadTimeのままにすると、0.42秒しか回っていないのに
    // 「もう85%終わった」と出て、手も薬莢も最後の一瞬しか動かない
    const span = d.reloadKind === 'shell' ? d.shellTime : d.reloadTime;
    const p = reloading ? clamp01(1 - this.reloading / span) : 0;

    /* ---- ボルト。発砲で1往復し、撃ち切ると後退位置で止まる */
    let boltOff = 0;
    if (this.boltCycle > 0) {
      this.boltCycle = Math.max(0, this.boltCycle - dt / v.boltTime);
      const u = 1 - this.boltCycle;
      // 後退は速く、戻りはゆっくり。実物の動きに近づく
      boltOff = u < 0.34 ? u / 0.34 : 1 - (u - 0.34) / 0.66;
    }
    if (w.boltLocked) {
      // 装填の終盤で槓桿を引いて解放する
      boltOff = reloading ? (p < 0.86 ? 1 : 1 - ease(seg(p, 0.86, 0.93))) : 1;
    }
    if (P.bolt) P.bolt.position.z = P.boltRest + boltOff * v.boltTravel;
    // 排莢口カバーはボルトが動いている間だけ開く
    if (P.dust) P.dust.rotation.z = -boltOff * 1.45;

    /* ---- 弾倉。反動では遅れて揺れ、装填では抜けて落ちて差し変わる */
    /* 反動のばね(上のkick系)と同じで、dtをそのまま使うと重い画面(低fps)で
       発散する。dt=0.1が続く端末で弾倉が回り続けた(実際に「弾倉がめっちゃ
       ぐるぐる回ってる」と言われた)。kick系は刻みを分割して直してあったのに、
       このばねだけ対策から漏れていた。同じ刻み方で分割する */
    const wobSteps = Math.max(1, Math.ceil(dt / 0.02));
    const wobH = dt / wobSteps;
    for (let i = 0; i < wobSteps; i++) {
      this.magWobV += (-this.magWob * 260 - this.magWobV * 16) * wobH;
      this.magWob += this.magWobV * wobH;
    }
    if (P.mag && w.magRest) {
      const R = w.magRest;
      if (reloading && d.reloadKind === 'mag') {
        if (p < 0.40) {
          P.mag.visible = true;
          P.mag.position.copy(R);
          P.mag.rotation.set(0, 0, 0);
        } else if (p < 0.60) {
          const k = seg(p, 0.40, 0.58);
          P.mag.visible = k < 0.98;
          P.mag.position.set(R.x + k * 0.014, R.y - k * k * 0.55, R.z + k * 0.05);
          P.mag.rotation.set(k * 2.0, 0, k * 0.5);
        } else if (p < 0.62) {
          P.mag.visible = false;
        } else {
          const k = ease(seg(p, 0.62, 0.72));
          P.mag.visible = true;
          P.mag.position.set(R.x, R.y - (1 - k) * 0.16
            - Math.sin(seg(p, 0.72, 0.80) * Math.PI) * 0.004, R.z + (1 - k) * 0.03);
          P.mag.rotation.set((1 - k) * 0.45, 0, 0);
        }
      } else {
        P.mag.visible = true;
        P.mag.position.copy(R);
        P.mag.rotation.set(this.magWob, 0, this.magWob * 0.4);
      }
    }

    /* ---- 引金と人差し指 */
    this.trigT = THREE.MathUtils.damp(this.trigT, this.trigTarget, 30, dt);
    if (P.trigger) P.trigger.rotation.x = -this.trigT * 0.32;
    const ix = P.handR && P.handR.userData.index;
    if (ix) {
      // 曲げるだけだと届いてしまうので、少し手前へ引いて「引いた」ように見せる
      ix.rotation.x = -this.trigT * 0.22;
      ix.position.z = P.handR.userData.indexZ + this.trigT * 0.006;
    }

    /* ---- ポンプ。発砲後の排莢と、装填の最後の一動作 */
    if (P.pump) {
      let po = 0;
      if (this.pumping > 0 && d.pumpTime) po = Math.sin((1 - this.pumping / d.pumpTime) * Math.PI);
      // 装填中にポンプを引く動きは入れない。
      // この表は1発ぶんで1周するので、ここに置くと**1発入れるたびに引く**ことになる。
      // ポンプは発砲の後に引く物なので、上のpumpingだけが受け持つ
      P.pump.position.z = P.pumpRest + po * 0.075;
    }

    /* ---- 装填中のシェル。1発を出し入れして繰り返し装弾に見せる */
    if (P.shell) {
      let on = false;
      if (reloading && d.reloadKind === 'shell') {
        for (let i = 0; i < SHELL_INS.length; i++) {
          const a = SHELL_INS[i][0], b = SHELL_INS[i][1];
          if (p >= a && p < b) {
            const k = ease(seg(p, a, b));
            P.shell.position.set(
              lerp(0.052, 0.004, k), lerp(-0.230, -0.038, k), lerp(0.050, -0.010, k));
            P.shell.rotation.set(lerp(0.55, 0.04, k), lerp(0.45, 0.0, k), 0);
            on = true;
            break;
          }
        }
      }
      P.shell.visible = on;
    }

    /* ---- ドットの滲みをわずかに脈打たせる。生きた光に見える */
    if (P.dotGlow) {
      const k = 1 + Math.sin(this.idleTime * 8.5) * 0.05;
      P.dotGlow.scale.set(k, k, 1);
    }

    this._poseHands(w, d, p, reloading);
  }

  // 左手の位置。構えている間は握り位置、装填中は工程表に沿って動かす
  _poseHands(w, d, p, reloading) {
    const P = w.parts;
    const L = P.handL;
    const H = w.holdL;
    if (!L || !H.rest) return;

    if (reloading) {
      const path = d.reloadKind === 'shell' ? PATH_SHELL
        : (w.boltLocked ? PATH_EMPTY : PATH_TAC);
      for (let i = 0; i < path.length; i++) {
        const s = path[i];
        if (p <= s[1] || i === path.length - 1) {
          const t = ease(seg(p, s[0], s[1]));
          const a = H[s[2]], b = H[s[3]];
          L.position.lerpVectors(a.p, b.p, t);
          L.rotation.set(
            lerp(a.r.x, b.r.x, t), lerp(a.r.y, b.r.y, t), lerp(a.r.z, b.r.z, t));
          break;
        }
      }
    } else {
      L.position.copy(H.rest.p);
      L.rotation.copy(H.rest.r);
    }

    // ポンプ式は左手がポンプと一緒に前後する
    if (P.pump) L.position.z += P.pump.position.z - P.pumpRest;
  }

  // 視点の角速度。銃を遅れて追従させるのに使う
  _lookVel(player, key) {
    const cur = key === 'yaw' ? player.yaw : player.pitch;
    const prev = this[`_prev_${key}`] ?? cur;
    this[`_prev_${key}`] = cur;
    let dv = cur - prev;
    if (key === 'yaw') {
      if (dv > Math.PI) dv -= Math.PI * 2;
      if (dv < -Math.PI) dv += Math.PI * 2;
    }
    return clamp(dv * 2.2, -0.06, 0.06);
  }

  /**
   * 持って出ている銃の予備弾を満タンへ戻す。地面の物を拾った時に呼ぶ。
   *
   * **弾の数はサーバーが持っていない。** 撃った回数を数えているのは手元だけなので、
   * 「拾った」という知らせを受けて手元が戻す形になる。
   * 拾えるかどうかを決めるのはサーバー（近づいたかどうか）なので、
   * ここを書き換えても好きな時に補給はできない。
   *
   * マガジンの中身は戻さない。戻すと、撃ち切る直前に拾えば装填を飛ばせることになり、
   * 「弾切れで一度下がる」という間が消える。
   *
   * @returns 1本でも増えたか（何も増えなかった時に「補給した」と出さないため）
   */
  refillReserve() {
    let got = false;
    // 数字キーの4本＋Qの1本。Qの物を外すと、訓練場で狙撃銃だけ弾が戻らない
    for (const i of [...this.carry, this.quickIndex]) {
      if (i == null) continue;
      const w = this.weapons[i];
      if (!w || !w.def.reserve) continue;   // ナイフと手榴弾は予備弾を持たない
      if (w.reserve >= w.def.reserve) continue;
      w.reserve = w.def.reserve;
      got = true;
    }
    return got;
  }

  resetAll() {
    for (const w of this.weapons) {
      w.ammo = w.def.mag;
      w.reserve = w.def.reserve;
      w.spread = w.def.spreadHip;
      w.model.visible = false;
      w.flash.visible = false;
      w.restPose();
    }
    // 投げ物も配り直す。**弾と同じ扱い**（出撃のたびに満タンから始まる）
    this.nades = NADE.PER_ROUND;
    this.index = 0;
    // Qで戻る先も出撃前へ。**quickIndex(何が持てるか)は消さない。**
    // あれは波が決める物で、湧き直しでは変わらない
    this.quickBack = null;
    this.current.model.visible = true;
    this.reloading = 0;
    this.shellReload = false;
    this._shellLower = 0;
    this.switching = 0;
    this.pumping = 0;
    this.adsFactor = 0;
    // 包帯を持ったまま死ぬと、湧き直した所でも持ったままになっていた
    this.bandageOut = false;
    this._healBlend = 0;
    this._wasHealing = false;
    if (this.bandage) this.bandage.visible = false;
    // ラウンドを跨いで覗きっぱなし・バースト途中が残らないようにする
    this.adsHeld = false;
    this.wantAds = false;
    this.burstLeft = 0;
    // 手榴弾を構えたまま(離さずに)死ぬと、湧き直した所でも構えたままになっていた
    this._throwCharging = false;
    this.shotIndexInMag = 0;
    this.boltCycle = 0;
    this.magWob = 0; this.magWobV = 0;
    this.trigT = 0; this.trigTarget = 0;
    this._ejectDelay = -1;
    this.flashTimer = 0;
    this.smokeTimer = 0;
    this.muzzleLight.intensity = 0;
    this.viewMuzzleLight.intensity = 0;
    this.kickZ = 0; this.kickZv = 0;
    this.kickY = 0; this.kickYv = 0;
    this.kickX = 0; this.kickXv = 0;
    this.kickPitch = 0; this.kickPitchV = 0;
    this.kickYaw = 0; this.kickYawV = 0;
    this.spreadHold = 0;
  }
}
