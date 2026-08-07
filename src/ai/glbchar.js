// 外部の3Dモデル(スキン+アニメクリップ入りGLB)を、キャラの見た目として使う口。
//
// 兵士の姿はコードで組んである(enemy.jsのbuildSoldier)。それが基本形で、
// ここは「選べる見た目のうち1枠だけ、外部モデルで出す」試験の口。
// CHARACTERSの表に model:'soldier' と書いた枠だけがここを通る。
//
// **武器(glbview.js)と作りが根本から違う。** 武器は剛体なので「元の箱に収める」
// 力技で済んだが、キャラは歩く・しゃがむ・倒れる。コード製の骨(parts)へ被せる形は
// 骨格が別物なので取れない。**モデル自身の骨格とアニメクリップをそのまま再生する。**
// 何が難しいかは issue #56 に整理してある。
//
// 読み込みは後から届く。届くまで(と失敗した時)はコード製の兵士のまま出る。
// 素材ファイルが無くても遊べる、はこのrepoの決まり(glbview.jsと同じ)。
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

/* キャラのモデルの置き場。**武器(assets/models直下)とは分けてある。**
   tools/check-weapons.mjs が「直下の.glbは全部武器で、HAS_MODELと対で管理」
   という決まりを見張っているので、キャラを直下へ置くとそこで落ちる */
export const CHAR_DIR = 'assets/models/chars';

/* 1人プレイの敵の見た目に使うモデル(試験)。
   ここを空文字にすれば、敵は全部コード製の見た目へ戻る。
   2026-08-07: 1日で 試す→重い→切る→戻す→**「外部モデルはいらない、1つも」で空に決着**。
   重さの疑い(死体を消さないゲームで骨付きの死体が波ごとに積み上がる)は
   結論を出す前に判断が先に出た。この口自体は残す(検査が両方の状態を見ている) */
export const SOLO_MODEL = '';

/* モデルごとの調整表。
   rotY: 前を-zへ向けるための回転。作った人によって前の向きがばらばらで、
   mixamo系の素体は+z向きが多い。**裏返っていると全員が後ろ歩きで詰めてくる。**
   前がどちらかは骨で測れる(check-character.mjsの[8]が調整表と突き合わせる) */
const MODELS = {
  soldier: { rotY: 0 },
  xbot: { rotY: Math.PI },
  robot: { rotY: Math.PI },
  michelle: { rotY: Math.PI },
  cesium: { rotY: 0 },
};
export const modelRotY = (name) => MODELS[name]?.rotY ?? 0;

/**
 * クリップを名前で引く。名前はモデルごとに揺れる(Walk/walk/Walking)ので正規表現で。
 * 3本揃っていないモデル(1クリップだけの物)は、有る物へ倒す——全部同じクリップに
 * なっても、混ぜる重みの式はそのまま動く(見た目は常にそのクリップになるだけ)
 */
export function pickClips(clips) {
  const find = (re) => clips.find((c) => re.test(c.name)) || null;
  const idle = find(/^idle$/i) || find(/idle/i);
  const walk = find(/^walk(ing)?$/i) || find(/walk/i);
  const run = find(/^run(ning)?$/i) || find(/run/i);
  const any = idle || walk || run || clips[0] || null;
  return { idle: idle || any, walk: walk || any, run: run || any };
}

/* 読み込んだ雛形の置き場。name -> {scene, clips} 。
   'loading'/'failed' も入れて、失敗した物を何度も読みに行かない */
const CACHE = new Map();

/**
 * 雛形を直接流し込む口。**検査用。**
 * ブラウザの外(Node)ではURLの読み込みができないので、検査は
 * ファイルを自分で読んで、ここから流し込んでから実物の動きを確かめる
 */
export function primeCharModel(name, tpl) { CACHE.set(name, tpl); }

