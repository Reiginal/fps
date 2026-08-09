// 財布。**何枚あげるかの計算**と、**台帳へ足す1本のSQL**だけ。
//
// server/auth.js と同じで、ここには接続が無い（DBへ投げる関数を引数でもらう）。
// server/index.js は読み込むと起動してしまうので、判定をそこへ書くと検査から叩けない。
//
// **対戦でしか貯まらない。** 1人プレイはサーバーに一切繋がっていないので、
// 貯めるにはクライアントの自己申告を受け取るしかなく、
// 開発者ツールから「ウェーブ50まで行った」と送れてしまう。
// 買える物に値段が付く以上、そこを開けない（2026-08-09に決めた）。
//
// **ログインしていない人には配らない。** 配る先が無いので当然だが、
// 「遊んだのに貯まらない」は画面で分かるようにしておくこと（ホームの行に出る）。

/* 何枚あげるか。**全部サーバーが数えた値から決める。**
   撃破数もラウンド数も、クライアントが送ってきた数字ではない。

   数字の決め方: 4人のデスマッチを1試合終えると、
   勝った人が 20 + 12撃破*5 + 3ラウンド*15 + 50 = 175枚、
   負けた人が 20 + 5撃破*5 = 45枚くらいになる。
   スキン1つを数百枚にすれば「何試合か遊んだら1つ買える」になる */
export const COIN = {
  // 参加賞。**0にしない。** 勝てない人が永久に何も買えないと、
  // 買い物そのものが「上手い人だけの物」になる
  JOIN: 20,
  KILL: 5,
  ROUND: 15,
  TOP: 50,
  /* 1試合で出せる上限。**実装事故の止め金。**
     ラウンド数の数え方を間違えて桁が飛んでも、ここで止まる。
     「気づいた時には全員が100万枚持っていた」は取り返しがつかない
     （減らすと、遊ぶ側からは没収に見える） */
  MAX_PER_MATCH: 500,
};

/**
 * 1人ぶんの枚数を数える。**引数は全部サーバーが持っている値。**
 *
 * @param me   { kills, rounds } その人の成績
 * @param top  一番ラウンドを取った人の取得数。同点なら全員が1位扱い
 * @returns 枚数（0以上）
 */
export function coinsFor(me, top) {
  const kills = Math.max(0, me.kills | 0);
  const rounds = Math.max(0, me.rounds | 0);
  let n = COIN.JOIN + kills * COIN.KILL + rounds * COIN.ROUND;
  // 誰もラウンドを取っていない試合（時間切れの0-0）で全員が1位になるのを防ぐ
  if (top > 0 && rounds >= top) n += COIN.TOP;
  return Math.min(n, COIN.MAX_PER_MATCH);
}

/**
 * 財布へ足す。**読んでから書かない。**
 *
 * `SELECT coins → +120 → UPDATE coins = 新しい値` と書くと、
 * 同じ人の2試合がほぼ同時に終わった時に**片方が消える**。
 * 両方が「今100枚」を読んで、両方が「220枚」と書くので、
 * 340枚あるはずが220枚になる（ロストアップデート）。
 *
 * `coins = wallets.coins + $2` は**台帳の中で足す**ので、
 * 誰が同時に来ても順番に積まれる。読む工程が無いのでずれようが無い。
 *
 * ON CONFLICT は「その人の行が無ければ作る、あれば足す」。
 * 財布を作る処理を登録時に別で持たなくて済む
 * （持つと、登録より前からいる人の財布が永久に無いままになる）。
 *
 * @returns 足した後の残高
 */
export async function addCoins(query, userId, amount) {
  const add = Math.max(0, Math.round(amount || 0));
  if (!add) return getCoins(query, userId);
  const res = await query(
    `INSERT INTO wallets (user_id, coins) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET coins = wallets.coins + EXCLUDED.coins, updated_at = now()
     RETURNING coins`,
    [userId, add],
  );
  return Number(res.rows[0]?.coins ?? 0);
}

/** 今いくら持っているか。財布がまだ無い人は0 */
export async function getCoins(query, userId) {
  const res = await query('SELECT coins FROM wallets WHERE user_id = $1', [userId]);
  return Number(res.rows[0]?.coins ?? 0);
}
