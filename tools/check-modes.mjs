// 遊び方（デスマッチ／ガンゲーム）の検査。本物のRoomを動かす。
//
// なぜ要るか: **ガンゲームはデスマッチと進行の根本が違う。**
// ラウンドが無く、倒れても数秒で生き返り、勝ちは取ったラウンド数ではなく
// 「全部の武器で1回ずつ倒したか」で決まる。
//
// 一番怖いのは**デスマッチを壊すこと**。今まで動いていた対戦の進行に
// 分岐を入れているので、ガンゲームを足したせいでラウンドが終わらなくなる、
// といった形で壊れうる。なので両方を同じ検査で回す。
//
// 2番目に怖いのは**倒れたまま局面が動かないこと**。デスマッチは倒れた瞬間に
// 局面がBREAKへ移るので「もう数えた」を持たなくて済んでいたが、
// ガンゲームは局面が動かないので、目印が無いと毎刻み「落下で死んだ」が
// 積み上がる（毎秒60回）。
//
//   node tools/check-modes.mjs
import '../server/dom-stub.js';
import { readFileSync } from 'node:fs';
import { PHASE, MODE_IDS, GUN_ORDER, MATCH, TICK_DT, Sv } from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');
const { WEAPONS } = await import('../src/player/weapons.js');
const { modeOf } = await import('../server/modes.js');
const { logs } = await import('../server/logs.js');

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

/** 全員を席に着かせて始める */
const startWith = (names, mode) => {
  clear();
  room.phase = PHASE.WAIT;
  room.setMode(mode);
  const ps = names.map((n) => join(n));
  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  ps.forEach((p) => room.setReady(p.slot, true));
  return ps;
};

const idOf = (i) => WEAPONS[i]?.id;
const down = (p) => { p.slot.sim.player.alive = false; p.slot.sim.player.health = 0; };

console.log('\n[1] 遊び方を選べる');
{
  clear();
  room.phase = PHASE.WAIT;
  ok(MODE_IDS.length >= 2, `遊び方は ${MODE_IDS.length} 種類（${MODE_IDS.join('、')}）`);
  room.setMode('dm');
  ok(room.mode === 'dm', '既定はデスマッチ');
  ok(room.setMode('gun') === true, 'ガンゲームへ変えられる');
  ok(room.mode === 'gun', '変わっている');
  ok(room.setMode('gun') === false, '同じ物をもう一度押しても何も起きない');
  ok(room.setMode('しらない遊び方') === false, '知らない名前は断る');
  ok(room.mode === 'gun', '断った後も元のまま');
  room.setMode('dm');
}

console.log('\n[2] 試合が始まったら遊び方は変えられない');
// 途中で決まりが変わると、遊んでいる側からは何が起きたのか読めない
{
  startWith(['あき', 'ばん'], 'dm');
  ok(room.phase !== PHASE.WAIT, '試合が始まっている');
  ok(room.setMode('gun') === false, '試合中は変えられない');
  ok(room.mode === 'dm', 'デスマッチのまま');
}

console.log('\n[3] デスマッチは今まで通り（ラウンド制）');
// ガンゲームを足したせいでこちらが壊れていないか。**ここが一番大事**
{
  const ps = startWith(['あき', 'ばん', 'しい'], 'dm');
  ok(room.rules.rounds === true, 'ラウンド制である');
  const round0 = room.round;

  down(ps[0]);
  room._checkRoundOver('kill');
  ok(room.phase === PHASE.LIVE, '1人倒れてもラウンドは続く');
  ok(room.round === round0, 'ラウンドが進んでいない');

  down(ps[1]);
  room._checkRoundOver('kill');
  ok(room.phase !== PHASE.LIVE, '最後の1人になったら終わる');
  ok(ps[2].slot.rounds === 1, '残った人がラウンドを取る');

  // 持ち物は既定のまま（1本だけにされていない）
  ok(ps[2].slot.sim.carry.length >= 3,
    `持ち物は既定のまま ${ps[2].slot.sim.carry.length}本`);
}

