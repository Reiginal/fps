/* サーバーとの通信そのものと、自分の位置のつじつま合わせ。
   判定はサーバーが持つ（protocol.js参照）が、自分の移動だけは返事を待たずに
   ローカルで進める。往復の遅延ぶん操作が遅れる操作感は、遅延の多寡に関わらず
   「重い」としか感じられないので、遊べる物にならない。
   そのぶん、後から届いたサーバーの答えとのずれを静かに埋めるのがこのファイルの仕事。

   他人は逆に、届いた瞬間の位置へ飛ばすと毎秒20回の瞬間移動になる。
   INTERP_DELAY_MSだけ遅らせて2つのスナップショットの間を補間して描く。

   DOMには触らない。接続画面もスコアボードも別のファイルが作る。 */

import {
  C, Sv, EV, PHASE, encode, decode, unpackPlayer,
  qPos, qAng, INPUT_BATCH, INTERP_DELAY_MS, TIMEOUT_MS, CHAT_MAX,
} from './protocol.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
// 角度差は必ず-π..πに畳んでから使う。畳まないと真後ろで一周する
const wrapPi = (a) => {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
};

/* このずれを超えたら予測が破綻している（壁の判定が食い違った等）とみなして
   即座に飛ばす。中途半端に補間すると、壁にめり込んだまま歩き続けることになる */
const HARD_ERR = 0.5;
// 小さいずれを埋めきるまでの時間。いきなり代入すると画面がガクッと飛ぶ
const SMOOTH_S = 0.15;
/* 受信が途切れた時に補間の先を作る上限。長く伸ばすと、止まった相手が
   壁を突き抜けて滑っていく。止まって見える方がまだ嘘が小さい */
const EXTRAP_MAX_MS = 100;

// 補間に使うぶん＋取りこぼしの余裕。20Hzなので1.5秒ぶん残る
const SNAP_KEEP = 32;
// ackが返らないまま溜まり続けるのを防ぐ。5秒ぶんあれば足りる
const PENDING_MAX = 300;
// お迎えが来ないまま黙っているサーバーを待ち続けない
const CONNECT_TIMEOUT_MS = 8000;

export class NetClient {
  constructor() {
    this.id = null;
    this.connected = false;
    this.ping = 0;
    // id -> { name, kills, deaths, ping }。スコアボードはこれを読む
    this.players = new Map();

    // 試合の残り秒。スナップショットに相乗りして届く
    this.timeLeft = 0;
    // 人待ちから始まる。繋がった直後にラウンド中の表示を出さない
    this.phase = PHASE.WAIT;

    this.onEvent = null;
    this.onSnapshot = null;
    this.onScore = null;
    this.onDisconnect = null;
    // 試合終了。ここで受けた得点だけが最終順位で、直後に届くSCOREは次の試合の0点
    this.onMatchEnd = null;
    // ロビーの中身が変わった。誰かが座った・降りた・出入りした時に届く
    this.onLobby = null;
    // 局面が変わった。ロビーを畳んで操作を握るのはこれが起点
    this.onPhase = null;
    // 誰かが発言した
    this.onChat = null;

    /* 未確認の入力。ackが返るまで捨てない。
       中身は [seq, キー, yaw, pitch] に加えて、その入力を送った時点の自分の
       予測位置と、そこまでに補正で足し込んだ量の累計（下の_appliedの写し）。
       ずれを測るにはサーバーが答えた時刻の自分の予測位置が要る */
    this._pending = [];
    this._outbox = [];      // まだ電文にしていない刻み
    this._seq = 0;
    this._lastAck = -1;

    this._snaps = [];       // 時刻の昇順。stateAt()がここを引く
    this._clockOff = null;  // サーバー時刻 - 手元の時刻
    this._rtt = 0;

    // まだcolliderへ足していない補正の残り
    this._err = { x: 0, y: 0, z: 0, t: 0 };
    // これまでcolliderへ足した補正の累計。ずれの二重計上を防ぐのに要る
    this._applied = { x: 0, y: 0, z: 0 };
    this._player = null;

    this._ws = null;
    this._lastRecv = 0;
    this._watch = null;
    this._resolve = null;
    this._reject = null;
    this._connectTimer = null;
    this._closed = false;

    /* protocol.jsは「取りこぼしに備えて直近の未確認分も一緒に送る」と書いてあるが、
       既定では新しい刻みだけを送る。1パケット3刻みという前提を崩さないため。
       サーバー側が取りこぼしに弱いと分かったらここを1〜3にする */
    this.inputRedundancy = 0;
  }

