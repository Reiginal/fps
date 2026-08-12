// 反動が「撃つと上がって、離すと戻る」形になっているかの検査。
//
// なぜ要るか: 遊んで「撃ってる時にエイムが上がるのはいいけど、
// 打ち終わったら元に戻るべきでは」と言われた所。
// **それまでは戻る仕組みが1つも無かった。** 1発ごとに跳ねの22%を狙点へ置いていき、
// 置いた分は自分でマウスを引き下げるしかなかったので、
// 弾倉を1本撃つたびに空を向いた状態から狙い直すことになっていた。
//
// 一般的なFPSはどちらかを持っている:
//   CS/Valorant … 跳ねは全部戻る。自分で引いた分は自分の狙点として残る
//   CoD系       … リコイルセンタリング。撃つ前に狙っていた点へ勝手に戻る
// ここは後者。ブラウザで気軽に遊ぶ物なので、狙点を毎回拾い直させない。
//
// 見るのは4つ。**撃つと上がる／離すと戻る／連射中は戻らない／
// 自分で引いた分と二重にならない。** 3つ目が一番大事で、
// ここが崩れると弾を撒く代償が消えて、押しっぱなしが最適解になる。
//
//   node tools/check-recoil.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';

const { Player } = await import('../src/player/player.js');
const { WEAPONS } = await import('../src/player/weapons.js');
const { buildWorld } = await import('../server/world.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const world = buildWorld();
const rifle = WEAPONS.find((w) => w.id === 'rifle');
const DT = 1 / 120;

// 何も押さない入力。視点を動かす時だけ pitch/yaw を1回ぶん載せる
const input = (look = null) => {
  let once = look;
  return {
    down: () => false,
    pressed: () => false,
    buttons: [false, false, false],
    takeLook: () => { const l = once || { yaw: 0, pitch: 0 }; once = null; return l; },
    moveVector: (o) => { o.x = 0; o.z = 0; return o; },
    endFrame: () => {},
  };
};

const mk = () => {
  const p = new Player(new THREE.Object3D(), world);
  p.pitch = 0;
  p.yaw = 0;
  return p;
};

/* weapons.jsの「反動を積む」と同じ式。**ばらつき(rand)だけ落としてある**
   （毎回違う値だと測れない）。あちらを変えたらここも直す */
const shot = (p, n) => {
  const rise = rifle.recoilPitch * (1 + Math.min(n, 7) * 0.16);
  const drift = rifle.recoilYaw * Math.sin(n * 1.7) * (0.6 + Math.min(n, 10) * 0.09);
  p.addRecoil(rise, drift);
};

/** 秒数ぶん進める。撃つならライフルの間隔(640rpm)で撃ち続ける */
const run = (p, seconds, { firing = false, from = 0, look = null } = {}) => {
  const gap = 60 / rifle.rpm;
  let next = firing ? 0 : Infinity;
  let n = from;
  let t = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    if (t >= next) { shot(p, n++); next += gap; }
    p.update(DT, input(i === 0 ? look : null), true);
    t += DT;
  }
  return n;
};

/** ラジアンを20m先の高さ(cm)に直す。「頭何個分ずれたか」で読めるようにする */
const cm = (rad) => Math.tan(rad) * 20 * 100;

console.log('\n[1] 撃っている間は狙点が上がる（連射の代償は残っている）');
{
  const p = mk();
  // 弾倉の半分（12発）ぶん撃ちっぱなし
  const gap = 60 / rifle.rpm;
  run(p, gap * 12, { firing: true });
  ok(p.pitch > 0, `12発で狙点が ${cm(p.pitch).toFixed(0)}cm 上がった（20m先）`);
  /* **上がりすぎていないこと。** 敵の身長(170cm)を越えると、
     撃ち切った時に相手の頭より上を狙っている＝当たらない武器になる */
  ok(cm(p.pitch) < 170, `170cm(敵の身長)は越えていない（${cm(p.pitch).toFixed(0)}cm）`);
}

