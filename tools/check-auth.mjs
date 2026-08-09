// 会員証の検査。
//
// **台帳(DB)に一切繋がずに走る。** SQLを投げる関数は偽物を渡す。
// 繋ぐ形にすると、CIにDBが要るうえ、検査どうしが同じ台帳を取り合って壊れる。
// server/auth.js が「queryをもらって答えを返す」形になっているのはこのため。
//
// ここで見張るのは、間違えた時に**静かに危なくなる**所に絞ってある:
//   ・パスワードが戻せる形で保存されていないか
//   ・居ない人と居る人で返事の仕方が変わっていないか（会員かどうかが漏れる）
//   ・Cookieの印が3つ揃っているか（1つ欠けると札が盗める）
//   ・台帳が無い時に口が消えているか（遊べなくなっていないか）
//
//   node tools/check-auth.mjs
import { readFileSync } from 'node:fs';
import {
  hashPassword, verifyPassword, newToken, hashToken,
  cookieHeader, clearCookieHeader, readCookie, COOKIE_NAME,
  checkEmail, checkPassword, checkName, normalizeEmail,
  register, login, sessionUser, logout, verifyEmail,
  PASSWORD_MIN, NAME_MAX,
} from '../server/auth.js';
import { STEPS, checkSteps, migrate } from '../server/migrations.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* ------------------------------------------------------------ 偽の台帳 */

/* SQLの形だけ見て、それらしい返事をする。**本物のPostgresではない。**
   ここで確かめたいのは auth.js の筋道であって、SQLの実行結果ではない
   （SQLそのものが正しいかは、本番で1度動かせば分かる種類の話） */
