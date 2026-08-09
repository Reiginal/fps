// 対戦のCPUの検査。**本物のRoomを本物の地形の上で動かす。**
//
// なぜ要るか: CPUを足した理由が「1人だと対戦を一度も確かめられない」なので、
// そのCPU自体を確かめる手立てが無いと、確かめる道具を確かめずに使うことになる。
//
// 特に見たいのは「静かに壊れる」形:
//   ・席には座るが1発も撃たない（相手を見つけられていない・向きが逆）
//   ・撃つが1発も当たらない（撃つ向きと見ている向きが食い違っている）
//   ・壁に張り付いたまま試合が終わる
//   ・人が来ても席を譲らない
//   ・誰も居なくなった部屋で永久に撃ち合い続ける（本番のCPU代を食い続ける）
// どれも遊んでいる最中には「なんか変」としか見えない。
//
//   node tools/check-bots.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { PHASE, SEATS } from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');
const { Bot, aimAt, forwardOf, turnToward } = await import('../server/bot.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const mkConn = () => ({ sent: [], rtt: 0, send(m) { this.sent.push(m); } });
const room = getRoom(world);

/* CPUの乱数を種から作り直す。**そのままだとMath.randomなので、検査が日によって落ちる。**
   （うろつく向き・回り込む側・横移動の向きが全部乱数。check-swarmとcheck-soundで
   同じ形の揺れを踏んで、どちらも種を固定して直した） */
const lcg = (seed) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const seedBots = () => {
  let n = 1;
  for (const s of room.slots.values()) if (s.bot) s.bot = new Bot({ rng: lcg(12345 * n++) });
};
// 部屋は1つしか無く、他の検査と同じプロセスで動くこともある（check-lobbyと同じ作法）
const clear = () => { for (const s of [...room.slots.values()]) room.leave(s); };
clear();

const join = (name) => {
  const conn = mkConn();
  const slot = room.join(conn, name);
  conn.slot = slot;
  return { conn, slot };
};

console.log('\n[1] 向きの計算（撃つ向きと見る向きが同じ式から出ている）');
{
  /* ここがずれると「明後日の方向へ撃つCPU」になる。
     aimAtで作った角度からforwardOfで向きを戻して、元の向きに戻ることを見る */
  const from = { x: 0, y: 1.6, z: 0 };
  for (const to of [
    { x: 0, y: 1.6, z: -10 },   // 真正面(-Z)
    { x: 10, y: 1.6, z: 0 },    // 右(+X)
    { x: -7, y: 4.6, z: 7 },    // 左後ろの上
  ]) {
    const a = aimAt(from, to);
    const f = forwardOf(a.yaw, a.pitch);
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const len = Math.hypot(dx, dy, dz);
    const dot = (f.x * dx + f.y * dy + f.z * dz) / len;
    ok(dot > 0.9999, `(${to.x},${to.y},${to.z})を向いた向きが元へ戻る（内積${dot.toFixed(4)}）`);
  }
  // 前方が-Z。ここが+Zになっていると全員が背中を向けて撃ち合う
  const f0 = forwardOf(0, 0);
  ok(Math.abs(f0.z + 1) < 1e-6 && Math.abs(f0.x) < 1e-6, '向き0の前方は-Z（クライアントと同じ約束）');

  // 折り返し。-3.1から+3.1へは、長い方(ほぼ1周)ではなく短い方へ回る
  const t = turnToward(-3.1, 3.1, 0.2);
  ok(t < -3.1, `±πをまたぐ時は近い方へ回る（${t.toFixed(2)}）`);
  ok(turnToward(0, 1, 0.2) === 0.2, '1回で回せるのは上限まで');
}

console.log('\n[2] 席に座らせる・外す');
{
  clear();
  const me = join('わたし');
  room.takeSeat(me.slot, 0);
  room.setReady(me.slot, true);
  ok(room.phase === PHASE.WAIT, '1人では始まらない');

  room.toggleBot(1);
  const bots = [...room.slots.values()].filter((s) => s.bot);
  ok(bots.length === 1, `CPUが1体入った（${bots.length}体）`);
  ok(bots[0].seat === 1, `指定した席に座った（${bots[0].seat}番）`);
  ok(bots[0].ready === true, 'CPUは自分で準備完了になる（押す人がいないので）');
  ok(room.phase === PHASE.LIVE, 'CPUが座ったことで試合が始まった');

  // 同じ席をもう一度押すと外れる
  room._tick();
  const before = room.slots.size;
  room.toggleBot(1);
  ok(room.slots.size === before, '試合中は外れない（席が動かせるのはロビーだけ）');

  clear();
}

console.log('\n[3] 人が座っている席は触れない・人に席を譲る');
{
  clear();
  const me = join('わたし');
  room.takeSeat(me.slot, 0);
  room.toggleBot(0);   // 人が座っている席
  ok(room.slots.size === 1, '人が座っている席にはCPUを入れない');

  // 席を全部CPUで埋めてから、人が入ってくる
  clear();
  for (let s = 0; s < SEATS; s++) room.toggleBot(s);
  const seated = [...room.slots.values()].filter((x) => x.bot).length;
  ok(seated === SEATS, `席が全部CPUで埋まった（${seated}／${SEATS}体）`);
  ok(room.phase === PHASE.WAIT, 'CPUだけでは試合が始まらない（人を置いて始めない）');
  const late = join('あとから');
  const free = [...Array(SEATS).keys()].filter((s) => !room._seatTaken(s));
  ok(free.length === 1, `人が入ってきたらCPUが1体立って席が空く（空席${free.length}）`);
  room.takeSeat(late.slot, free[0]);
  ok(late.slot.seat === free[0], '空いた席に座れた');

  // 人がCPUの席を直に押しても譲る
  clear();
  room.toggleBot(2);
  const p = join('よこどり');
  room.takeSeat(p.slot, 2);
  ok(p.slot.seat === 2, 'CPUが座っていた席を人が押すと、CPUが立って人が座る');
  ok([...room.slots.values()].filter((x) => x.bot).length === 0, 'そのCPUは部屋から消えた');
  clear();
}

console.log('\n[4] 人が居なくなったらCPUも引き上げる');
{
  /* ここが抜けていると、誰も見ていない部屋で60Hzの撃ち合いが永久に続く。
     本番は常時起動なので、遊んでいない時間帯もずっと計算し続けることになる */
  clear();
  const me = join('わたし');
  room.takeSeat(me.slot, 0);
  room.toggleBot(1);
  room.toggleBot(2);
  ok(room.slots.size === 3, 'CPU2体と人1人');
  room.leave(me.slot);
  ok(room.slots.size === 0, `最後の人が抜けたらCPUも消える（残り${room.slots.size}）`);
  ok(room._timer === null || room._timer === undefined, '60Hzの刻みも止まっている');
  clear();
}

console.log('\n[5] 実際に動いて・撃って・当てる（本物の地形で30秒）');
{
  clear();
  const me = join('まと');
  room.takeSeat(me.slot, 0);
  // CPUを先に並べてから準備完了を押す。逆にすると、1体目が座った時点で
  // 2人揃って試合が始まり、2体目が入れない（席が動かせるのはロビーだけ）
  room.toggleBot(1);
  room.toggleBot(2);
  seedBots();
  room.setReady(me.slot, true);
  const bots = [...room.slots.values()].filter((s) => s.bot);
  ok(bots.length === 2, `CPUが2体入った（${bots.length}体）`);
  ok(room.phase === PHASE.LIVE, '試合が始まった');

  // 人は動かさない（入力を送らない＝その場に立っている的）。
  // CPUだけが動く状態で、CPUが人を見つけて撃てるかを見る
  const start = bots.map((b) => ({
    x: b.sim.player.collider.start.x, z: b.sim.player.collider.start.z,
  }));
  let fired = 0;
  let hitMe = 0;
  const myHp0 = me.slot.sim.player.health;
  // 撃った電文を数える。EV.FIREはpushで溜まるので、配る前に覗く
  const seen = new Set();
  for (let i = 0; i < 30 * 60; i++) {
    room._tick();
    for (const ev of room.events) {
      if (ev.e === 'f' && bots.some((b) => b.id === ev.id)) fired++;
      if (ev.e === 'h' && ev.id === me.slot.id) hitMe++;
      seen.add(ev.e);
    }
    room.events.length = 0;
  }
  const moved = bots.map((b, i) => Math.hypot(
    b.sim.player.collider.start.x - start[i].x,
    b.sim.player.collider.start.z - start[i].z,
  ));
  ok(moved.every((d) => d > 3), `CPUが動いた（${moved.map((d) => d.toFixed(1)).join('m / ')}m）`);
  ok(fired > 0, `CPUが撃った（${fired}発）`);
  ok(hitMe > 0, `その弾が人に当たった（${hitMe}発）`);
  ok(me.slot.sim.player.health < myHp0 || me.slot.sim.deaths > 0,
    '棒立ちの人は削られる（体力が減ったか倒された）');
  clear();
}

console.log('\n[6] 強すぎない（振り向きざまの即死をしない）');
{
  /* CPUは人と同じ入力しか使えないが、向きだけは計算で作れるので、
     制限が外れると「真後ろから撃たれた瞬間に振り向いて撃ち返す」機械になる。
     背後から見た時に、撃ち始めるまで一定の間があることを見る */
  const bot = new Bot({ rng: () => 0.5 });
  // 真後ろ(+Z側)に敵。自分は-Zを向いている
  const me = fakeSim(0, { x: 0, y: 0, z: 0 }, 0);
  const foe = fakeSim(1, { x: 0, y: 0, z: 12 }, 0);
  let firstFire = -1;
  for (let i = 0; i < 200; i++) {
    const f = bot.think(me, [foe], null, 1 / 60, true);
    me.player.yaw = f.yaw;
    me.player.pitch = f.pitch;
    if (f.fire && firstFire < 0) firstFire = i;
  }
  // 出会い頭に必ず負けないよう、人が反応するのと同じくらいの間を置く
  ok(firstFire > 30, `真後ろの相手を撃つまで${firstFire}刻み（0.5秒より長い）`);
  ok(firstFire > 0 && firstFire < 200, '最後には撃つ（永久に撃たないわけではない）');
}

console.log('\n[7] 反動の代わりの散りと、連射の区切り');
{
  /* **人には反動があるのにCPUには無かった。** 押しっぱなしで全弾が同じ点へ飛ぶので、
     人から見ると「こちらは散るのに相手は散らない」撃ち合いになる
     （「絶対CPUの方が強い、敵の攻撃はめっちゃ入る」2026-08-09）。
     撃つほど散りが広がること・撃ち続けずに間を置くことを見る */
  const bot = new Bot({ rng: () => 0.9 });   // 散りは常に同じ側へ最大に振れる
  const me = fakeSim(0, { x: 0, y: 0, z: 0 }, Math.PI);
  const foe = fakeSim(1, { x: 0, y: 0, z: 12 }, 0);
  const devs = [];
  let gaps = 0, run = 0;
  for (let i = 0; i < 60 * 6; i++) {
    const f = bot.think(me, [foe], null, 1 / 60, true);
    me.player.yaw = f.yaw;
    me.player.pitch = f.pitch;
    if (f.fire) {
      devs.push(Math.abs(f.fireYaw - f.yaw));
      if (run > 20) gaps++;
      run = 0;
    } else run++;
  }
  ok(devs.length > 5, `何発か撃った（${devs.length}発）`);
  ok(devs.some((d) => d > 0), '弾の向きが見ている向きとずれる（散りがある）');
  // 撃ち始めより撃ち続けた後の方が散る
  const first = devs[0];
  const later = Math.max(...devs.slice(1, 6));
  ok(later > first, `撃つほど散りが広がる（1発目${first.toFixed(3)} → ${later.toFixed(3)}rad）`);
  ok(gaps > 0, `連射に区切りがある（${gaps}回の間）`);
}

console.log('\n[8] 弾倉を自分で数える（サーバーは弾数を持っていない）');
{
  /* **サーバーが持っているのは連射の速さだけで、弾数は持っていない。**
     CPUがここで数えないと、CPUだけ無限に撃ち続ける人になる */
  const bot = new Bot({ rng: () => 0.5 });
  const me = fakeSim(0, { x: 0, y: 0, z: 0 }, Math.PI);   // +Zを向く
  const foe = fakeSim(1, { x: 0, y: 0, z: 12 }, 0);
  let shots = 0;
  let gap = 0;      // 撃たなかった一番長い連続刻み数
  let run = 0;
  for (let i = 0; i < 60 * 12; i++) {
    const f = bot.think(me, [foe], null, 1 / 60, true);
    me.player.yaw = f.yaw;
    me.player.pitch = f.pitch;
    if (f.fire) { shots++; run = 0; } else { run++; gap = Math.max(gap, run); }
  }
  ok(shots > 0, `撃っている（${shots}発）`);
  const mag = me.def.mag | 0;
  ok(shots < 60 * 12, '毎刻み撃ってはいない');
  // 装填の間は最低でも1.5秒(90刻み)は撃たない
  ok(gap > 90, `装填で撃てない間がある（一番長い間が${gap}刻み）。弾倉は${mag}発`);
}

console.log('\n[9] 器の繋ぎ込み（電文・画面）');
{
  const proto = readFileSync(new URL('../src/net/protocol.js', import.meta.url), 'utf8');
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const cli = readFileSync(new URL('../src/net/client.js', import.meta.url), 'utf8');
  const lob = readFileSync(new URL('../src/ui/lobby.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  // 送る側・受ける側・表の3つが揃っているか（protocol.jsの冒頭が戒めている所）
  ok(/BOT: 'b'/.test(proto), '表に電文がある');
  ok(/case C\.BOT: return onBot/.test(idx), 'サーバーが受け口を持っている');
  ok(/t: C\.BOT, st:/.test(cli), 'クライアントが送る口を持っている');
  ok(/toggleBot\(/.test(idx), '受け口がroomのtoggleBotを呼ぶ');
  ok(/onBot\(seat\)/.test(lob), 'ロビーの席にCPUのボタンがある');
  ok(/lobby\.onBot = \(seat\) => this\.net\?\.sendBot\(seat\)/.test(main),
    '統合側でロビーと通信が繋がっている');
  ok(/\.lbbot \{/.test(html), 'CPUボタンの見た目がある');
  // 席の並びにBOTを足したので、読む側と長さが揃っているか
  ok(/LOBBY_ROW = \{ ID: 0, NAME: 1, SEAT: 2, READY: 3, CHR: 4, BOT: 5 \}/.test(proto)
    && /LOBBY_ROW_LEN = 6/.test(proto), '席の行にCPUの印が増えて、長さも揃っている');
  ok(/LOBBY_ROW\.BOT/.test(lob), '画面側がLOBBY_ROW.BOTで読んでいる（番号を直に書かない）');
}

/* 検査用の、SimPlayerのふりをする最小限。
   本物のSimPlayerは地形と履歴を持つので、[6][7]のような「向きと撃つ判断だけ」を
   見たい所では重すぎるし、地形に阻まれて狙いが通らず判定が揺れる */
function fakeSim(id, pos, yaw) {
  return {
    id,
    alive: true,
    def: { mag: 25, reloadTime: 2.15, range: 120 },
    player: {
      yaw,
      pitch: 0,
      collider: { start: { x: pos.x, y: pos.y + 0.34, z: pos.z } },
      velocity: { x: 0, y: 0, z: 0 },
    },
    eye(out) {
      out.set(pos.x, pos.y + 1.58, pos.z);
      return out;
    },
  };
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
