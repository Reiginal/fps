// 音の質を数字で見張る検査。
//
// なぜ要るか: 「軽い」「ダサい」と言われるたびに勘で作り直して何度も外した。
// こちらは音を聴けないので、直した結果が良くなったのか悪くなったのかを
// 自分で判定できず、毎回まるごと運任せになっていた。
//
// 音は波なので数字で測れる。実際に測ったら軽さの正体がすぐ出た。
//   直す前のキル音 … 30〜250Hzの取り分が 0.0〜0.4%、長さ100〜315ms
//   爆発          … 同じ帯が 42%
// 低い音がまったく入っていなかった。人が「重い」と感じるのはこの帯なので、
// ここが空だと上で何を鳴らしても薄い通知音にしかならない。
//
// ここに置く下限は「これを割ったら確実に軽い」という線であって、
// 満たせば良い音になるという物ではない。良し悪しの最終判断は耳が持つ。
// この検査がやるのは、一度直した物が黙って元に戻るのを止めることだけ。
//
//   node tools/check-sound.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { OfflineCtx } from './offline-audio.mjs';
import { analyze, capture, SR } from './sound-measure.mjs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* 音の中身も毎回同じにする（乱数の種を固定。やり方はcheck-swarm.mjsと同じ）。
   audio.jsはノイズバッファや発音の揺らぎをMath.random()で作るので、
   素のままだと**この検査は毎回別の波形を測っている**ことになる。
   敷居の際にある項目が運で落ちて、9回に1回くらい理由なく赤くなっていた
   （2026-08-08に3回踏んで特定）。時々落ちる検査は最後には誰も見なくなる */
let _seed = 20260808;
Math.random = () => {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
};

// 自己検査で使う雑音は毎回同じ物にする。Math.randomで作ると中身が毎回変わり、
// 測った重心が729〜748Hzの間で揺れて、敷居のすぐ上と下を行き来した。
// 測定器が正しいかを見る検査が、日によって通ったり落ちたりするのでは意味がない
const seeded = (n, seed = 1) => {
  const out = new Float32Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x / 0x3fffffff) - 1;
  }
  return out;
};

/* ------------------------------------------------- まず測定器を疑う */

// この検査は全部「測った数字」を根拠にする。測定器が壊れていたら、
// 下の判定は全部もっともらしい嘘になる。答えの分かっている音を先に通す
console.log('\n[1] 測定器の自己検査');
{
  // 440Hzのサイン波。山が440Hzに出て、エネルギーがその帯に集まっていること
  const ctx = new OfflineCtx(SR);
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.value = 440;
  const g = ctx.createGain();
  g.gain.value = 0.8;
  o.connect(g); g.connect(ctx.destination);
  o.start(0); o.stop(1.0);
  const [L, R] = ctx.render(1.0);
  const i = analyze(L, R);
  ok(Math.abs(i.peaks[0] - 440) < 6, `山がぴったり440Hzに出る (${i.peaks[0]}Hz)`);
  ok(Math.abs(i.peak - 0.8) < 0.02, `振幅0.8がそのまま出る (${i.peak.toFixed(3)})`);
  ok(i.bands[2].pct > 80, `250〜800Hzの帯に集まる (${i.bands[2].pct.toFixed(1)}%)`);
  // 重心は全部の桁を足して出すので、微細な床のぶんだけ必ず実際より高く出る。
  // 440Hzの純音でも552Hzと読む。絶対値ではなく、上下の比較に使う数字
  ok(i.centroid < 700, `重心が実際の高さの近くにある (${i.centroid.toFixed(0)}Hz)`);
}
{
  // 2つの音を離して置く。山が両方拾えること＝周波数の対応がずれていないこと
  const ctx = new OfflineCtx(SR);
  for (const f of [300, 3000]) {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.value = 0.4;
    o.connect(g); g.connect(ctx.destination);
    o.start(0); o.stop(1.0);
  }
  const [L, R] = ctx.render(1.0);
  const i = analyze(L, R);
  const near = (hz) => i.peaks.some((p) => Math.abs(p - hz) < 15);
  ok(near(300) && near(3000), `300Hzと3000Hzの山を両方拾う (${i.peaks.join(', ')})`);
}
{
  // ノイズを200Hzで切る。1段のフィルタは1オクターブで12dBしか落ちないので、
  // 上に半分近く残るのが正しい。「低音が全部」にはならない
  const ctx = new OfflineCtx(SR);
  const buf = ctx.createBuffer(1, SR);
  buf.getChannelData(0).set(seeded(SR));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 200;
  src.connect(lp); lp.connect(ctx.destination);
  src.start(0); src.stop(1.0);
  const [L, R] = ctx.render(1.0);
  const i = analyze(L, R);
  ok(i.lowPct > 45, `低音が主役になる (${i.lowPct.toFixed(1)}%)`);
  ok(i.centroid < 700, `重心が下がる (${i.centroid.toFixed(0)}Hz)`);
}
{
  // 逆向き。5kHzより上だけ残したら低音は消える
  const ctx = new OfflineCtx(SR);
  const buf = ctx.createBuffer(1, SR);
  buf.getChannelData(0).set(seeded(SR, 7));
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 5000;
  src.connect(hp); hp.connect(ctx.destination);
  src.start(0); src.stop(1.0);
  const [L, R] = ctx.render(1.0);
  const i = analyze(L, R);
  ok(i.lowPct < 2, `5kHzで切ったノイズに低音は残らない (${i.lowPct.toFixed(1)}%)`);
  ok(i.centroid > 6000, `重心が上へ行く (${i.centroid.toFixed(0)}Hz)`);
}

