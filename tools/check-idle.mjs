// メニューの間に回り続ける物が無いことの検査。
//
// なぜ要るか: ホームもロビーもDOMの画面で、後ろの3Dはほぼ塗り潰されて見えない。
// それなのに影・AO・ブルームまで全部の行程が毎フレーム回っていて、
// 「閉じずに置いているだけでファンが回る」の原因になっていた。
// 遠景の撃ち合いの音も同じで、メニューに置いたまま席を外しても
// 数秒おきに銃声のノード一式を作っては捨て続けていた。
//
// 実物を起こしてメニュー状態を再現するにはWebGLごと要るので、
// ここはソースの突き合わせで見る（check-hud.mjsの地図の検査と同じやり方）。
//
//   node tools/check-idle.mjs

import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const audio = readFileSync(new URL('../src/core/audio.js', import.meta.url), 'utf8');
const charview = readFileSync(new URL('../src/ui/charview.js', import.meta.url), 'utf8');

console.log('\n[1] メニューの間、毎フレーム描かない');
{
  // 描くかどうかの分岐がある。無条件のcomposer.render()が復活したら落ちる
  ok(/const idle = this\.state === 'menu';/.test(main), 'メニューかどうかを見ている');
  ok(/if \(!idle \|\| !this\._idleDrawn\) this\.fx\.composer\.render\(\);/.test(main),
    '1枚描いたら止める形になっている');
  // 無条件のrender()は、boot()でシェーダーを温める1回だけ。
  // ループの中に無条件の物が増えたら（=毎フレーム描くへ戻したら）ここで気づく
  const bare = (main.match(/^\s*this\.fx\.composer\.render\(\);\s*$/mg) || []).length;
  ok(bare === 1, `無条件のcomposer.render()はbootの温めの1箇所だけ（今${bare}箇所）`);
}

console.log('\n[2] 止めた絵の描き直し');
{
  // 窓の大きさが変わるとキャンバスの中身が消える。
  // 描き直す印を倒し忘れると、メニューでリサイズした人の画面が真っ黒のままになる
  ok(/_resize\(\) \{[\s\S]{0,900}?_idleDrawn = false/.test(main),
    '窓の大きさが変わったら描き直す');
}

console.log('\n[3] 遠景の撃ち合いは試合の中でだけ鳴る');
{
  ok(/this\.enabled && this\.battle && Math\.random/.test(audio),
    '遠景の銃声が試合の印を見ている');
  ok(/this\.audio\.battle = this\.state === 'playing'/.test(main),
    'ループが試合の印を入れている');
}

console.log('\n[4] ロビーの3Dはロビーでだけ描く');
{
  // charviewは元から止まる作りだが、この検査が無いと
  // 「毎フレーム描く形に書き替えても誰も気づかない」になる
  ok(/if \(!this\.running \|\| !this\.ready \|\| !this\._model\) return;/.test(charview),
    '止まっている間は描かない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
