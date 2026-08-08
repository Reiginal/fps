// 通算の戦績と実績の検査。
//
// なぜ要るか: 戦績は**間違っていても遊べてしまう。** 数字が少しおかしいだけなので、
// 遊んでいる本人も「そんなもんかな」で流す。流れたまま数ヶ月経つと、
// もう正しい値には戻せない（元の記録がどこにも無いので）。
//
// 特に見張りたいのが3つ。
//
//   1. **足し算と最大値を取り違える。** 「最高到達ウェーブ」を足し算にすると、
//      遊んだ回数の合計になる。数字は増え続けるので、遠目には正しく見える
//   2. **書き出す場所を間違える。** 1発撃つたびに localStorage へ書くと、
//      撃ち合いの最中に引っかかる。毎秒40発を超える場面がある
//   3. **解除済みの実績が起動のたびに知らせに来る。** 一覧を別に持つと必ずずれる
//
//   node tools/check-stats.mjs
import { readFileSync } from 'node:fs';

/* ------------------------------------------------ 最小限の偽DOM */
// tools/check-settings.mjs と同じ形。dom-stub.js の getElementById は
// null を返すので、画面を組み立てる所が検査にならない

const mkEl = (id) => {
  const classes = new Set();
  const el = {
    id,
    tag: '',
    style: {},
    children: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
    append(...cs) { for (const c of cs) { this.children.push(c); c._parent = this; } },
    appendChild(c) { this.append(c); },
  };
  let text = '';
  Object.defineProperty(el, 'textContent', {
    get() { return text; },
    set(v) { text = String(v); if (text === '') el.children.length = 0; },
  });
  let cls = '';
  Object.defineProperty(el, 'className', {
    get() { return cls; },
    set(v) { cls = String(v); classes.clear(); for (const c of cls.split(/\s+/)) if (c) classes.add(c); },
  });
  return el;
};

const els = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!els.has(id)) els.set(id, mkEl(id));
    return els.get(id);
  },
  createElement: (tag) => { const e = mkEl('new'); e.tag = tag; return e; },
};
globalThis.window = globalThis;
const listeners = [];
globalThis.addEventListener = (type, fn) => listeners.push({ type, fn });

/* ------------------------------------------------ 偽localStorage */
const mkStore = () => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
};
globalThis.localStorage = mkStore();

const {
  TALLIES, ACHIEVEMENTS, emptyTally, mergeTally, loadStats, saveStats, resetStats,
  progressOf, unlockedIds, newlyUnlocked, accuracyOf,
} = await import('../src/core/stats.js');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

console.log('\n[1] 数える物の表');
{
  const keys = TALLIES.map((t) => t.key);
  ok(new Set(keys).size === keys.length, `${keys.length}種類、同じ名札が2回出てこない`);
  ok(TALLIES.every((t) => t.kind === 'sum' || t.kind === 'max'),
    '数え方は足し算か最大値のどちらか');
  ok(TALLIES.some((t) => t.kind === 'max'), '最大値で数える物がある（自己ベスト）');
  ok(TALLIES.every((t) => !!t.name), '全部に画面へ出す名前がある');

  // **最高○○を足し算にすると、遊んだ回数の合計になる。**
  // 数字は増え続けるので遠目には正しく見えるが、意味は失われている
  for (const t of TALLIES) {
    if (!/^best/.test(t.key)) continue;
    ok(t.kind === 'max', `${t.key} は最大値で数える（足し算だと回数の合計になる）`);
  }
}

console.log('\n[2] 足し算と最大値');
{
  const a = { ...emptyTally(), kills: 10, bestScore: 5000 };
  const b = { ...emptyTally(), kills: 3, bestScore: 800 };
  const m = mergeTally(a, b);
  ok(m.kills === 13, `足し算の物は足される（${m.kills}）`);
  ok(m.bestScore === 5000, `最大値の物は大きいほうが残る（${m.bestScore}）`);

  const m2 = mergeTally(a, { ...emptyTally(), bestScore: 9000 });
  ok(m2.bestScore === 9000, '新しいほうが大きければ入れ替わる');

  // 何度混ぜても同じ結果（同じ物を2回流し込んでも壊れない）
  const twice = mergeTally(mergeTally(a, emptyTally()), emptyTally());
  ok(twice.kills === 10 && twice.bestScore === 5000, '空を混ぜても変わらない');
}

