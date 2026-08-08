// 地形の「描く量」が増える方向へ戻っていないかの検査。
//
// なぜ要るか: PCが熱くなる件の調査（2026-08-08）で、地形側に
// 「毎フレーム必ず払う固定費」が3つ見つかった。
//   1. 路面の貼り分け板13枚が影を落としていた（コメントは「落とさない」と
//      書いてあるのに実装が違った。数cm浮いた板の影は自己遮蔽の縞の温床でもある）
//   2. 見た目の地面板が96×96分割=18,432三角形で、420m四方あるため
//      視錐台カリングで一度も落ちず、どこを向いても全部描かれていた
//   3. デカール132枚が1枚ずつ独立材質で、埋まりきると132draw/フレームが定常化
// どれも「1行の数字を戻すだけ」で静かに再発するので、実物を組んで測る。
//
//   node tools/check-worldgeo.mjs
import * as THREE from 'three';
import '../server/dom-stub.js';
import { readFileSync } from 'node:fs';
import { buildLevel } from '../src/world/level.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 材質はサーバーの地形組みと同じ手（見た目の中身は要らないので1個を使い回す）
const SHARED = new THREE.MeshStandardMaterial();
const MATS = new Proxy({}, { get: () => SHARED });
const level = buildLevel(MATS);

console.log('\n[1] 路面の貼り分け板は影を落とさない');
{
  /* 板の見分け方: 貼り分け板だけがtransparent+depthWrite=false+polygonOffsetの
     3点セットを持つ（buildPatch参照）。この組で拾って全部castShadow=falseを確かめる */
  let patches = 0, casting = 0;
  level.root.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material;
    if (m?.transparent && m.depthWrite === false && m.polygonOffset) {
      patches++;
      if (o.castShadow) casting++;
    }
  });
  ok(patches >= 10, `貼り分け板が見つかる（${patches}枚）`);
  ok(casting === 0, `影を落とす板が無い（今${casting}枚）`);
}

console.log('\n[2] 見た目の地面板の分割');
{
  // 420m四方の板はカリングが効かないので、分割数=毎フレームの固定費。
  // 96×96(18,432三角形)へ戻すと、それだけで約14,000三角形/フレーム増える
  const src = readFileSync(new URL('../src/world/level.js', import.meta.url), 'utf8');
  ok(/PlaneGeometry\(420, 420, 48, 48\)/.test(src), '地面板は48×48のまま');
}

console.log('\n[3] デカールの枠');
{
  const src = readFileSync(new URL('../src/world/effects.js', import.meta.url), 'utf8');
  // 枠の数がそのまま描画命令の数になる（1枚ずつ独立材質のため）。
  // 増やしたくなったら、先に材質の共有かインスタンス化を
  const m = src.match(/constructor\(scene, max = (\d+), reserved = (\d+), splashes = (\d+)\)/);
  ok(!!m, 'デカールの枠の定義が見つかる');
  ok(m && parseInt(m[1], 10) <= 72, `枠は72以下（今${m?.[1]}）`);
}

console.log('\n[4] 壁と小物は異方性フィルタを上限まで使わない');
{
  // 異方性の上限(多くの環境で16)が要るのは視線が寝る地面系だけ。
  // 壁・小物へ配ると、そのぶん帯域を16タップ側で払う
  const src = readFileSync(new URL('../src/world/textures.js', import.meta.url), 'utf8');
  ok(/const ANISO_WALL = 4;/.test(src), '壁・小物用の低い値がある');
  // 壁系の代表4つが低い側を使っている（全部並べると表の書き替えで検査が崩れるので代表）
  for (const name of ['metal:', 'brick:', 'plaster:', 'corrugated:']) {
    const re = new RegExp(`${name} mk\\([^)]*\\{ aniso: ANISO_WALL`);
    ok(re.test(src), `${name.slice(0, -1)} が低い側`);
  }
  // 地面系は上限のまま（モアレ対策。textures.jsのコメント参照）
  ok(!/asphalt: mk\([^)]*aniso: ANISO_WALL/.test(src), 'asphaltは上限のまま');
  ok(!/dirt: mk\([^)]*aniso: ANISO_WALL/.test(src), 'dirtは上限のまま');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
