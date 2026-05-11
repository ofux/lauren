import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { PlanStore } from './core/store.js';
import type { Plan, PlanWorktree } from './core/types.js';
import { gitDeleteBranch, gitWorktreeRemove } from './proc/git.js';
import {
  allowsDirtyStartupRecovery,
  finalizeCancelledImplementingPlans,
  recoverImplementingPlans,
} from './vibe-command.js';

vi.mock('./proc/git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./proc/git.js')>();
  return {
    ...actual,
    gitWorktreeRemove: vi.fn(),
    gitDeleteBranch: vi.fn(),
  };
});

function worktree(repo: string | null, parentRoot: string): PlanWorktree {
  return {
    repo,
    path: `/workspace/.lauren/worktrees/demo-plan/${repo ?? ''}`.replace(/\/$/, ''),
    branch: 'lauren/demo-plan',
    parentRoot,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
    target_repos: [],
    status: 'implementing',
    cancel_requested: true,
    created_at: '2026-05-08T12:00:00Z',
    started_at: '2026-05-08T12:05:00Z',
    finished_at: null,
    failure: null,
    steps: null,
    ...overrides,
  };
}

function makeStore(): PlanStore {
  return {
    update: vi.fn(async () => makePlan({ status: 'cancelled' })),
  } as unknown as PlanStore;
}

describe('finalizeCancelledImplementingPlans', () => {
  beforeEach(() => {
    vi.mocked(gitWorktreeRemove).mockReset();
    vi.mocked(gitDeleteBranch).mockReset();
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('removes per-plan worktrees and branches and marks the row cancelled', async () => {
    const plan = makePlan({
      worktrees: [worktree('frontend', '/workspace/apps/frontend')],
    });
    const store = makeStore();

    await expect(finalizeCancelledImplementingPlans(store, [plan])).resolves.toBe(true);

    expect(gitWorktreeRemove).toHaveBeenCalledTimes(1);
    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/workspace/apps/frontend',
      worktreePath: '/workspace/.lauren/worktrees/demo-plan/frontend',
    });
    expect(gitDeleteBranch).toHaveBeenCalledWith('lauren/demo-plan', '/workspace/apps/frontend');
    expect(store.update).toHaveBeenCalledWith(
      'demo-plan',
      expect.objectContaining({
        status: 'cancelled',
        cancel_requested: false,
        worktrees: undefined,
        pr_urls: undefined,
      }),
      expect.objectContaining({ allowImplementing: true }),
    );
  });

  test('cleans up every recorded worktree for a multi-repo plan', async () => {
    const plan = makePlan({
      worktrees: [
        worktree('frontend', '/workspace/apps/frontend'),
        worktree('backend', '/workspace/backend'),
      ],
    });

    await expect(finalizeCancelledImplementingPlans(makeStore(), [plan])).resolves.toBe(true);

    expect(gitWorktreeRemove).toHaveBeenCalledTimes(2);
    expect(gitWorktreeRemove).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/workspace/apps/frontend' }),
    );
    expect(gitWorktreeRemove).toHaveBeenCalledWith(
      expect.objectContaining({ repoRoot: '/workspace/backend' }),
    );
    expect(gitDeleteBranch).toHaveBeenCalledTimes(2);
  });

  test('is a no-op (still marks cancelled) when no worktrees were recorded', async () => {
    const plan = makePlan({ worktrees: [] });

    await expect(finalizeCancelledImplementingPlans(makeStore(), [plan])).resolves.toBe(true);

    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitDeleteBranch).not.toHaveBeenCalled();
  });

  test('leaves cancellation pending when worktree removal fails', async () => {
    vi.mocked(gitWorktreeRemove).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const plan = makePlan({
      worktrees: [worktree(null, '/repo')],
    });
    const store = makeStore();

    await expect(finalizeCancelledImplementingPlans(store, [plan])).resolves.toBe(false);

    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });
});

describe('allowsDirtyStartupRecovery', () => {
  test('allows dirty startup when a merge row needs crash recovery', () => {
    expect(
      allowsDirtyStartupRecovery([
        makePlan({
          status: 'merging',
          cancel_requested: false,
          worktrees: [worktree(null, '/repo')],
        }),
      ]),
    ).toBe(true);
  });

  test('allows dirty startup while a cancelling row is being resolved', () => {
    expect(allowsDirtyStartupRecovery([makePlan({ status: 'cancelling' })])).toBe(true);
  });

  test('keeps the dirty checkout guard for normal queue states', () => {
    expect(
      allowsDirtyStartupRecovery([
        makePlan({ status: 'ready', cancel_requested: false }),
        makePlan({ status: 'enqueued', cancel_requested: false }),
      ]),
    ).toBe(false);
  });
});

describe('recoverImplementingPlans', () => {
  beforeEach(() => {
    vi.mocked(gitWorktreeRemove).mockReset();
    vi.mocked(gitDeleteBranch).mockReset();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('preserves branch commits when demoting an orphaned implementing row to ready', async () => {
    const plan = makePlan({
      cancel_requested: false,
      steps: [
        {
          id: '1',
          title: 'First step',
          status: 'done',
          commit_subject: 'demo-plan: Step 1',
          started_at: '2026-05-08T12:05:00Z',
          finished_at: '2026-05-08T12:10:00Z',
        },
      ],
      worktrees: [worktree(null, '/repo')],
    });
    const store = makeStore();

    await expect(recoverImplementingPlans(store, [plan])).resolves.toBe(true);

    expect(gitWorktreeRemove).toHaveBeenCalledWith({
      repoRoot: '/repo',
      worktreePath: '/workspace/.lauren/worktrees/demo-plan',
    });
    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(store.update).toHaveBeenCalledWith(
      'demo-plan',
      expect.objectContaining({
        status: 'ready',
        worktrees: undefined,
      }),
      expect.objectContaining({ allowImplementing: true }),
    );
  });

  test('does not clear orphaned worktree metadata when cleanup fails', async () => {
    vi.mocked(gitWorktreeRemove).mockImplementationOnce(() => {
      throw new Error('locked');
    });
    const plan = makePlan({
      cancel_requested: false,
      worktrees: [worktree(null, '/repo')],
    });
    const store = makeStore();

    await expect(recoverImplementingPlans(store, [plan])).resolves.toBe(false);

    expect(gitDeleteBranch).not.toHaveBeenCalled();
    expect(store.update).not.toHaveBeenCalled();
  });
});
