import { describe, expect, test } from 'vitest';
import { materializeSteps, parseSteps, reconcileSteps, type StepEntry } from './steps.js';

function entry(overrides: Partial<StepEntry> & Pick<StepEntry, 'id' | 'title'>): StepEntry {
  return {
    status: 'pending',
    commit_subject: null,
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe('parseSteps', () => {
  test('returns [] for empty input', () => {
    expect(parseSteps('')).toEqual([]);
  });

  test('parses two Step headings in order', () => {
    const text = ['# Plan', '', '### Step 1.1 — Foo', 'body', '### Step 1.2 — Bar', 'body'].join(
      '\n',
    );
    expect(parseSteps(text)).toEqual([
      { id: '1.1', title: 'Foo' },
      { id: '1.2', title: 'Bar' },
    ]);
  });

  test('trims trailing whitespace from titles', () => {
    expect(parseSteps('### Step 2.3 — A title with trailing space   ')).toEqual([
      { id: '2.3', title: 'A title with trailing space' },
    ]);
  });

  test('ignores lines that do not match the Step heading shape', () => {
    const text = [
      '### Step 1 — single segment id',
      '### Foo',
      '## Step 1.1 — wrong heading level',
      'Step 1.1 — no hashes',
    ].join('\n');
    expect(parseSteps(text)).toEqual([]);
  });

  test('throws on duplicate Step id', () => {
    const text = ['### Step 1.1 — first', '### Step 1.1 — second'].join('\n');
    expect(() => parseSteps(text)).toThrow(/duplicate Step id 1\.1/);
  });
});

describe('reconcileSteps', () => {
  test('starts every Step as pending when nothing was stored', () => {
    const result = reconcileSteps(
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
    const stored: StepEntry[] = [
      entry({
        id: '1.1',
        title: 'A',
        status: 'done',
        commit_subject: 'slug: Step 1.1 — A',
        finished_at: '2026-05-08T00:00:00Z',
      }),
      entry({ id: '1.2', title: 'B', status: 'pending' }),
    ];
    const result = reconcileSteps(
      [
        { id: '1.1', title: 'A' },
        { id: '1.2', title: 'B' },
      ],
      stored,
    );
    expect(result[0]?.status).toBe('done');
    expect(result[0]?.commit_subject).toBe('slug: Step 1.1 — A');
    expect(result[1]?.status).toBe('pending');
  });

  test('refreshes the title when the markdown was edited', () => {
    const stored: StepEntry[] = [entry({ id: '1.1', title: 'old title', status: 'pending' })];
    const result = reconcileSteps([{ id: '1.1', title: 'new title' }], stored);
    expect(result[0]?.title).toBe('new title');
    expect(result[0]?.status).toBe('pending');
  });

  test('iteration order follows the parsed list, not the stored list', () => {
    const stored: StepEntry[] = [
      entry({ id: '1.1', title: 'A' }),
      entry({ id: '1.2', title: 'B' }),
    ];
    const result = reconcileSteps(
      [
        { id: '1.2', title: 'B' },
        { id: '1.1', title: 'A' },
      ],
      stored,
    );
    expect(result.map((e) => e.id)).toEqual(['1.2', '1.1']);
  });

  test('appends entries that are no longer in the markdown as orphaned', () => {
    const stored: StepEntry[] = [
      entry({ id: '1.1', title: 'A', status: 'pending' }),
      entry({ id: '1.2', title: 'B', status: 'pending' }),
    ];
    const result = reconcileSteps([{ id: '1.1', title: 'A' }], stored);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: '1.1', status: 'pending' });
    expect(result[1]).toMatchObject({ id: '1.2', status: 'orphaned' });
  });

  test('orphaned-but-done entries stay done, not downgraded to orphaned', () => {
    const stored: StepEntry[] = [
      entry({ id: '1.1', title: 'A', status: 'pending' }),
      entry({ id: '1.2', title: 'B', status: 'done' }),
    ];
    const result = reconcileSteps([{ id: '1.1', title: 'A' }], stored);
    const orphan = result.find((e) => e.id === '1.2');
    expect(orphan?.status).toBe('done');
  });

  test('a re-added orphaned Step is revived to pending', () => {
    const stored: StepEntry[] = [entry({ id: '1.1', title: 'A', status: 'orphaned' })];
    const result = reconcileSteps([{ id: '1.1', title: 'A' }], stored);
    expect(result[0]?.status).toBe('pending');
  });
});

describe('materializeSteps', () => {
  test('returns null for single-unit plans with no prior state', () => {
    expect(materializeSteps('# Plan body, no Step headings\n', null)).toBeNull();
  });

  test('returns an empty list (not null) when prior entries existed', () => {
    // Reading the markdown produced no Step headings but the row remembers
    // Steps that were once placed — keep them as orphaned so the UI shows
    // history instead of silently flipping into single-unit mode.
    const stored: StepEntry[] = [entry({ id: '1.1', title: 'A', status: 'done' })];
    const result = materializeSteps('# Plan with no headings\n', stored);
    expect(result).not.toBeNull();
    expect(result?.[0]).toMatchObject({ id: '1.1', status: 'done' });
  });

  test('materializes a fresh Step list from markdown', () => {
    const md = '### Step 1.1 — A\n### Step 1.2 — B\n';
    const result = materializeSteps(md, null);
    expect(result?.map((e) => [e.id, e.title, e.status])).toEqual([
      ['1.1', 'A', 'pending'],
      ['1.2', 'B', 'pending'],
    ]);
  });
});
