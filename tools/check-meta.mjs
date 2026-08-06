// 検査そのものが、ちゃんと走る場所に繋がっているかの検査。
//
// なぜ要るか: **検査を書いても、繋ぎ忘れたら1度も走らない。**
// しかも走っていないことは何処にも出ない。緑のCIを見て「全部見た」と思い込む。
//
// このrepoは同じ形で2回転んでいる（CLAUDE.mdの「検査は落ちることを確認する」）:
//   ・ブランチ保護を設定したのに、管理者は素通りできた
//   ・つまみの開閉ボタンが、何も畳めていなかった
// どちらも**設定/実装しただけで、効いていることを確かめなかった**。
// 検査の繋ぎ忘れは、それの一番たちの悪い版になる（見張り番が寝ていても誰も見に行かない）。
//
// 一覧が3箇所にある:
//   1. tools/check-*.mjs          … 実物
//   2. package.json の scripts.check … 手元で npm run check した時に走る物
//   3. .github/workflows/ci.yml   … CIで走る物
//
// 3箇所とも手書きなので、放っておけば必ずずれる。
// ずれ方によって被害が変わる:
//   ・実物にあるのに2と3に無い → **書いたのに1度も走らない**（一番痛い）
//   ・2にあって3に無い         → 手元では気づくがCIは緑。他の環境で落ちる
//   ・2や3にあって実物が無い   → その場で「そんなファイルは無い」で落ちるので、まだまし
//
//   node tools/check-meta.mjs
import { readFileSync, readdirSync } from 'node:fs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 実物。sound-lab や offline-audio は道具であって検査ではないので、check- だけを見る
const real = readdirSync('tools').filter((f) => f.startsWith('check-') && f.endsWith('.mjs')).sort();

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');

// 「tools/check-なんとか.mjs」を全部拾う。--expose-gc のような前置きがあっても届く
const pick = (text) => [...text.matchAll(/tools\/(check-[\w-]+\.mjs)/g)].map((m) => m[1]);

const inPkg = new Set(pick(pkg.scripts.check || ''));
const inCi = new Set(pick(ci));

console.log('\n[1] 3箇所の一覧が揃っている');
ok(real.length > 0, `tools/ に検査が ${real.length} 本ある`);
ok(inPkg.size > 0, `package.json の check に ${inPkg.size} 本`);
ok(inCi.size > 0, `ci.yml に ${inCi.size} 本`);

console.log('\n[2] 書いた検査が、手元とCIの両方に繋がっている');
// **ここが本題。** 新しく作った検査を繋ぎ忘れると、
// 書いた本人は「検査を足した」つもりのまま1度も走らない
for (const f of real) {
  const p = inPkg.has(f);
  const c = inCi.has(f);
  ok(p && c, `${f}`
    + (p && c ? ' … npm run check とCIの両方にある'
      : `  ← ${!p && !c ? 'どちらにも繋がっていない（1度も走らない）'
        : !p ? 'npm run check に無い（手元で走らない）'
          : 'ci.yml に無い（CIで走らない）'}`));
}

console.log('\n[3] 一覧に、実在しない検査が並んでいない');
// こちらは走らせた瞬間に落ちるので被害は小さいが、
// 消した検査の名前が残っていると「まだ見ている」と勘違いする
const realSet = new Set(real);
for (const f of inPkg) ok(realSet.has(f), `package.json の ${f} は実在する`);
for (const f of inCi) ok(realSet.has(f), `ci.yml の ${f} は実在する`);

console.log('\n[4] どの検査も、落ちた時にちゃんと落ちる');
// **通ることより落ちることが大事**、というのがこのrepoの考え方。
// process.exit(1) を書き忘れた検査は、画面に「× 失敗」と出しておきながら
// 終了コード0で返す。CIは緑のままなので、失敗が素通りする
for (const f of real) {
  const src = readFileSync(`tools/${f}`, 'utf8');
  ok(/process\.exit\(/.test(src), `${f} … 終了コードを返している`);
}

console.log('\n[5] このファイル自身も繋がっている');
// 自分を数え忘れたら意味が無い
ok(inPkg.has('check-meta.mjs') && inCi.has('check-meta.mjs'), 'check-meta.mjs 自身が両方にある');

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
