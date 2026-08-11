// 近接の当たり方と振り方の検査。
//
// **威力を上げる仕掛けは、偽られた時に何が起きるかまで見ないと入れられない。**
// クライアントが送るのは「強い」という印だけで、威力そのものは送らせていない。
// 偽って送り続けられても、サーバーが発射権を余分に使うので
// **間隔が伸びるだけで得が無い。** そこが崩れていないかを見張る。
//
// もう1つ、**1人用と対戦で当たり判定が別々の場所にある**（このrepoの持病）。
// 片方だけ直すと「1人用では当たるのに対戦では当たらない」になるので、
// 同じ数字を見ているかをここで突き合わせる。
//
// 3つ目は**形スキンで強くならないこと。** コインで買う物なので、
// 刀に持ち替えて間合いが伸びたら「強さを買える」ことになる。
//
//   node tools/check-melee.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { MELEE_HEAVY, MELEE_SWEEP, HITBOX, HP } from '../src/net/protocol.js';
import { WEAPONS as SIM_WEAPONS, heavyDef, hitPose } from '../server/sim.js';
import { WEAPONS, SWINGS, swingOf } from '../src/player/weapons.js';
import { setAccount } from '../src/player/skins.js';
import { SWING_TUNE, SWING_HEAVY_TUNE, swingTune } from '../src/core/audio.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const knife = WEAPONS.find((w) => w.id === 'knife');
const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');

console.log('\n[1] 数字の釣り合い');
{
  ok(MELEE_HEAVY.COST >= 2, `発射権を${MELEE_HEAVY.COST}個使う（間隔が${MELEE_HEAVY.COST}倍）`);
  ok(MELEE_HEAVY.MULT > 1, `威力は${MELEE_HEAVY.MULT}倍`);
  /* **毎秒の威力は下がっていること。** 上がっていると
     「右クリックを連打するのが最適」になって、左クリックが要らなくなる */
  const dpsNormal = knife.damage / (60 / knife.rpm);
  const dpsHeavy = (knife.damage * MELEE_HEAVY.MULT) / ((60 / knife.rpm) * MELEE_HEAVY.COST);
  ok(dpsHeavy < dpsNormal,
    `**押しっぱなしより弱い**（毎秒 ${dpsNormal.toFixed(0)} → ${dpsHeavy.toFixed(0)}）`);

  const heavy = knife.damage * MELEE_HEAVY.MULT;
  ok(heavy < HP.VERSUS, `対戦(体力${HP.VERSUS})を胴1回では倒せない（${heavy.toFixed(0)}）`);
  /* 頭でちょうど倒せないのは意図的。129.5×2.0＝259で、体力260にあと1足りない。
     **当てても詰め切る一手が要る形**にしてある（1回で終わると近づくだけで勝てる）*/
  ok(heavy * knife.headMult < HP.VERSUS,
    `**頭でも1回では倒せない**（${(heavy * knife.headMult).toFixed(0)} 対 ${HP.VERSUS}。あと${(HP.VERSUS - heavy * knife.headMult).toFixed(1)}）`);
  // 1人用の敵は体力100から始まる（波が進むと固くなる）。序盤なら1回で倒せる
  const ENEMY_BASE = 100;
  ok(heavy >= ENEMY_BASE,
    `1人用の敵(体力${ENEMY_BASE}から)は序盤なら1回で倒せる（${heavy.toFixed(0)}）`);
  ok(heavy < ENEMY_BASE * 2, `後半の固い敵は2回要る（${heavy.toFixed(0)}）`);
}

console.log('\n[2] 威力を送らせていない');
{
  const cli = src('src/net/client.js');
  ok(/h: heavy \? 1 : undefined/.test(cli), '送るのは印だけ');
  ok(!/damage/.test(cli), '**client.jsが威力という言葉すら持っていない**');

  const idx = src('server/index.js');
  ok(/m\.h === 1/.test(idx), 'サーバーは印を真偽として読む（数として読まない）');
  ok(!/m\.(dmg|damage|mult)/.test(idx), '威力らしき物を受け取っていない');
}

