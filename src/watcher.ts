import { promises as fs } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

import type { LaurenConfig } from './core/config.js';
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
import { finalizeMerge, mergePlanOnce, PR_POLL_INTERVAL_MS } from './merger.js';
import { type BrainCancelState, processEnqueuedPlan } from './organize.js';
import { workingTreeDirty } from './proc/git.js';
import { newPlanRuntimeState, type PlanItem, type WatcherRuntime } from './tui/runtime.js';
import { cleanupPlanWorktrees, setupPlanWorktrees } from './worktree.js';

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

function resetMergeHandles(handles: WatcherLoopHandles): void {
  handles.current.slug = null;
  handles.cancelController.ref = null;
  handles.phase.value = 'idle';
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
 * Sweep cancelled rows that still have `worktrees` recorded and remove
 * the on-disk worktrees. Branches (`lauren/<slug>`) are preserved so any
 * committed Step work survives — the user explicitly chose to cancel-keep,
 * and we don't know whether they've already merged the branch into
 * dev_branch manually. Idempotent + best-effort: per-row failures are
 * logged but don't propagate, so a leaked worktree never crashes the loop.
 *
 * Called when the watcher transitions out of a `cancelling` pause (the
 * user resolved by flipping cancelling→cancelled) and on daemon startup.
 */
export async function cleanupCancelledLeftoverWorktrees(
  store: PlanStore,
  plans: readonly Plan[],
): Promise<void> {
  const candidates = plans.filter(
    (p) => p.status === 'cancelled' && (p.worktrees?.length ?? 0) > 0,
  );
  for (const plan of candidates) {
    try {
      await cleanupPlanWorktrees(plan, { keepBranches: true, requireClean: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `warning: failed to clean leftover worktree for cancelled '${plan.slug}': ${msg}\n`,
      );
      continue;
    }
    try {
      await store.update(
        plan.slug,
        { worktrees: undefined },
        { allowImplementing: true, allowMerging: true },
      );
    } catch (err) {
      if (!(err instanceof PlanNotFound)) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `warning: failed to clear worktrees field on '${plan.slug}': ${msg}\n`,
        );
      }
    }
  }
}

/**
 * Move a plan into a terminal status (done/failed/cancelled) or the
 * paused-`cancelling` state. Stamps `finished_at` for terminal statuses and swallows
 * `ImplementingLocked` / `PlanNotFound` so a concurrent cancel or removal
 * during finalization doesn't propagate. `allowMerging` covers the
 * merging→cancelling cancel-keep transition.
 */
export async function markPlanFinal(
  store: PlanStore,
  slug: string,
  fields: Partial<Omit<Plan, 'slug' | 'finished_at'>>,
): Promise<void> {
  try {
    const patch = fields.status === 'cancelling' ? fields : { ...fields, finished_at: nowIso() };
    await store.update(slug, patch, { allowImplementing: true, allowMerging: true });
  } catch (err) {
    if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
      throw err;
    }
  }
}

