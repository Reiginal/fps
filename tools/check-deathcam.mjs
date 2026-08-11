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

  /* **_deathFall を呼ぶ所は、必ず直前で _applyCamera() を呼んでいること。**
     applyDeath は「姿勢を決めた後に倒れ込みぶんを足す(+=)」約束なので、
     姿勢を決めずに回すと傾きが毎フレーム積み上がる。
     実際に、倒れ込みを playing でないフレームへ移した時にこれを忘れて、
     **カメラがぐるぐる回り続けた**（2026-08-08、遊んだ本人に「キモい」と言われた） */
  /* コメントを外してから見る。**外さないと素通りする。**
     このrepoは「なぜ」を長いコメントで残す作法なので、
     生のソースで「直前○字」を見ると、その窓がコメントで埋まって
     隣の無関係な_applyCameraを拾ってしまう（実際に拾って、
     わざと壊しても落ちない検査になっていた） */
  const bare = src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // ブロックコメント
    .replace(/^\s*\/\/.*$/mg, '');          // 行コメント
  const calls = [...bare.matchAll(/this\._deathFall\(dt\)/g)];
  ok(calls.length >= 2, `_deathFall を呼ぶ所が ${calls.length} 箇所ある`);
  for (const m of calls) {
    // コメントを外した後の直前120字。同じ流れの中で呼ばれているかだけを見る
    const before = bare.slice(Math.max(0, m.index - 120), m.index);
    ok(/_applyCamera\(\);/.test(before),
      `_deathFall の直前で _applyCamera() を呼んでいる（${m.index}文字目）`);
  }
}

