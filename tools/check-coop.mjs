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
const { Monster, MSTATE, MONSTER_HIT } = await import('../src/ai/monster.js');

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
  const m = room.monsters.active.find((x) => x.mon.alive);
  const e = m.mon;
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
    e.collider.start.x, (e._bodyA.y + e._bodyB.y) / 2, e.collider.start.z,
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
  ok(target && target.mon.health < target.mon.maxHealth, '体力が減っている');

  // 撃ち切って倒す
  const kills0 = p.sim.kills;
  if (target) {
    while (target.mon.alive) room.monsters.hit(target, 100, 'body', p);
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
      if (m.mon.alive) room.monsters.hit(m, 1000, 'body', ps[0].slot);
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


/* ======================================================================
   ここから下は「モンスターがちゃんと襲ってくるか」の検査。

   なぜ要るか: 最初の実装は1人用の兵士AIを流用していて、**検査は全部通るのに
   遊ぶと何も起きなかった。** 実測すると60秒でモンスターが6体湧いて
   発砲1回・プレイヤーの体力は260→255しか減っていない。
   兵士は「間合いまで詰めたら止まって撃ち合う」設計なので、
   間に建物があると遮蔽の裏で立ち尽くす。加えて地形に挟まると
   3フレーム周期の足踏みで永久に固まる。

   通る／通らないの形（イベントが飛ぶ・体力が減る）をいくら並べても
   これは1つも捕まらない。**届くかどうかは距離と回数で測るしかない。**
   ====================================================================== */

console.log('\n[8] モンスターが本当にプレイヤーまで届く（距離と回数で測る）');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('coop');
  const p = join('的');
  room.takeSeat(p.slot, 0);
  room.setReady(p.slot, true);
  const me = p.slot.sim.player;
  // 棒立ちのまま60秒。**動かないのがこの検査の要**。
  // 昔の実装は「相手が動くから勝手に視線が通る」ことに寄りかかっていて、
  // 立ち止まった瞬間に何も起きなくなった
  for (let i = 0; i < 60 * 60; i++) {
    room._tick();
    me.health = Math.max(me.health, 40);   // 倒れると計測が止まるので生かしておく
  }
  const alive = room.monsters.active.filter((m) => m.mon.alive);
  const dists = alive
    .map((m) => Math.hypot(m.mon.collider.start.x - me.collider.start.x,
      m.mon.collider.start.z - me.collider.start.z))
    .sort((a, b) => a - b);
  const nearest = dists[0] ?? 99;
  // 爪の間合いは小型で2.4m。5m以内まで来ていれば「襲いに来ている」と言える
  ok(nearest < 5, `一番近い個体が5m以内まで来る（${nearest.toFixed(1)}m）`);
  const within = dists.filter((d) => d < 8).length;
  ok(within >= 3, `3体以上が8m以内に集まる（${within}体）`);

  const ev = eventsOf(p);
  const swings = ev.filter((e) => e.e === EV.MSWING).length;
  // 昔の実装はここが「60秒で1回」だった
  ok(swings >= 20, `60秒で20回以上は爪を振る（${swings}回）`);
  const hits = ev.filter((e) => e.e === EV.HIT && e.by === -1).length;
  ok(hits >= 5, `攻撃が実際に当たる（${hits}発）`);
}

console.log('\n[9] 詰まった個体が置き去りにならない（波が終わらなくなる元）');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('coop');
  const p = join('待つ人');
  room.takeSeat(p.slot, 0);
  room.setReady(p.slot, true);
  for (let i = 0; i < 300; i++) { p.slot.sim.protectIn = 1; room._tick(); }
  const m = room.monsters.active.find((x) => x.mon.alive);
  /* 「進もうとしているのに1歩も進めない」状態を作る。毎ティック元の位置へ
     引き戻すのが一番確実（実際に踏んだ形は、加速と押し戻しが釣り合う
     3フレーム周期の足踏みだった）。
     湧き直しが起きたかどうかは spawn() が呼ばれたかで見る——
     こちらが毎ティック引き戻しているので、位置では確かめられない */
  const pinned = m.mon.collider.start.clone();
  let respawned = 0;
  const origSpawn = m.mon.spawn.bind(m.mon);
  m.mon.spawn = (pos) => { respawned++; return origSpawn(pos); };
  let hopped = false;
  for (let i = 0; i < 60 * 12; i++) {
    p.slot.sim.protectIn = 1;
    room._tick();
    if (m.mon.velocity.y > 3) hopped = true;      // 跳ねて越えようとした
    m.mon.collider.start.copy(pinned);
    m.mon.collider.end.set(pinned.x, pinned.y + m.mon.height - m.mon.radius, pinned.z);
  }
  ok(hopped, '進めないと、まず跳ねて越えようとする');
  ok(respawned > 0, `それでも進めなければ湧き直す（${respawned}回）`);
}

