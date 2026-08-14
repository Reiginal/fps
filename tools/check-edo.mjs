// 江戸ステージ（2つ目のマップ）の検査。
//
// なぜ要るか: level.jsのbuildLevel()にmapIdの分岐を足したので、
// **既存の市街地(urban)を壊していないこと**と、**江戸(edo)がちゃんと組めること**の
// 両方を確かめないといけない。特にurbanは1年近く手を入れて詰めてある地形なので、
// ここが1三角形でもずれたらクライアントとサーバーの地形が食い違う。
//
//   node tools/check-edo.mjs
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import '../server/dom-stub.js';
import { readFileSync } from 'node:fs';
import { buildLevel } from '../src/world/level.js';
import { MAP_LIST, MAP_IDS, PHASE } from '../src/net/protocol.js';

const { buildWorld } = await import('../server/world.js');
const { getRoom } = await import('../server/room.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const SHARED = new THREE.MeshStandardMaterial();
const MATS = new Proxy({}, { get: () => SHARED });

console.log('\n[1] マップの一覧');
{
  ok(MAP_IDS.length === 2, `マップは2種類（${MAP_IDS.join('、')}）`);
  ok(MAP_IDS[0] === 'urban', '既定は市街地');
  ok(MAP_IDS.includes('edo'), '江戸が入っている');
  ok(MAP_LIST.every((m) => m.id && m.name && m.desc), '名前と説明が全部揃っている');
}

console.log('\n[2] 市街地(urban)は今まで通り組める（既存への影響が無い）');
{
  const urban = buildLevel(MATS, { mapId: 'urban' });
  // server/world.jsのEXPECTと同じ値。ここがずれたら向こうも直す
  ok(urban.arenaSpawns.length === 8, '対戦の湧き場所は8箇所のまま');
  ok(urban.teamSpawns.length === 4, '2対2の湧き場所は4箇所のまま');
  ok(urban.bounds === 40, '場外の壁は40のまま');
}

console.log('\n[3] 江戸(edo)が組める');
{
  const edo = buildLevel(MATS, { mapId: 'edo' });
  let tris = 0;
  edo.root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  /* 密度の下限。**一番最初の江戸はここが8,824三角形しかなかった**
     （市街地は208,102で、21分の1）。中身は板塀・社1棟・町屋4棟・
     灯籠4個・酒樽4組・木箱4個だけで、地面の敷き分けが1枚も無く、
     実際に遊んだ画は「砂漠に木箱が置いてある」だった。
     形が組めるかどうかだけ見ていても、この状態は通ってしまう */
  ok(tris > 30000, `町として組み上がっている（${tris.toLocaleString()}三角形。8,824だった頃は砂漠だった）`);
  ok(edo.enemySpawns.length >= 8, `1人用/協力プレイ向けの湧き場所がある（${edo.enemySpawns.length}箇所）`);
  ok(edo.arenaSpawns.length === 8, '対戦の湧き場所は8箇所（urbanと同じ並びの型を流用）');
  ok(edo.teamSpawns.length === 4, '2対2の湧き場所は4箇所');
  ok(edo.coverPoints.length >= 30, `遮蔽物リストがある（${edo.coverPoints.length}箇所）`);
  ok(edo.bounds > 0 && edo.bounds !== 40, `場外の壁は市街地と別の値（${edo.bounds}）`);
  ok(edo.playerSpawn.z !== 26, '1人用の湧き位置も市街地と別');

  /* **湧き地点が地形に埋まっていないか、Octreeに当てて実測する。**
     「中央の社に入っていないか」だけ見ていた頃は、町屋を建て直した瞬間に
     4箇所が井戸と19cm重なり、(0,28)の開始位置は町屋の中だった。
     目分量で座標を書く限り必ずまた踏むので、機械に測らせる */
  const ray = new THREE.Ray();
  const cap = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.34);
  const buried = [];
  const check = (label, list) => {
    for (const sp of list) {
      ray.set(new THREE.Vector3(sp.x, 20, sp.z), new THREE.Vector3(0, -1, 0));
      const hit = edo.octree.rayIntersect(ray);
      const gy = hit ? 20 - hit.distance : null;
      if (gy === null) { buried.push(`${label}(${sp.x},${sp.z}) 地面が無い`); continue; }
      // 屋根の上に湧かせない。立ち姿のカプセルが地形に食い込まないことも見る
      if (gy > 1.3) { buried.push(`${label}(${sp.x},${sp.z}) 地面が${gy.toFixed(1)}m＝屋根の上`); continue; }
      cap.start.set(sp.x, gy + 0.34, sp.z);
      cap.end.set(sp.x, gy + 1.75 - 0.34, sp.z);
      const stuck = edo.octree.capsuleIntersect(cap);
      if (stuck && stuck.depth > 0.05) {
        buried.push(`${label}(${sp.x},${sp.z}) ${stuck.depth.toFixed(2)}m埋まる`);
      }
    }
  };
  check('敵', edo.enemySpawns);
  check('対戦', edo.arenaSpawns);
  check('2対2', edo.teamSpawns);
  check('開始', [edo.playerSpawn]);
  ok(buried.length === 0, `湧き地点が地形に埋まっていない${buried.length ? `：${buried.join(' / ')}` : ''}`);

  // 境内の中から湧かない。中央から出てくると、押し寄せてくる形が消える
  const inPrecinct = (v) => Math.abs(v.x) < 15.5 && Math.abs(v.z) < 15.5;
  ok(edo.enemySpawns.every((v) => !inPrecinct(v)), '敵は境内の外（町の外縁）から入ってくる');
}

