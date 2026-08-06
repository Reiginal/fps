// 地面に落ちている物の検査。本物のRoomを動かす。
//
// なぜ要るか: **落ちている物は「在るのに見えない」形で壊れる。**
// サーバーだけが持っていて手元に届かない、届いたのに消えない、
// 消えたのに手元に残る。どれも例外にならないので、遊んでいて
// 「光る箱が街に浮きっぱなし」「近づいたのに何も起きない」で初めて分かる。
//
// 特に見張りたいのが4つ。
//
//   1. **ガンゲームで落ちる。** 拾えると「今の段の1本だけを持つ」という
//      あの遊び方の芯がそのまま消える
//   2. **拾っても何も起きない物が散らばる。** 近づいて何も起きない経験を
//      1回させると、次からは誰も拾いに行かなくなる
//   3. **溜まり続ける。** 撃ち合いが続くと置きっぱなしが増え、描く物が増え続ける
//   4. **ラウンドをまたいで持ち越す。** 1回拾えば以後ずっと持てることになる
//
//   node tools/check-drops.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { PHASE, DROP, NADE, EV } from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');
const { WEAPONS } = await import('../src/player/weapons.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const mkConn = () => ({ sent: [], rtt: 0, send(m) { this.sent.push(m); } });
const room = getRoom(world);
const clear = () => { for (const s of [...room.slots.values()]) room.leave(s); room.drops.clear(); };

const join = (name) => {
  const conn = mkConn();
  const slot = room.join(conn, name);
  conn.slot = slot;
  return { conn, slot };
};

const startWith = (names, mode) => {
  clear();
  room.phase = PHASE.WAIT;
  room.setMode(mode);
  const ps = names.map((n) => join(n));
  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  ps.forEach((p) => room.setReady(p.slot, true));
  room.events.length = 0;
  return ps;
};

const idOf = (i) => WEAPONS[i]?.id;
/* 倒す。**_killを呼ぶだけでは倒れていない。**
   体力を0にして倒すのが本物の道筋（本来はshot()の中でそうなる）で、
   ここを飛ばすと倒れた本人が生きたまま自分の落とした物を拾ってしまう */
const down = (p) => { p.slot.sim.player.alive = false; p.slot.sim.player.health = 0; };
/* 倒す一式。**局面をLIVEへ戻してから呼ぶ。**
   デスマッチは1人倒れた時点でラウンドが決まってBREAKへ移り、
   _killはそこで早々に戻るので、2回目以降は何も起きない。
   ここで見たいのは落ちる物のほうなので、ラウンドの進行は毎回まっさらに戻す
   （進行そのものは tools/check-modes.mjs が見ている） */
const kill = (victim, killer) => {
  room.phase = PHASE.LIVE;
  down(victim);
  room._kill(victim.slot, killer.slot, 1);
};
const indexOf = (id) => WEAPONS.findIndex((w) => w.id === id);
/** その人を落ちている物の上へ立たせる */
const standOn = (slot, d) => {
  const p = slot.sim.player.collider.start;
  p.set(d.x, d.y + slot.sim.player.height * 0.5, d.z);
  slot.sim.player.collider.end.set(p.x, p.y + 0.6, p.z);
};

console.log('\n[1] 決まりの数字');
{
  ok(DROP.LIFE_S > 5 && DROP.LIFE_S < 120, `地面に残るのは ${DROP.LIFE_S}秒`);
  ok(DROP.RADIUS > 0.8, `拾える距離は ${DROP.RADIUS}m（狭すぎると撃ち合いの最中に拾えない）`);
  ok(DROP.MAX > 0 && DROP.MAX <= 64, `同時に置ける数は ${DROP.MAX}`);
}

console.log('\n[2] デスマッチでは倒した相手の物が落ちる');
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  ok(room.rules.drops === true, 'デスマッチは落とす遊び方');
  ok(room.drops.size === 0, '最初は何も落ちていない');

  kill(b, a);
  ok(room.drops.size === 1, `倒すと1つ落ちる（${room.drops.size}個）`);

  const d = [...room.drops.values()][0];
  ok(d.w === b.slot.sim.weapon, `倒れた人が持っていた武器（${idOf(d.w)}）`);
  ok(d.n === NADE.PER_ROUND, `残っていた手榴弾も一緒（${d.n}個）`);

  // 落ちた事は全員に届く。**届かないと、在るのに見えない物になる**
  const ev = room.events.map((e) => e.e ?? e).filter((e) => e === EV.DROP);
  ok(ev.length === 1, '落ちた知らせが配られている');
  const msg = room.events.find((e) => e.e === EV.DROP);
  ok(Array.isArray(msg?.p) && msg.p.length === 3, `場所が載っている（${msg?.p?.map((n) => n.toFixed(1)).join(', ')}）`);
  ok(msg.did > 0, '番号が付いている（後で消すのに要る）');
}

