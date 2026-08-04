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

const { KILL_SOUNDS, KILL_TUNE } = await import('../src/core/audio.js');

console.log('\n[2] キル音 … 出発点');
// 下限の根拠:
//   低音25%以上 … 直す前は0.0〜0.4%で「軽い」と言われた。ここが空だと薄い通知音になる
//   長さ250ms以上 … 直す前は最短102ms。短いと「ピッ」で終わって手応えが残らない
//   音量0.55〜0.95 … 聴き比べる時、音量差があると音の質より大きさで選ばれる。
//                    1.0に届くと波の頭が潰れて割れる
// 重心には上限を置かない。明るい出発点をわざと1つ入れてあるので、
// 全部を低い側へ縛ると選ぶ幅がなくなる
for (let i = 0; i < KILL_SOUNDS.length; i++) {
  const s = KILL_SOUNDS[i];
  const m = await capture((a) => { a.killVariant = i; a.killTune = null; a.kill(false); });
  ok(
    m.lowPct > 25 && m.lenMs > 250 && m.peak > 0.55 && m.peak < 0.95,
    `${s.name} … 低音${m.lowPct.toFixed(0)}% 長さ${m.lenMs.toFixed(0)}ms `
    + `重心${m.centroid.toFixed(0)}Hz 音量${m.peak.toFixed(2)}`,
  );
}
// 出発点は形が違うから並べる意味がある。打点の数が宣言どおりか見る
for (let i = 0; i < KILL_SOUNDS.length; i++) {
  const s = KILL_SOUNDS[i];
  const want = s.cfg.hits ?? KILL_TUNE.hits;
  const m = await capture((a) => { a.killVariant = i; a.killTune = null; a.kill(false); });
  ok(m.hits === want, `${s.name} … 打点${m.hits}発（狙いは${want}発）`);
}

console.log('\n[2b] つまみが本当に効くか');
// ここが今回の本体。作った側が音を聴けないので、遊ぶ側が自分で回して
// 決められるようにつまみを付けた。動かないつまみを渡したら本末転倒なので、
// 「上げた時に狙った向きへ数字が動くか」を1本ずつ確かめる
const withTune = (tune) => capture((a) => {
  a.killVariant = 0;
  a.killTune = tune;
  a.kill(false);
});
const base = await withTune(null);

{
  const hi = await withTune({ pitch: 2.0 });
  const lo = await withTune({ pitch: 0.6 });
  ok(
    hi.centroid > base.centroid * 1.3 && lo.centroid < base.centroid * 0.85,
    `高さ … 上げると高く下げると低い (${lo.centroid.toFixed(0)} ← ${base.centroid.toFixed(0)} → ${hi.centroid.toFixed(0)}Hz)`,
  );
}
{
  const wide = await withTune({ gap: 0.28 });
  const tight = await withTune({ gap: 0.07 });
  // 詰めた側も2発のままであること。間隔0ms＝2発目が消えて1発になった、を通さない
  ok(
    wide.gapMs > base.gapMs * 1.4 && tight.hits === 2 && tight.gapMs < base.gapMs * 0.7,
    `間隔 … 詰めても2発のまま近づく (${tight.gapMs.toFixed(0)}ms/${tight.hits}発 ← `
    + `${base.gapMs.toFixed(0)} → ${wide.gapMs.toFixed(0)}ms)`,
  );
}
{
  const long = await withTune({ tail: 2.5 });
  const short = await withTune({ tail: 0.35 });
  ok(
    long.lenMs > base.lenMs * 1.3 && short.lenMs < base.lenMs * 0.8,
    `余韻 … 伸ばすと長く詰めると短い (${short.lenMs.toFixed(0)} ← ${base.lenMs.toFixed(0)} → ${long.lenMs.toFixed(0)}ms)`,
  );
}
{
  const heavy = await withTune({ weight: 1.8 });
  const light = await withTune({ weight: 0 });
  ok(
    heavy.lowPct > base.lowPct && light.lowPct < base.lowPct * 0.62,
    `低音 … 上げると増え0で消える (${light.lowPct.toFixed(0)} ← ${base.lowPct.toFixed(0)} → ${heavy.lowPct.toFixed(0)}%)`,
  );
}
{
  const bright = await withTune({ edge: 1.8 });
  const dull = await withTune({ edge: 0 });
  ok(
    bright.centroid > dull.centroid * 1.15,
    `芯 … 上げると明るくなる (${dull.centroid.toFixed(0)} → ${bright.centroid.toFixed(0)}Hz)`,
  );
}
{
  const one = await withTune({ hits: 1 });
  const three = await withTune({ hits: 3, gap: 0.12 });
  ok(one.hits === 1 && three.hits === 3, `打点の数 … 1発と3発が作れる (${one.hits}発 / ${three.hits}発)`);
}
{
  // どのつまみをどこまで回しても割れないこと。
  // 遊ぶ側が端まで回した時に音が壊れるなら、渡した意味がない
  let worst = 0;
  const ends = [
    { pitch: 2.2, weight: 1.8, edge: 1.8, drive: 4.5, tail: 2.6, hits: 3 },
    { pitch: 0.5, weight: 1.8, edge: 1.8, drive: 4.5, hits: 3, gap: 0.06 },
    { pitch: 1, weight: 1.8, edge: 0, drive: 4.5, tail: 2.6 },
  ];
  for (const t of ends) worst = Math.max(worst, (await withTune(t)).peak);
  ok(worst < 0.99, `つまみを端まで回しても割れない (一番大きい回で ${worst.toFixed(2)})`);
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

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
