// 体力の検査。**1人用と対戦で違う値が入っている**ので、その食い違いを見張る。
//
// なぜ要るか: 遊んで「対戦は撃ち合いを楽しみたいから体力2倍ぐらいあってもいい」
// と言われて分けた。分けた瞬間から、次の3つが黙って壊れうるようになった。
//
//   1. サーバーだけ倍で、手元が130のまま
//      → 画面の棒は満タンなのに、向こうでは半分しか無い。
//        撃たれて「まだ半分あるはず」なのに倒れる。**遊んでいる側には原因が読めない**
//   2. 手元だけ倍で、サーバーが130のまま
//      → 逆に、倒したはずの相手が立っている
//   3. 対戦から抜けた後、1人用が倍のまま
//      → 波の難度が丸ごと変わるのに、どこにも表示が出ない
//
// どれもターミナルには何も出ないし、構文エラーにもならない。
//
//   node tools/check-hp.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import * as THREE from 'three';
import { HP, HEAL, NADE, healAmount, blastDamage } from '../src/net/protocol.js';

const { Player } = await import('../src/player/player.js');
const { SimPlayer } = await import('../server/sim.js');
const { buildWorld } = await import('../server/world.js');
const { WEAPONS } = await import('../src/player/weapons.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const world = buildWorld();

console.log('\n[1] 対戦は1人用の倍');
{
  ok(HP.VERSUS === HP.SOLO * 2, `${HP.SOLO} の倍で ${HP.VERSUS}`);
  const p = new Player(new THREE.Object3D(), world);
  ok(p.maxHealth === HP.SOLO, `Playerの既定は1人用の値 (${p.maxHealth})`);
  ok(p.health === p.maxHealth, '出撃時は満タン');
}

console.log('\n[2] サーバーは対戦の体力で人を作る');
{
  const sim = new SimPlayer(1, 'me', world);
  ok(sim.player.maxHealth === HP.VERSUS, `上限が対戦の値 (${sim.player.maxHealth})`);
  ok(sim.hp === HP.VERSUS, `出撃時は満タン (${sim.hp})`);
  // 湧き直しでも倍のまま。ここでmaxHealthを取り違えると、2回目から半分で始まる
  sim.player.damage(200);
  sim.spawn(new THREE.Vector3(0, 0.2, 0), 0);
  ok(sim.hp === HP.VERSUS, `湧き直しても満タン (${sim.hp})`);
}

console.log('\n[3] 手元も対戦に入ったら倍にする');
/* main.jsが書き換えている所を見る。ここを消すと、
   画面の体力の棒だけ130を上限に描かれて、満タンなのに半分に見える。
   **サーバーは何も言ってこない**（向こうは正しく倍で動いている） */
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/maxHealth = HP\.VERSUS/.test(main), '対戦に入る時に上限を倍にしている');
  ok(/maxHealth = HP\.SOLO/.test(main), '抜ける時に1人用へ戻している');
  // 戻す時に今の値も詰めないと、130を超えた体力が残って棒がはみ出す
  ok(/health = Math\.min\(this\.player\.health, HP\.SOLO\)/.test(main),
    '戻す時に今の値も上限まで詰めている');
  const sim = readFileSync(new URL('../server/sim.js', import.meta.url), 'utf8');
  ok(/maxHealth = HP\.VERSUS/.test(sim), 'サーバーも同じ定数を見ている');
  // 数字の直書きが残っていないこと。片方だけ直して食い違うのがこの類の事故の原因
  ok(!/maxHealth = 2?[0-9]{2,3};/.test(sim), 'サーバー側に数字の直書きが無い');
}

console.log('\n[4] 落下ダメージは割合なので、倍にしても同じ高さで死ぬ');
/* 落下ダメージは maxHealth に比例させてある。倍にした時にここが定数だと、
   対戦だけ落下がほぼ無害になって、屋上から飛び降りるのが最短経路になる */
{
  const drop = (max) => {
    const p = new Player(new THREE.Object3D(), world);
    p.maxHealth = max;
    p.health = max;
    /* 湧き位置の真上6mから落とす。地形の真ん中(0,0)の上は屋根が9.7mにあって
       2.3mしか落ちず、痛くも痒くもないまま「割合が同じ」と言えてしまう。
       6mだと着地が16m/sで、痛いが死なない（13m/sから痛くなり20m/sで即死） */
    p.teleport(new THREE.Vector3(0, 6, 26));
    const input = {
      down: () => false,
      pressed: () => false,
      buttons: [false, false, false],
      takeLook: () => ({ yaw: 0, pitch: 0 }),
      moveVector: (o) => { o.x = 0; o.z = 0; return o; },
      endFrame: () => {},
    };
    for (let i = 0; i < 180; i++) p.update(1 / 60, input, false);
    return p.health / p.maxHealth;
  };
  const solo = drop(HP.SOLO);
  const versus = drop(HP.VERSUS);
  // まず本当に痛かったか。ここを見ないと「両方0ダメージで一致」でも通ってしまう
  ok(solo > 0.1 && solo < 0.95, `ちゃんと痛い高さで測っている (残り ${(solo * 100).toFixed(0)}%)`);
  ok(Math.abs(solo - versus) < 0.02,
    `同じ高さから落ちて残る割合が同じ (1人用 ${(solo * 100).toFixed(0)}% / 対戦 ${(versus * 100).toFixed(0)}%)`);
}