console.log('\n[10] ボスの弱点（背中のコブ）');
{
  const boss = new Monster({ octree: world.octree, bounds: world.bounds, enemySpawns: world.enemySpawns },
    'boss', { visual: false });
  boss.spawn(new THREE.Vector3(0, 0.1, 0));
  boss.yaw = 0;              // 前方は-Z
  boss._syncHitboxes();
  const dirTo = (from) => {
    const o = new THREE.Vector3(...from);
    const d = new THREE.Vector3(0, boss.feetY + 1.3 * boss.scale, 0).sub(o).normalize();
    return { o, d };
  };
  // 正面(-Z側)から水平に撃つ。**弱点は背中にあるので当たってはいけない**
  {
    const { o, d } = dirTo([0, boss.feetY + 1.3 * boss.scale, -14]);
    const h = boss.intersect(o, d);
    ok(h && h.part !== 'weak', `正面からは弱点に当たらない（${h?.part}）`);
  }
  // 背中(+Z側)の、コブの高さから撃つ
  {
    const y = boss.feetY + MONSTER_HIT.WEAK.y * boss.scale;
    const o = new THREE.Vector3(0, y, 14);
    const d = new THREE.Vector3(0, y, 0.30 * boss.scale).sub(o).normalize();
    const h = boss.intersect(o, d);
    ok(h?.part === 'weak', `背中からは弱点に当たる（${h?.part}）`);
  }
  ok(Monster.mulOf('weak') > Monster.mulOf('body') * 2,
    `弱点は胴の2倍より大きい（${Monster.mulOf('weak')}倍）`);
  ok(Monster.mulOf('head') > Monster.mulOf('body'), '頭も胴より大きい');
  // 小型は弱点を持たない（遠くから背中を撃つだけの試合にしない）
  const small = new Monster({ octree: world.octree, bounds: world.bounds, enemySpawns: world.enemySpawns },
    'crawler', { visual: false });
  ok(!small.hasWeak, '小型には弱点が無い');
  ok(boss.hasWeak, 'ボスには弱点がある');
  ok(!boss.canBurrow, 'ボスは地面へ潜って湧き直さない（目の前から消えたら山場が壊れる）');
  ok(small.canBurrow, '小型は詰まったら潜って湧き直す');
}

console.log('\n[11] 火を吐く個体は、視線が通らない時に前へ出る（遮蔽の裏で止まらない）');
{
  const lvl = { octree: world.octree, bounds: world.bounds, enemySpawns: world.enemySpawns };
  const sp = new Monster(lvl, 'spitter', { visual: false });
  // 中央の掩体を挟んだ位置に立たせる。視線は通らないが、相手はすぐ向こう
  sp.spawn(new THREE.Vector3(0, 0.1, 16));
  const target = { pos: new THREE.Vector3(0, 0.94, -16), eyeY: 1.6, alive: true };
  const d0 = sp.collider.start.distanceTo(target.pos);
  for (let i = 0; i < 60 * 20; i++) sp.update(1 / 60, target, { others: [] });
  const d1 = sp.collider.start.distanceTo(target.pos);
  ok(d1 < d0 - 4, `視線が通らなくても詰める（${d0.toFixed(1)}m → ${d1.toFixed(1)}m）`);
  ok(d1 < 30, '掩体の裏で立ち尽くさない');
}

console.log('\n[12] ボスは技を一通り出す');
/* **平らな地面の上で測る。** 市街地の上でやると、中央の掩体で視線が切れて
   突進(視線が要る)と火の玉(視線が要る)が条件に入らず、
   「技が出ない」のか「そこへ行けない」のかが区別できない。
   そこへ行けるかは[8]と[9]が別に見ているので、ここは技の選び方だけを測る */
{
  const { Octree } = await import('three/addons/math/Octree.js');
  const flat = new THREE.Mesh(new THREE.BoxGeometry(160, 1, 160));
  flat.position.set(0, -0.5, 0);
  flat.updateMatrixWorld(true);
  const g = new THREE.Group();
  g.add(flat);
  const lvl = { octree: new Octree().fromGraphNode(g), bounds: 70, enemySpawns: [new THREE.Vector3(0, 0.1, 0)] };

  const boss = new Monster(lvl, 'boss', { visual: false });
  boss.spawn(new THREE.Vector3(0, 0.1, 0));
  const target = { pos: new THREE.Vector3(0, 0.94, 8), eyeY: 1.6, alive: true };
  const seen = new Set();
  let swings = 0, stomps = 0, roars = 0, spits = 0;
  boss.onMelee = () => { swings++; };
  boss.onStomp = () => { stomps++; };
  boss.onRoar = () => { roars++; };
  boss.onSpit = () => { spits++; };
  /* **相手を近づけたり離したりする。** 技は間合いで選ばれるので、
     1つの距離に置きっぱなしだと片方しか出ない
     （爪は4.6m以内、突進は7.4〜26m、火の玉は10m以上）。
     実際の試合でも、引きつける人と離れて撃つ人が同時にいる */
  for (let i = 0; i < 60 * 120; i++) {
    // 12秒ごとに、爪の間合いと遠間を行き来させる（ボスの位置から測って置く）
    const near = Math.floor(i / (60 * 12)) % 2 === 0;
    const want = near ? 3.0 : 17.0;
    const dx = target.pos.x - boss.collider.start.x;
    const dz = target.pos.z - boss.collider.start.z;
    const d = Math.hypot(dx, dz) || 1;
    target.pos.set(boss.collider.start.x + (dx / d) * want, 0.94, boss.collider.start.z + (dz / d) * want);
    boss.update(1 / 60, target, { others: [] });
    seen.add(boss.state);
  }
  ok(swings > 0, `爪を振る（${swings}回）`);
  ok(stomps > 0, `踏みつける（${stomps}回）`);
  ok(roars > 0, `咆哮する（${roars}回）`);
  ok(spits > 0, `離れた相手には火の玉を吐く（${spits}回）`);
  ok(seen.has(MSTATE.CHARGE), '突進もする');
  ok(seen.has(MSTATE.WINDUP), '殴る前に必ず溜めがある（避けられる）');
  /* **殴った後は一度離れる。** ここが効いていないと、爪の間合いに張り付いて
     突進も火の玉も一生出ないボスになる（実際そうなっていた） */
  ok(seen.has(MSTATE.SPIT) && seen.has(MSTATE.STOMP) && seen.has(MSTATE.ROAR),
    '技の状態が電文に乗る（クライアントが姿勢を作れる）');
}

