// 武器のスキンの検査。
//
// **画像を1枚も増やさずに色違いを出す**のがこの機能の値打ちなので、
// そこが崩れていないかを最初に見る。
//
// もう1つは軽さ。見た目の画面は**2つ目の3Dの場面**を持つので、
// 閉じた後も回り続けると、ホームに居るだけでパソコンが熱くなる。
// このrepoが実際に踏んだ形（ミニマップ・順位表）と同じ型なので見張る。
//
//   node tools/check-skins.mjs
import { readFileSync, readdirSync } from 'node:fs';
import '../server/dom-stub.js';
import {
  SKINS, skinAt, applySkin, skinFor, hasSkin, wearSkin, setAccount,
} from '../src/player/skins.js';
import { SKIN_LIST, SKINNABLE, DEFAULT_SKIN, skuOf } from '../src/net/protocol.js';
import { WEAPONS, MATS, recolor } from '../src/player/weapons.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

console.log('\n[1] スキンの表');
{
  ok(SKINS.length >= 2, `${SKINS.length}種ある`);
  ok(SKINS[0].id === 'stock' && !SKINS[0].over, '先頭は標準（何も差し替えない）');
  const ids = new Set(SKINS.map((s) => s.id));
  ok(ids.size === SKINS.length, 'idが重複していない');
  for (const s of SKINS) {
    ok(!!s.name && !!s.note && /^#[0-9a-f]{6}$/i.test(s.swatch || ''),
      `${s.id} … 名前・説明・色の見本が揃っている`);
  }
  ok(skinAt('知らないid').id === 'stock', '知らないidは標準へ寄せる（姿が消えない）');
}

console.log('\n[2] 材質を作り直せる');
{
  const base = MATS.enamel;
  ok(!!base, '元の材質がある');
  const red = recolor(base, { color: 0x992222 });
  ok(!!red && red !== base, '**元を書き換えずに、新しい材質を作る**');
  ok(!!base.map === !!red.map, '焼いた地図の有無が引き継がれる');
  ok(base.normalMap === red.normalMap || (!!base.normalMap && !!red.normalMap),
    '表面の凹凸は引き継ぐ（そこまで変えると別の銃になる）');
  ok(recolor({}, {}) === null, '控えに無い材質は作り直さない（黙ってnull）');

  // 色を1つも変えずに、擦れだけ変えられること。「歴戦」がこれで作ってある
  const worn = recolor(base, { wear: { amount: 1.6 } });
  ok(!!worn && worn !== base, '**色を変えずに擦れだけ変えた物が作れる**');
}

console.log('\n[3] 銃の組み立てを触っていない');
{
  /* ここが今回の値打ち。材質は MATS.enamel のように直に書かれた所が
     200箇所以上あって、そこへ「どのスキンか」を配って回ると
     武器を1本足すたびに同じ配線が要る。
     組み上がった後で材質だけ差し替える形なので、組み立て側は無傷 */
  const src = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  const uses = (src.match(/MATS\./g) || []).length;
  ok(uses > 200, `MATS. を直に書いている所が ${uses} 箇所ある（触っていない）`);
  const builds = (src.match(/function build[A-Z]\w*\(([^)]*)\)/g) || []);
  ok(builds.length >= 5, `組み立ての関数が ${builds.length} 本ある`);
  ok(!builds.some((b) => /skin|mats|MATS/i.test(b)),
    '**どの組み立て関数もスキンを引数で受け取っていない**');
}

