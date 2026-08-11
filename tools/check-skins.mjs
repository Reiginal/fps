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
import * as THREE from 'three';
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

  applySkin(gun, 'camo');
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
  applySkin(gun, 'camo');
  applySkin(gun, 'gold');
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
  // 形違いは塗り替えではないので、ここでは見ない（[11]で別に見る）
  for (const s of SKINS.filter((x) => x.kind === 'paint' && x.over)) {
    const over = s.over.enamel;
    // 色を指定していないスキン（歴戦）はここでは見ない。下で別に測る
    if (!over || over.color == null) continue;
    const got = avg(recolor(MATS.enamel, over));
    const d = dist(base, got);
    // 20は「並べて見れば違うと分かる」あたり。ここを下回るなら書いた意味が無い
    ok(d > 20, `${s.name} … 標準から ${d.toFixed(0)} 離れている (${got.map((v) => v.toFixed(0)).join(', ')})`);
  }

  /* **迷彩は材質ごとに違う色を置く。** そこが「1色で塗る商品」との違いで、
     2026-08-11にデザート・アーバン・歴戦を消して迷彩を入れた理由そのもの。
     ここが崩れて全材質が同じ色になったら、消した3つと同じ物に戻っている */
  const camo = SKINS.find((s) => s.id === 'camo');
  const tones = ['enamel', 'polymer', 'anodized', 'phosphate', 'steel']
    .map((k) => camo.over[k]?.color)
    .filter((c) => c != null);
  ok(tones.length >= 4, `迷彩は4つ以上の材質に色を置いている（${tones.length}個）`);
  ok(new Set(tones).size === tones.length, '迷彩の色は材質ごとに全部違う（1色で塗っていない）');
  // 明暗が散っていること。**同じ明るさの色を並べても迷彩には見えない**
  const lum = (h) => 0.2126 * ((h >> 16) & 255) + 0.7152 * ((h >> 8) & 255) + 0.0722 * (h & 255);
  const ls = tones.map(lum);
  ok(Math.max(...ls) - Math.min(...ls) > 60,
    `迷彩の明暗が散っている（一番明るい所と暗い所の差 ${(Math.max(...ls) - Math.min(...ls)).toFixed(0)}）`);
}

