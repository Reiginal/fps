// 描く速さの上限。requestAnimationFrameの呼び出しのうち、升目に乗る回だけ通す。
//
// なぜ要るか: rAFは画面のリフレッシュレートで呼ばれるので、
// 120Hzの画面では何もしないと全部の仕事が毎秒120回走る＝60Hzのちょうど2倍の熱。
// このゲームは物理が60Hz固定・対戦の受信が毎秒20回なので、
// 60より速く描いても買える手触りがほとんど無い。
//
// 30は「省エネ」用。1フレームの仕事量が同じでも回数が半分になるので、
// 熱への効きは画質のどの項目より大きい。そのかわり狙いの滑らかさは目に見えて落ちる。
// どちらを取るかは遊ぶ人が設定で選ぶ（既定は60）。
//
// 判定だけの純粋なクラスにしてある。main.jsに直書きだった頃は
// ブラウザ無しで一度も確かめられなかった（tools/check-framecap.mjsが叩く）。
//
// 通さない回は時刻を進めない（dtの計算はmain.js側の_lastTimeが持つ）ので、
// 次に通る回のdtには飛ばした時間がそのまま入り、動きの速さは変わらない。

export class FrameGate {
  constructor(hz = 60) {
    this.hz = hz;
    this._ms = 1000 / hz;
    this._next = 0;
  }

  /** 上限を変える。升目は今から引き直す */
  setCap(hz) {
    this.hz = Math.max(1, hz | 0);
    this._ms = 1000 / this.hz;
    this._next = 0;
  }

  /** この呼び出しで描くべきならtrue。nowMsはperformance.now() */
  shouldDraw(nowMs) {
    if (nowMs < this._next) return false;
    this._next += this._ms;
    // タブ復帰などで升目に大きく置いていかれたら、引き直す。
    // 引き直さないと、置いていかれた分を「連続で描いてよい」と誤解して
    // しばらく上限なしで走る。
    // 引き直す先は「今」ではなく「今+1升」。今に置くと、この回で描いたのに
    // 次の呼び出しがすぐまた通って、引き直しのたびに1回余計に描く
    // （main.jsに直書きだった頃からそうなっていた。升目を数える検査で見えた）
    if (nowMs - this._next > this._ms * 3) this._next = nowMs + this._ms;
    return true;
  }
}
