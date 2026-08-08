// 対戦に入るまでの画面。DOMはindex.htmlに置いてあるので、ここは値の出し入れだけ持つ。
// 通信は一切やらない。繋ぐのは統合側で、この画面は「何を入力したか」を渡して、
// 結果の文言を受け取るだけにしてある。ここに接続まで持たせると、
// 画面の見た目を直すたびに通信の作法まで触ることになる。
const $ = (id) => document.getElementById(id);

// 前回の入力を覚えておく口。遊ぶたびに名前を打ち直させない。
// 全画面の入り切りもここが持っていたが、設定画面へ移した（src/core/settings.js）
const SAVE = { name: 'blackout.name' };

// 繋がらなかった時の文言。「エラー」とだけ出すと、遊ぶ側に打つ手が無くなる。
// 統合側はsetStatusにこれを渡す
export const NET_MSG = {
  connecting: '接続中…',
  offline: 'サーバーに繋がりません。少し待ってから、もう一度押してください',
  full: 'いま満員です。誰かが抜けるのを待ってください',
  lost: '接続が切れました。もう一度「対戦に参加」を押してください',
  // 自動で戻りにいっている最中。**「切れました」で終わらせない。**
  // 押す物が無い画面に赤字だけ出ていると、遊ぶ側は待てばいいのか
  // 押せばいいのか分からないまま止まる
  rejoin: '接続が切れました。戻っています…',
  timeout: 'サーバーから応答がありません。少し待ってから、もう一度押してください',
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
      name: $('nmName'),
      status: $('nmStatus'), solo: $('nmSolo'), join: $('nmJoin'),
      tutorial: $('nmTutorial'),
      settings: $('nmSettings'), quit: $('nmQuit'),
    };

    // 統合側が差し替える。初期値を空関数にしておくと、繋ぎ忘れても画面が落ちない
    this.onSolo = () => {};
    this.onJoin = () => {};
    // FPSが初めての人向けの練習場を開く口
    this.onTutorial = () => {};
    // 設定を開く口。画面そのものは src/ui/settings.js が持っている
    this.onSettings = () => {};
    // 戦績を開く口はここにあったが、画面ごと消した（「誰も見ない」）
    /* 終了する口。**ブラウザのゲームには「閉じる」が無い。**
       タブを閉じるまで裏で3Dを描き続けるので、見ていないのにパソコンが熱くなる。
       やめる意思をここで受け取って、描画を止める（統合側の仕事） */
    this.onQuit = () => {};
    this.busy = false;

    this.el.name.value = load(SAVE.name, '');
    this.el.settings.onclick = () => this.onSettings();
    this.el.quit.onclick = () => this.onQuit();

    // addEventListenerではなく代入で持つ。DOMはindex.html側に1組しかないので、
    // 2回作られた時に古い方の処理まで動いて二重に始まるのを防ぐ
    this.el.solo.onclick = () => {
      if (this.busy) return;
      this._store();
      this.onSolo();
    };
    this.el.tutorial.onclick = () => {
      if (this.busy) return;
      this._store();
      this.onTutorial();
    };
    this.el.join.onclick = () => this._join();

    // 打ち終わってEnterを押すのが自然な形。押せるボタンを探させない
    this.el.name.onkeydown = (e) => {
      if (e.key === 'Enter') this._join();
      // WASDやRが下のゲームへ抜けないようにする（入力中に武器が切り替わる）
      e.stopPropagation();
    };
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

  /** 入力欄の名前。1人で遊ぶ時は必須ではないので、空のこともある */
  get playerName() { return this.el.name.value.trim(); }

  /** 接続中はボタンを止める。連打されると同じ部屋へ何本も繋ぎにいく */
  setBusy(on) {
    this.busy = !!on;
    this.el.root.classList.toggle('busy', this.busy);
    this.el.solo.disabled = this.busy;
    this.el.join.disabled = this.busy;
    // ここに書き忘れると、対戦の接続中にチュートリアルへ入れてしまう
    this.el.tutorial.disabled = this.busy;
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

    this._store();
    this.setStatus(NET_MSG.connecting, false);
    this.setBusy(true);
    this.onJoin({ url: defaultUrl(), name });
  }

  _store() {
    save(SAVE.name, this.el.name.value.trim());
  }
}

// 繋ぎ先は必ず今開いているページと同じ場所。
//
// 手で書き換える欄を出していた時期があるが、畳んだ。
// 全員が同じURLを開いて遊ぶ形になった以上、書き換える理由がもう無い。
// 加えて、あの欄は事故の元でもあった。前にLANで遊んだブラウザには
// ws://192.168... が保存されたままになっていて、httpsのページから
// それで繋ごうとして混在コンテンツで弾かれる。
// 遊ぶ側にはなぜ繋がらないのかまったく見えない。
//
// 手元で npm start して遊ぶ時も、開くのは http://localhost:8080 なので
// この関数がそのまま ws://localhost:8080 を返す。困らない
function defaultUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + (location.host || 'localhost:8080');
}
