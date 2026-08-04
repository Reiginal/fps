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
import '../server/dom-stub.js';
import * as THREE from 'three';

const { WeaponSystem } = await import('../src/player/weapons.js');

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
// 出ていると画面の縁で切れて「見切れている」状態になる
vcam.updateProjectionMatrix();
vcam.updateMatrixWorld(true);
const _v = new THREE.Vector3();
for (const w of ws.weapons) {
  w.model.position.copy(w.hipPos);
  w.model.rotation.copy(w.hipRot);
  w.model.scale.setScalar(w.def.view.scale);
  w.model.updateMatrixWorld(true);
  let out = 0, total = 0;
  w.model.traverse((m) => {
    if (!m.isMesh || !m.geometry?.attributes?.position) return;
    // 見えていない物は数えない。近接や投擲は使わない左手を画面外へ
    // 逃がしてあるので、そのまま数えると常に「見切れている」と出る
    let vis = m.visible;
    for (let o = m.parent; o && vis; o = o.parent) vis = o.visible;
    if (!vis) return;
    const pos = m.geometry.attributes.position;
    // 全頂点は多いので間引く。形の端は拾える
    for (let i = 0; i < pos.count; i += 7) {
      _v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(vcam);
      total++;
      if (Math.abs(_v.x) > 1 || Math.abs(_v.y) > 1) out++;
    }
  });
  const pct = total ? (out / total) * 100 : 0;
  // 銃は手前や下が少し切れるのが普通で、実測すると
  // ライフル14.5%・ショットガン24.7%。これは遊んでいて気にならない範囲。
  // 4割を超えると「刃先が枠の外にある」レベルになるのでそこを線にする
  ok(pct < 40, `${w.def.name} … 画面外へ出ている頂点 ${pct.toFixed(1)}%`);
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

  ws.holsterBandage();
  for (let i = 0; i < 40; i++) ws.update(1 / 60, none, p, {});
  ok(!ws.bandage.visible, 'しまうと消える');
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

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
