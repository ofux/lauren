import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { InboxStore } from './core/inbox.js';
import { VIBE_LOCK_PATH } from './core/paths.js';
import { materializePrs, type PrEntry } from './core/prs.js';
import type { TodoStore } from './core/store.js';
import { nowIso } from './core/time.js';
import {
  ImplementingLocked,
  type Plan,
  type PlanFailure,
  PlanNotFound,
  planFilePath,
} from './core/types.js';
import { RunFailure, runPlan } from './executor.js';
import { type BrainCancelState, processInboxPlan } from './organize.js';
import { newPlanRuntimeState, type PlanItem, type WatcherRuntime } from './tui/runtime.js';

export const IDLE_POLL_SECONDS = 3.0;

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function planFileExists(plan: Plan): Promise<boolean> {
  try {
    await fs.access(planFilePath(plan));
    return true;
  } catch {
    return false;
  }
}

export async function tryAcquireVibeLock(): Promise<(() => Promise<void>) | null> {
  await fs.mkdir(path.dirname(VIBE_LOCK_PATH), { recursive: true });
  const fd = await fs.open(VIBE_LOCK_PATH, 'a');
  await fd.close();
  try {
    return await lockfile.lock(VIBE_LOCK_PATH, {
      stale: 60_000,
      realpath: false,
    });
  } catch {
    return null;
  }
}

function runtimeItemsForPlan(plan: Plan): PlanItem[] {
  if (plan.prs && plan.prs.length > 0) {
    return plan.prs
      .filter((pr) => pr.status !== 'orphaned')
      .map((pr) => ({ id: pr.id, title: pr.title }));
  }
  return [{ id: plan.slug, title: plan.title }];
}

