// 射撃訓練場の検査。
//
// なぜ要るか: 訓練場は「弾を気にせず撃ち続けられる」が売りで、壊れ方が全部陰湿:
//   ・レーンの振れ幅が壁を越えていて、的が壁の中を泳ぐ
//   ・弾の補充を入れ忘れて、3分遊ぶと弾切れで何もできなくなる
//   ・無敵の入れ忘れで、手榴弾の練習をしたら結果画面へ飛ばされる
//   ・的の判定だけ動いて見た目が置き去り（当たらないのに血が出る）
// のどれも、画面で長めに遊ばないと気づけない。全部机の上で測る。
//
//   node tools/check-range.mjs
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

console.log('\n[1] 小ステージ: 実際に組んで寸法を測る');
await import('../server/dom-stub.js');
const THREE = await import('three');
const { buildRangeLevel } = await import('../src/world/range-level.js');
const SHARED = new THREE.MeshStandardMaterial();
const mats = new Proxy({}, { get: () => SHARED });
const level = buildRangeLevel(mats);
{
  // 軽さ。ここが膨らむと「気軽に開ける練習場」が本編並みに重くなる
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
}

console.log('\n[2] レーン表: 的の動きが部屋と噛み合う');
{
  const lanes = level.targetLanes;
  ok(Array.isArray(lanes) && lanes.length >= 3, `レーンが3本以上（今${lanes?.length}本）`);
  const down = new THREE.Vector3(0, -1, 0);
  for (const l of lanes) {
    /* 振れ幅の両端に的の半径(0.34)を足しても壁の内側に収まる。
       ここが超えていると、的が壁へ潜って撃てない時間ができる */
    const reach = Math.abs(l.x) + l.amp + 0.34;
    ok(reach < 13.0, `z=${l.z}: 振れ幅の端${reach.toFixed(1)}mが壁の内側13mに収まる`);
    // 横へ動く速さの最大(amp×speed)。歩き〜小走り(2〜4.5m/s)の帯に収める。
    // 速すぎると未経験者が当てられず、遅すぎると止まっているのと同じ
    const peak = l.amp * l.speed;
    ok(peak >= 2 && peak <= 4.5, `z=${l.z}: 最高速${peak.toFixed(1)}m/sが2〜4.5の帯にある`);
    // 振れ幅の両端の真下にも床がある（端で床を踏み外すと保険のspawnし直しが暴れる）
    for (const sx of [l.x - l.amp, l.x + l.amp]) {
      const hit = level.octree.rayIntersect(
        new THREE.Ray(new THREE.Vector3(sx, 1, l.z), down),
      );
      ok(hit && hit.distance < 1.5, `z=${l.z}: 端(x=${sx.toFixed(1)})の真下に床がある`);
    }
    // 射座(湧き地点の目の高さ)からレーンの中央へ視線が通る（土嚢で塞がっていない）
    const eye = level.playerSpawn.clone().setY(1.58);
    const to = new THREE.Vector3(l.x, 1.3, l.z);
    const dir = to.clone().sub(eye);
    const dist = dir.length();
    const hit = level.octree.rayIntersect(new THREE.Ray(eye.clone(), dir.normalize()));
    ok(!hit || hit.distance > dist, `z=${l.z}: 射座から的へ視線が通る`);
  }
  // 保険のspawnし直し(enemy.jsの場外復帰)が読むenemySpawnsも埋まっている
  ok(level.enemySpawns.length === lanes.length, 'enemySpawnsがレーンと同数ある');
}

