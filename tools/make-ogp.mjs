// URLを貼った時に出る札の画像を作る。
//
//   npm run ogp        → assets/ogp.png を書き出す
//
// なぜ画像を「描く」のではなく「作る」のか:
// このリポジトリは今のところ画像ファイルを1枚も持っていない。テクスチャも空も
// コードから作っている。それは決まりではなく、ただ今そうなっているだけだが、
// 1枚のためにお絵描きの道具を持ち込むより、同じやり方で作った方が筋が通る。
// 作り直しがコマンド1つで済むという実利もある（題を変えたら打ち直すだけ）。
//
// PNGを外部の部品なしで書けるのは、中身が単純だから:
//   署名8バイト → IHDR(大きさ) → IDAT(zlibで圧縮した画素) → IEND
// 各かたまりに CRC32 を付ける。圧縮はNodeのzlibがやってくれる。
//
// 文字は5×7のドットで持っている。日本語は形が複雑でこの持ち方では出せないので、
// 題(BLACKOUT)だけをドットで置き、日本語は札の文章側(index.htmlのog:description)に任せる。
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = `${ROOT}assets/ogp.png`;

// 1200×630はLINEやSlackが大きい札を出す時に想定している比率(1.91:1)。
// ここを外すと、向こうで上下や左右が切り落とされる
const W = 1200;
const H = 630;

/* ------------------------------------------------------------ 画布 */

// RGBを1画素3バイトで持つ。透過は要らない（札の下地は必ず塗り潰す）
const px = new Uint8Array(W * H * 3);

const setPx = (x, y, r, g, b) => {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
};

// 上に重ねる。aは0〜1の濃さ。下地を活かしたい物（光や影）はこちらを使う
const blendPx = (x, y, r, g, b, a) => {
  if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) return;
  const i = (y * W + x) * 3;
  const k = a > 1 ? 1 : a;
  px[i] = px[i] * (1 - k) + r * k;
  px[i + 1] = px[i + 1] * (1 - k) + g * k;
  px[i + 2] = px[i + 2] * (1 - k) + b * k;
};

const rect = (x, y, w, h, r, g, b, a = 1) => {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) blendPx(x + i, y + j, r, g, b, a);
  }
};

/* ------------------------------------------------------------ 下地 */

// ゲームの画面と同じ配色にする。札を見た人が実物を開いた時、
// 別の物に来たと思わせない。index.htmlの :root と同じ値
const HUD = [232, 240, 244];
const ACCENT = [99, 210, 255];
const WARN = [255, 70, 50];

// 中央が少し明るい暗がり。真っ黒一色だと、送られた側には
// 画像が読み込めなかったのか黒い画像なのかが区別できない
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W / 2);
    const dy = (y - H / 2) / (H / 2);
    const d = Math.min(1, Math.hypot(dx * 0.85, dy));
    const k = 1 - d * d;
    setPx(x, y, 5 + 12 * k, 8 + 16 * k, 13 + 24 * k);
  }
}

/* -------------------------------------------------- 街の輪郭（下部） */

// 市街地掃討戦という副題に対して、下地が無地だと何のゲームか手掛かりが無い。
// 建物の影を並べて「街」であることだけ出す。
//
// 乱数は使わず、決まった数列から作る。Math.random()で作ると打つたびに
// 違う画像になり、「同じコマンドで同じ物が出る」が崩れて差分も毎回出る
let seed = 20260804;
const rnd = () => {
  // 線形合同法。並びに癖は出るが、輪郭を散らすには十分
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const SKY_BASE = H - 40;
let bx = -20;
while (bx < W + 40) {
  const bw = 26 + Math.floor(rnd() * 58);
  const bh = 40 + Math.floor(rnd() * 150);
  // 奥ほど暗く小さく。手前と奥で濃さを変えないと、ただの櫛の歯になる
  const far = rnd();
  const shade = 14 + far * 16;
  rect(bx, SKY_BASE - bh, bw, bh + 40, shade, shade + 4, shade + 8, 0.92);
  // 窓明かり。数を絞る。多いと賑やかな街になってしまい、掃討戦に見えない
  for (let wy = SKY_BASE - bh + 10; wy < SKY_BASE - 8; wy += 14) {
    for (let wx = bx + 7; wx < bx + bw - 7; wx += 12) {
      if (rnd() > 0.86) rect(wx, wy, 3, 5, 255, 190, 120, 0.30 + far * 0.25);
    }
  }
  bx += bw + 4 + Math.floor(rnd() * 10);
}

/* ------------------------------------------------------------ 文字 */

// 5×7のドット。題に要るのは B L A C K O U T の8文字だけ
const GLYPHS = {
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
};

/** 文字列の横幅（描く前に中央へ寄せるために要る） */
const textWidth = (s, dot, gap) => s.length * 5 * dot + (s.length - 1) * gap;

const drawText = (s, x, y, dot, gap, col, a = 1) => {
  let cx = x;
  for (const ch of s) {
    const g = GLYPHS[ch];
    if (!g) { cx += 5 * dot + gap; continue; }
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if (g[r][c] === '1') rect(cx + c * dot, y + r * dot, dot, dot, col[0], col[1], col[2], a);
      }
    }
    cx += 5 * dot + gap;
  }
};

