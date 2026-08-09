// 武器まわりの検査。ブラウザを使わずNodeだけで走る。
//
// なぜ要るか: この repo の不具合は「ターミナルで見える層」と
// 「画面を見ないと分からない層」にはっきり割れる。前者は構文チェックと
// サーバー側のテストで落ちるが、後者は素通りしていた。
// 実際に素通りした例:
//   ・ナイフを振ると銃口が光って曳光弾が飛ぶ（銃の処理を流用したため）
//   ・近接武器の弾数欄に9999と出る
//   ・銃身の向きと弾の飛ぶ向きが7度ずれている
// どれも画面を見れば一瞬で分かるが、コードを読んでいるだけでは見えない。
//
// ヘッドレスのブラウザで開く案は実測して捨てた。GPUが無いと
// 手続き的なテクスチャ生成とPMREMの焼き込みが終わらず、3分でも起動しない。
// server/dom-stub.js の上なら武器一式が1秒で組めるので、こちらを使う。
//
//   node tools/check-weapons.mjs
import { readdirSync } from 'node:fs';
import '../server/dom-stub.js';
import * as THREE from 'three';

const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');

// 銃身の向きと弾の向きの許容ズレ(度)。
// 弾は必ずクロスヘアへ真っ直ぐ飛ぶので、銃がそこから離れて見えるほど
// 「どこを狙えばいいのか」が画から読めなくなる。20m先で35cmが1度ぶん
const AIM_TOLERANCE_DEG = 1.2;