console.log('\n[13] サーバーは見た目を組まない（軽さ）');
{
  const lvl = { octree: world.octree, bounds: world.bounds, enemySpawns: world.enemySpawns };
  const head = new Monster(lvl, 'boss', { visual: false });
  ok(head.root === null, 'visual:falseなら骨もメッシュも無い');
  ok(head.meshes.length === 0, '描く物を1つも持たない');
  // それでも当たり判定は引ける（位置と向きから計算しているため）
  head.spawn(new THREE.Vector3(0, 0.1, 0));
  const o = new THREE.Vector3(0, head.feetY + 1.2 * head.scale, -12);
  const d = new THREE.Vector3(0, head.feetY + 1.2 * head.scale, 0).sub(o).normalize();
  ok(!!head.intersect(o, d), '見た目が無くても弾は当たる');

  // 1体ぶんのupdate()にかかる時間。**サーバーは1刻み16.7msしか無い**
  const many = [];
  for (let i = 0; i < 12; i++) {
    const m = new Monster(lvl, i === 0 ? 'boss' : 'crawler', { visual: false });
    m.spawn(world.enemySpawns[i % world.enemySpawns.length]);
    many.push(m);
  }
  const target = { pos: new THREE.Vector3(0, 0.94, 0), eyeY: 1.6, alive: true };
  const ctx = { others: many };
  for (let i = 0; i < 60; i++) for (const m of many) m.update(1 / 60, target, ctx);  // 暖機
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 600; i++) for (const m of many) m.update(1 / 60, target, ctx);
  const per = Number(process.hrtime.bigint() - t0) / 1e6 / 600;
  ok(per < 4, `12体を1刻み動かして4ms未満（${per.toFixed(2)}ms）`);
}

console.log('\n[14] 見た目を実際に組んで動かす（ブラウザでしか走らない側）');
/* なぜ要るか: モンスターの姿と姿勢は**クライアントでしか走らない**。
   サーバーは visual:false で骨を1つも持たないので、
   ここまでの検査を全部通しても「開いたらモンスターが出ない／画面が黒い」は
   1つも捕まらない。import の綴りを check-imports が見るのと同じ理屈で、
   組み立てと1フレームぶんの姿勢付けだけでも回しておく */
{
  const { RemoteMonsters } = await import('../src/net/remoteMonsters.js');
  const scene = new THREE.Scene();
  const rm = new RemoteMonsters(scene);

  for (const kind of Object.keys(MONSTER_KINDS)) {
    const m = new Monster({ octree: null, bounds: null, enemySpawns: null }, kind, { visual: true });
    ok(!!m.root && m.meshes.length > 0, `${kind} の姿が組める（メッシュ${m.meshes.length}枚）`);
    // 骨が揃っているか。1つでも欠けると animate() が落ちる
    const bones = ['hips', 'spine', 'neck', 'headPivot', 'jaw', 'hump',
      'armL', 'foreL', 'armR', 'foreR', 'legL', 'shinL', 'footL',
      'legR', 'shinR', 'footR', 'tail1', 'tail2', 'tail3'];
    ok(bones.every((b) => m.parts[b]), `${kind} の骨が全部ある`);
    // 姿勢。全部の状態を1回ずつ通す（溜め・突進・怯みで骨の回し方が変わる）
    for (const st of Object.values(MSTATE)) {
      m.animate(1 / 60, { speed: 3, state: st, pitch: 0.2 });
    }
    m.animateDeath(0.4);
    ok(Number.isFinite(m.parts.hips.position.y), `${kind} は全部の状態で姿勢が数になる（NaNにならない）`);
    m.dispose();
  }

  // 湧く→動く→倒れる→消える、をクライアント側で一周させる
  rm.spawn(1, 'crawler', MONSTER_KINDS.crawler.scale, [4, 0, 4]);
  rm.spawn(2, 'boss', MONSTER_KINDS.boss.scale, [-6, 0, 2]);
  ok(rm.slots.size === 2, '2体ぶんの姿が場面に入る');
  rm.sync([{ mid: 1, x: 5, y: 0, z: 5, yaw: 0.4, pitch: 0, state: MSTATE.SEEK },
    { mid: 2, x: -5, y: 0, z: 3, yaw: 1.2, pitch: 0, state: MSTATE.WINDUP }]);
  for (let i = 0; i < 30; i++) rm.update(1 / 60);
  const head = rm.get(1)?.headPos;
  ok(!!head && Number.isFinite(head.x), '頭の位置が引ける（音と火花の置き場）');
  // 火の玉。吐く→飛ぶ→弾ける
  rm.spit([0, 1.5, 0], [0, 0, -1], 26);
  ok(rm._spits.length === 1, '火の玉が1つ飛ぶ');
  for (let i = 0; i < 20; i++) rm.update(1 / 60);
  ok(rm._spits[0].mesh.position.z < -5, '火の玉が前へ進む');
  rm.boom([rm._spits[0].mesh.position.x, rm._spits[0].mesh.position.y, rm._spits[0].mesh.position.z]);
  ok(rm._spits.length === 0, '弾けたら消える');
  // 倒す。死に絵を演じ切ってから場面から外れる
  rm.kill(1);
  for (let i = 0; i < 60 * 5; i++) rm.update(1 / 60);
  ok(!rm.slots.has(1), '倒れた個体は時間で消える');
  rm.dispose();
  ok(rm.slots.size === 0, '畳めば全部消える');
}

console.log('\n[15] 描く物が増えすぎていない（軽さ）');
/* このrepoは「軽さは機能より優先」なので、姿を1体足すたびに
   描画呼び出しが何本増えるかを見張る。メッシュ1枚＝描画1回。
   同時に生きられる数(ALIVE_CAP)を掛けた合計が、対戦の最大人数ぶんの
   兵士より大きく膨らんでいないことを確かめる */
{
  const { Enemy } = await import('../src/ai/enemy.js');
  const count = (root) => { let n = 0; root.traverse((o) => { if (o.isMesh) n++; }); return n; };
  const soldier = count(new Enemy({ octree: null, bounds: null }).root);
  for (const kind of Object.keys(MONSTER_KINDS)) {
    const m = new Monster({ octree: null }, kind, { visual: true });
    const n = count(m.root);
    ok(n <= soldier, `${kind} は兵士より描く物が少ない（${n}枚 / 兵士${soldier}枚）`);
    m.dispose();
  }
}


