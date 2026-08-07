// 1人ぶんの権威シミュレーション。移動も当たり判定もここが最終決定。
//
// 要はクライアントと同じPlayerクラスをサーバーでも回す、という一点に尽きる。
// 別実装の「サーバー用の簡易移動」を書いた瞬間、段差の乗り越えや壁ずりが必ず食い違って、
// 撃ち合いの最中に位置が引き戻される（いわゆるラバーバンド）。
// だからPlayerには一切手を入れず、入力の偽物だけを用意して同じコードを走らせる。
import './dom-stub.js';
import * as THREE from 'three';
import { Player } from '../src/player/player.js';
import {
  K, S, TICK_DT, TICK_HZ, HISTORY_MS, MAX_REWIND_MS, INTERP_DELAY_MS,
  HITBOX, PART, PART_MUL, loadoutOf,
} from '../src/net/protocol.js';

/* ------------------------------------------------------------ 武器の表 */

// weapons.jsが読めなかった時の退避。サーバーが要るのは弾の強さと距離減衰だけなので、
// 見た目・音・反動は持たない。値はweapons.jsのWEAPONSから写したもの。
//
// **写しなので、weapons.js側を触ると黙ってずれる。**
// ずれたまま退避へ落ちた日は、弾の強さも距離減衰も別物のサーバーで対戦することになり、
// 「今日はやけに固い」としか分からない。tools/check-weapons.mjs の[6]が写し間違いを見張るので、
// 検査から読めるようにexportしてある
export const FALLBACK_WEAPONS = [
  {
    id: 'rifle', name: 'MK-4 カービン', damage: 27, rpm: 640, pellets: 1,
    mag: 25, reloadTime: 2.15, adsTime: 0.16,
    range: 120, falloffStart: 42, falloffEnd: 95, falloffMin: 0.5,
  },
  {
    id: 'shotgun', name: 'M870 ショットガン', damage: 13, rpm: 78, pellets: 9,
    mag: 7, reloadTime: 2.9, adsTime: 0.2,
    range: 40, falloffStart: 8, falloffEnd: 26, falloffMin: 0.18,
  },
  {
    id: 'pistol', name: 'P-9 サイドアーム', damage: 26, rpm: 400, pellets: 1,
    mag: 15, reloadTime: 1.55, adsTime: 0.11,
    range: 70, falloffStart: 18, falloffEnd: 46, falloffMin: 0.42,
  },
  {
    id: 'knife', name: 'ナイフ', damage: 70, rpm: 95, pellets: 1,
    mag: 9999, reloadTime: 0, adsTime: 0.16,
    range: 1.8, falloffStart: 1.8, falloffEnd: 1.8, falloffMin: 1.0,
  },
  {
    // 手榴弾は撃たないので、当たり判定の値は使われない。
    // 表の並びをクライアントと揃えるためだけに置く（番号がずれると別の武器になる）
    id: 'nade', name: '手榴弾', damage: 0, rpm: 40, pellets: 1,
    mag: 9999, reloadTime: 0, adsTime: 0.16,
    range: 0, falloffStart: 0, falloffEnd: 0, falloffMin: 1,
  },
];

// weapons.jsは別チームが触っている最中に構文エラーで読めないことがある。
// そこで落とすと対戦そのものが立たないので、退避表に切り替えて起動は通す
let WEAPONS = FALLBACK_WEAPONS;
let weaponsSource = 'fallback';
try {
  const m = await import('../src/player/weapons.js');
  if (Array.isArray(m.WEAPONS) && m.WEAPONS.length > 0) {
    WEAPONS = m.WEAPONS;
    weaponsSource = 'weapons.js';
  }
} catch (e) {
  console.warn(`[sim] weapons.jsを読めなかったので内蔵の表を使う: ${e.message}`);
}
export { WEAPONS, weaponsSource };

export const weaponDef = (i) => WEAPONS[(i | 0) >= 0 && (i | 0) < WEAPONS.length ? (i | 0) : 0];

/* -------------------------------------------------- 入力の偽物（Input互換） */

