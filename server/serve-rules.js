// 外へ配ってよいURLかを決める。
//
// なぜ独立したファイルにしてあるか: server/index.js は読み込むと
// その場でサーバーが起動するので、判定だけを試すことができない。
// 「絞ったつもり」で終わらせないために、判定を独立させて検査から呼べるようにした。
// tools/check-serve.mjs がここを叩いている。
//
// 以前はリポジトリの中身を丸ごと配っていた。手元で遊ぶ分には害が無いが、
// インターネットへ出すと server/sim.js（当たり判定の実装）も package.json も
// 誰でも取れる。当たり判定の中身が読めると、当たったことにする細工を作るのが楽になる。
import { normalize } from 'node:path';

// 配ってよい単体のファイル。
// privacy.html は個人情報の扱い。メールアドレスを預かる以上、掲示が要る。
// ゲーム本体とは別の1枚にしてあるので、ここに名前を足さないと404になる
const FILES = new Set(['/index.html', '/privacy.html']);

// 配ってよいディレクトリ。この下は全部通す
const DIRS = [
  '/src/',
  // URLを貼った時の札に使う画像。LINEやSlackの取りに来る先が
  // ここになるので、遊ぶ人向けの物と同じく外へ出す
  '/assets/',
  // importmapがこの2つを直接参照している。ビルド手順を持たないので、
  // three本体はnode_modulesから配るしかない。
  // node_modules全体ではなくthreeの中の必要な2つに限る（wsのソース等は配らない）
  '/node_modules/three/build/',
  '/node_modules/three/examples/jsm/',
];

/**
 * リクエストのURLから、配ってよい相対パスを返す。配れないものはnull。
 * @param rawUrl req.url そのもの（クエリ付き・パーセント符号化のままでよい）
 */
export function publicPath(rawUrl) {
  let url;
  try {
    url = decodeURIComponent(String(rawUrl).split('?')[0]);
  } catch {
    // 壊れたパーセント符号化。読めない物は配らない
    return null;
  }
  // 二重に符号化して .. を紛れ込ませる手を塞ぐ。
  // %252e%252e は1回目のdecodeで %2e%2e に戻るだけなので、もう一度戻して確かめる
  if (/%2e|%2f|%5c/i.test(url)) return null;
  const rel = normalize(url === '/' ? '/index.html' : url).replace(/^(\.\.[/\\])+/, '');
  // normalizeを通しても先頭が / でない形は想定外なので配らない
  if (!rel.startsWith('/')) return null;
  if (rel.includes('..')) return null;
  // Windows形式の区切りが混ざった物も弾く
  if (rel.includes('\\')) return null;
  if (FILES.has(rel)) return rel;
  if (DIRS.some((d) => rel.startsWith(d))) return rel;
  return null;
}
