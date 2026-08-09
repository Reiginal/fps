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
// できるのは「塗装の色を変える」「擦れ具合を変える」まで。
// スキンとしてはそれで足りるし、部品ごとにやりたくなったら組み立て側の話になる。
import { skinnedFrom, matNameOf } from './weapons.js';

/* 選んだスキンの覚え先。**この端末に覚える。**
   買える形にする時にサーバー側（台帳）へ移す。
   今は全部解放なので、端末ごとに違っても誰も困らない */
const STORE = 'blackout.skin';

/* スキンの表。
 *
 * over の鍵は MATS の名前。**そこに書いた材質だけが差し替わる。**
 * 書かなかった物（手袋・袖・レンズ）は元のまま出る。
 *
 * wear は「角の塗装がどれだけ剥げて地金が出ているか」。
 * amount を上げると使い込んだ銃に、下げると新品に見える。
 * **CS:GOの「摩耗度」と同じ考え方**で、色を変えずに値段の幅を作れる */
export const SKINS = [
  {
    id: 'stock',
    name: '標準',
    note: '支給品のまま',
    // 何も差し替えない。元の見た目
    over: null,
    swatch: '#2c2f34',
  },
  {
    id: 'desert',
    name: 'デザート',
    note: '砂漠色の塗装。埃を強めに',
    over: {
      enamel: { color: 0x6d5f45, wear: { color: 0x8a7c62, dust: 0.22 } },
      anodized: { color: 0x7a6c50, wear: { color: 0x9c8f74, dust: 0.20 } },
      polymer: { color: 0x5b5240, wear: { color: 0x7d7460, dust: 0.24 } },
      phosphate: { color: 0x4a4436, wear: { dust: 0.20 } },
    },
    swatch: '#6d5f45',
  },
  {
    id: 'urban',
    name: 'アーバン',
    note: '青灰色。市街地で沈む',
    over: {
      enamel: { color: 0x2b323c, wear: { color: 0x7d8794 } },
      anodized: { color: 0x39424f, wear: { color: 0x94a0b0 } },
      polymer: { color: 0x2f353d },
      phosphate: { color: 0x272c34 },
    },
    swatch: '#39424f',
  },
  {
    id: 'veteran',
    name: '歴戦',
    note: '色は標準のまま。角が全部剥げている',
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
    swatch: '#7d858e',
  },
  {
    id: 'gold',
    name: 'ゴールド',
    note: '派手枠。値段を付けるならここ',
    over: {
      enamel: { color: 0x8a6a1f, metalness: 1.0, roughness: 0.28, wear: { color: 0xe8c46a, rough: 0.16 } },
      anodized: { color: 0xa8811f, metalness: 1.0, roughness: 0.24, wear: { color: 0xf0d488, rough: 0.12 } },
      phosphate: { color: 0x6b5416, wear: { color: 0xc9a24e } },
      steel: { color: 0xb8903e, wear: { color: 0xe0c179 } },
    },
    swatch: '#a8811f',
  },
];

export const skinAt = (id) => SKINS.find((s) => s.id === id) || SKINS[0];

/* 焼いた材質の置き場。id -> Map<面に貼ってある材質, 新しい材質>。
   **1つのスキンにつき、1つの材質を1回しか焼かない。**
   焼くのは96×96の画素をなめる処理なので、持ち替えのたびにやり直すと
   持ち替えの瞬間に必ず引っかかる。
   nullも覚える（「この材質はこのスキンでは差し替えない」も答えの1つ） */
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

/* localStorageは設定次第で読み書きどちらも例外を投げる。
   覚えられないだけで遊べなくなるのは割に合わない（netmenu.jsと同じ作法） */
export function loadSkin() {
  try {
    const v = localStorage.getItem(STORE);
    return SKINS.some((s) => s.id === v) ? v : SKINS[0].id;
  } catch { return SKINS[0].id; }
}

export function saveSkin(id) {
  const v = skinAt(id).id;
  try { localStorage.setItem(STORE, v); } catch { /* 覚えられないだけ */ }
  return v;
}
