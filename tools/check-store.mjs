// ストアの検査。**台帳に繋がずに走る。**
//
// 買い物は間違えた時の代償がコインを配るより大きい。
//   ・払ったのに物が来ない → 遊ぶ側から見て一番腹が立つ
//   ・払わずに物が来る → こちらが損をするうえ、後から回収できない
//   ・二重に払う → 連打で普通に起きる
//
// なので**流れたSQLの形を実際に見て**、
//   ・判定がUPDATEの中に入っていること（読んでから判定していない）
//   ・BEGINとCOMMITで囲まれていること
//   ・値段をクライアントから受け取っていないこと
// を押さえる。
//
//   node tools/check-store.mjs
import { readFileSync } from 'node:fs';
import { buy, equip, ownedOf, equippedOf, BUY_ERR } from '../server/store.js';
import { STEPS } from '../server/migrations.js';
import {
  SKIN_LIST, SKINNABLE, DEFAULT_SKIN, skuOf, parseSku, skinInfo, itemsFor,
} from '../src/net/protocol.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* ------------------------------------------------------------ 偽の台帳 */

/* 財布と持ち物だけを持つ。**取引も真似る**（ROLLBACKで元へ戻る）。
   ここを真似ないと「払ったのに物が来ない」を確かめられない */
function fakeDb(coins = 1000, owned = []) {
  const st = { coins, owned: new Set(owned), equipped: new Map() };
  let snap = null;
  const sqls = [];

  const query = async (sql, params = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    sqls.push({ s, params });

    if (s === 'BEGIN') { snap = { coins: st.coins, owned: new Set(st.owned) }; return { rows: [] }; }
    if (s === 'COMMIT') { snap = null; return { rows: [] }; }
    if (s === 'ROLLBACK') {
      if (snap) { st.coins = snap.coins; st.owned = snap.owned; snap = null; }
      return { rows: [] };
    }
    if (s.startsWith('UPDATE wallets SET coins = coins -')) {
      const [, price] = params;
      // **足りている時だけ減る。** 足りなければ0行（それが「買えない」の返事）
      if (st.coins < price) return { rows: [] };
      st.coins -= price;
      return { rows: [{ coins: st.coins }] };
    }
    if (s.startsWith('INSERT INTO owned_skins')) {
      const sku = params[1];
      if (st.owned.has(sku)) { const e = new Error('dup'); e.code = '23505'; throw e; }
      st.owned.add(sku);
      return { rows: [] };
    }
    if (s.startsWith('SELECT sku FROM owned_skins')) {
      return { rows: [...st.owned].map((sku) => ({ sku })) };
    }
    if (s.startsWith('SELECT 1 FROM owned_skins')) {
      return { rows: st.owned.has(params[1]) ? [{ '?column?': 1 }] : [] };
    }
    if (s.startsWith('INSERT INTO equipped_skins')) {
      st.equipped.set(params[1], params[2]);
      return { rows: [] };
    }
    if (s.startsWith('SELECT weapon_id, skin_id')) {
      return { rows: [...st.equipped].map(([weapon_id, skin_id]) => ({ weapon_id, skin_id })) };
    }
    return { rows: [] };
  };
  return { query, st, sqls };
}

const KNIFE_GOLD = skuOf('knife', 'gold');
const GOLD = skinInfo('gold').price;

/* ------------------------------------------------------------ 品揃え */