console.log('\n[3] 偽られても間隔が伸びるだけ');
{
  const room = src('server/room.js');
  ok(/const cost = strong \? MELEE_HEAVY\.COST : 1;/.test(room), '強い一撃は発射権を余分に使う');
  ok(/if \(sim\.fireTokens < cost\) return;/.test(room), '足りなければ捨てる');
  ok(/sim\.fireTokens -= cost;/.test(room), '実際に引いている');
  /* **近接以外では効かない。** 銃に強弱は無いので、
     ここを見ていないと「ライフルで威力1.85倍」が通ってしまう */
  ok(/heavy && sim\.def\.melee/.test(room), '**近接以外は強い一撃にならない**');
  ok(/pad: sim\.def\.melee \?/.test(room), '刃の太さも近接の時だけ渡している');
  /* 刃を出す高さは**サーバーが下げる。**申告された位置を直した後に下げているので、
     クライアントを書き換えても位置を稼げない */
  const at = room.indexOf('origin.y -= MELEE_SWEEP.DROP');
  ok(at > 0 && at > room.indexOf('origin.copy(eye)'),
    '**下げるのは位置を直した後**（申告された位置で稼げない）');
}

console.log('\n[4] 1人用と対戦で同じ数字を見ている');
{
  const heavy = heavyDef(SIM_WEAPONS.find((w) => w.id === 'knife'));
  ok(Math.abs(heavy.damage - knife.damage * MELEE_HEAVY.MULT) < 1e-6,
    `サーバーの威力が表と合う（${heavy.damage.toFixed(1)}）`);
  ok(heavy.range === MELEE_SWEEP.HEAVY.reach,
    `右クリックの間合いが表と合う（${heavy.range}m）`);
  ok(knife.range === MELEE_SWEEP.LIGHT.reach,
    `左クリックの間合いが表と合う（${knife.range}m）`);
  ok(heavyDef(SIM_WEAPONS[3]) === heavyDef(SIM_WEAPONS[3]),
    '同じ表からは同じ物が返る（撃つたびに作っていない）');

  const main = src('src/main.js');
  ok(/heavy \? MELEE_HEAVY\.MULT : 1/.test(main),
    '**1人用も同じ倍率を見ている**（片方だけ強い、が起きない）');
  ok(/heavy \? MELEE_SWEEP\.HEAVY : MELEE_SWEEP\.LIGHT/.test(main),
    '**1人用も同じ太さと間合いを見ている**');
  ok(/e\.intersect\(from, dir, sweep \? sweep\.pad : 0\)/.test(main),
    '1人用の敵にも刃の太さを渡している');
  ok(/sendShot\(origin, dir, heavy\)/.test(main), '対戦へは印を渡している');

  const enemy = src('src/ai/enemy.js');
  ok(/HITBOX\.CHEST_R \* s \+ pad/.test(enemy) && /HITBOX\.LEG_R \* s \+ pad/.test(enemy),
    '1人用も胴と脚だけ太らせている');
  ok(/raySphere\(origin, dir, this\._headPos, HITBOX\.HEAD_R \* s\)/.test(enemy),
    '**1人用も頭は太らせていない**');
}

console.log('\n[5] 右クリックが覗きへ流れない');
{
  const w = src('src/player/weapons.js');
  ok(/rightEdge && !d\.thrown && !d\.melee/.test(w),
    '近接の右クリックは覗きの入り切りへ行かない');
  ok(/d\.melee && rightEdge && canFire/.test(w), '近接の右クリックで振る');
  ok(/this\.fireTimer = \(60 \/ d\.rpm\) \* MELEE_HEAVY\.COST/.test(w),
    '手元でも間隔を伸ばす（見た目を合わせるため。本当の縛りはサーバー）');
  // 手榴弾の右クリック（手前投げ）を壊していないか
  ok(/rightEdge && canFire/.test(w), '手榴弾の手前投げは残っている');
}

/* ------------------------------------------------------ 刃の太さ */

