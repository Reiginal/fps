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
import * as THREE from 'three';
import { MELEE_HEAVY, MELEE_SWEEP, HITBOX, HP } from '../src/net/protocol.js';
import { WEAPONS as SIM_WEAPONS, heavyDef, hitPose } from '../server/sim.js';
import { WEAPONS, SWINGS, swingOf, WeaponSystem } from '../src/player/weapons.js';
import { setAccount } from '../src/player/skins.js';
import { SWING_TUNE, SWING_HEAVY_TUNE, SWING_TUNES, swingTune } from '../src/core/audio.js';

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

  /* **斧の左は振り下ろす。** 上のえぐり判定は`.light`を飛ばすので
     （払いは切っ先が上がって正しい）、縦に落とす物だけ名指しで見る。

     2026-08-11に足した。斧を作った時、`-0.95 → +1.05`と書いて
     **下からえぐり上げる動きにしていた**（刀の右クリックで
     「真上から落とす」と書きながら同じ間違いをしたのと同じ形）。
     pはプラスで切っ先が上なので、落とすなら thru < back になる */
  const al = SWINGS['axe.light'];
  ok(al.thru.p < al.back.p,
    `斧の左は振り下ろす（切っ先が ${al.back.p} → ${al.thru.p}。下がっている）`);
  ok(swept(al, 'p') > swept(al, 'y'),
    `斧の左は**縦の軌道**（上下${swept(al, 'p').toFixed(2)} 対 左右${swept(al, 'y').toFixed(2)}）`);

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
  /* **並びではなく中身を見る。** 前は `swingH - healDrop` という
     隣り合わせを正規表現で見ていたが、姿勢に層を1つ足した時に
     間へ別の項が入って落ちた（意図は守れているのに落ちる形）。
     見たいのは「上下に振りのhを使っていること」と
     「前後(swingZ)の半分を流用していないこと」の2つなので、そこだけを見る */
  ok(/swingH/.test(w), '上下に振りのhを使っている');
  ok(!/swingZ \* 0\.5/.test(w),
    '前後(swingZ)の半分を上下へ流用していない（「前へ出すだけ」が作れなくなる）');
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
  /* 全部の形で右の方が低いこと（同じ音を大きくしただけにしない）。
     **表そのものから引く。** ここに名前をべた書きしていたせいで、
     2026-08-11に足した3つ（レイピア・斧・グローブ）がこの検査を素通りしていた */
  for (const s of Object.keys(SWING_TUNES)) {
    ok(swingTune(s, true).band[1] < swingTune(s, false).band[1],
      `${s}も右の方が低い（${swingTune(s, false).band[1]} → ${swingTune(s, true).band[1]}Hz）`);
  }

  /* **5つの形が、狙った順番に並んでいるか。**
     2026-08-12に測ったら、刀の右(886ms/重心6260Hz)とダガーの右(886/6265)が
     **数字の上でほぼ同じ音**だった。見た目を5つに分けても、
     音が2つ同じなら着け替えた実感はそのぶん減る。

     並びの意図（audio.jsのコメントの通り）:
       高さ … レイピア > ダガー > 刀 > ナイフ > 斧
       長さ … 斧 > 刀 > ナイフ > レイピア・ダガー
       重さ … 斧が一番。空気の層(airGain)で持つ */
  const T = (s, h = false) => (s === 'knife' ? (h ? SWING_HEAVY_TUNE : SWING_TUNE) : swingTune(s, h));
  const higher = [['rapier', 'dagger'], ['dagger', 'katana'], ['katana', 'knife'], ['knife', 'axe']];
  for (const [a, b] of higher) {
    ok(T(a).band[1] > T(b).band[1],
      `${a}の方が${b}より高い（${T(b).band[1]} → ${T(a).band[1]}Hz）`);
  }
  ok(T('axe').env[1] > T('katana').env[1] && T('katana').env[1] > T('knife').env[1],
    `長さは 斧${T('axe').env[1]} > 刀${T('katana').env[1]} > ナイフ${T('knife').env[1]}秒`);
  ok(T('dagger').env[1] < T('rapier').env[1],
    `ダガーが一番短い（レイピア${T('rapier').env[1]} → ダガー${T('dagger').env[1]}秒）`);
  for (const s of ['katana', 'dagger', 'rapier', 'glove']) {
    ok(T('axe', true).airGain > T(s, true).airGain,
      `斧の空気が${s}より重い（${T(s, true).airGain} → ${T('axe', true).airGain}）`);
  }
  /* **拳は刃の鳴きを持たない。** ここが残っていると、
     刃物と同じ「シュッ」が拳から鳴る（測った時に帯が900〜3400Hzに居た） */
  ok(T('glove').edge < 0.10, `グローブは刃先が鳴らない（edge=${T('glove').edge}）`);
  ok(T('glove').band[1] < T('knife').band[1] * 0.5,
    `グローブの帯はナイフの半分より下（${T('knife').band[1]} → ${T('glove').band[1]}Hz）`);

  /* **書き出す側にも全部並んでいるか。** 音を足した人が
     tools/sound-lab.mjs にも名前を写す手順だったので、
     2026-08-11に足した3つは**一度も測られていなかった**（2026-08-12に気づいた）。
     測れない音は「ダサい」と言われた時に勘で直すことになる */
  const lab = src('tools/sound-lab.mjs');
  ok(/for \(const shape of Object\.keys\(SWING_TUNES\)\)/.test(lab),
    '振る音は表から引いて書き出している（名前のべた書きではない）');
  // 知らない形はナイフの音へ落ちる（形を足して音を書き忘れても黙って壊れない）
  ok(swingTune('dragon', false) === SWING_TUNE, '知らない形はナイフの音になる');

  const w = src('src/player/weapons.js');
  ok(/swing\?\.\(swingTune\(w\.shapeId, this\.heavy\)\)/.test(w),
    '振った時に形と強さで鳴り分ける');
  /* 形は**構えた時に1回引いて覚えておく。**撃つたびに引き直していた頃、
     skinFor が中で品揃えの配列を毎回作っていた（毎秒12発ぶんのごみ）。
     観戦用の素の模型を足した時に `plain ? null :` が前に付いたので、
     **代入の左辺だけを見る形にしてある**（右辺の条件が増えても効き続ける） */
  ok(/this\.shapeId = [^;]*shapeIdOf\(def\.id\)/.test(w), '形は組み立てた時に1回だけ引く');
  // 撃つたびに引き直していないこと。ここが本題（上は「1回引く」しか見ていない）
  ok(!/_fire\([^)]*\)\s*\{[\s\S]{0,3000}?shapeIdOf\(/.test(w),
    '撃つ処理の中で形を引き直していない');
  ok(/w\.shapeId = shapeIdOf\(w\.def\.id\)/.test(w), '着け替えた時に引き直している');
}

