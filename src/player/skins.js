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
/* 形違いも塗り替えを持てる。**飾りを足すだけだと本体が元の紺黒のままで、
   足した部品だけ浮いて見える。** 組み立て(SHAPE_BUILDS)が飾りを、
   ここが本体の色を受け持つ */
const SHAPE_LOOK = {
  kusarigama: {
    note: '前へ曲がる鎌の刃と、柄尻から垂れる鎖と分銅。黒鉄と縄',
    swatch: '#2b2a26',
    /* **農具の鉄。** 日本刀（黒漆と金）と同じ和の系統だが、
       あちらが飾ってある物なのに対してこちらは**使っている物**なので、
       磨かず・金を使わず、縄と木で仕上げる */
    over: {
      steel: { color: 0x8a8f94, wear: { color: 0xd2d8de, amount: 0.5 } },
      phosphate: { color: 0x24231f, wear: { color: 0x7e7666, amount: 1.0, dust: 0.18 } },
      chrome: { color: 0xc8ccd0 },
      walnut: { color: 0x4a3422, wear: { color: 0x8a6038, dust: 0.12 } },
      strap: { color: 0x8a7a58 },
      anodized: { color: 0x2a2822, wear: { color: 0x7a7260 } },
    },
  },
  chainsaw: {
    note: '刃物ではなく機械。角張った発動機と、刃を並べた前へ伸びるバー',
    swatch: '#d4620e',
    /* **橙。** 品揃えで一番強い色になる。
       作業機械は遠くからでも見える色で塗ってあるのが普通で、
       他の短剣（黒・銀・銅・赤）とどれとも被らない */
    over: {
      polymer: { color: 0xd4620e, roughness: 0.52, wear: { color: 0xf2a052, amount: 0.6, dust: 0.16 } },
      enamel: { color: 0x1a1a1c, wear: { color: 0x6e6a66, amount: 0.9, dust: 0.14 } },
      phosphate: { color: 0x53585c, wear: { color: 0xa8b0b6, amount: 1.0 } },
      chrome: { color: 0xd8dce0 },
      strap: { color: 0x2a2a2c },
      steel: { color: 0x9aa2a8, wear: { color: 0xd8e0e6 } },
    },
  },

  /* ---- 短剣の形違い5つ。**2026-08-12に、5つとも塗りを足した。**
     「ナイフ系のスキン全体的に色とか質感にも変化欲しい」と言われた所。
     それまで5つとも**塗りを1つも持っていなかった**ので、
     形だけ違って**色は全部同じ紺黒＋鋼**だった。
     説明文には「磨いた銀に青の焼き入れ」「錆の入った鉄と焦茶の木」と
     書いてあったのに、実際には1面も塗り替えていなかった。

     **5つで系統が被らないように配ってある**（並べた時に選択になるように）:
       日本刀 … 黒漆と金（和）        ダガー   … 焼けた銅と黒革（古い物）
       レイピア … 磨いた銀と青焼き（貴族）  斧 … 錆びた鉄と焦茶の木（道具）
       グローブ … 深い赤と生成りの紐（拳闘）

     **柄の芯(rubber)と革(strap)は擦れを焼いていない材質**なので、
     色だけ差し替える（wearを足すと amount が無くて黒く潰れる）*/
  katana: {
    note: '反りのある片刃に刃文、鎺と鮫皮。黒漆の鞘金具と金',
    swatch: '#1c1a1e',
    /* **刃は明るくする方へ動かす。** 日本刀は刃が主役で、
       ここを暗くすると「黒い棒」になる。金具の側を黒漆で沈めて、
       刃・鮫皮の白・金の3つだけが光る形にする。
       刃文(hamon)と鮫皮(ivory)は書いていない＝**元の白のまま出る** */
    over: {
      steel: { color: 0x7c8590, wear: { color: 0xd8e0e8, amount: 0.45, rough: 0.20 } },
      anodized: { color: 0x4a5460, wear: { color: 0x9aa6b4 } },
      phosphate: { color: 0x18181c, wear: { color: 0xb08a3e, amount: 0.8 } },
      // 柄巻きは紺。**黒にしない。** 鍔も柄芯も黒で沈めてあるので、
      // ここまで黒いと握りが1本の黒い棒になって、巻いてあることが読めない
      enamel: { color: 0x22305c, wear: { color: 0x4e5e90, amount: 0.7 } },
      brass: { color: 0xc9a24e, wear: { color: 0xf0dca0, rough: 0.12 } },
      rubber: { color: 0x14141a },
    },
  },
  dagger: {
    note: '短く幅広い両刃と、横へ張り出したクロスガード。焼けた銅と黒革',
    swatch: '#8a5a32',
    /* **銅にしてあるのは、鋼の刃が他に4本あるから。**
       日本刀・レイピア・ナイフ・斧の刃は全部銀色なので、
       ここだけ地の色そのものを変えないと「短い刀」で終わる */
    over: {
      steel: { color: 0x9a6a3c, metalness: 1.0, roughness: 0.38, wear: { color: 0xe0b070, amount: 0.5 } },
      anodized: { color: 0x6a4526, wear: { color: 0xba8a50 } },
      phosphate: { color: 0x241c16, wear: { color: 0x8a6a44, amount: 0.9 } },
      brass: { color: 0xb8862e, wear: { color: 0xe8c880 } },
      polymer: { color: 0x1c1814, wear: { color: 0x4a3c2c } },
      rubber: { color: 0x15120f },
    },
  },
  rapier: {
    note: '細長い直刃と椀型の護拳。磨いた銀に青の焼き入れ',
    swatch: '#b8c4d0',
    /* 説明の通りに塗る。**護拳(phosphate)を青焼きにするのが本体で、**
       刃を明るくしただけだと「細いナイフ」のまま。
       焼き入れの青は金物の中で一番珍しい色なので、遠目でも他と混ざらない */
    over: {
      steel: { color: 0xb0bac6, metalness: 1.0, roughness: 0.18, wear: { color: 0xeaf2fa, amount: 0.35, rough: 0.12 } },
      anodized: { color: 0x2a4a86, wear: { color: 0x7098d0 } },
      phosphate: { color: 0x22345e, metalness: 1.0, roughness: 0.30, wear: { color: 0x6a8cc4, amount: 0.7 } },
      brass: { color: 0xd8c070, wear: { color: 0xf6ecc0, rough: 0.12 } },
      rubber: { color: 0x101828 },
    },
  },
  axe: {
    note: '柄を横切って載る刃頭と長い顎。錆の入った鉄と焦茶の木',
    swatch: '#5a4636',
    /* **刃先(chrome)だけ明るく残す。** 錆びた鉄の塊の中で、
       研いだ縁だけが光っている形にすると「使ってある道具」に見える。
       chromeは擦れを焼いていない材質なので色だけ差し替える */
    over: {
      steel: { color: 0x6a5648, metalness: 1.0, roughness: 0.62, wear: { color: 0xa8724a, amount: 1.2, dust: 0.22, dustColor: 0x6a4a30 } },
      chrome: { color: 0xc4ccd4 },
      phosphate: { color: 0x2a2320, wear: { color: 0x8a6a4e, amount: 1.1, dust: 0.20 } },
      walnut: { color: 0x3a2418, wear: { color: 0x7a4e2e, dust: 0.14 } },
      strap: { color: 0x3a2a1c },
      brass: { color: 0x9a7830, wear: { color: 0xd0b060 } },
    },
  },
  glove: {
    note: '刃を持たない。深い赤の革に白い縁取りと紐。両拳を構える',
    swatch: '#8c2a20',
    /* **革(mitt)を濃くして、縁取り(ivory)と手首の布(strap)を明るく置く。**
       全部を赤いままにすると、丸い塊が1色で潰れて風船に見える。
       縁が明るいと、そこが輪郭になって拳の丸みが読める。
       **真鍮は書かない。** 2026-08-12に当て金と留め金具を全部外した
       （ボクシンググローブに金物は無い） */
    over: {
      mitt: { color: 0x8e1c16, wear: { color: 0xd05a48, amount: 0.45 } },
      ivory: { color: 0xf0ece0, wear: { color: 0xfdfbf6, amount: 0.30 } },
      strap: { color: 0xd8d0be },
    },
  },

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
    note: '白い地に桜の柄。面へ貼った花と、銃床の花吹雪、朱の房',
    swatch: '#f0e8e4',
    /* **2026-08-11に作り直した。** 最初は漆の黒に金の桜という和の器に寄せたが、
       「桜なんだから、もっと白とピンクをベースにしてほしい」と言われた。
       **「和」ではなく「桜」を作る**のが要件だった。

       地を白にする。**明るい地は他にアイス（狙撃銃）しか無い**ので、
       ライフルではこれが唯一の明るい銃になる。
       擦れの色も暗くしない（塗り物ではなく、白く塗った銃なので）。

       機関部だけ桜色を薄く入れて、白一色の塊にならないようにしてある */
    over: {
      enamel: { color: 0xeee6e2, metalness: 0.1, roughness: 0.34, wear: { amount: 0.3, color: 0xfdf8f6, rough: 0.28 } },
      anodized: { color: 0xe4d2d6, metalness: 0.2, roughness: 0.30, wear: { amount: 0.3, color: 0xf6ecee } },
      polymer: { color: 0xe8dcd8, roughness: 0.42, wear: { amount: 0.25, color: 0xf8f2ee } },
      phosphate: { color: 0xd8c4c8, metalness: 0.2, roughness: 0.36, wear: { amount: 0.3, color: 0xefe0e2 } },
      // 地金は淡い金へ。花の芯と螺鈿の白が繋がる
      steel: { color: 0xc8b898, wear: { color: 0xeee0c8 } },
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
  // **サメは2026-08-14に消した**（経緯は protocol.js の SHAPE_LIST）

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
  astro: {
    note: '白い鏡筒と真鍮の口金、副望遠鏡と赤経環。天体望遠鏡に見立てる',
    swatch: '#12142a',
    /* **2026-08-12に作り直した。**「コンセプトもない」と言われた所。
       前は紺紫の地に光る粒を12個散らしただけだった。

       今は飾り側(astroDeco)が白い鏡筒と真鍮を持っているので、
       **ここは架台の黒を作る役。** 19世紀の屈折望遠鏡は
       「白い筒＋真鍮の金具＋黒い架台」の3色でできていて、
       架台まで明るくすると筒が浮かなくなる。
       夜空の名残りで、黒を少しだけ青へ寄せてある */
    over: {
      enamel: { color: 0x13152a, wear: { color: 0xa88c50, amount: 0.9 } },
      polymer: { color: 0x171930, wear: { color: 0x8a7448 } },
      polymerTan: { color: 0x1c1e36, wear: { color: 0x9a8250 } },
      anodized: { color: 0x0f1120, wear: { color: 0x8e7a48 } },
      phosphate: { color: 0x0d0f1c, wear: { color: 0x7e6c40 } },
      // 地金は真鍮寄りへ。口金と地金が繋がって、飾りが後付けに見えない
      steel: { color: 0xa8925c, wear: { color: 0xdcc890 } },
    },
  },
  bamboo: {
    note: '銃身に沿う弓の弧と弦、籐巻きと朱の房。和弓に見立てる',
    swatch: '#1c1a16',
    /* **2026-08-12に作り直した。**「コンセプトもない」と言われた所。
       前は銃身に竹の筒を被せて節を並べただけで、
       出来上がりは「緑に塗った狙撃銃」だった。

       今は飾り側(bambooDeco)が弓の弧と弦を持っている。
       **ここは黒漆を作る役。** 和弓の籐巻きと弭は黒漆で、
       竹の色はそこに挟まって初めて竹に見える。
       日本刀（黒漆と金）と同じ系統 */
    over: {
      enamel: { color: 0x1c1a16, wear: { color: 0x8a7a4e, amount: 0.9 } },
      polymer: { color: 0x201d18, wear: { color: 0x74684a } },
      polymerTan: { color: 0x27231c, wear: { color: 0x8a7c58 } },
      anodized: { color: 0x161410, wear: { color: 0x6e6244 } },
      phosphate: { color: 0x13110e, wear: { color: 0x625840 } },
      // 地金は古い真鍮へ。弓の金具と繋がる
      steel: { color: 0x9a8a5e, wear: { color: 0xcabb8e } },
    },
  },


  bullpup: {
    note: '弾倉が引金の後ろ。全長は短いのに銃身は長い、機関部が肩まで続く形',
    swatch: '#2e3338',
    /* **無彩色の樹脂。** ドラゴン(赤銅)・キャンディ(パステル)・
       装甲(鉄)・桜(白)と色で競わない。この形違いは輪郭で主張する物なので、
       色は「新しい樹脂の銃」であることだけ出せばいい */
    over: {
      polymer: { color: 0x2e3338, wear: { color: 0x76808a } },
      polymerTan: { color: 0x353b41, wear: { color: 0x828c96 } },
      enamel: { color: 0x1c2024, wear: { color: 0x68727c, amount: 0.8 } },
      anodized: { color: 0x262c32, wear: { color: 0x7e8892 } },
      phosphate: { color: 0x20252a, wear: { color: 0x6e7882 } },
      steel: { color: 0x8a939c, wear: { color: 0xc8d0d8 } },
    },
  },
  antimat: {
    note: '太い銃身と大きな制退器、角張った箱の機関部。前へ開いた二脚',
    swatch: '#3d4238',
    /* **砂漠の機材色。** 今の狙撃銃は白(氷)・黄緑(毒)・黒(望遠鏡と和弓)なので、
       くすんだ土色がここだけになる。大きい物は彩度を落とす方が重く見える */
    over: {
      anodized: { color: 0x3d4238, wear: { color: 0x8e9484, amount: 1.0, dust: 0.20 } },
      polymer: { color: 0x363a30, wear: { color: 0x7e8474, dust: 0.18 } },
      polymerTan: { color: 0x5a5a46, wear: { color: 0xa2a288, dust: 0.22 } },
      enamel: { color: 0x24261e, wear: { color: 0x6e7464, amount: 0.9 } },
      phosphate: { color: 0x2a2c24, wear: { color: 0x767c6c, dust: 0.16 } },
      steel: { color: 0x8a9080, wear: { color: 0xc2c8b4 } },
    },
  },
  hunter: {
    note: '一体の胡桃の銃床、露出した長い遊底、真鍮の口金と底板',
    swatch: '#5a3520',
    /* **木と真鍮。** 飾りは足していない（素朴なのがこの銃の中身）ので、
       塗りが仕事を全部する。金属は木に合う暖かい黒へ寄せて、
       真鍮と象牙だけが明るく残る形にしてある */
    over: {
      walnut: { color: 0x5a3520, wear: { color: 0x9c6438, dust: 0.10 } },
      phosphate: { color: 0x1e1a16, wear: { color: 0x7a6a52, amount: 0.9 } },
      enamel: { color: 0x191512, wear: { color: 0x6a5c46 } },
      anodized: { color: 0x221d18, wear: { color: 0x7e6e56 } },
      polymer: { color: 0x1c1814, wear: { color: 0x64583f } },
      brass: { color: 0xc09040, wear: { color: 0xecd490, rough: 0.12 } },
      steel: { color: 0x9a9288, wear: { color: 0xd6d0c4 } },
    },
  },

  suppressed: {
    note: '前へ11cm伸びる消音器。ねじ切りの銃身と、溝の入った太い筒',
    swatch: '#22262b',
    /* **地は暗いまま。** 消音器は輪郭で主張する飾りなので、
       色で足すと筒と本体が別々の物に見える。艶を落として
       「音を殺す道具」の質感（つや消しの黒）へ寄せるのが仕事 */
    over: {
      enamel: { color: 0x16191d, roughness: 0.62, wear: { color: 0x5e6870, amount: 0.7 } },
      anodized: { color: 0x22262b, roughness: 0.55, wear: { color: 0x6e7880 } },
      phosphate: { color: 0x1b1f23, roughness: 0.72, wear: { color: 0x66707a, amount: 0.8 } },
      polymer: { color: 0x191c20, wear: { color: 0x545e66 } },
      steel: { color: 0x707a84, wear: { color: 0xa8b2bc } },
    },
  },

  /* ---- 2026-08-12に足した2つ。**どちらも形ごと別の銃になる。**
     「ピストルがなんかな。どれもイケてないんだよな」
     「ショットガンもなんか好きに足んないなぁ」と言われた所。
     色を並べても「同じ銃の色違い」から出られないので、組み立てから変えている
     （実際の組み立ては weapons.js の buildRevolver / buildSawedOff）*/
  revolver: {
    note: 'スライドを持たない。丸い銃身と回転弾倉、立った撃鉄と胡桃の握把',
    swatch: '#1d2733',
    /* **青黒い鋼（ブルーイング）。** 今の拳銃は黒・銀・黒緑・透明で、
       青みのある黒が1つも無い。木の握把と並べた時に一番古い銃に見える色 */
    over: {
      enamel: { color: 0x141c26, wear: { color: 0x6e808e, amount: 0.9 } },
      anodized: { color: 0x1a2430, wear: { color: 0x7a8c9a } },
      phosphate: { color: 0x1d2733, wear: { color: 0x8496a4, amount: 0.8 } },
      polymer: { color: 0x181f27, wear: { color: 0x5a6a76 } },
      steel: { color: 0x8496a4, wear: { color: 0xccd8e2 } },
      walnut: { color: 0x53301c, wear: { color: 0x9a6034 } },
      brass: { color: 0xc0913a, wear: { color: 0xecd48c } },
    },
  },
  sawedoff: {
    note: '銃身を切り詰めた二連。露出した撃鉄と木の先台、切り口の地金',
    swatch: '#2a2018',
    /* **黒鉄と古い木。** ウエスタン（手入れされた胡桃と真鍮）と分ける。
       あちらは飾ってある猟銃で、こちらは**切ってある**銃なので、
       木も金属も傷んでいる方が正しい。切り口(steel)だけ明るく残す */
    over: {
      enamel: { color: 0x1a1712, wear: { color: 0x7a6c52, amount: 1.1, dust: 0.18 } },
      phosphate: { color: 0x211c15, wear: { color: 0x8a7854, amount: 1.0, dust: 0.16 } },
      anodized: { color: 0x241e16, wear: { color: 0x8e7c58 } },
      polymer: { color: 0x1e1a14, wear: { color: 0x6a5c44 } },
      walnut: { color: 0x40291a, wear: { color: 0x845234, dust: 0.14 } },
      // 切った面。**ここだけ明るい。** 切ったばかりの地金が光る
      steel: { color: 0xb0b6bc, wear: { color: 0xe4eaf0 } },
      brass: { color: 0x9a7c34, wear: { color: 0xd0b06a } },
    },
  },

  /* ---- 2026-08-15に足したショットガンの2つ（経緯は protocol.js の SHAPE_LIST） */
  lever: {
    note: '機関部の下の輪っか、露出した撃鉄、青光りする鋼とまっすぐな木の銃床',
    swatch: '#2c3a48',
    /* **青光りする鋼（ブルーイング）。** 同じ「昔の銃の木と金属」でも、
       ウエスタンは真鍮の暖色、ソードオフは傷んだ黒鉄なので、
       ここは**青へ振った鋼**で3本を分ける。木は赤みの胡桃で鋼の青と対にする */
    over: {
      enamel: { color: 0x232e3a, metalness: 0.6, roughness: 0.30, wear: { color: 0x6e8296, amount: 0.8 } },
      phosphate: { color: 0x1e2832, wear: { color: 0x64788c } },
      polymer: { color: 0x28303a, wear: { color: 0x5e7080 } },
      walnut: { color: 0x58301c, wear: { color: 0xa06438, dust: 0.10 } },
      steel: { color: 0x8ea0b2, wear: { color: 0xd8e4ee } },
      brass: { color: 0xa08038, wear: { color: 0xd4b468 } },
    },
  },
  drum: {
    note: '太鼓型の弾倉、天面のレール、マズルブレーキ。つや消しの軍用樹脂',
    swatch: '#4a5240',
    /* **暗いオリーブ。** 棚で唯一の現代の軍用なので、色も唯一の軍色にする。
       ヴェノム（狙撃銃の黄緑）と被らないよう、彩度を落として灰へ寄せる */
    over: {
      polymer: { color: 0x3c4434, roughness: 0.52, wear: { color: 0x78806a, dust: 0.14 } },
      phosphate: { color: 0x2e3428, wear: { color: 0x6a7258 } },
      enamel: { color: 0x33392c, wear: { color: 0x707862 } },
      steel: { color: 0x7a8270, wear: { color: 0xbcc4ae } },
      rubber: { color: 0x2a2e24, wear: { color: 0x565c4a } },
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
