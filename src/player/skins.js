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
  /* 迷彩。2026-08-11に、削った3つ（デザート・アーバン・歴戦）の代わりに入れた。

     **1色で塗るのをやめたのがこの商品の中身。**
     削った3つはどれも銃全体を同じ色で塗る形で、測ると
     「材質ごとに明暗を割らないと銃が1つの塊のまま」だと分かっていた
     （アーバンは元の色との距離が30しかなかった）。

     迷彩は**材質ごとに違う色を置く**ので、その問題が原理的に起きない。
     部品ごとに模様を描くことはできない作り（skins.jsの冒頭）だが、
     材質は5つに分かれているので、**そこへ別々の色を配れば迷彩に見える。**
     実銃の迷彩塗装も面ごとに色を分けて塗るので、見た目の理屈も合っている。

     色の選び方: 中間の緑褐色を一番広い面(enamel)に置き、
     樹脂を明るい砂、レールを暗い緑、機関部を暗い茶、地金を明るい灰緑。
     **明暗が4段に散る**ので、遠目にも「単色でない」ことが読める */
  camo: {
    note: '材質ごとに色を分けた4色の迷彩',
    swatch: '#5a6142',
    over: {
      enamel: { color: 0x5a6142, wear: { color: 0x8a9070, amount: 1.1, dust: 0.20 } },
      polymer: { color: 0x8a8560, wear: { color: 0xb0ab86, dust: 0.24 } },
      anodized: { color: 0x2f3a2a, wear: { color: 0x6a7a60 } },
      phosphate: { color: 0x3a3228, wear: { color: 0x7a6e56, dust: 0.18 } },
      steel: { color: 0x9aa085, wear: { color: 0xd0d6bc } },
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

  /* ---- 各武器の2つ目。2026-08-11 ----
     **1つ目と色の系統を変えている。** 同じ武器に似た色を2つ並べても選択にならない */
  scrap: {
    note: '錆びた鉄板と布テープ、赤い塗り文字。拾って継ぎ足した銃',
    swatch: '#6a4a34',
    /* ウエスタン（焦茶＋真鍮）に対して、こちらは**錆と煤。**
       金属を赤茶へ寄せて、擦れの色も明るい地金ではなく錆にする
       （普通の金属と逆。使い込むほど錆が濃くなる物なので） */
    over: {
      enamel: { color: 0x40352c, wear: { color: 0x8a5a34, amount: 1.4, dust: 0.30 } },
      polymer: { color: 0x3a322a, wear: { color: 0x6a4e38, amount: 1.2, dust: 0.32 } },
      anodized: { color: 0x4a3a2c, wear: { color: 0x9a6a3e, amount: 1.3, dust: 0.26 } },
      phosphate: { color: 0x352c24, wear: { color: 0x7a5230, amount: 1.4, dust: 0.30 } },
      // 地金だけは擦れて出る。**触る所は錆が落ちる**ので、ここが唯一明るい
      steel: { color: 0x7a6e60, wear: { color: 0xc4b8a4 } },
    },
  },
  venom: {
    note: '黄緑の鱗と牙、垂れる毒。蛇に飲まれた狙撃銃',
    swatch: '#5a6a1e',
    /* アイス（白と薄氷の青）に対して、こちらは**黄緑と黒。**
       地を黒く沈めるのが大事で、明るいと鱗と光る毒がどちらも埋もれる */
    over: {
      enamel: { color: 0x1e2418, wear: { color: 0x6a7a30, amount: 1.0 } },
      polymer: { color: 0x232a1c, wear: { color: 0x5a6a28 } },
      polymerTan: { color: 0x2e3820, wear: { color: 0x7a8c38 } },
      anodized: { color: 0x2a3420, wear: { color: 0x8a9a40 } },
      phosphate: { color: 0x1a1f14, wear: { color: 0x5e6c28 } },
      steel: { color: 0x6a7a48, wear: { color: 0xaebc78 } },
    },
  },
  bone: {
    note: '髑髏の握把、肋骨、銃口の牙。骨に憑かれた拳銃',
    swatch: '#c9bfa6',
    /* サイバー（黒と青緑の光）に対して、こちらは**黒と骨の白。**
       光らせないので、白い骨と黒い地の**明暗差だけ**で読ませる。
       地を一番黒くしてあるのはそのため */
    over: {
      enamel: { color: 0x14120f, wear: { color: 0x6a6254, amount: 0.8 } },
      anodized: { color: 0x1a1814, wear: { color: 0x7a7264 } },
      polymer: { color: 0x121110, wear: { color: 0x5a5348 } },
      phosphate: { color: 0x100e0c, wear: { color: 0x6e6658 } },
      // 地金を骨寄りの色へ。骨の飾りと地金が繋がって、銃が骨から生えて見える
      steel: { color: 0xa89e88, wear: { color: 0xe0d8c4 } },
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
