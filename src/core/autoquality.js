// 実測fpsを見て、重い端末の画質を1段ずつ自動で下げる係。
//
// なぜ要るか: 画質の設定は付けたが、設定を自分で触るのは
// 「重い→設定があるはず→開いて→下げて→試す」を全部やれる人だけ。
// 友達のPCでカクついた時に、こちらが気づいて言うまで遊びにくいままでは遅い。
// 黙って1段ずつ下げて、下げたことだけ画面の隅に一言出す。
//
// 決めごと:
//   ・見るのは「遅かった5%」。平均は見ない（60が続いて時々10へ落ちる端末は
//     平均だと問題なしに見える。/logsの報告と同じ理屈）
//   ・下げるのは4秒の窓で2回続けて悪かった時だけ。1回のスパイク（読み込み・
//     GC・裏のアプリ）で下げると、良い端末までどんどん落ちる
//   ・上げ直しは臆病に。30秒続けて良く、しかも最後に下げてから60秒経ってから。
//     一度上げてすぐ落ちた段は、そのセッションではもう上げない
//     （上げ下げの往復＝画面がチカチカ切り替わるのが一番目障りなので）
//   ・遊んでいる間しか数えない。メニューの数字を混ぜると軽く見えすぎる
//
// この層は「いつ段を動かすか」だけを決める。何を下げるかはmain.js側
// （_applyRung）が持つ。DOMもthreeも知らないので、tools/check-autoquality.mjsが
// 机の上でdt列を食わせて全分岐を叩ける。

export class AutoQuality {
  constructor({
    maxRung = 5,        // 一番下の段（main.jsの段の数と揃える）
    badFps = 45,        // 遅かった5%がこれを切ったら「悪い窓」
    goodFps = 55,       // 上げ直しの条件その1（遅かった5%）
    goodMedianFps = 58, // 上げ直しの条件その2（中央値）
    windowS = 4,        // 窓の長さ（秒）
    warmupS = 5,        // 遊び始めの捨て時間。湧き直後はシェーダの温めで必ず引っかかる
    promoteAfterS = 30, // これだけ良い窓が続いたら1段上げる
    cooldownS = 60,     // 下げた直後は最低これだけ上げない
  } = {}) {
    this.enabled = true;
    this.rung = 0;          // 今の段。0が全部入り、大きいほど軽い絵
    this.maxRung = maxRung;
    this.onChange = () => {};   // (from, to, { fps, low }) 段が動いた時に呼ぶ
    this._badFps = badFps;
    this._goodFps = goodFps;
    this._goodMedianFps = goodMedianFps;
    this._windowS = windowS;
    this._warmupS = warmupS;
    this._promoteAfterS = promoteAfterS;
    this._cooldownS = cooldownS;

    this._dts = new Float64Array(600);   // 窓1つぶんのフレーム時間（輪にしない。窓ごとに使い切り）
    this._n = 0;
    this._sum = 0;
    this._warm = warmupS;
    this._t = 0;              // 遊んでいる時間の積算。クールダウンの物差し
    this._badStreak = 0;      // 悪い窓が続いた数
    this._goodFor = 0;        // 良い窓が続いた秒数
    this._lastDropAt = -1e9;
    this._promotedTo = -1;    // 最後に上げた先の段
    this._promotedAt = -1e9;
    this._minRung = 0;        // 上げ直しで戻ってよい一番上の段（失敗した段はここで塞ぐ）
  }

  /** 手動で画質を触った人には手を出さない（設定側から呼ばれる） */
  disable() { this.enabled = false; }

  enable() { this.enabled = true; }

  /**
   * fps上限に物差しを合わせる（設定「fps上限」から呼ばれる）。
   * 既定の45/55/58は上限60が前提の値で、上限30のままだと
   * 「常に45未満＝悪い窓」と誤解して、軽い端末でも最低画質まで転げ落ちる。
   * 割合は 0.75 / 0.92 / 0.97（60の時に元の45/55/58へ一致するのが検算）。
   * 数え途中の窓は捨てて仕切り直す（60の物差しで数えた分を30の判定に混ぜない）
   */
  setCap(hz) {
    const h = Math.max(10, hz | 0);
    this._badFps = Math.round(h * 0.75);
    this._goodFps = Math.round(h * 0.92);
    this._goodMedianFps = Math.round(h * 0.97);
    this._n = 0;
    this._sum = 0;
    this._badStreak = 0;
    this._goodFor = 0;
    this._warm = this._warmupS;
  }

  /** 毎フレーム呼ぶ。activeは「遊んでいる最中」（main.jsのstate==='playing'） */
  frame(dt, active) {
    if (!this.enabled) return;
    if (!active || dt <= 0) {
      // メニューや一時停止。窓を捨てて、戻ったらウォームアップから数え直す
      this._n = 0;
      this._sum = 0;
      this._warm = this._warmupS;
      return;
    }
    this._t += dt;
    if (this._warm > 0) { this._warm -= dt; return; }
    if (this._n < this._dts.length) this._dts[this._n++] = dt;
    this._sum += dt;
    if (this._sum < this._windowS) return;
    this._evalWindow();
    this._n = 0;
    this._sum = 0;
  }

  _evalWindow() {
    if (this._n < 30) return;   // 短すぎる窓は数字にならない
    const s = Array.from(this._dts.subarray(0, this._n)).sort((a, b) => a - b);
    const fpsAt = (q) => {
      const d = s[Math.min(s.length - 1, Math.floor(s.length * q))];
      return d > 0 ? 1 / d : 999;
    };
    const med = fpsAt(0.5);
    const low = fpsAt(0.95);

    if (low < this._badFps) {
      this._goodFor = 0;
      this._badStreak++;
      if (this._badStreak >= 2 && this.rung < this.maxRung) this._drop(med, low);
      return;
    }
    this._badStreak = 0;

    if (low >= this._goodFps && med >= this._goodMedianFps) {
      this._goodFor += this._sum;
      const canPromote = this.rung > this._minRung
        && this._goodFor >= this._promoteAfterS
        && this._t - this._lastDropAt >= this._cooldownS;
      if (canPromote) {
        const from = this.rung;
        this.rung--;
        this._promotedTo = this.rung;
        this._promotedAt = this._t;
        this._goodFor = 0;
        this.onChange(from, this.rung, { fps: med, low });
      }
    } else {
      // 悪くはないが良くもない。上げ直しの数え直し
      this._goodFor = 0;
    }
  }

  _drop(med, low) {
    const from = this.rung;
    this.rung++;
    this._badStreak = 0;
    this._goodFor = 0;
    this._lastDropAt = this._t;
    // 上げた直後に落ちた＝その段はこの端末には重い。セッション中はもう上げない
    if (from === this._promotedTo && this._t - this._promotedAt < this._cooldownS) {
      this._minRung = Math.max(this._minRung, this.rung);
    }
    this.onChange(from, this.rung, { fps: med, low });
  }
}
