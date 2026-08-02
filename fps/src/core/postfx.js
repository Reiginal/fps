// 画面の最終仕上げ。素のレンダリングのままだと「ゲームエンジンの出力」に見えるので、
//   世界 → AO(接地の陰り) → AO合成 → ブルーム → 武器 → 太陽のグレア → トーンマップ/グレード
//   → FXAA → 輝点つぶし+シャープ+粒子+ディザ
// の順に通して映画寄りの絵にする。
// ブルームが武器より前にあるのは、武器を重ねた後に掛けるとマズルフラッシュの滲みが
// そのまま銃の画素へ足されて、撃つたびに銃が洗われるため(理由と実測は下のブルームの節)。
// トーンマップは自前で持つ(OutputPassを外した)。ACESを掛けてから表示空間で色を触りたいので、
// 最後に色空間変換まで面倒を見るパスが必要になる。
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// AOの解像度。半分(0.5)まで落とすと、拾いたい5〜20cmの接地の遮蔽が
// デプスバッファの1〜2画素に潰れて消える。0.75なら5cmの段差が1280幅で5〜6画素残るので、
// 瓦礫や土嚢の足元の落ち込みがようやく画に出る。画素数は1/4→約1/1.8に増える
const AO_SCALE = 0.75;
const aoDim = (w, h) => [
  Math.max(2, Math.round(w * AO_SCALE)),
  Math.max(2, Math.round(h * AO_SCALE)),
];

// 太陽のグレア(異方性ストリーク＋ゴッドレイ)を作る作業バッファの解像度。
// にじみは元々低周波なので1/4で足りるし、ここが一番タップ数を食うので落としておく
const GLARE_SCALE = 0.25;
const glareDim = (w, h) => [
  Math.max(4, Math.round(w * GLARE_SCALE)),
  Math.max(4, Math.round(h * GLARE_SCALE)),
];

// 毎フレームのVector3生成を避けるためのスクラッチ
const _sunWorld = new THREE.Vector3();
const _tgtWorld = new THREE.Vector3();
const _sunView = new THREE.Vector3();
const _camFwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _proj = new THREE.Vector3();
const _clearCol = new THREE.Color();

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// 太陽はmain.jsのDirectionalLightを唯一の情報源にする。postfx側に方向を持たせると
// main.jsのSUN_DIRと二重管理になって、片方だけ直した時に光条や接触影が変な向きに出る
function findSun(scene) {
  const list = scene.children;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (o.isDirectionalLight && o.castShadow) return o;
  }
  return null;
}

/* ------------------------------------------------------------ AOの合成 */

