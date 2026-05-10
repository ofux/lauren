import { describe, expect, test, vi } from 'vitest';

import { cancelPlan } from './cancel.js';
import type { PlanStore } from './core/store.js';
import { ImplementingLocked, type Plan, PlanNotFound, PreparingLocked } from './core/types.js';
import { signalDaemon } from './proc/pid.js';

vi.mock('./proc/pid.js', () => ({
  signalDaemon: vi.fn(async () => true),
}));

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
