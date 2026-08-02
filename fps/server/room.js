// 1試合ぶん。60Hzで全員を進めて、20Hzで全員の状態を配る。
//
// 「入力が届かなかった刻み」をどう扱うかがこの層の肝。
// 最後の入力を繰り返して埋めると、送る側が60Hzにわずかに届かないだけで
// 本人が要求していない前進が積み上がり、走っている間ずっと位置が引き戻される。
// なので入力が無い刻みは進めずに待ち、本当に途切れた時だけキーを離した扱いにする。
import './dom-stub.js';
import {
  TICK_HZ, TICK_DT, SNAPSHOT_HZ, MAX_PLAYERS, MATCH,
  Sv, EV, packPlayer,
} from '../src/net/protocol.js';
import { SimPlayer, resolveShot, rewindMs, originVisible } from './sim.js';

const TICK_MS = 1000 / TICK_HZ;
const SNAP_EVERY = Math.round(TICK_HZ / SNAPSHOT_HZ);
// 入力が来ないまま待てる刻み数。入力は3刻みまとめて20Hzで届くので、
// 回線の揺らぎ1〜2回分は待てる長さが要る。これを超えたら切れたとみなす
const STARVE_HOLD = 20;
// 溜まった入力をまとめて食べ始める深さ。これ未満なら回線の揺らぎの範囲なので待つ
const CATCHUP_AT = 8;
// 1刻みに2件食べる権利の溜まり方。これが無いと入力を大量に送るだけで倍速で動ける
const BUDGET_PER_TICK = 0.1;
const BUDGET_MAX = 30;
// 溜め込める入力の上限。巨大な配列で記憶を埋められないように
const PENDING_MAX = 96;
const EVENT_MAX = 256;
// 申告された発射位置を認める、本人の目からの距離。
// カメラのバネの揺れは数cmなのでこれで足りる。以前の2.5mは薄い壁を1枚越せてしまい、
// 曲がり角に隠れたまま壁の向こうへ発射位置を出して撃てた
const SHOT_ORIGIN_MAX = 0.6;
// 試合が終わってから次の試合を始めるまで。
// すぐ0点に戻すと最終順位と0点が同じ1msの間に届いて、必ず0-0が描かれる
const INTERMISSION_S = 8;

const nowMs = () => performance.now();

// 巻き戻しが本当に効いているかを確かめるための逃げ道。
// 普段は有効。NO_REWIND=1で切ると「当てたのに抜ける」が再現する
const REWIND_ON = process.env.NO_REWIND !== '1';

export class Room {
  constructor(code, world) {
    this.code = code;
    this.world = world;
    this.slots = new Map();      // id -> slot
    this.nextId = 1;
    this.tick = 0;
    this.events = [];
    this.timeLeft = MATCH.TIME_LIMIT_S;
    this._ending = false;
    this._intermission = 0;
    this._timer = null;
    this._nextTickAt = nowMs();
    this._scoreTimer = 0;
    this.onEmpty = null;
  }

  /* ------------------------------------------------------ 出入り */

  get full() { return this.slots.size >= MAX_PLAYERS; }

  join(conn, name) {
    if (this.full) return null;
    const id = this.nextId++;
    const slot = {
      id,
      name,
      conn,
      sim: new SimPlayer(id, name, this.world),
      pending: new Map(),   // seq -> [bits, yaw, pitch]
      nextSeq: -1,          // 次に食わせるseq
      lastSeq: -1,          // 最後に適用したseq（ackで返す）
      starve: 0,            // 入力が来ないまま待った刻み数
      lastYaw: 0,
      lastPitch: 0,
      budget: 0,
    };
    this.slots.set(id, slot);
    this._respawn(slot);
    this.push({ e: EV.JOIN, id, name });
    if (!this._timer) this._start();
    return slot;
  }

  leave(slot) {
    if (!this.slots.delete(slot.id)) return;
    this.push({ e: EV.LEAVE, id: slot.id });
    if (this.slots.size === 0) {
      this._stop();
      this.onEmpty?.(this);
    }
  }

  // 先客の名前と戦績。座標は直後のSNAPSHOTで届くのでここには載せない。
  // packPlayer()の数値の並びを渡すと、client.jsが名前だと思って読むp[1]がx座標になり、
  // 先にいた人が全員無名のまま戦績表と名札に並ぶ
  welcome(slot) {
    const players = [];
    for (const s of this.slots.values()) {
      players.push({
        id: s.id,
        name: s.name,
        kills: s.sim.kills,
        deaths: s.sim.deaths,
        ping: Math.round(s.conn.rtt || 0),
      });
    }
    return {
      t: Sv.WELCOME,
      id: slot.id,
      room: this.code,
      tick: this.tick,
      now: Math.round(nowMs()),
      you: { name: slot.name },
      players,
    };
  }