// GTAOPassの標準の合成(OUTPUT.Default)はハードウェアブレンドの単純な乗算なので、
// 元の色を読めない＝どこが直射日光でどこが日陰かを区別できない。
// AOは本来「まわりから回り込んでくる光(間接光)がどれだけ遮られたか」の量なので、
// 太陽が直接当たっている面にまで同じだけ掛けると、日向が理由もなく煤けて汚れる。
// そこで自前の合成パスに置き換えて、明るい面ほどAOの効きを落とす。
// 明るい＝直射が当たっている、暗い＝環境光しか来ていない、の近似で十分機能する。
// これで日向を汚さずにAO本体の強度を上げられるようになる
const AoComposeShader = {
  uniforms: {
    // 世界の絵はMSAAのrtWorldから直に読む。ここをtDiffuseという名前にしておくと、
    // ShaderPassが毎フレームreadBuffer(＝合成器のping-pongの板)のテクスチャを
    // 上書きで差し込んでしまい、解決済みの絵ではなく空の板を読むことになる。
    // 差し込みの対象にならない名前にして、こちらで固定する
    tWorld: { value: null },
    tAo: { value: null },
    tDepth: { value: null },
    tNormal: { value: null },
    uAoTexel: { value: new THREE.Vector2(1 / 960, 1 / 540) },
    uIntensity: { value: 0.62 },
    // 直射が当たっている面にどれだけAOを残すか。0.55まで絞ると
    // 日向に置いた物の接地の陰りまで丸ごと消えて、床に貼り付いたように浮いた。
    // 消したいのは「日向の広く薄い汚れ」だけなので残存率は高く取り、
    // 弱める対象は下のcontact(遮蔽の空間周波数)で選り分ける
    uDirectKeep: { value: 0.84 },
    // 「直射が当たっている」と見なす輝度の範囲。
    // ここはトーンマップ前のリニアHDR値で測る。表示された画素値とは桁が違うので注意。
    // renderer.toneMappingはACESに設定してあるが、レンダーターゲットへ描く時は
    // three側がトーンマップを外す(WebGLPrograms: currentRenderTarget!==nullならNoToneMapping)ので、
    // このバッファに入っているのは素のリニア輝度。
    // 画面の実測値から逆算すると 日陰アスファルト0.022 / 日向アスファルト0.081 /
    // 日向コンクリ0.23 / 明るい壁0.39 / 空1.22。
    // 以前ここに0.22〜0.78を置いていたが、それでは空以外の全部がdirect≈0になり、
    // 「日向でAOを弱める」も下の接触影も丸ごと動いていなかった(接地が出なかった直接の原因)。
    // 日向のアスファルトはAOを弱めたくないので立ち上がりは0.09に置く。
    // 弱めたいのは日向のコンクリ壁のような明るい面だけ
    uLumaLo: { value: 0.09 },
    uLumaHi: { value: 0.34 },
    // 接触影を出すかどうかの判定はもっと下で切る。落ち影が一番効くのは足元の
    // 暗いアスファルトで、そこはリニア0.08しかない。上のdirectを流用すると
    // 「一番影が要る所ほど影が出ない」形になる。日陰(0.022)だけ確実に外せればいい
    uSunLo: { value: 0.035 },
    uSunHi: { value: 0.075 },
    // 接触線の判定。まわりのAOを見に行くタップ幅(AOバッファのテクセル数)と、
    // 「まわりより暗い」量をどれだけ増幅して接触とみなすか。
    // 幅を2本持つのは、床と兵士のブーツのような細い接触線と、
    // ドラム缶と床のような太い接触線が同じ画面幅では出てこないため
    uNarrow: { value: 2.5 },
    uWide: { value: 7.0 },
    uContactGain: { value: 6.5 },
    // 遮蔽そのものの深さで接触とみなす範囲。溝の底・物の足元はここに入る
    uDeepLo: { value: 0.45 },
    uDeepHi: { value: 0.90 },
    // 接触線だけ追加で落とす量。GTAOの生の値は接触線でも0.7程度までしか落ちず、
    // そのままでは画に出ない。部屋の隅のような広い遮蔽には掛けない
    uContactBoost: { value: 0.6 },

    // ---- 接触影(スクリーン空間の短距離レイマーチ)
    // GTAOは「まわりからの回り込みが遮られた量」なので、太陽の向きを持たない＝
    // 落ち影の形が出ない。しかも影マップはカスケード無しの1枚で189m×2048pxなので
    // 1テクセル9cm、直径40cmのパイプや兵士の足元の影は焼かれる前に消えている。
    // そこで太陽へ向かって数十cmだけ画面空間でレイを飛ばし、
    // 「すぐ手前に物がある画素」を暗くして接地の落ち影を自前で作る
    uProj: { value: new THREE.Matrix4() },
    uProjInv: { value: new THREE.Matrix4() },
    uSunView: { value: new THREE.Vector3(0, 1, 0) },  // 視点空間での太陽への向き
    uSscs: { value: 0.7 },
    uSscsLen: { value: 0.45 },      // 何メートル先まで遮蔽を探すか(＝影の伸びる長さ)
    uSscsBias: { value: 0.012 },
    uSscsThick: { value: 0.6 },     // これ以上手前の面は「無関係な前景」として無視する
    uSscsFar: { value: 30.0 },      // ここまで来るとレイが1画素以下になるので消す
    uNear: { value: 0.1 },
    uFar: { value: 400.0 },
    // 直射を失った面に残るのは空からの回り込みだけ。今の空は夕方の暖色だが
    // 天頂側は青いので、落ち影は寒色に転ぶのが正しい
    uSscsTint: { value: new THREE.Color(0.33, 0.36, 0.45) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tWorld, tAo, tDepth, tNormal;
    uniform vec2 uAoTexel;
    uniform float uIntensity, uDirectKeep, uLumaLo, uLumaHi, uSunLo, uSunHi;
    uniform float uNarrow, uWide, uContactGain, uDeepLo, uDeepHi, uContactBoost;
    uniform mat4 uProj, uProjInv;
    uniform vec3 uSunView, uSscsTint;
    uniform float uSscs, uSscsLen, uSscsBias, uSscsThick, uSscsFar, uNear, uFar;
    varying vec2 vUv;

    // 深度バッファ(非線形)から視点空間の座標に戻す
    vec3 viewPosOf(vec2 uv, float d) {
      vec4 c = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
      return c.xyz / c.w;
    }

    // 奥行きだけが要る所ではこちらを使う。行列を1本掛けるより桁違いに軽く、
    // ループの中で12回呼ぶので効いてくる
    float viewZOf(float d) {
      return (uNear * uFar) / ((uFar - uNear) * d - uFar);
    }

    // インターリーブド・グラディエント・ノイズ。レイの開始位置をずらすのに使う。
    // 時間で動かさないのは、動かすと12ステップぶんのばらつきがフレームごとに変わって
    // 接地影がザワザワ沸くため。固定なら細かいディザとして目に馴染む
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    // 十字4点の平均。AOバッファを何テクセル離して見るかで拾える遮蔽の幅が変わる
    float aoAvg(float w) {
      return 0.25 * (
          texture2D(tAo, vUv + vec2(uAoTexel.x * w, 0.0)).r
        + texture2D(tAo, vUv - vec2(uAoTexel.x * w, 0.0)).r
        + texture2D(tAo, vUv + vec2(0.0, uAoTexel.y * w)).r
        + texture2D(tAo, vUv - vec2(0.0, uAoTexel.y * w)).r);
    }

    void main() {
      vec3 col = texture2D(tWorld, vUv).rgb;
      float ao = texture2D(tAo, vUv).r;

      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float direct = smoothstep(uLumaLo, uLumaHi, lum);
      // 接触影用の判定は別に持つ。理由はuniform側のコメントのとおり
      float sunlit = smoothstep(uSunLo, uSunHi, lum);

      // AOで消したいのは「日向の平らな壁に広く薄く乗る汚れ」であって、
      // 物と床の接触線ではない。両者は遮蔽の空間周波数と深さで分けられる。
      // (1) まわりの平均より飛び抜けて暗い＝数十cm以内の近い遮蔽＝接触線。
      //     細い接触線(兵士のブーツ)と太い接触線(ドラム缶)を両方拾うため幅を2本見る
      float local = clamp(
        max(aoAvg(uNarrow) - ao, aoAvg(uWide) - ao) * uContactGain, 0.0, 1.0);
      // (2) 遮蔽が単純に深い所。溝の底や足元は薄い汚れと違って一気に落ちる
      float deep = 1.0 - smoothstep(uDeepLo, uDeepHi, ao);
      float contact = max(local, deep);

      // 接触と判定した所は日向でも丸ごと残す。日向で弱めるのは薄く広い遮蔽だけ
      float keep = mix(uDirectKeep, 1.0, contact);
      float amt = clamp(uIntensity * mix(1.0, keep, direct), 0.0, 1.0);

      // GTAOの生の値をそのまま掛けると、溝の底でも0.7程度にしか落ちず画で見えない。
      // 1より大きい指数でカーブを立てて、遮蔽が深い所ほど強く落とす。
      // さらに指数を色ごとにずらす。遮蔽で減るのは空から回り込む光で、今の空は
      // 夕方の暖色なので、遮られた所は相対的に寒色へ転ぶのが正しい。
      // 「AOで暗くなるほど青が残る」形になり、セピア一色の画に寒色が1点入る
      vec3 aoc = pow(vec3(clamp(ao, 0.0, 1.0)), vec3(1.50, 1.36, 1.18));
      vec3 f = mix(vec3(1.0), aoc, amt);

      // 接触線だけ追い込む。deep(部屋の隅のような広く深い遮蔽)には掛けない。
      // 隅まで増し掛けすると、ただでさえ暗い日陰の隅が黒い塗り潰しになる。
      // 上限を切ってあるので、どれだけ重なっても半分より暗くはならない
      float extra = clamp(uContactBoost * local * (1.0 - ao) * 2.0, 0.0, 0.5);
      col *= max(f * (1.0 - extra), vec3(0.05));

      /* ---- 接触影。太陽へ向かって数十cmだけレイを飛ばす ---- */

      float d = texture2D(tDepth, vUv).x;
      // 空(d==1)はレイを飛ばす意味がない。日陰(sunlit≈0)も既に影なので触らない
      if (uSscs > 0.001 && d < 0.9999 && sunlit > 0.02) {
        vec3 P = viewPosOf(vUv, d);
        float dist = -P.z;
        // 遠くなるほどレイの長さが画面上で1画素を切ってノイズにしかならない。
        // その距離では影マップ側の解像度で足りているので消す
        float fade = 1.0 - smoothstep(uSscsFar * 0.6, uSscsFar, dist);
        // 太陽に背を向けた面は元から影。ここでレイを出すと自分自身に当たって
        // 面全体がまだらに黒ずむ(セルフオクルージョンのアクネ)
        vec3 N = normalize(texture2D(tNormal, vUv).xyz * 2.0 - 1.0);
        float ndl = dot(N, uSunView);
        if (fade > 0.01 && ndl > 0.03) {
          float stepLen = uSscsLen / 12.0;
          // 開始点を法線方向へ少し浮かせる。距離に比例させるのは、
          // 遠いほど深度バッファの1段が粗くなるため
          vec3 pos = P + N * (0.008 + dist * 0.0025)
                       + uSunView * (stepLen * (0.5 + ign(gl_FragCoord.xy)));
          float bias = uSscsBias + dist * 0.004;
          float hit = 0.0;
          for (int i = 0; i < 12; i++) {
            pos += uSunView * stepLen;
            vec4 cp = uProj * vec4(pos, 1.0);
            vec2 suv = cp.xy / cp.w * 0.5 + 0.5;
            float inside = step(0.0, suv.x) * step(suv.x, 1.0)
                         * step(0.0, suv.y) * step(suv.y, 1.0);
            float sz = viewZOf(texture2D(tDepth, suv).x);
            // 正＝レイより手前に面がある＝太陽が遮られている。
            // ただし厚みを超えて手前なら、それは影を落とす物ではなく別の前景
            float diff = sz - pos.z;
            float occ = step(bias, diff) * (1.0 - step(uSscsThick, diff)) * inside;
            // 手前のステップで当たったものほど接触線に近いので重く数える。
            // これで足元から遠ざかるにつれ影が薄くなる階調が出る
            hit += occ * (1.0 - float(i) / 12.0 * 0.55);
          }
          // 太陽に正対しているほど濃く落とす。斜めに掠めている面まで同じ濃さにすると
          // 影の縁が面の傾きを無視してべったり付く
          float sscs = clamp(hit / 6.0, 0.0, 1.0) * fade * sunlit
                     * smoothstep(0.03, 0.30, ndl) * uSscs;
          col *= mix(vec3(1.0), uSscsTint, sscs);
        }
      }

      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

/* ------------------------------------------------------ 太陽のグレア */

// 「太陽が白い水たまり」問題への対処。ブルームの丸いにじみを広げても、
// 光源の形が出ないうえに鉄塔の梁のような細いシルエットを食って断線させるだけなので、
// ブルーム自体は半径を切り詰め、減った輝きを別の形で稼ぐ。
//  (1) 異方性ストリーク: 横一直線の光条。レンズの癖として読まれるので、
//      丸くにじむのと違って輪郭を溶かさない
//  (2) ゴッドレイ: 太陽のスクリーン座標を中心にした放射ブラー。
//      手前の物のシルエットがそのまま光の筋の切れ目になるので、
//      「太陽の手前に鉄塔がある」という位置関係が画に出る
const glareVert = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// 明るい所だけ抜く。4タップの箱で縮小してから閾値を取る。1タップで縮小すると
// 細い輝線がフレームごとに拾えたり拾えなかったりして、光条が点滅する
const glareThreshFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uThreshold;
  varying vec2 vUv;
  void main() {
    vec3 s = (
        texture2D(tDiffuse, vUv + vec2( 0.5,  0.5) * uTexel).rgb
      + texture2D(tDiffuse, vUv + vec2(-0.5,  0.5) * uTexel).rgb
      + texture2D(tDiffuse, vUv + vec2( 0.5, -0.5) * uTexel).rgb
      + texture2D(tDiffuse, vUv + vec2(-0.5, -0.5) * uTexel).rgb
    ) * 0.25;
    float l = dot(s, vec3(0.2126, 0.7152, 0.0722));
    // 閾値ぶんを引くのではなく比で落とす。引き算だと閾値付近の色相が転ぶ
    float k = max(l - uThreshold, 0.0) / max(l, 0.0001);
    gl_FragColor = vec4(s * k, 1.0);
  }
`;

// 1次元のぼかし。歩幅(uStride)を変えて3回通すと、7タップ×3回で
// 実効±87テクセル(＝1280幅で±350px)の長い尾が引ける。
// 1回で長い尾を出そうとするとタップの間が空いて縞になるので、
// 歩幅は前段のぼけ幅を超えないように増やしていく
const glareBlurFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform vec2 uDir;
  uniform float uStride;
  varying vec2 vUv;
  void main() {
    vec2 step0 = uDir * uTexel * uStride;
    vec3 sum = texture2D(tDiffuse, vUv).rgb;
    float wsum = 1.0;
    for (int i = 1; i <= 3; i++) {
      float fi = float(i);
      float w = exp(-fi * fi * 0.36);
      sum += texture2D(tDiffuse, vUv + step0 * fi).rgb * w;
      sum += texture2D(tDiffuse, vUv - step0 * fi).rgb * w;
      wsum += w * 2.0;
    }
    gl_FragColor = vec4(sum / wsum, 1.0);
  }
`;

// 太陽へ向かう放射ブラー。太陽が画面外や背後の時は呼ばれない
const glareRayFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uSunUv;
  uniform float uDensity, uDecay;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  void main() {
    vec2 delta = (uSunUv - vUv) * uDensity / 24.0;
    // タップ位置を画素ごとにずらす。揃えると太陽を中心にした同心円の縞が出る
    vec2 uv = vUv + delta * hash(vUv * 613.0);
    vec3 sum = vec3(0.0);
    float w = 1.0;
    float wsum = 0.0;
    for (int i = 0; i < 24; i++) {
      uv += delta;
      // 画面の外まで舐めるとClampToEdgeで端の1列が引き伸ばされて縦縞になる。
      // 外に出たタップは重みごと捨てる
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      sum += texture2D(tDiffuse, uv).rgb * (w * inside);
      wsum += w;
      w *= uDecay;
    }
    gl_FragColor = vec4(sum / max(wsum, 0.0001), 1.0);
  }
`;

const glareCompFrag = /* glsl */`
  uniform sampler2D tDiffuse, tStreak, tRay;
  uniform vec3 uStreakColor, uRayColor;
  uniform float uStreak, uRay;
  varying vec2 vUv;
  void main() {
    vec3 col = texture2D(tDiffuse, vUv).rgb;
    col += texture2D(tStreak, vUv).rgb * uStreakColor * uStreak;
    col += texture2D(tRay, vUv).rgb * uRayColor * uRay;
    gl_FragColor = vec4(col, 1.0);
  }
`;

class SunGlarePass extends Pass {
  constructor(scene, camera, width, height) {
    super();
    this.scene = scene;
    this.camera = camera;
    this._sun = null;

    const [w, h] = glareDim(width, height);
    const opt = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.rtBright = new THREE.WebGLRenderTarget(w, h, opt);
    this.rtA = new THREE.WebGLRenderTarget(w, h, opt);
    this.rtB = new THREE.WebGLRenderTarget(w, h, opt);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({
      uniforms, vertexShader: glareVert, fragmentShader: frag,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });

    this.mThresh = mk(glareThreshFrag, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      // 空はヘイズ込みでもリニア0.7前後までしか行かない。2.0に置けば
      // 太陽ディスク・マズルフラッシュ・曳光弾＝自分で光っている物だけが残る
      uThreshold: { value: 2.0 },
    });
    this.mBlur = mk(glareBlurFrag, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uStride: { value: 2 },
    });
    this.mRay = mk(glareRayFrag, {
      tDiffuse: { value: null },
      uSunUv: { value: new THREE.Vector2(0.5, 0.5) },
      // 各画素から太陽までの距離の何割を舐めるか。ここが小さいとタップが太陽本体まで
      // 届かず、光源のすぐ周りにしか筋が出ない。1.0にすると画面全体が霧のカーテンになる
      uDensity: { value: 0.85 },
      uDecay: { value: 0.95 },
    });
    this.mComp = mk(glareCompFrag, {
      tDiffuse: { value: null },
      tStreak: { value: this.rtB.texture },
      tRay: { value: this.rtA.texture },
      // アナモルフィックの光条は青に転ぶのがレンズの癖。
      // 画面がセピア一色なので、ここが数少ない寒色の差し色にもなる
      uStreakColor: { value: new THREE.Color(0.52, 0.72, 1.0) },
      uRayColor: { value: new THREE.Color(1.0, 0.84, 0.62) },
      uStreak: { value: 0.20 },
      uRay: { value: 0.0 },   // 太陽の見え方に応じて毎フレーム入れる
    });
    this.rayStrength = 0.42;

    this._quad = new FullScreenQuad(null);
  }

  // 太陽のスクリーン座標と「どれだけ視界に入っているか」を出す。
  // 背後にある時にゴッドレイを出すと、画面のどこにも光源が無いのに筋だけ走る
  _syncSun() {
    if (!this._sun) this._sun = findSun(this.scene);
    const sun = this._sun;
    if (!sun) return 0;

    sun.getWorldPosition(_sunWorld);
    sun.target.getWorldPosition(_tgtWorld);
    _sunWorld.sub(_tgtWorld).normalize();

    this.camera.getWorldDirection(_camFwd);
    const facing = _camFwd.dot(_sunWorld);
    if (facing <= 0.02) return 0;

    // 太陽は無限遠なので、視点から太陽方向へ十分遠い1点を投影すれば向きが出る
    this.camera.getWorldPosition(_camPos);
    _proj.copy(_sunWorld).multiplyScalar(1000).add(_camPos).project(this.camera);
    this.mRay.uniforms.uSunUv.value.set(_proj.x * 0.5 + 0.5, _proj.y * 0.5 + 0.5);

    // 画角のすぐ外に太陽がある時も実レンズは光条を出すので、外へ出た所で急に消さない
    const edge = Math.max(Math.abs(_proj.x), Math.abs(_proj.y));
    return clamp01(1.0 - (edge - 0.9) / 0.7) * clamp01(facing / 0.22);
  }

  _blit(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    this._quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    const vis = this._syncSun();

    // 明るい所を抜く
    this.mThresh.uniforms.tDiffuse.value = readBuffer.texture;
    this._blit(renderer, this.mThresh, this.rtBright);

    // 横方向へ3段のぼかし。歩幅を2→7→20と広げて長い光条にする
    this.mBlur.uniforms.uDir.value.set(1, 0);
    this.mBlur.uniforms.tDiffuse.value = this.rtBright.texture;
    this.mBlur.uniforms.uStride.value = 2;
    this._blit(renderer, this.mBlur, this.rtB);

    this.mBlur.uniforms.tDiffuse.value = this.rtB.texture;
    this.mBlur.uniforms.uStride.value = 7;
    this._blit(renderer, this.mBlur, this.rtA);

    this.mBlur.uniforms.tDiffuse.value = this.rtA.texture;
    this.mBlur.uniforms.uStride.value = 20;
    this._blit(renderer, this.mBlur, this.rtB);   // 光条はrtBに確定

    // ゴッドレイ。太陽が見えていない間はパスごと飛ばす
    if (vis > 0.002) {
      this.mRay.uniforms.tDiffuse.value = this.rtBright.texture;
      this._blit(renderer, this.mRay, this.rtA);
    }
    this.mComp.uniforms.uRay.value = vis * this.rayStrength;

    this.mComp.uniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this.mComp;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this._quad.render(renderer);
  }

  setSize(width, height) {
    const [w, h] = glareDim(width, height);
    this.rtBright.setSize(w, h);
    this.rtA.setSize(w, h);
    this.rtB.setSize(w, h);
    this.mThresh.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.mBlur.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  dispose() {
    this.rtBright.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.mThresh.dispose();
    this.mBlur.dispose();
    this.mRay.dispose();
    this.mComp.dispose();
    this._quad.dispose();
  }
}

/* ------------------------------------------ 武器レイヤーの合成(覗いた時のボケ) */

// 覗いている間、目のピントは数十m先の的に合っている。だから目から12〜15cmしかない
// 光学の筐体も、先台のレールの歯も、実際には大きくボケて見える。
// これまで武器は世界のバッファへ直接重ねていたので、武器だけをぼかす手が無かった。
// そこで武器を自前のRGBAバッファへ描いてから合成する形に変える。
//  - αごとぼかすので、筐体の輪郭そのものが柔らかく溶ける(硬い黒の切り口が消える)
//  - ぼけたαをそのまま使えば、開口の縁に接眼のケラレ(スコープシャドウ)も置ける
// ボケ量は深度ではなく「画面中心からの距離」で決める。深度基準にすると
// レティクルまでボケて狙点が読めなくなるし、開口の向こうの的まで巻き込む
const viewBlurFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform vec2 uDir;
  uniform float uStride;
  varying vec2 vUv;
  void main() {
    // 事前乗算済みのRGBAをまとめて重み付け平均する。RGBとαを別扱いにすると
    // 縁で色だけが先に薄まって、輪郭に黒い芯が残る。
    // 歩幅(uStride)を段で広げるのは、1回で広いボケを出そうとすると
    // タップの間が空いて縞になるため
    vec2 s = uDir * uTexel * uStride;
    vec4 sum = texture2D(tDiffuse, vUv) * 0.227027;
    sum += (texture2D(tDiffuse, vUv + s * 1.384615)
          + texture2D(tDiffuse, vUv - s * 1.384615)) * 0.316216;
    sum += (texture2D(tDiffuse, vUv + s * 3.230769)
          + texture2D(tDiffuse, vUv - s * 3.230769)) * 0.070270;
    gl_FragColor = sum;
  }
`;

// レティクルのグローを作る抜き出し。UnrealBloomPassは世界だけに掛かるので武器には届かず、
// 仮に届かせても閾値0.95に上がるのは太陽のような白く強い物だけ。ドットサイトの赤点は
// toneMapped:falseでもリニア値は最大1.0止まりなので、あのブルームには一生拾われず、
// 「板に描いた赤い丸」のまま終わる。かといって閾値を下げると銃の金属ハイライトまで
// にじんで銃全体が霞む。
// 分ける鍵は彩度。自分で光っているレティクルは純赤(彩度≈1)で、
// 金属のハイライトは白(彩度≈0)、マズルフラッシュは橙(彩度0.48)。彩度で窓を切れば赤点だけ拾える。
// 4タップの箱で縮小してから閾値を取るのは、1タップだと数px幅のドットが
// 縮小の格子とずれた時に拾えたり拾えなかったりして点滅するため
const viewGlowFrag = /* glsl */`
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  uniform float uThreshold, uSatLo, uSatHi, uMax;
  varying vec2 vUv;
  void main() {
    vec3 c = (
        texture2D(tDiffuse, vUv + vec2( 0.5,  0.5) * uTexel).rgb
      + texture2D(tDiffuse, vUv + vec2(-0.5,  0.5) * uTexel).rgb
      + texture2D(tDiffuse, vUv + vec2( 0.5, -0.5) * uTexel).rgb
      + texture2D(tDiffuse, vUv + vec2(-0.5, -0.5) * uTexel).rgb
    ) * 0.25;
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float sat = (mx - mn) / max(mx, 0.0001);
    // 閾値ぶんを比で落とす。引き算だと閾値付近で色相が転ぶ
    float k = max(mx - uThreshold, 0.0) / max(mx, 0.0001);
    // 上限を切る。レティクルは加算の板が3枚(滲み・輪・芯)重なるので、芯の真ん中では
    // 倍率がそのまま積み上がる。上限が無いとそこだけ白く飛んで「赤い点」でなくなる
    gl_FragColor = vec4(min(c * k * smoothstep(uSatLo, uSatHi, sat), vec3(uMax)), 1.0);
  }
`;

const viewCompFrag = /* glsl */`
  uniform sampler2D tDiffuse, tView, tViewBlur, tViewGlow;
  uniform float uAds, uAspect, uRIn, uROut, uStrength, uScopeShadow, uPeriph;
  uniform float uGlow, uGlowAds;
  varying vec2 vUv;
  void main() {
    vec4 v = texture2D(tView, vUv);
    vec3 world = texture2D(tDiffuse, vUv).rgb;

    if (uAds > 0.002) {
      // 画素が正方に見える座標へ直す。UVのまま半径を測ると縦長の楕円になり、
      // 画面下のレールだけ先にボケて左右が残る。半画面高＝1.0のスケール
      vec2 c = (vUv - 0.5) * vec2(uAspect, 1.0) * 2.0;
      float k = uAds * uStrength * smoothstep(uRIn, uROut, length(c));
      vec4 b = texture2D(tViewBlur, vUv);
      v = mix(v, b, k);

      // 接眼のケラレ。ぼけたα＝筐体の縁から内側へにじんだ量なので、
      // 開口の縁のすぐ内側だけが暗くなる。開口の大きさを数値で持たなくて済む
      float rim = clamp(b.a, 0.0, 1.0) * uAds * uScopeShadow;
      // 目を接眼に寄せると視野の外周そのものが落ちる(アイリリーフのケラレ)。
      // 上のrimは筐体の縁の数十pxしか届かないので、画面の隅まで効く広い減光を別に足す。
      // これが無いと、覗いた瞬間に周辺が締まる感じが出ずADSの切り替わりが画に出ない
      rim = clamp(rim + uAds * uPeriph * smoothstep(0.55, 1.30, length(c)), 0.0, 1.0);
      world *= 1.0 - rim;
    }

    // 事前乗算のover合成。武器のバッファは透明な黒に対して描いてあるので、
    // 背景を(1-α)で落としてから足すのが正しい
    vec3 outc = world * (1.0 - clamp(v.a, 0.0, 1.0)) + v.rgb;

    // レティクルのグローは合成の後に足す。αで抜くと赤点の外側＝開口の向こうの景色に
    // にじみが出ず、光が空気中に漏れている感じにならない。
    // 覗いている間だけ強めるのは、実物のドットサイトも目を近づけるほど
    // 光点がフレアを引いて見えるため
    outc += texture2D(tViewGlow, vUv).rgb * (uGlow + uAds * uGlowAds);

    gl_FragColor = vec4(outc, 1.0);
  }
`;

class ViewCompositePass extends Pass {
  constructor(renderPass, width, height, samples) {
    super();
    this.renderPass = renderPass;   // 武器シーンを描くRenderPass(合成器の鎖には入れない)
    this.needsSwap = true;
    // 覗いている量。createComposer側でgrade.uniforms.uAdsとこのオブジェクトを共有する
    this.ads = { value: 0 };

    // 武器のバッファ。半透明のマズルフラッシュが乗るのでHDRのまま持つ。
    // MSAAを入れてあるのは、目のすぐ先にあるレールの歯やスコープの縁の段差が
    // FXAAだけでは均しきれないため。ただし効きは世界側ほど大きくない。ここのsamplesだけ
    // 0にして同じフレームを撮り比べると、動くのは銃まわりの14877画素だけで、
    // 中間の被覆率を持つ画素の割合は0.586→0.539としか変わらない(世界側は0.471→0.339)。
    // それでも残しているのは、銃だけは画面から一度も消えず、一番長く視線が乗る物だから
    this.rtView = new THREE.WebGLRenderTarget(width, height, {
      type: THREE.HalfFloatType,
      samples: samples || 0,
    });
    // ボケは元々低周波なので半解像度で足りる
    const bw = Math.max(2, width >> 1);
    const bh = Math.max(2, height >> 1);
    const opt = { type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false };
    this.rtA = new THREE.WebGLRenderTarget(bw, bh, opt);
    this.rtB = new THREE.WebGLRenderTarget(bw, bh, opt);
    // グローはさらに低周波なので1/4で足りる。ここを半解像度にすると
    // ADSしていない間も毎フレーム走る2枚のぼかしが4倍のfill costになる
    const gw = Math.max(2, width >> 2);
    const gh = Math.max(2, height >> 2);
    this.rtG1 = new THREE.WebGLRenderTarget(gw, gh, opt);
    this.rtG2 = new THREE.WebGLRenderTarget(gw, gh, opt);

    const mk = (frag, uniforms) => new THREE.ShaderMaterial({
      uniforms, vertexShader: glareVert, fragmentShader: frag,
      depthTest: false, depthWrite: false, blending: THREE.NoBlending,
    });

    this.mBlur = mk(viewBlurFrag, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / bw, 1 / bh) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uStride: { value: 1 },
    });
    this.mGlow = mk(viewGlowFrag, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / gw, 1 / gh) },
      // 赤点(リニアで最大1.0)は拾い、日陰の銃身(0.05前後)は拾わない高さ
      uThreshold: { value: 0.30 },
      // 白い金属ハイライト(彩度0)とマズルフラッシュを外すための彩度の窓。
      // フラッシュの色は(5.0,4.2,2.6)なので彩度は(5.0-2.6)/5.0＝0.48。
      // 以前ここに0.40〜0.78を置いていたが、それだと0.48は窓のど真ん中で、
      // 11%に減るだけで素通ししていた。コメントが避けたかった「発砲のたびに滲む」が
      // 明るさだけ頭打ちにした状態で起きていた。立ち上がりを0.48より上へ動かす。
      // レティクルは純赤(0xff2b1a等)でリニアの彩度0.99、1/4縮小の箱で銃身と混ざっても
      // 0.87は残るので0.70/0.85なら丸ごと通る。窓を上げる前後でグローの絵は
      // 1画素も変わらないことを実測で確認済み(レティクルまわり120x120画素の差 平均0.749/255・
      // 最大14.4/255が両方で完全一致)。ここを0.90付近まで上げると赤点まで削り始めるので上げない。
      //
      // ただし発砲時の銃をここから完全に外せるわけではない。ビューモデル側のマズルライトは
      // 0xffb060＝リニアで彩度0.886あり、それに照らされた金属はこの窓を素通りする。
      // 彩度では赤点(0.99)と分けられないので残す。ブルームを武器の前へ移した後で
      // 実測すると、この残りが銃の平均輝度に足しているのは0.0026(＝0.66/255)しかない
      uSatLo: { value: 0.70 },
      uSatHi: { value: 0.85 },
      uMax: { value: 1.2 },
    });
    // グロー用のぼかしは1/4解像度のテクセルで持つ。mBlurと共用にすると
    // ADSのボケ(1/2解像度)と歩幅が混ざって、どちらかの幅が倍か半分にずれる
    this.mGlowBlur = mk(viewBlurFrag, {
      tDiffuse: { value: null },
      uTexel: { value: new THREE.Vector2(1 / gw, 1 / gh) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uStride: { value: 1.6 },
    });
    this.mComp = mk(viewCompFrag, {
      tDiffuse: { value: null },
      tView: { value: this.rtView.texture },
      tViewBlur: { value: this.rtB.texture },
      tViewGlow: { value: this.rtG1.texture },
      // 腰だめでも赤点は光っているので常時少し乗せ、覗いた時にさらに足す
      uGlow: { value: 0.55 },
      uGlowAds: { value: 0.75 },
      uAds: this.ads,
      uAspect: { value: width / Math.max(1, height) },
      // 半画面高＝1.0のスケール。レティクルの輪が0.10、開口の縁が0.15、
      // 筐体の外縁が0.29、先台のレールが0.36〜1.0あたりに来る。
      // 0.13から立ち上げれば、レティクルは素通しのまま筐体の縁が半分ボケて、
      // レールはほぼ全ボケになる
      uRIn: { value: 0.13 },
      uROut: { value: 0.46 },
      uStrength: { value: 1.0 },
      uScopeShadow: { value: 0.62 },
      // 画面の隅で3割強落ちる程度。ここを強くすると照明ではなく黒い丸を
      // 重ねたように見えるので、gradeのビネットと足して破綻しない範囲に留める
      uPeriph: { value: 0.30 },
    });

    this._quad = new FullScreenQuad(null);
  }

  _blit(renderer, material, target) {
    this._quad.material = material;
    renderer.setRenderTarget(target);
    renderer.clear();
    this._quad.render(renderer);
  }

  render(renderer, writeBuffer, readBuffer) {
    // 武器を透明な黒の上に描く。RenderPassは第3引数(readBuffer)を描画先にする
    this.renderPass.render(renderer, null, this.rtView);

    // レティクルのグロー。1/4解像度の3枚で済むので常時走らせる
    this.mGlow.uniforms.tDiffuse.value = this.rtView.texture;
    this._blit(renderer, this.mGlow, this.rtG1);
    this.mGlowBlur.uniforms.tDiffuse.value = this.rtG1.texture;
    this.mGlowBlur.uniforms.uDir.value.set(1, 0);
    this._blit(renderer, this.mGlowBlur, this.rtG2);
    this.mGlowBlur.uniforms.tDiffuse.value = this.rtG2.texture;
    this.mGlowBlur.uniforms.uDir.value.set(0, 1);
    this._blit(renderer, this.mGlowBlur, this.rtG1);

    const ads = this.ads.value;
    if (ads > 0.002) {
      // 横→縦を2巡。1巡＝半解像度で実効±5px程度では「少し甘い」で止まり、
      // 覗いた感じが出ない。2巡目は歩幅を広げて実効±20px相当まで持っていく
      this.mBlur.uniforms.tDiffuse.value = this.rtView.texture;
      this.mBlur.uniforms.uDir.value.set(1, 0);
      this.mBlur.uniforms.uStride.value = 1;
      this._blit(renderer, this.mBlur, this.rtA);

      this.mBlur.uniforms.tDiffuse.value = this.rtA.texture;
      this.mBlur.uniforms.uDir.value.set(0, 1);
      this._blit(renderer, this.mBlur, this.rtB);

      this.mBlur.uniforms.tDiffuse.value = this.rtB.texture;
      this.mBlur.uniforms.uDir.value.set(1, 0);
      this.mBlur.uniforms.uStride.value = 2.4;
      this._blit(renderer, this.mBlur, this.rtA);

      this.mBlur.uniforms.tDiffuse.value = this.rtA.texture;
      this.mBlur.uniforms.uDir.value.set(0, 1);
      this._blit(renderer, this.mBlur, this.rtB);
    }

    this.mComp.uniforms.tDiffuse.value = readBuffer.texture;
    this._quad.material = this.mComp;
    if (this.renderToScreen) {
      renderer.setRenderTarget(null);
    } else {
      renderer.setRenderTarget(writeBuffer);
      if (this.clear) renderer.clear();
    }
    this._quad.render(renderer);
  }

  setSize(width, height) {
    this.rtView.setSize(width, height);
    const bw = Math.max(2, width >> 1);
    const bh = Math.max(2, height >> 1);
    this.rtA.setSize(bw, bh);
    this.rtB.setSize(bw, bh);
    this.mBlur.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    const gw = Math.max(2, width >> 2);
    const gh = Math.max(2, height >> 2);
    this.rtG1.setSize(gw, gh);
    this.rtG2.setSize(gw, gh);
    this.mGlow.uniforms.uTexel.value.set(1 / gw, 1 / gh);
    this.mGlowBlur.uniforms.uTexel.value.set(1 / gw, 1 / gh);
    this.mComp.uniforms.uAspect.value = width / Math.max(1, height);
  }

  dispose() {
    this.rtView.dispose();
    this.rtA.dispose();
    this.rtB.dispose();
    this.rtG1.dispose();
    this.rtG2.dispose();
    this.mBlur.dispose();
    this.mGlow.dispose();
    this.mGlowBlur.dispose();
    this.mComp.dispose();
    this._quad.dispose();
  }
}

