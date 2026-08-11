// チュートリアルの検査。
//
// なぜ要るか: チュートリアルは「FPS未経験の人が最初に触る場所」で、
// ここが壊れていると、その人はゲームの中身へ一度も辿り着けずに閉じる。
// しかも壊れ方が陰湿で、
//   ・課題の文言が実装のキーとずれる（Shiftと書いてあるのに右Shiftが効かない）
//   ・段差が低すぎて歩いて登れてしまい、ジャンプを教えられない
//   ・先に的を倒していた人の課題が勝手に達成になる
// のどれも、画面を見て通しで遊ばないと気づけない。全部机の上で測る。
//
//   node tools/check-tutorial.mjs
import { readFileSync } from 'node:fs';
import { TUTORIAL_STEPS, TutorialMachine } from '../src/core/tutorial.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 素のスナップショット。1フレームぶん。上書きしたい所だけ渡す。
// zの既定は湧き地点（そこに立っているだけでは移動系の課題が進まないこと）
const snap = (over = {}) => ({
  dt: 1 / 60, yaw: 0, pitch: 0, z: 26, speed: 0, onFloor: true,
  sprinting: false, crouching: false, sliding: false,
  keyW: false, keyA: false, keyS: false, keyD: false,
  aimId: null, shots: 0, kills: 0,
  adsFactor: 0, reloading: 0, weaponIndex: 0, nadeKilled: false, healed: false,
  ...over,
});

// 同じスナップショットをn回流す
const run = (m, n, over) => {
  let advanced = 0;
  for (let i = 0; i < n; i++) if (m.update(snap(over)) === 'advance') advanced++;
  return advanced;
};

