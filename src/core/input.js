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

const META = ['MetaLeft', 'MetaRight'];

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
    /* **Commandを押している間に押し下げたキー。** Commandを離す時に落とす相手。
       理由は下のkeyupに書いてある（macOSがkeyupを送らない相手がここだけ） */
    this._underMeta = new Set();
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
      /* **文字を打っている間は、ここから下も全部素通しする。**
         2026-08-13に「新規登録でパスワードにrが打てない」と言われた所。
         下の「掴んでいなくても止める」一覧にKeyRが入っていて、
         そこには打っている最中かどうかの条件が付いていなかった。
         止められたキーは1文字も入らないので、遊ぶ側からは
         **キーボードのrだけが壊れている**ようにしか見えない。

         Rだけの話ではない。Spaceも入らず、Tabで次の欄へ移ることもできなかった。
         合言葉にスペースを使う人・Tabで欄を送る人は、そちらで詰まっていたはず。

         会員証(account.js)はchat.jsと違ってstopPropagationしていないので、
         打った物がここまで上がってくる。**打つ場所は他にもある**
         （合言葉・部屋の合言葉・名前）ので、受け口のこちら側で1回止める */
      if (typing) return;
      /* 押している集合は、キーリピートでも入れ直す。
         入れ直すのは集合だけで、「押した瞬間」の印は下へ置いたまま。
         あれをリピートで立てると、跳躍も装填も押しっぱなしで連射になる */
      this.keys.add(e.code);
      /* **Commandを押している間に押し下げたキーを覚えておく。**
         このキーたちだけが、離した時のkeyupを取りこぼす相手になる（下のkeyup参照）。
         Commandを押す前から握っていたキーはここに入らないので、落とされない */
      if (!META.includes(e.code) && (this.keys.has('MetaLeft') || this.keys.has('MetaRight'))) {
        this._underMeta.add(e.code);
      }
      if (e.repeat) return;
      this._pressedThisFrame.add(e.code);
      // 掴んでいない間も、これだけは止める。
      // スペースでページがスクロールしたりタブが移動すると台無しになる
      if (['Space', 'Tab', 'KeyR', 'ControlLeft', 'MetaLeft', 'MetaRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      /* MacはCommandを押している間、他のキーのkeyupを一切よこさない。
         「Wで走る → Commandでしゃがむ → Wを離す → Commandを離す」と辿ると、
         Wのkeyupがどこにも来ないまま押しっぱなし扱いで残り、手を離しているのに
         前へ走り続ける（戦域の外へ出て力尽きる）。だからCommandが離れた時に片付ける。

         **落とすのは「Commandを押している間に押し下げたキー」だけ。**
         ここを2回間違えている:
           1回目 … keys.clear() で全部落とした。Shiftまで消えるので、
                    走りながらCommandでしゃがむと離した瞬間に棒立ちになった
           2回目 … 修飾キー以外を全部落とした。今度は**Wが消える**ので、
                    Shift+Wを押しっぱなしでも前へ進まなくなった（同じ「止まる」）。
                    「キーリピートが入れ直すから大丈夫」と考えていたが、
                    macOSは別のキーを挟むと元のキーのリピートを再開しないので、
                    **Wは戻ってこない**

         正しい線引きは「いつ押されたか」。Commandを押す前から握っているキーは、
         遊ぶ側がそのまま握り続けているキー（走りも前進もこれ）。
         Commandを押してから押し下げたキーだけが、keyupを取りこぼす相手になる */
      if (META.includes(e.code)) {
        // 両方の⌘が離れてから片付ける。片方だけ離しても押している間は続きなので
        if (!this.keys.has('MetaLeft') && !this.keys.has('MetaRight')) {
          for (const k of this._underMeta) this.keys.delete(k);
          this._underMeta.clear();
        }
      } else {
        // 普通にkeyupが来た物は、もう取りこぼしの心配が無い
        this._underMeta.delete(e.code);
      }
    });
    addEventListener('blur', () => { this.keys.clear(); this._underMeta.clear(); this.buttons.fill(false); });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.dom;
      if (!this.locked) {
        this.keys.clear();
        this._underMeta.clear();
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
   * だから全画面にしてから、そのうえでキーボードを借りる。
   * どちらも失敗しうるので、失敗しても遊べる形（今まで通り）に落ちる。
   *
   * 借りるキーはLOCK_KEYSで名指しする。**ESCを借りると、ESCが効かなくなる。**
   * ここを空にして「全部」と頼んでいた時期があり、全画面にした後だけ
   * ESCで一時停止へ抜けられない状態になっていた
   */
  requestLock() {
    /* **掴むのを先に頼む。順番を入れ替えてはいけない。**
       ブラウザは「人がたった今押した」という印を1回ぶんだけ持っていて、
       全画面はそれを**使い切る**（掴む方は使い切らない）。
       だから先に全画面を頼むと、その後の掴む方には印が残っていなくて、
       ブラウザが "A user gesture is required to request Pointer Lock." と言って断る。
       断られた失敗は誰も受け取らないまま画面の赤い枠へ流れるので、
       遊ぶ側には**読めない英語が出たまま消えない**（2026-08-08に実際に出た）。
       掴む→全画面の順にすると、1回の印で両方通る */
    const p = this.dom.requestPointerLock?.();
    /* それでも断られること自体は普通に起きる（掴みを外した直後は
       少しの間ブラウザが掴み直させない決まりがある）。
       ここで受けないと、また同じ赤い枠に戻る。
       もう一度クリックすれば掴めるので、遊べなくなる類の失敗ではない。
       読める言葉に翻訳するのは受け取った側(main.js)の仕事 */
    p?.catch?.(() => this._onLockFail?.());
    // 全画面はここから。断られても遊べる（Ctrl+Wが残るだけ）
    this.goFullscreen();
  }

  /** 掴むのを断られた時。遊ぶ側へ「もう一度クリック」を出すために要る */
  onLockFail(fn) { this._onLockFail = fn; }

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
    /* **try/catchでは受け止められない。** lock()はpromiseを返すので、
       断られた時は例外ではなく「拾われなかった約束の失敗」として流れる。
       行き先はsrc/ui/diag.jsで、遊ぶ側の画面の隅に**英語のまま**出る
       （2026-08-12に「右上にthis requestみたいなエラー文が出てた」と言われた所。
         ブラウザは掴み直しのたびに前の申し込みを取り消すので、
         押し直しただけで "...cancelled by a new lock request" が出る）。

       断られても遊べる（Ctrl+Wが手元に残るだけ）ので、黙って捨てる。
       tryも残す。**対応していないブラウザではその場で例外**になる */
    try { navigator.keyboard?.lock?.(LOCK_KEYS)?.catch?.(() => {}); } catch { /* 借りられないだけ */ }
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