  /* -------------------------------------------------- 電文の受け口 */

  // 入力はseqの連番で届く。取りこぼしに備えて重複して届くので、
  // 適用済みより古い物は黙って捨てる
  input(slot, firstSeq, frames) {
    if (slot.nextSeq < 0) slot.nextSeq = firstSeq;
    for (let i = 0; i < frames.length; i++) {
      const seq = firstSeq + i;
      if (seq < slot.nextSeq) continue;
      // 溢れた時に新しい方を捨てると、そのseqが二度と届かないまま欠番になる。
      // 捨てるなら古い方。本人が今やりたい操作は新しい方に入っている
      if (slot.pending.size >= PENDING_MAX && !slot.pending.has(seq)) {
        this._dropOldest(slot);
      }
      slot.pending.set(seq, frames[i]);
    }
  }

  // 溜まった入力のうち一番古いものを1件捨てる。
  // Mapは入れた順に並ぶが、詰め直しで届いた古いseqが後ろに入ることがあるので端は見ない
  _dropOldest(slot) {
    let min = Infinity;
    for (const k of slot.pending.keys()) if (k < min) min = k;
    if (min !== Infinity) slot.pending.delete(min);
  }

  weapon(slot, index) {
    if (slot.sim.setWeapon(index)) return true;
    return false;
  }

  // 発射。当たり判定はここで完結する
  shot(slot, seq, origin, dir) {
    const sim = slot.sim;
    if (!sim.alive) return;
    // 持ち替えの最中は撃てない。切り替えを撃つ度に挟む撃ち方を成立させない
    if (sim.swapIn > 0) return;
    // rpmを超える連射は捨てる。弾数はクライアントが持つが、
    // 撃てる速さだけはサーバーが持たないと押しっぱなしで撃ち放題になる
    if (sim.fireTokens < 1) return;
    sim.fireTokens -= 1;

    // 撃った瞬間は無敵を解く。無敵のまま撃てるのは理不尽
    sim.protectIn = 0;

    // 申告された発射位置は、本人の目のすぐ近くで、かつ目から見えている所だけ認める。
    // 距離だけ見ていると、間に壁があっても構わないので壁の向こうへ発射位置を置いて撃てる。
    // 弾く（無視する）と回線の遅れで正当な弾まで消えるので、位置だけ目に直して撃たせる
    const eye = sim.eye();
    const far = Math.hypot(origin.x - eye.x, origin.y - eye.y, origin.z - eye.z) > SHOT_ORIGIN_MAX;
    if (far || !originVisible(this.world.octree, eye, origin)) {
      origin.copy(eye);
    }

    this.push({ e: EV.FIRE, id: slot.id, w: sim.weapon });

    const targets = [];
    for (const s of this.slots.values()) if (s !== slot) targets.push(s.sim);

    // 撃った人の画面に映っていた時刻まで戻す。
    // seqが古いほど「もっと前の画面を見て撃った」ということなので、その分も足す
    const stale = slot.lastSeq >= 0 && seq >= 0 ? Math.max(0, slot.lastSeq - seq) : 0;
    const back = rewindMs(slot.conn.rtt || 0, stale);
    const atMs = nowMs() - back;

    const res = resolveShot({
      octree: this.world.octree,
      origin,
      dir,
      def: sim.def,
      targets,
      atMs,
      rewind: REWIND_ON,
    });

    if (res.kind === 'player') {
      const tslot = this.slots.get(res.target.id);
      if (!tslot) return;
      const protectedTarget = res.target.protectIn > 0;
      const dmg = protectedTarget ? 0 : res.dmg;
      this.push({
        e: EV.HIT, id: res.target.id, by: slot.id,
        dmg: Math.round(dmg * 10) / 10, part: res.part, p: res.point,
      });
      if (dmg > 0) {
        res.target.player.damage(dmg);
        if (!res.target.player.alive) this._kill(tslot, slot, res.part);
      }
    } else if (res.kind === 'wall') {
      // 撃った本人は手元で着弾を描いている（往復を待つと自分の弾だけ遅れて見える）。
      // 誰の弾かを載せておかないと、本人の画面で同じ場所に二重に火花が出る
      this.push({ e: EV.IMPACT, by: slot.id, p: res.point, n: res.normal, k: 'concrete' });
    }
  }

  /* ------------------------------------------------------ 生き死に */

