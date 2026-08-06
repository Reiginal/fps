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
 * 銃口の位置（元の組み立てが持っている印）を手掛かりにして、
 * 銃身の長さが合うように縮める。
 *
 * @param target 置き先（元のinner）
 * @param scene  読み込んだモデル
 * @param aimZ   元の銃の銃口のz（マイナスが前）。ここへ長さを合わせる
 */
export function fitModel(scene, aimZ) {
  const box = new THREE.Box3().setFromObject(scene);
  const size = new THREE.Vector3();
  box.getSize(size);
  const longest = Math.max(size.x, size.y, size.z, 1e-6);
  // 一番長い辺を銃身の長さへ合わせる。多くの銃モデルは長辺が銃身
  const want = Math.abs(aimZ) * 1.35;
  const k = want / longest;
  scene.scale.setScalar(k);

  // 中心を原点へ寄せてから、銃口が前（-z）へ来るように置く。
  // モデルによっては長辺がxのことがあるので、その時は回す
  if (size.x > size.z) scene.rotation.y = Math.PI / 2;
  const box2 = new THREE.Box3().setFromObject(scene);
  const c = new THREE.Vector3();
  box2.getCenter(c);
  scene.position.sub(c);
  return k;
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
