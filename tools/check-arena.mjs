// 対戦の戦域（中心から半径20m）の点対称度の検査。
//
// なぜ要るか: 対戦の湧きは中心を挟んで向かい合う（±17.5,0 と 0,±17.5）。
// 戦域の地形が180度回して重ならないと、片方の組だけ掩体に正面から入れる・
// 片方にだけ胸の高さの遮蔽がある、という形の不利がそのまま勝率になる
// （2026-08-14に「普通対称でしょ、片方不利やろ」と言われて直した所）。
//
// 測り方: 格子点(0.5m刻み)ごとに細い当たり判定を高さ4段で置いて、
// 180度回した点(-x,-z)と食い違う割合を数える。
// 0%にはならない。理由は2つあって、どちらも直さないと決めた種類:
//   ・建物（事務所棟・倉庫等）の角が戦域の縁に少し食い込んでいる。
//     建物ごと動かすのはマップの作り直しなので、縁の食い込みは受け入れる
//   ・木箱の山や土嚢は「対の位置に同じ種類の山」を置いてあるが、
//     中身の乱数で形が違う（形まで揃えると絵が複製になる）
// 対称化する前は36.3%だった。細かい配置の直しでじわじわ悪化しないよう、
// 上限をそこから十分離れた所（下の値）に置いて見張る。
//
//   node tools/check-arena.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';

const { buildWorld } = await import('../server/world.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const HEIGHTS = [0.5, 1.1, 1.7, 2.4];
const R = 21;
const STEP = 0.5;

/** 戦域内の点対称の食い違い率（0..1）を測る */
function asymmetryOf(world) {
  const probe = (x, y, z) => {
    const cap = new Capsule(
      new THREE.Vector3(x, y - 0.2, z),
      new THREE.Vector3(x, y + 0.2, z),
      0.22,
    );
    return world.octree.capsuleIntersect(cap) ? 1 : 0;
  };
  const cells = new Map();
  const key = (x, z) => `${x.toFixed(1)},${z.toFixed(1)}`;
  for (let x = -R; x <= R + 1e-6; x += STEP) {
    for (let z = -R; z <= R + 1e-6; z += STEP) {
      if (Math.hypot(x, z) > R) continue;
      let bits = 0;
      for (let i = 0; i < HEIGHTS.length; i++) bits |= probe(x, HEIGHTS[i], z) << i;
      cells.set(key(x, z), bits);
    }
  }
  let total = 0;
  let mismatch = 0;
  for (const [k, bits] of cells) {
    const [xs, zs] = k.split(',');
    const x = parseFloat(xs);
    const z = parseFloat(zs);
    if (x < 0 || (x === 0 && z < 0)) continue;
    const twin = cells.get(key(-x, -z));
    if (twin === undefined) continue;
    total++;
    if (bits !== twin) mismatch++;
  }
  return { ratio: mismatch / total, total, mismatch };
}

console.log('\n[1] 市街地(urban)の戦域が概ね点対称');
{
  const r = asymmetryOf(buildWorld('urban'));
  // 直した時点の実測は17.6%。建物の縁と山の乱数ぶんの床がここに残る。
  // 20%を超えたら、誰かが戦域内へ対の無い遮蔽を足したということ
  ok(r.ratio < 0.20, `食い違い ${(r.ratio * 100).toFixed(1)}%（上限20%。対称化前は36.3%）`);
  console.log(`  （${r.total}点を比べて${r.mismatch}点）`);
}

console.log('\n[2] 江戸(edo)の戦域も概ね点対称');
{
  const r = asymmetryOf(buildWorld('edo'));
  // 江戸は最初から対で置いてあるので床が低い。緩めの上限で見張るだけ
  ok(r.ratio < 0.15, `食い違い ${(r.ratio * 100).toFixed(1)}%（上限15%）`);
  console.log(`  （${r.total}点を比べて${r.mismatch}点）`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