/* ------------------------------------------------------ 実際の音を測る */

const { KILL_TUNE } = await import('../src/core/audio.js');

console.log('\n[2] キル音');
// 下限の根拠:
//   低音25%以上 … 直す前は0.0〜0.4%で「軽い」と言われた。ここが空だと薄い通知音になる
//   長さ250ms以上 … 直す前は最短102ms。短いと「ピッ」で終わって手応えが残らない
//   重心700Hz以下 … 鐘(747〜931Hz)で「まだ甲高い」と言われた。それより下
//   音量0.55〜0.95 … 1.0に届くと波の頭が潰れて割れる
{
  const m = await capture((a) => a.kill(false));
  ok(
    m.lowPct > 25 && m.lowPct < 80 && m.lenMs > 250 && m.centroid < 700
      && m.peak > 0.55 && m.peak < 0.95,
    `低音${m.lowPct.toFixed(0)}% 長さ${m.lenMs.toFixed(0)}ms `
    + `重心${m.centroid.toFixed(0)}Hz 音量${m.peak.toFixed(2)}`,
  );
  // 「デデン」は低い打点が2つ。帯の取り分や重心だけ見ていても、
  // 1発しか鳴っていない物と区別が付かない。形そのものを数える
  ok(
    m.hits === KILL_TUNE.hits && m.gapMs > 70 && m.gapMs < 220,
    `打点${m.hits}発 間隔${m.gapMs.toFixed(0)}ms（狙いは${KILL_TUNE.hits}発）`,
  );
  // 2発目が本命。圧縮器の戻りが打点の間隔より長かった時は、
  // 2発目だけ半分の大きさになっていた
  ok(
    m.hitLevels[1] > 0.7,
    `2発目が1発目に潰されていない (1発目${m.hitLevels[0].toFixed(2)} / `
    + `2発目${m.hitLevels[1].toFixed(2)})`,
  );
}
{
  // 頭に当てて倒した時は少し高くする。同じ音の音量違いでは差が伝わらない
  const body = await capture((a) => a.kill(false));
  const head = await capture((a) => a.kill(true));
  ok(head.centroid > body.centroid * 1.05,
    `頭で倒した時は音が上がる (${body.centroid.toFixed(0)} → ${head.centroid.toFixed(0)}Hz)`);
}

console.log('\n[2.5] 自分が倒れた音');
/* 「死んだ時の音がチープすぎる」と言われて測ったら、こうなっていた。
 *
 *   超低 33.6% ／ 低 7.0% ／ **中低 2.2%** ／ 中 19.2% ／ **高 35.4%**
 *
 * **一番下と一番上しか無い。** 胴体（250〜800Hz）が空で、そのぶん
 * 3.1kHzの純音（耳鳴り）が全体の35%を占めて音の主役になっていた。
 * 純音は素材として一番安っぽく聞こえるので、それが主役だと全部が安く聞こえる。
 * 比較として爆発は 23.8 / 10.1 / 24.3 / 21.2 / 9.4 と満遍なく埋まっている。
 *
 * 下限の根拠:
 *   中低18%以上 … 直す前は2.2%。ここが空だと胴体の無い音になる
 *   高25%未満   … 直す前は35.4%で、純音が主役だった
 *   打点2つ     … 倒れるのは「崩れる」と「地面に着く」の2つの出来事。
 *                  1つしか鳴っていないと、何が起きたのか耳から分からない
 */
{
  const m = await capture((a) => a.playerDown(), { seconds: 2.0 });
  const mid = m.bands[2].pct;   // 250-800Hz
  const hi = m.bands[4].pct;    // 2.5k-7k
  ok(mid > 18, `胴体(250-800Hz)が入っている ${mid.toFixed(1)}%（直す前は2.2%）`);
  ok(hi < 14, `高い所が主役になっていない ${hi.toFixed(1)}%（直す前は35.4%）`);
  /* **純音（サイン波1本）を高い所に置かない。**
     35%から13%まで落としても「甲高いピューが不快」と言われた。
     音量の問題ではなく、純音そのものが耳につく。
     サイン波は自然界にほぼ無いので、小さくても耳が必ず拾い上げる。
     一番強い山が高い所にあると、どんな作り方でも「ピー」に寄る */
  ok(m.peaks[0] < 1500, `一番強い山が低い所にある ${m.peaks[0]}Hz（前は3100Hzの純音）`);
  ok(m.lowPct > 25 && m.lowPct < 70, `低音 ${m.lowPct.toFixed(0)}%`);
  ok(m.hits >= 2 && m.gapMs > 250 && m.gapMs < 800,
    `打点${m.hits}発 間隔${m.gapMs.toFixed(0)}ms（崩れる → 地面に着く）`);
  ok(m.peak > 0.55 && m.peak < 0.99, `音量 ${m.peak.toFixed(2)}（1.0に届くと割れる）`);
}

