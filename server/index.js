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
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { WebSocketServer } from 'ws';
import { buildWorld } from './world.js';
import { getRoom } from './room.js';
import { publicPath } from './serve-rules.js';
import {
  ReportLimiter, reportLine, reportRecord, REPORT_BODY_MAX, stripControl,
} from './report.js';
import { logs, canViewLogs, isLocal, renderPage } from './logs.js';
import { WEAPONS, weaponsSource } from './sim.js';
import * as db from './db.js';
import * as auth from './auth.js';
import { addCoins, getCoins, coinsFor } from './wallet.js';
import { sendVerifyMail } from './mail.js';
import {
  C, Sv, decode, encode, TIMEOUT_MS, CHAT_MAX, CHAT_GAP_MS,
} from '../src/net/protocol.js';

const PORT = Number(process.env.PORT) || 8080;
const ROOT = fileURLToPath(new URL('../', import.meta.url));
// 起動した時刻。ログの一覧に「起動から何分」を出すのに使う。
// ログは記憶の中にしか無いので、この時刻より前の物はどこにも残っていない
const BOOT_AT = Date.now();

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
// 配ってよいURLかの判定は serve-rules.js が持つ。
// このファイルは読み込むとサーバーが起動するので、判定をここに書くと
// 「絞ったつもり」を試す方法が無くなる（tools/check-serve.mjs が向こうを叩く）

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
    // 死活監視の受け口。置き場所によっては定期的にここを叩いて、
    // 返らなくなったら落ちたとみなして入れ替える。
    // 地形を組み終わってからlistenする作りなので、返った時点で遊べる状態
    if (url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('ok');
      return;
    }

    /* 遊ぶ人の画面で起きた例外を受け取る口。
       ここがこのサーバーで初めての「読む以外のHTTPの口」になる。

       なぜ要るか: Windowsの人に遊んでもらった時、こちらには何の情報も無く、
       何回試してもらっても推測しか増えなかった。画面に出すだけでは
       本人が読み上げてくれない限り届かないので、こちらへ送らせる。

       受け取った物は flyctl logs へ出したうえで、logs.js の表にも積む。
       流れて消える物だけだと、後から見に行けない */
    if (url === '/report') {
      if (req.method !== 'POST') { res.writeHead(405).end('post only'); return; }
      await handleReport(req, res);
      return;
    }

    /* 溜めた出来事を読む口。ブラウザで開いて読む。
       鍵(LOG_KEY)を入れていない間は手元からしか見えない（logs.jsのcanViewLogs）。
       本番で見たい時は flyctl secrets set LOG_KEY=... を1度打つ。
       見えない時に404を返すのは、口の存在そのものを外へ出さないため */
    if (url === '/logs') {
      const key = String(process.env.LOG_KEY || '');
      const given = new URL(req.url, 'http://x').searchParams.get('k') || '';
      if (!canViewLogs({ key, given, local: isLocal(req) })) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(renderPage(logs.recent(), Date.now(), BOOT_AT));
      return;
    }
    // 部屋の一覧を返す口は閉じてある。合言葉で部屋を分けていた頃、
    // ここが誰でも叩けて全部屋の合言葉と人数が取れていた。
    // 今は部屋が1つなので隠す物も無いが、外に増やす口を作らない方針は変えない

    /* 会員証の口。**台帳(DATABASE_URL)が無ければ、書き込む口は無かったことにする。**
       「有るけど使えない」より「無い」の方が、外から見て手掛かりが減る。

       **ただし /api/me だけは、台帳が無くても200で「ここには無い」と答える。**
       ここも404にしていたら、台帳を置いていない本番で
       **遊ぶ人全員のコンソールに毎回404が1件出た**（e2eが止めた）。
       毎回出るエラーは、本当のエラーがそこに紛れて読めなくなるので害が大きい。
       しかも/api/meは隠す中身が何も無い（ログインの画面は誰にでも見える）ので、
       404にして得られる物が最初から無かった */
    if (url.startsWith('/api/')) {
      if (!accountsOn && url !== '/api/me') { res.writeHead(404).end('not found'); return; }
      await handleApi(url, req, res);
      return;
    }

    // 配ってよい物か。ここを通らない物は、存在していても無いものとして返す
    const rel = publicPath(req.url);
    if (!rel) {
      res.writeHead(404).end('not found');
      return;
    }
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

