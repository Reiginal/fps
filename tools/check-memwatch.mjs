// メモリの見張り（src/core/memwatch.js）の検査。
//
// なぜ要るか: 2026-08-08、1人プレイの第3波でChromeにタブごと殺された。
// 原因を追ったが**メモリを1バイトも測っていなかった**ので何も出せなかった。
// 届いていたのは「fpsは32で5分間ずっと平ら」だけ。
//
// この見張りは「落ちる前に1行送る」ためにあるので、
// **黙っていること・出すのが1回だけであること**が本体になる。
// 毎秒出れば連投止めに捨てられて意味が消え、出なければ入れた意味が消える。
// どちらの壊れ方も画面には出ないので、ここで机上から全部叩く。
//
//   node tools/check-memwatch.mjs
import { readFileSync } from 'node:fs';
import { MemoryWatch } from '../src/core/memwatch.js';
import { reportRecord, reportLine, REPORT_KINDS } from '../server/report.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const MB = 1048576;
const GB = 1024 * MB;
// 描く物の底。地形128個＋武器まわりで、遊び始めはこのあたり
const BASE = 700;

console.log('\n[1] 限界に近づくまでは黙る');
{
  const w = new MemoryWatch();
  ok(w.sample(0.2 * GB, 4 * GB, BASE, 1) === null, '5%では何も言わない');
  ok(w.sample(1.5 * GB, 4 * GB, BASE, 1) === null, '37%でも言わない');
  ok(w.sample(2.3 * GB, 4 * GB, BASE, 1) === null, '57%でもまだ言わない（段は60%）');
}

console.log('\n[2] 段に届いたら知らせる。ただし同じ段では1回だけ');
{
  const w = new MemoryWatch();
  const first = w.sample(2.5 * GB, 4 * GB, BASE, 1);
  ok(first?.reason === 'heap', '62%で知らせる');
  ok(first?.pct === 63, `割合が入る（実際: ${first?.pct}%）`);
  ok(first?.used === 2560 && first?.limit === 4096, `MBで入る（実際: ${first?.used}/${first?.limit}MB）`);
  // ここが一番大事。毎秒出ると連投止め(3秒)に捨てられて、結局1件も残らない
  ok(w.sample(2.5 * GB, 4 * GB, BASE, 1) === null, '同じ所に居る間は黙る');
  ok(w.sample(2.9 * GB, 4 * GB, BASE, 1) === null, '同じ段の中で増えても黙る');
  ok(w.sample(3.3 * GB, 4 * GB, BASE, 1)?.reason === 'heap', '次の段(80%)まで来たらまた知らせる');
  ok(w.sample(3.8 * GB, 4 * GB, BASE, 1)?.reason === 'heap', 'その次の段(92%)でも知らせる');
  ok(w.sample(3.9 * GB, 4 * GB, BASE, 1) === null, '一番上の段を過ぎたら、もう言わない');
}

console.log('\n[3] 一気に飛んだら1行だけ（下の段を後から出さない）');
{
  const w = new MemoryWatch();
  const jump = w.sample(3.9 * GB, 4 * GB, BASE, 1);
  ok(jump?.reason === 'heap', 'いきなり97%まで飛んだら知らせる');
  ok(w.sample(3.95 * GB, 4 * GB, BASE, 1) === null, '飛び越した下の段は後から出てこない');
}

console.log('\n[4] performance.memoryが無い環境（Chrome以外）で嘘をつかない');
{
  const w = new MemoryWatch();
  ok(w.sample(0, 0, BASE, 1) === null, '山の数字が無ければ山の話はしない');
  ok(w.lastMB === 0 && w.limitMB === 0, '読めなかった物を0以外で名乗らない');
  for (let i = 0; i < 120; i++) w.sample(0, 0, BASE, 1);
  ok(w.series().memMins === '', '0が並ぶ列を送らない（使っていないように読めるため）');
  // 描く物の数はThreeJSが持っているので、こちらはどのブラウザでも動く
  ok(w.series().objMins !== '', '描く物の列はChrome以外でも出る');
}

