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

console.log('\n[1] 動かない画面の間、毎フレーム描かない');
{
  // 止める対象は3つ: メニュー／ソロの一時停止／ソロの死亡画面（倒れ込みの後）。
  // どれかが式から消えたら、その画面を開いたまま置くだけでファンが回る形へ戻る
  ok(/const idle = this\.state === 'menu'[\s\S]{0,120}state === 'paused'[\s\S]{0,120}state === 'dead'/.test(main),
    'メニュー・一時停止・死亡画面を見ている');
  // 対戦は止めない（裏で試合が動き続けているのを隠さない）。
  // soloの判定が式から消えると、対戦の一時停止まで静止画になる
  ok(/const solo = this\.mode !== 'versus';/.test(main), '対戦を除いている');
  // 死亡画面は倒れ込みが終わってから止める。倒れている最中に止めると
  // 撃たれた次の瞬間に画面が固まって、何が起きたか見えない
  ok(/state === 'dead' && \(this\.deathT \?\? 0\) >= DEATH_FALL_S/.test(main),
    '倒れ込みの間は描き続ける');
  ok(/const willDraw = !idle \|\| !this\._idleDrawn;/.test(main),
    '1枚描いたら止める形になっている');
  // render()はwillDrawの中の1回と、boot()でシェーダーを温める1回の計2箇所だけ。
  // ループの中に無条件の物が増えたら（=毎フレーム描くへ戻したら）ここで気づく
  const all = (main.match(/this\.fx\.composer\.render\(\);/g) || []).length;
  ok(all === 2, `composer.render()はbootの温めとwillDrawの中の2箇所だけ（今${all}箇所）`);
  ok(/if \(willDraw\) \{[\s\S]{0,400}?this\.fx\.composer\.render\(\);/.test(main),
    'ループ側のrender()はwillDrawの中にある');
  // 描かないフレームでは残響の測り直しと影の箱の置き直しも見送る
  ok(/if \(willDraw\) \{[\s\S]{0,400}?_updateEnvironment[\s\S]{0,200}?_updateSunCascades/.test(main),
    '残響と影の箱も描くフレームだけ');
}

console.log('\n[1.5] ソロの倒れ込みは死んだ後も進む');
{
  // 倒れるとstateが'dead'になり、playingブロック（の中の_deathFall）は
  // 次のフレームから通らない。else側に無いと倒れ込みが1フレームで止まる
  // （実際に止まっていた。撃たれた後カメラが立ったまま結果画面まで固まる）
  /* **姿勢を決めてから倒れ込みを足す、の順番ごと見る。**
     applyDeathは「_applyCameraが姿勢を決めた後に足す(+=)」約束なので、
     _deathFallだけ呼ぶと傾きが毎フレーム積み上がってカメラがぐるぐる回る
     （実際に回った。詳しくはtools/check-deathcam.mjs） */
  ok(/if \(this\.state === 'dead'\) \{\s*this\.player\._applyCamera\(\);\s*this\._deathFall\(dt\);\s*\}/.test(main),
    'playingでないフレームでも「姿勢を決める→倒れ込みを足す」を回している');
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
