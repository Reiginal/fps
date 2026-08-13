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
  ok(a >= 3.0, `狙点のまわりが全周素通し（${a.toFixed(1)}度まで）`);
  ok(clearAt(w.model, 1.0) === 1, '狙点のまわりに欠けが無い');
  /* 下限は2026-08-11に4.0から6.0へ上げた。**「もっと敵が見えるように」で広げたぶんを、
     ここで固定する。** 上げないと、次に構えの寸法を触った誰かが黙って元へ戻せる
     （窓の広さは筒の寸法ではなく目からの距離で決まるので、
     照準を1つも触らずに窓だけ狭くできてしまう）。

     広げ方の内訳: 内壁を0.0195→0.0215（外皮は据え置き＝銃は太くならない）で4.6→5.0度、
     そこから adsDist 0.145→0.112 で6.6度。効いたのは後者 */
  /* 2026-08-12に6.0から7.5へ上げた。**「アサルトのスコープは見づらいまんまだな」**
     と言われて広げたぶんを、ここで固定する。
     広げ方: 内壁を0.0215→0.0300、対物リムを0.0340→0.0500（外皮も一緒に太らせる）、
     そこから adsDist 0.112→0.096。6.6→8.0度、画面では220→268画素 */
  ok(win >= 7.5, `窓の広さ ${win.toFixed(1)}度（半分以上抜けている所まで）`);
  // 画面に写る大きさ。覗くとビューモデルの画角も絞られるので、その値で換算する
  const px = (Math.tan(THREE.MathUtils.degToRad(win))
    / Math.tan(THREE.MathUtils.degToRad(vcam.fov / 2))) * H;
  ok(px > 180, `覗いた窓の直径 ${px.toFixed(0)}画素（画角${vcam.fov.toFixed(1)}度）`);
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
  /* **赤ドットより角度は狭い**（2026-08-11に赤ドットを6.6度へ広げたので逆転した）。
     狙撃銃はそのぶん覗いた時の倍率が高く、同じ角度が画面では3倍の大きさで写る
     （下の画素の判定がそこを見ている）。だから角度の下限は4.0のまま */
  ok(win >= 4.0, `窓の広さ ${win.toFixed(1)}度`);
  ok(a >= 2.0, `狙点のまわりが全周素通し（${a.toFixed(1)}度まで）`);
  ok(clearAt(w.model, 1.0) === 1, '狙点のまわりに欠けが無い');
  const px = (Math.tan(THREE.MathUtils.degToRad(win))
    / Math.tan(THREE.MathUtils.degToRad(vcam.fov / 2))) * H;
  // 覗くとビューモデル側の画角も絞られる（55度→adsFov*0.9）ので、
  // 同じ角度でも画面には赤ドットの3倍の大きさで写る。狙撃銃らしさはここから出る
  ok(px > H * 0.5,
    `覗いた窓が画面の半分より大きい（${px.toFixed(0)}画素 / 高さ${H}）`);

  console.log('\n[2.5] 拳銃の照準線が飾りで塞がれていないか');
{
  /* 2026-08-11に足した。**拳銃には望遠照準が無いので上の測り方が使えない。**
     あちらは目から放射状にレイを撃つが、拳銃は「後ろの照門から前の照星へ
     線が通っているか」だけが要件で、円錐ではなく1本の線。

     なぜ要るか: 拳銃の形違いが2つになった（サイバー・クローム）。
     どちらも飾りをスライドの天面や後端へ足すので、
     **1つでも照門より高い物を置くと狙点が読めなくなる。**
     数字で見ないと「少し高いだけ」が通ってしまう。

     見るのは**素のままと同じ数しか塞いでいないこと。**
     素のままでも照門そのものに1個当たるので、0個を求めても意味がない */
  const { SHAPE_BUILDS, matNameOf } = await import('../src/player/weapons.js');
  const def = WEAPONS.find((w) => w.id === 'pistol');
  const line = new THREE.Raycaster();
  line.far = 1;
  // 照門(z=0.026)の後ろから、照星(z=-0.128)の高さへ向けて1本通す
  const P_BORE = 0.012;
  const from = new THREE.Vector3(0, P_BORE + 0.0235, 0.060);
  const to = new THREE.Vector3(0, P_BORE + 0.0235, -0.128);
  const dir = to.clone().sub(from).normalize();
  const blockers = (build) => {
    const g = build(def.view);
    g.updateMatrixWorld(true);
    line.set(from, dir);
    return line.intersectObject(g, true)
      .filter((h) => h.object.material && !h.object.material.transparent)
      // 照星そのものは終点なので数えない
      .filter((h) => h.distance < from.distanceTo(to) - 0.004)
      .map((h) => matNameOf(h.object.material) || '?');
  };
  const plain = blockers(def.build);
  ok(plain.length <= 1, `素のままで線を塞ぐ物は${plain.length}個（照門そのもの）`);
  /* **並べる形は表から引く。** 名前をべた書きしていると、
     形を消した時にここが「無い物」を組もうとして落ち、
     足した時は測られないまま出ていく（2026-08-12に両方踏んだ）*/
  const { SHAPE_LIST: SLP } = await import('../src/net/protocol.js');
  for (const { name, id } of SLP.filter((x) => x.weapon === 'pistol')) {
    const got = blockers(SHAPE_BUILDS[id]);
    ok(got.length <= plain.length,
      `${name} … 素のままより増やしていない（${got.length}個 / 素のまま${plain.length}個`
      + `${got.length > plain.length ? ` ← ${[...new Set(got)].join('、')}` : ''}）`);
  }
}

