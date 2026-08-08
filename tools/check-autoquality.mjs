// 自動画質（src/core/autoquality.js）の検査。
//
// あの係が軽率だと、良い端末の絵まで下がる。臆病すぎると、重い端末で何も起きない。
// 一番まずいのは上げ下げの往復（画面がチカチカ切り替わる）。
// どれも画面を見ないと分からない壊れ方なので、dt列を机の上で食わせて全部叩く。
//
//   node tools/check-autoquality.mjs

import { AutoQuality } from '../src/core/autoquality.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// fpsの列を秒数ぶん流す助っ人。lowFpsを渡すと20フレームに1回だけ遅いフレームを混ぜる
// （「遅かった5%」を見ていることを確かめるため、全体を遅くしない）
const run = (q, seconds, fps, lowFps = 0) => {
  let t = 0;
  let i = 0;
  while (t < seconds) {
    const dt = lowFps && i % 20 === 19 ? 1 / lowFps : 1 / fps;
    q.frame(dt, true);
    t += dt;
    i++;
  }
};

console.log('\n[1] 60fpsで安定している端末では何も起きない');
{
  const q = new AutoQuality();
  let moved = 0;
  q.onChange = () => moved++;
  run(q, 120, 60);
  ok(q.rung === 0 && moved === 0, `2分回して段は${q.rung}のまま（動いた回数${moved}）`);
}

console.log('\n[2] 重い端末では段階的に下がる（一気に最低まで落ちない）');
{
  const q = new AutoQuality();
  const drops = [];
  q.onChange = (from, to) => drops.push(to);
  run(q, 14, 30);   // ウォームアップ5秒＋窓2枚ぶん
  ok(q.rung === 1, `最初の悪い窓2枚で1段だけ下がる（今${q.rung}段目）`);
  run(q, 60, 30);
  ok(q.rung === q.maxRung, `重いままなら最後は一番下へ（${q.rung}段目）`);
  const oneByOne = drops.every((r, i) => r === i + 1);
  ok(oneByOne, `1段ずつ順に下がっている（${drops.join('→')}）`);
}

console.log('\n[3] 遅かった5%を見ている（平均では見ない）');
{
  const q = new AutoQuality();
  // 60fpsが続くが、20フレームに1回だけ20fps相当のつっかえが混ざる端末。
  // 平均は57fps相当で「問題なし」に見えるが、体感はカクカクしている
  run(q, 30, 60, 20);
  ok(q.rung > 0, `時々つっかえる端末でも下がる（${q.rung}段目）`);
}

console.log('\n[4] 一瞬のスパイクでは下げない');
{
  const q = new AutoQuality();
  run(q, 10, 60);
  // 1秒だけ重い（読み込みや裏アプリの一瞬の引っかかり）。悪い窓は1枚しかできない
  run(q, 1, 20);
  run(q, 20, 60);
  ok(q.rung === 0, `一瞬の引っかかりでは動かない（${q.rung}段目）`);
}

console.log('\n[5] 上げ直しは臆病に');
{
  const q = new AutoQuality();
  run(q, 14, 30);            // 1段下がる
  ok(q.rung === 1, `まず1段下がる（${q.rung}段目)`);
  run(q, 40, 60);            // 良いが、下げてから60秒はまだ
  ok(q.rung === 1, `下げてから60秒は上げない（${q.rung}段目）`);
  run(q, 40, 60);            // 60秒＋良い30秒が揃う
  ok(q.rung === 0, `60秒経って良さが30秒続いたら1段だけ戻す（${q.rung}段目）`);
}

console.log('\n[6] 上げてすぐ落ちた段は、そのセッションではもう上げない');
{
  const q = new AutoQuality();
  run(q, 14, 30);            // 1段下がる
  run(q, 80, 60);            // 上げ直し（0段目へ）
  ok(q.rung === 0, `一度は上がる（${q.rung}段目）`);
  run(q, 9, 30);             // 上げた直後にまた重い → 1段下がる＋この上は塞ぐ
  ok(q.rung === 1, `また下がる（${q.rung}段目）`);
  run(q, 200, 60);           // どれだけ良くても
  ok(q.rung === 1, `塞いだ段へは二度と上げない（${q.rung}段目のまま）`);
}

console.log('\n[7] 切ったら動かない・メニューの数字は混ぜない');
{
  const q = new AutoQuality();
  q.disable();
  run(q, 60, 20);
  ok(q.rung === 0, `切っている間は何が来ても動かない（${q.rung}段目）`);

  const q2 = new AutoQuality();
  // メニュー（active=false）で重くても数えない
  for (let i = 0; i < 600; i++) q2.frame(1 / 20, false);
  run(q2, 4, 20);   // 戻った直後はウォームアップで捨てる
  ok(q2.rung === 0, `メニューの重さと戻り直後は数えない（${q2.rung}段目）`);
}