console.log('\n[1] 品揃えと値段');
{
  ok(SKIN_LIST.length >= 3, `色は${SKIN_LIST.length}種（標準を含む）`);
  ok(SKIN_LIST[0].id === DEFAULT_SKIN && SKIN_LIST[0].price === 0,
    '標準は0コイン（**最初から全員が持っている**）');
  ok(SKIN_LIST.every((s) => s.id === DEFAULT_SKIN || s.price > 0), '標準以外は必ず有料');
  ok(SKINNABLE.length >= 4, `スキンを着せられる武器が ${SKINNABLE.length} 本`);
  /* **色だけで数えない。** 2026-08-11に色を4種から2種（迷彩・ゴールド）へ減らして、
     そのぶん形違いを武器ごとに2つずつ揃えた。
     色の数だけで数えていた頃の式は、その入れ替えで数が半分になったように見える。

     遊ぶ側から見た品揃えは itemsFor(武器) が返す物なので、そこを数える */
  const perWeapon = SKINNABLE.map((w) => ({ w, n: itemsFor(w).length }));
  const items = perWeapon.reduce((a, x) => a + x.n, 0);
  ok(items >= 12, `商品は ${items} 品（武器ごとに別の商品）`);
  /* **どの武器にも買う物がある。** 1本だけ品揃えが薄いと、
     その武器を使う人だけ買う物が無い状態になる。

     狙いは「各武器に4種類ぐらい」（2026-08-11に言われた）だが、
     **下限は2にしてある。** 最初は4で、ボーン（拳銃の4つ目）を
     「マジダサすぎる。いらない」で消した時に3へ、
     サメ（ショットガンの2つ目）を「いらないから削除でいい」で消した時（2026-08-14）に
     2へ下げた。

     高いままにすると、**気に入らない物を消すたびに検査が落ちる。**
     見た目の good/bad はこちらでは判断できない領域なので、
     消せなくなる形にするのは筋が悪い。
     下限は「買う物が無い武器を作らない」に置いて、
     何を増やすかは人が決める */
  const thin = perWeapon.filter((x) => x.n < 2);
  ok(thin.length === 0,
    `どの武器にも2種類以上ある${thin.length ? ` ← ${thin.map((x) => `${x.w}(${x.n})`).join('、')}` : ''}`);
  // 4種類に届いていない武器は、落とさずに名前だけ出す（次に足す先が分かる）
  const short = perWeapon.filter((x) => x.n < 4).map((x) => `${x.w}(${x.n})`);
  ok(true, `4種類に届いていない武器${short.length ? `: ${short.join('、')}` : 'は無い'}`);
}

console.log('\n[2] 商品の文字列');
{
  const it = parseSku(KNIFE_GOLD);
  ok(!!it && it.weapon === 'knife' && it.skin === 'gold', 'ちゃんとした物は分解できる');
  ok(it.price === GOLD, `**値段は表から引く**（${GOLD}コイン）`);
  ok(parseSku('rifle:stock') === null, '標準は商品として存在しない（買えない）');
  ok(parseSku('rocket:gold') === null, '知らない武器は断る');
  ok(parseSku('rifle:diamond') === null, '知らないスキンは断る');
  ok(parseSku('') === null && parseSku(null) === null, '空でも落ちない');
  ok(parseSku('rifle:gold:extra') === null, '余計な物が付いていたら断る');
}

