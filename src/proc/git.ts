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
    return subject.startsWith(`${slug}: PR `) || subject.startsWith(`${slug}: Plan `);
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
