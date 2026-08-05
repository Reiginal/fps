// 遊ぶ人の画面で起きた例外を受け取る時の、判定だけを持つ。
//
// なぜ独立したファイルにしてあるか: server/index.js は読み込むと
// その場でサーバーが起動するので、判定だけを試すことができない。
// serve-rules.js を分けたのと同じ理由で、ここも分けてある
// （tools/check-report.mjs がここを叩いている）。
//
// この口は、このサーバーで唯一の「外から書き込める場所」になる。
// 読む口と違って、送られた物がそのままログに流れるので、
// 長さ・制御文字・連投の3つは必ずここで止める。

// 1件の長さ。長い積み重ね（stack）をそのまま受けると、ログが1件で埋まる
export const REPORT_MAX = 400;
// 送りつけられる本文の上限。中身を読む前に、入口で切る
export const REPORT_BODY_MAX = 4 * 1024;
// 同じ相手から続けて受ける最短の間隔。毎フレーム例外が出る不具合だと、
// 放っておけば秒間60件が延々と流れてログが読めなくなる
export const REPORT_GAP_MS = 3000;
// 連投を見張るために覚えておく送り元の数。
// 同時に遊べるのは数人なので、これだけあれば足りる
export const MAX_SENDERS = 200;

/**
 * 制御文字を空白へ置き換える。
 * 改行をそのまま通すと、1件の報告がログの複数行に化けて、
 * 他の行に紛れ込ませることができてしまう
 */
export function stripControl(s) {
  let out = '';
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    out += (c < 0x20 || c === 0x7f) ? ' ' : ch;
  }
  return out;
}

/**
 * 連投の見張り。
 * 時刻を引数で渡す形にしてあるのは、検査から時間を進められるようにするため。
 * Date.now()を中で呼ぶと、3秒待たないと試せない検査になる
 */
export class ReportLimiter {
  constructor(gapMs = REPORT_GAP_MS) {
    this.gapMs = gapMs;
    this.seen = new Map();   // 送り元 -> 最後に受けた時刻
  }

  /** 受けてよければtrue。trueを返した時だけ時刻を覚える */
  allow(from, now) {
    if (now - (this.seen.get(from) || 0) < this.gapMs) return false;
    // 入れ直して一番新しい位置へ動かす。Mapは入れた順を覚えているので、
    // 先頭から捨てれば「一番長く来ていない相手」から消える
    this.seen.delete(from);
    this.seen.set(from, now);

    /* 溜まり続けないよう上限で切る。
       最初は「60秒以上前の物を落とす」と書いていたが、
       **短い間に大量の送り元から来ると1件も落ちない。**
       実際、500件を続けて入れたら500件とも残った（検査が見つけた）。
       時間ではなく数で切れば、どんな来方をしても伸びない */
    while (this.seen.size > MAX_SENDERS) {
      const oldest = this.seen.keys().next().value;
      this.seen.delete(oldest);
    }
    return true;
  }
}

/* 遊ぶ側から受け取ってよい出来事の種類。
 *
 * **ここに無い名前は全部 error 扱いにする。** 種類を自由に付けられると、
 * 外から 'boot'（サーバー起動）のような偽の行を混ぜられて、
 * ログを読む側が「いつ再起動したか」を読み違える。
 *
 * solo は1人プレイ。1人プレイはサーバーに一切繋がらないので、
 * ここを通さないと**遊んだ事実がどこにも残らない**。
 * 実際に遊んだ後でログを見て「1件も無い、壊れている？」となった */
export const REPORT_KINDS = ['error', 'solo'];

/**
 * 受け取った本文を、扱える形へ直す。
 * 捨てるべき物はnullを返す（壊れたJSON・本文が無い・空っぽ）
 */
export function reportRecord(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length > REPORT_BODY_MAX) return null;
  let m = null;
  try { m = JSON.parse(bodyText); } catch { return null; }
  if (!m || typeof m.message !== 'string') return null;

  const one = (v, max = REPORT_MAX) => stripControl(v ?? '').trim().slice(0, max);
  const message = one(m.message);
  if (!message) return null;

  // 数字は数字として持つ。文字にすると、後で「3波より上だけ数える」ができない。
  // 有限の数以外（NaN・Infinity・文字列）は入れない
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);

  return {
    kind: REPORT_KINDS.includes(m.kind) ? m.kind : 'error',
    name: one(m.name || '名無し', 24) || '名無し',
    message,
    where: one(m.where, 120),
    ua: one(m.ua, 120),
    wave: num(m.wave),
    kills: num(m.kills),
    score: num(m.score),
  };
}

/** 流れて消える方（flyctl logs）へ出す1行。人が目で追うためだけの形 */
export function reportLine(bodyText) {
  const r = reportRecord(bodyText);
  if (!r) return null;
  const tag = r.kind === 'solo' ? '[1人で遊んだ]' : '[画面のエラー]';
  return `${tag} ${r.name}: ${r.message}`
    + (r.where ? ` @ ${r.where}` : '')
    + (r.ua ? ` [${r.ua}]` : '');
}
