import { describe, expect, test } from 'vitest';
import { formatCommitFailureMessage, RunFailure } from './executor.js';
import { planCommitMessage } from './executor-prompts.js';

describe('formatCommitFailureMessage', () => {
  const baseArgs = {
    repoName: 'backend',
    repoPath: 'apps/backend',
    commitSubject: 'feat-x: PR 1.2 — Add foo',
    slug: 'feat-x',
    exitCode: 1,
    gitTail: 'pre-commit hook failed',
  };

  test('names the repo, quotes the commit subject, and references the slug for retry', () => {
    const msg = formatCommitFailureMessage(baseArgs);
    expect(msg).toContain("repo 'backend' (apps/backend)");
    expect(msg).toContain('feat-x: PR 1.2 — Add foo');
    expect(msg).toContain('lauren vibe retry feat-x');
  });

  test('includes the git tail when present', () => {
    const msg = formatCommitFailureMessage(baseArgs);
    expect(msg).toContain('git exited 1: pre-commit hook failed');
  });

  test('omits the tail suffix when gitTail is empty (e.g. inherited stdio)', () => {
    const msg = formatCommitFailureMessage({ ...baseArgs, gitTail: '' });
    expect(msg).toContain('git exited 1');
    expect(msg).not.toContain('git exited 1:');
  });

  test('tells the user to pause-and-commit-manually (not auto-retry)', () => {
    const msg = formatCommitFailureMessage(baseArgs);
    expect(msg.toLowerCase()).toContain('pausing vibe');
    expect(msg.toLowerCase()).toContain('commit manually');
  });
});

describe('RunFailure', () => {
  test('Error.message has the step prefix; rawMessage does not', () => {
    const f = new RunFailure('commit', 'something went wrong', '1.2');
    expect(f.message).toBe('commit: something went wrong');
    expect(f.rawMessage).toBe('something went wrong');
    expect(f.step).toBe('commit');
    expect(f.prId).toBe('1.2');
  });
});

describe('planCommitMessage', () => {
  test('includes the slug so single-unit plan commits are resumable', () => {
    expect(
      planCommitMessage({
        slug: 'single-plan',
        title: 'Single plan',
        path: '.lauren/plans/single-plan.md',
        target_repos: [],
        status: 'ready',
        cancel_requested: false,
        created_at: '2026-05-08T12:00:00Z',
        started_at: null,
        finished_at: null,
        failure: null,
        prs: null,
      }),
    ).toBe('single-plan: Plan — Single plan');
  });
});