  /* ------------------------------------------------------------ 接続 */

  /** 成功でお迎えの電文（WELCOME）がそのまま返る。失敗は理由つきで投げる */
  connect(url, { name = '' } = {}) {
    this.disconnect();
    this._closed = false;
    return new Promise((resolve, reject) => {
      const WS = globalThis.WebSocket;
      if (!WS) { reject(new Error('WebSocketが無い')); return; }
      let ws;
      try {
        ws = new WS(url);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this._ws = ws;
      this._resolve = resolve;
      this._reject = reject;
      this._lastRecv = now();

      this._connectTimer = setTimeout(() => this._fail('接続がタイムアウトした'), CONNECT_TIMEOUT_MS);
      this._connectTimer.unref?.();

      ws.onopen = () => {
        this._send({ t: C.JOIN, name: String(name).slice(0, 24) });
      };
      ws.onmessage = (ev) => this._recv(ev.data);
      // 切れ方の違いは遊ぶ側にはどうでもいい。理由の文字列だけ変えて同じ道を通す
      ws.onerror = () => this._fail('通信エラー');
      ws.onclose = (ev) => this._fail(ev && ev.reason ? String(ev.reason) : '切断');
    });
  }

  disconnect() {
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(1000); } catch { /* 既に閉じている */ }
    }
    this._stopWatch();
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    // 接続待ちのまま捨てられたPromiseを宙ぶらりんにしない
    if (this._reject) { const r = this._reject; this._resolve = this._reject = null; r(new Error('切断した')); }
    const wasConnected = this.connected;
    this._reset();
    if (wasConnected && !this._closed) {
      this._closed = true;
      this._emit(this.onDisconnect, 'bye');
    }
  }

  _reset() {
    this.connected = false;
    this.id = null;
    this.players.clear();
    this._pending.length = 0;
    this._outbox.length = 0;
    this._snaps.length = 0;
    this._seq = 0;
    this._lastAck = -1;
    this._clockOff = null;
    this._err.x = this._err.y = this._err.z = this._err.t = 0;
    this._applied.x = this._applied.y = this._applied.z = 0;
  }

  /* 落ち方が何であれ、外から見えるのは「切れた」の一度きりにする。
     onerror→oncloseと2回来るのが普通なので、ここで畳まないとUIが二度動く */
  _fail(why) {
    if (this._closed) return;
    this._closed = true;
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    this._stopWatch();
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try { ws.close(); } catch { /* 既に閉じている */ }
    }
    const reject = this._reject;
    this._resolve = this._reject = null;
    const wasConnected = this.connected;
    this._reset();
    // お迎えの前に落ちたなら接続失敗。後ならゲーム中の切断
    if (reject) reject(new Error(why));
    else if (wasConnected) this._emit(this.onDisconnect, why);
  }

  _startWatch() {
    this._stopWatch();
    // 何も届かないまま黙って固まるのが一番たちが悪い。切れたことにして知らせる
    this._watch = setInterval(() => {
      if (now() - this._lastRecv > TIMEOUT_MS) this._fail('応答が途絶えた');
    }, 1000);
    this._watch.unref?.();
  }

  _stopWatch() {
    if (this._watch) { clearInterval(this._watch); this._watch = null; }
  }

  _send(msg) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(encode(msg));
      return true;
    } catch {
      // 送れないソケットは既に死んでいる。ここで投げると呼び出し側のループが止まる
      return false;
    }
  }

  // 外から差された関数が投げても通信は続ける。UIの不具合で通信が死ぬ方が困る
  _emit(fn, a) {
    if (typeof fn !== 'function') return;
    try { fn(a); } catch (err) { console.error('[net] コールバックが投げた', err); }
  }

  /* ---------------------------------------------------------- 受信 */

  _recv(raw) {
    this._lastRecv = now();
    const m = decode(raw);
    if (!m) return;              // 壊れた電文で落ちない
    switch (m.t) {
      case Sv.WELCOME: this._welcome(m); break;
      case Sv.SNAPSHOT: this._snapshot(m); break;
      case Sv.EVENT:
        if (Array.isArray(m.e)) for (const ev of m.e) { this._emit(this.onEvent, ev); this._roster(ev); }
        break;
      case Sv.SCORE: this._score(m); break;
      case Sv.MATCHEND: this._matchEnd(m); break;
      // 発言。名前と本文をそのまま渡す。
      // HTMLとして解釈されないようにするのは、画面へ出す側の仕事
      case Sv.CHAT:
        if (typeof m.m === 'string') {
          this._emit(this.onChat, { name: String(m.name ?? ''), text: m.m });
        }
        break;
      // ロビーの中身。届いた物をそのまま渡す。
      // ここで席の絵を組み立てないのは、通信の層が画面の都合を持たないため
      case Sv.LOBBY: {
        const rows = Array.isArray(m.rows) ? m.rows : [];
        // 見た目の番号だけはここで拾って覚えておく。
        // 試合が始まると、相手の姿を組むのに要るのはこの番号で、
        // ロビーの電文はもう飛んでこない
        for (const r of rows) {
          const row = this._touchPlayer({ id: r[0], name: r[1] });
          if (row) row.chr = r[5] | 0;
        }
        this._emit(this.onLobby, { rows, why: m.why || '' });
        break;
      }
      // 往復を測るのはサーバー。こちらは即返すことだけが仕事
      case Sv.PING: this._send({ t: C.PONG, id: m.id }); break;
      case Sv.FULL: this._fail(m.why || '満員'); break;
      // サーバーが理由付きで閉じてきた（更新など）。
      // 「切れた」とだけ出すより、待てば戻ると分かる方が親切
      case Sv.BYE: this._fail(m.why || 'サーバーが閉じた'); break;
      default: break;
    }
  }

  _welcome(m) {
    this.id = m.id;
    this.connected = true;
    this._syncClock(m.now);
    this.players.clear();
    if (Array.isArray(m.players)) for (const p of m.players) this._touchPlayer(p);
    /* 自分の名前はyouに入る。playersにも自分の行は来るが、名前の無い形
       （packPlayerの配列）で配るサーバーもあり、行だけ先に出来ていると
       「居なければ入れる」では自分の名前が空欄のまま固まる */
    if (this.id != null) this._touchPlayer({ id: this.id, name: (m.you && m.you.name) || '' });
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    this._startWatch();
    const resolve = this._resolve;
    this._resolve = this._reject = null;
    if (resolve) resolve(m);
  }

  /* WELCOMEのplayersの中身の形はprotocol.jsに書かれていない。
     名前つきのオブジェクトでも、packPlayerの配列（先頭がidで名前が無い）でも
     読めるようにしておく。名前が拾えない形の時は空のままにして、見せる側でnameOf()が補う */
  _touchPlayer(p) {
    if (!p) return null;
    const id = Array.isArray(p) ? p[0] : p.id;
    if (id == null) return null;
    let row = this.players.get(id);
    // chrは選んだ見た目の番号。既定は0番で、ロビーの電文が来たら上書きされる
    if (!row) { row = { name: '', kills: 0, deaths: 0, ping: 0, rounds: 0, chr: 0 }; this.players.set(id, row); }
    const name = Array.isArray(p) ? p[1] : p.name;
    // 送る時と同じ長さで詰める。長い名前がそのまま来ると名札が画面を横切る
    if (typeof name === 'string' && name) row.name = name.slice(0, 24);
    if (!Array.isArray(p)) {
      if (typeof p.kills === 'number') row.kills = p.kills;
      if (typeof p.deaths === 'number') row.deaths = p.deaths;
      if (typeof p.ping === 'number') row.ping = p.ping;
      if (typeof p.chr === 'number') row.chr = p.chr | 0;
    }
    return row;
  }

  /* 名簿に効くイベントだけ拾う。
     名前が流れてくるのはJOINだけで、SCOREもスナップショットもidしか持たない。
     ここで拾わないとスコアボードも名札もキルログも空欄のままになる。
     外へ渡した後に消すのは、抜けた本人の名前を使って「◯◯が抜けた」を出せるようにするため */
  _roster(ev) {
    if (!ev || ev.id == null) return;
    if (ev.e === EV.JOIN) this._touchPlayer({ id: ev.id, name: ev.name });
    else if (ev.e === EV.LEAVE) this.players.delete(ev.id);
  }

  _score(m) {
    if (!Array.isArray(m.rows)) return;
    for (const r of m.rows) {
      if (!Array.isArray(r)) continue;
      const row = this._touchPlayer([r[0], null]);
      if (!row) continue;
      row.kills = r[1] | 0;
      row.deaths = r[2] | 0;
      row.ping = r[3] | 0;
      row.rounds = r[4] | 0;
      // 自分の往復遅延はサーバーが測った値を優先する。他人に見えている数字と揃う
      if (r[0] === this.id) this.ping = row.ping;
    }
    this._emit(this.onScore, m.rows);
  }

  /* 試合終了。名簿への反映は_scoreと同じでよいが、
     「これが最終順位だ」という情報はこの電文にしか無いので別で通す */
  _matchEnd(m) {
    this._score(m);
    this._emit(this.onMatchEnd, {
      rows: this.scoreRows(),
      why: m.why === 'time' ? 'time' : 'score',
      next: typeof m.next === 'number' ? m.next : 0,
    });
  }

  /* -------------------------------------------------------- 名簿の見せ方 */

  /** 画面に出す名前。JOINを受け取る前のidや、名前を配らないサーバーだと空になる。
      空欄のまま名札やキルログに出すと誰を撃ったのか分からないので、その時は番号で呼ぶ */
  nameOf(id) {
    const row = this.players.get(id);
    return (row && row.name) || `プレイヤー${id}`;
  }

  /** スコアボードの行。並べ替えは見せる側の仕事なので順番は付けない */
  scoreRows() {
    const out = [];
    for (const [id, r] of this.players) {
      out.push({
        id, name: this.nameOf(id),
        kills: r.kills | 0, deaths: r.deaths | 0, ping: r.ping | 0,
        rounds: r.rounds | 0,
        me: id === this.id,
      });
    }
    return out;
  }

  /* サーバー時刻と手元の時刻の差。片道ぶん偏るが、補間は「一定量遅らせる」
     だけなので偏りは効かない。跳ねた時だけ即座に合わせ、あとはゆっくり寄せる */
  _syncClock(serverNow) {
    if (typeof serverNow !== 'number') return;
    const off = serverNow - now();
    if (this._clockOff === null || Math.abs(off - this._clockOff) > 250) this._clockOff = off;
    else this._clockOff += (off - this._clockOff) * 0.05;
  }

  _snapshot(m) {
    this._syncClock(m.now);
    if (typeof m.left === 'number') this.timeLeft = m.left;
    // 局面。timeLeftが「ラウンドの残り」なのか「次が始まるまで」なのかは
    // これを見ないと分からない。
    // 変わった時だけ知らせる。ロビーを畳んで操作を握るのはこの合図が起点で、
    // 毎フレーム自分で見に行く形にすると「見た人」と「見ていない人」が分かれる
    if (typeof m.ph === 'number' && m.ph !== this.phase) {
      this.phase = m.ph;
      this._emit(this.onPhase, this.phase);
    }

    const time = typeof m.now === 'number' ? m.now : (this._snaps.length ? this._snaps[this._snaps.length - 1].time + 50 : 0);
    const last = this._snaps[this._snaps.length - 1];
    // 順番が入れ替わった古い電文で補間の土台を壊さない
    if (last && time <= last.time) return;

    const players = new Map();
    if (Array.isArray(m.ps)) {
      for (const a of m.ps) {
        if (!Array.isArray(a)) continue;
        const p = unpackPlayer(a);
        players.set(p.id, p);
      }
    }
    const snap = { time, tick: m.tk | 0, ack: typeof m.ack === 'number' ? m.ack : -1, players };
    this._snaps.push(snap);
    while (this._snaps.length > SNAP_KEEP) this._snaps.shift();

    this._reconcile(snap);
    this._emit(this.onSnapshot, m);
  }

  /* ------------------------------------------ 自分の位置のつじつま合わせ */

  /* サーバーがack番の入力まで処理した時点の位置と、その時の自分の予測位置を比べる。
     ここで出た差を_errに積み、correction()が毎フレーム少しずつcolliderへ足す */
  _reconcile(snap) {
    const ack = snap.ack;
    if (ack < 0 || this.id == null) return;
    const mine = snap.players.get(this.id);

    // 往復遅延。入力を送ってからその入力の返事が来るまでを測る
    for (const e of this._pending) {
      if (e.seq === ack && e.sentAt) {
        const rtt = now() - e.sentAt;
        this._rtt = this._rtt ? this._rtt + (rtt - this._rtt) * 0.2 : rtt;
        // サーバーが測った値が来ていればそちらが優先（_score参照）
        if (!this.players.get(this.id) || !this.players.get(this.id).ping) this.ping = Math.round(this._rtt);
        break;
      }
    }

    /* ack番の入力を処理し終えた時点の予測位置 ＝ ack+1番を送った瞬間の位置。
       送ってから進める順で呼ばれる前提（下のsendInputのコメント参照） */
    let rec = null;
    for (const e of this._pending) { if (e.seq === ack + 1) { rec = e; break; } }
    // 全部処理済みなら「今の位置」がそのまま予測位置
    if (!rec && ack === this._seq - 1 && this._player) rec = this._capture(-1);

    this._lastAck = ack;
    while (this._pending.length && this._pending[0].seq <= ack) this._pending.shift();

    if (!mine || !rec || !rec.hasPos) return;
    /* 記録した時点から今までに足した補正は、その状態にも後から効いている。
       引かずに比べると、直している最中のずれをもう一度数えて振動する */
    const dx = mine.x - rec.x - (this._applied.x - rec.ax);
    const dy = mine.y - rec.y - (this._applied.y - rec.ay);
    const dz = mine.z - rec.z - (this._applied.z - rec.az);

    const err = this._err;
    err.x = dx; err.y = dy; err.z = dz;
    // 大きいずれは予測の破綻。時間をかけて寄せず、その場で飛ばす
    err.t = Math.hypot(dx, dy, dz) >= HARD_ERR ? 0 : SMOOTH_S;
  }

  /** 湧き直しのように、予測を経由せず位置を強制的に動かした時に呼ぶ。
      飛ぶ前に控えた予測位置とサーバーの答えを突き合わせると、
      自分では移動していないのに巨大なずれが出たことになって、
      次のスナップショットで一度ガクッと引き戻される */
  resetPrediction() {
    for (const e of this._pending) e.hasPos = false;
    this._err.x = 0; this._err.y = 0; this._err.z = 0; this._err.t = 0;
    this._applied.x = 0; this._applied.y = 0; this._applied.z = 0;
  }

  /** 今の自分の足元の位置を控える。seqが負なら記録用の使い捨て */
  _capture(seq) {
    const p = this._player;
    const e = { seq, hasPos: false, x: 0, y: 0, z: 0, ax: 0, ay: 0, az: 0, sentAt: 0 };
    if (p && p.collider) {
      const c = p.collider;
      e.hasPos = true;
      e.x = c.start.x;
      // サーバーが配るyは足元。カプセルの下端は半径ぶん上にある
      e.y = c.start.y - c.radius;
      e.z = c.start.z;
      e.ax = this._applied.x; e.ay = this._applied.y; e.az = this._applied.z;
    }
    return e;
  }

  /* 毎フレーム呼ぶ。ずれをcolliderへ足す。
     cameraではなくcolliderに入れるのは、カメラだけ直すと当たり判定と見た目が
     ずれて「見えている物に当たらない」が起きるから */
  correction(localPlayer, dt) {
    if (localPlayer) this._player = localPlayer;
    const p = this._player;
    const e = this._err;
    if (!p || !p.collider) return;
    if (e.x === 0 && e.y === 0 && e.z === 0) return;

    let f = 1;
    if (e.t > 0) {
      // 残り時間で割ると、ずれは時間に対してまっすぐ0へ落ちる
      f = dt >= e.t ? 1 : dt / e.t;
      e.t -= dt;
      if (e.t < 0) e.t = 0;
    }
    const dx = e.x * f, dy = e.y * f, dz = e.z * f;
    const c = p.collider;
    c.start.x += dx; c.start.y += dy; c.start.z += dz;
    c.end.x += dx; c.end.y += dy; c.end.z += dz;
    this._applied.x += dx; this._applied.y += dy; this._applied.z += dz;
    e.x -= dx; e.y -= dy; e.z -= dz;
    if (e.t <= 0) { e.x = 0; e.y = 0; e.z = 0; }
  }

  /* ---------------------------------------------------------- 送信 */

  /* 毎tick呼ぶ。1刻みずつ送るとパケットが毎秒60個になるので、
     INPUT_BATCH刻み溜まってから1つの電文にまとめる。

     前提: この呼び出しは「これから進める入力」を渡す順で使う。
     つまり main は sendInput() → player.update() → correction() の順に呼ぶ。
     逆順で呼ぶと予測位置が1刻みずれ、常時5cm前後の補正が走る */
  sendInput(keyBits, yaw, pitch) {
    if (!this.connected) return;
    const seq = this._seq++;
    const e = this._capture(seq);
    e.key = keyBits | 0;
    e.yaw = yaw;
    e.pitch = pitch;
    this._pending.push(e);
    while (this._pending.length > PENDING_MAX) this._pending.shift();
    this._outbox.push(e);
    if (this._outbox.length >= INPUT_BATCH) this._flushInput();
  }

  _flushInput() {
    if (!this._outbox.length) return;
    const frames = [];
    let head = this._outbox[0];
    if (this.inputRedundancy > 0) {
      // 未確認のうち、今回の塊より前のものを指定数だけ前に付ける。sは付けた先頭のseq
      const first = this._outbox[0].seq;
      const extra = [];
      for (let i = this._pending.length - 1; i >= 0 && extra.length < this.inputRedundancy; i--) {
        const e = this._pending[i];
        if (e.seq < first) extra.unshift(e);
      }
      if (extra.length && extra[extra.length - 1].seq === first - 1) {
        head = extra[0];
        for (const e of extra) frames.push([e.key, qAng(e.yaw), qAng(e.pitch)]);
      }
    }
    const t = now();
    for (const e of this._outbox) {
      e.sentAt = t;
      frames.push([e.key, qAng(e.yaw), qAng(e.pitch)]);
    }
    this._outbox.length = 0;
    this._send({ t: C.INPUT, s: head.seq, f: frames });
  }

  /* 撃った瞬間に呼ぶ。当たり判定はサーバーなので、こちらは撃った向きだけ申告する。
     溜めている入力を先に吐くのは、サーバーがseqの入力を知らないまま
     この電文を受け取ると、巻き戻す先が無くて当たり判定を作れないため */
  sendShot(origin, dir) {
    if (!this.connected) return;
    this._flushInput();
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const len = Math.hypot(dx, dy, dz);
    // 長さ1でない向きを渡されるとサーバー側のレイの距離計算が狂う。ここで正す
    if (len > 1e-6) { dx /= len; dy /= len; dz /= len; }
    this._send({
      t: C.SHOT,
      s: this._seq - 1,
      o: [qPos(origin.x), qPos(origin.y), qPos(origin.z)],
      d: [qPos(dx), qPos(dy), qPos(dz)],
    });
  }

  // 投擲。撃つのと同じで向きだけを申告する。
  // 飛翔も跳ね返りも爆発もサーバーが計算するので、着弾点はこちらから指定できない
  sendThrow(origin, dir) {
    if (!this.connected) return;
    this._flushInput();
    let dx = dir.x, dy = dir.y, dz = dir.z;
    const len = Math.hypot(dx, dy, dz);
    if (len > 1e-6) { dx /= len; dy /= len; dz /= len; }
    this._send({
      t: C.THROW,
      o: [qPos(origin.x), qPos(origin.y), qPos(origin.z)],
      d: [qPos(dx), qPos(dy), qPos(dz)],
    });
  }

  sendWeapon(index) {
    if (!this.connected) return;
    this._send({ t: C.WEAPON, i: index | 0 });
  }

  /** ロビーで席に着く。-1を渡すと降りる。座れたかどうかはLOBBYが返ってくるかで分かる */
  sendSeat(seat) {
    if (!this.connected) return;
    this._send({ t: C.SEAT, st: seat | 0 });
  }

  /** 準備完了の入り切り。全員が立てた時にサーバーが試合を始める */
  sendReady(on) {
    if (!this.connected) return;
    this._send({ t: C.READY, r: on ? 1 : 0 });
  }

  /** 見た目を選ぶ。番号だけ送れば、相手の画面でも同じ姿が組み上がる */
  sendChar(index) {
    if (!this.connected) return;
    this._send({ t: C.CHAR, i: index | 0 });
  }

  /** 発言する。長さも連投もサーバーが見るので、ここでは送るだけ */
  sendChat(text) {
    if (!this.connected) return;
    const s = String(text ?? '').trim();
    if (!s) return;
    this._send({ t: C.CHAT, m: s.slice(0, CHAT_MAX) });
  }

  /* -------------------------------------------------------- 他人の補間 */

  /** サーバー時刻の推定値 */
  serverTime() { return now() + (this._clockOff ?? 0); }

  /** 他人を描くべき時刻。届いた分より一定量遅れた所を描く */
  renderTime() { return this.serverTime() - INTERP_DELAY_MS; }

  /* 自分のサーバー側の状態。HPも生き死にも武器もサーバーが持っているので、
     手元の予測からは作れない（位置だけは予測とcorrection()の方が新しい）。
     写しを返す。呼んだ側が書き換えても補間の土台を壊さないため */
  self() {
    if (this.id == null) return null;
    for (let i = this._snaps.length - 1; i >= 0; i--) {
      const p = this._snaps[i].players.get(this.id);
      if (p) return { ...p };
    }
    return null;
  }

  /* 指定時刻の他人の状態。位置は線形、角度は最短回りで補間する。
     返す配列は毎回新しく作る（受け取った側が持ち越しても壊れない）。
     自分は入らない。自分の位置は予測とcorrection()が持っている */
  stateAt(renderTimeMs = this.renderTime()) {
    const out = [];
    const s = this._snaps;
    if (!s.length) return out;

    // 補間の土台が1つも無い＝まだ始まっていない。最初の1枚をそのまま出す
    if (s.length === 1 || renderTimeMs <= s[0].time) {
      for (const p of s[0].players.values()) {
        if (p.id === this.id) continue;
        out.push(this._raw(p, false));
      }
      return out;
    }

    let ai = -1;
    for (let i = s.length - 1; i >= 0; i--) { if (s[i].time <= renderTimeMs) { ai = i; break; } }

    // 先が無い＝受信が途切れている。外挿は上限まで、そこから先は最後の位置で止める
    if (ai === s.length - 1) {
      const a = s[ai], prev = s[ai - 1];
      const dt = clamp(renderTimeMs - a.time, 0, EXTRAP_MAX_MS) / 1000;
      const span = (a.time - prev.time) / 1000;
      for (const p of a.players.values()) {
        if (p.id === this.id) continue;
        const o = this._raw(p, dt > 0);
        const q = prev.players.get(p.id);
        if (q && span > 1e-4 && dt > 0) {
          // 角度は伸ばさない。伸ばすと途切れた相手がその場で回り続ける
          o.x += (p.x - q.x) / span * dt;
          o.y += (p.y - q.y) / span * dt;
          o.z += (p.z - q.z) / span * dt;
        }
        out.push(o);
      }
      return out;
    }

    const a = s[ai], b = s[ai + 1];
    const span = b.time - a.time;
    const u = span > 1e-4 ? clamp((renderTimeMs - a.time) / span, 0, 1) : 0;
    /* 並べる相手は新しい側を基準にする。抜けた相手を古い側から拾い続けると、
       出ていった人の抜け殻がその場に立ち続ける */
    for (const q of b.players.values()) {
      if (q.id === this.id) continue;
      const p = a.players.get(q.id);
      if (!p) { out.push(this._raw(q, false)); continue; }
      const o = this._raw(p, false);
      o.x = p.x + (q.x - p.x) * u;
      o.y = p.y + (q.y - p.y) * u;
      o.z = p.z + (q.z - p.z) * u;
      // ±πの折り返しで一周させない。差を畳んでから足す
      o.yaw = wrapPi(p.yaw + wrapPi(q.yaw - p.yaw) * u);
      o.pitch = p.pitch + (q.pitch - p.pitch) * u;
      // 生き死にや弾倉交換は途中の値に意味が無いので、近い側の物をそのまま使う
      const src = u < 0.5 ? p : q;
      o.state = src.state; o.hp = src.hp; o.weapon = src.weapon;
      out.push(o);
    }
    return out;
  }

  _raw(p, extrapolated) {
    return {
      id: p.id,
      x: p.x, y: p.y, z: p.z,
      yaw: p.yaw, pitch: p.pitch,
      state: p.state, hp: p.hp, weapon: p.weapon,
      extrapolated,
    };
  }
}
