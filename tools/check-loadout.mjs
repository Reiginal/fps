// 持ち物の検査。
//
// なぜ要るか: 遊んで「ライフルとショットガンとピストルを全部デフォルトで持ってるの嫌だ。
// そんな持てないからね、人は」と言われて、持ち物を絞った。
//
// **表にあること（WEAPONS）と、持って出られること（LOADOUT_IDS）を分けた**のがこの回の肝。
// 表から消さないのは、ガンゲーム（キルごとに武器が替わる）で配れなくなるのと、
// 将来「試合前に主武器を選ぶ」を入れる時に作り直しになるため。
//
// 分けたぶん、揃えないといけない場所が増えた:
//   1. protocol.js の LOADOUT_IDS   … 決まりそのもの
//   2. index.html の武器の札        … 遊ぶ人が見る「1〜4」
//   3. weapons.js の WeaponSystem   … 手元で持ち替えられる範囲
//   4. server/sim.js の SimPlayer   … サーバーが握らせる範囲
//
// **3と4がずれると一番読めない不具合になる。** 画面だけ持ち替わって
// 当たり判定が別の武器のまま、あるいは画面に写っていない武器で撃たれる。
// 撃たれた側からは何が起きたのか分からない。
//
//   node tools/check-loadout.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import * as THREE from 'three';
import {
  LOADOUT_IDS, loadoutOf, WEAPON_NICK, PRIMARY_IDS, PRIMARY_DEF, loadoutWith, PHASE,
} from '../src/net/protocol.js';

const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');
const { SimPlayer } = await import('../server/sim.js');
const { buildWorld } = await import('../server/world.js');
const { getRoom } = await import('../server/room.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const ids = WEAPONS.map((w) => w.id);
const carry = loadoutOf(WEAPONS);

console.log('\n[1] 持ち物の決まりが表と噛み合っている');
ok(LOADOUT_IDS.length > 0, `持ち物は ${LOADOUT_IDS.length} 本（${LOADOUT_IDS.join('、')}）`);
for (const id of LOADOUT_IDS) ok(ids.includes(id), `${id} は武器の表にある`);
ok(carry.length === LOADOUT_IDS.length,
  `全部の番号が引けた (${carry.join(', ')})`);
ok(new Set(LOADOUT_IDS).size === LOADOUT_IDS.length, '同じ武器が2回入っていない');

console.log('\n[2] 持って出ない武器が、表からは消えていない');
// 消してしまうとガンゲームで配れない。**持って出ないだけで、在る**
const benched = ids.filter((id) => !LOADOUT_IDS.includes(id));
ok(benched.length > 0, `持って出ない武器も表に残っている（${benched.join('、') || 'なし'}）`);
for (const id of benched) {
  const i = ids.indexOf(id);
  ok(i >= 0 && !!WEAPONS[i].build, `${id} … 表にあって組み立ても持っている`);
}

/* 短い呼び名は protocol.js が持つ。**ここに書き写さない。**
   写すと、片方だけ直した時に検査が古い言葉で通ってしまう
   （検査が嘘をつく形になり、一番たちが悪い） */
const NICK = WEAPON_NICK;

console.log('\n[3] 画面の札と並びが一致している');
// ここがずれると、押した数字と出てくる武器が違う。
// 遊ぶ側からは「3を押したのにナイフが出ない」としか見えない
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const at = html.indexOf('<div id="slots">');
  ok(at > 0, '武器の札が index.html にある');
  // 武器の札の並びは #slots から #slots2（包帯の札）の手前まで。
  // 閉じタグを数えて切り出そうとすると入れ子で必ず数え違えるので、
  // 次の入れ物の始まりを終わりの目印にする
  const to = html.indexOf('id="slots2"', at);
  const block = html.slice(at, to > 0 ? to : html.length);
  const labels = [...block.matchAll(/class="slot[^"]*">\s*(\d+)\s*([^<]+?)\s*</g)]
    .map((m) => ({ n: Number(m[1]), name: m[2] }));

  ok(labels.length === LOADOUT_IDS.length,
    `札の数が持ち物と同じ (札${labels.length} / 持ち物${LOADOUT_IDS.length})`);

  labels.forEach((l, k) => {
    ok(l.n === k + 1, `${k + 1}番目の札の数字が ${l.n}`);
    const def = WEAPONS[carry[k]];
    ok(def && l.name === NICK[def.id],
      `${k + 1}番の札「${l.name}」が持ち物の${k + 1}本目(${def?.id})と合っている`);
  });
}

console.log('\n[3.5] 起動画面の操作説明も同じ並びになっている');
// **札(#slots)と操作説明の2箇所に、同じ並びが書いてある。**
// 実際に片方だけ直して食い違っていた: 持ち物からショットガンを外した時、
// HUDの札は直したのに、起動画面には「2 ショットガン」が残っていた。
// 遊ぶ前に読む所なので、初めて遊ぶ人はそちらを信じて2を押す
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  // <b>1 / 2 / 3 / 4</b><span>ライフル / ピストル / …</span> の対を拾う
  const m = html.match(/<b>((?:\d\s*\/\s*)+\d)<\/b>\s*<span>([^<]+)<\/span>/);
  ok(!!m, '操作説明に武器の行がある');
  if (m) {
    const nums = m[1].split('/').map((s) => Number(s.trim()));
    const names = m[2].split('/').map((s) => s.trim());
    ok(nums.length === LOADOUT_IDS.length,
      `数字の数が持ち物と同じ (${nums.join('/')})`);
    ok(names.length === LOADOUT_IDS.length,
      `名前の数が持ち物と同じ (${names.join(' / ')})`);
    carry.forEach((w, k) => {
      const def = WEAPONS[w];
      ok(nums[k] === k + 1, `${k + 1}番目の数字が ${nums[k]}`);
      ok(names[k] === NICK[def.id],
        `${k + 1}番の説明「${names[k]}」が持ち物の${k + 1}本目(${def.id})と合っている`);
    });
  }
}