console.log('\n[5] 描く物の増え方（WebGLの物はJSの山に載らないので別に見る）');
{
  // 敵1体でジオメトリ45個。プールの上限18体＝810個までは正当に増える（実測）
  const w = new MemoryWatch();
  w.sample(1 * GB, 4 * GB, BASE, 1);
  ok(w.sample(1 * GB, 4 * GB, BASE + 810, 1) === null, '敵18体ぶん(+810)では騒がない');
  ok(w.sample(1 * GB, 4 * GB, BASE + 1200, 1) === null, '武器と効果を足した+1200でも騒がない');
  const grew = w.sample(1 * GB, 4 * GB, BASE + 1500, 1);
  ok(grew?.reason === 'objects', '+1500まで増えたら知らせる');
  ok(grew?.base === BASE && grew?.objects === BASE + 1500,
    `底と今の数が入る（実際: ${grew?.base}→${grew?.objects}）`);
  ok(w.sample(1 * GB, 4 * GB, BASE + 2000, 1) === null, '同じ段では1回だけ');
  ok(w.sample(1 * GB, 4 * GB, BASE + 4000, 1)?.reason === 'objects', '次の段(+4000)でまた知らせる');
}

console.log('\n[6] 1分ごとの列');
{
  const w = new MemoryWatch();
  // 3分ぶん。1分ごとに増えていく形
  for (let i = 0; i < 60; i++) w.sample(300 * MB, 4 * GB, 700, 1);
  for (let i = 0; i < 60; i++) w.sample(400 * MB, 4 * GB, 800, 1);
  for (let i = 0; i < 60; i++) w.sample(500 * MB, 4 * GB, 900, 1);
  const s = w.series();
  ok(s.memMins === '300,400,500', `伸びる形がそのまま出る（実際: "${s.memMins}"）`);
  ok(s.objMins === '700,800,900', `描く物も同じ形で出る（実際: "${s.objMins}"）`);

  // 束の頭で谷を作らない。0へ戻すと、増え続けている形が階段に見える
  const w2 = new MemoryWatch();
  for (let i = 0; i < 60; i++) w2.sample(500 * MB, 4 * GB, 900, 1);
  for (let i = 0; i < 60; i++) w2.sample(500 * MB, 4 * GB, 900, 1);
  ok(w2.series().memMins === '500,500', `平らなら平らな列になる（実際: "${w2.series().memMins}"）`);

  // 15秒未満の閉じかけは出さない（数フレームで数字を名乗らせない）
  const w3 = new MemoryWatch();
  for (let i = 0; i < 10; i++) w3.sample(300 * MB, 4 * GB, 700, 1);
  ok(w3.series().memMins === '', '10秒しか無ければまだ何も出さない');

  // 61分でも束は60個で頭打ち（送る文字列が伸び続けない）
  const w4 = new MemoryWatch();
  for (let i = 0; i < 60 * 61; i++) w4.sample(300 * MB, 4 * GB, 700, 1);
  ok(w4.series().memMins.split(',').length <= 60, '61分見ても束は60個まで');

  // resetで次の回に前の回が混ざらない。段も戻る（回ごとに1行ずつ出る）
  const w5 = new MemoryWatch();
  w5.sample(3.9 * GB, 4 * GB, BASE, 1);
  w5.reset();
  ok(w5.series().memMins === '', 'reset()で列が空に戻る');
  ok(w5.sample(2.5 * GB, 4 * GB, BASE, 1)?.reason === 'heap', 'reset()で段も戻る（次の回でも知らせる）');
}

