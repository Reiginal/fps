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
/* 差出人。**ドメインを取ったら、そのドメインのアドレスに変える。**
   検証していないドメインから出そうとすると、Resendが403で断る */
const FROM = process.env.MAIL_FROM || 'BLACKOUT <noreply@blackout-fps.example>';
/* リンクの行き先の頭。本番は https://blackout-fps.fly.dev（か独自ドメイン）。
   **ここが違うと、届いたリンクを踏んでも別の場所へ飛ぶ。**
   入っていなければ手元とみなす */
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
  const body = verifyBody(url);

  if (!isEnabled()) {
    // 手元。**リンクをそのまま出す。** これを踏めば確認が終わる
    console.log(`[mail] 鍵が無いので送らない。${to} 宛の確認リンク: ${url}`);
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
      // 返らない相手を待ち続けると、登録した人の画面が固まる
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
