// 出来事を溜める所と、それをブラウザで見せる所。
//
// なぜ要るか: console.log は駅のアナウンスと同じで、その場で流れて消える。
// 遠くで遊んでいる人の画面でエラーが出ても、こちらへは何も残らない。
// `flyctl logs` は「今流れている物」を聞きに行く道具なので、
// 30分前に起きたことはもう聞けない。
//
// 【この作りの弱点を先に書いておく】
// **記憶の中にしか置かない。デプロイすると全部消える。**
// 置き場所（ディスク）を作るなら Fly のボリュームが要るが、そこは今やらない。
// 想定している使い方が「遊ぶ→不具合が出る→その日のうちに見に行く→直す→出す」
// なので、直した後に前のログが残っていないのはむしろ都合がよい
// （直す前と後のログが混ざらない）。
//
// 【重くしないために決めてあること】
// 1. **ディスクを触らない。** サーバーは1秒に60回、全員の位置を計算して配っている。
//    その途中で書き込みを待つと、その瞬間だけ全員がカクつく。
//    記憶の中だけなら待ち時間が無い。
// 2. **毎フレーム起きる物は拾わない。** 4人で遊ぶと、位置の更新は毎秒240回、
//    発砲は毎秒43回起きる。1行100バイトとして1日で2GBと370MB。
//    拾ってよいのは「たまにしか起きない物」だけで、
//    入退場や試合の結果は毎秒0.07回（1日0.6KB）しかない。
//    **この2つの間には1万倍の差がある。** 線はその間に引く。
// 3. **上限を持つ。** 溜まり続ける物には必ず捨てる仕組みを付ける。
//    付け忘れると、いつか記憶を使い切ってサーバーが落ちる。
//    ログを取るために入れた仕組みがゲームを殺すのでは本末転倒。
//
// 【形について】
// 人が読む文章ではなく、項目に名前を付けた形で持つ。
//   ❌ "たろう: Cannot read ... @ main.js:1234"
//   ⭕ { kind:'error', name:'たろう', message:'Cannot read ...', where:'main.js:1234' }
// 文章で溜めると「たろうが何回エラーを出したか」を数える時に文字を切り貼りする
// ことになり、名前に : が入っているだけで壊れる。
// 後からファイルへ書くのも、データベースへ入れるのも、この形なら持っていける。

// 覚えておく件数。1試合あたり15件ほどなので、これで30試合ぶん。
// 1件200バイトとして100KB＝512MBのマシンの0.03%。
// ここを増やす時は「何試合ぶん見たいか」で決める（バイト数では決めない）
export const LOG_MAX = 500;
// 1つの項目の長さ。長い積み重ね(stack)をそのまま入れると、1件で画面が埋まる
export const TEXT_MAX = 200;

/**
 * 表に入れてよい形へ直す。
 * 制御文字を空白にするのは、改行が混ざると1件が複数行に化けて、
 * 他の行に紛れ込ませることができてしまうため（report.js と同じ理由）
 */
export function clean(v, max = TEXT_MAX) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  let out = '';
  for (const ch of String(v ?? '')) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || c === 0x7f) ? ' ' : ch;
    if (out.length >= max) break;
  }
  return out.trim();
}

export class Logs {
  constructor(max = LOG_MAX) {
    this.max = max;
    this._rows = [];
    // 通し番号。時刻だけだと、同じミリ秒に2件入った時に順番が読めない
    this._seq = 0;
  }

  /**
   * 1件足す。
   * 時刻を引数で渡せるようにしてあるのは、検査から時間を進められるようにするため
   * （Date.now()を中で呼ぶと、時刻に依存する検査が書けない）
   */
  add(kind, fields = {}, now = Date.now()) {
    const row = { n: ++this._seq, at: now, kind: clean(kind, 24) };
    for (const k of Object.keys(fields)) {
      const v = fields[k];
      if (v === undefined || v === null || v === '') continue;
      row[clean(k, 24)] = clean(v);
    }
    this._rows.push(row);
    // 上限を超えたら古い方から捨てる。ここが無いと際限なく太る
    while (this._rows.length > this.max) this._rows.shift();
    return row;
  }