console.log('\n[7] 送り口と受け口が繋がっている');
{
  ok(REPORT_KINDS.includes('mem'), '受ける側が mem を受け付ける');
  // perfと同じ種類にすると、連投止めの鍵が「送り元＋種類」なので
  // 遊び終わりのperfと潰し合って、どちらかが429で消える
  const diagSrc = readFileSync(new URL('../src/ui/diag.js', import.meta.url), 'utf8');
  ok(/kind:\s*'mem'/.test(diagSrc), '送る側が mem という種類で送っている');

  const body = JSON.stringify({
    kind: 'mem', message: 'メモリが限界に近い（92%）', name: 'れい',
    mem: 3800, memMax: 3900, memLimit: 4096, memPct: 92, geo: 900, tex: 120,
    memMins: '300,400,500', objMins: '700,800,900',
  });
  const r = reportRecord(body);
  ok(r?.kind === 'mem', '種類がそのまま通る（errorへ落とされない）');
  for (const k of ['mem', 'memMax', 'memLimit', 'memPct', 'geo', 'tex']) {
    ok(typeof r?.[k] === 'number', `${k} が数字として通る`);
  }
  ok(r?.memMins === '300,400,500' && r?.objMins === '700,800,900', '1分ごとの列が通る');
  // 数字とカンマ以外は丸ごと捨てる（ログ画面へ好きな文字を流し込める口にしない）
  const dirty = (o) => reportRecord(JSON.stringify({ kind: 'mem', message: 'x', ...o }));
  ok(dirty({ memMins: '300,<b>x</b>' })?.memMins == null, 'タグ混じりの列は捨てる');
  ok(dirty({ objMins: ',700' })?.objMins == null, 'カンマ始まりの列は捨てる');
  ok(dirty({ mem: 'たくさん' })?.mem == null, '数字でない使用量は捨てる');
  ok(dirty({ mem: Infinity })?.mem == null, '無限は捨てる');

  // 流れる方(flyctl logs)にも数字が出る。鍵は手元に無いので、
  // ここに出ていないと開発する側からメモリを追えない
  const line = reportLine(body);
  for (const k of ['mem=3800', 'memMax=3900', 'memLimit=4096', 'memPct=92',
    'geo=900', 'tex=120', 'memMins=300,400,500', 'objMins=700,800,900']) {
    ok(line.includes(k), `${k} が1行に出る`);
  }
  ok(line.startsWith('[メモリ]'), '種類が日本語で頭に付く');
  ok(!line.includes('\n'), '1行のまま（ログの他の行に紛れ込ませない）');
}

console.log('\n[8] main.jsが毎フレーム読んでいない');
{
  /* performance.memoryの読み出しを毎フレームやると、
     測るための仕掛けが測られる物を重くする（このrepoで実際に4回踏んだ形）。
     1秒に1回の升目を通っているかをソースで見る */
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const m = mainSrc.match(/_watchMemory\(dt\)\s*\{([\s\S]*?)\n {2}\}/);
  ok(!!m, '_watchMemory()が見つかる');
  const bodyText = m?.[1] ?? '';
  ok(/this\._memAcc\s*\+=\s*dt/.test(bodyText), 'dtを積んでいる');
  ok(/if\s*\(this\._memAcc\s*<\s*1\)\s*return/.test(bodyText), '1秒に届くまで帰る');
  // 読み出しは升目を抜けた後にだけ置く。手前に置くと積む意味が無くなる
  const gateAt = bodyText.indexOf('this._memAcc = 0');
  const readAt = bodyText.indexOf('performance.memory');
  ok(gateAt >= 0 && readAt > gateAt, '読み出しは升目を抜けた後にある');
  // 遊んでいない間も止めない。メニューに置いたまま増える形の方がたちが悪い
  ok(/this\._watchMemory\(dt\);/.test(mainSrc), '_loopから呼ばれている');
  const callAt = mainSrc.indexOf('this._watchMemory(dt);');
  const playingAt = mainSrc.indexOf('const playing = this.state === ');
  ok(callAt < playingAt, '遊んでいるかどうかで分かれる前に呼んでいる（メニューでも見張る）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
