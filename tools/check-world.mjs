// 地形を組むのに要るメモリと、Octreeの形を測る。
//
// なぜ要るか: ここが膨らむとクラウドのマシンを大きくするしかなくなり、
// そのまま毎月の出費になる。実際、1GB(月$5〜6)から512MB(月$3)へ戻せたのは
// Octreeの組み方を変えたから。
//
// 一度下げても、地形に物を足せば静かに戻る。**戻ったことに気づけるのは数字だけ**
// （画面を見ても分からないし、手元のパソコンでは何GBあっても動いてしまう）。
//
//   node tools/check-world.mjs
import '../server/dom-stub.js';

const { buildWorld } = await import('../server/world.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const w = buildWorld();

console.log('\n[1] Octreeが深く割れすぎていない');
// three付属の実装は葉に8三角形まで、深さ16まで割る。
// そのまま組むと深さ12・節点26,960まで行き、組む途中の記憶が448MB要った。
// level.jsのbuildOctreeが、各節点の split の頭で閾値を入れ直して浅く保つ
{
  let nodes = 0, leaves = 0, depth = 0, worstLeaf = 0;
  (function walk(n, d) {
    nodes++;
    depth = Math.max(depth, d);
    if (!n.subTrees.length) { leaves++; worstLeaf = Math.max(worstLeaf, (n.triangles || []).length); }
    for (const s of n.subTrees) walk(s, d + 1);
  })(w.octree, 0);

  ok(depth <= 14, `深さ ${depth}（上限14）`);
  ok(nodes < 60000, `節点 ${nodes.toLocaleString()}（6万未満）`);
  // 葉が太りすぎると、1回の判定で総当たりする数が増えて当たり判定が遅くなる。
  // 浅くするのと速さは引き換えなので、上限も見る
  ok(worstLeaf <= 64, `一番太い葉 ${worstLeaf}個（上限64）`);
  console.log(`  （葉 ${leaves.toLocaleString()}）`);
}

console.log('\n[2] 抱えているメモリ');
// ここは「組んだ直後の値」ではなく、ゴミを片付けた後の本当の量を見る。
// 前にこれを取り違えて、431MBという実際の7倍の数字を課題に書いていた
if (typeof global.gc === 'function') {
  global.gc(); global.gc();
  const mb = process.memoryUsage().heapUsed / 1024 / 1024;
  ok(mb < 120, `ゴミを片付けた後 ${mb.toFixed(0)}MB（上限120MB）`);
} else {
  console.log('  － ゴミの片付けを頼めないので飛ばす（--expose-gc を付けると測る）');
}

console.log('\n[3] 地形の指紋が変わっていない');
// 三角形数とOctreeの節点数が形そのものを表す。
// ここがずれたらクライアントとサーバーで別の地形を見ていることになる
ok(w.stats.tris > 0, `三角形 ${w.stats.tris.toLocaleString()}`);
ok(Array.isArray(w.arenaSpawns) && w.arenaSpawns.length >= 4, `対戦の湧き場所 ${w.arenaSpawns.length}箇所`);

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
