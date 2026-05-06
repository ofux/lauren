import { describe, expect, test, vi } from 'vitest';

import { cancelPlan } from './cancel.js';
import type { InboxStore } from './core/inbox.js';
import type { TodoStore } from './core/store.js';
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
    ...overrides,
  };
}

describe('cancelPlan', () => {
  test('redirects an enqueued inbox cancellation when brain claims the row first', async () => {
    const plan = makePlan({ status: 'enqueued' });
    const inboxStore = {
      find: vi.fn(async () => plan),
      remove: vi.fn(async () => {
        plan.status = 'preparing';
        throw new PreparingLocked(plan.slug);
      }),
      update: vi.fn(async (_slug: string, fields: Partial<Plan>) => {
        Object.assign(plan, fields);
        return plan;
      }),
    } as unknown as InboxStore;
    const todoStore = { find: vi.fn(async () => null) } as unknown as TodoStore;

    const outcome = await cancelPlan({
      slug: plan.slug,
      store: 'inbox',
      todoStore,
      inboxStore,
    });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_requested).toBe(true);
    expect(inboxStore.update).toHaveBeenCalledWith(
      plan.slug,
      { cancel_requested: true },
      { allowPreparing: true },
    );
    expect(signalDaemon).toHaveBeenCalledWith(expect.stringContaining('brain.pid'), 'SIGUSR2');
  });

  test('does not report success when an enqueued inbox row disappears before remove', async () => {
    const plan = makePlan({ status: 'enqueued' });
    const inboxStore = {
      find: vi.fn(async () => plan),
      remove: vi.fn(async () => {
        throw new PlanNotFound(plan.slug);
      }),
    } as unknown as InboxStore;
    const todoStore = { find: vi.fn(async () => null) } as unknown as TodoStore;

    const outcome = await cancelPlan({
      slug: plan.slug,
      store: 'inbox',
      todoStore,
      inboxStore,
    });

    expect(outcome).toEqual({ kind: 'noop', message: `no inbox row for '${plan.slug}'` });
  });

  test('signals vibe when a ready todo row is claimed during cancellation', async () => {
    const plan = makePlan({ status: 'ready' });
    let firstUpdate = true;
    const todoStore = {
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
    } as unknown as TodoStore;
    const inboxStore = { find: vi.fn(async () => null) } as unknown as InboxStore;

    const outcome = await cancelPlan({
      slug: plan.slug,
      store: 'todo',
      todoStore,
      inboxStore,
    });

    expect(outcome).toMatchObject({ kind: 'requested', daemonReachable: true });
    expect(plan.cancel_requested).toBe(true);
    expect(todoStore.update).toHaveBeenLastCalledWith(
      plan.slug,
      { cancel_requested: true },
      { allowImplementing: true },
    );
    expect(signalDaemon).toHaveBeenCalledWith(expect.stringContaining('vibe.pid'), 'SIGUSR2');
  });
});
