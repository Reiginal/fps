// 狙撃銃の検査。
//
// なぜ要るか: 遊んで「1人プレイで第二波までいったらスナイパー使えるようにしてほしい。
// アサルトよりも遠くまで覗けて、ヘッドショットなら割と1撃、bodyなら2発ぐらい。5発まで」
// と言われて足した武器で、**注文が全部「数字」で書かれている。**
// 数字で書かれた注文は数字で確かめられるので、ここで固定する。
//
// 一番こわいのは「持ち物が増える」側で、ここは画面を開かないと分からない場所に
// 書きがちなところ。**条件を protocol.js の表(SOLO_UNLOCKS)へ出してある**ので、
// ブラウザ無しでそのまま引ける。
//
//   node tools/check-sniper.mjs
import { readFileSync } from 'node:fs';
import '../server/dom-stub.js';
import { LOADOUT_IDS, loadoutOf, soloCarryAt, SOLO_UNLOCKS } from '../src/net/protocol.js';

const { WEAPONS } = await import('../src/player/weapons.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const byId = Object.fromEntries(WEAPONS.map((d) => [d.id, d]));
const sniper = byId.sniper;
const rifle = byId.rifle;

console.log('\n[1] 表にはあるが、最初は持って出ない');
ok(!!sniper, '武器の表にスナイパーがある');
ok(!LOADOUT_IDS.includes('sniper'), '既定の持ち物には入っていない');
ok(soloCarryAt(WEAPONS, 0).length === loadoutOf(WEAPONS).length, '出撃前(0波)は既定のまま');
ok(!soloCarryAt(WEAPONS, 1).includes(WEAPONS.indexOf(sniper)), '第1波ではまだ持っていない');

console.log('\n[2] 第2波で増える');
{
  const at2 = soloCarryAt(WEAPONS, 2);
  const i = WEAPONS.indexOf(sniper);
  ok(at2.includes(i), '第2波で持ち物に入る');
  // **後ろに足す。** 途中へ差し込むと、体が覚えた1〜4の並びが試合中に入れ替わる
  ok(at2[at2.length - 1] === i, `並びの最後に付く（${at2.length}番キー）`);
  const base = loadoutOf(WEAPONS);
  ok(base.every((w, k) => at2[k] === w), '1〜4の並びは動かない');
  ok(at2.length === base.length + 1, `増えるのは1本だけ（${base.length}→${at2.length}）`);
  // 何波行っても増え続けない
  ok(soloCarryAt(WEAPONS, 30).length === base.length + 1, '第30波でも本数は同じ');
  ok(SOLO_UNLOCKS.every((u) => WEAPONS.some((w) => w.id === u.id)),
    '解放表に載っている名前が全部、武器の表にある');
}

console.log('\n[2.5] 5番まで指を伸ばさずに握れるか');
/* 遊んで「5押すのは流石に指的に遠い」と言われた所。
   往復キー(Q)の中身は武器側が持っている（tools/check-weapons.mjsの[5.8]）ので、
   ここで見るのは**繋ぎ込みの3点**だけ。どれか1つ抜けると、
   キーはあるのに効かない・支給されたのにQが別の武器を指す、になる */
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(/input\.pressed\('KeyQ'\)/.test(main), 'Qを見ている');
  ok(/KeyQ[\s\S]{0,400}?swapLast\(\)/.test(main), 'Qで往復を呼んでいる');
  // 支給された瞬間にQの行き先をそこへ向ける。無いと最初の1回だけ5を押すことになる
  ok(/added\.length === 0[\s\S]{0,400}?lastIndex = added\[0\]/.test(main),
    '支給された物がQの行き先になる');
  ok(/<b>Q<\/b>/.test(html), '起動画面の操作説明にQがある');
}

console.log('\n[3] 注文どおりの手数か');
/* 敵の体力は波で決まる（src/ai/enemy.js: 100 + min(波*12, 120)）。
   **一番固い敵(220)でも頭1発・胴2発**であること。ここが崩れると、
   波が進んだ途端に「一番当たらない銃が一番手数も要る」ことになる */
const ENEMY_MAX = 220;   // 第10波以降
const ENEMY_MIN = 112;   // 第1波
const PLAYER_HP = 130;   // 対戦の人（今は配らないが、配った時のために見る）
{
  ok(sniper.mag === 5, `弾倉は5発（今 ${sniper.mag}）`);
  const head = sniper.damage * sniper.headMult;
  ok(head >= ENEMY_MAX, `頭1発で一番固い敵も倒れる（${head} >= ${ENEMY_MAX}）`);
  ok(sniper.damage * 2 >= ENEMY_MAX, `胴2発で倒れる（${sniper.damage * 2} >= ${ENEMY_MAX}）`);
  ok(sniper.damage < ENEMY_MIN, `胴1発では倒せない（${sniper.damage} < ${ENEMY_MIN}）`);
  ok(head >= PLAYER_HP && sniper.damage < PLAYER_HP,
    `対人でも頭1発・胴2発（頭${head} / 胴${sniper.damage} / 体力${PLAYER_HP}）`);
  /* この地形は端から端まで80mしかない（level.jsのbounds 40）。
     減衰が始まるのがその外なら、**この地形では常に全弾が満額**で入る。
     上の「胴2発」が距離で崩れないのはこれが根拠 */
  ok(sniper.falloffStart >= 100, `減衰の始まりが地形の外（${sniper.falloffStart}m。地形は80m）`);
}

console.log('\n[4] アサルトより遠くまで覗ける');
{
  ok(sniper.adsFov < rifle.adsFov,
    `覗いた時の画角が狭い（狙撃${sniper.adsFov}度 / ライフル${rifle.adsFov}度）`);
  const mag = Math.tan((75 * Math.PI) / 360) / Math.tan((sniper.adsFov * Math.PI) / 360);
  const rmag = Math.tan((75 * Math.PI) / 360) / Math.tan((rifle.adsFov * Math.PI) / 360);
  ok(mag > rmag * 2, `見える大きさが2倍以上（狙撃${mag.toFixed(1)}倍 / ライフル${rmag.toFixed(1)}倍）`);
  // 倍率を上げたら視点の効きも一緒に落とすこと。落とさないと画面上で
  // 景色が倍率のぶんだけ速く流れて、狙いが一切定まらない
  ok((sniper.adsSlow ?? 0.45) > 0.45,
    `覗いている間は視点の効きを落とす（感度 ${Math.round((1 - (sniper.adsSlow ?? 0.45)) * 100)}%）`);
  ok(sniper.adsTime > rifle.adsTime,
    `覗き終わるまでは遅い（狙撃${sniper.adsTime}秒 / ライフル${rifle.adsTime}秒）`);
}

console.log('\n[5] 覗かないと当たらない銃になっている');
{
  ok(sniper.spreadHip > rifle.spreadHip * 2,
    `腰だめは論外の広さ（20m先で${(Math.tan(sniper.spreadHip) * 20 * 100).toFixed(0)}cm）`);
  ok(sniper.spreadAds < rifle.spreadAds,
    `覗けばライフルより締まる（20m先で${(Math.tan(sniper.spreadAds) * 20 * 1000).toFixed(0)}mm）`);
  ok(!sniper.auto, '押しっぱなしでは連射できない');
  const gap = 60 / sniper.rpm;
  ok(gap >= 1.0, `次の1発まで${gap.toFixed(2)}秒（1発ずつ送る銃）`);
  ok(sniper.reserve === sniper.mag * 5, `予備は5弾倉ぶん（${sniper.reserve}発）`);
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