/* -------------------------------------------- 遊ぶ人の画面のエラーを受ける */

// 長さ・制御文字・連投の判定は server/report.js が持つ。
// ここは受け取って渡してログに出すだけ（判定を検査から叩けるようにするため）
const reportLimit = new ReportLimiter();

async function handleReport(req, res) {
  // 送り元は「誰か」ではなく「連投を止める鍵」としてだけ使う。
  // Fly経由だと本当の送り元はヘッダに入るが、無くても困らない
  const from = String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '?');

  let body = '';
  for await (const chunk of req) {
    body += chunk;
    // 中身を読む前に、入口で切る
    if (body.length > REPORT_BODY_MAX) { res.writeHead(413).end('too big'); return; }
  }

  const rec = reportRecord(body);
  if (!rec) { res.writeHead(400).end('bad'); return; }
  /* 連投止めの鍵は「送り元」だけでなく「送り元＋種類」。
     1人プレイで力尽きた瞬間、クライアントは「力尽きた(solo)」と
     「描画の重さ(perf)」を続けて2発送る。鍵が送り元だけだと2発目が
     毎回429で捨てられて、**重さの実測が1本も届かなかった**
     （「めっちゃ重い」と言われた日に、数字が何も無かったのはこれ）。
     種類ごとに分ければ、毎フレーム出る例外の洪水は今まで通り止まる */
  if (!reportLimit.allow(`${from}|${rec.kind}`, Date.now())) { res.writeHead(429).end('too fast'); return; }
  // 流れる方と、後から読める方の両方へ出す。
  // console.warnは`flyctl logs`で今しか見られないので、表にも積む
  console.warn(reportLine(body));
  logs.add(rec.kind, {
    name: rec.name, message: rec.message, where: rec.where, ua: rec.ua,
    wave: rec.wave, kills: rec.kills, score: rec.score,
    fps: rec.fps, low: rec.low, players: rec.players,
    /* 切り分け用の数字と1分ごとの列。**ここに並べないと表に出ない。**
       reportRecordで受けていたのに、ここへ書き忘れていてcalls/tris/scale/rungが
       表から落ちていた（perf自体が届かないバグの陰で気づけなかった。2026-08-08） */
    calls: rec.calls, tris: rec.tris, scale: rec.scale, rung: rec.rung,
    cap: rec.cap, fpsMins: rec.fpsMins, lowMins: rec.lowMins,
    /* メモリ。ここへ並べ忘れると、受けていても表に出ない
       （calls/tris/scale/rungが実際にそれで落ちていた。同じ轍を踏まないよう
       tools/check-perf-report.mjs の[5]がこの並びを見張っている） */
    mem: rec.mem, memMax: rec.memMax, memLimit: rec.memLimit, memPct: rec.memPct,
    geo: rec.geo, tex: rec.tex, memMins: rec.memMins, objMins: rec.objMins,
  });
  res.writeHead(204).end();
}

/* ---------------------------------------------------------- 会員証 */

// 判定は全部 server/auth.js が持つ（server/index.js は読み込むと起動するので、
// 判定をここに書くと検査から叩けない。serve-rules.js / report.js と同じ）。
// ここがやるのは「受け取る・呼ぶ・返す」だけ。

/* 会員証が本当に使えるか。**DATABASE_URLがあるだけでは足りない。**
   台帳に繋げなかった時にここがtrueのままだと、
   ログインの画面は出るのに押すたびに500が返る（一番たちが悪い形）。
   起動時に表を作り終えて初めてtrueになる */
let accountsOn = false;

// 送られてくる本文の上限。メアドとパスワードと名前しか来ないので小さくてよい
const AUTH_BODY_MAX = 2 * 1024;
/* 総当たりの見張り。**ログインだけ厳しくする。**
   2回/秒まで落とせば、8文字のパスワードを総当たりするのに何万年もかかる。
   同じ家から2人が同時に入る時に1回待たされるが、429の文言で分かるようにしてある */