// protocol.jsのビットを、Playerが聞いてくるキー名に翻訳するだけの対応表
const CODE_BIT = {
  KeyW: K.FWD, KeyS: K.BACK, KeyA: K.LEFT, KeyD: K.RIGHT,
  Space: K.JUMP, ControlLeft: K.CROUCH, ShiftLeft: K.SPRINT, KeyR: K.RELOAD,
  KeyF: K.HEAL,
};

const ZERO_LOOK = { yaw: 0, pitch: 0 };

// src/core/input.js と同じ意味を返す最小の実装。
// テスト側でも同じ物を使ってクライアント役を回せるようにexportしてある
export class ServerInput {
  constructor() {
    this.bits = 0;
    this.prev = 0;
    this._move = { x: 0, z: 0 };
  }

  // 1刻みぶんの押しているキーを差し替える。前回分を残すのはpressed()の立ち上がり判定のため
  set(bits) {
    this.prev = this.bits;
    this.bits = bits | 0;
  }

  down(code) {
    const b = CODE_BIT[code];
    return b !== undefined && (this.bits & b) !== 0;
  }

  // 「その刻みで0→1に変わった時だけ」。押しっぱなしでtrueを返すとジャンプが毎刻み出る
  pressed(code) {
    const b = CODE_BIT[code];
    return b !== undefined && (this.bits & b) !== 0 && (this.prev & b) === 0;
  }

  moveVector(out) {
    let x = 0, z = 0;
    if (this.bits & K.FWD) z -= 1;
    if (this.bits & K.BACK) z += 1;
    if (this.bits & K.LEFT) x -= 1;
    if (this.bits & K.RIGHT) x += 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    out.x = x; out.z = z;
    return out;
  }

  // 視点は電文のyaw/pitchを直接使うので、ここで返す値は誰も読まない。
  // それでもPlayerがlookEnabled=falseでもtakeLook()を呼ぶので、無いと落ちる
  takeLook() { return ZERO_LOOK; }
}

/* ------------------------------------------------ 当たり判定（enemy.jsと同じ式） */

// src/ai/enemy.js の raySphere / rayCapsule をそのまま持ってきた。
// 撃つ側の画面（enemy.jsの判定）とサーバーの判定が別式だと、
// 見えている当たり所と実際の当たり所がずれる
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

// 使い回しの入れ物。1発ごとに新しいベクトルを作ると毎秒数千個のごみになる
const _c = { x: 0, y: 0, z: 0 };
const _a = { x: 0, y: 0, z: 0 };
const _b = { x: 0, y: 0, z: 0 };

// 頭が胴より優先される幅。胴を1本貫いた程度の長さ。
// これより前に別の部位へ入っていたら「体を貫いてから頭に届いた」ということなので、
// 手前の部位を採る（真下から脚越しに撃った弾が頭部判定になるのを防ぐ）
const HEAD_SPAN = HITBOX.CHEST_R * 2;

// 姿勢（足元の座標と身長）から3つの当たり所を作る。部位は縦に積まれているだけなのでyawは要らない。
//
// 部位を「一番手前」だけで決めてはいけない。protocol.jsのHITBOXだと
// 頭の球(1.416〜1.716)は胴カプセルの上端の球(1.202〜1.722)に完全に埋まっていて、
// 正面から水平に撃つと必ず胴の面の方が手前に来る＝頭に永久に当たらなくなる。
// だから頭に触れているならまず頭とみなし、明らかに体を貫いた後の場合だけ手前の部位に譲る
export function hitPose(pose, origin, dir) {
  const h = pose.h;
  // まず全身を包む球で足切りする。ほとんどの相手はこれで落ちるので、
  // 8人ぶんのカプセル計算を毎発やらずに済む
  _c.x = pose.x; _c.y = pose.y + h * 0.5; _c.z = pose.z;
  if (raySphere(origin, dir, _c, h * 0.5 + HITBOX.RADIUS) < 0) return null;

  _c.x = pose.x; _c.y = pose.y + h * HITBOX.HEAD_AT; _c.z = pose.z;
  const th = raySphere(origin, dir, _c, HITBOX.HEAD_R);

  _a.x = pose.x; _a.y = pose.y + h * HITBOX.CHEST_FROM; _a.z = pose.z;
  _b.x = pose.x; _b.y = pose.y + h * HITBOX.CHEST_TO; _b.z = pose.z;
  const tc = rayCapsule(origin, dir, _a, _b, HITBOX.CHEST_R);

  _a.y = pose.y + h * HITBOX.LEG_FROM;
  _b.y = pose.y + h * HITBOX.LEG_TO;
  const tl = rayCapsule(origin, dir, _a, _b, HITBOX.LEG_R);

  let best = -1;
  let part = -1;
  if (tc >= 0) { best = tc; part = PART.CHEST; }
  if (tl >= 0 && (best < 0 || tl < best)) { best = tl; part = PART.LEG; }
  if (th >= 0 && (best < 0 || th - best <= HEAD_SPAN)) { best = th; part = PART.HEAD; }

  return best < 0 ? null : { t: best, part };
}

