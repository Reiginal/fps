// 全部を繋ぐ本体。読み込み → 生成 → ゲームループ。
import * as THREE from 'three';
import { buildMaterials, createSky, skyFogColor } from './world/textures.js';
import { buildLevel } from './world/level.js';
import { Effects } from './world/effects.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { createComposer } from './core/postfx.js';
import { Player } from './player/player.js';
import { WeaponSystem } from './player/weapons.js';
import { Director } from './ai/enemy.js';
import { HUD } from './ui/hud.js';
import { NetMenu, NET_MSG } from './ui/netmenu.js';
import { NetClient } from './net/client.js';
import { RemotePlayers } from './net/remote.js';
import { K, KEY_CODES, S, EV, PART, MATCH, TICK_DT } from './net/protocol.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// 太陽の向き。ここが画の出来をほぼ決める。
// 以前は仰角43度でスポーン視線の真後ろから当たる完全な順光だったので、
// 物の落ち影が全部その物の裏に隠れて画面に一つも出ていなかった。
// 低い高度(約27度)で、視線に対して斜め前左から当てる。これで
//   ・影が手前に長く伸びて画面内に入る
//   ・面ごとに明暗差がついて立体が起きる
//   ・輪郭に逆光気味の縁が出る
// の3つが同時に効く。夕方寄りの空の色ともこの高度が合う。
const SUN_DIR = new THREE.Vector3(-0.78, 0.46, -0.34).normalize();

// ビューモデルのキーライトが必ず確保する向き（カメラ空間・右上手前）。
// 太陽追従だけにすると背を向けた時に銃が真っ黒になるので、これへ寄せて下限を作る
const VIEW_KEY_FIXED = new THREE.Vector3(0.45, 0.72, 0.52).normalize();

/* ------------------------------------------------------------------ 影 */

// 太陽の見かけの大きさ（半径側の角度のtan）。光源が点でないから、遮蔽物から
// 離れるほど影の縁が広がる。半影の量はこの1つの数字だけで決まり、
// 縁のぼけ幅(半径) = 遮蔽物までの光線距離 × この値。
// 実物の太陽は半径0.27度(tan 0.0046)しかなく、それだと2m上の縁で1cm、
// 20m先で0.2pxにもならず画では読めない。屋外の影の縁は太陽の大きさだけでなく
// 空全体からの散乱でもぼけているので、6倍(半径1.6度)まで誇張する
const SUN_ANGULAR_TAN = 0.028;

// 深度に足す下駄。影カメラの正規化深度ではなくワールドの長さ(m)で持つ。
// カスケードは枚ごとに深度レンジが違うので、正規化された値を全枚に使い回すと
// レンジの広い枚だけ下駄が実寸で数倍になり、そこだけ接地影が浮く。
// 3.8mmは前の設定(bias -0.00002 × 深度レンジ189m)の実寸そのままで、
// あの値は散々調整して合格が出ているので、実寸のほうを引き継ぐ
const SHADOW_BIAS_M = 0.0038;

// normalBiasはテクセル何個ぶん法線方向に押し出すか。
// 前の設定(0.028 / テクセル2.25cm)が1.24個ぶんだったので、その比を引き継ぐ。
// ここを実寸で固定すると一番細かい枚で押し出しすぎて足元の接地影が丸ごと消える
const SHADOW_NORMAL_BIAS_TEXELS = 1.24;

// 影マップの横。縦は下のSHADOW_MAP_MINOR
const SHADOW_MAP_SIZE = 2048;

// 影マップの縦。正方にしない。カスケードの箱は太陽に正対しているので、
// 縦（＝太陽の側から見た上下）1mは地面の上では 1/sin(仰角) = 2.1m に伸びる。
// 正方の箱にすると地面では太陽方向にだけ2.1倍長い帯を覆うことになり、
// その余分な帯のぶんだけ影マップへ描く物が増える。
// 縦をsin(仰角)倍に潰すと地面での覆い方が正方形になり、テクセルも正方のまま保てる
const SHADOW_MAP_MINOR = Math.round(SHADOW_MAP_SIZE * SUN_DIR.y);

// 太陽の仰角のtan。カスケードの箱の奥行きを決めるのに要る
const SUN_TAN_ELEVATION = SUN_DIR.y / Math.hypot(SUN_DIR.x, SUN_DIR.z);

// 影カメラが箱の面より上（太陽側）へ何m遡って遮蔽物を拾うか。
// 高さhの物は h/sin(仰角) だけ太陽側にいるので、仰角28度の今は
// 52mで高さ24.7m相当。場内で一番高い面を実測したら18.1mだったので、
// これで場内の全部が影を落とせる。ここを無闇に伸ばすと、
// 影マップに描くだけ描いて画には出ない物が増えて描画回数だけ膨らむ
const SHADOW_CASTER_REACH = 52;

// 半影のカーネルが広がれる上限（テクセル）。探索半径も兼ねる。
// ここを大きくするとタップが薄く散って縁がざらつくので、増やすならタップ数も要る。
// 一番細かい枚では20テクセル=23cmが上限になるので、
// 手元から4m以上高い所の縁はそれ以上ぼけない（それ以上は次の枚の担当）
const SHADOW_MAX_TEXELS = 20;
const SHADOW_BLOCKER_TAPS = 12;
const SHADOW_PCF_TAPS = 16;

// 太陽の影を距離で分割した3枚。radiusは箱の半径(m)。
// followはカメラに付いていくか、intervalは何フレームに1回焼き直すか。
// 一番外の1枚は場全体を固定で覆う。動かさないので縁がちらつかず、
// 中身もほとんど建物なので毎フレーム焼き直す必要がない
const CASCADES = [
  { radius: 12, follow: true, interval: 1 },
  { radius: 30, follow: true, interval: 1 },
  { radius: 90, follow: false, interval: 3 },
];

/**
 * 影の計算をカスケード＋PCSSに差し替える。
 *
 * 材質側には一切触らない。このrepoの材質はonBeforeCompileが何段も積んであって、
 * three/addons/csm/CSM.jsのsetupMaterial()はそれを上書きで潰してしまう
 * （汚れのマクロ変調・詳細法線・地面の第2層が全部消える）。
 * ShaderChunkを丸ごと差し替えれば材質を1つも触らずに全材質へ同じ計算が乗るので、
 * 「後から作られた材質だけカスケードに乗り遅れて太陽が3重に当たる」事故も起きない。
 */
