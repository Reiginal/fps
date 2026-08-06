// 回線が切れた人の復帰の検査。本物のRoomを動かす。
//
// なぜ要るか: **切れた時の挙動は、狙って再現するのが一番難しい層。**
// 手元で遊んでいる限り回線は切れないので、実際に壊れているかどうかは
// 「電車の中で遊んだ人が、席と点数を失ったかどうか」でしか分からない。
// その報告は「なんか切れた」としか返ってこない。
//
// 特に見張りたいのが3つ。
//
//   1. **戻ってきたのに0から始まる。** 取っておく所か返す所のどちらかが
//      抜けていても、遊べてしまうので気づけない
//   2. **他人の席を奪って戻る。** 抜けている間に誰かが座っていたら、
//      その人を立たせてまで返してはいけない
//   3. **合言葉が使い回せる。** 1つの合言葉で2人が同じ点数を持てると、
//      席と点数がいくらでも増える
//
//   node tools/check-rejoin.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { PHASE, MATCH } from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');

const world = buildWorld();
let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const mkConn = () => ({ sent: [], rtt: 0, send(m) { this.sent.push(m); } });
const room = getRoom(world);
const clear = () => { for (const s of [...room.slots.values()]) room.leave(s); room.parked.clear(); };

const join = (name, token = null) => {
  const conn = mkConn();
  const slot = room.join(conn, name, token);
  if (slot) conn.slot = slot;
  return { conn, slot };
};

console.log('\n[1] 入ると合言葉がもらえる');
{
  clear();
  room.phase = PHASE.WAIT;
  const a = join('あき');
  ok(typeof a.slot.token === 'string' && a.slot.token.length > 8,
    `合言葉が付いている（${a.slot.token.length}文字）`);

  const w = room.welcome(a.slot);
  ok(w.tk === a.slot.token, 'お迎えの電文に載っている');
  ok(w.back === false, '初めて入った人は「戻ってきた」ではない');

  const b = join('ばん');
  ok(b.slot.token !== a.slot.token, '人ごとに違う');
}

console.log('\n[2] 席と点数を取っておいて、合言葉で返す');
{
  clear();
  room.phase = PHASE.WAIT;
  const a = join('あき');
  const token = a.slot.token;
  room.takeSeat(a.slot, 2);
  a.slot.rounds = 2;
  a.slot.sim.kills = 7;
  a.slot.sim.deaths = 3;
  a.slot.chr = 3;
  a.slot.stage = 4;

  room.leave(a.slot);
  ok(room.parked.size === 1, '抜けた時点で記録が取ってある');
  ok(!room.slots.has(a.slot.id), '部屋からは居なくなっている');

  const back = join('あき', token);
  ok(back.slot.seat === 2, `席が返ってきた（${back.slot.seat}番）`);
  ok(back.slot.rounds === 2, `ラウンドが返ってきた（${back.slot.rounds}）`);
  ok(back.slot.sim.kills === 7, `撃破が返ってきた（${back.slot.sim.kills}）`);
  ok(back.slot.sim.deaths === 3, `戦死も返ってきた（${back.slot.sim.deaths}）`);
  ok(back.slot.chr === 3, `見た目も返ってきた（${back.slot.chr}）`);
  ok(back.slot.stage === 4, `ガンゲームの段も返ってきた（${back.slot.stage}）`);
  ok(back.slot.back === true, '戻ってきた印が立っている');
  ok(room.welcome(back.slot).back === true, 'お迎えの電文にも載る');
  ok(back.slot.id !== a.slot.id, '番号そのものは新しい（前の番号は他の人が覚えている）');
}

