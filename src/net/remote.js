/* 他プレイヤーの見た目。net.stateAt()が返した補間済みの状態を、そのまま姿にする。

   兵士のモデルはai/enemy.jsのbuildSoldier()が作るが、あれはexportされていない。
   enemy.jsは他の担当の持ち物なので触らず、Enemyを1体作って中身の骨と
   メッシュだけ借りる（AIのupdate()は一度も呼ばない）。
   同じ兵士が敵としても他プレイヤーとしても出てくるので、見た目の作り込みも
   個体差もそのまま効くし、材質やテクスチャの焼き直しも起きない。

   姿勢はenemy.jsの歩行と同じ考え方で組み直す。AIの状態機械（索敵・遮蔽・射撃）
   に紐付いた_animate()はそのまま使えないので、
   スナップショットの状態ビットから同じ形を作る。 */

import * as THREE from 'three';
import { S, characterAt, CHARACTERS, HITBOX } from './protocol.js';
import { Enemy } from '../ai/enemy.js';
import { WEAPONS } from '../player/weapons.js';
import { preloadCharModel, charModelReady, spawnCharModel } from '../ai/glbchar.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// Enemyはlevel.octreeしか見ないので、AIを回さないぶんには空で足りる
const NO_LEVEL = { octree: null, bounds: null };

// 歩きと走りの境。プレイヤーの歩行4.7・疾走7.4に合わせる（player.js参照）
const SPEED_WALK = 4.7;
// 上半身をどこまで捻れるか。これを超えたら下半身が向きを変える
const TWIST_LIMIT = 1.05;

// 倒れ切るまで／死体が残る時間／沈み始めてから消えるまで
const FALL_S = 0.75;
const CORPSE_HOLD_S = 3.0;
const CORPSE_SINK_S = 0.6;

/* 影カメラは場内±46mしか覆っていない（main.js参照）。その外に立っている相手に
   castShadowを立てても影は落ちず、シャドウマップへの描画だけが増える */
const SHADOW_BOUND = 44;
// これより遠い相手は近距離用の細部を消す。3cmの段差は遠景で1px未満に潰れる
const DETAIL_DIST = 22;

const _pose = { thigh: 0, knee: 0, ankle: 0, abduct: 0 };

/* enemy.jsのlegPose()と同じ組み立て。位相tの1周期が2歩ぶんで、
   fwdが進行方向の前後成分、strafeが横成分、sideが脚の左右(+1が右脚)。
   横へ動いているのに前後のストライドを打つと足が地面を擦る（ムーンウォーク）ので、
   前後幅をfwdで潰したぶんを外転へ振り替える */
function legPose(t, amp, run, out, fwd, strafe, side) {
  const sn = Math.sin(t), cs = Math.cos(t);
  const stride = (0.50 + run * 0.42) * amp;
  // 静止時も膝は伸ばし切らない。伸ばすと台に刺したフィギュアになる
  out.thigh = 0.05 + sn * stride * Math.abs(fwd);
  // 横へ振るのは足が浮いている遊脚期(cos>0)だけ。両脚同時に開くとガニ股で滑る
  out.abduct = side * 0.045 + strafe * (0.10 + 0.26 * Math.max(0, cs));

  const swingFlex = Math.max(0, cs);
  const impact = Math.max(0, Math.sin(t - 0.6));
  // 膝は後ろにしか曲がらない。前に折れると一発で人形に見える
  out.knee = -0.11 - amp * (0.10 + swingFlex * (0.70 + run * 0.80) + impact * (0.20 + run * 0.20));

  let ankle = 0.06 + amp * 0.28 * Math.sin(t + 0.5);
  const stanceW = Math.max(0, -cs);
  ankle = ankle * (1 - stanceW) + (-(out.thigh + out.knee)) * stanceW * 0.9;
  const toe = Math.max(0, -Math.sin(t + 0.35));
  out.ankle = ankle - amp * (0.19 + run * 0.24) * toe * toe;
}

