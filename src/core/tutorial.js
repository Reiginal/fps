// チュートリアルの進行係。「今なにを教えていて、できたかどうか」だけを持つ。
//
// なぜ要るか: このゲームを人に遊んでもらうと、FPS自体が初めての人が結構いる。
// WASDで歩く・右クリックで覗く・Rで弾を入れ替える、のような「FPSの常識」は、
// 未経験の人には画面の説明を読んでも伝わらない。1つずつ体でやってもらうしかない。
//
// ここはDOMもThreeJSも知らない純粋なクラスにしてある。
// 毎フレーム、ゲーム側(main.js)が数字だけのスナップショットを渡し、
// こちらは「今の課題ができたか」を判定して次へ進む。
// エッジの検出（ジャンプの瞬間・リロードの完了・ADSの往復）も全部こちらの内部。
// おかげで tools/check-tutorial.mjs が、素のオブジェクトを流すだけで
// 全ステップの遷移を机の上で叩ける。
//
// 文言もこの表が唯一の持ち場。キーの表記（左Shift・R・右クリック…）が
// 実装とずれていないかは check-tutorial.mjs が突き合わせる。

// 課題の並びは通路の構造と1対1で対応する（tutorial-level.js参照）。
// 移動系(1-5)を通路の前半で、射撃系(6-10)を射撃線で、
// 2段階操作の難しい物(11-12)を最後に。
//
// **移動系の課題は「やっている時間」ではなく「通路のどこまで進めたか」で見る。**
// 最初は「しゃがみを1.5秒」のような時間で数えていたが、
// その場でキーを押して待つだけでクリアになってしまい、
// 「時間で解決してる感じ」と言われた（2026-08-09）。
// 段差の奥・梁の奥は、跳ばないと・しゃがまないと物理的に辿り着けない地形なので、
// **そこに立っていること自体が「できた」の証明**になる。
// goalZは通路のZ座標（+側で湧いて-側へ進む）。仕掛けの座標と噛み合っているかは
// tools/check-tutorial.mjsが地形を実際に組んで突き合わせる
/* 的に照準を「乗せた」と認める秒数。
   一瞬かすっただけで数えると、マウスを一振りするだけで4枚まとめて緑になって、
   狙いを止める練習にならない。0.25秒は「意識して止めた」と「通り過ぎた」の境 */
const AIM_HOLD_S = 0.25;
// 歩きながらの課題で「足が動いている」と認める速さ(m/s)。歩きは4.7m/s
const MOVE_MIN_SPEED = 1.5;

