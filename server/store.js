// ストア。買う・持っている物を数える・装備する。
//
// server/auth.js と server/wallet.js と同じで、**ここには接続が無い**
// （DBへ投げる関数を引数でもらう）。検査は台帳に繋がずに全部確かめられる。
//
// **値段はクライアントから受け取らない。** 送られてくるのは「どれを買うか」だけで、
// いくらかは protocol.js の表をサーバーが引く。
// 値段を送らせると、開発者ツールから0円で買えてしまう。
//
// **持っていない物は装備できない。** ここもサーバーが確かめる。
// 画面側でも押せないようにしてあるが、あれは親切であって守りではない。
import {
  parseSku, skuOf, SKINNABLE, DEFAULT_SKIN, SLOTS, canEquipSlot, emptyLook,
} from '../src/net/protocol.js';

/* 買えなかった理由。**画面にそのまま出す文言。**
   「エラー」とだけ返すと、遊ぶ側に打つ手が無くなる */
export const BUY_ERR = {
  BAD: 'そんな商品はありません',
  OWNED: 'もう持っています',
  POOR: 'コインが足りません',
};

/** その人が持っている物のsku一覧 */
export async function ownedOf(query, userId) {
  const res = await query('SELECT sku FROM owned_skins WHERE user_id = $1', [userId]);
  return res.rows.map((r) => r.sku);
}

/** その人が今装備している物。{ rifle:{shape:'stock',paint:'desert'}, ... } */
export async function equippedOf(query, userId) {
  const res = await query(
    'SELECT weapon_id, slot, skin_id FROM equipped_skins WHERE user_id = $1', [userId],
  );
  const out = emptyLook();
  for (const r of res.rows) {
    // **知らない武器・知らない枠は捨てる。** 商品を消した後の古い行が
    // 画面へ届くと、着せられない物を着ているように見える
    if (!out[r.weapon_id] || !SLOTS.includes(r.slot)) continue;
    out[r.weapon_id][r.slot] = r.skin_id;
  }
  return out;
}

/**
 * 買う。**ここが今回の山。**
 *
 * 素直に書くとこうなる:
 *   1. 残高を読む（1200枚）
 *   2. JavaScriptで「1200 >= 300 だから買える」と判定する
 *   3. 残高を900枚に書き換える
 *   4. 持ち物に足す
 *
 * **これは同時に2回押されると壊れる。** 両方が1200枚を読んで、
 * 両方が「買える」と判定して、両方が900枚と書く。
 * 600枚ぶん買ったのに300枚しか減らない。連打で普通に起きる。
 *
 * 正しい形は**判定をUPDATEの中へ入れること。**
 *   UPDATE wallets SET coins = coins - $2 WHERE user_id = $1 AND coins >= $2
 * 「足りている行だけ」を減らすので、読む工程が消える。
 * 減らせなかった時は0行返ってくる＝それが「足りなかった」の返事になる。
 *
 * さらに**取引(BEGIN/COMMIT)で囲む。** 残高を減らした直後に落ちると、
 * 払ったのに物が来ない状態が残る。囲めば両方まとめて無かったことになる。
 *
 * @param query **1本の接続に紐づいた**関数（取引を使うのでプールでは駄目）
 * @returns { ok:false, error } か { ok:true, coins, sku }
 */
export async function buy(query, userId, rawSku) {
  const item = parseSku(rawSku);
  if (!item) return { ok: false, error: BUY_ERR.BAD };

  await query('BEGIN');
  try {
    /* **足りている時だけ減る。** 読んでから判定していない。
       0行返ってきたら、財布が無いか足りないかのどちらか */
    const pay = await query(
      `UPDATE wallets SET coins = coins - $2, updated_at = now()
        WHERE user_id = $1 AND coins >= $2
        RETURNING coins`,
      [userId, item.price],
    );
    if (!pay.rows.length) {
      await query('ROLLBACK');
      return { ok: false, error: BUY_ERR.POOR };
    }

    /* 持ち物へ足す。**2回買えないのは台帳が断る。**
       先にSELECTで確かめる形にすると、確かめてから書くまでの隙間に
       もう1回押されて両方通る（連打で起きる）*/
    try {
      await query(
        'INSERT INTO owned_skins (user_id, sku, price) VALUES ($1, $2, $3)',
        [userId, rawSku, item.price],
      );
    } catch (e) {
      await query('ROLLBACK');
      // 23505 は UNIQUE 違反。**払った分は戻る**（ROLLBACKしたので）
      if (e && e.code === '23505') return { ok: false, error: BUY_ERR.OWNED };
      throw e;
    }

    await query('COMMIT');
    return { ok: true, coins: Number(pay.rows[0].coins), sku: rawSku };
  } catch (e) {
    // ここへ来るのは想定外の失敗。**必ず取り消してから投げる**
    await query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * 装備する。**持っている物しか着けられない。**
 *
 * 標準(stock)はいつでも着けられる。買う物ではないので。
 * **枠(slot)ごとに1つ。** 形と色は別の枠なので、金色の刀が成立する。
 *
 * @param slot 'shape' か 'paint'。**画面が明示して送る。**
 *   idから割り出す形にすると、標準(stock)がどちらの枠にも属さないので
 *   「形を元へ戻す」が送れなくなる（stockは色の枠としか解釈できない）
 * @returns { ok:false, error } か { ok:true, weapon, slot, skin }
 */
export async function equip(query, userId, weapon, slot, skin) {
  /* **その武器の、その枠で扱える物か。** 形違いはその武器専用なので、
     ここを「スキンの一覧に有るか」だけで見ると「ライフルの刀」が着けられる。
     枠まで見ないと、形の枠にゴールドが入って形が消える */
  if (!SKINNABLE.includes(weapon) || !canEquipSlot(weapon, slot, skin)) {
    return { ok: false, error: BUY_ERR.BAD };
  }
  if (skin !== DEFAULT_SKIN) {
    const has = await query(
      'SELECT 1 FROM owned_skins WHERE user_id = $1 AND sku = $2',
      [userId, skuOf(weapon, skin)],
    );
    if (!has.rows.length) return { ok: false, error: '持っていません' };
  }
  /* 武器1本の1枠につき1つ。**入れ替えは1本のSQLで済ませる。**
     消してから入れると、間で落ちた時に何も装備していない状態が残る */
  await query(
    `INSERT INTO equipped_skins (user_id, weapon_id, slot, skin_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, weapon_id, slot) DO UPDATE SET skin_id = EXCLUDED.skin_id`,
    [userId, weapon, slot, skin],
  );
  return { ok: true, weapon, slot, skin };
}

/** 検査から枠の名前を引くため（マイグレーション9番の振り分けと突き合わせる） */
export { SLOTS };
