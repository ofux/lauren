import { promises as fs } from 'node:fs';
import path from 'node:path';

import { REPO, VIBE_PID_PATH } from './core/paths.js';
import type { PlanStore } from './core/store.js';
import { nowIso } from './core/time.js';
import {
  type CancelIntent,
  ImplementingLocked,
  MergingLocked,
  type Plan,
  PlanNotFound,
  PlanPreconditionFailed,
  PreparingLocked,
  planFilePath,
} from './core/types.js';
import { signalDaemon } from './proc/pid.js';
import { cleanupPlanWorktrees } from './worktree.js';

async function deleteCheckpointSidecars(plan: Plan): Promise<void> {
  for (const cp of plan.checkpoints ?? []) {
    const abs = path.isAbsolute(cp.html_path) ? cp.html_path : path.resolve(REPO, cp.html_path);
    try {
      await fs.unlink(abs);
    } catch {
      // best-effort — sidecar may already be gone
    }
  }
}

async function cleanupCancelledWorktrees(store: PlanStore, plan: Plan): Promise<void> {
  if ((plan.worktrees?.length ?? 0) === 0) return;
  try {
    await cleanupPlanWorktrees(plan, { keepBranches: true, requireClean: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `warning: failed to clean leftover worktree for cancelled '${plan.slug}': ${msg}\n`,
    );
    return;
  }
  try {
    await store.update(plan.slug, { worktrees: undefined }, { allowImplementing: true });
  } catch (err) {
    if (!(err instanceof PlanNotFound)) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`warning: failed to clear worktrees field on '${plan.slug}': ${msg}\n`);
    }
  }
}

export type CancelOutcome =
  | { kind: 'removed'; message: string }
  | { kind: 'requested'; message: string; daemonReachable: boolean }
  | { kind: 'noop'; message: string };

async function requestDaemonCancellation(
  store: PlanStore,
  slug: string,
  phase: 'preparing' | 'implementing' | 'merging',
  intent?: CancelIntent,
): Promise<CancelOutcome> {
  // Stamp cancel_intent for both implementing and merging: a user who picks
  // 'keep' on an implementing plan that races to merging would otherwise see
  // their intent silently dropped, because the daemon's drainMerging cancel
  // path consults cancel_intent and falls back to 'revert' when it's unset.
  // Preparing rows have no work to preserve, so intent doesn't apply.
  const stampIntent = phase === 'implementing' || phase === 'merging';
  try {
    await store.update(
      slug,
      stampIntent
        ? { cancel_requested: true, cancel_intent: intent ?? 'revert' }
        : { cancel_requested: true },
      {
        allowPreparing: true,
        allowImplementing: true,
        allowMerging: true,
        ...(phase === 'merging'
          ? {
              precondition: (plan: Plan) => plan.failure?.phase !== 'cleanup',
              preconditionDetail: 'cleanup is already pending',
            }
          : {}),
      },
    );
  } catch (err) {
    if (err instanceof PlanNotFound) {
      return { kind: 'noop', message: `no row for '${slug}'` };
    }
    if (err instanceof PlanPreconditionFailed) {
      return {
        kind: 'noop',
        message: `'${slug}' already merged; waiting for cleanup to finish.`,
      };
    }
    throw err;
  }
  const reachable = await signalDaemon(VIBE_PID_PATH, 'SIGUSR2');
  if (!reachable) {
    return {
      kind: 'requested',
      daemonReachable: reachable,
      message: `cancel_requested set on '${slug}', but vibe daemon not reachable — start \`lauren vibe\` to finalize.`,
    };
  }
  let message: string;
  if (phase === 'preparing') {
    message = `cancelling '${slug}' (was preparing; vibe signalled to abort brain)`;
  } else if (phase === 'merging') {
    // The merge can complete (e.g. PR merged on GitHub) between SIGUSR2 firing
    // and drainMerging's next check, in which case finalizeMerge for `done`
    // clears cancel_requested and the request is silently dropped. Don't
    // promise cancellation here — describe the request and the two outcomes.
    const ifNotLanded =
      intent === 'keep' ? 'mark cancelling and pause' : 'clean up the worktree and mark cancelled';
    message =
      `cancel requested for '${slug}' (was merging); ` +
      `if the merge has not landed, vibe will ${ifNotLanded}; ` +
      `otherwise the plan finalizes as done`;
  } else if (intent === 'keep') {
    message = `cancelling '${slug}' (was implementing; vibe signalled to abort and mark cancelling)`;
  } else {
    message = `cancelling '${slug}' (was implementing; vibe signalled to abort and clean up worktree)`;
  }
  return { kind: 'requested', daemonReachable: reachable, message };
}

