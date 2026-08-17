/* 協力プレイのモンスターの見た目。**AIは一切回さない。**
   サーバーが20Hzで送ってくる位置と状態（スナップショットのms）から姿を作るだけ。
   姿勢を作るのは src/ai/monster.js の Monster.animate() で、そこはサーバーが
   一度も呼ばない部分（サーバーの個体は visual:false で骨を持たない）。

   補間はプレイヤー（stateAt()の2枚の間を取る）と違って、
   「今描いている位置から、最新の位置へ指数的に寄せる」だけにしてある。
   モンスターはAIの歩きなので急な方向転換が少なく、この安い形で足りる。

   火の玉もここが描く。**位置は届かない。**吐いた瞬間の出発点と向きと速さだけ
   受け取って、こちらで同じようにまっすぐ飛ばす（曳光弾と同じ考え方）。
   当たり判定はサーバーが自分の中だけで持っているので、絵が数十cmずれても
   「当たった／当たらない」は必ずサーバーの答えが届く */

import * as THREE from 'three';
import { Monster, MSTATE, MONSTER_HIT } from '../ai/monster.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => { let x = a; while (x > Math.PI) x -= TAU; while (x < -Math.PI) x += TAU; return x; };

// Monsterはlevel.octreeしか見ないが、update()を呼ばないので空で足りる（remote.jsと同じ）
const NO_LEVEL = { octree: null, bounds: null, enemySpawns: null };

const CORPSE_HOLD_S = 2.6;
const CORPSE_SINK_S = 0.7;

/* 影を落とすのはカメラから何mまでか。**13m。**
   ここは44（場内のほぼ全域）だった。remote.jsの相手プレイヤーから写した数字だが、
   あちらは多くて7人、こちらは同時に10体以上いる。

   なぜ効くか: 太陽の影は2枚に分けて焼いている（main.jsのCASCADES）。
     ・近い1枚 … 半径16m・カメラに追従・毎フレーム焼く
     ・遠い1枚 … 半径56m・3フレームに1回、**しかも遠くで何かが動いた時だけ**
   遠い方は焼くとなると地形ごと全部（500枚超）を焼き直すので、
   ソロの敵は13mより外でcastShadowを切って**遠い方に写らないようにしてある**
   （enemy.jsの_liveShadow。同じ理屈をここへ持ってくる）。

   44のままだと、モンスター全員が遠い1枚の住人になる。**地形500枚＋モンスター408枚を
   3フレームに1回まるごと焼き直す**ので、毎秒20回の息継ぎが出る。
   これが「協力プレイだと歩くだけでカクカクする」の正体（2026-08-17）。
   13mの外の個体は足元の暗がりが無いぶん浮くが、影1枚のために
   毎秒20回つっかえるほうが遊べない */
const SHADOW_NEAR = 13;
// 火の玉の見た目。半径は種類で変わらない（大きさで威力を読ませるほど種類が無い）
const SPIT_R = 0.22;

const _boomAt = new THREE.Vector3();

export class RemoteMonsters {
  constructor(scene) {
    this.scene = scene;
    this.slots = new Map();   // mid -> slot
    this._pool = new Map();   // kind -> Monster[]（体格が違うので種類別に使い回す）
    this._all = [];
    this._spits = [];
    this._spitPool = [];
    this._spitGeo = null;
    this._spitMat = null;
    /* animate()へ毎フレーム渡す入れ物。**1つ作って使い回す。**
       その場で `{ speed, state, pitch }` と書くと、体の数だけ毎フレーム
       作って捨てることになる（実測で1体あたり418バイト／フレーム。
       10体だと毎秒250KBで、そのぶんGCが走る回数が増える＝画面の息継ぎ） */
    this._st = { speed: 0, state: 0, pitch: 0 };
  }

  /** MSPAWNで呼ぶ。kindは湧いた時にしか届かないので、ここで姿を決める */
  spawn(mid, kind, scale, p) {
    if (this.slots.has(mid)) return;
    let arr = this._pool.get(kind);
    if (!arr) this._pool.set(kind, (arr = []));
    let mon = arr.pop();
    if (!mon) {
      mon = new Monster(NO_LEVEL, kind, { visual: true });
      this.scene.add(mon.root);
      this._all.push(mon);
    }
    mon.alive = true;
    mon.root.visible = true;
    mon.root.rotation.set(0, 0, 0);
    // MSPAWNのscaleは念のため受けるが、体格の元はMONSTER_KINDSなので普段は同じ値
    if (Number.isFinite(scale) && scale > 0) mon.root.scale.setScalar(scale);
    // 影は消した状態から始める。近づいてきたら最初のupdate()が点ける
    for (const m of mon.meshes) m.castShadow = false;

    const x = p?.[0] ?? 0, y = p?.[1] ?? 0, z = p?.[2] ?? 0;
    mon.root.position.set(x, y, z);
    this.slots.set(mid, {
      mon,
      kind,
      // 今描いている位置(c*)と、サーバーから届いた最新の位置(t*)
      cx: x, cy: y, cz: z,
      tx: x, ty: y, tz: z,
      yaw: 0, pitch: 0, drawYaw: 0,
      speed: 0,
      state: MSTATE.SEEK,
      // 1つ前の状態。**変わった瞬間だけ**を拾って予告の音を鳴らすのに要る
      // （溜めに入った瞬間は電文で別に届かない。姿勢と同じで状態番号から作る）
      wasState: MSTATE.SEEK,
      dead: false, deadT: 0,
      seen: true, shadowOn: false,
      headPos: new THREE.Vector3(x, y + mon.height * 0.8, z),
    });
  }

