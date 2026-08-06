// 弾痕・火花・煙・血・曳光弾・薬莢。撃った実感はほぼここで決まる。
// パーティクルは1つのPointsに詰めて1ドローコールで出す（毎フレーム大量に出るので）。
// 層ごとに寿命と物理を変えて重ねるのが肝で、同じ動きの粒を増やしても情報量は増えない。
import * as THREE from 'three';
import { radialTexture, smokeTexture } from './textures.js';

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _p = new THREE.Vector3();
const _m = new THREE.Matrix4();
// カメラの向きの逆回転。太陽をビュー空間へ持ち込むのに毎フレーム使う
const _q = new THREE.Quaternion();
// 毎フレーム判定で使い回す。ここでnewすると着弾のたびにGCが走る
const _sphere = new THREE.Sphere(new THREE.Vector3(), 0.06);
// 血の飛沫・血だまりの落下先を探すレイ。着弾のたびにnewしないよう使い回す
const _ray = new THREE.Ray();
// デカールの置き場所指定。着弾のたびにオブジェクトを作らないよう共有する（中身は読むだけ）
const SPLASH = { splash: true };
const SPLATTER = { splash: true, spread: 0.13, maxScale: 0.9 };
const POOL_OPTS = { persistent: true, grow: 1.5, life: 75 };

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/* --------------------------------------------------------- 減衰カーブ */

const FADE_LINEAR = 0;   // まっすぐ消える
const FADE_OUT2 = 1;     // 後半で一気に消える（火花・破片）
const FADE_INOUT = 2;    // 出てから膨らんで消える（粉塵）
const FADE_FLASH = 3;    // 出た瞬間が最大（着弾閃光）
const FADE_HOLD = 4;     // ほぼ一定で居座ってから消える（残留粉・銃口煙）

/* ------------------------------------------------------- パーティクル */

// STREAK付きの群は速度方向に伸びる。止まっている粒は伸びないので、
// 同じ群に閃光（速度ゼロ）と高速火花を同居させられる。
const PARTICLE_VS = /* glsl */`
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute float aRot;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vRot;
  uniform float uScale;
  uniform float uMaxSize;
  #ifdef STREAK
    attribute vec3 aVel;
    uniform float uAspect;
    uniform float uStretch;
    varying vec2 vDir;
    varying float vStretch;
  #endif
  void main() {
    vAlpha = aAlpha;
    vColor = aColor;
    vRot = aRot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vec4 clip = projectionMatrix * mv;
    float sz = aSize * uScale / max(-mv.z, 0.001);
    #ifdef STREAK
      // 1/60秒先の位置を投影して、画面上でどれだけ動くかを測る
      vec4 clip2 = projectionMatrix * (modelViewMatrix * vec4(position + aVel * 0.016, 1.0));
      vec2 s0 = clip.xy / max(clip.w, 1e-4);
      vec2 s1 = clip2.xy / max(clip2.w, 1e-4);
      vec2 d = vec2((s1.x - s0.x) * uAspect, s1.y - s0.y);
      float l = length(d);
      // gl_PointCoordはyが下向きなので符号を反転して合わせる
      vDir = l > 1e-5 ? vec2(d.x, -d.y) / l : vec2(1.0, 0.0);
      vStretch = clamp(1.0 + l * uStretch / max(sz, 1.0), 1.0, 4.0);
      sz *= vStretch;
    #endif
    gl_Position = clip;
    // 至近の煙が画面を丸ごと覆って白くなるのを防ぐ。塗る面積の保険でもある
    gl_PointSize = min(sz, uMaxSize);
  }
`;

const PARTICLE_FS = /* glsl */`
  uniform sampler2D uMap;
  varying float vAlpha;
  varying vec3 vColor;
  varying float vRot;
  #ifdef STREAK
    varying vec2 vDir;
    varying float vStretch;
  #endif
  #ifdef LIT
    // ビュー空間。粒から太陽へ向かう向き
    uniform vec3 uSunDir;
    uniform vec3 uSunCol;
    uniform vec3 uAmbCol;
  #endif
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float a;
    vec2 uv;
    #ifdef STREAK
      // 速度方向をx軸に合わせ、垂直方向だけ縮めて筋にする
      vec2 q = vec2(p.x * vDir.x + p.y * vDir.y, -p.x * vDir.y + p.y * vDir.x);
      q.y *= vStretch;
      if (abs(q.y) > 0.5) discard;
      uv = q + 0.5;
      // 伸びた分だけ薄くしないと、速い粒ほど明るくなって嘘になる
      a = vAlpha * inversesqrt(vStretch);
    #else
      float cr = cos(vRot), sr = sin(vRot);
      uv = vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr) + 0.5;
      if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
      a = vAlpha;
    #endif
    vec4 t = texture2D(uMap, uv);
    a *= t.a;
    if (a < 0.004) discard;
    vec3 c = vColor * t.rgb;
    #ifdef LIT
      // 板1枚を球とみなして法線をでっち上げる。粒に陰影が付かないと、砂埃も血も
      // 「色を塗ったシール」に見えて画面の中で唯一ライティングから外れた物になる。
      // ビルボードなので法線のzは常にカメラ側(+z)
      vec2 sp = p * 2.0;
      float r2 = min(dot(sp, sp), 1.0);
      vec3 nrm = vec3(sp.x, -sp.y, sqrt(1.0 - r2));
      float ndl = dot(nrm, uSunDir);
      // 煙は光を透かすので半球ラップ。真っ二つに割れた陰影にはしない
      float wrap = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
      // 逆光で内側が抜ける前方散乱。夕方の砂埃はこれが無いとただの灰色の丸
      float back = pow(clamp(-ndl, 0.0, 1.0), 3.0) * (1.0 - r2 * 0.6);
      c *= uAmbCol + uSunCol * (wrap * wrap * 0.9 + back * 0.75);
    #endif
    gl_FragColor = vec4(c, a);
  }
`;

class ParticleGroup {
  // lit: 太陽と空で陰影を付ける。自分で光っている物（火花・閃光）には掛けない
  constructor(capacity, map, additive, streak = false, lit = false) {
    this.capacity = capacity;
    this.count = 0;
    this.cursor = 0;
    this.streak = streak;
    this.lit = lit;

    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.color = new Float32Array(capacity * 3);   // 描画に渡る現在色
    this.col0 = new Float32Array(capacity * 3);
    this.col1 = new Float32Array(capacity * 3);    // 寿命の終わりの色（冷えていく表現）
    this.size = new Float32Array(capacity);
    this.size0 = new Float32Array(capacity);
    this.size1 = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.alpha0 = new Float32Array(capacity);      // 最大不透明度。薄い粉塵はここで決まる
    this.rot = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.gravity = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.fade = new Float32Array(capacity);
    this.tag = new Uint8Array(capacity);           // 1:血。跳ねた場所に染みを残す
    this.bounceLeft = new Uint8Array(capacity);    // 残りバウンド回数。0なら判定しない

    // 衝突は外から差してもらう。無ければ判定を丸ごと飛ばす
    this.octree = null;
    this.onRest = null;
    this._frame = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    geo.setAttribute('aRot', new THREE.BufferAttribute(this.rot, 1));
    if (streak) geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);

