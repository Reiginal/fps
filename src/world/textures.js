// 画像ファイルを一切使わず、コードでPBRテクスチャ一式を作る。
// アルベド・法線・ラフネス・メタルネスを同じ高さ場から導出するので、
// 凹凸と光沢が必ず一致する（そこがズレると一気に安っぽく見える）。
//
// 設計方針: どの素材も「低周波(遠景で効く大きなムラ)」「中周波(中距離で効く模様・
// 構造物・汚れの流れ)」「高周波(近接で効く粒)」の3帯域を必ず重ねる。
// 単一周波数の面があると、寄った瞬間にのっぺりして作り物に見える。
import * as THREE from 'three';

/* -------------------------------------------------- 空気遠近(aerial perspective) */

/**
 * 距離だけの単色乗算だったフォグを、方向と高度を持つ大気に差し替える。
 *
 * 元の実装(FogExp2)には決定的に足りないものが2つあった。
 * (1) 方向依存が無い。太陽の方を向いても背を向けても同じ色なので、
 *     前方散乱(Mie)が消えて遠景が「乳白色のフィルタを1枚かけただけ」に見える。
 * (2) 高度依存が無い。地面すれすれも200m先のビルの上端も同じ密度で霞むので、
 *     遠景の輪郭がどこも同じだけ潰れて距離帯が分離しない。
 *
 * 直し方は、遠いほど寒色・太陽側だけ暖色にして、密度を高さで指数減衰させること。
 * これで「遠いほど青い／太陽側だけ暖かい」が出て、距離が色相でも読めるようになる。
 *
 * 実装はScene.fogを触らずShaderChunkごと差し替える。フォグを使う材質は
 * level.js・enemy.js・effects.jsにも散っていて、一部だけ差し替えると
 * 地面と建物でフォグの色が食い違うため。scene.fogは「フォグを有効にする
 * スイッチ」と「密度(fogDensity)の入れ物」としてだけ使い、色は無視する。
 *
 * 太陽の向き(sunDir)は呼ぶ側から渡してもらう。GLSLの定数へ焼くので
 * uniformでは渡せず、main.jsのSUN_DIRと同じ値が要る。
 * 前は太陽の向きをこのファイルの中に別で持っていて、main.js側が時刻で
 * 動くようになった後も夕方の値のまま置き去りになっていた
 * （朝・昼に遊んでも霧の暖色側が夕方の方角を向いたままだった）。
 * main.jsがSUN_DIRを決めた直後にここを呼ぶ形にして、置き去りが起きない
 * ようにする（呼ぶ場所はmain.js側、ShaderChunkの差し替え自体は
 * 材質のコンパイルより前ならどこでもよい）
 *
 * @param sunDir main.jsのSUN_DIRと同じTHREE.Vector3
 */
export function installAerialPerspective(sunDir) {
  const C = THREE.ShaderChunk;
  // 空の色をGLSLの定数へ焼く。ShaderChunkは静的な文字列なのでuniformを持てない。
  // createSky()と同じ値でないと、遠景が溶け込む先が背後の空とズレて、
  // どれだけ霞ませても輪郭が消えずに残る
  const hz = new THREE.Color(SKY_HORIZON), zn = new THREE.Color(SKY_ZENITH);
  const az = new THREE.Vector2(sunDir.x, sunDir.z).normalize();
  const v3 = (c) => `vec3( ${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)} )`;

  // 頂点側: ワールド座標を1本渡す。begin_vertexのtransformedを使うと
  // sprite系(transformedを持たない)で壊れるので、どの材質にも必ずある
  // mvPosition から復元する。viewMatrixの回転は正規直交なので、
  // 転置＝逆回転として使える（列との内積がそのまま転置積になる）
  C.fog_pars_vertex = /* glsl */`
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWP;
#endif
`;
  C.fog_vertex = /* glsl */`
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWP = cameraPosition + vec3(
    dot( viewMatrix[ 0 ].xyz, mvPosition.xyz ),
    dot( viewMatrix[ 1 ].xyz, mvPosition.xyz ),
    dot( viewMatrix[ 2 ].xyz, mvPosition.xyz ) );
#endif
`;

  // 大気の色は、その視線の先にある空そのもの。定数2色の間を振っていた頃は、
  // 太陽側でリニア(1.55,1.27,0.90)まで上がって地平の空(0.92,0.75,0.61)を追い越し、
  // 100m先のビルが背後の空より明るくなって輪郭が消えていた。
  // 空の式(createSky)から雲と太陽の芯を抜いたものを引き写して、それを上限にする。
  C.fog_pars_fragment = /* glsl */`
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogWP;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  const vec3 AP_SUNDIR = vec3( ${sunDir.x.toFixed(5)}, ${sunDir.y.toFixed(5)}, ${sunDir.z.toFixed(5)} );
  const vec2 AP_SUNAZ = vec2( ${az.x.toFixed(5)}, ${az.y.toFixed(5)} );   // 太陽の水平方位
  const vec3 AP_HORIZON = ${v3(hz)};
  const vec3 AP_ZENITH = ${v3(zn)};
  const float AP_GAIN = ${SKY_GAIN.toFixed(2)};
  // 空に対して遠景を置く段。空の手前に立っている面が、その空と同じ放射輝度を
  // 持つことは無いので、必ず1つ下へ落とす。ここが1.0だと、霞むほど空に
  // 溶けるのではなく空と同化して、地平線の位置すら読めなくなる
  const float AP_LEVEL = 0.82;
  // 大気のスケールハイト(m)。この高さごとに密度が1/eになる。
  // 30mだと高さ20〜30mの遠景ビルの上端がほぼ真空の中に立つことになり、
  // 60m先でも190m先でも霞む量が4〜8%しか無かった。実測でも52m先と140m先の
  // ビルが同じ濃さで並んでいて、これが「遠景が書き割りに見える」の正体。
  // 110mまで上げると上端でも 60m:10% / 120m:35% / 190m:66% と距離で開く。
  // 場内(40m以内)の霞む量は0.2%も動かないので、近景の見え方は変わらない
  const float AP_H = 110.0;
#endif
`;
  C.fog_fragment = /* glsl */`
#ifdef USE_FOG
{
  vec3 apRay = vFogWP - cameraPosition;
  float apDist = max( length( apRay ), 1e-4 );
  vec3 apDir = apRay / apDist;

  // 密度 ∝ exp(-y/H) を視線に沿って解析積分する。
  // ∫ exp(-(ya + t*dy/L)/H) dt = L*H*(exp(-ya/H) - exp(-yb/H)) / dy
  float apYa = max( cameraPosition.y, 0.0 );
  float apYb = max( vFogWP.y, 0.0 );
  float apEa = exp( -apYa / AP_H );
  float apEb = exp( -apYb / AP_H );
  float apDy = apYb - apYa;
  // dy→0では0/0になるので、その時は等密度として扱う。
  // GPUによっては三項演算子の両辺が評価されるので、分母は先に潰しておく
  float apDenom = abs( apDy ) > 0.05 ? apDy : 0.05;
  float apOd = abs( apDy ) > 0.05 ? apDist * AP_H * ( apEa - apEb ) / apDenom : apDist * apEa;

  #ifdef FOG_EXP2
    float apD = fogDensity * apOd;
    float fogFactor = 1.0 - exp( - apD * apD );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, apOd );
  #endif

  // 同じ画素の空を引き直す。apDirは「カメラから面へ」の向きで、空の球も
  // カメラ中心なので、面のすぐ上に見えている空とまったく同じ方向になる。
  // だから遠景は、真上の空の色へまっすぐ寄っていく
  float apSun = max( dot( apDir, AP_SUNDIR ), 0.0 );
  // 2乗を1回作って使い回す。ハローの4乗もこれの2乗で足りるので、
  // 差し替え前より pow の回数は1回減っている
  float apSun2 = apSun * apSun;
  float apT = pow( clamp( apDir.y, 0.0, 1.0 ), 0.42 );
  vec3 apCol = mix( AP_HORIZON, AP_ZENITH, apT );
  // 前方散乱。太陽側の空全体がうっすら明るくなる
  apCol += vec3( 1.00, 0.70, 0.44 ) * apSun2 * 0.17 * ( 1.0 - apT * 0.55 );
  // 地平のヘイズ層。太陽の方位側は暖色、反対側は寒色に振る。
  // 遠景が最後に溶けるのはこの層なので、ここを空と食い違わせると
  // 地平すれすれのビルだけ色が浮く
  float apAz = dot( normalize( apDir.xz + vec2( 1e-5 ) ), AP_SUNAZ );
  vec3 apHaze = mix( AP_HORIZON * vec3( 0.84, 0.90, 1.04 ),
                     AP_HORIZON * vec3( 1.12, 1.03, 0.88 ),
                     clamp( apAz * 0.5 + 0.5, 0.0, 1.0 ) );
  apCol = mix( apCol, apHaze, exp( -max( apDir.y, 0.0 ) * 13.0 ) * 0.55 );
  // 太陽まわりのハロー。逆光の遠景が白熱する所を作る。空側に3層あるうち
  // 一番広い1層だけ拾う。芯まで足すと太陽の近くだけ遠景が空を追い越す
  apCol += vec3( 1.00, 0.74, 0.46 ) * apSun2 * apSun2 * 0.16;
  apCol *= AP_GAIN * AP_LEVEL;

  gl_FragColor.rgb = mix( gl_FragColor.rgb, apCol, fogFactor );
}
#endif
`;
}
// 呼ぶのは空の色(SKY_*)を宣言した後。constは巻き上がらないので、
// ここで呼ぶと未初期化で落ちる。ShaderChunkの差し替えはモジュール評価中に
// 済めばよく、材質のコンパイルはそれより後なので順番を下げて困らない

/* ---------------------------------------------------------------- noise */

function hash2(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

// period を整数に保つことでテクスチャの継ぎ目が消える（タイリング可能）
function vnoise(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const w = (n) => ((n % period) + period) % period;
  const x0 = w(xi), x1 = w(xi + 1), y0 = w(yi), y1 = w(yi + 1);
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

// 縦横で周期を変えられる版。水垂れ・ヘアライン・鋸目のような
// 「一方向にだけ伸びた」模様は等方ノイズでは絶対に出ないのでこれを使う。
// 旧実装は片軸をスケールして誤魔化していて継ぎ目が出ていた。
function vnoiseA(x, y, px, py, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const wx0 = ((xi % px) + px) % px, wx1 = (((xi + 1) % px) + px) % px;
  const wy0 = ((yi % py) + py) % py, wy1 = (((yi + 1) % py) + py) % py;
  const a = hash2(wx0, wy0, seed), b = hash2(wx1, wy0, seed);
  const c = hash2(wx0, wy1, seed), d = hash2(wx1, wy1, seed);
  const top = a + (b - a) * u;
  const bot = c + (d - c) * u;
  return top + (bot - top) * v;
}

function fbm(x, y, freq, octaves, seed, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoise(x * f, y * f, f, seed + i * 131);
    norm += amp;
    amp *= gain;
    f *= 2;
  }
  return sum / norm;
}

function fbmA(x, y, fx, fy, octaves, seed, gain = 0.5) {
  let sum = 0, amp = 1, norm = 0, ax = fx, ay = fy;
  for (let i = 0; i < octaves; i++) {
    sum += amp * vnoiseA(x * ax, y * ay, ax, ay, seed + i * 131);
    norm += amp;
    amp *= gain;
    ax *= 2; ay *= 2;
  }
  return sum / norm;
}

// 尾根状ノイズ。ひび割れや金属の擦り傷に使う
function ridged(x, y, freq, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoise(x * f, y * f, f, seed + i * 977) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

// 方向を持った尾根。木の割れ目のように「繊維に沿って長く走る」線に使う
function ridgedA(x, y, fx, fy, octaves, seed) {
  let sum = 0, amp = 1, norm = 0, ax = fx, ay = fy;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(vnoiseA(x * ax, y * ay, ax, ay, seed + i * 977) * 2 - 1);
    sum += amp * n * n;
    norm += amp;
    amp *= 0.5;
    ax *= 2; ay *= 2;
  }
  return sum / norm;
}

// ボロノイ。砂利・石畳・鉄板の粒に使う。
// F1距離に加えてF2も返す。F2-F1がセル境界なので、補修跡の継ぎ目や
// 剥離した錆の鱗の輪郭がこれ1つで作れる。
const _cell = { d: 0, d2: 0, id: 0 };
function voronoi(x, y, freq, seed) {
  const px = x * freq, py = y * freq;
  const ix = Math.floor(px), iy = Math.floor(py);
  let b1 = 1e9, b2 = 1e9, id = 0;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = ix + ox, cy = iy + oy;
      const wx = ((cx % freq) + freq) % freq;
      const wy = ((cy % freq) + freq) % freq;
      const h = hash2(wx, wy, seed);
      const g = hash2(wx, wy, seed + 7717);
      const dx = cx + h - px, dy = cy + g - py;
      const d = dx * dx + dy * dy;
      if (d < b1) { b2 = b1; b1 = d; id = h * 137.31 + g * 71.7; }
      else if (d < b2) { b2 = d; }
    }
  }
  _cell.d = Math.sqrt(b1);
  _cell.d2 = Math.sqrt(b2);
  _cell.id = id - Math.floor(id);
  return _cell;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const fract = (x) => x - Math.floor(x);
const smoothstep = (e0, e1, x) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
// 0.5からの距離。タイル内の縞や目地の中心を取るのに毎回書くので関数にする
const tri = (x) => Math.abs(fract(x) - 0.5);

/* -------------------------------------------------------------- baking */

// 高さ場からソーベル法で法線を起こす。端は巻き戻して継ぎ目を消す。
// バイト列でなく正規化済みfloatで返すのは、ミップを自前で作る時に
// 「平均した法線の長さ」が必要だから（縮んだ長さ＝その段で潰れた凹凸の量）。
function normalFieldFromHeight(height, size, strength) {
  const out = new Float32Array(size * size * 3);
  const w = (n) => (n + size) % size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const l = height[y * size + w(x - 1)];
      const r = height[y * size + w(x + 1)];
      const u = height[w(y - 1) * size + x];
      const d = height[w(y + 1) * size + x];
      const nx = (l - r) * strength;
      const ny = (u - d) * strength;
      const inv = 1 / Math.hypot(nx, ny, 1);
      const i = (y * size + x) * 3;
      out[i] = nx * inv; out[i + 1] = ny * inv; out[i + 2] = inv;
    }
  }
  return out;
}