/** 読み込みを始める。何度呼んでも1回しか読まない */
export function preloadCharModel(name) {
  if (!name || CACHE.has(name)) return;
  CACHE.set(name, 'loading');
  /* 失敗は例外でも読み込みエラーでも同じ扱いで「コード製の代役」へ落とす。
     ブラウザの外(Node上の検査がRemotePlayersを組む時)では相対URLの解決で
     その場で例外になるので、try無しだと検査ごと死ぬ */
  try {
    new GLTFLoader().load(
      `${CHAR_DIR}/${name}.glb`,
      (gltf) => CACHE.set(name, { scene: gltf.scene, clips: gltf.animations }),
      undefined,
      () => CACHE.set(name, 'failed'),
    );
  } catch {
    CACHE.set(name, 'failed');
  }
}

/** 使える状態か。まだ/失敗ならfalse(呼ぶ側はコード製で出す) */
export function charModelReady(name) {
  const c = CACHE.get(name);
  return !!c && c !== 'loading' && c !== 'failed';
}

/**
 * 1体ぶんを組む。charModelReady()がtrueの時だけ呼べる。
 *
 * スキンメッシュは普通のclone()では骨とメッシュの繋がりが切れて動かなくなるので、
 * SkeletonUtils.cloneを使う(骨格ごと複製して繋ぎ直してくれる)。
 * ジオメトリと材質は雛形と共有される＝人数が増えてもメモリは骨の分しか増えない。
 *
 * @param name   モデル名(CHARACTERSのmodel欄)
 * @param height 見た目の身長(m)。**サーバーの当たり判定の身長に必ず合わせる。**
 *               コード製の兵士で「見えている頭と判定の頭が1cmも重ならない」事故が
 *               実際にあった(remote.jsのコメント参照)。外部モデルも同じ道を通す
 */
export function spawnCharModel(name, height) {
  const tpl = CACHE.get(name);
  const inner = SkeletonUtils.clone(tpl.scene);

  // 前を-zへ向ける(調整表)。y回転は高さを変えないので、測る前に回してよい
  inner.rotation.y = modelRotY(name);
  // 身長をそろえる。素の高さはモデルごとにばらばら(兵士1.83m、ロボは4.79m)
  inner.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(inner);
  const natural = Math.max(0.01, box.max.y - box.min.y);
  const k = height / natural;
  inner.scale.setScalar(k);
  // 足の底をy=0へ。浮いたモデルだと、置いた瞬間から宙に立つ
  inner.position.y = -box.min.y * k;

  const root = new THREE.Group();
  root.add(inner);

  const meshes = [];
  let head = null;
  inner.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; meshes.push(o); }
    if (o.isBone && /Head$/.test(o.name)) head = o;
  });

  const mixer = new THREE.AnimationMixer(inner);
  const picked = pickClips(tpl.clips);
  const idle = mixer.clipAction(picked.idle);
  const walk = mixer.clipAction(picked.walk);
  const run = mixer.clipAction(picked.run);
  // 3本とも常に再生して、重みで混ぜる。都度play/stopすると切り替わりの瞬間に跳ねる。
  // クリップが足りないモデルではidle/walk/runが同じ実体になる(mixerは同じクリップに
  // 同じactionを返す)ので、重複がある前提で組む
  for (const a of [idle, walk, run]) { a.play(); a.setEffectiveWeight(0); }
  idle.setEffectiveWeight(1);

  return {
    root,
    mixer,
    meshes,
    head,          // 名札・銃声・ミニマップの位置に使う。無ければ呼ぶ側がrootから測る
    scale: k,
    /**
     * 歩様を混ぜる。move=0で待機、1で歩き。runはそのうち走りに寄せる割合。
     * しゃがみのクリップは無いので、しゃがみの見た目は出ない(試験の割り切り)。
     *
     * **重複しているactionには重みを合算してから1回だけ書く。**
     * 別々に書くと後の書き込みが前を上書きして、1クリップしか無いモデルは
     * 止まっている間ずっと重み0＝Tポーズで立つ
     */
    mix(move, runK) {
      let wi = 1 - move;
      let ww = move * (1 - runK);
      let wr = move * runK;
      if (walk === idle) { wi += ww; ww = 0; }
      if (run === idle) { wi += wr; wr = 0; } else if (run === walk) { ww += wr; wr = 0; }
      idle.setEffectiveWeight(wi);
      if (walk !== idle) walk.setEffectiveWeight(ww);
      if (run !== idle && run !== walk) run.setEffectiveWeight(wr);
    },
  };
}
