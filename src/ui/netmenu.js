// 対戦に入るまでの画面。DOMはindex.htmlに置いてあるので、ここは値の出し入れだけ持つ。
// 通信は一切やらない。繋ぐのは統合側で、この画面は「何を入力したか」を渡して、
// 結果の文言を受け取るだけにしてある。ここに接続まで持たせると、
// 画面の見た目を直すたびに通信の作法まで触ることになる。
import { normalizeRoom, ROOM_LEN } from '../net/protocol.js';

const $ = (id) => document.getElementById(id);

// 前回の入力を覚えておく口。遊ぶたびに名前とIPを打ち直させない
const SAVE = { name: 'blackout.name', url: 'blackout.url', room: 'blackout.room' };

// 繋がらなかった時の文言。「エラー」とだけ出すと、アドレスが違うのか
// 相手がまだ立てていないのか分からず、遊ぶ側に打つ手が無くなる。
// 統合側はsetStatusにこれを渡す
export const NET_MSG = {
  connecting: '接続中…',
  offline: '相手に繋がりません。接続先のアドレスと、同じWi-Fiに繋がっているかを確かめてください',
  full: 'この部屋は満員です。合言葉を変えるか、誰かが抜けるのを待ってください',
  lost: '接続が切れました。もう一度「対戦に参加」を押してください',
  timeout: '応答がありません。相手の端末でサーバーが動いているか確かめてください',
};

// localStorageは設定次第で読み書きどちらも例外を投げる。
// 名前を覚えられないだけで遊べなくなるのは割に合わない
function load(key, fallback) {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, value); } catch { /* 覚えられないだけ */ }
}

export class NetMenu {
  constructor() {
    this.el = {
      root: $('netmenu'),
      name: $('nmName'), url: $('nmUrl'), room: $('nmRoom'),
      status: $('nmStatus'), solo: $('nmSolo'), join: $('nmJoin'),
      killPrev: $('nmKillPrev'), killNext: $('nmKillNext'),
      killPlay: $('nmKillPlay'), killNote: $('nmKillNote'),
      killMore: $('nmKillMore'), killTune: $('nmKillTune'),
    };

    // 統合側が差し替える。初期値を空関数にしておくと、繋ぎ忘れても画面が落ちない
    this.onSolo = () => {};
    this.onJoin = () => {};
    // キル音の候補送り。dirが0なら今の候補をもう一度鳴らすだけ。
    // 戻り値の{index,total,name,note,tune}をそのまま画面へ出す
    this.onKillSound = () => null;
    // つまみを1つ動かした時。統合側がAudioEngineへ渡して鳴らす
    this.onKillTweak = () => null;
    this.busy = false;

    this.el.name.value = load(SAVE.name, '');
    // 空で覚えてしまった時も既定へ戻す。接続先が空欄の画面は手掛かりが無い
    this.el.url.value = load(SAVE.url, '') || defaultUrl();
    this.el.room.value = normalizeRoom(load(SAVE.room, ''));

    // addEventListenerではなく代入で持つ。DOMはindex.html側に1組しかないので、
    // 2回作られた時に古い方の処理まで動いて二重に始まるのを防ぐ
    this.el.solo.onclick = () => {
      if (this.busy) return;
      this._store();
      this.onSolo();
    };
    this.el.join.onclick = () => this._join();

    // 打ち終わってEnterを押すのが自然な形。押せるボタンを探させない
    for (const k of ['name', 'url', 'room']) {
      this.el[k].onkeydown = (e) => {
        if (e.key === 'Enter') this._join();
        // WASDやRが下のゲームへ抜けないようにする（入力中に武器が切り替わる）
        e.stopPropagation();
      };
    }

    // 合言葉は口頭で伝わってくるので、小文字も紛れた文字も打った端から整える
    this.el.room.oninput = () => {
      this.el.room.value = normalizeRoom(this.el.room.value);
    };

    // キル音を出撃前に聴き比べる。押した操作が起点になるので、
    // ブラウザの「操作がないと音を鳴らさない」制限にもここで引っかからない
    this.el.killPrev.onclick = () => this._killSound(-1);
    this.el.killNext.onclick = () => this._killSound(1);
    this.el.killPlay.onclick = () => this._killSound(0);
    this.el.killMore.onclick = () => {
      const open = this.el.killTune.classList.toggle('hidden');
      this.el.killMore.textContent = open ? 'つまみを開く ▾' : 'つまみを閉じる ▴';
    };
  }