console.log('\n[3] 当たった時の音');
{
  const m = await capture((a) => a.hitmarker(false));
  ok(m.lowPct > 15, `胴に当てた音に低音がある (${m.lowPct.toFixed(1)}%)`);
  ok(m.peak > 0.3, `聞こえる音量が出ている (${m.peak.toFixed(2)})`);
  // ライフルは0.094秒に1発。これより長いと次の当たり音と重なって団子になる
  ok(m.lenMs < 130, `連射で重ならない長さ (${m.lenMs.toFixed(0)}ms)`);
}
{
  const m = await capture((a) => a.hitmarker(true));
  // 頭に当てた時は高くではなく鈍く鳴らす。前は矩形波2400Hzで耳に刺さっていた
  ok(m.centroid < 1400, `頭に当てた音は鈍い (重心${m.centroid.toFixed(0)}Hz)`);
  ok(m.lowPct > 30, `重さがある (${m.lowPct.toFixed(1)}%)`);
}

// 銃声は武器ごとに設定が違う。ここで作った値ではなく、実際に鳴っている
// weapons.jsの設定をそのまま使う。作り話の設定で測っても意味がない
const { WEAPONS } = await import('../src/player/weapons.js');
const GUNS = WEAPONS.filter((w) => w.sound && !w.melee);

console.log('\n[4] 銃声');
for (const w of GUNS) {
  const m = await capture((a) => a.gunshot(w.sound, null, null));
  // 7kHzより上が主役になった音は銃声ではなく「サーッ」という雨に聞こえる。
  // 直す前はライフルでここが35.2%あった
  const hi = m.bands[5].pct;
  ok(
    hi < 20 && m.lowPct > 14 && m.centroid < 3600,
    `${w.name} … 7kHz以上${hi.toFixed(1)}% 低音${m.lowPct.toFixed(1)}% `
    + `重心${m.centroid.toFixed(0)}Hz`,
  );
}

console.log('\n[4.5] 狙撃銃が一番重い1発になっているか');
/* 遊んで「銃声もっとかっこよくして欲しい。1発のプレミア感というか、派手に」と
   言われた所。**言われた言葉は測れないが、言われた中身は測れる。**

   1発が重い銃を数字にすると3つになる:
     ・低い帯の取り分がライフルより明らかに多い（腹に来る層があるか）
     ・重心がライフルより低い（明るい破裂だけの音になっていないか）
     ・実効値がライフルより大きい（同じ距離で単純に大きいか）

   音量を上げるだけでは3つ目しか動かず、しかも山が出口の限界に当たって
   潰れる（＝大きくしたつもりが小さく聞こえる）。実際に一度そうなった。
   ここが赤くなったら、上げるのは音量ではなく低い層と尾のほう */
{
  /* **2挺に同じ乱数を配る。** 1発ごとの揺らぎ（音程・減衰・フィルタ）は
     ±3%あって、1回ずつ測って比べると差が揺らぎに埋もれる。
     実際、平均では狙撃のほうが重心が130Hz低いのに、1回ずつだと逆に出た。
     測る直前に種を同じ値へ戻せば、2挺が同じ揺らぎを受けるので、
     残った差は設定の差だけになる（測り直しても同じ数字が出る） */
  // 種を戻すのはこの節の中だけ。**後ろの節へ持ち越さない。**
  // 持ち越すと、下の[5]が測る山の高さが今までと別の乱数で測られることになり、
  // 直したつもりのない武器の数字が動いて読めなくなる
  const keep = _seed;
  const one = async (id) => {
    const w = GUNS.find((g) => g.id === id);
    _seed = 20260808;
    return capture((a) => a.gunshot(w.sound, null, null));
  };
  const rifle = await one('rifle');
  const sniper = await one('sniper');
  _seed = keep;
  ok(sniper.lowPct > rifle.lowPct + 5,
    `低音がライフルより多い（狙撃${sniper.lowPct.toFixed(1)}% / ライフル${rifle.lowPct.toFixed(1)}%）`);
  ok(sniper.centroid < rifle.centroid,
    `重心が低い（狙撃${sniper.centroid.toFixed(0)}Hz / ライフル${rifle.centroid.toFixed(0)}Hz）`);
  ok(sniper.rms > rifle.rms,
    `実効値が大きい（狙撃${sniper.rms.toFixed(3)} / ライフル${rifle.rms.toFixed(3)}）`);
  // 立ち上がりが鈍ると「重いだけの音」になる。派手さは鋭さと重さの両方から出る
  ok(sniper.attackMs <= rifle.attackMs + 0.3,
    `立ち上がりは鈍っていない（狙撃${sniper.attackMs.toFixed(1)}ms / ライフル${rifle.attackMs.toFixed(1)}ms）`);
}

