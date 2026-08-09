// プレイヤーの足回り。カプセル形状をOctreeに押し当てて衝突を解決する。
// 加速と摩擦で動かす方式（Quake系）にしてあるので、止まる/曲がるが素直に効く。
//
// 「体重がある」感触は、速度そのものではなく速度の変化（加速度）から作っている。
// 加速度・着地速度・ヨー角速度・姿勢の変化量、この4つを入力にして
// 減衰バネを叩き、その解をカメラの位置と姿勢に足す。
// バネの結果は絶対にcolliderへ戻さない。当たり判定が揺れると撃ち合いが壊れる。
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import { HEAL, HP, healAmount } from '../net/protocol.js';

const GRAVITY = 22;
const STAND_H = 1.74;
const CROUCH_H = 1.06;
const RADIUS = 0.34;
// 足元の床を確かめるだけの小さい球の半径。カプセルより十分細くしないと
// 擦っている壁を拾ってしまい、床を探す意味がなくなる
const PROBE_R = 0.1;

const SPEED_WALK = 4.7;
const SPEED_SPRINT = 7.4;
const SPEED_CROUCH = 2.3;

/* 走れる時間と、切れてから戻るまで。
   遊んで「無限に走れたら、やらない理由がないし」と言われた所。その通りで、
   **速く動けて損が1つも無いなら、常に走るのが最適解になって選択が消える。**
   移動そのものが「押す／押さない」だけの操作になっていた。

   ついでに「PCが熱くなる原因だったりしない？」も測った。**走りは熱の原因ではない。**
   走っている間に増える仕事は、足音の音づくり（歩幅が1.22倍になるので毎秒の回数が増える）と、
   画角が75→84度へ寄る間の投影行列の作り直しくらいで、どちらも1フレームの中では誤差。
   熱くなるのは場面を毎フレーム描くほうで、走る／走らないでそこは変わらない。
   なので**これは軽くするための変更ではなく、選択を作るための変更**。

   3.0秒はユーザーの提案そのまま。戻りを2.4秒にしてあるのは、
   使い切ってから全快までが「走った時間より少し短い」と、
   逃げ切れなかった時に次の機会がすぐ来て、追われている感じが続くため */
const SPRINT_MAX_S = 3.0;
const SPRINT_REFILL_S = 2.4;
// 走るのをやめてから溜まり始めるまでの間。これが無いと、
// 小刻みに押し直すだけで実質無限に走れる（1フレームごとに満タンへ戻る）
const SPRINT_REST_S = 0.5;
// 押した瞬間に足が出る硬さ。低いと最高速まで半歩ぶん流れて、
// 入力より体が遅れて動くぶんが全部「滑り」として伝わる
const ACCEL_GROUND = 20;
// 走りは加速を落として「乗るのに時間がかかる」感じを出す。
// ただし摩擦に負けると最高速に届かなくなるので下げすぎない
const ACCEL_SPRINT = 5.2;
const ACCEL_AIR = 3.0;
// 空中で速さは変えずに向きだけ寄せる強さ。無いと跳んだ瞬間に操作不能で不快、
// 大きいと空中で曲がり放題になって重さが消える
const AIR_STEER = 0.9;
// 入力を押している間の摩擦。加速は step = min(accel*wishSpeed*dt, 目標との差) なので、
// ここを上げると摩擦が加速の頭打ちを超えて最高速そのものが下がる。だから触らない
const FRICTION = 9.5;
// 入力を離した瞬間だけ効かせる摩擦。「押してる分だけ動く」はここで決まる。
// 押している間と離した瞬間を分けてあるので、最高速を削らずに惰性だけ短くできる
const FRICTION_STOP = 22;
// 走っている間の摩擦倍率。止まるのに滑るのは走りの重さそのもの
const SPRINT_FRICTION = 0.42;
// 走りから止まる時の倍率。歩きは足で踏ん張れるが走りは体重が乗っていて止まれない、
// という差をここで作る。_sprintHoldが抜けるまで効くので離した後もしばらく滑る
const SPRINT_STOP_FRICTION = 0.34;
const JUMP_VEL = 6.6;
// しゃがみジャンプの倍率。縮こまった姿勢から伸び上がるので立ち跳びより低い。
// 0.82だと段差の乗り越えには足りるが、立ち跳びの代わりにはならない
const CROUCH_JUMP_MUL = 0.82;

/* ------------------------------------------------------ スライディング */

/* 走ってトップスピードに乗っている時にしゃがみを押すと、前へ滑り込む。
   Valorantのネオンの動きが元ネタ。

   **これは「速い移動手段」ではなく「速さを一度だけ現金化する操作」。**
   滑っている間は加速も方向転換もほぼ効かず、行き先を先に決めて飛び込む形になる。
   だから曲がり角へ体を投げ込む・遮蔽の裏へ滑り込む、のような使い方に寄る。
   もし「歩くより滑るほうが速い」状態にすると、走りに息を付けた時と同じで
   常に滑るのが最適解になって、また選択が消える。だから息を消費させて、
   終わった後にしばらく滑れない時間を置いてある。

   数字の根拠:
   ・滑り出し11.2は走り7.4の1.51倍。速いのは一瞬だけなので、
     移動距離では走り続けたほうが速い（0.86秒で終わる）
   ・摩擦1.2は「11.2から4.0まで落ちるのに0.86秒かかる」量。進む距離は約6.0m。
     ここを上げると滑らずに転ぶだけになる

   **「走り続けたほうが遠い」は必ず守ること。** 同じ0.86秒を走ると6.36m進むので、
   滑りは0.36mだけ損をする。ここが逆転した瞬間に「常に滑るのが最適解」になって、
   走る／滑るの選択が消える（走りに息を付けた時と同じ話）。
   速さと距離を伸ばす時は、必ずこの差が残っているかを見る
   （tools/check-slide.mjs の [3] が毎回測っている） */

// 滑り出せる最低速度。歩き(4.7)からは絶対に出ない。走りの最高速7.4の85%
const SLIDE_MIN_SPEED = 6.3;
/* 滑り出しの速さ。走り(7.4)の1.51倍。
   10.2から上げた。遊んで「ほんの少しだけ速さと距離を伸ばして」と言われた所で、
   飛び込む距離が5.1mだと通路1本を渡り切る手前で止まっていた */
const SLIDE_SPEED = 11.2;
/* 滑っていられる最長。過ぎたら普通のしゃがみへ戻る。
   **普段はここまで届かない。** 下のSLIDE_END_SPEEDに先に当たって0.86秒で終わる。
   ここは「摩擦が効かない床に乗った時でも、いつかは終わる」ための上限 */
const SLIDE_TIME_S = 0.90;
// ここまで遅くなったら終わる。止まりかけを滑りと呼ばない
const SLIDE_END_SPEED = 4.0;
// 滑っている間の摩擦。走りの摩擦(9.5*0.42)より桁で弱い
const SLIDE_FRICTION = 1.2;
// 滑りながら向きを変えられる強さ。速さは変えずに向きだけ寄せる。
// 大きいと滑りながら自由に曲がれてしまい、行き先を先に決める操作でなくなる
const SLIDE_STEER = 2.2;
// 終わってから次に滑れるまで
const SLIDE_COOLDOWN_S = 1.1;
/* 1回ぶんの息。**ほとんど取らない。**

   元は0.34（走り1秒ぶん）にしていたが、滑るには先に6.3m/sまで走る必要があるので、
   **1回滑るのに走りの3秒のうち2秒を払う**ことになっていた。実測すると
   「1.5秒走る→滑る→また走る」で滑り終わりの1秒後に息が尽き、
   7.4m/sから4.7m/sへ落ちてそこから3秒走れない。
   2.5秒走ってから滑ろうとすると、息が足りずにそもそも滑れなかった。

   遊ぶ側からは**「滑ったあと止まる」**としか見えない。
   一番使いたい「走って詰めて滑り込む」が、一番できない形になっていた。

   連打の歯止めは息ではなく待ち時間(SLIDE_COOLDOWN_S)が持っている。
   滑り終わりの4.0m/sから6.3m/sまで走り直すのに約0.5秒かかるので、
   待ち1.1秒と合わせて1回あたり2秒近く空く。息まで取る必要が無い */
