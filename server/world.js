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

// 組み上がった地形が「いつものマップ」であることの指紋。マップごとに持つ。
// 地形が変わればここがずれるので、対戦が始まる前に気づける。
// meshesはlevel.jsの結合の仕方で動くため参考値、
// 三角形数とOctreeのノード数が形そのものを表す
// 2026-08-08: 三角形198344→184520。見た目の地面板の分割を96×96→48×48へ
// 落とした分（軽量化。当たり判定は別の板なのでOctreeのノード数は動いていない）
// 2026-08-09: 184520→184650。建物A・Bの入口が塞がっていたのを開けた分
// （基礎の段差の切り欠き＋重なった開口の積み方の直し。壁が細かく割れるので増える）
// 2026-08-14: 江戸ステージ(edo)を追加。urbanの値はそのまま動いていない
const EXPECT = {
  urban: { tris: 184650, nodes: 26234 },
  edo: { tris: 8824, nodes: 2872 },
};

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

// マップごとに1回だけ組んで使い回す（部屋が増えても地形は共有）
const cached = new Map();

// Playerのコンストラクタはlevel.octree / level.bounds / level.playerSpawn しか見ないので、
// この戻り値をそのまま「level」として渡せる
export function buildWorld(mapId = 'urban') {
  const hit = cached.get(mapId);
  if (hit) return hit;

  const t0 = Date.now();
  const level = buildLevel(MATS, { mapId });
  const stats = measure(level);
  const ms = Date.now() - t0;

  const expect = EXPECT[mapId] || EXPECT.urban;
  console.log(`[world] 地形を組んだ(${mapId}) ${ms}ms  メッシュ${stats.meshes} 三角形${stats.tris} Octreeノード${stats.nodes}`);
  if (stats.tris !== expect.tris || stats.nodes !== expect.nodes) {
    console.warn(`[world] 警告: 期待値と違う (三角形${expect.tris} ノード${expect.nodes})。`
      + 'クライアントと地形がずれている可能性がある');
  }

  const world = {
    mapId,
    octree: level.octree,
    bounds: level.bounds,
    playerSpawn: level.playerSpawn,
    // 湧き地点は対戦用の8箇所。場内の中央（protocol.jsのZONE）に収まっている。
    // 敵用のenemySpawnsは場内全域に散っていて1つも範囲内に無いので流用できない
    // （流用すると湧いた瞬間に全員が範囲外で、出てきた端から削られる）
    arenaSpawns: level.arenaSpawns,
    // 2対2の湧き地点。味方2人が並んで出る4箇所（席番号でそのまま引く）
    teamSpawns: level.teamSpawns,
    enemySpawns: level.enemySpawns,
    stats,
  };
  cached.set(mapId, world);
  return world;
}