/* -------------------------------------------------------------- 履歴 */

// 武器を持ち替えてから撃てるようになるまで。
// weapons.jsのswitchingが0.42秒なので、正当な弾がこれで消えることはない
const SWAP_LOCK_S = 0.3;

// 巻き戻しに使う輪状の履歴。HISTORY_MSぶん残せばMAX_REWIND_MSは必ず届く
const HIST_LEN = Math.ceil((HISTORY_MS / 1000) * TICK_HZ) + 2;

const lerpAngle = (a, b, t) => {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
};

/* ---------------------------------------------------------- 1人ぶん */

export class SimPlayer {
  constructor(id, name, world) {
    this.id = id;
    this.name = name;
    this.world = world;

    // カメラはObject3Dで足りる。Playerがカメラに触るのは_applyCameraだけで、
    // そこがやるのはpositionとrotation(order='YXZ')の書き込みだけ
    this.player = new Player(new THREE.Object3D(), world);
    this.input = new ServerInput();

    // 持って出ている物の番号。既定は protocol.js の LOADOUT_IDS。
    // ガンゲームで配る時はここを差し替える
    this.carry = loadoutOf(WEAPONS);
    this.weapon = this.carry[0] ?? 0;
    this.adsFactor = 0;
    this.kills = 0;
    this.deaths = 0;
    this.ping = 0;

    this.respawnIn = 0;
    this.protectIn = 0;
    this.reloadIn = 0;
    this.swapIn = 0;
    // 連射の上限。弾数までは持たないが、rpmを超えて撃てないことだけは押さえる
    this.fireTokens = 0;
    this._fireCap = 1;
    this._refill = 1;
    this._applyWeaponRate();

    this._hist = [];
    for (let i = 0; i < HIST_LEN; i++) {
      this._hist.push({ ms: -1, x: 0, y: 0, z: 0, h: HITBOX.STAND_H, yaw: 0, pitch: 0, alive: true });
    }
    this._hi = -1;   // 最後に書いた位置
    this._hn = 0;    // 溜まった数

    this._pose = { x: 0, y: 0, z: 0, h: HITBOX.STAND_H, yaw: 0, pitch: 0, alive: true };
    this._eye = new THREE.Vector3();
  }

  get def() { return weaponDef(this.weapon); }
  get alive() { return this.player.alive; }
  get hp() { return this.player.health; }

  _applyWeaponRate() {
    const d = this.def;
    const pellets = Math.max(1, d.pellets | 0);
    const rpm = Math.max(1, d.rpm || 600);
    this._refill = pellets / (60 / rpm);     // 1秒あたりに撃てる弾の数
    this._fireCap = pellets * 3;             // 取りこぼしをまとめて出す余裕
    // ここで満タンに戻してはいけない。武器を切り替えるだけで発射権が湧き、
    // 0と1を交互に送るだけで連射の上限が消える（サーバー側の射撃の制限はこれ1つしかない）。
    // 補充はspawn()だけ。上限が下がる持ち替えでは、はみ出した分だけ切る
    if (this.fireTokens > this._fireCap) this.fireTokens = this._fireCap;
  }

