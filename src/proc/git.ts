import { spawnSync } from 'node:child_process';

import { REPO } from '../core/paths.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const WORKTREE_PATHSPECS = ['--', '.', ':(exclude).lauren'] as const;

function runSync(cmd: string[], cwd: string = REPO): RunResult {
  const [program, ...args] = cmd;
  if (!program) throw new Error('empty git command');
  const r = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function workingTreeDirty(cwd: string = REPO): boolean {
  const r = runSync(['git', 'status', '--porcelain', ...WORKTREE_PATHSPECS], cwd);
  if (r.code !== 0) {
    throw new Error(`git status --porcelain exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.trim().length > 0;
}

export function hasUnresolvedMergeConflicts(cwd: string = REPO): boolean {
  const r = runSync(['git', 'diff', '--name-only', '--diff-filter=U', ...WORKTREE_PATHSPECS], cwd);
  if (r.code !== 0) {
    throw new Error(`git diff --name-only --diff-filter=U exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.trim().length > 0;
}

export function gitLogSubjects(cwd: string = REPO): string[] {
  const r = runSync(['git', 'log', '--pretty=%s'], cwd);
  if (r.code !== 0) {
    if (r.stderr.includes('does not have any commits yet')) {
      return [];
    }
    throw new Error(`git log --pretty=%s exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.split('\n').filter((l) => l.length > 0);
}

export function slugHasLaurenHistory(slug: string, cwd: string = REPO): boolean {
  let subjects: string[];
  try {
    subjects = gitLogSubjects(cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not a git repository')) return false;
    throw err;
  }
  return subjects.some((subject) => {
    return subject.startsWith(`${slug}: Step `) || subject.startsWith(`${slug}: Plan `);
  });
}

export function gitAddAll(cwd: string = REPO): void {
  const r = runSync(['git', 'add', '-A', ...WORKTREE_PATHSPECS], cwd);
  if (r.code !== 0) {
    throw new Error(`git add -A exited ${r.code}: ${r.stderr.trim()}`);
  }
}

/**
 * Drop uncommitted changes in the working tree (excluding `.lauren/` so
 * we don't blow away log files mid-cancellation). Used when a plan is
 * cancelled while implementing — vibe must revert the partial work
 * before marking the plan as cancelled.
 *
 * Two steps: `git checkout -- <pathspecs>` to discard tracked changes,
 * then `git clean -fd <pathspecs>` to remove untracked files.
 */
export function revertWorkingTree(cwd: string = REPO): void {
  const checkout = runSync(['git', 'checkout', ...WORKTREE_PATHSPECS], cwd);
  if (checkout.code !== 0) {
    throw new Error(`git checkout -- exited ${checkout.code}: ${checkout.stderr.trim()}`);
  }
  const clean = runSync(['git', 'clean', '-fd', ...WORKTREE_PATHSPECS], cwd);
  if (clean.code !== 0) {
    throw new Error(`git clean -fd exited ${clean.code}: ${clean.stderr.trim()}`);
  }
}

export function getCurrentBranch(cwd: string = REPO): string {
  const r = runSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (r.code !== 0) {
    throw new Error(`git rev-parse --abbrev-ref HEAD exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

export function gitBranchExists(branch: string, cwd: string = REPO): boolean {
  const r = runSync(['git', 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], cwd);
  return r.code === 0;
}

export function gitBranchHasDiff(args: { cwd: string; base: string }): boolean {
  const r = runSync(
    ['git', 'diff', '--quiet', `${args.base}...HEAD`, ...WORKTREE_PATHSPECS],
    args.cwd,
  );
  if (r.code === 0) return false;
  if (r.code === 1) return true;
  throw new Error(`git diff ${args.base}...HEAD exited ${r.code}: ${r.stderr.trim()}`);
}

/**
 * Create a worktree at `worktreePath`. When `branch` does not yet exist,
 * a new branch is created from `baseBranch`; when it already exists (e.g.
 * from a prior failed run), the worktree checks out that branch as-is.
 */
export function gitWorktreeAdd(args: {
  repoRoot: string;
  worktreePath: string;
  branch: string;
  baseBranch: string;
}): void {
  const { repoRoot, worktreePath, branch, baseBranch } = args;
  const cmd = gitBranchExists(branch, repoRoot)
    ? ['git', 'worktree', 'add', worktreePath, branch]
    : ['git', 'worktree', 'add', '-b', branch, worktreePath, baseBranch];
  const r = runSync(cmd, repoRoot);
  if (r.code !== 0) {
    throw new Error(`git worktree add exited ${r.code}: ${r.stderr.trim()}`);
  }
}

/**
 * Remove a worktree (force, to discard any uncommitted state) and prune
 * stale administrative entries. Safe to call even when the worktree
 * directory or branch ref is already gone.
 */
export function gitWorktreeRemove(args: { repoRoot: string; worktreePath: string }): void {
  const { repoRoot, worktreePath } = args;
  const r = runSync(['git', 'worktree', 'remove', '--force', worktreePath], repoRoot);
  if (r.code !== 0 && !/not a working tree|No such file/i.test(r.stderr)) {
    throw new Error(`git worktree remove exited ${r.code}: ${r.stderr.trim()}`);
  }
  // Even when remove succeeded, prune in case earlier crashes left dangling
  // worktree metadata. Failures here are non-fatal.
  runSync(['git', 'worktree', 'prune'], repoRoot);
}

export function gitDeleteBranch(branch: string, cwd: string = REPO): void {
  const r = runSync(['git', 'branch', '-D', branch], cwd);
  if (r.code !== 0 && !r.stderr.includes('not found')) {
    throw new Error(`git branch -D ${branch} exited ${r.code}: ${r.stderr.trim()}`);
  }
}

export interface GitMergeResult {
  code: number;
  stdout: string;
  stderr: string;
  hasConflicts: boolean;
}

/**
 * Run `git merge --no-ff <branch>` in `cwd`. Returns the merge result;
 * inspect `hasConflicts` to decide whether to launch claude conflict
 * resolution. Stdio is captured so the TUI stays clean.
 */
export function gitMerge(branch: string, cwd: string = REPO): GitMergeResult {
  const r = runSync(['git', 'merge', '--no-ff', '--no-edit', branch], cwd);
  const combined = `${r.stdout}\n${r.stderr}`;
  const hasConflicts =
    r.code !== 0 && (/conflict/i.test(combined) || /automatic merge failed/i.test(combined));
  return { ...r, hasConflicts };
}

export function gitFetchBranch(args: { cwd: string; branch: string; remote?: string }): RunResult {
  const remote = args.remote ?? 'origin';
  return runSync(['git', 'fetch', remote, args.branch], args.cwd);
}

export function gitFastForward(ref: string, cwd: string = REPO): RunResult {
  return runSync(['git', 'merge', '--ff-only', ref], cwd);
}

export function gitMergeContinue(cwd: string = REPO): RunResult {
  return runSync(['git', 'commit', '--no-edit'], cwd);
}

export function gitMergeAbort(cwd: string = REPO): RunResult {
  return runSync(['git', 'merge', '--abort'], cwd);
}

export function gitCheckout(branch: string, cwd: string = REPO): void {
  const r = runSync(['git', 'checkout', branch], cwd);
  if (r.code !== 0) {
    throw new Error(`git checkout ${branch} exited ${r.code}: ${r.stderr.trim()}`);
  }
}

export interface GitPushResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function gitPush(args: {
  cwd: string;
  branch: string;
  remote?: string;
  setUpstream?: boolean;
}): GitPushResult {
  const remote = args.remote ?? 'origin';
  const cmd = ['git', 'push'];
  if (args.setUpstream !== false) cmd.push('-u');
  cmd.push(remote, args.branch);
  return runSync(cmd, args.cwd);
}

export interface GitCommitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run `git commit -m <message>`. When `capture` is true, stdio is captured
 * (used by the live TUI to keep its display clean and to extract a tail
 * line for failure messages). When false, stdio inherits and output goes
 * straight to the parent terminal (used by `lauren vibe --dry-run` style flows).
 */
export function gitCommit(
  message: string,
  opts: { capture: boolean; cwd?: string } = { capture: true },
): GitCommitResult {
  const cwd = opts.cwd ?? REPO;
  if (opts.capture) {
    return runSync(['git', 'commit', '-m', message], cwd);
  }
  // We need to inherit stdio but still get an exit code synchronously —
  // spawnSync with stdio: 'inherit' does both.
  const r = spawnSync('git', ['commit', '-m', message], {
    cwd,
    stdio: 'inherit',
  });
  if (r.error) throw r.error;
  return { code: r.status ?? 1, stdout: '', stderr: '' };
}
