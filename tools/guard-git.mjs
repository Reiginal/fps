// 並行して動くセッションどうしの事故を、ルールではなく仕組みで止める見張り。
//
// **2026-08-12に実際に起きた形。**
// このrepoで2つのClaudeセッションが同じ作業ツリーで動いていて、
// 片方が index.html を書きかけたまま考えている間に、
// もう片方が自分のコミットを作った。その時に `git add` が全部を拾ったので、
// 書きかけの index.html が**まったく関係のないコミットに混ざって**
// PRになり、mainへマージされた。
// 書いた側は「自分の変更がgit statusから消えている」形で後から気づく。
//
// CLAUDE.mdには前から「worktreeへ隔離する」「コミットはファイル名指定」と
// 書いてあった。**書いてあっても起きた。**
// 相手が守るかどうかに賭ける形になっていたのが原因なので、ここで止める。
//
// やっていることは2つだけ。
//
//   1. 誰がどのファイルを触ったかを覚える（Edit/Writeのたび）
//   2. gitに「全部まとめて」系の命令が来たら止める。
//      名指しのコミットでも、他のセッションが触った物が混ざっていたら止める
//
// **人が自分で打つgitには何も起きない。** Claudeの道具として走るコマンドだけを見る。
// 事故を起こすのはセッションどうしなので、そこだけで足りる。
//
// 繋ぎ方は .claude/settings.local.json のhooks（手元だけ・gitに入らない）。
// 検査は tools/check-guard.mjs。
//
//   echo '{"tool_name":"Bash","tool_input":{"command":"git add -A"}}' | node tools/guard-git.mjs

import { readFileSync, writeFileSync, renameSync, realpathSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';

/* 覚えておく期限。**これを過ぎた印は無視する。**
   終わったセッションの印が残り続けると、誰も居ないのに永久に止まる */
const KEEP_MS = 24 * 60 * 60 * 1000;

/* ------------------------------------------------------ 返事の作り方 */

// 何も言わずに通す。**迷ったら必ずこちら。**
// 見張りが誤って止めると作業が進まなくなるので、判断が付かない時は通す側に倒す
const pass = () => process.exit(0);

const say = (decision, reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};
// 止める。理由はそのままClaudeに返るので、代わりの打ち方まで書く
const deny = (reason) => say('deny', reason);
// 人に聞く。止めるほどではないが、黙って進めさせたくない物
const ask = (reason) => say('ask', reason);

/* ------------------------------------------------------ 下ごしらえ */

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/* 印の置き場。**.git の中に置く。**
   作業ツリーへ置くとgit statusに出てしまい、
   「知らないファイルがある」と思われて消される（実際に相手の調査用ファイルを消している）。
   --git-common-dir にするのは、worktreeへ隔離した相手とも同じ台帳を見るため */
function claimFile() {
  const dir = git(['rev-parse', '--git-common-dir']).trim();
  return `${dir}/claude-claims.json`;
}

function readClaims(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
}

function writeClaims(path, claims) {
  /* 書いている途中を相手に読ませない。
     同じ台帳を2つのセッションが触るので、途中の壊れたJSONを見せると
     「印が無い」と読まれて、止めるべき時に止まらなくなる */
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(claims));
  renameSync(tmp, path);
}

/* 今も書きかけとして残っている物だけを残す。
   **コミットが済んだ印は消す。** 残しておくと、
   同じファイルを次に触った別のセッションが理由もなく止められる */
function sweepStale(claims, dirty, now) {
  for (const [path, c] of Object.entries(claims)) {
    if (!dirty.has(path) || now - (c.t || 0) > KEEP_MS) delete claims[path];
  }
  return claims;
}

// git status から、今なんらかの変更があるファイルを拾う
function dirtyPaths() {
  const out = new Set();
  for (const line of git(['status', '--porcelain', '-z']).split('\0')) {
    if (!line) continue;
    // 「XY パス」の形。名前替えの「元 -> 先」は -z だと別の欄に来るので、ここは先だけ拾う
    const p = line.slice(3);
    if (p) out.add(p);
  }
  return out;
}

/* ------------------------------------------------------ 命令の読み方 */

/* 引用符の中を1つの塊として割る。
   ここで見たいのはフラグとパスの有無だけなので、これで足りる
   （コミットのメッセージが -a を含んでいても巻き込まれないようにするのが本題） */
