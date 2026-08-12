// 対戦のCPU。**「入力を自分で作る人」**として席に座る。
//
// なぜ要るか: 対戦は2人揃わないと始まらないので、**1人だと一度も動作確認できない。**
// 撃たれる・倒れる・生き返る・観戦カメラ・キルログ・順位表は、
// 相手がいて初めて動く所なのに、そこを一度も見ずに本番へ出していた（2026-08-09）。
//
// **見せかけの相手を画面側に描く形にはしていない。**
// それだと確かめられるのは絵だけで、当たり判定も巻き戻しもラウンド進行も通らない。
// ここが作るのは human と同じ「1刻みぶんの入力（キーのビット・向き）」だけで、
// あとは room.js が人と同じ道（_feed → sim.tick → shot）へ流す。
// だから**人でしか通らない道が1本も残らない。**
//
// 強くしすぎない:
//   ・向きは1刻みで少ししか回せない（TURN_RATE）。振り向きざまの即死が無い
//   ・狙いは胸で、常に少し揺れている（WOBBLE）。頭ばかり抜かない
//   ・見つけてから撃ち始めるまで間がある（REACT_S）
//   ・弾倉を自分で数えて、撃ち切ったら装填で止まる
//     （**サーバーは弾数を持っていない。** 持っているのは連射の速さだけなので、
//      ここで数えないとCPUだけ無限に撃ち続ける人になる）
import './dom-stub.js';
import * as THREE from 'three';
import { K } from '../src/net/protocol.js';
import { originVisible } from './sim.js';

/* ------------------------------------------------------------ さじ加減 */

/* **2026-08-11に全体を大きく弱くした。**
   「対戦モードの敵がマジで強すぎる。こっちはmacのトラックパッドだから無理。
     マウスでも勝てるかわからん」と言われた所。

   **トラックパッドは指の可動域が狭い。** マウスなら手首で180度振り向けるが、
   トラックパッドは指を持ち上げて置き直す動作が入るので、
   振り向きに何倍もかかる。CPUは計算で一瞬で向けるので、
   「速さ」で差が付く項目は全部こちらが負ける。

   だから落としたのは速さに効く物（反応・振り向き）と、当てる精度の両方。
   前の値は括弧の中に残してある。**戻したくなった時に迷わないため。**

   狭めるのは後からでもできるので、まず遊べる所まで持っていく */

// 向きを変えられる速さ(rad/s)。人が振り向くのと同じくらいに抑える。
// 上げるほど「後ろから撃っても即座に振り向いて撃ち返す」に近づく。
// 3.4→2.1。**トラックパッドの振り向きに近づける**のがここ
const TURN_RATE = 2.1;
// この角度(rad)まで狙いが寄ったら撃つ。0.055(約3度)→0.085(約5度)。
// **緩めると早く撃ち始めるが、そのぶん外す。** 当たる精度を落とす側の値
const AIM_TOL = 0.085;
// 狙いの揺れ(rad)。0にすると全弾が同じ点に当たる機械になる。0.035→0.075
const WOBBLE = 0.075;
// 揺れの速さ(rad/s)。位相を進める量
const WOBBLE_HZ = 2.3;
/* 見つけてから撃ち始めるまでの間(秒)。
   **ここが撃ち合いの勝敗をほぼ決める。** CPUは相手を見失わないし狙いも外さないので、
   先に撃ち始めた側がそのまま勝つ。0.34秒だと人より速く、
   曲がり角で出会い頭に必ず負ける（「絶対CPUの方が強い」2026-08-09）。

   0.55→1.05。**一番効く値なので一番大きく動かした。**
   人の反応が0.25秒前後なので、CPUに1秒待たせれば
   出会い頭はこちらが先に撃てる */
const REACT_S = 1.05;

/* 撃つたびに広がる散り(rad)と、収まる速さ(rad/s)、その上限。
   **人には反動があるのにCPUには無かった。** 押しっぱなしで全弾同じ点に飛ぶので、
   人から見ると「こちらは散るのに相手は散らない」撃ち合いになる。
   1発ごとに散りを足して、撃つのをやめると収まる形にする（銃の反動と同じ振る舞い）。

   0.022→0.040／上限0.085→0.170。**押しっぱなしで当て続けるのを止める側の値。**
   収まる速さ(DECAY)は上げていない。上げると間を置いたCPUがまた正確になる */
