import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Plan } from './core/types.js';
import {
  alreadyDone,
  alreadyDoneInRepos,
  singleUnitDone,
  singleUnitDoneInRepos,
} from './executor.js';
import { planCommitMessage } from './executor-prompts.js';

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
    target_repos: [],
    status: 'ready',
    cancel_requested: false,
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

  test('repo with no commits returns an empty set', () => {
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

  test('single-unit commits are detected by slugged subject', () => {
    const plan = makePlan('single-plan');
    commit(repoDir, planCommitMessage(plan));
    expect(singleUnitDone(plan, repoDir)).toBe(true);
  });

  test('legacy single-unit commits are still detected by title', () => {
    const plan = makePlan('single-plan');
    commit(repoDir, `Plan: ${plan.title}`);
    expect(singleUnitDone(plan, repoDir)).toBe(true);
  });

  test('multi-repo PR resume treats an id as done if any target repo has it', async () => {
    const firstRepo = repoDir;
    const secondRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-git-peer-'));
    try {
      git(secondRepo, 'init', '-q', '-b', 'main');
      const repos = [
        { name: 'first', path: 'first', root: firstRepo },
        { name: 'second', path: 'second', root: secondRepo },
      ];
      expect(alreadyDoneInRepos(makePlan('feature-x'), repos)).toEqual(new Set());

      commit(firstRepo, 'feature-x: PR 1.1 — First');
      expect(alreadyDoneInRepos(makePlan('feature-x'), repos)).toEqual(new Set(['1.1']));

      commit(secondRepo, 'feature-x: PR 1.2 — Second');
      expect(alreadyDoneInRepos(makePlan('feature-x'), repos)).toEqual(new Set(['1.1', '1.2']));
    } finally {
      await fs.rm(secondRepo, { recursive: true, force: true });
    }
  });

  test('multi-repo single-unit resume succeeds when any target repo has the marker', async () => {
    const plan = makePlan('single-plan');
    const firstRepo = repoDir;
    const secondRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'lauren-git-peer-'));
    try {
      git(secondRepo, 'init', '-q', '-b', 'main');
      const repos = [
        { name: 'first', path: 'first', root: firstRepo },
        { name: 'second', path: 'second', root: secondRepo },
      ];
      expect(singleUnitDoneInRepos(plan, repos)).toBe(false);

      commit(firstRepo, planCommitMessage(plan));
      expect(singleUnitDoneInRepos(plan, repos)).toBe(true);
    } finally {
      await fs.rm(secondRepo, { recursive: true, force: true });
    }
  });
});
