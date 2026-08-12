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

  // 手榴弾は1ラウンドの持ち数で縛る（既定。ガンゲームだけが外す）
  nadeLimit: true,

  // ラウンド制。倒れたらそのラウンドは終わりで、復活はラウンドの頭にまとめて
  rounds: true,

  // 持ち物は既定のまま（protocol.jsのLOADOUT_IDS）
  carryFor: (weapons) => loadoutOf(weapons),

  // 段は無い。画面に「あと何本」を出さないための目印
  stagesOf: () => 1,

  // 倒れた人が武器を落とす。拾うと弾と手榴弾が戻る
  drops: true,

  // チーム分けは無い。全員が互いに敵
  teams: false,

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

  /* **今の段の武器と、ナイフ。** 1本だけにするのがこの遊び方の芯だが、
     ナイフだけは常に持たせる。

     2026-08-13に足した。「せめてナイフ、ナイフはデフォルトであってもいいと思うけどね。
     弾切れした時に殺しようがないし」と言われた所。
     この遊び方は落ちた武器を拾えない(drops: false)ので、
     **弾を撃ち切った人は次に倒されるまで何もできない。**

     最後の段はナイフなので、そこでは今まで通り**ナイフ1本だけ**になる
     （銃が無くなるので、段としての手応えは残る）*/
  carryFor: (weapons, slot) => {
    const order = idsToIndex(weapons, GUN_ORDER);
    const st = Math.min(slot?.stage ?? 0, order.length - 1);
    const knife = weapons.findIndex((w) => w.id === 'knife');
    const carry = [order[st]];
    if (knife >= 0 && !carry.includes(knife)) carry.push(knife);
    return carry;
  },

  /* **手榴弾を数えない。** 2026-08-13に
     「ガンゲームの時は、手榴弾の弾の制限があったらちょっとおかしいよね」と言われた所。
     手榴弾の段は**投げる物が無くなったらそこで詰む**（拾えないので補充も無い）。
     数えないのはこの遊び方だけで、デスマッチと2対2は今まで通り */
  nadeLimit: false,

  stagesOf: (weapons) => idsToIndex(weapons, GUN_ORDER).length,

  /* **落とさない。** 落ちた武器を拾えると、今の段の1本だけを持つという
     この遊び方の芯がそのまま消える。段を飛ばして先の武器を持てるなら、
     倒して進む理由が無くなる */
  drops: false,

  teams: false,

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

/* ---------------------------------------------------------- 2対2 */

// デスマッチと同じ進行で、**「最後の1人」が「最後の1チーム」に変わるだけ。**
//
// Room側は「生きているチームが1つになったらラウンド終わり」という数え方に
// してあるので、チームを持たない遊び方では1人＝1チームとして同じ道を通る。
// 分岐が増えないので、デスマッチの進行を壊す余地がそのぶん減る。
const teamplay = {
  id: 'team',
  rounds: true,
  nadeLimit: true,
  carryFor: (weapons) => loadoutOf(weapons),
  stagesOf: () => 1,
  drops: true,
  // 席の左2つと右2つで分かれる（protocol.jsのTEAM_OF_SEAT）
  teams: true,
  onKill: () => 'none',
};

/* ------------------------------------------------------------ 表 */

const TABLE = { dm: deathmatch, gun: gungame, team: teamplay };

/** 知らないidが来たらデスマッチへ寄せる（部屋が止まるより寄せたほうがまし） */
export const modeOf = (id) => TABLE[id] || TABLE.dm;

export const MODE_BEHAVIOR = TABLE;
