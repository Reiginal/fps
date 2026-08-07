// キャラクター選択の検査。
//
// この仕組みは「姿そのものは送らず、番号だけ送る。番号から同じ姿を組み直す」
// という作りなので、**同じ番号から違う姿が出た瞬間に破綻する。**
// しかもその壊れ方は、自分の画面と相手の画面で違う人が立っているという形で出る。
// 遊んでいる本人にはまず気づけないので、ここで測る。
//
//   node tools/check-character.mjs
import '../server/dom-stub.js';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CHARACTERS, characterAt } from '../src/net/protocol.js';

const { buildLevel } = await import('../src/world/level.js');
const { Enemy } = await import('../src/ai/enemy.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const MAT = new THREE.MeshStandardMaterial();
const level = buildLevel(new Proxy({}, { get: () => MAT }));

// 姿を決めている値だけを取り出す。ここが同じなら同じ人が組み上がる
const shape = (v) => [
  v.camo.fatigue, v.skin, v.headGear, v.weapon,
  v.scale.toFixed(4), v.width.toFixed(4), v.stance,
  v.faceCover, v.plateCarrier, v.coverHelmet, v.pouches,
  v.pack, v.radio, v.chevron, v.canteen, v.holster, v.optic,
  v.uvOff.x.toFixed(4), v.uvOff.y.toFixed(4),
].join('|');

const variantOf = (seed) => new Enemy(level, { seed }).variant;

console.log('\n[1] 同じ番号からは必ず同じ姿が出る');
for (let i = 0; i < CHARACTERS.length; i++) {
  const seed = characterAt(i).seed;
  const a = shape(variantOf(seed));
  const b = shape(variantOf(seed));
  ok(a === b, `${i}番「${CHARACTERS[i].name}」… 2回組んでも同じ`);
}

console.log('\n[2] 番号ごとに姿が違う');
// 同じ姿が2つ並ぶと、選ぶ意味が無いうえ、対戦で相手と自分を取り違える
const shapes = CHARACTERS.map((c) => shape(variantOf(c.seed)));
const uniq = new Set(shapes);
ok(uniq.size === CHARACTERS.length, `${CHARACTERS.length}種類とも別の姿（重複なし）`);

console.log('\n[3] 見た目がひと目で見分けられる');
// 色だけ違う6人だと、撃ち合いの最中には区別が付かない。
// 迷彩・かぶり物・武器の3つで、どれか2つは散っていてほしい
const camos = new Set(CHARACTERS.map((c) => variantOf(c.seed).camo.fatigue));
const heads = new Set(CHARACTERS.map((c) => variantOf(c.seed).headGear));
const weps = new Set(CHARACTERS.map((c) => variantOf(c.seed).weapon));
ok(camos.size >= 2, `迷彩が${camos.size}系統に散っている`);
ok(heads.size >= 3, `かぶり物が${heads.size}種類に散っている`);
ok(weps.size >= 2, `武器が${weps.size}種類に散っている`);

console.log('\n[3.5] 画面に出す名前が、実際の姿と合っている');
// 名前は手で書いた文字列なので、種を差し替えた時にここだけ古いまま残る。
// 「タン」と書いてある物が緑で出てくると、選ぶ側は毎回裏切られる
const CAMO_NAME = { 0x5f6a4a: 'オリーブ', 0x7a6949: 'タン', 0x5e626b: 'グレー' };
const HEAD_NAME = ['ヘルメット', 'ブーニー', 'キャップ', '素頭'];
for (let i = 0; i < CHARACTERS.length; i++) {
  const c = CHARACTERS[i];
  /* 外部モデルの枠は、見た目がGLBから来るので迷彩の名前・色と対応しない。
     この枠の実物が壊れていないかは[8]が実物を読んで見ている */
  if (c.model) continue;
  const v = variantOf(c.seed);
  const camo = CAMO_NAME[v.camo.fatigue];
  const head = HEAD_NAME[v.headGear];
  ok(
    c.name === `${camo}／${head}`,
    `${i}番の名前「${c.name}」… 実物は「${camo}／${head}」`,
  );
  // 色の四角も迷彩に合わせる。ここがずれると、色で選んだ人が別の色で出てくる
  ok(
    c.color.toLowerCase() === `#${v.camo.fatigue.toString(16).padStart(6, '0')}`,
    `${i}番の色 ${c.color} が迷彩と一致`,
  );
}

console.log('\n[4] 選んだ物で強さが変わらない');
// 見た目に強さが乗ると、選ぶ物で有利不利が出る。
// 当たり判定の太さは全員同じで、背丈だけ個体差がある（当たり判定は太さで決まる）
const radii = new Set(CHARACTERS.map((c) => new Enemy(level, { seed: c.seed }).radius));
ok(radii.size === 1, `当たり判定の太さは全員同じ（${[...radii][0]}m）`);

console.log('\n[5] 知らない番号が来ても姿が消えない');
// 古い版の相手や、壊れた電文から範囲外の番号が来ることがある
ok(characterAt(-1) === CHARACTERS[0], '負の番号は0番へ寄せる');
ok(characterAt(999) === CHARACTERS[0], '大きすぎる番号も0番へ寄せる');
ok(characterAt(undefined) === CHARACTERS[0], '番号が無くても0番になる');

console.log('\n[6] ロビーの3Dが、試合中も描き続けないか');
// 止め忘れると、遊んでいる裏で2つ目の場面をずっと描くことになる。
// 画面を見ても気づけない（絵は隠れている）のに、パソコンだけ熱くなる。
// ロビーを畳む場所は複数あるので、そのどれからも止まることを文字で確かめる
{
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const hides = (src.match(/lobby\.hide\(\)/g) || []).length;
  const stops = (src.match(/charView\?\.stop\(\)/g) || []).length;
  ok(hides > 0, `ロビーを畳む場所が${hides}箇所ある`);
  ok(stops >= hides, `そのどれでも3Dを止めている（止める記述 ${stops}箇所）`);
  // 描く側も、止まっている間は何もしないこと
  const view = readFileSync(new URL('../src/ui/charview.js', import.meta.url), 'utf8');
  ok(/if \(!this\.running/.test(view), '止まっている間は描かない');
}

console.log('\n[7] ロビーのプレビューに、兵士が丸ごと収まっている');
// 遊んで「見た目のやつが見切れてる」と言われた所。
//
// 収まらない理由は2つあって、**どちらも兵士の一部なので切るわけにいかない**:
//   ・無線のアンテナが2.37mまで伸びている（身長1.74mより63cm上）
//   ・ライフルが中心から1.04m出ていて、回ると横へ大きく振れる
// 直す前は頂点の8.6%が枠の外にあり、背丈だけで画面の107%を占めていた。
//
// canvasの大きさとカメラの置き方はコードに直書きしてあるので、
// 両方をソースから読み取って、実際に投影して測る。
// **片方だけ直すと必ずずれる**（canvasを縦長に戻せば、回ったライフルがまた出る）
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const view = readFileSync(new URL('../src/ui/charview.js', import.meta.url), 'utf8');

  const cv = html.match(/id="lbView"\s+width="(\d+)"\s+height="(\d+)"/);
  ok(!!cv, 'index.html から canvas の大きさが読める');
  const pos = view.match(/camera\.position\.set\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/);
  const look = view.match(/camera\.lookAt\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)/);
  const fovM = view.match(/PerspectiveCamera\((\d+)/);
  ok(!!pos && !!look && !!fovM, 'charview.js からカメラの置き方が読める');

  if (cv && pos && look && fovM) {
    const W = +cv[1], H = +cv[2];
    const cam = new THREE.PerspectiveCamera(+fovM[1], W / H, 0.1, 20);
    cam.position.set(+pos[1], +pos[2], +pos[3]);
    cam.lookAt(+look[1], +look[2], +look[3]);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);

    // ロビーでは回り続けるので、1周ぶん試して一番はみ出す角度で判定する。
    // 正面だけ見て通していたら、横を向いた時にライフルが出るのを見逃す
    const SPIN = 12;
    let out = 0, total = 0, top = -9, bottom = 9, side = 0, headTop = -9, footLow = 9;
    const v = new THREE.Vector3();
    for (let i = 0; i < CHARACTERS.length; i++) {
      const e = new Enemy(level, { seed: characterAt(i).seed });
      e.root.position.set(0, 0, 0);
      e.root.rotation.y = 0;
      e.root.updateMatrixWorld(true);
      const pts = [];
      e.root.traverse((m) => {
        if (!m.isMesh || !m.geometry?.attributes?.position) return;
        if (m === e.blob) return;         // 足元の暗がりはロビーでは消してある
        let vis = m.visible;
        for (let o = m.parent; o && vis; o = o.parent) vis = o.visible;
        if (!vis) return;
        const p = m.geometry.attributes.position;
        for (let k = 0; k < p.count; k += 3) {
          v.fromBufferAttribute(p, k).applyMatrix4(m.matrixWorld);
          pts.push(v.x, v.y, v.z);
        }
      });
      for (let s = 0; s < SPIN; s++) {
        const a = (s / SPIN) * Math.PI * 2;
        const cos = Math.cos(a), sin = Math.sin(a);
        for (let k = 0; k < pts.length; k += 3) {
          const x = pts[k], y = pts[k + 1], z = pts[k + 2];
          v.set(x * cos + z * sin, y, -x * sin + z * cos).project(cam);
          total++;
          if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) out++;
          top = Math.max(top, v.y); bottom = Math.min(bottom, v.y);
          side = Math.max(side, Math.abs(v.x));
          if (y > 1.60 && y < 1.80) headTop = Math.max(headTop, v.y);
          if (y < 0.05) footLow = Math.min(footLow, v.y);
        }
      }
    }
    const pct = (out / total) * 100;
    ok(pct === 0, `枠の外に出ている頂点 ${pct.toFixed(1)}%（元は8.6%）`);
    ok(
      top <= 1 && bottom >= -1 && side <= 1,
      `上端 ${top.toFixed(2)} 下端 ${bottom.toFixed(2)} 左右 ${side.toFixed(2)}（±1が枠）`,
    );
    // 収めるだけなら遠ざければいくらでも収まるが、それでは何を選んでいるか分からない。
    // 背丈が画面の半分は無いと、迷彩の違いが読めない
    const bodyH = (headTop - footLow) / 2 * 100;
    ok(bodyH > 50, `兵士の背丈が画面の${bodyH.toFixed(0)}%（50%以上）`);
  }
}