console.log('\n[5] 撃ち合いの長さがどう変わったか');
/* 数字を出しておく。**判定はしない。** ここは good/bad の線が引ける所ではなく、
   遊んで決める所なので、触った時に何発になったかが見えれば足りる */
{
  const rows = [];
  for (const w of WEAPONS) {
    if (!w.damage || w.id === 'nade') continue;
    const per = w.damage * Math.max(1, w.pellets | 0);
    rows.push(`    ${w.name}: 1人用 ${Math.ceil(HP.SOLO / per)}発 → 対戦 ${Math.ceil(HP.VERSUS / per)}発`);
  }
  console.log(rows.join('\n'));
  // 弾倉1つで倒しきれない武器が出ていないか。出ていたら撃ち合いが成立しない
  let starved = [];
  for (const w of WEAPONS) {
    if (!w.damage || w.id === 'nade' || w.mag > 900) continue;
    const per = w.damage * Math.max(1, w.pellets | 0);
    if (Math.ceil(HP.VERSUS / per) > w.mag) starved.push(w.name);
  }
  ok(starved.length === 0,
    starved.length ? `弾倉1つで倒しきれない武器がある: ${starved.join('、')}`
      : '弾倉1つで倒しきれる武器ばかり');
}

console.log('\n[6] 包帯の効きが1人用と対戦で同じか');
/* **これが固定の数だと、体力を倍にした瞬間に効きが半分になる。**
   35のままだと対戦では13%しか戻らず、2回全部巻いても4分の1。
   持っていることを忘れる道具になる（そして誰も壊れたとは言わない）。
   割合で持っているので、体力をいくつに変えても効きは変わらないはず */
{
  const soloPct = (healAmount(HP.SOLO) * HEAL.PER_ROUND / HP.SOLO) * 100;
  const versusPct = (healAmount(HP.VERSUS) * HEAL.PER_ROUND / HP.VERSUS) * 100;
  console.log(`    1回で戻る量は 1人用 ${healAmount(HP.SOLO)} / 対戦 ${healAmount(HP.VERSUS)}`);
  ok(Math.abs(soloPct - versusPct) < 1.5,
    `1ラウンド分を全部巻いて戻る割合が同じ (1人用 ${soloPct.toFixed(0)}% / 対戦 ${versusPct.toFixed(0)}%)`);
  // ライフル1発ぶん(27)より小さいと、巻く2.4秒を払う価値が無くなる
  ok(healAmount(HP.VERSUS) > 27, `対戦の1回がライフル1発より大きい (${healAmount(HP.VERSUS)})`);
  const player = readFileSync(new URL('../src/player/player.js', import.meta.url), 'utf8');
  ok(/healAmount\(this\.maxHealth\)/.test(player), 'player.jsが割合から量を出している');
}

console.log('\n[7] 手榴弾の効きが1人用と対戦で同じか');
/* 包帯と同じ話。爆風の威力(170)は固定なので、体力が倍になると
   **中心で当てても一撃で倒せない**（170 < 260）。
   置きにいく道具から、削るだけの道具に静かに変わる */
{
  const soloCenter = blastDamage(0) / HP.SOLO;
  const versusCenter = blastDamage(0, true) / HP.VERSUS;
  const soloEdge = blastDamage(NADE.BLAST_R * 0.99) / HP.SOLO;
  const versusEdge = blastDamage(NADE.BLAST_R * 0.99, true) / HP.VERSUS;
  console.log(`    中心の威力は 1人用 ${blastDamage(0)} / 対戦 ${blastDamage(0, true)}`);
  ok(Math.abs(soloCenter - versusCenter) < 0.01,
    `中心で持っていく割合が同じ (1人用 ${(soloCenter * 100).toFixed(0)}% / 対戦 ${(versusCenter * 100).toFixed(0)}%)`);
  ok(Math.abs(soloEdge - versusEdge) < 0.01,
    `端でも同じ (1人用 ${(soloEdge * 100).toFixed(0)}% / 対戦 ${(versusEdge * 100).toFixed(0)}%)`);
  ok(blastDamage(0, true) > HP.VERSUS, '対戦でも足元に落とせば一撃');
  // 1人用は倍にしない。敵の体力は波で増える別の作りなので、巻き添えにしない
  ok(blastDamage(0) === NADE.BLAST_DMG, `1人用は今まで通り (${blastDamage(0)})`);
  // 式が1か所にまとまっているか。手で3回書いていた頃は、片方だけ直る事故が起きる
  const room = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/blastDamage\(d, true\)/.test(room), 'サーバーは対戦の威力で解く');
  ok(!/BLAST_DMG/.test(room) && !/BLAST_DMG/.test(main), '爆風の式が手で書き写されていない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
