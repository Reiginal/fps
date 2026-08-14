// 音源ファイルを持たず、ノイズとフィルタで効果音を合成する。
// 銃声は距離で「音量が変わる」のではなく「別の音になる」。近くは乾いたクラック、
// 中距離は残響が主役、遠くは低音のドスンだけが届く。ここを作り分けないと
// どれだけ層を重ねても平坦に聞こえる。
import { VOLUME_DEF } from './settings.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rnd = (a, b) => a + Math.random() * (b - a);
// 0→1の滑らかな遷移。距離帯の混ぜ具合に使う
const step = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

const SOUND_SPEED = 343;

// 足音の素材別パラメータ。踏み込みの低音・粒立ち・共鳴で「踏んだ物」を作り分ける。
// partialsは非整数比にしてある。整数比にすると楽器の音程に聞こえて金属に感じない
const SURFACES = {
  dirt:     { lp: 950,  thump: 74,  decay: 0.055, grit: 0.55, gritFreq: 2400, gritQ: 0.9, ring: 0,    partials: null,             vol: 1.0 },
  gravel:   { lp: 1150, thump: 80,  decay: 0.05,  grit: 0.8,  gritFreq: 3200, gritQ: 0.8, ring: 0,    partials: null,             vol: 1.0 },
  asphalt:  { lp: 1700, thump: 96,  decay: 0.042, grit: 0.34, gritFreq: 3800, gritQ: 1.1, ring: 0,    partials: null,             vol: 0.95 },
  concrete: { lp: 1900, thump: 104, decay: 0.04,  grit: 0.3,  gritFreq: 4200, gritQ: 1.3, ring: 0.08, partials: [820, 1970],      vol: 0.95 },
  // ringを0.62から0.10へ、倍音も3本から2本の低い所へ落とす。
  // 前は186/471/1237Hzという調律された倍音を長い余韻付きで鳴らしていて、
  // これは「叩かれた金属の棒」＝鉄琴の作り方そのものだった。
  // 実際の鉄板は踏むと鳴るのではなく「ぼこっ」と凹んで軋む。
  // 余韻を削って、倍音を濁った近い2本にすると打楽器に聞こえなくなる
  metal:    { lp: 1900, thump: 124, decay: 0.062, grit: 0.30, gritFreq: 4200, gritQ: 1.1, ring: 0.10, partials: [173, 268], vol: 0.95 },
  wood:     { lp: 1400, thump: 128, decay: 0.055, grit: 0.22, gritFreq: 2100, gritQ: 1.2, ring: 0.34, partials: [243, 617, 1490], vol: 0.9 },
};

/**
 * 倒した合図の候補。遊びながらKキーで切り替えて聴き比べる。
 *
 * なぜ候補を並べるのか: 「気持ちよくない」と言われるたびに1案ずつ作り直して
 * 5回外した。こちらは音を聴けないので、1往復で1案しか試せないやり方だと
 * いつまでも当たらない。質感の方向が違う案を先に並べて、その場で比べてもらう。
 *
 * 5案は3つの軸で振り分けてある。
 *   ・倍音が整数比か非整数比か … 整数比は楽器の音程に、非整数比は金属や鐘になる
 *   ・音程を持たせるか否か     … ノイズ主体にすると音程感が消えて打撃寄りになる
 *   ・低音を混ぜるか           … 低音は重さになるが、混ぜすぎると歯切れが鈍る
 *
 * どの案も共通で守っている所は3つ。立ち上がりを1ms以下にする（鈍ると
 * 弾いた感じが消える）、主な成分を2〜6kHzに置く（銃声は低音が主役なので、
 * ここに置くと撃ち合いの中でも埋もれない）、350ms以内に終わらせる。
 */
/**
 * 倒した合図の設定。
 *
 * ここに至った経緯: 「軽い」「甲高い」「デデンにして」と何度も作り直した。
 * こちらは音を聴けないので良し悪しの判定ができず、7回とも外した。
 * 一時期はロビーにつまみを出して遊ぶ側が直接回せるようにしていたが、
 * 決まったので畳んだ。作り直したくなったら、まずこの値を触る。
 *
 * 各項目が何を動かすか:
 *   hits   … 打点の数。1でドン、2でデデン、3でデデデン
 *   pitch  … 全体の高さ。下げるほど重く、上げるほど鋭くなる
 *   gap    … 打点の間隔(秒)。詰めるほど1発に近づく
 *   tail   … 最後の打点の余韻。伸ばすと鳴り物、詰めると打楽器に寄る
 *   weight … 低い所の量。これが「重さ」。0にすると軽い通知音になる
 *   edge   … 上の芯の量。「甲高い⇔こもる」はここで決まる
 *   drive  … 歪みの量。上げると倍音が増えて太くなるが、行きすぎると割れた音になる
 *
 * 数字の当たりを付ける時は tools/sound-lab.mjs で書き出して測る。
 * 低音の割合・重心・長さ・打点の数が数字で出る
 */
export const KILL_TUNE = {
  hits: 2, pitch: 1, gap: 0.155, tail: 1, weight: 1, edge: 0.3, drive: 2.8, level: 1,
};

/**
 * 刃を振る音の作り。**「鈍い」と言われて作り直した所。**
 *
 *   band    … 帯域の [開始, 頂点, 終わり] Hz。**頂点がシュッとゴォを分ける**
 *   at      … [頂点までの秒, 終わりまでの秒]。短いほど鋭く通り過ぎる
 *   q       … 帯の細さ。低いと広がって、ノイズがそのまま「ゴォ」になる
 *   gain    … 芯の音量
 *   env     … [立ち上がり, 減衰] 秒
 *   rate    … ノイズの再生速度の範囲。高いほど粒が細かい
 *   edge    … 刃先の鳴きの量。0で無し。伸ばすと金属の残響になる
 *   air     … 押しのける空気の [開始, 頂点, 終わり] Hz
 *   airGain … 空気の量。**芯に対する比。** ここが1.0だと前の鈍い音に戻る
 *   airDec  … 空気の減衰(秒)
 *   pulse   … [刻みHz, 深さ0〜1]。音量を矩形波で刻む。**機械の点火の音**なので
 *             チェーンソーだけが持つ（刃物は連続して空気を切るから刻まない）
 *
 * 数字の当たりは tools/sound-lab.mjs で書き出して測る。
 * **ただし最後は聴いて決める。**測って良く見える音が鈍いことがある（実際そうだった）
 */
export const SWING_TUNE = {
  band: [1900, 6200, 2400], at: [0.042, 0.105], q: 3.0,
  gain: 1.40, env: [0.004, 0.075], rate: [1.3, 1.7],
  edge: 0.45,
  air: [310, 740, 270], airGain: 0.38, airDec: 0.11,
};

/**
 * 強い一撃の振る音。**通常より低く、長く、空気が重い。**
 *
 * 同じ音を大きくするだけだと「近くで振った」にしか聞こえない。
 * 重い物を振ると空気の量が増えて、通り過ぎるのに時間がかかる。
 * 芯を1オクターブ弱下げて、空気の比を倍にしてある
 */
export const SWING_HEAVY_TUNE = {
  band: [1100, 3800, 1500], at: [0.070, 0.170], q: 2.4,
  gain: 1.55, env: [0.006, 0.130], rate: [0.9, 1.15],
  edge: 0.30,
  air: [220, 560, 200], airGain: 0.80, airDec: 0.20,
};

/**
 * 形ごとの振る音。**刃の長さと薄さが音を決める。**
 *
 * 同じ「シュッ」でも、刀は長いぶん空気を切っている時間が長く、
 * 薄いぶん刃先が高く鳴る。ダガーは短いので一瞬で終わる。
 * 見た目だけ変えて音が同じだと、持ち替えた実感が出ない。
 *
 * 表に無い形は SWING_TUNE / SWING_HEAVY_TUNE（ナイフ）へ落ちる
 */
export const SWING_TUNES = {
  /* 刀。**長く、澄んで、刃先が鳴る。**
     帯の頂点を上げて、減衰を伸ばし、刃先の鳴き(edge)を倍近くにしてある。
     空気を減らしているのは、薄い刃は空気を押しのけずに割って通るため */
  katana: {
    light: {
      band: [2200, 7400, 2900], at: [0.048, 0.135], q: 3.6,
      // 音量を1.38から下げた。**測ったら12本の中で一番大きかった**
      // （0.58。レイピア0.45・ナイフ0.47）。刀が一番うるさい理由が無い
      gain: 1.26, env: [0.004, 0.125], rate: [1.45, 1.85],
      edge: 0.78,
      air: [330, 700, 250], airGain: 0.26, airDec: 0.16,
    },
    // 刺突。腰へ引いてから出すので、音も遅れて伸びる
    heavy: {
      band: [1500, 5200, 2000], at: [0.085, 0.215], q: 3.0,
      /* **ダガーの右と作り分ける。** 2026-08-12に測ったら
         刀の右(886ms/低音4.7%/重心6260Hz)とダガーの右(886/4.5/6265)が
         **ほぼ同一の音**だった。長い刀は遅く伸ばし、短いダガーは速く切る */
      gain: 1.46, env: [0.006, 0.200], rate: [0.95, 1.22],
      edge: 0.62,
      air: [250, 600, 220], airGain: 0.72, airDec: 0.28,
    },
  },
  /* ---- 2026-08-11に足した3つ。**音でも軸道の違いを出す。**
     見た目と振り方を分けても、音が同じだと着け替えた実感が半分になる */

  /* レイピア。**一番高く細い。** ダガー(2600〜8200)よりさらに上へ。
     細い刃は押しのける空気がほとんど無いので、空気の層(air)を一番小さくする */
  rapier: {
    light: {
      band: [3200, 9500, 4200], at: [0.024, 0.060], q: 3.8,
      gain: 1.20, env: [0.002, 0.038], rate: [1.9, 2.3],
      edge: 0.58,
      air: [420, 900, 340], airGain: 0.10, airDec: 0.05,
    },
    heavy: {
      band: [2400, 7200, 3000], at: [0.040, 0.098], q: 3.2,
      gain: 1.36, env: [0.004, 0.070], rate: [1.35, 1.65],
      edge: 0.50,
      air: [320, 720, 280], airGain: 0.30, airDec: 0.11,
    },
  },

  /* 斧。**一番低く重い。** 空気の層を一番大きく取る
     （重い物は押しのける空気の量が多い。SWING_HEAVY_TUNEと同じ考え方の延長）

     **2026-08-12に伸ばした。** 測ったら12本の中で**一番短い音**(344ms)だった。
     一番遅く振る武器（振り0.58秒）の音が一番早く終わっていて、
     低さは出ていたのに「重い物を振っている時間」が出ていなかった */
  axe: {
    light: {
      band: [700, 2600, 1100], at: [0.080, 0.240], q: 2.2,
      gain: 1.55, env: [0.010, 0.245], rate: [0.72, 0.92],
      edge: 0.30,
      air: [140, 420, 180], airGain: 1.00, airDec: 0.36,
    },
    heavy: {
      band: [560, 2100, 900], at: [0.100, 0.290], q: 2.0,
      gain: 1.62, env: [0.012, 0.310], rate: [0.60, 0.78],
      edge: 0.26,
      air: [110, 360, 150], airGain: 1.30, airDec: 0.44,
    },
  },

  /* グローブ。**刃の音を持たない。** 布と革が押し出す風の音。
     刃物は「切る」＝高い所が細く伸びるが、拳は「叩く」＝短く止まる。

     **2026-08-12に作り直した。** 測ったら12本で**一番静か**(0.27。次が0.36)で、
     しかも帯が900〜3400Hzに残っていて**細い風切り音**が鳴っていた。
     拳は刃ではないので、風切りではなく「ブンッ」という厚い風でなければいけない。
     帯を1オクターブ下げ、切れの成分(edge)をほぼ0にして、空気を3倍近くにした。
     **空気は斧より下に置く**（一番重いのは斧、という関係は崩さない）*/
  glove: {
    light: {
      band: [720, 2600, 980], at: [0.026, 0.058], q: 1.3,
      gain: 1.85, env: [0.003, 0.040], rate: [1.35, 1.65],
      edge: 0.05,
      /* 空気の層(airGain)は**斧より下**に置く。重い物を振っているのは斧の担当で、
         拳は「厚いが短い」。ただし帯そのものが低いので、測った低音の割合は
         斧と並ぶ所まで来る（0.92まで上げた時は11.9%で斧を越えた）*/
      air: [190, 560, 230], airGain: 0.70, airDec: 0.09,
    },
    heavy: {
      band: [560, 2000, 800], at: [0.044, 0.098], q: 1.25,
      gain: 1.95, env: [0.005, 0.070], rate: [1.00, 1.24],
      edge: 0.04,
      air: [150, 460, 190], airGain: 0.84, airDec: 0.14,
    },
  },

  /* ---- 2026-08-12に足した2つ。**どちらも刃の風切りではない。** */

  /* 鎖鎌。**鎖が鳴る。**
     刃は小さいので風切りはほとんど出ない。代わりに鉄の輪が擦れて鳴る音を出す。
     帯を中ほどに置いて、**刃先の鳴き(edge)を高く**取る
     （細い金属が擦れる高い音がそこから出る）。
     空気は少ない——小さい鎌は空気を押しのけない */
  kusarigama: {
    light: {
      /* 帯と刃先の鳴きは、測ってから下げた。
         最初に置いた[1800,6000]・edge0.66だと重心8219Hzで、
         **日本刀(8071Hz)とほぼ同じ音**になっていた。
         鎖は「高く澄む」ではなく「硬い物が擦れる」なので、そのぶん下げる */
      band: [1400, 4600, 1900], at: [0.034, 0.086], q: 2.6,
      gain: 1.30, env: [0.003, 0.062], rate: [1.5, 1.9],
      edge: 0.44,
      air: [280, 660, 240], airGain: 0.22, airDec: 0.08,
    },
    // 分銅を叩きつける。**鎖ごと回すので長い。** 空気も重くなる
    heavy: {
      band: [760, 3000, 1200], at: [0.070, 0.180], q: 2.2,
      gain: 1.52, env: [0.006, 0.145], rate: [1.0, 1.28],
      edge: 0.34,
      air: [200, 520, 200], airGain: 0.74, airDec: 0.22,
    },
  },

  /* チェーンソー。**唯一の「機械」の音。**
     刃物の「シュッ」でも拳の「ブンッ」でもなく、**唸り**を出す。

     Qを一番低くして帯を広げるのが要点で、
     細い帯は「刃が空気を割る」音になるが、広い帯はノイズがそのまま唸る。
     ここは他の武器で全部「避けてきた」作りなので、ここだけ逆を踏む。
     長さも一番長く取る（動いている物なので、振り終わっても鳴っている）

     **2026-08-15に脈(pulse)を足した。** 広い帯だけだと「ゴォ」＝風の音と
     区別が付かず、機械に聞こえていなかった。エンジンは点火が1回ずつ別の
     破裂なので、音量をその速さで刻むと「ドュルルル」になる。
     右は左より刻みを遅くする（重く当てると回転が落ちる）*/
  chainsaw: {
    light: {
      band: [260, 1100, 420], at: [0.050, 0.150], q: 0.9,
      gain: 1.44, env: [0.010, 0.230], rate: [0.9, 1.06],
      edge: 0.10,
      air: [160, 480, 200], airGain: 0.60, airDec: 0.26,
      /* 刻みは最初105Hzに置いたが、帯(260〜1100Hz)のフィルタが谷を均してしまい、
         包絡で測ると深い谷が9個しか立たなかった。遅くすると谷の幅が広がって
         均されずに残る（80Hzで14個、右は60Hzで21個。刀は1個）*/
      pulse: [80, 0.85],
    },
    heavy: {
      band: [200, 860, 330], at: [0.080, 0.240], q: 0.8,
      gain: 1.58, env: [0.012, 0.320], rate: [0.78, 0.94],
      edge: 0.08,
      air: [130, 400, 165], airGain: 0.78, airDec: 0.34,
      pulse: [60, 0.85],
    },
  },

  /* ダガー。**短く、高く、乾いている。**
     減衰を半分にして、空気をほとんど無くしてある。
     短い刃は押しのける空気の量そのものが少ない */
  dagger: {
    light: {
      band: [2600, 8200, 3400], at: [0.024, 0.058], q: 3.4,
      // **一番短く切る。** レイピアは「高くて細い」で持っていくので、
      // ダガーは高さではなく短さで分ける（同じ方向で競うと聴き分けられない）
      gain: 1.26, env: [0.002, 0.030], rate: [1.8, 2.2],
      edge: 0.52,
      air: [360, 800, 300], airGain: 0.16, airDec: 0.045,
    },
    /* 突き上げ。**刀の右と作り分ける。** 前は帯も長さもほぼ同じで、
       測ると886ms/重心6265Hzと刀の右(886ms/6260Hz)が同じ音になっていた。
       短い刃は速く高く切って、長い刀は遅く低く伸ばす */
    heavy: {
      band: [2000, 6600, 2600], at: [0.042, 0.096], q: 2.8,
      gain: 1.44, env: [0.004, 0.058], rate: [1.35, 1.70],
      edge: 0.44,
      air: [270, 640, 240], airGain: 0.32, airDec: 0.10,
    },
  },
};

/** その形・その強さの振る音。無ければナイフの音 */
export const swingTune = (shape, heavy) =>
  SWING_TUNES[shape]?.[heavy ? 'heavy' : 'light']
  || (heavy ? SWING_HEAVY_TUNE : SWING_TUNE);

/**
 * 形ごとの銃声。**着けた見た目の通りに鳴らないと、着けた気がしない。**
 *
 * 元の武器の音に**上書きで被せる**（全部を書き直さない）ので、
 * 書かなかった層は元の銃のまま鳴る。どの数字が何に効くかは gunshot() の頭。
 */