console.log('\n[6] 刃には太さがある');
{
  const EYE = HITBOX.STAND_H - 0.16;                 // 目の高さ 1.58
  const from = { x: 0, y: EYE - MELEE_SWEEP.DROP, z: 0 };
  // 正面d先の相手へ、真っ直ぐ水平に振った時に当たるか
  const flat = (d, h, pad, reach, side = 0) => {
    const r = hitPose({ x: side, y: 0, z: -d, h, alive: true }, from, { x: 0, y: 0, z: -1 }, pad);
    return r && r.t <= reach ? r : null;
  };
  // 横へどこまでずれても当たるか
  const lateral = (pad, reach, h = HITBOX.STAND_H) => {
    let last = 0;
    for (let s = 0; s <= 1.4; s += 0.01) if (flat(1.0, h, pad, reach, s)) last = s;
    return last;
  };

  const wasEye = { x: 0, y: EYE, z: 0 };
  let wasLast = 0;
  for (let s = 0; s <= 1.4; s += 0.01) {
    const r = hitPose({ x: s, y: 0, z: -1.0, h: HITBOX.STAND_H, alive: true }, wasEye, { x: 0, y: 0, z: -1 }, 0);
    if (r && r.t <= 1.8) wasLast = s;
  }
  const now = lateral(MELEE_SWEEP.LIGHT.pad, MELEE_SWEEP.LIGHT.reach);
  ok(now > wasLast * 2,
    `横へのずれの許容が倍以上になった（線だと${wasLast.toFixed(2)}m → 掃きで${now.toFixed(2)}m）`);

  /* **しゃがんだ相手に水平のまま当たること。**
     しゃがみの一番高い所は1.15しかないので、目(1.58)から水平に振ると
     太らせても上を通っていた。手の高さから出して初めて届く */
  ok(!!flat(1.0, HITBOX.CROUCH_H, MELEE_SWEEP.LIGHT.pad, MELEE_SWEEP.LIGHT.reach),
    '左: しゃがんだ相手に水平のまま当たる');
  ok(!!flat(1.0, HITBOX.CROUCH_H, MELEE_SWEEP.HEAVY.pad, MELEE_SWEEP.HEAVY.reach),
    '右: しゃがんだ相手に水平のまま当たる');
  ok(MELEE_SWEEP.DROP > 0.20,
    `刃を目より${MELEE_SWEEP.DROP}m下から出している（0.20以下だと右が届かない）`);

  /* **左は広くて近い、右は狭くて遠い。** ここが逆になると
     「右クリックが上位互換」になって左を押す理由が消える */
  ok(MELEE_SWEEP.LIGHT.pad > MELEE_SWEEP.HEAVY.pad,
    `左の方が広い（${MELEE_SWEEP.LIGHT.pad} 対 ${MELEE_SWEEP.HEAVY.pad}）`);
  ok(MELEE_SWEEP.HEAVY.reach > MELEE_SWEEP.LIGHT.reach,
    `右の方が遠い（${MELEE_SWEEP.HEAVY.reach}m 対 ${MELEE_SWEEP.LIGHT.reach}m）`);
  ok(lateral(MELEE_SWEEP.LIGHT.pad, MELEE_SWEEP.LIGHT.reach)
    > lateral(MELEE_SWEEP.HEAVY.pad, MELEE_SWEEP.HEAVY.reach),
    '実際に振っても左の方が横に強い');

  /* **頭を太らせていないこと。** 太らせると頭の球が体を飲み込んで、
     どこを斬っても頭になる（倍率2.6倍が常時掛かる）*/
  const share = (pad, reach) => {
    const n = { 0: 0, 1: 0, 2: 0 };
    let all = 0;
    for (let d = 0.5; d <= reach; d += 0.1) {
      for (let a = -40; a <= 40; a += 2) {
        for (let p = -60; p <= 25; p += 2) {
          const ya = a * Math.PI / 180, pi = p * Math.PI / 180;
          const r = hitPose({ x: 0, y: 0, z: -d, h: HITBOX.STAND_H, alive: true }, from,
            { x: Math.sin(ya) * Math.cos(pi), y: Math.sin(pi), z: -Math.cos(ya) * Math.cos(pi) }, pad);
          if (r && r.t <= reach) { n[r.part]++; all++; }
        }
      }
    }
    return (n[0] / all) * 100;
  };
  const headPct = share(MELEE_SWEEP.LIGHT.pad, MELEE_SWEEP.LIGHT.reach);
  ok(headPct < 15, `頭になるのは当たったうちの${headPct.toFixed(1)}%（狙わないと頭にならない）`);
  ok(headPct > 0.5, `それでも頭は取れる（${headPct.toFixed(1)}%。0だと頭を狙う遊びが消える）`);

  // 壁越しに斬れない。太らせた時だけ体の中心でやり直している
  const sim = src('server/sim.js');
  ok(/if \(bestTarget && pad > 0 && wall\)/.test(sim)
    && /originVisible\(octree, origin, _c\)/.test(sim),
    '**太らせた時は壁の判定を体の中心でやり直す**（角の裏を斬れない）');
  ok(/HITBOX\.HEAD_R\);/.test(sim), 'サーバー側も頭にはpadを足していない');
}