const SLIDE_STAMINA = 0.10;

/* ------------------------------------------------------------ 落下ダメージ */

// これより速く地面に当たると痛い。m/s。
// 自力のジャンプ(JUMP_VEL 6.6)で落ちてくる速さがちょうど6.6なので、
// そこを超える12から始める。平地で跳ねているだけでは絶対に減らない
const FALL_SAFE_SPEED = 13;
// 即死する落下速度。18m/s＝約16mの高さ。場内で一番高い面が18.1mなので、
// 屋上から地面へ直に落ちるとほぼ死ぬ
const FALL_LETHAL_SPEED = 20;
// 乗り越えられる段差。土嚢1段(0.55)に乗れる高さにしてある
const STEP_HEIGHT = 0.58;
// 床から離れた直後の跳躍猶予と、着地直前の入力の取り置き。
// どちらも無いと縁で跳べずに落ちて、操作が下手に感じる
const COYOTE = 0.12;
const JUMP_BUFFER = 0.12;

// 1歩あたりの歩幅。歩調を時間ではなく進んだ距離で刻むための基準になる。
// 時間で刻むと減速中も同じテンポで足が動き続けて、足だけ空回りする氷の上になる
const STRIDE_WALK = 0.92;
// 走りは歩幅を伸ばす。歩きの早回しではなく一歩が大きいから走りに見える
const STRIDE_SPRINT = 1.22;
const STRIDE_CROUCH = 0.66;

// 反動のうち、指を離しても戻らずに狙点そのものへ残る割合。
// 全部が戻る作りだと、8発目で跳ねが平衡に達したあとは30発目まで狙点が同じ位置に
// 座ったままになり、撃った事が次の1発に一切影響しない＝連射に代償が生まれない。
// 1発ぶんの跳ね上がり量は変えていない（戻る分と残る分に割っただけ）ので、
// 撃った瞬間に画が動く量は今までと同じまま、連射だけが上へ流れる
// 反動のうち狙点に残る割合。0.5だと8発で敵の身長ぶん(20m先で170cm)上を
// 狙った状態が固定されて、弾倉を撃ち切っても1人も倒せなくなる。
// 連射の代償は残しつつ、狙い直しで取り返せる量に落とす
const RECOIL_KEEP = 0.22;

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 減衰バネ。kick()で衝撃を積むと一度行き過ぎてから戻る。
// damp()だと目標へ滑らかに寄るだけで「行き過ぎ」が出ず、軽い体に見えてしまう
class Spring {
  constructor(k, c) {
    this.x = 0;
    this.v = 0;
    this.k = k;
    this.c = c;
    this.target = 0;
  }

  kick(a) { this.v += a; }

  step(dt) {
    // この解き方は1回の刻み幅が大きすぎると振れ幅が増えて発散する。
    // 一番硬い_sStep(k=260, c=24)は0.083秒(12fps)で崩れ、main.js側はdtを
    // 0.1秒まで許しているので、刻みを0.02秒以下に割ってから解く。
    // 60fps時はdt=0.0167で1回のまま、つまり今までと同じ動きになる
    const steps = Math.max(1, Math.ceil(dt / 0.02));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.v += ((this.target - this.x) * this.k - this.v * this.c) * h;
      this.x += this.v * h;
    }
  }

  reset() { this.x = 0; this.v = 0; this.target = 0; }
}

export class Player {
  constructor(camera, level) {
    this.camera = camera;
    this.octree = level.octree;
    this.bounds = level.bounds;

    this.height = STAND_H;
    this.collider = new Capsule(new THREE.Vector3(), new THREE.Vector3(), RADIUS);
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.onFloor = false;
    this.crouching = false;
    this.sprinting = false;
    /* 走れる息の残り（0〜1）。0で切れて、満タンに戻るまで走り直せない。
       staminaLockがその「戻るまで走れない」の鍵で、_sprintRestは
       走るのをやめてから溜まり始めるまでの間 */
    this.stamina = 1;
    this.staminaLock = false;
    this._sprintRest = SPRINT_REST_S;
    /* 滑り込み。slidingが今まさに滑っているか、_slideTが残り秒数、
       _slideCdが次に滑れるまでの待ち。_slideLeanは見た目の傾きだけに使う。
       _slideKeyHeldは「滑り出しに使ったしゃがみを、まだ離していない」印 */
    this.sliding = false;
    this._slideT = 0;
    this._slideCd = 0;
    this._slideLean = 0;
    this._slideKeyHeld = false;
    // 滑り出した瞬間に1回だけ呼ぶ。音を鳴らすのは呼ばれた側の仕事
    this.onSlide = null;
    this.adsFactor = 0;      // 外から武器が書き込む 0..1
    // 持っている武器から入る移動速度の倍率。武器側が毎フレーム書き込む
    this.moveMul = 1;
    // 覗いている間に視点の効きを落とす量。これも武器側が毎フレーム書き込む。
    // 既定の0.45は「覗くと感度55%」の意味で、狙撃銃だけここが大きい
    this.adsSlow = 0.45;

    /* 体力を100から130へ。武器のダメージ表は触らない。
       ライフルは胴27なので4発→5発、SMGは18で6発→8発になり、
       撃ち合いが「先に当てたほうが勝ち」から「当て続けたほうが勝ち」へ寄る。
       頭は倍率が乗るので、狙える人の速さは落としすぎない。

       ここに入るのは1人用の値。**対戦は倍**で、入る時に外から書き換える
       （main.jsの_joinMatchとserver/sim.jsのSimPlayer）。理由はprotocol.jsのHP */
    this.health = HP.SOLO;
    this.maxHealth = HP.SOLO;
    this.alive = true;
    // 包帯。巻いている残り秒数と、持っている数
    this.healing = 0;
    // 巻き終わった直後だけ立つ印。対戦で「巻いている」意思をサーバーへ
    // 送り続ける時間を、通信の遅れぶん引き伸ばすために使う
    this.healHold = 0;
    this.bandages = HEAL.PER_ROUND;
    this.onHealDone = null;
    this.onHealCancel = null;

    // 見た目の揺れ（当たり判定には一切影響させない）
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.roll = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;

    // 着地の沈み / 踏み込みの衝撃 / 姿勢変化の勢い
    this._dip = new Spring(190, 22);
    this._sStep = new Spring(260, 24);
    this._sPosture = new Spring(150, 13);
    // 前後の傾き（前のめり・後ろ残り）と左右の振られ
    this._sPitch = new Spring(110, 12);
    this._sRoll = new Spring(120, 13);
    // 体に対するカメラの遅れ。前後方向と左右方向で別々に効かせる
    this._sOffF = new Spring(170, 17);
    this._sOffR = new Spring(150, 15);
    this._springs = [
      this._dip, this._sStep, this._sPosture,
      this._sPitch, this._sRoll, this._sOffF, this._sOffR,
    ];

    this.onFootstep = null;
    this.onLand = null;
    this.onFallDamage = null;

    this._probe = new Capsule(new THREE.Vector3(), new THREE.Vector3(), PROBE_R);
    this._wish = new THREE.Vector3();
    this._step = new THREE.Vector3();
    this._saveS = new THREE.Vector3();
    this._saveE = new THREE.Vector3();
    this._move = { x: 0, z: 0 };

    this._prevOnFloor = true;
    this._fallSpeed = 0;
    this._airTime = 0;
    this._jumpBuffer = 0;
    this._wantCrouch = false;
    // 立とうとしたが頭がつかえた。低い天井の下で足の速さを決めるのに要る
    this._headBlocked = false;
    this._postureArm = 0;
    this._sprintHold = 0;    // 摩擦と旋回の鈍さに使う（ゆっくり抜ける）
    this._sprintLean = 0;    // 走りの前傾（狙いに響くので速く抜ける）
    this._wasMoving = false;
    this._prevSpeed = 0;
    this._prevWishX = 0;
    this._prevWishZ = 0;
    this._accX = 0;
    this._accZ = 0;
    this._strafeRoll = 0;
    this._stepSmooth = 0;    // 段差で持ち上がった分。カメラだけ遅れて追いつく

    this.teleport(level.playerSpawn);
  }

