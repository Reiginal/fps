// 会員証まわりの判定。**ここには接続が無い。**
//
// なぜファイルを分けてあるか: server/index.js は読み込むとサーバーが起動するので、
// 判定だけを試すことができない（server/serve-rules.js と server/report.js と同じ理由）。
// DBへ投げる関数も引数でもらう形にしてあるので、**検査は台帳に繋がずに全部確かめられる。**
//
// この層が守っている物は3つ。
//   1. パスワードを戻せない形にしてから渡す（生のまま台帳へ行かせない）
//   2. 番号札（セッション）も潰してから渡す（台帳が漏れても成りすませない）
//   3. 外から来た文字を、形と長さで必ず切る
import {
  randomBytes, scrypt as scryptCb, timingSafeEqual, createHash,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

/* --------------------------------------------------------- パスワード */

/* scryptの強さ。**わざと遅くするための数字。**
   普通のハッシュ（SHA-256）は速いのが取り柄で、だからこそ
   総当たりも速い。パスワードは「1回試すのに時間がかかる」方が正しい。

   N=16384 は 128*N*r = 16MB のメモリを使う設定で、手元の実測で1回あたり約60ms。
   人がログインする時に60ms待つのは気づかないが、
   総当たりする側は1回ごとに16MBと60msを払うことになる。

   **数字を後から上げられるように、潰した文字列の中へ書き込んである。**
   保存済みの物は昔の数字で読めて、次に入れ直した時から新しい数字になる */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALTLEN = 16;
// 128*N*r を超えるとNodeが断るので、少し余裕を持たせて明示する
const MAXMEM = 64 * 1024 * 1024;

/**
 * パスワードを戻せない形へ潰す。
 *
 * **同じパスワードでも毎回違う文字列になる。** 1人ずつ違う塩(salt)を混ぜるため。
 * 混ぜないと、同じパスワードの人が台帳の上で同じ文字列になり、
 * 「この2人は同じパスワード」が漏れるうえ、
 * よくあるパスワードの潰した形を一覧で持っておけば一気に照合できてしまう。
 */
export async function hashPassword(plain) {
  const salt = randomBytes(SALTLEN);
  const key = await scrypt(plain, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  // 区切りは $。強さの数字を中に入れておくと、後から上げても古い物が読める
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * 合っているか確かめる。
 *
 * **比べるのに === を使わない。** 文字列の比較は違う所で打ち切るので、
 * 「何文字目まで合っていたか」が返ってくるまでの時間に出る。
 * timingSafeEqual は長さが同じなら必ず同じ時間で比べる。
 */
export async function verifyPassword(plain, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let want;
  try {
    salt = Buffer.from(parts[4], 'base64');
    want = Buffer.from(parts[5], 'base64');
  } catch { return false; }
  if (!salt.length || !want.length) return false;
  let got;
  try {
    got = await scrypt(plain, salt, want.length, { N: n, r, p, maxmem: MAXMEM });
  } catch { return false; }
  // 長さが違うと timingSafeEqual は投げるので、先に見る
  if (got.length !== want.length) return false;
  return timingSafeEqual(got, want);
}

/* **居ない人のログインでも、同じだけ時間をかけるための捨て札。**
   台帳に居なければ即座に「違う」を返すと、
   返ってくるまでの速さで「そのメアドは登録されている / されていない」が分かる。
   会員かどうかが外から総当たりで調べられるのは、それだけで漏洩になる */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

/* ------------------------------------------------------------ 番号札 */

/* Cookieに入れる名前。ゲームの他のlocalStorageと揃えて blackout. で始める */
export const COOKIE_NAME = 'blackout_sid';
/* 札の寿命。30日。遊ぶたびにログインさせない */
export const SESSION_DAYS = 30;
/* 確認メールのリンクの寿命。受信箱に残った古いリンクが何ヶ月後でも効くのを防ぐ */
export const EMAIL_TOKEN_HOURS = 24;

/** 新しい札。32バイトの完全な乱数。総当たりできる量ではない */
export const newToken = () => randomBytes(32).toString('base64url');

/**
 * 札を潰す。**台帳には潰した物だけを書く。**
 *
 * パスワードと違って、こちらはSHA-256でいい。
 * 札は完全な乱数なので「よくある札の一覧」が作れず、わざと遅くする理由が無い
 */
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

/**
 * Cookieに付ける印。**この3つが揃っていないと札を守れない。**
 *
 *   HttpOnly … JavaScriptから読めなくなる。
 *              これが無いと、ページに悪いスクリプトが1本混ざるだけで札を盗まれる
 *   Secure   … httpsでしか送らない。街のWi-Fiで盗み見られるのを防ぐ
 *   SameSite … 他所のサイトから勝手に送られない。
 *              罠のページを踏むだけでログイン状態で操作させられるのを防ぐ
 *
 * @param secure httpsで動いているか。**手元(http://localhost)ではfalse。**
 *               trueで固定すると、手元でCookieが1つも保存されず、
 *               ログインした直後にログアウトしているように見える
 */
export function cookieHeader(token, { secure = true, maxAgeSec = SESSION_DAYS * 86400 } = {}) {
  const bits = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec | 0}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/** ログアウト用。同じ名前を空にして、寿命0で上書きする */
export function clearCookieHeader({ secure = true } = {}) {
  return cookieHeader('', { secure, maxAgeSec: 0 });
}

/**
 * Cookieのヘッダから1つ取り出す。
 * `a=1; b=2` の形で来る。値に = が入ることがあるので、最初の = だけで割る
 */
export function readCookie(header, name = COOKIE_NAME) {
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    if (part.slice(0, at).trim() !== name) continue;
    return part.slice(at + 1).trim();
  }
  return null;
}

/* -------------------------------------------------------- 入力の検査 */

/* メアドの長さの上限。決まりの上でこれ以上は無い */
const EMAIL_MAX = 254;
/* パスワードの下限。**8文字。** 4文字を許すと総当たりが現実的になる。
   上限を置くのは、長すぎる物をscryptに通すとそこだけCPUを食うため */
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;
/* 名前は12文字。index.htmlの名前欄(maxlength=12)と揃える。
   片方だけ広いと、打てるのに登録で断られる */
export const NAME_MAX = 12;

/** 大文字小文字と前後の空白を均す。**台帳へ入れる前に必ず通す** */
export const normalizeEmail = (s) => String(s ?? '').trim().toLowerCase();

/**
 * メアドの形。**厳しくしすぎない。**
 * 決まりの上で有効なメアドは正規表現1本では表せないので、
 * ここでは明らかにおかしい物だけ弾いて、本当に届くかは確認メールに任せる
 * @returns 問題があれば理由。無ければnull
 */
export function checkEmail(raw) {
  const s = normalizeEmail(raw);
  if (!s) return 'メールアドレスを入れてください';
  if (s.length > EMAIL_MAX) return 'メールアドレスが長すぎます';
  // @が1つ、その前後に空白でない文字、後ろにドットが1つ以上
  if (!/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(s)) return 'メールアドレスの形が違います';
  return null;
}

/** @returns 問題があれば理由。無ければnull */
export function checkPassword(raw) {
  const s = String(raw ?? '');
  if (s.length < PASSWORD_MIN) return `パスワードは${PASSWORD_MIN}文字以上にしてください`;
  if (s.length > PASSWORD_MAX) return 'パスワードが長すぎます';
  return null;
}

/** @returns 問題があれば理由。無ければnull */
export function checkName(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '名前を入れてください';
  if (s.length > NAME_MAX) return `名前は${NAME_MAX}文字までです`;
  // 制御文字は順位表の見た目を壊すので通さない
  for (const ch of s) if (ch.codePointAt(0) < 0x20) return '名前に使えない文字が入っています';
  return null;
}

/* ------------------------------------------------------------ 本体 */
/* 以下は全部「queryをもらって、答えを返す」形。台帳の中身を知っているのはここだけ */

const userRow = (r) => (r ? {
  id: String(r.id), email: r.email, name: r.name, verified: !!r.verified_at,
} : null);

/**
 * 入会。
 *
 * @returns { ok:false, error } か { ok:true, user, emailToken }
 *          emailToken は確認メールに載せる合言葉（**潰す前の物**。呼ぶ側が送る）
 */
export async function register(query, { email, password, name }, now = new Date()) {
  const bad = checkEmail(email) || checkPassword(password) || checkName(name);
  if (bad) return { ok: false, error: bad };

  const mail = normalizeEmail(email);
  const nick = String(name).trim();
  const hash = await hashPassword(password);

  let res;
  try {
    res = await query(
      `INSERT INTO users (email, pass_hash, name) VALUES ($1, $2, $3)
       RETURNING id, email, name, verified_at`,
      [mail, hash, nick],
    );
  } catch (e) {
    /* 23505 は「UNIQUE に引っかかった」というPostgresの決まった番号。
       **先にSELECTで確かめてからINSERTする形にしない。**
       確かめてから書くまでの隙間にもう1通来ると、両方とも通ってしまう。
       台帳のUNIQUEに断らせて、その返事を読む方が確実 */
    if (e && e.code === '23505') return { ok: false, error: 'そのメールアドレスは登録済みです' };
    throw e;
  }

  const user = userRow(res.rows[0]);
  const token = newToken();
  const exp = new Date(now.getTime() + EMAIL_TOKEN_HOURS * 3600_000);
  await query(
    'INSERT INTO email_tokens (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), user.id, exp],
  );
  return { ok: true, user, emailToken: token };
}

/**
 * 来店。合っていたら札を1枚出す。
 *
 * **「メアドが違う」と「パスワードが違う」を言い分けない。**
 * 言い分けると、そのメアドが登録されているかを外から総当たりで調べられる
 */
export async function login(query, { email, password }, now = new Date()) {
  const mail = normalizeEmail(email);
  const res = await query(
    'SELECT id, email, name, pass_hash, verified_at FROM users WHERE email = $1',
    [mail],
  );
  const row = res.rows[0];
  // 居なくても同じだけ時間をかける（上の DUMMY_HASH の説明）
  const good = await verifyPassword(password, row ? row.pass_hash : DUMMY_HASH);
  if (!row || !good) return { ok: false, error: 'メールアドレスかパスワードが違います' };

  const token = newToken();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400_000);
  await query(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)',
    [hashToken(token), row.id, exp],
  );
  return { ok: true, token, user: userRow(row) };
}

