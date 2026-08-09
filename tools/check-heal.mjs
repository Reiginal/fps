// 包帯の検査。Playerを直接動かして、巻く・遅くなる・中断する・
// 数が減る・上限を超えないを確かめる。
//
//   node tools/check-heal.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';
import { HEAL, HP, healAmount } from '../src/net/protocol.js';

const { Player } = await import('../src/player/player.js');
const { buildWorld } = await import('../server/world.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 押しているキーだけを返す最小限の入力
const keys = new Set();
const input = {
  down: (k) => keys.has(k),
  pressed: (k) => keys.has(k),
  buttons: [false, false, false],
  takeLook: () => ({ yaw: 0, pitch: 0 }),
  moveVector: (o) => { o.x = 0; o.z = 0; return o; },
  endFrame: () => {},
};
const DT = 1 / 60;
const run = (p, sec) => { for (let i = 0; i < Math.round(sec / DT); i++) p.update(DT, input, false); };

const mk = () => {
  const p = new Player(new THREE.Object3D(), world);
  p.teleport(new THREE.Vector3(0, 0.1, 0));
  return p;
};

console.log('\n[1] 満タンでは巻けない');
const a = mk();
ok(a.startHeal() === false, '体力が満タンなら始まらない');
ok(a.bandages === HEAL.PER_ROUND, `数が減っていない (${a.bandages})`);

console.log('\n[2] 削られてから巻く');
const b = mk();
b.damage(80);
const hpBefore = b.health;
ok(b.startHeal() === true, '巻き始められる');
ok(b.healing > 0, '巻いている状態になる');
run(b, HEAL.TIME_S * 0.5);
ok(b.health === hpBefore, '巻き終わるまで体力は増えない');
run(b, HEAL.TIME_S * 0.6);
ok(b.healing === 0, '巻き終わった');
const back = healAmount(b.maxHealth);
ok(b.health === hpBefore + back, `体力が${back}戻った (${hpBefore} → ${b.health})`);
ok(b.bandages === HEAL.PER_ROUND - 1, `数が1つ減った (${b.bandages})`);

console.log('\n[3] 上限を超えない');
const c = mk();
c.damage(10);
c.startHeal();
run(c, HEAL.TIME_S + 0.2);
ok(c.health === c.maxHealth, `満タンで止まる (${c.health}/${c.maxHealth})`);

console.log('\n[4] 撃たれると中断する');
const d = mk();
d.damage(80);
d.startHeal();
run(d, HEAL.TIME_S * 0.5);
const hpMid = d.health;
d.damage(10);
ok(d.healing === 0, '被弾で中断した');
run(d, HEAL.TIME_S);
ok(d.health === hpMid - 10, '中断した回は回復していない');
ok(d.bandages === HEAL.PER_ROUND, `中断では数を消費しない (${d.bandages})`);

console.log('\n[5] 巻いている間は遅い');
// 長く歩かせて速さを比べると、途中で遮蔽にぶつかって両方0になる（最初これで誤判定した）。
// 1フレームぶんの加速だけを見る。加速量は目標速度に比例するので、
// 壁に触れる前に倍率の差がそのまま出る
const accel = (heal) => {
  const p = mk();
  p.damage(80);
  if (heal) p.startHeal();
  const walk = { ...input, moveVector: (o) => { o.x = 0; o.z = -1; return o; } };
  p.update(DT, walk, false);
  return p.horizontalSpeed;
};
const fast = accel(false);
const slow = accel(true);
console.log(`    1フレームの加速 通常 ${fast.toFixed(3)} → 巻いている間 ${slow.toFixed(3)}`);
ok(slow < fast * 0.6, '巻いている間ははっきり遅い');

console.log('\n[6] 数を使い切ったら巻けない');
const f = mk();
f.bandages = 0;
f.damage(50);
ok(f.startHeal() === false, '残り0では始まらない');

/* ------------------------------------------------ 手に持つ所まで通す */

// ここから下はPlayerではなくWeaponSystem側の検査。
// 上の[1]〜[6]はPlayer.startHeal()を直に叩いていて、これだと
// 「Fで持って、クリックで巻く」という実際の操作経路を一度も通らない。
// 実際そのせいで、包帯の見た目を作る_buildBandage()が一度も呼ばれておらず、
// 画面に何も出ないまま気づけなかった
const { WeaponSystem } = await import('../src/player/weapons.js');

const cam = new THREE.PerspectiveCamera(75, 1.6, 0.05, 900);
const vcam = new THREE.PerspectiveCamera(55, 1.6, 0.002, 12);
const ws = new WeaponSystem(new THREE.Scene(), cam, vcam, new THREE.Scene());
const idle = { down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false] };
const click = { ...idle, buttons: [true, false, false] };
const ctx = {};
// 何フレーム回すか。押しっぱなしと押した瞬間を区別するため、
// 押していないフレームを1枚挟んでから押す
const step = (p, inp, n = 1) => { for (let i = 0; i < n; i++) ws.update(1 / 60, inp, p, ctx); };

