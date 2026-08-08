// 遠い方の影マップの門番（src/world/shadowgate.js）の検査。
//
// あの門番が緩いと、3フレームごとに517枚を丸ごと焼き直す元の形へ戻る。
// 逆に固すぎると、遠くで敵が動いているのに影が止まったままになる。
// どちらも画面を見ないと分からない壊れ方なので、判定だけを机上で全部叩く。
//
//   node tools/check-shadowgate.mjs

import { FarShadowGate } from '../src/world/shadowgate.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 1回の判定をまとめて回す助っ人。casters = [{x, z, settled}]
const check = (gate, camX, camZ, casters) => {
  gate.begin(camX, camZ);
  for (const c of casters) gate.add(c.x, c.z, !!c.settled);
  return gate.end();
};

console.log('\n[1] 最初は必ず焼く');
{
  const g = new FarShadowGate();
  ok(check(g, 0, 0, []) === true, '誰も居なくても初回は焼く（地形をまだ焼いていない）');
  ok(check(g, 0, 0, []) === false, '2回目は焼かない（何も変わっていない）');
}

console.log('\n[2] 遠くの生きた敵');
{
  const g = new FarShadowGate();
  check(g, 0, 0, []);
  ok(check(g, 0, 0, [{ x: 30, z: 0 }]) === true, '遠くに現れたら焼く');
  ok(check(g, 0, 0, [{ x: 30, z: 0 }]) === true, '居る間は毎回焼く（歩き・構えで姿勢が動き続ける）');
}

console.log('\n[3] 近くの敵は近い枚の担当');
{
  const g = new FarShadowGate();
  check(g, 0, 0, []);
  ok(check(g, 0, 0, [{ x: 5, z: 5 }]) === false, '近い枚の中に居る間は焼かない');
  ok(check(g, 0, 0, [{ x: 8, z: 0 }]) === false, '近い枚の中で動いても焼かない');
  ok(check(g, 0, 0, [{ x: 20, z: 0 }]) === true, '近い枚の外へ出たら焼く');
}

console.log('\n[4] 落ち着いた死体は指紋で見る');
{
  const g = new FarShadowGate();
  check(g, 0, 0, []);
  ok(check(g, 0, 0, [{ x: 30, z: 10, settled: true }]) === true, '遠くで死体が落ち着いたら1回焼く');
  ok(check(g, 0, 0, [{ x: 30, z: 10, settled: true }]) === false, '同じ死体のままなら、もう焼かない');
  ok(check(g, 0, 0, [{ x: 30, z: 10, settled: true }, { x: 40, z: -5, settled: true }]) === true,
    '死体が増えたら焼く');
  ok(check(g, 0, 0, [{ x: 40, z: -5, settled: true }]) === true, '死体が片付いても焼く（置き去りの影が残るので）');
  ok(check(g, 0, 0, [{ x: 40, z: -5, settled: true }]) === false, 'その後は焼かない');
}

console.log('\n[5] カメラが動いて担当が替わる');
{
  const g = new FarShadowGate();
  // 死体のそばで焼いた後、離れる。近い枚の担当だった死体が遠い枚の担当になるので、
  // 焼いた時の指紋(死体なし)と今(死体あり)がずれて1回焼き直しになる
  check(g, 0, 0, [{ x: 5, z: 0, settled: true }]);
  ok(check(g, 30, 0, [{ x: 5, z: 0, settled: true }]) === true, '離れたら焼き直す');
  ok(check(g, 30, 0, [{ x: 5, z: 0, settled: true }]) === false, '止まっていればそれきり');
}