/* ------------------------------------------------- 合焦距離(オートフォーカス) */

// クロスヘアの先にある物までの距離を1画素のバッファに溜める。
// ADSの被写界深度はこの距離を基準に「離れているほどボケる」を作るので、
// ここが毎フレーム飛び跳ねると画面全体のボケ量が丸ごと入れ替わって、
// 首を振るたびに背景がパカパカする。実際のレンズもピントの送りには時間が掛かるので、
// 前フレームの値へ寄せながら追わせる。
// 前の値を読むためのバッファをもう1枚持つ代わりに、ハードウェアのブレンドで混ぜる。
// 書き込み先をテクスチャとして読むわけではないので、1x1のping-pongを組まなくて済む
const focusFrag = /* glsl */`
  uniform sampler2D tDepth;
  uniform vec2 uTexel;
  uniform float uNear, uFar, uMin, uMax, uRate;
  varying vec2 vUv;

  // 深度バッファ(非線形)から視点空間のZへ。負の値が返る
  float viewZOf(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }

  void main() {
    // 中心1点だけを見ると、狙点に手すりや金網の線が1本掛かった瞬間に
    // 合焦距離がその1本へ吸われる。十字5点の一番手前を採れば
    // 「クロスヘアが乗っている物」に寄り、網目から抜けた背景には持っていかれない
    vec2 o = uTexel * 3.0;
    float d = texture2D(tDepth, vec2(0.5, 0.5)).x;
    d = min(d, texture2D(tDepth, vec2(0.5 + o.x, 0.5)).x);
    d = min(d, texture2D(tDepth, vec2(0.5 - o.x, 0.5)).x);
    d = min(d, texture2D(tDepth, vec2(0.5, 0.5 + o.y)).x);
    d = min(d, texture2D(tDepth, vec2(0.5, 0.5 - o.y)).x);
    // 空を狙うと最遠が返る。そのまま合焦距離にすると手前が全部溶けるので上限で止める。
    // ここより遠い的はどのみち被写界深度の中に収まり、送っても画が変わらない
    float z = clamp(-viewZOf(d), uMin, uMax);
    // 持つのは距離ではなく1/距離。ボケ量の式が1/距離の差で決まるうえ、
    // 距離のまま補間すると遠→近の送りだけ極端に遅くなる
    gl_FragColor = vec4(1.0 / z, 0.0, 0.0, uRate);
  }
`;

