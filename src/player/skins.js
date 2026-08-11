// 武器のスキン（同じ銃の見た目違い）。
//
// **画像ファイルは1枚も増えない。** この表が持っているのは数字だけで、
// 色も擦れも埃も、元の材質を作った時と同じ手順で焼き直す（weapons.jsのrecolor）。
// スキンを1つ足しても配る物は0バイトしか増えない。
// 買ったモデルでスキンをやると、1つごとにテクスチャが数MB増える所。
//
// **銃の組み立ては一切触っていない。** 組み上がった後で、
// 面に貼ってある材質だけを差し替える。だから
//   ・武器を1本足してもスキンの側は何もしなくていい
//   ・スキンを1つ足しても銃の組み立てを触らなくていい
// 逆に言うと**部品ごとに色を変えることはできない**（「機関部だけ赤」は作れない）。
//
// **値段と品揃えはここに書かない。** あれは src/net/protocol.js が持っていて、
// サーバーも同じ物を読む（値段が2箇所にあると、片方だけ直した時に
// 「画面では300なのに引かれるのは1500」になる）。ここが持つのは塗り方だけ。
import {
  SKIN_LIST, SHAPE_LIST, SKINNABLE, DEFAULT_SKIN, skuOf, canEquip,
} from '../net/protocol.js';
import { skinnedFrom, matNameOf, SHAPE_BUILDS } from './weapons.js';

/* 選んだスキンの覚え先。**ログインしていない人のための控え。**
   ログインしている人はサーバーが持っている物が正になる（下のsetOwnedを参照）*/
const STORE = 'blackout.skins';

/* 塗り方の表。鍵は protocol.js の SKIN_LIST と揃える（検査が突き合わせる）。
 *
 * over の鍵は MATS の名前。**そこに書いた材質だけが差し替わる。**
 * 書かなかった物（手袋・袖・レンズ）は元のまま出る。
 *
 * wear は「角の塗装がどれだけ剥げて地金が出ているか」。
 * amount を上げると使い込んだ銃に、下げると新品に見える。
 * **CS:GOの「摩耗度」と同じ考え方**で、色を変えずに値段の幅を作れる */