    const defines = {};
    if (streak) defines.STREAK = '';
    if (lit) defines.LIT = '';

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: map },
        uScale: { value: 600 },
        uStretch: { value: 540 },
        uAspect: { value: 1.777 },
        uMaxSize: { value: 600 },
        // 太陽側と日陰側を足して約1.0になるよう配分してある。粒の基準色は
        // 「日向で見た色」として書かれているので、掛けても全体の明るさが動かない
        uSunDir: { value: new THREE.Vector3(0, 0, 1) },
        uSunCol: { value: new THREE.Vector3(0.80, 0.75, 0.63) },
        uAmbCol: { value: new THREE.Vector3(0.30, 0.34, 0.42) },
      },
      defines,
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.geo = geo;
  }

  spawn(o) {
    // 上限に達したら一番古いものを潰す。詰まって出なくなるより自然
    const i = this.count < this.capacity ? this.count++ : (this.cursor = (this.cursor + 1) % this.capacity);
    const i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx; this.vel[i3 + 1] = o.vy; this.vel[i3 + 2] = o.vz;
    this.col0[i3] = o.r; this.col0[i3 + 1] = o.g; this.col0[i3 + 2] = o.b;
    this.col1[i3] = o.r1 ?? o.r; this.col1[i3 + 1] = o.g1 ?? o.g; this.col1[i3 + 2] = o.b1 ?? o.b;
    this.color[i3] = o.r; this.color[i3 + 1] = o.g; this.color[i3 + 2] = o.b;
    this.size0[i] = o.size0;
    this.size1[i] = o.size1;
    this.size[i] = o.size0;
    this.alpha0[i] = o.alpha ?? 1;
    this.alpha[i] = o.alpha ?? 1;
    this.rot[i] = o.rot ?? 0;
    this.spin[i] = o.spin ?? 0;
    this.life[i] = 0;
    this.maxLife[i] = o.life;
    this.gravity[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.fade[i] = o.fade ?? FADE_LINEAR;
    this.tag[i] = o.tag ?? 0;
    this.bounceLeft[i] = o.bounce ?? 0;
  }

  update(dt) {
    const oct = this.octree;
    // 跳ね判定は毎フレーム全部やると重いので、1フレームあたりの本数を絞る
    let budget = oct ? 20 : 0;
    // 血は別枠。共通の枠を破片と取り合うと、交戦中ほど判定に当たらずに寿命が尽きて
    // 空中で消え、床にも壁にも痕跡が残らない（撃った証拠が全部消える）
    let bloodBudget = oct ? 24 : 0;
    const parity = (this._frame++) & 1;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      this.life[i] += dt;
      if (this.life[i] >= this.maxLife[i]) {
        // 末尾と入れ替えて詰める
        const last = --n;
        if (i !== last) this._copy(last, i);
        i--;
        continue;
      }
      const i3 = i * 3;
      const d = Math.max(0, 1 - this.drag[i] * dt);
      let vx = this.vel[i3] * d;
      let vy = this.vel[i3 + 1] * d - this.gravity[i] * dt;
      let vz = this.vel[i3 + 2] * d;
      let px = this.pos[i3] + vx * dt;
      let py = this.pos[i3 + 1] + vy * dt;
      let pz = this.pos[i3 + 2] + vz * dt;

      // 破片・血だけ地面と当てる。破片は数が多いので1フレームおきに間引くが、
      // 血は痕跡を残す役目があるので間引かずに毎フレーム見る
      const isBlood = this.tag[i] === 1;
      const canHit = this.bounceLeft[i] > 0
        && (isBlood ? bloodBudget > 0 : (budget > 0 && ((i & 1) === parity)));
      if (canHit) {
        if (isBlood) bloodBudget--; else budget--;
        _sphere.center.set(px, py, pz);
        _sphere.radius = 0.06;
        const hit = oct.sphereIntersect(_sphere);
        if (hit) {
          const hn = hit.normal;
          px += hn.x * hit.depth; py += hn.y * hit.depth; pz += hn.z * hit.depth;
          const vn = vx * hn.x + vy * hn.y + vz * hn.z;
          // 反発は弱く、接線は摩擦で削る。石は跳ねるが飛び続けはしない
          vx = (vx - hn.x * vn * 1.35) * 0.5;
          vy = (vy - hn.y * vn * 1.35) * 0.5;
          vz = (vz - hn.z * vn * 1.35) * 0.5;
          this.bounceLeft[i]--;
          if (isBlood) {
            // 血の粒は跳ねずに貼り付く。そこに染みを残して粒は消す
            this.onRest?.(px, py, pz, hn);
            const last = --n;
            if (i !== last) this._copy(last, i);
            i--;
            continue;
          }
          if (vx * vx + vy * vy + vz * vz < 0.6) {
            // ほぼ止まったら地面に居座らせる。転がり続けるより落ち着いて見える
            vx = 0; vy = 0; vz = 0;
            this.gravity[i] = 0;
            this.bounceLeft[i] = 0;
            this.fade[i] = FADE_HOLD;
          }
        }
      }

      this.vel[i3] = vx; this.vel[i3 + 1] = vy; this.vel[i3 + 2] = vz;
      this.pos[i3] = px; this.pos[i3 + 1] = py; this.pos[i3 + 2] = pz;

      const t = this.life[i] / this.maxLife[i];
      this.size[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      this.rot[i] += this.spin[i] * dt;
      this.color[i3] = this.col0[i3] + (this.col1[i3] - this.col0[i3]) * t;
      this.color[i3 + 1] = this.col0[i3 + 1] + (this.col1[i3 + 1] - this.col0[i3 + 1]) * t;
      this.color[i3 + 2] = this.col0[i3 + 2] + (this.col1[i3 + 2] - this.col0[i3 + 2]) * t;

      let a;
      const f = this.fade[i];
      if (f === FADE_OUT2) a = 1 - t * t;
      else if (f === FADE_INOUT) {
        if (t < 0.18) a = t / 0.18;
        else { const k = (t - 0.18) / 0.82; a = 1 - k * k; }
      } else if (f === FADE_FLASH) { const k = 1 - t; a = k * k * k; }
      else if (f === FADE_HOLD) a = t < 0.65 ? 1 : (1 - t) / 0.35;
      else a = 1 - t;
      this.alpha[i] = a * this.alpha0[i];
    }
    this.count = n;
    this.geo.setDrawRange(0, n);
    if (n > 0) {
      // needsUpdateだけを立てると、three.jsはupdateRangeが空の時
      // 容量ぶん(capacity)を丸ごとbufferSubDataで送る。生きている粒がn個でも
      // spark(2000)やsmoke(1300)の容量ぶんを毎フレーム送ることになっていた。
      // addUpdateRangeで先頭n個ぶんだけに絞る（範囲は要素数。position/aColorは
      // 1粒3要素、aSize/aAlpha/aRotは1粒1要素）
      const { position, aSize, aAlpha, aColor, aRot, aVel } = this.geo.attributes;
      position.addUpdateRange(0, n * 3); position.needsUpdate = true;
      aSize.addUpdateRange(0, n); aSize.needsUpdate = true;
      aAlpha.addUpdateRange(0, n); aAlpha.needsUpdate = true;
      aColor.addUpdateRange(0, n * 3); aColor.needsUpdate = true;
      aRot.addUpdateRange(0, n); aRot.needsUpdate = true;
      if (this.streak) { aVel.addUpdateRange(0, n * 3); aVel.needsUpdate = true; }
    }
  }

  _copy(from, to) {
    const f3 = from * 3, t3 = to * 3;
    for (let k = 0; k < 3; k++) {
      this.pos[t3 + k] = this.pos[f3 + k];
      this.vel[t3 + k] = this.vel[f3 + k];
      this.color[t3 + k] = this.color[f3 + k];
      this.col0[t3 + k] = this.col0[f3 + k];
      this.col1[t3 + k] = this.col1[f3 + k];
    }
    this.size[to] = this.size[from];
    this.size0[to] = this.size0[from];
    this.size1[to] = this.size1[from];
    this.alpha[to] = this.alpha[from];
    this.alpha0[to] = this.alpha0[from];
    this.rot[to] = this.rot[from];
    this.spin[to] = this.spin[from];
    this.life[to] = this.life[from];
    this.maxLife[to] = this.maxLife[from];
    this.gravity[to] = this.gravity[from];
    this.drag[to] = this.drag[from];
    this.fade[to] = this.fade[from];
    this.tag[to] = this.tag[from];
    this.bounceLeft[to] = this.bounceLeft[from];
  }

  clear() { this.count = 0; this.geo.setDrawRange(0, 0); }
}

/* ------------------------------------------------------ 弾痕テクスチャ */

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// デカールは並べないのでタイリングは考えなくていい
function vnoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

function fbm(x, y, freq, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * f, y * f, seed + i * 131);
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

function makeSprite(data, size, srgb = true) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  // 法線・粗さは色ではないのでsRGB変換を通すと値が壊れる
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/**
 * 高さ場から接空間の法線マップを焼く。
 * デカールを受光させる以上、穴が凹んで見えるかどうかはここが全部決める。
 * DataTextureはflipYが効かないので、配列のy方向がそのままvの正方向になる。
 */
