// 検査を全部走らせる。手元でもCIでもこれ1本。
//
//   npm run check        通った物は1行ずつ、落ちた物だけ中身を全部出す
//   npm run check -- -v  全部の中身を出す
//
// なぜ作ったか。理由が2つある。
//
// 1. **速さ。** 前は33本を1本ずつ順番に走らせていて、CIで55秒かかっていた。
//    そのうち音の質の1本だけで15秒あり、残り32本はその間ずっと待っていた。
//    検査どうしは何も共有していない（それぞれ別のプロセスで、書き込む先も無い）ので、
//    待つ理由がそもそも無い。CPUの数だけ同時に走らせる。
//    こうすると全体の時間は「一番長い1本」に近づく
//
// 2. **繋ぎ忘れが起こせなくなる。** 前は一覧が3箇所（tools/の実物・package.json・
//    ci.yml）にあって、全部手書きだった。放っておけば必ずずれるので、
//    ずれを見張るための検査(check-meta.mjs)を別に持つ羽目になっていた。
//    ここが tools/ を自分で読むようにしたので、**ファイルを置いた時点で走る。**
//    書いたのに1度も走らない、が作れない
//
// 項目の数もここが数える。前はCLAUDE.mdに手で書いた数字があって、
// 検査を足すたびに数え直す約束にしていたが、当然ずれた。
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { availableParallelism, cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const VERBOSE = process.argv.includes('-v');

/* **時間のかかる物から先に始める。** 順番はここでしか効かない（結果は変わらない）。
   長い1本を最後に回すと、他が全部終わった後にそれ1本を待つ時間が生まれる。
   先に始めておけば、その裏で短い物が流れていく。

   結果は変わらないが、名前を打ち間違えたり消した検査の名前が残っていると、
   **速くしたつもりのまま元の遅さに戻る**（しかも緑のままなので気づけない）。
   実在するかは check-meta.mjs の[4]が見ている */
const HEAVY = [
  'check-scope.mjs',        // 照準へ放射状にレイを当てて測る。一番長い（実測15秒）
  'check-sound.mjs',        // 音を実際に計算して測る（実測10秒）
  'check-swarm.mjs',        // 敵を大量に動かす（実測9秒）
  'check-loadout.mjs',
  'check-reload.mjs',
  'check-skins.mjs',
  'check-rays.mjs',
  'check-audio-leak.mjs',
  'check-syntax.mjs',       // ファイルの数だけ node --check を起こす
  'check-heal.mjs',
];

const all = readdirSync(join(ROOT, 'tools'))
  .filter((f) => f.startsWith('check-') && f.endsWith('.mjs'))
  .sort();

const rank = (f) => { const i = HEAVY.indexOf(f); return i === -1 ? HEAVY.length : i; };
const queue = [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

const LANES = Math.max(1, Math.min(queue.length, availableParallelism?.() ?? cpus().length));

/* 1本走らせて、出た物を全部ためる。**その場では出さない。**
   同時に走っているので、垂れ流すと何本もの出力が行単位で混ざって読めなくなる。

   --expose-gc は check-world.mjs だけが要るが、全部に付けている。
   要る物だけに付ける表を持つと、その表がまた繋ぎ忘れの置き場になる。
   付いていても他の検査は触らないので害が無い */
const run = (file) => new Promise((res) => {
  const at = Date.now();
  const p = spawn(process.execPath, ['--expose-gc', join('tools', file)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  p.on('error', (e) => res({ file, code: 1, out: `起動できなかった: ${e.message}`, ms: Date.now() - at }));
  p.on('close', (code) => res({ file, code, out, ms: Date.now() - at }));
});

const started = Date.now();
const done = [];
let next = 0;

// レーンの数だけ同時に走らせる。1本終わったら、そのレーンが次を取りに行く
await Promise.all(Array.from({ length: LANES }, async () => {
  while (next < queue.length) {
    const r = await run(queue[next++]);
    done.push(r);
    // 終わった順に1行だけ出す。「止まっていない」が見えるのが大事
    const items = (r.out.match(/^\s+[○×]/gm) || []).length;
    const mark = r.code === 0 ? '○' : '×';
    console.log(`  ${mark} ${r.file.padEnd(26)} ${(r.ms / 1000).toFixed(1)}秒  ${items}項目`);
    if (VERBOSE) console.log(r.out);
  }
}));

const items = done.reduce((n, r) => n + (r.out.match(/^\s+[○×]/gm) || []).length, 0);
const failed = done.filter((r) => r.code !== 0).sort((a, b) => a.file.localeCompare(b.file));

/* **落ちた物だけ中身を出す。** 全部出すと1400行流れて、
   その中の1行の「×」を目で探すことになる。通った時に読む物ではない */
for (const r of failed) {
  console.log(`\n${'='.repeat(60)}\n落ちた: ${r.file}\n${'='.repeat(60)}`);
  console.log(r.out);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(failed.length === 0
  ? `\n全部通った  ${all.length}本 ${items}項目  ${secs}秒（同時に${LANES}本）`
  : `\n${failed.length}本 落ちた（${failed.map((r) => r.file).join('、')}）  ${secs}秒`);
process.exit(failed.length === 0 ? 0 : 1);
