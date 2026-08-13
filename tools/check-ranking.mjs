// ホームの順位表の検査。
//
// なぜ要るか: **誰でも見える口**なので、うっかり載せた1列がそのまま外へ出る。
// 名前以外（メール・id）が混ざっていないかを、実際に呼んで確かめる。
//
// もう1つは順位の元。**コインで並べてはいけない。**
// 残高は買うと減るし、稼いだ総額は**台帳から直に足せる**ので、
// どちらも「遊んだ記録」にならない
// （2026-08-12に「稼いだコインの総額、微妙だな。俺ら金もらってるからね、DBで」）。
// 遊ばないと増えない3つ（勝利・撃破・到達波）で並べていることを見る。
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
    { name: 'れい', score: 5200, wins: 12, email: 'x@example.com', id: 7, pass_hash: 'zzz' },
    { name: 'ばん', score: 900, wins: 1, email: 'y@example.com', id: 8 },
  ], 2);
  const r = await ranking(db.query, 10);
  ok(r.rows.length === 2, `2人ぶん返る（${r.rows.length}人）`);
  const keys = Object.keys(r.rows[0]).sort().join(',');
  ok(keys === 'name,score,wins', `1人ぶんの中身は name と score と wins だけ（${keys}）`);
  const dumped = JSON.stringify(r);
  ok(!/example\.com/.test(dumped), '**メールが混ざっていない**');
  ok(!/pass|hash/i.test(dumped), '合言葉らしき物も混ざっていない');
  ok(r.players === 2, `登録した人の数も返る（${r.players}人）`);
}

console.log('\n[2] 順位の元は「遊んだ量」で、コインではない');
{
  const { SCORE, scoreOf } = await import('../server/wallet.js');
  const db = fakeDb([], 0);
  await ranking(db.query, 10);
  const top = db.sqls[0].sql;
  ok(/ORDER BY score DESC/.test(top), '点の高い順で並べている');
  ok(!/ORDER BY[^;]*(coins|earned)/.test(top),
    '**コインでは並べていない**（台帳から直に足せる物では記録にならない）');
  // メール未確認の人は出さない。確認前でも名前は付けられるので、そこを載せない
  ok(/verified_at IS NOT NULL/.test(top), 'メールを確認した人だけを並べる');

  /* **勝利が一番重いこと。**「できれば勝利数が高いほうがいいね」と言われた所。
     1勝＝撃破50回＝到達波20。1試合の撃破は多くて10前後なので、
     勝った試合1つが負け続けた10試合より上に来る */
  ok(SCORE.WIN > SCORE.KILL * 10 && SCORE.WIN > SCORE.WAVE * 10,
    `勝利が一番重い（勝${SCORE.WIN} 撃破${SCORE.KILL} 波${SCORE.WAVE}）`);
  ok(scoreOf({ wins: 1 }) > scoreOf({ kills: 10, waves: 10 }),
    '1勝が「撃破10・波10」より上');
  // soloだけ・対戦だけのどちらでも上がること
  ok(scoreOf({ waves: 12 }) > 0 && scoreOf({ kills: 12 }) > 0,
    '1人プレイだけでも対戦だけでも点が入る');
  ok(scoreOf({ wins: -5, kills: -5 }) === 0, '負の数を渡しても点は0まで');

  /* 遊んだ記録は**両方の入口から足される。**
     ここが抜けると、順位表が全員0のまま動かない */
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/wins: top > 0 && \(s\.rounds \| 0\) === top \? 1 : 0/.test(idx),
    '対戦の終わりに、1位だけ勝ち星が付く');
  ok(/addPlay\(db\.query, me\.id, \{[\s\S]{0,120}waves:/.test(idx),
    '1人プレイの受け取りで到達波と撃破が足される');
  /* **コインが貰えなかった時も記録は足す。**
     1日の上限に当たった後も遊んではいるので、
     受け取りと同じ扱いにすると、その日たくさん遊んだ人ほど記録が止まる */
  ok(idx.indexOf('addPlay(db.query, me.id') < idx.indexOf('addSoloCoins(q, me.id, want)'),
    '**コインの上限判定より前に記録している**（上限に当たっても記録は残る）');
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

console.log('\n[6] 付けるclass名が、枠の外の決まりに掴まれていないか');
{
  /* **2026-08-13に「ランキングの表示おかしいw」と言われた所。**
     1位の行に class="top" を付けていたが、index.htmlには
     **枠を持たない .top（HUDの上帯）が居て、そちらは position:absolute。**
     掴まれた1位の行だけが順位表の枠から抜けて、
     枠いっぱいに広がって位置も右端も揃っていなかった。

     同じ罠はスコアボードでも一度踏んでいて、あちらは
     「class名をtopにするとHUD上部の.topに掴まれて画面の天辺へ飛ぶ」と
     index.htmlに書き残したうえで .sbrow.win に避けてある。
     **書き残しただけでは防げなかった**ので、ここで機械に見張らせる。

     決まりは1つ: **順位表が付けるclass名は、#rankの中でしか使われていないこと。**
     枠の外の決まりが同じ名前を持っていたら落とす */
  const ui = readFileSync(new URL('../src/ui/ranking.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  // 注釈は外す。「class名をtopにすると」のような文中の語を拾わないため
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');

  const names = [...ui.matchAll(/className = '([\w-]+)'/g)].map((m) => m[1]);
  ok(names.length > 0, `付けているclass名を拾えた（${names.join('、') || 'なし'}）`);
  for (const n of names) {
    /* その名前を含む決まりを全部集めて、1つでも #rank の外に居たら落とす。
       セレクタは「{ の手前」なので、そこだけ見る */
    const rules = [...bare.matchAll(new RegExp(`([^{}]*\\.${n}\\b[^{}]*)\\{`, 'g'))]
      .map((m) => m[1].trim().replace(/\s+/g, ' '))
      // @media の中身も同じ形で拾えるが、@から始まる物は決まりではない
      .filter((s) => !s.startsWith('@'));
    const loose = rules.filter((s) => !s.includes('#rank'));
    ok(loose.length === 0,
      `.${n} は#rankの中でしか使われていない${loose.length ? `（外にもある: ${loose.join(' / ')}）` : ''}`);
  }
  // 実際に踏んだ名前は名指しで塞いでおく。次に誰かが付け直した時に一目で分かる
  ok(!names.includes('top'), '**topという名前を付けていない**（HUDの上帯に掴まれる）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
