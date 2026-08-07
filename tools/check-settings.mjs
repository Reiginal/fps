// 設定（感度・音量・上下反転・全画面）の検査。
//
// なぜ要るか: 設定は**壊れても例外にならない**種類の機能なので、
// 気づく手段が「遊んでいて何かおかしい」しか無い。落ち方が3つある。
//
//   1. 表に足したのに繋ぎ忘れる … つまみは動くのに何も起きない
//   2. 覚えた値が壊れている     … 感度がNaNになると視点が一切動かなくなる。
//                                 例外は出ないので「マウスが効かない」としか見えない
//   3. 既定値が変わってしまう   … 設定を足した副作用で、今まで遊んでいた人の
//                                 手触りが黙って変わる。一番気づかれにくい
//
// 3つとも数字で押さえる。特に[2]は「設定を足したせいで前と違う感度になっていないか」で、
// **設定機能そのものより大事**（今まで通り遊べることが最低条件なので）。
//
//   node tools/check-settings.mjs
import { readFileSync } from 'node:fs';

/* ------------------------------------------------ 最小限の偽DOM */
// dom-stub.js の getElementById は null を返す作りなので、
// 画面を組み立てる所が「部品が無いので何もしない」経路に落ちて検査にならない
// （tools/check-hud.mjs と同じ理由・同じ形）

const mkEl = (id) => {
  const classes = new Set();
  const el = {
    id,
    tag: '',
    type: '',
    value: '',
    checked: false,
    style: {},
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    append(...cs) { for (const c of cs) { this.children.push(c); c._parent = this; } },
    appendChild(c) { this.append(c); },
  };
  // textContent = '' で中身を空にする作法を使っているので、そこだけ本物に寄せる
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); if (text === '') el.children.length = 0; },
  });
  return el;
};

const els = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, mkEl(id));
    return els.get(id);
  },
  createElement: (tag) => { const e = mkEl('new'); e.tag = tag; return e; },
};
globalThis.window = globalThis;

// キーの受け口。ESCで閉じるところを確かめたいので、捨てずに溜める
const listeners = [];
globalThis.addEventListener = (type, fn) => listeners.push({ type, fn });
const fireKey = (key) => {
  const e = { key, _stopped: false, stopPropagation() { this._stopped = true; } };
  for (const l of listeners) if (l.type === 'keydown') l.fn(e);
  return e;
};

/* ------------------------------------------------ 偽localStorage */
// 本物と同じく「文字しか入らない」ことを守る。
// ここを素のオブジェクトにすると、数値が数値のまま往復してしまい、
// 実機で起きる「読むと文字になっている」がすり抜ける

const mkStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    _map: m,
  };
};
globalThis.localStorage = mkStore();