  teleport(pos) {
    this.collider.start.set(pos.x, pos.y + RADIUS, pos.z);
    this.collider.end.set(pos.x, pos.y + this.height - RADIUS, pos.z);
    this.velocity.set(0, 0, 0);
    this._resetView();
  }

  // 死亡直前の傾きや揺れを持ち越さない
  _resetView() {
    for (let i = 0; i < this._springs.length; i++) this._springs[i].reset();
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.roll = 0;
    this._strafeRoll = 0;
    this._stepSmooth = 0;
    this._accX = 0;
    this._accZ = 0;
    this._sprintHold = 0;
    this._sprintLean = 0;
    // 滑っている最中に湧き直したら、湧いた先で滑り続けないように畳む
    this.sliding = false;
    this._slideT = 0;
    this._slideCd = 0;
    this._slideLean = 0;
    this._slideKeyHeld = false;
    this._wasMoving = false;
    this._prevSpeed = 0;
    this._fallSpeed = 0;
    this._airTime = 0;
    this._jumpBuffer = 0;
  }

  get position() {
    return this.collider.end;
  }

  get feetY() {
    return this.collider.start.y - RADIUS;
  }

  // 水平速度。HUDと頭の揺れの強さに使う
  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  // 着地の沈み量（見た目だけ）
  get landDip() {
    return this._dip.x;
  }

  /**
   * 包帯を巻き始める。巻いている間は遅くなり、撃つか被弾すると中断する。
   * 中断した回は数を消費しない（撃たれ得にしない）
   */
  startHeal() {
    if (!this.alive) return false;
    if (this.healing > 0) return false;
    if (this.bandages <= 0) return false;
    if (this.health >= this.maxHealth) return false;
    this.healing = HEAL.TIME_S;
    return true;
  }

  /**
   * ラウンドの頭と湧き直しで戻す物。
   *
   * 体力・包帯・巻いている途中の状態をまとめて1か所にしてあるのは、
   * 前は呼ぶ側が3行ずつ手で書いていて、湧き直しの経路で書き漏れていたから。
   * 実際、死んで再開しても包帯が0のままだった。
   * 対戦ではもっと悪く、サーバー側は2本に戻すのに手元だけ0のままで、
   * Fを押しても手元が断って、一生使えない状態になっていた
   */
  refill() {
    this.health = this.maxHealth;
    this.alive = true;
    // 息も戻す。湧いた所で切れたままだと、最初の数秒だけ走れない体で始まる
    this.stamina = 1;
    this.staminaLock = false;
    this.bandages = HEAL.PER_ROUND;
    this.healing = 0;
    this.healHold = 0;
  }

  /** 巻くのをやめる。撃った時・被弾した時・持ち替えた時に呼ぶ */
  cancelHeal() {
    if (this.healing <= 0) return;
    this.healing = 0;
    // 中断は即座に相手へ伝える。ここで印を残すと、対戦相手側の
    // サーバーが中断に気づかず回復だけ通ってしまう
    this.healHold = 0;
    this.onHealCancel?.();
  }

  damage(amount) {
    if (!this.alive) return;
    // 撃たれたら巻くのを中断する。撃ち合いながら回復できると、
    // 遮蔽へ下がる判断そのものが要らなくなる
    this.cancelHeal();
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
  }