console.log('\n[2.6] ショットガンの照準線が飾りで塞がれていないか');
{
  /* 2026-08-11に足した。**サメを作った時に実際に塞いだ。**

     背鰭を `cylG(0, 0.024, 0.011, 3)` に `rz=π/2` を付けて置いたら、
     円錐が横に倒れて**半径0.024がYへ効き、頂点が0.068まで伸びた。**
     照準線は0.054(SY)なので、覗くと銃口のビードが鰭に隠れる。
     回転を外して「上を向いた三角錐」にすると高さがhに収まる。

     拳銃([2.5])と同じ考え方で、ゴーストリング(z=0.100)から
     銃口のビード(z=-0.548)へ1本の線を通して数える。
     **この銃は素のままで0個**なので、1個でも増えたら落とす */
  const { SHAPE_BUILDS, matNameOf } = await import('../src/player/weapons.js');
  const def = WEAPONS.find((w) => w.id === 'shotgun');
  const line = new THREE.Raycaster();
  line.far = 1.2;
  const SY = 0.054;   // buildShotgunの照準線の高さ
  const from = new THREE.Vector3(0, SY, 0.140);
  const to = new THREE.Vector3(0, SY, -0.548);
  const dir = to.clone().sub(from).normalize();
  const blockers = (build) => {
    const g = build(def.view);
    g.updateMatrixWorld(true);
    line.set(from, dir);
    return line.intersectObject(g, true)
      .filter((h) => h.object.material && !h.object.material.transparent)
      // ビードそのものは終点なので数えない
      .filter((h) => h.distance < from.distanceTo(to) - 0.004)
      .map((h) => matNameOf(h.object.material) || '?');
  };
  const plain = blockers(def.build);
  ok(plain.length === 0, `素のままで線を塞ぐ物は無い（${plain.length}個）`);
  for (const [name, id] of [['ウエスタン', 'western'], ['サメ', 'shark']]) {
    const got = blockers(SHAPE_BUILDS[id]);
    ok(got.length === 0,
      `${name} … 線を塞いでいない（${got.length}個`
      + `${got.length ? ` ← ${[...new Set(got)].join('、')}` : ''}）`);
  }
}

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
  /* **2026-08-12に十字から点へ変えた。**
     「シンプルなドットみたいなのがいいんだけど、倍率上がったら」と言われた所。
     倍率が上がると線も一緒に太くなるので、8本の線が寄って星形の塊になり、
     狙う所が一番濃くなっていた。今は「点＋暗い縁」の2枚だけ */
  ok(n <= 3, `照準は点と縁だけ（${n}枚。十字を持たない）`);
  ok(maxThick > 3, `細すぎて消えない（一番大きい所 ${maxThick.toFixed(1)}画素）`);
  ok(maxThick < 12, `太すぎて的を隠さない（一番大きい所 ${maxThick.toFixed(1)}画素）`);
  /* **縁は加算合成にしない。** 点(MATS.dot)は加算なので、
     明るい空を背にすると白へ溶けて消える（赤＋白＝白）。
     暗い縁が普通の重ね方で1枚下に居ることで、背景が何色でも点の形が残る */
  const rim = (w.parts.reticle || []).find((m) => m.material?.blending !== THREE.AdditiveBlending);
  ok(!!rim, '暗い縁が加算ではない重ね方で入っている（明るい空で消えない）');
  relax();
}

