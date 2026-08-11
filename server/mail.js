// 手紙を出す口。今はメールの確認だけに使う。
//
// **鍵(RESEND_API_KEY)が入っていなければ、送らずにリンクをコンソールへ出す。**
// これは手抜きではなく狙いで、手元で開発している間にメールの到着を待つのは
// 割に合わない（1回試すたびに受信箱を見に行くことになる）。
// 本番では鍵が入っているので実際に飛ぶ。
//
// 送り先はResend。SDK（npm の resend）は入れていない。
// やることが「JSONを1回POSTする」だけなので、依存を1つ増やす価値が無い。
// Node 22 の fetch がそのまま使える。
//
// **なぜ独自ドメインが要るか:** Resendの無料枠は3000通/月・100通/日で十分だが、
// 自分のドメインを1つ検証しないと、自分以外の宛先へ送れない。
// ドメインを取ると、そのDNSへレコードを足して「このドメインの手紙は
// Resendが出してよい」を宣言する形になる（SPF/DKIM）。
// これが無いと、届いても迷惑メール扱いになる。

const KEY = process.env.RESEND_API_KEY || '';
/* 差出人。本番は noreply@blackoutfps.com（Flyの秘密に入れてある）。
   検証していないドメインから出そうとすると、Resendが403で断る */
const FROM = process.env.MAIL_FROM || 'BLACKOUT <noreply@blackout-fps.example>';
/* リンクの行き先の頭。本番は https://blackoutfps.com。
   **ここが違うと、届いたリンクを踏んでも別の場所へ飛ぶ。**
   入っていなければ手元とみなす。

   **差出人のドメインとリンクのドメインは揃えること。**
   noreply@blackoutfps.com から出た手紙の中のリンクが別の場所を指していると、
   受け取る側から見ると偽の手紙と同じ形になり、迷惑メール扱いされやすくなる
   （2026-08-11にドメインを取るまでは、差出人が.comでリンクがfly.devだった） */
export const appOrigin = () => process.env.APP_ORIGIN || 'http://localhost:8080';

/** 実際に飛ぶ状態か。falseならコンソールへ出すだけ */
export const isEnabled = () => KEY !== '';

/** メール確認のリンク */
export const verifyUrl = (token) => `${appOrigin()}/api/verify?t=${encodeURIComponent(token)}`;

/* 確認メールの中身。**HTMLと素の文の両方を送る。**
   HTMLを切ってある受信箱だと、片方だけでは真っ白な手紙が届く */
function verifyBody(url) {
  return {
    subject: 'BLACKOUT — メールアドレスの確認',
    text: `BLACKOUTへの登録ありがとうございます。

下のリンクを開くと、メールアドレスの確認が終わります。

${url}

このリンクは24時間で切れます。
心当たりが無い場合は、そのまま捨ててください。`,
    html: `<p>BLACKOUTへの登録ありがとうございます。</p>
<p>下のリンクを開くと、メールアドレスの確認が終わります。</p>
<p><a href="${url}">${url}</a></p>
<p>このリンクは24時間で切れます。<br>心当たりが無い場合は、そのまま捨ててください。</p>`,
  };
}

/* 再設定のリンク。**行き先はゲームの画面。**
   確認メールのリンクが /api/verify（サーバーが処理して戻すだけ）なのと違って、
   こちらは**新しいパスワードを打ってもらう画面が要る**ので、
   合言葉を付けたままゲームの画面へ送る。受け取るのは src/ui/account.js */
export const resetUrl = (token) => `${appOrigin()}/?reset=${encodeURIComponent(token)}`;

/* 再設定メールの中身。
   **「心当たりが無ければ捨ててください」を必ず書く。**
   このメールは他人のメールアドレスを打てば誰にでも送れるので、
   身に覚えの無い人に届くことがある。その人が慌てないようにするのと、
   「踏まなければ何も起きない」を伝えるため */
function resetBody(url) {
  return {
    subject: 'BLACKOUT — パスワードの再設定',
    text: `パスワードの再設定が申し込まれました。

下のリンクを開くと、新しいパスワードを決められます。

${url}

このリンクは1時間で切れます。1回しか使えません。
心当たりが無い場合は、そのまま捨ててください。何も変わりません。`,
    html: `<p>パスワードの再設定が申し込まれました。</p>
<p>下のリンクを開くと、新しいパスワードを決められます。</p>
<p><a href="${url}">${url}</a></p>
<p>このリンクは1時間で切れます。1回しか使えません。<br>
心当たりが無い場合は、そのまま捨ててください。何も変わりません。</p>`,
  };
}

/**
 * 確認メールを送る。
 *
 * **失敗しても投げない。** 送れなかっただけで登録そのものを失敗にすると、
 * 台帳には会員が居るのに「登録できませんでした」と出て、
 * もう一度登録しようとしても「登録済みです」で詰む。
 * 確認前でも遊べる作りなので、届かなくても致命傷にならない。
 *
 * @returns 送れたか（コンソールへ出しただけの時もtrue）
 */
export async function sendVerifyMail(to, token) {
  const url = verifyUrl(token);
  // 手元では**リンクをそのまま出す。** これを踏めば確認が終わる
  return send(to, verifyBody(url), `確認リンク: ${url}`);
}

/**
 * パスワード再設定のメールを送る。
 *
 * **失敗しても投げない。** 呼ぶ側（server/index.js）は、
 * 送れても送れなくても、居ても居なくても**同じ返事**を返す。
 * 「送れませんでした」と言い分けるだけで、
 * そのメールアドレスが登録されているかが外から分かってしまう。
 *
 * @returns 送れたか（コンソールへ出しただけの時もtrue）
 */
export async function sendResetMail(to, token) {
  const url = resetUrl(token);
  return send(to, resetBody(url), `再設定リンク: ${url}`);
}

/**
 * 実際に投げる所。**2通で同じなのでここ1箇所。**
 * 分けて書いていた頃は、片方だけ時間切れの秒数が違う、が起きうる形だった。
 *
 * @param hint 鍵が無い時にコンソールへ出す1行（手元ではこれを踏む）
 */
async function send(to, body, hint) {
  if (!isEnabled()) {
    console.log(`[mail] 鍵が無いので送らない。${to} 宛の${hint}`);
    return true;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ from: FROM, to: [to], ...body }),
      // 返らない相手を待ち続けると、押した人の画面が固まる
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.warn(`[mail] 送れなかった (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[mail] 送れなかった:', e.message);
    return false;
  }
}