  /**
   * 持ち物を差し替える。ガンゲームで段が進んだ時にRoomが呼ぶ。
   *
   * 今握っている武器が新しい持ち物に入っていなければ、先頭へ持ち替える。
   * **その時は持ち替えの間(swapIn)を必ず置く。** 置かないと、
   * 倒した瞬間に次の武器で撃てることになり、連続で倒すのが強すぎる
   */
  setCarry(list) {
    this.carry = Array.isArray(list) && list.length ? list.slice() : [0];
    if (this.carry.includes(this.weapon)) return;
    this.weapon = this.carry[0];
    this.reloadIn = 0;
    this.swapIn = SWAP_LOCK_S;
    this._applyWeaponRate();
  }

  setWeapon(i) {
    const n = i | 0;
    if (n < 0 || n >= WEAPONS.length || n === this.weapon) return false;
    // 持って出ていない武器は握らせない。**ここが無いと、電文を作れる人は
    // 表にある武器を何でも使える。** 画面には持って出ていない物が写らないので、
    // 撃たれた側からは「見えていない武器で撃たれた」ようにしか見えない
    if (!this.carry.includes(n)) return false;
    this.weapon = n;
    this.reloadIn = 0;
    // 持ち替えの間は撃てない。weapons.jsのswitchingは0.42秒だが、
    // 電文が届くぶんサーバー側の方が遅れて始まるので、その片道ぶんを短くしてある
    this.swapIn = SWAP_LOCK_S;
    this._applyWeaponRate();
    return true;
  }

  // 湧く。身長を立ち姿に戻してからteleportしないと、
  // しゃがんだまま死んだ人が縮んだ当たり判定で復帰する
  spawn(pos, yaw) {
    this.player.height = HITBOX.STAND_H;
    this.player.health = this.player.maxHealth;
    this.player.alive = true;
    this.player.yaw = yaw;
    this.player.pitch = 0;
    this.player.teleport(pos);
    this.adsFactor = 0;
    this.player.adsFactor = 0;
    this.respawnIn = 0;
    this.reloadIn = 0;
    this.swapIn = 0;
    this.fireTokens = this._fireCap;
    // 履歴も捨てる。湧く前の座標へ巻き戻して当てられるのは理不尽
    this._hi = -1;
    this._hn = 0;
  }

  // 1刻み進める。yaw/pitchは電文の値をそのまま採用するので、
  // Playerのマウス処理(lookEnabled)は切っておく
  tick(bits, yaw, pitch) {
    const p = this.player;
    this.input.set(bits);
    p.yaw = yaw;
    p.pitch = pitch < -1.5 ? -1.5 : pitch > 1.5 ? 1.5 : pitch;

    // 包帯。このビットは「Fを押している」ではなく「今まさに巻いている」を表す。
    // 立ち上がりで開始し、落ちたら中断する。
    // 中断まで見るのは、向こうで武器を持ち替えて巻くのをやめた時に、
    // こちらだけ最後まで巻き切って体力が食い違うのを防ぐため
    if (this.input.pressed('KeyF')) p.startHeal();
    else if (!this.input.down('KeyF') && p.healing > 0) p.cancelHeal();

    p.update(TICK_DT, this.input, false);

    // main.jsはplayer.update()の後にweapons.update()を呼ぶ。
    // つまりadsFactorは常に1刻み前の値が移動に効く。順番を合わせないとここだけずれる
    const d = this.def;
    const want = (bits & K.ADS) !== 0 && !p.sprinting && p.alive;
    const target = want ? 1 : 0;
    const speed = (1 / Math.max(d.adsTime || 0.16, 0.01)) * 1.6;
    this.adsFactor = THREE.MathUtils.damp(this.adsFactor, target, speed, TICK_DT);
    if (Math.abs(this.adsFactor - target) < 0.002) this.adsFactor = target;
    p.adsFactor = this.adsFactor;

    if (this.input.pressed('KeyR') && this.reloadIn <= 0 && p.alive) {
      this.reloadIn = d.reloadTime || 2;
    }
  }

  // 実時間で減る物だけ。装填も持ち替えも無敵も連射も「何秒経ったか」の話なので、
  // 入力が届いた刻みだけで減らすと、送るのを止めれば無敵が切れないことになる。
  // Roomが入力の有無に関係なく毎刻み呼ぶ
  clock(dt) {
    if (this.reloadIn > 0) this.reloadIn = Math.max(0, this.reloadIn - dt);
    if (this.protectIn > 0) this.protectIn = Math.max(0, this.protectIn - dt);
    if (this.swapIn > 0) this.swapIn = Math.max(0, this.swapIn - dt);
    this.fireTokens = Math.min(this._fireCap, this.fireTokens + this._refill * dt);
  }