const TITLE = 'BLACKOUT';
const DOT = 13;
const GAP = 26;
const tw = textWidth(TITLE, DOT, GAP);
const tx = Math.round((W - tw) / 2);
const ty = 210;

// 文字の後ろに落とす影。下地の建物と文字が同じ濃さの所で重なると読めなくなる
drawText(TITLE, tx + 4, ty + 5, DOT, GAP, [0, 0, 0], 0.55);
drawText(TITLE, tx, ty, DOT, GAP, HUD, 1);

// 題の下の線。水色はゲーム側で「今こっち」を示すのに使っている色なので、
// 札でも同じ色を1本だけ引いて、開いた先と同じ物だと分かるようにする
rect(tx, ty + 7 * DOT + 34, tw, 3, ACCENT[0], ACCENT[1], ACCENT[2], 0.9);

/* -------------------------------------------------------- クロスヘア */

// ゲーム中ずっと画面の真ん中にある印。これが載っているだけで
// 「撃つゲーム」だと文字を読む前に伝わる。
// 開き具合はゲーム側と同じで、閉じた状態（止まって狙っている時の形）にする
const cxp = W / 2;
const cyp = ty + 7 * DOT + 128;
const barL = 26, barT = 4, spread = 15;
rect(cxp - barT / 2, cyp - spread - barL, barT, barL, HUD[0], HUD[1], HUD[2], 0.92);
rect(cxp - barT / 2, cyp + spread, barT, barL, HUD[0], HUD[1], HUD[2], 0.92);
rect(cxp - spread - barL, cyp - barT / 2, barL, barT, HUD[0], HUD[1], HUD[2], 0.92);
rect(cxp + spread, cyp - barT / 2, barL, barT, HUD[0], HUD[1], HUD[2], 0.92);
// 中心の点は赤。ゲーム側で当たった時に赤くなるのと同じ意味合いで、
// 白一色の十字より的に見える
rect(cxp - 3, cyp - 3, 6, 6, WARN[0], WARN[1], WARN[2], 0.95);

/* ------------------------------------------------------------ 縁 */

// 四隅を落とす。札は白い背景のアプリの上に置かれるので、
// 縁が明るいままだと画像の切れ目が分からず、下地に溶ける
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const dx = (x - W / 2) / (W / 2);
    const dy = (y - H / 2) / (H / 2);
    const d = Math.hypot(dx, dy);
    const v = Math.max(0, d - 0.72) * 1.5;
    if (v > 0) blendPx(x, y, 0, 0, 0, Math.min(0.85, v));
  }
}

/* -------------------------------------------------------- PNGとして書く */

// CRC32。PNGは各かたまりの末尾にこれを付ける決まりで、
// 合っていないと受け取った側が壊れた画像として捨てる
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;    // 1色8ビット
ihdr[9] = 2;    // 色の持ち方: RGB（透過なし）
ihdr[10] = 0;   // 圧縮方式は1つしかない
ihdr[11] = 0;   // ふるい分けの方式も1つ
ihdr[12] = 0;   // 飛び飛びに読む形にはしない

// 各行の頭に「ふるい分けの種類」を1バイト置く決まり。
// 0＝そのまま。凝った種類にすると縮むが、この画像は圧縮後で数十KBに収まるので
// 読みやすさを取る
const raw = Buffer.alloc(H * (1 + W * 3));
for (let y = 0; y < H; y++) {
  const o = y * (1 + W * 3);
  raw[o] = 0;
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, o + 1);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`assets/ogp.png を書いた  ${W}×${H}  ${(png.length / 1024).toFixed(1)}KB`);
