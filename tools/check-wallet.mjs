// 財布の検査。**台帳に繋がずに走る。**
//
// お金は間違えた時の代償が他と違う。多く配ったら回収できないし
// （減らすと遊ぶ側からは没収に見える）、少なく配ったら気づかれない。
// なので「枚数の数え方」と「足し方」を両方ここで押さえる。
//
// 一番見張りたいのは**ロストアップデート**。
//   SELECT coins → +120 → UPDATE coins = 新しい値
// と書くと、同じ人の2試合がほぼ同時に終わった時に片方が消える。
// SQLの形をここで見張って、その書き方に戻れないようにしてある。
//
//   node tools/check-wallet.mjs
import { readFileSync } from 'node:fs';
import {
  COIN, coinsFor, addCoins, getCoins, SOLO, soloCoinsFor, addSoloCoins,
} from '../server/wallet.js';
import { STEPS } from '../server/migrations.js';
import { SKIN_LIST, SHAPE_LIST } from '../src/net/protocol.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

console.log('\n[1] 枚数の数え方');
{
  ok(coinsFor({ kills: 0, rounds: 0 }, 0) === COIN.JOIN,
    `何もできなくても参加賞は出る（${COIN.JOIN}枚）`);
  ok(coinsFor({ kills: 3, rounds: 0 }, 3) === COIN.JOIN + 3 * COIN.KILL,
    '撃破のぶんが乗る');
  ok(coinsFor({ kills: 0, rounds: 2 }, 2) === COIN.JOIN + 2 * COIN.ROUND + COIN.TOP,
    'ラウンド取得と1位のぶんが乗る');
  // 誰も取っていない試合（0-0の時間切れ）で全員に1位を付けない
  ok(coinsFor({ kills: 1, rounds: 0 }, 0) === COIN.JOIN + COIN.KILL,
    '**誰もラウンドを取っていない試合では1位の加算が付かない**');
  // 同点の時は両方に付ける。「並びの先頭だけ」にすると運で決まる
  ok(coinsFor({ kills: 0, rounds: 2 }, 2) > coinsFor({ kills: 0, rounds: 1 }, 2),
    '同点なら1位のぶんが付き、負けていれば付かない');
}

console.log('\n[2] 変な値で壊れない');
for (const [me, why] of [
  [{ kills: -5, rounds: -5 }, 'マイナス'],
  [{ kills: NaN, rounds: NaN }, '数でない'],
  [{}, '空'],
  [{ kills: 1e9, rounds: 1e9 }, '桁が飛んでいる'],
]) {
  const n = coinsFor(me, 0);
  ok(Number.isInteger(n) && n >= 0 && n <= COIN.MAX_PER_MATCH, `${why} → ${n}枚（0以上・上限以下）`);
}
ok(coinsFor({ kills: 1e9, rounds: 1e9 }, 1) === COIN.MAX_PER_MATCH,
  `**1試合の上限で止まる（${COIN.MAX_PER_MATCH}枚）**。数え方を間違えても桁は飛ばない`);

console.log('\n[3] 台帳の中で足す（読んでから書かない）');
{
  /* ここが今回の肝。**足し算をJavaScript側でやっていないこと**を、
     実際に流れたSQLを見て確かめる */
  const sqls = [];
  const q = async (sql, params) => {
    sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ coins: '340' }] };
  };
  const after = await addCoins(q, '7', 120);
  ok(after === 340, '足した後の残高が返る');
  ok(sqls.length === 1, '**問い合わせは1回だけ**（読んでから書いていない）');
  const s = sqls[0].sql;
  ok(!/SELECT/i.test(s), 'SELECTしていない');
  ok(/coins = wallets\.coins \+ /i.test(s), '**台帳の中で足している**（coins = wallets.coins + …）');
  ok(/ON CONFLICT/i.test(s), '財布がまだ無い人はその場で作る');
  ok(/\$1/.test(s) && /\$2/.test(s), '値は $1 $2 で渡している');
  ok(typeof after === 'number', '文字列で返さない（pgはBIGINTを文字列で返す）');
}

