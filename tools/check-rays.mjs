// 地形レイの検査。octreeのレイと、メッシュ544枚総当たりのレイが同じ答えを返すか。
//
// なぜ要るか: 手榴弾の弧・敵の発砲・散弾の解決を、総当たり(1本0.2ms)から
// octree(main.jsの_terrainRay)へ乗せ替えた。速くなっても答えが変わっていたら、
// 「壁の向こうから撃たれる」「軌道の線と実際の落ち方がずれる」という
// 画面を見ても気づきにくい壊れ方をする。ここで数百本のレイを両方で飛ばして突き合わせる。
//
//   node tools/check-rays.mjs
import '../server/dom-stub.js';
import * as THREE from 'three';

// 乱数を固定する（check-swarm.mjsと同じ理由: 時々落ちる検査は誰も見なくなる）
let _seed = 7;
const rand = () => {
  _seed = (_seed * 1664525 + 1013904223) >>> 0;
  return _seed / 4294967296;
};

const { buildLevel } = await import('../src/world/level.js');

// 素材は当たり判定に効かないので焼かない（check-swarm.mjsと同じ）。
// sideは既定(表面のみ)のまま。octreeのレイは三角形の裏面を素通しするので、
// メッシュ側も裏面を間引く既定と揃えないと、箱の裏から入るレイだけ答えが割れる
// （最初DoubleSideで書いて、実際に11本割れた）
const SHARED_MAT = new THREE.MeshStandardMaterial();
const MATS = new Proxy({}, { get: () => SHARED_MAT });

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const level = buildLevel(MATS);

/* 比べる相手は「衝突に参加する物」(level.solids)にする。
   propsの飾り（電線・アンテナ・路面の貼り分け）は octree に入っていない。
   乗せ替え前は弾だけがこの飾りに当たっていた——つまり
   **歩いて通れるのに弾は止まる**という非対称が残っていた。
   乗せ替え後は弾も手榴弾も移動も同じ octree を見るので、この非対称ごと消えている。
   これは意図した挙動変更（見た目の実害は、電線に着弾の火花が出なくなる程度）。

   visibleでは絞らない。solidsには「描かないがOctreeには入る」床がある
   （level.jsのfloor.visible = false）。見えるかどうかと当たるかどうかは別の話 */
const solidMeshes = [];
level.solids.traverse((o) => { if (o.isMesh) solidMeshes.push(o); });
// main.jsのthis.solidMeshesと同じ集め方（見える物全部）。面の取り直し[2]で使う
const visibleMeshes = [];
level.root.traverse((o) => { if (o.isMesh && o.visible) visibleMeshes.push(o); });
level.root.updateMatrixWorld(true);

const raycaster = new THREE.Raycaster();
const ray = new THREE.Ray();

// 場内のそれっぽい所からそれっぽい向きへ。撃ち合いと同じ高さ帯を中心にする
const N = 300;
const cases = [];
for (let i = 0; i < N; i++) {
  const origin = new THREE.Vector3(
    (rand() - 0.5) * 76,
    0.4 + rand() * 7,
    (rand() - 0.5) * 76,
  );
  const dir = new THREE.Vector3(rand() - 0.5, (rand() - 0.5) * 0.6, rand() - 0.5);
  if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
  dir.normalize();
  cases.push({ origin, dir, far: 5 + rand() * 75 });
}

console.log(`\n[1] octreeと総当たりが同じ答えを返す（${N}本）`);
{
  let both = 0, neither = 0, onlyOct = 0, onlyMesh = 0, apart = 0;
  let worst = 0;
  for (const c of cases) {
    ray.origin.copy(c.origin);
    ray.direction.copy(c.dir);
    const oh = level.octree.rayIntersect(ray);
    const octHit = oh && oh.distance <= c.far ? oh : null;

    raycaster.set(c.origin, c.dir);
    raycaster.far = c.far;
    const mh = raycaster.intersectObjects(solidMeshes, false);
    const meshHit = mh.length ? mh[0] : null;

    if (octHit && meshHit) {
      both++;
      const d = Math.abs(octHit.distance - meshHit.distance);
      worst = Math.max(worst, d);
      if (d > 0.05) apart++;
    } else if (!octHit && !meshHit) neither++;
    else if (octHit) onlyOct++;
    else onlyMesh++;
  }
  ok(onlyOct === 0, `octreeだけが当たる本数 ${onlyOct}（0であること。あると見えない壁に当たる）`);
  ok(onlyMesh === 0, `総当たりだけが当たる本数 ${onlyMesh}（0であること。あるとすり抜ける）`);
  ok(apart === 0, `距離が5cm以上ずれた本数 ${apart}（一番ずれた所 ${(worst * 100).toFixed(2)}cm）`);
  console.log(`  （両方当たり ${both}本／両方外れ ${neither}本）`);
}