console.log('\n[4] ガンゲームは倒すたびに武器が替わる');
{
  const ps = startWith(['あき', 'ばん'], 'gun');
  ok(room.mode === 'gun', 'ガンゲームで始まった');
  ok(room.rules.rounds === false, 'ラウンドを持たない');
  /* **手榴弾を数えない。** 2026-08-13に
     「ガンゲームの時は、手榴弾の弾の制限があったらちょっとおかしいよね」で足した。
     手榴弾の段は投げる物が無くなるとそこで詰む（拾えない遊び方なので補充が無い）*/
  ok(room.rules.nadeLimit === false, '手榴弾を数えない');

  const [a, b] = ps;
  ok(a.slot.stage === 0, '最初は0段目');
  /* **銃1本＋ナイフ。** 2026-08-13にナイフを常に持たせるようにした
     （「弾切れした時に殺しようがないし」）。
     この遊び方は落ちた武器を拾えないので、撃ち切ると次に倒されるまで何もできなかった */
  ok(a.slot.sim.carry.length === 2 && a.slot.sim.carry.map(idOf).includes('knife'),
    `持ち物は今の段の1本とナイフ (${a.slot.sim.carry.map(idOf).join('、')})`);
  ok(idOf(a.slot.sim.weapon) === GUN_ORDER[0],
    `最初の武器は ${GUN_ORDER[0]}（今 ${idOf(a.slot.sim.weapon)}）`);

  // 順番に倒していく
  for (let st = 0; st < GUN_ORDER.length - 1; st++) {
    room._kill(b.slot, a.slot, 1);
    ok(a.slot.stage === st + 1, `${st + 1}段目へ進んだ`);
    ok(idOf(a.slot.sim.weapon) === GUN_ORDER[st + 1],
      `武器が ${GUN_ORDER[st + 1]} になった（今 ${idOf(a.slot.sim.weapon)}）`);
    /* 最後の段（ナイフ）だけは1本。銃が無くなるので、段としての手応えが残る */
    const want = GUN_ORDER[st + 1] === 'knife' ? 1 : 2;
    ok(a.slot.sim.carry.length === want,
      `持ち物は ${want}本（${a.slot.sim.carry.map(idOf).join('、')}）`);
    // 倒された側は生き返らせて次へ
    room._respawn(b.slot);
  }
}

console.log('\n[4.5] ガンゲームでは最後の1人になってもラウンドが終わらない');
// ラウンドの判定をそのまま通すと、1人倒れただけで「決着」になって
// 局面がBREAKへ移り、ガンゲームがデスマッチとして進んでしまう
{
  const ps = startWith(['あき', 'ばん'], 'gun');
  const phase0 = room.phase;
  down(ps[1]);
  room._checkRoundOver('kill');
  ok(room.phase === phase0, `局面が動かない (${room.phase})`);
  ok(room.round === 1, `ラウンドが増えない (${room.round})`);
  ok(ps[0].slot.rounds === 0, `残った人がラウンドを取らない (${ps[0].slot.rounds})`);
}

console.log('\n[5] 最後の武器で倒したら試合が終わる');
{
  const ps = startWith(['あき', 'ばん'], 'gun');
  const [a, b] = ps;
  const last = GUN_ORDER.length - 1;
  a.slot.stage = last;
  room._arm(a.slot);
  ok(idOf(a.slot.sim.weapon) === GUN_ORDER[last],
    `最後の武器を持っている (${GUN_ORDER[last]})`);

  // このあとの/logsの検査が前の節の記録と混ざらないよう、ここで一度空にする
  logs.clear();
  room._kill(b.slot, a.slot, 1);
  ok(room.phase === PHASE.END, '試合が終わった');
  const end = a.conn.sent.filter((m) => m.t === 'M').pop();
  ok(!!end, '試合終了の知らせが届いている');

  /* ガンゲームはs.roundsを誰も増やさない（rules.rounds===falseでラウンドが
     無いため）。_endMatchが従来通り無条件でs.roundsから「一番多い人」を
     探して/logsへ書くと、常に0対0を並び順で見て、勝った本人ではない側
     （最悪、負けた側）が優勝として記録される。段勝ちの1件だけが残るはず */
  const matches = logs.recent(50, 'match');
  ok(matches.length === 1, `/logsの試合終了が1件だけ（${matches.length}件）`);
  ok(matches[0]?.winner?.startsWith(a.slot.name),
    `勝った本人(${a.slot.name})が記録されている（${matches[0]?.winner}）`);
}

console.log('\n[6] ガンゲームでは自滅で進まない');
// 進めてしまうと、崖から飛び降りるのが一番速い勝ち方になる
{
  const ps = startWith(['あき', 'ばん'], 'gun');
  const a = ps[0];
  const st0 = a.slot.stage;
  room._kill(a.slot, a.slot, 1);        // 自分で自分を倒す扱い
  ok(a.slot.stage === st0, `自分を倒しても段が進まない（${st0}段のまま）`);

  room._killByFall(a.slot);
  ok(a.slot.stage === st0, '落ちても進まない');
  ok(room.phase === PHASE.LIVE, 'ラウンドが終わったりもしない');
}