console.log('\n[4] 手元では持って出た物にしか持ち替えられない');
{
  const cam = new THREE.PerspectiveCamera(75, 1.6, 0.05, 900);
  const ws = new WeaponSystem(new THREE.Scene(), cam,
    new THREE.PerspectiveCamera(55, 1.6, 0.002, 12), new THREE.Scene());

  ok(ws.carry.join(',') === carry.join(','), `持ち物が決まり通り (${ws.carry.join(', ')})`);
  ok(ws.index === carry[0], `始まりは持ち物の1本目 (${WEAPONS[ws.index].id})`);

  for (const id of benched) {
    const i = ids.indexOf(id);
    ok(ws.switchTo(i) === false, `${id} へは持ち替えられない`);
    ok(ws.index !== i, `${id} を握っていない`);
  }
  // 持っている物へは替われる
  const other = carry.find((i) => i !== ws.index);
  ok(ws.switchTo(other) === true, `${WEAPONS[other].id} へは持ち替えられる`);
}

console.log('\n[5] サーバーも同じ判断をする');
// **ここが本題。** 手元だけで弾いていると、電文を作れる人は表にある武器を
// 何でも使える。画面には持って出ていない物が写らないので、
// 撃たれた側からは「見えていない武器で撃たれた」ようにしか見えない
{
  const world = buildWorld();
  const sim = new SimPlayer(1, 'テスト', world);

  ok(sim.carry.join(',') === carry.join(','), `サーバー側の持ち物も同じ (${sim.carry.join(', ')})`);
  ok(sim.weapon === carry[0], `始まりも同じ (${WEAPONS[sim.weapon].id})`);

  for (const id of benched) {
    const i = ids.indexOf(id);
    ok(sim.setWeapon(i) === false, `${id} を握らせない`);
    ok(sim.weapon !== i, `${id} になっていない`);
  }
  const other = carry.find((i) => i !== sim.weapon);
  ok(sim.setWeapon(other) === true, `${WEAPONS[other].id} は握れる`);

  // 範囲の外も今まで通り弾く
  ok(sim.setWeapon(-1) === false, '負の番号は弾く');
  ok(sim.setWeapon(WEAPONS.length + 3) === false, '大きすぎる番号も弾く');
}

console.log('\n[5.4] 主武器はサーバーが握る');
/* **手元が決める形にすると、電文を1つ送るだけで表にある武器を何でも持てる。**
   画面に写らない武器で撃たれた側は、何が起きたのか分からない */
{
  const room = getRoom(buildWorld());
  for (const s2 of [...room.slots.values()]) room.leave(s2);
  room.phase = PHASE.WAIT;
  room.setMode('dm');
  const conn = { sent: [], rtt: 0, send(m) { this.sent.push(m); } };
  const slot = room.join(conn, 'あき');

  ok(slot.primary === PRIMARY_DEF, `入った時は既定（${slot.primary}）`);
  ok(room.setPrimary(slot, 'shotgun') === true, 'ロビーでは選べる');
  ok(slot.primary === 'shotgun', '選んだ物が入っている');
  ok(WEAPONS[slot.sim.carry[0]].id === 'shotgun', 'その場で持ち物へ効く（押した結果が見える）');
  ok(room.setPrimary(slot, 'でたらめ') === false, '知らない名前は断る');
  ok(slot.primary === 'shotgun', '断った後も元のまま');
  ok(room.setPrimary(slot, 'nade') === false, '選べない武器も断る');

  // 試合中に持ち物が変わると、撃ち合いの最中に手の中の物が入れ替わる
  room.phase = PHASE.LIVE;
  ok(room.setPrimary(slot, 'rifle') === false, '試合が始まってからは変えられない');
  ok(slot.primary === 'shotgun', '変わっていない');
  room.phase = PHASE.WAIT;
  for (const s2 of [...room.slots.values()]) room.leave(s2);
}