console.log('\n[3] 動きの式: 判定と見た目が一緒に動く');
{
  /* main.jsの_rangeFrameを源で見る（コメントを外してから。理由コメントに
     同じ語が出るため。check-tutorial.mjsと同じ流儀）。
     ここで見たいのは「colliderとrootと接地暗がりが同じフレームで運ばれる」こと。
     どれか1つでも欠けると「当たらないのに血が出る」「影だけ置き去り」になる */
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/mg, '');
  const frame = src.match(/_rangeFrame\(dt\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
  ok(frame !== '', '_rangeFrameがある');
  ok(/collider\.start\.x = x;\s*t\.collider\.end\.x = x;/.test(frame),
    '判定のカプセル(collider)を動かしている');
  ok(/root\.position\.x = x/.test(frame), '見た目(root)も同じxへ動かしている');
  ok(/_syncHitboxes\(\)/.test(frame), '部位判定(hitbox)を作り直している');
  ok(/_updateContact\(\)/.test(frame), '足元の暗がりも運んでいる');
  // 減る物を毎フレーム戻す3点。どれか忘れると数分で練習が止まる
  ok(/refillReserve\(\)/.test(frame), '予備弾を戻している');
  ok(/addNades\(/.test(frame), '手榴弾を戻している');
  ok(/player\.refill\(\)/.test(frame), '体力を戻している（無敵）');
}

console.log('\n[3.5] 訓練場で持てる武器**全部**の弾が戻る');
{
  /* **形ではなく実際に減らして戻して確かめる。**
     上の[3]は「refillReserveを呼んでいる」までしか見ていないので、
     呼ばれた先が一部の枠しか見ていない時に素通りする。実際そうなった:

       2026-08-11 … Eの枠(rangeIndex)にショットガンを足した
       2026-08-12 … 「ショットガンだけは弾が無限じゃない」と言われた

     refillReserveが carry と quickIndex しか見ていなくて、
     **Eの枠だけ補給から漏れていた。** 同じ抜け方はQの枠でも一度やっている
     （あちらは狙撃銃で、コメントに残っている）。
     枠を足すたびに手で書き足す形なので、ここは実測で押さえる */
  const { WeaponSystem, WEAPONS } = await import('../src/player/weapons.js');
  const ws = new WeaponSystem(new THREE.Scene(),
    new THREE.PerspectiveCamera(75, 1.6, 0.05, 900),
    new THREE.PerspectiveCamera(55, 1.6, 0.002, 12), new THREE.Scene());

  // main.jsの_enterRangeと同じ配り方にする
  ws.quickIndex = WEAPONS.findIndex((w) => w.id === 'sniper');
  ws.rangeIndex = WEAPONS.findIndex((w) => w.id === 'shotgun');

  const slots = [...ws.carry, ws.quickIndex, ws.rangeIndex].filter((i) => i != null);
  // 予備弾を持つ武器だけを見る（ナイフと手榴弾は元から持たない）
  const withReserve = slots.filter((i) => ws.weapons[i].def.reserve > 0);
  ok(withReserve.length >= 4, `訓練場で持てて予備弾のある武器が ${withReserve.length}本`);

  for (const i of withReserve) ws.weapons[i].reserve = 0;
  ws.refillReserve();
  for (const i of withReserve) {
    const w = ws.weapons[i];
    ok(w.reserve === w.def.reserve,
      `${w.def.name} … 予備弾が戻る（${w.reserve} / ${w.def.reserve}）`);
  }

  /* 弾倉の中身は戻さないこと。**練習でも装填の呼吸は本物のまま**にしておく
     （戻すと、撃ち切る直前に補給が入って装填が一度も起きない）*/
  const sg = ws.weapons[ws.rangeIndex];
  sg.ammo = 0;
  ws.refillReserve();
  ok(sg.ammo === 0, 'マガジンの中身は戻さない（装填の呼吸は残す）');
}

console.log('\n[4] 本編との縁切り（戦績・波・死・自爆）');
{
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/mg, '');
  // 戦績・波・死のガードはチュートリアルと共用（形はcheck-tutorial.mjsの[6]が見る）。
  // ここでは訓練場側が確かにその共用ガードに乗っていることだけ見る
  ok(/if \(this\.tutorial \|\| this\.range\) return;/.test(src),
    '戦績のガードに訓練場も乗っている');
  ok(/!this\.range && this\.director\.wave === 0/.test(src),
    '波の起動ガードに訓練場も乗っている');
  // 手榴弾の自爆は訓練場だけノーダメ（チュートリアルは食らってから受け止める形）
  ok(/dm <= NADE\.BLAST_R && this\.player\.alive && !this\.range/.test(src),
    '爆風の自爆ダメージが訓練場では入らない');
  // 世界を戻す口が、ソロ開始・対戦参加・ホーム・チュートリアル開始の全経路に居る
  ok(/_enterSolo\(\) \{\s*this\._leaveTutorial\(\);\s*this\._leaveRange\(\);/.test(src),
    '_enterSoloで片付ける');
  ok(/_joinMatch\(\{ url, name \}\) \{\s*this\._leaveTutorial\(\);\s*this\._leaveRange\(\);/.test(src),
    '_joinMatchで片付ける');
  ok(/_goHome\(\) \{[\s\S]{0,240}?_leaveRange\(\);/.test(src), '_goHomeで片付ける');
  ok(/_enterTutorial\(\) \{\s*this\._leaveRange\(\);/.test(src),
    '_enterTutorialでも片付ける（訓練場→チュートリアルの直行）');
  ok(/_enterRange\(\) \{\s*this\._leaveTutorial\(\);/.test(src),
    '_enterRangeでも片付ける（逆の直行）');
  // 的あての差し替え口はチュートリアルと同じ物を使う（増えていたら二重管理の芽）
  const swaps = (src.match(/this\._shootables \?\? this\.director\.active/g) || []).length;
  ok(swaps === 2, `当たり先の差し替え口は2箇所のまま（今${swaps}）`);
  // 波の起動を止める順（_restartの後にInfinity）。逆だと1.5秒後に敵が湧く。
  // _restart();の後ろに行末コメントが残る（剥がすのは行頭コメントだけ）ので行またぎで見る
  ok(/_enterRange\(\) \{[\s\S]{0,900}?_restart\(\);[^\n]*\n\s*this\.director\.betweenWaves = Infinity;/.test(src),
    '_restartの後でbetweenWavesを止めている（順序が命）');
}

console.log('\n[5] 器の繋ぎ込み（HTML/メニュー/e2e）');
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const netmenuSrc = readFileSync(new URL('../src/ui/netmenu.js', import.meta.url), 'utf8');
  ok(/id="nmRange"/.test(html), 'ホームに訓練場のボタンがある');
  ok(/setBusy\(on\) \{[\s\S]{0,400}?range\.disabled = this\.busy/.test(netmenuSrc),
    '接続中は訓練場のボタンも止まる');
  ok(/onRange/.test(netmenuSrc), 'メニューに開く口(onRange)がある');
  const e2e = readFileSync(new URL('../e2e/boot.spec.mjs', import.meta.url), 'utf8');
  ok(/'nmRange'/.test(e2e), 'e2eがボタンの実在を見ている');
  // サーバーが読んでいない（訓練場は通信しない決まり）
  const { execSync } = await import('node:child_process');
  const hit = execSync(
    'grep -rl "range-level" server/ || true',
    { cwd: new URL('..', import.meta.url).pathname, encoding: 'utf8' },
  ).trim();
  ok(hit === '', `server/がrange-levelを読んでいない（${hit || '無し'}）`);
  // 材質の決まり（tutorial-level.jsと同じ2点）
  const lvlSrc = readFileSync(new URL('../src/world/range-level.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/mg, '');
  ok(!/addMacroVariation|addGroundBlend/.test(lvlSrc),
    '材質の混合層を二重適用していない');
  ok(!/\.clone\(/.test(lvlSrc), '材質をcloneしていない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