export const SHAPE_GUN = {
  /* ドラゴン。**低く鈍く。**
     破裂の帯(crackFreq)を半分以下まで下げて、そのぶん胴と尾を伸ばす。
     鈍いというのは「高い所が無い」ことなので、
     クラックの量(crackVol)を落とすのが一番効く。
     腹に来る低音は長く垂らす（唸りではなく、押される感じになる所まで） */
  dragon: {
    volume: 0.88, bodyFreq: 150, crackFreq: 1500,
    bodyDecay: 0.36, tailDecay: 1.05, tailVol: 0.56, crackVol: 0.20,
    thumpFrom: 150, thumpTo: 24, thumpTime: 0.30,
    subVol: 0.70, subTime: 0.34, subDelay: 0.03,
  },
  /* キャンディ。**軽くて高い「ピュン」。**
     銃声の低い層を全部抜いて、代わりに**低音の層を音程として使う。**
     thumpFrom→thumpTo は本来「腹に来る低音」だが、
     1150Hzから320Hzへ0.05秒で滑らせると玩具の発射音になる
     （ここだけが唯一の音程のある層なので、可愛い音はここでしか作れない）。
     機関部の音(mech)も切る。金属がぶつかる音が入ると玩具に聞こえない */
  cute: {
    // 音量は0.52から下げた。**音程のある層は音程の無いノイズより山が高い**ので、
    // 同じ音量の数字でも山が0.91まで来ていた（1.0で割れる）
    volume: 0.42, bodyFreq: 1500, crackFreq: 5600,
    bodyDecay: 0.05, tailDecay: 0.14, tailVol: 0.12, crackVol: 0.20,
    thumpFrom: 1150, thumpTo: 320, thumpTime: 0.055,
    subVol: 0.02, subTime: 0.05,
    mech: false,
  },

  /* ---- 2026-08-11に足した3つ。**見た目を足したら音も足す。**
     ドラゴンとキャンディで「着けた見た目の通りに鳴らないと着けた気がしない」を
     やってあるので、新しい3つを黙って元の銃の音のままにはしない ---- */

  /* ウエスタン（ショットガン）。**木の胴が鳴る音。**
     元のショットガン(胴380Hz・破裂2600Hz・尾0.70秒)から、
     胴を240まで下げて尾を0.92まで伸ばす。**木は金属より高い所が減る**ので
     破裂の帯も2000へ落とす。

     ドラゴンほど極端にしない（あちらは破裂1500・尾1.05）。
     木は「鈍い」のではなく「響く」ので、削るのは高い所だけにして
     胴と尾は残す。低音の取り分はドラゴンより少なく、元の銃より多い所を狙う */
  western: {
    volume: 0.86, bodyFreq: 240, crackFreq: 2000,
    bodyDecay: 0.30, tailDecay: 0.92, tailVol: 0.50, crackVol: 0.26,
    thumpFrom: 130, thumpTo: 34, thumpTime: 0.24,
    subVol: 0.62, subTime: 0.30, subDelay: 0.03,
  },

  /* アイス（狙撃銃）。**氷が割れる音。**
     元の狙撃銃は低くて大きい（胴180Hz・低音34.6%）。
     そこから**低い層を削って、高い所を主役にする。**
     氷は「重い」音ではなく「硬くて澄んだ」音なので、
     胴を520へ上げ、破裂を5200へ上げ、腹に来る低音(sub)をほぼ切る。

     尾は残す（0.55秒）。**尾を切ると乾いた破裂になって、氷の余韻が消える。**
     キャンディのように短く切らないのはそこが違う */
  ice: {
    volume: 0.70, bodyFreq: 520, crackFreq: 5200,
    bodyDecay: 0.10, tailDecay: 0.55, tailVol: 0.34, crackVol: 0.86,
    thumpFrom: 300, thumpTo: 120, thumpTime: 0.06,
    subVol: 0.08, subTime: 0.10, subDelay: 0.0,
  },

  /* サイバー（拳銃）。**電子の発射音。**
     キャンディと同じ手を使う（低音の層を音程として使う）が、**滑る向きが逆。**
     キャンディは1150→320へ落として玩具にしているので、
     こちらは**上げる**。上がる音程は「充電して撃った」に聞こえる
     （同じ層を逆向きに使うだけで、系統が完全に分かれる）。

     2026-08-14に滑りを260→1500から420→2400へ上げた。
     サイレンサーをピュン（1250→380で落ちる）にした時、
     「サイバーの方が甲高い」の関係をはっきりさせるため
     （落ちる方の頭1250と上がる方の頭1500では、並べた時に差が出なかった）。

     機関部の音(mech)は切る。**真鍮が跳ねる音が入ると電子銃に聞こえない**
     ——ここはキャンディと同じ理由 */
  cyber: {
    volume: 0.46, bodyFreq: 1200, crackFreq: 6200,
    bodyDecay: 0.06, tailDecay: 0.22, tailVol: 0.18, crackVol: 0.28,
    thumpFrom: 420, thumpTo: 2400, thumpTime: 0.06,
    subVol: 0.04, subTime: 0.06,
    mech: false,
  },

  /* ---- 各武器2つ目のぶん。**1つ目と音でも分ける。**
     見た目だけ2種類あって音が同じだと、着け替えた実感が半分になる ---- */

  /* 装甲（ライフル）。**鉄の箱の中で鳴る音。**
     元のライフル(胴300・破裂3600・尾0.62)から、
     装甲で覆われたぶん**響きが閉じる**方向へ。
     胴を上げて尾を切り、破裂を落とす（硬い箱は高い所を吸わずに短く返す）。
     ドラゴン（胴150・破裂1500の鈍い方）とは、破裂の残り方で分かれる */
  armor: {
    /* **重心では逃げ場が無かった。**
       一度 破裂1900 まで下げて重心1733まで持っていったが、
       ドラゴン(1919)と186Hzしか離れず落ちた。
       ライフルは形違いが4つ（ドラゴン1919・キャンディ3224・桜2706）あるので、
       **重心の軸だけでは空いている窓が無い。**

       なので別の軸で離す。**尾の長さ。**
       鉄の箱を叩いた音は「硬くて短い」ので、尾を0.22まで切る
       （ドラゴン1.05・桜1.10の5分の1）。
       破裂は残して硬さを出す。重心が近くても、
       5倍違う余韻は耳には別の音として届く */
    volume: 0.88, bodyFreq: 560, crackFreq: 4400,
    bodyDecay: 0.10, tailDecay: 0.22, tailVol: 0.20, crackVol: 0.85,
    thumpFrom: 130, thumpTo: 44, thumpTime: 0.12,
    subVol: 0.30, subTime: 0.14, subDelay: 0.02,
  },

  /* 桜（ライフル）。**澄んで長く残る音。**
     漆器と金物の系統なので、**尾を一番長く取る**（鐘の余韻に寄せる）。
     破裂は元より上げて、澄んだ高い所を残す。
     キャンディ（胴1500・尾0.14の短い方）とは尾の長さで正面から分かれる */
  sakura: {
    volume: 0.74, bodyFreq: 620, crackFreq: 4200,
    bodyDecay: 0.16, tailDecay: 1.10, tailVol: 0.44, crackVol: 0.80,
    thumpFrom: 240, thumpTo: 96, thumpTime: 0.08,
    subVol: 0.16, subTime: 0.14,
  },

  // **サメ（ショットガン）は2026-08-14に見た目ごと消した**（経緯は protocol.js の SHAPE_LIST）

  /* ヴェノム（狙撃銃）。**低く粘る音。**
     アイス（硬くて澄む／胴520・破裂5200）に対して、こちらは**逆へ振る。**
     胴を下げて尾を長く垂らし、破裂を落とす。
     蛇の系統なので「鋭い」ではなく「重く残る」方が合う。
     ドラゴンと向きは同じだが、あちらより破裂を残して狙撃銃の芯を保つ */
  /* ヴェノム（狙撃銃）。**2026-08-11に作り直した。**
     「ベノムとかって銃声全く変わってないよね」と言われて、その通りだった。

     最初は 胴165・尾1.30 に置いていたが、**元の狙撃銃が既に 胴180・尾1.50** で
     低くて長い銃なので、そこから少し下げても何も変わらない。
     測って比べていたのは「アイスとの違い」だけで、**元の銃との違いを見ていなかった。**
     検査にその穴があった（今は元の銃とも比べている）。

     方向を変えて、**元の銃から「重さ」を抜く。**
     蛇が咬むのは速くて乾いた動きなので、
     胴を340（元の倍近く）へ上げ、尾を0.62（元の4割）へ切り、
     腹に来る低音(sub)を0.72→0.10でほぼ消す。
     **狙撃銃の轟きが無くなるので、元との違いが一番はっきり出る。**
     アイス（胴520・破裂5200の明るい方）とも、胴と破裂の両方で離れている */
  venom: {
    volume: 0.80, bodyFreq: 340, crackFreq: 2000,
    bodyDecay: 0.12, tailDecay: 0.62, tailVol: 0.34, crackVol: 0.55,
    thumpFrom: 260, thumpTo: 110, thumpTime: 0.07,
    subVol: 0.10, subTime: 0.10, subDelay: 0.0,
  },


  /* 星（狙撃銃）。**遠くまで届く澄んだ音。**
     アイス(破裂5200・尾0.55)・ヴェノム(破裂2000・尾0.62)と離す。
     望遠鏡の系統なので、**尾を一番長く**取って余韻を残す
     （空へ抜ける音に寄せる）。破裂は中ほどに置いて、どちらとも被らせない */
  astro: {
    volume: 0.82, bodyFreq: 260, crackFreq: 3600,
    bodyDecay: 0.24, tailDecay: 1.60, tailVol: 0.56, crackVol: 0.66,
    thumpFrom: 180, thumpTo: 60, thumpTime: 0.22,
    subVol: 0.40, subTime: 0.26, subDelay: 0.02,
  },

  /* 竹（狙撃銃）。**木の筒が鳴る音。**
     アイス・ヴェノム・星の3つと離す必要がある。
     竹は中が空洞なので、**胴を高く・尾を短く**取る
     （空洞の筒は「コン」と鳴って止まる。詰まった木は響く） */
  bamboo: {
    volume: 0.78, bodyFreq: 700, crackFreq: 2600,
    bodyDecay: 0.10, tailDecay: 0.30, tailVol: 0.24, crackVol: 0.52,
    thumpFrom: 200, thumpTo: 78, thumpTime: 0.09,
    subVol: 0.20, subTime: 0.12,
  },


  /* サイレンサー（拳銃）。**映画の消音銃の「ピュン」。**
     2026-08-14に作り直した。最初は「腹に来ない低音＋カシャッ」の地味な音に
     していたが、「もうちょい音大きくというか、ピュンピュンピュンぐらいに
     してほしい」と言われた。静かさそのものより、**消音銃らしい記号**が商品になる。

     ピュンはキャンディと同じ手（音程のある層を速く滑らせる）で、
     1250→380を0.05秒で**落とす**。上げるのはサイバーだけ（check-soundが見ている）。
     破裂は潰したまま（消音器なので）、機関部の「カシャッ」は残す。
     音量は0.34から0.44へ。それでも品揃えで一番静か（0.5未満を検査が見ている） */
  suppressed: {
    volume: 0.44, bodyFreq: 300, crackFreq: 1400,
    bodyDecay: 0.08, tailDecay: 0.16, tailVol: 0.12, crackVol: 0.10,
    thumpFrom: 1250, thumpTo: 380, thumpTime: 0.05,
    subVol: 0.06, subTime: 0.06,
  },

  /* ---- 2026-08-12に足した2つ。**形ごと別の銃になる物なので、音も別の銃にする。**
     飾りを足しただけの物は元の音を少し曲げれば足りるが、
     こちらは持ち替えたら別の銃なので、元の音の面影を残す必要が無い */

  /* リボルバー（拳銃）。**一番大きくて一番低い拳銃。**
     今の4つは 元(胴420・破裂3900・尾0.38)／サイバー(1200・6200)／
     クローム(760・4600)／スケルトン(220・2200) で、
     **低い方はスケルトンが押さえている**が、あちらは「機械が動く音」で
     破裂が弱い(0.44)。こちらは逆に**破裂が一番強い**。

     太い薬莢は「腹に来る低音＋鋭い破裂」が同時に来る。
     尾も伸ばす（回転弾倉と鉄の枠がそのまま鳴る） */
  revolver: {
    volume: 0.92, bodyFreq: 300, crackFreq: 3200,
    bodyDecay: 0.26, tailDecay: 0.78, tailVol: 0.52, crackVol: 1.05,
    thumpFrom: 170, thumpTo: 42, thumpTime: 0.26,
    subVol: 0.62, subTime: 0.30, subDelay: 0.02,
  },

  /* ブルパップ（ライフル）。**機関部が耳の横にある銃。**
     ドラゴン(破裂1500・尾1.05)・キャンディ(5600・0.14)・装甲(4400・0.22)・
     桜(4200・1.1)の4つから離す。

     ブルパップは薬室が頬のすぐ横にあるので、実物でも「うるさい銃」と言われる。
     **破裂を一番高く、機関部の金属音を強く、尾は短く。**
     耳のそばで金属が鳴っている感じにする */
  bullpup: {
    volume: 0.86, bodyFreq: 520, crackFreq: 6800,
    bodyDecay: 0.09, tailDecay: 0.30, tailVol: 0.26, crackVol: 1.00,
    thumpFrom: 200, thumpTo: 70, thumpTime: 0.08,
    subVol: 0.18, subTime: 0.10,
  },

  /* 対物ライフル（狙撃銃）。**一番大きくて一番低い。**
     アイス(5200・0.55)・ヴェノム(2000・0.62)・星(3600・1.60)・竹(2600・0.30)から離す。

     口径が違う銃なので、**腹に来る低音を一番長く垂らす。**
     制退器が横へ抜くぶん、破裂は前ではなく左右へ広がる＝尾に厚みが出る */
  antimat: {
    volume: 1.00, bodyFreq: 170, crackFreq: 2900,
    bodyDecay: 0.42, tailDecay: 1.20, tailVol: 0.70, crackVol: 0.86,
    thumpFrom: 140, thumpTo: 22, thumpTime: 0.44,
    subVol: 0.90, subTime: 0.48, subDelay: 0.03,
  },

  /* 猟銃（狙撃銃）。**山で鳴る1発。**
     木の銃床は金属より響かないので、機関部の金属音が少ない。
     破裂は素直に高く、**尾は谷へ抜けるように長く薄く**取る
     （星の尾1.60は「空へ抜ける」で厚い。こちらは薄い） */
  hunter: {
    volume: 0.80, bodyFreq: 340, crackFreq: 4200,
    bodyDecay: 0.16, tailDecay: 0.95, tailVol: 0.30, crackVol: 0.72,
    thumpFrom: 165, thumpTo: 55, thumpTime: 0.16,
    subVol: 0.30, subTime: 0.20, subDelay: 0.01,
  },

  /* ソードオフ（ショットガン）。**銃身が短いほど音は大きく短い。**
     筒が短いと火薬が銃口の外で燃えるので、前へ抜ける音が増えて余韻が減る。
     元のショットガン(胴380・破裂2600・尾0.7)と、
     ウエスタン(胴240・破裂2000・尾0.92)から離す必要がある。

     胴を一番低く、破裂を一番強く、**尾は一番短く。**
     「ドンッ」で終わるのがこの銃の音で、伸ばすと切った意味が消える */
  sawedoff: {
    volume: 1.00, bodyFreq: 240, crackFreq: 2100,
    bodyDecay: 0.30, tailDecay: 0.22, tailVol: 0.30, crackVol: 1.15,
    thumpFrom: 150, thumpTo: 30, thumpTime: 0.30,
    subVol: 0.80, subTime: 0.34, subDelay: 0.02,
  },

  /* ---- 2026-08-15に足した2つ（経緯は protocol.js の SHAPE_LIST）。
     ショットガンの棚は 元(胴380・破裂2600・尾0.70)／ウエスタン(240・2000・0.92)／
     ソードオフ(240・2100・0.22) で、破裂が2000〜2600に固まっている。
     なので1本は上（3400）、1本は下（1400）へ出して帯を割る */

  /* レバーアクション。**乾いた鋭い1発。**
     裸の銃身は放熱筒もガスの逃げも無いので、前へ抜ける音が素直に高く出る。
     破裂を棚で一番高く、尾は鋼の機関部が短く鳴る程度に残す */
  lever: {
    volume: 0.94, bodyFreq: 340, crackFreq: 3400,
    bodyDecay: 0.18, tailDecay: 0.55, tailVol: 0.36, crackVol: 1.00,
    thumpFrom: 150, thumpTo: 40, thumpTime: 0.20,
    subVol: 0.50, subTime: 0.24, subDelay: 0.02,
  },

  /* ドラム。**低く籠もる腹。**
     マズルブレーキが横へ抜くので前への破裂は弱く、
     樹脂の塊は高い所を吸う。破裂を棚で一番低く、腹に来る低音を一番厚く */
  drum: {
    volume: 0.96, bodyFreq: 250, crackFreq: 1400,
    bodyDecay: 0.26, tailDecay: 0.48, tailVol: 0.40, crackVol: 0.55,
    thumpFrom: 140, thumpTo: 28, thumpTime: 0.26,
    subVol: 0.72, subTime: 0.30, subDelay: 0.02,
  },

};

