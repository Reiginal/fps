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

/* 場所の割り振り。**課題の並び(tutorial.jsの表)と1対1で対応する。**

   前は50mの一本道に仕掛けを詰めていて、遊んで3つ怒られた:
     ・視点の課題に狙う物が無かった（「合計これだけマウスを動かす」だけ）
     ・S/A/Dが2mずつしか無く、練習になる幅を用意していなかった
     ・**スライディングが梁のすぐ後ろ**で、助走が2mしか無かった
   なので「その場で覚える広場」と「走って覚える通路」に分けてある。

   ここの数字を動かしたら、tutorial.jsのgoalZも一緒に動かすこと。
   噛み合っているかは tools/check-tutorial.mjs の [3] が実際に組んで測る */
const L = {
  // 練習広場。マウスとWASDをここで全部やる。**広いのが仕事。**
  // 20m×22mあるので、6m動く課題を壁際から始めても行き先に困らない
  YARD_X: 10,
  YARD_FAR: 12,      // 広場と通路の境
  YARD_NEAR: 34,     // 広場の後ろの壁
  // 通路。ここから先は一本道
  HALL_X: 4,
  HALL_END: -56,
  // 走りと滑り込みの助走路。境(12)から最初の段(-16)まで28mの直線。
  // **滑り込みはここでやる。** 走り12m＋滑り6mでも10m余る
  JUMP_A: -16,
  JUMP_B: -20,
  BEAM: -24,
  // ナイフで歩く区間。梁の奥から土嚢まで14m空けてある（課題は8m）
  SANDBAG: -40,
  TARGETS: [-46, -49, -52],
  SPAWN_Z: 26,
};

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

  /* ------------------------------- 練習広場（マウスとWASD） -------------------------------
     湧いた所。**ここでは1歩も先へ進めなくてよい。** 見回す・4方向に歩く・
     歩きながら見る、を全部この中で終わらせる */

  const yardLen = L.YARD_NEAR - L.YARD_FAR;
  const yardMid = (L.YARD_NEAR + L.YARD_FAR) / 2;
  box(mats.concrete, L.YARD_X * 2, 0.3, yardLen, 0, -0.15, yardMid, 0.95);
  box(mats.brick, 0.4, 3.5, yardLen, -L.YARD_X - 0.2, 1.75, yardMid);
  box(mats.brick, 0.4, 3.5, yardLen, L.YARD_X + 0.2, 1.75, yardMid);
  box(mats.concrete, L.YARD_X * 2 + 0.8, 3.5, 0.4, 0, 1.75, L.YARD_NEAR + 0.2, 0.9);
  /* 広場と通路の境の壁。**真ん中だけ通路の幅ぶん開ける。**
     開けておかないと、広場の課題が終わっても先へ進めない */
  const sideW = L.YARD_X - L.HALL_X;
  for (const sx of [-1, 1]) {
    box(mats.concrete, sideW, 3.5, 0.4, sx * (L.HALL_X + sideW / 2), 1.75, L.YARD_FAR, 0.9);
  }

  /* ------------------------------- 通路（走る・跳ぶ・撃つ） ------------------------------- */

  const hallLen = L.YARD_FAR - L.HALL_END;
  const hallMid = (L.YARD_FAR + L.HALL_END) / 2;
  box(mats.concrete, L.HALL_X * 2, 0.3, hallLen, 0, -0.15, hallMid, 0.95);
  box(mats.brick, 0.4, 3.5, hallLen, -L.HALL_X - 0.2, 1.75, hallMid);
  box(mats.brick, 0.4, 3.5, hallLen, L.HALL_X + 0.2, 1.75, hallMid);
  box(mats.concrete, L.HALL_X * 2 + 0.8, 3.5, 0.4, 0, 1.75, L.HALL_END - 0.2, 0.9);

  // ジャンプの段差×2。通路の全幅を塞ぐので跳ぶしかない
  box(mats.wood, 8, JUMP_BOX_H, 1.6, 0, JUMP_BOX_H / 2, L.JUMP_A, 1.05);
  box(mats.wood, 8, JUMP_BOX_H, 1.6, 0, JUMP_BOX_H / 2, L.JUMP_B, 0.98);

  // くぐり梁。下端1.25mで全幅を塞ぐ。しゃがむしかない
  box(mats.rustMetal, 8, 0.5, 1.4, 0, BEAM_UNDER + 0.25, L.BEAM);

  // 射撃線の土嚢。中央2mを開けて左右に置く。胸の高さの遮蔽
  box(mats.sandbag, 3, 1.1, 0.8, -2.5, 0.55, L.SANDBAG, 1.05);
  box(mats.sandbag, 3, 1.1, 0.8, 2.5, 0.55, L.SANDBAG, 1.05);

  for (const [mat, list] of byMat) {
    const merged = mergeGeometries(list, false);
    const m = new THREE.Mesh(merged, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    solids.add(m);
  }

  /* ------------------------------- 狙う的と、歩く先の線 -------------------------------

     **ここだけ渡された材質を使わない。** 上の箱は「地形」で、こちらは「案内」。
     光の当たり方で暗くなると案内にならないので、光を無視する材質(Basic)で塗る。
     色は2つだけ作って全部の的で使い回す（材質が増えると描画の切り替えが増える）。

     衝突には入れない（solidsへ入れない＝Octreeに乗らない）。
     案内の板に体が引っかかったら、それは案内ではなく障害物 */
  const guides = new THREE.Group();
  root.add(guides);
  /* 案内はレイに引っ掛けない。main.jsは見えているメッシュへレイを飛ばして
     着弾の火花と音の材質を引き当てるので、案内の板が混ざると
     **案内を撃った時だけ材質の分からない着弾**になる。
     衝突(Octree)にも入れていないので、これで完全に「見えるだけ」になる */
  const noHit = (m) => { m.raycast = () => {}; return m; };
  const matPending = new THREE.MeshBasicMaterial({ color: 0xffa24a });
  const matDone = new THREE.MeshBasicMaterial({ color: 0x4ce08f });
  const matLine = new THREE.MeshBasicMaterial({
    color: 0x63d2ff, transparent: true, opacity: 0.55,
  });

  /* 狙う的。**上下左右にはっきり散らす。** マウスに慣れていない人に
     「まわりを見て」と言っても何をすれば正解か分からないので、
     4枚を順に狙わせて「思った所へ照準を持っていく」だけをやってもらう。
     湧いた所(0, 目の高さ, SPAWN_Z)から見て、上11度・下10度・左右52度になる置き方 */
  const eyeZ = L.SPAWN_Z;
  const aimSpec = [
    { id: 'up', x: 0, y: 3.2, z: eyeZ - 8 },
    { id: 'down', x: 0, y: 0.38, z: eyeZ - 7 },
    { id: 'left', x: -6.5, y: 1.6, z: eyeZ - 5 },
    { id: 'right', x: 6.5, y: 1.6, z: eyeZ - 5 },
    /* 歩きながら狙う2枚。**通り過ぎる横に置く。**
       正面に置くとまっすぐ歩くだけで照準が乗ってしまい、
       「歩きながら視点を変える」にならない */
    { id: 'passL', x: -8.5, y: 1.6, z: eyeZ - 9 },
    { id: 'passR', x: 8.5, y: 1.6, z: eyeZ - 9 },
  ];
  const aimTargets = aimSpec.map((t) => {
    const geo = new THREE.BoxGeometry(0.7, 0.7, 0.12);
    const mesh = noHit(new THREE.Mesh(geo, matPending));
    mesh.position.set(t.x, t.y, t.z);
    // 板の面を湧き地点へ向ける。横の的が線にしか見えないのを避ける
    mesh.lookAt(0, t.y, eyeZ);
    guides.add(mesh);
    return { id: t.id, mesh, pos: mesh.position.clone() };
  });

  /* 歩く先の線。**「6m」がどのくらいかを目で見せる。**
     数字だけ出しても、FPSが初めての人には1mの見当が付かない */
  const lineGeos = [];
  const line = (w, d, x, z) => {
    const g = new THREE.BoxGeometry(w, 0.02, d);
    g.translate(x, 0.012, z);
    lineGeos.push(g);
  };
  const REACH = 6;
  line(5, 0.18, 0, eyeZ - REACH);   // W
  line(5, 0.18, 0, eyeZ + REACH);   // S
  line(0.18, 5, -REACH, eyeZ);      // A
  line(0.18, 5, REACH, eyeZ);       // D
  guides.add(noHit(new THREE.Mesh(mergeGeometries(lineGeos, false), matLine)));


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
      new THREE.Vector3(-2, 0, L.TARGETS[0]),
      new THREE.Vector3(0, 0, L.TARGETS[1]),
      new THREE.Vector3(2, 0, L.TARGETS[2]),
    ],
    arenaSpawns: [],
    coverPoints: [],
    playerSpawn: new THREE.Vector3(0, 1.2, L.SPAWN_Z),
    bounds: 70,
    // 課題の座標が噛み合っているかを検査から測るために出す（tools/check-tutorial.mjs）
    layout: { ...L },
    /* 狙う的。main.jsが毎フレーム「今どれに照準が乗っているか」を見て、
       進行係(tutorial.js)へidを渡す */
    aimTargets,
    /* 狙えた的を緑にする。**できたことが画で分かるのが仕事。**
       文字だけだと、当たっているのか外しているのかが読めない */
    setAimDone(id, on) {
      const t = aimTargets.find((a) => a.id === id);
      if (t) t.mesh.material = on ? matDone : matPending;
    },
    resetAim() {
      for (const t of aimTargets) t.mesh.material = matPending;
    },
  };
}