const loginLimit = new ReportLimiter(500);
// 入会はもっと遅くていい。連続で作られると台帳がゴミで埋まる
const registerLimit = new ReportLimiter(5000);
// 「今誰か」を聞くのは画面を開くたびなので緩く。それでも叩き放題にはしない
const meLimit = new ReportLimiter(200);

/* Flyの向こうにいる時、本当の送り元と本当の道筋はヘッダに入る。
   secure を取り違えると、httpsなのにCookieにSecureが付かない（危ない）か、
   手元(http)なのにSecureが付いてCookieが1つも保存されない（ログインできない）*/
const clientIp = (req) => String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '?');
const isHttps = (req) => String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

const sendJson = (res, code, obj, extra) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra });
  res.end(JSON.stringify(obj));
};

/** 本文をJSONとして読む。壊れていたらnull（呼ぶ側が400を返す） */
async function readJson(req, res) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > AUTH_BODY_MAX) { res.writeHead(413).end('too big'); return undefined; }
  }
  try {
    const o = JSON.parse(body || '{}');
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null;
  } catch { return null; }
}

/* 他所のページから勝手に叩かれていないか。
   CookieのSameSite=Laxでほぼ防げているが、**入口でも一応見る。**
   Originが付いていない古い相手は通す（付けてくる相手だけ突き合わせる） */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === String(req.headers.host || ''); } catch { return false; }
}

/* 台帳が一瞬落ちても、返すのは500の1件だけにする。
   投げっぱなしにすると serveStatic の catch が404を返しにいって、
   **既にヘッダを送った後だともう一度投げる**（そこは誰も拾わない） */
async function handleApi(url, req, res) {
  try {
    await routeApi(url, req, res);
  } catch (e) {
    console.warn(`[auth] ${url} で例外: ${e && e.message}`);
    logs.add('error', { message: e && e.message, where: url });
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: '今うまくいきませんでした。少し待ってからもう一度' });
  }
}

async function routeApi(url, req, res) {
  const ip = clientIp(req);
  const secure = isHttps(req);
  const token = auth.readCookie(req.headers.cookie);

  if (url === '/api/me') {
    if (req.method !== 'GET') { res.writeHead(405).end('get only'); return; }
    /* 台帳を置いていない置き場。**エラーではなく「無い」と答える。**
       遊ぶ側はこれを見て、ログインの行そのものを画面に出さない */
    if (!accountsOn) { sendJson(res, 200, { ok: true, accounts: false, user: null }); return; }
    if (!meLimit.allow(`me|${ip}`, Date.now())) { sendJson(res, 429, { ok: false, error: '少し待ってください' }); return; }
    const me = await auth.sessionUser(db.query, token);
    // 残高も一緒に返す。別の口にすると、画面を開くたびに往復が2回になる
    if (me) me.coins = await getCoins(db.query, me.id);
    sendJson(res, 200, { ok: true, accounts: true, user: me });
    return;
  }

  if (url === '/api/verify') {
    if (req.method !== 'GET') { res.writeHead(405).end('get only'); return; }
    const t = new URL(req.url, 'http://x').searchParams.get('t') || '';
    const user = await auth.verifyEmail(db.query, t);
    /* **踏んだ人はブラウザで見ている。**JSONを返すと生の中括弧が画面に出る。
       ホームへ戻す。合言葉が古い時も同じ所へ戻して、印だけ変える */
    res.writeHead(303, { location: user ? '/?verified=1' : '/?verified=0' }).end();
    if (user) logs.add('auth', { message: 'メールを確認した', name: user.name });
    return;
  }

  // ここから下は全部POST
  if (req.method !== 'POST') { res.writeHead(405).end('post only'); return; }
  if (!sameOrigin(req)) { res.writeHead(403).end('forbidden'); return; }

  if (url === '/api/logout') {
    await auth.logout(db.query, token);
    sendJson(res, 200, { ok: true, user: null }, { 'set-cookie': auth.clearCookieHeader({ secure }) });
    return;
  }

  if (url === '/api/register') {
    if (!registerLimit.allow(`reg|${ip}`, Date.now())) {
      sendJson(res, 429, { ok: false, error: '続けて登録はできません。少し待ってください' });
      return;
    }
    const body = await readJson(req, res);
    if (body === undefined) return;
    if (!body) { sendJson(res, 400, { ok: false, error: '送られた中身が読めません' }); return; }

    const r = await auth.register(db.query, body);
    if (!r.ok) { sendJson(res, 400, r); return; }
    /* **メールが送れなくても登録は成功のまま返す。**
       ここで失敗にすると、台帳には会員が居るのに画面には「登録できませんでした」と出て、
       もう一度登録しても「登録済みです」で詰む */
    await sendVerifyMail(r.user.email, r.emailToken);
    // 入会したらそのままログイン状態にする。登録の直後にもう一度
    // メアドとパスワードを打たせる理由が無い
    const s = await auth.login(db.query, { email: body.email, password: body.password });
    logs.add('auth', { message: '入会した', name: r.user.name });
    sendJson(res, 200, { ok: true, user: r.user },
      s.ok ? { 'set-cookie': auth.cookieHeader(s.token, { secure }) } : undefined);
    return;
  }

  if (url === '/api/login') {
    if (!loginLimit.allow(`log|${ip}`, Date.now())) {
      sendJson(res, 429, { ok: false, error: '続けて試しすぎです。少し待ってください' });
      return;
    }
    const body = await readJson(req, res);
    if (body === undefined) return;
    if (!body) { sendJson(res, 400, { ok: false, error: '送られた中身が読めません' }); return; }

    const r = await auth.login(db.query, body);
    // 401は「合っていない」。中身は言い分けない（auth.jsの説明の通り）
    if (!r.ok) { sendJson(res, 401, r); return; }
    logs.add('auth', { message: 'ログインした', name: r.user.name });
    sendJson(res, 200, { ok: true, user: r.user }, { 'set-cookie': auth.cookieHeader(r.token, { secure }) });
    return;
  }

  res.writeHead(404).end('not found');
}

