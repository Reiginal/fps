// 覗いた時に、本当に穴が抜けているかの検査。
//
// なぜ要るか: **照準は「画面を見ないと分からない層」の代表格。**
// 筒の中身は数値としては何も間違っていないのに、内壁が視線を1周ぶん食っていると
// 「覗くと灰色の輪の真ん中に小さく景色が見える」だけの物になる。
// コードを読んでも気づけないし、構えの寸法(adsDist/adsScale)を少し動かすだけで
// 黙って壊れる（穴の広さは筒の寸法ではなく、目から各リムまでの距離の比で決まるため）。
//
// 実際、狙撃銃を足した時に一度外している。理屈で置いた開口は6.0度のはずだったのに
// 実測は3.4度しかなく、**効いていたのは接眼リムではなく直筒の前端**だった。
// 斜めに入った光線はリムを通った後もまっすぐ進むので、筒が長いほど前端で切られる。
//
// ここでやるのは実測だけ。目の位置(ビューモデルの原点)からレイを放射状に撃って、
// どこまで素通しかを測る。**透明な物(レンズ・コーティング・レティクル)は通す。**
//
//   node tools/check-scope.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';

const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const cam = new THREE.PerspectiveCamera(75, 16 / 9, 0.05, 900);
const vcam = new THREE.PerspectiveCamera(55, 16 / 9, 0.002, 12);
const viewScene = new THREE.Scene();
const ws = new WeaponSystem(viewScene, cam, vcam, new THREE.Scene());
// 持って出ない武器も測る。ここは「照準の見え方」の検査で、誰が持てるかは別の話
ws.carry = ws.weapons.map((_, i) => i);

const none = {
  down: () => false, pressed: () => false, clicked: () => false, buttons: [false, false, false],
};
const player = {
  alive: true, sprinting: false, crouching: false, onFloor: true,
  horizontalSpeed: 0, adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2,
  yaw: 0, pitch: 0, bobAmount: 0, bobPhase: 0,
  addRecoil: () => {}, cancelHeal: () => {}, startHeal: () => false,
  collider: { start: new THREE.Vector3() },
};

const ray = new THREE.Raycaster();
ray.far = 5;
const H = 720;   // 画素で言う時の画面の高さ

/** 覗き切った状態にして、その武器を返す */
const aim = (id) => {
  const i = WEAPONS.findIndex((w) => w.id === id);
  ws.switchTo(i);
  ws.switching = 0; ws.index = i; ws._pendingIndex = null;
  for (const w of ws.weapons) w.model.visible = false;
  ws.weapons[i].model.visible = true;
  ws.adsHeld = true;
  // 覗き終わるまで空回し（adsTimeは武器ごとに違うので多めに回す）
  for (let k = 0; k < 600; k++) ws.update(1 / 120, none, player, {});
  viewScene.updateMatrixWorld(true);
  return ws.weapons[i];
};

const relax = () => {
  ws.adsHeld = false;
  for (let k = 0; k < 300; k++) ws.update(1 / 120, none, player, {});
};

/** その角度の輪のうち、素通しの割合 */
const clearAt = (model, deg, n = 48) => {
  const r = THREE.MathUtils.degToRad(deg);
  let open = 0;
  for (let a = 0; a < n; a++) {
    const t = (a / n) * Math.PI * 2;
    ray.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(
      Math.sin(r) * Math.cos(t), Math.sin(r) * Math.sin(t), -Math.cos(r),
    ));
    const hits = ray.intersectObject(model, true);
    // 透明な物は覗く邪魔にならない。硝子もコーティングもレティクルもここに入る
    if (!hits.some((h) => h.object.material && !h.object.material.transparent)) open++;
  }
  return open / n;
};

/* 2つの数え方で測る。**この2つは別のことを言っている:**
     全周    … 1周ぜんぶ抜けている一番外側の角度。狙点のまわりの「無傷の円」
     窓      … 半分以上抜けている一番外側の角度。見えている絵の広さ
   下側は自分の銃身がどうしても入る（実物のスコープでも銃身は見えないが、
   この作りだと目・照準・銃身が同じ模型の上にあるので原理的に避けられない）ので、
   全周だけで測ると「銃身が太い＝照準が壊れている」と読めてしまう */