/**
 * Apply the cancellation policy:
 *   enqueued     → remove from queue + delete .md
 *   preparing    → set cancel_requested=true, signal vibe (SIGUSR2);
 *                  vibe's brain phase aborts and removes the row
 *   ready        → set status='cancelled' directly
 *   implementing → set cancel_requested=true (+ cancel_intent), signal vibe;
 *                  vibe aborts the subprocess and either tears down the
 *                  worktree + marks 'cancelled' (intent='revert', the default)
 *                  or leaves the worktree intact + marks 'cancelling' and
 *                  pauses (intent='keep')
 *   merging      → set cancel_requested=true (+ cancel_intent), signal vibe;
 *                  vibe stops the merge/poll and either tears down the
 *                  worktree + marks 'cancelled' (intent='revert', default)
 *                  or leaves the worktree intact + marks 'cancelling'
 *                  (intent='keep' — preserves the lauren/<slug> branch's
 *                  committed Step work for manual handling)
 *   awaiting_human → set status='cancelled' directly. Committed Steps stay
 *                  on the lauren/<slug> branch.
 *   else (failed/done/cancelled/cancelling) → no-op
 */
export async function cancelPlan(args: {
  slug: string;
  store: PlanStore;
  /**
   * Honored for implementing and merging plans (including races where the
   * row transitions implementing↔merging between TUI capture and this call).
   * Defaults to 'revert'.
   */
  intent?: CancelIntent;
}): Promise<CancelOutcome> {
  const { slug, store, intent } = args;
  const plan = await store.find(slug);
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
    await deleteCheckpointSidecars(removed);
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
      if (err instanceof MergingLocked) {
        return requestDaemonCancellation(store, slug, 'merging', intent);
      }
      if (err instanceof PlanNotFound) {
        return { kind: 'noop', message: `no row for '${slug}'` };
      }
      throw err;
    }
    return { kind: 'removed', message: `cancelled '${slug}' (was ready)` };
  }

  if (plan.status === 'awaiting_human') {
    // The daemon is paused at a Human Checkpoint. Earlier commits already
    // landed on the lauren/<slug> branch; finalize as 'cancelled', then
    // remove any clean worktrees while preserving the branch for inspection.
    let cancelled: Plan;
    try {
      cancelled = await store.update(slug, {
        status: 'cancelled',
        finished_at: nowIso(),
        current_checkpoint_id: null,
      });
    } catch (err) {
      if (err instanceof PlanNotFound) {
        return { kind: 'noop', message: `no row for '${slug}'` };
      }
      throw err;
    }
    await cleanupCancelledWorktrees(store, cancelled);
    return { kind: 'removed', message: `cancelled '${slug}' (was awaiting_human)` };
  }

  if (plan.status === 'implementing') {
    return requestDaemonCancellation(store, slug, 'implementing', intent);
  }

  if (plan.status === 'merging') {
    if (plan.failure?.phase === 'cleanup') {
      return {
        kind: 'noop',
        message: `'${slug}' already merged; waiting for cleanup to finish.`,
      };
    }
    return requestDaemonCancellation(store, slug, 'merging', intent);
  }

  return { kind: 'noop', message: `'${slug}' is ${plan.status}; nothing to cancel.` };
}

export function isCancellable(plan: Plan): boolean {
  return (
    plan.status === 'enqueued' ||
    plan.status === 'preparing' ||
    plan.status === 'ready' ||
    plan.status === 'implementing' ||
    plan.status === 'awaiting_human' ||
    (plan.status === 'merging' && plan.failure?.phase !== 'cleanup')
  );
}