const {
  SETTINGS, SENS_BASE, VOLUME_DEF, coerce, defOf,
  loadSettings, saveSetting, resetSettings, applySettings,
} = await import('../src/core/settings.js');
const { SettingsMenu } = await import('../src/ui/settings.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/** 効かせ先の代わり。本物と同じ名前の置き場だけ持つ */
const mkTargets = () => ({
  input: {},
  audio: { volume: null, setVolume(v) { this.volume = v; } },
  // 声の層。**効かせ先をここへ足し忘れると、[6]が落ちる。**
  // 落ちるのが正しい（表に足したのに何も動かない設定、という意味なので）
  voice: {
    enabled: null, volume: null,
    setEnabled(v) { this.enabled = v; },
    setVolume(v) { this.volume = v; },
  },
  // 画質の層（main.jsが組むgfxと同じ口）
  gfx: {
    scale: null, ao: null, bloom: null, shadow: null, msaa: null, auto: null,
    setRenderScale(v) { this.scale = v; },
    setAo(v) { this.ao = v; },
    setBloom(v) { this.bloom = v; },
    setShadowQuality(v) { this.shadow = v; },
    setMsaa(v) { this.msaa = v; },
    setAuto(v) { this.auto = v; },
  },
});
const snap = (t) => JSON.stringify({
  input: t.input, vol: t.audio.volume, voice: t.voice.enabled, vvol: t.voice.volume,
  gfx: t.gfx,
});

console.log('\n[1] 表の作り');
{
  ok(SETTINGS.length >= 3, `設定は ${SETTINGS.length} 個（${SETTINGS.map((s) => s.name).join('、')}）`);

  const keys = SETTINGS.map((s) => s.key);
  ok(new Set(keys).size === keys.length, '同じ名札が2回出てこない');

  const stores = SETTINGS.map((s) => s.store);
  ok(new Set(stores).size === stores.length, '端末の鍵が重なっていない');
  ok(stores.every((k) => k.startsWith('blackout.')),
    '鍵は全部 blackout. で始まる（他のページと混ざらない）');

  for (const s of SETTINGS) {
    ok(!!s.name && typeof s.apply === 'function' && s.def !== undefined,
      `${s.key} … 名前と既定値と効かせ方が揃っている`);
    if (s.kind === 'select') {
      ok(Array.isArray(s.options) && s.options.length >= 2 && s.options.includes(s.def),
        `${s.key} … 選択肢があり、既定値がその中にある（${s.options?.join('/')}）`);
    }
    if (s.kind !== 'range') continue;
    ok(s.min < s.max && s.step > 0, `${s.key} … 幅が正しい (${s.min}〜${s.max} 刻み${s.step})`);
    ok(s.def >= s.min && s.def <= s.max, `${s.key} … 既定値 ${s.def} が幅の中にある`);
    ok(typeof s.fmt === 'function', `${s.key} … 画面に出す文字の作り方を持っている`);
  }
}

console.log('\n[2] 既定のままなら、今までと同じ手触り');
// **ここが一番大事。** 設定を足した副作用で、何も触っていない人の
// 感度や音量が変わってはいけない。数字は設定を入れる前にコードへ直接書いてあった物
{
  const t = mkTargets();
  applySettings({}, t);   // 何も覚えていない端末＝全部既定
  ok(t.input.sensitivity === 0.0022,
    `感度が前と同じ 0.0022（今 ${t.input.sensitivity}）`);
  ok(t.input.wantFullscreen === true, '全画面は入り');
  ok(t.audio.volume === 0.75, `音量が前と同じ 0.75（今 ${t.audio.volume}）`);
  ok(VOLUME_DEF === 0.75, '音量の既定値もそこと揃っている');
  ok(SENS_BASE === 0.0022, '感度の基準もそこと揃っている');

  // 感度は掛け算。×2で倍、×0.5で半分になる
  const t2 = mkTargets();
  applySettings({ sens: 2 }, t2);
  ok(Math.abs(t2.input.sensitivity - 0.0044) < 1e-9,
    `×2で倍になる（${t2.input.sensitivity}）`);

  // 画質の既定も「今までと同じ絵」。設定を足した副作用で
  // 何も触っていない人の画面がぼやけたり陰影が消えたりしてはいけない
  ok(t.gfx.scale === 1, `描画のきめ細かさの既定は100%（今 ${t.gfx.scale}）`);
  ok(t.gfx.ao === true, '接地の陰影の既定は入り');
  ok(t.gfx.bloom === true, '光のにじみの既定は入り');
}

console.log('\n[3] 壊れた値を正す');
// localStorageは人が手で書き換えられるし、保存の形を変えれば前の形が残る。
// **感度にNaNが入ると掛け算の結果もNaNになり、視点がまったく動かなくなる。**
// 例外は1つも出ないので、遊ぶ側からは「マウスが効かない」としか見えない
{
  const sens = defOf('sens');
  ok(coerce(sens, 'でたらめ') === sens.def, `文字は既定へ（${coerce(sens, 'でたらめ')}）`);
  ok(coerce(sens, null) === sens.def, '空も既定へ');
  ok(coerce(sens, 'NaN') === sens.def, 'NaNという文字も既定へ');
  ok(coerce(sens, '999') === sens.max, `大きすぎる値は上限へ（${coerce(sens, '999')}）`);
  ok(coerce(sens, '-5') === sens.min, `小さすぎる値は下限へ（${coerce(sens, '-5')}）`);
  ok(coerce(sens, '1.5') === 1.5, '文字で入っている数はちゃんと数になる');

  // どんな入れ方をしても、掛けた先がNaNにならない
  for (const junk of ['でたらめ', null, undefined, '', 'NaN', 'Infinity', {}, []]) {
    const t = mkTargets();
    applySettings({ sens: junk }, t);
    ok(Number.isFinite(t.input.sensitivity) && t.input.sensitivity > 0,
      `${JSON.stringify(junk) ?? 'undefined'} を入れても感度が生きている（${t.input.sensitivity}）`);
  }

  const full = defOf('full');
  ok(coerce(full, '0') === false, '入り切りの0は切り');
  ok(coerce(full, '1') === true, '入り切りの1は入り');
  ok(coerce(full, null) === full.def, '覚えていない時は既定');

  // 選択式。選択肢に無い物（壊れた値・作りを変えた後の昔の値）は既定へ
  const shadow = defOf('gfxShadow');
  ok(coerce(shadow, '中') === '中', '選択肢の中の値はそのまま通る');
  ok(coerce(shadow, 'ultra') === shadow.def, '選択肢に無い値は既定へ');
  ok(coerce(shadow, null) === shadow.def, '覚えていない時は既定');
  ok(coerce(shadow, 12) === shadow.def, '数字が来ても落ちずに既定へ');
}

console.log('\n[4] 端末に覚えて、次に開いた時に戻ってくる');
{
  globalThis.localStorage = mkStore();
  ok(saveSetting('sens', '1.4') === 1.4, '覚えさせた値が返る');
  saveSetting('vol', 0.3);
  saveSetting('full', false);
  const v = loadSettings();
  ok(v.sens === 1.4, `感度が戻ってきた（${v.sens}）`);
  ok(v.vol === 0.3, `音量が戻ってきた（${v.vol}）`);
  ok(v.full === false, '全画面の切りが戻ってきた');

  // **全画面は設定画面へ移す前から blackout.fullscreen に '1'/'0' で入っている。**
  // 鍵と形を引き継いでいないと、前に切った人が開き直した時に黙って全画面へ戻る
  ok(defOf('full').store === 'blackout.fullscreen',
    '全画面の鍵が前と同じ blackout.fullscreen');
  ok(localStorage.getItem('blackout.fullscreen') === '0',
    `覚え方も前と同じ '0'（今 '${localStorage.getItem('blackout.fullscreen')}'）`);
  globalThis.localStorage = mkStore();
  localStorage.setItem('blackout.fullscreen', '0');
  ok(loadSettings().full === false, '前に切った人は切ったまま読み込まれる');

  const back = resetSettings();
  ok(back.sens === defOf('sens').def && loadSettings().sens === defOf('sens').def,
    '既定に戻すと全部戻る');
}

console.log('\n[5] localStorageが使えなくても遊べる');
// 設定によっては読み書きどちらも例外を投げる。
// 設定を覚えられないだけで遊べなくなるのは割に合わない
{
  globalThis.localStorage = {
    getItem() { throw new Error('拒否'); },
    setItem() { throw new Error('拒否'); },
  };
  let threw = false;
  let v = null;
  try { v = loadSettings(); saveSetting('sens', 2); resetSettings(); } catch { threw = true; }
  ok(!threw, '読み書きで例外が出ても外へ漏らさない');
  ok(v && v.sens === defOf('sens').def, '読めない時は既定で動く');
  globalThis.localStorage = mkStore();
}

console.log('\n[6] 表に足した物は必ず効く');
// **繋ぎ忘れの検出。** 表に足しただけで apply を書き忘れると、
// つまみは動くのに何も起きない。1つずつ「既定と違う値」を入れて、
// 効かせ先が本当に変わることを見る
{
  for (const s of SETTINGS) {
    const other = s.kind === 'check' ? !s.def
      : s.kind === 'select' ? s.options.find((o) => o !== s.def)
        : (s.def === s.min ? s.max : s.min);
    const t = mkTargets();
    applySettings({}, t);
    const before = snap(t);
    applySettings({ [s.key]: other }, t);
    ok(snap(t) !== before, `${s.name}（${s.def} → ${other}）で効かせ先が変わる`);
  }
}

console.log('\n[7] 音量は master に掛かる');
// 掛ける場所を間違えて一番下流にすると、頭打ちを通った後を削ることになり、
// 小さくしたのに割れたままになる
{
  const param = () => ({
    value: 0,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    setTargetAtTime() { return this; },
    cancelScheduledValues() { return this; },
  });
  const node = (extra = {}) => ({
    connect() {}, disconnect() {}, start() {}, stop() {},
    gain: param(), frequency: param(), Q: param(), detune: param(), delayTime: param(),
    ...extra,
  });
  window.AudioContext = class {
    constructor() { this.currentTime = 0; this.sampleRate = 48000; this.destination = node(); this.state = 'running'; }
    createGain() { return node(); }
    createOscillator() { return node({ type: 'sine' }); }
    createBiquadFilter() { return node({ type: 'lowpass' }); }
    createDynamicsCompressor() { return node({ threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }); }
    createConvolver() { return node({ buffer: null }); }
    createWaveShaper() { return node({ curve: null, oversample: 'none' }); }
    createDelay() { return node(); }
    createBufferSource() { return node({ buffer: null, playbackRate: param(), loop: false }); }
    createStereoPanner() { return node({ pan: param() }); }
    createBuffer(ch, len) { return { length: len, numberOfChannels: ch, getChannelData: () => new Float32Array(len) }; }
  };

  const { AudioEngine } = await import('../src/core/audio.js');
  const a = new AudioEngine();
  ok(a.volume === VOLUME_DEF, `作った時点の音量が既定（${a.volume}）`);

  // **音は「クリックしてから」でないと起こせないのに、設定は起動直後に読み込まれる。**
  // init前に呼ばれても値を覚えておけないと、開き直すたびに音量が既定へ戻る
  a.setVolume(0.2);
  ok(a.volume === 0.2, 'init前でも値は覚える');
  a.init({ ambience: false });
  ok(a.master.gain.value === 0.2, `init時に master へ写る（${a.master.gain.value}）`);

  a.setVolume(0.9);
  ok(a.master.gain.value === 0.9, 'init後は master へ直接効く');
  a.setVolume(0);
  ok(a.master.gain.value === 0, '0にもできる（無音）');
  a.setVolume(5);
  ok(a.master.gain.value === 1, '1を超えない（割れる）');
  a.setVolume('でたらめ');
  ok(a.master.gain.value === 1, '壊れた値は無視して今の音量を保つ');
}

console.log('\n[8] 設定の画面');
{
  globalThis.localStorage = mkStore();
  const root = document.getElementById('settings');
  root.classList.add('hidden');       // index.htmlと同じ、閉じた状態から始める

  const t = mkTargets();
  const menu = new SettingsMenu(t);

  ok(!menu.isOpen, '起動した時は閉じている');
  ok(t.input.sensitivity === 0.0022, '作った時点で設定が効いている（写し忘れが無い）');

  const rows = document.getElementById('stRows');
  ok(rows.children.length === SETTINGS.length,
    `表の数だけ行が並ぶ（${rows.children.length}行 / 設定${SETTINGS.length}個）`);

  // つまみを動かす → 覚える → 効く、が1本で繋がっているか
  const sensRow = rows.children[SETTINGS.findIndex((s) => s.key === 'sens')];
  const input = sensRow.children.find((c) => c.tag === 'input');
  ok(!!input && input.type === 'range', '感度はつまみで出ている');
  input.value = '2';
  input.oninput();
  ok(menu.values.sens === 2, `動かした値を持ち直している（${menu.values.sens}）`);
  ok(Math.abs(t.input.sensitivity - 0.0044) < 1e-9, 'その場で効いている');
  ok(localStorage.getItem('blackout.sens') === '2', '端末にも覚えている');
  const head = sensRow.children.find((c) => c.children.some((x) => x.textContent.includes('×')));
  ok(!!head, '今の値が画面にも出ている');

  // 入り切りのほう
  const fullRow = rows.children[SETTINGS.findIndex((s) => s.key === 'full')];
  const box = fullRow.children.find((c) => c.tag === 'input');
  ok(box.type === 'checkbox', '全画面は入り切りで出ている');
  box.checked = false;
  box.oninput();
  ok(t.input.wantFullscreen === false, '切ると効かせ先も切りになる');

  menu.show();
  ok(menu.isOpen, '開ける');
  const e = fireKey('Escape');
  ok(!menu.isOpen, 'ESCで閉じる');
  ok(e._stopped, 'ESCを下のゲームへ流さない（流すと一時停止と二重に効く）');

  menu.show();
  root.onclick({ target: root });
  ok(!menu.isOpen, '枠の外を押しても閉じる');
  menu.show();
  root.onclick({ target: rows });
  ok(menu.isOpen, '中の部品を押した時は閉じない');
  menu.hide();

  // 既定に戻す
  document.getElementById('stReset').onclick();
  ok(menu.values.sens === defOf('sens').def, '既定に戻すが効く');
  ok(t.input.sensitivity === 0.0022, '戻した値が効かせ先にも届く');
  document.getElementById('stClose').onclick();
  ok(!menu.isOpen, '閉じるボタンが効く');
}

console.log('\n[9] 画面の器と、開ける口が実在する');
// JSがどれだけ正しくても、器のidが1つ無いだけで静かに何も起きない
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['settings', 'stRows', 'stClose', 'stReset', 'nmSettings']) {
    ok(html.includes(`id="${id}"`), `id="${id}" が index.html にある`);
  }
  // 開いたまま起動すると、遊ぶ前に設定が画面いっぱいに出る
  ok(/id="settings"[^>]*class="[^"]*hidden/.test(html), '設定は閉じた状態で置いてある');

  // 全画面のつまみは設定画面へ移した。選択画面に残骸が残っていないか
  ok(!html.includes('id="nmFull"'), '選択画面の全画面つまみは残っていない');
  const netmenu = readFileSync(new URL('../src/ui/netmenu.js', import.meta.url), 'utf8');
  ok(!netmenu.includes('nmFull'), 'netmenu.js も引きに行っていない');

  // 一時停止から開く口。ここは main.js が文字列で組み立てるので、
  // index.html には出てこない。**置いた側と繋いだ側の両方が要る**
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok((main.match(/ovSettings/g) || []).length >= 2,
    '一時停止に設定のボタンを置いて、押した時の処理も繋いである');
  ok(/settings\?\.isOpen/.test(main),
    '設定が開いている間は、後ろの画面を押してもマウスを掴まない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
