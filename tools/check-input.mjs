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
// orderは「掴む」と「全画面」を頼んだ順番。**この順番そのものが検査の対象**なので、
// 回数ではなく並びで持つ。lockRejectsを立てると、掴む方を断るブラウザになる
const log = {
  fullscreen: 0, exit: 0, lockedKeys: null, unlocked: 0,
  order: [], lockRejects: false,
};
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
    log.order.push('全画面');
    document.fullscreenElement = document.documentElement;
    return Promise.resolve();
  },
};
document.exitFullscreen = () => {
  log.exit++;
  document.fullscreenElement = null;
  return Promise.resolve();
};

/* キーボードの受け口も拾う。**windowに付くので、Inputを読み込む前に差し替える。**
   こうしないとキーを押した時に何が起きるかを一度も確かめられない
   （実際、Commandを離すと走りが止まる不具合をここで踏めなかった） */
const winKeys = new Map();
const origWinAdd = globalThis.addEventListener;
globalThis.addEventListener = (type, fn) => {
  winKeys.set(type, fn);
  origWinAdd?.(type, fn);
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
  // 本物のChromeと同じく約束(Promise)を返す。断る側も再現できるようにしてある
  requestPointerLock: () => {
    log.order.push('掴む');
    if (log.lockRejects) {
      return Promise.reject(new Error('A user gesture is required to request Pointer Lock.'));
    }
    document.pointerLockElement = dom;
    return Promise.resolve();
  },
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

console.log('\n[5] 掴むのを全画面より先に頼む');
/* **順番を逆にすると必ず断られる。**
   ブラウザは「人がたった今押した」という印を1回ぶんしか持っていなくて、
   全画面はそれを使い切る（掴む方は使い切らない）。
   先に全画面を頼むと、掴む方には印が残っていなくて
   "A user gesture is required to request Pointer Lock." で断られる。
   2026-08-08まで実際にこの順で、遊ぶ側の画面に読めない英語が出ていた */
{
  document.fullscreenElement = null;
  document.pointerLockElement = null;
  log.order.length = 0;
  input.requestLock();
  await settle();
  ok(log.order[0] === '掴む', `掴む方を先に頼んでいる（順番: ${log.order.join('→')}）`);
  ok(log.order.includes('全画面'), '全画面も頼んでいる');
}

console.log('\n[6] 掴むのを断られても、拾い手のいない失敗にしない');
/* 断られること自体は普通に起きる（掴みを外した直後は、少しの間ブラウザが掴み直させない）。
   受けずに放っておくとunhandledrejectionになり、diagの赤い枠へ
   ブラウザの英語がそのまま出る。**しかもdiagはエラーを消さないので、
   一度出たら遊び終わりまで残る**（死亡画面まで残っているのを実際に見た） */
{
  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  let told = 0;
  input.onLockFail(() => { told++; });
  log.lockRejects = true;
  document.fullscreenElement = null;
  document.pointerLockElement = null;
  input.requestLock();
  // 約束の失敗が拾われないと分かるのは、その回の処理が全部終わった後。
  // 1回の待ちでは早すぎて、受けていなくても素通りしてしまう
  await settle();
  await settle();
  ok(told === 1, '断られたことを受け取っている');
  ok(!unhandled, `拾い手のいない失敗になっていない（${unhandled?.message ?? 'なし'}）`);
  process.off('unhandledRejection', onUnhandled);
  log.lockRejects = false;
}

console.log('\n[7] Commandを離しても、押しっぱなしのキーが落ちない');
/* **Macでだけ起きる形。** macOSはCommandを押している間、他のキーのkeyupを送らない。
   だからCommandを離した時にこちらで落とすのだが、**落とす相手を2回間違えている。**

     1回目 … 押している物を丸ごと落とした。Shiftまで消えるので、
              走りながら⌘でしゃがむと離した瞬間に棒立ちになった（実測で速度0）
     2回目 … 修飾キー以外を全部落とした。今度はWが消えるので、
              Shift+Wを押しっぱなしでも前へ進まなくなった。**同じ「止まる」が再発。**
              「キーリピートが入れ直す」と考えていたが、macOSは別のキーを挟むと
              元のキーのリピートを再開しないので、Wは戻ってこない

   正しい線引きは「いつ押されたか」。⌘より前から握っているキーは落とさない。
   ⌘の後に押したキーだけを落とし、そちらは最後に押したキー＝リピートが来る側なので、
   本当に握り続けていれば戻ってくる */
{
  // 「文字を打っている最中か」を見るのに使われる。dom-stubには無いので生やす
  globalThis.HTMLElement = globalThis.HTMLElement ?? class {};
  const down = (code, repeat = false) => winKeys.get('keydown')?.({
    code, repeat, target: null, preventDefault: () => {},
  });
  const up = (code) => winKeys.get('keyup')?.({ code, preventDefault: () => {} });
  ok(!!winKeys.get('keydown') && !!winKeys.get('keyup'), 'キーの受け口を掴めた');

  /* ここが本番。**Shift+Wを押しっぱなしのまま⌘でスライディング**、が壊れないこと。
     ⌘より前から握っているキーは、遊ぶ側がそのまま握り続けているキー */
  input.keys.clear();
  down('KeyW'); down('ShiftLeft'); down('MetaLeft');
  ok(input.down('KeyW') && input.down('ShiftLeft') && input.down('MetaLeft'),
    '3つとも押している');
  up('MetaLeft');
  ok(!input.down('MetaLeft'), 'しゃがみは離れた');
  ok(input.down('ShiftLeft'), '**走り(Shift)は残る**（落ちると棒立ちになる）');
  ok(input.down('KeyW'), '**前進(W)も残る**（落ちると前へ進まなくなる）');

  /* 落とすのは「⌘を押している間に押し下げたキー」だけ。
     そちらは離した時のkeyupがmacOSから来ないので、こちらで片付けるしかない */
  input.keys.clear();
  down('MetaLeft');
  down('KeyD');            // ⌘を押してから右へ動き始めた
  ok(input.down('KeyD'), '⌘の後に押したキーは効いている');
  up('MetaLeft');
  ok(!input.down('KeyD'), '⌘の後に押したキーは、⌘を離した時に片付ける');

  /* ⌘の後に押したキーを本当に握り続けているなら、キーリピートが戻す。
     **こちら側はリピートが当てになる。** macOSが繰り返すのは
     「最後に押した文字キー」なので、⌘の後に押したキーがちょうどそれにあたる
     （⌘より前に押したキーは、間に別のキーを挟んだ時点で繰り返しが止まる。
     そこをリピート頼みにしていたのが2回目の失敗） */
  down('KeyD', true);
  ok(input.down('KeyD'), '握り続けていればリピートで戻る');

  // 普通にkeyupが来た物は覚えから外す（次に⌘を離す時に巻き添えにしない）
  input.keys.clear();
  down('MetaLeft'); down('KeyD'); up('KeyD'); up('MetaLeft');
  ok(!input.down('KeyD'), '離した物はそのまま落ちている');
  down('KeyD');            // ⌘が無い所で押し直したので、もう覚えに入らない
  up('MetaLeft');
  ok(input.down('KeyD'), '⌘の外で押し直した物は巻き添えにしない');

  // 「押した瞬間」の印はリピートで立てない（跳躍が連射になる）
  input.keys.clear();
  input.endFrame();
  down('Space', true);
  ok(!input.pressed('Space'), 'リピートでは押した瞬間の印を立てない');
  down('Space');
  ok(input.pressed('Space'), '本当に押し下げた時だけ立つ');
  input.keys.clear();
  input.endFrame();
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
