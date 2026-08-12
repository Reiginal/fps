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

console.log('\n[1.5] 短い呼び名が全部の武器にある');
// 画面の札はこれを読む。欠けると札に長い正式名（MK-4 カービン）が並んで
// 1行に収まらなくなる
for (const d of WEAPONS) ok(!!d.nick && d.nick.length <= 8, `${d.id} … 呼び名「${d.nick}」`);

console.log('\n[2] 持って出ない武器が、表からは消えていない');
// 消してしまうとガンゲームで配れない。**持って出ないだけで、在る**
const benched = ids.filter((id) => !LOADOUT_IDS.includes(id));
ok(benched.length > 0, `持って出ない武器も表に残っている（${benched.join('、') || 'なし'}）`);
for (const id of benched) {
  const i = ids.indexOf(id);
  ok(i >= 0 && !!WEAPONS[i].build, `${id} … 表にあって組み立ても持っている`);
}

/* 短い呼び名。画面の札にも操作説明にも、この言葉で出す。
   **武器の表(WEAPONS)のnickが唯一の出どころ。** ここに写しを持っていた頃は、
   index.html・HUD・この検査の3箇所に同じ言葉が散っていて、
   武器を1本足すたびに手で揃えることになっていた */
const NICK = Object.fromEntries(WEAPONS.map((d) => [d.id, d.nick]));

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

console.log('\n[7] 数字キーに載らない枠（Qの狙撃銃・Eのショットガン・5で見る）');
{
  /* 2026-08-11に足した。「射撃訓練の時だけはショットガン出しておいて」と
     「5を押したら武器を見るモーション」を同じ日に言われて、**5番が衝突した。**

     持ち物(carry)へショットガンを入れると、main.jsのDigitの回しが
     carry.length ぶん回るので自動で5番になる。5番は見るモーションに使うので、
     Qの狙撃銃と同じ「carryの外側の例外枠」へ入れてある。

     ここで見たいのは**枠が2つ別々にあること**。
     1つを使い回すと、訓練場で狙撃銃とショットガンのどちらか片方しか持てない */
  const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');
  const ws = new WeaponSystem(new THREE.Scene(),
    new THREE.PerspectiveCamera(75, 1.6, 0.05, 900),
    new THREE.PerspectiveCamera(55, 1.6, 0.002, 12), new THREE.Scene());

  const sniperAt = WEAPONS.findIndex((w) => w.id === 'sniper');
  const shotgunAt = WEAPONS.findIndex((w) => w.id === 'shotgun');
  ok(!ws.carry.includes(sniperAt), '狙撃銃は数字キーの持ち物に入っていない');
  ok(!ws.carry.includes(shotgunAt), 'ショットガンも数字キーの持ち物に入っていない');
  ok(ws.carry.length < 5,
    `数字キーの持ち物は4本まで（${ws.carry.length}本）。5番を見るモーションに使えている`);

  // 枠に入れていない武器へは替われない
  ok(!ws.switchTo(shotgunAt), '枠に入れる前はショットガンへ替われない');
  ws.rangeIndex = shotgunAt;
  ws.switching = 0;
  ok(ws.switchTo(shotgunAt), 'Eの枠へ入れたら替われる');
  // **2つの枠が別々であること。** ここが本題
  ws.quickIndex = sniperAt;
  ws.switching = 0;
  ok(ws.rangeIndex === shotgunAt && ws.quickIndex === sniperAt,
    'Qの枠とEの枠が同時に埋まる（訓練場で両方持てる）');

  console.log('\n[8] 武器を見る動き（5キー）');
  ws.switching = 0;
  ws.switchTo(ws.carry[0]);
  ws.switching = 0;
  ok(ws.startInspect(), '手が空いていれば見られる');
  ok(ws.inspect > 0, `残り時間が入る（${ws.inspect.toFixed(2)}秒）`);
  // もう一度押したら止まる。1.6秒あるので押し間違えを待たされたくない
  ok(!ws.startInspect() && ws.inspect === 0, 'もう一度押すと止まる');
  /* **撃ったら止まること。** ここが一番大事で、止めないと
     銃を横に向けて回している最中に弾が出る */
  ws.startInspect();
  const player = {
    alive: true, sprinting: false, crouching: false, onFloor: true, horizontalSpeed: 0,
    adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2, yaw: 0, pitch: 0,
    bobAmount: 0, bobPhase: 0, addRecoil: () => {}, cancelHeal: () => {},
    startHeal: () => false, collider: { start: new THREE.Vector3() },
  };
  ws._fire(player, {});
  ok(ws.inspect === 0, '撃ったら見るのをやめる');
  // 走ったら止まること
  ws.startInspect();
  ws.update(1 / 60, {
    down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
  }, { ...player, sprinting: true }, {});
  ok(ws.inspect === 0, '走り出したら見るのをやめる');
  // 装填中は始められないこと
  ws.reloading = 1;
  ok(!ws.startInspect(), '装填中は見られない');
  ws.reloading = 0;
  ws.adsHeld = true;
  ok(!ws.startInspect(), '覗いている間は見られない');
  ws.adsHeld = false;

  /* **回さないこと。** 2026-08-11に1周回す形で出したら
     「なんか腕ごと回るってどういうこと？ちょっと見れればいいのよ」と言われた。

     正体は**腕が武器の模型の中に入っていること。**
     手と腕(buildHand)は銃と同じ群れの子なので、
     模型のrotation.zを回すと腕まで一緒に回る。銃だけ回す方法が無い。

     実際に見る動きを回してみて、**傾く量が小さいまま**であることを測る。
     1周(6.28rad)回っていたら元の形に戻っている */
  const src2 = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  ok(!/turn: Math\.PI \* 2/.test(src2), '1周回す設定が残っていない');

  ws.switching = 0;
  ws.startInspect();
  let maxRoll = 0;
  const still = {
    down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
  };
  // 見る動きの間ずっと回し続けて、傾きの最大を拾う
  for (let i = 0; i < 150; i++) {
    ws.update(1 / 120, still, player, {});
    maxRoll = Math.max(maxRoll, Math.abs(ws.current.model.rotation.z));
  }
  /* 0.6rad(約34度)まで。**傾けて天面を見せる**にはこのくらいで足り、
     1周(6.28)や半周(3.14)には遠い。
     元の構えにも少し傾きがあるので0にはならない */
  ok(maxRoll < 0.6, `見ている間の傾きが小さいまま（一番傾いた所で ${maxRoll.toFixed(2)}rad）`);

  /* ---- 形ごとの見る動き。2026-08-12に足した
     （「ブキミルモーションも何個かは、ちょっと違う挙動をするみたいなのあってもいいよね」）。

     **付いている形が実在すること**と、**やりすぎていないこと**を見る。
     ここが緩いと、消した形の設定が残ったり、
     腕ごと回る量まで傾けた設定が黙って入ったりする */
  const tbl = src2.match(/const INSPECTS = \{[\s\S]*?\n\};/)?.[0] ?? '';
  ok(tbl !== '', '形ごとの表がある');
  const ids = [...tbl.matchAll(/^ {2}(\w+): \{/gm)].map((m) => m[1]);
  ok(ids.length >= 3, `違う動きを持つ形が ${ids.length}つ`);
  const { SHAPE_LIST } = await import('../src/net/protocol.js');
  const known = new Set(SHAPE_LIST.map((x) => x.id));
  const ghost = ids.filter((id) => !known.has(id));
  ok(!ghost.length, ghost.length ? `売っていない形の設定が残っている（${ghost.join('、')}）`
    : '**書いてある形が全部実在する**（消した形の設定が残っていない）');

  /* やりすぎの線を数字で引く。
     傾け(tilt) … 1.0rad(57度)まで。**腕ごと回って見えるのがこの先**
     引き寄せ(z) … 0.07mまで。引きすぎると銃口が画面を覆う */
  let over = null;
  for (const m of tbl.matchAll(/^ {2}(\w+): \{ ([^}]*)\}/gm)) {
    const num = (k) => Number(new RegExp(`${k}: (-?[\\d.]+)`).exec(m[2])?.[1] ?? 0);
    if (Math.abs(num('tilt')) > 1.0 || num('z') > 0.07) over = m[1];
  }
  ok(!over, over ? `${over} がやりすぎ（傾け1.0rad・引き寄せ0.07mまで）`
    : '傾けも引き寄せも上限の中に収まっている');

  /* **模型ごと回さないこと（回すのは群れだけ）。** 2026-08-12に
     「ブキミルモーションでその鎖をブンブン回すとかでもいいしね」で
     鎖鎌の鎖を回す形を足した。腕は武器と同じ群れに入っているので、
     模型のrotationへ回転を積むと腕まで回る。
     **回す先が userData の群れ限定**であることを見る */
  ok(/w\.parts\.chain\.rotation\.z = /.test(src2), '回すのは鎖の群れ（parts.chain）');
  ok(!/insR \+= [^;]*spin/.test(src2), '模型の傾き(insR)へは回転を積んでいない');
  // 見るのをやめたら戻すこと。戻さないと回った所で止まったままになる
  ok(/w\.parts\.chain\.rotation\.z = 0;/.test(src2), 'やめた時に元へ戻している');
}

