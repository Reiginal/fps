// 出来事を溜める所の検査。
//
// なぜ要るか: ログは**普段は誰も見ない**。見に行くのは何かが起きた後で、
// その時に「実は溜まっていなかった」と分かっても、もう遅い。
// 起きてから確かめる物ではないので、普段から数字で見張る。
//
// 特に見張るのは3つ:
//   1. 上限で必ず捨てる … 捨て損なうと記憶を使い切ってサーバーが落ちる。
//      ログを取るために入れた仕組みがゲームを殺す
//   2. 鍵が無い間は本番で見えない … 名前と環境が入る物を公開URLに出さない
//   3. 名前や発言をそのままHTMLにしない … 細工した名前で見に来た人の画面を書き換えられる
//
//   node tools/check-logs.mjs
import {
  Logs, LOG_MAX, TEXT_MAX, clean, canViewLogs, isLocal, renderPage,
} from '../server/logs.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

console.log('\n[1] 溜まって、新しい順に読める');
{
  const L = new Logs(10);
  L.add('join', { name: 'たろう', count: 1 }, 1000);
  L.add('join', { name: 'はなこ', count: 2 }, 2000);
  L.add('error', { name: 'たろう', message: '落ちた' }, 3000);
  ok(L.size === 3, `3件溜まっている (${L.size})`);
  const r = L.recent();
  ok(r[0].kind === 'error', `一番上が最後の1件 (${r[0].kind})`);
  ok(r[2].kind === 'join' && r[2].name === 'たろう', '一番下が最初の1件');
  ok(r[0].n === 3 && r[2].n === 1, `通し番号が付いている (${r[2].n}〜${r[0].n})`);
  // 種類で絞れる。エラーだけ見たい場面が一番多い
  const errs = L.recent(50, 'error');
  ok(errs.length === 1, `種類で絞れる（エラー ${errs.length}件）`);
}

console.log('\n[2] 上限を超えたら古い方から捨てる');
// **ここが今回一番大事。** 捨てる仕組みが無いと、溜まり続けていつか落ちる
{
  const L = new Logs(50);
  for (let i = 0; i < 500; i++) L.add('join', { name: `p${i}` }, i);
  ok(L.size === 50, `500件入れても50件しか残らない (${L.size})`);
  const r = L.recent();
  ok(r[0].name === 'p499', `一番新しいのは最後に入れた物 (${r[0].name})`);
  ok(r[49].name === 'p450', `一番古いのは50件前 (${r[49].name})`);
  // 既定の上限も、記憶を食い潰さない大きさになっているか
  ok(LOG_MAX <= 2000, `既定の上限 ${LOG_MAX}件（2000件以下）`);
}

console.log('\n[3] 1件が長くなりすぎない');
// 長い積み重ね(stack)をそのまま入れると、1件で表が埋まる
{
  const L = new Logs();
  const row = L.add('error', { message: 'あ'.repeat(5000) }, 0);
  ok(row.message.length <= TEXT_MAX, `${TEXT_MAX}文字で切れている (${row.message.length}文字)`);
}

console.log('\n[4] 改行や制御文字が混ざらない');
// 改行を通すと、1件が複数行に化けて他の行に紛れ込ませることができる
{
  const L = new Logs();
  const row = L.add('error', { message: '前\n[boot] にせもの\t後' }, 0);
  ok(!row.message.includes('\n'), '改行が残っていない');
  ok(!row.message.includes('\t'), 'タブが残っていない');
  ok(row.message.includes('にせもの'), `中身は残る (${row.message})`);
  // 種類の名前も同じ。ここを素通しにすると表の組み立てが壊れる
  ok(clean('a\nb') === 'a b', '制御文字は空白になる');
}

console.log('\n[5] 空の項目は入れない');
// 「where は空」のような行が並ぶと、読む時に目が滑る
{
  const L = new Logs();
  const row = L.add('error', { name: 'たろう', where: '', ua: null, line: undefined }, 0);
  ok(!('where' in row) && !('ua' in row) && !('line' in row),
    `空の項目は落ちる (${Object.keys(row).join(',')})`);
}

