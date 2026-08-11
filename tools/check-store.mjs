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
  SKIN_LIST, SHAPE_LIST, SKINNABLE, SKIN_IDS, DEFAULT_SKIN, skuOf, parseSku, skinInfo,
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
    // 鍵は「武器＋枠」。**枠が2つある**ので、武器だけを鍵にすると
    // 形を着けた瞬間に色が消える（本物の主キーと同じ形にしておく）
    if (s.startsWith('INSERT INTO equipped_skins')) {
      st.equipped.set(`${params[1]}|${params[2]}`, params[3]);
      return { rows: [] };
    }
    if (s.startsWith('SELECT weapon_id, slot, skin_id')) {
      return {
        rows: [...st.equipped].map(([k, skin_id]) => {
          const [weapon_id, slot] = k.split('|');
          return { weapon_id, slot, skin_id };
        }),
      };
    }
    return { rows: [] };
  };
  return { query, st, sqls };
}

const RIFLE_GOLD = skuOf('rifle', 'gold');
const GOLD = skinInfo('gold').price;

/* ------------------------------------------------------------ 品揃え */

console.log('\n[1] 品揃えと値段');
{
  ok(SKIN_LIST.length >= 3, `${SKIN_LIST.length}種`);
  ok(SKIN_LIST[0].id === DEFAULT_SKIN && SKIN_LIST[0].price === 0,
    '標準は0コイン（**最初から全員が持っている**）');
  ok(SKIN_LIST.every((s) => s.id === DEFAULT_SKIN || s.price > 0), '標準以外は必ず有料');
  ok(SKINNABLE.length >= 4, `スキンを着せられる武器が ${SKINNABLE.length} 本`);
  const items = (SKIN_IDS.length - 1) * SKINNABLE.length;
  ok(items >= 12, `商品は ${items} 品（武器ごとに別の商品）`);
}

console.log('\n[2] 商品の文字列');
{
  const it = parseSku(RIFLE_GOLD);
  ok(!!it && it.weapon === 'rifle' && it.skin === 'gold', 'ちゃんとした物は分解できる');
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
  const r = await buy(db.query, '7', RIFLE_GOLD);
  ok(r.ok, `買えた${r.ok ? '' : ` ← ${r.error}`}`);
  ok(r.coins === 5000 - GOLD, `残高が引かれた（5000 → ${r.coins}）`);
  ok(db.st.owned.has(RIFLE_GOLD), '持ち物に入った');

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
  const r = await buy(db.query, '7', RIFLE_GOLD);
  ok(!r.ok && r.error === BUY_ERR.POOR, `断られた（${r.error}）`);
  ok(db.st.coins === 100, '**残高が1枚も減っていない**');
  ok(!db.st.owned.has(RIFLE_GOLD), '持ち物にも入っていない');
  ok(db.sqls.some((x) => x.s === 'ROLLBACK'), '取り消している');
}

console.log('\n[6] 買う — 2回は買えない、払わされない');
{
  const db = fakeDb(5000);
  await buy(db.query, '7', RIFLE_GOLD);
  const after1 = db.st.coins;
  const r = await buy(db.query, '7', RIFLE_GOLD);
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
  const db = fakeDb(0, [RIFLE_GOLD]);
  const good = await equip(db.query, '7', 'rifle', 'paint', 'gold');
  ok(good.ok, '持っている物は着けられる');

  const ng = await equip(db.query, '7', 'pistol', 'paint', 'gold');
  ok(!ng.ok, '**同じスキンでも武器が違えば別の商品**（持っていないので断る）');

  const st = await equip(db.query, '7', 'pistol', 'paint', DEFAULT_SKIN);
  ok(st.ok, '標準はいつでも着けられる（買う物ではない）');

  ok(!(await equip(db.query, '7', 'rocket', 'paint', 'gold')).ok, '知らない武器は断る');
  ok(!(await equip(db.query, '7', 'rifle', 'paint', 'diamond')).ok, '知らないスキンは断る');
  /* **枠を跨いだ指定を通さない。** 通すと、形の枠が色で埋まって形が消える。
     画面側でも枠を分けているが、あれは親切であって守りではない */
  ok(!(await equip(db.query, '7', 'rifle', 'shape', 'gold')).ok,
    '**色を形の枠へは入れられない**');
  ok(!(await equip(db.query, '7', 'knife', 'paint', 'katana')).ok,
    '**形を色の枠へは入れられない**');
  ok(!(await equip(db.query, '7', 'rifle', 'いろ', 'gold')).ok, '知らない枠は断る');

  const now = await equippedOf(db.query, '7');
  ok(now.rifle.paint === 'gold' && now.pistol.paint === DEFAULT_SKIN,
    '**武器ごとに別々に残る**');
  ok(now.rifle.shape === DEFAULT_SKIN, '触っていない枠は標準のまま');

  // 着け替えは1本のSQL。消してから入れると、間で落ちた時に裸になる
  const sql = db.sqls.filter((x) => /equipped_skins/.test(x.s)).map((x) => x.s);
  ok(!sql.some((s) => /DELETE/.test(s)), '消してから入れていない');
  ok(sql.some((s) => /ON CONFLICT .* DO UPDATE/.test(s)), '1本のSQLで入れ替える');
}

console.log('\n[9] 持ち物の読み取り');
{
  const db = fakeDb(0, [RIFLE_GOLD, skuOf('pistol', 'desert')]);
  const list = await ownedOf(db.query, '7');
  ok(list.length === 2 && list.includes(RIFLE_GOLD), '持っている物が全部返る');
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

  const eq = STEPS.find((s) => /CREATE TABLE equipped_skins/.test(s.sql));
  ok(!!eq, `装備の手順がある（${eq?.n}番）`);
  ok(/ON DELETE CASCADE/.test(owned.sql) && /ON DELETE CASCADE/.test(eq.sql),
    '会員を消したら持ち物も装備も消える');

  /* **枠が2つになった（形・色）。** 主キーに枠が入っていないと、
     形を着けた瞬間に色の行が上書きされて消える */
  const slot = STEPS.find((s) => /ALTER TABLE equipped_skins/.test(s.sql));
  ok(!!slot, `枠を分ける手順がある（${slot?.n}番）`);
  ok(/PRIMARY KEY \(user_id, weapon_id, slot\)/.test(slot.sql),
    '**1本の武器の1枠につき1つ**（形と色が別々に残る）');
  /* 既にある行を、中身を見て振り分けている。**やらないと刀を着けていた人が
     全員「金色の普通のナイフ」になる。** SQLからprotocol.jsを呼べないので
     形のidを直書きしているぶん、ここで表とずれていないかを見る。
     **新しい形を足した時にここへ足す必要は無い**（効くのは既にある行だけ）ので、
     見るのは「この手順を書いた時点で在った形が全部載っているか」 */
  const listed = [...slot.sql.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const atThatTime = ['katana', 'dagger', 'dragon', 'cute'];
  for (const id of atThatTime) ok(listed.includes(id), `振り分けに ${id} が載っている`);
  for (const id of atThatTime) {
    ok(SHAPE_LIST.some((x) => x.id === id), `${id} が今も形の商品として実在する`);
  }
  ok(/DEFAULT 'paint'/.test(slot.sql), '振り分けから漏れた行は色の枠へ入る');
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