export type DaemonPhase = 'idle' | 'organizing' | 'implementing' | 'merging';

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
  } else if (handles.phase.value === 'merging') {
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

/**
 * Apply a cancellation request to a `merging` row, honoring `cancel_intent`.
 *
 *   - intent='keep' — preserve the worktree + `lauren/<slug>` branch (the
 *     committed Step work) and mark the row 'cancelling' so the outer loop
 *     pauses for manual resolution. Matches the implementing→cancelling
 *     path (see `watcherLoop`'s implementing catch).
 *   - intent='revert' (default) — tear down the worktree and finalize as
 *     'cancelled'. If cleanup fails, persist `failure.phase='cleanup'`
 *     with `cleanup_result='cancelled'` so the next drainMerging iteration
 *     retries via `mergePlanOnce`'s cleanup-pending path. Without this
 *     wrapping a thrown cleanup error would crash the daemon.
 *
 * Returns true when the failure was persisted as cleanup_pending (the
 * caller should sleep before looping); false otherwise.
 */
async function applyMergingCancellation(args: {
  store: PlanStore;
  plan: Plan;
  config: LaurenConfig;
  runtime: WatcherRuntime;
}): Promise<{ persistedCleanupFailure: boolean }> {
  const { store, plan, config, runtime } = args;
  // Re-read so we pick up cancel_intent that landed after the row was last
  // read (cancel.ts may have written it during the merge attempt).
  let fresh: Plan | null = null;
  try {
    fresh = await store.find(plan.slug);
  } catch {
    // best-effort re-read; fall back to the row we already have
  }
  const intent = fresh?.cancel_intent ?? plan.cancel_intent;
  if (intent === 'keep') {
    await markPlanFinal(store, plan.slug, {
      status: 'cancelling',
      cancel_requested: false,
      cancel_intent: undefined,
    });
    return { persistedCleanupFailure: false };
  }
  try {
    await cleanupPlanWorktrees(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      const updated = await store.update(
        plan.slug,
        {
          failure: {
            phase: 'cleanup',
            step_id: null,
            message: `cancel requested, but cleanup failed: ${msg}`,
            cleanup_result: 'cancelled',
          },
        },
        { allowMerging: true },
      );
      runtime.setMerging(await store.read(), updated, config.merge_mode);
    } catch {
      // best-effort UI refresh
    }
    return { persistedCleanupFailure: true };
  }
  await finalizeMerge(store, plan.slug, { kind: 'cancelled' });
  return { persistedCleanupFailure: false };
}

async function drainMerging(
  runtime: WatcherRuntime,
  store: PlanStore,
  config: LaurenConfig,
  signal: AbortSignal,
  handles: WatcherLoopHandles,
): Promise<void> {
  while (!signal.aborted) {
    const plans = await store.read();
    const merging = plans.find((p) => p.status === 'merging');
    if (!merging) return;

    handles.current.slug = merging.slug;
    handles.phase.value = 'merging';
    const cleanupPending = merging.failure?.phase === 'cleanup';

    if (merging.cancel_requested && !cleanupPending) {
      runtime.setMerging(plans, merging, config.merge_mode);
      const { persistedCleanupFailure } = await applyMergingCancellation({
        store,
        plan: merging,
        config,
        runtime,
      });
      resetMergeHandles(handles);
      if (persistedCleanupFailure) {
        await sleep(PR_POLL_INTERVAL_MS, signal);
        if (signal.aborted) return;
      }
      continue;
    }

    const cancelController = new AbortController();
    handles.cancelController.ref = cancelController;
    const merged = AbortSignal.any([signal, cancelController.signal]);
    const mergeSignal = cleanupPending ? signal : merged;

    runtime.setMerging(plans, merging, config.merge_mode);

    let result: Awaited<ReturnType<typeof mergePlanOnce>>;
    try {
      result = await mergePlanOnce({ plan: merging, store, config, signal: mergeSignal });
    } catch (err) {
      if (cancelController.signal.aborted && !cleanupPending) {
        const { persistedCleanupFailure } = await applyMergingCancellation({
          store,
          plan: merging,
          config,
          runtime,
        });
        resetMergeHandles(handles);
        if (persistedCleanupFailure) {
          await sleep(PR_POLL_INTERVAL_MS, signal);
          if (signal.aborted) return;
        }
        continue;
      }
      if (signal.aborted) {
        resetMergeHandles(handles);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      await finalizeMerge(store, merging.slug, {
        kind: 'failed',
        failure: { phase: 'merge', step_id: null, message: msg },
      });
      resetMergeHandles(handles);
      continue;
    }

    if (result.kind === 'done') {
      await finalizeMerge(store, merging.slug, result);
      resetMergeHandles(handles);
      continue;
    }

    if (result.kind === 'cleanup_failed') {
      const updated = await store.update(
        merging.slug,
        { failure: result.failure },
        { allowMerging: true },
      );
      runtime.setMerging(
        plans.map((p) => (p.slug === updated.slug ? updated : p)),
        updated,
        config.merge_mode,
      );
      await sleep(PR_POLL_INTERVAL_MS, mergeSignal);
      resetMergeHandles(handles);
      if (signal.aborted) return;
      continue;
    }

    if (cancelController.signal.aborted && !cleanupPending) {
      // User-initiated cancel of merging wins over a concurrent Ctrl-C.
      const { persistedCleanupFailure } = await applyMergingCancellation({
        store,
        plan: merging,
        config,
        runtime,
      });
      resetMergeHandles(handles);
      if (persistedCleanupFailure) {
        await sleep(PR_POLL_INTERVAL_MS, signal);
        if (signal.aborted) return;
      }
      continue;
    }

    if (result.kind === 'pending') {
      await sleep(PR_POLL_INTERVAL_MS, merged);
      if (cancelController.signal.aborted && !cleanupPending) {
        // User-initiated cancel while waiting between PR polls.
        const { persistedCleanupFailure } = await applyMergingCancellation({
          store,
          plan: merging,
          config,
          runtime,
        });
        resetMergeHandles(handles);
        if (persistedCleanupFailure) {
          await sleep(PR_POLL_INTERVAL_MS, signal);
          if (signal.aborted) return;
        }
        continue;
      }
      resetMergeHandles(handles);
      if (signal.aborted) return;
      continue;
    }

    if (result.kind === 'aborted' || signal.aborted) {
      resetMergeHandles(handles);
      return;
    }

    await finalizeMerge(store, merging.slug, result);
    resetMergeHandles(handles);
  }
}

export async function watcherLoop(
  runtime: WatcherRuntime,
  store: PlanStore,
  config: LaurenConfig,
  signal: AbortSignal,
  handles: WatcherLoopHandles,
): Promise<{ inFlight: Plan | null; cancelledSlug: string | null }> {
  let inFlight: Plan | null = null;
  let cancelledSlug: string | null = null;
  let requireCleanWorkspaceAfterCancelling = false;
  while (!signal.aborted) {
    // Drain any in-flight merge before touching the rest of the queue.
    // For github-pr mode this polls every PR_POLL_INTERVAL_MS until the PR
    // resolves; the daemon does no other work in the meantime.
    await drainMerging(runtime, store, config, signal, handles);
    if (signal.aborted) break;

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
      // The user resolved cancelling→cancelled. The worktree was kept
      // around for inspection; now that they've moved on, remove it so
      // we don't leak `.lauren/worktrees/<slug>/` directories indefinitely.
      // Branches are preserved (see cleanupCancelledLeftoverWorktrees).
      await cleanupCancelledLeftoverWorktrees(store, beforeDrain);
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

    // An `awaiting_human` row pauses the daemon at a checkpoint boundary.
    // The user opens the linked HTML, performs the manual step, then
    // acknowledges via the TUI which flips the row back to `ready`.
    const awaiting = plans.find((p) => p.status === 'awaiting_human');
    if (awaiting) {
      const cp = (awaiting.checkpoints ?? []).find((c) => c.id === awaiting.current_checkpoint_id);
      if (cp) {
        runtime.setAwaitingCheckpoint(plans, awaiting, cp);
      } else {
        runtime.setIdle(plans);
      }
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

    // Provision worktrees BEFORE flipping the row to `implementing` so that
    // a crash between status-flip and worktree-create can't leave us with
    // an implementing row pointing at non-existent worktrees. The worktree
    // setup is idempotent (cleans up stale state from prior failed runs).
    let execCtx: Awaited<ReturnType<typeof setupPlanWorktrees>>;
    try {
      execCtx = await setupPlanWorktrees(next, config);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await markPlanFinal(store, next.slug, {
        status: 'failed',
        failure: {
          phase: 'implement',
          step_id: null,
          message: `failed to create worktree(s): ${msg}`,
        },
      });
      continue;
    }

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
          worktrees: execCtx.worktrees,
        },
        {
          precondition: (p) => p.status === 'ready',
          preconditionDetail: 'row is no longer ready (likely cancelled concurrently)',
        },
      );
    } catch (err) {
      // Roll back worktree allocation if the claim failed.
      await cleanupPlanWorktrees(
        { ...next, worktrees: execCtx.worktrees },
        { keepBranches: true },
      ).catch(() => undefined);
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

    let runResult: Awaited<ReturnType<typeof runPlan>>;
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
      runResult = await runPlan({
        plan: claimed,
        dryRun: false,
        targetRepos: execCtx.rewrittenRepos,
        cwd: execCtx.rootCwd,
        progress: runtime,
        signal: merged,
        onStepUpdate,
      });
    } catch (err) {
      handles.current.slug = null;
      handles.cancelController.ref = null;
      handles.phase.value = 'idle';
      if (cancelController.signal.aborted) {
        // Per-plan cancellation. Branch by intent:
        //   'keep' — leave the worktree intact, demote to 'cancelling',
        //            and let the outer loop pause on the cancelling row.
        //   'revert' (default) — return to the caller so vibe-command can
        //            tear down the worktree + mark 'cancelled' and exit.
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

    // Clear inFlight before marking the row so an abort in the window below
    // cannot demote a finished plan back to pending. Transition to
    // `merging` — the outer loop will pick it up at the top. `finished_at`
    // is left null until the plan reaches its true terminal status (done /
    // failed / cancelled).
    //
    // The precondition guards an implement→merge race: between the handles
    // being cleared above and this update winning the lock, a TUI cancel
    // (cancel.ts → requestDaemonCancellation) can stamp cancel_requested on
    // the still-`implementing` row. Without the guard, cancel_requested would
    // ride into `merging`, and drainMerging would honor it as a merging
    // cancel — for intent='revert' (default) that means deleting the
    // `lauren/<slug>` branch, destroying the just-committed Step work.
    // The user clicked cancel on what they saw as `implementing`, so we
    // honor the implementing-cancel semantics here instead.
    inFlight = null;
    if (runResult.kind === 'paused-at-checkpoint') {
      // The executor committed every Step it could and hit a pending Human
      // Checkpoint. Demote the row to `awaiting_human` and stop. The outer
      // loop will detect the awaiting row at the head of the queue and
      // pause (mirroring the failed/cancelling pause). The user
      // acknowledges via the TUI, which flips the row back to `ready`.
      // The implement→awaiting precondition matches the implement→merge
      // one above: if a cancel landed in the gap, drop into the cancel
      // branch instead.
      const checkpointId = runResult.checkpoint_id;
      try {
        await store.update(
          claimed.slug,
          {
            status: 'awaiting_human',
            current_checkpoint_id: checkpointId,
            started_at: null,
            finished_at: null,
          },
          {
            allowImplementing: true,
            precondition: (p) => !p.cancel_requested,
            preconditionDetail: 'cancel_requested landed during implement→awaiting transition',
          },
        );
      } catch (err) {
        if (err instanceof PlanPreconditionFailed) {
          const cancelledPlan = await store.find(claimed.slug);
          const cancelIntent = cancelledPlan?.cancel_intent ?? claimed.cancel_intent;
          if (cancelIntent === 'keep') {
            await markPlanFinal(store, claimed.slug, {
              status: 'cancelling',
              cancel_requested: false,
              cancel_intent: undefined,
            });
            continue;
          }
          cancelledSlug = claimed.slug;
          return { inFlight: claimed, cancelledSlug };
        }
        if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
          throw err;
        }
      }
      continue;
    }
    try {
      await store.update(
        claimed.slug,
        { status: 'merging', finished_at: null },
        {
          allowImplementing: true,
          precondition: (p) => !p.cancel_requested,
          preconditionDetail: 'cancel_requested landed during implement→merge transition',
        },
      );
    } catch (err) {
      if (err instanceof PlanPreconditionFailed) {
        // Mirror the runPlan-throw branch above: re-read for the latest
        // intent, then either pause on cancelling (keep) or hand back to
        // vibe-command to finalize as cancelled (revert).
        const cancelledPlan = await store.find(claimed.slug);
        const cancelIntent = cancelledPlan?.cancel_intent ?? claimed.cancel_intent;
        if (cancelIntent === 'keep') {
          await markPlanFinal(store, claimed.slug, {
            status: 'cancelling',
            cancel_requested: false,
            cancel_intent: undefined,
          });
          continue;
        }
        cancelledSlug = claimed.slug;
        return { inFlight: claimed, cancelledSlug };
      }
      if (!(err instanceof ImplementingLocked) && !(err instanceof PlanNotFound)) {
        throw err;
      }
    }
  }

  return { inFlight, cancelledSlug };
}