console.log('\n[2] 指を離すと元の狙点へ戻る');
{
  const p = mk();
  const gap = 60 / rifle.rpm;
  run(p, gap * 25, { firing: true });      // 弾倉1本ぶん
  const peak = p.pitch;
  ok(peak > 0.01, `撃ち終わりで ${cm(peak).toFixed(0)}cm 上（20m先）`);

  run(p, 0.5);                              // 指を離して0.5秒
  ok(Math.abs(cm(p.pitch)) < 5,
    `0.5秒で元へ戻った（残り ${cm(p.pitch).toFixed(1)}cm。5cm未満）`);
  ok(Math.abs(cm(p.yaw)) < 5,
    `左右のずれも戻っている（残り ${cm(p.yaw).toFixed(1)}cm）`);

  /* **戻り切るまでの時間。** 遅いと撃ち終わってから画がふわふわ動き続ける。
     速すぎると跳ねが最初から無かったように見える */
  const q = mk();
  run(q, gap * 25, { firing: true });
  run(q, 0.30);
  ok(Math.abs(q.pitch) < peak * 0.15,
    `0.3秒で8割以上返っている（残り ${(100 * Math.abs(q.pitch) / peak).toFixed(0)}%）`);
}

console.log('\n[3] 押しっぱなしの間は返らない');
{
  /* **ここが崩れると連射の代償が消える。**
     返し始めるまでの間(RECOIL_RETURN_REST)が発射間隔より短いと、
     1発ごとに合間で返ってしまって、押しっぱなしでも狙点が上がらなくなる */
  const gap = 60 / rifle.rpm;
  const p = mk();
  const half = run(p, gap * 12, { firing: true });
  const mid = p.pitch;
  run(p, gap * 13, { firing: true, from: half });   // 続けて撃ち切る
  ok(p.pitch > mid * 1.4,
    `12発(${cm(mid).toFixed(0)}cm)から25発(${cm(p.pitch).toFixed(0)}cm)まで積み上がり続ける`);

  // 発射間隔より「返し始めるまでの間」が長いこと。数字はソースから読む
  const src = new URL('../src/player/player.js', import.meta.url);
  const { readFileSync } = await import('node:fs');
  const rest = Number(/RECOIL_RETURN_REST = ([\d.]+)/.exec(readFileSync(src, 'utf8'))?.[1]);
  const fastest = Math.min(...WEAPONS.filter((w) => w.auto && w.rpm).map((w) => 60 / w.rpm));
  ok(rest > fastest,
    `返し始めるまで${rest}秒 > 一番速い連射の間隔${fastest.toFixed(3)}秒`);
}

console.log('\n[4] 自分で引き下げた分と二重にならない');
{
  /* 撃ちながら自分でマウスを引き下げた人が、指を離した瞬間に
     **自分で下げた分＋勝手に返ってきた分**で地面を向くのを防ぐ。
     引いた分は「返す予定の借り」から先に引く作りになっている */
  const gap = 60 / rifle.rpm;
  const p = mk();
  run(p, gap * 12, { firing: true });
  const up = p.pitch;
  // 上がったぶんをちょうど自分で引き下げる（＝完璧に制御した人）
  run(p, 0.05, { look: { yaw: 0, pitch: -up } });
  ok(Math.abs(p.pitch) < 1e-6, '引き下げた直後は元の狙点に戻っている');

  run(p, 0.6);
  ok(Math.abs(cm(p.pitch)) < 5,
    `離しても下を向かない（${cm(p.pitch).toFixed(1)}cm。5cm未満）`);
}

console.log('\n[5] 真上で止まった分は借りにしない');
{
  /* 上限(1.5rad)で止まった分まで借りに積むと、
     真上を向いて撃ち続けた人が指を離した瞬間に地面まで落ちる */
  const p = mk();
  p.pitch = 1.49;
  for (let i = 0; i < 40; i++) shot(p, i);
  ok(p.pitch <= 1.5 + 1e-9, `狙点は上限で止まっている（${p.pitch.toFixed(3)}rad）`);
  run(p, 1.0);
  ok(p.pitch > 1.0,
    `離しても真上付近に留まる（${p.pitch.toFixed(2)}rad。地面まで落ちない）`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
