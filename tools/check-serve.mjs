// 外へ配る物の検査。
//
// なぜ要るか: インターネットへ出すと、配信の範囲を間違えた時の代償が変わる。
// 手元で遊ぶ分には server/sim.js が読めても害は無いが、公開すると
// 当たり判定の実装が誰でも取れて、当たったことにする細工を作るのが楽になる。
// package.json や tools/ の中身も同じ。
//
// 「絞ったつもり」で終わらせないために、判定だけを server/serve-rules.js へ
// 切り出してここから直接叩く（server/index.js は読み込むと起動してしまう）。
//
//   node tools/check-serve.mjs
import { publicPath } from '../server/serve-rules.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const serves = (url, why) => {
  const got = publicPath(url);
  ok(got !== null, `${url} … 配る${why ? `（${why}）` : ''}${got ? '' : ' ← 配れていない'}`);
};
const blocks = (url, why) => {
  const got = publicPath(url);
  ok(got === null, `${url} … 配らない${why ? `（${why}）` : ''}${got ? ` ← ${got} が漏れる` : ''}`);
};

console.log('\n[1] ブラウザが実際に読む物は配る');
serves('/', 'index.htmlを返す');
serves('/index.html');
serves('/src/main.js');
serves('/src/core/audio.js');
serves('/src/net/protocol.js');
serves('/node_modules/three/build/three.module.js');
serves('/node_modules/three/examples/jsm/math/Octree.js');
serves('/src/main.js?v=2', 'クエリ付きでも読める');

console.log('\n[2] サーバー側の実装は配らない');
blocks('/server/sim.js', '当たり判定の実装');
blocks('/server/index.js');
blocks('/server/room.js');
blocks('/server/serve-rules.js');

console.log('\n[3] 遊ぶのに要らない物は配らない');
blocks('/package.json', '依存の版が全部見える');
blocks('/package-lock.json');
blocks('/tools/check-sound.mjs');
blocks('/課題.md');
blocks('/README.md');
blocks('/eslint.config.js');
blocks('/.github/workflows/ci.yml');
blocks('/Dockerfile');
blocks('/fly.toml');
blocks('/node_modules/ws/index.js', 'three以外のnode_modules');
blocks('/node_modules/three/package.json', 'threeでも要らない所');

console.log('\n[4] 部屋の一覧を返す口は閉じた');
// 誰でも叩けて、全部屋の合言葉と人数が取れていた。
// 合言葉は部屋を分ける唯一の鍵なので、漏れると誰でも入れる
blocks('/rooms', '合言葉が漏れていた');

console.log('\n[5] 抜け道');
blocks('/../package.json', '上へ抜ける');
blocks('/src/../server/sim.js', '途中で戻る');
blocks('/src/../../etc/passwd');
blocks('/%2e%2e/package.json', 'パーセント符号化した ..');
blocks('/%2E%2E%2Fpackage.json', '大文字の符号化');
blocks('/src%2f..%2fserver/sim.js', '符号化した区切り');
blocks('/..%5cserver/sim.js', 'Windows形式の区切り');
blocks('/%ZZ', '壊れた符号化');
blocks('/srcx/main.js', '前方一致だけで通してしまう名前');
blocks('/node_modules/three/buildx/x.js');

console.log('\n[6] 死活監視の口はサーバー側で先に処理する');
// /healthz は publicPath へ来る前に server/index.js が返すので、
// ここで配らない判定になるのが正しい
blocks('/healthz', 'serveStaticより手前で返している');

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