console.log('\n[倒れ込みは何フレーム回しても暴れない]');
{
  /* 上のソース突き合わせだけだと「呼び順が合っているか」しか見られない。
     実際にカメラを何フレームも回して、傾きが決まった値へ収束することを測る。
     倒れ切った後(t>=DEATH_FALL_S)は、何フレーム回しても同じ姿勢のままが正しい */
  const cam = {
    position: { x: 0, y: 1.7, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
  };
  // 本物と同じ順番: 毎フレーム「姿勢を決める→倒れ込みを足す」
  const frame = (t) => {
    cam.position.y = 1.7;      // _applyCameraがやること（目の高さを入れ直す）
    cam.rotation.x = 0; cam.rotation.y = 0; cam.rotation.z = 0;
    applyDeath(cam, { t, height: 1.7 });
  };
  frame(DEATH_FALL_S);
  const settled = { z: cam.rotation.z, x: cam.rotation.x, y: cam.position.y };
  for (let i = 0; i < 600; i++) frame(DEATH_FALL_S);   // 10秒ぶん回す
  ok(Math.abs(cam.rotation.z - settled.z) < 1e-9,
    `10秒回しても傾きが変わらない（${settled.z.toFixed(3)} → ${cam.rotation.z.toFixed(3)}）`);
  ok(Math.abs(cam.position.y - settled.y) < 1e-9,
    `目の高さも変わらない（${settled.y.toFixed(3)} → ${cam.position.y.toFixed(3)}）`);
  ok(cam.rotation.z < Math.PI, `傾きは半回転より小さい（${cam.rotation.z.toFixed(2)}rad＝横倒しであって回転ではない）`);

  // 姿勢を決め直さずに回すと積み上がること自体は確かめておく。
  // 「+=で足す作りだから、決め直しとセットで呼ぶ必要がある」の裏付け
  const bad2 = { position: { y: 1.7 }, rotation: { x: 0, y: 0, z: 0 } };
  for (let i = 0; i < 10; i++) applyDeath(bad2, { t: DEATH_FALL_S, height: 1.7 });
  ok(bad2.rotation.z > settled.z * 5,
    '姿勢を決め直さずに回すと傾きが積み上がる（だから直前の_applyCameraが要る）');
}

console.log('\n[観戦カメラ] 生きている人の目線に入る');
{
  const { spectatePose, spectateEyeH, smoothEyeH, SPEC_EYE_STAND, SPEC_EYE_CROUCH, SPEC_EYE_DROP } =
    await import('../src/core/deathcam.js');
  const { S, HITBOX } = await import('../src/net/protocol.js');

  // 北(-Z)を向いて立っている人。yaw=0がその向き（player._applyCameraと同じ約束）
  const t = { x: 3, y: 1, z: -2, yaw: 0.4, pitch: 0.2, state: 0 };
  const p = spectatePose(t);
  ok(Math.abs(p.rot.y - t.yaw) < 1e-9, '見ている人と同じ方を向く');
  ok(Math.abs(p.rot.x - t.pitch) < 1e-9, '上下の向きもそのまま借りる（勝手に見下ろさない）');
  /* **本人の目線なので、横にも後ろにもずれない。**
     ここがずれていると肩越し（俯瞰に見える）へ戻ったということ */
  ok(Math.abs(p.pos.x - t.x) < 1e-9 && Math.abs(p.pos.z - t.z) < 1e-9,
    '足元と同じ位置に立つ（後ろへ引かない）');
  ok(Math.abs(p.pos.y - (t.y + SPEC_EYE_STAND)) < 1e-9,
    `目の高さは足元から${SPEC_EYE_STAND}m（y=${p.pos.y.toFixed(2)}）`);

  /* **目の高さの出し方が本人と同じか。** ここが違うと、生き返った瞬間に視点が跳ねる。
     player._applyCamera() は feetY + height - 0.16 で、heightは判定と同じ1.74/1.06 */
  const psrc = readFileSync(new URL('../src/player/player.js', import.meta.url), 'utf8');
  ok(/feetY \+ this\.height - 0\.16/.test(psrc),
    'player側の目の高さは feetY + height - 0.16 のまま');
  ok(Math.abs(SPEC_EYE_DROP - 0.16) < 1e-9, `観戦側も同じ0.16を引いている（${SPEC_EYE_DROP}）`);
  ok(Math.abs(SPEC_EYE_STAND - (HITBOX.STAND_H - 0.16)) < 1e-9, '立ちの目の高さが判定の身長と揃っている');
  ok(Math.abs(SPEC_EYE_CROUCH - (HITBOX.CROUCH_H - 0.16)) < 1e-9, 'しゃがみも揃っている');

  // しゃがんでいる人の目線は低い
  ok(spectateEyeH(S.CROUCH) < spectateEyeH(0), 'しゃがんでいる相手の目線は低くなる');
  const crouched = spectatePose({ ...t, state: S.CROUCH });
  ok(crouched.pos.y < p.pos.y - 0.5, `しゃがみで視点が下がる（${p.pos.y.toFixed(2)} → ${crouched.pos.y.toFixed(2)}）`);
  // 高さを渡したらそちらが勝つ（滑らかに寄せた値を入れるため）
  ok(Math.abs(spectatePose(t, 1.0).pos.y - (t.y + 1.0)) < 1e-9, '渡した目の高さが優先される');

  /* しゃがみの上下を均す所。スナップショットのしゃがみは0か1しか無いので、
     ここが効いていないと相手がしゃがんだ瞬間に68cm落ちる */
  ok(smoothEyeH(null, 1.58, 1 / 60) === 1.58, '見始めは寄せずにその高さから始める');
  const step = smoothEyeH(SPEC_EYE_STAND, SPEC_EYE_CROUCH, 1 / 60);
  ok(step < SPEC_EYE_STAND && step > SPEC_EYE_CROUCH,
    `1フレームでは途中までしか下がらない（${SPEC_EYE_STAND.toFixed(2)} → ${step.toFixed(2)}）`);
  ok(SPEC_EYE_STAND - step < 0.30,
    `1フレームの落ち幅は30cm未満（${(SPEC_EYE_STAND - step).toFixed(2)}m）`);
  // 何フレームか回せば追いつく。行き過ぎない（越えると視点が上下に揺れる）
  let h = SPEC_EYE_STAND;
  for (let i = 0; i < 60; i++) h = smoothEyeH(h, SPEC_EYE_CROUCH, 1 / 60);
  ok(Math.abs(h - SPEC_EYE_CROUCH) < 0.01, `1秒あれば追いつく（${h.toFixed(3)}）`);
  ok(h >= SPEC_EYE_CROUCH - 1e-9, '行き過ぎない（下限を割らない）');
  ok(smoothEyeH(1.0, 2.0, 10) <= 2.0, 'フレームが飛んでも越えない');
}

console.log('\n[観戦カメラ] 繋ぎ込み（main.js / remote.js）');
{
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  // 倒れ込みを見せ終わってから移る（撃たれた瞬間に視点が飛ぶと何が起きたか分からない）
  ok(/deathT >= DEATH_FALL_S[\s\S]{0,80}?_spectate\(/.test(src),
    '倒れ込みが終わってから観戦へ移る');
  // 死んでいる人は候補に入れない
  ok(/_spectate\(states, input, dt\) \{[\s\S]{0,600}?st\.state & S\.DEAD\)+ continue;/.test(src),
    '倒れている人は観戦の相手にしない');
  // 自分自身も候補から外す（自分の死体の目線に入っても意味が無い）
  ok(/_spectate\(states, input, dt\) \{[\s\S]{0,600}?st\.id === this\.net\.id/.test(src),
    '自分は観戦の相手にしない');
  /* **目線を借りる人の体は描かない。** カメラがその人の頭の中に入るので、
     消し忘れると腕と銃で画面が埋まる */
  ok(/setHidden\(target\.id\)/.test(src), '見ている人の体を消している');
  // 消した体を出し直すのを1箇所にまとめてある（呼び忘れると人が消えたままになる）
  ok(/_forgetSpectate\(\) \{[\s\S]{0,300}?setHidden\(null\)[\s\S]{0,120}?spectating\(null\)/.test(src),
    '観戦をやめる時に体を出し直して札も畳む');
  ok(/player\.alive\) \{[\s\S]{0,200}?_forgetSpectate\(\)/.test(src),
    '生き返ったら自分の視点へ戻す');
  ok(/setMode\('solo'\);[\s\S]{0,300}?_forgetSpectate\(\)/.test(src),
    '試合を抜けたら観戦を畳む');
  // 観戦をやめる時に体を出し直すのは、相手を描くsyncより前でないと1フレーム遅れる
  ok(src.indexOf('_spectate(states, input, dt)') > 0
    && /_spectate\(states, input, dt\);[\s\S]{0,600}?remotes\.sync\(/.test(src),
    '体を消す指示を出してから相手を描く');
  // クリックは押した瞬間だけ拾う（押しっぱなしで相手が回り続けない）
  ok(/input\?\.clicked\(0\)/.test(src), '切り替えは押した瞬間だけ拾う');
  /* **見ている人の体力を出す。** 自分の体力の棒は倒れている間0のまま消えているので、
     出さないと観戦中は画面のどこにも体力が無い。遊んで
     「デスカメラのときに、そいつの体力とかもない」と言われた所 */
  ok(/spectating\([\s\S]{0,160}?target\.hp/.test(src), '観戦の札へ相手の体力を渡している');
  const hsrc = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
  ok(/specHp/.test(hsrc), 'HUDが体力の置き場を持っている');
  // 毎フレーム呼ばれるので、値が変わった時だけ書く（同じ値で書き直さない）
  ok(/_specKey = key;/.test(hsrc) && /\$\{shown\}/.test(hsrc),
    '同じ値なら書き込まない（体力も鍵に入っている）');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/id="specHp"/.test(html), '体力のDOMがある');
  ok(/#specHp\.low/.test(html), '残りが少ない時に色が変わる');
  /* **倒れている間は手元の武器を描かない。**
     手元の武器は自分専用の別の場面(viewScene)に浮かんでいて、カメラがどこへ
     行こうが画面の手前に付いてくる。だから観戦中も自分の武器が写り続けて、
     **見ている相手が自分と同じ武器を持っているように見える**
     （遊んで「デスカメラの時に自分と同じ武器になってる気がする」と言われた）。
     ガンゲームだと相手が今どの段にいるのかが読めなくなる */
  ok(/viewScene\.visible = !down \|\| this\._specId != null/.test(src),
    '自分の死体を映している間だけ畳む（観戦中は畳まない）');
  ok(/_deathFall\(dt\) \{[\s\S]{0,1100}?viewScene\.visible/.test(src),
    '倒れ込みの所で畳んでいる（1人用と対戦の両方が通る道）');
  /* **畳んだままだと今度は手元が空になる。**
     体を消して武器も出さないと「味方の武器が見えない」になり、
     出さないままにすると自分の武器が写って「相手が自分と同じ武器」に見える。
     観戦中はその人の武器を出すのが正解（遊んで両方言われた） */
  ok(/showSpectated\(target\.weapon\)/.test(src), '観戦中は見ている人の武器を手元へ出す');
  ok(/_forgetSpectate\(\) \{[\s\S]{0,400}?showSpectated\(null\)/.test(src),
    '観戦をやめたら自分の武器へ戻す');
  const wsrc = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  ok(/showSpectated\(i\) \{/.test(wsrc), '武器側に出し口がある');
  // 毎フレーム呼ばれる所なので、変わった時しか触らない
  ok(/if \(at === this\._specWeapon\) return;/.test(wsrc), '同じ武器なら触らない');
  // 肩越しの名残（壁当たりのレイ）が残っていないか
  ok(!/_specRay/.test(src), '肩越しの時の壁当たりのレイは消えている');

  const rsrc = readFileSync(new URL('../src/net/remote.js', import.meta.url), 'utf8');
  /* 毎フレーム消し直す。_apply側が生き返りでvisibleを立て直すので、
     1回消すだけだと相手が湧いた瞬間に体が生えてくる */
  ok(/st\.id === this\._hiddenId\) this\._setBodyVisible\(slot, false\)/.test(rsrc),
    '毎フレーム消し直している（生き返りで立て直されるため）');
  // 変わった時しか触らない（毎フレーム呼ばれる所なので）
  ok(/setHidden\(id = null\) \{[\s\S]{0,200}?if \(next === this\._hiddenId\) return;/.test(rsrc),
    '相手が変わった時しかsceneを触らない');
  // 沈み切った死体を出し直さない
  ok(/_setBodyVisible\(slot, on\) \{[\s\S]{0,400}?CORPSE_HOLD_S \+ CORPSE_SINK_S\) return;/.test(rsrc),
    '沈み切った死体は出し直さない');
  // 試合をまたいで持ち越さない
  ok(/slots\.clear\(\);[\s\S]{0,200}?_hiddenId = null/.test(rsrc),
    '試合が終わったら観戦の相手を忘れる');
}

console.log('\n[観戦の見た目] 相手の武器に自分のスキンが乗っていないか');
{
  /* 2026-08-11に足した。**「デスカメラになった時に、俺と同じスキンで表示された」**
     と言われた所。観戦は自分の武器の模型をそのまま出していたので、
     金色のライフルを着けていると**相手も金色のライフルで撃ってきたことになる。**

     直し方は「素の姿で組んだ模型を別に持って、観戦中はそちらを出す」。
     **相手の本当のスキンは出していない**（スキンは電文に載っていないので、
     手元にそもそも届いていない）。相手の3人称も兵士モデルの銃なので、
     標準で出すのが他の画面と揃った状態。

     見るのは「自分のスキンが漏れていないこと」だけ。
     そこが本題で、何を出すかはその次の話 */
  const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');
  const { setAccount } = await import('../src/player/skins.js');

  // 自分は形と色の両方を着けている状態にする。**形の方が漏れると分かりやすい**
  setAccount({
    owned: ['rifle:gold', 'knife:katana'],
    equipped: { rifle: 'gold', knife: 'katana' },
  });
  // 場面は後で物の数を数えるので、変数に持っておく
  const scene = new THREE.Scene();
  const ws = new WeaponSystem(scene,
    new THREE.PerspectiveCamera(75, 1.6, 0.05, 900),
    new THREE.PerspectiveCamera(55, 1.6, 0.002, 12), new THREE.Scene());
  ws.carry = ws.weapons.map((_, i) => i);
  ws.refreshSkins();

  const knifeAt = WEAPONS.findIndex((x) => x.id === 'knife');
  const rifleAt = WEAPONS.findIndex((x) => x.id === 'rifle');
  // 自分の方には着いていること（着いていなければ、この検査は何も見ていない）
  ok(ws.weapons[knifeAt].shapeId === 'katana', '自分のナイフには刀が着いている（前提）');

  const shownOf = () => {
    const out = [];
    for (const w of ws.weapons) if (w.model.visible) out.push({ w, plain: !!w.plain });
    for (const w of ws._plain.values()) if (w.model.visible) out.push({ w, plain: !!w.plain });
    return out;
  };

  ws.showSpectated(knifeAt);
  let shown = shownOf();
  ok(shown.length === 1, `観戦中に出ている武器は1つ（${shown.length}個）`);
  ok(shown.length === 1 && shown[0].plain, '観戦で出しているのは素の姿の模型');
  // **ここが本題。** 自分の刀が出ていたら元の不具合
  ok(shown.length === 1 && shown[0].w.shapeId !== 'katana',
    '相手のナイフに自分の刀が乗っていない');

  ws.showSpectated(rifleAt);
  shown = shownOf();
  ok(shown.length === 1 && shown[0].plain, 'ライフルも素の姿で出る');
  // 素の模型は覚えておくこと。倒れるたびに組み直すと画面が詰まる
  ok(ws._plain.size === 2, `素の模型を覚えている（${ws._plain.size}本）`);
  ws.showSpectated(rifleAt);
  ok(ws._plain.size === 2, '同じ武器をもう一度観戦しても組み直さない');

  /* **場面に残さないこと。** 2026-08-11に測って足した所。
     隠すだけにしていたら、武器を替えながら何度か倒されるうちに
     場面の物が289→560個（メッシュ+206個）へ増えた。
     **隠れていても行列の計算は毎フレーム走る**
     （three.jsのupdateMatrixWorldはvisibleを見ずに子を全部辿る）。

     実測0.025→0.046msで熱の原因になる量ではないが、
     このrepoの決めごとが「描く物を増やしていないか」なので、増えたまま置かない。
     **覚えている物は捨てない**（組み直しは16〜40msかかる）ので、
     見るのは「場面の物の数が戻ること」と「覚えている数は減らないこと」の2つ */
  {
    const count = () => { let c = 0; scene.traverse(() => c++); return c; };
    // まず素の状態に戻して数える
    ws.showSpectated(null);
    const base = count();
    for (let i = 0; i < ws.weapons.length; i++) ws.showSpectated(i);
    const during = count();
    ok(during > base, `観戦中は場面に出ている（${base} → ${during}）`);
    ws.showSpectated(null);
    ok(count() === base, `観戦を抜けたら場面の物の数が戻る（${count()} / 元は${base}）`);
    ok(ws._plain.size === ws.weapons.length,
      `覚えている素の模型は捨てていない（${ws._plain.size}本）`);
    // もう一度観戦しても組み直さず、その時だけ場面へ戻る
    const kept = ws._plain.size;
    ws.showSpectated(0);
    ok(ws._plain.size === kept, 'もう一度観戦しても組み直さない');
    ok(count() > base, 'その時だけ場面に戻る');
  }

  // 自分へ戻ったら自分のスキンで出ること
  ws.showSpectated(null);
  shown = shownOf();
  ok(shown.length === 1 && !shown[0].plain, '観戦を抜けたら自分の模型へ戻る');
  ok(shown.length === 1 && shown[0].w.def.id === WEAPONS[ws.index].id,
    '戻る先は今持っている武器');

  setAccount({ owned: [], equipped: {} });
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
