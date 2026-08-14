// 建物の出入口を、本物のPlayerで歩いて通れるかを測る。
//
// なぜ要るか: 2026-08-09、一人プレイで建物B（南東・レンガの詰所）の
// 屋根の崩落跡から中へ落ちたら、二度と出られなかった。
// 原因は別々の2つが重なっていた。**どちらも画面では気づけない。**
//
//   1. 基礎の段差（帯）が入口を通しで横切っていた。天端は1.15mで、
//      跳べる高さ(JUMP_VEL 6.6 / GRAVITY 22 → 0.99m)より上。
//      立ったまま跳ぶとまぐさ(2.9m)に頭がつかえて段差の乗り越えも効かないので、
//      しゃがみ跳びを知らないと本当に出られない
//   2. 壁の積み方（wallRun）が、横に重なった開口を後から塗り潰していた。
//      扉(u=0 幅3.0 床〜2.9m)の真上に足した高窓(u=0 幅2.0 3.7〜5.0m)の
//      腰壁(0〜3.7m)が、扉の穴をそのまま埋めていた
//
// 見切りも建具も開口ごとに出るので、**塞がっていても画面上は扉に見える。**
// 目で見ても、地形の三角形数を見ても分からない。歩いて通れることを毎回測る。
//
// 建物Aの南面も同じ理由で1階の窓が塞がっていた（u=-5.6と5.6に窓が上下2段）。
//
//   node tools/check-doors.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { buildLevel } from '../src/world/level.js';
import { Player } from '../src/player/player.js';
import { ServerInput } from '../server/sim.js';
import { K } from '../src/net/protocol.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const SHARED = new THREE.MeshStandardMaterial();
const level = buildLevel(new Proxy({}, { get: () => SHARED }));
const player = new Player(new THREE.Object3D(), level);
const input = new ServerInput();
const DT = 1 / 60;

/* 出入口の表。fromからtoへ**まっすぐ歩くだけ**で、間にある壁の面(gate)を
   越えられることを見る。跳ばない・しゃがまない・回り込まないのが肝で、
   「知っていれば抜けられる」は通ったことにしない */
const DOORS = [
  {
    name: '建物A 南面の正面入口', from: [-21, -19], to: [-21, -8], axis: 'z', at: -13,
  },
  {
    name: '建物B 西面の入口', from: [23, 21], to: [12, 21], axis: 'x', at: 15.5,
  },
  {
    // 倉庫の南面はシャッターの大開口だが、その外は高さ1.15mの荷捌き場（トラック床）で、
    // 段差があるのは作った通り。倉庫を歩いて出入りする口は西面のこの戸になる
    name: '倉庫 西面の戸', from: [20, -25], to: [10, -25], axis: 'x', at: 13,
  },
  {
    /* 掩体の出入口。2026-08-14の戦域対称化で南面の戸は無くなり、
       東西の袖壁の開口（点対称）になった。東西どちらからも入れることが
       この検査の意味なので、両方歩く */
    name: '掩体 東面の開口', from: [10, 0], to: [-4, 0], axis: 'x', at: 7.0,
  },
  {
    name: '掩体 西面の開口', from: [-10, 0], to: [4, 0], axis: 'x', at: -7.0,
  },
];

// from に立って to の方を向き、Wだけ押して歩く。壁の面を越えたらtrue。
// Wで進む向きは (-sin yaw, -cos yaw) なので、yawはそこから逆に引く
function walkThrough(from, to, axis, at) {
  const dx = to[0] - from[0], dz = to[1] - from[1];
  const len = Math.hypot(dx, dz);
  player.teleport(new THREE.Vector3(from[0], 0.2, from[1]));
  for (let i = 0; i < 90; i++) { input.set(0); player.update(DT, input, true, false); }
  player.yaw = Math.atan2(-dx / len, -dz / len);

  const side = Math.sign((axis === 'x' ? to[0] : to[1]) - at);
  let passed = false;
  for (let i = 0; i < 300; i++) {
    input.set(K.FWD);
    player.update(DT, input, true, false);
    const v = axis === 'x' ? player.collider.start.x : player.collider.start.z;
    // 0.8m余分に越えてから数える。壁の面ぎりぎりで擦っているのを通過にしない
    if (Math.sign(v - at) === side && Math.abs(v - at) > 0.8) { passed = true; break; }
  }
  return { passed, x: player.collider.start.x, z: player.collider.start.z };
}

console.log('\n[1] 中から外へ歩いて出られる');
for (const d of DOORS) {
  const r = walkThrough(d.from, d.to, d.axis, d.at);
  ok(r.passed, `${d.name} … 出た先 (${r.x.toFixed(1)}, ${r.z.toFixed(1)})`);
}

console.log('\n[2] 外から中へ歩いて入れる');
for (const d of DOORS) {
  const r = walkThrough(d.to, d.from, d.axis, d.at);
  ok(r.passed, `${d.name} … 入った先 (${r.x.toFixed(1)}, ${r.z.toFixed(1)})`);
}

console.log('\n[3] 入口を塞いでいた段差そのものが消えている');
{
  /* 帯の切り欠きは形が変わっても効いていればよいので、「扉の真ん中の足元に
     腰の高さの物が無い」ことだけを見る。段差を戻すとここが落ちる */
  const probe = (x, z) => {
    const c = new Capsule(new THREE.Vector3(x, 0.36, z), new THREE.Vector3(x, 1.4, z), 0.34);
    return !level.octree.capsuleIntersect(c);
  };
  ok(probe(-21, -13), '建物A 南面の入口の足元が空いている');
  ok(probe(15.5, 21), '建物B 西面の入口の足元が空いている');
}

console.log('\n[4] 屋根の崩落跡から落ちた所（建物Bの北東）から歩いて出られる');
{
  // 実際に落ちた場所。ここから歩いて建物の外へ出られること
  const r = walkThrough([27, 16], [12, 21], 'x', 15.5);
  ok(r.passed, `落下地点から西の入口へ … (${r.x.toFixed(1)}, ${r.z.toFixed(1)})`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