console.log('\n[7] 包帯が画面に存在するか');
ok(!!ws.bandage, '包帯の見た目が作られている');
ok(ws.bandage?.visible === false, '出していない間は隠れている');

console.log('\n[8] Fで持って、クリックで巻く');
const g = mk();
g.damage(80);
ok(ws.toggleBandage(g) === true, 'Fに当たる操作で手に持てる');
ok(g.healing === 0, '持っただけでは回復が始まらない');
step(g, idle, 30);
ok(ws.bandage.visible === true, '持っている間は画面に出ている');
ok(ws._healBlend > 0.8, `武器を下ろしきっている (${ws._healBlend.toFixed(2)})`);

step(g, idle);
step(g, click);
ok(g.healing > 0, '左クリックで巻き始める');
const hpBefore8 = g.health;
step(g, idle, 30);
ok(ws.bandage.visible === true, '巻いている間も出ている');

console.log('\n[9] 巻いている間は撃てない');
const shots = [];
ws.onShot = (s) => shots.push(s);
step(g, idle);
step(g, click, 10);
ok(shots.length === 0, `弾が出ない (${shots.length}発)`);
ws.onShot = () => {};

console.log('\n[10] 巻き終わったら勝手にしまう');
for (let i = 0; i < 60 * 3; i++) { g.update(1 / 60, input, false); ws.update(1 / 60, idle, g, ctx); }
ok(g.healing === 0, '巻き終わっている');
ok(g.health === hpBefore8 + healAmount(g.maxHealth), `体力が戻った (${hpBefore8} → ${g.health})`);
ok(ws.bandageOut === false, '手放して武器へ戻る');
step(g, idle, 30);
ok(ws.bandage.visible === false, '包帯が画面から消えている');

console.log('\n[11] 出せない場合');
const h = mk();
h.bandages = 0;
ok(ws.toggleBandage(h) === false, '残り0では持てない');
ok(ws.bandageOut === false, '持てなかった時に出しっぱなしにならない');

console.log('\n[12] もう一度Fでしまう');
const j = mk();
j.damage(40);
ws.toggleBandage(j);
ok(ws.bandageOut === true, '1回目で出る');
ws.toggleBandage(j);
ok(ws.bandageOut === false, '2回目でしまう');
// 巻いている最中にFを押しても消費だけして回復しない事故を防ぐ
ws.toggleBandage(j);
j.startHeal();
ws.toggleBandage(j);
ok(ws.bandageOut === true, '巻いている最中はFでしまえない');

/* ------------------------------------------ 対戦での自分とサーバーの一致 */

// 対戦では自分の端末で回復を先に走らせ、同じ入力をサーバーへ送って
// 向こうでも同じ回復を走らせる。ここがズレると、片方だけ体力が戻る。
//
// Fの意味を「巻き始める」から「手に持つ」へ変えた時、この電文の中身も
// 一緒に変えないと、手に持っただけでサーバー側の回復が始まっていた。
// 画面を見ても自分の体力は自分の端末の値が出るので、相手側から見た時にだけ
// 食い違う＝遊んでいる本人には最後まで分からない類のズレになる
const { SimPlayer } = await import('../server/sim.js');
const { K } = await import('../src/net/protocol.js');

// 通信の遅れ。片道3刻み(=50ms)ぶん遅れて相手に届くとして回す
const LAG = 3;

// main.jsが組み立てるビットと同じ式
const healBit = (p) => (p.healing > 0 || p.healHold > 0 ? K.HEAL : 0);

/**
 * 自分の端末とサーバーを、遅れを挟んで同時に回す。
 * @param cancelAt 何秒目に自分の側で巻くのをやめるか（nullなら最後まで巻く）
 */
