// チュートリアルの検査。
//
// なぜ要るか: チュートリアルは「FPS未経験の人が最初に触る場所」で、
// ここが壊れていると、その人はゲームの中身へ一度も辿り着けずに閉じる。
// しかも壊れ方が陰湿で、
//   ・課題の文言が実装のキーとずれる（Shiftと書いてあるのに右Shiftが効かない）
//   ・段差が低すぎて歩いて登れてしまい、ジャンプを教えられない
//   ・先に的を倒していた人の課題が勝手に達成になる
// のどれも、画面を見て通しで遊ばないと気づけない。全部机の上で測る。
//
//   node tools/check-tutorial.mjs
import { readFileSync } from 'node:fs';
import { TUTORIAL_STEPS, TutorialMachine } from '../src/core/tutorial.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 素のスナップショット。1フレームぶん。上書きしたい所だけ渡す
const snap = (over = {}) => ({
  dt: 1 / 60, yaw: 0, pitch: 0, speed: 0, onFloor: true,
  sprinting: false, crouching: false, shots: 0, kills: 0,
  adsFactor: 0, reloading: 0, weaponIndex: 0, threw: false, healed: false,
  ...over,
});

// 同じスナップショットをn回流す
const run = (m, n, over) => {
  let advanced = 0;
  for (let i = 0; i < n; i++) if (m.update(snap(over)) === 'advance') advanced++;
  return advanced;
};

console.log('\n[1] ステップ機械: 全遷移');
{
  const m = new TutorialMachine({ rifleIndex: 0, pistolIndex: 2 });

  // look: 動かさなければ進まない。累積2.5radで進む
  ok(m.step.id === 'look', '最初はlook');
  run(m, 120, {});
  ok(m.step.id === 'look', 'マウスを動かさなければ進まない');
  // 1フレーム0.05radずつ回す。50フレームで2.5rad
  for (let i = 0; i < 49; i++) m.update(snap({ yaw: i * 0.05 }));
  ok(m.step.id === 'look', '2.45radではまだ進まない');
  m.update(snap({ yaw: 49 * 0.05 }));
  m.update(snap({ yaw: 50 * 0.05 }));
  ok(m.step.id === 'move', '2.5radで進む');

  // move: 空中や停止では数えない。歩き合計3.0秒で進む
  run(m, 300, { speed: 3, onFloor: false });
  ok(m.step.id === 'move', '空中の移動は数えない');
  run(m, 179, { speed: 3 });     // 179/60 = 2.98秒
  ok(m.step.id === 'move', '2.98秒ではまだ');
  run(m, 3, { speed: 3 });
  ok(m.step.id === 'sprint', '3.0秒で進む');

  // sprint: 1.5秒
  run(m, 89, { sprinting: true });
  ok(m.step.id === 'sprint', '1.48秒ではまだ');
  run(m, 3, { sprinting: true });
  ok(m.step.id === 'jump', '1.5秒で進む');

  // jump: 接地→空中のエッジ2回。空中のままでは数えない
  run(m, 200, { onFloor: false });
  ok(m.step.id === 'jump', '空中に居続けても1回しか数えない');
  run(m, 5, { onFloor: true });
  run(m, 5, { onFloor: false });   // 2回目のエッジ
  ok(m.step.id === 'crouch', '2回跳んで進む');

  // crouch: 1.5秒。**この時点で既に100発撃っていた人**を再現する
  // （入場フレームの基準取りにこの100が乗ることを次の項で確かめる）
  run(m, 92, { crouching: true, shots: 100 });
  ok(m.step.id === 'shoot', 'しゃがみ1.5秒で進む');

  // shoot: 入場時の累積は基準から除外。+5発で進む
  run(m, 10, { shots: 100 });
  ok(m.step.id === 'shoot', '入場前の100発では進まない');
  run(m, 5, { shots: 104 });
  ok(m.step.id === 'shoot', '+4発ではまだ');
  run(m, 2, { shots: 105 });
  ok(m.step.id === 'ads', '+5発で進む');

  // ads: 覗いただけでは進まず、戻して進む
  run(m, 30, { adsFactor: 1 });
  ok(m.step.id === 'ads', '覗いただけでは進まない（戻すまでがトグルの練習）');
  run(m, 5, { adsFactor: 0 });
  ok(m.step.id === 'reload', '戻して進む');

  // reload: 完了エッジ。リロード中では進まない
  run(m, 60, { reloading: 1.2 });
  ok(m.step.id === 'reload', 'リロード中はまだ');
  run(m, 2, { reloading: 0 });
  ok(m.step.id === 'switch', '巻き終わりで進む');

  // switch: pistol(2)→rifle(0)の順でだけ進む。
  // この時点で既に7体倒していた人を再現（次のtargetの基準取りに乗る）
  run(m, 10, { weaponIndex: 0, kills: 7 });
  ok(m.step.id === 'switch', '最初からライフルのままでは進まない');
  run(m, 5, { weaponIndex: 2, kills: 7 });
  ok(m.step.id === 'switch', 'ピストルに替えただけではまだ');
  run(m, 2, { weaponIndex: 0, kills: 7 });
  ok(m.step.id === 'target', 'ライフルへ戻して進む');

  // target: 入場時基準の増分3体
  run(m, 5, { kills: 7 });
  ok(m.step.id === 'target', '入場前の7体では進まない');
  run(m, 2, { kills: 9 });
  ok(m.step.id === 'target', '+2体ではまだ');
  run(m, 2, { kills: 10 });
  ok(m.step.id === 'nade', '+3体で進む');

  // nade / heal: 1フレームのフラグ
  run(m, 30, {});
  ok(m.step.id === 'nade', 'フラグ無しでは進まない');
  m.update(snap({ threw: true }));
  ok(m.step.id === 'heal', '投げた瞬間に進む');
  m.update(snap({ healed: true }));
  ok(m.done, '巻き終えて修了');
  ok(m.step === null, '修了後のstepはnull');

  // done後に呼び続けても落ちない・進まない
  const after = run(m, 60, { threw: true, healed: true });
  ok(after === 0 && m.done, '修了後は何も起きない');

  // reset
  m.reset();
  ok(m.step.id === 'look' && !m.done, 'reset()で最初へ戻る');
}

