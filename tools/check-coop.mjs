// 協力プレイ（対モンスター）の検査。本物のRoomとMonsterDirectorを動かす。
//
// なぜ要るか: 協力プレイは**サーバーに敵AIのシミュレーションを丸ごと足した**ので、
// 壊れうる面が2方向ある。
//   ① 対人の進行（デスマッチ等）を壊していないか … check-modes.mjsが見ている
//   ② 協力プレイ自身がちゃんと回るか … ここで見る
// 「波が進む」「撃てば減る」「全滅で負け」「ボスを倒せば勝ち」を、
// ブラウザ無しで最初から最後まで通す。
//
//   node tools/check-coop.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';
import { PHASE, EV, MODE_IDS } from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');
const { MONSTER_KINDS, WAVE_COUNT } = await import('../server/monsters.js');
const { modeOf } = await import('../server/modes.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const mkConn = () => ({ sent: [], rtt: 0, send(m) { this.sent.push(m); } });
const room = getRoom(world);
const clear = () => { for (const s of [...room.slots.values()]) room.leave(s); };
const join = (name) => {
  const conn = mkConn();
  const slot = room.join(conn, name);
  conn.slot = slot;
  return { conn, slot };
};
const eventsOf = (p) => p.conn.sent.filter((m) => m.t === 'E').flatMap((m) => m.e);

console.log('\n[1] 遊び方の表に協力が居る');
{
  ok(MODE_IDS.includes('coop'), 'MODE_LISTにcoopがある（ロビーに並ぶ）');
  const rules = modeOf('coop');
  ok(rules.coop === true, 'rules.coopの印が立っている');
  ok(rules.rounds === false, 'ラウンド無し（倒れても時間で生き返る）');
  ok(rules.teams === true && typeof rules.teamOf === 'function', '全員が同じチーム');
  ok(rules.teamOf(0) === rules.teamOf(3), '席0と席3が同じチーム（TEAM_OF_SEATの左右割りを上書き）');
  ok(rules.timed === false, '3分の時計は無い（決着はボス討伐か全滅だけ）');
}

console.log('\n[2] 1人でも始められて、モンスターが湧く');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('coop');
  const p = join('ソロ');
  room.takeSeat(p.slot, 0);
  room.setReady(p.slot, true);
  ok(room.phase === PHASE.LIVE, '1人＋準備完了で始まる（対人は2人要るが、相手はモンスター）');
  ok(!!room.monsters, 'モンスターの進行が組まれている');

  for (let i = 0; i < 600; i++) room._tick();   // 10秒
  const ev = eventsOf(p);
  const spawns = ev.filter((e) => e.e === EV.MSPAWN);
  ok(spawns.length > 0, `湧いた（${spawns.length}体）`);
  ok(spawns.every((e) => e.kind in MONSTER_KINDS), '知っている種類だけが湧く');
  const waves = ev.filter((e) => e.e === EV.WAVE);
  ok(waves.length >= 1 && waves[0].n === 1, '第1波の知らせが飛ぶ');
  ok(waves[0].of === WAVE_COUNT + 1, `全体の波数も載っている（${WAVE_COUNT}波＋ボス）`);
  const snaps = p.conn.sent.filter((m) => m.t === 'S' && Array.isArray(m.ms));
  ok(snaps.length > 0, 'スナップショットにモンスターの位置(ms)が載る');
  const row = snaps.at(-1).ms[0];
  ok(Array.isArray(row) && row.length === 8, 'packMonsterの並びは8項目');
}

console.log('\n[3] 撃てば減り、倒せば知らせが飛ぶ');
{
  // [2]の10秒でプレイヤーが撃たれて倒れている（＝全滅で試合が終わっている）
  // ことがあるので、仕切り直してから撃つ。待つ間は無敵にして確実に生かしておく
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('coop');
  const pj = join('射手');
  room.takeSeat(pj.slot, 0);
  room.setReady(pj.slot, true);
  for (let i = 0; i < 300; i++) { pj.slot.sim.protectIn = 1; room._tick(); }
  const p = pj.slot;
  const conn = p.conn;
  const m = room.monsters.active.find((x) => x.enemy.alive);
  const e = m.enemy;
  /* AIの歩き先は毎回違い、壁の中や物陰に立たれると弾が届かず検査が不安定になる。
     開けた場所（対戦の湧き地点の並び）へ湧き直させてから、目の前で撃つ。
     spawn()は当たり判定の仮の位置(_syncHitboxes)も入れ直すので、
     update()を回さなくてもintersect()が引ける */
  e.spawn(new THREE.Vector3(-14, 0.3, 0));
  p.sim.player.collider.start.set(-17.5, 0.94, 0);
  p.sim.player.collider.end.set(-17.5, 1.49, 0);
  p.sim.fireTokens = 5;
  p.sim.swapIn = 0;
  const eye = p.sim.eye();
  const origin = new THREE.Vector3(eye.x, eye.y, eye.z);
  const aim = new THREE.Vector3(
    e.collider.start.x, (e._chestA.y + e._chestB.y) / 2, e.collider.start.z,
  );
  const dir = aim.sub(origin).normalize();
  const before = conn.sent.length;
  room.shot(p, p.lastSeq, origin.clone(), dir.clone());
  room._broadcast();
  const ev = conn.sent.slice(before).filter((x) => x.t === 'E').flatMap((x) => x.e);
  const mhit = ev.find((x) => x.e === EV.MHIT);
  ok(!!mhit, 'MHITが飛ぶ');
  ok(mhit && mhit.by === p.id, '誰が当てたか載っている');
  // どの個体に当たったかはレイ次第（複数居る）なので、当たった個体のHPで確かめる
  const target = room.monsters.active.find((x) => x.mid === mhit?.mid);
  ok(target && target.enemy.health < target.enemy.maxHealth, '体力が減っている');

  // 撃ち切って倒す
  const kills0 = p.sim.kills;
  if (target) {
    while (target.enemy.alive) room.monsters.hit(target, 100, 'chest', null, p);
  }
  room._broadcast();
  const ev2 = conn.sent.filter((x) => x.t === 'E').flatMap((x) => x.e);
  const mk = ev2.filter((x) => x.e === EV.MKILL && x.mid === target?.mid);
  ok(mk.length === 1, 'MKILLが1回だけ飛ぶ');
  ok(p.sim.kills === kills0 + 1, '倒した数が入る');
}

