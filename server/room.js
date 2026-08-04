// 1試合ぶん。60Hzで全員を進めて、20Hzで全員の状態を配る。
//
// 「入力が届かなかった刻み」をどう扱うかがこの層の肝。
// 最後の入力を繰り返して埋めると、送る側が60Hzにわずかに届かないだけで
// 本人が要求していない前進が積み上がり、走っている間ずっと位置が引き戻される。
// なので入力が無い刻みは進めずに待ち、本当に途切れた時だけキーを離した扱いにする。
import './dom-stub.js';
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import {
  TICK_HZ, TICK_DT, SNAPSHOT_HZ, MAX_PLAYERS, MATCH, PHASE, ZONE, NADE, outsideZone,
  Sv, EV, packPlayer, SEATS_PER_TEAM, SEAT_SPAWN,
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

const nowMs = () => performance.now();

// 爆発の距離を測る時の使い回し。1回ごとに作ると毎爆発でごみが出る
const _nadeTo = new THREE.Vector3();

// 巻き戻しが本当に効いているかを確かめるための逃げ道。
// 普段は有効。NO_REWIND=1で切ると「当てたのに抜ける」が再現する
const REWIND_ON = process.env.NO_REWIND !== '1';

export class Room {
  constructor(world) {
    this.world = world;
    this.slots = new Map();      // id -> slot
    this.nextId = 1;
    this.tick = 0;
    this.events = [];
    // 局面と、その局面の残り秒。この2つで進行が全部決まる。
    // 以前は_ending(真偽)と_intermission(秒)の2本立てだったが、
    // ラウンドが挟まると「試合が終わったのか、ラウンドが終わったのか、
    // そもそも始まっていないのか」を真偽1つでは表せない
    this.phase = PHASE.WAIT;
    this.timeLeft = 0;
    this.round = 0;
    // 飛んでいる手榴弾。投げた順に並ぶ
    this.nades = [];
    this.nextNadeId = 1;
    this._timer = null;
    this._nextTickAt = nowMs();
    this._scoreTimer = 0;
  }

  /* ------------------------------------------------------ 出入り */

  get full() { return this.slots.size >= MAX_PLAYERS; }

  /* -------------------------------------------------------- ロビーの席 */

  /**
   * 席に着く／降りる。teamに-1を渡すと降りる。
   * 埋まっている席や、番号が範囲外の指定は黙って捨てる。
   * 「その席は埋まっています」と返さないのは、席の絵が全員に配られていて
   * 押せない事は画面から見えているため。押した側の間違いではなく、
   * 押す直前に他人が座った時にしか起きない
   */
  takeSeat(slot, team, seat) {
    // 試合が始まってから席を移られると、湧く位置も陣営も途中で変わる。
    // 席を動かせるのはロビーにいる間だけ
    if (this.phase !== PHASE.WAIT) return;

    if (team < 0) {
      if (slot.team === null) return;   // 既に立っている
      slot.team = null;
      slot.seat = null;
      slot.ready = false;
      this._sendLobby();
      return;
    }
    if (team !== 0 && team !== 1) return;
    if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS_PER_TEAM) return;
    if (slot.team === team && slot.seat === seat) return;   // 今いる席
    for (const s of this.slots.values()) {
      if (s !== slot && s.team === team && s.seat === seat) return;   // 埋まっている
    }
    slot.team = team;
    slot.seat = seat;
    // 座った所から湧くので、席が決まった時点で位置も合わせておく。
    // ここで動かしておかないと、ロビーで待っている間だけ前の席の場所に立っている
    this._respawn(slot);
    // 先に始めてから配る。始まっていれば理由は空文字になり、
    // 受け取った側は「もう始まった」と分かる
    this._startIfReady();
    this._sendLobby();
  }

  /**
   * 準備完了の入り切り。席に着いていない人は立てられない。
   * 立てた人が全員揃った時に試合が始まる（_whyNotStartが見ている）
   */
  setReady(slot, on) {
    if (this.phase !== PHASE.WAIT) return;
    if (slot.team === null) return;   // 席にいない人は準備しようが無い
    const next = !!on;
    if (slot.ready === next) return;
    slot.ready = next;
    this._startIfReady();
    this._sendLobby();
  }

  /** 各チームに座っている人。[Aの人たち, Bの人たち] */
  _seated() {
    const teams = [[], []];
    for (const s of this.slots.values()) {
      if (s.team === 0 || s.team === 1) teams[s.team].push(s);
    }
    return teams;
  }

  /** 揃っていれば始める */
  _startIfReady() {
    if (this._whyNotStart() === '') this._startMatch();
  }

  _lobbyRows() {
    const rows = [];
    for (const s of this.slots.values()) {
      rows.push([
        s.id, s.name,
        s.team === null ? -1 : s.team,
        s.seat === null ? -1 : s.seat,
        s.ready ? 1 : 0,
      ]);
    }
    return rows;
  }

  /** ロビーの絵を全員へ配る。席が動いた時と、人が出入りした時だけ呼ぶ */
  sendLobby(why) { this._sendLobby(why); }

  _sendLobby(why) {
    // whyを渡されなかった時は、その場で数え直す。
    // 呼ぶ側に毎回計算させると、片方だけ古い理由を配る事故が起きる
    const msg = {
      t: Sv.LOBBY,
      rows: this._lobbyRows(),
      why: why === undefined ? this._whyNotStart() : why,
    };
    for (const s of this.slots.values()) s.conn.send(msg);
  }

  /**
   * 始まらない理由。始められる状態なら空文字。
   * 今の試合の中身は1対1のままなので、各チームちょうど1人の時だけ始まる。
   * 席を3つずつ出しているのは、3対3にする時にこの仕組みをそのまま使うため。
   * 決着条件（今は「どちらかが倒れたら終わり」）を作り直すのが次の話
   */
  _whyNotStart() {
    if (this.phase !== PHASE.WAIT) return '';
    const [a, b] = this._seated();
    if (a.length === 0 && b.length === 0) return '席に着いてください';
    if (a.length === 0) return 'Aに誰もいません';
    if (b.length === 0) return 'Bに誰もいません';
    if (a.length !== 1 || b.length !== 1) return 'いまは1対1だけ動きます。各チーム1人ずつにしてください';
    // 席が埋まっただけでは始めない。座り間違えただけで撃ち合いが始まるのを避ける。
    // 押していない人が誰なのかまで出す。「準備待ち」とだけ出すと、
    // 2人しかいなくても自分が押したかどうかを思い出す所から始まる
    const notReady = [...a, ...b].filter((s) => !s.ready);
    if (notReady.length) return `${notReady.map((s) => s.name).join('、')} の準備待ち`;
    return '';
  }

  join(conn, name) {
    if (this.full) return null;
    const id = this.nextId++;
    const slot = {
      id,
      name,
      conn,
      // ロビーの席。入った時点では立ったまま（どちらのチームでもない）で、
      // 自分で押して座る。サーバーが勝手に割り振らないのは、
      // 誰と組むかを選べることがロビーを置く理由そのものだから
      team: null,
      seat: null,
      // 準備完了。席に着いてから自分で押す。
      // 席を降りた時と、試合が終わって待ちへ戻った時に倒れる
      ready: false,
      sim: new SimPlayer(id, name, this.world),
      pending: new Map(),   // seq -> [bits, yaw, pitch]
      nextSeq: -1,          // 次に食わせるseq
      lastSeq: -1,          // 最後に適用したseq（ackで返す）
      starve: 0,            // 入力が来ないまま待った刻み数
      lastYaw: 0,
      lastPitch: 0,
      budget: 0,
      // 戦闘範囲の外に居続けた秒数。猶予を過ぎたぶんだけ体力が減る。
      // 範囲に戻ったら0に戻す（外に出るたび猶予をやり直す）
      outsideFor: 0,
      // 取ったラウンド数。killsとは別物で、画面の上に出る点数はこちら
      rounds: 0,
      // 残りの手榴弾。ラウンドの頭で戻す
      nades: NADE.PER_ROUND,
    };
    this.slots.set(id, slot);
    this._respawn(slot);
    this.push({ e: EV.JOIN, id, name });
    if (!this._timer) this._start();
    // ここでロビーを配ってはいけない。
    //
    // 入ってきた本人へは、この時点ではまだ何も届かない。
    // 本人の画面は「お迎え(WELCOME)が届いた時点」で受け口を繋ぐ作りなので、
    // それより先に送ったロビーは受け取る相手がいないまま捨てられる。
    // 結果、後から入った側の画面には**先にいた人が誰も映らない**
    // （実際に「相手から見たら俺がロビーにいない」が起きた）。
    //
    // 配るのは server/index.js が WELCOME を送った後。
    // 先にいた人にも同じ電文が行くので、ここで別に配る必要も無い
    return slot;
  }

  leave(slot) {
    if (!this.slots.delete(slot.id)) return;
    this.push({ e: EV.LEAVE, id: slot.id });
    if (this.slots.size === 0) {
      // 誰もいなくなったら60Hzのタイマーを止める。部屋そのものは残す
      this._stop();
      this.phase = PHASE.WAIT;
      this.timeLeft = 0;
      this.round = 0;
      return;
    }
    // 抜けた人の席は空く。今は1対1なので、片方が抜けた時点で試合は成立しない。
    // 点数を持ち越すと、次に入ってきた別人が知らない負けを背負って始まる。
    //
    // ここで_whyNotStart()を使ってはいけない。あれは試合中(phaseがWAITでない)なら
    // 常に空文字を返すので、試合の最中に抜けられた時だけ素通りしてしまい、
    // 1人になった部屋で試合が進み続ける
    const [aSide, bSide] = this._seated();
    if (aSide.length !== 1 || bSide.length !== 1) {
      this.phase = PHASE.WAIT;
      this.timeLeft = 0;
      this.round = 0;
      for (const s of this.slots.values()) {
        s.rounds = 0; s.sim.kills = 0; s.sim.deaths = 0;
        // 準備完了も倒す。倒さないと、残った人が押しっぱなしの状態でロビーに戻り、
        // 次に誰かが座って準備を押した瞬間に、心の準備なく試合が始まる
        s.ready = false;
      }
      this._sendScore();
    }
    this._sendLobby();
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
    // 撃ったら包帯を中断する。クライアント側も撃った時点で中断するので、
    // ここで揃えないと、こちらだけ巻き切って体力が食い違う。
    // 「巻いている間は撃たせない」にはしない。中断の知らせが届くのと
    // 弾が届くのは同じ回線なので、順番が入れ替わると正当な弾まで消える
    sim.player.cancelHeal();

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

  /* ---------------------------------------------------------- 手榴弾 */

  // 投擲の受け口。撃つのと同じで、申告を受けるのは向きだけ。
  // 位置は本人の目から前へ少し出した所に固定する（好きな場所から出させない）
  throwNade(slot, origin, dir) {
    const sim = slot.sim;
    if (!sim.alive) return;
    if (this.phase !== PHASE.LIVE) return;
    if (slot.nades <= 0) return;
    slot.nades--;

    const eye = sim.eye();
    const g = {
      id: this.nextNadeId++,
      by: slot.id,
      pos: new THREE.Vector3(
        eye.x + dir.x * NADE.MUZZLE,
        eye.y + dir.y * NADE.MUZZLE,
        eye.z + dir.z * NADE.MUZZLE,
      ),
      vel: new THREE.Vector3(dir.x, dir.y, dir.z).multiplyScalar(NADE.SPEED),
      fuse: NADE.FUSE_S,
      // 転がっている玉のカプセル。Octreeは点ではなくカプセルで押し返すので、
      // 長さゼロの（＝球の）カプセルを使い回す
      cap: new Capsule(new THREE.Vector3(), new THREE.Vector3(), NADE.RADIUS),
    };
    this.nades.push(g);
  }

  // 飛翔と跳ね返り。1刻みぶん進めて、地形に埋まったら押し戻して勢いを削る
  _stepNades() {
    for (let i = this.nades.length - 1; i >= 0; i--) {
      const g = this.nades[i];
      g.fuse -= TICK_DT;

      g.vel.y -= NADE.GRAVITY * TICK_DT;

      // 1刻みぶんを一気に動かすと床をすり抜ける。
      // 初速20m/sだと1刻みで0.33m進むのに、玉の半径は0.075mしかない。
      // 床を跨いだ刻みでは、動かし終わった位置が既に床の0.3m下にあり、
      // そこに置いたカプセルは床の三角形とどこも重ならないので当たりが取れない。
      // 1回の移動が半径の半分を超えないところまで割ってから当てにいく
      const dist = g.vel.length() * TICK_DT;
      const steps = Math.min(8, Math.max(1, Math.ceil(dist / (NADE.RADIUS * 0.5))));
      const h = TICK_DT / steps;

      let dead = false;
      for (let s = 0; s < steps; s++) {
        g.pos.addScaledVector(g.vel, h);

        // 場外へ抜けた玉は追いかけない。地形の無い所へ落ち続ける
        if (g.pos.y < -30) { dead = true; break; }

        g.cap.start.copy(g.pos);
        g.cap.end.copy(g.pos);
        const hit = this.world.octree.capsuleIntersect(g.cap);
        if (!hit) continue;
        // 面から出してから、面に対する速度成分だけ反転させて減らす。
        // 押し出さずに反転だけすると、次の刻みでまた同じ面に埋まって震える
        g.pos.addScaledVector(hit.normal, hit.depth);
        const into = g.vel.dot(hit.normal);
        if (into < 0) g.vel.addScaledVector(hit.normal, -into * (1 + NADE.BOUNCE));
        // 面に沿う成分を摩擦で削る。これが無いと転がり続けて止まらない
        const k = Math.max(0, 1 - NADE.FRICTION * h);
        g.vel.x *= k; g.vel.z *= k;
        if (hit.normal.y > 0.5) g.vel.y *= k;
      }
      if (dead) { this.nades.splice(i, 1); continue; }

      if (g.fuse <= 0) {
        this._explode(g);
        this.nades.splice(i, 1);
      } else {
        this.push({ e: EV.NADE, gid: g.id, by: g.by, p: [g.pos.x, g.pos.y, g.pos.z] });
      }
    }
  }

  // 爆発。距離で線形に落ちるダメージを、遮蔽の無い相手にだけ入れる。
  // 味方はいないので投げた本人も巻き込む（自分の足元に落として道連れが成立する）
  _explode(g) {
    this.push({ e: EV.BOOM, gid: g.id, p: [g.pos.x, g.pos.y, g.pos.z] });
    if (this.phase !== PHASE.LIVE) return;

    for (const s of [...this.slots.values()]) {
      const sim = s.sim;
      if (!sim.alive) continue;
      // 胸の高さを狙う。足元だと段差1つで遮られ、頭だと屈んでも当たる
      const p = sim.player.collider.start;
      _nadeTo.set(p.x, p.y + 0.5, p.z);
      const d = _nadeTo.distanceTo(g.pos);
      if (d > NADE.BLAST_R) continue;
      // 爆心と相手の間に地形があるなら入らない。壁越しの爆風を作らない
      if (!originVisible(this.world.octree, g.pos, _nadeTo)) continue;

      const t = 1 - d / NADE.BLAST_R;
      const dmg = Math.max(NADE.MIN_DMG, NADE.BLAST_DMG * t);
      if (sim.protectIn > 0) continue;
      this.push({
        e: EV.HIT, id: s.id, by: g.by,
        dmg: Math.round(dmg * 10) / 10, part: 1, p: [g.pos.x, g.pos.y, g.pos.z],
      });
      sim.player.damage(dmg);
      if (!sim.player.alive) {
        const killer = this.slots.get(g.by);
        // 自分で自分を吹き飛ばした回は、相手の取得にする（_killByFallと同じ扱い）
        if (killer && killer !== s) this._kill(s, killer, 1);
        else this._killByFall(s);
      }
    }
  }

  /* -------------------------------------------------------- 戦闘範囲 */

  // 範囲の外に居る間だけ体力を削る。判定はサーバーが持つ。
  // クライアントにやらせると、外に出た人が自分で「出ていない」と言えてしまう。
  // 逆に警告の表示は各自の画面が自分の位置から出す（往復を待つと手遅れになる）ので、
  // 半径と猶予はprotocol.jsに置いて両側で同じ値を見る
  _zone(slot) {
    const sim = slot.sim;
    if (!sim.alive) { slot.outsideFor = 0; return; }
    const p = sim.player.collider.start;
    if (!outsideZone(p.x, p.z)) { slot.outsideFor = 0; return; }

    const was = slot.outsideFor;
    slot.outsideFor += TICK_DT;
    // 猶予を跨いだ刻みは、跨いだ分だけを削る。まるごと1刻み削ると
    // 猶予の長さが刻みの位相でぶれる
    const over = slot.outsideFor - ZONE.GRACE_S;
    if (over <= 0) return;
    const dt = Math.min(TICK_DT, over - Math.max(0, was - ZONE.GRACE_S));
    if (dt <= 0) return;

    sim.player.damage(ZONE.DPS * dt);
    if (!sim.player.alive) this._killByZone(slot);
  }

  // 範囲外で力尽きた。撃った人はいないが、1対1なので残った側のラウンド取得になる。
  // ここを引き分け扱いにすると、追い詰められた側が場外へ逃げてラウンドを潰せてしまう
  _killByZone(slot) {
    slot.outsideFor = 0;
    this.push({
      e: EV.KILL, id: slot.id, by: slot.id,
      w: slot.sim.weapon, head: false, z: 1,
    });
    if (this.phase !== PHASE.LIVE) return;
    slot.sim.deaths++;
    this._endRound(this._other(slot), 'zone');
  }

  /* ------------------------------------------------------ 生き死に */

  _kill(victim, killer, part) {
    this.push({
      e: EV.KILL, id: victim.id, by: killer.id,
      w: killer.sim.weapon, head: part === 0,
    });
    // ラウンドが動いていない間の撃ち合いは点に入れない。
    // 入れると画面に出ている点数が決着後にも動き続ける
    if (this.phase !== PHASE.LIVE) return;
    victim.sim.deaths++;
    killer.sim.kills++;
    this._endRound(killer, 'kill');
  }

  // 落下で力尽きた。戦域の外と同じ扱いで、残った側のラウンド取得にする
  _killByFall(slot) {
    this.push({
      e: EV.KILL, id: slot.id, by: slot.id,
      w: slot.sim.weapon, head: false, f: 1,
    });
    slot.sim.deaths++;
    this._endRound(this._other(slot), 'fall');
  }

  /** 1対1なので「相手」は1人に決まる。いなければnull */
  _other(slot) {
    for (const s of this.slots.values()) if (s !== slot) return s;
    return null;
  }

  // 席ごとの定位置。選ぶ余地を残さない。
  //
  // 以前は8箇所から「他人からSPAWN_MIN_DIST以上離れた所」を毎回抽選していたが、
  // ラウンドの頭は2人が同時に湧くので、相手の位置が決まる前に自分の位置を選ぶことになる。
  // 結果、条件を満たしているつもりで隣同士に出る回があった。
  // 席で固定すれば、どのラウンドでも必ず離れた位置から始まる。
  //
  // ロビーを入れてからは、湧く位置はチームと席番号から決まる（protocol.jsのSEAT_SPAWN）。
  // Aは西側、Bは東側にまとまるので、味方と敵が入り混じった位置から始まることが無い。
  // まだ席に着いていない人は、ロビーで立っているだけなので0番へ置く
  _spawnFor(slot) {
    const spawns = this.world.arenaSpawns;
    if (slot.team === null || slot.seat === null) return spawns[0];
    const idx = SEAT_SPAWN[slot.team][slot.seat % SEATS_PER_TEAM];
    return spawns[idx % spawns.length];
  }

  _respawn(slot) {
    const pos = this._spawnFor(slot);
    // 場外を向いて湧かないよう、必ず中央を向かせる
    const yaw = Math.atan2(pos.x, pos.z);
    slot.sim.spawn(pos, yaw);
    slot.sim.protectIn = MATCH.SPAWN_PROTECT_S;
    slot.starve = 0;
    slot.outsideFor = 0;
    slot.nades = NADE.PER_ROUND;
    // 包帯もラウンドの頭で戻す。持ち越すと、前のラウンドで使い切った側だけ
    // 立て直す手段が無いまま次のラウンドを戦うことになる
    slot.sim.player.refill();
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
      // ラウンドの途中では誰も生き返らない。倒れたらそのラウンドは終わりなので、
      // 復活はラウンドの頭で全員まとめてやる（_startRound）
      // 持ち替え・装填・無敵・連射の残りは実時間の話なので、
      // 入力が届いているかに関係なく毎刻み減らす。
      // 入力任せにすると、送るのを止めるだけで無敵が切れなくなる
      sim.clock(TICK_DT);
      this._feed(slot);
      // 位置が決まった後で見る。食べる前に見ると1刻み古い位置で判定することになり、
      // 戻り切った瞬間にもう1回削られる。
      // 削るのはラウンドが動いている間だけ。人待ちの間や決着後の数秒に
      // 範囲外で削られると、操作していないのに死ぬ
      if (this.phase === PHASE.LIVE) this._zone(slot);
      // 撃たれる以外の死に方（落下）でもラウンドは決まる。
      // shot()を通った死は_killが拾うが、Playerの中で体力が0になる経路は
      // ここで拾わないと、倒れたまま誰も勝たずに時間切れまで続く。
      // _killも_killByZoneも局面をBREAKへ移すので、二重には走らない
      if (this.phase === PHASE.LIVE && !sim.alive) this._killByFall(slot);
      sim.record(t);
    }

    // 玉はラウンドが動いている間だけ進める。幕間に爆発すると、
    // 次のラウンドが始まった直後の相手に前のラウンドの爆風が入る
    if (this.phase === PHASE.LIVE) this._stepNades();

    if (this.phase !== PHASE.WAIT) {
      this.timeLeft -= TICK_DT;
      if (this.timeLeft <= 0) {
        if (this.phase === PHASE.LIVE) this._endRound(null, 'time');
        else if (this.phase === PHASE.BREAK) this._startRound();
        else this._startMatch();
      }
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
      s.conn.send({
        t: Sv.SNAPSHOT, tk: this.tick, now, ack: s.lastSeq, left, ph: this.phase, ps,
      });
    }
    if (this.events.length > 0) {
      const e = this.events;
      this.events = [];
      for (const s of this.slots.values()) s.conn.send({ t: Sv.EVENT, e });
    }
  }

  _rows() {
    const rows = [];
    for (const s of this.slots.values()) {
      rows.push([s.id, s.sim.kills, s.sim.deaths, Math.round(s.conn.rtt || 0), s.rounds]);
    }
    return rows;
  }

  _sendScore() {
    const rows = this._rows();
    for (const s of this.slots.values()) s.conn.send({ t: Sv.SCORE, rows });
  }

  /* ------------------------------------------------------ ラウンド進行 */

  // 試合の頭。点数を0に戻して1ラウンド目へ
  _startMatch() {
    this.round = 0;
    for (const s of this.slots.values()) {
      s.rounds = 0;
      s.sim.kills = 0;
      s.sim.deaths = 0;
    }
    this._sendScore();
    this._startRound();
  }

  // ラウンドの頭。ここで初めて全員が生き返る
  _startRound() {
    this.round++;
    this.phase = PHASE.LIVE;
    this.timeLeft = MATCH.ROUND_TIME_S;
    // 前のラウンドで空中に残っていた玉は持ち越さない
    this.nades.length = 0;
    for (const s of this.slots.values()) this._respawn(s);
  }

  // ラウンドの決着。winnerがnullなら時間切れで、どちらの取得にもならない。
  // 「どちらかが倒れたら終わり」なので、残りの人数を数える必要がない（1対1固定）
  _endRound(winner, why) {
    if (this.phase !== PHASE.LIVE) return;
    if (winner) winner.rounds++;
    this._sendScore();

    if (winner && winner.rounds >= MATCH.ROUND_WINS) {
      this._endMatch(why);
      return;
    }
    this.phase = PHASE.BREAK;
    this.timeLeft = MATCH.ROUND_BREAK_S;
  }

  // 最終得点を配ってから、少し置いて次の試合を始める。
  // 終わったまま止めると待っている人が部屋に取り残されるが、
  // その場で0点に戻すと最終順位と0点が1ms差で届いて、順位が読めないまま消える
  _endMatch(why = 'score') {
    this.phase = PHASE.END;
    this.timeLeft = MATCH.MATCH_BREAK_S;
    // 得点だけを配ると、受け取った側は「これが最終順位なのか途中経過なのか」を
    // 区別できない。次の試合の0点で必ず上書きされるので、専用の電文で名乗る
    const rows = this._rows();
    for (const s of this.slots.values()) {
      s.conn.send({ t: Sv.MATCHEND, rows, why, next: MATCH.MATCH_BREAK_S });
    }
  }
}

/* ------------------------------------------------------------ 唯一の部屋 */

// 合言葉で部屋を分けるのをやめたので、部屋はサーバーに1つだけ。
// 名簿(Map)を持っていた時は、誰もいなくなった部屋をその都度畳んでいたが、
// 1つしかないなら畳む相手がいない。作り直しもしない。
//
// 空になっても捨てないのは、次に誰かが来た時に地形を組み直させないため。
// 部屋が抱えているのは進行の状態だけで、地形(world)は外から渡された1つを
// 参照しているだけなので、空のまま置いておいても重さはほとんど無い。
// 60Hzのタイマーだけは空になった時点で止まる（leave側で_stopしている）
let theRoom = null;

export function getRoom(world) {
  if (!theRoom) {
    theRoom = new Room(world);
    console.log('[room] 部屋を開いた');
  }
  return theRoom;
}
