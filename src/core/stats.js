// 通算の戦績と実績。**今は端末に覚えるだけ。**
//
// なぜ端末から始めるか: ブレストで「まず手元保存で作る。後のDB移行の練習台」と決めた。
// 先にアカウントとDBを作ると、実績そのものが面白いかどうかを確かめる前に
// 2日かかる。ここで面白くなければ、DBを足しても面白くならない。
//
// 端末保存の限界も承知の上:
//   - ブラウザを変えると0から。別のパソコンでも0から
//   - 消そうと思えば本人が消せる（**だから他人と競う物には使えない**）
// 逆に言えば、この2つが困り始めた時が「サーバーへ移す」の合図になる。
//
// 移す時に困らないよう、**数え方と実績の判定を1枚の表**にしてある。
// サーバーへ移す時に動かすのは「どこへ書くか」だけで済む。
//
// 検査は tools/check-stats.mjs。

/**
 * 数える物。
 *
 * kind: 'sum' … 足していく（累計撃破など）
 *       'max' … 一番良かった回だけ残す（自己ベスト）
 *
 * **2種類あるのが肝。** 全部足し算にすると「最高到達ウェーブ」が
 * 遊んだ回数の合計になって、数字が意味を失う
 */
export const TALLIES = [
  { key: 'kills', kind: 'sum', name: '通算撃破' },
  { key: 'headshots', kind: 'sum', name: 'ヘッドショット' },
  { key: 'deaths', kind: 'sum', name: '戦死' },
  { key: 'shots', kind: 'sum', name: '発射数' },
  { key: 'hits', kind: 'sum', name: '命中数' },
  { key: 'matches', kind: 'sum', name: '対戦した回数' },
  { key: 'wins', kind: 'sum', name: '勝利' },
  { key: 'bestStreak', kind: 'max', name: '連続撃破の最高' },
  { key: 'bestWave', kind: 'max', name: '最高到達ウェーブ' },
  { key: 'bestScore', kind: 'max', name: '最高スコア' },
];

const STORE = 'blackout.stats';

/** 命中率。撃っていない時に0/0で NaN にしない */
export const accuracyOf = (t) => (t.shots > 0 ? t.hits / t.shots : 0);

/* 命中率の実績は、数発だけ撃って当てた人が取れてはいけない。
   3発撃って1発当てれば33%になるので、下限を置く */
const ACC_MIN_SHOTS = 300;

/**
 * 実績の表。
 *
 * have は「今いくつか」、need は「いくつで解除か」。
 * 進み具合を出したいので、解除の判定を真偽値ではなく数で持つ。
 * **数で持たないと「あと3人」が画面に出せない。**
 * 出せないと、遠い実績はただの飾りになる
 */
export const ACHIEVEMENTS = [
  { id: 'first-blood', name: '初撃破', desc: '誰かを1人倒す', have: (t) => t.kills, need: 1 },
  { id: 'kills-100', name: '撃破100', desc: '通算100人倒す', have: (t) => t.kills, need: 100 },
  { id: 'kills-1000', name: '撃破1000', desc: '通算1000人倒す', have: (t) => t.kills, need: 1000 },
  { id: 'head-25', name: '頭を狙う', desc: 'ヘッドショット25回', have: (t) => t.headshots, need: 25 },
  { id: 'head-200', name: '狙撃手', desc: 'ヘッドショット200回', have: (t) => t.headshots, need: 200 },
  { id: 'first-win', name: '初勝利', desc: '対戦で1勝する', have: (t) => t.wins, need: 1 },
  { id: 'win-10', name: '常勝', desc: '対戦で10勝する', have: (t) => t.wins, need: 10 },
  { id: 'streak-3', name: '3連続撃破', desc: '倒されずに3人倒す', have: (t) => t.bestStreak, need: 3 },
  { id: 'streak-8', name: '無双', desc: '倒されずに8人倒す', have: (t) => t.bestStreak, need: 8 },
  { id: 'wave-10', name: '第10波', desc: '1人用で10波まで生き残る', have: (t) => t.bestWave, need: 10 },
  { id: 'score-10k', name: '1万点', desc: '1人用で10,000点を出す', have: (t) => t.bestScore, need: 10_000 },
  {
    id: 'accuracy-30',
    name: '無駄弾なし',
    desc: `${ACC_MIN_SHOTS}発以上撃って命中率30%`,
    // 撃った数が足りないうちは0のまま。進み具合の分母を命中率にすると、
    // 3発撃って1発当てた人の画面に「100%達成」が出る
    have: (t) => (t.shots >= ACC_MIN_SHOTS ? Math.floor(accuracyOf(t) * 100) : 0),
    need: 30,
  },
];