/* ------------------------------------------------------ 振り方 */

console.log('\n[7] 振り方が形ごと・左右ごとに違う');
{
  const need = ['knife.light', 'knife.heavy', 'katana.light', 'katana.heavy',
    'dagger.light', 'dagger.heavy', 'nade.throw'];
  for (const k of need) ok(!!SWINGS[k], `${k} の振り方がある`);

  // 全部の姿勢が揃っているか（1つ欠けるとNaNになって腕が消える）
  let full = true;
  for (const [k, s] of Object.entries(SWINGS)) {
    for (const pose of ['back', 'thru', 'arc']) {
      for (const axis of ['p', 'y', 'r', 'z', 'h']) {
        if (typeof s[pose]?.[axis] !== 'number') { full = false; console.log(`    ${k}.${pose}.${axis} が無い`); }
      }
    }
    if (!(s.time > 0) || !(s.wind > 0 && s.wind < 1)) full = false;
  }
  ok(full, '姿勢と時間が全部揃っている（欠けると腕が飛ぶ）');

  /* **時間は見た目だけ。**間隔より長いと、振り終わる前に次が出て動きが飛ぶ */
  const gap = 60 / knife.rpm;
  ok(SWINGS['knife.light'].time <= gap && SWINGS['katana.light'].time <= gap
    && SWINGS['dagger.light'].time <= gap,
    `左の振りは間隔(${gap.toFixed(2)}秒)に収まっている`);
  const gapH = gap * MELEE_HEAVY.COST;
  ok(SWINGS['katana.heavy'].time <= gapH, `右の振りも間隔(${gapH.toFixed(2)}秒)に収まっている`);

  /* **刀の左は横へ払う。**縦に落とすナイフと同じでは、長い物を持っている感じが出ない */
  const kl = SWINGS['katana.light'];
  const swept = (s, ax) => Math.abs(s.thru[ax] - s.back[ax]);
  ok(swept(kl, 'y') > swept(kl, 'p'),
    `刀の左は**横へ払う**（左右${swept(kl, 'y').toFixed(2)} 対 上下${swept(kl, 'p').toFixed(2)}）`);
  ok(Math.abs(kl.back.r) > 0.8, `刃を寝かせている（捻り${kl.back.r}）`);

  /* **刀の右は突く。**左が横に払う動きなので、右も縦に振ると
     「大きい横薙ぎと小さい横薙ぎ」に見えて差が出にくい。払う／突くで分ける */
  const kh = SWINGS['katana.heavy'];
  ok(swept(kh, 'z') > swept(kh, 'p'),
    `刀の右は**突く**（前後${swept(kh, 'z').toFixed(2)} 対 上下${swept(kh, 'p').toFixed(2)}）`);
  ok(kh.thru.z < kh.back.z, '引いてから前へ出している');

  /* **pの向きを取り違えていないこと。**
     pはプラスで切っ先が上（反動のkickPitchと同じ向き）。
     ここを逆に覚えていたせいで、「真上から落とす」と書いた刀の右クリックが
     **下からえぐる動き**になっていて「ダサい」と言われた。
     突きと払いは切っ先を持ち上げながら入る物ではないので、
     振り抜きで切っ先が大きく上がる動きが残っていないかを見る */
  let scoop = null;
  for (const [k, s] of Object.entries(SWINGS)) {
    if (k === 'nade.throw' || k.endsWith('.light')) continue;   // 投げと払いは別
    if (s.thru.p - s.back.p > 0.9) scoop = k;
  }
  ok(!scoop, scoop ? `${scoop} が下からえぐっている（pが+${(SWINGS[scoop].thru.p - SWINGS[scoop].back.p).toFixed(2)}）`
    : '右クリックに下からえぐる動きが無い');

  // ナイフの右は突き。前へ出す量が、振る量より大きい
  const nh = SWINGS['knife.heavy'];
  ok(swept(nh, 'z') > swept(nh, 'y'),
    `ナイフの右は**突く**（前後${swept(nh, 'z').toFixed(2)} 対 左右${swept(nh, 'y').toFixed(2)}）`);
  ok(nh.thru.z < nh.back.z, '引いてから前へ出している');

  /* **前へ出しすぎないこと。** 構えの位置が-0.52なので、
     0.34も出すと画面から0.86の所まで離れて刃が6割の大きさに縮む（遠近は1/zに効く）。
     突きは「速く出て速く戻る」で見せる物で、遠ざけて見せる物ではない */
  let tooFar = null;
  for (const [k, s] of Object.entries(SWINGS)) {
    if (s.thru.z + Math.min(0, s.arc.z) < -0.28) tooFar = k;
  }
  ok(!tooFar, tooFar ? `${tooFar} が前へ出しすぎ（刃が縮んで見える）` : '前へ出す量が0.28mまでに収まっている');

  // ダガーは速い。ナイフより短く終わる
  ok(SWINGS['dagger.light'].time < SWINGS['knife.light'].time,
    `ダガーの方が速い（${SWINGS['dagger.light'].time}秒 対 ${SWINGS['knife.light'].time}秒）`);

  /* 手榴弾を巻き込んでいないこと。**同じ数字だが別の物**で、
     ナイフの振りを調整した時に投げ方まで動いてはいけない */
  ok(SWINGS['nade.throw'] !== SWINGS['knife.light'], '投げ方はナイフと別に持っている');

  const w = src('src/player/weapons.js');
  /* **割る相手は振り方ごとの長さ。**固定値で割っていた頃、
     0.62秒の強い一撃は最初の0.2秒が止まって見えていた（1を超えて据え置かれる） */
  ok(/clamp01\(this\.swing \/ s\.time\)/.test(w),
    '**振りの進みを、その振り方の長さで割っている**（止まって見えない）');
  ok(!/const SWING_TIME/.test(w), '固定の振り時間はもう無い');
  ok(/swingH - healDrop/.test(w),
    '上下は振りのhを使う（前後の流用だと「前へ出すだけ」が作れない）');
}

