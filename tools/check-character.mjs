// キャラクター選択の検査。
//
// この仕組みは「姿そのものは送らず、番号だけ送る。番号から同じ姿を組み直す」
// という作りなので、**同じ番号から違う姿が出た瞬間に破綻する。**
// しかもその壊れ方は、自分の画面と相手の画面で違う人が立っているという形で出る。
// 遊んでいる本人にはまず気づけないので、ここで測る。
//
//   node tools/check-character.mjs
import '../server/dom-stub.js';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { CHARACTERS, characterAt } from '../src/net/protocol.js';

const { buildLevel } = await import('../src/world/level.js');
const { Enemy } = await import('../src/ai/enemy.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const MAT = new THREE.MeshStandardMaterial();
const level = buildLevel(new Proxy({}, { get: () => MAT }));

// 姿を決めている値だけを取り出す。ここが同じなら同じ人が組み上がる
const shape = (v) => [
  v.camo.fatigue, v.skin, v.headGear, v.weapon,
  v.scale.toFixed(4), v.width.toFixed(4), v.stance,
  v.faceCover, v.plateCarrier, v.coverHelmet, v.pouches,
  v.pack, v.radio, v.chevron, v.canteen, v.holster, v.optic,
  v.uvOff.x.toFixed(4), v.uvOff.y.toFixed(4),
].join('|');

const variantOf = (seed) => new Enemy(level, { seed }).variant;

console.log('\n[1] 同じ番号からは必ず同じ姿が出る');
for (let i = 0; i < CHARACTERS.length; i++) {
  const seed = characterAt(i).seed;
  const a = shape(variantOf(seed));
  const b = shape(variantOf(seed));
  ok(a === b, `${i}番「${CHARACTERS[i].name}」… 2回組んでも同じ`);
}

console.log('\n[2] 番号ごとに姿が違う');
// 同じ姿が2つ並ぶと、選ぶ意味が無いうえ、対戦で相手と自分を取り違える
const shapes = CHARACTERS.map((c) => shape(variantOf(c.seed)));
const uniq = new Set(shapes);
ok(uniq.size === CHARACTERS.length, `${CHARACTERS.length}種類とも別の姿（重複なし）`);

console.log('\n[3] 見た目がひと目で見分けられる');
// 色だけ違う6人だと、撃ち合いの最中には区別が付かない。
// 迷彩・かぶり物・武器の3つで、どれか2つは散っていてほしい
const camos = new Set(CHARACTERS.map((c) => variantOf(c.seed).camo.fatigue));
const heads = new Set(CHARACTERS.map((c) => variantOf(c.seed).headGear));
const weps = new Set(CHARACTERS.map((c) => variantOf(c.seed).weapon));
ok(camos.size >= 2, `迷彩が${camos.size}系統に散っている`);
ok(heads.size >= 3, `かぶり物が${heads.size}種類に散っている`);
ok(weps.size >= 2, `武器が${weps.size}種類に散っている`);

console.log('\n[3.5] 画面に出す名前が、実際の姿と合っている');
// 名前は手で書いた文字列なので、種を差し替えた時にここだけ古いまま残る。
// 「タン」と書いてある物が緑で出てくると、選ぶ側は毎回裏切られる
const CAMO_NAME = { 0x5f6a4a: 'オリーブ', 0x7a6949: 'タン', 0x5e626b: 'グレー' };
const HEAD_NAME = ['ヘルメット', 'ブーニー', 'キャップ', '素頭'];
for (let i = 0; i < CHARACTERS.length; i++) {
  const c = CHARACTERS[i];
  const v = variantOf(c.seed);
  const camo = CAMO_NAME[v.camo.fatigue];
  const head = HEAD_NAME[v.headGear];
  ok(
    c.name === `${camo}／${head}`,
    `${i}番の名前「${c.name}」… 実物は「${camo}／${head}」`,
  );
  // 色の四角も迷彩に合わせる。ここがずれると、色で選んだ人が別の色で出てくる
  ok(
    c.color.toLowerCase() === `#${v.camo.fatigue.toString(16).padStart(6, '0')}`,
    `${i}番の色 ${c.color} が迷彩と一致`,
  );
}

console.log('\n[4] 選んだ物で強さが変わらない');
// 見た目に強さが乗ると、選ぶ物で有利不利が出る。
// 当たり判定の太さは全員同じで、背丈だけ個体差がある（当たり判定は太さで決まる）
const radii = new Set(CHARACTERS.map((c) => new Enemy(level, { seed: c.seed }).radius));
ok(radii.size === 1, `当たり判定の太さは全員同じ（${[...radii][0]}m）`);

console.log('\n[5] 知らない番号が来ても姿が消えない');
// 古い版の相手や、壊れた電文から範囲外の番号が来ることがある
ok(characterAt(-1) === CHARACTERS[0], '負の番号は0番へ寄せる');
ok(characterAt(999) === CHARACTERS[0], '大きすぎる番号も0番へ寄せる');
ok(characterAt(undefined) === CHARACTERS[0], '番号が無くても0番になる');

console.log('\n[6] ロビーの3Dが、試合中も描き続けないか');
// 止め忘れると、遊んでいる裏で2つ目の場面をずっと描くことになる。
// 画面を見ても気づけない（絵は隠れている）のに、パソコンだけ熱くなる。
// ロビーを畳む場所は複数あるので、そのどれからも止まることを文字で確かめる
{
  const src = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const hides = (src.match(/lobby\.hide\(\)/g) || []).length;
  const stops = (src.match(/charView\?\.stop\(\)/g) || []).length;
  ok(hides > 0, `ロビーを畳む場所が${hides}箇所ある`);
  ok(stops >= hides, `そのどれでも3Dを止めている（止める記述 ${stops}箇所）`);
  // 描く側も、止まっている間は何もしないこと
  const view = readFileSync(new URL('../src/ui/charview.js', import.meta.url), 'utf8');
  ok(/if \(!this\.running/.test(view), '止まっている間は描かない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