console.log('\n[当たるタイミング] 刃が届いてから判定が出ているか');
{
  /* 2026-08-11に足した。**「押した瞬間にダメージが入っている」と言われて、本当だった。**

     振りは2段（振りかぶり → 振り抜き）で、刃が一番遠くへ届くのは
     wind + (1/speed)*(1-wind) の所。判定はそこで出す（weapons.jsの_strikeDelay）。
     直す前は全部0秒に出ていて、刀の右クリックは**0.40秒も先走っていた。**

     **通っている時点では何も見えない類の不具合。** 当たるし、倒れるし、
     エラーも出ない。ただ「突き出す前に倒れている」だけなので、
     画面を見ないと分からない。だから数字で残す */
  /* **本文を読む形では駄目だった。** 最初は
       「_startSwing('heavy') の次の行が _fire でないこと」を正規表現で見ていたが、
     直したコードを元へ戻して確かめたら**素通りした。**
     間にコメントが1行挟まるだけで並びが変わるので、当たっていなかった。

     なので実際に振らせて、判定が飛んだ時刻を測る。
     見たいのは「押してすぐ出ていないこと」なので、そこを直接数える方が短い */
  const shots = [];
  const ws = new WeaponSystem(new THREE.Scene(),
    new THREE.PerspectiveCamera(75, 1.6, 0.05, 900),
    new THREE.PerspectiveCamera(55, 1.6, 0.002, 12), new THREE.Scene());
  ws.carry = ws.weapons.map((_, i) => i);
  ws.onShot = () => shots.push(now);
  const knifeIndex = WEAPONS.findIndex((x) => x.id === 'knife');
  ws.switchTo(knifeIndex);
  ws.switching = 0; ws.index = knifeIndex; ws._pendingIndex = null;

  const player = {
    alive: true, sprinting: false, crouching: false, onFloor: true, horizontalSpeed: 0,
    adsFactor: 0, moveMul: 1, roll: 0, healing: 0, bandages: 2, yaw: 0, pitch: 0,
    bobAmount: 0, bobPhase: 0, addRecoil: () => {}, cancelHeal: () => {},
    startHeal: () => false, collider: { start: new THREE.Vector3() },
  };
  /* 右クリックを1回だけ押す入力。
     **押しっぱなしにしない。** 右クリックは clicked(2)（押した瞬間だけtrue）で
     読まれるので、毎フレームtrueを返すと連打になって何回も振る */
  let clickedOnce = false;
  const tap = {
    down: () => false,
    pressed: () => false,
    clicked: (b) => {
      if (b === 2 && !clickedOnce) { clickedOnce = true; return true; }
      return false;
    },
    buttons: [false, false, false],
  };
  const DT = 1 / 240;
  let now = 0;
  // 0.7秒ぶん回す。一番遅い刀の右(0.40秒)より充分長い
  for (let i = 0; i < 168; i++) { ws.update(DT, tap, player, {}); now += DT; }

  ok(shots.length >= 1, `振ったら判定が出る（${shots.length}回）`);
  /* **ここが本題。** 押した最初のフレームで出ていたら元の不具合。
     ナイフの右は0.36秒後に届くので、0.2秒より手前で出たらおかしい */
  ok(shots.length >= 1 && shots[0] > 0.2,
    `最初の判定が ${(shots[0] ?? 0).toFixed(3)}秒後（0.2秒より後）`);
  // 表から出した狙いの時刻と合っているか。1フレームぶんの誤差は許す
  const want = (() => { const s = swingOf('knife', 'heavy', null); return (s.wind + (1 / s.speed) * (1 - s.wind)) * s.time; })();
  ok(shots.length >= 1 && Math.abs(shots[0] - want) < 0.02,
    `狙いの ${want.toFixed(3)}秒 と合っている（ずれ ${Math.abs((shots[0] ?? 0) - want).toFixed(3)}秒）`);

  const w = src('src/player/weapons.js');
  // 銃は待たせないこと。待たせると撃ち味が丸ごと変わる
  ok(/if \(d\.melee && !d\.thrown\) this\.strikeIn = this\._strikeDelay\(\);/.test(w),
    '**銃と手榴弾は待たせていない**（弾は引金を引いた瞬間に出る物）');
  // 持ち替えと死亡で捨てること。捨てないと銃を構えた状態で刃の判定が飛ぶ
  ok((w.match(/this\.strikeIn = 0;/g) || []).length >= 3,
    '待っている判定を、持ち替えと片付けで捨てている');

  /* 実際の秒数。**表から計算して出す。**
     ここに数字を書き写すと、SWINGSを触った時に片方だけ古くなる */
  const delayOf = (s) => (s.wind + (1 / s.speed) * (1 - s.wind)) * s.time;
  const rows = [
    ['ナイフ', 'knife'], ['日本刀', 'katana'], ['ダガー', 'dagger'],
  ];
  for (const [name, shape] of rows) {
    for (const kind of ['light', 'heavy']) {
      const s = swingOf('knife', kind, shape === 'knife' ? null : shape);
      const d = delayOf(s);
      /* 下限: 0.08秒。ここを割ると「押した瞬間」と区別が付かない。
         上限: 0.45秒。**待たせすぎると当たらない武器になる**
         （相手は毎秒6m動くので、0.5秒待つと3m逃げられる。間合いは1.9〜2.5m） */
      ok(d > 0.08 && d < 0.45,
        `${name}${kind === 'heavy' ? '右' : '左'} … 刃が届くのは ${d.toFixed(2)}秒後（0.08〜0.45）`);
    }
  }
  /* **右は左より遅いこと。** 右は「遅いが重い一撃」なので、
     振りかぶりが相手から見えていないと避ける手が無い（MELEE_HEAVYの説明の通り） */
  for (const [name, shape] of rows) {
    const l = delayOf(swingOf('knife', 'light', shape === 'knife' ? null : shape));
    const h = delayOf(swingOf('knife', 'heavy', shape === 'knife' ? null : shape));
    ok(h > l, `${name} … 右(${h.toFixed(2)}秒)の方が左(${l.toFixed(2)}秒)より遅く届く`);
  }
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
