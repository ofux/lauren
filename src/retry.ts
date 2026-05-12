import type { PlanStore } from './core/store.js';
import { type Plan, PlanNotFound } from './core/types.js';

export type RetryOutcome = { kind: 'reset'; message: string } | { kind: 'noop'; message: string };

export function isRetryable(plan: Plan): boolean {
  return plan.status === 'failed';
}

/**
 * Reset a failed plan back to `ready` so the next vibe loop will rerun it.
 * Clears `failure`, the timestamps, and any leftover `cancel_requested` flag.
 * Only `failed` rows are accepted — stale `implementing` recovery still
 * requires the user to clean the working tree and restart the watcher.
 */
export async function retryPlan(args: { slug: string; store: PlanStore }): Promise<RetryOutcome> {
  const { slug, store } = args;
  const plan = await store.find(slug).catch(() => null);
  if (plan === null) return { kind: 'noop', message: `no row for '${slug}'` };
  if (plan.status !== 'failed') {
    return {
      kind: 'noop',
      message: `'${slug}' is ${plan.status}; only failed plans can be retried.`,
    };
  }
  try {
    await store.update(slug, {
      status: 'ready',
      started_at: null,
      finished_at: null,
      failure: null,
      cancel_requested: false,
    });
  } catch (err) {
    if (err instanceof PlanNotFound) {
      return { kind: 'noop', message: `no row for '${slug}'` };
    }
    throw err;
  }
  return { kind: 'reset', message: `reset '${slug}' to ready` };
}