const PAINT = {
  stock: { note: '支給品のまま', swatch: '#2c2f34', over: null },
  /* ここから3つは2026-08-11に塗り直した。**「地味すぎる」と言われて測ったら本当に地味だった。**
     元の値と、目で見た変化の大きさ（元の色との距離の平均）:

       デザート  121 … 砂色なので変わってはいたが、隣のキャンディ(376)に食われていた
       アーバン   30 … 紺黒(#1d2024)の上に青灰(#2b323c)。**暗い色に暗い色を塗っていた**
       歴戦        0 … 色の指定が1つも無い。擦れの量だけ上げたスキンだった

     **効いたのは「材質ごとに明暗を割る」ことで、色を変えること自体ではない。**
     全部を同じ明るさで塗ると、どんな色にしても銃は1つの塊のまま。
     機関部(phosphate)を暗いまま残して外装(enamel/polymer)を明るくすると、
     同じ形の銃が二色に割れて、遠目にも別の銃に見える。

     ここを触る時は `tools/check-skins.mjs` の [変化の大きさ] が下限を見張っている */
  desert: {
    note: '砂色の外装に、暗いままの機関部。埃を強めに',
    swatch: '#a89170',
    over: {
      // 外装は明るい砂(FDE)。ここが一番広いので、スキンの印象はほぼこの1色で決まる
      enamel: { color: 0x8f7a58, wear: { color: 0xc0ab86, dust: 0.24 } },
      polymer: { color: 0xa89170, wear: { color: 0xcdbb99, dust: 0.26 } },
      anodized: { color: 0x7a6748, wear: { color: 0xa8956e, dust: 0.20 } },
      // **機関部は暗いまま。** ここまで砂色にすると一色の塊に戻る
      phosphate: { color: 0x3e392e, wear: { dust: 0.20 } },
      steel: { color: 0x8a8272, wear: { color: 0xbdb5a2 } },
    },
  },
  urban: {
    note: '明るい灰の外装と、暗いレール。市街地の二色',
    swatch: '#8e969e',
    /* **元は青灰1色で、変化が30しかなかった。**
       都市迷彩は「明るい灰と濃い灰の二色」なので、そこを素直に作る。
       外装を上げてレールと機関部を下げると、明度差が一番開く */
    /* 外装は0x8e969eまで上げて変化265まで出したが、そこから一段落とした。
       **手袋で同じ罠を踏んでいる**（weapons.jsのglove）。明るい無彩色を広い面に置くと、
       背景のコンクリートと明度が並んで「塗り忘れた白い塊」に見える。
       二色に割れているのはレール側を沈めているからなので、外装を下げても効果は残る */
    over: {
      enamel: { color: 0x7a828a, wear: { color: 0xb4bcc4, dust: 0.10 } },
      polymer: { color: 0x5f676f, wear: { color: 0x8e969e } },
      // レールは逆に沈める。**上げると外装と溶けて、また1色の塊になる**
      anodized: { color: 0x2a3038, wear: { color: 0x7d8794 } },
      phosphate: { color: 0x22262b, wear: { color: 0x8e969e } },
      steel: { color: 0x98a0a8, wear: { color: 0xd0d6dc } },
    },
  },
  veteran: {
    note: '塗装が剥げて錆が回った銃。褪せた茶灰と錆',
    swatch: '#6a5a48',
    /* **元は「色を変えずに擦れだけ上げる」スキンだった。**
       考え方としては面白いが、擦れは角にしか出ないので測ると変化が0で、
       600コイン出して何も変わらない商品になっていた。

       擦れの量を上げるのは残したまま、**地の色を褪せた茶灰へ落として、
       剥げた所から出る色を錆にする。** これで「長く使った物」が色でも読める。
       擦れだけに頼らないので、角以外も変わる */
    /* 一度 0x4a4038 で組んだが、測ると変化76で**塗り直した3つの中でまだ最下位**だった
       （デザート224・アーバン200台）。600コインで一番安い物より変わらないのは通らない。
       錆は元から中間の明るさなので、黒に近い地からの距離を稼ぐには**褪せ側へ持ち上げる**
       しかない。日に焼けて色が飛んだ銃はむしろ明るくなるので、見た目にも合う */
    over: {
      enamel: { color: 0x6a5a48, wear: { amount: 1.6, color: 0xc08a52, dust: 0.26 } },
      polymer: { color: 0x5e5346, wear: { amount: 1.1, color: 0x9a7852, dust: 0.30 } },
      anodized: { color: 0x74604a, wear: { amount: 1.5, color: 0xd09a5e, dust: 0.24 } },
      phosphate: { color: 0x4e4034, wear: { amount: 1.6, color: 0xb87c48, dust: 0.28 } },
      // 地金は錆びずに磨かれる所。**ここだけ明るいと「使い込んだ」に見える**
      steel: { color: 0xa89a86, wear: { amount: 0.9, color: 0xe4dcc8 } },
    },
  },
  gold: {
    note: '派手枠。一番高い',
    swatch: '#a8811f',
    over: {
      enamel: { color: 0x8a6a1f, metalness: 1.0, roughness: 0.28, wear: { color: 0xe8c46a, rough: 0.16 } },
      anodized: { color: 0xa8811f, metalness: 1.0, roughness: 0.24, wear: { color: 0xf0d488, rough: 0.12 } },
      phosphate: { color: 0x6b5416, wear: { color: 0xc9a24e } },
      steel: { color: 0xb8903e, wear: { color: 0xe0c179 } },
    },
  },
};

/* 形違いの見せ方。塗りは持たない（組み立てが自分で材質を決めている）。
   組み立てそのものは weapons.js の SHAPE_BUILDS */