console.log('\n[1] ステップ機械: 全遷移');
{
  const m = new TutorialMachine({ rifleIndex: 0, pistolIndex: 2, knifeIndex: 4 });

  /* look: **的に合わせないと進まない。** 前は「合計2.5rad動かす」だけで、
     適当に振り回せば終わっていた（何ができれば正解なのかが伝わらない）。
     4枚を順に、それぞれ0.25秒ずつ乗せる */
  ok(m.step.id === 'look', '最初はlook');
  run(m, 120, {});
  ok(m.step.id === 'look', 'マウスを動かさなければ進まない');
  run(m, 600, { aimId: 'passL' });
  ok(m.step.id === 'look', 'この課題に無い的では進まない');
  // かすっただけ（0.25秒に足りない）では数えない
  run(m, 10, { aimId: 'up' });
  run(m, 10, {});
  run(m, 10, { aimId: 'down' });
  run(m, 10, {});
  ok(m.step.id === 'look', 'かすっただけでは数えない');
  for (const id of ['up', 'down', 'left']) run(m, 20, { aimId: id });
  ok(m.step.id === 'look', '3枚ではまだ');
  run(m, 20, { aimId: 'right' });
  ok(m.step.id === 'move', '4枚合わせて進む');

  /* W/S/A/Dは「そのキーで動けた距離」。キーを押しているだけ・
     別のキーで動いているだけでは数えない。**4方向とも6m。**
     前はS/A/Dが2mしか無く、1秒足らずで終わって足の感覚が残らなかった */
  run(m, 300, { keyW: true, speed: 0 });
  ok(m.step.id === 'move', 'Wを押して壁に詰まっていても進まない');
  run(m, 70, { keyW: true, speed: 4.7 });   // 5.48m
  ok(m.step.id === 'move', '5.5mではまだ');
  run(m, 10, { keyW: true, speed: 4.7 });
  ok(m.step.id === 'moveBack', 'Wで6m動いて進む（次はS）');

  run(m, 300, { keyS: true, speed: 0 });
  ok(m.step.id === 'moveBack', 'Sを押して壁に詰まっていても進まない');
  run(m, 80, { keyS: true, speed: 4.7 });   // 6.27m
  ok(m.step.id === 'moveLeft', 'Sで6m動いて進む');
  run(m, 80, { keyS: true, speed: 4.7 });
  ok(m.step.id === 'moveLeft', 'Sで動いてもAの課題は進まない');
  run(m, 80, { keyA: true, speed: 4.7 });
  ok(m.step.id === 'moveRight', 'Aで6m動いて進む');
  run(m, 80, { keyD: true, speed: 4.7 });
  ok(m.step.id === 'lookMove', 'Dで6m動いて進む（次は歩きながら見る）');

  /* lookMove: **足が止まっている間は数えない。**
     ここが効いていないと、止まって左右を見るだけで終わって、
     「歩きながら視点を変える」を一度もやらないまま進む */
  run(m, 600, { aimId: 'passL', speed: 0 });
  ok(m.step.id === 'lookMove', '止まったまま合わせても進まない');
  run(m, 20, { aimId: 'passL', speed: 4.7 });
  ok(m.step.id === 'lookMove', '1枚ではまだ');
  run(m, 20, { aimId: 'passR', speed: 4.7 });
  ok(m.step.id === 'sprint', '歩きながら2枚合わせて進む');

  // sprint: 距離で見る。キーを押しているだけ（進んでいない）では数えない
  run(m, 300, { sprinting: true, speed: 0 });
  ok(m.step.id === 'sprint', '壁に向かって走っても進まない（距離が出ていない）');
  run(m, 94, { sprinting: true, speed: 7.4 });   // 11.6m
  ok(m.step.id === 'sprint', '11.6mではまだ');
  run(m, 5, { sprinting: true, speed: 7.4 });
  ok(m.step.id === 'slide', '12m走って進む（次は滑り込み）');

  /* slide: **走りの直後に置いてある。** 前はしゃがみ（梁）の後ろにあって、
     助走が2mしか無かった（「場所が間違ってるでしょ」）。
     位置では見ない。引き返して助走を付け直すのも正解 */
  run(m, 300, { sprinting: true, speed: 7.4 });
  ok(m.step.id === 'slide', '走っているだけでは進まない');
  run(m, 2, { sliding: true });
  ok(m.step.id === 'knife', '滑れたら進む（次はナイフ）');

  /* knife: **滑り込みの直後、助走路の上でやる。** 前は梁の先（持ち替えの後ろ）に
     あって、そこまで来ると前は射撃線・後ろは梁で8m歩く場所が残っていなかった
     （「もう歩くスペースないタイミングで言われても」2026-08-12） */
  run(m, 300, { weaponIndex: 4, speed: 0 });
  ok(m.step.id === 'knife', 'ナイフを持って立っているだけでは進まない');
  run(m, 300, { weaponIndex: 0, speed: 6.3 });
  ok(m.step.id === 'knife', 'ライフルのまま動いても進まない');
  run(m, 80, { weaponIndex: 4, speed: 6.3 });   // 8.4m
  ok(m.step.id === 'jump', 'ナイフで8m動いて進む（次はジャンプ）');

  // jump: 2つ目の段の奥に立てたか（跳ばないと辿り着けない地形なので位置が証明）
  run(m, 120, { z: -17, onFloor: false });
  ok(m.step.id === 'jump', '段の手前で跳んでいるだけでは進まない');
  run(m, 2, { z: -21 });
  ok(m.step.id === 'crouch', '段を越え切って進む');

  // crouch: 梁の奥。しゃがんでいるだけ（くぐっていない）では進まない
  run(m, 300, { z: -23, crouching: true });
  ok(m.step.id === 'crouch', 'しゃがんで待っているだけでは進まない');
  run(m, 2, { z: -26 });
  ok(m.step.id === 'switch', '梁をくぐり切って進む（次は持ち替え）');

  /* switch は**梁の先**で、撃つ課題の直前。ここに置いてあるのは
     場所の都合ではなく、**1でライフルへ戻って終わる＝ナイフのまま撃つ課題へ
     入らない**ため（ナイフを持ったまま左クリックしても弾は出ない） */
  run(m, 10, { z: -26, weaponIndex: 4 });
  ok(m.step.id === 'switch', 'ナイフを持ったままでは進まない');
  run(m, 5, { z: -26, weaponIndex: 2 });
  ok(m.step.id === 'switch', 'ピストルに替えただけではまだ');
  // **この時点で既に100発撃っていた人**を再現（次のshootの基準取りに乗る）
  run(m, 2, { z: -26, weaponIndex: 0, shots: 100 });
  ok(m.step.id === 'shoot', 'ライフルへ戻して進む（次は撃つ）');

  // shoot: 入場時の累積は基準から除外。+5発で進む
  run(m, 10, { shots: 100 });
  ok(m.step.id === 'shoot', '入場前の100発では進まない');
  run(m, 5, { shots: 104 });
  ok(m.step.id === 'shoot', '+4発ではまだ');
  run(m, 2, { shots: 105 });
  ok(m.step.id === 'ads', '+5発で進む');

  // ads: 覗いただけでは進まず、戻して進む
  run(m, 30, { adsFactor: 1 });
  ok(m.step.id === 'ads', '覗いただけでは進まない（戻すまでがトグルの練習）');
  run(m, 5, { adsFactor: 0 });
  ok(m.step.id === 'reload', '戻して進む');

  // reload: 完了エッジ。リロード中では進まない
  run(m, 60, { reloading: 1.2 });
  ok(m.step.id === 'reload', 'リロード中はまだ');
  /* 巻き終わりで的へ。**この時点で既に7体倒していた人**を再現する。
     runは2フレーム流すので、2フレーム目が的の課題の入場フレームになり、
     そこで基準(7)が取られる。取れていないと、次の項が素通りする */
  run(m, 2, { reloading: 0, kills: 7 });
  ok(m.step.id === 'target', '巻き終わりで進む（次は的）');

  // target: 入場時基準の増分3体。この時点で既に7体倒していた人を再現
  run(m, 5, { kills: 7 });
  ok(m.step.id === 'target', '入場前の7体では進まない');
  run(m, 2, { kills: 9 });
  ok(m.step.id === 'target', '+2体ではまだ');
  run(m, 2, { kills: 10 });
  ok(m.step.id === 'nade', '+3体で進む');

  // nade / heal: 1フレームのフラグ
  run(m, 30, {});
  ok(m.step.id === 'nade', '何もしなければ進まない');
  m.update(snap({ nadeKilled: true }));
  ok(m.step.id === 'heal', '爆風で的を倒した瞬間に進む');
  m.update(snap({ healed: true }));
  ok(m.done, '巻き終えて修了');
  ok(m.step === null, '修了後のstepはnull');

  // done後に呼び続けても落ちない・進まない
  const after = run(m, 60, { nadeKilled: true, healed: true });
  ok(after === 0 && m.done, '修了後は何も起きない');

  // reset
  m.reset();
  ok(m.step.id === 'look' && !m.done, 'reset()で最初へ戻る');
}

