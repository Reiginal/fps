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
  // 撃ち合いの最中に自分が滑るたび銃声を食うと、相手の足音が聞こえなくなる
  ok(slide.peak < 0.7, `銃声より大きくならない (${slide.peak.toFixed(2)})`);
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