console.log('\n[7.5] 走りながら振れる');
{
  /* ナイフは**持っているだけで足が速くなる**物なので（moveMul 1.35）、
     走っている間に振れないと道具として噛み合わない。
     実際に「走ってると振れない」と言われた。銃だけ止める */
  ok(knife.moveMul > 1, `ナイフを持つと速い（${knife.moveMul}倍）`);
  const w = src('src/player/weapons.js');
  ok(/const sprintBlock = player\.sprinting && !\(d\.melee && !d\.thrown\);/.test(w),
    '**止まるのは銃だけ**（刃は走りながら振れる）');
  ok(!/this\.fireTimer <= 0 && !player\.sprinting/.test(w),
    '発射の条件から素の「走っていない」が消えている');
  // 手榴弾は今まで通り。「押して狙って離す」なので走りながらの投げは別の話
  ok(/!\(d\.melee && !d\.thrown\)/.test(w), '手榴弾は今まで通り走ると構えが解ける');
  /* サーバーは元から走りを見ていない（見ているのは発射権だけ）。
     つまりこれは手元の遊び方の決まりで、緩めても穴は開かない */
  const room = src('server/room.js');
  ok(!/sprint/i.test(room), 'サーバーは走りを見ていない（緩めても穴が開かない）');
}

console.log('\n[8] 形スキンで強くならない');
{
  /* コインで買う物なので、持ち替えて強くなると**強さを買える**ことになる。
     振り方と音は変わるが、当たり方の数字はどこにも武器の形が出てこない */
  const w = src('src/player/weapons.js');
  ok(!/MELEE_SWEEP\.\w+\.(pad|reach) \*/.test(w), '太さと間合いに掛け算をしていない');
  const room = src('server/room.js');
  ok(!/skin|shape/.test(room), '**サーバーはスキンを知らない**（知らない物では強くできない）');

  // 実際に刀を着けて確かめる
  setAccount({ owned: ['knife:katana'], equipped: { knife: 'katana' } });
  ok(swingOf('knife', 'light') === SWINGS['katana.light'], '刀を着けると振り方が変わる');
  ok(swingTune('katana', false) !== SWING_TUNE, '刀を着けると音も変わる');
  setAccount({ owned: [], equipped: {} });
  ok(swingOf('knife', 'light') === SWINGS['knife.light'], '外すと元の振り方に戻る');
}

