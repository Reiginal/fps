// 並行セッションの見張りの検査。
//
// 見ているのは2つ。
//   ・止めるべき打ち方をちゃんと止めるか（通ることより、こちらが本題）
//   ・**普通の打ち方を邪魔しないか。** 見張りが誤って止めると作業そのものが進まない
//
// 使い捨てのrepoを作って、本物の tools/guard-git.mjs をその中で走らせる。
// このrepo自身の .git には触らない（印の台帳を汚すと、走らせるたびに結果が変わる）。
//
//   node tools/check-guard.mjs
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepReason, gitCall, segments } from './guard-git.mjs';

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '○' : '× 失敗:'} ${msg}`); if (!c) bad++; };

const GUARD = new URL('./guard-git.mjs', import.meta.url).pathname;

// 命令の文字列から「止める理由」を引く。通すなら null
const judge = (cmd) => {
  for (const seg of segments(cmd)) {
    const call = gitCall(seg);
    if (call && sweepReason(call)) return sweepReason(call);
  }
  return null;
};

/* ------------------------------------------------ 全部まとめて系 */

console.log('\n[1] 「全部まとめて」系を止める');
{
  /* **2026-08-12に実際に起きた形。** 片方のセッションが書きかけた index.html を、
     もう片方の git add が拾って、無関係のコミットに混ぜてマージした */
  for (const cmd of [
    'git add -A',
    'git add --all',
    'git add -u',
    'git add .',
    'git add',
    'git commit -a -m "x"',
    'git commit -am "x"',
    'git commit --all -m "x"',
    'git stash',
    'git stash save "とりあえず"',
    'git stash -u',
    'git reset --hard origin/main',
    'git checkout .',
    'git checkout -- .',
    'git clean -fd',
  ]) {
    ok(judge(cmd) !== null, `止まる: ${cmd}`);
  }
}

console.log('\n[2] 繋がった命令の後ろも見る');
{
  /* 頭だけ見ると素通しになる。**1回のBashに複数入るのが普通の書き方** */
  ok(judge('npm run check && git add -A') !== null, '&& の後ろの git add -A を止める');
  ok(judge('git status --short; git commit -am "x"') !== null, '; の後ろの commit -a を止める');
  ok(judge('cd /tmp && git stash') !== null, 'cd してからの git stash を止める');
}

console.log('\n[3] 普通の打ち方を邪魔しない');
{
  /* **こちらの方が大事。** 見張りが誤って止めると、
     直し方が分からないまま作業が止まる（止まる側は理由を選べない） */
  for (const cmd of [
    'git add tools/guard-git.mjs',
    'git add src/ui/account.js tools/check-auth.mjs',
    'git commit -m "fix: なおした"',
    'git commit --amend -m "なおした"',
    'git status --short',
    'git diff --cached --name-only',
    'git log --oneline -3',
    'git checkout main',
    'git checkout -b account-name-instant',
    'git switch main',
    'git stash pop',
    'git stash list',
    'git stash push -- index.html',
    'git push -u origin main',
    'git pull --ff-only origin main',
    'npm run lint',
    'gh pr create --base main',
  ]) {
    ok(judge(cmd) === null, `通る: ${cmd}`);
  }

  /* **コミットのメッセージに -a や . が入っていても巻き込まない。**
     引用符の中を1つの塊として読んでいるかを見ている */
  ok(judge('git commit -m "fix: git add -A をやめた"') === null,
    '**メッセージの中の -A で止まらない**');
  ok(judge('git commit -m "update: 設定を . 以下へ移した"') === null,
    'メッセージの中の . で止まらない');
}

/* ------------------------------------------------ 誰が触ったかの台帳 */

console.log('\n[4] 別のセッションが触った物をコミットに入れない');
{
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // 見張りを走らせる。返事が空なら「通す」、JSONが返れば止めている
  const hook = (payload) => {
    const out = execFileSync('node', [GUARD], {
      cwd: dir, encoding: 'utf8', input: JSON.stringify(payload),
    });
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };

  try {
    git('init', '-q');
    git('config', 'user.email', 'a@b.c');
    git('config', 'user.name', 'test');
    writeFileSync(join(dir, 'mine.txt'), 'あ\n');
    writeFileSync(join(dir, 'theirs.txt'), 'い\n');
    git('add', 'mine.txt', 'theirs.txt');
    git('commit', '-q', '-m', 'first');

    // 相手のセッションが theirs.txt を書きかけている、という状態を作る
    writeFileSync(join(dir, 'theirs.txt'), 'い\nう\n');
    hook({
      session_id: 'sessionB', tool_name: 'Edit',
      tool_input: { file_path: join(dir, 'theirs.txt') },
    });
    // 自分は mine.txt を書いている
    writeFileSync(join(dir, 'mine.txt'), 'あ\nか\n');
    hook({
      session_id: 'sessionA', tool_name: 'Edit',
      tool_input: { file_path: join(dir, 'mine.txt') },
    });

    const commitAsA = (cmd) => hook({
      session_id: 'sessionA', tool_name: 'Bash', tool_input: { command: cmd },
    });

    ok(commitAsA('git add mine.txt && git commit -m "x"') === null,
      '自分が触ったファイルだけなら通る');

    const blocked = commitAsA('git add theirs.txt && git commit -m "x"');
    ok(blocked?.permissionDecision === 'deny',
      '**相手が書きかけのファイルを名指しで入れても止まる**');
    ok(/theirs\.txt/.test(blocked?.permissionDecisionReason || ''),
      '止めた理由にファイル名が出る（何を外せばいいか分かる）');

    // 段取り済み(staged)から来る場合も同じ。add と commit が別のBashに分かれた形
    git('add', 'theirs.txt');
    const staged = commitAsA('git commit -m "x"');
    ok(staged?.permissionDecision === 'deny',
      '前のBashで段取りされていた分も止まる');
    git('reset', '-q');

    /* **枝を移るのは止めない。聞くだけ。**
       止めてしまうと、隔離するために枝を作ることすらできなくなる */
    const moving = commitAsA('git checkout -b new-branch');
    ok(moving?.permissionDecision === 'ask',
      '相手の書きかけがある時に枝を移ろうとしたら聞く（止めはしない）');

    /* 相手の書きかけがコミットされたら、印は消えて何も言わなくなる。
       **残ると、同じファイルを次に触る人が理由もなく止められる** */
    git('add', 'theirs.txt');
    git('commit', '-q', '-m', 'theirs');
    writeFileSync(join(dir, 'theirs.txt'), 'い\nう\nえ\n');
    hook({ session_id: 'sessionA', tool_name: 'Edit', tool_input: { file_path: join(dir, 'theirs.txt') } });
    ok(commitAsA('git add theirs.txt && git commit -m "x"') === null,
      '相手がコミットし終えた後は、同じファイルを自分が触っても通る');

    // 見張りが転んでも作業を止めない
    ok(hook({ session_id: 'sessionA', tool_name: 'Bash', tool_input: {} }) === null,
      '命令が空でも通す（見張りのせいで作業が止まらない）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n[5] 繋ぎ方が残っているか');
{
  /* **仕掛けを書いただけでは動かない。**
     .claude/settings.local.json は手元だけの物（gitに入らない）ので、
     消えていても他の検査は全部通る。ここで見ておかないと、
     「入れたつもりで外れている」に気づけない */
  let settings = null;
  try {
    settings = JSON.parse(execFileSync('cat',
      [new URL('../.claude/settings.local.json', import.meta.url).pathname], { encoding: 'utf8' }));
  } catch { /* 手元に無い環境（CI）では見ない */ }

  if (settings === null) {
    console.log('  － 手元の設定が無いので飛ばす（CIではこれが普通）');
  } else {
    const all = JSON.stringify(settings.hooks || {});
    ok(/guard-git\.mjs/.test(all), '見張りがhooksから呼ばれている');
    ok(/"PreToolUse"/.test(JSON.stringify(Object.keys(settings.hooks || {}))),
      'Bashの前に走る繋ぎがある（止めるにはPreToolUseで無いと間に合わない）');
    ok(/"PostToolUse"/.test(JSON.stringify(Object.keys(settings.hooks || {}))),
      'Edit/Writeの後に走る繋ぎがある（これが無いと誰が触ったか分からない）');
  }
}

console.log(`\n${bad === 0 ? '全部通った' : `${bad}件 失敗`}`);
process.exit(bad === 0 ? 0 : 1);