export class RemotePlayers {
  constructor(scene, level = null) {
    this.scene = scene;
    this.level = level || NO_LEVEL;
    this.slots = new Map();     // id -> slot
    this._pool = [];            // 使い終わった兵士。湧き直しで作り直さない
    this._all = [];             // dispose()で始末する全部
    this._glbPool = [];         // 外部モデル版の使い回し
    this._glbAll = [];
    this._last = 0;
    this._seen = new Set();     // sync()の中だけで使う。毎フレーム作り直さず使い回す
    // 外部モデルの枠があれば、対戦に入った時点で読み込みを始めておく。
    // 相手が現れた瞬間に読み始めると、届くまでコード製の代役で立つことになる
    for (const c of CHARACTERS) if (c.model) preloadCharModel(c.model);
  }

  /* net.stateAt()の結果をそのまま渡す。dtは持たないので自前で測る
     （呼ぶ側のフレーム時間と一致していなくても、歩調が少しずれるだけで破綻しない）。
     viewPosを渡すと、遠くの相手の細部を落とす */
  /**
   * 誰がどの見た目を選んだかを渡す。id -> 番号 のMap。
   * 統合側が毎フレーム渡すのではなく、変わった時だけ入れ替える
   */
  setChars(map) { this._chars = map; }

  sync(states, myId, viewPos = null) {
    const t = now();
    const dt = this._last ? clamp((t - this._last) / 1000, 0, 0.1) : 1 / 60;
    this._last = t;

    const seen = this._seen;
    seen.clear();
    for (const st of states) {
      if (st.id === myId) continue;      // 自分は描かない。一人称の腕が既にある
      seen.add(st.id);
      let slot = this.slots.get(st.id);
      if (!slot) { slot = this._spawn(st, this._chars?.get(st.id) | 0); this.slots.set(st.id, slot); }
      this._applyWeapon(slot, st.weapon | 0);
      this._apply(slot, st, dt, viewPos);
    }
    // 消えた相手は残さない。抜け殻が立ち続けるより消える方が嘘が小さい
    for (const id of this.slots.keys()) if (!seen.has(id)) this.remove(id);
  }

  /**
   * 相手が持ち替えた武器を見た目へ反映する。
   *
   * 武器の番号はスナップショットにずっと乗っていた（protocol.jsのpackPlayerの9番目）が、
   * **受け取った側が一度も使っていなかった。** 相手がナイフに持ち替えても
   * こちらの画面では銃を構えたままで、何で殺されるのか読めなかった。
   *
   * 兵士の銃は組み上げ時に決まっていて差し替えられないので、
   * 出す・引っ込める・寸法を変える、の3つで持ち替えを表す。
   * 見た目を作り込むのは後からできるが、**持っていない物を持って見えるのは嘘**なので
   * そこだけ先に消す
   */
  _applyWeapon(slot, index) {
    if (slot.weapon === index) return;
    slot.weapon = index;
    // 外部モデルの試験枠は丸腰のまま。手の骨へ武器をぶら下げるのは
    // 本採用の時にやる（丸腰で撃つのは嘘だが、試験の割り切りとして明記しておく）
    if (slot.glb) return;
    const p = slot.enemy.parts;
    if (!p.gun) return;
    // 出るのは常に1つだけ。全部消してから1つ出す形にすると、
    // 武器を足した時に消し忘れが起きない
    const id = WEAPONS[index]?.id;
    if (p.gunShotgun) p.gunShotgun.visible = id === 'shotgun';
    if (p.heldKnife) p.heldKnife.visible = id === 'knife';
    if (p.heldNade) p.heldNade.visible = id === 'nade';
    // 専用の見た目を持たない武器は、まとめてライフルの形で出す。
    //
    // **「知らない番号だけ」を拾う書き方にしていると、武器を足した時に
    // 誰も持っていない絵になる。** 実際ピストルを足した時、idは引けるので
    // 下の !id に入らず、上のどれにも一致せず、**素手で構えて撃つ**状態だった。
    // 「持っていない物を持って見える」のは嘘だが、
    // 「持っている物が何も見えない」のはもっと読めない
    const hasOwnModel = (p.gunShotgun && p.gunShotgun.visible)
      || (p.heldKnife && p.heldKnife.visible)
      || (p.heldNade && p.heldNade.visible);
    p.gun.visible = !hasOwnModel;
  }

  get(id) {
    const slot = this.slots.get(id);
    return slot ? slot.handle : null;
  }

  remove(id) {
    const slot = this.slots.get(id);
    if (!slot) return;
    this.slots.delete(id);
    if (slot.glb) {
      slot.obj.root.visible = false;
      this._glbPool.push(slot.obj);
      return;
    }
    slot.enemy.root.visible = false;
    slot.enemy.blob.visible = false;
    this._pool.push(slot.enemy);
  }