console.log('\n[9] パンチグローブは左右交互に打つ');
{
  /* 2026-08-12に「左クリックは交互で右左でパンチするようにしてほしいわ。
     左右左右で」と言われて足した。

     **群れが左右で別々でないと成立しない。** 振りは模型ごと動かす作りなので、
     打っていない方をその場へ置くには、その拳だけを逆へ戻す必要がある */
  const { SHAPE_BUILDS: SB, WEAPONS: WP } = await import('../src/player/weapons.js');
  const knife = WP.find((w) => w.id === 'knife');
  const gl = SB.glove(knife.view);
  ok(!!gl.userData.fistR && !!gl.userData.fistL, '左右の拳が別々の群れになっている');
  ok(gl.userData.handR?.parent === gl.userData.fistR,
    '**右手が右の拳の群れに入っている**（ミットは止まるのに手だけ出る、を防ぐ）');
  /* **左手は userData.handL ではない方を見る。**
     meleeRigが「使わない左手」を作って userData.handL を上書きするので
     （あちらは画面外へ逃がしてある物で、装填の道筋がそこを動かす）、
     見えている左手は fistL の中にいる別の手になる。
     ここでは「左の群れの中に手がある」ことだけ確かめる */
  let handInL = false;
  gl.userData.fistL.traverse((o) => { if (o.userData?.isHand) handInL = true; });
  ok(handInL, '左の拳の群れの中にも手がある');

  // 左クリックのたびに入れ替わること。右クリックは必ず右
  const src3 = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  ok(/this\.punchLeft = kind === 'light' \? !this\.punchLeft : false;/.test(src3),
    '左クリックで入れ替わり、右クリックは右に戻る');
  ok(/const idle = this\.punchLeft \? fistR : fistL;/.test(src3),
    '打っていない方だけをその場へ置いている');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