export const TUTORIAL_STEPS = [
  /* **一番慣れていないのはマウス。** 前は「合計2.5ラジアン動かす」だけで、
     狙う物が無かった。適当に振り回せば終わるので、**何ができれば正解なのかが
     伝わらない**（遊んで「もうちょい上下左右に的を作って、それに合わせないと
     進まないのにしてほしい」と言われた）。
     4枚の的を順に狙わせる形にする。狙えた的は緑になる（tutorial-level.jsのsetAimDone） */
  {
    id: 'look',
    main: 'マウスを動かして、4枚の的に照準を合わせる',
    sub: '上・下・左・右に1枚ずつ。合わせると緑になる',
    aim: ['up', 'down', 'left', 'right'],
  },
  /* 移動キーは1つずつ練習する。まとめて「WASDで歩く」だと、
     Wだけで奥へ着いてクリアになり、A/S/Dを一度も押さないまま進む
     （「それぞれで案内して」と言われた 2026-08-09）。
     Wは通路の位置で、S/A/Dは「そのキーで実際に動けた距離」で見る
     （sprintと同じ理屈: 壁に向かって押しても進まなければ数えない） */
  /* 4方向とも**同じ6m**にしてある。前はWだけ8mで、S/A/Dは2mだった。
     2mは1秒足らずで終わるので「押した」で終わり、**その足で動く感覚が残らない**
     （遊んで「SもAもDもちゃんと何メートルか用意してあげて」と言われた）。
     広場は20m×22mあるので、どこから始めても6m動ける
     （壁に詰まっても、視点を回せばA/Dの向きはついてくる） */
  {
    id: 'move',
    main: 'W で前の線まで歩く',
    sub: 'Wが前。床の水色の線が6m先',
    goal: 6,     // そのキーで動けた距離(m)
  },
  {
    id: 'moveBack',
    main: 'S で後ろの線まで下がる',
    sub: '撃ち合いながら間合いを取る時に使う',
    goal: 6,
  },
  {
    id: 'moveLeft',
    main: 'A で左の線まで動く',
    sub: '左右の動きは弾をかわす基本',
    goal: 6,
  },
  {
    id: 'moveRight',
    main: 'D で右の線まで動く',
    sub: '左右の動きは弾をかわす基本',
    goal: 6,
  },
  /* **歩きながら視点を変える。** ここが一番の山で、前は課題そのものが無かった。
     FPSは「足と手を別々に動かす」ゲームなので、止まって狙う・歩くだけ、を
     別々にできても本編では何もできない。
     的を通路の外の横に置いてあるので、歩いて通り過ぎながら首を振るしかない */
  {
    id: 'lookMove',
    main: '歩きながら、左右の的に照準を合わせる',
    sub: '足を止めずに。止まっている間は数えない',
    aim: ['passL', 'passR'],
    moving: true,
  },
  {
    id: 'sprint',
    main: 'Wで前に進みながら 左Shift で走る',
    sub: '前に進んでいる間だけ。息は3秒で切れて、体力の下の細い棒が戻るとまた走れる',
    goal: 12,    // 走った距離(m)。助走路は28mあるので端まで使い切らない
  },
  /* 滑り込み。**走りの直後に置く。** ここが一番直したかった所で、
     前はしゃがみ（梁）の後ろに置いていた。梁の先は助走が2mしか無く、
     滑るのに要る6.3m/sへ乗る前に土嚢へ着く（「場所が間違ってるでしょ」）。
     今は走りと同じ助走路の続きなので、**走り切ったその足でしゃがみを押せば出る。**

     位置ではなく「1回滑れたか」で見る。どこで滑ってもよいことにしておくと、
     引き返して助走を付け直すのも正解になる（位置で縛ると詰む人が出る） */
  {
    id: 'slide',
    main: '走ったまま Ctrl か C でスライディング',
    sub: 'トップスピードに乗っている時だけ出る。低い姿勢のまま前へ滑り込む',
    goal: 1,     // 回
  },
  /* ナイフは**滑り込みの直後、助走路の上**で持たせる。
     前は梁をくぐった先（持ち替えの後ろ）に置いていて、そこまで来ると
     前は射撃線・後ろは低い梁で、**8m歩く場所がもう残っていなかった**
     （遊んで「もう歩くスペースないタイミングで言われても」と言われた 2026-08-12）。
     助走路は28mあって、走り12m＋滑り6mを使い切ってもまだ10m残る。
     足の速さの違いは走った直後にやるのが一番わかりやすい、という理由でもここがいい。

     持ち替えの課題(switch)は梁の先に置いたまま。あちらは足を使わないので場所が要らず、
     **ライフルへ戻る形で終わるので、撃つ課題へナイフのまま入らない** */
  {
    id: 'knife',
    main: '3 でナイフを持って、そのまま8m歩く',
    sub: 'ナイフは足が速くなる。持ったまま先へ進んでよい',
    goal: 8,     // ナイフを持ったまま動けた距離(m)。速さの違いを体で感じる長さ
  },
  {
    id: 'jump',
    main: 'Space でジャンプして、2つの段差を越える',
    sub: '段の手前で押すと登れる',
    goalZ: -21,  // 2つ目の段(z=-20)の奥。跳ばないと辿り着けない
  },
  {
    id: 'crouch',
    main: 'Ctrl か C でしゃがんで、低い梁をくぐる',
    sub: '押している間だけしゃがむ。走っていなければ滑らない',
    goalZ: -26,  // 梁(z=-24)の奥。しゃがまないと通れない
  },
  /* 持ち替えは**梁の先の開けた所**で、撃つ課題の直前にやる。
     足を使わない課題なので場所は要らないが、ここに置くと
     **ナイフを持ったまま撃つ課題へ入らない**（1でライフルへ戻って終わるため）。
     ナイフは助走路へ移した（理由はslideの下のコメント） */
  {
    id: 'switch',
    main: '2 でピストルに持ち替えて、1 でライフルに戻す',
    sub: '数字キーが武器の番号',
    goal: 1,
  },
  {
    id: 'shoot',
    main: '左クリックで撃ってみる',
    sub: '押しっぱなしで連射できる',
    goal: 5,     // 発
  },
  {
    id: 'ads',
    main: '右クリックで覗き込む。もう一度右クリックで戻す',
    sub: '覗くと狙いが定まる（押しっぱなしではなく、切り替え式）',
    goal: 1,
  },
  {
    id: 'reload',
    main: 'R で弾を入れ替える（リロード）',
    sub: '撃ち合いの前に満タンにしておく',
    goal: 1,
  },
  {
    id: 'target',
    main: '的の兵士を3体倒す',
    sub: '頭に当てると大ダメージ',
    goal: 3,
  },
  {
    id: 'nade',
    // 「投げたら」でなく「倒したら」クリア（2026-08-09。投げるだけだと
    // 爆風がどのくらい効くのかを一度も見ないまま先へ進んでしまう）
    main: '4 で手榴弾。左クリックを押して狙い、離して投げて的を倒す',
    sub: '線は2本出る。水色が左クリック、橙が右クリック（その場で手前へ放る）',
    goal: 1,
  },
  {
    id: 'heal',
    main: 'F で包帯を持ち、左クリックで巻く',
    sub: '左下のゲージが体力。巻き終わると回復する',
    goal: 1,
  },
];

