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
   勝った人が 40 + 12撃破*10 + 3ラウンド*35 + 100 = 365枚、
   負けた人が 40 + 5撃破*10 = 90枚くらいになる。

   **2026-08-11に倍にした。** それまでは勝ち175・負け45で、
   一番安いスキン(300)が勝っても2試合ぶんだった。
   「対戦をやってくれる機会が増えるように上げたい」と言われて、
   gold(1500)が4〜5試合、ドラゴン(2000)が6試合になる所まで持ってきた */
export const COIN = {
  // 参加賞。**0にしない。** 勝てない人が永久に何も買えないと、
  // 買い物そのものが「上手い人だけの物」になる
  JOIN: 40,
  KILL: 10,
  ROUND: 35,
  TOP: 100,
  /* 1試合で出せる上限。**実装事故の止め金。**
     ラウンド数の数え方を間違えて桁が飛んでも、ここで止まる。
     「気づいた時には全員が100万枚持っていた」は取り返しがつかない
     （減らすと、遊ぶ側からは没収に見える） */
  MAX_PER_MATCH: 800,
  /* 登録した時に1回だけ配る。**一番安いスキンが1つ買えて少し残る額。**
     狙いは金額ではなく、**「買う」を1回体験させること。**
     0枚から始めると、店を開いても全部が灰色で、
     何が売っているのかを見る前に閉じることになる。

     **2026-08-11に500から900へ上げた。**
     デザート(300)・アーバン(300)・歴戦(600)を棚から下げて、
     一番安い商品が迷彩(800)になったので、500枚では何も買えなくなっていた。
     商品の値段ではなくこちらを動かしたのは、800が「迷彩を800ぐらいで」と
     決められた値だから。**祝い金は誰も決めていない数字なので、こちらが譲る。**

     tools/check-wallet.mjs の[9]が「一番安い商品が買えること」を見張っているので、
     次に一番安い商品を動かした時もここで気づける。

     **2026-08-13に900から2000へ上げた。**
     「登録してくれた人は、１つぐらいいいスキン変えてもいいから
       2000ぐらいコイン配るようにする？」と言われた所。

     900だと**棚の下の方しか買えない。** 買えるのは迷彩(800)くらいで、
     形ごと別の銃になる物（リボルバー・ソードオフ・ブルパップ等）には届かない。
     この店の売りはそこなので、900で始めると
     「見せ場は見せずに、余り物だけ買わせる」形になっていた。

     2000あれば**棚の上の方から1つ選べる。**
     選ぶこと自体が店を一周する理由になるので、
     枚数を配っているというより「1回選ばせる」ための額として置いている。

     既にいる人には17番と同じ考えで差額を配ってある（migrations.jsの19番）*/
  SIGNUP: 2000,
};

/**
 * 1人プレイの取り分。**ここだけ本人の申告が混じる。**
 *
 * 1人プレイはサーバーに一切繋がっていないので、何波まで行ったかは
 * 開発者ツールから好きな数を送れる。**それでも構わない形にしてある。**
 *
 * 信じる代わりに天井を置く:
 *   PER_RUN … 1回で受け取れる上限
 *   PER_DAY … その日に受け取れる上限（台帳が数える。migrations.jsの8番）
 *   MIN_GAP_S … 前回からこれだけ空いていないと受け取れない
 *
 * PER_DAY(600)は**対戦2試合ぶんにも満たない。**
 * 嘘をついて取れる最大が対戦を普通に回すより少ないので、嘘をつく意味が消える。
 *
 * 代わりに、**1人プレイは上手さより回数が効く。**
 * 時間で縛る以上そうなるので、そこは承知のうえで置いている
 */
export const SOLO = {
  WAVE: 20,
  KILL: 1,
  PER_RUN: 400,
  PER_DAY: 600,
  MIN_GAP_S: 60,
};

/** 1人プレイ1回ぶんの枚数。申告された数字はここで上限まで丸める */
export function soloCoinsFor({ wave, kills } = {}) {
  // 申告の桁が飛んでいても、掛ける前にここで止める。
  // 上限だけで守ると、途中の掛け算がとんでもない数になってから丸めることになる
  const w = Math.min(500, Math.max(0, wave | 0));
  const k = Math.min(5000, Math.max(0, kills | 0));
  return Math.min(SOLO.PER_RUN, w * SOLO.WAVE + k * SOLO.KILL);
}

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
  /* **earned にも同じだけ足す。** こちらは減らない列で、順位表(/api/ranking)が読む。
     残高(coins)は買うと減るので順位にできない
     （スキンを買った人ほど下に落ちる表になる） */
  const res = await query(
    `INSERT INTO wallets (user_id, coins, earned) VALUES ($1, $2, $2)
     ON CONFLICT (user_id) DO UPDATE
       SET coins = wallets.coins + EXCLUDED.coins,
           earned = wallets.earned + EXCLUDED.earned,
           updated_at = now()
     RETURNING coins`,
    [userId, add],
  );
  return Number(res.rows[0]?.coins ?? 0);
}