console.log('\n[3] 壊れた記録を捨てる');
// 手で書き換えられる場所なので、何が入っていてもおかしくない
{
  const junk = mergeTally({ kills: 'たくさん', deaths: -5, bestScore: NaN, なにこれ: 9 }, emptyTally());
  ok(junk.kills === 0, `数でない物は0（${junk.kills}）`);
  ok(junk.deaths === 0, `負の数も0（${junk.deaths}）`);
  ok(junk.bestScore === 0, `NaNも0（${junk.bestScore}）`);
  ok(junk['なにこれ'] === undefined, '知らない項目は持ち込まない');
  ok(Object.values(junk).every((v) => Number.isFinite(v)), '出てくる値は全部ちゃんとした数');

  ok(accuracyOf(emptyTally()) === 0, '1発も撃っていない時の命中率は0（0割りにしない）');
  ok(accuracyOf({ shots: 4, hits: 1 }) === 0.25, '命中率は当てた数÷撃った数');
}

console.log('\n[4] 端末に覚えて、次に開いた時に戻ってくる');
{
  globalThis.localStorage = mkStore();
  ok(loadStats().kills === 0, '何も無い端末では0から');
  saveStats({ ...emptyTally(), kills: 42, bestWave: 7 });
  const back = loadStats();
  ok(back.kills === 42 && back.bestWave === 7, `覚えた物が戻ってくる（撃破${back.kills} / ${back.bestWave}波）`);

  // **戦績を作る前は、自己ベストだけ blackout.best に入っていた。**
  // 引き取らないと、前から遊んでいる人のベストが0に戻る
  globalThis.localStorage = mkStore();
  localStorage.setItem('blackout.best', JSON.stringify({ score: 8800, wave: 12 }));
  const moved = loadStats();
  ok(moved.bestScore === 8800 && moved.bestWave === 12,
    `昔の自己ベストを引き取る（${moved.bestScore}点 / ${moved.bestWave}波）`);

  // 消したのに消えていないのが一番気持ち悪い
  resetStats();
  const gone = loadStats();
  ok(gone.bestScore === 0 && gone.bestWave === 0, '記録を消すと昔のベストも一緒に消える');
}

console.log('\n[5] localStorageが使えなくても遊べる');
{
  globalThis.localStorage = {
    getItem() { throw new Error('拒否'); },
    setItem() { throw new Error('拒否'); },
    removeItem() { throw new Error('拒否'); },
  };
  let threw = false;
  let v = null;
  try { v = loadStats(); saveStats({ kills: 3 }); resetStats(); } catch { threw = true; }
  ok(!threw, '読み書きで例外が出ても外へ漏らさない');
  ok(v && v.kills === 0, '読めない時は0で動く');
  globalThis.localStorage = mkStore();
}

console.log('\n[6] 実績の表');
{
  const ids = ACHIEVEMENTS.map((a) => a.id);
  ok(new Set(ids).size === ids.length, `${ids.length}個、同じidが2回出てこない`);
  ok(ACHIEVEMENTS.every((a) => a.name && a.desc), '全部に名前と説明がある');
  ok(ACHIEVEMENTS.every((a) => a.need > 0 && typeof a.have === 'function'),
    '全部が「今いくつ / いくつで解除」の形を持っている');

  // 0の記録では1つも解除されていない。1つでも解除済みだと、
  // 遊び始めた瞬間に全部が知らせに来る
  ok(unlockedIds(emptyTally()).size === 0, '何もしていない人は0個');

  // 進み具合が0〜1に収まる（画面の棒がはみ出す）
  const big = Object.fromEntries(TALLIES.map((t) => [t.key, 1e9]));
  for (const a of ACHIEVEMENTS) {
    const p = progressOf(a, big);
    ok(p === 1, `${a.name} … 十分やれば必ず解除される（${p}）`);
  }
  ok(ACHIEVEMENTS.every((a) => progressOf(a, emptyTally()) === 0), '0の記録では進み具合も0');
}

