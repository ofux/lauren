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

/**
 * Subset of `paths` that have uncommitted changes (staged, unstaged, or
 * untracked) in the working tree at `cwd`. Used to recheck a 'merge_blocked'
 * pause: if none of the files git originally refused on are dirty anymore,
 * the merge can resume.
 */
export function dirtyPaths(cwd: string, paths: readonly string[]): string[] {
  if (paths.length === 0) return [];
  const r = runSync(['git', 'status', '--porcelain', '--', ...paths], cwd);
  if (r.code !== 0) {
    throw new Error(`git status --porcelain exited ${r.code}: ${r.stderr.trim()}`);
  }
  const dirty: string[] = [];
  for (const raw of r.stdout.split('\n')) {
    if (raw.length < 4) continue;
    // Porcelain v1 line: `XY path` (renames use `XY orig -> new`).
    const path = raw.slice(3);
    const renamed = path.split(' -> ');
    dirty.push(renamed[renamed.length - 1]!);
  }
  return dirty;
}

export function hasUnresolvedMergeConflicts(cwd: string = REPO): boolean {
  const r = runSync(['git', 'diff', '--name-only', '--diff-filter=U', ...WORKTREE_PATHSPECS], cwd);
  if (r.code !== 0) {
    throw new Error(`git diff --name-only --diff-filter=U exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.trim().length > 0;
}

/**
 * Paths that are currently in unmerged state (conflict markers from a
 * mid-flight merge). Captured right after `git merge` returns conflicts
 * so the merger can stage only those paths after the conflict resolver
 * runs — avoiding the bug where `git add -A` would sweep in unrelated
 * WIP from the parent checkout (now allowed at merge time by option A).
 */
export function listUnresolvedConflicts(cwd: string = REPO): string[] {
  const r = runSync(['git', 'diff', '--name-only', '--diff-filter=U', ...WORKTREE_PATHSPECS], cwd);
  if (r.code !== 0) {
    throw new Error(`git diff --name-only --diff-filter=U exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.split('\n').filter((l) => l.length > 0);
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
  const r = runSync(
    ['git', '-c', 'advice.addIgnoredFile=false', 'add', '-A', ...WORKTREE_PATHSPECS],
    cwd,
  );
  if (r.code === 0) return;
  // Quirk: when a path is excluded by .gitignore AND is also covered by our
  // `:(exclude).lauren` pathspec, git still exits 1 just because the positive
  // pathspec `.` matched it. The file is not actually staged — the exclude
  // does its job — so swallow this specific case.
  if (r.code === 1 && /paths are ignored by one of your \.gitignore files/.test(r.stderr)) {
    return;
  }
  throw new Error(`git add -A exited ${r.code}: ${r.stderr.trim()}`);
}

/**
 * Stage the named paths only — no `-A`, no path expansion beyond the
 * explicit list. Used by the merge conflict resolver to commit *only*
 * the files that started in conflict, leaving any unrelated WIP in the
 * working tree unstaged.
 */
export function gitAddPaths(cwd: string, paths: readonly string[]): void {
  if (paths.length === 0) return;
  const r = runSync(['git', 'add', '--', ...paths], cwd);
  if (r.code !== 0) {
    throw new Error(`git add -- exited ${r.code}: ${r.stderr.trim()}`);
  }
}

export function getCurrentBranch(cwd: string = REPO): string {
  // symbolic-ref returns the branch name on an unborn branch (fresh `git init`
  // with no commits yet), where `rev-parse --abbrev-ref HEAD` fails with
  // "ambiguous argument 'HEAD'". Fall back to rev-parse only for detached HEAD,
  // where symbolic-ref doesn't work and rev-parse returns the literal 'HEAD'.
  const sym = runSync(['git', 'symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  if (sym.code === 0) return sym.stdout.trim();
  const r = runSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (r.code !== 0) {
    throw new Error(`git rev-parse --abbrev-ref HEAD exited ${r.code}: ${r.stderr.trim()}`);
  }
  return r.stdout.trim();
}

/**
 * True iff `cwd` is a git repo with at least one commit (HEAD resolves).
 * Returns false on an unborn branch (`git init` with no commits yet);
 * callers that need to distinguish "not a git repo" from "no commits"
 * should validate the `.git` entry separately.
 */
export function hasAnyCommits(cwd: string = REPO): boolean {
  const r = runSync(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], cwd);
  return r.code === 0;
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
    const err = new Error(`git checkout ${branch} exited ${r.code}: ${r.stderr.trim()}`);
    // Preserve the raw stderr so callers can parse "would be overwritten"
    // refusals without re-parsing the wrapped message.
    (err as Error & { gitStderr?: string }).gitStderr = r.stderr;
    throw err;
  }
}

/**
 * Parse the stderr of a git merge/checkout/fast-forward that was refused
 * because it would clobber uncommitted work, and return the file list git
 * named. Covers both variants:
 *   - "Your local changes to the following files would be overwritten by ..."
 *   - "The following untracked working tree files would be overwritten by ..."
 * Returns null if the text doesn't match either pattern.
 *
 * This is the load-bearing detection for the auto-merge "merge_blocked"
 * pause: when git itself refuses on dirt overlap (the precise, narrow
 * condition we care about), the caller transitions the plan to
 * 'merge_blocked' with these files captured for both the TUI banner and
 * the auto-resume check.
 */
export function parseDirtyMergeRefusal(text: string): { files: string[] } | null {
  const marker =
    /(?:Your local changes to the following files|The following untracked working tree files) would be overwritten by (?:merge|checkout):/;
  const match = marker.exec(text);
  if (!match) return null;
  const after = text.slice(match.index + match[0].length);
  const files: string[] = [];
  for (const raw of after.split('\n')) {
    const fileMatch = /^(?:\t| {2,})(\S.*)$/.exec(raw);
    if (fileMatch) {
      files.push(fileMatch[1]!.trim());
    } else if (files.length > 0) {
      break;
    }
  }
  return { files };
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
