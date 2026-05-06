import { describe, expect, test } from 'vitest';
import { formatCommitFailureMessage, parseDoneIds, parsePrs, RunFailure } from './executor.js';
import { planCommitMessage } from './executor-prompts.js';

describe('parsePrs', () => {
  test('returns [] for empty input', () => {
    expect(parsePrs('')).toEqual([]);
  });

  test('parses two PR headings in order', () => {
    const text = ['# Plan', '', '### PR 1.1 — Foo', 'body', '### PR 1.2 — Bar', 'body'].join('\n');
    expect(parsePrs(text)).toEqual([
      { id: '1.1', title: 'Foo' },
      { id: '1.2', title: 'Bar' },
    ]);
  });

  test('trims trailing whitespace from titles', () => {
    expect(parsePrs('### PR 2.3 — A title with trailing space   ')).toEqual([
      { id: '2.3', title: 'A title with trailing space' },
    ]);
  });

  test('ignores lines that do not match the PR heading shape', () => {
    const text = [
      '### PR 1 — single segment id',
      '### Foo',
      '## PR 1.1 — wrong heading level',
      'PR 1.1 — no hashes',
    ].join('\n');
    expect(parsePrs(text)).toEqual([]);
  });

  test('throws on duplicate PR id', () => {
    const text = ['### PR 1.1 — first', '### PR 1.1 — second'].join('\n');
    expect(() => parsePrs(text)).toThrow(/duplicate PR id 1\.1/);
  });
});

describe('parseDoneIds', () => {
  test('returns an empty set for no subjects', () => {
    expect(parseDoneIds([], 'my-slug').size).toBe(0);
  });

  test('extracts PR ids from matching subjects', () => {
    const subjects = ['my-slug: PR 1.1 — First', 'my-slug: PR 1.2 — Second', 'unrelated commit'];
    expect(parseDoneIds(subjects, 'my-slug')).toEqual(new Set(['1.1', '1.2']));
  });

  test('does not match subjects for a different slug', () => {
    const subjects = ['other-slug: PR 1.1 — X', 'other-slug: PR 1.2 — Y'];
    expect(parseDoneIds(subjects, 'my-slug').size).toBe(0);
  });

  test('escapes regex specials in slug — does not falsely match siblings', () => {
    // Slug "feat.x+y" must match itself but not "featXxXy" — the dot/plus
    // would otherwise be metacharacters.
    const subjects = ['featXxXy: PR 1.1 — A', 'feat.x+y: PR 1.2 — B'];
    expect(parseDoneIds(subjects, 'feat.x+y')).toEqual(new Set(['1.2']));
  });

  test('does not match a Plan: <title> commit', () => {
    const subjects = ['Plan: A single-unit plan'];
    expect(parseDoneIds(subjects, 'a-single-unit-plan').size).toBe(0);
  });
});

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
      }),
    ).toBe('single-plan: Plan — Single plan');
  });
});
