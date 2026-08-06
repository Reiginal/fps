// 全部のファイルが、そもそも文として読めるかを見る。
//
// なぜ要るか: 他の検査は **import した物しか見ない。**
// どこからも読まれていないファイル（例: src/world/level.js）は、
// 中で括弧が閉じていなくても検査が1本も落ちない。
// 後でそこを読み込むように繋いだ日に、初めて真っ黒になって出てくる。
//
// 前はこれをci.ymlの中にシェルのfor文で書いていた。
// **CIにしか無いので、手元では1度も走らなかった。**
// pushして30秒待って赤くなって初めて気づく、という形になっていたので、
// 他の検査と同じ場所へ移した。
//
// node --check は「文として読めるか」だけを見る。読み込み先が本当にあるかは見ない
// （それは check-imports.mjs の担当）。
//
//   node tools/check-syntax.mjs
import { readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* 見る場所。node_modules は他人の物なので見ない（数が桁違いに増えるだけで、
   こちらが直せる物は1つも出てこない） */
const ROOTS = ['src', 'server', 'tools', 'e2e'];
// 置き場を持たない、根に直に置いてある物
const LOOSE = ['eslint.config.mjs', 'playwright.config.mjs'];

const walk = (dir, out = []) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
};

const files = [];
for (const r of ROOTS) {
  try { walk(join(ROOT, r), files); } catch { /* 無い置き場は飛ばす */ }
}
for (const f of LOOSE) {
  try { statSync(join(ROOT, f)); files.push(join(ROOT, f)); } catch { /* 無ければ飛ばす */ }
}
files.sort();

const check = (file) => new Promise((res) => {
  execFile(process.execPath, ['--check', file], (err) => res(err));
});

/* 1本ずつ順に起こすとファイルの数だけ待つことになるので、CPUの数だけ同時に起こす。
   ここは run-checks.mjs から見ると1本の検査なので、その中でも並べておかないと
   ここだけが長い1本になる */
console.log(`\n[1] 全部のファイルが文として読める（${files.length}本）`);
const LANES = Math.max(1, availableParallelism?.() ?? cpus().length);
let next = 0;
const errs = new Map();
await Promise.all(Array.from({ length: LANES }, async () => {
  while (next < files.length) {
    const f = files[next++];
    const e = await check(f);
    if (e) errs.set(f, e);
  }
}));

for (const f of files) {
  const e = errs.get(f);
  ok(!e, relative(ROOT, f) + (e ? `\n${String(e.stderr || e.message).trim()}` : ''));
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
