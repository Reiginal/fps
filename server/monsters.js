// 協力プレイのモンスター。**サーバーだけが動かす。**
//
// 判定を持つのはサーバー、という決まり（src/net/protocol.jsの冒頭）はモンスターでも
// 変えない。クライアントに動かさせると、書き換えた人の画面でだけモンスターが
// 棒立ちになり、その人だけ安全に稼げる。
//
// AIの中身は1人用の敵（src/ai/enemy.js の Enemy クラス）をそのまま使う。
// server/dom-stub.js の上で本物のクラスがヘッドレスに動くことは実測済みで、
// 1体あたり update() 約0.17ms/フレーム、10体でも1ティック2ms弱に収まる。
// 状態機械（索敵→追跡→交戦→遮蔽）・視線判定・分離力を書き直さずに済むのが
// 一番大きい（あそこは1人用で長く調整してきた部分で、書き直すと必ず劣化する）。
//
// 1人用との違いは2つだけ:
//   ・狙う相手が複数いる。毎ティック「一番近い生きているプレイヤー」を選んで渡す
//   ・見た目の大小（小型・大型・ボス）を bodyScale で振る。
//     当たり判定も銃口の位置も骨から取っているので、縮尺を掛けるだけで全部ついてくる
import './dom-stub.js';
import { Enemy } from '../src/ai/enemy.js';

/* 種類ごとの体格と強さ。
   scaleは見た目と当たり判定の倍率（intersect()がbodyScaleを掛ける）。
   小型は速くて脆い・大型は遅くて硬い、で役割を分ける。
   ボスは1体だけの大物。体力は「4人で撃って十数秒」を目安に置いた */
export const MONSTER_KINDS = {
  grunt: {
    scale: 0.82, health: 70, speed: 4.2, damage: 5, accuracy: 0.26, fireRate: 0.18, radius: 0.28,
  },
  brute: {
    scale: 1.38, health: 260, speed: 2.7, damage: 11, accuracy: 0.34, fireRate: 0.30, radius: 0.47,
  },
  boss: {
    scale: 2.0, health: 1500, speed: 2.5, damage: 15, accuracy: 0.42, fireRate: 0.24, radius: 0.60,
  },
};

// 波の数。この数を凌いだらボス戦。
// 長丁場にしない（1試合10分を超えると、負けた時にもう1回が重くなる）
export const WAVE_COUNT = 3;

export class MonsterDirector {
  /**
   * worldはbuildWorld()の戻り値（octree / bounds / enemySpawns / coverPoints）。
   * 出来事は全部コールバックで部屋へ返す。こちらから部屋の中身は触らない
   * （触り始めると、部屋とモンスターのどちらが試合を進めているのか読めなくなる）
   *   onSpawn(m)              … 湧いた。mはこのファイルが持つ管理レコード
   *   onFire(m)               … 撃った（音と光のため。当たったかは別）
   *   onHitPlayer(slot, dmg)  … プレイヤーに当てた
   *   onDeath(m, bySlot, head)… 倒された
   *   onWave(n, boss)         … 波が進んだ
   *   onCleared()             … ボスまで全部倒した（勝ち）
   */
  constructor(world, cb = {}) {
    this.world = world;
    this.cb = cb;
    // Enemyが見る「レベル」。1人用と同じ項目名で渡す
    this.level = {
      octree: world.octree,
      bounds: world.bounds,
      coverPoints: world.coverPoints || [],
      enemySpawns: world.enemySpawns,
    };
    this.pool = [];
    this.active = [];   // { mid, kind, enemy, targetSlot, deadFor }
    this.wave = 0;
    this.bossWave = false;
    this.cleared = false;
    this.queue = [];    // これから湧く種類の並び
    this.spawnTimer = 0;
    this.betweenWaves = 3.0;
    this.nextMid = 1;
    this._spawnBag = null;
  }

  /* Enemyは組むのに20msかかる（骨とメッシュ）ので、倒れた個体を使い回す。
     1人用のDirector._obtainと同じ考え方。死体の表示はクライアントが
     自分で面倒を見る（MKILLを受けて倒し、時間で消す）ので、
     サーバー側は死んだらすぐプールへ返してよい */
  _obtain() {
    let e = this.pool.find((x) => !x._coopInUse);
    if (!e) {
      e = new Enemy(this.level);
      this.pool.push(e);
    }
    e._coopInUse = true;
    return e;
  }