function fakeDb() {
  const users = [];
  const sessions = [];
  const emailTokens = [];
  let nextId = 1;
  const sqls = [];

  const query = async (sql, params = []) => {
    sqls.push(sql.replace(/\s+/g, ' ').trim());
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('INSERT INTO users')) {
      const [email, hash, name] = params;
      if (users.some((u) => u.email === email)) {
        // Postgresが UNIQUE 違反で返す番号。auth.js はこれを読んで文言を出す
        const e = new Error('duplicate key'); e.code = '23505'; throw e;
      }
      /* **idは文字列で持つ。** 本物のpgもBIGINTを文字列で返す
         （JavaScriptの数値では大きい整数を正確に持てないため）。
         ここを数値にすると、検査だけ通って本番で取り違える形の偽物になる */
      const u = { id: String(nextId++), email, pass_hash: hash, name, verified_at: null };
      users.push(u);
      return { rows: [u] };
    }
    if (s.startsWith('SELECT id, email, name, pass_hash')) {
      const u = users.find((x) => x.email === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (s.startsWith('INSERT INTO sessions')) {
      sessions.push({ token_hash: params[0], user_id: params[1], expires_at: params[2] });
      return { rows: [] };
    }
    if (s.startsWith('SELECT u.id, u.email')) {
      const now = Date.now();
      const se = sessions.find((x) => x.token_hash === params[0] && +x.expires_at > now);
      const u = se && users.find((x) => x.id === se.user_id);
      return { rows: u ? [u] : [] };
    }
    if (s.startsWith('DELETE FROM sessions WHERE token_hash')) {
      const at = sessions.findIndex((x) => x.token_hash === params[0]);
      if (at >= 0) sessions.splice(at, 1);
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO email_tokens')) {
      emailTokens.push({ token_hash: params[0], user_id: params[1], expires_at: params[2] });
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM email_tokens WHERE token_hash')) {
      const now = Date.now();
      const at = emailTokens.findIndex((x) => x.token_hash === params[0] && +x.expires_at > now);
      if (at < 0) return { rows: [] };
      const [t] = emailTokens.splice(at, 1);
      return { rows: [{ user_id: t.user_id }] };
    }
    if (s.startsWith('UPDATE users SET verified_at')) {
      const u = users.find((x) => x.id === params[0]);
      if (u) u.verified_at = new Date();
      return { rows: u ? [u] : [] };
    }
    return { rows: [] };
  };
  return { query, users, sessions, emailTokens, sqls };
}

const GOOD = { email: 'Aki@Example.com', password: 'hunter22ok', name: 'あき' };

/* ------------------------------------------------------ パスワード */

console.log('\n[1] パスワードは戻せない形で保存する');
{
  const a = await hashPassword('hunter22ok');
  const b = await hashPassword('hunter22ok');
  ok(!a.includes('hunter22ok'), '生のパスワードが文字列に残っていない');
  ok(a !== b, '**同じパスワードでも毎回違う文字列になる**（1人ずつ塩が違う）');
  ok(a.startsWith('scrypt$'), '方式と強さが文字列に書いてある（後から強くできる）');
  ok(a.split('$').length === 6, '方式・N・r・p・塩・本体の6つに分かれている');
  ok(await verifyPassword('hunter22ok', a), '正しいパスワードで通る');
  ok(!await verifyPassword('hunter22oK', a), '1文字違うと通らない');
  ok(!await verifyPassword('', a), '空では通らない');
}

console.log('\n[2] 壊れた保存文字列で通らない');
for (const s of ['', 'x', 'scrypt$1$2$3', 'plain$hunter22ok', null, undefined,
  'scrypt$notnum$8$1$AAAA$AAAA']) {
  ok(!await verifyPassword('hunter22ok', s), `${JSON.stringify(s)} では通らない`);
}

/* ---------------------------------------------------------- 番号札 */

console.log('\n[3] 番号札');
{
  const t1 = newToken();
  const t2 = newToken();
  ok(t1 !== t2, '毎回違う');
  ok(t1.length >= 40, `十分に長い（${t1.length}文字＝32バイト）`);
  ok(!/[^A-Za-z0-9_-]/.test(t1), 'URLとCookieにそのまま入る文字だけ');
  ok(hashToken(t1) !== t1, '**台帳へ書くのは潰した物で、札そのものではない**');
  ok(hashToken(t1) === hashToken(t1), '同じ札からは同じ物が出る');
  ok(hashToken(t1) !== hashToken(t2), '違う札からは違う物が出る');
}

console.log('\n[4] Cookieの印が3つ揃っている');
{
  const h = cookieHeader('abc', { secure: true });
  ok(h.includes('HttpOnly'), 'HttpOnly … JavaScriptから読めない（盗まれない）');
  ok(h.includes('Secure'), 'Secure … httpsでしか送らない');
  ok(/SameSite=(Lax|Strict)/.test(h), 'SameSite … 他所のサイトから勝手に送られない');
  ok(h.startsWith(`${COOKIE_NAME}=abc`), '名前と値が先頭にある');
  ok(h.includes('Path=/'), 'Path=/ … どのページでも送られる');

  // 手元(http://localhost)ではSecureを外す。付けたままだとCookieが1つも保存されず、
  // ログインした直後にログアウトしているように見える
  ok(!cookieHeader('abc', { secure: false }).includes('Secure'), 'httpの時はSecureを付けない');
  ok(/Max-Age=0(;|$)/.test(clearCookieHeader({ secure: true })), 'ログアウトは寿命0で上書きする');
}

console.log('\n[5] Cookieの読み取り');
{
  ok(readCookie(`${COOKIE_NAME}=abc`) === 'abc', '1つだけの時');
  ok(readCookie(`a=1; ${COOKIE_NAME}=abc; b=2`) === 'abc', '他が混ざっていても取れる');
  ok(readCookie(`${COOKIE_NAME}=a=b=c`) === 'a=b=c', '値に = が入っていても切れない');
  ok(readCookie('a=1; b=2') === null, '無ければnull');
  ok(readCookie('') === null, '空でも落ちない');
  ok(readCookie(undefined) === null, 'Cookieが1つも無い相手でも落ちない');
  // 名前の前方一致で拾うと、blackout_sid_evil= を置かれて乗っ取られる
  ok(readCookie(`${COOKIE_NAME}x=evil`) === null, '**似た名前を取り違えない**');
}

/* -------------------------------------------------------- 入力の検査 */

console.log('\n[6] 入力の形を弾く');
ok(checkEmail('a@b.co') === null, 'まともなメアドは通る');
ok(normalizeEmail('  Aki@Example.COM ') === 'aki@example.com', '大文字と前後の空白を均す');
for (const s of ['', 'abc', 'a@b', 'a b@c.jp', 'a@@b.jp', `${'a'.repeat(250)}@b.jp`]) {
  ok(checkEmail(s) !== null, `${JSON.stringify(s)} は断る`);
}
ok(checkPassword('x'.repeat(PASSWORD_MIN)) === null, `${PASSWORD_MIN}文字は通る`);
ok(checkPassword('x'.repeat(PASSWORD_MIN - 1)) !== null, `${PASSWORD_MIN - 1}文字は断る`);
ok(checkPassword('x'.repeat(500)) !== null, '長すぎる物は断る（そこだけCPUを食う）');
ok(checkName('あき') === null, '名前は通る');
ok(checkName('') !== null, '空の名前は断る');
ok(checkName('あ'.repeat(NAME_MAX + 1)) !== null, `${NAME_MAX}文字を超えたら断る`);
ok(checkName('あ き') !== null, '制御文字の入った名前は断る（順位表の見た目が壊れる）');

/* ------------------------------------------------------------ 本体 */

console.log('\n[7] 入会');
{
  const db = fakeDb();
  const r = await register(db.query, GOOD);
  ok(r.ok, '登録できた');
  ok(db.users.length === 1, '台帳に1行できた');
  ok(db.users[0].email === 'aki@example.com', '**メアドは小文字に均してから入る**');
  ok(!db.users[0].pass_hash.includes(GOOD.password), '生のパスワードが台帳に無い');
  ok(db.users[0].verified_at === null, '確認はまだ（それでも遊べる）');
  ok(!!r.emailToken, '確認メール用の合言葉が返る');
  ok(db.emailTokens.length === 1 && db.emailTokens[0].token_hash === hashToken(r.emailToken),
    '**合言葉も潰した物だけが台帳に入る**');

  const again = await register(db.query, GOOD);
  ok(!again.ok, '同じメアドで2回目は断られる');
  ok(db.users.length === 1, '2行目ができていない');

  // 大文字で来ても同じ人として扱う。均していないと2人になる
  const upper = await register(db.query, { ...GOOD, email: 'AKI@EXAMPLE.COM' });
  ok(!upper.ok, '**大文字で書いても同じメアドとして断る**');

  ok(!(await register(db.query, { ...GOOD, email: 'b@b.jp', password: 'short' })).ok,
    '短いパスワードは断る');
  ok(!(await register(db.query, { ...GOOD, email: 'zzz', password: 'hunter22ok' })).ok,
    'メアドの形が違えば断る');
}

console.log('\n[8] ログイン');
{
  const db = fakeDb();
  await register(db.query, GOOD);

  const r = await login(db.query, { email: GOOD.email, password: GOOD.password });
  ok(r.ok && !!r.token, 'ログインできて札が出る');
  ok(db.sessions.length === 1, '札が台帳に1枚');
  ok(db.sessions[0].token_hash === hashToken(r.token), '台帳にあるのは潰した物');
  ok(db.sessions[0].token_hash !== r.token, '**札そのものは台帳に無い**');

  const lower = await login(db.query, { email: 'AKI@example.com', password: GOOD.password });
  ok(lower.ok, '大文字で打ってもログインできる');

  const ng = await login(db.query, { email: GOOD.email, password: 'hunter22oX' });
  ok(!ng.ok, 'パスワードが違えば断る');

  const none = await login(db.query, { email: 'nobody@example.com', password: GOOD.password });
  ok(!none.ok, '居ない人は断る');
  // ここが漏れると、メアドの総当たりで「会員かどうか」が調べられる
  ok(none.error === ng.error, '**居ない人と、パスワード違いで、同じ文言を返す**');
}

console.log('\n[9] 札を見せて誰かを引く');
{
  const db = fakeDb();
  await register(db.query, GOOD);
  const { token } = await login(db.query, { email: GOOD.email, password: GOOD.password });

  const u = await sessionUser(db.query, token);
  ok(!!u && u.name === GOOD.name, '札から本人が引ける');
  ok(await sessionUser(db.query, '知らない札') === null, '知らない札では引けない');
  ok(await sessionUser(db.query, null) === null, '札が無ければnull（台帳へ聞きにいかない）');
  ok(await sessionUser(db.query, hashToken(token)) === null,
    '**潰した物をそのまま出しても通らない**（台帳が漏れても成りすませない）');

  await logout(db.query, token);
  ok(db.sessions.length === 0, 'ログアウトで札が消える');
  ok(await sessionUser(db.query, token) === null, '**消した札はその瞬間から効かない**');
}

console.log('\n[10] 期限');
{
  const db = fakeDb();
  await register(db.query, GOOD);
  // 30日前にログインしたことにする＝札はもう切れている
  const past = new Date(Date.now() - 31 * 86400_000);
  const { token } = await login(db.query, { email: GOOD.email, password: GOOD.password }, past);
  ok(await sessionUser(db.query, token) === null, '期限の切れた札では通らない');
}

console.log('\n[11] メールの確認');
{
  const db = fakeDb();
  const r = await register(db.query, GOOD);
  const u = await verifyEmail(db.query, r.emailToken);
  ok(!!u && u.verified, 'リンクを踏むと確認済みになる');
  ok(db.emailTokens.length === 0, '使った合言葉は捨てる');
  ok(await verifyEmail(db.query, r.emailToken) === null, '**同じリンクは2回使えない**');
  ok(await verifyEmail(db.query, '知らない合言葉') === null, '知らない合言葉では何も起きない');

  const db2 = fakeDb();
  const r2 = await register(db2.query, GOOD, new Date(Date.now() - 48 * 3600_000));
  ok(await verifyEmail(db2.query, r2.emailToken) === null, '古いリンク(24時間超)は効かない');
}

/* -------------------------------------------------- SQLの書き方 */

console.log('\n[12] SQLに値を埋め込んでいない');
{
  /* 文字列を繋いでSQLを組み立てると、名前欄に `' OR 1=1 --` と打った人へ
     全員ぶんの行を返すことになる（SQLインジェクション）。
     $1 で渡した物は値としてだけ扱われ、SQLの一部として読まれない */
  const src = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  const lines = src.split('\n');
  const guilty = [];
  let inSql = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    // SQLを書いていそうなバッククォートの行
    if (/`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(l)) inSql = true;
    if (inSql && /\$\{/.test(l)) guilty.push(`${i + 1}行目`);
    if (inSql && /`\s*,?\s*$|`\);|`,$/.test(l) && !/`[^`]*\b(SELECT|INSERT)/i.test(l)) inSql = false;
  }
  ok(guilty.length === 0, `SQLの中に \${} が無い${guilty.length ? ` ← ${guilty.join('、')}` : ''}`);
  const uses = (src.match(/\$1/g) || []).length;
  ok(uses >= 5, `値は $1 で渡している（${uses}箇所）`);
}