const SHAPE_LOOK = {
  katana: { note: '反りのある片刃と円い鍔。刃渡りが3割長い', swatch: '#b9c2cc' },
  dagger: { note: '短く幅広い両刃と、横へ張り出したクロスガード', swatch: '#c9a24e' },
  /* 形違いも塗り替えを持てる。**飾りを足すだけだと本体が元の紺黒のままで、
     足した部品だけ浮いて見える。** 組み立て(SHAPE_BUILDS)が飾りを、
     ここが本体の色を受け持つ */
  dragon: {
    note: '背の棘・銃口の顎・鱗・光る目。暗い赤銅に金の擦れ',
    swatch: '#3a1c18',
    over: {
      enamel: { color: 0x2a1512, wear: { color: 0xc79a4a, amount: 1.1 } },
      anodized: { color: 0x3a1c18, wear: { color: 0xd8ad5c, amount: 1.0 } },
      phosphate: { color: 0x241210, wear: { color: 0xb98d42, amount: 1.2 } },
      polymer: { color: 0x2b1a17, wear: { color: 0x7a5f36, metal: 0.2 } },
      steel: { color: 0x6b4a2a, wear: { color: 0xe8c88a } },
    },
  },
  /* ---- 2026-08-11に足した3つ。武器ごとに別のテーマ ---- */
  western: {
    note: '胡桃の銃床と先台、真鍮の口金、機関部の彫金',
    swatch: '#4a2a18',
    /* **木そのものは飾り側(weapons.jsのwesternDeco)が持っている。**
       ここが塗るのは金属の側で、木に合う焦茶へ寄せる役。
       金属を黒いまま残すと、木だけ後から貼ったように浮く */
    over: {
      enamel: { color: 0x3c2c22, wear: { color: 0xa07850, amount: 1.1, dust: 0.14 } },
      phosphate: { color: 0x33261e, wear: { color: 0x9a7448, amount: 1.0 } },
      polymer: { color: 0x35251c, wear: { color: 0x7a5a3c } },
      anodized: { color: 0x4a3526, wear: { color: 0xb08a58 } },
      // 地金は磨いた鋼のまま少し暖色へ。真鍮と喧嘩しない所で止める
      steel: { color: 0x8a7a66, wear: { color: 0xd8c8aa } },
    },
  },
  ice: {
    note: '霜の結晶と氷輪、銃口から垂れる氷柱。白と薄氷の青',
    swatch: '#dce8f2',
    /* **今の品揃えで唯一の明るい銃。** 他の6つは全部暗いか原色なので、
       棚に並べた時にここだけ浮く（それが狙い）。
       機関部まで白くすると輪郭が消えるので、そこは薄氷の青で止める */
    over: {
      enamel: { color: 0x6f8fa4, wear: { color: 0xdff0fa, amount: 1.2, dust: 0.06 } },
      polymer: { color: 0x8aa8bc, wear: { color: 0xe4f2fb } },
      polymerTan: { color: 0xa8c4d6, wear: { color: 0xecf6fd } },
      anodized: { color: 0x4e6c80, wear: { color: 0xc8e2f0 } },
      phosphate: { color: 0x3e5a6c, wear: { color: 0xb4d6e8 } },
      steel: { color: 0xc4dae8, wear: { color: 0xf2fafe } },
    },
  },
  cyber: {
    note: '光る回路と表示窓、放熱の羽。黒に青緑の光',
    swatch: '#14171c',
    /* **光っているのは飾り側(cyberDeco)のcircuit。**
       ここは地を黒く沈めるのが仕事で、色を足す方ではない。
       地が明るいと、光の線が「明るい銃の上の少し明るい線」になって消える */
    over: {
      enamel: { color: 0x0e1116, wear: { color: 0x3e5a68, amount: 0.7 } },
      anodized: { color: 0x14181e, wear: { color: 0x4a6a7a } },
      polymer: { color: 0x101318, wear: { color: 0x35505e } },
      phosphate: { color: 0x0c0f13, wear: { color: 0x3a5866 } },
      // 地金だけ青緑へ寄せる。光の色と地金が繋がって、発光が銃から出て見える
      steel: { color: 0x4e6e78, wear: { color: 0x9ac4cc } },
    },
  },

  cute: {
    note: '猫耳・丸めた角・パステルの縞・星のチャーム',
    swatch: '#d98aa6',
    over: {
      enamel: { color: 0xd98aa6, metalness: 0.0, roughness: 0.55, wear: { amount: 0.3, color: 0xf0b8ca, metal: 0.0 } },
      anodized: { color: 0x7fc9b8, metalness: 0.0, roughness: 0.52, wear: { amount: 0.3, color: 0xaee2d6, metal: 0.0 } },
      phosphate: { color: 0xe0d3b4, metalness: 0.0, roughness: 0.60, wear: { amount: 0.25, color: 0xf2ead6, metal: 0.0 } },
      polymer: { color: 0xc9789a, wear: { amount: 0.3, color: 0xe6a8c0, metal: 0.0 } },
      steel: { color: 0xbfc9d4, wear: { color: 0xe4ecf5 } },
    },
  },
};

/** 画面に並べる用。値段は protocol.js、見せ方はこのファイル */
export const SKINS = [
  ...SKIN_LIST.map((s) => ({ ...s, ...PAINT[s.id], kind: 'paint' })),
  ...SHAPE_LIST.map((s) => ({ ...s, ...SHAPE_LOOK[s.id], kind: 'shape' })),
];
export const skinAt = (id) => SKINS.find((s) => s.id === id) || SKINS[0];

/**
 * その見た目の組み立て関数。**色のスキンならnull**（組み立ては元のまま）。
 *
 * ここがnullかどうかで、被せ方が変わる:
 *   null … 組み上がった後で材質だけ差し替える（安い）
 *   関数 … **組み立て直す**（形が違うので材質の差し替えでは届かない）
 */
export const shapeOf = (id) => SHAPE_BUILDS[id] || null;

/* --------------------------------------------------- 今の持ち物と装備 */

/* 持っている物。skuの集合。**ログインしていない人は空**＝標準しか着けられない。
   ここが空でも遊べる（標準はいつでも着けられる） */