console.log('\n[2] 当たった面をメッシュ側で取り直せる（材質と面の向きの回収）');
/* octreeの三角形は「どのメッシュ(=材質)の物か」を知らない。
   main.jsの_meshNearは、当たりの0.5m手前から短いレイを撃ち直して同じ面を拾う。
   その取り直しが同じ場所に当たることを見る */
{
  let recovered = 0, tried = 0, near = 0, decor = 0, worst = 0;
  const from = new THREE.Vector3();
  for (const c of cases) {
    ray.origin.copy(c.origin);
    ray.direction.copy(c.dir);
    const oh = level.octree.rayIntersect(ray);
    if (!oh || oh.distance > c.far) continue;
    tried++;
    // _meshNearと同じ手順・同じ相手（main.jsは見える物全部から取り直す）
    const back = Math.min(0.5, oh.distance);
    from.copy(oh.position).addScaledVector(c.dir, -back);
    raycaster.set(from, c.dir);
    raycaster.far = back + 0.05;
    const hs = raycaster.intersectObjects(visibleMeshes, false);
    if (!hs.length) continue;
    recovered++;
    const d = hs[0].point.distanceTo(oh.position);
    worst = Math.max(worst, d);
    /* 手前0.5mの間に歩ける飾り（電線・貼り分け）が挟まっていると、
       材質はそちらから取れる。乗せ替え前の弾はその飾りで止まっていたので、
       「見えている手前の物の材質で火花が出る」のはむしろ元の見た目に近い。
       ここでは「同じ面」と「手前の飾り」だけを許し、それ以外（明後日の面）が
       混ざっていないことを見る */
    if (d < 0.05) near++;
    else if (d <= back + 0.06) decor++;
  }
  ok(tried > 50, `試せた本数 ${tried}（少なすぎると検査になっていない）`);
  ok(recovered === tried, `全部の当たりで材質を拾えた（${recovered}/${tried}）`);
  ok(near + decor === recovered,
    `同じ面${near}本＋手前の飾り${decor}本＝全部（明後日の面はない。最大ずれ${(worst * 100).toFixed(1)}cm）`);
}

console.log('\n[軽さ] octreeの方が速い');
/* 乗せ替えの動機そのもの。逆転していたら乗せ替えの意味が無い */
{
  const t0 = performance.now();
  for (const c of cases) {
    ray.origin.copy(c.origin);
    ray.direction.copy(c.dir);
    level.octree.rayIntersect(ray);
  }
  const oct = performance.now() - t0;
  const t1 = performance.now();
  for (const c of cases) {
    raycaster.set(c.origin, c.dir);
    raycaster.far = c.far;
    raycaster.intersectObjects(solidMeshes, false);
  }
  const mesh = performance.now() - t1;
  ok(oct < mesh, `octree ${oct.toFixed(1)}ms ／ 総当たり ${mesh.toFixed(1)}ms（${N}本）`);
}

console.log('\n[3] main.jsが実際に乗せ替わっている');
{
  const { readFileSync } = await import('node:fs');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const bare = (main.match(/intersectObjects\(this\.solidMeshes/g) || []).length;
  // 残ってよいのは、足音の材質(_footSurface)と、面の取り直し(_meshNear)の2箇所だけ。
  // どちらも「材質が要る短いレイ」で、総当たりでも外接球で殆ど弾かれる
  ok(bare === 2, `総当たりのレイは残り${bare}箇所（_footSurfaceと_meshNearの2箇所だけ）`);
  ok((main.match(/this\._terrainRay\(/g) || []).length >= 7, 'octreeのレイに乗っている');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