const SPREAD_PER_SHOT = 0.040;
const SPREAD_MAX = 0.170;
const SPREAD_DECAY = 0.16;

/* 連射を区切る発数と、区切りの間(秒)。
   撃ち続けられると、隠れる間も立て直す間も無い。
   人も反動が上がれば指を離すので、その呼吸をここで作る */
const BURST_MIN = 4;
const BURST_MAX = 8;
const BURST_PAUSE_S = 0.5;
// この距離(m)より遠い相手は撃たない。武器の射程より手前で切る。
// **追うのはこの外からでもやる**（追わないと、離れた所で棒立ちの相手を
// いつまでも見つけられない。詳しくはthink）
const SIGHT_R = 55;
// これより近づいたら前進をやめて横へ動く(m)。密着して棒立ちにならないため
const KEEP_R = 7;
// 走るのはこれより遠い時だけ(m)。近距離で走ると狙いが付かない
const SPRINT_R = 18;
// 横移動の向きを変える間隔(秒)
const STRAFE_S = 1.15;
// 誰も居ない時に、うろつく向きを変える間隔(秒)
const WANDER_S = 2.6;
/* 相手に近づけないまま我慢する時間(秒)。これを過ぎたら回り込みに切り替える。
   **「速さが出ているか」では駄目だった。** 壁沿いを行ったり来たりしている間は
   速さが4m/s出ていて、それでいて相手との距離は1mも縮んでいない。
   見るべきは「近づけているか」の方（2026-08-09に実測して差し替え） */
const NOPROG_S = 1.5;
// 近づいたと認める幅(m)。揺れで縮んだ分を進歩と数えないための下駄
const NOPROG_EPS = 0.5;
// 動きたいのに一歩も出ていない時、引っかかったと見なすまでの時間(秒)
const STUCK_S = 0.7;
// 引っかかったと見なす速さ(m/s)。これ以下しか出ていなければ進めていない
const STUCK_SPEED = 0.7;
// 引っかかりを外すために横を向いている時間(秒)。短いと、抜け切る前に
// 相手の方へ向き直して同じ壁へ突っ込み直す（0.9秒で往復して抜けられなかった）
const DETOUR_S = 1.8;

/* 前方の詰まりを見る線（ひげ）の長さ(m)と、左右へ振る角度(rad)。
   **これが無いと、間に建物がある相手へまっすぐ歩いて壁に張り付いたまま終わる。**
   実測で、CPU2体が建物の角で3m離れたまま30秒動けなかった（2026-08-09）。
   目の高さから水平に出すので、地面の段差や低い箱は見ない（そちらは乗り越えられる） */
const WHISKER_R = 3.2;
const WHISKER_A = 0.7;

/* 目からどれだけ下を狙うか(m)。胸のあたり。
   0にすると目＝頭を狙い続けることになり、当たれば毎回ヘッドショットになる。
   0.3→0.42。**腹のあたりまで下げてヘッドショットを減らす。**
   1発の重みが下がるので、こちらが撃ち返す時間ができる */
const AIM_DROP = 0.42;

/* ------------------------------------------------------------ 向きの計算 */

/**
 * fromからtoを向く角度。**この式はクライアントと揃っている。**
 * 向き0で前方が-Z（player.jsの移動の式と、カメラのYXZ回転から出る形）。
 * ずれると「撃った向き」と「見ている向き」が食い違って、
 * 明後日の方向へ弾が飛ぶCPUになる
 */
export function aimAt(from, to) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const flat = Math.hypot(dx, dz);
  return {
    yaw: Math.atan2(-dx, -dz),
    pitch: Math.atan2(dy, flat || 1e-6),
  };
}

/** 向き(yaw/pitch)から前方の向き。aimAtの逆。撃つ向きはここから作る */
export function forwardOf(yaw, pitch, out = { x: 0, y: 0, z: 0 }) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/**
 * curからwantへ、1回でmaxまでしか回さない。
 * 角度は±πで折り返すので、近い方向へ回ることまでここで面倒を見る
 * （見ないと、-3.1から+3.1へ回る時に長い方（ほぼ1周）を回りにいく）
 */
