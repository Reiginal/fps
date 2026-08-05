// キーボードと全画面まわりの検査。
//
// なぜ要るか: ここは**手元では一度も踏めない層**が多い。
// Keyboard Lockも全画面もdom-stubの上では動かないので、
// 「頼んだかどうか」「何を渡したか」を横から見るしかない。
//
// 実際に素通りした例:
//   ・キーボードを丸ごと借りていて、全画面にした後だけESCが効かなくなっていた
//     （借りた物にESCが含まれると、ブラウザが「2秒押し続けろ」の作法へ切り替わる。
//       短く押す人からは、ESCが壊れたようにしか見えない）
//   ・全画面が対戦で一度も適用されていなかった（通信の知らせから頼んでいたため）
//
//   node tools/check-input.mjs
import '../server/dom-stub.js';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

/* ブラウザの代わりに、頼まれた内容を記録するだけの偽物を置く。
   dom-stubにはこれらが無いので、ここで足す */
const log = { fullscreen: 0, exit: 0, lockedKeys: null, unlocked: 0 };
// navigatorはNodeのバージョンで扱いが割れる。**両方で通る形にしないとCIが片肺で落ちる。**
//   Node 20 … そもそも生えていない（触るとReferenceError）
//   Node 21以降 … 生えているが、差し替えられないgetterになっている（代入すると例外）
// 無ければ作る、有ればその上へkeyboardだけ足す、で両方を通す。
// 手元がNode 24しかなくて20で落ちた実績があるので、ここは消さない
if (typeof globalThis.navigator === 'undefined') {
  Object.defineProperty(globalThis, 'navigator', { value: {}, writable: true, configurable: true });
}
navigator.keyboard = {
  lock: (keys) => { log.lockedKeys = keys; return Promise.resolve(); },
  unlock: () => { log.unlocked++; },
};
// dom-stubは描画に要る所しか持っていないので、全画面まわりはここで生やす
document.fullscreenElement = null;
document.documentElement = {
  requestFullscreen: () => {
    log.fullscreen++;
    document.fullscreenElement = document.documentElement;
    return Promise.resolve();
  },
};
document.exitFullscreen = () => {
  log.exit++;
  document.fullscreenElement = null;
  return Promise.resolve();
};

const { Input } = await import('../src/core/input.js');

// addEventListenerを受け取るだけの受け口。掴む・離すを手で起こせるようにする
const listeners = new Map();
const origAdd = document.addEventListener?.bind(document);
document.addEventListener = (type, fn) => {
  listeners.set(type, fn);
  origAdd?.(type, fn);
};
const dom = {
  addEventListener: () => {},
  requestPointerLock: () => { document.pointerLockElement = dom; },
};
const input = new Input(dom);
// 全画面の約束は次のフレームで解決するので、待つ手を用意しておく
const settle = () => new Promise((r) => setTimeout(r, 0));

console.log('\n[1] 借りるキーにESCが入っていない');
// ここが今回の不具合そのもの。ESCを借りると、ESCで抜けられなくなる。
// lock()を引数なしで呼ぶ＝全部借りる＝ESCも借りる、なので
// 「引数が配列で渡っていること」も一緒に見る
await input.goFullscreen();
await settle();
ok(Array.isArray(log.lockedKeys), `借りるキーを名指ししている（${log.lockedKeys?.length}個）`);
ok(
  Array.isArray(log.lockedKeys) && !log.lockedKeys.includes('Escape'),
  'ESCを借りていない',
);
// 借りる意味があるのはブラウザ予約のショートカットだけ。
// ここが抜けると、しゃがみながらWでタブが閉じる形へ戻る
for (const k of ['KeyW', 'KeyT', 'KeyN', 'Digit1']) {
  ok(log.lockedKeys?.includes(k), `${k} は借りている（Ctrl+${k.slice(-1)}を止めるため）`);
}
// Tabとメタキーは借りない。借りるとAlt+TabもCmd+Tabもできなくなって、
// ゲームから出られない状態になる
for (const k of ['Tab', 'MetaLeft', 'MetaRight']) {
  ok(!log.lockedKeys?.includes(k), `${k} は借りていない（他のアプリへ移れなくなるため）`);
}

console.log('\n[2] 全画面を切っていれば頼まない');
{
  const before = log.fullscreen;
  document.fullscreenElement = null;
  input.wantFullscreen = false;
  await input.goFullscreen();
  await settle();
  ok(log.fullscreen === before, '切ってある間は全画面を頼まない');
  input.wantFullscreen = true;
}

console.log('\n[3] 掴みを離したら全画面も畳む');
// 遊ぶのをやめる＝別のタブを見たい時なので、画面いっぱいのまま残さない。
// ここが無いと、ESCで一時停止に入っても画面が全部ゲームのままになる
{
  await input.goFullscreen();
  await settle();
  ok(!!document.fullscreenElement, '全画面に入っている');
  const before = log.exit;
  document.pointerLockElement = null;
  listeners.get('pointerlockchange')?.();
  ok(log.exit === before + 1, '掴みを離した時に全画面を畳んだ');
  ok(!document.fullscreenElement, '窓に戻っている');
  ok(log.unlocked > 0, '借りたキーボードも返している');
}

console.log('\n[4] 全画面でない時にexitFullscreenを呼んでも落ちない');
// document.exitFullscreenは全画面でない時に呼ぶと例外を投げる。
// 掴みを離すたびに通る道なので、ここで落ちると遊べなくなる
{
  document.fullscreenElement = null;
  const before = log.exit;
  let threw = false;
  try { input.exitFullscreen(); } catch { threw = true; }
  ok(!threw, '例外を投げない');
  ok(log.exit === before, '窓のままなら何もしない');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
