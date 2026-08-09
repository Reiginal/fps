// 手榴弾の飛び方の検査。
//
// なぜ要るか: 遊んで「手榴弾がなんか野球ボール投げたみたいな挙動してる。
// 他のゲームの手榴弾ってこんな挙動だっけ」と言われた（2026-08-09）。
//
// **「投げ物らしさ」は感想だが、中身は全部数字だった。** 測ったらこうなっていた:
//   0.68秒で13.5m先まで飛ぶのに、一番高い所でも目の高さから0.95mしか上がらない
//   → 弧を描いていない。速い直線＝送球
//   着地してから12.7m転がって、爆発するのは26m先
//   → 置きにいく物ではなく、投げた後どこかへ行く物
//
// ここで見るのは「弧を描いて飛び、着いた所の近くで止まるか」だけ。
// 数字そのものに正解は無いが、**直した形から黙って戻るのを止める**のが役目。
//
// 地形は使わない。平らな床だけの場所で測る（地形の凸凹が混ざると、
// 測っているのが投げ方なのか地形なのか分からなくなる）。
// 跳ね返りの割り方は server/room.js の _stepNades / main.js の _stepSoloNades と同じ式。
//
//   node tools/check-nade.mjs
import { readFileSync } from 'node:fs';
import { NADE } from '../src/net/protocol.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 投げる時の上向き成分はmain.jsが持っている（向きは手元が決めて申告する物なので）。
// **写しを持たない。** 写すと、片方だけ動かした時にこの検査が嘘をつく
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const LOFT = Number(main.match(/const NADE_LOFT = ([\d.]+);/)?.[1]);

const DT = 1 / 120;
const EYE = 1.6;      // 目の高さ（player.jsのSTAND_H相当。おおよそで足りる）

/** 水平を向いて投げた時の一生を追う */
const throwFlat = () => {
  const len = Math.hypot(1, LOFT);
  const dz = -1 / len, dy = LOFT / len;
  let y = EYE + dy * NADE.MUZZLE, z = dz * NADE.MUZZLE;
  let vy = dy * NADE.SPEED, vz = dz * NADE.SPEED;
  let t = 0, land = -1, landAt = 0, top = y;
  while (t < NADE.FUSE_S) {
    t += DT;
    vy -= NADE.GRAVITY * DT;
    y += vy * DT; z += vz * DT;
    top = Math.max(top, y);
    if (y <= NADE.RADIUS) {
      y = NADE.RADIUS;
      if (land < 0) { land = t; landAt = -z; }
      vy = -vy * NADE.BOUNCE;
      const k = Math.max(0, 1 - NADE.FRICTION * DT);
      vz *= k; vy *= k;
    }
  }
  return { land, landAt, rise: top - EYE, end: -z, roll: -z - landAt };
};

console.log('\n[1] 投げる向きと初速');
ok(Number.isFinite(LOFT), `main.jsから上向き成分を読めた（${LOFT}）`);
ok(LOFT > 0.4, `下手投げの角度になっている（${(Math.atan(LOFT) * 180 / Math.PI).toFixed(0)}度）`);
ok(NADE.SPEED <= 16, `初速が弾のように速くない（${NADE.SPEED}m/s）`);

console.log('\n[2] 弧を描いて飛ぶか');
const r = throwFlat();
// 「野球ボール」だった時: 0.68秒・0.95m。投げ物として見えるには、
// 目の高さより1m以上あがって、1秒近く飛んでいてほしい
ok(r.rise >= 1.1, `目の高さより${r.rise.toFixed(2)}m上まで上がる`);
ok(r.land >= 0.85, `着地まで${r.land.toFixed(2)}秒かかる（速い直線ではない）`);
ok(r.landAt > 8 && r.landAt < 18, `水平に投げて${r.landAt.toFixed(1)}m先へ落ちる`);

console.log('\n[3] 着いた所の近くで止まるか');
// 置きにいく物なので、狙った所と爆発する所が離れていては意味が無い。
// 爆風の半径(9.5m)より転がったら、それは別の場所に投げたのと同じ
ok(r.roll < 5, `着地してから${r.roll.toFixed(1)}mで止まる（直す前は12.7m）`);
ok(r.roll < NADE.BLAST_R, `転がりが爆風の半径(${NADE.BLAST_R}m)より短い`);
ok(NADE.BOUNCE <= 0.25, `よく弾むボールになっていない（跳ね返り${NADE.BOUNCE}）`);

console.log('\n[4] 爆発するまでに間があるか');
// 着地してから爆発まで。ここが0だと空中で爆発する物になり、
// 長すぎると投げてから見ているだけの時間が増える
const wait = NADE.FUSE_S - r.land;
ok(wait > 0.8 && wait < 2.5, `着地してから爆発まで${wait.toFixed(2)}秒`);

console.log('\n[5] 手元とサーバーが同じ式で飛ばしているか');
/* **飛翔を2箇所に書いてある。** サーバー(対戦)と手元(1人用)で、
   同じNADEの値を読んで同じ順で計算する約束になっている。
   片方だけ直すと、対戦では壁を越えたのに1人用では越えない、が起きる */
{
  const room = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  const solo = main;
  for (const [name, src] of [['server/room.js', room], ['src/main.js', solo]]) {
    ok(/NADE\.GRAVITY \* (dt|TICK_DT)/.test(src), `${name} … 重力をNADEから読んでいる`);
    ok(/NADE\.BOUNCE/.test(src), `${name} … 跳ね返りもNADEから読んでいる`);
    ok(/NADE\.FRICTION \* h/.test(src), `${name} … 摩擦もNADEから読んでいる`);
  }
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