console.log('\n[4.7] 形スキンの銃声が、見た目の通りに鳴っているか');
/* 「ドラゴンは低く鈍く、キャンディは可愛くポップに」と言われた所。
   **言われた言葉は測れないが、言われた中身は測れる。**

     低く鈍い … 低音の取り分が多く、重心が低く、高い所が少ない
     可愛くポップ … 低音がほとんど無く、短く、高い所が主役

   [4.5]と同じで、2挺に同じ乱数を配ってから比べる（揺らぎに埋もれるため） */
{
  const { gunTune, SHAPE_GUN } = await import('../src/core/audio.js');
  const base = GUNS.find((g) => g.id === 'rifle').sound;
  const keep = _seed;
  /* **窓の長さを揃える。**ここを長く取ると比べ物にならない。
     ドラゴンは尾が長い(1.05秒)ので、3秒で測ると尾ばかりが数字に乗り、
     尾の帯(700〜1250Hz)は低音ではないので**低くしたはずが「低音29%・重心2507Hz」**
     と出た（同じ音を2秒で測ると40.8%・2016Hz）。
     短い方（元の銃）の長さに合わせて、重なっている所だけを比べる。
     長さそのものは下で表を見る */
  const one = async (shape) => {
    _seed = 20260811;
    return capture((a) => a.gunshot(gunTune(shape, base), null, null));
  };
  const plain = await one(null);
  const dragon = await one('dragon');
  const cute = await one('cute');
  _seed = keep;
  const high = (m) => m.bands[4].pct + m.bands[5].pct;

  ok(dragon.lowPct > plain.lowPct + 8,
    `ドラゴンは低音が多い（${plain.lowPct.toFixed(1)}% → ${dragon.lowPct.toFixed(1)}%）`);
  ok(dragon.centroid < plain.centroid,
    `ドラゴンは重心が低い（${plain.centroid.toFixed(0)} → ${dragon.centroid.toFixed(0)}Hz）`);
  // 鈍いというのは「高い所が無い」こと。ここが動かないと低いだけの音になる
  ok(high(dragon) < high(plain),
    `ドラゴンは高い所が減っている（${high(plain).toFixed(1)}% → ${high(dragon).toFixed(1)}%）`);
  ok(SHAPE_GUN.dragon.tailDecay > base.tailDecay,
    `ドラゴンは尾が長い（${base.tailDecay} → ${SHAPE_GUN.dragon.tailDecay}秒）`);

  ok(cute.lowPct < 6, `キャンディは低音がほとんど無い（${cute.lowPct.toFixed(1)}%）`);
  ok(cute.centroid > plain.centroid,
    `キャンディは明るい（${plain.centroid.toFixed(0)} → ${cute.centroid.toFixed(0)}Hz）`);
  ok(high(cute) > high(plain) * 1.4,
    `キャンディは高い所が主役（${high(plain).toFixed(1)}% → ${high(cute).toFixed(1)}%）`);
  ok(SHAPE_GUN.cute.tailDecay < base.tailDecay && SHAPE_GUN.cute.bodyDecay < base.bodyDecay,
    `キャンディは短い（尾${base.tailDecay}→${SHAPE_GUN.cute.tailDecay}秒）`);
  /* **音程のある層はここだけ。**thumpは本来「腹に来る低音」だが、
     高い所から滑らせると玩具の発射音になる。可愛い音はここでしか作れない */
  ok(SHAPE_GUN.cute.thumpFrom > 800 && SHAPE_GUN.cute.thumpTo < SHAPE_GUN.cute.thumpFrom,
    `音程が上から下へ滑る（${SHAPE_GUN.cute.thumpFrom}→${SHAPE_GUN.cute.thumpTo}Hz）`);

  // 山は潰さない。可愛い音は小さくてよいので、大きくして割るのが一番もったいない
  ok(cute.peak < 0.9 && dragon.peak < 0.9,
    `割れていない（キャンディ${cute.peak.toFixed(2)} / ドラゴン${dragon.peak.toFixed(2)}）`);
  // 書いていない形は元の音のまま。形を足して音を書き忘れても黙って壊れない
  ok(gunTune('katana', base) === base, '書いていない形は元の銃の音のまま');

  /* ---- 2026-08-11に足した3つ。**元の銃が違うので、比べる相手も銃ごとに変える。**
     ドラゴンとキャンディはどちらもライフルに着けるので上は1つの基準で足りたが、
     こちらはショットガン・狙撃銃・拳銃に散っている。
     ライフルと比べると「元からそういう銃だった」が数字に混ざる */
  const other = async (shape, weaponId) => {
    const b = GUNS.find((g) => g.id === weaponId).sound;
    _seed = 20260811;
    const before = await capture((a) => a.gunshot(b, null, null));
    _seed = 20260811;
    const after = await capture((a) => a.gunshot(gunTune(shape, b), null, null));
    return { b, before, after };
  };

  /* ウエスタンは「木が響く」。**低音が増えて重心が下がり、高い所が減る。**
     ドラゴンと向きは同じだが、量が違う（あちらは鈍く、こちらは響く）ので、
     ここでは「元より」だけを見て、ドラゴンとの大小は見ない */
  {
    const { b, before, after } = await other('western', 'shotgun');
    ok(after.lowPct > before.lowPct,
      `ウエスタンは低音が増える（${before.lowPct.toFixed(1)}% → ${after.lowPct.toFixed(1)}%）`);
    ok(after.centroid < before.centroid,
      `ウエスタンは重心が下がる（${before.centroid.toFixed(0)} → ${after.centroid.toFixed(0)}Hz）`);
    ok(high(after) < high(before),
      `ウエスタンは高い所が減る（${high(before).toFixed(1)}% → ${high(after).toFixed(1)}%）`);
    ok(SHAPE_GUN.western.tailDecay > b.tailDecay,
      `ウエスタンは尾が長い（${b.tailDecay} → ${SHAPE_GUN.western.tailDecay}秒）`);
    ok(after.peak < 0.95, `ウエスタンが割れていない（${after.peak.toFixed(2)}）`);
  }

  /* アイスは「硬くて澄んでいる」。**元の狙撃銃が低くて大きい**（低音34.6%）ので、
     ここは減らす向き。キャンディと違って尾は残す
     （切ると乾いた破裂になって、氷の余韻が消える） */
  {
    const { b, before, after } = await other('ice', 'sniper');
    ok(after.lowPct < before.lowPct,
      `アイスは低音が減る（${before.lowPct.toFixed(1)}% → ${after.lowPct.toFixed(1)}%）`);
    ok(after.centroid > before.centroid,
      `アイスは重心が上がる（${before.centroid.toFixed(0)} → ${after.centroid.toFixed(0)}Hz）`);
    ok(high(after) > high(before),
      `アイスは高い所が増える（${high(before).toFixed(1)}% → ${high(after).toFixed(1)}%）`);
    // **尾を切っていないこと。** ここが0.2を割ると氷ではなく乾いた破裂になる
    ok(SHAPE_GUN.ice.tailDecay > 0.3 && SHAPE_GUN.ice.tailDecay < b.tailDecay,
      `アイスは余韻が残る（${b.tailDecay} → ${SHAPE_GUN.ice.tailDecay}秒）`);
    ok(after.peak < 0.95, `アイスが割れていない（${after.peak.toFixed(2)}）`);
  }

  /* サイバーは電子音。**キャンディと同じ層を逆向きに使う。**
     キャンディが1150→320で落とすのに対して、こちらは260→1500で上がる。
     ここが同じ向きになったら、2つは同じ系統の音になってしまう */
  {
    const { before, after } = await other('cyber', 'pistol');
    ok(SHAPE_GUN.cyber.thumpTo > SHAPE_GUN.cyber.thumpFrom,
      `サイバーは音程が下から上へ滑る（${SHAPE_GUN.cyber.thumpFrom}→${SHAPE_GUN.cyber.thumpTo}Hz）`);
    ok(SHAPE_GUN.cute.thumpTo < SHAPE_GUN.cute.thumpFrom,
      'キャンディとは滑る向きが逆（同じ層を別の音に使い分けている）');
    ok(after.centroid > before.centroid,
      `サイバーは明るい（${before.centroid.toFixed(0)} → ${after.centroid.toFixed(0)}Hz）`);
    ok(high(after) > high(before),
      `サイバーは高い所が増える（${high(before).toFixed(1)}% → ${high(after).toFixed(1)}%）`);
    // 真鍮が跳ねる音を切ってあること。入ると電子銃に聞こえない
    ok(SHAPE_GUN.cyber.mech === false, 'サイバーは機関部の音を切っている');
    ok(after.peak < 0.95, `サイバーが割れていない（${after.peak.toFixed(2)}）`);
  }

  /* ---- 各武器2つ目の音。**1つ目と分かれていること**が本題。
     見た目が2種類あって音が同じだと、着け替えた実感が半分になる。
     ここでは「同じ武器の1つ目と、測って別方向へ動いていること」を見る */
  {
    const pairs = [
      ['装甲', 'armor', 'ドラゴン', 'dragon', 'rifle'],
      ['桜', 'sakura', 'キャンディ', 'cute', 'rifle'],
      ['ヴェノム', 'venom', 'アイス', 'ice', 'sniper'],
      ['サイレンサー', 'suppressed', 'サイバー', 'cyber', 'pistol'],
    ];
    for (const [nA, a, nB, b, weapon] of pairs) {
      const base = GUNS.find((g) => g.id === weapon).sound;
      _seed = 20260811;
      const plainM = await capture((x) => x.gunshot(base, null, null));
      _seed = 20260811;
      const mA = await capture((x) => x.gunshot(gunTune(a, base), null, null));
      _seed = 20260811;
      const mB = await capture((x) => x.gunshot(gunTune(b, base), null, null));

      /* **ここが2026-08-11に足した所。元の銃と比べる。**
         「ベノムとかって銃声全く変わってないよね」と言われて、その通りだった。

         それまでこの節は「1つ目と2つ目が違うか」しか見ていなかった。
         ヴェノムは胴165・尾1.30に置いてあって、アイス(胴520)とは充分離れていたので
         **検査は通っていた。** ところが元の狙撃銃が胴180・尾1.50で、
         そこから少ししか動いていなかったので、遊ぶ側には何も変わって聞こえない。

         **「兄弟と違う」は「元と違う」を保証しない。** 両方見る */
      ok(Math.abs(mA.centroid - plainM.centroid) > 200
        || Math.abs(mA.lowPct - plainM.lowPct) > 8,
      `${nA}は元の${weapon}と違う（重心 ${plainM.centroid.toFixed(0)}→${mA.centroid.toFixed(0)}Hz`
        + ` / 低音 ${plainM.lowPct.toFixed(1)}→${mA.lowPct.toFixed(1)}%）`);
      /* **3つの軸のどれかで離れていれば別の音。**

         最初は重心だけで200Hzを線にしていたが、
         **ライフルの形違いが4つになった時に窓が足りなくなった**
         （ドラゴン1919・キャンディ3224・桜2706・元2224が並ぶと、
           装甲を置ける帯が80Hzしか残らない）。

         重心が近くても、**尾の長さが5倍違えば耳には別の音**として届く
         （鉄の箱を叩いた音と鐘の音は、高さが同じでも余韻で分かれる）。
         低音の取り分も同じで、腹に来る量が違えば別の音になる。

         200Hz / 8% / 1.5倍 は、どれも「並べて鳴らした時に言える差」の線 */
      const tailA = gunTune(a, base).tailDecay;
      const tailB = gunTune(b, base).tailDecay;
      const apart = Math.abs(mA.centroid - mB.centroid) > 200
        || Math.abs(mA.lowPct - mB.lowPct) > 8
        || Math.max(tailA, tailB) / Math.min(tailA, tailB) > 1.5;
      ok(apart,
        `${nA}と${nB}は別の音（重心 ${mA.centroid.toFixed(0)}/${mB.centroid.toFixed(0)}Hz`
        + ` 低音 ${mA.lowPct.toFixed(1)}/${mB.lowPct.toFixed(1)}%`
        + ` 尾 ${tailA}/${tailB}秒）`);
      ok(mA.peak < 0.95, `${nA}が割れていない（${mA.peak.toFixed(2)}）`);
    }

    /* 1つ目の3つも同じ目で見る。**あちらは元の銃と比べて作ったので通るはず**だが、
       通ることを確かめておかないと「見ていない」のと同じ */
    for (const [name, shape, weapon] of [
      ['ウエスタン', 'western', 'shotgun'],
      ['アイス', 'ice', 'sniper'],
      ['サイバー', 'cyber', 'pistol'],
    ]) {
      const base = GUNS.find((g) => g.id === weapon).sound;
      _seed = 20260811;
      const p0 = await capture((x) => x.gunshot(base, null, null));
      _seed = 20260811;
      const p1 = await capture((x) => x.gunshot(gunTune(shape, base), null, null));
      ok(Math.abs(p1.centroid - p0.centroid) > 200 || Math.abs(p1.lowPct - p0.lowPct) > 8,
        `${name}も元の${weapon}と違う（重心 ${p0.centroid.toFixed(0)}→${p1.centroid.toFixed(0)}Hz`
        + ` / 低音 ${p0.lowPct.toFixed(1)}→${p1.lowPct.toFixed(1)}%）`);
    }
    // サイバーは真鍮が跳ねる音を切ってある（電子銃に聞こえないので）
    ok(SHAPE_GUN.cyber.mech === false, 'サイバーは機関部の音を切っている');
    /* **音程のある層はサイバーだけの手。** 他の拳銃で同じ向きに滑らせると
       同じ系統の音になって、拳銃の形が区別できなくなる */
    ok(SHAPE_GUN.suppressed.thumpTo < SHAPE_GUN.suppressed.thumpFrom,
      'サイレンサーは音程を上げない（上がるのはサイバーだけ）');
    /* **サイレンサーだけは音量で分ける。** 他の全部が「大きく・鋭く」を
       競っているので、小さいことがそのまま商品になる */
    ok(SHAPE_GUN.suppressed.volume < 0.5,
      `サイレンサーは一番静か（音量${SHAPE_GUN.suppressed.volume}）`);
  }

  /* ---- 同じ武器の形が3つ以上になったので、**全部の組を突き合わせる。**

     上の判定は「兄弟の1組」しか見ていない。ライフルは形違いが4つあるので、
     組は6つある。**装甲(重心2658)と桜(2706)は48Hzしか離れていない**が、
     尾が0.22対1.10で5倍違うので別の音として通る。
     そこを見ていない判定だと、次に足した物が既にある物と丸かぶりでも通ってしまう。

     ここは**音を焼かずに、書いてある数字だけで見る。**
     焼くと1つ2〜3秒かかって、組の数だけ増えるとCIが伸びる
     （このrepoはCI30秒を画質の網羅より優先している）。
     破裂の帯と尾の長さは鳴り方をほぼ決めるので、この2つで足りる */
  {
    const { SHAPE_LIST } = await import('../src/net/protocol.js');
    const byWeapon = new Map();
    for (const sh of SHAPE_LIST) {
      if (!SHAPE_GUN[sh.id]) continue;   // 近接は銃声を持たない
      if (!byWeapon.has(sh.weapon)) byWeapon.set(sh.weapon, []);
      byWeapon.get(sh.weapon).push(sh);
    }
    for (const [weapon, list] of byWeapon) {
      const base = GUNS.find((g) => g.id === weapon).sound;
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = gunTune(list[i].id, base);
          const b = gunTune(list[j].id, base);
          const crackApart = Math.abs(a.crackFreq - b.crackFreq) > 500;
          const tailApart = Math.max(a.tailDecay, b.tailDecay)
            / Math.min(a.tailDecay, b.tailDecay) > 1.5;
          ok(crackApart || tailApart,
            `${weapon}: ${list[i].name}と${list[j].name}が離れている`
            + `（破裂 ${a.crackFreq}/${b.crackFreq}Hz 尾 ${a.tailDecay}/${b.tailDecay}秒）`);
        }
      }
    }
  }

  /* **形が全部そろっているか。** 見た目を足して音を書き忘れると、
     「ドラゴンだけ音が違って、他は同じ」という中途半端な状態になる。
     形違いの一覧(SHAPE_LIST)を持ってきて、全部に音があることを見る */
  {
    const { SHAPE_LIST } = await import('../src/net/protocol.js');
    const missing = SHAPE_LIST.filter((s) => !SHAPE_GUN[s.id])
      // 近接は銃声を持たない（振る音はSWING_TUNESが受け持つ）
      .filter((s) => s.weapon !== 'knife')
      .map((s) => s.name);
    ok(missing.length === 0,
      `形違いの銃は全部専用の銃声を持っている${missing.length ? ` ← ${missing.join('、')}が無い` : ''}`);

    /* **書き出す側にも全部並んでいるか。**
       tools/sound-lab.mjs に名前をべた書きしていた頃、
       後から足した形が**一度も測られないまま**になっていた
       （2026-08-12にリボルバーとソードオフで踏んだ。振る音でも同じ形で踏んだ）。
       測れない音は「ダサい」と言われた時に勘で直すことになる */
    const lab = readFileSync(new URL('../tools/sound-lab.mjs', import.meta.url), 'utf8');
    ok(/const SHAPE_ON = SHAPE_LIST/.test(lab),
      '銃声は表から引いて書き出している（名前のべた書きではない）');
  }
}

