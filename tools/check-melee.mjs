// 近接の強い一撃（右クリック）の検査。
//
// **威力を上げる仕掛けは、偽られた時に何が起きるかまで見ないと入れられない。**
// クライアントが送るのは「強い」という印だけで、威力そのものは送らせていない。
// 偽って送り続けられても、サーバーが発射権を余分に使うので
// **間隔が伸びるだけで得が無い。** そこが崩れていないかを見張る。
//
// もう1つ、**1人用と対戦で威力の計算が別々の場所にある**（このrepoの持病）。
// 片方だけ直すと「1人用では強いのに対戦では通常と同じ」になるので、
// 同じ倍率を見ているかをここで突き合わせる。
//
//   node tools/check-melee.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { MELEE_HEAVY, HP } from '../src/net/protocol.js';
import { WEAPONS as SIM_WEAPONS, heavyDef } from '../server/sim.js';
import { WEAPONS } from '../src/player/weapons.js';
import { SWING_TUNE, SWING_HEAVY_TUNE } from '../src/core/audio.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const knife = WEAPONS.find((w) => w.id === 'knife');

console.log('\n[1] 数字の釣り合い');
{
  ok(MELEE_HEAVY.COST >= 2, `発射権を${MELEE_HEAVY.COST}個使う（間隔が${MELEE_HEAVY.COST}倍）`);
  ok(MELEE_HEAVY.MULT > 1, `威力は${MELEE_HEAVY.MULT}倍`);
  /* **毎秒の威力は下がっていること。** 上がっていると
     「右クリックを連打するのが最適」になって、左クリックが要らなくなる */
  const dpsNormal = knife.damage / (60 / knife.rpm);
  const dpsHeavy = (knife.damage * MELEE_HEAVY.MULT) / ((60 / knife.rpm) * MELEE_HEAVY.COST);
  ok(dpsHeavy < dpsNormal,
    `**押しっぱなしより弱い**（毎秒 ${dpsNormal.toFixed(0)} → ${dpsHeavy.toFixed(0)}）`);
  ok(MELEE_HEAVY.TIME_S > 0.42,
    `振りが長い（${MELEE_HEAVY.TIME_S}秒。振りかぶりが相手から見える）`);

  const heavy = knife.damage * MELEE_HEAVY.MULT;
  ok(heavy < HP.VERSUS, `対戦(体力${HP.VERSUS})を胴1回では倒せない（${heavy.toFixed(0)}）`);
  /* 頭でちょうど倒せないのは意図的。129.5×2.0＝259で、体力260にあと1足りない。
     **当てても詰め切る一手が要る形**にしてある（1回で終わると近づくだけで勝てる）*/
  ok(heavy * knife.headMult < HP.VERSUS,
    `**頭でも1回では倒せない**（${(heavy * knife.headMult).toFixed(0)} 対 ${HP.VERSUS}。あと${(HP.VERSUS - heavy * knife.headMult).toFixed(1)}）`);
  // 1人用の敵は体力100から始まる（波が進むと固くなる）。序盤なら1回で倒せる
  const ENEMY_BASE = 100;
  ok(heavy >= ENEMY_BASE,
    `1人用の敵(体力${ENEMY_BASE}から)は序盤なら1回で倒せる（${heavy.toFixed(0)}）`);
  ok(heavy < ENEMY_BASE * 2, `後半の固い敵は2回要る（${heavy.toFixed(0)}）`);
}

console.log('\n[2] 威力を送らせていない');
{
  const cli = readFileSync(new URL('../src/net/client.js', import.meta.url), 'utf8');
  ok(/h: heavy \? 1 : undefined/.test(cli), '送るのは印だけ');
  ok(!/damage/.test(cli), '**client.jsが威力という言葉すら持っていない**');

  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/m\.h === 1/.test(idx), 'サーバーは印を真偽として読む（数として読まない）');
  ok(!/m\.(dmg|damage|mult)/.test(idx), '威力らしき物を受け取っていない');
}

