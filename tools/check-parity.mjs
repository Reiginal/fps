// クライアントとサーバーで、同じキーを押した時に同じ所へ着くかの検査。
//
// なぜ要るか: **この作りの土台がここだから。**
// server/sim.js の冒頭にこう書いてある —
// 「別実装の『サーバー用の簡易移動』を書いた瞬間、段差の乗り越えや壁ずりが必ず食い違う」。
// だから両側で同じ Player クラスを走らせている。
//
// ところが**同じクラスを走らせていても、入り口が2つある**:
//
//   遊ぶ人がキーを押す
//        ↓
//   [クライアント] src/core/input.js … e.code の文字列をそのまま持つ
//        ↓  main.js が protocol.js の KEY_CODES で整数へ畳む
//        ↓  電文
//   [サーバー]  server/sim.js の ServerInput … 整数を e.code へ戻す
//        ↓
//   どちらも Player.update(dt, input) を呼ぶ
//
// **戻す表(CODE_BIT)と畳む表(KEY_CODES)が食い違うと、同じキーを押したのに
// 片方だけ効かない。** そして誰も気づけない:
//   ・構文エラーではない。両方とも正しいJavaScript
//   ・check-protocol.mjs は電文の項目名しか見ない。中身のビットは見ない
//   ・check-lobby.mjs は Room を叩くが、キーは1つも押さない
//   ・画面上は自分だけしゃがんでいて、サーバーでは立ったままなので、
//     **しゃがんで隠れているのに頭を撃たれる。** 撃たれた側には何が起きたのか読めない
//
// これは絵空事ではない。CLAUDE.local.md に書いてある通り、
// しゃがみがCtrlだとWindowsでタブが閉じる問題があり、
// **割り当てを変える話が実際に出ている。** 片側だけ直した日にこれが落ちる。
//
// やることは単純で、両方を本当に走らせて着いた場所を比べるだけ。
// 正規表現で表を突き合わせる形にしないのは、突き合わせが通っても
// Playerの中で分岐が変われば食い違うため。**動かして比べるのが一番強い。**
//
//   node tools/check-parity.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';
import { KEY_CODES, TICK_DT } from '../src/net/protocol.js';

const { Player } = await import('../src/player/player.js');
const { SimPlayer } = await import('../server/sim.js');
const { buildWorld } = await import('../server/world.js');

const world = buildWorld();

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* ------------------------------------------------ クライアント側の入力の偽物

   src/core/input.js と同じ約束で動く最小の実装。
   本物と同じく **e.code の文字列をそのまま持つ**（ここが要点で、
   サーバー側は整数からこの文字列を作り直している）。

   pressed() は「その刻みで押し下がった物だけ」。
   本物は endFrame() で毎フレーム消すが、こちらは前回の集合と比べて出す
   （ServerInput.pressed と同じ数え方にしないと、比べる意味が無くなる） */
class FakeClientInput {
  constructor() {
    this.keys = new Set();
    this.prev = new Set();
  }

  hold(codes) {
    this.prev = this.keys;
    this.keys = new Set(codes);
  }

  down(code) { return this.keys.has(code); }
  pressed(code) { return this.keys.has(code) && !this.prev.has(code); }

  moveVector(out) {
    let x = 0, z = 0;
    if (this.keys.has('KeyW')) z -= 1;
    if (this.keys.has('KeyS')) z += 1;
    if (this.keys.has('KeyA')) x -= 1;
    if (this.keys.has('KeyD')) x += 1;
    const len = Math.hypot(x, z);
    if (len > 1) { x /= len; z /= len; }
    out.x = x; out.z = z;
    return out;
  }

  // 視点は電文のyaw/pitchを使うので、ここが返す値は誰も読まない。
  // それでも lookEnabled=false でPlayerが必ず呼ぶので、無いと落ちる
  takeLook() { return { yaw: 0, pitch: 0 }; }
}

/* 押しているキーの集合を、電文に載る整数へ畳む。
   main.js:1687 がやっているのと同じこと（あちらも KEY_CODES を回すだけ） */
const toBits = (codes) => {
  let bits = 0;
  for (const [code, bit] of KEY_CODES) if (codes.includes(code)) bits |= bit;
  return bits;
};

/**
 * 同じ台本を両側に流して、着いた所を比べる。
 * script は [押しているキーの配列, 刻み数] の並び。
 */
function run(script, yaw = 0) {
  const cli = new Player(new THREE.Object3D(), world);
  const srv = new SimPlayer(1, 'テスト', world);

  const cin = new FakeClientInput();
  cli.yaw = yaw;
  srv.player.yaw = yaw;

  for (const [codes, ticks] of script) {
    for (let i = 0; i < ticks; i++) {
      // クライアント: 文字列のまま Player へ渡す
      cin.hold(codes);
      cli.yaw = yaw;
      cli.pitch = 0;
      cli.update(TICK_DT, cin, false);

      // サーバー: 整数へ畳んで送り、向こうで文字列へ戻してから Player へ渡す
      srv.tick(toBits(codes), yaw, 0);
      srv.clock(TICK_DT);
    }
  }

  const at = (p) => ({
    x: p.collider.start.x, y: p.feetY, z: p.collider.start.z,
    h: p.height, crouch: p.crouching, sprint: p.sprinting, floor: p.onFloor,
  });
  return { cli: at(cli), srv: at(srv.player) };
}