export function tokens(segment) {
  const found = segment.match(/"[^"]*"|'[^']*'|\S+/g) || [];
  return found.map((t) => t.replace(/^["']|["']$/g, ''));
}

/* 1回のBashに複数の命令が入る（git add ... && git commit ...）。
   **繋がった全部を見る。** 頭だけ見ると、後ろに付けた方を素通しする */
export function segments(cmd) {
  return cmd.split(/&&|\|\||[;|\n]/);
}

/* 「git なんとか」を取り出す。-C や -c は git 自身への指定なので読み飛ばす */
export function gitCall(segment) {
  const t = tokens(segment);
  const at = t.indexOf('git');
  if (at < 0) return null;
  let i = at + 1;
  while (i < t.length && (t[i] === '-C' || t[i] === '-c')) i += 2;
  if (i >= t.length) return null;
  return { sub: t[i], args: t.slice(i + 1) };
}

const isFlag = (t) => t.startsWith('-');

/**
 * 「全部まとめて」系か。**他のセッションの書きかけを巻き込む打ち方だけを見る。**
 * 名指しの `git add ファイル名` は通す（それが正しい打ち方なので）。
 *
 * @returns 止める理由。問題なければ null
 */
export function sweepReason({ sub, args }) {
  const paths = args.filter((t) => !isFlag(t));

  if (sub === 'add') {
    if (args.some((t) => t === '--all' || t === '--update' || /^-[A-Za-z]*[Au]/.test(t))) {
      return 'git add -A / -u は追跡中のファイルを全部拾うので、'
        + '同じ作業ツリーで動いている別のセッションの書きかけまでコミットに入る。'
        + '2026-08-12に実際に起きた（index.htmlが無関係のPRに混ざってマージされた）。'
        + 'git add <ファイル名> と名指しで打つこと。';
    }
    if (paths.length === 0 || paths.some((p) => p === '.' || p === ':/' || p === '*')) {
      return 'git add . は今いる場所より下を全部拾うので、別のセッションの書きかけまで入る。'
        + 'git add <ファイル名> と名指しで打つこと。';
    }
    return null;
  }

  if (sub === 'commit') {
    // -a / -am。--amend や --author は「--」始まりなので当たらない
    if (args.some((t) => t === '--all' || (/^-[A-Za-z]+$/.test(t) && t.includes('a')))) {
      return 'git commit -a は追跡中の変更を全部拾うので、別のセッションの書きかけまで入る。'
        + '先に git add <ファイル名> で名指ししてから、-a なしで commit すること。';
    }
    return null;
  }

  if (sub === 'stash') {
    const first = paths[0] || '';
    // 取り出す・見る系は誰の書きかけも巻き上げない
    if (['list', 'show', 'pop', 'apply', 'drop', 'clear', 'branch', 'create', 'store'].includes(first)) return null;
    const dd = args.indexOf('--');
    if (dd >= 0 && args.length > dd + 1) return null; // パスを名指ししている
    return 'パスを指定しない git stash は、作業ツリーの変更を全部棚に上げる。'
      + '別のセッションが書いている途中の物まで作業ツリーから消えるので、'
      + 'git stash push -- <ファイル名> と名指しで打つこと。';
  }

  if (sub === 'reset' && args.includes('--hard')) {
    return 'git reset --hard は作業ツリーの変更を全部捨てる。別のセッションの書きかけも戻せなくなる。'
      + '自分の分だけ戻したいなら git stash push -- <ファイル名>。';
  }

  if (sub === 'checkout' || sub === 'restore') {
    const dd = args.indexOf('--');
    const after = dd >= 0 ? args.slice(dd + 1).filter((t) => !isFlag(t)) : paths;
    if (after.includes('.') || (dd >= 0 && after.length === 0) || (sub === 'restore' && after.length === 0)) {
      return `git ${sub} で変更をまとめて捨てようとしている。別のセッションの書きかけも一緒に消える。`
        + 'git stash push -- <ファイル名> を使うこと。';
    }
    return null;
  }

  if (sub === 'clean' && args.some((t) => t === '--force' || /^-[a-zA-Z]*f/.test(t))) {
    return 'git clean は追跡していないファイルを消す。'
      + '別のセッションが置いた調査用のファイルまで消える（2026-08-09に実際に消している）。'
      + '消したい物を名指しで rm すること。';
  }

  return null;
}

/* この命令で新しく段取りされるファイル。
   **同じBashの中で add してから commit する形が一番多い。**
   commitの時点ではまだ段取りされていないので、前の段の add から拾っておかないと素通しになる */
function willStage(calls) {
  const out = [];
  for (const c of calls) {
    if (c.sub === 'add') out.push(...c.args.filter((t) => !isFlag(t)));
  }
  return out;
}

// 枝を移る・作る命令か。移ると書きかけが付いて来る（これで index.html が旅をした）
function movesBranch({ sub, args }) {
  if (sub === 'switch') return true;
  if (sub !== 'checkout') return false;
  // ファイルを戻す用の checkout は sweepReason 側の担当
  return !args.includes('--');
}

/* ------------------------------------------------------ 本体 */

/* **読み込まれただけでは何もしない。**
   検査(tools/check-guard.mjs)が上の関数だけを取りに来るので、
   その時に標準入力を読みにいくと、待ち続けて検査ごと止まる。
   pass()はprocess.exitなので、ここで呼ぶと呼んだ側まで道連れになる。だからreturnで抜ける */
function main() {
  let ev;
  try {
    ev = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    pass();
  }

  const tool = ev.tool_name;
  const me = ev.session_id || '';

  try {
    /* 触った印を残す（Edit/Writeの後）。**ここが台帳の入口。**
       道具を通さずに書き換えた物は載らないが、事故を起こすのはClaudeどうしなので足りる */
    if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
      const abs = ev.tool_input?.file_path;
      if (!abs || !me) pass();
      /* **本当の場所まで辿ってから比べる。**
         macOSの /tmp は /private/tmp への近道で、gitは辿った後の道を答える。
         辿らずに比べると「repoの外だ」と読んで、印を1つも残さないまま素通しする
         （検査を書いて初めて気づいた） */
      const root = realpathSync(git(['rev-parse', '--show-toplevel']).trim());
      const real = join(realpathSync(dirname(abs)), basename(abs));
      if (!real.startsWith(`${root}/`)) pass();   // repoの外は関係ない
      const rel = real.slice(root.length + 1);
      const path = claimFile();
      const claims = readClaims(path);
      claims[rel] = { s: me, t: Date.now() };
      writeClaims(path, sweepStale(claims, dirtyPaths(), Date.now()));
      pass();
    }

    if (tool !== 'Bash') pass();

    const cmd = ev.tool_input?.command || '';
    if (!/\bgit\b/.test(cmd)) pass();

    const calls = segments(cmd).map(gitCall).filter(Boolean);
    if (calls.length === 0) pass();

    // 1. 「全部まとめて」系は、相手が居るかどうかに関係なく止める
    for (const c of calls) {
      const why = sweepReason(c);
      if (why) deny(why);
    }

    // 2. 名指しでも、他のセッションが触った物が混ざっていたら止める
    const claims = readClaims(claimFile());
    const mine = (p) => !claims[p] || claims[p].s === me || Date.now() - (claims[p].t || 0) > KEEP_MS;
    const whose = (p) => `${p}（別のセッションが編集中）`;

    if (calls.some((c) => c.sub === 'commit')) {
      const staged = git(['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
      const theirs = [...new Set([...staged, ...willStage(calls)])].filter((p) => !mine(p));
      if (theirs.length) {
        deny('このコミットに、別のセッションが書いている途中のファイルが入っている:\n'
          + theirs.map((p) => `  ${whose(p)}`).join('\n')
          + '\n\n相手の書きかけには触らないこと。'
          + 'git restore は使えないので、git rm --cached <ファイル名> で段取りから外してから、'
          + '自分が触ったファイルだけを名指ししてコミットすること。');
      }
    }

    // 3. 枝を移るのは止めない。**ただし黙っては通さない**（移ると書きかけが付いて来る）
    if (calls.some(movesBranch)) {
      const theirs = [...dirtyPaths()].filter((p) => !mine(p));
      if (theirs.length) {
        ask('別のセッションが書いている途中のファイルがあります。'
          + 'このまま枝を移ると、相手の書きかけが付いて来ます:\n'
          + theirs.map((p) => `  ${whose(p)}`).join('\n')
          + '\n\n進めてよいか確認してください（自分をworktreeへ隔離する手もあります）。');
      }
    }
  } catch {
    /* 見張りが転んだせいで作業が止まるのが一番困る。
       git が無い・台帳が壊れている・worktreeの繋ぎが切れている、どれでもそのまま通す */
    pass();
  }

  pass();
}

// 直に走らせた時だけ動く。読み込まれただけの時は上の関数を配るだけ
if (process.argv[1] === new URL(import.meta.url).pathname) main();
