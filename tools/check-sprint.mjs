// 走りの息（スタミナ）の検査。
//
// なぜ要るか: 遊んで「これ無限に走れたら、やらない理由がないし」と言われた所。
// **速く動けて損が1つも無いなら、常に走るのが最適解になって選択が消える。**
// 移動が「押す／押さない」だけの操作になっていた。
//
// あわせて「PCが熱くなる原因だったりしない？」も聞かれたが、**走りは熱の原因ではない。**
// 走っている間に増える仕事は足音の回数と画角の寄せくらいで、1フレームの中では誤差。
// 熱くなるのは場面を毎フレーム描くほうで、走る／走らないでそこは変わらない。
// なのでこれは軽くするための物ではなく、選択を作るための物。
//
// ここで見るのは4つ。**3秒で切れる／切れたら走れない／満タンで戻る／
// 押し直しで無限に走れない。** 最後のが一番大事で、
// 溜まり始めるまでの間(SPRINT_REST_S)が無いと小刻みに押すだけで元通りになる。
//
//   node tools/check-sprint.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import * as THREE from 'three';

const { Player } = await import('../src/player/player.js');
const { buildWorld } = await import('../server/world.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const world = buildWorld();
const mk = () => new Player(new THREE.Object3D(), world);

// 前へ走り続ける入力と、何も押さない入力
const input = (keys = []) => ({
  down: (c) => keys.includes(c),
  pressed: () => false,
  buttons: [false, false, false],
  takeLook: () => ({ yaw: 0, pitch: 0 }),
  moveVector: (o) => { o.x = 0; o.z = keys.includes('KeyW') ? -1 : 0; return o; },
  endFrame: () => {},
});
const RUN = input(['KeyW', 'ShiftLeft']);
const WALK = input(['KeyW']);
const STILL = input([]);

const DT = 1 / 60;
/** n秒ぶん進めて、走っていた時間を返す */
const step = (p, seconds, inp) => {
  let ran = 0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    p.update(DT, inp, false);
    if (p.sprinting) ran += DT;
  }
  return ran;
};

console.log('\n[1] 走れる時間に上限がある');
{
  const p = mk();
  ok(p.stamina === 1, '出撃時は満タン');
  // 4秒ぶん押しっぱなしにする。3秒で切れて、残りは切れたまま走れない時間
  const ran = step(p, 4, RUN);
  ok(ran > 2.5 && ran < 3.6, `押しっぱなしで走れたのは ${ran.toFixed(2)}秒（3秒前後）`);
  ok(!p.sprinting, '押し続けていても切れた後は走っていない');
  ok(p.staminaLock === true, '息が切れた印が立っている');
  /* **押しっぱなしのまま待てば、また走り出す。**
     「クールタイムが終わったらまた走れる」がここ。
     切れてから満タンまでは休み0.5秒＋回復2.4秒で2.9秒 */
  const again = step(p, 3.2, RUN);
  ok(again > 0.1, `待っていればまた走り出す（続けて${again.toFixed(2)}秒）`);
}

console.log('\n[2] 切れたら満タンに戻るまで走れない');
{
  const p = mk();
  step(p, 4, RUN);      // 3秒で切れて、そこから1秒ぶん切れたまま
  // 半分ほど戻した所ではまだ走れない（半分で走り出せると、押し直すのが最適解になる）
  step(p, 0.7, STILL);
  ok(p.stamina > 0.2 && p.stamina < 0.95, `途中まで戻っている（${p.stamina.toFixed(2)}）`);
  const midRan = step(p, 0.3, RUN);
  ok(midRan === 0, '途中では走り出せない');

  // 満タンまで待てばまた走れる
  step(p, 3.5, STILL);
  ok(p.stamina >= 1 && !p.staminaLock, '満タンに戻って鍵も外れた');
  const ran2 = step(p, 1.0, RUN);
  ok(ran2 > 0.9, `また走れる（${ran2.toFixed(2)}秒）`);
}

console.log('\n[3] 押し直しても無限には走れない');
/* **ここが一番の急所。** 走るのをやめた瞬間に溜まり始める作りだと、
   小刻みに押し直すだけで実質無限に走れて、上限を付けた意味が丸ごと消える */
{
  const p = mk();
  let ran = 0;
  // 0.4秒走って0.4秒歩く、を10回。溜まり始めるまでの間(0.5秒)より短く刻む
  for (let i = 0; i < 10; i++) {
    ran += step(p, 0.4, RUN);
    step(p, 0.4, WALK);
  }
  ok(ran < 4.0, `刻んで押しても走れたのは合計 ${ran.toFixed(2)}秒（上限の3秒＋α）`);
}

console.log('\n[4] 歩いている間に少しずつ戻る');
{
  const p = mk();
  step(p, 2, RUN);
  const half = p.stamina;
  step(p, 1.5, WALK);
  ok(p.stamina > half, `歩いていても戻る（${half.toFixed(2)} → ${p.stamina.toFixed(2)}）`);
}

console.log('\n[5] 画面に出ているか');
/* 息が切れて走れないのに理由が画面に無いと、**操作が壊れたようにしか見えない。**
   満タンの時だけ消すのは、減っていないことを毎秒確かめさせないため */
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const hud = readFileSync(new URL('../src/ui/hud.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/hud\.stamina\(this\.player\.stamina/.test(main), '毎フレーム画面へ渡している');
  ok(/staminaBar/.test(hud) && /staminaFill/.test(hud), 'HUDが棒を持っている');
  ok(/id="staminaBar"/.test(html), '棒のDOMがある');
  ok(/#staminaBar\.on/.test(html) && /#staminaBar\.spent/.test(html),
    '減った時に出て、切れた時は色が変わる');
  // 毎フレーム呼ばれる物なので、同じ値で2度書かないこと
  ok(/_lastStamina/.test(hud), '同じ値なら書き込まない');
}

console.log('\n[6] サーバーも同じ息で走る');
/* 対戦では入力からの移動をサーバーも同じPlayerで解いている。
   **どちらか片方だけ上限を持つと、走っている間ずっと位置がずれ続ける。**
   同じクラスを使っているので自動的に揃うが、
   「別実装のサーバー用移動」を書き始めた瞬間に壊れるので、ここで釘を刺しておく */
{
  const sim = readFileSync(new URL('../server/sim.js', import.meta.url), 'utf8');
  ok(/import \{ Player \} from '\.\.\/src\/player\/player\.js'/.test(sim),
    'サーバーは本物のPlayerを読んでいる');
  ok(!/SPRINT_MAX|stamina\s*=/.test(sim), 'サーバー側に息の写しが無い');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