function failureFromError(err: unknown): PlanFailure {
  if (err instanceof RunFailure) {
    // Use rawMessage (without the "${step}: " prefix the Error constructor
    // adds) — the TUI displays step separately and we don't want it twice.
    return { step: err.step, pr_id: err.prId, message: err.rawMessage };
  }
  return {
    step: 'unknown',
    pr_id: null,
    message: `unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
  };
}

async function markPlanMissing(store: TodoStore, plan: Plan): Promise<void> {
  const failure: PlanFailure = {
    step: 'implement',
    pr_id: null,
    message: `plan file missing: ${plan.path}`,
  };
  try {
    await store.update(plan.slug, {
      status: 'failed',
      finished_at: nowIso(),
      failure,
    });
  } catch (err) {
    if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
      throw err;
    }
  }
}

async function markPlanFailed(store: TodoStore, plan: Plan, failure: PlanFailure): Promise<void> {
  try {
    await store.update(
      plan.slug,
      { status: 'failed', finished_at: nowIso(), failure },
      { allowImplementing: true },
    );
  } catch (err) {
    if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
      throw err;
    }
  }
}

async function markPlanDone(store: TodoStore, plan: Plan): Promise<void> {
  try {
    await store.update(
      plan.slug,
      { status: 'done', finished_at: nowIso() },
      { allowImplementing: true },
    );
  } catch (err) {
    if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
      throw err;
    }
  }
}

async function markPlanCancelled(store: TodoStore, plan: Plan): Promise<void> {
  try {
    await store.update(
      plan.slug,
      {
        status: 'cancelled',
        finished_at: nowIso(),
        cancel_requested: false,
      },
      { allowImplementing: true },
    );
  } catch (err) {
    if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
      throw err;
    }
  }
}

export type DaemonPhase = 'idle' | 'organizing' | 'implementing';

export interface WatcherLoopHandles {
  /**
   * Slug currently being processed; null between runs. The vibe SIGUSR2
   * handler reads this to decide whether to abort.
   */
  current: { slug: string | null };
  /**
   * Current phase. SIGUSR2 dispatches based on this:
   * organizing → abort brain subprocess via brainState.controller
   * implementing → abort executor subprocess via cancelController
   */
  phase: { value: DaemonPhase };
  /**
   * AbortController scoped to the in-flight plan during 'implementing'.
   * The vibe SIGUSR2 handler calls `.abort()` to interrupt subprocesses.
   */
  cancelController: { ref: AbortController | null };
  /**
   * Brain-side cancel state during 'organizing'. Mutated by processInboxPlan
   * to expose the current AbortController so SIGUSR2 can abort the brain
   * subprocess mid-placement.
   */
  brainState: BrainCancelState;
}

/**
 * Drain the inbox by running brain placement on each enqueued/preparing
 * plan until none remain. Phase 'organizing' is held throughout. Errors
 * are reported via stderr and the loop sleeps briefly to avoid hot-looping
 * on a broken plan.
 */
async function drainInbox(
  runtime: WatcherRuntime,
  todoStore: TodoStore,
  inboxStore: InboxStore,
  signal: AbortSignal,
  handles: WatcherLoopHandles,
): Promise<void> {
  while (!signal.aborted) {
    const inboxPlans = await inboxStore.read();
    const next = inboxPlans[0];
    if (!next) return;

    const todoSnapshot = await todoStore.read();
    runtime.setOrganizing(todoSnapshot, next);
    handles.current.slug = next.slug;
    handles.phase.value = 'organizing';
    try {
      await processInboxPlan({
        plan: next,
        todoStore,
        inboxStore,
        state: handles.brainState,
        notify: ({ level, text }) => {
          if (level === 'error') {
            process.stderr.write(`brain: ${text}\n`);
          }
          runtime.setOrganizingNote(text);
        },
      });
    } catch (err) {
      handles.brainState.current = null;
      handles.brainState.controller = null;
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`brain: failed to process '${next.slug}': ${msg}\n`);
      // Back off briefly so we don't hot-loop on the same broken plan.
      await sleep(IDLE_POLL_SECONDS * 1000, signal);
    } finally {
      handles.current.slug = null;
      handles.phase.value = 'idle';
    }
  }
}

export async function watcherLoop(
  runtime: WatcherRuntime,
  store: TodoStore,
  inboxStore: InboxStore,
  signal: AbortSignal,
  handles: WatcherLoopHandles,
): Promise<{ inFlight: Plan | null; cancelledSlug: string | null }> {
  let inFlight: Plan | null = null;
  let cancelledSlug: string | null = null;
  while (!signal.aborted) {
    // Phase A: drain the inbox completely before touching the ready queue.
    // New plans landing mid-implement will be placed on the next iteration.
    await drainInbox(runtime, store, inboxStore, signal, handles);
    if (signal.aborted) break;

    const plans = await store.read();

    const failed = plans.find((p) => p.status === 'failed');
    if (failed) {
      runtime.setPaused(plans, failed);
      await sleep(IDLE_POLL_SECONDS * 1000, signal);
      continue;
    }

    const ready = plans.filter((p) => p.status === 'ready');
    if (ready.length === 0) {
      runtime.setIdle(plans);
      await sleep(IDLE_POLL_SECONDS * 1000, signal);
      continue;
    }

    const next = ready[0]!;
    if (next.cancel_requested) {
      // User cancelled before we picked it up. Mark cancelled directly.
      await markPlanCancelled(store, next);
      continue;
    }
    if (!(await planFileExists(next))) {
      await markPlanMissing(store, next);
      continue;
    }

    let planText: string;
    try {
      planText = await fs.readFile(planFilePath(next), 'utf8');
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        await markPlanMissing(store, next);
        continue;
      }
      throw err;
    }

    // Re-parse PRs from the (possibly-edited) plan file and reconcile with
    // stored state. This is the only place per-PR state is materialized at
    // execution time — everything downstream trusts `claimed.prs`.
    const reconciledPrs = materializePrs(planText, next.prs);

    let claimed: Plan;
    try {
      claimed = await store.update(next.slug, {
        status: 'implementing',
        started_at: nowIso(),
        finished_at: null,
        failure: null,
        prs: reconciledPrs,
      });
    } catch (err) {
      if (err instanceof ImplementingLocked || err instanceof PlanNotFound) {
        continue;
      }
      throw err;
    }
    inFlight = claimed;

    const cancelController = new AbortController();
    handles.current.slug = claimed.slug;
    handles.cancelController.ref = cancelController;
    handles.phase.value = 'implementing';

    // Combine the outer abort signal with our cancel-scoped controller so
    // a Ctrl-C OR a per-plan cancel both interrupt the in-flight subprocess.
    const merged = new AbortController();
    const onOuter = (): void => merged.abort();
    const onCancel = (): void => merged.abort();
    signal.addEventListener('abort', onOuter, { once: true });
    cancelController.signal.addEventListener('abort', onCancel, { once: true });
    if (signal.aborted) merged.abort();
    if (cancelController.signal.aborted) merged.abort();

    try {
      const planProgress = newPlanRuntimeState({
        items: runtimeItemsForPlan(claimed),
        planTitle: claimed.title,
      });
      runtime.setRunning(await store.read(), claimed, planProgress);
      const onPrUpdate = async (prs: PrEntry[]): Promise<void> => {
        try {
          await store.update(claimed.slug, { prs }, { allowImplementing: true });
        } catch (err) {
          if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
            throw err;
          }
        }
      };
      await runPlan({
        plan: claimed,
        dryRun: false,
        progress: runtime,
        signal: merged.signal,
        onPrUpdate,
      });
    } catch (err) {
      signal.removeEventListener('abort', onOuter);
      cancelController.signal.removeEventListener('abort', onCancel);
      handles.current.slug = null;
      handles.cancelController.ref = null;
      handles.phase.value = 'idle';
      if (cancelController.signal.aborted && !signal.aborted) {
        // Per-plan cancellation: revert the working tree and mark cancelled.
        cancelledSlug = claimed.slug;
        return { inFlight: claimed, cancelledSlug };
      }
      if (signal.aborted) {
        return { inFlight, cancelledSlug };
      }
      await markPlanFailed(store, claimed, failureFromError(err));
      inFlight = null;
      continue;
    }
    signal.removeEventListener('abort', onOuter);
    cancelController.signal.removeEventListener('abort', onCancel);
    handles.current.slug = null;
    handles.cancelController.ref = null;
    handles.phase.value = 'idle';

    // Clear inFlight before marking done so an abort in the window below
    // cannot demote a finished plan back to pending.
    inFlight = null;
    await markPlanDone(store, claimed);
  }

  return { inFlight, cancelledSlug };
}

export { markPlanCancelled };
