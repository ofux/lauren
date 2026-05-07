import { describe, expect, test } from 'vitest';
import { materializePrs, migratePrEntry, type PrEntry, parsePrs, reconcilePrs } from './prs.js';

function entry(overrides: Partial<PrEntry> & Pick<PrEntry, 'id' | 'title'>): PrEntry {
  return {
    status: 'pending',
    commit_subject: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

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

describe('reconcilePrs', () => {
  test('starts every PR as pending when nothing was stored', () => {
    const result = reconcilePrs(
      [
        { id: '1.1', title: 'A' },
        { id: '1.2', title: 'B' },
      ],
      null,
    );
    expect(result.map((e) => [e.id, e.status])).toEqual([
      ['1.1', 'pending'],
      ['1.2', 'pending'],
    ]);
  });

  test('preserves status and commit_subject for matching ids', () => {
    const stored: PrEntry[] = [
      entry({
        id: '1.1',
        title: 'A',
        status: 'done',
        commit_subject: 'slug: PR 1.1 — A',
        finished_at: '2026-05-08T00:00:00Z',
      }),
      entry({ id: '1.2', title: 'B', status: 'pending' }),
    ];
    const result = reconcilePrs(
      [
        { id: '1.1', title: 'A' },
        { id: '1.2', title: 'B' },
      ],
      stored,
    );
    expect(result[0]?.status).toBe('done');
    expect(result[0]?.commit_subject).toBe('slug: PR 1.1 — A');
    expect(result[1]?.status).toBe('pending');
  });

  test('refreshes the title when the markdown was edited', () => {
    const stored: PrEntry[] = [entry({ id: '1.1', title: 'old title', status: 'pending' })];
    const result = reconcilePrs([{ id: '1.1', title: 'new title' }], stored);
    expect(result[0]?.title).toBe('new title');
    expect(result[0]?.status).toBe('pending');
  });

  test('iteration order follows the parsed list, not the stored list', () => {
    const stored: PrEntry[] = [entry({ id: '1.1', title: 'A' }), entry({ id: '1.2', title: 'B' })];
    const result = reconcilePrs(
      [
        { id: '1.2', title: 'B' },
        { id: '1.1', title: 'A' },
      ],
      stored,
    );
    expect(result.map((e) => e.id)).toEqual(['1.2', '1.1']);
  });

  test('appends entries that are no longer in the markdown as orphaned', () => {
    const stored: PrEntry[] = [
      entry({ id: '1.1', title: 'A', status: 'pending' }),
      entry({ id: '1.2', title: 'B', status: 'pending' }),
    ];
    const result = reconcilePrs([{ id: '1.1', title: 'A' }], stored);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: '1.1', status: 'pending' });
    expect(result[1]).toMatchObject({ id: '1.2', status: 'orphaned' });
  });

  test('orphaned-but-done entries stay done, not downgraded to orphaned', () => {
    const stored: PrEntry[] = [
      entry({ id: '1.1', title: 'A', status: 'pending' }),
      entry({ id: '1.2', title: 'B', status: 'done' }),
    ];
    const result = reconcilePrs([{ id: '1.1', title: 'A' }], stored);
    const orphan = result.find((e) => e.id === '1.2');
    expect(orphan?.status).toBe('done');
  });

  test('a re-added orphaned PR is revived to pending', () => {
    const stored: PrEntry[] = [entry({ id: '1.1', title: 'A', status: 'orphaned' })];
    const result = reconcilePrs([{ id: '1.1', title: 'A' }], stored);
    expect(result[0]?.status).toBe('pending');
  });
});

describe('materializePrs', () => {
  test('returns null for single-unit plans with no prior state', () => {
    expect(materializePrs('# Plan body, no PR headings\n', null)).toBeNull();
  });

  test('returns an empty list (not null) when prior entries existed', () => {
    // Reading the markdown produced no PR headings but the row remembers
    // PRs that were once placed — keep them as orphaned so the UI shows
    // history instead of silently flipping into single-unit mode.
    const stored: PrEntry[] = [entry({ id: '1.1', title: 'A', status: 'done' })];
    const result = materializePrs('# Plan with no headings\n', stored);
    expect(result).not.toBeNull();
    expect(result?.[0]).toMatchObject({ id: '1.1', status: 'done' });
  });

  test('materializes a fresh PR list from markdown', () => {
    const md = '### PR 1.1 — A\n### PR 1.2 — B\n';
    const result = materializePrs(md, null);
    expect(result?.map((e) => [e.id, e.title, e.status])).toEqual([
      ['1.1', 'A', 'pending'],
      ['1.2', 'B', 'pending'],
    ]);
  });
});

describe('migratePrEntry', () => {
  test('coerces an unknown status to pending', () => {
    expect(migratePrEntry({ id: '1.1', title: 'A', status: 'weird' })).toMatchObject({
      id: '1.1',
      title: 'A',
      status: 'pending',
    });
  });

  test('rejects entries without id or title', () => {
    expect(migratePrEntry({ id: '', title: 'A' })).toBeNull();
    expect(migratePrEntry({ id: '1.1', title: '' })).toBeNull();
    expect(migratePrEntry(null)).toBeNull();
  });

  test('preserves valid status values', () => {
    for (const status of ['pending', 'done', 'failed', 'orphaned'] as const) {
      expect(migratePrEntry({ id: '1.1', title: 'A', status })?.status).toBe(status);
    }
  });
});