console.log('\n[4] ライフルの形違いが赤ドットの窓を狭めていないか');
{
  /* 2026-08-11に足した。**ライフルの形違いが4つになった**
     （ドラゴン・キャンディ・装甲・桜）。どれも飾りを機関部や先台へ足すので、
     **1つでも赤ドットの視界へ入ると覗いた時に狙点が読めなくなる。**

     addOpticの不変条件は「接眼リムを頂点にした円錐の内側に置いてよいのは
     筒の内壁とレンズとドットだけ」で、円錐は前へ行くほど太くなるので
     「y=0.052より上は禁止」のような固定の高さでは守れない。
     **だから測る。**

     素のままの窓（6.6度）と同じであることを見る。
     1つずつ着せて覗き切らせるので少し時間がかかるが、
     ここを目で確かめる方法が無い（ブラウザを開かないと見えない層）。

     **この節は一番後ろに置くこと。** 中で refreshSkins() を呼んで武器を組み直すので、
     前に置くと [3] が捕まえていた模型が古くなって、
     レティクルの太さが5.0画素から1.3画素へ化ける（実際にそうなった。
     [3]は前の節が掴んだ模型をそのまま測る作りなので、組み直すと壊れる）*/
  const { setAccount } = await import('../src/player/skins.js');
  const base = (() => {
    const w = aim('rifle');
    const v = windowOf(w.model);
    relax();
    return v;
  })();
  ok(base > 6.0, `素のままの窓は ${base.toFixed(1)}度`);

  /* **並べる形は表から引く。** ここに名前をべた書きしていたせいで、
     後から足した形が測られないまま出ていく形になっていた
     （同じ抜け方を振る音・銃声・訓練場の弾でも踏んでいる）*/
  const { SHAPE_LIST } = await import('../src/net/protocol.js');
  for (const { name, id } of SHAPE_LIST.filter((x) => x.weapon === 'rifle')) {
    setAccount({ owned: [`rifle:${id}`], equipped: { rifle: id } });
    ws.refreshSkins();
    const w = aim('rifle');
    const got = windowOf(w.model);
    relax();
    /* **狭くなっていないこと。** 0.2度は測る刻みそのものなので、
       そのぶんだけ許す（刻みより細かい差は測れない） */
    ok(got >= base - 0.2,
      `${name} … 窓が狭まっていない（${got.toFixed(1)}度 / 素のまま${base.toFixed(1)}度）`);
  }
  setAccount({ owned: [], equipped: {} });
  ws.refreshSkins();
}

console.log('\n[5] 狙撃銃の形違いが望遠照準の窓を狭めていないか');
{
  /* ライフルの[4]と同じ理由。**狙撃銃も形違いが4つになった**
     （アイス・ヴェノム・星・竹）。どれも先台と銃身へ飾りを足すので、
     レール(0.042)より上へ出ると狙点のまわりが欠ける。

     アイスの霜・ヴェノムの鱗・星の光る環・竹の節と、
     **4つとも別の物を別の場所へ置いている**ので、1つずつ測る意味がある */
  const { setAccount: setAcc } = await import('../src/player/skins.js');
  const base = (() => {
    const w = aim('sniper');
    const v = windowOf(w.model);
    relax();
    return v;
  })();
  ok(base > 4.0, `素のままの窓は ${base.toFixed(1)}度`);

  const { SHAPE_LIST: SL } = await import('../src/net/protocol.js');
  for (const { name, id } of SL.filter((x) => x.weapon === 'sniper')) {
    setAcc({ owned: [`sniper:${id}`], equipped: { sniper: id } });
    ws.refreshSkins();
    const w = aim('sniper');
    const got = windowOf(w.model);
    relax();
    ok(got >= base - 0.2,
      `${name} … 窓が狭まっていない（${got.toFixed(1)}度 / 素のまま${base.toFixed(1)}度）`);
  }
  setAcc({ owned: [], equipped: {} });
  ws.refreshSkins();
}