console.log('\n[5] 振り切れていないか');
// 山が1.0に届くと波の頭が平らに潰れて、迫力ではなく割れた音になる。
//
// これらの音は1発ごとに乱数で揺らしてあるので、1回測って0.8でも、
// 別の回は1.0を超えることがある。実際8回測った時は 0.65〜1.01 と割れていた。
// 「たまに割れる」は遊んでいる側から見れば壊れているのと同じなので、
// 何度か鳴らして一番大きく出た回で判定する
const REPEAT = 6;
const loud = [['爆発', (a) => a.explosion(null, null)]];
for (const w of GUNS) loud.push([w.name, (a) => a.gunshot(w.sound, null, null)]);
for (const [name, play] of loud) {
  let worst = 0;
  for (let k = 0; k < REPEAT; k++) worst = Math.max(worst, (await capture(play)).peak);
  ok(worst < 0.95, `${name} … ${REPEAT}回のうち一番大きい回で ${worst.toFixed(2)}`);
}

console.log('\n[6] 刃が当たった音が材質で分かれているか');
// 遊んで「ナイフを障害物にやったらカンカン鳴ってほしい」と言われた所。
// 元は肉でも鉄板でもコンクリでも同じ鈍い音で、何に当たったのか耳から分からなかった。
//
// 「カンカン」は数字で言うと、低音がほとんど無く高い所へ寄っていること。
// 逆に肉へ刺さる音は低音が主役でないといけない。
// この2つが逆転していないか、間に木とコンクリが挟まっているかを見る
{
  const got = {};
  for (const k of ['flesh', 'metal', 'wood', 'concrete']) {
    got[k] = await capture((a) => a.stab(null, null, k));
  }
  ok(
    got.metal.centroid > 2500,
    `金属は高い所で鳴る (重心${got.metal.centroid.toFixed(0)}Hz / 2500Hzより上)`,
  );
  ok(
    got.metal.lowPct < 8,
    `金属に低音の重さは無い (${got.metal.lowPct.toFixed(1)}% / 8%未満)`,
  );
  ok(
    got.flesh.lowPct > 40 && got.flesh.centroid < 900,
    `肉は低く鈍い (低音${got.flesh.lowPct.toFixed(1)}% 重心${got.flesh.centroid.toFixed(0)}Hz)`,
  );
  // 材質の間に差が出ているか。1つでも同じ所に来ていると作り分けた意味が無い。
  // 金属＞木＞コンクリ＞肉 の順に高くなる並びを崩さない
  const order = ['metal', 'wood', 'concrete', 'flesh'];
  let sorted = true;
  for (let i = 0; i + 1 < order.length; i++) {
    if (got[order[i]].centroid <= got[order[i + 1]].centroid) sorted = false;
  }
  ok(
    sorted,
    '金属＞木＞コンクリ＞肉 の順に高い ('
    + order.map((k) => `${k} ${got[k].centroid.toFixed(0)}Hz`).join(' / ') + ')',
  );
  // 壁を擦るたびに銃声より大きい音が出ると、耳が持たない。
  // 金属だけ出口のリミッターに突っ込んで0.9近くまで出ていたことがある
  let worst = 0;
  for (let k = 0; k < 4; k++) worst = Math.max(worst, (await capture((a) => a.stab(null, null, 'metal'))).peak);
  ok(worst < 0.7, `金属が銃声より大きくならない (4回のうち一番大きい回で ${worst.toFixed(2)})`);
}