console.log('\n[4] server/world.jsがマップごとに組み分ける');
{
  const urban = buildWorld('urban');
  const edo = buildWorld('edo');
  ok(urban.mapId === 'urban' && edo.mapId === 'edo', 'mapIdを覚えている');
  ok(urban.stats.tris !== edo.stats.tris, '別の地形として組まれている');
  // 2回目は組み直さない（キャッシュされている）ことを、参照の一致で確かめる
  ok(buildWorld('urban') === urban, 'urbanは組み直さず使い回す');
  ok(buildWorld('edo') === edo, 'edoは組み直さず使い回す');

  const src = readFileSync(new URL('../server/world.js', import.meta.url), 'utf8');
  const m = src.match(/edo: \{ tris: (\d+), nodes: (\d+) \}/);
  ok(!!m, 'EXPECT.edoが定義されている');
  ok(m && parseInt(m[1], 10) === edo.stats.tris, `EXPECT.edoの三角形数が実測と合っている（${edo.stats.tris}）`);
  ok(m && parseInt(m[2], 10) === edo.stats.nodes, `EXPECT.edoのOctreeノード数が実測と合っている（${edo.stats.nodes}）`);
}

console.log('\n[5] 部屋でマップを選べる（setModeと同じ作法）');
{
  const world = buildWorld('urban');
  const room = getRoom(world);
  for (const s of [...room.slots.values()]) room.leave(s);
  room.phase = PHASE.WAIT;
  room.map = 'urban';
  room.world = buildWorld('urban');

  ok(room.map === 'urban', '既定は市街地');
  ok(room.setMap('edo') === true, '江戸へ変えられる');
  ok(room.map === 'edo', '変わっている');
  ok(room.world.mapId === 'edo', 'this.worldも江戸の地形に差し替わっている');
  ok(room.setMap('edo') === false, '同じ物をもう一度押しても何も起きない');
  ok(room.setMap('しらないマップ') === false, '知らない名前は断る');
  ok(room.map === 'edo', '断った後も元のまま');

  room.phase = PHASE.LIVE;
  ok(room.setMap('urban') === false, '試合中は変えられない');
  room.phase = PHASE.WAIT;
  room.setMap('urban');
}

console.log('\n[6] 江戸用の材質がtextures.jsに揃っている');
{
  const src = readFileSync(new URL('../src/world/textures.js', import.meta.url), 'utf8');
  for (const name of ['timberSiding', 'kawara', 'packedEarth', 'shojiPaper']) {
    ok(new RegExp(`${name}: mk\\(`).test(src), `${name} がbuildMaterials()の戻り値にある`);
  }
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