console.log('\n[8] 外部モデルの枠（model欄が付いた物）');
/* CHARACTERSにmodel:'soldier'と書くと、その枠だけ外部のGLB
   (assets/models/<model>.glb)で出る。書いたのにファイルが無い・
   クリップの名前が違う・頭の骨が見つからない、のどれでも
   **黙ってコード製の代役に落ちる**作りなので、壊れても画面には何も出ない。
   ここで実物を読んで確かめる */
{
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const withModel = CHARACTERS.filter((c) => c.model);
  ok(withModel.length > 0, `外部モデルの枠が ${withModel.length} 個ある`);
  for (const c of withModel) {
    const path = new URL(`../assets/models/chars/${c.model}.glb`, import.meta.url);
    let buf = null;
    try { buf = readFileSync(path); } catch { /* 下で落とす */ }
    ok(!!buf, `${c.model}.glb … ファイルが置いてある`);
    if (!buf) continue;

    const gltf = await new Promise((res, rej) => new GLTFLoader().parse(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej,
    )).catch(() => null);
    ok(!!gltf, `${c.model}.glb … GLBとして読める`);
    if (!gltf) continue;

    // glbchar.jsが名前で引くクリップ。1本でも欠けると歩様が混ざらない
    const names = gltf.animations.map((a) => a.name);
    for (const need of ['Idle', 'Walk', 'Run']) {
      ok(names.includes(need), `${c.model} … クリップ ${need} がある（${names.join('、')}）`);
    }

    let skinned = null;
    let head = null;
    gltf.scene.traverse((o) => {
      if (o.isSkinnedMesh && !skinned) skinned = o;
      if (o.isBone && /Head$/.test(o.name)) head = o;
    });
    ok(!!skinned, `${c.model} … スキンメッシュがある（無いと骨で動かない）`);
    ok(!!head, `${c.model} … 頭の骨がある（名札と銃声の位置に使う）`);

    gltf.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(gltf.scene);
    const h = box.max.y - box.min.y;
    ok(h > 1.4 && h < 2.2, `${c.model} … 人の背丈の範囲（${h.toFixed(2)}m）`);

    /* 前が-zを向いていること。つま先の骨が腰よりも-z側に出ているかで測る。
       裏返っていると、全員が後ろ歩きで詰めてくる画になる */
    if (skinned) {
      const v = new THREE.Vector3();
      const bone = (re) => skinned.skeleton.bones.find((b) => re.test(b.name));
      const toe = bone(/ToeBase/);
      const hips = bone(/Hips/);
      if (toe && hips) {
        toe.getWorldPosition(v); const toeZ = v.z;
        hips.getWorldPosition(v); const hipsZ = v.z;
        ok(toeZ < hipsZ, `${c.model} … 前が-zを向いている（つま先z=${toeZ.toFixed(2)} 腰z=${hipsZ.toFixed(2)}）`);
      }
    }
  }
}