console.log('\n[2] 文言とキーの整合');
{
  const byId = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s]));
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const playerSrc = readFileSync(new URL('../src/player/player.js', import.meta.url), 'utf8');
  const text = (s) => `${s.main} ${s.sub}`;

  /* 文言に出るキーが、実装が本当に見ているキーと一致すること。
     どちらかを変えたらもう片方も変える。ずれた瞬間、未経験者は
     「書いてある通りに押したのに動かない」で詰む（自力で抜けられない） */
  ok(/左Shift/.test(text(byId.sprint)) && /ShiftLeft/.test(playerSrc),
    '走り: 文言は「左Shift」、実装はShiftLeft（右Shiftでは走れない）');
  ok(/Ctrl か C/.test(text(byId.crouch))
    && /ControlLeft/.test(playerSrc) && /KeyC/.test(playerSrc),
    'しゃがみ: 文言のCtrl/Cが実装に居る');
  ok(/Space/.test(text(byId.jump)) && /pressed\('Space'\)/.test(playerSrc),
    'ジャンプ: Space');
  ok(/R で/.test(text(byId.reload)) && /pressed\('KeyR'\)/.test(mainSrc),
    'リロード: R');
  ok(/F で/.test(text(byId.heal)) && /pressed\('KeyF'\)/.test(mainSrc),
    '包帯: F');
  ok(/Digit/.test(mainSrc) && /2 で.*1 で/.test(byId.switch.main),
    '武器切り替え: 数字キー');
  // ADSはトグル。「押している間だけ覗く」と書いたら嘘になる
  // （「押しっぱなしではなく」のような否定は正しい説明なので引っかけない）
  ok(!/押している間|押し続け/.test(text(byId.ads)),
    'ADSの文言が押しっぱなし前提になっていない');
  ok(/もう一度/.test(byId.ads.main) && /切り替え/.test(text(byId.ads)),
    'ADSの文言が「もう一度で戻す」切り替え式だと言っている');
  // 手榴弾は「押して構え、離して投げる」。押した瞬間に飛ぶと書いたら嘘。
  // クリアの条件は「倒す」なので、それも文言に出ていること（投げただけで
  // 終わらないのに「投げる」としか書いていないと、投げた後に置き去りになる）
  ok(/離して/.test(byId.nade.main) && /倒/.test(byId.nade.main),
    '手榴弾の文言が「離して投げて倒す」');

  // 移動の4課題がW/A/S/Dをそれぞれ名指ししている（まとめて教えない）
  ok(/W で/.test(byId.move.main) && /S で/.test(byId.moveBack.main)
    && /A で/.test(byId.moveLeft.main) && /D で/.test(byId.moveRight.main),
    '移動の課題がW・S・A・Dの4つに分かれている');

  // ナイフの「足が速い」が実装と合っている（moveMul>1で本当に速い）
  const weaponsSrc = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  const knifeMul = weaponsSrc.match(/id: 'knife'[\s\S]{0,1500}?moveMul: ([\d.]+)/);
  ok(/速/.test(text(byId.knife)) && knifeMul && parseFloat(knifeMul[1]) > 1,
    `ナイフの課題が速さを教えていて、実装も速い（moveMul=${knifeMul?.[1]}）`);

  // 包帯の課題が体力ゲージの場所を教えている（回復を目で確かめられるように）
  ok(/左下のゲージが体力/.test(text(byId.heal)),
    '包帯の課題が「左下のゲージが体力」を言っている');

  /* switchステップの数字はLOADOUT_IDSの並びと一致すること。
     並びが変わると「2でピストル」が嘘になる */
  const { LOADOUT_IDS } = await import('../src/net/protocol.js');
  ok(LOADOUT_IDS[0] === 'rifle' && LOADOUT_IDS[1] === 'pistol' && LOADOUT_IDS[2] === 'knife',
    `1=ライフル・2=ピストル・3=ナイフの並び（今: ${LOADOUT_IDS.join(',')}）`);
}

