// 画面の隅に描画の重さを数字で出す小窓。**URLに ?debug を付けた時だけ現れる。**
//
// なぜ要るか: 軽量化は「直したつもりで測っていない」が一番危ない。
// 遊び終わりに/logsへ残る1行(diag.perf)は後から見る用で、
// その場でA/Bを見るには、画面に今の数字が出ている必要がある
// （AOを切ったら描画命令が何回減るか、をその場で読む等）。
//
// 出すのは4つ: fps／描画命令(GPUへ「これを描いて」と頼んだ回数)／三角形／描画倍率。
// **毎フレーム書かない。** 数字を出す窓が重さを増やしたら本末転倒なので、
// 更新は毎秒4回、しかも文字が変わった時だけDOMへ触る
// （tools/check-hud.mjs の[計測窓]がそこを見張る）。

// 書き直す間隔（秒）。これより短いと数字が読めないうえDOMを触る回数が増えるだけ
const UPDATE_S = 0.25;

export class PerfMeter {
  constructor(el) {
    this.el = el;
    this._acc = 0;      // 前回書いてからの経過秒
    this._frames = 0;   // 前回書いてからの枚数。fpsはここから出す
    this._text = '';
  }

  /** 毎フレーム呼ぶ。dtは秒、calls/trisはrenderer.info.renderの値 */
  frame(dt, calls, tris, scale) {
    this._acc += dt;
    this._frames++;
    if (this._acc < UPDATE_S) return;
    const fps = Math.round(this._frames / this._acc);
    this._acc = 0;
    this._frames = 0;
    const t = `${fps}fps／描画命令${calls}／三角形${Math.round(tris / 1000)}k／倍率${scale.toFixed(2)}`;
    if (t === this._text) return;
    this._text = t;
    this.el.textContent = t;
  }
}
