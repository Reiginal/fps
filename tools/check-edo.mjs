// 江戸ステージ（2つ目のマップ）の検査。
//
// なぜ要るか: level.jsのbuildLevel()にmapIdの分岐を足したので、
// **既存の市街地(urban)を壊していないこと**と、**江戸(edo)がちゃんと組めること**の
// 両方を確かめないといけない。特にurbanは1年近く手を入れて詰めてある地形なので、
// ここが1三角形でもずれたらクライアントとサーバーの地形が食い違う。
//
//   node tools/check-edo.mjs
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import '../server/dom-stub.js';
import { readFileSync } from 'node:fs';
import { buildLevel } from '../src/world/level.js';
import { MAP_LIST, MAP_IDS, PHASE } from '../src/net/protocol.js';

const { buildWorld } = await import('../server/world.js');
const { getRoom } = await import('../server/room.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const SHARED = new THREE.MeshStandardMaterial();
const MATS = new Proxy({}, { get: () => SHARED });

console.log('\n[1] マップの一覧');
{
  ok(MAP_IDS.length === 2, `マップは2種類（${MAP_IDS.join('、')}）`);
  ok(MAP_IDS[0] === 'urban', '既定は市街地');
  ok(MAP_IDS.includes('edo'), '江戸が入っている');
  ok(MAP_LIST.every((m) => m.id && m.name && m.desc), '名前と説明が全部揃っている');
}

console.log('\n[2] 市街地(urban)は今まで通り組める（既存への影響が無い）');
{
  const urban = buildLevel(MATS, { mapId: 'urban' });
  // server/world.jsのEXPECTと同じ値。ここがずれたら向こうも直す
  ok(urban.arenaSpawns.length === 8, '対戦の湧き場所は8箇所のまま');
  ok(urban.teamSpawns.length === 4, '2対2の湧き場所は4箇所のまま');
  ok(urban.bounds === 40, '場外の壁は40のまま');
}

console.log('\n[3] 江戸(edo)が組める');
{
  const edo = buildLevel(MATS, { mapId: 'edo' });
  let tris = 0;
  edo.root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  /* 密度の下限。**一番最初の江戸はここが8,824三角形しかなかった**
     （市街地は208,102で、21分の1）。中身は板塀・社1棟・町屋4棟・
     灯籠4個・酒樽4組・木箱4個だけで、地面の敷き分けが1枚も無く、
     実際に遊んだ画は「砂漠に木箱が置いてある」だった。
     形が組めるかどうかだけ見ていても、この状態は通ってしまう */
  ok(tris > 30000, `町として組み上がっている（${tris.toLocaleString()}三角形。8,824だった頃は砂漠だった）`);
  ok(edo.enemySpawns.length >= 8, `1人用/協力プレイ向けの湧き場所がある（${edo.enemySpawns.length}箇所）`);
  ok(edo.arenaSpawns.length === 8, '対戦の湧き場所は8箇所（urbanと同じ並びの型を流用）');
  ok(edo.teamSpawns.length === 4, '2対2の湧き場所は4箇所');
  ok(edo.coverPoints.length >= 30, `遮蔽物リストがある（${edo.coverPoints.length}箇所）`);
  ok(edo.bounds > 0 && edo.bounds !== 40, `場外の壁は市街地と別の値（${edo.bounds}）`);
  ok(edo.playerSpawn.z !== 26, '1人用の湧き位置も市街地と別');

  /* **湧き地点が地形に埋まっていないか、Octreeに当てて実測する。**
     「中央の社に入っていないか」だけ見ていた頃は、町屋を建て直した瞬間に
     4箇所が井戸と19cm重なり、(0,28)の開始位置は町屋の中だった。
     目分量で座標を書く限り必ずまた踏むので、機械に測らせる */
  const ray = new THREE.Ray();
  const cap = new Capsule(new THREE.Vector3(), new THREE.Vector3(), 0.34);
  const buried = [];
  const check = (label, list) => {
    for (const sp of list) {
      ray.set(new THREE.Vector3(sp.x, 20, sp.z), new THREE.Vector3(0, -1, 0));
      const hit = edo.octree.rayIntersect(ray);
      const gy = hit ? 20 - hit.distance : null;
      if (gy === null) { buried.push(`${label}(${sp.x},${sp.z}) 地面が無い`); continue; }
      // 屋根の上に湧かせない。立ち姿のカプセルが地形に食い込まないことも見る
      if (gy > 1.3) { buried.push(`${label}(${sp.x},${sp.z}) 地面が${gy.toFixed(1)}m＝屋根の上`); continue; }
      cap.start.set(sp.x, gy + 0.34, sp.z);
      cap.end.set(sp.x, gy + 1.75 - 0.34, sp.z);
      const stuck = edo.octree.capsuleIntersect(cap);
      if (stuck && stuck.depth > 0.05) {
        buried.push(`${label}(${sp.x},${sp.z}) ${stuck.depth.toFixed(2)}m埋まる`);
      }
    }
  };
  check('敵', edo.enemySpawns);
  check('対戦', edo.arenaSpawns);
  check('2対2', edo.teamSpawns);
  check('開始', [edo.playerSpawn]);
  ok(buried.length === 0, `湧き地点が地形に埋まっていない${buried.length ? `：${buried.join(' / ')}` : ''}`);

  // 境内の中から湧かない。中央から出てくると、押し寄せてくる形が消える
  const inPrecinct = (v) => Math.abs(v.x) < 15.5 && Math.abs(v.z) < 15.5;
  ok(edo.enemySpawns.every((v) => !inPrecinct(v)), '敵は境内の外（町の外縁）から入ってくる');
}

console.log('\n[4] server/world.jsがマップごとに組み分ける');
{
  const urban = buildWorld('urban');
  const edo = buildWorld('edo');
  ok(urban.mapId === 'urban' && edo.mapId === 'edo', 'mapIdを覚えている');
  ok(urban.stats.tris !== edo.stats.tris, '別の地形として組まれている');
  // 2回目は組み直さない（キャッシュされている）ことを、参照の一致で確かめる
  ok(buildWorld('urban') === urban, 'urbanは組み直さず使い回す');
  ok(buildWorld('edo') === edo, 'edoは組み直さず使い回す');

  const src = readFileSync(new URL('../server/world.js', import.meta.url), 'utf8');
  const m = src.match(/edo: \{ tris: (\d+), nodes: (\d+) \}/);
  ok(!!m, 'EXPECT.edoが定義されている');
  ok(m && parseInt(m[1], 10) === edo.stats.tris, `EXPECT.edoの三角形数が実測と合っている（${edo.stats.tris}）`);
  ok(m && parseInt(m[2], 10) === edo.stats.nodes, `EXPECT.edoのOctreeノード数が実測と合っている（${edo.stats.nodes}）`);
}

console.log('\n[5] 部屋でマップを選べる（setModeと同じ作法）');
{
  const world = buildWorld('urban');
  const room = getRoom(world);
  for (const s of [...room.slots.values()]) room.leave(s);
  room.phase = PHASE.WAIT;
  room.map = 'urban';
  room.world = buildWorld('urban');

  ok(room.map === 'urban', '既定は市街地');
  ok(room.setMap('edo') === true, '江戸へ変えられる');
  ok(room.map === 'edo', '変わっている');
  ok(room.world.mapId === 'edo', 'this.worldも江戸の地形に差し替わっている');
  ok(room.setMap('edo') === false, '同じ物をもう一度押しても何も起きない');
  ok(room.setMap('しらないマップ') === false, '知らない名前は断る');
  ok(room.map === 'edo', '断った後も元のまま');

  room.phase = PHASE.LIVE;
  ok(room.setMap('urban') === false, '試合中は変えられない');
  room.phase = PHASE.WAIT;
  room.setMap('urban');
}

console.log('\n[6] 江戸用の材質がtextures.jsに揃っている');
{
  const src = readFileSync(new URL('../src/world/textures.js', import.meta.url), 'utf8');
  for (const name of ['timberSiding', 'kawara', 'packedEarth', 'shojiPaper',
    'shikkui', 'urushi', 'cutstone']) {
    ok(new RegExp(`${name}: mk\\(`).test(src), `${name} がbuildMaterials()の戻り値にある`);
  }
}

console.log('\n[6.5] 色が「江戸」になっている（ここが根っこだった）');
/* なぜ要るか: 2026-08-17に「江戸っていうステージも全然江戸感ない。
   何のこだわりもない」と言われて、屋根の形と密度を疑う前に材質の色を測ったら、
   **実際に置いている6種の平均輝度が0.074〜0.083の12%幅に固まっていた。**
     石畳0.0779 板壁0.0738 叩き土0.0771 漆喰0.0824 木0.0769 米俵0.0828
   離れているのは瓦0.0150だけ。つまり「同じ明るさの茶色い面の上に
   黒い三角屋根が乗った物」で、これは江戸ではなく土壁の集落＝砂漠の集落に見える。

   日本家屋の記号は「白漆喰・黒瓦・木格子・朱」の4色の対比なので、
   **白が無く朱が黒い**時点で、形をいくら作り込んでも画は変わらない。

   ここが黙って元へ戻る（誰かが材質を市街地の物へ差し替える等）と、
   同じ所へ一直線で戻るので、数字で見張る */
{
  const { materialTone } = await import('../src/world/textures.js');
  const t = (n) => materialTone(n);
  const shikkui = t('shikkui'), urushi = t('urushi'), stone = t('cutstone');
  const kawara = t('kawara'), earth = t('packedEarth'), timber = t('timberSiding');

  // 白。**これが無かった**（障子紙は焼いてあるのに1回も貼っていなかった）
  ok(shikkui.lum > 0.45,
    `白漆喰が本当に白い（輝度${shikkui.lum.toFixed(4)} / 0.45以上。前の漆喰は0.0742）`);
  const contrast = shikkui.lum / kawara.lum;
  ok(contrast > 20,
    `白漆喰と黒瓦の対比がある（${contrast.toFixed(0)}倍 / 20倍以上。前は5.5倍）`);

  // 朱。本物の朱はsRGB(224,75,40)で輝度0.2103
  ok(urushi.lum > 0.12,
    `朱が黒くない（輝度${urushi.lum.toFixed(4)} / 0.12以上。前は0.0079で本物の1/26.6）`);
  ok(urushi.r > urushi.g * 2 && urushi.r > urushi.b * 2,
    `朱が赤い（sRGB(${urushi.srgb.join(',')})）`);
  // 漆は半艶。1に近いと朱色のフェルトになる
  ok(urushi.rough < 0.62, `漆に艶が残っている（粗さ${urushi.rough.toFixed(2)} / 0.62未満）`);

  // 石。足元と玉垣と灯籠。土と同じ暖色だと地面と壁の境が消える
  ok(stone.lum > earth.lum * 1.6,
    `切石が土より明るい（石${stone.lum.toFixed(4)} 対 土${earth.lum.toFixed(4)}）`);
  ok(stone.b > stone.r, `切石が寒色に振ってある（青${stone.srgb[2]} > 赤${stone.srgb[0]}）`);

  /* **輝度が1点に集まっていないこと。** ここが12%幅に固まっていたのが
     「江戸感が無い」の正体だった。一番明るい材質と一番暗い材質で
     20倍以上開いていることを見る */
  const all = [shikkui, urushi, stone, kawara, earth, timber].map((m) => m.lum);
  const spread = Math.max(...all) / Math.min(...all);
  ok(spread > 20, `明るさが散らばっている（最大/最小=${spread.toFixed(0)}倍 / 20倍以上）`);

  // 実際に江戸へ貼っていること（材質を作っただけで貼り忘れると意味が無い）
  const lv = readFileSync(new URL('../src/world/level.js', import.meta.url), 'utf8');
  const edo = lv.slice(lv.indexOf("if (mapId === 'edo') {"), lv.indexOf('  } else {', lv.indexOf("if (mapId === 'edo') {")));
  ok(edo.includes('M.shikkui'), '白漆喰を江戸に貼っている');
  ok(edo.includes('M.urushi'), '朱漆を江戸に貼っている');
  ok(edo.includes('M.stone'), '切石を江戸に貼っている');
  ok(!/M\.concrete\b/.test(edo), '江戸に市街地のコンクリが残っていない');
  ok(!/M\.metalRed\b/.test(edo), '江戸に塗装鉄板の赤が残っていない');
  ok(!/M\.plaster\b/.test(edo), '江戸に廃墟の漆喰が残っていない');
}

console.log('\n[6.6] 絵と挙動が食い違っていない');
/* 蔵の観音扉が、閉まって見えるのに当たり判定を持っていなかった
   （2枚とも solid=false で、合わせて幅1.95mがband()の開けた1.9mの開口を
   完全に塞いでいた）。issue #57で直したのと同じ形の再発。
   木箱は鋼の隅金物と梱包バンドが付いた近代の輸送箱なので江戸には置かない */
{
  const lv = readFileSync(new URL('../src/world/level.js', import.meta.url), 'utf8');
  const kura = lv.split('const kura = (cx, cz, ry) => {')[1]?.split('\n  };')[0] || '';
  ok(kura.length > 0, '蔵を組む所が見つかった');
  const doorLines = kura.split('\n').filter((l) => /2\.2, /.test(l) && /M\.timber/.test(l));
  ok(doorLines.length === 2, `観音扉が2枚ある（${doorLines.length}枚）`);
  ok(doorLines.every((l) => /true\);\s*$/.test(l.trim())),
    '扉が2枚とも当たり判定に入っている（閉まって見えるのにすり抜けない）');

  const edo = lv.slice(lv.indexOf("if (mapId === 'edo') {"), lv.indexOf('  } else {', lv.indexOf("if (mapId === 'edo') {")));
  ok(!/^\s*crate\(/m.test(edo), '江戸に近代の木箱を置いていない');
}

console.log('\n[6.7] 灯りと場外の景がある');
/* なぜ要るか（灯り）: 江戸には点光源が0個で、提灯も行灯もかがり火も
   1つも無かった。町並みの形をどれだけ作り込んでも、灯りが1点も無いと
   「昼の土壁の集落」で終わる。

   なぜ要るか（場外）: 板塀(2.6m)の外は無地の土が地平線まで続いていて、
   見えるのは空だけだった。山も寺も城も櫓も無いので、
   **この町が「どこかの町の一部」に見えない。**
   市街地は遠景の街・崩落壁・瓦礫の土手を持っているのに、江戸には1行も無かった。

   どちらも**当たり判定を増やしていないこと**を必ず確かめる。
   場外の物が固体になると、Octreeのノードが増えて弾が場外の山に当たり始める */
{
  const lv = readFileSync(new URL('../src/world/level.js', import.meta.url), 'utf8');
  const edo = lv.slice(lv.indexOf("if (mapId === 'edo') {"), lv.indexOf('  } else {', lv.indexOf("if (mapId === 'edo') {")));

  ok(/const chochin = /.test(edo), '提灯を組む所がある');
  ok(/M\.lantern/.test(edo), '光る材質を使っている');

  /* **呼び出しの回数ではなく、実際に建った物を数える。**
     chochin()の呼び出しは2箇所しか無いが、町屋16棟と門4箇所の中から
     呼ばれるので実際は24個立つ。呼び出しを数えると、そこを取り違える。

     灯りが1箇所に固まっていないことも見る（社の周りだけ光っていても
     「通りに沿った灯りの列」にはならない）*/
  {
    const built = buildLevel(MATS, { mapId: 'edo' });
    let lit = 0, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    built.root.traverse((o) => {
      if (!o.isMesh || !(o.material?.emissiveIntensity > 1)) return;
      lit++;
      o.geometry.computeBoundingBox();
      const b = o.geometry.boundingBox;
      minX = Math.min(minX, b.min.x + o.position.x); maxX = Math.max(maxX, b.max.x + o.position.x);
      minZ = Math.min(minZ, b.min.z + o.position.z); maxZ = Math.max(maxZ, b.max.z + o.position.z);
    });
    ok(lit > 0, `光る面が実際に建っている（${lit}枚）`);
    const spanX = maxX - minX, spanZ = maxZ - minZ;
    ok(spanX > 40 && spanZ > 40,
      `灯りが町中に散っている（${spanX.toFixed(0)}m×${spanZ.toFixed(0)}m。1箇所に固まっていない）`);
  }
  const lanternDef = lv.split('lantern: (() => {')[1]?.split('})(),')[0] || '';
  ok(/emissive/.test(lanternDef), '光る材質が本当に光る設定を持っている');
  ok(/clone\(\)/.test(lanternDef), '障子紙の写しなので、焼き直しもVRAMも増えない');

  ok(/場外の景/.test(edo), '場外の景を組む所がある');
  for (const [what, re] of [['山並み', /const ridge = /], ['天守', /天守/], ['火の見櫓', /火の見櫓/], ['寺の屋根', /寺の屋根/]]) {
    ok(re.test(edo), `${what}がある`);
  }

  /* **場外の物が1つも固体になっていないこと。**
     Octreeのノード数で見る（固体が増えれば必ず増える）*/
  const w = buildWorld('edo');
  let nodes = 0;
  (function walk(n) { nodes++; for (const s of n.subTrees) walk(s); })(w.octree);
  ok(nodes === 7404, `当たり判定が増えていない（Octreeノード${nodes} / 灯りと場外を足す前と同じ7404）`);

  // 塀より高い物だけ置く（低いと塀に隠れて1ピクセルも見えない＝置いた意味が無い）
  ok(/板塀の天端/.test(edo), '塀より高い物だけ置く、と決めてある');
}

console.log('\n[7] 湧いた所から本当に歩けるか（実際に歩かせて測る）');
/* なぜ要るか: 「地形に埋まっていないか」だけでは足りなかった。
   band()で組む建物は**中が空洞**なので、町屋の真ん中に湧いても
   カプセルはどこにも当たらず、埋まり判定はすり抜ける。
   実際にはドアまで1.2mの部屋に閉じ込められている。

   最初の町割りは通りを±21に通して内側の列を±15.8に建てていたので、
   対戦の湧き地点の環（±17.5と±12,±12）の真上に建物が乗っていた。
   32通り歩かせて12通りが動けず、
     ・(0,-17.5) … 町屋の中
     ・(±12,±12) … 町屋2棟の角に挟まれた0.7mの隙間
   遊ぶと「歩けない・画面が揺れる」になる。**歩かせないと分からない。** */
{
  const { SimPlayer } = await import('../server/sim.js');
  const K_FWD = 1 << 0;
  const world = buildWorld('edo');
  const sim = new SimPlayer(1, '検査', world);
  const spots = [
    ...world.arenaSpawns.map((v) => ['対戦', v]),
    ...world.teamSpawns.map((v) => ['2対2', v]),
    ['開始', world.playerSpawn],
  ];
  const stuck = [];
  let jitterWorst = 0, jitterAt = '';
  for (const [label, sp] of spots) {
    let openWays = 0;
    for (let a = 0; a < 8; a++) {
      const dir = (a / 8) * Math.PI * 2;
      sim.spawn(new THREE.Vector3(sp.x, 0.1, sp.z), dir);
      const p0 = sim.player.collider.start.clone();
      let prev = p0.clone(), prevDx = 0, prevDz = 0, rev = 0, frames = 0;
      for (let i = 0; i < 60 * 3; i++) {
        sim.tick(K_FWD, dir, 0);
        const c = sim.player.collider.start;
        const dx = c.x - prev.x, dz = c.z - prev.z;
        if (i > 5 && (dx * dx + dz * dz) > 1e-8 && (prevDx * prevDx + prevDz * prevDz) > 1e-8) {
          // 前のフレームと逆向きに動いた＝押し戻されている（＝画面が揺れる）
          if (dx * prevDx + dz * prevDz < 0) rev++;
          frames++;
        }
        prevDx = dx; prevDz = dz; prev.set(c.x, c.y, c.z);
      }
      const moved = Math.hypot(sim.player.collider.start.x - sp.x, sim.player.collider.start.z - sp.z);
      if (moved > 5) openWays++;
      const jit = frames ? rev / frames : 0;
      if (jit > jitterWorst) { jitterWorst = jit; jitterAt = `${label}(${sp.x},${sp.z})`; }
    }
    // 8方向のうち5方向以上へ抜けられること。壁を背負う位置はあってよいが、
    // 「どこへも行けない」は湧き地点として成立していない
    if (openWays < 5) stuck.push(`${label}(${sp.x},${sp.z}) 抜けられる向き${openWays}/8`);
  }
  ok(stuck.length === 0,
    `どの湧き地点からも8方向のうち5方向以上へ歩ける${stuck.length ? `：${stuck.join(' / ')}` : ''}`);
  // 押し戻され率。壁と同じ場所に当たり判定を二重に置くとここが跳ね上がる
  ok(jitterWorst < 0.10,
    `歩いていて押し戻されない（最悪${(jitterWorst * 100).toFixed(1)}% ${jitterAt}。10%未満）`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
