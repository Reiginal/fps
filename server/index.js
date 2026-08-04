// 接続の受け口。WebSocketと静的配信を同じポートで受ける。
//
// 配信を分けないのは、対戦する時に相手へ渡すURLを1本にしたいから。
// 「まずこっちのサーバーを立てて、次にあっちも立てて」は必ず片方を忘れる。
//
// この層の役目は「壊れた電文で試合を止めないこと」に尽きる。
// 1人が変な物を送っただけで例外が上がると、そのプロセスの全員の試合が終わる。
// なので受け取った値は全部その場で範囲を検査して、駄目なら黙って捨てる。
import './dom-stub.js';
import { createServer } from 'node:http';
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
import { accessSync, constants } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { WebSocketServer } from 'ws';
import { buildWorld } from './world.js';
import { getRoom, roomList } from './room.js';
import { WEAPONS, weaponsSource } from './sim.js';
import {
  C, Sv, decode, encode, normalizeRoom, TIMEOUT_MS,
} from '../src/net/protocol.js';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = fileURLToPath(new URL('../', import.meta.url));

// 押しているキーは11ビットしか定義がない。それ以外のビットは捨てる。
// protocol.jsのKを増やしたらここも広げること。忘れると増やしたキーだけ
// サーバーに届かず、手元では効いているのにサーバーでは押していない状態になる
const KEY_MASK = 0x7ff;
// 1つの電文に詰めてよい入力の数。INPUT_BATCHは3だが、
// 取りこぼしの詰め直しで増えることがあるので余裕を持たせる
const MAX_FRAMES = 32;
// 1秒あたりに許す電文の数。これを超えるのは実装事故か嫌がらせのどちらか
const MSG_PER_SEC = 600;
const PING_EVERY_MS = 2000;

/* -------------------------------------------------------- 静的配信 */

// ゲーム本体の配信はここ1箇所だけが持つ。
// 以前は静的配信だけを行うserve.mjsが別にあって、同じ処理をこちらへ写していた。
// 「片方を直したらもう片方も直すこと」と注意書きを添える形は必ず片方を忘れるので、
// 起動口をこのファイル1本に寄せて写しごと消した
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