console.log('\n[16] 協力プレイで仲間が仲間だと分かる');
/* なぜ要るか: 味方かどうかの判定(_isMate)が`mode === 'team'`だけを見ていたので、
   **協力プレイでは名札が一枚も出ていなかった。**
   見た目は全員同じ兵士で、名前も体力も出ないので、遊んでいる間ずっと
   「どれが仲間か分からない」「誰が倒れているか分からない」状態だった。
   引きつける人と背中へ回る人が要る遊びなのに、画面に手掛かりが無い */
{
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const isMate = main.split('_isMate(id) {')[1]?.split('\n  }')[0] || '';
  ok(isMate.length > 0, '味方かどうかを決める所が見つかった');
  ok(/net\.mode === 'coop'/.test(isMate) && /return true/.test(isMate),
    '協力プレイは席に関係なく全員が味方（server/modes.jsのteamOfと揃う）');

  const plates = main.split('_updatePlates(states) {')[1]?.split('\n  }')[0] || '';
  ok(/const down = /.test(plates) && /coop && this\._isMate/.test(plates),
    '倒れている仲間にも札を出す（協力プレイだけ）');
  ok(/alwaysBar: coop && mate/.test(plates),
    '協力プレイの仲間は体力の帯を常に出す（誰が削られているかで次の動きが決まる）');

  const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
  ok(/p\.alwaysBar/.test(hud), 'HUD側が常時の帯を受けている');
  ok(/classList\.toggle\('down'/.test(hud), 'HUD側が倒れている印を付けている');
  ok(/classList\.toggle\('occl'/.test(hud), 'HUD側が壁の向こうの印を付けている');

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/\.plate\.down /.test(html), '倒れている札の見た目がCSSにある');
  ok(/\.plate\.occl /.test(html), '壁の向こうの札の見た目がCSSにある');
}

console.log('\n[17] 影を落とすのは近くの個体だけ（カクつきの元）');
/* なぜ要るか: 太陽の影は2枚に分けて焼いていて、遠い1枚は
   「遠くで何かが動いていたら、影を落とすメッシュ全部を丸ごと焼き直す」作り。
   モンスターの影を44m（場内のほぼ全域）まで立てていたので、
   **地形96枚の焼き直しに、モンスター408枚が丸ごと乗っていた**（5.2倍）。
   3フレームに1回それが走るので、毎秒20回の息継ぎになる。
   2026-08-17に「協力プレイだと歩くだけでカクカクする」と言われた所 */
{
  const { RemoteMonsters } = await import('../src/net/remoteMonsters.js');
  const scene = new THREE.Scene();
  const rm = new RemoteMonsters(scene);
  const cam = new THREE.PerspectiveCamera();
  cam.position.set(0, 1.6, 0);

  rm.spawn(1, 'crawler', 0.78, [4, 0, 0]);     // 近い
  rm.spawn(2, 'crawler', 0.78, [30, 0, 0]);    // 遠い
  const at = (mid, x) => ({ mid, x, y: 0, z: 0, yaw: 0, pitch: 0, state: MSTATE.SEEK });
  rm.sync([at(1, 4), at(2, 30)]);
  for (let i = 0; i < 90; i++) rm.update(1 / 60, cam);

  const casters = (mid) => rm.slots.get(mid).mon.meshes.filter((m) => m.castShadow).length;
  const total = rm.slots.get(1).mon.meshes.length;
  ok(casters(1) === total, `4mの個体は影を落とす（${casters(1)}/${total}枚）`);
  ok(casters(2) === 0, `30mの個体は落とさない（${casters(2)}枚）`);

  // 近づいたら点く。切りっぱなしだと足元の暗がりが二度と戻らない
  rm.sync([at(1, 4), at(2, 6)]);
  for (let i = 0; i < 90; i++) rm.update(1 / 60, cam);
  ok(casters(2) === total, '近づいてきたら点く');

  // cameraを渡さない呼び方でも落ちない（距離が測れないので全部切る）
  rm.update(1 / 60);
  ok(casters(1) === 0 && casters(2) === 0, 'カメラ無しで呼ばれたら全部切る');
  rm.dispose();
}

console.log('\n[18] 光る所は1体ずつ別の材質を持つ');
/* なぜ要るか: 目と口の奥の材質を種類ごとに1つ共有していた。
   animate()が毎フレーム emissiveIntensity を書くので、
   **その種類の全個体が「最後に姿勢を作った1体」の明るさになる。**
   溜めている個体だけ光るという唯一の予告が、群れの中では
   誰の予告でもない点滅になっていた。倒れる絵は0まで落とすので、
   1体倒れると生きている全員の目が消える回まであった。
   2026-08-17に「敵の攻撃モーションが俺に全く見えない」と言われた所 */
{
  const a = new Monster({ octree: null }, 'crawler', { visual: true });
  const b = new Monster({ octree: null }, 'crawler', { visual: true });
  ok(a.parts.mats.glow !== b.parts.mats.glow, '同じ種類でも光る材質は別物');
  ok(a.parts.mats.hide === b.parts.mats.hide, '皮は共有のまま（枚数を増やさない）');

  const st = (state) => ({ speed: 0, state, pitch: 0 });
  // aだけ溜めさせる。bは歩いているだけ
  for (let i = 0; i < 60; i++) { a.animate(1 / 60, st(MSTATE.WINDUP)); b.animate(1 / 60, st(MSTATE.SEEK)); }
  const ga = a.parts.mats.glow.emissiveIntensity;
  const gb = b.parts.mats.glow.emissiveIntensity;
  ok(ga > gb * 2, `溜めている個体だけが強く光る（溜め${ga.toFixed(1)} / 歩き${gb.toFixed(1)}）`);
  a.dispose(); b.dispose();
}

console.log('\n[19] 溜めに入った瞬間を1回だけ知らせる');
/* 爪は振った瞬間に当たるので、避けられるかどうかは溜めが分かるかで決まる。
   小型は体高1.26mで間合い2.4mだと視線の下に沈むため、音でも知らせる。
   **専用の電文は作らない**（状態番号は20Hzの定期便に元から載っている）*/
{
  const { RemoteMonsters } = await import('../src/net/remoteMonsters.js');
  const scene = new THREE.Scene();
  const rm = new RemoteMonsters(scene);
  const cam = new THREE.PerspectiveCamera();
  rm.spawn(1, 'crawler', 0.78, [2, 0, 0]);
  let tells = 0;
  const onTell = () => { tells++; };
  const at = (state) => [{ mid: 1, x: 2, y: 0, z: 0, yaw: 0, pitch: 0, state }];

  rm.sync(at(MSTATE.SEEK));
  for (let i = 0; i < 10; i++) rm.update(1 / 60, cam, onTell);
  ok(tells === 0, '歩いているだけでは鳴らない');

  rm.sync(at(MSTATE.WINDUP));
  for (let i = 0; i < 25; i++) rm.update(1 / 60, cam, onTell);   // 溜めは0.42秒＝25コマ
  ok(tells === 1, `溜めの間に1回だけ（${tells}回）`);

  rm.sync(at(MSTATE.STRIKE));
  for (let i = 0; i < 10; i++) rm.update(1 / 60, cam, onTell);
  rm.sync(at(MSTATE.WINDUP));
  for (let i = 0; i < 10; i++) rm.update(1 / 60, cam, onTell);
  ok(tells === 2, '次の溜めでまた鳴る');
  rm.dispose();
}

console.log('\n[20] モンスターに殴られた時、どこから来たかが届く');
/* なぜ要るか: 撃たれた向きのリングは「撃った人のidから位置を引く」作り。
   モンスターは人ではないので by:-1 で届き、引く先が無いまま
   **モンスターの一撃だけ向きが一切出ていなかった。**
   「気づいたらダメージ食らってる」の半分はこれ */
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('coop');
  const a = join('こう');
  room.takeSeat(a.slot, 0);
  room.setReady(a.slot, true);
  ok(room.phase === PHASE.LIVE, '試合が始まった');

  // 湧いた直後の無敵(protectIn)が切れるまで回す。切れる前は当たっても無視される
  for (let i = 0; i < 600; i++) room._tick();
  a.conn.sent.length = 0;
  // 爪が届いたことにして、直接叩く（湧いて歩いてくるのを待たない）
  const from = new THREE.Vector3(7, 1, -3);
  room._monsterHitPlayer(a.slot, 9, 'claw', from);
  for (let i = 0; i < 10; i++) room._tick();   // 溜めた出来事は刻みで配られる
  const hit = eventsOf(a).find((e) => e.e === EV.HIT && e.by === -1);
  ok(!!hit, 'モンスターの一撃が届く（by:-1）');
  ok(Array.isArray(hit?.mp) && hit.mp.length === 3, 'どこから来たかが載っている（mp）');
  ok(Math.abs(hit.mp[0] - 7) < 0.01 && Math.abs(hit.mp[2] + 3) < 0.01,
    `位置が合っている（${hit.mp.join(', ')}）`);

  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/ev\.mp[\s\S]{0,120}?_damageFromPoint/.test(main), 'クライアントがmpから向きを出している');
  clear();
}