console.log('\n[7] 解除は記録から毎回引き直す');
// **解除済みの一覧を別に保存すると、記録と一覧の2つを揃える必要が出る。**
// 揃わなくなった時に直す手がかりがどこにも無い
{
  const before = { ...emptyTally(), kills: 0 };
  const after = { ...emptyTally(), kills: 1 };
  const got = newlyUnlocked(before, after);
  ok(got.length === 1 && got[0].id === 'first-blood',
    `1人倒した瞬間だけ知らせが出る（${got.map((a) => a.name).join('、') || 'なし'}）`);

  // **同じ状態をもう一度渡しても、二度は知らせない。**
  // ここが緩いと、起動のたびに解除済みが全部流れてくる
  ok(newlyUnlocked(after, after).length === 0, '同じ記録では二度知らせない');

  // 一度に複数解除されることはある（初撃破と3連続撃破が同時など）
  const many = newlyUnlocked(emptyTally(), { ...emptyTally(), kills: 3, bestStreak: 3 });
  ok(many.length >= 2, `まとめて解除もできる（${many.length}個）`);

  // 記録を消すと解除も消える（別に持っていたら消え残る）
  ok(unlockedIds(emptyTally()).size === 0, '記録を消せば解除も消える');
}

console.log('\n[8] 撃つたびに端末へ書かない');
// **毎秒40発を超える場面がある。** そのたびに文字列へ直して書き出すと、
// 撃ち合いの最中に引っかかる。手元で数えて、区切りで流し込む形になっているか
{
  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');

  // 撃った数・当てた数は _tally（手元で数えるほう）で増やす
  const shotLines = main.split('\n').filter((l) => /shotsFired\+\+|shotsHit\+\+/.test(l));
  ok(shotLines.length > 0, `撃った数を数えている箇所が ${shotLines.length} 個ある`);
  for (const l of shotLines) {
    ok(/_tally\('(shots|hits)'\)/.test(l), `手元で数えている: ${l.trim().slice(0, 60)}`);
  }

  // saveStats を直に呼ぶのは流し込みの1箇所だけ
  const saves = (main.match(/saveStats\(/g) || []).length;
  ok(saves === 1, `書き出しは1箇所だけ（${saves}箇所）`);
  // 窓は800字。_flushStatsの頭に重さの報告（_reportPerf）とその理由コメントが
  // 入った（2026-08-08）ので、400では先頭からsaveStatsまで届かなくなった
  ok(/_flushStats\(\)\s*\{[\s\S]{0,800}?saveStats\(/.test(main),
    'その1箇所が _flushStats の中にある');

  // 流し込む区切りが揃っているか。どれか1つ抜けると、その道で抜けた回だけ記録が消える
  for (const at of ['_onPlayerDown', '_onMatchEnd', '_leaveMatch', '_goHome', 'visibilitychange']) {
    ok(new RegExp(`${at}[\\s\\S]{0,900}?_flushStats\\(\\)`).test(main), `${at} で流し込む`);
  }
}

console.log('\n[9] 戦績の画面は無い（2026-08-07に消した）');
/* ホームの「戦績」ボタンは誰も開かなかったので、画面ごと消した。
   記録そのもの(stats.js)は残す: 死亡画面の自己ベストと実績の解除通知が使う。
   ここで見張るのは「中途半端に蘇らないこと」——入口だけ戻ると開けない画面になり、
   器だけ戻ると押せないボタンになる */
{
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(!html.includes('id="nmStats"'), 'ホームに戦績ボタンが無い');
  ok(!html.includes('id="stats"'), '戦績の器が無い');
  ok(html.includes('id="achfeed"'), '実績の解除通知の器は残っている');

  const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
  ok(!/StatsMenu/.test(main), 'main.jsが戦績の画面を読み込んでいない');

  // 自己ベストを2箇所に持たない。
  // コメントには「昔ここにあった」と残してあるので、コメントを外してから見る
  const code = main.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!code.includes('blackout.best'),
    'main.js が自己ベストを別に持っていない（stats.js が引き取った）');
}

console.log(bad === 0 ? '\n全部通った' : `\n${bad}件 落ちた`);
process.exit(bad === 0 ? 0 : 1);