  /** MKILLで呼ぶ。倒れる絵はここから先、こちらだけで面倒を見る */
  kill(mid) {
    const slot = this.slots.get(mid);
    if (!slot || slot.dead) return;
    slot.dead = true;
    slot.deadT = 0;
    slot.mon.alive = false;
  }

  /** スナップショットが届くたびに呼ぶ。位置と向きの「目標」を入れ替えるだけ */
  sync(states) {
    for (const slot of this.slots.values()) slot.seen = false;
    for (const st of states) {
      const slot = this.slots.get(st.mid);
      if (!slot) continue;   // MSPAWNより先にmsが届いた回。次のMSPAWNで拾う
      slot.seen = true;
      slot.tx = st.x; slot.ty = st.y; slot.tz = st.z;
      slot.yaw = st.yaw; slot.pitch = st.pitch;
      slot.state = st.state;
    }
    /* msから消えた＝サーバーが手放した。倒れた個体はMKILLからの死に絵の途中なので
       そのまま演じ切らせる。生きているのに消えた個体（試合が畳まれた等）は即座に消す */
    for (const [mid, slot] of this.slots) {
      if (!slot.seen && !slot.dead) this._release(mid);
    }
  }

  /** 火の玉が飛び出した。MSPITで呼ぶ */
  spit(p, d, speed) {
    if (!this._spitGeo) {
      this._spitGeo = new THREE.SphereGeometry(SPIT_R, 10, 8);
      // 光る球。影は落とさない（飛んでいる火の玉の影は情報として要らない）
      this._spitMat = new THREE.MeshStandardMaterial({
        color: 0xffb23a, emissive: 0xff7a1e, emissiveIntensity: 3.2,
        roughness: 0.7, toneMapped: true,
      });
    }
    let m = this._spitPool.pop();
    if (!m) {
      m = new THREE.Mesh(this._spitGeo, this._spitMat);
      m.castShadow = false;
      this.scene.add(m);
    }
    m.visible = true;
    m.position.set(p[0], p[1], p[2]);
    this._spits.push({
      mesh: m,
      vx: d[0] * speed, vy: d[1] * speed, vz: d[2] * speed,
      life: 2.8, spin: Math.random() * TAU,
    });
  }

  /** 火の玉が弾けた。MBOOMで呼ぶ。近くを飛んでいる玉を1つ消す */
  boom(p) {
    let bestAt = -1, bestD = 9;
    for (let i = 0; i < this._spits.length; i++) {
      const s = this._spits[i];
      const d = s.mesh.position.distanceTo(_boomAt.set(p[0], p[1], p[2]));
      if (d < bestD) { bestD = d; bestAt = i; }
    }
    if (bestAt >= 0) this._killSpit(bestAt);
  }

  _killSpit(i) {
    const s = this._spits[i];
    s.mesh.visible = false;
    this._spitPool.push(s.mesh);
    this._spits.splice(i, 1);
  }

