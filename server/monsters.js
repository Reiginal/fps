// 協力プレイの進行。**サーバーだけが動かす。**
//
// 判定を持つのはサーバー、という決まり（src/net/protocol.jsの冒頭）はモンスターでも
// 変えない。クライアントに動かさせると、書き換えた人の画面でだけモンスターが
// 棒立ちになり、その人だけ安全に稼げる。
//
// ここが持つのは「試合の進行」だけ。1体ぶんの姿と動きは src/ai/monster.js。
//   ・波を組む → 湧かせる → 全部倒したら次の波 → 最後にボス
//   ・モンスターの攻撃（爪・火の玉・踏みつけ・咆哮）をプレイヤーへの被害に変える
//   ・弾と手榴弾がモンスターに当たったかを答える
//
// **見た目はサーバーで1つも組まない。** Monsterはvisual:falseで作れて、
// 当たり判定は位置と向きから計算で出る。前は兵士(Enemy)を流用していたので
// サーバーが骨とメッシュを1体ずつ組んでいた（1体20ms）。
import './dom-stub.js';
import * as THREE from 'three';
import { Monster, MONSTER_KINDS, MSTATE } from '../src/ai/monster.js';

export { MONSTER_KINDS, MSTATE };

// 波の数。この数を凌いだらボス戦。
// 長丁場にしない（1試合10分を超えると、負けた時にもう1回が重くなる）
export const WAVE_COUNT = 3;

/* 同時に生かしておく上限。**遊びやすさとサーバーの負荷の両方の話。**
   上限が無いと、湧いた数がそのまま画面の敵の数になって、
   遮蔽から出た瞬間に全方位から削られる（凌ぎようが無い）。
   倒すたびに待っている個体が出てくるので、総数は減らない。

   14から10へ下げた（2026-08-17）。**画面の重さにも直に効く。**
   1体29枚のメッシュなので、14体だと406枚を毎フレーム描くうえ、
   近くに居る個体は影の焼き直しにも同じ枚数ぶん乗る */
const ALIVE_CAP = 10;

/* 波が終わらない時の保険。**生き残りが0にならないと次の波へ進まない**作りなので、
   どこかで1体でも取り残されると試合がそこで止まる。
   1体ぶんの脱出（monster.jsの_unstick）で拾えない形——たとえば
   誰も居ない方向で延々と壁を回っている——のために、ここでも見張る */
const WAVE_STALL_S = 75;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _ray = new THREE.Ray();

/* 火の玉。**サーバーが飛ばして当たり判定も持つ。**
   クライアントへは「吐いた瞬間の出発点と向き」だけ送って、
   同じ速さでまっすぐ飛ぶ絵を各自に描かせる（曳光弾と同じ考え方）。
   毎フレーム位置を配ると、4体が吐いただけで位置の定期便が倍になる */
class Spit {
  constructor(mid, pos, dir, def) {
    this.mid = mid;
    this.pos = pos.clone();
    this.vel = dir.clone().multiplyScalar(def.speed);
    this.damage = def.damage;
    this.splash = def.splash;
    this.life = 2.6;
  }
}

export class MonsterDirector {
  /**
   * worldはbuildWorld()の戻り値（octree / bounds / enemySpawns）。
   * 出来事は全部コールバックで部屋へ返す。こちらから部屋の中身は触らない
   * （触り始めると、部屋とモンスターのどちらが試合を進めているのか読めなくなる）
   *   onSpawn(m)                  … 湧いた
   *   onHitPlayer(slot, dmg, kind)… プレイヤーに当てた。kindは 'claw'|'fire'|'stomp'
   *   onSpit(m, pos, dir)         … 火の玉を吐いた（絵と音）
   *   onBoom(pos, r)              … 火の玉が弾けた
   *   onSwing(m)                  … 爪を振った（音）
   *   onStomp(m, r)               … 踏みつけた
   *   onRoar(m)                   … 咆哮した
   *   onDeath(m, bySlot, part)    … 倒された
   *   onWave(n, boss)             … 波が進んだ
   *   onCleared()                 … ボスまで倒し切った（勝ち）
   */
  constructor(world, cb = {}) {
    this.world = world;
    this.cb = cb;
    // Monsterが見る「レベル」。隠れないのでcoverPointsは要らない
    this.level = {
      octree: world.octree,
      bounds: world.bounds,
      enemySpawns: world.enemySpawns,
    };
    this.pool = new Map();    // kind -> Monster[]（体格が違うので種類別に使い回す）
    this.active = [];         // { mid, kind, mon, targetSlot, deadFor }
    this.spits = [];
    this.wave = 0;
    this.bossWave = false;
    this.cleared = false;
    this.queue = [];
    this.spawnTimer = 0;
    this.betweenWaves = 3.0;
    this.nextMid = 1;
    this._spawnBag = null;
    this._waveT = 0;
    // Monster.update()へ毎ティック渡す標的。使い回して確保を避ける
    this._target = { pos: new THREE.Vector3(), eyeY: 0, alive: false };
    this._others = [];
  }

