// 全部を繋ぐ本体。読み込み → 生成 → ゲームループ。
import * as THREE from 'three';
import { buildMaterials, createSky, skyFogColor, installAerialPerspective } from './world/textures.js';
import { currentTimeOfDay } from './world/sun.js';
import { buildLevel } from './world/level.js';
import { Effects } from './world/effects.js';
import { Input } from './core/input.js';
import { AudioEngine } from './core/audio.js';
import { createComposer } from './core/postfx.js';
import { DEATH_FALL_S, startLook, turnLook, applyDeath } from './core/deathcam.js';
import { Capsule } from 'three/addons/math/Capsule.js';
import { Player } from './player/player.js';
import { WeaponSystem } from './player/weapons.js';
import { Director } from './ai/enemy.js';
import { HUD } from './ui/hud.js';
import { NetMenu, NET_MSG } from './ui/netmenu.js';
import { SettingsMenu } from './ui/settings.js';
import { StatsMenu } from './ui/statsmenu.js';
import { VoiceChat, PTT_CODE } from './net/voice.js';
import { emptyTally, mergeTally, loadStats, saveStats, newlyUnlocked } from './core/stats.js';
import { Lobby } from './ui/lobby.js';
import { Chat } from './ui/chat.js';
import { Diag } from './ui/diag.js';
import { PerfMeter } from './ui/perfmeter.js';
import { CharView } from './ui/charview.js';
import { NetClient } from './net/client.js';
import { RemotePlayers } from './net/remote.js';
import { preloadCharModel, SOLO_MODEL } from './ai/glbchar.js';
import { FarShadowGate } from './world/shadowgate.js';
import {
  K, KEY_CODES, S, EV, PART, MATCH, PHASE, TICK_DT, ZONE, NADE, HEAL, outsideZone, CHARACTERS,
  TEAM_NAMES,
} from './net/protocol.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/* 回線が切れた時に、自分で入り直しにいく間隔（ミリ秒）。
   短い所から始めて伸ばすのは、切れ方が2種類あるため。
   電車のトンネルなら数秒で戻るが、サーバーの入れ替えは十数秒かかる。
   合計19秒で、サーバーが記録を取っておく60秒（MATCH.REJOIN_S）に収まっている */
const REJOIN_WAITS = [1000, 2000, 3000, 5000, 8000];

/* 重さを測るのに覚えておく枚数。60fpsで33秒ぶん。
   全部覚えると長く遊ぶほど記憶を食い続けるし、古い所まで混ぜると
   「今どうだったか」が薄まる */
const FRAME_SAMPLES = 2000;

/* 描画命令(draw call)と三角形の数を覚えておく枚数。毎秒1回しか取らないので40秒ぶん。
   フレーム時間と違って毎フレーム取らないのは、この2つは1秒の中では
   ほとんど動かない数字だから（敵の数と画面に入っている物で決まる） */
const PERF_INFO_SAMPLES = 40;

/* 地図を塗り直す回数（毎秒）。**他人の位置が届くのと同じ速さ。**
   これより速く塗っても、他人の点は1つも動かない */
const MAP_HZ = 20;

// 倒れてから結果が出るまで。ここが短いと、撃たれた次の瞬間に文字が出て
// 倒れ切るまでの秒数（1.3秒）は src/core/deathcam.js が持つ。
// 何が起きたのかを見る時間が無いと短すぎ、長いと待たされる。1.3秒は
// 「崩れ落ちて地面に転がるのを見終わる」あたり

// 自己ベスト。localStorageは設定次第で読み書きどちらも例外を投げるので、
// 覚えられないだけで遊べなくなることのないよう握り潰す（netmenu.jsと同じ作法）
// 選んだ見た目。覚えておかないと、入るたびに選び直すことになる
const CHAR_KEY = 'blackout.char';
function loadChar() {
  try { return Math.max(0, Math.min(CHARACTERS.length - 1, (localStorage.getItem(CHAR_KEY) | 0))); } catch { return 0; }
}
function saveChar(i) {
  try { localStorage.setItem(CHAR_KEY, String(i | 0)); } catch { /* 覚えられないだけ */ }
}

/* 自己ベストは src/core/stats.js の bestScore / bestWave が持つようになった。
   ここに blackout.best を別で持っていた頃は、同じ「一番良かった回」が2箇所にあり、
   死亡画面と戦績の画面で違う数字が出うる形だった。
   前に遊んだ人の記録は stats.js の読み込みが引き取る */
const frame = () => new Promise((r) => requestAnimationFrame(() => r()));

// 太陽の向き。ここが画の出来をほぼ決める。
// 以前は仰角43度でスポーン視線の真後ろから当たる完全な順光だったので、
// 物の落ち影が全部その物の裏に隠れて画面に一つも出ていなかった。
// 低い高度(約27度)で、視線に対して斜め前左から当てる。これで
//   ・影が手前に長く伸びて画面内に入る
//   ・面ごとに明暗差がついて立体が起きる
//   ・輪郭に逆光気味の縁が出る
// の3つが同時に効く。夕方寄りの空の色ともこの高度が合う。
// 遊びに来た時刻でどの時間帯かが決まる（src/world/sun.js）。
// **起動時に1回だけ決める。** 空も影も焼き上げは起動時の1回きりなので、
// 途中で変えるとそこを作り直す話になる
const TOD = currentTimeOfDay();
const SUN_DIR = new THREE.Vector3(...TOD.dir).normalize();
// フォグの向き依存もここで決めた太陽の向きに合わせる。材質のコンパイルより
// 前ならいつでもよいので、SUN_DIRが決まった直後のここでやる
// （以前はtextures.js側が別に持つ固定値のままで、朝・昼に遊んでも
// 霧の暖色側が夕方の方角を向いたままだった）
installAerialPerspective(SUN_DIR);

// 1人プレイの敵の見た目に使う外部モデル(試験)を、起動した時点で読み始める。
// 敵が湧く時にまだ届いていなければコード製で出て、届いた波から切り替わる
preloadCharModel(SOLO_MODEL);

// ビューモデルのキーライトが必ず確保する向き（カメラ空間・右上手前）。
// 太陽追従だけにすると背を向けた時に銃が真っ黒になるので、これへ寄せて下限を作る
const VIEW_KEY_FIXED = new THREE.Vector3(0.45, 0.72, 0.52).normalize();

/* -------------------------------------------------------------- 描画倍率 */

// 1フレームで塗る画素数の上限。
//
// 以前はdevicePixelRatioを2で頭打ちにするだけだったが、これは窓の大きさを見ていない。
// 4Kディスプレイを「1920x1080に見える」設定で使っていると、CSS上は1920x1080でも
// 倍率2倍で3840x2160＝830万画素を毎フレーム塗ることになる。
// この後のポストエフェクト（AO合成・ブルーム・グレード・FXAA・仕上げ）は
// どれも画面全体を舐めるので、その面積が5〜6回ぶん効いてくる。
// M1では間に合わずコマ落ちする。
//
// 210万画素（1920x1080相当）で頭打ちにする。窓が小さいうちは今まで通り2倍のまま
// 描けるので、小窓でぼやけることはない
const MAX_DRAW_PIXELS = 2.1e6;

// CSS寸法から実際の描画倍率を出す。上限は今まで通り2倍、下限は0.75。
// 下限を置くのは、極端に大きい窓で倍率が落ちすぎて照準もHUDも潰れるため
function drawScale(w, h) {
  const want = Math.min(devicePixelRatio, 2);
  const fit = Math.sqrt(MAX_DRAW_PIXELS / Math.max(1, w * h));
  return clamp(Math.min(want, fit), 0.75, want);
}

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

// 影マップの横。縦は下のSHADOW_MAP_MINOR。
// 2048から1536へ落とす。影マップは下のCASCADESの枚数だけ毎フレーム焼き直すので、
// ここの面積はそのまま枚数倍で効く。1536でも一番細かい枚のテクセルは1.8cmで、
// 半影のカーネル上限（20テクセル）が36cmぶん取れるから縁のぼけ方は変わらない
const SHADOW_MAP_SIZE = 1536;

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