  /* 場面を丸ごと畳む時だけ呼ぶ。
     テクスチャは触らない。enemy.jsのmakeFaceMaterial()が顔だけモジュール共有の
     DataTextureをそのまま貼っているので、ここで捨てると他の兵士の顔まで消える。
     終了時にGPUのテクスチャが数枚残るのと、生きている兵士の顔が壊れるのとでは
     後者の方がはるかに悪い */
  dispose() {
    for (const e of this._all) {
      this.scene.remove(e.root);
      this.scene.remove(e.blob);
      e.root.traverse((o) => {
        if (!o.isMesh) return;
        o.geometry?.dispose?.();
        const m = o.material;
        if (Array.isArray(m)) for (const x of m) x?.dispose?.();
        else m?.dispose?.();
      });
    }
    this._all.length = 0;
    this._pool.length = 0;
    /* 外部モデルは場面から外すだけで、ジオメトリと材質は捨てない。
       複製(SkeletonUtils.clone)が雛形と共有しているので、ここで捨てると
       次の試合で組む複製が壊れる（顔テクスチャを捨てない上の理屈と同じ） */
    for (const o of this._glbAll) this.scene.remove(o.root);
    this._glbAll.length = 0;
    this._glbPool.length = 0;
    this.slots.clear();
  }

  /* ------------------------------------------------------------ 中身 */

  /* chrは選ばれた見た目の番号。
     使い回しの入れ物は、姿を組み上げた時の種を持ったままなので、
     **番号が違う物を使い回すと別人の姿で出てくる。**
     同じ番号の物だけを探し、無ければ新しく組む。
     人数は最大8人で選べる姿も数種類なので、作られる数はたかが知れている */
  _spawn(st, chr = 0) {
    const def = characterAt(chr);
    /* 外部モデルの試験枠。読み込みが届いていればそちらで出す。
       まだ(または失敗)ならコード製の代役で出し、その相手が居る間はそのまま
       （途中で差し替えると、目の前で人が入れ替わって見える） */
    if (def.model && charModelReady(def.model)) return this._spawnGlb(st, def);
    const seed = def.seed;
    const at = this._pool.findIndex((x) => x.variant?.seed === seed);
    let e = at >= 0 ? this._pool.splice(at, 1)[0] : null;
    if (!e) {
      e = new Enemy(this.level, { seed });
      this.scene.add(e.root);
      // 足元の暗がりはrootの子にすると倒れた時に一緒に回るのでシーン直下に置く
      this.scene.add(e.blob);
      this._all.push(e);
    }
    /* 見た目の身長を、サーバーの当たり判定の身長へ合わせる。
       **ここがずれていたのが「ヘッドショットの判定がデカすぎる」の正体だった。**

       兵士は個体差で0.94〜1.12倍に伸び縮みするのに、サーバーの当たり判定は
       1.74m固定。実測すると、大柄なキャラでは頭の当たり判定(1.42〜1.72m)と
       見えている頭(1.72〜2.03m)が**1cmも重ならない**。
       見えている頭を撃っても頭にならず、胸のあたりを撃つと頭になっていた。

       身長差を残したまま判定側を各自の身長に合わせる手もあるが、それをやると
       背の低いキャラを選ぶだけで当たりにくくなり、選ぶ物で有利不利が出る。
       見た目を判定へ寄せるのが正しい。個体差は迷彩・装備・肩幅・姿勢に残る */
    const natural = e.height / e.bodyScale;   // 個体差を掛ける前の素の身長
    const fit = HITBOX.STAND_H / natural;
    e.root.scale.setScalar(fit);
    e.bodyScale = fit;
    e.height = HITBOX.STAND_H;

    e.root.visible = true;
    e.root.rotation.set(0, 0, 0);
    e.blob.visible = true;
    e.alive = true;
    // 骨を組み上がりの姿勢へ戻す。使い回した個体が前の死に方を引きずらない
    e._resetPose?.();
    e._pickUpGun?.();
    for (const m of e.meshes) m.castShadow = true;
    for (const g of e.parts.detail) g.visible = true;

    const p = e.parts;
    return {
      enemy: e,
      handle: { root: e.root, headPos: new THREE.Vector3() },
      // 銃に焼き込まれた構えの角度。ここを打ち消さないと銃口が狙いからずれる。
      // 数値をenemy.jsから写すと片方だけ直った時に静かに壊れるので、組み上がりから読む
      gunBlade: p.gun.rotation.y,
      gunPitch: p.gun.rotation.x,
      x: st.x, y: st.y, z: st.z,
      speed: 0,
      moveYaw: st.yaw,
      lowerYaw: st.yaw,
      phase: Math.random() * TAU,
      dirSign: 1,
      crouch: 0,
      ready: 0,
      reload: 0,
      dead: false,
      deadT: 0,
      fallDir: 1,
      shadowOn: true,
      detailOn: true,
    };
  }