console.log('\n[6] 鍵が無い間は本番で見えない');
// ログには遊んだ人の名前と環境が入る。公開URLなので、
// 入れ忘れたまま出した時に黙って全公開になるのが一番まずい
{
  ok(canViewLogs({ key: '', given: '', local: true }), '鍵が無くても手元からは見える');
  ok(!canViewLogs({ key: '', given: '', local: false }), '鍵が無ければ本番からは見えない');
  ok(!canViewLogs({ key: 'himitsu', given: '', local: true }),
    '鍵を設定したら、手元からでも鍵が要る');
  ok(canViewLogs({ key: 'himitsu', given: 'himitsu', local: false }), '鍵が合えば見える');
  ok(!canViewLogs({ key: 'himitsu', given: 'chigau', local: false }), '鍵が違えば見えない');
}

console.log('\n[7] 手元かどうかの見分け');
// Flyを通ると必ずfly-client-ipが付く。付いていたら外から来た物
{
  ok(isLocal({ headers: {}, socket: { remoteAddress: '127.0.0.1' } }), '127.0.0.1 は手元');
  ok(isLocal({ headers: {}, socket: { remoteAddress: '::1' } }), '::1 は手元');
  ok(
    !isLocal({ headers: { 'fly-client-ip': '1.2.3.4' }, socket: { remoteAddress: '127.0.0.1' } }),
    'Fly経由なら、送り元が127.0.0.1に見えても手元ではない',
  );
  ok(!isLocal({ headers: {}, socket: { remoteAddress: '203.0.113.9' } }), '外のアドレスは手元ではない');
}

console.log('\n[8] 名前をそのままHTMLにしない');
// 名前は遊ぶ人が自由に決められる。細工した名前で入られた時、
// 見に来たこちらの画面が書き換えられては困る
{
  const L = new Logs();
  L.add('join', { name: '<img src=x onerror=alert(1)>' }, 0);
  L.add('error', { message: '</table><script>bad()</script>' }, 0);
  const html = renderPage(L.recent(), 0, 0);
  ok(!html.includes('<img src=x'), '細工した名前がそのまま出ていない');
  ok(!html.includes('<script>bad()'), '細工した本文がそのまま出ていない');
  ok(html.includes('&lt;img'), `文字としては残っている（読めないと調査にならない）`);
  // 外の物を読み込まない1枚で完結していること。
  // 読み込むと、ログを見る時に外へ「今このログを見た」が漏れる
  ok(!/<script\s+src=|<link\s/i.test(html), '外の物を読み込んでいない');
}

console.log('\n[9] 何も無い時も画面が出る');
// 空の時に落ちると、一番知りたい「何も起きていない」が確かめられない
{
  const html = renderPage([], 0, 0);
  ok(html.includes('まだ何も起きていません'), '空でも読める文が出る');
  ok(html.includes('<title>'), '題名がある');
}

console.log('\n[10] 拾っているのは「たまにしか起きない物」だけか');
// **線はここに引いてある。**
// 4人で遊ぶと、位置の更新は毎秒240回・発砲は毎秒43回起きる。
// 1行100バイトとして1日で2GBと370MB。拾ったらその時点で破綻する。
// 入退場や試合の結果は毎秒0.07回（1日0.6KB）しかない。
// 実際に拾っている種類が、後者の側だけであることを見る
{
  const src = await import('node:fs').then((m) => m.readFileSync);
  const files = ['server/index.js', 'server/room.js'];
  const kinds = new Set();
  for (const f of files) {
    const text = String(src(new URL(`../${f}`, import.meta.url)));
    for (const m of text.matchAll(/logs\.add\(\s*'([a-z]+)'/g)) kinds.add(m[1]);
  }
  // 毎フレーム・毎発砲で起きる物の名前。ここに載っている名前で拾い始めたら落とす
  const TOO_OFTEN = ['shot', 'fire', 'move', 'input', 'tick', 'pos', 'hit', 'frame'];
  const busted = [...kinds].filter((k) => TOO_OFTEN.includes(k));
  ok(busted.length === 0, `毎秒何十回も起きる物を拾っていない (${[...kinds].join(', ')})`);
  ok(kinds.has('error'), 'エラーは拾っている');
  ok(kinds.has('boot'), '起動の印を残している（ログが消えた境目が読める）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
