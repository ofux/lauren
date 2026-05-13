import { describe, expect, test } from 'vitest';
import {
  type CheckpointEntry,
  nextPendingCheckpointAfter,
  type ParsedCheckpoint,
  reconcileCheckpoints,
} from './checkpoints.js';

function parsed(
  overrides: Partial<ParsedCheckpoint> & Pick<ParsedCheckpoint, 'id'>,
): ParsedCheckpoint {
  return {
    title: 'Untitled',
    html_path: `.lauren/plans/${overrides.id}.html`,
    after_step_id: null,
    ...overrides,
  };
}

function entry(overrides: Partial<CheckpointEntry> & Pick<CheckpointEntry, 'id'>): CheckpointEntry {
  return {
    title: 'Untitled',
    html_path: `.lauren/plans/${overrides.id}.html`,
    after_step_id: null,
    status: 'pending',
    acknowledged_at: null,
    ...overrides,
  };
}

describe('reconcileCheckpoints', () => {
  test('returns fresh pending entries when nothing was stored', () => {
    const result = reconcileCheckpoints(
      [parsed({ id: 'cp-1', title: 'A' }), parsed({ id: 'cp-2', title: 'B' })],
      null,
    );
    expect(result.map((e) => [e.title, e.status])).toEqual([
      ['A', 'pending'],
      ['B', 'pending'],
    ]);
  });

  test('preserves done status when html_path matches', () => {
    const stored: CheckpointEntry[] = [
      entry({
        id: 'cp-1',
        html_path: '.lauren/plans/foo.cp1.html',
        status: 'done',
        acknowledged_at: '2026-05-13T10:00:00.000Z',
      }),
    ];
    const result = reconcileCheckpoints(
      [parsed({ id: 'cp-1', title: 'renamed', html_path: '.lauren/plans/foo.cp1.html' })],
      stored,
    );
    expect(result[0]?.status).toBe('done');
    expect(result[0]?.acknowledged_at).toBe('2026-05-13T10:00:00.000Z');
    expect(result[0]?.title).toBe('renamed');
  });

  test('resets to pending when html_path changes (different sidecar)', () => {
    const stored: CheckpointEntry[] = [
      entry({ id: 'cp-1', html_path: '.lauren/plans/foo.cp1.html', status: 'done' }),
    ];
    const result = reconcileCheckpoints(
      [parsed({ id: 'cp-1', html_path: '.lauren/plans/foo.cp1.v2.html' })],
      stored,
    );
    expect(result[0]?.status).toBe('pending');
  });

  test('drops stored entries that no longer appear in the markdown', () => {
    const stored: CheckpointEntry[] = [
      entry({ id: 'cp-1', html_path: '.lauren/plans/foo.cp1.html', status: 'done' }),
      entry({ id: 'cp-2', html_path: '.lauren/plans/foo.cp2.html', status: 'pending' }),
    ];
    const result = reconcileCheckpoints(
      [parsed({ id: 'cp-1', html_path: '.lauren/plans/foo.cp1.html' })],
      stored,
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe('cp-1');
  });

  test('adopts latest after_step_id when the checkpoint moves', () => {
    const stored: CheckpointEntry[] = [
      entry({
        id: 'cp-1',
        html_path: '.lauren/plans/foo.cp1.html',
        after_step_id: '1.1',
        status: 'pending',
      }),
    ];
    const result = reconcileCheckpoints(
      [parsed({ id: 'cp-1', html_path: '.lauren/plans/foo.cp1.html', after_step_id: '1.2' })],
      stored,
    );
    expect(result[0]?.after_step_id).toBe('1.2');
  });
});

describe('nextPendingCheckpointAfter', () => {
  test('returns null when checkpoints are undefined', () => {
    expect(nextPendingCheckpointAfter(undefined, null)).toBeNull();
  });

  test('returns null when no checkpoint matches', () => {
    const cps = [entry({ id: 'cp-1', after_step_id: '1.1' })];
    expect(nextPendingCheckpointAfter(cps, '1.2')).toBeNull();
  });

  test('returns the first pending matching checkpoint', () => {
    const cps = [
      entry({ id: 'cp-1', after_step_id: null, status: 'done' }),
      entry({ id: 'cp-2', after_step_id: null, status: 'pending' }),
    ];
    expect(nextPendingCheckpointAfter(cps, null)?.id).toBe('cp-2');
  });

  test('skips done checkpoints', () => {
    const cps = [entry({ id: 'cp-1', after_step_id: '1.1', status: 'done' })];
    expect(nextPendingCheckpointAfter(cps, '1.1')).toBeNull();
  });
});
