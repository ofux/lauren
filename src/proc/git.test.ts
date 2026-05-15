import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  gitAddAll,
  gitAddPaths,
  gitBranchHasDiff,
  gitCommit,
  hasUnresolvedMergeConflicts,
  listUnresolvedConflicts,
  parseDirtyMergeRefusal,
  slugHasLaurenHistory,
  workingTreeDirty,
} from './git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('git worktree helpers', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-git-'));
    git(repoDir, 'init', '-q', '-b', 'main');
    // Local identity so commits made via the production gitCommit() helper
    // (which doesn't inject GIT_AUTHOR_* env vars) still succeed on CI
    // runners that lack a global user.name / user.email.
    git(repoDir, 'config', 'user.email', 'test@example.com');
    git(repoDir, 'config', 'user.name', 'Test');
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'initial\n', 'utf8');
    git(repoDir, 'add', 'tracked.txt');
    git(repoDir, 'commit', '-m', 'initial');
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test('workingTreeDirty ignores lauren artifacts', async () => {
    await fs.mkdir(path.join(repoDir, '.lauren', 'logs'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.lauren', 'plans.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.lauren', 'logs', 'run.log'), 'log\n', 'utf8');

    expect(workingTreeDirty(repoDir)).toBe(false);
  });

  test('workingTreeDirty still detects non-lauren changes', async () => {
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');

    expect(workingTreeDirty(repoDir)).toBe(true);
  });

  test('gitAddAll does not stage lauren artifacts', async () => {
    await fs.mkdir(path.join(repoDir, '.lauren'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.lauren', 'plans.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'feature.txt'), 'feature\n', 'utf8');

    gitAddAll(repoDir);

    expect(git(repoDir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)).toEqual([
      'feature.txt',
    ]);
  });

  test('gitAddAll succeeds when .lauren is also gitignored', async () => {
    // Regression: with `.lauren/` in .gitignore AND present in the worktree,
    // `git add -A . :(exclude).lauren` exits 1 with "paths are ignored …"
    // even though the exclude prevents staging. Must be tolerated.
    await fs.writeFile(path.join(repoDir, '.gitignore'), '.lauren\n', 'utf8');
    git(repoDir, 'add', '.gitignore');
    git(repoDir, 'commit', '-m', 'ignore lauren');

    await fs.mkdir(path.join(repoDir, '.lauren'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.lauren', 'plans.json'), '{}\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'feature.txt'), 'feature\n', 'utf8');

    gitAddAll(repoDir);

    expect(git(repoDir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean)).toEqual([
      'feature.txt',
    ]);
  });

  test('gitAddPaths only stages the listed paths, leaving other WIP unstaged', async () => {
    await fs.writeFile(path.join(repoDir, 'a.txt'), 'a\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'b.txt'), 'b\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'unrelated.txt'), 'wip\n', 'utf8');

    gitAddPaths(repoDir, ['a.txt', 'b.txt']);

    const staged = git(repoDir, 'diff', '--cached', '--name-only').split('\n').filter(Boolean);
    expect(staged.sort()).toEqual(['a.txt', 'b.txt']);
    // unrelated.txt is still untracked / unstaged
    expect(git(repoDir, 'status', '--porcelain')).toContain('?? unrelated.txt');
  });

  test('listUnresolvedConflicts returns paths in unmerged state after a real conflicted merge', async () => {
    // Set up two divergent branches that touch the same line of the same file.
    await fs.writeFile(path.join(repoDir, 'conflict.txt'), 'base\n', 'utf8');
    git(repoDir, 'add', 'conflict.txt');
    git(repoDir, 'commit', '-m', 'base');

    git(repoDir, 'checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(repoDir, 'conflict.txt'), 'feature change\n', 'utf8');
    git(repoDir, 'add', 'conflict.txt');
    git(repoDir, 'commit', '-m', 'feature');

    git(repoDir, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(repoDir, 'conflict.txt'), 'main change\n', 'utf8');
    git(repoDir, 'add', 'conflict.txt');
    git(repoDir, 'commit', '-m', 'main');

    // Attempt the merge; git will leave the tree in conflict (non-zero exit).
    try {
      git(repoDir, 'merge', '--no-edit', 'feature');
    } catch {
      /* expected — merge conflicts */
    }

    expect(listUnresolvedConflicts(repoDir)).toEqual(['conflict.txt']);
    expect(hasUnresolvedMergeConflicts(repoDir)).toBe(true);

    // Resolving + staging clears the unmerged status.
    await fs.writeFile(path.join(repoDir, 'conflict.txt'), 'resolved\n', 'utf8');
    gitAddPaths(repoDir, ['conflict.txt']);
    expect(listUnresolvedConflicts(repoDir)).toEqual([]);
  });

  test('gitBranchHasDiff ignores lauren artifacts when comparing with base branch', async () => {
    git(repoDir, 'checkout', '-q', '-b', 'lauren/demo');
    await fs.mkdir(path.join(repoDir, '.lauren'), { recursive: true });
    await fs.writeFile(path.join(repoDir, '.lauren', 'plans.json'), '{}\n', 'utf8');
    git(repoDir, 'add', '.lauren/plans.json');
    git(repoDir, 'commit', '-m', 'lauren artifact');

    expect(gitBranchHasDiff({ cwd: repoDir, base: 'main' })).toBe(false);

    await fs.writeFile(path.join(repoDir, 'feature.txt'), 'feature\n', 'utf8');
    gitAddAll(repoDir);
    git(repoDir, 'commit', '-m', 'feature');

    expect(gitBranchHasDiff({ cwd: repoDir, base: 'main' })).toBe(true);
  });

  test('hasUnresolvedMergeConflicts ignores staged conflict resolutions', async () => {
    git(repoDir, 'checkout', '-q', '-b', 'feature');
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'feature\n', 'utf8');
    git(repoDir, 'add', 'tracked.txt');
    git(repoDir, 'commit', '-m', 'feature edit');

    git(repoDir, 'checkout', '-q', 'main');
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'main\n', 'utf8');
    git(repoDir, 'add', 'tracked.txt');
    git(repoDir, 'commit', '-m', 'main edit');

    expect(() => git(repoDir, 'merge', 'feature')).toThrow();
    expect(hasUnresolvedMergeConflicts(repoDir)).toBe(true);

    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'resolved\n', 'utf8');
    gitAddAll(repoDir);

    expect(workingTreeDirty(repoDir)).toBe(true);
    expect(hasUnresolvedMergeConflicts(repoDir)).toBe(false);
  });

  test('slugHasLaurenHistory detects prior Step and plan commits for a slug', () => {
    expect(slugHasLaurenHistory('feature-x', repoDir)).toBe(false);

    git(repoDir, 'commit', '--allow-empty', '-m', 'feature-x: Step 1.1 — First');
    expect(slugHasLaurenHistory('feature-x', repoDir)).toBe(true);
    expect(slugHasLaurenHistory('other-slug', repoDir)).toBe(false);

    git(repoDir, 'commit', '--allow-empty', '-m', 'single-plan: Plan — Single unit');
    expect(slugHasLaurenHistory('single-plan', repoDir)).toBe(true);
  });

  test('gitCommit honors cwd and captures output', async () => {
    await fs.writeFile(path.join(repoDir, 'feature.txt'), 'feature\n', 'utf8');
    gitAddAll(repoDir);

    const result = gitCommit('feature commit', { capture: true, cwd: repoDir });

    expect(result.code).toBe(0);
    expect(git(repoDir, 'log', '-1', '--pretty=%s').trim()).toBe('feature commit');
  });
});