  /* 倒れた個体を使い回す。姿を持たない（visual:false）ので組み直しは軽いが、
     それでもカプセルと当たり所の確保はゼロにできる */
  _obtain(kind) {
    let arr = this.pool.get(kind);
    if (!arr) this.pool.set(kind, (arr = []));
    let m = arr.find((x) => !x._inUse);
    if (!m) {
      m = new Monster(this.level, kind, { visual: false });
      arr.push(m);
    }
    m._inUse = true;
    return m;
  }

  /* 波の中身。人数が多いほど数を足す（1人で4人分の群れは凌げない）。

     **数を半分近くまで落とした（2026-08-17）。**
     前は 5 + wave*3 + extra*2 で、1人でも 8 / 11 / 14 体。
     火を吐く方を足すと 8 / 12 / 16 の36体で、ボスに辿り着く前に
     同じ作業を36回やることになっていた。
     「ボスまで見たいから敵少なめにしてほしい」と言われた所。

     今は 1人で 5 / 7 / 9 体（火を吐く方を足して 5 / 8 / 11 の24体）。
     4人なら 11 / 13 / 15。倒すのに掛かる時間は人数ぶん短くなるので、
     頭数を素直に足すと1人の時より長くなる。足すのは1人あたり2体まで */
  _composition(wave, playerCount) {
    const extra = Math.max(0, playerCount - 1);
    const list = [];
    // 小型。波が進むほど増える
    const crawlers = 3 + wave * 2 + extra * 2;
    // 大型（火を吐く方）は2波目から。1波目から遠距離が居ると、
    // 遊び方を覚える前に見えない所から焼かれる
    const spitters = wave >= 2 ? (wave - 1) + (extra > 1 ? 1 : 0) : 0;
    for (let i = 0; i < crawlers; i++) list.push('crawler');
    for (let i = 0; i < spitters; i++) list.push('spitter');
    // 並べ替える。同じ種類が固まって出ると波の中で難度が階段状になる
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  _refillSpawnBag() {
    const n = this.level.enemySpawns.length;
    const bag = [];
    for (let i = 0; i < n; i++) bag.push(i);
    for (let i = bag.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [bag[i], bag[j]] = [bag[j], bag[i]];
    }
    this._spawnBag = bag;
  }

  /* 湧き場所。袋から4枚めくって「一番近い人から一番遠い1枚」を採る。
     誰かの目の前に湧くのが一番白けるので、最悪ケースで選ぶ。

     nearを立てると逆に「一番近い1枚（ただしCLOSEST_OKより手前は除く）」を採る。
     **ボス用。** ボスは体が大きくて路地を素直に通れないうえ、突進も火の玉も
     視線が要るので、町の反対側から歩かせると山場が始まる前に日が暮れる
     （実測：外縁の湧き地点から60秒歩かせて、爪が届いたのは
     市街地14箇所中4箇所・江戸16箇所中3箇所だけだった）。
     最後の大物が近くに現れるのは、演出としてもそのほうが正しい */
  _pickSpawn(players, near = false) {
    const spawns = this.level.enemySpawns;
    if (!this._spawnBag || this._spawnBag.length === 0) this._refillSpawnBag();
    const bag = this._spawnBag;
    const look = near ? bag.length : Math.min(4, bag.length);
    // 近い側を採る時の下限。これより手前だと足元に湧いて避けようがない
    const CLOSEST_OK = 14;
    let bestAt = 0, bestD = near ? Infinity : -1;
    for (let i = 0; i < look; i++) {
      const sp = spawns[bag[i]];
      let nearest = Infinity;
      for (const p of players) {
        const d = sp.distanceToSquared(p.player.collider.start);
        if (d < nearest) nearest = d;
      }
      if (near) {
        if (nearest < CLOSEST_OK * CLOSEST_OK) continue;
        if (nearest < bestD) { bestD = nearest; bestAt = i; }
      } else if (nearest > bestD) { bestD = nearest; bestAt = i; }
    }
    const pick = bag.splice(bestAt, 1)[0];
    return spawns[pick];
  }

  _spawnOne(kind, players, at = null) {
    const mon = this._obtain(kind);
    // ボスだけは近い側から出す（_pickSpawnのnearの説明を読むこと）
    mon.spawn(at || this._pickSpawn(players, kind === 'boss'));
    mon.state = MSTATE.SEEK;
    const rec = { mid: this.nextMid++, kind, mon, targetSlot: null, deadFor: 0 };
    mon._rec = rec;

    // 出来事の受け口。**当たったかどうかの判定はここで持つ**
    // （Monster側は「爪が出た」までしか知らない。誰に当たったかは試合の話）
    mon.onMelee = (self, dmg, reach) => {
      this.cb.onSwing?.(rec);
      this._clawHit(rec, dmg, reach);
    };
    mon.onSpit = (self, origin, dir) => {
      this.spits.push(new Spit(rec.mid, origin, dir, self.def.ranged));
      this.cb.onSpit?.(rec, origin, dir, self.def.ranged.speed);
    };
    mon.onStomp = (self, radius, dmg) => {
      this.cb.onStomp?.(rec, radius);
      this._stompHit(rec, radius, dmg);
    };
    mon.onRoar = () => {
      this.cb.onRoar?.(rec);
      this._roarSpawn(rec);
    };
    mon.onDeath = () => {
      this.cb.onDeath?.(rec, rec.lastHitBy || null, rec.lastPart || 'body');
    };
    mon.onStep = () => { this.cb.onStep?.(rec); };

    this.active.push(rec);
    this.cb.onSpawn?.(rec);
    return rec;
  }

  /* 爪。**振った瞬間に、間合いと向きの中に居る人へ入る。**
     飛び道具と違って避けようが無いので、溜め(WINDUP)が見えることが公平さの担保 */
  _clawHit(rec, dmg, reach) {
    const mon = rec.mon;
    const c = mon.collider.start;
    // 前方だけ。真後ろに立っている人まで薙ぐと、避けた意味が消える
    const fx = -Math.sin(mon.yaw), fz = -Math.cos(mon.yaw);
    for (const p of this._players) {
      if (!p.player.alive) continue;
      const px = p.player.collider.start.x - c.x, pz = p.player.collider.start.z - c.z;
      const d = Math.hypot(px, pz);
      if (d > reach) continue;
      if (d > 0.1 && (px / d) * fx + (pz / d) * fz < 0.25) continue;   // 正面120度ぶん
      // 4つめは「どこから来たか」。撃たれた向きのリングを出すのに要る
      this.cb.onHitPlayer?.(p.slot, dmg, 'claw', c);
    }
  }

  /* 踏みつけ。**周囲を薙ぐので向きは見ない。**
     そのかわり届く距離をはっきり決めて、外へ逃げれば必ず避けられるようにする */
  _stompHit(rec, radius, dmg) {
    const c = rec.mon.collider.start;
    for (const p of this._players) {
      if (!p.player.alive) continue;
      const d = Math.hypot(p.player.collider.start.x - c.x, p.player.collider.start.z - c.z);
      if (d > radius) continue;
      // 縁ほど軽い。ぎりぎりで逃げた人が丸ごと食らわない
      const k = 1 - Math.max(0, (d - radius * 0.4) / (radius * 0.6)) * 0.55;
      this.cb.onHitPlayer?.(p.slot, dmg * k, 'stomp', c);
    }
  }

  /* 咆哮。**小型を呼ぶ。**ボスの周りが一度空っぽになると、
     4人で囲んで削るだけの作業になるので、定期的に手を増やさせる */
  _roarSpawn(rec) {
    const c = rec.mon.collider.start;
    /* 呼ぶ数。**3体から2体へ減らした。**
       実測でプレイヤーが受ける被害の85〜88%が、ここで湧いた小型からだった
       （ボス本人は12〜15%）。咆哮の間隔も16秒→24秒にしてあるので、
       180秒で「11回×3体＝33体」から「7回×2体＝14体」になる。
       ボスが自分で殴るようになったぶん、周りは薄くする */
    let n = 2;
    for (let i = 0; i < n; i++) {
      if (this._aliveCount() >= ALIVE_CAP) break;
      const a = Math.random() * Math.PI * 2;
      const r = 6 + Math.random() * 4;
      _v.set(c.x + Math.cos(a) * r, 0.1, c.z + Math.sin(a) * r);
      // 湧く先が地形の中だと即座に詰まるので、上から地面を探して足元へ置く
      _ray.origin.set(_v.x, 6, _v.z);
      _ray.direction.set(0, -1, 0);
      const g = this.level.octree.rayIntersect(_ray);
      if (!g || 6 - g.distance > 1.5) { n++; continue; }   // 屋根の上などは避けて引き直す
      _v.y = 6 - g.distance;
      this._spawnOne('crawler', this._players, _v);
    }
  }

  /** 生きている数（湧き待ちも数える。0になったら波が片付いたという意味なので） */
  get remaining() {
    let n = this.queue.length;
    for (const m of this.active) if (m.mon.alive) n++;
    return n;
  }

  _aliveCount() {
    let n = 0;
    for (const m of this.active) if (m.mon.alive) n++;
    return n;
  }

  /**
   * 毎ティック呼ぶ。playersは [{ slot, player }] の並び
   * （playerはsim.player。位置と生死をここから読む）
   */
  update(dt, players) {
    if (this.cleared) return;
    this._players = players;

    /* ------------------------------------------------------ 波の進行 */
    if (this.queue.length === 0 && this.remaining === 0) {
      if (this.bossWave) {
        this.cleared = true;
        this.cb.onCleared?.();
        return;
      }
      this.betweenWaves -= dt;
      if (this.betweenWaves <= 0) {
        this.wave++;
        // 波と波の間。6秒は「片付いたのに何も起きない時間」が長すぎた
        this.betweenWaves = 4.0;
        this._waveT = 0;
        if (this.wave > WAVE_COUNT) {
          // ボス戦。1体の大物と、脇を固める小型
          this.bossWave = true;
          this.queue = ['boss', 'crawler', 'crawler', 'crawler'];
        } else {
          this.queue = this._composition(this.wave, players.length);
        }
        this.spawnTimer = 0;
        this.cb.onWave?.(Math.min(this.wave, WAVE_COUNT + 1), this.bossWave);
      }
    } else {
      this._waveT += dt;
    }

    /* 湧かせる。一斉に出すと群れて歩いてくるので間隔を空ける。
       0.8秒だと、湧き切るまでに波の頭の6秒を使い切って
       「まだ来ない」時間が続く。0.45秒でも群れにはならない
       （湧き地点そのものが散っているので、間隔より場所の方が効く）*/
    if (this.queue.length > 0 && this._aliveCount() < ALIVE_CAP) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 0.45;
        this._spawnOne(this.queue.shift(), players);
      }
    }

