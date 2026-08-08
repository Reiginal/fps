// 倒れている間のカメラ。
//
// なぜ別ファイルにするか: ここは main.js の _deathFall の中に直書きしてあったが、
// **main.js は入り口なので、読み込んだ瞬間にゲームが丸ごと立ち上がる。**
// ブラウザ無しで確かめる手段が無く、倒れ込みの曲がり方も見回しの上下限も
// 一度も測られていなかった。計算だけここへ出せば tools/check-deathcam.mjs から
// 本物を動かせる。
//
// やっていることは2つだけ:
//   ・倒れ込み … 目の高さを地面まで落として、体を横へ倒す
//   ・見回し   … 倒れている間だけ、首を振れるようにする

// 倒れ切るまでの秒数。main.js は結果画面へ移る時計にも同じ値を使う
export const DEATH_FALL_S = 1.3;

// 倒れている間の上下の限界。地面に転がっているので、
// 立っている時(1.5)より狭くする。真下を向いても床しか無い
export const DEATH_PITCH_LIMIT = 1.1;

// 倒れ切った時の目の高さ。足元からこれだけ上（＝地面に転がった頭の高さ）
export const DEATH_EYE_H = 0.42;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 倒れた瞬間の向きから始める。以後この入れ物の中だけで首を回す */
export function startLook(yaw, pitch) {
  return { yaw, pitch: clamp(pitch, -DEATH_PITCH_LIMIT, DEATH_PITCH_LIMIT) };
}

/**
 * 見回す。
 *
 * **ここで player.yaw を動かしてはいけない。** あれはサーバーへ送る向きなので、
 * 動かすと他の人の画面では倒れているはずの体が首だけ回り続ける。
 * 見回すのは自分のカメラの中だけの話
 */
export function turnLook(look, dYaw, dPitch) {
  if (!look) return look;
  look.yaw += dYaw;
  look.pitch = clamp(look.pitch + dPitch, -DEATH_PITCH_LIMIT, DEATH_PITCH_LIMIT);
  return look;
}

/**
 * 倒れ込みの進み具合。t は倒れてからの秒数。
 * drop は目の高さの落ち方、roll は体の倒れ方で、
 * どちらも 0→1。落ちるほうを速く始めて、倒れるほうを後から効かせる
 */
export function fallCurve(t) {
  const k = clamp(t / DEATH_FALL_S, 0, 1);
  return { k, drop: 1 - (1 - k) ** 3, roll: 1 - (1 - k) ** 2 };
}

/**
 * カメラへ反映する。player._applyCamera() の後に呼ぶ前提で、
 * 向きは上書き・高さは引き算になっている。
 *
 * look を渡さなければ今まで通り（1人用は結果画面へ移るので見回しを持たない）
 */
/* ------------------------------------------------------ 観戦（対戦だけ） */

// 肩越しに置く距離と高さ。真後ろすぎると自分の背中で画面が埋まり、
// 離しすぎると誰を見ているのか分からなくなる
export const SPEC_BACK = 2.6;
export const SPEC_UP = 0.75;
// 見る点は相手の胸の高さ。足元を見ると地面ばかり映る
export const SPEC_AIM_H = 1.35;
// 壁に埋まらないよう手前で止める時の余白（カメラの near より大きく取る）
export const SPEC_PAD = 0.28;

/**
 * 観戦カメラの置き場所を決める。
 *
 * なぜ要るか: 対戦で倒れると生き返るまで死体の目線のままで、
 * 地面に転がったまま数秒待つことになる（「ずっと死体からの目線しかないのキツかった」）。
 * 生きている人の肩越しに移せば、その間も試合が見られる。
 *
 * **通信も計算もほとんど増えない。** 見る相手の位置と向きは、
 * 他人を描くために元々毎フレーム届いている（protocol.jsのpackPlayer）。
 * ここはその数字からカメラの置き場所を出すだけで、描く物は1つも増えない。
 *
 * 戻り値は {pos:{x,y,z}, rot:{x,y}}。実際にカメラへ入れるのは呼ぶ側。
 * @param target 見る相手 {x,y,z,yaw,pitch}
 * @param castRay (from, dir, maxDist) => 距離 or null。地形に当たった距離を返す。
 *   渡さなければ壁抜けの手当てをしない（検査で分けて測れるようにしてある）
 */
export function spectatePose(target, castRay = null) {
  const yaw = target.yaw;
  const pitch = clamp(target.pitch ?? 0, -0.9, 0.9);
  // 相手の胸。ここを中心に、後ろ上へ引いた所へカメラを置く
  const ax = target.x;
  const ay = target.y + SPEC_AIM_H;
  const az = target.z;
  /* 引く向き。yaw/pitchはプレイヤーの前を向いているので、その逆へ下がる。
     pitchも効かせるのは、上を撃っている人の後ろで地面に潜らないため */
  const cp = Math.cos(pitch);
  const bx = Math.sin(yaw) * cp;
  const by = -Math.sin(pitch);
  const bz = Math.cos(yaw) * cp;

  let back = SPEC_BACK;
  if (castRay) {
    // 胸から後ろへ1本だけ飛ばす。壁があれば手前で止める。
    // レイ1本は交戦中に毎フレーム90〜140本飛んでいる中の1本ぶんで、負荷としては誤差
    const hit = castRay({ x: ax, y: ay, z: az }, { x: bx, y: by, z: bz }, SPEC_BACK + SPEC_PAD);
    if (hit !== null && hit !== undefined) back = Math.max(0.4, hit - SPEC_PAD);
  }

  return {
    pos: { x: ax + bx * back, y: ay + by * back + SPEC_UP, z: az + bz * back },
    // 相手と同じ方を向く。少しだけ下げて相手の頭が画面の下寄りに来るようにする
    rot: { x: pitch - 0.12, y: yaw },
  };
}

export function applyDeath(camera, { t, height, look = null }) {
  const { drop, roll } = fallCurve(t);
  if (look) {
    camera.rotation.y = look.yaw;
    camera.rotation.x = look.pitch;
  }
  // 目の高さから、地面に転がった高さまで落とす
  camera.position.y -= drop * (height - DEATH_EYE_H);
  camera.rotation.z += roll * 1.15;
  // 顔が上を向く。倒れた先に空が見えると「自分が倒れた」が伝わる
  camera.rotation.x -= roll * 0.22;
  return camera;
}
