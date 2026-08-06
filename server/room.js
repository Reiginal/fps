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
  Sv, EV, packPlayer, SEATS, SEAT_SPAWN, CHARACTERS, MODE_IDS, LOBBY_ROW, LOBBY_ROW_LEN, DROP,
  TEAM_OF_SEAT, TEAM_NAMES, PRIMARY_IDS, PRIMARY_DEF,
} from '../src/net/protocol.js';
import { SimPlayer, resolveShot, rewindMs, originVisible, WEAPONS } from './sim.js';
import { modeOf } from './modes.js';
import { logs } from './logs.js';

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
    /* 回線が切れた人の記録。合言葉 -> { at, chr, seat, rounds, kills, deaths, stage }。
       **席そのものは押さえない。** 押さえると、抜けた人が戻ってこない時に
       その席が60秒間ずっと空かず、残った人が始められなくなる。
       戻ってきた時に空いていれば返す、くらいの弱い持ち方にしてある */
    this.parked = new Map();
    /* 地面に落ちている物。did -> { w, n, x, y, z, at }。
       **動かないので、位置は置いた時に一度配るだけ。**
       手榴弾は飛んでいる間ずっと20Hzで配っているが、こちらは要らない */
    this.drops = new Map();
    this.nextDrop = 1;
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
    // 遊び方。ロビーで誰でも変えられる（身内で遊ぶのに部屋主を作らない）。
    // 決まりの中身は server/modes.js が持つ
    this.mode = MODE_IDS[0];
  }

  /** 今の遊び方の決まり */
  get rules() { return modeOf(this.mode); }

  /* ------------------------------------------------------ 出入り */

  get full() { return this.slots.size >= MAX_PLAYERS; }

  /* -------------------------------------------------------- ロビーの席 */

  /**
   * 席に着く／降りる。seatに-1を渡すと降りる。
   * 埋まっている席や、番号が範囲外の指定は黙って捨てる。
   * 「その席は埋まっています」と返さないのは、席の絵が全員に配られていて
   * 押せない事は画面から見えているため。押した側の間違いではなく、
   * 押す直前に他人が座った時にしか起きない
   */
  takeSeat(slot, seat) {
    // 試合が始まってから席を移られると、湧く位置が途中で変わる。
    // 席を動かせるのはロビーにいる間だけ
    if (this.phase !== PHASE.WAIT) return;

    if (seat < 0) {
      if (slot.seat === null) return;   // 既に立っている
      slot.seat = null;
      slot.ready = false;
      this._sendLobby();
      return;
    }
    if (!Number.isInteger(seat) || seat >= SEATS) return;
    if (slot.seat === seat) return;   // 今いる席
    if (this._seatTaken(seat, slot)) return;   // 埋まっている
    slot.seat = seat;
    // 座った時点で、見た目が先客とかぶっていたら空いている物へ寄せる。
    // 立っている人同士は見た目がかぶれるので（席に着いている人しか見張っていない）、
    // その2人が続けて座ると同じ姿が2人並ぶ。ここが最後の砦
    if (this._charTaken(slot.chr, slot)) slot.chr = this._freeChar(slot);
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
    if (slot.seat === null) return;   // 席にいない人は準備しようが無い
    const next = !!on;
    if (slot.ready === next) return;
    slot.ready = next;
    this._startIfReady();
    this._sendLobby();
  }

  /**
   * その見た目が、席に着いている誰かに使われているか。
   *
   * **見張るのは席に着いている人だけ。** 部屋には最大8人入れるのに見た目は6種類しかないので、
   * 全員で取り合うと7人目が必ずあぶれる。実際に撃ち合うのは席に着いた4人までなので、
   * その4人が別々の姿であれば足りる（席は4つ、見た目は6種類あるので必ず行き渡る）
   */
  _charTaken(index, except = null) {
    for (const s of this.slots.values()) {
      if (s !== except && s.seat !== null && s.chr === index) return true;
    }
    return false;
  }

  /** まだ席に着いている誰にも使われていない見た目を1つ返す */
  _freeChar(except = null) {
    for (let i = 0; i < CHARACTERS.length; i++) if (!this._charTaken(i, except)) return i;
    return 0;   // 席が4つで見た目が6種類あるので、ここへは来ない
  }

  /**
   * 入った時に配る既定の見た目。
   *
   * こちらは席に着いていない人も含めて見る。**入った瞬間から散っていてほしい**ので、
   * 席に着くのを待たない。部屋の上限8人に対して見た目は6種類なので、
   * 7人目からは重なるが、席に着いた時にtakeSeatが寄せ直すので実害は無い
   */
  _defaultChar() {
    const used = new Set();
    for (const s of this.slots.values()) used.add(s.chr);
    for (let i = 0; i < CHARACTERS.length; i++) if (!used.has(i)) return i;
    return 0;
  }

  /**
   * 見た目を選ぶ。試合が始まってからは変えられない。
   * 途中で姿が変わると、撃っている相手が入れ替わったように見える。
   *
   * **同じ見た目が2人並ぶのも断る。** 撃ち合いの最中に区別が付かないし、
   * 撃破の知らせを見ても誰を倒したのか読めなくなる。早い者勝ち。
   * 断った時もロビーを配り直す。押した側の画面は元の番号へ戻るので、
   * 「押したのに変わらない」ではなく「取られている」が絵で分かる
   */
  setChar(slot, index) {
    if (this.phase !== PHASE.WAIT) return;
    const i = index | 0;
    if (i < 0 || i >= CHARACTERS.length) return;
    if (slot.chr === i) return;
    if (this._charTaken(i, slot)) { this._sendLobby(); return; }
    slot.chr = i;
    this._sendLobby();
  }

  /** 席に着いている人。チーム分けは無いので1本の並び */
  /**
   * 遊び方を選ぶ。**誰が押しても変わる。**
   * 身内で遊ぶのに部屋主を作ると、その人が居ない日に何も選べなくなる。
   * 試合が始まってからは効かない（途中で決まりが変わると何が起きたか読めない）
   */
  setMode(id) {
    if (this.phase !== PHASE.WAIT) return false;
    if (!MODE_IDS.includes(id) || id === this.mode) return false;
    this.mode = id;
    // 選んだ瞬間に持ち物を配り直す。ロビーで構えている武器が
    // その遊び方の物に変わるので、押した結果がその場で見える
    for (const s2 of this.slots.values()) { s2.stage = 0; this._arm(s2); }
    this._sendLobby();
    return true;
  }

  /**
   * 今の遊び方に合わせて持ち物を配る。
   * デスマッチなら既定の4本、ガンゲームなら今の段の1本だけ。
   *
   * **持ち物を決めるのはサーバー。** クライアントが自分で進めると、
   * そちらを書き換えるだけで最後の武器から始められる
   */
  _arm(slot) {
    const base = this.rules.carryFor(WEAPONS, slot);
    /* 拾って増えた武器を足す。**遊び方が配る物と別に持つ**ので、
       ラウンドが替わって配り直された時に自然に消える（extraを空にするだけ）。
       混ぜて1つの並びにすると、拾った物と元から持っていた物の区別が付かず、
       ラウンドをまたいで残ってしまう */
    const carry = base.slice();
    for (const i of slot.extra || []) if (!carry.includes(i)) carry.push(i);
    slot.sim.setCarry(carry);
    this.push({
      e: EV.ARM, id: slot.id, c: carry,
      st: slot.stage | 0, of: this.rules.stagesOf(WEAPONS),
    });
  }

  _seated() {
    const list = [];
    for (const s of this.slots.values()) if (s.seat !== null) list.push(s);
    return list;
  }

  /* ---------------------------------------------------------- チーム */

  /**
   * その人がどのチームか。
   *
   * **チーム分けの無い遊び方では「1人＝1チーム」を返す。**
   * こうしておくと、ラウンドの終わり方を「生きているチームが1つになったら」の
   * 1本で書ける。デスマッチだけ別の数え方を持つ形にすると、
   * チーム戦を足すたびにあちらの進行を壊す危険が出る
   */
  teamOf(slot) {
    if (!this.rules.teams) return `p${slot.id}`;
    const t = TEAM_OF_SEAT(slot.seat);
    // 席に着いていない人は誰の味方でもない（試合には出ていない）
    return t === null ? `p${slot.id}` : `t${t}`;
  }

  /** 2人が味方同士か。撃っても効かない相手かどうかの判定に使う */
  _sameTeam(a, b) {
    if (!a || !b || a === b) return false;
    if (!this.rules.teams) return false;
    return this.teamOf(a) === this.teamOf(b);
  }

  /**
   * 主武器を選ぶ。**ロビーにいる間だけ。**
   * 試合中に持ち物が変わると、撃ち合いの最中に手の中の物が入れ替わる。
   *
   * 選んだ瞬間に配り直すので、ロビーで構えている武器がその場で変わる。
   * **押した結果がその場で見える**のが大事で、見えないと押せたのか分からない
   */
  setPrimary(slot, id) {
    if (this.phase !== PHASE.WAIT) return false;
    if (!PRIMARY_IDS.includes(id) || slot.primary === id) return false;
    slot.primary = id;
    this._arm(slot);
    this._sendLobby();
    return true;
  }

  /* ------------------------------------------------------ 声の輪 */

  /**
   * 声が届く相手。**誰と繋いでよいかを決めるのはサーバー。**
   *
   * 手元が自分で決める形にすると、書き換えるだけで敵チームへ繋いで
   * 作戦を聞ける。合図を渡す所（signal）もこの並びを見て弾く。
   *
   * 決まり:
   *   ・チーム戦 … 味方だけ
   *   ・それ以外 … 部屋にいる人みんな（チームが無いので分けようが無い）
   *   ・席に着いていない人も入れる。**ロビーで話せないと、
   *     席を決める相談ができない**（そこが一番喋りたい場面）
   */
  voicePeers(slot) {
    const out = [];
    for (const s of this.slots.values()) {
      if (s === slot) continue;
      // チーム戦でも、どちらかが席に着いていない間は同じ輪に入れる。
      // 座る前から相談できないと、チーム分けそのものが決められない
      if (this.rules.teams && slot.seat !== null && s.seat !== null
        && this.teamOf(s) !== this.teamOf(slot)) continue;
      out.push(s.id);
    }
    return out;
  }

  /** 声の輪が変わった事を全員へ配る。**人ごとに中身が違う**ので1人ずつ送る */
  sendVoice() {
    for (const s of this.slots.values()) {
      s.conn.send({ t: Sv.EVENT, e: [{ e: EV.VOICE, p: this.voicePeers(s) }] });
    }
  }

  /**
   * 声の合図を相手へ渡す。**中身(d)は読まない。**
   *
   * 読むと、そこが壊れた電文を食わせる入口になる。
   * やるのは「同じ声の輪にいる相手か」を見て、そのまま渡すことだけ。
   */
  signal(from, toId, d) {
    if (d === undefined || d === null) return false;
    const to = this.slots.get(toId);
    if (!to || to === from) return false;
    if (!this.voicePeers(from).includes(toId)) return false;
    to.conn.send({ t: Sv.VSIG, from: from.id, d });
    return true;
  }

  /** 画面に出すチームの名前。チーム分けが無い遊び方では本人の名前 */
  _teamName(slot) {
    if (!this.rules.teams) return slot.name;
    const t = TEAM_OF_SEAT(slot.seat);
    return t === null ? slot.name : TEAM_NAMES[t];
  }

  /* ------------------------------------------------ 地面に落ちている物 */

  /**
   * 倒れた人が持っていた物を地面へ置く。
   *
   * 落とすかどうかは遊び方が決める（modes.jsのdrops）。
   * ガンゲームで拾えると、今の段の1本だけを持つという芯がそのまま消える。
   *
   * 拾う価値が無い物は置かない。ナイフしか持っていなくて手榴弾も無い人が
   * 倒れるたびに置いていると、**拾っても何も起きない物**が戦場に散らばる。
   * 近づいて何も起きない経験を1回させると、次からは誰も拾いに行かなくなる
   */
  _dropFrom(slot) {
    if (!this.rules.drops) return;
    const def = WEAPONS[slot.sim.weapon];
    const gun = !!def && !def.melee && !def.thrown;
    const nades = slot.nades | 0;
    if (!gun && nades <= 0) return;

    // 溜まりすぎたら古い物から消す。撃ち合いが続くと置きっぱなしが増え続ける
    while (this.drops.size >= DROP.MAX) {
      const oldest = this.drops.keys().next().value;
      this._takeDrop(oldest, null);
    }

    const p = slot.sim.player.collider.start;
    const did = this.nextDrop++;
    // 足元へ置く。目の高さのまま置くと、宙に浮いた武器が並ぶ
    const y = p.y - slot.sim.player.height * 0.5;
    this.drops.set(did, { w: gun ? slot.sim.weapon : -1, n: nades, x: p.x, y, z: p.z, at: nowMs() });
    this.push({ e: EV.DROP, did, w: gun ? slot.sim.weapon : -1, n: nades, p: [p.x, y, p.z] });
  }

  /** 地面から消す。byが居れば拾われた、居なければ時間切れ */
  _takeDrop(did, slot) {
    if (!this.drops.delete(did)) return;
    this.push(slot ? { e: EV.TAKE, did, by: slot.id } : { e: EV.TAKE, did });
  }

  /**
   * 近くに居る人が拾う。**踏んだら拾う**（押す操作を足さない）。
   *
   * 拾う操作を別のキーにすると、撃ち合いの最中には押せない。
   * 落ちている物を取りに行くこと自体が危険を冒す行為なので、
   * 辿り着いた時点で報われる形にする
   */
  _stepDrops() {
    if (!this.drops.size) return;
    const now = nowMs();
    for (const [did, d] of this.drops) {
      // 時間切れ
      if (now - d.at > DROP.LIFE_S * 1000) { this._takeDrop(did, null); continue; }
      for (const slot of this.slots.values()) {
        if (slot.seat === null || !slot.sim.alive) continue;
        const p = slot.sim.player.collider.start;
        const dx = p.x - d.x, dz = p.z - d.z;
        const dy = (p.y - slot.sim.player.height * 0.5) - d.y;
        if (dx * dx + dy * dy + dz * dz > DROP.RADIUS * DROP.RADIUS) continue;
        this._pickUp(slot, d);
        this._takeDrop(did, slot);
        break;
      }
    }
  }

  /* 拾った時に起きること。**弾そのものはサーバーが持っていない**ので、
     ここでやるのは「その武器を持てるようにする」と「手榴弾を戻す」の2つ。
     弾を戻すのは、拾った本人の画面がEV.TAKEを見てやる（弾数は元々手元の持ち物） */
  _pickUp(slot, d) {
    if (d.n > 0) slot.nades = Math.min(NADE.PER_ROUND, slot.nades + d.n);
    if (d.w >= 0 && !slot.sim.carry.includes(d.w)) {
      if (!slot.extra.includes(d.w)) slot.extra.push(d.w);
      this._arm(slot);
    }
  }

  /** 揃っていれば始める */
  _startIfReady() {
    if (this._whyNotStart() === '') this._startMatch();
  }

  /**
   * 試合が決まった後、次の試合を勝手に始めずロビーへ戻す。
   *
   * 以前は決着の8秒後に同じ顔ぶれで次が始まっていた。抜けたい人も
   * 席を変えたい人も、始まってしまうと次の決着まで動けない。
   * 準備完了を押し直してもらう形にすると、続けるかどうかを選べる。
   *
   * 席はそのまま残す。毎回座り直させるのは、同じ相手と続ける時に邪魔になる
   */
  _backToLobby() {
    this.phase = PHASE.WAIT;
    this.timeLeft = 0;
    this.round = 0;
    for (const s of this.slots.values()) {
      s.rounds = 0;
      s.sim.kills = 0;
      s.sim.deaths = 0;
      s.stage = 0;
      // 準備は倒す。倒さないと、結果を見ている間に相手が押した瞬間、
      // こちらは何もしていないのに次が始まる
      s.ready = false;
      this._respawn(s);
    }
    this._sendScore();
    this._sendLobby();
  }

  // 並びは protocol.js の LOBBY_ROW が決める。**番号を直に書かない。**
  // チーム制をやめた時、ここから team を落としたのに読む側は6項目のまま読んでいて、
  // 見た目の番号が1つずれて全員0番の姿になっていた
  _lobbyRows() {
    const rows = [];
    for (const s of this.slots.values()) {
      const row = new Array(LOBBY_ROW_LEN).fill(0);
      row[LOBBY_ROW.ID] = s.id;
      row[LOBBY_ROW.NAME] = s.name;
      row[LOBBY_ROW.SEAT] = s.seat === null ? -1 : s.seat;
      row[LOBBY_ROW.READY] = s.ready ? 1 : 0;
      row[LOBBY_ROW.CHR] = s.chr | 0;
      // 主武器。**味方が何を持っていくかが見えると、片方が近距離を持てる**
      row[LOBBY_ROW.PRIMARY] = s.primary;
      rows.push(row);
    }
    return rows;
  }

  /**
   * 発言を全員へ配る。名前も一緒に載せる。
   * idだけにすると、言った人が抜けた後で名前が引けなくなり、
   * 誰の発言か分からない行が画面に残る
   */
  chat(slot, text) {
    const msg = {
      md: this.mode, t: Sv.CHAT, name: slot.name, m: text };
    for (const s of this.slots.values()) s.conn.send(msg);
  }

  /** ロビーの絵を全員へ配る。席が動いた時と、人が出入りした時だけ呼ぶ */
  sendLobby(why) { this._sendLobby(why); }

  /* ロビーの中身を配る。**声の輪もここで配り直す。**
     輪が変わるのは「誰が入った・抜けた・席を移った・遊び方が変わった」の時で、
     それはロビーを配り直す時と完全に同じ。別々に呼ぶ形にすると、
     必ずどこかで片方を書き忘れて「声だけ繋がらない」が残る */
  _sendLobby(why) {
    this.sendVoice();
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
   * 2人から4人まで。全員が互いに敵で、最後まで残った人がそのラウンドを取る
   */
  _whyNotStart() {
    if (this.phase !== PHASE.WAIT) return '';
    const seated = this._seated();
    if (seated.length === 0) return '席に着いてください';
    if (seated.length < 2) return 'あと1人来れば始められます';
    /* チーム戦は両側に人が要る。片側だけに全員が座っていると、
       始まった瞬間に「相手が全員倒れている」状態になって即決着する */
    if (this.rules.teams) {
      const sides = new Set(seated.map((s) => TEAM_OF_SEAT(s.seat)));
      if (sides.size < 2) return `${TEAM_NAMES[sides.has(0) ? 1 : 0]}側の席にも座ってください`;
    }
    // 席が埋まっただけでは始めない。座り間違えただけで撃ち合いが始まるのを避ける。
    // 押していない人が誰なのかまで出す。「準備待ち」とだけ出すと、
    // 自分が押したかどうかを思い出す所から始まる
    const notReady = seated.filter((s) => !s.ready);
    if (notReady.length) return `${notReady.map((s) => s.name).join('、')} の準備待ち`;
    return '';
  }

  /** その席に誰か座っているか。except は自分（自分の席は埋まっている扱いにしない） */
  _seatTaken(seat, except = null) {
    for (const s of this.slots.values()) {
      if (s !== except && s.seat === seat) return true;
    }
    return false;
  }

  /* -------------------------------------------- 回線が切れた人の記録 */

  /**
   * 抜けた人の記録を取っておく。**戻ってきた時に0から始めさせないため。**
   *
   * 電車でトンネルに入った・Wi-Fiが切り替わった、で1試合ぶんの
   * ラウンドと撃破が消えるのは、遊ぶ側からするとただの理不尽になる。
   * 自分で「ホームへ戻る」を押した時とは区別が付かないが、区別する必要も無い
   * （自分で抜けた人が入り直したら、続きから始まるだけ）
   */
  _park(slot) {
    if (!slot.token) return;
    // 何も持っていない人の記録は取らない。入ってすぐ閉じただけの人まで
    // 溜め込むと、記憶が増えるだけで誰の役にも立たない
    if (slot.seat === null && !slot.rounds && !slot.sim.kills && !slot.sim.deaths) return;
    this.parked.set(slot.token, {
      at: nowMs(),
      chr: slot.chr | 0,
      primary: slot.primary,
      seat: slot.seat,
      rounds: slot.rounds | 0,
      kills: slot.sim.kills | 0,
      deaths: slot.sim.deaths | 0,
      stage: slot.stage | 0,
    });
  }

  /* 期限切れを捨てる。人が入ってくる時にだけ回すので、専用のタイマーは要らない
     （タイマーを持つと、誰もいない部屋でも動き続けることになる） */
  _sweepParked(now = nowMs()) {
    for (const [k, v] of this.parked) {
      if (now - v.at > MATCH.REJOIN_S * 1000) this.parked.delete(k);
    }
  }

  /** 合言葉に見合う記録を1回だけ取り出す。使ったら消す（二重に復帰させない） */
  _claimParked(token) {
    this._sweepParked();
    if (!token || typeof token !== 'string') return null;
    const v = this.parked.get(token);
    if (!v) return null;
    this.parked.delete(token);
    return v;
  }

  /* 合言葉。当てられても取れるのは「その人の点数」だけで、
     その人はもう繋がっていないので、なりすます相手がいない */
  _newToken() {
    return `${this.nextId}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  }

  join(conn, name, token = null) {
    if (this.full) return null;
    const id = this.nextId++;
    const slot = {
      id,
      name,
      conn,
      // 次に入り直した時に、この人だと分かるための合言葉。
      // お迎え(WELCOME)で1回だけ渡す
      token: this._newToken(),
      // ロビーの席。入った時点では立ったままで、自分で押して座る。
      // サーバーが勝手に割り振らないのは、どこに座るかを選べること自体が
      // ロビーを置く理由だから
      seat: null,
      // 準備完了。席に着いてから自分で押す。
      // 席を降りた時と、試合が終わって待ちへ戻った時に倒れる
      ready: false,
      // 選んだ見た目（CHARACTERSの番号）。姿そのものは運ばず、番号だけ配る。
      // 見た目に効くだけで、当たり判定にも足の速さにも一切効かない。
      //
      // 入った時点で、まだ使われていない番号を配る。
      // **全員0番から始める形にしていたので、誰も選び直さなければ4人とも同じ姿だった。**
      // 選べるようにしてあるだけでは足りず、既定でも散っていないと意味がない
      chr: this._defaultChar(),
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
      // ガンゲームで今どの武器まで進んだか。デスマッチでは使わない。
      // 0から始まって、倒すたびに1つ増える
      stage: 0,
      // この死をもう数えたか。**ラウンドが無い遊び方ではこれが要る。**
      // デスマッチは倒れた瞬間に局面がBREAKへ移るので二重に数えなかったが、
      // ガンゲームは局面が動かないまま倒れたままなので、
      // 目印が無いと毎刻み「落下で死んだ」が積み上がる（毎秒60回）
      downed: false,
      // 生き返るまでの残り秒。ラウンドが無い遊び方でだけ減る
      respawnIn: 0,
      // 回線が切れて戻ってきた人か。お迎えに載せて、画面に一言出すためだけの印
      back: false,
      // 地面から拾って増えた武器。ラウンドの頭で空になる（_respawn）
      extra: [],
      // 試合前に選んだ主武器（PRIMARY_IDSのどれか）。1本目だけがこれになる
      primary: PRIMARY_DEF,
    };
    /* 合言葉が合えば、前の続きから。**席は空いている時だけ返す。**
       抜けている間に誰かが座っていたら、その人を立たせてまで返さない
       （戻ってきた側は少し損をするが、座って待っていた側を巻き込むほうが悪い） */
    const back = this._claimParked(token);
    if (back) {
      slot.chr = back.chr;
      slot.primary = back.primary || PRIMARY_DEF;
      slot.rounds = back.rounds;
      slot.stage = back.stage;
      slot.sim.kills = back.kills;
      slot.sim.deaths = back.deaths;
      if (back.seat !== null && !this._seatTaken(back.seat)) slot.seat = back.seat;
      slot.back = true;
    }

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
    // 出て行く前に記録を取る。**消してから取ると席の情報がもう無い**ので、
    // 順番を入れ替えてはいけない
    this._park(slot);
    this.push({ e: EV.LEAVE, id: slot.id });
    // 抜けた所を残す。「途中で落ちた」のか「自分で抜けた」のかは
    // ここからは分からないが、**いつ何人になったか**が分かるだけで
    // 「3人目が入った直後に落ちる」のような形に辿り着ける
    logs.add('leave', { name: slot.name, count: this.slots.size });
    /* 声の輪を配り直すのは、この関数の最後の _sendLobby() が兼ねている。
       ここで別に呼んでいた時期があるが、二重に配るだけだったので外した
       （検査で「戻しても落ちない」＝要らない処理だと分かった） */
    if (this.slots.size === 0) {
      // 誰もいなくなったら60Hzのタイマーを止める。部屋そのものは残す
      this._stop();
      this.phase = PHASE.WAIT;
      this.timeLeft = 0;
      this.round = 0;
      return;
    }
    // 抜けた人の席は空く。残りが1人以下になった時点で試合は成立しない。
    // 点数を持ち越すと、次に入ってきた別人が知らない負けを背負って始まる。
    //
    // ここで_whyNotStart()を使ってはいけない。あれは試合中(phaseがWAITでない)なら
    // 常に空文字を返すので、試合の最中に抜けられた時だけ素通りしてしまい、
    // 1人になった部屋で試合が進み続ける
    // 席に着いている人が1人以下になったら試合は成立しない
    if (this._seated().length < 2) {
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
        // 見た目の番号。試合の途中で入ってきた人にも先客の姿が伝わるように、
        // ここにも載せる（普段はロビーの電文で届く）
        chr: s.chr | 0,
      });
    }
    return {
      t: Sv.WELCOME,
      id: slot.id,
      tick: this.tick,
      now: Math.round(nowMs()),
      you: { name: slot.name },
      // 次に入り直す時の合言葉。**この電文でしか渡らない**ので、
      // 受け取った側は必ず控えること（控えないと復帰できない）
      tk: slot.token,
      // 前の続きから始まったか。画面に一言出すためだけの印
      back: !!slot.back,
      /* 今このとき地面に落ちている物。**置いた時の1回しか配らない**ので、
         途中から入ってきた人にはここで渡さないと、拾える物が見えないまま
         「近づいたら何か起きた」になる */
      drops: [...this.drops].map(([did, d]) => [did, d.w, d.n, d.x, d.y, d.z]),
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

    /* 撃たれる側の並び。**味方は最初から入れない。**
       当たった後で「味方だったので無かったことにする」と、当たり判定の巻き戻しを
       通った後で捨てることになり、味方越しに後ろの敵へ当たるのか当たらないのかが
       その場の書き方次第で変わる。ここで外しておけば、味方の体は
       弾を止めない（味方の後ろの敵にはそのまま当たる） */
    const targets = [];
    for (const s of this.slots.values()) {
      if (s === slot || this._sameTeam(s, slot)) continue;
      targets.push(s.sim);
    }

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

  /* 爆発。距離で線形に落ちるダメージを、遮蔽の無い相手にだけ入れる。
     **投げた本人は巻き込む。** 自分の足元に落として道連れにするのは、
     追い詰められた側に残る最後の手なので消さない。
     チーム戦では味方だけ外す（味方に投げて倒せると、味方が邪魔でしかなくなる） */
  _explode(g) {
    this.push({ e: EV.BOOM, gid: g.id, p: [g.pos.x, g.pos.y, g.pos.z] });
    if (this.phase !== PHASE.LIVE) return;

    const thrower = this.slots.get(g.by) || null;
    for (const s of [...this.slots.values()]) {
      const sim = s.sim;
      if (!sim.alive) continue;
      if (this._sameTeam(s, thrower)) continue;
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

  // 範囲外で力尽きた。撃った人はいないが、倒れたことには変わらない。
  // ここを引き分け扱いにすると、追い詰められた側が場外へ逃げてラウンドを潰せてしまう
  _killByZone(slot) {
    slot.outsideFor = 0;
    this.push({
      e: EV.KILL, id: slot.id, by: slot.id,
      w: slot.sim.weapon, head: false, z: 1,
    });
    if (this.phase !== PHASE.LIVE) return;
    slot.downed = true;
    slot.respawnIn = MATCH.RESPAWN_S;
    slot.sim.deaths++;
    this._checkRoundOver('zone');
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
    victim.downed = true;
    victim.respawnIn = MATCH.RESPAWN_S;
    victim.sim.deaths++;
    killer.sim.kills++;
    // 倒れた人が持っていた物を地面へ。落とすかどうかは遊び方が決める
    this._dropFrom(victim);

    // 段が進むか、そこで勝ちが決まるかは遊び方が決める。
    // Roomは「誰が誰を倒したか」だけを渡して、結果を受け取る
    const what = this.rules.onKill(killer, victim, WEAPONS);
    if (what === 'win') {
      logs.add('match', { winner: `${killer.name}(${this.mode})`, why: 'stage' });
      this._endMatch('score');
      return;
    }
    if (what === 'advance') this._arm(killer);

    this._checkRoundOver('kill');
  }

  // 落下で力尽きた。戦域の外と同じ扱いで、残った側のラウンド取得にする
  _killByFall(slot) {
    this.push({
      e: EV.KILL, id: slot.id, by: slot.id,
      w: slot.sim.weapon, head: false, f: 1,
    });
    slot.downed = true;
    slot.respawnIn = MATCH.RESPAWN_S;
    slot.sim.deaths++;
    // ガンゲームでは自滅で段は進まない。進めると崖から飛び降りるのが
    // 一番速い勝ち方になる（modes.jsのonKillが自分自身を弾いている）
    this._checkRoundOver('fall');
  }

  /**
   * 誰かが倒れるたびに呼ぶ。**最後の1人になったらそのラウンドの勝ち。**
   *
   * 1対1の頃は「片方が倒れたら終わり」で、倒れた本人の相手を1人だけ探せば
   * 済んでいた（_other）。3人以上いるとそれが成り立たないので、
   * 生きている人数を数える形にした。
   *
   * 全員が同時に倒れた時（手榴弾の相討ち等）は誰の取得にもしない。
   * 「最後に死んだ人」を勝ちにすると、爆風の計算順という遊ぶ側から
   * まったく見えない事情で勝敗が決まることになる
   */
  _checkRoundOver(why) {
    if (this.phase !== PHASE.LIVE) return;
    // ラウンドを持たない遊び方（ガンゲーム）では、最後の1人になっても何も起きない。
    // 倒れた人は数秒で生き返って続く（_tickが面倒を見る）
    if (!this.rules.rounds) return;
    /* 生きている「チーム」を数える。チーム分けの無い遊び方では
       1人＝1チームなので、今まで通り「最後の1人」と同じ意味になる */
    const alive = new Map();
    for (const s of this.slots.values()) {
      if (s.seat === null || !s.sim.alive) continue;
      const key = this.teamOf(s);
      if (!alive.has(key)) alive.set(key, []);
      alive.get(key).push(s);
    }
    if (alive.size > 1) return;
    this._endRound(alive.size === 1 ? [...alive.values()][0] : null, why);
  }

  // 席ごとの定位置。選ぶ余地を残さない。
  //
  // 以前は8箇所から「他人からSPAWN_MIN_DIST以上離れた所」を毎回抽選していたが、
  // ラウンドの頭は2人が同時に湧くので、相手の位置が決まる前に自分の位置を選ぶことになる。
  // 結果、条件を満たしているつもりで隣同士に出る回があった。
  // 席で固定すれば、どのラウンドでも必ず離れた位置から始まる。
  //
  // 湧く位置は席番号から決まる（protocol.jsのSEAT_SPAWN）。
  // デスマッチは全員が互いに敵なので、4箇所を場内の対角へ散らしてある。
  // 近くに湧いた2人だけが真っ先に潰し合う形にならないようにするため。
  // まだ席に着いていない人は、ロビーで立っているだけなので0番へ置く
  _spawnFor(slot) {
    const spawns = this.world.arenaSpawns;
    if (slot.seat === null) return spawns[0];
    const idx = SEAT_SPAWN[slot.seat % SEATS];
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
    slot.downed = false;
    slot.respawnIn = 0;
    slot.nades = NADE.PER_ROUND;
    // 拾った武器はラウンドをまたがない。持ち越すと、1回拾えば以後ずっと持てる
    slot.extra = [];
    // 包帯もラウンドの頭で戻す。持ち越すと、前のラウンドで使い切った側だけ
    // 立て直す手段が無いまま次のラウンドを戦うことになる
    slot.sim.player.refill();
    slot.lastYaw = yaw;
    slot.lastPitch = 0;
    this.push({ e: EV.SPAWN, id: slot.id, p: [pos.x, pos.y, pos.z], yaw });
    // 湧いた時点で持ち物を配り直す。ガンゲームは段が進んでいるかもしれないし、
    // 遊び方そのものが変わっているかもしれない
    this._arm(slot);
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
      // 撃たれる以外の死に方（落下）も拾う。
      // shot()を通った死は_killが拾うが、Playerの中で体力が0になる経路は
      // ここで拾わないと、倒れたまま誰も勝たずに時間切れまで続く。
      //
      // downedで一度だけにする。デスマッチは倒れた瞬間に局面がBREAKへ移るので
      // 二重に走らなかったが、**ガンゲームは局面が動かない**ので、
      // 目印が無いと毎刻み「落下で死んだ」が積み上がる
      if (this.phase === PHASE.LIVE && !sim.alive && !slot.downed) this._killByFall(slot);

      // ラウンドが無い遊び方では、倒れた人が時間で生き返る。
      // ラウンド制はラウンドの頭でまとめて生き返るので、こちらは動かない
      if (this.phase === PHASE.LIVE && !this.rules.rounds && !sim.alive) {
        slot.respawnIn -= TICK_DT;
        if (slot.respawnIn <= 0) this._respawn(slot);
      }
      sim.record(t);
    }

    // 玉はラウンドが動いている間だけ進める。幕間に爆発すると、
    // 次のラウンドが始まった直後の相手に前のラウンドの爆風が入る
    if (this.phase === PHASE.LIVE) this._stepNades();
    // 落ちている物の時間切れと拾い上げ。ラウンドが動いている間だけ。
    // 幕間に拾えると、次のラウンドの頭に前のラウンドの拾い物を持ち越すことになる
    if (this.phase === PHASE.LIVE) this._stepDrops();

    if (this.phase !== PHASE.WAIT) {
      this.timeLeft -= TICK_DT;
      if (this.timeLeft <= 0) {
        if (this.phase === PHASE.LIVE) this._endRound(null, 'time');
        else if (this.phase === PHASE.BREAK) this._startRound();
        else this._backToLobby();
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
      // 並びは protocol.js の SCORE_ROW。**足す時は読む側も一緒に直す**
      rows.push([
        s.id, s.sim.kills, s.sim.deaths, Math.round(s.conn.rtt || 0), s.rounds,
        this.rules.teams ? (TEAM_OF_SEAT(s.seat) ?? -1) : -1,
      ]);
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
      // ガンゲームの段。試合ごとに最初の武器へ戻す
      s.stage = 0;
    }
    this._sendScore();
    logs.add('start', {
      players: [...this.slots.values()].filter((s) => s.seat !== null).map((s) => s.name).join('、'),
    });
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

  // ラウンドの決着。winnerがnullなら時間切れか相討ちで、誰の取得にもならない。
  // 誰が残ったかを数えるのは_checkRoundOver側
  /**
   * ラウンドの決着。winners は残ったチームの人たち（1人の時もある）。
   *
   * **チームの全員に1本ずつ入れる。** 取得数をチーム側に持たせず、
   * 人ごとの数字をそのまま揃える形にしてあるのは、画面が「自分の取得数」を
   * 出しているため。片方だけに入れると、倒れていた側の画面には
   * 勝ったのに0本のまま出る
   */
  _endRound(winners, why) {
    if (this.phase !== PHASE.LIVE) return;
    const list = winners ? [].concat(winners) : [];
    for (const w of list) w.rounds++;
    this._sendScore();
    logs.add('round', {
      round: this.round,
      winner: list.length ? this._teamName(list[0]) : '（決着なし）',
      why,
    });

    if (list.length && list[0].rounds >= MATCH.ROUND_WINS) {
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
    // 取得ラウンドが一番多い人が勝ち。同数なら並びの先頭になるが、
    // ここは記録であって判定ではないので、その粗さで足りる
    let best = null;
    for (const s of this.slots.values()) if (!best || s.rounds > best.rounds) best = s;
    logs.add('match', { winner: best ? `${best.name}(${best.rounds})` : '', why });
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
