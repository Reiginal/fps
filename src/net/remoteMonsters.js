/* 協力プレイのモンスターの見た目。**AIは一切回さない。**
   サーバーが20Hzで送ってくる位置と状態（スナップショットのms）から姿を作るだけ。
   remote.jsのRemotePlayersと同じ考え方で、Enemyを1体作って骨とメッシュだけ借りる。

   補間はプレイヤー（stateAt()の2枚の間を取る）と違って、
   「今描いている位置から、最新の位置へ指数的に寄せる」だけにしてある。
   モンスターはAIの歩きなので急な方向転換が少なく、この安い形で足りる。
   （プレイヤーと同じ2枚補間に乗せたくなったら、client.jsの_snapsに
   モンスターも積む形へ直すのが正道） */

import * as THREE from 'three';
import { Enemy } from '../ai/enemy.js';
import { legPose } from './remote.js';

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const wrapPi = (a) => {
  let x = a;
  while (x > Math.PI) x -= TAU;
  while (x < -Math.PI) x += TAU;
  return x;
};

// Enemyはlevel.octreeしか見ないが、update()を呼ばないので空で足りる（remote.jsと同じ）
const NO_LEVEL = { octree: null, bounds: null };

const SPEED_WALK = 4.7;
const FALL_S = 0.75;
const CORPSE_HOLD_S = 2.5;
const CORPSE_SINK_S = 0.6;
const SHADOW_BOUND = 44;

const _pose = { thigh: 0, knee: 0, ankle: 0, abduct: 0 };

export class RemoteMonsters {
  constructor(scene) {
    this.scene = scene;
    this.slots = new Map();   // mid -> slot
    this._pool = [];          // 種類別に使い回す（scaleが違うのでkindで引く）
    this._all = [];
  }

  /** MSPAWNで呼ぶ。kind/scaleは湧いた時にしか届かないので、ここで姿を決める */
  spawn(mid, kind, scale, p) {
    if (this.slots.has(mid)) return;
    const at = this._pool.findIndex((x) => x._monKind === kind);
    let e = at >= 0 ? this._pool.splice(at, 1)[0] : null;
    if (!e) {
      e = new Enemy(NO_LEVEL);
      e._monKind = kind;
      this.scene.add(e.root);
      this.scene.add(e.blob);
      this._all.push(e);
    }
    const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
    e.root.scale.setScalar(s);
    e.bodyScale = s;
    e.height = 1.78 * s;
    e.root.visible = true;
    e.root.rotation.set(0, 0, 0);
    e.blob.visible = true;
    e.alive = true;
    e._resetPose?.();
    e._pickUpGun?.();
    for (const m of e.meshes) m.castShadow = true;
    for (const g of e.parts.detail) g.visible = true;

    const x = p?.[0] ?? 0, y = p?.[1] ?? 0, z = p?.[2] ?? 0;
    e.root.position.set(x, y, z);
    this.slots.set(mid, {
      enemy: e,
      // 今描いている位置(c*)と、サーバーから届いた最新の位置(t*)
      cx: x, cy: y, cz: z,
      tx: x, ty: y, tz: z,
      yaw: 0, pitch: 0,
      speed: 0, moveYaw: 0, lowerYaw: 0, phase: Math.random() * TAU,
      dead: false, deadT: 0, fallDir: Math.random() < 0.5 ? 1 : -1,
      seen: true, shadowOn: true,
      headPos: new THREE.Vector3(x, y + e.height - 0.12, z),
    });
  }

