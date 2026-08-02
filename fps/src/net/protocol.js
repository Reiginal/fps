// クライアントとサーバーが喋る取り決め。両方から読まれる唯一の共有ファイル。
// ここを片方だけ書き換えると、繋がるのに挙動だけおかしいという最悪のバグになる。
// 値を足す時は必ず両側の実装を同時に直すこと。
//
// 方針:
//  - 判定はすべてサーバーが持つ。クライアントの申告は「入力」と「狙った向き」だけ
//  - 移動の中身はクライアントとサーバーで同じPlayerクラスを走らせる（server/sim.js参照）。
//    だから送るのは押しているキーの組み合わせであって、座標ではない
//  - 座標を送らせると、送る側が好きな値を書けてしまう＝壁抜けし放題になる
//
// 数値はJSONで送る。8人・毎秒20回でも1人あたり15KB/s程度なので、
// バイナリに詰め直す価値より、詰まった時に中身を目で読める価値の方が高い。

/* ------------------------------------------------------------ 時間の刻み */

// 物理の刻み。クライアントもサーバーもこの刻みで進める。
// 可変dtのまま送ると、同じ入力でも到達位置がずれて補正が常時走ることになる
export const TICK_HZ = 60;
export const TICK_DT = 1 / TICK_HZ;

// サーバーが全員の状態を配る頻度。60回配ると帯域の割に見た目が変わらない
export const SNAPSHOT_HZ = 20;

// 入力をまとめて送る頻度。1刻みずつ送るとパケットが毎秒60個になるので、
// 3刻み分をまとめて毎秒20回にする。取りこぼしに備えて直近の未確認分も一緒に送る
export const INPUT_SEND_HZ = 20;
export const INPUT_BATCH = Math.round(TICK_HZ / INPUT_SEND_HZ);

// 他人を何ミリ秒遅らせて描くか。2つのスナップショットの間を補間するので、
// 最低でも配信間隔(50ms)は必要。取りこぼし1回分の余裕を見て倍を取る
export const INTERP_DELAY_MS = 100;

// 「当てたのに抜ける」を消すための巻き戻しの上限。
// これを超える遅延の相手は、撃った側の画面を再現しきれないので諦める
export const MAX_REWIND_MS = 300;

// 巻き戻し用に位置を残しておく長さ。上限より少し余裕を持たせる
export const HISTORY_MS = 500;

export const MAX_PLAYERS = 8;

// この秒数だけ何も届かなければ切れたとみなす
export const TIMEOUT_MS = 12000;

/* -------------------------------------------------------------- 入力の詰め方 */

// 押しているキーを1つの整数に畳む。名前で送ると1刻みあたり100バイト超える
export const K = {
  FWD: 1 << 0,      // W
  BACK: 1 << 1,     // S
  LEFT: 1 << 2,     // A
  RIGHT: 1 << 3,    // D
  JUMP: 1 << 4,     // Space
  CROUCH: 1 << 5,   // Ctrl
  SPRINT: 1 << 6,   // Shift
  FIRE: 1 << 7,     // 左クリック
  ADS: 1 << 8,      // 右クリック
  RELOAD: 1 << 9,   // R
};

// 押しているキーの集合とビットの対応。クライアント側で組み立てる時に使う
export const KEY_CODES = [
  ['KeyW', K.FWD], ['KeyS', K.BACK], ['KeyA', K.LEFT], ['KeyD', K.RIGHT],
  ['Space', K.JUMP], ['ControlLeft', K.CROUCH], ['ShiftLeft', K.SPRINT],
  ['KeyR', K.RELOAD],
];

/* ------------------------------------------------------------ 状態のビット */

// スナップショットに載せる見た目の状態。他人の姿勢を再現するのに使う
export const S = {
  CROUCH: 1 << 0,
  SPRINT: 1 << 1,
  AIR: 1 << 2,
  ADS: 1 << 3,
  DEAD: 1 << 4,
  RELOAD: 1 << 5,
};

/* ------------------------------------------------------------ 電文の種類 */

// クライアント → サーバー
export const C = {
  JOIN: 'j',      // { t, name, room }
  INPUT: 'i',     // { t, s:先頭seq, f:[[key,yaw,pitch], ...] } fは連続する刻みの列
  SHOT: 'f',      // { t, s:撃った時のseq, o:[x,y,z], d:[x,y,z] } 発射。当たり判定はサーバー
  WEAPON: 'w',    // { t, i:武器番号 }
  PONG: 'o',      // { t, id }
  CHAT: 'c',      // { t, m }
};