// 太陽の影を距離で分割した2枚。radiusは箱の半径(m)。
// followはカメラに付いていくか、intervalは何フレームに1回焼き直すか。
// 外の1枚は場全体を固定で覆う。動かさないので縁がちらつかず、
// 中身もほとんど建物なので毎フレーム焼き直す必要がない。
//
// 以前は12m/30m/90mの3枚で、うち2枚が毎フレーム焼き直しだった。
// 影マップを1枚焼くのは「シーンの物を全部もう一度描く」ことなので、
// 本番の描画と合わせるとシーンを毎フレーム3回描いていたことになる。
// 近い1枚を12→16mへ広げて中間の枚を畳み、毎フレーム描くのを2回に減らす。
// 外の枚は場内(±42m)を覆えば足りるので90→56mまで詰める。
// 90mは場外の遠景ビルまで入れていた設定だが、あれは影を落とさない層なので要らなかった
const CASCADES = [
  { radius: 16, follow: true, interval: 1 },
  { radius: 56, follow: false, interval: 3 },
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

/* ---------------------------------------------------------- ミニマップ */

// ミニマップの下敷きが覆うワールドの半径(m)。場内はbounds=40なので、
// 外周の壁まで入る44mで焼いておく。対戦は描く時に中央だけを切り出して使う
const MAP_EXTENT = 44;
// 焼く解像度。168pxの枠へ最大でも2倍で貼るので、これ以上は見えない
const MAP_PIXELS = 512;

// 撃った人の点が消えるまでの秒数。銃声が聞こえている間だけ残る長さにする。
// 長くすると常時レーダーに近づいて、待ち伏せも回り込みも成立しなくなる
const BLIP_FADE_S = 2.2;

// 投げる時に前方へ足す上向き成分。真っ直ぐ投げると足元へ落ちて自爆する
const NADE_LOFT = 0.34;
const _throwOrigin = new THREE.Vector3();
const _throwDir = new THREE.Vector3();

// 投げる先の弧を何点で描くか。0.045秒刻みなので40点で約1.8秒ぶん
const ARC_STEPS = 40;
const _arcPos = new THREE.Vector3();
const _arcVel = new THREE.Vector3();
const _arcPrev = new THREE.Vector3();
const _arcStep = new THREE.Vector3();

/**
 * 地形を真上から1枚だけ焼いて、2Dキャンバスとして返す。
 *
 * 起動時に1回だけ走る。地形は動かないので、毎フレーム上から描き直す理由が無い
 * （それをやると軽量化したぶんを自分で食い潰す）。
 *
 * ゲーム本編のシーンをそのまま使わず、真上からの平行投影の専用シーンへ
 * 地形を一時的に移して焼く。本編のシーンには空・フォグ・夕方の斜光が入っていて、
 * そのまま焼くと影が長く伸びて地図として読めない絵になる。
 */
function bakeMinimap(renderer, level, environment) {
  const cam = new THREE.OrthographicCamera(
    -MAP_EXTENT, MAP_EXTENT, MAP_EXTENT, -MAP_EXTENT, 0.1, 400,
  );
  cam.position.set(0, 200, 0);
  // 真下を向く時、upが(0,1,0)のままだと向きが定まらない。
  // (0,0,-1)にすると画面の右が+X・下が+Zになる（hud.js側の変換はこれ前提）
  cam.up.set(0, 0, -1);
  cam.lookAt(0, 0, 0);

  const flat = new THREE.Scene();
  flat.background = new THREE.Color(0x0b0e13);
  // 真上からの平坦な照明。影を作らないので地形の形だけが出る
  flat.add(new THREE.AmbientLight(0xffffff, 1.15));
  const top = new THREE.DirectionalLight(0xffffff, 1.05);
  top.position.set(0.25, 1, 0.35);
  flat.add(top);
  // 環境光を外すと金属が真っ黒に沈んで、コンテナや波板の棟が地図から消える
  flat.environment = environment;
  flat.environmentIntensity = 0.7;

  const rt = new THREE.WebGLRenderTarget(MAP_PIXELS, MAP_PIXELS);
  rt.texture.colorSpace = THREE.SRGBColorSpace;

  // 地形を借りる。addは親から外して付け替えるので、焼き終わったら必ず戻す
  const home = level.root.parent;
  flat.add(level.root);

  const prevTarget = renderer.getRenderTarget();
  const prevShadow = renderer.shadowMap.autoUpdate;
  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(rt);
  renderer.clear();
  renderer.render(flat, cam);
  renderer.setRenderTarget(prevTarget);
  renderer.shadowMap.autoUpdate = prevShadow;

  const buf = new Uint8Array(MAP_PIXELS * MAP_PIXELS * 4);
  renderer.readRenderTargetPixels(rt, 0, 0, MAP_PIXELS, MAP_PIXELS, buf);

  if (home) home.add(level.root);
  rt.dispose();

  // WebGLは左下が原点、キャンバスは左上が原点なので行を逆に積む
  const canvas = document.createElement('canvas');
  canvas.width = MAP_PIXELS;
  canvas.height = MAP_PIXELS;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(MAP_PIXELS, MAP_PIXELS);
  const row = MAP_PIXELS * 4;
  for (let y = 0; y < MAP_PIXELS; y++) {
    img.data.set(buf.subarray((MAP_PIXELS - 1 - y) * row, (MAP_PIXELS - y) * row), y * row);
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
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

    /* ------------------------------------------------------ 通算の戦績 */
    // 端末に覚えている通算と、まだ書いていない今回ぶんを分けて持つ。
    //
    // **1発撃つたびに localStorage へ書かない。** 撃ち合いの最中は毎秒40発を超えるので、
    // そのたびに文字列へ直して書き出すと、遊んでいる最中に引っかかる。
    // 手元で数えておいて、区切り（倒れた時・試合が終わった時・ホームへ戻る時）で流し込む。
    //
    // 実績の判定は書き込みと切り離してある。判定はただの足し算なので、
    // 倒した瞬間にその場でやってよい（そうしないと「初撃破」が
    // 死ぬまで出てこない）
    this.stats = loadStats();
    this.session = emptyTally();
    this.streak = 0;
    // 最後に実績を数えた時の記録。ここが無いと、起動のたびに
    // 解除済みの実績が全部もう一度知らせに来る
    this._seen = this.stats;

    /* 描いた1枚ごとの秒数。**遊び終わりに1回だけ数字にして送る。**
       毎フレーム送ったら、その通信でさらに重くなる。

       **輪にして使い回す。** 最初は普通の配列に push して、溢れたら shift していたが、
       shift は先頭を抜いて残り全部を1つずつ前へ詰める処理で、
       2000件の配列を**毎フレーム**ずらすことになる。
       測るための仕掛けが測られる物を重くしていたら本末転倒 */
    this._frames = new Float64Array(FRAME_SAMPLES);
    this._frameAt = 0;    // 次に書く場所
    this._frameN = 0;     // 溜まった数（上限はFRAME_SAMPLES）
    /* 描画命令(draw call)と三角形の数。fpsだけだと「重い」は分かっても
       「何を減らせば軽くなるか」が分からない。命令の数が多いのか、
       三角形が多いのか、数は普通で塗りが重いのか、を切り分ける入口 */
    this._infoCalls = new Int32Array(PERF_INFO_SAMPLES);
    this._infoTris = new Int32Array(PERF_INFO_SAMPLES);
    this._infoAt = 0;
    this._infoN = 0;
    this._infoAcc = 0;    // 1秒に1回だけ取るための積み
    this.perfMeter = null;
    // メニューの間、既に1枚描いてあるか。描いてあれば描き直さない（_loop末尾を参照）
    this._idleDrawn = false;
    this._lastTime = 0;
    this._invQ = new THREE.Quaternion();
    // 倒れている間の見回し。生きている間はnullで、倒れた瞬間に
    // その時の向きを入れて、生き返ったらnullへ戻す（_deathFall参照）
    this.deathLook = null;

    /* ------------------------------------------------------------ 対戦 */
    this.net = null;
    this.remotes = null;
    this.menu = null;
    // 回線が切れた時に、次はどの待ち時間で入り直すか（REJOIN_WAITSの位置）。
    // 入れたら0へ戻す
    this._rejoinAt = 0;
    this._rejoinTimer = null;
    this._lastJoin = null;
    // 対戦は物理を60Hz固定で回す。可変dtのまま送ると、同じキーを同じ長さ押しても
    // 到達位置がサーバーと食い違い、補正が常時走ることになる
    this._acc = 0;
    this._plates = [];
    this._toRemote = new THREE.Vector3();
    this._plateV = new THREE.Vector3();
    this._ray = new THREE.Ray();
    this._evPos = new THREE.Vector3();
    this._evNormal = new THREE.Vector3();
    // ソロの着弾解決(_resolveShot)専用。散弾は1発で複数ペレットぶん
    // 呼ばれるので、その回数ぶんnew Vector3()を積まないための使い回し
    this._hitNormal = new THREE.Vector3();
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
    renderer.setPixelRatio(drawScale(innerWidth, innerHeight));
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
    /* 描画命令の数は自動では数えさせない。自動(autoReset)だと render() の
       たびに0へ戻るが、このゲームは1フレームに何度も render() が走る
       （影の焼き込み・AOの法線・ポストの各パス）。自動のままだと最後のパス
       （仕上げの板1枚）しか見えず、「描画命令2回」という嘘の数字になる。
       ループの頭で自分で0へ戻し、フレーム全部を数える（_loopの先頭を参照） */
    renderer.info.autoReset = false;
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
    /* 空は起動時に1回だけキューブマップ（箱の内側6面の絵）へ焼いて、
       毎フレームは焼いた絵を貼るだけにする。
       前は空のシェーダを球のまま場面に置いていたが、あれは雲の計算で
       1ピクセル80回のハッシュを回すうえ、renderOrder=-1000で一番先に描くので、
       ビルや地面で隠れる画素のぶんまで毎フレーム全画面で払っていた。
       空は起動時に時間帯を決めたきり動かない（TODのコメント参照）ので、
       動かない物を毎フレーム計算し直す理由が無い。
       HalfFloatで焼くのは、太陽の芯がリニアで13を超えるため。8bitで焼くと
       1.0で頭打ちになり、ブルームへ渡る強さが消えて夕日がただの白丸になる */
    const sky = createSky(SUN_DIR);
    sky.scale.setScalar(10);
    const skyScene = new THREE.Scene();
    skyScene.add(sky);
    const skyRT = new THREE.WebGLCubeRenderTarget(1024, { type: THREE.HalfFloatType });
    const skyCam = new THREE.CubeCamera(0.1, 100, skyRT);
    skyCam.update(renderer, skyScene);
    scene.background = skyRT.texture;

    // 空から環境光を焼く。これがあると金属や影の色が一気に馴染む。
    // 焼き元は上と同じ球をそのまま使う（前は同じ物をもう1回組んでいた）
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const envRT = pmrem.fromScene(skyScene, 0.04);
    scene.environment = envRT.texture;
    // 環境光を抑えて日向と日陰の差を開く。上げすぎると影が持ち上がって平坦になる。
    // 空を2.75倍で焼いてあるので下げる必要はあるが、下げすぎると日陰が黒く潰れる。
    // 日陰の中に階調が残る最低限は確保する
    scene.environmentIntensity = 0.85;
    viewScene.environment = envRT.texture;
    viewScene.environmentIntensity = 0.45;   // 銃の環境反射も絞る（上面の白飛び対策）
    // 2回の焼きが終わったら焼き元は用済み。以後、空のシェーダは一度も走らない
    sky.geometry.dispose();
    sky.material.dispose();
    pmrem.dispose();

    /* ---------------------------------------------------------- 照明 */
    // 直射と天空光の比が画の生死を分ける。夕方の直射と天空フィルの比はリニアで5〜10倍あり、
    // ここが詰まると影が「影」ではなく「少し汚れた床」になる。
    // 実測で日向/日陰が1.24倍しかなかったので、直射を上げて環境光を大きく削る
    // 直射と天空光の比。前回1.24倍しか無いと言われて4.6まで振ったら、今度は
    // 日陰が黒く潰れて中間調が消えた。比は保ちつつ、潰さない側へ戻す。
    // 大事なのは「日向/日陰の比」であって「直射の絶対値」ではない。
    // 太陽そのものは1本だが、影だけは距離で分けた2枚に焼く。1枚で場内±46mを
    // 覆っていた時はその外の物が影を落とさず、遠景だけ影の無い書き割りになっていた。
    // 近くは細かく・遠くは粗く分ければ、範囲と精度を両方取れる。
    // 明るさを載せるのはシェーダー側で1枚目だけ（installCascadedSoftShadow参照）
    this._sunQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(SUN_DIR, new THREE.Vector3(), new THREE.Vector3(0, 1, 0)),
    );
    this._sunQuatInv = this._sunQuat.clone().invert();
    this._sunCenter = new THREE.Vector3();
    this._shadowTick = 0;
    // 遠い方の影マップを焼き直すべきかの門番（中身の説明はshadowgate.js）
    this._farShadow = new FarShadowGate();

    this.cascades = CASCADES.map((c) => {
      // 日射しの色も時間帯で変える。向きだけだと「影が伸びた」で終わって、
      // 朝なのか夕方なのかが読めない
      const light = new THREE.DirectionalLight(TOD.color, 3.6);
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
    this.weapons.onThrow = () => this._throwNade();
    this.weapons.onEject = (pos, dir) => this.effects.ejectCasing(pos, dir, camera);
    this.effects.onCasingLand = (pos) => this.audio.click(4200, 0.16, 0.05, pos, camera);
    this.director.onEnemyShoot = (...a) => this._enemyShot(...a);
    this.director.onEnemyDeath = (e) => this._onKill(e);
    this.director.onWaveStart = (n, count) => {
      // 波が変わる時に体力を戻す。回復手段が1つも無いので、
      // 1波で削られた分を抱えたまま次の波に入ることになり、
      // 進むほど「前の波の削られ方」だけで生死が決まっていた。
      // 全快にするのは、波の切れ目が唯一の立て直しどころだから
      const healed = n > 1 && this.player.health < this.player.maxHealth;
      if (healed) {
        this.player.refill();
        this.weapons.resetAll();
      }
      this.hud.banner(`第${n}波`, healed ? '体力と弾薬を補給した' : `敵 ${count}名 接近中`);
      this.audio.click(600, 0.4, 0.4);
    };

    // ミニマップの下敷き。ここで1回だけ焼く。
    // fxを作る前にやるのは、合成器が描画先を握った後だと
    // レンダーターゲットの付け外しが噛み合わなくなるため
    this.hud.setMinimap(bakeMinimap(renderer, level, scene.environment), MAP_EXTENT);
    // 撃った人の点。idごとに1つだけ持つ（連射で点が積み上がらない）。
    // tは1から0へ落ちる残り具合で、そのまま濃さになる
    this._blips = new Map();
    this._blipList = [];
    // 飛んでいる手榴弾の見た目。gidで引く
    this._nadeMeshes = new Map();
    // 地面に落ちている物。did -> 目印のGroup
    this._dropMeshes = new Map();
    // ソロで飛んでいる手榴弾。サーバーがいないので手元で持つ
    this._soloNades = [];
    this._soloNadeId = 1;
    // 毎フレーム作り直さないための入れ物
    this._mapMe = { x: 0, z: 0, yaw: 0 };
    this._outsideFor = 0;

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

    // 終了の画面から戻る口。**描画を止めた後なので、ここだけは
    // ゲームループの外から繋ぐ**（ループが止まっていても押せる必要がある）
    const back = document.getElementById('qtBack');
    if (back) back.onclick = () => this._resumeFromQuit();

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

    /* 設定（感度・音量・上下反転・全画面）。
       作った時点で覚えている値が全部効くので、ここで1つずつ写す必要はない。
       写す形にしていた頃は、設定を1つ足すたびにここへ1行足すのを忘れて
       「つまみは動くのに効かない」が出ていた */
    /* 声で話す層。**試合ごとに作り直さない。**
       設定（入り切り・音量）がここを掴むので、作り直すと設定の繋ぎが外れる。
       合図の送り先は今繋がっているサーバー。繋がっていなければ何も起きない */
    this.voice = new VoiceChat((to, d) => this.net?.sendVoice(to, d));
    this.voice.onChange = () => this._updateVoiceHud();

    this.settings = new SettingsMenu({ input: this.input, audio: this.audio, voice: this.voice });
    this.settings.onChange = (key, value) => {
      // 遊んでいる最中に全画面を切られたら、その場で窓へ戻す。
      // 次に遊び始めるまで効かないと、切ったのに何も起きないように見える
      if (key === 'full' && !value) this.input.exitFullscreen();
    };
    menu.onSettings = () => this.settings.show();

    /* 戦績と実績。開くたびに端末から読み直すのではなく、まだ書いていない今回ぶんも
       足した物を渡す。**渡さないと、遊んだ直後に開いた時だけ数字が古い。**
       「今30人倒したのに通算が増えていない」は、壊れているようにしか見えない */
    this.statsMenu = new StatsMenu();
    menu.onStats = () => this.statsMenu.show(this.totalStats);
    menu.onQuit = () => this._quitGame();

    // タブを閉じる・別のタブへ移る時に、今回ぶんを書き出す。
    // これが無いと、対戦の途中でブラウザを閉じた回は丸ごと消える。
    // beforeunloadではなくvisibilitychangeを使うのは、携帯とSafariが
    // beforeunloadを呼ばないまま終わることがあるため
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this._flushStats();
    });

    // 繋がってから試合が始まるまでの画面。押された席をそのままサーバーへ送る。
    // 座れたかどうかを手元で決めないので、ここでは絵を書き換えない
    const lobby = new Lobby();
    this.lobby = lobby;
    // ロビーで何か押されたら全画面へ入り直す。選択画面で断られていても、
    // ここでもう一度頼める。試合が始まってからでは断られる
    lobby.onPress = () => this.input.goFullscreen();
    lobby.onSeat = (seat) => this.net?.sendSeat(seat);
    lobby.onMode = (id) => this.net?.sendMode(id);
    lobby.onReady = (on) => this.net?.sendReady(on);
    // 選んでいる兵士を3Dで見せる。ロビーにいる間だけ描く
    this.charView = new CharView(document.getElementById('lbView'));
    lobby.onChar = (i) => {
      // 選んだ物は覚えておく。毎回選び直させると、決まっている人ほど面倒になる
      saveChar(i);
      this.charView.select(i);
      this.net?.sendChar(i);
    };

    // 何かがおかしい時だけ手掛かりを出す入れ物。
    // 遠くの人に遊んでもらった時、こちらに情報が返ってこないのを直すためにある
    this.diag = new Diag();

    /* URLに ?debug を付けた時だけ、左下に fps・描画命令・三角形の数を出す。
       軽量化の作業中に「この変更で何が減ったか」をその場で読むための窓。
       普段は作らないので、遊ぶ人の画面にも重さにも影響しない */
    if (new URLSearchParams(location.search).has('debug')) {
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;'
        + 'font:11px/1.6 ui-monospace,Menlo,monospace;color:#7ddb8a;'
        + 'background:rgba(0,0,0,.55);padding:2px 8px;border-radius:4px;'
        + 'pointer-events:none;white-space:nowrap';
      document.body.appendChild(el);
      this.perfMeter = new PerfMeter(el);
    }

    // 発言。ロビーでも試合中でも同じ物を使う
    const chat = new Chat();
    this.chat = chat;
    chat.onSend = (text) => this.net?.sendChat(text);
    lobby.onLeave = () => this._quitMatch();

    menu.onSolo = () => {
      // WebAudioはユーザーの操作を起点にしないと鳴らない。
      // 以前は起動画面のクリックで起こしていたが、ここから直接ロックへ飛ばすと
      // その起動画面が押されないまま隠れて、音が一度も初期化されないまま遊ぶことになる。
      // ボタンを押した流れそのものが操作なので、ここで起こしてよい
      this._wakeAudio();
      // 1人プレイはこの後サーバーと一度も会話しないので、
      // ここで送っておかないと**遊んだ事実がどこにも残らない**。
      // 名前は対戦と違って必須ではないので、入っていなければ名無しになる
      this.diag.name = menu.playerName || '';
      this.diag.event('遊び始めた');
      this._enterSolo();
      menu.hide();
      // 選んだ直後にロックを取らないと、画面が固まったように見える
      this.input.requestLock();
    };
    menu.onJoin = (opt) => {
      this._wakeAudio();
      // ここで全画面に入っておく。
      // 試合が始まるのはサーバーからの知らせが起点で、そこからでは
      // ブラウザが全画面を断る（人が押した直後しか許されない）。
      // 押したこの瞬間だけが頼めるタイミングで、ここを逃すと
      // 対戦の最中ずっと全画面にならず、Ctrl+Wでタブが閉じる形が残る
      this.input.goFullscreen();
      this._joinMatch(opt);
    };
    menu.show();
  }

  /**
   * 遊ぶのをやめる。**ブラウザのゲームには「閉じる」が無い。**
   *
   * タブを開いたままにしておくと、見ていない間もずっと3Dを描き続ける。
   * このゲームは元々「描画が増えるとパソコンが熱くなる」を抱えているので、
   * やめた後まで回し続けるのは実害が大きい。
   *
   * window.close() は**自分で開いたタブしか閉じられない**決まりなので、
   * URLを踏んで来た人の画面では何も起きない。だから閉じるのは頼むだけにして、
   * 閉じられなかった時のために「描画を止めて、その事を画面に出す」を必ずやる。
   *
   * 戻れるようにしてあるのは、押し間違いで作業が終わってしまわないため
   */
  _quitGame() {
    // やめる前に今回ぶんの戦績を書き出す。書かないと、最後の1戦が丸ごと消える
    this._flushStats();
    if (this.mode === 'versus') this._quitMatch();
    this.menu.hide();
    this.settings?.hide();
    this.statsMenu?.hide();
    this.hud.show(false);
    this.hud.hideOverlay();
    this.chat.hide();
    this.charView?.stop();
    this.input.exitFullscreen();
    document.exitPointerLock?.();
    // 描画を止める。ここが本体で、下のwindow.close()はおまけ
    this.renderer?.setAnimationLoop(null);
    this.state = 'quit';
    document.getElementById('quit')?.classList.remove('hidden');
    const note = document.getElementById('qtNote');
    if (note) {
      note.textContent = '画面の描画を止めました。このタブは閉じて構いません。';
    }
    // 自分で開いたタブなら閉じる。踏んで来た人の画面では何も起きない
    try { window.close(); } catch { /* 閉じられないだけ */ }
  }

  /** 終了の画面から戻る。描画を動かし直す */
  _resumeFromQuit() {
    document.getElementById('quit')?.classList.add('hidden');
    this.state = 'menu';
    this._lastTime = performance.now();
    this.renderer?.setAnimationLoop(() => this._loop());
    this.menu.show();
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

  async _joinMatch({ url, name }) {
    // 切れた時に自分で入り直せるよう、入った先を覚えておく。
    // 覚えないと、繋ぎ先を作るのが選択画面の中にあるので手が届かない
    this._lastJoin = { url };
    const net = new NetClient();
    let hello;
    try {
      hello = await net.connect(url, { name });
    } catch (err) {
      // 繋がらなかった回も、まだ試す回数が残っていれば自分で戻りにいく。
      // ここで諦めると、サーバーの入れ替え中の1回目で必ず終わる
      if (this._rejoinAt > 0 && this._rejoinAt < REJOIN_WAITS.length) {
        const wait = REJOIN_WAITS[this._rejoinAt++];
        this.menu.setStatus(NET_MSG.rejoin, false);
        clearTimeout(this._rejoinTimer);
        this._rejoinTimer = setTimeout(() => this._joinMatch({ url, name }), wait);
        return;
      }
      this._rejoinAt = 0;
      this.menu.setBusy(false);
      // 満員だけは「繋がらない」と原因が違うので、文言を分けて出す
      const msg = /満員|full/i.test(err.message) ? NET_MSG.full : NET_MSG.offline;
      this.menu.setStatus(msg, true);
      return;
    }
    // 入れたので数え直す。次に切れた時はまた最初の待ち時間から
    this._rejoinAt = 0;

    this.net = net;
    this.mode = 'versus';
    this.remotes = new RemotePlayers(this.scene, this.level);
    /* 今このとき地面に落ちている物。**置いた時の1回しか配られない**ので、
       途中から入った時はお迎えの電文で受け取らないと、拾える物が見えないまま
       「近づいたら何か起きた」になる */
    this._clearDrops();
    for (const d of hello?.drops || []) {
      if (Array.isArray(d) && d.length >= 6) this._addDrop(d[0], d[1] | 0, d[2] | 0, [d[3], d[4], d[5]]);
    }

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
    net.onLobby = (m) => { this._lobbyChime(m.rows); this.lobby.render(m); };
    net.onChat = ({ name, text }) => this.chat.push(name, text, name === this._myName);
    /* 声の合図。**中身は読まずに声の層へ渡す。**
       誰と繋いでよいかはサーバーが決めているので、ここで確かめ直さない */
    net.onVoiceSignal = ({ from, d }) => this.voice?.receive(from, d);
    net.onPhase = (ph) => this._onPhase(ph);

    this.hud.setMode('versus');
    this.hud.netStatus('');
    this.menu.setBusy(false);
    this.menu.hide();
    // 発言の中身は誰が言ったかを名前で運ぶので、自分の名前を覚えておく。
    // idで比べたいところだが、抜けた人の発言を残すために名前で運んでいる
    this._myName = name;
    // エラーを送る時に名前も載せる。誰の画面で起きたかが分からないと、
    // 遊んでいた人に聞き直す所からやり直しになる
    if (this.diag) this.diag.name = name;
    this.chat.clear();
    this.chat.show();
    // 前の顔ぶれを忘れてから入る。持ち越すと、2回目に入った時に
    // 「前にいた人」が新顔として数えられて、入った瞬間に鳴る
    this._lobbyIds = null;
    // 自分の番号を声の層へ渡す。**どちらから声をかけるかを決めるのに要る**
    // （番号の小さい方からだけ声をかける。両側から出すとぶつかる）
    this.voice.myId = net.id;
    this._updateVoiceHud();
    // 前の続きから始まったなら、そう言う。**言わないと、席と点数が戻っているのに
    // 本人には「入り直した」としか見えない**（戻ったのか0からなのか分からない）
    if (net.wasBack) this.chat.push('', '回線が戻りました。前の続きから始めます', false);
    // 前に選んだ見た目をサーバーへ伝える。伝えないと、覚えていても
    // 相手からは既定の姿に見える（サーバーは0番のまま持っている）
    const myChar = loadChar();
    net.sendChar(myChar);
    this.charView.select(myChar);
    this.charView.start();
    // 繋がっただけでは操作を握らない。ここでロックを取ると、席を選ぶ前に
    // マウスが画面へ吸われて、ロビーのボタンが押せなくなる
    this.lobby.show(net.id);
  }

  /* 人が増えたらピコンと鳴らす。
     待っている間に別の作業をしている人へ、画面を見ずに気づかせるのが狙い。
     だから「席に着いた」ではなく「繋いできた」時点で鳴らす。
     自分が入った時の1通目では鳴らさない。あの時点では前の顔ぶれを知らないので、
     先にいた人が全員新顔に見えて、入るたびに鳴ることになる */
  _lobbyChime(rows) {
    const now = new Set((rows || []).map((r) => r[0]));
    const before = this._lobbyIds;
    this._lobbyIds = now;
    if (!before) return;
    for (const id of now) {
      if (!before.has(id) && id !== this.net?.id) { this.audio.lobbyJoin(); return; }
    }
  }

  /* 局面が変わった時。ロビーを出すか畳むかはここ1箇所で決める。
     待ちに戻る経路（相手が抜けた・試合が終わって次を待つ）が複数あるので、
     それぞれの場所で畳んだり出したりすると必ずどれかを書き忘れる */
  _onPhase(phase) {
    if (this.mode !== 'versus') return;
    if (phase === PHASE.WAIT) {
      // 試合が成立しなくなってロビーへ戻された。操作を手放して席の画面を出す
      if (!this.lobby.isOpen) {
        this.hud.show(false);
        this.state = 'menu';
        document.exitPointerLock?.();
        this.lobby.show(this.net?.id ?? -1);
        // 試合が終わってロビーへ戻された。3Dも動かし直す
        this.charView?.start();
      }
      return;
    }
    // 始まった。席の画面を畳んで操作を握る
    if (this.lobby.isOpen) {
      this.lobby.hide();
      // ロビーの3Dを止める。止め忘れると、遊んでいる裏で2つ目の場面を
      // 描き続けることになって、そのぶんパソコンが熱くなる
      this.charView?.stop();
      this.input.requestLock();
    }
  }

  /**
   * 回線が切れた。**自分で戻りにいく。**
   *
   * サーバーは切れた人の席・点数・ラウンド数を60秒取っておくので（MATCH.REJOIN_S）、
   * その間に入り直せれば続きから遊べる。ただし入り直すのは手元の仕事で、
   * 何もしなければ「接続が切れました」の赤字が出て終わるだけになる。
   *
   * 待ち時間を伸ばしながら数回試すのは、切れ方が2種類あるから。
   * 電車のトンネルなら数秒で戻るが、サーバーの入れ替えは十数秒かかる。
   * 1秒間隔で連打しても入れ替え中のサーバーには繋がらないし、
   * 最初から8秒待つと、すぐ戻る場面で無駄に待たされる
   */
  _onNetLost(why) {
    if (this.mode !== 'versus') return;
    // 自分で抜けた時は戻らない（_quitMatchは受け口を外してから切るので普通は来ない）
    const canRetry = why !== 'bye' && !!this.net?.token && this._rejoinAt < REJOIN_WAITS.length;
    const name = this._myName;
    const back = this._lastJoin;
    this._leaveMatch();
    if (!canRetry || !back) {
      this._rejoinAt = 0;
      this.menu.setStatus(why || NET_MSG.lost, true);
      return;
    }
    const wait = REJOIN_WAITS[this._rejoinAt++];
    this.menu.setBusy(true);
    this.menu.setStatus(NET_MSG.rejoin, false);
    clearTimeout(this._rejoinTimer);
    this._rejoinTimer = setTimeout(() => this._joinMatch({ ...back, name }), wait);
  }

  /* 対戦の後片付けと、選択画面へ戻る所まで。
     回線が切れた時と、自分でホームへ戻った時で踏む手順は同じなので1つにしてある。
     違うのは「理由を赤字で出すかどうか」だけなので、そこは呼ぶ側が足す */
  _leaveMatch() {
    // 試合の途中で抜けた回も、そこまでの撃破は残す。
    // 残さないと「勝てないから抜ける」と記録が消えるのが同じ操作になる
    this._flushStats();
    this.mode = 'solo';
    this.net = null;
    // 落ちている物も片付ける。残すと、1人用に戻った後の街に光る箱が浮いたままになる
    this._clearDrops();
    // 声も畳む。畳まないと、抜けた後もマイクが開いたままになる
    this.voice?.dispose();
    if (this.voice) this.voice.myId = -1;
    this._updateVoiceHud();
    this.remotes?.dispose();
    this.remotes = null;
    this._lastStates = null;
    this._lastFireAt.clear();
    this._lobbyIds = null;
    // 試合終了の順位を畳むタイマーが残っていると、1人用に戻った後で最終順位が消えにいく
    clearTimeout(this._endTimer);
    this.hud.setMode('solo');
    this.hud.show(false);
    // 一時停止から戻る時は一時停止の画面が、ロビーから戻る時はロビーが
    // 出たままなので、どちらも畳んでから選択画面を出す
    this.hud.hideOverlay();
    this.lobby.hide();
    // ロビーの3Dを止める。止め忘れると、遊んでいる裏で2つ目の場面を
    // 描き続けることになって、そのぶんパソコンが熱くなる
    this.charView?.stop();
    this.chat.hide();
    this.state = 'menu';
    document.exitPointerLock?.();
    this._enterSolo();
    this.menu.show();
    this.menu.setBusy(false);
  }

  _onMatchEnd({ rows }) {
    // 通算へ流し込む区切り。順位はラウンド取得数→撃破数の順で並ぶので、
    // 先頭が自分なら勝ち。**hud側の並べ方と同じ順にする**
    // （別々に並べると、画面では1位なのに勝ちが増えない、が起きる）
    const rank = (rows || []).slice()
      .sort((a, b) => ((b.rounds | 0) - (a.rounds | 0)) || ((b.kills | 0) - (a.kills | 0)));
    this._tally('matches');
    if (rank[0]?.me) this._tally('wins');
    this._checkAchievements();
    this._flushStats();
    this._reportPerf();
    this.hud.matchEnd(rows, true, `${MATCH.ROUND_WINS}本先取で決着`);
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
      // 取ると選択画面の裏でゲームが始まってしまう。
      // ロビーも同じで、席を選んでいる最中にロックを取られると
      // マウスが画面へ吸われて席が押せなくなる。
      // 設定も同じで、一時停止から開いている最中にロックを取られると
      // つまみを掴んだ瞬間に試合へ戻ってしまう
      if (this.menu?.isOpen || this.lobby?.isOpen
        || this.settings?.isOpen || this.statsMenu?.isOpen) return;
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
        // 手榴弾を構えたまま(離さずに)一時停止すると、pointerlockが外れて
        // input.buttonsが黙って全部falseになる。断ち切らずにいると、
        // 再開した1フレーム目が「離した」と誤認して押してもいないのに
        // 手榴弾が飛ぶ（課題.md #1）
        this.weapons?.cancelThrowHold();
      }
    });

    addEventListener('resize', () => this._resize());
  }

  _showPause() {
    this.hud.show(false);
    if (this.mode === 'versus') {
      // 対戦は止まらない。抜けている間も撃たれるということを隠さない
      const me = this.net?.players.get(this.net.id);
      this._pauseOverlay(`
        <div class="title">一時停止</div>
        <div class="subtitle">試合は進行中</div>
        <div class="stats">
          撃破 <b>${me?.kills | 0}</b> &nbsp; 戦死 <b>${me?.deaths | 0}</b><br>
          回線 <b>${Math.round(this.net?.ping || 0)}</b>ms
        </div>
        <div class="cta">クリックで復帰</div>
        <div>
          <button id="ovSettings" class="ovhome" type="button">設定</button>
          <button id="ovHome" class="ovhome" type="button">ホームへ戻る</button>
        </div>
      `);
      return;
    }
    this._pauseOverlay(`
      <div class="title">一時停止</div>
      <div class="subtitle">作戦を中断中</div>
      <div class="stats">
        スコア <b>${this.score.toLocaleString('en-US')}</b><br>
        到達 <b>${this.director.wave}</b>波 &nbsp; 撃破 <b>${this.kills}</b>
      </div>
      <div class="cta">クリックで再開</div>
      <div>
        <button id="ovSettings" class="ovhome" type="button">設定</button>
        <button id="ovHome" class="ovhome" type="button">ホームへ戻る</button>
      </div>
    `);
  }

  /* 一時停止の画面を出して、「ホームへ戻る」と「設定」を繋ぐ。
     #overlayは「どこを押しても復帰」なので、そのまま置くとボタンを押した瞬間に
     復帰の処理も一緒に走る。stopPropagationで、この2箇所だけ上へ伝わらないようにする。
     設定をここから開けるようにしてあるのは、**感度は遊びながらでないと合わせられない**から。
     ホームまで戻らないと変えられない作りだと、確かめるたびに試合を抜けることになる */
  _pauseOverlay(html) {
    this.hud.overlay(html);
    const home = document.getElementById('ovHome');
    if (home) {
      home.onclick = (e) => {
        e.stopPropagation();
        this._goHome();
      };
    }
    const set = document.getElementById('ovSettings');
    if (set) {
      set.onclick = (e) => {
        e.stopPropagation();
        this.settings?.show();
      };
    }
  }

  /* 自分で対戦から抜ける。
     disconnect()は最後に onDisconnect('bye') を自分で呼ぶ作りなので、
     先に受け口を外しておかないと「回線が切れた」の道へ入って、
     選択画面に赤字で bye と出る（実際に出た）。
     切ったのは自分なので、伝える理由が無い */
  _quitMatch() {
    if (!this.net) return;
    this.net.onDisconnect = null;
    this.net.disconnect();
    this._leaveMatch();
  }

  /** 一時停止から選択画面へ戻る。対戦中なら回線も切る */
  _goHome() {
    if (this.mode === 'versus') {
      this._quitMatch();
      return;
    }
    this._flushStats();
    this.hud.show(false);
    this.hud.hideOverlay();
    this.state = 'menu';
    document.exitPointerLock?.();
    this.menu.show();
  }

  /* ---------------------------------------------------- 通算の戦績 */

  /** 今回ぶんを1つ数える。**ここでは書き出さない**（区切りでまとめて流す） */
  _tally(key, n = 1) {
    this.session[key] = (this.session[key] | 0) + n;
  }

  /** 一番良かった回だけ残す物（連続撃破・到達ウェーブ・スコア） */
  _tallyBest(key, v) {
    if (v > (this.session[key] | 0)) this.session[key] = v;
  }

  /** 端末に覚えている通算 ＋ まだ書いていない今回ぶん。実績の判定はこれを見る */
  get totalStats() { return mergeTally(this.stats, this.session); }

  /**
   * 解除されたばかりの実績を知らせる。**書き出しは伴わない。**
   *
   * 倒した直後に呼びたいので、書き出しと切り離してある。
   * 一緒にすると「初撃破」が死ぬまで出てこないか、1発撃つたびに書き出すかの
   * どちらかになる
   */
  _checkAchievements() {
    const now = this.totalStats;
    for (const a of newlyUnlocked(this._seen || this.stats, now)) {
      this.hud.achievement(a.name, a.desc);
    }
    this._seen = now;
  }

  /**
   * 今回ぶんを端末へ流し込む。区切り（倒れた時・試合が終わった時・
   * ホームへ戻る時・タブを離れた時）でだけ呼ぶ。
   *
   * 何も起きていない時は書きに行かない。ホームと選択画面を行き来するだけで
   * 毎回書き出すと、遊んでいないのに書き込みが走る
   */
  _flushStats() {
    if (!Object.values(this.session).some((v) => v > 0)) return;
    this.stats = saveStats(mergeTally(this.stats, this.session));
    this.session = emptyTally();
    this._seen = this.stats;

    /* 描いた1枚ごとの秒数。**遊び終わりに1回だけ数字にして送る。**
       毎フレーム送ったら、その通信でさらに重くなる。

       **輪にして使い回す。** 最初は普通の配列に push して、溢れたら shift していたが、
       shift は先頭を抜いて残り全部を1つずつ前へ詰める処理で、
       2000件の配列を**毎フレーム**ずらすことになる。
       測るための仕掛けが測られる物を重くしていたら本末転倒 */
    this._frames = new Float64Array(FRAME_SAMPLES);
    this._frameAt = 0;    // 次に書く場所
    this._frameN = 0;     // 溜まった数（上限はFRAME_SAMPLES）
    // 描画命令・三角形の数も同じ区切りで捨てる。前の試合の数字を混ぜない
    this._infoAt = 0;
    this._infoN = 0;
    this._infoAcc = 0;
  }

  /* 自分が倒れた。撃たれた・爆風・落下の3経路から同じ形で入る。
     以前はこの3箇所が同じ4行を各自持っていて、演出を足すなら3箇所を直す形だった */
  _onPlayerDown() {
    if (this.state === 'dead') return;
    this.state = 'dead';
    // 1人用の出撃が終わった。ここが通算へ流し込む区切りになる。
    // 到達ウェーブとスコアは、この回の最後の値が一番良い値なのでここで取る
    this._tally('deaths');
    this.streak = 0;
    if (this.mode === 'solo') {
      // 更新したかどうかを死亡画面で出すので、混ぜる前の値を控えておく
      const was = this.totalStats;
      this._prevBest = { score: was.bestScore | 0, wave: was.bestWave | 0 };
      this._tallyBest('bestWave', this.director.wave);
      this._tallyBest('bestScore', this.score);
    }
    this._checkAchievements();
    this._flushStats();
    this.deathT = 0;
    document.exitPointerLock?.();
    this.audio.playerDown();
    // 1人プレイの結果を残す。対戦はサーバーが全部知っているので送らない。
    // どこまで行ったかが分かると、「3波で必ず落ちる」のような形に辿り着ける
    if (this.mode === 'solo') {
      this.diag?.event('力尽きた', {
        wave: this.director.wave, kills: this.kills, score: this.score,
      });
      // 1人用はここが遊び終わり。対戦は試合が終わった時に送る
      this._reportPerf();
    }
    // すぐ結果を出さない。倒れる間を見せてから出す。
    // 260msで切り替えていた頃は、撃たれた次の瞬間に文字が出ていて、
    // 何が起きて死んだのかを見る時間が無かった
    clearTimeout(this._deathTimer);
    this._deathTimer = setTimeout(() => this._showDeath(), DEATH_FALL_S * 1000);
  }

  /* 倒れる間のカメラ。player._applyCamera()が書いた後に上書きする。
     膝から崩れて横倒しになる形。落ちるのを速く、傾くのを遅らせると
     「崩れ落ちた」に見える。同じ曲線で動かすと板が倒れるようにしか見えない */
  _deathFall(dt) {
    // 1人用は結果画面へ行くので state で、対戦は生き返るので体力で見る。
    // 対戦側を state で見ると、倒れている間ずっと state が 'dead' のままになり、
    // 生き返った後もカメラが地面に転がったままになる
    const down = this.mode === 'versus' ? !this.player.alive : this.state === 'dead';
    // 生き返ったら見回しも畳む。ここで落とさないと、湧いた後もカメラが
    // 倒れていた時の向きで上書きされ続けて、動いているのに景色が回らない
    if (!down) { this.deathT = null; this.deathLook = null; return; }
    this.deathT = Math.min(DEATH_FALL_S, (this.deathT ?? 0) + dt);
    // 倒れ込みと見回しの計算は src/core/deathcam.js が持つ。
    // ここに直書きしてあった頃は、main.jsを読み込むとゲームが丸ごと立ち上がるので
    // ブラウザ無しでは一度も確かめられなかった（tools/check-deathcam.mjs 参照）
    applyDeath(this.camera, {
      t: this.deathT,
      height: this.player.height,
      // 見回しは対戦だけ。1人用は倒れたら結果画面へ移るので持たない
      look: this.deathLook,
    });
  }

  _showDeath() {
    this.hud.show(false);
    const acc = this.shotsFired ? Math.round((this.shotsHit / this.shotsFired) * 100) : 0;
    const wave = this.director.wave;
    // 自己ベスト。点数だけ出しても、それが良い回だったのか分からない。
    // 前回までの一番と並べて初めて、もう一度やる理由になる。
    // **倒れた時点で今回ぶんは既に通算へ入っている**ので、そのまま読むと
    // 常に「今回＝自己ベスト」になる。倒れる直前に控えておいた物を使う
    const best = this._prevBest || { score: 0, wave: 0 };
    const isBest = this.score > best.score;

    // 数字を1行ずつ遅らせて出す。まとめて出すと表にしか見えない
    const row = (label, value, i, cls = '') => `<div class="drow ${cls}" style="animation-delay:${0.12 + i * 0.09}s">`
      + `<span class="dlabel">${label}</span><span class="dval">${value}</span></div>`;

    // 一時停止と同じ入れ物を使う。「ホームへ戻る」の繋ぎ込みが向こうにあり、
    // 押した時に再出撃が一緒に走らないようにする処理もそこが持っている
    this._pauseOverlay(`
      <div class="dtitle">戦死</div>
      <div class="dsub">${wave}波で力尽きた</div>
      <div class="dgrid">
        ${row('スコア', this.score.toLocaleString('en-US'), 0, 'big')}
        ${row('到達ウェーブ', wave, 1)}
        ${row('撃破', this.kills, 2)}
        ${row('ヘッドショット', this.headshots, 3)}
        ${row('命中率', `${acc}%`, 4)}
      </div>
      ${isBest
    ? `<div class="dbest hit" style="animation-delay:.62s">自己ベスト更新</div>`
    : `<div class="dbest" style="animation-delay:.62s">自己ベスト ${best.score.toLocaleString('en-US')}（${best.wave}波）</div>`}
      <div class="cta dcta" style="animation-delay:.78s">クリックで再出撃</div>
      <div class="dcta" style="animation-delay:.86s">
        <button id="ovHome" class="ovhome" type="button">ホームへ戻る</button>
      </div>
    `);
  }

  _restart() {
    this.score = 0; this.kills = 0; this.headshots = 0;
    this.shotsFired = 0; this.shotsHit = 0;
    this.damageFlash = 0;
    // 倒れる動きを止める。残すと再出撃した直後のカメラが傾いたまま始まる
    this.deathT = 0;
    clearTimeout(this._deathTimer);
    this.player.refill();
    this.player.yaw = 0; this.player.pitch = 0;
    this.player.teleport(this.level.playerSpawn);
    this.weapons.resetAll();
    this.director.reset();
    this.effects.clear();
    // 前の試合で空中に残っていた玉を消す。残すと次の開始直後に爆発する
    for (const g of this._soloNades) this._dropNade(g.gid);
    this._soloNades.length = 0;
    this.hud.score(0);
    this.state = 'menu';
  }

  _resize() {
    const w = innerWidth, h = innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewCamera.aspect = w / h;
    this.viewCamera.updateProjectionMatrix();
    // 倍率は窓の大きさで決まるので、寸法を入れる前に取り直す。
    // 順番が逆だと合成器のバッファだけ古い倍率で作られて画がずれる
    this.renderer.setPixelRatio(drawScale(w, h));
    this.renderer.setSize(w, h);
    this.fx.setSize(w, h);
    this.effects.setPixelScale(this.renderer.getDrawingBufferSize(new THREE.Vector2()).y);
    // 寸法が変わるとキャンバスの中身が消えるので、メニューで止めていた絵を描き直す
    this._idleDrawn = false;
  }

  /* 太陽の2枚を置き直す。近い1枚はカメラに付いていくので毎フレーム動かす */
  _updateSunCascades() {
    const center = this._sunCenter;
    for (const c of this.cascades) {
      if (c.interval > 1) {
        // 焼き直す番でなければ前に焼いた1枚をそのまま使う。
        // 箱を動かすのも一緒に見送る。動かすと中身と行列が食い違って影がずれる
        if (this._shadowTick % c.interval !== 0) continue;
        /* 番が来ても、遠くで何かが動いていた時しか焼き直さない。
           太陽も地形も動かないので、誰も遠くで動いていなければ
           前に焼いた1枚がそのまま正しい（判定の中身はshadowgate.js）。
           近い枚の中の動きは、毎フレーム焼く近い枚が受け持つ。
           前はここが無条件で、3フレームごとに517枚を丸ごと焼き直していた */
        const g = this._farShadow;
        g.begin(this.camera.position.x, this.camera.position.z);
        if (this.mode === 'versus') {
          if (this.remotes) {
            for (const s of this.remotes.slots.values()) {
              const r = s.handle.root;
              g.add(r.position.x, r.position.z, false);
            }
          }
        } else if (this.director) {
          // 死体は片付くまでactiveに残る（enemy.jsの_retireCorpse参照）ので、
          // ここを回れば生きている敵も死体も全部数えたことになる
          for (const e of this.director.active) {
            g.add(e.root.position.x, e.root.position.z, !e.alive && e.deathSettled);
          }
        }
        if (g.end()) c.light.shadow.needsUpdate = true;
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
    // 何も拾えなかった時(段差の隙間など)と、材質は拾えたがsurfaceOfに
    // 載っていない時(コンクリ・舗装など大半の地面)は、どちらも
    // 「詳しくは分からない地面」という同じ状況。既定は揃えておく
    if (!hits.length) return 'asphalt';
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
    if (pellet === 0) { this.shotsFired++; this._tally('shots'); }

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

    // 近接は弾を飛ばさないので曳光弾も出さない（刃を振るたびに弾が飛んで見えていた）
    const drawTracer = !def.melee && pellet % 3 === 0;

    if (enemyHit && (!worldHit || enemyHit.distance < worldHit.distance)) {
      const d = enemyHit.distance;
      const t = clamp((d - def.falloffStart) / (def.falloffEnd - def.falloffStart), 0, 1);
      let dmg = def.damage * THREE.MathUtils.lerp(1, def.falloffMin, t);
      const head = enemyHit.part === 'head';
      if (head) dmg *= def.headMult;
      else if (enemyHit.part === 'legs') dmg *= 0.82;

      const killed = enemyHit.enemy.hit(dmg, enemyHit.part);
      if (pellet === 0) { this.shotsHit++; this._tally('hits'); }

      this.effects.impact(enemyHit.point, this._hitNormal.copy(dir).negate(), 'flesh');
      // 近接は刃が入る音を足す。弾が当たった時と同じ音だと、
      // 撃ったのか斬ったのかが耳から判別できない
      if (def.melee) this.audio.stab(enemyHit.point, this.camera, 'flesh');
      this.hud.hitmarker(head);
      this.audio.hitmarker(head);
      if (killed) {
        enemyHit.enemy._killHeadshot = head;
        this.audio.death(enemyHit.point, this.camera);
      }
      if (drawTracer) this.effects.tracer(muzzle, enemyHit.point, 0.03);
    } else if (worldHit) {
      const normal = worldHit.face
        ? this._hitNormal.copy(worldHit.face.normal).transformDirection(worldHit.object.matrixWorld)
        : this._hitNormal.copy(dir).negate();
      const kind = this.kindOf.get(worldHit.object.material) ?? 'concrete';
      // 近接は弾ではない。壁を刃で擦っても火花は散らないし着弾痕も残らない。
      // ここを素通ししていたせいで、ナイフを振るたびに銃の着弾と同じ
      // 火花・粉塵・弾痕が壁に出ていた
      if (!def.melee) {
        this.effects.impact(worldHit.point, normal, kind);
        this.audio.impact(kind, worldHit.point, this.camera);
      } else {
        // 火花は出さないが、当たった手応えは要る。
        // 材質を渡すのは、鉄板とコンクリで鳴り方を変えるため。
        // 全部同じ鈍い音だと、何に当たったのか耳から分からない
        this.audio.stab(worldHit.point, this.camera, kind);
      }
      if (drawTracer) this.effects.tracer(muzzle, worldHit.point, 0.03);
    } else if (drawTracer) {
      const far = this._hitNormal.copy(origin).addScaledVector(dir, def.range);
      this.effects.tracer(muzzle, far, 0.025);
    }
  }

  /* 対戦では当たったかどうかをサーバーが決める。ここでやるのは見た目だけ。
     ただし「自分の弾がどこへ飛んだか」は往復を待たずに出さないと、
     撃った手応えが遅れて別のゲームになる。だから壁への着弾は手元で描いて、
     サーバーから返る自分ぶんのIMPACTは捨てる（二重に火花が出る） */
  _resolveShotVersus(shot) {
    const { origin, dir, muzzle, def, pellet } = shot;
    if (pellet === 0) { this.shotsFired++; this._tally('shots'); }

    this.net.sendShot(origin, dir);

    // 近接は弾を飛ばさないので曳光弾も出さない（刃を振るたびに弾が飛んで見えていた）
    const drawTracer = !def.melee && pellet % 3 === 0;
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
      // 対戦側も同じ。近接では火花も着弾痕も出さない
      if (!def.melee) {
        this.effects.impact(h.point, normal, kind);
        this.audio.impact(kind, h.point, this.camera);
      } else {
        this.audio.stab(h.point, this.camera, kind);
      }
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

  _enemyShot(enemy, muzzle, dir, damage, _dist) {
    this.effects.muzzle(muzzle, dir);
    this.audio.gunshot(
      { volume: 0.62, bodyFreq: 360, crackFreq: 3000, bodyDecay: 0.17, tailDecay: 0.30, thumpFrom: 105, thumpTo: 42 },
      muzzle, this.camera,
    );
    // 対戦と同じ扱いで、撃った敵だけミニマップに一瞬出す。
    // 敵はidを持たないのでオブジェクトそのものを鍵にする
    this._markBlip(enemy, muzzle);

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

      if (!player.alive) this._onPlayerDown();
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
    this._tally('kills');
    this.streak++;
    this._tallyBest('bestStreak', this.streak);
    if (enemy._killHeadshot) this._tally('headshots');
    this._checkAchievements();
    // 倒れた場所に血だまりを残す。死体が消えた後も戦闘の痕跡が残る
    this.effects.bloodPool(enemy.collider.start);
    const head = !!enemy._killHeadshot;
    this.audio.kill(head);
    this.hud.elim('敵兵', head);
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
          { volume: 0.62, bodyFreq: 360, crackFreq: 3000, bodyDecay: 0.17, tailDecay: 0.30, thumpFrom: 105, thumpTo: 42 },
          r.headPos, this.camera,
        );
        // 撃った所をミニマップに出す。音で位置が割れるのと同じことを画でも見せる。
        // 銃声をまとめる判定の後に置く。前に置くと散弾1発ごとに書き直すことになる
        this._markBlip(ev.id, r.headPos);
        break;
      }

      case EV.HIT: {
        if (ev.by === me) {
          this.shotsHit++; this._tally('hits');
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
        // 戦域の外で力尽きた回はbyに本人が入っている。倒した人がいないので、
        // 普通の撃破と同じ行にすると「Xを倒したのはX」という行が流れる
        // 1対1のラウンド制なので、誰かが倒れた時点でそのラウンドは決まる。
        // 「戦死」だけ出すと、それで1本落としたのかどうかが画面から読めない
        if (ev.z || ev.f) {
          // 戦域の外・落下で力尽きた回も戦死は戦死。連続撃破もここで切れる
          if (ev.id === me) { this._tally('deaths'); this.streak = 0; }
          const why = ev.z ? '戦域の外' : '落下';
          this.hud.kill(`${net.nameOf(ev.id)}が${why}で力尽きた`, false);
          this.hud.banner(
            ev.id === me ? 'ラウンドを落とした' : 'ラウンド取得',
            ev.id === me ? `${why}で力尽きた` : `相手が${why}で力尽きた`, 1.8,
          );
          break;
        }
        const head = !!ev.head;
        this.hud.killVersus(net.nameOf(ev.by), net.nameOf(ev.id), head, ev.by === me, ev.id === me);
        if (ev.by === me && ev.id !== me) {
          this.kills++;
          this._tally('kills');
          this.streak++;
          this._tallyBest('bestStreak', this.streak);
          if (head) this.headshots++;
          if (head) this._tally('headshots');
          this._checkAchievements();
          this.audio.death(this.remotes?.get(ev.id)?.headPos ?? this.camera.position, this.camera);
          // 倒れる音（相手の場所で鳴る環境音）とは別に、倒した知らせを耳元で鳴らす
          this.audio.kill(head);
          this.hud.elim(net.nameOf(ev.id), head);
          this.hud.banner('ラウンド取得', '', 1.8);
        }
        if (ev.id === me) {
          this._tally('deaths');
          this.streak = 0;
          this.hud.banner('ラウンドを落とした', `${net.nameOf(ev.by)}に倒された`, 1.8);
        }
        break;
      }

      case EV.NADE:
        if (Array.isArray(ev.p)) this._syncNade(ev.gid, ev.p);
        break;

      // 声で繋ぐ相手が変わった。**誰と繋いでよいかを決めるのはサーバー**
      case EV.VOICE:
        this.voice?.setPeers(ev.p);
        break;

      case EV.DROP:
        if (Array.isArray(ev.p)) this._addDrop(ev.did, ev.w | 0, ev.n | 0, ev.p);
        break;

      case EV.TAKE: {
        const g = this._dropMeshes.get(ev.did);
        // 拾ったのが自分なら、その場で弾を戻す。
        // **弾の数はサーバーが持っていない**（撃った回数は手元が数えている）ので、
        // 「拾った」という知らせを受けて手元が戻す形になる。
        // 増やせる上限は武器の表が持っているので、ここで数は決めない
        if (ev.by === me) {
          const got = this.weapons.refillReserve();
          const nades = g?.userData.nades | 0;
          this.audio.click(1500, 0.4, 0.05);
          // 何が増えたのかを言う。「補給」とだけ出すと、
          // 弾が満タンの時に拾っても同じ文字が出て、何も起きていないのに起きた気になる
          const what = [got ? '弾' : '', nades > 0 ? `手榴弾${nades}個` : ''].filter(Boolean);
          this.hud.kill(what.length ? `補給 — ${what.join('と')}` : '拾った（増える物は無かった）', false);
        }
        this._removeDrop(ev.did);
        break;
      }

      case EV.BOOM: {
        this._dropNade(ev.gid);
        if (!this._vecOf(this._evPos, ev.p)) break;
        this.effects.explosion?.(this._evPos);
        this.audio.explosion?.(this._evPos, this.camera);
        // 近いほど画面を揺らす。爆風の判定はサーバーが持つので、
        // ここで揺らす量は「見えた距離」だけで決めてよい
        const d = this._evPos.distanceTo(this.camera.position);
        const k = Math.max(0, 1 - d / NADE.BLAST_R);
        if (k > 0) {
          this.player.addRecoil(0.05 * k, (Math.random() - 0.5) * 0.06 * k);
          this.damageFlash = Math.min(0.5, this.damageFlash + 0.18 * k);
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
        // 包帯もここで戻す。サーバーは湧き直しで2本に戻しているので、
        // 手元だけ0のままだとFを押しても手元が断って、一生使えなくなる
        this.player.refill();
        this.weapons.resetAll();
        this.damageFlash = 0;
        this.net.resetPrediction?.();
        break;
      }

      // 持ち物が替わった。ガンゲームで段が進んだ時に届く。
      // **持ち物を決めるのはサーバー。** 手元で進めると、
      // このファイルを書き換えるだけで最後の武器から始められる
      case EV.ARM: {
        if (ev.id !== me || !Array.isArray(ev.c) || ev.c.length === 0) break;
        const before = this.weapons.index;
        this.weapons.carry = ev.c.map((n) => n | 0);
        // 今持っている物が持ち物から外れたら、先頭へ持ち替える。
        // switchTo は持ち物を見るので、carry を入れ替えた後に呼ぶ
        if (!this.weapons.carry.includes(before)) {
          this.weapons.switchTo(this.weapons.carry[0]);
        }
        // 何段目かを画面へ出す。ガンゲームは「あと何本で勝ち」が
        // 分からないと、何を目指して撃っているのか読めない
        this.hud.stage?.(ev.st | 0, ev.of | 0);
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
  /**
   * その人が味方か。**チーム戦の時だけ。**
   *
   * どちらのチームかは席から決まる（protocol.jsのTEAM_OF_SEAT）が、
   * 試合が始まると席の情報はもう流れてこないので、得点の電文に載せてもらった
   * 番号をそのまま見る
   */
  _isMate(id) {
    const net = this.net;
    if (!net || net.mode !== 'team' || id === net.id) return false;
    const me = net.players.get(net.id);
    const other = net.players.get(id);
    if (!me || !other) return false;
    return me.team >= 0 && me.team === other.team;
  }

  _updatePlates(states) {
    const cam = this.camera;
    const list = this._plates;
    list.length = 0;
    for (const st of states) {
      if (st.state & S.DEAD) continue;
      // 名札は撃った直後だけ出す。常時出していると、遮蔽の陰から動く名前が
      // 先に見えて奇襲が一切成立しない（壁の裏の相手の居場所まで分かってしまう）。
      // ミニマップの点と同じ_blipsを見るので、画で光る条件と名前が出る条件が揃う
      if (!this._blips.has(st.id)) continue;
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
        // 発砲からの残り具合。点と同じ速さで消えていく
        fade: this._blips.get(st.id).t,
        // 味方かどうか。札の色を変えるのに使う（2対2でだけ立つ）
        mate: this._isMate(st.id),
      });
    }
    this.hud.nameplates(list);
  }

  /* 対戦の1フレーム。物理だけ60Hz固定で回す。
     可変dtのまま送ると、同じキーを同じ長さ押してもサーバーと到達位置が食い違う */
  _versusFrame(dt, input) {
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
    } else if (this.deathLook) {
      // 倒れている間も見回せる。撃たれた瞬間に視点が固まって、
      // 生き返るまで同じ方向を向いたままなのが「あっさり」の正体だった。
      // 誰にやられたのか・味方がどこにいるのかを見る時間がここにしかない。
      //
      // **送るのは倒れた瞬間の向きのままにする。** ここでplayer.yawを動かすと
      // サーバーへ流れて、他の人の画面では倒れているはずの体が首だけ回り続ける。
      // 見回すのは自分のカメラの中だけの話なので、別に持つ
      // 上下はdeathcam側で狭める。地面に転がっているので、真下を向いても床しか無い
      turnLook(this.deathLook, look.yaw, look.pitch);
    }

    let bits = 0;
    if (player.alive) {
      for (const [code, bit] of KEY_CODES) if (input.down(code)) bits |= bit;
      // 包帯は「巻いている間ずっと」立てる。Fの押し下げを送っていた時の名残で
      // ここをキーから引くと、手に持っただけでサーバー側の回復が始まる。
      // healHoldのぶん余分に立て続けるのは、向こうが遅れて巻き終わるため
      if (player.healing > 0 || player.healHold > 0) bits |= K.HEAL;
      // 包帯を持っている間は撃たない。持ったまま左クリックすると
      // こちらでは巻き始めるだけなのに、サーバーには発砲として届く
      if (input.buttons[0] && !this.weapons.bandageOut && player.healing <= 0) bits |= K.FIRE;
      // 覗いているかは武器側が持つ入り切りの状態を見る。ボタンの押し下げを送ると、
      // トグルなのに「押した瞬間だけ覗いた」という入力がサーバーへ流れる
      if (this.weapons.wantAds) bits |= K.ADS;
    }

    // Spaceの立ち上がりを持ち越す。ジャンプは player.update の中で
    // input.pressed('Space') の1フレームだけの立ち上がりで拾うが、対戦では
    // player.update が下の固定刻みループの中でしか回らない。120/144Hzの画面だと
    // 刻みが1回も回らないフレームが半分ほど出て、そのフレームに来たSpaceは
    // フレーム末の endFrame() で消えてしまい、ジャンプが抜ける。ここで拾って
    // 次に刻みが回った最初の1回へ渡す（サーバーはbitの立ち上がりで跳ぶので、
    // これで手元の予測とサーバーの跳躍が同じ刻みに揃う）
    this._pendingJump = this._pendingJump || input.pressed('Space');

    this._acc += dt;
    // 溜まりすぎたら捨てる。タブから戻った時に数百刻みを一気に流すと、
    // サーバーの受け皿が溢れて入力に穴が空き、その人だけ動けなくなる
    if (this._acc > TICK_DT * 6) this._acc = TICK_DT * 6;
    while (this._acc >= TICK_DT) {
      this._acc -= TICK_DT;
      net.sendInput(bits, player.yaw, player.pitch);
      player.update(TICK_DT, input, false, this._pendingJump);
      // 持ち越したジャンプは最初の1刻みだけで使い切る（二重に跳ばせない）
      this._pendingJump = false;
      net.correction(player, TICK_DT);
    }

    // 体力と生死はサーバーが持っている。手元では表示に写すだけ
    const me = net.self();
    if (me) {
      player.health = me.hp;
      const dead = !!(me.state & S.DEAD);
      if (dead !== !player.alive) {
        player.alive = !dead;
        // 倒れ込みの時計を回す・止める。
        // 1人用と違って結果画面へは行かない（次のラウンドの頭で生き返る）ので、
        // 使うのは倒れる動きだけ。撃たれた瞬間に視点が固まって、
        // 生き返るまでその場に立ったままだったのが「あっさり」の正体
        this.deathT = dead ? 0 : null;
        // 見回す用の向き。倒れた瞬間の向きから始める（そこから首を回す形にする）。
        // 生き返る時にnullへ戻すのを忘れると、湧いた後もカメラがここの値で
        // 上書きされ続けて、動いているのに景色が回らない状態になる
        this.deathLook = dead ? startLook(player.yaw, player.pitch) : null;
        if (dead) this.audio.playerDown();
      }
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
    // 倒れ込み。1人用と同じ動きを対戦にも入れる
    this._deathFall(dt);

    const states = net.stateAt();
    this._lastStates = states;
    // 誰がどの見た目かを渡す。姿を組むのは相手が初めて画面に出る時だけなので、
    // 毎フレーム作り直すことにはならない
    this._charMap ??= new Map();
    this._charMap.clear();
    for (const [id, row] of net.players) this._charMap.set(id, row.chr | 0);
    this.remotes.setChars(this._charMap);
    this.remotes.sync(states, net.id, this.camera.position);
    this._updatePlates(states);

    this.effects.update(dt, this.camera);
    this._spinDrops(dt);
    this._commonHud(dt);
    /* 画面の上に出す点数。「自分 － 先頭」で出す。
       1対1の頃は「自分以外の1人」がそのまま相手だったが、
       3人以上いると相手が1人に決まらない。
       全員ぶん並べても撃ち合いの最中には読めないので、
       **今追うべき相手＝一番取っている人**とだけ比べる。
       自分が先頭なら2番手と比べる（自分と自分を比べても差が分からない） */
    let mine = 0;
    let theirs = 0;
    let leader = '';
    if (net.mode === 'team') {
      /* 2対2は「自分のチーム － 相手のチーム」。
         味方には同じ本数が入っているので、自分の数字がそのままチームの数字になる。
         **人ごとの比べ方をそのまま使うと、味方が先頭の時に「2 － 2」と出る** */
      const me = net.players.get(net.id);
      const myTeam = me ? me.team : -1;
      mine = me ? me.rounds | 0 : 0;
      for (const [id, r] of net.players) {
        if (id === net.id || r.team < 0 || r.team === myTeam) continue;
        theirs = Math.max(theirs, r.rounds | 0);
        leader = TEAM_NAMES[r.team] || '';
      }
    } else {
      for (const [id, r] of net.players) {
        if (id === net.id) { mine = r.rounds | 0; continue; }
        const n = r.rounds | 0;
        // 先頭の名前も持つ。3人以上いる時、王手なのが誰かを名指しで出すのに要る
        if (n > theirs || !leader) { theirs = Math.max(theirs, n); if (n >= theirs) leader = r.name || ''; }
      }
    }
    this.hud.matchInfo(mine, theirs, MATCH.ROUND_WINS, net.phase, net.timeLeft, leader);
    // **1回だけ作る。** 名簿と順位表で別々に呼んでいた頃は、
    // 人数ぶんの入れ物を毎フレーム2組作って捨てていた
    const rows = net.scoreRows();
    this.hud.roster(rows);
    this.hud.scoreboard(rows, input.down('Tab'));
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
    // 画面の札に印を付ける位置は「持ち物の何番目か」。武器の番号そのものだと、
    // 持って出ない武器のぶんずれて、別の札が光る
    const slotAt = this.weapons.carry.indexOf(this.weapons.index);
    this.hud.ammo(w.ammo, w.reserve, w.def.name, slotAt, this.weapons.reloading, !!w.def.melee);
    this.hud.bandage(
      this.player.bandages, this.player.healing, HEAL.TIME_S,
      this.weapons.bandageOut, HEAL.PER_ROUND,
    );
    this._minimapFrame(dt);
    this._updateNadeArc();
    this.hud.update(dt);
  }

  /**
   * 手榴弾を投げる。向きだけ送って、飛翔も爆発もサーバーに任せる。
   * 手元で軌道を予測して描くこともできるが、それをやると
   * 「自分の画面では壁を越えたのにサーバーでは越えていない」がそのまま見えてしまう。
   * サーバーから届く位置だけを描くほうが、遅れても嘘をつかない
   */
  _throwNade() {
    // ソロにはサーバーがいないので、手元で1つ飛ばして自分で爆発まで面倒を見る。
    // 対戦と同じNADEの値を使うので、飛び方と爆風の広さは両モードで揃う
    if (this.mode !== 'versus') { this._throwNadeSolo(); return; }
    if (!this.net) return;
    const cam = this.camera;
    _throwOrigin.setFromMatrixPosition(cam.matrixWorld);
    // 真っ直ぐ前ではなく少し上へ。水平に投げると足元へ落ちて自爆する
    _throwDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _throwDir.y += NADE_LOFT;
    _throwDir.normalize();
    this.net.sendThrow(_throwOrigin, _throwDir);
  }

  /**
   * 手榴弾を持っている間だけ、飛ぶ先の弧を出す。
   *
   * 投げてみるまでどこへ落ちるか分からないのは、弧を描く物では致命的に不便。
   * サーバーと同じ初速・重力で先読みして、地形に当たった所で切る。
   * 当たり判定はカプセルではなくレイで代用する（見せる線なので、
   * 数cmの差はどうせ描き分けられない）
   */
  _updateNadeArc() {
    const holding = !!this.weapons.def.thrown;
    const show = this.state === 'playing' && this.player.alive && holding;

    /* 手榴弾を持っているのに線が出ない時だけ、その理由を画面に出す。
       「試合の途中から軌道が出なくなった」と言われたが、コードを読んでも
       どこで止まるのか特定できなかった。3つの条件のどれが崩れているかが
       分かれば次の1回で決まるので、本人の画面に出す。
       持っていない時は当然出ないので、その時は黙っている */
    this.diag?.setState(
      'arc',
      !holding || show ? ''
        : this.state !== 'playing'
          ? `軌道が出ない: 操作を握れていない（state=${this.state}）`
          : '軌道が出ない: 倒れている扱いになっている',
    );

    if (!show) {
      if (this._arc) this._arc.visible = false;
      return;
    }
    if (!this._arc) {
      this._arc = new THREE.Line(
        new THREE.BufferGeometry().setAttribute(
          'position', new THREE.BufferAttribute(new Float32Array(ARC_STEPS * 3), 3),
        ),
        new THREE.LineDashedMaterial({
          color: 0x63d2ff, transparent: true, opacity: 0.5,
          dashSize: 0.22, gapSize: 0.16, depthTest: false,
        }),
      );
      this._arc.renderOrder = 900;
      this._arc.frustumCulled = false;
      this.scene.add(this._arc);
    }
    this._arc.visible = true;

    const cam = this.camera;
    _throwOrigin.setFromMatrixPosition(cam.matrixWorld);
    _throwDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _throwDir.y += NADE_LOFT;
    _throwDir.normalize();

    const pos = _arcPos.copy(_throwOrigin).addScaledVector(_throwDir, NADE.MUZZLE);
    const vel = _arcVel.copy(_throwDir).multiplyScalar(NADE.SPEED);
    const arr = this._arc.geometry.attributes.position.array;
    const dt = 0.045;
    let n = 0;
    for (let i = 0; i < ARC_STEPS; i++) {
      arr[n++] = pos.x; arr[n++] = pos.y; arr[n++] = pos.z;
      _arcPrev.copy(pos);
      vel.y -= NADE.GRAVITY * dt;
      pos.addScaledVector(vel, dt);
      // 地形に当たったらそこで打ち切る。残りの点は最後の位置で潰す
      _arcStep.subVectors(pos, _arcPrev);
      const len = _arcStep.length();
      if (len > 1e-4) {
        this.raycaster.set(_arcPrev, _arcStep.divideScalar(len));
        this.raycaster.far = len;
        const hit = this.raycaster.intersectObjects(this.solidMeshes, false);
        if (hit.length) {
          pos.copy(hit[0].point);
          for (let k = i + 1; k < ARC_STEPS; k++) {
            arr[n++] = pos.x; arr[n++] = pos.y; arr[n++] = pos.z;
          }
          break;
        }
      }
    }
    this._arc.geometry.attributes.position.needsUpdate = true;
    this._arc.computeLineDistances();
  }

  /** ソロの手榴弾。判定を持つ相手がいないので、飛翔も爆発もここで完結させる */
  _throwNadeSolo() {
    const cam = this.camera;
    _throwOrigin.setFromMatrixPosition(cam.matrixWorld);
    _throwDir.set(0, 0, -1).applyQuaternion(cam.quaternion);
    _throwDir.y += NADE_LOFT;
    _throwDir.normalize();

    const gid = this._soloNadeId++;
    this._soloNades.push({
      gid,
      pos: _throwOrigin.clone().addScaledVector(_throwDir, NADE.MUZZLE),
      vel: _throwDir.clone().multiplyScalar(NADE.SPEED),
      fuse: NADE.FUSE_S,
      cap: new Capsule(new THREE.Vector3(), new THREE.Vector3(), NADE.RADIUS),
    });
  }

  /**
   * ソロの手榴弾を1フレーム進める。
   * 跳ね返りの割り方はサーバー側(_stepNades)と同じ。初速20m/sだと1フレームで
   * 0.33m進むのに玉の半径は0.075mしかなく、割らずに動かすと床をすり抜ける
   */
  _stepSoloNades(dt) {
    const list = this._soloNades;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      g.fuse -= dt;
      g.vel.y -= NADE.GRAVITY * dt;

      const steps = Math.min(8, Math.max(1, Math.ceil((g.vel.length() * dt) / (NADE.RADIUS * 0.5))));
      const h = dt / steps;
      let dead = false;
      for (let s = 0; s < steps; s++) {
        g.pos.addScaledVector(g.vel, h);
        if (g.pos.y < -30) { dead = true; break; }
        g.cap.start.copy(g.pos);
        g.cap.end.copy(g.pos);
        const hit = this.level.octree.capsuleIntersect(g.cap);
        if (!hit) continue;
        g.pos.addScaledVector(hit.normal, hit.depth);
        const into = g.vel.dot(hit.normal);
        if (into < 0) g.vel.addScaledVector(hit.normal, -into * (1 + NADE.BOUNCE));
        const k = Math.max(0, 1 - NADE.FRICTION * h);
        g.vel.x *= k; g.vel.z *= k;
        if (hit.normal.y > 0.5) g.vel.y *= k;
      }

      if (dead || g.fuse <= 0) {
        if (!dead) this._explodeSolo(g.pos);
        this._dropNade(g.gid);
        list.splice(i, 1);
        continue;
      }
      this._syncNade(g.gid, [g.pos.x, g.pos.y, g.pos.z]);
    }
  }

  /** ソロの爆発。敵と自分の両方に入る（足元に落とせば自爆する） */
  _explodeSolo(pos) {
    this.effects.explosion(pos);
    this.audio.explosion(pos, this.camera);

    for (const e of this.director.active) {
      if (!e.alive) continue;
      const p = e.collider.start;
      _throwOrigin.set(p.x, p.y + 0.5, p.z);
      const d = _throwOrigin.distanceTo(pos);
      if (d > NADE.BLAST_R) continue;
      // 爆心から胸へレイを飛ばして、遮る物があれば入らない
      _throwDir.subVectors(_throwOrigin, pos);
      const len = _throwDir.length() || 1;
      _throwDir.divideScalar(len);
      this.raycaster.set(pos, _throwDir);
      this.raycaster.far = len;
      if (this.raycaster.intersectObjects(this.solidMeshes, false).length) continue;

      const dmg = Math.max(NADE.MIN_DMG, NADE.BLAST_DMG * (1 - d / NADE.BLAST_R));
      if (e.hit(dmg, 'chest')) this._onKill(e);
    }

    // 自分も巻き込まれる
    const me = this.player.collider.start;
    const dm = Math.hypot(me.x - pos.x, me.y + 0.5 - pos.y, me.z - pos.z);
    if (dm <= NADE.BLAST_R && this.player.alive) {
      this.player.damage(Math.max(NADE.MIN_DMG, NADE.BLAST_DMG * (1 - dm / NADE.BLAST_R)));
      this.damageFlash = Math.min(0.6, this.damageFlash + 0.4);
      if (!this.player.alive) this._onPlayerDown();
    }
  }

  /** 飛んでいる手榴弾を描く。サーバーから届いた位置に玉を置くだけ */
  _syncNade(gid, p) {
    let m = this._nadeMeshes.get(gid);
    if (!m) {
      m = new THREE.Mesh(
        new THREE.SphereGeometry(NADE.RADIUS, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x2a2e26, roughness: 0.7, metalness: 0.3 }),
      );
      this.scene.add(m);
      this._nadeMeshes.set(gid, m);
    }
    m.position.set(p[0], p[1], p[2]);
    // 届かなくなった玉を片付けるための最終受信時刻
    m.userData.at = performance.now();
  }

  /** 爆発したか、位置が届かなくなった玉を消す */
  _dropNade(gid) {
    const m = this._nadeMeshes.get(gid);
    if (!m) return;
    this.scene.remove(m);
    m.geometry.dispose();
    m.material.dispose();
    this._nadeMeshes.delete(gid);
  }

  /**
   * 描画の重さを1行送る。**遊び終わりに1回だけ。**
   *
   * 中央値と、遅かった5%の2つを出す。**平均を取らない。**
   * 60が続いて時々10まで落ちる端末は、平均だと57くらいになって
   * 「問題なし」に見えるが、遊んでいる本人にはその10の瞬間しか記憶に残らない。
   *
   * 送った後は捨てる。次の試合の数字に前の試合が混ざらないように
   */
  _reportPerf() {
    const n = this._frameN;
    // 短すぎる回は数字にならない（湧いた直後に落ちた等）
    if (n < 120) { this._frameN = 0; this._frameAt = 0; return; }
    const sorted = Array.from(this._frames.subarray(0, n)).sort((a, b) => a - b);
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
    const fps = (dt) => (dt > 0 ? Math.round(1 / dt) : 0);
    // 描画命令・三角形は中央値で1つに潰す。敵の数で上下するので、
    // 最大を取ると波の瞬間だけの数字になり、最小だと誰もいない時の数字になる
    const mid = (buf, m) => {
      if (!m) return null;
      const s = Array.from(buf.subarray(0, m)).sort((a, b) => a - b);
      return s[m >> 1];
    };
    this.diag?.perf({
      fps: fps(at(0.5)),
      // 遅かった5%＝引っかかりの目安。並びの後ろから5%の所
      low: fps(at(0.95)),
      players: this.mode === 'versus' ? (this.net?.players.size | 0) : 1,
      wave: this.mode === 'solo' ? this.director.wave : null,
      /* 何を減らせば軽くなるかの切り分け用。
         calls=描画命令、tris=三角形、scale=描画倍率(%)。
         倍率を%にするのは、受け口(server/report.js)が数字を丸めるため
         （1.5をそのまま送ると2になる） */
      calls: mid(this._infoCalls, this._infoN),
      tris: mid(this._infoTris, this._infoN),
      scale: Math.round((this.renderer?.getPixelRatio() || 0) * 100),
    });
    this._frameN = 0;
    this._frameAt = 0;
    this._infoAt = 0;
    this._infoN = 0;
    this._infoAcc = 0;
  }

  /**
   * 声の状態を画面へ出す。
   *
   * 出すのは**自分が送っているかどうか**と、**マイクが使えない事**の2つだけ。
   * 誰が喋っているかは次の回（相手の声の大きさを測る仕掛けが要る）。
   *
   * マイクを断った事を出しておかないと、押しても何も起きない理由が分からない
   */
  _updateVoiceHud() {
    const v = this.voice;
    if (!v || this.mode !== 'versus' || !v.enabled) { this.hud.voice('off'); return; }
    if (!v.talking) { this.hud.voice('off'); return; }
    // マイクが使えない時も、押している間は出す。**押しても何も起きない理由**が
    // ここに出ていないと、キーが効いていないのか声が届いていないのか分からない
    if (v.micDenied) { this.hud.voice('nomic', 'マイクが使えません'); return; }
    // 繋がっている人数まで出す。0人なら「押せてはいるが届いていない」と分かる
    const n = v.liveCount;
    this.hud.voice('talk', n > 0 ? `送信中 ${n}人へ` : '送信中（相手なし）');
  }

  /* ------------------------------------------ 地面に落ちている物 */

  /**
   * 落ちている物を地面へ置く。**位置は届いた1回きり**なので、
   * 置いた後は動かさない（サーバーも動かさない）。
   *
   * 見た目を武器そのものにしていない理由: 武器の模型は手元で構えるために
   * 作ってある（手が付いていて、目のすぐ前に置く前提の大きさ）ので、
   * 地面に転がすと手だけが巨大に見える。ここは「拾える物がある」と
   * 分かればいいので、光る箱と、そこから立つ細い光にした。
   * **遠くからでも見える必要がある**（近づかないと見えないなら、
   * 落ちていること自体に気づけない）
   */
  _addDrop(did, w, n, p) {
    if (this._dropMeshes.has(did)) return;
    const g = new THREE.Group();
    const gun = w >= 0;
    // 銃なら青、手榴弾だけなら緑。何が落ちているかを色で分ける
    const color = gun ? 0x63d2ff : 0x7ddb8a;
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(0.42, 0.14, 0.22),
      new THREE.MeshStandardMaterial({ color: 0x1a1e24, roughness: 0.6, metalness: 0.4 }),
    );
    box.position.y = 0.09;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.045, 0.045, 1.4, 6, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, side: THREE.DoubleSide }),
    );
    beam.position.y = 0.75;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.28, 0.36, 20),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    g.add(box, beam, ring);
    g.position.set(p[0], p[1], p[2]);
    g.userData.spin = box;
    g.userData.nades = n | 0;
    this.scene.add(g);
    this._dropMeshes.set(did, g);
  }

  /** 拾われた・時間切れで消えた */
  _removeDrop(did) {
    const g = this._dropMeshes.get(did);
    if (!g) return;
    this.scene.remove(g);
    g.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this._dropMeshes.delete(did);
  }

  /** 全部片付ける。試合から抜ける時に呼ばないと、次の試合まで残る */
  _clearDrops() {
    for (const did of [...this._dropMeshes.keys()]) this._removeDrop(did);
  }

  /* 目印の箱をゆっくり回す。動いていないと、地面の模様と見分けが付かない */
  _spinDrops(dt) {
    for (const g of this._dropMeshes.values()) {
      if (g.userData.spin) g.userData.spin.rotation.y += dt * 1.2;
    }
  }

  /** 撃った人をミニマップに出す。同じ人の点は上書きして増やさない */
  _markBlip(id, pos) {
    const b = this._blips.get(id);
    if (b) { b.x = pos.x; b.z = pos.z; b.t = 1; return; }
    this._blips.set(id, { x: pos.x, z: pos.z, t: 1 });
  }

  /* ミニマップと、戦闘範囲の外の警告。1人用と対戦で共通 */
  _minimapFrame(dt) {
    // 撃った点を時間で薄くする。消えた物はその場で捨てる。
    // 残したままにすると、試合が長引くほど描く点が増え続ける
    this._blipList.length = 0;
    for (const [id, b] of this._blips) {
      b.t -= dt / BLIP_FADE_S;
      if (b.t <= 0) this._blips.delete(id);
      else this._blipList.push(b);
    }

    /* **地図を塗り直すのは毎フレームではない。**
       168pxの枠でも、塗り直すたびに 焼いた地図の切り出し＋拡大＋円と点の描画 が走り、
       そのうえ描き上がった絵を毎回画面へ送り直すことになる。60分の1秒ごとにやると、
       小さい絵なのにパソコンが温まり続ける。

       20回/秒にしてある。**他人の位置がサーバーから届くのが20回/秒**なので、
       それより速く塗り直しても他人の点は1つも動かない（自分の向きだけが滑らかになるが、
       168pxの地図でそこを見ている人はいない） */
    this._mapAcc = (this._mapAcc ?? 0) + dt;
    if (this._mapAcc < 1 / MAP_HZ) return;
    this._mapAcc = 0;

    const p = this.player.collider.start;
    const versus = this.mode === 'versus';
    this._mapMe.x = p.x;
    this._mapMe.z = p.z;
    this._mapMe.yaw = this.player.yaw;
    this.hud.minimap(
      this._mapMe,
      this._blipList,
      versus ? ZONE.RADIUS : 0,
      // 対戦は戦う範囲の少し外まで。ソロは場内全域
      versus ? ZONE.RADIUS + 4 : MAP_EXTENT,
    );

    // 範囲外の警告。判定はサーバーが持つが、表示は自分の位置から出す。
    // サーバーの返事を待つと、警告が出た時にはもう削られている
    if (!versus || !this.player.alive) { this.hud.zoneWarn(false); return; }
    if (!outsideZone(p.x, p.z)) {
      this._outsideFor = 0;
      this.hud.zoneWarn(false);
      return;
    }
    this._outsideFor += dt;
    const left = ZONE.GRACE_S - this._outsideFor;
    this.hud.zoneWarn(true, left > 0 ? `${Math.ceil(left)}秒で削られる` : '中央へ戻れ');
  }

  /**
   * 今の画面をクリップボードへコピーする（課題.md #7）。
   *
   * ファイルには保存しない。「クリップボードに入っていればいい、貼るだけで送れる」
   * という要望なので、それ以上は持たない。
   *
   * preserveDrawingBufferは立てない（常時遅くなる）。代わりに、composer.render()の
   * 直後・ブラウザに制御を返す前にtoBlob()を呼ぶことで、描いた直後の中身を読む。
   *
   * clipboard.write()の呼び出し自体はキー入力の流れの中（同じタスク）で行う必要が
   * あるので、ここは同期的に呼ぶ。実際に読む画素（toBlob）はその後で非同期に確定して
   * よい ── ClipboardItemはBlobの代わりにPromise<Blob>を受け付けるので、
   * 「コピー先を確保する」と「中身が揃う」を分けられる
   */
  _screenshot() {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
      this._shotMsg = 'このブラウザはスクショのコピーに対応していません';
      this._shotMsgT = 3;
      return;
    }
    const blob = new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => { this._shotMsg = 'スクショをコピーしました'; this._shotMsgT = 2; })
      .catch(() => { this._shotMsg = 'コピーできませんでした'; this._shotMsgT = 3; });
  }

  /* ------------------------------------------------------- ループ */

  _loop() {
    // 描画命令の数を0へ戻す。ここから次のrender全部（影・AO・ポスト）を数える。
    // autoResetを切ってある理由はboot()のrenderer設定を参照
    this.renderer.info.reset();

    const now = performance.now();
    let dt = (now - this._lastTime) / 1000;
    this._lastTime = now;
    // タブ復帰などで巨大なdtが来ると物理が破綻するので頭を押さえる
    if (dt > 0.1) dt = 0.1;
    if (dt < 0) dt = 0;

    /* 重さを測る。遊んでいる間だけ数える（メニューやロビーの数字を混ぜると、
       描く物が少ない画面のぶんだけ良く見える）。
       頭を押さえた後のdtを使うので、タブを離していた間は0.1で頭打ちになる */
    if (this.state === 'playing' && dt > 0) {
      this._frames[this._frameAt] = dt;
      this._frameAt = (this._frameAt + 1) % FRAME_SAMPLES;
      if (this._frameN < FRAME_SAMPLES) this._frameN++;
    }

    const playing = this.state === 'playing';

    /* 押して話す。**遊んでいる最中もロビーにいる間も同じキーで効く。**
       席を決める相談が一番喋りたい場面なので、試合中だけにはしない。
       発言を打っている最中は送らない（Vの字がそのまま送信になる） */
    if (this.mode === 'versus' && this.voice) {
      this.voice.setTalking(!this.chat?.typing && this.input.down(PTT_CODE));
    }

    if (playing) {
      // 発言を打っている間は、キーを1つもゲームへ通さない。
      // 通すと、打った文字がそのまま移動や武器の切り替えになる。
      //
      // マウスの掴みは外さない。外すと一時停止の画面が出てしまい、
      // 「打とうとしただけなのに試合から離れた」形になる。
      // 掴んだままでも、文字を打つ場所に入力先があれば文字は打てる
      const typing = !!this.chat?.typing;
      // Enterで打つ場所を開く。対戦している時だけ
      if (!typing && this.input.pressed('Enter')) {
        if (this.mode === 'versus') {
          this.chat.open();
        } else {
          // 1人プレイでは発言そのものが無い（対戦専用）。押しても何も
          // 起きないと、遊ぶ側からは壊れているのかキーが違うのか分からない
          // （課題.md #3）。一言だけ出して、放っておけば消える
          this._chatHintT = 2.5;
        }
      }
      this._chatHintT = Math.max(0, (this._chatHintT || 0) - dt);
      this.diag?.setState('chatHint', this._chatHintT > 0 ? '発言は対戦でだけ使えます' : '');
      // Pでスクショをクリップボードへ（課題.md #7）。全画面＋マウス固定なので
      // OSのスクショが撮りにくく、見た目の不具合を言葉だけで詰めることになっていた。
      // typing中はchat.js側がstopPropagationしているのでPはここまで届かない。
      // ここでは押した印だけ立てる。実際に読むのはこの回のcomposer.render()の後
      // （下の_wantShotを参照。ここで即座に読むと真っ白になる不具合があった）
      if (!typing && this.input.pressed('KeyP')) this._wantShot = true;
      this._shotMsgT = Math.max(0, (this._shotMsgT || 0) - dt);
      this.diag?.setState('shot', this._shotMsgT > 0 ? (this._shotMsg || '') : '');
      const input = typing ? this._noInput : this.input;
      // 打っている間も、押した印とマウスの移動量は毎フレーム捨てる。
      // 溜めたままにすると、打ち終わった瞬間に溜まっていた分が一度に効く。
      // 特にlookは、掴んだままなのでmousemoveが溜まり続け、捨てないと
      // 打ち終わりに視点が一気に飛ぶ（_versusFrameは凍結inputを見るので
      // 打っている間はtakeLook()を呼ばず、ここで捨てないと溜まりっぱなしになる）
      if (typing) { this.input.endFrame(); this.input.takeLook(); }

      // 対戦では倒れている間の操作を受け付けない。復帰待ちの3秒に装填や持ち替えを
      // 通すと、湧いた瞬間の弾数がサーバーと食い違う
      const canAct = this.mode !== 'versus' || this.player.alive;
      /* 効かない時は、なぜ効かないかを画面に出す。
         ここが黙って効かなくなるのが一番たちが悪い。
         包帯・リロード・武器の切り替えが全部この1つで止まるので、
         遊ぶ側からは「3つ同時に壊れた」ようにしか見えない。
         実際にWindowsの人から報告された症状のうち3件がこの形だった */
      this.diag?.setState(
        'canAct',
        canAct ? '' : '倒れている間は、包帯・リロード・武器の切り替えが使えません',
      );
      // 包帯はFで手に持つだけ。巻き始めるのは左クリックで、そちらはweapons側が見る。
      // 押した瞬間に巻き始める形をやめたのは、巻いている2.4秒は移動が半分以下に
      // 落ちるので、指が滑って始まった時の代償が大きすぎるため
      if (canAct && input.pressed('KeyF')) {
        const out = this.weapons.toggleBandage(this.player);
        this.audio.click(out ? 1400 : 1000, 0.28, 0.05);
      }
      if (canAct && input.pressed('KeyR')) {
        // 鳴らす音の選び分けは武器側が持つ。1発ずつ入れる武器と
        // 弾倉ごと入れ替える武器で鳴る物が違う
        if (this.weapons.reload()) this.weapons.playReloadSound(this.audio);
      }
      // **持っている物の数だけ回す。** 表にある武器の数ではない。
      // 表には持って出ない物（ショットガン）も入っているので、
      // そちらで回すと押した数字と画面の札がずれる
      const carry = this.weapons.carry;
      for (let n = 0; canAct && n < carry.length && n < 9; n++) {
        if (!input.pressed(`Digit${n + 1}`)) continue;
        const i = carry[n];
        // 包帯を持ったまま武器を選んだらしまう。巻いている最中なら中断する。
        // 数字を押した時点で「戦う」と決めているので、包帯より武器を優先する
        this.player.cancelHeal();
        this.weapons.holsterBandage();
        if (this.weapons.switchTo(i) && this.mode === 'versus') this.net?.sendWeapon(i);
      }

      if (this.mode === 'versus') {
        this._versusFrame(dt, input);
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
        // 落下や自爆で死んだ時にもリザルトへ行く。
        // 以前は「敵に撃たれた」経路にしか死亡の受け口が無く、高い所から落ちて
        // 体力が0になっても操作だけ効かないまま画面が動き続けていた
        if (!this.player.alive) this._onPlayerDown();
        // 倒れる動きはカメラが決まった後に上書きする。
        // player側へ入れると、対戦の他人の描画やリスポーン処理まで巻き込む
        this._deathFall(dt);
        this.director.update(dt, this.player, {});
        this._stepSoloNades(dt);
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

    // 発言の行を古くしていく。遊んでいてもいなくても時間は進むので、
    // どちらの道からも同じだけ薄くなるようここに置く
    this.chat?.update(dt);
    // ロビーの3D。start()されている間だけ描く
    this.charView?.update(dt);

    /* 空はscene.backgroundに焼いてあるので、ここでやることは無い。
       前は球をカメラへ毎フレーム追従させていた（背景のキューブは勝手に付いてくる） */

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
    // 倒れている間は、崩れ落ちるのに合わせて画面を沈めていく。
    // 死んだ瞬間から一定の濃さだと、時間が止まった絵に見える
    const lowHp = this.player.alive
      ? clamp(1 - this.player.health / (this.player.maxHealth * 0.45), 0, 1) * 0.45
      : 0.6 + 0.35 * clamp((this.deathT ?? 0) / DEATH_FALL_S, 0, 1);
    this.fx.grade.uniforms.uDamage.value = Math.min(1, this.damageFlash + lowHp);
    this.fx.grade.uniforms.uTime.value += dt;
    // 覗いている量。ADS中だけ浅い被写界深度を掛けるのに使う
    this.fx.grade.uniforms.uAds.value = this.weapons.adsFactor;

    // 体力を音側へ渡す。低体力の心音と呼吸が鳴る
    this.audio.setVitals(this.player.health / this.player.maxHealth, this.player.alive);
    // 試合の中かどうかも渡す。遠景の撃ち合いを試合の外で鳴らさないため。
    // 一時停止と死亡画面は試合の続きなので鳴らしたままにする
    this.audio.battle = this.state === 'playing' || this.state === 'paused' || this.state === 'dead';
    this._updateEnvironment(dt);

    // 影の箱はカメラの位置が決まった後でないと置けない
    this._updateSunCascades();

    /* メニュー・ロビーの間は毎フレーム描かない。
       ホームもロビーもDOMの画面で、後ろの3Dはほぼ塗り潰されて見えないのに、
       影・AO・ブルームまで全部の行程が毎フレーム回っていた
       （閉じずに置いているだけでファンが回る、の原因の1つ）。
       1枚だけ描いて止める。キャンバスは最後に描いた絵を出し続けるので、
       止めても画面は変わらない。窓の大きさが変わった時だけ描き直す（_resize参照）。
       一時停止(paused)と死亡画面(dead)は後ろで試合が見えているので今まで通り描く */
    const idle = this.state === 'menu';
    if (!idle || !this._idleDrawn) this.fx.composer.render();
    this._idleDrawn = idle;

    /* 描画命令と三角形は描き終わった後に読む（ここまでの合計がこのフレームの数）。
       毎フレームは取らない。1秒の中ではほぼ動かない数字なので、1秒に1回で足りる */
    const rinfo = this.renderer.info.render;
    if (this.state === 'playing') {
      this._infoAcc += dt;
      if (this._infoAcc >= 1) {
        this._infoAcc = 0;
        this._infoCalls[this._infoAt] = rinfo.calls;
        this._infoTris[this._infoAt] = rinfo.triangles;
        this._infoAt = (this._infoAt + 1) % PERF_INFO_SAMPLES;
        if (this._infoN < PERF_INFO_SAMPLES) this._infoN++;
      }
    }
    // ?debugの数字窓。作っていない時（普段）はnullで何もしない
    this.perfMeter?.frame(dt, rinfo.calls, rinfo.triangles, this.renderer.getPixelRatio());

    // Pの押した印はここで拾う。preserveDrawingBufferを立てていないので、
    // 描いた直後・ブラウザに制御を返す前でないと中身が読めない
    // （render()より前で読んでいた時は、真っ白なままコピーされることがあった）
    if (this._wantShot) { this._wantShot = false; this._screenshot(); }
  }
}

const game = new Game();
window.__game = game;   // 動作確認用の口
game.boot().catch((err) => {
  console.error(err);
  document.getElementById('loadMsg').textContent = 'FAILED — ' + err.message;
});
