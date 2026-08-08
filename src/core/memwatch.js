// 使っているメモリを見張って、**落ちる前に**1行送る。
//
// なぜ要るか: 2026-08-08、1人プレイの第3波でChromeにタブごと殺された。
// 調べても原因が出なかったのは、**このゲームがメモリを1バイトも測っていなかった**から。
// 届いていた記録は「fpsは32で5分間ずっと平ら」だけで、
// 何が足りなくなったのかを示す数字がどこにも無かった。
// 例外なら記録が残る仕組みは既にあるのに、メモリだけ何も無い状態だった。
//
// 厄介なのは**落ちた瞬間には何も送れない**こと。
// 重さの報告(perf)は遊び終わりに1回送る形なので、タブごと死ぬ事故とは相性が最悪で、
// そのままだと次に同じ事が起きてもまた同じ所で行き止まりになる。
// だから、限界に近づいた時点で送る。落ちるより前なら、まだ数字が残せる。
//
// 【見るのは2つ。片方だけでは足りない】
//
//  1. JSの山(performance.memory)  … 配列・オブジェクトが溜まる形
//  2. 描く物の数(ジオメトリ+テクスチャ) … WebGLの物が溜まる形
//
// **2つ目が要るのは、WebGLの物はJSの山に載らないため。** メッシュを作っては捨て忘れても
// usedJSHeapSizeはほとんど動かず、増えているのはGPU側とブラウザの内部だけになる。
// 山の割合だけ見張っていると、この形の漏れは最後まで気づけない。
//
// 【段を分けてある理由】
// 1回きりの通知だと「近づいて戻った」のか「そのまま突き抜けた」のかが読めない。
// 60%→80%→92%と3行残れば、落ちる直前の伸び方がそのまま形で見える。
//
// 【1分ごとの列も出す】
// 閾値は当たり外れがあるが、列は嘘をつかない。プールで回している物は必ず頭打ちになり、
// 漏れている物は上がり続ける。**この差は閾値を決めなくても列を見れば分かる**
// （fpsで同じ事をしたのが perfsegments.js）。
//
// ここはDOMもThreeJSも触らない純粋なクラスにしてある。
// ブラウザ無しの検査（tools/check-memwatch.mjs）でそのまま食わせるため。

const MB = (b) => Math.round(b / 1048576);

/* 描く物が「底からいくつ増えたら知らせるか」。
   **実測から決めてある。** 1人プレイで正当に増えるのは、
   敵1体につきジオメトリ45個 × プールの上限18体 = 810個。
   そこへ武器と効果のぶんを足しても1200個前後で頭打ちになる。
   1500はその上。発砲や撃破のたびに作って捨て忘れる形なら、
   毎秒70発の撃ち合いで1分と待たずにここを抜ける */
const GROW_STEPS = [1500, 4000, 12000];

// JSの山を、限界の何割で知らせるか
const HEAP_STEPS = [0.6, 0.8, 0.92];

export class MemoryWatch {
  constructor({
    steps = HEAP_STEPS, grow = GROW_STEPS, bucketS = 60, maxBuckets = 60,
  } = {}) {
    this.steps = steps;
    this.grow = grow;
    this.bucketS = bucketS;
    // 60束=1時間ぶん。送る文字列が伸び続けないための頭打ち（perfsegments.jsと同じ）
    this.maxBuckets = maxBuckets;
    this.reset();
  }

  reset() {
    this.last = 0;        // 最後に見た使用量（バイト）
    this.peak = 0;        // この回の最大
    this.limit = 0;       // ブラウザが言う限界
    this.objects = 0;     // 今の「描く物」の数
    this.base = 0;        // 遊び始めの数。増え方はここからの差で見る
    this._stepAt = 0;     // 次に知らせる段（ここより下は済んだ）
    this._growAt = 0;
    this._acc = 0;        // 今の束に溜まった秒数
    this._memMax = 0;     // 今の束の最大（使用量）
    this._objMax = 0;     // 今の束の最大（描く物）
    this._mem = [];       // 閉じた束（MB）
    this._obj = [];       // 閉じた束（個数）
  }