/* ------------------------------------------------ マイグレーション */

console.log('\n[13] 台帳の作り替えの手順');
{
  ok(checkSteps().length === 0, `並びが壊れていない（${STEPS.length}手順）${checkSteps().join('、')}`);
  ok(STEPS[0].n === 1, '1から始まる');

  // 番号が飛んでいる／重なっている物は、流す前に断る
  ok(checkSteps([{ n: 1, name: 'a', sql: 'x' }, { n: 3, name: 'b', sql: 'y' }]).length > 0,
    '**番号が飛んでいたら断る**');
  ok(checkSteps([{ n: 1, name: 'a', sql: 'x' }, { n: 1, name: 'b', sql: 'y' }]).length > 0,
    '**番号が重なっていたら断る**');

  // 1回目は全部流れて、2回目は1本も流れない
  const done = new Set();
  const log = [];
  const q = async (sql, params) => {
    log.push(sql.trim().split('\n')[0].slice(0, 30));
    if (/SELECT n FROM schema_version/.test(sql)) {
      return { rows: [...done].map((n) => ({ n })) };
    }
    if (/INSERT INTO schema_version/.test(sql)) done.add(params[0]);
    return { rows: [] };
  };
  const first = await migrate(q);
  ok(first.length === STEPS.length, `1回目は全部流れる（${first.join(', ')}番）`);
  ok(log.filter((s) => s === 'BEGIN').length === STEPS.length,
    '**1手順が1つの取引になっている**（途中で落ちても半端が残らない）');
  ok(log.filter((s) => s === 'COMMIT').length === STEPS.length, '手順の数だけ確定している');

  log.length = 0;
  const second = await migrate(q);
  ok(second.length === 0, '**2回目は1本も流れない**（起動のたびに走っても何も起きない）');
  ok(log.filter((s) => s === 'BEGIN').length === 0, '2回目は取引すら始めない');

  // 壊れた並びを渡したら、1本も流さずに投げる
  let threw = false;
  try { await migrate(q, [{ n: 2, name: 'x', sql: 'y' }]); } catch { threw = true; }
  ok(threw, '並びが壊れていたら1本も流さずに止まる');
}

