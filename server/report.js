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
/* 受け取る種類。**perfは「重い」を感想でなく数字で見るための物。**
   「なんか重い」と言われても、こちらには何も分からなかった
   （端末も回線も人数も違うので、手元で再現しようが無い） */
export const REPORT_KINDS = ['error', 'solo', 'perf'];

/**
 * 受け取った本文を、扱える形へ直す。
 * 捨てるべき物はnullを返す（壊れたJSON・本文が無い・空っぽ）
 */
export function reportRecord(bodyText) {
  if (typeof bodyText !== 'string' || bodyText.length > REPORT_BODY_MAX) return null;
  let m = null;
  try { m = JSON.parse(bodyText); } catch { return null; }
  if (!m || typeof m.message !== 'string') return null;

  // slice(0, max)はUTF-16の単位で切るので、絵文字など2単位で1文字の所を
  // ちょうど跨ぐと、片割れのサロゲートだけが残ることがある。
  // logs.jsのclean()と同じく、文字(コードポイント)ごと足すかどうかで切る
  const one = (v, max = REPORT_MAX) => {
    let out = '';
    for (const ch of stripControl(v ?? '').trim()) {
      out += ch;
      if (out.length >= max) break;
    }
    return out;
  };
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
    /* 描けた回数。fpsは中央値、lowは遅かった5%（引っかかりの目安）。
       **平均を取らない。** 60が続いて時々10まで落ちる端末は、
       平均だと57くらいになって「問題なし」に見えるが、遊んでいる本人には
       その10の瞬間しか記憶に残らない */
    fps: num(m.fps),
    low: num(m.low),
    players: num(m.players),
    /* 何を減らせば軽くなるかの切り分け用。callsは描画命令(GPUへ頼んだ回数)、
       trisは三角形、scaleは描画倍率を%にした物（丸めで小数が消えないように%で受ける）。
       fpsだけだと「重い」は分かっても、命令が多いのか三角形が多いのかが分からない */
    calls: num(m.calls),
    tris: num(m.tris),
    scale: num(m.scale),
    // 自動画質がどこまで下げて落ち着いたか（0=全部入り、大きいほど軽い絵）。
    // fpsが良く見えても、rungが深ければ「下げたから保てている」と読める
    rung: num(m.rung),
    // fps上限の設定値（60/30）。無いと「fps30」が省エネ設定なのか不調なのか読めない
    cap: num(m.cap),
    /* 1分ごとのfps中央値と遅かった5%の列（例: "60,58,52"）。
       上のfps/lowは最後の33秒だけなので、「だんだん重くなる」はこの列で見る。
       数字とカンマ以外が混ざった物は丸ごと捨てる（文字列で受ける唯一の数字列なので、
       ここから変な物がログ画面に流れ込まないよう形で縛る）。
       上限200字＝60fpsでも1時間ぶんの束(60個×最大4字)が収まる長さ */
    fpsMins: typeof m.fpsMins === 'string' && /^\d+(,\d+)*$/.test(m.fpsMins)
      ? one(m.fpsMins, 200) : null,
    lowMins: typeof m.lowMins === 'string' && /^\d+(,\d+)*$/.test(m.lowMins)
      ? one(m.lowMins, 200) : null,
  };
}

/* 流れて消える方（flyctl logs）へ出す1行。人が目で追うためだけの形。
 *
 * **数字もここへ出す。** 前は名前とメッセージとブラウザ名だけを組み立てていて、
 * fpsも描画命令も1分ごとの列も全部落としていた。そのせいで
 * `flyctl logs` には「[描画の重さ] れい: 描画の重さ」としか出ず、
 * **肝心の数字を見るには毎回/logsを鍵付きで開くしかなかった**（2026-08-08）。
 * 鍵は手元に無いので、こちらから重さを追えない状態だった。
 * 中身のある項目だけを並べるので、エラーの行は今まで通り短いまま */
export function reportLine(bodyText) {
  const r = reportRecord(bodyText);
  if (!r) return null;
  const tag = { solo: '[1人で遊んだ]', perf: '[描画の重さ]' }[r.kind] || '[画面のエラー]';
  // 並べる順番は「まず結論(fps)、次に切り分け(何が多いか)、最後に設定」。
  // 1分ごとの列は長いので末尾に置く
  const num = ['fps', 'low', 'calls', 'tris', 'scale', 'rung', 'cap', 'wave', 'kills', 'score']
    .filter((k) => r[k] !== null && r[k] !== undefined)
    .map((k) => `${k}=${r[k]}`);
  for (const k of ['fpsMins', 'lowMins']) if (r[k]) num.push(`${k}=${r[k]}`);
  return `${tag} ${r.name}: ${r.message}`
    + (num.length ? ` ${num.join(' ')}` : '')
    + (r.where ? ` @ ${r.where}` : '')
    + (r.ua ? ` [${r.ua}]` : '');
}
