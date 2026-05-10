import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import { VIBE_LOCK_PATH } from './core/paths.js';
import { materializeSteps, type StepEntry } from './core/steps.js';
import type { PlanStore } from './core/store.js';
import { nowIso } from './core/time.js';
import {
  ImplementingLocked,
  type Plan,
  type PlanFailure,
  PlanNotFound,
  PlanPreconditionFailed,
  planFilePath,
} from './core/types.js';
import {
  formatRepoList,
  type ResolvedWorkspaceRepo,
  resolveWorkspaceRepos,
} from './core/workspace.js';
import { RunFailure, runPlan } from './executor.js';
import { type BrainCancelState, processEnqueuedPlan } from './organize.js';
import { workingTreeDirty } from './proc/git.js';
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

function dirtyRepos(repos: readonly ResolvedWorkspaceRepo[]): ResolvedWorkspaceRepo[] {
  return repos.filter((repo) => workingTreeDirty(repo.root));
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
  if (plan.steps && plan.steps.length > 0) {
    return plan.steps
      .filter((step) => step.status !== 'orphaned')
      .map((step) => ({ id: step.id, title: step.title }));
  }
  return [{ id: plan.slug, title: plan.title }];
}

function failureFromError(err: unknown): PlanFailure {
  if (err instanceof RunFailure) {
    // Use rawMessage (without the "${phase}: " prefix the Error constructor
    // adds) — the TUI displays phase separately and we don't want it twice.
    return { phase: err.phase, step_id: err.stepId, message: err.rawMessage };
  }
  return {
    phase: 'unknown',
    step_id: null,
    message: `unexpected error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
  };
}

/**
 * Move a plan into a terminal status (done/failed/cancelled). Stamps
 * `finished_at` and swallows `ImplementingLocked` / `PlanNotFound` so a
 * concurrent cancel or removal during finalization doesn't propagate.
 */
export async function markPlanFinal(
  store: PlanStore,
  slug: string,
  fields: Partial<Omit<Plan, 'slug' | 'finished_at'>>,
): Promise<void> {
  try {
    await store.update(slug, { ...fields, finished_at: nowIso() }, { allowImplementing: true });
  } catch (err) {
    if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
      throw err;
    }
  }
}

export type DaemonPhase = 'idle' | 'organizing' | 'implementing';

/**
 * Handle a SIGUSR2 cancellation request: abort the in-flight subprocess
 * matching the current phase, but only if (a) there is an in-flight slug,
 * (b) that slug actually has `cancel_requested=true` on disk, and (c) it's
 * still the in-flight slug after the disk read.
 *
 * (c) is the load-bearing check: between capturing the slug and reading
 * the store, the daemon can transition phase (organizing → idle →
 * implementing of a different plan). Without the re-verify we'd dispatch
 * the abort on the *current* phase/controller — which now belongs to an
 * unrelated subprocess.
 */
export async function handleCancelSignal(
  store: { find: (slug: string) => Promise<Plan | null> },
  handles: WatcherLoopHandles,
): Promise<void> {
  const slug = handles.current.slug;
  if (!slug) return;
  let fresh: Plan | null;
  try {
    fresh = await store.find(slug);
  } catch {
    return;
  }
  if (!fresh?.cancel_requested) return;
  if (handles.current.slug !== slug) return;
  if (handles.phase.value === 'organizing') {
    handles.brainState.controller?.abort();
  } else if (handles.phase.value === 'implementing') {
    handles.cancelController.ref?.abort();
  }
}

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
 * Drain every `enqueued` plan by running brain placement until none remain.
 * Phase 'organizing' is held throughout. Errors are reported via stderr and
 * the loop sleeps briefly to avoid hot-looping on a broken plan.
 */
async function drainEnqueued(
  runtime: WatcherRuntime,
  store: PlanStore,
  signal: AbortSignal,
  handles: WatcherLoopHandles,
): Promise<void> {
  while (!signal.aborted) {
    const plans = await store.read();
    const next = plans.find((p) => p.status === 'enqueued');
    if (!next) return;

    runtime.setOrganizing(plans, next);
    handles.current.slug = next.slug;
    handles.phase.value = 'organizing';
    try {
      await processEnqueuedPlan({
        plan: next,
        store,
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
  store: PlanStore,
  signal: AbortSignal,
  handles: WatcherLoopHandles,
): Promise<{ inFlight: Plan | null; cancelledSlug: string | null }> {
  let inFlight: Plan | null = null;
  let cancelledSlug: string | null = null;
  let requireCleanWorkspaceAfterCancelling = false;
  while (!signal.aborted) {
    const beforeDrain = await store.read();

    // A 'cancelling' row means the user cancelled an implementing plan with
    // intent='keep'. The working tree still has the partial work; vibe must
    // pause before doing any other queue work until the user resolves the
    // dirty state and flips status to 'cancelled'.
    const cancellingBeforeDrain = beforeDrain.find((p) => p.status === 'cancelling');
    if (cancellingBeforeDrain) {
      requireCleanWorkspaceAfterCancelling = true;
      runtime.setPausedCancelling(beforeDrain, cancellingBeforeDrain);
      await sleep(IDLE_POLL_SECONDS * 1000, signal);
      continue;
    }

    if (requireCleanWorkspaceAfterCancelling) {
      const dirty = dirtyRepos(await resolveWorkspaceRepos());
      if (dirty.length > 0) {
        runtime.setPausedDirtyWorkspace(beforeDrain, formatRepoList(dirty));
        await sleep(IDLE_POLL_SECONDS * 1000, signal);
        continue;
      }
      requireCleanWorkspaceAfterCancelling = false;
    }

    // Phase A: drain every enqueued plan before touching the ready queue.
    // New plans landing mid-implement will be placed on the next iteration.
    await drainEnqueued(runtime, store, signal, handles);
    if (signal.aborted) break;

    const plans = await store.read();

    const failed = plans.find((p) => p.status === 'failed');
    if (failed) {
      runtime.setPaused(plans, failed);
      await sleep(IDLE_POLL_SECONDS * 1000, signal);
      continue;
    }

    // A 'cancelling' row means the user cancelled an implementing plan with
    // intent='keep'. The working tree still has the partial work; vibe must
    // pause until the user resolves the dirty state and flips status to
    // 'cancelled'.
    const stuck = plans.find((p) => p.status === 'cancelling');
    if (stuck) {
      requireCleanWorkspaceAfterCancelling = true;
      runtime.setPausedCancelling(plans, stuck);
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
      // User cancelled before we picked it up. No partial work exists, so
      // regardless of intent there's nothing to revert/keep — just cancel.
      await markPlanFinal(store, next.slug, {
        status: 'cancelled',
        cancel_requested: false,
        cancel_intent: undefined,
      });
      continue;
    }
    const missingFailure = (plan: Plan): PlanFailure => ({
      phase: 'implement',
      step_id: null,
      message: `plan file missing: ${plan.path}`,
    });
    if (!(await planFileExists(next))) {
      await markPlanFinal(store, next.slug, { status: 'failed', failure: missingFailure(next) });
      continue;
    }

    let planText: string;
    try {
      planText = await fs.readFile(planFilePath(next), 'utf8');
    } catch (err) {
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        await markPlanFinal(store, next.slug, {
          status: 'failed',
          failure: missingFailure(next),
        });
        continue;
      }
      throw err;
    }

    // Re-parse Steps from the (possibly-edited) plan file and reconcile with
    // stored state. This is the only place per-step state is materialized at
    // execution time — everything downstream trusts `claimed.steps`.
    const reconciledSteps = materializeSteps(planText, next.steps);

    let claimed: Plan;
    try {
      // Require the row to still be `ready` at lock time. Without this CAS,
      // a concurrent cancel that flipped the row to `cancelled` between our
      // read above and this update would be silently overwritten back to
      // `implementing` — the cancellation lost without a trace.
      claimed = await store.update(
        next.slug,
        {
          status: 'implementing',
          started_at: nowIso(),
          finished_at: null,
          failure: null,
          steps: reconciledSteps,
        },
        {
          precondition: (p) => p.status === 'ready',
          preconditionDetail: 'row is no longer ready (likely cancelled concurrently)',
        },
      );
    } catch (err) {
      if (
        err instanceof ImplementingLocked ||
        err instanceof PlanNotFound ||
        err instanceof PlanPreconditionFailed
      ) {
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
    const merged = AbortSignal.any([signal, cancelController.signal]);

    try {
      const planProgress = newPlanRuntimeState({
        items: runtimeItemsForPlan(claimed),
        planTitle: claimed.title,
      });
      runtime.setRunning(await store.read(), claimed, planProgress);
      const onStepUpdate = async (steps: StepEntry[]): Promise<void> => {
        try {
          await store.update(claimed.slug, { steps }, { allowImplementing: true });
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
        signal: merged,
        onStepUpdate,
      });
    } catch (err) {
      handles.current.slug = null;
      handles.cancelController.ref = null;
      handles.phase.value = 'idle';
      if (cancelController.signal.aborted && !signal.aborted) {
        // Per-plan cancellation. Branch by intent:
        //   'keep' — leave the working tree untouched, demote to 'cancelling',
        //            and let the outer loop pause on the cancelling row.
        //   'revert' (default) — return to the caller so vibe-command can
        //            revert + mark 'cancelled' and exit.
        const cancelledPlan = await store.find(claimed.slug);
        const cancelIntent = cancelledPlan?.cancel_intent ?? claimed.cancel_intent;
        if (cancelIntent === 'keep') {
          await markPlanFinal(store, claimed.slug, {
            status: 'cancelling',
            cancel_requested: false,
            cancel_intent: undefined,
          });
          inFlight = null;
          continue;
        }
        cancelledSlug = claimed.slug;
        return { inFlight: claimed, cancelledSlug };
      }
      if (signal.aborted) {
        return { inFlight, cancelledSlug };
      }
      await markPlanFinal(store, claimed.slug, {
        status: 'failed',
        failure: failureFromError(err),
      });
      inFlight = null;
      continue;
    }
    handles.current.slug = null;
    handles.cancelController.ref = null;
    handles.phase.value = 'idle';

    // Clear inFlight before marking done so an abort in the window below
    // cannot demote a finished plan back to pending.
    inFlight = null;
    await markPlanFinal(store, claimed.slug, { status: 'done' });
  }

  return { inFlight, cancelledSlug };
}