  // 今の姿勢を履歴に1件積む。当たり判定は足元基準なのでfeetYを残す
  record(ms) {
    this._hi = (this._hi + 1) % HIST_LEN;
    if (this._hn < HIST_LEN) this._hn++;
    const h = this._hist[this._hi];
    const p = this.player;
    h.ms = ms;
    h.x = p.collider.start.x;
    h.y = p.feetY;
    h.z = p.collider.start.z;
    h.h = p.height;
    h.yaw = p.yaw;
    h.pitch = p.pitch;
    h.alive = p.alive;
  }

  pose() {
    const p = this.player;
    const o = this._pose;
    o.x = p.collider.start.x;
    o.y = p.feetY;
    o.z = p.collider.start.z;
    o.h = p.height;
    o.yaw = p.yaw;
    o.pitch = p.pitch;
    o.alive = p.alive;
    return o;
  }

  // 指定時刻の姿勢。履歴の外を指されたら一番近い端で妥協する
  poseAt(ms) {
    if (this._hn === 0) return this.pose();
    const newest = this._hist[this._hi];
    if (ms >= newest.ms) return this.pose();

    const oldestIdx = (this._hi - this._hn + 1 + HIST_LEN * 2) % HIST_LEN;
    const oldest = this._hist[oldestIdx];
    if (ms <= oldest.ms) return oldest;

    // 新しい方から辿る。探すのはたいてい直近の数件なので線形で十分
    for (let k = 0; k < this._hn - 1; k++) {
      const bi = (this._hi - k + HIST_LEN) % HIST_LEN;
      const ai = (bi - 1 + HIST_LEN) % HIST_LEN;
      const b = this._hist[bi];
      const a = this._hist[ai];
      if (a.ms <= ms && ms <= b.ms) {
        const span = b.ms - a.ms;
        const t = span > 1e-6 ? (ms - a.ms) / span : 0;
        const o = this._pose;
        o.x = a.x + (b.x - a.x) * t;
        o.y = a.y + (b.y - a.y) * t;
        o.z = a.z + (b.z - a.z) * t;
        o.h = a.h + (b.h - a.h) * t;
        o.yaw = lerpAngle(a.yaw, b.yaw, t);
        o.pitch = a.pitch + (b.pitch - a.pitch) * t;
        // 区間の途中で死んだ場合、その時刻にはまだ生きていたとみなす
        o.alive = a.alive;
        return o;
      }
    }
    return this.pose();
  }

  // 撃った位置の妥当性を見るための目の高さ。player.jsの_applyCameraと同じ式の芯だけ使う
  // （バネの揺れは含めない。含めても数cmの上下でしかなく、その分は許容範囲で吸収する）
  eye(out = this._eye) {
    const p = this.player;
    out.set(p.collider.start.x, p.feetY + p.height - 0.16, p.collider.start.z);
    return out;
  }

  stateBits() {
    const p = this.player;
    let s = 0;
    if (p.crouching) s |= S.CROUCH;
    if (p.sprinting) s |= S.SPRINT;
    if (!p.onFloor) s |= S.AIR;
    if (this.adsFactor > 0.5) s |= S.ADS;
    if (!p.alive) s |= S.DEAD;
    if (this.reloadIn > 0) s |= S.RELOAD;
    return s;
  }

  // protocol.packPlayer に渡す形。x/y/zは足元の位置
  // （当たり判定の寸法が全部足元からの割合なので、足元を配れば形が一意に決まる）
  packSource() {
    const p = this.player;
    return {
      id: this.id,
      x: p.collider.start.x,
      y: p.feetY,
      z: p.collider.start.z,
      yaw: p.yaw,
      pitch: p.pitch,
      state: this.stateBits(),
      hp: p.health,
      weapon: this.weapon,
    };
  }
}

/* ------------------------------------------------------ 射撃の解決 */

