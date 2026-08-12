// ホームの順位表の検査。
//
// なぜ要るか: **誰でも見える口**なので、うっかり載せた1列がそのまま外へ出る。
// 名前以外（メール・id）が混ざっていないかを、実際に呼んで確かめる。
//
// もう1つは順位の元。**残高(coins)で並べてはいけない。**
// 買うと減るので「スキンを買った人ほど下に落ちる表」になる。
// 減らない列(earned)で並べていることを見る。
//
//   node tools/check-ranking.mjs
import { readFileSync } from 'node:fs';

const { ranking } = await import('../server/wallet.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* 台帳の代わり。**投げられたSQLを全部取っておく**ので、
   「何を読みに行ったか」をそのまま確かめられる */
function fakeDb(rows = [], count = 0) {
  const sqls = [];
  const query = async (sql, args) => {
    sqls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), args });
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ n: count }] };
    return { rows };
  };
  return { query, sqls };
}

console.log('\n[1] 返す中身は名前とスコアだけ');
{
  /* 台帳が余計な列を返してきても、こちらで捨てていること。
     **SELECT を直しても大丈夫な形にしておく**のが目的 */
  const db = fakeDb([
    { name: 'れい', earned: 5200, email: 'x@example.com', id: 7, pass_hash: 'zzz' },
    { name: 'ばん', earned: 900, email: 'y@example.com', id: 8 },
  ], 2);
  const r = await ranking(db.query, 10);
  ok(r.rows.length === 2, `2人ぶん返る（${r.rows.length}人）`);
  const keys = Object.keys(r.rows[0]).sort().join(',');
  ok(keys === 'earned,name', `1人ぶんの中身は name と earned だけ（${keys}）`);
  const dumped = JSON.stringify(r);
  ok(!/example\.com/.test(dumped), '**メールが混ざっていない**');
  ok(!/pass|hash/i.test(dumped), '合言葉らしき物も混ざっていない');
  ok(r.players === 2, `登録した人の数も返る（${r.players}人）`);
}

console.log('\n[2] 順位の元は「稼いだ総額」で、残高ではない');
{
  const db = fakeDb([], 0);
  await ranking(db.query, 10);
  const top = db.sqls[0].sql;
  ok(/ORDER BY earned DESC/.test(top), `earnedの多い順で並べている`);
  ok(!/ORDER BY[^;]*coins/.test(top), '**残高(coins)では並べていない**（買うと下がる物では順位にならない）');
  // メール未確認の人は出さない。確認前でも名前は付けられるので、そこを載せない
  ok(/verified_at IS NOT NULL/.test(top), 'メールを確認した人だけを並べる');

  /* 稼いだ総額は**受け取った時に一緒に増える。**
     ここが抜けると、順位表が全員0のまま動かない */
  const w = readFileSync(new URL('../server/wallet.js', import.meta.url), 'utf8');
  ok(/earned = wallets\.earned \+ EXCLUDED\.earned/.test(w),
    'addCoinsがearnedにも足している');
  ok(/coins = coins \+ \$2, earned = earned \+ \$2/.test(w),
    '1人プレイの受け取り(addSoloCoins)もearnedに足している');
}

console.log('\n[3] 数を絞っている');
{
  const many = Array.from({ length: 50 }, (_, i) => ({ name: `p${i}`, earned: i }));
  const db = fakeDb(many, 50);
  await ranking(db.query, 999);
  ok(db.sqls[0].args[0] === 20, `いくつ頼まれても20位までで止める（${db.sqls[0].args[0]}）`);
  const db2 = fakeDb(many, 50);
  await ranking(db2.query, 0);
  ok(db2.sqls[0].args[0] >= 1, `0や負の数でも1以上になる（${db2.sqls[0].args[0]}）`);
}

console.log('\n[4] 台帳が無い置き場でも404を返さない');
{
  /* **ホームが起動のたびに必ず叩く口。**404にすると、
     台帳を置いていない置き場で遊ぶ人全員のコンソールに毎回赤い行が出る
     （/api/meで一度踏んで、e2eがデプロイを止めた話と同じ）*/
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/url !== '\/api\/ranking'/.test(idx), '台帳が無い時の404から除いてある');
  ok(/if \(!accountsOn\) \{ sendJson\(res, 200, \{ ok: true, accounts: false, rows: \[\], players: 0 \}\)/.test(idx),
    '台帳が無ければ「まだ誰もいない」を200で返す');
  ok(/rank\|\$\{ip\}/.test(idx), '連投止めが掛かっている');
}

console.log('\n[5] 画面側');
{
  const ui = readFileSync(new URL('../src/ui/ranking.js', import.meta.url), 'utf8');
  /* **名前はテキストとして入れる。** innerHTMLで組むと、
     名前に入れられたタグがそのまま動く（名前は本人が決められる文字列）*/
  ok(/textContent = r\.name/.test(ui), '名前をテキストとして入れている');
  ok(!/innerHTML\s*\+?=\s*`/.test(ui), '**文字列を組み立ててinnerHTMLへ入れていない**');
  ok(/AbortSignal\.timeout/.test(ui), '返らないサーバーを待ち続けない');
  ok(/AGAIN_MS/.test(ui), '開き直すたびに叩かないよう間を空けている');

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/id="rank"/.test(html), 'ホームに枠がある');
  ok(/#rank[\s\S]{0,400}pointer-events: none/.test(html),
    '**押せない**（ホームのボタンの上に透明な板を敷かない）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
