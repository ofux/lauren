import { describe, expect, test } from 'vitest';
import { parseDoneIds, parsePrs } from './executor.js';

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
