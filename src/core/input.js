// キーボード・マウス・ポインタロックの受け口。
// マウス移動量は毎フレーム消費して溜め込まない（消費し忘れると視点がすっ飛ぶ）。
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
      if (this.locked) e.preventDefault();
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
   * ESCを押した時に全画面と掴みの両方が外れるのは、ブラウザ側がそう作っている
   */
  requestLock() {
    // 全画面はマウスを掴むより先に頼む。逆にすると、全画面へ移る時の
    // 画面の作り直しで掴みが外れることがある
    if (!document.fullscreenElement) {
      // 失敗しても遊べるので、断られたことは黙って受ける
      document.documentElement.requestFullscreen?.({ navigationUI: 'hide' })
        .then(() => this._lockKeyboard())
        .catch(() => this._lockKeyboard());
    } else {
      this._lockKeyboard();
    }
    this.dom.requestPointerLock?.();
  }

  /* キーボードを丸ごと借りる。Ctrl+WとCtrl+Tまで手元に来る。
     対応していないブラウザでは何も起きない（navigator.keyboardが無い） */
  _lockKeyboard() {
    try { navigator.keyboard?.lock?.(); } catch { /* 借りられないだけ */ }
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
