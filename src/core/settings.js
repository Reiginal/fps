// 遊ぶ側が変えられる設定。**表が1枚、それだけ。**
//
// なぜ要るか: 感度はコードに 0.0022 と直接書いてあった。
// 感度は人によって合う値が全然違うもので、合っていないと
// 「狙えない」がずっと「自分が下手だから」に見える。作った側は自分に合わせて
// 書いてあるので、この不自由さを一生踏まない。
//
// なぜ表にするか: 設定というのは**足す場所が4つある**。
//   1. 画面の並び（名前・説明・つまみの幅）
//   2. 端末への覚えさせ方（localStorageの鍵）
//   3. 読み込んだ値の正し方（範囲外・壊れた値）
//   4. 実際にどこへ効かせるか
// 4箇所に散らすと、必ずどれかを書き忘れる。特に4を忘れた時が最悪で、
// **つまみは動くのに何も起きない。** 遊ぶ側からは壊れていると分かるが、
// 作った側は「設定を足した」で終わっている。
// なので1つの表に4つとも持たせて、画面はこの表を読んで並べるだけにする。
//
// 検査は tools/check-settings.mjs。

/* 感度の基準。ここに掛け算する形にしてある。
   生の 0.0022 をそのままつまみに出すと、遊ぶ側は 0.0018 と 0.0026 の違いを
   数字から想像できない。×0.8 / ×1.2 なら「2割ゆるく」と読める */
export const SENS_BASE = 0.0022;

/* 音量の既定。audio.js が init する前でもこの値を持っておく必要があるので、
   あちらの constructor もここを見る（2箇所に0.75と書くと必ず片方が古くなる） */
export const VOLUME_DEF = 0.75;

/**
 * 設定の表。並べた順にそのまま画面へ出る。
 *
 * kind:  'range' … つまみ（min/max/step/fmtを持つ）
 *        'check' … 入り切り
 * store: localStorageの鍵。**既にある鍵は変えない。**
 *        変えると、その設定だけ黙って既定へ戻る
 * apply: 効かせ先。targets は { input, audio } を想定していて、
 *        まだ出来ていない物が居ないよう ?. で受ける
 */
export const SETTINGS = [
  {
    key: 'sens',
    store: 'blackout.sens',
    name: 'マウス感度',
    kind: 'range',
    min: 0.3, max: 3, step: 0.05, def: 1,
    fmt: (v) => `×${v.toFixed(2)}`,
    hint: '大きいほど、同じ手の動きで大きく振り向きます。覗き込み中の効き方も一緒に変わります',
    apply: (v, t) => { if (t.input) t.input.sensitivity = SENS_BASE * v; },
  },
  {
    key: 'invY',
    store: 'blackout.invertY',
    name: '上下を反転',
    kind: 'check',
    def: false,
    hint: 'マウスを手前に引くと上を向くようになります',
    apply: (v, t) => { if (t.input) t.input.invertY = v; },
  },
  {
    key: 'vol',
    store: 'blackout.volume',
    name: '音量',
    kind: 'range',
    min: 0, max: 1, step: 0.05, def: VOLUME_DEF,
    fmt: (v) => `${Math.round(v * 100)}%`,
    hint: '0にすると無音になります。足音で位置を掴む遊びなので、下げすぎると不利になります',
    apply: (v, t) => { t.audio?.setVolume?.(v); },
  },
  {
    key: 'full',
    // 全画面は前から選択画面のつまみにあった。**鍵をそのまま引き継ぐ**ので、
    // 前に切った人は切ったまま、ここへ移っても戻らない
    store: 'blackout.fullscreen',
    name: '全画面で遊ぶ',
    kind: 'check',
    def: true,
    hint: '切ると窓のまま遊べます（別のタブを見に行きたい時に）。'
      + 'そのかわりWindowsでは、しゃがみながらWを押すとタブが閉じることがあります',
    apply: (v, t) => { if (t.input) t.input.wantFullscreen = v; },
  },
];

export const defOf = (key) => SETTINGS.find((s) => s.key === key) || null;

/**
 * 端末から出てきた値を、使える値へ正す。
 *
 * **ここが無いと、壊れた値がそのまま感度になる。** localStorageは人が手で
 * 書き換えられるし、こちらが保存の形を変えれば前の形が残る。
 * 感度に NaN が入ると掛け算の結果も NaN になり、視点がまったく動かなくなる。
 * 例外は1つも出ないので、遊ぶ側からは「マウスが効かない」としか見えない。
 */
export function coerce(def, raw) {
  if (!def) return null;
  if (def.kind === 'check') {
    if (raw === null || raw === undefined || raw === '') return def.def;
    return raw === true || raw === '1' || raw === 'true';
  }
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return def.def;
  return Math.min(def.max, Math.max(def.min, n));
}

/* localStorageは設定次第で読み書きどちらも例外を投げる。
   設定を覚えられないだけで遊べなくなるのは割に合わない（netmenu.jsと同じ作法） */
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 覚えられないだけ */ } };

/** 端末に覚えさせる形。入り切りは前からある '1' / '0' を使う */
const encode = (def, v) => (def.kind === 'check' ? (v ? '1' : '0') : String(v));

/** 全部読む。壊れていた物は既定へ落ちるので、戻り値は必ず使える値 */
export function loadSettings() {
  const out = {};
  for (const s of SETTINGS) out[s.key] = coerce(s, read(s.store));
  return out;
}

/** 1つ覚えさせる。正した後の値を返すので、呼んだ側はそれを持ち直す */
export function saveSetting(key, raw) {
  const def = defOf(key);
  if (!def) return null;
  const v = coerce(def, raw);
  write(def.store, encode(def, v));
  return v;
}

/** 覚えた物を全部消す（設定画面の「既定に戻す」） */
export function resetSettings() {
  for (const s of SETTINGS) write(s.store, encode(s, s.def));
  return Object.fromEntries(SETTINGS.map((s) => [s.key, s.def]));
}

/**
 * 効かせる。**表に足しただけで繋ぎ忘れる**のがこの手の機能の定番の落とし方なので、
 * 効かせ方も表が持っていて、ここは表を回すだけにしてある。
 */
export function applySettings(values, targets) {
  for (const s of SETTINGS) s.apply(coerce(s, values?.[s.key]), targets || {});
}
