import { describe, expect, test } from 'vitest';
import { SINGLE_UNIT_AFTER } from './checkpoints.js';
import {
  materializeSteps,
  parseCheckpoints,
  parseSteps,
  reconcileSteps,
  type StepEntry,
} from './steps.js';

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

describe('parseCheckpoints', () => {
  test('returns empty for plans without any checkpoint sections', () => {
    const md = '### Step 1.1 — A\n### Step 1.2 — B\n';
    const result = parseCheckpoints(md);
    expect(result.checkpoints).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.multiStep).toBe(true);
  });

  test('parses a leading checkpoint (after_step_id null) in a multi-step plan', () => {
    const md = [
      '### Human Checkpoint — Set up env',
      '',
      '[Instructions](./foo.cp1.html)',
      '',
      '### Step 1.1 — A',
      '### Step 1.2 — B',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.errors).toEqual([]);
    expect(result.multiStep).toBe(true);
    expect(result.checkpoints).toEqual([
      {
        id: 'cp-1',
        title: 'Set up env',
        html_path: './foo.cp1.html',
        after_step_id: null,
      },
    ]);
  });

  test('parses a middle checkpoint between two Steps', () => {
    const md = [
      '### Step 1.1 — A',
      'body',
      '### Human Checkpoint — Subscribe to X',
      '',
      '[link](./foo.cp1.html)',
      '',
      '### Step 1.2 — B',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.errors).toEqual([]);
    expect(result.checkpoints[0]?.after_step_id).toBe('1.1');
  });

  test('parses a trailing checkpoint after the last Step', () => {
    const md = [
      '### Step 1.1 — A',
      '### Step 1.2 — B',
      '### Human Checkpoint — Flip flag',
      '',
      '[link](./foo.cp1.html)',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.errors).toEqual([]);
    expect(result.checkpoints[0]?.after_step_id).toBe('1.2');
  });

  test('treats a checkpoint in a single-unit plan as trailing (sentinel)', () => {
    const md = [
      '# Plan body',
      '',
      'Some prose without Step headings.',
      '',
      '### Human Checkpoint — Final manual check',
      '',
      '[Instructions](./foo.cp1.html)',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.errors).toEqual([]);
    expect(result.multiStep).toBe(false);
    expect(result.checkpoints).toEqual([
      {
        id: 'cp-1',
        title: 'Final manual check',
        html_path: './foo.cp1.html',
        after_step_id: SINGLE_UNIT_AFTER,
      },
    ]);
  });

  test('rejects multiple checkpoints in a single-unit plan', () => {
    const md = [
      '# Plan',
      '### Human Checkpoint — One',
      '[link](./foo.cp1.html)',
      '### Human Checkpoint — Two',
      '[link](./foo.cp2.html)',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.multiStep).toBe(false);
    expect(result.errors[0]?.kind).toBe('multiple-checkpoints-in-single-unit');
  });

  test('rejects a non-trailing checkpoint in a single-unit plan', () => {
    const md = [
      '# Plan',
      '### Human Checkpoint — Manual setup',
      '[link](./foo.cp1.html)',
      '### Follow-up prose',
      'More implementation notes.',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.multiStep).toBe(false);
    expect(result.errors).toContainEqual({
      kind: 'non-trailing-checkpoint-in-single-unit',
      title: 'Manual setup',
    });
  });

  test('rejects multiple checkpoints at the same multi-step boundary', () => {
    const md = [
      '### Step 1.1 — A',
      '### Human Checkpoint — One',
      '[link](./foo.cp1.html)',
      '### Human Checkpoint — Two',
      '[link](./foo.cp2.html)',
      '### Step 1.2 — B',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.multiStep).toBe(true);
    expect(result.errors).toContainEqual({
      kind: 'multiple-checkpoints-at-boundary',
      after_step_id: '1.1',
      titles: ['One', 'Two'],
    });
  });

  test('flags checkpoint sections that have no markdown link in their body', () => {
    const md = [
      '### Step 1.1 — A',
      '### Human Checkpoint — Missing link',
      'just prose without any link',
      '### Step 1.2 — B',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.errors[0]).toEqual({ kind: 'no-link', title: 'Missing link' });
    expect(result.checkpoints).toEqual([]);
  });

  test('uses the first link in the section body as the html_path', () => {
    const md = [
      '### Human Checkpoint — Title',
      'Some prose with a [docs link](https://example.com)',
      'and a sidecar [Instructions](./foo.cp1.html)',
    ].join('\n');
    const result = parseCheckpoints(md);
    expect(result.checkpoints[0]?.html_path).toBe('https://example.com');
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
