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

// 手前投げの上向き成分も同じくmain.jsが持つ
const LOFT_SHORT = Number(main.match(/const NADE_LOFT_SHORT = ([\d.]+);/)?.[1]);

const DT = 1 / 120;
const EYE = 1.6;      // 目の高さ（player.jsのSTAND_H相当。おおよそで足りる）

/** 水平を向いて投げた時の一生を追う */
const throwFlat = (short = false) => {
  const loft = short ? LOFT_SHORT : LOFT;
  const speed = NADE.SPEED * (short ? NADE.SHORT_MUL : 1);
  const len = Math.hypot(1, loft);
  const dz = -1 / len, dy = loft / len;
  let y = EYE + dy * NADE.MUZZLE, z = dz * NADE.MUZZLE;
  let vy = dy * speed, vz = dz * speed;
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

console.log('\n[4.5] 右クリックの手前投げ');
/* 遊んで「右クリしたら手前めに投げれるようになったら嬉しい」と言われて足した物。
   押した瞬間にその場で放る（構えない）。
   見るのは2つ。**近くへ落ちること**と、**それで自爆しないこと。** */
{
  ok(Number.isFinite(LOFT_SHORT), `main.jsから手前投げの上向きを読めた（${LOFT_SHORT}）`);
  ok(NADE.SHORT_MUL < 1, `初速に掛ける倍率がある（×${NADE.SHORT_MUL}）`);
  ok(LOFT_SHORT > LOFT, `普通より上へ放る（${LOFT_SHORT} > ${LOFT}）`);

  const s = throwFlat(true);
  ok(s.landAt < r.landAt * 0.7,
    `普通より手前へ落ちる（手前${s.landAt.toFixed(1)}m / 普通${r.landAt.toFixed(1)}m）`);
  ok(s.landAt > 3, `足元すぎない（${s.landAt.toFixed(1)}m先）`);
  ok(s.rise > 0.9, `山なりに放っている（目より${s.rise.toFixed(2)}m上）`);

  /* **自爆の量を見る。** 爆風は max(MIN_DMG, BLAST_DMG*(1-距離/半径)) なので、
     下限(18)で止まる距離まで離れていれば「手前へ置いた」で済む。
     そこを割ると、手前投げが「自分に投げる」に変わる（0.55倍だと45喰らう） */
  const dmg = Math.max(NADE.MIN_DMG, NADE.BLAST_DMG * (1 - s.end / NADE.BLAST_R));
  ok(dmg <= NADE.MIN_DMG,
    `遮蔽が無くても被害は下限で止まる（${s.end.toFixed(1)}m先で${dmg.toFixed(0)}）`);
}

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

console.log('\n[6] 手前投げの繋ぎ込み');
/* **強さを申告させない。** 速さの数字を電文に載せると、
   そこを書き換えるだけで好きなだけ飛ばせる。送るのは「弱く投げた」の印だけで、
   どれだけ弱いかはサーバーが持つ倍率で決まる */
{
  const client = readFileSync(new URL('../src/net/client.js', import.meta.url), 'utf8');
  const index = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const room = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  ok(/sendThrow\(origin, dir, short/.test(client), '手元は印だけを送っている');
  ok(!/SHORT_MUL/.test(client), '手元は強さの数字を送っていない');
  ok(/m\.s === 1/.test(index), 'サーバーが印を読んでいる');
  ok(/NADE\.SHORT_MUL/.test(room), 'サーバー側が倍率を掛けている');
  // 手元(1人用)と予測線も同じ関数から取ること。別々に書くと線と飛び方がずれる
  ok(/throwSpeedOf\(short\)[\s\S]*throwSpeedOf\(short\)/.test(main),
    '予測線と1人用の飛翔が同じ関数を読んでいる');
  // 線は2本出す。右クリックは押した瞬間に飛ぶので、押す前に落ちる場所が見えていないと
  // 「押してみないと分からない物」になる
  ok(/_fillArc\(this\._arc, false\)[\s\S]{0,200}?_fillArc\(this\._arcShort, true\)/.test(main),
    '普通と手前の弧を2本とも描いている');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
