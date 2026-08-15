// 2対2（チーム戦）の検査。本物のRoomを動かす。
//
// なぜ要るか: **チーム制は一度入れて、一度やめている。**
// その時の残骸（ロビーの行に team が入っていた頃の番号）が読む側に残っていて、
// 対戦中は全員が同じ姿で並ぶという不具合を何ヶ月も抱えていた。
// 同じ轍を踏まないよう、入れ直す今回は数字で押さえる。
//
// 特に見張りたいのが4つ。
//
//   1. **味方を撃てる。** 味方に弾が入ると、2対2はただの4人デスマッチになる
//   2. **1人倒れた時点でラウンドが終わる。** 相方が生きているのに決着すると、
//      2対2である意味がそのまま消える
//   3. **片側だけに全員が座って始まる。** 始まった瞬間に「相手が全員倒れている」
//      状態になって即決着する
//   4. **デスマッチとガンゲームを巻き込む。** ラウンドの終わり方を
//      「最後のチーム」へ書き換えているので、そちらが壊れうる
//
//   node tools/check-teams.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import {
  PHASE, MATCH, MODE_IDS, TEAM_OF_SEAT, TEAM_NAMES, SCORE_ROW, SCORE_ROW_LEN, NADE,
} from '../src/net/protocol.js';

const { getRoom } = await import('../server/room.js');
const { buildWorld } = await import('../server/world.js');
const { modeOf } = await import('../server/modes.js');

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

/** 席を指定して座らせて始める。seats は席番号の並び */
const startWith = (names, seats, mode) => {
  clear();
  room.phase = PHASE.WAIT;
  room.setMode(mode);
  const ps = names.map((n) => join(n));
  ps.forEach((p, i) => room.takeSeat(p.slot, seats[i]));
  ps.forEach((p) => room.setReady(p.slot, true));
  room.events.length = 0;
  return ps;
};

const down = (p) => { p.slot.sim.player.alive = false; p.slot.sim.player.health = 0; };

console.log('\n[1] 遊び方として並んでいる');
{
  ok(MODE_IDS.includes('team'), `遊び方に入っている（${MODE_IDS.join('、')}）`);
  const t = modeOf('team');
  ok(t.teams === true, '2対2はチーム分けがある');
  ok(modeOf('dm').teams === false, 'デスマッチにはチーム分けが無い');
  ok(modeOf('gun').teams === false, 'ガンゲームにもチーム分けが無い');
  ok(t.rounds === true, 'ラウンド制（デスマッチと同じ進行）');
  ok(TEAM_NAMES.length === 2, `チームは2つ（${TEAM_NAMES.join(' / ')}）`);
}

console.log('\n[2] 席でチームが決まる');
// チームを選ぶ画面を別に作らない。席を選ぶ画面が既にあるので、そこに寄せる
{
  ok(TEAM_OF_SEAT(0) === 0 && TEAM_OF_SEAT(1) === 0, '1番と2番の席が同じチーム');
  ok(TEAM_OF_SEAT(2) === 1 && TEAM_OF_SEAT(3) === 1, '3番と4番の席が同じチーム');
  ok(TEAM_OF_SEAT(0) !== TEAM_OF_SEAT(2), '左と右は別のチーム');
  ok(TEAM_OF_SEAT(null) === null, '席に着いていない人はどちらでもない');

  const ps = startWith(['あき', 'ばん', 'しい', 'えむ'], [0, 1, 2, 3], 'team');
  const [a, b, c, d] = ps;
  ok(room.teamOf(a.slot) === room.teamOf(b.slot), 'あきとばんは味方');
  ok(room.teamOf(c.slot) === room.teamOf(d.slot), 'しいとえむは味方');
  ok(room.teamOf(a.slot) !== room.teamOf(c.slot), 'あきとしいは敵');
}

console.log('\n[3] チーム分けの無い遊び方では1人＝1チーム');
// **ここが効いている。** こうしておくとラウンドの終わり方を1本で書けるので、
// デスマッチだけ別の数え方を持つ形にならない
{
  const ps = startWith(['あき', 'ばん'], [0, 1], 'dm');
  ok(room.teamOf(ps[0].slot) !== room.teamOf(ps[1].slot),
    'デスマッチでは隣の席同士でも敵');
  ok(room._sameTeam(ps[0].slot, ps[1].slot) === false, '味方判定も立たない');
}

