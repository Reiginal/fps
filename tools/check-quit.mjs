// 終了の検査。
//
// なぜ要るか: **ブラウザのゲームには「閉じる」が無い。**
// タブを開いたままにしておくと、見ていない間もずっと3Dを描き続ける。
// このゲームは元々「描画が増えるとパソコンが熱くなる」を抱えているので、
// やめた後まで回し続けるのは実害が大きい。
//
// 落ち方が2つある。どちらも例外にならないので気づけない。
//
//   1. **描画を止め忘れる。** 画面には「またね」が出ているのに裏で回り続ける。
//      見た目は正しいので、パソコンが熱いことでしか分からない
//   2. **window.close() だけで済ませる。** あれは**自分で開いたタブしか
//      閉じられない**決まりなので、URLを踏んで来た人の画面では何も起きない。
//      押しても無反応の「終了」が残る
//
//   node tools/check-quit.mjs
import { readFileSync } from 'node:fs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* コメントを外す。**コメントの中にも window.close() と書いてある**ので、
   そのまま探すと説明文のほうを拾って、順番の判定が逆に出る（実際そうなった） */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const netmenu = readFileSync(new URL('../src/ui/netmenu.js', import.meta.url), 'utf8');

console.log('\n[1] ホーム画面に終了の口がある');
{
  ok(html.includes('id="nmQuit"'), 'ホーム画面に終了のボタンがある');
  ok(/id="nmQuit"[^>]*>\s*終了/.test(html), 'ボタンの文字が「終了」');
  ok(netmenu.includes("$('nmQuit')"), '画面の側が引いている');
  ok(/this\.el\.quit\.onclick/.test(netmenu), '押した時の処理が繋がっている');
  ok(/menu\.onQuit\s*=/.test(main), '統合側が受け取っている');
}

console.log('\n[2] 終了した後の画面');
{
  ok(html.includes('id="quit"'), '終了の画面が置いてある');
  // 開いたまま起動すると、遊ぶ前に「またね」が出る
  ok(/id="quit"[^>]*class="[^"]*hidden/.test(html), '閉じた状態で置いてある');
  ok(html.includes('id="qtBack"'), '戻る口がある（押し間違いで作業が終わらないように）');
  ok(html.includes('id="qtNote"'), '何が起きたのかを出す場所がある');
}

console.log('\n[3] 描画を止めている');
// **ここが本体。** 画面を出すだけで止め忘れると、
// 「またね」を出したまま裏で3Dを回し続けることになる
{
  const body = main.split('_quitGame() {')[1]?.split('\n  }')[0] || '';
  ok(body.length > 0, '終了の処理が見つかった');
  ok(/setAnimationLoop\(null\)/.test(body), '描画のループを止めている');
  ok(/exitFullscreen/.test(body), '全画面も畳んでいる');
  ok(/exitPointerLock/.test(body), 'マウスも手放している');
  // 書き出さないと、最後の1戦の戦績が丸ごと消える
  ok(/_flushStats\(\)/.test(body), 'やめる前に戦績を書き出している');
  // 対戦の途中でやめた時に、回線を切らないと相手の画面に立ち尽くす人が残る
  ok(/_quitMatch\(\)/.test(body), '対戦中なら回線も切っている');
}

