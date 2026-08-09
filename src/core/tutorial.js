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
export const TUTORIAL_STEPS = [
  {
    id: 'look',
    main: 'マウスを動かして、まわりを見回す',
    sub: '画面の向きはマウスで変わる',
    goal: 2.5,   // ラジアン。ゆっくりでも2〜3秒で届く量
  },
  /* 移動キーは1つずつ練習する。まとめて「WASDで歩く」だと、
     Wだけで奥へ着いてクリアになり、A/S/Dを一度も押さないまま進む
     （「それぞれで案内して」と言われた 2026-08-09）。
     Wは通路の位置で、S/A/Dは「そのキーで実際に動けた距離」で見る
     （sprintと同じ理屈: 壁に向かって押しても進まなければ数えない） */
  {
    id: 'move',
    main: 'W で通路の奥へ歩く',
    sub: 'Wが前。まずは奥へ進む',
    goalZ: 10,   // 湧き(z=18)から8m歩いた所
  },
  {
    id: 'moveBack',
    main: 'S で少し下がる',
    sub: '撃ち合いながら間合いを取る時に使う',
    goal: 2,     // 動けた距離(m)
  },
  {
    id: 'moveLeft',
    main: 'A で左へ動く',
    sub: '左右の動きは弾をかわす基本',
    goal: 2,
  },
  {
    id: 'moveRight',
    main: 'D で右へ動く',
    sub: '左右の動きは弾をかわす基本',
    goal: 2,
  },
  {
    id: 'sprint',
    main: 'Wで前に進みながら 左Shift で走る',
    sub: '前に進んでいる間だけ。息は3秒で切れて、体力の下の細い棒が戻るとまた走れる',
    goal: 10,    // 走った距離(m)。速さ7.4m/sなので1.5秒ほど走れば届く
  },
  {
    id: 'jump',
    main: 'Space でジャンプして、2つの段差を越える',
    sub: '段の手前で押すと登れる',
    goalZ: -2,   // 2つ目の段(z=0)の奥。跳ばないと辿り着けない
  },
  {
    id: 'crouch',
    main: 'Ctrl か C でしゃがんで、低い梁をくぐる',
    sub: '押している間だけしゃがむ',
    goalZ: -6,   // 梁(z=-4)の奥。しゃがまないと通れない
  },
  /* 滑り込み。**走りとしゃがみの両方を教えた後に置く。**
     押すキーはしゃがみと同じで、走っている時だけ意味が変わる操作なので、
     どちらか片方しか知らない状態で出しても「なぜ今だけ違うのか」が伝わらない。

     位置ではなく「1回滑れたか」で見る。梁の先(z=-6)から通路の端(z=-30)まで
     24mあるので走る場所には困らないが、**どこで滑ってもよい**ことにしておくと、
     引き返して助走を付け直すのも正解になる（位置で縛ると詰む人が出る） */
  {
    id: 'slide',
    main: '走りながら Ctrl か C でスライディング',
    sub: 'トップスピードに乗っている時だけ出る。低い姿勢のまま前へ滑り込む',
    goal: 1,     // 回
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
    id: 'switch',
    main: '2 でピストルに持ち替えて、1 でライフルに戻す',
    sub: '数字キーが武器の番号',
    goal: 1,
  },
  {
    id: 'knife',
    main: '3 でナイフを持つと、足が少し速くなる',
    sub: '移動したい時はナイフ。戦う前に 1 か 2 へ戻す',
    goal: 8,     // ナイフを持ったまま動けた距離(m)。速さの違いを体で感じる長さ
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
  }

  get step() { return this.done ? null : TUTORIAL_STEPS[this.at]; }

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
      case 'look': {
        if (prev) {
          this._progress += Math.abs(snap.yaw - prev.yaw) + Math.abs(snap.pitch - prev.pitch);
        }
        hit = this._progress >= s.goal;
        break;
      }
      /* 移動系は位置で見る（表の頭のコメント参照）。
         先に奥まで進んでいた人は課題に入った瞬間クリアになるが、それでいい。
         段差の奥に立っている＝跳んだことは地形が保証している */
      case 'move':
      case 'jump':
      case 'crouch':
        hit = snap.z <= s.goalZ;
        break;
      /* S/A/Dは「そのキーを押しながら動けた距離」。時間でなく距離なのは
         sprintと同じ理由（壁に向かって押しても進まなければ数えない） */
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
      case 'move': case 'jump': case 'crouch': {
        // 目的地までの距離。位置はupdateで見た最後の値から出す
        const z = this._prev?.z;
        if (typeof z === 'number') left = `あと${Math.max(1, Math.ceil(z - s.goalZ))}m先へ`;
        break;
      }
      case 'moveBack': case 'moveLeft': case 'moveRight': case 'sprint': case 'knife':
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