let owned = new Set();
/* 武器ごとに何を着けているか。{ rifle:'desert', ... } */
let worn = loadWorn();
/* 装備が変わった時に呼ぶ。今持っている銃へ掛け直すのは呼ぶ側の仕事 */
let onWear = () => {};

export const setOnWear = (fn) => { onWear = fn || (() => {}); };

/** その武器に今着いているスキンのid。何も着けていなければ標準 */
export const skinFor = (weaponId) => {
  const id = worn[weaponId];
  // **その武器で扱える物か**まで見る。形違いは武器専用なので、
  // 別の武器のidが紛れ込んでいたら標準へ寄せる
  return (id && canEquip(weaponId, id)) ? id : DEFAULT_SKIN;
};

/** 持っているか。標準はいつでも持っている扱い */
export const hasSkin = (weaponId, skinId) =>
  skinId === DEFAULT_SKIN || owned.has(skuOf(weaponId, skinId));

/** 今の持ち物（画面が値段の横に「所持」を出すのに使う） */
export const ownedSkus = () => [...owned];

/**
 * サーバーから届いた持ち物と装備で置き換える。**こちらでは足し引きしない。**
 * 台帳が持っている物だけが本当（財布と同じ考え方）。
 *
 * ログアウトした時は空で呼ばれる＝標準へ戻る
 */
export function setAccount({ owned: list, equipped } = {}) {
  owned = new Set(Array.isArray(list) ? list : []);
  worn = {};
  for (const w of SKINNABLE) {
    const id = equipped?.[w];
    // **持っていない物が届いても着せない。** 台帳側で持ち物を消した時の保険
    worn[w] = (id && canEquip(w, id) && hasSkin(w, id)) ? id : DEFAULT_SKIN;
  }
  saveWorn();
  onWear();
}

/**
 * 装備する。**手元だけ先に変える。** サーバーへ送るのは呼ぶ側（look.js）。
 * 押した瞬間に見た目が変わらないと、効いていないように見える
 */
export function wearSkin(weaponId, skinId) {
  if (!SKINNABLE.includes(weaponId)) return false;
  if (!hasSkin(weaponId, skinId)) return false;
  worn[weaponId] = skinId;
  saveWorn();
  onWear();
  return true;
}

/** 買った物を持ち物へ入れる。サーバーが返した一覧で置き換える */
export function setOwned(list) {
  owned = new Set(Array.isArray(list) ? list : []);
}

/* localStorageは設定次第で読み書きどちらも例外を投げる。
   覚えられないだけで遊べなくなるのは割に合わない（netmenu.jsと同じ作法）*/
function loadWorn() {
  const out = {};
  for (const w of SKINNABLE) out[w] = DEFAULT_SKIN;
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || '{}');
    for (const w of SKINNABLE) if (canEquip(w, raw[w])) out[w] = raw[w];
  } catch { /* 覚えていないだけ */ }
  return out;
}

function saveWorn() {
  try { localStorage.setItem(STORE, JSON.stringify(worn)); } catch { /* 覚えられないだけ */ }
}

/* ------------------------------------------------------ 被せる */

/* 焼いた材質の置き場。id -> Map<面に貼ってある材質, 新しい材質>。
   **1つのスキンにつき、1つの材質を1回しか焼かない。**
   焼くのは96×96の画素をなめる処理なので、持ち替えのたびにやり直すと
   持ち替えの瞬間に必ず引っかかる。
   nullも覚える（「この材質はこのスキンでは差し替えない」も答えの1つ）*/
const CACHE = new Map();

const cacheFor = (id) => {
  if (!CACHE.has(id)) CACHE.set(id, new Map());
  return CACHE.get(id);
};

/**
 * 組み上がった銃にスキンを被せる。**何度呼んでも、行き来しても元へ戻せる。**
 *
 * 面に実際に貼られているのは、接触影(AO)を焼く時に作られた複製のことが多い。
 * **そこを見落として元のMATSと突き合わせていたら、1面も差し替わらなかった。**
 * 元が誰かは weapons.js の matNameOf が辿る。
 *
 * @param root 銃のGroup（Weapon.inner）
 * @param id   スキンのid
 */
export function applySkin(root, id) {
  if (!root) return;
  const over = skinAt(id).over;
  const cache = cacheFor(id);
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    /* 元を控える。**1回目だけ。** 2回目以降にここで控えると、
       前のスキンの材質を「元」だと思い込んで、標準へ戻れなくなる */
    if (!o.userData.baseMat) o.userData.baseMat = o.material;
    const base = o.userData.baseMat;
    if (!over) { o.material = base; return; }

    if (!cache.has(base)) {
      const name = matNameOf(base);
      cache.set(base, (name && over[name]) ? skinnedFrom(base, over[name]) : null);
    }
    o.material = cache.get(base) || base;
  });
}
