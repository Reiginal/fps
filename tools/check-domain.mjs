// 本番のアドレスが、書いてある所すべてで揃っているかの検査。
//
// なぜ要るか: 2026-08-11に blackout-fps.fly.dev から blackoutfps.com へ移した時、
// 同じアドレスが index.html(OGP) と README.md と CLAUDE.md の**4箇所**に手書きされていた。
// 1箇所だけ直しても誰も困らないので、**ずれたまま何ヶ月も気づけない。**
// ずれると実際に困るのは次の2つ。
//
//   - og:url が古いと、URLを貼った時に出る札のリンク先だけ前のアドレスになる
//   - og:image が og:url と違うホストを指すと、札の絵が出ない場合がある
//     （貼った先が、本文と同じ所から取れる絵しか信用しないことがある）
//
// **どのアドレスが正しいかはここに書かない。** index.html の og:url を正とみなして、
// 他がそれに付いてきているかだけを見る。書くと5箇所目になる。
//
// メールの差出人(MAIL_FROM)とリンクの行き先(APP_ORIGIN)も揃っている必要があるが、
// あれはFlyの秘密の中にあり、手元からは読めないのでここでは見られない。
// 揃える理由は server/mail.js のコメントに書いてある。
//
//   node tools/check-domain.mjs
import { readFileSync, existsSync } from 'node:fs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const html = read('index.html');

const meta = (prop) => html.match(new RegExp(`<meta property="${prop}" content="([^"]*)"`))?.[1] ?? '';
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

console.log('\n[1] 札(OGP)のアドレスが読み取れる');
const ogUrl = meta('og:url');
const ogImage = meta('og:image');
ok(ogUrl !== '', `og:url がある … ${ogUrl || '見つからない'}`);
ok(ogImage !== '', `og:image がある … ${ogImage || '見つからない'}`);

const host = hostOf(ogUrl);
ok(host !== '', `og:url がURLの形をしている … ${host || 'ホストが取れない'}`);
// httpのままだと、貼った先が札を取りに行けないことがある
ok(ogUrl.startsWith('https://'), 'og:url が https');
// 「/」で終わっていないと、貼る人が末尾を足した時に別のアドレス扱いになる
ok(ogUrl.endsWith('/'), 'og:url が / で終わる（貼られ方でぶれないように）');

console.log('\n[2] 札の絵が、本文と同じホストから取れる');
ok(hostOf(ogImage) === host,
  `og:image のホストが og:url と同じ … ${hostOf(ogImage) || '取れない'}${hostOf(ogImage) === host ? '' : ` ← og:url は ${host}`}`);

console.log('\n[3] 札の絵が実在して、外へ配られる');
// 絵の場所を変えたのに og:image を直し忘れると、札だけ絵が欠ける
const imgPath = (() => { try { return new URL(ogImage).pathname; } catch { return ''; } })();
ok(imgPath !== '', `og:image のパスが取れる … ${imgPath || '取れない'}`);
ok(imgPath !== '' && existsSync(new URL(`..${imgPath}`, import.meta.url)),
  `${imgPath} がファイルとして在る`);
// 在っても配られていなければ、本番でだけ絵が出ない
const { publicPath } = await import('../server/serve-rules.js');
ok(imgPath !== '' && publicPath(imgPath) !== null, `${imgPath} を外へ配る決まりがある`);

console.log('\n[4] 人が読む文書も同じアドレスを指している');
// 遊ぶ人に送るアドレスがここにある。古いと、移した意味が無い
const readme = read('README.md');
const readmeUrl = readme.match(/^\*\*(https:\/\/[^*]+)\*\*$/m)?.[1] ?? '';
ok(readmeUrl !== '', `README.md にアドレスがある … ${readmeUrl || '見つからない'}`);
ok(hostOf(readmeUrl) === host,
  `README.md のホストが og:url と同じ${hostOf(readmeUrl) === host ? '' : ` ← ${hostOf(readmeUrl) || '取れない'} と ${host}`}`);

// CLAUDE.mdの「本番」の節。ここが古いと、次に触る時に古いアドレスを見て作業する。
// **fly.devのアドレスも併記してある**（消えていないので）ため、
// 節の中に「正しいホストが1回でも出てくるか」で見る
const claude = read('CLAUDE.md');
const honban = claude.split('\n## 本番')[1]?.split('\n## ')[0] ?? '';
ok(honban !== '', 'CLAUDE.md に「本番」の節がある');
ok(honban.includes(host), `CLAUDE.md の「本番」に ${host} が書いてある`);

console.log('\n[5] 古いアドレスが、直し忘れとして残っていない');
/* fly.devのアドレスは消えていないので、CLAUDE.mdに併記されているのは正しい。
   **見張りたいのは「遊ぶ人が見る所」に古いのが残ること。**
   だから見るのは index.html と README.md だけにしてある（CLAUDE.mdは除く）。
   ここを全ファイルに広げると、経緯を書いたコメントを消させる検査になる */
for (const f of ['index.html', 'README.md']) {
  const body = read(f);
  const olds = [...body.matchAll(/https:\/\/([A-Za-z0-9.-]+)/g)]
    .map((m) => m[1])
    .filter((h) => h !== host && (h.endsWith('.fly.dev') || h.endsWith('blackoutfps.com')));
  ok(olds.length === 0,
    `${f} に古い本番アドレスが残っていない${olds.length ? ` ← ${[...new Set(olds)].join('、')}` : ''}`);
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
