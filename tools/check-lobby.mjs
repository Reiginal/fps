// ロビーとデスマッチの検査。本物のRoomを動かして、席の取り合いと決着を確かめる。
//
// なぜ要るか: ここは「誰が座れて、いつ始まって、誰が勝つか」を決めている層で、
// 全部サーバー側にあるのでブラウザ無しで動かせる。画面に出す前にここで潰す。
//
// 特に確かめたいのは「落ちること」のほう。
// 埋まっている席に座れてしまう・1人でも試合が始まってしまう・
// 誰かが倒れただけでラウンドが終わってしまう、が起きると
// 遊んでいる側からは何が起きたのか読めない不具合になる。
//
//   node tools/check-lobby.mjs
import '../server/dom-stub.js';
import { PHASE, SEATS, MATCH } from '../src/net/protocol.js';

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
const clear = () => { for (const s of [...room.slots.values()]) room.leave(s); };
clear();

const join = (name) => {
  const conn = mkConn();
  const slot = room.join(conn, name);
  conn.slot = slot;
  return { conn, slot };
};

/* 倒す。sim.aliveは読み取り専用で、中のPlayerが実体を持っている。
   体力を0にして倒すのが本物の道筋なので、そこを通す */
const down = (p) => { p.slot.sim.player.alive = false; p.slot.sim.player.health = 0; };

/** 全員を席に着かせて準備完了まで持っていく。始まった状態で返す */
const startWith = (names) => {
  clear();
  const ps = names.map((n) => join(n));
  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  ps.forEach((p) => room.setReady(p.slot, true));
  return ps;
};

console.log('\n[1] 入っただけでは試合が始まらない');
const a = join('あき');
const b = join('ばん');
ok(room.phase === PHASE.WAIT, '2人繋いでも待ちのまま');
ok(a.slot.seat === null, '入った人はまだ席にいない');

console.log('\n[2] 1人だけでは始まらない');
room.takeSeat(a.slot, 0);
room.setReady(a.slot, true);
ok(a.slot.seat === 0, '1番の席に座れた');
ok(room.phase === PHASE.WAIT, '1人では始まらない');
ok(/あと1人/.test(room._whyNotStart()), `理由が出る（${room._whyNotStart()}）`);

console.log('\n[3] 埋まっている席には座れない');
room.takeSeat(b.slot, 0);
ok(b.slot.seat === null, '先客のいる席は取れない');
ok(a.slot.seat === 0, '先客は動かされない');

console.log('\n[4] 席が埋まっただけでは始まらない');
room.takeSeat(b.slot, 1);
ok(b.slot.seat === 1, '2番の席には座れる');
ok(room.phase === PHASE.WAIT, '準備完了を押していないので始まらない');
ok(/準備待ち/.test(room._whyNotStart()), `理由が出る（${room._whyNotStart()}）`);

console.log('\n[5] 全員が準備完了で始まる（1対1）');
room.setReady(b.slot, true);
ok(room.phase !== PHASE.WAIT, '試合が始まった');
ok(room._whyNotStart() === '', '始まらない理由はもう無い');

console.log('\n[6] 範囲の外を指定しても座らない');
clear();
const c = join('しい');
room.takeSeat(c.slot, SEATS);
ok(c.slot.seat === null, `席番号が${SEATS}は範囲外なので座らない`);
room.takeSeat(c.slot, 99);
ok(c.slot.seat === null, '大きすぎる番号でも座らない');

console.log('\n[7] 降りられる');
room.takeSeat(c.slot, 2);
ok(c.slot.seat === 2, 'いったん座る');
room.takeSeat(c.slot, -1);
ok(c.slot.seat === null && c.slot.ready === false, '降りると立った状態へ戻り、準備も倒れる');

console.log('\n[8] 3人でも4人でも始まる');
for (const n of [3, 4]) {
  const names = ['あき', 'ばん', 'しい', 'でー'].slice(0, n);
  const ps = startWith(names);
  ok(room.phase !== PHASE.WAIT, `${n}人で始まった`);
  ok(ps.length === n, `${n}人が席に着いている`);
}

console.log('\n[9] 誰か1人が倒れただけではラウンドが終わらない（3人以上）');
// 1対1の頃は「片方が倒れたら終わり」だった。3人いる時にそれをやると、
// 最初に倒れた瞬間に残り2人の勝負が消える
{
  const ps = startWith(['あき', 'ばん', 'しい']);
  const round0 = room.round;
  down(ps[0]);
  room._checkRoundOver('kill');
  ok(room.phase === PHASE.LIVE, '1人倒れてもラウンドは続く');
  ok(room.round === round0, 'ラウンドが進んでいない');

  down(ps[1]);
  room._checkRoundOver('kill');
  ok(room.phase !== PHASE.LIVE, '2人目が倒れて最後の1人になったら終わる');
  ok(ps[2].slot.rounds === 1, '最後まで残った人が取る');
  ok(ps[0].slot.rounds === 0 && ps[1].slot.rounds === 0, '倒れた人は取らない');
}

