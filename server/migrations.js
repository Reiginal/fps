// 台帳（データベース）の作り替えの手順。**番号順に、まだ流していない物だけ流す。**
//
// なぜこの形にしたか。
//
// 一番簡単なのは `CREATE TABLE IF NOT EXISTS` を起動のたびに流すやり方で、
// 最初の1回はそれで足りる。**足りなくなるのは列を1本足したくなった時。**
// テーブルは既にあるので IF NOT EXISTS は何もせず、追加した列は永遠に来ない。
// 手で ALTER を打ちに行くことになり、本番と手元で中身が違う状態が普通になる。
//
// ゲーム内通貨とスキンで wallets と owned_skins が来るのは決まっているので、
// **最初からこちらで作る。** 仕組み自体は小さい:
//
//   1. DB側に schema_version という表を1つ持って、流し終わった番号を書く
//   2. 起動時に「書いていない番号」だけを順に流す
//   3. 流したら同じ取引（トランザクション）の中で番号を書く
//
// 3が肝で、**表を作った直後に回線が切れる**ようなことが起きても、
// 「表はあるのに番号が書かれていない」状態にならない。次の起動でもう一度流れて、
// CREATE TABLE が「もうある」と怒って**サーバーが起動しなくなる**のを防ぐ。
// PostgreSQLは CREATE TABLE も取引の中に入れられる（これができないDBもある）。
//
// **一度出した手順は二度と書き換えない。** 直したい時は新しい番号を足す。
// 書き換えると、既に流し終わった環境（本番）と、これから流す環境（新しい手元）で
// 出来上がる形が変わってしまい、**その2つは二度と揃わない。**

/* 手順の一覧。**下に足す。真ん中に挿し込まない。**
   n は1から続き番号。tools/check-auth.mjs が飛びと重複を見張る */
