// 装填の検査。ブラウザを使わずNodeだけで走る。
//
// なぜ要るか: 「1発ずつ入る」「途中で撃てる」は**画面を見ないと分からない**が、
// 中身は弾数と時間なので測れる。
//
// 実際に素通りしていた形: 見た目は1発ずつ入れる動きをしていたのに、
// 中身は「2.9秒待って7発まとめて足す」だった。途中でやめると1発も増えない。
// 動きだけ真似てあると、遊んで初めて気づく。
//
//   node tools/check-reload.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';

const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const cam = new THREE.PerspectiveCamera(75, 1.6, 0.05, 900);
const vcam = new THREE.PerspectiveCamera(55, 1.6, 0.002, 12);

const mkPlayer = () => ({
  alive: true, sprinting: false, crouching: false, onFloor: true,
  horizontalSpeed: 0, adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2,
  yaw: 0, pitch: 0, bobAmount: 0,
  addRecoil: () => {}, cancelHeal: () => {}, startHeal: () => false,
  collider: { start: new THREE.Vector3() },
});
const idle = {
  down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
};
const held = { ...idle, buttons: [true, false, false] };
const DT = 1 / 120;

// 武器番号を名前から引く。並びが変わっても壊れない
const indexOf = (id) => WEAPONS.findIndex((w) => w.id === id);
const SHOTGUN = indexOf('shotgun');
const RIFLE = indexOf('rifle');

/* 持ち替えが終わるまで空回しした状態のWeaponSystemを作る */
function ready(index) {
  const ws = new WeaponSystem(new THREE.Scene(), cam, vcam, new THREE.Scene());
  const p = mkPlayer();
  ws.switchTo(index);
  for (let i = 0; i < 120; i++) ws.update(DT, idle, p, {});
  return { ws, p };
}

console.log('\n[1] 表の値');
{
  const sg = WEAPONS[SHOTGUN];
  ok(sg.reloadKind === 'shell', `${sg.name} は1発ずつ入れる`);
  ok(sg.shellTime > 0, `1発ぶんの時間 ${(sg.shellTime * 1000).toFixed(0)}ms`);
  // 空から満タンにかかる時間が、前の一括装填(2.9秒)から大きく動いていないこと。
  // ここが倍になると、同じ武器のはずなのに強さが変わってしまう
  const full = sg.mag * sg.shellTime;
  ok(
    Math.abs(full - sg.reloadTime) < 0.4,
    `空から満タンで ${full.toFixed(2)}秒（前の一括装填は ${sg.reloadTime}秒）`,
  );
}

console.log('\n[2] 1発ずつ増える');
// ここが本体。0.42秒ごとに1発ずつ増えるか、時間を進めながら数える
{
  const { ws, p } = ready(SHOTGUN);
  const w = ws.current;
  const d = w.def;
  w.ammo = 0;
  const reserveBefore = w.reserve;
  ok(ws.reload(), '装填を始められる');

  const steps = [];
  let last = 0;
  for (let t = 0; t < d.shellTime * (d.mag + 2); t += DT) {
    ws.update(DT, idle, p, {});
    if (w.ammo !== last) { steps.push({ at: t + DT, ammo: w.ammo }); last = w.ammo; }
  }
  ok(steps.length === d.mag, `${d.mag}回に分けて増えた（${steps.length}回）`);
  ok(w.ammo === d.mag, `満タンになった (${w.ammo}/${d.mag})`);
  ok(
    w.reserve === reserveBefore - d.mag,
    `予備から${d.mag}発だけ減った (${reserveBefore} → ${w.reserve})`,
  );
  // 1発ずつなら増え方は必ず+1。まとめて足しているとここで落ちる
  const allByOne = steps.every((s, i) => s.ammo === i + 1);
  ok(allByOne, `毎回1発ずつ増えた（${steps.map((s) => s.ammo).join(',')}）`);
  // 間隔がshellTimeに揃っているか
  if (steps.length >= 2) {
    const gap = steps[1].at - steps[0].at;
    ok(
      Math.abs(gap - d.shellTime) < DT * 2,
      `間隔が1発ぶんに揃っている (${(gap * 1000).toFixed(0)}ms / 狙いは${(d.shellTime * 1000).toFixed(0)}ms)`,
    );
  }
}