console.log('\n[4] 味方は撃てない');
// **味方に弾が入ると、2対2はただの4人デスマッチになる**
{
  const ps = startWith(['あき', 'ばん', 'しい', 'えむ'], [0, 1, 2, 3], 'team');
  const [a, b, c] = ps;
  ok(room._sameTeam(a.slot, b.slot) === true, '味方同士だと分かっている');
  ok(room._sameTeam(a.slot, c.slot) === false, '敵は味方ではない');

  // 撃たれる側の並びに味方が入っていないこと。
  // 当たった後で捨てる形にすると、味方の体が弾を止めるかどうかが書き方次第で変わる
  const src = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  ok(/const targets = \[\];[\s\S]{0,300}?_sameTeam/.test(src),
    '狙う相手を作る所で味方を外している（当たった後で捨てていない）');
}

console.log('\n[5] 手榴弾も味方には入らない');
// 味方に投げて倒せると、味方が邪魔でしかなくなる。
// **投げた本人は巻き込む**（自分の足元に落として道連れは残す）
{
  const src = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  ok(/_explode\(g\)[\s\S]{0,900}?_sameTeam\(s, thrower\)/.test(src), '爆風から味方を外している');
  ok(!/_explode\(g\)[\s\S]{0,900}?s === thrower/.test(src),
    '投げた本人は外していない（道連れは残す）');
}

console.log('\n[6] 相方が生きている間はラウンドが終わらない');
// **1人倒れた時点で決着すると、2対2である意味がそのまま消える**
{
  const ps = startWith(['あき', 'ばん', 'しい', 'えむ'], [0, 1, 2, 3], 'team');
  const [a, b, c, d] = ps;
  const round0 = room.round;

  down(a);
  room._checkRoundOver('kill');
  ok(room.phase === PHASE.LIVE, '味方が1人倒れてもラウンドは続く');
  ok(room.round === round0, 'ラウンドも進んでいない');

  down(b);
  room._checkRoundOver('kill');
  ok(room.phase !== PHASE.LIVE, 'チームが全滅したら終わる');
  ok(c.slot.rounds === 1 && d.slot.rounds === 1,
    `残ったチームの2人ともが1本取る（${c.slot.rounds} / ${d.slot.rounds}）`);
  ok(a.slot.rounds === 0 && b.slot.rounds === 0, '倒れた側は取っていない');
}

console.log('\n[7] デスマッチは今まで通り');
// ラウンドの終わり方を書き換えているので、**こちらが壊れていないかが本題**
{
  const ps = startWith(['あき', 'ばん', 'しい'], [0, 1, 2], 'dm');
  down(ps[0]);
  room._checkRoundOver('kill');
  ok(room.phase === PHASE.LIVE, '1人倒れてもラウンドは続く');
  down(ps[1]);
  room._checkRoundOver('kill');
  ok(room.phase !== PHASE.LIVE, '最後の1人になったら終わる');
  ok(ps[2].slot.rounds === 1, '残った人がラウンドを取る');
  ok(ps[0].slot.rounds === 0 && ps[1].slot.rounds === 0, '倒れた人は取っていない');
}

console.log('\n[8] ガンゲームも今まで通り');
{
  const ps = startWith(['あき', 'ばん'], [0, 2], 'gun');
  const phase0 = room.phase;
  down(ps[1]);
  room._checkRoundOver('kill');
  ok(room.phase === phase0, 'ラウンドを持たないので局面が動かない');
  ok(ps[0].slot.rounds === 0, '誰もラウンドを取らない');
  room.setMode('dm');
}

console.log('\n[9] 片側だけに座っていると始まらない');
// 始まった瞬間に「相手が全員倒れている」状態になって即決着する
{
  clear();
  room.phase = PHASE.WAIT;
  room.setMode('team');
  const a = join('あき');
  const b = join('ばん');
  room.takeSeat(a.slot, 0);
  room.takeSeat(b.slot, 1);   // どちらも左側
  room.setReady(a.slot, true);
  room.setReady(b.slot, true);
  ok(room.phase === PHASE.WAIT, '片側だけでは始まらない');
  const why = room._whyNotStart();
  ok(/席にも座って/.test(why), `理由が出る（${why}）`);

  // 右側へ移ると始まる
  room.takeSeat(b.slot, 2);
  room.setReady(b.slot, true);
  ok(room.phase !== PHASE.WAIT, '両側に座ると始まる（1対1でも）');
  room.setMode('dm');
}