export const STEPS = [
  {
    n: 1,
    name: '会員名簿',
    /* email は必ず小文字に均してから入れる（均すのは server/auth.js の仕事）。
       UNIQUE を付けてあるので、同じメアドで2回登録すると**DBが断る。**
       アプリ側でも先に確かめるが、確かめてから書くまでの隙間に
       もう1通来ることがあるので、最後の砦はこちらに置く。

       verified_at が null なのが「メールの確認がまだ」の状態。
       **確認前でも遊べる。** 確認しないと遊べない作りにすると、
       身内に配った時に最初の1歩で全員が詰まる。
       確認を要るようにするのは、お金を使う所だけにする */
    sql: `CREATE TABLE users (
      id          BIGSERIAL PRIMARY KEY,
      email       TEXT NOT NULL UNIQUE,
      pass_hash   TEXT NOT NULL,
      name        TEXT NOT NULL,
      verified_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    n: 2,
    name: '配ってある番号札',
    /* **札そのものは書かない。** 書くのは札を潰した物（token_hash）。
       ここが漏れても、書いてある文字列から札は作れないので誰にも成りすませない。

       ON DELETE CASCADE は「会員を消したら、その人の札も一緒に消える」。
       付けておかないと、消えた会員の札が残り続けて、
       その札を持っている人がどこの誰でもない状態でログインできてしまう */
    sql: `CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    n: 3,
    name: '番号札の索引',
    /* 期限切れを掃除する時に使う。索引が無いと、掃除のたびに全部の札を見ることになる。
       user_id の方は「この人のログインを全部切る」を後から足す時に要る */
    sql: `CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);
          CREATE INDEX sessions_user_id_idx    ON sessions (user_id)`,
  },
  {
    n: 4,
    name: 'メール確認の合言葉',
    /* 確認メールのリンクに入れる合言葉。札と同じで**潰した物だけ**を書く。
       期限を持たせるのは、受信箱に残った古いリンクが何ヶ月後でも効くのを防ぐため */
    sql: `CREATE TABLE email_tokens (
      token_hash TEXT PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    n: 5,
    name: '財布',
    /* ゲーム内通貨。**1人1行しか無い。**
       user_id をそのまま主キーにしてあるので、
       同じ人の財布が2つできることが台帳の作りとして起きない。

       CHECK (coins >= 0) は最後の砦。買い物を作った時に
       「残高より高い物を買えてしまう」不具合を書いても、**台帳が断る。**
       アプリ側でも当然確かめるが、そこを間違えた時にマイナスの残高が
       残る方が後始末が難しい（どこまで戻せばいいのか誰にも分からなくなる）。

       BIGINT なのは、後で「1コイン＝小数点以下も持つ通貨」にしたくなった時に
       整数のまま桁を増やせるようにするため。お金を小数で持つのは事故のもと */
    sql: `CREATE TABLE wallets (
      user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      coins      BIGINT NOT NULL DEFAULT 0 CHECK (coins >= 0),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`,
  },
  {
    n: 6,
    name: '持っているスキン',
    /* 買った物。sku は 'rifle:desert' の形で、**武器ごとに別の商品**。
       主キーを (user_id, sku) にしてあるので、
       **同じ物を2回買うことが台帳の作りとして起きない。**
       アプリ側でも確かめるが、確かめてから書くまでの隙間に
       もう1回押されると両方通る（連打で起きる）。最後の砦はこちら。

       price を残すのは、後で値段を変えても
       「いくらで買ったか」が消えないようにするため。
       現金を入れる段になると、ここが領収の記録の下地になる */
    sql: `CREATE TABLE owned_skins (
      user_id BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sku     TEXT        NOT NULL,
      price   INTEGER     NOT NULL,
      got_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, sku)
    )`,
  },
  {
    n: 7,
    name: '装備しているスキン',
    /* 武器1本につき1つ。主キーが (user_id, weapon_id) なので、
       同じ武器に2つ装備することが起きない。

       **持っているかどうかはここでは見ない。** 見るのはアプリ側（server/store.js）。
       台帳に「持っている物しか入れられない」を書くこともできる（外部キー）が、
       そうすると持ち物を消した時に装備の行が道連れで消えて、
       何を装備していたかの記録まで無くなる */
    sql: `CREATE TABLE equipped_skins (
      user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      weapon_id TEXT   NOT NULL,
      skin_id   TEXT   NOT NULL,
      PRIMARY KEY (user_id, weapon_id)
    )`,
  },
  {
    n: 8,
    name: '1人用の受け取り記録',
    /* **1人プレイの取り分は「その日いくら受け取ったか」で縛る。**

       1人プレイはサーバーに繋がっていないので、枚数の元になる数字
       （何波まで行ったか）は本人の申告しか無い。開発者ツールから
       「50波まで行った」と送れる。だから**数字を信じないで済む形**にする。

       信じる代わりに天井を置く。1日いくらまでと決めておけば、
       いくら嘘をついてもその日の上限で止まる。
       上限を対戦2試合ぶんより下にしておけば、嘘をつく意味そのものが消える。

       solo_day … その数字がいつの日付のぶんか（日付が変われば0から数え直す）
       solo_today … その日ここまでに受け取った枚数
       solo_at … 最後に受け取った時刻。**短い間隔での連投を弾く**のに使う
                 （倒れた直後に何十回も送りつける形を止める）

       **wallets に足す形にしてある。**別の表にすると、
       払う時に2つの表を同じ取引で触ることになって、片方だけ書けた状態が作れる */
    sql: `ALTER TABLE wallets
      ADD COLUMN solo_day   DATE,
      ADD COLUMN solo_today INTEGER NOT NULL DEFAULT 0 CHECK (solo_today >= 0),
      ADD COLUMN solo_at    TIMESTAMPTZ`,
  },
  // 現金を入れる時の明細(ledger)はここへ足す。上の8つには二度と触らない
];

/**
 * 手順の並びが壊れていないか。
 *
 * **番号が飛ぶと、飛んだ先が永遠に流れない**（流し終わった番号の集合で判定するので
 * 飛び自体は動くが、後から間を埋めた時に本番だけ抜ける）。
 * 重複はもっと悪くて、どちらが流れたのか分からなくなる。
 *
 * 検査から叩けるように、投げずに理由を返す形にしてある。
 * @returns 問題があれば理由の配列。無ければ空
 */
export function checkSteps(steps = STEPS) {
  const bad = [];
  const seen = new Set();
  /* **1から始まっていること。** ここを見ないと、頭の何本かを消した表が通ってしまう。
     消した手順は新しい台帳では二度と流れないので、
     本番（既に流し終わっている）だけが正しい形になり、新しい手元は壊れる */
  if (steps.length && steps[0].n !== 1) bad.push(`1から始まっていない: ${steps[0].n}`);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!Number.isInteger(s.n) || s.n < 1) bad.push(`${i}番目の n が整数でない: ${s.n}`);
    if (seen.has(s.n)) bad.push(`番号が重複している: ${s.n}`);
    seen.add(s.n);
    if (!s.sql || typeof s.sql !== 'string') bad.push(`${s.n}番に sql が無い`);
    if (!s.name) bad.push(`${s.n}番に name が無い`);
    if (i > 0 && s.n !== steps[i - 1].n + 1) {
      bad.push(`番号が続いていない: ${steps[i - 1].n} の次が ${s.n}`);
    }
  }
  return bad;
}

/* 流し終わった番号を書いておく表。これ自体は手順の外にある
   （手順を数えるための表なので、手順の中には置けない） */
const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS schema_version (
  n     INTEGER PRIMARY KEY,
  at    TIMESTAMPTZ NOT NULL DEFAULT now()
)`;

/**
 * まだ流していない手順を流す。
 *
 * @param query 1本のSQLを投げる関数。`(sql, params) => Promise<{rows}>`。
 *              **取引を使うので、必ず同じ接続に紐づいた物を渡すこと**
 *              （プールに投げると BEGIN と COMMIT が別の接続へ散る）
 * @param steps 手順。既定は上の表。検査は偽物を渡す
 * @returns 実際に流した番号の配列
 */
export async function migrate(query, steps = STEPS) {
  const bad = checkSteps(steps);
  // 並びが壊れているなら1本も流さない。中途半端に流す方が後始末が難しい
  if (bad.length) throw new Error(`マイグレーションの並びが壊れている: ${bad.join(' / ')}`);

  await query(VERSION_TABLE);
  const done = await query('SELECT n FROM schema_version');
  const already = new Set((done?.rows ?? []).map((r) => Number(r.n)));

  const ran = [];
  for (const s of steps) {
    if (already.has(s.n)) continue;
    /* 1手順＝1取引。**中身と番号を同時に確定させる。**
       別々にすると、間で落ちた時に「表はあるのに番号が無い」状態が残り、
       次の起動で同じ CREATE TABLE が走って起動できなくなる */
    await query('BEGIN');
    try {
      await query(s.sql);
      await query('INSERT INTO schema_version (n) VALUES ($1)', [s.n]);
      await query('COMMIT');
    } catch (e) {
      await query('ROLLBACK');
      // 元の失敗をcauseに付ける。付けないと、Postgresが返した番号と場所が消えて
      // 「4番で止まった」しか残らない
      throw new Error(`${s.n}番(${s.name})で止まった: ${e.message}`, { cause: e });
    }
    ran.push(s.n);
  }
  return ran;
}
