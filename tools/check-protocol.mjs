// 電文の「送る側」と「受ける側」が食い違っていないかの検査。
//
// なぜ要るか: **実際に、対戦がまるごと成立しない状態で本番へ出ていた。**
//
// チーム制をやめた時、クライアントは席の電文から `tm`（チーム番号）を送るのをやめた。
// ところがサーバーの onSeat は `if (!isNum(m.tm) || !isNum(m.st)) return;` のままで、
// **席に着く要求を毎回黙って捨てていた。** 座れないので試合が始まらない。
//
// この壊れ方は既存のどの検査にも引っかからなかった:
//   ・構文エラーではない（両方とも正しいJavaScript）
//   ・check-calls.mjs は「呼び先が実在するか」しか見ない。ここは呼び先ではなく電文の中身
//   ・サーバー側の検査は Room を直接叩くので、index.js の入口を通らない
//   ・遊ぶ側からは「押しても何も起きない」としか見えず、画面にも何も出ない
//
// やることは単純で、両側のソースから電文ごとの項目名を拾って突き合わせるだけ。
// **サーバーが必須にしている項目が、クライアントの送る物に無ければ落とす。**
//
//   node tools/check-protocol.mjs
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const read = (p) => String(readFileSync(new URL(`../${p}`, import.meta.url)));
const client = read('src/net/client.js');
const server = read('server/index.js');

/* ---- クライアントが送る物を拾う ----
   this._send({ t: C.SEAT, st: seat | 0 }) の形から、電文の名前と項目名を取る */
const sends = new Map();   // 'SEAT' -> Set{'st'}
for (const m of client.matchAll(/_send\(\{\s*t:\s*C\.([A-Z]+)\s*,?([^}]*)\}/g)) {
  const name = m[1];
  const fields = new Set();
  /* 「項目名:」と、省略形（{ to, d } のように名前だけ書く形）の両方を拾う。
     **省略形を拾えていなかった。** 名前だけで書かれた項目は1つも見えず、
     「必須の項目を送っていない」と出る（実際にVSIGでそうなった）。
     値の中の識別子を拾わないよう、後ろが , : } のどれかの時だけ数える */
  for (const f of m[2].matchAll(/(?:^|,)\s*([a-zA-Z_$][\w$]*)\s*[,:}]/g)) fields.add(f[1]);
  if (!sends.has(name)) sends.set(name, new Set());
  for (const f of fields) sends.get(name).add(f);
}

/* ---- サーバーが読む物を拾う ----
   switch の case C.SEAT: return onSeat(conn, m) から、電文の名前と受け口の対応を取り、
   その関数の本文から m.○○ を拾う */
const routes = new Map();  // 'SEAT' -> 'onSeat'
for (const m of server.matchAll(/case\s+C\.([A-Z]+)\s*:\s*return\s+([a-zA-Z_$][\w$]*)\s*\(/g)) {
  routes.set(m[1], m[2]);
}

function bodyOf(fnName) {
  const at = server.indexOf(`function ${fnName}(`);
  if (at < 0) return '';
  // 波括弧の対応を数えて関数の終わりまで取る
  let i = server.indexOf('{', at);
  let depth = 0;
  for (let k = i; k < server.length; k++) {
    if (server[k] === '{') depth++;
    else if (server[k] === '}') { depth--; if (depth === 0) return server.slice(i, k + 1); }
  }
  return '';
}

console.log('\n[1] 電文の受け口が全部見つかる');
ok(routes.size > 0, `受け口 ${routes.size} 本（${[...routes.keys()].join(', ')}）`);
ok(sends.size > 0, `送る側 ${sends.size} 種（${[...sends.keys()].join(', ')}）`);

console.log('\n[2] サーバーが必須にしている項目を、クライアントが送っている');
// ここが今回の不具合そのもの。**isNum(m.○○) で弾いている項目**を見る。
// 読むだけ（m.name のような任意の項目）は必須ではないので、弾いている物だけを対象にする
for (const [msg, fn] of routes) {
  const body = bodyOf(fn);
  if (!body) { ok(false, `${msg} … 受け口 ${fn} の本文が読めない`); continue; }

  // 「isNum(m.x) が false なら return」の形で必須にしている項目を拾う
  const required = new Set();
  for (const m of body.matchAll(/!isNum\(\s*m\.([a-zA-Z_$][\w$]*)\s*\)/g)) required.add(m[1]);
  // 「!Array.isArray(m.x)」も必須扱い
  for (const m of body.matchAll(/!Array\.isArray\(\s*m\.([a-zA-Z_$][\w$]*)\s*\)/g)) required.add(m[1]);

  const sent = sends.get(msg) || new Set();
  const missing = [...required].filter((f) => !sent.has(f));
  ok(
    missing.length === 0,
    `${msg} … 必須 {${[...required].join(', ') || 'なし'}} / 送っている {${[...sent].join(', ')}}`
    + (missing.length ? `  ← ${missing.join(', ')} が送られていない` : ''),
  );
}

console.log('\n[3] 送っている項目に、受け口が知らない物が混ざっていない');
// こちらは「送っているのに使われていない」で、実害は小さいが古い項目が残る目印になる。
// t は電文の種類そのものなので数えない
for (const [msg, fn] of routes) {
  const body = bodyOf(fn);
  if (!body) continue;
  const usedInBody = new Set();
  for (const m of body.matchAll(/\bm\.([a-zA-Z_$][\w$]*)/g)) usedInBody.add(m[1]);
  const sent = [...(sends.get(msg) || new Set())].filter((f) => f !== 't');
  const unused = sent.filter((f) => !usedInBody.has(f));
  ok(unused.length === 0, `${msg} … 送った物は全部読まれている${unused.length ? `（余り: ${unused.join(', ')}）` : ''}`);
}

console.log('\n[4] 電文の名前が protocol.js に揃っている');
// 片側だけが知っている電文があると、送っても誰も受けない／受け口が永遠に呼ばれない。
// ここは本文を読まずに実物を読み込む（コメントの波括弧で数え違える心配が無い）
{
  const { C } = await import('../src/net/protocol.js');
  const declared = new Set(Object.keys(C));
  ok(declared.size > 0, `protocol.js の C に ${declared.size} 種（${[...declared].join(', ')}）`);
  for (const name of sends.keys()) ok(declared.has(name), `${name} は protocol.js にある（送る側）`);
  for (const name of routes.keys()) ok(declared.has(name), `${name} は protocol.js にある（受ける側）`);
  // 受け口が1本も無い電文。作りかけで放置されている物が見つかる
  const orphan = [...declared].filter((n) => !routes.has(n));
  ok(orphan.length === 0, `受け口の無い電文が無い${orphan.length ? `（${orphan.join(', ')}）` : ''}`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
