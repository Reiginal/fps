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
    this._state = '';
    this._seen = new Set();

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
  }

  /**
   * 今の状態。空文字なら何も出ない。
   * 「操作が効かない理由」をここへ入れる
   */
  setState(text) {
    const t = String(text || '');
    if (t === this._state) return;
    this._state = t;
    this._render();
  }

  _render() {
    const lines = [];
    if (this._state) lines.push(this._state);
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
