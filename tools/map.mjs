// このrepoの地図。どのファイルが何を持っているかを1画面に出す。
//
//   node tools/map.mjs        ファイルの一覧と、大きいファイルの中の見出し
//   node tools/map.mjs 武器    「武器」を含む行だけ絞って出す
//
// なぜ要るか: **新しく入った人（次の日の自分・Claude）が、直す場所を探すのに
// 一番時間を使っているから。** 43,000行あって、上位5本で4割を占める。
// weapons.js を開いても4185行あるので、grepを何往復もすることになる。
//
// **手で書いた地図は持たない。** このrepoは同じ形で何度も転んでいる:
//   ・検査の一覧が3箇所（tools/の実物・package.json・ci.yml）にあってずれた
//   ・検査の本数をCLAUDE.mdに手で書いてずれた
//   ・課題の一覧をCLAUDE.mdと課題.mdの両方に書いてずれた
// なので、ここは**既にファイルの中にある物を読んで並べるだけ**にしてある。
//
// 材料は2つとも、**元から全部書いてあった**。作る時に新しい書式を足していない:
//
//   1. 冒頭コメントの1行目 … src/ と server/ の全ファイルに有る
//   2. 「/* ------ 見出し */」 … 22ファイルに297箇所。書く時に自然と入れている区切り
//
// 地図が無かったのは、書いていなかったからではなく**拾っていなかったから**。
// だから、ファイルを足しても消しても名前を変えても、ここは何もしなくていい。
// 逆に言えば**冒頭コメントを書かないと地図から中身が消える**ので、
// それは tools/check-meta.mjs の[8]が見張っている。
//
// 細かい方の見出し（銃の部品ひとつ、といった段の深い区切り）は既定では出さない。
// weapons.js だけで74本あって、全部出すと地図ではなく目次の壁になる。
// 探し物がある時は絞り込みの語を渡すと、深い所まで含めて出る。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
// 絞り込みの語。node tools/map.mjs 武器 のように渡す
const NEEDLE = process.argv.slice(2).filter((a) => !a.startsWith('-')).join(' ');

/* 冒頭コメントの1行目を取る。`//` で始まる形と `/*` で始まる形の両方がある
   （client.js と remote.js はブロックコメント） */
function summaryOf(src) {
  const first = src.split('\n', 1)[0];
  const m = first.match(/^\s*(?:\/\/|\/\*+)\s*(.*)$/);
  if (!m) return '';
  return m[1].replace(/\*+\/\s*$/, '').trim();
}

// 大見出しに何本まで採るか。段の浅い順に足していって、
// 次の段を足すとここを超える所で止める。
//
// 45という数字に理屈は無い。**実際の4本の作りが全部収まる所**を採った:
//   weapons.js  段0が15本、段2が54本 → 15本で止まる（段2は銃の部品まで降りるので細かすぎる）
//   level.js    段0が 1本、段2が39本 → 40本まで採る（buildLevel1個の中が地形そのもの）
//   main.js     段0が 3本、段2が 9本 → 21本まで採る
//   audio.js    段2が13本            → 13本（列0の区切りが1本も無い）
// 段の深さだけでも本数だけでも、この4本は同時に拾えない。
const MAX_HEADINGS = 45;