console.log('\n[3] 途中でやめても、入れた分は残る');
// 「見た目だけ1発ずつ」だった時はここが0発になる
{
  const { ws, p } = ready(SHOTGUN);
  const w = ws.current;
  w.ammo = 0;
  ws.reload();
  // 3発ぶんだけ回してから、引金を引いて中断する
  for (let t = 0; t < w.def.shellTime * 3 + DT; t += DT) ws.update(DT, idle, p, {});
  const before = w.ammo;
  ok(before === 3, `3発ぶん回したら3発入っている (${before}発)`);

  ws.update(DT, held, p, {});
  ok(ws.reloading <= 0, '引金を引いた時点で装填が止まる');
  ok(w.ammo >= 2, `止めても入れた分は残る (${w.ammo}発)`);
}

console.log('\n[4] 中断したその場で撃てる');
// APEXと同じ形。「押した→止まる→もう一度押す」では遅い。
// 押した1回で止まって撃つ所まで行く
{
  const { ws, p } = ready(SHOTGUN);
  const w = ws.current;
  let shots = 0;
  ws.onShot = () => { shots++; };
  w.ammo = 0;
  ws.reload();
  for (let t = 0; t < w.def.shellTime * 2 + DT; t += DT) ws.update(DT, idle, p, {});
  const loaded = w.ammo;
  ok(loaded === 2, `2発入った所から始める (${loaded}発)`);

  // 引金を押した「その1コマ」で撃つ
  ws.update(DT, held, p, {});
  ok(shots > 0, `押した同じコマで撃った（${shots}発）`);
  ok(w.ammo === loaded - 1, `弾が1発減っている (${loaded} → ${w.ammo})`);
}

console.log('\n[5] 弾が無い時は中断できない');
// 弾が0で中断できてしまうと、押しても撃てないのに装填だけ止まる。
// 押すたびに装填がやり直しになって、いつまでも弾が入らない
{
  const { ws, p } = ready(SHOTGUN);
  const w = ws.current;
  w.ammo = 0;
  ws.reload();
  for (let i = 0; i < 6; i++) ws.update(DT, idle, p, {});
  const t0 = ws.reloading;
  ws.update(DT, held, p, {});
  ok(ws.reloading > 0 && ws.reloading < t0, `弾0では止まらず装填が続く (${ws.reloading.toFixed(3)}秒)`);
}

console.log('\n[6] 弾倉ごと入れ替える武器は途中で止まらない');
// 実物がそうだし、ここまで止められると1発ずつ入れる武器の意味が無くなる
{
  const { ws, p } = ready(RIFLE);
  const w = ws.current;
  w.ammo = 10;
  ws.reload();
  for (let i = 0; i < 30; i++) ws.update(DT, idle, p, {});
  const mid = ws.reloading;
  ws.update(DT, held, p, {});
  ok(ws.reloading > 0, `引金を引いても装填が続く (${ws.reloading.toFixed(3)}秒)`);
  ok(ws.reloading < mid, '時間はちゃんと進んでいる');
  ok(w.ammo === 10, `途中では1発も増えない (${w.ammo}発)`);
}

console.log('\n[7] 予備が足りない時は、ある分だけ入る');
{
  const { ws, p } = ready(SHOTGUN);
  const w = ws.current;
  w.ammo = 0;
  w.reserve = 3;
  ws.reload();
  for (let t = 0; t < w.def.shellTime * (w.def.mag + 2); t += DT) ws.update(DT, idle, p, {});
  ok(w.ammo === 3, `予備の3発だけ入った (${w.ammo}発)`);
  ok(w.reserve === 0, `予備が0になった (${w.reserve})`);
  ok(ws.reloading <= 0, '入れ終わって止まっている');
}

console.log('\n[8] 入れている間、銃が1発ごとに上下しない');
// 1発ぶんの進み具合で銃を上げ下げしていると、7発で7回上下する。
// 下ろす量が単調に上がって、下ろしきった後は動かないことを見る
{
  const { ws, p } = ready(SHOTGUN);
  const w = ws.current;
  w.ammo = 0;
  ws.reload();
  const seen = [];
  for (let t = 0; t < w.def.shellTime * 4; t += DT) {
    ws.update(DT, idle, p, {});
    seen.push(ws._shellLower);
  }
  // 下ろしきるまでの立ち上がりを飛ばして、その後の振れ幅を見る
  const settled = seen.slice(Math.round(0.5 / DT));
  const swing = Math.max(...settled) - Math.min(...settled);
  ok(swing < 0.05, `下ろした後は動かない（振れ幅 ${swing.toFixed(3)} / 上限0.05）`);
  ok(Math.max(...seen) > 0.9, `ちゃんと下ろしている（最大 ${Math.max(...seen).toFixed(2)}）`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
