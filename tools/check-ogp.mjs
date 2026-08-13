// URLを貼った時に出る札（OGP）の検査。
//
// なぜ要るか: **絵を差し替えても、送った先の札は変わらない。**
// LINE・Slack・Xは一度取った絵を**URL単位で覚え込む**ので、
// assets/ogp.png の中身だけ入れ替えてもURLが同じなら前の絵が出続ける。
// LINEには消してもらう手立てが無い（Xとfacebookにはある）。
//
// 2026-08-12に絵を差し替えて、翌日に
// 「LINEとかに送った時のサムネイルが、なんか新しいのに変わってなかった？」
// と言われたのがこれ。**差し替えた側は変えたつもりでいる**ので、
// 言われるまで誰も気づけない。
//
// なので og:image の末尾に絵の中身から作った目印を付けて、
// **中身が変わったらURLも変わる**形にしてある。
// ここはその目印がずれていないかを見るだけ。ずれていたら入れる値を出す。
//
//   node tools/check-ogp.mjs
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const png = readFileSync(new URL('../assets/ogp.png', import.meta.url));

/** 絵の中身から作る目印。中身が1バイトでも変われば別の値になる */
const stampOf = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 8);

console.log('\n[1] 絵の中身と、URLに付けた目印が揃っている');
{
  const want = stampOf(png);
  const url = /<meta property="og:image" content="([^"]+)">/.exec(html)?.[1] ?? '';
  ok(!!url, `og:imageがある（${url || 'なし'}）`);
  const got = /[?&]v=([0-9a-f]+)/.exec(url)?.[1] ?? '';
  ok(!!got, '目印(?v=)が付いている');
  ok(got === want,
    got === want
      ? `目印が絵と揃っている（?v=${want}）`
      : `**目印が古い。** index.htmlのog:imageを ?v=${want} に直すこと（今は ?v=${got || 'なし'}）`);
}

console.log('\n[2] 札そのものの形');
{
  // 絵の実寸と、書いてある寸法が合っているか。
  // 食い違うと、切り取られたり余白が付いた札になる
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const sw = Number(/<meta property="og:image:width" content="(\d+)">/.exec(html)?.[1] ?? 0);
  const sh = Number(/<meta property="og:image:height" content="(\d+)">/.exec(html)?.[1] ?? 0);
  ok(w === sw && h === sh, `書いてある寸法が実物と合っている（実物 ${w}×${h} / 表記 ${sw}×${sh}）`);
  // 1.91:1 から大きく外れると、どこも同じようには出してくれない
  const ratio = w / h;
  ok(ratio > 1.85 && ratio < 1.95, `縦横の比が 1.91:1 のあたり（${ratio.toFixed(2)}）`);

  /* **重すぎない。** LINEは大きい絵を取りに行かず、札が絵無しになる。
     1MBを超えたら赤にする（今の絵で0.9MB。ここは余裕が無い） */
  const mb = png.length / 1024 / 1024;
  ok(mb < 1.0, `1MBに収まっている（${mb.toFixed(2)}MB）`);

  ok(/<meta property="og:url" content="https:\/\//.test(html), 'og:urlが絶対のURL');
  // 相対で書くと、取りに来た側がどこを見ればいいか分からない
  ok(/content="https:\/\/[^"]*\/assets\/ogp\.png/.test(html), 'og:imageも絶対のURL');
  ok(/<meta name="twitter:card" content="summary_large_image">/.test(html),
    'Xでも大きい札で出る指定がある');
}

console.log('\n[3] 絵が外へ配られる所に居る');
{
  /* **配る決まりとDockerfileの両方に居ないと、本番でだけ絵が出ない。**
     手元では素通りするので、ここで見るしかない */
  const rules = readFileSync(new URL('../server/serve-rules.js', import.meta.url), 'utf8');
  ok(/'\/assets\/'/.test(rules), '配ってよい所に /assets/ が入っている');
  const docker = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  ok(/COPY assets/.test(docker), '本番の箱にも assets を入れている');

  // 目印(?v=)を付けたURLでも配れること。判定は?から後ろを捨てるはず
  const { publicPath } = await import('../server/serve-rules.js');
  ok(publicPath('/assets/ogp.png?v=deadbeef') === '/assets/ogp.png',
    '目印付きのURLでも絵が配られる');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