console.log('\n[8] main.jsと表の繋ぎ');
{
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/autoQ\?\.frame\(dt, this\.state === 'playing'\)/.test(main),
    '遊んでいる間だけ数えている');
  ok(/_applyRung\(/.test(main), '段を絵へ落とす口がある');
  ok(/key\.startsWith\('gfx'\) && key !== 'gfxAuto'/.test(main),
    '画質を手で触ったら自動が切れる');
  ok(/rung: this\.autoQ\?\.enabled \? this\.autoQ\.rung : null/.test(main),
    'どこまで下げたかが/logsの報告に乗る');
}

console.log('\n[段の表] 段が進むほど必ず軽くなる');
{
  /* なぜ見るか: 既定を軽くした時に「既定と同じ内容の段」が空回りになる事故が
     実際に起きた（既定85%の頃に段1=85%、既定AO切りなのに段3=AO切り。
     5段のうち2段が何もせず、一番効く段まで最短32秒のうち16秒がただの待ち）。
     表(gfxrungs.js)と既定(settings.js)は別ファイルなので、
     片方だけ変えるとまた空回りが生まれる。ここで突き合わせる。

     **既定が最低限になってからは、段の主な客は「絵を盛った人」。**
     既定のまま遊ぶ人には下げ代がほとんど無いので、
     「盛った人には全段効く」＋「既定の人にも最後の段は効く」を見る形にする */
  const { MAX_RUNG, rungValues } = await import('../src/core/gfxrungs.js');
  const { loadSettings } = await import('../src/core/settings.js');
  // 既定の設定＝空のlocalStorageで読んだ値
  globalThis.localStorage = {
    getItem: () => null, setItem: () => {}, removeItem: () => {},
  };
  const defaults = loadSettings();
  const weight = (a) => JSON.stringify(a);

  // (1) 絵を盛った人には、どの段も何かを削る
  const rich = { ...defaults, gfxScale: 1, gfxAo: true, gfxBloom: true, gfxShadow: '高' };
  let prev = rungValues(rich, 0);
  ok(weight(prev) === weight({ scale: 1, ao: true, bloom: true, shadow: '高' }),
    '段0は設定どおり（盛った人の絵をそのまま出す）');
  for (let r = 1; r <= MAX_RUNG; r++) {
    const cur = rungValues(rich, r);
    ok(weight(cur) !== weight(prev), `盛った設定で段${r}は段${r - 1}から何かが変わる`);
    prev = cur;
  }

  // (2) どちらの設定でも、段が進んで重くなる項目が1つも無い
  for (const [name, base] of [['既定', defaults], ['盛った設定', rich]]) {
    let p = rungValues(base, 0);
    let bump = 0;
    for (let r = 1; r <= MAX_RUNG; r++) {
      const c = rungValues(base, r);
      if (c.scale > p.scale) bump++;
      if (!p.ao && c.ao) bump++;
      if (!p.bloom && c.bloom) bump++;
      if (p.shadow === '低' && c.shadow !== '低') bump++;
      p = c;
    }
    ok(bump === 0, `${name}で、段が進んで重くなる項目が無い`);
  }

  // (3) 既定のまま遊ぶ人にも、最後の段だけは効く（逃げ道が塞がっていない）
  const d0 = rungValues(defaults, 0);
  const dLast = rungValues(defaults, MAX_RUNG);
  ok(dLast.scale < d0.scale,
    `既定でも最後の段で倍率が下がる（${d0.scale}→${dLast.scale}）`);
}

console.log('\n[段の記憶] 前回落ち着いた段を覚えて、次の起動で使える');
{
  const { loadSavedRung, saveRung } = await import('../src/core/settings.js');
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  ok(loadSavedRung() === 0, '何も無ければ0（全部入り）');
  saveRung(3);
  ok(loadSavedRung() === 3, '書いた段が読める');
  saveRung(0);
  ok(loadSavedRung() === 0 && !store.has('blackout.gfx.autorung'), '0は消す（メモを残さない）');
  store.set('blackout.gfx.autorung', 'でたらめ');
  ok(loadSavedRung() === 0, '壊れた値は0扱い');
  // main.js側の繋ぎ込み: 起動時の復元と、段が動いた時の保存
  const { readFileSync } = await import('node:fs');
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/loadSavedRung\(\)/.test(mainSrc), '起動時に読んでいる');
  ok(/gfxAuto && this\.autoQ\.enabled/.test(mainSrc), '自動が入っている時だけ復元する');
  ok(/saveRung\(to\)/.test(mainSrc), '段が動いた時に書いている');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
