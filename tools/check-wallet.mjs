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
import { COIN, coinsFor, addCoins, getCoins } from '../server/wallet.js';
import { STEPS } from '../server/migrations.js';

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

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
