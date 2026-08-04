// 呼び先が実在するかの検査。
//
// なぜ要るか: main.js が this.hud.elim(...) を2箇所から呼んでいたのに、
// HUD側にそのメソッドが1行も無かった。JavaScriptは呼ぶまで気づけないので、
// 構文チェックも既存のテストも全部素通りしていた。
// 実害はバナーが出ないことだけでは済まない。例外はその場で関数を打ち切るので、
// 撃破処理の後ろにあった得点加算とキルログまで巻き添えで飛んでいた。
//
// やることは単純で、ソースから「this.○○.△△(」の形を全部拾い、
// △△ がそのクラスに本当に在るかを見るだけ。クラスは実体を作らずに
// prototype だけ読むので、DOMもWebGLも要らない。
//
//   node tools/check-calls.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import '../server/dom-stub.js';

const { HUD } = await import('../src/ui/hud.js');
const { AudioEngine } = await import('../src/core/audio.js');
const { Effects } = await import('../src/world/effects.js');
const { WeaponSystem } = await import('../src/player/weapons.js');
const { Player } = await import('../src/player/player.js');
const { Input } = await import('../src/core/input.js');
const { NetClient } = await import('../src/net/client.js');
const { RemotePlayers } = await import('../src/net/remote.js');
const { Director } = await import('../src/ai/enemy.js');

// 受け側の名前(コード上の this.○○ )と、その中身のクラス。
// 名前が一致していても別物が入っている箇所があると誤検知するので、
// 素直に1対1で対応している物だけを並べる
const TARGETS = {
  hud: HUD,
  audio: AudioEngine,
  effects: Effects,
  weapons: WeaponSystem,
  player: Player,
  input: Input,
  net: NetClient,
  remotes: RemotePlayers,
  director: Director,
};

// クラス本体と親クラスのメソッド名を全部集める
const methodsOf = (cls) => {
  const names = new Set();
  for (let p = cls.prototype; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const k of Object.getOwnPropertyNames(p)) names.add(k);
  }
  return names;
};

const known = {};
for (const [prop, cls] of Object.entries(TARGETS)) known[prop] = methodsOf(cls);

// constructorで代入している物（メソッドではなく普通の値）は prototype に無い。
// 呼び出しの形をしていない物は拾わないので基本は当たらないが、
// 素通りさせたい物が出たらここへ足す
const ALLOW = new Set([
  'player.on', // 将来増える受け口用の空き。今は使っていない
]);

const files = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (name.endsWith('.js')) files.push(p);
  }
};
walk('src');

// this.hud.elim( / this.hud?.elim( / this.audio?.kill?.( を全部拾う。
// 最後の ?. まで許すのは、weapons.js が ctx.audio?.swing?.() と書いているため
const CALL = /\bthis\.(\w+)\??\.(\w+)\s*\??\s*\(/g;

let bad = 0;
let checked = 0;
const seen = new Set();

console.log('\n[1] this.○○.△△() の呼び先');
for (const file of files) {
  const src = readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((line, i) => {
    // 行ごとに回すのは、失敗した時に行番号を出したいから
    for (const m of line.matchAll(CALL)) {
      const [, prop, name] = m;
      const set = known[prop];
      if (!set) continue;              // 見張っていない受け側は無視
      const key = `${prop}.${name}`;
      if (ALLOW.has(key)) continue;
      checked++;
      if (set.has(name)) { seen.add(key); continue; }
      console.log(`  × 失敗: ${file}:${i + 1} … this.${prop}.${name}() は ${TARGETS[prop].name} に無い`);
      bad++;
    }
  });
}

console.log(`  ${checked}件の呼び出しを見て、${seen.size}種類の呼び先を確認した`);

/* -------------------------------------------- 画面の部品が実在するか */

// HUDは document.getElementById で部品を引く。index.html側の id を
// 書き換えると、引いた結果が null のまま持ち回されて、
// 使う瞬間まで気づけない（elimの件と同じ形の見落とし）
const html = readFileSync('index.html', 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

console.log('\n[2] HUDが引く画面の部品');
let missing = 0;
for (const file of ['src/ui/hud.js', 'src/ui/netmenu.js']) {
  const src = readFileSync(file, 'utf8');
  src.split('\n').forEach((line, i) => {
    for (const m of line.matchAll(/\$\('([\w-]+)'\)|getElementById\('([\w-]+)'\)/g)) {
      const id = m[1] || m[2];
      if (ids.has(id)) continue;
      console.log(`  × 失敗: ${file}:${i + 1} … id="${id}" が index.html に無い`);
      missing++;
    }
  });
}
console.log(`  ${missing === 0 ? `index.htmlの${ids.size}個のidと突き合わせて欠けは無し` : `${missing}件 欠けている`}`);

bad += missing;
console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