console.log('\n[4] window.close() だけに頼っていない');
// **自分で開いたタブしか閉じられない。** URLを踏んで来た人の画面では何も起きないので、
// これだけだと「押しても無反応の終了ボタン」になる
{
  const body = stripComments(main.split('_quitGame() {')[1]?.split('\n  }')[0] || '');
  const closeAt = body.indexOf('window.close()');
  const stopAt = body.indexOf('setAnimationLoop(null)');
  ok(closeAt >= 0, 'タブを閉じることは頼んでいる');
  ok(stopAt >= 0 && stopAt < closeAt,
    '閉じるより先に描画を止めている（閉じられなかった時に何も起きないことがない）');
  ok(/try \{ window\.close\(\)/.test(body), '閉じられなくても例外を外へ出さない');
}

console.log('\n[5] 戻れる');
// 押し間違いで作業が終わってしまうと、遊び直すのに読み込みからやり直しになる
{
  const body = main.split('_resumeFromQuit() {')[1]?.split('\n  }')[0] || '';
  ok(body.length > 0, '戻る処理がある');
  ok(/setAnimationLoop\(\(\) => this\._loop\(\)\)/.test(body), '描画を動かし直している');
  ok(/menu\.show\(\)/.test(body), 'ホーム画面へ戻している');
  ok(/_lastTime = performance\.now\(\)/.test(body),
    '時計を入れ直している（止めていた間の秒数がそのまま1フレームに入らないように）');
  // **描画を止めた後なので、ループの中から繋いでいると押せない**
  ok(/qtBack[\s\S]{0,200}?_resumeFromQuit/.test(main),
    '戻るボタンをゲームループの外から繋いでいる');
}

console.log('\n[並び] ホームのボタンが1行に収まっているか');
/* **ボタンの中で単語が割れるのは、幅が足りないという意味。**
   実際に「チュートリア／ル」で割れていた（ストアを足して1行4個にした時。2026-08-11）。
   ブラウザ無しでも、幅は掛け算で出せる:

     1個あたりの幅 = (枠 - 隙間×(個数-1)) ÷ 個数
     文字が要る幅   = 文字数 × (字の大きさ + 字間)

   等幅の全角なので、1文字は「字の大きさ」ぶんの幅を取る。
   字間(letter-spacing)は文字ごとに足されるので掛ける。
   数字はCSSから読む（片方だけ変えた時に、この見張りが古くならないように） */
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const num = (re, why) => {
    const m = html.match(re);
    if (!m) { ok(false, `CSSから${why}を読めない`); return 0; }
    return Number(m[1]);
  };
  const panel = num(/\.netpanel \{ width: min\((\d+)px/, '枠の幅');
  const btn = html.match(/\.netbtn \{[\s\S]*?\}/)?.[0] || '';
  const size = Number(btn.match(/font-size:\s*(\d+)px/)?.[1] || 0);
  /* **`.2em` を 0.2 と読むこと。** 最初 `\.?(\d+)em` と書いていて、
     `.2em` から「2」だけ拾って0.02にしていた。字間が10分の1になるので、
     **1行4個の頃の「チュートリアル」を93pxと見積もって見逃していた**
     （本当は109px要って、1個あたり97pxに入らない）。
     見張るための検査が、見張りたい物を通していた */
  const spacing = parseFloat(btn.match(/letter-spacing:\s*([\d.]+)em/)?.[1] || '0');
  const gap = num(/\.netbtns \{ display: flex; gap: (\d+)px/, '隙間');
  ok(panel > 0 && size > 0 && gap > 0, `CSSから寸法を読めた（枠${panel}px 字${size}px 隙間${gap}px）`);
  ok(/white-space:\s*nowrap/.test(btn),
    '**文字の途中で折り返さない**（足りない時ははみ出して一目で分かる）');

  // ホームの中のボタンの行だけを見る（ロビーや会員証の行は幅の条件が違う）
  const home = html.slice(html.indexOf('<div id="netmenu"'), html.indexOf('<div id="account"'));
  const rows = [...home.matchAll(/<div class="netbtns[^"]*">([\s\S]*?)<\/div>/g)];
  ok(rows.length >= 2, `ホームにボタンの行が${rows.length}本ある`);
  for (const [, inner] of rows) {
    const labels = [...inner.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1]);
    if (!labels.length) continue;
    const each = (panel - gap * (labels.length - 1)) / labels.length;
    const longest = labels.reduce((a, b) => (a.length >= b.length ? a : b));
    const need = longest.length * (size * (1 + spacing));
    ok(need <= each,
      `${labels.length}個の行（${labels.join('・')}）… 一番長い「${longest}」に`
      + `${need.toFixed(0)}px要って、1個あたり${each.toFixed(0)}px`);
  }
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
