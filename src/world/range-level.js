// 射撃訓練場の小さいステージ。
//
// チュートリアルの通路(tutorial-level.js)と同じ理由で本編(level.js)と別ファイル:
//   ・level.jsを1行も触らない（サーバーが照合している地形の指紋を壊さない）
//   ・サーバーはこのファイルを読まない（訓練場は1人用で通信しない）
//
// 作りの決まりも通路と同じ（破ると静かに壊れる。tools/check-range.mjsが見張る）:
//   ・材質は渡されたmatsの**同じインスタンス**。cloneしない
//     （着弾音・足音の引き当てが材質インスタンスを鍵にしている）
//   ・addMacroVariation/addGroundBlendは呼ばない（uniformの二重適用で壊れる）
//   ・全ジオメトリにcolor属性を焼く（無いと真っ黒になる）
//
// 形は横長の屋外レンジ1部屋。手前に土嚢の射座、奥へ向かって的のレーンが
// 5本並ぶ。的そのものはここに居ない（main.jsがEnemyを置いて動かす）。
// ここが持つのはレーンの表(targetLanes)だけで、
// 「どの高さの帯をどの速さで往復するか」を数字で渡す。
//
// 軽さ: 箱を材質ごとに結合して数枚のメッシュ・数百三角形。
// 本編(18万三角形)の1%未満。チュートリアルと同じ考え方。

import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* 的のレーン。zが奥行き（射座の土嚢はz=+2、奥ほど遠い）、
   ampが左右の振れ幅(m)、speedが角速度(rad/s)、phaseは同時に折り返さないためのずらし。
   横へ動く速さの最大はamp×speed。全レーンを3〜4m/s（歩き〜小走り）に揃えてある。
   速すぎると未経験者が一発も当てられず、遅すぎると止まっているのと変わらない。
   振れ幅＋的の半径が壁の内側(±13)に収まることはcheck-range.mjsが実測する */
const LANES = [
  { x: 0, z: -4, amp: 4.0, speed: 1.0, phase: 0 },
  { x: 0, z: -10, amp: 5.5, speed: 0.7, phase: 1.3 },
  { x: 0, z: -16, amp: 7.0, speed: 0.5, phase: 2.6 },
  { x: 0, z: -22, amp: 8.5, speed: 0.42, phase: 3.9 },
  { x: 0, z: -28, amp: 10.0, speed: 0.34, phase: 5.2 },
];

// 面ごとの向きからUVを作る（tutorial-level.jsと同じ写し。理由もあちらと同じ）
function boxUV(geo, scale) {
  const pos = geo.attributes.position;
  const nor = geo.attributes.normal;
  const uv = geo.attributes.uv;
  const s = 1 / scale;
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i));
    const ny = Math.abs(nor.getY(i));
    const nz = Math.abs(nor.getZ(i));
    let u, v;
    if (nx >= ny && nx >= nz) { u = pos.getZ(i); v = pos.getY(i); }
    else if (ny >= nz) { u = pos.getX(i); v = pos.getZ(i); }
    else { u = pos.getX(i); v = pos.getY(i); }
    uv.setXY(i, u * s, v * s);
  }
  uv.needsUpdate = true;
}

export function buildRangeLevel(mats) {
  const root = new THREE.Group();
  const solids = new THREE.Group();
  root.add(solids);

  const byMat = new Map();
  const box = (mat, w, h, d, x, y, z, tint = 1) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    boxUV(geo, 2);
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3).fill(tint);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.translate(x, y, z);
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  };

  /* ---------------- 部屋。幅26m(x±13)・奥行き50m(z:+15〜-35) ----------------
     z+側に湧いて、-Z（奥）へ向かって撃つ。一番奥の壁が弾受け */

  // 床。上面がy=0
  box(mats.concrete, 27, 0.3, 50, 0, -0.15, -10, 0.95);
  // 左右の壁と前後の壁。高さ4m（手榴弾がぽんぽん場外へ出ない程度）
  box(mats.brick, 0.4, 4, 50, -13.2, 2, -10);
  box(mats.brick, 0.4, 4, 50, 13.2, 2, -10, 0.96);
  box(mats.concrete, 27.6, 4, 0.4, 0, 2, 15.2, 0.9);
  box(mats.concrete, 27.6, 4, 0.4, 0, 2, -35.2, 0.88);

  // 射座の土嚢（z=+2）。中央4mを開けて左右に置く。胸の高さの依託
  box(mats.sandbag, 5, 1.1, 0.8, -4.5, 0.55, 2, 1.05);
  box(mats.sandbag, 5, 1.1, 0.8, 4.5, 0.55, 2, 0.98);

  // 距離の目安の帯。レーンごとに床へ薄く敷く（0.06mは自動乗り越え0.58mの誤差内）
  let stripTint = 1.08;
  for (const l of LANES) {
    box(mats.wood, 24, 0.06, 0.35, 0, 0.03, l.z, stripTint);
    stripTint = stripTint === 1.08 ? 0.9 : 1.08;
  }

  for (const [mat, list] of byMat) {
    const merged = mergeGeometries(list, false);
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    solids.add(m);
  }

  // Octreeは素のまま組む（tutorial-level.jsと同じ理屈。数百三角形なら一瞬）
  const octree = new Octree();
  octree.fromGraphNode(solids);

  return {
    root,
    octree,
    solids,
    targetLanes: LANES,
    // enemySpawnsも埋めておく。的が場外へ落ちた時のEnemy側の保険
    // (enemy.jsの「-20より下でspawnし直す」)がここを読む
    enemySpawns: LANES.map((l) => new THREE.Vector3(l.x, 0, l.z)),
    arenaSpawns: [],
    coverPoints: [],
    playerSpawn: new THREE.Vector3(0, 1.2, 10),
    bounds: 45,
  };
}
