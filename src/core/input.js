// キーボード・マウス・ポインタロックの受け口。
// マウス移動量は毎フレーム消費して溜め込まない（消費し忘れると視点がすっ飛ぶ）。

/* キーボードを借りる時に、借りるキーを名指しする一覧。
 *
 * **ここを空にして「全部借りる」と頼んではいけない。** 全部の中にはESCも入っていて、
 * ESCまで借りると、ブラウザは「短く押しても何も起きない。2秒押し続けたら抜ける」
 * という作法へ切り替わる。遊んでいる側からは**ESCが壊れたようにしか見えない**
 * （実際に全画面にしてから「escを押しても何も起きない」と言われた）。
 *
 * 借りたいのは、preventDefaultで止められないブラウザ予約のショートカットだけ:
 *   Ctrl/Cmd + W … タブを閉じる
 *   Ctrl/Cmd + T … 新しいタブ
 *   Ctrl/Cmd + N … 新しい窓
 *   Ctrl/Cmd + 1〜9 … タブの切り替え
 * Ctrl+RやCtrl+FやCtrl+Dはページ側のpreventDefaultで止まるので借りなくてよい。
 *
 * ESCとTabとCommandを外してあるのは意図的で、外さないと
 * ESCで抜けられない・Alt+TabもCmd+Tabもできない、という閉じ込めになる */
const LOCK_KEYS = [
  'KeyW', 'KeyT', 'KeyN',
  'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5',
  'Digit6', 'Digit7', 'Digit8', 'Digit9',
];

export class Input {
  constructor(domElement) {
    this.dom = domElement;
    this.keys = new Set();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.buttons = [false, false, false];
    this.locked = false;
    this.sensitivity = 0.0022;
    this.invertY = false;
    /* 全画面にするかどうか。遊ぶ側が切れる。
       切ってあるとCtrl+Wを止める手段が無くなるが、それは選んだ側が承知していること。
       「裏で別のタブを見ながら友達を待つ」ほうが大事な場面がある */
    this.wantFullscreen = true;
    this._pressedThisFrame = new Set();
    this._clickedThisFrame = new Set();
    this._onLockChange = null;

    addEventListener('keydown', (e) => {
      // 遊んでいる間はブラウザのショートカットを全部止める。
      //
      // Windowsで実際に起きたこと。しゃがみがCtrlなので、しゃがみながら動くと:
      //   Ctrl+W → タブが閉じる（前進しようとして落ちる）
      //   Ctrl+R → 再読み込み（リロードしようとしてホーム画面に戻る）
      //   Ctrl+D → ブックマーク（右へ行けない）
      //   Ctrl+F → ページ内検索（包帯が出せない）
      //   Ctrl+1/2/3 → タブの切り替え（武器を変えられない）
      // MacはこれがCommand+キーなので、Ctrlでしゃがんでも何も起きない。
      // 作った側が一度も踏まないまま出していた。
      //
      // 個別に並べて止める形にしない。並べ方を間違えると、遊ぶ側からは
      // 「たまにタブが消える」としか見えず、原因に辿り着けない。
      // マウスを掴んでいる＝遊んでいる間は、ブラウザの操作は全部要らない
      // 文字を打つ場所に入力先がある時は止めない。
      // 止めると、発言を打とうとしても1文字も入らない。
      // ゲームの操作へ漏らさないのは打つ側（chat.jsのstopPropagation）の仕事
      const typing = e.target instanceof HTMLElement
        && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
      if (this.locked && !typing) e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this._pressedThisFrame.add(e.code);
      // 掴んでいない間も、これだけは止める。
      // スペースでページがスクロールしたりタブが移動すると台無しになる
      if (['Space', 'Tab', 'KeyR', 'ControlLeft', 'MetaLeft', 'MetaRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      // MacはCommandを押している間、他のキーのkeyupを一切よこさない。
      // 「Wで走る → Commandでしゃがむ → Wを離す → Commandを離す」と辿ると、
      // Wのkeyupがどこにも来ないまま押しっぱなし扱いで残り、手を離しているのに
      // 前へ走り続ける（戦域の外へ出て力尽きる）。
      // Commandが離れた時点で全部落とす。取りこぼした物がここで必ず消える。
      // 本当に押し続けていたキーまで落ちるが、押し直せば戻る。
      // 「勝手に走り続ける」より「一瞬止まる」のほうが被害が小さい
      if (e.code === 'MetaLeft' || e.code === 'MetaRight') this.keys.clear();
    });
    addEventListener('blur', () => { this.keys.clear(); this.buttons.fill(false); });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keys.clear();
        this.buttons.fill(false);
        // 遊ぶのをやめたらキーボードを返す。返さないと、ロビーや選択画面でも
        // Ctrl+Wが効かないままになって、閉じたい時に閉じられない
        this._unlockKeyboard();
        // 全画面もここで畳む。
        // 遊ぶのをやめる＝別のタブを見たい・他の作業をしたい時なので、
        // 画面いっぱいのまま残されると、そのために毎回もう一度ESCを押すことになる。
        // 復帰はクリックからなので、その時にまた全画面へ入れる
        this.exitFullscreen();
      }
      this._onLockChange?.(this.locked);
    });