async function serveStatic(req, res) {
  try {
    const url = decodeURIComponent(req.url.split('?')[0]);
    // 部屋の一覧だけは覗けるようにしておく。誰がどこに居るか分からないと合言葉を配れない
    if (url === '/rooms') {
      res.writeHead(200, { 'content-type': TYPES['.json'] }).end(JSON.stringify(roomList()));
      return;
    }
    // ルート外へ抜けるパスは弾く
    const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
    const path = join(ROOT, rel);
    if (!path.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(path);
    if (info.isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

/* ------------------------------------------------------ 値の検査 */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 角度は無限に回るので、履歴の補間が壊れない範囲へ畳んでおく
function wrapAngle(v) {
  if (!isNum(v)) return 0;
  let a = v % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// [x,y,z]の配列を検査してoutへ。1つでも駄目ならfalse
function readVec3(a, out, limit) {
  if (!Array.isArray(a) || a.length < 3) return false;
  if (!isNum(a[0]) || !isNum(a[1]) || !isNum(a[2])) return false;
  if (Math.abs(a[0]) > limit || Math.abs(a[1]) > limit || Math.abs(a[2]) > limit) return false;
  out.set(a[0], a[1], a[2]);
  return true;
}

/* -------------------------------------------------------- 接続1本 */

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.slot = null;
    this.room = null;
    this.rtt = 0;
    this.lastMsgAt = Date.now();
    this.pingId = 0;
    this.pingSentAt = 0;
    this.msgCount = 0;
    this.msgWindowAt = Date.now();
  }

  send(msg) {
    if (this.ws.readyState !== 1) return;
    try {
      this.ws.send(encode(msg));
    } catch {
      // 送れないのは相手が消えた時。次のタイムアウトで片付くので握り潰す
    }
  }

  close(why) {
    try { this.ws.close(1000, why || ''); } catch { /* 既に閉じている */ }
  }
}

/* ---------------------------------------------------------- 起動 */

const world = buildWorld();

const server = createServer((req, res) => { serveStatic(req, res); });
// maxPayloadで巨大な電文そのものを入口で切る。中身を検査する前に記憶を食われては意味がない
const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

const conns = new Set();
// 1発ごとにベクトルを作ると毎秒数百個のごみになるので使い回す
const _o = new THREE.Vector3();
const _d = new THREE.Vector3();

wss.on('connection', (ws) => {
  const conn = new Conn(ws);
  conns.add(conn);

  ws.on('message', (raw) => {
    try {
      onMessage(conn, raw);
    } catch (e) {
      // 1人の電文で全員の試合を落とさない。捨てて次を待つ
      console.warn(`[net] 電文の処理で例外: ${e && e.message}`);
    }
  });
  ws.on('error', () => { /* 切断の副産物。closeで片付く */ });
  ws.on('close', () => {
    conns.delete(conn);
    if (conn.slot && conn.room) conn.room.leave(conn.slot);
    conn.slot = null;
    conn.room = null;
  });
});

function onMessage(conn, raw) {
  const now = Date.now();
  conn.lastMsgAt = now;

  // 流量の見張り。窓を1秒で切って数える
  if (now - conn.msgWindowAt >= 1000) {
    conn.msgWindowAt = now;
    conn.msgCount = 0;
  }
  if (++conn.msgCount > MSG_PER_SEC) {
    conn.close('flood');
    return;
  }

  const m = decode(raw);
  if (!m) return;   // 壊れたJSONはdecodeがnullを返す

  switch (m.t) {
    case C.JOIN: return onJoin(conn, m);
    case C.INPUT: return onInput(conn, m);
    case C.SHOT: return onShot(conn, m);
    case C.THROW: return onThrow(conn, m);
    case C.WEAPON: return onWeapon(conn, m);
    case C.PONG: return onPong(conn, m);
    case C.CHAT: return;   // protocol側にサーバー→クライアントのCHATが無いので今は捨てる
    default: return;
  }
}

function onJoin(conn, m) {
  if (conn.slot) return;   // 二重参加は無視

  // 名前から制御文字を剥がす。他人の端末に表示される文字列なので、
  // 端末の表示を壊す文字や改行を混ぜられないようにする
  const name = typeof m.name === 'string'
    // eslint-disable-next-line no-control-regex -- 制御文字を消すのが目的の正規表現
    ? m.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) || '名無し'
    : '名無し';
  const code = normalizeRoom(m.room) || 'MAIN';

  const room = getRoom(code, world);
  const slot = room.join(conn, name);
  if (!slot) {
    conn.send({ t: Sv.FULL, why: 'この部屋は満員' });
    conn.close('full');
    return;
  }
  conn.slot = slot;
  conn.room = room;
  conn.send(room.welcome(slot));
  console.log(`[net] ${name} が ${code} に入った (${room.slots.size}人)`);
}

function onInput(conn, m) {
  const slot = conn.slot;
  if (!slot) return;
  if (!isNum(m.s)) return;
  const head = Math.round(m.s);
  if (head < 0 || head > 1e9) return;
  if (!Array.isArray(m.f) || m.f.length === 0) return;

  // 上限を超えた分は先頭側を捨てる。後ろ側を捨てると、
  // 本人が今やりたい操作が丸ごと消えた上に、捨てたseqが欠番として残る
  const skip = Math.max(0, m.f.length - MAX_FRAMES);
  const frames = [];
  for (let i = skip; i < m.f.length; i++) {
    const f = m.f[i];
    if (!Array.isArray(f) || f.length < 3) return;
    if (!isNum(f[0]) || !isNum(f[1]) || !isNum(f[2])) return;
    frames.push([
      Math.round(f[0]) & KEY_MASK,
      wrapAngle(f[1]),
      clamp(f[2], -1.5, 1.5),
    ]);
  }
  conn.room.input(slot, head + skip, frames);
}

function onShot(conn, m) {
  const slot = conn.slot;
  if (!slot) return;
  // 場外や無限遠から撃たれないよう、まず数として成立しているかを見る
  if (!readVec3(m.o, _o, 1e4)) return;
  if (!readVec3(m.d, _d, 1e4)) return;
  const len = _d.length();
  if (len < 1e-6) return;
  _d.divideScalar(len);

  const seq = isNum(m.s) ? Math.round(m.s) : -1;
  conn.room.shot(slot, seq, _o, _d);
}

// 投擲。撃つのと同じで、受け取るのは向きだけ。位置はサーバーが本人の目から作る
function onThrow(conn, m) {
  const slot = conn.slot;
  if (!slot) return;
  if (!readVec3(m.o, _o, 1e4)) return;
  if (!readVec3(m.d, _d, 1e4)) return;
  const len = _d.length();
  if (len < 1e-6) return;
  _d.divideScalar(len);
  conn.room.throwNade(slot, _o, _d);
}

function onWeapon(conn, m) {
  const slot = conn.slot;
  if (!slot || !isNum(m.i)) return;
  conn.room.weapon(slot, Math.round(m.i));
}

function onPong(conn, m) {
  if (!isNum(m.id) || m.id !== conn.pingId) return;
  const rtt = Date.now() - conn.pingSentAt;
  if (rtt < 0 || rtt > 10000) return;
  // 1回の飛び値で巻き戻し量が跳ねないようになましてから使う
  conn.rtt = conn.rtt === 0 ? rtt : conn.rtt * 0.7 + rtt * 0.3;
}

/* ------------------------------------------- 生存確認と往復遅延 */

setInterval(() => {
  const now = Date.now();
  for (const conn of conns) {
    if (now - conn.lastMsgAt > TIMEOUT_MS) {
      conn.close('timeout');
      try { conn.ws.terminate(); } catch { /* 既に死んでいる */ }
      continue;
    }
    conn.pingId = (conn.pingId + 1) & 0xffff;
    conn.pingSentAt = now;
    conn.send({ t: Sv.PING, id: conn.pingId });
  }
}, PING_EVERY_MS);

/* ------------------------------------------------ 自分のLANアドレス */

// 相手に渡すURLを組むための、このマシンのLAN側アドレス。
//
// os.networkInterfaces()から「内部でない最初のIPv4」を拾う書き方は当てにならない。
// VPNやThunderbolt Bridge、Docker、仮想NICが同じ条件で何本も並んでいて、
// 実際にWi-Fiで通じるのとは違うアドレスを先に掴むことがある（このマシンだと4本ある）。
//
// なので経路表に聞く。UDPのconnectはパケットを1つも送らず、
// 「この宛先へ出すならどのインターフェースを使うか」だけを解決するので、
// 既定の経路に紐づいたアドレスがそのまま出てくる。
// 相手が同じWi-Fiにいる限り、これが渡すべきアドレスになる
function lanAddress() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let sock;
    try {
      sock = createSocket('udp4');
    } catch { finish(fallbackAddress()); return; }
    sock.on('error', () => { try { sock.close(); } catch { /* 既に閉じている */ } finish(fallbackAddress()); });
    // 経路が無い（機内モード等）と応答が返らないことがあるので、待ち続けない
    const timer = setTimeout(() => { try { sock.close(); } catch { /* 同上 */ } finish(fallbackAddress()); }, 300);
    try {
      sock.connect(53, '8.8.8.8', () => {
        clearTimeout(timer);
        let addr = null;
        try { addr = sock.address().address; } catch { /* 取れなければ退避側へ */ }
        try { sock.close(); } catch { /* 同上 */ }
        finish(addr || fallbackAddress());
      });
    } catch {
      clearTimeout(timer);
      finish(fallbackAddress());
    }
  });
}