console.log('\n[6] 焼くのは1回だけ');
{
  /* 焼くのは96×96の画素をなめる処理。持ち替えのたびにやり直すと、
     持ち替えた瞬間に必ず引っかかる */
  const def = WEAPONS.find((w) => w.id === 'rifle');
  const a = def.build(def.view);
  const b = def.build(def.view);
  applySkin(a, 'camo');
  applySkin(b, 'camo');
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
  setAccount({ owned: [skuOf('rifle', 'gold'), skuOf('pistol', 'camo')], equipped: {} });
  ok(hasSkin('rifle', 'gold'), 'ライフルのゴールドを持っている');
  ok(!hasSkin('pistol', 'gold'), '**ピストルのゴールドは別の商品**（持っていない）');
  ok(wearSkin('rifle', 'gold'), '持っている物は着けられる');
  ok(skinFor('rifle') === 'gold' && skinFor('pistol') === DEFAULT_SKIN,
    '**武器ごとに別々**（ライフルはゴールド、ピストルは標準）');
  ok(wearSkin('pistol', 'camo') && skinFor('rifle') === 'gold',
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
  const paints = SKINS.filter((s) => s.kind === 'paint').map((s) => s.id).sort().join();
  ok(paints === ids, '塗り方と品揃えのidが揃っている');
  ok(SKINS.every((s) => s.id === DEFAULT_SKIN || s.price > 0), '標準以外は必ず値段が付いている');
  // 色と形でidがぶつかると、どちらの意味か決まらなくなる
  const all = SKINS.map((s) => s.id);
  ok(new Set(all).size === all.length, '**色と形でidが重複していない**');
  ok(SKINS.every((s) => s.swatch && s.note), '形違いにも色の見本と説明がある');
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
  /* **入口はホームに2つ、画面は1枚。**
     やることが違うので入口は分けるが、見せる物が「持っている物」か
     「売り物」かの違いしかないので、画面まで2枚にすると3Dの場面を2つ持つ */
  ok(html.includes('id="nmLook"') && html.includes('id="nmStore"'),
    'ホームに入口が2つある（スキン変更・ストア）');
  ok((html.match(/id="lkView"/g) || []).length === 1, '3Dの場面は1つのまま');
  ok(!/id="lkTab/.test(html), '画面の中の切り替えタブは消えている（入口で分かれた）');
  const menu = readFileSync(new URL('../src/ui/netmenu.js', import.meta.url), 'utf8');
  ok(/onLook\(false\)/.test(menu) && /onLook\(true\)/.test(menu),
    'どちらの面で開くかをボタンが渡している');
  ok(/show\(store = false\)/.test(js), '開く時に受け取っている');

  /* **見本の色の読み方が画面に出ているか。**
     印だけ置いても、初見の人には読めない（「左右のマークがなんなのか謎」） */
  ok(/lkhelp/.test(html) && /this\.el\.help/.test(js), '見本の読み方を出す場所がある');

  /* **スキンに種類の区別を出していないこと。**
     「形」の札と「色だけでなく形も変わる」の説明を並べていたが、
     遊ぶ側にそんな制度は無い、と言われて畳んだ（2026-08-11）。
     スキンはスキンで、1つの武器に1つ着ける */
  ok(!/class="kd"/.test(js) && !/\.lkitem \.kd \{/.test(html),
    '**「形」の札が無い**（スキンに種類を出さない）');
  /* **コメントを外してから見る。** 「前はこう書いていた」という説明が
     コードに残っているので、素で探すと検査が自分の注意書きに引っかかる
     （実際に引っかかった） */
  const code = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/形も変わる|形と色/.test(code), '画面に出す文にも形と色の分け方が無い');
}

console.log('\n[9.5] 買えた合図の音');
{
  /* **買った後に何も鳴らないと、効いたのかが分からない**（そう言われた）。
     ストアからはその商品が消えるので、押した所の見た目も一緒に変わってしまい、
     「買えたのか、押し間違えて何か消えたのか」が文字だけでは読めない */
  const js = readFileSync(new URL('../src/ui/look.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const audio = readFileSync(new URL('../src/core/audio.js', import.meta.url), 'utf8');
  ok(/purchase\(\)\s*\{/.test(audio), 'audio.jsに買えた音がある');
  ok(/this\.onBought\(/.test(js), '買えた時に呼んでいる');
  // **失敗した時に鳴らさない。** 返事を見る前に鳴らすと、残高不足でも鳴る
  const buyBody = js.slice(js.indexOf('async _buy('), js.indexOf('get isOpen'));
  ok(buyBody.indexOf('this.onBought(') > buyBody.indexOf('if (!r.ok)'),
    '**サーバーがokと言ってから鳴らす**（残高不足では鳴らない）');
  ok(/this\.look\.onBought = /.test(main), 'main.jsが音へ繋いでいる');
  /* ホームから直でストアへ来た人は、まだ音が起きていない。
     WebAudioは操作を起点にしないと走らない */
  ok(/onBought = \(\) => \{ this\._wakeAudio\(\);/.test(main),
    '鳴らす前に音を起こしている（ホームから直で来ても鳴る）');
  /* この画面に音の一式を持たせない。持たせるとスキンの画面だけで音が要る。
     **コメントを外してから見る。**「音を知らない」の理由コメントに
     AudioEngineの名前が出ているので、生のまま見ると自分の説明で落ちる */
  const bare = js.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/audio/i.test(bare), 'スキンの画面はAudioEngineを知らない');
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

console.log('\n[11] 形違いのスキン');
{
  const { SHAPE_LIST, itemsFor, canEquip } = await import('../src/net/protocol.js');
  const { SHAPE_BUILDS } = await import('../src/player/weapons.js');
  const { shapeOf } = await import('../src/player/skins.js');

  ok(SHAPE_LIST.length > 0, `${SHAPE_LIST.length}種`);
  for (const s of SHAPE_LIST) {
    ok(!!SHAPE_BUILDS[s.id], `${s.name}(${s.id}) … 組み立て関数がある`);
    ok(shapeOf(s.id) === SHAPE_BUILDS[s.id], `${s.name} … skins.jsから引ける`);
  }
  ok(shapeOf('gold') === null, '色のスキンは組み立てを持たない（材質だけ差し替える）');

  /* **その武器でしか買えない・着けられない。**
     ここが緩いと「ライフルの刀」が成立してしまう */
  ok(canEquip('knife', 'katana'), 'ナイフに刀は着けられる');
  ok(!canEquip('rifle', 'katana'), '**ライフルに刀は着けられない**');
  ok(!itemsFor('rifle').some((i) => i.id === 'katana'), 'ライフルの品揃えに刀が並ばない');
  ok(itemsFor('knife').some((i) => i.id === 'katana'), 'ナイフの品揃えには並ぶ');
  // 色は全武器で売る
  ok(SKINNABLE.every((w) => itemsFor(w).some((i) => i.id === 'gold')), '色はどの武器でも売っている');

  /* 組み上がった物が、武器側の決まりを満たしているか。
     **印が1つでも欠けると、閃光の出所も覗きの逆算も行き先を失う** */
  /* **元の武器と比べる。** 形違いはその武器専用なので、
     ナイフの形をライフルと比べても意味が無い（実際そう書いて4件落ちた）*/
  const defOf = (id) => WEAPONS.find((w) => w.id === (SHAPE_LIST.find((s) => s.id === id)?.weapon));
  for (const [id, build] of Object.entries(SHAPE_BUILDS)) {
    const def = defOf(id);
    ok(!!def, `${id} … 売る武器(${SHAPE_LIST.find((s) => s.id === id)?.weapon})が実在する`);
    const base = def.build(def.view);
    let baseMeshes = 0;
    base.traverse((o) => { if (o.isMesh) baseMeshes++; });
    const g = build(def.view);
    for (const k of ['muzzle', 'eject', 'sight', 'handR', 'handL', 'holdL']) {
      ok(!!g.userData[k], `${id} … ${k} がある`);
    }
    /* **元の武器が持っている動く部品を欠かさない。**
       bolt/mag/trigger が無いと装填で何も動かなくなる。
       短剣系は元から持っていないので、ここは「元と同じだけある」を見る */
    for (const k of ['bolt', 'mag', 'trigger']) {
      ok(!base.userData[k] === !g.userData[k], `${id} … ${k} の有無が元と同じ`);
    }
    /* 結合が効いているか。**失敗しても見た目は変わらず、描画呼び出しだけ増える。**
       しかも bakeStatic は1つの材質で失敗すると**その群れ全部の結合を諦める**ので、
       1箇所の取り違えで一気に跳ねる（実際、星と輪を同じ材質にしていた時に
       47個から288個になった）。元の武器＋10個までを目安にする */
    let meshes = 0;
    g.traverse((o) => { if (o.isMesh) meshes++; });
    ok(meshes <= baseMeshes + 10,
      `${id} … 面が ${meshes} 個（元は ${baseMeshes} 個。結合できている）`);
    // 前（-Z）へ伸びているか。符号を間違えるとカメラの後ろへ伸びる
    ok(g.userData.muzzle.position.z < 0, `${id} … 前を向いている`);

    /* **元より大きくなりすぎていないか。**
       構えは目の前に出るので、少し盛るだけで画面を覆う。
       外部モデルを被せた時に「画面の右半分を覆う黒い板」になった前例がある
       （assets/models/CREDITS.md）。1.5倍を境にする */
    const size = (grp) => {
      const b = new THREE.Box3();
      grp.traverse((o) => {
        if (!o.isMesh || !o.visible) return;
        for (let p = o; p; p = p.parent) if (p.userData?.isHand) return;
        b.expandByObject(o);
      });
      const v = new THREE.Vector3();
      b.getSize(v);
      return v;
    };
    /* **一番長い辺どうしで比べる。**
       軸ごとの比で見ると、刀の厚み(0.036→0.060)のような
       画面の埋まり方に関係ない所で落ちる。実際そう書いて2件落ちた。
       画面をどれだけ覆うかを決めるのは一番長い辺 */
    const a = size(base);
    const c = size(g);
    const big = (v) => Math.max(v.x, v.y, v.z);
    const ratio = big(c) / big(a);
    ok(ratio < 1.5,
      `${id} … 一番長い辺が元の${ratio.toFixed(2)}倍（幅${c.x.toFixed(3)} 高${c.y.toFixed(3)} 長${c.z.toFixed(3)}）`);
  }

  // 刀は長く、ダガーは短い。**形が実際に違うことを寸法で押さえる**
  const len = (g) => {
    let min = Infinity; let max = -Infinity;
    g.traverse((o) => {
      if (!o.isMesh || !o.geometry?.attributes?.position) return;
      for (let p = o; p; p = p.parent) if (p.userData?.isHand) return;
      o.geometry.computeBoundingBox();
      min = Math.min(min, o.geometry.boundingBox.min.z + o.position.z);
      max = Math.max(max, o.geometry.boundingBox.max.z + o.position.z);
    });
    return max - min;
  };
  const knife = WEAPONS.find((w) => w.id === 'knife');
  const kn = len(knife.build(knife.view));
  const ka = len(SHAPE_BUILDS.katana(knife.view));
  const da = len(SHAPE_BUILDS.dagger(knife.view));
  ok(ka > kn * 1.2, `刀はナイフより長い（${kn.toFixed(3)} → ${ka.toFixed(3)}）`);
  ok(da < kn, `ダガーはナイフより短い（${kn.toFixed(3)} → ${da.toFixed(3)}）`);
}

console.log('\n[ストアの動線] 押す物と買う物が分かれているか');
{
  /* 2026-08-11に足した。同じ日に言われた2つ:

       「購入が2回クリックなのが嫌だわ。なんかpopoverじゃないけど、なんか出してみて」
       「買ったやつは購入済みってなるようにしてよ。ストア、いなくなるの寂しい」

     前は**同じボタンを2回押す**形だった（1回目が試着・2回目で購入）。
     押す回数そのものより、**2回目が何をするか分からない**のが問題だったので、
     買う操作を専用の札へ移した。

     **一番怖いのは「商品を押した瞬間に買う」形へ戻ること。**
     押し間違えでコインが減るのは取り返しがつかない（返金の手順を毎回書くことになる）*/
  const look = readFileSync(new URL('../src/ui/look.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  /* 並んだ商品を押しても買わない。押したら試着(_pick)へ行く。

     **2026-08-11に「着け替えの面も同じ形」へ揃えたので、条件が消えた。**
     前は `this.store ? this._pick(s) : this._wear(s.id)` で、
     ストアだけ試着・着け替えは即実行だった。
     今はどちらも試着だけなので、条件無しの `this._pick(s)` になっている
     （元より強い形。ストアだけでなく着け替えでも押し間違いで確定しない）*/
  ok(/b\.onclick = \(\) => this\._pick\(s\)/.test(look),
    '**商品を押しても買わない・着けない**（どちらの面でも試着だけ）');
  ok(/_pick\(s\)\s*\{[\s\S]{0,400}?this\.preview = s\.id/.test(look),
    '押すと試着になる');
  // 買うのは札の「買う」から1回だけ。呼び出し口が2つ以上あったら押し間違えの道が増える
  const buyCalls = (look.match(/this\._buy\(/g) || []).length;
  ok(buyCalls === 1, `_buyの呼び出し口は1箇所だけ（${buyCalls}箇所）`);
  ok(/this\.el\.buyGo\.onclick/.test(look), '買う札のボタンから呼んでいる');

  // 買った物を棚から消していないこと。**haveでcontinueしていたのが元の形**
  ok(!/this\.store && \(have \|\| s\.id === DEFAULT_SKIN\)/.test(look),
    '**買った物をストアから消していない**（「いなくなるの寂しい」）');
  ok(/if \(this\.store && have\) b\.classList\.add\('own'\)/.test(look),
    '買った物に印を付けている');
  ok(/\.lkitem\.own::after/.test(html) && /購入済み/.test(html),
    '印は「購入済み」と読める（CSSが文字を出す）');

  /* 足りない時は押す前に分かること。**押してから断られるより早い。**
     サーバー側でも断るが（server/store.js）、あれは守りでこちらは親切 */
  ok(/コイン足りません/.test(look), '足りない額を先に出す');
  ok(/el\.buyGo\.disabled = true/.test(look), '足りない時はボタンを押せなくする');

  // 買う札の器が画面に在ること。[9]が全部のidを突き合わせるが、ここは名指しで見る
  for (const id of ['lkBuy', 'lkBuyName', 'lkBuyPrice', 'lkBuyGo', 'lkBuyNote']) {
    ok(html.includes(`id="${id}"`), `${id} が画面に在る`);
  }
}

console.log('\n[装備の分かりやすさ] 着けているかが読めて、装備ボタンがあるか');
{
  /* 2026-08-11に足した。**「装備してるかどうかがわかりづらい。装備するボタンも欲しい」。**

     それまで着け替えの面は
       ・着けている物の印が「選んでいる」の印(.on)と同じ見た目
       ・押した瞬間に着く（速いが、着いたことが画面のどこにも出ない）
     の2つで、**着けているのか見ているだけなのかが読めなかった。**

     ストアの札（購入）と同じ形に揃えた。押すのは試着だけで、
     やるのは札のボタン1回。器も同じ物を使い回している
     （やることが違っても「選んだ物に対して1つ押す」は同じなので、
       同じ位置に同じ形で出る方が読みやすい）*/
  const look = readFileSync(new URL('../src/ui/look.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

  // 着けている物に印が付くこと。**ストアには出さない**（あちらは買う場所）
  ok(/if \(!this\.store && s\.id === skinFor\(this\.weapon\)\) b\.classList\.add\('wearing'\)/.test(look),
    '着けている物に印を付けている（着け替えの面だけ）');
  ok(/\.lkitem\.wearing::after/.test(html) && /装備中/.test(html),
    '印は「装備中」と読める（CSSが文字を出す）');
  /* **「選んでいる」の印と見た目が違うこと。**
     同じだと区別が付かない（それが元の不具合）*/
  ok(/\.lkitem\.on \{/.test(html) && /\.lkitem\.wearing \{/.test(html),
    '「選んでいる」と「装備中」で別の見た目を持っている');

  // 押した瞬間に着けないこと。押すのは試着だけ
  ok(/b\.onclick = \(\) => this\._pick\(s\)/.test(look),
    '**押した瞬間に着けない**（試着だけ）');
  ok(/_wear\(id\); return;/.test(look), '装備は札のボタンから呼んでいる');
  ok(/装備する/.test(look) && /装備中/.test(look),
    '札に「装備する」と「装備中」の両方が出る');

  /* 開いた時点で今着けている物が選ばれていること。
     nullで開くと札が畳まれて、押すまで「今どれを着けているか」が分からない */
  ok(/this\.preview = this\.store \? null : skinFor\(id\)/.test(look),
    '武器を選ぶと、その武器で今着けている物が選ばれる');
  ok(/this\.preview = store \? null : skinFor\(this\.weapon\)/.test(look),
    '着け替えの面を開いた時も今着けている物から始まる');
}

console.log('\n[変化の大きさ] 売る色スキンが、見て分かるほど変わっているか');
{
  /* 2026-08-11に足した。**「地味すぎる」で作り直した後、二度と戻せないようにする。**
     測ったら本当に地味だったので、その時の値をここに残しておく:

       歴戦   0 … **色の指定が1つも無かった。** 擦れの量だけ上げたスキンで、
                  擦れは角にしか出ないので、600コインで何も変わらない商品だった
       アーバン 30 … 紺黒(#1d2024)の上に青灰(#2b323c)。暗い色に暗い色を塗っていた
       デザート 121 … 変わってはいたが、隣のキャンディ(376)に食われて地味に見えた

     **通っている時点では何も分からない類の不具合。** 色は入っているし、
     材質も焼けているし、画面にも出る。ただ変わっていないだけなので、
     数えないと気づけない。

     元の色は MATS からは取れない。**擦れを焼いた材質は色が白に置き換わる**ので
     （weapons.jsのmat()に「色はマップ側が全部持つ」と書いてある）、
     MATS.enamel.color を読むと 0xffffff が返る。
     だから元の色は weapons.js の mat(0x......) から、
     塗り替えの色は skins.js の over から、どちらも本文を読んで取る
     （このファイルは[3]でも同じやり方をしている） */
  const wsrc = readFileSync(new URL('../src/player/weapons.js', import.meta.url), 'utf8');
  const ssrc = readFileSync(new URL('../src/player/skins.js', import.meta.url), 'utf8');

  // MATSの元の色。「  なまえ: mat(0x......,」の形で並んでいる
  const BASE = {};
  for (const m of wsrc.matchAll(/^ {2}(\w+): mat\((0x[0-9a-fA-F]{6})/gm)) {
    BASE[m[1]] = parseInt(m[2], 16);
  }
  ok(Object.keys(BASE).length > 8, `元の色が ${Object.keys(BASE).length} 個読めた`);

  /* 目で見た距離。**緑に重みを置く。** 人の目は緑に一番敏感なので、
     RGBを素直に足すと「青だけ変えた」を過大に、「緑を変えた」を過小に数える */
  const rgb = (h) => [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  const dist = (a, b) => {
    const [r1, g1, b1] = rgb(a); const [r2, g2, b2] = rgb(b);
    return Math.sqrt(2 * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + 3 * (b1 - b2) ** 2);
  };

  /* skins.jsのPAINTから、その名前の over の色だけ拾う。
     **SKINSの over をそのまま使わない。** あちらは同じ塗り替えを
     形違い(SHAPE_LOOK)とも混ぜて持っていて、ここで見たいのは
     「色スキンとして売っている物」だけなので、表の切れ目で区切って読む */
  const overOf = (name) => {
    const at = ssrc.indexOf(`\n  ${name}: {`);
    if (at < 0) return null;
    const rest = ssrc.slice(at + 3);
    const end = rest.search(/\n {2}[a-zA-Z]+: \{|\n\};/);
    const body = rest.slice(0, end < 0 ? rest.length : end);
    const out = {};
    for (const m of body.matchAll(/(\w+): \{ color: (0x[0-9a-fA-F]{6})/g)) {
      out[m[1]] = parseInt(m[2], 16);
    }
    return out;
  };

  /* 下限。**今の一番低い物（歴戦126）より下**に置いてある。
     ここを実測ぴったりに置くと、色を1つ触るたびに落ちて誰も直せなくなる。
     「明らかに地味」を弾くのが目的なので、その線で足りる。
     参考: アーバンは直す前が30で、直した後は233 */
  const FLOOR = 80;
  const MIN_MATS = 3;

  for (const s of SKIN_LIST) {
    if (s.id === DEFAULT_SKIN) continue;   // 標準は商品ではない
    const over = overOf(s.id);
    if (!over) { ok(false, `${s.name} … skins.jsに塗り方が無い`); continue; }
    const keys = Object.keys(over).filter((k) => BASE[k] != null);

    // **材質の数から見る。** 1つだけ塗り替えた物は、その部品が見えない角度で無地に戻る
    ok(keys.length >= MIN_MATS,
      `${s.name} … 色を変えた材質が ${keys.length} 個（${MIN_MATS}個以上）`);

    if (!keys.length) continue;
    const avg = keys.reduce((a, k) => a + dist(BASE[k], over[k]), 0) / keys.length;
    ok(avg >= FLOOR,
      `${s.name}(${s.price}コイン) … 目で見た変化 ${avg.toFixed(0)}（${FLOOR}以上）`);
  }

  /* **値段が高いほど変わる、までは求めない。**
     ゴールドは金属の光りかたで値打ちを出していて、色の距離では測れない。
     ただ「一番安い物より変わらない一番高い物」は通さない
     （歴戦600が0で、デザート300が121だったのがまさにその形だった） */
  const paid = SKIN_LIST.filter((s) => s.id !== DEFAULT_SKIN);
  const score = (s) => {
    const over = overOf(s.id) || {};
    const keys = Object.keys(over).filter((k) => BASE[k] != null);
    return keys.length ? keys.reduce((a, k) => a + dist(BASE[k], over[k]), 0) / keys.length : 0;
  };
  const cheapest = paid.reduce((a, b) => (a.price <= b.price ? a : b));
  const dearest = paid.reduce((a, b) => (a.price >= b.price ? a : b));
  ok(score(dearest) >= score(cheapest) * 0.5,
    `一番高い${dearest.name}(${score(dearest).toFixed(0)})が、`
    + `一番安い${cheapest.name}(${score(cheapest).toFixed(0)})の半分は変わっている`);
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
