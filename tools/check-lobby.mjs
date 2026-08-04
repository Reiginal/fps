// ロビーの検査。本物のRoomを動かして、席の取り合いと開始条件を確かめる。
//
// なぜ要るか: ロビーは画面を見ないと分からない層に見えるが、
// 「誰が座れて、いつ始まるか」を決めているのは全部サーバー側で、
// そこはブラウザ無しで動かせる。画面に出す前にここで潰しておく。
//
// 特に確かめたいのは「落ちること」のほう。
// 埋まっている席に座れてしまう・1人でも試合が始まってしまう、が起きると
// 遊んでいる側からは何が起きたのか読めない不具合になる。
//
//   node tools/check-lobby.mjs
import '../server/dom-stub.js';
import { PHASE, SEATS_PER_TEAM } from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 送られた電文を溜めるだけの、接続の代わり。
// 本物のWebSocketを立てずにRoomを動かせるのは、Roomがconn.send()しか使わないため
const mkConn = () => ({ sent: [], rtt: 0, send(m) { this.sent.push(m); } });

const room = getRoom(world);
// 部屋は1つしか無く、他の検査と同じプロセスで動くこともある。
// 前の検査が残した人がいると数が合わないので、必ず空から始める
for (const s of [...room.slots.values()]) room.leave(s);

const join = (name) => {
  const conn = mkConn();
  const slot = room.join(conn, name);
  conn.slot = slot;
  return { conn, slot };
};

console.log('\n[1] 入っただけでは試合が始まらない');
const a = join('あき');
const b = join('ばん');
ok(room.phase === PHASE.WAIT, '2人繋いでも待ちのまま');
ok(a.slot.team === null && a.slot.seat === null, '入った人はまだ席にいない');

console.log('\n[2] 片方だけ座っても始まらない');
room.takeSeat(a.slot, 0, 0);
ok(a.slot.team === 0 && a.slot.seat === 0, 'Aの1番に座れた');
ok(room.phase === PHASE.WAIT, '相手がいないので始まらない');
ok(/B/.test(room._whyNotStart()), `理由が出る（${room._whyNotStart()}）`);

console.log('\n[3] 埋まっている席には座れない');
room.takeSeat(b.slot, 0, 0);
ok(b.slot.team === null, '先客のいる席は取れない');
ok(a.slot.team === 0 && a.slot.seat === 0, '先客は動かされない');

console.log('\n[4] 同じチームに2人だと始まらない');
room.takeSeat(b.slot, 0, 1);
ok(b.slot.seat === 1, 'Aの2番には座れる');
ok(room.phase === PHASE.WAIT, '1対1しか動かないので始まらない');

console.log('\n[5] AとBに1人ずつで始まる');
room.takeSeat(b.slot, 1, 0);
ok(b.slot.team === 1 && b.slot.seat === 0, 'Bへ移れた');
ok(room.phase !== PHASE.WAIT, '試合が始まった');
ok(room._whyNotStart() === '', '始まらない理由はもう無い');

console.log('\n[6] 湧く位置がチームで分かれる');
const pa = room._spawnFor(a.slot);
const pb = room._spawnFor(b.slot);
ok(pa.x < 0, `Aは西側 (x=${pa.x})`);
ok(pb.x > 0, `Bは東側 (x=${pb.x})`);

console.log('\n[7] 試合が始まったら席を動かせない');
room.takeSeat(a.slot, 1, 1);
ok(a.slot.team === 0 && a.slot.seat === 0, '始まった後の移動は無視される');

console.log('\n[8] 範囲の外を指定しても座らない');
room.leave(b.slot);
ok(room.phase === PHASE.WAIT, '片方が抜けたら待ちへ戻る');
const c = join('しい');
room.takeSeat(c.slot, 1, SEATS_PER_TEAM);
ok(c.slot.team === null, `席番号が${SEATS_PER_TEAM}は範囲外なので座らない`);
room.takeSeat(c.slot, 5, 0);
ok(c.slot.team === null, 'チーム5は無いので座らない');
room.takeSeat(c.slot, 1, -1);
ok(c.slot.team === null, '席番号が負でも座らない');

// ここでBに座らせると1対1が成立して試合が始まってしまい、
// 「試合中は席を動かせない」の方が効いて降りられない。
// 降りる所を見たいので、始まらない側（aと同じA）に座らせる
console.log('\n[9] 降りられる');
room.takeSeat(c.slot, 0, 1);
ok(c.slot.team === 0 && c.slot.seat === 1, 'いったん座る');
ok(room.phase === PHASE.WAIT, '同じチームなので始まらない');
room.takeSeat(c.slot, -1, 0);
ok(c.slot.team === null && c.slot.seat === null, '降りると立った状態へ戻る');

console.log('\n[10] 試合中に抜けられたら待ちへ戻る');
room.takeSeat(c.slot, 1, 0);
ok(room.phase !== PHASE.WAIT, 'また揃って始まった');
room.leave(c.slot);
ok(room.phase === PHASE.WAIT, '相手が抜けたら試合を止める');
ok(a.slot.rounds === 0, '取ったラウンドも戻す');

console.log('\n[11] ロビーの中身が配られている');
const last = a.conn.sent.filter((m) => m.t === 'L').pop();
ok(!!last, 'LOBBYが届いている');
ok(Array.isArray(last.rows), '席の一覧が入っている');
ok(last.rows.some((r) => r[0] === a.slot.id), '自分が一覧に入っている');

// 後片付け。同じ部屋を他の検査が使う
for (const s of [...room.slots.values()]) room.leave(s);

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
