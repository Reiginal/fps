// 滑り込み（スライディング）の検査。
//
// なぜ要るか: **これは「しゃがみ」の上に乗っている操作だから。**
// 押すキーはしゃがみと同じで、走ってトップスピードに乗っている時だけ
// 意味が変わる。つまり条件を1つ書き間違えると、
// **隠れようとしてしゃがんだのに前へ飛び出す**という一番痛い壊れ方をする。
// 撃ち合いの最中にそれが起きても、遊んでいる側からは
// 「たまに勝手に突っ込む」としか見えず、原因に辿り着けない。
//
// あわせて「速い移動手段になっていないか」も見る。
// 走りに息を付けた時と同じ話で、**滑るほうが速いなら常に滑るのが最適解**になり、
// せっかく作った選択がまた消える。実際、最初に書いた時は向きを寄せる所で
// 摩擦をかける前の速さへ戻していて、10.2m/sのまま8m滑り続けていた。
// ターミナルからは何も見えず、数字を出して初めて分かった。
//
//   node tools/check-slide.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';
import { S } from '../src/net/protocol.js';

const { Player } = await import('../src/player/player.js');
const { SimPlayer, ServerInput } = await import('../server/sim.js');
const { buildWorld } = await import('../server/world.js');
const { K, TICK_DT } = await import('../src/net/protocol.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const world = buildWorld();

/* 走れる直線を1本決めておく。地形の真ん中には掩体があって、
   向きによっては1歩目で壁に当たる（実際、南向き以外は0.64m/sしか出なかった）。
   南向き(yaw=π)だけが10m以上まっすぐ走れるので、そこで測る */
const LANE_YAW = Math.PI;
const mk = () => {
  const p = new Player(new THREE.Object3D(), world);
  p.teleport(new THREE.Vector3(0, 0.2, 0));
  p.yaw = LANE_YAW;
  return p;
};

const input = (keys = []) => ({
  down: (c) => keys.includes(c),
  pressed: () => false,
  buttons: [false, false, false],
  takeLook: () => ({ yaw: 0, pitch: 0 }),
  moveVector: (o) => {
    o.x = (keys.includes('KeyD') ? 1 : 0) - (keys.includes('KeyA') ? 1 : 0);
    o.z = keys.includes('KeyW') ? -1 : 0;
    return o;
  },
  endFrame: () => {},
});

const RUN = input(['KeyW', 'ShiftLeft']);
const WALK = input(['KeyW']);
const STILL = input([]);
const CROUCH_STILL = input(['ControlLeft']);
const RUN_CROUCH = input(['KeyW', 'ShiftLeft', 'ControlLeft']);

const DT = 1 / 60;
// yawはマウスで動く物なので、lookEnabled=falseで回すと毎回書き戻す必要がある
const step = (p, seconds, inp) => {
  for (let i = 0; i < Math.round(seconds / DT); i++) { p.update(DT, inp, false); p.yaw = LANE_YAW; }
};
/** トップスピードまで走らせる */
const runUp = (p, seconds = 1.5) => { step(p, seconds, RUN); return p.horizontalSpeed; };

console.log('\n[1] 走ってトップスピードに乗っている時だけ滑る');
{
  const p = mk();
  const top = runUp(p);
  ok(top > 7.0, `走りの最高速まで乗った (${top.toFixed(2)}m/s)`);
  step(p, DT, RUN_CROUCH);
  ok(p.sliding === true, '走っている時にしゃがみを押すと滑り出す');
  ok(p.horizontalSpeed > top * 1.25,
    `走りより速く飛び出す (${top.toFixed(2)} → ${p.horizontalSpeed.toFixed(2)}m/s)`);
}

console.log('\n[2] しゃがみは今まで通り使える');
/* **ここが一番大事。** 滑りはしゃがみと同じキーなので、条件を緩めると
   隠れようとしてしゃがんだ時に前へ飛び出す。
   立ち止まってしゃがむ・歩きながらしゃがむは、今まで通りでなければならない */
{
  const p = mk();
  step(p, 0.5, STILL);
  step(p, 0.4, CROUCH_STILL);
  ok(p.sliding === false, '立ち止まってしゃがんでも滑らない');
  ok(p.crouching === true, 'ちゃんとしゃがんでいる');
  ok(p.horizontalSpeed < 0.5, `前へ出ていない (${p.horizontalSpeed.toFixed(2)}m/s)`);
}
{
  const p = mk();
  step(p, 1.5, WALK);
  const walk = p.horizontalSpeed;
  step(p, DT, input(['KeyW', 'ControlLeft']));
  ok(p.sliding === false, `歩きからは滑らない (歩き ${walk.toFixed(2)}m/s)`);
  step(p, 0.4, input(['KeyW', 'ControlLeft']));
  ok(p.crouching === true, 'しゃがみ歩きになるだけ');
}
{
  // 走り出した直後、まだ加速の途中では滑らせない
  const p = mk();
  step(p, 0.12, RUN);
  const sp = p.horizontalSpeed;
  step(p, DT, RUN_CROUCH);
  ok(p.sliding === false, `加速の途中では滑らない (${sp.toFixed(2)}m/s)`);
}
{
  // 空中でしゃがんでも滑らない。跳びながら滑れると空中で加速できてしまう
  const p = mk();
  runUp(p);
  step(p, DT, input(['KeyW', 'ShiftLeft', 'Space']));
  p.velocity.y = 5;                       // 確実に浮かせる
  step(p, 0.25, input(['KeyW', 'ShiftLeft']));
  ok(p.onFloor === false, '浮いている');
  step(p, DT, RUN_CROUCH);
  ok(p.sliding === false, '空中でしゃがんでも滑らない');
}

console.log('\n[3] 滑る距離と長さ');
/* 走り続けたほうが遠くまで行く、が守られていること。
   滑りが移動手段として得だと、常に滑るのが最適解になって選択が消える */
{
  const p = mk();
  runUp(p);
  const x0 = p.collider.start.x, z0 = p.collider.start.z;
  const v0 = p.horizontalSpeed;
  step(p, DT, RUN_CROUCH);
  let t = 0;
  while (p.sliding && t < 3) { p.update(DT, RUN_CROUCH, false); p.yaw = LANE_YAW; t += DT; }
  const dist = Math.hypot(p.collider.start.x - x0, p.collider.start.z - z0);
  ok(t > 0.6 && t < 0.95, `0.8秒ほどで終わる (${t.toFixed(2)}秒)`);
  ok(dist > 4 && dist < 6.5, `5mほど進む (${dist.toFixed(2)}m)`);
  ok(p.horizontalSpeed < v0 * 0.62,
    `終わる頃には遅くなっている (${v0.toFixed(2)} → ${p.horizontalSpeed.toFixed(2)}m/s)`);
  // 同じ時間ずっと走っていたほうが遠い＝滑りは移動手段として得ではない
  const q = mk();
  runUp(q);
  const qx = q.collider.start.x, qz = q.collider.start.z;
  step(q, t, RUN);
  const runDist = Math.hypot(q.collider.start.x - qx, q.collider.start.z - qz);
  ok(runDist > dist,
    `同じ時間なら走ったほうが遠い (走り ${runDist.toFixed(2)}m / 滑り ${dist.toFixed(2)}m)`);
}

console.log('\n[4] 滑っている間は加速できない');
/* Wを押しっぱなしにしていても速くならないこと。
   ここが通っていると、滑りは「速さを一度だけ現金化する操作」に収まる */
{
  const p = mk();
  runUp(p);
  step(p, DT, RUN_CROUCH);
  let prev = p.horizontalSpeed;
  let rose = 0;
  while (p.sliding) {
    p.update(DT, RUN_CROUCH, false);
    p.yaw = LANE_YAW;
    if (p.horizontalSpeed > prev + 1e-6) rose++;
    prev = p.horizontalSpeed;
  }
  ok(rose === 0, `最初から最後まで減り続ける (速くなったフレーム ${rose}回)`);
}

console.log('\n[5] 当たり判定が低くなる');
// 見た目だけ低くして判定が立ち姿のままだと、滑って避けたつもりが頭を撃たれる
{
  const p = mk();
  runUp(p);
  step(p, DT, RUN_CROUCH);
  step(p, 0.3, RUN_CROUCH);
  ok(p.height < 1.15, `しゃがみの高さまで縮む (${p.height.toFixed(2)}m)`);
  ok(p.crouching === true, 'しゃがみ扱いになっている');
}

console.log('\n[6] しゃがみを離しても滑りは続く');
// 離した瞬間に立ち上がる作りだと、滑り終わりが毎回ぶれて手応えが読めない
{
  const p = mk();
  runUp(p);
  step(p, DT, RUN_CROUCH);
  step(p, 0.2, RUN);          // しゃがみを離す
  ok(p.sliding === true, '離しても滑り続ける');
  ok(p.height < 1.3, `姿勢も低いまま (${p.height.toFixed(2)}m)`);
}

console.log('\n[7] 足音が鳴らない');
/* 歩調は「進んだ距離」で刻んでいるので、止めないと滑っている間に
   10m/sぶんの足音が鳴る。地面を蹴っていないのに全力疾走の足音が鳴る */
{
  const p = mk();
  runUp(p);
  let steps = 0;
  p.onFootstep = () => { steps++; };
  step(p, DT, RUN_CROUCH);
  while (p.sliding) { p.update(DT, RUN_CROUCH, false); p.yaw = LANE_YAW; }
  ok(steps === 0, `滑っている間は1回も鳴らない (${steps}回)`);
}
{
  // 滑り出した合図は1回だけ来る。音を鳴らすのはこれを受けた側
  const p = mk();
  runUp(p);
  let fired = 0;
  p.onSlide = () => { fired++; };
  step(p, DT, RUN_CROUCH);
  while (p.sliding) { p.update(DT, RUN_CROUCH, false); p.yaw = LANE_YAW; }
  ok(fired === 1, `滑り出しの合図は1回 (${fired}回)`);
}

console.log('\n[8] 息を使う');
{
  const p = mk();
  runUp(p, 0.9);
  const before = p.stamina;
  step(p, DT, RUN_CROUCH);
  ok(p.stamina < before - 0.2,
    `1回で息が減る (${before.toFixed(2)} → ${p.stamina.toFixed(2)})`);
}
{
  // 息が足りなければ滑れない。走り切って空にしてから試す
  const p = mk();
  step(p, 3.4, RUN);
  ok(p.staminaLock === true, '息が切れている');
  // 切れた状態からは走れないので、速度だけ手で乗せて条件を揃える
  p.velocity.z = 7.4 * Math.cos(LANE_YAW);
  p.velocity.x = 0;
  step(p, DT, RUN_CROUCH);
  ok(p.sliding === false, '息が無ければ滑らない');
}

console.log('\n[9] 押し直しても滑り続けられない');
/* **ここが一番の急所。** 終わった瞬間にまた滑れる作りだと、
   しゃがみを連打しながら走るのが一番速い移動になる。
   6秒のあいだ0.1秒おきにしゃがみを押し直して、何回滑れるかを数える */
{
  const p = mk();
  let slides = 0;
  p.onSlide = () => { slides++; };
  runUp(p);
  let t = 0;
  let on = false;
  let flip = 0;
  while (t < 6) {
    flip += DT;
    if (flip >= 0.1) { on = !on; flip = 0; }
    p.update(DT, on ? RUN_CROUCH : RUN, false);
    p.yaw = LANE_YAW;
    t += DT;
  }
  // 待ち1.1秒＋息0.34ぶんで、6秒なら多くても3回。連打が効くなら10回以上出る
  ok(slides <= 3, `6秒間の連打で滑れたのは ${slides}回（3回まで）`);
}

console.log('\n[10] 跳ぶと滑りが切れて、走りの速さまでしか持ち出せない');
/* 空中は摩擦が効かないので、滑り出しの10.2m/sのまま跳べたら
   着地まで一切減速しない＝「滑る→跳ぶ」が一番速い移動になる */
{
  const p = mk();
  runUp(p);
  step(p, DT, RUN_CROUCH);
  ok(p.sliding === true, '滑っている');
  const fast = p.horizontalSpeed;
  const JUMP = { ...RUN_CROUCH, pressed: (c) => c === 'Space' };
  p.update(DT, JUMP, false);
  p.yaw = LANE_YAW;
  ok(p.sliding === false, '跳んだら滑りが切れる');
  ok(p.velocity.y > 3, `ちゃんと跳んでいる (上向き ${p.velocity.y.toFixed(2)}m/s)`);
  ok(p.horizontalSpeed <= 7.45,
    `持ち出せるのは走りの最高速まで (${fast.toFixed(2)} → ${p.horizontalSpeed.toFixed(2)}m/s)`);
}

console.log('\n[11] 倒れたら滑りも止まる');
{
  const p = mk();
  runUp(p);
  step(p, DT, RUN_CROUCH);
  p.damage(9999);
  step(p, DT, RUN_CROUCH);
  ok(p.alive === false, '倒れた');
  ok(p.sliding === false, '滑りも畳まれている');
}

console.log('\n[12] サーバーでも同じように滑る');
/* 対戦では同じPlayerをサーバーでも回している。**片方だけ滑ると、
   滑っている間ずっと位置が引き戻される**（一番不快な壊れ方）。
   ここではしゃがみのビットを送って、向こうでも滑り出すかを見る */
{
  const sim = new SimPlayer(1, 'me', world);
  sim.player.teleport(new THREE.Vector3(0, 0.2, 0));
  const bits = (crouch) => K.FWD | K.SPRINT | (crouch ? K.CROUCH : 0);
  for (let i = 0; i < Math.round(1.5 / TICK_DT); i++) sim.tick(bits(false), LANE_YAW, 0);
  const top = sim.player.horizontalSpeed;
  ok(top > 7.0, `サーバー側も走れている (${top.toFixed(2)}m/s)`);
  sim.tick(bits(true), LANE_YAW, 0);
  ok(sim.player.sliding === true, 'しゃがみのビットで滑り出す');
  ok((sim.stateBits() & S.SLIDE) !== 0, '滑っている印がスナップショットに載る');
  ok((sim.stateBits() & S.SPRINT) === 0, '滑っている間は走りの印は消える');
  // 滑り終わったら印も消える
  for (let i = 0; i < Math.round(1.2 / TICK_DT); i++) sim.tick(bits(true), LANE_YAW, 0);
  ok(sim.player.sliding === false, '滑り終わった');
  ok((sim.stateBits() & S.SLIDE) === 0, '印も消えている');
}
{
  /* 同じ入力を同じ刻みで両側に流して、着く場所を比べる。
     check-parity.mjsと同じ考え方で、滑りの分だけをここで見る */
  const me = new Player(new THREE.Object3D(), world);
  me.teleport(new THREE.Vector3(0, 0.2, 0));
  me.yaw = LANE_YAW;
  const sim = new SimPlayer(2, 'you', world);
  sim.player.teleport(new THREE.Vector3(0, 0.2, 0));
  const srvIn = new ServerInput();
  const feed = (crouch, n) => {
    const b = K.FWD | K.SPRINT | (crouch ? K.CROUCH : 0);
    for (let i = 0; i < n; i++) {
      srvIn.set(b);
      me.update(TICK_DT, srvIn, false);
      me.yaw = LANE_YAW;
      sim.tick(b, LANE_YAW, 0);
    }
  };
  feed(false, Math.round(1.5 / TICK_DT));
  feed(true, Math.round(1.0 / TICK_DT));
  const gap = Math.hypot(
    me.collider.start.x - sim.player.collider.start.x,
    me.collider.start.z - sim.player.collider.start.z,
  );
  ok(gap < 0.01, `滑った後の位置が一致する (差 ${(gap * 1000).toFixed(1)}mm)`);
  ok(Math.abs(me.height - sim.player.height) < 0.001,
    `姿勢の高さも一致する (${me.height.toFixed(3)} / ${sim.player.height.toFixed(3)})`);
}

console.log('\n[13] 他人の画面でも滑って見える');
/* 印を載せただけで、見る側が使っていなければ意味が無い。
   使われていないと「しゃがんだまま毎秒10mで歩く人」になる */
{
  const { readFileSync } = await import('node:fs');
  const remote = readFileSync(new URL('../src/net/remote.js', import.meta.url), 'utf8');
  ok(/S\.SLIDE/.test(remote), 'remote.jsが滑りの印を読んでいる');
  ok(/slot\.slide/.test(remote), '姿勢の混ぜ具合を持っている');
  ok(/slot\.slide < 0\.5/.test(remote), '滑っている間は歩行の位相を止めている');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/player\.onSlide\s*=/.test(main), '滑り出しで音が鳴る');
  ok(/player\.sliding/.test(main), '画角が滑りを見ている');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
