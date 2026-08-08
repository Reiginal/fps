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
// 達成条件のkind:
//   accum … valueの累積がgoalに達したら
//   time  … 条件を満たしている時間の合計がgoal秒に達したら
//   count … 入場時からの増分（またはエッジの回数）がgoalに達したら
//   phase … 「Aを見た後にB」の2段階（ADSの往復・武器の行き来）
export const TUTORIAL_STEPS = [
  {
    id: 'look',
    main: 'マウスを動かして、まわりを見回す',
    sub: '画面の向きはマウスで変わる',
    goal: 2.5,   // ラジアン。ゆっくりでも2〜3秒で届く量
  },
  {
    id: 'move',
    main: 'W A S D で歩いてみる',
    sub: 'Wが前・Sが後ろ・AとDが横',
    goal: 3.0,   // 歩いている時間の合計（秒）
  },
  {
    id: 'sprint',
    main: 'Wで前に進みながら 左Shift で走る',
    sub: '前に進んでいる間だけ走れる',
    goal: 1.5,
  },
  {
    id: 'jump',
    main: 'Space でジャンプして、段差を越えて進む',
    sub: '段の手前で押すと登れる',
    goal: 2,     // 跳んだ回数
  },
  {
    id: 'crouch',
    main: 'Ctrl か C を押している間しゃがむ',
    sub: '低い梁の下は、しゃがむと通れる',
    goal: 1.5,
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
    id: 'target',
    main: '的の兵士を3体倒す',
    sub: '頭に当てると大ダメージ',
    goal: 3,
  },
  {
    id: 'nade',
    main: '4 で手榴弾。左クリックを押して狙い、離して投げる',
    sub: '押している間、飛んでいく先の線が出る',
    goal: 1,
  },
  {
    id: 'heal',
    main: 'F で包帯を持ち、左クリックで巻く',
    sub: '巻き終わるまで動きが遅くなる。物陰で使う',
    goal: 1,
  },
];

export class TutorialMachine {
  /**
   * @param rifleIndex / pistolIndex 武器の番号（weapons.carryの中身）。
   *   protocol.jsをここから読まないのは、この機械を「表と判定だけ」に保つため
   */
  constructor({ rifleIndex = 0, pistolIndex = 1 } = {}) {
    this.rifleIndex = rifleIndex;
    this.pistolIndex = pistolIndex;
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
   *   { dt, yaw, pitch, speed, onFloor, sprinting, crouching,
   *     shots, kills, adsFactor, reloading, weaponIndex, threw, healed }
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
       1フレームしか立たないフラグ（threw/healed）が入場と同時に来た時に
       取りこぼして、投げたのに課題が残る */
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
      case 'move':
        if (snap.onFloor && snap.speed > 1.0) this._progress += snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'sprint':
        if (snap.sprinting) this._progress += snap.dt;
        hit = this._progress >= s.goal;
        break;
      case 'jump':
        // 跳んだ瞬間＝接地が離れた瞬間。落下でも数えてしまうが、
        // この通路に落ちる場所は無いので跳ぶ以外でここは立たない
        if (prev && prev.onFloor && !snap.onFloor) this._progress += 1;
        hit = this._progress >= s.goal;
        break;
      case 'crouch':
        if (snap.crouching) this._progress += snap.dt;
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
        if (snap.threw) hit = true;
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
      case 'move': case 'sprint': case 'crouch':
        left = `あと${Math.max(1, Math.ceil(s.goal - this._progress))}秒`;
        break;
      case 'jump':
        left = `あと${s.goal - this._progress}回`;
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