console.log('\n[2] 文言とキーの整合');
{
  const byId = Object.fromEntries(TUTORIAL_STEPS.map((s) => [s.id, s]));
  const mainSrc = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const playerSrc = readFileSync(new URL('../src/player/player.js', import.meta.url), 'utf8');
  const text = (s) => `${s.main} ${s.sub}`;

  /* 文言に出るキーが、実装が本当に見ているキーと一致すること。
     どちらかを変えたらもう片方も変える。ずれた瞬間、未経験者は
     「書いてある通りに押したのに動かない」で詰む（自力で抜けられない） */
  ok(/左Shift/.test(text(byId.sprint)) && /ShiftLeft/.test(playerSrc),
    '走り: 文言は「左Shift」、実装はShiftLeft（右Shiftでは走れない）');
  ok(/Ctrl か C/.test(text(byId.crouch))
    && /ControlLeft/.test(playerSrc) && /KeyC/.test(playerSrc),
    'しゃがみ: 文言のCtrl/Cが実装に居る');
  ok(/Space/.test(text(byId.jump)) && /pressed\('Space'\)/.test(playerSrc),
    'ジャンプ: Space');
  ok(/R で/.test(text(byId.reload)) && /pressed\('KeyR'\)/.test(mainSrc),
    'リロード: R');
  ok(/F で/.test(text(byId.heal)) && /pressed\('KeyF'\)/.test(mainSrc),
    '包帯: F');
  ok(/Digit/.test(mainSrc) && /2 で.*1 で/.test(byId.switch.main),
    '武器切り替え: 数字キー');
  // ADSはトグル。「押している間だけ覗く」と書いたら嘘になる
  // （「押しっぱなしではなく」のような否定は正しい説明なので引っかけない）
  ok(!/押している間|押し続け/.test(text(byId.ads)),
    'ADSの文言が押しっぱなし前提になっていない');
  ok(/もう一度/.test(byId.ads.main) && /切り替え/.test(text(byId.ads)),
    'ADSの文言が「もう一度で戻す」切り替え式だと言っている');
  // 手榴弾は「押して構え、離して投げる」。押した瞬間に飛ぶと書いたら嘘
  ok(/離して/.test(byId.nade.main), '手榴弾の文言が「離して投げる」');

  /* switchステップの数字はLOADOUT_IDSの並びと一致すること。
     並びが変わると「2でピストル」が嘘になる */
  const { LOADOUT_IDS } = await import('../src/net/protocol.js');
  ok(LOADOUT_IDS[0] === 'rifle' && LOADOUT_IDS[1] === 'pistol',
    `1=ライフル・2=ピストルの並び（今: ${LOADOUT_IDS.join(',')}）`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