export function turnToward(cur, want, max) {
  let d = want - cur;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  if (d > max) d = max;
  if (d < -max) d = -max;
  return cur + d;
}

/* ------------------------------------------------------------ 頭脳 */

export class Bot {
  /**
   * @param rng 乱数。検査から種を固定して渡せるようにしてある
   *   （揺れとうろつきに乱数が要る。固定できないと検査が日によって落ちる）
   */
  constructor({ rng = Math.random } = {}) {
    this.rng = rng;
    this.reset();
  }

  /** ラウンドの頭・湧き直しで呼ぶ。狙いも弾倉も戻す */
  reset() {
    this.targetId = null;
    this._retarget = 0;     // 次に相手を選び直すまでの秒
    // 湧いた直後から満タンで撃ち始めないよう、間を持たせた状態から始める
    this._react = REACT_S;
    this._reload = 0;       // 自分で数えている装填の残り秒
    this._mag = -1;         // 残弾。-1は「まだ武器を見ていない」
    this._strafe = 1;       // 横へ動く向き
    this._strafeIn = 0;
    this._wanderYaw = null;
    this._wanderIn = 0;
    this._wobble = 0;
    this._stuck = 0;
    this._detour = 0;       // 引っかかった時に横へ逃がす角度
    this._detourIn = 0;
    this._best = Infinity;  // その相手にどこまで近づけたか（一番近かった距離）
    this._noProg = 0;       // それより近づけないまま経った秒数
    this._spread = 0;       // 撃つほど広がる散り（反動の代わり）
    this._burst = 0;        // この連射であと何発撃つか
    this._pause = 0;        // 連射の区切りの残り秒
    this._pressReload = false;
  }