  /* 外部モデル版の1体を組む。姿はGLBの複製、身長は判定(HITBOX.STAND_H)へ揃える */
  _spawnGlb(st, def) {
    const at = this._glbPool.findIndex((o) => o.modelName === def.model);
    let obj = at >= 0 ? this._glbPool.splice(at, 1)[0] : null;
    if (!obj) {
      obj = spawnCharModel(def.model, HITBOX.STAND_H);
      obj.modelName = def.model;
      this.scene.add(obj.root);
      this._glbAll.push(obj);
    }
    obj.root.visible = true;
    obj.root.rotation.set(0, 0, 0);
    obj.mixer.timeScale = 1;
    obj.mix(0, 0);
    for (const m of obj.meshes) m.castShadow = true;
    return {
      glb: true,
      obj,
      handle: { root: obj.root, headPos: new THREE.Vector3() },
      x: st.x, y: st.y, z: st.z,
      speed: 0,
      weapon: -1,
      dead: false,
      deadT: 0,
      fallDir: 1,
      shadowOn: true,
    };
  }

  /* 外部モデル版の毎フレーム。コード製(_apply)は骨を1本ずつ手で回すが、
     こちらはクリップの再生に任せて、混ぜる重みだけを速度から決める。
     捻り(下半身は進行方向・上半身は狙い)はクリップと手回しの混在になるので
     試験ではやらない。体ごと狙いの方を向く */
  _applyGlb(slot, st, dt) {
    const o = slot.obj;
    const root = o.root;

    const dx = st.x - slot.x, dz = st.z - slot.z;
    slot.x = st.x; slot.y = st.y; slot.z = st.z;
    const raw = dt > 1e-4 ? Math.hypot(dx, dz) / dt : 0;
    slot.speed += (raw - slot.speed) * Math.min(1, dt * 12);

    const dead = (st.state & S.DEAD) !== 0;
    // 沈み切って見えなくなった死体は何もしない（コード製と同じ理屈）
    if (dead && slot.dead && !root.visible) { slot.deadT += dt; return; }

    root.position.set(st.x, st.y, st.z);
    root.rotation.y = st.yaw;

    // 歩様。止まっていれば待機、歩けば歩き、それ以上は走りへ寄せる
    const move = clamp(slot.speed / SPEED_WALK, 0, 1);
    const runK = clamp((slot.speed - 1.8) / 2.4, 0, 1);
    o.mix(move, runK);
    o.mixer.update(dt);

    /* 死亡。このモデルに倒れるクリップは無いので、コード製と同じく体ごと倒す。
       倒れた後はアニメを止める（待機のまま倒すと、死体が呼吸して見える） */
    if (dead && !slot.dead) {
      slot.dead = true;
      slot.deadT = 0;
      slot.fallDir = Math.random() < 0.5 ? 1 : -1;
      o.mixer.timeScale = 0;
    } else if (!dead && slot.dead) {
      slot.dead = false;
      slot.deadT = 0;
      root.visible = true;
      o.mixer.timeScale = 1;
    }

    if (slot.dead) {
      slot.deadT += dt;
      const k = clamp(slot.deadT / FALL_S, 0, 1);
      const fall = (1 - Math.pow(1 - k, 3)) * slot.fallDir * Math.PI * 0.5;
      root.rotation.x = fall;
      // 足元を軸に倒すので、胴の太さのぶん持ち上げないと床にめり込む
      root.position.y = st.y + Math.abs(Math.sin(fall)) * 0.24;
      const gone = slot.deadT - CORPSE_HOLD_S;
      if (gone > 0) {
        const sinkK = clamp(gone / CORPSE_SINK_S, 0, 1);
        root.position.y -= sinkK * 1.2;
        if (sinkK >= 1) root.visible = false;
      }
    } else if (root.rotation.x !== 0) {
      root.rotation.x = 0;
    }

    // 影カメラの外では影の描画だけが無駄になる（コード製と同じ理屈）
    const wantShadow = Math.abs(st.x) <= SHADOW_BOUND && Math.abs(st.z) <= SHADOW_BOUND
      && !(slot.dead && slot.deadT > CORPSE_HOLD_S);
    if (wantShadow !== slot.shadowOn) {
      slot.shadowOn = wantShadow;
      for (const m of o.meshes) m.castShadow = wantShadow;
    }

    // 名札・銃声・ミニマップが同じフレームの頭の位置を読めるようにする
    root.updateMatrixWorld(true);
    if (o.head) o.head.getWorldPosition(slot.handle.headPos);
    else slot.handle.headPos.set(st.x, st.y + HITBOX.STAND_H - 0.12, st.z);
  }