    this.dom.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons[e.button] = true;
      // 押した瞬間だけ立つ印。押しっぱなしと区別したい操作（覗き込みの切り替え）に使う。
      // トラックパッドは右クリックを押したまま左クリックができないので、
      // 「押している間だけ覗く」だと覗きながら撃つ動作そのものが成立しない
      this._clickedThisFrame.add(e.button);
      e.preventDefault();
    });
    addEventListener('mouseup', (e) => { this.buttons[e.button] = false; });
    this.dom.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
  }

  onLockChange(fn) { this._onLockChange = fn; }

  /**
   * マウスを掴む。あわせて全画面にして、キーボードも借りにいく。
   *
   * なぜ全画面まで要るか: preventDefaultで止められないショートカットが2つある。
   * **Ctrl+W（タブを閉じる）とCtrl+T（新しいタブ）はブラウザが予約していて、
   * 普通のページからは絶対に止められない。** しゃがみながら前へ進むと
   * タブが閉じる、という一番痛い形がこれで残ってしまう。
   *
   * Keyboard Lockという仕組みだけがこれを止められるが、条件が2つある:
   *   1. 全画面であること
   *   2. ChromeかEdgeであること（FirefoxとSafariには無い）
   *
   * だから全画面を先に頼み、そのうえでキーボードを借りる。
   * どちらも失敗しうるので、失敗しても遊べる形（今まで通り）に落ちる。
   *
   * 借りるキーはLOCK_KEYSで名指しする。**ESCを借りると、ESCが効かなくなる。**
   * ここを空にして「全部」と頼んでいた時期があり、全画面にした後だけ
   * ESCで一時停止へ抜けられない状態になっていた
   */
  requestLock() {
    // ここでも一応頼むが、**これだけでは足りない。**
    //
    // 全画面はブラウザが「人が押した直後」しか許さない。
    // 対戦で試合が始まるのはサーバーから知らせが届いた時なので、
    // そこから頼んでも断られる。まさに友達が遊ぶ場面で全画面にならず、
    // キーボードも借りられず、Ctrl+Wでタブが閉じるのが残っていた。
    //
    // なので、ボタンを押した時点で goFullscreen() を呼んでおく形にした。
    // 既に全画面なら、ここはキーボードを借り直すだけで済む
    this.goFullscreen();
    this.dom.requestPointerLock?.();
  }

  /**
   * 全画面にしてキーボードを借りる。**必ずクリックの中から呼ぶこと。**
   *
   * 通信の知らせやタイマーから呼んでも、ブラウザは全画面を断る。
   * 断られたら黙って受ける（全画面でなくても遊べる。Ctrl+Wだけ残る）
   */
  goFullscreen() {
    // 遊ぶ側が全画面を切っている時は何もしない。
    // キーボードを借りにいくのも省く（全画面でないと借りられない決まりなので、
    // 頼んでも必ず断られる。断られる呼び出しを残しておく意味が無い）
    if (!this.wantFullscreen) return;
    if (document.fullscreenElement) { this._lockKeyboard(); return; }
    const p = document.documentElement.requestFullscreen?.({ navigationUI: 'hide' });
    // 対応していないブラウザは何も返さないので、その時は素通り
    if (!p?.then) { this._lockKeyboard(); return; }
    p.then(() => this._lockKeyboard()).catch(() => this._lockKeyboard());
  }

  /* 名指しした分だけキーボードを借りる。Ctrl+WとCtrl+Tが手元に来る。
     LOCK_KEYSの説明にある通り、ESCは**絶対にここへ入れない**。
     対応していないブラウザでは何も起きない（navigator.keyboardが無い） */
  _lockKeyboard() {
    try { navigator.keyboard?.lock?.(LOCK_KEYS); } catch { /* 借りられないだけ */ }
  }

  /* 全画面を畳む。既に窓なら何もしない。
     document.exitFullscreenは全画面でない時に呼ぶと例外を投げる */
  exitFullscreen() {
    if (!document.fullscreenElement) return;
    try { document.exitFullscreen?.()?.catch?.(() => {}); } catch { /* 畳めないだけ */ }
  }

  /* 借りた物を返す。遊ぶのをやめた時に返さないと、
     ロビーや選択画面でもCtrl+Wが効かないままになる */
  _unlockKeyboard() {
    try { navigator.keyboard?.unlock?.(); } catch { /* 借りていないだけ */ }
  }

  pressed(code) { return this._pressedThisFrame.has(code); }

  /** そのフレームで押し込まれたマウスボタン。押しっぱなしでは2度目は立たない */
  clicked(button) { return this._clickedThisFrame.has(button); }
  down(code) { return this.keys.has(code); }

  // 移動入力を -1..1 で返す（斜め移動が速くならないよう正規化する）
  moveVector(out) {
    let x = 0, z = 0;
    if (this.keys.has('KeyW')) z -= 1;
    if (this.keys.has('KeyS')) z += 1;
    if (this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('KeyD')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    out.x = x; out.z = z;
    return out;
  }

  // 1フレーム分のマウス移動をラジアンに変換して取り出す
  takeLook() {
    const yaw = -this.mouseDX * this.sensitivity;
    const pitch = (this.invertY ? 1 : -1) * this.mouseDY * this.sensitivity;
    this.mouseDX = 0;
    this.mouseDY = 0;
    return { yaw, pitch };
  }

  endFrame() { this._pressedThisFrame.clear(); this._clickedThisFrame.clear(); }
}