// cloudflaredが入っているか。入っていない人に入っている前提の案内を出すと、
// 打った瞬間に command not found で行き止まりになる
function hasCloudflared() {
  for (const dir of (process.env.PATH || '').split(':')) {
    if (!dir) continue;
    try {
      accessSync(join(dir, 'cloudflared'), constants.X_OK);
      return true;
    } catch { /* この場所には無い */ }
  }
  return false;
}

// 経路表に聞けなかった時の当て推量。169.254(自動割り当て)と内部向けだけは除く
function fallbackAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const n of list || []) {
      if (n.internal) continue;
      if (n.family !== 'IPv4' && n.family !== 4) continue;
      if (n.address.startsWith('169.254.')) continue;
      return n.address;
    }
  }
  return null;
}

/* --------------------------------------------------- 最後の砦 */

// ここまでで拾いきれなかった例外でプロセスが落ちると、全部屋の試合が同時に終わる。
// 落とすより、その電文を諦めて走り続ける方が被害が小さい
process.on('uncaughtException', (e) => {
  // 待ち受けの失敗だけは握り潰さずに落ちる。
  // 何も待ち受けていないプロセスが生き残ると、起動した本人には
  // 「起動したのに繋がらない」としか見えない上に、ターミナルも占領される。
  // server.on('error')でも拾えるはずだがそちらへは届かなかったので、
  // 実際に届くこの入口で見る
  if (e && (e.code === 'EADDRINUSE' || e.syscall === 'listen')) {
    if (e.code === 'EADDRINUSE') {
      console.error(`\n  ポート${PORT}は既に使われている。`);
      console.error('  別のBLACKOUTが動いていないか確認するか、ポートを変えて起動する:');
      console.error(`    lsof -nP -iTCP:${PORT} -sTCP:LISTEN     # 誰が使っているか`);
      console.error(`    PORT=8081 npm start                     # 別のポートで立てる\n`);
    } else {
      console.error('\n  待ち受けに失敗した:', e.message, '\n');
    }
    process.exit(1);
  }
  console.error('[fatal] 拾い損ねた例外:', e && e.stack);
});
process.on('unhandledRejection', (e) => {
  console.error('[fatal] 拾い損ねた失敗:', e);
});