  _collide() {
    const hit = this.octree.capsuleIntersect(this.collider);
    this.onFloor = false;
    if (!hit) return;
    // 壁ずりで速度を削る前に見ておく。削る向きに上向き成分があると
    // 落ちている最中でもvelocity.yが正に化けて、下の足元探しが素通りする
    const falling = this.velocity.y <= 0;
    // 法線が上向きなら床。そうでなければ壁や天井なので、
    // めり込む方向の速度成分だけ削って壁ずりを起こす
    this.onFloor = hit.normal.y > 0.35;
    if (!this.onFloor) {
      this.velocity.addScaledVector(hit.normal, -hit.normal.dot(this.velocity));
    } else if (this.velocity.y < 0) {
      this.velocity.y = 0;
    }
    this.collider.translate(hit.normal.multiplyScalar(hit.depth));
    // 押し戻しは触れている面を全部まとめた1本のベクトルで返ってくるので、床に立った
    // まま壁を押すと横成分が勝って床を見失う。落ちている時だけ足元をもう一度探す。
    // 見失うと摩擦も足音も止まり、壁に肩を当てて走ると速いという抜け道になる
    if (!this.onFloor && falling && this._floorUnderFoot()) {
      this.onFloor = true;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
  }

  // 足裏のすぐ下だけを見る小さい球。カプセルの半径より内側に置いてあるので、
  // 体が擦っている壁には届かず、床だけを拾う
  _floorUnderFoot() {
    const y = this.collider.start.y - RADIUS + PROBE_R;
    this._probe.start.set(this.collider.start.x, y - 0.02, this.collider.start.z);
    this._probe.end.set(this.collider.start.x, y + 0.01, this.collider.start.z);
    const hit = this.octree.capsuleIntersect(this._probe);
    return !!hit && hit.normal.y > 0.35;
  }

  _tryHeight(target) {
    const before = this.height;
    if (target > before) {
      // 立ち上がる前に頭上の余裕を確認する。無ければしゃがんだまま
      this.height = target;
      this.collider.end.y = this.collider.start.y - RADIUS + target - RADIUS;
      const hit = this.octree.capsuleIntersect(this.collider);
      if (hit && hit.normal.y < -0.3) {
        this.height = before;
        this.collider.end.y = this.collider.start.y - RADIUS + before - RADIUS;
        return false;
      }
    } else {
      this.height = target;
      this.collider.end.y = this.collider.start.y - RADIUS + target - RADIUS;
    }
    return true;
  }

  _restoreCollider() {
    this.collider.start.copy(this._saveS);
    this.collider.end.copy(this._saveE);
  }

  // 低い縁の乗り越え。カプセルの滑りに任せると土嚢や板の端で必ず引っかかるので、
  // 「持ち上げる→前に出す→着地させる」を1フレームで済ませる。
  // 進もうとしたのに進めなかったフレームだけ呼ぶので、平常時の負荷は増えない
  _tryStepUp(dx, dz, remain) {
    const c = this.collider;
    this._saveS.copy(c.start);
    this._saveE.copy(c.end);
    // 縁の上に足裏が完全に乗る分だけ前に出す。短いと縁に引っ掛かったままになる
    const probe = clamp(remain + 0.1, 0.16, 0.42);

    c.translate(this._step.set(0, STEP_HEIGHT, 0));
    if (this.octree.capsuleIntersect(c)) {   // 頭上が塞がっている
      this._restoreCollider();
      return false;
    }

    c.translate(this._step.set(dx * probe, 0, dz * probe));
    if (this.octree.capsuleIntersect(c)) {   // 段ではなく本物の壁
      this._restoreCollider();
      return false;
    }

    // 下ろして段の天面に乗せる。空振りしたら段ではなく穴なので元に戻す
    const n = 6;
    const drop = (STEP_HEIGHT + 0.04) / n;
    for (let i = 0; i < n; i++) {
      c.translate(this._step.set(0, -drop, 0));
      const hit = this.octree.capsuleIntersect(c);
      if (!hit) continue;
      if (hit.normal.y < 0.5) break;         // 斜面や壁の側面には乗せない
      c.translate(hit.normal.multiplyScalar(hit.depth));
      const lift = c.start.y - this._saveS.y;
      if (lift <= 0.001) break;              // 上がっていないなら意味がない
      this._stepSmooth = Math.min(STEP_HEIGHT, this._stepSmooth + lift);
      if (this.velocity.y < 0) this.velocity.y = 0;
      this.onFloor = true;
      this._airTime = 0;
      this._sStep.kick(-lift * 1.2);         // 段を上がる時の踏ん張り
      return true;
    }

    this._restoreCollider();
    return false;
  }

  /**
   * 滑れるなら滑り出す。しゃがみを押し下げた瞬間にだけ呼ばれる。
   *
   * 条件を絞っているのは、**しゃがみが今まで通り使えることのほうが大事**だから。
   * 立ち止まってしゃがむ・歩きながらしゃがむ・覗きながらしゃがむは全部これまで通りで、
   * 「走ってトップスピードに乗っている時」だけが滑りに化ける。
   * 条件をどれか1つでも緩めると、隠れようとしてしゃがんだのに前へ飛び出す事故が起きる
   */
  _trySlide() {
    if (!this.alive || this.sliding) return false;
    if (this._slideCd > 0) return false;
    // 前のフレームの走り。しゃがみを押した瞬間はまだ身長が縮んでいないので、
    // この時点のsprintingは「押す直前まで走っていたか」を正しく表している
    if (!this.sprinting) return false;
    if (!this.onFloor && this._airTime >= COYOTE) return false;
    const sp = this.horizontalSpeed;
    // 走りのキーを押した直後の、まだ加速中の状態では滑らせない。
    // 走り出しと同時にしゃがめる形にすると、走る意味そのものが薄くなる
    if (sp < SLIDE_MIN_SPEED) return false;
    if (this.stamina < SLIDE_STAMINA) return false;

    this.sliding = true;
    this._slideT = SLIDE_TIME_S;
    // この押し下げは滑りに使い切った。離すまでしゃがみには数えない
    this._slideKeyHeld = true;
    this.stamina = Math.max(0, this.stamina - SLIDE_STAMINA);
    // 今進んでいる向きへそのまま加速する。視点の向きではなく速度の向きに乗せるのは、
    // 滑り出しで体が横へワープしたように見えるのを避けるため
    const k = SLIDE_SPEED / sp;
    this.velocity.x *= k;
    this.velocity.z *= k;
    // 腰を落として前へ突っ込む。当たり判定には一切効かない見た目だけの衝撃
    this._dip.kick(-2.4);
    this._sStep.kick(-0.8);
    this.onSlide?.();
    return true;
  }

  /** 滑りを畳んで、次に滑れるまでの待ちを置く */
  _endSlide() {
    if (!this.sliding) return;
    this.sliding = false;
    this._slideT = 0;
    this._slideCd = SLIDE_COOLDOWN_S;
  }

  // バネは硬いので重いフレームで一気に積むと発散する。0.02秒ずつに割って解く
  _stepSprings(dt) {
    const n = Math.min(5, Math.max(1, Math.ceil(dt / 0.02)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < this._springs.length; j++) this._springs[j].step(h);
    }
  }

  update(dt, input, lookEnabled = true, jumpQueued = false) {
    const prevYaw = this.yaw;

    if (lookEnabled) {
      const look = input.takeLook();
      /* 覗き込み中は感度を落とす。これが無いとADSで狙いが定まらない。
         落とす量は武器が決める（adsSlow）。倍率の高い照準ほど、同じ手の動きで
         景色が速く流れるので、狙撃銃だけ0.72＝感度28%まで落としてある */
      const scale = 1 - this.adsFactor * (this.adsSlow ?? 0.45);
      this.yaw += look.yaw * scale;
      this.pitch = clamp(this.pitch + look.pitch * scale, -1.5, 1.5);
    } else {
      input.takeLook();
    }

    // 視点の角速度。曲がった時に体が外へ振られる量の元になる
    let dYaw = this.yaw - prevYaw;
    if (dYaw > Math.PI) dYaw -= Math.PI * 2;
    if (dYaw < -Math.PI) dYaw += Math.PI * 2;
    const yawRate = clamp(dYaw / Math.max(dt, 1e-4), -6, 6);

    if (!this.alive) {
      this.velocity.set(0, this.velocity.y, 0);
    }

    /* ---------------------------------------------------- しゃがみ */
    /* しゃがみはCtrl・C・Command。対戦側の割り当て(protocol.jsのKEY_CODES)と揃えてある。
       MetaはMacのCommandで、左手の小指がCtrlより自然に届く。

       **一度Commandを外したが、戻した。** 外した理由は「Commandを離すと棒立ちになる」で、
       それ自体は本当に起きていた（実測v=0）。ただし原因はCommandの側ではなく、
       input.jsがCommandのkeyupで**修飾キーまで含めて全部落としていた**ことだった。
       そちらを直したので、ここは元に戻してよい（詳しくはsrc/core/input.jsのkeyup） */
    const crouchKey = this.alive && (input.down('ControlLeft') || input.down('KeyC')
      || input.down('MetaLeft') || input.down('MetaRight'));
    this._slideCd = Math.max(0, this._slideCd - dt);
    /* **滑り出しに使った押し下げを、滑り終わった後まで持ち越さない。**

       滑るのに押したしゃがみは、指を離す理由が無いので押しっぱなしになる。
       そのまま数えていると、滑り終わった瞬間にしゃがみ歩き(2.3m/s)へ落ちて、
       走り出そうとしても動けない。実測すると滑り終わりの4.3m/sから
       2.3へ落ちてそこに張り付いた。**遊んでいる側には「なんか止まる」としか見えない。**

       1回の押し下げは1つの操作。滑りに使ったらそこで使い切りにして、
       一度離すまでは「しゃがみたい」に数えない。
       滑ったまま低い姿勢で居たい時は、離して押し直せば今まで通りしゃがめる */
    if (this._slideKeyHeld && !crouchKey) this._slideKeyHeld = false;
    const wantCrouch = crouchKey && !this._slideKeyHeld;
    if (wantCrouch !== this._wantCrouch) {
      this._wantCrouch = wantCrouch;
      // 到着した時に行き過ぎさせる向き。滑っている最中の切り替わりでは付けない
      // （上のラッチで滑り出した次の刻みに必ず1回落ちるので、そこで
      //   「立ち上がる」向きの勢いが入って、滑りの最中に頭が跳ねる）
      if (!this.sliding) this._postureArm = wantCrouch ? -1 : 1;
      /* しゃがみを押し下げた瞬間だけ、滑れるかを見る。
         押し下がりをここで拾うのは、しゃがみのキーが4つ(Ctrl/C/Command左右)あって、
         input.pressed()を1つずつ見ると押し方によって取りこぼすため。
         この_wantCrouchの立ち上がりなら、どのキーで押しても同じ1回になる。
         **サーバー側も同じ判定を通る**（ServerInputもdown()を返すので） */
      if (wantCrouch) this._trySlide();
    }
    // 滑っている間はしゃがみの姿勢に固定する。キーを離しても滑りは続く
    // （離した瞬間に立ち上がると、滑り終わりが毎回ぶれて操作の手応えが読めない）
    const targetH = (wantCrouch || this.sliding) ? CROUCH_H : STAND_H;
    if (Math.abs(this.height - targetH) > 0.001) {
      // 沈むのは速く、立つのは遅い。左右対称だと機敏すぎて体重が消える
      const rate = targetH < this.height ? 20 : 12;
      // 立てなかった（頭がつかえた）かどうかを覚えておく。下の足の速さで要る
      this._headBlocked = !this._tryHeight(THREE.MathUtils.damp(this.height, targetH, rate, dt));
    }
    if (this._postureArm !== 0 && Math.abs(this.height - targetH) < 0.1) {
      // 体が止まる瞬間に頭だけ勢いで行き過ぎ、戻ってから収まる。
      // 単純な補間だと目標にぴたりと張り付いて、頭に重さが無いように見える
      this._sPosture.kick(this._postureArm * 1.35);
      this._postureArm = 0;
    }
    this.crouching = this.height < (STAND_H + CROUCH_H) / 2;
    /* **足が縛られるのは「しゃがんでいる間」ではなく「しゃがみ続けたい間」。**

       身長だけで見ていると、立ち上がっている途中の数フレームもしゃがみ扱いになり、
       そこで摩擦がしゃがみの速さ(2.3)まで削りにいく。立とうとしているのに
       足だけ止められるので、滑り終わりに4.3→2.8まで一度落ちてから戻っていた
       （普通のしゃがみを解いた時にも同じ引っ掛かりが出ていた）。
       低い姿勢のまま歩きの速さで動ける時間が0.06秒できるが、悪用できる長さではない。

       **ただし頭がつかえて立てない時は別。** 低い天井の下（階段の裏・配管の下）で
       しゃがみを離すと、意思は「立ちたい」なのに身長は縮んだままになる。
       そこを速い側に倒すと、**判定が低いまま走れる場所**ができてしまう。
       0.06秒では済まず、その場所に居る限りずっと続く */
    const crouchSlow = this.crouching && (this._wantCrouch || this._headBlocked);

    /* ------------------------------------------------------ 移動入力 */
    const m = input.moveVector(this._move);
    const moving = this.alive && (m.x !== 0 || m.z !== 0);
    /* 走りは息が続く間だけ。**切れたら全快するまで走り直せない。**
       半分だけ戻った所で走り出せる形にすると、押し直すのが最適解になって
       「息が切れた」という状態が事実上消える（走る／歩くの判断も戻らない） */
    const wantSprint = this.alive && moving && m.z < -0.1 && input.down('ShiftLeft')
      && !crouchSlow && this.adsFactor < 0.5;
    if (this.staminaLock && this.stamina >= 1) this.staminaLock = false;
    this.sprinting = wantSprint && !this.staminaLock;
    // 滑っている間は「走り」ではない。ここを立てたままにすると、
    // 画面の走りの印も画角も武器の下げ方も走り扱いのままになり、
    // 滑っているのに走って見える（撃てるのに撃てない絵になる）
    if (this.sliding) this.sprinting = false;

    if (this.sprinting) {
      this._sprintRest = 0;
      this.stamina = Math.max(0, this.stamina - dt / SPRINT_MAX_S);
      // 使い切った瞬間に鍵をかける。ここから先は満タンになるまで走れない
      if (this.stamina <= 0) { this.staminaLock = true; this.sprinting = false; }
    } else {
      this._sprintRest = Math.min(SPRINT_REST_S, this._sprintRest + dt);
      if (this._sprintRest >= SPRINT_REST_S) {
        this.stamina = Math.min(1, this.stamina + dt / SPRINT_REFILL_S);
      }
    }

    // 走りの「効き」は入切より遅らせる。抜けきるまで滑るのが走りの重さ
    this._sprintHold = this.sprinting
      ? Math.min(1, this._sprintHold + dt * 2.2)
      : Math.max(0, this._sprintHold - dt * 1.6);
    // 前傾は狙いに直接響くので、こちらは素早く戻す
    this._sprintLean = THREE.MathUtils.damp(this._sprintLean, this.sprinting ? 1 : 0, 8, dt);
    // 滑りの傾き。入るのは速く、戻るのは遅い。滑り終わってからも
    // 少しだけ体が起き上がりきらない残り方をするほうが、立ち上がりに重さが出る
    this._slideLean = THREE.MathUtils.damp(
      this._slideLean, this.sliding ? 1 : 0, this.sliding ? 14 : 6, dt,
    );

    // 武器ごとの倍率。短剣は銃を下ろすぶん身軽で速い。
    // 持たない武器はmoveMulを書いていないので、その時は1として扱う
    // 包帯を巻いている間は遅くなる。速いまま巻けると、下がりながら回復できて
    // 「遮蔽に入って巻く」という判断が消える
    let wishSpeed = (crouchSlow ? SPEED_CROUCH : this.sprinting ? SPEED_SPRINT : SPEED_WALK)
      * (this.moveMul || 1) * (this.healing > 0 ? HEAL.SLOW : 1);
    wishSpeed *= 1 - this.adsFactor * 0.35;
    if (!this.alive) wishSpeed = 0;

    // 入力をヨー基準のワールド方向に変換（ピッチは移動に効かせない）
    // ヨー0のとき前方は -Z、右は +X。W(m.z=-1)で -Z に進むこと
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const wish = this._wish.set(
      m.x * cos + m.z * sin,
      0,
      -m.x * sin + m.z * cos,
    );
    if (wish.lengthSq() > 0) wish.normalize();

    /* -------------------------------------------------- 摩擦と加速 */
    // 傾きの元になる加速度は、摩擦と入力だけから測る。
    // 衝突で削られた分まで混ぜると壁際で毎フレーム暴れて見苦しい
    const preX = this.velocity.x, preZ = this.velocity.z;

    // 摩擦・加速・足の動きに使う接地判定。縁や瓦礫の上では接地が1〜2フレームだけ
    // 落ちることがあり、素のonFloorで見るとそのたびに摩擦が抜けて足も止まる。
    // 跳躍と同じ猶予でつないで、地面の上にいる間は途切れさせない。
    // 跳んだ瞬間は_airTimeがCOYOTEで埋まるので、跳躍の慣性はここに入らない
    const grounded = this.onFloor || this._airTime < COYOTE;

    if (this.sliding) {
      /* 滑っている間は、摩擦も加速も普段と別物にする。
         普段の摩擦は「押している間は弱く、離した瞬間に強い」だが、
         滑りは押していようがいまいが同じ速さで減っていくのが正しい
         （体が地面を擦っているだけで、足で踏ん張っていないので） */
      this._slideT -= dt;
      const speed = this.horizontalSpeed;
      const drop = speed * SLIDE_FRICTION * dt;
      const factor = Math.max(speed - drop, 0) / Math.max(speed, 1e-6);
      this.velocity.x *= factor;
      this.velocity.z *= factor;
      /* 向きだけ少し寄せる。速さは変えないので、曲がっても得はしない。
         **ここで使う速さは摩擦をかけた後の値。** 上のspeedを使い回すと、
         向きを直した後に摩擦をかける前の長さへ戻してしまい、
         滑りが1ミリも減速しなくなる（実際そう書いて、10.2m/sのまま
         8m滑り続けた。走るより速い移動手段になっていた） */
      const now = this.horizontalSpeed;
      if (moving && now > 0.5) {
        const t = Math.min(1, SLIDE_STEER * dt);
        const nx = this.velocity.x + (wish.x * now - this.velocity.x) * t;
        const nz = this.velocity.z + (wish.z * now - this.velocity.z) * t;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-4) {
          this.velocity.x = (nx / nl) * now;
          this.velocity.z = (nz / nl) * now;
        }
      }
      // 遅くなりきった／時間切れ／床から離れた／死んだ、のどれかで終わる。
      // 床から離れた時に切るのは、崖から滑り落ちながら空中で滑り続けないため
      if (this._slideT <= 0 || this.horizontalSpeed < SLIDE_END_SPEED
        || !grounded || !this.alive) this._endSlide();
    } else if (grounded) {
      const speed = this.horizontalSpeed;
      if (speed > 0.01) {
        // 入力を離した瞬間だけ強い方に切り替える。押している間は弱いままなので
        // 加速の頭打ちが下がらず、最高速はどちらも変わらない
        const base = moving ? FRICTION : FRICTION_STOP;
        const sprintMul = moving ? SPRINT_FRICTION : SPRINT_STOP_FRICTION;
        const mul = THREE.MathUtils.lerp(1, sprintMul, this._sprintHold);
        const drop = Math.max(speed, 2.0) * base * mul * dt;
        const factor = Math.max(speed - drop, 0) / speed;
        this.velocity.x *= factor;
        this.velocity.z *= factor;
      } else {
        this.velocity.x = 0;
        this.velocity.z = 0;
      }
    }

    let accel = grounded
      ? (this.sprinting ? ACCEL_SPRINT : ACCEL_GROUND)
      : ACCEL_AIR;
    if (grounded && this._sprintHold > 0.01) {
      // 走っている間は曲がりにくい。今の速度と入力の向きがずれるほど加速を削るので、
      // 急に横を向いても内側に切り込めず外へ膨らむ
      const sp = this.horizontalSpeed;
      if (sp > 1) {
        const align = (this.velocity.x * wish.x + this.velocity.z * wish.z) / sp;
        const steer = 0.35 + 0.65 * Math.max(0, align);
        accel *= THREE.MathUtils.lerp(1, steer, this._sprintHold);
      }
    }

    const current = this.velocity.x * wish.x + this.velocity.z * wish.z;
    let add = wishSpeed - current;
    // 進行方向の投影だけで頭を押さえると、速度の向きと入力がずれている間は総速度が伸びる。
    // 空中なら跳ぶほど速くなり（いわゆる空中加速）、地上でも壁が進行方向の成分だけ削るので
    // 壁沿いに伸びる（肩を当てて走ると速い）。どちらも総速度で押さえる。
    // まっすぐ走っている間は投影＝総速度なので、開けた場所の最高速には触らない
    add = Math.min(add, wishSpeed - this.horizontalSpeed);
    // 滑っている間は加速しない。ここを通すと、滑りながらWを押しっぱなしにすれば
    // しゃがみの速さまで自分で足せることになり、滑りが減速しなくなる
    if (add > 0 && !this.sliding) {
      const step = Math.min(accel * wishSpeed * dt, add);
      this.velocity.x += wish.x * step;
      this.velocity.z += wish.z * step;
    }

    // 空中は速さを変えずに向きだけ少し寄せる。加速はさせないので跳んで加速はできない
    if (!this.onFloor && moving) {
      const sp = this.horizontalSpeed;
      if (sp > 0.5) {
        const t = Math.min(1, AIR_STEER * dt);
        const nx = this.velocity.x + (wish.x * sp - this.velocity.x) * t;
        const nz = this.velocity.z + (wish.z * sp - this.velocity.z) * t;
        const nl = Math.hypot(nx, nz);
        if (nl > 1e-4) {
          this.velocity.x = (nx / nl) * sp;
          this.velocity.z = (nz / nl) * sp;
        }
      }
    }

    // 傾きに使う加速度。生の差分は跳ねるので一度なましてから使う
    const idt = 1 / Math.max(dt, 1e-4);
    this._accX = THREE.MathUtils.damp(this._accX, clamp((this.velocity.x - preX) * idt, -60, 60), 13, dt);
    this._accZ = THREE.MathUtils.damp(this._accZ, clamp((this.velocity.z - preZ) * idt, -60, 60), 13, dt);

    /* ------------------------------------------------------ 包帯 */
    this.healHold = Math.max(0, (this.healHold || 0) - dt);
    if (this.healing > 0) {
      // 走り出したら中断する。走れる状態で巻けると遅くする意味が無い
      if (this.sprinting) {
        this.cancelHeal();
      } else {
        this.healing -= dt;
        if (this.healing <= 0) {
          this.healing = 0;
          this.bandages = Math.max(0, this.bandages - 1);
          // 戻る量は体力に対する割合。対戦(260)では1人用(130)の倍が戻る
          this.health = Math.min(this.maxHealth, this.health + healAmount(this.maxHealth));
          // 巻き終わってからも0.5秒だけ「巻いている」印を残す。
          // 対戦では自分の入力をサーバーへ送って向こうでも同じ回復を走らせるが、
          // 向こうは通信の遅れぶん遅れて始まって遅れて終わる。こちらが
          // 終わった瞬間に意思表示をやめると、向こうが巻き終わる寸前に
          // 「やめた」と受け取られて、こちらだけ回復した状態になる
          this.healHold = 0.5;
          this.onHealDone?.();
        }
      }
    }

    /* -------------------------------------------------------- 跳躍 */
    this._airTime = this.onFloor ? 0 : this._airTime + dt;
    // jumpQueuedは、刻みが回らなかったフレームで拾ったSpaceの立ち上がりを
    // 呼び手が持ち越して渡してくる分（対戦の120Hz対策。詳しくは_versusFrame）。
    // ソロやparity検査は渡さないので既定のfalse＝これまで通りpressed()だけを見る
    this._jumpBuffer = (input.pressed('Space') || jumpQueued)
      ? JUMP_BUFFER
      : Math.max(0, this._jumpBuffer - dt);
    // しゃがんだままでも跳べる。以前は!this.crouchingで弾いていたので、
    // Ctrlを押したままだとSpaceが無反応になり「たまにジャンプが出ない」に見えていた。
    // 跳ぶ勢いだけ落とす（縮こまった姿勢から伸び上がるぶん低い）
    if (this._jumpBuffer > 0 && this._airTime < COYOTE
      && this.alive && this.velocity.y < 4) {
      /* 滑っている最中に跳ぶと、滑りを打ち切って跳ぶ。
         **ただし持ち出せる速さは走りの最高速まで。** 空中は摩擦が効かないので、
         滑り出しの10.2m/sのまま跳ぶと着地まで一切減速せず、
         「滑る→跳ぶ」を繰り返すのが一番速い移動になって走りが要らなくなる。
         7.4までは残すので、勢いを切らさずに跳べる手応えは残る */
      if (this.sliding) {
        this._endSlide();
        const sp = this.horizontalSpeed;
        if (sp > SPEED_SPRINT) {
          const k = SPEED_SPRINT / sp;
          this.velocity.x *= k;
          this.velocity.z *= k;
        }
      }
      this.velocity.y = this.crouching ? JUMP_VEL * CROUCH_JUMP_MUL : JUMP_VEL;
      this.onFloor = false;
      this._airTime = COYOTE;     // 猶予を使い切って二重跳びを止める
      this._jumpBuffer = 0;
      this._sStep.kick(-0.5);     // 踏み切りで一度沈む
    }
    this.velocity.y -= GRAVITY * dt;

    /* -------------------------------------- 移動適用（速いときは分割） */
    const wantX = this.velocity.x * dt, wantZ = this.velocity.z * dt;
    const fromX = this.collider.start.x, fromZ = this.collider.start.z;
    const keepX = this.velocity.x, keepZ = this.velocity.z;

    const dist = this.velocity.length() * dt;
    const steps = clamp(Math.ceil(dist / 0.15), 1, 6);
    const sub = dt / steps;
    // _collide()は毎回onFloorをfalseから測り直すので、最後の1回の結果だけ残すと
    // 「押し戻された後は接触が無い」ことになって接地が消える。分割が起きるのは
    // 速度*dtが0.15を超えた時、つまり走りは50fps・歩きは32fpsを割った瞬間で、
    // そこから先は摩擦も足音も跳躍も全部死んで20m超滑る。一度でも床に触れたら接地とする
    let floored = false;
    for (let i = 0; i < steps; i++) {
      this.collider.translate(
        this._step.set(this.velocity.x * sub, this.velocity.y * sub, this.velocity.z * sub),
      );
      this._collide();
      floored = floored || this.onFloor;
    }
    this.onFloor = floored;

    // 歩調に使う「体が実際に進んだ水平距離」。この後の段差の乗り越えは体を持ち上げて
    // 前に置き直す補正で、歩いて進んだぶんではないので、ここで先に取っておく
    let movedX = this.collider.start.x - fromX;
    let movedZ = this.collider.start.z - fromZ;

    /* ------------------------------------------------ 段差の乗り越え */
    // 進みたかった向きにどれだけ進めたかで判定する。半分も進めていないなら
    // 何かに当たっているので、乗れる段かどうかを試す
    const wantLen = Math.hypot(wantX, wantZ);
    if (wantLen > 0.004 && this._airTime < 0.25 && this.velocity.y < 2) {
      const dx = wantX / wantLen, dz = wantZ / wantLen;
      const got = (this.collider.start.x - fromX) * dx + (this.collider.start.z - fromZ) * dz;
      if (got < wantLen * 0.6 && this._tryStepUp(dx, dz, wantLen)) {
        // 縁に当たって削られた速度を戻す。ここを戻さないと低い段のたびに
        // 一瞬止まって、体重ではなく引っ掛かりとして伝わってしまう
        this.velocity.x = keepX;
        this.velocity.z = keepZ;
      }
    }

    // マップ外に出られると興ざめなので水平位置だけ押し戻す
    const b = this.bounds - 1.2;
    const cx = clamp(this.collider.start.x, -b, b);
    const cz = clamp(this.collider.start.z, -b, b);
    if (cx !== this.collider.start.x || cz !== this.collider.start.z) {
      const ox = cx - this.collider.start.x, oz = cz - this.collider.start.z;
      this.collider.translate(this._step.set(ox, 0, oz));
      // 押し戻されたぶんは進んでいないので歩調からも引く。
      // 引かないとマップの端で足だけ動き続ける
      movedX += ox;
      movedZ += oz;
    }
    // 落下事故の保険
    if (this.collider.start.y < -20) {
      this.teleport(new THREE.Vector3(0, 1.2, 26));
    }

    /* --------------------------------------------------- 着地の衝撃 */
    if (this.onFloor && !this._prevOnFloor) {
      const impact = clamp(-this._fallSpeed / 14, 0, 1);
      if (impact > 0.08) {
        this._dip.kick(-impact * 3.6);        // 膝が沈む
        this._sPitch.kick(-impact * 0.55);    // 前へつんのめる
        this.onLand?.(impact);
      }
      // 落下ダメージ。速さで測る（高さではなく）。
      // 高さで測ろうとすると「どこから落ち始めたか」を覚えておく必要があり、
      // 斜路を駆け下りた場合や段差を連続で降りた場合に何を起点にするかが決まらない。
      // 着地の瞬間の速さなら、途中で屋根を経由しようが正しく分かれる
      const fall = -this._fallSpeed;
      if (fall > FALL_SAFE_SPEED) {
        const t = (fall - FALL_SAFE_SPEED) / (FALL_LETHAL_SPEED - FALL_SAFE_SPEED);
        // 二乗で効かせる。線形だと「安全な高さの少し上」が痛すぎて、
        // コンテナの上から降りるだけで削られる
        const dmg = this.maxHealth * t * t;
        if (dmg >= 1) {
          this.damage(dmg);
          this.onFallDamage?.(dmg);
        }
      }
    }
    this._prevOnFloor = this.onFloor;
    this._fallSpeed = this.velocity.y;

    /* ----------------------------------------------- 頭の揺れと傾き */
    const speed = this.horizontalSpeed;
    const speedRatio = clamp(speed / SPEED_WALK, 0, 1.6);
    // 滑っている間は足が地面を蹴っていないので揺れも足音も止める。
    // 止めないと、進んだ距離で刻んでいる歩調が10m/sぶん回って、
    // 滑っているのに全力疾走の足音が鳴る
    const walking = grounded && !this.sliding;
    const targetBob = walking ? speedRatio * (this.crouching ? 0.45 : 1) : 0;
    this.bobAmount = THREE.MathUtils.damp(this.bobAmount, targetBob, 9, dt);
    if (walking) {
      const prev = this.bobPhase;
      // 姿勢で歩幅を変える。切り替わる瞬間に歩幅が飛ぶと位相が跳ねて足がもつれるので、
      // 元から滑らかに動く_sprintHoldと身長そのものを混ぜ具合に使う
      const crouchT = clamp((STAND_H - this.height) / (STAND_H - CROUCH_H), 0, 1);
      const stride = THREE.MathUtils.lerp(
        THREE.MathUtils.lerp(STRIDE_WALK, STRIDE_SPRINT, this._sprintHold),
        STRIDE_CROUCH,
        crouchT,
      );
      // 実際に進んだ距離で位相を進める。遅く動けば遅く足が出るので、減速中でも足が地面を掴む。
      // 速度で刻むと壁で削られたぶんが位相に乗らず、進んでいないのに足だけ動く。
      // 止まりかけの微速なら位相もほぼ進まないので、速度での足切りは要らない
      this.bobPhase += (Math.hypot(movedX, movedZ) / stride) * Math.PI;
      // 足が地面を叩く位相を跨いだら足音。同じ瞬間に踏み込みの衝撃も入れる。
      // 距離で刻んでいるので、鳴る間隔は自動的に歩幅どおりになる
      const foot = Math.floor(this.bobPhase / Math.PI);
      if (Math.floor(prev / Math.PI) !== foot && this.bobAmount > 0.15) {
        const power = (this.sprinting ? 1.05 : this.crouching ? 0.34 : 0.58) * this.bobAmount;
        this._sStep.kick(-0.7 * power);
        // 左右の足で反対に振れる。走りは踏み替えの振れを歩きよりはっきり大きくして、
        // 歩きと同じ揺れの拡大版に見えないようにする
        this._sRoll.kick((foot & 1 ? 1 : -1) * (0.045 + this._sprintHold * 0.04) * power);
        this.onFootstep?.(this.sprinting ? 1 : this.crouching ? 0.35 : 0.7);
      }
    }

    /* ------------------------------------------- 踏み出し・停止・転換 */
    // ここも接地の猶予付きで見る。壁に触れた1フレームだけonFloorが落ちると
    // 「歩き出した／止まった」が交互に立って、踏み出しの前のめりが延々と鳴り続ける
    // 滑っている間も「動いている」に数える。数えないと、滑り出した瞬間に
    // 「急に止まった」と見なされて前のめりの衝撃が入る（実際は加速している）
    const nowMoving = grounded && (moving || this.sliding);
    if (nowMoving && !this._wasMoving) {
      // 体が先に出て頭が置いていかれる。加速が硬くなったぶん置いていかれ方も強い
      this._sPitch.kick(0.11 * (this.sprinting ? 1.3 : 1));
      this._sOffF.kick(-0.30);
    } else if (!nowMoving && this._wasMoving && this._prevSpeed > 2.2) {
      // 急停止の前のめり。速いほど深く突っ込む。
      // 離した瞬間に強い摩擦で踏ん張る形になったので、その踏ん張りぶん深くする
      const f = clamp(this._prevSpeed / SPEED_SPRINT, 0, 1);
      this._sPitch.kick(-0.20 * f);
      this._dip.kick(-0.62 * f);
    }
    if (nowMoving && speed > 2.2 && (this._prevWishX !== 0 || this._prevWishZ !== 0)) {
      const dot = wish.x * this._prevWishX + wish.z * this._prevWishZ;
      if (dot < 0.55) {
        // 進行方向を切り替えた瞬間、体は元の向きに残るので外側へ振られる。
        // 外積は真横で最大・真後ろで0になるので、横向きの勢いそのものとして使える
        // （前後の切り返しは横に振られないのが正しい）
        const cross = this._prevWishZ * wish.x - this._prevWishX * wish.z;
        const power = clamp(speed / SPEED_WALK, 0, 1.4);
        this._sRoll.kick(-cross * 0.95 * power);
        this._sOffR.kick(-cross * 0.4 * power);
      }
    }
    this._wasMoving = nowMoving;
    this._prevSpeed = speed;
    this._prevWishX = wish.x;
    this._prevWishZ = wish.z;

    /* ----------------------------------------- 加速度から遅れを作る */
    // 加速度をヨー基準の前後・左右に分解する（前方 -Z、右 +X）
    const accF = -(this._accX * sin + this._accZ * cos);
    const accR = this._accX * cos - this._accZ * sin;
    // 加速で後ろに反り、減速で前へ突っ込む。走っている間は常に前傾させる
    // 滑っている間は顔が路面へ寄る。0.030は約1.7度で、
    // 「体が低い」ことが視界の端で分かる程度。これ以上倒すと狙えなくなる
    this._sPitch.target = clamp(accF * 0.00042, -0.014, 0.014)
      - this._sprintLean * 0.005 - this._slideLean * 0.030;
    // 体に対してカメラが遅れる。前後は壁に頭を突っ込みやすいので控えめに
    this._sOffF.target = clamp(-accF * 0.0013, -0.036, 0.036);
    this._sOffR.target = clamp(-accR * 0.0018, -0.05, 0.05);
    // 曲がると外へ振られる。止まっている時は画面が回ると酔うので効きを落とす
    this._sRoll.target = clamp(-yawRate, -4, 4) * 0.0068
      * (0.18 + 0.82 * Math.min(speedRatio, 1));

    this._stepSprings(dt);

    /* ストレイフの傾きは入力に対する体重移動なので、バネではなく素直に寄せる。
       滑っている間は2.4倍に増やす。滑りは体を倒して路面へ落とす動作なので、
       左右に振った時の傾きが立っている時と同じだと、姿勢が変わって見えない */
    this._strafeRoll = THREE.MathUtils.damp(
      this._strafeRoll, -m.x * 0.028 * (1 + this._slideLean * 1.4), 8, dt,
    );
    this.roll = (this._strafeRoll + this._sRoll.x) * (1 - this.adsFactor * 0.7);

    // 反動は毎フレーム自然減衰。武器側から加算される
    this.recoilPitch = THREE.MathUtils.damp(this.recoilPitch, 0, 7.5, dt);
    this.recoilYaw = THREE.MathUtils.damp(this.recoilYaw, 0, 7.5, dt);

    // 段差で持ち上げた分を少しずつ返す。これが無いと縁で視点が瞬間移動する
    this._stepSmooth = THREE.MathUtils.damp(this._stepSmooth, 0, 15, dt);

    this._applyCamera();
    return this;
  }