console.log('\n[5.5] 試合前に主武器を選べる');
/* **ショットガンをここで初めて持って出られるようになった。**
 * 表に残しておいたのがそのまま効いた（消していたら作り直しだった）。
 *
 * 見張りたいのは2つ。
 *   1. 選んだ物が1本目に来ること（来ないと押した意味が無い）
 *   2. **知らない名前を渡された時に既定へ寄せること。**
 *      電文は手で作れるので、表に無い武器の名前を送られても持たせない
 */
{
  ok(PRIMARY_IDS.length >= 2, `選べるのは ${PRIMARY_IDS.length} 本（${PRIMARY_IDS.join('、')}）`);
  ok(PRIMARY_IDS.includes(PRIMARY_DEF), `既定は ${PRIMARY_DEF}`);
  for (const id of PRIMARY_IDS) ok(ids.includes(id), `${id} は武器の表にある`);
  ok(PRIMARY_IDS.includes('shotgun'), 'ショットガンが選べるようになっている');

  const base = loadoutWith(WEAPONS, PRIMARY_DEF);
  ok(base.join(',') === carry.join(','), '既定を選んだ時は今まで通りの持ち物');

  for (const id of PRIMARY_IDS) {
    const list = loadoutWith(WEAPONS, id);
    ok(list.length === LOADOUT_IDS.length, `${id} … 本数は変わらない（${list.length}本）`);
    ok(WEAPONS[list[0]].id === id, `${id} … 1本目が選んだ武器になる`);
    // 2本目から先は固定。ここまで動くと、押すたびに全部が入れ替わることになる
    ok(list.slice(1).join(',') === carry.slice(1).join(','), `${id} … 2本目から先は変わらない`);
    ok(new Set(list).size === list.length, `${id} … 同じ武器が2回入らない`);
  }

  for (const junk of ['でたらめ', '', null, undefined, 'nade']) {
    const list = loadoutWith(WEAPONS, junk);
    ok(WEAPONS[list[0]].id === PRIMARY_DEF,
      `${JSON.stringify(junk) ?? 'undefined'} を渡されても既定へ寄せる`);
  }
}

console.log('\n[5.6] 画面の札が配られた物に付いてくる');
/* **1番の札が「ライフル」で固定ではなくなった。**
   書き換えないと、ショットガンを選んだ人の画面に「1 ライフル」と出たまま
   ショットガンが出てくる。押した数字と出てくる物が食い違う */
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/hud\.slotNames\(/.test(main), '札の文字を書き換える所がある');
  ok(/case EV\.ARM[\s\S]{0,900}?hud\.slotNames/.test(main),
    '持ち物が配られた時に書き換えている');

  const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
  ok(/slotNames\(names\)\s*\{/.test(hud), 'HUD側に受け口がある');

  // 呼び名は1箇所に置く。写すと、片方だけ直した時に食い違う
  const proto = readFileSync(new URL('../src/net/protocol.js', import.meta.url), 'utf8');
  ok(/export const WEAPON_NICK/.test(proto), '呼び名は protocol.js が持っている');
  for (const id of ids) ok(!!WEAPON_NICK[id], `${id} の呼び名がある`);
}

console.log('\n[6] 持ち物の並びに近接と投擲が最後に来ている');
// 数字の1と2が銃で、後ろがナイフと手榴弾。
// 撃ち合いの最中に押し間違えて刃を握る事故を減らす並びにしてある
{
  const kinds = LOADOUT_IDS.map((id) => {
    const d = WEAPONS[ids.indexOf(id)];
    return d.thrown ? '投擲' : d.melee ? '近接' : '銃';
  });
  const firstMelee = kinds.findIndex((k) => k !== '銃');
  const lastGun = kinds.lastIndexOf('銃');
  ok(firstMelee === -1 || lastGun < firstMelee,
    `銃が先、近接と投擲が後ろ (${kinds.join(' → ')})`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