  /**
   * 毎フレーム呼ぶ。姿勢はここで全部作る。
   * cameraは影を落とす距離を測るのに要る（渡さない時は影を全部切る）。
   * onTellは「溜めに入った」を1回だけ知らせる先。(slot, mid) で呼ぶ
   */
  update(dt, camera = null, onTell = null) {
    const cx = camera ? camera.position.x : 0;
    const cz = camera ? camera.position.z : 0;
    for (const [mid, slot] of this.slots) {
      const mon = slot.mon;

      if (slot.dead) {
        slot.deadT += dt;
        mon.animateDeath(slot.deadT);
        mon.root.position.set(slot.cx, slot.cy, slot.cz);
        const gone = slot.deadT - CORPSE_HOLD_S;
        if (gone > 0) {
          const k = clamp(gone / CORPSE_SINK_S, 0, 1);
          mon.root.position.y = slot.cy - k * 1.4 * mon.scale;
          if (k >= 1) { this._release(mid); continue; }
        }
        continue;
      }

      /* --------------------------------------------- 位置を目標へ寄せる */
      const k = Math.min(1, dt * 14);
      const dx = (slot.tx - slot.cx) * k;
      const dz = (slot.tz - slot.cz) * k;
      slot.cx += dx; slot.cy += (slot.ty - slot.cy) * k; slot.cz += dz;
      const raw = dt > 1e-4 ? Math.hypot(dx, dz) / dt : 0;
      slot.speed += (raw - slot.speed) * Math.min(1, dt * 10);

      // 向きも寄せる。届く向きは20Hzなので、そのまま入れると首が段階的に回る
      slot.drawYaw += wrapPi(slot.yaw - slot.drawYaw) * Math.min(1, dt * 12);

      mon.root.position.set(slot.cx, slot.cy, slot.cz);
      mon.root.rotation.set(0, slot.drawYaw, 0);
      const st = this._st;
      st.speed = slot.speed; st.state = slot.state; st.pitch = slot.pitch;
      mon.animate(dt, st);

      /* 溜めに入った瞬間を1回だけ知らせる。**専用の電文は作らない。**
         状態番号は20Hzの定期便に元から載っているので、前の値と比べれば
         「今フレームで溜めに入った」が分かる。溜めは0.42〜0.62秒あるので、
         50msごとの定期便で必ず1回は溜めの姿が届く（取りこぼさない） */
      if (slot.state !== slot.wasState) {
        if (onTell && slot.state === MSTATE.WINDUP) onTell(slot, mid);
        slot.wasState = slot.state;
      }

      /* --------------------------------------------- 影と頭の位置 */
      // 近い1枚（半径16m・毎フレーム焼く）に入る個体だけ影を落とす。
      // 理由は上のSHADOW_NEARの説明
      const ddx = slot.cx - cx, ddz = slot.cz - cz;
      const wantShadow = !!camera && (ddx * ddx + ddz * ddz) < SHADOW_NEAR * SHADOW_NEAR;
      if (wantShadow !== slot.shadowOn) {
        slot.shadowOn = wantShadow;
        for (const m of mon.meshes) m.castShadow = wantShadow;
      }
      /* 頭の位置。**当たり判定と同じ数字(MONSTER_HIT.HEAD)から作る。**
         骨から読むと、判定（サーバーの計算）と音や火花の位置（骨）が
         別々の場所を指すことになる */
      const h = MONSTER_HIT.HEAD;
      const s = mon.scale;
      slot.headPos.set(
        slot.cx + Math.sin(slot.drawYaw) * h.z * s,
        slot.cy + h.y * s,
        slot.cz + Math.cos(slot.drawYaw) * h.z * s,
      );
    }

    /* -------------------------------------------------------- 火の玉 */
    for (let i = this._spits.length - 1; i >= 0; i--) {
      const s = this._spits[i];
      s.life -= dt;
      s.vy -= 5.5 * dt;    // サーバー側(monsters.jsの_stepSpits)と同じ落ち方
      s.mesh.position.x += s.vx * dt;
      s.mesh.position.y += s.vy * dt;
      s.mesh.position.z += s.vz * dt;
      s.spin += dt * 9;
      // 少し脈打たせる。等速で飛ぶ光る球は、止まって見える瞬間がある
      const p = 1 + Math.sin(s.spin) * 0.12;
      s.mesh.scale.setScalar(p);
      if (s.life <= 0) this._killSpit(i);
    }
  }

  /** 火花や音の位置取りに使う。いなければnull */
  get(mid) {
    const slot = this.slots.get(mid);
    return slot ? { headPos: slot.headPos, root: slot.mon.root, kind: slot.kind } : null;
  }

  _release(mid) {
    const slot = this.slots.get(mid);
    if (!slot) return;
    this.slots.delete(mid);
    slot.mon.root.visible = false;
    slot.mon.root.rotation.set(0, 0, 0);
    let arr = this._pool.get(slot.kind);
    if (!arr) this._pool.set(slot.kind, (arr = []));
    arr.push(slot.mon);
  }

  /** 試合を抜ける時。全部消してプールへ */
  clear() {
    for (const mid of [...this.slots.keys()]) this._release(mid);
    for (let i = this._spits.length - 1; i >= 0; i--) this._killSpit(i);
  }

  /* 場面を丸ごと畳む時だけ。材質はモジュールで共有しているので、
     ここでは触らない（monster.jsのdisposeMonsterMaterialsが持ち主） */
  dispose() {
    this.clear();
    for (const mon of this._all) {
      this.scene.remove(mon.root);
      mon.dispose();
    }
    this._all.length = 0;
    this._pool.clear();
    for (const m of this._spitPool) this.scene.remove(m);
    this._spitPool.length = 0;
    this._spitGeo?.dispose?.();
    this._spitMat?.dispose?.();
    this._spitGeo = null;
    this._spitMat = null;
  }
}