console.log('\n[3] ガンゲームでは落ちない');
// **拾えると「今の段の1本だけを持つ」という芯がそのまま消える。**
// 段を飛ばして先の武器を持てるなら、倒して進む理由が無くなる
{
  const [a, b] = startWith(['あき', 'ばん'], 'gun');
  ok(room.rules.drops === false, 'ガンゲームは落とさない遊び方');
  kill(b, a);
  ok(room.drops.size === 0, `倒しても何も落ちない（${room.drops.size}個）`);
  room.setMode('dm');
}

console.log('\n[4] 拾っても何も起きない物は置かない');
// 近づいて何も起きない経験を1回させると、次からは誰も拾いに行かなくなる
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  // ナイフしか持っておらず、手榴弾も使い切っている人
  b.slot.sim.weapon = indexOf('knife');
  b.slot.nades = 0;
  kill(b, a);
  ok(room.drops.size === 0, 'ナイフだけで手榴弾も無い人は何も落とさない');

  // 手榴弾が残っていれば、ナイフでも落とす（拾う価値がある）
  room.drops.clear();
  b.slot.nades = 1;
  kill(b, a);
  ok(room.drops.size === 1, '手榴弾が残っていれば落とす');
  const d = [...room.drops.values()][0];
  ok(d.w === -1, '武器は入っていない印になる（ナイフは拾えない）');
  ok(d.n === 1, `手榴弾の数だけ入っている（${d.n}個）`);
}

console.log('\n[5] 近づくと拾える');
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  a.slot.nades = 0;
  b.slot.nades = 2;
  kill(b, a);
  const [did, d] = [...room.drops][0];

  // まだ遠い
  room._stepDrops();
  ok(room.drops.has(did), '離れている間は拾えない');
  ok(a.slot.nades === 0, '手榴弾も増えていない');

  standOn(a.slot, d);
  room._stepDrops();
  ok(!room.drops.has(did), '上に立つと拾える');
  ok(a.slot.nades === 2, `手榴弾が戻った（${a.slot.nades}個）`);

  const take = room.events.find((e) => e.e === EV.TAKE && e.did === did);
  ok(!!take, '拾った知らせが配られている');
  ok(take.by === a.slot.id, '誰が拾ったかが載っている（本人の画面が弾を戻すのに要る）');
}

console.log('\n[6] 手榴弾は持てる上限を超えない');
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  a.slot.nades = NADE.PER_ROUND;
  b.slot.nades = NADE.PER_ROUND;
  kill(b, a);
  const d = [...room.drops.values()][0];
  standOn(a.slot, d);
  room._stepDrops();
  ok(a.slot.nades === NADE.PER_ROUND,
    `満タンの人が拾っても増えない（${a.slot.nades} / ${NADE.PER_ROUND}）`);
}

console.log('\n[7] 倒れている人は拾えない');
// 倒れたその場に落ちるので、拾えると自分の落とした物を自分で拾える
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  b.slot.nades = 2;
  kill(b, a);
  const [did, d] = [...room.drops][0];
  standOn(b.slot, d);
  const before = b.slot.nades;
  room._stepDrops();
  ok(room.drops.has(did), '倒れている人の上にあっても拾われない');
  ok(b.slot.nades === before, '手榴弾も増えない');
}

