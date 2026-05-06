import { promises as fs } from 'node:fs';

import type { InboxStore } from './core/inbox.js';
import { BRAIN_PID_PATH, VIBE_PID_PATH } from './core/paths.js';
import type { TodoStore } from './core/store.js';
import { nowIso } from './core/time.js';
import {
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

/**
 * Apply the cancellation policy specified in the user-facing requirements:
 *   enqueued     → remove from inbox + delete .md
 *   preparing    → set cancel_requested=true, signal brain (SIGUSR2);
 *                  the brain finalizes by removing the inbox row
 *   ready        → set status='cancelled' on the todo row
 *   implementing → set cancel_requested=true, signal vibe (SIGUSR2);
 *                  vibe aborts the subprocess + git revert + sets 'cancelled'
 *   else (failed/done/cancelled) → no-op
 *
 * The TUI calls this after the user confirms a cancellation. `store` tells
 * us which file the plan lives in (resolves the inbox-vs-todo ambiguity
 * when the same slug briefly appears in both during brain hand-off).
 */
export async function cancelPlan(args: {
  slug: string;
  store: 'inbox' | 'todo';
  todoStore: TodoStore;
  inboxStore: InboxStore;
}): Promise<CancelOutcome> {
  const { slug, store, todoStore, inboxStore } = args;

  async function requestBrainCancellation(): Promise<CancelOutcome> {
    try {
      await inboxStore.update(slug, { cancel_requested: true }, { allowPreparing: true });
    } catch (err) {
      if (err instanceof PlanNotFound) {
        return { kind: 'noop', message: `no inbox row for '${slug}'` };
      }
      throw err;
    }
    const reachable = await signalDaemon(BRAIN_PID_PATH, 'SIGUSR2');
    return {
      kind: 'requested',
      daemonReachable: reachable,
      message: reachable
        ? `cancelling '${slug}' (was preparing; brain signalled to abort)`
        : `cancel_requested set on '${slug}', but brain daemon not reachable — start \`lauren organize\` to finalize.`,
    };
  }

  async function requestVibeCancellation(): Promise<CancelOutcome> {
    try {
      await todoStore.update(slug, { cancel_requested: true }, { allowImplementing: true });
    } catch (err) {
      if (err instanceof PlanNotFound) {
        return { kind: 'noop', message: `no todo row for '${slug}'` };
      }
      throw err;
    }
    const reachable = await signalDaemon(VIBE_PID_PATH, 'SIGUSR2');
    return {
      kind: 'requested',
      daemonReachable: reachable,
      message: reachable
        ? `cancelling '${slug}' (was implementing; vibe signalled to abort and revert)`
        : `cancel_requested set on '${slug}', but vibe daemon not reachable — start \`lauren vibe\` to finalize.`,
    };
  }

  if (store === 'inbox') {
    const plan = await inboxStore.find(slug).catch(() => null);
    if (plan === null) return { kind: 'noop', message: `no inbox row for '${slug}'` };

    if (plan.status === 'enqueued') {
      let removed: Plan;
      try {
        removed = await inboxStore.remove(slug);
      } catch (err) {
        if (err instanceof PreparingLocked) {
          return requestBrainCancellation();
        }
        if (err instanceof PlanNotFound) {
          return { kind: 'noop', message: `no inbox row for '${slug}'` };
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
      return requestBrainCancellation();
    }

    return { kind: 'noop', message: `'${slug}' is ${plan.status}; nothing to cancel.` };
  }

  const plan = await todoStore.find(slug).catch(() => null);
  if (plan === null) return { kind: 'noop', message: `no todo row for '${slug}'` };

  if (plan.status === 'ready') {
    try {
      await todoStore.update(slug, { status: 'cancelled', finished_at: nowIso() });
    } catch (err) {
      if (err instanceof ImplementingLocked) {
        return requestVibeCancellation();
      }
      if (err instanceof PlanNotFound) {
        return { kind: 'noop', message: `no todo row for '${slug}'` };
      }
      throw err;
    }
    return { kind: 'removed', message: `cancelled '${slug}' (was ready)` };
  }

  if (plan.status === 'implementing') {
    return requestVibeCancellation();
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