console.log('\n[4] モンスターの攻撃で削られ、全員倒れたら負け');
{
  const p = [...room.slots.values()][0];
  // モンスター→プレイヤーのダメージ経路を直接呼ぶ
  // （実際の発砲はAIの照準と乱数を待つことになり、検査が不安定になる）
  p.sim.protectIn = 0;   // [3]で生かすために立てた無敵を解く
  const hp0 = p.sim.player.health;
  room._monsterHitPlayer(p, 10);
  ok(p.sim.player.health < hp0, '体力が減る');
  const hits = eventsOf(p).filter((e) => e.e === EV.HIT && e.by === -1);
  ok(room.events.some((e) => e.e === EV.HIT && e.by === -1) || hits.length > 0,
    'HITのbyは-1（人ではない印）');

  // とどめ
  room._monsterHitPlayer(p, 9999);
  ok(!p.sim.player.alive, '倒れる');
  room._broadcast();
  const kills = eventsOf(p).filter((e) => e.e === EV.KILL && e.m === 1);
  ok(kills.length >= 1, 'KILLにモンスターの印(m)が立つ');
  ok(room.phase === PHASE.END, '1人プレイなら全滅＝そのまま負けで試合が終わる');
  const me = p.conn.sent.filter((x) => x.t === 'M').at(-1);
  ok(me?.why === 'wipe', `決着の理由はwipe（${me?.why}）`);
}

console.log('\n[5] ボスを倒し切ると勝ちで終わる');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('coop');
  const ps = ['甲', '乙'].map(join);
  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  ps.forEach((p) => room.setReady(p.slot, true));
  ok(room.phase === PHASE.LIVE, '2人でも始まる');

  // 波が来るたびに全部倒す、をボスまで繰り返す
  let guard = 0;
  while (room.phase === PHASE.LIVE && guard++ < 30000) {
    for (const m of room.monsters.active) {
      if (m.enemy.alive) room.monsters.hit(m, 1000, 'chest', null, ps[0].slot);
    }
    room._tick();
  }
  ok(room.phase === PHASE.END, `ボスまで倒し切ると試合が終わる（${guard}ティック）`);
  const me = ps[0].conn.sent.filter((x) => x.t === 'M').at(-1);
  ok(me?.why === 'boss', `決着の理由はboss（${me?.why}）`);
  const ev = eventsOf(ps[0]);
  const bossSpawn = ev.find((e) => e.e === EV.MSPAWN && e.kind === 'boss');
  ok(!!bossSpawn, 'ボスが湧いていた');
  ok(bossSpawn && bossSpawn.scale > 1.5, `ボスは大きい（scale=${bossSpawn?.scale}）`);
  const bossWave = ev.find((e) => e.e === EV.WAVE && e.boss);
  ok(!!bossWave, 'ボス戦の知らせも飛んでいた');
}

console.log('\n[6] 協力プレイに戦域（20mの輪）は無い');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('coop');
  const p = join('端の人');
  room.takeSeat(p.slot, 0);
  room.setReady(p.slot, true);
  // 戦域の外（半径20mの外、半径30m地点）へ立たせて数秒待つ
  p.slot.sim.player.collider.start.set(30, 0.5, 0);
  p.slot.sim.player.collider.end.set(30, 1.6, 0);
  const hp0 = p.slot.sim.player.health;
  for (let i = 0; i < 600; i++) {
    // モンスターに殺されると戦域の検査にならないので、毎ティック無敵にする
    p.slot.sim.protectIn = 1;
    room._tick();
  }
  ok(p.slot.sim.player.health === hp0, '輪の外に立っていても削られない');
  room.setMode('dm');
  clear();
}

console.log('\n[7] 対人の進行を壊していない（デスマッチが今まで通り始まる）');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('dm');
  const ps = ['A', 'B'].map(join);
  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  ps[0].slot.chr = 0; ps[1].slot.chr = 1;
  ps.forEach((p) => room.setReady(p.slot, true));
  ok(room.phase === PHASE.LIVE, 'デスマッチは2人で始まる');
  ok(!room.monsters, 'モンスターの進行は畳まれている');
  for (let i = 0; i < 60; i++) room._tick();
  const snaps = ps[0].conn.sent.filter((m) => m.t === 'S');
  ok(snaps.every((m) => m.ms === undefined), '対人のスナップショットにmsは載らない');
  clear();
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
