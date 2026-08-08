// fps上限の升目（src/core/framegate.js）の検査。
//
// なぜ要るか: ここが緩いと120Hzの画面で全部の仕事が毎秒120回走って
// 熱が2倍になる（上限を入れる前の状態）。固すぎると60Hzの画面で
// 描ける回まで捨てて、ただカクつく。どちらも画面と温度計が無いと
// 分からない壊れ方なので、時刻の列を机の上で流して数える。
//
//   node tools/check-framecap.mjs
import { FrameGate } from '../src/core/framegate.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// refreshHzで1秒ぶんrAFが呼ばれた時に、何回描くかを数える
const drawsPerSecond = (gate, refreshHz, startMs = 0) => {
  let draws = 0;
  for (let i = 0; i < refreshHz; i++) {
    if (gate.shouldDraw(startMs + (i * 1000) / refreshHz)) draws++;
  }
  return draws;
};

console.log('\n[1] 上限60');
{
  const g = new FrameGate(60);
  ok(drawsPerSecond(g, 120) === 60, '120Hzの画面では1回おき＝毎秒60回');
  const g2 = new FrameGate(60);
  const d = drawsPerSecond(g2, 60);
  ok(d >= 59 && d <= 60, `60Hzの画面では全部通す（${d}回。丸めで59になる回は許す）`);
}

console.log('\n[2] 上限30（省エネ）');
{
  const g = new FrameGate(60);
  g.setCap(30);
  ok(g.hz === 30, '上限を覚えている（/logsのcapに載る値）');
  const d120 = drawsPerSecond(g, 120, 1000);
  ok(d120 >= 29 && d120 <= 30, `120Hzの画面で毎秒30回（${d120}回）`);
  g.setCap(30);
  const d60 = drawsPerSecond(g, 60, 3000);
  ok(d60 >= 29 && d60 <= 30, `60Hzの画面でも毎秒30回（${d60}回）`);
}

console.log('\n[3] タブ復帰で升目を引き直す');
{
  // 置いていかれた分を「連続で描いてよい」と誤解すると、
  // 復帰直後にしばらく上限なしで走る
  const g = new FrameGate(60);
  drawsPerSecond(g, 120);
  // 10秒後に戻ってきた。その直後の1秒も上限の回数で止まること
  const d = drawsPerSecond(g, 120, 11000);
  ok(d >= 59 && d <= 61, `復帰直後の1秒も上限どおり（${d}回）`);
}

console.log('\n[4] 自動画質の物差しがfps上限に付いてくる');
{
  /* 既定の45/55/58は上限60が前提。上限30のままだと「常に悪い窓」と誤解して、
     軽い端末でも最低画質まで転げ落ちる。実際にdt列を食わせて確かめる */
  const { AutoQuality } = await import('../src/core/autoquality.js');
  const run = (q, seconds, fps) => {
    let t = 0;
    while (t < seconds) { q.frame(1 / fps, true); t += 1 / fps; }
  };

  // 上限30に合わせた後、安定30fpsで段が動かない
  const q = new AutoQuality();
  q.setCap(30);
  let dropped = 0;
  q.onChange = () => { dropped++; };
  run(q, 60, 30);
  ok(q.rung === 0 && dropped === 0, '上限30で安定30fpsなら何も起きない');

  // 本当に重い（20fps）なら下がる
  run(q, 30, 20);
  ok(q.rung > 0, '上限30でも20fpsまで落ちれば下げる');

  // 60へ戻すと物差しも戻る（検算: 0.75/0.92/0.97×60 = 45/55/58）
  const q2 = new AutoQuality();
  q2.setCap(60);
  ok(q2._badFps === 45 && q2._goodFps === 55 && q2._goodMedianFps === 58,
    `60の物差しは元の45/55/58（今 ${q2._badFps}/${q2._goodFps}/${q2._goodMedianFps}）`);

  // 混ぜ物の確認: 上限を変えた瞬間、数え途中の窓は捨てる
  const q3 = new AutoQuality();
  run(q3, 2, 60);            // 窓の途中まで60fpsで数える
  q3.setCap(30);
  let moved = 0;
  q3.onChange = () => { moved++; };
  run(q3, 20, 30);           // その後は健康な30fps
  ok(moved === 0, '上限を変えた直後に、前の物差しの数えかけで誤判定しない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
