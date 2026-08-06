// 戦績と実績の画面。中身は src/core/stats.js の表が持っていて、ここは並べるだけ
// （設定の画面と同じ作り。表に足したら画面にも必ず出る）。
//
// 見せ方で1つだけ決めていること: **解除できていない実績も名前を出す。**
// 隠すと「何をすれば増えるのか」が分からず、実績が「気づいたら増えていた物」になる。
// あと3人で解除、が見えている方が、もう1試合やる理由になる。
import { TALLIES, ACHIEVEMENTS, progressOf, loadStats, resetStats, accuracyOf } from '../core/stats.js';

const $ = (id) => document.getElementById(id);

/** 数字を読みやすく。10000 → 10,000 */
const num = (v) => (v | 0).toLocaleString('en-US');

export class StatsMenu {
  constructor() {
    this.el = {
      root: $('stats'),
      tallies: $('sxTallies'),
      list: $('sxList'),
      close: $('sxClose'),
      reset: $('sxReset'),
      done: $('sxDone'),
    };
    this.stats = loadStats();

    this.el.close.onclick = () => this.hide();
    this.el.reset.onclick = () => {
      // 消したら戻せない。押し間違いで通算が飛ぶのが一番きつい
      if (!this._armed) { this._armed = true; this.el.reset.textContent = 'もう一度押すと消える'; return; }
      this.stats = resetStats();
      this._armed = false;
      this.el.reset.textContent = '記録を消す';
      this.render();
    };
    this.el.root.onclick = (e) => { if (e.target === this.el.root) this.hide(); };
    addEventListener('keydown', (e) => {
      if (!this.isOpen || e.key !== 'Escape') return;
      e.stopPropagation();
      this.hide();
    });
  }

  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  /** 開く。開くたびに読み直すのは、遊んだ後の数字を出すため */
  show(stats = null) {
    this.stats = stats || loadStats();
    this._armed = false;
    this.el.reset.textContent = '記録を消す';
    this.render();
    this.el.root.classList.remove('hidden');
  }

  hide() { this.el.root.classList.add('hidden'); }

  render() {
    const t = this.stats;

    this.el.tallies.textContent = '';
    for (const d of TALLIES) {
      const row = document.createElement('div');
      row.className = 'sxtally';
      const name = document.createElement('span');
      name.textContent = d.name;
      const val = document.createElement('b');
      val.textContent = num(t[d.key]);
      row.append(name, val);
      this.el.tallies.append(row);
    }
    // 命中率は覚えていない。撃った数と当てた数から毎回引く
    // （覚えると、片方だけ足し忘れた時に辻褄の合わない数字が残る）
    {
      const row = document.createElement('div');
      row.className = 'sxtally';
      const name = document.createElement('span');
      name.textContent = '命中率';
      const val = document.createElement('b');
      val.textContent = `${Math.round(accuracyOf(t) * 100)}%`;
      row.append(name, val);
      this.el.tallies.append(row);
    }

    this.el.list.textContent = '';
    let got = 0;
    for (const a of ACHIEVEMENTS) {
      const p = progressOf(a, t);
      if (p >= 1) got++;
      const row = document.createElement('div');
      row.className = p >= 1 ? 'sxach got' : 'sxach';

      const head = document.createElement('div');
      head.className = 'sxahead';
      const name = document.createElement('span');
      name.textContent = a.name;
      const count = document.createElement('span');
      count.className = 'sxacount';
      count.textContent = p >= 1 ? '解除' : `${num(a.have(t))} / ${num(a.need)}`;
      head.append(name, count);

      const desc = document.createElement('div');
      desc.className = 'hint';
      desc.textContent = a.desc;

      const bar = document.createElement('div');
      bar.className = 'sxbar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.round(p * 100)}%`;
      bar.append(fill);

      row.append(head, desc, bar);
      this.el.list.append(row);
    }
    this.el.done.textContent = `${got} / ${ACHIEVEMENTS.length} 解除`;
  }
}