console.log('\n[4] 被せる・戻せる');
{
  const def = WEAPONS.find((w) => w.id === 'rifle');
  const gun = def.build(def.view);

  // 元の材質を数える
  const before = [];
  gun.traverse((o) => { if (o.isMesh) before.push(o.material); });
  ok(before.length > 20, `面が ${before.length} 個ある`);

  applySkin(gun, 'desert');
  const after = [];
  gun.traverse((o) => { if (o.isMesh) after.push(o.material); });
  const diff = after.filter((m, i) => m !== before[i]).length;
  ok(diff > 0, `${diff} 個の面が差し替わった`);
  ok(diff < after.length, '全部は差し替わらない（手袋やレンズは元のまま）');

  applySkin(gun, 'stock');
  const back = [];
  gun.traverse((o) => { if (o.isMesh) back.push(o.material); });
  ok(back.every((m, i) => m === before[i]), '**標準へ戻すと元の材質へ完全に戻る**');

  // 行ったり来たりしても壊れない（2回目に「前のスキン」を元だと思い込まないか）
  applySkin(gun, 'urban');
  applySkin(gun, 'veteran');
  applySkin(gun, 'stock');
  const back2 = [];
  gun.traverse((o) => { if (o.isMesh) back2.push(o.material); });
  ok(back2.every((m, i) => m === before[i]), '**何度行き来しても元へ戻る**');
}

console.log('\n[5] 色が実際に変わっている（測る）');
{
  /* **書いたのに効いていない、を防ぐ。**
     材質の色は焼いた地図(map)が全部持っていて、materialのcolorは白のまま。
     なので色を比べるには地図の中身を平均するしかない。
     画面を見られない所で「差し替わったつもり」を潰すための項目 */
  const avg = (m) => {
    const d = m?.map?.image?.data;
    if (!d) return null;
    let r = 0; let g = 0; let b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  };
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  const base = avg(MATS.enamel);
  ok(!!base, `標準の塗装の平均色 (${base.map((v) => v.toFixed(0)).join(', ')})`);
  for (const s of SKINS.slice(1)) {
    const over = s.over.enamel;
    // 色を指定していないスキン（歴戦）はここでは見ない。下で別に測る
    if (!over || over.color == null) continue;
    const got = avg(recolor(MATS.enamel, over));
    const d = dist(base, got);
    // 20は「並べて見れば違うと分かる」あたり。ここを下回るなら書いた意味が無い
    ok(d > 20, `${s.name} … 標準から ${d.toFixed(0)} 離れている (${got.map((v) => v.toFixed(0)).join(', ')})`);
  }

  // 「歴戦」は色を変えずに擦れだけ変えるスキン。**色は近いままで、地図は違う**
  const vet = SKINS.find((s) => s.id === 'veteran');
  const worn = recolor(MATS.enamel, vet.over.enamel);
  const wd = dist(base, avg(worn));
  ok(wd > 3, `歴戦 … 色を指定していないのに地図は変わる（${wd.toFixed(0)}）`);
}

console.log('\n[6] 焼くのは1回だけ');
{
  /* 焼くのは96×96の画素をなめる処理。持ち替えのたびにやり直すと、
     持ち替えた瞬間に必ず引っかかる */
  const def = WEAPONS.find((w) => w.id === 'rifle');
  const a = def.build(def.view);
  const b = def.build(def.view);
  applySkin(a, 'desert');
  applySkin(b, 'desert');
  const ma = [];
  a.traverse((o) => { if (o.isMesh) ma.push(o.material); });
  const mb = [];
  b.traverse((o) => { if (o.isMesh) mb.push(o.material); });
  const shared = ma.filter((m, i) => m === mb[i]).length;
  ok(shared === ma.length,
    '**2本の銃が同じスキンの材質を共有する**（銃ごとに焼き直していない）');
}

console.log("\n[7] 武器ごとに別のスキンを着ける");
{
  // 何も持っていない状態から始める（ログインしていない人と同じ）
  setAccount({ owned: [], equipped: {} });
  for (const w of SKINNABLE) ok(skinFor(w) === DEFAULT_SKIN, `${w} … 最初は標準`);
  ok(!wearSkin('rifle', 'gold'), '**持っていない物は着けられない**');
  ok(skinFor('rifle') === DEFAULT_SKIN, '着けようとしても標準のまま');
  ok(wearSkin('rifle', DEFAULT_SKIN), '標準はいつでも着けられる（買う物ではない）');

  // 買ってある状態にする
  setAccount({ owned: [skuOf('rifle', 'gold'), skuOf('pistol', 'desert')], equipped: {} });
  ok(hasSkin('rifle', 'gold'), 'ライフルのゴールドを持っている');
  ok(!hasSkin('pistol', 'gold'), '**ピストルのゴールドは別の商品**（持っていない）');
  ok(wearSkin('rifle', 'gold'), '持っている物は着けられる');
  ok(skinFor('rifle') === 'gold' && skinFor('pistol') === DEFAULT_SKIN,
    '**武器ごとに別々**（ライフルはゴールド、ピストルは標準）');
  ok(wearSkin('pistol', 'desert') && skinFor('rifle') === 'gold',
    'ピストルを変えてもライフルは変わらない');

  // 台帳側で持ち物を消された時。着せたままにしない
  setAccount({ owned: [], equipped: { rifle: 'gold' } });
  ok(skinFor('rifle') === DEFAULT_SKIN,
    '**持っていない物が届いても着せない**（持ち物を消した時の保険）');
}