    /* -------------------------------------------------- 1体ずつ動かす */
    // 分離に渡す並び。毎ティック作り直すが、配列は使い回す
    this._others.length = 0;
    for (const m of this.active) if (m.mon.alive) this._others.push(m.mon);
    const ctx = { others: this._others };

    for (const m of this.active) {
      const mon = m.mon;
      if (!mon.alive) {
        // 死んだ個体はすぐ回収する。倒れる絵はクライアントが自分で持つ
        m.deadFor += dt;
        if (m.deadFor > 0.5) mon._inUse = false;
        continue;
      }
      // 一番近い生きている人を狙う
      let best = null, bestD = Infinity;
      for (const p of players) {
        if (!p.player.alive) continue;
        const d = mon.collider.start.distanceToSquared(p.player.collider.start);
        if (d < bestD) { bestD = d; best = p; }
      }
      m.targetSlot = best ? best.slot : null;
      const t = this._target;
      if (best) {
        t.pos.copy(best.player.collider.start);
        t.eyeY = best.player.feetY + best.player.height - 0.16;
        t.alive = true;
      } else {
        // 全員倒れている間も動きは止めない（数秒で誰かが復活してくる）。
        // 狙う相手が居ないので、その場で待つ姿になる
        t.alive = false;
      }
      mon.update(dt, t, ctx);
    }

