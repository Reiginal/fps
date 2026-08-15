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

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