  /** 波の中身。人数が多いほど数を足す（1人で4人分の群れは凌げない） */
  _composition(wave, playerCount) {
    const extra = Math.max(0, playerCount - 1);
    const list = [];
    const grunts = 4 + wave * 2 + extra * 2;
    const brutes = Math.max(0, wave - 1) + (wave >= 2 ? extra : 0);
    for (let i = 0; i < grunts; i++) list.push('grunt');
    for (let i = 0; i < brutes; i++) list.push('brute');
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

  /* 湧き場所。1人用のDirector._spawnOneと同じ「袋から4枚めくって一番遠い1枚」。
     遠さは「全プレイヤーの中で一番近い人との距離」で測る。
     誰かの目の前に湧くのが一番白けるので、最悪ケースで選ぶ */
  _pickSpawn(players) {
    const spawns = this.level.enemySpawns;
    if (!this._spawnBag || this._spawnBag.length === 0) this._refillSpawnBag();
    const bag = this._spawnBag;
    const look = Math.min(4, bag.length);
    let bestAt = 0, bestD = -1;
    for (let i = 0; i < look; i++) {
      const sp = spawns[bag[i]];
      let nearest = Infinity;
      for (const p of players) {
        const d = sp.distanceToSquared(p.player.collider.start);
        if (d < nearest) nearest = d;
      }
      if (nearest > bestD) { bestD = nearest; bestAt = i; }
    }
    const pick = bag.splice(bestAt, 1)[0];
    return spawns[pick];
  }

  _spawnOne(kind, players) {
    const def = MONSTER_KINDS[kind];
    const e = this._obtain();

    /* 体格を先に入れる。spawn()がthis.heightからカプセルを組むので、順番が逆だと
       大型の当たり判定だけ小型のままになる。
       radiusも変える——2倍のボスが0.34mの芯で歩くと、見た目の体の半分が
       壁にめり込んで見える */
    e.bodyScale = def.scale;
    e.height = 1.78 * def.scale;
    e.radius = def.radius;
    e.collider.radius = def.radius;
    e.root.scale.setScalar(def.scale);

    e.maxHealth = def.health;
    e.speed = def.speed * (0.92 + Math.random() * 0.16);
    e.damage = def.damage;
    e.accuracy = def.accuracy * (0.85 + Math.random() * 0.3);
    e.fireRate = def.fireRate * (0.9 + Math.random() * 0.25);

    e.spawn(this._pickSpawn(players));

    const m = {
      mid: this.nextMid++, kind, enemy: e, targetSlot: null, deadFor: 0,
    };
    /* 撃った時。狙いは「このティックにupdate()へ渡した相手」なので、
       当たったかどうかもその人に入れる。dmgが0の回は外した弾（音と光だけ） */
    e.onShoot = (_en, _origin, _dir, dmg) => {
      this.cb.onFire?.(m);
      if (dmg > 0 && m.targetSlot) this.cb.onHitPlayer?.(m.targetSlot, dmg);
    };
    e.onDeath = () => {
      this.cb.onDeath?.(m, m.lastHitBy || null, m.lastHitHead || false);
    };
    this.active.push(m);
    this.cb.onSpawn?.(m);
    return m;
  }

  /** 生きている数（湧き待ちも数える。0になったら波が片付いたという意味なので） */
  get remaining() {
    let n = this.queue.length;
    for (const m of this.active) if (m.enemy.alive) n++;
    return n;
  }

  /**
   * 毎ティック呼ぶ。playersは [{ slot, player }] の並び
   * （playerはsim.player。位置と生死をここから読む）
   */
  update(dt, players) {
    if (this.cleared) return;

    // 波の進行。今の波が片付いたら次を用意する
    if (this.queue.length === 0 && this.remaining === 0) {
      if (this.bossWave) {
        // ボスまで倒し切った。勝ち
        this.cleared = true;
        this.cb.onCleared?.();
        return;
      }
      this.betweenWaves -= dt;
      if (this.betweenWaves <= 0) {
        this.wave++;
        this.betweenWaves = 6.0;
        if (this.wave > WAVE_COUNT) {
          // ボス戦。1体の大物と、脇を固める小型
          this.bossWave = true;
          this.queue = ['boss', 'grunt', 'grunt'];
        } else {
          this.queue = this._composition(this.wave, players.length);
        }
        this.spawnTimer = 0;
        this.cb.onWave?.(Math.min(this.wave, WAVE_COUNT + 1), this.bossWave);
      }
    }

    // 湧かせる。一斉に出すと群れて歩いてくるので間隔を空ける（1人用と同じ）
    if (this.queue.length > 0) {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0) {
        this.spawnTimer = 0.7;
        this._spawnOne(this.queue.shift(), players);
      }
    }

    // 1体ずつ、一番近い生きているプレイヤーを狙わせる。
    // Enemy.update()は「1人のプレイヤー」を前提に書かれているので、
    // 相手の選び直しをここでやれば中身はそのまま使える
    for (const m of this.active) {
      const e = m.enemy;
      if (!e.alive) {
        // 死んだ個体はすぐ回収する。死体の絵はクライアントが自分で持つ
        m.deadFor += dt;
        if (m.deadFor > 0.5) { e._coopInUse = false; }
        continue;
      }
      let best = null, bestD = Infinity;
      for (const p of players) {
        if (!p.player.alive) continue;
        const d = e.collider.start.distanceToSquared(p.player.collider.start);
        if (d < bestD) { bestD = d; best = p; }
      }
      m.targetSlot = best ? best.slot : null;
      // 全員倒れている間も、動きは止めない（すぐ誰かが復活してくる）。
      // 生きている人がいないティックは最後に狙っていた姿勢のまま歩かせたいが、
      // update()にはplayerが必須なので、誰でもいいから渡す（alive:falseなら撃たない）
      const target = best ? best.player : players[0]?.player;
      if (!target) continue;
      e.update(dt, target, { enemies: this._aliveEnemies() });
    }

    // 回収済みをactiveから外す（詰め直しはここでしか起きないので毎ティックでも安い）
    for (let i = this.active.length - 1; i >= 0; i--) {
      const m = this.active[i];
      if (!m.enemy.alive && !m.enemy._coopInUse) this.active.splice(i, 1);
    }
  }