// 平均した法線の長さ r から、その段で失われた凹凸を粗さへ繰り込む。
// vMF分布の集中度 kappa = r(3-r^2)/(1-r^2) を使い alpha^2 += 2/kappa で広げる。
// これが無いと、遠くの面は法線だけ平均されて「平らで滑らかな面」と誤認され、
// 1画素の白点が沸く（カメラを振るとチカチカするファイアフライ）。
function toksvigRough(rough, r) {
  if (r >= 0.9995) return rough;
  const rr = r < 0.02 ? 0.02 : r;
  const kappa = rr * (3 - rr * rr) / (1 - rr * rr);
  const a2 = rough * rough + 2 / kappa;
  return a2 >= 1 ? 1 : Math.sqrt(a2);
}

// 法線とARMのミップを自前で作る。GPUのgenerateMipmapは法線だけを平均して
// 向きを均す一方、粗さは元のまま残すので両者の辻褄が合わなくなる。
// 段ごとに平均法線の長さを測り、同じ段の粗さ(Gチャンネル)へ焼き込む。
function buildRegularizedMips(field, arm, size) {
  const normalMips = [];
  const armMips = [];
  // 累積は「正規化しない平均」で持つ。box平均の平均は全体平均と一致するので、
  // 段を下げるほど長さが縮み、その縮みがそのまま法線のばらつきを表す
  let acc = field;
  let armAcc = Float32Array.from(arm);
  let s = size;
  for (;;) {
    const n = s * s;
    const nData = new Uint8Array(n * 4);
    const aData = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = acc[i * 3], y = acc[i * 3 + 1], z = acc[i * 3 + 2];
      let len = Math.hypot(x, y, z);
      if (len < 1e-6) len = 1e-6;
      const inv = 1 / len;
      const o = i * 4;
      nData[o] = (x * inv * 0.5 + 0.5) * 255;
      nData[o + 1] = (y * inv * 0.5 + 0.5) * 255;
      nData[o + 2] = (z * inv * 0.5 + 0.5) * 255;
      nData[o + 3] = 255;
      aData[o] = armAcc[o];
      aData[o + 1] = clamp01(toksvigRough(armAcc[o + 1] / 255, len)) * 255;
      aData[o + 2] = armAcc[o + 2];
      aData[o + 3] = 255;
    }
    normalMips.push({ data: nData, width: s, height: s });
    armMips.push({ data: aData, width: s, height: s });
    if (s === 1) break;

    const hs = s >> 1;
    const nAcc = new Float32Array(hs * hs * 3);
    const aAcc = new Float32Array(hs * hs * 4);
    for (let y = 0; y < hs; y++) {
      for (let x = 0; x < hs; x++) {
        const o = y * hs + x;
        const a0 = (y * 2) * s + x * 2, a1 = a0 + 1;
        const b0 = (y * 2 + 1) * s + x * 2, b1 = b0 + 1;
        for (let c = 0; c < 3; c++) {
          nAcc[o * 3 + c] = (acc[a0 * 3 + c] + acc[a1 * 3 + c] + acc[b0 * 3 + c] + acc[b1 * 3 + c]) * 0.25;
        }
        for (let c = 0; c < 4; c++) {
          aAcc[o * 4 + c] = (armAcc[a0 * 4 + c] + armAcc[a1 * 4 + c] + armAcc[b0 * 4 + c] + armAcc[b1 * 4 + c]) * 0.25;
        }
      }
    }
    acc = nAcc; armAcc = aAcc; s = hs;
  }
  return { normalMips, armMips };
}

function makeTexture(data, size, srgb, repeat, aniso, mipmaps) {
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  if (mipmaps) {
    // 自前のミップを使う。threeは mipmaps が入っている時だけ各段を
    // 明示アップロードするので、generateMipmapsは必ず落とす
    t.mipmaps = mipmaps;
    t.generateMipmaps = false;
  } else {
    t.generateMipmaps = true;
  }
  t.anisotropy = aniso;
  if (repeat) t.repeat.set(repeat, repeat);
  t.needsUpdate = true;
  return t;
}

/**
 * ピクセルごとのコールバックを回して、アルベド/法線/ラフネス+メタルの
 * 3枚を一度に焼く。cb は out に h(高さ) r,g,b(色) rough metal ao を書く。
 */
function bake(size, seed, cb, normalStrength, aniso) {
  const height = new Float32Array(size * size);
  const albedo = new Uint8Array(size * size * 4);
  const arm = new Uint8Array(size * size * 4); // R:AO G:Roughness B:Metalness
  const out = { h: 0, r: 0, g: 0, b: 0, rough: 0.8, metal: 0, ao: 1 };
  const inv = 1 / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out.h = 0; out.r = 0.5; out.g = 0.5; out.b = 0.5;
      out.rough = 0.8; out.metal = 0; out.ao = 1;
      cb(x * inv, y * inv, out, seed);
      const i = y * size + x;
      const o = i * 4;
      height[i] = out.h;
      const cr = clamp01(out.r), cg = clamp01(out.g), cb2 = clamp01(out.b);
      albedo[o] = cr * 255;
      albedo[o + 1] = cg * 255;
      albedo[o + 2] = cb2 * 255;
      albedo[o + 3] = 255;
      arm[o] = clamp01(out.ao) * 255;
      arm[o + 1] = clamp01(out.rough) * 255;
      arm[o + 2] = clamp01(out.metal) * 255;
      arm[o + 3] = 255;
    }
  }
  const field = normalFieldFromHeight(height, size, normalStrength);
  const { normalMips, armMips } = buildRegularizedMips(field, arm, size);
  return {
    map: makeTexture(albedo, size, true, null, aniso),
    normalMap: makeTexture(normalMips[0].data, size, false, null, aniso, normalMips),
    armMap: makeTexture(armMips[0].data, size, false, null, aniso, armMips),
  };
}

/* ---------------------------------------------------- surface shader work */

// threeはonBeforeCompileを1材質に1つしか持てない。level.jsのaddMacroVariation()が
// 後から代入すると、ここで入れた改造（汚れの向き・詳細法線・スペキュラAA）が
// 丸ごと消える。代入を「置き換え」でなく「追加」として受け取れるように、
// プロパティをアクセサへ差し替えておく。
function chainCompile(m, fn) {
  let list = m.userData._surfChain;
  if (!list) {
    list = [];
    m.userData._surfChain = list;
    const composed = (shader, renderer) => {
      for (let i = 0; i < list.length; i++) list[i](shader, renderer);
    };
    Object.defineProperty(m, 'onBeforeCompile', {
      configurable: true,
      get() { return composed; },
      set(f) { if (typeof f === 'function' && list.indexOf(f) < 0) list.push(f); },
    });
  }
  list.push(fn);
}

// シェーダー内で使う値ノイズ。マクロの汚れをmapの再サンプルで作ると、
// 元の模様（目地・レンガ）の構造がそのまま巨大化して乗ってしまうので、
// 汚れ用の場は手続きで作る。テクスチャ参照0回、数十命令で済む。
const SURF_NOISE = /* glsl */`
float sfHash( vec2 p ) {
  p = fract( p * vec2( 127.31, 311.7 ) );
  p += dot( p, p + 34.23 );
  return fract( p.x * p.y );
}
float sfVn( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = sfHash( i ), b = sfHash( i + vec2( 1.0, 0.0 ) );
  float c = sfHash( i + vec2( 0.0, 1.0 ) ), d = sfHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}
float sfFbm( vec2 p ) { return sfVn( p ) * 0.64 + sfVn( p * 2.13 + 11.3 ) * 0.36; }
`;

/**
 * 面の見え方をまとめて1本のonBeforeCompileで面倒を見る。
 * (1) 汚れのマクロ変調を「重力方向」に持たせる。等方の楕円斑をアルベドに
 *     直接掛けると、暗い斑がスラブ上面から垂直面へジオメトリを無視して
 *     横に連続し、汚れではなく迷彩塗装に見える。実物は上から下への縦筋で、
 *     上向き面（埃が溜まって明るい）と垂直面（雨で洗われる）で符号が逆になる。
 * (2) 近接に詳細法線を1枚重ねる。512pxを4m角に貼ると128px/mしかなく、
 *     3〜5mで見る壁の大半が特徴ゼロの平坦な灰色になる。同じ法線マップを
 *     高い倍率でもう1度引くだけなので、テクスチャは1枚も増えない。
 * (3) 遠景では逆に法線の細部を落とす。距離で粒が縮まないと、中距離の
 *     アスファルトが編み目の生地に見える。
 * (4) 幾何スペキュラAA。ミップ側の正則化(toksvigRough)で拾いきれない
 *     「手前で視線が寝た面」のギラつきを最後に潰す。
 */