console.log('\n[7] 滑り込みが「シュー」に聞こえるか');
/* **ここは2回外している。両方の外し方をそのまま線にしてある。**
 *
 *   1回目 … ノイズを帯域で切って鳴らしただけ
 *            重心5184Hz・低音11%・**7kHz超が26.9%**。砂嵐の音だった。
 *            耳障りの正体は高い所そのものではなく、7kHzより上の取り分
 *   2回目 … 低い唸りを足して重心905Hz・低音39%まで落とした
 *            重さは出たが「ズズッ」で、遊ぶ側が欲しかった
 *            「シュー！」からは遠かった（実際そう言われて作り直した）
 *
 * つまり**上へ行きすぎても下へ行きすぎても外れる。**
 * 欲しい音は「2.5〜7kHzが主役で、7kHzより上は薄く、下も少しは鳴っている」。
 * 足音との比較で線を引くのはやめた（あれは打点の音で、質が別物）。
 */
{
  const slide = await capture((a) => a.slide('dirt', null, null), { seconds: 1.4 });
  const hi = slide.bands[4].pct;      // 2.5k-7k
  const air = slide.bands[5].pct;     // 7k+
  ok(
    hi > 30,
    `擦れの帯(2.5-7kHz)が主役になっている (${hi.toFixed(1)}% / 30%より上。2回目の版は4.9%)`,
  );
  ok(
    air < 15,
    `7kHzより上が主役になっていない (${air.toFixed(1)}% / 15%未満。1回目の版は26.9%)`,
  );
  ok(
    slide.centroid > 2200 && slide.centroid < 4200,
    `高すぎず低すぎず (重心${slide.centroid.toFixed(0)}Hz / 2200〜4200Hz。1回目5184・2回目905)`,
  );
  // 体が地面に接した合図。完全に消えると、宙を切っているだけの音になる
  ok(
    slide.lowPct > 6,
    `下でも鳴っている (${slide.lowPct.toFixed(1)}% / 6%より上)`,
  );
  // 打点が並ぶと足音の早回しに聞こえる。滑りは打点が1つ（落ちる所）だけ
  ok(
    slide.hits <= 1,
    `打点が並んでいない (${slide.hits}回 / 1回まで)`,
  );
  /* 大きさは足音を基準にする。**「銃声より小さい」では緩すぎた。**
     山が0.48でも、生の信号が全開の2倍あって出口のリミッターを潰していると、
     山の高さの割にずっと大きく聞こえるうえ、鳴っている間ほかの音が引っ込む。
     実際それで「うるさい」と言われた。山の数字だけでは気づけない
     （1.0→0.22まで絞っても山は0.48→0.40しか動かない）。

     足音と同じ高さに収まっていれば、リミッターには触れていない。
     自分が滑るたびに相手の足音が聞こえなくなる、という形にもならない */
  const step = await capture((a) => a.footstep(0.8, 'dirt', null, null), { seconds: 1.0 });
  ok(
    slide.peak < step.peak * 1.15,
    `足音より大きくならない (滑り${slide.peak.toFixed(2)} / 足音${step.peak.toFixed(2)})`,
  );
}