  /**
   * 1秒に1回ほど呼ぶ。**毎フレーム呼ばない**（1秒の中では動かない数字なので、
   * 頻度を上げても分かる事は増えず、読み出しのぶんだけ重くなる）。
   *
   * @param used    使用量(バイト)。performance.memoryが無い環境では0を渡す
   * @param limit   限界(バイト)。同上
   * @param objects 描く物の数（ジオメトリ + テクスチャ）
   * @param dt      前に呼んでからの秒数（1分の束を閉じるのに使う）
   * @returns 知らせる事があればその中身、無ければnull
   */
  sample(used, limit, objects, dt = 0) {
    /* performance.memory はChromeにしか無い。無い環境では0が来る。
       **その時は山の話だけ黙る。** 描く物の数はThreeJSが持っているので、
       Safariでも Firefoxでもそちらは見張れる */
    const heapOk = Number.isFinite(used) && used > 0
      && Number.isFinite(limit) && limit > 0;
    if (heapOk) {
      this.last = used;
      this.limit = limit;
      if (used > this.peak) this.peak = used;
      if (used > this._memMax) this._memMax = used;
    }
    if (Number.isFinite(objects) && objects > 0) {
      this.objects = objects;
      // 底は最初に見えた数。ここを遊び始めに取り直すのは呼ぶ側の仕事(reset)
      if (this.base === 0) this.base = objects;
      if (objects > this._objMax) this._objMax = objects;
    }

    this._acc += dt > 0 ? dt : 0;
    if (this._acc >= this.bucketS) this._close();

    /* 段は上から見る。一気に飛んだ時に3行出しても読む側の手掛かりは増えないので、
       一番上の段だけを1行出して、下の段は済んだ事にする */
    if (heapOk) {
      for (let i = this.steps.length - 1; i >= this._stepAt; i--) {
        if (used / limit < this.steps[i]) continue;
        this._stepAt = i + 1;
        return this._warn('heap');
      }
    }
    if (this.base > 0) {
      for (let i = this.grow.length - 1; i >= this._growAt; i--) {
        if (this.objects - this.base < this.grow[i]) continue;
        this._growAt = i + 1;
        return this._warn('objects');
      }
    }
    return null;
  }

  _warn(reason) {
    return {
      reason,                                    // 'heap' か 'objects'
      used: MB(this.last),
      peak: MB(this.peak),
      limit: MB(this.limit),
      // 割合は限界が読めた時だけ。読めない環境で0%と出すと「余裕がある」に見える
      pct: this.limit > 0 ? Math.round((this.last / this.limit) * 100) : null,
      objects: this.objects,
      base: this.base,
    };
  }

  /* 束を閉じて、その1分の最大を2つ積む。
     **中央値ではなく最大を取る。** 漏れているかどうかを見る列なので、
     一番増えた所が残らないと意味がない（fpsの列とは目的が逆） */
  _close() {
    this._mem.push(MB(this._memMax));
    this._obj.push(this._objMax);
    if (this._mem.length > this.maxBuckets) { this._mem.shift(); this._obj.shift(); }
    this._acc = 0;
    // 次の束は「今の値」から始める。0へ戻すと、束の頭に必ず谷ができて
    // 増え続けている形が階段に見える
    this._memMax = this.last;
    this._objMax = this.objects;
  }

  get lastMB() { return MB(this.last); }

  get peakMB() { return MB(this.peak); }

  get limitMB() { return MB(this.limit); }

  /**
   * 送る用の文字列2本にする。例: { memMins: '312,340,371', objMins: '640,690,700' }
   * 閉じかけの束も15秒以上あれば末尾に足す（perfsegments.jsと同じ扱い）。
   * まだ何も無ければ空文字
   */
  series() {
    const mem = this._mem.slice();
    const obj = this._obj.slice();
    if (this._acc >= 15) {
      mem.push(MB(this._memMax));
      obj.push(this._objMax);
    }
    // 数字が1つも無い環境（performance.memoryが無い）では空文字のまま返す。
    // 0が並ぶ列を送ると「メモリを使っていない」と読めてしまう
    return {
      memMins: mem.some((v) => v > 0) ? mem.slice(-this.maxBuckets).join(',') : '',
      objMins: obj.some((v) => v > 0) ? obj.slice(-this.maxBuckets).join(',') : '',
    };
  }
}