  _apply(slot, st, dt, viewPos) {
    if (slot.glb) return this._applyGlb(slot, st, dt);
    const e = slot.enemy;
    const p = e.parts;

    /* --------------------------------------------------- 速さと向き */
    const dx = st.x - slot.x, dz = st.z - slot.z;
    slot.x = st.x; slot.y = st.y; slot.z = st.z;
    // 20Hzのスナップショットを補間した位置なので、そのまま割ると段でぶれる
    const raw = dt > 1e-4 ? Math.hypot(dx, dz) / dt : 0;
    slot.speed += (raw - slot.speed) * Math.min(1, dt * 12);
    if (Math.hypot(dx, dz) > 1e-4) slot.moveYaw = Math.atan2(-dx, -dz);

    const dead = (st.state & S.DEAD) !== 0;
    // 沈み切って見えなくなった死体は、姿勢もIKも作り直す意味が無い。
    // 復帰は下の死亡の節で拾うので、そこまでは何もしない
    if (dead && slot.dead && !e.root.visible) { slot.deadT += dt; return; }
    const air = (st.state & S.AIR) !== 0;
    const run = clamp((slot.speed - 1.8) / 2.4, 0, 1);
    /* 止まっているのに足が動くのが一番安く見える。位相を進めるのは
       はっきり動いている時だけにして、止まったら振れ幅を0へ落とす */
    const moving = slot.speed > 0.25;
    const amp = dead ? 0 : clamp(slot.speed / SPEED_WALK, 0, 1.15);

    // 下半身は進行方向、上半身は狙い。捻りの限界を超えたら足が追いかける
    const wantLower = moving
      ? st.yaw + clamp(wrapPi(slot.moveYaw - st.yaw), -TWIST_LIMIT, TWIST_LIMIT)
      : slot.lowerYaw;
    slot.lowerYaw += wrapPi(wantLower - slot.lowerYaw) * Math.min(1, dt * (moving ? 10 : 5.5));
    const twist = wrapPi(st.yaw - slot.lowerYaw);

    const moveRel = wrapPi(slot.moveYaw - slot.lowerYaw);
    const fwd = Math.cos(moveRel);
    // 真横に近いとcosの符号が暴れる。前後がはっきりしている時だけ向きを決める
    if (Math.abs(fwd) > 0.25) slot.dirSign = fwd >= 0 ? 1 : -1;
    const strafe = -Math.sin(moveRel) * amp;
    if (moving) {
      slot.phase += dt * (0.62 + slot.speed * 0.30) * e.gaitRate * TAU * slot.dirSign;
      slot.phase = ((slot.phase % TAU) + TAU) % TAU;
    }

    const wantCrouch = (st.state & S.CROUCH) ? 1 : 0;
    slot.crouch += (wantCrouch - slot.crouch) * Math.min(1, dt * 9);
    // 覗いている時だけ肩に付ける。走っている間は胸の前へ寝かせる
    const wantReady = dead ? 0 : (st.state & S.RELOAD) ? 0 : (st.state & S.ADS) ? 1 : (run > 0.5 ? 0.35 : 0.8);
    slot.ready += (wantReady - slot.ready) * Math.min(1, dt * (wantReady > slot.ready ? 6 : 3));
    const wantReload = (st.state & S.RELOAD) ? 1 : 0;
    slot.reload += (wantReload - slot.reload) * Math.min(1, dt * 6);

    /* ------------------------------------------------------ 置き場所 */
    const root = e.root;
    root.position.set(st.x, st.y, st.z);
    root.rotation.set(0, slot.lowerYaw, 0);

    const t = slot.phase;
    const cr = slot.crouch;

    /* ---------------------------------------------------------- 脚 */
    legPose(t, amp, run, _pose, fwd, strafe, -1);
    p.legL.rotation.x = _pose.thigh; p.legL.rotation.z = _pose.abduct;
    p.shinL.rotation.x = _pose.knee; p.footL.rotation.x = _pose.ankle;
    legPose(t + Math.PI, amp, run, _pose, fwd, strafe, 1);
    p.legR.rotation.x = _pose.thigh; p.legR.rotation.z = _pose.abduct;
    p.shinR.rotation.x = _pose.knee; p.footR.rotation.x = _pose.ankle;

    if (cr > 0.001) {
      p.legL.rotation.x += cr * 1.05; p.legR.rotation.x += cr * 1.05;
      p.shinL.rotation.x -= cr * 1.75; p.shinR.rotation.x -= cr * 1.75;
      p.footL.rotation.x += cr * 0.62; p.footR.rotation.x += cr * 0.62;
    }
    // 跳んでいる間は歩行の周期を止めて膝を抱える。空中で歩くと嘘が一番目立つ
    if (air && !dead) {
      p.legL.rotation.x = 0.34; p.legR.rotation.x = 0.10;
      p.shinL.rotation.x = -0.72; p.shinR.rotation.x = -0.34;
      p.footL.rotation.x = 0.22; p.footR.rotation.x = 0.16;
    }

    /* -------------------------------------------------------- 骨盤 */
    const bobA = (0.035 + run * 0.045) * amp;
    const sink = Math.max(0, Math.sin(t * 2 - 0.9)) * 0.012 * amp;
    p.hips.position.y = 0.92 - bobA * 0.5 + Math.cos(t * 2) * bobA * 0.5 - sink - cr * 0.30;
    const hipYaw = -Math.sin(t) * (0.09 + run * 0.10) * amp;
    // 銃を斜めに構えるぶん腰も半分開く。上体だけで作ると腰から上だけ捻れて立つ
    const still = 1 - clamp(amp * 2, 0, 1);
    const bladeHip = -slot.gunBlade * 0.45 * slot.ready * still;
    p.hips.rotation.y = hipYaw + bladeHip;
    p.hips.rotation.z = Math.sin(t) * (0.045 + run * 0.03) * amp + Math.sin(moveRel) * amp * 0.06;
    p.hips.rotation.x = -run * 0.05 * amp;

    /* -------------------------------------------------------- 上体 */
    // 骨盤と逆に回す。同じ向きに回ると全身が板に見える
    const chestYaw = Math.sin(t) * (0.08 + run * 0.07) * amp;
    p.chest.rotation.y = twist - slot.gunBlade + chestYaw - hipYaw - bladeHip;
    p.chest.rotation.x = -run * 0.16 * amp + st.pitch * 0.25 - cr * 0.22 + e.variant.slouch;
    p.chest.rotation.z = -Math.sin(t) * 0.03 * amp;

    /* ---------------------------------------------------------- 頭 */
    const weld = slot.ready;
    p.headPivot.rotation.x = st.pitch * 0.45 - Math.cos(t * 2) * 0.02 * amp + weld * 0.09;
    // 上体を戻したぶん頭だけ狙いへ向け直す。見ていない顔は気づかれていない印象になる
    p.headPivot.rotation.y = slot.gunBlade - chestYaw * 0.6;
    p.headPivot.rotation.z = -weld * 0.13 + e.variant.neckTilt;
    p.headPivot.position.set(
      p.headHome.x + weld * 0.035,
      p.headHome.y,
      p.headHome.z - weld * 0.020,
    );

    /* ---------------------------------------------------------- 銃 */
    const low = (1 - slot.ready) * (1 + run * 0.55);
    const rl = slot.reload;
    const h = p.mountHome;
    p.gunMount.position.set(
      h.x + Math.sin(t) * 0.008 * amp,
      h.y + Math.cos(t * 2) * 0.012 * amp - cr * 0.03 - low * 0.13 - rl * 0.06,
      h.z + low * 0.07,
    );
    p.gunMount.rotation.set(
      // 銃自体に焼いた伏せ角は、肩に付け切った時だけ打ち消す
      st.pitch * 0.8 * slot.ready + low * 0.55 + rl * 0.35 - slot.gunPitch * slot.ready,
      -Math.sin(t) * 0.03 * amp,
      Math.sin(t) * 0.05 * amp + run * 0.06 + low * 0.10 + rl * 0.55,
    );

    /* -------------------------------------------------------- 死亡 */
    if (dead && !slot.dead) {
      slot.dead = true;
      slot.deadT = 0;
      // 倒れる向きは分からない（スナップショットに被弾方向が無い）ので振り分ける
      slot.fallDir = Math.random() < 0.5 ? 1 : -1;
    } else if (!dead && slot.dead) {
      // 復帰。沈めたぶんと倒した角度を戻す
      slot.dead = false;
      slot.deadT = 0;
      root.visible = true;
      e.blob.visible = true;
    }

    if (slot.dead) {
      slot.deadT += dt;
      const k = clamp(slot.deadT / FALL_S, 0, 1);
      const fall = (1 - Math.pow(1 - k, 3)) * slot.fallDir * Math.PI * 0.5;
      root.rotation.x = fall;
      /* 足元を軸に倒すので、そのままだと胴の太さのぶん床にめり込む。
         倒れた角度に応じて持ち上げる */
      root.position.y = st.y + Math.abs(Math.sin(fall)) * 0.24 * e.bodyScale;
      // 倒れた体は膝と肘を伸ばす。構えたまま横たわると人形に見える
      const relax = k;
      p.legL.rotation.x *= 1 - relax * 0.8; p.legR.rotation.x *= 1 - relax * 0.8;
      p.shinL.rotation.x *= 1 - relax * 0.7; p.shinR.rotation.x *= 1 - relax * 0.7;
      p.chest.rotation.x -= relax * 0.18;

      const gone = slot.deadT - CORPSE_HOLD_S;
      if (gone > 0) {
        // 消える時は床へ沈める。その場で消えると見ている側に何が起きたか分からない
        const sinkK = clamp(gone / CORPSE_SINK_S, 0, 1);
        root.position.y -= sinkK * 1.2;
        if (sinkK >= 1) { root.visible = false; e.blob.visible = false; }
      }
    } else if (root.rotation.x !== 0) {
      root.rotation.x = 0;
    }

    /* ---------------------------------------------------------- 腕 */
    // 手は銃側に付いているので、腕はその手首を掴みに行くだけでいい。
    // enemy.jsのIKはpartsだけで閉じていてAIの状態を見ないのでそのまま借りる
    e._solveArms?.();

    /* ------------------------------------------------- 影と細部の間引き */
    // 影カメラの外に居る相手はcastShadowを立てても影が出ない。描くだけ無駄
    const wantShadow = Math.abs(st.x) <= SHADOW_BOUND && Math.abs(st.z) <= SHADOW_BOUND
      && !(slot.dead && slot.deadT > CORPSE_HOLD_S);
    if (wantShadow !== slot.shadowOn) {
      slot.shadowOn = wantShadow;
      for (const m of e.meshes) m.castShadow = wantShadow;
    }
    if (viewPos) {
      const d = Math.hypot(viewPos.x - st.x, viewPos.y - st.y, viewPos.z - st.z);
      const wantDetail = d < DETAIL_DIST;
      if (wantDetail !== slot.detailOn) {
        slot.detailOn = wantDetail;
        for (const g of p.detail) g.visible = wantDetail;
      }
    }

    /* 足元の暗がり。太陽の影とは別に効くので逆光でも足が地面に接して見える。
       床の高さは分からないので相手の足元をそのまま使う（平らな床と箱の上は合う） */
    const b = e.blob;
    b.position.set(st.x, st.y + 0.025, st.z);
    const bs = (slot.dead ? 1.55 : 1.02 - cr * 0.15) * e.bodyScale;
    b.scale.set(bs, 1, bs);

    // 名前表示が同じフレームの頭の位置を読めるように、ここで world 変換を確定させる
    root.updateMatrixWorld(true);
    p.headBone.getWorldPosition(slot.handle.headPos);
  }
}
