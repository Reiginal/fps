// 拾われない「約束の失敗」が無いかの検査。
//
// なぜ要るか: 2026-08-12に「右上にthis requestみたいなエラー文も出てた」と言われた。
//
// **ブラウザのAPIの一部は、断る時に例外ではなくpromiseを失敗させる。**
// そこを try/catch で囲んでも1つも受け止められない。
// 受け止め損ねた失敗は unhandledrejection として上がり、
// src/ui/diag.js が拾って**画面の隅へ英語のまま出す。**
// 遊ぶ側には「なんか赤い英語が出た」としか読めず、こちらへも何も返ってこない。
//
// 実際に漏れていたのは2つ:
//   navigator.keyboard.lock() … 掴み直すたびに前の申し込みが取り消される。
//                               押し直しただけで "...cancelled by a new lock request"
//   AudioContext.resume()     … 人が押していない所から呼ぶと断られる
//
// どちらも「断られても遊べる」種類なので、黙って捨ててよい。
// **捨てる書き方をしていないこと**だけをここで見張る。
//
//   node tools/check-promises.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* 断る時にpromiseを失敗させるAPI。**try/catchでは受け止められない物だけ**を並べる。
   ここに足す時は「例外ではなく約束で失敗するか」を確かめてから足すこと */
const PROMISED = [
  'requestPointerLock',
  'requestFullscreen',
  // **自前の包み(this.exitFullscreen)ではなく、DOMの方だけを見る。**
  // 包みの中では既に捨ててあるので、そちらまで見ると直しようが無い所で落ちる
  'document.exitFullscreen',
  'keyboard?.lock',
  'keyboard.lock',
  'clipboard.write',
  'ctx.resume',
];


/* その呼び出しが入っている**1文だけ**を切り出す。
   括弧の深さを数えて、深さ0の「;」で切る。
   単純に最初の「;」で切ると、.then(() => { a; b; }) の中の「;」で切れて、
   その後ろに繋がっている .catch を見落とす（実際に見落とした） */
function statementAt(src, from, api) {
  const at = src.indexOf(api, from);
  if (at < 0) return '';
  let depth = 0;
  for (let k = at; k < src.length; k++) {
    const c = src[k];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ';' && depth <= 0) return src.slice(at, k + 1);
  }
  return src.slice(at);
}

const files = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.js')) files.push(p);
  }
};
walk('src');

console.log('\n[1] 断られた時の失敗を捨てているか');
{
  let checked = 0;
  for (const f of files) {
    /* コメントの中の例は数えない。**改行の数は保つ**
       （潰すと行番号がずれて、直しに行った先に何も無い） */
    const src = readFileSync(f, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .replace(/^(\s*)\/\/.*$/mg, '$1');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const api of PROMISED) {
        if (!line.includes(`${api}?.(`) && !line.includes(`${api}(`)) continue;
        checked++;
        /* 受け止め方は2つだけ認める:
             ・その場で .catch を繋いでいる
             ・await で待っている（呼んだ側のtryが効く形）
           **見るのはその1文だけ。** 前は「続く数行」を見ていて、
           下の行に居る別のcatchを自分の物と数えて素通りしていた
           （わざと外して試したら通ってしまった）。
           変数へ入れてから後で catch する書き方もあるので、
           その時は同じ変数に .catch が付いているかを探す */
        const one = statementAt(src, lines.slice(0, i).join('\n').length, api);
        let held = /\bawait\b/.test(line) || /\.catch\b/.test(one);
        // const p = ... の形。その変数に catch が付いているか
        const named = /(?:const|let|var)\s+(\w+)\s*=/.exec(line);
        if (!held && named) held = new RegExp(`\\b${named[1]}\\??\\.catch`).test(src);
        ok(held, `${f}:${i + 1} … ${api} の失敗を捨てている`);
      }
    }
  }
  ok(checked >= 4, `promiseで断るAPIの呼び出しを ${checked}箇所 見た`);
}

console.log('\n[2] 拾えなかった失敗を画面へ出す口は残っている');
{
  /* **捨て方を足したからといって、受け皿を外さないこと。**
     ここが無いと、次に漏れた時に誰も気づけない
     （遊ぶ側の画面に何も出ず、/logsにも残らない） */
  const diag = readFileSync('src/ui/diag.js', 'utf8');
  ok(/addEventListener\('unhandledrejection'/.test(diag),
    '拾われなかった約束の失敗を受けている');
  ok(/addEventListener\('error'/.test(diag), '普通の例外も受けている');
  ok(/_report\(/.test(diag), '受けた物をサーバーへも送っている（/logsで後から読める）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
