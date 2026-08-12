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
  requestReset, resetPassword,
  PASSWORD_MIN, NAME_MAX, RESET_TOKEN_MINUTES, EMAIL_TOKEN_HOURS,
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
  const resets = [];
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
    /* ---- パスワードの再設定 ---- */
    // 申し込みの時に人を探す。pass_hashを取らないので上の分岐とは別物
    if (s.startsWith('SELECT id, email, name, verified_at FROM users')) {
      const u = users.find((x) => x.email === params[0]);
      return { rows: u ? [u] : [] };
    }
    if (s.startsWith('DELETE FROM password_resets WHERE user_id')) {
      for (let i = resets.length - 1; i >= 0; i--) {
        if (resets[i].user_id === params[0]) resets.splice(i, 1);
      }
      return { rows: [] };
    }
    if (s.startsWith('INSERT INTO password_resets')) {
      resets.push({ token_hash: params[0], user_id: params[1], expires_at: params[2] });
      return { rows: [] };
    }
    if (s.startsWith('DELETE FROM password_resets WHERE token_hash')) {
      const now = Date.now();
      const at = resets.findIndex((x) => x.token_hash === params[0] && +x.expires_at > now);
      if (at < 0) return { rows: [] };
      const [t] = resets.splice(at, 1);
      return { rows: [{ user_id: t.user_id }] };
    }
    if (s.startsWith('UPDATE users SET pass_hash')) {
      const u = users.find((x) => x.id === params[0]);
      if (u) u.pass_hash = params[1];
      return { rows: u ? [u] : [] };
    }
    // **その人の札を全部捨てる。** 再設定の芯なので、偽物でもちゃんと消す
    if (s.startsWith('DELETE FROM sessions WHERE user_id')) {
      for (let i = sessions.length - 1; i >= 0; i--) {
        if (sessions[i].user_id === params[0]) sessions.splice(i, 1);
      }
      return { rows: [] };
    }
    return { rows: [] };
  };
  return { query, users, sessions, emailTokens, resets, sqls };
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
  /* **404を返さない口は名指しで数える。** 2026-08-12に順位表(/api/ranking)が
     2つ目の例外になった。正規表現で1つ目だけを見ていると、
     例外がいくつ増えても通ってしまう（例外が増えること自体は正しいが、
     「どれが例外か」がここに書いてある状態を保ちたい）*/
  const open = (src.match(/url !== '\/api\/(\w+)'/g) || []).map((m) => m.split("'")[1]);
  ok(/if \(!accountsOn && url !== '\/api\/me' && url !== '\/api\/ranking'\) \{/.test(src),
    `**書き込む口は accountsOn が立っていなければ404**（素通しは ${open.join('・')} だけ）`);
  ok(open.length === 2, `素通しの口は2つまで（今 ${open.length}つ）`);

  /* 「/api/me」だけは404にしない。
     ここを404にすると、台帳を置いていない本番で遊ぶ人全員のコンソールに
     毎回404が1件出る（実際にe2eがデプロイを止めた）。
     毎回出るエラーは、本当のエラーがそこに紛れて読めなくなる */
  ok(/if \(!accountsOn\) \{ sendJson\(res, 200, \{ ok: true, accounts: false/.test(src),
    '**/api/me は台帳が無くても200で「無い」と答える**（コンソールに404を出さない）');
  const ui = readFileSync(new URL('../src/ui/account.js', import.meta.url), 'utf8');
  ok(/r\.accounts !== false/.test(ui), '画面はその返事を読んで、行ごと出さない');
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

  /* **器を置いただけでは出ない。**
     hidden を外しても、画面いっぱいに広げる指定が無いと
     平たい箱が隅に置かれるだけで、押しても何も起きないように見える。
     実際にそうなって本番で気づいた（このrepoの「実装しただけで確かめない」の型）。

     #account.hidden も要る。共通の .hidden{display:none} はクラス指定なので、
     IDで display:flex と書いた瞬間にそちらが勝って隠れなくなる */
  for (const id of ['netmenu', 'settings', 'account']) {
    const rule = html.match(new RegExp(`#${id} \\{[^}]*\\}`));
    ok(!!rule && /position:\s*fixed/.test(rule[0]), `#${id} が画面いっぱいに出る指定を持っている`);
    ok(new RegExp(`#${id}\\.hidden \\{[^}]*display:\\s*none`).test(html),
      `#${id}.hidden で隠せる（IDの指定がクラスに勝つので、ID側にも要る）`);
  }

  // 名前欄はホーム(netmenu)の物を読みに行っている。あちらのidが変わると静かに壊れる
  ok(html.includes('id="nmName"'), '名前欄(nmName)がある（登録時に初期値として読む）');
  // 個人情報の扱いへの導線。メアドを預かる画面から辿れないと掲示の意味が無い
  ok(/href="\/privacy\.html"/.test(html), '会員証の画面から個人情報の扱いへ行ける');
}

/* ------------------------------------------ パスワードの再設定 */

console.log('\n[16] パスワードの再設定');
{
  const db = fakeDb();
  await register(db.query, GOOD);
  // 別の端末から2回入っておく（札そのものは下の[17]で見る）
  await login(db.query, { email: GOOD.email, password: GOOD.password });
  await login(db.query, { email: GOOD.email, password: GOOD.password });
  ok(db.sessions.length === 2, '2つの端末から入っている');

  const req = await requestReset(db.query, GOOD.email);
  ok(!!req && !!req.token, '合言葉が出る');
  ok(req.token !== hashToken(req.token), '**台帳へ書くのは潰した物**');
  ok(db.resets.length === 1 && db.resets[0].token_hash === hashToken(req.token),
    '潰した物だけが台帳に入っている');
  ok(!req.user.pass_hash && !req.user.email.includes('Aki'),
    '返す人の情報にパスワードが混ざっていない（メアドは小さく均されている）');

  // 期限。メール確認(24時間)より短いこと
  const life = +db.resets[0].expires_at - Date.now();
  ok(life > 0 && life <= RESET_TOKEN_MINUTES * 60_000 + 2000,
    `${RESET_TOKEN_MINUTES}分で切れる`);
  ok(RESET_TOKEN_MINUTES * 60 < EMAIL_TOKEN_HOURS * 3600,
    `**メール確認のリンクより短い**（${RESET_TOKEN_MINUTES}分 対 ${EMAIL_TOKEN_HOURS}時間）`);

  // もう一度申し込むと、古い方は消える
  const req2 = await requestReset(db.query, GOOD.email);
  ok(db.resets.length === 1, '**新しく出すと古い合言葉は消える**（受信箱に生きたリンクを残さない）');
  const old = await resetPassword(db.query, req.token, 'newpass9876');
  ok(!old.ok, '古いリンクはもう使えない');

  const r = await resetPassword(db.query, req2.token, 'newpass9876');
  ok(r.ok, '新しいリンクで変えられる');
  ok(!await login(db.query, { email: GOOD.email, password: GOOD.password }).then((x) => x.ok),
    '**古いパスワードでは入れなくなる**');
  const fresh = await login(db.query, { email: GOOD.email, password: 'newpass9876' });
  ok(fresh.ok, '新しいパスワードで入れる');

  // 使い切り。同じリンクを2回踏んでも2回目は効かない
  ok(!(await resetPassword(db.query, req2.token, 'another12345')).ok,
    '**同じリンクは1回しか使えない**');
}

console.log('\n[17] 変えたら今までのログインを全部切る');
{
  const db = fakeDb();
  await register(db.query, GOOD);
  const a = await login(db.query, { email: GOOD.email, password: GOOD.password });
  const b = await login(db.query, { email: GOOD.email, password: GOOD.password });
  const req = await requestReset(db.query, GOOD.email);
  await resetPassword(db.query, req.token, 'newpass9876');

  /* **これがこの機能の芯。** パスワードを変える理由の多くは
     「盗られたかもしれない」なので、変えたのに盗った側が
     ログインしたままなら意味が無い */
  ok(!await sessionUser(db.query, a.token), '1つ目の端末の札が効かなくなった');
  ok(!await sessionUser(db.query, b.token), '2つ目の端末の札も効かなくなった');
  ok(db.sessions.length === 0, '台帳から札が消えている（JWTだとこれができない）');
}

console.log('\n[18] 会員かどうかを漏らさない');
{
  const db = fakeDb();
  await register(db.query, GOOD);
  const none = await requestReset(db.query, 'nobody@example.com');
  ok(none === null, '居ない人にはnullを返すだけ（理由を作らない）');
  ok(db.resets.length === 0, '居ない人ぶんの合言葉は作られない');

  /* **返事を言い分けるのは受け口の仕事。**
     居ても居なくても同じ200を返しているかを、server/index.js を読んで確かめる */
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const at = idx.indexOf("url === '/api/forgot'");
  const block = idx.slice(at, idx.indexOf("url === '/api/reset'"));
  ok(at > 0, '/api/forgot の受け口がある');
  ok(/if \(r\) \{/.test(block), '居た時だけメールを出している');
  /* **人を探した後は、もうエラーを返してはいけない。**
     探す前の400（本文が読めない・連投）は誰にでも同じ条件で返るので構わない。
     手掛かりになるのは「探した結果で返事が変わる」ことだけなので、
     見るのは requestReset より後ろに絞る */
  const after = block.slice(block.indexOf('auth.requestReset'));
  ok(!/sendJson\(res, [45]/.test(after),
    '**人を探した後はエラーを返していない**（返事の違いが手掛かりになる）');
  ok((block.match(/sendJson\(res, 200, \{ ok: true \}\)/g) || []).length === 1,
    '出口が1つしかない（居ても居なくても同じ返事）');
  ok(/catch \(e\)/.test(block), 'メールが送れなくても同じ返事（失敗も手掛かりになる）');
  // 押されるたびに他人の受信箱へ飛ぶ口なので、連投を止める
  ok(/resetLimit\.allow/.test(block), '連投を止めている（嫌がらせに使わせない）');
}

console.log('\n[19] 再設定の合言葉は別の表に置く');
{
  const step = STEPS.find((s) => /password_resets/.test(s.sql));
  ok(!!step, `再設定の表がある（${step?.n}番）`);
  ok(/token_hash TEXT PRIMARY KEY/.test(step.sql), '潰した物を主キーにしている');
  ok(/ON DELETE CASCADE/.test(step.sql), '会員を消したら合言葉も消える');
  /* **メール確認の表と分けてあること。**
     混ぜて「種類」の列で分けると、種類を見る1行を忘れただけで
     「確認メールのリンクでパスワードを変えられる」が成立する */
  ok(!/email_tokens/.test(step.sql), '**メール確認の表とは別**（取り違えようがない形）');

  const authSrc = readFileSync(new URL('../server/auth.js', import.meta.url), 'utf8');
  ok(/DELETE FROM password_resets\s+WHERE token_hash = \$1 AND expires_at > now\(\)/.test(authSrc),
    '**期限の判定は台帳の中**（こちらの時計がずれても効く）');
  ok(/RETURNING user_id/.test(authSrc), '消すのと読むのが1回で済んでいる（使い切りが競らない）');
  ok(/DELETE FROM password_resets WHERE expires_at < now\(\)/.test(authSrc),
    '期限切れの掃除に入っている（放っておくと増え続ける）');
}

console.log('\n[20] 再設定の画面');
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/ui/account.js', import.meta.url), 'utf8');
  ok(/id="acForgot"/.test(html), 'ログインの面から「忘れた」へ行ける');
  // 4つの面が全部そろっているか。1つ欠けると、その面だけ文言が空になる
  for (const m of ['login', 'register', 'forgot', 'reset']) {
    ok(new RegExp(`\\b${m}: \\{`).test(js), `${m} の面がある`);
  }
  /* **合言葉をURLから消していること。**
     残すと、履歴・共有・スクショから拾える所に
     パスワードを変えられる文字列が居座る */
  ok(/q\.delete\('reset'\)/.test(js) && /history\.replaceState/.test(js),
    '**URLから合言葉を消している**（履歴やスクショに残さない）');
  ok(/this\._resetToken = t;/.test(js), '合言葉は画面ではなく手元の変数で預かる');
  ok(/登録があれば、メールを送りました/.test(js),
    '**送った後の文言でも会員かどうかを言わない**');
  const mail = readFileSync(new URL('../server/mail.js', import.meta.url), 'utf8');
  ok(/\?reset=/.test(mail), 'リンクの行き先はゲームの画面（打つ所が要るので）');
  ok(/心当たりが無い場合は/.test(mail), '身に覚えの無い人向けの1行がある');
}

console.log('\n[会員証の返し] 3つの口が同じ物を返すか');
{
  /* 2026-08-11に足した。**「blackoutfps.comで入り直したらコイン0になってた」**
     と言われた所。台帳には25040枚あったのに、画面が0枚を出していた。

     正体は「/api/me だけが残高・持ち物・装備を付けていて、
     ログインと入会の口は名前とメールしか返していなかった」こと。
     画面は返ってきた user をそのまま信じるので、
     **ログインした直後だけコイン0枚・持ち物なしに見えていた**（読み込み直すと直る）。

     独自ドメインを繋いだ日に出たのは偶然ではない。
     Cookieはホスト限定なので、新しいドメインでは全員が1回ログインし直す。
     その「ログイン直後の画面」を今まで誰も見ていなかった
     （一度ログインすれば、次からは会員証の口が答えるので）。

     **見るのは「3つの口が同じ物を返すこと」。** どれか1つだけを直すと、
     また同じ形の食い違いが別の口で起きる */
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

  // 足す処理が1箇所にまとまっていること。3箇所へ書き写すとまたずれる
  ok(/const withWallet = async \(user\)/.test(idx),
    '残高・持ち物・装備を足す処理が1箇所にまとまっている');
  /* 呼び出しが3つあること（定義は `withWallet = async` なのでここには数えない）*/
  const uses = (idx.match(/withWallet\(/g) || []).length;
  ok(uses >= 3, `3つの口が同じ処理を通っている（${uses}箇所で呼んでいる）`);

  /* 口ごとに名指しで見る。**まとめて数えるだけだと、
     同じ口で2回呼んでいても数が合ってしまう** */
  /* 入会の口は長い（メールを出して入会祝いを配ってからログインさせる）ので、
     窓を広く取る。狭いとsendJsonまで届かず、付けているのに落ちる */
  const around = (marker, span = 2600) => {
    const at = idx.indexOf(marker);
    return at < 0 ? '' : idx.slice(at, at + span);
  };
  for (const [name, marker] of [
    ['会員証(/api/me)', "url === '/api/me'"],
    ['ログイン', "url === '/api/login'"],
    ['入会', "url === '/api/register'"],
  ]) {
    const block = around(marker);
    ok(block !== '' && /withWallet\(/.test(block), `${name}の口が残高を付けて返す`);
  }

  /* 中身が3つ揃っていること。1つ落ちると、
     たとえば持ち物だけ空で返って「買ったスキンが消えた」に見える */
  const body = around('const withWallet = async (user)', 400);
  for (const [name, key] of [['残高', 'coins'], ['持ち物', 'owned'], ['装備', 'equipped']]) {
    ok(new RegExp(`user\\.${key} = await`).test(body), `${name}を付けている`);
  }
  // 誰でもない時に落ちないこと（ログインしていない人にも同じ処理を通す道がある）
  ok(/if \(!user\) return user;/.test(body), 'ログインしていない時はそのまま返す');
}

/* ------------------------------------------ 名前が出るまでの間 */

console.log('\n[名前が出るまで] 先に聞き始めているか');
{
  /* **ホームが出てから一拍おいて名前が入る、を戻さないための見張り。**

     account.js の refresh() が動き出すのは main.js の _bindMenu、つまり
     three.jsを読んで地形を組んでシェーダーを通し終わった後（読み込み画面が
     消える直前）。そこから /api/me を投げると、往復ぶんまるごとが
     「ホームは出ているのに名前欄が空」の時間になる。
     本番(東京)で70ms前後、遅い回線ならもっと。

     直し方は「早く投げる」1本で、index.htmlの頭で先に投げてある。
     読み込みの数秒の裏で往復が済むので、ホームの1枚目から名前が入る */
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/ui/account.js', import.meta.url), 'utf8');

  const head = html.slice(0, html.indexOf('<style'));
  ok(/window\.__me\s*=\s*fetch\('\/api\/me'/.test(head),
    '**index.htmlの頭で /api/me を先に投げている**（<style>より前）');
  ok(/window\.__me[\s\S]{0,220}credentials:\s*'same-origin'/.test(head),
    'Cookieを付けて投げている（付け忘れると誰でもない扱いで返る）');
  /* **投げる側に打ち切りの時計を持たせないこと。**
     ここに AbortSignal.timeout(15000) を付けていて、2026-08-12に
     本番へ出す所（e2e）で止まった。この時計は壁時計なので、
     **読み込みで本体が詰まっている間も数える。**
     答えは数msで返っているのに、受け取り手が付くのは地形を組み終わった後なので、
     起動が15秒を超える所では「もう返ってきている物」を自分から打ち切っていた。
     GPUが無い所（CIとheadless）は起動に20秒以上かかる。
     待つのをやめる判断は、本体が空いてから数える受け取り側でやる */
  const throwSection = head.slice(head.indexOf('window.__me'));
  ok(!/AbortSignal|signal:/.test(throwSection.slice(0, 300)),
    '**投げる側に打ち切りの時計が無い**（読み込み中も数えて、返っている物を捨てる）');

  /* 受け取り側には上限があること。**無いと、答えないサーバーで
     会員証の行が永久に決まらない**（押しても何も起きない行が出たままになる） */
  const early = js.slice(js.indexOf('async function earlyMe'));
  const earlyBody = early.slice(0, early.indexOf('\n}'));
  ok(/Promise\.race/.test(earlyBody) && /setTimeout/.test(earlyBody),
    '**受け取る側で待つのをやめる**（本体が空いてから数えるので、秒数がそのまま意味を持つ）');
  /* 受け取り手が付くのは数秒後なので、失敗をそのままにすると
     「拾われなかった失敗」として画面のエラーに数えられ /logs に出る */
  ok(/window\.__me[\s\S]{0,300}\.catch\(/.test(head),
    '**繋がらなかった時をここで握っている**（/logs に偽のエラーを出さない）');

  /* type="module" にすると下のimportmapより先に読み込みが始まり、
     「モジュールを読み始めた後のimportmapは受け付けない」ブラウザで
     ゲーム本体ごと動かなくなる。素のscriptであること */
  const tag = head.match(/<script[^>]*>\s*window\.__me/);
  ok(!!tag && !/type=/.test(tag[0]), '素のscriptで書いてある（importmapより前にモジュールを読ませない）');

  ok(/window\.__me/.test(js), 'account.js が先に投げた分を受け取りにいく');
  /* **1回使ったら捨てること。** ログイン・ログアウトの後にも同じ返事を
     使い回すと、変わる前の状態がそのまま画面に出る */
  ok(/window\.__me = null/.test(js), '**1回受け取ったら捨てる**（2回目からは自分で聞く）');
  // index.html側の1行を消しても、遅くなるだけで壊れない形であること
  ok(/if \(!p\) return null/.test(js) && /if \(!r\) r = await api\('\/api\/me'\)/.test(js),
    '先に投げた分が無ければ自分で聞く（index.html側を消しても壊れない）');

  /* 返事の読み方が2箇所に増えていないこと。
     404の扱いを書き写すと、必ず片方だけが古くなる */
  ok((js.match(/status === 404/g) || []).length === 1,
    '**404の扱いは1箇所だけ**（index.html側へ書き写していない）');
  ok(!/status === 404/.test(html), 'index.htmlは返事を読まない（Responseをそのまま渡す）');
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