/* 何が起きて払えなかったのか。**画面に出す文言はここが持つ。**
   クライアント側でも同じ判定を書くと、必ずどちらかが古くなる */
export const SOLO_ERR = {
  SOON: '少し間を空けてからどうぞ',
  FULL: '今日のぶんはここまで。明日また貯まります',
};

/**
 * 1人プレイの取り分を財布へ入れる。**天井は台帳の中で決める。**
 *
 * `withClient` で1本の線を借りて呼ぶこと（BEGIN と COMMIT が散ると取引にならない）。
 *
 * **なぜ SELECT してから UPDATE してよいのか。**
 * addCoins では「読んでから書く」を避けている（同時に2試合終わると片方消える）が、
 * ここは避けようがない。**その日いくらまで、を決めるには今日ぶんを読むしかない。**
 * だから代わりに `FOR UPDATE` で行に鍵を掛ける。
 * 同じ人の2回目が同時に来たら、1回目が COMMIT するまで待たされるので、
 * 2つが同じ「今日ぶん」を読むことが起きない。
 *
 * @param want 申告から計算した希望額（soloCoinsFor の返り値）
 * @param now  「今日」を決める時刻。検査から日を跨がせるために引数にしてある
 * @returns { ok:true, got, coins, today } か { ok:false, error }
 */