class FocusPass extends Pass {
  constructor(depthTexture, camera) {
    super();
    this.camera = camera;
    // 合成器の鎖には何も書かないので、readとwriteを入れ替えさせない
    this.needsSwap = false;
    this.rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDepth: { value: depthTexture },
        uTexel: { value: new THREE.Vector2(1 / 960, 1 / 540) },
        uNear: { value: 0.05 },
        uFar: { value: 900 },
        // 光学の最短合焦。これより手前へ送れるようにすると、壁に張り付いた瞬間に
        // 世界が丸ごと溶ける
        uMin: { value: 1.6 },
        // これより遠い的は被写界深度に収まるので、送る意味がない
        uMax: { value: 70.0 },
        uRate: { value: 1 },
      },
      vertexShader: glareVert,
      fragmentShader: focusFrag,
      depthTest: false,
      depthWrite: false,
      // 出力のαを混合比として使う。dst = 新しい値*uRate + 前の値*(1-uRate)
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.ZeroFactor,
    });
    this._quad = new FullScreenQuad(this.material);
    this._primed = false;
  }

  render(renderer, writeBuffer, readBuffer, deltaTime) {
    const u = this.material.uniforms;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    // 時定数0.13秒。速いと柱を横切るたびに背景のボケ量が暴れ、
    // 遅いと的に付けてから背景が締まるまで待たされる。
    // 1フレーム目は前の値が無いので丸ごと入れ替える
    const dt = Math.min(Math.max(deltaTime || 0, 0.001), 0.1);
    u.uRate.value = this._primed ? 1 - Math.exp(-dt / 0.13) : 1;
    this._primed = true;
    // 前フレームの値の上に混ぜるので、renderer.renderの自動クリアに消させない
    const prevAuto = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    this._quad.render(renderer);
    renderer.autoClear = prevAuto;
  }

  dispose() {
    this.rt.dispose();
    this.material.dispose();
    this._quad.dispose();
  }
}