function heightToNormal(hgt, size, strength) {
  const out = new Uint8Array(size * size * 4);
  const at = (x, y) => hgt[
    (y < 0 ? 0 : y > size - 1 ? size - 1 : y) * size + (x < 0 ? 0 : x > size - 1 ? size - 1 : x)
  ];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (at(x - 1, y) - at(x + 1, y)) * strength;
      const ny = (at(x, y - 1) - at(x, y + 1)) * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      out[i + 2] = (inv * 0.5 + 0.5) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

/**
 * 素材別の弾痕。同じ穴を色違いで使うと嘘っぽいので、
 * 砕ける・凹む・裂けるという壊れ方の違いそのものを描き分ける。
 * アルベドだけでなく高さ場と粗さ/金属も同時に焼く。デカールを受光させるので、
 * これが無いと弾痕が周りの壁と別の光の下にある板になる。
 * 戻り値は { map, normalMap, armMap, ns }（armはG=粗さ B=金属）
 */
function decalTexture(kind, size = 128, variant = 0) {
  const data = new Uint8Array(size * size * 4);
  const arm = new Uint8Array(size * size * 4);
  const hgt = new Float32Array(size * size);   // 0=面と同じ高さ、-が凹み、+がめくれ
  const c = size / 2;
  const kseed = kind.length * 37 + 5 + variant * 917;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const n = fbm(x / size, y / size, 9, 3, kseed);
      let a = 0, r = 0, g = 0, b = 0;
      // 既定は「乾いてざらざら・非金属」。素材ごとに下で上書きする
      let h = 0, rough = 0.9, metal = 0;

      if (kind === 'metal') {
        // 金属は砕けずに凹む。縁がめくれて地金が光り、粉は出ない
        const hole = smoothstep(0.15, 0.05, d);
        const rim = Math.max(0, smoothstep(0.34 + n * 0.08, 0.12, d) - hole * 0.7);
        const scratch = smoothstep(0.55, 0.18, d) * Math.pow(Math.abs(Math.sin(ang * 9 + n * 4)), 6);
        a = clamp01(hole + rim * 0.95 + scratch * 0.5);
        // 凹みの陰影は法線マップと実際の太陽が付けるので、ここで焼くのは
        // 地金の下地の濃淡だけに留める。強く焼くと画面のどこを向いても
        // 左上から光が来ている板になり、周りの陰影と喧嘩する
        const shade = d > 0.02 ? clamp01(0.5 + 0.5 * (-dx * 0.7 + dy * 0.7) / d) : 0.5;
        let lum = lerp(0.52, 0.88, shade) * (0.82 + n * 0.36);
        lum = lerp(lum, 0.02, hole);
        r = lum * 0.95; g = lum * 0.97; b = lum;
        // 弾は板を凹ませ、縁を進行方向へめくり上げる。凹みと隆起が隣り合うので
        // 太陽の向き次第で明暗が入れ替わり、平面のままでも本当に穴に見える
        h = -hole * 1.0 + rim * 0.5 - scratch * 0.1;
        // めくれた地金と穴の内側は塗膜が剥げて光る。周りの塗装面は艶消し
        const bare = clamp01(hole + rim * 0.9);
        rough = lerp(0.58, 0.28, bare);
        metal = bare * 0.95;
      } else if (kind === 'wood') {
        // 木は繊維に沿って裂ける。横方向（繊維方向）に長く毛羽立たせる
        const fiber = Math.pow(Math.abs(Math.cos(ang)), 2);
        const spike = Math.pow(Math.abs(Math.sin(ang * 11 + Math.sin(ang * 2) * 3)), 4);
        const reach = 0.22 + fiber * 0.55 + spike * 0.22 + (n - 0.5) * 0.12;
        const hole = smoothstep(0.16, 0.05, d);
        const splinter = smoothstep(reach, 0.07, d) * (0.3 + spike * 0.85);
        const chip = smoothstep(0.38, 0.1, d) * (0.4 + n * 0.6);
        a = clamp01(hole + splinter * 0.8 + chip * 0.45);
        // 割れた内側は日焼けしていないので周りより明るい
        const fresh = clamp01(splinter * 0.9 + chip * 0.5);
        let lum = lerp(0.2, 0.62, fresh) * (0.8 + n * 0.4);
        lum = lerp(lum, 0.03, hole);
        r = lum; g = lum * 0.78; b = lum * 0.5;
        // ささくれは手前に立ち上がる。穴だけ深く、その周りは毛羽で凸凹する
        h = -hole * 1.0 + splinter * 0.4 - chip * 0.2;
        rough = 0.88 + n * 0.1;
      } else if (kind === 'blood' || kind === 'bloodPool') {
        // 血は「濃い芯・飛沫の粒・乾きかけた暗い縁」の3層で作る。
        // ベタ赤1色だと漫画になるので、厚みで色を変えて階調を出す。
        // bloodPoolは床用。垂れが無く、輪郭が丸く、面積が広い
        const pool = kind === 'bloodPool';
        const seed = pool ? 311 : 71;

        // (1) 芯。真円だと印刷したシミに見えるので低周波で輪郭を波打たせる
        const lobe = Math.sin(ang * 3 + n * 5.5) * (pool ? 0.05 : 0.07)
          + Math.sin(ang * 7 + 1.7) * (pool ? 0.025 : 0.04);
        const edge = (pool ? 0.44 : 0.29) + (n - 0.5) * (pool ? 0.14 : 0.28) + lobe;
        const core = smoothstep(edge, edge - (pool ? 0.09 : 0.12), d);
        // 中心ほど厚い。ここが一番暗く沈む
        const coreThick = core * (0.5 + 0.5 * smoothstep(edge, edge * 0.3, d));

        // (2) 乾きかけた縁。輪郭のすぐ内側だけ濃度が上がる（コーヒーリングと同じ）
        const ring = smoothstep(edge + 0.01, edge - 0.045, d)
          * smoothstep(edge - 0.16, edge - 0.05, d);

        // (3) 飛沫の粒。大小を混ぜないと点描に見える。
        //     真円のまま撒くと水玉模様になるので、飛んできた向き（中心から外）へ伸ばし、
        //     外側だけに尾を引かせる。粒の形そのものが飛散方向を語る
        let sat = 0, satThick = 0;
        const nsat = pool ? 13 : 26;
        for (let k = 0; k < nsat; k++) {
          const sa = hash2(k, 3, seed) * 6.283;
          const sr = (pool ? 0.44 : 0.28) + hash2(k, 9, seed) * (pool ? 0.32 : 0.6);
          // 2.2乗で小粒に寄せる。大きい粒がたまに混ざるくらいが自然
          const rad = 0.011 + Math.pow(hash2(k, 17, seed), 2.2) * 0.09;
          const ca = Math.cos(sa), sn = Math.sin(sa);
          const ox = dx - ca * sr, oy = dy - sn * sr;
          const along = ox * ca + oy * sn;      // 外向きが正
          const across = -ox * sn + oy * ca;
          // 血だまりの粒は真上から落ちた分ほぼ丸い。壁の飛沫は勢いがある分よく伸びる
          const el = pool ? 1.1 + hash2(k, 23, seed) * 0.3 : 1.4 + hash2(k, 23, seed) * 1.4;
          const g0 = smoothstep(rad, rad * 0.3, Math.hypot(along > 0 ? along / el : along, across));
          if (g0 > sat) { sat = g0; satThick = 0.16 + rad * 3.2; }
        }

        // (4) 垂れ。壁用だけ。テクスチャのv=0側（下）に筋を落とす。
        //     等間隔の縞で作ると櫛の歯にしか見えないので、1本ずつ位置・太さ・
        //     落ちた距離を散らし、先端には表面張力で溜まった玉を付ける
        let drip = 0, dripThick = 0;
        if (!pool) {
          for (let k = 0; k < 5; k++) {
            const top = -0.04 - hash2(k, 55, seed) * 0.16;   // 芯のどこから垂れ始めるか
            if (dy > top) continue;
            const len = 0.18 + hash2(k, 71, seed) * 0.48;
            const t = (top - dy) / len;                       // 0:根元 1:先端
            if (t > 1.3) continue;
            const cx2 = (hash2(k, 41, seed) - 0.5) * 0.5;
            const w = 0.013 + hash2(k, 87, seed) * 0.015;
            // まっすぐ落ちるが、面のムラで下ほど少し蛇行する
            const wob = Math.sin(t * 5.5 + k * 2.1) * 0.016 * t;
            const half = w * (1 - t * 0.5);                   // 先へ行くほど細る
            const stem = t <= 1
              ? smoothstep(half, half * 0.2, Math.abs(dx - cx2 - wob)) * (1 - smoothstep(0.7, 1, t) * 0.4)
              : 0;
            const bead = smoothstep(w * 1.9, w * 0.6,
              Math.hypot(dx - cx2 - wob, (dy - (top - len)) * 0.85));
            const g0 = Math.max(stem, bead);
            if (g0 > drip) { drip = g0; dripThick = 0.3 + bead * 0.45; }
          }
        }

        // ムラを芯の内側だけに掛ける。粒や垂れまで欠けさせると輪郭が汚れる
        a = clamp01(core * (0.78 + n * 0.3) + sat * 0.92 + drip * 0.85);
        // 厚み。0=乾いた薄い縁 1=溜まった芯。層ごとに厚みが違うので足さずに濃い方を採る
        const thick = clamp01(Math.max(coreThick + ring * 0.5, sat * satThick, drip * dripThick));
        // 厚み→色。薄いと乾いて茶に寄り、中間が一番赤く、厚いと黒赤に沈む
        if (thick < 0.5) {
          const k = thick / 0.5;
          r = lerp(0.33, 0.56, k); g = lerp(0.125, 0.1, k); b = lerp(0.105, 0.07, k);
        } else {
          const k = (thick - 0.5) / 0.5;
          r = lerp(0.56, 0.25, k); g = lerp(0.1, 0.04, k); b = lerp(0.07, 0.035, k);
        }
        const v = 0.85 + n * 0.3;
        r *= v; g *= v; b *= v;
        // 液体の厚みをそのまま高さにする。縁は表面張力で盛り上がるので、
        // 輪郭に細いハイライトが1本回って「濡れた縁」が読める
        h = thick * 0.9 + ring * 0.35;
        // 血は濡れている＝粗さが低い。乾いた薄い縁だけざらつかせる。
        // 床の血だまりは空を映すので一番滑らかにする
        // 下限を0.1まで落とすと太陽の鏡面反射が針のように尖り、ブルームの閾値を
        // 越えて血だまりが電球になる。周りのコンクリ(0.86〜0.98)より十分低ければ
        // 濡れて見えるので、そこまで下げない
        rough = lerp(pool ? 0.62 : 0.68, pool ? 0.28 : 0.34, thick);
        if (pool) {
          // 空の映り込みは粗さと法線で実際に出るようになったので、焼き込みは
          // 「そこに溜まりがある」と判る程度の補助に落とす。乗せすぎると
          // 明るい赤に転んで漫画になる
          const gl = smoothstep(0.26, 0.03, Math.hypot(dx + 0.13, (dy + 0.17) * 2.8)) * core;
          const gl2 = smoothstep(0.14, 0.02, Math.hypot((dx - 0.2) * 1.4, (dy - 0.24) * 3.0)) * core;
          const sheen = gl * 0.08 + gl2 * 0.05;
          r += sheen; g += sheen * 0.74; b += sheen * 0.64;
        }
      } else {
        // コンクリート。骨材ごと砕けて白い粉が飛ぶ。
        // ひびの本数と位相を種違いでずらさないと、2枚焼いても同じ星形が並ぶ
        const vph = variant * 2.31;
        const spokes = Math.pow(Math.abs(Math.sin(ang * (5.5 + variant) + Math.sin(ang * 3 + vph) * 1.6 + vph)), 3);
        const hole = smoothstep(0.16, 0.06, d);
        const crater = smoothstep(0.33 + n * 0.1, 0.12, d);
        const crack = smoothstep(0.3 + spokes * 0.34, 0.12, d) * spokes;
        const dust = smoothstep(0.85, 0.26, d) * (0.22 + n * 0.55) * 0.5;
        a = clamp01(hole + crater * 0.85 + crack * 0.5 + dust);
        let lum = lerp(0.8, 0.5, n);
        lum = lerp(lum, 0.42, crack * 0.7);
        lum = lerp(lum, 0.025, hole);
        r = lum; g = lum * 0.985; b = lum * 0.95;
        // 骨材ごと持って行かれるので、穴とすり鉢が実際に凹む。
        // ひびは溝なので浅く筋状に落とす
        h = -hole * 1.0 - crater * 0.34 - crack * 0.26 + dust * 0.03;
        // 割れたての断面は骨材が露出していて、元の面より粗い
        rough = lerp(0.86, 0.98, clamp01(crater * 0.8 + crack * 0.5));
      }

      const i = (y * size + x) * 4;
      data[i] = clamp01(r) * 255;
      data[i + 1] = clamp01(g) * 255;
      data[i + 2] = clamp01(b) * 255;
      data[i + 3] = clamp01(a) * 255;
      hgt[y * size + x] = h;
      arm[i] = 255;
      arm[i + 1] = clamp01(rough) * 255;
      arm[i + 2] = clamp01(metal) * 255;
      arm[i + 3] = 255;
    }
  }
  return {
    map: makeSprite(data, size),
    normalMap: makeSprite(heightToNormal(hgt, size, 3.2), size, false),
    armMap: makeSprite(arm, size, false),
    // 血は液膜なので凹凸を主張させない（縁の盛り上がりだけ拾えれば濡れて見える）。
    // 穴は逆に立てないと凹んで見えない
    ns: kind === 'blood' ? 0.55 : kind === 'bloodPool' ? 0.6 : kind === 'metal' ? 1.25 : 1.0,
  };
}