console.log('\n[4] 足さない時は書きにいかない');
{
  const sqls = [];
  const q = async (sql) => { sqls.push(sql); return { rows: [] }; };
  await addCoins(q, '7', 0);
  ok(sqls.length === 1 && /SELECT/i.test(sqls[0]), '0枚なら読むだけ（無駄な書き込みをしない）');
  sqls.length = 0;
  await addCoins(q, '7', -50);
  ok(sqls.length === 1 && /SELECT/i.test(sqls[0]), '**マイナスを渡されても減らさない**');
}

console.log('\n[5] 残高の読み取り');
{
  const none = await getCoins(async () => ({ rows: [] }), '7');
  ok(none === 0, '財布がまだ無い人は0（nullやundefinedを返さない）');
  const some = await getCoins(async () => ({ rows: [{ coins: '1240' }] }), '7');
  ok(some === 1240 && typeof some === 'number', '文字列で来ても数にして返す');
}

console.log('\n[6] 台帳の作り');
{
  const step = STEPS.find((s) => /wallets/.test(s.sql));
  ok(!!step, `財布の手順がある（${step?.n}番）`);
  ok(/user_id\s+BIGINT PRIMARY KEY/.test(step.sql),
    '**1人1行しか作れない**（user_idが主キー）');
  ok(/CHECK \(coins >= 0\)/.test(step.sql),
    '**マイナスの残高を台帳が断る**（買い物の実装を間違えても残らない）');
  ok(/ON DELETE CASCADE/.test(step.sql), '会員を消したら財布も消える');

  /* **入会祝いを上げたら、今いる人にも差額を配る手順が要る。**
     2026-08-13に900から2000へ上げた所で「今いるユーザーにも配っておいて」と言われた。
     上げただけだと、これから登録する人だけが得をして、
     先に登録してくれた人にちょうど逆向きの形になる。

     配るのは**差額**であって全額ではない（全額だと今いる人は2900枚になる）。
     手順の中の枚数と、今の祝い金の差が食い違っていないかを見る */
  const gift = STEPS.find((s) => /入会祝い/.test(s.name));
  ok(!!gift, `差額を配る手順がある（${gift?.n}番）`);
  if (gift) {
    const amount = Number(/SELECT u\.id, (\d+)/.exec(gift.sql)?.[1] ?? 0);
    ok(amount > 0 && amount < COIN.SIGNUP,
      `配るのは差額（${amount}枚 < 祝い金${COIN.SIGNUP}枚）`);
    ok(/INSERT INTO wallets[\s\S]*FROM users/.test(gift.sql),
      '**財布がまだ無い人にも配る**（会員の一覧から作りに行く）');
    ok(/earned\s*=\s*wallets\.earned \+/.test(gift.sql),
      'earnedにも同じだけ足す（addCoinsと揃える）');
    ok(gift.n === Math.max(...STEPS.map((s) => s.n)),
      '手順の一番下に足してある（真ん中に挿し込まない）');
  }
}

console.log('\n[7] 部屋は台帳を知らない');
{
  /* 部屋(server/room.js)がDBを直接触ると、部屋を動かす検査が
     台帳無しでは走らなくなる。配るのは外から差し込む形にしてある */
  const room = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  ok(!/from '\.\/db\.js'/.test(room) && !/from '\.\/wallet\.js'/.test(room),
    '**room.js が db.js も wallet.js も読み込んでいない**');
  ok(/this\.onMatchEnd/.test(room), '配る係は外から差し込む口になっている');
  ok(/this\.onMatchEnd = null/.test(room),
    '差し込まれていなくても動く（台帳を持たないサーバーと検査のため）');

  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/room\.onMatchEnd = payMatch/.test(idx), 'server/index.js が差し込んでいる');
  ok(/if \(!accountsOn\) return null/.test(idx),
    '台帳が無い時は配らずにnullを返す（部屋は枚数を載せずに配る）');
  ok(/if \(!user\) continue/.test(idx),
    '**ログインしていない人とCPUには配らない**（配る先が無い）');
}

