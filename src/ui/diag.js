// 何かがおかしい時だけ、その手掛かりを画面に出す。
//
// なぜ要るか: Windowsの人に遊んでもらったら「Fが効かない」「武器が変えられない」
// 「リロードするとホーム画面に飛ぶ」と言われたが、こちらには何の情報も無く、
// 何回試してもらっても推測しか増えなかった。
// 本人の画面に状態が出ていれば、次の1回で原因が分かる。
//
// 出すのは2種類:
//   1. 処理の途中で例外が出た（普段は誰にも見えないまま画面が固まる）
//   2. 操作が効かない状態にいる（倒れている間・打っている間など）
//
// 開発者向けの文字列ではなく、遊ぶ側が読める言葉で書く。
// 読めない文字列を出しても「なんか赤いのが出た」で終わって、こちらへ何も返ってこない。
const $ = (id) => document.getElementById(id);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

// 例外を出しっぱなしにしない。同じ物が毎フレーム出ると画面が埋まる
const MAX_ERRORS = 3;

export class Diag {
  constructor() {
    this.el = $('diag');
    this._errors = [];
    // 状態は名前を付けて複数持つ。1つの文字列にすると、
    // 別々の場所から毎フレーム書き合って点滅する
    this._states = new Map();
    this._seen = new Set();
    // 送る時に名前も載せる。「誰の画面で起きたか」が分からないと、
    // 遊んでいた人に聞き直す所からやり直しになる。統合側が入れる
    this.name = '';

    // 拾い損ねた例外を捕まえる。ここが無いと、遊ぶ側には
    // 「急に操作が効かなくなった」としか見えない
    addEventListener('error', (e) => {
      this.error(e?.message || '不明なエラー', e?.filename, e?.lineno);
    });
    addEventListener('unhandledrejection', (e) => {
      this.error(e?.reason?.message || String(e?.reason ?? '不明な失敗'));
    });
  }

  /** 例外を1つ足す。同じ物は1回しか出さない */
  error(message, file = '', line = 0) {
    const where = file ? `${String(file).split('/').pop()}${line ? `:${line}` : ''}` : '';
    const key = `${message}|${where}`;
    if (this._seen.has(key)) return;
    this._seen.add(key);
    this._errors.push(where ? `${message}（${where}）` : String(message));
    while (this._errors.length > MAX_ERRORS) this._errors.shift();
    this._render();
    this._report(message, where);
  }

  /**
   * エラー以外の出来事を送る。
   *
   * なぜ要るか: **1人プレイはサーバーに一度も繋がらない。**
   * 敵も地形も得点も全部このブラウザの中で動いていて、通信が発生しないので、
   * どれだけ遊んでもサーバー側には何も残らない。
   * 遊んだ後でログを見て「1件も無い、壊れている？」となった（実際になった）。
   *
   * 送り先を増やさず /report を通すのは、あの口に既に
   * 連投の見張りと長さの上限が付いているため。口を増やすと同じ守りを2度書くことになる
   */
  event(message, fields = {}) {
    this._send({ kind: 'solo', message, ...fields });
  }

  /**
   * 描画の重さを送る。**遊び終わりに1回だけ。**
   *
   * なぜ要るか: 「なんか重い」と言われても、こちらには何も分からない。
   * 端末も回線も人数も違うので、手元で再現しようが無い。
   * 遊んだ後の数字が1行残るだけで、「どの端末で・何人の時に落ちるか」に辿り着ける。
   *
   * **毎フレーム送らない。** 送ったら、その通信でさらに重くなる
   */
  perf(fields = {}) {
    this._send({ kind: 'perf', message: '描画の重さ', ...fields });
  }

  /**
   * メモリの警告を送る。**遊び終わりを待たず、その場で送る。**
   *
   * なぜ要るか: 2026-08-08、1人プレイの第3波でタブごと落ちた。
   * 例外なら記録が残るのに、メモリが足りなくなった時だけ何も残らない。
   * **落ちてからでは送れない**ので、限界に近づいた時点で送る必要がある。
   *
   * perfと種類を分けてあるのは、連投止めの鍵が「送り元＋種類」だから。
   * 同じ種類にすると、遊び終わりのperfと同時に出た警告が429で捨てられる
   * （力尽きた瞬間にperfとsoloが潰し合っていたのと同じ事故になる）
   */
  memory(message, fields = {}) {
    this._send({ kind: 'mem', message, ...fields });
  }

  /* サーバーへ送る。画面に出すだけでは、遠くで遊んでいる人の不具合が
     こちらへ届かない（本人が読み上げてくれない限り分からない）。
     送れなくても遊べる物なので、失敗は黙って捨てる。
     同じ物は_seenで既に1回に絞ってあるので、ここでは数を数えない */
  _report(message, where) {
    this._send({ kind: 'error', message: String(message).slice(0, 400), where });
  }

  /* 実際に投げる所。**送り終わるのを待たない。**
     待つと、60分の1秒ごとに描き直している最中に止まってカクつく */
  _send(payload) {
    try {
      fetch('/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: this.name || '',
          // どの環境か。Windowsだけで出る不具合を追うのに要る
          ua: navigator.userAgent || '',
          ...payload,
        }),
      }).catch(() => {});
    } catch { /* 送れないだけ */ }
  }

  /**
   * 今の状態。空文字を渡すとその行が消える。
   * 「操作が効かない理由」をここへ入れる。
   * keyは出す場所ごとの名前で、別々の場所が互いを消さないために要る
   */
  setState(key, text) {
    const t = String(text || '');
    if ((this._states.get(key) || '') === t) return;
    if (t) this._states.set(key, t);
    else this._states.delete(key);
    this._render();
  }

  _render() {
    const lines = [];
    for (const s of this._states.values()) lines.push(s);
    for (const e of this._errors) lines.push(`エラー: ${e}`);
    if (!lines.length) {
      this.el.classList.add('hidden');
      this.el.innerHTML = '';
      return;
    }
    this.el.classList.remove('hidden');
    this.el.innerHTML = lines.map((l) => esc(l)).join('<br>');
  }
}