/* ------------------------------------------------------------ 財布 */

/**
 * 試合が終わった時にコインを配る。部屋(server/room.js)から呼ばれる。
 *
 * **ログインしている人にだけ配る。** 配る先が無いので当然だが、
 * 遊ぶ側には「貯まらない」が分かるようにしてある（ホームの行にログイン状態が出る）。
 * CPUは conn.user を持たないので、ここで勝手に外れる。
 *
 * **1人ずつ別々に書く。** まとめて1つの取引にすると、
 * 誰か1人の書き込みで詰まった時に全員が待つ。
 * コインは1人ずつ独立しているので、まとめる理由が無い。
 *
 * @returns Map<slot, {got, coins}>。台帳が無ければ null（部屋は枚数を載せずに配る）
 */
async function payMatch(slots) {
  if (!accountsOn) return null;
  // 1位の判定に使う。**誰も取っていない試合(0-0の時間切れ)では全員に付けない**
  let top = 0;
  for (const s of slots.values()) if ((s.rounds | 0) > top) top = s.rounds | 0;

  const paid = new Map();
  for (const s of slots.values()) {
    const user = s.conn?.user;
    if (!user) continue;
    const got = coinsFor({ kills: s.sim?.kills, rounds: s.rounds }, top);
    try {
      // 1人ずつ順に書く。まとめて1つの取引にすると、誰か1人で詰まった時に全員が待つ
      const coins = await addCoins(db.query, user.id, got);
      paid.set(s, { got, coins });
    } catch (e) {
      // その人だけ配れなかった。試合の終わりそのものは止めない
      console.warn(`[wallet] ${s.name} に配れなかった: ${e && e.message}`);
    }
  }
  if (paid.size) {
    logs.add('coin', {
      message: [...paid.values()].map((p) => `+${p.got}`).join(' '),
      count: paid.size,
    });
  }
  return paid;
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
    /* 会員かどうかを調べている最中の約束。**繋いだ時点で調べ始める。**
       台帳が寝ていると起きるのに数百ミリ秒かかるので、
       JOINが来てから調べ始めると、そのぶん入場が遅れる。
       ログインしていない人・台帳が無い時は null に解決する */
    this.userReady = Promise.resolve(null);
    this.user = null;
    this.joining = false;
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

/* **WebSocketの最初の一回は普通のHTTPリクエスト。**
   だからブラウザはそこにCookieを勝手に付けてくる。
   会員かどうかはここで読むだけで分かり、遊ぶ側は何も送らなくていい。

   前は名前が自己申告で、送られた文字列をそのまま信じていた
   （src/net/client.jsのJOIN）。ログインしている人はここで分かるので、
   onJoinが名前を上書きする＝**名乗りのなりすましが消える** */
wss.on('connection', (ws, req) => {
  const conn = new Conn(ws);
  conns.add(conn);

  if (accountsOn) {
    const token = auth.readCookie(req?.headers?.cookie);
    if (token) {
      // 台帳が落ちていても対戦は続くべきなので、失敗は「ログインしていない」に倒す
      conn.userReady = auth.sessionUser(db.query, token).catch((e) => {
        console.warn('[auth] 札を読めなかった:', e.message);
        return null;
      });
    }
  }

  ws.on('message', (raw) => {
    try {
      onMessage(conn, raw);
    } catch (e) {
      // 1人の電文で全員の試合を落とさない。捨てて次を待つ。
      // ここは黙って捨てる道なので、残しておかないと起きたことすら分からない
      console.warn(`[net] 電文の処理で例外: ${e && e.message}`);
      logs.add('net', { message: e && e.message, who: conn.slot?.name });
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
    /* JOINだけ待ちが入る（会員かどうかを台帳へ聞く）。
       **上のtry/catchは約束の中の失敗を拾えないので、onJoinが自分で拾う。**
       並びは他の受け口と同じ形に揃えてある（tools/check-protocol.mjs が
       この形で受け口を数えているので、崩すと受け口が1本消えたことになる） */
    case C.JOIN: return onJoin(conn, m);
    case C.INPUT: return onInput(conn, m);
    case C.SHOT: return onShot(conn, m);
    case C.THROW: return onThrow(conn, m);
    case C.WEAPON: return onWeapon(conn, m);
    case C.MODE: return onMode(conn, m);
    case C.SEAT: return onSeat(conn, m);
    case C.BOT: return onBot(conn, m);
    case C.READY: return onReady(conn, m);
    case C.CHAR: return onChar(conn, m);
    case C.PONG: return onPong(conn, m);
    case C.CHAT: return onChat(conn, m);
    case C.VSIG: return onVoiceSignal(conn, m);
    default: return;
  }
}

async function onJoin(conn, m) {
  if (conn.slot) return;   // 二重参加は無視
  /* 会員かどうかを待っている間にもう1通JOINが来ると、両方が席を取りにいく。
     その時点ではまだ conn.slot が立っていないので、上の行では止まらない */
  if (conn.joining) return;
  conn.joining = true;

  // 名前から制御文字を剥がす。他人の端末に表示される文字列なので、
  // 端末の表示を壊す文字や改行を混ぜられないようにする
  let name = typeof m.name === 'string'
    // eslint-disable-next-line no-control-regex -- 制御文字を消すのが目的の正規表現
    ? m.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 16) || '名無し'
    : '名無し';
  /* **ログインしている人の名前は、送られた物ではなく台帳の物を使う。**
     会員証を作った一番わかりやすい見返りがここで、
     「他人の名前を名乗って入る」が成立しなくなる。

     **失敗はここで拾いきる。** onMessage の try/catch は
     この関数が返した約束の中の失敗を拾えないので、外へ出すと誰も受けない */
  try {
    conn.user = await conn.userReady;
  } catch (e) {
    console.warn(`[auth] 札を読めなかった: ${e && e.message}`);
    conn.user = null;
  }
  if (conn.user) name = conn.user.name;

  // 待っている間に切れていることがある。席を取る前に確かめる
  if (conn.ws.readyState !== 1) { conn.joining = false; return; }

  /* ここから先も、待った後なので**失敗が外へ出ても誰も受けない。**
     1人の入場でプロセスごと落とさないよう、この関数の中で拾いきる */
  try {
    // 前に入った時の合言葉。回線が切れて入り直した時、これが合えば
    // 席・点数・ラウンド数が返る。文字でなければ黙って無視する
    const token = typeof m.tk === 'string' ? m.tk.slice(0, 64) : null;
    // 部屋はサーバーに1つだけ。繋いだ人は全員そこへ入る
    const room = getRoom(world);
    // コインを配る係を差し込む。部屋は台帳を知らないので、外から入れる
    room.onMatchEnd = payMatch;
    const slot = room.join(conn, name, token);
    if (!slot) {
      conn.send({ t: Sv.FULL, why: 'この部屋は満員' });
      conn.close('full');
      return;
    }
    conn.slot = slot;
    conn.room = room;
    conn.send(room.welcome(slot));
    // ロビーはお迎えの後で配る。順番が逆だと、入ってきた本人の画面は
    // まだ受け口を繋いでいないので、先にいた人が誰も映らないまま始まる
    room.sendLobby();
    // 復帰かどうかをログに残す。「切れた人が戻れているのか」は
    // 遊んでいる本人に聞いても「なんか切れた」しか返ってこないので、ここでしか分からない
    console.log(`[net] ${name} が${slot.back ? '戻ってきた' : '入った'} (${room.slots.size}人)`);
    logs.add('join', { name, count: room.slots.size, back: slot.back || undefined });
  } catch (e) {
    console.warn(`[net] 入場で例外: ${e && e.message}`);
    logs.add('net', { message: e && e.message, who: name });
    conn.joining = false;
  }
}

/* 声の合図を相手へ渡すだけ。**中身(m.d)は読まない。**
   読むと、そこが壊れた電文を食わせる入口になる。
   誰へ渡してよいかはRoomが決める（同じ声の輪にいる相手だけ） */
function onVoiceSignal(conn, m) {
  const slot = conn.slot;
  if (!slot || !isNum(m.to)) return;
  conn.room.signal(slot, Math.round(m.to), m.d);
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
    // 壊れた1本が出た所で打ち切る（続きを見ない）。
    // 配列の並び=連番のseqという前提なので、途中を抜いて後ろを詰めると
    // それより後ろのフレームが全部1つずつ違うseqとして届いてしまう。
    // 打ち切ってそこまでの分だけ使えば、位置と連番の対応はずれない
    if (!Array.isArray(f) || f.length < 3) break;
    if (!isNum(f[0]) || !isNum(f[1]) || !isNum(f[2])) break;
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
  // 手前投げの印。**どれだけ弱いかはこちらが決める**（強さを申告させない）
  conn.room.throwNade(slot, _o, _d, m.s === 1);
}

// 遊び方を選ぶ。誰が押しても変わるので、席に着いているかも見ない
function onMode(conn, m) {
  if (!conn.slot) return;
  if (typeof m.md !== 'string') return;
  conn.room.setMode(m.md);
}

function onWeapon(conn, m) {
  const slot = conn.slot;
  if (!slot || !isNum(m.i)) return;
  conn.room.weapon(slot, Math.round(m.i));
}

// ロビーで席に着く／降りる。範囲の検査だけしてroomへ渡す。
// 埋まっている席かどうかはroomが持っているので、ここでは見ない
function onSeat(conn, m) {
  const slot = conn.slot;
  if (!slot) return;
  // ここは長い間 m.tm（チーム番号）も必須にしていた。
  // チーム制をやめた時にクライアントは送るのをやめたが、こちらは要求したままで、
  // **席に着く要求が毎回ここで捨てられていた**（座れないので対戦が始まらない）。
  // 捨てる側は黙って捨てるので、遊ぶ側からは「押しても何も起きない」としか見えない。
  // tools/check-protocol.mjs が、送る側と受ける側の食い違いを見張る
  if (!isNum(m.st)) return;
  conn.room.takeSeat(slot, Math.round(m.st));
}

// 空席にCPUを座らせる／その席のCPUを立たせる。誰が押しても効く（席と同じ扱い）。
// 席の範囲も、人が座っている席かどうかもroomが見張っているので、ここは形だけ見る
function onBot(conn, m) {
  if (!conn.slot) return;
  if (!isNum(m.st)) return;
  conn.room.toggleBot(Math.round(m.st));
}

// 発言。人が読む文字列をそのまま他人の画面へ流すので、ここが一番危ない口になる。
//
// 3つやる:
//   1. 制御文字を剥がす（名前と同じ。改行や端末を壊す文字を混ぜられないように）
//   2. 長さで切る（長文で画面を埋められないように）
//   3. 連投を止める（電文の流量制限とは別。あちらは実装事故を止める数字で、
//      人が読む物を流す速さとしては速すぎる）
//
// HTMLとして解釈されないようにするのは受け取った側の仕事（hud.jsのescを通す）。
// ここで <> を消してしまうと、記号を打っただけの発言まで化ける
function onChat(conn, m) {
  const slot = conn.slot;
  if (!slot) return;
  if (typeof m.m !== 'string') return;

  const now = Date.now();
  if (now - (conn.lastChatAt || 0) < CHAT_GAP_MS) return;

  const text = stripControl(m.m).trim().slice(0, CHAT_MAX);
  if (!text) return;

  conn.lastChatAt = now;
  conn.room.chat(slot, text);
}

// 見た目を選ぶ。番号の範囲はroomが見ている
function onChar(conn, m) {
  const slot = conn.slot;
  if (!slot || !isNum(m.i)) return;
  conn.room.setChar(slot, Math.round(m.i));
}

// 準備完了の入り切り。席にいない人が押しても効かないのはroomが見ている
function onReady(conn, m) {
  const slot = conn.slot;
  if (!slot) return;
  conn.room.setReady(slot, !!m.r);
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

/* ------------------------------------------------------ 終了の合図 */

// クラウドへ置くと、更新のたびに終了の合図(SIGTERM)が飛んでくる。
// 受け取らずに落ちると、遊んでいる人は何の説明も無く切断される。
// 「回線が落ちた」のか「サーバーが死んだ」のか「更新中」なのかが
// 区別できないので、まず理由を配ってから閉じる
let closing = false;
function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`\n[shutdown] ${signal} を受けた。繋がっている人へ知らせてから閉じる`);
  const bye = JSON.stringify({ t: Sv.BYE, why: 'サーバーを更新しています。少ししてから入り直してください' });
  for (const c of wss.clients) {
    try { c.send(bye); } catch { /* 既に切れている */ }
  }
  // 送り終わる間を置いてから閉じる。すぐ閉じると理由が届かない
  setTimeout(() => {
    for (const c of wss.clients) {
      try { c.close(1001, 'server shutdown'); } catch { /* 既に切れている */ }
    }
    // 台帳への線も畳む。畳まないとプロセスがいつまでも終わらない
    db.close().catch(() => {});
    server.close(() => process.exit(0));
    // 閉じ切らない接続が残っても、いつかは落ちる
    setTimeout(() => process.exit(0), 3000).unref();
  }, 250);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, async () => {
  // 武器の出どころは必ず出す。退避表で走っていることに気づかないまま
  // 「ダメージが本番と違う」を追いかけるのが一番時間を溶かす
  console.log(`[sim] 武器の表: ${weaponsSource}（${WEAPONS.map((w) => w.id).join(', ')}）`);
  // 起動の印を1件目に置く。ログは記憶の中にしか無いので、
  // デプロイのたびに全部消える。**その境目がどこかを表の上で分かるようにしておく**。
  // これが無いと「静かだ」なのか「さっき消えた」なのかが読めない
  logs.add('boot', { weapons: weaponsSource, port: PORT });

  /* 台帳を最新の形まで持っていく。**繋げなくても遊べる状態で続ける。**
     ここで投げると、DBが一瞬落ちているだけでゲームごと起動しなくなる。
     アカウントの口は/api/*が404になるだけで、対戦も1人プレイも今まで通り動く */
  if (db.isEnabled()) {
    try {
      await db.setup();
      accountsOn = true;
      console.log('  会員証            使える（DATABASE_URLあり）');
      /* 期限の切れた札を捨てる。放っておくとログインのたびに1行増えて二度と減らない。
         1時間ごとで足りる（30日の札なので、少し遅れても誰も困らない）。
         unref を付けてあるのは、この待ちがあるせいでプロセスが終われなくなるのを防ぐため */
      setInterval(() => {
        auth.sweepExpired(db.query).catch((e) => console.warn('[db] 掃除で失敗:', e.message));
      }, 3600_000).unref();
    } catch (e) {
      console.warn(`[db] 台帳に繋げなかった。アカウント機能は畳んで続ける: ${e.message}`);
      logs.add('error', { message: `台帳に繋げなかった: ${e.message}`, where: 'db.setup' });
    }
  } else {
    console.log('  会員証            使わない（DATABASE_URLが無い）');
  }

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
