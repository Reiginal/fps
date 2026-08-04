// 発言の画面。ロビーでも試合中でも同じ物を使う。
// DOMはindex.htmlに置いてあるので、ここは出し入れと打つ場所だけ持つ。
// 通信はしない（netmenu.js・lobby.jsと同じ作法）。
//
// 一番気を付ける所は、他人が打った文字列をそのまま画面へ出す点。
// innerHTMLへ入れる前に必ずescを通す。ここを抜かすと、発言に細工した人が
// 他人の画面を書き換えられる。身内で遊ぶ前提でも、ここだけは省けない。
import { CHAT_MAX } from '../net/protocol.js';

const $ = (id) => document.getElementById(id);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

// 画面に残す行数。増やすと古い発言まで見えるが、視界を塞ぐ
const MAX_LINES = 6;
// 薄くなるまでの秒数。消さずに薄くするのは、撃ち合いの後に読み返せるようにするため
const FADE_AFTER_S = 12;

export class Chat {
  constructor() {
    this.el = {
      root: $('chat'),
      log: $('chatLog'),
      input: $('chatInput'),
    };
    // 統合側が差し替える
    this.onSend = () => {};
    // 打っている間だけ真。ゲーム側はこれを見て、WASDを文字として扱う
    this.typing = false;
    this._lines = [];

    this.el.input.onkeydown = (e) => {
      // 打っている文字がゲームへ抜けないようにする。
      // これが無いと、発言を打つたびに武器が切り替わって走り出す
      e.stopPropagation();
      if (e.key === 'Enter') {
        const text = this.el.input.value.trim().slice(0, CHAT_MAX);
        this.el.input.value = '';
        this.close();
        if (text) this.onSend(text);
      } else if (e.key === 'Escape') {
        this.el.input.value = '';
        this.close();
      }
    };
  }

  show() { this.el.root.classList.remove('hidden'); }

  hide() {
    this.el.root.classList.add('hidden');
    this.close();
  }

  /** 打つ場所を開く。開いている間はゲームの操作を止める側の判断が要る */
  open() {
    if (this.typing) return;
    this.typing = true;
    this.el.root.classList.remove('hidden');
    this.el.input.classList.remove('hidden');
    this.el.input.focus();
  }

  close() {
    if (!this.typing) return;
    this.typing = false;
    this.el.input.classList.add('hidden');
    this.el.input.blur();
  }

  /** 届いた発言を1行足す。mineで自分の発言を色分けする */
  push(name, text, mine = false) {
    this.el.root.classList.remove('hidden');
    const d = document.createElement('div');
    d.className = `cline${mine ? ' me' : ''}`;
    d.innerHTML = `<b>${esc(name)}</b>${esc(text)}`;
    this.el.log.appendChild(d);
    this._lines.push({ el: d, at: 0 });
    while (this._lines.length > MAX_LINES) {
      const old = this._lines.shift();
      old.el.remove();
    }
  }

  /** 古い行を薄くする。毎フレーム呼ばれる */
  update(dt) {
    for (const l of this._lines) {
      l.at += dt;
      if (l.at > FADE_AFTER_S) l.el.classList.add('old');
    }
  }

  clear() {
    this.el.log.innerHTML = '';
    this._lines.length = 0;
  }
}
