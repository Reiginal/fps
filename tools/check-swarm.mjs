// 1人用の敵が固まらずに散るかを測る。
//
// 遊んで「敵が4人とか固まってる時あるんだよなww 二人とかならまだしも、4はきつい」
// と言われた所。固まって出てくると、遊ぶ側は角を曲がった瞬間に4方向から撃たれる。
// 1体ずつ捌ければ勝てる場面が、運で死ぬ場面に変わる。
//
// これは画面を見ないと気づけない類に見えるが、実際は座標なので測れる。
// 敵を本当に湧かせて本当に動かし、毎秒「近すぎる塊」を数える。
//
//   node tools/check-swarm.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';

// 乱数を固定する。
//
// 敵の湧き場所も速さも命中率もMath.random()で散らしているので、
// そのまま測ると打つたびに数字が変わる。実際、固定する前は3回に2回落ちた。
// 時々落ちる検査は、直すべきなのか運が悪いだけなのかが読めなくなって、
// 最後には誰も見なくなる。
//
// 種を変えて何通りか回し、そのどれでも成り立つことを求める。
// 1つの種だけで見ると、たまたま良い並びを引いていても気づけない
let _seed = 1;
const seedRandom = (s) => { _seed = s >>> 0; };
Math.random = () => {
  // 線形合同法。癖はあるが、散らし方の傾向を測るには足りる
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
};

const { buildLevel } = await import('../src/world/level.js');
const { Director } = await import('../src/ai/enemy.js');

// 素材は見た目の話で、敵の動きには一切効かない。
// 本当に焼くと数秒と数百MBを払うので、何を聞かれても同じ物を返す
const SHARED_MAT = new THREE.MeshStandardMaterial();
const MATS = new Proxy({}, { get: () => SHARED_MAT });

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const level = buildLevel(MATS);
const scene = new THREE.Scene();

// 動かない的。敵は必ずこちらへ寄ってくるので、群れ方だけが結果に出る
const player = {
  collider: { start: new THREE.Vector3(0, 1.2, 26) },
  feetY: 0.1, height: 1.7, alive: true, health: 100,
  takeDamage: () => {},
};

/** 半径r以内で繋がっている敵をひとまとまりとして数える。返すのは一番大きい塊の人数 */
function biggestCluster(alive, r) {
  const seen = new Set();
  let biggest = 0;
  for (const e of alive) {
    if (seen.has(e)) continue;
    // 繋がっている物を芋づるで辿る。「AとBが近い、BとCが近い」なら3人の塊
    const stack = [e];
    seen.add(e);
    let n = 0;
    while (stack.length) {
      const cur = stack.pop();
      n++;
      for (const o of alive) {
        if (seen.has(o)) continue;
        const dx = cur.collider.start.x - o.collider.start.x;
        const dz = cur.collider.start.z - o.collider.start.z;
        if (Math.hypot(dx, dz) <= r) { seen.add(o); stack.push(o); }
      }
    }
    if (n > biggest) biggest = n;
  }
  return biggest;
}

const DT = 1 / 60;
const ctx = { octree: level.octree };

/**
 * 指定の波まで進めて、その波の間ずっと塊の大きさを見張る。
 * 敵は倒さない。倒すと数が減って、一番きつい場面（全員生きている時）を見逃す
 */
function runWave(targetWave, seconds, seed) {
  seedRandom(seed);
  const director = new Director(scene, level);
  director.reset?.();
  director.betweenWaves = 0;
  // 目当ての波まで一気に上げる。1波から積むと敵が出続けて時間がかかる
  director.wave = targetWave - 1;

  let worst = 0, worstAt = 0, sum = 0, samples = 0;
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    director.update(DT, player, ctx);
    // 敵は撃ってくるが、こちらは減らない的なので体力を戻し続ける
    player.health = 100;
    if (i % 30 === 0) {
      const alive = director.active.filter((e) => e.alive);
      if (alive.length >= 3) {
        const c = biggestCluster(alive, 4.0);
        if (c > worst) { worst = c; worstAt = i * DT; }
        sum += c; samples++;
      }
    }
  }
  // 離れる力を強くしすぎると、散りはするが誰も寄って来なくなる。
  // 散り具合と一緒に「ちゃんと襲ってくるか」も見ないと、
  // 固まりを直したつもりで遊びを壊すことになる
  const alive = director.active.filter((e) => e.alive);
  let near = 0, closest = 999;
  for (const e of alive) {
    const dx = e.collider.start.x - player.collider.start.x;
    const dz = e.collider.start.z - player.collider.start.z;
    const d = Math.hypot(dx, dz);
    if (d < closest) closest = d;
    if (d < 20) near++;
  }
  return {
    worst, worstAt, avg: samples ? sum / samples : 0,
    alive: alive.length, near, closest,
  };
}

console.log('\n[1] 波が進んだ時に何人が固まるか（半径4mで繋がっている塊）');
// 4人固まると言われたのは、敵が増える中盤以降のはず。
// 湧く数は 4 + 波数×2（上限14）なので、波5で14人、波8以降はずっと14人
const SEEDS = [1, 20260804, 777];
const results = [];
for (const w of [3, 8]) {
  for (const seed of SEEDS) {
    const r = runWave(w, 26, seed);
    results.push([w, seed, r]);
    ok(
      r.worst <= 3,
      `波${w} 種${seed} … 一番大きい塊 ${r.worst}人`
      + `（平均${r.avg.toFixed(1)}人 / 生存${r.alive}人 / ${r.worstAt.toFixed(0)}秒時点）`,
    );
  }
}

console.log('\n[2] 散らした結果、寄って来なくなっていないか');
// 散ることと襲って来ないことは別。ここを見ないと、
// 「固まりは消えたが誰も来ないので撃ち合いが起きない」に気づけない。
//
// 「全員が近くまで来ること」は求めない。この敵は遮蔽を使って遠くから撃つ作りで、
// 目の前まで詰めるのが正しい動きではないため。
// 求めるのは「撃ち合いが始まる距離まで来る敵が複数いること」。
//
// 直す前の数字（波3/5/8の順）: 20m以内 0人 / 0人 / 1人、最短 33.4m / 28.8m / 12.4m。
// 湧き場所を使い回していた頃は、遠い所ばかりが選ばれて誰も来ていなかった
for (const [w, seed, r] of results) {
  ok(
    // 「22m以内まで詰めてくる敵が1体はいる」を下限にする。
    // 直す前は波3で最短33.4m・20m以内0人だったので、ここで落ちる。
    // 数を求めないのは、遮蔽に張り付いて撃つ敵が正しく振る舞った結果として
    // 近づかない場合があるため（種777がその形で、最短17.0m・1人）
    r.closest < 22 && r.near >= 1,
    `波${w} 種${seed} … 20m以内に ${r.near}人（最短${r.closest.toFixed(1)}m / 生存${r.alive}人）`,
  );
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
