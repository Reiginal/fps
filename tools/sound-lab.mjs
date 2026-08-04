// 音を書き出して表にする。
//
//   node tools/sound-lab.mjs            … 全部書き出す
//   node tools/sound-lab.mjs kill       … 名前で絞る
//
// 出力先は sounds/ 。書き出したwavはそのまま再生できる。
//   afplay sounds/kill.wav
import { mkdirSync } from 'node:fs';
import { capture, BANDS } from './sound-measure.mjs';
import '../server/dom-stub.js';

const OUT = 'sounds';
mkdirSync(OUT, { recursive: true });

const targets = [];
targets.push({ name: 'kill', label: 'キル音', play: (a) => a.kill(false) });
targets.push({ name: 'kill-head', label: 'キル音(頭)', play: (a) => a.kill(true) });
targets.push({ name: 'hit', label: '命中', play: (a) => a.hitmarker(false) });
targets.push({ name: 'hit-head', label: '命中(頭)', play: (a) => a.hitmarker(true) });
targets.push({
  name: 'gun-rifle',
  label: '銃声(ライフル)',
  play: (a) => a.gunshot({
    volume: 0.7, bodyFreq: 300, crackFreq: 3600, bodyDecay: 0.2, tailDecay: 0.6,
    thumpFrom: 110, thumpTo: 44,
  }, null, null),
});
targets.push({
  name: 'gun-shotgun',
  label: '銃声(ショットガン)',
  play: (a) => a.gunshot({
    volume: 0.85, bodyFreq: 210, crackFreq: 2600, bodyDecay: 0.3, tailDecay: 0.8,
    thumpFrom: 95, thumpTo: 38,
  }, null, null),
});
targets.push({ name: 'explosion', label: '爆発', play: (a) => a.explosion(null, null) });
targets.push({ name: 'swing', label: 'ナイフを振る', play: (a) => a.swing() });
for (const sf of ['dirt', 'gravel', 'asphalt', 'concrete', 'metal', 'wood']) {
  targets.push({
    name: `step-${sf}`, label: `足音(${sf})`, seconds: 0.8,
    play: (a) => a.footstep(0.8, sf, null, null),
  });
}
targets.push({
  name: 'land', label: '着地', seconds: 1.0,
  play: (a) => a.land(1.1, 'concrete', null, null),
});
targets.push({ name: 'reload', label: 'リロード', play: (a) => a.reload(2), seconds: 2.6 });

const filter = process.argv[2] || '';
const rows = [];
for (const t of targets) {
  if (filter && !t.name.includes(filter)) continue;
  rows.push({
    ...t,
    info: await capture(t.play, { wav: `${OUT}/${t.name}.wav`, seconds: t.seconds || 2.0 }),
  });
}

const pad = (s, w) => {
  // 日本語は等幅で2文字ぶんの幅を取るので、桁を数えて詰める
  let n = 0;
  for (const c of String(s)) n += c.charCodeAt(0) > 0x2000 ? 2 : 1;
  return String(s) + ' '.repeat(Math.max(1, w - n));
};
const num = (v, w, d = 0) => String(v.toFixed(d)).padStart(w, ' ');

console.log('\n書き出し先: sounds/*.wav');
console.log('\n' + pad('音', 26) + '  長さms   低音%   重心Hz  打点   間隔ms    音量');
console.log('-'.repeat(62));
for (const r of rows) {
  const i = r.info;
  console.log(pad(r.label, 26) + num(i.lenMs, 8) + num(i.lowPct, 8, 1)
    + num(i.centroid, 9) + num(i.hits, 5) + num(i.gapMs, 8) + num(i.peak, 8, 2));
}

console.log('\n帯ごとの取り分(%)');
console.log(pad('', 26) + BANDS.map((b) => b[0].padStart(13)).join(''));
for (const r of rows) {
  console.log(pad(r.label, 26) + r.info.bands.map((b) => num(b.pct, 13, 1)).join(''));
}

console.log('\n聴き方:');
console.log('  for f in sounds/*.wav; do echo "$f"; afplay "$f"; sleep 0.5; done');
process.exit(0);