console.log('\n[6] 混ざっている時');
{
  const g = new FarShadowGate();
  check(g, 0, 0, []);
  const mixed = [
    { x: 4, z: 2 },                      // 近くで生きている（近い枚の担当）
    { x: 25, z: 0, settled: true },      // 遠くの死体
  ];
  ok(check(g, 0, 0, mixed) === true, '遠くの死体が新しく数えられた回は焼く');
  ok(check(g, 0, 0, mixed) === false, '近くで生きた敵が動いても、遠くが変わらなければ焼かない');
  mixed.push({ x: 30, z: 30 });          // 遠くに生きた敵が来た
  ok(check(g, 0, 0, mixed) === true, '遠くに生きた敵が来たら焼く');
}

console.log('\n[7] main.jsが門番を通している');
{
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/new FarShadowGate\(\)/.test(main), '門番を持っている');
  // 無条件の needsUpdate = true が interval>1 の枝に戻っていないこと。
  // 門番の返事を見てから立てる形だけを許す
  ok(/if \(g\.end\(\)\) c\.light\.shadow\.needsUpdate = true;/.test(main),
    '門番がうんと言った時だけ焼く');
  /* ソロで数えるのは落ち着いた死体だけ。生きた敵をここへ戻すと、
     castShadowを切ってある（＝写りもしない）敵が歩くたびに
     500枚超の焼き直しが走る元の形へ戻る */
  ok(/if \(e\.alive \|\| !e\.deathSettled \|\| !e\.root\.visible\) continue;/.test(main),
    'ソロは落ち着いた死体だけを数えている');
}

console.log('\n[8] 敵の影そのものが距離で入り切りする（実物を湧かせて測る）');
{
  // 門番が「生きた敵を数えない」で成り立つのは、
  // 13mの外の敵がcastShadowを切っている時だけ。両方が揃って初めて安全なので、
  // 敵側も実物のDirectorで湧かせて測る（やり方はcheck-swarm.mjsと同じ）
  await import('../server/dom-stub.js');
  const THREE = await import('three');
  const { buildLevel } = await import('../src/world/level.js');
  const { Director } = await import('../src/ai/enemy.js');
  const SHARED = new THREE.MeshStandardMaterial();
  const level = buildLevel(new Proxy({}, { get: () => SHARED }));
  const scene = new THREE.Scene();
  const player = {
    collider: { start: new THREE.Vector3(0, 1.2, 0) },
    feetY: 0.1, height: 1.7, alive: true, health: 100,
    takeDamage: () => {},
  };
  const ctx = { octree: level.octree };
  const director = new Director(scene, level);
  director.betweenWaves = 0;
  // 敵が湧いて最初のupdateが回るまで進める（湧きは0.55秒間隔）
  for (let i = 0; i < 240; i++) director.update(1 / 60, player, ctx);
  const alive = director.active.filter((e) => e.alive);
  ok(alive.length >= 3, `敵が湧いた（${alive.length}体）`);

  const far = alive.filter((e) => e._playerDist >= 14);
  const farCasting = far.filter((e) => e.meshes.some((m) => m.castShadow));
  ok(far.length >= 1 && farCasting.length === 0,
    `13mの外の敵は影を落とさない（外${far.length}体中、落とすのは${farCasting.length}体）`);

  // プレイヤーを1体の目の前へ置くと、その敵だけ影が点く
  const target = far[0];
  player.collider.start.set(target.collider.start.x + 2, 1.2, target.collider.start.z + 2);
  director.update(1 / 60, player, ctx);
  ok(target.meshes.every((m) => m.castShadow), '近づいた敵は影を落とす');

  // 倒して落ち着かせると、死体として影が点く（遠くでも。遠い枚の住人になる）
  player.collider.start.set(target.collider.start.x + 40, 1.2, target.collider.start.z + 40);
  director.update(1 / 60, player, ctx);
  ok(!target.meshes.some((m) => m.castShadow), '離れたら消える');
  target.hit(9999, 'chest');
  for (let i = 0; i < 300; i++) director.update(1 / 60, player, ctx);   // 5秒=倒れ切る
  ok(!target.alive && target.deathSettled, '倒れ切った');
  ok(target.meshes.every((m) => m.castShadow), '落ち着いた死体は遠くでも影を落とす');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
