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
import { SWING_HEAVY_TUNE, swingTune } from '../src/core/audio.js';

const OUT = 'sounds';
mkdirSync(OUT, { recursive: true });

const targets = [];
targets.push({ name: 'kill', label: 'キル音', play: (a) => a.kill(false) });
targets.push({ name: 'kill-head', label: 'キル音(頭)', play: (a) => a.kill(true) });
targets.push({ name: 'hit', label: '命中', play: (a) => a.hitmarker(false) });
targets.push({ name: 'hit-head', label: '命中(頭)', play: (a) => a.hitmarker(true) });
/* 銃声は**武器の表から引く。** ここに数字を写していた頃は、
   ライフルとショットガンの2挺ぶんだけが手で書いてあって、しかも中身が古かった
   （volume 0.7と書いてあるが本物は0.78）。**聴いて確かめるための道具なのに、
   本物と違う音を書き出していた**ので、ピストルと狙撃銃は聴く手段が無かった。
   尾の長い銃（狙撃銃は1.5秒引く）は2秒だと切れるので、長さも表から決める */
const { WEAPONS } = await import('../src/player/weapons.js');
for (const w of WEAPONS) {
  if (!w.sound || w.melee) continue;
  targets.push({
    name: `gun-${w.id}`,
    label: `銃声(${w.nick || w.name})`,
    seconds: Math.max(2.0, (w.sound.tailDecay || 0.4) * 1.6 + 0.8),
    play: (a) => a.gunshot(w.sound, null, null),
  });
}
targets.push({ name: 'explosion', label: '爆発', play: (a) => a.explosion(null, null) });
// 自分が倒れた時の音。**一番長く聴かされる音**（結果画面まで鳴っている）なのに
// 一度も測っていなかった。3秒取るのは、耳鳴りの尻尾まで含めて見るため
targets.push({ name: 'player-down', label: '自分が倒れた', play: (a) => a.playerDown(), seconds: 3.0 });
/* 振る音は2種類ある。**強い一撃は低く長い。**
   同じ音を大きくするだけだと「近くで振った」にしか聞こえない。
   長さを0.6秒に切ってあるのは、2秒取ると残響の尻尾ばかりが数字に乗るため

   **wavで候補を並べて選ぶやり方は、一度やって機能しなかった**（2026-08-11）。
   4案を書き出して聴いてもらったが「全部きもい」で終わり、
   しかも爆発やキル音まで一緒に流れて何を聴いているのか分からなくなった。
   短い効果音は、実際に構えて振った時の速さと一緒でないと判断できない。
   **次に迷ったら、候補を並べるより実機へ出して聴いてもらう方が早い。**
   src/core/audio.js の swing(tune) は残してあるので、必要ならここから渡せる */
targets.push({ name: 'swing', label: 'ナイフを振る', play: (a) => a.swing(), seconds: 0.6 });
targets.push({
  name: 'swing-heavy', label: '強い一撃', seconds: 0.9,
  play: (a) => a.swing(SWING_HEAVY_TUNE),
});
// 形ごとの振る音。**刀は長く澄んで、ダガーは短く高い。**
// 見た目だけ変えて音が同じだと、持ち替えた実感が出ない
for (const shape of ['katana', 'dagger']) {
  for (const heavy of [false, true]) {
    targets.push({
      name: `swing-${shape}${heavy ? '-heavy' : ''}`,
      label: `振る(${shape}${heavy ? '/右' : ''})`,
      seconds: heavy ? 0.9 : 0.6,
      play: (a) => a.swing(swingTune(shape, heavy)),
    });
  }
}
// 刃が当たった音は材質で分かれる。金属だけ「カンッ」と長く残るのが狙いなので、
// 4つとも書き出して長さと重心を並べて見る
for (const k of ['flesh', 'metal', 'wood', 'concrete']) {
  targets.push({ name: `stab-${k}`, label: `刃が当たる(${k})`, play: (a) => a.stab(null, null, k) });
}
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
for (const sf of ['dirt', 'gravel', 'asphalt', 'concrete', 'metal', 'wood']) {
  targets.push({
    name: `slide-${sf}`, label: `滑り込み(${sf})`, seconds: 1.4,
    play: (a) => a.slide(sf, null, null),
  });
}
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