/* ------------------------------------------------------------ グレード */

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uTime: { value: 0 },
    uDamage: { value: 0 },              // main.jsが毎フレーム書く
    uAds: { value: 0 },                 // main.jsが毎フレーム書く（覗いている量 0..1）
    uExposure: { value: 1.05 },         // renderer.toneMappingExposureから毎フレーム拾う
    // 色収差は「レンズの癖」として気づかれない程度でいい。強いと外周壁の上の
    // 有刺鉄線のような1px幅の線に青シアンの縁が付いて、線そのものが色の点線に見える
    uAberration: { value: 0.0003 },
    // ビネットは「言われないと気づかない」強さに留める。強いと照明ではなくフィルタとして読まれ、
    // 平らなコンクリ床が画面端に向かって理由なく暗くなる
    uVignette: { value: 0.26 },

    // 3wayカラコレ。影・中間・ハイライトを別々のオフセットで転がす。
    // 影を青、ハイライトを橙のはっきりした補色ペアにする。ここが弱いと
    // 空も地面も物も全部hue 20〜45度に収まって、画面から青が1画素も無くなり、
    // 明暗が色でも分かれないので立体が読めなくなる
    uShadow: { value: new THREE.Vector3(-0.030, -0.010, 0.055) },  // 影は寒色へ
    uMid: { value: new THREE.Vector3(0.010, 0.006, 0.000) },       // 中間はわずかに暖色へ
    uHigh: { value: new THREE.Vector3(0.022, 0.010, -0.016) },     // 夕方の陽なのでハイライトは暖色
    uContrast: { value: 0.17 },         // S字の掛かり具合
    uBlackLift: { value: 0.011 },       // 黒を少し浮かせる（影を締めても潰さない）
    uHiKnee: { value: 0.70 },
    uHiRoll: { value: 0.05 },           // ハイライトの肩。1.0に張り付かせない
    uSat: { value: 1.08 },

    // ADS中だけの浅い被写界深度(世界側)。
    // 以前は画面中心からの距離だけでボカしていたので、1.5m先の土嚢も30m先の壁も
    // 画面の同じ位置にあれば同じ量でボケていた。つまり被写界深度ではなく周辺ボカシで、
    // 覗いても奥行きが締まらない。深度から視点までの距離を戻して、
    // 合焦距離から離れているほどボカす形にする
    tDepth: { value: null },
    tFocus: { value: null },            // FocusPassが入れる1/合焦距離(1x1)
    // 武器のバッファ。銃はviewCameraの別シーンなのでtDepthには写っておらず、
    // 銃の画素には「裏側にある壁の距離」が入っている。αで抜いて世界側のボケから外す
    tView: { value: null },
    uNear: { value: 0.05 },             // カメラから毎フレーム拾う
    uFar: { value: 900 },
    // ボケ量は距離の差ではなく1/距離の差で決める(レンズの錯乱円と同じ形)。
    // 手前と奥で係数を分けるのは、合焦30mに対して1.5mの土嚢が0.63離れているのに
    // 100mのビルは0.023しか離れていないため。同じ係数を掛けると
    // 「手前だけ溶けて奥は素通し」になり、覗いた時に奥行きが締まらない
    uCocNear: { value: 1.6 },
    uCocFar: { value: 19.0 },
    // 錯乱円が最大の時のぼかし半径。画面高に対する比なので解像度が変わっても見た目が揃う。
    // 13タップしか撒かないので、ここを広げるほどリングのゴーストが分かれて見える
    uDofRadius: { value: 0.013 },
    uDofStrength: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth, tFocus, tView;
    uniform vec2 uTexel;
    uniform float uTime, uDamage, uAds, uExposure, uAberration, uVignette;
    uniform float uContrast, uBlackLift, uHiKnee, uHiRoll, uSat;
    uniform float uDofRadius, uDofStrength, uCocNear, uCocFar, uNear, uFar;
    uniform vec3 uShadow, uMid, uHigh;
    varying vec2 vUv;

    // 深度バッファ(非線形)から視点空間のZへ。負の値が返る
    float viewZOf(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }

    // 錯乱円の大きさ。合焦距離との「1/距離の差」で測る。
    // 手前(diff>0)と奥(diff<0)で係数を分ける理由はuniform側のコメントのとおり
    float cocOf(float d, float invFocus) {
      float diff = 1.0 / max(-viewZOf(d), uNear) - invFocus;
      return clamp(diff > 0.0 ? diff * uCocNear : -diff * uCocFar, 0.0, 1.0);
    }

    // インターリーブド・グラディエント・ノイズ。ぼかしのリングを画素ごとに回すのに使う
    float ign(vec2 p) {
      return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
    }

    // ACES(Stephen Hillの近似)。threeのACESFilmicToneMappingと同じ式・同じ係数にしてある。
    // 自前で書き直したせいで明るさが変わると、照明側の調整が全部ずれる
    const mat3 ACES_IN = mat3(
      0.59719, 0.07600, 0.02840,
      0.35458, 0.90834, 0.13383,
      0.04823, 0.01566, 0.83777
    );
    const mat3 ACES_OUT = mat3(
       1.60475, -0.10208, -0.00327,
      -0.53108,  1.10813, -0.07276,
      -0.07367, -0.00605,  1.07602
    );

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    vec3 rrtOdtFit(vec3 v) {
      vec3 a = v * (v + 0.0245786) - 0.000090537;
      vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
      return a / b;
    }

    vec3 tonemap(vec3 c) {
      c *= uExposure / 0.6;
      c = ACES_IN * c;
      c = rrtOdtFit(c);
      c = ACES_OUT * c;
      return clamp(c, 0.0, 1.0);
    }

    // リニア→sRGB。ここから先は「目で見た明るさ」に近い空間になるので、
    // 0.5が中間グレーとして扱えて色調整の数値が直感どおりに効く
    vec3 toDisplay(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(0.4166667)) - 0.055, step(0.0031308, c));
    }

    void main() {
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);

      // 色収差。画面端ほど強く、被弾中はさらに広がる
      float ab = uAberration * (1.0 + uDamage * 6.0);
      vec2 off = c * r2 * ab * 8.0;
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + off).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - off).b;

      // ADS中だけの浅い被写界深度(世界側)。ピントはクロスヘアの先にある物に合っていて、
      // そこから奥にも手前にも離れるほどボケる。合焦距離はFocusPassが1画素のバッファに
      // 1/距離の形で入れてある。
      // 銃と光学の筐体は先のViewCompositePassでボケ済みなので、ここでは受け持たない。
      // uAdsは画面全体で同じ値なので、この分岐は覗いていない間まるごと飛ぶ
      if (uAds > 0.002) {
        float invFocus = texture2D(tFocus, vec2(0.5, 0.5)).r;
        float coc = cocOf(texture2D(tDepth, vUv).x, invFocus);
        // 銃の画素は世界の深度を持っていない(別シーンなので深度には裏の壁が入っている)。
        // そのままボカすと、銃だけが「裏側にある壁までの距離」でボケる。
        // 武器のαで抜いて、銃のボケはViewCompositePassだけに任せる
        coc *= 1.0 - clamp(texture2D(tView, vUv).a, 0.0, 1.0);
        if (coc * uAds > 0.012) {
          // 画素の縦横比を揃えて円形にぼかす。UVのまま足すと横長の楕円になる。
          // 半径を錯乱円に比例させるので、合焦面へ近づくほど自然にタップが中心へ畳まれる
          vec2 s = vec2(uTexel.x / uTexel.y, 1.0) * uDofRadius * coc;
          // 内側6点＋外側6点を30度ずらす。1周だけだと大きく開いた時に六角形が見える。
          // さらに画素ごとにリングを回す。固定のままだと明るい点の周りに
          // 同じ形のゴーストが12個並んで、玉ボケではなく星形の判子に見える
          float rot = ign(gl_FragCoord.xy) * 1.0471976;
          vec3 acc = col;
          float wsum = 1.0;
          for (int i = 0; i < 12; i++) {
            float k = float(i);
            float ring = step(6.0, k);      // 0=内周(0.6倍) 1=外周(1.0倍)
            float a = (k - ring * 6.0) * 1.0471976 + ring * 0.5235988 + rot;
            vec2 tuv = vUv + vec2(cos(a), sin(a)) * mix(0.6, 1.0, ring) * s;
            // タップ自身のボケが中心の画素まで届く物だけ採る。全部同じ重みで足すと、
            // 合焦した的の輪郭へ奥の背景がにじんで、縁に二重の暈が付く
            float w = clamp(cocOf(texture2D(tDepth, tuv).x, invFocus)
                            / max(coc, 0.02) * 1.25, 0.0, 1.0);
            acc += texture2D(tDiffuse, tuv).rgb * w;
            wsum += w;
          }
          col = mix(col, acc / wsum, uAds * uDofStrength);
        }
      }

      // ビネットと被弾の赤みはトーンマップ前(リニア)で掛ける。
      // レンズの減光に近い出方になるし、赤が飽和しても白飛びせずに肩で寝てくれる
      // r2はvUv-0.5の二乗長なので、四隅でも最大0.5にしかならない。終端を0.55のように
      // 四隅のすぐ外に置くと、隅に着く前にsmoothstepが1.0近くまで上がりきってしまい、
      // 弱めたはずの係数が丸ごと乗る。終端は四隅の外(0.68)まで送って上がりきらせない。
      // 立ち上がりも0.18(＝画面高の8割強の円)まで遅らせて、左右端の中央＝床が広く写る帯を
      // 完全にフラットにする。この形だと四隅で表示輝度が2割弱落ちるだけで、
      // 平らな床が端に向かって暗くなる「フィルタ感」が出ない
      float vig = 1.0 - uVignette * smoothstep(0.18, 0.68, r2);
      col *= vig;

      if (uDamage > 0.001) {
        // 画面端だけに寄せる。中央まで染めると狙いが付けられなくなる。
        // 体力が低い間はuDamageが出っぱなしなので、脈打たせて「まずい状態」を体で分からせる
        float pulse = 0.86 + 0.14 * sin(uTime * 8.0);
        float d = uDamage * pulse;
        float edge = smoothstep(0.10, 0.62, r2);
        col = mix(col, mix(col, vec3(0.45, 0.02, 0.02), 0.62), edge * d);
        col *= 1.0 - d * 0.08;
      }

      col = tonemap(col);
      col = toDisplay(col);

      /* ---------------- ここから表示空間でのグレード ---------------- */

      // 輝度から影・中間・ハイライトの重みを作って別々に色を足す
      float l = luma(col);
      float wS = 1.0 - smoothstep(0.0, 0.42, l);
      float wH = smoothstep(0.48, 1.0, l);
      float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
      col += uShadow * wS + uMid * wM + uHigh * wH;
      col = clamp(col, 0.0, 1.0);

      // S字コントラスト。両端(0と1)を動かさない形なので、締めても白飛び・黒潰れが増えない
      col = mix(col, col * col * (3.0 - 2.0 * col), uContrast);

      // ハイライトの肩。上限に張り付いたままだとデジタル臭が残る
      vec3 t = max(col - uHiKnee, 0.0) / max(1.0 - uHiKnee, 0.0001);
      col -= t * t * uHiRoll * (1.0 - uHiKnee);

      // 黒を少しだけ浮かせる。影を寒色に振って締めても潰れないようにするため
      col = mix(vec3(uBlackLift), vec3(1.0), col);

      float l2 = luma(col);
      col = mix(vec3(l2), col, uSat);

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

