// 設定の画面。並べる物は src/core/settings.js の表が持っていて、ここは**並べるだけ**。
//
// なぜ表と画面を分けるか: 設定を1つ足すたびに画面のHTMLも書き足す形にすると、
// 「表に足したのに画面に出ない」「画面には出るのに何も効かない」が起きる。
// どちらも例外にならないので、遊んでもらうまで気づけない。
// ここが表を回して作る形なら、表に足した時点で必ず画面に出て、必ず効く。
//
// 開ける場所は2つある。ホーム画面と、遊んでいる最中の一時停止。
// **感度は遊びながらでないと合わせられない。** 一度ホームへ戻らないと変えられない作りだと、
// 「ちょっと速い気がする」を確かめるのに毎回試合を抜けることになる。
import { SETTINGS, loadSettings, saveSetting, resetSettings, applySettings } from '../core/settings.js';

const $ = (id) => document.getElementById(id);

export class SettingsMenu {
  /**
   * @param targets 効かせ先。{ input, audio } を想定。
   *   作った時点で一度全部を効かせるので、呼ぶ側は「読み込んで写す」を書かなくていい
   */
  constructor(targets = {}) {
    this.targets = targets;
    this.el = {
      root: $('settings'),
      rows: $('stRows'),
      close: $('stClose'),
      reset: $('stReset'),
    };
    this.values = loadSettings();
    /* つまみを動かした時に呼ばれる口。統合側が「切られたら今すぐ窓へ戻す」のような
       その場の後始末を足すために要る（設定そのものの反映は applySettings が済ませている） */
    this.onChange = () => {};
    this._rows = new Map();

    this._build();
    this.apply();

    this.el.close.onclick = () => this.hide();
    this.el.reset.onclick = () => {
      this.values = resetSettings();
      this._refresh();
      this.apply();
      for (const s of SETTINGS) this.onChange(s.key, this.values[s.key]);
    };

    // 枠の外を押しても閉じる。「閉じる」を探させない。
    // 中の部品を押した時に閉じないよう、押された物が背景そのものの時だけ畳む
    this.el.root.onclick = (e) => { if (e.target === this.el.root) this.hide(); };

    // ESCでも閉じる。一時停止から開いている時、遊ぶ側の手はESCの上にある。
    // ここで止めておかないと、下のゲーム側までESCが流れる
    addEventListener('keydown', (e) => {
      if (!this.isOpen || e.key !== 'Escape') return;
      e.stopPropagation();
      this.hide();
    });
  }

  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  show() { this.el.root.classList.remove('hidden'); }

  hide() { this.el.root.classList.add('hidden'); }

  /** 今の値を効かせ先へ写す */
  apply() { applySettings(this.values, this.targets); }

  /* ------------------------------------------------------------ 中身 */

  _build() {
    this.el.rows.textContent = '';
    for (const s of SETTINGS) {
      const row = document.createElement('div');
      row.className = 'strow';

      const head = document.createElement('div');
      head.className = 'sthead';
      const name = document.createElement('span');
      name.textContent = s.name;
      const val = document.createElement('span');
      val.className = 'stval';
      head.append(name, val);

      let input;
      if (s.kind === 'select') {
        // 多択（影のこまやかさ等）。つまみにすると「0.5が何なのか」を
        // 数字から想像させることになるので、言葉の選択肢で出す
        input = document.createElement('select');
        input.className = 'stselect';
        for (const o of s.options) {
          const opt = document.createElement('option');
          opt.value = o;
          opt.textContent = o;
          input.appendChild(opt);
        }
      } else {
        input = document.createElement('input');
        if (s.kind === 'check') {
          input.type = 'checkbox';
          input.className = 'stcheck';
        } else {
          input.type = 'range';
          input.className = 'strange';
          input.min = String(s.min);
          input.max = String(s.max);
          input.step = String(s.step);
        }
      }
      // つまみは掴んで動かしている最中もずっと input が飛ぶ。
      // change（離した時）にすると、動かしている間の音量が変わらず、
      // 耳で合わせられない
      input.oninput = () => this._changed(s, s.kind === 'check' ? input.checked : input.value);

      const hint = document.createElement('div');
      hint.className = 'hint';
      hint.textContent = s.hint || '';

      row.append(head, input, hint);
      this.el.rows.append(row);
      this._rows.set(s.key, { input, val });
    }
    this._refresh();
  }

  _changed(def, raw) {
    // 覚えさせた後の（正された）値を持ち直す。つまみが返す文字をそのまま持つと、
    // 次に読み込んだ時と型が違う物を握ることになる
    this.values[def.key] = saveSetting(def.key, raw);
    this._refresh();
    this.apply();
    this.onChange(def.key, this.values[def.key]);
  }

  /** 画面の見た目を今の値へ合わせる。既定へ戻した時にも使う */
  _refresh() {
    for (const s of SETTINGS) {
      const row = this._rows.get(s.key);
      if (!row) continue;
      const v = this.values[s.key];
      if (s.kind === 'check') {
        row.input.checked = !!v;
        row.val.textContent = v ? '入' : '切';
      } else {
        row.input.value = String(v);
        row.val.textContent = s.fmt ? s.fmt(v) : String(v);
      }
    }
  }
}