    this._stepSpits(dt, players);

    /* -------------------------------------------------- 取り残しの保険 */
    // 波が長引いたら、遠くで迷っている個体を湧き直させて人の方へ寄せる。
    // ボスは動かさない（目の前から消えたら山場が壊れる）
    if (this._waveT > WAVE_STALL_S && this.remaining > 0) {
      this._waveT = 0;
      for (const m of this.active) {
        if (!m.mon.alive || !m.mon.canBurrow) continue;
        let near = Infinity;
        for (const p of players) {
          const d = m.mon.collider.start.distanceTo(p.player.collider.start);
          if (d < near) near = d;
        }
        if (near > 22) { m.mon.spawn(this._pickSpawn(players)); m.mon.state = MSTATE.SEEK; }
      }
    }

    // 回収済みをactiveから外す
    for (let i = this.active.length - 1; i >= 0; i--) {
      const m = this.active[i];
      if (!m.mon.alive && !m.mon._inUse) this.active.splice(i, 1);
    }
  }

  /* 火の玉を進める。壁に当たるか、人の近くを通ったら弾ける。
     弾けた所から半径splashぶんに被害が入る（手榴弾より狭くて軽い） */
  _stepSpits(dt, players) {
    for (let i = this.spits.length - 1; i >= 0; i--) {
      const s = this.spits[i];
      s.life -= dt;
      const move = _v.copy(s.vel).multiplyScalar(dt);
      const len = move.length();
      let hitAt = null;
      if (len > 1e-4) {
        _ray.origin.copy(s.pos);
        _ray.direction.copy(move).divideScalar(len);
        const h = this.level.octree.rayIntersect(_ray);
        if (h && h.distance <= len) hitAt = _v2.copy(s.pos).addScaledVector(_ray.direction, h.distance);
      }
      if (!hitAt) {
        // 人に直接触れたか。胸の高さで見る
        for (const p of players) {
          if (!p.player.alive) continue;
          const c = p.player.collider.start;
          const d = Math.hypot(s.pos.x - c.x, s.pos.z - c.z);
          if (d < 0.8 && Math.abs(s.pos.y - (c.y + 0.4)) < 1.2) {
            hitAt = _v2.copy(s.pos);
            break;
          }
        }
      }
      s.pos.add(move);
      s.vel.y -= 5.5 * dt;    // 少しだけ落ちる。まっすぐ飛ぶと弾に見える

      if (hitAt || s.life <= 0) {
        const at = hitAt || s.pos;
        this.cb.onBoom?.(at, s.splash);
        for (const p of players) {
          if (!p.player.alive) continue;
          const c = p.player.collider.start;
          const d = Math.hypot(at.x - c.x, at.z - c.z, at.y - (c.y + 0.4));
          if (d > s.splash) continue;
          const k = 1 - (d / s.splash) * 0.6;
          // 火の玉は「弾けた場所」から来たことにする（吐いた本体ではなく）
          this.cb.onHitPlayer?.(p.slot, s.damage * k, 'fire', at);
        }
        this.spits.splice(i, 1);
      }
    }
  }

  /**
   * 弾のレイと交差する一番手前のモンスター。
   * room.shot()が、プレイヤー標的（resolveShot）と距離を比べるのに使う。
   * padは近接の刃の太さ（プレイヤー同士の判定と同じ値を渡す）
   */
  intersectShot(origin, dir, pad = 0) {
    let best = null;
    for (const m of this.active) {
      const h = m.mon.intersect(origin, dir, pad);
      if (h && (!best || h.distance < best.hit.distance)) best = { m, hit: h };
    }
    return best;
  }

  /** モンスターに当てた。倒し切ったらtrue（onDeathも飛ぶ） */
  hit(m, dmg, part, bySlot) {
    m.lastHitBy = bySlot;
    m.lastPart = part;
    return m.mon.hit(dmg, part);
  }

  /** 部位ごとの倍率。room.jsが威力を出す時に掛ける */
  // 部位ごとの倍率。**種類を渡す**（唐傘小僧は頭の倍率が低い等、表が種類で違う）
  static mulOf(part, kind = null) { return Monster.mulOf(part, kind); }

  /** スナップショットに載せる中身（protocol.jsのpackMonsterへ渡す形） */
  packSource() {
    const out = [];
    for (const m of this.active) {
      if (!m.mon.alive) continue;
      out.push(m.mon.packSource(m.mid));
    }
    return out;
  }

  /** 試合を畳む。全部プールへ返して次の試合に備える */
  reset() {
    for (const m of this.active) { m.mon.alive = false; m.mon._inUse = false; }
    this.active.length = 0;
    this.queue.length = 0;
    this.spits.length = 0;
    this.wave = 0;
    this.bossWave = false;
    this.cleared = false;
    this.spawnTimer = 0;
    this.betweenWaves = 3.0;
    this._waveT = 0;
    this._spawnBag = null;
  }
}