server.listen(PORT, async () => {
  // 武器の出どころは必ず出す。退避表で走っていることに気づかないまま
  // 「ダメージが本番と違う」を追いかけるのが一番時間を溶かす
  console.log(`[sim] 武器の表: ${weaponsSource}（${WEAPONS.map((w) => w.id).join(', ')}）`);

  const lan = await lanAddress();
  console.log('\n  BLACKOUT');
  console.log(`\n  自分用            http://localhost:${PORT}`);

  // 「相手に渡すURL」とだけ書くと、Wi-Fiが違う相手にもこれで届くように読める。
  // 届かないので、渡し先の条件を見出しそのものに入れる
  if (lan) {
    console.log(`  同じWi-Fiの相手   http://${lan}:${PORT}`);
  } else {
    console.log('  同じWi-Fiの相手   （LAN側アドレスが取れなかった。ネットワークに繋がっていない）');
  }

  console.log('\n  Wi-Fiが違う相手に渡すURLは、別のターミナルでこれを打つと出る:');
  console.log(`    ${hasCloudflared() ? '' : 'brew install cloudflared     # 初回のみ\n    '}`
    + `cloudflared tunnel --url http://localhost:${PORT}`);
  console.log('    出てきた https://〜.trycloudflare.com をそのまま送る\n');
  console.log('  どちらの渡し方でも、相手は接続先を書き換えなくていい。名前を入れて押すだけ。\n');
});