/** その形の銃声。形が無ければ元の武器の音をそのまま返す */
export const gunTune = (shape, base) =>
  (SHAPE_GUN[shape] ? { ...base, ...SHAPE_GUN[shape] } : base);

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.enabled = true;
    /* 全体の音量。**init前に設定画面から呼ばれる。**
       音は「クリックしてから」でないと起こせないのに、設定は起動直後に読み込まれるので、
       ここで値だけ覚えておいて init のときに写す。既定値は settings.js が持つ
       （2箇所に数字を書くと必ず片方が古くなる） */
    this.volume = VOLUME_DEF;
    // 空間の開け具合(0=壁が近い 1=開けている)。init前に呼ばれても値だけ覚えておく
    this.openness = 0.65;
    /* 試合の中にいるか。main.jsのループが毎フレーム入れる。
       遠景の撃ち合い(_startAmbienceのdistant)は試合の外では鳴らさない。
       メニューに置いたまま席を外しても、数秒おきに銃声のノード一式
       （1発で十数個）を作っては捨て続けていた。風の層は流しっぱなしでよい
       （起動時に作った物が回り続けるだけで、新しい物を作らない） */
    this.battle = false;
    this._lowHp = 0;
    this._heartTimer = null;
    // 同時発音が増えすぎた時に層を間引くための負荷カウンタ
    this._load = 0;
    this._loadAt = 0;
    // 鳴らし終わって切り離す順番待ち。まとめて片付けるための待ち行列
    this._graveyard = [];
    this._reaper = null;

    // 選んだキル音は端末に覚えさせる。決まった後に遊び直すたび
    // 1番へ戻ると、せっかく選んだ意味がない
  }

  /**
   * 音を起こす。ブラウザは操作を起点にしないとWebAudioを動かしてくれない。
   * @param ambience 環境音を流すか。測定(tools/sound-lab.mjs)ではfalseにする
   */
  init({ ambience = true } = {}) {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { this.enabled = false; return; }
    const ctx = new Ctx();
    this.ctx = ctx;

    // 出口の頭打ち。ここへ来た波の頭を丸めて、1.0を絶対に超えさせない。
    //
    // なぜ要るか: 効果音の素材ノイズには「突発の山」をわざと混ぜてあり、
    // 鳴らすたびに素材のどこから読み始めるかを乱数で変えている。
    // 山を引いた回だけ音が跳ね上がり、実測すると同じ銃声が0.70〜1.12まで
    // 揺れていた。1.0を超えた回は波の頭が平らに切られて「バリッ」と割れる。
    // 全体の音量を下げて逃げると、割れない代わりに常時痩せた音になる。
    // 曲線で丸めれば、普段の音はそのままで、跳ねた回だけが抑えられる。
    //
    // 0.72までは素通し。そこから上を滑らかに寝かせて0.97へ漸近させる
    const limiter = ctx.createWaveShaper();
    {
      const n = 2048;
      const c = new Float32Array(n);
      const KNEE = 0.72, CEIL = 0.97;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * 2 - 1;
        const a = Math.abs(x);
        const y = a <= KNEE
          ? a
          : KNEE + (CEIL - KNEE) * Math.tanh((a - KNEE) / (CEIL - KNEE));
        c[i] = Math.sign(x) * y;
      }
      limiter.curve = c;
      limiter.oversample = '4x';
    }
    limiter.connect(ctx.destination);

    // 突発的な銃声で音が割れないよう最後に軽く潰す
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 24;
    comp.ratio.value = 8;
    comp.attack.value = 0.002;
    // 戻りを速くする。0.18秒は打点を2つ続けて鳴らす音（デデン）の間隔155msより
    // 長く、1発目で沈んだまま2発目が来て、2発目だけ半分の大きさになっていた。
    // 出口に頭打ちを入れたので、ここは強く掛ける必要がなくなっている
    comp.release.value = 0.09;
    comp.connect(limiter);

    // 被弾時に世界の音だけを丸めるための段。耳鳴りや心音はこれを迂回して
    // 素通しで鳴らす（実際、爆発の直後は外の音だけが遠のいて耳鳴りは近い）
    this.postBus = ctx.createGain();
    this.postBus.connect(comp);

    this.earFilter = ctx.createBiquadFilter();
    this.earFilter.type = 'lowpass';
    this.earFilter.frequency.value = 20000;
    this.earFilter.Q.value = 0.4;
    this.earFilter.connect(this.postBus);

    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.earFilter);

    /* -------------------------------------------------- 残響と初期反射 */
    // 硬く短い残響と、開けた長い残響を2本持ってクロスフェードさせる。
    // 1本を伸び縮みさせるだけでは「壁が近い」硬さが出ない
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 0.5;

    this.tightVerb = ctx.createConvolver();
    this.tightVerb.buffer = this._impulse(0.6, 5.0, 9);
    this.tightGain = ctx.createGain();
    this.reverbSend.connect(this.tightVerb);
    this.tightVerb.connect(this.tightGain);
    this.tightGain.connect(this.master);

    this.openVerb = ctx.createConvolver();
    this.openVerb.buffer = this._impulse(2.6, 2.3, 3);
    this.openGain = ctx.createGain();
    this.reverbSend.connect(this.openVerb);
    this.openVerb.connect(this.openGain);
    this.openGain.connect(this.master);

    // 遠くの壁から返る一枚跳ね返り。残響とは別に「パーン…パン」の間を作る。
    // これがあると屋外の広場らしさが一気に出る
    this.slapSend = ctx.createGain();
    this.slapSend.gain.value = 1;
    this.slapDelay = ctx.createDelay(0.6);
    this.slapDelay.delayTime.value = 0.12;
    this.slapFilter = ctx.createBiquadFilter();
    this.slapFilter.type = 'lowpass';
    this.slapFilter.frequency.value = 2200;
    this.slapFeedback = ctx.createGain();
    this.slapFeedback.gain.value = 0.24;
    this.slapGain = ctx.createGain();
    this.slapGain.gain.value = 0.4;
    this.slapSend.connect(this.slapDelay);
    this.slapDelay.connect(this.slapFilter);
    this.slapFilter.connect(this.slapFeedback);
    this.slapFeedback.connect(this.slapDelay);
    this.slapFilter.connect(this.slapGain);
    this.slapGain.connect(this.master);
    this.slapGain.connect(this.reverbSend);

    this.noise = this._noiseBuffer(2.0);

    this._buildTinnitus();
    this._buildBreath();

    this.ready = true;
    this._loadAt = ctx.currentTime;
    this.setEnvironment(this.openness);
    // 環境音と息づかいは鳴りっぱなしなので、1つの効果音を測りたい時は邪魔になる。
    // tools/sound-lab.mjs がここをfalseで呼ぶ。
    // 切り忘れたまま測った時は、5案とも「長さ2000ms・低音22%」というそっくりな
    // 数字が出た。測っていたのは環境音のうなりだった
    if (ambience) this._startAmbience();
  }

  resume() {
    /* **catchが要る。** resume()はpromiseを返すので、断られた時は
       例外ではなく「拾われなかった約束の失敗」として流れて、
       遊ぶ側の画面の隅へ英語のまま出る（src/ui/diag.js）。
       人が押していない所から呼ばれると断られるので、起こり得る */
    if (this.ctx?.state === 'suspended') this.ctx.resume()?.catch?.(() => {});
  }

  /**
   * 全体の音量。設定画面のつまみから来る。
   *
   * 掛ける場所を master にしてあるのは、ここが**世界の音の入口**だから。
   * ここより下流には出口の頭打ちと圧縮しか居ないので、下げても音の質が変わらない。
   * 逆に一番下流（destination の手前）で下げると、頭打ちを通った後を削ることになり、
   * 小さくしたのに割れたままになる。
   *
   * init前に呼ばれても値だけ覚える。壊れた値は無視して今の値を保つ
   * （0にはできる必要があるので、falsyを弾く形にはしない）
   */
  setVolume(v) {
    const g = clamp(Number(v), 0, 1);
    if (!Number.isFinite(g)) return this.volume;
    this.volume = g;
    if (this.master) this.master.gain.value = g;
    return this.volume;
  }

  /* ------------------------------------------------------------ 素材 */

  _noiseBuffer(seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // spikesは初期反射の本数。壁が近い空間はここが立って「硬さ」になる
  _impulse(seconds, decay, spikes = 0) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // 立ち上がりに少し間を置くと「広い空間」に聞こえる
        const early = t < 0.02 ? t / 0.02 : 1;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, decay) * early;
      }
      for (let k = 0; k < spikes; k++) {
        const idx = Math.floor(len * rnd(0.008, 0.14));
        d[idx] += (Math.random() * 2 - 1) * 0.8 * Math.pow(1 - idx / len, decay * 0.5);
      }
    }
    return buf;
  }

  // ノイズ源を1本作って返す。offsetをずらして毎回違う波形にする
  _noiseSource(playbackRate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noise;
    s.loop = true;
    s.playbackRate.value = playbackRate;
    return s;
  }

  _env(gain, t0, peak, attack, decay, curve = 2.2) {
    const g = gain.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + attack);
    g.setTargetAtTime(0.0001, t0 + attack, decay / curve);
  }

  // 直近の発音数をざっくり見る。撃ち合いが密になった時に層を間引いて
  // 音が団子になるのと、ノード生成が増えすぎるのを同時に防ぐ
  _busy(t, add = 1) {
    this._load = Math.max(0, this._load - (t - this._loadAt) * 7);
    this._loadAt = t;
    this._load += add;
    return this._load;
  }

  _dist(position, camera) {
    if (!position || !camera) return 0;
    return Math.hypot(
      position.x - camera.position.x,
      position.y - camera.position.y,
      position.z - camera.position.z,
    );
  }

  /**
   * 音の定位。カメラ基準で左右の振りと距離減衰を手計算する。
   * PannerNodeより軽く、どのブラウザでも同じ鳴り方になる。
   */
  _place(input, position, camera, refDist = 8, dist = null, hfLoss = 260) {
    const ctx = this.ctx;
    if (!position || !camera) {
      const g = ctx.createGain();
      input.connect(g);
      return g;
    }
    const dx = position.x - camera.position.x;
    const dy = position.y - camera.position.y;
    const dz = position.z - camera.position.z;
    if (dist === null) dist = Math.hypot(dx, dy, dz);

    const atten = 1 / (1 + Math.pow(dist / refDist, 1.7));

    // カメラの右方向ベクトルとの内積で左右を決める
    const yaw = camera.rotation.y;
    const rx = Math.cos(yaw), rz = -Math.sin(yaw);
    const inv = dist > 0.001 ? 1 / dist : 0;
    const pan = clamp((dx * inv) * rx + (dz * inv) * rz, -1, 1);

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const g = ctx.createGain();
    g.gain.value = atten;
    if (panner) {
      panner.pan.value = pan * 0.85;
      input.connect(panner);
      panner.connect(g);
    } else {
      input.connect(g);
    }
    // 途中に挟んだノードも後で切り離す。返り値だけ切っても、
    // その手前のpannerやフィルタはinputに繋がったまま残る
    if (panner) this._reap([panner], 3.2);
    // 遠い音は空気に高域を食われる
    if (dist > 12) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(16000 - (dist - 12) * hfLoss, 700, 16000);
      const out = ctx.createGain();
      g.connect(lp);
      lp.connect(out);
      this._reap([g, lp], 3.2);
      return out;
    }
    return g;
  }

  /**
   * 鳴らし終わった音を出力へ繋ぐ。
   *
   * 繋いだノードは必ず後で切り離す。WebAudioはstop()したソースこそ自動で片付くが、
   * その下流のGainやBiquadFilterはmasterに繋がったまま残り続ける。
   * 実測すると1試合ぶん（銃声1200・足音3000・被弾300）で67,295個が生き残っていた。
   * 増え続けるとブラウザのノード上限に当たってcreateGain()が失敗し始め、
   * そこから先は何も鳴らなくなる。「遊んでいると音が消える」の正体がこれ。
   *
   * lifeは切り離すまでの秒数。鳴り終わる前に切ると音が途中で欠けるので、
   * 一番長い尾（残響2.6秒）より余裕を持たせた既定にしてある
   */
  _out(node, wet = 0.35, slap = 0, life = 3.2) {
    const dead = [node];
    node.connect(this.master);
    const send = this.ctx.createGain();
    send.gain.value = wet;
    node.connect(send);
    send.connect(this.reverbSend);
    dead.push(send);
    if (slap > 0) {
      const s2 = this.ctx.createGain();
      s2.gain.value = slap;
      node.connect(s2);
      s2.connect(this.slapSend);
      dead.push(s2);
    }
    this._reap(dead, life);
  }

  /**
   * 指定秒後にノードを切り離す。
   * setTimeoutを1本ずつ持つと同時発音の数だけタイマーが並ぶので、
   * 期限つきの待ち行列に積んで1本のタイマーでまとめて片付ける
   */
  _reap(nodes, life) {
    const at = (this.ctx.currentTime + life) * 1000;
    this._graveyard.push({ at, nodes });
    if (this._reaper) return;
    this._reaper = setInterval(() => {
      const now = this.ctx ? this.ctx.currentTime * 1000 : Infinity;
      let i = 0;
      while (i < this._graveyard.length) {
        const e = this._graveyard[i];
        if (e.at > now) { i++; continue; }
        for (const n of e.nodes) {
          try { n.disconnect(); } catch { /* 既に切れている */ }
        }
        // 末尾を詰めて削る。spliceだと同時発音が多い時に毎回配列を作り直す
        this._graveyard[i] = this._graveyard[this._graveyard.length - 1];
        this._graveyard.pop();
      }
      if (this._graveyard.length === 0) {
        clearInterval(this._reaper);
        this._reaper = null;
      }
    }, 500);
  }

  /* ------------------------------------------------------ 環境（空間） */

  /**
   * 周囲の開け具合を伝える。0=壁に囲まれている 1=開けた広場。
   * main.js側でプレイヤーから数本レイを飛ばし、平均距離を0..1に正規化して渡す想定。
   * 毎フレーム呼んで良いように、値は時定数付きで滑らかに追従させる。
   */
  setEnvironment(openness = 0.65) {
    const o = clamp(openness, 0, 1);
    this.openness = o;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    const tau = 0.35;
    // 狭いほど硬く短い残響、開けているほど長く尾を引く残響
    this.tightGain.gain.setTargetAtTime(lerp(0.85, 0.12, o), t, tau);
    this.openGain.gain.setTargetAtTime(lerp(0.10, 0.80, o), t, tau);
    this.reverbSend.gain.setTargetAtTime(lerp(0.34, 0.62, o), t, tau);
    // 壁が近い＝跳ね返りが早く何度も返る。開けている＝遅く一発だけ返る
    this.slapDelay.delayTime.setTargetAtTime(lerp(0.028, 0.185, o), t, tau);
    this.slapFeedback.gain.setTargetAtTime(lerp(0.36, 0.12, o), t, tau);
    this.slapGain.gain.setTargetAtTime(lerp(0.50, 0.30, o), t, tau);
    this.slapFilter.frequency.setTargetAtTime(lerp(3000, 1500, o), t, tau);
  }

  /* ------------------------------------------------------------ 銃声 */

  /**
   * profile: { volume, bodyFreq, crackFreq, bodyDecay, tailDecay, thumpFrom, thumpTo,
   *            distance(位置を渡さない時の距離指定), mech(排莢機構の音を出すか) }
   * positionとcameraを省くと「自分の銃」＝距離0として鳴る。
   */
  gunshot(profile = {}, position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    /* 層ごとの大きさと長さ。**既定値は今までの音そのまま**なので、
       書かなかった武器の鳴り方は1ミリも変わらない。
       大口径（狙撃銃）だけ、腹に来る低音と尾を伸ばして「1発が重い」を作る。
       どの数字が何に効くかは tools/check-sound.mjs の[4]が測っている */
    const {
      volume = 1, bodyFreq = 620, crackFreq = 3600,
      bodyDecay = 0.13, tailDecay = 0.42, thumpFrom = 105, thumpTo = 44,
      mech = true,
      // 立ち上がりの鋭さ・尾の大きさ
      crackVol = 0.49, tailVol = 0.38,
      // 腹に来る低音の長さ（秒）と、その下のサブベースの大きさ・長さ・遅らせる量
      thumpTime = 0.085, subVol = 0.44, subTime = 0.14, subDelay = 0,
      // 撃った後に遊底を送る音を重ねるまでの秒数（0で鳴らさない）。
      // 手で1発ずつ送る銃だけ、撃つ動作の一部として鳴る
      boltAfter = 0,
    } = profile;

    const spatial = !!(position && camera);
    const dist = spatial ? this._dist(position, camera) : (profile.distance ?? 0);
    // 音速ぶんの到達遅れ。遠い銃声が一拍遅れて届くと距離が体で分かる
    const delay = Math.min(dist / SOUND_SPEED, 0.28);
    const t = ctx.currentTime + delay;
    // 遠景の撃ち合いは何発重なっても手前の音を痩せさせない
    const busy = this._busy(t, dist > 60 ? 0.3 : 1);

    /* 同時発音の上限。敵14体が撃ち合うと発砲は瞬間で毎秒30〜60発になり、
       1発ごとにノード十数個のグラフを作っては捨てていた。
       耳はその全部を聞き分けられない（近い数発の後ろで壁になるだけ）ので、
       混んでいる時は遠い発砲から鳴らさない。層を痩せさせる既存の間引き
       （尾はbusy<9、機関部はbusy<7）より一段外側の、丸ごとの打ち切り。
       **自分の銃（距離0）は絶対に間引かない。** 撃った手応えが消えるのは事故 */
    if (dist > 0
      && (busy > 14 || (dist > 18 && busy > 10) || (dist > 45 && busy > 6))) return;

    // 距離帯ごとの重み。近＝クラック、中＝胴体と残響、遠＝低音のドスンだけ
    const wCrack = Math.pow(1 - step(3, 34, dist), 1.1);
    const wBody = lerp(1, 0.18, step(6, 60, dist));
    const wTail = lerp(0.35, 1.0, step(4, 30, dist));
    const wSub = 1 - step(1.5, 11, dist);
    const wBoom = step(22, 75, dist);

    // 1発ごとの揺らぎ。ここが狭いと連射が同じ音の反復に聞こえて一気に安くなる
    const jPitch = rnd(0.88, 1.14);
    const jVol = rnd(0.9, 1.08);
    const jDecay = rnd(0.85, 1.2);

    const bus = ctx.createGain();
    // 位置を渡さず距離だけ指定された場合（遠景の環境音）は_placeが減衰を掛けないので、
    // ここで手計算しておく。これを忘れると遠くの銃声が真横で鳴る
    const farAtten = !spatial && dist > 0 ? 1 / (1 + Math.pow(dist / 26, 1.4)) : 1;
    bus.gain.value = volume * jVol * farAtten;

    // 尾の実際の長さを先に出す。距離が離れる・開けた場所ほど、尾は
    // tailDecayの最大約3.9倍まで伸びる（下の[3]のtailLenと同じ式）。
    // stopAtが元のtailDecayしか見ていないと、遠景の尾はまだ2割前後の
    // 音量が残っている所でオシレータごと止まり、プツンと切れる。
    // tailDecayとのmaxを取るのは、開けていない・揺らぎが小さい側では
    // tailLenがtailDecayを下回ることがあり、そちらまで縮めたくないため
    const tailLen = tailDecay * jDecay * lerp(0.6, 1.7, this.openness) * lerp(1, 1.9, step(8, 50, dist));
    // サブベースを伸ばした武器では、そちらが一番長く残る層になる。
    // ここに入れ忘れると、伸ばしたぶんの低音が途中でオシレータごと切られて
    // 「重くしたはずなのにブツッと止まる」になる
    const life = Math.max(Math.max(tailDecay, tailLen) * 2.4, bodyDecay * 3, subTime * 4) + 0.6;
    const stopAt = t + life;

    // 1. 立ち上がりの鋭いクラック。近距離だけの成分で、遠くでは空気に食われて消える
    if (wCrack > 0.03) {
      const crack = this._noiseSource(jPitch);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = crackFreq * rnd(0.9, 1.12) * lerp(1, 0.45, step(2, 30, dist));
      // 上にも蓋をする。ハイパスだけだとノイズが20kHzまで平らに伸びて、
      // 測ると7kHz以上だけで全体の35%を占めていた。この帯が主役になった音は
      // 銃声ではなく「サーッ」という雨や砂嵐に聞こえる。
      // 実際の発砲音も8kHzより上は空気に食われてすぐ落ちる
      const hlp = ctx.createBiquadFilter();
      hlp.type = 'lowpass';
      hlp.frequency.value = rnd(7600, 9400);
      hlp.Q.value = 0.6;
      const crackGain = ctx.createGain();
      crack.connect(hp); hp.connect(hlp); hlp.connect(crackGain); crackGain.connect(bus);
      this._env(crackGain, t, crackVol * wCrack, 0.0005, rnd(0.026, 0.042));
      crack.start(t, Math.random() * 1.5); crack.stop(t + 0.25);
    }

    // 2. 胴体。共振させた低めのバンドで「押し」を出す
    const body = this._noiseSource(jPitch * rnd(0.95, 1.05));
    const bp = ctx.createBiquadFilter();
    bp.type = 'lowpass';
    const bf = bodyFreq * rnd(0.88, 1.12);
    bp.frequency.setValueAtTime(bf * 3.2, t);
    bp.frequency.exponentialRampToValueAtTime(bf * 0.55, t + bodyDecay * 1.6 * jDecay);
    bp.Q.value = rnd(2.6, 4.4);
    const bodyGain = ctx.createGain();
    body.connect(bp); bp.connect(bodyGain); bodyGain.connect(bus);
    // ごく僅かに遅らせる。クラックと完全同時だと1枚の板に潰れる
    this._env(bodyGain, t + rnd(0.0005, 0.004), 0.96 * wBody, 0.0015, bodyDecay * jDecay);
    body.start(t, Math.random() * 1.5); body.stop(stopAt);

    // 3. 尾。距離が伸びるほど主役になり、開けた場所ほど長く伸びる。
    //    連射が続くと尾は前の尾に埋もれて聞こえないので、その時だけ省く
    if (busy < 9) {
      const tail = this._noiseSource(rnd(0.7, 0.95));
      const tf = ctx.createBiquadFilter();
      tf.type = 'bandpass';
      tf.frequency.value = rnd(700, 1250) * lerp(1, 0.55, step(10, 60, dist));
      tf.Q.value = rnd(0.55, 0.9);
      const tailGain = ctx.createGain();
      tail.connect(tf); tf.connect(tailGain); tailGain.connect(bus);
      // tailLenはstopAtを決める所で先に出してある（同じ式）
      this._env(tailGain, t + rnd(0.004, 0.022), tailVol * wTail, 0.006, tailLen);
      tail.start(t, Math.random() * 1.5); tail.stop(stopAt);
    }

    // 4. 腹に来る低音。至近だけ。マズルフラッシュと同時に胸を押される感じを作る
    if (wSub > 0.03) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(thumpFrom * rnd(0.92, 1.1), t);
      // 落ちきるまでの時間も長さに合わせる。ここだけ0.09秒に固定していると、
      // 減衰だけ伸ばしても「一瞬で底まで落ちた低音が長く残る」になって、
      // 押される感じではなく唸りに聞こえる
      osc.frequency.exponentialRampToValueAtTime(thumpTo * rnd(0.9, 1.1), t + thumpTime);
      const oscGain = ctx.createGain();
      osc.connect(oscGain); oscGain.connect(bus);
      this._env(oscGain, t, 0.78 * wSub, 0.002, thumpTime * jDecay);
      osc.start(t); osc.stop(t + thumpTime * 3 + 0.12);

      // サブベース。閃光の一瞬だけ床が鳴るような圧を足す。
      // 単体では聞こえないくらいで良い（聞こえると安いブーストになる）
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      /* 少し遅らせられるようにしてある（subDelay）。
         破裂と低音が同じ瞬間に山を作ると、波の頭が足し算されて出口の限界に当たり、
         **音を大きくしたつもりが潰れて小さく聞こえる**（実測で山0.92まで来た）。
         30ms遅らせると山が下がるうえに、耳には「割れた後に低音が来る」順で届く */
      const st = t + subDelay;
      sub.frequency.setValueAtTime(56, st);
      sub.frequency.exponentialRampToValueAtTime(29, st + subTime * 1.15);
      const subGain = ctx.createGain();
      sub.connect(subGain); subGain.connect(bus);
      // 出しすぎるとコンプが低音に反応して他の音まで毎発沈むので控えめに
      this._env(subGain, st, subVol * wSub, 0.006, subTime);
      sub.start(st); sub.stop(st + subTime * 3 + 0.2);
    }

    /* 遊底を送る音。**撃った後の動作を音でも見せる。**
       手で1発ずつ送る銃は、撃つ→送る が1つの流れになっていて、
       銃声だけだと「1発しか出ない銃」の理由が音から消える。
       装填の時に鳴らしている物と同じ部品を、少し遅らせて重ねるだけ。
       自分の銃の時だけ（遠くの人の遊底まで聞こえたら嘘になる） */
    // 大きさは銃声の半分以下に。素のままだと銃声より大きい音が毎発鳴る
    if (boltAfter > 0 && dist < 3 && busy < 7) this._bolt(t + boltAfter, 0.42);

    // 5. 遠距離のドスン。高域は全部落ちて低い塊だけが届く。
    //    距離減衰で消えないよう、低域は減りにくい前提で持ち上げる
    if (wBoom > 0.03) {
      const boom = this._noiseSource(rnd(0.25, 0.4));
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = rnd(150, 260);
      lp.Q.value = 1.4;
      const bg = ctx.createGain();
      boom.connect(lp); lp.connect(bg); bg.connect(bus);
      // 低音は距離で減りにくい。_placeの一律減衰で消えてしまうぶんを押し戻す
      this._env(bg, t, 0.9 * wBoom * (spatial ? 1 + dist / 26 : 1), 0.008, rnd(0.16, 0.26));
      boom.start(t, Math.random() * 1.5); boom.stop(t + 0.7);
    }

    // 6. 自分の銃だけ、機関部が動く金属音を薄く重ねる。
    //    銃声が「発射炎」だけでなく「機械」に聞こえるようになる
    if (mech && dist < 3 && busy < 7) {
      this._metal(t + rnd(0.022, 0.04), {
        partials: [1180, 2670, 4310], vol: 0.09, decay: 0.03,
        ring: 0.5, noiseFreq: 4200, noiseQ: 2.4, wet: 0.1,
      });
    }

    let out = this._place(bus, position, camera, 14, dist, 300);
    if (!spatial && dist > 12) {
      // 遠景も高域を落とす。近くで鳴らした音をそのまま小さくしただけだと距離が出ない
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = clamp(16000 - (dist - 12) * 300, 500, 16000);
      const g2 = ctx.createGain();
      out.connect(lp); lp.connect(g2);
      out = g2;
    }
    // 遠いほど残響と跳ね返りに送る割合を増やす＝空間そのものが鳴っている状態
    //
    // _reap()の期限はここを呼んだ瞬間のctx.currentTimeからの秒数で決まるが、
    // 上のstopAtはt(=その時点 + 音速の到達遅れdelay)からの秒数。
    // 揃えないと、遠い銃声ほど「まだtがdelayぶん遅れて来ていない=音源は
    // 生きている」うちに出力側だけ先に切り離されることになる。
    // life(stopAtまでの長さ)にdelayを足して、両者が同じ実時刻を指すようにする
    this._out(out, lerp(0.45, 1.0, step(2, 45, dist)), lerp(0.5, 0.95, step(2, 45, dist)), life + delay);
  }

  /* -------------------------------------------------- 金属音の共通部品 */

  // 打撃のノイズ + 非整数比の倍音。倍音を整数比にすると楽器の音程に聞こえて
  // 金属に感じないので、必ずずらして積む
  _metal(t, opts = {}) {
    const ctx = this.ctx;
    const {
      partials = [420, 980, 1750], vol = 0.4, decay = 0.09, ring = 0.5,
      noiseFreq = 3000, noiseQ = 1.6, noiseType = 'bandpass',
      position = null, camera = null, wet = 0.2, refDist = 6,
    } = opts;

    const bus = ctx.createGain();
    bus.gain.value = 1;

    const src = this._noiseSource(rnd(0.85, 1.2));
    const f = ctx.createBiquadFilter();
    f.type = noiseType;
    f.frequency.value = noiseFreq * rnd(0.9, 1.12);
    f.Q.value = noiseQ;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(bus);
    this._env(g, t, vol, 0.0008, decay);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay * 4 + 0.3);

    let longest = decay * 4;
    for (let i = 0; i < partials.length; i++) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = partials[i] * rnd(0.96, 1.05);
      const og = ctx.createGain();
      o.connect(og); og.connect(bus);
      const d = decay * (2.4 - i * 0.5) * ring * rnd(0.8, 1.25);
      this._env(og, t, (vol * ring) / (1 + i * 0.9), 0.0015, Math.max(0.01, d));
      o.start(t); o.stop(t + Math.max(0.05, d * 4));
      longest = Math.max(longest, d * 4);
    }

    const out = this._place(bus, position, camera, refDist);
    this._out(out, wet, wet * 0.4);
    return longest;
  }

  /* ------------------------------------------------- 機械的なカチッ音 */
  click(freq = 2200, vol = 0.5, decay = 0.03, position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this._noiseSource(rnd(0.9, 1.15));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq * rnd(0.92, 1.1);
    f.Q.value = rnd(1.8, 2.8);
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, vol, 0.001, decay);
    const out = this._place(g, position, camera, 6);
    this._out(out, 0.18, 0.1);
    src.start(t, Math.random() * 1.5);
    src.stop(t + decay + 0.2);
  }

  /* ---------------------------------------------------------- リロード */

  // マガジンリリース。指で押すボタンの小さいカチッ＋バネ
  // ここも鳴り物になっていた。2450/3980Hzを余韻0.35で鳴らすと鈴になる。
  // 弾倉止めは金属の爪が外れる音で、音程を持たない「カチッ」。
  // 倍音を低く濁らせて余韻をほぼ消し、代わりに粒立ちを上げる
  _magRelease(t) {
    this._metal(t, {
      partials: [880, 1310], vol: 0.30, decay: 0.010,
      ring: 0.05, noiseFreq: 2800, noiseQ: 1.2, wet: 0.05,
    });
  }

  /**
   * 機械が止まる時の低い一撃。装填のカチャカチャが軽く聞こえるのは、
   * 高い倍音と擦れの音しか鳴らしていないから。実物は重い金属の塊が動いて
   * 止まるので、必ず低い所が一緒に鳴る。測ると装填音は30〜250Hzの取り分が
   * 0.7%しかなく、重心は5420Hzにあった＝上だけで鳴っていた
   */
  _thunk(t, f0, f1, vol, decay) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0 * rnd(0.92, 1.08), t);
    o.frequency.exponentialRampToValueAtTime(f1, t + decay);
    const g = ctx.createGain();
    o.connect(g);
    this._env(g, t, vol, 0.002, decay);
    this._out(g, 0.08, 0.05);
    o.start(t); o.stop(t + decay * 4 + 0.1);
  }

  // マガジン抜去。金属が擦れて滑り、抜けきった所で軽く鳴る
  _magOut(t) {
    const ctx = this.ctx;
    const src = this._noiseSource(rnd(0.5, 0.7));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(rnd(1500, 1900), t);
    f.frequency.exponentialRampToValueAtTime(rnd(600, 780), t + 0.11);
    f.Q.value = 1.1;
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, 0.2, 0.012, 0.075);
    this._out(g, 0.16, 0.1);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.4);
    this._metal(t + rnd(0.075, 0.1), {
      partials: [640, 1490, 2380], vol: 0.22, decay: 0.03,
      ring: 0.09, noiseFreq: 1900, noiseQ: 1.1, wet: 0.08,
    });
  }

  // 挿入。重い塊が入って止まる音。低い倍音を厚めに、最後に嵌るカチッ
  _magIn(t) {
    this._thunk(t, 118, 68, 0.62, 0.06);
    this._metal(t, {
      // 弾倉が座る音。ring 0.7は「鳴らす」量で、実物は詰まって止まるだけ
      partials: [148, 262], vol: 0.5, decay: 0.038,
      ring: 0.10, noiseFreq: 900, noiseQ: 0.9, noiseType: 'lowpass', wet: 0.10,
    });
    this._metal(t + rnd(0.03, 0.045), {
      partials: [760, 1090], vol: 0.26, decay: 0.010,
      ring: 0.06, noiseFreq: 3100, noiseQ: 1.3, wet: 0.06,
    });
  }

  /* ボルト。バネがジャッと鳴ってから、前進して硬く止まる。
     volは全体の大きさ。装填の一工程として鳴らす時は1.0のまま。
     **撃った直後に重ねる時は下げる。** 実測すると、この音は素のままだと
     山0.92で、狙撃銃の銃声そのもの(0.78)より大きかった。
     1発ごとに鳴る物が銃声より大きいのは、迫力ではなくただの騒音になる */
  _bolt(t, vol = 1) {
    this._thunk(t + 0.055, 146, 82, 0.70 * vol, 0.055);
    const ctx = this.ctx;
    const src = this._noiseSource(rnd(1.1, 1.4));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(rnd(2600, 3200), t);
    f.frequency.exponentialRampToValueAtTime(rnd(1300, 1700), t + 0.06);
    f.Q.value = 2.2;
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, 0.24 * vol, 0.004, 0.04);
    this._out(g, 0.14, 0.1);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.3);
    // 前進して閉鎖。ここが一番硬い音になる
    this._metal(t + rnd(0.05, 0.07), {
      // 4本の高い倍音をring 0.62で鳴らすと、閉鎖ではなく金属の鐘になる。
      // 閉鎖は重い塊が受けに当たって止まる音なので、低い2本を短く切る
      partials: [268, 640], vol: 0.55 * vol, decay: 0.020,
      ring: 0.08, noiseFreq: 2600, noiseQ: 1.0, wet: 0.10,
    });
  }

  // 工程ごとに別の音で組む。同じclickの周波数違いだと「操作している」感じが出ない
  reload(duration = 2) {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    this._magRelease(t + 0.04);
    this._magOut(t + duration * 0.30);
    this._magIn(t + duration * 0.64);
    this._bolt(t + duration * 0.86);
  }

  /**
   * 1発だけ押し込む音。ショットガンのように1発ずつ入れる武器で、
   * 弾が1つ増えるたびに鳴らす。
   *
   * reload() を短くした物ではない。あれは「抜く→落とす→差す→引く」の
   * 4工程を時間の中に並べた物で、1発ずつ入れる動作にはその工程が無い。
   * ここは「布に包まれた物が受けに当たって止まる」1回だけ。
   * 硬すぎると弾倉を差した音に聞こえるので、低い方へ寄せて余韻を切る
   */
  shell() {
    if (!this.ready || !this.enabled) return;
    const t = this.ctx.currentTime;
    // 掴んで運ぶ所の擦れ。これが無いと、何もない所から急に音が出る
    this._metal(t, {
      partials: [520, 810], vol: 0.10, decay: 0.014,
      ring: 0.04, noiseFreq: 2200, noiseQ: 1.1, wet: 0.05,
    });
    // 押し込んで止まる所。1発ずつの装填はここが本体
    const at = t + rnd(0.045, 0.065);
    this._thunk(at, 132, 76, 0.34, 0.045);
    this._metal(at, {
      partials: [186, 305], vol: 0.30, decay: 0.026,
      ring: 0.07, noiseFreq: 1100, noiseQ: 0.9, noiseType: 'lowpass', wet: 0.08,
    });
  }

  /* ------------------------------------------------------------ 足音 */

  /**
   * surfaceは 'dirt' | 'gravel' | 'asphalt' | 'concrete' | 'metal' | 'wood'。
   * 旧シグネチャ footstep(強さ, 位置, カメラ) でも壊れないよう引数を受け直す。
   */
  footstep(intensity = 0.7, surface = 'dirt', position = null, camera = null) {
    if (surface && typeof surface === 'object') { camera = position; position = surface; surface = 'dirt'; }
    this._step(intensity, surface, position, camera, 1);
  }

  // 着地。踏み込みが深く、低音と擦れが伸びる
  land(intensity = 1, surface = 'dirt', position = null, camera = null) {
    if (surface && typeof surface === 'object') { camera = position; position = surface; surface = 'dirt'; }
    this._step(Math.min(1.4, intensity * 1.3), surface, position, camera, 2.1);
  }

  /**
   * 滑り込み。**足音の連打ではなく、1本の長い擦れ。**
   *
   * 足音を速く鳴らして代用してはいけない。足音は「踏む・離す」の打点の集まりで、
   * 滑りは打点が1つも無い連続音。速く鳴らすと機関銃のような足音になるだけで、
   * 「体が地面に接している」に絶対に聞こえない。
   *
   * 組み方は4層。
   *   1. 体が路面へ落ちる低音（1回だけ。無いと何もない所から急に擦り始める）
   *   2. 引きずる唸り（下で鳴っているのが分かる程度。主役ではない）
   *   3. 擦れ本体。**ここが「シュー」。** 帯域を上から下へ落としながら減る
   *   4. 砂利や小石が弾ける粒（素材のgritをそのまま使う）
   *
   * **高さの置き所を2回外している。** 詳しくは下の3の所に書いたが、
   * 上げすぎると砂嵐、下げすぎると「ズズッ」で、どちらも一発では当たらなかった。
   * 今の形は遊ぶ側に「もっとシュー！って感じに」と言われて寄せた版で、
   * 数字の線は tools/check-sound.mjs の [7] が持っている。
   * **触る時はそちらを先に読むこと。** 両方の外し方が数字で書いてある。
   *
   * 長さは player.js の滑りが実際に終わる0.83秒に合わせてある
   （上限のSLIDE_TIME_Sは0.90だが、普段はその手前で速さが落ちて終わる）。
   * 途中で滑りが終わる（跳んで抜ける等）ことはあるが、鳴っている音を
   * 途中で止める仕組みは持たせていない。0.2秒ぶんの尻尾が残るだけで、
   * そのために毎回ノードの参照を持ち回るほうが割に合わない
   */
  slide(surface = 'dirt', position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = SURFACES[surface] ?? SURFACES.dirt;
    const dur = 0.83;

    /* 全体の大きさ。**層ごとの値ではなくここで絞る。**
       「うるさい」と言われた時に層ごとの値を触ると、せっかく合わせた帯のつり合い
       （下の3に書いた2回ぶんの失敗の結果）が崩れて、音の質まで一緒に変わる。
       ここを掛けるだけなら質はそのままで量だけ減る。

       **絞る前は出口のリミッターを叩いていた。** 4層を足した生の信号が全開の2倍以上あり、
       master手前のリミッターとコンプレッサーが潰していた。
       山を測ると0.48で銃声より小さいのに耳にうるさかったのはこれが理由で、
         ・潰された広帯域のノイズは、山の高さの割にずっと大きく聞こえる
         ・コンプレッサーが掛かるので、鳴っている間ほかの音が全部引っ込む
       **山の数字だけ見ていても気づけない。** 1.0→0.22まで絞っても山は0.48→0.40しか
       動かなかった（潰れていたぶんが減っただけで、実際の音量は5分の1になっている）。

       0.14で山が0.27。足音(dirt 0.29)と同じ高さで、リミッターにも触れない */
    const bus = ctx.createGain();
    bus.gain.value = 0.14;

    // 1. 体が落ちる低音。着地(land)より深く、余韻を長めに取る。
    // 「シュー」に寄せる時、ここを大きいままにすると出だしが「ドッ」で始まって
    // 息の抜ける音に聞こえない。体が接した合図として残る量まで下げてある
    const th = ctx.createOscillator();
    th.type = 'sine';
    th.frequency.setValueAtTime(s.thump * 0.9, t);
    th.frequency.exponentialRampToValueAtTime(s.thump * 0.42, t + 0.14);
    const thg = ctx.createGain();
    th.connect(thg); thg.connect(bus);
    this._env(thg, t, 0.60 * s.vol, 0.005, 0.12);
    th.start(t); th.stop(t + 0.45);

    // 2. 体が路面を引きずる唸り。**支え役であって主役ではない。**
    // これを最初に外して組んだら重心が5.2kHzまで上がって砂嵐になったが、
    // 逆に大きくしすぎると「ゴー」という地鳴りになって、遊ぶ側が言う
    // 「シュー」から遠ざかる。**下で鳴っているのが分かる程度**に留める
    const low = this._noiseSource(rnd(0.55, 0.7));
    const lf = ctx.createBiquadFilter();
    lf.type = 'lowpass';
    lf.frequency.setValueAtTime(s.thump * 5.0, t);
    lf.frequency.exponentialRampToValueAtTime(s.thump * 2.0, t + dur);
    lf.Q.value = 1.1;
    const lg = ctx.createGain();
    low.connect(lf); lf.connect(lg); lg.connect(bus);
    lg.gain.setValueAtTime(0.0001, t);
    lg.gain.linearRampToValueAtTime(1.25 * s.vol, t + 0.05);
    lg.gain.setTargetAtTime(0.0001, t + 0.05, dur * 0.28);
    low.start(t, Math.random() * 1.5);
    low.stop(t + dur + 0.3);

    /* 3. 擦れ本体。**ここが「シュー」そのもの。**
       帯域が上から下へ落ちていく＝速さが落ちていく音になる。

       高さの置き所を2回外している。
       ・4kHz付近を蓋なしで鳴らした最初の版 … 7kHz超が27%を占めて砂嵐になった
       ・800Hzまで落とした次の版         … 重さは出たが「ズズッ」で、
                                            遊ぶ側が欲しかった「シュー」ではなかった
       今は3.8kHz→1.3kHzを掃きながら、6.5kHzに蓋をしてある。
       **蓋は残す。** 外すと1回目に戻る（人が耳障りだと感じるのは7kHzより上）。
       Qを0.45まで下げて帯を広く取るのは、狭いと音程の付いた笛になるため */
    const src = this._noiseSource(rnd(0.9, 1.15));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(s.gritFreq * 1.05, t);
    f.frequency.exponentialRampToValueAtTime(s.gritFreq * 0.28, t + dur);
    f.Q.value = 0.45;
    const cap = ctx.createBiquadFilter();
    cap.type = 'lowpass';
    cap.frequency.value = 5000;
    const g = ctx.createGain();
    src.connect(f); f.connect(cap); cap.connect(g); g.connect(bus);
    /* 立ち上がりだけ速く、そこから滑りの減速と同じ形で減らす。
       _envだと減り方が固定なので、ここは直に書く。
       「シュー！」の勢いは立ち上がりの速さで決まるので、0.03秒で頂点まで出す */
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.85 * s.vol * s.grit + 0.24, t + 0.03);
    g.gain.setTargetAtTime(0.0001, t + 0.03, dur * 0.32);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.3);

    // 4. 弾ける粒。土や砂利ほど強い。舗装の上ではほとんど鳴らない。
    // 最初の1/4秒だけ。滑り出しの瞬間に小石が跳ねて、あとは擦れだけが残る
    const grit = this._noiseSource(rnd(1.1, 1.4));
    const gf = ctx.createBiquadFilter();
    gf.type = 'bandpass';
    gf.frequency.value = s.gritFreq * 0.9;
    gf.Q.value = 0.8;
    const gg = ctx.createGain();
    grit.connect(gf); gf.connect(gg); gg.connect(bus);
    gg.gain.setValueAtTime(0.0001, t);
    gg.gain.linearRampToValueAtTime(0.05 * s.vol * s.grit, t + 0.03);
    gg.gain.setTargetAtTime(0.0001, t + 0.03, 0.07);
    grit.start(t, Math.random() * 1.5);
    grit.stop(t + 0.6);

    const out = this._place(bus, position, camera, 6);
    this._out(out, surface === 'metal' ? 0.34 : 0.20, 0.14);
  }

  _step(intensity, surface, position, camera, weight) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const s = SURFACES[surface] ?? SURFACES.dirt;
    const vol = 0.16 * intensity * s.vol;

    const bus = ctx.createGain();
    bus.gain.value = 1;

    // 踏み込みの低音。素材が硬いほど高く短い
    const th = ctx.createOscillator();
    th.type = 'sine';
    th.frequency.setValueAtTime(s.thump * rnd(0.85, 1.2), t);
    th.frequency.exponentialRampToValueAtTime(s.thump * 0.55, t + 0.06);
    const thg = ctx.createGain();
    th.connect(thg); thg.connect(bus);
    this._env(thg, t, vol * 1.5 * weight, 0.003, s.decay * weight);
    th.start(t); th.stop(t + 0.3);

    // 表面の粒立ち。土や砂利はここが主役
    const src = this._noiseSource(rnd(0.7, 1.25));
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(s.gritFreq * rnd(0.8, 1.25), t);
    f.frequency.exponentialRampToValueAtTime(s.lp * rnd(0.7, 1.1), t + s.decay * 2);
    f.Q.value = s.gritQ;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(bus);
    this._env(g, t, vol * s.grit * (1 + (weight - 1) * 0.4), 0.002, s.decay * (1 + weight * 0.3));
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.5);

    // 爪先が擦れて抜ける音。踵が着いた少し後に鳴る。
    //
    // これが無いと1歩が「1点」で鳴って、機械が刻んでいるように聞こえる。
    // 実際の1歩は踵が着いてから爪先で蹴り出すまでに幅があり、
    // その2つの間隔が歩き方そのものになる。走るほど間隔が詰まって擦れが強い。
    // 走りの足音が安っぽかったのは、速く鳴らしているだけで
    // 「蹴り出している」音が1つも入っていなかったため
    // 間隔は短く、量は控えめに。前は最大6cm近く遅れて音量も0.42倍あり、
    // 1歩が「タッ・シャッ」と2回鳴って別の生き物の足音になっていた。
    // 実際の1歩は2つの音が重なって聞こえるくらいの近さで、
    // 擦れは踏み込みに混ざって聞こえるだけ
    const scuff = 0.016 + (2.1 - weight) * 0.008 + rnd(0, 0.006);
    const ssrc = this._noiseSource(rnd(0.35, 0.6));
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.setValueAtTime(s.gritFreq * 0.55, t + scuff);
    sf.frequency.exponentialRampToValueAtTime(s.gritFreq * 0.22, t + scuff + 0.09);
    sf.Q.value = 0.7;
    const sg = ctx.createGain();
    ssrc.connect(sf); sf.connect(sg); sg.connect(bus);
    // 重い着地ほど強く擦る。歩きでは薄く、走りと着地でしっかり出る
    this._env(sg, t + scuff, vol * 0.20 * weight, 0.004, s.decay * 1.1);
    ssrc.start(t + scuff, Math.random() * 1.5);
    ssrc.stop(t + scuff + 0.35);

    const out = this._place(bus, position, camera, 5);
    this._out(out, surface === 'metal' ? 0.34 : 0.18, surface === 'metal' ? 0.3 : 0.12);

    // 金属板は踏むと共鳴する。コンテナや斜路の上だけ音が別物になるのが分かる
    if (s.partials && s.ring > 0.05) {
      this._metal(t + 0.002, {
        partials: s.partials, vol: vol * s.ring * weight, decay: s.decay * 1.4,
        ring: 1.0, noiseFreq: s.lp, noiseQ: 1.0, position, camera, refDist: 5, wet: 0.3,
      });
    }
  }

  /* ------------------------------------------------------------ 着弾 */

  // 素材で高域の質感を変える
  impact(kind = 'concrete', position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const tone = { concrete: 2400, metal: 5200, wood: 1500, flesh: 700 }[kind] ?? 2400;
    const src = this._noiseSource(rnd(0.85, 1.2));
    const f = ctx.createBiquadFilter();
    f.type = kind === 'metal' ? 'bandpass' : 'lowpass';
    f.frequency.value = tone * rnd(0.85, 1.2);
    f.Q.value = kind === 'metal' ? 6 : 1;
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, kind === 'flesh' ? 0.5 : 0.34, 0.001, kind === 'metal' ? 0.16 : 0.06);
    const out = this._place(g, position, camera, 10);
    this._out(out, 0.4, 0.3);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.5);

    // 金属は跳弾のキーンを足す
    if (kind === 'metal' && Math.random() < 0.6) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      const base = rnd(1400, 3200);
      o.frequency.setValueAtTime(base, t);
      o.frequency.exponentialRampToValueAtTime(base * 0.35, t + 0.35);
      const og = ctx.createGain();
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass'; bp.Q.value = 12; bp.frequency.value = base;
      o.connect(bp); bp.connect(og);
      this._env(og, t, 0.08, 0.004, 0.3);
      const o2 = this._place(og, position, camera, 10);
      this._out(o2, 0.5, 0.4);
      o.start(t); o.stop(t + 0.6);
    }
  }

  /* ------------------------------------------------------ 至近弾の風切り */

  /**
   * 敵の外れ弾が体の近くを抜けた時の音。distanceは弾道とプレイヤーの最短距離[m]。
   * panは-1(左)..1(右)。省くと左右ランダム。
   * これが無いと「撃たれている怖さ」が出ないので、外れ弾ほど大事。
   */
  whizBy(distance = 2, pan = null) {
    if (!this.ready || !this.enabled) return;
    if (distance > 5) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const near = clamp(1 - distance / 5, 0, 1);
    const vol = 0.06 + near * near * 0.55;
    const p = pan === null ? rnd(-0.85, 0.85) : clamp(pan, -1, 1);

    const bus = ctx.createGain();
    bus.gain.value = 1;

    // 通過に合わせて帯域を下げる。上から下へ滑るとドップラーに聞こえる
    const src = this._noiseSource(rnd(1.0, 1.35));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(rnd(2300, 3400), t);
    bp.frequency.exponentialRampToValueAtTime(rnd(600, 900), t + 0.05 + near * 0.035);
    bp.Q.value = rnd(1.3, 2.2);
    const g = ctx.createGain();
    src.connect(bp); bp.connect(g); g.connect(bus);
    this._env(g, t, vol, 0.003, 0.045 + near * 0.03);
    src.start(t, Math.random() * 1.5);
    src.stop(t + 0.4);

    // 至近弾は衝撃波のパチンが先に立つ。ここが「掠った」感の正体
    if (near > 0.5) {
      const snap = this._noiseSource(rnd(1.1, 1.4));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = rnd(4200, 6200);
      const sg = ctx.createGain();
      snap.connect(hp); hp.connect(sg); sg.connect(bus);
      this._env(sg, t, vol * 0.8 * near, 0.0004, 0.012);
      snap.start(t, Math.random() * 1.5);
      snap.stop(t + 0.15);
    }

    const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (panner) {
      panner.pan.value = p;
      bus.connect(panner);
      this._out(panner, 0.3, 0.35);
    } else {
      this._out(bus, 0.3, 0.35);
    }
  }

  /* ------------------------------------------------------------ 通知 */

  /**
   * 命中通知。当たった瞬間に耳元で鳴らす短い打点。
   *
   * 頭に当てた時は「高く」ではなく「鈍く」鳴らす。
   * 前は矩形波の1750→2400Hzを追い打ちで足していて、これは電子音の作り方
   * そのもの（矩形波は倍音が全部残るので、高い所で鳴らすと一番耳に刺さる）。
   * 頭に当たった手応えとして欲しいのは高さではなく重さなので、
   * 胴体より低い所へ落として、下へ滑らせ、低音を1枚敷く。
   */
  hitmarker(headshot = false) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // 矩形波1150Hzは電子的すぎて「当たった」より「通知が来た」に聞こえる。
    // 短い木を叩く音に寄せる。三角波を素早く下げると打点が出る
    const o = ctx.createOscillator();
    // 頭に当てた方はサイン波にする。三角波は3倍・5倍の倍音を持つので、
    // 620Hzで鳴らすと1860Hzと3100Hzが一緒に出て、そこが鈍さを消していた。
    // 胴の方は輪郭が欲しいので三角波のまま
    o.type = headshot ? 'sine' : 'triangle';
    o.frequency.setValueAtTime(headshot ? 620 : 900, t);
    o.frequency.exponentialRampToValueAtTime(headshot ? 190 : 430, t + (headshot ? 0.09 : 0.055));
    const g = ctx.createGain();
    o.connect(g);
    this._env(g, t, headshot ? 0.22 : 0.24, 0.001, headshot ? 0.075 : 0.05);
    // 通知音は耳鳴りの向こうでも聞こえるべきなので、被弾フィルタを迂回する
    g.connect(this.postBus);
    this._reap([g], 1.0);
    o.start(t); o.stop(t + 0.2);

    // 胴に当てた時の低音。測ると、当たった音は30〜250Hzの取り分が0.2%しかなく、
    // 音量も山が0.12と、キル音の6分の1しか出ていなかった。
    // 一番よく聞く音がこれでは、当てた手応えが最初から存在しない。
    //
    // ただし長くはできない。ライフルは0.094秒に1発なので、100msを超えると
    // 次の当たり音と重なって団子になる。短いまま重さだけ足す
    if (!headshot) {
      const lo = ctx.createOscillator();
      lo.type = 'sine';
      lo.frequency.setValueAtTime(210, t);
      lo.frequency.exponentialRampToValueAtTime(112, t + 0.055);
      const lg = ctx.createGain();
      lo.connect(lg); lg.connect(this.postBus);
      this._env(lg, t, 0.30, 0.0015, 0.048);
      this._reap([lg], 1.0);
      lo.start(t); lo.stop(t + 0.2);
      // 芯。低音だけ足すと輪郭が消えて「ボッ」になるので、上に点を打つ
      const tick = this._noiseSource(1.3);
      const bpf = ctx.createBiquadFilter();
      bpf.type = 'bandpass';
      bpf.frequency.value = 1750;
      bpf.Q.value = 1.1;
      const tg = ctx.createGain();
      tick.connect(bpf); bpf.connect(tg); tg.connect(this.postBus);
      this._env(tg, t, 0.13, 0.0006, 0.015);
      this._reap([tg, bpf], 1.0);
      tick.start(t, Math.random()); tick.stop(t + 0.1);
    }
    if (headshot) {
      // 重さのぶん。サイン波を190→95Hzへ落とす。倍音が無いので
      // 音程としてではなく「ドッ」という圧として聞こえる
      const lo = ctx.createOscillator();
      lo.type = 'sine';
      lo.frequency.setValueAtTime(190, t);
      lo.frequency.exponentialRampToValueAtTime(95, t + 0.09);
      const lg = ctx.createGain();
      lo.connect(lg); lg.connect(this.postBus);
      this._env(lg, t, 0.24, 0.0015, 0.085);
      this._reap([lg], 1.0);
      lo.start(t); lo.stop(t + 0.3);
      // 潰れる質感。低い所で切ったノイズを一瞬だけ。
      // 高い所を残すと結局「チッ」と鳴って鈍さが消えるので2.2kHzで蓋をする
      const th = this._noiseSource(0.55);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 1300;
      // 2段重ねる。1段だと1オクターブで12dBしか落ちず、蓋をしたつもりでも
      // 2.5〜7kHzが22%残って「鈍く」ならなかった
      const lp2 = ctx.createBiquadFilter();
      lp2.type = 'lowpass';
      lp2.frequency.value = 1300;
      const tg = ctx.createGain();
      th.connect(lp); lp.connect(lp2); lp2.connect(tg); tg.connect(this.postBus);
      this._env(tg, t, 0.22, 0.001, 0.055);
      this._reap([tg, lp, lp2], 1.0);
      th.start(t, Math.random()); th.stop(t + 0.2);
    }
  }

  /* ------------------------------------------ 倒した合図（5案の作り） */

  /**
   * 倒した合図は「軽い」と何度も言われて作り直した。
   * 5回目までは勘で直していたが、tools/sound-lab.mjs で波形を書き出して
   * 測ったら、軽さの正体がはっきり数字で出た。
   *
   *   これまでの5案 … 30〜250Hzの取り分が 0.0〜0.4%、長さ100〜315ms、山2〜4本
   *   爆発          … 同じ帯が 42%、長さ2000ms
   *
   * つまり低い音がまったく入っていなかった。人が「重い」「迫力がある」と
   * 感じるのはこの帯で、ここが空だと上で何を鳴らしても薄い通知音にしかならない。
   * 加えて、純粋なサイン波は倍音が1本しか無いので、何本重ねても密度が出ない。
   *
   * 作り直しでは3つを土台にした。
   *   1. サブベース … 80Hz付近から40Hzへ落とす層。歪ませない（濁ると汚れになる）
   *   2. 歪み       … 中高域だけを軽く潰して倍音を増やす。同じ音量で密度が上がる
   *   3. 尾         … 300〜700msの余韻。短く切ると「ピッ」で終わって手応えが残らない
   */

  // 歪ませる曲線。tanhで軽く潰す。潰すほど倍音が増えて密度が出るが、
  // やりすぎると割れた音になるだけなので、係数は2〜3の範囲で使う
  _satCurve(k = 2.4) {
    const n = 1024;
    const c = new Float32Array(n);
    const norm = Math.tanh(k);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * k) / norm;
    }
    return c;
  }

  /**
   * 倒した合図の土台。各案の声はここが返す入口へ繋ぐ。
   *   ・入口は歪み器。通った音は倍音が増えて太くなる
   *   ・同時に低音の層を1枚敷く。これが「重さ」そのもの
   * 低音を歪み器に通さないのは、潰すと輪郭が濁って重さではなく汚れになるため
   */
  _killBed(t, { sub = 1, subF0 = 86, subF1 = 41, subLen = 0.22, satK = 2.4, level = 0.5 } = {}) {
    const ctx = this.ctx;
    const shaper = ctx.createWaveShaper();
    shaper.curve = this._satC || (this._satC = this._satCurve(satK));
    // 歪ませた後に必ず蓋をする。tanhで潰すと倍音が上へ無限に伸びるので、
    // 掛けっぱなしだと音の重心が3kHzより上へ持って行かれて、
    // 低音を足したのに「シャリシャリして軽い」という妙な音になる。
    // 潰してから削るのが順番で、逆にすると密度だけ落ちる
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    lp.Q.value = 0.7;
    const out = ctx.createGain();
    out.gain.value = level;
    shaper.connect(lp); lp.connect(out);
    // 耳鳴りのフィルタを迂回する。倒した知らせが被弾で埋もれると、
    // 撃ち合いの真っ最中＝一番知りたい時に限って聞こえない
    out.connect(this.postBus);
    this._reap([out, lp], 2.0);

    if (sub > 0) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(subF0, t);
      o.frequency.exponentialRampToValueAtTime(subF1, t + subLen);
      const g = ctx.createGain();
      o.connect(g); g.connect(this.postBus);
      this._env(g, t, 0.50 * sub, 0.002, subLen);
      this._reap([g], 2.0);
      o.start(t); o.stop(t + subLen * 4 + 0.2);
      // 低音だけだと聞こえない環境（ノートPCの内蔵スピーカー等）がある。
      // 2倍の所に薄く重ねると、低音が出ない機械でも重さの手掛かりが残る
      const o2 = ctx.createOscillator();
      o2.type = 'sine';
      o2.frequency.setValueAtTime(subF0 * 2, t);
      o2.frequency.exponentialRampToValueAtTime(subF1 * 2, t + subLen);
      const g2 = ctx.createGain();
      o2.connect(g2); g2.connect(shaper);
      this._env(g2, t, 0.30 * sub, 0.002, subLen * 0.8);
      this._reap([g2], 2.0);
      o2.start(t); o2.stop(t + subLen * 4 + 0.2);
    }
    return shaper;
  }

  /**
   * 倒した合図の1音ぶん。
   * @param bend 1以外を渡すと、鳴っている間にその倍率まで音程を滑らせる
   * @param dest 繋ぎ先。省略すると歪みを通さずそのまま出る
   */
  _killTone(t, freq, level, attack, decay, type = 'sine', bend = 1, dest = null) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (bend !== 1) o.frequency.exponentialRampToValueAtTime(freq * bend, t + decay);
    const g = this.ctx.createGain();
    o.connect(g); g.connect(dest || this.postBus);
    this._env(g, t, level, attack, decay);
    this._reap([g], 1.6);
    o.start(t); o.stop(t + attack + decay * 3 + 0.05);
  }

  /**
   * 倒した合図のノイズ層。帯域で切り出して打点を作る。
   * bandpassだと帯の中心が鳴って「チッ」に、highpassだと上が全部残って
   * 「シャッ」になる。前者は硬い物、後者は空気の抜けに聞こえる
   */
  _killNoise(t, level, decay, { hp = 0, bp = 0, q = 1, rate = 1.4 } = {}, dest = null) {
    const src = this._noiseSource(rate);
    const f = this.ctx.createBiquadFilter();
    if (bp) { f.type = 'bandpass'; f.frequency.value = bp; f.Q.value = q; }
    else { f.type = 'highpass'; f.frequency.value = hp; }
    const g = this.ctx.createGain();
    src.connect(f); f.connect(g); g.connect(dest || this.postBus);
    this._env(g, t, level, 0.0006, decay);
    this._reap([g, f], 1.6);
    src.start(t, Math.random()); src.stop(t + decay * 4 + 0.05);
  }

  /**
   * 打点を1つ。低い所で叩いて、音程を下へ落とす。
   *
   * 「デン」と聞こえるのは音程が下がるから。上げると「ディン」＝撞いた音になる。
   * 層は3つで、低音が重さ、胴が輪郭、頭の一瞬が打った感触を作る。
   */
  _killBeat(t, dest, {
    f0 = 120, f1 = 62, body = 220, bodyTo = 140,
    level = 1, len = 0.10, subLen = 0.09, edge = 0, punch = 700, weight = 1,
  }) {
    // 低音のつまみは、敷く低音の量だけでなく胴の落ち方も動かす。
    // 量だけ絞っても、胴が下まで滑り落ちるぶんの低い音が残って、
    // 0まで下げても3割しか軽くならなかった。落とす幅も一緒に縮める
    const fall = 0.45 + 0.55 * Math.min(1.4, weight);
    bodyTo = body - (body - bodyTo) * fall;
    const ctx = this.ctx;
    // 低音。歪ませずにpostBusへ直に出す。潰すと重さではなく濁りになる
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + subLen);
    const g = ctx.createGain();
    o.connect(g); g.connect(this.postBus);
    this._env(g, t, 0.40 * level * weight, 0.0015, subLen);
    this._reap([g], 2.0);
    o.start(t); o.stop(t + subLen * 4 + 0.3);

    // 胴。三角波を歪ませて倍音を詰める。ここが無いと低音だけの唸りになって、
    // 何が鳴ったのか輪郭が読めない
    this._killTone(t, body, 0.56 * level, 0.001, len, 'triangle', bodyTo / body, dest);
    this._killTone(t + 0.002, body * 1.5, 0.26 * level, 0.001, len * 0.7, 'sine', bodyTo / body, dest);

    // 叩いた頭の一瞬。上を残すと甲高くなるので、低い所で切って厚みだけ足す
    this._killNoise(t, 0.30 * level, 0.014, { bp: punch, q: 0.8 }, dest);
    // 抜けを良くしたい時だけ、上に細い芯を置く
    if (edge > 0) this._killNoise(t, 0.16 * edge * level, 0.012, { bp: 2600, q: 1.6 }, dest);
  }

  /**
   * 倒した合図。打点をいくつか並べて鳴らす。最後の打点が本命で余韻を持つ。
   * 実際の値は上の KILL_TUNE。
   */
  _killShot(t, head) {
    const c = KILL_TUNE;
    const n = clamp(Math.round(c.hits), 1, 3);
    // 頭に当てた時だけ全体を長3度上げる。同じ音の音量違いでは差が伝わらない
    const p = c.pitch * (head ? 1.26 : 1);
    const bed = this._killBed(t, { sub: 0, satK: c.drive, level: 0.62 * c.level });

    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const at = t + c.gap * i;
      // 最後だけ低く長く大きく。手前は短い助走にする
      const k = last ? 1 : 0.62 + i * 0.06;
      // 手前の打点は、間隔より長く鳴らすと次の打点に被って1発に聞こえる。
      // 間隔を一番詰めた時に実際そうなって、2発目が消えていた
      const lead = Math.min(0.085, c.gap * 0.55);
      this._killBeat(at, bed, {
        f0: (last ? 112 : 132) * p, f1: (last ? 52 : 74) * p,
        body: (last ? 300 : 360) * p, bodyTo: (last ? 205 : 268) * p,
        level: (last ? 1.30 : 0.60) * k / (last ? 1 : 0.62),
        len: last ? 0.24 * c.tail : lead,
        subLen: last ? 0.20 * c.tail : lead * 0.82,
        weight: c.weight, edge: c.edge,
        punch: (last ? 850 : 980) * p,
      });
    }

    // 最後の打点の余韻。完全5度で重ねると濁らずに伸びる。
    // これが無いと叩いて終わりで、「ン」の残りが出ない
    const end = t + c.gap * (n - 1);
    this._killTone(end + 0.01, 190 * p, 0.26 * c.weight, 0.004, 0.40 * c.tail, 'sine', 0.88, bed);
    this._killTone(end + 0.01, 285 * p, 0.20 * c.weight, 0.004, 0.32 * c.tail, 'sine', 0.88, bed);
    this._killNoise(end + 0.03, 0.06, 0.32 * c.tail, { bp: 700 * p, q: 0.7 }, bed);
    // 芯を上げた時だけ、上に伸びる余韻も足す。ここが「抜け」を作る
    if (c.edge > 0.05) {
      this._killNoise(end + 0.02, 0.05 * c.edge, 0.26 * c.tail, { bp: 3200 * p, q: 1.1 }, bed);
    }
  }

  kill(headshot = false) {
    if (!this.ready || !this.enabled) return;
    this._killShot(this.ctx.currentTime, headshot);
  }

  /**
   * 自分が倒れた時。
   *
   * 敵が倒れる音(death)とは別物にしてある。あちらは「向こうで何かが倒れた」を
   * 場の中で鳴らす音だが、こちらは自分にしか聞こえない音なので、
   * 場に馴染ませる必要がない。遠慮なく前に出す。
   *
   * 作りは3層:
   *   1. 落ちる低音 … 倒れ込む重さ。ここが無いと「点数が止まった」だけになる
   *   2. 潰れたノイズ … 地面に着く音
   *   3. 尾を引く高い音 … 耳鳴り。撃たれて意識が飛ぶ側の合図で、
   *      これがあると音が途切れずに結果画面へ繋がる
   */
  /**
   * 自分が倒れた。**画面が結果へ切り替わるまで、一番長く聴かされる音。**
   *
   * 前の作りを測ったら、こういう形をしていた:
   *
   *   超低 33.6% ／ 低 7.0% ／ **中低 2.2%** ／ 中 19.2% ／ **高 35.4%**
   *
   * つまり**一番下と一番上しか無い。** 胴体（250〜800Hz）が空っぽで、
   * そのぶん3.1kHzの純音（耳鳴り）が音の主役になっていた。
   * 純音は素材として一番安っぽく聞こえるので、それが主役だと全体が安く聞こえる。
   * 比較として爆発は 23.8 / 10.1 / 24.3 / 21.2 / 9.4 と満遍なく埋まっている。
   *
   * 直した後:
   *
   *   超低 25.5% ／ 低 14.5% ／ **中低 23.7%** ／ 中 18.6% ／ **高 13.2%** ／ 打点2つ
   *
   * **どこが効いたのかも1つずつ測った。** 思っていたのと違った:
   *
   *   ・耳鳴りの音量を 0.075 → 0.013 に落とす … 中低が 17.7 → 23.7（一番効いた）
   *     35%を占めていた物が減ると、残り全部の取り分がそのぶん上がる
   *   ・着地の低域切りを 420 → 640Hz へ開ける … 中低が 21.3 → 23.7
   *   ・胴体の層を足す … 中低が 22.6 → 23.7（**思ったより効いていない**）
   *
   * つまり「胴体が空だったから足した」より、
   * **「純音が場所を取りすぎていたから退かした」のほうが本体**だった。
   * 足す前に、大きすぎる物を探すほうが先。
   *
   * 打点が2つになったのは、落ちる低音を0.95秒から0.3秒へ縮めて
   * 着地の手前で切ったから。鳴りっぱなしだと着地が別の出来事に聞こえない。
   */
  playerDown() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // 1. 落ちる低音。高い所から下へ滑らせる。**ここが「重さ」そのもの**
    const lo = ctx.createOscillator();
    lo.type = 'sine';
    lo.frequency.setValueAtTime(180, t);
    lo.frequency.exponentialRampToValueAtTime(52, t + 0.42);
    const lg = ctx.createGain();
    lo.connect(lg); lg.connect(this.postBus);
    /* **着地の手前で切る。** 前は0.95秒かけて減衰していて、
       その間ずっと音が鳴り続けているせいで、着地の音が「別の出来事」として
       立たなかった（測ると打点が1つのまま＝崩れたのか着いたのか耳から分からない）。
       落ちている間の音は、着いた時点で終わるのが本来の形でもある */
    this._env(lg, t, 0.34, 0.006, 0.3);
    this._reap([lg], 1.2);
    lo.start(t); lo.stop(t + 0.7);

    /* 2. 胴体。400〜600Hzのノイズを幅を持たせて鳴らす。
       歪み器に通すのは、素のノイズだと「サー」で終わって物が崩れる音にならないため。
       **帯の取り分としては1ポイントほどしか動かない**（測った）。
       ここが持っているのは「崩れていく」という形のほうで、
       数字を直したのは耳鳴りを退かしたことのほう */
    const body = this._noiseSource(0.85);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(640, t);
    bp.frequency.exponentialRampToValueAtTime(480, t + 0.55);
    bp.Q.value = 0.75;
    const sat = ctx.createWaveShaper();
    sat.curve = this._satCurve(2.0);
    sat.oversample = '2x';
    /* 歪ませた後を低めで切る。**歪みは倍音を上へ伸ばす**ので、
       そのまま出すとせっかく足した胴体が高域の足しにしかならない
       （実測で 高2.5k-7k が22.6%まで上がった） */
    const bodyLp = ctx.createBiquadFilter();
    bodyLp.type = 'lowpass';
    bodyLp.frequency.value = 1100;
    const bg = ctx.createGain();
    body.connect(bp); bp.connect(sat); sat.connect(bodyLp); bodyLp.connect(bg); bg.connect(this.postBus);
    // 減衰を短くするのは、長く伸ばすと次の打点（着地）を覆い隠して
    // 出来事が1つに聞こえるため（実測で打点が2→1に戻った）
    this._env(bg, t, 1.5, 0.01, 0.24);
    this._reap([bg], 1.4);
    body.start(t); body.stop(t + 0.95);

    // 胴体の芯。ノイズだけだと高さが定まらないので、同じ帯に音程を1本置く
    const mid = ctx.createOscillator();
    mid.type = 'triangle';
    mid.frequency.setValueAtTime(540, t);
    mid.frequency.exponentialRampToValueAtTime(215, t + 0.5);
    const mg = ctx.createGain();
    mid.connect(mg); mg.connect(this.postBus);
    this._env(mg, t, 0.46, 0.004, 0.46);
    this._reap([mg], 1.2);
    mid.start(t); mid.stop(t + 0.7);

    /* 3. 地面に着く音。**2つ目の打点。**
       低音の滑りが終わった所に置く。前は薄すぎて（0.30）打点として数えられず、
       測ると打点1個のまま＝出来事が1つしか無い音だった。
       低域切りを420Hzから640Hzへ開けてあるのは、閉じたままだと
       この音が全部「超低」へ入って、胴体の帯に何も残らないため */
    const thud = this._noiseSource(1.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(640, t);
    const tg = ctx.createGain();
    thud.connect(lp); lp.connect(tg); tg.connect(this.postBus);
    this._env(tg, t + 0.48, 0.78, 0.003, 0.3);
    this._reap([tg], 1.6);
    thud.start(t + 0.48); thud.stop(t + 1.0);

    // 着地に低い芯を重ねる。ノイズだけだと「バサッ」で止まって、地面の硬さが出ない
    const floor = ctx.createOscillator();
    floor.type = 'sine';
    floor.frequency.setValueAtTime(96, t + 0.48);
    floor.frequency.exponentialRampToValueAtTime(44, t + 0.84);
    const fg = ctx.createGain();
    floor.connect(fg); fg.connect(this.postBus);
    this._env(fg, t + 0.48, 0.28, 0.004, 0.36);
    this._reap([fg], 1.6);
    floor.start(t + 0.48); floor.stop(t + 1.0);

    /* 4. 余韻。**純音（サイン波1本）は使わない。**
       前は3.1kHzのサイン波を「耳鳴り」として鳴らしていた。音量を35%から
       13%まで落としても、**「甲高いピュー」が不快**だと言われた。
       音量の問題ではなく、**純音そのものが耳につく**のが原因。
       サイン波は自然界にほぼ無い音なので、小さくても耳が必ず拾い上げる。

       替わりに、低めの雑音を1枚だけ残す。同じ「音が切れない」役目を果たしつつ、
       高さを持たないので「鳴っている」と意識されない。
       中心を900Hzまで下げてあるのは、2kHzより上に山があると
       どんな作り方でも「ピー」に寄るため */
    const air = this._noiseSource(0.7);
    const ap = ctx.createBiquadFilter();
    ap.type = 'bandpass';
    ap.frequency.setValueAtTime(900, t);
    ap.frequency.exponentialRampToValueAtTime(420, t + 1.1);
    ap.Q.value = 1.1;
    const ag = ctx.createGain();
    air.connect(ap); ap.connect(ag); ag.connect(this.postBus);
    this._env(ag, t + 0.05, 0.12, 0.12, 0.9);
    this._reap([ag], 1.8);
    air.start(t); air.stop(t + 1.6);

    /* 遠くの低い唸り。倒れた後の「まだ世界は続いている」を残す。
       ここも高さを持たせない（音程が聞こえると、それはそれで耳につく）ので、
       低い所へ薄く1枚だけ */
    const hum = ctx.createOscillator();
    hum.type = 'sine';
    hum.frequency.setValueAtTime(74, t);
    hum.frequency.exponentialRampToValueAtTime(58, t + 1.4);
    const hg = ctx.createGain();
    hum.connect(hg); hg.connect(this.postBus);
    this._env(hg, t + 0.1, 0.1, 0.2, 1.1);
    this._reap([hg], 1.8);
    hum.start(t); hum.stop(t + 1.6);
  }

  /**
   * 誰かがロビーに入ってきた合図。「ピコン」。
   *
   * これは戦闘中に鳴る音ではなく、**別の作業をしている人に気づかせる音**なので、
   * 作りの狙いが他と違う。他の音は場に馴染ませるが、これは馴染ませない。
   *
   * - 高い2音を上がる形で並べる。上がる音は「来た・増えた」に聞こえる。
   *   下がると「終わった・抜けた」になるので、入室に下降は使わない
   * - サイン波にする。ノイズや倍音の多い波は環境音に紛れて、
   *   画面を見ていない人には聞こえない
   * - 距離減衰も残響も通さない。場所を持たない音なので、
   *   位置を付けると「どこかで鳴った」になって用を成さない
   */
  lobbyJoin() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // 1音目は短く切る。2音目と繋がって「ピー」になると呼びかけに聞こえない
    const beep = (at, freq, vol, len) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, at);
      const g = ctx.createGain();
      o.connect(g);
      // 立ち上がりを0にすると先頭がプチッと鳴るので、わずかに寝かせる
      this._env(g, at, vol, 0.004, len);
      // 被弾で耳鳴りが掛かっている最中でも聞こえてほしいので、そのフィルタは迂回する
      g.connect(this.postBus);
      this._reap([g], 1.2);
      o.start(at); o.stop(at + len + 0.05);
    };
    beep(t, 1320, 0.22, 0.075);
    beep(t + 0.085, 1980, 0.20, 0.16);
  }

  /**
   * 買えた合図。**硬貨が数枚、硬い所へ落ちて跳ねる音。**
   *
   * 2026-08-11に作り直した。前は三角波と正弦波の分散和音（ドミソを上がる形）で、
   * 「古すぎる」と言われた。**言われた通りで、正体は「ノイズが1粒も無いこと」だった。**
   *
   * 純粋な発振器だけで組むと、どう並べても8ビットの効果音になる。
   * 本物の硬貨の音は、
   *
   *   1. **当たった瞬間の広い帯のノイズ**（「チッ」の部分）… ここが無いと物に聞こえない
   *   2. 整数比から外れた金属の余韻（円盤が鳴る）
   *   3. 落ちた面の胴（「トッ」）
   *
   * の3つで出来ていて、前の音には1と3が丸ごと無かった。
   * ドミソの上がる分散和音そのものも、レトロゲームの硬貨の型そのままだった。
   *
   * **1枚ではなく4枚落とす。** 和音を1回鳴らすと「合図」になるが、
   * 少しずつずれた間隔で複数当てると「お金」になる。
   * 間隔を等間隔にしないのが効く（等間隔だと機械が刻んでいるように聞こえる）。
   *
   * 守っている線（tools/check-sound.mjsの[8]が測る）:
   *
   * - **ロビー入室(lobbyJoin)と混ざらないこと。** 画面を見ていない人に気づかせる音は
   *   この2つだけなので、買った後に「誰か入ってきた」と思われたら失敗
   * - 山は0.5未満。場所を持たない合図なので、戦闘中の音より大きくしない
   * - **低音(30〜250Hz)は5%未満。** 太らせると遠くの爆発と紛らわしくなる。
   *   胴は250〜800Hzに置くので、この線には当たらない
   *
   * 場所を持たない音なので、距離減衰も残響も通さない（lobbyJoinと同じ扱い）
   */
  purchase() {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    /* 硬貨1枚ぶん。当たる瞬間のノイズと、金属の余韻を組で鳴らす。
       @param at 鳴らす時刻 @param base 余韻の基音 @param vol 音量 @param ring 余韻の長さ */
    const coin = (at, base, vol, ring) => {
      /* (1) 当たった瞬間。**ノイズを帯域で切って10msだけ出す。**
         ここが「物が当たった」の全部。発振器では代わりが作れない */
      const n = this._noiseSource(1.0);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.setValueAtTime(base * 1.35, at);
      // Qを上げると金属寄り、下げると砂利寄り。硬貨はこのくらい
      bp.Q.setValueAtTime(1.6, at);
      const ng = ctx.createGain();
      n.connect(bp); bp.connect(ng); ng.connect(this.postBus);
      this._env(ng, at, vol * 0.55, 0.0004, 0.012);
      this._reap([ng, bp], 0.6);
      n.start(at); n.stop(at + 0.05);

      /* (2) 金属の余韻。**整数比から外した2本。**
         1 : 1.593 は円盤を叩いた時の並びに近い比で、
         ここを1:2にすると「ポーン」という笛の音になって硬貨から離れる */
      for (const [mul, mv] of [[1, 1], [1.593, 0.62]]) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        o.frequency.setValueAtTime(base * mul, at);
        const g = ctx.createGain();
        o.connect(g); g.connect(this.postBus);
        this._env(g, at, vol * mv * 0.5, 0.001, ring);
        this._reap([g], ring + 0.4);
        o.start(at); o.stop(at + ring + 0.1);
      }
    };

    /* 4枚。**間隔を等間隔にしない**（48→53→67ms）。
       等間隔にすると機械が刻んでいるように聞こえて、落ちた物に聞こえない。
       音程も1枚ずつ変えてある（同じ硬貨が4回鳴ると連射に聞こえる）。
       最後の1枚だけ余韻を長く取って、「終わった」を出す。

       **測ると打点は1発と出るが、それで合っている。**
       打点の数え方は「一度20%まで下がってから、また45%を超えた所」を数えるので、
       余韻が100ms残っている硬貨を50ms間隔で落とすと谷がそこまで下がらない。
       耳には4枚に聞こえる（50ms間隔は毎秒20回で、人には別々の粒として届く） */
    coin(t, 1960, 0.30, 0.10);
    coin(t + 0.048, 2470, 0.26, 0.09);
    coin(t + 0.101, 1720, 0.22, 0.13);
    coin(t + 0.168, 2930, 0.24, 0.34);

    /* 落ちた面の胴（「トッ」）。**250〜800Hzに置く。**
       ここが無いと、硬貨が空中で鳴っているように聞こえる。
       低音の判定は30〜250Hzしか見ていないので、この帯なら太らせても線に当たらない */
    const body = this._noiseSource(0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'bandpass';
    lp.frequency.setValueAtTime(420, t);
    lp.Q.setValueAtTime(1.1, t);
    const bg = ctx.createGain();
    body.connect(lp); lp.connect(bg); bg.connect(this.postBus);
    this._env(bg, t, 0.16, 0.001, 0.055);
    this._reap([bg, lp], 0.6);
    body.start(t); body.stop(t + 0.2);
  }

  /**
   * 爆発。銃声と同じ3層の作りだが、比率が逆になる。
   * 銃声は高いクラックが主役で低音が支え。爆発は低音が主役で、
   * 高域は「立ち上がりの割れ」として一瞬だけ乗る。
   * ここを銃声と同じ比率で作ると、ただの大きい銃声になって爆発に聞こえない
   */
  explosion(position, camera) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    // 音は光より遅い。近いと同時、遠いと遅れて届く
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);

    // (1) 低音の押し。90Hzから20Hzへ落として腹に来る成分を作る
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    // 低音を1本から2本に。62Hzと94Hzをずらして重ねると唸りが出て太くなる。
    // 1本だと音程のはっきりした「ボン」になって、玩具の破裂音に近づく
    sub.frequency.setValueAtTime(rnd(58, 70), t);
    sub.frequency.exponentialRampToValueAtTime(16, t + 0.85);
    const sg = ctx.createGain();
    sub.connect(sg);
    this._env(sg, t, 0.66, 0.004, 0.75);
    this._out(this._place(sg, position, camera, 30, dist), 0.5, 0.5);
    sub.start(t); sub.stop(t + 1.6);

    // 2本目の低音。1本目とわずかにずらして唸りを作る。
    // 同じ周波数を重ねても音量が増えるだけだが、ずらすと「うねる」ぶん体積が出る
    const sub2 = ctx.createOscillator();
    sub2.type = 'sine';
    sub2.frequency.setValueAtTime(rnd(88, 104), t);
    sub2.frequency.exponentialRampToValueAtTime(24, t + 0.6);
    const sg2 = ctx.createGain();
    sub2.connect(sg2);
    this._env(sg2, t, 0.42, 0.004, 0.5);
    this._out(this._place(sg2, position, camera, 28, dist), 0.5, 0.5);
    sub2.start(t); sub2.stop(t + 1.2);

    // (2) 割れ。立ち上がりの一瞬だけ高域を通す
    const crack = this._noiseSource(rnd(0.9, 1.1));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(2200, t);
    bp.frequency.exponentialRampToValueAtTime(400, t + 0.18);
    bp.Q.value = 0.8;
    const cg = ctx.createGain();
    crack.connect(bp); bp.connect(cg);
    this._env(cg, t, 0.48, 0.002, 0.20);
    this._out(this._place(cg, position, camera, 22, dist), 0.45, 0.6);
    crack.start(t, Math.random()); crack.stop(t + 0.6);

    // (3) 尾。低く長く引いて空間の広さを出す
    const tail = this._noiseSource(0.35);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, t);
    lp.frequency.exponentialRampToValueAtTime(160, t + 1.1);
    const tg = ctx.createGain();
    tail.connect(lp); lp.connect(tg);
    this._env(tg, t + 0.03, 0.42, 0.02, 1.5);
    this._out(this._place(tg, position, camera, 26, dist), 0.7, 0.8);
    tail.start(t, Math.random()); tail.stop(t + 2.0);
  }

  /**
   * 刃が物に当たった音。当たった相手で鳴り方を変える。
   *
   * 全部同じ鈍い音にしていた時期があるが、遊んで
   * 「ナイフを障害物にやったらカンカン鳴ってほしい」と言われた。
   * 肉に刺さる音と鉄板を叩く音が同じでは、何に当たったのか耳から分からない。
   *
   * kind は着弾の材質分けと同じ言葉を使う（flesh / metal / wood / concrete）。
   * 分けているのは3つ:
   *   刺さる … 芯が低くて余韻が無い。「ドスッ」
   *   叩く   … 澄んだ倍音が重なって長く残る。「カンッ」
   *   突く   … その中間。木は短く、コンクリは芯だけ
   */
  stab(position, camera, kind = 'concrete') {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const flesh = kind === 'flesh';
    const bus = ctx.createGain();
    const ends = [];

    if (kind === 'metal') {
      /* 金属を叩いた音。
         鐘や鉄板の倍音は整数倍に並ばない（1:2:3ではなく1:2.76:5.40のように散る）。
         整数倍で重ねると「音程のある楽器」になってしまい、鉄を叩いた感じが出ない。
         散らした3本を高いQで長めに残すと「カンッ」と鳴って尾が引く */
      const base = rnd(1180, 1520);
      const ratios = [1, 2.71, 5.13];
      /* 音量。ここは最初この5倍にしていて、実測すると山が0.58〜0.92まで振れていた。
         銃声(0.67)より大きい音が壁を擦るたびに鳴る状態。
         しかも5分の1にしても山は0.38までしか下がらず、**比例していなかった**。
         出口のリミッターに突っ込んでいて、潰れたぶんだけ数字が動かなくなっていた。
         潰れる手前まで下げてあるのがこの値で、山は0.42（肉0.57・木0.45と同じ範囲） */
      const gains = [0.053, 0.030, 0.018];
      const decays = [0.34, 0.22, 0.14];
      for (let i = 0; i < ratios.length; i++) {
        const o = ctx.createOscillator();
        o.type = 'sine';
        // わずかに下がる。叩いた直後の張りが抜けていく所
        o.frequency.setValueAtTime(base * ratios[i], t);
        o.frequency.exponentialRampToValueAtTime(base * ratios[i] * 0.985, t + decays[i]);
        const g = ctx.createGain();
        o.connect(g); g.connect(bus);
        this._env(g, t, gains[i], 0.001, decays[i]);
        o.start(t); o.stop(t + 0.9);
        ends.push(o);
      }
      // 打点。刃が当たった瞬間の硬い当たり。これが無いと「後から鳴り出す」ように聞こえる
      const src = this._noiseSource(0.35);
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 2600;
      const g = ctx.createGain();
      src.connect(f); f.connect(g); g.connect(bus);
      this._env(g, t, 0.065, 0.001, 0.02);
      src.start(t, Math.random()); src.stop(t + 0.4);

      // 物がぶつかった手応え。倍音だけだと250〜800Hzの取り分が1.2%まで落ちて、
      // 鉄板ではなく鈴を鳴らしたように聞こえる（実測して足した。今は15.2%）。
      // 短く切るので「カン」の頭にしか乗らない
      const th = ctx.createOscillator();
      th.type = 'sine';
      th.frequency.setValueAtTime(420, t);
      th.frequency.exponentialRampToValueAtTime(180, t + 0.06);
      const thg = ctx.createGain();
      th.connect(thg); thg.connect(bus);
      this._env(thg, t, 0.050, 0.001, 0.045);
      th.start(t); th.stop(t + 0.3);
      ends.push(th);
      // 残響へ多めに送る。金属は周りへ響く物なので、乾いていると板ではなく紙に聞こえる
      this._out(this._place(bus, position, camera, 10), 0.32, 0.22);
      return;
    }

    // 突き当たりの芯。硬い物ほど高く短い
    const core = flesh ? 160 : kind === 'wood' ? 300 : 240;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(core, t);
    o.frequency.exponentialRampToValueAtTime(flesh ? 70 : core * 0.46, t + 0.05);
    const og = ctx.createGain();
    o.connect(og); og.connect(bus);
    this._env(og, t, 0.30, 0.002, flesh ? 0.07 : 0.05);

    // 擦れ。刃が入って止まるまでの短いノイズ
    const src = this._noiseSource(rnd(0.5, 0.8));
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = flesh ? 700 : kind === 'wood' ? 2400 : 1600;
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(bus);
    this._env(g, t, flesh ? 0.26 : 0.16, 0.002, 0.06);

    this._out(this._place(bus, position, camera, 8), 0.2, 0.1);
    o.start(t); o.stop(t + 0.3);
    src.start(t, Math.random()); src.stop(t + 0.3);
  }

  /**
   * 刃を振る音。空気を切る「シュッ」だけ。金属は鳴らさない（振っただけでは鳴らない）。
   *
   * **一度「鈍い」と言われて作り直した音。** 前は2層あって、
   * 空気の層（260〜620Hzのローパス）が**芯より大きい音量(1.45対1.30)**で鳴っていた。
   * 低い音は高い音を覆い隠すので、聞こえていたのはほぼ空気の方＝「ボワッ」。
   * 測ると低音13.5%・重心3282Hzで、数字の上では悪く見えないのが厄介な所だった。
   *
   * その空気の層は、もっと前に「低音が0.6%しかなくて細い糸のようだ」と言われて
   * 足した物で、**直しすぎて逆へ振れていた。** 今は芯に対する比(airGain)で持たせて、
   * 片方を動かしてももう片方との関係が崩れないようにしてある。
   *
   * @param tune 音の作り。**普段は渡さない。**
   *             tools/sound-lab.mjs が候補を聴き比べる時だけ差し替える
   */
  swing(tune = SWING_TUNE) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const u = tune;

    const src = this._noiseSource(rnd(u.rate[0], u.rate[1]));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    // 通り過ぎる間に帯域が上がって下がる。これが「横切った」に聞こえる。
    // **頂点の高さがシュッとゴォを分ける。** 実際の刃の風切りは4〜8kHzに芯がある
    bp.frequency.setValueAtTime(u.band[0], t);
    bp.frequency.exponentialRampToValueAtTime(u.band[1], t + u.at[0]);
    bp.frequency.exponentialRampToValueAtTime(u.band[2], t + u.at[1]);
    // Qが低いと帯が広がって、ノイズがそのまま「ゴォ」に聞こえる
    bp.Q.value = u.q;

    /* 機械の脈。**表に pulse がある形（チェーンソー）だけ。**
       エンジンの点火は1回ずつ別の破裂なので、音量をその速さの矩形波で刻むと、
       連続の「ゴォ」（風と同じ音）が機械の「ドュルルル」になる。
       振り終わりへ向けて刻みを少し落とす（振り抜くと回転が落ちる）。
       芯と空気の両方へ同じ刻みを挟む——片方だけ刻むと、
       刻まれていない層が隙間を埋めて脈が聞こえなくなる */
    let pulseDepth = null;
    if (u.pulse) {
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.setValueAtTime(u.pulse[0] * 1.12, t);
      lfo.frequency.exponentialRampToValueAtTime(u.pulse[0] * 0.82, t + 0.40);
      pulseDepth = ctx.createGain();
      pulseDepth.gain.value = u.pulse[1] / 2;
      lfo.connect(pulseDepth);
      lfo.start(t); lfo.stop(t + 0.5);
    }
    // 層の出口へ刻みを挟む。中心(1-深さ/2)に±深さ/2が乗り、1-深さ〜1で暴れる
    const chop = (node) => {
      if (!pulseDepth) return node;
      const trem = ctx.createGain();
      trem.gain.value = 1 - u.pulse[1] / 2;
      pulseDepth.connect(trem.gain);
      node.connect(trem);
      return trem;
    };

    const g = ctx.createGain();
    src.connect(bp); chop(bp).connect(g);
    this._env(g, t, u.gain, u.env[0], u.env[1]);
    this._out(g, 0.12, 0.05);
    src.start(t, Math.random()); src.stop(t + 0.4);

    /* 刃先の鳴き。ごく短い高域を1つ重ねると「切った」の角が立つ。
       長く伸ばすと金属の残響になって、振っただけで鳴っているように聞こえる */
    if (u.edge > 0) {
      const ed = this._noiseSource(rnd(1.8, 2.2));
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5200;
      const eg = ctx.createGain();
      ed.connect(hp); hp.connect(eg);
      this._env(eg, t + 0.012, u.edge, 0.002, 0.030);
      this._out(eg, 0.10, 0.04);
      ed.start(t + 0.012, Math.random()); ed.stop(t + 0.2);
    }

    /* 押しのける空気。**芯に対する比で持つ。**
       絶対値で持っていた頃、芯を上げても空気がそのままで関係が崩れた。
       速く動く物は低い所の空気も動かすので、0にはしない */
    const air = this._noiseSource(rnd(0.35, 0.5));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(u.air[0], t);
    lp.frequency.exponentialRampToValueAtTime(u.air[1], t + 0.07);
    lp.frequency.exponentialRampToValueAtTime(u.air[2], t + 0.18);
    lp.Q.value = 0.8;
    const ag = ctx.createGain();
    air.connect(lp); chop(lp).connect(ag);
    this._env(ag, t, u.gain * u.airGain, 0.014, u.airDec);
    this._out(ag, 0.10, 0.04);
    air.start(t, Math.random()); air.stop(t + 0.45);
  }

  /* -------------------------------------------------- 被弾・耳鳴り・生体 */

  // 耳鳴り。2本を僅かにずらすと単音のピーではなく「詰まった」鳴りになる
  _buildTinnitus() {
    const ctx = this.ctx;
    this.ringGain = ctx.createGain();
    this.ringGain.gain.value = 0.0001;
    this.ringGain.connect(this.postBus);
    for (const f of [4720, 6180]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      const g = ctx.createGain();
      g.gain.value = f > 5000 ? 0.4 : 1;
      o.connect(g); g.connect(this.ringGain);
      o.start();
    }
  }

  // 呼吸。息の帯域をゆっくり開閉させるだけで「人間が中にいる」音になる
  _buildBreath() {
    const ctx = this.ctx;
    const src = this._noiseSource(0.6);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 620;
    bp.Q.value = 0.9;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0.0001;
    src.connect(bp); bp.connect(this.breathGain);
    this.breathGain.connect(this.postBus);
    src.start();

    // 吸って吐くの往復。depthを上げると息が荒くなる
    this.breathLfo = ctx.createOscillator();
    this.breathLfo.type = 'sine';
    this.breathLfo.frequency.value = 0.42;
    this.breathDepth = ctx.createGain();
    this.breathDepth.gain.value = 0;
    this.breathLfo.connect(this.breathDepth);
    this.breathDepth.connect(this.breathGain.gain);
    const fMod = ctx.createGain();
    fMod.gain.value = 260;
    this.breathLfo.connect(fMod);
    fMod.connect(bp.frequency);
    this.breathLfo.start();
  }

  /**
   * 体力を伝える。0..1。低体力で心音と息が立ち上がる。
   * 毎フレーム呼んで良い（変化が小さい時は何もしない）。
   */
  setVitals(healthFraction = 1, alive = true) {
    const frac = clamp(healthFraction, 0, 1);
    // 45%を切ってから効き始める。常時鳴っていると緊張感が擦り切れる
    const low = alive ? clamp((0.45 - frac) / 0.45, 0, 1) : 0;
    if (Math.abs(low - this._lowHp) < 0.02 && !(low > 0 && !this._heartTimer)) return;
    this._lowHp = low;
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.breathDepth.gain.setTargetAtTime(low * 0.055, t, 0.5);
    this.breathLfo.frequency.setTargetAtTime(0.35 + low * 0.55, t, 0.8);
    if (low > 0.02 && !this._heartTimer) this._heartLoop();
  }

  _heartLoop() {
    this._heartTimer = null;
    if (!this.ready || !this.enabled || this._lowHp <= 0.02) return;
    const t = this.ctx.currentTime + 0.03;
    const vol = 0.10 + this._lowHp * 0.26;
    this._heartBeat(t, vol);
    this._heartBeat(t + 0.17, vol * 0.62);
    const bpm = 64 + this._lowHp * 62;
    this._heartTimer = setTimeout(() => this._heartLoop(), 60000 / bpm);
  }

  // 心音。低い正弦を短く落とすだけで胸を叩く音になる
  _heartBeat(t, vol) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(58, t);
    o.frequency.exponentialRampToValueAtTime(31, t + 0.1);
    const g = ctx.createGain();
    o.connect(g); g.connect(this.postBus);
    this._reap([g], 1.2);
    this._env(g, t, vol, 0.008, 0.07);
    o.start(t); o.stop(t + 0.3);
  }

  /**
   * 被弾。amountは0..1（受けたダメージの重さ）。
   * 世界の音が丸まり、耳鳴りだけが素通しで残る＝殴られた直後の聞こえ方。
   */
  hurt(amount = 0.4) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const amt = clamp(amount, 0, 1);

    const src = this._noiseSource(rnd(0.4, 0.6));
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = rnd(320, 440);
    const g = ctx.createGain();
    src.connect(f); f.connect(g); g.connect(this.postBus);
    this._reap([g, f], 1.2);
    this._env(g, t, 0.4 + amt * 0.3, 0.002, 0.16);
    src.start(t, Math.random()); src.stop(t + 0.5);

    // 世界の音を落とす。戻す時定数を重さで変えると、軽い被弾は一瞬で復帰する
    const ef = this.earFilter.frequency;
    ef.cancelScheduledValues(t);
    // こもらせる量も戻る速さも控えめにする。
    // 3460Hzまで落として時定数1秒で戻す形だと、連射を受けている間ずっと
    // こもったままになり、被弾が続く＝一番音を聴きたい場面で何も聞こえなくなる。
    // 一瞬だけ落として素早く戻す（撃たれた実感は出るが情報は失わない）
    ef.setValueAtTime(Math.max(ef.value, 3000), t);
    ef.linearRampToValueAtTime(lerp(9000, 4200, amt), t + 0.02);
    ef.setTargetAtTime(20000, t + 0.05, 0.10 + amt * 0.22);

    // 耳鳴り（キーン）は鳴らさない。撃たれるたびに高い正弦波が数秒残るのは
    // 情報を1つも足さないうえ、次の撃ち合いの音を聴き取る邪魔にしかならない。
    // 「撃たれた」の実感は上の earFilter（世界の音がこもる）だけで足りる
  }

  death(position, camera) {
    if (!this.ready || !this.enabled) return;
    this.impact('flesh', position, camera);
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.28;
    const src = this._noiseSource(rnd(0.5, 0.75));
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = rnd(420, 580);
    const g = ctx.createGain();
    src.connect(f); f.connect(g);
    this._env(g, t, 0.3, 0.006, 0.2);
    const out = this._place(g, position, camera, 10);
    this._out(out, 0.4, 0.25);
    src.start(t, Math.random()); src.stop(t + 0.7);
  }

  /* ------------------------------------------------ 協力プレイのモンスター */

  /* モンスターの声。**低い音の取り分がそのまま「大きさ」になる。**
     キル音で7回外した時に測って分かった通り（tools/check-sound.mjs の冒頭）、
     人が「重い」と感じるのは30〜250Hzの取り分なので、
     ここが空だと体高4.5mのボスが鳴らしても子犬の唸りにしかならない。

     作りは声帯の物真似。
       ・基音を2本、わずかにずらして重ねる（唸り＝周波数のうねり）
       ・それをローパスで丸めて胸郭の共鳴を作る
       ・上から荒れたノイズを乗せて、声帯が擦れる音を足す
     体格(scale)で基音を下げ、長さを伸ばす。**同じ音の音程違いにしない。**
     大きい個体ほど「うねりが遅く、尾が長い」のが、耳から見た大きさの正体

     kind は 'growl'(唸り) | 'roar'(咆哮) | 'die'(倒れる) */
  monsterVoice(kind = 'growl', scale = 1, position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);
    // 体格で基音を下げる。2.75倍のボスで38Hz前後まで落ちる
    const f0 = (kind === 'roar' ? 108 : kind === 'die' ? 84 : 96) / Math.pow(scale, 0.85);
    const len = (kind === 'roar' ? 1.5 : kind === 'die' ? 0.9 : 0.55) * (0.85 + scale * 0.18);
    /* 音量。**測って決めた。** 最初は roar 0.85 / die 0.5 / growl 0.34 にしていて、
       tools/sound-lab.mjs で書き出すと山が唸り0.87・倒れる0.88まで行っていた。
       爆発が0.66、銃声が0.67〜0.78なので、**モンスターが唸るたびに
       手榴弾より大きい音が鳴る**状態。咆哮だけは試合で一番大きくてよい */
    const vol = (kind === 'roar' ? 0.72 : kind === 'die' ? 0.34 : 0.23);
    const bus = ctx.createGain();

    // 基音2本。3〜7Hzずらして重ねると、うねって「生き物の喉」になる。
    // 1本だとブザーになる（爆発の低音を2本にしたのと同じ理由）
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';       // 倍音が要る。sineだと丸すぎて喉に聞こえない
      const f = f0 * (i === 0 ? 1 : rnd(1.03, 1.09));
      o.frequency.setValueAtTime(f * (kind === 'roar' ? 0.82 : 1), t);
      // 咆哮は途中で持ち上げてから落とす。一定だと機械の唸りになる
      if (kind === 'roar') {
        o.frequency.linearRampToValueAtTime(f * 1.22, t + len * 0.28);
        o.frequency.exponentialRampToValueAtTime(f * 0.55, t + len);
      } else {
        o.frequency.exponentialRampToValueAtTime(f * 0.72, t + len);
      }
      // 胸郭。基音の6倍あたりで切ると、喉から胸へ落ちた音になる
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(f0 * 7, t);
      lp.frequency.exponentialRampToValueAtTime(f0 * 3.2, t + len);
      lp.Q.value = 1.4;
      const g = ctx.createGain();
      o.connect(lp); lp.connect(g); g.connect(bus);
      this._env(g, t + i * 0.012, vol * (i === 0 ? 1 : 0.6), kind === 'roar' ? 0.06 : 0.03, len);
      o.start(t); o.stop(t + len + 0.4);
    }

    /* 声帯の擦れ。ノイズを基音のあたりに集めて、荒れた息として乗せる。
       これが無いと合成音の「ブー」で終わる */
    const rasp = this._noiseSource(rnd(0.5, 0.8));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(f0 * 4.5, t);
    bp.frequency.exponentialRampToValueAtTime(f0 * 2.0, t + len);
    bp.Q.value = 0.7;
    const rg = ctx.createGain();
    rasp.connect(bp); bp.connect(rg); rg.connect(bus);
    this._env(rg, t, vol * 0.5, 0.02, len * 0.9);
    rasp.start(t, Math.random()); rasp.stop(t + len + 0.3);

    // 咆哮だけ、腹に来る一撃を下に敷く
    if (kind === 'roar') {
      const sub = ctx.createOscillator();
      sub.type = 'sine';
      sub.frequency.setValueAtTime(f0 * 0.55, t);
      sub.frequency.exponentialRampToValueAtTime(f0 * 0.30, t + len * 1.2);
      const sg = ctx.createGain();
      sub.connect(sg); sg.connect(bus);
      this._env(sg, t, 0.7, 0.03, len * 1.2);
      sub.start(t); sub.stop(t + len + 0.6);
    }

    const out = this._place(bus, position, camera, kind === 'roar' ? 34 : 14, dist);
    this._out(out, kind === 'roar' ? 0.6 : 0.3, kind === 'roar' ? 0.7 : 0.3);
  }

  /* 爪を振る音。**刃の風切り(swing)とは別物にする。**
     刃は薄いので高い所が「シュッ」と鳴るが、爪は太い腕ごと来るので
     低い所の「ゴッ」が要る。同じ音を流用すると、モンスターがナイフを
     振っているように聞こえる */
  monsterSwipe(scale = 1, position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);
    const len = 0.20 * (0.8 + scale * 0.3);
    const bus = ctx.createGain();

    // 風。帯を上から下へ滑らせると「通り過ぎた」に聞こえる
    const air = this._noiseSource(rnd(0.85, 1.1));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1500 / scale, t);
    bp.frequency.exponentialRampToValueAtTime(260 / scale, t + len);
    bp.Q.value = 1.1;
    const ag = ctx.createGain();
    air.connect(bp); bp.connect(ag); ag.connect(bus);
    this._env(ag, t, 0.34, 0.012, len);
    air.start(t, Math.random()); air.stop(t + len + 0.2);

    // 腕の重み。低い所に短い山を1つ置くだけで、細い風切りが太い腕になる
    const thud = ctx.createOscillator();
    thud.type = 'sine';
    thud.frequency.setValueAtTime(150 / scale, t + len * 0.55);
    thud.frequency.exponentialRampToValueAtTime(52 / scale, t + len * 1.4);
    const tg = ctx.createGain();
    thud.connect(tg); tg.connect(bus);
    this._env(tg, t + len * 0.55, 0.30, 0.006, len * 0.9);
    thud.start(t); thud.stop(t + len * 2 + 0.2);

    this._out(this._place(bus, position, camera, 11, dist), 0.3, 0.3);
  }

  // 火の玉を吐く。濡れた噴き出しと、火が付く一瞬の膨らみ
  monsterSpit(position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);
    const bus = ctx.createGain();

    // 噴き出し。高い所の擦れを短く
    const hiss = this._noiseSource(rnd(1.2, 1.5));
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(900, t);
    hp.frequency.exponentialRampToValueAtTime(2600, t + 0.18);
    const hg = ctx.createGain();
    hiss.connect(hp); hp.connect(hg); hg.connect(bus);
    this._env(hg, t, 0.30, 0.004, 0.22);
    hiss.start(t, Math.random()); hiss.stop(t + 0.5);

    // 着火。低い所が一瞬膨らむ
    const fl = ctx.createOscillator();
    fl.type = 'sine';
    fl.frequency.setValueAtTime(210, t);
    fl.frequency.exponentialRampToValueAtTime(70, t + 0.3);
    const fg = ctx.createGain();
    fl.connect(fg); fg.connect(bus);
    this._env(fg, t, 0.34, 0.008, 0.3);
    fl.start(t); fl.stop(t + 0.6);

    this._out(this._place(bus, position, camera, 16, dist), 0.35, 0.35);
  }

  /* 火の玉が弾けた。手榴弾(explosion)より小さく短い。
     同じ音にすると、火の玉1発で手榴弾が落ちたのかと身構えることになる */
  monsterBoom(position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);
    const bus = ctx.createGain();

    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.setValueAtTime(rnd(76, 92), t);
    sub.frequency.exponentialRampToValueAtTime(28, t + 0.42);
    const sg = ctx.createGain();
    sub.connect(sg); sg.connect(bus);
    this._env(sg, t, 0.52, 0.004, 0.42);
    sub.start(t); sub.stop(t + 0.9);

    // 火の広がり。帯を落としながら少し長く残す
    const fire = this._noiseSource(rnd(0.6, 0.85));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(2400, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.6);
    const fg = ctx.createGain();
    fire.connect(lp); lp.connect(fg); fg.connect(bus);
    this._env(fg, t, 0.40, 0.003, 0.6);
    fire.start(t, Math.random()); fire.stop(t + 1.0);

    this._out(this._place(bus, position, camera, 20, dist), 0.5, 0.5);
  }

  /* 踏みつけ。**地面が来る音。**低い衝撃と、遅れて散る瓦礫。
     ボスしか鳴らさないので、この音が聞こえたら輪の外へ逃げる合図になる */
  monsterStomp(position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);
    const bus = ctx.createGain();

    for (const [f, v, d] of [[64, 0.85, 0.5], [102, 0.45, 0.3]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(f * rnd(0.94, 1.06), t);
      o.frequency.exponentialRampToValueAtTime(f * 0.35, t + d);
      const g = ctx.createGain();
      o.connect(g); g.connect(bus);
      this._env(g, t, v, 0.003, d);
      o.start(t); o.stop(t + d + 0.5);
    }

    // 瓦礫。少し遅らせて散らす
    const deb = this._noiseSource(rnd(0.9, 1.2));
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(1600, t);
    bp.frequency.exponentialRampToValueAtTime(500, t + 0.5);
    bp.Q.value = 0.6;
    const dg = ctx.createGain();
    deb.connect(bp); bp.connect(dg); dg.connect(bus);
    this._env(dg, t + 0.03, 0.30, 0.004, 0.55);
    deb.start(t, Math.random()); deb.stop(t + 0.9);

    this._out(this._place(bus, position, camera, 26, dist), 0.55, 0.6);
  }

  /* 大型の足音。**小型では鳴らさない**（群れが来た時に音が飽和する）。
     人の足音(footstep)と作りを変えているのは、重さが「高い音の有無」ではなく
     「低い所の山の長さ」で決まるため */
  monsterStep(scale = 1, position = null, camera = null) {
    if (!this.ready || !this.enabled) return;
    const ctx = this.ctx;
    const dist = this._dist(position, camera);
    const t = ctx.currentTime + Math.min(0.6, dist / SOUND_SPEED);
    const bus = ctx.createGain();
    const f = 90 / Math.pow(scale, 0.7);

    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.42, t + 0.16 * scale);
    const g = ctx.createGain();
    o.connect(g); g.connect(bus);
    this._env(g, t, 0.34 * Math.min(1.4, scale), 0.003, 0.16 * scale);
    o.start(t); o.stop(t + 0.5 * scale);

    // 土と砂利。上に薄く乗せると、低音だけの「ドン」が地面に着いた音になる
    const grit = this._noiseSource(rnd(0.7, 1.0));
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400 / scale;
    const gg = ctx.createGain();
    grit.connect(lp); lp.connect(gg); gg.connect(bus);
    this._env(gg, t, 0.16, 0.002, 0.10);
    grit.start(t, Math.random()); grit.stop(t + 0.3);

    this._out(this._place(bus, position, camera, 12 * scale, dist), 0.3, 0.3);
  }

  /* ---------------------------------------------------------- 環境音 */

  // 遠くの銃声と風。無音だと戦場に見えないので薄く敷く。
  //
  // 以前は「1本のノイズをローパスに通して0.07Hzで揺らす」だけだった。
  // 帯域が1つしかないので、耳が数秒で慣れて「ずっと同じ音」になる。
  // 自然界の風がそう聞こえないのは、低い唸り・中域のさざめき・高域の擦れが
  // それぞれ別の速さで動いているから。層を3つに分けて、揺らす周期を
  // 互いに素にならない程度にずらす（同じ周期だと3層が揃って脈打つ）
  _startAmbience() {
    const ctx = this.ctx;

    // 層を1つ作る。rateは再生速度＝ざらつきの細かさ、
    // freqはローパスの高さ、lfoHzは強弱の揺れる速さ
    const layer = (rate, type, freq, q, level, lfoHz, depth) => {
      const src = this._noiseSource(rate);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      if (q) f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = level;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();

      const lfo = ctx.createOscillator();
      lfo.frequency.value = lfoHz;
      const lg = ctx.createGain();
      lg.gain.value = depth;
      lfo.connect(lg); lg.connect(g.gain);
      lfo.start();
      return { f, g };
    };

    // 低い唸り。建物の間を抜ける風の芯。一番ゆっくり動く
    layer(0.16, 'lowpass', 150, 0, 0.020, 0.043, 0.012);
    // 中域のさざめき。ここが「屋外にいる」感を作る
    // 中域は一番耳につく帯。0.020は流しっぱなしだと「サー」として残り続けるので半分に
    layer(0.30, 'bandpass', 520, 0.9, 0.009, 0.071, 0.007);
    // 高域の擦れ。金網や砂が鳴る帯。速く動かすと落ち着かないので浅く
    // 高域は完全に落とす。2.6kHz以上のノイズは音量を絞っても不快さだけが残る
    layer(0.85, 'lowpass', 1400, 0, 0.004, 0.113, 0.003);

    // 遠くの金属が軋む音。風の層とは無関係に、思い出したように鳴る。
    // 周期的な物が1つも無いと、耳は全体を「ノイズ」として1枚に畳んでしまう。
    // たまに輪郭のある音が入ると、そのたびに空間の広さを聞き直すことになる
    const creak = () => {
      if (!this.ctx) return;
      if (this.enabled && Math.random() < 0.55) {
        const t = ctx.currentTime;
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        const base = rnd(70, 150);
        o.frequency.setValueAtTime(base, t);
        // ゆっくり上げると「重い物が撓む」に聞こえる。下げると崩れる音になる
        o.frequency.exponentialRampToValueAtTime(base * rnd(1.15, 1.5), t + rnd(0.5, 1.1));
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = rnd(300, 700);
        bp.Q.value = 3.5;
        const g = ctx.createGain();
        o.connect(bp); bp.connect(g); g.connect(this.master);
        this._env(g, t, rnd(0.010, 0.022), 0.35, rnd(0.6, 1.2));
        o.start(t); o.stop(t + 2.0);
        // 止めたoは自動で片付くが、下流のbp/gはmasterに繋がったまま残る。
        // ここだけ_reap()を呼び忘れていて、ロビーで待っている間も含めて
        // 20〜40秒に1回、masterへノードが繋がりっぱなしで積み上がっていた
        this._reap([bp, g], 2.4);
      }
      setTimeout(creak, rnd(14000, 34000));
    };
    setTimeout(creak, rnd(4000, 9000));

    // 遠景の撃ち合い。distanceを渡して遠距離帯の合成に乗せる。
    // 単発と連射を混ぜると「別の場所で戦闘が続いている」ように聞こえる
    const distant = () => {
      if (!this.ctx) return;
      // 試合の外(メニュー・ロビー)では鳴らさない。battleの説明はconstructor参照
      if (this.enabled && this.battle && Math.random() < 0.7) {
        const d = rnd(90, 220);
        const burst = Math.random() < 0.45 ? Math.floor(rnd(2, 5)) : 1;
        for (let i = 0; i < burst; i++) {
          setTimeout(() => this.gunshot({
            volume: rnd(0.5, 0.9), bodyFreq: rnd(210, 290), crackFreq: 1200,
            bodyDecay: 0.3, tailDecay: 1.1, thumpFrom: 70, thumpTo: 30,
            distance: d, mech: false,
          }), i * rnd(85, 130));
        }
      }
      setTimeout(distant, rnd(2600, 8600));
    };
    setTimeout(distant, 3000);
  }
}
