import { describe, expect, test, vi } from 'vitest';

import type { PlanStore } from './core/store.js';
import { type Plan, PlanNotFound } from './core/types.js';
import { isRetryable, retryPlan } from './retry.js';

function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    slug: 'demo-plan',
    title: 'Demo plan',
    path: '.lauren/plans/demo-plan.md',
    target_repos: [],
    status: 'failed',
    cancel_requested: false,
    created_at: '2026-05-08T12:00:00Z',
    started_at: '2026-05-08T12:05:00Z',
    finished_at: '2026-05-08T12:10:00Z',
    failure: { phase: 'implement', step_id: null, message: 'boom' },
    steps: null,
    ...overrides,
  };
}

describe('retryPlan', () => {
  test('resets a failed plan back to ready and clears failure metadata', async () => {
    const plan = makePlan();
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        Object.assign(plan, fields);
        return plan;
      }),
    } as unknown as PlanStore;

    const outcome = await retryPlan({ slug: plan.slug, store });

    expect(outcome).toEqual({ kind: 'reset', message: `reset '${plan.slug}' to ready` });
    expect(store.update).toHaveBeenCalledWith(plan.slug, {
      status: 'ready',
      started_at: null,
      finished_at: null,
      failure: null,
      cancel_requested: false,
    });
    expect(plan.status).toBe('ready');
    expect(plan.failure).toBeNull();
  });

  test('refuses non-failed plans without mutating the store', async () => {
    const plan = makePlan({ status: 'ready', failure: null });
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(),
    } as unknown as PlanStore;

    const outcome = await retryPlan({ slug: plan.slug, store });

    expect(outcome).toMatchObject({ kind: 'noop' });
    expect(store.update).not.toHaveBeenCalled();
  });

  test('returns noop when the slug does not exist', async () => {
    const store = {
      find: vi.fn(async () => null),
      update: vi.fn(),
    } as unknown as PlanStore;

    const outcome = await retryPlan({ slug: 'missing', store });

    expect(outcome).toEqual({ kind: 'noop', message: `no row for 'missing'` });
    expect(store.update).not.toHaveBeenCalled();
  });

  test('returns noop if the row disappears between find and update', async () => {
    const plan = makePlan();
    const store = {
      find: vi.fn(async () => plan),
      update: vi.fn(async () => {
        throw new PlanNotFound(plan.slug);
      }),
    } as unknown as PlanStore;

    const outcome = await retryPlan({ slug: plan.slug, store });

    expect(outcome).toEqual({ kind: 'noop', message: `no row for '${plan.slug}'` });
  });

  test('isRetryable only accepts failed plans', () => {
    expect(isRetryable(makePlan({ status: 'failed' }))).toBe(true);
    expect(isRetryable(makePlan({ status: 'ready' }))).toBe(false);
    expect(isRetryable(makePlan({ status: 'implementing' }))).toBe(false);
    expect(isRetryable(makePlan({ status: 'enqueued' }))).toBe(false);
    expect(isRetryable(makePlan({ status: 'done' }))).toBe(false);
    expect(isRetryable(makePlan({ status: 'cancelled' }))).toBe(false);
    expect(isRetryable(makePlan({ status: 'preparing' }))).toBe(false);
  });
});