const aperture = (model) => {
  let last = 0;
  for (let deg = 0.2; deg <= 12; deg += 0.2) {
    if (clearAt(model, deg) < 0.999) break;
    last = deg;
  }
  return last;
};

const windowOf = (model) => {
  let last = 0;
  for (let deg = 0.2; deg <= 12; deg += 0.2) {
    if (clearAt(model, deg) < 0.5) break;
    last = deg;
  }
  return last;
};

console.log('\n[1] 赤ドット（ライフル）');
{
  const w = aim('rifle');
  const a = aperture(w.model);
  const win = windowOf(w.model);
  ok(a >= 2.5, `狙点のまわりが全周素通し（${a.toFixed(1)}度まで）`);
  ok(clearAt(w.model, 1.0) === 1, '狙点のまわりに欠けが無い');
  ok(win >= 4.0, `窓の広さ ${win.toFixed(1)}度（半分以上抜けている所まで）`);
  // 画面に写る大きさ。覗くとビューモデルの画角も絞られるので、その値で換算する
  const px = (Math.tan(THREE.MathUtils.degToRad(win))
    / Math.tan(THREE.MathUtils.degToRad(vcam.fov / 2))) * H;
  ok(px > 100, `覗いた窓の直径 ${px.toFixed(0)}画素（画角${vcam.fov.toFixed(1)}度）`);
  relax();
}

console.log('\n[2] 望遠照準（狙撃銃）');
{
  const w = aim('sniper');
  const a = aperture(w.model);
  const win = windowOf(w.model);
  /* **ここが本題。** 筒が長いぶん、窓の広さは目から各リムまでの距離の比で決まる。
     4度を割ったら、それはどこかが視線を食っている
     （最初に置いた寸法は3.4度しか無く、原因は直筒の前端だった） */
  ok(win >= 4.0, `窓の広さ ${win.toFixed(1)}度（赤ドットと同じ範囲に入っている）`);
  ok(a >= 2.0, `狙点のまわりが全周素通し（${a.toFixed(1)}度まで）`);
  ok(clearAt(w.model, 1.0) === 1, '狙点のまわりに欠けが無い');
  const px = (Math.tan(THREE.MathUtils.degToRad(win))
    / Math.tan(THREE.MathUtils.degToRad(vcam.fov / 2))) * H;
  // 覗くとビューモデル側の画角も絞られる（55度→adsFov*0.9）ので、
  // 同じ角度でも画面には赤ドットの3倍の大きさで写る。狙撃銃らしさはここから出る
  ok(px > H * 0.5,
    `覗いた窓が画面の半分より大きい（${px.toFixed(0)}画素 / 高さ${H}）`);

  console.log('\n[3] レティクルの太さ（画素）');
  /* 線の太さは模型の寸法ではなく**画面の画素**で決まる。
     覗くと画角が14.4度まで絞られて1度が50画素になるので、
     腰だめの感覚で置くと的を隠す帯になる（実際に9画素の帯になっていた）*/
  const pxPerDeg = H / vcam.fov;
  let maxThick = 0;
  let n = 0;
  for (const m of w.parts.reticle || []) {
    m.updateWorldMatrix(true, false);
    const box = new THREE.Box3()
      .setFromBufferAttribute(m.geometry.attributes.position)
      .applyMatrix4(m.matrixWorld);
    const size = new THREE.Vector3();
    box.getSize(size);
    const c = new THREE.Vector3();
    box.getCenter(c);
    const d = -c.z;
    // 細い方が線の太さ
    const thick = (Math.atan(Math.min(size.x, size.y) / d) * 180 / Math.PI) * pxPerDeg;
    maxThick = Math.max(maxThick, thick);
    n++;
  }
  ok(n >= 5, `十字と芯が揃っている（${n}個）`);
  ok(maxThick > 1.5, `細すぎて消えない（一番太い線 ${maxThick.toFixed(1)}画素）`);
  ok(maxThick < 7, `太すぎて的を隠さない（一番太い線 ${maxThick.toFixed(1)}画素）`);
  relax();
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
