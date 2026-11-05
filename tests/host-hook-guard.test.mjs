// The commit guard every host calls: which payloads count as a commit, what a passing review allows,
// and what a blocking one answers in each host's own contract.

import assert from 'node:assert/strict';
import test from 'node:test';
import { asksForHelp, commandOf, decideGuard, denyContract, isCommitCommand, stripShellComment, substitutions } from '../scripts/hook-guard.mjs';
import { isMainModule } from '../src/infra/main-module.mjs';

test('Given the payload shapes the hosts use, When the command is read, Then every shape is recognised', () => {
  assert.equal(commandOf({ tool_input: { command: 'git commit -m x' } }), 'git commit -m x');
  assert.equal(commandOf({ args: { command: 'git commit' } }), 'git commit');
  assert.equal(commandOf({ input: { cmd: 'git commit' } }), 'git commit');
  assert.equal(commandOf({ command: 'git commit' }), 'git commit');
  assert.equal(commandOf({ tool_input: { command: '   ' } }), null);
  assert.equal(commandOf(null), null);
});

test('Given a command, When it is classified, Then only a real commit is a commit', () => {
  assert.equal(isCommitCommand('git commit -m "x"'), true);
  assert.equal(isCommitCommand('cd repo && git commit'), true);
  assert.equal(isCommitCommand('git -C repo commit -m x'), true);
  assert.equal(isCommitCommand('git status'), false);
  assert.equal(isCommitCommand('git commit --help'), false);
  assert.equal(isCommitCommand('echo "git commit"'), false);
  assert.equal(isCommitCommand(''), false);
});

test('Given a non-commit command, When the guard decides, Then it allows without running the review', () => {
  let reviews = 0;
  const decision = decideGuard({ command: 'npm test', review: () => { reviews += 1; return { status: 0 }; } });
  assert.equal(decision.decision, 'allow');
  assert.equal(reviews, 0, 'the review never runs for a command that does not commit');
});

test('Given a commit and a passing review, When the guard decides, Then it allows', () => {
  const decision = decideGuard({ command: 'git commit -m x', review: () => ({ status: 0 }) });
  assert.equal(decision.decision, 'allow');
  assert.equal(decision.remark, 'review passed');
});

test('Given a commit and a blocking review, When the guard decides, Then it blocks and carries the reason', () => {
  const decision = decideGuard({ command: 'git commit -m x', review: () => ({ status: 1, stderr: 'review: BLOCK (finding)' }) });
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /blocked this commit/);
  assert.match(decision.reason, /review: BLOCK/);
});

test('Given a review that crashed, When the guard decides, Then it blocks rather than letting the commit through', () => {
  const decision = decideGuard({ command: 'git commit', review: () => ({ status: null, stderr: '' }) });
  assert.equal(decision.decision, 'block');
  assert.match(decision.reason, /unknown/);
});

