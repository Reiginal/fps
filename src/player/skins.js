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
  /* ジャングル迷彩（拳銃だけ）。ライフルの迷彩と**柄を分ける。**
     あちらは緑褐色の4色（砂と枯草の土地）、こちらは深緑と黒（濡れた森）。
     同じ「迷彩」でも、明るいか暗いかで別の物に見える */
  jungle: {
    note: '深緑と黒の斑、泥の汚れ。拳銃だけの迷彩',
    swatch: '#2c3a24',
    /* 一度全部を暗い緑で塗って**変化64しか出ず落ちた。**
       アーバン（元は変化30で作り直した）と同じ罠で、
       **暗い地に暗い色を塗っても何も変わらない。**
       迷彩は明暗が散っていることが柄の条件なので、
       樹脂を明るい枯草色まで上げて4段に散らす */
    over: {
      enamel: { color: 0x4e6236, wear: { color: 0x8a9a64, amount: 1.1, dust: 0.28, dustColor: 0x6a5c3e } },
      polymer: { color: 0x8a9660, wear: { color: 0xb4bc8c, dust: 0.32, dustColor: 0x6a5c3e } },
      anodized: { color: 0x1e2a18, wear: { color: 0x4a5c38 } },
      phosphate: { color: 0x30401f, wear: { color: 0x62744a, dust: 0.26 } },
      steel: { color: 0x9aa478, wear: { color: 0xccd4a8 } },
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
  rapier: { note: '細長い直刃と椀型の護拳。磨いた銀に青の焼き入れ', swatch: '#b8c4d0' },
  axe: { note: '幅広い片刃と木の柄、刃の背の打撃面。錆の入った鉄と焦茶の木', swatch: '#5a4636' },
  glove: { note: '刃を持たない。革のグローブと真鍮の当て金。両拳を構える', swatch: '#6a4a30' },

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
  armor: {
    note: '鉄板とボルト、角張った制退器。輪郭そのものを角にする',
    swatch: '#3a4248',
    /* ドラゴン（暗い赤銅と金）に対して、こちらは**無彩色の鉄。**
       色で主張しない代わりに形で主張する商品なので、
       塗りは「重い鉄」であることだけを出す。彩度を上げると玩具に寄る */
    over: {
      enamel: { color: 0x2a3036, wear: { color: 0x7a848c, amount: 1.2, dust: 0.16 } },
      anodized: { color: 0x3a4248, wear: { color: 0x8e9aa2, amount: 1.1 } },
      polymer: { color: 0x24282c, wear: { color: 0x5e666c } },
      phosphate: { color: 0x22262a, wear: { color: 0x76808a, amount: 1.2 } },
      steel: { color: 0x7a848c, wear: { color: 0xb8c2ca } },
    },
  },
  sakura: {
    note: '漆の黒に金の桜、朱の紐と房、螺鈿の白帯',
    swatch: '#14100e',
    /* **地は漆の黒。** 金の桜と螺鈿の白を置く物なので、
       地が明るいとどちらも埋もれる（サイバーで光を乗せた時と同じ理屈）。
       粗さを落として「塗り物」の照りを出すのがここの要点で、
       他の商品のような擦れは入れない（漆器は使い込んで剥げた物ではない） */
    over: {
      enamel: { color: 0x14100e, metalness: 0.25, roughness: 0.18, wear: { amount: 0.2, color: 0x4a3c30, rough: 0.14 } },
      anodized: { color: 0x1a1512, metalness: 0.3, roughness: 0.16, wear: { amount: 0.2, color: 0x5a4838 } },
      polymer: { color: 0x100d0b, roughness: 0.30, wear: { amount: 0.15, color: 0x3a3028 } },
      phosphate: { color: 0x0e0b09, metalness: 0.25, roughness: 0.20, wear: { amount: 0.2, color: 0x463828 } },
      // 地金は金へ寄せる。桜の金と地金が繋がって、飾りが後付けに見えない
      steel: { color: 0x9a7c42, wear: { color: 0xd8bc7a } },
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
  shark: {
    note: '銃口の顎と歯、鰓の切れ込み、背と胸の鰭。青灰の背と白い腹',
    swatch: '#4a5c6a',
    /* ウエスタン（焦茶＋真鍮）に対して、こちらは**青灰。**
       **腹の白は塗りでは出せない**（塗り替えは材質ごとにしか効かないので、
       上下の塗り分けが作れない）。腹の板を飾り側(sharkDeco)が持っていて、
       ここが塗るのは背の側だけ。

       鰭と顎に anodized を使ってあるので、ここで anodized を青灰にすると
       **鰭も一緒に染まる**（材質を増やさずに背の色が乗る） */
    over: {
      enamel: { color: 0x2e3a44, wear: { color: 0x6a8090, amount: 0.9 } },
      anodized: { color: 0x4a5c6a, wear: { color: 0x8aa4b4, amount: 0.8 } },
      polymer: { color: 0x36444e, wear: { color: 0x6e8492 } },
      phosphate: { color: 0x28323a, wear: { color: 0x62788a } },
      // 地金は濡れた鮫肌の照り。青を残したまま明るくする
      steel: { color: 0x8ea4b2, wear: { color: 0xd4e2ea } },
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
  skeleton: {
    note: '透ける樹脂の枠と、中に見える発条と真鍮の弾',
    swatch: '#d8e4ea',
    /* **地は明るくしない。** 透ける枠の中に元の部品が見える作りなので、
       中身が暗い方が枠の透明感が出る。
       地金だけ明るくして、発条と縁の金属が繋がるようにしてある */
    over: {
      enamel: { color: 0x30363c, wear: { color: 0x7e8a94, amount: 0.6 } },
      anodized: { color: 0x3a4248, wear: { color: 0x8e9aa4 } },
      polymer: { color: 0x282e34, wear: { color: 0x66727c } },
      phosphate: { color: 0x2a3036, wear: { color: 0x76828c } },
      steel: { color: 0xb4c0c8, wear: { color: 0xe8f0f6 } },
    },
  },
  astro: {
    note: '紺紫の地に星の粒、対物側に光る環。望遠鏡に見立てる',
    swatch: '#2a2448',
    /* **地は紺紫。** 星を置く物なので、夜空の暗さが要る。
       アイス（明るい白）と正面から逆で、ヴェノム（黄緑）とも色相が離れている */
    over: {
      enamel: { color: 0x201c3a, wear: { color: 0x6a64a0, amount: 0.8 } },
      polymer: { color: 0x262046, wear: { color: 0x5e589a } },
      polymerTan: { color: 0x2a2448, wear: { color: 0x7068ac } },
      anodized: { color: 0x18142c, wear: { color: 0x58508a } },
      phosphate: { color: 0x141024, wear: { color: 0x4e4880 } },
      // 地金は銀へ。光る環と地金が繋がって、飾りが後付けに見えない
      steel: { color: 0xa8b0c8, wear: { color: 0xdce2f0 } },
    },
  },
  bamboo: {
    note: '節が並ぶ竹の銃身、麻紐の巻き。若竹の緑と生成りの白',
    swatch: '#a8b060',
    /* **竹そのものは飾り側(bambooDeco)が持っている。**
       ここが塗るのは金属の側で、竹に合う生成りへ寄せる役。
       金属を黒く残すと、竹だけ後から被せたように浮く（ウエスタンと同じ理屈） */
    over: {
      enamel: { color: 0x4a4632, wear: { color: 0x9a9468, amount: 1.0, dust: 0.16 } },
      polymer: { color: 0x585240, wear: { color: 0xa8a078 } },
      polymerTan: { color: 0x7a7452, wear: { color: 0xc0b888 } },
      anodized: { color: 0x3e3a2a, wear: { color: 0x8a8460 } },
      phosphate: { color: 0x363224, wear: { color: 0x7e785a } },
      steel: { color: 0x8e8a6e, wear: { color: 0xc8c4a2 } },
    },
  },

  chrome: {
    note: '磨いた銀と象牙の握把、真鍮の撃鉄。品揃えで唯一の明るい拳銃',
    swatch: '#c8d0d8',
    /* サイバー（黒＋青緑の光）に対して、こちらは**明るい銀。**
       **地を明るくするのがこの商品の本体。** 飾りだけ銀にして地を黒く残すと、
       ボーン（消した物）と同じ「暗い銃に明るい飾り」になって地味に戻る。

       擦れの色を暗くしないのも決めごと。
       他の商品は全部「使い込んだ物」だが、これは磨いてある物なので、
       剥げた所も明るいままにする */
    over: {
      enamel: { color: 0x9aa4ae, metalness: 1.0, roughness: 0.14, wear: { color: 0xdce4ec, amount: 0.4, rough: 0.10 } },
      anodized: { color: 0xb4bec8, metalness: 1.0, roughness: 0.10, wear: { color: 0xe8f0f6, amount: 0.35, rough: 0.08 } },
      polymer: { color: 0x8e98a2, wear: { color: 0xc4ccd4, amount: 0.3 } },
      phosphate: { color: 0x8a949e, metalness: 1.0, roughness: 0.16, wear: { color: 0xd0d8e0, amount: 0.4 } },
      // 地金は一番磨かれている所。鏡面の飾り(chrome)と繋がる明るさへ
      steel: { color: 0xc8d0d8, wear: { color: 0xf4f8fc } },
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
