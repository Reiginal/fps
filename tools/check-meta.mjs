// 検査そのものが、ちゃんと走る場所に繋がっているかの検査。
//
// なぜ要るか: **検査を書いても、繋ぎ忘れたら1度も走らない。**
// しかも走っていないことは何処にも出ない。緑のCIを見て「全部見た」と思い込む。
//
// このrepoは同じ形で2回転んでいる（CLAUDE.mdの「検査は落ちることを確認する」）:
//   ・ブランチ保護を設定したのに、管理者は素通りできた
//   ・つまみの開閉ボタンが、何も畳めていなかった
// どちらも**設定/実装しただけで、効いていることを確かめなかった**。
//
// 前はここが「tools/の実物」「package.jsonの一覧」「ci.ymlの一覧」の3箇所を
// 突き合わせていた。3箇所とも手書きなので、放っておけば必ずずれるからだった。
// **今は一覧そのものを無くしてある。** tools/run-checks.mjs が tools/ を自分で読むので、
// ファイルを置いた時点で走る。だからここが見るのは「一覧が揃っているか」ではなく、
// **一覧を手で持つ形に戻っていないか**になった。
//
//   node tools/check-meta.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 実物。sound-lab や offline-audio は道具であって検査ではないので、check- だけを見る
const real = readdirSync('tools').filter((f) => f.startsWith('check-') && f.endsWith('.mjs')).sort();

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const runner = readFileSync('tools/run-checks.mjs', 'utf8');
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
// コメントの中にも npm run check と書いてあるので、外してから探す
const noComment = (s) => s.replace(/^\s*#.*$/gm, '');

console.log('\n[1] 検査の一覧を手で持っていない');
ok(real.length > 0, `tools/ に検査が ${real.length} 本ある`);
// **ここが肝。** 走らせる側が置き場を自分で読んでいれば、繋ぎ忘れは起こせない
ok(/readdirSync\([^)]*'tools'/.test(runner) && /startsWith\('check-'\)/.test(runner),
  'run-checks.mjs が tools/ を自分で読んで検査を見つけている');
ok(/tools\/run-checks\.mjs/.test(pkg.scripts.check || ''),
  'npm run check がその1本を呼ぶ');
// 検査の名前をずらずら並べる形に戻っていないこと（戻すと、また手で揃える話になる）
ok((pkg.scripts.check.match(/tools\/check-/g) || []).length === 0,
  'package.json に検査の名前が並んでいない');
ok((noComment(ci).match(/tools\/check-/g) || []).length === 0,
  'ci.yml に検査の名前が並んでいない');

console.log('\n[2] 手元とCIと本番前で、同じ1本が走る');
// 走らせ方が場所ごとに違うと、「手元では通るのにCIだけ落ちる」の置き場になる
ok(/npm run check/.test(noComment(ci)), 'ci.yml が npm run check を呼ぶ');
ok(/npm run check/.test(noComment(deploy)), 'deploy.yml が npm run check を呼ぶ');
ok(/npm run lint/.test(noComment(ci)), 'ci.yml が npm run lint を呼ぶ');

console.log('\n[3] どの検査も、落ちた時にちゃんと落ちる');
// **通ることより落ちることが大事**、というのがこのrepoの考え方。
// process.exit(1) を書き忘れた検査は、画面に「× 失敗」と出しておきながら
// 終了コード0で返す。CIは緑のままなので、失敗が素通りする
for (const f of real) {
  ok(/process\.exit\(/.test(readFileSync(`tools/${f}`, 'utf8')), `${f} … 終了コードを返している`);
}

console.log('\n[4] 先に始める物の当てが、古くなっていない');
/* run-checks.mjs は時間のかかる検査から先に始める。並び順なので結果は変わらないが、
   名前を打ち間違えたり、消した検査の名前が残っていると、
   **速くしたつもりのまま元の遅さに戻る**（しかも緑のままなので気づけない） */
const heavy = [...(runner.match(/'(check-[\w-]+\.mjs)',\s*(?:\/\/.*)?$/gm) || [])]
  .map((s) => s.match(/'(check-[\w-]+\.mjs)'/)[1]);
ok(heavy.length > 0, `先に始める検査が ${heavy.length} 本書いてある`);
for (const f of heavy) ok(real.includes(f), `${f} … 実在する`);

console.log('\n[5] ブラウザで開く検査が、どこかで走る');
/* **ここが一番危ない。** ブラウザの検査はPRのたびに走らせると2分かかるので、
   本番へ出す直前(deploy.yml)へ移した。移した先から消えても、
   ci.ymlは緑のままなので誰も気づかない。1372項目が届いていない層なのに */
ok(existsSync('e2e') && readdirSync('e2e').some((f) => f.endsWith('.spec.mjs')),
  'e2e/ に検査がある');
ok(/playwright test/.test(pkg.scripts.e2e || ''), 'npm run e2e で走る');
ok(/npm run e2e/.test(noComment(deploy)), 'deploy.yml が本番へ出す前に npm run e2e を呼ぶ');
// 出す前に、であること。出した後だと壊れた物が既に本番に居る
ok(noComment(deploy).indexOf('npm run e2e') < noComment(deploy).indexOf('flyctl deploy'),
  'flyctl deploy より前に呼んでいる');

console.log('\n[6] このファイル自身も走る');
ok(real.includes('check-meta.mjs'), 'check-meta.mjs 自身が tools/ にある');

console.log('\n[7] ブラウザ検査が見るidが、画面に実在する');
/* e2eはデプロイ直前にしか走らない。見ているidが画面から消えると、
   手元のcheckは全部緑のまま、デプロイの段で初めて止まる
   （戦績ボタンを消した時に実際に止まった）。
   e2eのソースから locator('#〜') と id一覧のリテラルを拾って、
   index.htmlに実在するかをここ（毎回走る側）で突き合わせる */
{
  const { readFileSync: rf } = await import('node:fs');
  const spec = rf(new URL('../e2e/boot.spec.mjs', import.meta.url), 'utf8');
  const html = rf(new URL('../index.html', import.meta.url), 'utf8');
  const ids = new Set();
  for (const m of spec.matchAll(/locator\(['"`]#([A-Za-z][\w-]*)['"`]\)/g)) ids.add(m[1]);
  /* page.evaluateの中のgetElementByIdも拾う。最初locator()と一覧リテラルだけ見ていて、
     evaluate内に残っていた戦績のgetElementByIdを取りこぼし、デプロイがもう1回止まった */
  for (const m of spec.matchAll(/getElementById\(['"`]([A-Za-z][\w-]*)['"`]\)/g)) ids.add(m[1]);
  for (const m of spec.matchAll(/querySelectorAll\(['"`]#([A-Za-z][\w-]*)[\s'"`]/g)) ids.add(m[1]);
  for (const m of spec.matchAll(/\[((?:'[A-Za-z]\w*',?\s*)+)\]/g)) {
    for (const q of m[1].matchAll(/'([A-Za-z]\w*)'/g)) {
      // id一覧のリテラルだけを拾いたいので、index.htmlのid規約(nm〜等)に限る
      if (/^(nm|st|sx|ov)[A-Z]/.test(q[1])) ids.add(q[1]);
    }
  }
  ok(ids.size >= 5, `e2eが見るidを${ids.size}個拾えた（拾えなさすぎたら検査の壊れ）`);
  for (const id of ids) {
    ok(html.includes(`id="${id}"`), `#${id} が index.html に実在する`);
  }
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