function installCascadedSoftShadow() {
  const C = THREE.ShaderChunk;
  const N = CASCADES.length;
  // カーネルが枚の外へはみ出すと縁が切れるので、端はカーネル1個ぶん使わない
  const edge = (SHADOW_MAX_TEXELS + 4).toFixed(1);

  // どの枚に載っているかはUVに収まっているかで決める。深度で切ると、
  // 箱がカメラに付いて動くぶん境目が地面の上を滑って見える
  const pick = CASCADES.map((_, i) => `
	size = directionalLightShadows[ ${i} ].shadowMapSize;
	sc = vDirectionalShadowCoord[ ${i} ].xyz / vDirectionalShadowCoord[ ${i} ].w;
	if ( sc.z > 0.0 && sc.z < 1.0
		&& all( greaterThan( sc.xy, ${edge} / size ) ) && all( lessThan( sc.xy, 1.0 - ${edge} / size ) ) ) {

		return sunPenumbra( directionalShadowMap[ ${i} ], size,
			directionalLightShadows[ ${i} ].shadowBias, directionalLightShadows[ ${i} ].shadowRadius, sc, phi );

	}`).join('\n');

  C.shadowmap_pars_fragment = C.shadowmap_pars_fragment + /* glsl */`
#if defined( USE_SHADOWMAP ) && ( NUM_DIR_LIGHT_SHADOWS == ${N} )

	// 画素ごとにサンプルの向きを回す。回さないと少ないタップ数の並びが
	// そのまま縞になって縁に出る
	float sunNoise( vec2 p ) {

		return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );

	}

	// 円盤へ均等に散らす。同じ半径でもタップが中心に寄らない
	vec2 sunDisk( int i, int n, float phi ) {

		float r = sqrt( ( float( i ) + 0.5 ) / float( n ) );
		float a = float( i ) * 2.399963229728653 + phi;
		return vec2( cos( a ), sin( a ) ) * r;

	}

	/* 半影付きの影。固定幅のカーネルで一律にぼかすのをやめて、
	   「何がどれだけ手前で遮っているか」を先に測ってから縁の幅を決める。
	   半径はUVではなくテクセル数で持つ。影マップが正方でない（縦を潰してある）ので、
	   UVで持つと縦横で違う幅にぼけて縁が楕円に歪む。
	   penumbraScaleは深度差1あたりテクセル何個ぶん広がるかの換算係数で、
	   枚ごとに深度レンジも箱の大きさも違うのでJS側から光ごとに渡している */
	float sunPenumbra( sampler2D map, vec2 mapSize, float bias, float penumbraScale, vec3 sc, float phi ) {

		vec2 texel = 1.0 / mapSize;
		float wide = ${SHADOW_MAX_TEXELS.toFixed(1)};
		float z = sc.z + bias;

		// 遮蔽物探し。日向の平らな面はここで1本も当たらないので、
		// 画面の大半はこの${SHADOW_BLOCKER_TAPS}タップだけで抜けられる
		float sum = 0.0;
		float hits = 0.0;
		for ( int i = 0; i < ${SHADOW_BLOCKER_TAPS}; i ++ ) {

			float d = texture2D( map, sc.xy + sunDisk( i, ${SHADOW_BLOCKER_TAPS}, phi ) * wide * texel ).r;
			if ( d < z ) { sum += d; hits += 1.0; }

		}

		if ( hits < 0.5 ) return 1.0;

		// 遮蔽物までの距離に比例して縁を広げる。接地点は距離0なので点のまま残り、
		// 離れた桁や屋根の縁だけがぼける
		float radius = clamp( ( z - sum / hits ) * penumbraScale, 1.0, wide );
		float lit = 0.0;
		for ( int i = 0; i < ${SHADOW_PCF_TAPS}; i ++ ) {

			lit += step( z, texture2D( map, sc.xy + sunDisk( i, ${SHADOW_PCF_TAPS}, phi + 2.4 ) * radius * texel ).r );

		}

		return lit / ${SHADOW_PCF_TAPS.toFixed(1)};

	}

	float sunShadow() {

		float phi = sunNoise( gl_FragCoord.xy ) * PI2;
		vec3 sc;
		vec2 size;
${pick}

		return 1.0;

	}

#endif
`;

  // 向き光の扱いを差し替える。RECT_AREAの手前までが向き光の塊なので、
  // その範囲だけを入れ替えて他は元のまま使う。
  // 目印が見つからなければ黙って元の挙動へ落ちるのではなく落とす。
  // 影が3枚のまま素の計算が走ると太陽が3重に当たって画が破綻するので、
  // 気づかないまま出るほうが困る
  const src = C.lights_fragment_begin;
  const head = '#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )';
  const tail = '#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )';
  const a = src.indexOf(head);
  const b = src.indexOf(tail);
  if (a < 0 || b <= a) throw new Error('lights_fragment_begin: 向き光の差し替え位置が見つからない');

  C.lights_fragment_begin = src.slice(0, a) + /* glsl */`
#if defined( USE_SHADOWMAP ) && defined( RE_Direct ) && ( NUM_DIR_LIGHT_SHADOWS == ${N} )

	// 影を持つ${N}本は1つの太陽を距離で割った物なので、明るさは1本ぶんしか載せない。
	// 素直に${N}本まわすと日向が${N}倍になるうえ、影の計算も${N}回走る
	DirectionalLight directionalLight;
	directionalLight = directionalLights[ 0 ];
	getDirectionalLightInfo( directionalLight, directLight );
	directLight.color *= ( directLight.visible && receiveShadow ) ? sunShadow() : 1.0;
	RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	// 影を持たない向き光（逆光側のリム）はそのまま足す
	#pragma unroll_loop_start
	for ( int i = ${N}; i < NUM_DIR_LIGHTS; i ++ ) {

		directionalLight = directionalLights[ i ];

		getDirectionalLightInfo( directionalLight, directLight );

		RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );

	}
	#pragma unroll_loop_end

#else

${src.slice(a, b)}
#endif

` + src.slice(b);
}

class Game {
  constructor() {
    this.state = 'loading';   // loading | menu | playing | paused | dead
    // solo=今までのウェーブ制 / versus=対戦。判定を持つ場所が根本的に違うので、
    // ループも射撃の解決も分岐させる
    this.mode = 'solo';
    this.score = 0;
    this.kills = 0;
    this.headshots = 0;
    this.shotsFired = 0;
    this.shotsHit = 0;
    this.damageFlash = 0;
    this._lastTime = 0;
    this._invQ = new THREE.Quaternion();

    /* ------------------------------------------------------------ 対戦 */
    this.net = null;
    this.remotes = null;
    this.menu = null;
    // 対戦は物理を60Hz固定で回す。可変dtのまま送ると、同じキーを同じ長さ押しても
    // 到達位置がサーバーと食い違い、補正が常時走ることになる
    this._acc = 0;
    this._plates = [];
    this._toRemote = new THREE.Vector3();
    this._plateV = new THREE.Vector3();
    this._ray = new THREE.Ray();
    this._evPos = new THREE.Vector3();
    this._evNormal = new THREE.Vector3();
    // 誰がいつ撃ったか。散弾を1発の銃声にまとめるのに使う
    this._lastFireAt = new Map();
    // 死んでいる間の入力を止める受け皿。Inputと同じ形をしていればよい
    this._noInput = {
      down: () => false,
      pressed: () => false,
      buttons: [false, false, false],
      takeLook: () => ({ yaw: 0, pitch: 0 }),
      moveVector: (o) => { o.x = 0; o.z = 0; return o; },
      endFrame: () => {},
    };
  }

  async boot() {
    const setLoad = (pct, msg) => {
      document.getElementById('loadFill').style.width = `${pct}%`;
      document.getElementById('loadMsg').textContent = msg;
    };

    /* ------------------------------------------------------ 描画基盤 */
    const canvas = document.createElement('canvas');
    document.body.insertBefore(canvas, document.body.firstChild);
    const renderer = new THREE.WebGLRenderer({
      canvas, antialias: false, powerPreference: 'high-performance', stencil: false,
    });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight);
    renderer.shadowMap.enabled = true;
    // 半影を自前で作るので、影マップは比較付きではなく素の深度で持つ。
    // 「遮蔽物がどれだけ手前にあるか」はハードウェアの深度比較サンプラでは読めず、
    // 生の深度値が要る。ちなみにこのthreeではPCFSoftShadowMapは廃止済みで、
    // 指定しても警告を出してPCFへ落ちるだけなので、あれは元々効いていなかった
    renderer.shadowMap.type = THREE.BasicShadowMap;
    installCascadedSoftShadow();
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // 空を明るく作り直したぶん、露出を下げないと全体が白飛びする。
    // 実測で空が飛んでいたのでさらに絞る（中間調を上限側から救う）
    renderer.toneMappingExposure = 1.0;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer = renderer;

    setLoad(8, '素材を生成中');
    await frame();

    /* ------------------------------------------------------ テクスチャ */
    const mats = buildMaterials(renderer);
    this.mats = mats;

    setLoad(38, '地形を構築中');
    await frame();

