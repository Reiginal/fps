// 遊んだ時間を1分ごとの束に切って、束ごとのfps中央値と「遅かった5%」を並べる。
//
// なぜ要るか: /logsへ送る重さの数字は「最後の33秒」の中央値1つだけだった
// （fpsのリングが2000枠=60fpsで約33秒ぶんしか持てないため）。
// それだと「10分遊んだらPCが熱くなってきた」と言われた時に、
// **最初から重かったのか、だんだん重くなったのかが区別できない。**
// 1分ごとの列（例: 60,60,58,52,49）が1行あれば、垂れていく形がそのまま見える。
//
// 全フレームのdtを持ち続けると10分で36,000個になるので、
// 束が閉じるたびに中央値と5%の2つの整数へ潰して、生のdtは捨てる。
// 束の計測は遊んでいる時間だけ進める（メニューや一時停止で止まる。
// 壁時計で切ると、一時停止を挟んだ分だけ「良く見える束」が混ざる）。
//
// ここはDOMもThreeJSも触らない純粋なクラスにしてある。
// ブラウザ無しの検査（tools/check-perf-report.mjs）でそのまま食わせるため。

// 1束に入るdtの上限。fpsの上限が60なので、60秒×60fps=3600が理論上の最大。
// 余裕を見て4096。万一これを超えたら（上限を上げた未来）、束を早めに閉じるだけで
// 落ちはしない
const BUCKET_CAP = 4096;

export class PerfSegments {
  constructor(bucketS = 60, maxBuckets = 60) {
    this.bucketS = bucketS;
    // 60束=1時間ぶん。それより長い回は古い束から捨てる
    // （送る文字列が伸び続けないための頭打ち。1時間遊ぶ回はまず無い）
    this.maxBuckets = maxBuckets;
    this._buf = new Float64Array(BUCKET_CAP);
    this.reset();
  }

  reset() {
    this._n = 0;      // 今の束に溜まったdtの数
    this._acc = 0;    // 今の束に溜まった遊び時間（秒）
    this._fps = [];   // 閉じた束の中央値fps
    this._low = [];   // 閉じた束の「遅かった5%」fps
  }

  /** 毎フレーム呼ぶ。activeが偽の間は何も溜めない（束の時計も進まない） */
  frame(dt, active) {
    if (!active || !(dt > 0)) return;
    this._buf[this._n++] = dt;
    this._acc += dt;
    if (this._acc >= this.bucketS || this._n >= BUCKET_CAP) this._close();
  }

  /* 束を閉じて2つの整数に潰す。sortは1分に1回だけなので重さは気にしなくてよい */
  _close() {
    const s = Array.from(this._buf.subarray(0, this._n)).sort((a, b) => a - b);
    const fps = (dt) => (dt > 0 ? Math.round(1 / dt) : 0);
    this._fps.push(fps(s[s.length >> 1]));
    // 並びの後ろから5%＝引っかかりの目安。平均を取らないのは/logs側と同じ理由
    // （60が続いて時々10に落ちる端末は、平均だと問題なしに見える）
    this._low.push(fps(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]));
    if (this._fps.length > this.maxBuckets) { this._fps.shift(); this._low.shift(); }
    this._n = 0;
    this._acc = 0;
  }

  /**
   * 送る用の文字列2本にする。例: { fpsMins: '60,58,52', lowMins: '55,44,38' }
   * 閉じかけの束も15秒以上あれば末尾に足す（死んだのが1分30秒なら、
   * 最後の30秒を捨てずに3束目として出す）。まだ何も無ければ空文字
   */
  series() {
    const fps = this._fps.slice();
    const low = this._low.slice();
    if (this._acc >= 15) {
      const s = Array.from(this._buf.subarray(0, this._n)).sort((a, b) => a - b);
      const f = (dt) => (dt > 0 ? Math.round(1 / dt) : 0);
      fps.push(f(s[s.length >> 1]));
      low.push(f(s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]));
    }
    // 閉じかけの束を足した結果が上限を超えたら、古い方から捨てる。
    // 「今どうなっているか」を知りたい列なので、残すのは新しい側
    return {
      fpsMins: fps.slice(-this.maxBuckets).join(','),
      lowMins: low.slice(-this.maxBuckets).join(','),
    };
  }
}