describe('parseDirtyMergeRefusal', () => {
  test('extracts files from "local changes would be overwritten by merge"', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '\tsrc/app.ts\n' +
      '\tsrc/lib/util.ts\n' +
      'Please commit your changes or stash them before you merge.\n' +
      'Aborting\n';

    expect(parseDirtyMergeRefusal(stderr)).toEqual({
      files: ['src/app.ts', 'src/lib/util.ts'],
    });
  });

  test('handles the "untracked working tree files" variant', () => {
    const stderr =
      'error: The following untracked working tree files would be overwritten by merge:\n' +
      '\tnewfile.txt\n' +
      'Please move or remove them before you merge.\n' +
      'Aborting\n';

    expect(parseDirtyMergeRefusal(stderr)).toEqual({ files: ['newfile.txt'] });
  });

  test('extracts files from space-indented staged-change refusals', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by merge:\n' +
      '  b\n' +
      'Merge with strategy ort failed.\n';

    expect(parseDirtyMergeRefusal(stderr)).toEqual({ files: ['b'] });
  });

  test('matches the checkout variant as well', () => {
    const stderr =
      'error: Your local changes to the following files would be overwritten by checkout:\n' +
      '\tREADME.md\n' +
      'Please commit your changes or stash them before you switch branches.\n' +
      'Aborting\n';

    expect(parseDirtyMergeRefusal(stderr)).toEqual({ files: ['README.md'] });
  });

  test('returns null on unrelated git stderr', () => {
    expect(parseDirtyMergeRefusal('fatal: refusing to merge unrelated histories')).toBeNull();
    expect(parseDirtyMergeRefusal('')).toBeNull();
  });

  test('returns null for a plain merge-conflict error (different code path)', () => {
    expect(
      parseDirtyMergeRefusal('Automatic merge failed; fix conflicts and then commit the result.'),
    ).toBeNull();
  });
});
