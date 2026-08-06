// 遊び方の決まり。**サーバーだけが持つ。**
//
// なぜ別ファイルにするか: 遊び方を足すたびに Room の中の if が増えていく形だと、
// 3つ目を足す頃には「どの行がどの遊び方の話か」が読めなくなる。
// Room は「誰が倒したか」「今どの局面か」だけを見て、
// **どう勝つか・いつ生き返るか・何を持たせるかはここへ聞く**形にする。
//
// 名前と説明は src/net/protocol.js の MODE_LIST にある（ロビーの画面が並べるため）。
// こちらは中身の決まりだけを持つ。クライアントに決まりを持たせると、
// そちらを書き換えれば勝てることになる。
import { GUN_ORDER, loadoutOf } from '../src/net/protocol.js';

/* ------------------------------------------------------------ 共通の道具 */

/** 名前の並びを武器の番号の並びへ。表に無い名前は落とす */
const idsToIndex = (weapons, ids) => ids
  .map((id) => weapons.findIndex((w) => w.id === id))
  .filter((i) => i >= 0);

/* ------------------------------------------------------ デスマッチ（今まで通り） */

const deathmatch = {
  id: 'dm',

  // ラウンド制。倒れたらそのラウンドは終わりで、復活はラウンドの頭にまとめて
  rounds: true,

  // 持ち物は既定のまま（protocol.jsのLOADOUT_IDS）
  carryFor: (weapons) => loadoutOf(weapons),

  // 段は無い。画面に「あと何本」を出さないための目印
  stagesOf: () => 1,

  // 倒しても持ち物は変わらない。勝ち負けはラウンド数で決まるので、
  // そちらは _endRound が持っている
  onKill: () => 'none',
};

/* ---------------------------------------------------------- ガンゲーム */

// 倒すたびに次の武器へ進む。全部の武器で1回ずつ倒したら勝ち。
//
// ラウンドを持たないのがデスマッチとの一番大きい違いで、
// 倒れても数秒で生き返って続く。**ラウンドが無いので「最後の1人」も無い。**
const gungame = {
  id: 'gun',

  rounds: false,

  // **今の段の武器だけを持たせる。** 1本だけにするのがこの遊び方の芯で、
  // 持ち替えができると全部持っているのと変わらなくなる
  carryFor: (weapons, slot) => {
    const order = idsToIndex(weapons, GUN_ORDER);
    const st = Math.min(slot?.stage ?? 0, order.length - 1);
    return [order[st]];
  },

  stagesOf: (weapons) => idsToIndex(weapons, GUN_ORDER).length,

  /**
   * 倒した側の段を1つ進める。返すのは3つのどれか:
   *   'win'     … 最後の武器で倒した。試合の勝ち
   *   'advance' … 次の武器へ進んだ。Roomが持ち物を配り直す
   *   'none'    … 何も起きない
   *
   * 自分で自分を倒した時（落下・戦域の外）は進めない。
   * 進めてしまうと、崖から飛び降りるのが一番速い勝ち方になる
   */
  onKill: (killer, victim, weapons) => {
    if (!killer || killer === victim) return 'none';
    const last = idsToIndex(weapons, GUN_ORDER).length - 1;
    if (killer.stage >= last) return 'win';
    killer.stage++;
    return 'advance';
  },
};

/* ------------------------------------------------------------ 表 */

const TABLE = { dm: deathmatch, gun: gungame };

/** 知らないidが来たらデスマッチへ寄せる（部屋が止まるより寄せたほうがまし） */
export const modeOf = (id) => TABLE[id] || TABLE.dm;

export const MODE_BEHAVIOR = TABLE;
