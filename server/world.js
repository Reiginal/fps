// 地形をNode上で組む。クライアントと同じlevel.jsを使うので、
// 壁の位置も段差の高さも1mmの差もなく一致する。
// 別々に用意すると「サーバーでは壁、クライアントでは通路」が必ずどこかで生まれる。
import './dom-stub.js';
import * as THREE from 'three';
import { buildLevel } from '../src/world/level.js';

// 素材は見た目の話なので、何を聞かれても同じ物を返す。
// 実際にテクスチャを焼くと数秒と数百MBを払って、衝突判定には一切効かない
const SHARED_MAT = new THREE.MeshStandardMaterial();
const MATS = new Proxy({}, { get: () => SHARED_MAT });

// 組み上がった地形が「いつものマップ」であることの指紋。
// 地形が変わればここがずれるので、対戦が始まる前に気づける。
// meshesはlevel.jsの結合の仕方で動くため参考値、
// 三角形数とOctreeのノード数が形そのものを表す
// 2026-08-08: 三角形198344→184520。見た目の地面板の分割を96×96→48×48へ
// 落とした分（軽量化。当たり判定は別の板なのでOctreeのノード数は動いていない）
const EXPECT = { tris: 184520, nodes: 26175 };

function measure(level) {
  let meshes = 0;
  let tris = 0;
  level.root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  let nodes = 0;
  (function walk(n) {
    nodes++;
    for (const s of n.subTrees) walk(s);
  })(level.octree);
  return { meshes, tris, nodes };
}

let cached = null;

// Playerのコンストラクタはlevel.octree / level.bounds / level.playerSpawn しか見ないので、
// この戻り値をそのまま「level」として渡せる
export function buildWorld() {
  if (cached) return cached;

  const t0 = Date.now();
  const level = buildLevel(MATS);
  const stats = measure(level);
  const ms = Date.now() - t0;

  console.log(`[world] 地形を組んだ ${ms}ms  メッシュ${stats.meshes} 三角形${stats.tris} Octreeノード${stats.nodes}`);
  if (stats.tris !== EXPECT.tris || stats.nodes !== EXPECT.nodes) {
    console.warn(`[world] 警告: 期待値と違う (三角形${EXPECT.tris} ノード${EXPECT.nodes})。`
      + 'クライアントと地形がずれている可能性がある');
  }

  cached = {
    octree: level.octree,
    bounds: level.bounds,
    playerSpawn: level.playerSpawn,
    // 湧き地点は対戦用の8箇所。場内の中央（protocol.jsのZONE）に収まっている。
    // 敵用のenemySpawnsは場内全域に散っていて1つも範囲内に無いので流用できない
    // （流用すると湧いた瞬間に全員が範囲外で、出てきた端から削られる）
    arenaSpawns: level.arenaSpawns,
    enemySpawns: level.enemySpawns,
    stats,
  };
  return cached;
}