test('Given a blocked decision, When each host contract is rendered, Then each host gets the shape it reads', () => {
  const codex = denyContract('codex', { decision: 'block', reason: 'nope' });
  assert.equal(codex.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(codex.hookSpecificOutput.permissionDecisionReason, 'nope');
  const opencode = denyContract('opencode', { decision: 'block', reason: 'nope' });
  assert.equal(opencode.deny, true);
  assert.deepEqual(denyContract('codex', { decision: 'allow', reason: '' }), {});
});

test('Given a commit followed by an unrelated --help segment, When it is classified, Then the commit still counts', () => {
  assert.equal(isCommitCommand('git commit -m x; echo --help'), true);
  assert.equal(isCommitCommand('git commit -m x && ls --help'), true);
  assert.equal(isCommitCommand('git commit --help; git commit -m x'), true, 'a help segment does not decide the real one');
  assert.equal(isCommitCommand('git commit --help'), false);
  assert.equal(isCommitCommand('npm test; git status --help'), false);
});

test('Given a command that only mentions help elsewhere, When the guard decides, Then the review still runs for a commit', () => {
  let reviews = 0;
  const decision = decideGuard({ command: 'git commit -m x; echo --help', review: () => { reviews += 1; return { status: 0 }; } });
  assert.equal(decision.decision, 'allow');
  assert.equal(reviews, 1, 'the review ran for the commit segment');
});

test('Given a path containing a space, When the module identity is compared, Then the decoded path matches', () => {
  const withSpace = 'C:/Users/some one/kit/scripts/hook-guard.mjs';
  const encoded = new URL('file:///C:/Users/some%20one/kit/scripts/hook-guard.mjs').href;
  assert.equal(isMainModule(encoded, withSpace), true, 'the percent-encoded pathname must not defeat the comparison');
  assert.equal(isMainModule(encoded, 'C:/elsewhere.mjs'), false);
  assert.equal(isMainModule(encoded, undefined), false);
});

test('Given a newline-separated command, When it is classified, Then a commit on the second line counts', () => {
  assert.equal(isCommitCommand('echo ok\ngit commit -m x'), true);
  assert.equal(isCommitCommand('echo ok\r\ngit commit'), true);
  assert.equal(isCommitCommand('git commit -m x\necho done'), true);
  assert.equal(isCommitCommand('echo ok\ngit status'), false);
});

test('Given a commit carrying git global options, When it is classified, Then it is still a commit', () => {
  assert.equal(isCommitCommand('git -c core.hooksPath=/dev/null commit -m x'), true);
  assert.equal(isCommitCommand('git --git-dir=/tmp/g commit -m x'), true);
  assert.equal(isCommitCommand('env GIT_TRACE=1 git commit -m x'), true);
  assert.equal(isCommitCommand('sudo git commit -m x'), true);
  assert.equal(isCommitCommand('git -c core.hooksPath=/dev/null status'), false);
});

test('Given a commit whose message mentions --help, When it is classified, Then it is still a commit', () => {
  assert.equal(isCommitCommand('git commit -m "document --help handling"'), true);
  assert.equal(isCommitCommand("git commit -m 'mentions -h too'"), true);
  assert.equal(asksForHelp('git commit -m "document --help"'), false);
  assert.equal(asksForHelp('git commit --help'), true);
  assert.equal(asksForHelp('git commit -h'), true);
});

test('Given a message with an escaped quote before --help, When the segments are classified, Then the commit still counts', () => {
  assert.equal(asksForHelp('git commit -m "text \\" --help"'), false);
  assert.equal(isCommitCommand('git commit -m "text \\" --help"'), true);
  assert.equal(asksForHelp('git commit -m "a" --help'), true, 'a real help token after the message still asks for help');
});

test('Given a commit followed by a shell comment mentioning --help, When it is classified, Then the commit counts', () => {
  assert.equal(isCommitCommand('git commit -m x # --help'), true);
  assert.equal(stripShellComment('git commit -m x # --help'), 'git commit -m x ');
  assert.equal(stripShellComment('git commit -m "text # not a comment"'), 'git commit -m "text # not a comment"');
  assert.equal(isCommitCommand('echo hi # git commit'), false);
});

test('Given a commit inside command substitution, When the command is classified, Then it is a commit', () => {
  assert.equal(isCommitCommand('echo "$(git commit -m bypass)"'), true);
  assert.equal(isCommitCommand('echo \`git commit -m bypass\`'), true);
  assert.equal(isCommitCommand('echo "$(git status)"'), false);
  assert.deepEqual(substitutions('echo "$(git commit -m x)"'), ['git commit -m x']);
});

test('Given a command whose substitution asks for help, When it is classified, Then it is not a commit', () => {
  assert.equal(isCommitCommand('echo "$(git commit --help)"'), false);
});

test('Given a deeply nested commit, When it is classified, Then the guard refuses to call the command safe', () => {
  const deep = 'echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(echo "$(git commit -m x)")")")")")")")")"';
  assert.equal(isCommitCommand(deep), true, 'past the traversal bound a possible commit blocks');
  assert.equal(isCommitCommand('echo "$(echo "$(echo "$(echo "$(echo "noise")")")")"'), false);
});

test('Given a substitution inside single quotes, When the command is classified, Then it is a literal and not a commit', () => {
  assert.deepEqual(substitutions("echo '$(git commit -m x)'"), []);
  assert.equal(isCommitCommand("echo '$(git commit -m x)'"), false);
  assert.equal(isCommitCommand('echo "$(git commit -m x)"'), true, 'double quotes still execute');
});

test('Given a backgrounded commit, When it is classified, Then it is still a commit', () => {
  assert.equal(isCommitCommand('echo --help & git commit -m x'), true);
  assert.equal(isCommitCommand('git commit -m x &'), true);
  assert.equal(isCommitCommand('sleep 1 & git status'), false);
});

test('Given a parenthesized subshell commit, When it is classified, Then it is a commit', () => {
  assert.equal(isCommitCommand('(git commit -m change)'), true);
  assert.equal(isCommitCommand('( cd repo && git commit -m x )'), true);
  assert.equal(isCommitCommand('(git status)'), false);
});

test('Given a commit that bypasses the git hook, When it is classified, Then the host guard still reviews it', () => {
  assert.equal(isCommitCommand('git commit --no-verify -m x'), true);
  assert.equal(isCommitCommand('git commit -n -m x'), true);
});

test('Given a commit in process substitution, When it is classified, Then it is a commit', () => {
  assert.equal(isCommitCommand('echo <(git commit -m x)'), true);
  assert.equal(isCommitCommand('cat >(git commit -F -)'), true);
});

test('Given a commit that passes -h as a path after --, When it is classified, Then it is still a commit', () => {
  assert.equal(isCommitCommand('git commit -- -h'), true);
  assert.equal(asksForHelp('git commit -- -h'), false);
  assert.equal(isCommitCommand('git commit --help -- -h'), false, 'a real help request before -- still wins');
});
