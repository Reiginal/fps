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