console.log('\n[7] ガンゲームは倒れても生き返る');
// ラウンドが無いので、生き返らないと倒れたまま試合が終わらない
{
  const ps = startWith(['あき', 'ばん'], 'gun');
  const a = ps[0];
  down(a);
  a.slot.downed = true;
  a.slot.respawnIn = MATCH.RESPAWN_S;
  ok(!a.slot.sim.alive, '倒れている');

  // 復活までの秒数ぶん回す
  const need = Math.ceil(MATCH.RESPAWN_S / TICK_DT) + 4;
  for (let i = 0; i < need; i++) room._tick();
  ok(a.slot.sim.alive, `${MATCH.RESPAWN_S}秒で生き返った`);
  ok(a.slot.downed === false, '倒れた印も消えている');
}

console.log('\n[8] 倒れている間に死亡が積み上がらない');
// **ここがガンゲーム特有の壊れ方。** 局面が動かないので、
// 「もう数えた」の目印が無いと毎刻み「落下で死んだ」が走る（毎秒60回）
{
  const ps = startWith(['あき', 'ばん'], 'gun');
  const a = ps[0];
  const d0 = a.slot.sim.deaths;
  down(a);
  // 復活する前に何刻みか回す
  for (let i = 0; i < 30; i++) room._tick();
  const added = a.slot.sim.deaths - d0;
  ok(added === 1, `30刻み回しても死亡は1回だけ（${added}回）`);
}

console.log('\n[9] 遊び方を変えると持ち物も配り直る');
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('dm');
  const a = join('あき');
  const dmCarry = a.slot.sim.carry.length;
  ok(dmCarry >= 3, `デスマッチでは ${dmCarry}本`);
  room.setMode('gun');
  ok(a.slot.sim.carry.length === 2 && a.slot.sim.carry.map(idOf).includes('knife'),
    `ガンゲームでは今の段の1本とナイフ（${a.slot.sim.carry.map(idOf).join('、')}）`);

  room.setMode('dm');
  ok(a.slot.sim.carry.length === dmCarry, `戻すと ${dmCarry}本に戻る`);
}

console.log('\n[9.5] ガンゲームだけ手榴弾を数えない');
{
  /* 2026-08-13に足した。「ガンゲームの時は、手榴弾の弾の制限があったら
     ちょっとおかしいよね」と言われた所。
     あちらは手榴弾の段があって、投げる物が無くなるとその段で詰む
     （落ちた武器を拾えない遊び方なので、補充する道が1つも無い）。

     **実際に投げて数える。** 決まりの表を読むだけだと、
     部屋の側が決まりを見ていない時に素通りする */
  const ps = startWith(['あき', 'ばん'], 'gun');
  const a = ps[0];
  const before = a.slot.nades;
  for (let i = 0; i < 8; i++) room.throwNade(a.slot, null, { x: 0, y: 0, z: -1 });
  ok(a.slot.nades === before, `ガンゲームでは減らない（${before} → ${a.slot.nades}）`);

  const ps2 = startWith(['あき', 'ばん'], 'dm');
  const c = ps2[0];
  c.slot.nades = 2;
  room.throwNade(c.slot, null, { x: 0, y: 0, z: -1 });
  ok(c.slot.nades === 1, `デスマッチでは今まで通り減る（2 → ${c.slot.nades}）`);
}

console.log('\n[9.7] ガンゲームには制限時間が無い');
{
  /* 2026-08-13に「ガンゲームで時間制限あるの変だし」と言われた所。

     時計は**ラウンドの決着が付かない時に切るための物**なので、
     ラウンドが無いこの遊び方には切る相手が居ない。
     それでも時計だけが回っていて、3分ごとに「決着なし」でラウンドが終わり、
     幕間を挟んで全員が湧き直していた。
     撃ち合いの最中に、理由の分からない仕切り直しが挟まる形。

     **実際に3分以上回して確かめる。** 表のtimedを読むだけでは、
     部屋の側がそれを見ていない時に素通りする */
  const modes = modeOf('gun');
  ok(modes.timed === false, 'ガンゲームの決まりに「時計を持たない」がある');
  ok(modeOf('dm').timed !== false && modeOf('team').timed !== false,
    'デスマッチと2対2は今まで通り時計を持つ');

  startWith(['あき', 'ばん'], 'gun');
  ok(room.phase === PHASE.LIVE, '始まっている');
  const round = room.round;
  // 制限時間より長く回す。実時間で回すと3分待つことになるので刻みだけ進める
  const ticks = Math.ceil((MATCH.ROUND_TIME_S + 20) / TICK_DT);
  for (let i = 0; i < ticks; i++) room._tick();
  ok(room.phase === PHASE.LIVE, `${MATCH.ROUND_TIME_S}秒を越えても撃ち合いのまま`);
  ok(room.round === round, `仕切り直しが挟まっていない（ラウンド ${round} → ${room.round}）`);

  // デスマッチは今まで通り時間で切れる。ここが落ちると決着しない試合ができる
  startWith(['あき', 'ばん'], 'dm');
  const r2 = room.round;
  for (let i = 0; i < ticks; i++) room._tick();
  ok(room.round > r2 || room.phase !== PHASE.LIVE,
    'デスマッチは今まで通り時間で切れる');
  clear();
}

