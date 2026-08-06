// 買った（もらった）3Dモデルを、手元の武器の見た目として被せる口。
//
// **今の武器はコードで組んである。** 銃口・薬莢の出口・照準の位置が全部
// その組み立ての中で決まっていて、閃光も煙もそこへぶら下がっている。
// モデルを丸ごと差し替えると、その印まで消えて撃った時に何も出なくなる。
//
// なので**印は残して、見えている所だけ差し替える。**
//   ・手（userData.isHand）は残す … 銃だけ替わって手が消えると持っていないように見える
//   ・銃口などの印（Object3D、面を持たない）は残す … 閃光と煙の出所
//   ・面を持っている所だけ隠して、その場所へ読み込んだモデルを置く
//
// 読み込みは後から届く。**届かなくても遊べる**（コードで組んだ物のまま）。
// 素材ファイルを持たないゲームなので、ここで落ちると何も遊べなくなるのが一番痛い。
import * as THREE from 'three';

/* 置き場。ここに <武器のid>.glb を置くと、その武器だけ見た目が替わる。
   無ければ何も起きない（コードで組んだ物のまま）。
   /assets/ は既に外へ配る決まりに入っているので、置くだけで本番にも出る */
export const MODEL_DIR = 'assets/models';

/** その武器のモデルの置き場所 */
export const modelUrl = (id) => `${MODEL_DIR}/${id}.glb`;

/**
 * 面を持っている所だけ隠す。手と印は残す。
 *
 * **手を消してはいけない。** 銃だけ替わって手が消えると、
 * 宙に浮いた銃を見ることになる
 */
export function hideBuiltMeshes(inner) {
  const hidden = [];
  inner.traverse((o) => {
    if (!o.isMesh) return;
    // 手はそのまま。持ち替えの動きも手に付いている
    let onHand = false;
    for (let p = o; p; p = p.parent) {
      if (p.userData?.isHand) { onHand = true; break; }
      if (p === inner) break;
    }
    if (onHand) return;
    if (!o.visible) return;
    o.visible = false;
    hidden.push(o);
  });
  return hidden;
}

/**
 * 読み込んだモデルを、元の銃と同じ大きさ・向きへ合わせる。
 *
 * **モデルごとに向きも大きさもばらばら。** 買った物をそのまま置くと、
 * 10倍の大きさで横を向いた銃が目の前に出る。
 * 銃口の位置（元の組み立てが持っている印）を手掛かりにして銃身の長さを合わせ、
 * **細いほう（銃身）が前を向くように回す。**
 *
 * @param scene 読み込んだモデル
 * @param aimZ  元の銃の銃口のz（マイナスが前）。ここへ長さを合わせる
 */
export function fitModel(scene, aimZ) {
  scene.updateMatrixWorld(true);
  const pts = collectPoints(scene);
  if (!pts.length) return 1;

  // 一番長い向きを探す。銃はほぼ必ずその向きが銃身
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const p of pts) {
    for (let a = 0; a < 3; a++) {
      if (p[a] < min[a]) min[a] = p[a];
      if (p[a] > max[a]) max[a] = p[a];
    }
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const long = size[0] >= size[2] ? 0 : 2;   // 横長か、前後に長いか
  const span = size[long] || 1e-6;

  /* **どちらが銃口か。** 細いほうが銃身、太いほうが銃床と弾倉。
     ここを間違えると、銃が自分のほうを向いた状態で構えることになる
     （実際、最初の作りは向きを見ていなくて後ろ向きになった）。
     両端2割ずつの太さを比べる */
  const thickness = (from, to) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const t = (p[long] - min[long]) / span;
      if (t < from || t >= to) continue;
      if (p[1] < lo) lo = p[1];
      if (p[1] > hi) hi = p[1];
    }
    return hi > lo ? hi - lo : 0;
  };
  const headThin = thickness(0, 0.2) < thickness(0.8, 1);

  /* 細いほうを前（-z）へ向ける。
       横長 … 小さい側が細いなら -90度、大きい側が細いなら +90度
       前後長 … 小さい側が細いならそのまま、大きい側が細いなら180度 */
  if (long === 0) scene.rotation.y = headThin ? -Math.PI / 2 : Math.PI / 2;
  else scene.rotation.y = headThin ? 0 : Math.PI;

  // 銃身の長さへ合わせる。実寸のまま置くと、10倍の大きさの銃が目の前に出る
  const want = Math.abs(aimZ) * 1.35;
  const k = want / span;
  scene.scale.setScalar(k);

  // 真ん中を原点へ寄せる。寄せないと、モデルの原点次第で銃が視界の外へ飛ぶ
  const box = new THREE.Box3().setFromObject(scene);
  const c = new THREE.Vector3();
  box.getCenter(c);
  scene.position.sub(c);
  return k;
}

/* 頂点を世界の座標で集める。向きと太さを測るのに要る */
function collectPoints(scene) {
  const out = [];
  const v = new THREE.Vector3();
  scene.traverse((o) => {
    if (!o.isMesh || !o.geometry?.attributes?.position) return;
    const p = o.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
      out.push([v.x, v.y, v.z]);
    }
  });
  return out;
}

/**
 * モデルを読み込んで被せる。**失敗しても何も言わずに諦める。**
 *
 * 素材ファイルを持たないゲームなので、ここで例外を外へ出すと
 * 武器が1本も組み上がらないまま画面が止まる。
 *
 * @returns 被せられたか
 */
export async function tryModelOverride(weapon, id) {
  const inner = weapon?.inner;
  if (!inner) return false;
  let GLTFLoader;
  try {
    ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
  } catch { return false; }

  const url = modelUrl(id);
  let gltf = null;
  try {
    // 置いていない時は404が返る。**そこは普通のこと**なので黙って諦める
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) return false;
    gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
  } catch { return false; }
  if (!gltf?.scene) return false;

  const aimZ = inner.userData?.muzzle?.position?.z ?? -0.6;
  fitModel(gltf.scene, aimZ);
  // 銃口の少し後ろへ据える。銃口そのものへ置くと、モデルの真ん中が銃口へ来る
  gltf.scene.position.z += aimZ * 0.35;
  hideBuiltMeshes(inner);
  inner.add(gltf.scene);
  inner.userData.glb = gltf.scene;
  return true;
}