console.log('\n[3] 合言葉が無い・違うと0から');
{
  clear();
  room.phase = PHASE.WAIT;
  const a = join('あき');
  room.takeSeat(a.slot, 1);
  a.slot.rounds = 2;
  room.leave(a.slot);

  const noToken = join('あき');
  ok(noToken.slot.seat === null && noToken.slot.rounds === 0,
    '合言葉なしでは新しい人として入る');
  ok(room.parked.size === 1, '記録は残っている（期限まで待つ）');

  const wrong = join('あき', 'でたらめな合言葉');
  ok(wrong.slot.seat === null && wrong.slot.rounds === 0, '違う合言葉でも新しい人');
}

console.log('\n[4] 合言葉は1回しか使えない');
// **ここが緩いと、1つの合言葉で2人が同じ点数を持てる。**
// 席と点数がいくらでも増える
{
  clear();
  room.phase = PHASE.WAIT;
  const a = join('あき');
  const token = a.slot.token;
  a.slot.rounds = 3;
  room.takeSeat(a.slot, 0);
  room.leave(a.slot);

  const first = join('あき', token);
  ok(first.slot.rounds === 3, '1回目は返ってくる');
  const second = join('なりすまし', token);
  ok(second.slot.rounds === 0, '2回目はもう返ってこない');
  ok(room.parked.size === 0, '使った記録は消えている');
}

console.log('\n[5] 他人が座った席は奪わない');
// 戻ってきた側は少し損をするが、座って待っていた側を立たせるほうが悪い
{
  clear();
  room.phase = PHASE.WAIT;
  const a = join('あき');
  const token = a.slot.token;
  a.slot.rounds = 1;
  room.takeSeat(a.slot, 1);
  room.leave(a.slot);

  const b = join('ばん');
  room.takeSeat(b.slot, 1);
  ok(b.slot.seat === 1, '抜けた席に別の人が座った');

  const back = join('あき', token);
  ok(back.slot.seat === null, '戻ってきても席は取り返さない');
  ok(b.slot.seat === 1, '座っていた人は動かされない');
  ok(back.slot.rounds === 1, `点数だけは返ってくる（${back.slot.rounds}）`);
}

console.log('\n[6] 期限を過ぎた記録は捨てる');
// 残し続けると、遊んだ人数ぶんの記録がサーバーの記憶に溜まり続ける
{
  clear();
  room.phase = PHASE.WAIT;
  const a = join('あき');
  const token = a.slot.token;
  a.slot.rounds = 2;
  room.takeSeat(a.slot, 0);
  room.leave(a.slot);
  ok(room.parked.size === 1, '記録がある');

  // 時計を進める代わりに、記録の時刻を過去へずらす
  room.parked.get(token).at -= (MATCH.REJOIN_S + 1) * 1000;
  const late = join('あき', token);
  ok(late.slot.rounds === 0, `${MATCH.REJOIN_S}秒を過ぎたら返ってこない`);
  ok(room.parked.size === 0, '期限切れは掃除されている');
}

console.log('\n[7] 何も持っていない人の記録は取らない');
// 入ってすぐ閉じただけの人まで溜め込むと、記憶が増えるだけで誰の役にも立たない
{
  clear();
  room.phase = PHASE.WAIT;
  const a = join('あき');
  room.leave(a.slot);
  ok(room.parked.size === 0, '立ったまま抜けた人は取っておかない');

  const b = join('ばん');
  b.slot.sim.kills = 1;
  room.leave(b.slot);
  ok(room.parked.size === 1, '撃破がある人は取っておく');
}

console.log('\n[8] 試合の途中で戻ると、その試合に入る');
// **ここが本題。** 席が空いたまま試合が続いていれば、戻って続きから戦える
{
  clear();
  room.phase = PHASE.WAIT;
  const ps = ['あき', 'ばん', 'しい'].map((n) => join(n));
  ps.forEach((p, i) => room.takeSeat(p.slot, i));
  ps.forEach((p) => room.setReady(p.slot, true));
  ok(room.phase !== PHASE.WAIT, '3人で試合が始まった');

  const token = ps[0].slot.token;
  ps[0].slot.rounds = 1;
  room.leave(ps[0].slot);
  ok(room.phase !== PHASE.WAIT, `1人抜けても試合は続く（残り${room._seated().length}席）`);

  const back = join('あき', token);
  ok(back.slot.seat === 0, '空いたままの席へ戻れる');
  ok(back.slot.rounds === 1, 'ラウンドも持ったまま');
  ok(back.slot.sim.alive, '生きた状態で湧いている（倒れたままにしない）');
  ok(room.phase !== PHASE.WAIT, '戻ったせいで試合が止まったりしない');
}

