import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { ensureInitialCommit } from './init-repo.js';

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

describe('ensureInitialCommit', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-init-repo-'));
    git(repoDir, 'init', '-q', '-b', 'main');
    git(repoDir, 'config', 'user.email', 'test@example.com');
    git(repoDir, 'config', 'user.name', 'Test');
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test('creates an initial commit with .gitignore on an unborn branch', async () => {
    const created = await ensureInitialCommit(repoDir);

    expect(created).toBe(true);
    expect(git(repoDir, 'log', '-1', '--pretty=%s').trim()).toBe('Initial commit');
    expect(git(repoDir, 'ls-tree', '--name-only', 'HEAD').split('\n').filter(Boolean)).toEqual([
      '.gitignore',
    ]);
    expect(await fs.readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe('.lauren/\n');
  });

  test('appends .lauren/ to an existing .gitignore that is missing the entry', async () => {
    await fs.writeFile(path.join(repoDir, '.gitignore'), 'node_modules\n', 'utf8');

    const created = await ensureInitialCommit(repoDir);

    expect(created).toBe(true);
    expect(await fs.readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.lauren/\n',
    );
  });

  test('adds a trailing newline before appending when the file lacks one', async () => {
    await fs.writeFile(path.join(repoDir, '.gitignore'), 'node_modules', 'utf8');

    await ensureInitialCommit(repoDir);

    expect(await fs.readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.lauren/\n',
    );
  });

  test('does not duplicate .lauren/ when the entry is already present', async () => {
    await fs.writeFile(path.join(repoDir, '.gitignore'), 'node_modules\n.lauren/\n', 'utf8');

    const created = await ensureInitialCommit(repoDir);

    expect(created).toBe(true);
    expect(await fs.readFile(path.join(repoDir, '.gitignore'), 'utf8')).toBe(
      'node_modules\n.lauren/\n',
    );
    expect(git(repoDir, 'ls-tree', '--name-only', 'HEAD').split('\n').filter(Boolean)).toEqual([
      '.gitignore',
    ]);
  });

  test('leaves untracked working-tree files alone', async () => {
    await fs.writeFile(path.join(repoDir, 'untracked.txt'), 'wip\n', 'utf8');

    await ensureInitialCommit(repoDir);

    expect(git(repoDir, 'ls-tree', '--name-only', 'HEAD').split('\n').filter(Boolean)).toEqual([
      '.gitignore',
    ]);
    expect(git(repoDir, 'status', '--porcelain')).toContain('?? untracked.txt');
  });

  test('is a no-op when the repo already has commits', async () => {
    await fs.writeFile(path.join(repoDir, 'tracked.txt'), 'initial\n', 'utf8');
    git(repoDir, 'add', 'tracked.txt');
    git(repoDir, 'commit', '-m', 'first');

    const created = await ensureInitialCommit(repoDir);

    expect(created).toBe(false);
    expect(git(repoDir, 'log', '--pretty=%s').trim()).toBe('first');
    // Did not write a .gitignore that wasn't already there.
    await expect(fs.readFile(path.join(repoDir, '.gitignore'), 'utf8')).rejects.toThrow();
  });
});