function addSurfaceShading(m, cfg) {
  // level.js の addMacroVariation() は同等のことを等方・UV基準でやっていて、
  // 重ねると斑が二重になる。向こうの番人フラグを立てて、こちらに一本化する
  m.userData.macroApplied = true;

  const uniforms = {
    // x:ムラの周期(1/m) y:ムラ量 z:雨だれの量 w:粗さへの連動
    uMacro: { value: new THREE.Vector4(cfg.macroScale, cfg.macroAmt, cfg.macroRun, cfg.macroRough) },
    // x:詳細法線のUV倍率 y:強さ z:効かせる距離(m)
    uDetail: { value: new THREE.Vector3(cfg.detail[0], cfg.detail[1], cfg.detail[2]) },
    // x:減衰開始(m) y:減衰終了(m) z:遠景に残す割合
    uNormFade: { value: new THREE.Vector3(cfg.fade[0], cfg.fade[1], cfg.fade[2]) },
    uWarpAmt: { value: cfg.warp ?? 0 },
  };

  chainCompile(m, (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = `
uniform float uWarpAmt;
varying vec3 vSurfWP;
varying vec3 vSurfWN;
` + shader.vertexShader
      .replace('#include <uv_vertex>', /* glsl */`#include <uv_vertex>
      if ( uWarpAmt > 0.0 ) {
        // タイルの升目そのものを読めなくする。低周波でUVを押し引きする
        vec3 wposW = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
        vec2 warpUv = vec2(
          sin( wposW.z * 0.083 + 1.7 ) * 0.62 + sin( wposW.x * 0.031 + 4.1 ) * 0.44,
          cos( wposW.x * 0.071 + 0.4 ) * 0.62 + sin( wposW.z * 0.047 + 2.3 ) * 0.44
        ) * uWarpAmt;
        // アルベドだけずらすと法線と柄が食い違うので、同じ量を全部に掛ける。
        // alphaMapは板1枚に紐づくマスクなので触らない
        #ifdef USE_MAP
          vMapUv += warpUv;
        #endif
        #ifdef USE_NORMALMAP
          vNormalMapUv += warpUv;
        #endif
        #ifdef USE_ROUGHNESSMAP
          vRoughnessMapUv += warpUv;
        #endif
        #ifdef USE_METALNESSMAP
          vMetalnessMapUv += warpUv;
        #endif
        #ifdef USE_AOMAP
          vAoMapUv += warpUv;
        #endif
      }`)
      .replace('#include <begin_vertex>', /* glsl */`#include <begin_vertex>
      vSurfWP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
      // mat3(mat4)の切り出しはGLSL ES 1.00では処理系依存なので、列を明示して組む
      mat3 sfRot = mat3( modelMatrix[ 0 ].xyz, modelMatrix[ 1 ].xyz, modelMatrix[ 2 ].xyz );
      vSurfWN = normalize( sfRot * objectNormal );`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`#include <common>
uniform vec4 uMacro;
uniform vec3 uDetail;
uniform vec3 uNormFade;
varying vec3 vSurfWP;
varying vec3 vSurfWN;
float sfMacro = 0.0;
float sfRoughVar = 0.0;
${SURF_NOISE}`)
      .replace('#include <map_fragment>', /* glsl */`#include <map_fragment>
{
  vec3 wn = normalize( vSurfWN );
  // 汚れの座標はworldから作る。UVの向きは面ごとにバラバラなので、
  // UVを縦に伸ばすと面によっては筋が横倒しになって余計に嘘くさくなる
  vec3 hT = cross( vec3( 0.0, 1.0, 0.0 ), wn ) / max( length( cross( vec3( 0.0, 1.0, 0.0 ), wn ) ), 1e-4 );
  // 水平に近い面ではhTが縮退するので、その時だけxz平面をそのまま使う
  vec2 sUv = mix( vSurfWP.xz, vec2( dot( vSurfWP, hT ), vSurfWP.y ),
                  step( 0.02, 1.0 - abs( wn.y ) ) );
  float upF = smoothstep( 0.45, 0.85, wn.y );                 // 上を向いた面
  float vertF = 1.0 - smoothstep( 0.18, 0.55, abs( wn.y ) );  // ほぼ垂直な面
  // GLSLのsmoothstepはedge0>edge1が仕様上未定義なので、必ず1.0-で反転させる
  float dnF = 1.0 - smoothstep( -0.85, -0.45, wn.y );         // 軒裏

  // 打設ロットのムラ。上向き面は埃が積もって明るく、垂直面は洗われて逆符号
  float lot = sfFbm( sUv * uMacro.x * 0.42 + 3.7 ) - 0.5;
  sfMacro = lot * 2.0 * uMacro.y * mix( -1.0, 1.0, upF );

  // タイル周期(約4m)の1/16まで落とした超低周波。textures側のレシピはタイル内の
  // 3帯域しか持っていないので、この帯域が無いと512pxの升目がそのまま等間隔で
  // 反復して読める（俯瞰で屋根一面に同じ星形が20回並ぶのがこれ）。
  // 明度で±25%振ると、同じ模様でも「同じ場所」には見えなくなる
  float macroL = sfFbm( sUv * uMacro.x * 0.062 + 21.7 ) - 0.5;
  sfMacro += macroL * 3.2 * uMacro.y;

  // 粗さはアルベドと別の場で割る。同じ場で振ると「明るい所は必ず滑らか」という
  // 対応が面全体に出て、ザラついた面に鏡のような一枚のハイライトが残ってしまう。
  // 2帯域取る。中距離用(uMacro.x*0.28≒14m)と、上のmacroLと同じ超低周波。
  // 低周波側が無いと、10m四方の屋根がまるごと同じ粗さになって
  // 一枚の巨大な鏡面ブロブがそのまま残る
  sfRoughVar = ( sfVn( sUv * uMacro.x * 0.28 + 9.4 ) - 0.5 ) * 0.30
             + ( sfVn( sUv * uMacro.x * 0.055 + 33.1 ) - 0.5 ) * 0.24;

  // 雨だれ。縦に引き伸ばした筋を、上の見切り（スラブ・水切り）から下へ
  // 指数で減衰させる。この上下非対称が無いと汚れが塗装に見える
  float colJ = sfVn( vec2( sUv.x * uMacro.x * 0.75, 7.3 ) );
  float dropD = mod( 1.9 - vSurfWP.y - colJ * 1.7, 3.2 );
  float streak = sfFbm( sUv * uMacro.x * vec2( 1.0, 0.22 ) );
  float run = exp( -dropD * 0.9 ) * smoothstep( 0.42, 0.86, streak );
  sfMacro -= run * uMacro.z * vertF;
  sfMacro -= dnF * uMacro.y * 0.6;                            // 軒裏は一様に暗い

  diffuseColor.rgb *= clamp( 1.0 + sfMacro, 0.45, 1.55 );
}`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
#ifdef USE_NORMALMAP_TANGENTSPACE
{
  float sfDist = length( vViewPosition );
  // 近接だけ、同じ法線マップを高い倍率でもう1度重ねる。
  // ifで囲わないのは、テクスチャ参照を分岐の中に置くとミップの導出に使う
  // 微分が未定義になるから。dtl=0ならdN=(0,0,z)で法線は素通しになる
  float dtl = uDetail.y * ( 1.0 - smoothstep( uDetail.z * 0.35, uDetail.z, sfDist ) );
  vec3 dN = texture2D( normalMap, vNormalMapUv * uDetail.x ).xyz * 2.0 - 1.0;
  dN.xy *= normalScale * dtl;
  dN.z = max( dN.z, 0.05 );
  // 確定した法線をZ軸に取り直してから乗せる(RNM相当)。単純加算だと
  // 面の傾きが二重に効いて陰影が濁る
  normal = normalize( tbn[ 0 ] * dN.x + tbn[ 1 ] * dN.y + normal * dN.z );
  // 遠景では細部を落とす。ミップの正則化と両輪で、手前だけに粒が残る
  float keep = mix( uNormFade.z, 1.0, 1.0 - smoothstep( uNormFade.x, uNormFade.y, sfDist ) );
  normal = normalize( mix( nonPerturbedNormal, normal, keep ) );
}
#endif
// 明るいムラは乾いて粗く、暗いムラは湿って滑らか。色と光沢の対応を崩さない。
// sfRoughVarはそれとは無関係の斑で、広いハイライトを割るためだけに入れる
roughnessFactor = clamp( roughnessFactor - sfMacro * uMacro.w + sfRoughVar, 0.05, 1.0 );
{
  vec3 saaDx = dFdx( normal );
  vec3 saaDy = dFdy( normal );
  float saaVar = 0.5 * ( dot( saaDx, saaDx ) + dot( saaDy, saaDy ) );
  // 上限を付けないと、シルエットの縁で粗さが飛んで面が白茶ける
  float saaKernel = min( 2.0 * saaVar, 0.16 );
  roughnessFactor = sqrt( clamp( roughnessFactor * roughnessFactor + saaKernel, 0.0, 1.0 ) );
}`);
  });

  // シェーダーを差し替えた材質は、鍵を明示しないと素のStandardMaterialと
  // プログラムを取り違える。挿すソースは全材質で同一（差はuniformだけ）なので鍵は1つでよい
  m.customProgramCacheKey = () => 'surfShade1';
  return m;
}

// アルベド/法線/ARMをまとめてStandardMaterialに載せる
function materialFrom(baked, opts = {}) {
  // normalScaleはVector2。コンストラクタに数値のまま渡すとVector2が
  // 数値で上書きされて壊れるので、必ず取り除いてから後で入れる
  const { normalScale = 1, surf = null, ...rest } = opts;
  const m = new THREE.MeshStandardMaterial({
    map: baked.map,
    normalMap: baked.normalMap,
    roughnessMap: baked.armMap,
    metalnessMap: baked.armMap,
    aoMap: baked.armMap,
    roughness: 1,
    metalness: 1,
    aoMapIntensity: 0.9,
    ...rest,
  });
  m.normalScale.set(normalScale, normalScale);
  if (surf) addSurfaceShading(m, surf);
  return m;
}

/* ------------------------------------------------------- surface recipes */

// レンガの積み方を返す共通部品。plasterが「剥がれた下から覗くレンガ」として
// そのまま使い回すので、brick本体と分けてある。
// 1タイル=16段×5本。レンガの縦横比が実物(約3.3:1)に近くなる並びにしている。
const BRICK_ROWS = 16, BRICK_COLS = 5;
const _bk = { mortar: 0, round: 0, id: 0, bu: 0, bv: 0 };
function brickField(u, v, seed) {
  const rv = v * BRICK_ROWS;
  const rowRaw = Math.floor(rv);
  const bv = rv - rowRaw;
  const row = ((rowRaw % BRICK_ROWS) + BRICK_ROWS) % BRICK_ROWS;
  // 段ごとの半個ズラし＋わずかな乱れ。整然としすぎると図面に見える
  const cu = u * BRICK_COLS + (row & 1) * 0.5 + hash2(row, 71, seed) * 0.05;
  const colRaw = Math.floor(cu);
  const bu = cu - colRaw;
  const col = ((colRaw % BRICK_COLS) + BRICK_COLS) % BRICK_COLS;
  // 目地幅はタイル単位で測る。uv比で測ると横目地だけ3倍太くなって嘘になる
  const du = (0.5 - Math.abs(bu - 0.5)) / BRICK_COLS;
  const dv = (0.5 - Math.abs(bv - 0.5)) / BRICK_ROWS;
  const d = du < dv ? du : dv;
  _bk.mortar = smoothstep(0.0058, 0.0032, d);
  _bk.round = smoothstep(0.020, 0.006, d);     // レンガの角の丸まり
  _bk.id = hash2(col, row, seed + 5);
  _bk.bu = bu; _bk.bv = bv;
  return _bk;
}

// コンクリート。
// 低: 打設ロットの色ムラ・広い汚れ / 中: 型枠のパネル割り・セパ穴・水垂れ・
// 鉄筋の錆汁・ひび・爆裂(かぶり欠け) / 高: 骨材・砂粒・ピンホール(気泡)
function concrete(u, v, o, seed) {
  // 型枠のパネル割り。中距離の骨格はここ。水垂れも錆汁も全部この線から出す
  const fu = fract(u * 2), fv = fract(v * 2);
  const seamH = smoothstep(0.026, 0.005, Math.min(fv, 1 - fv));
  const seamV = smoothstep(0.016, 0.004, Math.min(fu, 1 - fu));
  // セパレータ（型枠を留めるボルト）の跡。全パネルに律儀に入れると製図に見えるので間引く
  const tieOn = hash2(Math.floor(u * 2), Math.floor(v * 2), seed + 3) > 0.35 ? 1 : 0;
  const tie = smoothstep(0.030, 0.015, Math.hypot(fu - 0.5, fv - 0.5)) * tieOn;

  // 低周波: 打ち継ぎごとの明度差と広い汚れ
  const blotch = fbm(u, v, 3, 3, seed + 40);
  const wide = fbm(u, v, 2, 2, seed + 140);
  // 中周波のまだら。ここが空くと、寄った時に面が単一周波数になってのっぺりする
  const mottle = fbm(u, v, 11, 3, seed + 150);

  // 中周波: 水垂れ。縦に引き伸ばしたノイズを目地の直下ほど濃くして上下非対称にする。
  // 長さは列ごとにバラす（全部同じ高さで切れるとバーコードに見える）
  const streak = fbmA(u, v, 40, 3, 3, seed + 200);
  const colRand = fbmA(u, v, 56, 1, 1, seed + 205);   // 周期1＝v方向に一定＝列ごとの乱数
  const below = smoothstep(0.26 + colRand * 0.55, 0.99, fv);
  const drip = clamp01(smoothstep(0.58, 0.86, streak) * below * (0.6 + wide * 0.8));
  // 中周波: 鉄筋・セパの錆汁。水垂れと同じ流れに乗せるとオレンジの筋になる
  const rustSrc = smoothstep(0.66, 0.82, fbm(u, v, 4, 3, seed + 260));
  const bleed = clamp01(rustSrc * (drip * 2.0 + tie * 1.2));
  // ひびは尾根の頂点付近だけを拾う。閾値を下げすぎると線でなく塊になり、
  // 壁に墨をぶちまけたような模様になる
  // 周期5・4オクターブのridgedは、1タイル(4m)の中に0.8m級の星形／X字の
  // 尾根を数本しか作らない。同じ模様が屋根一面に20回以上並んで
  // 「等間隔の格子に貼られた1個のモチーフ」として読めてしまうので、
  // 周期を上げて閾値を絞り、モチーフではなく細かい網に崩す
  const crack = smoothstep(0.88, 0.97, ridged(u, v, 9, 4, seed + 12));
  const hair = smoothstep(0.84, 0.95, ridged(u, v, 17, 3, seed + 13));
  // 中周波: 爆裂・欠け。中から骨材が顔を出す
  const spall = smoothstep(0.76, 0.86, fbm(u, v, 7, 3, seed + 310));

  // 高周波: 骨材と砂と気泡
  const agg = voronoi(u, v, 40, seed + 90);
  const aggD = agg.d, aggId = agg.id;
  const grain = fbm(u, v, 110, 2, seed);
  const pin = smoothstep(0.74, 0.86, fbm(u, v, 170, 2, seed + 400));

  // 窪みに残った水。画のどこにも鏡面が無いと光の向きも強さも読み取れないので、
  // 低周波の低い側だけを閾値で拾って濡らす。水は誘電体なのでmetalは上げない
  // 閾値は面積で決める。fbmの分布は0.5付近に固まっているので、0.6を超えた辺りで
  // 切ると濡れた面が実質ゼロになり、結局どこにも光の向きが出ない。広場の
  // 1割弱が濡れる所まで下げる
  const pool = clamp01((1 - wide) * 0.62 + (1 - blotch) * 0.45 + drip * 0.22);
  // 閾値を下げすぎると、面積1割の不定形な塊がまるごと粗さ0.15になる。
  // 浅い視線角では空のIBLをほぼ鏡面のまま返すので、俯瞰で見た屋根や床に
  // ジオメトリと無関係の白飛びしたシミが出る。3%程度の点在まで絞る
  const wet = smoothstep(0.655, 0.725, pool) * (1 - crack * 0.6) * (1 - spall * 0.5);
  // 水たまりの説得力は面でなく縁で決まる。溜まりの外周だけ濃く濡れた帯を作る
  const wetRim = smoothstep(0.600, 0.655, pool) * (1 - smoothstep(0.655, 0.710, pool));

  // 3〜5mで見た時に読める物（型枠の目・セパ穴・骨材の粒）を深く彫る。
  // ここが浅いと、寄った壁が特徴ゼロの平坦な灰色になる
  const hLow = blotch * 0.22 + wide * 0.16 + mottle * 0.12
    - seamH * 0.95 - seamV * 0.55 - tie * 1.15;
  // ひびの溝を深く彫るほど、低い太陽では片方の斜面が直射を正面から拾って
  // 「ひびが周囲より明るい線」になる。アスファルトで踏んだのと同じ罠なので、
  // 溝は浅くして暗さはアルベドとAOに持たせる
  const hFine = grain * 0.19
    + (0.45 - aggD) * 0.14                    // 骨材の起伏は欠けていない所にも薄く効かせる
    - crack * 0.42 - hair * 0.28 - pin * 0.58
    - spall * 0.50 + (0.45 - aggD) * spall * 1.0;
  // 水面は平ら。細かい起伏を残したまま光沢だけ上げると「濡れた紙やすり」になる
  o.h = hLow + hFine * (1 - wet * 0.85);

  // 各帯域を0.5中心の増減として足す。積み上げ式だと平均だけ上がって
  // コントラストが乗らず、遠目に「均一な白い板」になる。
  // baseは屋外ヤードの汚れたコンクリを想定した値。ここを上げると広場が空と
  // 同じ階調帯に入って、前景/中景/空の分離が消える
  // 低周波(1〜2m級)のアメーバ状の斑はタイル側で持たない。等方の大きな斑を
  // アルベドに焼くと、タイルを並べた時に暗い斑がジオメトリを無視して横に
  // 連続し、汚れではなく迷彩の塗り分けに見える。大きなムラは面の向きと
  // 重力を知っているシェーダー側(addSurfaceShading)の担当にして、
  // ここは中・高周波（型枠の目・骨材・水垂れ）に絞る
  let base = 0.35 + (blotch - 0.5) * 0.085 + (wide - 0.5) * 0.065
    + (mottle - 0.5) * 0.095 + (grain - 0.5) * 0.068;
  base *= 1 - smoothstep(0.52, 0.92, wide) * 0.08;   // 広い黒ずみ
  base *= 1 - drip * 0.17;                           // 水垂れは黒い
  let r = base, g = base * 0.995, b = base * 0.955;
  // 錆汁のオレンジ
  r = lerp(r, 0.42, bleed * 0.8); g = lerp(g, 0.23, bleed * 0.8); b = lerp(b, 0.12, bleed * 0.8);
  // 欠けの中は骨材の色。粒ごとに色を振ると急に情報量が増える
  const aggTone = 0.36 + aggId * 0.20;
  r = lerp(r, aggTone, spall * 0.5); g = lerp(g, aggTone * 0.97, spall * 0.5); b = lerp(b, aggTone * 0.90, spall * 0.5);
  // 溝を浅くしたぶん、ひびの暗さはこちらで受ける
  const dark = 1 - crack * 0.62 - hair * 0.26 - seamH * 0.28 - seamV * 0.18 - tie * 0.44;
  // 濡れた面は暗く沈み、その代わりに鏡面で空を返す。
  // ただしこの材質は床にも垂直な壁にも貼られる。水たまり前提で0.45も
  // 暗く落とすと、壁では1〜2m級の暗いアメーバ斑が重力と無関係に広がって
  // 迷彩の塗り分けに見えるので、色の落ち込みは控えめにして
  // 「濡れている」ことは粗さ側（鏡面）に語らせる
  const wd = (1 - wet * 0.18) * (1 - wetRim * 0.30);
  o.r = r * dark * wd; o.g = g * dark * wd; o.b = b * dark * wd * 0.98;

  // 粗さの振れ幅を広げる。0.75〜0.92しか無いと面全体が同じ光沢で、
  // 広い上向き面に鏡のような一枚のハイライトが乗ったまま割れない
  o.rough = lerp(0.80 + grain * 0.12 - wide * 0.05 + spall * 0.12 + drip * 0.05
    + (mottle - 0.5) * 0.16 + (0.40 - aggD) * 0.12 - wetRim * 0.10, 0.30, wet);
  o.metal = 0;
  o.ao = 1 - crack * 0.78 - hair * 0.28 - pin * 0.45 - seamH * 0.35 - seamV * 0.2
    - tie * 0.5 - spall * 0.25 - (1 - aggD) * 0.08;
}

// アスファルト。
// 低: 舗装ロットの明度差・轍(わだち)・油染み / 中: 補修パッチの継ぎ目・
// タールで埋めたひび・掠れた白線 / 高: 骨材粒・砂
function asphalt(u, v, o, seed) {
  // 低周波
  const lot = fbm(u, v, 2, 2, seed + 500);
  const oil = smoothstep(0.60, 0.80, fbm(u, v, 3, 3, seed + 21));
  // 轍は進行方向に長い。等方ノイズでは絶対に出ない形なのでfbmAで潰す
  const rut = smoothstep(0.45, 0.78, fbmA(u, v, 2, 10, 2, seed + 600));

  // 中周波: 補修パッチ。セル境界(F2-F1)がそのまま切り継ぎの目地になる
  const patch = voronoi(u, v, 4, seed + 700);
  const patchId = patch.id;
  // 継ぎ目の幅。太いと路面が「白い蜘蛛の巣」で覆われるので、実物の
  // 切り継ぎ目地(数cm)相当まで絞る
  const patchEdge = smoothstep(0.038, 0.008, patch.d2 - patch.d);
  // ひび割れは場所を選ばせる。全面均一に入れると干上がった泥に見える
  const craze = smoothstep(0.40, 0.68, fbm(u, v, 4, 3, seed + 705));
  const mottle = fbm(u, v, 9, 3, seed + 510);
  const tar = smoothstep(0.84, 0.95, ridged(u, v, 7, 3, seed + 800));
  const netCrack = smoothstep(0.80, 0.95, ridged(u, v, 15, 3, seed + 810)) * craze;
  const seamCrack = patchEdge * (0.35 + craze * 0.65);
  // 掠れた白線。v方向の帯なので格子にならず、区画線らしく平行に並ぶ
  const lineBand = smoothstep(0.017, 0.007, tri(v));
  const paint = lineBand * smoothstep(0.50, 0.74, fbm(u, v, 22, 3, seed + 900));

  // 高周波
  const grit = voronoi(u, v, 100, seed + 55);
  const gritD = grit.d, gritId = grit.id;
  const sand = fbm(u, v, 170, 2, seed + 3);

  const pebble = smoothstep(0.42, 0.10, gritD);

  // 轍と低い側が重なった所にだけ水が残る。場内で一番強い鏡面になる場所。
  // 加算で作ると轍だけで飽和して舗装が全面濡れるので、両方が揃った所を積で拾う
  const pool = rut * smoothstep(0.52, 0.24, lot) + oil * 0.20;
  // 面積で1割も濡らすと、浅い視線角では空のIBLをほぼ鏡面のまま返すので
  // 広場に不定形な白飛びの塊が湧く。3%程度の「点在する小さな鏡」に絞ると、
  // 光の向きは出したまま塊にはならない
  const wet = smoothstep(0.50, 0.70, pool) * (1 - paint * 0.6);
  // 水たまりは面でなく縁で読ませる。溜まりの外周に濃く濡れた暗い帯を作る。
  // これが無いと「周囲との段差も輪郭も無いただの明るいシミ」になる
  const rim = smoothstep(0.44, 0.50, pool) * (1 - smoothstep(0.50, 0.56, pool));

  // 高さ場を2帯域に割る。(a)骨材の粒＝高周波・低振幅 (b)轍と補修の帯＝低周波・中振幅。
  // 旧実装は粒の振幅が帯の2倍あって、手前3mも奥30mも同じ粒径の虫食い模様に
  // 埋まっていた。粒を削って帯を立てると、距離で潰れる粒と残る帯に分かれて
  // 路面が距離の手がかりを返すようになる
  const hLow = lot * 0.20 + mottle * 0.12 - rut * 0.42
    + (patchId - 0.5) * 0.14 - patchEdge * 0.28;
  // 溝を深く彫るほど、低い太陽では片方の斜面が直射を正面から拾って
  // 「ひびが周囲より明るい線」になる。溝は浅く、暗さはアルベドとAOで語らせる
  const hFine = pebble * 0.17 + sand * 0.06
    - seamCrack * 0.30 - netCrack * 0.24 + tar * 0.26;
  // 水は窪みを埋めて平らになる。ここを残すと水たまりが粒立って見える
  o.h = hLow + hFine * (1 - wet * 0.85);

  // 骨材の粒ごとに明度を振る。単一トーンだと寄った時に紙やすりに見える。
  // ベースは実物のアルベド比(アスファルト0.10 : コンクリ0.35)から逆算し、
  // 黒帯にならないよう実物より少しだけ持ち上げた値(平均で概ね0.16)。
  // ここを上げすぎるとコンクリとの差が1.2倍程度まで詰まり、地面が
  // 「一枚の灰色い板」になって舗装の貼り分けが読めなくなる
  let tone = 0.045 + lot * 0.062 + mottle * 0.048 + patchId * 0.040
    + gritId * 0.070 * pebble + sand * 0.045;
  tone += rut * 0.058;                    // 轍は骨材が磨かれて明るい
  tone *= 1 - oil * 0.30;                 // 油は黒く沈む
  o.r = tone; o.g = tone * 1.01; o.b = tone * 1.08;
  // ひびは必ず暗い。溝の中は自己遮蔽で光が入らないうえ、埃と泥が詰まっている。
  // ここまで高さ場とAOにしか入れていなかったので、低い太陽では溝の片斜面が
  // 直射を拾って「路面より2倍明るい白い線」になっていた。アルベドで先に沈める
  const ck = clamp01(seamCrack + netCrack);
  o.r *= 1 - ck * 0.55; o.g *= 1 - ck * 0.55; o.b *= 1 - ck * 0.50;
  // タールは真っ黒、白線は掠れて灰色に近い。どちらもベースを下げたぶん
  // 目標色も一緒に下げないと、地の色に埋もれる／逆に浮いて線が主張しすぎる
  o.r = lerp(o.r, 0.022, tar * 0.8); o.g = lerp(o.g, 0.022, tar * 0.8); o.b = lerp(o.b, 0.026, tar * 0.8);
  // 白線は敢えて弱く。タイル周期(約4m)で平行に並ぶので、濃く入れると
  // 場内全体が縞模様に見えてしまう
  o.r = lerp(o.r, 0.30, paint * 0.5); o.g = lerp(o.g, 0.295, paint * 0.5); o.b = lerp(o.b, 0.275, paint * 0.5);
  // 濡れた所は暗く沈んで空を映す。ここが画の中で唯一「光の向き」を語る面になる。
  // 路面は上を向いているので水たまりは本物として読める。ただしタイルを並べると
  // 同じ形の暗い斑が一定間隔で並ぶので、色の落ち込みはコンクリより強い程度に留める
  // 濡れ縁は水を吸って一番暗い。この暗い輪郭があって初めて水たまりに見える
  const wd = (1 - wet * 0.32) * (1 - rim * 0.35);
  o.r *= wd; o.g *= wd; o.b *= wd * 1.02;

  // 粗さを0.14まで落とすと、浅い視線角で空をほぼ鏡面のまま返して白い塊になる。
  // 0.28あっても光の向き（太陽の伸びたハイライト）は十分に出るので、
  // 「鏡」ではなく「濡れた路面」の側に寄せる
  o.rough = lerp(0.94 - oil * 0.34 - rut * 0.10 - tar * 0.24 + sand * 0.03 - paint * 0.06, 0.28, wet);
  o.metal = 0;
  // 溝の自己遮蔽。高さ場を浅くしたぶんをこちらで深く取る
  o.ao = 1 - (1 - pebble) * 0.22 - seamCrack * 0.6 - netCrack * 0.5;
}

// 塗装された鉄板（コンテナ・斜路）。
// 低: パネルごとの塗装のヤレ・チョーキング・大きなへこみ / 中: パネル分割線・
// リベット・マスキングの塗り分け境界・ステンシル文字・下から溜まる錆と垂れ錆 /
// 高: ヘアライン・擦り傷・砂ぼこり
// 重要: 塗膜は誘電体。ここでmetalを上げると塗装面まで金属になって真っ黒に沈む
function metalPanel(u, v, o, seed) {
  const px = u * 4, py = v * 2;
  const pcol = Math.floor(px), prow = Math.floor(py);
  const pu = px - pcol, pv = py - prow;
  const gx = Math.abs(pu - 0.5), gy = Math.abs(pv - 0.5);
  const gm = gx > gy ? gx : gy;                 // パネル中心からの距離(0.5で境界)
  // 分割線は境界にだけ入れる。ここを逆向きに書くとパネル面全体が溝扱いで
  // 暗く沈み、コンテナが真っ黒の塊に見える（旧実装がそうなっていた）
  const seam = smoothstep(0.462, 0.5, gm);

  // リベット: パネル境界に沿って一定間隔で打つ
  const rx = fract(u * 32) - 0.5, ry = fract(v * 16) - 0.5;
  const nearEdge = smoothstep(0.34, 0.46, gm);
  const rivet = smoothstep(0.24, 0.1, Math.hypot(rx, ry)) * nearEdge;

  // 低周波: パネルごとの塗り直し差、白亜化、板の歪み
  const panelTone = hash2(pcol, prow, seed + 1);
  const chalk = fbm(u, v, 2, 2, seed + 220);
  const dent = fbm(u, v, 3, 3, seed + 210);

  // 中周波: 錆。下端に溜まり、上の目地から垂れる。この上下非対称が肝
  const lowGrad = smoothstep(0.50, 0.02, pv);
  const topGrad = smoothstep(0.55, 1.0, pv);
  const rustSrc = smoothstep(0.55, 0.88, fbm(u, v, 5, 4, seed + 77));
  const rustRun = smoothstep(0.46, 0.82, fbmA(u, v, 56, 4, 3, seed + 240));
  const rust = clamp01(rustSrc * (0.35 + lowGrad * 1.5)
    + rustRun * lowGrad * 0.85
    + rustRun * topGrad * 0.55
    + rivet * rustRun * 0.7);

  // 中周波: マスキングテープで塗り分けた境界。少し波打たせて手作業感を出す
  const trimEdge = pv + (fbm(u, v, 24, 2, seed + 250) - 0.5) * 0.02;
  const trim = smoothstep(0.30, 0.288, trimEdge);

  // 中周波: ステンシル文字風の矩形。実在の文字である必要はなく、
  // 5行のドット列を欠けさせるだけで遠目には印字に見える
  let stencil = 0;
  if (hash2(pcol, prow, seed + 55) > 0.52) {
    const cu = (pu - 0.17) * 8.5;
    const cv = (pv - 0.44) * 6.5;
    if (cu > 0 && cu < 5 && cv > 0 && cv < 1) {
      const ci = Math.floor(cu), cf = cu - ci;
      const rr = Math.floor(cv * 5);
      const on = hash2(ci * 7 + 1, rr, seed + 91) > 0.4;
      const inGlyph = cf > 0.14 && cf < 0.86 && Math.abs((cv * 5 - rr) - 0.5) < 0.34;
      if (on && inGlyph) stencil = 1;
    }
  }

  // 高周波
  const brushed = fbmA(u, v, 3, 220, 2, seed + 8);        // 横方向のヘアライン
  const scratch = smoothstep(0.80, 0.95, ridged(u, v, 22, 3, seed + 61));
  const grit = fbm(u, v, 150, 2, seed + 300);
  const bare = clamp01(scratch * 0.85 + smoothstep(0.74, 0.86, chalk) * 0.5);

  o.h = -seam * 0.85 + rivet * 0.9 + brushed * 0.05 + grit * 0.05
    - scratch * 0.22 - rust * 0.28 + (dent - 0.5) * 0.35
    - trim * 0.03 + stencil * 0.04;

  // 塗装色 → 塗り分けの帯 → ステンシル → 地金 → 錆 の順に上書き
  // 隣に来るコンクリ壁と明度が被ると素材が違って見えないので、
  // 塗装面はコンクリより一段下の青灰の帯として独立させる
  let r = 0.290 + panelTone * 0.055, g = 0.315 + panelTone * 0.045, b = 0.330 + panelTone * 0.038;
  r *= 1 - chalk * 0.16; g *= 1 - chalk * 0.16; b *= 1 - chalk * 0.14;
  r = lerp(r, r * 0.62, trim); g = lerp(g, g * 0.66, trim); b = lerp(b, b * 0.70, trim);
  const mark = stencil * (1 - rust) * (0.35 + (1 - chalk) * 0.65);
  r = lerp(r, 0.72, mark); g = lerp(g, 0.71, mark); b = lerp(b, 0.68, mark);
  r = lerp(r, 0.50, bare); g = lerp(g, 0.52, bare); b = lerp(b, 0.545, bare);
  r = lerp(r, 0.30, rust); g = lerp(g, 0.145, rust); b = lerp(b, 0.070, rust);
  const dk = 1 - seam * 0.40 - grit * 0.06;
  o.r = r * dk; o.g = g * dk; o.b = b * dk;

  // 塗膜は誘電体、剥げた地金だけ金属。錆も酸化物なのでほぼ非金属
  o.metal = clamp01(bare * 0.92 + rust * 0.10);
  const paintRough = lerp(0.44, 0.80, chalk);
  o.rough = clamp01(paintRough - bare * 0.10 + rust * 0.35 + brushed * 0.07 + stencil * 0.10);
  o.ao = 1 - seam * 0.55 - rust * 0.14 - scratch * 0.1;
}

// 木箱。
// 低: 板ごとの色差(幅を広く取る)・全体の薄汚れ / 中: 板の継ぎ目・年輪・
// 節・繊維に沿った割れ・釘とその周りの錆染み・面取りの摩耗 / 高: 導管・鋸目
function woodCrate(u, v, o, seed) {
  const PLANKS = 5;
  const pIdx = Math.floor(v * PLANKS);
  const pf = fract(v * PLANKS);
  const gap = smoothstep(0.055, 0.0, pf) + smoothstep(0.945, 1.0, pf);
  // 面取りは角が擦れて明るく毛羽立つ。ここが無いと板が金太郎飴に見える
  const chamfer = smoothstep(0.15, 0.05, Math.min(pf, 1 - pf)) * (1 - gap);
  const off = hash2(pIdx, 3, seed) * 10;
  const tone = hash2(pIdx, 9, seed);
  const sat = hash2(pIdx, 17, seed);

  // 中周波: 年輪。板ごとに位相をずらし、fbmで歪ませて直線に見せない
  const warp = fbm(u, v, 6, 3, seed + 5);
  const rings = Math.sin((u * 24 + off + warp * 7) * Math.PI);
  const knot = smoothstep(0.78, 0.90, fbm(u, v, 6, 3, seed + 44));
  // 割れは繊維(u方向)に沿って長く走る。等方ノイズだと点々にしかならない
  const split = smoothstep(0.76, 0.93, ridgedA(u, v, 3, 40, 2, seed + 55));
  // 釘: 板の両端、桟のある位置に打たれている想定
  const nx = Math.min(Math.abs(fract(u) - 0.07), Math.abs(fract(u) - 0.93));
  const nd = Math.hypot(nx, (pf - 0.5) / PLANKS);
  const nail = smoothstep(0.026, 0.012, nd);
  const nailStain = smoothstep(0.075, 0.020, nd);

  // 高周波
  const fine = fbmA(u, v, 128, 20, 2, seed + 2);     // 繊維方向に伸びた導管
  const saw = fbmA(u, v, 190, 5, 2, seed + 70);      // 木目を横切る鋸目
  const grime = fbm(u, v, 5, 4, seed + 61);

  o.h = rings * 0.10 + fine * 0.16 + saw * 0.05
    - gap * 1.0 - knot * 0.45 - split * 0.7 - chamfer * 0.35
    - nail * 0.9;

  // 使い込まれた合板。木箱は必ず土嚢の隣に積まれるので、土嚢(最も明るい素材)の
  // 7割の明度に置いて、砂色と生木を別の段として読ませる。ここを土嚢と同じまで
  // 上げると、隣り合った2素材が同じ明るさの塊に融けて形が読めなくなる
  const warm = 0.285 + tone * 0.165;
  const tint = rings * 0.045 + fine * 0.07 - knot * 0.17 - grime * 0.11 - split * 0.10;
  let r = warm + tint;
  let g = warm * (0.80 + sat * 0.07) + tint * 0.85;
  let b = warm * (0.56 + sat * 0.10) + tint * 0.6;
  // 面取りは擦れて白茶ける
  r = lerp(r, r * 1.30 + 0.03, chamfer * 0.8);
  g = lerp(g, g * 1.28 + 0.03, chamfer * 0.8);
  b = lerp(b, b * 1.24 + 0.03, chamfer * 0.8);
  // 釘穴の周りは水が回って黒ずむ
  const st = nailStain * 0.55;
  r *= 1 - st * 0.55; g *= 1 - st * 0.6; b *= 1 - st * 0.55;
  r = lerp(r, 0.26, nail * 0.9); g = lerp(g, 0.235, nail * 0.9); b = lerp(b, 0.215, nail * 0.9);
  const dk = 1 - gap * 0.78 - split * 0.45;
  o.r = r * dk; o.g = g * dk; o.b = b * dk;

  o.rough = clamp01(0.74 + fine * 0.16 + chamfer * 0.10 - knot * 0.12 - nail * 0.30);
  o.metal = nail * 0.85;
  o.ao = 1 - gap * 0.8 - knot * 0.3 - split * 0.45 - nail * 0.35;
}

// 土嚢。
// 低: 袋ごとの色差と泥汚れ / 中: 袋そのものの膨らみ・積み方のズレ・縫い目の
// ステッチ・上面の摩耗と退色 / 高: 麻布の織り目・毛羽
// 旧実装は織り目しか無く「布の壁」に見えていたので、袋の形を高さ場に入れた
function sandbag(u, v, o, seed) {
  const ROWS = 3, COLS = 2;
  const rowRaw = Math.floor(v * ROWS);
  const rf = fract(v * ROWS);
  const row = ((rowRaw % ROWS) + ROWS) % ROWS;
  // 段ごとに半個ズラす＋段ごとの微妙な狂い。揃いすぎると型抜きに見える
  const cu = u * COLS + (row & 1) * 0.5 + hash2(row, 41, seed) * 0.14;
  const colRaw = Math.floor(cu);
  const cf = cu - colRaw;
  const col = ((colRaw % COLS) + COLS) % COLS;
  const bagId = hash2(col, row, seed + 3);

  // 枕型の膨らみ。角丸の超楕円で落とすと袋らしい張りが出る。
  // 指数を上げすぎると角ばって「丸角のタイル」に見えるので2.2程度に留める
  const ex = Math.abs(cf - 0.5) * 2, ey = Math.abs(rf - 0.5) * 2;
  const q = Math.pow(ex, 2.0) + Math.pow(ey, 2.0);
  // 指数を1未満に寝かせると頂点側が平らになる。積まれた土嚢は上の袋に
  // 潰されて上面が平坦になるので、この平らな面が無いと「膨らんだ袋」ではなく
  // 断面が真円のチューブに見える
  const bulge = Math.pow(clamp01(1 - q), 0.62);
  const edge = smoothstep(0.80, 1.0, ex > ey ? ex : ey);
  // 縫い目のステッチ。袋の縁に沿って点線状に走る
  const stitch = edge * smoothstep(0.34, 0.12, tri((cf + rf) * 34));

  // 低周波
  const soil = fbm(u, v, 5, 4, seed + 18);
  const wide = fbm(u, v, 2, 2, seed + 22);
  // 中周波: 泥はね。袋の下半分に集中する
  const splat = smoothstep(0.66, 0.84, fbm(u, v, 14, 3, seed + 30));
  // 上側は日に焼けて白茶け、砂が擦れて毛羽立つ
  const sun = smoothstep(0.40, 0.95, rf);

  // 中周波: 袋の皺。縁に向かって寄る布のたるみ
  const wrinkle = (fbm(u, v, 22, 2, seed + 50) - 0.5) * (1 - bulge * 0.6);

  // 麻布の織り目。周期88はlevel.js側のUVスケール(1.1)だと1本0.5mmになり、
  // 2mも離れるとミップに消えて無地のビニールに見える。実物の麻袋の織り目
  // (1本3〜4mm)が2〜3mで読める周期まで落とす
  const weave = (tri(u * 30 + rf * 2) + tri(v * 30)) * 0.5;
  const fuzz = fbm(u, v, 140, 3, seed + 6);

  o.h = bulge * 1.5 - edge * 0.5 + stitch * 0.35 + wrinkle * 0.45
    + weave * (0.45 + (1 - bulge) * 0.30) + fuzz * 0.20
    + (bagId - 0.5) * 0.12;

  // 乾いた砂の色。土嚢は場内で明るい側の素材だが、明度も彩度も上げすぎていた。
  // 実測で路面の4倍の明度・B/R=0.54で、画面内で唯一の飽和色として視線を
  // 全部奪っていた（黄色いビニールのソーセージに見える原因）。
  // 麻袋は「汚れた生成り」であって鮮やかな黄土色ではないので、
  // 明度を約3割、彩度を半分近くまで落とす
  const base = (0.33 + bagId * 0.10 + soil * 0.12 + wide * 0.05) * (0.88 + sun * 0.20);
  let r = base, g = base * (0.86 + bagId * 0.07), b = base * (0.74 + bagId * 0.08);
  // 織り目を色にも出す。高さだけに入れると、光が回った時に無地の布に戻ってしまう
  const fiber = (weave - 0.25) * 0.15 + (fuzz - 0.5) * 0.09;
  r += fiber; g += fiber * 0.94; b += fiber * 0.82;
  // 下側は泥を吸って濃い。上下差を付けると積んだ壁に見える
  const wet = (1 - sun) * soil + splat * (1 - sun) * 0.8;
  r *= 1 - wet * 0.34; g *= 1 - wet * 0.32; b *= 1 - wet * 0.26;
  // 袋と袋の接触部。ここが浅いと6個の袋が1本の連続したチューブに融ける
  const dk = 1 - edge * 0.34 - (1 - bulge) * 0.10;
  o.r = r * dk; o.g = g * dk; o.b = b * dk;

  o.rough = clamp01(0.92 + fuzz * 0.08 - sun * 0.04);
  o.metal = 0;
  // 袋の合わせ目は袋どうしが押し合って光が入らない。edgeを深く取って
  // 「積んだ袋の列」として1個ずつ読めるようにする
  o.ao = 1 - edge * 0.70 - weave * 0.35 - (1 - bulge) * 0.15;
}

// レンガ。
// 低: 壁全体の湿り気ムラと白華(エフロレッセンス) / 中: 積み方・レンガごとの
// 焼きムラ・角の欠け・目地の凹み / 高: レンガの砂目・目地の砂粒・気泡
function brick(u, v, o, seed) {
  const bk = brickField(u, v, seed);
  const mortar = bk.mortar, round = bk.round, id = bk.id, bu = bk.bu, bv = bk.bv;

  // 低周波
  const damp = fbm(u, v, 2, 2, seed + 30);
  const efflo = smoothstep(0.60, 0.80, fbm(u, v, 3, 3, seed + 60));  // 白華
  const soot = smoothstep(0.55, 0.82, fbmA(u, v, 30, 3, 3, seed + 70)); // 雨だれの黒ずみ

  // 中周波: レンガごとの表情。1個ずつ焼きの当たりを変える
  const burn = hash2(Math.floor(id * 977), 3, seed + 11);
  const chip = smoothstep(0.52, 0.76, fbm(u, v, 26, 2, seed + 80)) * round;
  const faceTilt = (id - 0.5) * 0.5;

  // 高周波
  const sandy = fbm(u, v, 130, 2, seed + 90);
  const mgrain = voronoi(u, v, 80, seed + 100);
  const mgD = mgrain.d;
  const pit = smoothstep(0.74, 0.86, fbm(u, v, 190, 2, seed + 110));

  o.h = -mortar * 1.15 - round * 0.30 + faceTilt * 0.20
    + sandy * 0.16 - pit * 0.30 - chip * 0.55
    + (1 - mgD) * mortar * 0.25
    + Math.sin(bu * Math.PI) * Math.sin(bv * Math.PI) * 0.10;   // 面のわずかな膨らみ

  // レンガ本体。赤〜焦げ茶〜黄土まで振ると1枚ずつ違って見える。
  // 明度は実物の赤レンガ(0.15-0.25)に寄せて、同じ建物に載る漆喰の半分に置く。
  // ここを漆喰と同じ明るさにすると、剥がれた所と残った所が同じ帯に入って
  // 「下地が覗いている」ことが読めなくなる
  const warm = 0.185 + burn * 0.150;
  let r = warm * (1.0 + id * 0.10) + sandy * 0.05;
  let g = warm * (0.46 + burn * 0.16) + sandy * 0.045;
  let b = warm * (0.33 + id * 0.12) + sandy * 0.04;
  // 目地は砂まじりのグレー。白く置くとレンガより目地のほうが目立って
  // 壁が「白い格子」に見えるので、レンガの1.4倍程度に留める
  const mg = 0.355 + mgD * 0.12 + sandy * 0.05;
  r = lerp(r, mg, mortar); g = lerp(g, mg * 0.99, mortar); b = lerp(b, mg * 0.95, mortar);
  // 欠けた角は焼けていない生地が出るので明るい
  r = lerp(r, 0.46, chip * 0.6); g = lerp(g, 0.36, chip * 0.6); b = lerp(b, 0.30, chip * 0.6);
  // 白華は上から薄く被る、雨だれは黒く流れる
  r = lerp(r, 0.62, efflo * 0.35); g = lerp(g, 0.61, efflo * 0.35); b = lerp(b, 0.59, efflo * 0.35);
  const dk = (1 - soot * 0.20) * (1 - smoothstep(0.5, 0.95, damp) * 0.14);
  o.r = r * dk; o.g = g * dk; o.b = b * dk;

  o.rough = clamp01(0.78 + sandy * 0.12 + mortar * 0.12 + chip * 0.08 - efflo * 0.05);
  o.metal = 0;
  o.ao = 1 - mortar * 0.55 - round * 0.20 - pit * 0.35 - chip * 0.2;
}

// 塗装された構造鋼（鉄塔・ドラム缶・古い鉄骨）。
// 旧実装は面の全部を大きな錆の鱗で埋めていたので、主柱にも細い斜材にも
// 部材幅と無関係の同じ鱗が乗って「ワニ革」に見えていた。
// 実物は塗膜が生きている面が大半で、錆はボルト列・溶接ビード・下端という
// 決まった発生源から出て、そこから下へ垂れる。主役は鱗ではなく縦の垂れ。
// 低: 塗膜のヤレと白亜化 / 中: ビード・ボルト・発錆域・垂れ錆 / 高: 鱗・孔食・粒
function rustMetal(u, v, o, seed) {
  // 低周波
  const zone = fbm(u, v, 2, 2, seed + 30);
  const patch = fbm(u, v, 4, 3, seed);
  const chalk = smoothstep(0.52, 0.86, fbm(u, v, 3, 2, seed + 150));   // 塗膜の白亜化

  // 中周波: 溶接ビードとボルト列。錆の発生源をここに集める。
  // 定規で引いた直線と等間隔・等サイズのボルトを並べると、部材ではなく
  // 壁紙に見えるので、線は波打たせ、ボルトは間引いて大きさも振る
  const beadD = tri(v * 2 + (fbm(u, v, 8, 2, seed + 62) - 0.5) * 0.05);
  const bead = smoothstep(0.020, 0.005, beadD);
  const bcol = Math.floor(u * 10), brow = Math.floor(v * 2 + 0.25);
  const bOn = hash2(bcol, brow, seed + 63) > 0.40 ? 1 : 0;
  const bR = 0.0060 + hash2(bcol, brow, seed + 64) * 0.0042;
  const bdx = (fract(u * 10) - 0.5) / 10 + (hash2(bcol, brow, seed + 65) - 0.5) * 0.012;
  const bdy = (fract(v * 2 + 0.25) - 0.5) / 2;
  const bolt = bOn * smoothstep(bR, bR * 0.40, Math.hypot(bdx, bdy));

  // 発錆域。塗膜が死ぬのは発生源の周りと下端だけにして、面積を3〜4割に抑える
  const low = smoothstep(0.34, 0.0, fract(v) + (fbm(u, v, 6, 3, seed + 66) - 0.5) * 0.22);
  const src = smoothstep(0.60, 0.80, patch);
  const bite = clamp01(src * (0.5 + zone * 0.7) + bead * 0.45 + bolt * 0.75 + low * 0.55);
  // 垂れ錆。縦に伸ばした筋を主役にする。鱗に負けると全面がワニ革に戻る。
  // 垂れは必ず発生源より「下」にしか出ない。v=0が下端なので、直上のビード列
  // までの距離で指数減衰させる。ここを方向の無いノイズで済ませると、
  // 垂れが上へも伸びて重力を無視した模様になる
  const dBelow = (1 - fract(v * 2)) * 0.5;
  const fall = Math.exp(-dBelow * 5.0);
  // 筋が出る列は列ごとに決める（周期1＝v方向に一定＝列ごとの乱数）。
  // 全列から等しく垂らすとバーコードに見える
  const colSrc = smoothstep(0.40, 0.72, fbmA(u, v, 22, 1, 2, seed + 91));
  const run = smoothstep(0.44, 0.80, fbmA(u, v, 36, 3, 3, seed + 90))
    * fall * colSrc * (0.45 + zone * 0.8);
  const rust = clamp01(smoothstep(0.30, 0.62, bite) + run * 0.70);

  // 高周波: 剥離の鱗。錆びた所にだけ、部材の太さに負けない細かさで乗せる
  const sc = voronoi(u, v, 34, seed + 60);
  const flakeEdge = smoothstep(0.055, 0.0, sc.d2 - sc.d) * rust;
  const lifted = (sc.id - 0.45) * smoothstep(0.30, 0.08, sc.d) * rust;
  const pitc = voronoi(u, v, 95, seed + 120);
  const grain = fbm(u, v, 175, 2, seed + 130);
  const peel = fbm(u, v, 60, 2, seed + 140);                          // 塗膜のうねり
  const deep = smoothstep(0.35, 0.06, pitc.d) * rust * (0.4 + patch * 0.8);

  o.h = zone * 0.14 + patch * 0.12
    + bead * 0.55 + bolt * 0.85
    + lifted * 0.30 - flakeEdge * 0.40 - deep * 0.30
    + run * 0.22 + grain * 0.10 + (peel - 0.5) * 0.10 * (1 - rust);

  // 塗膜: 構造物用の赤系ペイント。錆と違って彩度が高く、粗さが低い
  const pt = clamp01(0.5 + (zone - 0.5) * 0.6);
  let r = 0.235 + pt * 0.075, g = 0.083 + pt * 0.030, b = 0.058 + pt * 0.020;
  r = lerp(r, r * 1.35 + 0.05, chalk * 0.5);
  g = lerp(g, g * 1.40 + 0.05, chalk * 0.5);
  b = lerp(b, b * 1.45 + 0.05, chalk * 0.5);

  // 錆の色域: 焦げた暗褐色 → 橙 → 白茶けた黄土。3色を混ぜると単色錆から脱する
  const t1 = clamp01(patch * 1.2 - 0.1);
  const t2 = clamp01(zone * 1.1 - 0.15);
  let rr = lerp(0.19, 0.47, t1), rg = lerp(0.095, 0.235, t1), rb = lerp(0.055, 0.105, t1);
  rr = lerp(rr, 0.50, t2 * 0.5); rg = lerp(rg, 0.34, t2 * 0.5); rb = lerp(rb, 0.20, t2 * 0.5);
  // 孔食の底は湿って黒い
  rr *= 1 - deep * 0.32; rg *= 1 - deep * 0.34; rb *= 1 - deep * 0.32;

  r = lerp(r, rr, rust); g = lerp(g, rg, rust); b = lerp(b, rb, rust);
  // 垂れは面の上を流れた跡なので、発錆域の外へも薄く伸びる
  r = lerp(r, 0.44, run * 0.70); g = lerp(g, 0.21, run * 0.70); b = lerp(b, 0.09, run * 0.70);
  // ごく稀に地金が覗く。明るくしすぎると錆の上に雪が乗ったように見える
  const shiny = smoothstep(0.95, 1.0, pitc.id) * smoothstep(0.45, 0.22, patch) * rust;
  r = lerp(r, 0.38, shiny); g = lerp(g, 0.385, shiny); b = lerp(b, 0.39, shiny);
  const dk = 1 - flakeEdge * 0.20 - bead * 0.10;
  o.r = (r + grain * 0.035) * dk; o.g = (g + grain * 0.030) * dk; o.b = (b + grain * 0.026) * dk;

  // 塗膜は誘電体で艶が残る。錆は酸化物なので粗くほぼ非金属
  o.rough = clamp01(lerp(0.46 + chalk * 0.26 + peel * 0.06, 0.92 + grain * 0.06, rust) - shiny * 0.45);
  o.metal = clamp01(0.04 + shiny * 0.85);
  o.ao = 1 - flakeEdge * 0.35 - deep * 0.30 - bead * 0.15 - rust * 0.10;
}

// ひび割れた漆喰。剥がれた所から下地のレンガが覗く。
// 低: 剥落した大きな領域 / 中: ひび割れ網・剥落の縁の段差・水染み・補修跡 /
// 高: コテ跡・砂粒・ピンホール
function plaster(u, v, o, seed) {
  // 低周波: どこが剥がれ落ちたか。境界に中周波を足して縁をボロボロにする
  // （滑らかな境界のままだと壁に塗料をぶちまけたような形に見える）
  const fall = fbm(u, v, 3, 3, seed + 10) + (fbm(u, v, 22, 3, seed + 12) - 0.5) * 0.17;
  const wide = fbm(u, v, 2, 2, seed + 15);
  const exposed = smoothstep(0.50, 0.585, fall);
  const rim = smoothstep(0.50, 0.545, fall) * (1 - smoothstep(0.560, 0.605, fall));

  // 中周波: ひび。粗い網と細い網の2段
  const crack = smoothstep(0.72, 0.88, ridged(u, v, 6, 4, seed + 20)) * (1 - exposed);
  const crack2 = smoothstep(0.80, 0.95, ridged(u, v, 18, 3, seed + 21)) * (1 - exposed);
  const stain = smoothstep(0.52, 0.80, fbmA(u, v, 22, 3, 3, seed + 40));   // 雨染めの縦筋
  const repair = smoothstep(0.64, 0.78, fbm(u, v, 5, 2, seed + 45));        // 塗り直したパッチ

  // 高周波: コテ跡は一方向に伸びる。砂目とピンホール
  const trowel = fbmA(u, v, 9, 90, 2, seed + 50);
  const sand = fbm(u, v, 145, 2, seed + 60);
  const pin = smoothstep(0.74, 0.86, fbm(u, v, 200, 2, seed + 65));

  // 下地のレンガ
  const bk = brickField(u, v, seed + 700);
  const bMortar = bk.mortar, bId = bk.id, bRound = bk.round;

  const brickH = -bMortar * 1.0 - bRound * 0.25;
  const plasterH = trowel * 0.22 + sand * 0.12 - crack * 0.8 - crack2 * 0.35
    - pin * 0.30 + (repair - 0.5) * 0.10 + wide * 0.14;
  o.h = lerp(plasterH + 0.55, brickH, exposed) - rim * 0.25;

  // 漆喰: 汚れた生成り。壁の中では明るい側の代表として置き、下地レンガとの間に
  // 2倍近い明度差を作る。上げすぎると空の階調帯に食い込んで前景/中景の分離が消える
  let pr = 0.435 + (wide - 0.5) * 0.145 + (sand - 0.5) * 0.065 + (trowel - 0.5) * 0.07;
  pr *= 1 - stain * 0.34 - crack * 0.25;
  let pg = pr * 0.985, pb = pr * 0.945;
  pr = lerp(pr, 0.48, repair * 0.35); pg = lerp(pg, 0.47, repair * 0.35); pb = lerp(pb, 0.455, repair * 0.35);

  // 下地レンガ: 表に出ている面ほど風化していないので彩度を残す。
  // 明度はbrick()と揃える（別々に持つと同じ建物で下地の色が食い違う）
  const warm = 0.205 + bId * 0.17;
  let br = warm * 1.05, bg = warm * 0.50, bb = warm * 0.36;
  const bm = 0.40 + sand * 0.08;
  br = lerp(br, bm, bMortar); bg = lerp(bg, bm * 0.99, bMortar); bb = lerp(bb, bm * 0.95, bMortar);

  let r = lerp(pr, br, exposed), g = lerp(pg, bg, exposed), b = lerp(pb, bb, exposed);
  // 剥落の縁は割れ口が白く立ち、内側に影が落ちる
  r = lerp(r, 0.50, rim * 0.4); g = lerp(g, 0.49, rim * 0.4); b = lerp(b, 0.47, rim * 0.4);
  const dk = 1 - crack * 0.35 - crack2 * 0.15 - pin * 0.2;
  o.r = r * dk; o.g = g * dk; o.b = b * dk;

  o.rough = clamp01(0.86 + sand * 0.10 - repair * 0.06 + exposed * 0.04);
  o.metal = 0;
  o.ao = 1 - crack * 0.55 - crack2 * 0.2 - pin * 0.35 - exposed * 0.15 - bMortar * exposed * 0.4;
}

// 土と砂利の地面。
// 低: 乾湿のムラ・広い窪み / 中: 砂利の塊・乾いた泥のひび・踏み荒らし /
// 高: 砂粒・小石
function dirt(u, v, o, seed) {
  // 低周波
  const damp = fbm(u, v, 2, 3, seed);
  const dip = fbm(u, v, 4, 3, seed + 20);
  const mottle = fbm(u, v, 9, 3, seed + 25);

  // 中周波: 砂利のかたまり。粒が一様に散るのではなく塊で寄る
  const grav = voronoi(u, v, 24, seed + 40);
  const gD = grav.d, gId = grav.id;
  const cluster = smoothstep(0.44, 0.74, fbm(u, v, 6, 3, seed + 45));
  const stone = smoothstep(0.40, 0.12, gD) * cluster;
  // 乾いた泥のひび割れ。湿った所には出ない
  const mud = smoothstep(0.74, 0.90, ridged(u, v, 11, 3, seed + 50)) * smoothstep(0.55, 0.30, damp);
  // 踏み荒らし・轍。方向性を持たせる
  const tread = smoothstep(0.48, 0.78, fbmA(u, v, 3, 14, 2, seed + 55));

  // 高周波
  const fineC = voronoi(u, v, 105, seed + 70);
  const fD = fineC.d, fId = fineC.id;
  const sand = fbm(u, v, 185, 2, seed + 80);
  const pebble = smoothstep(0.38, 0.12, fD);

  o.h = (dip - 0.5) * 0.45 - tread * 0.25
    + stone * 0.55 + pebble * 0.18 + sand * 0.14
    - mud * 0.55 + (gId - 0.5) * stone * 0.25;

  // 土: 湿った所は濃い茶、乾いた所は白っぽい砂色
  const dry = 1 - clamp01(damp * 1.2 - 0.1);
  let r = lerp(0.20, 0.42, dry) + (sand - 0.5) * 0.10 + (mottle - 0.5) * 0.11;
  let g = lerp(0.148, 0.350, dry) + (sand - 0.5) * 0.09 + (mottle - 0.5) * 0.10;
  let b = lerp(0.098, 0.262, dry) + (sand - 0.5) * 0.07 + (mottle - 0.5) * 0.08;
  // 砂利は灰色寄り。粒ごとに明度を振る。明るくしすぎると降雪に見える
  const st = 0.28 + gId * 0.20;
  r = lerp(r, st, stone * 0.85); g = lerp(g, st * 0.98, stone * 0.85); b = lerp(b, st * 0.94, stone * 0.85);
  const ft = 0.24 + fId * 0.18;
  r = lerp(r, ft, pebble * 0.45); g = lerp(g, ft * 0.98, pebble * 0.45); b = lerp(b, ft * 0.93, pebble * 0.45);
  // 踏まれた所は土が締まって暗い
  const dk = 1 - tread * 0.14 - mud * 0.35 - smoothstep(0.55, 0.95, damp) * 0.12;
  // ぬかるみは水を含んで暗く光る。地面素材が全部0.9台のラフネスだと
  // どこにも光の向きが出ないので、湿った側に鏡面のアンカーを作る
  const wet = smoothstep(0.545, 0.665, damp) * (1 - stone * 0.5);
  const wd = 1 - wet * 0.30;
  o.r = r * dk * wd; o.g = g * dk * wd; o.b = b * dk * wd;

  o.rough = clamp01(lerp(0.94 - stone * 0.10 + sand * 0.04, 0.16, wet));
  o.metal = 0;
  o.ao = 1 - mud * 0.4 - (1 - pebble) * 0.10 - (1 - stone) * 0.06 - tread * 0.08;
}

// 波板トタン。
// 低: 板全体の退色とたわみ / 中: 波型そのもの・パネルの重ね継ぎ・
// ワッシャ付きビス・下端に溜まる錆 / 高: 汚れの粒・擦り傷・小さな凹み
function corrugated(u, v, o, seed) {
  const WAVES = 14;                        // 1タイルあたりの山の数
  const ph = u * WAVES;
  const wave = Math.cos(ph * Math.PI * 2);  // +1が山、-1が谷
  const peakDist = (0.5 - tri(ph)) / WAVES; // 山の頂点からの距離(タイル単位)

  // 中周波: パネルの重ね継ぎ。v方向に一定間隔で段差が入る
  const lapDist = 0.5 - tri(v);            // 継ぎ目(fract(v)=0)からの距離
  const lap = smoothstep(0.022, 0.0, lapDist);
  // ビスは山の頂点に、継ぎ目からずらして打つ
  const sx = peakDist;
  const sy = (fract(v * 4) - 0.5) / 4;
  const screwD = Math.hypot(sx, sy);
  const screw = smoothstep(0.011, 0.005, screwD);
  const washer = smoothstep(0.018, 0.012, screwD) * (1 - screw);

  // 低周波
  const fade = fbm(u, v, 2, 2, seed + 10);
  const sag = fbmA(u, v, 2, 6, 2, seed + 15);

  // 中周波: 錆。谷に水が残るので谷筋と下端に集中し、そこから下へ流れる
  const low = smoothstep(0.55, 0.0, fract(v));
  const valley = smoothstep(-0.1, -0.85, wave);   // 谷筋(wave<0)ほど1
  const rustSrc = smoothstep(0.52, 0.86, fbm(u, v, 6, 4, seed + 20));
  const rustRun = smoothstep(0.44, 0.80, fbmA(u, v, 48, 4, 3, seed + 25));
  const rust = clamp01(rustSrc * (0.3 + low * 1.3 + valley * 0.5)
    + rustRun * low * 0.8 + screw * rustRun * 1.2);

  // 高周波
  const grit = fbm(u, v, 150, 2, seed + 30);
  const scratch = smoothstep(0.80, 0.95, ridgedA(u, v, 6, 120, 2, seed + 35));
  const dentN = fbm(u, v, 12, 2, seed + 40);

  o.h = wave * 1.0 + (sag - 0.5) * 0.25 + (dentN - 0.5) * 0.10
    - lap * 0.5 - screw * 0.7 + washer * 0.25
    + grit * 0.04 - scratch * 0.10 - rust * 0.10;

  // 亜鉛メッキの銀灰色。退色と結晶模様で単色を避ける
  const spangle = fbm(u, v, 18, 2, seed + 45);
  let base = 0.46 + spangle * 0.10 - fade * 0.12 + grit * 0.05;
  base *= 1 - valley * 0.10;                       // 谷は汚れが溜まって暗い
  let r = base, g = base * 0.995, b = base * 0.98;
  r = lerp(r, 0.34, rust); g = lerp(g, 0.165, rust); b = lerp(b, 0.075, rust);
  const dk = 1 - lap * 0.25 - screw * 0.25;
  o.r = r * dk; o.g = g * dk; o.b = b * dk;

  o.metal = clamp01(0.85 - rust * 0.78 + screw * 0.1);
  o.rough = clamp01(0.42 + fade * 0.20 + rust * 0.42 + grit * 0.08 - scratch * 0.12);
  o.ao = 1 - valley * 0.22 - lap * 0.4 - screw * 0.35 - rust * 0.12;
}

/* ---------------------------------------------------------- sprite maps */

// 中心が白く飛び、外に向かって減衰する丸。閃光・火花・血しぶきの共通素材
export function radialTexture(size = 64, power = 2.2, hardness = 0) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot((x - c) / c, (y - c) / c);
      let a = clamp01(1 - d);
      a = Math.pow(a, power);
      if (hardness > 0) a = clamp01(a * (1 + hardness) - hardness * smoothstep(0.0, 1.0, d));
      const i = (y * size + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
      data[i + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// もくもくした煙。ノイズで輪郭を崩さないと丸い玉に見えてしまう
export function smokeTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const d = Math.hypot((x - c) / c, (y - c) / c);
      const n = fbm(u, v, 6, 5, 91);
      const a = clamp01(smoothstep(1.0, 0.15, d) * (0.35 + n * 1.1) - 0.12);
      const lum = 0.55 + n * 0.45;
      const i = (y * size + x) * 4;
      data[i] = lum * 255; data[i + 1] = lum * 255; data[i + 2] = lum * 255;
      data[i + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// マズルフラッシュ。中心のコア＋不規則な放射の花弁
export function muzzleFlashTexture(size = 128) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x - c) / c, dy = (y - c) / c;
      const d = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const petal = 0.45 + 0.55 * Math.pow(Math.abs(Math.cos(ang * 2.5)), 1.5)
        + 0.25 * Math.sin(ang * 7);
      const reach = clamp01(1 - d / (petal * 0.95));
      const core = smoothstep(0.28, 0.0, d);
      const a = clamp01(Math.pow(reach, 2.0) * 0.85 + core);
      const heat = clamp01(core * 1.2 + Math.pow(reach, 3) * 0.6);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = lerp(160, 255, heat);
      data[i + 2] = lerp(40, 220, heat * heat);
      data[i + 3] = a * 255;
    }
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/* ---------------------------------------------------------- 汚しデカール */

// 建築の汚れは、タイル1枚のproceduralテクスチャでは原理的に作れない。
// 「どこから雨が垂れたか」「どこに泥が跳ねたか」は面の中の位置で決まるのに、
// タイルは位置を持たないからで、壁が均一なノイズを貼った板に見える原因がこれ。
// そこで貼り込み専用のアルファ付きデカールを別に焼く。
// RGBが汚れの色、Aが被り具合。DataTextureは行0がv=0なので v=0 が下端。
function alphaTexture(w, h, cb, aniso) {
  const data = new Uint8Array(w * h * 4);
  const out = { r: 0, g: 0, b: 0, a: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      out.r = 0; out.g = 0; out.b = 0; out.a = 0;
      cb((x + 0.5) / w, (y + 0.5) / h, out);
      const i = (y * w + x) * 4;
      data[i] = clamp01(out.r) * 255;
      data[i + 1] = clamp01(out.g) * 255;
      data[i + 2] = clamp01(out.b) * 255;
      data[i + 3] = clamp01(out.a) * 255;
    }
  }
  const t = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
  t.colorSpace = THREE.SRGBColorSpace;
  // 繰り返すと汚れが枠のように四方に回り込むので必ずクランプ
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = aniso;
  t.needsUpdate = true;
  return t;
}

/**
 * 汚し層のデカール一式。level.js側で開口の直下・建物の外周基部・ボルト位置に
 * quadとして貼る想定（透過・polygonOffsetを効かせた材質で使う）。
 */
export function buildDecals(aniso = 4) {
  // (a) 窓台や庇の下から垂れる雨だれ。上端が発生源
  const rainStreak = alphaTexture(96, 256, (u, v, o) => {
    const col = fbmA(u, v, 26, 1, 1, 71);              // v方向に一定＝筋ごとの乱数
    const n = fbmA(u, v, 22, 5, 3, 72);
    const line = smoothstep(0.44, 0.70, n);
    // 届く長さを筋ごとにバラす。全部同じ高さで切れるとバーコードに見える
    const reach = 0.30 + col * 0.65;
    const down = smoothstep(1 - reach, 1.0, v);        // v=1(上端)ほど濃い
    const side = smoothstep(0.0, 0.10, u) * smoothstep(1.0, 0.90, u);
    const spread = smoothstep(1.0, 0.55, v) * 0.25;    // 下ほど薄く広がる
    const t = 0.15 + n * 0.09;
    o.r = t; o.g = t * 0.96; o.b = t * 0.90;
    o.a = clamp01((line * down + spread * down * 0.6) * side) * 0.72;
  }, aniso);

  // (b) 壁と地面の接合部。跳ね返った泥が下端に溜まる
  const grime = alphaTexture(256, 96, (u, v, o) => {
    const n = fbm(u, v, 9, 4, 81);
    const splat = smoothstep(0.58, 0.86, fbm(u, v, 26, 3, 82));
    const edge = 0.30 + n * 0.55;                      // 上縁を波打たせて直線を殺す
    const up = smoothstep(edge, 0.0, v);               // v=0(下端)ほど濃い
    const t = 0.13 + n * 0.09;
    o.r = t * 1.05; o.g = t * 0.90; o.b = t * 0.70;
    o.a = clamp01(up * (0.65 + n * 0.6) + splat * smoothstep(0.55, 0.0, v) * 0.5) * 0.85;
  }, aniso);

  // (c) ボルトや金具から下に伸びる錆垂れ。発生源は幅が狭く濃い
  const rustRun = alphaTexture(48, 160, (u, v, o) => {
    const wob = (fbmA(u, v, 3, 18, 3, 91) - 0.5) * 0.22;
    const cx = 0.5 + wob * (1 - v);
    const w = 0.10 + (1 - v) * 0.22;
    const core = smoothstep(w, w * 0.25, Math.abs(u - cx));
    const n = fbmA(u, v, 10, 40, 3, 92);
    const fade = smoothstep(0.0, 0.55, v) * (0.4 + n * 0.9);
    const t1 = clamp01(n * 1.1);
    o.r = lerp(0.30, 0.47, t1); o.g = lerp(0.135, 0.225, t1); o.b = lerp(0.065, 0.10, t1);
    o.a = clamp01(core * fade) * 0.80;
  }, aniso);

  // (d) 落書き。実在の文字である必要はなく、太い曲線を数本重ねて縁を
  // スプレーで崩せば遠目にはタグに見える
  const graffiti = alphaTexture(256, 160, (u, v, o) => {
    let a = 0, pick = 0;
    for (let s = 0; s < 4; s++) {
      const ph = hash2(s, 1, 909) * 6.2832;
      const amp = 0.10 + hash2(s, 2, 909) * 0.16;
      const fr = 1.4 + hash2(s, 3, 909) * 2.6;
      const yc = 0.42 + (hash2(s, 4, 909) - 0.5) * 0.34;
      const y = yc + Math.sin(u * fr * 6.2832 + ph) * amp;
      const w = 0.030 + hash2(s, 5, 909) * 0.028;
      const stroke = smoothstep(w, w * 0.3, Math.abs(v - y));
      if (stroke > a) { a = stroke; pick = hash2(s, 6, 909); }
    }
    // 掠れと端の減衰。矩形にスパッと切れると落書きでなく貼り紙に見える
    const dry = smoothstep(0.34, 0.72, fbm(u, v, 14, 3, 910));
    const side = smoothstep(0.0, 0.14, u) * smoothstep(1.0, 0.86, u);
    const spray = smoothstep(0.62, 0.88, fbm(u, v, 60, 2, 911)) * a * 0.5;
    o.r = pick < 0.34 ? 0.62 : pick < 0.67 ? 0.15 : 0.55;
    o.g = pick < 0.34 ? 0.14 : pick < 0.67 ? 0.30 : 0.52;
    o.b = pick < 0.34 ? 0.16 : pick < 0.67 ? 0.52 : 0.10;
    o.a = clamp01((a * (1 - dry * 0.55) + spray) * side) * 0.85;
  }, aniso);

  // (e) 剥落したモルタル。落ちた所から粗い骨材が出るので周りより明るく粒立つ
  const spall = alphaTexture(160, 160, (u, v, o) => {
    const shape = fbm(u, v, 3, 3, 921) + (fbm(u, v, 20, 3, 922) - 0.5) * 0.22;
    const disc = smoothstep(0.28, 0.60, 1 - Math.hypot(u - 0.5, v - 0.5) * 2);
    const agg = voronoi(u, v, 34, 923);
    const grain = fbm(u, v, 90, 2, 924);
    const tone = 0.30 + agg.id * 0.16 + grain * 0.08;
    // 割れ口の縁は立って明るい。ここが無いと壁に塗料をぶちまけた形に見える
    const rim = smoothstep(0.50, 0.545, shape) * (1 - smoothstep(0.555, 0.60, shape)) * disc;
    o.r = lerp(tone, 0.42, rim * 0.5);
    o.g = lerp(tone * 0.97, 0.41, rim * 0.5);
    o.b = lerp(tone * 0.92, 0.39, rim * 0.5);
    o.a = clamp01(smoothstep(0.50, 0.60, shape) * disc) * 0.95;
  }, aniso);

  // (f) 舗装の切り替わり(アスファルト↔コンクリ)にまたがせる帯。砂利・泥・タイヤ痕。
  // 材質の違う面同士は必ず定規で引いた直線で接するので、その線をまたいで
  // 散らかった物を置かないといつまでも施工図に見える。
  // 帯の長手をu、跨ぐ向きをvに取る(v=0.5が境界線の真上、v=0/1が帯の外周)
  const edgeBand = alphaTexture(256, 64, (u, v, o) => {
    const ragged = (fbm(u, v, 6, 3, 931) - 0.5) * 0.55;   // 縁を波打たせて直線を殺す
    const across = Math.abs(v - 0.5) * 2 + ragged;
    // 端は必ず0まで落とす。板の縁でアルファが残ると、そこが新しい直線になる
    const hem = smoothstep(0.0, 0.10, v) * smoothstep(1.0, 0.90, v);
    const body = smoothstep(1.0, 0.10, across) * hem;
    const grit = voronoi(u, v, 30, 932);
    const cluster = smoothstep(0.30, 0.68, fbm(u, v, 5, 3, 933));
    const stone = smoothstep(0.38, 0.12, grit.d) * cluster;
    // タイヤ痕は帯を跨ぐ向きに走る。u方向に細かくv方向に粗いノイズで縦筋になる
    const tread = smoothstep(0.52, 0.86, fbmA(u, v, 40, 2, 2, 934));
    const dust = fbm(u, v, 22, 3, 935);
    const mud = 0.115 + dust * 0.075;
    let r = mud * 1.06, g = mud * 0.94, b = mud * 0.76;
    const st = 0.19 + grit.id * 0.14;
    r = lerp(r, st, stone * 0.8); g = lerp(g, st * 0.98, stone * 0.8); b = lerp(b, st * 0.94, stone * 0.8);
    r = lerp(r, 0.045, tread * 0.7); g = lerp(g, 0.045, tread * 0.7); b = lerp(b, 0.050, tread * 0.7);
    o.r = r; o.g = g; o.b = b;
    o.a = clamp01(body * (0.42 + dust * 0.75) + stone * body * 0.6 + tread * body * 0.35) * 0.9;
  }, aniso);
  // 長い境界に沿って引き伸ばして使うので、長手だけは繰り返せるようにする。
  // 中のノイズは全部整数周期なのでu方向に継ぎ目は出ない
  edgeBand.wrapS = THREE.RepeatWrapping;

  return { rainStreak, grime, rustRun, graffiti, spall, edgeBand };
}

/* ------------------------------------------------------------ sky / IBL */

// 空はシェーダーで描く。PMREMでIBLに焼かれるので、ここの質が上がると
// 金属の映り込みも影の中の色も全部良くなる。
// 層構成: 大気の勾配 → 地平のヘイズ → 太陽 → 積雲(平面投影) → 巻雲 → 地面側。
// 天頂の青。以前より彩度と明度を上げてある。FOV75・目線の高さの視界には
// 天頂そのものは入らないので、ここが弱いと画面から青が1ピクセルも消えて
// 空・地面・木箱・兵士まで全部が同じhue20〜45度のセピア一色に落ちる。
const SKY_ZENITH = 0x2f5e93;
const SKY_HORIZON = 0xc6b49b;
const SKY_GROUND = 0x413a31;
// 空の最終ゲイン。素のアルベド色をそのまま出していたので、太陽と環境光を
// 積み増した地面のほうが光源である空より明るいという物理的にありえない
// 並びになっていた。ここで空を持ち上げて 空 > 日向 > 日陰 の順序を作る。
// 露出(main.jsのtoneMappingExposure)側で全体を下げ直す前提の値。
// 2.75は上げすぎで、暖色のヘイズごと持ち上がって画面全体が白茶けていた。
// 2.35でもまだ高い。ACESの肩(1.0付近から圧縮が始まる)にRGBが3本とも
// 乗ってしまうので、リニアでどれだけ青くしても表示に出る頃には
// 3本が同じ値へ収束して無彩色に漂白される。実測で天頂が(206,201,207)、
// つまり彩度0.16しか残っていなかった。
// 「空だけリニアで持ち上げて、全体を露出で絞り直す」という作りは、
// 空の彩度だけを選択的に殺す構造になっているので、持ち上げをやめる。
// 1.5なら天頂が(53,134,201)相当まで戻り、地平のヘイズは(228,221,207)で
// 空 > 日向 > 日陰 の並びも保てる
const SKY_GAIN = 1.5;

// installAerialPerspective()はここでは呼ばない。太陽の向き(sunDir)を
// main.jsのSUN_DIRからもらう必要があり、main.jsはこのファイルを先に
// importするのでモジュール評価の時点ではまだSUN_DIRが無い。
// main.js側でSUN_DIRを決めた直後に呼んでもらう
// （呼ぶタイミングの制約は関数のJSDocを参照。材質のコンパイルより前ならよい）

// 遠景の色は installAerialPerspective() が視線方向と高度から作るので、
// 描画上この値はもう使われない（scene.fogは「フォグを有効にするスイッチ」と
// 密度の入れ物としてだけ残っている）。公開APIなので式はそのまま残す。
// 遠景が空に溶けるには、フォグ色が地平の空と同じ放射輝度でなければならない。
// 寒色のフォグと暖色の地平がぶつかると、遠景の輪郭がいつまでも残る。
// createSkyの地平付近の式（ヘイズ混合→ゲイン）をそのまま辿って引く。
export function skyFogColor() {
  const c = new THREE.Color(SKY_HORIZON);
  // ヘイズ層は太陽方位側が暖色、逆側が寒色に振れる。その中間を代表値にする。
  // わずかに寒色へ倒してあるのは空気遠近のため。日向の面（暖色）と遠景（寒色）が
  // 色相でも離れると、明度差が小さい距離帯でも前後が読める
  c.multiply(new THREE.Color().setRGB(0.95, 0.965, 1.02));
  c.multiplyScalar(SKY_GAIN);
  return c;
}

export function createSky(sunDirection) {
  const geo = new THREE.SphereGeometry(1, 48, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uSun: { value: sunDirection.clone().normalize() },
      uZenith: { value: new THREE.Color(SKY_ZENITH) },
      uHorizon: { value: new THREE.Color(SKY_HORIZON) },
      uGround: { value: new THREE.Color(SKY_GROUND) },
      uGain: { value: SKY_GAIN },
    },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */`
      varying vec3 vDir;
      uniform vec3 uSun, uZenith, uHorizon, uGround;
      uniform float uGain;

      float h21(vec2 p) {
        p = fract(p * vec2(127.31, 311.7));
        p += dot(p, p + 34.23);
        return fract(p.x * p.y);
      }
      float vn(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = h21(i), b = h21(i + vec2(1.0, 0.0));
        float c = h21(i + vec2(0.0, 1.0)), d = h21(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      // オクターブごとに回転を掛ける。掛けないと雲が縦横の格子に並ぶ
      float fbm5(vec2 p) {
        float s = 0.0, a = 0.5;
        mat2 rot = mat2(0.80, 0.60, -0.60, 0.80);
        for (int i = 0; i < 5; i++) { s += a * vn(p); p = rot * p * 2.02; a *= 0.5; }
        return s;
      }

      void main() {
        vec3 d = normalize(vDir);
        vec3 sunDir = normalize(uSun);
        float h = d.y;
        float sunAmt = max(dot(d, sunDir), 0.0);
        vec2 dh = normalize(d.xz + vec2(1e-5));
        float az = dot(dh, normalize(uSun.xz));

        // 大気の勾配。指数を寝かせて地平近くの層を厚くする
        float t = pow(clamp(h, 0.0, 1.0), 0.42);
        vec3 sky = mix(uHorizon, uZenith, t);

        // 前方散乱。太陽側の空全体がうっすら明るくなる。
        // 実測で太陽側(239,236,231)と反対側(223,214,194)の差が16しかなく、
        // 前方散乱がほぼ効いていなかった。色をはっきり暖色に振って量も上げる
        sky += vec3(1.00, 0.70, 0.44) * pow(sunAmt, 2.0) * 0.17 * (1.0 - t * 0.55);

        // 地平のヘイズ層。太陽の方位側は暖色、反対側は寒色に振る
        vec3 hazeCol = mix(uHorizon * vec3(0.84, 0.90, 1.04),
                           uHorizon * vec3(1.12, 1.03, 0.88),
                           clamp(az * 0.5 + 0.5, 0.0, 1.0));
        // ヘイズ層は地平すれすれに限定する。減衰8.5・混合0.78では、
        // 目線の高さの視界（h≈0〜0.3）が丸ごと暖色のヘイズで塗り潰されて、
        // 天頂の青が画面に1ピクセルも入らなくなる
        float haze = exp(-max(h, 0.0) * 13.0);
        sky = mix(sky, hazeCol, haze * 0.55);

        // 太陽。雲より先に足しておくと雲が太陽を隠してくれる。
        // 芯の色をほぼ白(1.0,0.88,0.66)で置くと、ブルームに渡る頃には
        // R-Bの差が7しか無い「ただの白飛び」になって夕日に見えない。
        // 芯・グレア・ハローの3層とも彩度を上げ、そのぶん強度は下げる。
        // ACESの肩に乗ってもB成分が先に頭打ちになるので橙が残る
        sky += vec3(1.0, 0.70, 0.40) * pow(sunAmt, 1400.0) * 13.0;
        sky += vec3(1.0, 0.66, 0.36) * pow(sunAmt, 22.0) * 0.60;
        sky += vec3(1.0, 0.74, 0.46) * pow(sunAmt, 4.0) * 0.16;

        // 積雲。雲底の平面に投影するので、地平に近いほど自然に引き伸ばされる。
        // 分母を小さくしすぎると地平付近で座標が発散し、ハッシュの精度が落ちて縞が出る
        vec2 cp = d.xz / (max(h, 0.0) + 0.12) * 1.15;
        vec2 warp = vec2(fbm5(cp * 0.55), fbm5(cp * 0.55 + 7.3));
        float n = fbm5(cp * 1.05 + warp * 1.3);
        // 雲量。0.55〜0.85は厳しすぎて空にほとんど形が出ず、画面上部20%が
        // 構図的に完全な余白になっていた。閾値を広げて雲を出す。
        // 白い面で青を覆う心配は、下の雲底の陰影(cov連動)で受ける
        float cov = smoothstep(0.42, 0.78, n);
        // 巻雲は別の層。高い所だけ、横に伸ばす
        float cir = smoothstep(0.56, 0.88, fbm5(cp * vec2(0.22, 0.85) + 19.0))
                  * smoothstep(0.04, 0.45, h) * 0.20;
        float dens = clamp(cov + cir, 0.0, 1.0);
        dens *= smoothstep(0.0, 0.13, h);           // 地平の特異点を隠す

        // 雲の明部。下地の空はSKY_GAIN(1.5)と前方散乱で太陽側がリニア1.2〜1.5まで
        // 持ち上がるので、雲の上限が1.22だと下地より暗くなり、mixしても何も出ない。
        // 実測で空100pxを縦走査して5階調しか動かず、雲が1片も見えていなかった。
        // 下地の上限を確実に超えるところまで持ち上げる
        vec3 lit = mix(vec3(1.55, 1.52, 1.47), vec3(2.10, 1.86, 1.55), sunAmt);
        vec3 shade = vec3(0.62, 0.66, 0.78);   // 雲底も同じだけ持ち上げないと、明部だけ浮いて紙細工になる
        vec3 cloud = mix(shade, lit, smoothstep(0.44, 0.94, n));
        // 雲底の陰。厚い所ほど下面に光が届かない。この上下の非対称が無いと
        // 雲が「白い紙を切り抜いた形」になって、空にシルエットが立たない
        cloud *= 1.0 - cov * 0.4;
        // 縁の銀色。厚みの薄い縁(cov小)にだけ集めると、太陽側の輪郭が抜ける
        cloud += vec3(1.0, 0.80, 0.52) * pow(sunAmt, 7.0) * (1.0 - cov) * 0.9;
        // GLSLのsmoothstepはedge0>edge1が仕様上未定義なので、必ず1.0-で反転させる
        cloud = mix(cloud, hazeCol * 1.05, (1.0 - smoothstep(0.04, 0.55, h)) * 0.7);  // 遠景はヘイズに溶ける
        sky = mix(sky, cloud, dens * 0.88);

        // 地面側。地平のすぐ下はヘイズ、下に行くほど土の色
        vec3 gnd = mix(uHorizon * 0.70, uGround, 1.0 - smoothstep(-0.26, 0.0, h));
        sky = mix(sky, gnd, 1.0 - smoothstep(-0.030, 0.012, h));

        // ゲインは色ごとではなく最終出力に掛ける。環境光のPMREMもこの関数から
        // 焼いているので、空だけでなく照り返しごと正しい強さに上がる
        gl_FragColor = vec4(sky * uGain, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1000;
  return mesh;
}

/* ----------------------------------------------------------------- API */

export function buildMaterials(renderer) {
  // 420m角の地面に4m角のタイルを貼るので、視線が寝た所では8では足りず
  // ミップが崩れてクロスハッチのモアレが出る。上限まで使う
  const aniso = renderer.capabilities.getMaxAnisotropy();
  const S = 512;

  const mk = (fn, seed, strength, repeat, opts) => {
    const baked = bake(S, seed, fn, strength, aniso);
    if (repeat) {
      baked.map.repeat.set(repeat, repeat);
      baked.normalMap.repeat.set(repeat, repeat);
      baked.armMap.repeat.set(repeat, repeat);
    }
    return materialFrom(baked, opts);
  };

  // 面の設定。単位はワールド基準にしてある（UV基準だと、同じ材質でも
  // 貼る面のtexScaleでムラの大きさが変わってしまう）。
  //   macroScale : 汚れのムラの周期(1/m)。0.26なら約4m周期
  //   macroAmt   : 打設ロットのムラ量（上向き面と垂直面で符号が反転する）
  //   macroRun   : 垂直面に落とす雨だれの量
  //   macroRough : ムラの粗さへの連動
  //   detail     : [近接で重ねる法線のUV倍率, 強さ, 効かせる距離(m)]
  //   fade       : [法線を落とし始める距離, 落としきる距離, 遠景に残す割合]
  //   warp       : 頂点側のUVゆらぎ。タイルの升目そのものを読めなくする
  const ground = {
    macroScale: 0.26, macroAmt: 0.15, macroRun: 0.10, macroRough: 0.09,
    detail: [11.0, 0.55, 7.0], fade: [9.0, 38.0, 0.30], warp: 0.14,
  };
  const wall = {
    macroScale: 0.34, macroAmt: 0.12, macroRun: 0.42, macroRough: 0.10,
    detail: [9.0, 0.50, 6.0], fade: [13.0, 55.0, 0.45], warp: 0.0,
  };
  const prop = {
    macroScale: 0.55, macroAmt: 0.10, macroRun: 0.26, macroRough: 0.08,
    detail: [7.0, 0.40, 4.5], fade: [10.0, 40.0, 0.50], warp: 0.0,
  };

  return {
    // 床にも掩体の壁にも使う材質なので、雨だれは壁側の値に寄せておく
    // （垂直面にしか出ないので、床に貼っても何も乗らない）
    concrete: mk(concrete, 11, 2.2, 1, { normalScale: 1.0, surf: { ...ground, macroRun: 0.36 } }),
    // 建物側のコンクリ。colorはmapに対する乗算係数なので、見た目が白っぽい
    // 値でも実際は「わずかに暗い」になる。床のコンクリ(平均0.35)に対して
    // 0.55倍あたりが上限で、これ以上落とすと建物が黒い塊に潰れて
    // 明度のハシゴが「床」と「それ以外」の2段しか無くなる。
    // 少し寒色に振ってあるのは、暖色のヘイズに沈む床と色相でも離すため
    concreteDark: mk(concrete, 27, 2.2, 1, {
      normalScale: 1.0, color: 0xc2c4c8, surf: { ...wall, macroRun: 0.42, warp: 0.08 },
    }),
    // 地面は視線が浅く入るぶんエイリアスが出やすい。骨材の粒を高さ場側で
    // 削ったので、法線の倍率もそれに合わせて落とす（0.92だと粒が
    // 距離に関係なく主張して、中距離がニット生地の編み目に見える）
    asphalt: mk(asphalt, 5, 2.6, 1, {
      normalScale: 0.60, surf: { ...ground, warp: 0.16, detail: [13.0, 0.45, 6.0] },
    }),
    metal: mk(metalPanel, 3, 2.8, 1, { normalScale: 1.0, surf: wall }),
    metalRed: mk(metalPanel, 19, 2.8, 1, { normalScale: 1.0, color: 0xa8524a, surf: wall }),
    wood: mk(woodCrate, 7, 1.8, 1, { normalScale: 0.9, surf: prop }),
    sandbag: mk(sandbag, 13, 1.5, 1, { normalScale: 1.2, surf: prop }),
    brick: mk(brick, 23, 2.4, 1, { normalScale: 1.1, surf: wall }),
    // 錆は発生源から下へ垂れる絵をテクスチャ側で作ったので、
    // シェーダー側の雨だれは重ねない
    rustMetal: mk(rustMetal, 31, 2.4, 1, { normalScale: 1.05, surf: { ...prop, macroRun: 0.10 } }),
    plaster: mk(plaster, 37, 2.2, 1, { normalScale: 1.05, surf: wall }),
    dirt: mk(dirt, 41, 2.4, 1, { normalScale: 1.2, surf: { ...ground, macroRun: 0.0 } }),
    corrugated: mk(corrugated, 43, 2.6, 1, { normalScale: 1.0, surf: wall }),
  };
}