  /**
   * 1刻みぶん考える。返すのは人が送ってくるのと同じ形の入力。
   *
   * @param me   自分のSimPlayer
   * @param foes 敵のSimPlayerの並び（味方は room 側で外してある）
   * @param octree 地形。見えているかの判定に使う
   * @param live  今ラウンドが動いているか。動いていなければ棒立ち
   * @returns { bits, yaw, pitch, fire }
   */
  think(me, foes, octree, dt, live) {
    const p = me.player;
    /* fireYaw/firePitchは「弾が飛ぶ向き」。yaw/pitchの「見ている向き」とは別物で、
       散り(反動の代わり)のぶんだけずれる。人の銃も、狙った点そのものではなく
       その周りの円のどこかへ飛ぶので、そこを揃えてある */
    const out = { bits: 0, yaw: p.yaw, pitch: p.pitch, fire: false, fireYaw: 0, firePitch: 0 };
    // 倒れている間とロビーでは何もしない。
    // ここで動かすと、幕間に走り回るCPUが全員の画面に映る
    if (!live || !me.alive) {
      this._react = REACT_S;
      return out;
    }

    const def = me.def;
    // 武器が変わったら弾倉を数え直す（ガンゲームで持ち物が進む）
    if (this._mag < 0) this._mag = def.mag | 0;

    this._wobble += WOBBLE_HZ * dt;
    // 撃つのをやめている間に散りが収まる（銃の反動が落ち着くのと同じ）
    this._spread = Math.max(0, this._spread - SPREAD_DECAY * dt);
    if (this._pause > 0) this._pause = Math.max(0, this._pause - dt);
    if (this._reload > 0) this._reload = Math.max(0, this._reload - dt);
    this._retarget -= dt;
    this._strafeIn -= dt;
    if (this._strafeIn <= 0) {
      this._strafeIn = STRAFE_S * (0.7 + this.rng() * 0.6);
      this._strafe = -this._strafe;
    }

    const eye = me.eye(_eyeA);

    /* 相手を選ぶ。**近い相手をそのまま選ぶ（見えているかは見ない）。**
       見えている相手だけを選ぶ形にしていたが、それだと物陰に立っている人を
       いつまでも見つけられず、当てもなくうろつくCPUになった
       （35m先に立っている人を30秒見つけられなかった。2026-08-09に実測）。
       **見えるかどうかは「撃つか」にだけ効かせる。**
       近づくのは見えていなくてよく、撃つのは見えている時だけ。
       選び直しは0.4秒に1回。毎刻み選び直すと、同じくらいの距離に2人いる時に
       狙いが往復してどちらにも当たらない */
    const target = this._pick(foes, eye);
    // 見えているかは選んだ1人にだけ聞く。全員に毎刻み聞くと、
    // 人数ぶんの射線判定が60Hzで走る
    /* 見えている点。**頭が隠れていても胴が出ていれば撃つ。**
       返ってきた点をそのまま狙うので、「見えている所を撃つ」が一致する */
    const at = target ? this._visibleAt(target, eye, octree) : null;
    const seen = !!at;

    let wantYaw = p.yaw;
    let wantPitch = p.pitch;
    let advance = false;
    let strafe = false;
    let dist = Infinity;

    if (target) {
      const t = target.player.collider.start;
      const teye = target.eye(_eyeB);
      /* 狙う所。**見えている点があればそこ。** 無ければ目の少し下（今まで通り）。
         胴しか見えていない時に目を狙うと、遮蔽へ撃ち続けることになる */
      if (at) _look.copy(at);
      else { _look.x = t.x; _look.y = teye.y - AIM_DROP; _look.z = t.z; }
      // 目が見えている時だけ、狙いを少し下げる（頭を狙い続けないため）
      if (at === teye) _look.y = teye.y - AIM_DROP;
      dist = Math.hypot(t.x - eye.x, t.z - eye.z);
      if (seen) {
        const a = aimAt(eye, _look);
        // 揺れは狙いそのものに乗せる。撃つ向きも同じ値から作るので、
        // 「見えている向き」と「弾の向き」が必ず一致する
        wantYaw = a.yaw + Math.sin(this._wobble) * WOBBLE;
        wantPitch = a.pitch + Math.cos(this._wobble * 0.7) * WOBBLE * 0.6;
        advance = dist > KEEP_R;
        strafe = true;
        this._react = Math.max(0, this._react - dt);
      } else {
        // 見えていない間は近づくだけ。上下は水平に戻す
        // （壁越しに相手の高さを狙ったまま歩くと、曲がった瞬間に足元か空を撃つ）
        wantYaw = aimAt(eye, _look).yaw;
        wantPitch = 0;
        advance = true;
        this._react = REACT_S;
      }
    } else {
      // 誰も見えない。うろつく
      this._wanderIn -= dt;
      if (this._wanderYaw === null || this._wanderIn <= 0) {
        this._wanderIn = WANDER_S * (0.6 + this.rng() * 0.8);
        this._wanderYaw = (this.rng() * 2 - 1) * Math.PI;
      }
      wantYaw = this._wanderYaw;
      wantPitch = 0;
      advance = true;
      this._react = REACT_S;
    }

    /* 引っかかり外し。進みたいのに速さが出ていない時間が続いたら、
       別の方角へ向き直して跳ぶ。**これが無いと壁や段差に張り付いたまま
       試合が終わる**（地形は本編のもので、階段も戸口もある） */
    const speed = Math.hypot(p.velocity.x, p.velocity.z);
    if (advance && speed < STUCK_SPEED) this._stuck += dt;
    else this._stuck = 0;
    // 進んでいる最中は前方の詰まりを避ける。**狙っている間は向きを変えない**
    // （向きを変えると狙いごと振り回すことになる。下の引っかかり外しと同じ理由）
    if (advance && !seen) wantYaw += this._avoid(eye, wantYaw, octree);

    /* 相手に近づけているか。近づけないまま時間が経ったら回り込みに切り替える。
       建物を挟んで向かい合うと、まっすぐ向かうだけでは永久に届かない
       （壁の両側で3m離れたまま30秒動けなかった） */
    if (target && !seen) {
      if (dist < this._best - NOPROG_EPS) { this._best = dist; this._noProg = 0; }
      else this._noProg += dt;
    } else {
      this._best = dist;
      this._noProg = 0;
    }

    if (this._stuck > STUCK_S || this._noProg > NOPROG_S) {
      this._stuck = 0;
      this._noProg = 0;
      // 回り込む先は、その時点で空いている側を選ぶ（両側詰まりなら適当に振る）
      const l = this._probe(eye, wantYaw + Math.PI * 0.5, octree);
      const r = this._probe(eye, wantYaw - Math.PI * 0.5, octree);
      const side = l === r ? (this.rng() < 0.5 ? -1 : 1) : (l > r ? 1 : -1);
      this._detour = side * (Math.PI * 0.5);
      this._detourIn = DETOUR_S;
      // 回り込む間は「今より近づけていない」を作り直す（前の記録を引きずらない）
      this._best = dist;
      out.bits |= K.JUMP;
    }
    if (this._detourIn > 0) {
      this._detourIn -= dt;
      /* **狙っている最中は向きを変えない。** この入力の形は「向いている方へ歩く」
         なので、引っかかりを向きで外そうとすると狙いごと振り回すことになり、
         壁際のCPUが延々と回るだけで1発も撃たなくなる（実際そうなった）。
         見えている間は横移動キーだけ入れ替えて、狙ったまま横へ滑る */
      if (seen) {
        strafe = true;
        this._strafe = this._detour > 0 ? 1 : -1;
      } else {
        wantYaw += this._detour;
      }
    }

    // 向きは少しずつ寄せる
    out.yaw = turnToward(p.yaw, wantYaw, TURN_RATE * dt);
    out.pitch = turnToward(p.pitch, wantPitch, TURN_RATE * dt);

    if (advance) out.bits |= K.FWD;
    if (strafe) out.bits |= this._strafe > 0 ? K.RIGHT : K.LEFT;
    // 走るのは遠い時だけ。相手が居ない時のdistはInfinityなので、うろつきは常に走る
    if (advance && dist > SPRINT_R) out.bits |= K.SPRINT;

    /* 装填。押した1刻みだけビットを立てる（sim側が押した瞬間を見ている）。
       残りは自分で数える */
    if (this._pressReload) {
      out.bits |= K.RELOAD;
      this._pressReload = false;
    }
    if (this._mag <= 0 && this._reload <= 0) {
      this._reload = def.reloadTime || 2;
      this._mag = def.mag | 0;
      this._pressReload = true;
    }

    /* 撃つ。全部そろった時だけ。
       ここを緩めると「壁越しに撃ってくる」「振り向きざまに当ててくる」になる */
    if (target && seen && this._react <= 0 && this._reload <= 0 && this._mag > 0
      && this._pause <= 0 && dist <= Math.min(SIGHT_R, def.range || SIGHT_R)) {
      // 狙いがどれだけ寄ったか。撃つ向きは out.yaw/out.pitch なので、
      // 判定もその値で見る（見ている向きと撃つ向きを別々に持たない）
      const a = aimAt(eye, _look);
      let dy = a.yaw - out.yaw;
      while (dy > Math.PI) dy -= Math.PI * 2;
      while (dy < -Math.PI) dy += Math.PI * 2;
      const dp = a.pitch - out.pitch;
      if (Math.abs(dy) < AIM_TOL && Math.abs(dp) < AIM_TOL) {
        out.fire = true;
        this._mag -= 1;
        /* 弾は狙った点そのものではなく、散りの円のどこかへ飛ぶ。
           撃つほど円が広がるので、押しっぱなしの後半は当たらなくなる */
        const sp = this._spread;
        out.fireYaw = out.yaw + (this.rng() * 2 - 1) * sp;
        out.firePitch = out.pitch + (this.rng() * 2 - 1) * sp * 0.7;
        this._spread = Math.min(SPREAD_MAX, this._spread + SPREAD_PER_SHOT);
        // 連射を区切る。撃ち切ったら少し間を置く（人が反動で指を離す呼吸）
        if (this._burst <= 0) {
          this._burst = BURST_MIN + Math.floor(this.rng() * (BURST_MAX - BURST_MIN + 1));
        }
        this._burst -= 1;
        if (this._burst <= 0) this._pause = BURST_PAUSE_S * (0.7 + this.rng() * 0.8);
      }
    }

    return out;
  }