/* ------------------------------------------------------------ デカール */

class Decals {
  constructor(scene, max = 132, reserved = 18, splashes = 40) {
    this.max = max;
    this.pool = [];
    this.index = 0;
    // 3つの輪に割る。1本の輪で回すと、撃ち合い中に出る大量の弾痕が血を、
    // 血が弾痕を、互いに押し出して両方とも残らない。
    //   0..limit           弾痕（数が出るので回転が速い）
    //   limit..reservedStart 血の飛沫・染み
    //   reservedStart..max   血だまり（キル跡。数秒で消えるとキルが軽くなる）
    this.reserved = reserved;
    this.splashes = splashes;
    this.limit = max - reserved - splashes;
    this.splashStart = this.limit;
    this.splashIndex = 0;
    this.reservedStart = this.limit + splashes;
    this.reservedIndex = 0;
    // 素材ごとに壊れ方が違うので焼き分ける。コンクリだけは同じ穴が並ぶと
    // 目に付くので、種違いを2枚焼いて撃つたびに引き分ける
    this.maps = {
      concrete: decalTexture('concrete', 128, 0),
      concreteAlt: decalTexture('concrete', 128, 1),
      metal: decalTexture('metal'),
      wood: decalTexture('wood'),
      blood: decalTexture('blood', 128),
      bloodPool: decalTexture('bloodPool', 128),
    };
    const geo = new THREE.PlaneGeometry(1, 1);
    // Basicのままだと、日陰の壁に貼った弾痕だけが日向の明るさで光って
    // 「あとから貼ったシール」になる。受光させて初めて壁の一部になる。
    // 全種が同じマップ構成なので、貼り替えてもシェーダーは組み直されない
    const mat = new THREE.MeshStandardMaterial({
      map: this.maps.concrete.map,
      normalMap: this.maps.concrete.normalMap,
      roughnessMap: this.maps.concrete.armMap,
      metalnessMap: this.maps.concrete.armMap,
      roughness: 1,
      metalness: 1,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -8,
      side: THREE.DoubleSide,
    });
    // コンストラクタに数値で渡すとVector2が潰れるので、生成後に入れる
    mat.normalScale.set(1, 1);
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(geo, mat.clone());
      m.visible = false;
      m.renderOrder = 2;
      // 日陰の壁に貼った弾痕が日向の明るさで浮かないよう影は受ける。
      // 逆に落とす側に回すと1cm浮かせた板の影が本体からずれて二重に見える
      m.receiveShadow = true;
      m.castShadow = false;
      scene.add(m);
      this.pool.push({ mesh: m, life: 0, sx: 1, sy: 1, sz: 1, grow: 0, growT: 0 });
    }
  }

  /**
   * opts.persistent: 血だまりの輪に置く（弾痕にも飛沫にも押し出されない）
   * opts.splash: 血の飛沫の輪に置く（弾痕と食い合わない）
   * opts.grow: 秒。0.2倍から等倍までじわりと広がる（血だまりが染み出す表現）
   * opts.life: 表示時間の上書き
   */
  add(point, normal, scale = 0.26, kind = 'concrete', opts = null) {
    let slot;
    if (opts && opts.persistent) {
      slot = this.pool[this.reservedStart + this.reservedIndex];
      this.reservedIndex = (this.reservedIndex + 1) % this.reserved;
    } else if (opts && opts.splash) {
      slot = this.pool[this.splashStart + this.splashIndex];
      this.splashIndex = (this.splashIndex + 1) % this.splashes;
    } else {
      slot = this.pool[this.index];
      this.index = (this.index + 1) % this.limit;
    }
    const m = slot.mesh;
    // 面から少し浮かせないとZファイティングでチラつく
    m.position.copy(point).addScaledVector(normal, 0.012);
    _v1.copy(normal);
    // 法線と平行な上ベクトルを避けて向きを作る
    const up = Math.abs(_v1.y) > 0.95 ? _v2.set(1, 0, 0) : _v2.set(0, 1, 0);
    _m.lookAt(_v1.set(0, 0, 0), normal, up);
    m.quaternion.setFromRotationMatrix(_m);

    let set = this.maps[kind] ?? this.maps.concrete;
    if (kind === 'concrete' && Math.random() < 0.45) set = this.maps.concreteAlt;
    if (m.material.map !== set.map) {
      // マップの有無は変わらないのでneedsUpdateは要らない（要ると毎回シェーダーが組み直される）
      m.material.map = set.map;
      m.material.normalMap = set.normalMap;
      m.material.roughnessMap = set.armMap;
      m.material.metalnessMap = set.armMap;
    }
    m.material.normalScale.set(set.ns, set.ns);

    if (kind === 'blood') {
      // 垂れを下に落としたいので、壁の血だけは回さない
      const s = scale * (0.7 + Math.random() * 0.7);
      slot.sx = s * (0.85 + Math.random() * 0.4); slot.sy = s; slot.sz = s;
      slot.life = 40 + Math.random() * 14;
    } else {
      m.rotateZ(Math.random() * Math.PI * 2);
      const s = scale * (0.8 + Math.random() * 0.5);
      // わずかに縦横比を崩すと、同じ絵が並んでいるのに気付かれにくい
      slot.sx = s * (0.9 + Math.random() * 0.25); slot.sy = s; slot.sz = s;
      slot.life = kind === 'bloodPool' ? 44 + Math.random() * 16 : 22 + Math.random() * 8;
    }
    if (opts && opts.life) slot.life = opts.life;

    slot.grow = (opts && opts.grow) || 0;
    slot.growT = 0;
    if (slot.grow > 0) {
      m.scale.set(slot.sx * 0.2, slot.sy * 0.2, slot.sz * 0.2);
      m.material.opacity = 0.5;
    } else {
      m.scale.set(slot.sx, slot.sy, slot.sz);
      m.material.opacity = 1;
    }
    m.visible = true;
  }

  update(dt) {
    for (const slot of this.pool) {
      if (!slot.mesh.visible) continue;
      slot.life -= dt;
      if (slot.grow > 0) {
        slot.growT += dt;
        const k = smoothstep(0, 1, clamp01(slot.growT / slot.grow));
        const s = 0.2 + 0.8 * k;
        slot.mesh.scale.set(slot.sx * s, slot.sy * s, slot.sz * s);
        slot.mesh.material.opacity = 0.5 + 0.5 * k;
        if (slot.growT >= slot.grow) slot.grow = 0;
      }
      if (slot.life < 3) slot.mesh.material.opacity = Math.max(0, slot.life / 3);
      if (slot.life <= 0) slot.mesh.visible = false;
    }
  }

  clear() { for (const s of this.pool) { s.mesh.visible = false; s.life = 0; s.grow = 0; } }
}

/* ------------------------------------------------------------ 曳光弾 */

