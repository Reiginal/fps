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

console.log('\n[時間帯] 遊びに来た時刻で太陽が変わる');
/* **夜を作っていないことが肝。** 暗くすると当てる所が見えなくなって、
   遊びとして別物になる。何時に来ても朝・昼・夕方のどれかへ寄せる。
   仰角が0以下だと太陽が地面の下に行って、影の計算（仰角のtanで割る）が壊れる */
{
  const { TIME_OF_DAY, timeOfDayAt, timeOfDay, currentTimeOfDay } = await import('../src/world/sun.js');

  ok(TIME_OF_DAY.length >= 2, `時間帯は ${TIME_OF_DAY.length} 種類（${TIME_OF_DAY.map((t) => t.name).join('、')}）`);
  for (const t of TIME_OF_DAY) {
    const [x, y, z] = t.dir;
    ok(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z), `${t.name} … 向きが数`);
    // 地面の下から照らすと、影カメラの奥行き（仰角のtanで割る）が壊れる
    ok(y > 0.15, `${t.name} … 太陽が地面の上にある（仰角 ${(Math.atan2(y, Math.hypot(x, z)) * 57.3).toFixed(0)}度）`);
    ok(y < 0.95, `${t.name} … 真上ではない（真上だと影が物の真下に潰れて画が平らになる）`);
    ok(Number.isInteger(t.color) && t.color > 0, `${t.name} … 日射しの色がある`);
  }

  /* **24時間どこにも入らない時刻があってはいけない。**
     夕方だけ日をまたぐので、範囲の見方を間違えると夜が抜ける。

     表そのものを見る。timeOfDayAt() には「どこにも入らなければ夕方」という
     逃げ道があるので、返り値だけ見ていると穴が空いていても気づけない
     （実際、範囲を [16,24] に壊しても検査が通ってしまった） */
  const covers = (t, h) => {
    const [from, to] = t.hours;
    return from < to ? (h >= from && h < to) : (h >= from || h < to);
  };
  for (let h = 0; h < 24; h++) {
    ok(TIME_OF_DAY.some((t) => covers(t, h)), `${h}時 … 表のどれかの範囲に入っている`);
  }

  const seen = new Set();
  for (let h = 0; h < 24; h++) {
    const t = timeOfDayAt(h);
    ok(!!t && TIME_OF_DAY.includes(t), `${h}時 … ${t?.name || 'どこにも入らない'}`);
    seen.add(t?.id);
  }
  ok(seen.size === TIME_OF_DAY.length, `24時間で全部の時間帯が出る（${seen.size} / ${TIME_OF_DAY.length}）`);

  // 壊れた時刻でも画が出る
  for (const junk of [NaN, undefined, -3, 99]) {
    ok(!!timeOfDayAt(junk)?.dir, `${String(junk)} を渡されても向きが返る`);
  }
  ok(timeOfDay('でたらめ') === TIME_OF_DAY[2], '知らない名前は夕方（今まで通りの画）へ寄せる');
  ok(!!currentTimeOfDay()?.dir, '今の時刻でも向きが返る');
}

console.log('\n[霧] 霧の向きが、時刻で動く太陽と同期している');
/* installAerialPerspective()は太陽の向きをGLSLの定数へ焼く（ShaderChunkは
   静的な文字列でuniformを持てないため）。以前はこのファイルの中だけで
   夕方の値を固定で持っていて、main.js側のSUN_DIRが時刻で動くようになった後も
   同期されないまま置き去りになっていた（朝・昼に遊んでも霧の暖色側が
   夕方の方角を向いたまま）。渡した向きが実際にShaderChunkへ焼かれることと、
   main.js側が「時刻で決めたSUN_DIR」をそのまま渡していることの両方を見る */
{
  const THREE = await import('three');
  const { installAerialPerspective } = await import('../src/world/textures.js');

  // 夕方(-0.78,0.46,-0.34)とはっきり違う向きを渡して、古い固定値が
  // 残っていないか（=渡した値ではなく夕方の値のままでないか）を見分ける
  const morning = new THREE.Vector3(0.72, 0.38, -0.46).normalize();
  installAerialPerspective(morning);
  const frag = THREE.ShaderChunk.fog_pars_fragment;
  ok(frag.includes(morning.x.toFixed(5)) && frag.includes(morning.y.toFixed(5))
    && frag.includes(morning.z.toFixed(5)), '渡した向きがShaderChunkに焼かれる');
  ok(!frag.includes('-0.78000'), '夕方の固定値が残っていない');

  // main.js側の呼び出しが、SUN_DIRを決めた直後にそのまま渡しているか。
  // main.jsはGameクラスを起動するのでNode上では実行できない（DOM前提）。
  // ソースの並びだけを見る: installAerialPerspective(SUN_DIR)が、
  // SUN_DIRを定義する行より後ろにあること
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const sunDirAt = main.indexOf('const SUN_DIR');
  const callAt = main.indexOf('installAerialPerspective(SUN_DIR)');
  ok(sunDirAt >= 0 && callAt > sunDirAt, 'main.jsがSUN_DIRを決めた直後に渡している');
}

console.log('\n[5] AOから外す物を毎フレーム探し直していない');
/* AOの法線パスは半透明の板を隠してから描く。前はその「隠す物探し」を
   毎フレームscene.traverse()（2千個超の全訪問）でやっていた。
   候補は起動時のプールでほぼ固定なので、一覧を使い回し、
   増え物の取りこぼしは2秒に1回の組み直しで自己回復する */
{
  const src = readFileSync(new URL('../src/core/postfx.js', import.meta.url), 'utf8');
  const override = src.slice(src.indexOf('ao._overrideVisibility'), src.indexOf('composer.addPass(ao)'));
  ok(/aoScanIn = 120/.test(src), '組み直しの間隔が決めてある（120フレーム=2秒）');
  ok(/if \(--aoScanIn <= 0\)/.test(override), '間隔が来た時だけ全走査する');
  ok(/if \(!o\.visible\) continue;/.test(override),
    '元から隠れている物は触らない（戻す側が一律trueにするため）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