    /* ---------------------------------------------------------- 場面 */
    const scene = new THREE.Scene();
    // フォグの色は空の地平線の色から取る。ここがズレると遠景だけ浮いて見える。
    // リニアで1を超える値が来るのでhexコンストラクタでは渡せず、あとからcopyする
    scene.fog = new THREE.FogExp2(0x000000, 0.0062);
    // 空の地平線の色をそのまま使うとリニアで(1.5,1.2,0.85)になり、
    // 日向のコンクリより明るい光を全距離に一律で足すことになる。
    // 結果25m先の木箱と100m先のビルが同じ明るさになって遠近が消えたので、
    // 日向の面より暗くなるところまで落とす
    scene.fog.color.copy(skyFogColor()).multiplyScalar(0.45);
    this.scene = scene;

    const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.05, 900);
    this.camera = camera;
    scene.add(camera);

    // 武器専用の別シーン。壁に近づいても銃が壁に刺さらない
    const viewScene = new THREE.Scene();
    const viewCamera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.002, 12);
    this.viewScene = viewScene;
    this.viewCamera = viewCamera;

    /* ------------------------------------------------------------ 空 */
    const sky = createSky(SUN_DIR);
    sky.scale.setScalar(600);
    scene.add(sky);
    this.sky = sky;

    // 空から環境光を焼く。これがあると金属や影の色が一気に馴染む
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envScene = new THREE.Scene();
    const skyClone = createSky(SUN_DIR);
    skyClone.scale.setScalar(10);
    envScene.add(skyClone);
    const envRT = pmrem.fromScene(envScene, 0.04);
    scene.environment = envRT.texture;
    // 環境光を抑えて日向と日陰の差を開く。上げすぎると影が持ち上がって平坦になる。
    // 空を2.75倍で焼いてあるので下げる必要はあるが、下げすぎると日陰が黒く潰れる。
    // 日陰の中に階調が残る最低限は確保する
    scene.environmentIntensity = 0.85;
    viewScene.environment = envRT.texture;
    viewScene.environmentIntensity = 0.45;   // 銃の環境反射も絞る（上面の白飛び対策）
    skyClone.geometry.dispose();
    skyClone.material.dispose();
    pmrem.dispose();

    /* ---------------------------------------------------------- 照明 */
    // 直射と天空光の比が画の生死を分ける。夕方の直射と天空フィルの比はリニアで5〜10倍あり、
    // ここが詰まると影が「影」ではなく「少し汚れた床」になる。
    // 実測で日向/日陰が1.24倍しかなかったので、直射を上げて環境光を大きく削る
    // 直射と天空光の比。前回1.24倍しか無いと言われて4.6まで振ったら、今度は
    // 日陰が黒く潰れて中間調が消えた。比は保ちつつ、潰さない側へ戻す。
    // 大事なのは「日向/日陰の比」であって「直射の絶対値」ではない。
    // 太陽そのものは1本だが、影だけは距離で分けた3枚に焼く。1枚で場内±46mを
    // 覆っていた時はその外の物が影を落とさず、遠景だけ影の無い書き割りになっていた。
    // 近くは細かく・遠くは粗く分ければ、範囲と精度を両方取れる。
    // 明るさを載せるのはシェーダー側で1枚目だけ（installCascadedSoftShadow参照）
    this._sunQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(SUN_DIR, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
    );
    this._sunQuatInv = this._sunQuat.clone().invert();
    this._sunCenter = new THREE.Vector3();
    this._shadowTick = 0;

    this.cascades = CASCADES.map((c) => {
      const light = new THREE.DirectionalLight(0xfff0d8, 3.6);
      light.castShadow = true;
      light.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_MINOR);
      const sc = light.shadow.camera;
      // 縦を潰したぶん箱の高さも潰す。これで地面での覆いがradius四方の正方形になる
      const minor = c.radius * SUN_DIR.y;
      sc.left = -c.radius; sc.right = c.radius; sc.top = minor; sc.bottom = -minor;
      // 箱の上端と下端で、地面の「光からの距離」はminor/tan(仰角)だけ振れる。
      // ここを見ずに奥行きを決めると、外側の枚の隅だけnearの手前へ落ちて影が消える。
      // 逆に取りすぎると影マップに描くだけで画には出ない物が増える
      const spread = minor / SUN_TAN_ELEVATION;
      const height = spread + SHADOW_CASTER_REACH + 1;
      sc.near = 1; sc.far = height + spread + 12;
      const range = sc.far - sc.near;
      const texel = (c.radius * 2) / SHADOW_MAP_SIZE;
      light.shadow.bias = -SHADOW_BIAS_M / range;
      light.shadow.normalBias = SHADOW_NORMAL_BIAS_TEXELS * texel;
      // shadow.radiusはBasicShadowMapでは使われない。材質へuniformを足さずに
      // 枚ごとの値をシェーダーへ渡す口として借りる。中身は
      // 「深度差1 → 半影の幅がテクセル何個ぶんか」の換算係数（下のsunPenumbra参照）
      light.shadow.radius = (range * SUN_ANGULAR_TAN) / texel;
      // 場全体を固定で覆う枚は中身がほとんど建物なので、毎フレーム焼き直さない
      light.shadow.autoUpdate = c.interval <= 1;
      if (!c.follow) {
        light.position.copy(SUN_DIR).multiplyScalar(height);
        light.target.position.set(0, 0, 0);
      }
      scene.add(light);
      scene.add(light.target);
      return { light, height, texel, ...c };
    });
    this._updateSunCascades();

    // IBLと二重に足すと日陰だけがどんどん持ち上がる。空の色味を足す係として薄く残す
    const fill = new THREE.HemisphereLight(0xa8c4de, 0x4a4136, 0.62);
    scene.add(fill);

    // 地面からの照り返し。上を黒・下を乾いた土色にした半球光は「下向き成分だけ」を
    // 足すので、日向をほとんど変えずに日陰の中だけを暖色で持ち上げられる。
    // これが無いと影が全部「青い穴」になり、影の中の素材が読めなくなる
    // （実測で日陰の路面がB/R比1.8倍の単色板になっていた）
    const bounce = new THREE.HemisphereLight(0x000000, 0x7a6444, 0.55);
    scene.add(bounce);

    // 逆光側のリム。太陽の反対から弱く当てて輪郭を起こす。
    // 実測で兵士の胴(29,33,47)と背後の壁(26,29,40)の差が3階調しかなく、
    // 人物が壁に完全に溶けていた。武器シーンにはvRimを入れているのに、
    // ゲーム中いちばん読ませたい兵士にリムが無かった
    const worldRim = new THREE.DirectionalLight(0x9ec6ff, 0.75);
    worldRim.position.set(-SUN_DIR.x, 0.42, -SUN_DIR.z).multiplyScalar(60);
    scene.add(worldRim);

    // 武器用の照明。ビューモデルはカメラ空間にいるので、光をワールド固定にすると
    // どちらを向いても銃の陰影が同じになり、銃だけ世界と無関係に光る。
    // 毎フレーム太陽の向きをカメラ空間へ引き直して追従させる（_loop内）
    // 銃だけフィルが過剰でキー3.0に対し合計3.65、ワールド側の25:1と30倍違っていた。
    // 結果、銃身の上面が白飛び(232,240,244)して未着色のプレースホルダーに見える。
    // キーを立ててフィルを削り、ワールドと同じ照明比に寄せる
    const vSun = new THREE.DirectionalLight(0xfff2e0, 4.2);
    vSun.position.copy(SUN_DIR);
    viewScene.add(vSun);
    this.vSun = vSun;
    const vFill = new THREE.HemisphereLight(0x9fbcd6, 0x3a352c, 0.40);
    viewScene.add(vFill);
    const vRim = new THREE.DirectionalLight(0x9ec6ff, 0.45);
    vRim.position.set(-0.6, 0.2, -0.7);
    viewScene.add(vRim);

    setLoad(58, '遮蔽物を配置中');
    await frame();

    /* ---------------------------------------------------------- 地形 */
    const level = buildLevel(mats);
    scene.add(level.root);
    this.level = level;
    // 射線判定用。当たり判定専用の見えない床は除き、見えている面だけを対象にする
    this.solidMeshes = [];
    level.root.traverse((o) => { if (o.isMesh && o.visible) this.solidMeshes.push(o); });

    // 着弾の質感を材質から引く。ここに載っていない材質はコンクリ扱いに落ちるので、
    // 波板や錆鉄がコンクリの火花と音で鳴ってしまう。新素材も全部登録する
    this.kindOf = new Map([
      [mats.concrete, 'concrete'], [mats.concreteDark, 'concrete'], [mats.asphalt, 'concrete'],
      [mats.metal, 'metal'], [mats.metalRed, 'metal'],
      [mats.wood, 'wood'], [mats.sandbag, 'wood'],
      [mats.rustMetal, 'metal'], [mats.corrugated, 'metal'],
      [mats.brick, 'concrete'], [mats.plaster, 'concrete'], [mats.dirt, 'concrete'],
    ]);

    // 足音用の材質分け。着弾の分類とは粒度が違う（土と舗装を区別したい）
    this.surfaceOf = new Map([
      [mats.metal, 'metal'], [mats.metalRed, 'metal'],
      [mats.rustMetal, 'metal'], [mats.corrugated, 'metal'],
      [mats.wood, 'wood'], [mats.sandbag, 'dirt'], [mats.dirt, 'dirt'],
    ]);
    this._down = new THREE.Vector3(0, -1, 0);
    this._probe = new THREE.Vector3();
    this._envTimer = 0;
    // 残響測定用のレイ方向。毎回newすると測るたびにゴミが出る
    this._dirs = Array.from({ length: 8 }, () => new THREE.Vector3());

    setLoad(76, '照準を調整中');
    await frame();

    /* -------------------------------------------------- ゲーム構成要素 */
    this.input = new Input(canvas);
    this.audio = new AudioEngine();
    this.hud = new HUD();
    this.effects = new Effects(scene, level.octree);
    // 点スプライトの大きさは実描画画素で決まるので、CSS寸法ではなくバッファ寸法を渡す
    this.effects.setPixelScale(renderer.getDrawingBufferSize(new THREE.Vector2()).y);
    this.player = new Player(camera, level);
    this.weapons = new WeaponSystem(viewScene, camera, viewCamera, scene);
    this.director = new Director(scene, level);
    this.raycaster = new THREE.Raycaster();
    this.raycaster.firstHitOnly = true;

    // 足元の材質で足音を変える。コンテナの上と地面で同じ音が鳴ると一気に嘘くさい
    this.player.onFootstep = (i) => this.audio.footstep(i, this._footSurface());
    this.player.onLand = (i) => this.audio.land(Math.min(1, i * 1.4), this._footSurface());
    this.weapons.onShot = (s) => this._resolveShot(s);
    this.weapons.onEject = (pos, dir) => this.effects.ejectCasing(pos, dir, camera);
    this.effects.onCasingLand = (pos) => this.audio.click(4200, 0.16, 0.05, pos, camera);
    this.director.onEnemyShoot = (...a) => this._enemyShot(...a);
    this.director.onEnemyDeath = (e) => this._onKill(e);
    this.director.onWaveStart = (n, count) => {
      this.hud.banner(`第${n}波`, `敵 ${count}名 接近中`);
      this.audio.click(600, 0.4, 0.4);
    };

    setLoad(92, 'シェーダーを準備中');
    await frame();

    // 初回描画の引っ掛かりを消すため、事前にシェーダーを通しておく
    this.fx = createComposer(renderer, scene, camera, viewScene, viewCamera);
    renderer.compile(scene, camera);
    renderer.compile(viewScene, viewCamera);
    this.fx.composer.render();

    setLoad(100, '準備完了');
    await frame();
    document.getElementById('loading').classList.add('done');

    this._bindUI();
    this._bindMenu();
    this.state = 'menu';
    this._lastTime = performance.now();
    renderer.setAnimationLoop(() => this._loop());
  }

  /* ------------------------------------------------------ 遊び方の選択 */

  _bindMenu() {
    const menu = new NetMenu();
    this.menu = menu;
    menu.onSolo = () => {
      // WebAudioはユーザーの操作を起点にしないと鳴らない。
      // 以前は起動画面のクリックで起こしていたが、ここから直接ロックへ飛ばすと
      // その起動画面が押されないまま隠れて、音が一度も初期化されないまま遊ぶことになる。
      // ボタンを押した流れそのものが操作なので、ここで起こしてよい
      this._wakeAudio();
      this._enterSolo();
      menu.hide();
      // 選んだ直後にロックを取らないと、画面が固まったように見える
      this.input.requestLock();
    };
    menu.onJoin = (opt) => {
      this._wakeAudio();
      this._joinMatch(opt);
    };
    menu.show();
  }

  /* 音を起こす。ブラウザは操作を起点にしないとWebAudioを走らせてくれないので、
     遊び始める経路が増えるたびにここを通す必要がある。
     何度呼んでも害は無いので、迷ったら呼ぶ側に倒す */
  _wakeAudio() {
    this.audio.init();
    this.audio.resume();
  }

  _enterSolo() {
    this.mode = 'solo';
    this.hud.setMode('solo');
    this.director.reset();
    this.effects.clear();
    this._restart();
  }

  async _joinMatch({ url, room, name }) {
    const net = new NetClient();
    try {
      await net.connect(url, { name, room });
    } catch (err) {
      this.menu.setBusy(false);
      // 満員だけは「繋がらない」と原因が違うので、文言を分けて出す
      const msg = /満員|full/i.test(err.message) ? NET_MSG.full : NET_MSG.offline;
      this.menu.setStatus(msg, true);
      return;
    }

    this.net = net;
    this.mode = 'versus';
    this.remotes = new RemotePlayers(this.scene, this.level);

    // 対戦にAIは出さない。1人用で遊んだ後に繋いだ時、敵が残っていると混ざる
    this.director.reset();
    this.effects.clear();
    this.score = 0; this.kills = 0; this.headshots = 0;
    this.shotsFired = 0; this.shotsHit = 0;
    this.damageFlash = 0;
    this.weapons.resetAll();
    this.player.health = this.player.maxHealth;
    this.player.alive = true;
    this._acc = 0;

    net.onEvent = (ev) => this._onNetEvent(ev);
    net.onMatchEnd = (r) => this._onMatchEnd(r);
    net.onDisconnect = (why) => this._onNetLost(why);

    this.hud.setMode('versus');
    this.hud.netStatus('');
    this.menu.setBusy(false);
    this.menu.hide();
    this.input.requestLock();
  }

  _onNetLost(why) {
    if (this.mode !== 'versus') return;
    this.mode = 'solo';
    this.net = null;
    this.remotes?.dispose();
    this.remotes = null;
    this._lastStates = null;
    this._lastFireAt.clear();
    // 試合終了の順位を畳むタイマーが残っていると、1人用に戻った後で最終順位が消えにいく
    clearTimeout(this._endTimer);
    this.hud.setMode('solo');
    this.hud.show(false);
    this.state = 'menu';
    document.exitPointerLock?.();
    this._enterSolo();
    this.menu.show();
    this.menu.setBusy(false);
    this.menu.setStatus(why || NET_MSG.lost, true);
  }

  _onMatchEnd({ rows, why }) {
    this.hud.matchEnd(rows, true, why === 'time' ? '時間切れ' : '規定得点に到達');
    // 次の試合が始まったら畳む。サーバーはINTERMISSION後に0点を配って再開する。
    // 前のタイマーが残っていると、続けて2試合終わった時に早い方が新しい順位を消す
    clearTimeout(this._endTimer);
    this._endTimer = setTimeout(() => {
      if (this.mode === 'versus') this.hud.matchEnd(null, false);
    }, 6000);
  }

  /* ------------------------------------------------------------ UI */

  _bindUI() {
    const overlay = document.getElementById('overlay');
    overlay.addEventListener('click', () => {
      // 遊び方を選ぶ前に起動画面を押してもロックを取らせない。
      // 取ると選択画面の裏でゲームが始まってしまう
      if (this.menu?.isOpen) return;
      this.audio.init();
      this.audio.resume();
      if (this.state === 'dead') this._restart();
      this.input.requestLock();
    });

    this.input.onLockChange((locked) => {
      if (locked) {
        if (this.state === 'menu' || this.state === 'paused') {
          this.state = 'playing';
          this.hud.hideOverlay();
          this.hud.show(true);
          // 対戦の湧きと得点はサーバーが持っている。ここで波を起こすと
          // 対戦の最中にAIの敵が湧いてくる
          if (this.mode === 'solo' && this.director.wave === 0) this.director.betweenWaves = 1.5;
        }
      } else if (this.state === 'playing') {
        this.state = 'paused';
        this._showPause();
      }
    });

    addEventListener('resize', () => this._resize());
  }

  _showPause() {
    this.hud.show(false);
    if (this.mode === 'versus') {
      // 対戦は止まらない。抜けている間も撃たれるということを隠さない
      const me = this.net?.players.get(this.net.id);
      this.hud.overlay(`
        <div class="title">一時停止</div>
        <div class="subtitle">試合は進行中</div>
        <div class="stats">
          撃破 <b>${me?.kills | 0}</b> &nbsp; 戦死 <b>${me?.deaths | 0}</b><br>
          回線 <b>${Math.round(this.net?.ping || 0)}</b>ms
        </div>
        <div class="cta">クリックで復帰</div>
      `);
      return;
    }
    this.hud.overlay(`
      <div class="title">一時停止</div>
      <div class="subtitle">作戦を中断中</div>
      <div class="stats">
        スコア <b>${this.score.toLocaleString('en-US')}</b><br>
        到達 <b>${this.director.wave}</b>波 &nbsp; 撃破 <b>${this.kills}</b>
      </div>
      <div class="cta">クリックで再開</div>
    `);
  }

  _showDeath() {
    this.hud.show(false);
    const acc = this.shotsFired ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    this.hud.overlay(`
      <div class="title">戦死</div>
      <div class="subtitle">作戦失敗</div>
      <div class="stats">
        スコア <b>${this.score.toLocaleString('en-US')}</b><br>
        到達ウェーブ <b>${this.director.wave}</b><br>
        撃破数 <b>${this.kills}</b> &nbsp; ヘッドショット <b>${this.headshots}</b><br>
        命中率 <b>${acc}%</b>
      </div>
      <div class="cta">クリックで再出撃</div>
    `);
  }

  _restart() {
    this.score = 0; this.kills = 0; this.headshots = 0;
    this.shotsFired = 0; this.shotsHit = 0;
    this.damageFlash = 0;
    this.player.health = this.player.maxHealth;
    this.player.alive = true;
    this.player.yaw = 0; this.player.pitch = 0;
    this.player.teleport(this.level.playerSpawn);
    this.weapons.resetAll();
    this.director.reset();
    this.effects.clear();
    this.hud.score(0);
    this.state = 'menu';
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.fx.setSize(w, h);
    this.effects.setPixelScale(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
  }

  /* 太陽の3枚を置き直す。近い2枚はカメラに付いていくので毎フレーム動かす */
  _updateSunCascades() {
    const center = this._sunCenter;
    for (const c of this.cascades) {
      if (c.interval > 1) {
        // 焼き直す番でなければ前に焼いた1枚をそのまま使う。
        // 箱を動かすのも一緒に見送る。動かすと中身と行列が食い違って影がずれる
        if (this._shadowTick % c.interval !== 0) continue;
        c.light.shadow.needsUpdate = true;
      }
      if (!c.follow) continue;
      // ライト空間へ移してテクセルの升目に載せてから戻す。載せずに動かすと、
      // 歩くたびに影の縁がテクセル1個ぶん行き来して沸き立つ
      center.copy(this.camera.position).applyQuaternion(this._sunQuatInv);
      center.x = Math.round(center.x / c.texel) * c.texel;
      center.y = Math.round(center.y / c.texel) * c.texel;
      center.applyQuaternion(this._sunQuat);
      c.light.position.copy(center).addScaledVector(SUN_DIR, c.height);
      c.light.target.position.copy(center);
    }
    this._shadowTick++;
  }

  /* ------------------------------------------------------ 環境の問い合わせ */

  // 足元の材質。足が地面を叩いた瞬間だけ1本レイを撃つので、毎フレームの負荷にはならない
  _footSurface() {
    const p = this.player;
    this._probe.set(p.collider.start.x, p.feetY + 0.35, p.collider.start.z);
    this.raycaster.set(this._probe, this._down);
    this.raycaster.far = 1.4;
    const hits = this.raycaster.intersectObjects(this.solidMeshes, false);
    if (!hits.length) return 'dirt';
    return this.surfaceOf.get(hits[0].object.material) ?? 'asphalt';
  }

  // 周囲の開け具合を測って残響量に反映する。狭い路地と広場で同じ響きだと空間が死ぬ。
  // 8方向は毎回撃つと重いので、呼び出し自体を0.4秒に1回へ間引く
  _updateEnvironment(dt) {
    this._envTimer -= dt;
    if (this._envTimer > 0) return;
    this._envTimer = 0.4;
    const p = this.player;
    this._probe.set(p.collider.start.x, p.feetY + 1.4, p.collider.start.z);
    let sum = 0;
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      this.raycaster.set(this._probe, this._dirs[i].set(Math.cos(a), 0, Math.sin(a)));
      this.raycaster.far = 40;
      const hits = this.raycaster.intersectObjects(this.solidMeshes, false);
      sum += hits.length ? hits[0].distance : 40;
    }
    this.audio.setEnvironment(clamp(sum / N / 30, 0, 1));
  }

  /* -------------------------------------------------------- 射撃解決 */

  _resolveShot(shot) {
    if (this.mode === 'versus') return this._resolveShotVersus(shot);
    const { origin, dir, muzzle, def, pellet } = shot;
    if (pellet === 0) this.shotsFired++;

    this.raycaster.set(origin, dir);
    this.raycaster.far = def.range;
    const worldHits = this.raycaster.intersectObjects(this.solidMeshes, false);
    const worldHit = worldHits.length ? worldHits[0] : null;

    // 敵は専用の球/カプセルで判定する
    let enemyHit = null;
    for (const e of this.director.active) {
      if (!e.alive) continue;
      const h = e.intersect(origin, dir);
      if (h && h.distance <= def.range && (!enemyHit || h.distance < enemyHit.distance)) enemyHit = h;
    }

    const drawTracer = pellet % 3 === 0;

    if (enemyHit && (!worldHit || enemyHit.distance < worldHit.distance)) {
      const d = enemyHit.distance;
      const t = clamp((d - def.falloffStart) / (def.falloffEnd - def.falloffStart), 0, 1);
      let dmg = def.damage * THREE.MathUtils.lerp(1, def.falloffMin, t);
      const head = enemyHit.part === 'head';
      if (head) dmg *= def.headMult;
      else if (enemyHit.part === 'legs') dmg *= 0.82;

      const killed = enemyHit.enemy.hit(dmg, enemyHit.part);
      if (pellet === 0) this.shotsHit++;

      this.effects.impact(enemyHit.point, dir.clone().negate(), 'flesh');
      this.hud.hitmarker(head);
      this.audio.hitmarker(head);
      if (killed) {
        enemyHit.enemy._killHeadshot = head;
        this.audio.death(enemyHit.point, this.camera);
      }
      if (drawTracer) this.effects.tracer(muzzle, enemyHit.point, 0.03);
    } else if (worldHit) {
      const normal = worldHit.face
        ? worldHit.face.normal.clone().transformDirection(worldHit.object.matrixWorld)
        : dir.clone().negate();
      const kind = this.kindOf.get(worldHit.object.material) ?? 'concrete';
      this.effects.impact(worldHit.point, normal, kind);
      this.audio.impact(kind, worldHit.point, this.camera);
      if (drawTracer) this.effects.tracer(muzzle, worldHit.point, 0.03);
    } else if (drawTracer) {
      const far = origin.clone().addScaledVector(dir, def.range);
      this.effects.tracer(muzzle, far, 0.025);
    }
  }

  /* 対戦では当たったかどうかをサーバーが決める。ここでやるのは見た目だけ。
     ただし「自分の弾がどこへ飛んだか」は往復を待たずに出さないと、
     撃った手応えが遅れて別のゲームになる。だから壁への着弾は手元で描いて、
     サーバーから返る自分ぶんのIMPACTは捨てる（二重に火花が出る） */
  _resolveShotVersus(shot) {
    const { origin, dir, muzzle, def, pellet } = shot;
    if (pellet === 0) this.shotsFired++;

    this.net.sendShot(origin, dir);

    const drawTracer = pellet % 3 === 0;
    this.raycaster.set(origin, dir);
    this.raycaster.far = def.range;
    const hits = this.raycaster.intersectObjects(this.solidMeshes, false);
    const wallDist = hits.length ? hits[0].distance : Infinity;

    // 相手に当たったかは手元でも粗く見る。当たっていれば壁の火花を出さない。
    // ここで出す判定はあくまで絵の切り替え用で、ダメージには一切使わない
    const bodyDist = this._nearestRemoteHit(origin, dir, Math.min(wallDist, def.range));

    if (bodyDist < wallDist) {
      if (drawTracer) {
        this.effects.tracer(muzzle, this._evPos.copy(origin).addScaledVector(dir, bodyDist), 0.03);
      }
      return;
    }
    if (hits.length) {
      const h = hits[0];
      const normal = h.face
        ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
        : dir.clone().negate();
      const kind = this.kindOf.get(h.object.material) ?? 'concrete';
      this.effects.impact(h.point, normal, kind);
      this.audio.impact(kind, h.point, this.camera);
      if (drawTracer) this.effects.tracer(muzzle, h.point, 0.03);
    } else if (drawTracer) {
      this.effects.tracer(muzzle, origin.clone().addScaledVector(dir, def.range), 0.025);
    }
  }

  /* 他プレイヤーを1本の太いカプセルで見る雑な判定。部位は要らないので、
     胴も頭も足もまとめて包む半径で足りる */
  _nearestRemoteHit(origin, dir, maxDist) {
    if (!this.remotes || !this.net) return Infinity;
    let best = Infinity;
    for (const st of this._lastStates || []) {
      if (st.state & S.DEAD) continue;
      const r = this.remotes.get(st.id);
      if (!r) continue;
      // 足元から頭までの線分と弾道の最近接点を出す
      const bx = st.x, bz = st.z;
      const by0 = st.y + 0.3, by1 = st.y + ((st.state & S.CROUCH) ? 0.95 : 1.6);
      this._toRemote.set(bx - origin.x, 0, bz - origin.z);
      const along = this._toRemote.x * dir.x + this._toRemote.z * dir.z;
      if (along <= 0.4 || along > maxDist) continue;
      const px = origin.x + dir.x * along, py = origin.y + dir.y * along, pz = origin.z + dir.z * along;
      if (py < by0 - 0.4 || py > by1 + 0.4) continue;
      const d = Math.hypot(px - bx, pz - bz);
      if (d < 0.45 && along < best) best = along;
    }
    return best;
  }

  _enemyShot(enemy, muzzle, dir, damage, dist) {
    this.effects.muzzle(muzzle, dir);
    this.audio.gunshot(
      { volume: 0.34, bodyFreq: 560, crackFreq: 3200, bodyDecay: 0.12, tailDecay: 0.4 },
      muzzle, this.camera,
    );

    const player = this.player;
    const playerEye = new THREE.Vector3(
      player.collider.start.x,
      player.feetY + player.height - 0.16,
      player.collider.start.z,
    );
    const toPlayer = playerEye.distanceTo(muzzle);

    // 壁越しに当たらないよう、必ず遮蔽を確認する
    this.raycaster.set(muzzle, dir);
    this.raycaster.far = Math.max(toPlayer + 4, 8);
    const hits = this.raycaster.intersectObjects(this.solidMeshes, false);
    const blocked = hits.length && hits[0].distance < toPlayer - 0.4;

    this.effects.tracer(muzzle, muzzle.clone().addScaledVector(dir, Math.min(toPlayer + 6, 60)), 0.028, 0xffb066);

    if (blocked) {
      const h = hits[0];
      const normal = h.face
        ? h.face.normal.clone().transformDirection(h.object.matrixWorld)
        : dir.clone().negate();
      const kind = this.kindOf.get(h.object.material) ?? 'concrete';
      this.effects.impact(h.point, normal, kind);
      this.audio.impact(kind, h.point, this.camera);
      return;
    }

    if (damage > 0 && player.alive) {
      player.damage(damage);
      this.audio.hurt();
      // 撃たれ続けると赤で埋まって何も見えなくなるので、上限を低めに抑える
      this.damageFlash = Math.min(0.55, this.damageFlash + 0.22);

      // どこから撃たれたかを画面のリングで示す
      const yaw = player.yaw;
      const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
      const rx = Math.cos(yaw), rz = -Math.sin(yaw);
      let dx = enemy.collider.start.x - player.collider.start.x;
      let dz = enemy.collider.start.z - player.collider.start.z;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len; dz /= len;
      this.hud.damageFrom(Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz));

      // 被弾で視点が少し跳ねる
      player.addRecoil(0.014 + Math.random() * 0.012, (Math.random() - 0.5) * 0.02);

      if (!player.alive) {
        this.state = 'dead';
        document.exitPointerLock?.();
        setTimeout(() => this._showDeath(), 700);
      }
    } else {
      // 外れ弾が耳元を掠める音。これが無いと「撃たれている怖さ」が出ない。
      // 弾道への垂線距離を出して、近い時だけ鳴らす
      this._probe.subVectors(playerEye, muzzle);
      const along = this._probe.dot(dir);
      if (along > 0) {
        const perp = Math.sqrt(Math.max(0, this._probe.lengthSq() - along * along));
        // 通り過ぎた後ではなく、プレイヤーの手前で止まった弾では鳴らさない
        if (perp < 3.2 && along < toPlayer + 6) this.audio.whizBy(perp);
      }

      // 外れ弾も周囲に着弾させる（掠める感じが出る）
      this.raycaster.set(muzzle, dir);
      this.raycaster.far = 80;
      const mh = this.raycaster.intersectObjects(this.solidMeshes, false);
      if (mh.length) {
        const normal = mh[0].face
          ? mh[0].face.normal.clone().transformDirection(mh[0].object.matrixWorld)
          : dir.clone().negate();
        const kind = this.kindOf.get(mh[0].object.material) ?? 'concrete';
        this.effects.impact(mh[0].point, normal, kind);
        if (mh[0].distance < 26) this.audio.impact(kind, mh[0].point, this.camera);
      }
    }
  }

  _onKill(enemy) {
    this.kills++;
    // 倒れた場所に血だまりを残す。死体が消えた後も戦闘の痕跡が残る
    this.effects.bloodPool(enemy.collider.start);
    const head = enemy._killHeadshot;
    if (head) this.headshots++;
    const bonus = head ? 250 : 100;
    this.score += bonus;
    this.hud.score(this.score);
    this.hud.kill(head ? '敵兵を排除 — ヘッドショット' : '敵兵を排除', head);
    enemy._killHeadshot = false;
  }

  /* -------------------------------------------------- 対戦の出来事 */

  /* 電文の座標をVector3へ移す。1つでも数でなければ受け取らない。
     NaNをcolliderへ入れると当たり判定ごと壊れて、以後どこへも進めなくなる */
  _vecOf(out, a) {
    if (!Array.isArray(a) || a.length < 3) return null;
    const x = +a[0], y = +a[1], z = +a[2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
    return out.set(x, y, z);
  }

  _onNetEvent(ev) {
    const net = this.net;
    if (!net || !ev) return;
    const me = net.id;

    switch (ev.e) {
      case EV.FIRE: {
        // 自分の銃声は武器側が鳴らしている。ここで鳴らすと二重になる
        if (ev.id === me) break;
        const r = this.remotes?.get(ev.id);
        if (!r) break;
        // ショットガンは1回の引き金で散弾の数だけ別々に発射の電文が飛ぶ。
        // 素直に鳴らすと他人の1発で銃声が9重になる。
        // 同じ人の発射は短い間隔でまとめる（一番速いSMGでも63msに1発なので、
        // ここを30msにしておけば正当な連射は1発も潰さない）
        const t = performance.now();
        if (t - (this._lastFireAt.get(ev.id) || 0) < 30) break;
        this._lastFireAt.set(ev.id, t);
        this.audio.gunshot(
          { volume: 0.34, bodyFreq: 560, crackFreq: 3200, bodyDecay: 0.12, tailDecay: 0.4 },
          r.headPos, this.camera,
        );
        break;
      }

      case EV.HIT: {
        if (ev.by === me) {
          this.shotsHit++;
          const head = ev.part === PART.HEAD;
          this.hud.hitmarker(head);
          this.audio.hitmarker(head);
          if (this._vecOf(this._evPos, ev.p)) {
            this._evNormal.subVectors(this.camera.position, this._evPos).normalize();
            this.effects.impact(this._evPos, this._evNormal, 'flesh');
          }
        }
        if (ev.id === me && ev.dmg > 0) {
          this.audio.hurt();
          this.damageFlash = Math.min(0.55, this.damageFlash + 0.22);
          this.player.addRecoil(0.012 + Math.random() * 0.010, (Math.random() - 0.5) * 0.018);
          this._damageArrow(ev.by);
        }
        break;
      }

      case EV.KILL: {
        const head = !!ev.head;
        this.hud.killVersus(net.nameOf(ev.by), net.nameOf(ev.id), head, ev.by === me, ev.id === me);
        if (ev.by === me && ev.id !== me) {
          this.kills++;
          if (head) this.headshots++;
          this.audio.death(this.remotes?.get(ev.id)?.headPos ?? this.camera.position, this.camera);
        }
        if (ev.id === me) {
          this.hud.banner('戦死', `${net.nameOf(ev.by)}に倒された`, 2.0);
        }
        break;
      }

      case EV.SPAWN: {
        if (ev.id !== me || !this._vecOf(this._evPos, ev.p)) break;
        // サーバーが決めた地点へ自分で飛ぶ。補正任せにすると、
        // 死んだ場所から新しい湧き地点まで数十m滑っていく絵になる
        this.player.teleport(this._evPos);
        this.player.yaw = Number.isFinite(ev.yaw) ? ev.yaw : 0;
        this.player.pitch = 0;
        this.player.alive = true;
        this.player.health = this.player.maxHealth;
        this.weapons.resetAll();
        this.damageFlash = 0;
        this.net.resetPrediction?.();
        break;
      }

      case EV.JOIN:
        if (ev.id !== me) this.hud.kill(`${ev.name || `プレイヤー${ev.id}`}が参加`, false);
        break;

      case EV.LEAVE:
        this.hud.kill(`${net.nameOf(ev.id)}が退出`, false);
        this.remotes?.remove(ev.id);
        this._lastFireAt.delete(ev.id);
        break;

      case EV.IMPACT: {
        // 自分の弾は撃った瞬間に手元で描いてある
        if (ev.by === me || !this._vecOf(this._evPos, ev.p)) break;
        if (!this._vecOf(this._evNormal, ev.n)) this._evNormal.set(0, 1, 0);
        this.effects.impact(this._evPos, this._evNormal, ev.k || 'concrete');
        if (this._evPos.distanceTo(this.camera.position) < 26) {
          this.audio.impact(ev.k || 'concrete', this._evPos, this.camera);
        }
        break;
      }

      default: break;
    }
  }

  // 撃たれた方向を画面のリングで示す。相手が見えていなくても向きだけは出す
  _damageArrow(byId) {
    const r = this.remotes?.get(byId);
    if (!r) return;
    const yaw = this.player.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    let dx = r.headPos.x - this.player.collider.start.x;
    let dz = r.headPos.z - this.player.collider.start.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    this.hud.damageFrom(Math.atan2(dx * rx + dz * rz, dx * fx + dz * fz));
  }

  /* 相手の頭の上に名前を出す。壁の向こうは出さない。
     Octreeへ1本ずつレイを通すので、8人でも毎フレーム7本で済む */
  _updatePlates(states) {
    const cam = this.camera;
    const list = this._plates;
    list.length = 0;
    for (const st of states) {
      if (st.state & S.DEAD) continue;
      const r = this.remotes?.get(st.id);
      if (!r) continue;
      this._toRemote.subVectors(r.headPos, cam.position);
      const dist = this._toRemote.length();
      if (dist < 0.5 || dist > 90) continue;
      this._toRemote.divideScalar(dist);
      this._ray.set(cam.position, this._toRemote);
      const hit = this.level.octree.rayIntersect(this._ray);
      if (hit && hit.distance < dist - 0.45) continue;

      this._plateV.copy(r.headPos).project(cam);
      if (this._plateV.z > 1) continue;
      list.push({
        id: st.id,
        x: (this._plateV.x * 0.5 + 0.5) * innerWidth,
        y: (-this._plateV.y * 0.5 + 0.5) * innerHeight,
        name: this.net.nameOf(st.id),
        hp: st.hp,
        dist,
      });
    }
    this.hud.nameplates(list);
  }

  /* 対戦の1フレーム。物理だけ60Hz固定で回す。
     可変dtのまま送ると、同じキーを同じ長さ押してもサーバーと到達位置が食い違う */
  _versusFrame(dt) {
    const input = this.input;
    const net = this.net;
    const player = this.player;

    // 視点はフレーム単位で取る。マウスの移動量はフレームごとにしか届かないので、
    // 固定刻みのループの中でtakeLook()を呼ぶと2刻み目以降が必ず0になり、
    // 手元の向きと送る向きが刻みごとにずれる。
    // ここで先に向きを決めてから送るので、サーバーは同じ向きで同じ移動を再現できる
    const look = input.takeLook();
    if (player.alive) {
      const scale = 1 - player.adsFactor * 0.45;
      player.yaw += look.yaw * scale;
      player.pitch = clamp(player.pitch + look.pitch * scale, -1.5, 1.5);
    }

    let bits = 0;
    if (player.alive) {
      for (const [code, bit] of KEY_CODES) if (input.down(code)) bits |= bit;
      if (input.buttons[0]) bits |= K.FIRE;
      if (input.buttons[2]) bits |= K.ADS;
    }

    this._acc += dt;
    // 溜まりすぎたら捨てる。タブから戻った時に数百刻みを一気に流すと、
    // サーバーの受け皿が溢れて入力に穴が空き、その人だけ動けなくなる
    if (this._acc > TICK_DT * 6) this._acc = TICK_DT * 6;
    while (this._acc >= TICK_DT) {
      this._acc -= TICK_DT;
      net.sendInput(bits, player.yaw, player.pitch);
      player.update(TICK_DT, input, false);
      net.correction(player, TICK_DT);
    }

    // 体力と生死はサーバーが持っている。手元では表示に写すだけ
    const me = net.self();
    if (me) {
      player.health = me.hp;
      const dead = !!(me.state & S.DEAD);
      if (dead !== !player.alive) player.alive = !dead;
    }

    const wInput = player.alive ? input : this._noInput;
    this.weapons.update(dt, wInput, player, { audio: this.audio, effects: this.effects });
    // 描く直前にここで姿勢を決め直す。2つ理由がある。
    // 1つは反動で、積むのはweapons側の発砲処理なのに姿勢が決まるのは
    // player.updateの末尾なので、そのままだと撃ったフレームの反動が
    // カメラに乗るのは次のフレームになる（詳しくは_loopの同じ場所）。
    // もう1つは120Hzの画面で、刻みが回らないフレームが半分出るため、
    // updateの中でしか姿勢を入れないと回さなかったフレームは視点が固まる
    player._applyCamera();

    const states = net.stateAt();
    this._lastStates = states;
    this.remotes.sync(states, net.id, this.camera.position);
    this._updatePlates(states);

    this.effects.update(dt, this.camera);
    this._commonHud(dt);
    this.hud.matchInfo(me ? (net.players.get(net.id)?.kills | 0) : 0, MATCH.SCORE_LIMIT, net.timeLeft);
    this.hud.scoreboard(net.scoreRows(), input.down('Tab'));
    this.hud.netStatus(net.ping > 220 ? `回線が不安定です (${Math.round(net.ping)}ms)` : '');
    input.endFrame();
  }

  /* 1人用と対戦で共通の表示。視野・クロスヘア・体力・弾数 */
  _commonHud(dt) {
    const sprintT = this.player.sprinting ? 1 : 0;
    this._fovBlend = THREE.MathUtils.damp(this._fovBlend ?? 0, sprintT, 6, dt);
    const targetFov = THREE.MathUtils.lerp(75, 84, this._fovBlend)
      - this.weapons.adsFactor * (75 - this.weapons.def.adsFov);
    if (Math.abs(this.camera.fov - targetFov) > 0.02) {
      this.camera.fov = targetFov;
      this.camera.updateProjectionMatrix();
    }
    this.hud.sprinting(this.player.sprinting);

    const spread = this.weapons._currentSpread(this.player);
    const px = Math.tan(spread) / Math.tan((this.camera.fov * Math.PI) / 360) * (innerHeight / 2);
    this.hud.crosshair(clamp(px, 2, 190), this.weapons.adsFactor > 0.8);

    const w = this.weapons.current;
    this.hud.health(this.player.health, this.player.maxHealth);
    this.hud.ammo(w.ammo, w.reserve, w.def.name, this.weapons.index, this.weapons.reloading);
    this.hud.update(dt);
  }

  /* ------------------------------------------------------- ループ */

  _loop() {
    const now = performance.now();
    let dt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    // タブ復帰などで巨大なdtが来ると物理が破綻するので頭を押さえる
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;

    const playing = this.state === 'playing';

    if (playing) {
      const input = this.input;

      // 対戦では倒れている間の操作を受け付けない。復帰待ちの3秒に装填や持ち替えを
      // 通すと、湧いた瞬間の弾数がサーバーと食い違う
      const canAct = this.mode !== 'versus' || this.player.alive;
      if (canAct && input.pressed('KeyR')) {
        if (this.weapons.reload()) this.audio.reload(this.weapons.def.reloadTime);
      }
      for (let i = 0; canAct && i < 3; i++) {
        if (!input.pressed(`Digit${i + 1}`)) continue;
        if (this.weapons.switchTo(i) && this.mode === 'versus') this.net?.sendWeapon(i);
      }

      if (this.mode === 'versus') {
        this._versusFrame(dt);
      } else {
        this.player.update(dt, input, true);
        this.weapons.update(dt, input, this.player, {
          audio: this.audio, effects: this.effects,
        });
        // 反動を積むのはweapons側の発砲処理だが、カメラの姿勢が決まるのは
        // player.updateの末尾なので、そのままだと撃ったフレームの反動が
        // カメラに乗るのは次のフレームになる。銃はkickZ/kickPitchで同じ
        // フレームに跳ねるため、銃だけ動いて世界が止まる→次は世界だけ動く、
        // と2つが別のフレームで飛んで跳ねが読めなくなる。
        // 両方のupdateが終わってから姿勢を決め直して1フレームに揃える。
        // weapons側が書き込むplayer.adsFactorの遅れも同時に消える
        this.player._applyCamera();
        this.director.update(dt, this.player, {});
        this.effects.update(dt, this.camera);

        // 走ると視野を少し広げる。速度感が出る
        this._commonHud(dt);
        this.hud.wave(Math.max(1, this.director.wave), this.director.aliveCount + this.director.pendingSpawns);
        input.endFrame();
      }
    } else {
      this.effects.update(dt, this.camera);
      this.hud.update(dt);
      this.input.takeLook();
      this.input.endFrame();
    }

    // 空はカメラに追従させる（遠景として固定して見せる）
    this.sky.position.copy(this.camera.position);

    // 武器の主光源をワールドの太陽に合わせ直す。カメラ空間へ引き戻すことで、
    // 太陽の方を向けば銃も逆光になり、背にすれば順光になる
    // 太陽を完全に追従させると、プレイヤーが太陽に背を向けた瞬間にキーが
    // 銃の裏へ回り、下限が無いので機関部が真っ黒(14,15,26)に落ちる。
    // カメラ空間の定位置キーへ半分寄せて下限を作る。物理的には嘘だが、
    // AAAのビューモデルは必ずこの嘘をつく側（銃が読めないほうが問題）
    this._invQ.copy(this.camera.quaternion).invert();
    this.vSun.position.copy(SUN_DIR).applyQuaternion(this._invQ)
      .normalize().lerp(VIEW_KEY_FIXED, 0.55).normalize();

    // 被弾の赤みと体力低下の常時ビネット
    this.damageFlash = Math.max(0, this.damageFlash - dt * 2.4);
    const lowHp = this.player.alive
      ? clamp(1 - this.player.health / (this.player.maxHealth * 0.45), 0, 1) * 0.45
      : 0.6;
    this.fx.grade.uniforms.uDamage.value = Math.min(1, this.damageFlash + lowHp);
    this.fx.grade.uniforms.uTime.value += dt;
    // 覗いている量。ADS中だけ浅い被写界深度を掛けるのに使う
    this.fx.grade.uniforms.uAds.value = this.weapons.adsFactor;

    // 体力を音側へ渡す。低体力の心音と呼吸が鳴る
    this.audio.setVitals(this.player.health / this.player.maxHealth, this.player.alive);
    this._updateEnvironment(dt);

    // 影の箱はカメラの位置が決まった後でないと置けない
    this._updateSunCascades();

    this.fx.composer.render();
  }
}

const game = new Game();
window.__game = game;   // 動作確認用の口
game.boot().catch((err) => {
  console.error(err);
  document.getElementById('loadMsg').textContent = 'FAILED — ' + err.message;
});