// 板1枚に色を塗るのではなく、芯（白熱）と滲み（橙）をシェーダーで分ける。
// 芯だけがブルームのしきい値を越えるので、光っているのは細い線だけになる。
const TRACER_VS = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const TRACER_FS = /* glsl */`
  uniform vec3 uCore;
  uniform vec3 uGlow;
  uniform float uOpacity;
  varying vec2 vUv;
  void main() {
    float x = abs(vUv.x - 0.5) * 2.0;
    float k = max(1.0 - x, 0.0);
    float core = pow(k, 14.0);
    float glow = pow(k, 2.5);
    float head = smoothstep(0.35, 1.0, vUv.y);   // 先端ほど熱い
    float tail = smoothstep(0.0, 0.45, vUv.y);   // 尾は細く消える
    float a = (core + glow * 0.3) * uOpacity * tail;
    vec3 c = uCore * core * (1.0 + head * 1.5) + uGlow * glow * 0.55;
    gl_FragColor = vec4(c, a);
  }
`;

class Tracers {
  constructor(scene, max = 48) {
    this.max = max;
    this.items = [];
    this.index = 0;
    const geo = new THREE.PlaneGeometry(1, 1);
    geo.translate(0, 0.5, 0);      // 原点から+Y方向に伸びる形にする
    for (let i = 0; i < max; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uCore: { value: new THREE.Color(1.0, 0.95, 0.86) },
          uGlow: { value: new THREE.Color(0xffd9a0) },
          uOpacity: { value: 0 },
        },
        vertexShader: TRACER_VS,
        fragmentShader: TRACER_FS,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 3;
      scene.add(m);
      this.items.push({
        mesh: m, origin: new THREE.Vector3(), dir: new THREE.Vector3(),
        total: 0, head: 0, len: 0, speed: 0, width: 0.045,
      });
    }
  }

  add(from, to, width = 0.045, color = 0xffd9a0) {
    const it = this.items[this.index];
    this.index = (this.index + 1) % this.max;
    it.dir.subVectors(to, from);
    it.total = it.dir.length();
    if (it.total < 0.01) return;
    it.dir.normalize();
    it.origin.copy(from);
    it.speed = 360 + Math.random() * 90;
    // 弾は瞬間移動しない。飛んでいる途中の一部だけを描くので、速いほど長い筋になる
    it.len = Math.min(it.speed * 0.017, it.total * 0.9);
    it.head = it.len * 0.35;       // 銃口に張り付いた状態から始めない
    it.width = width;
    it.mesh.material.uniforms.uGlow.value.setHex(color);
    it.mesh.material.uniforms.uOpacity.value = 1;
    it.mesh.visible = true;
  }

  // 進行方向を軸にカメラへ向ける（板が横を向くと消えてしまうので毎フレーム回す）
  update(dt, camera) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.head += it.speed * dt;
      const tail = it.head - it.len;
      if (tail >= it.total) { it.mesh.visible = false; continue; }
      const a = Math.max(tail, 0);
      const b = Math.min(it.head, it.total);
      const segLen = b - a;
      if (segLen <= 0.001) continue;

      it.mesh.position.copy(it.origin).addScaledVector(it.dir, a);
      // 着弾点に吸い込まれる直前で薄くする
      it.mesh.material.uniforms.uOpacity.value = 0.95 * clamp01((it.total - tail) / Math.max(it.len, 0.01));

      _v1.subVectors(camera.position, it.mesh.position);
      const dist = _v1.length() || 1;
      _v1.multiplyScalar(1 / dist);
      _v2.crossVectors(it.dir, _v1).normalize();       // 板の横方向
      const forward = _v1.crossVectors(_v2, it.dir).normalize();
      _m.makeBasis(_v2, it.dir, forward);
      it.mesh.quaternion.setFromRotationMatrix(_m);
      // 遠いと1画素を割って点滅するので、距離に応じて最低幅を確保する
      it.mesh.scale.set(Math.max(it.width, dist * 0.0022), segLen, 1);
    }
  }

  clear() { for (const it of this.items) { it.mesh.visible = false; } }
}

/* ------------------------------------------------------------- 薬莢 */

class Casings {
  constructor(scene, max = 26) {
    this.items = [];
    this.index = 0;
    const geo = new THREE.CylinderGeometry(0.011, 0.012, 0.045, 6, 1);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xc8a24a, metalness: 1, roughness: 0.32,
    });
    for (let i = 0; i < max; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.castShadow = false;
      scene.add(m);
      this.items.push({
        mesh: m, life: 0,
        vel: new THREE.Vector3(), spin: new THREE.Vector3(), bounced: 0, rest: false,
      });
    }
    this.max = max;
  }

  eject(pos, dir, camera) {
    const it = this.items[this.index];
    this.index = (this.index + 1) % this.max;
    it.mesh.position.copy(pos);
    // 右斜め後ろ上に飛ばす
    _v1.set(1, 0, 0).applyQuaternion(camera.quaternion);
    _v2.set(0, 1, 0).applyQuaternion(camera.quaternion);
    it.vel.copy(_v1).multiplyScalar(2.1 + Math.random() * 0.9)
      .addScaledVector(_v2, 1.5 + Math.random() * 0.7)
      .addScaledVector(dir, -0.5 + Math.random() * 0.4);
    it.spin.set(
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26,
      (Math.random() - 0.5) * 26,
    );
    it.life = 4.5;
    it.bounced = 0;
    it.rest = false;
    it.mesh.visible = true;
    it.mesh.scale.set(1, 1, 1);
    it.mesh.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
  }

  update(dt, octree, onLand, camPos) {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.life -= dt;
      if (it.life <= 0) { it.mesh.visible = false; continue; }
      // 床の薬莢が忽然と消えると気付かれる。最後の0.5秒で畳んで見えなくする
      if (it.life < 0.5) { const k = it.life * 2; it.mesh.scale.set(k, k, k); }
      if (it.rest) continue;      // 転がり終わったものは計算しない

      it.vel.y -= 18 * dt;
      it.mesh.position.addScaledVector(it.vel, dt);
      it.mesh.rotation.x += it.spin.x * dt;
      it.mesh.rotation.y += it.spin.y * dt;
      it.mesh.rotation.z += it.spin.z * dt;

      // 速い間は軸方向に伸ばして残像に見せる。実際に軌跡を描くより安い
      const sp = it.vel.length();
      const stretch = 1 + Math.min(sp * 0.1, 1.1);
      // 目のすぐ前では描かない。覗いている間の排莢口は目から14cmしかないので、
      // 4.5cmの薬莢がそのまま出ると画面の22.6%を金色で塞ぐ（実測。腰だめは66cmなので2%）。
      // しかも伸ばす倍率が最大2.1倍なので、覗いて撃つ間ずっと視界を帯が横切る。
      // 落下音も跳ね返りもそのまま進めて、絵だけ離れてから出す
      const near = camPos ? clamp01((camPos.distanceTo(it.mesh.position) - 0.25) / 0.20) : 1;
      it.mesh.scale.set(near, stretch * near, near);

      // 地面や物に当たったら跳ねさせる。1回目と2回目だけチャリンと鳴らす
      _sphere.center.copy(it.mesh.position);
      _sphere.radius = 0.02;
      const hit = octree.sphereIntersect(_sphere);
      if (hit) {
        it.mesh.position.addScaledVector(hit.normal, hit.depth);
        const vn = it.vel.dot(hit.normal);
        // 跳ねるたびに反発を落とす。小さく何度も跳ねて止まる
        const e = 1.45 - Math.min(it.bounced, 3) * 0.22;
        it.vel.addScaledVector(hit.normal, -vn * e);
        it.vel.multiplyScalar(0.55);
        it.spin.multiplyScalar(0.55);
        if (it.bounced < 2 && Math.abs(vn) > 0.5) onLand?.(it.mesh.position, it.bounced);
        it.bounced++;
        if (it.vel.lengthSq() < 0.25 || it.bounced > 5) {
          it.vel.set(0, 0, 0);
          it.spin.set(0, 0, 0);
          it.rest = true;
          it.mesh.scale.set(1, 1, 1);
        }
      }
    }
  }

  clear() { for (const it of this.items) { it.mesh.visible = false; it.rest = false; } }
}

/* ------------------------------------------------------- 素材ごとの設定 */

// 火花・粉塵・破片の量と色。撃つ相手が変わったと分かる程度に差を付ける
const SURFACE = {
  concrete: {
    dust: [0.66, 0.63, 0.57], dust1: [0.42, 0.4, 0.37],
    sparks: 9, puff: 6, crawl: 7, motes: 5, debris: 7,
    flash: 0.5, decal: 'concrete', decalScale: 0.28,
  },
  metal: {
    dust: [0.5, 0.5, 0.52], dust1: [0.3, 0.3, 0.32],
    sparks: 26, puff: 2, crawl: 2, motes: 3, debris: 4,
    flash: 1.15, decal: 'metal', decalScale: 0.24,
  },
  wood: {
    dust: [0.46, 0.34, 0.19], dust1: [0.28, 0.2, 0.11],
    sparks: 3, puff: 5, crawl: 5, motes: 6, debris: 10,
    flash: 0.22, decal: 'wood', decalScale: 0.3,
  },
};

/* ---------------------------------------------------------------- API */