console.log('\n[9.8] 画面の上帯が、起きないことを出していないか');
{
  /* ガンゲームでは取得ラウンドが誰も増えず（rounds: false）、
     時計も無い。それなのに上帯は「3本先取 ／ 残り 3:00」と出していて、
     **どちらも起きないこと**を表示していた。
     今どの武器かは別の札(stage)が持っているので、上帯は決まりだけを言う */
  const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
  ok(/matchInfo\(mine, theirs, limit, phase, left, leader = '', mode = '\w+'\)/.test(hud),
    '上帯が遊び方を受け取っている');
  ok(/mode === 'gun'[\s\S]{0,900}?sub = '倒すと次の武器へ/.test(hud),
    'ガンゲームでは先取本数も残り時間も出さない');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/matchInfo\([\s\S]{0,160}?net\.mode/.test(main), '遊び方を渡している');
  ok(/gun \? r\.kills : r\.rounds/.test(main),
    'ガンゲームでは撃破数で比べる（取得本数は誰も増えないので0対0のままだった）');
}

console.log('\n[10] 決まりはサーバーだけが持っている');
// クライアントに決まりを持たせると、そちらを書き換えれば勝てる
{
  const dm = modeOf('dm');
  const gun = modeOf('gun');
  ok(typeof dm.onKill === 'function' && typeof gun.onKill === 'function',
    '両方とも倒した時の決まりを持っている');
  ok(gun.stagesOf(WEAPONS) === GUN_ORDER.length,
    `ガンゲームの段数は ${gun.stagesOf(WEAPONS)}（武器の並びと同じ）`);
  ok(modeOf('でたらめ').id === 'dm', '知らない名前はデスマッチへ寄せる');
}

console.log('\n[11] 選んだ遊び方が画面まで届く');
/* **ここが抜けていた。** サーバー側は切り替わっているのに、
   ロビーの電文に「今どれか」が入っていなかったので、押した側の画面は
   前の物に印が付いたまま。**「押せないボタン」に見えていた。**
   （項目を足す時に、間違えて発言の電文のほうへ入れていた） */
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('dm');
  const a = join('あき');
  a.conn.sent.length = 0;
  room.sendLobby();

  const lobbyOf = (p) => [...p.conn.sent].reverse().find((m) => m.t === Sv.LOBBY);
  ok(!!lobbyOf(a), 'ロビーの電文が届いている');
  ok(lobbyOf(a).md === 'dm', `今の遊び方が入っている（${lobbyOf(a).md}）`);

  for (const id of MODE_IDS) {
    // 今と同じ物を押しても何も起きない（[1]で見ている）ので、一度別の物にしてから押す
    room.setMode(MODE_IDS.find((x) => x !== id));
    a.conn.sent.length = 0;
    room.setMode(id);
    const msg = lobbyOf(a);
    ok(!!msg, `${id} … 押すとロビーが配り直される`);
    ok(msg?.md === id, `${id} … 押した物が画面へ届く（${msg?.md}）`);
  }
  room.setMode('dm');

  // 発言の電文には要らない。入れていたせいで、こちらに紛れ込んでいた
  a.conn.sent.length = 0;
  room.chat(a.slot, 'てすと');
  const chat = a.conn.sent.find((m) => m.t === Sv.CHAT);
  ok(!!chat && chat.m === 'てすと', '発言は届く');
  ok(chat.md === undefined, '発言の電文に遊び方は入っていない');

  // 読む側も同じ項目を見ているか
  const client = readFileSync(new URL('../src/net/client.js', import.meta.url), 'utf8');
  ok(/mode: m\.md/.test(client), '手元がロビーの md を読んでいる');
  const lobby = readFileSync(new URL('../src/ui/lobby.js', import.meta.url), 'utf8');
  ok(/if \(mode\) this\.mode = mode;/.test(lobby), '画面が届いた物へ印を付け替えている');
}

clear();
room.phase = PHASE.WAIT;
room.setMode('dm');

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