console.log('\n[3] 小ステージ: 実際に組んで寸法を測る');
{
  /* 文言と機械が正しくても、通路の寸法が身体能力と噛み合っていなければ
     「Spaceを押しても越えられない」「しゃがんでも通れない」で詰む。
     ここは断言でなく実測で見る（やり方はcheck-worldgeo.mjsと同じ） */
  await import('../server/dom-stub.js');
  const THREE = await import('three');
  const { Capsule } = await import('three/addons/math/Capsule.js');
  const { buildTutorialLevel } = await import('../src/world/tutorial-level.js');
  const SHARED = new THREE.MeshStandardMaterial();
  const mats = new Proxy({}, { get: () => SHARED });
  const level = buildTutorialLevel(mats);

  const L = level.layout;
  ok(!!L, '通路の割り振り(layout)を出している');

  /* 軽さ。ここが膨らむと「未経験者の非力な端末で動く」が崩れる。
     案内の的(6枚)と床の線(1枚)が別メッシュなので、地形の分と合わせて上限を上げてある
     （案内は光を無視する材質で塗るので、地形と同じメッシュには混ぜられない） */
  let meshes = 0, tris = 0, noColor = 0;
  level.root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  // 色属性が要るのは地形だけ（vertexColorsで動いている材質を使うのはそちら）
  level.solids.traverse((o) => { if (o.isMesh && !o.geometry.attributes.color) noColor++; });
  ok(meshes <= 14, `メッシュは14枚まで（今${meshes}枚）`);
  ok(tris < 2000, `三角形は2000未満（今${Math.round(tris)}）`);
  ok(noColor === 0, `地形に色属性の無いジオメトリが無い（真っ黒事故防止。今${noColor}枚）`);

  // 湧き地点の真下に床がある
  const down = new THREE.Vector3(0, -1, 0);
  const spawnRay = level.octree.rayIntersect(
    new THREE.Ray(level.playerSpawn.clone(), down),
  );
  ok(spawnRay && spawnRay.distance < 2, '湧き地点の真下に床がある');

  // カプセルの実測。数字はprotocol.jsのHITBOXと同じ体格
  const R = 0.34;
  const capsule = (x, z, h) => new Capsule(
    new THREE.Vector3(x, 0.05 + R, z),
    new THREE.Vector3(x, h - R, z),
    R,
  );
  // 梁: 立ち姿(1.74)は当たる。しゃがみ(1.06)は通る
  ok(!!level.octree.capsuleIntersect(capsule(0, L.BEAM, 1.74)),
    'くぐり梁: 立ったままでは詰まる');
  ok(!level.octree.capsuleIntersect(capsule(0, L.BEAM, 1.06)),
    'くぐり梁: しゃがめば通れる');
  // 段差: 歩いて登れず(0.58超)、跳べば越えられる(0.99未満)
  const boxTop = (() => {
    const hit = level.octree.rayIntersect(
      new THREE.Ray(new THREE.Vector3(0, 3, L.JUMP_A), down),
    );
    return hit ? 3 - hit.distance : 0;
  })();
  ok(boxTop > 0.58, `段の高さ${boxTop.toFixed(2)}m > 自動乗り越え0.58m（歩いては登れない）`);
  ok(boxTop < 0.99, `段の高さ${boxTop.toFixed(2)}m < 跳躍の頂点0.99m（跳べば越えられる）`);

  // 射撃線から的3点へ視線が通る（土嚢や梁で塞がっていない）
  const eye = new THREE.Vector3(0, 1.58, L.SANDBAG - 0.6);
  for (const sp of level.enemySpawns) {
    const to = sp.clone().setY(1.3);
    const dir = to.clone().sub(eye);
    const dist = dir.length();
    const hit = level.octree.rayIntersect(new THREE.Ray(eye.clone(), dir.normalize()));
    ok(!hit || hit.distance > dist,
      `射撃線から的(${sp.x}, ${sp.z})へ視線が通る`);
  }

  /* **練習広場が本当に広いか。** ここが狭いと、6m動く課題が壁で詰む。
     遊んで「SもAもDもちゃんと何メートルか用意してあげて」と言われた所なので、
     4方向とも6m歩ける余地があることを実測する */
  const sp0 = level.playerSpawn;
  for (const [label, dx, dz] of [['前', 0, -1], ['後ろ', 0, 1], ['左', -1, 0], ['右', 1, 0]]) {
    const at = capsule(sp0.x + dx * 6, sp0.z + dz * 6, 1.74);
    ok(!level.octree.capsuleIntersect(at), `広場: 湧き地点から${label}へ6m立てる`);
  }

  /* 狙う的。**湧いた所から4枚とも見えていること。**
     壁の中や背中側に置くと、マウスに慣れていない人が永久に見つけられない */
  const eye0 = new THREE.Vector3(sp0.x, sp0.y + 0.38, sp0.z);
  const byId = Object.fromEntries(level.aimTargets.map((t) => [t.id, t]));
  ok(level.aimTargets.length === 6, `案内の的が6枚ある（今${level.aimTargets.length}枚）`);
  for (const id of ['up', 'down', 'left', 'right']) {
    const t = byId[id];
    ok(!!t, `的「${id}」がある`);
    if (!t) continue;
    const dir = t.pos.clone().sub(eye0);
    const dist = dir.length();
    const hit = level.octree.rayIntersect(new THREE.Ray(eye0.clone(), dir.normalize()));
    ok(!hit || hit.distance > dist, `湧き地点から的「${id}」が見える`);
  }
  // 上下左右にちゃんと散っているか。同じ方向に固まっていたら練習にならない
  ok(byId.up.pos.y > eye0.y + 1, `上の的は上にある（y=${byId.up.pos.y}）`);
  ok(byId.down.pos.y < eye0.y - 0.8, `下の的は下にある（y=${byId.down.pos.y}）`);
  ok(byId.left.pos.x < -4, `左の的は左にある（x=${byId.left.pos.x}）`);
  ok(byId.right.pos.x > 4, `右の的は右にある（x=${byId.right.pos.x}）`);
  // 歩きながら狙う2枚は、通り過ぎる横に置く（正面だと歩くだけで乗る）
  ok(Math.abs(byId.passL.pos.x) > 6 && Math.abs(byId.passR.pos.x) > 6,
    '歩きながらの的は通路の横にある');

  /* **的の出し分け。** 前は6枚とも最初から立っていて、最初の課題が
     「上・下・左・右の4枚」なのに橙の板が6枚見えていた（遊んで指摘された）。
     立っている板が全部「今狙う物」でないと、文章と画が食い違う */
  const shown = () => level.aimTargets.filter((t) => t.mesh.visible).map((t) => t.id).sort();
  ok(shown().length === 0, `組んだ直後は1枚も出ていない（今${shown().length}枚）`);
  const lookStep = TUTORIAL_STEPS.find((st) => st.id === 'look');
  const walkStep = TUTORIAL_STEPS.find((st) => st.id === 'lookMove');
  level.showAim(lookStep.aim);
  ok(shown().join() === 'down,left,right,up', `視点の課題では4枚だけ（今${shown().join()}）`);
  level.showAim(walkStep.aim);
  ok(shown().join() === 'passL,passR',
    `歩きながらの課題に入ると2枚に入れ替わる（今${shown().join()}）`);
  // 課題に的が無い間（歩く・走る…）は1枚も出さない。showAim(undefined)で消える
  level.showAim(TUTORIAL_STEPS.find((st) => st.id === 'sprint').aim);
  ok(shown().length === 0, '的の無い課題では1枚も出ていない');
  // 2回目に入った時。緑のままでも出たままでも残らない
  level.showAim(lookStep.aim);
  level.setAimDone('up', true);
  level.resetAim();
  ok(shown().length === 0 && byId.up.mesh.material.color.getHex() === 0xffa24a,
    '入り直すと的は消えて橙に戻る');

  /* **足を使う課題は全部この直線の上でやる。** ここが一番の直し所で、
     前はしゃがみの後ろに滑り込みを置いていて助走が2mしか無かった。
     境(YARD_FAR)から最初の段(JUMP_A)まで、
     走り12m＋滑り6m＋ナイフ歩き8mを続けてやっても入る長さが要る
     （ナイフを梁の先に置いていた時は、そこに8m歩く場所が残っていなかった） */
  const runway = L.YARD_FAR - L.JUMP_A;
  const gates = Object.fromEntries(TUTORIAL_STEPS.map((st) => [st.id, st]));
  const needRun = gates.sprint.goal + 6 + gates.knife.goal;
  ok(runway >= needRun,
    `助走路が${runway}m（走り${gates.sprint.goal}m＋滑り6m＋ナイフ${gates.knife.goal}mの${needRun}mが入る）`);
  // 助走路に障害物が無いこと。1mおきに立ってみる
  let blocked = 0;
  for (let z = L.YARD_FAR - 1; z > L.JUMP_A + 1; z -= 1) {
    if (level.octree.capsuleIntersect(capsule(0, z, 1.74))) blocked++;
  }
  ok(blocked === 0, `助走路がまっすぐ空いている（詰まり${blocked}箇所）`);

  /* **ナイフの8m歩きが助走路の側にあること。** 梁の先へ戻すと、
     前は射撃線・後ろは低い梁で歩く場所が残らない（今回直した所）。
     段(JUMP_A)より前の課題だと言い切れれば、上で測った助走路の中に居る */
  const order = TUTORIAL_STEPS.map((st) => st.id);
  ok(order.indexOf('knife') > order.indexOf('slide')
    && order.indexOf('knife') < order.indexOf('jump'),
    `ナイフは滑り込みの後・ジャンプの前（今: ${order.slice(order.indexOf('sprint'), order.indexOf('jump') + 1).join('→')}）`);
  // 持ち替えは撃つ課題の直前。ナイフのまま撃つ課題へ入らないための並び
  ok(order.indexOf('switch') === order.indexOf('shoot') - 1,
    `持ち替えの直後が撃つ課題（今: ${order[order.indexOf('shoot') - 1]}→shoot）`);

  /* 課題の目的地(goalZ)が仕掛けの座標と噛み合っているか。
     表(tutorial.js)と通路(tutorial-level.js)は別ファイルなので、
     片方だけ動かすと「段の手前なのにクリア」「くぐり切ったのにクリアされない」になる */
  ok(gates.jump.goalZ < L.JUMP_B - 0.8 && gates.jump.goalZ > L.BEAM + 0.7,
    `ジャンプの目的地(z=${gates.jump.goalZ})は2つ目の段の奥・梁の手前`);
  ok(gates.crouch.goalZ < L.BEAM - 0.7 && gates.crouch.goalZ > L.SANDBAG + 0.4,
    `しゃがみの目的地(z=${gates.crouch.goalZ})は梁の奥・土嚢の手前`);
  // 広場でやる課題は位置で見ない（広場は先へ進む場所ではない）
  for (const id of ['look', 'move', 'moveBack', 'moveLeft', 'moveRight', 'lookMove']) {
    ok(gates[id].goalZ === undefined, `${id}は位置で判定していない`);
  }

  // 決まりごとのソース検査。**コメントを外してから見る**
  // （「呼ぶな」の理由コメントに名前が出ているので、生のまま見ると誤検知する。
  //  check-deathcam.mjsで同じ誤検知を踏んだ）
  const src = readFileSync(new URL('../src/world/tutorial-level.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/mg, '');
  ok(!/addMacroVariation|addGroundBlend/.test(src),
    '材質の混合層を二重適用していない（シェーダ破壊防止）');
  ok(!/mats\.[a-zA-Z]+\.clone\(/.test(src) && !/mat\.clone\(/.test(src),
    '材質をcloneしていない（着弾音・足音の引き当てが外れる）');
  // サーバーが読んでいない（チュートリアルは通信しない決まり）
  const { execSync } = await import('node:child_process');
  const hit = execSync(
    'grep -rl "tutorial-level" server/ || true',
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' },
  ).trim();
  ok(hit === '', `server/がtutorial-levelを読んでいない（${hit || '無し'}）`);
}

console.log('\n[4] HUDの課題札: 軽さと畳み');
{
  /* 課題札は毎フレーム呼ばれる。同じ文で毎回DOMを書くと、
     見えない所でレイアウト計算が走り続ける（check-hud.mjsの[軽さ]と同じ話）。
     偽DOMの作りもcheck-hud.mjsと同じ（idごとに要素を作って配る） */
  const mkEl = () => {
    const classes = new Set();
    return {
      textContent: '', style: {}, children: [],
      classList: {
        add: (c) => classes.add(c),
        remove: (c) => classes.delete(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
        contains: (c) => classes.has(c),
      },
      appendChild() {}, querySelectorAll: () => [],
    };
  };
  const els = new Map();
  globalThis.document = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, mkEl());
      return els.get(id);
    },
    createElement: () => mkEl(),
    querySelectorAll: () => [],
  };
  globalThis.performance = globalThis.performance || { now: () => 0 };
  const { HUD } = await import('../src/ui/hud.js');
  const hud = new HUD();

  // 書き込み回数を数える細工。mainとsubの両方に仕込む
  const counted = (el) => {
    let v = el.textContent;
    let n = 0;
    Object.defineProperty(el, 'textContent', {
      get: () => v,
      set: (x) => { v = x; n++; },
    });
    return () => n;
  };
  const mainWrites = counted(document.getElementById('tutMain'));
  const subWrites = counted(document.getElementById('tutSub'));
  const tut = document.getElementById('tutorial');
  const hudEl = document.getElementById('hud');

  for (let i = 0; i < 10; i++) hud.tutorial('WASDで歩く', 'あと3秒');
  ok(mainWrites() === 1 && subWrites() === 1,
    `同じ文を10回渡しても書き込みは1回（main${mainWrites()}/sub${subWrites()}）`);
  hud.tutorial('WASDで歩く', 'あと2秒');
  ok(subWrites() === 2, '文が変われば書く');
  ok(!tut.classList.contains('hidden'), '出ている');
  hud.tutorial(null);
  ok(tut.classList.contains('hidden'), 'nullで畳む');
  // クリアの瞬間の一発合図。付いて、少し置いて自分で消える
  hud.tutorialDone(0.01);
  ok(tut.classList.contains('done'), 'tutorialDone()で✓の印(done)が付く');
  await new Promise((r) => setTimeout(r, 40));
  ok(!tut.classList.contains('done'), '✓の印は少し置いて自分で消える');
  hud.setTutorial(true);
  ok(hudEl.classList.contains('tutorial'), 'setTutorial(true)で#hudに印が付く');
  hud.setTutorial(false);
  ok(!hudEl.classList.contains('tutorial'), 'falseで外れる');
}

console.log('\n[5] 器の繋ぎ込み（HTML/CSS/メニュー）');
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const netmenuSrc = readFileSync(new URL('../src/ui/netmenu.js', import.meta.url), 'utf8');
  ok(/id="nmTutorial"/.test(html), 'ホームにチュートリアルのボタンがある');
  ok(/id="tutorial"/.test(html) && /id="tutMain"/.test(html), '課題札のDOMがある');
  ok(/id="tutCheck"/.test(html) && /#tutorial\.done/.test(html),
    'クリアの✓の器と見た目のCSSがある');
  ok(/#hud\.tutorial #waveBox, #hud\.tutorial #scoreBox, #hud\.tutorial #minimap \{ display: none; \}/.test(html),
    'チュートリアル中は波・得点・地図が消えるCSSがある');
  // setBusyへの足し忘れ＝対戦の接続中にチュートリアルへ入れてしまう
  ok(/setBusy\(on\) \{[\s\S]{0,400}?tutorial\.disabled = this\.busy/.test(netmenuSrc),
    '接続中はチュートリアルのボタンも止まる');
  // e2e（デプロイ前の実ブラウザ検査）もボタンを見ている
  const e2e = readFileSync(new URL('../e2e/boot.spec.mjs', import.meta.url), 'utf8');
  ok(/'nmTutorial'/.test(e2e), 'e2eがボタンの実在を見ている');
}

console.log('\n[6] 本編との縁切り（戦績・波・死・当たり先）');
{
  /* チュートリアルは本編と同じ道具（敵・武器・地形の判定）を使う。
     縁を切る所を切り忘れると、
       ・練習の発砲が通算戦績に混ざる（後から分離できない）
       ・一時停止から戻った瞬間に敵の波が湧く
       ・手榴弾の自爆で結果画面へ飛ばされる
     のどれも実際に遊ばないと気づけない。ソースの形で見張る
     （コメントを外してから見る。理由コメントに同じ語が出るため） */
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/mg, '');
  // ガードは訓練場(check-range.mjs)と共用の「tutorial || range」の形
  ok(/_tally\(key, n = 1\) \{\s*if \(this\.tutorial \|\| this\.range\) return;/.test(src),
    '_tallyの先頭で止める（戦績を汚さない唯一の急所）');
  ok(/_tallyBest\(key, v\) \{\s*if \(this\.tutorial \|\| this\.range\) return;/.test(src),
    '_tallyBestも同じ');
  ok(/mode === 'solo' && !this\.tutorial && !this\.range && this\.director\.wave === 0/.test(src),
    '波の起動にガードがある（一時停止からの復帰でも通る行）');
  ok(/_onPlayerDown\(\) \{\s*if \(this\.state === 'dead'\) return;\s*if \(this\.tutorial \|\| this\.range\) \{/.test(src),
    '_onPlayerDownの先頭で受ける（倒れない・結果画面へ行かない）');
  // 当たり先の差し替え。射撃と爆風の両方（片方だけだと手榴弾が的に効かない）
  const swaps = (src.match(/this\._shootables \?\? this\.director\.active/g) || []).length;
  ok(swaps === 2, `射撃と爆風の当たり先が差し替え式（${swaps}/2箇所）`);
  // 世界を戻す口が、ソロ開始・対戦参加・ホームの全経路に居る
  ok(/_enterSolo\(\) \{\s*this\._leaveTutorial\(\);/.test(src), '_enterSoloで片付ける');
  ok(/_joinMatch\(\{ url, name \}\) \{\s*this\._leaveTutorial\(\);/.test(src),
    '_joinMatchで片付ける');
  ok(/_goHome\(\) \{[\s\S]{0,200}?_leaveTutorial\(\);/.test(src), '_goHomeで片付ける');
  // 修了はstateを先に立ててから掴みを離す（逆だと一時停止画面に化ける）
  ok(/_finishTutorial\(\) \{[\s\S]{0,200}?state = 'paused';\s*document\.exitPointerLock/.test(src),
    '修了はstateを先に立てる');
  /* クリアの瞬間の合図（✓＋緑＋上がる2音）。バナーと小さいカチッだけでは
     「できたかどうかわかりづらい」と言われた(2026-08-09)。
     どちらか片方だけ残って片方が消える、を防ぐため両方の呼び出しを見る */
  const adv = src.match(/res === 'advance'\) \{[\s\S]{0,600}/)?.[0] ?? '';
  ok(/tutorialDone\(/.test(adv), 'クリアの瞬間に✓の合図を出す');
  ok(/lobbyJoin\(\)/.test(adv), 'クリアの瞬間に音を鳴らす');
  ok(/_tutDoneHold/.test(adv), '文言を少し止めてから次の課題へ変える');
  // 最後の課題（包帯）の後は、体力ゲージの案内を見せる間を置いてから修了画面
  ok(/if \(!s\) \{\s*this\._tutFinishT = TUT_FINISH_HOLD_S;/.test(src),
    '修了の前に間を置く（回復したのを見届けてから修了画面）');
  ok(/左下のゲージが体力/.test(src), '修了前の間に体力ゲージの場所を出す');
  // 手榴弾の課題は爆風の的キルで進む。的には_onKillを呼ばない（二重表示と得点を防ぐ）
  ok(/if \(this\._shootables\) \{\s*if \(this\.tutorial\) this\._tutFlags\.nadeKill = true;/.test(src),
    '爆風の的キルで課題の印を立てる（_onKillは的に呼ばない）');
  ok(/step\?\.id === 'nade' && this\.weapons\.nades < NADE\.PER_ROUND/.test(src),
    '手榴弾の課題の間は投げ放題（外し続けても詰まない）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
