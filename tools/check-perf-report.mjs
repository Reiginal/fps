// 重さの報告（perf）が実際に届く形になっているかの検査。
//
// なぜ要るか: 重さを測る仕組みは最初から作ってあったのに、
// **一度も/logsへ届いていなかった。** _flushStats()がfpsの標本を捨てた後に
// _reportPerf()を呼ぶ順になっていて、毎回「標本が少なすぎる」で帰っていた。
// さらにサーバー側でも、reportRecordで受けたcalls/tris/scale/rungを
// logs.add()へ書き忘れていて、届いたとしても表に出なかった。
// **二重に壊れていて、どちらも「作っただけで届くのを確かめなかった」のが原因。**
// ここでは「送る順番」「1分の束の中身」「受け口」「表への通り道」を全部見る。
//
//   node tools/check-perf-report.mjs
import { readFileSync } from 'node:fs';
import { PerfSegments } from '../src/core/perfsegments.js';
import { reportRecord } from '../server/report.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

console.log('\n[1] 送る順番: 標本を捨てる前に送っている');
{
  // _flushStats()の中身を切り出して、先頭側で_reportPerf()を呼んでいるかを見る。
  // 順番が逆（標本を捨ててから送る）だと、送る物が毎回空になる
  const m = mainSrc.match(/_flushStats\(\)\s*\{([\s\S]*?)\n {2}\}/);
  ok(!!m, '_flushStats()が見つかる');
  const bodyText = m?.[1] ?? '';
  const callAt = bodyText.indexOf('this._reportPerf()');
  ok(callAt >= 0, '_flushStats()の中で_reportPerf()を呼んでいる');
  // sessionの早期returnより前に呼ぶこと。後ろだと「戦績が空の回」
  // （観戦だけして戻った等）の重さが送られない
  const guardAt = bodyText.indexOf('if (!Object.values(this.session)');
  ok(guardAt < 0 || (callAt >= 0 && callAt < guardAt), '戦績が空でも送る位置にある（早期returnより前）');
  // _flushStatsが標本のリングを作り直していない（捨てるのは_reportPerfの仕事）。
  // ここで捨てると、また「送る前に捨てる」に戻ってしまう
  ok(!bodyText.includes('new Float64Array'), '_flushStats()は標本を捨てない');

  // _reportPerf()の単独呼び出しが残っていない。
  // 呼び出しが2系統あると、また「片方だけ順番が逆」が起きる
  const calls = [...mainSrc.matchAll(/this\._reportPerf\(\)/g)].length;
  ok(calls === 1, `_reportPerf()の呼び出しは_flushStats()の中の1箇所だけ（今${calls}箇所）`);
}

console.log('\n[2] 1分の束: 中央値と遅い5%が正しく並ぶ');
{
  // 60fpsで3分遊んだ形。1/60秒のdtを3分ぶん
  const seg = new PerfSegments();
  for (let i = 0; i < 60 * 180; i++) seg.frame(1 / 60, true);
  const s = seg.series();
  ok(s.fpsMins === '60,60,60', `60fpsで3分 → "60,60,60"（実際: "${s.fpsMins}"）`);

  // 前半60fps・後半30fpsの2分。垂れていく形が列に出る
  const seg2 = new PerfSegments();
  for (let i = 0; i < 60 * 60; i++) seg2.frame(1 / 60, true);
  for (let i = 0; i < 30 * 60; i++) seg2.frame(1 / 30, true);
  const s2 = seg2.series();
  ok(s2.fpsMins === '60,30', `前半60・後半30 → "60,30"（実際: "${s2.fpsMins}"）`);

  // 遅い5%: 60fpsの中に6%だけ20fpsのフレームを混ぜると、lowが20側に倒れる
  const seg3 = new PerfSegments();
  for (let i = 0; i < 60 * 60; i++) seg3.frame(i % 17 === 0 ? 1 / 20 : 1 / 60, true);
  const s3 = seg3.series();
  const low = parseInt(s3.lowMins, 10);
  ok(low <= 20, `6%が20fpsならlowは20以下（実際: ${low}）`);

  // 一時停止（active=false）の間は束の時計が進まない
  const seg4 = new PerfSegments();
  for (let i = 0; i < 60 * 30; i++) seg4.frame(1 / 60, true);
  for (let i = 0; i < 60 * 120; i++) seg4.frame(1 / 60, false); // 2分停止
  for (let i = 0; i < 60 * 30; i++) seg4.frame(1 / 60, true);
  ok(seg4.series().fpsMins === '60', `30秒+停止2分+30秒 → 束は1つ（実際: "${seg4.series().fpsMins}"）`);

  // 15秒未満の閉じかけの束は出さない（数十フレームで数字を名乗らせない）
  const seg5 = new PerfSegments();
  for (let i = 0; i < 60 * 10; i++) seg5.frame(1 / 60, true);
  ok(seg5.series().fpsMins === '', '10秒しか無ければまだ何も出さない');

  // resetで空に戻る
  seg.reset();
  ok(seg.series().fpsMins === '', 'reset()で空に戻る');

  // 61分でも束は60個で頭打ち（送る文字列が伸び続けない）
  const seg6 = new PerfSegments();
  for (let i = 0; i < 60 * 60 * 61; i++) seg6.frame(1 / 60, true);
  ok(seg6.series().fpsMins.split(',').length <= 60, '61分遊んでも束は60個まで');
}

console.log('\n[3] 受け口: 数字の列だけが通る');
{
  const body = (o) => JSON.stringify({ kind: 'perf', message: '描画の重さ', ...o });
  const r = reportRecord(body({ fpsMins: '60,58,52', lowMins: '55,44,38' }));
  ok(r?.fpsMins === '60,58,52', 'まともな列は通る');
  ok(r?.lowMins === '55,44,38', 'lowの列も通る');
  // 数字とカンマ以外は丸ごと捨てる。文字列で受ける唯一の数字列なので、
  // ここが緩いとログ画面へ好きな文字を流し込める口になる
  ok(reportRecord(body({ fpsMins: '60,<b>x</b>' }))?.fpsMins == null, 'タグ混じりは捨てる');
  ok(reportRecord(body({ fpsMins: '60,,58' }))?.fpsMins == null, '空の項が混ざった列は捨てる');
  ok(reportRecord(body({ fpsMins: ',60' }))?.fpsMins == null, 'カンマ始まりは捨てる');
  ok(reportRecord(body({ fpsMins: 60 }))?.fpsMins == null, '数値そのもの（文字列でない）は捨てる');
  const long = Array(300).fill('60').join(',');
  const rl = reportRecord(body({ fpsMins: long }));
  ok((rl?.fpsMins ?? '').length <= 200, '長すぎる列は切られる');
}

console.log('\n[4] 表への通り道: 受けた数字がlogs.addまで届く');
{
  // reportRecordで受けても、index.jsのlogs.add()に並べ忘れると表に出ない。
  // 実際にcalls/tris/scale/rungがここで落ちていた
  const m = indexSrc.match(/logs\.add\(rec\.kind,\s*\{([\s\S]*?)\}\);/);
  ok(!!m, 'logs.add()が見つかる');
  for (const k of ['calls', 'tris', 'scale', 'rung', 'fpsMins', 'lowMins']) {
    ok((m?.[1] ?? '').includes(`${k}: rec.${k}`), `${k} が表へ渡っている`);
  }
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