let bad = 0;
const ok = (c, msg) => {
  console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`);
  if (!c) bad++;
};

const cam = new THREE.PerspectiveCamera(75, 1.6, 0.05, 900);
const vcam = new THREE.PerspectiveCamera(55, 1.6, 0.002, 12);
const ws = new WeaponSystem(new THREE.Scene(), cam, vcam, new THREE.Scene());
// **ここでは表にある武器を全部見る。**
// 既定の持ち物(protocol.jsのLOADOUT_IDS)にはショットガンが入っていないが、
// 持って出ないだけで表からは消していない（ガンゲームで配る／将来の武器選択で選ぶ）。
// 持ち物のままだと switchTo が断って、持って出ない武器を1つも測れなくなる。
// 「誰が何を持てるか」は tools/check-loadout.mjs が別に見る
ws.carry = ws.weapons.map((_, i) => i);
cam.updateMatrixWorld(true);

/* ------------------------------------------------ モデルが組めているか */

console.log('\n[1] 各武器のモデル');
for (const w of ws.weapons) {
  const p = w.parts || {};
  // この3つは武器側が必ず読む。欠けると持ち替えた瞬間に落ちる
  const has = !!p.muzzle && !!p.eject && !!p.sight;
  ok(has, `${w.def.name} … muzzle/eject/sight が揃っている`);
}

/* ---------------------------------------------- 弾数欄に何が出るか */

console.log('\n[2] 弾数の表示');
for (const w of ws.weapons) {
  // main.js が hud.ammo() へ渡すのと同じ判定
  const shown = w.def.melee ? '—' : w.ammo;
  ok(
    !w.def.melee || shown === '—',
    `${w.def.name} … 画面に出る値 ${shown}`,
  );
}

/* -------------------------------------- 銃身の向きと弾の向きのズレ */

console.log('\n[3] 銃身の向きと弾の向き');
const _q = new THREE.Quaternion();
for (const w of ws.weapons) {
  if (w.def.melee) continue;
  w.model.position.copy(w.hipPos);
  w.model.rotation.copy(w.hipRot);
  w.model.updateMatrixWorld(true);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(w.model.getWorldQuaternion(_q));
  const deg = THREE.MathUtils.radToDeg(fwd.angleTo(new THREE.Vector3(0, 0, -1)));
  ok(
    deg <= AIM_TOLERANCE_DEG,
    `${w.def.name} … ズレ ${deg.toFixed(2)}度 (許容 ${AIM_TOLERANCE_DEG}度、20m先で${(Math.tan(THREE.MathUtils.degToRad(deg)) * 20 * 100).toFixed(0)}cm)`,
  );
}

/* ------------------------------------ 近接で撃つ処理が走っていないか */

/* -------------------------------------------- 画面から見切れていないか */

console.log('\n[3.5] 構えが画面に収まっているか');
// ビューモデルはviewCameraで写る。腰だめの姿勢に置いた時の
// 各頂点を投影して、正規化座標(-1..1)の外へ出ていないかを見る。
// 出ていると画面の縁で切れて「見切れている」状態になる。
//
// **測るのは「武器そのもの」で、手と腕は外す。**
// 腕は画面の下隅から入るので枠外に出て当たり前で、そこを混ぜると
// 「枠外の割合」が武器の見え方ではなく**手の頂点数**で決まってしまう。
// ナイフは刃が152頂点に対して手と腕が2639頂点あり、
// 腕をどう振っても割合が53.5%から動かなかった（＝何も測れていなかった）。
//
// あわせて「一番手前の頂点が目から何cm離れているか」も見る。
// カメラの手前へ回った面は画面上で無限に広がるので、
// **形が良くても位置がおかしいと画面が破裂する。**
// 包帯の手が「でかいしグロい」と言われたのがまさにこれで、
// ナイフも実測すると刃と腕が目の7cm後ろまで突き抜けていた
vcam.updateProjectionMatrix();
vcam.updateMatrixWorld(true);
const _v = new THREE.Vector3();
for (const w of ws.weapons) {
  w.model.position.copy(w.hipPos);
  w.model.rotation.copy(w.hipRot);
  w.model.scale.setScalar(w.def.view.scale);

  // **持っていない武器は model.visible が false になっている。**
  // 見えている物だけ数える作りなので、そのまま測ると持っている1本以外は
  // 頂点0個になり、下の pct が 0% と出て**そのまま通っていた**。
  // 「画面外0.0%」と書いてあるのに何も測っていない、という一番たちの悪い形で、
  // 実際ショットガン・ナイフ・手榴弾の3本は長い間ここを素通りしていた
  // （コメントに残っている「ショットガン24.7%」は測れていた頃の値）。
  // 測る間だけ持ち上げて、終わったら戻す
  const wasVisible = w.model.visible;
  w.model.visible = true;
  w.model.updateMatrixWorld(true);

  let out = 0, total = 0, nearest = 9, handSeen = 0;
  w.model.traverse((m) => {
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    // 部品ごとの非表示は残す。近接や投擲は使わない左手を画面外へ
    // 逃がしてあるので、そのまま数えると常に「見切れている」と出る
    let vis = m.visible;
    for (let o = m.parent; o && vis; o = o.parent) vis = o.visible;
    if (!vis) return;
    // 手と腕か（buildHandが付ける印を先祖まで辿る）
    let isHand = false;
    for (let o = m; o && !isHand; o = o.parent) if (o.userData?.isHand) isHand = true;

    const pos = m.geometry.attributes.position;
    // 全頂点は多いので間引く。形の端は拾える
    for (let i = 0; i < pos.count; i += 7) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      // 近さは手も含めて見る。腕が目を突き抜けるのも同じくらい困る
      nearest = Math.min(nearest, -_v.z);
      if (isHand) { handSeen++; continue; }
      _v.project(vcam);
      total++;
      if (Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1) out++;
    }
  });

  w.model.visible = wasVisible;
  w.model.updateMatrixWorld(true);

  // **何も測れていない時は落とす。** これが無いと、上の visible の件のように
  // 「measure した気になっているだけ」の状態が緑のまま通り続ける
  ok(total > 0 && handSeen > 0,
    `${w.def.name} … 本体${total}頂点・手${handSeen}頂点を測った`);

  // 目の手前へ回った頂点があると、その面は画面上で無限に広がる。
  // ライフル10.3cm・ショットガン12.1cmが「普通に構えている」時の値なので、
  // その半分を割ったら構えの位置がおかしいとみなす。
  // **包帯の手が「でかいしグロい」と言われたのがこれで、ナイフも実測すると
  // 刃と腕が目の7cm後ろまで突き抜けていた**（枠外98.9%）
  ok(nearest > 0.05,
    `${w.def.name} … 一番手前の頂点が目から ${(nearest * 100).toFixed(1)}cm`
    + (nearest > 0.05 ? '' : '  ← 近すぎる（画面で破裂する）'));

  const pct = total ? (out / total) * 100 : 100;
  // 銃は手前や下が少し切れるのが普通で、手を除いて実測すると
  // ライフル5.5%・ショットガン9.3%。これは遊んでいて気にならない範囲。
  // 2割を超えると「銃口や刃先が枠の外にある」レベルになるのでそこを線にする
  ok(pct < 20, `${w.def.name} … 武器本体で画面外へ出ている頂点 ${pct.toFixed(1)}%`);
}

/* -------------------------------------- 構えが武器ごとに違うか */

console.log('\n[3.55] 構えが武器ごとに違う');
// 遊んで「ナイフも手榴弾もライフルの構えになっている」と言われた所。
//
// 原因は def.view の値ではなく**組み立て側**だった。
// buildKnife/buildGrenade が右手を作る時、腕の入る向きを
// ライフルと同じ [0.38, -0.62, 0.92] で直書きしていて、
// 武器ごとに変える手段がそもそも無かった（def.view を渡していなかった）。
// Zが大きいぶん前腕が「手から目へ向かって」伸びるので、
// 短い武器では腕が目を突き抜けて画面が破裂する。
//
// ここで見るのは「4つが同じ値に戻っていないか」。
// 値を1箇所からコピーして増やすのが一番ありがちな戻り方なので、そこを塞ぐ
{
  const byId = Object.fromEntries(WEAPONS.map((d) => [d.id, d]));
  const rifleArm = [0.38, -0.62, 0.92];   // 既定（銃の腕）

  for (const id of ['knife', 'nade']) {
    const d = byId[id];
    const arm = d.view.grip?.armDir;
    ok(!!arm, `${d.name} … 自分の腕の向きを持っている（grip.armDir）`);
    if (!arm) continue;
    // 銃の腕と同じなら、それは「ライフルの構え」に戻っている
    const same = arm.every((v, i) => Math.abs(v - rifleArm[i]) < 1e-6);
    ok(!same, `${d.name} … 腕の向きが銃と違う [${arm.join(', ')}]`);
    // Zが大きいと前腕が目のほうへ戻ってくる。銃(0.92)の半分を上限にする
    ok(arm[2] < 0.46, `${d.name} … 前腕が目のほうへ戻っていない (z=${arm[2]})`);
  }

  // 4つの構えの向きが全部同じ、という状態も塞ぐ
  const rots = WEAPONS.map((d) => d.view.hipRot.join(','));
  ok(new Set(rots).size === WEAPONS.length,
    `4本とも構えの向きが違う（${new Set(rots).size}種類）`);
}

/* ---------------------------------------- 包帯が画面に収まっているか */

console.log('\n[3.6] 包帯の見え方');
// 位置と大きさを直接いじったので、刃が画面の外へ飛んでいた時と同じ測り方で見る。
// 手に持つ物は「在る」だけでは足りない。画角の中に、それと分かる大きさで
// 入っていないと、持ち替えたことに気づけない
{
  // yaw/pitch/bobAmount まで埋めるのは飾りではない。
  // 欠けていると銃の振り遅れの計算がNaNになり、そのNaNが行列を伝って
  // 頂点の投影結果まで全部NaNになる。NaNは大小比較が全部falseになるので、
  // 「画面の外へ出ている頂点は0個」という一見正しい結果が出てしまう
  const p = {
    alive: true, sprinting: false, crouching: false, onFloor: true,
    horizontalSpeed: 0, adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2,
    yaw: 0, pitch: 0, bobAmount: 0,
    addRecoil: () => {}, cancelHeal: () => {}, startHeal: () => false,
    collider: { start: new THREE.Vector3() },
  };
  const none = {
    down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
  };
  ws.toggleBandage(p);
  for (let i = 0; i < 40; i++) ws.update(1 / 60, none, p, {});
  ok(ws.bandage.visible, '手に持つと画面に出る');

  ws.bandage.updateMatrixWorld(true);
  // 画面の縦横比で横方向の見え方が変わるので、狭い方(4:3)でも測る。
  // 広い画面で合わせただけだと、窓を細くした時に右端から出る
  const measure = (root, aspect) => {
    const c = new THREE.PerspectiveCamera(vcam.fov, aspect, vcam.near, vcam.far);
    c.updateProjectionMatrix(); c.updateMatrixWorld(true);
    let out = 0, total = 0, minX = 9, maxX = -9, minY = 9, maxY = -9;
    root.traverse((m) => {
      if (!m.isMesh || !m.geometry?.attributes?.position) return;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i += 3) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(c);
        total++;
        if (Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1) out++;
        minX = Math.min(minX, _v.x); maxX = Math.max(maxX, _v.x);
        minY = Math.min(minY, _v.y); maxY = Math.max(maxY, _v.y);
      }
    });
    return { pct: total ? (out / total) * 100 : 100, minX, maxX, minY, maxY };
  };

  // 帯そのものは丸ごと画面に入っていないといけない。
  // 手や前腕は画面の下と背後へ伸びるので（銃の持ち手と同じ）別基準にする
  for (const aspect of [1.78, 1.333]) {
    const r = measure(ws.bandage.userData.roll, aspect);
    ok(
      r.pct === 0,
      `縦横比${aspect.toFixed(2)} … 帯が枠内に収まっている `
      + `(外 ${r.pct.toFixed(1)}% 横${r.minX.toFixed(2)}〜${r.maxX.toFixed(2)} `
      + `縦${r.minY.toFixed(2)}〜${r.maxY.toFixed(2)})`,
    );
  }
  // 画面に占める大きさ。小さすぎると持っていることに気づけない。
  // 正規化座標は-1〜1の幅2なので、0.4は画面の2割ぶん
  const r16 = measure(ws.bandage.userData.roll, 1.78);
  const bw = r16.maxX - r16.minX, bh = r16.maxY - r16.minY;
  ok(bw > 0.4 && bh > 0.4, `帯の大きさ 横${(bw * 50).toFixed(0)}% 縦${(bh * 50).toFixed(0)}%`);

  // 目からの距離。**ここが「手がでかい・グロい」の正体だった。**
  //
  // 元は目から25cmの所に縮尺1.35で置いてあり、前腕が目より26cm手前まで
  // 突き抜けていた（1307頂点のうち972個がカメラの手前）。
  // カメラの手前へ回った面は画面上で無限に広がるので、腕の断面が画面いっぱいに出る。
  // 形の問題ではなく位置の問題で、直すのに触ったのは距離と縮尺と袖の長さだけ。
  //
  // 「大きさ」ではなく「カメラの手前に頂点があるか」で見るのは、
  // 大きさは縮尺を下げれば下がってしまい、突き抜けを見逃すため
  {
    let ahead = 0, nearest = 9;
    ws.bandage.updateMatrixWorld(true);
    ws.bandage.traverse((m) => {
      if (!m.isMesh || !m.geometry?.attributes?.position) return;
      const pos = m.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
        const dist = -_v.z;   // ビューモデルは-zが前
        nearest = Math.min(nearest, dist);
        if (dist <= vcam.near) ahead++;
      }
    });
    ok(ahead === 0, `目より手前に出ている頂点 ${ahead}個（元は811個）`);
    // 一番近い所。ライフルを支える腕が16cmなので、そこから極端に離れない
    ok(nearest > 0.02, `一番近い所 ${(nearest * 100).toFixed(0)}cm（2cmより先）`);
  }

  ws.holsterBandage();
  for (let i = 0; i < 40; i++) ws.update(1 / 60, none, p, {});
  ok(!ws.bandage.visible, 'しまうと消える');
}

/* ------------------------------------------ 覗くのに何秒かかるか */

console.log('\n[3.8] 覗き込みの速さ');
// 遊んで「スコープを覗くまでの時間が長い」と言われた所。
//
// 原因は damp（指数で近づく関数）に adsTime をそのまま渡していたこと。
// 指数はいつまでも到達しないので、0.16秒と書いてあっても実際に覗き終わるのは
// 0.625秒（3.9倍）だった。数字の意味と画の動きが食い違っていると、
// 値をいくら詰めても合わせられない。
//
// ここは「書いた秒数で覗き終わる」ことだけを見る。
// 誤差を1割まで許すのは、コマの刻み方で1フレームぶんずれるため
{
  const none = {
    down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
  };
  const p = {
    alive: true, sprinting: false, crouching: false, onFloor: true,
    horizontalSpeed: 0, adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2,
    yaw: 0, pitch: 0, bobAmount: 0,
    addRecoil: () => {}, cancelHeal: () => {}, startHeal: () => false,
    collider: { start: new THREE.Vector3() },
  };
  const DT = 1 / 120;
  for (const [index, w] of ws.weapons.entries()) {
    if (w.def.melee) continue;
    ws.switchTo(index);
    // 持ち替えの間は覗けないので、終わるまで空回しする
    for (let i = 0; i < 120; i++) ws.update(DT, none, p, {});
    ws.adsHeld = true;
    let t = 0;
    for (let i = 0; i < 600 && ws.adsFactor < 1; i++) { ws.update(DT, none, p, {}); t += DT; }
    const want = w.def.adsTime;
    ok(
      ws.adsFactor >= 1 && Math.abs(t - want) <= want * 0.10 + DT * 1.5,
      `${w.def.name} … 指定${(want * 1000).toFixed(0)}ms に対して実測${(t * 1000).toFixed(0)}ms`,
    );
    ws.adsHeld = false;
    for (let i = 0; i < 240; i++) ws.update(DT, none, p, {});
  }
  ws.switchTo(0);
  for (let i = 0; i < 120; i++) ws.update(DT, none, p, {});
}

/* -------------------------------------- 巻いている間、手が回り続けないか */

console.log('\n[3.7] 包帯を巻いている間の動き');
// 遊んで「巻いてる時に腕もぐるぐる回ってる」と言われた所。
// 原因は、増え続ける値(spin)を手の向きへそのまま足していたこと。
// 2.4秒巻くと手が1回転半していた。
//
// 見た目の不具合は画面を見ないと気づけないが、「回りすぎ」は角度なので測れる。
// 巻いている間の向きを1コマずつ拾って、振れ幅が往復の範囲に収まるかを見る
{
  const p = {
    alive: true, sprinting: false, crouching: false, onFloor: true,
    horizontalSpeed: 0, adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2,
    yaw: 0, pitch: 0, bobAmount: 0,
    addRecoil: () => {}, cancelHeal: () => {}, startHeal: () => false,
    collider: { start: new THREE.Vector3() },
  };
  const none = {
    down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
  };
  ws.toggleBandage(p);
  for (let i = 0; i < 30; i++) ws.update(1 / 60, none, p, {});

  // 巻いている最中を再現する。healingは残り秒なので、満タンから減らしていく
  const HEAL_S = 2.4;
  let minY = 9, maxY = -9, rollX = 0;
  // 巻き終わる手前で止める。healingが0になったコマまで含めると、
  // そこは「巻いていない」扱いで回転が0に戻るので、最後の値を拾うと0が出る
  for (let i = 0; i < Math.round(HEAL_S * 60); i++) {
    p.healing = HEAL_S - i / 60;
    ws.update(1 / 60, none, p, {});
    minY = Math.min(minY, ws.bandage.rotation.y);
    maxY = Math.max(maxY, ws.bandage.rotation.y);
    rollX = Math.max(rollX, Math.abs(ws.bandage.userData.roll.rotation.x));
  }
  // 手が帯を握る向きになっているか。
  // 「手の形はしているが握っていない」は画面を見ないと気づけないが、
  // 握り軸(手のローカルY)と帯の軸(横に寝た円筒なのでX)の角度なら測れる。
  // 元は69.9度ずれていて、指が帯を回り込まずに横切って閉じていた
  {
    const hand = ws.bandage.children.find((c) => c !== ws.bandage.userData.roll);
    const grip = new THREE.Vector3(0, 1, 0).applyQuaternion(hand.quaternion).normalize();
    const gap = THREE.MathUtils.radToDeg(Math.acos(Math.abs(grip.dot(new THREE.Vector3(1, 0, 0)))));
    ok(gap < 20, `手が帯を握る向きになっている (軸のずれ ${gap.toFixed(1)}度 / 上限20度)`);
  }

  const swing = maxY - minY;
  // 手首のひねりは往復。半回転(π)を超えたら、それはもう「回っている」
  ok(swing < Math.PI, `手の振れ幅が往復に収まる (${swing.toFixed(2)}ラジアン / 上限${Math.PI.toFixed(2)})`);
  // 逆に、まったく動かないのも困る。持っているだけの絵に見える
  ok(swing > 0.1, `手はちゃんと動いている (${swing.toFixed(2)}ラジアン)`);
  // 帯そのものはほどけていく物なので、こちらは回り続けるのが正しい
  ok(rollX > Math.PI * 2, `帯はほどける向きに回っている (${rollX.toFixed(1)}ラジアン)`);

  p.healing = 0;
  ws.holsterBandage();
  for (let i = 0; i < 40; i++) ws.update(1 / 60, none, p, {});
}

console.log('\n[4] 近接武器を振った時');
const idle = {
  down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
};
const held = { ...idle, buttons: [true, false, false] };
const player = {
  alive: true, sprinting: false, crouching: false, onFloor: true,
  horizontalSpeed: 0, adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2,
  yaw: 0, pitch: 0, bobAmount: 0,
  addRecoil: () => {}, cancelHeal: () => {}, collider: { start: new THREE.Vector3() },
};

for (let i = 0; i < ws.weapons.length; i++) {
  const def = ws.weapons[i].def;
  if (!def.melee || def.thrown) continue;
  // 持ち替えを即座に終わらせてから振る
  ws.switchTo(i);
  ws.switching = 0;
  ws.index = i;
  ws.fireTimer = 0;

  const fired = [];
  ws.onShot = (s) => fired.push(s);
  ws.update(0.016, idle, player, {});
  ws.update(0.016, held, player, {});

  // 近接は当たり判定として射撃の道を通ってよい。
  // 駄目なのは「銃として撃った扱いになる」こと。渡ってくるdefが近接であれば、
  // 曳光弾も銃口の閃光も呼ぶ側で落とせる
  const asGun = fired.filter((s) => !s.def.melee);
  ok(asGun.length === 0, `${def.name} … 銃として撃っていない (銃扱い ${asGun.length}件)`);
  ok(ws.swing > 0, `${def.name} … 振りの動作が始まっている`);

  // 「火花が散る」の中身を1つずつ見る。
  // effects.muzzle() だけを止めても、板の閃光・煙・マズルライトが残っていて
  // 見た目は何も変わらなかった。出どころを個別に確かめる
  const w = ws.weapons[i];
  ok(w.flash.visible === false, `${def.name} … 銃口の閃光の板が出ていない`);
  ok(ws.flashTimer <= 0, `${def.name} … 閃光の寿命が動いていない`);
  ok((ws.smokeTimer || 0) === 0, `${def.name} … 残留煙が出ていない`);
  ok(ws.muzzleLight.intensity === 0, `${def.name} … マズルライトが光っていない`);
  ok(ws.viewMuzzleLight.intensity === 0, `${def.name} … 手元の発砲光が光っていない`);
}

/* ------------------------------------ 持ち替えで前の状態が残らないか */

console.log('\n[5] 持ち替え');
// ナイフを振っている最中に銃へ持ち替える。
// 振りの状態が残ると、銃が刃の軌道で振り回される
const knife = ws.weapons.findIndex((w) => w.def.melee && !w.def.thrown);
ws.switching = 0;
ws.index = knife;
ws.fireTimer = 0;
ws.onShot = () => {};
ws.update(0.016, idle, player, {});
ws.update(0.016, held, player, {});
ok(ws.swing > 0, '振っている最中である');
ws.switchTo(0);
ok(ws.swing === 0, '銃へ持ち替えたら振りの状態が消える');
ok(ws.burstLeft === 0 && ws.adsHeld === false, '覗きとバーストの残りも消える');

/* ------------------------------------------ 手榴弾は離した時に投げる（課題.md #1） */

console.log('\n[5.5] 手榴弾は押した瞬間ではなく離した瞬間に投げる');
{
  const nadeIdx = ws.weapons.findIndex((w) => w.def.thrown);
  ok(nadeIdx >= 0, '手榴弾がある');
  const thrown = [];
  ws.onThrow = () => thrown.push(1);

  const armThrow = () => {
    thrown.length = 0;
    ws.switchTo(nadeIdx);
    ws.switching = 0;
    ws.index = nadeIdx;
    ws.fireTimer = 0;
    ws.update(0.016, idle, player, {});   // 前回分のtriggerを必ず離した状態から始める
  };

  armThrow();
  ws.update(0.016, held, player, {});
  ok(thrown.length === 0, '押した瞬間には飛ばない');
  for (let i = 0; i < 30; i++) ws.update(0.016, held, player, {});
  ok(thrown.length === 0, '持ち続けている間も飛ばない（30刻み）');
  ws.update(0.016, idle, player, {});
  ok(thrown.length === 1, '離した瞬間に1つ飛ぶ');
  ws.update(0.016, idle, player, {});
  ok(thrown.length === 1, '離したままでは増えない');

  // 死んだまま離しても投げない。倒れている間は投げても仕方が無いし、
  // 死体が手榴弾を投げるのはもっとおかしい
  armThrow();
  ws.update(0.016, held, player, {});
  player.alive = false;
  ws.update(0.016, idle, player, {});
  ok(thrown.length === 0, '死んで離しても投げない');
  player.alive = true;

  // 構えている途中に一時停止(cancelThrowHold)すると、離しても投げない。
  // 無いと、pointerlockが外れてinput.buttonsが黙ってfalseになった時、
  // 再開した1フレーム目が「離した」と誤認して押してもいないのに飛ぶ
  armThrow();
  ws.update(0.016, held, player, {});
  ws.cancelThrowHold();
  ws.update(0.016, idle, player, {});
  ok(thrown.length === 0, '一時停止で断ち切った後は、離しても投げない');

  // 構えている途中に(離さずに)持ち替えると、構えの印が消える。
  // 消さないと、また手榴弾へ持ち替えて指を離しただけの時にまで
  // 前に構えていた分が「離した」と誤認されて飛ぶ
  armThrow();
  ws.update(0.016, held, player, {});
  ok(ws._throwCharging === true, '構えている（内部の印）');
  ws.switching = 0;   // 直前の持ち替えの余韻を消してから、離さずに別の武器へ
  ws.switchTo(0);
  ok(ws._throwCharging === false, '持ち替えると構えの印が消える');
}

console.log('\n[5.7] 手榴弾を使い切ったら手から下ろす');
/* 遊んで「2発使い切ったら手榴弾持つのやめて。無くなってんだから」と言われた所。
   それまでは0本になっても構え続けていて、左クリックのたびに
   空撃ちのカチッだけが鳴っていた（＝無い物を握っている絵） */
{
  const nadeIdx = ws.weapons.findIndex((w) => w.def.thrown);
  const gunIdx = ws.weapons.findIndex((w) => !w.def.melee);
  ws.carry = [gunIdx, nadeIdx];
  ws.resetAll();
  ws.index = nadeIdx;
  ws.switching = 0;
  ws._pendingIndex = null;
  const max = ws.nades;
  // main.js の _throwNadeSolo と同じ繋ぎ方。投げた時に1つ減らす
  ws.onThrow = () => ws.takeNade();

  // 押して離すと1つ飛ぶ。次の1つまで間が空くので、その間は空回しする
  const lob = () => {
    ws.update(0.016, idle, player, {});
    ws.update(0.016, held, player, {});
    ws.update(0.016, idle, player, {});    // 離した瞬間に飛ぶ
  };

  ok(max > 0, `出撃時に${max}個持っている`);
  lob();
  ok(ws.nades === max - 1, `1個目が減った（残り${ws.nades}）`);
  for (let i = 0; i < 120; i++) ws.update(0.016, idle, player, {});
  ok(ws.index === nadeIdx, '残っているうちは握ったまま');

  lob();
  ok(ws.nades === 0, '2個目で残り0個');
  // **投げる動作の途中では替わらない。** ここで替えると、
  // 玉だけ飛んで手は動かない（振りの状態が持ち替えで消える）
  ws.update(0.016, idle, player, {});
  ok(ws.index === nadeIdx && ws.swing > 0, '投げている最中はまだ手榴弾');
  // 振りが終わってから持ち替わる（持ち替え自体も0.42秒かかる）
  for (let i = 0; i < 90; i++) ws.update(0.016, idle, player, {});
  ok(ws.index === gunIdx, '投げ終わったら勝手に銃へ戻る');
  ok(ws.takeNade() === false, '無い物は投げられない');
  ok(ws.switchTo(nadeIdx) === false, '数字を押しても握り直せない');

  // 拾えば戻る（対戦で落ちている物を拾った時）
  ok(ws.addNades(1) === 1, '1個拾うと1個増える');
  ok(ws.switchTo(nadeIdx) === true, '拾えばまた握れる');
  ws.switching = 0; ws.index = nadeIdx; ws._pendingIndex = null;
  ok(ws.addNades(9) === max - 1, `上限を超えて増えない（${max}個まで）`);

  // 出撃し直すと満タンに戻る
  ws.resetAll();
  ok(ws.nades === max, `湧き直しで${max}個へ戻る`);
  ws.carry = ws.weapons.map((_, i) => i);
  ws.index = 0;
  ws.switching = 0;
}

/* ------------------------------------------ 重い画面でもばねが発散しない */

console.log('\n[5.6] 重い画面(dt=0.1)でも弾倉のばねが発散しない');
/* 重い端末では1フレームが0.1秒まで膨らむ(main.jsがそこで頭を押さえる)。
   ばねをその大きなdtのまま積分すると、減衰の掛け算が符号を跨いで
   エネルギーを注ぎ込む側に化けて発散する。実際に、重い端末で
   「弾倉がめっちゃぐるぐる回ってる」と言われた。
   反動のばね(kick系)は刻みの分割で対策済みだったが、弾倉だけ漏れていた */
{
  ws.switching = 0;
  ws.switchTo(0);        // 弾倉を持つライフルで見る
  ws.switching = 0;
  ws.magWob = 0;
  ws.magWobV = 6;        // 撃った直後の揺れより大きい衝撃を入れる
  let peak = 0;
  for (let i = 0; i < 60; i++) {          // 10fpsで6秒ぶん
    ws.update(0.1, idle, player, {});
    peak = Math.max(peak, Math.abs(ws.magWob));
  }
  ok(Number.isFinite(ws.magWob), `値が壊れていない（${ws.magWob.toExponential(2)}）`);
  ok(Math.abs(ws.magWob) < 0.01, `6秒後には収まっている（残り${Math.abs(ws.magWob).toExponential(2)}）`);
  ok(peak < 1.0, `途中でも回りきらない（最大${peak.toFixed(3)}rad。1周=6.28）`);
}

/* -------------------------------------- サーバーの退避表が本物とずれていないか */

console.log('\n[6] server/sim.js の退避武器表');

// server/sim.js は weapons.js を読み込めなかった時のために、
// 武器の数字を**手で写した表**を内蔵している。
// 写しなので、weapons.js を触ると黙ってずれる。
//
// ずれても普段は何も起きない（読み込みが成功する限り使われない）。
// **問題は、使われる日が「weapons.jsが壊れている日」だということ。**
// その日はただでさえ混乱しているのに、弾の強さと距離減衰まで別物のサーバーが動く。
// 遊んでいる側からは「今日はやけに固い」としか分からない。
//
// 並びも見る。sim.js のコメントにある通り**番号がずれると別の武器になる**ので、
// 手榴弾を1本足しただけで、ナイフを撃ったつもりが手榴弾の数字で判定される
{
  const { FALLBACK_WEAPONS, weaponsSource } = await import('../server/sim.js');

  // まず、そもそも今どちらを使っているか。
  // 読み込みに失敗していると黙って退避へ落ちるので、静かな異常として一番先に見る
  ok(weaponsSource === 'weapons.js',
    `サーバーは本物の表を読めている（${weaponsSource}）`
    + (weaponsSource === 'weapons.js' ? '' : '  ← 退避表で動いている'));

  ok(FALLBACK_WEAPONS.length === WEAPONS.length,
    `本数が同じ 退避${FALLBACK_WEAPONS.length} / 本物${WEAPONS.length}`);

  // サーバーが実際に読む項目だけを見る。
  // 見た目・音・反動は退避表が持たない（持たせても誰も読まない）
  const USED = [
    'id', 'damage', 'rpm', 'pellets', 'mag', 'reloadTime', 'adsTime',
    'range', 'falloffStart', 'falloffEnd', 'falloffMin',
  ];

  const n = Math.min(FALLBACK_WEAPONS.length, WEAPONS.length);
  for (let i = 0; i < n; i++) {
    const fb = FALLBACK_WEAPONS[i];
    const real = WEAPONS[i];
    const diff = USED.filter((k) => fb[k] !== real[k]);
    ok(diff.length === 0,
      `${i}番 ${real.id}`
      + (diff.length === 0 ? ' … 写しが本物と一致している'
        : `  ← ${diff.map((k) => `${k} 退避${fb[k]} / 本物${real[k]}`).join('、')}`));
  }
}

console.log('\n[モデル差し替え] 買ったモデルを被せられるか');
/* **今の武器はコードで組んである。** 銃口・薬莢の出口・照準の位置がその中で決まっていて、
   閃光も煙もそこへぶら下がっている。丸ごと差し替えると印まで消えて、
   撃った時に何も出なくなる。**印は残して、見えている所だけ差し替える** */
{
  const {
    modelUrl, hideBuiltMeshes, fitModel, builtBox, MODEL_DIR, HAS_MODEL,
  } = await import('../src/player/glbview.js');

  /* **置いてある物と、読みに行く物が同じか。**
     前は全部の武器について毎回「あるかどうか」を聞きに行っていた。
     置いてあるのが1本だけなので、**起動のたびに404が4回**返り、
     遊ぶ人の画面には毎回4行のエラーが並んでいた。
     本物のエラーがその中に紛れて読めなくなる（本物のブラウザで開く検査が見つけた）。

     ファイルを置くのと、名前を書き足すのは**両方やる**。片方だけになっていないかを見る */
  {
    const dir = new URL(`../${MODEL_DIR}/`, import.meta.url);
    const onDisk = readdirSync(dir).filter((f) => f.endsWith('.glb')).map((f) => f.replace(/\.glb$/, ''));
    for (const id of HAS_MODEL) {
      ok(onDisk.includes(id), `${id} … 名前を書いた物はファイルも置いてある`);
      ok(WEAPONS.some((w) => w.id === id), `${id} … 武器の表にある名前`);
    }
    for (const f of onDisk) {
      ok(HAS_MODEL.includes(f), `${f}.glb … 置いた物は名前も書いてある（書かないと読みに行かない）`);
    }
    ok(HAS_MODEL.length === onDisk.length,
      `数が合っている（名前${HAS_MODEL.length} / ファイル${onDisk.length}）`);
  }

  /* 収める先の箱。**元の銃（手を除いた本体）が占めていた所。**
     ここへ合わせないと、長さは合っても置き場所が原点のままで、
     構えた時に手から離れた所に銃が浮く（実際そうなった） */
  const target = new THREE.Box3(
    new THREE.Vector3(-0.04, -0.24, -0.68),
    new THREE.Vector3(0.04, 0.14, 0.26),
  );

  ok(MODEL_DIR.startsWith('assets/'), `置き場は外へ配る所（${MODEL_DIR}）`);
  ok(modelUrl('rifle').endsWith('/rifle.glb'), `名前から場所が引ける（${modelUrl('rifle')}）`);

  // 手を消してはいけない。銃だけ替わって手が消えると、宙に浮いた銃になる
  {
    const inner = new THREE.Group();
    const hand = new THREE.Group();
    hand.userData.isHand = true;
    const finger = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    hand.add(finger);
    const body = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    const mark = new THREE.Object3D();
    inner.add(hand, body, mark);

    const hidden = hideBuiltMeshes(inner);
    ok(body.visible === false, '面を持っている所は隠れる');
    ok(finger.visible === true, '手は残る（消すと宙に浮いた銃になる）');
    ok(mark.visible === true, '印（面を持たない物）は残る＝閃光と煙の出所');
    ok(hidden.length === 1, `隠したのは1つだけ（${hidden.length}）`);
  }

  /* 買った物は向きも大きさもばらばら。そのまま置くと巨大な銃が横を向いて出る。
     **どちらが銃口かも見る。** 間違えると、銃が自分のほうを向いた状態で構えることになる
     （実際、最初の作りは向きを見ていなくて後ろ向きになった）。
     細いほうが銃身、太いほうが銃床と弾倉 */

  // 銃のかたちを作る。thinAt で細い側（＝銃身）がどちらかを決める
  const mkGun = (axis, thinAt) => {
    const g = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial();
    // 銃身（細くて長い）と銃床（太くて短い）
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(...(axis === 'x' ? [6, 0.2, 0.2] : [0.2, 0.2, 6])), mat);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(...(axis === 'x' ? [2, 1.2, 0.6] : [0.6, 1.2, 2])), mat);
    const s = thinAt === 'min' ? 1 : -1;
    if (axis === 'x') { barrel.position.x = -3 * s; stock.position.x = 3.5 * s; }
    else { barrel.position.z = -3 * s; stock.position.z = 3.5 * s; }
    g.add(barrel, stock);
    return g;
  };

  // 合わせた後、前(-z)側が細くなっていること
  const frontIsThin = (g) => {
    g.updateMatrixWorld(true);
    const pts = [];
    const v = new THREE.Vector3();
    g.traverse((o) => {
      if (!o.isMesh) return;
      const p = o.geometry.attributes.position;
      for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); pts.push(v.clone()); }
    });
    const zs = pts.map((p) => p.z);
    const lo = Math.min(...zs); const hi = Math.max(...zs);
    const thick = (a, b) => {
      const sel = pts.filter((p) => p.z >= lo + (hi - lo) * a && p.z < lo + (hi - lo) * b);
      const ys = sel.map((p) => p.y);
      return sel.length ? Math.max(...ys) - Math.min(...ys) : 0;
    };
    return thick(0, 0.2) < thick(0.8, 1);
  };

  for (const axis of ['x', 'z']) {
    for (const thinAt of ['min', 'max']) {
      const g = mkGun(axis, thinAt);
      fitModel(g, target);
      ok(frontIsThin(g), `${axis}方向に長く、${thinAt === 'min' ? '手前' : '奥'}が銃身のモデル … 銃身が前を向く`);
    }
  }

  // **元の箱の長さと置き場所に合う。** ここが合っていないと、
  // 手から離れた所に銃が浮く／画面いっぱいの銃が出る
  {
    const big = mkGun('x', 'min');
    fitModel(big, target);
    const box = new THREE.Box3().setFromObject(big);
    const size = new THREE.Vector3();
    box.getSize(size);
    const want = new THREE.Vector3();
    target.getSize(want);
    ok(Math.abs(size.z - want.z) < 0.01, `長さが元と同じ（${size.z.toFixed(3)} / ${want.z.toFixed(3)}）`);
    /* **長さは据え置いたまま、断面だけ太らせる。**
       長さを合わせるだけだと断面が元の3分の1しか無くて刃物に見えた。
       かといって全体を大きくすると長さが1.7倍になって腕から突き出た（どちらも実際にそう見えた） */
    ok(size.x > want.x * 0.5, `細くなりすぎない（幅 ${size.x.toFixed(3)} / 元 ${want.x.toFixed(3)}）`);
    ok(size.z < want.z * 1.05, `長くなりすぎない（${size.z.toFixed(3)} / 元 ${want.z.toFixed(3)}）`);
    const c = new THREE.Vector3();
    box.getCenter(c);
    const wc = new THREE.Vector3();
    target.getCenter(wc);
    ok(c.distanceTo(wc) < 0.01, `中心が元と同じ（${c.z.toFixed(3)} / ${wc.z.toFixed(3)}）`);
  }

  /* **本物の道筋で測る。** ここが今回の肝。
     銃だけを手で組んで測っている限り、親も縮尺も無いので正しく見える。
     実際の場面では inner に0.86倍が掛かっていて構えの姿勢も乗っているので、
     世界の座標で測ると**箱が1.16倍**になり、その箱へ合わせたモデルが
     画面の右半分を覆う黒い板になった。**画面を撮って初めて分かった。**

     あわせて、閃光と煙の板（銃より広い平らな面）を数えていないことも見る */
  {
    const cam2 = new THREE.PerspectiveCamera(75, 1.6, 0.05, 900);
    const ws2 = new WeaponSystem(new THREE.Scene(), cam2,
      new THREE.PerspectiveCamera(55, 1.6, 0.002, 12), new THREE.Scene());
    const rifle = ws2.weapons[WEAPONS.findIndex((w) => w.id === 'rifle')];

    // 組み立てただけの物（親も縮尺も無い）と、本物の道筋で測った物が同じであること
    const bare = builtBox(WEAPONS.find((w) => w.id === 'rifle').build(WEAPONS.find((w) => w.id === 'rifle').view));
    const real = builtBox(rifle.inner);
    const bs = new THREE.Vector3();
    const rs = new THREE.Vector3();
    bare.getSize(bs);
    real.getSize(rs);
    ok(Math.abs(bs.z - rs.z) < 0.005,
      `親や縮尺が付いても箱が変わらない（素 ${bs.z.toFixed(3)} / 本番 ${rs.z.toFixed(3)}）`);
    ok(Math.abs(bs.x - rs.x) < 0.005, `幅も変わらない（素 ${bs.x.toFixed(3)} / 本番 ${rs.x.toFixed(3)}）`);

    // 閃光の板は銃より広い（幅0.48）。数えていたら幅がそこまで膨らむ
    ok(rs.x < 0.2, `閃光や煙の板を数えていない（幅 ${rs.x.toFixed(3)}。数えると0.48になる）`);
  }

  // 手を除いた本体の箱が引ける。手まで入れると銃だけが大きくなる
  {
    const inner = new THREE.Group();
    const hand = new THREE.Group();
    hand.userData.isHand = true;
    const far = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    far.position.set(5, 0, 0);
    hand.add(far);
    inner.add(hand);
    inner.add(new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.2, 0.9), new THREE.MeshBasicMaterial()));
    const b = builtBox(inner);
    const bs = new THREE.Vector3();
    b.getSize(bs);
    ok(bs.x < 0.5, `手は箱に入らない（x${bs.x.toFixed(2)}）`);
    ok(Math.abs(bs.z - 0.9) < 0.01, `本体だけの大きさになる（z${bs.z.toFixed(2)}）`);
  }
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