  /** 溜まっている物。新しい順に返す（見に来た人が知りたいのは直近なので） */
  recent(limit = this.max, kind = '') {
    const out = [];
    for (let i = this._rows.length - 1; i >= 0 && out.length < limit; i--) {
      if (kind && this._rows[i].kind !== kind) continue;
      out.push(this._rows[i]);
    }
    return out;
  }

  get size() { return this._rows.length; }

  clear() { this._rows.length = 0; }
}

// サーバー全体で1つ。部屋も通信も同じ物へ入れる
export const logs = new Logs();

/**
 * /logs を見せてよいか。
 *
 * ログには遊んだ人の名前と、その人の環境（ブラウザや OS）が入る。
 * 公開URLなので、鍵をかけないと誰でも読めてしまう。
 *
 *   鍵(LOG_KEY)が設定してある … 合っている時だけ見せる
 *   設定していない            … 手元(loopback)からだけ見せる。本番では見えない
 *
 * 「設定しなければ本番では見えない」を既定にしてあるのは、
 * 鍵を入れ忘れたまま出した時に、黙って全公開になるのを防ぐため
 */
export function canViewLogs({ key = '', given = '', local = false }) {
  if (key) return given === key;
  return !!local;
}

/** 手元から来た繋がりか。Fly を通ると必ず fly-client-ip が付くので、それで見分ける */
export function isLocal(req) {
  if (req?.headers?.['fly-client-ip']) return false;
  const a = String(req?.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

// 出来事の名前を日本語にする。英語の識別子のまま出すと、
// 見に来るたびに「startって何だっけ」と思い出す所から始まる
const KIND_LABEL = {
  boot: 'サーバー起動',
  join: '入場',
  leave: '退場',
  start: '試合開始',
  round: 'ラウンド決着',
  match: '試合終了',
  error: '画面のエラー',
  net: '通信で例外',
  solo: '1人で遊んだ',
};

const two = (n) => String(n).padStart(2, '0');

/** ブラウザで読める1枚のページにする。外の物は一切読み込まない（1ファイルで完結） */
export function renderPage(rows, now = Date.now(), bootAt = 0) {
  const body = rows.map((r) => {
    const d = new Date(r.at);
    const time = `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
    // 本文は kind と n と at を除いた残り全部。項目が増えてもここを直さなくて済む
    const rest = Object.keys(r)
      .filter((k) => k !== 'n' && k !== 'at' && k !== 'kind')
      .map((k) => `<b>${esc(k)}</b> ${esc(r[k])}`)
      .join('　');
    return `<tr class="k-${esc(r.kind)}"><td class="t">${time}</td>`
      + `<td class="k">${esc(KIND_LABEL[r.kind] || r.kind)}</td>`
      + `<td>${rest}</td></tr>`;
  }).join('\n');

  const upMin = bootAt ? Math.round((now - bootAt) / 60000) : 0;
  return `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>BLACKOUT のログ</title>
<style>
 body{background:#0a0d12;color:#c8d2dd;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0;padding:18px}
 h1{font-size:15px;letter-spacing:.2em;color:#63d2ff;margin:0 0 4px}
 .note{color:#68727e;font-size:11px;margin-bottom:14px}
 table{border-collapse:collapse;width:100%}
 td{padding:4px 8px;border-bottom:1px solid rgba(255,255,255,.06);vertical-align:top}
 .t{color:#68727e;white-space:nowrap;width:1%}
 .k{white-space:nowrap;width:1%;color:#8fa0b2}
 b{color:#68727e;font-weight:400}
 .k-error .k,.k-net .k{color:#ff6b5a}
 .k-boot .k{color:#7ddb8a}
 .empty{color:#68727e;padding:20px 0}
</style>
<h1>BLACKOUT のログ</h1>
<div class="note">
 新しい順に ${rows.length} 件${upMin ? `　／　起動から ${upMin} 分` : ''}。
 記憶の中にだけ置いてあるので、次にデプロイすると消えます。
</div>
${rows.length ? `<table>${body}</table>` : '<div class="empty">まだ何も起きていません</div>'}
`;
}
