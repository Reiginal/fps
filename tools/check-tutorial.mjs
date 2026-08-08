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

// 素のスナップショット。1フレームぶん。上書きしたい所だけ渡す
const snap = (over = {}) => ({
  dt: 1 / 60, yaw: 0, pitch: 0, speed: 0, onFloor: true,
  sprinting: false, crouching: false, shots: 0, kills: 0,
  adsFactor: 0, reloading: 0, weaponIndex: 0, threw: false, healed: false,
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
  const m = new TutorialMachine({ rifleIndex: 0, pistolIndex: 2 });

  // look: 動かさなければ進まない。累積2.5radで進む
  ok(m.step.id === 'look', '最初はlook');
  run(m, 120, {});
  ok(m.step.id === 'look', 'マウスを動かさなければ進まない');
  // 1フレーム0.05radずつ回す。50フレームで2.5rad
  for (let i = 0; i < 49; i++) m.update(snap({ yaw: i * 0.05 }));
  ok(m.step.id === 'look', '2.45radではまだ進まない');
  m.update(snap({ yaw: 49 * 0.05 }));
  m.update(snap({ yaw: 50 * 0.05 }));
  ok(m.step.id === 'move', '2.5radで進む');

  // move: 空中や停止では数えない。歩き合計3.0秒で進む
  run(m, 300, { speed: 3, onFloor: false });
  ok(m.step.id === 'move', '空中の移動は数えない');
  run(m, 179, { speed: 3 });     // 179/60 = 2.98秒
  ok(m.step.id === 'move', '2.98秒ではまだ');
  run(m, 3, { speed: 3 });
  ok(m.step.id === 'sprint', '3.0秒で進む');

  // sprint: 1.5秒
  run(m, 89, { sprinting: true });
  ok(m.step.id === 'sprint', '1.48秒ではまだ');
  run(m, 3, { sprinting: true });
  ok(m.step.id === 'jump', '1.5秒で進む');

  // jump: 接地→空中のエッジ2回。空中のままでは数えない
  run(m, 200, { onFloor: false });
  ok(m.step.id === 'jump', '空中に居続けても1回しか数えない');
  run(m, 5, { onFloor: true });
  run(m, 5, { onFloor: false });   // 2回目のエッジ
  ok(m.step.id === 'crouch', '2回跳んで進む');

  // crouch: 1.5秒。**この時点で既に100発撃っていた人**を再現する
  // （入場フレームの基準取りにこの100が乗ることを次の項で確かめる）
  run(m, 92, { crouching: true, shots: 100 });
  ok(m.step.id === 'shoot', 'しゃがみ1.5秒で進む');

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
  run(m, 2, { reloading: 0 });
  ok(m.step.id === 'switch', '巻き終わりで進む');

  // switch: pistol(2)→rifle(0)の順でだけ進む。
  // この時点で既に7体倒していた人を再現（次のtargetの基準取りに乗る）
  run(m, 10, { weaponIndex: 0, kills: 7 });
  ok(m.step.id === 'switch', '最初からライフルのままでは進まない');
  run(m, 5, { weaponIndex: 2, kills: 7 });
  ok(m.step.id === 'switch', 'ピストルに替えただけではまだ');
  run(m, 2, { weaponIndex: 0, kills: 7 });
  ok(m.step.id === 'target', 'ライフルへ戻して進む');

  // target: 入場時基準の増分3体
  run(m, 5, { kills: 7 });
  ok(m.step.id === 'target', '入場前の7体では進まない');
  run(m, 2, { kills: 9 });
  ok(m.step.id === 'target', '+2体ではまだ');
  run(m, 2, { kills: 10 });
  ok(m.step.id === 'nade', '+3体で進む');

  // nade / heal: 1フレームのフラグ
  run(m, 30, {});
  ok(m.step.id === 'nade', 'フラグ無しでは進まない');
  m.update(snap({ threw: true }));
  ok(m.step.id === 'heal', '投げた瞬間に進む');
  m.update(snap({ healed: true }));
  ok(m.done, '巻き終えて修了');
  ok(m.step === null, '修了後のstepはnull');

  // done後に呼び続けても落ちない・進まない
  const after = run(m, 60, { threw: true, healed: true });
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
  // 手榴弾は「押して構え、離して投げる」。押した瞬間に飛ぶと書いたら嘘
  ok(/離して/.test(byId.nade.main), '手榴弾の文言が「離して投げる」');

  /* switchステップの数字はLOADOUT_IDSの並びと一致すること。
     並びが変わると「2でピストル」が嘘になる */
  const { LOADOUT_IDS } = await import('../src/net/protocol.js');
  ok(LOADOUT_IDS[0] === 'rifle' && LOADOUT_IDS[1] === 'pistol',
    `1=ライフル・2=ピストルの並び（今: ${LOADOUT_IDS.join(',')}）`);
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

  // 軽さ。ここが膨らむと「未経験者の非力な端末で動く」が崩れる
  let meshes = 0, tris = 0, noColor = 0;
  level.root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (!g.attributes.color) noColor++;
  });
  ok(meshes <= 8, `メッシュは8枚まで（今${meshes}枚）`);
  ok(tris < 2000, `三角形は2000未満（今${Math.round(tris)}）`);
  ok(noColor === 0, `色属性の無いジオメトリが無い（真っ黒事故防止。今${noColor}枚）`);

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
  // 梁(z=-4): 立ち姿(1.74)は当たる。しゃがみ(1.06)は通る
  ok(!!level.octree.capsuleIntersect(capsule(0, -4, 1.74)),
    'くぐり梁: 立ったままでは詰まる');
  ok(!level.octree.capsuleIntersect(capsule(0, -4, 1.06)),
    'くぐり梁: しゃがめば通れる');
  // 段差(z=4): 歩いて登れず(0.58超)、跳べば越えられる(0.99未満)
  const boxTop = (() => {
    const hit = level.octree.rayIntersect(
      new THREE.Ray(new THREE.Vector3(0, 3, 4), down),
    );
    return hit ? 3 - hit.distance : 0;
  })();
  ok(boxTop > 0.58, `段の高さ${boxTop.toFixed(2)}m > 自動乗り越え0.58m（歩いては登れない）`);
  ok(boxTop < 0.99, `段の高さ${boxTop.toFixed(2)}m < 跳躍の頂点0.99m（跳べば越えられる）`);

  // 射撃線(0, 目の高さ, -8)から的3点へ視線が通る（土嚢や梁で塞がっていない）
  const eye = new THREE.Vector3(0, 1.58, -8.6);
  for (const s of level.enemySpawns) {
    const to = s.clone().setY(1.3);
    const dir = to.clone().sub(eye);
    const dist = dir.length();
    const hit = level.octree.rayIntersect(new THREE.Ray(eye.clone(), dir.normalize()));
    ok(!hit || hit.distance > dist,
      `射撃線から的(${s.x}, ${s.z})へ視線が通る`);
  }

  // 決まりごとのソース検査。**コメントを外してから見る**
  // （「呼ぶな」の理由コメントに名前が出ているので、生のまま見ると誤検知する。
  //  check-deathcam.mjsで同じ誤検知を踏んだ）
  const src = readFileSync(new URL('../src/world/tutorial-level.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/mg, '');
  ok(!/addMacroVariation|addGroundBlend/.test(src),
    '材質の混合層を二重適用していない（シェーダ破壊防止）');
  ok(!/\.clone\(/.test(src), '材質をcloneしていない（着弾音・足音の引き当てが外れる）');
  // サーバーが読んでいない（チュートリアルは通信しない決まり）
  const { execSync } = await import('node:child_process');
  const hit = execSync(
    'grep -rl "tutorial-level" server/ || true',
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' },
  ).trim();
  ok(hit === '', `server/がtutorial-levelを読んでいない（${hit || '無し'}）`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