const _ray = new THREE.Ray();
const _n = new THREE.Vector3();
const _eyeRay = new THREE.Ray();

// 申告された発射位置が、本人の目から実際に見えている所か。
// 目からの距離だけで許すと、間に何があっても構わないので、
// 曲がり角に隠れたまま壁の向こう側へ発射位置を出して撃てる
export function originVisible(octree, eye, origin) {
  const dx = origin.x - eye.x, dy = origin.y - eye.y, dz = origin.z - eye.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-4) return true;
  _eyeRay.origin.copy(eye);
  _eyeRay.direction.set(dx / d, dy / d, dz / d);
  const hit = octree.rayIntersect(_eyeRay);
  return !hit || hit.distance >= d;
}

// 三角形から面の法線を作る。着弾のデカールを貼る向きに要る
function faceNormal(tri, dir, out) {
  out.set(0, 1, 0);
  if (!tri) return out;
  const ax = tri.b.x - tri.a.x, ay = tri.b.y - tri.a.y, az = tri.b.z - tri.a.z;
  const bx = tri.c.x - tri.a.x, by = tri.c.y - tri.a.y, bz = tri.c.z - tri.a.z;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-9) return out;
  out.set(nx / len, ny / len, nz / len);
  // 撃った側へ向ける。裏を向いた法線でデカールを貼ると壁の中に貼られる
  if (out.x * dir.x + out.y * dir.y + out.z * dir.z > 0) out.multiplyScalar(-1);
  return out;
}

// 弾1発。壁で止まり、貫通も跳弾もしない。
// targetsは撃った本人を除いた相手の配列、atMsは「撃った人の画面に映っていた時刻」
export function resolveShot({ octree, origin, dir, def, targets, atMs, rewind = true }) {
  _ray.origin.copy(origin);
  _ray.direction.copy(dir);

  const range = def.range || 100;
  const wall = octree.rayIntersect(_ray);
  const wallDist = wall ? wall.distance : Infinity;

  let bestT = Infinity;
  let bestPart = -1;
  let bestTarget = null;

  for (let i = 0; i < targets.length; i++) {
    const tgt = targets[i];
    const pose = rewind ? tgt.poseAt(atMs) : tgt.pose();
    if (!pose.alive) continue;
    const h = hitPose(pose, origin, dir);
    if (!h) continue;
    if (h.t < bestT) { bestT = h.t; bestPart = h.part; bestTarget = tgt; }
  }

  // 相手より手前に壁があれば当たらない。これで壁越しの射撃が消える
  if (bestTarget && bestT <= range && bestT < wallDist) {
    const t = def.falloffEnd > def.falloffStart
      ? Math.min(1, Math.max(0, (bestT - def.falloffStart) / (def.falloffEnd - def.falloffStart)))
      : 0;
    const mul = 1 + (def.falloffMin - 1) * t;
    // 部位倍率はサーバーが持つ（protocol.jsのPART_MUL）。
    // weapons.jsのheadMultは単騎モードの数字なので対戦では使わない
    const dmg = def.damage * mul * (PART_MUL[bestPart] ?? 1);
    return {
      kind: 'player',
      target: bestTarget,
      part: bestPart,
      dist: bestT,
      dmg,
      point: [
        origin.x + dir.x * bestT,
        origin.y + dir.y * bestT,
        origin.z + dir.z * bestT,
      ],
    };
  }

  if (wall && wallDist <= range) {
    faceNormal(wall.triangle, dir, _n);
    return {
      kind: 'wall',
      dist: wallDist,
      point: [wall.position.x, wall.position.y, wall.position.z],
      normal: [_n.x, _n.y, _n.z],
    };
  }

  return { kind: 'miss', dist: range };
}

// 巻き戻す量。撃った人の画面は「往復遅延の半分＋補間の遅らせ」だけ過去を映している。
// staleTicksは電文のseqが今の刻みからどれだけ古いか（撃った瞬間からの経過ぶん）
export function rewindMs(rtt, staleTicks) {
  const ms = Math.max(0, staleTicks) * (1000 / TICK_HZ)
    + Math.max(0, rtt) * 0.5
    + INTERP_DELAY_MS;
  return Math.min(ms, MAX_REWIND_MS);
}