  // 武器から1発ぶんの反動を受け取る。半分は狙点(pitch/yaw)へ置いていき、
  // 残り半分だけを行って戻る跳ねに回す。置いていった分は自分でマウスを引いて
  // 戻すしかないので、撃つほど狙いが上へ流れる＝弾を撒くのに代償がつく。
  //
  // keepは呼ぶ側で下げられる。自分でトリガーを引いた結果なら残すのが正しいが、
  // 被弾のフリンチのように自分が選んでいない跳ねまで残すと、撃たれた回数ぶん
  // 狙いが上へずれていくだけの理不尽になるので、そちらは0を渡す想定
  addRecoil(pitch, yaw, keep = RECOIL_KEEP) {
    const keepPitch = pitch * keep;
    const keepYaw = yaw * keep;
    // 視点入力と同じ上限で止める。ここで止めないと真上を越えた値が残り、
    // 次にマウスを動かした瞬間に上限へ引き戻されて視点が飛ぶ
    this.pitch = clamp(this.pitch + keepPitch, -1.5, 1.5);
    this.yaw += keepYaw;
    this.recoilPitch += pitch - keepPitch;
    this.recoilYaw += yaw - keepYaw;
  }

  _applyCamera() {
    // 走りは沈む側だけ深く、蹴り出す側を浅くして波形そのものを歪ませる。
    // 振れ幅を大きくするだけだと歩きの早回しにしか見えない
    const bobY = (Math.sin(this.bobPhase) - this._sprintHold * 0.30 * Math.sin(this.bobPhase * 2))
      * 0.058 * this.bobAmount;
    const bobX = Math.cos(this.bobPhase * 0.5)
      * (0.070 + this._sprintHold * 0.022) * this.bobAmount;

    // 目の高さ。姿勢の行き過ぎ・着地の沈み・踏み込みの衝撃・段差の遅れを足す。
    // どれも見た目専用で、colliderは一切動かしていない
    const eyeY = this.feetY + this.height - 0.16
      + bobY + this._dip.x + this._sStep.x + this._sPosture.x - this._stepSmooth;

    // ローカルのずれをワールドへ戻す。前方 F=(-sin,0,-cos)、右 R=(cos,0,-sin)
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    const offF = this._sOffF.x;
    const offR = this._sOffR.x + bobX;
    this.camera.position.set(
      this.collider.start.x + offR * cos - offF * sin,
      eyeY,
      this.collider.start.z - offR * sin - offF * cos,
    );

    // 傾きは狙いを動かすので、覗いている間は薄める
    const lean = 1 - this.adsFactor * 0.65;
    const pitchBob = Math.sin(this.bobPhase * 2 + 1.2) * 0.0045 * this.bobAmount;

    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw + this.recoilYaw;
    this.camera.rotation.x = clamp(
      this.pitch + this.recoilPitch + (this._sPitch.x + pitchBob) * lean, -1.55, 1.55,
    );
    this.camera.rotation.z = this.roll
      + Math.sin(this.bobPhase * 0.5) * (0.018 + this._sprintHold * 0.007) * this.bobAmount;
  }
}