console.log('\n[9] 満員の時は戻れない');
// 記録は席を押さえないので、満員なら普通に断る。
// 押さえる形にすると、戻ってこない人の席が60秒空かない
{
  clear();
  room.phase = PHASE.WAIT;
  const first = join('あき');
  const token = first.slot.token;
  first.slot.sim.kills = 1;
  room.leave(first.slot);

  const others = [];
  while (!room.full) others.push(join(`ひと${others.length}`));
  ok(room.full, `満員になった（${room.slots.size}人）`);
  const back = join('あき', token);
  ok(back.slot === null, '満員なら合言葉があっても断る');
  ok(room.parked.has(token), '断った時は記録を使い切らない（次に空いたら戻れる）');
}

console.log('\n[10] 手元は合言葉を控えて、自分で戻りにいく');
// **サーバー側が完璧でも、手元が入り直さなければ何も起きない。**
// 「接続が切れました」の赤字が出て終わるだけになる
{
  const client = readFileSync(new URL('../src/net/client.js', import.meta.url), 'utf8');
  ok(/tk:\s*this\.token|join\.tk\s*=\s*this\.token/.test(client), '入る時に合言葉を添える');
  ok(/this\.token\s*=\s*m\.tk/.test(client), 'お迎えで届いた合言葉を控える');
  // ページを読み込み直した時は手元の変数が消える。「固まったから再読み込みした」が
  // 一番よくある戻り方なので、そこで落とすと復帰の半分が効かない
  ok(/sessionStorage\.setItem/.test(client), 'タブの記憶にも置く（読み込み直しに耐える）');
  // localStorageにすると、2つのタブで開いた時に片方の合言葉でもう片方の席を取る
  ok(!/localStorage\.[gs]etItem\(\s*TOKEN_KEY/.test(client),
    '合言葉は端末ではなくタブに覚える');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/REJOIN_WAITS/.test(main), '入り直す間隔を持っている');
  const waits = main.match(/const REJOIN_WAITS = \[([^\]]+)\]/);
  ok(!!waits, '間隔が並びで書いてある');
  if (waits) {
    const list = waits[1].split(',').map((s) => Number(s.trim()));
    ok(list.every((n) => Number.isFinite(n) && n > 0), `全部ちゃんとした数（${list.join('、')}ms）`);
    // 伸びていく形になっているか。全部同じだと、サーバーの入れ替え中は全部空振りする
    ok(list.every((n, i) => i === 0 || n >= list[i - 1]), '待ち時間が伸びていく');
    const total = list.reduce((a, b) => a + b, 0);
    // **合計がサーバーの取っておく時間を超えると、最後の1回は必ず無駄になる**
    ok(total < MATCH.REJOIN_S * 1000,
      `合計 ${total / 1000}秒 がサーバーの ${MATCH.REJOIN_S}秒 に収まっている`);
  }
  ok(/_onNetLost\([\s\S]{0,1200}?_joinMatch/.test(main), '切れた時に自分で入り直す');
  ok(/why !== 'bye'/.test(main), '自分で抜けた時は戻りにいかない');
  ok(/wasBack[\s\S]{0,200}?chat\.push/.test(main),
    '戻れた時は本人に伝える（黙って戻すと、戻ったのか0からなのか分からない）');
}

clear();
room.phase = PHASE.WAIT;

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
