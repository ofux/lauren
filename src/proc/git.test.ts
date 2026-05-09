import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  gitAddAll,
  gitCommit,
  revertWorkingTree,
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

  test('revertWorkingTree discards non-lauren changes without treating -- as a pathspec', async () => {
    await fs.mkdir(path.join(repoDir, '.lauren'), { recursive: true });
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'changed\n', 'utf8');
    await fs.writeFile(path.join(repoDir, 'feature.txt'), 'feature\n', 'utf8');
    await fs.writeFile(path.join(repoDir, '.lauren', 'plans.json'), '{}\n', 'utf8');

    revertWorkingTree(repoDir);

    await expect(fs.readFile(path.join(repoDir, 'tracked.txt'), 'utf8')).resolves.toBe('initial\n');
    await expect(fs.access(path.join(repoDir, 'feature.txt'))).rejects.toThrow();
    await expect(fs.readFile(path.join(repoDir, '.lauren', 'plans.json'), 'utf8')).resolves.toBe(
      '{}\n',
    );
  });

  test('slugHasLaurenHistory detects prior PR and plan commits for a slug', () => {
    expect(slugHasLaurenHistory('feature-x', repoDir)).toBe(false);

    git(repoDir, 'commit', '--allow-empty', '-m', 'feature-x: PR 1.1 — First');
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
