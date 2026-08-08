// チュートリアル専用の小さい通路。
//
// なぜ本編の地形(level.js)と別ファイルか:
//   ・level.jsの配置ヘルパーは全部buildLevelのクロージャの中にあり、
//     外へ出すとサーバーが照合している地形の指紋(server/world.jsのEXPECT)を
//     壊すリスクがある。ここに必要最小限だけ書けば、level.jsは1行も触らない
//   ・サーバーはこのファイルを一切読まない（チュートリアルは1人用で通信しない）
//
// 作りの決まり（破ると静かに壊れる。tools/check-tutorial.mjsが見張る）:
//   ・材質は渡されたmatsの**同じインスタンス**を使う。cloneしない。
//     main.jsの着弾音・足音の引き当て(kindOf/surfaceOf)が材質インスタンスを
//     鍵にしているので、同じ物なら火花も音も無償で付いてくる
//   ・addMacroVariation/addGroundBlendは呼ばない。buildLevelが同じインスタンスへ
//     適用済みなので、もう一度呼ぶとシェーダに同じuniformが二重に入って壊れる
//   ・全ジオメトリにcolor属性を焼く。全材質がvertexColors=trueで動いているので、
//     色の無いジオメトリを混ぜるとそこだけ真っ黒になる
//
// 軽さ: 箱を材質ごとに結合して数枚のメッシュにする。三角形は数百。
// 本編(18万三角形)の1%未満なので、未経験者の非力な端末でも確実に動く。

import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/* 通路の寸法。プレイヤーの身体能力(player.js)から決めてある:
   ・ジャンプの段: 高さ0.8m。**0.58m以下だと歩くだけで自動で登れてしまい**
     （STEP_HEIGHT=0.58の乗り越え処理）、ジャンプを教えられない。
     跳躍の頂点はJUMP_VEL²/2G = 6.6²/44 = 0.99mなので、0.8mは跳べば越えられる
   ・くぐり梁: 下端1.25m。立ち姿は1.74mで詰まり、しゃがみ1.06mは19cm余裕で通る */
const JUMP_BOX_H = 0.8;
const BEAM_UNDER = 1.25;

// 面ごとの向きからUVを作る（level.jsのapplyBoxUVと同じ式の写し。
// あちらはクロージャ外だがexportされていない。40行未満なので写す方が安い）
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

export function buildTutorialLevel(mats) {
  const root = new THREE.Group();
  const solids = new THREE.Group();
  root.add(solids);

  // 材質ごとにジオメトリを溜めて、最後に1枚へ結合する（描画1回=1材質）
  const byMat = new Map();
  const box = (mat, w, h, d, x, y, z, tint = 1) => {
    const geo = new THREE.BoxGeometry(w, h, d);
    boxUV(geo, 2);
    /* 頂点カラー。素の1.0で塗ると本編の焼き込みに比べてのっぺりするので、
       箱ごとにほんの少し明暗を散らす（同じ材質の箱が繋がって見えなくなる） */
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3).fill(tint);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.translate(x, y, z);
    if (!byMat.has(mat)) byMat.set(mat, []);
    byMat.get(mat).push(geo);
  };

  /* ---------------- 通路そのもの。幅8m(x±4)・長さ50m(z:+20〜-30) ----------------
     zの+側で湧いて-側へ進む一本道。課題の並び(tutorial.jsの表)と同じ順に
     仕掛けが現れる: 歩く→走る→跳ぶ→くぐる→撃つ */

  // 床。1枚の箱。上面がy=0
  box(mats.concrete, 8, 0.3, 50, 0, -0.15, -5, 0.95);
  // 左右の壁と前後の壁。高さ3.5m
  box(mats.brick, 0.4, 3.5, 50, -4.2, 1.75, -5);
  box(mats.brick, 0.4, 3.5, 50, 4.2, 1.75, -5);
  box(mats.concrete, 8.8, 3.5, 0.4, 0, 1.75, 20.2, 0.9);
  box(mats.concrete, 8.8, 3.5, 0.4, 0, 1.75, -30.2, 0.9);

  // ジャンプの段差×2（z=+4と0）。通路の全幅を塞ぐので跳ぶしかない
  box(mats.wood, 8, JUMP_BOX_H, 1.6, 0, JUMP_BOX_H / 2, 4, 1.05);
  box(mats.wood, 8, JUMP_BOX_H, 1.6, 0, JUMP_BOX_H / 2, 0, 0.98);

  // くぐり梁（z=-4）。下端1.25mで全幅を塞ぐ。しゃがむしかない
  box(mats.rustMetal, 8, 0.5, 1.4, 0, BEAM_UNDER + 0.25, -4);

  // 射撃線の土嚢（z=-8）。中央2mを開けて左右に置く。胸の高さの遮蔽
  box(mats.sandbag, 3, 1.1, 0.8, -2.5, 0.55, -8, 1.05);
  box(mats.sandbag, 3, 1.1, 0.8, 2.5, 0.55, -8, 1.05);

  for (const [mat, list] of byMat) {
    const merged = mergeGeometries(list, false);
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    solids.add(m);
  }

  /* Octreeは素のまま組む。level.jsのbuildOctreeはLEAF_TRISで深さを抑える
     パッチを差すが、あれは18万三角形をヒープ96MBで組むための物。
     ここは数百三角形なので素で組んでも一瞬で浅い */
  const octree = new Octree();
  octree.fromGraphNode(solids);

  return {
    root,
    octree,
    solids,
    // 的の置き場。左右にずらして、狙いを動かす練習になる並びにする。
    // enemySpawnsの名前なのは、本編のlevelと同じ形にして
    // Player/Director/Effectsがそのまま食えるようにするため
    enemySpawns: [
      new THREE.Vector3(-2, 0, -14),
      new THREE.Vector3(0, 0, -20),
      new THREE.Vector3(2, 0, -26),
    ],
    arenaSpawns: [],
    coverPoints: [],
    playerSpawn: new THREE.Vector3(0, 1.2, 18),
    bounds: 40,
  };
}