console.log('\n[21] 上帯と地図から対戦用の物が消えている');
/* 協力プレイにはラウンドも先取本数も制限時間も戦域も無い（server/modes.jsのcoop、
   room.jsの_zone）。それでも対戦用の表示を通していたので
   「0 － 0 ／ 3本先取 ／ 残り 3:00」と、起きないことを3つ並べていた。
   地図の方は逆に、**味方の点を出す条件が`mode === 'team'`だけ**だったので
   協力プレイでは仲間の居場所が画面のどこにも無かった
   （2026-08-17に「味方が範囲外に行きすぎてカバーができねえ」）*/
{
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');

  ok(/net\.mode === 'coop'[\s\S]{0,200}?hud\.coopInfo\(/.test(main),
    '協力プレイは専用の上帯(coopInfo)へ回している');
  const coopInfo = hud.split('coopInfo(')[1]?.split('\n  }')[0] || '';
  ok(coopInfo.length > 0, 'coopInfoが居る');
  ok(!/本先取/.test(coopInfo) && !/padStart/.test(coopInfo),
    '先取本数も時計も出さない');
  ok(/第\$\{wave\}波/.test(coopInfo) && /残り \$\{alive\}体/.test(coopInfo),
    '代わりに第何波とあと何体かを出す');

  const mini = main.split('_minimapFrame(dt) {')[1]?.split('\n  }')[0] || '';
  ok(/coop \|\| this\.net\?\.mode === 'team'/.test(mini),
    '地図に味方の点を出す（協力プレイも）');
  ok(/const zoned = versus && !coop/.test(mini) && /zoned \? ZONE\.RADIUS : 0/.test(mini),
    '協力プレイに戦域の円は出さない（サーバー側にも戦域が無い）');
  ok(/if \(!zoned \|\| !this\.player\.alive\)/.test(mini),
    '範囲外の警告も出さない');

  // 戦績表と名簿。取ったラウンドは協力プレイでは全員ずっと0
  ok(/scoreboard\(rows, input\.down\('Tab'\), net\.mode === 'coop'\)/.test(main),
    '戦績表に協力プレイかどうかを渡している');
  ok(/_setBoardHead\(/.test(hud) && /coop \? '撃破' : '取得'/.test(hud),
    '見出しを撃破と倒れた数に差し替える');
}

console.log('\n[22] 波の数とテンポ');
/* 「ボスまで見たいから敵少なめにしてほしい」と言われた所（2026-08-17）。
   前は1人でも8/12/16の36体で、ボスに辿り着く前に同じ作業を36回やっていた */
{
  const { MonsterDirector } = await import('../server/monsters.js');
  const d = new MonsterDirector(world, {});
  const total = (n) => {
    let s = 0;
    for (let w = 1; w <= WAVE_COUNT; w++) s += d._composition(w, n).length;
    return s;
  };
  ok(total(1) <= 26, `1人でボスまで${total(1)}体（26体以内）`);
  ok(total(4) <= 46, `4人でボスまで${total(4)}体（46体以内）`);
  ok(d._composition(1, 1).every((k) => k === 'crawler'),
    '1波目に火を吐く方は出さない（遊び方を覚える前に焼かれる）');
  ok(d._composition(2, 1).includes('spitter'), '2波目から火を吐く方が出る');
  for (let w = 1; w < WAVE_COUNT; w++) {
    ok(d._composition(w + 1, 1).length > d._composition(w, 1).length,
      `第${w + 1}波は第${w}波より多い`);
  }

  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/monsters.js', import.meta.url), 'utf8');
  const cap = Number(src.match(/const ALIVE_CAP = (\d+);/)?.[1]);
  ok(cap > 0 && cap <= 10, `同時に生きられるのは${cap}体まで（画面の重さに直に効く）`);
  // 0の代入（波の頭で戻す所）ではなく、次の1体までの間隔の方を読む
  const gap = Number(src.match(/this\.spawnTimer = (0\.\d+);/)?.[1]);
  ok(gap > 0 && gap <= 0.5, `湧く間隔は${gap}秒（0.8秒だと波の頭が待ち時間になる）`);
}

console.log('\n[23] 波が変わったら弾が戻る');
/* 落ちている物を拾えない遊び方(modes.jsのdrops:false)なので、
   補給が無いと3波目までに撃ち切った人はボスに何もできない。
   2026-08-17に「第2波になってタイミングで弾の補充はさすがに欲しい」*/
{
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const wave = main.split('case EV.WAVE: {')[1]?.split('\n      }')[0] || '';
  ok(wave.length > 0, '波の知らせを受ける所が見つかった');
  ok(/this\.weapons\.refillReserve\(\)/.test(wave), '予備弾を満タンに戻している');
  ok(!/w\.ammo = /.test(wave), 'マガジンの中身は戻さない（装填を飛ばせてしまう）');
  ok(/if \(got\)/.test(wave), '満タンの時は「補給した」と言わない');

  // ボス戦の頭でも戻る（ここが抜けると一番弾が要る所で空になる）
  ok(main.split('case EV.WAVE: {')[1].indexOf('refillReserve')
    < main.split('case EV.WAVE: {')[1].indexOf('boss ? \'ボスが来た\''),
    'ボス戦の垂れ幕より先に補給する（ボスの波でも戻る）');
}

console.log('\n[24] 毎フレーム作って捨てる物を増やしていない');
/* GCが動く回数がそのまま画面の息継ぎになる。
   姿勢を作る所は同時に10体ぶん走るので、1体あたりの取りこぼしが10倍で効く */
{
  const src = (await import('node:fs')).readFileSync(
    new URL('../src/net/remoteMonsters.js', import.meta.url), 'utf8',
  );
  ok(/this\._st = \{ speed: 0, state: 0, pitch: 0 \}/.test(src),
    'animateへ渡す入れ物を1つ持っている');
  ok(!/animate\(dt, \{/.test(src), 'その場で入れ物を作っていない');

  const mon = (await import('node:fs')).readFileSync(
    new URL('../src/ai/monster.js', import.meta.url), 'utf8',
  );
  ok(/this\._stepL = \{/.test(mon) && /step\(this\._stepL/.test(mon),
    '脚の角度の入れ物も使い回している');
}

console.log('\n[25] 4人が固まって湧いて、そこから歩ける');
/* なぜ要るか: 協力プレイは2対2用の湧き表(teamSpawns)をそのまま使っていた。
   全員が同じチーム（modes.jsのteamOf）なのに、**3人目と4人目だけ
   35m離れた反対側から出てくる。** 倒れた仲間を起こしにも行けないし、
   モンスターは一番近い人を個別に狙うので、試合の頭からばらばらのまま削られる。
   2026-08-17に「味方が範囲外に行きすぎてカバーができねえ」と言われた所。

   固めるだけでは足りない。**固めた先が歩ける所かどうかは歩かせないと分からない**
   （建物は中が空洞なので、部屋の真ん中でも埋まり判定はすり抜ける。
   check-edo.mjsの[7]で実際に踏んだ）*/
{
  const { SimPlayer } = await import('../server/sim.js');
  const { MAP_IDS } = await import('../src/net/protocol.js');
  const K_FWD = 1 << 0;
  for (const mapId of MAP_IDS) {
    const w = buildWorld(mapId);
    const sp = w.coopSpawns;
    ok(Array.isArray(sp) && sp.length >= 4, `${mapId}: 協力プレイ用の湧き表がある（${sp?.length}箇所）`);

    // 一番離れた2人でも声が届く距離に居ること
    let widest = 0;
    for (let i = 0; i < sp.length; i++) {
      for (let j = i + 1; j < sp.length; j++) {
        widest = Math.max(widest, Math.hypot(sp[i].x - sp[j].x, sp[i].z - sp[j].z));
      }
    }
    ok(widest <= 10, `${mapId}: 一番離れた2人でも${widest.toFixed(1)}m（10m以内）`);
    // 逆に重なってもいけない（同じ点に2人置くと押し合って弾かれる）
    ok(widest >= 3, `${mapId}: 重なってはいない（${widest.toFixed(1)}m）`);

    const sim = new SimPlayer(1, '検査', w);
    let stuck = 0;
    for (const v of sp) {
      let open = 0;
      for (let a = 0; a < 8; a++) {
        const dir = (a / 8) * Math.PI * 2;
        sim.spawn(new THREE.Vector3(v.x, 0.1, v.z), dir);
        for (let i = 0; i < 60 * 3; i++) sim.tick(K_FWD, dir, 0);
        const c = sim.player.collider.start;
        if (Math.hypot(c.x - v.x, c.z - v.z) > 5) open++;
      }
      if (open < 5) stuck++;
    }
    ok(stuck === 0, `${mapId}: どの湧き点からも8方向のうち5方向以上へ歩ける（詰まり${stuck}箇所）`);
  }

  // 部屋が本当にその表を引いていること（表を足しても繋がっていなければ意味が無い）
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  ok(/this\.rules\?\.coop && this\.world\.coopSpawns/.test(src),
    '部屋が協力プレイの時にその表を引いている');
}

console.log('\n[26] ボスがちゃんと殴りに来る（実際に180秒動かして数える）');
/* なぜ要るか: 2026-08-17に「ボスが全然怖くないし、全然こっち殴ってこない」と
   言われて実測したら、原因が4つ重なっていた。

   ① 殴った後に必ず2.6秒下がる処理(_backoff)が**永久ループしていた。**
      判定が「冷却が明けているか」だけで「その距離でその技が出せるか」を
      見ていない。爪の間合い(4.6m)では突進(7.4m以上)も火の玉(10m以上)も
      撃てないので冷却は0のまま張り付き、条件が常に真になる。
      3mに張り付かせた180秒で、下がっていたのが109.1秒(61%)、
      間合いに居て手が空いていた69.2秒のうち**68.5秒(99%)が不発**だった
   ② 5.2〜7.4mに**出せる技が1つも無い空白帯**があった。
      6.0mに立たれると180秒で爪0・踏み0・火0・突進0（咆哮だけ）
   ③ 踏み(5.2m)と咆哮(20m)が爪(4.6m)より先に判定されるので、
      **一番痛い技(34)が一番出なかった**
   ④ ボスの足3.1m/sに対しプレイヤーは走り7.4m/s。走って逃げられると
      **180秒追って爪0回・合計99ダメージ**

   全部「遊んでみないと分からない」ではなく机上で数えられる物なので、
   ここで数え続ける。**遅いのでこの節だけ数秒かかる** */
{
  const { Monster, MSTATE: MS } = await import('../src/ai/monster.js');
  const DT = 1 / 60;

  /* **乱数の種を固定する。**（やり方は tools/check-swarm.mjs と同じ）
     モンスターは進路の揺らぎ(jitter)・湧いた直後の火の玉の待ち時間・
     詰まった時にどちらへ回るか、を Math.random() で決める。
     素のままだと**この節は毎回別の試合を測っている**ことになり、
     敷居の際の項目が運で落ちる。実際、種を入れる前は
     同じコードで「60秒に24回」と「8回」の両方が出た。
     時々落ちる検査は最後には誰も見なくなる */
  const realRandom = Math.random;
  let _s = 20260817;
  Math.random = () => { _s = (_s * 1664525 + 1013904223) >>> 0; return _s / 4294967296; };

  /* **江戸で測る。** 協力プレイは江戸でしかやらない（[28]）ので、
     ボスの振る舞いもそこで測らないと意味が無い。
     遮蔽の量も広さも市街地とは別物になる */
  const cw = buildWorld('edo');

  // 標的を動かしながらボスを回して、出した技と当てた回数を数える
  const play = (mover, secs = 60, startD = 14) => {
    _s = 20260817;   // 1本ごとに同じ所から始める
    const level = { octree: cw.octree, bounds: cw.bounds, enemySpawns: cw.enemySpawns };
    const m = new Monster(level, 'boss', { visual: false });
    m.spawn(new THREE.Vector3(0, 0.2, 0));
    const target = { pos: new THREE.Vector3(startD, 0.2, 0), eyeY: 1.6, alive: true };
    const out = { claw: 0, stomp: 0, charge: 0, spit: 0, hits: 0, dmg: 0, inReach: 0, idleSeek: 0 };
    const land = (self, d, reach) => {
      const c = self.collider.start;
      const px = target.pos.x - c.x, pz = target.pos.z - c.z;
      const dd = Math.hypot(px, pz);
      const fx = -Math.sin(self.yaw), fz = -Math.cos(self.yaw);
      if (dd > reach) return;
      if (dd > 0.1 && (px / dd) * fx + (pz / dd) * fz < 0.25) return;
      out.hits++; out.dmg += d;
    };
    m.onMelee = land;
    m.onStomp = (self, radius, d) => {
      const c = self.collider.start;
      if (Math.hypot(target.pos.x - c.x, target.pos.z - c.z) <= radius) { out.hits++; out.dmg += d; }
    };
    m.onSpit = () => { out.spit++; };
    let was = m.state;
    const b = (cw.bounds || 38) - 2;
    for (let i = 0; i < secs / DT; i++) {
      mover(target.pos, m.collider.start, DT);
      target.pos.x = Math.max(-b, Math.min(b, target.pos.x));
      target.pos.z = Math.max(-b, Math.min(b, target.pos.z));
      m.update(DT, target, { others: [] });
      if (m.state !== was) {
        if (m.state === MS.WINDUP) out.claw++;
        if (m.state === MS.STOMP) out.stomp++;
        if (m.state === MS.CHARGE) out.charge++;
        was = m.state;
      }
      if (m.state === MS.SEEK || m.state === MS.IDLE) out.idleSeek += DT;
      const d = Math.hypot(target.pos.x - m.collider.start.x, target.pos.z - m.collider.start.z);
      if (d <= m.def.melee.reach) out.inReach += DT;
    }
    return out;
  };
  const still = () => {};
  const flee = (sp) => (p, c, dt) => {
    const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz) || 1;
    p.x += (dx / d) * sp * dt; p.z += (dz / d) * sp * dt;
  };

  const a = play(still, 60);
  ok(a.claw >= 15, `棒立ちの相手を60秒で${a.claw}回殴りにいく（15回以上）`);
  ok(a.dmg > 600, `与えた被害 ${Math.round(a.dmg)}（600以上。プレイヤーの体力は260）`);

  // ④ 走って逃げる相手。前は爪0回・99ダメージだった
  const b2 = play(flee(7.4), 60);
  ok(b2.hits > 0, `走って逃げる相手にも届く（当てた${b2.hits}回。前は0回）`);

  // ② 空白帯。6mに張り付かせて、何か1つは出ること
  const hold = (dd) => (p, c) => {
    const dx = p.x - c.x, dz = p.z - c.z, d = Math.hypot(dx, dz) || 1;
    p.x = c.x + (dx / d) * dd; p.z = c.z + (dz / d) * dd;
  };
  const c6 = play(hold(6.0), 30);
  ok(c6.charge + c6.stomp + c6.claw + c6.spit > 0,
    `5.2〜7.4mの空白帯が無い（6.0mで技が${c6.charge + c6.stomp + c6.claw + c6.spit}回出た。前は0回）`);
  const c3 = play(hold(3.0), 30);
  ok(c3.claw >= 8, `3.0mでは爪が主役（30秒で${c3.claw}回。前は後退で61%潰れていた）`);
  ok(c3.idleSeek < 30 * 0.35,
    `間合いの中で手が空いていない（歩いていた${c3.idleSeek.toFixed(1)}秒 / 10.5秒未満）`);
  Math.random = realRandom;   // 後の節へ持ち越さない
}

console.log('\n[27] ボスの作りが元へ戻っていない（読んで確かめる）');
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/ai/monster.js', import.meta.url), 'utf8');
  ok(!/_backoff/.test(src.replace(/2\.6秒の後退\(_backoff\)/g, '')),
    '殴った後に下がる処理を持っていない');

  const pick = src.split('/* 技の選び方。')[1]?.split('/* ------')[0] || '';
  ok(pick.length > 0, '技の選び方が見つかった');
  const clawAt = pick.indexOf('dist <= def.melee.reach');
  const stompAt = pick.indexOf('def.stomp &&');
  const roarAt = pick.indexOf('def.roar &&');
  ok(clawAt > 0 && stompAt > clawAt, '爪を踏みつけより先に見る（一番痛い技が一番出る）');
  ok(roarAt > clawAt && roarAt > stompAt, '咆哮は一番後ろ（自分で殴らない手なので）');

  const { MONSTER_KINDS: K } = await import('../src/ai/monster.js');
  const boss = K.boss;
  ok(boss.charge.minRange < boss.stomp.radius * 0.8,
    `突進の下限(${boss.charge.minRange}m)が踏みの届く所(${(boss.stomp.radius * 0.8).toFixed(1)}m)と重なっている`);
  ok(boss.speed > 4.0, `足が遅すぎない（${boss.speed}m/s。3.1では走る相手に永久に届かない）`);
  ok(boss.speed < 4.7, `プレイヤーの歩き(4.7m/s)より遅い（意識して下がれば引き離せる）`);
  ok(Array.isArray(boss.rage) && boss.rage.length >= 2, '手負いの段を持っている');
  ok(boss.charge.hitRecover < boss.charge.stun,
    `当てた時の硬直(${boss.charge.hitRecover}秒)が外した時(${boss.charge.stun}秒)より短い`);

  // 段が体力だけで決まる＝サーバーとクライアントで必ず一致する
  const m = new Monster({ octree: null }, 'boss', { visual: false });
  m.health = m.maxHealth;
  ok(m.ragePhase === 0, '満タンなら段は0');
  m.health = m.maxHealth * 0.5;
  ok(m.ragePhase === 1, '半分で段が1つ上がる');
  m.health = m.maxHealth * 0.2;
  ok(m.ragePhase === 2, '2割で段が2つ上がる');
  ok(m.rageCdMul < 1 && m.rageSpeedMul > 1, '段が上がると間隔が縮んで足が速くなる');
}

console.log('\n[28] 協力プレイは江戸でしかやらない');
/* 2026-08-17に「協力モードは江戸じゃない方のマップは消しといていい」と言われた所。
   選べるようにしておくと、湧き地点も遮蔽も妖怪の見た目も2つのマップぶん
   考えることになるし、市街地の廃墟に妖怪が出るのも噛み合っていない */
{
  clear();
  room.phase = PHASE.WAIT;
  // 前の節が協力プレイのまま残っていることがあるので、先に対戦へ戻してから始める
  room.setMode('dm');
  room.setMap('urban');
  ok(room.map === 'urban', '前提: 市街地に居る');
  room.setMode('coop');
  ok(room.map === 'edo', '協力プレイを選ぶと江戸へ移る');
  ok(room.world.mapId === 'edo', '地形も江戸に差し替わっている');
  ok(room.setMap('urban') === false, '協力プレイの最中は市街地へ移せない');
  ok(room.map === 'edo', '断った後も江戸のまま');

  // 他の遊び方へ戻したら、そこは自由（江戸で対戦したい人が選び直さずに済む）
  room.setMode('dm');
  ok(room.map === 'edo', '協力から戻っても勝手に市街地へ戻さない');
  ok(room.setMap('urban') === true, '対戦なら市街地を選べる');

  const { readFileSync } = await import('node:fs');
  const lobby = readFileSync(new URL('../src/ui/lobby.js', import.meta.url), 'utf8');
  ok(/coopOnly/.test(lobby) && /classList\.toggle\('hidden'/.test(lobby),
    'ロビーの札も畳んでいる（押しても変わらない札を並べない）');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/\.lbmode\.hidden/.test(html), '畳む見た目がCSSにある');
  clear();
  room.setMode('dm');
  room.setMap('urban');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