console.log('\n[9] 1人プレイの敵も外部モデルの見た目で出る（試験）');
/* 見た目だけGLBへ差し替えて、判定と銃口はコード製の骨(隠したまま動く)から取る作り。
   壊れると黙ってコード製に落ちるので、ここで実物を流し込んで確かめる。
   ブラウザの外ではURLを読めないため、ファイルを自分で読んでprimeで流し込む */
{
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const { primeCharModel, charModelReady, SOLO_MODEL } = await import('../src/ai/glbchar.js');
  ok(!!SOLO_MODEL, `1人プレイ用のモデル名がある（${SOLO_MODEL}）`);

  // 流し込む前はコード製のまま（読み込みが失敗した時と同じ道）
  const before = new Enemy(level, { seed: 1 });
  before.spawn(level.enemySpawns[0]);
  ok(before.meshes.some((m) => m.visible), '届いていない間はコード製の見た目のまま');
  ok(!before._glbVis, '外部モデルは付いていない');

  const buf = readFileSync(new URL(`../assets/models/chars/${SOLO_MODEL}.glb`, import.meta.url));
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', res, rej,
  ));
  primeCharModel(SOLO_MODEL, { scene: gltf.scene, clips: gltf.animations });
  ok(charModelReady(SOLO_MODEL), '流し込んだら使える扱いになる');

  const e = new Enemy(level, { seed: 1 });
  e.spawn(level.enemySpawns[0]);
  ok(!!e._glbVis, '外部モデルが付いた');
  ok(e._glbVis.root.parent === e.root, '体(root)へぶら下がっている＝位置と向きが一緒に動く');

  // 体は隠れるが、**銃だけは見えたまま残る**（丸腰で撃つ嘘を作らない）。
  // 銃は隠れた骨に付いていて、狙い・跳ね・死んだら落とす、が全部生きている
  const underGun = (m) => {
    for (let o = m; o; o = o.parent) if (o === e.parts.gun) return true;
    return false;
  };
  const body = e.meshes.filter((m) => !underGun(m));
  const gunMeshes = e.meshes.filter(underGun);
  ok(body.length > 0 && body.every((m) => !m.visible), `コード製の体の面は全部隠れた（${body.length}枚）`);
  ok(gunMeshes.length > 0 && gunMeshes.every((m) => m.visible), `銃の面は見えている（${gunMeshes.length}枚）`);

  // 判定は今まで通り、見えない骨から取れること
  e.root.updateMatrixWorld(true);
  e._syncHitboxesFromBones();
  const headY = e._headPos.y - level.enemySpawns[0].y;
  ok(headY > 1.2 && headY < 2.1, `頭の判定が今まで通りの高さにある（足元から${headY.toFixed(2)}m）`);

  // クリップが実際に骨を動かすこと（腰の骨の位置がアニメで変わる）
  const hips = e._glbVis.root.getObjectByName('mixamorigHips')
    || (() => { let b = null; e._glbVis.root.traverse((o) => { if (o.isBone && /Hips/.test(o.name) && !b) b = o; }); return b; })();
  ok(!!hips, '腰の骨が複製の中にもある');
  const v0 = new THREE.Vector3();
  const v1 = new THREE.Vector3();
  e._glbVis.mix(1, 1);          // 走りに全振り
  e._glbVis.mixer.update(0.01);
  e.root.updateMatrixWorld(true);
  hips.getWorldPosition(v0);
  e._glbVis.mixer.update(0.3);  // 走りの周期の半分近く進める
  e.root.updateMatrixWorld(true);
  hips.getWorldPosition(v1);
  ok(v0.distanceTo(v1) > 0.001, `クリップで骨が動く（${(v0.distanceTo(v1) * 1000).toFixed(1)}mm動いた）`);

  // 倒すと体ごと倒れて、待機の再生が止まる（死体が呼吸しない）。
  // コード製の死に方がrootを回すぶんと、見た目の入れ物が補うぶんの**合計**が
  // 90度あたりに収まること（片方だけ見ると、二重に回って裏返っていても通ってしまう。
  // 実際に裏返っていた）
  e.hit(9999, 'chest', new THREE.Vector3(0, 0, -1));
  ok(!e.alive, '倒れた');
  for (let i = 0; i < 90; i++) e._updateDeath(1 / 60);
  const total = Math.abs(e.root.rotation.x + e._glbVis.root.rotation.x);
  ok(total > 1.2 && total < 2.0, `合計でちょうど倒れている（root+見た目=${total.toFixed(2)}rad）`);
  ok(e._glbVis.mixer.timeScale === 0, '倒れた後はアニメが止まっている');

  // 湧き直したら立ち姿へ戻る
  e.spawn(level.enemySpawns[0]);
  ok(e._glbVis.root.rotation.x === 0 && e._glbVis.mixer.timeScale === 1, '湧き直すと立ち姿へ戻る');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