  /** 一番近い相手。見えているかは見ない（理由はthink参照）。0.4秒に1回だけ選び直す */
  _pick(foes, eye) {
    if (this._retarget > 0 && this.targetId !== null) {
      const cur = foes.find((f) => f.id === this.targetId);
      if (cur && cur.alive) return cur;
    }
    this._retarget = 0.4;
    let best = null;
    let bestD = Infinity;
    for (const f of foes) {
      if (!f.alive) continue;
      const c = f.player.collider.start;
      const d = Math.hypot(c.x - eye.x, c.z - eye.z);
      if (d >= bestD) continue;
      best = f;
      bestD = d;
    }
    this.targetId = best ? best.id : null;
    return best;
  }

  /**
   * 相手の**どこが見えているか。** 見えている点を返す。見えていなければ null。
   *
   * **目だけを見ていた。** 2026-08-13に「この位置の時に敵があんまり撃ってこない。
   * なんで簡単に勝てちゃいます」と言われた所で、
   * 遊ぶ側が**低い梁の下**に立っていた。
   * 目と目を結ぶ線は梁に当たるが、胴から下は丸見えという形になる。
   * 1本しか撃たない判定だと、そこが「見えていない」になって
   * **CPUが一度も撃たないまま立っている。**
   *
   * 目が通らなかった時だけ、胴と腰の高さをもう2本試す。
   * **見えている時は今まで通り1本で終わる**ので、
   * 撃ち合いが起きている間の負荷は変わらない。
   *
   * octreeを渡さなければ全部見えている扱い
   * （検査から地形抜きで動かせるようにするため）
   *
   * @returns 見えている点（使い回しのベクトル）か null
   */
  _visibleAt(foe, eye, octree) {
    const teye = foe.eye(_eyeB);
    if (!octree) return teye;
    if (originVisible(octree, eye, teye)) return teye;
    /* 胴(-0.35)と腰(-0.68)。**足首まで下げない。**
       足だけ見えている時に撃たせると、遮蔽の裏へ弾を撃ち続けることになる */
    for (const dy of [-0.35, -0.68]) {
      _peek.set(teye.x, teye.y + dy, teye.z);
      if (originVisible(octree, eye, _peek)) return _peek;
    }
    return null;
  }