console.log('\n[8] 買えた合図が、ロビー入室と混ざらないか');
/* 画面を見ていない人に気づかせる音は、今この2つだけ。
   どちらも「短い・高い・上がる」なので、作りが近いと**同じ音に聞こえる。**
   買った後に「誰か入ってきた」と思われたら合図として失敗している。
   耳で分かる違いは尾の長さと金属の当たる音なので、そこに線を引く */
{
  const buy = await capture((a) => a.purchase(), { seconds: 0.9 });
  const join = await capture((a) => a.lobbyJoin(), { seconds: 0.8 });
  ok(buy.lenMs > join.lenMs * 1.3,
    `尾が残る (買えた${buy.lenMs.toFixed(0)}ms / 入室${join.lenMs.toFixed(0)}ms の1.3倍より上)`);
  /* 硬貨の当たる音。ここが薄いと、ただの高い和音になって電子音に戻る。
     **下限は2026-08-11に「入室の2倍」から「50%以上」へ上げた。**
     前の音（三角波と正弦波の分散和音）はここが25.7%で、入室の2倍は超えていたので通っていた。
     それでも「古すぎる」と言われたので、線が緩かった。

     正体は**ノイズが1粒も無かったこと。** 純粋な発振器だけで組むと、
     どう並べても8ビットの効果音になる。当たった瞬間の広い帯のノイズを足したら
     25.7%→75.9%になった。50%を割ったら、またノイズが抜けたと考えていい */
  ok(buy.bands[4].pct > 50,
    `金属の帯(2.5-7kHz)が主役 (買えた${buy.bands[4].pct.toFixed(1)}% / 入室${join.bands[4].pct.toFixed(1)}%。50%以上)`);
  /* 明るすぎないこと。**本物の硬貨は2〜4kHzで鳴る。**
     一度 base*1.9 に帯域を置いて重心5374Hzまで上げてしまい、
     硬貨ではなく「ガラスの粒」に近い音になった。base*1.35 で4065Hzに収まる */
  ok(buy.centroid < 4600,
    `明るすぎない (重心${buy.centroid.toFixed(0)}Hz / 4600Hz未満)`);
  /* 場所を持たない合図なので、戦闘中の音より大きくしない。
     滑り込みで踏んだのと同じ形（山が低くても生の信号が全開を超えると
     出口のリミッターを潰して、その間ほかの音が引っ込む） */
  ok(buy.peak < 0.5, `振り切れていない (山${buy.peak.toFixed(2)} / 0.5未満)`);
  // 低音は要らない。ここが太ると、遠くの爆発と紛らわしくなる
  ok(buy.lowPct < 5, `低い所で鳴っていない (${buy.lowPct.toFixed(1)}% / 5%未満)`);
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
