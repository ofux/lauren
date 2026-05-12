import { describe, expect, test, vi } from 'vitest';

import { acknowledgeCheckpoint, isAwaitingHuman } from './checkpoint.js';
import type { CheckpointEntry } from './core/checkpoints.js';
import type { PlanStore } from './core/store.js';
import { type Plan, PlanNotFound, PlanPreconditionFailed } from './core/types.js';

function makeCheckpoint(overrides: Partial<CheckpointEntry> = {}): CheckpointEntry {
  return {
    id: 'cp-1',
    title: 'Set up Stripe test mode',
    html_path: '.lauren/plans/demo.cp1.html',
    after_step_id: '1.1',
    status: 'pending',
    acknowledged_at: null,
    ...overrides,
  };
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
    target_repos: [],
    status: 'awaiting_human',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: null,
    finished_at: null,
    failure: null,
    steps: [],
    checkpoints: [makeCheckpoint()],
    current_checkpoint_id: 'cp-1',
    ...overrides,
  };
}

describe('acknowledgeCheckpoint', () => {
  test('flips the plan to ready and marks the named checkpoint done', async () => {
    let plan = makePlan();
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        plan = { ...plan, ...fields };
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await acknowledgeCheckpoint({ slug: plan.slug, store });

    expect(outcome.kind).toBe('ok');
    expect(plan.status).toBe('ready');
    expect(plan.current_checkpoint_id).toBeNull();
    expect(plan.checkpoints?.[0]?.status).toBe('done');
    expect(plan.checkpoints?.[0]?.acknowledged_at).not.toBeNull();
  });

  test('advances a single-unit checkpoint directly to merging', async () => {
    let plan = makePlan({
      steps: null,
      checkpoints: [makeCheckpoint({ after_step_id: '__unit__' })],
    });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        plan = { ...plan, ...fields };
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await acknowledgeCheckpoint({ slug: plan.slug, store });

    expect(outcome.kind).toBe('ok');
    expect(plan.status).toBe('merging');
    expect(plan.current_checkpoint_id).toBeNull();
    expect(plan.checkpoints?.[0]?.status).toBe('done');
  });

  test('refuses to acknowledge when the plan is not awaiting_human', async () => {
    const plan = makePlan({ status: 'ready' });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(),
    } as unknown as PlanStore;

    const outcome = await acknowledgeCheckpoint({ slug: plan.slug, store });

    expect(outcome.kind).toBe('noop');
    expect(store.update).not.toHaveBeenCalled();
  });

  test('returns noop when the slug does not exist', async () => {
    const store = {
      find: vi.fn(async () => null),
      update: vi.fn(),
    } as unknown as PlanStore;

    const outcome = await acknowledgeCheckpoint({ slug: 'missing', store });

    expect(outcome).toEqual({ kind: 'noop', message: `no row for 'missing'` });
    expect(store.update).not.toHaveBeenCalled();
  });

  test('handles a row that disappears between find and update', async () => {
    const plan = makePlan();
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async () => {
        throw new PlanNotFound(plan.slug);
      }),
    } as unknown as PlanStore;

    const outcome = await acknowledgeCheckpoint({ slug: plan.slug, store });

    expect(outcome).toEqual({ kind: 'noop', message: `no row for '${plan.slug}'` });
  });

  test('does not acknowledge when the awaiting row changed before update', async () => {
    const plan = makePlan();
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async () => {
        throw new PlanPreconditionFailed(
          plan.slug,
          'row is no longer awaiting the same checkpoint',
        );
      }),
    } as unknown as PlanStore;

    const outcome = await acknowledgeCheckpoint({ slug: plan.slug, store });

    expect(outcome.kind).toBe('noop');
    expect(outcome.message).toContain('no longer awaiting checkpoint cp-1');
  });

  test('guards the update with the current awaiting checkpoint state', async () => {
    const plan = makePlan();
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => ({ ...plan, ...fields })),
    } as unknown as PlanStore;

    await acknowledgeCheckpoint({ slug: plan.slug, store });

    expect(store.update).toHaveBeenCalledWith(
      plan.slug,
      expect.objectContaining({ status: 'ready', current_checkpoint_id: null }),
      expect.objectContaining({
        preconditionDetail: 'row is no longer awaiting the same checkpoint',
      }),
    );
    const opts = vi.mocked(store.update).mock.calls[0]?.[2] as
      | { precondition?: (current: Plan) => boolean }
      | undefined;
    expect(opts?.precondition?.(plan)).toBe(true);
    expect(opts?.precondition?.({ ...plan, status: 'cancelled' })).toBe(false);
    expect(opts?.precondition?.({ ...plan, current_checkpoint_id: 'cp-2' })).toBe(false);
  });

  test('leaves checkpoints other than the current one untouched', async () => {
    let plan = makePlan({
      checkpoints: [
        makeCheckpoint({ id: 'cp-1' }),
        makeCheckpoint({ id: 'cp-2', after_step_id: '1.2' }),
      ],
      current_checkpoint_id: 'cp-1',
    });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        plan = { ...plan, ...fields };
        return plan;
      }),
    } as unknown as PlanStore;

    await acknowledgeCheckpoint({ slug: plan.slug, store });

    expect(plan.checkpoints?.[0]?.status).toBe('done');
    expect(plan.checkpoints?.[1]?.status).toBe('pending');
  });
});

describe('isAwaitingHuman', () => {
  test('only true for awaiting_human plans', () => {
    expect(isAwaitingHuman(makePlan({ status: 'awaiting_human' }))).toBe(true);
    expect(isAwaitingHuman(makePlan({ status: 'ready' }))).toBe(false);
    expect(isAwaitingHuman(makePlan({ status: 'done' }))).toBe(false);
  });
});