// サーバー → クライアント
export const Sv = {
  // players は [{ id, name, kills, deaths, ping }]。座標は直後のSNAPSHOTで届くので載せない。
  // ここを数値の並びにすると、名前を運ぶ場所が無くなって全員が無名で並ぶ
  WELCOME: 'W',   // { t, id, room, tick, now, you:{name}, players:[...] }
  // left は試合の残り秒。ここに載せないと、残り時間を運ぶ口がどこにも無くなる。
  // 20Hzで数バイト増えるだけなので、専用の電文を増やすより安い
  SNAPSHOT: 'S',  // { t, tk, now, ack, left, ps:[...] }
  EVENT: 'E',     // { t, e:[...] } 起きたこと（下のEV参照）をまとめて配る
  SCORE: 'C',     // { t, rows:[[id,kills,deaths,ping]] }
  // 試合終了。これが無いと「今届いた得点が最終順位なのか途中経過なのか」を
  // 受け取る側が判別できず、最終順位を出した直後に0点で上書きされる
  MATCHEND: 'M',  // { t, rows:[[id,kills,deaths,ping]], why:'score'|'time', next:再開までの秒 }
  PING: 'P',      // { t, id }
  FULL: 'X',      // { t, why } 入れなかった
};

// EVENTの中身。1つのスナップショットの間に起きたことをまとめて送る
export const EV = {
  FIRE: 'f',      // { e:'f', id, w } 誰かが撃った。音とマズルフラッシュ用
  HIT: 'h',       // { e:'h', id, by, dmg, part, p:[x,y,z] } 誰かに当たった
  KILL: 'k',      // { e:'k', id, by, w, head }
  SPAWN: 's',     // { e:'s', id, p:[x,y,z], yaw }
  JOIN: 'j',      // { e:'j', id, name }
  LEAVE: 'l',     // { e:'l', id }
  // 撃った本人は往復を待たずに手元で着弾を描くので、byを見て自分の分は捨てる
  IMPACT: 'i',    // { e:'i', by, p:[x,y,z], n:[x,y,z], k:種別 } 壁への着弾。デカール用
};

// 当たった部位。倍率はサーバーが持つ（クライアントに書かせない）
export const PART = { HEAD: 0, CHEST: 1, LEG: 2 };

/* -------------------------------------------------------------- 数値の丸め */

// 座標は1mm、角度は1/10000ラジアン。これ以上の精度を送っても誰も違いが分からない上に、
// JSONの桁数がそのまま帯域になる
export const qPos = (v) => Math.round(v * 1000) / 1000;
export const qAng = (v) => Math.round(v * 10000) / 10000;

/* ---------------------------------------------------- スナップショットの形 */

// 1人ぶんの状態。配列にして詰めるのはキー名の繰り返しが帯域の半分を占めるから。
// 並び順を変えたら必ず両側を直す
//   [id, x, y, z, yaw, pitch, stateBits, hp, weaponIndex]
export const PS_LEN = 9;

export function packPlayer(p) {
  return [
    p.id,
    qPos(p.x), qPos(p.y), qPos(p.z),
    qAng(p.yaw), qAng(p.pitch),
    p.state | 0, Math.round(p.hp), p.weapon | 0,
  ];
}

export function unpackPlayer(a) {
  return {
    id: a[0],
    x: a[1], y: a[2], z: a[3],
    yaw: a[4], pitch: a[5],
    state: a[6], hp: a[7], weapon: a[8],
  };
}

/* ------------------------------------------------------ 当たり判定の当たり所 */

// 立っている時の足元からの高さ。しゃがむと縮む。
// server/sim.js とクライアントの当たり判定用モデルはこの数字を共有する。
// 撃つ側の画面に映っている姿と判定の形がずれると「見えてるのに当たらない」になる
export const HITBOX = {
  STAND_H: 1.74,
  CROUCH_H: 1.06,
  RADIUS: 0.34,
  // 頭は球。中心は身長のこの割合の高さ
  HEAD_AT: 0.90,
  HEAD_R: 0.15,
  // 胴はカプセル。身長のこの割合の区間
  CHEST_FROM: 0.48,
  CHEST_TO: 0.84,
  CHEST_R: 0.26,
  // 脚もカプセル
  LEG_FROM: 0.06,
  LEG_TO: 0.48,
  LEG_R: 0.20,
};

// 部位倍率。頭は即死級だが一撃では落とさない（撃ち合いが運ゲーになる）
export const PART_MUL = { [PART.HEAD]: 2.6, [PART.CHEST]: 1.0, [PART.LEG]: 0.78 };

/* -------------------------------------------------------------- 試合の設定 */

export const MATCH = {
  // フリーフォーオール。この数だけ倒した人が出たら試合終了
  SCORE_LIMIT: 30,
  TIME_LIMIT_S: 600,
  RESPAWN_S: 3.0,
  // 復帰直後の無敵。これが無いと湧いた瞬間に撃たれ続けて何もできない
  SPAWN_PROTECT_S: 1.5,
  // 復帰地点は他人から最低これだけ離す
  SPAWN_MIN_DIST: 14,
};

/* ------------------------------------------------------------ 部屋の合言葉 */

// 紛らわしい文字(0/O, 1/I/L)を外した4文字。口頭で伝えられることを優先する
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_LEN = 4;

export function normalizeRoom(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_LEN);
}

/* ---------------------------------------------------------------- 送受信 */

export function encode(msg) { return JSON.stringify(msg); }

export function decode(raw) {
  try {
    const m = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    return (m && typeof m.t === 'string') ? m : null;
  } catch {
    return null;   // 壊れた電文で落ちない。無視して次を待つ
  }
}