  _kill(victim, killer, part) {
    victim.sim.respawnIn = MATCH.RESPAWN_S;
    this.push({
      e: EV.KILL, id: victim.id, by: killer.id,
      w: killer.sim.weapon, head: part === 0,
    });
    // 試合が終わってからの撃ち合いは点に入れない。
    // 入れると画面に出ている最終順位が終了後に動き続ける
    if (this._ending) return;
    victim.sim.deaths++;
    killer.sim.kills++;
    // 決着した回はここでSCOREを配らない。_endMatchが配るのが最終順位になる
    if (killer.sim.kills >= MATCH.SCORE_LIMIT) this._endMatch();
    else this._sendScore();
  }

  // 湧き地点は生きている他人からSPAWN_MIN_DIST以上離れた所。
  // 条件を満たす所が無ければ一番遠い所で妥協する（湧いた瞬間に撃たれるよりまし）
  _pickSpawn(slot) {
    const spawns = this.world.enemySpawns;
    const others = [];
    for (const s of this.slots.values()) {
      if (s !== slot && s.sim.alive) others.push(s.sim.player.collider.start);
    }
    const ok = [];
    let best = spawns[0];
    let bestD = -1;
    for (const sp of spawns) {
      let min = Infinity;
      for (const o of others) {
        const d = Math.hypot(o.x - sp.x, o.z - sp.z);
        if (d < min) min = d;
      }
      if (min > bestD) { bestD = min; best = sp; }
      if (min >= MATCH.SPAWN_MIN_DIST) ok.push(sp);
    }
    // 候補が複数あるならばらけさせる。毎回同じ所に出ると待ち伏せが成立してしまう
    if (ok.length > 0) return ok[(Math.random() * ok.length) | 0];
    return best;
  }

  _respawn(slot) {
    const pos = this._pickSpawn(slot);
    // 場外を向いて湧かないよう、必ず中央を向かせる
    const yaw = Math.atan2(pos.x, pos.z);
    slot.sim.spawn(pos, yaw);
    slot.sim.protectIn = MATCH.SPAWN_PROTECT_S;
    slot.starve = 0;
    slot.lastYaw = yaw;
    slot.lastPitch = 0;
    this.push({ e: EV.SPAWN, id: slot.id, p: [pos.x, pos.y, pos.z], yaw });
  }

  /* ---------------------------------------------------------- 進行 */

  _start() {
    this._nextTickAt = nowMs();
    this._timer = setInterval(() => this._pump(), TICK_MS);
  }

  _stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // setIntervalは遅れるので、遅れた分をまとめて取り返す。
  // ただし取り返しすぎると1回のpumpで数百刻み走って固まるので頭を押さえる
  _pump() {
    const t = nowMs();
    let guard = 0;
    while (t >= this._nextTickAt && guard < 8) {
      this._tick();
      this._nextTickAt += TICK_MS;
      guard++;
    }
    if (t - this._nextTickAt > 500) this._nextTickAt = t;   // 追いつけないなら諦めて合わせ直す
  }

  _tick() {
    this.tick++;
    const t = nowMs();

    for (const slot of this.slots.values()) {
      const sim = slot.sim;
      if (!sim.alive) {
        sim.respawnIn -= TICK_DT;
        if (sim.respawnIn <= 0) this._respawn(slot);
      }
      // 持ち替え・装填・無敵・連射の残りは実時間の話なので、
      // 入力が届いているかに関係なく毎刻み減らす。
      // 入力任せにすると、送るのを止めるだけで無敵が切れなくなる
      sim.clock(TICK_DT);
      this._feed(slot);
      sim.record(t);
    }

    if (this._ending) {
      this._intermission -= TICK_DT;
      if (this._intermission <= 0) this._restart();
    } else {
      this.timeLeft -= TICK_DT;
      if (this.timeLeft <= 0) this._endMatch('time');
    }

    this._scoreTimer -= TICK_DT;
    if (this._scoreTimer <= 0) {
      this._scoreTimer = 1;
      this._sendScore();
    }

    if (this.tick % SNAP_EVERY === 0) this._broadcast();
  }

