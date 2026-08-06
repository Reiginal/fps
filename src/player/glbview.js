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

/* **モデルを置いてある武器の名前。ここに書いた物しか読みに行かない。**
   前は全部の武器について「あるかどうか」を毎回聞きに行っていた。
   置いてあるのが1本だけなので、**起動のたびに404が4回**返り、
   遊ぶ人の画面には毎回4行のエラーが並んでいた。
   本物のエラーがその中に紛れて読めなくなるし、無駄な往復が4回増える。

   モデルを足したら、ファイルを置くのと**ここに1行足すのを両方やる。**
   片方だけになっていないかは tools/check-weapons.mjs が見張る。

   **今は空。** CC0のライフル（Quaternius、676三角形・テクスチャ無し）を1本置いてみたが、
   構えて見比べたら**コードで組んだ物のほうが明らかに良かった**（あちらはスコープも
   機関部も肌理もある）。置いた物は細い棒にしか見えなかったので外した。
   口だけ残してある。今より良い物が見つかった時に、ファイルを置いて1行足せば入る */
export const HAS_MODEL = [];

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
 * **元の銃が占めていた箱へ収める。** 長さも置き場所もそこから決まる。
 * あわせて**細いほう（銃身）が前を向くように回す。**
 *
 * @param scene 読み込んだモデル
 * @param box   元の銃（手を除いた本体）が占めていた箱。ここへ収める
 */
export function fitModel(scene, box) {
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
     両端2割ずつの「長い向きに直交する断面の大きさ」を比べる。
     高さだけで比べると、銃身が太く見えるモデルで裏返る */
  const girth = (from, to) => {
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    let n = 0;
    for (const p of pts) {
      const t = (p[long] - min[long]) / span;
      if (t < from || t >= to) continue;
      for (let a = 0; a < 3; a++) {
        if (p[a] < lo[a]) lo[a] = p[a];
        if (p[a] > hi[a]) hi[a] = p[a];
      }
      n++;
    }
    if (!n) return 0;
    // 長い向きは除いて、残り2つの断面の大きさを掛ける
    let area = 1;
    for (let a = 0; a < 3; a++) if (a !== long) area *= Math.max(1e-6, hi[a] - lo[a]);
    return area;
  };
  const headThin = girth(0, 0.2) < girth(0.8, 1);

  /* 細いほうを前（-z）へ向ける。
       横長 … 小さい側が細いなら -90度、大きい側が細いなら +90度
       前後長 … 小さい側が細いならそのまま、大きい側が細いなら180度 */
  if (long === 0) scene.rotation.y = headThin ? -Math.PI / 2 : Math.PI / 2;
  else scene.rotation.y = headThin ? 0 : Math.PI;

  /* **元の銃が占めていた箱へ合わせる。**
     銃口の位置だけを手掛かりにしていた頃は、長さは合っても
     置き場所が原点のままで、構えた時に手から離れた所に浮いていた。
     元の銃の箱（手を除いた本体）の長さと中心が、そのまま答えになっている */
  const target = new THREE.Vector3();
  box.getSize(target);
  const k = (target.z || 0.9) / span;
  scene.scale.setScalar(k);

  const now = new THREE.Box3().setFromObject(scene);
  const c = new THREE.Vector3();
  now.getCenter(c);
  const want = new THREE.Vector3();
  box.getCenter(want);
  scene.position.add(want).sub(c);
  return k;
}

/**
 * 手を除いた「本体」の箱。読み込んだモデルはここへ収める。
 * 手まで入れると、箱が手のぶん広がって銃だけが大きくなる
 */
export function builtBox(inner) {
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3();
  inner.traverse((o) => {
    if (!o.isMesh) return;
    for (let p = o; p; p = p.parent) {
      if (p.userData?.isHand) return;
      if (p === inner) break;
    }
    box.expandByObject(o);
  });
  return box;
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
  // 置いていない武器は読みに行かない（聞きに行くだけで往復とエラーが増える）
  if (!HAS_MODEL.includes(id)) return false;
  let GLTFLoader;
  try {
    ({ GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js'));
  } catch { return false; }

  const url = modelUrl(id);
  let gltf = null;
  try {
    gltf = await new Promise((res, rej) => new GLTFLoader().load(url, res, undefined, rej));
  } catch { return false; }
  if (!gltf?.scene) return false;

  // **隠す前に測る。** 隠してからだと箱が空になって、置き場所が原点になる
  const box = builtBox(inner);
  fitModel(gltf.scene, box);
  hideBuiltMeshes(inner);
  inner.add(gltf.scene);
  inner.userData.glb = gltf.scene;
  return true;
}
