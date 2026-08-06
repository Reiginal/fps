// 倒れている間のカメラの検査。
//
// なぜ要るか: 遊んで「倒された瞬間に視点が固まって、生き返るまで
// 同じ方向を向いたまま」なのが物足りない、という話から入れた見回し。
//
// ここで一番怖いのは**見回しがサーバーへ漏れること**。
// 倒れている間に player.yaw を動かすと、それは毎刻みサーバーへ送られるので、
// 他の人の画面では**倒れているはずの体が首だけ回り続ける。**
// 自分の画面では完璧に見えるのに、他人の画面だけおかしい——
// 席の不具合と同じで、作った本人からは一番見えない壊れ方になる。
//
// 倒れ込みの曲線そのものも、これまで一度も測られていなかった。
// main.js の中に直書きしてあり、**main.js は読み込むとゲームが丸ごと立ち上がる**ので
// ブラウザ無しでは動かせなかった。計算を src/core/deathcam.js へ出したので、
// ここからは本物を動かして測れる。
//
//   node tools/check-deathcam.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import * as THREE from 'three';

const {
  DEATH_FALL_S, DEATH_PITCH_LIMIT, DEATH_EYE_H,
  startLook, turnLook, fallCurve, applyDeath,
} = await import('../src/core/deathcam.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const STAND_H = 1.74;   // protocol.js の HITBOX.STAND_H と同じ立ち姿

/** _applyCamera() が置いたあとの状態を作る。倒れ込みはこの上へ乗る */
const freshCam = (yaw = 0, pitch = 0) => {
  const c = new THREE.PerspectiveCamera(75, 1.6, 0.05, 900);
  c.rotation.order = 'YXZ';
  c.position.set(0, STAND_H - 0.16, 0);
  c.rotation.set(pitch, yaw, 0);
  return c;
};

console.log('\n[1] 倒れ込みの進み具合');
{
  const a = fallCurve(0);
  ok(a.drop === 0 && a.roll === 0, `倒れた瞬間は動かない (drop ${a.drop} / roll ${a.roll})`);

  const z = fallCurve(DEATH_FALL_S);
  ok(Math.abs(z.drop - 1) < 1e-9 && Math.abs(z.roll - 1) < 1e-9,
    `${DEATH_FALL_S}秒で倒れ切る (drop ${z.drop} / roll ${z.roll})`);

  // 行き過ぎない。時計が進みすぎても地面へめり込まない
  const over = fallCurve(DEATH_FALL_S * 3);
  ok(over.drop === 1 && over.roll === 1, '時間を過ぎても1で止まる');
  ok(fallCurve(-1).k === 0, 'マイナスの時間でも0で止まる');

  // 単調に増える。途中で戻ると「倒れかけて起き上がる」動きになる
  let mono = true;
  let prevD = -1, prevR = -1;
  for (let i = 0; i <= 40; i++) {
    const r = fallCurve((DEATH_FALL_S * i) / 40);
    if (r.drop < prevD - 1e-12 || r.roll < prevR - 1e-12) mono = false;
    prevD = r.drop; prevR = r.roll;
  }
  ok(mono, '途中で戻らない（倒れかけて起き上がらない）');

  // 落ちるほうが先に効く。同じ曲線だと板が倒れるようにしか見えない
  const h = fallCurve(DEATH_FALL_S * 0.5);
  ok(h.drop > h.roll, `半分の時点で落ちるほうが先行 (drop ${h.drop.toFixed(3)} > roll ${h.roll.toFixed(3)})`);
}

console.log('\n[2] 目の高さが地面まで落ちる');
{
  const cam = freshCam();
  const before = cam.position.y;
  applyDeath(cam, { t: DEATH_FALL_S, height: STAND_H });
  const dropped = before - cam.position.y;
  ok(Math.abs(dropped - (STAND_H - DEATH_EYE_H)) < 1e-9,
    `${(dropped * 100).toFixed(0)}cm落ちた（立ち姿${(STAND_H * 100).toFixed(0)}cm→転がった頭${(DEATH_EYE_H * 100).toFixed(0)}cm）`);
  ok(cam.position.y > 0, `地面より下へ行かない (${cam.position.y.toFixed(3)}m)`);

  const still = freshCam();
  applyDeath(still, { t: 0, height: STAND_H });
  ok(Math.abs(still.position.y - (STAND_H - 0.16)) < 1e-9, '倒れた瞬間は目の高さのまま');
}

console.log('\n[3] 体が横へ倒れる');
{
  const cam = freshCam();
  applyDeath(cam, { t: DEATH_FALL_S, height: STAND_H });
  ok(Math.abs(cam.rotation.z) > 1.0, `横倒しになる (z ${cam.rotation.z.toFixed(2)}ラジアン)`);
  // 顔が上を向く。倒れた先に空が見えると「自分が倒れた」が伝わる
  ok(cam.rotation.x < 0, `顔が上を向く (x ${cam.rotation.x.toFixed(2)})`);
}

console.log('\n[4] 倒れている間に見回せる');
{
  const look = startLook(0.5, 0.1);
  ok(look.yaw === 0.5 && Math.abs(look.pitch - 0.1) < 1e-9, '倒れた瞬間の向きから始まる');

  turnLook(look, 1.0, 0);
  ok(Math.abs(look.yaw - 1.5) < 1e-9, `左右に振れる (${look.yaw})`);

  // 左右は一周できる。倒れて後ろを見たい場面があるので止めない
  const spin = startLook(0, 0);
  for (let i = 0; i < 100; i++) turnLook(spin, 0.1, 0);
  ok(Math.abs(spin.yaw - 10) < 1e-9, `何周でも回せる (${spin.yaw.toFixed(1)}ラジアン)`);

  // 上下の限界そのものが妥当か。**この節の他の項目は
  // DEATH_PITCH_LIMIT と自分を突き合わせているだけなので、
  // 0にされても1.55にされても気づかない。** そこは値で押さえる。
  // 0に近いと見上げられず、立っている時と同じ1.55だと
  // 地面に転がっているのに真下まで見えて姿勢と合わない
  ok(DEATH_PITCH_LIMIT > 0.6 && DEATH_PITCH_LIMIT < 1.4,
    `上下の限界が妥当 (${DEATH_PITCH_LIMIT}ラジアン ＝ 約${Math.round((DEATH_PITCH_LIMIT * 180) / Math.PI)}度)`);

  // 上下は狭める。地面に転がっているので真下を向いても床しか無い
  const up = startLook(0, 0);
  for (let i = 0; i < 100; i++) turnLook(up, 0, 0.1);
  ok(Math.abs(up.pitch - DEATH_PITCH_LIMIT) < 1e-9, `上は${DEATH_PITCH_LIMIT}で止まる (${up.pitch})`);
  const dn = startLook(0, 0);
  for (let i = 0; i < 100; i++) turnLook(dn, 0, -0.1);
  ok(Math.abs(dn.pitch + DEATH_PITCH_LIMIT) < 1e-9, `下も-${DEATH_PITCH_LIMIT}で止まる (${dn.pitch})`);

  // 倒れた瞬間に上を向いていても、その場で範囲へ収める
  ok(Math.abs(startLook(0, 1.5).pitch - DEATH_PITCH_LIMIT) < 1e-9, '始まりの向きも範囲へ収める');

  // 見回した向きがカメラに乗る
  const cam = freshCam(0, 0);
  applyDeath(cam, { t: 0, height: STAND_H, look: startLook(0, 0) });
  const base = cam.rotation.y;
  const cam2 = freshCam(0, 0);
  applyDeath(cam2, { t: 0, height: STAND_H, look: turnLook(startLook(0, 0), 0.8, 0) });
  ok(Math.abs(cam2.rotation.y - base - 0.8) < 1e-9, `振ったぶんカメラが回る (${cam2.rotation.y.toFixed(2)})`);
}

console.log('\n[5] 見回さない時は今まで通り');
// 1人用は倒れたら結果画面へ移るので見回しを持たない。
// look を渡さなかった時に向きが書き換わると、1人用の倒れ込みが変わってしまう
{
  const cam = freshCam(1.234, 0.2);
  applyDeath(cam, { t: DEATH_FALL_S, height: STAND_H });
  ok(Math.abs(cam.rotation.y - 1.234) < 1e-9, `向きは元のまま (${cam.rotation.y})`);
}

console.log('\n[6] 見回しがサーバーへ漏れていない');
// **ここが本題。** 倒れている間に player.yaw / player.pitch を動かすと、
// それは毎刻みサーバーへ送られて、他の人の画面では
// 倒れているはずの体が首だけ回り続ける。
// 自分の画面では完璧に見えるので、作った本人からは一番見えない壊れ方になる
{
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

  // 「倒れている間」の分岐を切り出す
  const at = src.indexOf('} else if (this.deathLook) {');
  ok(at > 0, '倒れている間の分岐がある');
  if (at > 0) {
    let depth = 0, end = at;
    for (let i = src.indexOf('{', at); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = src.slice(at, end + 1);
    ok(!/\bplayer\.yaw\s*[+-]?=/.test(body),
      'その中で player.yaw を動かしていない（動かすと他人の画面で首が回る）');
    ok(!/\bplayer\.pitch\s*[+-]?=/.test(body),
      'その中で player.pitch を動かしていない');
    ok(/turnLook\(/.test(body), '見回しは turnLook を通している');
  }

  // 生き返った時に見回しを畳んでいるか。
  // 落とし忘れると、湧いた後もカメラがここの値で上書きされ続けて、
  // 動いているのに景色が回らない状態になる
  ok(/if \(!down\) \{[^}]*this\.deathLook = null;/.test(src),
    '生き返ったら見回しを畳んでいる');

  // 計算が main.js へ直書きで戻っていないか
  ok(/applyDeath\(/.test(src), 'main.js は deathcam.js の applyDeath を使っている');
  ok(!/const drop = 1 - \(1 - k\) \*\* 3/.test(src), '倒れ込みの式が main.js へ戻っていない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