console.log('\n[6] 覗きから抜けられること（入り切りと押しっぱなしの両立）');
/* **2026-08-13にWindowsの人から「スコープを覗いたら移動ができなくなった」。**
   覗いたまま抜けられていなかった、が正体。

   この操作は入り切り（押すたび反転）で、押しっぱなし方式にしていない理由は
   Macのトラックパッドが右クリックを押したまま左クリックできないから。
   ところが世の中のFPSはほぼ押しっぱなし方式なので、
   押して離した人は「戻したつもり」で覗いたままになる。そこから先は
   歩きが65%・走れない・倍率が高いと景色が流れない、が重なって
   **動けなくなったようにしか見えない。**

   しかも**左Shiftが行き止まり**だった。覗いている間は走れず(adsFactor < 0.5)、
   走っていないと覗きは切れない(canAdsの!player.sprinting)ので、
   ダッシュを試しても何も起きない。

   ここで見るのは3つ。**素早い1回は今まで通り反転する／長押しは離すと戻る／
   走ろうとしたら切れる。** 1つ目が落ちるとトラックパッドで覗きながら撃てなくなる */
{
  const i = WEAPONS.findIndex((w) => w.id === 'sniper');
  const press = { ...none, clicked: (b) => b === 2, buttons: [false, false, true] };
  const hold = { ...none, buttons: [false, false, true] };
  const up = { ...none, buttons: [false, false, false] };
  const shiftRun = { ...none, down: (k) => k === 'ShiftLeft', buttons: [false, false, false] };

  const fresh = () => {
    ws.switchTo(i);
    ws.switching = 0; ws.index = i; ws._pendingIndex = null;
    ws.adsHeld = false; ws._adsPress = -1;
    player.horizontalSpeed = 0;
  };
  const step = (inp, sec) => {
    for (let k = 0; k < Math.round(sec * 120); k++) ws.update(1 / 120, inp, player, {});
  };

  // 素早く押して離す。トラックパッドの人はこれしか使えない
  fresh();
  step(press, 1 / 120);
  step(up, 0.1);
  ok(ws.adsHeld === true, '素早い1回で覗きに入る');
  step(press, 1 / 120);
  step(up, 0.1);
  ok(ws.adsHeld === false, '**もう一度素早く押すと戻る**（入り切りは今まで通り）');

  // 押しっぱなし。世の中のFPSと同じ持ち方
  fresh();
  step(press, 1 / 120);
  step(hold, 0.6);
  ok(ws.adsHeld === true, '押している間は覗いている');
  step(up, 0.1);
  ok(ws.adsHeld === false, '**離したら戻る**（ここが今回の不具合）');

  // 既に覗いている人が長押ししても、握っている間は覗いたまま
  fresh();
  step(press, 1 / 120); step(up, 0.1);          // 入り切りで覗きに入れておく
  step(press, 1 / 120); step(hold, 0.6);
  ok(ws.adsHeld === true, '覗いている状態から握り直しても、握っている間は覗いたまま');
  step(up, 0.1);
  ok(ws.adsHeld === false, 'そこから離しても戻る');

  // 走ろうとしたら切れる。左Shiftを行き止まりにしない
  fresh();
  step(press, 1 / 120); step(up, 0.1);
  ok(ws.adsHeld === true, '覗いている');
  player.horizontalSpeed = 4;
  step(shiftRun, 0.1);
  ok(ws.adsHeld === false, '**走ろうとしたら覗きが切れる**（Shiftが効かない行き止まりを塞ぐ）');

  // 止まったままShiftに指を置いているだけでは切らない
  fresh();
  step(press, 1 / 120); step(up, 0.1);
  player.horizontalSpeed = 0;
  step(shiftRun, 0.2);
  ok(ws.adsHeld === true, '止まっている間はShiftを押しても覗きは外れない');

  fresh();
  player.horizontalSpeed = 0;
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