export class Effects {
  constructor(scene, octree) {
    this.scene = scene;
    this.octree = octree;

    const spark = radialTexture(64, 2.6);
    const chunk = radialTexture(48, 1.4, 0.55);   // 破片は輪郭が要るので硬め
    const smoke = smokeTexture(128);

    // 火花と着弾閃光は自分で光っているので受光させない。煙と破片・血の粒は受光させる
    this.sparks = new ParticleGroup(2000, spark, true, true);
    this.smoke = new ParticleGroup(1300, smoke, false, false, true);
    this.debris = new ParticleGroup(1200, chunk, false, true, true);
    // 跳ねさせるのは破片・血・火花。煙は数が多いうえ当たっても絵が変わらないので当てない。
    // 判定本数はParticleGroup側で1フレーム20本に絞ってあるので、群を増やしても頭打ちになる
    this.debris.octree = octree;
    // 床を舐めて転がる残り火が出ると、着弾が「面に当たった」ことになる。
    // 素通りする火花は空中で消えるだけで、当たった面の情報を何も出さない
    this.sparks.octree = octree;
    this.debris.onRest = (x, y, z, n) => {
      // 主役の痕跡は_splatterと血だまりが受け持つので、ここは散らばりを足す脇役。
      // 全部残すと床が水玉だらけになるうえ飛沫の輪が1発で1周してしまう
      if (Math.random() < 0.3) {
        // decals.add側で_v1と_v2を使うので、ここでは別のスクラッチを渡す
        _n.copy(n);
        _p.set(x, y, z);
        // 床に落ちた粒は垂れない。上向きの面だけ血だまり側のテクスチャに切り替える
        const kind = n.y > 0.5 ? 'bloodPool' : 'blood';
        this.decals.add(_p, _n, 0.1 + Math.random() * 0.14, kind, SPLASH);
      }
    };
    scene.add(this.smoke.points);
    scene.add(this.debris.points);
    scene.add(this.sparks.points);   // 加算は最後に描く

    this.decals = new Decals(scene);
    this.tracers = new Tracers(scene);
    this.casings = new Casings(scene);
    this.onCasingLand = null;

    this.muzzleHeat = 0;      // 連射するほど溜まる。銃口の残り煙の量になる
    this._impacts = 0;        // 同フレームの着弾数。散弾で粒が溢れるのを抑える

    // 粒の陰影に使う太陽。既定はmain.jsのSUN_DIRと同じ向きにしてある。
    // ずれても粒の明暗の向きが違うだけなので、必要ならsetSun()で上書きする
    this.sunDir = new THREE.Vector3(-0.78, 0.46, -0.34).normalize();
    this._litGroups = [this.smoke, this.debris];
    // 銃口煙をプレイヤーの分だけ溜めるためにカメラ位置を覚えておく。
    // 敵の発砲までheatに積むと、敵が撃つほど自分の銃口が白く濁る
    this._camPos = new THREE.Vector3();
  }

  setPixelScale(height) {
    const s = height * 0.55;
    for (const g of [this.sparks, this.smoke, this.debris]) {
      g.material.uniforms.uScale.value = s;
      g.material.uniforms.uStretch.value = height * 0.5;
      g.material.uniforms.uMaxSize.value = height * 0.55;
    }
  }

  /** 着弾。閃光→火花→舞い上がる粉→這う粉→細塵→破片→残留、と層で重ねる */
  impact(point, normal, kind = 'concrete') {
    if (kind === 'flesh') { this._blood(point, normal); return; }

    const cfg = SURFACE[kind] ?? SURFACE.concrete;
    const rand = (s) => (Math.random() - 0.5) * s;
    // 散弾は1発で8回ここに来る。4発目以降は間引かないと粒だけで画面が埋まる
    const q = this._impacts++ < 3 ? 1 : 0.35;
    const cnt = (base) => Math.max(1, Math.round(base * q));

    const px = point.x + normal.x * 0.02;
    const py = point.y + normal.y * 0.02;
    const pz = point.z + normal.z * 0.02;
    this._basis(normal);
    const dc = cfg.dust, dc1 = cfg.dust1;

    /* (1) 閃光。1フレームだけ光って消える。これが無いと当たった瞬間が判らない */
    this.sparks.spawn({
      x: px, y: py, z: pz, vx: 0, vy: 0, vz: 0,
      r: 3.4 * cfg.flash, g: 2.1 * cfg.flash, b: 1.0 * cfg.flash,
      r1: 2.2 * cfg.flash, g1: 0.8 * cfg.flash, b1: 0.15 * cfg.flash,
      size0: 0.34 * (0.7 + cfg.flash * 0.6), size1: 0.1,
      life: 0.05 + Math.random() * 0.03, fade: FADE_FLASH,
    });

    /* (2) 高速の火花。速度で伸びるので線に見える。冷えながら赤へ落とす */
    const sparkCount = cnt(cfg.sparks);
    for (let i = 0; i < sparkCount; i++) {
      const speed = 4 + Math.random() * 11;
      this.sparks.spawn({
        x: px, y: py, z: pz,
        vx: (normal.x + rand(1.5)) * speed,
        vy: (normal.y + rand(1.5)) * speed + 1,
        vz: (normal.z + rand(1.5)) * speed,
        r: 3.2, g: 1.8 + Math.random() * 0.7, b: 0.45,
        r1: 2.0, g1: 0.32, b1: 0.04,
        size0: 0.05, size1: 0.006, life: 0.16 + Math.random() * 0.34,
        gravity: 16, drag: 1.9, fade: FADE_OUT2, bounce: 2,
      });
    }

    /* (3) 舞い上がる粉塵。法線方向に噴き上がる本体 */
    for (let i = 0; i < cnt(cfg.puff); i++) {
      this.smoke.spawn({
        x: px, y: py, z: pz,
        vx: normal.x * 1.8 + rand(1.1), vy: normal.y * 1.8 + rand(1.1) + 0.5, vz: normal.z * 1.8 + rand(1.1),
        r: dc[0], g: dc[1], b: dc[2], r1: dc1[0], g1: dc1[1], b1: dc1[2],
        size0: 0.08, size1: 0.7 + Math.random() * 0.5, life: 0.5 + Math.random() * 0.5,
        rot: Math.random() * 6.28, spin: rand(2.5), gravity: -0.5, drag: 2.8,
        fade: FADE_INOUT, alpha: 0.6,
      });
    }

    /* (4) 面を這う粉。接平面に低く広がってから立ち上る。これが無いと煙玉になる */
    for (let i = 0; i < cnt(cfg.crawl); i++) {
      const a = Math.random() * 6.283;
      const sp = 2.4 + Math.random() * 2.2;
      const cx = _t1.x * Math.cos(a) + _t2.x * Math.sin(a);
      const cy = _t1.y * Math.cos(a) + _t2.y * Math.sin(a);
      const cz = _t1.z * Math.cos(a) + _t2.z * Math.sin(a);
      this.smoke.spawn({
        x: px, y: py, z: pz,
        vx: cx * sp, vy: cy * sp + 0.1, vz: cz * sp,
        r: dc[0] * 0.95, g: dc[1] * 0.95, b: dc[2] * 0.95,
        r1: dc1[0], g1: dc1[1], b1: dc1[2],
        size0: 0.1, size1: 0.55 + Math.random() * 0.45, life: 0.7 + Math.random() * 0.6,
        rot: Math.random() * 6.28, spin: rand(1.6),
        // 横に走る勢いを抵抗で殺してから、負の重力でゆっくり起き上がらせる
        gravity: -0.55, drag: 4.5, fade: FADE_INOUT, alpha: 0.5,
      });
    }

    if (q < 1) { this.decals.add(point, normal, cfg.decalScale, cfg.decal); return; }

    /* (5) ゆっくり落ちる細塵。着弾が終わった後も空中に残って余韻を作る */
    for (let i = 0; i < cfg.motes; i++) {
      this.smoke.spawn({
        x: px + rand(0.2), y: py + rand(0.2), z: pz + rand(0.2),
        vx: normal.x * 0.5 + rand(0.9), vy: 0.3 + rand(0.5), vz: normal.z * 0.5 + rand(0.9),
        r: dc[0], g: dc[1], b: dc[2], r1: dc1[0], g1: dc1[1], b1: dc1[2],
        size0: 0.03, size1: 0.12, life: 1.4 + Math.random() * 1.4,
        rot: Math.random() * 6.28, spin: rand(0.8),
        gravity: 0.35, drag: 1.4, fade: FADE_INOUT, alpha: 0.28,
      });
    }

    /* (6) 面に残る粉。上向きの面だけ、薄く広がって長く残る */
    if (normal.y > 0.35) {
      for (let i = 0; i < 2; i++) {
        this.smoke.spawn({
          x: px + rand(0.15), y: py + 0.03, z: pz + rand(0.15),
          vx: rand(0.5), vy: 0.05, vz: rand(0.5),
          r: dc[0] * 0.9, g: dc[1] * 0.9, b: dc[2] * 0.9,
          r1: dc1[0] * 0.8, g1: dc1[1] * 0.8, b1: dc1[2] * 0.8,
          size0: 0.3, size1: 0.85, life: 2.2 + Math.random() * 1.6,
          rot: Math.random() * 6.28, spin: rand(0.4),
          gravity: 0.12, drag: 5, fade: FADE_HOLD, alpha: 0.16,
        });
      }
    }

    /* (7) 破片。跳ねさせると一気に実物っぽくなる */
    for (let i = 0; i < cfg.debris; i++) {
      const sp = 2 + Math.random() * 5.5;
      this.debris.spawn({
        x: px, y: py, z: pz,
        vx: (normal.x + rand(1.4)) * sp,
        vy: (normal.y + rand(1.4)) * sp + 1.5,
        vz: (normal.z + rand(1.4)) * sp,
        r: dc[0] * 0.5, g: dc[1] * 0.5, b: dc[2] * 0.5,
        r1: dc1[0] * 0.45, g1: dc1[1] * 0.45, b1: dc1[2] * 0.45,
        size0: 0.03 + Math.random() * 0.02, size1: 0.022,
        life: 0.9 + Math.random() * 0.8,
        gravity: 16, drag: 0.5, fade: FADE_LINEAR, bounce: 2,
      });
    }

    this.decals.add(point, normal, cfg.decalScale, cfg.decal);

    /* (8) 穴の脇に小さく持って行かれた欠け。真円の穴が1枚だけだと、
           どれだけ描き込んでも「穴の絵を貼った」に見える。面が砕けた事故にするには
           主穴の外にもう一段小さい破壊がいる。金属は砕けないので出さない */
    if (kind !== 'metal' && Math.random() < 0.45) {
      const a = Math.random() * 6.283;
      // 離しすぎると角を回った先の空中に板が浮くので、主穴の半径程度に留める
      const off = cfg.decalScale * (0.3 + Math.random() * 0.25);
      _p.set(
        point.x + (_t1.x * Math.cos(a) + _t2.x * Math.sin(a)) * off,
        point.y + (_t1.y * Math.cos(a) + _t2.y * Math.sin(a)) * off,
        point.z + (_t1.z * Math.cos(a) + _t2.z * Math.sin(a)) * off,
      );
      this.decals.add(_p, normal, cfg.decalScale * (0.3 + Math.random() * 0.22), cfg.decal);
    }
  }