/** 全部0の入れ物 */
export const emptyTally = () => Object.fromEntries(TALLIES.map((t) => [t.key, 0]));

/** 数でない物・負の数を落とす。壊れた記録で画面がNaNだらけになるのを防ぐ */
const clean = (raw) => {
  const out = emptyTally();
  if (!raw || typeof raw !== 'object') return out;
  for (const t of TALLIES) {
    const n = Number(raw[t.key]);
    if (Number.isFinite(n) && n > 0) out[t.key] = Math.floor(n);
  }
  return out;
};

/**
 * 2つの記録を合わせる。sumは足し算、maxは大きいほう。
 * 遊んでいる間の記録を手元に溜めて、区切りでここへ流し込む
 */
export function mergeTally(base, add) {
  const a = clean(base);
  const b = clean(add);
  const out = emptyTally();
  for (const t of TALLIES) out[t.key] = t.kind === 'max' ? Math.max(a[t.key], b[t.key]) : a[t.key] + b[t.key];
  return out;
}

/* 戦績を作る前から、1人用の自己ベストだけは blackout.best に覚えていた。
   同じ「一番良かった回」を2箇所に持つと必ずずれるので、こちらへ引き取る。
   前から遊んでいる人のベストが0に戻らないようにするためだけの物 */
const LEGACY_BEST = 'blackout.best';
function legacyBest() {
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY_BEST) || '{}');
    return { bestScore: v.score | 0, bestWave: v.wave | 0 };
  } catch { return {}; }
}

/* localStorageは設定次第で読み書きどちらも例外を投げる。
   戦績を覚えられないだけで遊べなくなるのは割に合わない */
export function loadStats() {
  let saved = emptyTally();
  try { saved = clean(JSON.parse(localStorage.getItem(STORE) || '{}')); } catch { return emptyTally(); }
  // 昔のベストのほうが大きい時だけ引き上げる。max なので何度読んでも同じ結果になる
  return mergeTally(saved, legacyBest());
}

export function saveStats(t) {
  const v = clean(t);
  try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* 覚えられないだけ */ }
  return v;
}

/* 消す時は昔のベストも一緒に消す。**残すと、消した直後に読み直した時に
   ベストだけ生き返る。** 消したのに消えていないのが一番気持ち悪い */
export function resetStats() {
  try { localStorage.removeItem(LEGACY_BEST); } catch { /* 消せないだけ */ }
  return saveStats(emptyTally());
}

/** その実績の進み具合。0〜1 */
export const progressOf = (a, t) => Math.min(1, Math.max(0, a.have(clean(t)) / a.need));

/** 解除済みの実績のid */
export function unlockedIds(t) {
  const c = clean(t);
  return new Set(ACHIEVEMENTS.filter((a) => a.have(c) >= a.need).map((a) => a.id));
}

/**
 * 前の記録と今の記録を比べて、**今まさに解除された物**だけ返す。
 *
 * 解除済みの一覧を別に保存しないのは、2つ持つと必ずずれるから。
 * 記録から毎回引き直せば、ずれようがない
 */
export function newlyUnlocked(before, after) {
  const was = unlockedIds(before);
  const now = unlockedIds(after);
  return ACHIEVEMENTS.filter((a) => !was.has(a.id) && now.has(a.id));
}
