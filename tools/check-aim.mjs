// 狙いの当たり具合を、距離と的の大きさに直して出す。
//
// ばらつきは0.024ラジアンのような数字で持っていて、そのままでは
// 当たるのか当たらないのかが読めない。20m先で何cmに散るかへ直すと、
// 頭(18cm)や胴(45cm)と並べて「当たるか」で話せるようになる。
//
// 「動きながら撃てるようにしたい」と言われた時、勘で係数をいじる前に
// ここを見る。実際、下げる前の値でも走りながら覗けば20m先14cmで、
// 「動くと当たらない」の実体はほとんど無かった。
// 効いていたのは移動ではなく、腰だめか覗いているかの差だった。
//
//   node tools/check-aim.mjs
import '../server/dom-stub.js';

const { WEAPONS } = await import('../src/player/weapons.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

// 移動の速さ1m/sあたりに足すばらつき。weapons.jsのMOVE_SPREADと同じ値を持つ。
// あちらから読めないので写している（変えたらここも直す）
const MOVE_SPREAD = 0.0028;
// 覗いている間の効きの落とし方も同じく写し
const ADS_DAMP = 0.75;

const HEAD_W = 0.18;   // 頭のおよその幅(m)
const BODY_W = 0.45;   // 胴のおよその幅(m)

/** ばらつき角を、その距離での直径(cm)に直す */
const cmAt = (rad, dist) => Math.tan(rad) * dist * 100;

const rifle = WEAPONS.find((w) => w.id === 'rifle');

console.log('\n[1] ライフルの散らばり（20m先・cm）');
const at20 = (spread) => cmAt(spread, 20);
const hip0 = at20(rifle.spreadHip);
const hipRun = at20(rifle.spreadHip + 4.6 * MOVE_SPREAD);
const ads0 = at20(rifle.spreadAds);
const adsRun = at20(rifle.spreadAds + 4.6 * MOVE_SPREAD * (1 - ADS_DAMP));
console.log(`  止まって腰だめ ${hip0.toFixed(0)}cm / 走って腰だめ ${hipRun.toFixed(0)}cm`);
console.log(`  止まって覗く ${ads0.toFixed(0)}cm / 走って覗く ${adsRun.toFixed(0)}cm`);

// 覗けば当たる。ここが崩れると、この作りの前提そのものが変わる
ok(adsRun < HEAD_W * 100, `走りながら覗いても頭に当たる (${adsRun.toFixed(0)}cm < 頭${HEAD_W * 100}cm)`);

// 腰だめは近くでだけ成立する。遠くまで当たると覗く意味が消える
const hipAt10 = cmAt(rifle.spreadHip, 10);
ok(hipAt10 < BODY_W * 100, `10m先なら腰だめでも胴に当たる (${hipAt10.toFixed(0)}cm < 胴${BODY_W * 100}cm)`);
ok(hip0 > HEAD_W * 100, `20m先の腰だめでは頭に当たらない (${hip0.toFixed(0)}cm > 頭${HEAD_W * 100}cm)`);

console.log('\n[2] 覗く価値が残っているか');
// 覗いた時と腰だめの差。ここが小さいと、覗く操作そのものが要らなくなる
const ratio = rifle.spreadHip / rifle.spreadAds;
ok(ratio > 8, `覗くと ${ratio.toFixed(0)}倍 締まる（8倍以上あれば覗く意味がある）`);

console.log('\n[3] 移動の効き');
// 移動で広がる量。0にすると走り撃ちが止まり撃ちと同じになり、
// 立ち止まる理由が無くなって撃ち合いが噛み合わなくなる
const moveAdd = at20(4.6 * MOVE_SPREAD) - at20(0);
ok(moveAdd > 5, `走ると腰だめが ${moveAdd.toFixed(0)}cm 広がる（0だと動く不利が消える）`);

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