  // 分離力（仲間と離れて歩く）用。Enemyのupdateがctx.enemiesを見る
  _aliveEnemies() {
    const out = [];
    for (const m of this.active) if (m.enemy.alive) out.push(m.enemy);
    return out;
  }

  /**
   * 弾のレイと交差する一番手前のモンスター。
   * room.shot()が、プレイヤー標的（resolveShot）と距離を比べるのに使う。
   * padは近接の刃の太さ（プレイヤー同士の判定と同じ値を渡す）
   */
  intersectShot(origin, dir, pad = 0) {
    let best = null;
    for (const m of this.active) {
      const h = m.enemy.intersect(origin, dir, pad);
      if (h && (!best || h.distance < best.hit.distance)) best = { m, hit: h };
    }
    return best;
  }

  /** モンスターに当てた。倒し切ったらtrue（onDeathも飛ぶ） */
  hit(m, dmg, part, dir, bySlot) {
    m.lastHitBy = bySlot;
    m.lastHitHead = part === 'head';
    return m.enemy.hit(dmg, part, dir);
  }

  /** スナップショットに載せる中身（protocol.jsのpackMonsterへ渡す形） */
  packSource() {
    const out = [];
    for (const m of this.active) {
      const e = m.enemy;
      if (!e.alive) continue;
      out.push({
        mid: m.mid,
        x: e.collider.start.x, y: e.feetY, z: e.collider.start.z,
        yaw: e.aimYaw, pitch: e.aimPitch,
        state: e.state, hp: e.health,
      });
    }
    return out;
  }

  /** 試合を畳む。全部プールへ返して次の試合に備える */
  reset() {
    for (const m of this.active) { m.enemy.alive = false; m.enemy._coopInUse = false; }
    this.active.length = 0;
    this.queue.length = 0;
    this.wave = 0;
    this.bossWave = false;
    this.cleared = false;
    this.spawnTimer = 0;
    this.betweenWaves = 3.0;
    this._spawnBag = null;
  }
}
