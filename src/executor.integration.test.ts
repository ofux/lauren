import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Plan } from './core/types.js';
import { alreadyDone } from './executor.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
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

function commit(cwd: string, subject: string): void {
  git(cwd, 'commit', '--allow-empty', '-m', subject);
}

function makePlan(slug: string): Plan {
  return {
    slug,
    title: `${slug} title`,
    path: `.lauren/plans/${slug}.md`,
    status: 'pending',
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
  };
}

describe('alreadyDone() — real git integration', () => {
  let repoDir: string;

  beforeEach(async () => {
    repoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-git-'));
    git(repoDir, 'init', '-q', '-b', 'main');
  });

  afterEach(async () => {
    await fs.rm(repoDir, { recursive: true, force: true });
  });

  test('repo with no matching commits returns an empty set', () => {
    commit(repoDir, 'initial');
    commit(repoDir, 'unrelated work');
    expect(alreadyDone(makePlan('feature-x'), repoDir).size).toBe(0);
  });

  test('matching PR commits are picked up', () => {
    commit(repoDir, 'feature-x: PR 1.1 — First');
    commit(repoDir, 'feature-x: PR 1.2 — Second');
    commit(repoDir, 'unrelated commit');
    expect(alreadyDone(makePlan('feature-x'), repoDir)).toEqual(new Set(['1.1', '1.2']));
  });

  test('commits for a different slug are not matched', () => {
    commit(repoDir, 'other-slug: PR 1.1 — X');
    commit(repoDir, 'other-slug: PR 2.3 — Y');
    expect(alreadyDone(makePlan('feature-x'), repoDir).size).toBe(0);
  });

  test('regex specials in slug are escaped — siblings do not collide', () => {
    commit(repoDir, 'featXxXy: PR 1.1 — A');
    commit(repoDir, 'feat.x+y: PR 1.2 — B');
    expect(alreadyDone(makePlan('feat.x+y'), repoDir)).toEqual(new Set(['1.2']));
  });

  test('a Plan: <title> commit is not matched as a PR', () => {
    commit(repoDir, 'Plan: a single-unit plan');
    expect(alreadyDone(makePlan('a-single-unit-plan'), repoDir).size).toBe(0);
  });
});
