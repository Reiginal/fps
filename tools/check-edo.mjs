// 江戸ステージ（2つ目のマップ）の検査。
//
// なぜ要るか: level.jsのbuildLevel()にmapIdの分岐を足したので、
// **既存の市街地(urban)を壊していないこと**と、**江戸(edo)がちゃんと組めること**の
// 両方を確かめないといけない。特にurbanは1年近く手を入れて詰めてある地形なので、
// ここが1三角形でもずれたらクライアントとサーバーの地形が食い違う。
//
//   node tools/check-edo.mjs
import * as THREE from 'three';
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
  ok(tris > 1000, `三角形が組める（${tris.toLocaleString()}）`);
  ok(edo.enemySpawns.length >= 8, `1人用/協力プレイ向けの湧き場所がある（${edo.enemySpawns.length}箇所）`);
  ok(edo.arenaSpawns.length === 8, `対戦の湧き場所は8箇所（urbanと同じ並びの型を流用）`);
  ok(edo.teamSpawns.length === 4, '2対2の湧き場所は4箇所');
  ok(edo.coverPoints.length >= 10, `遮蔽物リストがある（${edo.coverPoints.length}箇所）`);
  ok(edo.bounds > 0 && edo.bounds !== 40, `場外の壁は市街地と別の値（${edo.bounds}）`);
  ok(edo.playerSpawn.z !== 26, '1人用の湧き位置も市街地と別');

  // 湧き地点が原点付近の建物(中央9x9、半径4.5)に埋まっていないか。
  // 江戸の建物配置を変えた時に自分で踏む地雷を、ここで機械的に拾う
  const insideCenter = (v) => Math.abs(v.x) < 4.5 && Math.abs(v.z) < 4.5;
  for (const list of [edo.enemySpawns, edo.arenaSpawns, edo.teamSpawns]) {
    ok(list.every((v) => !insideCenter(v)), '中央の社の中に湧き地点が無い');
  }
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