console.log('\n[9] 振る音が形と強さで分かれている');
{
  ok(SWING_TUNE.band[1] > SWING_HEAVY_TUNE.band[1],
    `強い一撃の方が低い（${SWING_TUNE.band[1]} → ${SWING_HEAVY_TUNE.band[1]}Hz）`);
  ok(SWING_HEAVY_TUNE.env[1] > SWING_TUNE.env[1],
    `強い一撃の方が長い（${SWING_TUNE.env[1]} → ${SWING_HEAVY_TUNE.env[1]}秒）`);
  ok(SWING_HEAVY_TUNE.airGain > SWING_TUNE.airGain,
    `強い一撃の方が空気が重い（${SWING_TUNE.airGain} → ${SWING_HEAVY_TUNE.airGain}）`);

  /* **前の版へ戻っていないこと。** 空気が芯と同じ量になると
     低い音が高い音を覆って「ボワッ」に戻る（一度そうなって「鈍い」と言われた） */
  ok(SWING_TUNE.airGain < 0.6, `通常の空気は芯の${SWING_TUNE.airGain}倍まで（1.0で鈍い音に戻る）`);
  ok(SWING_TUNE.band[1] >= 4000, `芯の頂点が${SWING_TUNE.band[1]}Hz（低いと「ゴォ」になる）`);
  ok(SWING_TUNE.q >= 2.0, `帯が細い（Q=${SWING_TUNE.q}。広いとノイズがそのまま鳴る）`);

  // 刀は長く澄んでいる。ダガーは短く高い
  const kl = swingTune('katana', false);
  const dl = swingTune('dagger', false);
  ok(kl.band[1] > SWING_TUNE.band[1], `刀の方が高い（${SWING_TUNE.band[1]} → ${kl.band[1]}Hz）`);
  ok(kl.env[1] > SWING_TUNE.env[1], `刀の方が長い（${SWING_TUNE.env[1]} → ${kl.env[1]}秒）`);
  ok(kl.edge > SWING_TUNE.edge, `刀は刃先が鳴る（${SWING_TUNE.edge} → ${kl.edge}）`);
  ok(dl.env[1] < SWING_TUNE.env[1], `ダガーの方が短い（${SWING_TUNE.env[1]} → ${dl.env[1]}秒）`);
  ok(dl.airGain < SWING_TUNE.airGain, `ダガーは空気が少ない（${SWING_TUNE.airGain} → ${dl.airGain}）`);
  // 全部の形で右の方が低いこと（同じ音を大きくしただけにしない）
  for (const s of ['katana', 'dagger']) {
    ok(swingTune(s, true).band[1] < swingTune(s, false).band[1],
      `${s}も右の方が低い（${swingTune(s, false).band[1]} → ${swingTune(s, true).band[1]}Hz）`);
  }
  // 知らない形はナイフの音へ落ちる（形を足して音を書き忘れても黙って壊れない）
  ok(swingTune('dragon', false) === SWING_TUNE, '知らない形はナイフの音になる');

  const w = src('src/player/weapons.js');
  ok(/swing\?\.\(swingTune\(w\.shapeId, this\.heavy\)\)/.test(w),
    '振った時に形と強さで鳴り分ける');
  /* 形は**構えた時に1回引いて覚えておく。**撃つたびに引き直していた頃、
     skinFor が中で品揃えの配列を毎回作っていた（毎秒12発ぶんのごみ） */
  ok(/this\.shapeId = shapeIdOf\(def\.id\)/.test(w), '形は組み立てた時に1回だけ引く');
  ok(/w\.shapeId = shapeIdOf\(w\.def\.id\)/.test(w), '着け替えた時に引き直している');
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