  /**
   * つまみを組み立てる。
   * @param range {キー: {min,max,step,label}}
   */
  buildKillKnobs(range) {
    this._killRange = range;
    this._knobs = {};
    const box = this.el.killTune;
    box.innerHTML = '';
    for (const [key, r] of Object.entries(range)) {
      const row = document.createElement('div');
      row.className = 'knob';
      const nameEl = document.createElement('div');
      nameEl.className = 'kname';
      nameEl.textContent = r.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = r.min; input.max = r.max; input.step = r.step;
      const valEl = document.createElement('div');
      valEl.className = 'kval';
      // 動かしている最中に鳴らす。離すまで待たせると、回している感触が出ない。
      // ただし連続で動かすと音が重なって団子になるので、少し間引く
      let last = 0;
      input.oninput = () => {
        const v = parseFloat(input.value);
        valEl.textContent = this._fmt(key, v);
        const now = performance.now();
        if (now - last < 140) return;
        last = now;
        this.setKillSound(this.onKillTweak(key, v));
      };
      row.append(nameEl, input, valEl);
      box.appendChild(row);
      this._knobs[key] = { input, valEl };
    }
  }

  _fmt(key, v) {
    if (key === 'gap') return `${Math.round(v * 1000)}ms`;
    if (key === 'hits') return `${Math.round(v)}発`;
    return v.toFixed(2);
  }

  _killSound(dir) {
    this.setKillSound(this.onKillSound(dir));
  }

  /** 今の設定を画面に出す。鳴らさずに表示だけ更新する時にも使う */
  setKillSound(info) {
    if (!info) return;
    this.el.killPlay.textContent = `${info.index + 1} / ${info.total}　${info.name}`;
    this.el.killNote.textContent = `${info.note}　／　押すと鳴る。つまみで自分の好みに詰められる`;
    // つまみの位置も実際の値に合わせる。出発点を選び直した時にここがずれると、
    // 表示されている値と鳴っている音が食い違う
    if (info.tune && this._knobs) {
      for (const [key, k] of Object.entries(this._knobs)) {
        const v = info.tune[key];
        if (v == null) continue;
        k.input.value = v;
        k.valEl.textContent = this._fmt(key, v);
      }
    }
  }

  show() {
    this.el.root.classList.remove('hidden');
    this.setBusy(false);
    // 名前が入っていれば押すだけで済む。空の時だけ入力欄へ寄せる
    if (!this.el.name.value) this.el.name.focus();
  }

  hide() {
    this.el.root.classList.add('hidden');
    // 入力欄にフォーカスが残ったままだと、始まった後のWASDが文字として吸われる
    document.activeElement?.blur?.();
  }

  /** 選択画面が出ているか。裏の起動画面を押してもゲームを始めさせないために要る */
  get isOpen() { return !this.el.root.classList.contains('hidden'); }

  /** 統合側から接続の途中経過を出す。isErrorで赤くする */
  setStatus(text, isError = false) {
    this.el.status.textContent = text || '';
    this.el.status.classList.toggle('bad', !!isError);
  }

  /** 接続中はボタンを止める。連打されると同じ部屋へ何本も繋ぎにいく */
  setBusy(on) {
    this.busy = !!on;
    this.el.root.classList.toggle('busy', this.busy);
    this.el.solo.disabled = this.busy;
    this.el.join.disabled = this.busy;
  }

  /* ------------------------------------------------------------ 中身 */

  _join() {
    if (this.busy) return;

    const name = this.el.name.value.trim();
    if (!name) {
      this.setStatus('名前を入れてください。撃たれた相手にこの名前が出ます', true);
      this.el.name.focus();
      return;
    }

    let url = this.el.url.value.trim();
    if (!url) {
      this.setStatus('接続先を入れてください。部屋を立てた人の端末のアドレス', true);
      this.el.url.focus();
      return;
    }
    // 口頭で伝わるのはIPだけなので、ws://を書き忘れた形で入ってくる。
    // 補ったうえで欄にも戻して、次から何を書けばいいか見て分かるようにする
    if (!/^wss?:\/\//i.test(url)) url = `ws://${url}`;
    this.el.url.value = url;

    const room = normalizeRoom(this.el.room.value);
    this.el.room.value = room;
    // 半端な文字数は打ち間違い。空(共通の部屋)とは分けて止める
    if (room.length > 0 && room.length < ROOM_LEN) {
      this.setStatus(`合言葉は${ROOM_LEN}文字です。空のままなら共通の部屋に入ります`, true);
      this.el.room.focus();
      return;
    }

    this._store();
    this.setStatus(NET_MSG.connecting, false);
    this.setBusy(true);
    this.onJoin({ url, room, name });
  }

  _store() {
    save(SAVE.name, this.el.name.value.trim());
    save(SAVE.url, this.el.url.value.trim());
    save(SAVE.room, normalizeRoom(this.el.room.value));
  }
}

// 既定の接続先は今開いているページと同じ端末。自分で立てて自分で入る時は
// そのまま押せて、他人の所へ入る時だけIPを書き換えれば済む
function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + (location.host || 'localhost:8080');
}
