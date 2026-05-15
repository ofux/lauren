import { afterEach, describe, expect, test, vi } from 'vitest';

import { cancelPlan, isCancellable } from './cancel.js';
import type { PlanStore } from './core/store.js';
import {
  ImplementingLocked,
  MergingLocked,
  type Plan,
  PlanNotFound,
  PlanPreconditionFailed,
  PreparingLocked,
} from './core/types.js';
import { signalDaemon } from './proc/pid.js';
import { cleanupPlanWorktrees } from './worktree.js';

vi.mock('./proc/pid.js', () => ({
  signalDaemon: vi.fn(async () => true),
}));

vi.mock('./worktree.js', () => ({
  cleanupPlanWorktrees: vi.fn(async () => undefined),
}));

afterEach(() => {
  vi.clearAllMocks();
});

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
    target_repos: [],
    status: 'ready',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
    steps: null,
    ...overrides,
  };
}

describe('cancelPlan', () => {
  test('redirects an enqueued cancellation when the brain claims the row first', async () => {
    const plan = makePlan({ status: 'enqueued' });
    const store = {
      find: vi.fn(async () => plan),
      remove: vi.fn(async () => {
        plan.status = 'preparing';
        throw new PreparingLocked(plan.slug);
      }),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        Object.assign(plan, fields);
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_requested).toBe(true);
    expect(store.update).toHaveBeenCalledWith(
      plan.slug,
      { cancel_requested: true },
      { allowPreparing: true, allowImplementing: true, allowMerging: true },
    );
    expect(signalDaemon).toHaveBeenCalledWith(expect.stringContaining('vibe.pid'), 'SIGUSR2');
  });

  test('does not report success when an enqueued row disappears before remove', async () => {
    const plan = makePlan({ status: 'enqueued' });
    const store = {
      find: vi.fn(async () => plan),
      remove: vi.fn(async () => {
        throw new PlanNotFound(plan.slug);
      }),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toEqual({ kind: 'noop', message: `no row for '${plan.slug}'` });
  });

  test('signals vibe when a ready row is claimed during cancellation', async () => {
    const plan = makePlan({ status: 'ready' });
    let firstUpdate = true;
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(
        async (_slug: string, fields: Partial<Plan>, opts?: { allowImplementing?: boolean }) => {
          if (firstUpdate && !opts?.allowImplementing) {
            firstUpdate = false;
            plan.status = 'implementing';
            throw new ImplementingLocked(plan.slug);
          }
          Object.assign(plan, fields);
          return plan;
        },
      ),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_requested).toBe(true);
    expect(plan.cancel_intent).toBe('revert');
    expect(store.update).toHaveBeenLastCalledWith(
      plan.slug,
      { cancel_requested: true, cancel_intent: 'revert' },
      { allowPreparing: true, allowImplementing: true, allowMerging: true },
    );
    expect(signalDaemon).toHaveBeenCalledWith(expect.stringContaining('vibe.pid'), 'SIGUSR2');
  });

  test('signals vibe when a ready row races to merging during cancellation', async () => {
    const plan = makePlan({ status: 'ready' });
    let firstUpdate = true;
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(
        async (_slug: string, fields: Partial<Plan>, opts?: { allowMerging?: boolean }) => {
          if (firstUpdate && !opts?.allowMerging) {
            firstUpdate = false;
            plan.status = 'merging';
            throw new MergingLocked(plan.slug);
          }
          Object.assign(plan, fields);
          return plan;
        },
      ),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_requested).toBe(true);
    // Defaults to 'revert' for merging cancellations with no explicit intent.
    expect(plan.cancel_intent).toBe('revert');
    expect(store.update).toHaveBeenLastCalledWith(
      plan.slug,
      { cancel_requested: true, cancel_intent: 'revert' },
      expect.objectContaining({
        allowPreparing: true,
        allowImplementing: true,
        allowMerging: true,
      }),
    );
    expect(outcome.kind === 'requested' && outcome.message).toMatch(/was merging/);
    expect(signalDaemon).toHaveBeenCalledWith(expect.stringContaining('vibe.pid'), 'SIGUSR2');
  });

  test("preserves intent='keep' when an implementing plan races to merging mid-cancel", async () => {
    // User opened the TUI dialog while the row was 'implementing' and picked
    // 'keep'. By the time cancel.ts's find() runs, the daemon has already
    // transitioned the row to 'merging'. The intent must still land on the
    // row, otherwise drainMerging will silently delete the lauren/<slug>
    // branch and lose the committed Step work.
    const plan = makePlan({ status: 'merging' });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        Object.assign(plan, fields);
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store, intent: 'keep' });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_requested).toBe(true);
    expect(plan.cancel_intent).toBe('keep');
    expect(store.update).toHaveBeenCalledWith(
      plan.slug,
      { cancel_requested: true, cancel_intent: 'keep' },
      expect.objectContaining({
        allowPreparing: true,
        allowImplementing: true,
        allowMerging: true,
      }),
    );
    expect(outcome.kind === 'requested' && outcome.message).toMatch(/mark cancelling/);
  });

  test("preserves intent='keep' through a ready→merging race", async () => {
    // Variant of the race above where cancel.ts first read 'ready' and the
    // store rejects the direct status='cancelled' update with MergingLocked.
    // The redirect to requestDaemonCancellation must carry intent.
    const plan = makePlan({ status: 'ready' });
    let firstUpdate = true;
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(
        async (_slug: string, fields: Partial<Plan>, opts?: { allowMerging?: boolean }) => {
          if (firstUpdate && !opts?.allowMerging) {
            firstUpdate = false;
            plan.status = 'merging';
            throw new MergingLocked(plan.slug);
          }
          Object.assign(plan, fields);
          return plan;
        },
      ),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store, intent: 'keep' });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_intent).toBe('keep');
    expect(store.update).toHaveBeenLastCalledWith(
      plan.slug,
      { cancel_requested: true, cancel_intent: 'keep' },
      expect.objectContaining({ allowMerging: true }),
    );
  });

  test("stamps cancel_intent='keep' when cancelling an implementing plan with intent=keep", async () => {
    const plan = makePlan({ status: 'implementing' });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        Object.assign(plan, fields);
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store, intent: 'keep' });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_requested).toBe(true);
    expect(plan.cancel_intent).toBe('keep');
    expect(store.update).toHaveBeenCalledWith(
      plan.slug,
      { cancel_requested: true, cancel_intent: 'keep' },
      { allowPreparing: true, allowImplementing: true, allowMerging: true },
    );
    expect(outcome.kind === 'requested' && outcome.message).toMatch(/mark cancelling/);
  });

  test("defaults cancel_intent to 'revert' when cancelling an implementing plan with no intent", async () => {
    const plan = makePlan({ status: 'implementing' });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        Object.assign(plan, fields);
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_intent).toBe('revert');
    expect(store.update).toHaveBeenCalledWith(
      plan.slug,
      { cancel_requested: true, cancel_intent: 'revert' },
      { allowPreparing: true, allowImplementing: true, allowMerging: true },
    );
  });

  test('cleans recorded worktrees when cancelling an awaiting checkpoint plan', async () => {
    let plan = makePlan({
      status: 'awaiting_human',
      current_checkpoint_id: 'cp-1',
      worktrees: [
        {
          repo: null,
          path: '/workspace/.lauren/worktrees/demo-plan',
          branch: 'lauren/demo-plan',
          parentRoot: '/workspace',
        },
      ],
    });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        plan = { ...plan, ...fields };
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toEqual({
      kind: 'removed',
      message: `cancelled '${plan.slug}' (was awaiting_human)`,
    });
    expect(cleanupPlanWorktrees).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: plan.slug,
        status: 'cancelled',
        worktrees: expect.any(Array),
      }),
      { keepBranches: true, requireClean: true },
    );
    expect(store.update).toHaveBeenLastCalledWith(
      plan.slug,
      { worktrees: undefined },
      { allowImplementing: true },
    );
    expect(plan.worktrees).toBeUndefined();
  });

  test('does not cancel a cleanup-pending merge', async () => {
    const plan = makePlan({
      status: 'merging',
      failure: {
        phase: 'cleanup',
        step_id: null,
        message: 'merge landed, but cleanup failed: locked',
        cleanup_result: 'done',
      },
    });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toEqual({
      kind: 'noop',
      message: `'${plan.slug}' already merged; waiting for cleanup to finish.`,
    });
    expect(store.update).not.toHaveBeenCalled();
    expect(signalDaemon).not.toHaveBeenCalled();
    expect(isCancellable(plan)).toBe(false);
  });

  test('does not cancel when a ready row races into cleanup-pending merge', async () => {
    const plan = makePlan({ status: 'ready' });
    let firstUpdate = true;
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(
        async (_slug: string, _fields: Partial<Plan>, opts?: { allowMerging?: boolean }) => {
          if (firstUpdate && !opts?.allowMerging) {
            firstUpdate = false;
            plan.status = 'merging';
            plan.failure = {
              phase: 'cleanup',
              step_id: null,
              message: 'merge landed, but cleanup failed: locked',
              cleanup_result: 'done',
            };
            throw new MergingLocked(plan.slug);
          }
          throw new PlanPreconditionFailed(plan.slug, 'cleanup is already pending');
        },
      ),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome).toEqual({
      kind: 'noop',
      message: `'${plan.slug}' already merged; waiting for cleanup to finish.`,
    });
    expect(signalDaemon).not.toHaveBeenCalled();
  });

  test("is a no-op for a 'cancelling' plan", async () => {
    const plan = makePlan({ status: 'cancelling' });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(),
      remove: vi.fn(),
    } as unknown as PlanStore;

    const outcome = await cancelPlan({ slug: plan.slug, store });

    expect(outcome.kind).toBe('noop');
    expect(store.update).not.toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });
});