console.log("\n[7b] 値段の表が1つしかない");
{
  /* 値段が2箇所にあると、片方だけ直した時に
     「画面では300コインなのに引かれるのは1500コイン」が起きる */
  const paint = readFileSync(new URL('../src/player/skins.js', import.meta.url), 'utf8');
  ok(!/price\s*:/.test(paint), '**塗り方の表が値段を持っていない**（protocol.jsだけが持つ）');
  ok(SKINS.every((s) => typeof s.price === 'number'), '画面に出す時はprotocol.jsから乗る');
  const ids = SKIN_LIST.map((s) => s.id).sort().join();
  ok(SKINS.map((s) => s.id).sort().join() === ids, '塗り方と品揃えのidが揃っている');
  ok(SKINS.every((s) => s.id === DEFAULT_SKIN || s.price > 0), '標準以外は必ず値段が付いている');
}

console.log("\n[8] 軽さ — 開いている間だけ描く");
{
  const look = readFileSync(new URL('../src/ui/look.js', import.meta.url), 'utf8');
  ok(/if \(!this\.running/.test(look), '**閉じている間はupdateが即座に返る**');
  ok(/hide\(\)\s*\{[^}]*this\.running = false/.test(look), '閉じた時にrunningを落とす');
  ok(/if \(this\.ready\) return/.test(look) || /this\.ready = true/.test(look),
    '3Dの道具は初めて開いた時に作る（起動時に作らない）');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(/this\.look\?\.update\(dt\)/.test(main), 'ループから呼ばれている');
  ok(/this\.look\?\.hide\(\)/.test(main), 'やめる時に畳む（裏で回り続けない）');
  ok(/this\.look\?\.isOpen/.test(main),
    '開いている間はポインタロックを取らない（押した文字がゲームへ抜けない）');
}

console.log("\n[9] 画面の器");
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const js = readFileSync(new URL('../src/ui/look.js', import.meta.url), 'utf8');
  const want = [...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);
  const missing = [...new Set(want)].filter((id) => !html.includes(`id="${id}"`));
  ok(missing.length === 0, `look.jsが掴む${want.length}個のidが全部ある${missing.length ? ` ← ${missing.join('、')}` : ''}`);
  // 器を置いただけでは出ない。#account で実際に踏んだ形
  const rule = html.match(/#look \{[^}]*\}/);
  ok(!!rule && /position:\s*fixed/.test(rule[0]), '#look が画面いっぱいに出る指定を持っている');
  ok(/#look\.hidden \{[^}]*display:\s*none/.test(html), '#look.hidden で隠せる');
  ok(html.includes('id="nmLook"'), 'ホームに入口のボタンがある');
}

console.log("\n[10] 素材ファイルを増やしていない");
{
  // スキンの値打ちはここ。画像を持ち始めたら、この機能の前提が崩れる
  const skins = readFileSync(new URL('../src/player/skins.js', import.meta.url), 'utf8');
  ok(!/\.(png|jpg|jpeg|webp|ktx2|basis)/i.test(skins),
    '**スキンの表が画像ファイルを1枚も指していない**');
  const assets = readdirSync(new URL('../assets', import.meta.url));
  ok(!assets.some((f) => /skin/i.test(f)), 'assetsにスキン用の素材が増えていない');
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