console.log('\n[8] 稼いだ枚数の届け方');
{
  const room = readFileSync(new URL('../server/room.js', import.meta.url), 'utf8');
  // 「+120枚」と出したのに増えていない、が一番たちが悪い
  ok(/paying\.then\(finish\)/.test(room), '**書き終わってから配る**');
  ok(/\.catch\(/.test(room), '書けなかった時も試合の終わりは配る（枚数だけ載せない）');

  const cli = readFileSync(new URL('../src/net/client.js', import.meta.url), 'utf8');
  ok(/typeof m\.got === 'number' \? m\.got : null/.test(cli),
    '受け取る側は数でなければ通さない');

  const acc = readFileSync(new URL('../src/ui/account.js', import.meta.url), 'utf8');
  ok(/setCoins\(coins\)/.test(acc), 'ホームの残高を差し替える口がある');
  ok(!/this\.user\.coins \+=/.test(acc),
    '**画面側で足し算をしていない**（台帳が持っている値だけが本当）');
}

/* --------------------------------------------------- 値段との釣り合い */

console.log('\n[9] 値段との釣り合い');
{
  const paid = SKIN_LIST.filter((s) => s.price > 0).map((s) => s.price);
  const cheapest = Math.min(...paid);
  const dearest = Math.max(...paid, ...SHAPE_LIST.map((s) => s.price));

  /* **入会祝いで一番安い物が1つ買えること。**
     0枚から始めると、店を開いても全部が灰色で、
     何が売っているのかを見る前に閉じることになる */
  ok(COIN.SIGNUP >= cheapest,
    `入会祝い(${COIN.SIGNUP}枚)で一番安いスキン(${cheapest}枚)が買える`);

  /* **棚の上の方から1つ選べること。** 2026-08-13に900から2000へ上げた所で、
     「登録してくれた人は、１つぐらいいいスキン変えてもいいから
       2000ぐらいコイン配るようにする？」と言われた。

     ここで見るのは枚数そのものではなく**選ぶ余地**。
     この店の売りは形ごと別の銃になる物（リボルバー・ソードオフ・対物ライフル…）で、
     そこへ届かない額だと「見せ場は見せずに余り物だけ買わせる」形になる。

     前はここに「2つは買えない」と書いてあった。1回だけ体験させる額だった頃の線で、
     上の狙いに変わった今は逆向きになるので外してある */
  const shapes = SHAPE_LIST.filter((s) => s.price > 0).map((s) => s.price);
  const cheapestShape = Math.min(...shapes);
  ok(COIN.SIGNUP >= cheapestShape,
    `形ごと変わる物(一番安くて${cheapestShape}枚)にも手が届く`);
  const good = [...paid, ...shapes].filter((p) => p >= 2000);
  ok(good.length > 0 && COIN.SIGNUP >= Math.min(...good),
    `棚の上の方（2000枚以上が${good.length}点）からも1つ選べる`);

  /* **ただし全部は買えない。** 祝い金だけで棚が埋まると、
     そこから先に遊ぶ理由がスキンの側から1つも出てこなくなる */
  const all = [...paid, ...shapes];
  const reach = all.filter((p) => p <= COIN.SIGNUP).length;
  ok(reach < all.length,
    `棚を全部は買えない（届くのは${reach}/${all.length}点）`);
  ok(COIN.SIGNUP < dearest,
    `一番高い物(${dearest}枚)には届かない（貯める理由を残す）`);

  // 4人デスマッチ1試合ぶんの目安。wallet.jsの説明に書いてある数字と同じ形で数える
  const win = coinsFor({ kills: 12, rounds: 3 }, 3);
  const lose = coinsFor({ kills: 5, rounds: 0 }, 3);
  /* **2026-08-11に「1試合」から「2試合」へ緩めた。**
     一番安い商品が300から800になったので、1試合(365枚)では届かなくなった。

     ここで試合の取り分を上げなかったのは、**上げると全部が近づく**ため。
     1試合で800枚出すと、ゴールド(1500)が2試合・ドラゴン(2000)が2.5試合になり、
     wallet.jsが狙って置いた「ゴールドは4〜5試合」が崩れる。

     見たいのは「最初の1つが遠すぎないこと」なので、3試合以内を線にする。
     **買う体験そのものは入会祝い(900枚)が受け持っている**ので、
     ここは「次の1つまでの距離」を見ていることになる。
     値段の階段は 800→3試合 / 1500→5試合 / 2000→6試合 で素直に伸びている */
  ok(Math.ceil(cheapest / win) <= 3,
    `一番安いスキンが勝ち${Math.ceil(cheapest / win)}試合で届く（3試合以内）`);
  ok(Math.ceil(dearest / win) <= 8,
    `一番高いスキン(${dearest}枚)が勝ち${Math.ceil(dearest / win)}試合で届く`);
  ok(lose > 0 && lose < win, `負けても貰える（${lose}枚）が、勝ちより少ない`);

  /* **1人プレイより対戦の方が旨いこと。**
     ここが逆になると、対戦に人が来なくなる（対戦を増やしたくて上げた数字なので） */
  ok(SOLO.PER_DAY < win * 2,
    `**1人用の1日ぶん(${SOLO.PER_DAY}枚)が対戦2試合(${win * 2}枚)に届かない**`);
}

console.log('\n[10] 1人プレイの枚数（申告を信じない）');
{
  ok(soloCoinsFor({ wave: 10, kills: 80 }) === 10 * SOLO.WAVE + 80 * SOLO.KILL,
    `ウェーブと撃破のぶんが乗る（${soloCoinsFor({ wave: 10, kills: 80 })}枚）`);
  for (const [me, why] of [
    [{ wave: -5, kills: -5 }, 'マイナス'],
    [{ wave: NaN, kills: NaN }, '数でない'],
    [{}, '空'],
    [{ wave: 1e9, kills: 1e9 }, '桁が飛んでいる'],
    [{ wave: '99999', kills: '99999' }, '文字列'],
  ]) {
    const n = soloCoinsFor(me);
    ok(Number.isInteger(n) && n >= 0 && n <= SOLO.PER_RUN, `${why} → ${n}枚（0以上・上限以下）`);
  }
  ok(soloCoinsFor({ wave: 1e9, kills: 1e9 }) === SOLO.PER_RUN,
    `**1回の上限で止まる（${SOLO.PER_RUN}枚）**`);
}

console.log('\n[11] 1日の天井を台帳の中で決めている');
{
  /* 偽の台帳。**行に鍵を掛けて読み直す形になっているか**まで見る。
     ここが素のSELECTだと、同じ人の2回が同時に来た時に両方が同じ
     「今日ぶん」を読んで、天井を2回ぶん突き抜ける */
  const fake = (used, coins = 1000, soloAt = null) => {
    const sqls = [];
    const q = async (sql, params) => {
      sqls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT/i.test(sql.trim())) {
        return { rows: [{ coins: String(coins), used: String(used), solo_at: soloAt }] };
      }
      if (/RETURNING coins/i.test(sql)) {
        return { rows: [{ coins: String(coins + Number(params[1])) }] };
      }
      return { rows: [] };
    };
    return { q, sqls };
  };

  {
    const { q, sqls } = fake(0);
    const r = await addSoloCoins(q, '7', 280);
    ok(r.ok && r.got === 280, `今日まだ受け取っていなければ満額（${r.got}枚）`);
    const all = sqls.map((s) => s.sql).join(' | ');
    ok(/BEGIN/.test(all) && /COMMIT/.test(all), '取引で囲んでいる');
    ok(/FOR UPDATE/i.test(all),
      '**行に鍵を掛けてから読んでいる**（同時に2回来ても天井を突き抜けない）');
    ok(/ON CONFLICT DO NOTHING/i.test(all), '財布がまだ無い人はその場で作る');
  }
  {
    // 今日ぶんが残り少ない時は、残りだけ渡す
    const { q } = fake(SOLO.PER_DAY - 50);
    const r = await addSoloCoins(q, '7', 280);
    ok(r.ok && r.got === 50, `**天井までの残りしか渡さない**（280希望 → ${r.got}枚）`);
  }
  {
    const { q, sqls } = fake(SOLO.PER_DAY);
    const r = await addSoloCoins(q, '7', 280);
    ok(!r.ok && /今日/.test(r.error), `使い切っていたら断る（${r.error}）`);
    // 断った時も時刻は進める。進めないと、上限に当たっている間だけ連投し放題になる
    ok(sqls.some((s) => /solo_at = now\(\)/.test(s.sql)), '断った時も受け取りの時刻は進める');
  }
  {
    // 短い間隔での連投を弾く
    const soon = new Date(Date.now() - (SOLO.MIN_GAP_S - 10) * 1000).toISOString();
    const { q } = fake(0, 1000, soon);
    const r = await addSoloCoins(q, '7', 280);
    ok(!r.ok && /間を空けて/.test(r.error), `連投は弾く（${r.error}）`);
  }
  {
    // 日付が変われば0から数え直す。SQLの側で「今日のぶんか」を見ている
    const { q, sqls } = fake(0);
    await addSoloCoins(q, '7', 100, new Date('2026-08-12T00:00:00Z'));
    const sel = sqls.find((s) => /^SELECT/i.test(s.sql));
    ok(/CASE WHEN solo_day = \$2 THEN solo_today ELSE 0 END/.test(sel.sql),
      '**日付が違えば0から数え直す**（台帳の中で判定している）');
    ok(sel.params[1] === '2026-08-12', `今日の日付を渡している（${sel.params[1]}）`);
  }

  const step = STEPS.find((s) => /solo_today/.test(s.sql));
  ok(!!step, `1人用の記録を足す手順がある（${step?.n}番）`);
  ok(/ALTER TABLE wallets/.test(step.sql), '**財布と同じ行に足している**（2つの表を跨がない）');
  ok(/CHECK \(solo_today >= 0\)/.test(step.sql), 'マイナスを台帳が断る');
}

console.log('\n[12] 1人用の受け口');
{
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/url === '\/api\/solo'/.test(idx), '受け口がある');
  ok(/if \(!me\) \{ sendJson\(res, 401/.test(idx), 'ログインしていない人には配らない');
  ok(/db\.withClient\(\(q\) => addSoloCoins\(q, me\.id, want\)\)/.test(idx),
    '取引を使うので1本の接続の上で呼んでいる');
  ok(/const want = soloCoinsFor\(body\)/.test(idx),
    '**枚数はサーバーが決める**（送られてきた枚数を使っていない）');
  ok(!/body\.(coins|got|amount)/.test(idx), '枚数らしき物を受け取っていない');
  ok(/addCoins\(db\.query, r\.user\.id, COIN\.SIGNUP\)/.test(idx), '登録した人に入会祝いを配る');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/JSON\.stringify\(\{ wave: this\.director\.wave, kills: this\.kills \}\)/.test(main),
    '送るのは到達ウェーブと撃破数だけ');
  ok(/if \(!this\.account\?\.user\) return null/.test(main),
    'ログインしていなければ送らない');
  ok(/if \(res\.status === 404\) return null/.test(main),
    '台帳を持たないサーバーでは黙って何も出さない');
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