console.log('\n[10] 得点の電文にチームが載る');
// 載せないと、手元は「誰が味方か」を知る手段が無い。
// 席の情報は試合が始まると流れてこない
{
  const ps = startWith(['あき', 'ばん', 'しい', 'えむ'], [0, 1, 2, 3], 'team');
  const rows = room._rows();
  ok(rows.length === 4, `4人ぶん並ぶ（${rows.length}行）`);
  ok(rows[0].length === SCORE_ROW_LEN, `1行の項目数が決まり通り（${rows[0].length}）`);
  const teamOf = (slot) => rows.find((r) => r[SCORE_ROW.ID] === slot.id)[SCORE_ROW.TEAM];
  ok(teamOf(ps[0].slot) === teamOf(ps[1].slot), '味方同士は同じ番号');
  ok(teamOf(ps[0].slot) !== teamOf(ps[2].slot), '敵は違う番号');
  ok(teamOf(ps[0].slot) >= 0, `番号がちゃんと入っている（${teamOf(ps[0].slot)}）`);

  // チーム分けの無い遊び方では -1
  const dm = startWith(['あき', 'ばん'], [0, 1], 'dm');
  const r = room._rows().find((x) => x[SCORE_ROW.ID] === dm[0].slot.id);
  ok(r[SCORE_ROW.TEAM] === -1, `デスマッチでは -1（${r[SCORE_ROW.TEAM]}）`);
}

