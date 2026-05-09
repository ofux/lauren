import { promises as fs } from 'node:fs';

import { VIBE_PID_PATH } from './core/paths.js';
import type { PlanStore } from './core/store.js';
import { nowIso } from './core/time.js';
import {
  type CancelIntent,
  ImplementingLocked,
  type Plan,
  PlanNotFound,
  PreparingLocked,
  planFilePath,
} from './core/types.js';
import { signalDaemon } from './proc/pid.js';

export type CancelOutcome =
  | { kind: 'removed'; message: string }
  | { kind: 'requested'; message: string; daemonReachable: boolean }
  | { kind: 'noop'; message: string };

async function requestDaemonCancellation(
  store: PlanStore,
  slug: string,
  phase: 'preparing' | 'implementing',
  intent?: CancelIntent,
): Promise<CancelOutcome> {
  try {
    await store.update(
      slug,
      // Only stamp cancel_intent for implementing plans; the brain path
      // doesn't need it (there's no working tree state to preserve).
      phase === 'implementing'
        ? { cancel_requested: true, cancel_intent: intent ?? 'revert' }
        : { cancel_requested: true },
      { allowPreparing: true, allowImplementing: true },
    );
  } catch (err) {
    if (err instanceof PlanNotFound) {
      return { kind: 'noop', message: `no row for '${slug}'` };
    }
    throw err;
  }
  const reachable = await signalDaemon(VIBE_PID_PATH, 'SIGUSR2');
  let what: string;
  if (phase === 'preparing') {
    what = 'preparing; vibe signalled to abort brain';
  } else if (intent === 'keep') {
    what = 'implementing; vibe signalled to abort and mark cancelling';
  } else {
    what = 'implementing; vibe signalled to abort and revert';
  }
  return {
    kind: 'requested',
    daemonReachable: reachable,
    message: reachable
      ? `cancelling '${slug}' (was ${what})`
      : `cancel_requested set on '${slug}', but vibe daemon not reachable — start \`lauren vibe\` to finalize.`,
  };
}

/**
 * Apply the cancellation policy:
 *   enqueued     → remove from queue + delete .md
 *   preparing    → set cancel_requested=true, signal vibe (SIGUSR2);
 *                  vibe's brain phase aborts and removes the row
 *   ready        → set status='cancelled' directly
 *   implementing → set cancel_requested=true (+ cancel_intent), signal vibe;
 *                  vibe aborts the subprocess and either reverts the working
 *                  tree + marks 'cancelled' (intent='revert', the default)
 *                  or leaves the tree dirty + marks 'cancelling' and pauses
 *                  (intent='keep')
 *   else (failed/done/cancelled/cancelling) → no-op
 */
export async function cancelPlan(args: {
  slug: string;
  store: PlanStore;
  /** Only honored for implementing plans. Defaults to 'revert'. */
  intent?: CancelIntent;
}): Promise<CancelOutcome> {
  const { slug, store, intent } = args;
  const plan = await store.find(slug).catch(() => null);
  if (plan === null) return { kind: 'noop', message: `no row for '${slug}'` };

  if (plan.status === 'enqueued') {
    let removed: Plan;
    try {
      removed = await store.remove(slug);
    } catch (err) {
      if (err instanceof PreparingLocked) {
        return requestDaemonCancellation(store, slug, 'preparing');
      }
      if (err instanceof PlanNotFound) {
        return { kind: 'noop', message: `no row for '${slug}'` };
      }
      throw err;
    }
    try {
      await fs.unlink(planFilePath(removed));
    } catch {
      // ignore — plan file may have been cleaned up already
    }
    return { kind: 'removed', message: `cancelled '${slug}' (was enqueued; removed)` };
  }

  if (plan.status === 'preparing') {
    return requestDaemonCancellation(store, slug, 'preparing');
  }

  if (plan.status === 'ready') {
    try {
      await store.update(slug, { status: 'cancelled', finished_at: nowIso() });
    } catch (err) {
      if (err instanceof ImplementingLocked) {
        return requestDaemonCancellation(store, slug, 'implementing', intent);
      }
      if (err instanceof PlanNotFound) {
        return { kind: 'noop', message: `no row for '${slug}'` };
      }
      throw err;
    }
    return { kind: 'removed', message: `cancelled '${slug}' (was ready)` };
  }

  if (plan.status === 'implementing') {
    return requestDaemonCancellation(store, slug, 'implementing', intent);
  }

  return { kind: 'noop', message: `'${slug}' is ${plan.status}; nothing to cancel.` };
}

export function isCancellable(plan: Plan): boolean {
  return (
    plan.status === 'enqueued' ||
    plan.status === 'preparing' ||
    plan.status === 'ready' ||
    plan.status === 'implementing'
  );
}