/* -------------------------------------------- 台帳が無い時に畳めるか */

console.log('\n[14] 台帳が無ければ、口ごと消える');
{
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/if \(!accountsOn\) \{ res\.writeHead\(404\)/.test(src),
    '**/api/ は accountsOn が立っていなければ404**（「有るけど使えない」を作らない）');
  ok(/accountsOn = true/.test(src) && src.indexOf('await db.setup()') < src.indexOf('accountsOn = true'),
    '表を作り終えて初めて口が開く（繋げなかった時に開きっぱなしにしない）');

  const dbsrc = readFileSync(new URL('../server/db.js', import.meta.url), 'utf8');
  ok(/DATABASE_URL/.test(dbsrc) && !/postgres(ql)?:\/\/[^'"\s]/.test(dbsrc),
    '**繋ぎ先が直に書かれていない**（publicなrepoなので鍵は環境変数から）');

  const mailsrc = readFileSync(new URL('../server/mail.js', import.meta.url), 'utf8');
  ok(/RESEND_API_KEY/.test(mailsrc) && !/re_[A-Za-z0-9]{10}/.test(mailsrc),
    'メールの鍵も直に書かれていない');
}

/* ------------------------------------------------ 画面の繋ぎ */

console.log('\n[15] 画面のidが揃っている');
{
  /* **これが1つ欠けると、開いた瞬間に画面が真っ黒になる。**
     account.js は作られた時に getElementById の結果へ onclick を代入するので、
     nullが1つ混じるとそこで例外が上がり、main.js の組み立てごと止まる。
     他の検査は全部通ったまま、画面だけ出ない（このrepoが一番踏んでいる形） */
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/ui/account.js', import.meta.url), 'utf8');
  const want = [...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  ok(want.length > 0, `account.js が ${want.length} 個のidを掴んでいる`);
  const missing = [...new Set(want)].filter((id) => !html.includes(`id="${id}"`));
  ok(missing.length === 0, `index.htmlに全部ある${missing.length ? ` ← ${missing.join('、')} が無い` : ''}`);

  // 名前欄はホーム(netmenu)の物を読みに行っている。あちらのidが変わると静かに壊れる
  ok(html.includes('id="nmName"'), '名前欄(nmName)がある（登録時に初期値として読む）');
  // 個人情報の扱いへの導線。メアドを預かる画面から辿れないと掲示の意味が無い
  ok(/href="\/privacy\.html"/.test(html), '会員証の画面から個人情報の扱いへ行ける');
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