console.log('\n[11] 手元の受け取り方');
{
  const client = readFileSync(new URL('../src/net/client.js', import.meta.url), 'utf8');
  // **番号を直に書かない。** ロビーの行で、作る側が項目を落としたのに
  // 読む側が古い番号のまま残っていて、全員同じ姿になった前科がある
  ok(/SCORE_ROW\.TEAM/.test(client), 'チームの番号を並びの定数から読んでいる');
  /* 中身だけを切り出す。**呼び出し側（this._score(m);）で切ると、
     全然別の場所から数え始めてしまう。** 実際それで、隣にあるロビーの説明文の中の
     r[5] を拾って落ちた。コメントも外す（あそこには昔の番号が例として書いてある） */
  const scoreBlock = (client.split('_score(m) {')[1]?.split('\n  }')[0] || '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(scoreBlock.length > 0, '得点を読む所が見つかった');
  ok(!/r\[\d\]/.test(scoreBlock), `得点の行で番号を直に書いていない（${(scoreBlock.match(/r\[\d\]/g) || []).join('、') || 'なし'}）`);
  ok(/this\.mode = String\(m\.md\)/.test(client),
    '今の遊び方を覚えている（試合が始まるとロビーの電文は来ない）');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/_isMate\(/.test(main), '味方かどうかを見る所がある');
  ok(/const mate = this\._isMate\(/.test(main), '名札を作る所で味方かどうかを見ている');
  ok(/\n\s+mate,\n/.test(main), '名札へ味方かどうかを渡している');
  ok(/net\.mode === 'team'/.test(main), 'チーム戦の時だけ味方として扱う');

  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/\.plate\.mate/.test(html), '味方の名札に色が付く');
  // **味方だけ常に出すと、味方の位置が壁越しに分かる。**
  // 2人で挟む・別々に回る、という組み立てがそもそも要らなくなる
  ok(!/if \(!p\.mate\) continue;/.test(readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8')),
    '味方だけ別扱いで常に出したりはしていない');
}

console.log('\n[11.5] 味方が味方だと分かるか');
/* 実際に2対2を遊んで最初に出た感想が**「どれが味方か分からない」**だった。
   見た目は敵と同じ兵士で、名札は「相手が撃った直後」しか出ない決まりなので、
   撃たない相手を撃たない理由が画面のどこにも無かった。

   直し方は2つに分けてある。**どちらも「壁越しに全部見える」にはしない。**
     ・名札 … 味方は「撃った直後」の条件だけ外す。壁抜けの条件は外さない。
               見えた瞬間に色付きの名前が出るので、撃つ前に必ず分かる
     ・地図 … 味方は撃っていなくても点が出て、薄れず、色が違う。
               168pxの地図なので「あっちに居る」までしか分からない */
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const plates = main.split('_updatePlates(states) {')[1]?.split('\n  }')[0] || '';
  ok(plates.length > 0, '名札を作る所が見つかった');
  // 味方は「撃った直後」の条件を通らない
  ok(/if \(!mate && !this\._blips\.has\(st\.id\)\) continue;/.test(plates),
    '味方は撃っていなくても名札が出る');
  /* **壁抜けの条件は味方にも掛かる。** ここを味方だけ飛ばすと、
     相方の居場所が常に壁越しに分かって、組み立てが要らなくなる。
     レイを飛ばす所がmateの分岐の中に入っていないことを見る */
  const wallCheck = plates.split('rayIntersect')[0] || '';
  ok(!/if \(!mate\) \{/.test(wallCheck), '壁の向こうの味方までは出さない');
  ok(/hit\.distance < dist - 0\.45/.test(plates), '遮蔽の判定が残っている');
  /* **壁抜けを通してよいのは協力プレイだけ。**
     協力プレイには隠れる相手プレイヤーが居ないので、味方を壁で切ると
     「倒れた仲間が居ることにすら気づけない」だけになる。
     ただしその例外が対人（2対2）へ漏れると、上の組み立てが丸ごと壊れる。
     例外の条件に coop が入っていることを見る */
  const occl = plates.split('const occluded')[1]?.split('_plateV')[0] || '';
  ok(/coop/.test(occl), '壁抜けを通す例外は協力プレイ限定になっている');
  // 地図の点。味方は薄れない印(mate)を立てて渡す
  ok(/_blipList\.push\(\{[^}]*mate: true/.test(main), '地図へ味方の点を足している');
  const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
  ok(/b\.mate/.test(hud), '地図が味方の点を別の色で塗る');
}

console.log('\n[11.6] 2対2は味方同士で固まって始まる');
/* 湧く位置を散らす表(arenaSpawns)は「全員が互いに敵」向けに4隅へ置いてある。
   そのまま2対2に使うと**味方が35m離れた所からそれぞれ出てくる**ので、
   組んで戦う遊び方なのに合流するまでが毎ラウンドの最初の仕事になっていた */
{
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const sp = world.teamSpawns;
  ok(Array.isArray(sp) && sp.length === 4, `2対2用の湧き位置が4つある（${sp?.length}）`);
  const mateGap = [dist(sp[0], sp[1]), dist(sp[2], sp[3])];
  ok(mateGap.every((d) => d > 3 && d < 10),
    `味方同士は近い（${mateGap.map((d) => d.toFixed(1)).join('m / ')}m）`);
  // 敵とは今までの1対1と同じくらい離す
  const foeGap = dist(sp[0], sp[2]);
  ok(foeGap > 25, `相手チームとは遠い（${foeGap.toFixed(1)}m）`);
  /* **手榴弾1発で2人まとめて飛ばない距離。** 爆風は9.5mまで届くので、
     味方を2mまで寄せると開始直後に片方が投げた1発で味方ごと消える */
  ok(mateGap.every((d) => d > NADE.BLAST_R * 0.5),
    `手榴弾1発で味方ごと飛ばない（爆風${NADE.BLAST_R}mに対して${mateGap[0].toFixed(1)}m）`);

  // 本物のRoomで、席から引いた位置がそのチームの側になっているか
  const ps = startWith(['あき', 'ばん', 'しい', 'えむ'], [0, 1, 2, 3], 'team');
  const at = ps.map((p) => p.slot.sim.player.collider.start);
  ok(dist(at[0], at[1]) < 10,
    `左のチームは並んで湧く（${dist(at[0], at[1]).toFixed(1)}m）`);
  ok(dist(at[2], at[3]) < 10,
    `右のチームも並んで湧く（${dist(at[2], at[3]).toFixed(1)}m）`);
  ok(dist(at[0], at[2]) > 25,
    `相手とは離れて湧く（${dist(at[0], at[2]).toFixed(1)}m）`);
  // 味方同士が同じ場所に重ならないこと。重なると押し出し合って開幕に事故る
  ok(dist(at[0], at[1]) > 1.5, `味方同士が重なっていない（${dist(at[0], at[1]).toFixed(1)}m）`);
}

console.log('\n[11.7] デスマッチの湧き位置は今まで通り散っている');
// チーム用の表を足したせいで、全員が互いに敵の遊び方まで固まったら本末転倒
{
  const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
  const ps = startWith(['あき', 'ばん', 'しい', 'えむ'], [0, 1, 2, 3], 'dm');
  const at = ps.map((p) => p.slot.sim.player.collider.start);
  let worst = Infinity;
  for (let i = 0; i < at.length; i++) {
    for (let j = i + 1; j < at.length; j++) worst = Math.min(worst, dist(at[i], at[j]));
  }
  ok(worst > 20, `一番近い2人でも離れている（${worst.toFixed(1)}m）`);
}

console.log('\n[12] 2対2でも武器と手榴弾は今まで通り');
{
  const ps = startWith(['あき', 'ばん', 'しい', 'えむ'], [0, 1, 2, 3], 'team');
  ok(ps[0].slot.sim.carry.length >= 3,
    `持ち物は既定のまま（${ps[0].slot.sim.carry.length}本）`);
  ok(ps[0].slot.nades === NADE.PER_ROUND, `手榴弾も今まで通り（${ps[0].slot.nades}個）`);
  ok(modeOf('team').drops === true, '倒した相手の物は落ちる');
  ok(MATCH.ROUND_WINS === 3, `勝ちに要るラウンド数も同じ（${MATCH.ROUND_WINS}本）`);
}

clear();
room.phase = PHASE.WAIT;
room.setMode('dm');

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