/* ------------------------------------------------- 最後の締め(輪郭＋粒子) */

// FXAAで均した後に掛ける。先に掛けるとFXAAがシャープの縁を拾って余計に滲む。
// グレインもここ。シャープの前に乗せると粒がバリバリに強調される
const FinishShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    // FXAAが均しきれないサブピクセル幅の線(有刺鉄線・手すり)を、シャープが拾い直して
    // 白い点のハッシュに戻してしまう。輪郭の立ちを捨てない範囲でかなり弱く掛ける
    uSharpen: { value: 0.15 },
    uSharpClamp: { value: 0.06 },
    // 覗いている量。gradeと同じuniformオブジェクトを差し込んで共有する。
    // ADSでわざとボカした所まで同じ量でシャープを掛けると、
    // 前段で作った被写界深度を最後の1パスで削り戻してしまう
    uAds: { value: 0 },
    // ボケた所を見分けるための材料。gradeとuniformオブジェクトごと共有して、
    // 錯乱円の判定をgradeと1つの式に揃える。ここを画面中心からの距離で持つと、
    // 手前1.5mの土嚢が画面中央に来た時だけシャープが復活して、
    // 溶けた面にリングの縁だけが立つ
    tDepth: { value: null },
    tFocus: { value: null },
    uNear: { value: 0.05 },
    uFar: { value: 900 },
    uCocNear: { value: 1.6 },
    uCocFar: { value: 19.0 },
    uGrain: { value: 0.018 },
    uGrainPx: { value: 1 },   // 粒1つ分の画面ピクセル数。デバイスピクセル比から入れる
    uTime: { value: 0 },      // gradeと同じuniformオブジェクトを差し込んで共有する
    // 量子化ディザの振幅。8bit1段ぶん(1/255)を目安に置く
    uDither: { value: 0.85 / 255 },
    // 孤立輝点をどこまで許すか。周囲8画素の最大輝度に対する倍率と下駄
    uFireflyGain: { value: 3.4 },
    uFireflyFloor: { value: 0.34 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse, tDepth, tFocus;
    uniform vec2 uTexel;
    uniform float uSharpen, uSharpClamp, uGrain, uGrainPx, uTime, uAds;
    uniform float uDither, uFireflyGain, uFireflyFloor;
    uniform float uNear, uFar, uCocNear, uCocFar;
    varying vec2 vUv;

    float viewZOf(float d) { return (uNear * uFar) / ((uFar - uNear) * d - uFar); }

    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }

    float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;

      vec3 e = texture2D(tDiffuse, vUv + vec2(uTexel.x, 0.0)).rgb;
      vec3 w = texture2D(tDiffuse, vUv - vec2(uTexel.x, 0.0)).rgb;
      vec3 nn = texture2D(tDiffuse, vUv + vec2(0.0, uTexel.y)).rgb;
      vec3 s = texture2D(tDiffuse, vUv - vec2(0.0, uTexel.y)).rgb;

      // 斜め4点。孤立輝点かどうかの判定にだけ使う
      vec3 ne = texture2D(tDiffuse, vUv + uTexel).rgb;
      vec3 sw = texture2D(tDiffuse, vUv - uTexel).rgb;
      vec3 nw = texture2D(tDiffuse, vUv + vec2(-uTexel.x, uTexel.y)).rgb;
      vec3 se = texture2D(tDiffuse, vUv + vec2(uTexel.x, -uTexel.y)).rgb;

      // ファイアフライつぶし。法線マップの高周波が粗さに繰り込みきれず残った
      // 1px幅の白い輝点を、周囲8画素より飛び抜けているぶんだけ引き戻す。
      // 有刺鉄線や手すりのような細い線は斜めも含めたどこかの近傍が明るいので残る。
      // シャープより先に掛ける。後だと輝点をシャープが増幅してから潰す形になり、
      // 周囲まで引きずられて黒い縁が付く
      float lmax = max(max(max(luma(e), luma(w)), max(luma(nn), luma(s))),
                       max(max(luma(ne), luma(sw)), max(luma(nw), luma(se))));
      float lc = luma(c);
      float lim = lmax * uFireflyGain + uFireflyFloor;
      c *= min(1.0, lim / max(lc, 0.0001));

      vec3 n = (e + w + nn + s) * 0.25;

      // アンシャープマスク。持ち上げ幅に上限を付けないと、
      // 空と屋根のような強いコントラストの境目が白く縁取られる
      vec3 d = clamp(c - n, -uSharpClamp, uSharpClamp);
      // 前段でボカした所(ADS中)ではシャープを引く。判定はgradeの被写界深度と
      // 同じ式にする。ずらすと輪郭が立つ帯とボケる帯が分かれて縞に見える
      float soft = 1.0;
      if (uAds > 0.002) {
        float diff = 1.0 / max(-viewZOf(texture2D(tDepth, vUv).x), uNear)
                   - texture2D(tFocus, vec2(0.5, 0.5)).r;
        float coc = clamp(diff > 0.0 ? diff * uCocNear : -diff * uCocFar, 0.0, 1.0);
        soft = 1.0 - uAds * coc * 0.85;
      }
      vec3 col = c + d * uSharpen * soft;

      // フィルムグレイン。
      // 周波数はUVではなく画面ピクセル座標で決める。UV基準だと解像度を上げるほど粒が引き伸ばされ、
      // 4Kでは粒が倍に肥大してフィルムでなく壁紙の模様になる。
      // uTimeは加算され続けて桁が大きくなるので、fractで丸めてから使う(hashが固まるのを防ぐ)
      vec2 rawPx = vUv / uTexel;
      vec2 px = floor(rawPx / max(uGrainPx, 1.0));
      float g = hash(px + fract(uTime) * 137.0) - 0.5;

      // 実フィルムの粒は中間調で最大、影とハイライトでは目立たない。暗部ピークにすると
      // 手前のアスファルトのような一番暗い面に最大量が乗り、フィルムでなくビデオノイズに見える
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      float wg = 4.0 * lum * (1.0 - lum);
      col += g * uGrain * (0.25 + 0.75 * wg);

      // 量子化ディザ。グレインとは別項として最後に必ず足す。
      // グレインは上の重みで中間調に寄せてあるので、空(輝度0.93前後)では
      // 実効振幅が1/255の段差より小さくなり、8bitに丸めた時の等高線が丸見えになる。
      // ディザは輝度に依存させず、粒の大きさとも無関係に必ず1画素単位で振る。
      // 一様乱数2つの差＝三角分布にするのは、一様分布のままだと丸め後のノイズ量が
      // 元の値によって変わり、平坦な空にうっすら濃淡のムラが残るため
      vec2 dpx = floor(rawPx);
      float d1 = hash(dpx + fract(uTime) * 271.0);
      float d2 = hash(dpx.yx + 19.73 + fract(uTime) * 197.0);
      col += (d1 - d2) * uDither;

      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

