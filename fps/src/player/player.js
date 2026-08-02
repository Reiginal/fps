// プレイヤーの足回り。カプセル形状をOctreeに押し当てて衝突を解決する。
// 加速と摩擦で動かす方式（Quake系）にしてあるので、止まる/曲がるが素直に効く。
//
// 「体重がある」感触は、速度そのものではなく速度の変化（加速度）から作っている。
// 加速度・着地速度・ヨー角速度・姿勢の変化量、この4つを入力にして
// 減衰バネを叩き、その解をカメラの位置と姿勢に足す。
// バネの結果は絶対にcolliderへ戻さない。当たり判定が揺れると撃ち合いが壊れる。
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';

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
    this.adsFactor = 0;      // 外から武器が書き込む 0..1

    this.health = 100;
    this.maxHealth = 100;
    this.alive = true;

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

  damage(amount) {
    if (!this.alive) return;
    this.health -= amount;
    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
    }
  }

  heal(amount) {
    this.health = Math.min(this.maxHealth, this.health + amount);
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

  // バネは硬いので重いフレームで一気に積むと発散する。0.02秒ずつに割って解く
  _stepSprings(dt) {
    const n = Math.min(5, Math.max(1, Math.ceil(dt / 0.02)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < this._springs.length; j++) this._springs[j].step(h);
    }
  }

  update(dt, input, lookEnabled = true) {
    const prevYaw = this.yaw;

    if (lookEnabled) {
      const look = input.takeLook();
      // 覗き込み中は感度を落とす。これが無いとADSで狙いが定まらない
      const scale = 1 - this.adsFactor * 0.45;
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
    const wantCrouch = this.alive && (input.down('ControlLeft') || input.down('KeyC'));
    if (wantCrouch !== this._wantCrouch) {
      this._wantCrouch = wantCrouch;
      this._postureArm = wantCrouch ? -1 : 1;   // 到着した時に行き過ぎさせる向き
    }
    const targetH = wantCrouch ? CROUCH_H : STAND_H;
    if (Math.abs(this.height - targetH) > 0.001) {
      // 沈むのは速く、立つのは遅い。左右対称だと機敏すぎて体重が消える
      const rate = targetH < this.height ? 20 : 12;
      this._tryHeight(THREE.MathUtils.damp(this.height, targetH, rate, dt));
    }
    if (this._postureArm !== 0 && Math.abs(this.height - targetH) < 0.1) {
      // 体が止まる瞬間に頭だけ勢いで行き過ぎ、戻ってから収まる。
      // 単純な補間だと目標にぴたりと張り付いて、頭に重さが無いように見える
      this._sPosture.kick(this._postureArm * 1.35);
      this._postureArm = 0;
    }
    this.crouching = this.height < (STAND_H + CROUCH_H) / 2;

    /* ------------------------------------------------------ 移動入力 */
    const m = input.moveVector(this._move);
    const moving = this.alive && (m.x !== 0 || m.z !== 0);
    this.sprinting = this.alive && moving && m.z < -0.1 && input.down('ShiftLeft')
      && !this.crouching && this.adsFactor < 0.5;

    // 走りの「効き」は入切より遅らせる。抜けきるまで滑るのが走りの重さ
    this._sprintHold = this.sprinting
      ? Math.min(1, this._sprintHold + dt * 2.2)
      : Math.max(0, this._sprintHold - dt * 1.6);
    // 前傾は狙いに直接響くので、こちらは素早く戻す
    this._sprintLean = THREE.MathUtils.damp(this._sprintLean, this.sprinting ? 1 : 0, 8, dt);

    let wishSpeed = this.crouching ? SPEED_CROUCH : this.sprinting ? SPEED_SPRINT : SPEED_WALK;
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

    if (grounded) {
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
    if (add > 0) {
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

    /* -------------------------------------------------------- 跳躍 */
    this._airTime = this.onFloor ? 0 : this._airTime + dt;
    this._jumpBuffer = input.pressed('Space')
      ? JUMP_BUFFER
      : Math.max(0, this._jumpBuffer - dt);
    if (this._jumpBuffer > 0 && this._airTime < COYOTE
      && this.alive && !this.crouching && this.velocity.y < 4) {
      this.velocity.y = JUMP_VEL;
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
    }
    this._prevOnFloor = this.onFloor;
    this._fallSpeed = this.velocity.y;

    /* ----------------------------------------------- 頭の揺れと傾き */
    const speed = this.horizontalSpeed;
    const speedRatio = clamp(speed / SPEED_WALK, 0, 1.6);
    const targetBob = grounded ? speedRatio * (this.crouching ? 0.45 : 1) : 0;
    this.bobAmount = THREE.MathUtils.damp(this.bobAmount, targetBob, 9, dt);
    if (grounded) {
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
    const nowMoving = moving && grounded;
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
    this._sPitch.target = clamp(accF * 0.00042, -0.014, 0.014) - this._sprintLean * 0.005;
    // 体に対してカメラが遅れる。前後は壁に頭を突っ込みやすいので控えめに
    this._sOffF.target = clamp(-accF * 0.0013, -0.036, 0.036);
    this._sOffR.target = clamp(-accR * 0.0018, -0.05, 0.05);
    // 曲がると外へ振られる。止まっている時は画面が回ると酔うので効きを落とす
    this._sRoll.target = clamp(-yawRate, -4, 4) * 0.0068
      * (0.18 + 0.82 * Math.min(speedRatio, 1));

    this._stepSprings(dt);

    // ストレイフの傾きは入力に対する体重移動なので、バネではなく素直に寄せる
    this._strafeRoll = THREE.MathUtils.damp(this._strafeRoll, -m.x * 0.028, 8, dt);
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
