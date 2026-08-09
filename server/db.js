// 台帳（PostgreSQL）への配管。**繋ぐ・投げる・閉じる、それだけ。**
//
// 誰が会員で、何を持っているか。ここに置く物は
// 「サーバーが落ちても消えてはいけない物」だけ。
// 試合の状態（誰がどこに立っているか）は今まで通りメモリの中で、ここには来ない。
// **60Hzで動いている物をDBへ書きに行くと、その瞬間に試合が止まる。**
//
// 置き場所は Neon（PostgreSQLの管理された置き場）。無料枠で0.5GB。
// 5分触らないと寝るが、次に問い合わせた時に自分で起きる（実測500ms以内）。
// 起きるのを待つのはログインの時だけなので、試合には一切効かない。
//
// **DATABASE_URL が入っていなければ、繋ぎに行かない。**
// このrepoの決まりで、外の物が無くても遊べる（src/player/glbview.js と同じ）。
// アカウント機能ごと畳んで、今まで通り名前を打って遊べる状態になる。
import pg from 'pg';
import { migrate } from './migrations.js';

/* 接続先。**publicなrepoなので、ここに値を書かない。**
   本番は flyctl secrets set DATABASE_URL=... で入れる。
   手元は export DATABASE_URL=... してから npm start */
const URL = process.env.DATABASE_URL || '';

/* 接続の置き場。**繋ぎっぱなしの線を数本持って使い回す（プール）。**
   1回の問い合わせごとに繋いで切ってを繰り返すと、
   TCPの握手とTLSの握手とPostgresの認証で、毎回100ms以上を捨てることになる。
   Neonのように遠くにある置き場だとそれがそのまま待ち時間になる。

   max は2本。**このサーバーは1台しか動かない**（fly.tomlのmin_machines_running=1）うえ、
   DBを触るのはログインと登録だけで、試合中は一切触らない。
   Neonの無料枠は同時接続の数に上限があるので、要らない線を確保しない。

   idleTimeoutMillis を短くしてあるのは、遊んでいない間に線を返して
   Neonを寝かせるため（起きている時間で無料枠を食うので） */
let pool = null;

/** 台帳が使えるか。falseの時はアカウント機能ごと畳む */
export const isEnabled = () => URL !== '';

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: URL,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    /* **プールの中で起きたエラーを拾わないとプロセスごと落ちる。**
       寝ているNeonが線を切ってくる時など、こちらが何もしていない時に飛んでくる。
       試合中の全員がそれで落ちるのは割に合わないので、ここで受け止める */
    pool.on('error', (e) => console.warn('[db] 繋ぎっぱなしの線でエラー:', e.message));
  }
  return pool;
}

/**
 * SQLを1本投げる。
 *
 * **値は必ず params で渡す。文字列を繋いでSQLを組み立てない。**
 * 繋いで組み立てると、名前欄に `' OR 1=1 --` と打った人に
 * 全員ぶんの行を返すことになる（SQLインジェクション）。
 * $1 で渡した物は「値」としてだけ扱われ、SQLの一部として読まれることが無い。
 *
 * @param sql    `SELECT ... WHERE email = $1` のように、値の所を $1 $2 で書く
 * @param params $1 $2 に入る値の配列
 */
export async function query(sql, params) {
  return getPool().query(sql, params);
}

/**
 * 起動時に1回だけ呼ぶ。表を最新の形まで持っていく。
 *
 * **プールではなく1本の接続を取ってから流す。**
 * migrate() は BEGIN と COMMIT で囲むが、プールへ投げると
 * BEGIN と COMMIT が別々の線へ散って、取引にならない。
 *
 * @returns 実際に流した番号の配列。台帳を使わない設定なら null
 */
export async function setup() {
  if (!isEnabled()) return null;
  const client = await getPool().connect();
  try {
    const ran = await migrate((sql, params) => client.query(sql, params));
    if (ran.length) console.log(`[db] 台帳を更新した: ${ran.join(', ')}番`);
    return ran;
  } finally {
    // 借りた線は必ず返す。返さないと2本しかない線が減ったまま戻らない
    client.release();
  }
}

/** 終わる時に線を閉じる。閉じないとプロセスが終わらない */
export async function close() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.end().catch(() => {});
}