// 区切りのコメント行を拾う。**この書式は元からrepo中で使われている物**で、
// 地図のために新しく決めた物ではない。行番号は出さない（触るたびにずれる上に、
// ずれても誰も気づけない。名前が分かれば grep で一発で行ける）。
function headingsOf(src) {
  const out = [];
  for (const line of src.split('\n')) {
    // 閉じの */ は同じ行に無いことがある（見出しの後に説明が続く長いコメント）ので、
    // 有れば外す形にする。1行目だけ見れば見出しとしては足りる
    const m = line.match(/^(\s*)\/\*\s*-{3,}\s*(.+)$/);
    if (!m) continue;
    // 後ろにも罫線を引く書き方がある（/* ---- 名前 ---- ）ので、そちらも外す
    const text = m[2].replace(/\*\/\s*$/, '').replace(/-{3,}\s*$/, '').trim().replace(/[。、]$/, '');
    if (text) out.push({ text, indent: m[1].length });
  }
  /* **「列0の物が大見出し」とは決められない。** ファイルの作りが2種類あるため:

       関数が並ぶファイル（weapons.js、level.js）… 区切りは列0にも関数の中にも有る
       クラス1個のファイル（audio.js、hud.js）  … 区切りが全部クラスの中で、列0に1本も無い

     最初は列0だけを大見出しにしていて、**1928行のaudio.jsが地図の上で空欄だった。**
     次に「一番浅い段だけ」にしたら、今度は3793行のmain.jsが3本しか出なくなった
     （列0に有るのは読み込み前の小物3つで、中身はクラスの中に9本あった）。

     なので段の深さでは決めず、**浅い順に足していって多くなりすぎた所で止める。** */
  const levels = [...new Set(out.map((h) => h.indent))].sort((a, b) => a - b);
  let cut = levels[0], taken = 0;
  for (const lv of levels) {
    const n = out.filter((h) => h.indent === lv).length;
    if (taken && taken + n > MAX_HEADINGS) break;
    cut = lv;
    taken += n;
  }
  for (const h of out) h.top = h.indent <= cut;
  return out;
}

function filesUnder(dir) {
  const out = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...filesUnder(rel));
    else if (name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

const entries = [...filesUnder('src'), ...filesUnder('server')].map((rel) => {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  return {
    rel,
    lines: src.split('\n').length,
    summary: summaryOf(src),
    headings: headingsOf(src),
  };
});

// ディレクトリごとに束ねる。src/player, src/world のような単位で見たいので
const byDir = new Map();
for (const e of entries) {
  const d = dirname(e.rel);
  if (!byDir.has(d)) byDir.set(d, []);
  byDir.get(d).push(e);
}

const hit = (e) => !NEEDLE
  || e.rel.includes(NEEDLE)
  || e.summary.includes(NEEDLE)
  || e.headings.some((h) => h.text.includes(NEEDLE));

/* 何も絞っていない時は大見出しだけ。
   絞り込んでいる時は、当たった細かい見出しまで出す。探しているのはまさにその1行なので */
const shownHeadings = (e) => (NEEDLE
  ? e.headings.filter((h) => h.top || h.text.includes(NEEDLE))
  : e.headings.filter((h) => h.top));

console.log('\nBLACKOUT の地図');
console.log('  ファイルの冒頭コメントと、区切りのコメント行から組み立てている。');
console.log('  探し物がある時は語を渡す（node tools/map.mjs 発砲）と、関数の中の区切りまで出る。');
console.log('  症状から入口を引きたい時は CLAUDE.md の「どこを見るか」の表。');
if (NEEDLE) console.log(`  ${NEEDLE} で絞り込み中`);

let total = 0;
for (const [dir, list] of byDir) {
  const shown = list.filter(hit);
  const sum = list.reduce((a, e) => a + e.lines, 0);
  total += sum;
  if (!shown.length) continue;
  console.log(`\n${dir}/  (${sum.toLocaleString()}行)`);
  for (const e of shown) {
    const name = relative(dir, e.rel);
    console.log(`  ${name.padEnd(20)} ${String(e.lines).padStart(5)}行  ${e.summary}`);
    // 見出しは長いので折り返す。1行に詰め込むと目で追えない
    const hs = shownHeadings(e);
    if (hs.length) {
      let line = '        ';
      for (const h of hs) {
        if (line.length + h.text.length > 96) { console.log(line); line = '        '; }
        line += `${h.text} / `;
      }
      console.log(line.replace(/ \/ $/, ''));
    }
  }
}

if (!NEEDLE) {
  console.log(`\n合わせて ${total.toLocaleString()}行`);

  // 検査は名前と冒頭1行だけでいい。中身の見出しは要らない（1本が短いので）
  console.log('\ntools/  (ブラウザ無しで走る検査。npm run check で全部走る)');
  for (const f of readdirSync(join(ROOT, 'tools')).sort()) {
    if (!f.startsWith('check-') || !f.endsWith('.mjs')) continue;
    const s = summaryOf(readFileSync(join(ROOT, 'tools', f), 'utf8'));
    console.log(`  ${f.replace(/^check-|\.mjs$/g, '').padEnd(14)} ${s}`);
  }
}

console.log('');