/**
 * 札を見せてもらって、誰かを返す。**期限は台帳側で見る。**
 * こちらの時計で見ると、サーバーの時計がずれた時に全員の札が切れる
 */
export async function sessionUser(query, token) {
  if (!token) return null;
  const res = await query(
    `SELECT u.id, u.email, u.name, u.verified_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return userRow(res.rows[0]);
}

/** 札を捨てる。**DBから消せば次の瞬間から無効。** JWTだとこれができない */
export async function logout(query, token) {
  if (!token) return;
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

/**
 * メールのリンクを踏んだ時。確認済みにして、合言葉を捨てる。
 * @returns 確認できた人。合言葉が古い・知らない物ならnull
 */
export async function verifyEmail(query, token) {
  if (!token) return null;
  const res = await query(
    `DELETE FROM email_tokens
      WHERE token_hash = $1 AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token)],
  );
  const row = res.rows[0];
  if (!row) return null;
  const up = await query(
    `UPDATE users SET verified_at = now()
      WHERE id = $1 RETURNING id, email, name, verified_at`,
    [row.user_id],
  );
  return userRow(up.rows[0]);
}

/**
 * 期限の切れた札と合言葉を捨てる。
 * 放っておくと、ログインのたびに1行ずつ増え続けて二度と減らない
 */
export async function sweepExpired(query) {
  await query('DELETE FROM sessions WHERE expires_at < now()');
  await query('DELETE FROM email_tokens WHERE expires_at < now()');
}