  /** MKILLで呼ぶ。倒れる絵はここから先、こちらだけで面倒を見る */
  kill(mid) {
    const slot = this.slots.get(mid);
    if (!slot || slot.dead) return;
    slot.dead = true;
    slot.deadT = 0;
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
    }
    /* msから消えた＝サーバーが手放した。倒れた個体はMKILLからの死に絵の途中なので
       そのまま演じ切らせる。生きているのに消えた個体（試合が畳まれた等）は即座に消す */
    for (const [mid, slot] of this.slots) {
      if (!slot.seen && !slot.dead) this._release(mid);
    }
  }

  /** 毎フレーム呼ぶ。姿勢はここで全部作る */
  update(dt) {
    for (const [mid, slot] of this.slots) {
      const e = slot.enemy;
      const p = e.parts;

      if (slot.dead) {
        // 倒れて沈んで消える（remote.jsの死亡と同じ組み立て）
        slot.deadT += dt;
        const k = clamp(slot.deadT / FALL_S, 0, 1);
        const fall = (1 - (1 - k) ** 3) * slot.fallDir * Math.PI * 0.5;
        e.root.rotation.x = fall;
        e.root.position.y = slot.cy + Math.abs(Math.sin(fall)) * 0.24 * e.bodyScale;
        const gone = slot.deadT - CORPSE_HOLD_S;
        if (gone > 0) {
          const sinkK = clamp(gone / CORPSE_SINK_S, 0, 1);
          e.root.position.y -= sinkK * 1.2 * e.bodyScale;
          e.blob.visible = false;
          if (sinkK >= 1) { this._release(mid); continue; }
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
      if (Math.hypot(dx, dz) > 1e-4) slot.moveYaw = Math.atan2(-dx, -dz);

      /* ------------------------------------------------------ 歩様 */
      const moving = slot.speed > 0.25;
      const amp = clamp(slot.speed / SPEED_WALK, 0, 1.15);
      const run = clamp((slot.speed - 1.8) / 2.4, 0, 1);
      // 下半身は進行方向、上半身は狙い（remote.jsの捻りの簡略版。
      // モンスターは覗き込み・しゃがみ・滑りが無いので、捻りの上限だけ守る）
      const wantLower = moving
        ? slot.yaw + clamp(wrapPi(slot.moveYaw - slot.yaw), -1.05, 1.05)
        : slot.lowerYaw;
      slot.lowerYaw += wrapPi(wantLower - slot.lowerYaw) * Math.min(1, dt * (moving ? 10 : 5.5));
      const twist = wrapPi(slot.yaw - slot.lowerYaw);
      if (moving) {
        slot.phase += dt * (0.62 + slot.speed * 0.30) * e.gaitRate * TAU;
        slot.phase = ((slot.phase % TAU) + TAU) % TAU;
      }
      const t = slot.phase;
      const moveRel = wrapPi(slot.moveYaw - slot.lowerYaw);
      const fwd = Math.cos(moveRel);
      const strafe = -Math.sin(moveRel) * amp;

      e.root.position.set(slot.cx, slot.cy, slot.cz);
      e.root.rotation.set(0, slot.lowerYaw, 0);

      legPose(t, amp, run, _pose, fwd, strafe, -1);
      p.legL.rotation.x = _pose.thigh; p.legL.rotation.z = _pose.abduct;
      p.shinL.rotation.x = _pose.knee; p.footL.rotation.x = _pose.ankle;
      legPose(t + Math.PI, amp, run, _pose, fwd, strafe, 1);
      p.legR.rotation.x = _pose.thigh; p.legR.rotation.z = _pose.abduct;
      p.shinR.rotation.x = _pose.knee; p.footR.rotation.x = _pose.ankle;

      const bobA = (0.035 + run * 0.045) * amp;
      p.hips.position.y = 0.92 - bobA * 0.5 + Math.cos(t * 2) * bobA * 0.5;
      p.hips.rotation.set(-run * 0.05 * amp, -Math.sin(t) * (0.09 + run * 0.10) * amp, 0);
      p.chest.rotation.set(
        -run * 0.16 * amp + slot.pitch * 0.25 + e.variant.slouch,
        twist + Math.sin(t) * (0.08 + run * 0.07) * amp,
        0,
      );
      p.headPivot.rotation.x = slot.pitch * 0.45;
      p.gunMount.rotation.x = slot.pitch * 0.8;

      /* --------------------------------------------- 影と頭の位置 */
      const wantShadow = Math.abs(slot.cx) <= SHADOW_BOUND && Math.abs(slot.cz) <= SHADOW_BOUND;
      if (wantShadow !== slot.shadowOn) {
        slot.shadowOn = wantShadow;
        for (const m of e.meshes) m.castShadow = wantShadow;
      }
      // 銃声・被弾の火花が同じフレームの頭の位置を読めるようにしておく
      slot.headPos.set(slot.cx, slot.cy + e.height - 0.12 * e.bodyScale, slot.cz);
    }
  }

  /** 火花や銃声の位置取りに使う。いなければnull */
  get(mid) {
    const slot = this.slots.get(mid);
    return slot ? { headPos: slot.headPos, root: slot.enemy.root } : null;
  }

  _release(mid) {
    const slot = this.slots.get(mid);
    if (!slot) return;
    this.slots.delete(mid);
    slot.enemy.root.visible = false;
    slot.enemy.root.rotation.set(0, 0, 0);
    slot.enemy.blob.visible = false;
    this._pool.push(slot.enemy);
  }

  /** 試合を抜ける時。全部消してプールへ */
  clear() {
    for (const mid of [...this.slots.keys()]) this._release(mid);
  }

  /* 場面を丸ごと畳む時だけ。remote.jsのdispose()と同じ理屈で、
     モジュール共有の顔テクスチャは触らない */
  dispose() {
    this.clear();
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
  }
}
