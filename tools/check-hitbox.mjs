// 見えている兵士と、サーバーの当たり判定が合っているかを測る。
//
// なぜ要るか: 遊んで「ヘッドショットの判定がデカすぎる」と言われた所。
// 調べたら大きさの問題ではなく、**位置がずれていた**。
//
// 兵士は個体差で0.94〜1.12倍に伸び縮みするのに、サーバーの当たり判定は
// 身長1.74m固定だった。実測すると、大柄なキャラでは頭の判定(1.42〜1.72m)と
// 見えている頭(1.72〜2.03m)が1cmも重なっていなかった。
// 見えている頭を撃っても頭にならず、胸のあたりを撃つと頭になる。
// 遊ぶ側からは「頭の判定が下まで伸びている＝デカすぎる」としか見えない。
//
// この手のずれは、画面を見ても本人には絶対に分からない（当たり判定は見えない）。
// だから数字で押さえる。
//
//   node tools/check-hitbox.mjs
import '../server/dom-stub.js';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { HITBOX, CHARACTERS, PART } from '../src/net/protocol.js';

const { buildLevel } = await import('../src/world/level.js');
const { RemotePlayers } = await import('../src/net/remote.js');
const { hitPose } = await import('../server/sim.js');
const { WEAPONS } = await import('../src/player/weapons.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const MAT = new THREE.MeshStandardMaterial();
const level = buildLevel(new Proxy({}, { get: () => MAT }));

/* 本物のRemotePlayersを動かして、出てきた兵士を測る。
   ここで寸法合わせを自前に書き直してはいけない。
   **同じ計算を検査側にも書くと、remote.jsを壊しても検査は通ってしまう。**
   実際、最初はそう書いていて、remote.jsを元に戻しても検査が通った */
const scene = new THREE.Scene();
const remotes = new RemotePlayers(scene, level);

const fitted = (chr) => {
  const id = 100 + chr;
  remotes.setChars(new Map([[id, chr]]));
  remotes.sync([{
    id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, hp: 100, weapon: 0,
  }], -1, null);
  const e = remotes.slots.get(id).enemy;
  e.root.position.set(0, 0, 0);
  e.root.updateMatrixWorld(true);
  return e;
};

console.log('\n[1] 見た目の身長が、判定の身長と揃っている');
// ここが揃っていないと、頭も胴も全部ずれる。大元の条件
for (let i = 0; i < CHARACTERS.length; i++) {
  const e = fitted(i);
  ok(
    Math.abs(e.height - HITBOX.STAND_H) < 0.01,
    `${i}番 … 身長 ${e.height.toFixed(2)}m（判定は ${HITBOX.STAND_H}m）`,
  );
}

console.log('\n[2] 見えている頭と、判定の頭が重なっている');
const hitLo = HITBOX.STAND_H * HITBOX.HEAD_AT - HITBOX.HEAD_R;
const hitHi = HITBOX.STAND_H * HITBOX.HEAD_AT + HITBOX.HEAD_R;
console.log(`  判定の頭: ${hitLo.toFixed(2)}〜${hitHi.toFixed(2)}m`);
for (let i = 0; i < CHARACTERS.length; i++) {
  const e = fitted(i);
  const b = new THREE.Box3().setFromObject(e.parts.headPivot);
  const ov = Math.max(0, Math.min(b.max.y, hitHi) - Math.max(b.min.y, hitLo));
  const pct = (ov / (b.max.y - b.min.y)) * 100;
  // 8割を下限にする。ヘルメットの天辺まで完全に覆う必要は無いが、
  // 見えている頭の大半が判定に入っていないと「当たらない」と感じる
  ok(pct >= 80, `${i}番 … 見えている頭 ${b.min.y.toFixed(2)}〜${b.max.y.toFixed(2)}m の ${pct.toFixed(0)}% が判定内`);
}

console.log('\n[3] 頭の判定が、見えている頭より大きくなりすぎていない');
// 逆に広げすぎると、今度は本当に「デカすぎる」になる。
// 判定の球が、見えている頭の高さの2倍を超えていたら広げすぎ
for (let i = 0; i < CHARACTERS.length; i++) {
  const e = fitted(i);
  const b = new THREE.Box3().setFromObject(e.parts.headPivot);
  const seen = b.max.y - b.min.y;
  const box = HITBOX.HEAD_R * 2;
  ok(box <= seen * 2, `${i}番 … 判定 ${(box * 100).toFixed(0)}cm / 見た目 ${(seen * 100).toFixed(0)}cm`);
}

console.log('\n[3.5] 相手が武器を持ち替えると見た目が変わる');
// 武器の番号はずっと届いていたのに、受け取った側が使っていなかった所。
// 「同時に出るのは1つだけ」も見る。2つ出ると、ナイフを持ちながら銃も構えている絵になる
{
  const id = 900;
  remotes.setChars(new Map([[id, 0]]));
  const holdOf = (w) => {
    remotes.sync([{ id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, state: 0, hp: 100, weapon: w }], -1, null);
    const p = remotes.slots.get(id).enemy.parts;
    return [
      p.gun.visible && 'ライフル',
      p.gunShotgun.visible && '散弾銃',
      p.heldKnife.visible && 'ナイフ',
      p.heldNade.visible && '手榴弾',
    ].filter(Boolean);
  };
  // **番号ではなくidで見る。** 番号を直書きすると、武器を1本足しただけで
  // 後ろが全部ずれて、検査のほうが嘘になる（実際ピストルを足した時にそうなった）。
  //
  // 専用の見た目を持つのは散弾銃・ナイフ・手榴弾の3つで、それ以外は
  // まとめてライフルの形で出す。**大事なのは「必ず1つだけ出る」ほう。**
  // 0個だと素手で構えて撃つ絵になり、2個だとナイフを持ちながら銃も構える絵になる
  const OWN = { shotgun: '散弾銃', knife: 'ナイフ', nade: '手榴弾' };
  WEAPONS.forEach((d, w) => {
    const want = OWN[d.id] || 'ライフル';
    const shown = holdOf(w);
    ok(shown.length === 1 && shown[0] === want,
      `${w}番(${d.id})を持つと「${shown.join('と') || '何も出ない'}」が見える（欲しいのは${want}）`);
  });
  // 知らない番号が来ても素手にはしない。取りこぼしや将来の追加で
  // 「何も持っていないのに撃ってくる」相手が出ないようにする
  ok(holdOf(WEAPONS.length + 5).length === 1, '知らない番号でも必ず1つ出る');
  // 持ち替えて戻れること。1回変えたら戻らない作りになっていないか
  ok(holdOf(0)[0] === 'ライフル', 'ライフルへ戻せる');
}

console.log('\n[5] 1人用の敵も、対戦と同じ形と決まりで判定している');
/* 遊んで「ヘッドショット判定お互いガバガバだったりしないよね？」と聞かれて測った所。
   **1人用だけ別物だった。** しかも太いほうではなく、頭が当たらないほうへ壊れていた。

   1つ目: 太さが対戦と違った（頭が半径0.19。対戦は0.15）。
   2つ目: **こちらが本題。** 当たりを「一番手前の部位」だけで決めていた。
   胴のカプセルは上端が丸く、その丸みが頭の下半分を覆っている。
   太いぶん撃つ側から見た面が頭の球より手前に来るので、
   **顔の高さを正面から撃つと胴判定**になっていた。
   実測では、頭の球が直径32cmあるのに頭になるのは上の11cmだけ。

   サーバー側(hitPose)には最初から「頭は手前の部位より少し後ろでも優先する」
   という決まりがあり、1人用にはそれが無かった。同じ決まりを入れて揃える。

   ここでは実際にレイを撃って測る。コードの数字を読むだけだと、
   「読んでいる場所が違う」も「決まりが無い」も見逃す */
{
  const { Enemy } = await import('../src/ai/enemy.js');
  const src = readFileSync(new URL('../src/ai/enemy.js', import.meta.url), 'utf8');
  ok(/HITBOX\.HEAD_R \* s/.test(src) && /HITBOX\.CHEST_R \* s/.test(src),
    '太さを共有の表(HITBOX)から取っている');
  ok(/HEAD_SPAN/.test(src), '頭を優先する決まりを持っている');

  const dir = new THREE.Vector3(0, 0, -1);
  for (let c = 0; c < CHARACTERS.length; c++) {
    const e = new Enemy(level, { variant: c });
    e.spawn(new THREE.Vector3(0, 0, 0));
    e.root.position.set(0, 0, 0);
    e.root.updateMatrixWorld(true);
    // 実際に動いている時と同じ、骨から作る判定で測る
    e._syncHitboxesFromBones();
    const s = e.bodyScale;
    const r = HITBOX.HEAD_R * s;
    const hy = e._headPos.y;

    // 真正面から水平に撃つ。高さを変えながらどこ判定になるかを拾う
    const at = (y, x = 0) => e.intersect(new THREE.Vector3(x, y, 3), dir)?.part ?? null;

    ok(at(hy) === 'head', `${c}番 … 顔の高さ(${hy.toFixed(2)}m)を撃つと頭`);
    ok(at(hy - r - 0.03) === 'chest', `${c}番 … 頭の球より下は胴`);

    // 頭になる帯の厚み。球の直径とほぼ同じであること
    let band = 0;
    for (let y = hy - 0.5; y <= hy + 0.5; y += 0.005) if (at(y) === 'head') band += 0.005;
    ok(Math.abs(band - r * 2) < 0.04,
      `${c}番 … 頭になる帯 ${(band * 100).toFixed(0)}cm（球は直径${(r * 200).toFixed(0)}cm）`);

    // 見えている頭と比べる。基準は[3]と同じ（見た目の高さの2倍まで）
    const b = new THREE.Box3().setFromObject(e.parts.headPivot);
    const seen = b.max.y - b.min.y;
    ok(r * 2 <= seen * 2,
      `${c}番 … 判定 ${(r * 200).toFixed(0)}cm / 見た目 ${(seen * 100).toFixed(0)}cm`);
  }

  /* 頭を優先すると言っても限度がある。
     **体を貫いた先の頭まで拾ってはいけない。**
     真下から脚越しに撃った弾が頭判定になると、足元を撃つのが最適解になる */
  {
    const e = new Enemy(level, { variant: 0 });
    e.spawn(new THREE.Vector3(0, 0, 0));
    e.root.position.set(0, 0, 0);
    e.root.updateMatrixWorld(true);
    e._syncHitboxesFromBones();
    const from = new THREE.Vector3(0, -2.5, 0.001);
    const up = new THREE.Vector3(0, 1, 0).normalize();
    const part = e.intersect(from, up)?.part ?? null;
    ok(part === 'legs', `真下から撃つと脚（${part}）`);
  }
}

console.log('\n[4] 当たった弾のうち頭になる割合');
// 割合そのものに正解は無いが、跳ね上がった時に気づけるように数字を出す。
// 実測: 直す前も後も9%前後。位置が直っただけで、広さは変えていない
{
  const pose = { x: 0, y: 0, z: 0, h: HITBOX.STAND_H };
  const origin = { x: 0, y: 1.6, z: 12 };
  let head = 0, hit = 0;
  const N = 240;
  for (let iy = 0; iy < N; iy++) {
    for (let ix = 0; ix < N; ix++) {
      const tx = -0.5 + (ix / (N - 1)) * 1.0;
      const ty = (iy / (N - 1)) * 2.0;
      const d = { x: tx - origin.x, y: ty - origin.y, z: -origin.z };
      const L = Math.hypot(d.x, d.y, d.z);
      d.x /= L; d.y /= L; d.z /= L;
      const r = hitPose(pose, origin, d);
      if (!r) continue;
      hit++;
      if (r.part === PART.HEAD) head++;
    }
  }
  const pct = (head / hit) * 100;
  ok(pct > 4 && pct < 16, `頭になるのは ${pct.toFixed(1)}%（4〜16%に収まっている）`);
}

console.log('\n[軽さ] 判定づくりのために全身の行列を強制計算し直していない');
/* root.updateMatrixWorld(true)は69個の節を毎回強制で計算し直すうえ、
   同じフレームの描画時にthree側がもう一度計算する（二重払い）。
   getWorldPosition()が先祖の行列を自分で計算するので、読みたい骨のぶんで足りる。
   1体2〜3回×最大22体で毎フレーム4千回を超える行列合成になっていた */
{
  const { readFileSync } = await import('node:fs');
  const enemy = readFileSync(new URL('../src/ai/enemy.js', import.meta.url), 'utf8');
  const remote = readFileSync(new URL('../src/net/remote.js', import.meta.url), 'utf8');
  ok(!/this\.root\.updateMatrixWorld\(true\)/.test(enemy), '敵側に全身の強制計算が無い');
  ok(!/^\s*root\.updateMatrixWorld\(true\)/m.test(remote), '対戦の相手側にも無い');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