  /** 血。着弾方向に抜けるミスト、遅れて飛ぶ粒、壁に付く染みを分ける */
  _blood(point, normal) {
    const rand = (s) => (Math.random() - 0.5) * s;
    // normalは撃った側を向いている。血は反対（弾の進行方向）へ抜ける
    const ex = -normal.x, ey = -normal.y, ez = -normal.z;
    const q = this._impacts++ < 3 ? 1 : 0.4;
    const cnt = (base) => Math.max(1, Math.round(base * q));

    // (0) 抜けた先の面に飛沫を焼く。壁に何も残らないと当てた事実が消える。
    //     間引きが始まったフレーム（散弾の4発目以降）は撃たない。レイが増えると重い
    if (q === 1) this._splatter(point, ex, ey, ez);

    // (1) 命中の瞬間だけ出るミスト。細かくて速く、すぐ消える
    for (let i = 0; i < cnt(9); i++) {
      const sp = 2.5 + Math.random() * 4.5;
      this.smoke.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: (ex + rand(0.8)) * sp, vy: (ey + rand(0.8)) * sp + 0.6, vz: (ez + rand(0.8)) * sp,
        r: 0.32, g: 0.05, b: 0.045, r1: 0.12, g1: 0.02, b1: 0.02,
        size0: 0.05, size1: 0.34 + Math.random() * 0.2, life: 0.22 + Math.random() * 0.22,
        rot: Math.random() * 6.28, spin: rand(5), gravity: 2.2, drag: 5, fade: FADE_INOUT, alpha: 0.55,
      });
    }

    // (2) 手前に少しだけ跳ね返る。抜けた方向にしか出ないと嘘に見える
    for (let i = 0; i < cnt(4); i++) {
      const sp = 1.5 + Math.random() * 2.5;
      this.debris.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: (normal.x + rand(1.2)) * sp, vy: (normal.y + rand(1.2)) * sp + 1.2, vz: (normal.z + rand(1.2)) * sp,
        r: 0.30, g: 0.045, b: 0.038, r1: 0.15, g1: 0.022, b1: 0.02,
        size0: 0.010 + Math.random() * 0.026, size1: 0.014, life: 0.3 + Math.random() * 0.22,
        gravity: 14, drag: 1.3, fade: FADE_LINEAR,
      });
    }

    if (q < 1) return;

    // (3) 遅れて飛ぶ粒。重いので弧を描き、当たった面に染みを残す。
    //     粒径を揃えたまま長く飛ばすと、同じ大きさの赤い短冊が空中で止まって
    //     紙吹雪に見える。大小を大きく散らし、抵抗を上げて滞空させない
    for (let i = 0; i < 14; i++) {
      const sp = 3 + Math.random() * 7;
      const r0 = 0.012 + Math.random() * 0.033;
      this.debris.spawn({
        x: point.x, y: point.y, z: point.z,
        vx: (ex + rand(1.1)) * sp, vy: (ey + rand(1.1)) * sp + 1.6, vz: (ez + rand(1.1)) * sp,
        r: 0.33, g: 0.055, b: 0.045, r1: 0.17, g1: 0.026, b1: 0.022,
        size0: r0, size1: r0 * 0.7, life: 0.35 + Math.random() * 0.3,
        gravity: 15, drag: 1.2, fade: FADE_LINEAR, bounce: 1, tag: 1,
      });
    }

    // (4) 空中に薄く残る霧。撃った直後の余韻
    for (let i = 0; i < 3; i++) {
      this.smoke.spawn({
        x: point.x + rand(0.2), y: point.y + rand(0.3), z: point.z + rand(0.2),
        vx: ex * 0.6 + rand(0.5), vy: rand(0.4), vz: ez * 0.6 + rand(0.5),
        r: 0.21, g: 0.04, b: 0.038, r1: 0.09, g1: 0.018, b1: 0.018,
        size0: 0.2, size1: 0.6, life: 0.9 + Math.random() * 0.7,
        rot: Math.random() * 6.28, spin: rand(1), gravity: 0.6, drag: 3.5,
        fade: FADE_INOUT, alpha: 0.16,
      });
    }
  }

  /**
   * 面を探して血のデカールを1枚置く。当たらなければ何もしない。
   * 戻り値は置けたかどうか（血だまりの再挑戦判定に使う）
   * @param ox,oy,oz レイの始点 / dx,dy,dz 正規化済みの向き
   */
  _mark(ox, oy, oz, dx, dy, dz, maxDist, scale, kind, opts) {
    const oct = this.octree;
    if (!oct) return false;
    _ray.origin.set(ox, oy, oz);
    _ray.direction.set(dx, dy, dz);
    const hit = oct.rayIntersect(_ray);
    if (!hit || hit.distance > maxDist) return false;
    _p.copy(hit.position);
    hit.triangle.getNormal(_n);
    // Octreeの三角形は巻き順が揃っていないので、レイと向き合う側へ倒す
    let dot = _n.x * dx + _n.y * dy + _n.z * dz;
    if (dot > 0) { _n.negate(); dot = -dot; }
    // 面をかすめただけの角度で貼ると、板が細長く潰れて紙を立てたように見える
    if (dot > -0.22) return false;
    // 飛んだ距離だけ散らばりが広がる。近い壁は濃く小さく、遠い壁は広く薄く
    let s = scale;
    if (opts && opts.spread) s = Math.min(scale + hit.distance * opts.spread, opts.maxScale || 0.9);
    this.decals.add(_p, _n, s, kind, opts);
    return true;
  }

  /** 被弾した敵の背後へ抜ける飛沫。当たった面に大きめの染みを焼く */
  _splatter(point, ex, ey, ez) {
    // 体の厚み分だけ前に出さないと、敵自身のいた位置の床を拾ってしまう
    const hit = this._mark(
      point.x + ex * 0.25, point.y + ey * 0.25, point.z + ez * 0.25,
      ex, ey, ez, 3.4, 0.5, 'blood', SPLATTER,
    );
    // 至近の壁だけ、少し離れた位置にもう1枚散らして単調さを消す
    if (hit && Math.random() < 0.5) {
      const s = 0.22 + Math.random() * 0.18;
      this._mark(
        point.x + ex * 0.25 + (Math.random() - 0.5) * 0.5,
        point.y + ey * 0.25 + (Math.random() - 0.5) * 0.5,
        point.z + ez * 0.25 + (Math.random() - 0.5) * 0.5,
        ex, ey, ez, 3.4, s, 'blood', SPLASH,
      );
    }
  }

  /**
   * 死体の下に広がる血だまり。腰のワールド位置から真下へ落とす。
   * 弾痕に押し出されない予約スロットを使い、1.5秒かけてじわりと広がる
   */
  /**
   * 爆発。閃光・火の粉・煙の3層で作る。
   * 判定はサーバーが持っているので、ここは見た目だけを受け持つ。
   * 位置は爆心（サーバーが決めた座標）で、半径は演出上の見かけの大きさ
   */
  explosion(pos, radius = 9.5) {
    const rand = (s) => (Math.random() - 0.5) * s;

    // (1) 閃光。1フレームだけ大きく白く光る。爆発の「瞬間」はこれで決まる
    this.sparks.spawn({
      x: pos.x, y: pos.y, z: pos.z, vx: 0, vy: 0, vz: 0,
      r: 6.0, g: 4.4, b: 2.2, r1: 3.0, g1: 1.2, b1: 0.2,
      size0: radius * 0.55, size1: radius * 0.2,
      life: 0.07 + Math.random() * 0.04, fade: FADE_FLASH,
    });

    // (2) 火の粉。全方向へ飛ばす。上に偏らせると「吹き上がる」に見える
    for (let i = 0; i < 70; i++) {
      const sp = 6 + Math.random() * 16;
      const ux = rand(2), uy = Math.random() * 1.6 - 0.2, uz = rand(2);
      const l = Math.hypot(ux, uy, uz) || 1;
      this.sparks.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: (ux / l) * sp, vy: (uy / l) * sp + 2, vz: (uz / l) * sp,
        r: 3.4, g: 1.9 + Math.random() * 0.6, b: 0.4,
        r1: 1.4, g1: 0.35, b1: 0.05,
        size0: 0.05 + Math.random() * 0.05, size1: 0.012,
        life: 0.4 + Math.random() * 0.7, fade: FADE_LINEAR,
        gravity: 16, drag: 0.9, bounce: 1,
      });
    }

    // (3) 煙。遅く広がって長く残る。火の粉が消えた後に爆心を示し続ける
    for (let i = 0; i < 26; i++) {
      const sp = 1.5 + Math.random() * 4;
      const ux = rand(2), uy = Math.random() * 1.2, uz = rand(2);
      const l = Math.hypot(ux, uy, uz) || 1;
      this.smoke.spawn({
        x: pos.x, y: pos.y + 0.2, z: pos.z,
        vx: (ux / l) * sp, vy: (uy / l) * sp + 1.2, vz: (uz / l) * sp,
        r: 0.30, g: 0.28, b: 0.26, r1: 0.10, g1: 0.10, b1: 0.10,
        size0: 0.5 + Math.random() * 0.6, size1: 3.0 + Math.random() * 1.6,
        life: 1.2 + Math.random() * 1.4, fade: FADE_INOUT,
        gravity: -0.5, drag: 1.5,
      });
    }
  }

  bloodPool(pos, scale = 1.05) {
    const s = scale * (0.85 + Math.random() * 0.35);
    let placed = this._mark(pos.x, pos.y + 0.1, pos.z, 0, -1, 0, 2.6, s, 'bloodPool', POOL_OPTS);
    // 腰の真下が木箱の側面や瓦礫で塞がれていると1本目のレイが外れる。
    // キルの痕跡が丸ごと消えるのは一番もったいないので、周囲を数回探し直す
    if (!placed) {
      for (let k = 0; k < 4 && !placed; k++) {
        const a = k * 1.5708 + Math.random() * 0.5;
        placed = this._mark(
          pos.x + Math.cos(a) * 0.45, pos.y + 0.1, pos.z + Math.sin(a) * 0.45,
          0, -1, 0, 2.6, s * 0.8, 'bloodPool', POOL_OPTS,
        );
      }
    }
    if (!placed) return false;
    // 溜まる前に周りへ跳ねる重い粒。落ちた先にonRest経由で小さな血痕が残る
    for (let i = 0; i < 7; i++) {
      const a = Math.random() * 6.283;
      const sp = 0.8 + Math.random() * 1.8;
      const r0 = 0.012 + Math.random() * 0.028;
      this.debris.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: Math.cos(a) * sp, vy: 0.8 + Math.random() * 1.4, vz: Math.sin(a) * sp,
        r: 0.30, g: 0.045, b: 0.038, r1: 0.15, g1: 0.022, b1: 0.02,
        size0: r0, size1: r0 * 0.75, life: 0.45 + Math.random() * 0.35,
        gravity: 15, drag: 1.0, fade: FADE_LINEAR, bounce: 1, tag: 1,
      });
    }
    return true;
  }

  /**
   * 銃口の閃光と発射煙。連射するほど煙が溜まって残る。
   * heatは自分の銃の焼け具合なので、敵の発砲では積まない。
   * 敵が撃つほど自分の銃口が白く濁るのは明らかにおかしい。
   * isPlayerを渡さない場合はカメラからの距離で判定する（自分の銃口は常に手元）
   */
  muzzle(pos, dir, isPlayer) {
    const rand = (s) => (Math.random() - 0.5) * s;
    const mine = isPlayer === undefined
      ? this._camPos.distanceToSquared(pos) < 2.56
      : !!isPlayer;
    if (mine) this.muzzleHeat = Math.min(1.6, this.muzzleHeat + 0.3);
    const heat = mine ? this.muzzleHeat : 0;

    // 燃え残りの粉が前に吹き出す
    for (let i = 0; i < 5; i++) {
      this.sparks.spawn({
        x: pos.x, y: pos.y, z: pos.z,
        vx: dir.x * (6 + Math.random() * 9) + rand(3),
        vy: dir.y * (6 + Math.random() * 9) + rand(3),
        vz: dir.z * (6 + Math.random() * 9) + rand(3),
        r: 3.5, g: 1.9, b: 0.6, r1: 2.2, g1: 0.4, b1: 0.05,
        size0: 0.05, size1: 0.008, life: 0.06 + Math.random() * 0.08,
        gravity: 4, drag: 5, fade: FADE_OUT2,
      });
    }

    // 前に抜ける発射煙
    for (let i = 0; i < 2; i++) {
      this.smoke.spawn({
        x: pos.x + dir.x * 0.15, y: pos.y + dir.y * 0.15, z: pos.z + dir.z * 0.15,
        vx: dir.x * 2.4 + rand(0.7), vy: dir.y * 2.4 + rand(0.7) + 0.3, vz: dir.z * 2.4 + rand(0.7),
        r: 0.52, g: 0.51, b: 0.49, r1: 0.34, g1: 0.34, b1: 0.34,
        size0: 0.06, size1: 0.5, life: 0.35 + Math.random() * 0.3,
        rot: Math.random() * 6.28, spin: rand(3), gravity: -0.5, drag: 3.2,
        fade: FADE_INOUT, alpha: 0.35,
      });
    }

    // 溜まって残る煙。撃ち続けると銃口周りが白く濁っていく
    if (heat > 0.45) {
      const n = heat > 1.1 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        this.smoke.spawn({
          x: pos.x + dir.x * 0.1 + rand(0.08), y: pos.y + dir.y * 0.1 + rand(0.06), z: pos.z + dir.z * 0.1 + rand(0.08),
          vx: dir.x * 0.5 + rand(0.4), vy: 0.35 + rand(0.2), vz: dir.z * 0.5 + rand(0.4),
          r: 0.55, g: 0.55, b: 0.54, r1: 0.36, g1: 0.36, b1: 0.37,
          size0: 0.1, size1: 0.34 + heat * 0.3, life: 0.9 + heat * 1.3,
          rot: Math.random() * 6.28, spin: rand(0.8), gravity: -0.35, drag: 2.2,
          fade: FADE_HOLD, alpha: 0.04 + heat * 0.06,
        });
      }
    }
  }

  tracer(from, to, width, color) { this.tracers.add(from, to, width, color); }

  ejectCasing(pos, dir, camera) {
    this.casings.eject(pos, dir, camera);
    // 排莢口から抜ける熱気。1粒でも「今出た」感が出る
    this.smoke.spawn({
      x: pos.x, y: pos.y, z: pos.z,
      vx: (Math.random() - 0.5) * 0.3, vy: 0.5, vz: (Math.random() - 0.5) * 0.3,
      r: 0.6, g: 0.6, b: 0.58, r1: 0.4, g1: 0.4, b1: 0.4,
      size0: 0.04, size1: 0.22, life: 0.5 + Math.random() * 0.3,
      rot: Math.random() * 6.28, spin: (Math.random() - 0.5) * 2, gravity: -0.4, drag: 3,
      fade: FADE_INOUT, alpha: 0.12,
    });
  }

  /** 法線から接平面の正規直交基底を作る。這う粉の方向に使う */
  _basis(n) {
    _t1.set(0, 1, 0);
    if (Math.abs(n.y) > 0.9) _t1.set(1, 0, 0);
    _t1.crossVectors(_t1, n).normalize();
    _t2.crossVectors(n, _t1).normalize();
  }

  update(dt, camera) {
    this._impacts = 0;
    this.muzzleHeat = Math.max(0, this.muzzleHeat - dt * 0.55);
    if (camera && camera.isPerspectiveCamera) {
      const a = camera.aspect || 1.777;
      this.sparks.material.uniforms.uAspect.value = a;
      this.debris.material.uniforms.uAspect.value = a;
      this._camPos.copy(camera.position);
      // 板の法線はビュー空間で作るので、太陽もビュー空間へ持ち込む。
      // カメラを回すと粒の明暗が回るのが正しい。matrixWorldInverseは描画時にしか
      // 更新されないので、常に最新のクォータニオンから逆回転を作る
      _v1.copy(this.sunDir).applyQuaternion(_q.copy(camera.quaternion).invert());
      for (const g of this._litGroups) g.material.uniforms.uSunDir.value.copy(_v1);
    }
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.debris.update(dt);
    this.decals.update(dt);
    this.tracers.update(dt, camera);
    this.casings.update(dt, this.octree, this.onCasingLand, this._camPos);
  }

  clear() {
    this.sparks.clear();
    this.smoke.clear();
    this.debris.clear();
    this.decals.clear();
    this.tracers.clear();
    this.casings.clear();
    this.muzzleHeat = 0;
  }
}