export async function addSoloCoins(query, userId, want, now = new Date()) {
  const add = Math.max(0, Math.round(want || 0));
  // 日付はサーバーの時計で決める。UTCで切るので、日付が変わるのは日本時間の朝9時
  const today = now.toISOString().slice(0, 10);

  await query('BEGIN');
  try {
    // 財布がまだ無い人のために先に作る。**DO NOTHING なので既にあれば何も起きない**
    await query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    const cur = await query(
      `SELECT coins, solo_at,
              CASE WHEN solo_day = $2 THEN solo_today ELSE 0 END AS used
         FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId, today],
    );
    const row = cur.rows[0];
    const used = Number(row?.used ?? 0);

    // 連投を弾く。倒れた直後に何十回も送りつける形を止めるだけで、
    // 本当の天井は下の1日ぶん
    const last = row?.solo_at ? new Date(row.solo_at).getTime() : 0;
    if (last && now.getTime() - last < SOLO.MIN_GAP_S * 1000) {
      await query('ROLLBACK');
      return { ok: false, error: SOLO_ERR.SOON };
    }

    const got = Math.max(0, Math.min(add, SOLO.PER_DAY - used));
    if (got <= 0) {
      /* 受け取れなくても**時刻は進める。**進めないと、上限に当たった人が
         上限に当たっている間だけ連投し放題になる（弾く条件を通らなくなるので） */
      await query(
        'UPDATE wallets SET solo_day = $2, solo_today = $3, solo_at = now() WHERE user_id = $1',
        [userId, today, used],
      );
      await query('COMMIT');
      return { ok: false, error: SOLO_ERR.FULL, coins: Number(row?.coins ?? 0) };
    }

    const res = await query(
      // earnedにも同じだけ足す（addCoinsと同じ理由。順位表が読む減らない列）
      `UPDATE wallets
          SET coins = coins + $2, earned = earned + $2,
              solo_day = $3, solo_today = $4,
              solo_at = now(), updated_at = now()
        WHERE user_id = $1 RETURNING coins`,
      [userId, got, today, used + got],
    );
    await query('COMMIT');
    return { ok: true, got, coins: Number(res.rows[0]?.coins ?? 0), today: used + got };
  } catch (e) {
    await query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/* 順位の付け方。**遊んだ量がそのまま出る数字にする。**
 *
 * 2026-08-12に、稼いだコインの総額(earned)から作り直した。
 * 「稼いだコインの総額、微妙だな。俺ら金もらってるからね、DBで」と言われた所。
 * コインは台帳から直に足せるので、**順位表の元にすると記録にならない。**
 *
 * ここに並べた3つは、どれも遊ばないと1つも増えない。
 * **勝利を一番重くしてある**（「できれば勝利数が高いほうがいいね」）。
 *
 * 重みの決め方: 対戦1勝＝撃破50回＝到達波20。
 * 1試合で撃破は多くて10前後なので、**勝った試合1つが、負け続けた10試合より上**になる。
 * 1人プレイは第10波まで行って50点＝勝利0.5回ぶん。
 * 対戦だけ・1人だけのどちらでも上がるが、対戦の方が伸びる */
export const SCORE = { WIN: 100, KILL: 2, WAVE: 5 };

/** 1人ぶんの点。画面にも同じ式を出すので、ここが唯一の持ち主 */
export const scoreOf = ({ wins, kills, waves } = {}) =>
  Math.max(0, wins | 0) * SCORE.WIN
  + Math.max(0, kills | 0) * SCORE.KILL
  + Math.max(0, waves | 0) * SCORE.WAVE;

/**
 * 遊んだ記録を足す。**対戦の終わりと1人プレイの受け取りから呼ぶ。**
 *
 * どれも「増えるだけ」で減らない。
 * 申告を受け取るのは1人プレイの2つ(waves/kills)だけで、
 * そちらは呼ぶ側が上限で丸めてから渡す（soloCoinsForと同じ考え方）。
 *
 * **財布の行に相乗りしている。** 表を分けると、順位表を出すのに
 * 結合が1つ増える（Neonが寝ている時はそのぶん待つ）
 */
export async function addPlay(query, userId, { wins = 0, kills = 0, waves = 0 } = {}) {
  const w = Math.max(0, wins | 0);
  const k = Math.max(0, kills | 0);
  const v = Math.max(0, waves | 0);
  if (!w && !k && !v) return;
  await query(
    `INSERT INTO wallets (user_id, wins, kills, waves) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE
       SET wins = wallets.wins + EXCLUDED.wins,
           kills = wallets.kills + EXCLUDED.kills,
           waves = wallets.waves + EXCLUDED.waves,
           updated_at = now()`,
    [userId, w, k, v],
  );
}

/**
 * 順位表。**遊んだ量（勝利・撃破・到達波）の点が高い順。**
 *
 * なぜコインではないか: 残高は買うと減るし、
 * **稼いだ総額は台帳から直に足せる**ので、どちらも遊んだ記録にならない。
 *
 * なぜ要るか（2026-08-12に足した理由）: ホーム画面に常に出しておくと、
 * **誰かが新しく登録してくれた時にそれが分かる。**
 * 今は遊んだ記録がサーバーに1つも残らない（撃破数は端末の中だけ）ので、
 * 「人が来たか」を知る手立てがこれしか無い。
 *
 * **名前と点と勝利数しか返さない。** メールもidも返さない
 * （誰でも見える口なので、名前以外を載せると身元が漏れる）。
 *
 * @param limit 何位まで。呼ぶ側が大きい数を渡しても20で止める
 * @returns { rows: [{ name, score, wins }], players: 登録した人の数 }
 */
export async function ranking(query, limit = 10) {
  const n = Math.min(20, Math.max(1, Math.round(limit) || 10));
  /* 点はSQLの中で出す。**JavaScript側で並べ替えない。**
     並べ替えを外へ持つと、20位までに絞る前に全員を持ち出すことになる */
  const top = await query(
    `SELECT u.name,
            COALESCE(w.wins, 0)  AS wins,
            COALESCE(w.kills, 0) AS kills,
            COALESCE(w.waves, 0) AS waves,
            COALESCE(w.wins, 0) * $2 + COALESCE(w.kills, 0) * $3
              + COALESCE(w.waves, 0) * $4 AS score
       FROM users u
       LEFT JOIN wallets w ON w.user_id = u.id
      WHERE u.verified_at IS NOT NULL
      ORDER BY score DESC, wins DESC, u.id ASC
      LIMIT $1`,
    [n, SCORE.WIN, SCORE.KILL, SCORE.WAVE],
  );
  const all = await query('SELECT COUNT(*)::int AS n FROM users WHERE verified_at IS NOT NULL');
  return {
    rows: (top?.rows ?? []).map((r) => ({
      name: String(r.name ?? ''),
      score: Number(r.score ?? 0),
      wins: Number(r.wins ?? 0),
    })),
    players: Number(all?.rows?.[0]?.n ?? 0),
  };
}

/** 今いくら持っているか。財布がまだ無い人は0 */
export async function getCoins(query, userId) {
  const res = await query('SELECT coins FROM wallets WHERE user_id = $1', [userId]);
  return Number(res.rows[0]?.coins ?? 0);
}