export class TutorialMachine {
  /**
   * @param rifleIndex / pistolIndex / knifeIndex 武器の番号（weapons.carryの中身）。
   *   protocol.jsをここから読まないのは、この機械を「表と判定だけ」に保つため
   */
  constructor({ rifleIndex = 0, pistolIndex = 1, knifeIndex = 2 } = {}) {
    this.rifleIndex = rifleIndex;
    this.pistolIndex = pistolIndex;
    this.knifeIndex = knifeIndex;
    this.reset();
  }

  reset() {
    this.at = 0;          // 今のステップ（TUTORIAL_STEPSの添字）
    this.done = false;
    this._progress = 0;   // 今のステップの進み（累積rad・秒・回数）
    this._phase = 0;      // 2段階もの（ads/switch）の段
    this._entered = false; // 入場時の基準をまだ取っていない
    this._base = 0;       // count系の入場時基準（shots/kills）
    this._prev = null;    // 前フレームのスナップショット（エッジ検出用）
    /* 狙う課題。どの的をもう合わせたか(_hitAim)と、
       今どれに何秒乗っているか(_aimOn / _aimHold)。
       **一瞬かすっただけでは数えない。** 数えると、マウスを一振りするだけで
       4枚まとめて緑になって、狙いを止める練習にならない */
    this._hitAim = new Set();
    this._aimOn = null;
    this._aimHold = 0;
  }

  get step() { return this.done ? null : TUTORIAL_STEPS[this.at]; }

  /** もう合わせた的のid。画で緑にするのに使う（main.jsの_tutorialFrame） */
  get aimHits() { return this._hitAim; }

