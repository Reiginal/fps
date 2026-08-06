// 読み込みの繋がりを、ブラウザを開かずに辿る検査。
//
// なぜ要るか: **importを1行書き間違えると、他の検査は全部通ったまま、
// 開くと真っ黒になる。** 実際に壊して確かめてある。
// 他の検査はどれもNodeの中でクラスを動かしているだけで、
// 「index.htmlのimportmapとブラウザの読み込みが噛み合っているか」を1つも見ていない。
//
// 本物のブラウザで開く検査(npm run e2e)がそこを塞いでいたが、
// あれはGPUの無い所で走ると2分かかる。**PRのたびに2分待つのはやめた**ので、
// 一番よく踏む形（読み込み先の書き間違い）だけをここで拾う。
// 残り（本当に画が出るか）は本番へ出す直前にブラウザで見る（.github/workflows/deploy.yml）。
//
// ここが見ているのは3つ:
//   1. importmapを通して読み込み先が決まるか … 決まらないとブラウザはその場で諦める
//   2. その先のファイルが本当にあるか       … 名前の打ち間違い・移動し忘れ
//   3. そのファイルを外へ配る決まりがあるか … 手元では開けるが本番だけ404、を防ぐ
//
//   node tools/check-imports.mjs
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix } from 'node:path';
import { publicPath } from '../server/serve-rules.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

/* コメントを外してから探す。**コメントの中にもimportと書いてある**ので、
   そのまま探すと、説明のために書いた1行を本物の読み込みとして数えてしまう */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

console.log('\n[1] index.html に読み込みの入口がある');
const mapText = html.match(/<script[^>]*type="importmap"[^>]*>([\s\S]*?)<\/script>/)?.[1];
ok(!!mapText, 'importmapが書いてある');
let imports = {};
try { imports = JSON.parse(mapText || '{}').imports || {}; } catch { /* 下で落ちる */ }
ok(Object.keys(imports).length > 0, `importmapに ${Object.keys(imports).length} 件の対応がある`);

const entry = html.match(/<script[^>]*type="module"[^>]*src="([^"]+)"/)?.[1];
ok(!!entry, `最初に読み込むファイルが書いてある（${entry || '無い'}）`);

/**
 * 読み込み先の名前を、リポジトリの中の場所へ変える。ブラウザがやるのと同じ手順。
 * 決められない時は null（＝ブラウザもそこで諦める）
 */
function resolve(spec, fromRel) {
  // ./ ../ で始まる物は、書いてあるファイルからの相対
  if (spec.startsWith('./') || spec.startsWith('../')) {
    return posix.normalize(posix.join(posix.dirname(fromRel), spec));
  }
  if (spec.startsWith('/')) return spec.slice(1);
  // 名前だけの物はimportmapを引く。まず丸ごと一致
  if (imports[spec]) return posix.normalize(imports[spec].replace(/^\.\//, ''));
  // 次に「/で終わる鍵」の前方一致。three/addons/ がこれ
  for (const [k, v] of Object.entries(imports)) {
    if (k.endsWith('/') && spec.startsWith(k)) {
      return posix.normalize(v.replace(/^\.\//, '') + spec.slice(k.length));
    }
  }
  return null;
}

/* 読み込み先の名前を全部拾う。3つの書き方がある:
     import ... from 'x' / import 'x' / export ... from 'x' / import('x') */
const specsOf = (src) => {
  const s = stripComments(src);
  const out = new Set();
  for (const re of [
    /(?:^|[\s;}])import\s+(?:[\s\S]*?\sfrom\s+)?['"]([^'"]+)['"]/g,
    /(?:^|[\s;}])export\s+[\s\S]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]) for (const m of s.matchAll(re)) out.add(m[1]);
  return [...out];
};

/* 入口から辿れる所を全部歩く。
   node_modules の中（three本体）へは入らない。あれは他人の物で、
   こちらが直せる間違いは1つも出てこないうえに数が桁違いに増える。
   **あるかどうかと、配る決まりがあるかは見る**（そこは本番で効く） */
console.log('\n[2] 入口から辿れる読み込みが、全部その先まで繋がっている');
const seen = new Set();
const queue = [posix.normalize((entry || './src/main.js').replace(/^\.\//, ''))];
let files = 0;
let links = 0;
while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);

  const abs = join(ROOT, rel);
  if (!existsSync(abs)) { ok(false, `${rel} … ファイルが無い`); continue; }
  files++;
  // 外へ配る決まりに入っているか。ここが抜けると手元では開けて本番だけ404になる
  if (publicPath('/' + rel) === null) ok(false, `${rel} … 外へ配る決まりに入っていない`);
  if (rel.startsWith('node_modules/')) continue;

  for (const spec of specsOf(readFileSync(abs, 'utf8'))) {
    links++;
    const to = resolve(spec, rel);
    if (to === null) {
      ok(false, `${rel} の "${spec}" … importmapに無いので読み込み先が決まらない`);
      continue;
    }
    queue.push(to);
  }
}
ok(true, `入口から ${files} ファイル・${links} 本の読み込みを辿った`);
// 数が急に減っていたら、どこかで枝が丸ごと切れている
ok(files > 20, `辿れたファイルが ${files} 本ある`);

console.log('\n[3] importmapの行き先が実在する');
// 誰も読み込んでいなくても、書いてある以上は指す先があること。
// threeの版を上げた時に、置き場所だけ変わっているのがここに出る
for (const [k, v] of Object.entries(imports)) {
  const p = v.replace(/^\.\//, '');
  ok(existsSync(join(ROOT, p)), `${k} → ${p}`);
}

console.log('\n[4] 入口そのものが外へ配られる');
// index.html と最初のファイルが配られないと、そもそも何も始まらない
ok(publicPath('/') === '/index.html', 'まっさらなURLでindex.htmlが返る');
ok(publicPath('/' + posix.normalize((entry || '').replace(/^\.\//, ''))) !== null,
  `${entry} が配られる`);

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