console.log('\n[8] 時間切れで消える');
// 残り続けると、戦場が拾い物だらけになる
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  kill(b, a);
  const [did, d] = [...room.drops][0];
  d.at -= (DROP.LIFE_S + 1) * 1000;
  room._stepDrops();
  ok(!room.drops.has(did), `${DROP.LIFE_S}秒で消える`);
  const take = room.events.find((e) => e.e === EV.TAKE && e.did === did);
  ok(!!take, '消えた知らせも配る（配らないと手元に残り続ける）');
  ok(take.by === undefined, '時間切れの時は拾った人が入っていない');
}

console.log('\n[9] 溜まり続けない');
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  for (let i = 0; i < DROP.MAX + 6; i++) {
    b.slot.nades = 1;
    kill(b, a);
  }
  ok(room.drops.size <= DROP.MAX, `上限で止まる（${room.drops.size} / ${DROP.MAX}）`);
  ok(room.drops.size > 0, '全部消えたりはしない');
}

console.log('\n[10] 拾って増えた武器はラウンドをまたがない');
// 持ち越すと、1回拾えば以後ずっと持てることになる
{
  const [a] = startWith(['あき', 'ばん'], 'dm');
  const shotgun = indexOf('shotgun');
  ok(shotgun >= 0, 'ショットガンは表にある（持って出ないだけ）');
  ok(!a.slot.sim.carry.includes(shotgun), '普段は持っていない');

  room._pickUp(a.slot, { w: shotgun, n: 0 });
  ok(a.slot.sim.carry.includes(shotgun), '拾うと持てるようになる');
  ok(a.slot.extra.includes(shotgun), '拾った物として別に覚えている');
  const armed = room.events.filter((e) => e.e === EV.ARM && e.id === a.slot.id).pop();
  ok(!!armed && armed.c.includes(shotgun), '新しい持ち物が本人へ配られている');

  room._respawn(a.slot);
  ok(a.slot.extra.length === 0, '湧き直すと拾った物は消える');
  ok(!a.slot.sim.carry.includes(shotgun), '持ち物も元通り');
}

console.log('\n[11] 途中から入った人にも見える');
// 落ちた知らせは置いた時の1回しか流れないので、
// お迎えの電文に載せないと「近づいたら何か起きた」になる
{
  const [a, b] = startWith(['あき', 'ばん'], 'dm');
  kill(b, a);
  const late = join('あとから');
  const w = room.welcome(late.slot);
  ok(Array.isArray(w.drops), 'お迎えに落ちている物が載っている');
  ok(w.drops.length === room.drops.size, `今ある数と同じ（${w.drops.length}個）`);
  ok(w.drops[0].length === 6, '番号・武器・手榴弾・場所が入っている');
}

console.log('\n[12] 手元の受け取り方');
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/case EV\.DROP/.test(main), '落ちた知らせを受けている');
  ok(/case EV\.TAKE/.test(main), '消えた知らせも受けている');
  // 受けても消さないと、拾われた物が街に浮いたまま残る
  ok(/case EV\.TAKE[\s\S]{0,700}?_removeDrop/.test(main), '消えた時に絵も消す');
  ok(/hello\?\.drops/.test(main), 'お迎えで届いた分も置く');
  ok(/_leaveMatch[\s\S]{0,600}?_clearDrops/.test(main),
    '試合から抜ける時に片付ける（残すと1人用の街に浮いたままになる）');

  const weapons = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  ok(/refillReserve\(\)\s*\{/.test(weapons), '弾を戻す口がある');
  // マガジンまで戻すと、撃ち切る直前に拾えば装填を飛ばせる。
  // 関数の中だけを見る（後ろに続くresetAllはマガジンも戻すのが正しいので、
  // ファイル全体を見ると必ず引っかかる）
  const body = weapons.split('refillReserve() {')[1]?.split('\n  }')[0] || '';
  ok(body.length > 0, '弾を戻す口の中身が読めた');
  ok(!/\bammo\s*=/.test(body), 'マガジンの中身は戻さない（装填を飛ばせてしまう）');
}

clear();
room.phase = PHASE.WAIT;
room.setMode('dm');

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