/* ---------------------------------------------------------------- 組み立て */

export function createComposer(renderer, scene, camera, viewScene, viewCamera) {
  // 実際の描画バッファ寸法で作る。CSS寸法で作ると高DPI画面でぼやける
  const size = renderer.getDrawingBufferSize(new THREE.Vector2());

  // MSAAの本数。EffectComposerを使っている以上rendererのantialiasは効かない
  // (描き先がレンダーターゲットなので)ため、AAはターゲット側のsamplesで掛ける。
  // ここが買えるのは輪郭の階調だけで、細い線の生き死にではない。同じ1フレームのまま
  // rtWorldのsamplesだけ0にして撮り比べると、強い輪郭の画素が中央値6.3階調・上位5%で
  // 64.5階調動き、中間の被覆率を持つ画素の割合が0.471→0.339に落ちる(平坦な面の差は0)。
  // 一方で、空を背景にした暗い線を持つ列はMSAAを切ったほうが多い(45階調以上で553→592)。
  // 線は消えずに硬くなるだけなので、以前ここにあった「切ると4割弱の列で線が丸ごと消える」
  // は撤回する。あれは撮り直すたびに立ち位置がずれた2枚を比べた数字だった。
  // サンプルの間をすり抜けるサブピクセルの細物は4サンプルでも拾えず、FXAAは描き終わった
  // 絵をぼかす道具なのでなおさら拾えない。これ以上詰めるなら金網のようなアルファテスト
  // 材質側のalphaToCoverage(rtWorldがMSAAなので受け皿は出来ている)か時間方向の蓄積で、
  // どちらもこのファイルの外の話。
  // 上限を4で切るのは、増やすとこのMSAAの1枚だけ帯域が本数ぶん増えるため。
  // maxSamplesはハードウェア側の上限で、下回る環境ではそちらに合わせる
  const samples = Math.min(4, renderer.capabilities.maxSamples || 0);

  // 世界を描く先。MSAAを効かせるのはここと武器のrtViewだけにする。
  // EffectComposerは渡したターゲットを複製してping-pongの2枚にするので、
  // 合成器側にsamplesを渡すと鎖の2枚とも4サンプルになり、
  // 幾何を1つも描かないフルスクリーンのパス(AO合成・武器合成・ブルーム・グレア・
  // グレード・FXAA・仕上げ)まで毎回4サンプルの書き込みと解決のblitを踏むことになる。
  // その板は画面を端まで覆うので、どの画素も4サンプルが同じ色になり、解決しても
  // 元の1枚と同じ絵に戻るだけ。絵は1画素も変わらないまま書き込み帯域が8パスぶん4倍になる
  const rtWorld = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples,
  });

  // 合成器のping-pongは1サンプル。深度も要らない。幾何を描くのはrtWorldとrtViewだけで、
  // ここに来るのは全部depthTestを切ったフルスクリーンの板なので、深度バッファは
  // 一度も読まれないまま毎フレーム確保とクリアだけされることになる
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    depthBuffer: false,
    stencilBuffer: false,
  });
  const composer = new EffectComposer(renderer, target);

  // RenderPassは第3引数(readBuffer)を描画先にする。鎖の1サンプルの板ではなく
  // MSAAのrtWorldへ向ける。マルチサンプルのターゲットはそのままテクスチャとして
  // 読めないが、threeが.textureを使う時に解決のblitを自動で挟むので、
  // 後ろのパス(AO合成・ブルーム・グレア)は普通の1枚絵として読める。こちらでblitは書かない
  const worldPass = new RenderPass(scene, camera);
  const worldRender = worldPass.render.bind(worldPass);
  worldPass.render = (r, writeBuffer, readBuffer, dt, maskActive) =>
    worldRender(r, writeBuffer, rtWorld, dt, maskActive);
  worldPass.setSize = (w, h) => rtWorld.setSize(w, h);
  composer.addPass(worldPass);

  /* ------------------------------------------------ アンビエントオクルージョン */

  // 物と地面の接地部に陰りを入れる。これが無いと全部が床から浮いて見える。
  // 武器は別シーンなので、AOは必ず武器を重ねる前に掛ける。後ろの世界の遮蔽で
  // 銃が黒ずむのを避けるため
  const [aw, ah] = aoDim(size.x, size.y);
  const ao = new GTAOPass(scene, camera, aw, ah, undefined, {
    // メートル。0.6だと拾うのが「部屋の隅」規模の大きな陰りだけになり、
    // クラックの溝・瓦礫と床の接点・土嚢と床の接点といった5〜20cmの落ち込みが
    // サンプルの間に埋もれて出てこない。接地の陰りを主役にするので短く取る
    radius: 0.35,
    distanceExponent: 1.0,
    thickness: 1.0,
    scale: 1.0,
    samples: 16,
    screenSpaceRadius: false,
  }, {
    // デノイズの半径はそのまま陰りのぼけ幅になる。5だと拾った接地の落ち込みを
    // また塗り潰してしまうので詰める
    lumaPhi: 10, depthPhi: 2, normalPhi: 3,
    radius: 4, rings: 2, samples: 16, radiusExponent: 2,
  });
  // 標準の合成(OUTPUT.Default)はハードウェアブレンドの乗算で、元の色を読めない。
  // 日向と日陰を見分けて掛け方を変えたいので、合成は自前のパスでやる。
  // 出力を切ったパスをそのまま繋ぐとcomposerがバッファを空振りで入れ替えてしまうため、
  // needsSwapも下ろしてreadBufferに世界の絵を残す
  ao.output = GTAOPass.OUTPUT.Off;
  ao.needsSwap = false;

  const aoSetSize = GTAOPass.prototype.setSize.bind(ao);
  ao.setSize = (w, h) => aoSetSize(...aoDim(w, h));

  // 半透明の板(着弾痕・曳光弾・マズルフラッシュ・煙)まで法線バッファに描くと、
  // 手前に偽の遮蔽物ができて撃つたびに画面が暗くなる。深度を書かない物はAOの計算から外す
  const aoHidden = ao._visibilityCache;
  ao._overrideVisibility = function () {
    this.scene.traverse((o) => {
      if (!o.visible) return;
      const m = o.material;
      if (o.isPoints || o.isLine || o.isLine2 || o.isSprite || (m && m.depthWrite === false)) {
        o.visible = false;
        aoHidden.push(o);
      }
    });
  };

  // GTAOは法線バッファを作るのに renderer.render() をもう一度呼ぶ。そのままだと
  // 2048pxの影マップまで毎フレーム二度焼きされるので、この間だけ影の更新を止める
  const aoRender = ao.render.bind(ao);
  ao.render = (r, writeBuffer, readBuffer, dt, maskActive) => {
    const prev = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;
    aoRender(r, writeBuffer, readBuffer, dt, maskActive);
    r.shadowMap.autoUpdate = prev;
  };

  composer.addPass(ao);

  // AOの合成。GTAOのデノイズ済みバッファを読んで、直射が当たっている面だけ効きを弱める。
  // 深度と法線はGTAOが法線パスで既に作っているものを借りる。接触影のレイマーチに使う
  const aoCompose = new ShaderPass(AoComposeShader);
  // 世界の絵はMSAAのrtWorldから読む。ここが鎖の最初の読み手になる
  aoCompose.uniforms.tWorld.value = rtWorld.texture;
  aoCompose.uniforms.tAo.value = ao.pdRenderTarget.texture;
  aoCompose.uniforms.tDepth.value = ao.depthTexture;
  aoCompose.uniforms.tNormal.value = ao.normalTexture;
  // AOバッファは0.75倍なので、テクセル幅は画面のそれとは別に持つ。
  // ここを更新し忘れると解像度を変えた時に接触線の判定幅がずれる
  aoCompose.setSize = (w, h) => {
    const [dw, dh] = aoDim(w, h);
    aoCompose.uniforms.uAoTexel.value.set(1 / dw, 1 / dh);
  };
  aoCompose.setSize(size.x, size.y);

  // 接触影は視点空間で計算するので、カメラの投影行列と太陽の向きを毎フレーム渡す。
  // ADSで画角が動くたびに投影行列は変わるので、作った時の値を焼き付けてはいけない
  let aoSun = null;
  const aoComposeRender = aoCompose.render.bind(aoCompose);
  aoCompose.render = (r, writeBuffer, readBuffer, dt, maskActive) => {
    const u = aoCompose.uniforms;
    u.uProj.value.copy(camera.projectionMatrix);
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uNear.value = camera.near;
    u.uFar.value = camera.far;
    if (!aoSun) aoSun = findSun(scene);
    if (aoSun) {
      aoSun.getWorldPosition(_sunWorld);
      aoSun.target.getWorldPosition(_tgtWorld);
      _sunWorld.sub(_tgtWorld).normalize();
      // 視点空間へ。transformDirectionは回転だけを掛けて正規化してくれる
      _sunView.copy(_sunWorld).transformDirection(camera.matrixWorldInverse);
      u.uSunView.value.copy(_sunView);
    } else {
      u.uSscs.value = 0;
    }
    aoComposeRender(r, writeBuffer, readBuffer, dt, maskActive);
  };
  composer.addPass(aoCompose);

  // クロスヘアの先にある物までの距離。ADSの被写界深度がここを基準に働く。
  // 深度はGTAOが法線パスで既に焼いているものをそのまま借りるので、
  // このパスはAOより後ろに置く必要がある。書き先は1x1なので描画の負荷は無いに等しい
  const focus = new FocusPass(ao.depthTexture, camera);
  // 深度バッファはAO解像度(0.75倍)なので、テクセル幅は画面のそれとは別に持つ
  focus.setSize = (w, h) => {
    const [dw, dh] = aoDim(w, h);
    focus.material.uniforms.uTexel.value.set(1 / dw, 1 / dh);
  };
  focus.setSize(size.x, size.y);
  composer.addPass(focus);

  /* ------------------------------------------------------------ ブルーム */

  // 武器を重ねる前に掛ける。ここが順番の肝。
  // 武器を合成した後の1枚に掛けると、その時点でマズルフラッシュ(リニア5.0,4.2,2.6の加算・
  // 板が重なるので実効10超)は既に銃の真上に乗っている。ブルームにはフラッシュと銃の区別が
  // 付かないので、フラッシュのために作った滲みがそのまま銃の画素へ足される。
  // 同じ発砲フレームを順番だけ入れ替えて描き直した実測(腰だめ・銃のシルエット93931画素):
  //   武器の後ろ 平均輝度0.1843 / 勾配16.794 / 相対コントラスト(勾配÷平均)91.1
  //   武器の前   平均輝度0.1370 / 勾配18.467 / 相対コントラスト134.8   (静止時は137.1)
  // 輪郭の段差そのものは残るのに平均輝度だけが上がるので、比で見ると細部が消える。
  // それが連射中は1発ごとにon/offするので、目には「撃つと銃の絵がブレる」として届いていた。
  // 覗いている時はもっと酷く、相対コントラストが静止44.6→発砲9.2まで落ちて
  // 照準像が丸ごと白く飛んでいた(前へ移すと24.9まで戻る)。
  // 静止フレームでは前後どちらに置いても銃の輝度は0.1183対0.1179しか変わらない＝
  // 銃の上に乗っていた滲みは発砲時の物しかなく、前へ移して失う絵は無い。
  // レンズの癖として武器の上にも乗せたい滲みは、この後のSunGlarePassが受け持っている。
  //
  // 閾値は「空が絶対に届かない高さ」に置く。夕方の空は地平帯の0xc6b49bだけでリニア輝度0.51、
  // ヘイズが乗ると0.65前後まで来るので、0.62では空の面そのものが発光体になる。
  // そうなると建物の縁が空側からにじんで、暗いはずのシルエットが縁から2〜3割持ち上がって白く溶ける。
  // 0.95まで上げると、太陽ディスク(15.0)・太陽のすぐ周りのグレア・世界側のマズルライトで
  // 照らされた壁・曳光弾・着弾＝実際に自分で光っている物だけが残る。
  // strengthとradiusも切り詰める。閾値を上げても丸いにじみが太いままだと、
  // 太陽の手前を横切る鉄塔の水平梁がグレアに食われて途中で断線する。
  // 太陽を「明るい」と見せる仕事は、この後のSunGlarePassの光条とゴッドレイに移す
  const bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.22, 0.45, 0.95);
  composer.addPass(bloom);

  // 武器は別シーン。深度だけ消してから重ねるので、壁にめり込んでも銃が欠けない。
  // ただし重ね方はViewCompositePassに任せる。世界のバッファへ直接描いてしまうと
  // 「武器だけをぼかす」ができず、覗いても画が何も変わらないADSになる
  const viewPass = new RenderPass(viewScene, viewCamera);
  viewPass.clear = true;
  viewPass.clearColor = new THREE.Color(0, 0, 0);
  viewPass.clearAlpha = 0;
  const viewComposite = new ViewCompositePass(viewPass, size.x, size.y, samples);
  composer.addPass(viewComposite);

  // 太陽の光条(横一直線)と、手前のシルエットで切れるゴッドレイ。
  // レンズの artifact なので武器も含めて全部の上に乗せる
  const glare = new SunGlarePass(scene, camera, size.x, size.y);
  composer.addPass(glare);

  /* ------------------------------------------- トーンマップ＋グレード */

  const grade = new ShaderPass(GradeShader);
  grade.setSize = (w, h) => grade.uniforms.uTexel.value.set(1 / w, 1 / h);
  // 覗いている量は武器のボケ(ViewCompositePass)と周辺視野のボケ(grade)の両方で要る。
  // main.jsはgrade.uniforms.uAdsにしか書かないので、uniformオブジェクトごと共有する
  grade.uniforms.uAds = viewComposite.ads;
  // 被写界深度の材料。深度はGTAOのもの、合焦距離はFocusPassの1画素、
  // 武器のαは銃を世界側のボケから外すために使う
  grade.uniforms.tDepth.value = ao.depthTexture;
  grade.uniforms.tFocus.value = focus.rt.texture;
  grade.uniforms.tView.value = viewComposite.rtView.texture;
  // OutputPassを外したので、露出はここで拾う。main.js側のtoneMappingExposureを尊重する。
  // near/farも毎フレーム入れる。ADSで画角が動いても投影行列だけが変わり
  // near/far自体は動かないが、main.js側で触られた時に焼き付けた値だとずれる
  const gradeRender = grade.render.bind(grade);
  grade.render = (r, writeBuffer, readBuffer, dt, maskActive) => {
    grade.uniforms.uExposure.value = r.toneMappingExposure;
    grade.uniforms.uNear.value = camera.near;
    grade.uniforms.uFar.value = camera.far;
    gradeRender(r, writeBuffer, readBuffer, dt, maskActive);
  };
  composer.addPass(grade);

  // gradeがsRGBまで変換済みなので、FXAAはここで正しく効く（輝度差で輪郭を探すため）
  const fxaa = new FXAAPass();
  composer.addPass(fxaa);

  const sharpen = new ShaderPass(FinishShader);
  sharpen.setSize = (w, h) => sharpen.uniforms.uTexel.value.set(1 / w, 1 / h);
  // main.jsが書くのはgrade.uniforms.uTimeだけなので、uniformオブジェクトごと共有して
  // グレインにも同じ時間を流す
  sharpen.uniforms.uTime = grade.uniforms.uTime;
  // 覗いている量も共有する。ADSでボカした所をここでシャープに戻さないため
  sharpen.uniforms.uAds = viewComposite.ads;
  // 錯乱円の判定に使う材料もgradeとオブジェクトごと共有する。
  // 値を別に持つと、片方だけ調整した時にボケる帯とシャープが立つ帯がずれて縞に見える
  sharpen.uniforms.tDepth = grade.uniforms.tDepth;
  sharpen.uniforms.tFocus = grade.uniforms.tFocus;
  sharpen.uniforms.uNear = grade.uniforms.uNear;
  sharpen.uniforms.uFar = grade.uniforms.uFar;
  sharpen.uniforms.uCocNear = grade.uniforms.uCocNear;
  sharpen.uniforms.uCocFar = grade.uniforms.uCocFar;
  composer.addPass(sharpen);

  // 粒はデバイスピクセルではなくCSSピクセル基準で1粒にする。デバイスピクセル基準にすると
  // 高DPI画面で粒が肉眼の限界より細かくなり、目には見えないままチラつきだけが残る
  const syncGrainScale = () => {
    sharpen.uniforms.uGrainPx.value = Math.max(1, renderer.getPixelRatio());
  };
  syncGrainScale();

  return {
    composer, bloom, grade, viewPass, viewComposite, ao, aoCompose, glare, sharpen,
    focus, rtWorld,
    // composer.setSize がピクセル比を掛けて全パスに配るので、CSS寸法を渡す
    setSize(w, h) {
      composer.setSize(w, h);
      // 別DPIのディスプレイに窓を移すとピクセル比が変わるので、粒の大きさも取り直す
      syncGrainScale();
    },
  };
}