  // 届いた入力を1刻みぶん食べる。溜まっていたら2件まで食べて遅れを詰める
  _feed(slot) {
    const sim = slot.sim;

    // 欠番を踏み越える。WebSocketは順番が入れ替わらないので、
    // nextSeqより新しい入力が既に手元にあるならnextSeqはもう二度と届かない。
    // 待ち続けるとその人だけ試合中ずっと動けなくなる
    if (slot.pending.size > 0 && !slot.pending.has(slot.nextSeq)) {
      let min = Infinity;
      for (const k of slot.pending.keys()) if (k < min) min = k;
      if (min > slot.nextSeq) slot.nextSeq = min;
    }

    const max = (slot.pending.size > CATCHUP_AT && slot.budget >= 1) ? 2 : 1;
    let n = 0;
    while (n < max) {
      const f = slot.pending.get(slot.nextSeq);
      if (!f) break;
      slot.pending.delete(slot.nextSeq);
      slot.lastSeq = slot.nextSeq;
      slot.nextSeq++;
      slot.lastYaw = f[1];
      slot.lastPitch = f[2];
      sim.tick(f[0], f[1], f[2]);
      n++;
    }
    if (n === 2) slot.budget -= 1;

    if (n === 0) {
      // 入力が無い刻みは進めない。ここで最後の入力を繰り返すと、
      // 送信が60Hzにわずかに届かないだけで要求していない前進が積み上がり、
      // ackの位置と本人の予測位置が数十cm単位で食い違い続ける
      slot.starve++;
      if (slot.starve > STARVE_HOLD) {
        // ここまで来ると本当に切れている。キーを離した扱いにして止める。
        // 止めないと走っていた人が空中や壁際で固まったまま残る
        sim.tick(0, slot.lastYaw, slot.lastPitch);
      }
    } else {
      slot.starve = 0;
    }
    slot.budget = Math.min(BUDGET_MAX, slot.budget + BUDGET_PER_TICK);
  }

  push(ev) {
    if (this.events.length >= EVENT_MAX) return;
    this.events.push(ev);
  }

  _broadcast() {
    const ps = [];
    for (const s of this.slots.values()) ps.push(packPlayer(s.sim.packSource()));
    const now = Math.round(nowMs());
    // ackは人ごとに違うので、電文も人ごとに組む
    // 残り時間はここに相乗りさせる。専用の電文を毎秒足すより、
    // すでに20Hzで流れている物に数バイト載せるほうが安い
    const left = Math.round(Math.max(0, this.timeLeft) * 10) / 10;
    for (const s of this.slots.values()) {
      s.conn.send({ t: Sv.SNAPSHOT, tk: this.tick, now, ack: s.lastSeq, left, ps });
    }
    if (this.events.length > 0) {
      const e = this.events;
      this.events = [];
      for (const s of this.slots.values()) s.conn.send({ t: Sv.EVENT, e });
    }
  }

  _sendScore() {
    const rows = [];
    for (const s of this.slots.values()) {
      rows.push([s.id, s.sim.kills, s.sim.deaths, Math.round(s.conn.rtt || 0)]);
    }
    for (const s of this.slots.values()) s.conn.send({ t: Sv.SCORE, rows });
  }

  // 最終得点を配ってから、少し置いて次の試合を始める。
  // 終わったまま止めると待っている人が部屋に取り残されるが、
  // その場で0点に戻すと最終順位と0点が1ms差で届いて、順位が読めないまま消える
  _endMatch(why = 'score') {
    if (this._ending) return;   // 時間切れと点数到達が同じ刻みで重なっても二重に走らせない
    this._ending = true;
    this._intermission = INTERMISSION_S;
    this._sendScore();          // これが「今の試合の結果」
    // 得点だけを配ると、受け取った側は「これが最終順位なのか途中経過なのか」を
    // 区別できない。次の試合の0点で必ず上書きされるので、専用の電文で名乗る
    const rows = [];
    for (const s of this.slots.values()) {
      rows.push([s.id, s.sim.kills, s.sim.deaths, Math.round(s.conn.rtt || 0)]);
    }
    for (const s of this.slots.values()) {
      s.conn.send({ t: Sv.MATCHEND, rows, why, next: INTERMISSION_S });
    }
  }

  _restart() {
    this._ending = false;
    this._intermission = 0;
    for (const s of this.slots.values()) {
      s.sim.kills = 0;
      s.sim.deaths = 0;
      this._respawn(s);
    }
    this.timeLeft = MATCH.TIME_LIMIT_S;
    this._sendScore();          // 0点に戻ったことを伝えて次の試合へ
  }
}

/* -------------------------------------------------------- 部屋の名簿 */

const rooms = new Map();

export function getRoom(code, world) {
  let r = rooms.get(code);
  if (!r) {
    r = new Room(code, world);
    r.onEmpty = (room) => {
      rooms.delete(room.code);
      console.log(`[room] ${room.code} 誰もいなくなったので畳んだ`);
    };
    rooms.set(code, r);
    console.log(`[room] ${code} を開いた`);
  }
  return r;
}

export function roomList() {
  return [...rooms.values()].map((r) => ({ code: r.code, players: r.slots.size }));
}
