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
// それと、対戦で倒れている間に生きている人の目線を借りる所（下の「観戦」）。

// 目の高さと、しゃがみの判定に使うビット。**判定側の身長と同じ数字を使う。**
// ここで別の値を持つと、見ている人がしゃがんだ時に視点だけ立ったままになる
import { HITBOX, S } from '../net/protocol.js';

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

/* 見ている人の**目の中**にカメラを置く（一人称）。
 *
 * なぜ要るか: 対戦で倒れると生き返るまで死体の目線のままで、
 * 地面に転がったまま数秒待つことになる（「ずっと死体からの目線しかないのキツかった」）。
 * 生きている人の目線を借りれば、その間も試合が見られる。
 *
 * 前は肩越し（後ろ2.6m・上0.75m）に置いていたが、頭より高い所から見下ろす形で
 * 俯瞰に見えるので本人の目線へ変えた（2026-08-09）。
 *
 * **通信も計算もほとんど増えない。** 見る相手の位置と向きは、
 * 他人を描くために元々毎フレーム届いている（protocol.jsのpackPlayer）。
 * ここはその数字を読み替えるだけで、描く物は1つも増えない
 * （むしろ、その人の体を描かなくなるぶん1体減る。main.jsのsetHidden）。
 */

// 目の高さの出し方は player._applyCamera() と同じ（feetY + height - 0.16）。
// ここで別の数字を置くと、生き返った瞬間に視点の高さが跳ねる
export const SPEC_EYE_DROP = 0.16;
export const SPEC_EYE_STAND = HITBOX.STAND_H - SPEC_EYE_DROP;
export const SPEC_EYE_CROUCH = HITBOX.CROUCH_H - SPEC_EYE_DROP;
// しゃがみの上下を追う速さ。本人の姿勢は12〜20で滑らかに動く（player.js）ので、
// 段が付かない程度に寄せる。**瞬間で入れ替えると68cm跳ねる**
export const SPEC_CROUCH_RATE = 14;

/** 見ている人の目の高さ（足元から）。しゃがんでいれば低い */
export function spectateEyeH(stateBits = 0) {
  return (stateBits & S.CROUCH) ? SPEC_EYE_CROUCH : SPEC_EYE_STAND;
}

/**
 * 目の高さを滑らかに寄せる。prevがnull（見始め・相手を替えた）なら即その高さ。
 * スナップショットのしゃがみは0か1の切り替えしか無いので、ここで均さないと
 * 相手がしゃがんだ瞬間に視点が68cm落ちる
 */
export function smoothEyeH(prev, want, dt) {
  if (prev === null || prev === undefined) return want;
  const k = 1 - Math.exp(-SPEC_CROUCH_RATE * Math.max(0, dt));
  return prev + (want - prev) * k;
}

/**
 * 観戦カメラの置き場所を決める。
 *
 * 戻り値は {pos:{x,y,z}, rot:{x,y}}。実際にカメラへ入れるのは呼ぶ側。
 * @param target 見る相手 {x,y,z,yaw,pitch,state}
 * @param eyeH 目の高さ。渡さなければ相手のしゃがみから決める（切り替えは瞬間になる）
 */
export function spectatePose(target, eyeH = null) {
  const h = eyeH === null || eyeH === undefined ? spectateEyeH(target.state | 0) : eyeH;
  return {
    pos: { x: target.x, y: target.y + h, z: target.z },
    // 相手が向いている方をそのまま向く。首を勝手にずらすと、
    // 相手が撃っている物が画面の外に出る
    rot: { x: clamp(target.pitch ?? 0, -1.5, 1.5), y: target.yaw },
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
