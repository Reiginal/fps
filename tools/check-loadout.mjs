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
import { LOADOUT_IDS, loadoutOf } from '../src/net/protocol.js';

const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');
const { SimPlayer } = await import('../server/sim.js');
const { buildWorld } = await import('../server/world.js');

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

// 短い呼び名と武器の対応。画面の札にも操作説明にも、この言葉で出す。
// 完全一致を求めないのは、札が「1 ライフル」のように数字を含むため
const NICK = { rifle: 'ライフル', pistol: 'ピストル', knife: 'ナイフ', nade: '手榴弾', shotgun: 'ショットガン' };

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
