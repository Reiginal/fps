// 画面効果の検査。WebGLは使わず、シェーダの設定と本文だけを見る。
//
// なぜ要るか: ここは**絵を見ないと分からない層の中でも、一番気づきにくい**。
// 数字を1つ動かすだけで画面の見え方が変わるのに、動かしたことは
// どのターミナルにも出ない。実際に遊んで「スコープが曇る」と言われるまで、
// 覗いている間ずっと世界がボケていることに誰も気づかなかった。
//
// 見られるのは「設定がどうなっているか」までで、絵そのものは見られない。
// それでも、一度決めた値が黙って戻るのは止められる。
//
//   node tools/check-postfx.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';

const { GradeShader, FinishShader } = await import('../src/core/postfx.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

console.log('\n[1] 覗いた時に世界がボケない');
// 遊んで「スコープが曇ったりする仕様がいらない」と言われた所。
// 曇りを描いていたわけではなく、覗いている間だけ**合焦距離から外れた物が
// 全部ボケる**（被写界深度）ようにしてあった。遠くを狙えば手前が、
// 手前を狙えば遠くが溶けるので、撃ち合いの最中はレンズが曇ったようにしか見えない。
{
  const dof = GradeShader.uniforms.uDofStrength;
  ok(dof && dof.value === 0, `世界側のボケの強さ ${dof?.value}（0で切ってある）`);
  // 強さが0でも、分岐が uAds だけを見ていたら12回のテクスチャ読みは走り続ける。
  // 絵は変わらないのに負荷だけ残るので、掛け算で丸ごと飛ばす形になっているかを見る
  ok(
    GradeShader.fragmentShader.includes('uAds * uDofStrength > 0.002'),
    'ボケの分岐が uAds * uDofStrength で飛ぶ',
  );
}

console.log('\n[2] シャープを引く側も同じ判断をしている');
// 最後のシャープは「前段でボカした所」を避けて掛ける作りになっている。
// ボケを切った側と避ける側が別々の値を見ていると、ボカしていない所を
// 避け続けることになり、覗いた瞬間に画面全体が眠くなる
{
  const dof = FinishShader.uniforms.uDofStrength;
  ok(dof && dof.value === 0, `シャープ側が見ているボケの強さ ${dof?.value}`);
  ok(
    FinishShader.fragmentShader.includes('uAds * uDofStrength > 0.002'),
    'シャープを引く分岐も同じ式',
  );
  // 実際に同じ物を見ているか（uniformオブジェクトごと共有しているか）は
  // createComposerが繋ぐので、WebGLの無いここからは呼べない。
  // 繋ぐ1行が消えていないことだけ本文で見る
  const src = readFileSync(new URL('../src/core/postfx.js', import.meta.url), 'utf8');
  ok(
    src.includes('sharpen.uniforms.uDofStrength = grade.uniforms.uDofStrength;'),
    '2つが同じuniformを共有するよう繋いである',
  );
}

console.log('\n[3] 覗いた時の締まりは残っている');
// ボケを消したからといって、覗いた時に画が何も変わらないのでは
// 覗いたかどうかが分からなくなる。周辺の減光は残す
{
  const src = readFileSync(new URL('../src/core/postfx.js', import.meta.url), 'utf8');
  ok(/uPeriph:\s*\{\s*value:\s*0\.[1-9]/.test(src), '周辺の減光が残っている');
  ok(/uScopeShadow:\s*\{\s*value:\s*0\.[1-9]/.test(src), '接眼のケラレが残っている');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