console.log('\n[3] 偽られても間隔が伸びるだけ');
{
  const room = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  ok(/const cost = strong \? MELEE_HEAVY\.COST : 1;/.test(room), '強い一撃は発射権を余分に使う');
  ok(/if \(sim\.fireTokens < cost\) return;/.test(room), '足りなければ捨てる');
  ok(/sim\.fireTokens -= cost;/.test(room), '実際に引いている');
  /* **近接以外では効かない。** 銃に強弱は無いので、
     ここを見ていないと「ライフルで威力1.85倍」が通ってしまう */
  ok(/heavy && sim\.def\.melee/.test(room), '**近接以外は強い一撃にならない**');
}

console.log('\n[4] 1人用と対戦で同じ倍率');
{
  const heavy = heavyDef(SIM_WEAPONS.find((w) => w.id === 'knife'));
  ok(Math.abs(heavy.damage - knife.damage * MELEE_HEAVY.MULT) < 1e-6,
    `サーバーの威力が表と合う（${heavy.damage.toFixed(1)}）`);
  ok(heavy.range === knife.range, '**射程は伸びない**（遠くから強く当たる形にしない）');
  ok(heavy.falloffMin === knife.falloffMin, '減衰も変えていない');
  ok(heavyDef(SIM_WEAPONS[3]) === heavyDef(SIM_WEAPONS[3]),
    '同じ表からは同じ物が返る（撃つたびに作っていない）');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/heavy \? MELEE_HEAVY\.MULT : 1/.test(main),
    '**1人用も同じ倍率を見ている**（片方だけ強い、が起きない）');
  ok(/sendShot\(origin, dir, heavy\)/.test(main), '対戦へは印を渡している');
}

console.log('\n[5] 右クリックが覗きへ流れない');
{
  const w = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  ok(/rightEdge && !d\.thrown && !d\.melee/.test(w),
    '近接の右クリックは覗きの入り切りへ行かない');
  ok(/d\.melee && rightEdge && canFire/.test(w), '近接の右クリックで振る');
  ok(/this\.fireTimer = \(60 \/ d\.rpm\) \* MELEE_HEAVY\.COST/.test(w),
    '手元でも間隔を伸ばす（見た目を合わせるため。本当の縛りはサーバー）');
  // 手榴弾の右クリック（手前投げ）を壊していないか
  ok(/rightEdge && canFire/.test(w), '手榴弾の手前投げは残っている');
}

console.log('\n[6] 音が分かれている');
{
  ok(SWING_TUNE.band[1] > SWING_HEAVY_TUNE.band[1],
    `強い一撃の方が低い（${SWING_TUNE.band[1]} → ${SWING_HEAVY_TUNE.band[1]}Hz）`);
  ok(SWING_HEAVY_TUNE.env[1] > SWING_TUNE.env[1],
    `強い一撃の方が長い（${SWING_TUNE.env[1]} → ${SWING_HEAVY_TUNE.env[1]}秒）`);
  ok(SWING_HEAVY_TUNE.airGain > SWING_TUNE.airGain,
    `強い一撃の方が空気が重い（${SWING_TUNE.airGain} → ${SWING_HEAVY_TUNE.airGain}）`);

  /* **前の版へ戻っていないこと。** 空気が芯と同じ量になると
     低い音が高い音を覆って「ボワッ」に戻る（一度そうなって「鈍い」と言われた） */
  ok(SWING_TUNE.airGain < 0.6, `通常の空気は芯の${SWING_TUNE.airGain}倍まで（1.0で鈍い音に戻る）`);
  ok(SWING_TUNE.band[1] >= 4000, `芯の頂点が${SWING_TUNE.band[1]}Hz（低いと「ゴォ」になる）`);
  ok(SWING_TUNE.q >= 2.0, `帯が細い（Q=${SWING_TUNE.q}。広いとノイズがそのまま鳴る）`);

  const w = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  ok(/swing\?\.\(this\.heavy \? SWING_HEAVY_TUNE : undefined\)/.test(w),
    '振った時に強弱で鳴り分ける');
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
