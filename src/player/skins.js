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
  desert: {
    note: '砂漠色の塗装。埃を強めに',
    swatch: '#6d5f45',
    over: {
      enamel: { color: 0x6d5f45, wear: { color: 0x8a7c62, dust: 0.22 } },
      anodized: { color: 0x7a6c50, wear: { color: 0x9c8f74, dust: 0.20 } },
      polymer: { color: 0x5b5240, wear: { color: 0x7d7460, dust: 0.24 } },
      phosphate: { color: 0x4a4436, wear: { dust: 0.20 } },
    },
  },
  urban: {
    note: '青灰色。市街地で沈む',
    swatch: '#39424f',
    over: {
      enamel: { color: 0x2b323c, wear: { color: 0x7d8794 } },
      anodized: { color: 0x39424f, wear: { color: 0x94a0b0 } },
      polymer: { color: 0x2f353d },
      phosphate: { color: 0x272c34 },
    },
  },
  veteran: {
    note: '色は標準のまま。角が全部剥げている',
    swatch: '#7d858e',
    /* **色を1つも変えていない。** 擦れの量だけを上げたスキン。
       同じ銃が「長く使い込んだ物」に見える。
       画像を持たない作りだからこれが数字1つでできる */
    over: {
      enamel: { wear: { amount: 1.6, dust: 0.22 } },
      anodized: { wear: { amount: 1.5, dust: 0.20 } },
      phosphate: { wear: { amount: 1.6, dust: 0.24 } },
      polymer: { wear: { amount: 1.1, dust: 0.26 } },
      steel: { wear: { amount: 0.8 } },
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