const runNet = (cancelAt) => {
  /* **対戦の話なので、手元も対戦の体力にしてから始める。**
     Playerの既定は1人用の130で、対戦に入る時にmain.jsが260へ書き換えている。
     ここで書き換えないと、比べている2人が別の上限を持ったまま走り、
     「サーバーだけ回復量が違う」ように見える（実際は最大値が違うだけ） */
  const me = mk();
  me.maxHealth = HP.VERSUS;
  me.health = HP.VERSUS;
  me.damage(80);
  const sim = new SimPlayer(1, 'me', world);
  sim.player.teleport(new THREE.Vector3(0, 0.1, 0));
  sim.player.damage(80);

  me.startHeal();
  const queue = [];
  let t = 0;
  for (let i = 0; i < Math.round(5 / DT); i++) {
    if (cancelAt != null && t >= cancelAt && me.healing > 0) me.cancelHeal();
    me.update(DT, input, false);
    // 自分の入力を電文にして送り、遅れてサーバーが受け取る
    queue.push(healBit(me));
    if (queue.length > LAG) sim.tick(queue.shift(), 0, 0);
    t += DT;
  }
  return { me, srv: sim.player };
};

console.log('\n[13] 最後まで巻いた時、サーバー側も同じだけ回復する');
{
  const { me, srv } = runNet(null);
  ok(me.health === srv.health, `体力が一致する (自分 ${me.health} / サーバー ${srv.health})`);
  ok(me.bandages === srv.bandages, `残数が一致する (${me.bandages} / ${srv.bandages})`);
  ok(me.health === HP.VERSUS - 80 + healAmount(HP.VERSUS),
    `ちゃんと回復している (${me.health} / 対戦は1回 ${healAmount(HP.VERSUS)} 戻る)`);
}

console.log('\n[14] 途中でやめた時、サーバー側も回復しない');
{
  const { me, srv } = runNet(1.0);
  ok(me.health === srv.health, `体力が一致する (自分 ${me.health} / サーバー ${srv.health})`);
  ok(me.health === HP.VERSUS - 80, `やめたので戻っていない (${me.health})`);
  ok(srv.bandages === HEAL.PER_ROUND, `サーバー側も消費していない (${srv.bandages})`);
}

console.log('\n[15] 手に持っただけではサーバーの回復が始まらない');
{
  // Fを押しただけの状態＝巻いていないので、ビットは立たないはず
  const p = mk();
  p.damage(80);
  ws.toggleBandage(p);
  ok(healBit(p) === 0, '手に持っただけでは包帯のビットが立たない');
  const sim = new SimPlayer(2, 'x', world);
  sim.player.teleport(new THREE.Vector3(0, 0.1, 0));
  sim.player.damage(80);
  for (let i = 0; i < 60; i++) sim.tick(healBit(p), 0, 0);
  ok(sim.player.healing === 0, 'サーバー側が勝手に巻き始めない');
  ok(sim.player.health === HP.VERSUS - 80, `体力が動いていない (${sim.player.health})`);
  ws.holsterBandage();
}

/* ------------------------------------------------ 死んで再開した時 */

// 死んで再開しても包帯が0のままだった。
// 対戦ではもっと悪く、サーバーは湧き直しで2本に戻すのに手元だけ0のままで、
// Fを押しても手元が断って一生使えない状態になっていた。
// 戻す処理を Player.refill() に集めて、呼ぶ側が手で3行書かないようにした
console.log('\n[16] 死んで再開したら包帯が戻る');
{
  const p = mk();
  p.damage(80);
  p.startHeal();
  run(p, HEAL.TIME_S + 0.2);
  p.startHeal();
  run(p, HEAL.TIME_S + 0.2);
  ok(p.bandages === 0, `使い切った (${p.bandages})`);
  p.damage(200);
  ok(p.alive === false, '死んだ');
  p.refill();
  ok(p.bandages === HEAL.PER_ROUND, `包帯が戻る (${p.bandages})`);
  ok(p.health === p.maxHealth, `体力も戻る (${p.health})`);
  ok(p.alive === true, '生き返る');
  ok(p.healing === 0 && p.healHold === 0, '巻いている途中の状態も消える');
}

console.log('\n[17] 包帯を持ったまま死んでも、持ったまま再開しない');
{
  const p = mk();
  p.damage(50);
  ws.toggleBandage(p);
  ok(ws.bandageOut === true, '持っている');
  p.damage(200);
  p.refill();
  ws.resetAll();
  ok(ws.bandageOut === false, '手放した状態で再開する');
  step(p, idle, 30);
  ok(ws.bandage.visible === false, '画面からも消えている');
}

console.log('\n[18] サーバー側の湧き直しでも戻る');
{
  const sim = new SimPlayer(9, 'x', world);
  sim.player.teleport(new THREE.Vector3(0, 0.1, 0));
  sim.player.bandages = 0;
  sim.player.damage(60);
  sim.player.refill();
  ok(sim.player.bandages === HEAL.PER_ROUND, `サーバー側も戻る (${sim.player.bandages})`);
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