/** 2つの姿勢を突き合わせる。位置は1mm、身長は1mmまで一致していること */
function same(label, script, yaw = 0) {
  const { cli, srv } = run(script, yaw);
  const d = Math.hypot(cli.x - srv.x, cli.y - srv.y, cli.z - srv.z);
  const dh = Math.abs(cli.h - srv.h);

  const posOk = d < 0.001;
  const hOk = dh < 0.001;
  const stateOk = cli.crouch === srv.crouch && cli.sprint === srv.sprint && cli.floor === srv.floor;

  ok(posOk && hOk && stateOk, `${label}`
    + `  位置のずれ ${(d * 100).toFixed(3)}cm / 身長のずれ ${(dh * 100).toFixed(3)}cm`
    + (stateOk ? '' : `  ← 姿勢が違う しゃがみ ${cli.crouch}/${srv.crouch}`
      + ` 走り ${cli.sprint}/${srv.sprint} 接地 ${cli.floor}/${srv.floor}`)
    + (posOk ? '' : `  ← 手元(${cli.x.toFixed(2)}, ${cli.z.toFixed(2)})`
      + ` サーバー(${srv.x.toFixed(2)}, ${srv.z.toFixed(2)})`));
}

console.log('\n[1] 何も押さなければ、両方ともその場に立っている');
same('無入力60刻み', [[[], 60]]);

console.log('\n[2] 移動のキーが両側で同じに効く');
// 押しているキーそのものが電文の整数を通って戻ってくる道筋を、1方向ずつ通す
same('W 前へ', [[['KeyW'], 90]]);
same('S 後ろへ', [[['KeyS'], 90]]);
same('A 左へ', [[['KeyA'], 90]]);
same('D 右へ', [[['KeyD'], 90]]);
same('WD 斜め', [[['KeyW', 'KeyD'], 90]]);
// 向きを変えると、同じキーでも進む方角が変わる。
// yawは電文でそのまま届くので両側で同じはずだが、掛ける順番を間違えると
// 片方だけ90度ずれる（無入力では絶対に出ない食い違い）
same('W 前へ（yaw=1.0）', [[['KeyW'], 90]], 1.0);
same('W 前へ（yaw=-2.4）', [[['KeyW'], 90]], -2.4);

console.log('\n[3] しゃがみが両側で同じに効く');
// **ここが一番危ない。** protocol.jsのKEY_CODESはしゃがみを4通り受けるが、
// server/sim.jsのCODE_BITは ControlLeft の1つしか戻さない。
// player.jsは4つを or で見ているので今は通るが、
// **player.jsから ControlLeft を外した瞬間、サーバーだけしゃがまなくなる**
for (const key of ['ControlLeft', 'KeyC', 'MetaLeft', 'MetaRight']) {
  same(`${key} でしゃがむ`, [[[key], 40], [[key, 'KeyW'], 60]]);
}
same('しゃがんでから立つ', [[['ControlLeft'], 40], [[], 60]]);

console.log('\n[4] 走りが両側で同じに効く');
// 走りは前へ入力している時だけ乗る。片側だけ乗ると最高速が変わり、
// 撃ち合いの最中に位置が引き戻される
same('Shift+W で走る', [[['KeyW', 'ShiftLeft'], 90]]);
same('Shift+S では走らない', [[['KeyS', 'ShiftLeft'], 90]]);
same('しゃがみ走りにはならない', [[['KeyW', 'ShiftLeft', 'ControlLeft'], 90]]);

console.log('\n[5] 跳躍が両側で同じに効く');
// pressed() の数え方（押し下がった刻みだけ立つ）が片側で違うと、
// 押しっぱなしで毎刻み跳ぶ側と1回だけ跳ぶ側に割れる
same('Space 1回', [[['Space'], 1], [[], 60]]);
same('Space 押しっぱなし', [[['Space'], 60]]);
same('走って跳ぶ', [[['KeyW', 'ShiftLeft'], 40], [['KeyW', 'ShiftLeft', 'Space'], 1], [['KeyW', 'ShiftLeft'], 60]]);

console.log('\n[6] 長く歩いても離れていかない');
// 1刻みの誤差が積み上がる形だと、短い台本では気づけない。
// 地形にぶつかりながら300刻み（5秒）歩かせる
same('前へ300刻み', [[['KeyW'], 300]]);
same('うろうろ', [
  [['KeyW'], 60], [['KeyA'], 60], [['KeyS'], 60], [['KeyD'], 60],
  [['KeyW', 'ShiftLeft'], 60], [['ControlLeft'], 30], [['ControlLeft', 'KeyW'], 60],
], 0.7);

console.log('\n[7] 電文に載らないキーは、サーバー側で効かない');
// 逆向きの確認。KEY_CODESに無いキーは整数に畳まれないので、
// サーバーには届かない。**届いてしまうなら、それは送っていない物が
// 効いているということで、片側だけが知っている操作になる**
{
  const codes = KEY_CODES.map(([c]) => c);
  ok(!codes.includes('KeyF'), 'KeyF(包帯)はKEY_CODESに無い（main.jsがplayer.healingを見て立てる）');
  ok(toBits(['KeyQ', 'KeyZ', 'KeyM']) === 0, '割り当ての無いキーは整数に何も立てない');
}

console.log('\n[8] 両側のPlayerが本当に同じクラス');
// 「同じクラスを走らせる」がこの作りの前提。
// サーバーが自前の簡易移動を持ち始めたらここで気づける
{
  const srv = new SimPlayer(2, 'x', world);
  ok(srv.player instanceof Player, 'SimPlayerが持っているのは src/player/player.js の Player');
  ok(srv.player.octree === world.octree, 'サーバーもクライアントと同じ地形の当たり判定を見ている');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
