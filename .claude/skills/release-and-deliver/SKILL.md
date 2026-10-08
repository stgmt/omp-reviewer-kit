---
name: release-and-deliver
description: Use when releasing omp-reviewer-kit, or when asked to release, tag, publish, reinstall the plugin everywhere, heal the registered repositories, or deliver the kit to a repository such as tokenplan. Lists the whole chain in order (versions, tests, commit through the review hook, pull request and CI, merge, annotated tag, release workflow, OMP and Claude Code plugin update, registry heal, tokenplan delivery, checks) with the commands and the rules that must not be broken.
---

# Release and deliver omp-reviewer-kit

Run the steps in order. Each step says what must be true before the next one starts. When the user has asked for the release, do not stop between steps to ask; report what each step produced.

## 0. Versions agree

Before a release, these show the same version X.Y.Z:

- `package.json`: `version` and `omp.version`
- `.omp-plugin/marketplace.json`: `plugins[0].version`
- `claude-plugin/.claude-plugin/plugin.json`: `version`
- `CHANGELOG.md`: heading `## [X.Y.Z] - date`

`npm run check` fails on a hook marker that does not match its body. `release.yml` fails on any version mismatch.

## 1. Tests before the commit

Run them in a clean export of the index, not in the working tree (test runs write audit files there):

- Export: `git -c core.autocrlf=false checkout-index -a --prefix=<empty-dir>/`, then `git -C <empty-dir> init`.
- In the export: `npm test`, `npm run check`, and `npm run test:mutation` (about 30 minutes; it must report 100% killed).

## 2. Commit through the review hook

- Stage explicit paths only. Never `git add -A`.
- Restore the review badges before committing: `git checkout -- audit-reports/review-badge.full.json audit-reports/review-badge.json`. They are never committed.
- Commit detached, with a log, and do not touch the index while the hook runs:
  `nohup git commit -F <message-file> > <log> 2>&1; echo "commit exit=$?" >> <log>`
- Never use `--no-verify`.
- The message ends with `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`.
- A block that says "infrastructure failure" means OMP could not get an answer from its default model role. Report it. Do not edit `~/.omp/agent/config.yml` and do not commit around the hook.

## 3. Push and pull request

- `git push -u origin <branch>` always names the remote and the branch. The branch's upstream may point at `origin/main`.
- `gh pr create --base main --head <branch> --title <title> --body-file <file>`. The body ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Bind the PR with the `ccd_pr` tools: `get_status`, then `bind_pr` if it is not bound. Read its CI once. Do not poll CI: no loops, no `gh run watch`, no scheduled checks. Do not enable auto-merge.
- Give the user the full PR URL.

## 4. Merge and tag

- Merge only when the user has asked for the release and CI is green: `gh pr merge <n> --merge` (main keeps merge commits).
- Create an annotated tag on the merge commit on main, then push it:
  `git fetch origin && git tag -a vX.Y.Z -m "omp-reviewer-kit X.Y.Z" origin/main && git push origin vX.Y.Z`
  `release.yml` rejects lightweight tags and tags that point at another commit.

## 5. Publish the release

- `gh workflow run release.yml -f tag=vX.Y.Z`, then one read of `gh run list --workflow release.yml --limit 1`. The workflow verifies the tag, the versions, the layout and the tests, then publishes.

## 6. Reinstall the plugins everywhere (user scope)

- OMP: `omp plugin install github:stgmt/omp-reviewer-kit --force` (try `--dry-run` first). Check with `omp plugin list`: `omp-reviewer-kit` must show X.Y.Z. The marketplace entry `omp-reviewer-kit` points at the local checkout `E:\repos\omp-reviewer-kit`, so install from GitHub, not from that path.
- Claude Code: `claude plugin marketplace update omp-reviewer-kit`, then `claude plugin update omp-reviewer-kit@omp-reviewer-kit`. The update applies after Claude Code restarts; tell the user. Check with `claude plugin list`.
- The review algorithm (`scripts/run-review.mjs`) comes only from the installed plugin, so this step is what updates the review in every repository. Repositories' vendored runner is the thin stub, which does not change between releases.

## 7. Heal the registered repositories

- `node scripts/sync-targets.mjs` (dry run), read the list, then `node scripts/sync-targets.mjs --apply`.
- It rewrites only the two vendored files (`.omp/review-kit/run-review.mjs` and `.githooks/pre-commit`), and only where they are older. The runner it writes is the thin stub, so a repository that tracks it commits the stub, not the algorithm. It never commits in another repository; their owners commit through their own hooks.
- Check with `node claude-plugin/scripts/bridge.mjs doctor`: no registered repository may be stale.

## 8. Deliver to tokenplan (`E:\repos\tokenplan`)

- Its local agents get the kit from the user-scope plugins (step 6) and from the vendored pair (step 7).
- Commit only the vendored pair, with explicit paths: `git -C E:/repos/tokenplan add -- .omp/review-kit/run-review.mjs .githooks/pre-commit`, then commit through its hook. Never add `.claude/agents/omp-runner.md`, its untracked files, or any other change that belongs to the user.
- Check: `git -C E:/repos/tokenplan show --stat HEAD` lists only those two paths, and `cmp` of the vendored runner against the installed plugin's `templates/review-kit/run-review.mjs` is equal.

## Never

- Touch `tp-*` repositories or the `omp-reviewer-kit-release` checkout.
- Enable auto-merge, or poll CI.
- Edit `~/.omp/agent/config.yml`; model choices belong to the user.
- Commit or push in another repository beyond the vendored pair in step 8.