console.log('\n[10] 全員同時に倒れたら誰の取得にもならない');
// 手榴弾の相討ち。「最後に死んだ人」を勝ちにすると、爆風の計算順という
// 遊ぶ側からまったく見えない事情で勝敗が決まる
{
  const ps = startWith(['あき', 'ばん']);
  for (const p of ps) down(p);
  room._checkRoundOver('kill');
  ok(room.phase !== PHASE.LIVE, 'ラウンドは終わる');
  ok(ps.every((p) => p.slot.rounds === 0), '誰も取っていない');
}

console.log('\n[11] 先に3ラウンド取ったら試合が終わる');
{
  const ps = startWith(['あき', 'ばん']);
  for (let i = 0; i < MATCH.ROUND_WINS; i++) {
    down(ps[1]);
    room._checkRoundOver('kill');
    // 次のラウンドへ進める（幕間を飛ばす）
    if (room.phase === PHASE.BREAK) room._startRound();
  }
  ok(ps[0].slot.rounds === MATCH.ROUND_WINS, `${MATCH.ROUND_WINS}本取った`);
  ok(room.phase === PHASE.END, '試合が終わった');
}

console.log('\n[12] 試合中に抜けられて1人になったら待ちへ戻る');
{
  const ps = startWith(['あき', 'ばん']);
  ok(room.phase !== PHASE.WAIT, '始まっている');
  room.leave(ps[1].slot);
  ok(room.phase === PHASE.WAIT, '相手が抜けたら試合を止める');
  ok(ps[0].slot.rounds === 0, '取ったラウンドも戻す');
  ok(ps[0].slot.ready === false, '残った人の準備完了も倒す');
}

console.log('\n[13] 3人のうち1人が抜けても、残り2人なら続く');
{
  const ps = startWith(['あき', 'ばん', 'しい']);
  room.leave(ps[2].slot);
  ok(room.phase !== PHASE.WAIT, '2人残っているので試合は続く');
}

console.log('\n[14] 入った本人へ、お迎えより後にロビーが届く');
// 順番が逆だと、入ってきた本人の画面は受け口をまだ繋いでいないので
// ロビーを取りこぼし、先にいた人が誰も映らない
{
  clear();
  const d2 = join('でぃー');
  ok(!d2.conn.sent.some((m) => m.t === 'L'), 'join()の時点ではまだロビーを配っていない');
  d2.conn.send(room.welcome(d2.slot));
  room.sendLobby();
  const order = d2.conn.sent.map((m) => m.t).join('');
  ok(order.indexOf('W') < order.indexOf('L'), `お迎えが先、ロビーが後 (${order})`);
  const lob = d2.conn.sent.filter((m) => m.t === 'L').pop();
  ok(lob.rows.length === room.slots.size, `全員が一覧に入っている (${lob.rows.length}人)`);
}

console.log('\n[15] 同じ見た目が2人並ばない');
// 遊んで「2人以上でやる時は同じスキンを選べないようにして」と言われた所。
// 同じ姿が2人いると、撃ち合いの最中に区別が付かないし、
// 撃破の知らせを見ても誰を倒したのか読めない
{
  clear();
  const ps = ['あ', 'い', 'う', 'え'].map((n) => join(n));
  // **既定でも散っていること。** 全員0番から始める形だったので、
  // 誰も選び直さなければ4人とも同じ姿だった
  const defaults = ps.map((p) => p.slot.chr);
  ok(new Set(defaults).size === 4, `入った時点で全員別の見た目 (${defaults.join(', ')})`);

  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  ok(new Set(ps.map((p) => p.slot.chr)).size === 4, '席に着いても重ならない');

  // 他人が使っている番号は選べない
  const taken = ps[1].slot.chr;
  const before = ps[0].slot.chr;
  room.setChar(ps[0].slot, taken);
  ok(ps[0].slot.chr === before, `使われている ${taken} 番は取れない（${before} 番のまま）`);
  // 断った時もロビーを配り直す。押した側の画面が元へ戻らないと、
  // 「押したのに変わらない」が壊れているように見える
  const lob = ps[0].conn.sent.filter((m) => m.t === 'L').pop();
  ok(!!lob, '断った時もロビーを配り直している');

  // 空いている番号なら取れる
  const { CHARACTERS } = await import('../src/net/protocol.js');
  const used = new Set(ps.map((p) => p.slot.chr));
  const free = [...Array(CHARACTERS.length).keys()].find((i) => !used.has(i));
  room.setChar(ps[0].slot, free);
  ok(ps[0].slot.chr === free, `空いている ${free} 番は取れる`);

  // 立っている人同士は重なりうるが、座った時点で寄せる（最後の砦）
  clear();
  const x = join('えっくす');
  const y = join('わい');
  room.takeSeat(x.slot, 0);
  y.slot.chr = x.slot.chr;          // 立ったまま同じ番号を持っている状態を作る
  room.takeSeat(y.slot, 1);
  ok(y.slot.chr !== x.slot.chr, `座った時に空いている番号へ寄せた (${x.slot.chr} と ${y.slot.chr})`);

  // 席は4つで見た目は6種類。座る人が全員別の姿になれることを数で確かめる
  ok(CHARACTERS.length >= SEATS, `見た目 ${CHARACTERS.length} 種 ≧ 席 ${SEATS} つ（必ず行き渡る）`);
}

clear();

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
