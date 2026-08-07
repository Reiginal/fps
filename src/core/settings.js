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
    key: 'voice',
    store: 'blackout.voice',
    name: 'ボイスチャット',
    kind: 'check',
    def: true,
    hint: `対戦中、${'V'}キーを押している間だけ味方に声が届きます。`
      + 'マイクの許可は最初に1度だけ聞かれます。断っても遊べます（聞く側になります）',
    apply: (v, t) => { t.voice?.setEnabled?.(v); },
  },
  {
    key: 'voiceVol',
    store: 'blackout.voicevol',
    name: '声の音量',
    kind: 'range',
    min: 0, max: 1, step: 0.05, def: 1,
    fmt: (v) => `${Math.round(v * 100)}%`,
    hint: '相手の声だけの音量です。ゲームの音とは別に調整できます',
    apply: (v, t) => { t.voice?.setVolume?.(v); },
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
  /* ---- ここから画質。効かせ先は t.gfx（main.jsが組んで渡す） ----
     友達のPCでカクついた時に、こちらが直すまで遊べないのでは遅い。
     本人がその場で軽くできる逃げ道を置く。

     **既定は軽め（2026-08-07に方針変更）。**
     最初は「既定＝今までと同じ絵（全部盛り）」にしていたが、
     M1のMacBookで1人プレイを少し遊んだだけで熱くなった。
     このゲームの決めごとは「軽さは機能より優先」なので、既定は
     きめ細かさ85%・接地の陰影切り・影は中、に倒す。
     絵を盛りたい人が設定で上げる向きにする（groupは設定画面の列分け） */
  {
    key: 'gfxAuto',
    group: '画質',
    // **表の中で画質の先頭に置くこと。** 自動を切った時の巻き戻し(_applyRung(0))が
    // 先に走ってから、下の各項目が覚えている値を上書きで効かせる順になっている
    store: 'blackout.gfx.auto',
    name: '画質を自動でまかせる',
    kind: 'check',
    def: true,
    hint: 'カクつく端末では自動で1段ずつ画質を下げます（下げた時は画面に一言出ます）。'
      + '下の項目を手で触ると自動は切れます',
    apply: (v, t) => { t.gfx?.setAuto?.(v); },
  },
  {
    key: 'gfxScale',
    group: '画質',
    store: 'blackout.gfx.scale',
    name: '描画のきめ細かさ',
    kind: 'range',
    min: 0.5, max: 1, step: 0.05, def: 0.85,
    fmt: (v) => `${Math.round(v * 100)}%`,
    hint: '下げると少しぼやける代わりに軽くなります。カクつく時はまずここから',
    apply: (v, t) => { t.gfx?.setRenderScale?.(v); },
  },
  {
    key: 'gfxAo',
    group: '画質',
    store: 'blackout.gfx.ao',
    name: '接地の陰影',
    kind: 'check',
    def: false,
    hint: '物と床の接点に入る細い影です。入れると絵は締まりますが、'
      + '画面を2回描くことになるので大きく重くなります',
    apply: (v, t) => { t.gfx?.setAo?.(v); },
  },
  {
    key: 'gfxBloom',
    group: '画質',
    store: 'blackout.gfx.bloom',
    name: '光のにじみ',
    kind: 'check',
    def: true,
    hint: '太陽や発砲の光がふわっと広がる効果です。切ると少し軽くなります',
    apply: (v, t) => { t.gfx?.setBloom?.(v); },
  },
  {
    key: 'gfxShadow',
    group: '画質',
    store: 'blackout.gfx.shadow',
    name: '影のこまやかさ',
    kind: 'select',
    options: ['高', '中', '低'],
    def: '中',
    hint: '中は影が少し粗く、低はさらに遠く(16mの外)の動く影の更新がゆっくりになり、'
      + '屋内のランプも消えます。ぼかしの細かさとランプは開き直してから効きます',
    apply: (v, t) => { t.gfx?.setShadowQuality?.(v); },
  },
  {
    key: 'gfxMsaa',
    group: '画質',
    store: 'blackout.gfx.msaa',
    name: 'ふちのギザギザ消し',
    kind: 'check',
    def: true,
    hint: '物のふちをなめらかにする処理(MSAA)です。切ると軽くなりますが、'
      + '開き直してから効きます',
    apply: (v, t) => { t.gfx?.setMsaa?.(v); },
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
  // 選択式は、選択肢に無い物（壊れた値・昔の値）を全部既定へ落とす
  if (def.kind === 'select') {
    return def.options.includes(raw) ? raw : def.def;
  }
  const n = typeof raw === 'number' ? raw : parseFloat(raw);
  if (!Number.isFinite(n)) return def.def;
  return Math.min(def.max, Math.max(def.min, n));
}

/* localStorageは設定次第で読み書きどちらも例外を投げる。
   設定を覚えられないだけで遊べなくなるのは割に合わない（netmenu.jsと同じ作法） */
const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key, value) => { try { localStorage.setItem(key, value); } catch { /* 覚えられないだけ */ } };
const remove = (key) => { try { localStorage.removeItem(key); } catch { /* 消せないだけ */ } };

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

/**
 * 覚えた物を全部消す（設定画面の「既定に戻す」）。
 *
 * **既定値を書き込むのではなく、覚えた値を消す。**
 * 前は既定値を書き込んでいたが、それだと一度押した端末に「その時点の既定」が
 * 固定されて、こちらが既定を変えても（画質の既定を軽めへ倒した等）追従しない。
 * 実際、既定を軽めへ変えた後も前の全部盛りのまま始まる端末があった。
 * 消しておけば、次に読む時はその時々の既定に落ちる
 */
export function resetSettings() {
  for (const s of SETTINGS) remove(s.store);
  return Object.fromEntries(SETTINGS.map((s) => [s.key, s.def]));
}

/**
 * 効かせる。**表に足しただけで繋ぎ忘れる**のがこの手の機能の定番の落とし方なので、
 * 効かせ方も表が持っていて、ここは表を回すだけにしてある。
 */
export function applySettings(values, targets) {
  for (const s of SETTINGS) s.apply(coerce(s, values?.[s.key]), targets || {});
}