  /**
   * 毎フレーム呼ぶ。達成して次へ進んだフレームだけ 'advance' を返す。
   * snapは全部プリミティブ:
   *   { dt, yaw, pitch, z, speed, onFloor, sprinting, crouching, sliding,
   *     keyA, keyS, keyD, shots, kills, adsFactor, reloading,
   *     weaponIndex, nadeKilled, healed }
   * zは通路のどこまで進んだか（移動系の課題は位置で判定する）。
   * keyA/S/Dは移動キーを押しているか（そのキーで動けた距離を数える）
   */
  update(snap) {
    if (this.done) return null;
    const s = TUTORIAL_STEPS[this.at];
    const prev = this._prev;
    this._prev = { ...snap };

    /* 入場時の基準取り。count系（shoot/target）は「ステップに入ってからの増分」で
       数える。累積そのものを見ると、先走って的を倒した人のtargetステップが
       入った瞬間に達成になってしまい、課題を1つも読まずに進む。
       **判定を打ち切るのはこの2つだけ。** 全ステップで入場フレームを捨てると、
       1フレームしか立たないフラグ（nadeKilled/healed）が入場と同時に来た時に
       取りこぼして、倒したのに課題が残る */
    if (!this._entered) {
      this._entered = true;
      if (s.id === 'shoot') { this._base = snap.shots; return null; }
      if (s.id === 'target') { this._base = snap.kills; return null; }
    }

    let hit = false;
    switch (s.id) {
      /* 狙う課題(look / lookMove)。表のaimに並んだidを全部合わせたら達成。
         movingが付いている課題は、**足が止まっている間は数えない** */
      case 'look':
      case 'lookMove': {
        const moving = !s.moving || snap.speed > MOVE_MIN_SPEED;
        const on = moving && snap.aimId && s.aim.includes(snap.aimId) ? snap.aimId : null;
        if (on !== this._aimOn) { this._aimOn = on; this._aimHold = 0; }
        if (on) {
          this._aimHold += snap.dt;
          if (this._aimHold >= AIM_HOLD_S) this._hitAim.add(on);
        }
        this._progress = this._hitAim.size;
        hit = s.aim.every((id) => this._hitAim.has(id));
        break;
      }
      /* 位置で見る課題（表の頭のコメント参照）。
         先に奥まで進んでいた人は課題に入った瞬間クリアになるが、それでいい。
         段差の奥に立っている＝跳んだことは地形が保証している */
      case 'jump':
      case 'crouch':
        hit = snap.z <= s.goalZ;
        break;
      /* W/S/A/Dは「そのキーを押しながら動けた距離」。時間でなく距離なのは
         sprintと同じ理由（壁に向かって押しても進まなければ数えない）。
         **Wも位置ではなく距離で見る。** 広場は先へ進む場所ではないので、
         「どこまで行けたか」では測れない */
      case 'move':
        if (snap.keyW) this._progress += snap.speed * snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'moveBack':
        if (snap.keyS) this._progress += snap.speed * snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'moveLeft':
        if (snap.keyA) this._progress += snap.speed * snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'moveRight':
        if (snap.keyD) this._progress += snap.speed * snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'sprint':
        // 走った距離。時間でなく距離なのは、壁に向かって走り続けても
        // 進まなければ「走れた」ことにならないため（speedは実際の移動速度）
        if (snap.sprinting) this._progress += snap.speed * snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'slide':
        // 滑り出した瞬間だけ立つ印。滑っている間ずっと立つので、
        // 見えた時点で達成でよい（何度も滑らせる意味は無い）
        if (snap.sliding) hit = true;
        break;
      case 'knife':
        // ナイフを持ったまま動けた距離。持っただけでは速さの違いが分からない
        if (snap.weaponIndex === this.knifeIndex) this._progress += snap.speed * snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'shoot':
        this._progress = snap.shots - this._base;
        hit = this._progress >= s.goal;
        break;
      case 'ads':
        // 覗き切った(0.8以上)のを見てから、戻し切った(0.15以下)のを見る。
        // 往復まで見るのは、ADSがトグルだから。入れっぱなしで先へ進むと、
        // その後ずっと「なぜか歩きが遅い」まま遊ぶことになる
        if (this._phase === 0 && snap.adsFactor >= 0.8) this._phase = 1;
        if (this._phase === 1 && snap.adsFactor <= 0.15) hit = true;
        break;
      case 'reload':
        // 完了の瞬間＝残り時間が0を跨いだ時。押した瞬間ではなく巻き終わりで
        // 数えるのは、途中でキャンセルできる操作だから
        if (prev && prev.reloading > 0 && snap.reloading <= 0) hit = true;
        break;
      case 'switch':
        // ピストルへ替えたのを見てから、ライフルへ戻ったのを見る
        if (this._phase === 0 && snap.weaponIndex === this.pistolIndex) this._phase = 1;
        if (this._phase === 1 && snap.weaponIndex === this.rifleIndex) hit = true;
        break;
      case 'target':
        this._progress = snap.kills - this._base;
        hit = this._progress >= s.goal;
        break;
      case 'nade':
        // 投げた瞬間ではなく、爆風で的が倒れた瞬間（1フレームの印）
        if (snap.nadeKilled) hit = true;
        break;
      case 'heal':
        if (snap.healed) hit = true;
        break;
      default:
        break;
    }

    if (!hit) return null;
    this.at += 1;
    this._progress = 0;
    this._phase = 0;
    this._entered = false;
    // 狙った的の記録も次の課題へ持ち越さない（lookで合わせた4枚が
    // lookMoveの2枚と混ざると、歩かずにクリアになる）
    this._hitAim.clear();
    this._aimOn = null;
    this._aimHold = 0;
    if (this.at >= TUTORIAL_STEPS.length) this.done = true;
    return 'advance';
  }

  /**
   * 画面に出す文言。残りを整数に丸めて添える。
   * 丸めるのは見やすさだけの話ではなく、値が変わるのが秒に1回程度になるので、
   * HUD側の「同じ文なら書かない」ガードとちょうど噛み合う
   */
  label() {
    const s = this.step;
    if (!s) return { main: '', sub: '' };
    let left = '';
    switch (s.id) {
      case 'jump': case 'crouch': {
        // 目的地までの距離。位置はupdateで見た最後の値から出す
        const z = this._prev?.z;
        if (typeof z === 'number') left = `あと${Math.max(1, Math.ceil(z - s.goalZ))}m先へ`;
        break;
      }
      case 'look': case 'lookMove':
        left = `あと${Math.max(0, s.aim.length - this._hitAim.size)}枚`;
        break;
      case 'move': case 'moveBack': case 'moveLeft': case 'moveRight':
      case 'sprint': case 'knife':
        left = `あと${Math.max(1, Math.ceil(s.goal - this._progress))}m`;
        break;
      case 'shoot':
        left = `あと${Math.max(0, s.goal - this._progress)}発`;
        break;
      case 'target':
        left = `あと${Math.max(0, s.goal - this._progress)}体`;
        break;
      default:
        break;
    }
    return {
      main: `${this.at + 1}/${TUTORIAL_STEPS.length}　${s.main}`,
      sub: left ? `${s.sub}（${left}）` : s.sub,
    };
  }
}