  /**
   * 前方の詰まりを避ける向きのずれを返す。
   * 目の高さから水平に3本（正面・左斜め・右斜め）出して、
   * 正面が詰まっていたら空いている側へ寄せる。両側とも詰まっていたら大きく回る。
   *
   * まっすぐ相手へ歩くだけの形にしていたら、間に建物がある時に
   * **壁へ張り付いたまま30秒動けなかった**（2026-08-09に実測）
   */
  _avoid(eye, yaw, octree) {
    if (!octree) return 0;
    if (this._probe(eye, yaw, octree) >= WHISKER_R) return 0;
    const l = this._probe(eye, yaw + WHISKER_A, octree);
    const r = this._probe(eye, yaw - WHISKER_A, octree);
    if (l < WHISKER_R * 0.6 && r < WHISKER_R * 0.6) return Math.PI * 0.6;
    return l > r ? WHISKER_A : -WHISKER_A;
  }

  /** その向きの、目の高さで最初にぶつかる所までの距離。何も無ければInfinity
      （地形を渡さない検査からも呼ばれるので、無ければ全方向が空いている扱い） */
  _probe(eye, yaw, octree) {
    if (!octree) return Infinity;
    forwardOf(yaw, 0, _probeDir);
    _probeRay.origin.copy(eye);
    _probeRay.direction.set(_probeDir.x, 0, _probeDir.z).normalize();
    const hit = octree.rayIntersect(_probeRay);
    return hit ? hit.distance : Infinity;
  }
}

/* 使い回しの入れ物。CPUは毎刻み考えるので、ここで作ると60Hz×体数ぶんのゴミが出る。
   **_eyeAと_eyeBを同じ物にしない。** 自分の目と相手の目を同時に握るので、
   1つで回すと後から書いた方で上書きされて、自分の位置から自分を見ることになる */
const _eyeA = new THREE.Vector3();
const _eyeB = new THREE.Vector3();
const _look = new THREE.Vector3();
// 見えているかを試す点。頭が隠れていても胴が出ていることがあるので使い回す
const _peek = new THREE.Vector3();
const _probeDir = new THREE.Vector3();
const _probeRay = new THREE.Ray();