console.log('\n[3] 買う — 値段をクライアントから受け取らない');
{
  const src = readFileSync(new URL('../server/store.js', import.meta.url), 'utf8');
  ok(/parseSku\(rawSku\)/.test(src), '送られてくるのは「どれを買うか」だけ');
  ok(!/body\.price|params?\.price|\.price\s*=/.test(src),
    '**値段を受け取っていない**（受け取ると0円で買える）');

  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/buy\(q, me\.id, body\.sku\)/.test(idx), 'HTTPの口もskuしか渡していない');
  ok(/db\.withClient\(\(q\) => buy\(/.test(idx),
    '**1本の接続の上で買う**（プールだとBEGINとCOMMITが別の線へ散る）');
}

console.log('\n[4] 買う — 足りていれば買える');
{
  const db = fakeDb(5000);
  const r = await buy(db.query, '7', KNIFE_GOLD);
  ok(r.ok, `買えた${r.ok ? '' : ` ← ${r.error}`}`);
  ok(r.coins === 5000 - GOLD, `残高が引かれた（5000 → ${r.coins}）`);
  ok(db.st.owned.has(KNIFE_GOLD), '持ち物に入った');

  const forms = db.sqls.map((x) => x.s);
  ok(forms[0] === 'BEGIN' && forms[forms.length - 1] === 'COMMIT',
    '**BEGINで始まりCOMMITで終わる**（途中で落ちても半端が残らない）');
  const pay = db.sqls.find((x) => /UPDATE wallets/.test(x.s));
  ok(/WHERE user_id = \$1 AND coins >= \$2/.test(pay.s),
    '**判定がUPDATEの中に入っている**（読んでから判定していない）');
  ok(!forms.some((s) => /SELECT coins FROM wallets/.test(s)),
    '残高を先に読んでいない');
}

console.log('\n[5] 買う — 足りなければ買えない、減らない');
{
  const db = fakeDb(100);
  const r = await buy(db.query, '7', KNIFE_GOLD);
  ok(!r.ok && r.error === BUY_ERR.POOR, `断られた（${r.error}）`);
  ok(db.st.coins === 100, '**残高が1枚も減っていない**');
  ok(!db.st.owned.has(KNIFE_GOLD), '持ち物にも入っていない');
  ok(db.sqls.some((x) => x.s === 'ROLLBACK'), '取り消している');
}

console.log('\n[6] 買う — 2回は買えない、払わされない');
{
  const db = fakeDb(5000);
  await buy(db.query, '7', KNIFE_GOLD);
  const after1 = db.st.coins;
  const r = await buy(db.query, '7', KNIFE_GOLD);
  ok(!r.ok && r.error === BUY_ERR.OWNED, `2回目は断られた（${r.error}）`);
  ok(db.st.coins === after1,
    '**2回目で払わされていない**（取り消したので残高が戻っている）');
  ok(db.st.owned.size === 1, '持ち物も増えていない');
}

console.log('\n[7] 買う — 変な商品');
{
  const db = fakeDb(5000);
  for (const sku of ['rifle:stock', 'rocket:gold', '', null, 'rifle']) {
    const r = await buy(db.query, '7', sku);
    ok(!r.ok && r.error === BUY_ERR.BAD, `${JSON.stringify(sku)} は断る`);
  }
  ok(db.st.coins === 5000, '1枚も減っていない');
  ok(db.sqls.length === 0, '**台帳へ問い合わせてすらいない**（入口で断っている）');
}

console.log('\n[8] 装備 — 持っている物しか着けられない');
{
  const db = fakeDb(0, [KNIFE_GOLD]);
  const good = await equip(db.query, '7', 'knife', 'gold');
  ok(good.ok, '持っている物は着けられる');

  const ng = await equip(db.query, '7', 'pistol', 'gold');
  ok(!ng.ok, '**同じスキンでも武器が違えば別の商品**（持っていないので断る）');

  const st = await equip(db.query, '7', 'pistol', DEFAULT_SKIN);
  ok(st.ok, '標準はいつでも着けられる（買う物ではない）');

  ok(!(await equip(db.query, '7', 'rocket', 'gold')).ok, '知らない武器は断る');
  ok(!(await equip(db.query, '7', 'rifle', 'diamond')).ok, '知らないスキンは断る');

  const now = await equippedOf(db.query, '7');
  ok(now.knife === 'gold' && now.pistol === DEFAULT_SKIN, '**武器ごとに別々に残る**');

  // 着け替えは1本のSQL。消してから入れると、間で落ちた時に裸になる
  const sql = db.sqls.filter((x) => /equipped_skins/.test(x.s)).map((x) => x.s);
  ok(!sql.some((s) => /DELETE/.test(s)), '消してから入れていない');
  ok(sql.some((s) => /ON CONFLICT .* DO UPDATE/.test(s)), '1本のSQLで入れ替える');
}

console.log('\n[9] 持ち物の読み取り');
{
  const db = fakeDb(0, [KNIFE_GOLD, skuOf('pistol', 'camo')]);
  const list = await ownedOf(db.query, '7');
  ok(list.length === 2 && list.includes(KNIFE_GOLD), '持っている物が全部返る');
  const none = await ownedOf(fakeDb(0, []).query, '7');
  ok(Array.isArray(none) && none.length === 0, '何も持っていなければ空の配列');
}

console.log('\n[10] 台帳の作り');
{
  const owned = STEPS.find((s) => /owned_skins/.test(s.sql));
  ok(!!owned, `持ち物の手順がある（${owned?.n}番）`);
  ok(/PRIMARY KEY \(user_id, sku\)/.test(owned.sql),
    '**同じ物を2回買えないのが台帳の作りとして保証される**');
  ok(/price\s+INTEGER/.test(owned.sql), 'いくらで買ったかが残る（値段を変えても消えない）');

  const eq = STEPS.find((s) => /equipped_skins/.test(s.sql));
  ok(!!eq, `装備の手順がある（${eq?.n}番）`);
  ok(/PRIMARY KEY \(user_id, weapon_id\)/.test(eq.sql),
    '1本の武器に2つ装備できない');
  ok(/ON DELETE CASCADE/.test(owned.sql) && /ON DELETE CASCADE/.test(eq.sql),
    '会員を消したら持ち物も装備も消える');
}

console.log('\n[11] ログインしていない人');
{
  const idx = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  ok(/ログインしてください/.test(idx),
    '**「そんな商品はありません」で終わらせない**（何が悪いか分かる文言を返す）');
  ok(/const me = await auth\.sessionUser\(db\.query, token\);\s*\n\s*if \(!me\)/.test(idx),
    '買う前に誰かを確かめている');
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
